// ══ EL FLETE DE SALIDA QUE SAN GERÓNIMO LE ADELANTA AL PRODUCTOR (V1046) ════
//
// Pablo, 11/9/2026: «punto 1 OK avanzar». El remito ofrecía «flete a cargo del
// productor, lo adelanta San Gerónimo», la pantalla decía «se le descuenta de su
// liquidación» y ninguna liquidación lo descontaba: se le pagaba al fletero y la
// plata no volvía. Y el margen del remito lo restaba como costo nuestro.
//
// Estos tests corren el código REAL: los servicios importados tal cual, el freno
// de liquidar sobre una partida terminada en memoria, y los trozos de pantalla y
// de router que deciden cuánto se descuenta y qué frena.
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
const PANEL = leer('src/panel.html');
const LIQ = leer('src/rutas/liquidaciones.js');
const SERV_GF = leer('src/servicios/sg_gastos_facturados.js');
const SERV_PT = leer('src/servicios/sg_partida_terminada.js');

const { fletesSalidaAdelantados, resumenSalidaAdelantada, comprobantesDeLaPartida, fleteEntradaAdelantado } =
  await import(pathToFileURL(path.join(RAIZ, 'src/servicios/sg_gastos_facturados.js')).href);
const { frenoParaLiquidar } =
  await import(pathToFileURL(path.join(RAIZ, 'src/servicios/sg_partida_terminada.js')).href);

const tramo = (txt, desde, hasta) => {
  const i = txt.indexOf(desde);
  assert.ok(i >= 0, 'no está: ' + desde.slice(0, 60));
  const j = txt.indexOf(hasta, i + desde.length);
  assert.ok(j > i, 'no cierra: ' + hasta.slice(0, 60));
  return txt.slice(i, j);
};

// ── la base: dos productores, un remito que lleva mercadería de los dos ────────
//
// Partida 7 (productor A): 100 cajones de tomate. Partida 8 (productor B): 50 de
// zapallo. Las dos salieron enteras en el remito 10, con el flete a cargo del
// productor y adelantado por San Gerónimo. Precio 0: nada queda «sin facturar», así
// que el único freno posible es el del flete.
function base({ cargo = 'productor', quien = 'san_geronimo' } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, tipo_precio TEXT, flete_a_cargo TEXT, flete_pagado_por TEXT);
    CREATE TABLE sg_devoluciones (id INTEGER PRIMARY KEY, despacho_id INTEGER, estado TEXT);
    CREATE TABLE sg_devolucion_items (id INTEGER PRIMARY KEY, devolucion_id INTEGER, despacho_item_id INTEGER,
      lote_id INTEGER, bultos REAL, kg REAL, destino TEXT);
    INSERT INTO sg_oc (id, tipo_precio) VALUES (7, 'pizarra'), (8, 'pizarra');
    CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY, oc_id INTEGER);
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, oc_item_id INTEGER, bultos INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, numero TEXT, activo INTEGER DEFAULT 1,
      flete_a_cargo TEXT, flete_pagado_por TEXT);
    CREATE TABLE sg_despacho_items (id INTEGER PRIMARY KEY, despacho_id INTEGER, lote_id INTEGER,
      bultos INTEGER, kg_despachados REAL, kg_declarados REAL, precio_por_kg REAL);
    CREATE TABLE sg_lote_decomisos (id INTEGER PRIMARY KEY, lote_id INTEGER, bultos INTEGER);
    CREATE TABLE sg_ven_facturas (id INTEGER PRIMARY KEY);
    CREATE TABLE sg_factura_despachos (id INTEGER PRIMARY KEY, factura_id INTEGER, despacho_item_id INTEGER, kg REAL);
    CREATE TABLE sg_recepciones (id INTEGER PRIMARY KEY, oc_id INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_gastos_directos (id INTEGER PRIMARY KEY, tipo_gasto TEXT, despacho_id INTEGER,
      recepcion_id INTEGER, proveedor_servicio_id INTEGER, estado TEXT, monto REAL, fecha_servicio TEXT,
      activo INTEGER DEFAULT 1);
    CREATE TABLE sg_gasto_flete_lineas (id INTEGER PRIMARY KEY, gasto_id INTEGER, despacho_item_id INTEGER, monto REAL,
      UNIQUE (gasto_id, despacho_item_id));
    CREATE TABLE sg_facturas_gasto (id INTEGER PRIMARY KEY, proveedor_servicio_id INTEGER, tipo_comprobante TEXT,
      punto_venta INTEGER, numero INTEGER, fecha_emision TEXT, cuit_emisor TEXT, neto REAL, iva_monto REAL,
      total REAL, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_factura_gasto_items (id INTEGER PRIMARY KEY, factura_id INTEGER, gasto_id INTEGER, neto REAL);
    CREATE TABLE sg_proveedores (id INTEGER PRIMARY KEY, razon_social TEXT, cuit TEXT);
    INSERT INTO sg_proveedores VALUES (77, 'FLETES JUAN SRL', '30-77777777-7');
    INSERT INTO sg_oc_items VALUES (70, 7), (80, 8);
    INSERT INTO sg_lotes VALUES (1, 70, 100, 1), (2, 80, 50, 1);
    INSERT INTO sg_despacho_items VALUES (101, 10, 1, 100, 1800, NULL, 0), (102, 10, 2, 50, 1000, NULL, 0);
    INSERT INTO sg_gastos_directos (id, tipo_gasto, despacho_id, proveedor_servicio_id, estado)
      VALUES (1, 'flete_salida', 10, 77, 'pendiente_valorizar');
  `);
  db.prepare('INSERT INTO sg_despachos VALUES (10, ?, 1, ?, ?)').run('SG-DESP-10', cargo, quien);
  return db;
}
const valorizar = (db, a, b) => {
  db.exec(`UPDATE sg_gastos_directos SET estado='valorizado', monto=${a + b} WHERE id=1;
    INSERT INTO sg_gasto_flete_lineas (gasto_id, despacho_item_id, monto) VALUES (1, 101, ${a}), (1, 102, ${b});`);
};
const facturar = (db, activo = 1) => {
  db.exec(`INSERT INTO sg_facturas_gasto VALUES (900, 77, 'factura_a', 3, 1234, '2026-09-11', '30-77777777-7',
             5000, 1050, 6050, ${activo});
           INSERT INTO sg_factura_gasto_items VALUES (1, 900, 1, 5000);`);
};
const freno = (db, oc) => frenoParaLiquidar(db, oc, () => '1=1');

// ══ 1 · CUÁNTO ES DE CADA PARTIDA ══════════════════════════════════════════

test('a cada partida le toca lo valorizado para SUS productos, no el remito entero', () => {
  const db = base();
  valorizar(db, 3000, 2000);
  facturar(db);
  assert.equal(resumenSalidaAdelantada(db, 7).neto, 3000);
  assert.equal(resumenSalidaAdelantada(db, 8).neto, 2000);
  assert.deepEqual(resumenSalidaAdelantada(db, 7).remitos, ['SG-DESP-10']);
});

test('sólo cuenta si el flete es del productor y lo adelantó San Gerónimo', () => {
  for (const [cargo, quien] of [['nosotros', null], ['cliente', null], ['productor', 'productor']]) {
    const db = base({ cargo, quien });
    valorizar(db, 3000, 2000);
    facturar(db);
    assert.deepEqual(fletesSalidaAdelantados(db, 7), [], cargo + '/' + quien + ' se le descuenta al productor');
    assert.equal(resumenSalidaAdelantada(db, 7).neto, 0);
    assert.equal(freno(db, 7), null);
  }
});

test('a precio cerrado lo absorbemos nosotros: no se descuenta, no frena, no se cita', () => {
  // Pablo, 11/9/2026: «lo absorbemos nosotros».
  const db = base();
  valorizar(db, 3000, 2000);
  db.exec("UPDATE sg_oc SET tipo_precio = 'cerrado' WHERE id = 7");
  assert.deepEqual(fletesSalidaAdelantados(db, 7), []);
  assert.equal(resumenSalidaAdelantada(db, 7).neto, 0);
  assert.equal(freno(db, 7), null, 'frena una partida a precio cerrado por un flete que no se le descuenta');
  assert.deepEqual(comprobantesDeLaPartida(db, 7), []);
  // La otra, a pizarra, sigue con lo suyo.
  assert.equal(resumenSalidaAdelantada(db, 8).neto, 2000);
  // Sin tipo de precio tampoco: la pantalla la trata como precio cerrado.
  db.exec('UPDATE sg_oc SET tipo_precio = NULL WHERE id = 8');
  assert.deepEqual(fletesSalidaAdelantados(db, 8), []);
});

test('un remito anulado o un gasto anulado no le descuentan nada a nadie', () => {
  const db = base();
  valorizar(db, 3000, 2000);
  db.exec('UPDATE sg_despachos SET activo=0');
  assert.deepEqual(fletesSalidaAdelantados(db, 7), []);
  const db2 = base();
  db2.exec("UPDATE sg_gastos_directos SET estado='anulado'");
  assert.deepEqual(fletesSalidaAdelantados(db2, 7), []);
});

test('una base sin los renglones del flete no rompe: no hay nada que descontar', () => {
  const db = base();
  db.exec('DROP TABLE sg_gasto_flete_lineas');
  assert.deepEqual(fletesSalidaAdelantados(db, 7), []);
  assert.equal(resumenSalidaAdelantada(db, 7).neto, 0);
});

// ══ 2 · LO QUE FRENA LA LIQUIDACIÓN, CON EL FRENO REAL ═════════════════════

test('pendiente de valorizar: la partida no se liquida, y dice qué remito', () => {
  const db = base();
  const m = freno(db, 7);
  assert.match(m, /flete de salida del remito SG-DESP-10/);
  assert.match(m, /no está valorizado por producto/);
  assert.match(m, /Gastos Directos → Fletes de salida/);
  assert.equal(resumenSalidaAdelantada(db, 7).sin_valorizar, 1);
});

test('valorizado por remito antes de la V1045: tampoco, y manda a Editar', () => {
  const db = base();
  db.exec("UPDATE sg_gastos_directos SET estado='valorizado', monto=5000 WHERE id=1");
  const m = freno(db, 7);
  assert.match(m, /no está valorizado por producto/);
  assert.match(m, /✏️ Editar/);
  // Y si ya tiene la factura, dice que hay que anularla: Editar muestra 🔒.
  assert.match(m, /si ya tiene la factura del fletero, primero hay que anularla/);
  assert.equal(resumenSalidaAdelantada(db, 7).neto, 0, 'descontó un número que no es de esta partida');
});

test('valorizado por remito antes de la V1045, con TODO el remito de una partida: se toma entero', () => {
  const db = base();
  // Los dos renglones del remito, de la partida 7.
  db.exec("UPDATE sg_despacho_items SET lote_id = 1 WHERE id = 102;"
    + "UPDATE sg_gastos_directos SET estado='valorizado', monto=5000 WHERE id=1");
  const s = resumenSalidaAdelantada(db, 7);
  assert.equal(s.sin_valorizar, 0, 'pide valorizar por producto un remito que es todo de una partida');
  assert.equal(s.neto, 5000);
  assert.match(freno(db, 7), /todavía no tiene la factura del fletero/);
  facturar(db);
  assert.equal(freno(db, 7), null);
  assert.equal(comprobantesDeLaPartida(db, 7)[0].imputado, 5000);
});

test('un remito viejo con un renglón de reproceso, sin partida, no se toma entero', () => {
  const db = base();
  db.exec("INSERT INTO sg_lotes VALUES (3, NULL, 50, 1); UPDATE sg_despacho_items SET lote_id = 3 WHERE id = 102;"
    + "UPDATE sg_gastos_directos SET estado='valorizado', monto=5000 WHERE id=1");
  assert.equal(resumenSalidaAdelantada(db, 7).sin_valorizar, 1, 'se lo cobra entero a una partida con un renglón ajeno');
  assert.equal(resumenSalidaAdelantada(db, 7).neto, 0);
});

test('valorizado sin la factura del fletero: frena; con la factura, liquida', () => {
  const db = base();
  valorizar(db, 3000, 2000);
  assert.match(freno(db, 7), /todavía no tiene la factura del fletero/);
  assert.match(freno(db, 8), /todavía no tiene la factura del fletero/);
  facturar(db);
  assert.equal(freno(db, 7), null);
  assert.equal(freno(db, 8), null);
});

test('con la factura anulada vuelve a frenar', () => {
  const db = base();
  valorizar(db, 3000, 2000);
  facturar(db, 0);
  assert.match(freno(db, 7), /todavía no tiene la factura del fletero/);
});

test('si a esta partida le tocó cero, la factura no la frena', () => {
  const db = base();
  valorizar(db, 0, 2000);
  assert.equal(freno(db, 7), null, 'frena a una partida a la que no se le descuenta nada');
  assert.match(freno(db, 8), /factura del fletero/);
});

test('el freno del flete de salida va después de los de entrada, y el de valorizar antes que el de la factura', () => {
  const f = tramo(SERV_PT, 'export function frenoParaLiquidar(', '\n}');
  const iEntrada = f.indexOf("«Gastos Directos → Fletes de entrada → 🧾 Ingresar factura»");
  const iSal = f.indexOf('const sal = resumenSalidaAdelantada(db, ocId);');
  assert.ok(iEntrada > 0 && iSal > iEntrada);
  assert.ok(f.indexOf('if (sal.sin_valorizar > 0)') < f.indexOf('if (sal.sin_factura > 0)'));
});

// ══ 3 · EL PAPEL: LA FACTURA DEL FLETERO SE CITA ═══════════════════════════

test('el PDF cita la factura del fletero, con el total entero y lo imputado a esta partida', () => {
  const db = base();
  valorizar(db, 3000, 2000);
  facturar(db);
  const c7 = comprobantesDeLaPartida(db, 7);
  assert.equal(c7.length, 1);
  assert.equal(c7[0].emisor, 'FLETES JUAN SRL');
  assert.equal(c7[0].cuit, '30-77777777-7');
  assert.equal(c7[0].comprobante, 'A 0003-00001234');
  assert.equal(c7[0].total, 6050, 'la DDJJ necesita el total de la factura, no la parte');
  assert.equal(c7[0].imputado, 3000);
  assert.deepEqual(c7[0].conceptos, ['Flete de salida']);
  assert.equal(comprobantesDeLaPartida(db, 8)[0].imputado, 2000);
  // Y la liquidación agrupada lee la misma función.
  assert.match(LIQ, /for \(const c of comprobantesDeLaPartida\(dbSg, ocId, \{ salida: conSalida \}\)\)/);
});

test('sin factura, o con lo de la partida en cero, no se cita nada', () => {
  const db = base();
  valorizar(db, 0, 2000);
  assert.deepEqual(comprobantesDeLaPartida(db, 7), []);
  facturar(db);
  assert.deepEqual(comprobantesDeLaPartida(db, 7), [], 'cita una factura de la que no se descuenta nada');
});

test('una factura que cubre dos partidas del grupo se cita una vez, con lo imputado a las dos', () => {
  const db = base();
  valorizar(db, 3000, 2000);
  facturar(db);
  // La función REAL del PDF, con la base inyectada: la cabecera es la partida 7 y la
  // otra viene de liquidacion_partidas.
  const fn = tramo(LIQ, 'function comprobantesDeLaLiquidacion(liq, opts) {', '\r\n}') + '\r\n}';
  const deLaLiquidacion = new Function('db', 'dbSg', 'comprobantesDeLaPartida',
    fn + '\nreturn comprobantesDeLaLiquidacion;')(
    { prepare: () => ({ all: () => [{ oc_id: 8 }] }) }, db, comprobantesDeLaPartida);
  const cs = deLaLiquidacion({ id: 1, oc_id: 7 }, { alEmitir: true });
  assert.equal(cs.length, 1, 'cita dos veces la misma factura');
  assert.equal(cs[0].imputado, 5000, 'el papel dice lo imputado a una sola partida');
  assert.deepEqual(cs[0].conceptos, ['Flete de salida']);
});

test('el papel se reimprime como salió: con la copia guardada, o sin el flete de salida si es de antes', () => {
  const db = base();
  valorizar(db, 3000, 2000);
  facturar(db);
  const fn = tramo(LIQ, 'function comprobantesDeLaLiquidacion(liq, opts) {', '\r\n}') + '\r\n}';
  const deLaLiquidacion = new Function('db', 'dbSg', 'comprobantesDeLaPartida',
    fn + '\nreturn comprobantesDeLaLiquidacion;')(
    { prepare: () => ({ all: () => [] }) }, db, comprobantesDeLaPartida);
  // Una liquidación de ANTES, sin copia: ese flete no lo descontó, así que no se cita.
  assert.deepEqual(deLaLiquidacion({ id: 1, oc_id: 7 }), [],
    'la reimpresión de una liquidación vieja cita un flete que nunca descontó');
  // Con la copia, lo que dice la copia, aunque la base cambie.
  const copia = [{ factura_id: 1, emisor: 'X', imputado: 10 }];
  assert.deepEqual(deLaLiquidacion({ id: 1, oc_id: 7, comprobantes_json: JSON.stringify(copia) }), copia);
  // Y la copia se guarda al emitir, con el flete de salida, antes del INSERT.
  const post = tramo(LIQ, "router.post('/', ", '\r\n});');
  const iComps = post.indexOf("const compsEmitidos = comprobantesDeLaLiquidacion({ oc_ids: partidas.map((p) => p.oc_id) }, { alEmitir: true });");
  assert.ok(iComps > 0 && iComps < post.indexOf('INSERT INTO liquidaciones'));
  assert.match(post, /merma_liquidada, comprobantes_json\r?\n\s+\) VALUES \((\?,\s*){29}\?\)/);
  assert.match(post, /partidas\.length === 1 \? partidas\[0\]\.merma_liquidada : null,\r?\n\s+JSON\.stringify\(compsEmitidos\)\r?\n\s+\);/);
  assert.match(LIQ, /ALTER TABLE liquidaciones ADD COLUMN comprobantes_json TEXT/);
  // Y la pantalla lee la de la partida sin guardarla: ésa sí trae el flete de salida.
  assert.equal(comprobantesDeLaPartida(db, 7)[0].imputado, 3000);
  assert.deepEqual(comprobantesDeLaPartida(db, 7, { salida: false }), []);
});

test('el grupo, corrido: suma el flete de salida de todas y lo imputado de la misma factura, sin pisar las partidas', () => {
  const fusionarVentas = new Function('r2', fuenteSG('function fusionarVentas(') + '\nreturn fusionarVentas;')(
    (n) => Math.round((Number(n) || 0) * 100) / 100);
  const parte = (oc, neto, iva, imputado) => ({
    oc_id: oc, partida: 'P' + oc, proveedor: { id: 1 }, es_precio_cerrado: 0, acordado: {},
    articulos: [], mermas: [], lineas: [], descarga: {}, sin_valorizar: {}, sin_factura: {},
    flete: { se_cobra: 0, salida: { neto, iva, sin_valorizar: 0, sin_factura: 0, remitos: ['R-1'],
      remitos_sin_valorizar: [], remitos_sin_factura: [] } },
    comprobantes: [{ factura_id: 9, imputado, conceptos: ['Flete de salida'] }],
  });
  const partes = [parte(7, 3000, 630, 3000), parte(8, 2000, 420, 2000)];
  const f = fusionarVentas(partes);
  assert.equal(f.flete.salida.neto, 5000);
  assert.equal(f.flete.salida.iva, 1050);
  assert.deepEqual(f.flete.salida.remitos, ['R-1'], 'repite el remito que lleva mercadería de las dos');
  assert.equal(f.comprobantes.length, 1);
  assert.equal(f.comprobantes[0].imputado, 5000);
  assert.equal(partes[0].comprobantes[0].imputado, 3000, 'el grupo le pisó el número a la primera partida');
});

// ══ 4 · LA VENTA DE LA PARTIDA Y LA PANTALLA DE LIQUIDACIÓN ════════════════

test('la venta de la partida trae el flete de salida con IVA al 21, y el grupo lo suma', () => {
  assert.match(SG, /salida: \(function\(\)\{\r?\n\s+const s = resumenSalidaAdelantada\(db, ocId\);\r?\n\s+return Object\.assign\(\{\}, s, \{ iva: r2\(s\.neto \* IVA_SERVICIOS \/ 100\) \}\);/);
  // Desde la V1048 trae también el flete de entrada adelantado.
  assert.match(SG, /import \{ gastosSinFactura, comprobantesDeLaPartida, resumenSalidaAdelantada, [^}]*\} from '\.\.\/servicios\/sg_gastos_facturados\.js';/);
  const fusion = tramo(SG, 'function fusionarVentas(', '\r\n}');
  assert.match(fusion, /const ss = partes\.map\(\(p\) => \(p\.flete \|\| \{\}\)\.salida \|\| \{\}\);/);
  assert.match(fusion, /neto: n\(\(s\) => s\.neto\), iva: n\(\(s\) => s\.iva\),/);
  assert.match(fusion, /sin_valorizar: n\(\(s\) => s\.sin_valorizar\), sin_factura: n\(\(s\) => s\.sin_factura\),/);
});

// El bloque del flete ENTERO —el de la orden y el de salida— y el pg DE VERDAD, que
// sólo llena un casillero vacío. La primera versión de este test usaba un pg que
// pisaba siempre, y así no vio que el de salida quedaba afuera cuando la orden ya
// había escrito el suyo.
const PRELLENO = tramo(PANEL, '  var fl = r.flete || {};\r\n', '  // Y SI QUEDARON ABIERTAS, SE DICE POR QUÉ.');
const PG = tramo(PANEL, '  var pg = function(id, val){', "  pg('liq-g-f-ventas', r.neto);");
function prellenar(flete) {
  const campos = {};
  const LIQ_ = { origen: {} };
  const eid = (id) => (campos[id] = campos[id] || { value: '' });
  const liqNumPoner = (e, n) => { e.value = n; };
  new Function('r', 'LIQ', 'eid', 'liqNumPoner', 'sgMoney', 'escH', PG + PRELLENO)(
    { flete }, LIQ_, eid, liqNumPoner, (n) => '$' + n, (x) => String(x));
  const valores = {};
  for (const [k, v] of Object.entries(campos)) if (v.value !== '') valores[k] = v.value;
  return { campos: valores, origen: LIQ_.origen.flete };
}

test('la fila del flete suma el de la orden y el de salida adelantado', () => {
  const r = prellenar({ se_cobra: 1, neto: 1000, iva: 210,
    salida: { neto: 3000, iva: 630, remitos: ['SG-DESP-10'] } });
  assert.deepEqual(r.campos, { 'liq-g-f-flete': 4000, 'liq-g-f-iva_flete': 840 });
  assert.match(r.origen, /^de la orden de compra \+ \$3000 del flete de salida que San Gerónimo le adelantó \(remito SG-DESP-10\)$/);
});

test('sin flete de la orden, la fila es sólo el de salida; y sin salida no toca nada', () => {
  const r = prellenar({ se_cobra: 0, neto: 9000, iva: 1890, monto: 9000, a_cargo: 'vendedor',
    salida: { neto: 3000, iva: 630, remitos: [] } });
  assert.deepEqual(r.campos, { 'liq-g-f-flete': 3000, 'liq-g-f-iva_flete': 630 },
    'le cobró el flete que pagó el vendedor');
  assert.match(r.origen, /^la orden tiene \$9000 a cargo del vendedor — no se le cobra al productor · \$3000 del flete de salida que San Gerónimo le adelantó$/);
  const nada = prellenar({ se_cobra: 1, neto: 1000, iva: 210, salida: { neto: 0 } });
  assert.deepEqual(nada.campos, { 'liq-g-f-flete': 1000, 'liq-g-f-iva_flete': 210 });
  assert.equal(nada.origen, 'de la orden de compra');
  // Y sin ninguno de los dos, lo de siempre.
  const vendedor = prellenar({ se_cobra: 0, monto: 9000, a_cargo: 'vendedor', salida: {} });
  assert.deepEqual(vendedor.campos, {});
  assert.match(vendedor.origen, /a cargo del vendedor — no se le cobra al productor/);
});

const FRENOS = tramo(PANEL, '    var fsal = (r.flete || {}).salida || {};', '    LIQ.frenos = frenos;');
function frenosPantalla(salida) {
  const frenos = [];
  new Function('r', 'frenos', 'escH', FRENOS)({ flete: { salida } }, frenos, (x) => String(x));
  return frenos;
}

test('la pantalla frena igual que el servidor, primero valorizar y después la factura', () => {
  const sv = frenosPantalla({ sin_valorizar: 1, sin_factura: 1, remitos_sin_valorizar: ['R-1'], remitos_sin_factura: ['R-2'] });
  assert.equal(sv.length, 1, 'muestra los dos carteles a la vez');
  assert.match(sv[0], /R-1 se le adelantó al productor y <b>no está valorizado por producto<\/b>/);
  const sf = frenosPantalla({ sin_valorizar: 0, sin_factura: 1, remitos_sin_factura: ['R-2'] });
  assert.match(sf[0], /R-2 se le descuenta al productor pero todavía no tiene la <b>factura del fletero<\/b>/);
  assert.deepEqual(frenosPantalla({ sin_valorizar: 0, sin_factura: 0 }), []);
});

test('la celda del flete sigue abierta, y dice por qué', () => {
  const j = PANEL.indexOf('function liqCeldaCalculada(k, amb){');
  const antes = PANEL.slice(j - 4600, j);
  assert.match(antes, /el de SALIDA\r?\n\/\/\s+que San Gerónimo le adelantó \(V1046\)/);
  assert.match(antes, /el servidor no deja emitir/);
});

// ══ 5 · EL MARGEN DEL REMITO NO LO RESTA ═══════════════════════════════════

const REGLAS = (() => {
  const d = SG.indexOf('const FLETE_A_RECUPERAR =');
  const fin = SG.indexOf(';', SG.indexOf("quien === 'san_geronimo'", d)) + 1;
  const i = SG.indexOf('function fleteDeRemito(b) {');
  let prof = 0, k = SG.indexOf('{', i);
  for (; k < SG.length; k++) {
    if (SG[k] === '{') prof++;
    else if (SG[k] === '}') { prof--; if (prof === 0) break; }
  }
  return new Function(SG.slice(d, fin) + '\n' + SG.slice(i, k + 1)
    + '\nreturn { FLETE_A_RECUPERAR, fleteDeRemito };')();
})();

const aRecuperar = new Function('r2', fuenteSG('function fleteARecuperarDeRemito(') + '\nreturn fleteARecuperarDeRemito;')(
  (n) => Math.round((Number(n) || 0) * 100) / 100);
function fuenteSG(firma) {
  const i = SG.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  let prof = 0, k = SG.indexOf('{', i);
  for (; k < SG.length; k++) {
    if (SG[k] === '{') prof++;
    else if (SG[k] === '}') { prof--; if (prof === 0) break; }
  }
  return SG.slice(i, k + 1);
}

test('del flete del remito se recupera sólo lo de partidas a pizarra', () => {
  const db = base();
  valorizar(db, 3000, 2000);
  assert.equal(aRecuperar(db, 10), 5000);
  db.exec("UPDATE sg_oc SET tipo_precio = 'cerrado' WHERE id = 8");
  assert.equal(aRecuperar(db, 10), 3000, 'lo de la partida a precio cerrado no se le recupera a nadie');
  // Un renglón sin partida —un lote de reproceso— tampoco.
  db.exec('UPDATE sg_lotes SET oc_item_id = NULL WHERE id = 1');
  assert.equal(aRecuperar(db, 10), 0);
  // Pendiente, nada.
  assert.equal(aRecuperar(base(), 10), 0);
});

test('valorizado por remito: entero sólo si todo el remito es de UNA partida a pizarra', () => {
  const db = base();
  db.exec("UPDATE sg_gastos_directos SET estado='valorizado', monto=5000 WHERE id=1");
  assert.equal(aRecuperar(db, 10), 0, 'dos partidas: no se sabe cuánto es de cada una');
  db.exec('UPDATE sg_despacho_items SET lote_id = 1 WHERE id = 102');
  assert.equal(aRecuperar(db, 10), 5000);
  db.exec("UPDATE sg_oc SET tipo_precio = 'cerrado' WHERE id = 7");
  assert.equal(aRecuperar(db, 10), 0);
});

test('en la lista de remitos, lo que se recupera no resta del margen; lo nuestro sí', () => {
  const codigo = tramo(SG, '    for (const r of rows) {\r\n      const fr = fleteDeRemito(r);', '    res.json(');
  const rows = [
    { id: 1, margen: 1000, flete_salida: 300, carga_salida: 50, flete_a_cargo: 'productor', flete_pagado_por: 'san_geronimo' },
    { id: 2, margen: 1000, flete_salida: 300, carga_salida: 50, flete_a_cargo: 'productor', flete_pagado_por: 'san_geronimo' },
    { id: 3, margen: 1000, flete_salida: 300, carga_salida: 50, flete_a_cargo: 'nosotros' },
    { id: 4, margen: 1000, flete_salida: 300, carga_salida: 50, flete_paga: 'vendedor' },
  ];
  // El 1 se recupera entero; del 2 sólo 100 (el resto es de una partida a precio cerrado).
  const recuperable = { 1: 300, 2: 100, 3: 300, 4: 300 };
  new Function('rows', 'db', 'fleteDeRemito', 'FLETE_A_RECUPERAR', 'fleteARecuperarDeRemito', codigo)(
    rows, {}, REGLAS.fleteDeRemito, REGLAS.FLETE_A_RECUPERAR, (_db, id) => recuperable[id]);
  assert.deepEqual(rows.map((r) => [r.margen_neto, r.flete_a_recuperar]), [[950, 300], [750, 100], [650, 0], [650, 0]]);
});

test('en la ficha del remito, lo mismo, y dice cuánto queda como costo', () => {
  const codigo = tramo(SG, '    const frd = fleteDeRemito(d);', '    res.json(');
  const d = { id: 10, flete_salida: 300, carga_salida: 50, flete_a_cargo: 'productor', flete_pagado_por: 'san_geronimo' };
  new Function('d', 'db', 'margen', 'fleteDeRemito', 'FLETE_A_RECUPERAR', 'fleteARecuperarDeRemito', codigo)(
    d, {}, 1000, REGLAS.fleteDeRemito, REGLAS.FLETE_A_RECUPERAR, () => 100);
  assert.equal(d.flete_a_recuperar, 100);
  assert.equal(d.margen_neto, 750);
  assert.match(PANEL, /\? ' · se le descuenta al productor en su liquidación'/);
  assert.match(PANEL, /' queda como costo nuestro\)'/);
  // Y cuando no se recupera nada, lo dice igual.
  assert.match(PANEL, /' · no se le puede descontar a nadie \(precio cerrado o sin partida\): queda como costo nuestro'/);
});

// ══ 6 · LOS «¿CÓMO SE USA?» DICEN LO QUE EL CÓDIGO HACE ════════════════════

const manual = (clave) => {
  const i = PANEL.indexOf('SG_MANUAL.' + clave + ' = {');
  assert.ok(i > 0, 'no está el manual de ' + clave);
  return PANEL.slice(i, PANEL.indexOf('\r\n};', i)).replace(/'\r?\n\s*\+ '/g, '');
};

test('la pantalla de Liquidaciones tiene su botón y su manual', () => {
  const cab = tramo(PANEL, '<div class="sec" id="sec-ab-liquidaciones">', '<style>');
  assert.match(cab, /onclick="sgManualAbrir\('liquidaciones'\)">❓ ¿Cómo se usa\?<\/button>/);
  assert.ok(!/>\s*\+\s*Nueva liquidación\s*</.test(cab), 'volvió el botón de liquidación suelta');
  assert.match(PANEL, /SG_MANUAL\.liquidaciones = \{ titulo: 'Liquidaciones', html:/);
});

test('manual de Liquidaciones: cada afirmación, contra el código', () => {
  const M = manual('liquidaciones');
  // Las dos solapas, con contador, y sin «+ Nueva liquidación».
  assert.match(M, /<b>⏳ Partidas pendientes de liquidar<\/b>/);
  assert.match(M, /<b>📄 Liquidaciones emitidas<\/b> — las que ya salieron, con buscador por número o remitente/);
  assert.match(PANEL, /id="liq-cnt-part"/);
  assert.match(PANEL, /id="liq-cnt-emi"/);
  assert.match(PANEL, /<input id="liq-q" placeholder="🔎 Buscar por número o remitente…"/);
  // Agrupar.
  assert.match(M, /Se <b>tildan dos o más partidas del mismo productor<\/b>/);
  assert.match(M, /la liquidación suma, no promedia/);
  assert.match(PANEL, /title="Tildá dos o más partidas del mismo productor para liquidarlas juntas"/);
  assert.match(SG, /Por eso esto SUMA y no promedia/);
  // Los frenos: los cinco, en el freno real.
  assert.match(M, /la partida <b>no está terminada<\/b>/);
  assert.match(M, /salió mercadería que <b>todavía no se facturó<\/b>/);
  assert.match(M, /<b>sin valorizar<\/b>, o valorizados pero <b>sin la factura<\/b>/);
  assert.match(M, /<span class="ver">V1046<\/span> el <b>flete de salida que San Gerónimo le adelantó<\/b>/);
  const f = tramo(SERV_PT, 'export function frenoParaLiquidar(', '\n}');
  for (const x of ['frenoPartidaSinTerminar(db, ocId)', 'sinFacturarDePartida(db, ocId, facturaCuenta)',
                   'gastosSinValorizar(db, ocId)', 'gastosSinFactura(db, ocId)', 'resumenSalidaAdelantada(db, ocId)']) {
    assert.ok(f.includes(x), 'el freno no mira: ' + x);
  }
  // Lo que llega solo y lo que no.
  assert.match(M, /Las <b>ventas<\/b> salen de los comprobantes de la partida y no se tipean/);
  assert.match(M, /Sólo se abren a mano cuando una factura vieja se compartió entre dos partidas/);
  assert.match(PANEL, /function liqVentasSeCalculan\(/);
  assert.match(M, /Si hay de los dos, se suman en la misma fila/);
  assert.match(M, /La <b>descarga<\/b> sale de la recepción, si está valorizada/);
  assert.match(PANEL, /pg\('liq-g-f-descarga', d\.monto\);/);
  assert.match(M, /con IVA al 21%/);
  assert.match(M, /<b>Sólo a pizarra<\/b>: a precio cerrado el productor cobra lo pactado entero y ese flete lo absorbemos nosotros/);
  assert.match(SG, /const IVA_SERVICIOS = 21;/);
  assert.match(M, /Siguen <b>a mano<\/b>: los gastos administrativos a precio abierto/);
  // El papel.
  assert.match(M, /<b>emisor, CUIT, número, fecha y el total<\/b> de la factura, entero/);
  assert.match(LIQ, /doc\.text\('COMPROBANTES DE TERCEROS QUE SE DESCUENTAN', L, y\);/);
  assert.match(LIQ, /imputado a esta liquidación: /);
  assert.match(SERV_GF, /flete_salida: 'Flete de salida'/);
  // El asiento modelo, arriba.
  assert.match(M, /El asiento modelo de las liquidaciones se configura en esta pantalla y es del <b>módulo entero<\/b>/);
  assert.match(PANEL, /<div id="liq-modelo-box"/);
});

test('manual de Gastos Directos: «se le descuenta al productor, no resta del margen, frena la liquidación»', () => {
  const M = manual('gastos');
  assert.match(M, /<h3>🚚 El flete que se le adelantó al productor <span class="ver">V1046<\/span><\/h3>/);
  assert.match(M, /<b>Se le descuenta al productor<\/b> en la liquidación de su partida/);
  assert.match(M, /Lo que se le descuenta <b>no es costo nuestro<\/b>: el margen del remito no lo resta/);
  assert.match(M, /<b>Sólo en las partidas a pizarra<\/b>\. A <b>precio cerrado<\/b> el productor cobra lo pactado entero: ese flete lo absorbemos nosotros/);
  assert.match(SERV_GF, /if \(!oc \|\| oc\.tipo_precio !== 'pizarra'\) return \[\];/);
  assert.match(M, /esa partida <b>no se puede liquidar<\/b>\./);
  assert.match(M, /se toma <b>entero<\/b> si todo el remito es de una sola partida/);
  assert.match(M, /si ya tiene la factura del fletero, primero se anula la factura/);
  assert.match(SERV_GF, /Number\(x\.items_partida\) === Number\(x\.items_remito\)/);
  assert.match(SG, /r\.margen_neto = \(r\.margen \|\| 0\) - \(\(r\.flete_salida \|\| 0\) - r\.flete_a_recuperar\) - \(r\.carga_salida \|\| 0\);/);
  assert.match(SG, /JOIN sg_oc o ON o\.id = oi\.oc_id AND o\.tipo_precio = 'pizarra'/);
  assert.match(SERV_PT, /si ya estaba valorizado, con «✏️ Editar»/);
});

test('manual de Remitos: «el flete adelantado se le descuenta a esa partida y no resta del margen»', () => {
  const M = manual('ventas');
  assert.match(M, /<b>🚚 Flete que adelanta San Gerónimo<\/b> <span class="ver">V1046<\/span>/);
  assert.match(M, /<b>se le descuenta al productor de esa partida<\/b> en su liquidación, y <b>no resta del margen<\/b>/);
  assert.match(M, /<b>Sólo si la partida es a pizarra<\/b>: a precio cerrado el productor cobra lo pactado/);
  assert.match(PANEL, /<b>Sólo en las '\r?\n\s*\+ 'partidas a pizarra<\/b>: si la partida se compró a <b>precio cerrado<\/b>/);
  assert.match(M, /La ficha del remito lo dice al lado del flete/);
  assert.match(M, /<b>V1046<\/b> — el flete que San Gerónimo le adelanta al productor se le descuenta/);
});

test('los manuales no citan una versión que el panel todavía no alcanzó', () => {
  const actual = Number((leer('src/sidebar-v2.js').match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const k of ['liquidaciones', 'gastos', 'ventas']) {
    for (const v of (manual(k).match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
      assert.ok(v <= actual, `el manual de ${k} cita la V${v} y el panel va en la V${actual}`);
    }
  }
});

// ══ 7 · EL SERVIDOR NO DEJA DESCONTAR DE MENOS ═════════════════════════════

function fuenteLIQ(firma) {
  const i = LIQ.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  let prof = 0, k = LIQ.indexOf('{', i);
  for (; k < LIQ.length; k++) {
    if (LIQ[k] === '{') prof++;
    else if (LIQ[k] === '}') { prof--; if (prof === 0) break; }
  }
  return LIQ.slice(i, k + 1);
}

test('la fila «Flete» no puede traer menos que lo adelantado; más sí; a precio cerrado no se mira', () => {
  const frenoGrilla = new Function('resumenSalidaAdelantada', 'fleteEntradaAdelantado',
    fuenteLIQ('function frenoFleteSalidaEnGrilla(') + '\nreturn frenoFleteSalidaEnGrilla;')(resumenSalidaAdelantada, fleteEntradaAdelantado);
  const db = base();
  valorizar(db, 3000, 2000);
  facturar(db);
  const dos = [{ oc_id: 7 }, { oc_id: 8 }];
  const con = (flete, modo = 'abierto') => ({ modo_precio: modo, grilla: { fiscal: { flete } } });
  assert.match(frenoGrilla(db, dos, con(4000)), /La fila «Flete» tiene \$4\.000,00 y el flete que San Gerónimo le adelantó .* es \$5\.000,00/);
  assert.equal(frenoGrilla(db, dos, con(5000)), null);
  assert.equal(frenoGrilla(db, dos, con(6200)), null, 'con el flete de la orden encima también tiene que pasar');
  assert.equal(frenoGrilla(db, dos, con(0, 'cerrado')), null);
  assert.match(frenoGrilla(db, [{ oc_id: 7 }], { grilla: {} }), /tiene \$0,00 .* es \$3\.000,00/);
  // Sin nada adelantado no se mira la fila.
  assert.equal(frenoGrilla(base({ cargo: 'nosotros' }), dos, con(0)), null);
});

test('y está enganchado en el guardado, después de los frenos de la partida', () => {
  const post = tramo(LIQ, "router.post('/', ", '\r\n});');
  const iFreno = post.indexOf('frenoParaLiquidar(db, p.oc_id, facturaCuenta)');
  const iFlete = post.indexOf('const fleteMal = frenoFleteSalidaEnGrilla(db, partidas, d);');
  assert.ok(iFreno > 0 && iFlete > iFreno, 'el control de la fila no está en el guardado');
  assert.match(post, /if \(fleteMal\) return res\.status\(400\)\.json\(\{ error: fleteMal \}\);/);
  assert.ok(iFlete < post.indexOf('INSERT INTO liquidaciones'), 'controla después de guardar');
  const M = manual('liquidaciones');
  assert.match(M, /El casillero se puede tocar, pero <b>no por debajo<\/b> de lo adelantado: el sistema no deja emitir/);
});
