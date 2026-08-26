// ══ LA NOTA DE CRÉDITO PARCIAL ═════════════════════════════════════════════
//
// La nota era SIEMPRE por el total, y con un cerrojo binario: «este comprobante ya
// tiene una nota». Eso alcanzaba para el caso de la venta que se cae entera y no
// alcanza para nada más — una devolución de 300 de los 1.000 kg, o un precio que se
// corrige después de emitir.
//
// Y hacerla parcial no es filtrar renglones: hay tres cuentas que estaban escritas
// contra el TOTAL de la factura y que, con un subconjunto, salen mal sin avisar:
//
//   1. EL RESIDUO DE IVA. Se repartía contra `f.iva`, el IVA de la factura ENTERA. En
//      una parcial, la diferencia de toda la factura se le cargaba al último renglón
//      y la nota salía con un IVA disparatado — ya con CAE.
//   2. LA PARTE DE GESTIÓN. Se mandaba el `dif_gestion` completo. Volvía un renglón y
//      se borraba TODA la deuda de gestión. Como cada ámbito balancea por su cuenta,
//      el asiento igual decía «balancea».
//   3. LOS KILOS. Sin tope por renglón, devolver más de lo que esa factura documentó
//      deja el pendiente del remito por encima de lo despachado: se puede facturar
//      mercadería que nunca salió del depósito.
//
// Y dos cosas que no existían: que la suma de las notas no se pase de lo que el
// cliente compró, y la diferencia entre DEVOLVER mercadería (los kilos vuelven) y
// AJUSTAR EL PRECIO (los kilos no vuelven, están en la casa del cliente).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { facturaCuenta, ncAplicadas } from '../src/servicios/factura-cuenta.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENTAS = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');
const EMISION = fs.readFileSync(path.join(RAIZ, 'src/servicios/afip-wsfe-emision.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── 1. LAS CUENTAS DE UNA PARCIAL ───────────────────────────────────────────
// Una factura de dos renglones: 1.000 kg a $100 (10,5%) y 500 kg a $200 (21%).
const REN = [
  { id: 1, cantidad: 1000, neto: 100000, alic: 10.5, gestion: 30000 },
  { id: 2, cantidad: 500, neto: 100000, alic: 21, gestion: 0 },
];
const IVA_FACTURA = r2(100000 * 0.105 + 100000 * 0.21);   // 31.500

test('el residuo de IVA se mide contra ESTA nota, no contra la factura entera', () => {
  // Vuelve sólo el primer renglón: su IVA es 10.500. Contra el IVA de la factura
  // —31.500— el "residuo" daría 21.000 de más cargados al último renglón.
  const linea = REN[0];
  const ivaNota = r2(linea.neto * linea.alic / 100);
  assert.equal(ivaNota, 10500);
  const residuoMal = r2(IVA_FACTURA - ivaNota);
  assert.equal(residuoMal, 21000, 'esto es lo que se le sumaba de más a la nota');
  // El código ya no compara contra f.iva: la línea que lo hacía desapareció.
  assert.doesNotMatch(VENTAS, /const resto = r2n\(r2n\(f\.iva\) - ivaSuma\)/,
    'el residuo contra el IVA de la factura entera no puede volver');
});

test('el neto de una devolución parcial sale de la proporción de kilos', () => {
  const l = REN[0];
  const devuelve = 300;
  assert.equal(r2(l.neto * (devuelve / l.cantidad)), 30000);
  // Y el renglón ENTERO va por su número exacto, sin residuo de división: si se
  // calculara por proporción también acá, 1000/1000 podría dar 99.999,99.
  assert.match(VENTAS, /const entero = Math\.abs\(cant - ren\.cantidad_pendiente\) < 1e-6/);
});

test('la parte de gestión que vuelve es la del RENGLÓN, no la de la factura', () => {
  // El renglón 1 resignó 30.000 y el 2 nada. Devolviendo el 2, no vuelve gestión.
  assert.match(VENTAS, /const gesRenglones = r2n\(vinculos\.reduce/,
    'la gestión sale de la columna del puente, renglón por renglón');
  assert.doesNotMatch(VENTAS, /descuentoGestion: Math\.abs\(Number\(f\.dif_gestion\) \|\| 0\)/,
    'mandar el dif_gestion completo borraba toda la deuda de gestión por un renglón');
  // Y nunca más de lo que quedaba de gestión sin acreditar.
  assert.match(VENTAS, /r2n\(difFactura - base\.gestion_acreditada\)/);
});

// ── 2. LOS TOPES ────────────────────────────────────────────────────────────
function dbFactura() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_ven_facturas (id INTEGER PRIMARY KEY, cliente_id INTEGER, cbte_tipo INTEGER,
      total REAL, neto REAL, iva REAL, dif_gestion REAL DEFAULT 0, afip_estado TEXT, estado TEXT,
      nc_de_factura_id INTEGER, fecha TEXT, punto_venta INTEGER, cbte_nro INTEGER);
    CREATE TABLE sg_ven_factura_items (id INTEGER PRIMARY KEY, factura_id INTEGER,
      descripcion TEXT, cantidad REAL, precio_unitario REAL, subtotal REAL, alicuota_id INTEGER,
      despacho_item_id INTEGER, nc_de_item_id INTEGER);
    CREATE TABLE sg_factura_despachos (factura_id INTEGER, despacho_id INTEGER,
      despacho_item_id INTEGER, kg REAL, neto REAL, iva REAL, gestion REAL);
    -- Factura A: 1.000 kg a $100 y 500 kg a $200. Total 231.500, gestión 30.000.
    INSERT INTO sg_ven_facturas (id,cliente_id,cbte_tipo,total,neto,iva,dif_gestion,afip_estado,estado,fecha,punto_venta,cbte_nro)
      VALUES (1,7,1,231500,200000,31500,30000,'autorizado','pendiente','2026-08-20',7,9);
    INSERT INTO sg_ven_factura_items (id,factura_id,descripcion,cantidad,precio_unitario,subtotal,alicuota_id,despacho_item_id)
      VALUES (1,1,'Tomate',1000,100,100000,4,101),(2,1,'Papa',500,200,100000,5,102);
    INSERT INTO sg_factura_despachos VALUES (1,10,101,1000,100000,10500,30000),(1,10,102,500,100000,21000,0);
  `);
  return db;
}

// Una nota parcial ya emitida: vuelven 300 kg del renglón 1.
function conNotaParcial(db) {
  db.prepare(`INSERT INTO sg_ven_facturas (id,cliente_id,cbte_tipo,total,neto,iva,dif_gestion,
      afip_estado,estado,nc_de_factura_id,fecha,punto_venta,cbte_nro)
    VALUES (2,7,3,33150,30000,3150,9000,'autorizado','pendiente',1,'2026-08-21',7,3)`).run();
  db.prepare(`INSERT INTO sg_ven_factura_items (id,factura_id,descripcion,cantidad,precio_unitario,
      subtotal,alicuota_id,despacho_item_id,nc_de_item_id)
    VALUES (10,2,'Tomate',300,100,30000,4,101,1)`).run();
  db.prepare('INSERT INTO sg_factura_despachos VALUES (2,10,101,-300,-30000,-3150,-9000)').run();
  return db;
}

test('lo ya acreditado se lleva POR RENGLÓN, y por eso se puede seguir', () => {
  const db = conNotaParcial(dbFactura());
  const ya = db.prepare(`SELECT ni.nc_de_item_id AS ref, SUM(ni.cantidad) AS cant,
        SUM(ni.subtotal) AS neto
      FROM sg_ven_factura_items ni
      JOIN sg_ven_facturas nf ON nf.id = ni.factura_id
     WHERE nf.nc_de_factura_id = 1 AND ${facturaCuenta('nf')} AND ni.nc_de_item_id IS NOT NULL
     GROUP BY ni.nc_de_item_id`).all();
  assert.equal(ya.length, 1);
  assert.equal(ya[0].ref, 1);
  assert.equal(ya[0].cant, 300, 'del renglón 1 ya volvieron 300 kg');
  assert.equal(1000 - ya[0].cant, 700, '…y quedan 700 para una segunda nota');
});

test('entre todas las notas no se le devuelve más de lo que compró', () => {
  const db = conNotaParcial(dbFactura());
  const acordado = 231500 + 30000;
  const devuelto = db.prepare(`SELECT ${ncAplicadas('f')} AS x FROM sg_ven_facturas f WHERE f.id=1`)
    .get().x;
  assert.equal(devuelto, 42150, '33.150 del comprobante + 9.000 de gestión');
  assert.equal(r2(acordado - devuelto), 219350, 'lo que todavía se le puede acreditar');
  // Y el cerrojo existe: no queda saldo → no se emite.
  assert.match(VENTAS, /ya está acreditado entero/i);
});

test('los kilos que vuelven no pueden pasar los que esa factura documentó', () => {
  const db = conNotaParcial(dbFactura());
  const doc = () => db.prepare(`SELECT COALESCE(SUM(fd.kg),0) s FROM sg_factura_despachos fd
      JOIN sg_ven_facturas f ON f.id=fd.factura_id
     WHERE fd.despacho_item_id=101 AND ${facturaCuenta('f')}`).get().s;
  assert.equal(doc(), 700, 'de los 1.000 documentados volvieron 300');
  assert.ok(doc() >= 0, 'nunca en negativo: eso dejaría facturar lo que no salió del depósito');
  assert.match(VENTAS, /kg: e\.devuelveKg \? Math\.min\(e\.cantidad, e\.ren\.kg_documentados\) : 0/,
    'el tope está escrito en el código, no confiado al que llama');
});

// ── 3. DEVOLVER NO ES AJUSTAR EL PRECIO ─────────────────────────────────────
//
// El puente factura↔despacho hace DOS cosas a la vez y la nota las separa: dice
// cuántos KILOS de un remito tienen comprobante, y dice cuánta PLATA le entró a esa
// partida — de ahí sale lo que se le liquida al productor.
test('un AJUSTE DE PRECIO no devuelve kilos, pero SÍ baja la plata de la partida', () => {
  // Los kilos no vuelven: la mercadería está en la casa del cliente y si volvieran,
  // figurarían vendibles y se venderían dos veces.
  assert.match(VENTAS, /kg: e\.devuelveKg \? .* : 0/);
  // Pero la fila se escribe igual. Sin ella, /partidas/:id/venta —que arma lo que la
  // partida vendió leyendo este puente— sigue contando la venta entera, y al
  // productor se le liquida sobre plata que ya se le devolvió al cliente.
  assert.doesNotMatch(VENTAS, /if \(!e\.devuelveKg \|\| e\.ren\.despacho_item_id == null/,
    'el ajuste de precio no puede saltear el puente: la plata tiene que bajar');
  assert.match(VENTAS, /if \(e\.ren\.despacho_item_id == null \|\| e\.ren\.despacho_id == null\) continue;/);
  assert.match(VENTAS, /modo = \(String\(req\.body\?\.modo \|\| ''\) === 'precio'\)/);
  // Y la pantalla lo dice donde se elige, con las dos consecuencias escritas.
  assert.match(PANEL, /La mercadería <b>no vuelve<\/b>/);
  assert.match(PANEL, /La mercadería <b>vuelve<\/b>/);
});

test('un ajuste de precio NO consume los kilos del renglón', () => {
  // Se emite con la cantidad ENTERA —es lo que ARCA espera y lo que deja el papel
  // legible— pero esos kilos no volvieron. Contándolos como devueltos, la devolución
  // de verdad quedaba bloqueada para siempre: "de este renglón ya volvió todo".
  assert.match(VENTAS, /SUM\(CASE WHEN COALESCE\(ni\.nc_modo,''\) = 'precio' THEN 0 ELSE ni\.cantidad END\)/);
  assert.match(EMISION, /_alter\('sg_ven_factura_items', 'nc_modo'/);
  // La PLATA sí se cuenta siempre: si no, se podría acreditar el mismo renglón dos veces.
  assert.match(VENTAS, /SUM\(ni\.subtotal\) AS neto/);
});

test('a precio, la cantidad no cambia y lo que baja es el unitario', () => {
  // Es lo que ARCA espera de una nota de ajuste, y deja el renglón legible en el
  // papel. construirComprobante además exige cantidad > 0: mandar 0 no era opción.
  assert.match(VENTAS, /elegidos\.push\(\{ ren, cantidad: ren\.cantidad, neto, devuelveKg: false \}\)/);
  assert.match(VENTAS, /const precio = e\.cantidad > 0 \? \+\(e\.neto \/ e\.cantidad\)\.toFixed\(6\) : 0;/);
});

// ── 4. LA ATADURA ENTRE EL RENGLÓN Y EL REMITO ──────────────────────────────
test('el renglón del comprobante guarda de qué remito salió', () => {
  // Antes la correspondencia era POSICIONAL —ítem y vínculo se empujaban en la misma
  // vuelta del for— y nada los ataba. Para devolver 300 de 1.000 kg hay que saber a
  // qué remito devolvérselos; por posición andaba de casualidad.
  assert.match(EMISION, /_alter\('sg_ven_factura_items', 'despacho_item_id'/);
  assert.match(EMISION, /_alter\('sg_ven_factura_items', 'nc_de_item_id'/);
  assert.match(EMISION, /despacho_item_id, nc_de_item_id, nc_modo\)/, 'y se escriben al emitir');
});

test('el IVA de la nota sale del que ESE renglón le puso a la factura', () => {
  // Con el precio tipeado CON IVA, el IVA de la línea salió por DIFERENCIA contra el
  // bruto —no de multiplicar el neto por la alícuota—. Rehacerlo multiplicando deja
  // un centavo de diferencia, y una nota por el total dejaba ese centavo pegado a la
  // factura para siempre. El número exacto está guardado en el puente.
  assert.match(VENTAS, /const doc = e\.ren\.iva_documentado;/);
  assert.match(VENTAS, /return r2n\(doc \* \(e\.neto \/ e\.ren\.neto\)\);/);
  assert.match(VENTAS, /iva_documentado: \(v && v\.iva != null\)/);
  // 100 kg a $1.010 bruto al 10,5%: neto 91.402,71 e IVA 9.597,29 (por diferencia).
  // Multiplicando daría 9.597,28 y la nota saldría un centavo corta.
  const neto = r2(101000 / 1.105), iva = r2(101000 - neto);
  assert.equal(r2(neto + iva), 101000);
  assert.notEqual(r2(neto * 0.105), iva, 'multiplicar da distinto: por eso se guarda');
});

test('gestión: cero no es lo mismo que «no se sabe»', () => {
  // Un renglón sin acuerdo tiene gestión 0 y es el caso normal. Mirando el VALOR,
  // devolver ese renglón se llevaba gestión del renglón de al lado, que el cliente
  // sigue teniendo.
  assert.match(VENTAS, /gestion_conocida: !!\(v && v\.gestion != null\)/);
  assert.match(VENTAS, /const conocidos = elegidos\.filter\(\(e\) => e\.ren\.gestion_conocida\)\.length;/);
  assert.match(VENTAS, /const gestionNota = conocidos > 0/);
});

test('los comprobantes VIEJOS caen a la posición, y sólo si los largos coinciden', () => {
  assert.match(VENTAS, /const alineado = puente\.length === items\.length;/);
  assert.match(VENTAS, /\|\| \(alineado \? puente\[ix\] : null\)/);
  // Y la pantalla lo dice, en vez de devolver los kilos al remito equivocado.
  assert.match(PANEL, /anterior al[\s\S]{0,60}vínculo por renglón/);
});

// ── 5. LO QUE YA NO SE PUEDE COBRAR ─────────────────────────────────────────
test('un cobro no se imputa contra lo que la nota ya devolvió', () => {
  // pendienteDeDoc es el control del servidor en POST /cobranzas y no restaba nada de
  // notas: se le reclamaba al cliente algo que ya se le había devuelto, y la plata
  // quedaba pegada a un comprobante que no debía eso.
  const i = VENTAS.indexOf('function pendienteDeDoc(');
  assert.ok(i > 0);
  const cuerpo = VENTAS.slice(i, i + 2500);
  assert.match(cuerpo, /nc_de_factura_id/, 'la función mira las notas de esa factura');
  assert.match(cuerpo, /const pendFis = r2c\(\(d\.total \|\| 0\) - \(Number\(nc\.fiscal\) \|\| 0\)/);
  assert.match(cuerpo, /const pendGes = r2c\(\(d\.dif_gestion \|\| 0\) - \(Number\(nc\.gestion\) \|\| 0\)/);
});

test('el listado sigue ofreciendo acreditar mientras quede saldo', () => {
  // Con el flag binario, la primera nota parcial apagaba el botón y el resto de la
  // devolución no se podía hacer nunca.
  assert.match(VENTAS, /AS nc_acreditado/);
  assert.match(PANEL, /acreditada ' \+ sgMoney\(acred\)/, 'y se ve cuánto se acreditó ya');
});

test('la pantalla y el servidor hacen la MISMA cuenta del neto devuelto', () => {
  // Si la hicieran distinta, la pantalla mostraría un número y el comprobante saldría
  // con otro — y el que sale con CAE es el del servidor.
  const l = REN[0], c = 300;
  const front = Math.round((l.cantidad > 0 ? l.neto * (c / l.cantidad) : 0) * 100) / 100;
  assert.equal(front, 30000);
  assert.match(PANEL, /neto = entero \? l\.neto : Math\.round\(\(l\.cantidad>0 \? l\.neto\*\(c\/l\.cantidad\) : 0\)\*100\)\/100;/);
});
