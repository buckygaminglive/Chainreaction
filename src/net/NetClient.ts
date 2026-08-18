import type { PlayerConfig } from '../game/types';
import type { BoardSizeKey, ClientMsg, NetPlayer, OrbStyleKey, ServerMsg } from './protocol';

const RELAY_BASE = 'https://chain-reaction-relay.buckygaminglive.workers.dev';

export class NetClient {
  private ws: WebSocket | null = null;
  roomCode = '';
  myId = -1;
  hostId = -1;
  players: NetPlayer[] = [];

  onPlayers: (players: NetPlayer[], hostId: number) => void = () => {};
  onGameStarted: (rows: number, cols: number, players: PlayerConfig[], orbStyle: OrbStyleKey) => void = () => {};
  onMove: (row: number, col: number) => void = () => {};
  onError: (message: string) => void = () => {};
  onDisconnect: () => void = () => {};

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
    return new Promise((resolve, reject) => {
      this.roomCode = code.toUpperCase();
      const base = RELAY_BASE.replace(/^http/, 'ws');
      const ws = new WebSocket(`${base}/api/room/${this.roomCode}?name=${encodeURIComponent(name)}`);
      this.ws = ws;
      let settled = false;

      ws.onmessage = (ev) => {
        const msg: ServerMsg = JSON.parse(ev.data);
        this.handleMessage(msg);
        if (!settled && msg.type === 'welcome') {
          settled = true;
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
        this.onDisconnect();
      };
    });
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
        this.onGameStarted(msg.rows, msg.cols, msg.players, msg.orbStyle);
        break;
      case 'move':
        this.onMove(msg.row, msg.col);
        break;
      case 'error':
        this.onError(msg.message);
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

  restart() {
    this.send({ type: 'restart' });
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
    this.myId = -1;
    this.hostId = -1;
    this.players = [];
  }
}
