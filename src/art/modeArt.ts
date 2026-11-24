/**
 * Mode key art — one flat vector card per mode, 320×200.
 *
 * Every card is built from the game's own pieces: the cell lattice as the
 * ground, cel-shaded orbs as the actors, and one bold pictogram that says what
 * is different about the mode (the burst, the clock, the broken lattice, the
 * engineered ring, the two sides, the bracket, the closing ring). One accent
 * colour per mode, lattice and orbs drawn the same way on every card, so the
 * seven read as a series.
 */

export const MODE_ACCENTS: Record<string, string> = {
  classic: '#3ad9ff',
  blitz: '#ffb020',
  chaos: '#ff5cc0',
  power: '#ffca7a',
  team: '#3ad9ff',
  tournament: '#e6be5a',
  survival: '#ff3355',
};

const W = 320;
const H = 200;
const PITCH = 30;
const CELL = 25;
const COLS = 11;
const ROWS = 7;
const OX = (W - COLS * PITCH) / 2 + (PITCH - CELL) / 2;
const OY = (H - ROWS * PITCH) / 2 + (PITCH - CELL) / 2;
const RED = '#ff3355';
const CYAN = '#3ad9ff';
const VOID = '#05070a';

type CellFn = (c: number, r: number) => { fill: string; stroke?: string; extra?: string } | null;

const cx = (c: number): number => OX + c * PITCH + CELL / 2;
const cy = (r: number): number => OY + r * PITCH + CELL / 2;

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

function lattice(style?: CellFn, opacity = 1): string {
  const out: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const s = style?.(c, r) ?? { fill: '#131920' };
      const stroke = s.stroke ? ` stroke="${s.stroke}" stroke-width="1.6"` : '';
      out.push(`<rect x="${OX + c * PITCH}" y="${OY + r * PITCH}" width="${CELL}" height="${CELL}" rx="6" fill="${s.fill}"${stroke}/>`);
      if (s.extra) out.push(s.extra);
    }
  }
  return `<g opacity="${opacity}">${out.join('')}</g>`;
}

let instance = 0;

/** A cel-shaded orb: shade tone, lit tone offset up-left, flat glint. */
function orb(x: number, y: number, r: number, hue: string): string {
  const id = `mo${++instance}`;
  return (
    `<clipPath id="${id}"><circle cx="${x}" cy="${y}" r="${r}"/></clipPath>` +
    `<circle cx="${x}" cy="${y}" r="${r}" fill="${mix(hue, '#000000', 0.32)}"/>` +
    `<circle cx="${x - r * 0.14}" cy="${y - r * 0.16}" r="${r}" fill="${hue}" clip-path="url(#${id})"/>` +
    `<ellipse cx="${x - r * 0.38}" cy="${y - r * 0.42}" rx="${r * 0.24}" ry="${r * 0.15}" fill="${mix(hue, '#ffffff', 0.7)}" transform="rotate(-38 ${x - r * 0.38} ${y - r * 0.42})"/>`
  );
}

const ARTS: Record<string, () => string> = {
  classic: () => {
    const near = new Set(['5,3', '4,3', '6,3', '5,2', '5,4']);
    const ground = lattice((c, r) =>
      near.has(`${c},${r}`) ? { fill: mix(CYAN, '#131920', 0.82) } : r === 2 && c === 8 ? { fill: mix(RED, '#131920', 0.85) } : null
    );
    const x = cx(5);
    const y = cy(3);
    const traces = [
      [x, y - 15, x, y - PITCH + 9],
      [x, y + 15, x, y + PITCH - 9],
      [x - 15, y, x - PITCH + 9, y],
      [x + 15, y, x + PITCH - 9, y],
    ]
      .map(([a, b, c, d]) => `<path d="M${a} ${b}L${c} ${d}" stroke="${CYAN}" stroke-width="3" stroke-linecap="round"/>`)
      .join('');
    return (
      ground +
      `<circle cx="${x}" cy="${y}" r="46" fill="none" stroke="${CYAN}" stroke-width="1.5" opacity="0.35"/>` +
      `<circle cx="${x}" cy="${y}" r="62" fill="none" stroke="${CYAN}" stroke-width="1" opacity="0.15"/>` +
      traces +
      orb(cx(5), cy(2), 8, CYAN) + orb(cx(5), cy(4), 8, CYAN) + orb(cx(4), cy(3), 8, CYAN) + orb(cx(6), cy(3), 8, CYAN) +
      orb(x - 4.5, y + 3, 7, CYAN) + orb(x + 4.5, y + 3, 7, CYAN) + orb(x, y - 4.5, 7, CYAN) +
      orb(cx(8), cy(2), 8, RED) + orb(cx(2), cy(5), 8, RED) + orb(cx(1), cy(1), 8, CYAN)
    );
  },

  blitz: () => {
    const A = MODE_ACCENTS.blitz;
    const x = 168;
    const y = 104;
    const r = 52;
    const a1 = (-90 * Math.PI) / 180;
    const a2 = (180 * Math.PI) / 180;
    const arc = `M${x + Math.cos(a1) * r} ${y + Math.sin(a1) * r}A${r} ${r} 0 1 1 ${x + Math.cos(a2) * r} ${y + Math.sin(a2) * r}`;
    return (
      lattice(undefined, 0.7) +
      `<g stroke="${A}" stroke-width="5" stroke-linecap="round"><path d="M40 84H92" opacity="0.9"/><path d="M58 104H104" opacity="0.6"/><path d="M34 124H96" opacity="0.35"/></g>` +
      `<circle cx="${x}" cy="${y}" r="${r + 10}" fill="#0b0e13"/>` +
      `<rect x="${x - 9}" y="${y - r - 24}" width="18" height="12" rx="3" fill="${A}"/>` +
      `<rect x="${x - 3}" y="${y - r - 14}" width="6" height="8" fill="${A}"/>` +
      `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#1e252f" stroke-width="10"/>` +
      `<path d="${arc}" fill="none" stroke="${A}" stroke-width="10" stroke-linecap="round"/>` +
      `<path d="M${x + 6} ${y - 34}L${x - 18} ${y + 4}H${x - 2}L${x - 8} ${y + 34}L${x + 18} ${y - 6}H${x + 2}L${x + 10} ${y - 34}Z" fill="${A}"/>`
    );
  },

  chaos: () => {
    const A = MODE_ACCENTS.chaos;
    // Point-symmetric scatter, the way the real generator places specials.
    const voids = new Set(['2,1', '8,5', '4,4', '6,2', '1,5', '9,1', '0,3', '10,3']);
    const cats = new Set(['3,2', '7,4', '5,0', '5,6']);
    const damps = new Set(['1,2', '9,4', '7,1', '3,5']);
    const ground = lattice((c, r) => {
      const k = `${c},${r}`;
      if (voids.has(k)) return { fill: VOID };
      if (cats.has(k)) return { fill: mix('#ffca7a', '#131920', 0.86), stroke: '#ffca7a' };
      if (damps.has(k)) return { fill: mix('#5f708a', '#131920', 0.7), stroke: '#5f708a' };
      return null;
    });
    return (
      `<g transform="rotate(-9 160 100) translate(0 2)">${ground}` +
      orb(cx(3), cy(2), 8, A) + orb(cx(7), cy(4), 8, CYAN) + orb(cx(5), cy(3), 9, A) +
      orb(cx(8), cy(2), 8, RED) + orb(cx(2), cy(4), 8, CYAN) + orb(cx(6), cy(5), 8, A) +
      `</g>`
    );
  },

  power: () => {
    const A = MODE_ACCENTS.power;
    const ring = new Set(['4,2', '5,2', '6,2', '4,3', '6,3', '4,4', '5,4', '6,4']);
    const corners = new Set(['2,1', '8,1', '2,5', '8,5']);
    const ground = lattice((c, r) => {
      const k = `${c},${r}`;
      if (ring.has(k)) return { fill: mix(A, '#131920', 0.86), stroke: A };
      if (corners.has(k)) return { fill: mix('#5f708a', '#131920', 0.7), stroke: '#5f708a' };
      return null;
    });
    const x = cx(5);
    const y = cy(3);
    const sx = x + 11;
    const sy = y - 11;
    const star = `M${sx} ${sy - 13}Q${sx + 2} ${sy - 2} ${sx + 13} ${sy}Q${sx + 2} ${sy + 2} ${sx} ${sy + 13}Q${sx - 2} ${sy + 2} ${sx - 13} ${sy}Q${sx - 2} ${sy - 2} ${sx} ${sy - 13}Z`;
    return (
      ground +
      `<circle cx="${x}" cy="${y}" r="58" fill="none" stroke="${A}" stroke-width="1.2" opacity="0.3" stroke-dasharray="3 5"/>` +
      orb(x, y, 15, A) +
      `<path d="${star}" fill="#fff6e0"/>` +
      orb(cx(2), cy(1), 7, CYAN) + orb(cx(8), cy(5), 7, RED)
    );
  },

  team: () => {
    const tintL = mix(CYAN, '#0b0e13', 0.9);
    const tintR = mix(RED, '#0b0e13', 0.9);
    const left = `M0 0H190L130 200H0Z`;
    const right = `M190 0H320V200H130Z`;
    return (
      `<path d="${left}" fill="${tintL}"/><path d="${right}" fill="${tintR}"/>` +
      lattice(undefined, 0.55) +
      `<path d="M190 0L130 200" stroke="#ffffff" stroke-width="2" opacity="0.25"/>` +
      `<path d="M${cx(1)} ${cy(2)}L${cx(3)} ${cy(4)}" stroke="${CYAN}" stroke-width="3" stroke-dasharray="2 6" stroke-linecap="round"/>` +
      `<path d="M${cx(7)} ${cy(2)}L${cx(9)} ${cy(4)}" stroke="${RED}" stroke-width="3" stroke-dasharray="2 6" stroke-linecap="round"/>` +
      orb(cx(1), cy(2), 15, CYAN) + orb(cx(3), cy(4), 15, CYAN) +
      orb(cx(7), cy(2), 15, RED) + orb(cx(9), cy(4), 15, RED) +
      `<path d="M160 86L171 100L160 114L149 100Z" fill="#e8edf4"/>`
    );
  },

  tournament: () => {
    const A = MODE_ACCENTS.tournament;
    const line = '#2b3542';
    const seeds = [42, 78, 122, 158];
    const xs = [70, 150, 232];
    const semis = [60, 140];
    const parts: string[] = [];
    seeds.forEach((y, i) => {
      const s = semis[Math.floor(i / 2)];
      const win = i === 1 || i === 2;
      parts.push(`<path d="M${xs[0]} ${y}H${xs[0] + 40}V${s}H${xs[1]}" fill="none" stroke="${win ? A : line}" stroke-width="3" stroke-linejoin="round"/>`);
    });
    semis.forEach((y, i) => {
      parts.push(`<path d="M${xs[1]} ${y}H${xs[1] + 42}V100H${xs[2]}" fill="none" stroke="${i === 0 ? A : line}" stroke-width="3" stroke-linejoin="round"/>`);
    });
    const hues = [RED, CYAN, A, '#a878ff'];
    seeds.forEach((y, i) => parts.push(orb(xs[0], y, 9, hues[i])));
    parts.push(orb(xs[1], semis[0], 10, CYAN), orb(xs[1], semis[1], 10, A));
    parts.push(`<circle cx="${xs[2]}" cy="100" r="27" fill="none" stroke="${A}" stroke-width="2"/>`);
    parts.push(orb(xs[2], 100, 18, CYAN));
    const pips = [0, 1, 2, 3, 4]
      .map((i) => `<circle cx="${xs[2] - 24 + i * 12}" cy="146" r="4" fill="${i < 3 ? A : '#2b3542'}"/>`)
      .join('');
    return lattice(undefined, 0.35) + parts.join('') + pips;
  },

  survival: () => {
    const ground = lattice((c, r) => {
      const ring = Math.max(Math.abs(c - 5), Math.abs(r - 3));
      if (ring >= 4 || (ring === 3 && (c + r) % 2 === 0)) {
        return { fill: VOID, stroke: '#141a22' };
      }
      return null;
    });
    const x = cx(5);
    const y = cy(3);
    return (
      ground +
      `<circle cx="${x}" cy="${y}" r="70" fill="none" stroke="${RED}" stroke-width="2" opacity="0.5" stroke-dasharray="6 6"/>` +
      `<circle cx="${x}" cy="${y}" r="24" fill="none" stroke="${CYAN}" stroke-width="2" opacity="0.6"/>` +
      orb(x, y, 13, CYAN) +
      orb(cx(3), cy(1), 9, RED) + orb(cx(8), cy(2), 9, RED) + orb(cx(7), cy(5), 9, RED) + orb(cx(2), cy(4), 9, RED)
    );
  },
};

/** Close-up crops, about the centre cell, for cards whose hero is small. */
const ZOOM: Record<string, number> = { classic: 1.5, power: 1.3 };

export function modeArtSvg(key: string, width = W): string {
  const art = ARTS[key] ?? ARTS.classic;
  const zoom = ZOOM[key] ?? 1;
  const id = `ma${++instance}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${width}" height="${(width * H) / W}" role="img" aria-label="${key} mode">`,
    `<defs><clipPath id="${id}"><rect width="${W}" height="${H}" rx="18"/></clipPath></defs>`,
    `<g clip-path="url(#${id})"><rect width="${W}" height="${H}" fill="#0b0e13"/>`,
    zoom === 1 ? art() : `<g transform="translate(${W / 2} ${H / 2}) scale(${zoom}) translate(${-W / 2} ${-H / 2})">${art()}</g>`,
    `</g>`,
    `<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="17.5" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1.5"/>`,
    '</svg>',
  ].join('');
}

export const MODE_ART_KEYS = ['classic', 'blitz', 'chaos', 'power', 'team', 'tournament', 'survival'];
