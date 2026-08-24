export type GameModeKey = 'classic' | 'blitz' | 'chaos' | 'survival' | 'team' | 'power' | 'tournament';

export interface GameMode {
  key: GameModeKey;
  name: string;
  /** One-line technical descriptor shown under the mode selector. */
  blurb: string;
  /** Seconds each player gets per turn, or null for an untimed match. */
  turnSeconds: number | null;
  /** Players split into two sides; the match ends when one side is wiped out. */
  teams: boolean;
  /** Best-of-N series rather than a single match. */
  seriesLength: number;
  /** One human against escalating AI rounds. Forces the player count. */
  solo: boolean;
  /** Fixed player count, or null to let the player choose. */
  fixedPlayers: number | null;
  /** Safe to run over the relay. Anything needing a server-side clock or a
   *  local AI stays off until the relay can enforce it — see README. */
  online: boolean;
}

/** The seven modes from the roadmap. They are not seven separate systems:
 *  Chaos and Power Cells are the same special-cell layer tuned differently
 *  (random-per-match vs designed-and-fixed), Team Battle is a team-aware win
 *  condition, Tournament is a series wrapper that needs no engine change at
 *  all, and Survival is the only one that needs an AI. */
export const GAME_MODES: Record<GameModeKey, GameMode> = {
  classic: {
    key: 'classic',
    name: 'Classic',
    blurb: 'Untimed. Pure positioning and chain planning.',
    turnSeconds: null,
    teams: false,
    seriesLength: 1,
    solo: false,
    fixedPlayers: null,
    online: true,
  },
  blitz: {
    key: 'blitz',
    name: 'Blitz',
    blurb: 'Ten seconds per turn. Run the clock out and the system moves for you.',
    turnSeconds: 10,
    teams: false,
    seriesLength: 1,
    solo: false,
    fixedPlayers: null,
    online: false,
  },
  chaos: {
    key: 'chaos',
    name: 'Chaos',
    blurb: 'A new lattice every match — dead sites, catalysts and dampers, scattered symmetrically.',
    turnSeconds: null,
    teams: false,
    seriesLength: 1,
    solo: false,
    fixedPlayers: null,
    online: true,
  },
  power: {
    key: 'power',
    name: 'Power Cells',
    blurb: 'A fixed engineered lattice. Catalysts ring the centre, dampers anchor the corners.',
    turnSeconds: null,
    teams: false,
    seriesLength: 1,
    solo: false,
    fixedPlayers: null,
    online: true,
  },
  team: {
    key: 'team',
    name: 'Team Battle',
    blurb: '2v2. Turns alternate sides, and a side is out only when both of its players are.',
    turnSeconds: null,
    teams: true,
    seriesLength: 1,
    solo: false,
    fixedPlayers: 4,
    online: true,
  },
  tournament: {
    key: 'tournament',
    name: 'Tournament',
    blurb: 'Best of five. The lattice is rebuilt between games; the series score carries.',
    turnSeconds: null,
    teams: false,
    seriesLength: 5,
    solo: false,
    fixedPlayers: null,
    online: false,
  },
  survival: {
    key: 'survival',
    name: 'Survival',
    blurb: 'You against the system. Each round it plays better and the lattice degrades further.',
    turnSeconds: null,
    teams: false,
    seriesLength: 1,
    solo: true,
    fixedPlayers: 2,
    online: false,
  },
};

export const MODE_ORDER: GameModeKey[] = [
  'classic',
  'blitz',
  'chaos',
  'power',
  'team',
  'tournament',
  'survival',
];

export const DEFAULT_MODE: GameModeKey = 'classic';
