// ══ 📴 EL SERVICE WORKER DEL PANEL ══════════════════════════════════════════
//
// Andy, 2/11/2026: «que los chicos puedan cargar info sin necesidad de estar
// conectados». La cola resuelve la pestaña abierta; esto resuelve ABRIR.
//
// Un SW queda INSTALADO en el equipo, así que un error acá no se arregla
// recargando: la página ni llega al servidor. Ya pasó en este repo —
// mifco-sw.js lo tiene escrito: «le pasó a Santiago el 29/8/2026 con el
// servidor sano, contestando en menos de un segundo».
//
// Lo que se clava, en orden de qué duele más:
//
//   1. CONTESTAR undefined. `caches.match()` de algo que no está resuelve a
//      undefined, y `respondWith(undefined)` el navegador lo toma como error
//      de red: «No se puede acceder a este sitio». Con el SW instalado, eso
//      no se arregla recargando y parece que la aplicación se murió.
//   2. SERVIR LA VERSIÓN VIEJA CON SEÑAL. Es la razón por la que mifco-sw.js
//      decidió no cachear HTML. Acá se cachea, así que network-first no es
//      una preferencia: es la condición para que esto sea aceptable.
//   3. CACHEAR LA API. El stock de ayer servido como el de hoy, sin ninguna
//      marca de que es viejo.
//   4. QUEDARSE SIN NADA PORQUE UN ARCHIVO NO ESTÁ. cache.addAll rechaza todo
//      si uno solo falla, y el galpón queda sin un byte guardado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUENTE = fs.readFileSync(path.join(RAIZ, 'src/galpon-sw.js'), 'utf8');

/* El SW se EJECUTA contra un entorno de mentira. Un audit del texto vería
   `caches.match` y no sabría qué pasa cuando devuelve undefined — que es
   exactamente el bug que costó una tarde. */
function montar(opts) {
  const o = opts || {};
  const eventos = {};
  const guardado = new Map(o.guardado || []);
  const puestos = [];

  const self = {
    location: { origin: 'https://panel.test' },
    addEventListener: (n, fn) => { eventos[n] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const caches = {
    async open() {
      return {
        async add(u) {
          if (o.noSePuedeCachear && o.noSePuedeCachear.includes(u)) {
            throw new Error('404');
          }
          guardado.set(u, { url: u, cacheado: true });
        },
        async put(req, res) { puestos.push({ url: req.url || req, res }); },
      };
    },
    async keys() { return [...(o.viejos || []), 'lnb-galpon-v1']; },
    async delete(k) { (o.borrados || []).push(k); return true; },
    async match(req) {
      const u = typeof req === 'string' ? req : req.url;
      const g = guardado.get(u) || guardado.get(new URL(u).pathname);
      return g ? { ok: true, status: 200, delCache: true, url: u } : undefined;
    },
  };

  const pedidos = [];
  const fetch = async (req) => {
    pedidos.push(typeof req === 'string' ? req : req.url);
    if (o.red === 'cae') throw new TypeError('Failed to fetch');
    if (o.red === 'tarda') return new Promise(() => {});   // nunca resuelve
    return { ok: true, status: 200, delServidor: true, clone: () => ({ clonado: true }) };
  };

  const Response = function (cuerpo, init) {
    return { cuerpo, status: (init && init.status) || 200,
             headers: (init && init.headers) || {},
             statusText: (init && init.statusText) || '' };
  };
  const URLc = URL;

  new Function('self', 'caches', 'fetch', 'Response', 'URL', 'setTimeout',
    'clearTimeout', 'Promise', FUENTE)(
    self, caches, fetch, Response, URLc, setTimeout, clearTimeout, Promise);

  return { eventos, guardado, puestos, pedidos, caches, borrados: o.borrados || [] };
}

// Un pedido de mentira, con lo que el SW mira.
const GET = (ruta, modo) => ({ url: 'https://panel.test' + ruta, method: 'GET',
  mode: modo || 'no-cors' });

// Corre el handler de fetch y devuelve con qué contestó.
async function contestar(sw, req) {
  let resp;
  const ev = { request: req, respondWith: (p) => { resp = p; } };
  sw.eventos.fetch(ev);
  return resp === undefined ? undefined : await resp;
}

// ══════════════════════════════════════════════════════════════════════════
// 1 · NUNCA undefined
// ══════════════════════════════════════════════════════════════════════════
test('SIN RED Y SIN NADA GUARDADO, una navegación contesta una PÁGINA', async () => {
  // respondWith(undefined) el navegador lo toma como error de red, y con el
  // SW instalado eso NO se arregla recargando: la página ni llega al
  // servidor y parece que la aplicación se murió.
  const sw = montar({ red: 'cae' });
  const r = await contestar(sw, GET('/panel', 'navigate'));
  assert.ok(r, 'contestó undefined: el navegador muestra ERR_FAILED');
  assert.equal(r.status, 200);
  assert.match(r.cuerpo, /Sin conexión/);
  // Y dice lo único que el operador necesita saber en ese momento.
  assert.match(r.cuerpo, /no se perdió/i,
    'no le dice que lo que cargó está a salvo');
});

test('sin red y sin nada, un RECURSO falla como recurso y no como página', async () => {
  // Devolver el HTML de «sin conexión» en el lugar de un .js lo rompe con un
  // error de sintaxis que no dice nada de lo que pasó.
  const sw = montar({ red: 'cae' });
  const r = await contestar(sw, GET('/static/sidebar-v2.js'));
  assert.ok(r, 'contestó undefined');
  assert.equal(r.status, 504);
  assert.ok(!/<html/.test(String(r.cuerpo || '')), 'devolvió HTML en lugar de un script');
});

test('ninguna rama contesta undefined, con red o sin ella', async () => {
  for (const red of [null, 'cae']) {
    const sw = montar({ red, guardado: [['/panel', { url: '/panel' }]] });
    for (const req of [GET('/panel', 'navigate'), GET('/static/x.js'),
      GET('/static/galponOffline.js'), GET('/noexiste')]) {
      const r = await contestar(sw, req);
      assert.ok(r !== undefined || red === null,
        'contestó undefined con red=' + red + ' en ' + req.url);
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · NETWORK-FIRST: nadie ve la versión vieja con señal
// ══════════════════════════════════════════════════════════════════════════
test('CON SEÑAL GANA EL SERVIDOR, aunque esté guardado', async () => {
  // Es la razón por la que mifco-sw.js decidió no cachear HTML: «los
  // operadores siguen viendo la versión vieja después del deploy». Acá se
  // cachea, así que network-first no es una preferencia — es la condición
  // para que cachear sea aceptable.
  const sw = montar({ guardado: [['https://panel.test/panel', { url: '/panel' }]] });
  const r = await contestar(sw, GET('/panel', 'navigate'));
  assert.equal(r.delServidor, true, 'sirvió el caché teniendo red');
  assert.equal(sw.pedidos.length, 1, 'ni siquiera preguntó al servidor');
});

test('y lo que vuelve del servidor ACTUALIZA lo guardado', async () => {
  // Si no, el caché queda clavado en la primera versión que se bajó y la
  // próxima vez sin señal se abre algo de hace meses.
  const sw = montar({});
  await contestar(sw, GET('/panel', 'navigate'));
  await new Promise((r) => setImmediate(r));
  assert.equal(sw.puestos.length, 1, 'no actualizó el caché');
});

test('SI LA RED TARDA DEMASIADO, sale lo guardado', async () => {
  // El que está parado con un cajón en la balanza no puede mirar un spinner
  // veinte segundos. Una red que acepta la conexión y no contesta nunca es lo
  // normal en el campo, y para el navegador eso NO es estar offline.
  const sw = montar({ red: 'tarda',
    guardado: [['https://panel.test/panel', { url: '/panel' }]] });
  const r = await contestar(sw, GET('/panel', 'navigate'));
  assert.equal(r.delCache, true, 'se quedó esperando a una red que no contesta');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LA API NO SE TOCA
// ══════════════════════════════════════════════════════════════════════════
test('LAS LLAMADAS A LA API NO LAS INTERCEPTA EL SW', async () => {
  // De ésas se ocupa galponOfflineNav.js, que guarda la última respuesta con
  // la MARCA de cuándo se leyó. Un caché acá, sin esa marca, serviría el
  // stock de ayer como si fuera el de hoy.
  const sw = montar({ red: 'cae' });
  assert.equal(await contestar(sw, GET('/api/galpon/stock')), undefined,
    'el SW se metió con la API');
  assert.equal(await contestar(sw, GET('/api/auth/me')), undefined);
});

test('ni los POST, ni lo de otros dominios', async () => {
  const sw = montar({ red: 'cae' });
  const post = { url: 'https://panel.test/panel', method: 'POST', mode: 'cors' };
  assert.equal(await contestar(sw, post), undefined, 'interceptó un POST');
  const afuera = { url: 'https://otro.com/x.js', method: 'GET', mode: 'cors' };
  assert.equal(await contestar(sw, afuera), undefined, 'interceptó otro dominio');
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LA INSTALACIÓN
// ══════════════════════════════════════════════════════════════════════════
test('UN ARCHIVO QUE FALTA NO DEJA AL GALPÓN SIN NADA', async () => {
  // cache.addAll rechaza TODO si uno solo falla. Con addAll, un 404 en un
  // icono deja el panel sin un byte guardado — y nadie se entera hasta el día
  // que se corta la señal.
  const sw = montar({ noSePuedeCachear: ['/static/balanza.js'] });
  let esperado;
  sw.eventos.install({ waitUntil: (p) => { esperado = p; } });
  await esperado;
  assert.ok(sw.guardado.has('/panel'), 'un archivo que falta se llevó puesto el resto');
  assert.ok(sw.guardado.has('/static/galponOffline.js'));
  assert.ok(!sw.guardado.has('/static/balanza.js'));
});

test('el panel y la cola están entre lo que se guarda', async () => {
  // Sin panel.html no hay pantalla; sin galponOffline.js la pantalla abre y
  // no puede encolar nada, que es peor: parece que anda.
  const sw = montar({});
  let esperado;
  sw.eventos.install({ waitUntil: (p) => { esperado = p; } });
  await esperado;
  for (const u of ['/panel', '/static/galponOffline.js', '/static/galponOfflineNav.js',
    '/static/sidebar-v2.js']) {
    assert.ok(sw.guardado.has(u), 'no guarda ' + u);
  }
});

test('al activarse BORRA los cachés viejos', async () => {
  // Si no, cada versión deja el suyo y el equipo del galpón se queda sin
  // espacio — con panel.html pesando 3,6 MB, a la décima versión son 36 MB.
  const borrados = [];
  const sw = montar({ viejos: ['lnb-galpon-v0', 'lnb-mifco-v8'], borrados });
  let esperado;
  sw.eventos.activate({ waitUntil: (p) => { esperado = p; } });
  await esperado;
  assert.ok(borrados.includes('lnb-galpon-v0'), 'dejó el caché de la versión anterior');
  assert.ok(!borrados.includes('lnb-galpon-v1'), 'borró el suyo');
});

test('NO LE BORRA EL CACHÉ AL OTRO SERVICE WORKER', async () => {
  // `caches` es por ORIGEN, no por service worker: borrar todo lo que no sea
  // el mío se lleva puesto lnb-mifco-v8, que es el fallback de las PWA de
  // IFCO — y ellos sí trabajan en el teléfono, donde la señal es peor.
  //
  // Lo encontró la mutación: el assert anterior era `x === true || true`, que
  // pasa siempre, y tapaba exactamente esto.
  const borrados = [];
  const sw = montar({ viejos: ['lnb-mifco-v8', 'lnb-galpon-v0', 'otra-cosa'], borrados });
  let esperado;
  sw.eventos.activate({ waitUntil: (p) => { esperado = p; } });
  await esperado;
  assert.deepEqual(borrados, ['lnb-galpon-v0'],
    'borró cachés que no son suyos: ' + borrados.join(', '));
});
