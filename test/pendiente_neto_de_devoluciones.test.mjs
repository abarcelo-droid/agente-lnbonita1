// ══ LO ENTREGADO SIN COMPROBANTE NO CUENTA LO QUE EL CLIENTE DEVOLVIÓ (V1050) ══
//
// Pablo, 11/9/2026: «el pendiente de comprobante debería descontar lo que se devolvió,
// por supuesto».
//
// La cuenta corriente de clientes sumaba como deuda la mercadería que el cliente ya había
// devuelto: no se le va a facturar nunca —la lista de lo facturable ya la restaba— y
// sin embargo le inflaba el saldo. Y la liquidación de una cadena podía documentar esos
// mismos kilos.
//
// El test corre la consulta REAL de la cuenta corriente sobre una base en memoria.
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
const SV = leer('src/rutas/sg_ventas.js');
const PANEL = leer('src/panel.html');

const { kgPapelSql, kgDelPapel, kgPendienteDelPapel } = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/sg_kilos_del_papel.js')).href);
const { facturaCuenta } = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/factura-cuenta.js')).href);

// La columna de la cuenta corriente, tal cual está en el router.
const FRAG = (() => {
  const desde = "        COALESCE((SELECT SUM((${kgPapelSql('di')}";
  const i = SG.indexOf(desde);
  assert.ok(i > 0, 'no está el pendiente de comprobante');
  const j = SG.indexOf('AS pendiente_comprobante,', i);
  assert.ok(j > i);
  return SG.slice(i, j) + 'AS pendiente_comprobante';
})();
const SQL = new Function('kgPapelSql', 'facturaCuenta',
  'return `SELECT c.id, ' + FRAG + ' FROM sg_clientes c ORDER BY c.id`;')(kgPapelSql, facturaCuenta);

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_clientes (id INTEGER PRIMARY KEY);
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, cliente_id INTEGER, activo INTEGER DEFAULT 1, estado TEXT);
    CREATE TABLE sg_despacho_items (id INTEGER PRIMARY KEY, despacho_id INTEGER, kg_despachados REAL,
      kg_declarados REAL, precio_por_kg REAL);
    CREATE TABLE sg_ven_facturas (id INTEGER PRIMARY KEY, afip_estado TEXT, estado TEXT);
    CREATE TABLE sg_factura_despachos (id INTEGER PRIMARY KEY, factura_id INTEGER, despacho_item_id INTEGER, kg REAL);
    CREATE TABLE sg_ven_liquidaciones (id INTEGER PRIMARY KEY, estado TEXT);
    CREATE TABLE sg_liquidacion_despachos (id INTEGER PRIMARY KEY, liquidacion_id INTEGER, despacho_id INTEGER,
      despacho_item_id INTEGER, kg REAL);
    CREATE TABLE sg_devoluciones (id INTEGER PRIMARY KEY, estado TEXT);
    CREATE TABLE sg_devolucion_items (id INTEGER PRIMARY KEY, devolucion_id INTEGER, despacho_item_id INTEGER, kg REAL);
    INSERT INTO sg_clientes VALUES (1), (2);
    -- Cliente 1: un remito de 1.000 kg a $10. Cliente 2, una cadena: declaró 15 kg de 14, a $100.
    INSERT INTO sg_despachos VALUES (10, 1, 1, 'despachado'), (20, 2, 1, 'despachado');
    INSERT INTO sg_despacho_items VALUES (101, 10, 1000, NULL, 10), (201, 20, 14, 15, 100);
  `);
  return db;
}
const pendiente = (db) => Object.fromEntries(db.prepare(SQL).all().map((r) => [r.id, Math.round(r.pendiente_comprobante * 100) / 100]));

test('sin devoluciones, lo de siempre', () => {
  assert.deepEqual(pendiente(base()), { 1: 10000, 2: 1500 });
});

test('lo que el cliente devolvió no es deuda sin comprobante', () => {
  const db = base();
  db.exec("INSERT INTO sg_devoluciones VALUES (1, 'registrada'); INSERT INTO sg_devolucion_items VALUES (1, 1, 101, 200);");
  assert.equal(pendiente(db)[1], 8000, 'le suma la mercadería que ya devolvió');
  // Una devolución anulada vuelve a contar.
  db.exec("UPDATE sg_devoluciones SET estado = 'anulada'");
  assert.equal(pendiente(db)[1], 10000);
});

test('con parte facturada y parte devuelta, queda lo que falta de verdad', () => {
  const db = base();
  db.exec("INSERT INTO sg_ven_facturas VALUES (1, 'aprobado', 'emitida'); INSERT INTO sg_factura_despachos VALUES (1, 1, 101, 500);"
    + "INSERT INTO sg_devoluciones VALUES (1, 'registrada'); INSERT INTO sg_devolucion_items VALUES (1, 1, 101, 200);");
  assert.equal(pendiente(db)[1], 3000);
  // Devuelto todo lo que quedaba: la fila se va.
  db.exec('UPDATE sg_devolucion_items SET kg = 500');
  assert.equal(pendiente(db)[1], 0);
});

test('lo devuelto de algo ya facturado no deja una deuda negativa que se come la de otros remitos', () => {
  const db = base();
  db.exec("INSERT INTO sg_ven_facturas VALUES (1, 'aprobado', 'emitida'); INSERT INTO sg_factura_despachos VALUES (1, 1, 101, 900);"
    + "INSERT INTO sg_devoluciones VALUES (1, 'registrada'); INSERT INTO sg_devolucion_items VALUES (1, 1, 101, 200);");
  assert.equal(pendiente(db)[1], 0, 'el renglón con más devuelto que pendiente resta de lo demás');
});

test('a una cadena, lo devuelto se lleva a kilos del papel: devolver los 14 cancela los 15', () => {
  const db = base();
  db.exec("INSERT INTO sg_devoluciones VALUES (1, 'registrada'); INSERT INTO sg_devolucion_items VALUES (1, 1, 201, 14);");
  assert.equal(pendiente(db)[2], 0, 'queda 1 kg del papel pendiente para siempre');
});

test('la liquidación de un cliente tampoco documenta lo que volvió', () => {
  // El control REAL de la ruta: el bloque que ata la liquidación a los renglones del remito.
  const i = SV.indexOf('      const vinculos = Array.isArray(req.body.vinculos) ? req.body.vinculos : [];');
  assert.ok(i > 0, 'no está el control de la liquidación del cliente');
  let prof = 0, k = SV.indexOf('{', SV.indexOf('      if (vinculos.length) {', i));
  for (; k < SV.length; k++) {
    if (SV[k] === '{') prof++;
    else if (SV[k] === '}') { prof--; if (prof === 0) break; }
  }
  const bloque = SV.slice(i, k + 1);
  const liquidar = (db, despacho, item, kg) => new Function('db', 'req', 'liqId', 'kgDelPapel', 'kgPendienteDelPapel', bloque)(
    db, { body: { vinculos: [{ despacho_id: despacho, despacho_item_id: item, kg }] } }, 1, kgDelPapel, kgPendienteDelPapel);

  const db = base();
  db.exec("INSERT INTO sg_devoluciones VALUES (1, 'registrada'); INSERT INTO sg_devolucion_items VALUES (1, 1, 101, 200);");
  assert.throws(() => liquidar(db, 10, 101, 900), /tiene 800 kg pendientes/, 'deja liquidar kilos que el cliente devolvió');
  assert.throws(() => liquidar(db, 10, 101, 900), /o que el cliente haya devuelto parte/, 'el cartel no dice la otra causa');
  liquidar(db, 10, 101, 800);
  // A una cadena, en kilos del papel: devolvió 7 de los 14 del galpón, que son 7,5 del papel.
  const db2 = base();
  db2.exec("INSERT INTO sg_devoluciones VALUES (1, 'registrada'); INSERT INTO sg_devolucion_items VALUES (1, 1, 201, 7);");
  assert.throws(() => liquidar(db2, 20, 201, 8), /tiene 7\.5 kg pendientes/);
  // La misma cuenta que la factura: kgPendienteDelPapel, no una cuenta a mano.
  assert.match(bloque, /const pend = kgPendienteDelPapel\(di, yaFac \+ yaLiq, devuelto\);/);
});

// ══ EL «¿CÓMO SE USA?» ═════════════════════════════════════════════════════

const manual = (clave) => {
  const i = PANEL.indexOf('SG_MANUAL.' + clave + ' = {');
  assert.ok(i > 0, 'no está el manual de ' + clave);
  return PANEL.slice(i, PANEL.indexOf('\r\n};', i)).replace(/'\r?\n\s*\+ '/g, '');
};

test('manual de CC clientes: «no cuenta lo que el cliente devolvió»', () => {
  const M = manual('ccclientes');
  assert.match(M, /<span class="ver">V1050<\/span> Y <b>no cuenta lo que el cliente devolvió<\/b>/);
  assert.match(M, /Tampoco se le puede cargar una liquidación por esos kilos/);
  const actual = Number((leer('src/sidebar-v2.js').match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const v of (M.match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
    assert.ok(v <= actual, `el manual cita la V${v} y el panel va en la V${actual}`);
  }
});
