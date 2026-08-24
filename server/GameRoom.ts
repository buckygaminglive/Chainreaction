import { DurableObject } from 'cloudflare:workers';
import { GameEngine } from '../src/game/GameEngine';
import { layoutForMode, randomSeed } from '../src/game/cells';
import { GAME_MODES, type GameModeKey } from '../src/game/modes';
import type { EngineSnapshot, PlayerConfig } from '../src/game/types';
import type { BoardSizeKey, ClientMsg, NetPlayer, OrbStyleKey, ServerMsg } from '../src/net/protocol';
import { PLAYER_THEMES } from '../src/render/theme';

/** Team Battle pairs teammates into related emissions so a side reads as a
 *  side: cool tones against warm ones. */
const TEAM_COLOR_INDICES = [
  [0, 5],
  [1, 7],
];

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
}

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
}

interface Meta {
  started: boolean;
  nextPlayerId: number;
  hostId: number | null;
  boardSize: BoardSizeKey;
  orbStyle: OrbStyleKey;
  mode: GameModeKey;
  seed: number;
  rows?: number;
  cols?: number;
  roster: [number, RosterEntry][];
}

const BOARD_SIZES: Record<BoardSizeKey, { rows: number; cols: number }> = {
  small: { rows: 9, cols: 5 },
  medium: { rows: 11, cols: 6 },
  large: { rows: 13, cols: 7 },
};

const MAX_PLAYERS = 6;

export class GameRoom extends DurableObject<Env> {
  private engine: GameEngine | null = null;
  private started = false;
  private nextPlayerId = 0;
  private hostId: number | null = null;
  private boardSize: BoardSizeKey = 'medium';
  private orbStyle: OrbStyleKey = 'emoji';
  private mode: GameModeKey = 'classic';
  private seed = 0;
  private roster = new Map<number, RosterEntry>();
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
        this.orbStyle = meta.orbStyle;
        this.mode = meta.mode ?? 'classic';
        this.seed = meta.seed ?? 0;
        this.roster = new Map(meta.roster);
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
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const url = new URL(request.url);
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

    this.broadcastPlayers();

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

    if (msg.type === 'startGame') {
      // `mode` is newer than the deployed client. Treating its absence as
      // Classic is what lets the relay ship before the client without
      // breaking whoever is mid-session on the old build.
      await this.handleStart(ws, att, msg.boardSize, msg.orbStyle, msg.mode ?? 'classic');
    } else if (msg.type === 'move') {
      await this.handleMove(ws, att, msg.row, msg.col);
    } else if (msg.type === 'restart') {
      await this.handleRestart(att);
    } else if (msg.type === 'pickColor') {
      await this.handlePickColor(ws, att, msg.colorIndex);
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
  }

  private async handleStart(
    ws: WebSocket,
    att: Attachment,
    boardSize: BoardSizeKey,
    orbStyle: OrbStyleKey,
    mode: GameModeKey
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

    const size = BOARD_SIZES[boardSize];
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
    this.orbStyle = orbStyle;
    this.mode = mode;
    // The relay owns the seed. Letting the host pick it would let a host
    // re-roll the lattice until they liked it.
    this.seed = randomSeed();
    this.engine = new GameEngine({
      rows: size.rows,
      cols: size.cols,
      players,
      kinds: layoutForMode(mode, size.rows, size.cols, this.seed),
    });
    this.started = true;
    await this.persistMeta();
    await this.persistEngine();

    this.broadcastAll({
      type: 'gameStarted',
      rows: size.rows,
      cols: size.cols,
      players,
      orbStyle: this.orbStyle,
      mode: this.mode,
      seed: this.seed,
    });
  }

  private async handleMove(ws: WebSocket, att: Attachment, row: number, col: number) {
    if (!this.engine || this.engine.gameOver) return;
    if (this.engine.currentPlayer().id !== att.id) {
      this.send(ws, { type: 'error', message: "It's not your turn." });
      return;
    }
    if (!this.engine.canPlay(row, col)) return;

    this.engine.applyMove(row, col);
    await this.persistEngine();
    this.broadcastAll({ type: 'move', row, col });
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

  private async handleRestart(att: Attachment) {
    if (att.id !== this.hostId) return;
    this.started = false;
    this.engine = null;
    await this.ctx.storage.delete('engineSnapshot');
    await this.persistMeta();
    this.broadcastPlayers();
  }

  private rosterList(): NetPlayer[] {
    return Array.from(this.roster.entries())
      .map(([id, entry]) => ({ id, name: entry.name, connected: entry.connected, colorIndex: entry.colorIndex }))
      .sort((a, b) => a.id - b.id);
  }

  private broadcastPlayers() {
    this.broadcastAll({ type: 'players', players: this.rosterList(), hostId: this.hostId ?? -1 });
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
      orbStyle: this.orbStyle,
      mode: this.mode,
      seed: this.seed,
      rows: this.engine?.rows,
      cols: this.engine?.cols,
      roster: Array.from(this.roster.entries()),
    };
    await this.ctx.storage.put('meta', meta);
  }

  private async persistEngine() {
    if (this.engine) {
      await this.ctx.storage.put('engineSnapshot', this.engine.getSnapshot());
    }
  }
}
