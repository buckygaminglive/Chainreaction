import type { PlayerConfig } from '../game/types';
import type { BoardSizeKey, ClientMsg, NetPlayer, OrbStyleKey, ServerMsg } from './protocol';

const RELAY_BASE = 'https://chain-reaction-relay.buckygaminglive.workers.dev';
const PING_INTERVAL_MS = 15000;
const PONG_TIMEOUT_MS = 8000;
// Mobile networks and backgrounded tabs can kill a WebSocket without ever firing
// a close event promptly — a heartbeat plus these retries recover from that.
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 8000];

export class NetClient {
  private ws: WebSocket | null = null;
  private name = '';
  private gameHasStarted = false;
  private intentionalClose = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  roomCode = '';
  myId = -1;
  hostId = -1;
  players: NetPlayer[] = [];

  onPlayers: (players: NetPlayer[], hostId: number) => void = () => {};
  onGameStarted: (rows: number, cols: number, players: PlayerConfig[], orbStyle: OrbStyleKey) => void = () => {};
  onMove: (row: number, col: number) => void = () => {};
  onError: (message: string) => void = () => {};
  onDisconnect: () => void = () => {};
  /** Fired while silently retrying after an unexpected drop, before the game has started. */
  onReconnecting: (attempt: number, maxAttempts: number) => void = () => {};
  onReconnected: () => void = () => {};

  get isHost(): boolean {
    return this.myId !== -1 && this.myId === this.hostId;
  }

  async createRoom(): Promise<string> {
    const res = await fetch(`${RELAY_BASE}/api/create`, { method: 'POST' });
    if (!res.ok) throw new Error('Could not reach the server. Check your connection and try again.');
    const data = (await res.json()) as { code: string };
    return data.code;
  }

  connect(code: string, name: string): Promise<void> {
    this.roomCode = code.toUpperCase();
    this.name = name;
    this.intentionalClose = false;
    this.gameHasStarted = false;
    this.reconnectAttempt = 0;
    return this.open(false);
  }

  private open(isReconnect: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const base = RELAY_BASE.replace(/^http/, 'ws');
      const ws = new WebSocket(`${base}/api/room/${this.roomCode}?name=${encodeURIComponent(this.name)}`);
      this.ws = ws;
      let settled = false;

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
        }
      };
      ws.onclose = () => {
        this.stopHeartbeat();
        if (!settled) return; // initial handshake failed — the reject() above already surfaced it
        if (this.intentionalClose || this.gameHasStarted) {
          this.onDisconnect();
          return;
        }
        this.tryReconnect();
      };
    });
  }

  private tryReconnect() {
    if (this.intentionalClose || this.gameHasStarted) return;
    if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      this.onDisconnect();
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt];
    this.reconnectAttempt++;
    this.onReconnecting(this.reconnectAttempt, RECONNECT_DELAYS_MS.length);
    setTimeout(() => {
      if (this.intentionalClose || this.gameHasStarted) return;
      this.open(true).catch(() => {
        this.tryReconnect();
      });
    }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.send({ type: 'ping' });
      if (this.pongTimeout) clearTimeout(this.pongTimeout);
      this.pongTimeout = setTimeout(() => {
        // No pong in time — the connection is likely dead even though it
        // hasn't fired a close event yet. Force it closed so reconnect kicks in.
        this.ws?.close();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
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
        this.onPlayers(this.players, this.hostId);
        break;
      case 'players':
        this.players = msg.players;
        this.hostId = msg.hostId;
        this.onPlayers(this.players, this.hostId);
        break;
      case 'gameStarted':
        this.gameHasStarted = true;
        this.onGameStarted(msg.rows, msg.cols, msg.players, msg.orbStyle);
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

  private send(msg: ClientMsg) {
    this.ws?.send(JSON.stringify(msg));
  }

  startGame(boardSize: BoardSizeKey, orbStyle: OrbStyleKey) {
    this.send({ type: 'startGame', boardSize, orbStyle });
  }

  sendMove(row: number, col: number) {
    this.send({ type: 'move', row, col });
  }

  pickColor(colorIndex: number) {
    this.send({ type: 'pickColor', colorIndex });
  }

  restart() {
    this.send({ type: 'restart' });
  }

  disconnect() {
    this.intentionalClose = true;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.myId = -1;
    this.hostId = -1;
    this.players = [];
  }
}
