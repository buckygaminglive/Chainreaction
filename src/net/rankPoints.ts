/**
 * Ranked points: what a finished ranked match is worth, by how many players
 * were in it and where you finished.
 *
 * Shared by the relay (which applies it) and the app (which shows the table on
 * the ranked screen), so what a player is promised is exactly what they get.
 * Every account starts at 0 points, Unranked; points never go below 0.
 */

export const RANKED_PLAYER_COUNTS = [2, 3, 4] as const;
export type RankedPlayers = (typeof RANKED_PLAYER_COUNTS)[number];

/** Points by finishing place (index 0 = winner). */
export const PLACE_POINTS: Record<RankedPlayers, number[]> = {
  2: [25, -15],
  3: [30, 10, -15],
  4: [35, 15, -5, -20],
};

/** Leaving a ranked match, or being removed for missing three turns, costs
 *  more than finishing last — otherwise quitting a lost game would pay. */
export const LEAVE_PENALTY = -30;

export function isRankedPlayers(n: unknown): n is RankedPlayers {
  return n === 2 || n === 3 || n === 4;
}

/** Points change for one seat. `place` is 1-based. */
export function pointsFor(players: number, place: number, left: boolean): number {
  if (left) return LEAVE_PENALTY;
  const table = PLACE_POINTS[(isRankedPlayers(players) ? players : 2) as RankedPlayers];
  return table[Math.min(Math.max(place, 1), table.length) - 1];
}

/** Applies a change without letting the total drop below zero. */
export function applyPoints(current: number, delta: number): number {
  return Math.max(0, Math.round((Number(current) || 0) + delta));
}

export function ordinal(n: number): string {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}
