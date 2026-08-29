// ══ LO QUE SE DECIDE ARRIBA NO SE VUELVE A TIPEAR ABAJO ════════════════════
//
// Pablo, 27/8/2026: «cuando voy a emitir una nueva liquidación no tiene sentido no
// tocar nada arriba y que abajo me dejes modificar precios y cantidades de bultos.
// Simplifiquemos esta pantalla, creo que hay info que se repite».
//
// Y se repetía literal: arriba «precio acordado × bultos a liquidar = total», abajo
// «cantidad / precio / importe». Los mismos tres números, editables en dos lugares.
// Cambiar uno no cambiaba el otro, así que la liquidación podía salir diciendo una
// cosa arriba y otra en el renglón — y el renglón es el que se imprime en el papel
// donde el productor cobra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// Saca una función del archivo y la ejecuta con las dependencias que le pasemos.
function fn(nombre, deps = {}) {
  const i = PANEL.indexOf('function ' + nombre + '(');
  assert.ok(i > 0, 'no encontré ' + nombre);
  let d = 0, j = PANEL.indexOf('{', i);
  for (; j < PANEL.length; j++) {
    if (PANEL[j] === '{') d++;
    else if (PANEL[j] === '}') { d--; if (d === 0) { j++; break; } }
  }
  const nombres = Object.keys(deps);
  return new Function(...nombres, PANEL.slice(i, j) + '; return ' + nombre + ';')(
    ...nombres.map((k) => deps[k]));
}

// ── CUÁNDO EL RENGLÓN ES DERIVADO ──────────────────────────────────────────
test('con partida y precio cerrado, el renglón sale de arriba', () => {
  const derivado = fn('liqArtDerivado', { LIQ: null, liqModo: () => 'cerrado' });
  assert.equal(derivado(), false, 'sin LIQ no hay partida');
});

test('la liquidación SUELTA se sigue cargando a mano', () => {
  // Es para lo que existe: una liquidación que no sale de ninguna partida.
  const armar = (LIQ, modo) => fn('liqArtDerivado', { LIQ, liqModo: () => modo })();
  assert.equal(armar({ partida: null }, 'cerrado'), false);
  assert.equal(armar({ partida: { oc_id: 7 } }, 'cerrado'), true);
  // Y a precio ABIERTO tampoco se deriva: ahí el precio se está construyendo.
  assert.equal(armar({ partida: { oc_id: 7 } }, 'abierto'), false);
  assert.equal(armar({ partida: {} }, 'cerrado'), false, 'una partida sin oc_id no es una partida');
});

// ── EL BULTO ES ENTERO ─────────────────────────────────────────────────────
test('no existe medio cajón', () => {
  // El campo dejaba tipear 45,01 y ese decimal se multiplicaba por el precio: la
  // liquidación salía por unos pesos de más contra lo acordado y el control de
  // cierre se quejaba sin que se viera por qué. Es la captura de Pablo.
  const paso = (u) => fn('liqPasoCantidad', { liqUnidad: () => u })();
  assert.equal(paso('bulto'), '1');
  assert.equal(paso('kilo'), '0.01', 'el kilo sí lleva decimales: es peso');
  assert.equal(paso(''), '0.01');
});

test('y el campo de arriba también va de a un bulto', () => {
  assert.match(PANEL, /id="liq-cerr-cant" type="number" step="1" min="0"/);
  assert.ok(!/id="liq-cerr-cant" type="number" step="0\.01"/.test(PANEL),
    'quedó el paso viejo, que deja tipear 45,01 bultos');
});

// ── QUE LOS DOS LADOS DIGAN LO MISMO ───────────────────────────────────────
test('cambiar los bultos de arriba baja al renglón', () => {
  // Sin esto el cuadro decía 45 y el artículo seguía en los 60 de la vez anterior,
  // y la diferencia aparecía recién en el control de cierre.
  assert.match(PANEL, /function liqArtSync\(\)\{/);
  // Los bultos ya no se tipean —se liquida la partida entera—, así que el
  // oninput dejó de existir y el renglón se sincroniza donde se fija el número.
  assert.match(PANEL, /if \(String\(cc\.value\) !== antes\) liqArtSync\(\);/);
  const i = PANEL.indexOf('function liqArtSync(){');
  const b = PANEL.slice(i, i + 1500);
  assert.match(b, /if \(!liqArtDerivado\(\)\) return;/, 'no toca la liquidación suelta');
  // SÓLO con un producto: si la partida trae dos, los bultos de arriba son el
  // TOTAL y metérselos al primer renglón le adjudica a un producto lo que entró
  // de los dos — el papel donde el productor cobra sale mal.
  assert.match(b, /if \(arts\.length === 1\) \{/);
  assert.match(b, /arts\[0\]\.cantidad = cant/);
  assert.match(b, /arts\[0\]\.importe = Math\.round\(arts\[0\]\.cantidad \* arts\[0\]\.precio \* 100\) \/ 100/);
});

test('el precio se lee con separador de miles, no crudo', () => {
  // El campo muestra $25.000. parseFloat sobre eso da 25, y la liquidación saldría
  // por mil veces menos.
  const i = PANEL.indexOf('function liqArtSync(){');
  const b = PANEL.slice(i, i + 1500);
  assert.match(b, /liqNum\(eid\('liq-cerr-precio'\)\)/);
  assert.ok(!/parseFloat\(\(eid\('liq-cerr-precio'\)/.test(b));
});

// ── LA PANTALLA ────────────────────────────────────────────────────────────
test('los campos derivados se ven, no se tipean', () => {
  const i = PANEL.indexOf('function liqRenderArt(arts) {');
  const b = PANEL.slice(i, i + 4200);
  assert.match(b, /const fijo = liqArtDerivado\(\)/);
  assert.match(b, /const ro = fijo \? ' readonly tabindex="-1"/);
  // TODO el renglón queda de sólo lectura. Pablo, 29/8/2026: «no está bien que
  // me deje editar artículos, ya que ellos vienen con la partida».
  assert.match(b, /data-k="cantidad".*\+ro\+/);
  assert.match(b, /data-k="precio".*\+ro\+/);
  assert.match(b, /data-k="articulo".*\+ro\+/);
  // El importe también: es cantidad × precio y los dos salen de la partida.
  // Tocarlo era la forma de que la liquidación no diera el precio acordado sin
  // que se viera dónde se había torcido.
  const imp = b.slice(b.indexOf('data-k="importe"'), b.indexOf('data-k="importe"') + 260);
  assert.ok(imp.includes('+ro+'), 'el importe tiene que quedar de sólo lectura');
});

test('sin agregar ni borrar renglones cuando viene de una partida', () => {
  const i = PANEL.indexOf('function liqRenderArt(arts) {');
  const b = PANEL.slice(i, i + 4200);
  assert.match(b, /if \(add\) add\.style\.display = fijo \? 'none' : ''/);
  assert.match(b, /fijo \? '<span><\/span>'/, 'la × no se ofrece');
  assert.match(PANEL, /id="liq-art-add"/);
});

test('y se dice por qué no se pueden tocar, con el camino', () => {
  // Un campo gris sin explicación se lee como que la pantalla está rota.
  const i = PANEL.indexOf('function liqRenderArt(arts) {');
  const b = PANEL.slice(i, i + 4200);
  // Y el camino es la orden de compra: los bultos ya no se tocan tampoco.
  assert.match(b, /El producto, la cantidad y el precio salen de la partida/);
  assert.match(b, /se corrige en la orden de compra/);
  assert.match(PANEL, /id="liq-art-nota"/);
});

test('la lectura del renglón NO cambió: readonly sigue siendo un input', () => {
  // _liqLeerArt recorre input[data-k]. Si los derivados se dibujaran como texto,
  // la liquidación se guardaría SIN artículos y el papel saldría vacío.
  const i = PANEL.indexOf('function _liqLeerArt() {');
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /querySelectorAll\('#liq-articulos \.liq-art-row'\)/);
  assert.match(b, /row\.querySelectorAll\('input\[data-k\]'\)/);
  const r = PANEL.indexOf('function liqRenderArt(arts) {');
  const br = PANEL.slice(r, r + 3000);
  assert.match(br, /'<input data-k="cantidad"/, 'sigue siendo input, no un span');
  assert.match(br, /'<input data-k="precio"/);
});
