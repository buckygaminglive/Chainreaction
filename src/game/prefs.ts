/** The menu choices a player made last time, kept device-local next to
 *  `stats`. Separate from stats on purpose: these are settings the player
 *  chose, not a record of what happened, and the two want different
 *  treatment when they go bad — a lost statistic is a shrug, a lost setting
 *  is the menu forgetting who you are on every visit.
 *
 *  Everything is validated on read rather than trusted. The stored values are
 *  the same vocabularies the mode table and the protocol use, and a record
 *  written by an older build can name a mode or a board size this one no
 *  longer has. */
import { GAME_MODES, DEFAULT_MODE, type GameModeKey } from './modes.ts';
import type { BoardSizeKey, OrbStyleKey } from '../net/protocol.ts';

/** 'auto' follows the operating system. The two explicit values exist because
 *  a system-wide motion setting is a blunt instrument — someone may want the
 *  cascade animations here and nowhere else, or the reverse. */
export type MotionPref = 'auto' | 'full' | 'reduced';

export interface Prefs {
  mode: GameModeKey;
  boardSize: BoardSizeKey;
  players: number;
  orbStyle: OrbStyleKey;
  muted: boolean;
  /** Master level, 0–1. */
  volume: number;
  /** Ambient bed level relative to master, 0–1. */
  music: number;
  haptics: boolean;
  motion: MotionPref;
  /** Names for local seats, indexed by seat. Sparse and short by design — an
   *  empty entry means "no name given", which falls back to Player N rather
   *  than storing the fallback and pretending it was a choice. */
  names: string[];
  /** The name this device plays online under. Kept here as well as on the
   *  relay so it survives before an account exists, and so a returning player
   *  is not handed a fresh random name on every visit. */
  callsign: string;
}

/** Long enough for a real name, short enough to fit a pill on the HUD. */
export const MAX_NAME_LENGTH = 12;
/** Online names get a little more room than local seats: they sit on a
 *  leaderboard rather than in a HUD pill. */
export const MAX_CALLSIGN_LENGTH = 16;
const MAX_SEATS = 6;

const STORAGE_KEY = 'reacton.prefs.v1';

const DEFAULTS: Prefs = {
  mode: DEFAULT_MODE,
  boardSize: 'medium',
  players: 2,
  orbStyle: 'dots',
  muted: false,
  volume: 0.8,
  // Deliberately under the effects out of the box. A bed the player notices on
  // the first visit is not restrained, whatever §6 calls it.
  music: 0.45,
  haptics: true,
  motion: 'auto',
  names: [],
  callsign: '',
};

const BOARD_SIZE_KEYS: BoardSizeKey[] = ['small', 'medium', 'large'];
const ORB_STYLE_KEYS: OrbStyleKey[] = ['dots', 'emoji'];
const MOTION_KEYS: MotionPref[] = ['auto', 'full', 'reduced'];

function level(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** Names come back from storage as whatever was there last time, which on a
 *  shared device is whatever somebody typed — so they are length-capped and
 *  stripped of control characters here rather than trusted. */
function readNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_SEATS)
    .map((entry) =>
      typeof entry === 'string'
        ? entry.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH)
        : ''
    );
}

function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

function read(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Record<keyof Prefs, unknown>>;
    const players = Number(parsed.players);
    return {
      mode: pick(parsed.mode, Object.keys(GAME_MODES) as GameModeKey[], DEFAULTS.mode),
      boardSize: pick(parsed.boardSize, BOARD_SIZE_KEYS, DEFAULTS.boardSize),
      players: Number.isFinite(players) ? Math.min(6, Math.max(2, Math.round(players))) : DEFAULTS.players,
      orbStyle: pick(parsed.orbStyle, ORB_STYLE_KEYS, DEFAULTS.orbStyle),
      muted: parsed.muted === true,
      volume: level(parsed.volume, DEFAULTS.volume),
      music: level(parsed.music, DEFAULTS.music),
      haptics: parsed.haptics !== false,
      motion: pick(parsed.motion, MOTION_KEYS, DEFAULTS.motion),
      names: readNames(parsed.names),
      callsign:
        typeof parsed.callsign === 'string'
          ? parsed.callsign.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_CALLSIGN_LENGTH)
          : '',
    };
  } catch {
    // Private-browsing modes and disabled storage both throw here. Defaults
    // are always a playable menu, so nothing about this is worth surfacing.
    return { ...DEFAULTS };
  }
}

export const prefs = {
  get(): Prefs {
    return read();
  },

  /** Writes the whole record. Callers hold the live menu state anyway, so a
   *  merge would only add a way for the two to disagree. */
  save(next: Prefs) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable — the menu still works, it just forgets */
    }
  },
};
