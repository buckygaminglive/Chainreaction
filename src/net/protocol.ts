// Message protocol shared between the client and the Cloudflare Worker relay.
import type { PlayerConfig } from '../game/types';

export interface NetPlayer {
  id: number;
  name: string;
  connected: boolean;
  colorIndex: number;
}

export type BoardSizeKey = 'small' | 'medium' | 'large';
export type OrbStyleKey = 'dots' | 'emoji';

export type ClientMsg =
  | { type: 'startGame'; boardSize: BoardSizeKey; orbStyle: OrbStyleKey }
  | { type: 'move'; row: number; col: number }
  | { type: 'pickColor'; colorIndex: number }
  | { type: 'restart' };

export type ServerMsg =
  | { type: 'welcome'; youAreId: number; hostId: number; players: NetPlayer[] }
  | { type: 'players'; players: NetPlayer[]; hostId: number }
  | { type: 'gameStarted'; rows: number; cols: number; players: PlayerConfig[]; orbStyle: OrbStyleKey }
  | { type: 'move'; row: number; col: number }
  | { type: 'error'; message: string };
