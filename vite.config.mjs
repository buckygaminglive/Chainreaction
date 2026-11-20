import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Build behaviour is Vite's defaults apart from the version define below.
// The dev server's watcher must stay out of the native and asset folders:
// android/ alone is thousands of Gradle outputs, and on Windows the watcher's
// open handles there stop Gradle and `cap sync` from deleting their own
// stale files — a build that fails with EPERM/ENOTEMPTY while `npm run dev`
// is running is this.
export default defineConfig({
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
