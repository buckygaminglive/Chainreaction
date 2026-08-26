/**
 * Generates the raster brand assets that a web page and an app store need and
 * an SVG cannot provide: PWA install icons, a maskable icon, the Open Graph
 * share card, and the drawn feature graphic.
 *
 *   node scripts/make-icons.mjs
 *
 * The shapes themselves live in `brand-kit.mjs`; this file is only the list of
 * things to draw and where to put them.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INK,
  GROUND,
  EDGE,
  ACCENT,
  CORE_HOT,
  CORE_MID,
  CORE_COLD,
  TEXT,
  CELL,
  RED,
  surface,
  blend,
  paint,
  circle,
  ring,
  roundRect,
  rectOutline,
  stroke,
  arc,
  drawMark,
  mix,
  glyph,
  drawWordmark,
  wordmarkWidth,
  drawBoard,
  writePng,
} from './brand-kit.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ---------- outputs ----------
// App icons are NOT written here any more. They are drawn from the
// dimensional mark by `make-app-icons.mjs`, which owns every file named
// icon-*.png, favicon-*.png and apple-touch-icon.png. Two scripts writing the
// same paths is a race decided by pipeline order, and the loser is whichever
// icon the store happens to get.
//
// What remains here is the wide artwork, which still uses the flat mark
// because it is type-led rather than icon-led.
mkdirSync(OUT, { recursive: true });

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
