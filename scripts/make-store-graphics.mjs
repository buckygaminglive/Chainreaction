/**
 * Composites the Play Store feature graphic: generated key art underneath, the
 * real FISSILE lockup on top.
 *
 *   node scripts/make-store-graphics.mjs
 *
 * The art is a render — it is allowed to be prettier than a screenshot, and
 * every store's key art is. The *type* is not allowed to be approximate, which
 * is why the wordmark is drawn here from `brand-kit.mjs` rather than asked for
 * in the prompt: an image model renders letterforms it invents, and the one
 * word that has to survive being scaled to a thumbnail is the name.
 *
 * Play wants exactly 1024×500. The source renders are 16:9, so each is zoomed
 * and panned to put its burst right of centre, leaving the left third as
 * ground for the lockup.
 */
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ACCENT, TEXT, GROUND, surface, paint, blend, circle, stroke, drawMark, drawWordmark, wordmarkWidth } from './brand-kit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ART = join(ROOT, 'store-assets');

const W = 1024;
const H = 500;

/**
 * The lockup, rendered as straight-alpha RGBA.
 *
 * The kit paints into an opaque RGB buffer, so coverage is recovered by
 * drawing the same thing twice — once on black, once on white — and reading
 * the alpha out of the difference. That is exact for `over` compositing, and
 * it means the kit needs no alpha channel bolted on for one caller.
 */
function lockupLayer() {
  const draw = (ground) => {
    const s = surface(W, H, ground);
    const cy = H / 2;

    drawMark(s, 112, cy, 132, { plate: false });

    const cap = 46;
    const tracking = 15;
    const textX = 200;
    const width = wordmarkWidth('FISSILE', cap, tracking);
    drawWordmark(s, 'FISSILE', textX, cy - cap / 2 - 16, cap, 3.2, tracking, TEXT);

    // Rule and beads: the same three-particle cadence as the drawn graphic, so
    // the two feature graphics are recognisably one family.
    paint(s, stroke([[textX, cy + cap / 2 + 12], [textX + width, cy + cap / 2 + 12]], 1.4), ACCENT, 0.45);
    const dotY = cy + cap / 2 + 38;
    for (let i = 0; i < 3; i++) {
      const bx = textX + i * 38;
      paint(s, circle(bx, dotY, 4), ACCENT, 0.9 - i * 0.22);
      if (i < 2) paint(s, stroke([[bx + 7, dotY], [bx + 31, dotY]], 1.4), ACCENT, 0.35);
    }
    return s;
  };

  const black = draw([0, 0, 0]);
  const white = draw([255, 255, 255]);

  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const j = i * 3;
    // Whichever channel separates most gives the steadiest alpha.
    let a = 0;
    for (let c = 0; c < 3; c++) a = Math.max(a, 1 - (white.data[j + c] - black.data[j + c]) / 255);
    a = Math.min(1, Math.max(0, a));
    const k = i * 4;
    if (a > 0.0001) {
      for (let c = 0; c < 3; c++) out[k + c] = Math.min(255, Math.max(0, Math.round(black.data[j + c] / a)));
    }
    out[k + 3] = Math.round(a * 255);
  }
  return out;
}

/**
 * A left-to-right scrim, so type on the left has something to sit on.
 *
 * Tuned per image rather than fixed: art that is dark at the left edge needs
 * only a short fade, while art that is busy all the way across needs to stay
 * near-opaque past the end of the wordmark before it lets go — otherwise the
 * grid behind the type shows through the counters of the letters.
 */
function scrimLayer({ plateau, reach, strength }) {
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4;
      const t = Math.min(1, Math.max(0, (x - plateau) / (reach - plateau)));
      const a = (1 - t) ** 1.5 * strength;
      out[k] = GROUND[0];
      out[k + 1] = GROUND[1];
      out[k + 2] = GROUND[2];
      out[k + 3] = Math.round(a * 255);
    }
  }
  return out;
}

/** A hairline frame in the accent, which reads as intent at thumbnail size. */
function frameLayer() {
  const s = surface(W, H, [0, 0, 0]);
  const m = 14;
  const arm = 46;
  for (const [x0, y0, x1, y1] of [
    [m, m, m + arm, m], [m, m, m, m + arm],
    [W - m - arm, m, W - m, m], [W - m, m, W - m, m + arm],
    [m, H - m - arm, m, H - m], [m, H - m, m + arm, H - m],
    [W - m, H - m - arm, W - m, H - m], [W - m - arm, H - m, W - m, H - m],
  ]) paint(s, stroke([[x0, y0], [x1, y1]], 1.6), [255, 255, 255], 1);

  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const a = s.data[i * 3] / 255;
    const k = i * 4;
    out[k] = ACCENT[0]; out[k + 1] = ACCENT[1]; out[k + 2] = ACCENT[2];
    out[k + 3] = Math.round(a * 0.5 * 255);
  }
  return out;
}

/**
 * Zooms and pans `file` so its focal point lands where the composition wants
 * it, then hands back a 1024×500 cover crop.
 */
async function keyArt(file, focal) {
  const scaled = { w: 1500, h: Math.round((1500 / 2752) * 1536) };
  const fx = focal[0] * scaled.w;
  const fy = focal[1] * scaled.h;
  const left = Math.round(Math.min(scaled.w - W, Math.max(0, fx - 0.70 * W)));
  const top = Math.round(Math.min(scaled.h - H, Math.max(0, fy - 0.50 * H)));

  return sharp(join(ART, file))
    .resize(scaled.w, scaled.h, { fit: 'fill' })
    .extract({ left, top, width: W, height: H })
    .toBuffer();
}

const raw = (buf) => ({ input: buf, raw: { width: W, height: H, channels: 4 } });

async function build(file, focal, scrim, out) {
  const base = await keyArt(file, focal);
  await sharp(base)
    .composite([raw(scrimLayer(scrim)), raw(lockupLayer()), raw(frameLayer())])
    .png({ compressionLevel: 9 })
    .toFile(join(ART, out));
  const meta = await sharp(join(ART, out)).metadata();
  const bytes = statSync(join(ART, out)).size;
  console.log(`${out.padEnd(28)} ${meta.width}×${meta.height}  ${(bytes / 1024).toFixed(0)} kB`);
}

mkdirSync(ART, { recursive: true });
// A darkens toward its left edge on its own, so it needs no plateau at all.
await build('fg-option-a.png', [0.495, 0.448], { plateau: 0, reach: 620, strength: 0.94 }, 'feature-graphic-a.png');
// B's lattice runs edge to edge, so the scrim holds until the wordmark ends
// at x≈528 and then clears well before the burst at x≈717.
await build('fg-option-b.png', [0.500, 0.493], { plateau: 460, reach: 760, strength: 0.97 }, 'feature-graphic-b.png');
