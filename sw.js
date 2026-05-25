// ============================================================
// Service Worker for "מה לענות לה?" PWA
// Minimal: just enables installability + a tiny offline shell.
// Chat replies need network anyway, so we don't cache API calls.
// ============================================================

const CACHE_NAME = 'mll-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './icon.svg',
  './favicon.svg',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for HTML (so users always get latest app), cache fallback
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Don't cache Supabase / API calls — always go to network
  if (url.hostname.includes('supabase.co') || url.hostname.includes('anthropic.com')) {
    return; // default browser behavior
  }

  // For our shell files: network-first, fallback to cache
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
    );
  }
});
