// ══ EL PRECIO CORREGIDO EN LA PARTIDA TIENE QUE LLEGAR A LA LIQUIDACIÓN ═════
//
// Pablo, 30/8/2026: «entro a la orden de compra, arreglo el precio de costo, pero
// cuando voy a liquidar a precio cerrado no me trae el costo nuevo, me sigue tomando
// el viejo… entonces el cambio de costo que hice en la orden de compra no tiene
// ningún sentido».
//
// Tenía razón. Lo que se le paga al productor sale del RENGLÓN de la orden
// (sg_oc_items.precio_estimado_por_kg, que lee acordadoDeOC y contra el que controla
// la liquidación a precio cerrado). «Corregir la partida» escribía sólo
// sg_lotes.precio_unitario_kg, que es el COSTO: dos números para la misma mercadería,
// y el que mandaba al liquidar era justo el que no se había tocado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// ── 1 · LA VUELTA DEL IVA, CORRIDA ─────────────────────────────────────────

function traer(nombre, args, inyect) {
  const i = SG.indexOf(nombre);
  assert.ok(i > 0, 'no existe ' + nombre);
  const src = SG.slice(i, SG.indexOf('\n}', i) + 2);
  const clave = nombre.replace('function ', '').replace(/\(.*/, '');
  // eslint-disable-next-line no-new-func
  return new Function(...(args || []), src + '; return ' + clave + ';')(...(inyect || []));
}
const bruto = traer('function precioBrutoDeOC(db, ocId, ocItemId, neto) {');
const neto = traer('function precioNetoDeOC(db, ocId, ocItemId, precio) {');

function baseIva(incluye, alic) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, precio_incluye_iva INTEGER);
    CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY, iva_alicuota REAL)`);
  db.prepare('INSERT INTO sg_oc VALUES (1, ?)').run(incluye);
  db.prepare('INSERT INTO sg_oc_items VALUES (1, ?)').run(alic);
  return db;
}

test('el precio vuelve a la orden CON el IVA que se le había sacado', () => {
  // La partida guarda el neto y el renglón el precio como se pactó. Sin devolverle el
  // impuesto, cada corrección le baja un 10,5% a lo que se le paga al productor.
  const db = baseIva(1, 10.5);
  assert.equal(bruto(db, 1, 1, 1000), 1105);
  // Y es la vuelta EXACTA: ida y vuelta da el mismo número.
  assert.equal(Math.round(neto(db, 1, 1, bruto(db, 1, 1, 1000)) * 1e6) / 1e6, 1000);
});

test('y si la orden se pactó SIN IVA adentro, no se le suma nada', () => {
  assert.equal(bruto(baseIva(0, 10.5), 1, 1, 1000), 1000);
  assert.equal(bruto(baseIva(1, null), 1, 1, 1000), 1000, 'sin alícuota tampoco');
  assert.equal(bruto(baseIva(1, 10.5), 1, 1, null), null);
});

// ── 2 · CUÁNDO SUBE ────────────────────────────────────────────────────────

test('sube sólo si el precio CAMBIÓ y la partida es la única de su renglón', () => {
  // Compartiéndolo, subirlo se lo cambiaría también a las hermanas — y para eso está
  // el botón que le abre el suyo.
  const i = SG.indexOf("router.put('/lotes/:id/corregir'");
  const j = SG.indexOf('const subeALaOrden', i);
  assert.ok(j > i, 'la corrección no sube el precio a la orden');
  const b = SG.slice(j - 900, j + 500);
  assert.match(b, /const cambiaPrecio = String\(prev\.precio_unitario_kg/);
  assert.match(b, /const hermanasEnElRenglon = prev\.oc_item_id/);
  assert.match(b, /WHERE oc_item_id=\? AND activo=1 AND id<>\?/);
  assert.match(b, /cambiaPrecio && prev\.oc_item_id && chk\.lote\.oc_id\r?\n?\s*&& hermanasEnElRenglon === 0/);
});

test('y va por la puerta de siempre, con el precio en BRUTO', () => {
  // aplicarPrecioItem escribe el renglón y baja la cascada a los lotes: una sola
  // puerta, o el día que cambie la cascada esta queda vieja.
  const i = SG.indexOf('if (subeALaOrden) {');
  assert.ok(i > 0);
  const b = SG.slice(i, i + 1100);
  assert.match(b, /aplicarPrecioItem\(db, \{ ocId: chk\.lote\.oc_id, ocItemId: prev\.oc_item_id,/);
  assert.match(b, /precio: precioBrutoDeOC\(db, chk\.lote\.oc_id, prev\.oc_item_id, nuevo\.precio_unitario_kg\)/);
  assert.match(b, /anotarEdicion\(db, \{ tabla: 'sg_oc_items', registroId: prev\.oc_item_id,/);
  assert.match(b, /recalcTotalesOC\(db, chk\.lote\.oc_id\)/);
});

test('y va DESPUÉS de escribir la partida, antes del cronograma', () => {
  // El cronograma se arma con los costos de los lotes: rehacerlo antes de que la
  // cascada los reescriba lo dejaría con el número viejo.
  const i = SG.indexOf("router.put('/lotes/:id/corregir'");
  const lote = SG.indexOf('recalcCostoLote(db, prev.id)', i);
  const orden = SG.indexOf('if (subeALaOrden) {', i);
  const venc = SG.indexOf('generarVencimientos(db, chk.lote.oc_id)', i);
  assert.ok(lote > 0 && orden > lote, 'sube a la orden antes de escribir la partida');
  assert.ok(venc > orden, 'rehace el cronograma antes de subir el precio');
});

// ── 3 · Y SI LO COMPARTE, SE DICE ──────────────────────────────────────────

test('compartiendo el renglón, avisa que la liquidación va a pedir el precio viejo', () => {
  // Es exactamente lo que le pasó: cambió el precio, vio bajar el costo en la ficha, y
  // al liquidar el sistema le siguió pidiendo el número de antes.
  const i = SG.indexOf("router.put('/lotes/:id/corregir'");
  const j = SG.indexOf('comparte_renglon:', i);
  assert.ok(j > i, 'la respuesta no dice si comparte renglón');
  const b = SG.slice(j - 400, j + 900);
  assert.match(b, /precio_a_la_orden: subeALaOrden \? 1 : 0/);
  assert.match(b, /el precio de la PARTIDA cambió, pero el de la ORDEN no/);
  assert.match(b, /la liquidación va a seguir pidiendo el precio /);
  assert.match(b, /Dale su propio renglón/);
});

test('y ese aviso se ve, no se va solo', () => {
  const i = PANEL.indexOf("toast('Corregido — queda registrado quién y qué cambió', 'ok');");
  assert.ok(i > 0);
  assert.match(PANEL.slice(i, i + 600), /if \(r\.aviso\) alert\(r\.aviso\);/);
});

// ── 4 · LAS VENTAS NO SE TIPEAN ────────────────────────────────────────────

test('las ventas de la liquidación salen de los comprobantes y no se editan', () => {
  // Pablo, 30/8/2026: «me deja modificar las ventas a mano… es un error tremendo, de
  // ahí se despliega una mala liquidación de impuestos». Su IVA es débito fiscal.
  assert.match(PANEL, /function liqVentasSeCalculan\(\)\{/);
  const i = PANEL.indexOf('function liqCeldaCalculada(k, amb){');
  const b = PANEL.slice(i, i + 500);
  assert.match(b, /if \(k === 'ventas'\) return liqVentasSeCalculan\(\);/);
});

test('y el único caso en que quedan abiertas es el que el servidor declara', () => {
  // Una factura vieja compartida entre dos partidas: su IVA y su gestión no se pueden
  // separar sin repartir. El otro motivo —despachado sin facturar— dejó de existir: eso
  // ahora FRENA la liquidación.
  const i = PANEL.indexOf('function liqVentasSeCalculan(){');
  const b = PANEL.slice(i, i + 800);
  assert.match(b, /if \(!\(LIQ && LIQ\.partida && LIQ\.partida\.oc_id\)\) return false;/);
  assert.match(b, /return !\(Number\(v\.lineas_sin_atribuir\) > 0\);/);
});

test('y el rótulo dice de dónde salen, o por qué están abiertas', () => {
  // Un campo editable en el renglón que arma el libro de IVA tiene que estar
  // justificado a la vista.
  const i = PANEL.indexOf('LIQ.origen.ventas = liqVentasSeCalculan()');
  assert.ok(i > 0, 'el rótulo de ventas sigue diciendo siempre lo mismo');
  const b = PANEL.slice(i, i + 500);
  assert.match(b, /de los comprobantes de la partida, arriba/);
  assert.match(b, /factura compartida que no /);
});

// ── 5 · EL PRECIO NO SE TIPEA, HAYA UNO O HAYA DOS ─────────────────────────

test('el precio de una partida a precio cerrado sale de la orden, siempre', () => {
  // Pablo, 30/8/2026: «el precio en la liquidación a precio cerrado debe venir de la
  // orden de compra… ahora lo puede editar y sacar mal los números de margen, después
  // tengo problemas de quién se equivocó. Esto ya lo teníamos bien».
  //
  // Y lo estaba: se trababa. Lo destrabó partir el renglón por calidad — con dos
  // precios ya no hay UN precio por cajón, precio_por_bulto viene null, y la
  // condición lo leía como «la orden no dice nada, que lo tipee». La orden SÍ dice:
  // dice DOS.
  const i = PANEL.indexOf('function liqPrecioDeLaOrden(){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 400);
  assert.match(b, /\(Number\(ac\.precio_por_bulto\) \|\| Number\(ac\.total\)\)/);
});

test('y con dos precios el campo lo dice, en vez de quedar vacío', () => {
  // Vacío no puede querer decir «tipealo»: el total sale de la orden igual.
  const i = PANEL.indexOf('var variosPrecios =');
  assert.ok(i > 0, 'la pantalla no reconoce el caso de dos precios');
  const b = PANEL.slice(i, i + 500);
  assert.match(b, /Number\(ac\.total\) && !Number\(ac\.precio_por_bulto\)/);
  assert.match(b, /pc\.placeholder = 'dos precios'/);
});

test('y abajo se dice CUÁL es cada uno', () => {
  // Un total con el campo del precio vacío no se puede auditar: hay que poder ver
  // que la segunda se renegoció y a cuánto.
  assert.match(SG, /renglones: db\.prepare\(`SELECT i\.id, i\.precio_estimado_por_kg,/);
  assert.match(SG, /precio_por_bulto: \(x\.precio_estimado_por_kg != null && Number\(x\.kpb\) > 0\)/);
  const i = PANEL.indexOf("var acEl = eid('liq-cerr-acordado');");
  const b = PANEL.slice(i, i + 1600);
  assert.match(b, /\(r\.renglones \|\| \[\]\)\.length > 1/);
  assert.match(b, /escH\(x\.calidad \|\| 'sin calificar'\)/);
  assert.match(b, /sgMoney\(x\.precio_por_bulto \|\| x\.precio_por_kg\)/);
});

test('y en un grupo, los renglones no se repiten', () => {
  // Dos partidas del mismo camión comparten orden: sus renglones vendrían dos veces.
  const i = SG.indexOf('renglones: (function(){');
  assert.ok(i > 0);
  const b = SG.slice(i, i + 500);
  assert.match(b, /const vistos = new Set\(\)/);
  assert.match(b, /if \(vistos\.has\(x\.oc_item_id\)\) continue;/);
});

// ── 6 · LAS CORRECCIONES HABLAN EN LA UNIDAD QUE SE PACTÓ ──────────────────

test('el registro informa el precio por BULTO si así se pactó', () => {
  // Pablo, 30/8/2026: «si modifico el precio del bulto no tenés por qué seguirme
  // informando el precio por kilo. Si en la OC arreglamos por bulto y corregimos por
  // bulto, debemos informar por bulto en las correcciones también».
  //
  // Se guarda por kilo —es la unidad del costo y de la deuda— pero se pacta por
  // cajón: mostrar «2777.777777777778» donde se habló de $50.000 obliga a hacer una
  // cuenta para leer el propio registro.
  assert.match(SG, /COALESCE\(il\.modo_carga, ii\.modo_carga\) AS modo_carga/);
  assert.match(SG, /COALESCE\(l\.kg_por_bulto, psl\.factor_conversion,/);
  const i = PANEL.indexOf('function sgEdValor(campo, v, e){');
  assert.ok(i > 0, 'el formateador no recibe la edición');
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /sgEdPorBulto\(e\)\r?\n?\s*\? sgMoney2\(Number\(v\) \* Number\(e\.kg_por_bulto\)\) \+ ' \/bulto'/);
  // Y con el de la otra unidad al lado: el costo y el margen corren por kilo.
  assert.match(b, /\+ '  ·  ' \+ sgMoney2\(Number\(v\)\) \+ ' \/kg'/);
});

test('por bulto SÓLO si la orden se pactó así y hay factor', () => {
  // Sin una de las dos, el número por cajón sería inventado.
  const i = PANEL.indexOf('function sgEdPorBulto(e){');
  assert.ok(i > 0);
  assert.match(PANEL.slice(i, i + 220),
    /e\.modo_carga === 'bulto' && Number\(e\.kg_por_bulto\) > 0/);
});

test('y el rótulo dice de qué precio se trata, y en qué unidad', () => {
  // «precio_estimado_por_kg» era el nombre de la columna: nadie sabe qué es.
  const i = PANEL.indexOf('function sgEdCampo(e){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 500);
  // La condición arranca en el mapa de precios: colgarla de otra cosa la apaga y el
  // rótulo vuelve a ser el nombre crudo de la columna.
  assert.match(b, /if \(SG_ED_PRECIO_KG\[e\.campo\]\) \{/);
  assert.match(b, /Precio de la orden/);
  assert.match(b, /Precio de la partida/);
  assert.match(b, /sgEdPorBulto\(e\) \? ' por bulto' : ' por kg'/);
  // Y los otros campos crudos también tienen nombre.
  assert.match(PANEL, /oc_item_id: 'Renglón de la orden'/);
});
