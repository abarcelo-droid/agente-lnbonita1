// ══ PRECIO CERRADO ES PRECIO CERRADO ═══════════════════════════════════════
//
// Pablo, 26/8/2026: *"liquidación a precio cerrado ES precio cerrado; si hay cambio
// de condición va por MODIFICACIÓN DE LA ORDEN DE COMPRA"*.
//
// Hasta acá esto se cuidaba SÓLO en la pantalla: los campos del precio quedaban
// grises y el servidor guardaba cualquier número que le llegara. Un campo gris no es
// un control — la dirección se escribe igual.
//
// Lo que este test cuida son las dos mitades del cerrojo, que tiran para lados
// opuestos y por eso hay que probarlas juntas:
//
//   · que FRENE lo que tiene que frenar — un neto a pagar que no da el precio de la
//     orden por la cantidad;
//   · que NO frene trabajo legítimo — una orden vieja que no dice si el precio traía
//     IVA ni con qué alícuota, mercadería que entró pesada y sin cajones, una orden
//     con ítems a precios distintos liquidada entera.
//
// La segunda mitad importa tanto como la primera: el mensaje manda a "modificar la
// orden de compra", y para una partida YA RECIBIDA ese camino todavía no existe. Un
// cerrojo que frena de más deja la partida sin poder liquidarse y sin salida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acordadoDeOC, precioUnicoDeOC, recibidoDeOC, objetivoCerrado,
  cierraContraLoAcordado } from '../src/servicios/sg_acordado.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIQ = fs.readFileSync(path.join(RAIZ, 'src/rutas/liquidaciones.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// Una orden de 100 cajones de 20 kg a $500 el kilo → $10.000 el cajón, $1.000.000.
function base(opts = {}) {
  const db = new DatabaseSync(':memory:');
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
  db.prepare('INSERT INTO sg_oc VALUES (1,?,?,?)').run(
    opts.tipo_precio || 'firme',
    opts.precio_incluye_iva === undefined ? null : opts.precio_incluye_iva,
    opts.iva_alicuota_oc === undefined ? null : opts.iva_alicuota_oc);
  db.prepare('INSERT INTO sg_oc_items VALUES (1,1,?,?,?,NULL)')
    .run(('precio_kg' in opts) ? opts.precio_kg : 500, opts.modo_carga || 'bulto', 20);
  db.prepare('INSERT INTO sg_lotes VALUES (1,1,?,?,1)')
    .run(opts.kg != null ? opts.kg : 2000, opts.bultos != null ? opts.bultos : 100);
  return db;
}

test('lo acordado sale de la orden: 100 cajones × $10.000 = $1.000.000', () => {
  const db = base();
  const a = acordadoDeOC(db, 1);
  assert.equal(a.total, 1000000);
  assert.equal(precioUnicoDeOC(db, 1).precio, 10000, 'el precio por cajón: $500/kg × 20 kg');
  assert.equal(precioUnicoDeOC(db, 1).base, 'bulto');
  assert.deepEqual(recibidoDeOC(db, 1), { bultos: 100, kg: 2000 });
});

test('lo que NO da el precio de la orden se frena', () => {
  const db = base({ precio_incluye_iva: 1 });
  const obj = objetivoCerrado(db, { ocId: 1, cantidad: 100 });
  assert.equal(obj.ok, true);
  assert.equal(obj.objetivo, 1000000);
  assert.equal(cierraContraLoAcordado(1000000, obj), true, 'el número de la orden pasa');
  assert.equal(cierraContraLoAcordado(999999, obj), false, 'un peso de menos, no');
  assert.equal(cierraContraLoAcordado(1100000, obj), false, 'y un precio inventado, tampoco');
});

test('una liquidación PARCIAL se controla por precio × cantidad', () => {
  const db = base({ precio_incluye_iva: 1 });
  const obj = objetivoCerrado(db, { ocId: 1, cantidad: 40 });
  assert.equal(obj.objetivo, 400000, '40 cajones × $10.000');
  assert.equal(obj.entera, false);
  assert.equal(cierraContraLoAcordado(400000, obj), true);
  assert.equal(cierraContraLoAcordado(1000000, obj), false,
    'liquidar 40 cajones y pagar la partida entera es pagar de más');
});

test('el precio ACORDADO sin IVA se le suma, y con IVA no', () => {
  const conIva = objetivoCerrado(base({ precio_incluye_iva: 1, iva_alicuota_oc: 10.5 }),
    { ocId: 1, cantidad: 100 });
  assert.equal(cierraContraLoAcordado(1000000, conIva), true);
  assert.equal(cierraContraLoAcordado(1105000, conIva), false, 'con IVA no se le suma otra vez');
  const sinIva = objetivoCerrado(base({ precio_incluye_iva: 0, iva_alicuota_oc: 10.5 }),
    { ocId: 1, cantidad: 100 });
  assert.equal(cierraContraLoAcordado(1105000, sinIva), true);
  assert.equal(cierraContraLoAcordado(1000000, sinIva), false, 'sin IVA hay que sumárselo');
});

// ── Y AHORA LA OTRA MITAD: LO QUE NO SE PUEDE FRENAR ────────────────────────
test('una orden VIEJA que no dice si el precio traía IVA admite las dos lecturas', () => {
  // precio_incluye_iva NULL: es como quedaron las órdenes anteriores a la columna.
  const obj = objetivoCerrado(base(), { ocId: 1, cantidad: 100 });
  assert.equal(obj.ok, true);
  assert.equal(obj.dice_iva, null, 'la orden no lo dice, y se admite');
  assert.equal(cierraContraLoAcordado(1000000, obj), true, 'leída con IVA');
  assert.equal(cierraContraLoAcordado(1105000, obj), true, 'leída sin IVA, al 10,5%');
  assert.equal(cierraContraLoAcordado(1210000, obj), true, 'y al 21%, que la orden tampoco fija');
  assert.equal(cierraContraLoAcordado(1500000, obj), false, 'lo que no sale de la orden, no');
});

test('el producto al 21% con la orden que no fija alícuota NO se rechaza', () => {
  // Este es el caso que rompía: el servidor comparaba contra 10,5% fijo y la pantalla
  // despejaba la alícuota REAL de las ventas de la partida. Un producto al 21% daba
  // 400 sobre una liquidación correcta.
  const obj = objetivoCerrado(base(), { ocId: 1, cantidad: 100 });
  assert.equal(cierraContraLoAcordado(1210000, obj), true);
});

test('lo que la pantalla eligió manda cuando la orden no dice nada', () => {
  const obj = objetivoCerrado(base({ iva_alicuota_oc: 10.5 }),
    { ocId: 1, cantidad: 100, incluyeIvaElegido: false });
  assert.equal(cierraContraLoAcordado(1105000, obj), true, 'la pantalla dijo "sin IVA"');
  assert.equal(cierraContraLoAcordado(1000000, obj), false, '…y entonces el neto pelado no cierra');
});

test('la orden que SÍ lo dice le gana a la pantalla', () => {
  const obj = objetivoCerrado(base({ precio_incluye_iva: 1, iva_alicuota_oc: 10.5 }),
    { ocId: 1, cantidad: 100, incluyeIvaElegido: false });
  assert.equal(cierraContraLoAcordado(1000000, obj), true, 'la orden dice con IVA y eso vale');
  assert.equal(cierraContraLoAcordado(1105000, obj), false);
});

test('mercadería que entró PESADA y sin cajones se puede liquidar igual', () => {
  // bultos = 0: no hay cantidad que poner en «bultos a liquidar». Con el cerrojo
  // pidiendo cantidad, esa partida no se podía liquidar NUNCA.
  const db = base({ modo_carga: 'kilo', bultos: 0, kg: 1800 });
  const obj = objetivoCerrado(db, { ocId: 1, cantidad: null });
  assert.equal(obj.ok, true, 'sin cantidad se controla contra la partida entera');
  assert.equal(obj.objetivo, 900000, '1.800 kg × $500');
  assert.equal(cierraContraLoAcordado(900000, obj), true);
  assert.equal(cierraContraLoAcordado(1000000, obj), false);
});

test('la orden pactada POR KILO admite las DOS lecturas de la unidad', () => {
  // El kilaje real del cajón no es el nominal: 100 cajones que pesaron 1.800 kg se
  // pagan 1.800 × $500 = $900.000 según la orden, y la pantalla de la liquidación
  // —que trabaja por cajón— propone 100 × ($500 × 20) = $1.000.000.
  //
  // LOS DOS SALEN DE LA ORDEN, así que los dos pasan. Admitir sólo uno era el peor
  // caso posible del cerrojo: el operador veía el tilde verde y el servidor le
  // contestaba 400, y como modificar el precio de una orden ya recibida todavía no
  // existe, esa partida no se podía liquidar nunca.
  const db = base({ modo_carga: 'kilo', kg: 1800, bultos: 100 });
  assert.equal(acordadoDeOC(db, 1).total, 900000, 'la orden dice los kilos REALES');
  const obj = objetivoCerrado(db, { ocId: 1, cantidad: 100 });
  assert.equal(cierraContraLoAcordado(900000, obj), true, 'lo que dice la orden');
  assert.equal(cierraContraLoAcordado(1000000, obj), true, 'y lo que propone la pantalla');
  // Lo que se frena sigue siendo lo que hay que frenar: un precio que no es el pactado.
  assert.equal(cierraContraLoAcordado(1500000, obj), false);
  assert.equal(cierraContraLoAcordado(700000, obj), false);
});

test('no se liquida más de lo que entró', () => {
  // Un cero de más en «bultos a liquidar»: precio × 1.000 es un número que sale de la
  // orden, así que el cerrojo lo daba por bueno y le pagaba al productor diez veces
  // la partida.
  const obj = objetivoCerrado(base({ precio_incluye_iva: 1 }), { ocId: 1, cantidad: 1000 });
  assert.equal(obj.ok, false);
  assert.match(obj.motivo, /no recibimos/i);
});

test('una partida a PRECIO ABIERTO no tiene precio cerrado que exigirle', () => {
  const obj = objetivoCerrado(base({ tipo_precio: 'pizarra' }), { ocId: 1, cantidad: 100 });
  assert.equal(obj.ok, false);
  assert.match(obj.motivo, /PRECIO ABIERTO/);
});

test('sin precio en la orden no hay precio cerrado, y se dice dónde cargarlo', () => {
  const db = base({ precio_kg: null });
  const obj = objetivoCerrado(db, { ocId: 1, cantidad: 100 });
  assert.equal(obj.ok, false);
  assert.match(obj.motivo, /orden de compra/i);
});

test('con ítems a precios distintos se puede liquidar la partida ENTERA', () => {
  const db = base({ precio_incluye_iva: 1 });
  db.prepare("INSERT INTO sg_oc_items VALUES (2,1,700,'bulto',20,NULL)").run();
  db.prepare('INSERT INTO sg_lotes VALUES (2,2,1000,50,1)').run();
  assert.equal(precioUnicoDeOC(db, 1).precio, null, 'no hay UN precio por cajón');
  const entera = objetivoCerrado(db, { ocId: 1, cantidad: 150 });
  assert.equal(entera.ok, true, 'liquidando todo lo que entró sí hay un número: el de la orden');
  assert.equal(entera.objetivo, 1700000, '$1.000.000 + 50 cajones × $14.000');
  // Pero una PARTE no tiene contra qué controlarse, y se dice en vez de inventar.
  const parte = objetivoCerrado(db, { ocId: 1, cantidad: 40 });
  assert.equal(parte.ok, false);
  assert.match(parte.motivo, /precio por unidad/i);
  assert.match(parte.motivo, /partida entera/i, 'y se dice cuál es la salida');
});

test('la condición la dice la ORDEN, no el radio de la pantalla', () => {
  // El cerrojo corría sólo si el cliente decía 'cerrado'. Un clic en «Precio abierto»
  // sobre una partida firme lo saltaba entero: la pantalla marca el modo al abrir
  // pero no lo traba, así que la puerta que esto viene a cerrar quedaba con la llave
  // puesta al lado.
  assert.match(LIQ, /String\(d\.modo_precio \|\| ''\) !== 'cerrado'/);
  assert.match(LIQ, /no se puede liquidar a precio abierto/i);
});

test('entre todas las liquidaciones de una partida tampoco se paga de más', () => {
  // Dos parciales de 60 cajones sobre una partida de 100 pasaban las dos, y al
  // productor se le pagaba por 120.
  assert.match(LIQ, /FROM liquidaciones WHERE oc_id = \? AND eliminado_en IS NULL/);
  assert.match(LIQ, /ya tiene liquidaciones por/i);
});

// ── EL CERROJO ESTÁ PUESTO DONDE DECIDE ─────────────────────────────────────
test('el cerrojo corre en el POST que guarda, no sólo en la pantalla', () => {
  assert.match(LIQ, /objetivoCerrado\(/, 'el que guarda la liquidación lo consulta');
  assert.match(LIQ, /cierraContraLoAcordado\(/);
  assert.match(LIQ, /se modifica LA ORDEN DE COMPRA/,
    'y dice a dónde ir, que es lo único que el usuario puede hacer');
  // Lo que se compara es el NETO A PAGAR: comprobante + lo reconocido por fuera. Es
  // la misma suma que la cuenta corriente del productor.
  assert.match(LIQ, /const pagar = Math\.round\(\(\(parseFloat\(d\.total\) \|\| 0\) \+ difG\)/);
});

test('a precio cerrado el precio NO lo edita nadie, ni el administrador', () => {
  // Antes decía «lo edita el administrador», y era la puerta entreabierta: el
  // administrador es justamente el que podría cambiar un precio pactado sin que
  // quede rastro donde se pactó.
  assert.match(PANEL, /function liqPrecioDeLaOrden\(\)/);
  assert.doesNotMatch(PANEL.slice(PANEL.indexOf('function liqPrecioDeLaOrden()'),
    PANEL.indexOf('function liqPrecioDeLaOrden()') + 400), /rol === 'admin'/,
    'la regla del precio no puede mirar el rol');
  // Y la grilla —los gastos, la descarga, el flete— sigue con la regla vieja: eso es
  // operatoria del día y a veces hay que corregirla.
  assert.match(PANEL, /function liqCerradoBloquea\(\)\s*\{\s*[\s\S]{0,200}rol === 'admin'/);
});

test('la pantalla no manda lo que ya sabe que va a rebotar', () => {
  assert.match(PANEL, /El neto a pagar no da el precio acordado/,
    'se avisa ANTES de guardar: si no, se arma la liquidación entera y rebota al final');
  assert.match(PANEL, /precio_incluye_iva:\s*\(function\(\)/,
    'y viaja qué leyó la pantalla, o el selector de IVA no serviría para nada');
});
