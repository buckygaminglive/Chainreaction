// Message protocol shared between the client and the Cloudflare Worker relay.
import type { EngineSnapshot, PlayerConfig } from '../game/types';
import type { GameModeKey } from '../game/modes';

export interface NetPlayer {
  id: number;
  name: string;
  connected: boolean;
  colorIndex: number;
}

export type BoardSizeKey = 'small' | 'medium' | 'large';
export type OrbStyleKey = 'dots' | 'emoji';

export type ClientMsg =
  // `mode` is optional on the wire only so a relay running ahead of the
  // deployed client still understands it. New clients always send it.
  | { type: 'startGame'; boardSize: BoardSizeKey; orbStyle: OrbStyleKey; mode?: GameModeKey }
  | { type: 'move'; row: number; col: number }
  | { type: 'pickColor'; colorIndex: number }
  /** Legacy immediate restart. Current clients send `rematchVote`; the relay
   *  treats this as a vote so an older build still works in a mixed room. */
  | { type: 'restart' }
  /** Ask for another game on the same settings. The match restarts once every
   *  connected player has asked. */
  | { type: 'rematchVote' }
  | { type: 'taunt'; emoji: number }
  | { type: 'ping' };

export type ServerMsg =
  | {
      type: 'welcome';
      youAreId: number;
      hostId: number;
      players: NetPlayer[];
      /** Secret proving ownership of this seat. Presented on reconnect to
       *  reclaim it — without one, a returning player would be handed a fresh
       *  seat and their board would be gone. Never broadcast to the room. */
      token: string;
    }
  | { type: 'players'; players: NetPlayer[]; hostId: number }
  | {
      /** Sent to a player who reconnected into a match already in progress.
       *  Carries the whole authoritative board rather than a move log — the
       *  engine can already serialize itself, so catching up is a load rather
       *  than a replay. */
      type: 'resume';
      rows: number;
      cols: number;
      orbStyle: OrbStyleKey;
      mode: GameModeKey;
      snapshot: EngineSnapshot;
    }
  | {
      type: 'gameStarted';
      rows: number;
      cols: number;
      players: PlayerConfig[];
      orbStyle: OrbStyleKey;
      /** Optional on the wire only, so a client running ahead of the deployed
       *  relay still works instead of crashing on an undefined mode. A current
       *  relay always sends both. */
      mode?: GameModeKey;
      /** Every client rebuilds the special-cell lattice from this rather than
       *  receiving it cell by cell — same generator, same seed, same board,
       *  and the message stays small. */
      seed?: number;
    }
  | { type: 'move'; row: number; col: number }
  | { type: 'taunt'; from: number; emoji: number }
  /** Who has asked for a rematch, and how many are needed. */
  | { type: 'rematch'; votes: number[]; needed: number }
  /** Running head-to-head across rematches in this room. Lives only as long as
   *  the room does — persistent records are a separate, account-backed thing. */
  | { type: 'roomScore'; score: [number, number][] }
  | { type: 'error'; message: string }
  | { type: 'pong' };
