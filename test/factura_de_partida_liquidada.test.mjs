// ══ LO QUE UNA LIQUIDACIÓN CITA NO SE ANULA: LA FACTURA DEL FLETERO Y DE LA COOPERATIVA (V1049) ══
//
// Pablo, 11/9/2026: «una vez que está liquidado, los documentos asociados no pueden
// eliminarse: no deberíamos poder eliminar una factura de fletero».
//
// La liquidación cita como comprobante la factura del tercero cuyo gasto se le
// descontó al productor. Anularla después dejaba ese papel citando una factura que ya
// no existe. Lo que traba es lo que el PAPEL cita —la copia que guardó al emitirse—, no
// lo que la base diría hoy.
//
// Los tests corren la ruta REAL de anular, la lista REAL, la pantalla REAL y el freno
// REAL de la pantalla de Asientos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const SG = leer('src/rutas/sg.js');
const LIQ = leer('src/rutas/liquidaciones.js');
const PANEL = leer('src/panel.html');

const { comprobantesDeLaPartida, TIPOS_DESCONTABLES } =
  await import(pathToFileURL(path.join(RAIZ, 'src/servicios/sg_gastos_facturados.js')).href);
const { origenDeAsiento } = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/asientos.js')).href);

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
function ruta(firma) {
  const i = SG.indexOf(firma);
  assert.ok(i > 0, 'no está la ruta: ' + firma);
  const j = SG.indexOf('(req, res) => {', i);
  return SG.slice(j, SG.indexOf('\r\n});', j) + 3);
}
const liquidadas = new Function('comprobantesDeLaPartida',
  fuente(SG, 'function partidasLiquidadasDeFacturaGasto(') + '\nreturn partidasLiquidadasDeFacturaGasto;')(comprobantesDeLaPartida);

// ── la base ────────────────────────────────────────────────────────────────
//
// Partida 7 (a pizarra) y partida 8 (precio cerrado). Facturas:
//   900 · descarga de la recepción de la 7
//   901 · flete de salida ADELANTADO del remito 10 (renglón de la 7)
//   902 · flete de salida NUESTRO del remito 11 (renglón de la 7)
//   903 · carga de la cooperativa del remito 10
//   904 · flete de salida adelantado del remito 12 (renglón de la 8, precio cerrado)
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, trazabilidad TEXT, numero TEXT, tipo_precio TEXT, liquidada_en TEXT);
    CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY, oc_id INTEGER);
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, oc_item_id INTEGER);
    CREATE TABLE sg_recepciones (id INTEGER PRIMARY KEY, oc_id INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, numero TEXT, activo INTEGER DEFAULT 1,
      flete_a_cargo TEXT, flete_pagado_por TEXT);
    CREATE TABLE sg_despacho_items (id INTEGER PRIMARY KEY, despacho_id INTEGER, lote_id INTEGER,
      bultos INTEGER, kg_despachados REAL);
    CREATE TABLE sg_gastos_directos (id INTEGER PRIMARY KEY, tipo_gasto TEXT, recepcion_id INTEGER, despacho_id INTEGER,
      proveedor_servicio_id INTEGER DEFAULT 77, monto REAL, estado TEXT DEFAULT 'valorizado', fecha_servicio TEXT,
      activo INTEGER DEFAULT 1);
    CREATE TABLE sg_gasto_flete_lineas (id INTEGER PRIMARY KEY, gasto_id INTEGER, despacho_item_id INTEGER, monto REAL);
    CREATE TABLE sg_proveedores (id INTEGER PRIMARY KEY, razon_social TEXT, cuit TEXT);
    CREATE TABLE sg_facturas_gasto (id INTEGER PRIMARY KEY, proveedor_servicio_id INTEGER, tipo_comprobante TEXT,
      punto_venta INTEGER, numero TEXT, fecha_emision TEXT, cuit_emisor TEXT, neto REAL, iva_monto REAL, total REAL,
      activo INTEGER DEFAULT 1, asiento_id INTEGER, observaciones TEXT, anulada_en TEXT, anulada_por INTEGER,
      circuito TEXT);
    CREATE TABLE sg_factura_gasto_items (id INTEGER PRIMARY KEY, factura_id INTEGER, gasto_id INTEGER);
    CREATE TABLE sg_asientos (id INTEGER PRIMARY KEY, anulado INTEGER DEFAULT 0, anulado_por INTEGER,
      anulado_en TEXT, motivo_anulacion TEXT, ref_compra_id INTEGER, ref_codigo TEXT);
    CREATE TABLE liquidaciones (id INTEGER PRIMARY KEY, oc_id INTEGER, n_liquidacion TEXT, eliminado_en TEXT,
      comprobantes_json TEXT);
    CREATE TABLE liquidacion_partidas (id INTEGER PRIMARY KEY, liquidacion_id INTEGER, oc_id INTEGER);
    INSERT INTO sg_oc (id, trazabilidad, numero, tipo_precio) VALUES (7, '0034.P7', 'OC-7', 'pizarra'),
                                                                     (8, '0034.P8', 'OC-8', 'cerrado');
    INSERT INTO sg_oc_items VALUES (70, 7), (80, 8);
    INSERT INTO sg_lotes VALUES (1, 70), (2, 80);
    INSERT INTO sg_recepciones (id, oc_id) VALUES (55, 7);
    INSERT INTO sg_despachos VALUES (10, 'R-10', 1, 'productor', 'san_geronimo'), (11, 'R-11', 1, 'nosotros', NULL),
                                    (12, 'R-12', 1, 'productor', 'san_geronimo');
    INSERT INTO sg_despacho_items VALUES (101, 10, 1, 10, 100), (111, 11, 1, 10, 100), (121, 12, 2, 10, 100);
    INSERT INTO sg_gastos_directos (id, tipo_gasto, recepcion_id, despacho_id, monto) VALUES
      (1, 'descarga_ingreso', 55, NULL, 500), (2, 'flete_salida', NULL, 10, 3000), (3, 'flete_salida', NULL, 11, 2000),
      (4, 'carga_salida', NULL, 10, 400), (5, 'flete_salida', NULL, 12, 1000);
    INSERT INTO sg_gasto_flete_lineas (gasto_id, despacho_item_id, monto) VALUES (2, 101, 3000), (3, 111, 2000), (5, 121, 1000);
    INSERT INTO sg_proveedores VALUES (77, 'FLETES JUAN SRL', '30-77777777-7');
    INSERT INTO sg_facturas_gasto (id, proveedor_servicio_id, punto_venta, numero, total, activo, asiento_id)
      VALUES (900, 77, 3, '1234', 605, 1, 1), (901, 77, 3, '1235', 3630, 1, NULL), (902, 77, 3, '1236', 2420, 1, NULL),
             (903, 77, 3, '1237', 484, 1, NULL), (904, 77, 3, '1238', 1210, 1, NULL);
    INSERT INTO sg_factura_gasto_items (factura_id, gasto_id) VALUES (900, 1), (901, 2), (902, 3), (903, 4), (904, 5);
    INSERT INTO sg_asientos (id) VALUES (1);
  `);
  db.transaction = (fn) => (...a) => {
    db.exec('BEGIN');
    try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return db;
}
// `citadas`: lo que el papel guardó al emitirse. null = una liquidación de antes de la
// V1046, que no guardó la copia.
const liquidar = (db, oc, { grupo = false, citadas = [] } = {}) => {
  const json = citadas === null ? null : JSON.stringify(citadas.map((f) => ({ factura_id: f, comprobante: 'A ' + f })));
  const id = Number(db.prepare('INSERT INTO liquidaciones (oc_id, n_liquidacion, comprobantes_json) VALUES (?, ?, ?)')
    .run(grupo ? null : oc, 'LIQ-' + oc, json).lastInsertRowid);
  if (grupo) db.prepare('INSERT INTO liquidacion_partidas (liquidacion_id, oc_id) VALUES (?, ?)').run(id, oc);
  return id;
};
const partidas = (db, f) => liquidadas(db, f).map((x) => x.partida);

// ══ 1 · QUÉ FACTURAS TRABA UNA LIQUIDACIÓN ═════════════════════════════════

test('sin liquidar, ninguna factura está trabada', () => {
  const db = base();
  for (const f of [900, 901, 902, 903, 904]) assert.deepEqual(liquidadas(db, f), []);
});

test('la liquidación traba lo que su papel cita; la carga y el flete nuestro, no', () => {
  const db = base();
  liquidar(db, 7, { citadas: [900, 901] });
  assert.deepEqual(partidas(db, 900), ['0034.P7'], 'la descarga que el papel cita se deja anular');
  assert.deepEqual(partidas(db, 901), ['0034.P7'], 'el flete adelantado que el papel cita se deja anular');
  assert.deepEqual(liquidadas(db, 902), [], 'el flete que pagamos nosotros no es de ninguna liquidación');
  assert.deepEqual(liquidadas(db, 903), [], 'la carga de la cooperativa no es de ninguna liquidación');
});

test('lo que el papel NO cita se sigue anulando, aunque hoy la base diga que es de la partida', () => {
  // Un renglón de flete en cero, uno que el cliente devolvió entero, o una factura que
  // llegó después de liquidar: no están en el papel, y trabarlas obligaba a anular una
  // liquidación ajena para corregirlas.
  const db = base();
  liquidar(db, 7, { citadas: [900] });
  assert.deepEqual(liquidadas(db, 901), [], 'traba una factura que la liquidación no cita');
});

test('también si se liquidó en grupo; y con la liquidación anulada, se destraba', () => {
  const db = base();
  const id = liquidar(db, 7, { grupo: true, citadas: [900] });
  assert.deepEqual(partidas(db, 900), ['0034.P7']);
  db.prepare("UPDATE liquidaciones SET eliminado_en = '2026-09-11' WHERE id = ?").run(id);
  assert.deepEqual(liquidadas(db, 900), [], 'la liquidación de grupo anulada sigue trabando');
  // Y la de una sola partida, igual.
  const db2 = base();
  const id2 = liquidar(db2, 7, { citadas: [900] });
  db2.prepare("UPDATE liquidaciones SET eliminado_en = '2026-09-11' WHERE id = ?").run(id2);
  assert.deepEqual(liquidadas(db2, 900), [], 'la liquidación anulada sigue trabando');
});

test('una liquidación de antes de la V1046 se lee como su reimpresión: la descarga sí, el flete de salida no', () => {
  const db = base();
  liquidar(db, 7, { citadas: null });
  assert.deepEqual(partidas(db, 900), ['0034.P7'], 'la reimpresión cita la descarga');
  assert.deepEqual(liquidadas(db, 901), [], 'esas liquidaciones no descontaban el flete de salida');
});

test('la partida dada por liquidada a mano no traba nada: no hay un papel que cite la factura', () => {
  const db = base();
  db.exec("UPDATE sg_oc SET liquidada_en = '2026-09-11' WHERE id = 7");
  assert.deepEqual(liquidadas(db, 900), []);
});

test('una base sin liquidaciones no rompe', () => {
  const db = base();
  db.exec('DROP TABLE liquidacion_partidas; DROP TABLE liquidaciones;');
  assert.deepEqual(liquidadas(db, 900), []);
});

test('la lista lee las liquidaciones de una partida una sola vez, no una por factura', () => {
  const db = base();
  liquidar(db, 7, { citadas: [900, 901] });
  let lecturas = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => { if (/FROM liquidaciones WHERE oc_id = \?/.test(sql)) lecturas++; return prepare(sql); };
  const memo = new Map();
  // Las tres tocan la partida 7.
  for (const f of [900, 901, 903]) liquidadas(db, f, memo);
  assert.equal(lecturas, 1, 'con mil facturas en la lista, mil lecturas de las mismas liquidaciones');
  assert.match(ruta("router.get('/gastos-factura', requireAuth"), /partidasLiquidadasDeFacturaGasto\(db, f\.id, memo\)/);
});

// ══ 2 · LA RUTA DE ANULAR, CORRIDA ═════════════════════════════════════════

function anular(db, id, motivo = 'se cargó mal') {
  const h = new Function('getDb', 'val', 'uid', 'partidasLiquidadasDeFacturaGasto',
    'return ' + ruta("router.post('/gastos-factura/:id/anular'"))(
    () => db, (x) => (x == null || x === '' ? null : String(x).trim()), () => 5, liquidadas);
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  h({ params: { id }, body: { motivo } }, res);
  return res;
}

test('no deja anular la factura que cita una liquidación, y no toca ni la factura ni su asiento', () => {
  const db = base();
  liquidar(db, 7, { citadas: [900] });
  const r = anular(db, 900);
  assert.equal(r.code, 400);
  assert.match(r.body.error, /la cita como comprobante la liquidación de la partida 0034\.P7/);
  assert.match(r.body.error, /primero se anula la liquidación \(y si ya tiene pagos, antes el pago\)/);
  assert.equal(db.prepare('SELECT activo FROM sg_facturas_gasto WHERE id = 900').get().activo, 1);
  assert.equal(db.prepare('SELECT anulado FROM sg_asientos WHERE id = 1').get().anulado, 0);
});

test('la que no cita ninguna liquidación se sigue anulando como siempre', () => {
  const db = base();
  liquidar(db, 7, { citadas: [900] });
  const r = anular(db, 903);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(db.prepare('SELECT activo FROM sg_facturas_gasto WHERE id = 903').get().activo, 0);
  // Y sin liquidar, la de la descarga también, con su asiento.
  const db2 = base();
  assert.equal(anular(db2, 900).code, 200);
  assert.equal(db2.prepare('SELECT anulado FROM sg_asientos WHERE id = 1').get().anulado, 1);
});

test('su asiento tampoco se anula suelto desde Asientos: se anula la factura, que se lo lleva', () => {
  const db = base();
  const o = origenDeAsiento(db, 1);
  assert.ok(o, 'el asiento de una factura de servicio viva se deja anular desde la pantalla de Asientos');
  assert.match(o.error, /Este asiento es de la factura de servicio 3-1234\. No se anula desde acá/);
  db.exec('UPDATE sg_facturas_gasto SET activo = 0 WHERE id = 900');
  assert.equal(origenDeAsiento(db, 1), null, 'anulada la factura, el asiento ya no cuelga de nada');
  // Leída del papel, el número ya trae el punto de venta: no se le pone dos veces.
  db.exec("UPDATE sg_facturas_gasto SET activo = 1, numero = '0003-00001234' WHERE id = 900");
  assert.match(origenDeAsiento(db, 1).error, /la factura de servicio 0003-00001234\. No se anula/);
});

// ══ 3 · LA LISTA Y LA PANTALLA ═════════════════════════════════════════════

test('la lista marca las liquidadas, y la pantalla muestra 🔒 en vez del botón', () => {
  const db = base();
  liquidar(db, 7, { citadas: [900] });
  const h = new Function('getDb', 'partidasLiquidadasDeFacturaGasto', 'return ' + ruta("router.get('/gastos-factura', requireAuth"))(
    () => db, liquidadas);
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  h({ query: { proveedor_servicio_id: '77' } }, res);
  const porId = Object.fromEntries(res.body.data.map((f) => [f.id, f]));
  assert.equal(porId[900].liquidada, 1);
  assert.equal(porId[900].partidas_liquidadas, '0034.P7');
  assert.equal(porId[903].liquidada, 0);

  const tb = { innerHTML: '' };
  const els = { 'sg-fg-yacargadas': { style: {} }, 'sg-fg-yacargadas-tb': tb, 'sg-fg-prov': { value: '77' } };
  new Function('eid', 'api', 'SGFG', 'lnbPuedeAnular', 'esc', 'escH', 'nr', 'sgMoney',
    fuente(PANEL, 'function sgFgYaCargadas(){') + '; sgFgYaCargadas();')(
    (id) => els[id], () => ({ then(cb) { cb({ ok: true, data: res.body.data }); } }), { circuito: null },
    () => true, (x) => String(x), (x) => String(x), (n) => String(n), (n) => '$' + n);
  assert.match(tb.innerHTML, /🔒 liquidada/);
  assert.ok(!/sgFgAnular\(900,/.test(tb.innerHTML), 'ofrece anular una factura que cita una liquidación');
  assert.match(tb.innerHTML, /sgFgAnular\(903,/);
});

// ══ 4 · LOS «¿CÓMO SE USA?» ════════════════════════════════════════════════

const manual = (clave) => {
  const i = PANEL.indexOf('SG_MANUAL.' + clave + ' = {');
  assert.ok(i > 0, 'no está el manual de ' + clave);
  return PANEL.slice(i, PANEL.indexOf('\r\n};', i)).replace(/'\r?\n\s*\+ '/g, '');
};

test('manual de Gastos Directos y de Liquidaciones: lo que una liquidación cita no se anula', () => {
  const G = manual('gastos');
  assert.match(G, /<span class="ver">V1049<\/span> <b>Lo que una liquidación cita no se anula\.<\/b>/);
  assert.match(G, /El papel de una liquidación cita las facturas de la descarga y del flete de entrada de sus partidas, y la del flete de salida que se le adelantó al productor\. Mientras esa liquidación esté viva, la fila muestra <b>🔒 liquidada<\/b> y el sistema no deja anularla/);
  // Y así es: el papel cita TODA descarga y TODO flete de entrada de la partida, se le hayan descontado o no.
  assert.deepEqual([...TIPOS_DESCONTABLES].sort(), ['descarga_ingreso', 'flete_entrada']);
  assert.match(G, /primero se anula la liquidación \(y si ya tiene pagos, antes el pago\)/);
  assert.match(G, /Si la factura de la cooperativa lleva esa descarga junto con cargas, queda trabada entera/);
  assert.match(G, /La que ninguna liquidación cita —la carga sola, el flete de salida que pagamos nosotros, el flete de salida de una partida a precio cerrado— se sigue pudiendo anular/);
  assert.match(G, /<b>el asiento de una factura de servicio no se anula desde Asientos<\/b>: se anula la factura, que se lleva su asiento/);
  const L = manual('liquidaciones');
  assert.match(L, /mientras la liquidación esté viva, <b>esas facturas no se pueden anular<\/b>/);
  // Contra el código: el freno está en la ruta, ANTES de tocar nada; una liquidación con
  // pagos no se anula; y la cooperativa factura la carga y la descarga juntas.
  const a = ruta("router.post('/gastos-factura/:id/anular'");
  assert.ok(a.indexOf('partidasLiquidadasDeFacturaGasto(db, f.id)') > 0);
  assert.ok(a.indexOf('partidasLiquidadasDeFacturaGasto(db, f.id)') < a.indexOf('db.transaction('));
  assert.match(LIQ, /pagados al productor\. Anulá primero el pago\./);
  assert.match(SG, /descarga:\s+\{ tipos: \['descarga_ingreso', 'carga_salida'\]/);
});

test('los manuales no citan una versión que el panel todavía no alcanzó', () => {
  const actual = Number((leer('src/sidebar-v2.js').match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const k of ['gastos', 'liquidaciones']) {
    for (const v of (manual(k).match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
      assert.ok(v <= actual, `el manual de ${k} cita la V${v} y el panel va en la V${actual}`);
    }
  }
});
