/**
 * The share card — a 1080×1920 story poster, built as one SVG.
 *
 * Designed like a sports result graphic rather than a screenshot: one huge
 * number, the player's real final board as the picture, three stats, who
 * played, and a single call to action. Everything is vector and system type,
 * so it rasterises to a crisp PNG on the phone (SVG → canvas → blob) with
 * nothing to download.
 */
import { crewSvg } from './crew.ts';
import { rankEmblemSvg, METALS } from './rankEmblem.ts';

export interface ShareCell {
  /** Seat index into `colors`, or -1 for an empty cell. */
  owner: number;
  count: number;
}

export interface ShareCardData {
  /** Small pill at the top right, e.g. "VS INSANE CPU" or "DAILY BLAST #142". */
  tag: string;
  /** Label over the big number. */
  heroLabel: string;
  /** The big number itself, e.g. "×7" — a leading × is drawn in the accent. */
  hero: string;
  headline: string;
  sub: string;
  board: ShareCell[][];
  colors: string[];
  stats: { label: string; value: string }[];
  playerName: string;
  avatarKey: string;
  /** Tier key for the emblem; empty draws none (pass and play, unranked). */
  rankKey: string;
  rankLine: string;
  cta: string;
  url: string;
}

const W = 1080;
const H = 1920;
const M = 96;
const BG = '#07090c';
const CYAN = '#3ad9ff';
const TEXT = '#e8edf4';
const DIM = '#7d8899';
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Consolas, monospace";

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nest = (svg: string, x: number, y: number): string => svg.replace('<svg ', `<svg x="${x}" y="${y}" `);

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

let instance = 0;

function orb(x: number, y: number, r: number, hue: string): string {
  const id = `sc${++instance}`;
  return (
    `<clipPath id="${id}"><circle cx="${x}" cy="${y}" r="${r}"/></clipPath>` +
    `<circle cx="${x}" cy="${y}" r="${r}" fill="${mix(hue, '#000000', 0.32)}"/>` +
    `<circle cx="${x - r * 0.14}" cy="${y - r * 0.16}" r="${r}" fill="${hue}" clip-path="url(#${id})"/>` +
    `<ellipse cx="${x - r * 0.38}" cy="${y - r * 0.42}" rx="${r * 0.24}" ry="${r * 0.15}" fill="${mix(hue, '#ffffff', 0.7)}" transform="rotate(-38 ${x - r * 0.38} ${y - r * 0.42})"/>`
  );
}

/** The brand mark — the app icon's geometry, at any size. */
function mark(x: number, y: number, s: number): string {
  const k = s / 64;
  const p = (n: number): number => n * k;
  return (
    `<g transform="translate(${x} ${y})">` +
    `<rect width="${p(64)}" height="${p(64)}" rx="${p(14)}" fill="#0b0e13" stroke="#232b36" stroke-width="${p(1.5)}"/>` +
    `<circle cx="${p(32)}" cy="${p(32)}" r="${p(19)}" fill="none" stroke="${CYAN}" stroke-width="${p(1)}" opacity="0.3"/>` +
    `<g stroke="${CYAN}" stroke-width="${p(2)}" stroke-linecap="round" opacity="0.6"><path d="M${p(32)} ${p(23)}V${p(15)}M${p(32)} ${p(41)}V${p(49)}M${p(23)} ${p(32)}H${p(15)}M${p(41)} ${p(32)}H${p(49)}"/></g>` +
    `<g fill="${CYAN}"><circle cx="${p(32)}" cy="${p(12)}" r="${p(3.4)}"/><circle cx="${p(32)}" cy="${p(52)}" r="${p(3.4)}"/><circle cx="${p(12)}" cy="${p(32)}" r="${p(3.4)}"/><circle cx="${p(52)}" cy="${p(32)}" r="${p(3.4)}"/></g>` +
    orb(p(32), p(32), p(10), CYAN) +
    `</g>`
  );
}

/** The real final board, landscape so it fits the poster's width. */
function board(cells: ShareCell[][], colors: string[], x: number, y: number, w: number, h: number): string {
  let grid = cells;
  if (grid.length > (grid[0]?.length ?? 0)) grid = grid[0].map((_, c) => grid.map((row) => row[c]));
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (!rows || !cols) return '';
  const pitch = Math.min(w / cols, h / rows);
  const gap = pitch * 0.1;
  const size = pitch - gap;
  const ox = x + (w - pitch * cols + gap) / 2;
  const oy = y + (h - pitch * rows + gap) / 2;
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid[r][c];
      const px = ox + c * pitch;
      const py = oy + r * pitch;
      const hue = cell.owner >= 0 ? colors[cell.owner % colors.length] : null;
      out.push(`<rect x="${px}" y="${py}" width="${size}" height="${size}" rx="${size * 0.2}" fill="${hue ? mix(hue, '#0b0e13', 0.8) : '#121820'}"/>`);
      if (!hue || cell.count <= 0) continue;
      const mx = px + size / 2;
      const my = py + size / 2;
      const r1 = size * 0.2;
      if (cell.count === 1) out.push(orb(mx, my, r1 * 1.1, hue));
      else if (cell.count === 2) out.push(orb(mx - r1 * 0.75, my, r1, hue), orb(mx + r1 * 0.75, my, r1, hue));
      else out.push(orb(mx, my - r1 * 0.7, r1, hue), orb(mx - r1 * 0.8, my + r1 * 0.55, r1, hue), orb(mx + r1 * 0.8, my + r1 * 0.55, r1, hue));
    }
  }
  return out.join('');
}

export function shareCardSvg(d: ShareCardData): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<defs><pattern id="g" width="60" height="60" patternUnits="userSpaceOnUse"><path d="M60 0H0V60" fill="none" stroke="#ffffff" stroke-opacity="0.035" stroke-width="2"/></pattern></defs>`,
    `<rect width="${W}" height="${H}" fill="${BG}"/><rect width="${W}" height="${H}" fill="url(#g)"/>`
  );

  // Brand device: the mark's rings and neighbours, enormous and cropped.
  const bx = 960;
  const by = 470;
  parts.push(
    `<g fill="none" stroke="${CYAN}"><circle cx="${bx}" cy="${by}" r="250" stroke-opacity="0.12" stroke-width="3"/><circle cx="${bx}" cy="${by}" r="400" stroke-opacity="0.06" stroke-width="2"/></g>`,
    `<g stroke="${CYAN}" stroke-opacity="0.14" stroke-width="6" stroke-linecap="round"><path d="M${bx - 120} ${by}H${bx - 330}"/><path d="M${bx} ${by + 120}V${by + 330}"/></g>`,
    `<g fill="${CYAN}" fill-opacity="0.16"><circle cx="${bx - 400}" cy="${by}" r="26"/><circle cx="${bx}" cy="${by + 400}" r="26"/></g>`,
    `<circle cx="${bx}" cy="${by}" r="96" fill="${CYAN}" fill-opacity="0.07"/>`
  );

  // Header.
  parts.push(mark(M, 104, 76));
  parts.push(`<text x="${M + 104}" y="157" font-family="${SANS}" font-size="44" font-weight="600" letter-spacing="14" fill="${TEXT}">FISSILE</text>`);
  const tagW = d.tag.length * 17.5 + 56;
  parts.push(
    `<rect x="${W - M - tagW}" y="114" width="${tagW}" height="56" rx="28" fill="${CYAN}" fill-opacity="0.1" stroke="${CYAN}" stroke-opacity="0.45" stroke-width="2"/>`,
    `<text x="${W - M - tagW / 2}" y="151" text-anchor="middle" font-family="${MONO}" font-size="26" font-weight="600" letter-spacing="2" fill="${CYAN}">${esc(d.tag)}</text>`
  );

  // Hero number.
  parts.push(`<text x="${M}" y="320" font-family="${MONO}" font-size="28" font-weight="600" letter-spacing="7" fill="${DIM}">${esc(d.heroLabel)}</text>`);
  const hero = d.hero.startsWith('×')
    ? `<tspan fill="${CYAN}" font-size="190" font-weight="700">×</tspan><tspan dx="6">${esc(d.hero.slice(1))}</tspan>`
    : esc(d.hero);
  parts.push(`<text x="${M - 12}" y="590" font-family="${SANS}" font-size="330" font-weight="800" letter-spacing="-6" fill="#ffffff">${hero}</text>`);
  parts.push(`<text x="${M}" y="690" font-family="${SANS}" font-size="54" font-weight="700" fill="#ffffff">${esc(d.headline)}</text>`);
  parts.push(`<text x="${M}" y="752" font-family="${SANS}" font-size="36" fill="${DIM}">${esc(d.sub)}</text>`);

  // Board.
  const panelY = 812;
  const panelH = 540;
  parts.push(`<rect x="${M}" y="${panelY}" width="${W - 2 * M}" height="${panelH}" rx="40" fill="#0d1116" stroke="#ffffff" stroke-opacity="0.07" stroke-width="2"/>`);
  parts.push(board(d.board, d.colors, M + 36, panelY + 36, W - 2 * M - 72, panelH - 72));

  // Stats.
  const colW = (W - 2 * M) / d.stats.length;
  d.stats.forEach((s, i) => {
    const x = M + colW * i;
    if (i > 0) parts.push(`<path d="M${x} 1408V1504" stroke="#ffffff" stroke-opacity="0.1" stroke-width="2"/>`);
    parts.push(
      `<text x="${x + colW / 2}" y="1462" text-anchor="middle" font-family="${SANS}" font-size="68" font-weight="700" fill="#ffffff">${esc(s.value)}</text>`,
      `<text x="${x + colW / 2}" y="1504" text-anchor="middle" font-family="${MONO}" font-size="24" font-weight="600" letter-spacing="4" fill="${DIM}">${esc(s.label)}</text>`
    );
  });

  // Player.
  const metal = METALS[d.rankKey] ?? METALS.bronze;
  parts.push(`<rect x="${M}" y="1556" width="${W - 2 * M}" height="150" rx="36" fill="#ffffff" fill-opacity="0.04" stroke="#ffffff" stroke-opacity="0.07" stroke-width="2"/>`);
  parts.push(nest(crewSvg(d.avatarKey, 110), M + 22, 1576));
  parts.push(`<text x="${M + 158}" y="1624" font-family="${SANS}" font-size="46" font-weight="700" fill="#ffffff">${esc(d.playerName)}</text>`);
  parts.push(`<text x="${M + 158}" y="1670" font-family="${SANS}" font-size="30" font-weight="600" fill="${d.rankKey ? metal.light : DIM}">${esc(d.rankLine)}</text>`);
  if (d.rankKey) parts.push(nest(rankEmblemSvg(d.rankKey, 128), W - M - 150, 1567));

  // Call to action.
  parts.push(`<rect x="${M}" y="1746" width="${W - 2 * M}" height="96" rx="48" fill="${CYAN}"/>`);
  parts.push(`<text x="${W / 2}" y="1808" text-anchor="middle" font-family="${SANS}" font-size="40" font-weight="700" fill="${BG}">${esc(d.cta)}</text>`);
  parts.push(`<text x="${W / 2}" y="1884" text-anchor="middle" font-family="${MONO}" font-size="26" letter-spacing="1" fill="${DIM}">${esc(d.url)}</text>`);

  parts.push('</svg>');
  return parts.join('');
}
