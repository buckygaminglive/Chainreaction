/**
 * Rank emblems, v2 — flat, faceted, built on a 128-unit grid.
 *
 * Construction (every tier shares it, so the set reads as one family):
 *   - a pointy-top hex plate — the game's own cell — cut like a gem: six bevel
 *     facets lit from the upper left, around a dark inset table;
 *   - a charged core on the table, cel-shaded in two flat tones;
 *   - escalation by silhouette, not by decoration: blades fan out of the
 *     plate (one, two, three a side), then a crest, a keel, a crown, and for
 *     Master a burst behind everything.
 *
 * No gradients and no glow: tone steps do all the shading, which keeps the
 * emblem crisp at 24 px and print-sharp at 512.
 */

export interface MetalTones {
  hi: string;
  light: string;
  mid: string;
  dark: string;
  deep: string;
  /** Core colour on the table. */
  core: string;
  coreShade: string;
}

export const METALS: Record<string, MetalTones> = {
  unranked: { hi: '#c9d2dd', light: '#9aa6b5', mid: '#717d8c', dark: '#4b5462', deep: '#2f3640', core: '#5d6877', coreShade: '#454e5b' },
  bronze: { hi: '#f2c39a', light: '#d99a66', mid: '#b0784c', dark: '#7f4f2c', deep: '#55331b', core: '#f2c39a', coreShade: '#c98552' },
  silver: { hi: '#f4f8fc', light: '#cdd7e2', mid: '#9fadbd', dark: '#6b7a8c', deep: '#465363', core: '#f4f8fc', coreShade: '#aebccb' },
  gold: { hi: '#fff0b3', light: '#f5cf62', mid: '#d9a93a', dark: '#a17622', deep: '#6e4f14', core: '#fff0b3', coreShade: '#e6b847' },
  platinum: { hi: '#dcfffa', light: '#a6e8df', mid: '#6fc7bc', dark: '#3e9086', deep: '#26615a', core: '#dcfffa', coreShade: '#86d6cb' },
  diamond: { hi: '#e6f5ff', light: '#a9dbff', mid: '#62b4f5', dark: '#2f7cc9', deep: '#1b4f8a', core: '#e6f5ff', coreShade: '#7cc2fa' },
  master: { hi: '#f1e8ff', light: '#c9abff', mid: '#a07af5', dark: '#6b45c2', deep: '#40268a', core: '#bff4ff', coreShade: '#3ad9ff' },
};

interface Build {
  blades: number;
  crest: 0 | 1 | 3;
  keel: boolean;
  burst: boolean;
}

const BUILDS: Record<string, Build> = {
  unranked: { blades: 0, crest: 0, keel: false, burst: false },
  bronze: { blades: 0, crest: 0, keel: false, burst: false },
  silver: { blades: 1, crest: 0, keel: false, burst: false },
  gold: { blades: 2, crest: 1, keel: false, burst: false },
  platinum: { blades: 2, crest: 1, keel: true, burst: false },
  diamond: { blades: 3, crest: 3, keel: true, burst: false },
  master: { blades: 3, crest: 3, keel: true, burst: true },
};

const CX = 64;
const CY = 64;
const PLATE = 31;
const TABLE = 20;
const TABLE_INK = '#0e131a';

const f = (n: number): string => (Math.round(n * 100) / 100).toString();
const poly = (pts: [number, number][], fill: string): string =>
  `<path d="M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z" fill="${fill}"/>`;

function hexPoint(radius: number, i: number): [number, number] {
  const a = ((-90 + i * 60) * Math.PI) / 180;
  return [CX + Math.cos(a) * radius, CY + Math.sin(a) * radius];
}

/** Six bevel facets, toned by how squarely each faces a light at upper left. */
function plate(m: MetalTones): string {
  const out: string[] = [];
  for (let i = 0; i < 6; i++) {
    const mid = -60 + i * 60;
    const lit = Math.cos(((mid + 120) * Math.PI) / 180);
    const tone = lit > 0.9 ? m.hi : lit > 0.2 ? m.light : lit > -0.9 ? m.dark : m.deep;
    out.push(poly([hexPoint(PLATE, i), hexPoint(PLATE, i + 1), hexPoint(TABLE, i + 1), hexPoint(TABLE, i)], tone));
  }
  const table = Array.from({ length: 6 }, (_, i) => hexPoint(TABLE, i));
  out.push(poly(table, TABLE_INK));
  // Hairline on the table edge: the cut between bevel and table.
  out.push(
    `<path d="M${table.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z" fill="none" stroke="${m.mid}" stroke-width="1.4" stroke-linejoin="round" opacity="0.9"/>`
  );
  return out.join('');
}

/** The charged core: two flat tones and a glint, no gradient. */
function core(m: MetalTones, uid: string): string {
  const r = 8.5;
  return [
    `<clipPath id="${uid}c"><circle cx="${CX}" cy="${CY}" r="${r}"/></clipPath>`,
    `<circle cx="${CX}" cy="${CY}" r="${r}" fill="${m.coreShade}"/>`,
    `<circle cx="${f(CX - 2.4)}" cy="${f(CY - 2.4)}" r="${r}" fill="${m.core}" clip-path="url(#${uid}c)"/>`,
    `<circle cx="${f(CX - 3.4)}" cy="${f(CY - 3.6)}" r="2.1" fill="#ffffff"/>`,
  ].join('');
}

type Pt = [number, number];
const COS30 = Math.cos(Math.PI / 6);

/** One wing stripe: a band running out of the plate at the hex's own 30°
 *  angle, vertical where it tucks under the plate and pointed at the far end.
 *  Split along its centre line into a lit upper half and a shaded lower half.
 *  `side` is -1 for the left wing, 1 for the right. */
function stripe(m: MetalTones, k: number, side: -1 | 1): string {
  const h = 9;
  const length = [20, 28, 35][k];
  const x0 = CX + side * 22;
  const y0 = CY + 15 - k * 12;
  const d: Pt = [side * COS30, -0.5];
  const p1: Pt = [x0, y0];
  const p2: Pt = [x0 + d[0] * length, y0 + d[1] * length];
  const p3: Pt = [p2[0], p2[1] - h];
  const p4: Pt = [x0, y0 - h];
  const tip: Pt = [p2[0] + d[0] * 8, p2[1] - h / 2 + d[1] * 8];
  const m1: Pt = [x0, y0 - h / 2];
  const m2: Pt = [p2[0], p2[1] - h / 2];
  const lit = side === -1 ? m.light : m.mid;
  const shade = side === -1 ? m.dark : m.deep;
  return poly([m1, p4, p3, tip, m2], lit) + poly([m1, m2, tip, p2, p1], shade);
}

/** A spike with 60° flanks — the hex's other angle — lit on the left. */
function spike(m: MetalTones, x: number, baseY: number, tipY: number): string {
  const half = Math.abs(baseY - tipY) / Math.tan(Math.PI / 3);
  const tip: Pt = [x, tipY];
  const base: Pt = [x, baseY];
  return poly([[x - half, baseY], tip, base], m.light) + poly([base, tip, [x + half, baseY]], m.dark);
}

function crest(m: MetalTones, points: 0 | 1 | 3): string {
  if (points === 0) return '';
  const top = CY - PLATE;
  const centre = spike(m, CX, top + 8, top - 20);
  if (points === 1) return centre;
  return spike(m, CX - 16, top + 14, top - 8) + spike(m, CX + 16, top + 14, top - 8) + centre;
}

function keel(m: MetalTones): string {
  const bottom = CY + PLATE;
  return spike(m, CX, bottom - 8, bottom + 18);
}

/** Master only: a larger cell set behind everything, turned 30° so its flat
 *  top sits under the crown — a solid backplate with a lit rim. */
function halo(m: MetalTones): string {
  const at = (r: number, i: number): Pt => {
    const a = ((i * 60) * Math.PI) / 180;
    return [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
  };
  const outer = Array.from({ length: 6 }, (_, i) => at(52, i));
  const rim = Array.from({ length: 6 }, (_, i) => at(47, i));
  const out: string[] = [];
  for (let i = 0; i < 6; i++) {
    const mid = 30 + i * 60;
    const lit = Math.cos(((mid + 120) * Math.PI) / 180);
    const tone = lit > 0.5 ? m.mid : lit > -0.5 ? m.dark : m.deep;
    out.push(poly([outer[i], outer[(i + 1) % 6], rim[(i + 1) % 6], rim[i]], tone));
  }
  out.push(poly(rim, '#1a1330'));
  return out.join('');
}

let instance = 0;

export function rankEmblemSvg(key: string, size = 128): string {
  const m = METALS[key] ?? METALS.bronze;
  const b = BUILDS[key] ?? BUILDS.bronze;
  const uid = `re${++instance}`;
  const blades: string[] = [];
  for (let k = b.blades - 1; k >= 0; k--) blades.push(stripe(m, k, -1), stripe(m, k, 1));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}" role="img" aria-label="${key} rank">`,
    b.burst ? halo(m) : '',
    blades.join(''),
    crest(m, b.crest),
    b.keel ? keel(m) : '',
    plate(m),
    core(m, uid),
    '</svg>',
  ].join('');
}

export const RANK_KEYS = ['unranked', 'bronze', 'silver', 'gold', 'platinum', 'diamond', 'master'];
