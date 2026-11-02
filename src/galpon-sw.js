/* ══════════════════════════════════════════════════════════════════════════════════════
   📴 SERVICE WORKER DEL PANEL — para que el galpón ABRA sin señal
   ══════════════════════════════════════════════════════════════════════════════════════
   Andy, 2/11/2026: «que los chicos puedan cargar info sin necesidad de estar
   conectados».

   La cola (galponOffline.js) resuelve que una carga no se pierda cuando la pestaña YA
   está abierta, que es el caso normal: la PC del galpón queda prendida todo el día. Este
   archivo resuelve el otro: que alguien pueda ABRIR el panel sin señal, o recargarlo
   después de un corte de luz.

   ── LA LECCIÓN QUE YA ESTÁ ESCRITA EN mifco-sw.js ──────────────────────────────────
   Ese SW dice, con todas las letras, que NO cachea el HTML de la app «para evitar el
   bug de que los operadores sigan viendo la versión vieja después del deploy». Es una
   lección cara y sigue siendo cierta.

   Acá se cachea igual, pero el riesgo se maneja de otra manera: NETWORK-FIRST SIEMPRE.
   Con señal, la respuesta es la del servidor y el caché sólo se actualiza; el caché se
   sirve únicamente cuando la red falla o tarda demasiado. O sea que nadie ve la versión
   vieja mientras haya red — y sin red, ver la de ayer es infinitamente mejor que ver
   «no se puede acceder a este sitio».

   ── Y LA OTRA LECCIÓN: NUNCA CONTESTAR undefined ───────────────────────────────────
   `caches.match()` de algo que no está resuelve a `undefined`, y
   `event.respondWith(undefined)` el navegador lo toma como ERROR DE RED. Como el SW
   queda instalado, eso NO se arregla recargando: la página ni llega al servidor y
   parece que la aplicación se murió. Le pasó a Santiago el 29/8/2026 con el servidor
   sano. Por eso toda rama de este archivo termina en una Response de verdad.
   ══════════════════════════════════════════════════════════════════════════════════════ */

const CACHE = 'lnb-galpon-v1';

/* Lo que hace falta para que el panel abra y el galpón funcione. El panel.html pesa
   3,6 MB: se cachea igual, porque sin él no hay pantalla — y se baja UNA vez. */
const IMPRESCINDIBLES = [
  '/panel',
  '/static/sidebar-v2.js',
  '/static/galponOffline.js',
  '/static/galponOfflineNav.js',
  '/static/mandata.js',
  '/static/balanza.js',
];

// Cuánto se espera a la red antes de servir lo guardado. Corto a propósito: el que
// está parado con un cajón en la balanza no puede mirar un spinner veinte segundos.
const ESPERA = 4000;

function conTimeout(promesa, ms) {
  return new Promise((ok, mal) => {
    const t = setTimeout(() => mal(new Error('tardó demasiado')), ms);
    promesa.then((r) => { clearTimeout(t); ok(r); },
                 (e) => { clearTimeout(t); mal(e); });
  });
}

/* La página de último recurso: sin red y sin nada guardado. Va escrita acá adentro a
   propósito — si dependiera de un archivo cacheado, fallaría justo cuando hace falta. */
function sinNada() {
  return new Response(
    '<!doctype html><html lang="es"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Sin conexión</title><style>body{font-family:system-ui,sans-serif;'
    + 'margin:0;display:flex;align-items:center;justify-content:center;height:100vh;'
    + 'background:#f8fafc;color:#0f172a;text-align:center;padding:24px}'
    + 'div{max-width:420px}h1{font-size:19px;margin:0 0 10px}'
    + 'p{color:#64748b;font-size:14px;line-height:1.5}'
    + 'button{margin-top:16px;padding:9px 18px;border:1px solid #cbd5e1;'
    + 'border-radius:8px;background:#fff;font:inherit;cursor:pointer}</style></head>'
    + '<body><div><h1>📴 Sin conexión</h1>'
    + '<p>No hay señal y este equipo todavía no tiene el panel guardado. '
    + 'Abrilo una vez con señal y después va a funcionar sin ella.</p>'
    + '<p><b>Lo que ya cargaste no se perdió:</b> está en este equipo y se manda solo '
    + 'cuando vuelva la conexión.</p>'
    + '<button onclick="location.reload()">Reintentar</button></div></body></html>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('install', (ev) => {
  /* Falla de a uno: si un archivo no está, cache.addAll rechaza TODO y el SW queda sin
     instalar. Con addAll, un solo 404 deja el galpón sin nada guardado. */
  ev.waitUntil(caches.open(CACHE).then((c) =>
    Promise.all(IMPRESCINDIBLES.map((u) => c.add(u).catch(() => {})))
  ).then(() => self.skipWaiting()));
});

/* Al activarse se limpian las versiones viejas — si no, cada deploy deja la suya y con
   panel.html pesando 3,6 MB el equipo del galpón se queda sin espacio a la décima.

   PERO SÓLO LAS PROPIAS. `caches` es por ORIGEN, no por service worker: borrar todo lo
   que no sea el mío se lleva puesto `lnb-mifco-v8`, que es el fallback de las PWA de
   IFCO — y ellos sí trabajan en el teléfono, donde la señal es peor. */
const MIOS = /^lnb-galpon-/;

self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => MIOS.test(k) && k !== CACHE)
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* LAS LLAMADAS A LA API NO SE TOCAN. Del galpón se ocupa galponOfflineNav.js, que
     guarda la ÚLTIMA respuesta de cada una en IndexedDB y la marca con la fecha en que
     se leyó. Un caché de API acá, sin esa marca, serviría el stock de ayer como si
     fuera el de hoy. */
  if (url.pathname.startsWith('/api/')) return;

  ev.respondWith(
    conTimeout(fetch(req), ESPERA)
      .then((r) => {
        // Se guarda una COPIA: el cuerpo se lee una sola vez.
        if (r && r.ok) {
          const copia = r.clone();
          caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(req).then((g) => g
        || (req.mode === 'navigate' ? sinNada()
          /* Un recurso que no está guardado tiene que fallar como un recurso, no como
             una página: devolver el HTML de «sin conexión» en el lugar de un .js lo
             rompería con un error de sintaxis que no dice nada. */
          : new Response('', { status: 504, statusText: 'Sin conexión' }))))
  );
});
