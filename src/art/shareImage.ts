/**
 * Rasterises the share card to a PNG on the device.
 *
 * The card is one self-contained SVG (vector shapes and system type, no
 * external images), so the browser can draw it straight onto a canvas: no
 * server, no upload, works offline in the installed app.
 */
import { shareCardSvg, type ShareCardData } from './shareCard.ts';

export const SHARE_W = 1080;
export const SHARE_H = 1920;

export async function renderShareCard(data: ShareCardData): Promise<Blob> {
  const svg = shareCardSvg(data);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = SHARE_W;
    canvas.height = SHARE_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas');
    ctx.drawImage(img, 0, 0, SHARE_W, SHARE_H);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png')
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
