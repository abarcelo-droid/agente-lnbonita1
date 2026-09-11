// ══ EL FLETE DE SALIDA SE VALORIZA POR PRODUCTO (V1045) ═══════════════════
//
// Pablo, 9/9/2026: «el flete de salida se valoriza por línea de producto, no por
// remito: el monto de flete puede variar dependiendo del producto».
//
// Un camión con tomate y zapallo no cobra lo mismo por cajón. El remito tenía UN
// monto —que además no leía nadie— y la cuenta del fletero se valorizaba con UN
// número por remito: ningún producto sabía cuánto flete le tocó.
//
// Estos tests CORREN el código real —la ruta de valorizar, los renglones que se
// proponen, el reparto, lo que manda la pantalla al guardar— sobre una base en
// memoria. Donde sólo se puede leer el texto, se lee con el signo y el argumento.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const SG = leer('src/rutas/sg.js');
const PANEL = leer('src/panel.html');
const DBSG = leer('src/servicios/db_sg.js');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Una función de nivel superior, sacada del fuente por sus llaves.
function fuente(txt, firma) {
  const i = txt.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  let prof = 0, k = txt.indexOf('{', i);
  for (; k < txt.length; k++) {
    if (txt[k] === '{') prof++;
    else if (txt[k] === '}') { prof--; if (prof === 0) break; }
  }
  return txt.slice(i, k + 1);
}
// El cuerpo de una ruta: desde «(req, res) => {» hasta donde cierra el router.
function ruta(firma) {
  const i = SG.indexOf(firma);
  assert.ok(i > 0, 'no está la ruta: ' + firma);
  const j = SG.indexOf('(req, res) => {', i);
  return SG.slice(j, SG.indexOf('\r\n});', j) + 3);
}
const lineasFleteSalida = new Function('r2',
  fuente(SG, 'function repartirPorBultos(') + '\n' + fuente(SG, 'function lineasFleteSalida(')
  + '\nreturn { repartirPorBultos, lineasFleteSalida };')(r2);

// ── la base ────────────────────────────────────────────────────────────────
function base() {
  const db = new DatabaseSync(':memory:');
  // La tabla nueva, con el DDL REAL de db_sg.js: el UNIQUE es parte de lo que se prueba.
  const i = DBSG.indexOf('CREATE TABLE IF NOT EXISTS sg_gasto_flete_lineas');
  db.exec(DBSG.slice(i, DBSG.indexOf(');', i) + 2));
  db.exec(`
    CREATE TABLE sg_gastos_directos (id INTEGER PRIMARY KEY, tipo_gasto TEXT, despacho_id INTEGER,
      recepcion_id INTEGER, proveedor_servicio_id INTEGER, estado TEXT, monto REAL,
      fecha_valorizacion TEXT, valorizado_por INTEGER, cuenta_ref TEXT, activo INTEGER DEFAULT 1,
      observaciones TEXT, fecha_servicio TEXT, creado_por INTEGER);
    CREATE TABLE sg_recepciones (id INTEGER PRIMARY KEY, oc_id INTEGER, numero_recepcion TEXT,
      fecha_recepcion TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_proveedores (id INTEGER PRIMARY KEY, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, flete_monto REAL);
    CREATE TABLE sg_despacho_items (id INTEGER PRIMARY KEY, despacho_id INTEGER, lote_id INTEGER,
      producto_id INTEGER, bultos INTEGER, kg_despachados REAL, flete_por_bulto REAL);
    CREATE TABLE sg_productos (id INTEGER PRIMARY KEY, nombre TEXT);
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, oc_item_id INTEGER, codigo_lote TEXT, recepcion_id INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY, oc_id INTEGER);
    CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, trazabilidad TEXT, flete_a_cargo TEXT, flete_pagado_por TEXT);
    CREATE TABLE sg_facturas_gasto (id INTEGER PRIMARY KEY, numero TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_factura_gasto_items (id INTEGER PRIMARY KEY, factura_id INTEGER, gasto_id INTEGER);
    INSERT INTO sg_productos VALUES (1,'Tomate'), (2,'Zapallo'), (3,'Morrón');
    INSERT INTO sg_oc (id, trazabilidad) VALUES (7,'0034.17.08.2026.01');
    INSERT INTO sg_oc_items VALUES (70,7);
    INSERT INTO sg_lotes VALUES (1,70,'L-1',NULL,1), (2,NULL,'L-2',NULL,1), (3,NULL,'L-3',NULL,1);
    -- Remito 10: tomate 100 cj a $30 el cajón, zapallo 50 cj a $50. Remito 20: morrón 40 cj.
    INSERT INTO sg_despachos VALUES (10, 5500), (20, NULL);
    INSERT INTO sg_despacho_items VALUES (101,10,1,1,100,1800,30), (102,10,2,2,50,1000,50),
                                         (201,20,3,3,40,400,NULL);
    INSERT INTO sg_gastos_directos (id,tipo_gasto,despacho_id,proveedor_servicio_id,estado)
      VALUES (1,'flete_salida',10,77,'pendiente_valorizar'), (2,'flete_salida',20,77,'pendiente_valorizar');
  `);
  // better-sqlite3 tiene transaction(); node:sqlite no. Mismo contrato: todo o nada.
  db.transaction = (fn) => (...a) => {
    db.exec('BEGIN');
    try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return db;
}

const AYUDAS = new Function(fuente(SG, 'function importeValido(') + '\n' + fuente(SG, 'function facturaVivaDelGasto(')
  + '\n' + fuente(SG, 'function mensajeFacturaViva(')
  + '\nreturn { importeValido, facturaVivaDelGasto, mensajeFacturaViva };')();
function correrRuta(firma, db, req, recalc = () => {}) {
  const h = new Function('getDb', 'val', 'uid', 'r2', 'recalcCostoLote', 'importeValido', 'facturaVivaDelGasto',
    'mensajeFacturaViva', 'return ' + ruta(firma))(
    () => db, (x) => (x == null || x === '' ? null : x), () => 5, r2, recalc,
    AYUDAS.importeValido, AYUDAS.facturaVivaDelGasto, AYUDAS.mensajeFacturaViva);
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  h(req, res);
  return res;
}
const valorizar = (db, body, recalc) => correrRuta("router.post('/gastos-servicio/valorizar'", db, { body }, recalc);
const gasto = (db, id) => db.prepare('SELECT * FROM sg_gastos_directos WHERE id=?').get(id);
const renglones = (db, id) => db.prepare('SELECT despacho_item_id, monto FROM sg_gasto_flete_lineas WHERE gasto_id=? ORDER BY despacho_item_id')
  .all(id).map((x) => [x.despacho_item_id, x.monto]);

// ══ 1 · VALORIZAR, CON LA RUTA REAL ════════════════════════════════════════

test('cada producto con su importe, y el gasto vale la suma — no lo que diga «monto»', () => {
  const db = base();
  const r = valorizar(db, { proveedor_servicio_id: 77, items: [
    { id: 1, monto: 999999, lineas: [{ despacho_item_id: 101, monto: 3000 }, { despacho_item_id: 102, monto: 2500.5 }] }] });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.valorizados, 1);
  assert.equal(gasto(db, 1).estado, 'valorizado');
  assert.equal(gasto(db, 1).monto, 5500.5, 'el total tiene que ser la suma de los productos');
  assert.deepEqual(renglones(db, 1), [[101, 3000], [102, 2500.5]]);
});

test('corregirla reemplaza los renglones, no los suma', () => {
  const db = base();
  const lin = (a, b) => ({ proveedor_servicio_id: 77, items: [
    { id: 1, lineas: [{ despacho_item_id: 101, monto: a }, { despacho_item_id: 102, monto: b }] }] });
  assert.equal(valorizar(db, lin(3000, 2500)).code, 200);
  assert.equal(valorizar(db, lin(2800, 0)).code, 200);
  assert.deepEqual(renglones(db, 1), [[101, 2800], [102, 0]]);
  assert.equal(gasto(db, 1).monto, 2800);
});

test('un remito a medias no se guarda — y no queda nada a medias', () => {
  const casos = [
    [{ despacho_item_id: 101, monto: 3000 }], // falta el zapallo
    [{ despacho_item_id: 101, monto: 3000 }, { despacho_item_id: 102, monto: '' }], // vacío no es cero
    [{ despacho_item_id: 101, monto: 3000 }, { despacho_item_id: 102 }],
    [{ despacho_item_id: 101, monto: 3000 }, { despacho_item_id: 102, monto: -1 }],
    [{ despacho_item_id: 101, monto: 3000 }, { despacho_item_id: 101, monto: 1 }], // dos veces
    [{ despacho_item_id: 101, monto: 3000 }, { despacho_item_id: 201, monto: 1 }], // de otro remito
  ];
  for (const lineas of casos) {
    const db = base();
    const r = valorizar(db, { proveedor_servicio_id: 77, items: [{ id: 1, lineas }] });
    assert.equal(r.code, 400, 'pasó: ' + JSON.stringify(lineas));
    assert.equal(gasto(db, 1).estado, 'pendiente_valorizar');
    assert.equal(gasto(db, 1).monto, null);
    assert.deepEqual(renglones(db, 1), []);
  }
  // Y el repetido que igual «completa» el remito dice lo que pasó: sin el control, la
  // tabla lo rechaza con un error de base que el operador no puede leer.
  const db = base();
  const r = valorizar(db, { proveedor_servicio_id: 77, items: [{ id: 1, lineas: [
    { despacho_item_id: 101, monto: 3000 }, { despacho_item_id: 101, monto: 1 }, { despacho_item_id: 102, monto: 5 }] }] });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /vino dos veces/);
  assert.deepEqual(renglones(db, 1), []);
});

test('el flete de salida sin renglones se rechaza: ya no se valoriza por remito', () => {
  const db = base();
  const r = valorizar(db, { proveedor_servicio_id: 77, items: [{ id: 1, monto: 5000 }] });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /se valoriza por producto/);
  assert.equal(gasto(db, 1).estado, 'pendiente_valorizar');
});

test('todo o nada: si un remito de la cuenta falla, el otro tampoco queda valorizado', () => {
  const db = base();
  const r = valorizar(db, { proveedor_servicio_id: 77, items: [
    { id: 2, lineas: [{ despacho_item_id: 201, monto: 800 }] },
    { id: 1, lineas: [{ despacho_item_id: 101, monto: 3000 }] }] });
  assert.equal(r.code, 400);
  assert.equal(gasto(db, 2).estado, 'pendiente_valorizar', 'quedó valorizado a medias');
  assert.deepEqual(renglones(db, 2), []);
});

test('lo que ya está en una factura viva no se revaloriza; con la factura anulada, sí', () => {
  const db = base();
  const lin = { proveedor_servicio_id: 77, items: [{ id: 2, lineas: [{ despacho_item_id: 201, monto: 800 }] }] };
  assert.equal(valorizar(db, lin).code, 200);
  db.exec("INSERT INTO sg_facturas_gasto VALUES (9, '0003-00001234', 1); INSERT INTO sg_factura_gasto_items VALUES (1, 9, 2);");
  const r = valorizar(db, { proveedor_servicio_id: 77, items: [{ id: 2, lineas: [{ despacho_item_id: 201, monto: 1 }] }] });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /0003-00001234/);
  assert.match(r.body.error, /primero hay que anular esa factura/);
  assert.equal(gasto(db, 2).monto, 800);
  assert.deepEqual(renglones(db, 2), [[201, 800]]);
  db.exec('UPDATE sg_facturas_gasto SET activo=0');
  assert.equal(valorizar(db, { proveedor_servicio_id: 77, items: [{ id: 2, lineas: [{ despacho_item_id: 201, monto: 1 }] }] }).code, 200);
  assert.equal(gasto(db, 2).monto, 1);
});

test('el freno de la factura vale para todos los gastos, no sólo para el flete de salida', () => {
  const db = base();
  db.exec(`INSERT INTO sg_gastos_directos (id,tipo_gasto,recepcion_id,proveedor_servicio_id,estado,monto)
             VALUES (3,'descarga_ingreso',55,77,'valorizado',100);
           INSERT INTO sg_facturas_gasto VALUES (9, 'F-1', 1); INSERT INTO sg_factura_gasto_items VALUES (1, 9, 3);`);
  assert.equal(valorizar(db, { proveedor_servicio_id: 77, items: [{ id: 3, monto: 250 }] }).code, 400);
  assert.equal(gasto(db, 3).monto, 100);
});

test('los demás gastos siguen valorizándose con su monto, y la descarga rehace el costo', () => {
  const db = base();
  db.exec(`INSERT INTO sg_gastos_directos (id,tipo_gasto,recepcion_id,proveedor_servicio_id,estado)
             VALUES (3,'descarga_ingreso',55,77,'pendiente_valorizar');
           INSERT INTO sg_lotes VALUES (9,NULL,'L-9',55,1);`);
  const rehechos = [];
  const r = valorizar(db, { proveedor_servicio_id: 77, items: [{ id: 3, monto: 250 }] }, (_db, id) => rehechos.push(id));
  assert.equal(r.code, 200);
  assert.equal(gasto(db, 3).monto, 250);
  assert.deepEqual(rehechos, [9]);
  assert.deepEqual(renglones(db, 3), []);
});

test('un gasto anulado o de otro fletero no se toca, y no deja renglones', () => {
  const db = base();
  db.exec("UPDATE sg_gastos_directos SET estado='anulado' WHERE id=2");
  const r = valorizar(db, { proveedor_servicio_id: 77, items: [{ id: 2, lineas: [{ despacho_item_id: 201, monto: 5 }] }] });
  assert.equal(r.body.data.valorizados, 0);
  assert.deepEqual(renglones(db, 2), []);
  const r2b = valorizar(db, { proveedor_servicio_id: 88, items: [{ id: 1, lineas: [{ despacho_item_id: 101, monto: 5 }, { despacho_item_id: 102, monto: 5 }] }] });
  assert.equal(r2b.body.data.valorizados, 0);
  assert.deepEqual(renglones(db, 1), []);
});

test('el mismo renglón no puede quedar dos veces en un gasto: lo impide la tabla', () => {
  const db = base();
  db.exec('INSERT INTO sg_gasto_flete_lineas (gasto_id, despacho_item_id, monto) VALUES (1, 101, 1)');
  assert.throws(() => db.exec('INSERT INTO sg_gasto_flete_lineas (gasto_id, despacho_item_id, monto) VALUES (1, 101, 2)'));
});

// ══ 2 · LO QUE SE PROPONE EN CADA RENGLÓN ══════════════════════════════════

const G = (db, id) => gasto(db, id);

test('arranca con lo PACTADO en el remito: cajones por flete por cajón', () => {
  const db = base();
  const ls = lineasFleteSalida.lineasFleteSalida(db, G(db, 1));
  assert.deepEqual(ls.map((l) => [l.despacho_item_id, l.producto_nombre, l.bultos, l.monto, l.valorizado]),
    [[101, 'Tomate', 100, 3000, 0], [102, 'Zapallo', 50, 2500, 0]]);
  assert.equal(ls[0].partida, '0034.17.08.2026.01', 'la partida sale de la orden');
});

test('lo ya valorizado le gana a lo pactado', () => {
  const db = base();
  db.exec("UPDATE sg_gastos_directos SET estado='valorizado', monto=4000 WHERE id=1;"
    + 'INSERT INTO sg_gasto_flete_lineas (gasto_id, despacho_item_id, monto) VALUES (1,101,3500),(1,102,500);');
  const ls = lineasFleteSalida.lineasFleteSalida(db, G(db, 1));
  assert.deepEqual(ls.map((l) => [l.monto, l.valorizado]), [[3500, 1], [500, 1]]);
});

test('lo valorizado ANTES de la V1045, un número por remito, arranca repartido por cajones', () => {
  const db = base();
  db.exec("UPDATE sg_gastos_directos SET estado='valorizado', monto=1000 WHERE id=1");
  const ls = lineasFleteSalida.lineasFleteSalida(db, G(db, 1));
  // 100 y 50 cajones: dos tercios y un tercio, al centavo, y la suma da exacto.
  assert.deepEqual(ls.map((l) => l.monto), [666.67, 333.33]);
  assert.equal(r2(ls.reduce((a, l) => a + l.monto, 0)), 1000);
});

test('el remito viejo, con un solo monto pactado, arranca con ése repartido', () => {
  const db = base();
  db.exec('UPDATE sg_despacho_items SET flete_por_bulto=NULL');
  const ls = lineasFleteSalida.lineasFleteSalida(db, G(db, 1));
  assert.deepEqual(ls.map((l) => l.monto), [3666.67, 1833.33]);
  // Y sin nada pactado, vacío: no se inventa un número.
  assert.deepEqual(lineasFleteSalida.lineasFleteSalida(db, G(db, 2)).map((l) => l.monto), [null]);
});

test('repartir no pierde ni suma un centavo', () => {
  const { repartirPorBultos } = lineasFleteSalida;
  const tres = repartirPorBultos(100, [{ bultos: 1 }, { bultos: 1 }, { bultos: 1 }]);
  assert.deepEqual(tres, [33.33, 33.33, 33.34]);
  const raro = repartirPorBultos(1234.57, [{ bultos: 7 }, { bultos: 13 }, { bultos: 29 }, { bultos: 3 }]);
  assert.equal(r2(raro.reduce((a, x) => a + x, 0)), 1234.57);
  assert.deepEqual(repartirPorBultos(0, [{ bultos: 5 }]), [null]);
  assert.deepEqual(repartirPorBultos(100, [{ bultos: 0 }]), [null]);
});

test('la bandeja manda los renglones sólo del flete de salida, y los cajones de cada remito', () => {
  const h = ruta("router.get('/gastos-servicio'");
  assert.match(h, /\(SELECT COALESCE\(SUM\(bultos\),0\) FROM sg_despacho_items WHERE despacho_id=d\.id\) AS bultos,/);
  assert.match(h, /for \(const g of rows\) if \(g\.tipo_gasto === 'flete_salida' && g\.despacho_id\) g\.lineas = lineasFleteSalida\(db, g\);/);
});

// ══ 3 · EL REMITO: EL FLETE SE PACTA POR RENGLÓN ═══════════════════════════

const POST = (() => {
  const i = SG.indexOf('const postRemito = (req, res) => {');
  return SG.slice(i, SG.indexOf('\r\n};', i));
})();

// El bloque real que arma el flete del remito, corrido con lo que manda la pantalla.
function fleteDelRemito(b, lineas) {
  const i = POST.indexOf('// Y sin fletero no hay flete');
  const fin = POST.indexOf(': (Number(b.flete_monto) > 0 ? Number(b.flete_monto) : null));', i);
  assert.ok(i > 0 && fin > i, 'no está el bloque del flete del remito');
  const codigo = POST.slice(i, fin + ': (Number(b.flete_monto) > 0 ? Number(b.flete_monto) : null));'.length);
  // La regla de quién pone la plata es una flecha sin llaves: se corta en su «;».
  const desde = SG.indexOf('const FLETE_SG_PONE_LA_PLATA =');
  const regla = new Function(SG.slice(desde, SG.indexOf(';', SG.indexOf("quien === 'san_geronimo')", desde)) + 1)
    + '; return FLETE_SG_PONE_LA_PLATA;')();
  const traductor = new Function(fuente(SG, 'function fleteDeRemito(b) {') + '; return fleteDeRemito;')();
  return new Function('b', 'lineas', 'r2', 'FLETE_SG_PONE_LA_PLATA', 'fleteDeRemito',
    codigo + '\nreturn { fleteRemito, lineas };')(b, lineas, r2, regla, traductor);
}

test('el flete del remito es la suma de sus renglones, cajones por flete por cajón', () => {
  const r = fleteDelRemito({ fletero_id: 77, flete_a_cargo: 'nosotros', flete_monto: 999 },
    [{ bultos: 100, fleteBulto: 30 }, { bultos: 50, fleteBulto: 50.5 }, { bultos: 10, fleteBulto: null }]);
  assert.equal(r.fleteRemito, 5525);
  assert.deepEqual(r.lineas.map((l) => l.fleteBulto), [30, 50.5, null]);
});

test('si la plata no es nuestra, o no hay fletero, no queda ningún flete pactado', () => {
  for (const b of [{ fletero_id: 77, flete_a_cargo: 'cliente' },
                   { fletero_id: 77, flete_a_cargo: 'productor', flete_pagado_por: 'productor' },
                   { fletero_id: null, flete_a_cargo: 'nosotros' }]) {
    const r = fleteDelRemito(b, [{ bultos: 100, fleteBulto: 30 }]);
    assert.equal(r.fleteRemito, null, JSON.stringify(b));
    assert.equal(r.lineas[0].fleteBulto, null, 'el renglón se guardaría con flete: ' + JSON.stringify(b));
  }
  // El productor, con el flete adelantado por San Gerónimo, sí: se paga y se recupera.
  const ad = fleteDelRemito({ fletero_id: 77, flete_a_cargo: 'productor', flete_pagado_por: 'san_geronimo' },
    [{ bultos: 10, fleteBulto: 20 }]);
  assert.equal(ad.fleteRemito, 200);
});

test('quien todavía manda un monto suelto sin renglones lo sigue guardando', () => {
  assert.equal(fleteDelRemito({ fletero_id: 77, flete_a_cargo: 'nosotros', flete_monto: 5000 },
    [{ bultos: 10, fleteBulto: null }]).fleteRemito, 5000);
});

test('el renglón guarda su flete: la columna y su valor van juntos, en el mismo lugar', () => {
  const m = POST.match(/INSERT INTO sg_despacho_items\s*\(([^)]*)\)\s*VALUES \(([^)]*)\)/);
  assert.ok(m, 'no está el INSERT del renglón');
  const cols = m[1].split(',').map((x) => x.trim());
  assert.equal(cols.length, m[2].split(',').length, 'columnas y signos de pregunta no coinciden');
  assert.equal(cols[cols.length - 1], 'flete_por_bulto');
  // El último argumento del run es el flete del renglón.
  const i = POST.indexOf('ins.run(despachoId,');
  const run = POST.slice(i, POST.indexOf(');\r\n', i) + 2);
  assert.match(run, /ln\.fleteBulto != null \? ln\.fleteBulto : null\);$/);
  // Y lo que se guarda en el remito es la suma, no el monto que venga.
  assert.match(POST, /flete_a_cargo, flete_pagado_por, flete_monto\)/);
  assert.match(POST, /\/\/ suma de lo pactado en cada renglón: se arma arriba\.\r?\n\s+fleteRemito\);/);
  // Un flete por cajón negativo no entra.
  assert.match(POST, /if \(!\(fleteBulto >= 0\)\) \{\r?\n\s+return res\.status\(400\)/);
  assert.match(DBSG, /addCol\('sg_despacho_items',\s+'flete_por_bulto',\s+'REAL'\)/);
});

test('la ficha del remito da el flete de cada renglón sólo del gasto valorizado y vivo', () => {
  const i = SG.indexOf('// EL FLETE DE CADA PRODUCTO (V1045)');
  const fin = SG.indexOf(': null;', i) + ': null;'.length;
  const codigo = SG.slice(i, fin);
  const correr = (db) => {
    const d = { items: db.prepare('SELECT id FROM sg_despacho_items WHERE despacho_id=10 ORDER BY id').all() };
    new Function('db', 'req', 'd', codigo)(db, { params: { id: 10 } }, d);
    return d.items.map((x) => x.flete_linea);
  };
  const db = base();
  db.exec('INSERT INTO sg_gasto_flete_lineas (gasto_id, despacho_item_id, monto) VALUES (1,101,3000),(1,102,0)');
  assert.deepEqual(correr(db), [null, null], 'un gasto pendiente ya le pone flete al renglón');
  db.exec("UPDATE sg_gastos_directos SET estado='valorizado' WHERE id=1");
  assert.deepEqual(correr(db), [3000, 0]);
  db.exec("UPDATE sg_gastos_directos SET estado='anulado' WHERE id=1");
  assert.deepEqual(correr(db), [null, null], 'un gasto anulado le sigue dejando flete al renglón');
});

// ══ 4 · LA PANTALLA, CORRIDA ═══════════════════════════════════════════════

const FN = (firma) => fuente(PANEL, firma);

test('guardar la cuenta junta los renglones por remito; uno a medias frena y dice cuál', () => {
  const correr = (valItems) => {
    const llamadas = [], toasts = [];
    const SGGD = { valPorLinea: true, valItems, valProv: 77, valRuta: null, valCuerpo: null };
    const api = (url, m, body) => { llamadas.push(body); return { then() {} }; };
    new Function('SGGD', 'api', 'toast', 'closeMB', 'sgGdsLoad', FN('function sgGdsValGuardar(){') + '; sgGdsValGuardar();')(
      SGGD, api, (t) => toasts.push(t), () => {}, () => {});
    return { llamadas, toasts };
  };
  const ok = correr([
    { id: 1, diId: 101, ref: 'R-10', monto: 3000 }, { id: 1, diId: 102, ref: '', monto: 0 },
    { id: 2, diId: 201, ref: 'R-20', monto: '' }]);
  assert.equal(ok.llamadas.length, 1);
  assert.deepEqual(ok.llamadas[0].items, [{ id: 1, lineas: [{ despacho_item_id: 101, monto: 3000 }, { despacho_item_id: 102, monto: 0 }] }],
    'el remito entero va con sus dos renglones —el cero incluido— y el vacío se deja para otra cuenta');
  const medias = correr([{ id: 1, diId: 101, ref: 'R-10', monto: 3000 }, { id: 1, diId: 102, ref: '', monto: '' }]);
  assert.equal(medias.llamadas.length, 0, 'mandó un remito a medias');
  assert.match(medias.toasts[0], /Remito R-10: falta el flete de un producto/);
});

test('el cuadro abre una fila por producto, en cajones, con lo pactado y el remito sólo arriba', () => {
  let opts = null;
  const SGGD = { rows: [{ id: 1, proveedor_servicio_id: 77, fletero_nombre: 'Fletes Juan', despacho_numero: 'R-10',
    cliente_nombre: 'Coto', fecha_despacho: '2026-09-10',
    lineas: [{ despacho_item_id: 101, producto_nombre: 'Tomate', partida: 'P-1', bultos: 100, monto: 3000 },
             { despacho_item_id: 102, producto_nombre: 'Zapallo', partida: null, bultos: 50, monto: null }] }] };
  new Function('SGGD', 'toast', 'sgGdsValAbrir', 'sgGdsLoad',
    FN('function sgGdsValItemsFlete(gastos){') + FN('function sgGdsValOpen(provId){') + '; sgGdsValOpen(77);')(
    SGGD, () => {}, (o) => { opts = o; }, () => {});
  assert.equal(opts.porLinea, true);
  assert.equal(opts.editando, false, 'lo pactado no es una valorización anterior');
  assert.equal(opts.refLbl, 'Remito');
  assert.equal(opts.subLbl, 'Producto');
  assert.deepEqual(opts.items.map((x) => [x.id, x.diId, x.ref, x.base, x.unidadLbl, x.monto]),
    [[1, 101, 'R-10', 100, 'cj', 3000], [1, 102, '', 50, 'cj', null]]);
  assert.match(opts.items[0].sub, /^Tomate · P-1 — Coto$/);
  assert.equal(opts.items[1].sub, 'Zapallo');
});

test('el mismo cuadro vuelve a ser uno por operación para las otras solapas', () => {
  // Lo usan también el flete de entrada y la cooperativa. Si «por renglón» quedara
  // puesto de la cuenta anterior, sus importes viajarían agrupados sin monto y el
  // servidor los rechazaría.
  const ths = { 'sg-val-th-ref': { textContent: '' }, 'sg-val-th-sub': { textContent: '' } };
  const SGGD = {};
  const eid = (id) => ths[id] || { value: '', textContent: '', classList: { add() {} }, style: {} };
  const documento = { querySelector: () => ({ checked: false }) };
  const abrir = new Function('SGGD', 'eid', 'document', 'sgGdsValModo', 'sgGdsLoad',
    FN('function sgGdsValAbrir(opts){') + '; return sgGdsValAbrir;')(SGGD, eid, documento, () => {}, () => {});
  abrir({ prov: 77, porLinea: true, refLbl: 'Remito', subLbl: 'Producto', items: [{ id: 1, diId: 101, base: 100 }] });
  assert.equal(SGGD.valPorLinea, true);
  assert.equal(ths['sg-val-th-ref'].textContent, 'Remito');
  assert.equal(SGGD.valItems[0].diId, 101);
  abrir({ prov: 9, items: [{ id: 5, base: 20, monto: 10 }] });
  assert.equal(SGGD.valPorLinea, false, 'la cuenta de la cooperativa quedó agrupando por renglón');
  assert.equal(ths['sg-val-th-ref'].textContent, 'Partida');
  assert.equal(ths['sg-val-th-sub'].textContent, 'Detalle');
});

test('el renglón del remito calcula su flete y el remito lo suma', () => {
  const linea = new Function(FN('function sgDespFleteLinea(it){') + '; return sgDespFleteLinea;')();
  assert.equal(linea({ flete_bulto: 30, bultos: 100 }), 3000);
  assert.equal(linea({ flete_bulto: 0, bultos: 100 }), 0, 'cero es un flete');
  assert.equal(linea({ flete_bulto: '', bultos: 100 }), null);
  assert.equal(linea({ bultos: 100 }), null);
  const t = FN('function sgDespTotal(){');
  assert.match(t, /\(SG\.despItems \|\| \[\]\)\.forEach\(function\(it\)\{ fl \+= sgDespFleteLinea\(it\) \|\| 0; \}\);/);
});

test('guardar el remito manda el flete de cada renglón sólo si la plata es nuestra', () => {
  const correr = (pide) => {
    let body = null;
    const campos = { 'sg-desp-cli': '5', 'sg-desp-ped': '', 'sg-desp-fecha': '2026-09-11', 'sg-desp-fletero': '77',
      'sg-desp-flete-cargo': 'nosotros', 'sg-desp-flete-quien': 'productor', 'sg-desp-coop': '',
      'sg-desp-chofer': '', 'sg-desp-dominio': '', 'sg-desp-obs': '', 'sg-desp-turno': '', 'sg-desp-occli': '' };
    const SG_ = { despModo: 'normal', despItems: [
      { origen: 'lote', lote_id: 1, bultos: 100, kg: 1800, precio: 10, flete_bulto: 30 },
      { origen: 'lote', lote_id: 2, bultos: 50, kg: 1000, precio: 10, flete_bulto: '' }] };
    new Function('SG', 'eid', 'toast', 'api', 'closeMB', 'sgRemSuperLoad', 'sgLoadDespachos', 'sgDespImprimir',
      'sgDespPorBulto', 'sgDespFletePide', FN('function sgDespGuardar(){') + '; sgDespGuardar();')(
      SG_, (id) => ({ value: campos[id] }), () => {}, (u, m, b) => { body = b; return { then() {} }; },
      () => {}, () => {}, () => {}, () => {}, () => false, () => pide);
    return body;
  };
  const si = correr(true);
  assert.deepEqual(si.items.map((x) => x.flete_por_bulto), [30, null]);
  assert.ok(!('flete_monto' in si), 'volvió a viajar el monto suelto del remito');
  assert.deepEqual(correr(false).items.map((x) => x.flete_por_bulto), [null, null]);
});

test('cambiar a «lo paga el cliente» borra el flete que se había puesto en los renglones', () => {
  const SG_ = { despItems: [{ flete_bulto: 30 }, { flete_bulto: 5 }] };
  const val = { 'sg-desp-fletero': '77', 'sg-desp-flete-cargo': 'cliente', 'sg-desp-flete-quien': 'productor' };
  const el = (id) => (id in val ? { value: val[id] } : { style: {}, innerHTML: '' });
  let render = 0;
  new Function('SG', 'eid', 'sgDespRender', 'SG_DESP_FLETE_AYUDA',
    FN('function sgDespFletePideMonto(cargo, quien){') + FN('function sgDespFleteCargo(){') + '; sgDespFleteCargo();')(
    SG_, el, () => { render++; }, {});
  assert.deepEqual(SG_.despItems.map((x) => x.flete_bulto), ['', '']);
  assert.ok(render > 0, 'los renglones no se redibujan: el casillero queda a la vista');
});

// ══ 5 · EL «¿CÓMO SE USA?» DICE LO QUE EL CÓDIGO HACE ═════════════════════

const manual = (clave) => {
  const i = PANEL.indexOf('SG_MANUAL.' + clave + ' = {');
  assert.ok(i > 0, 'no está el manual de ' + clave);
  return PANEL.slice(i, PANEL.indexOf('\r\n};', i)).replace(/'\r?\n\s*\+ '/g, '');
};

test('manual de Remitos: «el flete se pone por cajón en cada renglón y el del remito es la suma»', () => {
  const M = manual('ventas');
  assert.match(M, /<b>🚚 Flete de cada producto<\/b> <span class="ver">V1045<\/span>/);
  assert.match(M, /<b>Flete de este producto<\/b>, <b>por cajón<\/b>/);
  assert.match(M, /el <b>flete del remito es la suma<\/b>/);
  assert.match(M, /<b>V1045<\/b> — el <b>flete se pone por producto<\/b>/);
  // Código: el casillero del renglón, el total que no se tipea, y la suma en el servidor.
  assert.match(PANEL, /<span style="color:var\(--mut\)">🚚 Flete de este producto<\/span>/);
  assert.ok(!/id="sg-desp-flete-monto"/.test(PANEL), 'volvió el casillero del monto suelto');
  assert.match(PANEL, /<div id="sg-desp-flete-total"/);
  assert.match(POST, /conFlete\.reduce\(\(a, ln\) => a \+ ln\.fleteBulto \* ln\.bultos, 0\)/);
});

test('manual de Gastos Directos: «una fila por producto, en cajones, con lo pactado; entero o nada»', () => {
  const M = manual('gastos');
  assert.match(M, /<h3>🚚 El flete de salida, producto por producto <span class="ver">V1045<\/span><\/h3>/);
  assert.match(M, /abre <b>una fila por producto<\/b> de cada remito, en <b>cajones<\/b>/);
  assert.match(M, /arranca con <b>lo que se pactó en el remito<\/b>/);
  assert.match(M, /lo reparte <b>por cajones<\/b> entre todos los productos/);
  assert.match(M, /Un remito se valoriza <b>entero<\/b>: cada producto con su importe, <b>aunque sea cero<\/b>/);
  assert.match(M, /<b>Lo que ya está en una factura no se revaloriza<\/b> — en ninguna de las solapas/);
  assert.match(M, /arrancan con ese número <b>repartido por cajones<\/b>/);
  // Código, afirmación por afirmación.
  assert.match(FN('function sgGdsValItemsFlete(gastos){'), /base:l\.bultos, unidadLbl:'cj', monto:l\.monto/);
  assert.match(fuente(SG, 'function lineasFleteSalida('),
    /\} else if \(g\.estado === 'valorizado' && Number\(g\.monto\) > 0\) \{\r?\n\s+prop = repartirPorBultos\(g\.monto, filas\);/);
  const v = ruta("router.post('/gastos-servicio/valorizar'");
  assert.match(v, /throw new Error\('Faltan productos del remito: cada renglón lleva su flete, aunque sea cero\.'\);/);
  // El freno de la factura va ANTES de mirar el tipo: vale para todas las solapas.
  assert.match(fuente(SG, 'function facturaVivaDelGasto('), /JOIN sg_facturas_gasto f ON f\.id = fi\.factura_id AND f\.activo = 1/);
  const iFac = v.indexOf('const fac = facturaVivaDelGasto(db, g0.id);');
  assert.ok(iFac > 0, 'la ruta de valorizar no mira la factura');
  assert.ok(iFac < v.indexOf("if (g0 && g0.tipo_gasto === 'flete_salida')"), 'el freno de la factura quedó sólo para el flete de salida');
  // Lo que agregó la revisión.
  assert.match(M, /Uno ya valorizado se corrige con <b>✏️ Editar<\/b>, en <b>Valorizados<\/b>/);
  assert.match(M, /La fila lo dice con <b>🔒<\/b> en vez de ofrecer el botón/);
  assert.match(M, /al centavo: la suma da exacto el total de la cuenta/);
});

test('los manuales no citan una versión que el panel todavía no alcanzó', () => {
  const actual = Number((leer('src/sidebar-v2.js').match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const k of ['ventas', 'gastos']) {
    for (const v of (manual(k).match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
      assert.ok(v <= actual, `el manual de ${k} cita la V${v} y el panel va en la V${actual}`);
    }
  }
});

test('la limpieza del módulo conoce la tabla nueva, antes que los gastos', () => {
  const L = leer('src/servicios/sg_limpieza_mapa.js');
  const a = L.indexOf("tabla: 'sg_gasto_flete_lineas'");
  assert.ok(a > 0, 'la limpieza no borra los renglones del flete');
  assert.ok(a < L.indexOf("tabla: 'sg_gastos_directos'"));
});

// ══ 6 · LO QUE ENCONTRÓ LA REVISIÓN ════════════════════════════════════════

test('fletes de entrada: lo que ya está en una factura viva tampoco se corrige, ni de a uno ni por cuenta', () => {
  const db = base();
  db.exec(`INSERT INTO sg_proveedores VALUES (77, 1);
    INSERT INTO sg_oc (id, trazabilidad) VALUES (8, 'P-8');
    INSERT INTO sg_recepciones VALUES (55, 8, 'R-55', '2026-09-01', 1);
    INSERT INTO sg_gastos_directos (id,tipo_gasto,recepcion_id,proveedor_servicio_id,estado,monto)
      VALUES (4,'flete_entrada',55,77,'valorizado',500);
    INSERT INTO sg_facturas_gasto VALUES (9, 'F-9', 1); INSERT INTO sg_factura_gasto_items VALUES (1, 9, 4);`);
  const deUno = () => correrRuta("router.post('/fletes-entrada/:recepcionId/valorizar'", db,
    { params: { recepcionId: 55 }, body: { monto: 800, proveedor_servicio_id: 77 } });
  const r1 = deUno();
  assert.equal(r1.code, 400);
  assert.match(r1.body.error, /F-9/);
  const r2c = correrRuta("router.post('/fletes-entrada/valorizar-cuenta'", db,
    { body: { proveedor_servicio_id: 77, items: [{ recepcion_id: 55, monto: 800 }] } });
  assert.equal(r2c.code, 400);
  assert.match(r2c.body.error, /primero hay que anular esa factura/);
  assert.equal(gasto(db, 4).monto, 500, 'la factura dice 500 y el gasto quedó en otro número');
  db.exec('UPDATE sg_facturas_gasto SET activo=0');
  assert.equal(deUno().code, 200);
  assert.equal(gasto(db, 4).monto, 800);
});

test('las tres listas dicen si la operación ya está facturada, con la misma condición', () => {
  assert.match(SG, /const SQL_GASTO_FACTURADO = `EXISTS \(SELECT 1 FROM sg_factura_gasto_items fi\s+JOIN sg_facturas_gasto f ON f\.id = fi\.factura_id AND f\.activo = 1\s+WHERE fi\.gasto_id = g\.id\) AS facturada`;/);
  for (const f of ["router.get('/gastos-servicio'", "router.get('/control-coop'", "router.get('/fletes-entrada'"]) {
    assert.match(ruta(f), /\$\{SQL_GASTO_FACTURADO\}/, f + ' no dice si está facturada');
  }
  // Y la condición de la lista es la de la ruta: corrida contra la base.
  const db = base();
  db.exec("UPDATE sg_gastos_directos SET estado='valorizado' WHERE id=1;"
    + "INSERT INTO sg_facturas_gasto VALUES (9, 'F-9', 1), (10, 'F-10', 0);"
    + 'INSERT INTO sg_factura_gasto_items VALUES (1, 9, 1), (2, 10, 2);');
  const sqlF = SG.match(/const SQL_GASTO_FACTURADO = `([\s\S]*?)`;/)[1];
  const fil = db.prepare(`SELECT g.id, ${sqlF} FROM sg_gastos_directos g ORDER BY g.id`).all();
  assert.deepEqual(fil.map((x) => [x.id, x.facturada]), [[1, 1], [2, 0]], 'una factura anulada sigue trabando');
});

test('ninguna lista ofrece corregir lo facturado: muestra 🔒 en su lugar', () => {
  const funcion = (firma) => {
    const i = PANEL.indexOf(firma);
    assert.ok(i > 0, 'no está ' + firma);
    return PANEL.slice(i, PANEL.indexOf('\r\n}', i));
  };
  const casos = [
    ['function sgGdsRenderVal(){', '(g.facturada', '🔒 facturado', 'sgGdsValEditar('],
    ['function sgCcoopRender(){', '(f.facturada', '🔒 facturada', ">✏️ Editar</button>'"],
    ['function sgFePintar(){', '(x.facturada', '🔒 facturado', 'onclick="sgFeOpen('],
  ];
  for (const [f, cond, candado, boton] of casos) {
    const b = funcion(f);
    const i = b.indexOf(cond), j = b.indexOf(candado, i), k = b.indexOf(boton, j);
    assert.ok(i > 0, f + ': no pregunta si está facturada');
    assert.ok(j > i && k > j && k - i < 700, f + ': el botón no quedó del otro lado del candado');
  }
});

test('valorizar por primera vez no se titula «Editar»: lo pactado no es una valorización', () => {
  const titulo = { textContent: '' };
  const eid = (id) => (id === 'sg-val-tit' ? titulo : { value: '', textContent: '', classList: { add() {} }, style: {} });
  const abrir = new Function('SGGD', 'eid', 'document', 'sgGdsValModo', 'sgGdsLoad',
    FN('function sgGdsValAbrir(opts){') + '; return sgGdsValAbrir;')({}, eid, { querySelector: () => ({}) }, () => {}, () => {});
  abrir({ nombre: 'Juan', porLinea: true, editando: false, items: [{ id: 1, monto: 3000 }] });
  assert.equal(titulo.textContent, 'Valorizar cuenta — Juan');
  abrir({ nombre: 'Juan', porLinea: true, editando: true, items: [{ id: 1, monto: 3000 }] });
  assert.equal(titulo.textContent, 'Editar valorización — Juan');
  // Los que no lo dicen siguen como antes: con importe puesto, es corregir.
  abrir({ nombre: 'Coop', items: [{ id: 5, monto: 10 }] });
  assert.equal(titulo.textContent, 'Editar valorización — Coop');
});

test('un flete de salida valorizado se corrige desde Valorizados; facturado, no', () => {
  const correr = (fila) => {
    let opts = null;
    const toasts = [];
    new Function('SGGD', 'toast', 'sgGdsValAbrir', 'sgGdsLoad',
      FN('function sgGdsValItemsFlete(gastos){') + FN('function sgGdsValEditar(gastoId){') + '; sgGdsValEditar(1);')(
      { rows: [fila] }, (t) => toasts.push(t), (o) => { opts = o; }, () => {});
    return { opts, toasts };
  };
  const fila = { id: 1, proveedor_servicio_id: 77, fletero_nombre: 'Juan', despacho_numero: 'R-10', estado: 'valorizado',
    lineas: [{ despacho_item_id: 101, producto_nombre: 'Tomate', bultos: 100, monto: 2800, valorizado: 1 }] };
  const ok = correr(fila);
  assert.equal(ok.opts.editando, true);
  assert.equal(ok.opts.porLinea, true);
  assert.equal(ok.opts.prov, 77);
  assert.deepEqual(ok.opts.items.map((x) => [x.diId, x.monto]), [[101, 2800]]);
  const fac = correr({ ...fila, facturada: 1 });
  assert.equal(fac.opts, null, 'abrió para corregir un flete que ya está en la factura');
  assert.match(fac.toasts[0], /primero anulá la factura/);
});

test('repartir un total en el cuadro da exacto el total, al centavo', () => {
  const correr = (bases, total) => {
    const SGGD = { valItems: bases.map((b) => ({ base: b })) };
    new Function('SGGD', 'eid', 'sgGdsValRender', FN('function sgGdsProrratear(){') + '; sgGdsProrratear();')(
      SGGD, () => ({ value: String(total) }), () => {});
    return SGGD.valItems.map((x) => x.monto);
  };
  assert.deepEqual(correr([1, 1, 1], 100), [33.33, 33.33, 33.34]);
  const raro = correr([7, 13, 29, 3], 1234.57);
  assert.equal(r2(raro.reduce((a, x) => a + x, 0)), 1234.57);
  assert.deepEqual(correr([0, 0], 100), [0, 0]);
});

test('un flete pactado en cero también se propone: cero no es «no se dijo»', () => {
  const db = base();
  db.exec('UPDATE sg_despacho_items SET flete_por_bulto=0 WHERE despacho_id=10');
  assert.deepEqual(lineasFleteSalida.lineasFleteSalida(db, G(db, 1)).map((l) => l.monto), [0, 0]);
});

test('los importes raros no entran: infinito, verdadero, texto, un renglón vacío', () => {
  for (const monto of ['Infinity', true, 'abc', '  ']) {
    const db = base();
    const r = valorizar(db, { proveedor_servicio_id: 77, items: [{ id: 1, lineas: [
      { despacho_item_id: 101, monto }, { despacho_item_id: 102, monto: 5 }] }] });
    assert.equal(r.code, 400, 'entró ' + JSON.stringify(monto));
    assert.deepEqual(renglones(db, 1), []);
  }
  const db = base();
  const r = valorizar(db, { proveedor_servicio_id: 77, items: [{ id: 1, lineas: [null, { despacho_item_id: 102, monto: 5 }] }] });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /vino vacío/);
  // Y el flete por cajón del remito, con el mismo criterio.
  const i = POST.indexOf('      let fleteBulto = null;');
  const codigo = POST.slice(i, POST.indexOf('      pedidoLote[loteId] =', i));
  const correr = (v) => new Function('it', 'loteId', 'res', 'importeValido', codigo + '\nreturn { fleteBulto };')(
    { flete_por_bulto: v }, 3,
    { code: 200, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } },
    AYUDAS.importeValido);
  for (const v of ['abc', 'Infinity', -1, true]) assert.equal(correr(v).code, 400, 'entró ' + JSON.stringify(v));
  assert.deepEqual(correr('12.5'), { fleteBulto: 12.5 });
  assert.deepEqual(correr(0), { fleteBulto: 0 });
  assert.deepEqual(correr(''), { fleteBulto: null });
});
