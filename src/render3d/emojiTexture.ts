import { CanvasTexture, SRGBColorSpace } from 'three';

const cache = new Map<string, CanvasTexture>();

/** Rasterizes an emoji character to a small square canvas texture, cached by character. */
export function emojiTexture(char: string): CanvasTexture {
  const cached = cache.get(char);
  if (cached) return cached;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.font = `${size * 0.82}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(char, size / 2, size * 0.56);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  cache.set(char, texture);
  return texture;
}
