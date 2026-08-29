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
  assert.match(LIQ, /mermaLiquidada: \(d\.merma_liquidada == null \|\| d\.merma_liquidada === ''\)/);
  assert.match(LIQ, /oc_id, bultos_liquidados, merma_liquidada/);
  const i = LIQ.indexOf('INSERT INTO liquidaciones (');
  const b = LIQ.slice(i, i + 2600);
  assert.match(b, /grilla_json,\r?\n\s*merma_liquidada/);
  assert.match(b, /\? null : \(Number\(d\.merma_liquidada\) \? 1 : 0\)/);
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
  const f = traer('function liqMermaPaga(){');
  const doc = (v) => ({ querySelector: () => (v == null ? null : { value: v }) });
  assert.equal(f(null, doc(null))(), null, 'sin contestar tiene que ser null');
  assert.equal(f(null, doc('1'))(), true);
  assert.equal(f(null, doc('0'))(), false);
});

test('la cantidad mermada se cuenta en la unidad en que se liquida', () => {
  const f = traer('function liqMermaCant(){');
  const enBultos = { venta: { unidad: 'bulto', bultos_merma: 5, kg_merma: 100 } };
  const enKilos  = { venta: { unidad: 'kilo',  bultos_merma: 5, kg_merma: 100 } };
  assert.equal(f(enBultos, null)(), 5);
  assert.equal(f(enKilos, null)(), 100);
  assert.equal(f({}, null)(), 0, 'sin partida no hay merma que contar');
});

test('la pregunta se muestra con las dos opciones y su importe', () => {
  const i = PANEL.indexOf('id="liq-merma-box"');
  assert.ok(i > 0, 'no está el cuadro de la merma');
  const b = PANEL.slice(i - 900, i + 1800);
  assert.match(b, /¿Se le pagan al productor\?/);
  assert.match(b, /La pérdida la absorbe San Gerónimo/);
  assert.match(b, /La pérdida la absorbe el productor/);
  const f = PANEL.indexOf('function liqMermaPintar(){');
  const p = PANEL.slice(f, f + 1200);
  assert.match(p, /sgMoney\(ac\.total\)/);
  assert.match(p, /sgMoney\(ac\.total_sin_mermas\)/);
});

test('NINGUNA opción viene marcada', () => {
  // Marcar una sería decidir de qué bolsillo sale la pérdida sin preguntarle a nadie.
  const i = PANEL.indexOf('id="liq-merma-box"');
  const b = PANEL.slice(i, i + 1800);
  const radios = b.match(/name="liq-merma-paga"[^>]*/g) || [];
  assert.equal(radios.length, 2, 'tienen que ser las dos opciones');
  for (const r of radios) assert.ok(!/checked/.test(r), 'vino una marcada por defecto');
});

test('ni se hereda de la liquidación anterior', () => {
  const i = PANEL.indexOf("querySelectorAll('input[name=\"liq-merma-paga\"]')");
  assert.ok(i > 0, 'no se limpian los radios al abrir una nueva');
  assert.match(PANEL.slice(i - 400, i + 300), /x\.checked = false/);
});

test('sin contestar no se calcula el objetivo, y se dice por qué', () => {
  const i = PANEL.indexOf('var mCant = liqMermaCant(), mPaga = liqMermaPaga();');
  assert.ok(i > 0, 'liqCerradoResolver no mira la merma');
  const b = PANEL.slice(i, i + 1400);
  assert.match(b, /if \(mCant > 0 && mPaga === null\) \{/);
  assert.match(b, /LIQ\.cerrado\.objetivo = 0;/);
  assert.match(b, /Falta decidir la merma/);
  // Y la otra rama: no pagarlas usa el total sin mermas del servidor.
  assert.match(b, /if \(mCant > 0 && mPaga === false\) \{/);
  assert.match(b, /m2\(ac\.total_sin_mermas\)/);
});

test('y no se emite sin contestar', () => {
  const g = PANEL.indexOf('async function liqGuardar() {');
  const i = PANEL.indexOf("liqMermaCant() > 0 && liqMermaPaga() === null", g);
  assert.ok(i > g, 'liqGuardar no frena cuando falta decidir la merma');
  // ANTES del envío: el servidor lo rebota igual, pero el que arma la liquidación
  // tiene que enterarse acá, con el número a la vista.
  assert.ok(i < PANEL.indexOf("fetch('/api/liquidaciones'", g));
  assert.match(PANEL.slice(i, i + 700), /Antes de emitir hay que decir si esa merma se le paga/);
});

test('la respuesta viaja al servidor', () => {
  assert.match(PANEL, /merma_liquidada:\s+\(function\(\)\{ var p = liqMermaPaga\(\);/);
  const i = PANEL.indexOf('merma_liquidada:      (function(){');
  const b = PANEL.slice(i, i + 400);
  assert.match(b, /liqModo\(\) === 'cerrado' && liqMermaCant\(\) > 0 && p !== null/);
});

// ── 6 · EL RENGLÓN, EN LA PANTALLA ─────────────────────────────────────────

test('el renglón se acuerda de que es merma después de repintarse', () => {
  // _liqLeerArt reconstruye el objeto recorriendo los input[data-k]: sin el campo
  // escondido, el primer repintado convierte la merma en un producto más y el
  // despeje del precio cerrado le mete encima la cantidad y el precio del producto.
  assert.match(PANEL, /'<input data-k="es_merma" type="hidden" value="'\+\(a\.es_merma \? '1' : ''\)\+'">'/);
  assert.match(PANEL, /es_merma: a\.es_merma \? 1 : 0 \}/);
});

test('el producto y la merma suman lo que entró, no más', () => {
  const i = PANEL.indexOf('function liqArtSync(){');
  const b = PANEL.slice(i, i + 2600);
  assert.match(b, /var cantM = mers\.reduce\(/);
  assert.match(b, /reales\[0\]\.cantidad = Math\.round\(\(cant - cantM\) \* 100\) \/ 100/);
});

test('y la merma cobra $0, salvo que se haya decidido pagarla', () => {
  const i = PANEL.indexOf('function liqArtSync(){');
  const b = PANEL.slice(i, i + 2600);
  assert.match(b, /var pagaM = \(liqMermaPaga\(\) === true\);/);
  assert.match(b, /a\.precio\s+= \(pagaM && pre > 0\) \? pre : 0;/);
});

test('cambiar la respuesta mueve el objetivo Y el renglón', () => {
  // Si sólo se moviera uno, el papel diría una cosa y el total otra.
  const i = PANEL.indexOf('function liqMermaCambio(){');
  const b = PANEL.slice(i, i + 200);
  assert.match(b, /liqCerradoResolver\(\); liqArtSync\(\);/);
});
