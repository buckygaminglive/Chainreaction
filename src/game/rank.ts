/** Named competitive tiers over ranked points (roadmap §9).
 *
 *  The rating was always there and always invisible: "1043" tells a player
 *  nothing about whether they are doing well. A tier is the same number with a
 *  meaning attached, and it costs no new server state — this is a pure
 *  function of a rating that already exists.
 *
 *  Bands are pinned to the scale in `server/PlayerHub.ts` (accounts start at
 *  1000) and `game/bots.ts` (the roster spans 780–1500), so every tier is
 *  reachable and a new account starts inside Bronze with room to climb rather
 *  than on a boundary it can fall off after one loss. */
export interface Rank {
  key: string;
  /** Shown in the UI. */
  name: string;
  /** Lowest rating in this tier. */
  min: number;
  /** A material, not a hue: §18 rules out a rainbow, and metals read as a
   *  progression on their own without introducing six accent colours. */
  css: string;
}

/** Ordered low to high, by ranked points. Every account starts at 0 points,
 *  Unranked, and climbs by finishing well in ranked matches (see
 *  src/net/rankPoints.ts for what each finish is worth). */
export const RANKS: Rank[] = [
  { key: 'unranked', name: 'Unranked', min: 0, css: '#8a96a6' },
  { key: 'bronze', name: 'Bronze', min: 100, css: '#b0784c' },
  { key: 'silver', name: 'Silver', min: 300, css: '#9fadbd' },
  { key: 'gold', name: 'Gold', min: 600, css: '#d9b64f' },
  { key: 'platinum', name: 'Platinum', min: 1000, css: '#86d6cb' },
  { key: 'diamond', name: 'Diamond', min: 1500, css: '#7cc2fa' },
  { key: 'master', name: 'Master', min: 2200, css: '#c9abff' },
];

export function rankFor(rating: number): Rank {
  let found = RANKS[0];
  for (const rank of RANKS) {
    if (rating >= rank.min) found = rank;
  }
  return found;
}

/** How far through the current tier a rating sits, 0–1. Master has no ceiling,
 *  so it reports full rather than inventing one. */
export function rankProgress(rating: number): number {
  const index = RANKS.indexOf(rankFor(rating));
  const next = RANKS[index + 1];
  if (!next) return 1;
  const floor = RANKS[index].min;
  return Math.min(1, Math.max(0, (rating - floor) / (next.min - floor)));
}

/** Rating needed for the next tier, or null at the top. */
export function nextRankAt(rating: number): number | null {
  const next = RANKS[RANKS.indexOf(rankFor(rating)) + 1];
  return next ? next.min : null;
}
