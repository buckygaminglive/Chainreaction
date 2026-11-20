/**
 * Launcher icons and the launch splash for the native Android project.
 *
 *   npm run native:res      (after `npm run icons:app`)
 *
 * Writes straight into android/app/src/main/res, replacing the Capacitor
 * template's placeholder artwork. The icon layers themselves are drawn once,
 * by make-app-icons.mjs, into store-assets/android/ — this only fans them out
 * to the density buckets Android's resource resolver looks in.
 *
 * The splash is deliberately just the mark, centred on the game's own
 * background colour, at one fixed density-independent size. Two different
 * things draw it on older Android (the window background while the process
 * starts, then the splash plugin's view until the menu has painted) and they
 * only hand over invisibly if both draw it at exactly the same size — which
 * they do when both take the size from the same resource.
 */
import sharp from 'sharp';
import { mkdirSync, copyFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { icon } from './icon-3d.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'store-assets', 'android');
const RES = join(ROOT, 'android', 'app', 'src', 'main', 'res');

if (!existsSync(RES)) {
  console.error('android/ not found — run `npx cap add android` first.');
  process.exit(1);
}

/** Adaptive-icon layers are 108dp; these are that at each density. */
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

for (const [bucket, scale] of Object.entries(DENSITIES)) {
  const dir = join(RES, `mipmap-${bucket}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(SRC, `mipmap-${bucket}`, 'ic_launcher.png'), join(dir, 'ic_launcher.png'));
  copyFileSync(join(SRC, `mipmap-${bucket}`, 'ic_launcher_round.png'), join(dir, 'ic_launcher_round.png'));
  const px = Math.round(108 * scale);
  for (const layer of ['foreground', 'background']) {
    await sharp(join(SRC, `ic_launcher_${layer}.png`))
      .resize(px, px, { kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toFile(join(dir, `ic_launcher_${layer}.png`));
  }
}

// Both adaptive layers are bitmaps now, so the template's vector placeholders
// and the colour resource they pointed at go.
for (const stale of [
  'drawable-v24/ic_launcher_foreground.xml',
  'drawable/ic_launcher_background.xml',
  'values/ic_launcher_background.xml',
]) {
  rmSync(join(RES, stale), { force: true });
}

const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
writeFileSync(join(RES, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptive);
writeFileSync(join(RES, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptive);

// ---- splash ----
// Every template splash bitmap goes: they are a stretched white Capacitor
// logo in eleven sizes, and any one left behind wins its density bucket.
for (const orient of ['', '-land', '-port']) {
  for (const bucket of ['', ...Object.keys(DENSITIES).map((b) => `-${b}`)]) {
    const dir = `drawable${orient}${bucket}`;
    rmSync(join(RES, dir, 'splash.png'), { force: true });
  }
}

// 144dp mark, authored at xxxhdpi and scaled down by Android for the rest.
const SPLASH_DP = 144;
const splashPx = SPLASH_DP * 4;
mkdirSync(join(RES, 'drawable-xxxhdpi'), { recursive: true });
await sharp(Buffer.from(icon('bare', splashPx)), { density: 512 })
  .resize(splashPx, splashPx)
  .png({ compressionLevel: 9 })
  .toFile(join(RES, 'drawable-xxxhdpi', 'splash.png'));

// The window background while the process starts: flat colour with the same
// bitmap centred at its own size, never stretched to the screen's aspect.
writeFileSync(
  join(RES, 'drawable', 'launch_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/fissile_bg"/>
    <item>
        <bitmap android:gravity="center" android:src="@drawable/splash"/>
    </item>
</layer-list>
`
);

console.log('native res written to android/app/src/main/res');
