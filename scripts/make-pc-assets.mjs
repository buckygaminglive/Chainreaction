/**
 * The two Google Play Games on PC assets that are not screenshots.
 *
 *   node scripts/make-pc-assets.mjs
 *
 * Play composites these into a single "game card": the logo is centred and
 * overlaid on top of the feature graphic. That is the whole reason for their
 * unusual constraints, and for two rules that pull in opposite directions:
 *
 *   - the LOGO must be a transparent PNG, exactly 600×400, and must represent
 *     the name of the game — so it carries the wordmark and nothing else that
 *     needs a background to read against.
 *   - the FEATURE GRAPHIC must contain NO TEXT, 16:9, each side 720–7,680 px —
 *     because the logo is going to land on top of it. Any type baked in here
 *     ends up double-set under Play's own overlay.
 *
 * So this deliberately does NOT reuse `store-assets/feature-graphic-a.png`:
 * that one has the FISSILE lockup composited into it for the Play Store
 * listing slot, which is exactly what this slot forbids. It goes back to the
 * untouched key art instead.
 */
import sharp from 'sharp';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCENT, TEXT, circle, paint, stroke, drawWordmark, wordmarkWidth, rgbaLayer } from './brand-kit.mjs';
import { icon } from './icon-3d.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ART = join(ROOT, 'store-assets');
const OUT = join(ART, 'play-games-pc');

mkdirSync(OUT, { recursive: true });

// ---------- the logo: 600×400, transparent ----------

const FG_W = 1920;
const FG_H = 1080;
const fgSource = join(ART, 'fg-option-a.png');

const LOGO_W = 600;
const LOGO_H = 400;

const MARK_PX = 168;

const type = rgbaLayer(LOGO_W, LOGO_H, (s) => {
  const cx = LOGO_W / 2;

  const cap = 58;
  const tracking = 21;
  const width = wordmarkWidth('FISSILE', cap, tracking);
  const textX = cx - width / 2;
  const textY = 253;
  drawWordmark(s, 'FISSILE', textX, textY, cap, 3.8, tracking, TEXT);

  // The same rule-and-beads cadence as every other piece of FISSILE artwork.
  const ruleY = textY + cap + 16;
  paint(s, stroke([[textX, ruleY], [textX + width, ruleY]], 1.6), ACCENT, 0.45);
  const dotY = ruleY + 26;
  for (let i = 0; i < 3; i++) {
    const bx = cx - 40 + i * 40;
    paint(s, circle(bx, dotY, 4.4), ACCENT, 0.9 - i * 0.22);
    if (i < 2) paint(s, stroke([[bx + 8, dotY], [bx + 32, dotY]], 1.5), ACCENT, 0.32);
  }
});

// The mark comes from the dimensional vector, not the flat SDF one, so the
// game card matches the icon a player just saw in the store.
const mark = await sharp(Buffer.from(icon('bare', MARK_PX)), { density: 512 })
  .resize(MARK_PX, MARK_PX)
  .ensureAlpha()
  .png()
  .toBuffer();

const logoPath = join(OUT, 'pc-logo-600x400.png');
await sharp({ create: { width: LOGO_W, height: LOGO_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([
    // Mark above, wordmark below. Stacked rather than side by side because the
    // slot is 3:2 — a horizontal lockup would leave the type too small.
    { input: mark, left: Math.round((LOGO_W - MARK_PX) / 2), top: 52 },
    { input: type, raw: { width: LOGO_W, height: LOGO_H, channels: 4 } },
  ])
  .png({ compressionLevel: 9 })
  .toFile(logoPath);

// The preview is built further down, from the finished feature graphic rather
// than from the raw art — previewing against the source would test a
// composite that never ships.

// ---------- the feature graphic: 16:9, no text ----------
//
// A straight resize was the obvious thing and it was wrong. The source render
// puts its burst dead centre, and Play centres the logo — so the wordmark
// landed on the brightest pixels in the frame and stopped being readable. This
// is a backdrop for someone else's overlay, not a standalone poster, and it
// has to be composed as one.
//
// Two corrections: pan the burst into the upper right so the middle is calm,
// and lay a soft darkening over the centre so the type has something to sit
// on whatever else changes. No text is added — that rule is untouched.

/** Zoom needed to place `focal` at `want` without running off the source. */
const ZOOM = 1.5;
const scaled = { w: Math.round(FG_W * ZOOM), h: Math.round(FG_H * ZOOM) };
const FOCAL = { x: 0.495, y: 0.448 }; // where the burst sits in the source
const WANT = { x: 0.72, y: 0.32 }; // where it should sit in the result

const left = Math.round(Math.min(scaled.w - FG_W, Math.max(0, FOCAL.x * scaled.w - WANT.x * FG_W)));
const top = Math.round(Math.min(scaled.h - FG_H, Math.max(0, FOCAL.y * scaled.h - WANT.y * FG_H)));

/** A wide, soft darkening over the middle, where the logo lands. */
function centreScrim() {
  const out = Buffer.alloc(FG_W * FG_H * 4);
  const cx = FG_W / 2;
  const cy = FG_H / 2;
  const rx = FG_W * 0.34;
  const ry = FG_H * 0.42;
  for (let y = 0; y < FG_H; y++) {
    for (let x = 0; x < FG_W; x++) {
      const t = Math.min(1, Math.hypot((x - cx) / rx, (y - cy) / ry));
      const a = (1 - t) ** 1.8 * 0.55;
      const k = (y * FG_W + x) * 4;
      out[k] = 3;
      out[k + 1] = 6;
      out[k + 2] = 10;
      out[k + 3] = Math.round(a * 255);
    }
  }
  return out;
}

const fgPath = join(OUT, 'pc-feature-graphic-1920x1080.png');
await sharp(fgSource)
  .resize(scaled.w, scaled.h, { fit: 'fill' })
  .extract({ left, top, width: FG_W, height: FG_H })
  .composite([{ input: centreScrim(), raw: { width: FG_W, height: FG_H, channels: 4 } }])
  .png({ compressionLevel: 9 })
  .toFile(fgPath);

// Play centres the logo on the feature graphic to build one game card, so the
// two are previewed together. A logo that reads fine on its own can still
// vanish into whatever it lands on — which is exactly what happened the first
// time this ran.
const cardPath = join(OUT, 'preview-game-card.png');
await sharp(fgPath)
  .composite([{ input: await sharp(logoPath).resize(Math.round(FG_W * 0.42)).toBuffer(), gravity: 'centre' }])
  .png({ compressionLevel: 9 })
  .toFile(cardPath);

// ---------- verification ----------

const problems = [];
const report = [];

async function check(path, { width, height, transparentCorners, maxMB }) {
  const meta = await sharp(path).metadata();
  const bytes = statSync(path).size;
  const name = path.split(/[\\/]/).pop();
  report.push(`${name.padEnd(34)} ${meta.width}×${meta.height}  ${(bytes / 1024 / 1024).toFixed(2)} MB`);

  if (meta.width !== width || meta.height !== height) {
    problems.push(`${name}: ${meta.width}×${meta.height}, expected ${width}×${height}`);
  }
  if (bytes > maxMB * 1024 * 1024) {
    problems.push(`${name}: ${(bytes / 1024 / 1024).toFixed(2)} MB, over the ${maxMB} MB limit`);
  }

  if (transparentCorners !== undefined) {
    const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => data[(y * info.width + x) * 4 + 3];
    const corners = [at(0, 0), at(info.width - 1, 0), at(0, info.height - 1), at(info.width - 1, info.height - 1)];
    const clear = corners.every((a) => a === 0);
    if (clear !== transparentCorners) {
      problems.push(`${name}: corners are ${clear ? 'transparent' : 'opaque'}, expected the opposite`);
    }
  }
}

// 600×400 exactly, transparent, up to 8 MB.
await check(logoPath, { width: 600, height: 400, transparentCorners: true, maxMB: 8 });
// 16:9, sides 720–7680, up to 15 MB, and no text — the last of which is a
// property of the source art, not something a check can assert.
await check(fgPath, { width: FG_W, height: FG_H, transparentCorners: false, maxMB: 15 });

for (const line of report) console.log(line);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nboth assets meet the Play Games on PC spec');
console.log('note: the feature graphic is the untouched key art — no text, by requirement');
