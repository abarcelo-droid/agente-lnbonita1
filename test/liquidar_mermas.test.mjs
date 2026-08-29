// ══ LA MERMA ES UNA PREGUNTA, NO UNA CUENTA ════════════════════════════════
//
// Pablo, 29/8/2026: «si las mermas deben descontarse, pero deben figurar como X
// cantidad de bultos mermados multiplicados por $0 de venta, en caso de precio
// abierto. En el caso de precio cerrado, efectivamente la liquidación debe
// preguntar si "liquida las mermas" —o sea las incluye en la liquidación, pérdida
// para San Gerónimo— o si no paga esas mermas. Mostralo en las partidas que tengan
// merma y da las dos opciones para el cálculo».
//
// A precio ABIERTO no hay nada que preguntar: se cobra lo que se vendió, y lo que
// se tiró va en su propio renglón a cero para que los renglones sumen lo que entró.
// A precio CERRADO sí: el precio se pactó por lo recibido, y lo tirado lo pierde
// San Gerónimo o lo pierde el productor. Ninguna de las dos es la respuesta por
// defecto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acordadoDeOC, precioUnicoDeOC, mermaPorItemDeOC, objetivoCerrado,
  cierraContraLoAcordado } from '../src/servicios/sg_acordado.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const LIQ = fs.readFileSync(path.join(RAIZ, 'src/rutas/liquidaciones.js'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');

// Un camión con DOS productos a precios muy distintos, que es donde el prorrateo
// se nota: 60 cajones de 20 kg de durazno a $400/kg ($8.000 el cajón) y 40 cajones
// de 20 kg de ciruela a $100/kg ($2.000 el cajón). Total $560.000.
function camion(opts = {}) {
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
  db.prepare('INSERT INTO sg_oc VALUES (1,?,1,10.5)').run(opts.tipo_precio || 'firme');
  db.prepare('INSERT INTO sg_oc_items VALUES (1,1,400,?,20,NULL)').run(opts.modo || 'bulto');
  db.prepare('INSERT INTO sg_oc_items VALUES (2,1,100,?,20,NULL)').run(opts.modo || 'bulto');
  db.prepare('INSERT INTO sg_lotes VALUES (1,1,1200,60,1)').run();   // durazno
  db.prepare('INSERT INTO sg_lotes VALUES (2,2,800,40,1)').run();    // ciruela
  return db;
}
const tirar = (db, lote, bultos, kg) =>
  db.prepare('INSERT INTO sg_lote_decomisos (lote_id, kg, bultos, motivo) VALUES (?,?,?,?)')
    .run(lote, kg, bultos, 'podrido');

// ── 1 · LA CUENTA SIN MERMAS ───────────────────────────────────────────────

test('el camión entero vale lo mismo que antes: la merma no baja los kilos del lote', () => {
  // El decomiso deja kg_reales intacto a propósito. Si esto cambiara, lo acordado
  // se estaría descontando dos veces sin que nadie lo pida.
  const db = camion();
  tirar(db, 2, 5, 100);
  assert.equal(acordadoDeOC(db, 1).total, 560000);
});

test('descontar la merma se hace ítem por ítem, NO prorrateado', () => {
  // Cinco cajones de CIRUELA valen $2.000 cada uno, no el promedio del camión
  // ($5.600). El prorrateo da un número creíble y equivocado, y la diferencia
  // —$18.000 en este camión— se la come el productor.
  const db = camion();
  tirar(db, 2, 5, 100);
  const sin = acordadoDeOC(db, 1, { sinMermas: true }).total;
  assert.equal(sin, 550000, '560.000 − 5 cajones de ciruela a $2.000');
  const prorrateado = Math.round(560000 * (95 / 100));
  assert.notEqual(sin, prorrateado, 'está prorrateando: 532.000, $18.000 de menos');
});

test('y la merma del caro descuenta lo del caro', () => {
  const db = camion();
  tirar(db, 1, 5, 100);   // 5 cajones de durazno, $8.000 cada uno
  assert.equal(acordadoDeOC(db, 1, { sinMermas: true }).total, 520000);
});

test('la merma se cuenta por ítem y en total', () => {
  const db = camion();
  tirar(db, 1, 2, 40);
  tirar(db, 2, 5, 100);
  const m = mermaPorItemDeOC(db, 1);
  assert.equal(m.hay, true);
  assert.equal(m.bultos, 7);
  assert.equal(m.kg, 140);
  assert.equal(m.porItem.get(1).bultos, 2);
  assert.equal(m.porItem.get(2).bultos, 5);
});

test('sin merma, la cuenta sin mermas es la cuenta de siempre', () => {
  const db = camion();
  assert.equal(mermaPorItemDeOC(db, 1).hay, false);
  assert.equal(acordadoDeOC(db, 1, { sinMermas: true }).total, 560000);
});

test('una partida mermada ENTERA se debe cero, y sigue siendo una cuenta por cajón', () => {
  // Caer a la cuenta por kilo cambiaría de qué se está hablando: se pactó por
  // cajón igual, y el mensaje del cerrojo tiene que decir eso.
  const db = camion();
  tirar(db, 1, 60, 1200);
  tirar(db, 2, 40, 800);
  const a = acordadoDeOC(db, 1, { sinMermas: true });
  assert.equal(a.total, 0);
  assert.deepEqual(a.detalle.map((d) => d.base), ['bulto', 'bulto']);
});

// ── 2 · LA PREGUNTA ────────────────────────────────────────────────────────

test('con merma y sin respuesta, NO hay objetivo: se frena', () => {
  const db = camion();
  tirar(db, 2, 5, 100);
  const obj = objetivoCerrado(db, { ocId: 1, cantidad: 100 });
  assert.equal(obj.ok, false);
  assert.match(obj.motivo, /5 bultos de merma/);
  assert.match(obj.motivo, /no puede elegir por vos/);
});

test('sin merma no se pregunta nada', () => {
  // Pedir una respuesta donde no hay pregunta es trabar trabajo legítimo.
  const db = camion();
  const obj = objetivoCerrado(db, { ocId: 1, cantidad: 100 });
  assert.equal(obj.ok, true);
  assert.equal(obj.merma.hay, false);
});

test('SÍ se las pago: el objetivo es la partida entera', () => {
  // La pérdida la absorbe San Gerónimo: se le paga mercadería que se tiró.
  const db = camion();
  tirar(db, 2, 5, 100);
  const obj = objetivoCerrado(db, { ocId: 1, cantidad: 100, mermaLiquidada: true });
  assert.equal(obj.ok, true);
  assert.equal(obj.objetivo, 560000);
  assert.equal(obj.merma.liquidada, 1);
  assert.equal(cierraContraLoAcordado(560000, obj), true);
});

test('NO se las pago: el objetivo baja lo que se tiró', () => {
  const db = camion();
  tirar(db, 2, 5, 100);
  const obj = objetivoCerrado(db, { ocId: 1, cantidad: 100, mermaLiquidada: false });
  assert.equal(obj.ok, true);
  assert.equal(obj.objetivo, 550000);
  assert.equal(obj.merma.liquidada, 0);
  assert.equal(obj.merma.cantidad, 5);
});

test('y la respuesta MANDA: el importe de la otra opción rebota', () => {
  // Es todo el punto de guardar la respuesta. Si las dos cifras se admitieran
  // siempre, la pregunta sería decorativa y el registro no diría nada.
  const db = camion();
  tirar(db, 2, 5, 100);
  const paga = objetivoCerrado(db, { ocId: 1, cantidad: 100, mermaLiquidada: true });
  const noPaga = objetivoCerrado(db, { ocId: 1, cantidad: 100, mermaLiquidada: false });
  assert.equal(cierraContraLoAcordado(550000, paga), false,
    'dijo que las pagaba y le paga de menos');
  assert.equal(cierraContraLoAcordado(560000, noPaga), false,
    'dijo que no las pagaba y le paga la partida entera');
});

test('la merma en KILOS cuando la mercadería entró pesada', () => {
  // Sin cajones contados, el campo «a liquidar» lleva kilos y la merma también.
  const db = camion({ modo: 'kilo' });
  db.prepare('UPDATE sg_lotes SET bultos = NULL').run();
  tirar(db, 2, null, 100);
  const obj = objetivoCerrado(db, { ocId: 1, cantidad: 2000, mermaLiquidada: false });
  assert.equal(obj.ok, true);
  assert.equal(obj.merma.unidad, 'kg');
  assert.equal(obj.merma.cantidad, 100);
  assert.equal(obj.objetivo, 550000, '480.000 de durazno + 70.000 de ciruela');
});

test('el tope sigue midiéndose contra lo que ENTRÓ, no contra lo sano', () => {
  // Descontar la merma no puede aflojar el control de que no se liquida más de lo
  // recibido: son dos cosas distintas y la segunda frena un cero de más.
  const db = camion();
  tirar(db, 2, 5, 100);
  const obj = objetivoCerrado(db, { ocId: 1, cantidad: 1000, mermaLiquidada: false });
  assert.equal(obj.ok, false);
  assert.match(obj.motivo, /No se le puede pagar al productor por mercadería que no recibimos/);
});

// ── 3 · EL SERVIDOR LA PASA Y LA GUARDA ────────────────────────────────────

test('la respuesta queda escrita en la liquidación', () => {
  // Dos liquidaciones de partidas iguales por plata distinta no se explican solas
  // seis meses después.
  assert.match(LIQ, /ALTER TABLE liquidaciones ADD COLUMN merma_liquidada INTEGER/);
  // La respuesta viaja POR PARTIDA: en un grupo cada una tiene la suya.
  assert.match(LIQ, /mermaLiquidada: p\.merma_liquidada == null \? null : !!p\.merma_liquidada/);
  assert.match(LIQ, /oc_id, bultos_liquidados, merma_liquidada/);
  const i = LIQ.indexOf('INSERT INTO liquidaciones (');
  const b = LIQ.slice(i, i + 2600);
  assert.match(b, /grilla_json,\r?\n\s*merma_liquidada/);
  // En la columna sólo cuando es UNA partida: la de la primera diría que el grupo
  // entero se resolvió así. Las de verdad están en liquidacion_partidas.
  assert.match(b, /partidas\.length === 1 \? partidas\[0\]\.merma_liquidada : null/);
  assert.match(LIQ, /INSERT INTO liquidacion_partidas \(liquidacion_id, oc_id, bultos, merma_liquidada\)/);
});

test('y el mensaje del cerrojo dice si el número lleva la merma o no', () => {
  // «Cobra $550.000 por la partida entera» sobre una partida de $560.000 manda a
  // revisar la orden de compra, que está bien.
  const i = LIQ.indexOf('Esta partida se compró a PRECIO CERRADO');
  const b = LIQ.slice(i, i + 900);
  assert.match(b, /descontando .* de merma/);
  assert.match(b, /incluyendo .* de merma/);
});

// ── 4 · EL RENGLÓN A $0 ────────────────────────────────────────────────────

test('lo que se tiró viaja como un renglón más, a precio cero', () => {
  const i = SG.indexOf('const mermaArticulos =');
  assert.ok(i > 0, 'no existe el armado de los renglones de merma');
  const b = SG.slice(i, i + 600);
  assert.match(b, /precio: 0, importe: 0, es_merma: 1/);
  assert.match(b, /\.filter\(\(a\) => a\.cantidad > 0\)/, 'un producto sin merma no debe dar renglón');
  assert.match(SG, /articulos: articulos\.concat\(mermaArticulos\),/);
});

test('agrupado por producto, no un renglón por decomiso', () => {
  // La liquidación es un comprobante, no un extracto: al productor se le dice
  // «se tiraron 5 cajones de ciruela», no los tres eventos de decomiso que hubo.
  const i = SG.indexOf('const mermaPorProd = new Map();');
  assert.ok(i > 0);
  const b = SG.slice(i, i + 500);
  assert.match(b, /const k = m\.producto \|\| 'Sin producto';/);
});

test('y lo acordado viaja también sin la merma, para poder ofrecer las dos opciones', () => {
  assert.match(SG, /total_sin_mermas: \(mermaBultos > 0 \|\| mermaKg > 0\)/);
  assert.match(SG, /acordadoDeOC\(db, ocId, \{ sinMermas: true \}\)\.total/);
});

// ── 5 · LA PANTALLA PREGUNTA ───────────────────────────────────────────────

// Las funciones reales, sacadas del panel y corridas de verdad.
function traer(nombre, extra = '') {
  const i = PANEL.indexOf(nombre);
  assert.ok(i > 0, 'no existe ' + nombre);
  const src = PANEL.slice(i, PANEL.indexOf('\n}', i) + 2);
  const clave = nombre.replace('function ', '').replace(/\(.*/, '');
  // eslint-disable-next-line no-new-func
  return new Function('LIQ', 'document', extra + src + '; return ' + clave + ';');
}

test('tres estados, no dos: sin contestar NO es «no»', () => {
  // Si null se leyera como «no», abrir la pantalla y guardar sin mirar equivaldría a
  // decidir que la pérdida la absorbe el productor, en silencio y por omisión.
  const f = traer('function liqMermaPagaDe(ocId){');
  const doc = (v) => ({ querySelector: (q) => {
    // Y la pregunta es DE UNA PARTIDA: el nombre del grupo de radios lleva su id.
    assert.match(q, /liq-merma-paga-7/);
    return v == null ? null : { value: v };
  } });
  assert.equal(f(null, doc(null))(7), null, 'sin contestar tiene que ser null');
  assert.equal(f(null, doc('1'))(7), true);
  assert.equal(f(null, doc('0'))(7), false);
});

test('la cantidad mermada se cuenta en la unidad en que se liquida', () => {
  const f = traer('function liqMermaCantDe(p){');
  assert.equal(f(null, null)({ unidad: 'bulto', bultos_merma: 5, kg_merma: 100 }), 5);
  assert.equal(f(null, null)({ unidad: 'kilo',  bultos_merma: 5, kg_merma: 100 }), 100);
  assert.equal(f(null, null)(null), 0, 'sin partida no hay merma que contar');
});

test('la pregunta se muestra con las dos opciones y su importe', () => {
  const i = PANEL.indexOf('id="liq-merma-box"');
  assert.ok(i > 0, 'no está el cuadro de la merma');
  const b = PANEL.slice(i - 900, i + 1400);
  assert.match(b, /¿Se le pagan al productor las mermas\?/);
  const f = PANEL.indexOf('function liqMermaPintar(){');
  const p = PANEL.slice(f, f + 2600);
  assert.match(p, /La pérdida la absorbe San Gerónimo/);
  assert.match(p, /La pérdida la absorbe el productor/);
  assert.match(p, /sgMoney\(p\.acordado_total\)/);
  assert.match(p, /sgMoney\(p\.acordado_sin_mermas\)/);
});

test('una pregunta por PARTIDA, no una para el grupo', () => {
  // Un grupo no tiene «una» merma: tiene la de cada partida, y se pueden querer
  // resolver distinto. El nombre del grupo de radios lleva el id de la partida.
  const f = PANEL.indexOf('function liqMermaPintar(){');
  const p = PANEL.slice(f, f + 2600);
  assert.match(p, /var n = 'liq-merma-paga-' \+ p\.oc_id;/);
  assert.match(p, /liqPartidasVenta\(\)\.filter\(function\(p\)\{ return liqMermaCantDe\(p\) > 0; \}\)/);
  assert.match(p, /Partida '\r?\n?\s*\+ escH\(p\.partida/, 'no dice de qué partida es cada pregunta');
});

test('NINGUNA opción viene marcada', () => {
  // Marcar una sería decidir de qué bolsillo sale la pérdida sin preguntarle a nadie.
  const f = PANEL.indexOf('function liqMermaPintar(){');
  const b = PANEL.slice(f, f + 2600);
  const radios = b.match(/<input type="radio" name="' \+ n \+ '" value="[01]"[^>]*/g) || [];
  assert.equal(radios.length, 2, 'tienen que ser las dos opciones');
  for (const r of radios) assert.ok(!/checked/.test(r), 'vino una marcada por defecto');
});

test('ni se hereda de la liquidación anterior', () => {
  // El cuadro se vacía al abrir: los radios se rearman con la partida nueva.
  const i = PANEL.indexOf("if ((_e = eid('liq-merma-lista'))) _e.innerHTML = '';");
  assert.ok(i > 0, 'no se limpia el cuadro de la merma al abrir una nueva');
  // Y NO se rearma en cada tecla: reconstruirlo mientras se tipea el precio
  // borraría el tilde recién puesto.
  const r = PANEL.indexOf('function liqCerradoResolver(){');
  assert.ok(!/liqMermaPintar\(\)/.test(PANEL.slice(r, r + 2200)),
    'el despeje reconstruye el cuadro y se lleva puesta la respuesta');
});

test('sin contestar no se calcula el objetivo, y se dice por qué', () => {
  const i = PANEL.indexOf('var pend = liqMermaPendientes();');
  assert.ok(i > 0, 'liqCerradoResolver no mira la merma');
  const b = PANEL.slice(i, i + 2200);
  assert.match(b, /if \(pend\.length\) \{/);
  assert.match(b, /LIQ\.cerrado\.objetivo = 0;/);
  assert.match(b, /Falta decidir la merma/);
  // Y la otra rama: no pagarlas usa el total sin mermas del servidor, POR PARTIDA.
  assert.match(b, /paga === false && p\.acordado_sin_mermas != null/);
  assert.match(b, /if \(hayAc && _entera\) \{/);
});

test('y no se emite sin contestar', () => {
  const g = PANEL.indexOf('async function liqGuardar() {');
  const i = PANEL.indexOf("liqModo() === 'cerrado' && liqMermaPendientes().length", g);
  assert.ok(i > g, 'liqGuardar no frena cuando falta decidir la merma');
  // ANTES del envío: el servidor lo rebota igual, pero el que arma la liquidación
  // tiene que enterarse acá, con el número a la vista.
  assert.ok(i < PANEL.indexOf("fetch('/api/liquidaciones'", g));
  assert.match(PANEL.slice(i, i + 900), /Antes de emitir hay que decir si esa merma se le paga/);
});

test('la respuesta viaja al servidor, una por partida', () => {
  const i = PANEL.indexOf('partidas:             liqPartidasVenta().map(function(p){');
  assert.ok(i > 0, 'no viaja la lista de partidas');
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /merma_liquidada: \(liqModo\(\) === 'cerrado'/);
  assert.match(b, /liqMermaCantDe\(p\) > 0 && x !== null\) \? \(x \? 1 : 0\) : null/);
  assert.match(b, /bultos_liquidados: \(p\.bultos_ingresados != null\)/);
});

// ── 6 · EL RENGLÓN, EN LA PANTALLA ─────────────────────────────────────────

test('el renglón se acuerda de que es merma después de repintarse', () => {
  // _liqLeerArt reconstruye el objeto recorriendo los input[data-k]: sin el campo
  // escondido, el primer repintado convierte la merma en un producto más y el
  // despeje del precio cerrado le mete encima la cantidad y el precio del producto.
  assert.match(PANEL, /'<input data-k="es_merma" type="hidden" value="'\+\(a\.es_merma \? '1' : ''\)\+'">'/);
  assert.match(PANEL, /es_merma: a\.es_merma \? 1 : 0,/);
});

test('el producto y la merma suman lo que entró, no más', () => {
  const i = PANEL.indexOf('function liqArtSync(){');
  const b = PANEL.slice(i, i + 3600);
  assert.match(b, /var cantM = mers\.reduce\(/);
  assert.match(b, /reales\[0\]\.cantidad = m2a\(ing - cantM\)/);
});

test('y la merma cobra $0, salvo que se haya decidido pagarla', () => {
  const i = PANEL.indexOf('function liqArtSync(){');
  const b = PANEL.slice(i, i + 3600);
  assert.match(b, /var paga = \(liqMermaPagaDe\(p\.oc_id\) === true\);/);
  assert.match(b, /a\.precio\s+= \(paga && pu > 0\) \? pu : 0;/);
  // AL PRECIO DE SU PARTIDA: en un grupo, la merma de un camión no se paga al
  // precio del otro.
  assert.match(b, /Number\(p\.precio_por_bulto\) \|\| 0/);
});

test('el renglón se acuerda de qué partida es', () => {
  // En una liquidación agrupada hay renglones de varias partidas con precios
  // distintos: sin esto, la merma de un camión se pagaría al precio del otro.
  assert.match(PANEL, /'<input data-k="oc_id" type="hidden" value="'\+_liqEsc\(a\.oc_id == null \? '' : a\.oc_id\)\+'">'/);
});

test('cambiar la respuesta mueve el objetivo Y el renglón', () => {
  // Si sólo se moviera uno, el papel diría una cosa y el total otra.
  const i = PANEL.indexOf('function liqMermaCambio(){');
  const b = PANEL.slice(i, i + 200);
  assert.match(b, /liqCerradoResolver\(\); liqArtSync\(\);/);
});
