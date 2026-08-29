// ══ LA LIQUIDACIÓN NO SE TIPEA: SE CONFIRMA ════════════════════════════════
//
// Pablo, 29/8/2026: «pusimos un cerrojo para que sólo se pueda facturar cuando
// toda la partida tiene venta o está mermada, entonces la liquidación no debería
// permitirnos liquidar un número diferente de bultos a los ingresados… Tampoco
// está bien que me deje editar artículos, ya que ellos vienen con la partida…
// tampoco tiene sentido editar estos cuadros, deberían venir todos por sistema».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const cuerpo = (nombre, largo = 2600) => {
  const i = PANEL.indexOf(nombre);
  assert.ok(i > 0, 'no existe ' + nombre);
  return PANEL.slice(i, i + largo);
};

// La regla real, importada sin inyectarle nada.
function cargarRegla() {
  const i = PANEL.indexOf('function liqCeldaCalculada(k, amb){');
  assert.ok(i > 0, 'no existe liqCeldaCalculada');
  const src = PANEL.slice(i, PANEL.indexOf('\n}', i) + 2);
  // eslint-disable-next-line no-new-func
  return new Function(src + '; return liqCeldaCalculada;')();
}
const calculada = cargarRegla();

// ── 1 · LOS BULTOS ─────────────────────────────────────────────────────────

test('los bultos a liquidar son los que entraron, y no se tipean', () => {
  // El sistema ya no deja liquidar hasta que la partida salió entera —vendida
  // más merma—, así que este número sólo puede ser el que entró. Editable era
  // la única forma de liquidar de menos.
  const i = PANEL.indexOf('id="liq-bultos-liq"');
  assert.ok(i > 0);
  assert.match(PANEL.slice(i - 300, i + 300), /readonly tabindex="-1"/);
  assert.match(PANEL, /value="' \+ \(r\.bultos_ingresados \|\| 0\) \+ '"/);
  assert.match(PANEL, /id="liq-cerr-cant" type="number" step="1" min="0" readonly tabindex="-1"/);
});

test('y el de arriba dice el mismo número que el de abajo', () => {
  // Es el mismo dato dicho dos veces en la misma pantalla: si uno se pudiera
  // tocar y el otro no, se contradicen.
  assert.match(PANEL, /cc\.value = Number\(r\.bultos_ingresados\) \|\| Number\(r\.bultos_vendidos\) \|\| '';/);
});

test('el renglón del artículo se sincroniza donde se fija el número', () => {
  // El oninput dejó de existir al quedar de sólo lectura: sin esto el cuadro
  // decía 55 y el artículo seguía en los bultos de la vez anterior.
  assert.match(PANEL, /if \(String\(cc\.value\) !== antes\) liqArtSync\(\);/);
});

test('pero NO le mete a un producto los bultos de toda la partida', () => {
  // Con dos productos, los bultos de arriba son el total: metérselos al primer
  // renglón le adjudica a uno lo que entró de los dos, y el papel donde el
  // productor cobra sale mal.
  //
  // Se cuentan los renglones REALES —los de merma no son productos vendidos—, si no
  // una partida de un solo producto con merma dejaba de sincronizarse.
  const b = cuerpo('function liqArtSync(){', 2600);
  assert.match(b, /var reales = arts\.filter\(function\(a\)\{ return !esM\(a\); \}\);/);
  assert.match(b, /if \(reales\.length === 1\) \{/);
});

// ── 2 · LOS ARTÍCULOS ──────────────────────────────────────────────────────

test('el artículo entero viene de la partida', () => {
  const b = cuerpo('function liqRenderArt(arts) {', 4200);
  for (const k of ['articulo', 'cantidad', 'precio', 'importe']) {
    const j = b.indexOf('data-k="' + k + '"');
    assert.ok(j > 0, 'falta el campo ' + k);
    assert.ok(b.slice(j, j + 260).includes('+ro+'), 'el campo ' + k + ' quedó editable');
  }
});

test('y se dice a dónde ir a corregirlo', () => {
  // Un campo gris sin explicación se lee como que la pantalla está rota.
  const b = cuerpo('function liqRenderArt(arts) {', 4200);
  assert.match(b, /El producto, la cantidad y el precio salen de la partida/);
  assert.match(b, /se corrige en la orden de compra/);
});

// ── 3 · LAS CELDAS DE LA GRILLA ────────────────────────────────────────────

test('todos los IVA salen del importe por la alícuota', () => {
  // Si un día hay que cambiar la alícuota, se cambia la alícuota, no el IVA.
  for (const k of ['iva_ventas', 'iva_comision', 'iva_descarga', 'iva_flete', 'iva_gastos_admin']) {
    assert.equal(calculada(k, 'f'), true, k + ' quedó editable');
  }
});

test('la comisión sale de una cuenta en los dos modos y en las dos columnas', () => {
  // Abierto: ventas × %. Cerrado: la despeja el sistema para llegar al precio
  // acordado. Tocar el importe deja el % de al lado mintiendo.
  assert.equal(calculada('comision', 'f'), true);
  assert.equal(calculada('comision', 'g'), true);
});

test('la descarga y el flete NO se reparten a gestión', () => {
  // Regla de Pablo, citada en el propio archivo: «la comisión debe afectar tanto
  // a la parte fiscal como a la parte de gestión, no así la descarga y el
  // flete». Nadie las calculaba y entraban igual en el despeje: eran la única
  // puerta para meter plata de gestión sin origen.
  assert.equal(calculada('descarga', 'g'), true);
  assert.equal(calculada('flete', 'g'), true);
  assert.equal(calculada('gastos_admin', 'g'), true);
  assert.match(PANEL, /no así la descarga y el flete/);
});

test('lo que el sistema HOY no puede calcular sigue abierto', () => {
  // Trabarlo dejaría liquidaciones que no se pueden emitir. Cada uno con su
  // motivo escrito al lado.
  assert.equal(calculada('ventas', 'f'), false, 'ventas: falta el freno de lo no facturado');
  assert.equal(calculada('ventas', 'g'), false);
  assert.equal(calculada('descarga', 'f'), false, 'descarga: puede estar sin valorizar');
  assert.equal(calculada('flete', 'f'), false, 'flete: el adelantado por SG no llega solo');
  assert.equal(calculada('gastos_admin', 'f'), false, 'a precio abierto nada lo calcula');
});

test('y está escrito POR QUÉ cada uno sigue abierto', () => {
  // Para que el próximo que lo mire no lo trabe sin resolver lo de arriba.
  const j = PANEL.indexOf('function liqCeldaCalculada(k, amb){');
  const antes = PANEL.slice(j - 3400, j);
  assert.match(antes, /NO se cierran, y hay que decir por qué/);
  assert.match(antes, /despachada sin facturar todavía/);
  assert.match(antes, /valoriza cuando se le paga a la cooperativa/);
  assert.match(antes, /adelantó/);
});

test('la celda trabada dice por qué lo está', () => {
  assert.match(PANEL, /function liqCeldaPorQue\(k, amb\)\{/);
  assert.match(PANEL, /Sale del importe por la alícuota de la fila/);
  assert.match(PANEL, /A precio cerrado se despeja para llegar al precio acordado/);
  assert.match(PANEL, /La descarga y el flete no se reparten a gestión/);
});

test('una sola puerta: la fila nueva no puede olvidarse de cerrarse', () => {
  const b = cuerpo('var inp = function(k, amb){', 1400);
  assert.match(b, /if \(liqCeldaCalculada\(k, amb\)\) \{/);
});

// ── 4 · EL CARTEL QUE MENTÍA ───────────────────────────────────────────────

test('el sub-rótulo se refresca: decía «a mano» sobre un número calculado', () => {
  // El despeje corregía el texto y nadie lo volvía a pintar, así que Gastos
  // administrativos decía «a mano» sobre el ajuste que la propia pantalla acaba
  // de calcular tres líneas antes.
  assert.match(PANEL, /function liqOrigenPintar\(\)\{/);
  assert.match(PANEL, /id="liq-org-' \+ f\.k \+ '"/);
  const b = cuerpo('LIQ.origen.gastos_admin = gAjuste > 0', 500);
  assert.match(b, /liqOrigenPintar\(\);/);
});

test('y refresca SÓLO el rótulo, no la grilla entera', () => {
  // Repintarla destruiría los inputs y se llevaría el foco del que se está
  // tipeando: es de donde salió el bug de «entra un dígito por vez».
  const b = cuerpo('function liqOrigenPintar(){', 500);
  assert.match(b, /e\.innerHTML = org\[f\.k\] \|\| ''/);
  assert.ok(!/liqGrillaPintar\(\)/.test(b), 'repinta la grilla entera');
});

// ── 5 · EL % DE COMISIÓN ───────────────────────────────────────────────────

test('a precio cerrado el % se VE trabado, no sólo lo está', () => {
  // Ya era readOnly, pero se veía igual que un campo editable y por eso se lee
  // como una invitación a tipear.
  const b = cuerpo("if (f.k === 'comision') {", 1400);
  assert.match(b, /var pctFijo = \(liqModo\(\) === 'cerrado'\);/);
  assert.match(b, /pctFijo[\s\S]{0,260}cursor:not-allowed/);
});

test('pero a precio abierto sigue editable: es la variable de ese modo', () => {
  // «Hay proveedores que tienen distintas comisiones» — Pablo.
  const b = cuerpo("if (f.k === 'comision') {", 1400);
  assert.match(b, /oninput="liqComisionCalcular\(\)"/);
});
