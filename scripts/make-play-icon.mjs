/**
 * Produces the Google Play store listing icon and checks it against the spec.
 *
 *   node scripts/make-play-icon.mjs
 *
 * This is NOT the same asset as `public/icon-512.png`. The web manifest icon
 * draws its own rounded plate, which is right for a PWA install but is a
 * direct violation of Play's rules: Play applies its own 30% corner mask and
 * its own drop shadow, so a pre-rounded asset lands as a rounded rectangle
 * inside a rounded rectangle. The store icon therefore has to be full-bleed
 * and shadowless, which is what this file makes.
 *
 * Source art is a generated render of the same mark. Every hard requirement is
 * asserted rather than trusted, because the failure mode is a store rejection
 * days later rather than an error here.
 */
import sharp from 'sharp';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'store-assets', 'icon-candidates', 'cand-2.png');
// The alternative icon, kept beside its source art. The canonical Play icon
// is store-assets/play-icon-512.png, drawn from the vector mark by
// make-app-icons.mjs — two scripts writing one path is a race, not a choice.
const OUT = join(ROOT, 'store-assets', 'icon-candidates', 'play-icon-generated-art-512.png');

const SIZE = 512;
const MAX_BYTES = 1024 * 1024;

await sharp(SRC)
  .resize(SIZE, SIZE, { fit: 'cover' })
  .toColourspace('srgb')
  // Play wants a 32-bit PNG but warns against transparency: transparent pixels
  // inherit whatever background the store UI happens to use. An alpha channel
  // that is opaque everywhere satisfies both at once.
  .ensureAlpha(1)
  .png({ compressionLevel: 9 })
  .toFile(OUT);

// ---------- verification ----------

const meta = await sharp(OUT).metadata();
const bytes = statSync(OUT).size;
const { data } = await sharp(OUT).raw().toBuffer({ resolveWithObject: true });

const failures = [];
const check = (ok, label) => {
  if (!ok) failures.push(label);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
};

check(meta.width === SIZE && meta.height === SIZE, `512×512 (got ${meta.width}×${meta.height})`);
check(meta.channels === 4, `32-bit PNG / 4 channels (got ${meta.channels})`);
check(meta.format === 'png', `PNG (got ${meta.format})`);
check(meta.space === 'srgb', `sRGB (got ${meta.space})`);
check(bytes <= MAX_BYTES, `under 1024 KB (got ${(bytes / 1024).toFixed(0)} KB)`);

let minAlpha = 255;
for (let i = 3; i < data.length; i += 4) if (data[i] < minAlpha) minAlpha = data[i];
check(minAlpha === 255, `fully opaque, no transparency (min alpha ${minAlpha})`);

// A pre-rounded asset shows up as background-coloured or transparent corners.
// Sampling the four corners is the cheapest way to catch it.
const px = (x, y) => {
  const i = (y * SIZE + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};
const corners = [px(0, 0), px(SIZE - 1, 0), px(0, SIZE - 1), px(SIZE - 1, SIZE - 1)];
check(corners.every((c) => c[3] === 255), 'square corners, no pre-applied mask');
console.log(`      corner colour rgb(${corners[0].slice(0, 3).join(', ')})`);

if (failures.length) {
  console.error(`\n${failures.length} spec violation(s)`);
  process.exit(1);
}
console.log(`\n${OUT.split(/[\/]/).pop()} passes the Play icon spec`);
