// ══ LIQUIDAR A PRECIO ABIERTO DEJÓ DE SER IMPOSIBLE ════════════════════════
//
// Pablo, 27/8/2026: «una partida a precio abierto cargada como orden de compra
// no me deja liquidarla a precio abierto y me obliga a precio cerrado».
//
// LA CAUSA: al abrir una partida de precio CERRADO se marcaba ese radio y se
// deshabilitaba el de precio abierto — y no había camino de vuelta. `disabled =
// true` era la ÚNICA línea del archivo que tocaba esa propiedad. Después de
// liquidar UNA partida cerrada el radio quedaba trabado para toda la sesión, y la
// siguiente —aunque se hubiera comprado a precio abierto— se abría con «Precio
// abierto» en gris. Sin recargar la página no se salía, y nada lo decía.
//
// Es el estado que sobrevive al cierre del modal: la pantalla se limpia entera en
// liqAbrirNueva() menos esto, porque esto lo escribió otro camino.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (p) => fs.readFileSync(path.join(RAIZ, p), 'utf8');
const PANEL = leer('src/panel.html');
const SG = leer('src/rutas/sg.js');
const LIQ = leer('src/rutas/liquidaciones.js');

// El bloque que decide el modo al abrir una partida.
function bloqueModo() {
  const i = PANEL.indexOf("var radC = document.querySelector('input[name=\"liq-modo\"][value=\"cerrado\"]');");
  assert.ok(i > 0, 'no encontré el bloque que fija el modo');
  return PANEL.slice(i, i + 2600);
}

test('trabar el radio tiene camino de vuelta', () => {
  // La regla: por cada disabled=true tiene que haber un disabled=false. Sin eso,
  // el primer caso especial se come al resto de la sesión.
  const b = bloqueModo();
  assert.match(b, /radA\.disabled = true/);
  assert.match(b, /radA\.disabled = false/);
  assert.match(b, /\} else \{/, 'sin else, la partida abierta no destraba nada');
});

test('una partida a precio abierto abre en «abierto», aunque la anterior fuera cerrada', () => {
  const b = bloqueModo();
  // El else tiene que hacer las dos cosas: destrabar Y desmarcar el cerrado.
  const i = b.indexOf('} else {');
  const rama = b.slice(i);
  assert.match(rama, /radA\.disabled = false; radA\.title = '';/);
  assert.match(rama, /radC\.checked\) \{ radC\.checked = false;.*radA\.checked = true/);
});

test('y la pantalla se entera: fondo, ayuda y bloque de precio cerrado', () => {
  // Mover el radio por código no dispara su onchange, y de él cuelgan el fondo
  // gris que distingue las dos pantallas, el texto de ayuda y el bloque de precio
  // cerrado. Sin esto el radio dice una cosa y la pantalla muestra otra.
  assert.match(bloqueModo(), /liqModoCambio\(\);/);
});

test('el `disabled` del radio se toca en UN solo lugar', () => {
  // Si aparece un segundo camino que lo trabe, este test avisa: el bug fue
  // exactamente que un camino trababa y ninguno destrababa.
  const trabas = (PANEL.match(/radA\.disabled|abi\.disabled/g) || []).length;
  assert.equal(trabas, 2, 'debería haber exactamente un true y un false');
});

// ── EL SERVIDOR SIGUE SIENDO EL QUE DECIDE ─────────────────────────────────
test('el servidor sigue frenando la partida CERRADA liquidada a precio abierto', () => {
  // Destrabar la pantalla no puede abrir la puerta que el servidor cuida: la
  // condición se pactó en la orden, y liquidar a precio abierto una partida firme
  // es pagarle al productor otra cosa de la que se acordó.
  // Y por CADA partida del grupo: una firme entre varias abiertas no puede pasar.
  assert.match(LIQ, /if \(String\(d\.modo_precio \|\| ''\) !== 'cerrado'\) \{/);
  assert.match(LIQ, /for \(const p of partidas\) \{[\s\S]{0,220}SELECT tipo_precio FROM sg_oc WHERE id = \?'\)\.get\(p\.oc_id\)/);
  assert.match(LIQ, /oc\.tipo_precio !== 'pizarra'/);
  assert.match(LIQ, /no se puede liquidar a precio abierto/);
});

test('el que manda es sg_oc.tipo_precio, no el radio de la pantalla', () => {
  assert.match(SG, /es_precio_cerrado: oc\.tipo_precio !== 'pizarra' \? 1 : 0/);
});

// ── LA BANDEJA DECÍA «CERRADO» POR DOS COSAS DISTINTAS ─────────────────────
test('la columna Precio dice cómo se PACTÓ la compra', () => {
  // «cerrado» significaba «todos los lotes ya tienen precio puesto». Pero precio
  // cerrado es también CÓMO SE PACTÓ, que es lo que decide a qué precio se
  // liquida. Una partida comprada a precio ABIERTO con los lotes ya valorizados
  // decía «cerrado», y se lee como que la compra fue a precio cerrado.
  const i = PANEL.indexOf('function sgLiqPartidasLoad()');
  const b = PANEL.slice(i, i + 3000);
  assert.match(b, /p\.tipo_precio === 'pizarra'/);
  assert.match(b, />abierto</);
  assert.match(b, /lote\(s\) sin valorizar/, 'y lo otro se dice con sus palabras');
});

test('tipo_precio viaja hasta la bandeja', () => {
  // Si el endpoint no lo manda, la columna dice «cerrado» para todo y el arreglo
  // de arriba queda decorativo.
  const i = SG.indexOf('function partidasRecibidas(db, comoSeDocumenta)');
  assert.ok(i > 0);
  assert.match(SG.slice(i, i + 400), /o\.tipo_precio/);
});
