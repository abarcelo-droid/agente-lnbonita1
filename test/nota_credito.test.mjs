// ══ LA NOTA DE CRÉDITO ═════════════════════════════════════════════════
//
// Existía a medias: `es_nc` cambiaba el TIPO de comprobante (3 y 8 en vez de 1 y 6) y
// nada más. Los importes se calculaban positivos, el asiento salía IDÉNTICO al de una
// factura —Deudores al debe, Ventas e IVA Débito al haber— y el puente con el remito
// se escribía igual.
//
// O sea: una nota de crédito AUMENTABA la deuda del cliente, AUMENTABA el débito
// fiscal y TAPABA los kilos del remito. Hacía lo contrario de las tres cosas para las
// que existe.
//
// Los cuatro caminos que este test cuida son los cuatro que estaban al revés:
//   1. el ASIENTO — se invierte por los lados, no por el signo (crearAsiento rechaza
//      importes negativos);
//   2. los KILOS — el puente se escribe en negativo, así la mercadería vuelve a
//      figurar entregada sin comprobante y se puede volver a facturar;
//   3. la CUENTA CORRIENTE — la nota resta, y lo pendiente de la factura acreditada
//      deja de ofrecerse para cobrar;
//   4. el LIBRO DE IVA VENTAS — la nota resta débito fiscal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esNotaDeCredito, signoFactura, deudaFactura, deudaGestionFactura,
  ncAplicadas, ncAplicadasFiscal, ncAplicadasGestion, noEsNotaDeCredito,
  facturaCuenta } from '../src/servicios/factura-cuenta.js';
import { libroIvaVentas } from '../src/servicios/sg_libros_iva.js';

// RAIZ se puede apuntar a otro árbol (un `git archive` de main) para comprobar que
// estos tests FALLAN sin el arreglo. Un test que pasa de los dos lados no protege nada.
const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASIENTO_VENTA = fs.readFileSync(path.join(RAIZ, 'src/servicios/asiento-venta.js'), 'utf8');
const EMISION = fs.readFileSync(path.join(RAIZ, 'src/servicios/afip-wsfe-emision.js'), 'utf8');
const VENTAS = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');

// Saca una función del archivo por su texto y la vuelve ejecutable. Salta la lista de
// parámetros antes de contar llaves: la primera `{` está en la firma (destructuring).
function extraer(src, firma, deps = {}) {
  const i = src.indexOf(firma);
  assert.ok(i >= 0, 'no está en el archivo: ' + firma);
  const abre = src.indexOf('(', i);
  let d = 0, j = abre;
  for (; j < src.length; j++) {
    if (src[j] === '(') d++;
    else if (src[j] === ')') { d--; if (d === 0) { j++; break; } }
  }
  const cuerpoIni = src.indexOf('{', j);
  d = 0;
  let k = cuerpoIni;
  for (; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) { k++; break; } }
  }
  const nombres = Object.keys(deps), vals = Object.values(deps);
  const cuerpo = src.slice(i, k).replace(/^export\s+/, '');
  // eslint-disable-next-line no-new-func
  return new Function(...nombres, cuerpo + '; return ' + firma.replace(/^export\s+function\s+/, '').replace(/\s*\(.*$/s, '') + ';')(...vals);
}

// ── 1. EL ASIENTO ───────────────────────────────────────────────────────
// El modelo mínimo de venta: una cuenta de clientes, una de ventas, una de IVA.
function dbModelo() {
  return {
    _: null,
    prepare() { return { get: () => null, all: () => [] }; },
  };
}
const MODELO = {
  id: 1,
  lineas: [
    { tipo_linea: 'clientes', lado: 'debe', cuenta_id: 101, descripcion: null },
    { tipo_linea: 'ventas', lado: 'haber', cuenta_id: 401, descripcion: null },
    { tipo_linea: 'iva', lado: 'haber', cuenta_id: 210, descripcion: null },
  ],
};

function armar(opts) {
  const fn = extraer(ASIENTO_VENTA, 'export function lineasAsientoVenta', {
    MOTIVOS: { ajuste_gestion: 1, precio_acordado: 1 },
    modeloVentaLineas: () => MODELO,
    modeloVentaFaltan: () => [],
    r2v: (n) => Math.round((Number(n) || 0) * 100) / 100,
  });
  return fn(dbModelo(), opts);
}
const suma = (ls, lado) => Math.round(ls.reduce((a, l) => a + (Number(l[lado]) || 0), 0) * 100) / 100;

test('la FACTURA sigue como estaba: el cliente al debe, ventas e IVA al haber', () => {
  const { lineas } = armar({ clienteId: 1, neto: 100000, iva: 21000, total: 121000,
    descuento: 0, numero: '0007-00000009' });
  const cli = lineas.find((l) => l.cuenta_id === 101);
  assert.equal(cli.debe, 121000, 'la factura CARGA la deuda del cliente');
  assert.equal(cli.haber, 0);
  assert.equal(lineas.find((l) => l.cuenta_id === 401).haber, 100000);
  assert.equal(lineas.find((l) => l.cuenta_id === 210).haber, 21000);
  assert.equal(suma(lineas, 'debe'), suma(lineas, 'haber'), 'y balancea');
});

test('la NOTA DE CRÉDITO va al revés: el cliente al HABER, ventas e IVA al debe', () => {
  const { lineas } = armar({ clienteId: 1, neto: 100000, iva: 21000, total: 121000,
    descuento: 0, numero: '0007-00000010', esNC: true });
  const cli = lineas.find((l) => l.cuenta_id === 101);
  assert.equal(cli.haber, 121000, 'la nota DESCARGA la deuda del cliente');
  assert.equal(cli.debe, 0, 'si acá hubiera un debe, la nota le sumaría deuda al cliente');
  assert.equal(lineas.find((l) => l.cuenta_id === 401).debe, 100000, 'la venta se deshace');
  assert.equal(lineas.find((l) => l.cuenta_id === 210).debe, 21000, 'y el débito fiscal también');
  assert.equal(suma(lineas, 'debe'), suma(lineas, 'haber'), 'y balancea igual');
});

test('los importes van en POSITIVO: el escritor de asientos rechaza los negativos', () => {
  const { lineas } = armar({ clienteId: 1, neto: 100000, iva: 21000, total: 121000,
    descuento: 30000, numero: 'X', esNC: true });
  for (const l of lineas) {
    assert.ok((Number(l.debe) || 0) >= 0 && (Number(l.haber) || 0) >= 0,
      'ninguna línea puede ir en negativo: ' + JSON.stringify(l));
  }
});

test('la mitad de GESTIÓN de la nota también se invierte, y balancea por su cuenta', () => {
  const { lineas } = armar({ clienteId: 1, neto: 100000, iva: 21000, total: 121000,
    descuento: 30000, motivo: 'ajuste_gestion', numero: 'X', esNC: true });
  const ges = lineas.filter((l) => l.ambito === 'gestion');
  assert.equal(ges.length, 2);
  assert.equal(suma(ges, 'debe'), suma(ges, 'haber'), 'gestión balancea sola (regla de CLAUDE.md)');
  const cliGes = ges.find((l) => l.cuenta_id === 101);
  assert.equal(cliGes.haber, 30000, 'lo resignado por el acuerdo también vuelve');
  assert.equal(cliGes.debe, 0);
  const fis = lineas.filter((l) => l.ambito !== 'gestion');
  assert.equal(suma(fis, 'debe'), suma(fis, 'haber'), 'y lo fiscal también');
});

// ── 2. LOS KILOS DEL REMITO ─────────────────────────────────────────────
test('el puente de una nota se escribe en NEGATIVO: los kilos vuelven a pendiente', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_ven_facturas (id INTEGER PRIMARY KEY, cbte_tipo INTEGER,
      afip_estado TEXT, estado TEXT);
    CREATE TABLE sg_factura_despachos (factura_id INTEGER, despacho_id INTEGER,
      despacho_item_id INTEGER, kg REAL, neto REAL, iva REAL, gestion REAL);
    INSERT INTO sg_ven_facturas VALUES (1,1,'autorizado','pendiente'),(2,3,'autorizado','pendiente');
    INSERT INTO sg_factura_despachos VALUES (1,10,100,1000,500000,105000,0);
  `);
  const documentado = () => db.prepare(`SELECT COALESCE(SUM(fd.kg),0) s
    FROM sg_factura_despachos fd JOIN sg_ven_facturas f ON f.id=fd.factura_id
   WHERE fd.despacho_item_id=? AND ${facturaCuenta('f')}`).get(100).s;
  assert.equal(documentado(), 1000, 'la factura documentó los 1.000 kg');

  // La nota de crédito, tal como la escribe confirmarAutorizada: el mismo renglón
  // con el signo dado vuelta.
  const sg = esNotaDeCredito(3) ? -1 : 1;
  assert.equal(sg, -1);
  db.prepare('INSERT INTO sg_factura_despachos VALUES (2,10,100,?,?,?,?)')
    .run(sg * 1000, sg * 500000, sg * 105000, 0);
  assert.equal(documentado(), 0,
    'después de la nota esos kilos vuelven a estar entregados sin comprobante');
});

test('confirmarAutorizada es la que da vuelta el signo, y sólo para la nota', () => {
  // Esto vive en el motor de emisión y no se puede importar (abre la base). Se lee.
  assert.match(EMISION, /function confirmarAutorizada\([^)]*esNC\)/,
    'confirmarAutorizada tiene que saber si lo que confirma es una nota');
  assert.match(EMISION, /const sg = esNC \? -1 : 1;/);
  assert.match(EMISION, /sg \* Math\.abs\(Number\(v\.kg\)\)/,
    'los kg del puente van con el signo de la operación');
});

// ── 3. LA CUENTA CORRIENTE ──────────────────────────────────────────────
function dbCC() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_ven_facturas (id INTEGER PRIMARY KEY, cliente_id INTEGER, cbte_tipo INTEGER,
      total REAL, neto REAL, iva REAL, dif_gestion REAL DEFAULT 0, afip_estado TEXT, estado TEXT,
      nc_de_factura_id INTEGER, fecha TEXT, numero TEXT, punto_venta INTEGER, cbte_nro INTEGER,
      tipo TEXT, cae TEXT, asiento_id INTEGER, ambiente TEXT, es_prueba INTEGER DEFAULT 0);
    -- Factura A por 121.000 (100.000 + IVA) con 30.000 de gestión, y su nota entera.
    INSERT INTO sg_ven_facturas (id,cliente_id,cbte_tipo,total,neto,iva,dif_gestion,afip_estado,estado,
      nc_de_factura_id,fecha,punto_venta,cbte_nro,tipo,cae,asiento_id,ambiente)
      VALUES (1,7,1,121000,100000,21000,30000,'autorizado','pendiente',NULL,'2026-08-20',7,9,'A','75000000000001',1,'produccion');
    INSERT INTO sg_ven_facturas (id,cliente_id,cbte_tipo,total,neto,iva,dif_gestion,afip_estado,estado,
      nc_de_factura_id,fecha,punto_venta,cbte_nro,tipo,cae,asiento_id,ambiente)
      VALUES (2,7,3,121000,100000,21000,30000,'autorizado','pendiente',1,'2026-08-21',7,3,'A','75000000000002',2,'produccion');
    CREATE TABLE sg_asientos (id INTEGER PRIMARY KEY, anulado INTEGER DEFAULT 0);
    INSERT INTO sg_asientos VALUES (1,0),(2,0);
    CREATE TABLE sg_clientes (id INTEGER PRIMARY KEY, razon_social TEXT, cuit TEXT, categoria_fiscal TEXT);
    INSERT INTO sg_clientes VALUES (7,'ASUNCION 4054 S.A.','30712400125','resp_inscripto');
    CREATE TABLE liquidaciones (id INTEGER PRIMARY KEY, n_liquidacion TEXT, fecha TEXT,
      grilla_json TEXT, asiento_id INTEGER, iva_letra TEXT, oc_id INTEGER, eliminado_en TEXT);
    CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, trazabilidad TEXT, proveedor_id INTEGER);
    CREATE TABLE sg_proveedores (id INTEGER PRIMARY KEY, razon_social TEXT, cuit TEXT);
  `);
  return db;
}

test('la nota RESTA de la deuda del cliente, no le suma', () => {
  const db = dbCC();
  const deuda = () => db.prepare(`SELECT COALESCE(SUM(${deudaFactura('f')}),0) s
    FROM sg_ven_facturas f WHERE f.cliente_id=7 AND ${facturaCuenta('f')}`).get().s;
  assert.equal(deuda(), 0, '121.000 + 30.000 facturados menos los mismos acreditados = 0');
  // Y sin el signo daría el doble: es exactamente lo que hacía antes.
  const sinSigno = db.prepare(`SELECT COALESCE(SUM(f.total + COALESCE(f.dif_gestion,0)),0) s
    FROM sg_ven_facturas f WHERE f.cliente_id=7 AND ${facturaCuenta('f')}`).get().s;
  assert.equal(sinSigno, 302000, 'sin signo, la nota le sumaba otra venta entera');
});

test('la mitad de gestión también resta', () => {
  const db = dbCC();
  const g = db.prepare(`SELECT COALESCE(SUM(${deudaGestionFactura('f')}),0) s
    FROM sg_ven_facturas f WHERE f.cliente_id=7 AND ${facturaCuenta('f')}`).get().s;
  assert.equal(g, 0);
});

test('una factura acreditada deja de ofrecerse para cobrar', () => {
  const db = dbCC();
  const docs = db.prepare(`SELECT f.id,
      f.total + COALESCE(f.dif_gestion,0) - ${ncAplicadas('f')} AS pendiente,
      f.total - ${ncAplicadasFiscal('f')} AS pendiente_fiscal,
      COALESCE(f.dif_gestion,0) - ${ncAplicadasGestion('f')} AS pendiente_gestion
     FROM sg_ven_facturas f
    WHERE f.cliente_id=7 AND ${facturaCuenta('f')} AND ${noEsNotaDeCredito('f')}`).all();
  assert.equal(docs.length, 1, 'la nota no es un documento a cobrar: no aparece en la lista');
  assert.equal(docs[0].pendiente, 0, 'y la factura que acreditó ya no tiene nada pendiente');
  assert.equal(docs[0].pendiente_fiscal, 0);
  assert.equal(docs[0].pendiente_gestion, 0);
});

test('una nota ANULADA deja de restar, y la factura vuelve a deberse', () => {
  const db = dbCC();
  db.prepare("UPDATE sg_ven_facturas SET estado='anulada' WHERE id=2").run();
  const deuda = db.prepare(`SELECT COALESCE(SUM(${deudaFactura('f')}),0) s
    FROM sg_ven_facturas f WHERE f.cliente_id=7 AND ${facturaCuenta('f')}`).get().s;
  assert.equal(deuda, 151000);
  const pend = db.prepare(`SELECT f.total + COALESCE(f.dif_gestion,0) - ${ncAplicadas('f')} p
     FROM sg_ven_facturas f WHERE f.id=1`).get().p;
  assert.equal(pend, 151000, 'lo que la nota anulada devolvía, vuelve a ser deuda');
});

test('el signo sale de UN solo lugar y reconoce los dos tipos de nota', () => {
  assert.equal(esNotaDeCredito(3), true, 'NC A');
  assert.equal(esNotaDeCredito(8), true, 'NC B');
  assert.equal(esNotaDeCredito(1), false, 'FA A');
  assert.equal(esNotaDeCredito(6), false, 'FA B');
  assert.equal(esNotaDeCredito(null), false);
  const db = dbCC();
  const s = db.prepare(`SELECT ${signoFactura('f')} s FROM sg_ven_facturas f WHERE f.id=2`).get().s;
  assert.equal(s, -1);
});

// ── 4. EL LIBRO DE IVA VENTAS ───────────────────────────────────────────
test('la nota RESTA débito fiscal en el libro de IVA ventas', () => {
  const db = dbCC();
  const r = libroIvaVentas(db, { desde: '2026-08-01', hasta: '2026-08-31',
    facturaCuentaSql: facturaCuenta('f') });
  assert.equal(r.filas.length, 2, 'las dos se listan: son dos comprobantes con su número');
  const nc = r.filas.find((x) => x.nc);
  assert.equal(nc.iva, -21000, 'la nota va con el signo cambiado');
  assert.equal(nc.total, -121000);
  assert.equal(r.totales.iva, 0, 'y el débito del período queda en cero');
  assert.equal(r.totales.neto, 0);
});

// ── 5. LAS PUERTAS QUE SE CIERRAN ───────────────────────────────────────
test('un comprobante con CAE ya no se puede «anular» a mano', () => {
  assert.match(VENTAS, /if \(f\.cae && !esNotaDeCredito\(f\.cbte_tipo\)\)/,
    'anular tiene que frenar cuando ARCA ya tiene el comprobante');
  assert.match(VENTAS, /hacele una NOTA DE CRÉDITO/i,
    'y decir cuál es la salida, que es lo único que el usuario puede hacer');
});

test('se puede acreditar de a poco, pero nunca más de lo que se compró', () => {
  assert.match(VENTAS, /nota-credito/, 'existe el camino para emitirla');
  // El cerrojo dejó de ser «ya tiene una nota» —eso impedía terminar una devolución
  // empezada— y pasó a ser por SALDO: mientras quede algo se puede seguir, y ni un
  // peso más. Ver test/nota_credito_parcial.test.mjs.
  assert.match(VENTAS, /ya está acreditado entero/i,
    'lo que frena es que no quede saldo, no que exista una nota');
  // Y no se le hace una nota a otra nota — ni de crédito ni de débito: la nota se
  // anula, o se corrige la factura de la que cuelga.
  assert.match(VENTAS, /No se le hace una nota de crédito a otra nota/i);
});

test('la nota va ASOCIADA a su factura, que es lo que ARCA pide', () => {
  assert.match(EMISION, /CbtesAsoc/, 'el XML lleva el comprobante asociado');
  assert.match(EMISION, /nc_de_factura_id/, 'y queda guardado de qué factura es');
});
