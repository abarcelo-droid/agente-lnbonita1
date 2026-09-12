// ══ LOS FLETES ADELANTADOS EN LA LIQUIDACIÓN: EL DE ENTRADA, Y LO DEVUELTO (V1048) ══
//
// Pablo, 11/9/2026:
//   · «El flete adelantado, en caso de corresponder, se debe descontar de la
//      liquidación». El de ENTRADA se tipeaba a mano en la fila «Flete».
//   · «El flete de salida cuando el cliente devuelve mercadería es pérdida de la
//      partida». El de lo devuelto se le seguía descontando al productor.
//   · Y la regla de precio cerrado que ya había dado para el de salida: «lo absorbemos
//      nosotros». Vale igual para el de entrada, que entonces sí es costo de la partida.
//
// Los tests corren el código REAL: los servicios importados, el freno de liquidar sobre
// una partida terminada en memoria, la consulta del costo del lote, el control del
// servidor y los trozos de pantalla.
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

const { esFleteEntradaAdelantado, fleteEntradaAdelantado, resumenSalidaAdelantada } =
  await import(pathToFileURL(path.join(RAIZ, 'src/servicios/sg_gastos_facturados.js')).href);
const { frenoParaLiquidar } =
  await import(pathToFileURL(path.join(RAIZ, 'src/servicios/sg_partida_terminada.js')).href);

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
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
const tramo = (txt, desde, hasta) => {
  const i = txt.indexOf(desde);
  assert.ok(i >= 0, 'no está: ' + desde.slice(0, 60));
  const j = txt.indexOf(hasta, i + desde.length);
  assert.ok(j > i, 'no cierra: ' + hasta.slice(0, 60));
  return txt.slice(i, j);
};

// ── la base ────────────────────────────────────────────────────────────────
//
// Partida 7: 100 cajones, entrados en DOS viajes (recepciones 55 y 56), que salieron
// enteros en el remito 10. Precio 0: nada queda sin facturar, así que el único freno
// posible es el de los fletes.
function base({ precio = 'pizarra', cargo = 'vendedor', quien = 'san_geronimo' } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, tipo_precio TEXT, flete_a_cargo TEXT, flete_pagado_por TEXT);
    CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY, oc_id INTEGER);
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, oc_item_id INTEGER, bultos INTEGER, activo INTEGER DEFAULT 1,
      recepcion_id INTEGER);
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
    CREATE TABLE sg_gasto_flete_lineas (id INTEGER PRIMARY KEY, gasto_id INTEGER, despacho_item_id INTEGER, monto REAL);
    CREATE TABLE sg_facturas_gasto (id INTEGER PRIMARY KEY, proveedor_servicio_id INTEGER, tipo_comprobante TEXT,
      punto_venta INTEGER, numero INTEGER, fecha_emision TEXT, cuit_emisor TEXT, neto REAL, iva_monto REAL,
      total REAL, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_factura_gasto_items (id INTEGER PRIMARY KEY, factura_id INTEGER, gasto_id INTEGER, neto REAL);
    CREATE TABLE sg_proveedores (id INTEGER PRIMARY KEY, razon_social TEXT, cuit TEXT);
    CREATE TABLE sg_devoluciones (id INTEGER PRIMARY KEY, despacho_id INTEGER, estado TEXT);
    CREATE TABLE sg_devolucion_items (id INTEGER PRIMARY KEY, devolucion_id INTEGER, despacho_item_id INTEGER,
      lote_id INTEGER, bultos REAL, kg REAL, destino TEXT);
    INSERT INTO sg_proveedores VALUES (77, 'FLETES JUAN SRL', '30-77777777-7');
    INSERT INTO sg_oc_items VALUES (70, 7);
    INSERT INTO sg_lotes VALUES (1, 70, 100, 1, 55), (2, 70, 0, 1, 56);
    INSERT INTO sg_recepciones VALUES (55, 7, 1), (56, 7, 1);
    INSERT INTO sg_despacho_items VALUES (101, 10, 1, 100, 1800, NULL, 0);
    INSERT INTO sg_despachos VALUES (10, 'SG-DESP-10', 1, 'nosotros', NULL);
  `);
  db.prepare('INSERT INTO sg_oc VALUES (7, ?, ?, ?)').run(precio, cargo, quien);
  return db;
}
const viaje = (db, id, recepcion, monto) => db.prepare(`INSERT INTO sg_gastos_directos
  (id, tipo_gasto, recepcion_id, proveedor_servicio_id, estado, monto)
  VALUES (?, 'flete_entrada', ?, 77, 'valorizado', ?)`).run(id, recepcion, monto);
const facturar = (db, pares, activo = 1) => {
  db.prepare(`INSERT INTO sg_facturas_gasto VALUES (900, 77, 'factura_a', 3, 1234, '2026-09-11',
    '30-77777777-7', 5000, 1050, 6050, ?)`).run(activo);
  for (const [g, neto] of pares) {
    db.prepare('INSERT INTO sg_factura_gasto_items (factura_id, gasto_id, neto) VALUES (900, ?, ?)').run(g, neto);
  }
};
const freno = (db) => frenoParaLiquidar(db, 7, () => '1=1');

// ══ 1 · EL FLETE DE ENTRADA ADELANTADO ═════════════════════════════════════

test('corresponde sólo con el flete del vendedor, adelantado por nosotros, y a pizarra', () => {
  const oc = { flete_a_cargo: 'vendedor', flete_pagado_por: 'san_geronimo', tipo_precio: 'pizarra' };
  assert.equal(esFleteEntradaAdelantado(oc), true);
  for (const otro of [{ tipo_precio: 'cerrado' }, { tipo_precio: null }, { flete_a_cargo: 'comprador' },
                      { flete_pagado_por: 'productor' }]) {
    assert.equal(esFleteEntradaAdelantado(Object.assign({}, oc, otro)), false, JSON.stringify(otro));
  }
  assert.deepEqual(fleteEntradaAdelantado(base({ precio: 'cerrado' }), 7), { corresponde: 0, sin_valorizar: 0, neto: 0 });
});

test('un viaje sin valorizar frena la liquidación, aunque todavía no haya fila de gasto', () => {
  const db = base();
  viaje(db, 1, 55, 3000);
  assert.equal(fleteEntradaAdelantado(db, 7).sin_valorizar, 1);
  assert.match(freno(db), /El flete de entrada de esta partida lo adelantó San Gerónimo y un viaje todavía no está valorizado/);
  assert.match(freno(db), /Gastos Directos → Fletes de entrada/);
  // Los dos sin valorizar, en plural.
  assert.match(freno(base()), /2 viajes todavía no están valorizados/);
  // El viaje de una recepción anulada no cuenta.
  db.exec('UPDATE sg_recepciones SET activo = 0 WHERE id = 56');
  assert.equal(fleteEntradaAdelantado(db, 7).sin_valorizar, 0);
});

test('valorizado y con la factura: se descuenta lo que dicen las facturas, y ya no frena', () => {
  const db = base();
  viaje(db, 1, 55, 3000);
  viaje(db, 2, 56, 2000);
  // Valorizados sin factura: frena el freno de siempre, el de la factura del fletero.
  assert.match(freno(db), /todavía no tiene la factura del fletero cargada/);
  facturar(db, [[1, 3000], [2, 2000]]);
  assert.deepEqual(fleteEntradaAdelantado(db, 7), { corresponde: 1, sin_valorizar: 0, neto: 5000 });
  assert.equal(freno(db), null);
  // Con la factura anulada, del papel no queda nada para descontar.
  db.exec('UPDATE sg_facturas_gasto SET activo = 0');
  assert.equal(fleteEntradaAdelantado(db, 7).neto, 0);
});

test('a precio cerrado lo absorbemos: el viaje sin valorizar no frena la liquidación', () => {
  assert.equal(freno(base({ precio: 'cerrado' })), null);
  assert.equal(freno(base({ cargo: 'comprador' })), null, 'el del comprador no cambió: no frena por esto');
});

test('la venta de la partida lo prellena, también sin monto en la orden si ya hay factura', () => {
  const v = tramo(SG, 'function ventaDePartida(db, ocId) {', '\r\n}');
  assert.match(v, /o\.flete_a_cargo, o\.flete_pagado_por, o\.flete_monto, o\.flete_con_iva,/);
  assert.match(v, /se_cobra: \(\(oc\.flete_a_cargo === 'comprador' && fMonto > 0\)\r?\n\s+\|\| \(esFleteEntradaAdelantado\(oc\) && \(fMonto > 0 \|\| fHayFactura\)\)\) \? 1 : 0,/);
  assert.match(v, /entrada_sin_valorizar: esFleteEntradaAdelantado\(oc\) \? fleteEntradaAdelantado\(db, ocId\)\.sin_valorizar : 0,/);
  const fusion = tramo(SG, 'function fusionarVentas(', '\r\n}');
  assert.match(fusion, /entrada_sin_valorizar: partes\.reduce\(\(a, p\) => a \+ \(Number\(\(p\.flete \|\| \{\}\)\.entrada_sin_valorizar\) \|\| 0\), 0\),/);
});

test('el costo del lote: a pizarra no entra, a precio cerrado sí, y el del comprador siempre', () => {
  const i = SG.indexOf("const dt = db.prepare(`SELECT COALESCE(SUM(g.monto),0) s FROM sg_gastos_directos g");
  assert.ok(i > 0, 'no está la consulta del costo del lote');
  const sql = SG.slice(SG.indexOf('`', i) + 1, SG.indexOf('`)', i));
  const costo = (precio, cargo, quien = 'san_geronimo') => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE sg_gastos_directos (id INTEGER PRIMARY KEY, recepcion_id INTEGER, tipo_gasto TEXT,
               estado TEXT, activo INTEGER, monto REAL);
             CREATE TABLE sg_recepciones (id INTEGER PRIMARY KEY, oc_id INTEGER);
             CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, flete_a_cargo TEXT, tipo_precio TEXT, flete_pagado_por TEXT);
             INSERT INTO sg_recepciones VALUES (55, 7);
             INSERT INTO sg_gastos_directos VALUES (1, 55, 'flete_entrada', 'valorizado', 1, 3000),
                                                   (2, 55, 'descarga_ingreso', 'valorizado', 1, 500);`);
    db.prepare('INSERT INTO sg_oc VALUES (7, ?, ?, ?)').run(cargo, precio, quien);
    return db.prepare(sql).get(55).s;
  };
  assert.equal(costo('pizarra', 'vendedor'), 500, 'el adelantado a pizarra se recupera: no es costo');
  assert.equal(costo('cerrado', 'vendedor'), 3500, 'a precio cerrado lo absorbemos: es costo de la partida');
  assert.equal(costo(null, 'vendedor'), 3500, 'sin tipo de precio cuenta como cerrado, igual que en la liquidación');
  assert.equal(costo('cerrado', 'vendedor', 'productor'), 500, 'el que pagó el productor nunca es costo nuestro');
  assert.equal(costo('pizarra', 'comprador'), 3500);
  // Y cambiar la condición de la orden, o quién paga el flete, lo rehace.
  assert.match(SG, /if \(precioNuevo !== oc\.tipo_precio\) recalcLotesDeOC\(db, oc\.id\);/);
  assert.match(SG, /if \(circ\.tipoPrecio !== oc\.tipo_precio\) recalcLotesDeOC\(db, oc\.id\);/);
  assert.match(SG, /if \(\['flete_a_cargo', 'flete_pagado_por'\]\.some\(\(c\) => req\.body\[c\] !== undefined\)\) \{\r?\n\s+recalcLotesDeOC\(db, Number\(req\.params\.id\)\);/);
  const rehace = fuente(SG, 'function recalcLotesDeOC(');
  assert.match(rehace, /recalcCostoLote\(db, l\.id\);\r?\n\s+recalcMargenDespachos\(db, l\.id\);/);
});

// ══ 2 · EL FLETE DE SALIDA DE LO QUE EL CLIENTE DEVOLVIÓ ═══════════════════

function conSalidaAdelantada({ renglones = true } = {}) {
  const db = base({ cargo: 'comprador' });
  db.exec(`UPDATE sg_despachos SET flete_a_cargo = 'productor', flete_pagado_por = 'san_geronimo';
    INSERT INTO sg_gastos_directos (id, tipo_gasto, despacho_id, proveedor_servicio_id, estado, monto)
      VALUES (9, 'flete_salida', 10, 77, 'valorizado', 3000);
    INSERT INTO sg_devoluciones VALUES (1, 10, 'registrada');
    INSERT INTO sg_devolucion_items VALUES (1, 1, 101, 1, 25, 450, 'stock');`);
  if (renglones) db.exec('INSERT INTO sg_gasto_flete_lineas (gasto_id, despacho_item_id, monto) VALUES (9, 101, 3000)');
  return db;
}

test('el flete de lo devuelto no se le descuenta al productor: es pérdida de la partida', () => {
  const db = conSalidaAdelantada();
  assert.equal(resumenSalidaAdelantada(db, 7).neto, 2250, 'le descuenta el flete de 25 cajones que volvieron');
  db.exec("UPDATE sg_devoluciones SET estado = 'anulada'");
  assert.equal(resumenSalidaAdelantada(db, 7).neto, 3000, 'una devolución anulada no es pérdida');
  // Devuelto de más no da negativo.
  db.exec("UPDATE sg_devoluciones SET estado = 'registrada'; UPDATE sg_devolucion_items SET bultos = 999");
  assert.equal(resumenSalidaAdelantada(db, 7).neto, 0);
});

test('el remito valorizado entero, antes de la V1045, también descuenta lo devuelto', () => {
  assert.equal(resumenSalidaAdelantada(conSalidaAdelantada({ renglones: false }), 7).neto, 2250);
});

test('y el margen del remito se queda con esa pérdida: no la da por recuperada', () => {
  const aRecuperar = new Function('r2', fuente(SG, 'function fleteARecuperarDeRemito(') + '\nreturn fleteARecuperarDeRemito;')(r2);
  assert.equal(aRecuperar(conSalidaAdelantada(), 10), 2250);
  assert.equal(aRecuperar(conSalidaAdelantada({ renglones: false }), 10), 2250);
});

// ══ 3 · EL CONTROL DEL SERVIDOR Y LA PANTALLA ══════════════════════════════

test('el servidor no deja emitir con la fila «Flete» por debajo del flete de entrada adelantado', () => {
  const frenoGrilla = new Function('resumenSalidaAdelantada', 'fleteEntradaAdelantado',
    fuente(LIQ, 'function frenoFleteSalidaEnGrilla(') + '\nreturn frenoFleteSalidaEnGrilla;')(
    resumenSalidaAdelantada, fleteEntradaAdelantado);
  const db = base();
  viaje(db, 1, 55, 3000);
  viaje(db, 2, 56, 2000);
  facturar(db, [[1, 3000], [2, 2000]]);
  const con = (flete) => ({ modo_precio: 'abierto', grilla: { fiscal: { flete } } });
  assert.match(frenoGrilla(db, [{ oc_id: 7 }], con(4000)), /tiene \$4\.000,00 y el flete que San Gerónimo le adelantó al productor —de entrada y de salida— es \$5\.000,00/);
  assert.equal(frenoGrilla(db, [{ oc_id: 7 }], con(5000)), null);
});

test('la pantalla frena por los viajes sin valorizar, y el renglón dice de quién es el flete', () => {
  const frenosSrc = tramo(PANEL, '    // ── EL FLETE DE ENTRADA QUE SE LE ADELANTÓ (V1048)', '    LIQ.frenos = frenos;');
  const frenos = (flete) => {
    const f = [];
    new Function('r', 'frenos', 'escH', frenosSrc)({ flete }, f, (x) => String(x));
    return f;
  };
  assert.match(frenos({ entrada_sin_valorizar: 2 })[0], /El <b>flete de entrada<\/b> lo adelantó San Gerónimo y todavía hay viajes <b>sin valorizar<\/b>/);
  assert.deepEqual(frenos({ entrada_sin_valorizar: 0 }), []);

  const PG = tramo(PANEL, '  var pg = function(id, val){', "  pg('liq-g-f-ventas', r.neto);");
  const PRELLENO = tramo(PANEL, '  var fl = r.flete || {};\r\n', '  // Y SI QUEDARON ABIERTAS, SE DICE POR QUÉ.');
  const campos = {};
  const LIQ_ = { origen: {} };
  new Function('r', 'LIQ', 'eid', 'liqNumPoner', 'sgMoney', 'escH', PG + PRELLENO)(
    { flete: { se_cobra: 1, neto: 5000, iva: 1050, adelantado: 1, salida: {} } }, LIQ_,
    (id) => (campos[id] = campos[id] || { value: '' }), (e, n) => { e.value = n; }, (n) => '$' + n, (x) => String(x));
  assert.equal(campos['liq-g-f-flete'].value, 5000);
  assert.equal(LIQ_.origen.flete, 'de la orden de compra — lo adelantó San Gerónimo');
});

// ══ 4 · LOS «¿CÓMO SE USA?» DICEN LO QUE EL CÓDIGO HACE ════════════════════

const manual = (clave) => {
  const i = PANEL.indexOf('SG_MANUAL.' + clave + ' = {');
  assert.ok(i > 0, 'no está el manual de ' + clave);
  return PANEL.slice(i, PANEL.indexOf('\r\n};', i)).replace(/'\r?\n\s*\+ '/g, '');
};

test('manual de Liquidaciones: el de entrada llega solo, frena sin valorizar, y lo devuelto es pérdida', () => {
  const M = manual('liquidaciones');
  assert.match(M, /<span class="ver">V1048<\/span> el <b>flete de entrada que San Gerónimo le adelantó<\/b> tiene viajes sin valorizar/);
  assert.match(M, /Y también el flete de <b>entrada<\/b> que San Gerónimo le adelantó al productor, con la misma regla: sólo a pizarra/);
  assert.match(M, /el flete de salida de lo devuelto <b>no se le descuenta<\/b>: es pérdida de la partida/);
  assert.match(M, /Siguen <b>a mano<\/b>: los gastos administrativos a precio abierto/);
});

test('manual de Gastos Directos: lo devuelto, el de entrada, y la carga con el asiento de la descarga', () => {
  const M = manual('gastos');
  assert.match(M, /el flete de lo devuelto no se le descuenta al productor: es <b>pérdida de la partida<\/b>/);
  assert.match(M, /El flete de <b>entrada<\/b> que adelanta San Gerónimo se le descuenta igual, solo, en la liquidación a pizarra/);
  assert.match(M, /A precio cerrado entra al costo de la partida/);
  assert.match(M, /Tiene su <b>propio asiento modelo<\/b>, aparte del de la descarga/);
  // Y así es: la carga está en el circuito de la descarga.
  assert.match(SG, /descarga:\s+\{ tipos: \['descarga_ingreso', 'carga_salida'\]/);
});

test('manuales de Remitos y de Órdenes de Compra, y la ayuda de la orden', () => {
  const V = manual('ventas');
  assert.match(V, /el flete de lo que el cliente devolvió <b>no se le descuenta<\/b>: es pérdida de la partida/);
  const vs = [...V.slice(V.indexOf('Qué cambió, y desde cuándo')).matchAll(/<li><b>V(\d+)<\/b>/g)].map((m) => Number(m[1]));
  assert.equal(vs[vs.length - 1], 1048);
  const O = manual('oc');
  assert.match(O, /<span class="ver">V1048<\/span> Se le descuenta <b>solo<\/b> en las partidas a pizarra; a precio cerrado lo absorbemos nosotros/);
  assert.match(O, /El primero y el último aparecen en Gastos Directos → Fletes de entrada/);
  assert.match(PANEL, /'vendedor\|san_geronimo': '<b>Lo adelanta San Gerónimo y se le recupera al productor\.<\/b> '[\s\S]{0,400}<b>Sólo a pizarra<\/b>: a precio cerrado el productor cobra lo pactado, ese flete lo absorbemos/);
  // Y la bandeja de fletes de entrada no dice «a recuperar del productor» a precio cerrado.
  assert.match(SG, /const aRecuperar = \(x\) => adelantado\(x\) && x\.tipo_precio === 'pizarra';/);
  assert.match(SG, /a_recuperar: aRecuperar\(x\) \};/);
  assert.match(SG, /o\.flete_a_cargo, o\.flete_pagado_por, o\.tipo_precio,/);
});

test('los manuales no citan una versión que el panel todavía no alcanzó', () => {
  const actual = Number((leer('src/sidebar-v2.js').match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const k of ['liquidaciones', 'gastos', 'ventas', 'oc']) {
    for (const v of (manual(k).match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
      assert.ok(v <= actual, `el manual de ${k} cita la V${v} y el panel va en la V${actual}`);
    }
  }
});

// ══ 5 · LO QUE ENCONTRÓ LA REVISIÓN ════════════════════════════════════════

test('una orden adelantada sin monto de flete igual aparece para valorizar: si no, la partida se traba', () => {
  // Sin la fila en la bandeja no habría dónde valorizarlo, y el freno no deja liquidar.
  assert.match(SG, /\.filter\(\(x\) => x\.estimado > 0 \|\| x\.gasto_id \|\| \(aRecuperar\(x\) && x\.lotes > 0\)\)/);
  assert.equal(fleteEntradaAdelantado(base(), 7).sin_valorizar, 2);
  const M = manual('gastos');
  assert.match(M, /aparecen en <b>Fletes de entrada<\/b> aunque el comprador no haya dejado pactado el monto en la orden/);
  assert.match(M, /si la orden cambia de condición, el costo de lo que ya entró se rehace/);
  assert.match(manual('oc'), /Si la condición de la orden cambia después, el costo de lo que ya entró se rehace/);
});

test('lo devuelto de un renglón sin cajones se mide en kilos', () => {
  const aRecuperar = new Function('r2', fuente(SG, 'function fleteARecuperarDeRemito(') + '\nreturn fleteARecuperarDeRemito;')(r2);
  for (const renglones of [true, false]) {
    const db = conSalidaAdelantada({ renglones });
    db.exec('UPDATE sg_despacho_items SET bultos = NULL; UPDATE sg_devolucion_items SET bultos = 0, kg = 900');
    assert.equal(resumenSalidaAdelantada(db, 7).neto, 1500, 'le descuenta entero el flete de lo que volvió');
    assert.equal(aRecuperar(db, 10), 1500, 'el margen da por recuperado el flete de lo que volvió');
  }
});

test('el grupo dice «lo adelantó San Gerónimo» sólo si todo lo que se cobra lo es', () => {
  const fusionarVentas = new Function('r2', fuente(SG, 'function fusionarVentas(') + '\nreturn fusionarVentas;')(r2);
  const parte = (oc, flete) => ({ oc_id: oc, partida: 'P' + oc, proveedor: { id: 1 }, es_precio_cerrado: 0,
    acordado: {}, articulos: [], mermas: [], lineas: [], descarga: { monto: 0, n: 0 }, sin_valorizar: {},
    sin_factura: {}, comprobantes: [], flete: Object.assign({ salida: {} }, flete) });
  const mixto = fusionarVentas([parte(7, { se_cobra: 1, neto: 100, adelantado: 1, entrada_sin_valorizar: 1 }),
                                parte(8, { se_cobra: 1, neto: 50, adelantado: 0, entrada_sin_valorizar: 2 })]);
  assert.equal(mixto.flete.entrada_sin_valorizar, 3);
  assert.equal(mixto.flete.adelantado, 0, 'dice «lo adelantó San Gerónimo» sobre el flete de un comprador');
  const todo = fusionarVentas([parte(7, { se_cobra: 1, neto: 100, adelantado: 1 }),
                               parte(8, { se_cobra: 0, neto: 0, adelantado: 0 })]);
  assert.equal(todo.flete.adelantado, 1, 'la que no se cobra no cuenta');
});

test('un viaje que se quedó sin mercadería no pide valorizarse: no hubo flete que pagar', () => {
  const db = base();
  viaje(db, 1, 55, 3000);
  facturar(db, [[1, 3000]]);
  assert.equal(fleteEntradaAdelantado(db, 7).sin_valorizar, 1);
  // Los lotes del segundo viaje se borraron por mal cargados.
  db.exec('UPDATE sg_lotes SET activo = 0 WHERE recepcion_id = 56');
  assert.equal(fleteEntradaAdelantado(db, 7).sin_valorizar, 0, 'pide inventar un flete para un viaje sin mercadería');
  assert.equal(freno(db), null);
  // Y la bandeja tampoco lo ofrece: la misma condición.
  assert.match(SG, /\(SELECT COUNT\(\*\) FROM sg_lotes l\r?\n\s+WHERE l\.recepcion_id = r\.id AND l\.activo = 1\) AS lotes,/);
  assert.match(manual('gastos'), /Un viaje que se quedó sin mercadería —sus lotes se borraron por mal cargados— no pide valorizarse/);
});

test('la carga de la cooperativa tiene su propio asiento modelo desde la V1051', () => {
  assert.match(manual('gastos'), /<span class="ver">V1051<\/span> Tiene su <b>propio asiento modelo<\/b>/);
  assert.ok(!/entrada<\/b> adelantado todavía se tipea a mano|el flete de ENTRADA\r?\n\/\/ adelantado todavía se tipea a mano/.test(LIQ));
});
