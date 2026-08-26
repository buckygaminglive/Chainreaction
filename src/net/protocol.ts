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

/** A guest account. The `secret` never appears here — it is held only by the
 *  client that owns it and by the relay. */
export interface PlayerProfile {
  id: string;
  name: string;
  /** Short, shareable code someone else types to add you. */
  friendCode: string;
  rating: number;
  wins: number;
  losses: number;
  matches: number;
  bestChain: number;
  /** Key into the generated avatar set — see `src/render/avatar.ts`. Four
   *  bytes rather than an image, which is what keeps this out of the
   *  user-generated-content tier on the store listing. */
  avatar: string;
}

/**
 * One finished ranked match, as the profile page shows it.
 *
 * Stored per player rather than per match: a profile only ever renders its own
 * owner's history, and duplicating a handful of fields is cheaper than joining
 * two records on every read — it also means an entry survives the opponent
 * later renaming themselves.
 */
export interface MatchRecord {
  /** Unix ms. Rendered relative, so no timezone travels with it. */
  at: number;
  won: boolean;
  /** Opponent's display name at the time the match ended. */
  opponent: string;
  opponentAvatar: string;
  /** Rating change this match caused; negative on a loss. */
  delta: number;
  /** Rating after the change. */
  rating: number;
  /** Longest chain this player set off in the match. */
  bestChain: number;
}

export interface LeaderboardRow {
  id: string;
  name: string;
  rating: number;
  wins: number;
  matches: number;
  bestChain: number;
  avatar: string;
}

/** A room advertising itself in the public list. Deliberately just a pointer —
 *  joining still goes through the normal room socket, so a listing going stale
 *  costs a failed join and nothing more. */
export interface PublicRoom {
  code: string;
  host: string;
  mode: GameModeKey;
  boardSize: BoardSizeKey;
  /** True when the lattice is turned on its side — see `landscape` below. */
  landscape?: boolean;
  players: number;
  maxPlayers: number;
}

export type ClientMsg =
  // `mode` is optional on the wire only so a relay running ahead of the
  // deployed client still understands it. New clients always send it.
  /** `landscape` turns the lattice on its side: the same three sizes, rows and
   *  columns swapped. Every board was portrait, which letterboxes badly on a
   *  monitor — the board is the whole screen, so its aspect has to be able to
   *  match the screen's. Optional on the wire so an older relay simply keeps
   *  serving portrait rather than rejecting the message. */
  | {
      type: 'startGame';
      boardSize: BoardSizeKey;
      orbStyle: OrbStyleKey;
      mode?: GameModeKey;
      landscape?: boolean;
    }
  | { type: 'move'; row: number; col: number }
  | { type: 'pickColor'; colorIndex: number }
  /** Legacy immediate restart. Current clients send `rematchVote`; the relay
   *  treats this as a vote so an older build still works in a mixed room. */
  | { type: 'restart' }
  /** Ask for another game on the same settings. The match restarts once every
   *  connected player has asked. */
  | { type: 'rematchVote' }
  | { type: 'taunt'; emoji: number }
  // An index into CHAT_PHRASES, never a string. The wire format is what makes
  // free text impossible by construction rather than by policy.
  | { type: 'chat'; phrase: number }
  /** Host-only lobby settings. The relay needs these before the game starts,
   *  not just at kick-off, or a public listing advertises whatever the room
   *  defaulted to rather than what the host actually picked. */
  | {
      type: 'setLobby';
      isPublic?: boolean;
      mode?: GameModeKey;
      boardSize?: BoardSizeKey;
      landscape?: boolean;
    }
  /** Attaches a verified account to this seat.
   *
   *  Sent as a message rather than as a query parameter on the socket URL.
   *  A URL is not a secret: it lands in the edge provider's access logs, in
   *  browser history and in any error report that captures the request, and
   *  this credential is permanent — losing it means losing the account. The
   *  message body is inside the TLS session and is never logged by default. */
  | { type: 'auth'; id: string; secret: string }
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
  | { type: 'players'; players: NetPlayer[]; hostId: number; isPublic?: boolean }
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
  | {
      /** The turn clock for a timed mode, enforced by the relay rather than by
       *  each client's own idea of when a turn expired. Carries time
       *  *remaining* rather than an absolute deadline: every client's clock is
       *  wrong by some amount, and a timestamp would be read through that
       *  error, while a duration is only read through the trip time. */
      type: 'turnClock';
      player: number;
      ms: number;
    }
  | {
      /** How a finished ranked match moved each seat. Only ever sent for
       *  public rooms — a private game between friends never touches the
       *  ladder, so there is nothing to report. */
      type: 'rated';
      results: { player: number; rating: number; delta: number }[];
    }
  | { type: 'taunt'; from: number; emoji: number }
  | { type: 'chat'; from: number; phrase: number }
  /** Who has asked for a rematch, and how many are needed. */
  | { type: 'rematch'; votes: number[]; needed: number }
  /** Running head-to-head across rematches in this room. Lives only as long as
   *  the room does — persistent records are a separate, account-backed thing. */
  | { type: 'roomScore'; score: [number, number][] }
  | { type: 'error'; message: string }
  | { type: 'pong' };
