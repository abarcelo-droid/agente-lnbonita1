// ══ LA NOTA DE DÉBITO ══════════════════════════════════════════════════════
//
// Es el espejo de la nota de crédito y por eso reusa casi todo. Lo que cambia es el
// sentido, y ahí está todo el riesgo: si en algún lado se la confunde con una nota de
// crédito, cobrarle más al cliente le BAJA la deuda.
//
//   · NC (3 y 8) le devuelve plata: baja la deuda, resta débito fiscal, asiento invertido.
//   · ND (2 y 7) le COBRA más: sube la deuda, suma débito fiscal, asiento de venta.
//
// Y la mercadería NO se mueve: no vuelven ni salen kilos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fiscalDeCliente, discriminaIva, esNotaDeDebito as esNDfiscal }
  from '../src/servicios/sg_fiscal.js';
import { esNotaDeCredito, esNotaDeDebito, signoFactura, deudaFactura,
  ncAplicadas, noEsNotaDeCredito, facturaCuenta } from '../src/servicios/factura-cuenta.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENTAS = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');
const EMISION = fs.readFileSync(path.join(RAIZ, 'src/servicios/afip-wsfe-emision.js'), 'utf8');
const ASIENTO = fs.readFileSync(path.join(RAIZ, 'src/servicios/asiento-venta.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const RI = { id: 1, razon_social: 'ASUNCION 4054 S.A.', cuit: '30712400125',
  categoria_fiscal: 'resp_inscripto' };
const CF = { id: 2, razon_social: 'ALBERTO', cuit: null, categoria_fiscal: 'no_inscripto' };

// ── 1. EL TIPO DE COMPROBANTE ───────────────────────────────────────────────
test('la clase pide el tipo: factura, nota de crédito o nota de DÉBITO', () => {
  // Antes esto era un booleano, y un booleano sólo tiene dos valores: no había forma
  // de pedir un 2 ni un 7.
  assert.equal(fiscalDeCliente(RI, { esNC: 'factura' }).cbte_tipo, 1, 'Factura A');
  assert.equal(fiscalDeCliente(RI, { esNC: 'nc' }).cbte_tipo, 3, 'Nota de crédito A');
  assert.equal(fiscalDeCliente(RI, { esNC: 'nd' }).cbte_tipo, 2, 'Nota de DÉBITO A');
  assert.equal(fiscalDeCliente(CF, { esNC: 'nd' }).cbte_tipo, 7, 'Nota de débito B');
  assert.equal(fiscalDeCliente(CF, { esNC: 'nc' }).cbte_tipo, 8);
});

test('el booleano viejo sigue funcionando', () => {
  // Lo mandan los llamadores de siempre; romperlos por un rename sería peor.
  assert.equal(fiscalDeCliente(RI, { esNC: true }).cbte_tipo, 3);
  assert.equal(fiscalDeCliente(RI, { esNC: false }).cbte_tipo, 1);
  assert.equal(fiscalDeCliente(RI, {}).cbte_tipo, 1);
});

test('la CLASE viaja entera hasta el motor: !!esNC la rompía', () => {
  // Con `!!esNC`, la cadena 'nd' se convertía en true y la nota de débito salía con
  // el tipo de una nota de crédito: le devolvía plata al cliente en vez de cobrársela.
  assert.match(EMISION, /const f = fiscalDeCliente\(cliente, \{ esNC, \.\.\.\(ctx \|\| \{\}\) \}\);/);
  assert.doesNotMatch(EMISION, /fiscalDeCliente\(cliente, \{ esNC: !!esNC/);
});

test('la letra A discrimina el IVA, sea cual sea el papel', () => {
  assert.equal(discriminaIva(1), true, 'Factura A');
  assert.equal(discriminaIva(3), true, 'Nota de crédito A');
  assert.equal(discriminaIva(2), true, 'Nota de DÉBITO A');
  // Sin esto, una ND A se imprimía con el IVA metido adentro del precio, como una B,
  // y el cliente responsable inscripto no podía tomarse el crédito fiscal.
  assert.equal(discriminaIva(6), false, 'Factura B');
  assert.equal(discriminaIva(7), false, 'Nota de débito B');
  assert.equal(discriminaIva(8), false);
});

test('la nota de débito A se guarda con la letra A', () => {
  // La cuenta decía `1 || 3` y dejaba el 2 afuera: una ND A quedaba guardada como 'B'
  // y el listado, los filtros y el libro la mostraban con la letra equivocada.
  assert.match(EMISION, /cbteTipo === 1 \|\| cbteTipo === 3 \|\| cbteTipo === 2/);
});

// ── 2. EL SENTIDO: LA ND SUMA ───────────────────────────────────────────────
test('una nota de débito NO es una nota de crédito', () => {
  assert.equal(esNotaDeCredito(2), false);
  assert.equal(esNotaDeCredito(7), false);
  assert.equal(esNotaDeDebito(2), true);
  assert.equal(esNotaDeDebito(7), true);
  assert.equal(esNotaDeDebito(3), false);
  assert.equal(esNDfiscal(2), true, 'y sg_fiscal dice lo mismo');
});

function dbCC() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_ven_facturas (id INTEGER PRIMARY KEY, cliente_id INTEGER, cbte_tipo INTEGER,
      total REAL, dif_gestion REAL DEFAULT 0, afip_estado TEXT, estado TEXT,
      nc_de_factura_id INTEGER);
    -- Factura por 121.000, una nota de crédito por 21.000 y una de DÉBITO por 5.000.
    INSERT INTO sg_ven_facturas VALUES (1,7,1,121000,0,'autorizado','pendiente',NULL);
    INSERT INTO sg_ven_facturas VALUES (2,7,3, 21000,0,'autorizado','pendiente',1);
    INSERT INTO sg_ven_facturas VALUES (3,7,2,  5000,0,'autorizado','pendiente',1);
  `);
  return db;
}

test('la nota de débito SUMA a la deuda del cliente', () => {
  const db = dbCC();
  const deuda = db.prepare(`SELECT COALESCE(SUM(${deudaFactura('f')}),0) s
    FROM sg_ven_facturas f WHERE f.cliente_id=7 AND ${facturaCuenta('f')}`).get().s;
  assert.equal(deuda, 105000, '121.000 − 21.000 de la nota de crédito + 5.000 de la de débito');
  assert.equal(db.prepare(`SELECT ${signoFactura('f')} s FROM sg_ven_facturas f WHERE f.id=3`).get().s, 1);
  assert.equal(db.prepare(`SELECT ${signoFactura('f')} s FROM sg_ven_facturas f WHERE f.id=2`).get().s, -1);
});

test('y NO cuenta como «ya acreditado»: cobrar más no baja la deuda', () => {
  // ncAplicadas filtra por el PUNTERO `nc_de_factura_id`, que las dos clases comparten.
  // Sin el filtro por tipo, la nota de débito de 5.000 contaba como acreditada: bajaba
  // lo pendiente de la factura, apagaba el botón de acreditar y frenaba la nota de
  // crédito de verdad con «ya está acreditado entero».
  const db = dbCC();
  const x = db.prepare(`SELECT ${ncAplicadas('f')} a FROM sg_ven_facturas f WHERE f.id=1`).get().a;
  assert.equal(x, 21000, 'sólo la nota de CRÉDITO');
  assert.notEqual(x, 26000);
});

test('la nota de débito SÍ se ofrece para cobrar', () => {
  // Es plata que el cliente debe y hay que ir a cobrársela. La de crédito no.
  const db = dbCC();
  const docs = db.prepare(`SELECT f.id FROM sg_ven_facturas f
    WHERE f.cliente_id=7 AND ${facturaCuenta('f')} AND ${noEsNotaDeCredito('f')}
    ORDER BY f.id`).all().map((r) => r.id);
  assert.deepEqual(docs, [1, 3], 'la factura y la nota de débito; la de crédito no');
});

// ── 3. EL ASIENTO VA PARA EL LADO DE UNA VENTA ──────────────────────────────
test('el asiento de una nota de débito es el de una venta, con su nombre', () => {
  // Los lados ya salían bien con esNC:false. Lo que mentía eran los TEXTOS: el asiento
  // decía «Factura 0001-00000012» sobre una nota de débito.
  assert.match(ASIENTO, /const PAPEL = \{ factura: 'Factura ', nc: 'Nota de crédito ', nd: 'Nota de débito ' \};/);
  assert.match(ASIENTO, /cl === 'nd' \? 'Ajuste a favor '/);
  assert.match(ASIENTO, /cl === 'nd' \? ' \(nota de débito\)'/);
  assert.match(EMISION, /function claseDeCbte\(t\)/);
  assert.match(EMISION, /nd: 'Nota de débito — '/);
});

// ── 4. LA MERCADERÍA NO SE MUEVE ────────────────────────────────────────────
test('una nota de débito no devuelve ni saca un solo kilo', () => {
  const i = VENTAS.indexOf("router.post('/facturas/:id(\\\\d+)/nota-debito'");
  assert.ok(i > 0, 'existe el camino para emitirla');
  const cuerpo = VENTAS.slice(i, i + 4500);
  assert.match(cuerpo, /vinculos: \[\]/, 'sin vínculos con el remito');
  assert.match(cuerpo, /descuentoGestion: 0/, 'ni parte de gestión: lo que se cobra está EN el comprobante');
  assert.match(cuerpo, /esNC: 'nd'/);
});

test('el signo del puente lo decide el TIPO, no lo que dijo el llamador', () => {
  // Con `!!esNC`, la clase 'nd' daba true y el puente se habría escrito en negativo.
  assert.match(EMISION, /vinculos, esNotaDeCredito\(cbteTipo\)\);/);
  assert.doesNotMatch(EMISION, /vinculos, !!esNC\);/);
});

// ── 5. UN CONCEPTO NO ES UN PRODUCTO ────────────────────────────────────────
test('el renglón sin producto entra si dice qué es y con qué alícuota', () => {
  // Una nota de débito por intereses por mora no tiene producto. Acá se exigía un
  // producto_id existente y se frenaba, así que no había forma de emitirla.
  assert.match(EMISION, /const prod = \(it\.producto_id != null\)/);
  assert.match(EMISION, /if \(!rotulo\) throw new Error\('Un renglón sin producto tiene que decir qué es/);
  assert.match(EMISION, /no dice con qué alícuota de IVA va, y sin producto no hay/);
  // Y NO se resuelve sembrando pseudo-productos en el maestro: aparecerían en los
  // autocompletar de orden de compra, remito y facturación, y en los informes de stock.
  assert.doesNotMatch(EMISION, /INSERT OR IGNORE INTO sg_productos/);
});

test('ante ARCA es SERVICIOS, y por eso lleva el período', () => {
  // Concepto 1 = Productos, 2 = Servicios. Estaba clavado en 1. Con 2 o 3, ARCA exige
  // además FchServDesde, FchServHasta y FchVtoPago, que no se mandaban.
  assert.doesNotMatch(EMISION, /<ar:Concepto>1<\/ar:Concepto>/);
  assert.match(EMISION, /<ar:Concepto>' \+ \(c\.concepto_afip \|\| 1\)/);
  assert.match(EMISION, /FchServDesde/);
  assert.match(EMISION, /FchVtoPago/);
  const i = VENTAS.indexOf("router.post('/facturas/:id(\\\\d+)/nota-debito'");
  assert.match(VENTAS.slice(i, i + 4500), /concepto: 2/);
});

// ── 6. LAS PUERTAS ──────────────────────────────────────────────────────────
test('no se le hace una nota a otra nota', () => {
  assert.match(VENTAS, /La nota de débito cuelga de una factura, no de otra nota/);
  assert.match(VENTAS, /No se le hace una nota de crédito a otra nota/);
});

test('una nota de débito por cero no existe', () => {
  assert.match(VENTAS, /Poné al menos un concepto con su importe/);
  assert.match(VENTAS, /no dice con qué alícuota de IVA va/);
});

test('la pantalla la distingue de la de crédito y ofrece las dos', () => {
  assert.match(PANEL, /function sgNdOpen\(id\)/);
  assert.match(PANEL, /sg-nd-modal/);
  assert.match(PANEL, /var esND = \(f\.cbte_tipo==2 \|\| f\.cbte_tipo==7\);/);
  assert.match(PANEL, /onclick="sgNdOpen\('\+f\.id\+'\)">➕ ND<\/button>/);
  assert.match(PANEL, /<b>Sube<\/b> la deuda del cliente/);
  // Sin barra de desplazamiento lateral (CLAUDE.md).
  const i = PANEL.indexOf('id="sg-nd-modal"');
  assert.match(PANEL.slice(i, i + 1800), /overflow-x:hidden !important/);
  assert.match(PANEL.slice(i, i + 1800), /table-layout:fixed/);
});
