/**
 * The standing roster of AI opponents.
 *
 * These exist to solve the cold-start problem: a new player who opens quick
 * match and finds nobody there does not come back. Every entry here is a real,
 * playable opponent backed by the same search in `ai.ts` — the roster is not a
 * decorative counter. That distinction matters: a player who is told eighteen
 * people are online and then waits two minutes without a match learns the
 * number was invented, and stops believing anything else the game tells them.
 * A player who is offered an opponent and gets one has a game.
 *
 * They are labelled as bots everywhere they appear, and matches against them
 * never touch the ladder.
 */

export interface Bot {
  id: string;
  name: string;
  /** Passed to chooseMove — how far down the ranked move list it will settle. */
  skill: number;
  /** Shown next to the name so a player can pick a fair fight. Derived from
   *  skill rather than invented, so the two can never disagree. */
  rating: number;
  /** Seconds it appears to "think", so a match against one has the rhythm of
   *  playing a person rather than a wall that answers instantly. */
  thinkMs: [number, number];
}

const NAMES: [string, number][] = [
  ['Solvent', 0.28],
  ['Halide', 0.34],
  ['Pyrex', 0.4],
  ['Isotope', 0.45],
  ['Quench', 0.5],
  ['Bunsen', 0.54],
  ['Titrate', 0.58],
  ['Reflux', 0.62],
  ['Meniscus', 0.66],
  ['Valence', 0.7],
  ['Crucible', 0.73],
  ['Enthalpy', 0.76],
  ['Zeolite', 0.79],
  ['Nucleate', 0.82],
  ['Fission', 0.85],
  ['Cherenkov', 0.88],
  ['Criticality', 0.92],
  ['Prometheum', 0.96],
];

/** Skill 0..1 mapped onto the same scale human accounts use, so a bot's rating
 *  means the same thing a player's does. */
function ratingFor(skill: number): number {
  return Math.round(780 + skill * 720);
}

export const BOTS: Bot[] = NAMES.map(([name, skill], i) => ({
  id: `bot-${i}`,
  name,
  skill,
  rating: ratingFor(skill),
  // Stronger opponents pause slightly longer — it reads as consideration, and
  // it stops the hardest bot also being the fastest, which feels inhuman.
  thinkMs: [420 + skill * 260, 900 + skill * 700],
}));

/** Picks an opponent near the player's own rating, so a first quick match is a
 *  game rather than a demonstration. Falls back to the middle of the roster
 *  when the player has no rating yet. */
export function pickBot(playerRating: number | null, rng: () => number = Math.random): Bot {
  const target = playerRating ?? 1000;
  const sorted = [...BOTS].sort(
    (a, b) => Math.abs(a.rating - target) - Math.abs(b.rating - target)
  );
  // From the closest five rather than the single closest, or the same opponent
  // comes up every time.
  const pool = sorted.slice(0, 5);
  return pool[Math.floor(rng() * pool.length)];
}

export function botById(id: string): Bot | undefined {
  return BOTS.find((b) => b.id === id);
}
