// Service Worker para LNB IFCO Mobile (PWA)
// Estrategia: network-first para HTML, cache-first para assets estáticos.
// El shell se cachea para que la app sea instalable y arranque rápido.

const CACHE_NAME = 'lnb-ifco-v1';
const SHELL = [
  '/m/ifco',
  '/manifest-mifco.json',
  '/mifco-icon-192.png',
  '/mifco-icon-512.png',
  '/mifco-icon-apple.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Limpiar caches viejos
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Nunca cachear las APIs (siempre live data)
  if (url.pathname.startsWith('/api/')) return;

  // Para la página principal /m/ifco: network-first con fallback a cache
  if (url.pathname === '/m/ifco' || url.pathname === '/m') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/m/ifco')))
    );
    return;
  }

  // Para los íconos y manifest: cache-first
  if (
    url.pathname.startsWith('/mifco-icon-') ||
    url.pathname === '/manifest-mifco.json'
  ) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }))
    );
    return;
  }

  // Resto: pasar tal cual
});
