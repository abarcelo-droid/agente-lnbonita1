// Service Worker para la PWA de IFCO
// Estrategia: NETWORK-FIRST para todo. La PWA queda online-first pero cachea
// como fallback si el operador queda sin señal momentáneamente.
//
// IMPORTANTE: este SW NO cachea el HTML/JS de la app. Eso evita el bug de
// "los operadores siguen viendo la versión vieja después del deploy".

const CACHE_NAME = 'lnb-mifco-v5';

// Recursos que SÍ cacheamos como fallback offline (no HTML del app):
const STATIC_FALLBACKS = [
  '/manifest-mifco.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Al instalar, cachear solo los recursos estáticos. NO cachear HTML.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_FALLBACKS).catch(()=>{}))
  );
});

// Al activar, limpiar caches viejos y tomar control inmediatamente.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Estrategia network-first: siempre pedir al server primero, solo caer al cache si falla.
// Y para HTML, NUNCA cachear (siempre pedir fresco).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // No interceptar /api/ — son llamadas al backend, queremos errores reales
  if (url.pathname.startsWith('/api/')) return;

  // Para HTML y JS principal, siempre pedir al server (network-first sin cache)
  const acceptsHtml = req.headers.get('accept') && req.headers.get('accept').includes('text/html');
  if (acceptsHtml || url.pathname === '/m/ifco' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // Para todo lo demás (imágenes, fonts, manifest, etc), network-first con cache fallback
  event.respondWith(
    fetch(req).then((resp) => {
      // Cachear copia de respuestas exitosas
      if (resp && resp.status === 200) {
        const respClone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, respClone).catch(()=>{}));
      }
      return resp;
    }).catch(() => caches.match(req))
  );
});

// CRÍTICO: cuando el HTML pide skipWaiting, activarse de inmediato.
// Esto + controllerchange en mifco.html = auto-update sin reinstalar.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
