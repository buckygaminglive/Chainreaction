/**
 * Service worker.
 *
 * Two jobs, in this order of importance:
 *
 *  1. Make the game installable. A manifest alone is not enough — Chrome
 *     requires a fetch handler before it will offer installation, and a
 *     Trusted Web Activity on the Play Store is an installed PWA in a native
 *     wrapper. Without this file there is no Android app.
 *
 *  2. Make a bad connection survivable. Everything except online play runs
 *     entirely on the device, so a player on a train has no reason to see a
 *     browser error page.
 *
 * Written by hand rather than generated, because the whole thing is ~120 lines
 * and a precache manifest would mean a build step that has to know about
 * hashed filenames. Runtime caching gets the same result without that
 * coupling.
 */

/** Bump on any change to this file, or old clients keep the old worker's
 *  caches around forever. */
const VERSION = 'v1';
const SHELL = `reacton-shell-${VERSION}`;
const RUNTIME = `reacton-runtime-${VERSION}`;

/** Enough to boot the game offline. Deliberately not the hashed bundles —
 *  their names change every build, so they are cached on first use instead. */
const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // Individually, not addAll: addAll rejects the whole install if any one
      // URL 404s, and a worker that fails to install leaves the app
      // permanently uninstallable rather than merely missing one icon.
      .then((cache) => Promise.all(SHELL_URLS.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL && key !== RUNTIME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // The relay lives on another origin and every one of its answers is about
  // right now — a cached room list or leaderboard is a wrong one.
  if (url.origin !== self.location.origin) return;

  // Media is served with Range requests. Answering one from the cache with a
  // full 200 response is how audio playback breaks in ways that are very hard
  // to trace, so the soundtrack is left to the browser's own HTTP cache.
  if (url.pathname.startsWith('/audio/')) return;

  // Navigations: network first, so a deploy is picked up on the next visit
  // rather than being pinned to whatever was cached first.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(SHELL).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/').then((hit) => hit ?? offlineResponse()))
    );
    return;
  }

  // Hashed build output is immutable: if the name matches, the bytes match, so
  // going to the network for it is pure latency.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(RUNTIME).then((cache) => cache.put(request, copy));
            }
            return response;
          })
      )
    );
    return;
  }

  // Everything else — icons, the manifest, the legal pages: try the network,
  // fall back to whatever was kept.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(RUNTIME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit ?? offlineResponse()))
  );
});

function offlineResponse() {
  return new Response('Offline, and this has not been cached yet.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' },
  });
}
