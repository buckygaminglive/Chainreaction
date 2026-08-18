export interface PlayerConfig {
  id: number;
  name: string;
  color: number; // hex
  colorLight: number;
  isAlive: boolean;
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
}

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
}

export interface EngineSnapshot {
  grid: Cell[][];
  currentPlayerIndex: number;
  gameOver: boolean;
  winner: number | null;
  players: PlayerConfig[];
  hasMoved: number[];
}
