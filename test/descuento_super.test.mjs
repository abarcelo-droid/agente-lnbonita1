// ══ EL DESCUENTO QUE SE LLEVA LA CADENA ════════════════════════════════════
//
// Pablo, 9/9/2026: «voy a necesitar un botón que se llame Descuento super: que sea
// un porcentaje de la venta, en la factura debe aparecer como un ítem más. El
// operador debería seleccionar si lo aplica o no. En contabilidad vamos a necesitar
// configurar a dónde hacer el asiento modelo de estos descuentos».
//
// Tres cosas distintas, y las tres se prueban acá:
//
//   1. Es FISCAL: baja el neto, baja el IVA y baja lo que el cliente debe. No tiene
//      nada que ver con dif_gestion, que mide lo resignado SIN papel.
//   2. Sale como RENGLÓN, uno por alícuota. Con una sola línea al 10,5% sobre un
//      comprobante que también tiene 21%, el crédito fiscal que se le devuelve al
//      cliente no es el suyo y las bases que ARCA registra dejan de ser la suma de
//      los renglones.
//   3. Y NO SE ESCONDE ADENTRO DE VENTAS. El asiento balancearía igual acreditando
//      Ventas por el neto ya descontado — y entonces nadie podría contestar cuánto
//      se llevaron las cadenas sin abrir factura por factura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const VENTAS = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const PDF = fs.readFileSync(path.join(RAIZ, 'src/servicios/facturaPDF.js'), 'utf8');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// El motor de emisión REAL, con los módulos que abren la base reemplazados por un
// doble que no hace nada. Lo que corre es el código del repo — no hay ninguna rama
// «si estoy en un test».
async function motorDeEmision() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-desc-'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/servicios'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(RAIZ, 'src/servicios', f), path.join(dir, f));
  }
  const doble = `const noop = { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }),
    exec: () => {}, transaction: (fn) => fn, pragma: () => [] };
  export default noop; export const getDb = () => noop; export const dbPa = noop;\n`;
  for (const s of ['db.js', 'db2.js', 'db_sg.js', 'db_sg_finanzas.js', 'db_pa.js', 'catalogo.js', 'catalogo_v2.js']) {
    if (fs.existsSync(path.join(dir, s))) fs.writeFileSync(path.join(dir, s), doble, 'utf8');
  }
  fs.writeFileSync(path.join(dir, 'afip-wsaa.js'),
    "export function ambienteActual(){ return 'homologacion'; }\n"
    + "export async function autenticar(){ throw new Error('acá no se llama a AFIP'); }\n", 'utf8');
  return import('file:///' + path.join(dir, 'afip-wsfe-emision.js').replace(/\\/g, '/'));
}

function baseDePrueba() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_clientes (id INTEGER PRIMARY KEY, razon_social TEXT, cuit TEXT,
      categoria_fiscal TEXT, descuento_pct REAL);
    CREATE TABLE sg_familias (id INTEGER PRIMARY KEY, nombre TEXT, iva_alicuota REAL);
    CREATE TABLE sg_productos (id INTEGER PRIMARY KEY, nombre TEXT, familia_id INTEGER, iva_alicuota REAL);
    INSERT INTO sg_clientes VALUES (1,'CADENA S.A.','30712400125','resp_inscripto',5);
    INSERT INTO sg_familias VALUES (1,'Frutas',10.5);
    INSERT INTO sg_productos VALUES (1,'Tomate',1,10.5), (2,'Envase',1,21);
  `);
  return db;
}

// ══════════════════════════════════════════════════════════════════════════
// 1 · UNA LÍNEA POR ALÍCUOTA, Y LA CUENTA HECHA
// ══════════════════════════════════════════════════════════════════════════

test('con una sola alícuota va un renglón, y dice el porcentaje', async () => {
  const { lineasDeDescuento } = await motorDeEmision();
  const l = lineasDeDescuento(5, { 10.5: { neto: 100000 } });
  assert.equal(l.length, 1);
  assert.equal(l[0].importe_neto, -5000);
  assert.equal(l[0].importe_iva, -525);
  // El rótulo lleva el porcentaje: es lo que el cliente reclama si no coincide con
  // lo acordado. Y sin la aclaración de alícuota, que sobra cuando hay una sola.
  assert.equal(l[0].descripcion, 'Descuento acordado 5%');
});

test('con DOS alícuotas van dos renglones, cada uno sobre SU base', async () => {
  const { lineasDeDescuento } = await motorDeEmision();
  const l = lineasDeDescuento(5, { 10.5: { neto: 100000 }, 21: { neto: 50000 } });
  assert.equal(l.length, 2, 'un solo renglón le devolvería al cliente el IVA que no es');
  const a105 = l.find((x) => x.alicuota === 10.5), a21 = l.find((x) => x.alicuota === 21);
  assert.equal(a105.importe_neto, -5000);
  assert.equal(a105.importe_iva, -525);
  assert.equal(a21.importe_neto, -2500);
  assert.equal(a21.importe_iva, -525);
  // Y ahí SÍ dice cuál es cada uno: si no salen dos renglones que se leen igual
  // con importes distintos.
  assert.match(a105.descripcion, /IVA 10,5%/);
  assert.match(a21.descripcion, /IVA 21%/);
});

test('una alícuota sin base no genera renglón: un descuento de cero no existe', async () => {
  const { lineasDeDescuento } = await motorDeEmision();
  assert.equal(lineasDeDescuento(5, { 10.5: { neto: 0 } }).length, 0);
  assert.equal(lineasDeDescuento(0, { 10.5: { neto: 100000 } }).length, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL COMPROBANTE ENTERO, ARMADO DE VERDAD
// ══════════════════════════════════════════════════════════════════════════

test('el descuento baja el neto, el IVA y el total — y sale como ítem', async () => {
  const { construirComprobante } = await motorDeEmision();
  const c = construirComprobante(baseDePrueba(), { clienteId: 1, descuentoPct: 5,
    items: [{ producto_id: 1, cantidad: 1000, precio: 100 }] });   // 100.000 al 10,5
  assert.equal(c.imp_neto, 95000, 'el neto tiene que bajar: no es un descuento sobre el total');
  assert.equal(c.imp_iva, 9975, '10,5% de 95.000');
  assert.equal(c.imp_total, 104975);
  // Y EL RENGLÓN ESTÁ. Pablo lo pidió así: «en la factura debe aparecer como un
  // ítem más». Un descuento que sólo cambia el total es uno que el cliente no ve.
  const d = c.detalle.filter((x) => x.es_descuento);
  assert.equal(d.length, 1);
  assert.equal(d[0].subtotal, -5000);
  assert.equal(d[0].producto_id, null, 'un descuento no es un producto del maestro');
  assert.equal(c.descuento_neto, 5000);
  assert.equal(c.descuento_pct, 5);
});

test('lo que se le informa a ARCA sigue siendo la suma de los renglones', async () => {
  const { construirComprobante } = await motorDeEmision();
  const c = construirComprobante(baseDePrueba(), { clienteId: 1, descuentoPct: 5,
    items: [{ producto_id: 1, cantidad: 1000, precio: 100 },      // 100.000 al 10,5
            { producto_id: 2, cantidad: 100, precio: 500 }] });   //  50.000 al 21
  // Las bases del array Iva son lo que ARCA registra. Si el descuento bajara sólo
  // los totales, la base de cada alícuota no coincidiría con sus renglones y el
  // comprobante quedaría inconsistente en el sistema de ellos, no en el nuestro.
  const porId = {};
  for (const x of c.iva) porId[x.Id] = x;
  const suma = (id) => r2(c.detalle.filter((d) => d.alicuota_id === id)
    .reduce((a, d) => a + d.subtotal, 0));
  for (const x of c.iva) assert.equal(x.BaseImp, suma(x.Id), 'la base del Id ' + x.Id);
  assert.equal(r2(c.iva.reduce((a, x) => a + x.Importe, 0)), c.imp_iva);
  assert.equal(c.imp_total, r2(c.imp_neto + c.imp_iva));
  // Cada alícuota queda con base POSITIVA: ARCA rechaza una base negativa, y con
  // menos de 100% no puede pasar.
  for (const x of c.iva) assert.ok(x.BaseImp > 0, 'base negativa en el Id ' + x.Id);
});

test('sin descuento, el comprobante sale exactamente igual que antes', async () => {
  const { construirComprobante } = await motorDeEmision();
  const c = construirComprobante(baseDePrueba(), { clienteId: 1,
    items: [{ producto_id: 1, cantidad: 1000, precio: 100 }] });
  assert.equal(c.imp_neto, 100000);
  assert.equal(c.imp_total, 110500);
  assert.equal(c.descuento_neto, 0);
  assert.equal(c.descuento_pct, null);
  assert.equal(c.detalle.filter((x) => x.es_descuento).length, 0);
});

test('100% no se acepta: el comprobante quedaría en cero', async () => {
  const { construirComprobante } = await motorDeEmision();
  assert.throws(() => construirComprobante(baseDePrueba(), { clienteId: 1, descuentoPct: 100,
    items: [{ producto_id: 1, cantidad: 1000, precio: 100 }] }), /menor a 100/);
  // Y por arriba de 100 quedaría en NEGATIVO, que ARCA rechaza.
  assert.throws(() => construirComprobante(baseDePrueba(), { clienteId: 1, descuentoPct: 150,
    items: [{ producto_id: 1, cantidad: 1000, precio: 100 }] }), /menor a 100/);
});

test('y la puerta de entrada lo dice con el nombre del campo, no con un 502', () => {
  // El motor frena igual, pero contestaría 502 —que suena a que se cayó AFIP—
  // cuando lo que pasó es que alguien tipeó 500 en vez de 5.
  const i = SG.indexOf('const descuentoPct = Number(b.descuento_pct) || 0;');
  assert.ok(i > 0, 'postEmitir no valida el porcentaje');
  const b = SG.slice(i, i + 500);
  assert.match(b, /descuentoPct < 0 \|\| descuentoPct >= 100/);
  assert.match(b, /status\(400\)/);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL ASIENTO: VENTAS POR EL NETO ENTERO
// ══════════════════════════════════════════════════════════════════════════

function baseContable({ conDescuento }) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_config (clave TEXT PRIMARY KEY, valor TEXT);
    CREATE TABLE sg_asientos_modelo (id INTEGER PRIMARY KEY, nombre TEXT, activo INTEGER);
    CREATE TABLE sg_asientos_modelo_lineas (id INTEGER PRIMARY KEY, modelo_id INTEGER,
      cuenta_id INTEGER, lado TEXT, descripcion TEXT, orden INTEGER, tipo_linea TEXT);
    CREATE TABLE sg_cuentas (id INTEGER PRIMARY KEY, codigo TEXT, nombre TEXT);
    CREATE TABLE sg_config_impositiva (clave TEXT, cuenta_id INTEGER);
    INSERT INTO sg_config VALUES ('asiento_modelo_venta','1');
    INSERT INTO sg_asientos_modelo VALUES (1,'Venta',1);
    INSERT INTO sg_cuentas VALUES (10,'1.01.02.0001','Deudores por ventas'),
      (20,'4.01.01.0001','Ventas'), (30,'2.01.03.0001','IVA Débito Fiscal'),
      (40,'4.01.02.0001','Descuentos sobre ventas');
    INSERT INTO sg_config_impositiva VALUES ('iva_debito_fiscal',30);
    INSERT INTO sg_asientos_modelo_lineas VALUES
      (1,1,10,'debe','Deudores',0,'clientes'),
      (2,1,20,'haber','Ventas',1,'ventas');
  `);
  if (conDescuento) {
    db.exec(`INSERT INTO sg_asientos_modelo_lineas VALUES
      (3,1,40,'debe','Descuentos sobre ventas',2,'descuento_super');`);
  }
  return db;
}

// La función de verdad, con su import de db.js reemplazado.
async function asientoVenta() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-asv-'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/servicios'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(RAIZ, 'src/servicios', f), path.join(dir, f));
  }
  const doble = `const noop = { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }),
    exec: () => {}, transaction: (fn) => fn, pragma: () => [] };
  export default noop; export const getDb = () => noop;\n`;
  for (const s of ['db.js', 'db_sg_finanzas.js']) {
    fs.writeFileSync(path.join(dir, s), doble, 'utf8');
  }
  return import('file:///' + path.join(dir, 'asiento-venta.js').replace(/\\/g, '/'));
}

const totales = (lineas) => lineas.reduce((a, l) => ({
  debe: r2(a.debe + (l.debe || 0)), haber: r2(a.haber + (l.haber || 0)) }), { debe: 0, haber: 0 });

test('Ventas se acredita por el neto ENTERO y el descuento va a su cuenta', async () => {
  const { lineasAsientoVenta } = await asientoVenta();
  const db = baseContable({ conDescuento: true });
  // El comprobante del caso de arriba: 100.000 de lista, 5% de descuento.
  const arm = lineasAsientoVenta(db, { clienteId: 1, neto: 95000, iva: 9975, total: 104975,
    numero: '0001-00000001', descuentoFiscal: 5000 });
  assert.deepEqual(arm.falta, []);
  const cta = (id) => arm.lineas.filter((l) => l.cuenta_id === id);
  assert.equal(cta(20)[0].haber, 100000, 'Ventas tiene que ser lo de LISTA, no lo cobrado');
  assert.equal(cta(40)[0].debe, 5000, 'el descuento tiene que verse en su propia cuenta');
  assert.equal(cta(10)[0].debe, 104975, 'la deuda del cliente es el total del papel');
  const t = totales(arm.lineas);
  assert.equal(t.debe, t.haber, 'el asiento no balancea');
});

test('sin descuento, el asiento es el de siempre: tres líneas', async () => {
  const { lineasAsientoVenta } = await asientoVenta();
  const arm = lineasAsientoVenta(baseContable({ conDescuento: true }),
    { clienteId: 1, neto: 100000, iva: 10500, total: 110500, numero: '0001-00000001' });
  assert.equal(arm.lineas.length, 3, 'apareció una línea de descuento por cero');
  assert.equal(arm.lineas.filter((l) => l.cuenta_id === 40).length, 0);
});

test('y si no hay cuenta de descuentos, FRENA: la alternativa es esconderlo', async () => {
  const { lineasAsientoVenta } = await asientoVenta();
  const arm = lineasAsientoVenta(baseContable({ conDescuento: false }),
    { clienteId: 1, neto: 95000, iva: 9975, total: 104975,
      numero: '0001-00000001', descuentoFiscal: 5000 });
  // Acreditando Ventas por 95.000 el asiento BALANCEARÍA IGUAL y el descuento no
  // existiría en ningún lado. Por eso no se cae para atrás: se dice.
  assert.equal(arm.lineas.length, 0);
  assert.match(arm.falta.join(' '), /Descuentos sobre ventas/);
  assert.match(arm.falta.join(' '), /Asiento Modelo/);
});

test('pero una venta SIN descuento se contabiliza igual sin esa cuenta', async () => {
  // Si no, agregar el descuento habría roto todas las ventas de todos los días.
  const { lineasAsientoVenta } = await asientoVenta();
  const arm = lineasAsientoVenta(baseContable({ conDescuento: false }),
    { clienteId: 1, neto: 100000, iva: 10500, total: 110500, numero: '0001-00000001' });
  assert.deepEqual(arm.falta, []);
  assert.equal(arm.lineas.length, 3);
});

test('en una nota de crédito el descuento se invierte, como todo lo demás', async () => {
  const { lineasAsientoVenta } = await asientoVenta();
  const arm = lineasAsientoVenta(baseContable({ conDescuento: true }),
    { clienteId: 1, neto: 95000, iva: 9975, total: 104975,
      numero: '0001-00000002', descuentoFiscal: 5000, esNC: true });
  const cta = (id) => arm.lineas.filter((l) => l.cuenta_id === id)[0];
  // La devolución devuelve también el descuento que se había concedido sobre esa
  // mercadería: si el descuento se quedara del lado del debe, la cuenta de
  // descuentos acumularía para siempre lo de ventas que ya no existen.
  assert.equal(cta(40).haber, 5000);
  assert.equal(cta(40).debe, 0);
  assert.equal(cta(10).haber, 104975);
  const t = totales(arm.lineas);
  assert.equal(t.debe, t.haber);
});

test('el preview espeja lo que se graba: pasa el descuento', () => {
  // Regla del repo: toda operación que asienta muestra el asiento ANTES. Si el
  // preview no recibiera el descuento, el cuadro mostraría tres líneas y el libro
  // guardaría cuatro — justo lo que el preview promete no hacer.
  const i = VENTAS.indexOf("router.post('/facturas/preview-asiento'");
  assert.ok(i > 0);
  const b = VENTAS.slice(i, VENTAS.indexOf('res.json', i));
  assert.match(b, /descuentoFiscal: r2v\(b\.descuento_fiscal\)/);
});

test('rehacer el asiento da el MISMO asiento', () => {
  // recontabilizarVenta arma el asiento de nuevo desde la factura guardada. Sin
  // leer descuento_neto, el mismo comprobante tenía dos asientos distintos según
  // por dónde se hubiera pasado.
  const EM = fs.readFileSync(path.join(RAIZ, 'src/servicios/afip-wsfe-emision.js'), 'utf8');
  const i = EM.indexOf('export function recontabilizarVenta');
  assert.ok(i > 0);
  const b = EM.slice(i, EM.indexOf('const cli =', i));
  assert.match(b, /COALESCE\(descuento_neto,0\) AS descuento_neto/);
  assert.match(b, /descuentoFiscal: f\.descuento_neto/);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LA NOTA DE CRÉDITO NO DEVUELVE DE MÁS
// ══════════════════════════════════════════════════════════════════════════

test('la nota acredita con el MISMO porcentaje que tenía la factura', () => {
  // La factura salió con 5% menos: el cliente pagó 95. Si la nota acreditara el
  // 100% de lo que vuelve, se le devolvería más de lo que pagó por esa mercadería.
  const i = VENTAS.indexOf('descuentoPct: Number(f.descuento_pct) || 0');
  assert.ok(i > 0, 'la nota de crédito no arrastra el descuento de la factura');
});

test('y el descuento no se ofrece como un renglón para devolver', () => {
  // Es un importe, no mercadería: preguntarle al operador cuántos kilos de
  // descuento quiere acreditar no tiene respuesta.
  const i = VENTAS.indexOf('function baseDeNotaCredito');
  assert.ok(i > 0);
  const b = VENTAS.slice(i, VENTAS.indexOf('const porDesp', i));
  assert.match(b, /AND COALESCE\(es_descuento,0\)=0/);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · EL PAPEL
// ══════════════════════════════════════════════════════════════════════════

test('el renglón del descuento no se imprime como «1 kg»', () => {
  // «Descuento acordado 5% · 1 · kg · -$12.345» es exactamente el renglón por el
  // que el cliente llama.
  assert.match(PDF, /const esDesc = !!it\.es_descuento;/);
  assert.match(PDF, /const cantTxt = esDesc \? '' :/);
  assert.match(PDF, /const uMed = esDesc \? '' :/);
  assert.match(PDF, /const pUnit = esDesc \? '' :/);
  // Y en la B, donde el precio va con IVA adentro, tampoco.
  assert.match(PDF, /esDesc \? '' : money\(conIva\(/);
});

test('el importe SÍ se imprime, en negativo', () => {
  // Es lo único que tiene que decir el renglón. Sacarlo dejaría un renglón mudo
  // y un total que no se explica.
  const i = PDF.indexOf('const fila = discrimina ? [');
  const b = PDF.slice(i, i + 600);
  assert.match(b, /money\(sub\)/);
  assert.match(b, /money\(conIva\(sub\)\)/);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · LA PANTALLA: SE OFRECE, NO SE APLICA SOLO
// ══════════════════════════════════════════════════════════════════════════

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

test('el bloque está en la ventana de facturar, con su casillero', () => {
  assert.match(PANEL, /id="sgf-desc-on"/);
  assert.match(PANEL, /id="sgf-desc-pct"/);
  assert.match(PANEL, /🏷️ Descuento super/);
});

test('ARRANCA APAGADO aunque el cliente tenga porcentaje', () => {
  // Pablo: «el operador debería seleccionar si lo aplica o no». Lo que se propone
  // es el NÚMERO; que se aplique es una decisión. Un descuento que se aplica solo
  // es un descuento que un día sale de más.
  const html = trozo(PANEL, 'id="sgf-desc-on"', '>');
  assert.ok(!/checked/.test(html), 'el casillero viene tildado');
  const init = trozo(PANEL, 'function sgFacInit(){', '\r\n}');
  assert.match(init, /dc\.checked = false/);
  assert.match(init, /dp\.value = ''/);
  // Y al cambiar de cliente también: el porcentaje de la cadena anterior no tiene
  // nada que ver con ésta.
  const cli = trozo(PANEL, 'function sgFacCliente(){', '\r\n}');
  assert.match(cli, /chk\.checked = false/);
});

test('el porcentaje lo PROPONE la ficha del cliente', () => {
  const f = trozo(PANEL, 'function sgFacDescPropuesto(){', '\r\n}');
  assert.match(f, /cli\.descuento_pct/);
  // Y se descarta un valor imposible en vez de proponerlo: la ficha se puede
  // haber cargado mal y esto se muestra como «acordado».
  assert.match(f, /p > 0 && p < 100/);
  // El campo existe en la ficha, y el backend lo guarda: sin la columna en la
  // lista, se pintaba el campo y al guardar se perdía en silencio.
  assert.match(PANEL, /\{k:'descuento_pct', l:'Descuento acordado \(%\)', t:'number'\}/);
  assert.match(SG, /'descuento_pct'\]/);
});

test('sin cuenta donde medirlo, NO se ofrece — y dice dónde arreglarlo', () => {
  // Es la regla del botón Anular: no se ofrece algo que va a contestar un error.
  // El que lo aprieta y rebota cree que rompió algo.
  const f = trozo(PANEL, 'function sgFacDescNota(){', '\r\n}');
  assert.match(f, /chk\.disabled = !hay/);
  assert.match(f, /chk\.checked = false/);
  assert.match(f, /Asiento Modelo/);
  // Y el backend contesta si la hay, para que la pantalla no tenga que adivinar.
  assert.match(VENTAS, /tiene_descuento: m\.lineas\.some\(\(l\) => l\.tipo_linea === 'descuento_super'\)/);
});

test('pero eso NO marca en rojo un modelo que está bien', () => {
  // Una venta sin descuento se contabiliza perfecto sin esa cuenta. Meterla en
  // `faltan` pondría el aviso rojo del encabezado en todas las instalaciones.
  const AV = fs.readFileSync(path.join(RAIZ, 'src/servicios/asiento-venta.js'), 'utf8');
  const f = trozo(AV, 'export function modeloVentaFaltan(lineas) {', '\r\n}');
  assert.ok(!/descuento_super/.test(f), 'el descuento entró en la lista de faltantes');
});

test('el circuito se pide al abrir la ventana, no sólo al entrar a la solapa', () => {
  // Esta ventana se abre desde «Remitos pendientes de comprobante», que no pasa
  // por la solapa donde el circuito se carga: sin esto el botón salía siempre
  // apagado, diciendo que falta una cuenta que estaba puesta.
  const init = trozo(PANEL, 'function sgFacInit(){', '\r\n}');
  assert.match(init, /SG_MODELO_EST\.venta === undefined\) sgModeloCargar\('venta'\)/);
  // Y cuando la respuesta llega, el bloque se repinta: si no, la primera vez
  // siempre diría que falta.
  const car = trozo(PANEL, 'function sgModeloCargar(k){', '\r\n}');
  assert.match(car, /k === 'venta'\) sgFacDescNota\(\)/);
});

test('viaja el PORCENTAJE, no los pesos', () => {
  // Mandar el importe obligaría a la pantalla a decidir cómo se reparte entre dos
  // alícuotas, y serían dos cuentas de lo mismo que un día no coinciden.
  const f = trozo(PANEL, 'function sgFacEmitir(){', '\r\n}');
  assert.match(f, /descuento_pct: sgFacDescPct\(\)/);
  assert.ok(!/descuento_neto:/.test(f));
  // Y facturación directa entra por la MISMA puerta, así que también lo pasa.
  assert.match(SG, /descuento_pct: Number\(b\.descuento_pct\) \|\| 0,/);
});

test('el total de la pantalla es el que va a salir impreso', () => {
  // El resumen espeja lineasDeDescuento(): una baja por alícuota, sobre su base.
  const f = trozo(PANEL, 'function sgFacResumen(){', '\r\n}');
  assert.match(f, /var dPct = sgFacDescPct\(\)/);
  assert.match(f, /netoPorAlic\[al\] \* dPct \/ 100/);
  assert.match(f, /ivaPorAlic\[al\] -= paRound2\(d \* Number\(al\) \/ 100\)/);
  // Y se ve cuánto es: un total que baja sin decir por qué es un total que se
  // desconfía.
  assert.match(f, /Descuento '\+String\(dPct\)/);
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · Y EL MANUAL DICE LO QUE EL CÓDIGO HACE
// ══════════════════════════════════════════════════════════════════════════
//
// La regla del repo: el manual se prueba contra el CÓDIGO, no contra sí mismo. Un
// test que sólo verifica que el texto existe no sirve para nada — lo que hay que
// clavar es que lo que el manual AFIRMA sigue siendo cierto.
const MAN_VENTAS = (() => {
  const i = PANEL.indexOf('SG_MANUAL.ventas = ');
  const j = PANEL.indexOf('SG_MANUAL.reprocesos', i);
  assert.ok(i > 0 && j > i, 'no está el manual de Remitos y Facturación');
  return PANEL.slice(i, j);
})();

test('el manual tiene la entrada, con su versión', () => {
  assert.match(MAN_VENTAS, /🏷️ Descuento super <span class="ver">V1038<\/span>/);
  assert.match(MAN_VENTAS, /<li><b>V1038<\/b>/, 'falta en «Qué cambió, y desde cuándo»');
});

test('«el casillero arranca apagado siempre» — y arranca apagado', async () => {
  assert.match(MAN_VENTAS, /El casillero arranca <b>apagado<\/b> siempre|arranca '\s*\+\s*'apagado/);
  const init = trozo(PANEL, 'function sgFacInit(){', '\r\n}');
  assert.match(init, /dc\.checked = false/);
});

test('«con dos alícuotas salen dos renglones» — y salen dos', async () => {
  assert.match(MAN_VENTAS, /Con dos alícuotas salen dos renglones/);
  const { lineasDeDescuento } = await motorDeEmision();
  assert.equal(lineasDeDescuento(5, { 10.5: { neto: 100 }, 21: { neto: 100 } }).length, 2);
});

test('«el total de abajo ya lo tiene descontado» — y el backend da lo mismo', async () => {
  assert.match(MAN_VENTAS, /ya lo tiene descontado/);
  // La cuenta de la pantalla y la del motor tienen que dar igual, o el operador
  // aprieta emitir mirando un número y sale otro.
  const { construirComprobante } = await motorDeEmision();
  const c = construirComprobante(baseDePrueba(), { clienteId: 1, descuentoPct: 5,
    items: [{ producto_id: 1, cantidad: 1000, precio: 100 }] });
  // Lo que hace sgFacResumen, a mano: neto por alícuota menos su descuento.
  const neto = r2(100000 - r2(100000 * 5 / 100));
  const iva = r2(neto * 10.5 / 100);
  assert.equal(c.imp_neto, neto);
  assert.equal(c.imp_total, r2(neto + iva));
});

test('«sin esa cuenta el casillero no se puede prender» — y no se puede', () => {
  assert.match(MAN_VENTAS, /el casillero no se puede prender<\/b>/);
  const f = trozo(PANEL, 'function sgFacDescNota(){', '\r\n}');
  assert.match(f, /chk\.disabled = !hay/);
});

test('«una venta sin descuento se contabiliza perfecto sin ella» — y se contabiliza', async () => {
  assert.match(MAN_VENTAS, /una venta sin descuento se contabiliza perfecto sin ella/);
  const { lineasAsientoVenta } = await asientoVenta();
  const arm = lineasAsientoVenta(baseContable({ conDescuento: false }),
    { clienteId: 1, neto: 100000, iva: 10500, total: 110500, numero: '0001-1' });
  assert.deepEqual(arm.falta, []);
});

test('«Ventas se acredita por el neto entero» — y así sale', async () => {
  assert.match(MAN_VENTAS, /Ventas se acredita por el neto entero<\/b>/);
  const { lineasAsientoVenta } = await asientoVenta();
  const arm = lineasAsientoVenta(baseContable({ conDescuento: true }),
    { clienteId: 1, neto: 95000, iva: 9975, total: 104975, numero: '0001-1', descuentoFiscal: 5000 });
  assert.equal(arm.lineas.filter((l) => l.cuenta_id === 20)[0].haber, 100000);
});

test('«el descuento vuelve en la misma proporción» — y la nota lo arrastra', () => {
  assert.match(MAN_VENTAS, /vuelve en la misma '\s*\+\s*'proporción|vuelve en la misma proporción/);
  assert.ok(VENTAS.includes('descuentoPct: Number(f.descuento_pct) || 0'));
});

test('y el manual de Maestros manda a cargar el porcentaje donde de verdad está', () => {
  const i = PANEL.indexOf('SG_MANUAL.catalogo = ');
  const j = PANEL.indexOf('SG_MANUAL.ventas', i);
  const man = PANEL.slice(i, j);
  assert.match(man, /descuento acordado<\/b> <span class="ver">V1038<\/span>/);
  // «Acá no se aplica nada»: el campo del maestro no dispara nada solo.
  assert.match(man, /no se aplica nada/);
  assert.match(PANEL, /\{k:'descuento_pct', l:'Descuento acordado \(%\)', t:'number'\}/);
});

test('el asiento modelo ofrece la línea, y no es la de gestión', () => {
  // La de arriba —'descuento'— mide lo resignado SIN papel. Ésta sale impresa,
  // baja el IVA y baja lo que el cliente debe. Una sola cuenta para las dos
  // mezclaría un descuento documentado con una medición interna.
  assert.match(PANEL, /\['descuento_super',\s+'Descuentos sobre ventas \(Debe\) — descuento de cadena'\]/);
  assert.match(PANEL, /\['descuento',\s+'Descuentos comerciales — ventas, gestión'\]/);
  // Las DOS copias del editor de modelos la tienen: hay una por módulo y la que
  // se olvidara dejaría media pantalla sin poder marcarla.
  assert.equal((PANEL.match(/'descuento_super',/g) || []).length, 2);
});
