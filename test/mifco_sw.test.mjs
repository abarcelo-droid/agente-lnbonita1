// El service worker de las PWA de /m/ (IFCO móvil e Informes), cargado de verdad en un
// ServiceWorkerGlobalScope de mentira: se le entregan pedidos y se mira QUÉ CONTESTA.
//
// ── POR QUÉ ESTE TEST EXISTE ──────────────────────────────────────────────────────────
// El 29/8/2026 Santiago no podía abrir /m/ifco: Chrome decía "No se puede acceder a este
// sitio web · ERR_FAILED". El servidor estaba sano y contestaba en menos de un segundo.
//
// La causa: `caches.match()` de algo que no está guardado resuelve a `undefined`, y
// `event.respondWith(undefined)` el navegador lo toma como un error de red. El SW no cachea
// HTML a propósito, así que CUALQUIER bache de señal en una navegación daba ERR_FAILED — y
// como el SW queda instalado en el teléfono, recargar no lo arregla: la página ni siquiera
// llega al servidor. La app parecía muerta estando viva.
//
// Un service worker está para que una mala señal se degrade con gracia. Uno que convierte un
// bache de red en una aplicación rota es peor que no tener ninguno. Por eso el test recorre
// todas las ramas y exige lo mismo en todas: una Response de verdad, nunca undefined.
//
// No necesita base ni servidor: es un archivo y un puñado de objetos falsos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/mifco-sw.js', import.meta.url), 'utf8');
const U = 'https://agente-lnbonita1-production.up.railway.app';

// Carga el SW con una red y un cache a medida.
function cargar({ cacheado = {}, red = 'ok' } = {}) {
  const handlers = {};
  const almacen = new Map(Object.entries(cacheado));
  const self = {
    addEventListener: (ev, fn) => { (handlers[ev] || (handlers[ev] = [])).push(fn); },
    skipWaiting: () => { self._skip = true; },
    clients: { claim: () => Promise.resolve() },
  };
  const caches = {
    open: async () => ({ addAll: async () => {}, put: async () => {} }),
    keys: async () => [],
    delete: async () => true,
    // Devuelve undefined cuando no hay nada guardado. Es lo que dice la norma, y es la trampa.
    match: async (req) => almacen.get(typeof req === 'string' ? req : req.url),
  };
  const fetchFalso = (req) => {
    if (red === 'falla')  return Promise.reject(new TypeError('Failed to fetch'));
    if (red === 'cuelga') return new Promise(() => {});     // no resuelve nunca
    return Promise.resolve({ status: 200, ok: true, clone: () => ({}), _red: true, url: req.url });
  };
  new Function('self', 'caches', 'fetch', 'URL', 'Response', 'setTimeout', 'clearTimeout', SRC)(
    self, caches, fetchFalso, URL, Response, setTimeout, clearTimeout);
  return { handlers, self };
}

const navegacion = (url) => ({ method: 'GET', url, mode: 'navigate',
  headers: { get: (k) => (String(k).toLowerCase() === 'accept' ? 'text/html,application/xhtml+xml' : null) } });
const recurso = (url) => ({ method: 'GET', url, mode: 'no-cors', headers: { get: () => 'image/png' } });
const llamadaApi = (url) => ({ method: 'GET', url, headers: { get: () => null } });

const NO_INTERCEPTADO = Symbol('no-interceptado');
async function responder(handlers, req) {
  let entregado = NO_INTERCEPTADO;
  const event = { request: req, respondWith: (p) => { entregado = p; }, waitUntil: () => {} };
  for (const fn of (handlers.fetch || [])) fn(event);
  return entregado === NO_INTERCEPTADO ? NO_INTERCEPTADO : await entregado;
}

// ── LO QUE NO PUEDE PASAR NUNCA ───────────────────────────────────────────────────────
test('sin red y sin cache, una navegación NO contesta undefined', async () => {
  // Éste es el bug exacto que dejó a Santiago afuera.
  const { handlers } = cargar({ red: 'falla', cacheado: {} });
  const r = await responder(handlers, navegacion(U + '/m/ifco'));
  assert.notEqual(r, undefined, 'respondWith(undefined) = ERR_FAILED en el navegador');
  assert.equal(typeof r.status, 'number');
});

test('contesta una página que explica y ofrece reintentar', async () => {
  const { handlers } = cargar({ red: 'falla' });
  const r = await responder(handlers, navegacion(U + '/m/ifco'));
  const txt = await r.text();
  assert.match(txt, /Sin conexión/i);
  assert.match(txt, /Reintentar/);
  // Y que diga que el servidor está bien: si no, el que la ve sale a reportar una caída que
  // no existe, que es la mitad del costo de este tipo de error.
  assert.match(txt, /servidor está andando/i);
  assert.equal(r.status, 503);
});

test('la página de sin conexión no se cachea', async () => {
  // Si se cacheara, quedaría pegada y taparía a la app cuando la señal vuelve.
  const { handlers } = cargar({ red: 'falla' });
  const r = await responder(handlers, navegacion(U + '/m/ifco'));
  assert.match(r.headers.get('Cache-Control') || '', /no-store/);
});

test('un recurso que no está en el cache tampoco puede ser undefined', async () => {
  const { handlers } = cargar({ red: 'falla', cacheado: {} });
  const r = await responder(handlers, recurso(U + '/no-existe.png'));
  assert.notEqual(r, undefined);
  assert.equal(typeof r.status, 'number');
});

test('si el servidor se cuelga, la navegación no espera para siempre', async () => {
  // Un spinner eterno se lee como "la app está rota" igual que un error, pero sin botón.
  const { handlers } = cargar({ red: 'cuelga' });
  const r = await Promise.race([
    responder(handlers, navegacion(U + '/m/ifco')),
    new Promise((res) => setTimeout(() => res('SIGUE-ESPERANDO'), 25000)),
  ]);
  assert.notEqual(r, 'SIGUE-ESPERANDO');
  assert.equal(r.status, 503);
});

// ── LO QUE TIENE QUE SEGUIR ANDANDO ───────────────────────────────────────────────────
test('con red, la navegación se sirve del servidor', async () => {
  const { handlers } = cargar();
  const r = await responder(handlers, navegacion(U + '/m/ifco'));
  assert.equal(r._red, true);
  assert.equal(r.status, 200);
});

test('las llamadas al backend NO se interceptan', async () => {
  // El OCR de un remito puede tardar un minuto y la app sabe explicarlo mejor que el SW.
  // Además, meterle un timeout de navegación cortaría una carga que estaba andando bien.
  const { handlers } = cargar({ red: 'falla' });
  const r = await responder(handlers, llamadaApi(U + '/api/ifco/ocr/remito-super'));
  assert.equal(r, NO_INTERCEPTADO);
});

test('sin red, un recurso guardado se sirve del cache', async () => {
  const { handlers } = cargar({ red: 'falla',
    cacheado: { [U + '/icon-192.png']: { status: 200, _cache: true } } });
  const r = await responder(handlers, recurso(U + '/icon-192.png'));
  assert.equal(r._cache, true);
});

test('sin red, una navegación guardada se sirve del cache antes que la página de error', async () => {
  const { handlers } = cargar({ red: 'falla',
    cacheado: { [U + '/m/ifco']: { status: 200, _cache: true } } });
  const r = await responder(handlers, navegacion(U + '/m/ifco'));
  assert.equal(r._cache, true);
});

test('el POST de un remito no lo toca el SW', async () => {
  const { handlers } = cargar({ red: 'falla' });
  const r = await responder(handlers, { method: 'POST', url: U + '/api/ifco/remitos', headers: { get: () => null } });
  assert.equal(r, NO_INTERCEPTADO);
});

// ── QUE EL ARREGLO LLEGUE A LOS TELÉFONOS ─────────────────────────────────────────────
test('se activa apenas se instala, sin esperar a que cierren la app', async () => {
  // Es un arreglo de algo que dejó la app inservible: esperar a que se cierren todas las
  // pestañas sería dejar a la gente rota un día más.
  const { handlers, self } = cargar();
  for (const fn of (handlers.install || [])) fn({ waitUntil: () => {} });
  assert.equal(self._skip, true, 'no llama a skipWaiting en install');
});

test('el nombre del cache cambió, así que el viejo se limpia', () => {
  // Sin subirlo, el activate no borra nada y puede quedar basura de la versión rota.
  assert.match(SRC, /CACHE_NAME\s*=\s*'lnb-mifco-v[89]\d*'/);
});

test('ninguna rama del fetch puede terminar en caches.match sin respaldo', () => {
  // El grep es tosco pero atrapa la reintroducción del bug: un caches.match() que no venga
  // seguido de un .then que lo respalde es exactamente lo que rompió.
  //
  // Sin los comentarios: el encabezado del archivo NOMBRA la trampa para explicarla, y un
  // grep sobre el texto entero fallaría por la explicación de por qué existe el test.
  const codigo = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const sospechosas = (codigo.match(/caches\.match\([^)]*\)(?!\s*\.then)/g) || []);
  assert.deepEqual(sospechosas, [], 'hay un caches.match sin .then que lo respalde');
});
