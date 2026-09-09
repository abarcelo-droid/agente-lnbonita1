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

test('el manual avisa que las facturas de servicio no están acá', () => {
  assert.match(MANUAL, /<b>Las facturas de servicio NO están acá todavía\.<\/b>/);
  assert.match(MANUAL, /no se pueden pagar '\r?\n?\s*\+ 'desde acá/);
  // Y dice por qué importa: el mayor y la pantalla dan distinto.
  assert.match(MANUAL, /el mayor de Proveedores y esta pantalla dan distinto/);
});

test('y es cierto: la cuenta corriente no lee sg_facturas_gasto', () => {
  // El día que se arregle, este test se pone en rojo y avisa que el párrafo del
  // manual hay que sacarlo. Es la única forma de que un hueco documentado no se
  // quede documentado para siempre.
  assert.ok(!/sg_facturas_gasto/.test(CC),
    'la CC ya lee las facturas de servicio: sacá el párrafo del hueco del manual');
  assert.match(CC, /FROM sg_facturas_compra f/);
  assert.match(CC, /FROM liquidaciones lq/);
});

test('ni un pago las puede cancelar: sólo factura o liquidación', () => {
  assert.match(PAGO, /String\(x\.tipo \|\| ''\) === 'liquidacion' \? 'liquidacion' : 'factura'/);
  assert.ok(!/sg_facturas_gasto/.test(PAGO),
    'el pago ya puede cancelar una factura de servicio: actualizá el manual');
});

test('pero su asiento SÍ le acredita al proveedor, que es de dónde sale la diferencia', () => {
  // Si no acreditara, no habría hueco: sería un gasto sin deuda. El hueco existe
  // justamente porque la deuda está en el libro y no en la pantalla.
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
