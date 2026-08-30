// Service Worker para las PWA que viven bajo /m/ (IFCO móvil e Informes).
// Estrategia: NETWORK-FIRST para todo. Quedan online-first pero cachean como fallback si el
// operador pierde señal un momento.
//
// IMPORTANTE: este SW NO cachea el HTML/JS de la app. Eso evita el bug de "los operadores
// siguen viendo la versión vieja después del deploy".
//
// ── NUNCA, NUNCA CONTESTAR undefined ──────────────────────────────────────────────────
// `caches.match()` de algo que no está guardado resuelve a `undefined`, y
// `event.respondWith(undefined)` el navegador lo toma como un ERROR DE RED: muestra
// "No se puede acceder a este sitio web · ERR_FAILED".
//
// Y como el SW queda instalado en el teléfono, eso NO se arregla recargando: la página ni
// siquiera llega al servidor, así que parece que la aplicación se murió. Le pasó a Santiago
// el 29/8/2026 con el servidor sano, contestando en menos de un segundo.
//
// El SW acá está para que una mala señal se degrade con gracia. Un SW que convierte un
// bache de red en una aplicación rota es peor que no tener SW. Por eso toda rama de este
// archivo termina en una Response de verdad, y hay un test que lo verifica pedido por
// pedido (.smoke/sw_test.mjs).

const CACHE_NAME = 'lnb-mifco-v8';

// Recursos que SÍ cacheamos como fallback offline (no HTML del app):
const STATIC_FALLBACKS = [
  '/manifest-mifco.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Cuánto se espera una navegación antes de mostrar la página de "sin conexión". El servidor
// sano contesta en menos de un segundo; si a los 20 no contestó, el que espera necesita un
// botón, no un spinner. NO aplica a /api/ —esas no se interceptan— así que una carga de foto
// con OCR, que puede tardar un minuto, no se ve afectada.
const TIMEOUT_NAVEGACION = 20000;

// La página que se muestra cuando no hay red y no hay nada guardado. Va escrita acá adentro
// a propósito: si dependiera de un archivo cacheado, fallaría justo cuando hace falta.
function paginaSinConexion(detalle) {
  const cuerpo = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Sin conexión</title><style>
:root{--bg:#f0f4f8;--sur:#fff;--txt:#1a2332;--mut:#5a6a7e;--burg:#1a3a5c;--bor:#dde3ea}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  display:flex;align-items:center;justify-content:center;padding:24px}
.c{background:var(--sur);border:1px solid var(--bor);border-radius:14px;padding:26px 22px;
  max-width:420px;width:100%}
h1{font-size:19px;margin-bottom:8px}
p{color:var(--mut);font-size:14.5px;line-height:1.5;margin-bottom:6px}
small{color:var(--mut);font-size:12px;display:block;margin-top:14px}
button{width:100%;margin-top:18px;padding:15px;border:0;border-radius:11px;background:var(--burg);
  color:#fff;font-size:16px;font-weight:600;font-family:inherit}
</style></head><body><div class="c">
<h1>📶 Sin conexión</h1>
<p>No se pudo llegar al servidor. Lo que cargaste hasta ahora no se perdió: volvé a intentar
cuando tengas señal.</p>
<p><b>El servidor está andando</b> — esto es la señal del teléfono o una caída momentánea.</p>
<button onclick="location.reload()">Reintentar</button>
<small>${detalle || ''}</small>
</div></body></html>`;
  return new Response(cuerpo, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// Y para lo que no es una página (una imagen, el manifest): una respuesta vacía pero VÁLIDA.
// Devolver undefined acá rompe la carga entera de la pantalla.
function sinContenido() {
  return new Response('', { status: 504, statusText: 'Sin conexión' });
}

self.addEventListener('install', (event) => {
  // Tomar el control apenas se instala. Es un arreglo de una app que quedó inservible en los
  // teléfonos: esperar a que se cierren todas las pestañas para activarse sería dejar a la
  // gente rota un día más.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_FALLBACKS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// La red, pero sin quedarse esperando para siempre.
function conTimeout(promesa, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promesa.then((r) => { clearTimeout(t); resolve(r); },
                 (e) => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // No interceptar /api/ — son llamadas al backend y queremos que el error llegue de verdad
  // a la aplicación, que sabe explicarlo mejor que un SW. Incluye el OCR, que tarda.
  if (url.pathname.startsWith('/api/')) return;

  const acceptsHtml = req.headers.get('accept') && req.headers.get('accept').includes('text/html');
  const esNavegacion = req.mode === 'navigate' || acceptsHtml
    || url.pathname === '/m/ifco' || url.pathname === '/m/informes' || url.pathname.endsWith('.html');

  if (esNavegacion) {
    event.respondWith(
      conTimeout(fetch(req), TIMEOUT_NAVEGACION)
        .catch(() => caches.match(req).then((r) => r || paginaSinConexion(
          'Si el problema sigue con buena señal, avisá — el servidor puede estar desplegando.')))
        // El .catch de arriba puede fallar él mismo (cache corrupto): igual sale una página.
        .catch(() => paginaSinConexion(''))
    );
    return;
  }

  // Todo lo demás: la red primero, el cache como paracaídas, y una respuesta válida siempre.
  event.respondWith(
    fetch(req).then((resp) => {
      if (resp && resp.status === 200) {
        const copia = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copia).catch(() => {}));
      }
      return resp;
    }).catch(() => caches.match(req).then((r) => r || sinContenido()))
      .catch(() => sinContenido())
  );
});

// Cuando el HTML pide skipWaiting, activarse de inmediato.
// Esto + controllerchange en mifco.html = auto-update sin reinstalar.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
