import type { CellKind, CellKindGrid } from './cells.ts';
import type { Cell, EngineSnapshot, GameConfig, MoveEvent, MoveResult, PlayerConfig } from './types.ts';

const MAX_WAVES = 400;

export class GameEngine {
  rows: number;
  cols: number;
  players: PlayerConfig[];
  grid: Cell[][];
  kinds: CellKindGrid;
  currentPlayerIndex = 0;
  gameOver = false;
  winner: number | null = null;
  /** Set in Team Battle: the side that took the match, rather than a player. */
  winningTeam: number | null = null;
  private hasMoved = new Set<number>();

  constructor(config: GameConfig) {
    this.rows = config.rows;
    this.cols = config.cols;
    this.players = config.players.map((p) => ({ ...p, isAlive: true }));
    this.kinds =
      config.kinds ??
      Array.from({ length: config.rows }, () =>
        Array.from({ length: config.cols }, () => 'normal' as CellKind)
      );
    this.grid = this.buildGrid();
  }

  kindAt(r: number, c: number): CellKind {
    return this.kinds[r]?.[c] ?? 'normal';
  }

  /** A dead site. It holds nothing, can't be played, and is skipped by
   *  `neighborsOf` — which is the whole implementation of it: adjacent cells
   *  lose a neighbour and therefore a point of critical mass automatically. */
  isVoid(r: number, c: number): boolean {
    return this.kindAt(r, c) === 'void';
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
      if (this.inBounds(nr, nc) && !this.isVoid(nr, nc)) result.push({ row: nr, col: nc });
    }
    return result;
  }

  criticalMass(r: number, c: number): number {
    const neighbours = this.neighborsOf(r, c).length;
    switch (this.kindAt(r, c)) {
      // Floored at 2 on purpose. A catalyst corner would otherwise go critical
      // at a single orb, and a site that ejects the instant it is touched can
      // never be held — it stops being a position you play around and becomes
      // one you avoid.
      case 'catalyst':
        return Math.max(2, neighbours - 1);
      case 'damper':
        return neighbours + 1;
      default:
        return neighbours;
    }
  }

  currentPlayer(): PlayerConfig {
    return this.players[this.currentPlayerIndex];
  }

  canPlay(r: number, c: number): boolean {
    if (this.gameOver) return false;
    if (!this.inBounds(r, c)) return false;
    if (this.isVoid(r, c)) return false;
    const cell = this.getCell(r, c);
    const player = this.currentPlayer();
    if (!player.isAlive) return false;
    return cell.owner === null || cell.owner === player.id;
  }

  aliveCount(): number {
    return this.players.filter((p) => p.isAlive).length;
  }

  /** True when the roster is split into sides. */
  get isTeamGame(): boolean {
    return this.players.some((p) => p.team !== undefined);
  }

  teamOf(playerId: number): number | undefined {
    return this.players.find((p) => p.id === playerId)?.team;
  }

  /** Sides with at least one player still standing. */
  private aliveTeams(): number[] {
    const teams = new Set<number>();
    for (const p of this.players) {
      if (p.isAlive && p.team !== undefined) teams.add(p.team);
    }
    return Array.from(teams);
  }

  /** Every legal cell for the player to move in right now. Used by Blitz's
   *  turn timer to auto-play rather than skip — skipping a turn would leave a
   *  player who has never placed an orb un-eliminable and stall the match. */
  legalMoves(): { row: number; col: number }[] {
    const moves: { row: number; col: number }[] = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.canPlay(r, c)) moves.push({ row: r, col: c });
      }
    }
    return moves;
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

  /** The single side that owns every orb currently on the board, or null if
   *  the board is empty or contested. A "side" is a team where there are
   *  teams and a player everywhere else, so the cascade guard below works
   *  unchanged in Team Battle — a board held entirely by one team is just as
   *  decided as one held by a single player. */
  private soleSideOwner(): number | null {
    let side: number | null = null;
    for (const row of this.grid) {
      for (const cell of row) {
        if (cell.owner === null || cell.orbs <= 0) continue;
        const s = this.isTeamGame ? this.teamOf(cell.owner) ?? cell.owner : cell.owner;
        if (side === null) side = s;
        else if (side !== s) return null;
      }
    }
    return side;
  }

  applyMove(r: number, c: number): MoveResult {
    const events: MoveEvent[] = [];
    if (!this.canPlay(r, c)) {
      return { events, gameOver: this.gameOver, winner: this.winner, chain: 0, captured: 0 };
    }

    const player = this.currentPlayer();
    const enemyCellsBefore = this.enemyCellCount(player.id);
    const cell = this.getCell(r, c);
    cell.owner = player.id;
    cell.orbs += 1;
    this.hasMoved.add(player.id);
    events.push({ type: 'place', row: r, col: c, player: player.id, orbs: cell.orbs });

    const chain = this.resolveExplosions(player.id, events);
    this.checkEliminations(events);
    // Cells taken off opponents. A cell can only stop belonging to an opponent
    // by being converted to the mover — an ejection claims the neighbour before
    // it can ever go critical itself — so the drop is exactly the capture count.
    const captured = Math.max(0, enemyCellsBefore - this.enemyCellCount(player.id));

    // A side is out only when every player on it is — that is the whole of
    // Team Battle's win condition.
    const decided = this.isTeamGame ? this.aliveTeams().length <= 1 : this.aliveCount() <= 1;
    if (decided && this.hasMoved.size > 1) {
      this.gameOver = true;
      const survivor = this.players.find((p) => p.isAlive);
      this.winner = survivor ? survivor.id : player.id;
      this.winningTeam = this.isTeamGame ? this.teamOf(this.winner) ?? null : null;
      events.push({ type: 'win', player: this.winner });
    } else {
      this.advanceTurn();
      events.push({ type: 'turnChange', player: this.currentPlayer().id });
    }

    return { events, gameOver: this.gameOver, winner: this.winner, chain, captured };
  }

  /** Resolves the cascade this move set off, wave by wave. Returns the number
   *  of waves it took. */
  private resolveExplosions(playerId: number, events: MoveEvent[]): number {
    // Everyone having placed at least once is what makes an all-one-colour
    // board terminal — until then a player with no orbs yet is still in the
    // game, so the cascade has to be played out in full.
    const allHaveMoved = this.players.every((p) => this.hasMoved.has(p.id));
    let wave = 0;
    while (wave < MAX_WAVES) {
      // A board where one player owns every orb is already decided, and once
      // it is also saturated the cascade genuinely never ends — each cell
      // keeps being pushed back over critical mass by its neighbours, forever.
      // Cutting out here is what stops a winning move from spinning through
      // hundreds of pointless waves; no further wave could change the outcome.
      if (allHaveMoved && this.soleSideOwner() !== null) break;

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
    return wave;
  }

  /** Cells held by someone actually opposing this player — a teammate's cells
   *  are not a capture target, so taking one would not count as a capture. */
  private enemyCellCount(playerId: number): number {
    const myTeam = this.teamOf(playerId);
    let total = 0;
    for (const row of this.grid) {
      for (const cell of row) {
        if (cell.owner === null || cell.owner === playerId) continue;
        if (this.isTeamGame && myTeam !== undefined && this.teamOf(cell.owner) === myTeam) continue;
        total++;
      }
    }
    return total;
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

  /**
   * Takes a player out of the match: they left, or ran out of turns on the
   * clock. Their orbs are cleared rather than handed to anyone, so nobody is
   * gifted a board, and the match ends if only one side is left standing.
   * Deterministic, so the relay and every client can apply it and stay in sync.
   */
  forfeit(playerId: number): MoveResult {
    const events: MoveEvent[] = [];
    const player = this.players.find((p) => p.id === playerId);
    if (!player || !player.isAlive || this.gameOver) {
      return { events, gameOver: this.gameOver, winner: this.winner, chain: 0, captured: 0 };
    }
    const wasCurrent = this.currentPlayer().id === playerId;
    for (const row of this.grid) {
      for (const cell of row) {
        if (cell.owner === playerId) {
          cell.owner = null;
          cell.orbs = 0;
        }
      }
    }
    player.isAlive = false;
    this.hasMoved.add(playerId);
    events.push({ type: 'eliminate', player: playerId });

    const decided = this.isTeamGame ? this.aliveTeams().length <= 1 : this.aliveCount() <= 1;
    if (decided) {
      const survivor = this.players.find((p) => p.isAlive);
      if (survivor) {
        this.gameOver = true;
        this.winner = survivor.id;
        this.winningTeam = this.isTeamGame ? this.teamOf(survivor.id) ?? null : null;
        events.push({ type: 'win', player: survivor.id });
      }
    } else if (wasCurrent) {
      this.advanceTurn();
      events.push({ type: 'turnChange', player: this.currentPlayer().id });
    }
    return { events, gameOver: this.gameOver, winner: this.winner, chain: 0, captured: 0 };
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
      kinds: this.kinds.map((row) => [...row]),
    };
  }

  loadSnapshot(snap: EngineSnapshot) {
    this.grid = snap.grid;
    this.currentPlayerIndex = snap.currentPlayerIndex;
    this.gameOver = snap.gameOver;
    this.winner = snap.winner;
    this.players = snap.players;
    this.hasMoved = new Set(snap.hasMoved);
    // A room restored from hibernation has to come back with the same lattice
    // it went down with, or the relay starts validating against a board the
    // clients aren't playing on.
    if (snap.kinds) this.kinds = snap.kinds;
    this.winningTeam = this.isTeamGame && this.winner !== null ? this.teamOf(this.winner) ?? null : null;
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
