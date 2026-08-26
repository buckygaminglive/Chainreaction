import { DurableObject } from 'cloudflare:workers';
import { GameEngine } from '../src/game/GameEngine';
import { layoutForMode, randomSeed } from '../src/game/cells';
import { GAME_MODES, type GameModeKey } from '../src/game/modes';
import { TAUNT_COOLDOWN_MS, isValidTaunt, CHAT_COOLDOWN_MS, isValidChat } from '../src/net/taunts';
import type { Matchmaker } from './Matchmaker';
import type { PlayerHub } from './PlayerHub';
import type { RateLimiter } from './RateLimiter';
import type { EngineSnapshot, PlayerConfig } from '../src/game/types';
import type { BoardSizeKey, ClientMsg, NetPlayer, OrbStyleKey, PublicRoom, ServerMsg } from '../src/net/protocol';
import { PLAYER_THEMES } from '../src/render/theme';

/** Team Battle pairs teammates into related emissions so a side reads as a
 *  side: cool tones against warm ones. */
const TEAM_COLOR_INDICES = [
  [0, 5],
  [1, 7],
];

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  MATCHMAKER: DurableObjectNamespace<Matchmaker>;
  PLAYER_HUB: DurableObjectNamespace<PlayerHub>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
}

export const PLAYER_HUB_SINGLETON = 'global';

/** Everything the public list needs is derived from the room's own state, so
 *  the listing is refreshed from here on every change rather than being kept in
 *  sync by hand somewhere else. */
export const MATCHMAKER_SINGLETON = 'global';

interface Attachment {
  id: number;
  name: string;
  /** Bumped every time this seat opens a new socket. A close event from an
   *  older generation is ignored, so the stale socket being torn down during a
   *  reconnect can't mark the freshly-returned player offline again. */
  gen: number;
}

interface RosterEntry {
  name: string;
  connected: boolean;
  colorIndex: number;
  /** Reconnect secret for this seat. Never leaves the room except to the one
   *  socket that owns it. */
  token: string;
  gen: number;
  /** The guest account occupying this seat, if the player has one. Held so a
   *  finished ranked match can be reported to the hub under a verified
   *  identity rather than a name anyone could type. */
  accountId?: string;
  accountSecret?: string;
  /** Best chain this account managed in the current match. */
  bestChain?: number;
}

interface Meta {
  started: boolean;
  nextPlayerId: number;
  hostId: number | null;
  boardSize: BoardSizeKey;
  landscape: boolean;
  orbStyle: OrbStyleKey;
  mode: GameModeKey;
  seed: number;
  rows?: number;
  cols?: number;
  roster: [number, RosterEntry][];
  roomScore?: [number, number][];
  isPublic?: boolean;
  /** Whether results from this room move anyone's rating. Deliberately not the
   *  same thing as `isPublic` — see the field on the class. */
  ranked?: boolean;
  roomCode?: string;
  /** Both deadlines have to survive hibernation. The WebSocket hibernation
   *  API means a room with players connected can still be evicted between
   *  arming an alarm and that alarm firing — and an alarm that wakes an object
   *  which has forgotten why it set it does nothing at all. */
  turnDeadline?: number;
  absentDeadline?: number;
  lastActivity?: number;
}

const BOARD_SIZES: Record<BoardSizeKey, { rows: number; cols: number }> = {
  small: { rows: 9, cols: 5 },
  medium: { rows: 11, cols: 6 },
  large: { rows: 13, cols: 7 },
};

const MAX_PLAYERS = 6;

/** Rows and columns swapped when the board is played on its side. Kept as a
 *  function rather than a second size table so there is still exactly one
 *  definition of how big each board is. */
function orient(size: { rows: number; cols: number }, landscape: boolean) {
  return landscape ? { rows: size.cols, cols: size.rows } : size;
}

/** Grace on top of the displayed turn clock before the relay plays the move
 *  itself. The client's countdown starts when the message lands, but the board
 *  is still animating the previous cascade at that point — without a little
 *  slack the relay would cut people off while they were still watching the
 *  move that gave them the turn. */
const TURN_ANIMATION_GRACE_MS = 1_400;

/** How long a disconnected player's turn is waited on before the relay plays
 *  it for them. Long enough to survive a tunnel or a locked phone, short
 *  enough that the player still sitting there does not give up and leave. */
const ABSENT_TURN_GRACE_MS = 45_000;

/** A room nobody has been connected to for this long is torn down. Idle rooms
 *  used to live forever: storage nothing would ever read again, and a public
 *  listing outliving the room it points at. */
const IDLE_ROOM_TTL_MS = 30 * 60_000;

export class GameRoom extends DurableObject<Env> {
  private engine: GameEngine | null = null;
  private started = false;
  private nextPlayerId = 0;
  private hostId: number | null = null;
  private boardSize: BoardSizeKey = 'medium';
  /** Rows and columns swapped, for a screen that is wider than it is tall. */
  private landscape = false;
  private orbStyle: OrbStyleKey = 'emoji';
  private mode: GameModeKey = 'classic';
  private seed = 0;
  private roster = new Map<number, RosterEntry>();
  /** Games won per seat since this room opened, carried across rematches. */
  private roomScore = new Map<number, number>();
  private rematchVotes = new Set<number>();
  /** Last taunt timestamp per seat, for the cooldown. In memory only — losing
   *  it to a hibernation just means one taunt gets through early. */
  private lastTaunt = new Map<number, number>();
  /** The same, for quick chat. Kept separate from the taunt clock so that
   *  sending an emoji does not eat the budget for saying "good game", and so
   *  the two can carry different cooldowns. */
  private lastChat = new Map<number, number>();
  /** Rooms are private by default: a code you shared with a friend must never
   *  end up on a public list because of a default. */
  private isPublic = false;
  /**
   * Whether a result here moves ratings.
   *
   * Separate from `isPublic`, which only decides whether the room appears in
   * the browsable list. Conflating the two was a rating exploit: `isPublic` is
   * settable by a client — through `?public=1` on the socket URL and through
   * the host's own `setLobby` — so any player could declare their own room
   * ranked, hand the code to a second device and farm the ladder.
   *
   * This flag is set only by the worker, only for a code the matchmaker
   * issued, over an internal path that the public router cannot reach. There
   * is no message a client can send that turns it on.
   */
  private ranked = false;
  /** The DO is addressed by room code but is never told what it is, so it is
   *  captured from the first request that reaches it. */
  private roomCode = '';
  /** Epoch ms the current turn is cut off at in a timed mode, or 0. */
  private turnDeadline = 0;
  /** Epoch ms the relay stops waiting for an absent player's turn, or 0. */
  private absentDeadline = 0;
  /** Last time anything happened here, for the idle TTL. */
  private lastActivity = Date.now();
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const meta = await ctx.storage.get<Meta>('meta');
      if (meta) {
        this.started = meta.started;
        this.nextPlayerId = meta.nextPlayerId;
        this.hostId = meta.hostId;
        this.boardSize = meta.boardSize;
        this.landscape = meta.landscape ?? false;
        this.orbStyle = meta.orbStyle;
        this.mode = meta.mode ?? 'classic';
        this.seed = meta.seed ?? 0;
        this.roster = new Map(meta.roster);
        this.roomScore = new Map(meta.roomScore ?? []);
        this.isPublic = meta.isPublic ?? false;
        this.ranked = meta.ranked ?? false;
        this.roomCode = meta.roomCode ?? '';
        this.turnDeadline = meta.turnDeadline ?? 0;
        this.absentDeadline = meta.absentDeadline ?? 0;
        this.lastActivity = meta.lastActivity ?? Date.now();
      }
      const snap = await ctx.storage.get<EngineSnapshot>('engineSnapshot');
      if (snap && meta?.rows && meta?.cols) {
        this.engine = new GameEngine({ rows: meta.rows, cols: meta.cols, players: snap.players });
        this.engine.loadSnapshot(snap);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;

    // Internal: the worker marks a room ranked when the matchmaker issues its
    // code. Unreachable from outside — the public router only ever forwards
    // paths matching /api/room/CODE, so this pathname cannot arrive from a
    // client. That is the whole security property, so it must stay true if
    // the router's routes are ever widened.
    const internal = new URL(request.url);
    if (internal.pathname === '/rank') {
      this.ranked = true;
      await this.persistMeta();
      return Response.json({ ok: true });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const url = new URL(request.url);
    // The object is addressed by room code but never told it, so it learns it
    // from the path the first time anyone connects.
    const fromPath = url.pathname.match(/\/api\/room\/([A-Z0-9]{4,8})$/i);
    if (fromPath) this.roomCode = fromPath[1].toUpperCase();
    // Quick match parks a room in the queue before anyone is in it, so the
    // first arrival can be told to advertise it. This controls listing only —
    // whether the match is *rated* is decided by the relay, never here.
    if (url.searchParams.get('public') === '1') this.isPublic = true;
    const name = (url.searchParams.get('name') || 'Player').slice(0, 20);
    const token = url.searchParams.get('token');
    const returning = token ? this.findSeatByToken(token) : null;

    if (!returning) {
      // Only genuinely new players are gated. A returning player already holds
      // a seat, so they neither fill the room further nor need the game to be
      // un-started — refusing them here is exactly the bug this fixes.
      if (this.ctx.getWebSockets().length >= MAX_PLAYERS) {
        return new Response('Room is full', { status: 403 });
      }
      if (this.started) {
        return new Response('Game already in progress', { status: 409 });
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    let id: number;
    let entry: RosterEntry;
    if (returning) {
      id = returning.id;
      entry = returning.entry;
      // Drop any socket still held by this seat before the new one takes over,
      // so a half-dead connection can't keep receiving broadcasts.
      this.closeSocketsFor(id);
      entry.gen += 1;
      entry.connected = true;
      entry.name = name || entry.name;
    } else {
      id = this.nextPlayerId++;
      entry = {
        name,
        connected: true,
        colorIndex: this.pickDefaultColor(),
        token: crypto.randomUUID(),
        gen: 1,
      };
      this.roster.set(id, entry);
    }

    if (this.hostId === null) this.hostId = id;
    const hostId = this.hostId;

    server.serializeAttachment({ id, name, gen: entry.gen } satisfies Attachment);
    this.ctx.acceptWebSocket(server);
    await this.persistMeta();

    this.send(server, {
      type: 'welcome',
      youAreId: id,
      hostId,
      players: this.rosterList(),
      token: entry.token,
    });

    // A player returning to a live match needs the board, not just the roster.
    if (returning && this.started && this.engine) {
      this.send(server, {
        type: 'resume',
        rows: this.engine.rows,
        cols: this.engine.cols,
        orbStyle: this.orbStyle,
        mode: this.mode,
        snapshot: this.engine.getSnapshot(),
      });
    }
    // The head-to-head predates this connection, so hand it over on arrival
    // rather than leaving a returning player showing 0-0.
    if (this.roomScore.size > 0) {
      this.send(server, { type: 'roomScore', score: Array.from(this.roomScore.entries()) });
    }

    this.broadcastPlayers();
    if (this.engine?.gameOver) this.broadcastRematchState();
    // Somebody is here, so the idle clock restarts and any grace on a seat
    // that just came back is cleared.
    this.lastActivity = Date.now();
    await this.syncAbsentTimer();

    return new Response(null, { status: 101, webSocket: client });
  }

  private findSeatByToken(token: string): { id: number; entry: RosterEntry } | null {
    for (const [id, entry] of this.roster) {
      if (entry.token && entry.token === token) return { id, entry };
    }
    return null;
  }

  private closeSocketsFor(id: number) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | undefined;
      if (att?.id !== id) continue;
      try {
        ws.close(4000, 'replaced by a newer connection');
      } catch {
        /* already gone */
      }
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string') return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;
    if (!att) return;
    this.lastActivity = Date.now();

    if (msg.type === 'startGame') {
      // `mode` is newer than the deployed client. Treating its absence as
      // Classic is what lets the relay ship before the client without
      // breaking whoever is mid-session on the old build.
      await this.handleStart(ws, att, msg.boardSize, msg.orbStyle, msg.mode ?? 'classic', msg.landscape === true);
    } else if (msg.type === 'move') {
      await this.handleMove(ws, att, msg.row, msg.col);
    } else if (msg.type === 'restart' || msg.type === 'rematchVote') {
      // An older client's `restart` counts as that player's vote, so a mixed
      // room still works rather than silently ignoring them.
      await this.handleRematchVote(att);
    } else if (msg.type === 'taunt') {
      this.handleTaunt(att, msg.emoji);
    } else if (msg.type === 'chat') {
      this.handleChat(att, msg.phrase);
    } else if (msg.type === 'setLobby') {
      if (att.id !== this.hostId || this.started) return;
      if (msg.isPublic !== undefined) this.isPublic = !!msg.isPublic;
      // Narrowed against the mode table, since this arrives from a client.
      if (msg.mode && GAME_MODES[msg.mode]?.online) this.mode = msg.mode;
      if (msg.boardSize && BOARD_SIZES[msg.boardSize]) this.boardSize = msg.boardSize;
      if (msg.landscape !== undefined) this.landscape = msg.landscape === true;
      await this.persistMeta();
      this.broadcastPlayers();
    } else if (msg.type === 'pickColor') {
      await this.handlePickColor(ws, att, msg.colorIndex);
    } else if (msg.type === 'auth') {
      this.handleAuth(att, msg.id, msg.secret);
    } else if (msg.type === 'ping') {
      this.send(ws, { type: 'pong' });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    await this.handleDisconnect(ws);
    // Finish the closing handshake. Without this the peer's socket sits in
    // CLOSING indefinitely and never fires its `close` event — which means a
    // client that hangs up cleanly never learns it is disconnected and never
    // starts reconnecting.
    try {
      // 1006 is reserved for abnormal closure and may not be sent on the wire.
      ws.close(code === 1006 || !code ? 1000 : code, reason);
    } catch {
      /* already fully closed */
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error('WebSocket error', String(error));
    await this.handleDisconnect(ws);
  }

  private async handleDisconnect(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | undefined;
    if (!att) return;

    const current = this.roster.get(att.id);
    // The seat has already moved on to a newer socket — this close is the tail
    // end of the connection that was replaced, and acting on it would mark a
    // player who is right here as offline.
    if (current && att.gen !== undefined && current.gen !== att.gen) return;

    if (!this.started) {
      // Nothing durable depends on this slot yet — drop it cleanly so a
      // reconnect looks like a normal fresh join instead of leaving a ghost.
      this.roster.delete(att.id);
    } else if (current) {
      // Mid-match the seat is kept: the player owns a colour, a position on
      // the board and a turn order, and holds a token to come back to them.
      current.connected = false;
    }

    if (!this.started && this.hostId === att.id) {
      const next = this.ctx.getWebSockets().find((s) => s !== ws);
      if (next) {
        const nextAtt = next.deserializeAttachment() as Attachment;
        this.hostId = nextAtt.id;
      } else {
        this.hostId = null;
      }
    }
    await this.persistMeta();
    this.broadcastPlayers();
    // The player who just dropped may be the one the board is waiting on.
    await this.syncAbsentTimer();

    // Someone leaving the result screen means the rematch everyone else is
    // waiting on is never coming. Reopen the lobby so the room stays usable
    // instead of stranding the rest on a finished board.
    if (this.started && this.engine?.gameOver) {
      await this.returnToLobby();
    } else if (this.started) {
      // Mid-match: the seat is held, but the vote tally has to shrink or a
      // rematch could never reach unanimity.
      this.broadcastRematchState();
    }
  }

  private async handleStart(
    ws: WebSocket,
    att: Attachment,
    boardSize: BoardSizeKey,
    orbStyle: OrbStyleKey,
    mode: GameModeKey,
    landscape: boolean
  ) {
    if (att.id !== this.hostId || this.started) return;

    // The mode arrives from a client, so it is untrusted input: reject anything
    // that isn't a real mode, and anything the relay can't actually referee.
    const spec = GAME_MODES[mode];
    if (!spec || !spec.online) {
      this.send(ws, { type: 'error', message: 'That mode is local-only for now.' });
      return;
    }

    const sockets = this.ctx.getWebSockets();
    if (sockets.length < 2) {
      this.send(ws, { type: 'error', message: 'Need at least 2 players to start.' });
      return;
    }
    if (spec.teams && (sockets.length < 4 || sockets.length % 2 !== 0)) {
      this.send(ws, { type: 'error', message: 'Team Battle needs an even roster of at least 4.' });
      return;
    }

    // The dimensions the whole room plays on, decided here and broadcast:
    // the host's screen shape settles it, not each client's.
    const size = orient(BOARD_SIZES[boardSize], landscape);
    const ordered = sockets
      .map((s) => s.deserializeAttachment() as Attachment)
      .sort((a, b) => a.id - b.id);

    const players: PlayerConfig[] = ordered.map((a, seat) => {
      // In Team Battle the roster's own colour picks are overridden: sides have
      // to be readable at a glance, which a free-for-all colour choice can't
      // guarantee. Alternating seats also makes turn order alternate sides
      // without the engine needing a special rule.
      const colorIndex = spec.teams
        ? TEAM_COLOR_INDICES[seat % 2][Math.floor(seat / 2) % TEAM_COLOR_INDICES[0].length]
        : this.roster.get(a.id)?.colorIndex ?? a.id % PLAYER_THEMES.length;
      const theme = PLAYER_THEMES[colorIndex];
      return {
        id: a.id,
        name: a.name,
        color: theme.base,
        colorLight: theme.light,
        isAlive: true,
        ...(spec.teams ? { team: seat % 2 } : {}),
      };
    });

    this.boardSize = boardSize;
    this.landscape = landscape;
    this.orbStyle = orbStyle;
    this.mode = mode;
    await this.beginGame(size.rows, size.cols, players);
  }

  /** Builds and broadcasts a fresh board on the room's current settings. Shared
   *  by the first game and every rematch, so a rematch cannot drift from the
   *  configuration the players agreed to. */
  private async beginGame(rows: number, cols: number, players: PlayerConfig[]) {
    // The relay owns the seed. Letting the host pick it would let a host
    // re-roll the lattice until they liked it — and a rematch gets a genuinely
    // new board rather than a repeat of the one just played.
    this.seed = randomSeed();
    this.engine = new GameEngine({
      rows,
      cols,
      players,
      kinds: layoutForMode(this.mode, rows, cols, this.seed),
    });
    this.started = true;
    this.rematchVotes.clear();
    // Per-match statistic, so it resets with the match rather than accumulating
    // across a whole rematch series.
    for (const entry of this.roster.values()) entry.bestChain = 0;
    await this.persistMeta();
    await this.persistEngine();

    this.broadcastAll({
      type: 'gameStarted',
      rows,
      cols,
      players,
      orbStyle: this.orbStyle,
      mode: this.mode,
      seed: this.seed,
    });
    this.broadcastRoomScore();
    // A room in progress is not joinable, so it comes off the public list.
    void this.syncListing();
    await this.beginTurn();
  }

  private broadcastRoomScore() {
    this.broadcastAll({ type: 'roomScore', score: Array.from(this.roomScore.entries()) });
  }

  private broadcastRematchState() {
    this.broadcastAll({
      type: 'rematch',
      votes: Array.from(this.rematchVotes),
      needed: this.connectedSeatIds().length,
    });
  }

  private connectedSeatIds(): number[] {
    return this.ctx
      .getWebSockets()
      .map((s) => (s.deserializeAttachment() as Attachment | undefined)?.id)
      .filter((id): id is number => id !== undefined);
  }

  private async handleMove(ws: WebSocket, att: Attachment, row: number, col: number) {
    if (!this.engine || this.engine.gameOver) return;
    if (this.engine.currentPlayer().id !== att.id) {
      this.send(ws, { type: 'error', message: "It's not your turn." });
      return;
    }
    if (!this.engine.canPlay(row, col)) return;
    await this.applyMove(att.id, row, col);
  }

  /** The one path a move takes into the board, whoever asked for it: a player,
   *  the Blitz clock, or the grace period on somebody who has not come back.
   *  Keeping them on one path is what stops a timed-out move quietly skipping
   *  the score-keeping or the result report. */
  private async applyMove(playerId: number, row: number, col: number) {
    if (!this.engine) return;
    const result = this.engine.applyMove(row, col);
    // Tracked here rather than trusted from the client: the best chain a player
    // reports about themselves is not a statistic, it is a wish.
    const entry = this.roster.get(playerId);
    if (entry && result.chain > (entry.bestChain ?? 0)) entry.bestChain = result.chain;
    this.lastActivity = Date.now();
    await this.persistEngine();
    this.broadcastAll({ type: 'move', row, col });

    // The relay is the only party that knows the real result, so it is the
    // only place a score can be kept honestly.
    if (this.engine.gameOver && this.engine.winner !== null) {
      const winner = this.engine.winner;
      this.roomScore.set(winner, (this.roomScore.get(winner) ?? 0) + 1);
      this.rematchVotes.clear();
      this.turnDeadline = 0;
      this.absentDeadline = 0;
      await this.persistMeta();
      this.broadcastRoomScore();
      await this.reportResult(winner);
      await this.armAlarm();
    } else {
      await this.beginTurn();
    }
  }

  // ---------- The alarm ----------
  /**
   * A Durable Object gets exactly one alarm, so everything here that needs
   * waking up shares it: the Blitz turn clock, the grace period on an absent
   * player's turn, and the idle-room TTL. Whichever is soonest owns the alarm,
   * and the handler works out what was actually due.
   */
  private async armAlarm() {
    const candidates = [this.turnDeadline, this.absentDeadline, this.lastActivity + IDLE_ROOM_TTL_MS];
    const next = Math.min(...candidates.filter((t) => t > 0));
    if (!Number.isFinite(next)) return;
    const current = await this.ctx.storage.getAlarm();
    if (current !== next) await this.ctx.storage.setAlarm(next);
  }

  async alarm() {
    await this.ready;
    const now = Date.now();

    // An empty room nothing has touched is storage nobody will ever read again
    // and a public listing pointing at nothing.
    if (this.ctx.getWebSockets().length === 0 && now >= this.lastActivity + IDLE_ROOM_TTL_MS) {
      await this.shutDown();
      return;
    }

    // Both timeouts do the same thing — play the move — so they share a path.
    // applyMove re-arms the alarm through beginTurn on its way out.
    if (this.turnDeadline && now >= this.turnDeadline) {
      this.turnDeadline = 0;
      await this.playTimedOutTurn();
      return;
    }
    if (this.absentDeadline && now >= this.absentDeadline) {
      this.absentDeadline = 0;
      await this.playTimedOutTurn();
      return;
    }

    await this.armAlarm();
  }

  /**
   * Sets the clock for a turn that has just changed hands. Deliberately *not*
   * called on a roster change: if it were, dropping out and coming back would
   * be a way to buy more time on the clock.
   */
  private async beginTurn() {
    this.turnDeadline = 0;
    this.absentDeadline = 0;
    if (this.engine && this.started && !this.engine.gameOver) {
      const seconds = GAME_MODES[this.mode].turnSeconds;
      if (seconds) {
        // The enforced deadline runs a little longer than the one players see,
        // to cover the cascade still animating on their screens when this
        // message lands. Erring the other way would cut somebody off while
        // they were still watching the move that handed them the turn.
        this.turnDeadline = Date.now() + seconds * 1000 + TURN_ANIMATION_GRACE_MS;
        this.broadcastAll({
          type: 'turnClock',
          player: this.engine.currentPlayer().id,
          ms: seconds * 1000,
        });
      }
    }
    await this.syncAbsentTimer();
  }

  /**
   * Arms — or clears — the grace period on a seat whose player is not
   * connected. Safe to call on any roster change: it never touches the turn
   * clock, and it will not re-arm a grace that is already running, so a
   * flapping connection cannot extend it indefinitely.
   */
  private async syncAbsentTimer() {
    const live = this.engine !== null && this.started && !this.engine.gameOver;
    const currentId = live && this.engine ? this.engine.currentPlayer().id : null;
    const present = currentId !== null && this.roster.get(currentId)?.connected === true;
    // Only worth waiting on while somebody is still in the room being kept
    // waiting. An empty room is the idle TTL's problem, not the clock's.
    const someoneWatching = this.ctx.getWebSockets().length > 0;

    if (live && !present && someoneWatching) {
      if (!this.absentDeadline) this.absentDeadline = Date.now() + ABSENT_TURN_GRACE_MS;
    } else {
      this.absentDeadline = 0;
    }
    await this.persistMeta();
    await this.armAlarm();
  }

  /**
   * A timed-out turn plays a move rather than skipping it. Skipping would
   * leave a player who has never placed a particle un-eliminable, which stalls
   * the win condition instead of resolving the match — the same reasoning the
   * local Blitz already used, now enforced in the one place that can enforce
   * it for everybody at once.
   */
  private async playTimedOutTurn() {
    if (!this.engine || this.engine.gameOver || !this.started) {
      await this.armAlarm();
      return;
    }
    const moves = this.engine.legalMoves();
    if (!moves.length) {
      await this.armAlarm();
      return;
    }
    const pick = moves[Math.floor(Math.random() * moves.length)];
    await this.applyMove(this.engine.currentPlayer().id, pick.row, pick.col);
  }

  /** Nothing here is worth keeping: the room is empty and stale. The listing
   *  goes first, so the browser stops pointing at a room that is about to stop
   *  existing. */
  private async shutDown() {
    if (this.isPublic) {
      this.isPublic = false;
      await this.syncListing();
    }
    this.engine = null;
    this.started = false;
    this.roster.clear();
    this.roomScore.clear();
    this.rematchVotes.clear();
    this.hostId = null;
    // Seat numbering restarts too. Storage is about to be wiped, so a later
    // restore would come back at zero while a live instance kept counting —
    // and the two disagreeing about seat ids is worse than either value.
    this.nextPlayerId = 0;
    this.turnDeadline = 0;
    this.absentDeadline = 0;
    this.lastActivity = Date.now();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Sends a finished match to the player hub.
   *
   * Only matchmade rooms count. A room entered by code is people who chose
   * each other, so rating it is an open invitation to farm a ladder against a
   * second device — and a friendly game between friends should not move
   * anyone's rank anyway.
   *
   * Gated on `ranked` rather than `isPublic`: the latter is client-settable
   * and was therefore never a safe basis for deciding what counts.
   */
  private async reportResult(winnerId: number) {
    if (!this.ranked || !this.engine) return;
    const players = this.engine.players
      .map((p) => {
        const entry = this.roster.get(p.id);
        if (!entry?.accountId || !entry.accountSecret) return null;
        return {
          id: entry.accountId,
          secret: entry.accountSecret,
          won: p.id === winnerId,
          bestChain: entry.bestChain ?? 0,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    // Every seat has to be a verified account or the result is meaningless —
    // rating someone against an anonymous opponent rates them against nothing.
    if (players.length < 2 || players.length !== this.engine.players.length) return;

    try {
      const stub = this.env.PLAYER_HUB.getByName(PLAYER_HUB_SINGLETON);
      const res = await stub.fetch('https://hub/result', {
        method: 'POST',
        body: JSON.stringify({ players }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        ratings?: { id: string; rating: number; delta: number }[];
      };
      if (!body.ok || !body.ratings) return;

      // Back from account ids to seat ids: the client knows the board, not the
      // ladder's identifiers.
      const bySeat = body.ratings
        .map((row) => {
          const seat = this.engine?.players.find(
            (p) => this.roster.get(p.id)?.accountId === row.id
          );
          return seat ? { player: seat.id, rating: row.rating, delta: row.delta } : null;
        })
        .filter((row): row is { player: number; rating: number; delta: number } => row !== null);

      if (bySeat.length > 0) this.broadcastAll({ type: 'rated', results: bySeat });
    } catch (err) {
      // A match must never fail because the ladder was unreachable.
      console.error('result report failed:', String(err));
    }
  }

  private async handleRematchVote(att: Attachment) {
    if (!this.engine || !this.engine.gameOver) return;
    this.rematchVotes.add(att.id);
    this.broadcastRematchState();

    const connected = this.connectedSeatIds();
    if (connected.length < 2) return;
    if (!connected.every((id) => this.rematchVotes.has(id))) return;

    // Everyone still in the room wants another game — go straight into it
    // rather than dropping back to the lobby, which is what made a rematch
    // feel like starting over instead of continuing.
    const players = this.engine.players.map((p) => ({ ...p, isAlive: true }));
    await this.beginGame(this.engine.rows, this.engine.cols, players);
  }

  private handleTaunt(att: Attachment, emoji: number) {
    if (!isValidTaunt(emoji)) return;
    const now = Date.now();
    const last = this.lastTaunt.get(att.id) ?? 0;
    // Silently dropped rather than answered with an error: a rate-limited
    // taunt is not a mistake worth interrupting the player about.
    if (now - last < TAUNT_COOLDOWN_MS) return;
    this.lastTaunt.set(att.id, now);
    this.broadcastAll({ type: 'taunt', from: att.id, emoji });
  }

  /**
   * Quick chat. Same shape as a taunt, on its own cooldown.
   *
   * The index is validated against the phrase list rather than trusted: the
   * whole reason this is an index and not a string is that a client cannot
   * then put arbitrary text on someone else's screen, and that only holds if
   * the relay checks the number is one it recognises.
   */
  private handleChat(att: Attachment, phrase: number) {
    if (!isValidChat(phrase)) return;
    const now = Date.now();
    const last = this.lastChat.get(att.id) ?? 0;
    if (now - last < CHAT_COOLDOWN_MS) return;
    this.lastChat.set(att.id, now);
    this.broadcastAll({ type: 'chat', from: att.id, phrase });
  }

  /**
   * Attaches an account to this seat, so a finished ranked match can be
   * reported under a verified identity.
   *
   * The relay does not check the secret here — the hub does, when the result
   * is submitted, and it rejects the whole match if any seat fails. Verifying
   * twice would mean a hub round trip on every join for no extra safety.
   * What this *does* enforce is that one account cannot occupy two seats in
   * the same room, which is the cheap half of collusion prevention and has to
   * happen here because only the room knows who else is sitting down.
   */
  private handleAuth(att: Attachment, id: unknown, secret: unknown) {
    if (typeof id !== 'string' || typeof secret !== 'string') return;
    if (id.length > 64 || secret.length > 64) return;
    const entry = this.roster.get(att.id);
    if (!entry) return;

    for (const [seatId, other] of this.roster) {
      if (seatId !== att.id && other.accountId === id) {
        this.send(this.ctx.getWebSockets()[0], {
          type: 'error',
          message: 'That account is already in this room.',
        });
        return;
      }
    }

    entry.accountId = id;
    entry.accountSecret = secret;
    void this.persistMeta();
  }

  private async handlePickColor(ws: WebSocket, att: Attachment, colorIndex: number) {
    if (this.started) return;
    if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex >= PLAYER_THEMES.length) return;
    const takenByOther = Array.from(this.roster.entries()).some(
      ([id, entry]) => id !== att.id && entry.connected && entry.colorIndex === colorIndex
    );
    if (takenByOther) {
      this.send(ws, { type: 'error', message: 'That color is already taken.' });
      return;
    }
    const entry = this.roster.get(att.id);
    if (!entry) return;
    entry.colorIndex = colorIndex;
    await this.persistMeta();
    this.broadcastPlayers();
  }

  private pickDefaultColor(): number {
    const taken = new Set(
      Array.from(this.roster.values())
        .filter((e) => e.connected)
        .map((e) => e.colorIndex)
    );
    for (let i = 0; i < PLAYER_THEMES.length; i++) {
      if (!taken.has(i)) return i;
    }
    return this.nextPlayerId % PLAYER_THEMES.length;
  }

  /** Tears the match down and returns everyone to the lobby. Used when a player
   *  leaves the result screen rather than rematching, so the room can be
   *  reconfigured instead of being stuck on the last game's settings. */
  private async returnToLobby() {
    this.started = false;
    this.engine = null;
    this.rematchVotes.clear();
    this.turnDeadline = 0;
    this.absentDeadline = 0;
    await this.ctx.storage.delete('engineSnapshot');
    await this.persistMeta();
    this.broadcastPlayers();
    await this.armAlarm();
  }

  private rosterList(): NetPlayer[] {
    return Array.from(this.roster.entries())
      .map(([id, entry]) => ({ id, name: entry.name, connected: entry.connected, colorIndex: entry.colorIndex }))
      .sort((a, b) => a.id - b.id);
  }

  private broadcastPlayers() {
    this.broadcastAll({
      type: 'players',
      players: this.rosterList(),
      hostId: this.hostId ?? -1,
      isPublic: this.isPublic,
    });
    void this.syncListing();
  }

  /** Keeps the public list honest. Driven from the room rather than from a
   *  client heartbeat, so a listing can only be wrong for as long as it takes
   *  this call to land — and a room that dies outright still expires on the
   *  matchmaker's own TTL. */
  private async syncListing() {
    const connected = this.rosterList().filter((p) => p.connected);
    const shouldList = this.isPublic && !this.started && connected.length > 0 && connected.length < MAX_PLAYERS;
    const stub = this.env.MATCHMAKER.getByName(MATCHMAKER_SINGLETON);

    try {
      if (shouldList) {
        const room: PublicRoom = {
          code: this.roomCode,
          host: connected.find((p) => p.id === this.hostId)?.name ?? connected[0].name,
          mode: this.mode,
          boardSize: this.boardSize,
          players: connected.length,
          maxPlayers: MAX_PLAYERS,
        };
        await stub.fetch('https://mm/publish', { method: 'POST', body: JSON.stringify(room) });
      } else {
        await stub.fetch('https://mm/unpublish', {
          method: 'POST',
          body: JSON.stringify({ code: this.roomCode }),
        });
      }
    } catch (err) {
      // The list is a convenience; a room must never fail because it could not
      // advertise itself.
      console.error('listing sync failed:', String(err));
    }
  }

  private broadcastAll(msg: ServerMsg) {
    const payload = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch (err) {
        console.error(`broadcast(${msg.type}) failed for a socket:`, String(err));
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    ws.send(JSON.stringify(msg));
  }

  private async persistMeta() {
    const meta: Meta = {
      started: this.started,
      nextPlayerId: this.nextPlayerId,
      hostId: this.hostId,
      boardSize: this.boardSize,
      landscape: this.landscape,
      orbStyle: this.orbStyle,
      mode: this.mode,
      seed: this.seed,
      rows: this.engine?.rows,
      cols: this.engine?.cols,
      roster: Array.from(this.roster.entries()),
      roomScore: Array.from(this.roomScore.entries()),
      isPublic: this.isPublic,
      ranked: this.ranked,
      roomCode: this.roomCode,
      turnDeadline: this.turnDeadline,
      absentDeadline: this.absentDeadline,
      lastActivity: this.lastActivity,
    };
    await this.ctx.storage.put('meta', meta);
  }

  private async persistEngine() {
    if (this.engine) {
      await this.ctx.storage.put('engineSnapshot', this.engine.getSnapshot());
    }
  }
}
