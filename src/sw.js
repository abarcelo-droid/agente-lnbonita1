// LNB App — Service Worker
// Estrategia: network-first para API, cache-first para assets estáticos.
// Actualizamos CACHE_NAME cada vez que queramos forzar refresh en todos los celulares.

const CACHE_NAME = 'lnb-app-v2';
const OFFLINE_URL = '/scout';

// Recursos que cacheamos al instalar el SW (sin los que requieren auth)
const PRECACHE_URLS = [
  '/scout',
  '/login',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
  // Leaflet CDN (para mapa de polígonos, por si lo abren offline)
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// ── INSTALL ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Intentamos cachear todos, pero si alguno falla no rompemos la instalación
      return Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => console.warn('No se pudo cachear:', url, err.message))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ── (borra caches viejos de versiones anteriores)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ──
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Solo manejamos GET del mismo origen o CDN conocidos
  if (request.method !== 'GET') return;

  // API calls: network-first (queremos siempre datos frescos)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        // Si no hay red, devolvemos un JSON de error consistente
        new Response(
          JSON.stringify({ ok: false, error: 'Sin conexión', offline: true }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // Imágenes de datos (fotos subidas): cache-first (no cambian una vez subidas)
  if (url.pathname.startsWith('/data/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return resp;
        }).catch(() =>
          new Response('', { status: 503, statusText: 'Sin conexión' })
        );
      })
    );
    return;
  }

  // Resto (HTML, JS, CSS, imágenes del app): network-first con fallback a cache
  event.respondWith(
    fetch(request).then((resp) => {
      // Actualizar cache con la versión nueva
      if (resp.ok && resp.type === 'basic') {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      }
      return resp;
    }).catch(() =>
      caches.match(request).then((cached) => {
        if (cached) return cached;
        // Si es una navegación a una ruta que no tenemos, servimos /scout offline
        if (request.mode === 'navigate') {
          return caches.match(OFFLINE_URL);
        }
        return new Response('', { status: 503, statusText: 'Sin conexión' });
      })
    )
  );
});

// Permitir que la app dispare un skipWaiting para actualizar
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
