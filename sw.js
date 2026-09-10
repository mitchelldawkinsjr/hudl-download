// Service worker for the Film Room web app. Lives at the repo root (not
// under web/) so its scope can cover both web/ and the shared/ engine it
// depends on -- a service worker can never claim a scope broader than its
// own location, and web/sw.js would've been stuck unable to see shared/.
const CACHE_NAME = 'film-room-shell-v6';

const SHELL_URLS = [
  './web/index.html',
  './web/manifest.webmanifest',
  './web/icons/icon-192.png',
  './web/icons/icon-512.png',
  './web/app.js',
  './web/sw-register.js',
  './shared/player.css',
  './shared/player.js',
  './shared/play-info.js',
  './shared/hudl-import.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for the app shell (so it works fully offline once installed),
// falling back to the network -- and re-populating the cache from a
// successful network response -- for anything not pre-cached. Video files
// the player loads are local blob:/file: URLs, never network requests, so
// they never pass through here at all.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
