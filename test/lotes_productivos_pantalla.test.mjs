// ══ 🌱 EL CONTRATO ENTRE EL ROUTER Y LA PANTALLA DE PRODUCTIVIDAD ══════════
//
// Los tests de lotes_productivos.test.mjs prueban la REGLA con una base armada
// a mano. Éste prueba otra cosa: que el router de verdad devuelva lo que la
// pantalla de verdad espera, y que el trigger que instala db_pa.js sea el que
// está escrito en db_pa.js — no una copia mía en un test.
//
// Es la diferencia que ya costó una pantalla en blanco: el 1/11/2026 el audit
// de panel.html pasaba en verde y la pantalla de Stock tiraba
// «dest.reduce is not a function», porque el front trataba un objeto como un
// array. Un chequeo de sintaxis no ve eso. Ejecutarlo sí.
//
// -- SIN node_modules ESTE ARCHIVO SE SALTEA ENTERO, NO SE CAE -------------
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

let express = null;
let falta = false;
try {
  express = (await import('express')).default;
} catch { falta = 'falta el paquete express: corre npm install para que estos tests corran'; }
const t = (nombre, fn) => test(nombre, { skip: falta }, fn);

// ── La base: sólo lo que la regla toca, más el trigger que instala db_pa.js ──
// No se levanta db_pa.js entero: son miles de líneas de DDL y lo que se prueba
// acá es una ruta. El trigger se LEE del archivo y se ejecuta, así que si
// alguien lo cambia allá, esto corre el cambiado.
function triggerDeDbPa() {
  const src = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_pa.js'), 'utf8');
  const i = src.indexOf('DROP TRIGGER IF EXISTS pa_costo_a_inversion;');
  assert.ok(i > 0, 'db_pa.js ya no instala el trigger pa_costo_a_inversion');
  const fin = src.indexOf('END;', i);
  assert.ok(fin > i, 'el trigger de db_pa.js no cierra con END;');
  return src.slice(i, fin + 4);
}

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_campañas (id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL, tipo TEXT, activa INTEGER DEFAULT 0,
      fecha_inicio TEXT, fecha_fin TEXT);
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
      hectareas REAL, año_plantacion INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT,
      lote_id INTEGER NOT NULL, campaña TEXT NOT NULL, cultivo TEXT,
      es_perenne INTEGER DEFAULT 0, en_desarrollo INTEGER DEFAULT 0,
      productividad_pct INTEGER, UNIQUE(lote_id, campaña));
    CREATE TABLE pa_rubros_contables (id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL, tipo_labor TEXT);
    CREATE TABLE pa_costos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT,
      lote_id INTEGER NOT NULL, campaña_id INTEGER NOT NULL,
      campaña_anual_id INTEGER, campaña_estacional_id INTEGER,
      categoria TEXT NOT NULL, fecha TEXT, monto REAL NOT NULL DEFAULT 0,
      descripcion TEXT, a_inversion INTEGER NOT NULL DEFAULT 0);
  `);
  db.exec(triggerDeDbPa());
  /* La ESTACIONAL activa va PRIMERA a propósito. Si la anual activa fuera la primera
     fila activa, un SELECT que se olvidara el "tipo='anual'" la devolvería igual y el
     test pasaría con el código roto. Así el invierno sale primero y el bug se ve. */
  for (const [n, t2, a] of [['Inv 2026', 'estacional', 1], ['2025/26', 'anual', 0],
    ['2026/27', 'anual', 1]]) {
    db.prepare('INSERT INTO pa_campañas (nombre,tipo,activa) VALUES (?,?,?)').run(n, t2, a);
  }
  db.prepare('INSERT INTO pa_rubros_contables (nombre,tipo_labor) VALUES (?,?)')
    .run('INVERSION', 'otro');
  for (const [id, nom, finca, anio] of [
    [32, '32-39', 'Puente Cordón', 2012],
    [41, '41 Nuevo', 'Puente Cordón', 2024],
    [7, '7 Viejo', 'La Esperanza', 2008]]) {
    db.prepare('INSERT INTO pa_lotes (id,nombre,finca,hectareas,año_plantacion,activo)'
      + ' VALUES (?,?,?,?,?,1)').run(id, nom, finca, 4.5, anio);
  }
  for (const l of [32, 41, 7]) {
    db.prepare('INSERT INTO pa_cultivos_lote (lote_id,campaña,cultivo)'
      + " VALUES (?,'2026/27','Damasco')").run(l);
  }
  return db;
}

// ── El router de verdad ────────────────────────────────────────────────────
async function servidor(db, usuario) {
  const dir = fs.mkdtempSync(path.join(RAIZ, '.tmp-prod-'));
  fs.mkdirSync(path.join(dir, 'servicios'));
  fs.mkdirSync(path.join(dir, 'rutas'));
  fs.mkdirSync(path.join(dir, 'config'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/servicios'))) {
    if (f.endsWith('.js')) {
      fs.copyFileSync(path.join(RAIZ, 'src/servicios', f), path.join(dir, 'servicios', f));
    }
  }
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/config'))) {
    if (f.endsWith('.js')) {
      fs.copyFileSync(path.join(RAIZ, 'src/config', f), path.join(dir, 'config', f));
    }
  }
  fs.copyFileSync(path.join(RAIZ, 'src/rutas/produccion.js'),
    path.join(dir, 'rutas', 'produccion.js'));
  // Los dos módulos que abren la base. db_pa.js corre miles de líneas de DDL al
  // importarse y acá no hace falta: lo que se prueba es la ruta, y el trigger ya
  // se instaló leyéndolo del archivo.
  fs.writeFileSync(path.join(dir, 'servicios', 'db.js'),
    'export default globalThis.__PROD_DB; export const getDb = () => globalThis.__PROD_DB;\n'
    + 'export function rehacerTabla(){}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'servicios', 'db_pa.js'),
    'export default globalThis.__PROD_DB;\n'
    + 'export const getDbPa = () => globalThis.__PROD_DB;\n', 'utf8');
  globalThis.__PROD_DB = db;

  const mod = await import('file:///'
    + path.join(dir, 'rutas', 'produccion.js').replace(/\\/g, '/') + '?t=' + Date.now());
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.cookies = usuario ? { lnb_user: JSON.stringify(usuario) } : {}; next();
  });
  app.use('/api/pa', mod.default);
  const srv = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const url = 'http://127.0.0.1:' + srv.address().port;
  return {
    pegar: (ruta, opts) => fetch(url + '/api/pa' + ruta, opts),
    cerrar: () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const ANDY = { id: 1, nombre: 'Andy', rol: 'admin' };
const json = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
                       body: JSON.stringify(b) });

// ── EL DOM DE MENTIRA ──────────────────────────────────────────────────────
function domFalso() {
  const nodos = {};
  const crear = (id) => ({
    id, innerHTML: '', textContent: '', value: '', options: [],
    style: { display: '' },
    classList: { add() {}, remove() {}, contains: () => false },
  });
  for (const id of ['pa-prod-camp', 'pa-prod-rubro', 'pa-prod-nprod', 'pa-prod-inv',
    'pa-prod-prod', 'pa-prod-sincult', 'pa-prod-tbody', 'pa-prod-detalle',
    'pa-lot-vista-tabla-cont', 'pa-lot-vista-mapa-cont', 'pa-lot-vista-prod-cont',
    'pa-lot-vista-tabla', 'pa-lot-vista-mapa', 'pa-lot-vista-prod']) nodos[id] = crear(id);
  return { nodos, document: { getElementById: (id) => nodos[id] || null } };
}

// El bloque de JS de la pantalla, sacado de panel.html y ejecutado de verdad.
function pantalla(dom, pegar) {
  const marca = PANEL.indexOf('// ── 🌱 QUÉ LOTES PRODUCEN EN ESTA TEMPORADA ─');
  assert.ok(marca > 0, 'no encontré el bloque de productividad en panel.html');
  const fin = PANEL.indexOf('function paProdMarcar(loteId, sel){', marca);
  assert.ok(fin > marca, 'no encontré paProdMarcar');
  const cierre = PANEL.indexOf('\n}', PANEL.indexOf('.catch(function(e){ toast(e.message', fin));
  assert.ok(cierre > fin, 'no encontré el final de paProdMarcar');
  const codigo = PANEL.slice(marca, cierre + 2);

  const avisos = [];
  const f = new Function('document', 'fetch', 'escH', 'paMoney', 'toast', 'paF',
    codigo + '\nreturn { PA_PROD, paProdCargar, paProdPintar, paProdMarcar,'
    + ' paProdPct, paProdVacio };');
  dom.avisos = avisos;
  return f(dom.document,
    (u, o) => pegar(String(u).replace('/api/pa', ''), o),
    (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    (n) => '$' + Math.round(n || 0).toLocaleString('es-AR'),
    (m, k) => avisos.push((k || 'ok') + ': ' + m),
    (u, o) => pegar(String(u).replace('/api/pa', ''), o).then((r) => r.json()));
}

// ══════════════════════════════════════════════════════════════════════════
// 1 · LA RUTA NO LA TAPA /lotes/:id
// ══════════════════════════════════════════════════════════════════════════
t('GET /lotes/productividad NO ENTRA POR /lotes/:id', async () => {
  /* Express se queda con la primera ruta que matchea. Si ésta quedara después,
     '/lotes/productividad' entraría por '/lotes/:id' con id='productividad' y
     devolvería un lote vacío — sin un solo error en el log. */
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    const r = await (await s.pegar('/lotes/productividad')).json();
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.lotes), 'no devolvió la lista de lotes');
    assert.ok(r.campaña, 'no devolvió la temporada');
  } finally { s.cerrar(); }
});

t('sin sesión no contesta', async () => {
  const db = base();
  const s = await servidor(db, null);
  try {
    assert.equal((await s.pegar('/lotes/productividad')).status, 401);
  } finally { s.cerrar(); }
});

t('la temporada por defecto es la ANUAL activa, no la estacional', async () => {
  // 'Inv 2026' también está activa. Si se tomara la primera activa a secas, la
  // pantalla mostraría el invierno y ningún lote tendría cultivo cargado.
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    const r = await (await s.pegar('/lotes/productividad')).json();
    assert.equal(r.campaña.nombre, '2026/27');
    assert.equal(r.campaña.tipo, 'anual');
  } finally { s.cerrar(); }
});

t('el selector sólo ofrece temporadas ANUALES', async () => {
  /* Un lote no es «productivo en el invierno»: la decisión es del año agrícola,
     y es la anual la que el trigger mira. Ofrecer la estacional invitaría a
     marcar algo que no se va a leer nunca. */
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    const r = await (await s.pegar('/lotes/productividad')).json();
    assert.deepEqual(r.campañas.map((c) => c.nombre), ['2026/27', '2025/26']);
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · MARCAR, DESDE LA RUTA
// ══════════════════════════════════════════════════════════════════════════
t('MARCAR «todavía no produce» Y UN GASTO NUEVO SE ACTIVA SOLO', async () => {
  // Punta a punta: la ruta marca, el trigger de db_pa.js clasifica, y la ruta
  // lo devuelve en el resumen. Es el circuito completo del pedido de Andy.
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    const m = await (await s.pegar('/lotes/41/productividad',
      json({ campaña: 3, produce: false }))).json();
    assert.equal(m.ok, true);
    assert.equal(m.a_inversion, 1);
    assert.match(m.aviso, /de ahora en más/, 'no avisa que lo ya imputado no se mueve');

    db.prepare('INSERT INTO pa_costos_lote (lote_id,campaña_id,campaña_anual_id,'
      + "categoria,monto,fecha,descripcion) VALUES (41,3,3,'fertilizante',5000,"
      + "'2026-11-02','Urea')").run();
    db.prepare('INSERT INTO pa_costos_lote (lote_id,campaña_id,campaña_anual_id,'
      + "categoria,monto) VALUES (32,3,3,'cosecha',12000)").run();

    const r = await (await s.pegar('/lotes/productividad?campaña=3')).json();
    assert.equal(r.resumen.inversion, 5000);
    assert.equal(r.resumen.produccion, 12000);
    assert.equal(r.detalle.length, 1);
    assert.equal(r.detalle[0].lote, '41 Nuevo');
    assert.equal(r.detalle[0].descripcion, 'Urea');
  } finally { s.cerrar(); }
});

t('UN COSTO QUE YA TRAE a_inversion=1 NO SE PISA', async () => {
  /* Si algún día hay que forzar la imputación a mano, el trigger no la toca. Se
     prueba acá y no en lotes_productivos.test.mjs porque este archivo corre el
     trigger LEÍDO de db_pa.js: el otro usa una copia a mano, y una copia no se rompe
     cuando alguien cambia el original. Lo encontró la prueba de mutación. */
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    db.prepare('INSERT INTO pa_costos_lote (lote_id,campaña_id,campaña_anual_id,'
      + "categoria,monto,a_inversion) VALUES (32,3,3,'otros',100,1)").run();
    const r = await (await s.pegar('/lotes/productividad?campaña=3')).json();
    assert.equal(r.resumen.inversion, 100, 'el trigger pisó una imputación forzada');
    assert.equal(r.resumen.produccion, 0);
  } finally { s.cerrar(); }
});

t('marcar que produce parcialmente NO activa', async () => {
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    const m = await (await s.pegar('/lotes/7/productividad',
      json({ campaña: 3, produce: true, productividad_pct: 60 }))).json();
    assert.equal(m.a_inversion, 0);
    assert.equal(m.productividad_pct, 60);
    db.prepare('INSERT INTO pa_costos_lote (lote_id,campaña_id,campaña_anual_id,'
      + "categoria,monto) VALUES (7,3,3,'cosecha',9000)").run();
    const r = await (await s.pegar('/lotes/productividad?campaña=3')).json();
    assert.equal(r.resumen.inversion, 0);
  } finally { s.cerrar(); }
});

t('un lote sin cultivo en esa temporada no se puede marcar, y lo dice', async () => {
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    const r = await s.pegar('/lotes/41/productividad', json({ campaña: 1, produce: false }));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /no tiene cultivo cargado/);
  } finally { s.cerrar(); }
});

t('EL RUBRO VIAJE EN LA RESPUESTA: si no existe, la pantalla lo avisa', async () => {
  /* El rubro INVERSION se siembra con el catálogo, pero una base donde no esté
     marcaría los costos y no sabría contra qué imputarlos. Mejor decirlo arriba
     que dejar que alguien descubra el agujero en el balance. */
  const db = base();
  db.exec("DELETE FROM pa_rubros_contables WHERE nombre='INVERSION'");
  const s = await servidor(db, ANDY);
  try {
    const r = await (await s.pegar('/lotes/productividad')).json();
    assert.equal(r.rubro, null);
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · Y LA PANTALLA LO PINTA
// ══════════════════════════════════════════════════════════════════════════
t('LA PANTALLA PINTA LOS TRES LOTES Y MARCA EL ACTIVADO', async () => {
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    await s.pegar('/lotes/41/productividad', json({ campaña: 3, produce: false }));
    const dom = domFalso();
    const p = pantalla(dom, s.pegar);
    await p.paProdCargar();

    const html = dom.nodos['pa-prod-tbody'].innerHTML;
    assert.ok(html.includes('32-39'), 'falta el lote 32-39');
    assert.ok(html.includes('41 Nuevo'), 'falta el lote 41');
    assert.ok(html.includes('7 Viejo'), 'falta el lote 7');
    assert.equal((html.match(/<tr/g) || []).length, 3);
    assert.ok(html.includes('INVERSIÓN'), 'el lote activado no se ve marcado');
    assert.equal((html.match(/INVERSIÓN/g) || []).length, 1, 'se marcó más de uno');
    assert.equal(dom.nodos['pa-prod-nprod'].textContent, '1 de 3');
  } finally { s.cerrar(); }
});

t('EL SELECT DE CADA FILA LLEGA CON SU ESTADO SELECCIONADO', async () => {
  /* Si llegara siempre en «Produce», el que revisa ve todo verde y vuelve a
     marcar lo que ya estaba — que es el mismo bug que tuvo Scout: un formulario
     que conserva lo anterior manda el reporte a la persona equivocada. */
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    await s.pegar('/lotes/41/productividad', json({ campaña: 3, produce: false }));
    await s.pegar('/lotes/7/productividad',
      json({ campaña: 3, produce: true, productividad_pct: 40 }));
    const dom = domFalso();
    const p = pantalla(dom, s.pegar);
    await p.paProdCargar();
    const filas = dom.nodos['pa-prod-tbody'].innerHTML.split('<tr');
    const de = (n) => filas.find((f) => f.includes(n)) || '';
    assert.match(de('41 Nuevo'), /value="nada" selected/);
    assert.match(de('7 Viejo'), /value="parcial" selected/);
    assert.match(de('32-39'), /value="maduro" selected/);
    assert.ok(de('7 Viejo').includes('(40%)'), 'no muestra el % que tiene');
  } finally { s.cerrar(); }
});

t('UN LOTE SIN CULTIVO APARECE, pero sin select', async () => {
  // Aparece para que se vea que falta; sin select para no ofrecer algo que va a
  // rebotar con 400.
  const db = base();
  db.exec("DELETE FROM pa_cultivos_lote WHERE lote_id=41");
  const s = await servidor(db, ANDY);
  try {
    const dom = domFalso();
    const p = pantalla(dom, s.pegar);
    await p.paProdCargar();
    const fila = dom.nodos['pa-prod-tbody'].innerHTML.split('<tr')
      .find((f) => f.includes('41 Nuevo'));
    assert.ok(fila, 'el lote sin cultivo no apareció');
    assert.ok(!fila.includes('<select'), 'ofrece marcar un lote sin cultivo');
    assert.match(fila, /cargá el cultivo primero/);
    assert.equal(dom.nodos['pa-prod-sincult'].textContent, 1);
  } finally { s.cerrar(); }
});

t('EL % SE EDITA DONDE SE LEE, no en un prompt', async () => {
  /* La regla del repo prohíbe el prompt() y acá se ve por qué: no deja ver el
     valor anterior y en el celular tapa la fila. */
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    await s.pegar('/lotes/7/productividad',
      json({ campaña: 3, produce: true, productividad_pct: 40 }));
    const dom = domFalso();
    const p = pantalla(dom, s.pegar);
    await p.paProdCargar();
    const fila = dom.nodos['pa-prod-tbody'].innerHTML.split('<tr')
      .find((f) => f.includes('7 Viejo'));
    assert.match(fila, /<input type="number"[^>]*value="40"/);
    assert.match(fila, /paProdPct\(7,this\)/);

    // Y guarda de verdad.
    await p.paProdPct(7, { value: '75' });
    assert.equal(db.prepare('SELECT productividad_pct AS p FROM pa_cultivos_lote'
      + " WHERE lote_id=7 AND campaña='2026/27'").get().p, 75);
  } finally { s.cerrar(); }
});

t('ELEGIR «todavía no produce» GUARDA Y AVISA QUÉ PASA CON LA PLATA', async () => {
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    const dom = domFalso();
    const p = pantalla(dom, s.pegar);
    await p.paProdCargar();
    await p.paProdMarcar(41, { value: 'nada' });
    assert.equal(db.prepare('SELECT en_desarrollo AS e, productividad_pct AS p'
      + " FROM pa_cultivos_lote WHERE lote_id=41 AND campaña='2026/27'").get().p, 0);
    assert.ok(dom.avisos.some((a) => /INVERSIÓN/.test(a)),
      'no avisó que lo que se cargue va a INVERSIÓN: ' + dom.avisos.join(' | '));
  } finally { s.cerrar(); }
});

t('ELEGIR «produce parcialmente» no pide nada y arranca en 50', async () => {
  /* Un default es mejor que preguntar antes de guardar: el que marca quiere
     decir «todavía no está entero» y el número exacto lo ajusta en el casillero
     que aparece al lado. */
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    const dom = domFalso();
    const p = pantalla(dom, s.pegar);
    await p.paProdCargar();
    await p.paProdMarcar(41, { value: 'parcial' });
    const f = db.prepare('SELECT en_desarrollo AS e, productividad_pct AS p'
      + " FROM pa_cultivos_lote WHERE lote_id=41 AND campaña='2026/27'").get();
    assert.equal(f.e, 1);
    assert.equal(f.p, 50);
  } finally { s.cerrar(); }
});

t('volver a «Produce» apaga en_desarrollo y el % entero', async () => {
  // Dejar un 0 guardado ahí activaría el gasto de un lote recién declarado maduro.
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    const dom = domFalso();
    const p = pantalla(dom, s.pegar);
    await p.paProdCargar();
    await p.paProdMarcar(41, { value: 'nada' });
    await p.paProdMarcar(41, { value: 'maduro' });
    const f = db.prepare('SELECT en_desarrollo AS e, productividad_pct AS p'
      + " FROM pa_cultivos_lote WHERE lote_id=41 AND campaña='2026/27'").get();
    assert.equal(f.e, 0);
    assert.equal(f.p, null);
  } finally { s.cerrar(); }
});

t('LA PANTALLA MUESTRA EL DETALLE DE LO ACTIVADO', async () => {
  // Un total sin detalle no se revisa, y el que firma el balance va a preguntar
  // cuáles son.
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    await s.pegar('/lotes/41/productividad', json({ campaña: 3, produce: false }));
    db.prepare('INSERT INTO pa_costos_lote (lote_id,campaña_id,campaña_anual_id,'
      + "categoria,monto,fecha,descripcion) VALUES (41,3,3,'fertilizante',5000,"
      + "'2026-11-02','Urea granulada')").run();
    const dom = domFalso();
    const p = pantalla(dom, s.pegar);
    await p.paProdCargar();
    const det = dom.nodos['pa-prod-detalle'].innerHTML;
    assert.ok(det.includes('Urea granulada'), 'falta el detalle del gasto activado');
    assert.ok(det.includes('41 Nuevo'));
    assert.ok(det.includes('fertilizante'));
    assert.equal(dom.nodos['pa-prod-inv'].textContent, '$5.000');
  } finally { s.cerrar(); }
});

t('sin gastos todavía, lo dice en vez de quedar en blanco', async () => {
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    await s.pegar('/lotes/41/productividad', json({ campaña: 3, produce: false }));
    const dom = domFalso();
    const p = pantalla(dom, s.pegar);
    await p.paProdCargar();
    assert.match(dom.nodos['pa-prod-detalle'].innerHTML, /Todavía no se cargó/);
  } finally { s.cerrar(); }
});

t('sin ningún lote marcado, el detalle queda callado', async () => {
  // Un cartel que explica algo que no pasó es ruido: la primera vez que se abre
  // la pantalla no hay nada activado y no hace falta decirlo.
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    const dom = domFalso();
    const p = pantalla(dom, s.pegar);
    await p.paProdCargar();
    assert.equal(dom.nodos['pa-prod-detalle'].innerHTML, '');
  } finally { s.cerrar(); }
});

t('EL SELECTOR DE TEMPORADA SE LLENA UNA VEZ Y NO PIERDE LO ELEGIDO', async () => {
  /* Recargarlo en cada guardado volvería a la temporada activa, y el que está
     revisando 2025/26 perdería el lugar en cada clic. */
  const db = base();
  const s = await servidor(db, ANDY);
  try {
    const dom = domFalso();
    const sel = dom.nodos['pa-prod-camp'];
    // Un select de verdad tiene .options; el de mentira se llena a mano al pintar.
    sel.options = [];
    const p = pantalla(dom, s.pegar);
    await p.paProdCargar();
    assert.ok(sel.innerHTML.includes('2026/27'), 'no llenó el selector');
    assert.ok(sel.innerHTML.includes('2025/26'));
    assert.equal(String(sel.value), '3', 'no quedó en la temporada activa');

    sel.options = [{}, {}];      // ya tiene opciones: no se vuelve a llenar
    sel.innerHTML = 'INTACTO';
    sel.value = '2';
    await p.paProdCargar();
    assert.equal(sel.innerHTML, 'INTACTO', 'repintó el selector y perdió lo elegido');
    assert.equal(sel.value, '2');
  } finally { s.cerrar(); }
});
