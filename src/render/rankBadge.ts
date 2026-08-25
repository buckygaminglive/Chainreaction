import { RANKS, type Rank } from '../game/rank';

/**
 * Rank emblems, drawn rather than shipped as art.
 *
 * Same reasoning as the app icons: geometry in code means one definition that
 * scales to any size, recolours from the tier's own metal, and never has to be
 * re-exported when a tier changes. It also keeps six badges off the critical
 * path — as markup they cost nothing to load.
 *
 * The tiers escalate on a single visual axis instead of six unrelated shapes:
 * a charged core, then orbital rings, then emission nodes, then a corona. That
 * is the game's own subject matter climbing, so a Diamond badge reads as *more
 * of the same thing* than a Silver one — which is what makes a ladder legible
 * at a glance. A shield, a crown and a star would each be prettier alone and
 * meaningless as a sequence.
 */

interface Emblem {
  /** Orbital rings around the core. */
  rings: number;
  /** Emission nodes sitting on those orbits. */
  nodes: number;
  /** Rays breaking out past the plate — the top tier only. */
  corona: boolean;
  /** Facet lines inside the plate, from Platinum up. */
  facets: boolean;
}

const EMBLEMS: Record<string, Emblem> = {
  bronze: { rings: 0, nodes: 0, corona: false, facets: false },
  silver: { rings: 1, nodes: 0, corona: false, facets: false },
  gold: { rings: 1, nodes: 4, corona: false, facets: false },
  platinum: { rings: 2, nodes: 4, corona: false, facets: true },
  diamond: { rings: 2, nodes: 6, corona: false, facets: true },
  master: { rings: 3, nodes: 6, corona: true, facets: true },
};

/** Unique per document so two badges of the same tier cannot collide on a
 *  gradient id — invalid markup that happens to render, until one day it
 *  does not. */
let instance = 0;

const CENTRE = 32;

/** Pointy-top hexagon: a plate with orientation, unlike a circle, so the
 *  emblem has a top even before anything is drawn inside it. */
function hexPath(radius: number): string {
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = ((-90 + i * 60) * Math.PI) / 180;
    const x = CENTRE + Math.cos(angle) * radius;
    const y = CENTRE + Math.sin(angle) * radius;
    points.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M${points.join('L')}Z`;
}

function nodesFor(count: number, radius: number, colour: string): string {
  if (count === 0) return '';
  const dots: string[] = [];
  for (let i = 0; i < count; i++) {
    // Start at the top so an even count is always symmetrical about the
    // vertical — an emblem that leans is an emblem that looks like a mistake.
    const angle = ((-90 + (360 / count) * i) * Math.PI) / 180;
    const x = CENTRE + Math.cos(angle) * radius;
    const y = CENTRE + Math.sin(angle) * radius;
    dots.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.4" fill="${colour}"/>`);
  }
  return dots.join('');
}

function coronaFor(colour: string): string {
  const rays: string[] = [];
  for (let i = 0; i < 12; i++) {
    const angle = ((-90 + i * 30) * Math.PI) / 180;
    const x1 = CENTRE + Math.cos(angle) * 27;
    const y1 = CENTRE + Math.sin(angle) * 27;
    const x2 = CENTRE + Math.cos(angle) * (i % 2 === 0 ? 31 : 29);
    const y2 = CENTRE + Math.sin(angle) * (i % 2 === 0 ? 31 : 29);
    rays.push(
      `<path d="M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}" stroke="${colour}" stroke-width="1.6" stroke-linecap="round" opacity="0.75"/>`
    );
  }
  return rays.join('');
}

/**
 * An inline SVG for a tier. Returns markup rather than an element so it can be
 * dropped into the innerHTML the rest of the UI is already built from.
 */
export function rankBadgeSvg(rank: Rank, size = 64): string {
  const emblem = EMBLEMS[rank.key] ?? EMBLEMS.bronze;
  const id = `rb${++instance}`;
  const metal = rank.css;

  const rings = Array.from({ length: emblem.rings }, (_, i) => {
    const r = 11 + i * 4.5;
    return `<circle cx="${CENTRE}" cy="${CENTRE}" r="${r}" fill="none" stroke="${metal}" stroke-width="1" opacity="${0.5 - i * 0.1}"/>`;
  }).join('');

  const facets = emblem.facets
    ? `<path d="${hexPath(14)}" fill="none" stroke="${metal}" stroke-width="0.8" opacity="0.28"/>`
    : '';

  return `<svg class="rank-badge" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${rank.name} rank" focusable="false">
  <defs>
    <radialGradient id="${id}core" cx="38%" cy="32%" r="70%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="45%" stop-color="${metal}"/>
      <stop offset="100%" stop-color="${metal}" stop-opacity="0.55"/>
    </radialGradient>
    <linearGradient id="${id}plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#161c24"/>
      <stop offset="100%" stop-color="#0a0d12"/>
    </linearGradient>
  </defs>
  ${emblem.corona ? coronaFor(metal) : ''}
  <path d="${hexPath(25)}" fill="url(#${id}plate)" stroke="${metal}" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="${hexPath(20.5)}" fill="none" stroke="${metal}" stroke-width="0.9" opacity="0.35"/>
  ${facets}
  ${rings}
  ${nodesFor(emblem.nodes, 11 + Math.max(0, emblem.rings - 1) * 4.5, metal)}
  <circle cx="${CENTRE}" cy="${CENTRE}" r="6.5" fill="url(#${id}core)"/>
</svg>`;
}

/** Every tier, for a ladder view that shows where you are among all of them. */
export function allRankBadges(size = 44): { rank: Rank; svg: string }[] {
  return RANKS.map((rank) => ({ rank, svg: rankBadgeSvg(rank, size) }));
}
