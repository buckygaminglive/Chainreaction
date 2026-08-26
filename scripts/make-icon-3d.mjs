/**
 * Writes the three standalone variants of the dimensional mark.
 *
 *   node scripts/make-icon-3d.mjs
 *
 * The shapes live in `icon-3d.mjs`; this file is the list of what to write
 * and where. For the full named app-icon set, see `make-app-icons.mjs`.
 *
 *   plate  — rounded plate and frame. The PWA/launcher look.
 *   flat   — full-bleed square, no frame. What Google Play's spec requires,
 *            since Play applies its own corner mask and drop shadow.
 *   bare   — no frame, no background, transparent. For compositing onto
 *            anything else: slides, the site, a press kit.
 */
import sharp from 'sharp';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { icon } from './icon-3d.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'store-assets', 'icon-3d');

mkdirSync(OUT, { recursive: true });

const SIZES = [512, 1024];
const VARIANTS = [
  ['plate', 'rounded plate and frame — PWA / launcher'],
  ['flat', 'full-bleed square, no frame — Play Store spec'],
  ['bare', 'no frame, no background, transparent'],
];

for (const [variant, note] of VARIANTS) {
  writeFileSync(join(OUT, `icon-3d-${variant}.svg`), icon(variant, 512));
  console.log(`${`icon-3d-${variant}.svg`.padEnd(24)} vector    ${note}`);

  for (const size of SIZES) {
    const buf = Buffer.from(icon(variant, size));
    let img = sharp(buf, { density: 384 }).resize(size, size);
    // Only the transparent variant keeps real alpha; the other two are opaque
    // by intent, and Play would rather they had no transparency at all.
    img = variant === 'bare' ? img.ensureAlpha() : img.flatten({ background: '#04060a' }).ensureAlpha(1);
    const out = join(OUT, `icon-3d-${variant}-${size}.png`);
    await img.png({ compressionLevel: 9 }).toFile(out);
    const m = await sharp(out).metadata();
    console.log(
      `  ${`icon-3d-${variant}-${size}.png`.padEnd(26)} ${m.width}×${m.height}  ${(statSync(out).size / 1024).toFixed(0)} kB`
    );
  }
}

// ---------- verification ----------
// Both of these are easy to get silently wrong and expensive to discover
// later, so they are proved rather than assumed.

// 1. The bare variant really is transparent.
const bare = join(OUT, 'icon-3d-bare-512.png');
const { data } = await sharp(bare).raw().toBuffer({ resolveWithObject: true });
if (data[3] !== 0) throw new Error('bare variant is not transparent at the corner');
let opaque = 0;
for (let i = 3; i < data.length; i += 4) if (data[i] > 250) opaque++;
console.log(`\nbare: corner alpha 0, ${((opaque / (data.length / 4)) * 100).toFixed(1)}% fully opaque pixels`);

// 2. The flat variant satisfies the Play store icon spec, so it can be
//    uploaded directly in place of the generated-art icon.
const flat = join(OUT, 'icon-3d-flat-512.png');
const fm = await sharp(flat).metadata();
const fbytes = statSync(flat).size;
const fraw = (await sharp(flat).raw().toBuffer({ resolveWithObject: true })).data;
let minAlpha = 255;
for (let i = 3; i < fraw.length; i += 4) if (fraw[i] < minAlpha) minAlpha = fraw[i];
const corners = [0, 511, 511 * 512, 511 * 512 + 511].map((i) => fraw[i * 4 + 3]);

const checks = [
  [fm.width === 512 && fm.height === 512, `512x512 (got ${fm.width}x${fm.height})`],
  [fm.channels === 4, `32-bit PNG / 4 channels (got ${fm.channels})`],
  [fm.format === 'png', `PNG (got ${fm.format})`],
  [fm.space === 'srgb', `sRGB (got ${fm.space})`],
  [fbytes <= 1024 * 1024, `under 1024 KB (got ${(fbytes / 1024).toFixed(0)} KB)`],
  [minAlpha === 255, `fully opaque (min alpha ${minAlpha})`],
  [corners.every((a) => a === 255), 'square corners, no pre-applied mask'],
];
console.log('\nflat variant against the Play icon spec:');
let bad = 0;
for (const [ok, label] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
}
if (bad) {
  console.error(`\n${bad} spec violation(s)`);
  process.exit(1);
}

