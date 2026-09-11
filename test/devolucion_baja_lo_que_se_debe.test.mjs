// ══════════════════════════════════════════════════════════════════════════
// LA DEVOLUCIÓN AL PRODUCTOR BAJA LO QUE SE LE DEBE — DE VERDAD
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 2/9/2026: si la mercadería vuelve al productor y la partida NO estaba firme,
// «sí baja lo que se le debe». Y si ya estaba firme, «una vez liquidado ya todo es
// firme»: se registra igual y es pérdida nuestra.
//
// LA DECISIÓN ESTABA TOMADA Y NADIE LA LEÍA. La devolución calcula y guarda en cada
// renglón si le descuenta al productor, y en rutas/sg.js hay una fórmula que la usa
// —KG_INGRESADO_NETO—. Pero esa fórmula no la llamaba ninguna pantalla: sólo los
// tests. Lo acordado con el productor salía de TODO lo recibido. O sea: el sistema
// anotaba «esta devolución le descuenta» y el productor cobraba igual la mercadería
// que ya tenía de vuelta.
//
// Un test que prueba una fórmula que nadie usa no protege nada. Éstos corren
// acordadoDeOC y recibidoDeOC, que son los que usan las ocho pantallas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DBSG = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const A = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/sg_acordado.js')).href);

// Las dos tablas de devolución, TAL CUAL las crea el arranque: si la consulta usara
// una columna que no existe, el test lo dice acá y no el operador en producción.
function ddl(tabla) {
  const i = DBSG.indexOf('CREATE TABLE IF NOT EXISTS ' + tabla + ' (');
  assert.ok(i > 0, 'no está el CREATE de ' + tabla);
  let d = 0, j = DBSG.indexOf('(', i);
  for (; j < DBSG.length; j++) {
    if (DBSG[j] === '(') d++;
    else if (DBSG[j] === ')') { d--; if (d === 0) break; }
  }
  return DBSG.slice(i, j + 1) + ';';
}

// Un camión con dos productos a precio distinto, pactados por cajón de 20 kg:
//   durazno  60 cajones × $8.000 = $480.000
//   ciruela  40 cajones × $2.000 =  $80.000      → $560.000
function camion(opts = {}) {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  db.exec(`
    CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, tipo_precio TEXT,
      precio_incluye_iva INTEGER, iva_alicuota_oc REAL);
    CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY, oc_id INTEGER, precio_estimado_por_kg REAL,
      modo_carga TEXT, kg_por_bulto REAL, presentacion_id INTEGER);
    CREATE TABLE sg_presentaciones (id INTEGER PRIMARY KEY, factor_conversion REAL);
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, oc_item_id INTEGER, kg_reales REAL,
      bultos REAL, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_lote_decomisos (id INTEGER PRIMARY KEY, lote_id INTEGER, kg REAL,
      bultos INTEGER, motivo TEXT, fecha TEXT);
  `);
  if (!opts.sinTablas) {
    db.exec(ddl('sg_devoluciones'));
    db.exec(ddl('sg_devolucion_items'));
    // La marca se agrega por addCol al arrancar, no está en el CREATE.
    assert.match(DBSG, /addCol\('sg_devolucion_items', 'descuenta_al_productor', 'INTEGER'\)/);
    db.exec('ALTER TABLE sg_devolucion_items ADD COLUMN descuenta_al_productor INTEGER');
    db.exec(`INSERT INTO sg_devoluciones (id, numero, despacho_id, estado) VALUES (1, 'SG-DEV-1', 1, 'registrada')`);
  }
  db.prepare("INSERT INTO sg_oc VALUES (1,'firme',1,10.5)").run();
  db.prepare("INSERT INTO sg_oc_items VALUES (1,1,400,'bulto',20,NULL)").run();   // durazno
  db.prepare("INSERT INTO sg_oc_items VALUES (2,1,100,'bulto',20,NULL)").run();   // ciruela
  db.prepare('INSERT INTO sg_lotes VALUES (1,1,1200,60,1)').run();
  db.prepare('INSERT INTO sg_lotes VALUES (2,2,800,40,1)').run();
  return db;
}

let _renglon = 0;
function devolver(db, { lote, bultos, kg, destino = 'proveedor', descuenta = 1, dev = 1 }) {
  _renglon++;
  db.prepare(`INSERT INTO sg_devolucion_items
    (devolucion_id, despacho_item_id, lote_id, bultos, kg, destino, piso_id, descuenta_al_productor)
    VALUES (?,?,?,?,?,?,?,?)`).run(dev, 1000 + _renglon, lote, bultos, kg, destino, 1, descuenta);
}

// ══════════════════════════════════════════════════════════════════════════
// 1 · LO ACORDADO
// ══════════════════════════════════════════════════════════════════════════

test('sin devoluciones, el camión vale lo mismo que siempre', () => {
  const db = camion();
  assert.equal(A.acordadoDeOC(db, 1).total, 560000);
});

test('diez cajones de ciruela devueltos descuentan diez cajones DE CIRUELA', () => {
  // No «diez cajones al precio promedio del camión»: eso daría un número creíble y
  // equivocado, y la diferencia la paga el productor o la pagamos nosotros.
  const db = camion();
  devolver(db, { lote: 2, bultos: 10, kg: 200 });
  const a = A.acordadoDeOC(db, 1);
  assert.equal(a.total, 540000, 'no descontó lo devuelto');
  const cir = a.detalle.find((d) => d.oc_item_id === 2);
  assert.equal(cir.importe, 60000);
  // Y el durazno no se enteró.
  assert.equal(a.detalle.find((d) => d.oc_item_id === 1).importe, 480000);
});

test('si la partida ya estaba firme cuando se devolvió, NO se le descuenta', () => {
  // «Una vez liquidado ya todo es firme» — Pablo. Se decide al registrar la
  // devolución y queda congelado en el renglón.
  const db = camion();
  devolver(db, { lote: 2, bultos: 10, kg: 200, descuenta: 0 });
  assert.equal(A.acordadoDeOC(db, 1).total, 560000);
});

test('las devoluciones de antes de la marca descuentan', () => {
  // El renglón sin marca es de cuando la marca no existía, y la regla de siempre fue
  // que lo que vuelve al productor le baja lo que se le debe.
  const db = camion();
  devolver(db, { lote: 2, bultos: 10, kg: 200, descuenta: null });
  assert.equal(A.acordadoDeOC(db, 1).total, 540000);
});

test('lo que volvió al STOCK no le toca nada al productor', () => {
  // Esa mercadería es nuestra y se va a vender otra vez: se le debe igual.
  const db = camion();
  devolver(db, { lote: 2, bultos: 10, kg: 200, destino: 'stock' });
  assert.equal(A.acordadoDeOC(db, 1).total, 560000);
});

test('una devolución anulada no descuenta', () => {
  const db = camion();
  db.exec(`INSERT INTO sg_devoluciones (id, numero, despacho_id, estado) VALUES (2, 'SG-DEV-2', 1, 'anulada')`);
  devolver(db, { lote: 2, bultos: 10, kg: 200, dev: 2 });
  assert.equal(A.acordadoDeOC(db, 1).total, 560000);
});

test('devolver la ciruela entera deja la ciruela en cero, y sigue siendo por cajón', () => {
  // Si descontar la hiciera caer a la cuenta por kilo, el cerrojo hablaría de una
  // cuenta que nadie hizo: se pactó por cajón igual.
  const db = camion();
  devolver(db, { lote: 2, bultos: 40, kg: 800 });
  const cir = A.acordadoDeOC(db, 1).detalle.find((d) => d.oc_item_id === 2);
  assert.equal(cir.importe, 0);
  assert.equal(cir.base, 'bulto');
});

test('la merma y la devolución se descuentan cada una por su lado, sin pisarse', () => {
  // Del mismo lote: 5 cajones se tiraron y 10 se devolvieron. Pagando sin merma se
  // descuentan los 15; pagando con merma, sólo los 10 devueltos.
  const db = camion();
  devolver(db, { lote: 2, bultos: 10, kg: 200 });
  db.prepare('INSERT INTO sg_lote_decomisos (lote_id, kg, bultos, motivo) VALUES (2,100,5,?)').run('podrido');
  assert.equal(A.acordadoDeOC(db, 1).total, 540000);
  assert.equal(A.acordadoDeOC(db, 1, { sinMermas: true }).total, 530000);
});

test('en una base sin las tablas de devolución, no se cae', () => {
  const db = camion({ sinTablas: true });
  assert.equal(A.acordadoDeOC(db, 1).total, 560000);
  assert.deepEqual(A.recibidoDeOC(db, 1), { bultos: 100, kg: 2000 });
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LO RECIBIDO, Y LA LIQUIDACIÓN
// ══════════════════════════════════════════════════════════════════════════

test('lo devuelto no cuenta como recibido', () => {
  // Esos cajones son del productor otra vez. Si se contaran, liquidarle todo lo que
  // quedó parecería «una parte» de lo recibido.
  const db = camion();
  devolver(db, { lote: 2, bultos: 10, kg: 200 });
  assert.deepEqual(A.recibidoDeOC(db, 1), { bultos: 90, kg: 1800 });
});

test('no se le puede liquidar lo que ya se le devolvió', () => {
  // Liquidar los 100 cajones del camión es pagarle al productor diez cajones que
  // tiene él.
  const db = camion();
  devolver(db, { lote: 2, bultos: 10, kg: 200 });
  const obj = A.objetivoCerrado(db, { ocId: 1, cantidad: 100 });
  assert.equal(obj.ok, false);
  assert.match(obj.motivo, /entraron 90 bultos/);
  // Los 90 que quedaron, sí.
  assert.notEqual(A.objetivoCerrado(db, { ocId: 1, cantidad: 90 }).ok, false);
});

test('y el total que admite la liquidación es el que quedó', () => {
  const db = camion();
  devolver(db, { lote: 2, bultos: 10, kg: 200 });
  const obj = A.objetivoCerrado(db, { ocId: 1, cantidad: 90 });
  assert.ok(obj.ok !== false, obj.motivo);
  // Liquidar lo que quedó entero se cierra contra los $540.000, no contra los 560.
  assert.equal(A.cierraContraLoAcordado(540000, obj), true, 'lo que quedó no cierra: ' + JSON.stringify(obj.admitidos));
  assert.equal(A.cierraContraLoAcordado(560000, obj), false,
    'se puede liquidar el camión entero como si no se hubiera devuelto nada');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL MANUAL YA LO PROMETÍA
// ══════════════════════════════════════════════════════════════════════════

const plano = (txt) => String(txt).replace(/'\s*\+\s*'/g, '');

test('el manual dice lo que ahora es cierto, con su versión', () => {
  const i = PANEL.indexOf('SG_MANUAL.ventas = ');
  const man = plano(PANEL.slice(i, PANEL.indexOf('SG_MANUAL.reprocesos = ', i)));
  assert.match(man, /<span class="ver">V1043<\/span> <b>Lo que se le devuelve al productor se le descuenta de lo que se le debe<\/b>/);
  assert.match(man, /diez cajones de ciruela descuentan diez cajones de ciruela/);
  // Y es cierto: la cuenta de lo acordado pasa por las devoluciones.
  const src = fs.readFileSync(path.join(RAIZ, 'src/servicios/sg_acordado.js'), 'utf8');
  assert.match(src, /const dev = devueltoPorItemDeOC\(db, ocId\);/);
});
