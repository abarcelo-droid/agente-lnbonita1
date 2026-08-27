// ══ CAMBIAR LO PACTADO ANTES DE QUE ENTRE NADA ═════════════════════════════
//
// Pablo, 27/8/2026: «desde la orden de compra los compradores pueden cambiar la
// cantidad de bultos de la orden ANTES de que se recepcione».
//
// Hasta acá no había forma. Corregir la partida rebota con «los bultos recibidos
// no se corrigen: son los que se contaron al bajar el camión — lo que se arregla
// es la ORDEN DE COMPRA», y esa puerta no existía: el comprador que cerraba 90
// cajones y al otro día acordaba 100 tenía que anular la orden y hacerla de nuevo.
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

const endpoint = () => {
  const i = SG.indexOf("router.put('/oc/:id/cantidades'");
  assert.ok(i > 0, 'no existe el endpoint');
  return SG.slice(i, i + 5200);
};

// ── EL CERROJO ─────────────────────────────────────────────────────────────
test('sólo se cambia si NO entró nada', () => {
  // Después de la primera recepción la cantidad de la orden es historia: lo que
  // vale es lo que se contó al bajar el camión.
  const b = endpoint();
  assert.match(b, /SELECT COUNT\(\*\) c FROM sg_recepciones WHERE oc_id=\? AND activo=1/);
  assert.match(b, /if \(rec > 0\)/);
  assert.match(b, /los bultos de la orden no se cambian después/);
  // Y se dice a dónde ir, que es la otra pantalla.
  assert.match(b, /Lo que se corrige ahí son los KILOS de la partida/);
});

test('el cerrojo mira las RECEPCIONES, no el estado', () => {
  // Una orden puede quedar 'abierta' con una recepción anulada: mirar el estado
  // dejaría cambiar la cantidad de una orden que ya recibió mercadería.
  const b = endpoint();
  const rec = b.indexOf('FROM sg_recepciones');
  assert.ok(rec > 0);
  assert.ok(!/oc\.estado === 'abierta'/.test(b), 'se coló el estado como cerrojo');
});

test('y respeta el precio firme, como las otras puertas', () => {
  // Las cantidades mueven el total que se le va a pagar al productor igual que el
  // precio: si la partida ya está documentada, el papel diría una cosa y la orden
  // otra.
  assert.match(endpoint(), /frenoPrecioFirme\(db, oc\.id, 'cambiar las cantidades'\)/);
});

test('el motivo es obligatorio', () => {
  const b = endpoint();
  assert.match(b, /if \(motivo\.length < 3\)/);
  assert.match(b, /es lo que después explica la diferencia contra lo pactado/);
  assert.match(b, /anotarEdicion\(db, \{ tabla: 'sg_oc_items'/);
});

test('un renglón de otra orden no entra', () => {
  assert.match(endpoint(), /no es de esta orden/);
});

// ── LA UNIDAD EN QUE SE PACTÓ ──────────────────────────────────────────────
test('por bulto se corrigen BULTOS y los kilos se derivan', () => {
  const b = endpoint();
  assert.match(b, /const porBulto = it\.modo_carga === 'bulto'/);
  assert.match(b, /UPDATE sg_oc_items SET cantidad_estimada_presentaciones=\?, kg_estimados=\?/);
});

test('por kilo, al revés', () => {
  assert.match(endpoint(), /UPDATE sg_oc_items SET kg_estimados=\?, cantidad_estimada_presentaciones=\?/);
});

test('la cuenta de derivación, corriéndola', () => {
  // Guardar un número sin recalcular su par dejaría la orden diciendo «100 bultos
  // de 900 kilos». Es la aritmética que hace el endpoint.
  const derivar = (porBulto, cant, kpb) => porBulto
    ? Math.round(cant * kpb * 100) / 100
    : Math.round(cant / kpb * 100) / 100;
  // 100 cajones de 9 kg = 900 kg.
  assert.equal(derivar(true, 100, 9), 900);
  // 900 kg en cajones de 9 = 100 cajones.
  assert.equal(derivar(false, 900, 9), 100);
  // Y con un factor que no divide exacto, a dos decimales.
  assert.equal(derivar(true, 66, 16), 1056);
  assert.equal(derivar(false, 1056, 16), 66);
  assert.equal(derivar(false, 1000, 9), 111.11);
});

test('sin kilos por bulto no se inventa el otro número', () => {
  // Un lote a granel no tiene cajón: convertir por un factor que no existe sería
  // peor que dejar el número como estaba.
  const b = endpoint();
  assert.match(b, /const kg = kpb \? Math\.round\(p\.cantidad \* kpb \* 100\) \/ 100 : it\.kg_estimados/);
  assert.match(b, /const blt = kpb \? Math\.round\(p\.cantidad \/ kpb \* 100\) \/ 100 : it\.cantidad_estimada_presentaciones/);
});

// ── LA PLATA SE REHACE ─────────────────────────────────────────────────────
test('los totales ANTES del cronograma, o la deuda queda con el importe viejo', () => {
  // Es el mismo orden que el endpoint de precios: generarVencimientos reparte el
  // total de la orden, así que sin rehacerlo primero el cronograma sale con el
  // número anterior y la deuda con el proveedor no cambia.
  const b = endpoint();
  const tot = b.indexOf('recalcTotalesOC(db, oc.id)');
  const ven = b.indexOf('generarVencimientos(db, oc.id)');
  assert.ok(tot > 0 && ven > tot, 'el cronograma se rehace después de los totales');
});

test('y avisa cuando el cronograma NO se pudo regenerar', () => {
  // generarVencimientos no toca una orden con cuotas ya pagadas: si no se dijera,
  // la deuda quedaría vieja en silencio.
  const b = endpoint();
  assert.match(b, /WHERE oc_id=\? AND pagado=1/);
  assert.match(b, /revisá la cuenta corriente del proveedor a mano/);
});

// ── LA PANTALLA ────────────────────────────────────────────────────────────
test('el botón vive SÓLO en el renglón que todavía no entró', () => {
  const i = PANEL.indexOf("+ '<td style=\"text-align:right;color:var(--mut)\">todavía no entró</td>'");
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /sgOcCantOpen\(' \+ it\.id \+ '\)/);
  assert.match(b, /lnbPuedeOperar\(\['sg-compras', 'sg-ordenes'\]\)/);
});

test('la pantalla pide la cantidad en la unidad de la orden', () => {
  const i = PANEL.indexOf('function sgOcCantOpen(itemId){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 2200);
  assert.match(b, /var porBulto = it\.modo_carga === 'bulto'/);
  assert.match(b, /var uni = porBulto \? 'bultos' : 'kilos'/);
  assert.match(b, /La orden se cerró POR ' \+ \(porBulto \? 'BULTO' : 'KILO'\)/);
  // Y muestra lo que dice ahora, para no tener que ir a buscarlo.
  assert.match(b, /Ahora dice ' \+ nr\(actual\)/);
});

test('el motivo se pide en la pantalla, no sólo en el servidor', () => {
  const i = PANEL.indexOf('function sgOcCantOpen(itemId){');
  const b = PANEL.slice(i, i + 2200);
  assert.match(b, /Por qué cambia la cantidad/);
  assert.match(b, /if \(String\(motivo\)\.trim\(\)\.length < 3\)/);
});

// ── Y EL PRECIO DE LA CORRECCIÓN, EN LA UNIDAD DE LA ORDEN ─────────────────
test('el modal de corregir arranca en la unidad que pactó la orden', () => {
  // Pablo: «siempre respetando el precio que se ingresó en la orden de compra».
  assert.match(PANEL, /var uniOrden = \(it && it\.modo_carga === 'bulto' && kpb\) \? 'bulto' : 'kg'/);
  assert.match(PANEL, /La orden se cerró <b>por/);
});

test('la pantalla de corregir quedó ordenada en bloques', () => {
  // «Mejorame un poco esa pantalla que está medio fea». Lo que la hacía fea era
  // que todo pesaba lo mismo: el precio —que es lo que mueve la plata— estaba
  // suelto entre la calidad y los kilos.
  assert.match(PANEL, />Lo que entró<\/div>/);
  assert.match(PANEL, />Lo que se paga<\/div>/);
  assert.match(PANEL, /id="sg-loteed-uni-nota"/);
});

// ── UNA BASE DE VERDAD ─────────────────────────────────────────────────────
test('la actualización deja los dos números coherentes', () => {
  // Se corre contra una base: es la parte donde un UPDATE mal escrito deja la
  // orden diciendo 100 bultos de 900 kilos y nadie lo nota hasta que llega el
  // camión.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY, oc_id INTEGER, modo_carga TEXT,
    kg_por_bulto REAL, kg_estimados REAL, cantidad_estimada_presentaciones REAL)`);
  db.prepare(`INSERT INTO sg_oc_items VALUES (1, 7, 'bulto', 9, 810, 90)`).run();
  // 90 → 100 cajones de 9 kg.
  const kg = Math.round(100 * 9 * 100) / 100;
  db.prepare(`UPDATE sg_oc_items SET cantidad_estimada_presentaciones=?, kg_estimados=? WHERE id=?`)
    .run(100, kg, 1);
  const it = db.prepare('SELECT * FROM sg_oc_items WHERE id=1').get();
  assert.equal(it.cantidad_estimada_presentaciones, 100);
  assert.equal(it.kg_estimados, 900);
  assert.equal(it.kg_estimados / it.cantidad_estimada_presentaciones, it.kg_por_bulto);
});
