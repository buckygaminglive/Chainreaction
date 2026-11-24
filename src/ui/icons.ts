/**
 * Lucide icons for markup built at runtime. Static markup in index.html gets
 * its icons inlined at build time (see vite.config.mjs); this covers the few
 * places script swaps an icon — the sound toggle. Only the icons imported
 * here are bundled.
 */
import { Volume2, VolumeX, type IconNode } from 'lucide';

function svg(node: IconNode): string {
  const body = node
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`)
    .join('');
  return (
    '<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
  );
}

export const ICON_SOUND_ON = svg(Volume2);
export const ICON_SOUND_OFF = svg(VolumeX);
