/**
 * Generates the raster brand assets that a web page and an app store need and
 * an SVG cannot provide: PWA install icons, a maskable icon, and the Open
 * Graph share card.
 *
 *   node scripts/make-icons.mjs
 *
 * Everything is drawn here rather than exported from a design tool, for the
 * same reason the game synthesises its own sound: there is then exactly one
 * definition of the mark, in text, that regenerates identically. The geometry
 * is `public/favicon.svg` — if that changes, change it here too.
 *
 * No dependencies. Shapes are signed distance fields composited straight into
 * an RGBA buffer, and the PNG is written with the zlib that ships with Node.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ---------- palette (mirrors src/style.css and public/favicon.svg) ----------
const INK = [0x0b, 0x0e, 0x13];
const GROUND = [0x07, 0x09, 0x0c];
const EDGE = [0x23, 0x2b, 0x36];
const ACCENT = [0x3a, 0xd9, 0xff];
const CORE_HOT = [0xe8, 0xfb, 0xff];
const CORE_MID = [0x6e, 0xe6, 0xff];
const CORE_COLD = [0x12, 0xa8, 0xd4];
const TEXT = [0xe8, 0xed, 0xf4];
const CELL = [0x16, 0x1b, 0x23];
const RED = [0xff, 0x33, 0x55];

// ---------- surface ----------
function surface(w, h, fill) {
  const data = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    data[i * 3] = fill[0];
    data[i * 3 + 1] = fill[1];
    data[i * 3 + 2] = fill[2];
  }
  return { w, h, data };
}

/** Straight-alpha `over`, one pixel. */
function blend(s, x, y, rgb, alpha) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= s.w || y >= s.h) return;
  const a = Math.min(1, alpha);
  const i = (y * s.w + x) * 3;
  s.data[i] += (rgb[0] - s.data[i]) * a;
  s.data[i + 1] += (rgb[1] - s.data[i + 1]) * a;
  s.data[i + 2] += (rgb[2] - s.data[i + 2]) * a;
}

/** Paints wherever `sdf(x, y)` is negative, antialiased across one pixel.
 *  `shade` may return a colour per pixel (used for the core's gradient). */
function paint(s, sdf, colour, alpha = 1, shade = null) {
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const d = sdf(x + 0.5, y + 0.5);
      if (d > 1) continue;
      const cover = Math.min(1, Math.max(0, 0.5 - d));
      if (cover <= 0) continue;
      blend(s, x, y, shade ? shade(x + 0.5, y + 0.5) : colour, cover * alpha);
    }
  }
}

// ---------- signed distance fields ----------
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;

const ring = (cx, cy, r, width) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - width / 2;

function roundRect(cx, cy, halfW, halfH, radius) {
  return (x, y) => {
    const qx = Math.abs(x - cx) - halfW + radius;
    const qy = Math.abs(y - cy) - halfH + radius;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
  };
}

const rectOutline = (cx, cy, halfW, halfH, radius, width) => {
  const base = roundRect(cx, cy, halfW, halfH, radius);
  return (x, y) => Math.abs(base(x, y)) - width / 2;
};

/** Round-capped stroke through a polyline. */
function stroke(points, width) {
  const half = width / 2;
  return (x, y) => {
    let best = Infinity;
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, ay] = points[i];
      const [bx, by] = points[i + 1];
      const vx = bx - ax;
      const vy = by - ay;
      const len2 = vx * vx + vy * vy || 1;
      const t = Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / len2));
      best = Math.min(best, Math.hypot(x - ax - vx * t, y - ay - vy * t));
    }
    return best - half;
  };
}

/** An elliptical arc as a polyline, for the letterforms. Angles in degrees,
 *  measured clockwise from 3 o'clock in screen space (y down). */
function arc(cx, cy, rx, ry, from, to, steps = 26) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    points.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return points;
}

// ---------- the mark ----------
/** Draws the favicon geometry into `s`, centred on (cx, cy) at `size` px. */
function drawMark(s, cx, cy, size, { plate = true } = {}) {
  const u = size / 64; // favicon.svg works in a 64-unit box
  const at = (vx, vy) => [cx + (vx - 32) * u, cy + (vy - 32) * u];

  if (plate) {
    paint(s, roundRect(cx, cy, 32 * u, 32 * u, 14 * u), INK);
    paint(s, rectOutline(cx, cy, 27.5 * u, 27.5 * u, 11 * u, 1 * u), EDGE);
  }

  paint(s, ring(cx, cy, 19 * u, 1 * u), ACCENT, 0.28);

  // Emission traces out to the four neighbours.
  const traces = [
    [at(32, 23), at(32, 15)],
    [at(32, 41), at(32, 49)],
    [at(23, 32), at(15, 32)],
    [at(41, 32), at(49, 32)],
  ];
  for (const line of traces) paint(s, stroke(line, 2 * u), ACCENT, 0.6);

  for (const [nx, ny] of [at(32, 12), at(32, 52), at(12, 32), at(52, 32)]) {
    paint(s, circle(nx, ny, 3.4 * u), ACCENT);
  }

  // The charged core: a radial gradient lit from the upper left, exactly as
  // the favicon's <radialGradient> specifies.
  const coreR = 10 * u;
  const gx = cx - 32 * u + (22 + 0.38 * 20) * u;
  const gy = cy - 32 * u + (22 + 0.32 * 20) * u;
  const gr = 14 * u;
  paint(s, circle(cx, cy, coreR), null, 1, (x, y) => {
    const t = Math.min(1, Math.hypot(x - gx, y - gy) / gr);
    return t < 0.4 ? mix(CORE_HOT, CORE_MID, t / 0.4) : mix(CORE_MID, CORE_COLD, (t - 0.4) / 0.6);
  });
}

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// ---------- a monoline logotype ----------
/** Seven letters is the whole alphabet this needs, so they are drawn rather
 *  than set: a geometric monoline matches §18's "modern technical sans-serif,
 *  precise spacing, minimal decoration" better than any face that happens to
 *  be installed on the machine running this script — and it renders the same
 *  everywhere, which a system font would not. */
function glyph(letter, x, y, w, h) {
  const r = Math.min(w, h) / 2;
  switch (letter) {
    case 'R':
      return [
        [[x, y + h], [x, y]],
        [
          ...[[x, y]],
          ...arc(x + w * 0.42, y + h * 0.26, w * 0.58, h * 0.26, -90, 90, 18),
          [x, y + h * 0.52],
        ],
        [[x + w * 0.42, y + h * 0.52], [x + w, y + h]],
      ];
    case 'E':
      return [
        [[x, y], [x, y + h]],
        [[x, y], [x + w, y]],
        [[x, y + h / 2], [x + w * 0.82, y + h / 2]],
        [[x, y + h], [x + w, y + h]],
      ];
    case 'A':
      return [
        [[x, y + h], [x + w / 2, y]],
        [[x + w / 2, y], [x + w, y + h]],
        [[x + w * 0.19, y + h * 0.64], [x + w * 0.81, y + h * 0.64]],
      ];
    case 'C':
      return [arc(x + w / 2, y + h / 2, w / 2, h / 2, -48, -312, 34)];
    case 'T':
      return [
        [[x, y], [x + w, y]],
        [[x + w / 2, y], [x + w / 2, y + h]],
      ];
    case 'O':
      return [arc(x + w / 2, y + h / 2, w / 2, h / 2, 0, 360, 44)];
    case 'N':
      return [
        [[x, y + h], [x, y]],
        [[x, y], [x + w, y + h]],
        [[x + w, y + h], [x + w, y]],
      ];
    case 'F':
      return [
        [[x, y], [x, y + h]],
        [[x, y], [x + w, y]],
        [[x, y + h / 2], [x + w * 0.82, y + h / 2]],
      ];
    case 'I':
      // A bare stem, centred in its advance width. No serifs or crossbars:
      // this is a monoline geometric face, and an I with arms would be the
      // only letter in the word pretending to be something else.
      return [[[x + w / 2, y], [x + w / 2, y + h]]];
    case 'L':
      return [
        [[x, y], [x, y + h]],
        [[x, y + h], [x + w, y + h]],
      ];
    case 'S':
      // Two three-quarter bowls, the lower one mirrored. Drawn as arcs rather
      // than a spline so it stays in the same vocabulary as C and O.
      // The bowls are mirrored through the letter's centre, not copies of each
      // other: two bowls curving the same way stack into a C over a U. The
      // upper one ends at its own bottom and the lower one starts at its own
      // top, which is the same point, so the stroke reads as continuous.
      return [
        arc(x + w / 2, y + h * 0.26, w / 2, h * 0.26, -45, -270, 34),
        arc(x + w / 2, y + h * 0.74, w / 2, h * 0.26, -90, 135, 34),
      ];
    default:
      return [[[x, y], [x + r, y]]];
  }
}

function drawWordmark(s, text, x, y, capHeight, weight, tracking, colour, alpha = 1) {
  const w = capHeight * 0.74;
  let cursor = x;
  for (const letter of text) {
    for (const path of glyph(letter, cursor, y, w, capHeight)) {
      paint(s, stroke(path, weight), colour, alpha);
    }
    cursor += w + tracking;
  }
  return cursor - tracking;
}

const wordmarkWidth = (text, capHeight, tracking) =>
  text.length * capHeight * 0.74 + (text.length - 1) * tracking;

// ---------- board motif ----------
/**
 * A fragment of the real lattice: cells, a cell going critical, and the four
 * particles it fires. Showing the mechanic rather than decorating around it —
 * a store listing is the one place a player decides whether they understand
 * the game, and a grid mid-cascade explains it faster than any strapline.
 */
function drawBoard(s, originX, originY, cols, rows, cell, gap, alpha) {
  const at = (col, row) => [originX + col * (cell + gap), originY + row * (cell + gap)];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const [x, y] = at(col, row);
      paint(s, roundRect(x + cell / 2, y + cell / 2, cell / 2, cell / 2, cell * 0.2), CELL, alpha);
    }
  }

  // The cell about to go, dead centre of the fragment, and its four targets.
  const midC = Math.floor(cols / 2);
  const midR = Math.floor(rows / 2);
  const [cx, cy] = at(midC, midR);
  const centre = [cx + cell / 2, cy + cell / 2];

  const targets = [
    [midC, midR - 1],
    [midC, midR + 1],
    [midC - 1, midR],
    [midC + 1, midR],
  ].filter(([col, row]) => col >= 0 && col < cols && row >= 0 && row < rows);

  // Emission traces, drawn under the orbs so they read as coming from beneath.
  for (const [col, row] of targets) {
    const [tx, ty] = at(col, row);
    paint(
      s,
      stroke([centre, [tx + cell / 2, ty + cell / 2]], 2),
      ACCENT,
      alpha * 2.6
    );
  }

  // A couple of held cells either side, so the board reads as contested.
  const held = [
    [0, 0, ACCENT],
    [cols - 1, 0, RED],
    [0, rows - 1, RED],
    [cols - 1, rows - 1, ACCENT],
  ];
  for (const [col, row, colour] of held) {
    if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
    const [x, y] = at(col, row);
    paint(s, circle(x + cell / 2, y + cell / 2, cell * 0.2), colour, alpha * 3.2);
  }

  for (const [col, row] of targets) {
    const [x, y] = at(col, row);
    paint(s, circle(x + cell / 2, y + cell / 2, cell * 0.17), ACCENT, alpha * 3.6);
  }

  // The critical cell itself, brightest thing in the fragment.
  paint(s, circle(centre[0], centre[1], cell * 0.26), null, 1, (x, y) => {
    const t = Math.min(1, Math.hypot(x - centre[0] + cell * 0.06, y - centre[1] + cell * 0.06) / (cell * 0.36));
    return t < 0.4 ? mix(CORE_HOT, CORE_MID, t / 0.4) : mix(CORE_MID, CORE_COLD, (t - 0.4) / 0.6);
  });
}

// ---------- PNG ----------
function writePng(path, s) {
  const { w, h, data } = s;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[p++] = clamp255(data[i]);
      raw[p++] = clamp255(data[i + 1]);
      raw[p++] = clamp255(data[i + 2]);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
  console.log(`${path.split(/[\\/]/).pop().padEnd(24)} ${w}×${h}  ${(png.length / 1024).toFixed(1)} kB`);
}

const clamp255 = (v) => Math.min(255, Math.max(0, Math.round(v)));

function chunk(type, body) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0, 0);
  return Buffer.concat([head, typed, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

// ---------- outputs ----------
mkdirSync(OUT, { recursive: true });

for (const size of [192, 512]) {
  const s = surface(size, size, INK);
  drawMark(s, size / 2, size / 2, size);
  writePng(join(OUT, `icon-${size}.png`), s);
}

// Maskable: the launcher crops to a circle inscribed in the middle 80%, so the
// plate goes full-bleed and the mark shrinks into the safe zone.
{
  const size = 512;
  const s = surface(size, size, INK);
  drawMark(s, size / 2, size / 2, size * 0.62, { plate: false });
  writePng(join(OUT, 'icon-maskable-512.png'), s);
}

// Open Graph card. 1200×630 is what every unfurl expects; SVG is what none of
// them accept, which is why this file exists.
{
  const w = 1200;
  const h = 630;
  const s = surface(w, h, GROUND);

  // The lab bench, one step brighter than in the app so it survives the
  // compression every social platform puts a share image through.
  for (let x = 0; x < w; x += 34) paint(s, stroke([[x, 0], [x, h]], 1), [255, 255, 255], 0.028);
  for (let y = 0; y < h; y += 34) paint(s, stroke([[0, y], [w, y]], 1), [255, 255, 255], 0.028);

  // Emission glow behind the mark.
  const glowX = 300;
  const glowY = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = Math.hypot(x - glowX, y - glowY) / 420;
      if (t < 1) blend(s, x, y, ACCENT, (1 - t) ** 3 * 0.16);
    }
  }

  drawMark(s, glowX, glowY, 260, { plate: false });

  // Sized to leave a wide margin on the right: every platform crops a share
  // card differently, and the last letter is the one that goes.
  const cap = 72;
  const tracking = 26;
  const textX = 552;
  const width = wordmarkWidth('FISSILE', cap, tracking);
  drawWordmark(s, 'FISSILE', textX, glowY - cap / 2 - 22, cap, 4.2, tracking, TEXT);

  // Rule and strapline, kept to shapes: dots, not letters.
  paint(s, stroke([[textX, glowY + cap / 2 + 18], [textX + width, glowY + cap / 2 + 18]], 1.5), ACCENT, 0.35);
  const dotY = glowY + cap / 2 + 52;
  for (let i = 0; i < 3; i++) {
    const bx = textX + i * 46;
    paint(s, circle(bx, dotY, 5), ACCENT, 0.85 - i * 0.2);
    if (i < 2) paint(s, stroke([[bx + 9, dotY], [bx + 37, dotY]], 1.5), ACCENT, 0.3);
  }

  writePng(join(OUT, 'og-card.png'), s);
}

// Play Store feature graphic. 1024x500, and cropped differently on every
// surface it appears on, so nothing that matters goes near an edge.
{
  const w = 1024;
  const h = 500;
  const s = surface(w, h, GROUND);

  for (let x = 0; x < w; x += 34) paint(s, stroke([[x, 0], [x, h]], 1), [255, 255, 255], 0.03);
  for (let y = 0; y < h; y += 34) paint(s, stroke([[0, y], [w, y]], 1), [255, 255, 255], 0.03);

  // The lattice sits in the right quarter, clear of the wordmark. It is
  // ground, not subject: overlapping the type would cost the one word that
  // has to survive being scaled down to a thumbnail.
  drawBoard(s, 776, 132, 3, 4, 52, 9, 0.13);

  const glowX = 190;
  const glowY = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = Math.hypot(x - glowX, y - glowY) / 400;
      if (t < 1) blend(s, x, y, ACCENT, (1 - t) ** 3 * 0.15);
    }
  }

  drawMark(s, glowX, glowY, 180, { plate: false });

  const cap = 56;
  const tracking = 20;
  const textX = 320;
  const width = wordmarkWidth('FISSILE', cap, tracking);
  drawWordmark(s, 'FISSILE', textX, glowY - cap / 2 - 20, cap, 3.6, tracking, TEXT);

  paint(s, stroke([[textX, glowY + cap / 2 + 14], [textX + width, glowY + cap / 2 + 14]], 1.5), ACCENT, 0.35);
  const dotY = glowY + cap / 2 + 44;
  for (let i = 0; i < 3; i++) {
    const bx = textX + i * 42;
    paint(s, circle(bx, dotY, 4.5), ACCENT, 0.85 - i * 0.2);
    if (i < 2) paint(s, stroke([[bx + 8, dotY], [bx + 34, dotY]], 1.5), ACCENT, 0.3);
  }

  writePng(join(OUT, 'feature-graphic.png'), s);
}
