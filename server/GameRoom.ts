import { DurableObject } from 'cloudflare:workers';
import { GameEngine } from '../src/game/GameEngine';
import type { EngineSnapshot, PlayerConfig } from '../src/game/types';
import type { BoardSizeKey, ClientMsg, NetPlayer, OrbStyleKey, ServerMsg } from '../src/net/protocol';
import { PLAYER_THEMES } from '../src/render/theme';

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
}

interface Attachment {
  id: number;
  name: string;
}

interface RosterEntry {
  name: string;
  connected: boolean;
}

interface Meta {
  started: boolean;
  nextPlayerId: number;
  hostId: number | null;
  boardSize: BoardSizeKey;
  orbStyle: OrbStyleKey;
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

    const connectedCount = this.ctx.getWebSockets().length;
    if (connectedCount >= MAX_PLAYERS) {
      return new Response('Room is full', { status: 403 });
    }
    if (this.started) {
      return new Response('Game already in progress', { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = this.nextPlayerId++;
    if (this.hostId === null) this.hostId = id;
    const hostId = this.hostId;

    server.serializeAttachment({ id, name } satisfies Attachment);
    this.ctx.acceptWebSocket(server);
    this.roster.set(id, { name, connected: true });
    await this.persistMeta();

    this.send(server, { type: 'welcome', youAreId: id, hostId, players: this.rosterList() });
    this.broadcastPlayers();

    return new Response(null, { status: 101, webSocket: client });
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
      await this.handleStart(ws, att, msg.boardSize, msg.orbStyle);
    } else if (msg.type === 'move') {
      await this.handleMove(ws, att, msg.row, msg.col);
    } else if (msg.type === 'restart') {
      await this.handleRestart(att);
    }
  }

  async webSocketClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | undefined;
    if (!att) return;
    const entry = this.roster.get(att.id);
    if (entry) entry.connected = false;

    if (!this.started && this.hostId === att.id) {
      const next = this.ctx.getWebSockets()[0];
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

  private async handleStart(ws: WebSocket, att: Attachment, boardSize: BoardSizeKey, orbStyle: OrbStyleKey) {
    if (att.id !== this.hostId || this.started) return;
    const sockets = this.ctx.getWebSockets();
    if (sockets.length < 2) {
      this.send(ws, { type: 'error', message: 'Need at least 2 players to start.' });
      return;
    }

    const size = BOARD_SIZES[boardSize];
    const players: PlayerConfig[] = sockets
      .map((s) => s.deserializeAttachment() as Attachment)
      .sort((a, b) => a.id - b.id)
      .map((a) => {
        const theme = PLAYER_THEMES[a.id % PLAYER_THEMES.length];
        return { id: a.id, name: a.name, color: theme.base, colorLight: theme.light, isAlive: true };
      });

    this.boardSize = boardSize;
    this.orbStyle = orbStyle;
    this.engine = new GameEngine({ rows: size.rows, cols: size.cols, players });
    this.started = true;
    await this.persistMeta();
    await this.persistEngine();

    this.broadcastAll({ type: 'gameStarted', rows: size.rows, cols: size.cols, players, orbStyle: this.orbStyle });
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
      .map(([id, entry]) => ({ id, name: entry.name, connected: entry.connected }))
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
      } catch {
        // socket gone; webSocketClose will clean it up
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
