import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import * as lucide from 'lucide';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * Icons in index.html are written as `<i data-icon="chevron-right"></i>` and
 * replaced here, at build time, with the Lucide SVG. Inlined rather than drawn
 * by script at startup so the first paint already has every icon in place —
 * nothing pops in a frame later — and no icon code ships to the browser.
 * An unknown name fails the build instead of rendering a blank square.
 */
const pascal = (name) => name.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());

function lucideSvg(name, extraClass) {
  const node = lucide[pascal(name)];
  if (!Array.isArray(node)) throw new Error(`Unknown Lucide icon "${name}" in index.html`);
  const body = node
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`)
    .join('');
  const cls = extraClass ? `icon ${extraClass}` : 'icon';
  return (
    `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
  );
}

const inlineIcons = {
  name: 'inline-lucide-icons',
  transformIndexHtml(html) {
    return html.replace(/<i data-icon="([a-z0-9-]+)"(?: class="([^"]*)")?><\/i>/g, (_, name, cls) => lucideSvg(name, cls));
  },
};

// Build behaviour is Vite's defaults apart from the version define and the
// icon inlining above. The dev server's watcher must stay out of the native
// and asset folders: android/ alone is thousands of Gradle outputs, and on
// Windows the watcher's open handles there stop Gradle and `cap sync` from
// deleting their own stale files — a build that fails with EPERM/ENOTEMPTY
// while `npm run dev` is running is this.
export default defineConfig({
  plugins: [inlineIcons],
  // The version the profile page shows, from the one place it is set.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    watch: {
      ignored: ['**/android/**', '**/store-assets/**', '**/play-games-pc/**', '**/.wrangler/**', '**/app/**', '**/build/**'],
    },
  },
});
