// ══ 🐢 CON LA SEÑAL LENTA, SE SIGUE CARGANDO (V1152) ═════════════════════════
//
// Andy, 12/11/2026: «quiero que no se preocupen si hay mala señal. Sigan
// cargando. Sobre todo el peor momento es cuando está lento. Cuando no hay
// internet ya saben que no hay internet».
//
// Sin señal, el pedido FALLA en el acto y la cola lo agarraba. Con señal lenta
// no falla: se queda colgado, y para el navegador eso no es estar offline. Lo
// que se clava acá:
//
//   1. UNA CARGA QUE TARDA SE GUARDA EN EL EQUIPO y la pantalla sigue.
//   2. NO SE DUPLICA aunque haya llegado: el uuid va desde el primer intento.
//   3. LO QUE NO SE PUEDE REPETIR NO SE CORTA: el lote del día espera.
//   4. LA COLA SALE SOLA, sin el evento 'online' que con señal lenta no llega.
//   5. TARDAR NO ES «TRABADO»: el rojo es para lo roto.
//   6. UNA LISTA QUE TARDA MUESTRA LO ÚLTIMO, marcado; sin nada, espera.
//   7. EL PANEL ARRANCA con señal lenta, sin mostrar el menú de otro usuario.
//
// Todo se prueba EJECUTÁNDOLO: la cola y el envoltorio del navegador contra
// una red de mentira que tarda lo que se le pida.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOFF_SRC = fs.readFileSync(path.join(RAIZ, 'src/galponOffline.js'), 'utf8');
const NAV_SRC = fs.readFileSync(path.join(RAIZ, 'src/galponOfflineNav.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const LOGIN = fs.readFileSync(path.join(RAIZ, 'src/login.html'), 'utf8');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const cargarGoff = () => new Function(GOFF_SRC + '\nreturn GOFF;')();

function almacenFalso() {
  const filas = new Map();
  return {
    filas,
    async guardar(f) { filas.set(f.uuid, Object.assign({}, f)); },
    async borrar(uuid) { filas.delete(uuid); },
    async listar() { return [...filas.values()]; },
  };
}

/* Una red que tarda lo que diga `demora` (ms) y que respeta el corte: un
   pedido cortado tira AbortError, como el de verdad. `null` = no contesta. */
function redLenta() {
  const r = {
    demora: 0,
    hay: true,
    pedidos: [],
    cortados: 0,
    responde: (url, opts) => ({ ok: true, status: 200,
      json: async () => ({ ok: true, uuid: JSON.parse(opts.body || '{}').uuid }) }),
    fetch(url, opts) {
      const o = opts || {};
      r.pedidos.push({ url: String(url), metodo: o.method || 'GET', cuerpo: o.body });
      if (!r.hay) return Promise.reject(new TypeError('Failed to fetch'));
      const d = r.demora;
      return new Promise((ok, mal) => {
        if (o.signal) {
          o.signal.addEventListener('abort', () => {
            r.cortados++;
            const e = new Error('The operation was aborted'); e.name = 'AbortError'; mal(e);
          });
        }
        if (d === null) return;
        setTimeout(() => ok(r.responde(url, o)), d);
      });
    },
  };
  return r;
}

const POST = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(b) });
// Esperas chicas para que el test no dure lo que duraría en el galpón.
const RAPIDO = { carga: 40, envio: 80, reintento: 30, reintento_max: 60 };

// ══════════════════════════════════════════════════════════════════════════
// 1 · UNA CARGA QUE TARDA SE GUARDA EN EL EQUIPO
// ══════════════════════════════════════════════════════════════════════════
test('UNA CARGA QUE NO CONTESTA A TIEMPO SE GUARDA Y LA PANTALLA SIGUE', async () => {
  const G = cargarGoff();
  const red = redLenta();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch, esperas: RAPIDO });
  red.demora = null;                         // acepta la conexión y no contesta nunca
  const t0 = Date.now();
  const r = await f('/api/galpon/volcados', POST({ kilos: 450 }));
  assert.ok(Date.now() - t0 < 400, 'se quedó esperando a una red que no contesta');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.encolado, true);
  assert.equal(j.lento, true, 'no avisa que fue por lentitud');
  assert.match(j.aviso, /Señal lenta/);
  assert.equal(j.fila.kilos, 450, 'la pantalla no tiene con qué pintar el renglón');
  assert.equal((await G.pendientes()).length, 1);
  assert.equal((await G.estado()).lenta, true);
});

test('el pedido que tardó se CORTA: no queda ocupando la poca señal', async () => {
  const G = cargarGoff();
  const red = redLenta();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch, esperas: RAPIDO });
  red.demora = null;
  await f('/api/galpon/volcados', POST({ kilos: 1 }));
  assert.equal(red.cortados, 1);
});

test('lo mismo con un proceso: es la otra carga del día', async () => {
  const G = cargarGoff();
  const red = redLenta();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch, esperas: RAPIDO });
  red.demora = null;
  const j = await (await f('/api/galpon/procesos', POST({ bultos: 10 }))).json();
  assert.equal(j.encolado, true);
});

test('con buena señal NADA cambia: la respuesta es la del servidor', async () => {
  const G = cargarGoff();
  const red = redLenta();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch, esperas: RAPIDO });
  red.demora = 5;
  const j = await (await f('/api/galpon/volcados', POST({ kilos: 3 }))).json();
  assert.equal(j.encolado, undefined, 'encoló algo que contestó a tiempo');
  assert.equal((await G.pendientes()).length, 0);
  assert.equal((await G.estado()).lenta, false);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · NO SE DUPLICA AUNQUE HAYA LLEGADO
// ══════════════════════════════════════════════════════════════════════════
test('EL UUID VA DESDE EL PRIMER INTENTO: el reenvío es el mismo pedido', async () => {
  // El pedido cortado pudo haber llegado: el servidor lo grabó y la respuesta
  // se perdió. Si el reenvío llevara un uuid nuevo, esos kilos entrarían dos
  // veces y nadie lo notaría.
  const G = cargarGoff();
  const red = redLenta();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch, esperas: RAPIDO });
  red.demora = null;
  const j = await (await f('/api/galpon/volcados', POST({ kilos: 7 }))).json();
  const primero = JSON.parse(red.pedidos[0].cuerpo);
  assert.ok(primero.uuid, 'el primer intento salió sin uuid');
  assert.equal(primero.uuid, j.uuid, 'lo encolado lleva otro uuid que el que ya salió');
  red.demora = 0;
  await G.mandar();
  const uuids = red.pedidos.map((p) => JSON.parse(p.cuerpo).uuid);
  assert.equal(new Set(uuids).size, 1, 'el reenvío no se reconoce como el mismo');
});

test('y respeta el uuid que ya traía la pantalla', async () => {
  const G = cargarGoff();
  const red = redLenta();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch, esperas: RAPIDO });
  red.demora = null;
  const j = await (await f('/api/galpon/volcados', POST({ kilos: 7, uuid: 'de-la-pantalla' }))).json();
  assert.equal(j.uuid, 'de-la-pantalla');
  assert.equal(JSON.parse(red.pedidos[0].cuerpo).uuid, 'de-la-pantalla');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LO QUE NO SE PUEDE REPETIR NO SE CORTA
// ══════════════════════════════════════════════════════════════════════════
test('EL LOTE DEL DÍA ESPERA A LA SEÑAL: repetirlo es cambiar de lote', async () => {
  const G = cargarGoff();
  const red = redLenta();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch, esperas: RAPIDO });
  red.demora = 150;                          // tarda más que la espera de una carga
  const r = await f('/api/galpon/lote-dia', POST({ lote_id: 3 }));
  const j = await r.json();
  assert.equal(j.encolado, undefined, 'cortó el lote del día por tardar');
  assert.equal(red.cortados, 0);
  assert.equal((await G.pendientes()).length, 0);
});

test('ni cerrar un pallet ni nada que no sea una carga', async () => {
  for (const u of ['/api/galpon/pallets/4/cerrar', '/api/galpon/despachos/2/emitir',
    '/api/galpon/lote-datos']) {
    const G = cargarGoff();
    assert.equal(G.noSeEspera('POST', u), false, u + ' se corta por tardar');
  }
  const G = cargarGoff();
  assert.deepEqual(G.SIN_ESPERAR.map((x) => x.metodo + ' ' + x.re.source),
    ['POST ^\\/api\\/galpon\\/volcados$', 'POST ^\\/api\\/galpon\\/procesos$'],
    'la lista de lo que no se espera cambió: cada una tiene que tener uuid en el servidor');
});

test('y el servidor de verdad reconoce el uuid repetido de las dos', () => {
  // Es la condición para que cortar sea seguro: si el servidor no lo
  // reconociera, el reenvío duplicaría.
  const SERV = fs.readFileSync(path.join(RAIZ, 'src/servicios/galpon.js'), 'utf8');
  assert.match(SERV, /SELECT \* FROM gal_volcados WHERE uuid = \?/);
  assert.match(SERV, /SELECT \* FROM gal_procesos WHERE uuid = \?/);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LA COLA SALE SOLA
// ══════════════════════════════════════════════════════════════════════════
test('LO QUE ENTRÓ POR LENTITUD SALE SOLO, sin que nadie apriete nada', async () => {
  // Con señal lenta el evento 'online' no llega nunca: el navegador cree que
  // está conectado. Esperar el tic de dos minutos es dejar los kilos colgados.
  const G = cargarGoff();
  const red = redLenta();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch, esperas: RAPIDO });
  red.demora = null;
  await f('/api/galpon/volcados', POST({ kilos: 9 }));
  red.demora = 0;                            // la señal mejora
  for (let i = 0; i < 40 && (await G.pendientes()).length; i++) await dormir(20);
  assert.equal((await G.pendientes()).length, 0, 'la cola no salió sola');
  assert.equal((await G.estado()).lenta, false, 'sigue diciendo «lenta» con todo enviado');
});

test('MIENTRAS SIGA LENTA, LO QUE VIENE ENTRA DIRECTO sin esperar otra vez', async () => {
  // Seis segundos por cajón es justo lo que se quería sacar.
  const G = cargarGoff();
  const red = redLenta();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch,
    esperas: Object.assign({}, RAPIDO, { carga: 120, envio: 2000, reintento: 5000 }) });
  red.demora = null;
  await f('/api/galpon/volcados', POST({ kilos: 1 }));
  const t0 = Date.now();
  const j = await (await f('/api/galpon/volcados', POST({ kilos: 2 }))).json();
  assert.ok(Date.now() - t0 < 60, 'la segunda carga volvió a esperar a la red');
  assert.equal(j.encolado, true);
  assert.equal(j.lento, true);
  assert.equal((await G.pendientes()).length, 2);
});

test('sin lentitud reciente se prueba directo, como siempre', async () => {
  // Si la cola tiene algo de un corte de ayer y hoy hay señal, la carga nueva
  // sale y arrastra la cola: no se queda atrás esperando un reintento.
  const G = cargarGoff();
  const red = redLenta();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch, esperas: RAPIDO });
  red.hay = false;
  await f('/api/galpon/volcados', POST({ kilos: 1 }));       // sin red: falla en el acto
  red.hay = true;
  const j = await (await f('/api/galpon/volcados', POST({ kilos: 2 }))).json();
  assert.equal(j.encolado, undefined, 'encoló sin haber visto la señal lenta');
});

test('LO QUE ENTRA MIENTRAS SE MANDA SALE EN LA MISMA VUELTA', async () => {
  const G = cargarGoff();
  const red = redLenta();
  const alm = almacenFalso();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch,
    esperas: Object.assign({}, RAPIDO, { reintento: 5000 }) });
  red.hay = false;
  await f('/api/galpon/volcados', POST({ kilos: 1 }));
  red.hay = true; red.demora = 30;
  const vuelta = G.mandar();
  await dormir(5);
  // Entra por la cola mientras la vuelta está mandando la primera.
  await G.encolar('/api/galpon/volcados', POST({ kilos: 2 }));
  const r = await vuelta;
  assert.equal(r.enviados, 2, 'la que entró durante la vuelta quedó esperando');
  assert.equal(alm.filas.size, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · TARDAR NO ES «TRABADO»
// ══════════════════════════════════════════════════════════════════════════
test('TARDAR NO SUMA INTENTOS: la barra no se pone roja por lentitud', async () => {
  const G = cargarGoff();
  const red = redLenta();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch,
    esperas: Object.assign({}, RAPIDO, { reintento: 5000 }) });
  red.hay = false;
  await f('/api/galpon/volcados', POST({ kilos: 1 }));
  red.hay = true; red.demora = null;
  for (let i = 0; i < 4; i++) await G.mandar();
  const e = await G.estado();
  assert.equal(e.trabados, 0, 'cuatro esperas largas la pintaron de rojo');
  assert.equal(e.lenta, true);
  // Y la falta de red de verdad sí cuenta, como siempre.
  red.hay = false;
  for (let i = 0; i < 3; i++) await G.mandar();
  assert.equal((await G.estado()).trabados, 1);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 y 7 · EL NAVEGADOR: LISTAS Y ARRANQUE
// ══════════════════════════════════════════════════════════════════════════
/* IndexedDB de mentira, con el contrato que usa galponOfflineNav.js. */
function idbFalso() {
  const stores = {};
  return {
    stores,
    open() {
      const req = {};
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: (n) => n in stores },
          createObjectStore(n, o) { stores[n] = { key: o.keyPath, map: new Map() }; },
          transaction(n) {
            const st = stores[n];
            const t = {};
            const fin = () => setTimeout(() => t.oncomplete && t.oncomplete(), 0);
            t.objectStore = () => ({
              put(v) { st.map.set(v[st.key], JSON.parse(JSON.stringify(v))); fin(); return {}; },
              get(k) { const r = { result: st.map.get(k) }; fin(); return r; },
              getAll() { const r = { result: [...st.map.values()] }; fin(); return r; },
              delete(k) { st.map.delete(k); fin(); return {}; },
            });
            return t;
          },
        };
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };
}

/* Monta galponOfflineNav.js de verdad. El reloj de las esperas va 50 veces más
   rápido: los cinco segundos de una lista son 100 ms acá. */
function navegador(opts) {
  const o = opts || {};
  const idb = idbFalso();
  const ls = new Map(Object.entries(o.localStorage || {}));
  const red = { demora: 0, hay: true, pedidos: [],
    cuerpo: (u) => JSON.stringify({ ok: true, de: u, n: red.pedidos.length }) };
  const realFetch = (url) => {
    red.pedidos.push(String(url));
    if (!red.hay) return Promise.reject(new TypeError('Failed to fetch'));
    const d = red.demora;
    return new Promise((ok) => {
      if (d === null) return;
      setTimeout(() => ok(new Response(red.cuerpo(String(url)), { status: 200 })), d);
    });
  };
  const creados = [];
  const window = { fetch: realFetch, addEventListener() {} };
  const document = {
    createElement() { const el = { style: {}, innerHTML: '' }; creados.push(el); return el; },
    body: { appendChild() {} },
    getElementById() { return null; },
  };
  const navigator = { onLine: true };
  const localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, String(v)) };
  const GOFF = cargarGoff();
  const rapido = (fn, ms) => setTimeout(fn, (ms || 0) / 50);
  new Function('window', 'document', 'navigator', 'localStorage', 'indexedDB', 'GOFF',
    'setTimeout', 'clearTimeout', 'setInterval', 'alert', 'Response', NAV_SRC)(
    window, document, navigator, localStorage, idb, GOFF,
    rapido, clearTimeout, () => 0, () => {}, Response);
  return { window, red, idb, creados, ls, GOFF,
    guardado: (u) => idb.stores.lecturas && idb.stores.lecturas.map.get(u) };
}

async function hasta(cond, que) {
  for (let i = 0; i < 100; i++) { if (await cond()) return; await dormir(10); }
  assert.fail('no pasó: ' + que);
}

test('UNA LISTA QUE TARDA MUESTRA LO ÚLTIMO QUE BAJÓ, marcado «lenta»', async () => {
  const n = navegador();
  const U = '/api/galpon/volcados?fecha=2026-11-12';
  await (await n.window.fetch(U)).json();           // con señal: se guarda
  await hasta(() => n.guardado(U), 'se guardó la lectura');
  n.red.demora = null;                              // ahora no contesta
  const t0 = Date.now();
  const j = await (await n.window.fetch(U)).json();
  assert.ok(Date.now() - t0 < 1000, 'se quedó esperando');
  assert.equal(j.de_cache, true);
  assert.equal(j.senal_lenta, true, 'no dice que es por lentitud');
  assert.ok(j.cache_cuando, 'no dice de cuándo es');
});

test('lo que llega TARDE igual actualiza lo guardado', async () => {
  const n = navegador();
  const U = '/api/galpon/stock';
  n.red.demora = 400;                               // 4 «segundos» de galpón > la espera
  await (await n.window.fetch(U)).json();           // sin nada guardado: espera
  await hasta(() => n.guardado(U), 'guardó la respuesta lenta');
});

test('SIN NADA GUARDADO, UNA LISTA LENTA ESPERA a la red: no sale vacía', async () => {
  const n = navegador();
  n.red.demora = 300;                               // más que la espera de una lista
  const j = await (await n.window.fetch('/api/galpon/procesos')).json();
  assert.equal(j.ok, true);
  assert.equal(j.de_cache, undefined, 'inventó una respuesta');
});

test('SIN RED, lo guardado sale en el acto y SIN la marca de lenta', async () => {
  const n = navegador();
  const U = '/api/galpon/pallets';
  await (await n.window.fetch(U)).json();
  await hasta(() => n.guardado(U), 'se guardó');
  n.red.hay = false;
  const j = await (await n.window.fetch(U)).json();
  assert.equal(j.de_cache, true);
  assert.equal(j.senal_lenta, undefined, '«lenta» sin red es mentir: es sin conexión');
});

test('EL PANEL ARRANCA CON SEÑAL LENTA: el usuario y el menú están guardados', async () => {
  const n = navegador();
  for (const u of ['/api/auth/me', '/api/org/sidebar', '/api/usuario/favoritos',
    '/api/org/sociedades']) {
    await (await n.window.fetch(u, { credentials: 'same-origin' })).json();
    await hasta(() => n.guardado(u), 'guardó ' + u);
  }
  n.red.demora = null;
  const j = await (await n.window.fetch('/api/auth/me')).json();
  assert.equal(j.ok, true);
  assert.equal(j.de_cache, true, 'sin el usuario guardado el panel abre sin menú');
});

test('PERO NO EL DE OTRO: lo guardado antes del último ingreso no se usa', async () => {
  const n = navegador();
  await (await n.window.fetch('/api/org/sidebar')).json();
  await hasta(() => n.guardado('/api/org/sidebar'), 'guardó el menú');
  // Entra otra persona en esta PC: login.html deja el sello.
  n.ls.set('lnb_ingreso_en', String(Date.now() + 1000));
  n.red.demora = 300;
  const j = await (await n.window.fetch('/api/org/sidebar')).json();
  assert.equal(j.de_cache, undefined, 'mostró el menú del usuario anterior');
});

test('un «no estás logueado» no se guarda', async () => {
  const n = navegador();
  n.red.cuerpo = () => JSON.stringify({ ok: false, error: 'sin sesión' });
  await (await n.window.fetch('/api/auth/me')).json();
  await dormir(30);
  assert.equal(n.guardado('/api/auth/me'), undefined,
    'servido después, echaría al login justo cuando no hay señal para volver');
});

test('al salir se borra el arranque guardado', async () => {
  const n = navegador();
  await (await n.window.fetch('/api/auth/me')).json();
  await hasta(() => n.guardado('/api/auth/me'), 'guardó');
  await n.window.galOffOlvidarArranque();
  assert.equal(n.guardado('/api/auth/me'), undefined);
});

test('EL RESTO DEL PANEL NI SE TOCA', async () => {
  const n = navegador();
  n.red.demora = 300;
  const j = await (await n.window.fetch('/api/sg/ventas')).json();
  assert.equal(j.de, '/api/sg/ventas');
  await dormir(20);
  assert.equal(n.guardado('/api/sg/ventas'), undefined, 'guardó algo que no es del galpón');
});

test('la barra, pintada: el texto y el color', () => {
  // Se corre pintar() con un estado lento y se mira lo que quedó.
  const i = NAV_SRC.indexOf('  function pintar(e) {');
  const j = NAV_SRC.indexOf('\r\n  }\r\n', i);
  const creados = [];
  const pintar = new Function('document', 'navigator', 'GOFF',
    'var barra = null;\n' + NAV_SRC.slice(i, j + 5) + '\nreturn pintar;')(
    { createElement() { const el = { style: {}, innerHTML: '' }; creados.push(el); return el; },
      body: { appendChild() {} }, getElementById() { return null; } },
    { onLine: true }, {});
  pintar({ pendientes: 3, trabados: 0, lenta: true });
  const b = creados[0];
  assert.match(b.innerHTML, /🐢 <b>Señal lenta\.<\/b>/);
  assert.match(b.innerHTML, /Seguí cargando/);
  assert.equal(b.style.background, '#fef3c7', 'no está en amarillo');
  pintar({ pendientes: 3, trabados: 0, lenta: false });
  assert.match(b.innerHTML, /Conectado/, 'sin lentitud sigue diciendo lenta');
});

// ══════════════════════════════════════════════════════════════════════════
// LA PANTALLA, EL INGRESO Y EL MANUAL
// ══════════════════════════════════════════════════════════════════════════
test('el cartel de la lista dice «Señal lenta» cuando es eso', () => {
  const i = PANEL.indexOf('function galOffCartel(j, dondeId){');
  const j = PANEL.indexOf('\r\n}', i);
  const el = { innerHTML: '' };
  const cartel = new Function('document', PANEL.slice(i, j + 3) + '\nreturn galOffCartel;')(
    { getElementById: () => el });
  cartel({ de_cache: true, senal_lenta: true, cache_cuando: Date.now() }, 'x');
  assert.match(el.innerHTML, /🐢 <b>Señal lenta\.<\/b>/);
  assert.doesNotMatch(el.innerHTML, /Sin conexión/);
  cartel({ de_cache: true, cache_cuando: Date.now() }, 'x');
  assert.match(el.innerHTML, /Sin conexión/);
});

test('el ingreso deja el sello, en los dos caminos que entran', () => {
  const llamadas = LOGIN.match(/marcarIngreso\(\);\r?\n\s*window\.location\.href = res\.redirect_to/g) || [];
  assert.equal(llamadas.length, 2, 'algún camino de ingreso no deja el sello');
  assert.match(LOGIN, /localStorage\.setItem\('lnb_ingreso_en'/);
  assert.match(NAV_SRC, /localStorage\.getItem\('lnb_ingreso_en'/);
});

test('salir del panel borra el arranque guardado', () => {
  const i = PANEL.indexOf('function doLogout() {');
  const cuerpo = PANEL.slice(i, PANEL.indexOf('\r\n}', i));
  assert.match(cuerpo, /galOffOlvidarArranque\(\)/);
  assert.ok(cuerpo.indexOf('galOffOlvidarArranque') < cuerpo.indexOf("fetch('/api/auth/logout'"),
    'se borra después de pedir la salida: si la señal no alcanza, no se borra');
});

const COMUN = (() => {
  const i = PANEL.indexOf('var SG_MANUAL_COMUN =');
  const j = PANEL.indexOf('// Lo que se muestra: el manual del módulo', i);
  return new Function(PANEL.slice(i, j) + '\nreturn SG_MANUAL_COMUN;')();
})();
const dice = (re) => assert.match(COMUN, re, 'el manual no dice: ' + re);

test('MANUAL: la sección lleva su V1152', () => {
  dice(/🐢 Con la señal lenta, se sigue cargando <span class="ver">V1152<\/span>/);
});

test('MANUAL: «no contesta en 6 segundos» es lo que espera la cola', () => {
  dice(/no contesta en 6 segundos se guarda en el/);
  assert.match(GOFF_SRC, /var ESPERAS = \{ carga: 6000,/);
});

test('MANUAL: «a los 10 segundos … hasta cada 30»', () => {
  dice(/vuelve a probar a los 10 segundos/);
  dice(/hasta cada 30/);
  assert.match(GOFF_SRC, /reintento: 10000, reintento_max: 30000 \}/);
});

test('MANUAL: «más de 5 segundos» es lo que espera una lista', () => {
  dice(/tarda más de 5 segundos muestra lo último que bajó/);
  assert.match(NAV_SRC, /var ESPERA_LECTURA = 5000;/);
});

test('MANUAL: «el lote del día sigue esperando» es cierto', () => {
  dice(/el lote del día, cerrar un/);
  const G = cargarGoff();
  assert.equal(G.noSeEspera('POST', '/api/galpon/lote-dia'), false);
});
