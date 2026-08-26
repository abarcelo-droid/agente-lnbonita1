// ══ LOS DOS LIBROS DE IVA ══════════════════════════════════════════════
//
// El de VENTAS no existía: el débito fiscal se calculaba en cada emisión, se le
// informaba a AFIP, se guardaba y se asentaba — y no se sumaba en ninguna pantalla.
// El de COMPRAS leía sólo las facturas, así que le faltaba todo el IVA de las
// liquidaciones al productor.
//
// Y una liquidación va en LOS DOS, que es lo que este test cuida: le compramos la
// mercadería (crédito) y le cobramos servicios (débito). Meterla en uno solo deja la
// otra mitad sin declarar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ivaDeLiquidacion, libroIvaVentas, comprasDeLiquidaciones, totalizar }
  from '../src/servicios/sg_libros_iva.js';

const GRILLA = JSON.stringify({
  fiscal: {
    ventas: 100000, iva_ventas: 10500,          // lo que le compramos → crédito
    comision: 12000, iva_comision: 1260,        // lo que le cobramos → débito
    descarga: 3000, iva_descarga: 630,
    flete: 5000, iva_flete: 1050,
    gastos_admin: 1000, iva_gastos_admin: 210,
  },
});

test('una liquidación aporta a los DOS libros, con sus mitades separadas', () => {
  const x = ivaDeLiquidacion({ grilla_json: GRILLA });
  assert.equal(x.compras.neto, 100000, 'la mercadería que le compramos');
  assert.equal(x.compras.iva, 10500, '…y su IVA es crédito fiscal');
  assert.equal(x.ventas.neto, 21000, 'comisión + descarga + flete + gastos');
  assert.equal(x.ventas.iva, 3150, '…y su IVA es débito fiscal');
});

test('el flete cuenta como servicio: es lo que le cobramos por traerla', () => {
  const sinFlete = JSON.parse(GRILLA);
  delete sinFlete.fiscal.flete; delete sinFlete.fiscal.iva_flete;
  const x = ivaDeLiquidacion({ grilla_json: JSON.stringify(sinFlete) });
  assert.equal(x.ventas.iva, 2100, 'sin flete son 1.260 + 630 + 210');
  // Con flete son 1.050 más: si el libro se olvidara del flete, faltaría ese débito.
  assert.equal(ivaDeLiquidacion({ grilla_json: GRILLA }).ventas.iva, 3150);
});

test('una grilla vacía o rota no rompe el libro', () => {
  for (const g of [null, '', '{}', 'no soy json', JSON.stringify({ fiscal: {} })]) {
    const x = ivaDeLiquidacion({ grilla_json: g });
    assert.equal(x.compras.total, 0);
    assert.equal(x.ventas.total, 0);
  }
});

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_asientos (id INTEGER PRIMARY KEY, anulado INTEGER DEFAULT 0);
    CREATE TABLE sg_clientes (id INTEGER PRIMARY KEY, razon_social TEXT, cuit TEXT, categoria_fiscal TEXT);
    CREATE TABLE sg_proveedores (id INTEGER PRIMARY KEY, razon_social TEXT, cuit TEXT);
    CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, trazabilidad TEXT, proveedor_id INTEGER);
    CREATE TABLE liquidaciones (id INTEGER PRIMARY KEY, n_liquidacion TEXT, fecha TEXT,
      grilla_json TEXT, asiento_id INTEGER, iva_letra TEXT, oc_id INTEGER, eliminado_en TEXT);
    CREATE TABLE sg_ven_facturas (id INTEGER PRIMARY KEY, fecha TEXT, numero TEXT, punto_venta INTEGER,
      cbte_tipo INTEGER, cbte_nro INTEGER, tipo TEXT, neto REAL, iva REAL, total REAL, cae TEXT,
      asiento_id INTEGER, ambiente TEXT, es_prueba INTEGER DEFAULT 0, cliente_id INTEGER,
      estado TEXT DEFAULT 'pendiente', afip_estado TEXT DEFAULT 'autorizado');
    INSERT INTO sg_asientos (id,anulado) VALUES (1,0),(2,0),(3,1);
    INSERT INTO sg_clientes VALUES (1,'ASUNCION 4054 S.A.','30712400125','resp_inscripto');
    INSERT INTO sg_proveedores VALUES (1,'AJOS DON HUGO','30111111117');
    INSERT INTO sg_oc VALUES (1,'0035.25.08.2026.02',1);
  `);
  db.prepare(`INSERT INTO liquidaciones (id,n_liquidacion,fecha,grilla_json,asiento_id,iva_letra,oc_id)
    VALUES (1,'1-205','2026-08-20',?,1,'A',1)`).run(GRILLA);
  db.prepare(`INSERT INTO sg_ven_facturas
    (id,fecha,numero,punto_venta,cbte_tipo,cbte_nro,tipo,neto,iva,total,cae,asiento_id,ambiente,cliente_id)
    VALUES (1,'2026-08-21','AFIP-7-1-9',7,1,9,'A',1000000,105000,1105000,'75000000000001',2,'produccion',1)`).run();
  return db;
}
const CUENTA = "(COALESCE(f.afip_estado,'') <> 'rechazado' AND COALESCE(f.estado,'') <> 'anulada')";

test('el libro de ventas trae las facturas Y los servicios de las liquidaciones', () => {
  const db = base();
  const r = libroIvaVentas(db, { desde: '2026-08-01', hasta: '2026-08-31', facturaCuentaSql: CUENTA });
  assert.equal(r.filas.length, 2);
  const fac = r.filas.find((x) => x.origen === 'factura');
  const liq = r.filas.find((x) => x.origen === 'liquidacion');
  assert.equal(fac.comprobante, '0007-00000009', 'el número que se cita es el fiscal');
  assert.equal(liq.iva, 3150, 'sólo los servicios: la mercadería va al libro de compras');
  assert.equal(r.totales.iva, 108150, '105.000 de la factura + 3.150 de los servicios');
});

test('el libro de compras suma el crédito de las liquidaciones', () => {
  const db = base();
  const filas = comprasDeLiquidaciones(db, { desde: '2026-08-01', hasta: '2026-08-31' });
  assert.equal(filas.length, 1);
  assert.equal(filas[0].iva, 10500);
  assert.equal(filas[0].comprobante, '1-205');
  assert.equal(filas[0].partida, '0035.25.08.2026.02', 'con la partida, para poder rastrearla');
});

test('sin asiento no hay libro, y un asiento anulado tampoco cuenta', () => {
  const db = base();
  db.prepare('UPDATE liquidaciones SET asiento_id=NULL WHERE id=1').run();
  assert.equal(comprasDeLiquidaciones(db, {}).length, 0, 'sin asiento la deuda no subió al libro');
  db.prepare('UPDATE liquidaciones SET asiento_id=3 WHERE id=1').run();  // el 3 está anulado
  assert.equal(comprasDeLiquidaciones(db, {}).length, 0, 'lo anulado no se declara');
});

test('una factura RECHAZADA por AFIP no entra al libro', () => {
  const db = base();
  db.prepare("UPDATE sg_ven_facturas SET afip_estado='rechazado' WHERE id=1").run();
  const r = libroIvaVentas(db, { facturaCuentaSql: CUENTA });
  assert.equal(r.filas.filter((x) => x.origen === 'factura').length, 0,
    'sin autorización no hay débito fiscal que declarar');
});

test('lo emitido en homologación o marcado como prueba NO se declara', () => {
  const db = base();
  db.prepare("UPDATE sg_ven_facturas SET ambiente='homologacion' WHERE id=1").run();
  const r = libroIvaVentas(db, { facturaCuentaSql: CUENTA });
  assert.equal(r.filas.find((x) => x.origen === 'factura').es_prueba, true, 'se lista, marcada…');
  assert.equal(r.totales.iva, 3150, '…pero no suma: no salió por el AFIP de producción');
});

test('el período filtra por fecha en las dos fuentes', () => {
  const db = base();
  const r = libroIvaVentas(db, { desde: '2026-08-21', hasta: '2026-08-31', facturaCuentaSql: CUENTA });
  assert.equal(r.filas.length, 1, 'la liquidación del 20 queda afuera');
  assert.equal(r.filas[0].origen, 'factura');
});

test('totalizar deja afuera lo de prueba', () => {
  assert.equal(totalizar([{ neto: 100, iva: 21, total: 121 },
    { neto: 999, iva: 999, total: 999, es_prueba: true }]).iva, 21);
});
