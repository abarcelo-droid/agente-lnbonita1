// ══ PARTIDA PERFECCIONADA = PRECIO FIRME ═══════════════════════════════════
//
// Pablo, 26/8/2026, al pie de la letra:
//
//   «una vez que se perfecciona la orden de compra con una FACTURA o una
//    LIQUIDACIÓN, ya no se puede modificar la orden de compra y ese precio queda
//    FIRME. La única manera de modificarlo es anular la factura recibida o la
//    liquidación emitida y cambiar el precio.»
//
// La regla ya se estaba violando por TRES puertas, y ninguna avisaba:
//
//   1. frenosDeEdicionLote miraba SÓLO la factura, y encima exigía asiento vivo. Una
//      partida ya LIQUIDADA se corregía sin que nadie chistara.
//   2. POST /oc/:id/completar repreciaba una orden retroactiva entera sin mirar nada,
//      con el papel del proveedor ya cargado.
//   3. POST /lotes/:id/cerrar-precio le fijaba el precio a una partida de pizarra sin
//      mirar si ya estaba documentada.
//
// Y dos precisiones de Pablo que cambian el criterio:
//   · «factura cargada y contabilizada debería ser lo mismo: si está cargada, se debe
//     haber disparado el asiento» → alcanza con que la factura esté VIVA. No se pide
//     el asiento, que era la ventana por la que se colaba el caso.
//   · «vale para todas las partidas» → también las de precio abierto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { perfeccionamientoDeOC, motivoPrecioFirme, frenoPrecioFirme }
  from '../src/servicios/sg_perfeccionada.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const LIQ = fs.readFileSync(path.join(RAIZ, 'src/rutas/liquidaciones.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, liquidada_en TEXT);
    CREATE TABLE sg_facturas_compra (id INTEGER PRIMARY KEY, numero TEXT, oc_id INTEGER,
      activo INTEGER DEFAULT 1, asiento_id INTEGER);
    CREATE TABLE sg_factura_compra_ocs (factura_id INTEGER, oc_id INTEGER);
    CREATE TABLE liquidaciones (id INTEGER PRIMARY KEY, n_liquidacion TEXT, oc_id INTEGER,
      asiento_id INTEGER, eliminado_en TEXT);
    INSERT INTO sg_oc (id) VALUES (1),(2),(3);
  `);
  return db;
}

test('una partida sin factura ni liquidación está libre', () => {
  assert.equal(perfeccionamientoDeOC(base(), 1), null);
  assert.equal(frenoPrecioFirme(base(), 1, 'cambiar el precio'), null);
});

test('la factura CARGADA ya deja el precio firme, sin pedirle el asiento', () => {
  // Es la precisión de Pablo: «si está cargada, se debe haber disparado el asiento».
  // Con el criterio viejo —asiento vivo— una factura cargada y todavía sin
  // contabilizar dejaba el precio editable justo cuando ya hay papel del proveedor.
  const db = base();
  db.prepare("INSERT INTO sg_facturas_compra (id,numero,oc_id,activo,asiento_id) VALUES (9,'A-0001-99',1,1,NULL)").run();
  const p = perfeccionamientoDeOC(db, 1);
  assert.equal(p.como, 'factura');
  assert.equal(p.numero, 'A-0001-99');
  assert.match(motivoPrecioFirme(p), /FIRME/);
  assert.match(motivoPrecioFirme(p), /anulá primero esa factura/i, 'y dice cuál es la salida');
});

test('la factura que cubre VARIAS partidas las traba a todas', () => {
  // Si sólo se mirara f.oc_id, las partidas secundarias —las de
  // sg_factura_compra_ocs— quedaban libres con su comprobante ya cargado.
  const db = base();
  db.prepare("INSERT INTO sg_facturas_compra (id,numero,oc_id,activo) VALUES (9,'A-0001-99',1,1)").run();
  db.prepare('INSERT INTO sg_factura_compra_ocs VALUES (9,2)').run();
  assert.equal(perfeccionamientoDeOC(db, 2).como, 'factura');
  assert.equal(perfeccionamientoDeOC(db, 3), null, 'la que no está en la factura sigue libre');
});

test('la LIQUIDACIÓN emitida también perfecciona — y eso no lo miraba nadie', () => {
  const db = base();
  db.prepare("INSERT INTO liquidaciones (id,n_liquidacion,oc_id) VALUES (5,'1-205',1)").run();
  const p = perfeccionamientoDeOC(db, 1);
  assert.equal(p.como, 'liquidacion');
  assert.equal(p.numero, '1-205');
  assert.match(motivoPrecioFirme(p), /anulá primero esa liquidación/i);
});

test('anulada la factura o la liquidación, la partida vuelve a quedar libre', () => {
  // Es la vuelta que Pablo describe: «la única manera es anular y cambiar el precio».
  const db = base();
  db.prepare("INSERT INTO sg_facturas_compra (id,numero,oc_id,activo) VALUES (9,'A-1',1,1)").run();
  assert.ok(perfeccionamientoDeOC(db, 1));
  db.prepare('UPDATE sg_facturas_compra SET activo=0 WHERE id=9').run();
  assert.equal(perfeccionamientoDeOC(db, 1), null);

  db.prepare("INSERT INTO liquidaciones (id,n_liquidacion,oc_id) VALUES (5,'1-205',1)").run();
  assert.ok(perfeccionamientoDeOC(db, 1));
  db.prepare("UPDATE liquidaciones SET eliminado_en=datetime('now') WHERE id=5").run();
  assert.equal(perfeccionamientoDeOC(db, 1), null);
});

test('y la marca a mano de «liquidada» también cuenta', () => {
  const db = base();
  db.prepare("UPDATE sg_oc SET liquidada_en='2026-08-20' WHERE id=1").run();
  const p = perfeccionamientoDeOC(db, 1);
  assert.equal(p.como, 'marca');
  assert.match(motivoPrecioFirme(p), /marcada como liquidada/i);
});

// ── LAS TRES PUERTAS ────────────────────────────────────────────────────────
test('la respuesta es UNA, no una consulta copiada en cada endpoint', () => {
  // Estaba escrita a mano en tres lugares de sg.js, con criterios distintos entre sí
  // y ninguno miraba la liquidación. Una cuarta copia garantizaba que el día que
  // cambiara el criterio, alguna quedara vieja.
  assert.match(SG, /import \{ frenoPrecioFirme, precioFirmeDetalle \} from '\.\.\/servicios\/sg_perfeccionada\.js'/);
  // Las NUEVE puertas por las que se puede cambiar lo que se le va a pagar al
  // productor: corregir un lote, completar una orden retroactiva, cerrarle el
  // precio a una de pizarra, editar los precios de la orden, cambiarla de circuito,
  // cambiar las CANTIDADES de la orden —que mueven el total igual que el precio— y
  // las tres del 29/8/2026: partirle el renglón a una partida, separarla por calidad
  // (que parte el renglón sola) y DESHACER esa separación, que le devuelve la
  // mercadería al renglón de la primera y con eso el precio viejo.
  //
  // Corregir el lote usa precioFirmeDetalle, que es la MISMA respuesta con los
  // datos del comprobante puestos: la pantalla los necesita para ofrecer el botón
  // de anular. Sigue siendo una sola fuente — las dos salen de
  // perfeccionamientoDeOC(), no de una consulta escrita de nuevo.
  const usos = (SG.match(/frenoPrecioFirme\(db,/g) || []).length
             + (SG.match(/precioFirmeDetalle\(db,/g) || []).length;
  assert.equal(usos, 9, 'todas las puertas usan la misma función');
  // Y no volvieron las copias que había, cada una con su propio mensaje: son la
  // huella de que alguien volvió a escribir la pregunta en vez de preguntarla.
  assert.doesNotMatch(SG, /Anulá el asiento primero: si se corrigen los kilos/);
  assert.doesNotMatch(SG, /Anulá el asiento antes de cambiarla de circuito/);
});

test('corregir un lote de una partida documentada se frena', () => {
  const i = SG.indexOf('function frenosDeEdicionLote(');
  assert.ok(i > 0);
  const cuerpo = SG.slice(i, i + 1600);
  assert.match(cuerpo, /precioFirmeDetalle\(db, l\.oc_id, 'corregir los kilos o el precio'\)/);
  // Y devuelve QUIÉN traba, no sólo el texto: sin eso la pantalla no puede ofrecer
  // el camino y el cerrojo vuelve a ser una pared.
  assert.match(cuerpo, /return \{ error: det\.error, firme: det\.firme \}/);
});

test('el cerrojo dice a dónde ir, y la regla no se afloja', () => {
  // Pablo, 27/8/2026: «el mensaje está OK, pero debe permitirme corregir el precio».
  // La regla del 26/8 sigue entera —hay que anular el comprobante primero— pero el
  // cartel deja de ser el final del camino: dice cuál lo traba y ofrece anularlo.
  assert.match(SG, /firme: chk\.firme \|\| null/);
  assert.match(PANEL, /function sgLoteFirmeCartel\(error, firme\)\{/);
  assert.match(PANEL, /function sgLoteFirmeAnular\(\)\{/);
  assert.match(PANEL, /Anular y corregir el precio/);
  // Las dos puertas de anulación, cada una a la suya.
  assert.match(PANEL, /'\/api\/sg\/facturas-compra\/' \+ f\.id \+ '\/anular'/);
  assert.match(PANEL, /'\/api\/liquidaciones\/' \+ f\.id \+ '\/anular'/);
  // El motivo sigue siendo obligatorio: anular sin rastro es lo que esto evita.
  assert.match(PANEL, /Poné por qué se anula/);
  // La marca a mano no es un comprobante: no hay nada que anular ahí.
  assert.match(PANEL, /firme\.como === 'marca'/);
  // Y el cartel de la partida anterior no puede quedar pegado.
  assert.match(PANEL, /sgLoteFirmeCartel\(null, null\);\s*\/\/ el cartel de la partida anterior/);
});

test('repreciar una orden retroactiva ya documentada se frena', () => {
  const i = SG.indexOf("router.post('/oc/:id/completar'");
  assert.ok(i > 0);
  const cuerpo = SG.slice(i, i + 1800);
  assert.match(cuerpo, /frenoPrecioFirme\(db, oc\.id, 'cambiar el precio'\)/);
  assert.match(cuerpo, /res\.status\(409\)/, 'conflicto, no un error de datos');
});

test('cerrarle el precio a una partida de pizarra ya documentada se frena', () => {
  // «Vale para todas»: acá el precio no vive en la orden sino en el lote, pero la
  // regla es la misma.
  const i = SG.indexOf("router.post('/lotes/:id/cerrar-precio'");
  assert.ok(i > 0);
  const cuerpo = SG.slice(i, i + 1600);
  assert.match(cuerpo, /frenoPrecioFirme\(db, ocDelLote\.oc_id, 'cerrarle el precio'\)/);
});

// ── LA PUERTA DE VUELTA ─────────────────────────────────────────────────────
test('anular una liquidación pide MOTIVO, como la factura de compra', () => {
  // Es la puerta oficial para destrabar un precio firme y era la más floja de las
  // dos: se daba de baja con un DELETE pelado y no quedaba escrito por qué.
  assert.match(LIQ, /router\.post\('\/:id\/anular'/, 'y por su propia dirección');
  assert.match(LIQ, /function anularLiquidacion\(id, motivo, usuarioId\)/);
  assert.match(LIQ, /Poné por qué se anula/);
  assert.match(LIQ, /ALTER TABLE liquidaciones ADD COLUMN anulado_motivo TEXT/);
  // El DELETE de siempre queda, pero pasa por la MISMA función: dos maneras de
  // anular, una sin rastro, es exactamente lo que esto viene a corregir.
  assert.match(LIQ, /router\.delete\('\/:id', function \(req, res\) \{\s*\r?\n\s*const r = anularLiquidacion/);
});

test('una liquidación ya pagada no se anula', () => {
  // La plata al productor ya salió: darla de baja deja el pago colgado de un
  // comprobante que no existe. Es el mismo freno que tiene la factura de compra.
  assert.match(LIQ, /pagados al productor\. Anulá primero el pago/);
});

test('el asiento se anula CON la liquidación y con el motivo pegado', () => {
  assert.match(LIQ, /descripcion \|\| ' — ANULADO: se dio de baja la liquidación '/);
  assert.match(LIQ, /\|\| \? \|\| ' — ' \|\| \?/, 'el motivo queda en la descripción del asiento');
});

test('la pantalla pide el motivo y avisa que la partida queda libre', () => {
  assert.match(PANEL, /\/anular', 'POST', \{ motivo: motivo \}\)/);
  assert.match(PANEL, /su precio se va a poder/);
  assert.doesNotMatch(PANEL, /fetch\('\/api\/liquidaciones\/'\+id, \{ method:'DELETE'/,
    'ya no se anula por el camino sin motivo');
});

test('cambiar las CANTIDADES de la orden también respeta el precio firme', () => {
  // Mueven el total que se le va a pagar al productor igual que el precio: si la
  // partida ya está documentada, el papel diría una cosa y la orden otra.
  const i = SG.indexOf("router.put('/oc/:id/cantidades'");
  assert.ok(i > 0, 'no existe el endpoint de cantidades');
  const b = SG.slice(i, i + 2200);
  assert.match(b, /frenoPrecioFirme\(db, oc\.id, 'cambiar las cantidades'\)/);
  assert.match(b, /res\.status\(409\)/, 'conflicto, no un error de datos');
});

test('y sólo se pueden cambiar ANTES de que entre mercadería', () => {
  // Después de la primera recepción la cantidad de la orden es historia: lo que
  // vale es lo que se contó al bajar el camión.
  const i = SG.indexOf("router.put('/oc/:id/cantidades'");
  const b = SG.slice(i, i + 2200);
  assert.match(b, /SELECT COUNT\(\*\) c FROM sg_recepciones WHERE oc_id=\? AND activo=1/);
  assert.match(b, /los bultos de la orden no se cambian después/);
  // El cerrojo es que no haya recepciones, NO el estado: una orden puede quedar
  // 'abierta' con una recepción anulada.
  assert.match(b, /if \(rec > 0\)/);
});
