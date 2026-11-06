// ══ 📲 LA APP DEL CARGADOR, CONTRA EL ROUTER DE VERDAD (V1149) ═══════════════════
//
// galpon_camion.test.mjs prueba las reglas en el servicio. Esto prueba lo que el
// servicio no ve:
//
//   · Que las RUTAS contesten como la pantalla espera: un «no va» es 200 con
//     ok:false —es la respuesta que hay que pintar en rojo, no un error del pedido—
//     y la pregunta de los faltantes también.
//   · Que la PANTALLA, ejecutada, pinte lo que dice el servidor: el <script> de
//     mgalpon-camion.html corre contra un DOM de mentira y un fetch que pega en el
//     router montado en Express. Lo que puede estar mal —que un rojo se pinte verde,
//     que «Agregarlo igual» no mande agregar— se ve idéntico leyendo el código.
//   · Que las piezas de alrededor estén: la ruta /m/galpon-camion, el manifest, el
//     service worker, el permiso y el menú.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
const APP = leer('src/mgalpon-camion.html');

let express = null;
let falta = false;
try {
  express = (await import('express')).default;
  await import('jspdf');
  await import('qrcode');
} catch { falta = 'falta el paquete express (o jspdf/qrcode): corre npm install para que estos tests corran'; }
const t = (nombre, fn) => test(nombre, { skip: falta }, fn);

const F = new Date().toLocaleDateString('en-CA');
const AA = F.slice(2, 4);
const num = (k) => 'PC-' + AA + '-' + String(269 + k).padStart(5, '0');
const ADMIN = { id: 1, nombre: 'Andy', rol: 'admin' };
const CARGADOR = { id: 5, nombre: 'Juan', rol: 'operador' };
const json = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
                       body: JSON.stringify(b) });

// Sólo lo que el galpón LEE de otros módulos. Las tablas gal_* las crea db_galpon.js
// al montar el router: así este test también prueba que la DDL nueva corre.
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sociedades (id INTEGER PRIMARY KEY, nombre TEXT);
    INSERT INTO sociedades (id,nombre) VALUES (7,'Puente Cordón SA');
    CREATE TABLE pa_sectores (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT);
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, sector_id INTEGER,
      finca TEXT, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca) VALUES (10,'Cuadro 3','La Esperanza');
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY, lote_id INTEGER, cultivo TEXT,
      campaña TEXT, es_perenne INTEGER DEFAULT 0);
    CREATE TABLE pa_cuadrillas (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT,
      activo INTEGER DEFAULT 1);
  `);
  return db;
}

async function servidor(db, usuario) {
  const dir = fs.mkdtempSync(path.join(RAIZ, '.tmp-galcam-'));
  for (const d of ['servicios', 'rutas', 'config']) fs.mkdirSync(path.join(dir, d));
  for (const [de, a] of [['src/config', 'config'], ['src/servicios', 'servicios']]) {
    for (const f of fs.readdirSync(path.join(RAIZ, de))) {
      if (f.endsWith('.js')) fs.copyFileSync(path.join(RAIZ, de, f), path.join(dir, a, f));
    }
  }
  fs.copyFileSync(path.join(RAIZ, 'src/rutas/galpon.js'), path.join(dir, 'rutas', 'galpon.js'));
  fs.writeFileSync(path.join(dir, 'servicios', 'db.js'),
    'export default globalThis.__GAL_DB; export const getDb = () => globalThis.__GAL_DB;\n'
    + 'export function rehacerTabla(){}\n', 'utf8');
  globalThis.__GAL_DB = db;
  const mod = await import('file:///' + path.join(dir, 'rutas', 'galpon.js').replace(/\\/g, '/'));
  const svc = await import('file:///' + path.join(dir, 'servicios', 'galpon.js').replace(/\\/g, '/'));
  const app = express();
  app.use(express.json());
  app.use((req, _r, next) => {
    req.cookies = usuario ? { lnb_user: JSON.stringify(usuario) } : {}; next(); });
  app.use('/api/galpon', mod.default);
  const srv = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const url = 'http://127.0.0.1:' + srv.address().port;
  return { svc,
    pegar: (ruta, opts) => fetch(url + '/api/galpon' + ruta, opts),
    cerrar: () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// Cuatro pallets cerrados (269-272) y un despacho de la oficina con los dos primeros.
function cargarCamara(db, svc) {
  db.prepare("INSERT OR REPLACE INTO gal_config (clave,valor) VALUES ('pallet_desde','269'),"
    + " ('pallet_desde_anio', ?)").run(AA);
  const a = svc.guardarPresentacion(db, { nombre: 'Carton Amarilla', destino: 'comercial',
    envase: 'Caja', por_bulto: 1, kg_unidad: 7, calibre: '35-55', categoria: 'I' }).id;
  const ids = [];
  for (let i = 0; i < 4; i++) {
    svc.registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40 + i,
      uuid: 'u' + i });
    const id = svc.palletAbierto(db).id;
    svc.cerrarPallet(db, id, {});
    ids.push(id);
  }
  const d = svc.abrirDespacho(db, { fecha: F, destinatario: 'San Gerónimo',
    patente: 'AB123CD' });
  svc.agregarPalletAlDespacho(db, d.id, ids[0], {});
  svc.agregarPalletAlDespacho(db, d.id, ids[1], {});
  return { d: Number(d.id), ids };
}

// ── LA PANTALLA, EJECUTADA ────────────────────────────────────────────────────────
// Un DOM de mentira: cada id que se pide existe, y guarda lo que se le escribe.
function pantalla(s, usuario) {
  const nodos = {};
  const nodo = (id) => nodos[id] || (nodos[id] = { id, innerHTML: '', textContent: '',
    value: '', className: '', disabled: false, style: { display: '' } });
  const document = { getElementById: nodo };
  const location = { href: '/m/galpon-camion', hash: '' };
  const history = { pushState() {}, replaceState() {}, back() {} };
  const navigator = { vibrate() { return true; } };
  const window = { addEventListener() {} };
  const fetchApp = async (url, opts) => {
    if (url === '/api/auth/me') {
      return { ok: true, status: 200, json: async () => ({ ok: true, user: usuario }) };
    }
    const r = await s.pegar(url.replace(/^\/api\/galpon/, ''), opts);
    const cuerpo = await r.text();
    return { ok: r.ok, status: r.status, json: async () => JSON.parse(cuerpo) };
  };
  const i = APP.indexOf('<script>') + 8;
  const codigo = APP.slice(i, APP.indexOf('</script>', i));
  const f = new Function('document', 'fetch', 'location', 'history', 'navigator', 'window',
    'setTimeout', 'setInterval', 'clearInterval',
    codigo + '\n;return { S, verLista, abrirCamion, leer, agregarIgual, seguir, bajar,'
    + ' darPorCargado, subirTipeado, crearCamion, verNuevo, claseDe };');
  const p = f(document, fetchApp, location, history, navigator, window,
    () => 0, () => 0, () => {});
  return Object.assign(p, { nodos, nodo, location });
}
/* LA APP ARRANCA SOLA y pide la lista: se espera a que haya llegado, no un tiempo fijo.
   Con 30 ms andaba solo y fallaba con la suite entera corriendo en paralelo — un test
   que depende de qué tan cargada está la máquina no es un test. */
const tic = async (p) => {
  for (let k = 0; k < 400 && p.S.camiones === null; k++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(p.S.camiones !== null, 'la app no terminó de arrancar');
};
// El contador vive ADENTRO del cuerpo: el DOM de mentira no parsea innerHTML, así que
// se lee del HTML que la pantalla escribió.
const contador = (p) => (/id="contador">(.*?)<\/div>/.exec(p.nodo('cuerpo').innerHTML) || [])[1] || '';

// ══════════════════════════════════════════════════════════════════════════
// 1 · LAS RUTAS
// ══════════════════════════════════════════════════════════════════════════
t('SIN SESIÓN NO SE LEE NINGÚN CAMIÓN', async () => {
  const s = await servidor(base(), null);
  try {
    assert.equal((await s.pegar('/camion')).status, 401);
    assert.equal((await s.pegar('/camion/1/escanear', json({ numero: '269' }))).status, 401);
  } finally { s.cerrar(); }
});

t('la DDL nueva corre: la tabla del registro y las columnas del cargado', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  try {
    const cols = db.prepare('PRAGMA table_info(gal_despachos)').all().map((c) => c.name);
    for (const c of ['cargado_en', 'cargado_por', 'cargado_por_id', 'cargado_faltan']) {
      assert.ok(cols.includes(c), 'falta la columna ' + c);
    }
    const esc = db.prepare('PRAGMA table_info(gal_camion_escaneos)').all().map((c) => c.name);
    for (const c of ['despacho_id', 'pallet_id', 'numero', 'accion', 'resultado', 'agregado',
                     'usuario']) assert.ok(esc.includes(c), 'falta ' + c + ' en el registro');
  } finally { s.cerrar(); }
});

t('LAS RESPUESTAS QUE SE PINTAN EN ROJO SON 200, no errores', async () => {
  const db = base();
  const s = await servidor(db, CARGADOR);
  try {
    const { d } = cargarCamara(db, s.svc);
    const no = await s.pegar('/camion/' + d + '/escanear', json({ numero: num(2) }));
    assert.equal(no.status, 200);
    const j = await no.json();
    assert.equal(j.ok, false);
    assert.equal(j.resultado, 'no_va');
    assert.equal(j.camion.total, 2, 'la respuesta no trae el camión como quedó');

    await s.pegar('/camion/' + d + '/escanear', json({ numero: num(0) }));
    const c = await s.pegar('/camion/' + d + '/cargado', json({}));
    assert.equal(c.status, 200, 'la pregunta de los faltantes volvió como error');
    assert.equal((await c.json()).necesita_confirmar, 1);

    // Lo que sí es un error del pedido: un despacho que no existe, bajar lo que no subió.
    assert.equal((await s.pegar('/camion/9999')).status, 404);
    assert.equal((await s.pegar('/camion/9999/escanear', json({ numero: '1' }))).status, 404);
    assert.equal((await s.pegar('/camion/' + d + '/bajar', json({ pallet_id: 9999 }))).status, 400);
    // Y quién: el usuario de la sesión, no uno que mande la pantalla.
    await s.pegar('/camion/' + d + '/escanear', json({ numero: num(1), usuario: 'Otro' }));
    const u = db.prepare("SELECT usuario, usuario_id FROM gal_camion_escaneos"
      + " WHERE accion = 'subio' ORDER BY id DESC").get();
    assert.equal(u.usuario, 'Juan');
    assert.equal(u.usuario_id, 5);
  } finally { s.cerrar(); }
});

t('agregar en la culata viaja como agregar:1, y sólo así', async () => {
  const db = base();
  const s = await servidor(db, CARGADOR);
  try {
    const { d } = cargarCamara(db, s.svc);
    // Un «agregar» que no es verdadero no agrega.
    const r0 = await (await s.pegar('/camion/' + d + '/escanear',
      json({ numero: num(2), agregar: 0 }))).json();
    assert.equal(r0.resultado, 'no_va');
    const r1 = await (await s.pegar('/camion/' + d + '/escanear',
      json({ numero: num(2), agregar: 1 }))).json();
    assert.equal(r1.resultado, 'agregado');
    assert.equal(r1.camion.total, 3);
  } finally { s.cerrar(); }
});

t('NUEVO CAMIÓN por la ruta, con lo que falta dicho', async () => {
  const db = base();
  const s = await servidor(db, CARGADOR);
  try {
    const mal = await s.pegar('/camion', json({ destinatario: 'Feria' }));
    assert.equal(mal.status, 400);
    assert.match((await mal.json()).error, /patente/);
    const bien = await (await s.pegar('/camion', json({ destinatario: 'Feria',
      patente: 'aa111bb' }))).json();
    assert.equal(bien.ok, true);
    assert.equal(bien.camion.patente, 'AA111BB');
    const l = await (await s.pegar('/camion')).json();
    assert.ok(l.camiones.some((x) => x.id === bien.id));
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LA PANTALLA
// ══════════════════════════════════════════════════════════════════════════
t('ARRANCA EN LA LISTA DE CAMIONES, con cuántos van arriba', async () => {
  const db = base();
  const s = await servidor(db, CARGADOR);
  try {
    cargarCamara(db, s.svc);
    const p = pantalla(s, CARGADOR);
    await tic(p);
    const h = p.nodo('cuerpo').innerHTML;
    assert.match(h, /San Gerónimo/);
    assert.match(h, />0<small> de 2<\/small>/, 'no dice 0 de 2: ' + h);
    assert.match(h, /Nuevo camión/);
  } finally { s.cerrar(); }
});

t('EL CAMIÓN: el contador, los que faltan y el botón de cargado apagado', async () => {
  const db = base();
  const s = await servidor(db, CARGADOR);
  try {
    const { d } = cargarCamara(db, s.svc);
    const p = pantalla(s, CARGADOR);
    await tic(p);
    await p.abrirCamion(d);
    assert.match(contador(p), /^0<small> de 2<\/small>$/);
    const h = p.nodo('cuerpo').innerHTML;
    assert.match(h, /Faltan · 2/);
    assert.ok(h.includes(num(0)) && h.includes(num(1)));
    assert.match(h, /Carton Amarilla 35-55 · 40/, 'no dice qué lleva cada pallet');
    // Con nada arriba no se puede dar por cargado.
    assert.match(p.nodo('pie').innerHTML, /id="btn-cargado"[^>]*disabled/);
  } finally { s.cerrar(); }
});

t('LEER UNO DE LA LISTA: verde, y el contador avanza', async () => {
  const db = base();
  const s = await servidor(db, CARGADOR);
  try {
    const { d } = cargarCamara(db, s.svc);
    const p = pantalla(s, CARGADOR);
    await tic(p);
    await p.abrirCamion(d);
    await p.leer(num(0), 0);
    assert.equal(p.nodo('res').className, 'on ok');
    assert.match(p.nodo('res').innerHTML, /1 de 2/);
    assert.match(contador(p), /^1<small> de 2/);
    assert.match(p.nodo('cuerpo').innerHTML, /Arriba · 1/);
    assert.match(p.nodo('cuerpo').innerHTML, /Lo bajé/);
    // El mismo dos veces: amarillo, y el contador no se mueve.
    await p.leer(num(0), 0);
    assert.equal(p.nodo('res').className, 'on ya');
    assert.match(contador(p), /^1<small>/);
  } finally { s.cerrar(); }
});

t('UNO QUE NO VA: rojo, frena, y AGREGARLO IGUAL manda agregar', async () => {
  const db = base();
  const s = await servidor(db, CARGADOR);
  try {
    const { d } = cargarCamara(db, s.svc);
    const p = pantalla(s, CARGADOR);
    await tic(p);
    await p.abrirCamion(d);
    await p.leer(num(2), 0);
    const r = p.nodo('res');
    assert.equal(r.className, 'on err');
    assert.match(r.innerHTML, /NO VA EN ESTE CAMIÓN/);
    assert.match(r.innerHTML, /onclick="agregarIgual\(\)"/);
    assert.match(r.innerHTML, /No va — sigo/);
    assert.equal(p.S.camion.total, 2, 'se agregó sin que nadie lo decidiera');

    await p.agregarIgual();
    assert.equal(p.nodo('res').className, 'on ok');
    assert.equal(p.S.camion.total, 3);
    assert.match(p.nodo('cuerpo').innerHTML, /agregado acá/);
  } finally { s.cerrar(); }
});

t('«No va — sigo» no agrega nada', async () => {
  const db = base();
  const s = await servidor(db, CARGADOR);
  try {
    const { d } = cargarCamara(db, s.svc);
    const p = pantalla(s, CARGADOR);
    await tic(p);
    await p.abrirCamion(d);
    await p.leer(num(2), 0);
    p.seguir();
    assert.equal(p.nodo('res').className, '');
    assert.equal(p.S.pendiente, null);
    // Y un «agregar» suelto después no agrega lo que ya se descartó.
    await p.agregarIgual();
    assert.equal((await (await s.pegar('/camion/' + d)).json()).camion.total, 2);
  } finally { s.cerrar(); }
});

t('TIPEADO: «270» sube el PC-AA-00270', async () => {
  const db = base();
  const s = await servidor(db, CARGADOR);
  try {
    const { d } = cargarCamara(db, s.svc);
    const p = pantalla(s, CARGADOR);
    await tic(p);
    await p.abrirCamion(d);
    p.nodo('tipeo').value = '270';
    await p.subirTipeado();
    assert.equal(p.nodo('res').className, 'on ok');
    assert.ok(p.nodo('res').innerHTML.includes(num(1)));
    assert.equal(p.nodo('tipeo').value, '', 'el casillero no se vació para el próximo');
  } finally { s.cerrar(); }
});

t('LO BAJÉ desde la pantalla vuelve a faltar', async () => {
  const db = base();
  const s = await servidor(db, CARGADOR);
  try {
    const { d, ids } = cargarCamara(db, s.svc);
    const p = pantalla(s, CARGADOR);
    await tic(p);
    await p.abrirCamion(d);
    await p.leer(num(0), 0);
    assert.ok(p.nodo('cuerpo').innerHTML.includes('onclick="bajar(' + ids[0] + ')"'));
    await p.bajar(ids[0]);
    assert.match(contador(p), /^0<small> de 2/);
  } finally { s.cerrar(); }
});

t('CAMIÓN CARGADO con faltantes: los nombra, y «Sale sin esos» lo deja escrito', async () => {
  const db = base();
  const s = await servidor(db, CARGADOR);
  try {
    const { d } = cargarCamara(db, s.svc);
    const p = pantalla(s, CARGADOR);
    await tic(p);
    await p.abrirCamion(d);
    await p.leer(num(0), 0);
    await p.darPorCargado(0);
    const r = p.nodo('res');
    assert.match(r.className, /^on ya$/);
    assert.ok(r.innerHTML.includes(num(1)), 'no nombra el que falta');
    assert.match(r.innerHTML, /darPorCargado\(1\)/);
    assert.equal(p.S.camion.cargado, null, 'lo dio por cargado sin preguntar');

    await p.darPorCargado(1);
    assert.match(p.nodo('cuerpo').innerHTML, /Cargado por <b>Juan<\/b>/);
    assert.ok(p.nodo('cuerpo').innerHTML.includes('salió sin ' + num(1)));
  } finally { s.cerrar(); }
});

t('NUEVO CAMIÓN desde la pantalla: sin lista, cada lectura es verde', async () => {
  const db = base();
  const s = await servidor(db, CARGADOR);
  try {
    cargarCamara(db, s.svc);
    const p = pantalla(s, CARGADOR);
    await tic(p);
    p.verNuevo();
    p.nodo('n-dest').value = 'Feria';
    p.nodo('n-pat').value = 'aa111bb';
    p.nodo('n-tra').value = '';
    await p.crearCamion();
    assert.equal(p.S.camion.modo, 'libre');
    await p.leer(num(2), 0);
    assert.equal(p.nodo('res').className, 'on ok', 'en un camión sin lista salió rojo');
    assert.equal(p.S.camion.total, 1);
  } finally { s.cerrar(); }
});

t('EL COLOR: verde sube, amarillo ya estaba, todo lo demás es rojo', () => {
  // Un resultado nuevo que alguien agregue mañana tiene que caer en rojo por defecto:
  // en la culata un verde de más es un pallet que no iba arriba del camión.
  const p = pantalla({ pegar: async () => ({ ok: true, status: 200, text: async () => '{}' }) },
    CARGADOR);
  assert.equal(p.claseDe('subido'), 'ok');
  assert.equal(p.claseDe('agregado'), 'ok');
  assert.equal(p.claseDe('ya_estaba'), 'ya');
  for (const r of ['no_va', 'otro_despacho', 'despachado', 'abierto', 'no_existe',
                   'despacho_cerrado', 'cualquier_cosa_nueva', undefined]) {
    assert.equal(p.claseDe(r), 'err', r + ' no salió rojo');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LAS PIEZAS DE ALREDEDOR
// ══════════════════════════════════════════════════════════════════════════
test('LA APP TIENE SU RUTA, SU MANIFEST Y EL SERVICE WORKER LA CONOCE', () => {
  const idx = leer('src/index.js');
  assert.match(idx, /app\.get\("\/m\/galpon-camion", \(req, res\) => \{/);
  assert.match(idx, /res\.redirect\('\/login\?next=\/m\/galpon-camion'\)/);
  assert.match(idx, /res\.sendFile\(path\.join\(__dirname, "mgalpon-camion\.html"\)\)/);
  assert.match(idx, /app\.get\("\/manifest-mgalpon-camion\.json"/);
  const man = JSON.parse(leer('src/manifest-mgalpon-camion.json'));
  assert.equal(man.start_url, '/m/galpon-camion');
  assert.equal(man.scope, '/m/');
  assert.match(APP, /<link rel="manifest" href="\/manifest-mgalpon-camion\.json">/);
  // El SW trata la app como navegación: si no, un bache de señal la deja en blanco.
  const sw = leer('src/mifco-sw.js');
  assert.match(sw, /url\.pathname === '\/m\/galpon-camion'/);
  assert.match(APP, /navigator\.serviceWorker\.register\('\/mifco-sw\.js', \{ scope: '\/m\/' \}\)/);
  // Sin sesión vuelve a la app, no al panel.
  assert.ok((APP.match(/\/login\?next=\/m\/galpon-camion/g) || []).length >= 2);
});

test('EL PERMISO ES SUYO: galpon-camion, y sólo /camion', () => {
  const pref = leer('src/servicios/ensure_api_prefijos.js');
  assert.match(pref, /\['galpon-camion', 'galpon\/camion'\]/);
  // Ninguna ruta de la app pega fuera de /camion: si lo hiciera, el cargador
  // necesitaría además el permiso de otra pantalla.
  const urls = [...APP.matchAll(/'\/api\/galpon\/([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 4);
  assert.deepEqual([...new Set(urls)], ['camion']);
  assert.match(leer('src/servicios/ensure_modulo_galpon.js'),
    /\['galpon-camion',\s+'📲 Cargar camiones', 706\]/);
});

test('LA PANTALLA DEL PANEL ES LA PUERTA A LA APP', () => {
  const panel = leer('src/panel.html');
  assert.match(panel, /<a class="btn bp" id="gcm-abrir" href="\/m\/galpon-camion"/);
  assert.match(panel, /el\.textContent = location\.origin \+ '\/m\/galpon-camion';/);
});

test('MANUAL: lo que dice es lo que hace el código', () => {
  const panel = leer('src/panel.html');
  const i = panel.indexOf("SG_MANUAL['galpon-camion']");
  assert.ok(i > 0, 'Cargar camiones no tiene «¿Cómo se usa?»');
  const man = panel.slice(i, panel.indexOf('\n};', i)).replace(/'\s*\r?\n\s*\+\s*'/g, '');
  const svc = leer('src/servicios/galpon.js');
  const cuerpo = (firma) => { const k = svc.indexOf(firma); return svc.slice(k, svc.indexOf('\r\n}', k)); };
  // «alcanza con 269 para el PC-26-00269»
  assert.match(man, /alcanza con <b>269<\/b>/);
  assert.match(cuerpo('function numeroLeido('), /if \(\/\^\\d\+\$\/\.test\(s\)\)/);
  // «el mismo tarjetón dos veces no cuenta dos»
  assert.match(man, /El mismo tarjetón dos veces no cuenta dos/);
  assert.match(cuerpo('export function escanearPallet('), /'ya_estaba'/);
  // «otro camión: eso lo cambia la oficina»
  assert.match(man, /lo cambia la oficina, no la culata/);
  // «no emite el remito»
  assert.match(man, /<b>No emite el remito<\/b>/);
  assert.ok(!/emitirDespacho\(/.test(cuerpo('export function marcarCargado(')),
    'marcarCargado emite');
  // «con cajas sueltas no se puede»
  assert.match(man, /Con cajas sueltas no se puede/);
  assert.match(cuerpo('export function marcarCargado('), /if \(c\.piso\.length\)/);
  // «subir o bajar después deshace el cargado»
  assert.match(man, /deshace el «cargado»/);
  assert.match(svc, /function camionTocado\(db, i\) \{/);
  // «en un camión vacío no hay no va»
  assert.match(man, /En un camión que se arrancó <b>vacío<\/b> no hay «no va»/);
  assert.match(cuerpo('export function escanearPallet('), /if \(!dd\.agregar && c\.modo === 'lista'\)/);
  // Con versión.
  assert.match(man, /<span class="ver">V1149<\/span>/);
});
