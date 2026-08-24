import type { CellKind, CellKindGrid } from './cells.ts';

export interface PlayerConfig {
  id: number;
  name: string;
  color: number; // hex
  colorLight: number;
  isAlive: boolean;
  /** Side index in Team Battle. Undefined in every free-for-all mode. */
  team?: number;
}

export interface Cell {
  row: number;
  col: number;
  owner: number | null; // player id or null
  orbs: number;
}

export interface GameConfig {
  rows: number;
  cols: number;
  players: PlayerConfig[];
  /** Special-cell layout. Omit for a plain lattice. */
  kinds?: CellKindGrid;
}

export type { CellKind, CellKindGrid };

export type MoveEvent =
  | { type: 'place'; row: number; col: number; player: number; orbs: number }
  | { type: 'explode'; row: number; col: number; player: number; wave: number; targets: { row: number; col: number }[] }
  | { type: 'eliminate'; player: number }
  | { type: 'turnChange'; player: number }
  | { type: 'win'; player: number };

export interface MoveResult {
  events: MoveEvent[];
  gameOver: boolean;
  winner: number | null;
  /** How many explosion waves this move set off. 0 = a quiet placement,
   *  1 = a single cell popped, higher = a genuine chain reaction. Drives the
   *  chain counter in the HUD and the "best chain" player statistic. */
  chain: number;
  /** Cells that changed hands to the mover during this move. */
  captured: number;
}

export interface EngineSnapshot {
  grid: Cell[][];
  currentPlayerIndex: number;
  gameOver: boolean;
  winner: number | null;
  players: PlayerConfig[];
  hasMoved: number[];
  kinds?: CellKindGrid;
}
