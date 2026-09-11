// ══ SIN LA FACTURA DEL TERCERO NO SE LIQUIDA ══════════════════════════════
//
// Pablo, 8/9/2026: «Solamente en los casos en que la partida se liquide, y el
// flete o la descarga figuren en los conceptos que restan a la liquidación... Para
// que las declaraciones juradas estén OK, necesitamos que en el documento que
// imprimamos figuren los datos fiscales de la factura que estamos descontando. Si
// al proveedor A le vamos a liquidar una partida y por esa partida pagamos
// descargas y fletes de los proveedores B y C, es MANDATORIO que figuren los datos
// de las facturas de B y C».
//
// Y las dos decisiones que cerraron el diseño, del mismo día:
//   · «En principio hay que FRENARLA. Sin la factura no podemos liquidar. Es el
//      filtro para contabilizar la factura.»
//   · «Hay que mostrar CUIT, Razón Social, número de factura y el TOTAL de esa
//      factura, no importa que solamente estemos descontando una parte.»
//   · «El flete debe salir de la factura del fletero: con la factura del fletero
//      PERFECCIONAMOS lo de la orden de compra. Recordá acá Gestión y Fiscal: se
//      descuenta lo que dice la factura en la parte fiscal, y si hay diferencia se
//      descuenta en Gestión.»
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const SERV = fs.readFileSync(path.join(RAIZ, 'src/servicios/sg_partida_terminada.js'), 'utf8');
const LIQ = fs.readFileSync(path.join(RAIZ, 'src/rutas/liquidaciones.js'), 'utf8');

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

const { gastosSinFactura, comprobantesDeLaPartida, numeroDe, TIPOS_DESCONTABLES } =
  await import(pathToFileURL(path.join(RAIZ, 'src/servicios/sg_gastos_facturados.js')).href);

// ══════════════════════════════════════════════════════════════════════════
// 1 · QUIÉN FALTA, CONTRA UN SQLITE DE VERDAD
// ══════════════════════════════════════════════════════════════════════════
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_recepciones (id INTEGER PRIMARY KEY, oc_id INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_gastos_directos (id INTEGER PRIMARY KEY, recepcion_id INTEGER,
      tipo_gasto TEXT, estado TEXT, monto REAL, fecha_servicio TEXT,
      proveedor_servicio_id INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_facturas_gasto (id INTEGER PRIMARY KEY, proveedor_servicio_id INTEGER,
      tipo_comprobante TEXT, punto_venta INTEGER, numero INTEGER, fecha_emision TEXT,
      cuit_emisor TEXT, neto REAL, iva_monto REAL, total REAL, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_factura_gasto_items (id INTEGER PRIMARY KEY, factura_id INTEGER,
      gasto_id INTEGER, neto REAL);
    CREATE TABLE sg_proveedores (id INTEGER PRIMARY KEY, razon_social TEXT, cuit TEXT);

    INSERT INTO sg_proveedores (id,razon_social,cuit) VALUES
      (20,'PUENTE CORDON SA','30-11111111-2'), (21,'COOP LA UNION','30-22222222-3');
    INSERT INTO sg_recepciones (id,oc_id) VALUES (5,7), (6,7);
    -- Un flete y una descarga, los dos valorizados. Es el caso de Pablo: el
    -- productor A, y los proveedores B (fletero) y C (cooperativa).
    INSERT INTO sg_gastos_directos (id,recepcion_id,tipo_gasto,estado,monto,proveedor_servicio_id)
      VALUES (100,5,'flete_entrada','valorizado',180000,20),
             (101,5,'descarga_ingreso','valorizado',60000,21),
             -- Y uno anulado, que no cuenta.
             (102,6,'flete_entrada','anulado',999,20);
  `);
  return db;
}

function facturar(db, { gastoId, facturaId = 900, prov = 20, pv = 1, nro = 1234,
                        neto = 180000, iva = 37800, total = 217800, cuit = '30-11111111-2',
                        activo = 1, imputado = null } = {}) {
  db.prepare(`INSERT OR IGNORE INTO sg_facturas_gasto
    (id,proveedor_servicio_id,tipo_comprobante,punto_venta,numero,fecha_emision,cuit_emisor,
     neto,iva_monto,total,activo) VALUES (?,?,'factura_a',?,?,'2026-09-05',?,?,?,?,?)`)
    .run(facturaId, prov, pv, nro, cuit, neto, iva, total, activo);
  db.prepare('INSERT INTO sg_factura_gasto_items (factura_id,gasto_id,neto) VALUES (?,?,?)')
    .run(facturaId, gastoId, imputado == null ? neto : imputado);
}

test('con los dos gastos sin factura, faltan los dos', () => {
  const db = base();
  assert.deepEqual({ ...gastosSinFactura(db, 7) }, { descarga: 1, flete: 1 });
});

test('cargando la del fletero, deja de faltar sólo ésa', () => {
  const db = base();
  facturar(db, { gastoId: 100 });
  assert.deepEqual({ ...gastosSinFactura(db, 7) }, { descarga: 1, flete: 0 });
});

test('una factura ANULADA no cuenta como cargada', () => {
  // Es lo que hace que anular una factura mal cargada vuelva a trabar la
  // liquidación, en vez de dejarla pasar con un comprobante que ya no existe.
  const db = base();
  facturar(db, { gastoId: 100, activo: 0 });
  assert.equal(gastosSinFactura(db, 7).flete, 1);
});

test('y un gasto sin valorizar todavía no se cuenta acá', () => {
  // Son dos frenos distintos: primero el importe, después el papel. Contarlo en
  // los dos daría dos carteles para el mismo problema.
  const db = base();
  db.exec("UPDATE sg_gastos_directos SET estado='pendiente_valorizar' WHERE id=100");
  assert.equal(gastosSinFactura(db, 7).flete, 0);
});

test('un gasto anulado no traba nada', () => {
  const db = base();
  facturar(db, { gastoId: 100 });
  facturar(db, { gastoId: 101, facturaId: 901, prov: 21, nro: 55, neto: 60000, total: 72600 });
  assert.deepEqual({ ...gastosSinFactura(db, 7) }, { descarga: 0, flete: 0 });
});

test('sólo se miran el flete de entrada y la descarga', () => {
  // La comisión y los gastos administrativos son NUESTROS: no tienen comprobante
  // de tercero detrás, así que exigirles factura trabaría todo sin razón.
  assert.deepEqual(TIPOS_DESCONTABLES, ['flete_entrada', 'descarga_ingreso']);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LO QUE SE IMPRIME
// ══════════════════════════════════════════════════════════════════════════

test('cada comprobante sale con CUIT, razón social, número y el TOTAL', () => {
  const db = base();
  facturar(db, { gastoId: 100 });
  facturar(db, { gastoId: 101, facturaId: 901, prov: 21, pv: 2, nro: 55,
    neto: 60000, iva: 12600, total: 72600, cuit: '30-22222222-3' });
  const cs = comprobantesDeLaPartida(db, 7);
  assert.equal(cs.length, 2);
  const flete = cs.find((c) => c.factura_id === 900);
  assert.equal(flete.emisor, 'PUENTE CORDON SA');
  assert.equal(flete.cuit, '30-11111111-2');
  assert.equal(flete.comprobante, 'A 0001-00001234');
  assert.equal(flete.total, 217800, 'el TOTAL de la factura, no el neto ni lo imputado');
  assert.deepEqual(flete.conceptos, ['Flete']);
  const desc = cs.find((c) => c.factura_id === 901);
  assert.equal(desc.emisor, 'COOP LA UNION');
  assert.deepEqual(desc.conceptos, ['Descarga']);
});

test('el TOTAL va entero aunque se descuente sólo una parte', () => {
  // Pablo: «no importa que solamente estemos descontando una parte». Lo que la
  // declaración necesita es IDENTIFICAR el comprobante.
  const db = base();
  facturar(db, { gastoId: 100, neto: 500000, total: 605000, imputado: 180000 });
  const c = comprobantesDeLaPartida(db, 7)[0];
  assert.equal(c.total, 605000);
  // Y al lado se dice qué parte se imputó, para poder seguir el número que se
  // descuenta arriba.
  assert.equal(c.imputado, 180000);
});

test('una factura que cubre DOS viajes de la partida se cita UNA vez', () => {
  // Citarla dos veces haría creer que son dos comprobantes.
  const db = base();
  db.exec(`INSERT INTO sg_gastos_directos (id,recepcion_id,tipo_gasto,estado,monto,proveedor_servicio_id)
           VALUES (103,6,'flete_entrada','valorizado',90000,20)`);
  facturar(db, { gastoId: 100, imputado: 180000 });
  facturar(db, { gastoId: 103, imputado: 90000 });
  const cs = comprobantesDeLaPartida(db, 7);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].imputado, 270000, 'lo imputado a la partida es la suma de sus viajes');
});

test('el número se arma como está impreso en el papel', () => {
  assert.equal(numeroDe({ tipo_comprobante: 'factura_a', punto_venta: 1, numero: 1234 }),
    'A 0001-00001234');
  assert.equal(numeroDe({ tipo_comprobante: 'factura_b', punto_venta: 12, numero: 7 }),
    'B 0012-00000007');
  // Sin punto de venta cargado no se inventa: se muestra lo que hay.
  assert.equal(numeroDe({ numero: 'X-9' }), 'X-9');
});

test('el PDF imprime el bloque, con el total de cada comprobante', () => {
  const b = trozo(LIQ, 'COMPROBANTES DE TERCEROS QUE SE DESCUENTAN', '\r\n    }');
  assert.match(b, /doc\.text\(String\(c\.cuit \|\| '—'\), L \+ 62, y\)/);
  assert.match(b, /doc\.text\(String\(c\.comprobante \|\| '—'\), L \+ 92, y\)/);
  assert.match(b, /moneyFmt\(c\.total\)/);
  // El nombre se recorta; el CUIT y el número NO: a medias no identifican nada.
  assert.match(b, /String\(c\.emisor \|\| ''\)\.slice\(0, 34\)/);
  assert.ok(!/c\.cuit[^)]*slice\(/.test(b), 'recorta el CUIT');
});

test('y junta los comprobantes de TODAS las partidas del grupo, sin repetir', () => {
  // Una liquidación puede cubrir varias partidas desde el 29/8. Una misma factura
  // del fletero puede cubrir dos de ellas.
  // Desde la V1046 recibe también opts: al emitir se guarda la copia con el flete de salida.
  const f = trozo(LIQ, 'function comprobantesDeLaLiquidacion(liq, opts) {', '\r\n}');
  assert.match(f, /SELECT oc_id FROM liquidacion_partidas WHERE liquidacion_id=\?/);
  assert.match(f, /if \(liq && liq\.oc_id\) ocs\.add/, 'se olvida de las de una sola partida');
  assert.match(f, /vistos\.has\(String\(c\.factura_id\)\)/);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL FRENO
// ══════════════════════════════════════════════════════════════════════════

test('la liquidación se frena si falta la factura, y dice cuál', () => {
  const f = trozo(SERV, 'export function frenoParaLiquidar(', '\r\n}');
  assert.match(f, /const sf = gastosSinFactura\(db, ocId\)/);
  assert.match(f, /sf\.descarga > 0[\s\S]{0,400}factura de la cooperativa/);
  assert.match(f, /sf\.flete > 0[\s\S]{0,400}factura del fletero/);
  // Y dice POR QUÉ, que es lo que evita que alguien lo tome por un capricho.
  assert.match(f, /la declaración jurada queda mal/);
  // Y adónde ir.
  assert.match(f, /🧾 Ingresar factura/);
});

test('va DESPUÉS del freno de valorizar, no antes', () => {
  // Primero se pone el importe —que es lo que entra al costo el día que pasa el
  // camión— y después llega el papel. Al revés, el aviso mandaría a cargar una
  // factura de algo que todavía no tiene precio.
  const f = trozo(SERV, 'export function frenoParaLiquidar(', '\r\n}');
  assert.ok(f.indexOf('gastosSinValorizar(db, ocId)') < f.indexOf('gastosSinFactura(db, ocId)'));
});

test('y la pantalla lo dice antes de que se cargue todo', () => {
  const f = trozo(PANEL, 'var frenos = [];', 'LIQ.frenos = frenos;');
  assert.match(f, /var sf = r\.sin_factura \|\| \{\}/);
  assert.match(f, /factura de '\r?\n?\s*\+ 'la cooperativa/);
  assert.match(f, /factura del '\r?\n?\s*\+ 'fletero/);
  // Los dos frenos del mismo gasto NO se muestran juntos: sería un cartel que
  // dice «hacé dos cosas» sin decir en qué orden.
  assert.match(f, /!Number\(sv\.descarga\) && Number\(sf\.descarga\) > 0/);
  assert.match(f, /!Number\(sv\.flete\) && Number\(sf\.flete\) > 0/);
});

test('el dato viaja desde el servidor, o la pantalla no puede frenar', () => {
  assert.match(SG, /sin_factura: gastosSinFactura\(db, ocId\)/);
  assert.match(SG, /comprobantes: comprobantesDeLaPartida\(db, ocId\)/);
  // Y también en el grupo de partidas, que es como se liquida desde el 29/8.
  assert.match(SG, /sin_factura: \{\r?\n?\s*descarga: partes\.reduce/);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · EL FLETE SALE DE LA FACTURA, Y LA DIFERENCIA VA A GESTIÓN
// ══════════════════════════════════════════════════════════════════════════

test('el flete fiscal es lo FACTURADO, no lo pactado en la orden', () => {
  // Pablo: «con la factura del fletero PERFECCIONAMOS lo de la orden de compra».
  // Antes salía sólo de sg_oc.flete_monto, así que al productor se le descontaba
  // un número sin ningún comprobante detrás.
  const b = trozo(SG, 'LA FACTURA DEL FLETERO PERFECCIONA LA ORDEN', 'se_cobra:');
  assert.match(b, /COALESCE\(SUM\(fi\.neto\),0\) AS neto/);
  assert.match(b, /JOIN sg_facturas_gasto f ON f\.id = fi\.factura_id AND f\.activo = 1/);
  assert.match(b, /const fNeto = fHayFactura \? fFiscal : fAcordado/);
});

test('y la diferencia con lo acordado viaja aparte, para gestión', () => {
  // Es la regla del repo: el ámbito viaja en la línea, y los dos números son
  // ciertos. A AFIP se le informa lo facturado; al productor se le descuenta lo
  // acordado.
  const b = trozo(SG, 'LA FACTURA DEL FLETERO PERFECCIONA LA ORDEN', 'se_cobra:');
  assert.match(b, /acordado: fAcordado/);
  assert.match(b, /facturado: fFiscal/);
  assert.match(b, /dif_gestion: fHayFactura \? r2\(fAcordado - fFiscal\) : 0/);
  assert.match(b, /hay_factura: fHayFactura \? 1 : 0/);
});

test('lo imputado sale del renglón de la factura, no del total del comprobante', () => {
  // Una factura del fletero puede cubrir varias partidas: a ésta le toca su parte.
  const b = trozo(SG, 'LA FACTURA DEL FLETERO PERFECCIONA LA ORDEN', 'se_cobra:');
  assert.match(b, /SUM\(fi\.neto\)/);
  assert.ok(!/SUM\(f\.total\)/.test(b), 'suma el total del comprobante en vez de lo imputado');
});

test('sin factura todavía, se muestra lo acordado — pero no se puede emitir', () => {
  // La pantalla tiene que poder mostrar de qué se está hablando; el freno es el
  // que impide emitir.
  const b = trozo(SG, 'LA FACTURA DEL FLETERO PERFECCIONA LA ORDEN', 'se_cobra:');
  assert.match(b, /Sin factura todavía, lo acordado es lo único que hay/);
  assert.match(b, /const fNeto = fHayFactura \? fFiscal : fAcordado/);
});

test('el manual lo explica, con su versión', () => {
  assert.match(PANEL, /Sin la factura del tercero NO se puede liquidar[\s\S]{0,90}V1030/);
  assert.match(PANEL, /La factura del fletero PERFECCIONA la orden[\s\S]{0,90}V1030/);
  // Los dos frenos y su orden, que es lo que evita que parezca un capricho.
  assert.match(PANEL, /<b>Son dos frenos y van en orden\.<\/b>/);
  // Y la regla fiscal/gestión, dicha como en el resto del repo.
  assert.match(PANEL, /<b>Fiscal<\/b> = lo que dice la factura/);
  assert.match(PANEL, /<b>Gestión<\/b> = la diferencia con lo acordado/);
});
