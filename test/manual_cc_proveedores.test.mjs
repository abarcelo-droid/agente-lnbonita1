// ══ EL «¿CÓMO SE USA?» DE CUENTA CORRIENTE DE PROVEEDORES ═════════════════
//
// Y, escribiéndolo, la confirmación de un hueco: LAS FACTURAS DE SERVICIO NO
// ESTÁN EN LA CUENTA CORRIENTE.
//
// El flete de entrada, la descarga y la cooperativa se cargan en Gastos Directos
// y su asiento SÍ le acredita al proveedor — pero la consulta de la cuenta
// corriente lee sólo sg_facturas_compra y liquidaciones, y un pago sólo puede
// cancelar esos dos tipos. O sea: el mayor de Proveedores y esta pantalla dan
// distinto para un fletero, y esa deuda no se puede pagar desde ninguna pantalla.
//
// Se volvió más visible con la V1030, que hizo obligatoria la factura del fletero
// para poder liquidar: ahora hay que cargarla sí o sí, y una vez cargada no hay
// dónde verla ni cómo pagarla.
//
// El manual lo DICE, en vez de dejar que alguien lo descubra cuadrando. Este test
// clava las dos cosas: que el manual lo diga, y que siga siendo cierto — el día
// que se arregle, el test avisa que hay que sacar el párrafo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

const MANUAL = trozo(PANEL, "SG_MANUAL.ccproveedores = { titulo: 'Cuenta corriente de proveedores'", '\r\n};');
const CC = trozo(SG, "router.get('/cc-proveedores', requireAuth", '\r\n});');
const PAGO = trozo(SG, "router.post('/pagos', requireAuth", '\r\n});');

// ══════════════════════════════════════════════════════════════════════════
// 1 · EL HUECO, DICHO Y VERIFICADO
// ══════════════════════════════════════════════════════════════════════════

test('las facturas de servicio SÍ están en la cuenta corriente', () => {
  // Hasta la V1035 no estaban: su asiento acreditaba al proveedor pero la
  // pantalla no las leía, así que el mayor y la cuenta corriente daban distinto
  // para un fletero y esa deuda no se podía pagar desde ninguna pantalla.
  //
  // El test que estaba acá clavaba el hueco y se puso en rojo al arreglarlo, que
  // es exactamente para lo que estaba: un hueco documentado no se queda
  // documentado para siempre.
  assert.match(CC, /FROM sg_facturas_gasto fg/);
  assert.match(CC, /fg\.proveedor_servicio_id = p\.id AND fg\.activo = 1/);
  // Y sólo si están en el libro, como las otras dos.
  assert.match(CC, /JOIN sg_asientos a5 ON a5\.id = fg\.asiento_id AND COALESCE\(a5\.anulado,0\) = 0/);
  assert.ok(!/NO están acá todavía/.test(MANUAL), 'el manual sigue avisando de un hueco cerrado');
  assert.match(MANUAL, /<b>V1035<\/b> — las <b>facturas de servicio<\/b> entran a la cuenta corriente/);
});

test('y se pueden elegir para pagar, con las mismas columnas que las otras dos', () => {
  const P = trozo(SG, "router.get('/pagos/pendientes/:proveedorId'", '\r\n});');
  assert.match(P, /FROM sg_facturas_gasto fg/);
  assert.match(P, /'factura_gasto' AS tipo/);
  // Las mismas dos mitades: sin ellas, el que arma el pago no sabe cuánto puede
  // imputar a cada lado.
  assert.match(P, /AS pendiente_fiscal/);
  assert.match(P, /AS pendiente_gestion/);
});

test('el pago las reconoce y les baja el saldo a SU tabla', () => {
  const P = trozo(SG, "router.post('/pagos', requireAuth", '\r\n});');
  assert.match(P, /\['liquidacion', 'factura_gasto'\]\.includes\(String\(x\.tipo \|\| ''\)\)/);
  assert.match(P, /im\.tipo === 'factura_gasto'/);
  assert.match(P, /UPDATE sg_facturas_gasto/);
  assert.match(P, /x\.f\._tipo === 'factura_gasto' \? subeSaldoGasto/);
  // Y el proveedor sale de proveedor_servicio_id, no de proveedor_id: sin ese
  // alias el control de «es de otro proveedor» rechazaría todas.
  assert.match(P, /fg\.proveedor_servicio_id AS proveedor_id/);
});

test('y anular el pago le devuelve el saldo a la tabla correcta', () => {
  // Sin esta tercera rama, anular le devolvía el saldo a sg_facturas_compra POR
  // EL ID de una factura de servicio: le borraba la deuda a una factura de
  // mercadería que no tenía nada que ver, y la de servicio quedaba pagada para
  // siempre.
  const A = trozo(SG, "router.post('/pagos/:id/anular'", '\r\n});');
  assert.match(A, /const bajaGasto = db\.prepare\(`UPDATE sg_facturas_gasto/);
  assert.match(A, /else if \(t === 'factura_gasto'\) bajaGasto\.run/);
});

test('las dos columnas de saldo existen en la tabla', () => {
  // Sin ellas la factura aparecería en la cuenta corriente y no habría forma de
  // bajarla: la deuda quedaría para siempre.
  const DB = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');
  assert.match(DB, /\['saldo_pagado',\s+'REAL NOT NULL DEFAULT 0'\]/);
  assert.match(DB, /\['saldo_pagado_gestion',\s+'REAL NOT NULL DEFAULT 0'\]/);
});

test('pero su asiento SÍ le acredita al proveedor, que es de dónde salía la diferencia', () => {
  const fg = trozo(SG, "router.post('/gastos-factura', ", '\r\n});');
  assert.match(fg, /crearAsiento/);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LO QUE AFIRMA, ¿ES CIERTO?
// ══════════════════════════════════════════════════════════════════════════

test('«la deuda es lo acordado; el libro fiscal es lo facturado»', () => {
  assert.match(MANUAL, /<b>La deuda es lo acordado; el libro fiscal es lo facturado\.<\/b>/);
  // total + dif_gestion es como está implementado.
  assert.match(CC, /total \+ .*dif_gestion|dif_gestion/);
});

test('«contabilizado + sin facturar = saldo»', () => {
  assert.match(MANUAL, /dan el <b>saldo<\/b>/);
  const f = trozo(PANEL, 'function sgCcProvPintar(){', '\r\nfunction ');
  assert.match(f, /pendiente_gestion/);
});

test('«esperando el libro no suma al saldo»', () => {
  assert.match(MANUAL, /<b>No suman al saldo<\/b>/);
  assert.match(MANUAL, /pagarlas '\r?\n?\s*\+ 'dejaría la cuenta del proveedor deudora/);
  // Se cuentan aparte, y la deuda exige asiento vivo.
  assert.match(CC, /sin_contabilizar/);
  assert.match(CC, /anulado/);
});

test('«el proveedor de una liquidación sale de la orden»', () => {
  assert.match(MANUAL, /El '\r?\n?\s*\+ 'proveedor sale de la <b>orden<\/b>/);
  assert.match(CC, /FROM liquidaciones lq/);
  assert.match(CC, /sg_oc/);
});

test('«los saldos de la ficha los calcula el servidor»', () => {
  // Para que la ficha y el listado no puedan discrepar: son la misma plata vista
  // desde dos lugares.
  assert.match(MANUAL, /calcula el <b>servidor<\/b>, para que la ficha y el listado no puedan discrepar/);
  // Hasta la ruta SIGUIENTE, no hasta el primer `});`: el handler tiene varios
  // adentro y el corte quedaba antes de llegar a los saldos.
  const i = SG.indexOf("router.get('/cc-proveedores/:id'");
  assert.ok(i > 0);
  const f = SG.slice(i, SG.indexOf("\r\nrouter.", i + 10));
  assert.match(f, /saldo_fiscal: saldos\.fiscal/);
  assert.match(f, /saldo_gestion: saldos\.gestion/);
});

test('«HABER es lo que se le debe; DEBE es lo que se le pagó»', () => {
  assert.match(MANUAL, /<b>HABER es lo que se le debe; DEBE es lo que se le pagó\.<\/b>/);
  // Y la pantalla lo dice también, abajo de la tabla.
  assert.match(PANEL, /HABER es lo que se le debe/);
});

test('«una diferencia de gestión deja dos renglones, no se mezcla»', () => {
  assert.match(MANUAL, /deja <b>dos renglones<\/b>/);
  const f = trozo(SG, "router.get('/cc-proveedores/:id'", '\r\n});');
  assert.match(f, /Falta por facturar/);
  assert.match(f, /Facturado de más/);
});

test('«no se puede pagar más de lo que queda» y «cada mitad con lo suyo»', () => {
  assert.match(MANUAL, /<b>No se puede pagar más de lo que queda<\/b>/);
  assert.match(MANUAL, /<b>Cada mitad se paga con lo suyo\.<\/b>/);
  assert.match(PAGO, /pendiente_fiscal|pendiente_gestion|pendiente/);
});

test('«las cuentas que no podés mover no se te ofrecen»', () => {
  assert.match(MANUAL, /no se te ofrecen<\/b>/);
  assert.match(SG, /puedeMoverCuenta/);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LA PANTALLA Y LA VERSIÓN
// ══════════════════════════════════════════════════════════════════════════

test('la pantalla tiene su botón', () => {
  const cab = trozo(PANEL, '<div class="sec sg-mod" id="sec-sg-cc-proveedores">', '</div>\r\n    </div>');
  assert.match(cab, /onclick="sgManualAbrir\('ccproveedores'\)"/);
});

test('y el manual dice desde cuándo, sin citar una versión que no llegó', () => {
  assert.match(MANUAL, /<b>V1034<\/b> — esta pantalla estrena su <b>¿Cómo se usa\?<\/b>/);
  const SIDEBAR = fs.readFileSync(path.join(RAIZ, 'src/sidebar-v2.js'), 'utf8');
  const actual = Number((SIDEBAR.match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const v of (MANUAL.match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
    assert.ok(v <= actual, 'el manual cita la V' + v + ' y el panel va en la V' + actual);
  }
});
