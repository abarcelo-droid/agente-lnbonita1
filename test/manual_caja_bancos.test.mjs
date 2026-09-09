// ══ EL «¿CÓMO SE USA?» DE CAJA Y BANCOS ═══════════════════════════════════
//
// Era la última pantalla grande de San Gerónimo sin manual. Y escribiéndolo
// apareció algo peor que la falta del manual: LA PANTALLA ENSEÑABA UNA REGLA QUE
// EL SERVIDOR NO APLICA.
//
// En tres lugares decía que una caja sin gente asignada «la mueve solamente un
// admin». puedeMoverCuenta() dice lo contrario: sin dueño la mueve cualquiera con
// permiso en el módulo. Al que lo leía le quedaba que no podía trabajar, y
// terminaba pidiendo que lo agreguen a una lista que justamente le CIERRA la caja
// al resto.
//
// Como en manual_remitos: el test NO controla que el texto exista, controla que
// lo que el manual AFIRMA siga siendo cierto en el código.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const TES = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_tesoreria.js'), 'utf8');

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

const MANUAL = trozo(PANEL, "SG_MANUAL.cajabancos = { titulo: 'Caja y Bancos'", '\r\n};');

// ══════════════════════════════════════════════════════════════════════════
// 1 · LA REGLA DE QUIÉN MUEVE UNA CAJA — Y LAS TRES FRASES QUE MENTÍAN
// ══════════════════════════════════════════════════════════════════════════

test('sin dueño la caja la mueve CUALQUIERA con permiso, y el manual lo dice', () => {
  const f = trozo(TES, 'export function puedeMoverCuenta(u, cuentaId) {', '\r\n}');
  assert.match(f, /if \(u\.rol === 'admin'\) return true;/);
  assert.match(f, /if \(!n\) return true;/, 'sin dueño ya no se abre a cualquiera');
  assert.match(MANUAL, /Si <b>no tiene a nadie<\/b>, la mueve <b>cualquiera con permiso en el módulo<\/b>/);
  assert.match(MANUAL, /<b>Asignar gente CIERRA la caja\.<\/b>/);
});

test('y la pantalla dejó de decir lo contrario en los tres lugares', () => {
  // No es un detalle de redacción: es la diferencia entre poder trabajar y creer
  // que no se puede.
  assert.ok(!/la caja la mueve solamente un admin/.test(PANEL));
  assert.ok(!/la caja la mueve sólo un admin/.test(PANEL));
  assert.ok(!/— sólo admin —/.test(PANEL), 'la columna sigue diciendo «sólo admin»');
  // Y dicen la regla real.
  assert.match(PANEL, /Sin nadie tildado la mueve cualquiera/);
  assert.match(PANEL, /— abierta —/);
  assert.match(PANEL, /queda abierta a cualquiera con permiso/);
});

test('«las que no podés mover no se te ofrecen» — y el server igual las corta', () => {
  assert.match(MANUAL, /<b>no se te ofrecen<\/b>/);
  // El front esconde, pero el que decide es el servidor: sin esto se podía meter
  // plata en la caja de otro escribiendo el número.
  assert.match(TES, /Esta cuenta tiene usuarios asignados y no estás entre ellos/);
  assert.match(TES, /puedo/, 'los GET ya no devuelven si se puede tocar la cuenta');
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LO QUE AFIRMA SOBRE LA PLATA
// ══════════════════════════════════════════════════════════════════════════

test('«el saldo sale de los movimientos, no del libro»', () => {
  assert.match(MANUAL, /<b>El saldo sale de los movimientos, no del libro\.<\/b>/);
  assert.match(TES, /saldo_fiscal/);
  assert.match(TES, /saldo_gestion/);
});

test('«el ámbito del movimiento manda; el de la caja se propone»', () => {
  assert.match(MANUAL, /El ámbito de la <b>caja<\/b> es lo que se <b>propone<\/b>/);
  // El POST toma el del cuerpo y sólo cae al de la caja si no viene.
  const p = trozo(TES, "router.post('/movimientos'", '\r\n});');
  assert.match(p, /ambito/);
  assert.match(p, /interno/, 'ya no traduce el interno de la caja');
});

test('«interno» y «gestión» son dos vocabularios de lo mismo, y se dice', () => {
  // Si no, el operador busca «interno» en el listado de movimientos y no lo
  // encuentra nunca.
  assert.match(MANUAL, /Son dos vocabularios para lo mismo\.<\/b>/);
  assert.match(MANUAL, /«Interno» de '\r?\n?\s*\+ 'la caja se traduce a «gestión»/);
  assert.match(TES, /'interno'/);
});

test('«un movimiento de gestión necesita motivo, y son cuatro»', () => {
  assert.match(MANUAL, /<b>gestión necesita motivo<\/b>, y son cuatro, no texto libre/);
  const p = trozo(TES, "router.post('/movimientos'", '\r\n});');
  assert.match(p, /motivo/);
});

test('«el ámbito sólo aplica a las cajas»', () => {
  assert.match(MANUAL, /Una <b>caja<\/b> puede ser <b>interna<\/b>/);
  assert.match(MANUAL, /Una <b>cuenta bancaria<\/b> es siempre fiscal/);
  assert.match(TES, /tipo === 'caja' && ambito === 'interno'/);
});

test('«entre cuenta corriente y caja de ahorro no hay diferencia»', () => {
  // Es cierto y conviene decirlo: el que elige uno de los dos pensando que cambia
  // algo, se queda esperando un comportamiento que no existe.
  assert.match(MANUAL, /<b>no hay ninguna diferencia de '\r?\n?\s*\+ 'comportamiento<\/b>/);
  // Lo que el código sí distingue es caja contra no-caja.
  assert.match(TES, /tipo === 'caja'/);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LOS CHEQUES
// ══════════════════════════════════════════════════════════════════════════

test('«un cheque no es plata en el banco hasta que se deposita»', () => {
  assert.match(MANUAL, /<b>no es plata en el banco<\/b>/);
  assert.match(MANUAL, /<b>Depositar<\/b> — recién ahí <b>sube el banco<\/b>/);
  // Recibir no mueve ninguna cuenta; depositar sí.
  const dep = trozo(TES, "router.post('/cheques-terceros/:id/depositar'", '\r\n});');
  assert.match(dep, /sg_fin_movimientos/);
});

test('«endosar saca el cheque de la cartera y NO mueve ninguna cuenta»', () => {
  assert.match(MANUAL, /<b>no mueve '\r?\n?\s*\+ 'ninguna cuenta<\/b>: no pasó por el banco/);
});

test('«el cheque se lleva su ámbito puesto», que es lo que evita el débito colgado', () => {
  assert.match(MANUAL, /<b>se lleva su ámbito puesto<\/b>/);
  assert.match(MANUAL, /débito de gestión en cartera que no se cancelaba nunca/);
  // Lo escribe la cobranza al recibirlo.
  const VEN = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');
  assert.match(VEN, /UPDATE sg_fin_cheques_terceros SET ambito=\?, motivo=\? WHERE id=\?/);
});

test('los cinco pasos del cheque están, y ninguno de más', () => {
  for (const paso of ['Recibir', 'Depositar', 'Endosar', 'Rechazar', 'Devolver']) {
    assert.ok(MANUAL.includes('<b>' + paso + '</b>'), 'falta el paso ' + paso);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LA PANTALLA Y LA REGLA DE PABLO
// ══════════════════════════════════════════════════════════════════════════

test('la pantalla tiene su botón y el manual cubre las cinco solapas', () => {
  const cab = trozo(PANEL, '<div class="ph-t">🏦 San Gerónimo · Caja y Bancos</div>', '</div>\r\n    </div>');
  assert.match(cab, /onclick="sgManualAbrir\('cajabancos'\)"/);
  for (const t of ['💵 Cajas', '🏦 Bancos', '📥 Cheques de terceros', '⛔ Rechazados', '⚖️ Conciliación']) {
    assert.ok(MANUAL.includes(t), 'el manual no menciona la solapa ' + t);
  }
});

test('y dice qué es parametrizar y qué es operar', () => {
  // Es la regla del repo, y acá se nota: dar de alta una cuenta es de admin;
  // cargar un movimiento es el trabajo del día.
  assert.match(MANUAL, /<b>Parametrizar<\/b>: dar de alta una cuenta/);
  assert.match(MANUAL, /<b>Operar<\/b>/);
});

test('el manual dice desde cuándo vale lo que cambió', () => {
  assert.match(MANUAL, /Quién puede mover una caja <span class="ver">V1033<\/span>/);
  const SIDEBAR = fs.readFileSync(path.join(RAIZ, 'src/sidebar-v2.js'), 'utf8');
  const actual = Number((SIDEBAR.match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const v of (MANUAL.match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
    assert.ok(v <= actual, 'el manual cita la V' + v + ' y el panel va en la V' + actual);
  }
});
