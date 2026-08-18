import type { Cell, EngineSnapshot, GameConfig, MoveEvent, MoveResult, PlayerConfig } from './types';

const MAX_WAVES = 400;

export class GameEngine {
  rows: number;
  cols: number;
  players: PlayerConfig[];
  grid: Cell[][];
  currentPlayerIndex = 0;
  gameOver = false;
  winner: number | null = null;
  private hasMoved = new Set<number>();

  constructor(config: GameConfig) {
    this.rows = config.rows;
    this.cols = config.cols;
    this.players = config.players.map((p) => ({ ...p, isAlive: true }));
    this.grid = this.buildGrid();
  }

  private buildGrid(): Cell[][] {
    const grid: Cell[][] = [];
    for (let r = 0; r < this.rows; r++) {
      const row: Cell[] = [];
      for (let c = 0; c < this.cols; c++) {
        row.push({ row: r, col: c, owner: null, orbs: 0 });
      }
      grid.push(row);
    }
    return grid;
  }

  getCell(r: number, c: number): Cell {
    return this.grid[r][c];
  }

  inBounds(r: number, c: number): boolean {
    return r >= 0 && r < this.rows && c >= 0 && c < this.cols;
  }

  neighborsOf(r: number, c: number): { row: number; col: number }[] {
    const deltas = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    const result: { row: number; col: number }[] = [];
    for (const [dr, dc] of deltas) {
      const nr = r + dr;
      const nc = c + dc;
      if (this.inBounds(nr, nc)) result.push({ row: nr, col: nc });
    }
    return result;
  }

  criticalMass(r: number, c: number): number {
    return this.neighborsOf(r, c).length;
  }

  currentPlayer(): PlayerConfig {
    return this.players[this.currentPlayerIndex];
  }

  canPlay(r: number, c: number): boolean {
    if (this.gameOver) return false;
    if (!this.inBounds(r, c)) return false;
    const cell = this.getCell(r, c);
    const player = this.currentPlayer();
    return cell.owner === null || cell.owner === player.id;
  }

  aliveCount(): number {
    return this.players.filter((p) => p.isAlive).length;
  }

  private playerOrbTotal(playerId: number): number {
    let total = 0;
    for (const row of this.grid) {
      for (const cell of row) {
        if (cell.owner === playerId) total += cell.orbs;
      }
    }
    return total;
  }

  applyMove(r: number, c: number): MoveResult {
    const events: MoveEvent[] = [];
    if (!this.canPlay(r, c)) {
      return { events, gameOver: this.gameOver, winner: this.winner };
    }

    const player = this.currentPlayer();
    const cell = this.getCell(r, c);
    cell.owner = player.id;
    cell.orbs += 1;
    this.hasMoved.add(player.id);
    events.push({ type: 'place', row: r, col: c, player: player.id, orbs: cell.orbs });

    this.resolveExplosions(player.id, events);
    this.checkEliminations(events);

    if (this.aliveCount() <= 1 && this.hasMoved.size > 1) {
      this.gameOver = true;
      const winner = this.players.find((p) => p.isAlive);
      this.winner = winner ? winner.id : player.id;
      events.push({ type: 'win', player: this.winner });
    } else {
      this.advanceTurn();
      events.push({ type: 'turnChange', player: this.currentPlayer().id });
    }

    return { events, gameOver: this.gameOver, winner: this.winner };
  }

  private resolveExplosions(playerId: number, events: MoveEvent[]) {
    let wave = 0;
    while (wave < MAX_WAVES) {
      const exploding: Cell[] = [];
      for (const row of this.grid) {
        for (const cell of row) {
          if (cell.orbs >= this.criticalMass(cell.row, cell.col) && cell.owner !== null) {
            exploding.push(cell);
          }
        }
      }
      if (exploding.length === 0) break;

      for (const cell of exploding) {
        const mass = this.criticalMass(cell.row, cell.col);
        const targets = this.neighborsOf(cell.row, cell.col);
        cell.orbs -= mass;
        if (cell.orbs <= 0) {
          cell.orbs = 0;
          cell.owner = null;
        }
        for (const t of targets) {
          const neighbor = this.getCell(t.row, t.col);
          neighbor.owner = playerId;
          neighbor.orbs += 1;
        }
        events.push({ type: 'explode', row: cell.row, col: cell.col, player: playerId, wave, targets });
      }
      wave++;
    }
  }

  private checkEliminations(events: MoveEvent[]) {
    for (const p of this.players) {
      if (!p.isAlive) continue;
      if (this.hasMoved.has(p.id) && this.playerOrbTotal(p.id) === 0) {
        p.isAlive = false;
        events.push({ type: 'eliminate', player: p.id });
      }
    }
  }

  /** Serializes full engine state — used by the online relay to persist/restore a room across Durable Object hibernation. */
  getSnapshot(): EngineSnapshot {
    return {
      grid: this.grid.map((row) => row.map((cell) => ({ ...cell }))),
      currentPlayerIndex: this.currentPlayerIndex,
      gameOver: this.gameOver,
      winner: this.winner,
      players: this.players.map((p) => ({ ...p })),
      hasMoved: Array.from(this.hasMoved),
    };
  }

  loadSnapshot(snap: EngineSnapshot) {
    this.grid = snap.grid;
    this.currentPlayerIndex = snap.currentPlayerIndex;
    this.gameOver = snap.gameOver;
    this.winner = snap.winner;
    this.players = snap.players;
    this.hasMoved = new Set(snap.hasMoved);
  }

  private advanceTurn() {
    let next = this.currentPlayerIndex;
    for (let i = 0; i < this.players.length; i++) {
      next = (next + 1) % this.players.length;
      if (this.players[next].isAlive) break;
    }
    this.currentPlayerIndex = next;
  }
}
