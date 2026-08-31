// ══ LA LIQUIDACIÓN QUE NOS EMITEN, CON SUS DOS LIBROS ══════════════════════
//
// Pablo, 30/8/2026: «vamos a liquidación recibida en remitos pendientes. La pantalla
// debería ser similar a la que tenemos en liquidaciones emitidas. Recordá que acá
// también tenemos que tener alternativa fiscal y de gestión: puede ser que acordamos
// un precio —el que ponemos en el remito SIEMPRE— y nos liquiden menos por algún
// error administrativo. Permitime acá poner la venta y los IVAs de las liquidaciones
// recibidas también. Mostrame asiento contable abajo para administradores».
//
// Es el espejo exacto de la compra: un comprobante, dos libros. Al cliente se le
// factura lo que dice SU papel y se le sigue debiendo lo acordado; la diferencia es
// de gestión y necesita motivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VEN = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const FIN = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg_finanzas.js'), 'utf8');

// El armador REAL, sacado del router. MOTIVOS se inyecta: vive en servicios/asientos.js
// y tiene sus propios tests.
function traerArmador() {
  const i = VEN.indexOf('export function armarLineasLiq(db, d) {');
  assert.ok(i > 0, 'no existe armarLineasLiq');
  const src = VEN.slice(i, VEN.indexOf('\n}', i) + 2).replace('export function', 'function');
  const MOTIVOS = { error_proveedor: {}, comprobante_pendiente: {},
    diferencia_peso_calidad: {}, ajuste_gestion: {} };
  // eslint-disable-next-line no-new-func
  return new Function('MOTIVOS', src + '; return armarLineasLiq;')(MOTIVOS);
}
const armar = traerArmador();

function base(opts = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sg_clientes (id INTEGER PRIMARY KEY, razon_social TEXT, cuenta_contable_id INTEGER);
    CREATE TABLE sg_config_impositiva (clave TEXT, cuenta_id INTEGER)`);
  db.prepare('INSERT INTO sg_clientes VALUES (1, ?, ?)')
    .run('DE FRUTOS SRL', opts.sinCuenta ? null : 100);
  const ins = db.prepare('INSERT INTO sg_config_impositiva VALUES (?,?)');
  ins.run('ventas', 200);
  if (!opts.sinIvaDebito) ins.run('iva_debito_fiscal', 210);
  ins.run('liq_recibida_gastos', 300);
  ins.run('percepcion_iva', 400);
  ins.run('retencion', 410);
  return db;
}
const suma = (ls, campo, amb) => Math.round(ls
  .filter((l) => (l.ambito || 'fiscal') === amb)
  .reduce((a, l) => a + (l[campo] || 0), 0) * 100) / 100;

// ── 1 · EL IVA DE LA LIQUIDACIÓN ES DÉBITO FISCAL ──────────────────────────

test('la liquidación que nos emiten genera IVA débito, y el asiento lo lleva', () => {
  // Es NUESTRO comprobante de venta. Sin esta línea, el asiento acreditaba Ventas por
  // el bruto y la operación no entraba al libro de IVA ventas.
  const db = base();
  const { lineas, falta } = armar(db, { cliente_id: 1, numero: 'L-1',
    precio_bruto: 100000, iva: 21000, neto_acreditar: 121000 });
  assert.deepEqual(falta, []);
  const iva = lineas.find((l) => l.cuenta_id === 210);
  assert.ok(iva, 'no hay línea de IVA débito');
  assert.equal(iva.haber, 21000);
  assert.equal(iva.debe, 0);
});

test('y el asiento balancea con el IVA adentro', () => {
  // El cliente nos debe el bruto MÁS el IVA: es plata que él nos acredita y que
  // nosotros le debemos a la AFIP.
  const db = base();
  const { lineas } = armar(db, { cliente_id: 1, numero: 'L-1',
    precio_bruto: 100000, iva: 21000, neto_acreditar: 121000 });
  assert.equal(suma(lineas, 'debe', 'fiscal'), suma(lineas, 'haber', 'fiscal'));
  assert.equal(suma(lineas, 'haber', 'fiscal'), 121000);
});

test('con descuentos y retenciones también cierra', () => {
  // debe = neto + retenciones + gastos ; haber = bruto + IVA
  const db = base();
  const d = { cliente_id: 1, numero: 'L-1', precio_bruto: 100000, iva: 21000,
    desc_comision: 8000, desc_flete: 2000, ret_iva: 3000, ret_otras: 1000 };
  d.neto_acreditar = 100000 + 21000 - 10000 - 4000;
  const { lineas } = armar(db, d);
  assert.equal(suma(lineas, 'debe', 'fiscal'), suma(lineas, 'haber', 'fiscal'));
  assert.equal(suma(lineas, 'debe', 'fiscal'), 121000);
});

test('sin IVA cargado, el asiento queda como estaba', () => {
  // Las liquidaciones que ya existen valen cero: el cambio no puede moverles el
  // asiento.
  const db = base();
  const { lineas } = armar(db, { cliente_id: 1, numero: 'L-1',
    precio_bruto: 100000, neto_acreditar: 100000 });
  assert.equal(lineas.filter((l) => l.cuenta_id === 210).length, 0);
  assert.equal(suma(lineas, 'debe', 'fiscal'), suma(lineas, 'haber', 'fiscal'));
});

test('y si falta la cuenta de IVA débito, se dice antes de guardar', () => {
  // Un asiento que no se puede armar bien no se arma: la venta no entra fuera del
  // libro.
  const db = base({ sinIvaDebito: true });
  const { lineas, falta } = armar(db, { cliente_id: 1, numero: 'L-1',
    precio_bruto: 100000, iva: 21000, neto_acreditar: 121000 });
  assert.equal(lineas.length, 0);
  assert.ok(falta.some((f) => /IVA Débito Fiscal/.test(f)), falta.join(' | '));
});

// ── 2 · LO ACORDADO QUE NO DECLARARON ES GESTIÓN ───────────────────────────

test('la diferencia con lo acordado va de gestión, en el mismo asiento', () => {
  // Un solo asiento —un solo número, el que se cita cuando hay que discutir algo—
  // con las líneas fiscales y las de gestión.
  const db = base();
  const { lineas } = armar(db, { cliente_id: 1, numero: 'L-1',
    precio_bruto: 100000, iva: 21000, neto_acreditar: 121000,
    dif_gestion: 15000, dif_motivo: 'error_proveedor' });
  const ges = lineas.filter((l) => l.ambito === 'gestion');
  assert.equal(ges.length, 2);
  assert.ok(ges.every((l) => l.motivo === 'error_proveedor'), 'sin motivo no entra');
  // El cliente al debe —nos debe más— contra Ventas al haber.
  assert.equal(ges.find((l) => l.cuenta_id === 100).debe, 15000);
  assert.equal(ges.find((l) => l.cuenta_id === 200).haber, 15000);
});

test('y cada ámbito balancea POR SU CUENTA', () => {
  // Que el total cierre no alcanza: lo fiscal puede estar descuadrado y la gestión
  // compensarlo al revés, y el asiento diría «balancea» con el libro fiscal mal.
  const db = base();
  const { lineas } = armar(db, { cliente_id: 1, numero: 'L-1',
    precio_bruto: 100000, iva: 21000, neto_acreditar: 121000,
    dif_gestion: 15000, dif_motivo: 'ajuste_gestion' });
  assert.equal(suma(lineas, 'debe', 'fiscal'), suma(lineas, 'haber', 'fiscal'));
  assert.equal(suma(lineas, 'debe', 'gestion'), suma(lineas, 'haber', 'gestion'));
});

test('SIN IVA del lado de gestión', () => {
  // El débito fiscal sale del comprobante y de nada más (regla del repo).
  const db = base();
  const { lineas } = armar(db, { cliente_id: 1, numero: 'L-1',
    precio_bruto: 100000, iva: 21000, neto_acreditar: 121000,
    dif_gestion: 15000, dif_motivo: 'ajuste_gestion' });
  assert.equal(lineas.filter((l) => l.ambito === 'gestion' && l.cuenta_id === 210).length, 0);
});

// ── 3 · LA PANTALLA ────────────────────────────────────────────────────────

test('la columna del IVA existe en la base', () => {
  assert.match(FIN, /ALTER TABLE sg_ven_liquidaciones ADD COLUMN iva REAL NOT NULL DEFAULT 0/);
});

test('el IVA se pide en la pantalla y suma al neto a acreditar', () => {
  // Es plata que el cliente nos debe y que nosotros le debemos a la AFIP, no un
  // descuento.
  assert.match(PANEL, /id="sg-liqrec-iva"/);
  const i = PANEL.indexOf('function sgLiqRecDatos(){');
  const b = PANEL.slice(i, i + 2400);
  assert.match(b, /var iva = v\('sg-liqrec-iva'\);/);
  assert.match(b, /neto_acreditar: m2\(bruto \+ iva - desc - ret\)/);
});

test('y se guarda: el POST lo escribe y lo manda al asiento', () => {
  assert.match(VEN, /ret_iva, ret_ganancias, ret_iibb, ret_otras, neto_acreditar, usuario_id, iva\)/);
  assert.match(VEN, /const neto_acreditar = precio_bruto \+ ivaLiq - descuentos - retenciones;/);
  assert.match(VEN, /cliente_id, numero, precio_bruto, neto_acreditar, iva: ivaLiq,/);
});

test('la grilla muestra fiscal, gestión y total, como la liquidación que emitimos', () => {
  assert.match(PANEL, /id="sg-liqrec-vf"/);
  assert.match(PANEL, /id="sg-liqrec-vg"/);
  assert.match(PANEL, /id="sg-liqrec-vt"/);
  // Y la fila de IVA no tiene gestión: el débito fiscal sale del comprobante.
  const i = PANEL.indexOf('id="sg-liqrec-iva"');
  assert.match(PANEL.slice(i, i + 500), /sin IVA en gesti/);
});

test('el precio del REMITO es lo acordado, y se guarda aparte del que se tipea', () => {
  // El del papel del cliente se escribe encima. Guardar el original es lo único que
  // permite después decir cuánto se resignó y por qué.
  const i = PANEL.indexOf('SGLR.items = d.items.map(function(it){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 1800);
  assert.match(b, /precio_acordado: it\.precio_por_kg != null \? it\.precio_por_kg : 0/);
});

test('y la diferencia sale de comparar los dos, sólo si liquidaron de MENOS', () => {
  // Si liquidaron de más no hay gestión: lo que vale es el comprobante.
  const i = PANEL.indexOf('var acordado = m2(SGLR.items.reduce(');
  assert.ok(i > 0, 'la pantalla no calcula lo acordado');
  const b = PANEL.slice(i, i + 600);
  assert.match(b, /Number\(it\.precio_acordado\)/);
  assert.match(b, /var dif = m2\(Math\.max\(0, acordado - bruto\)\);/);
});

test('el motivo se pide sólo si hay diferencia, y no se registra sin él', () => {
  // Pedirlo en cero es pedir un dato que no existe. El servidor lo exige igual.
  const i = PANEL.indexOf("var fm = eid('sg-liqrec-motivo-fila');");
  assert.ok(i > 0);
  assert.match(PANEL.slice(i, i + 200), /fm\.style\.display = d\._dif > 0 \? '' : 'none'/);
  const g = PANEL.indexOf('function sgLiqRecGuardar(){');
  const b = PANEL.slice(g, g + 2600);
  assert.match(b, /if \(d\._dif > 0 && !d\.dif_motivo\) \{/);
  assert.match(b, /se le siguen debiendo al cliente/);
});

test('y son los CUATRO motivos de siempre, no texto libre', () => {
  const i = PANEL.indexOf("var mo = eid('sg-liqrec-motivo');");
  assert.ok(i > 0);
  assert.match(PANEL.slice(i, i + 500), /Object\.keys\(SG_MOTIVOS\)\.map\(function\(k\)\{/);
});

test('la diferencia viaja al servidor con su motivo', () => {
  const g = PANEL.indexOf('function sgLiqRecGuardar(){');
  const b = PANEL.slice(g, g + 2600);
  assert.match(b, /iva: d\.iva, dif_gestion: d\.dif_gestion, dif_motivo: d\.dif_motivo,/);
});

test('y el asiento sigue abajo, plegado y para administradores', () => {
  // Regla del repo: toda operación que asienta muestra el asiento, al que puede
  // leerlo. sgAsientoCuadro ya envuelve con sgAsientoPlegado.
  assert.match(PANEL, /id="sg-liqrec-asiento"/);
  const i = PANEL.indexOf("var c = eid('sg-liqrec-asiento'); if (!c) return;");
  assert.ok(i > 0);
  assert.match(PANEL.slice(i, i + 900), /sgAsientoCuadro\(\{ falta: r\.falta, lineas: r\.lineas, totales: r\.totales \}/);
  const p = PANEL.indexOf('function sgAsientoPlegado(html, titulo){');
  assert.match(PANEL.slice(p, p + 200), /if \(!sgAsientoEsAdmin\(\)\) return '';/);
});
