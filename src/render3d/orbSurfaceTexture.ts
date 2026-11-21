import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';

let cached: CanvasTexture | null = null;

/** A plain solid-color sphere shows no visible rotation — there's nothing on
 *  its surface to track, so even genuinely chaotic 3-axis spin reads as
 *  static. This bakes an irregular, mottled "marble/planet" pattern across
 *  an equirectangular canvas (blotches placed across the full latitude
 *  range, poles included, so spin around any axis reveals movement) and
 *  gets multiplied by each player's tint color, so the tumble is actually
 *  visible instead of just mathematically happening. */
export function orbSurfaceTexture(): CanvasTexture {
  if (cached) return cached;

  // 512×256: at full screen resolution a smaller map visibly softens the
  // marbling on the larger orbs.
  const w = 512;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  // Irregular darker blotches scattered across the whole map, including
  // near the top/bottom edges (the sphere's poles) — a pattern confined to
  // the equator would make rotation around a horizontal axis invisible.
  const blotchCount = 22;
  for (let i = 0; i < blotchCount; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = 16 + Math.random() * 44;
    const shade = 0.55 + Math.random() * 0.3;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(0,0,0,${1 - shade})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // Wrap horizontally so blotches near the left/right seam don't look cut off.
    if (x < r) {
      ctx.save();
      ctx.translate(w, 0);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (x > w - r) {
      ctx.save();
      ctx.translate(-w, 0);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // A handful of small bright flecks for a bit of sparkle/variation.
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = 4 + Math.random() * 8;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  cached = texture;
  return texture;
}
