import { RANKS, type Rank } from '../game/rank';
import { rankEmblemSvg } from '../art/rankEmblem';

/**
 * Rank emblems, drawn rather than shipped as art — see art/rankEmblem.ts for
 * the construction. Every tier shares one cut-gem cell and climbs by
 * silhouette (blades, crest, keel, crown, backplate), so the ladder reads at a
 * glance and a badge stays crisp from 24 px to full screen.
 */
export function rankBadgeSvg(rank: Rank, size = 64): string {
  return rankEmblemSvg(rank.key, size).replace('<svg ', '<svg class="rank-badge" ');
}

/** Every tier, for a ladder view that shows where you are among all of them. */
export function allRankBadges(size = 44): { rank: Rank; svg: string }[] {
  return RANKS.map((rank) => ({ rank, svg: rankBadgeSvg(rank, size) }));
}
