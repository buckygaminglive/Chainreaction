/**
 * The complete app icon set, drawn from the dimensional mark in `icon-3d.mjs`.
 *
 *   npm run icons:app
 *
 * Every file here is named the way its consumer expects to find it, because
 * these names are not decorative — the manifest, the HTML head, Apple's
 * touch-icon lookup and Android's mipmap resolver all match on them, and a
 * "nicer" name is a missing icon.
 *
 * Where each one goes:
 *
 *   public/                       served by the site; the PWA manifest and the
 *                                 <head> reference these paths verbatim, and
 *                                 `twa-manifest.json` fetches icon-512 and
 *                                 icon-maskable-512 over HTTP at build time —
 *                                 so the Android launcher icon comes from here
 *                                 too, one deploy later.
 *   store-assets/                 the Play Console upload.
 *   store-assets/android/         adaptive-icon layers and mipmap densities,
 *                                 for the day this stops being a TWA and
 *                                 becomes a native shell.
 *
 * Two safe zones matter and only the tighter one needs honouring:
 *   - W3C maskable: content inside a centred circle of 80% diameter.
 *   - Android adaptive: 108dp canvas, only the central 72dp (66.7%) guaranteed.
 * The mark spans 73% of its box unscaled, so it already clears 80% but is
 * clipped by 66.7%. `scaleForSafeZone` computes the shrink from the geometry
 * rather than from a guessed constant.
 */
import sharp from 'sharp';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { icon, scaleForSafeZone } from './icon-3d.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const STORE = join(ROOT, 'store-assets');
const ANDROID = join(STORE, 'android');

/** Satisfies Android's 66.7% adaptive zone, and 80% maskable by implication. */
const SAFE = scaleForSafeZone(0.667);

const rows = [];

/**
 * Renders one icon and records what it is, so the run ends with a manifest of
 * what was written rather than a wall of unlabelled filenames.
 */
async function write(dir, name, { variant, size, markScale = 1, transparent = false, note }) {
  const svg = Buffer.from(icon(variant, size, { markScale }));
  let img = sharp(svg, { density: 512 }).resize(size, size);
  img = transparent
    ? img.ensureAlpha()
    : // Opaque by intent: Apple and Play both render transparency as whatever
      // their own surface happens to be, which is not a decision to leave to
      // them.
      img.flatten({ background: '#04060a' }).ensureAlpha(1);

  const out = join(dir, name);
  mkdirSync(dir, { recursive: true });
  await img.png({ compressionLevel: 9 }).toFile(out);

  const meta = await sharp(out).metadata();
  rows.push({
    path: join(dir, name).slice(ROOT.length + 1).replace(/\\/g, '/'),
    size: `${meta.width}×${meta.height}`,
    kb: (statSync(out).size / 1024).toFixed(0),
    note,
  });
  return out;
}

// ---------- web + PWA ----------
// These paths are referenced literally by index.html and manifest.webmanifest.

await write(PUBLIC, 'favicon-16x16.png', { variant: 'flat', size: 16, note: 'browser tab' });
await write(PUBLIC, 'favicon-32x32.png', { variant: 'flat', size: 32, note: 'browser tab, 2x' });
await write(PUBLIC, 'favicon-48x48.png', { variant: 'flat', size: 48, note: 'bookmarks, Windows' });

// iOS rounds the touch icon itself, so this one must not arrive pre-rounded.
await write(PUBLIC, 'apple-touch-icon.png', {
  variant: 'flat',
  size: 180,
  note: 'iOS home screen — iOS applies its own mask',
});

// purpose:any — shown as-authored, so the plate is wanted here.
await write(PUBLIC, 'icon-192.png', { variant: 'plate', size: 192, note: 'manifest, purpose:any' });
await write(PUBLIC, 'icon-512.png', { variant: 'plate', size: 512, note: 'manifest + TWA launcher source' });

// purpose:maskable — cropped to an arbitrary shape, so full-bleed ground and
// the mark pulled into the safe zone.
await write(PUBLIC, 'icon-maskable-192.png', {
  variant: 'flat',
  size: 192,
  markScale: SAFE,
  note: 'manifest, purpose:maskable',
});
await write(PUBLIC, 'icon-maskable-512.png', {
  variant: 'flat',
  size: 512,
  markScale: SAFE,
  note: 'manifest maskable + TWA adaptive source',
});

// ---------- Play Console ----------

await write(STORE, 'play-icon-512.png', {
  variant: 'flat',
  size: 512,
  note: 'Play Console → Store listing → App icon',
});

// ---------- Android native (adaptive icon + mipmaps) ----------
// Only needed if the TWA is ever replaced by a native shell; bubblewrap builds
// its own from the manifest URLs above.

await write(ANDROID, 'ic_launcher_foreground.png', {
  variant: 'bare',
  size: 432,
  markScale: SAFE,
  transparent: true,
  note: 'adaptive foreground layer (108dp @ xxxhdpi)',
});
await write(ANDROID, 'ic_launcher_background.png', {
  variant: 'flat',
  size: 432,
  markScale: 0, // ground only — the mark lives in the foreground layer
  note: 'adaptive background layer',
});

const DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];
for (const [density, size] of DENSITIES) {
  await write(join(ANDROID, `mipmap-${density}`), 'ic_launcher.png', {
    variant: 'plate',
    size,
    note: `legacy launcher, ${density}`,
  });
  await write(join(ANDROID, `mipmap-${density}`), 'ic_launcher_round.png', {
    variant: 'flat',
    size,
    markScale: SAFE,
    note: `round launcher, ${density}`,
  });
}

// ---------- report ----------

const w = Math.max(...rows.map((r) => r.path.length));
for (const r of rows) {
  console.log(`${r.path.padEnd(w)}  ${r.size.padStart(9)}  ${r.kb.padStart(4)} kB  ${r.note}`);
}

// ---------- verification ----------
// Named assets are exactly the kind of thing that rots silently, so the run
// fails loudly rather than shipping a wrong one.

const problems = [];

const foreground = join(ANDROID, 'ic_launcher_foreground.png');
const fg = await sharp(foreground).raw().toBuffer({ resolveWithObject: true });
if (fg.data[3] !== 0) problems.push('adaptive foreground layer is not transparent');

// The mark must sit inside the guaranteed-visible 66.7% of the adaptive
// canvas. Measured from the pixels, not assumed from the transform.
{
  const { data, info } = fg;
  let minX = info.width;
  let maxX = -1;
  let minY = info.height;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const extent = Math.max(maxX - minX, maxY - minY) / info.width;
  const ok = extent <= 0.667 + 0.01;
  console.log(`\nadaptive foreground: mark spans ${(extent * 100).toFixed(1)}% of the canvas (limit 66.7%)`);
  if (!ok) problems.push(`mark spans ${(extent * 100).toFixed(1)}%, outside the adaptive safe zone`);
}

for (const [name, expect] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  const m = await sharp(join(PUBLIC, name)).metadata();
  if (m.width !== expect || m.height !== expect) {
    problems.push(`${name} is ${m.width}×${m.height}, expected ${expect}×${expect}`);
  }
  // Apple and the manifest both dislike transparency in purpose:any icons.
  if (m.hasAlpha) {
    const raw = (await sharp(join(PUBLIC, name)).raw().toBuffer({ resolveWithObject: true })).data;
    let min = 255;
    for (let i = 3; i < raw.length; i += 4) if (raw[i] < min) min = raw[i];
    if (min !== 255) problems.push(`${name} contains transparency`);
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nall icons verified');

// The manifest has to list what actually exists, so it is written from the
// same run rather than hand-edited alongside it.
const manifestPath = join(PUBLIC, 'manifest.webmanifest');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.icons = [
  { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log('manifest.webmanifest icons updated');
