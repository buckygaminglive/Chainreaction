import { account } from './account';
import type { EngineSnapshot, PlayerConfig } from '../game/types';
import type { GameModeKey } from '../game/modes';
import type { BoardSizeKey, ClientMsg, NetPlayer, OrbStyleKey, PublicRoom, ServerMsg } from './protocol';

/** Set VITE_RELAY_URL (e.g. in a gitignored .env.local) to point the client at
 *  a local `wrangler dev` instead of production — necessary any time the
 *  protocol changes, since client and relay have to move together. */
const RELAY_BASE =
  import.meta.env.VITE_RELAY_URL ?? 'https://chain-reaction-relay.buckygaminglive.workers.dev';
// How often the socket's own state is inspected. Purely local, so it can be
// frequent — this is what makes a dropped connection visible to the player
// almost immediately rather than at the next ping.
const WATCHDOG_INTERVAL_MS = 1000;
// Tight enough that a turn-based match notices a silently dead link in about
// ten seconds rather than half a minute. The traffic is a few bytes either way.
const PING_INTERVAL_MS = 5000;
const PONG_TIMEOUT_MS = 6000;
// Mobile networks and backgrounded tabs can kill a WebSocket without ever firing
// a close event promptly — a heartbeat plus these retries recover from that.
// The ladder runs about a minute: a phone coming back from a tunnel or a
// screen lock is worth waiting out rather than dropping someone from a match
// they are winning.
const RECONNECT_DELAYS_MS = [800, 1500, 3000, 5000, 8000, 8000, 8000, 8000, 8000];

/** Turns a 429 into something a player can act on: how long, in plain words,
 *  rather than a status code. */
async function throttleMessage(res: Response, prefix: string): Promise<string> {
  let seconds = Number(res.headers.get('Retry-After')) || 0;
  if (!seconds) {
    const body = (await res.json().catch(() => ({}))) as { retryAfter?: number };
    seconds = body.retryAfter ?? 0;
  }
  if (seconds >= 60) return `${prefix} Try again in about ${Math.ceil(seconds / 60)} minutes.`;
  if (seconds > 0) return `${prefix} Try again in ${seconds} seconds.`;
  return `${prefix} Try again shortly.`;
}

/** Seat tokens are scoped to the tab and to the room. sessionStorage (not
 *  local) because two rooms in two tabs must not share a seat, and a token is
 *  worthless once the tab is gone. */
function tokenKey(code: string) {
  return `reacton.seat.${code}`;
}

function readToken(code: string): string | null {
  try {
    return sessionStorage.getItem(tokenKey(code));
  } catch {
    return null; // private browsing — reconnect still works in-memory
  }
}

function writeToken(code: string, token: string) {
  try {
    sessionStorage.setItem(tokenKey(code), token);
  } catch {
    /* storage unavailable; the in-memory copy still covers a network drop */
  }
}

function clearToken(code: string) {
  try {
    sessionStorage.removeItem(tokenKey(code));
  } catch {
    /* nothing to clear */
  }
}

export class NetClient {
  private ws: WebSocket | null = null;
  private name = '';
  private intentionalClose = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private token: string | null = null;
  private publicRoom = false;
  /** Declares the live socket dead without waiting on a close handshake that
   *  a vanished peer will never finish. Rebound by every `open()`. */
  private markCurrentDown: (() => void) | null = null;

  roomCode = '';
  myId = -1;
  hostId = -1;
  players: NetPlayer[] = [];

  onPlayers: (players: NetPlayer[], hostId: number, isPublic?: boolean) => void = () => {};
  onGameStarted: (
    rows: number,
    cols: number,
    players: PlayerConfig[],
    orbStyle: OrbStyleKey,
    mode: GameModeKey,
    seed: number
  ) => void = () => {};
  onMove: (row: number, col: number) => void = () => {};
  /** Fired when the relay hands back a match already in progress, after this
   *  client reconnected into it. */
  onResume: (
    rows: number,
    cols: number,
    orbStyle: OrbStyleKey,
    mode: GameModeKey,
    snapshot: EngineSnapshot
  ) => void = () => {};
  onTaunt: (from: number, emoji: number) => void = () => {};
  onRematch: (votes: number[], needed: number) => void = () => {};
  onRoomScore: (score: Map<number, number>) => void = () => {};
  onError: (message: string) => void = () => {};
  onDisconnect: () => void = () => {};
  /** Fired while silently retrying after an unexpected drop, in the lobby or
   *  mid-match. */
  onReconnecting: (attempt: number, maxAttempts: number) => void = () => {};
  onReconnected: () => void = () => {};

  get isHost(): boolean {
    return this.myId !== -1 && this.myId === this.hostId;
  }

  async createRoom(): Promise<string> {
    const res = await fetch(`${RELAY_BASE}/api/create`, { method: 'POST' });
    if (res.status === 429) throw new Error(await throttleMessage(res, 'Too many rooms created.'));
    if (!res.ok) throw new Error('Could not reach the server. Check your connection and try again.');
    const data = (await res.json()) as { code: string };
    return data.code;
  }

  /** Asks the matchmaker for a room. `waiting` means nobody was queued on
   *  these settings, so this code is now the one *other* people will be
   *  matched into — the caller sits in it until someone arrives. */
  static async quickMatch(
    mode: GameModeKey,
    boardSize: BoardSizeKey
  ): Promise<{ code: string; waiting: boolean }> {
    const res = await fetch(`${RELAY_BASE}/api/quickmatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, boardSize }),
    });
    // 404 specifically means the relay predates matchmaking — worth telling
    // apart from an outage, because the fix is a deploy, not a retry.
    if (res.status === 404) throw new Error('This server does not have matchmaking yet.');
    if (res.status === 429) throw new Error(await throttleMessage(res, 'Searching too often.'));
    if (!res.ok) throw new Error('Matchmaking is unavailable right now.');
    return (await res.json()) as { code: string; waiting: boolean };
  }

  static async cancelQuickMatch(code: string): Promise<void> {
    await fetch(`${RELAY_BASE}/api/quickmatch/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }).catch(() => {
      // Best effort — the queue entry expires on its own anyway.
    });
  }

  /** Real people currently queued or sitting in listed rooms. Allowed to be
   *  zero — the bot roster is what keeps the screen from being a dead end. */
  static async presence(): Promise<{ queued: number; inRooms: number }> {
    const res = await fetch(`${RELAY_BASE}/api/presence`);
    if (!res.ok) throw new Error('presence unavailable');
    return (await res.json()) as { queued: number; inRooms: number };
  }

  static async listRooms(): Promise<PublicRoom[]> {
    const res = await fetch(`${RELAY_BASE}/api/rooms`);
    if (res.status === 404) throw new Error('This server does not have the room list yet.');
    if (!res.ok) throw new Error('Could not load the room list.');
    const data = (await res.json()) as { rooms: PublicRoom[] };
    return data.rooms ?? [];
  }

  connect(code: string, name: string, opts: { publicRoom?: boolean } = {}): Promise<void> {
    this.roomCode = code.toUpperCase();
    this.name = name;
    this.publicRoom = !!opts.publicRoom;
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    // A token left over from this tab means we were in this room before — a
    // refresh mid-match, most likely. Offer it so the relay hands the seat
    // back instead of treating this as a brand new player.
    this.token = readToken(this.roomCode);
    return this.open(false);
  }

  private open(isReconnect: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const base = RELAY_BASE.replace(/^http/, 'ws');
      const params = new URLSearchParams({ name: this.name });
      if (this.token) params.set('token', this.token);
      // A quick-match room advertises itself, so someone browsing the list can
      // fill it too rather than everyone waiting on the queue alone.
      if (this.publicRoom) params.set('public', '1');
      // Identifies the seat to the relay so a ranked result can be attributed
      // to a verified account rather than to a name anyone could type.
      const creds = account.credentials;
      if (creds) {
        params.set('pid', creds.id);
        params.set('psec', creds.secret);
      }
      const ws = new WebSocket(`${base}/api/room/${this.roomCode}?${params}`);
      this.ws = ws;
      let settled = false;
      let downHandled = false;

      /** This connection is finished, however we found out.
       *
       *  Deliberately not driven by `close` alone: a socket whose peer has
       *  vanished can sit in CLOSING indefinitely and never fire `close` at
       *  all, which would leave the client believing it is still online. The
       *  heartbeat calls this directly when a pong goes missing. */
      const markDown = () => {
        if (downHandled) return;
        downHandled = true;
        if (this.ws !== ws) return; // a newer socket has already taken over
        this.stopHeartbeat();
        if (!settled) return; // handshake never completed — reject() covered it
        if (this.intentionalClose) {
          this.onDisconnect();
          return;
        }
        // A drop mid-match used to end the game for this player outright. With
        // a seat token the relay can hand the board back, so a match is
        // exactly the situation most worth retrying through.
        this.tryReconnect();
      };
      this.markCurrentDown = markDown;

      ws.onopen = () => {
        this.startHeartbeat();
      };

      ws.onmessage = (ev) => {
        const msg: ServerMsg = JSON.parse(ev.data);
        this.handleMessage(msg);
        if (!settled && msg.type === 'welcome') {
          settled = true;
          this.reconnectAttempt = 0;
          if (isReconnect) this.onReconnected();
          resolve();
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Could not connect to that room.'));
          return;
        }
        markDown();
      };
      ws.onclose = markDown;
    });
  }

  private tryReconnect() {
    if (this.intentionalClose) return;
    if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      this.onDisconnect();
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt];
    this.reconnectAttempt++;
    this.onReconnecting(this.reconnectAttempt, RECONNECT_DELAYS_MS.length);
    setTimeout(() => {
      if (this.intentionalClose) return;
      this.open(true).catch(() => {
        this.tryReconnect();
      });
    }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    let tick = 0;
    // One timer doing two jobs at different rates: the socket's state is
    // checked every second because that costs nothing, while an actual ping
    // only goes out every PING_INTERVAL_MS. A visibly-dead socket therefore
    // surfaces to the player in about a second instead of five.
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      // A socket whose peer never returns a close frame sits in CLOSING for as
      // long as the browser feels like it, and delivers no `close` event the
      // whole time. Anything that isn't OPEN is down — waiting for an event
      // that may never arrive is how a dropped player used to get stranded.
      if (ws.readyState !== WebSocket.OPEN) {
        this.markCurrentDown?.();
        return;
      }

      tick += WATCHDOG_INTERVAL_MS;
      if (tick < PING_INTERVAL_MS) return;
      tick = 0;

      this.send({ type: 'ping' });
      if (this.pongTimeout) clearTimeout(this.pongTimeout);
      this.pongTimeout = setTimeout(() => {
        // No pong in time — the connection is dead even though it hasn't fired
        // a close event. Ask it to close, but don't wait for a handshake the
        // other end is in no position to complete: declare it down now.
        try {
          this.ws?.close();
        } catch {
          /* already closing */
        }
        this.markCurrentDown?.();
      }, PONG_TIMEOUT_MS);
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  private handleMessage(msg: ServerMsg) {
    switch (msg.type) {
      case 'welcome':
        this.myId = msg.youAreId;
        this.hostId = msg.hostId;
        this.players = msg.players;
        this.token = msg.token;
        writeToken(this.roomCode, msg.token);
        this.onPlayers(this.players, this.hostId);
        break;
      case 'resume':
        // The relay only sends this when it recognised our seat in a live
        // match, so reaching here means the reconnect actually worked.
        this.onResume(msg.rows, msg.cols, msg.orbStyle, msg.mode, msg.snapshot);
        break;
      case 'players':
        this.players = msg.players;
        this.hostId = msg.hostId;
        this.onPlayers(this.players, this.hostId, msg.isPublic);
        break;
      case 'gameStarted':
        // Defaulted here rather than at the call site so every consumer sees a
        // real mode. An older relay sends neither field, and Classic with a
        // plain lattice is exactly what such a relay is actually running.
        this.onGameStarted(msg.rows, msg.cols, msg.players, msg.orbStyle, msg.mode ?? 'classic', msg.seed ?? 0);
        break;
      case 'taunt':
        this.onTaunt(msg.from, msg.emoji);
        break;
      case 'rematch':
        this.onRematch(msg.votes, msg.needed);
        break;
      case 'roomScore':
        this.onRoomScore(new Map(msg.score));
        break;
      case 'move':
        this.onMove(msg.row, msg.col);
        break;
      case 'error':
        this.onError(msg.message);
        break;
      case 'pong':
        if (this.pongTimeout) {
          clearTimeout(this.pongTimeout);
          this.pongTimeout = null;
        }
        break;
    }
  }

  /** Returns whether the message actually went out. Sending on a socket that
   *  is closing throws, and during a blip that is a normal thing to happen —
   *  callers need to know it didn't land rather than get an exception. */
  private send(msg: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  startGame(boardSize: BoardSizeKey, orbStyle: OrbStyleKey, mode: GameModeKey) {
    this.send({ type: 'startGame', boardSize, orbStyle, mode });
  }

  /** False when the socket wasn't up, so the caller can leave input unlocked. */
  sendMove(row: number, col: number): boolean {
    return this.send({ type: 'move', row, col });
  }

  pickColor(colorIndex: number) {
    this.send({ type: 'pickColor', colorIndex });
  }

  /** Host-only. Keeps the relay's idea of the lobby (and therefore the public
   *  listing) in step with what the host has selected. */
  setLobby(settings: { isPublic?: boolean; mode?: GameModeKey; boardSize?: BoardSizeKey }) {
    this.send({ type: 'setLobby', ...settings });
  }

  /** Asks for another game on the same settings. The relay starts one once
   *  every connected player has asked. */
  rematch() {
    this.send({ type: 'rematchVote' });
  }

  sendTaunt(emoji: number): boolean {
    return this.send({ type: 'taunt', emoji });
  }

  disconnect() {
    this.intentionalClose = true;
    this.stopHeartbeat();
    // Leaving on purpose gives up the seat, so the token must go too —
    // otherwise the next join in this tab would try to reclaim a seat the
    // player deliberately walked away from.
    clearToken(this.roomCode);
    this.token = null;
    this.ws?.close();
    this.ws = null;
    this.myId = -1;
    this.hostId = -1;
    this.players = [];
  }
}
