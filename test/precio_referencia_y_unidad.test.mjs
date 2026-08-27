// ══ EL PRECIO DE LA ORDEN: LA REFERENCIA Y LA UNIDAD ═══════════════════════
// Pablo, 27/8/2026.
//
// 13) «El precio cargado de referencia en una orden de compra a precio abierto
//     debe vivir en algún lado.»
//     Se guardaba desde siempre y se veía en UN solo lugar: la ficha de la orden.
//     El momento en que ese número sirve es otro — cuando se cierra el precio de
//     la partida, que es cuando el comprador decide cuánto se le paga al productor
//     y no tenía contra qué compararlo.
//
//  7) «Cuando voy a corregir una orden de compra debería permitirme corregir el
//     costo por bulto o por kilo.»
//     El campo era sólo $/kg. La compra se pacta por bulto la mayoría de las
//     veces, así que había que dividir a mano por los kilos del cajón — y esa
//     división es justamente donde se cuelan los errores que la corrección viene
//     a arreglar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const bloque = (nombre, largo = 1800) => {
  const i = PANEL.indexOf('function ' + nombre + '(');
  assert.ok(i > 0, 'no encontré ' + nombre);
  return PANEL.slice(i, i + largo);
};

// Las funciones de conversión, sacadas del archivo y ejecutadas de verdad. Es la
// cuenta donde un factor mal puesto cambia el precio por diez sin que se note.
function conversores() {
  const src = ['sgLoteEdKpb', 'sgLoteEdPrecioKg'].map((n) => {
    const i = PANEL.indexOf('function ' + n + '(');
    assert.ok(i > 0, n);
    let d = 0, j = PANEL.indexOf('{', i);
    const ini = j;
    for (; j < PANEL.length; j++) {
      if (PANEL[j] === '{') d++;
      else if (PANEL[j] === '}') { d--; if (d === 0) { j++; break; } }
    }
    return PANEL.slice(i, j);
  }).join('\n');
  // eid() y SG los pone el test: acá sólo interesa la aritmética.
  const f = new Function('SG', 'eid', src + '; return { sgLoteEdKpb, sgLoteEdPrecioKg };');
  return f;
}

// ── 13 · LA REFERENCIA, DONDE SIRVE ────────────────────────────────────────
test('la referencia viaja al modal de cerrar precio', () => {
  assert.match(PANEL, /function sgPrecioOpen\(loteId, codigo, kg, refKg\)\{/);
  // Y el botón se la pasa: sin esto la función la recibe siempre vacía.
  assert.match(PANEL, /sgPrecioOpen\('\+l\.id\+',\\'' \+ esc\(l\.codigo_lote\) \+ '\\','\+l\.kg_reales/);
  assert.match(PANEL, /refKgAcc == null \? 'null' : refKgAcc/);
});

test('accionesDe no puede ver `it`, así que la referencia entra por cierre', () => {
  // accionesDe() se define ANTES del forEach de ítems: adentro no existe `it`.
  // Si alguien la lee de ahí, es undefined y el botón manda "undefined".
  const decl = PANEL.indexOf('var refKgAcc = null;');
  const acc = PANEL.indexOf('var accionesDe = function(l){');
  const set = PANEL.indexOf('refKgAcc = refKg;');
  assert.ok(decl > 0 && acc > 0 && set > 0);
  assert.ok(decl < acc, 'la variable se declara antes de la función que la usa');
  assert.ok(acc < set, 'y se rellena en cada vuelta del forEach, que va después');
});

test('el modal muestra la referencia y el margen EN VIVO', () => {
  const b = bloque('sgPrecioOpen', 1600);
  assert.match(b, /venta de referencia/);
  // El margen se calcula sobre el precio de VENTA, como en la ficha de la orden.
  assert.match(b, /\(ref-p\)\/ref\*1000/);
  assert.match(b, /se estaría pagando MÁS de lo que se espera vender/);
  // Sin referencia el modal sigue funcionando: es un dato opcional.
  assert.match(b, /ref!=null/);
});

// ── 7 · POR BULTO O POR KILO ───────────────────────────────────────────────
test('el selector de unidad existe y convierte al cambiar', () => {
  assert.match(PANEL, /id="sg-loteed-uni" onchange="sgLoteEdUni\(\)"/);
  assert.match(PANEL, /<option value="bulto">por bulto<\/option>/);
  const b = bloque('sgLoteEdUni', 700);
  // Convertir, no dejar el número igual: dejarlo igual cambia el precio por el
  // factor del cajón sin que se note.
  assert.match(b, /v \* kpb/);
  assert.match(b, /v \/ kpb/);
});

test('arranca en la unidad en que se pactó la compra', () => {
  // Si el cajón vale $25.000, ver "$2.777,78 /kg" obliga a una cuenta mental
  // para saber si está bien.
  const b = bloque('sgLoteEditarOpen', 2600);
  assert.match(b, /uni\.value = kpb \? 'bulto' : 'kg'/);
  assert.match(b, /uni\.disabled = !kpb/, 'sin kg por bulto no hay conversión posible');
});

test('la otra unidad queda siempre a la vista', () => {
  // Es el control que evita guardar $/bulto creyendo que son $/kg.
  const b = bloque('sgLoteEdEq', 700);
  assert.match(b, /\/kg · bultos de/);
  assert.match(b, /\/bulto · bultos de/);
});

test('LO QUE VIAJA AL SERVIDOR ES SIEMPRE $/kg', () => {
  // Es la unidad con la que corren el costo, el margen y lo que se le debe al
  // proveedor. Mandar la otra deja dos ítems del mismo listado como números
  // incomparables, y nadie sabría cuál está mal.
  assert.match(PANEL, /precio_unitario_kg: sgLoteEdPrecioKg\(\)/);
  assert.ok(!/precio_unitario_kg: v\('sg-loteed-precio'\)/.test(PANEL),
    'quedó el envío viejo, que manda lo tipeado sin convertir');
});

test('la conversión da el número correcto, corriéndola', () => {
  const armar = conversores();
  // Un cajón de 9 kg a $25.000 el cajón = $2.777,777778 el kilo.
  const lote = { bultos: 45, kg_reales: 405, kg_por_bulto: null };
  let uni = 'bulto', precio = '25000';
  const api = armar({ loteEdit: lote }, (id) => ({
    value: id === 'sg-loteed-uni' ? uni : precio,
  }));
  assert.equal(api.sgLoteEdKpb(lote), 9);
  assert.equal(Number(api.sgLoteEdPrecioKg()), 2777.777778);
  // Y por kilo, lo tipeado pasa tal cual.
  uni = 'kg'; precio = '2777.78';
  assert.equal(Number(api.sgLoteEdPrecioKg()), 2777.78);
  // Vacío sigue siendo vacío: no se inventa un precio.
  precio = '';
  assert.equal(api.sgLoteEdPrecioKg(), null);
});

test('sin kilos por bulto, lo tipeado se manda tal cual', () => {
  // Un lote a granel no tiene cajón. Convertir por un factor inventado sería
  // peor que no ofrecer la conversión.
  const armar = conversores();
  const lote = { bultos: 0, kg_reales: 800, kg_por_bulto: null };
  const api = armar({ loteEdit: lote }, (id) => ({
    value: id === 'sg-loteed-uni' ? 'bulto' : '1500',
  }));
  assert.equal(api.sgLoteEdKpb(lote), null);
  assert.equal(Number(api.sgLoteEdPrecioKg()), 1500);
});

test('los kilos por bulto salen del lote, y si no, se derivan', () => {
  const armar = conversores();
  const api = armar({}, () => ({ value: '' }));
  assert.equal(api.sgLoteEdKpb({ kg_por_bulto: 16, bultos: 66, kg_reales: 1056 }), 16);
  assert.equal(api.sgLoteEdKpb({ kg_por_bulto: null, bultos: 66, kg_reales: 1056 }), 16);
  assert.equal(api.sgLoteEdKpb({ kg_por_bulto: 0, bultos: 0, kg_reales: 0 }), null);
});
