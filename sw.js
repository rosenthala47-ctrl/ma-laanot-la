// ============================================================
// Service Worker for "מה לענות לה?" PWA
// Network-first, NO HTML caching, aggressive update on activate.
// ============================================================

const CACHE_NAME = 'mll-v3-' + 'navfix';
const SHELL_ASSETS = [
  './icon.svg',
  './favicon.svg',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Don't intercept Supabase / Anthropic — always network
  if (url.hostname.includes('supabase.co') || url.hostname.includes('anthropic.com')) {
    return;
  }

  // HTML — ALWAYS go to network, NEVER cache. Stale HTML hides our latest fixes.
  if (req.destination === 'document' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() => caches.match('./icon.svg').then(() => new Response('Offline', { status: 503 })))
    );
    return;
  }

  // Other same-origin assets (svg, json, etc): cache-first with background refresh
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req).then((res) => {
          caches.open(CACHE_NAME).then((c) => c.put(req, res.clone())).catch(() => {});
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});
