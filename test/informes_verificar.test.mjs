// El verificador contra la planilla. Lo que hay que probar es lo que puede fallar EN SILENCIO:
// que aparee mal las filas. Si comparara por posición, la fila 5 de la base contra la 6 de la
// planilla, encontraría diferencias en todos lados y saldríamos a buscar un bug que no existe.
//
// La lógica pura vive acá para poder probarla sin Google ni better-sqlite3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { num } from '../src/servicios/sheets_num.js';

// El sync saltea las filas con la columna A vacía (`if (!r[0]) continue`). Esta es la misma
// regla, y es lo que hace que la posición NO sirva para aparear.
function indexarPlanilla(rows, primeraFila) {
  const idx = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    const k = String(r[0]);
    if (!idx.has(k)) idx.set(k, { fila_planilla: primeraFila + i, r });
  }
  return idx;
}

// Una planilla con DOS filas vacías en el medio, que es lo que descoloca el apareo posicional.
const PLANILLA = [
  ['V-1', '01/07/2026', 'F-1'],   // fila 2
  [null, null, null],             // fila 3  ← el sync la saltea
  ['V-2', '02/07/2026', 'F-2'],   // fila 4
  ['', null, null],               // fila 5  ← también
  ['V-3', '03/07/2026', 'F-3'],   // fila 6
];

test('aparear por id_venta y no por posición', () => {
  const idx = indexarPlanilla(PLANILLA, 2);
  assert.equal(idx.size, 3);
  // V-2 es la SEGUNDA fila que guardó el sync, pero está en la fila 4 de la planilla.
  assert.equal(idx.get('V-2').fila_planilla, 4);
  assert.equal(idx.get('V-3').fila_planilla, 6);
  // Aparear por posición habría comparado V-2 contra la fila 3, que está vacía.
  assert.notEqual(idx.get('V-2').fila_planilla, 3);
});

test('el número de fila que informa es el de la planilla, para poder ir a mirarla', () => {
  const idx = indexarPlanilla(PLANILLA, 2);
  for (const [id, v] of idx) assert.equal(PLANILLA[v.fila_planilla - 2][0], id);
});

// La comparación: base contra planilla, pasando el crudo por el MISMO num() del sync.
function comparar(base, crudo) {
  const b = Number(base) || 0;
  const c = num(crudo);
  const dif = Math.round((c - b) * 1000) / 1000;
  return { base: b, interpretado: c, diferencia: dif,
    ratio: b !== 0 ? Math.round((c / b) * 10000) / 10000 : null,
    coincide: Math.abs(dif) < 0.01 };
}

test('cuando lo guardado coincide con la planilla, lo dice', () => {
  const r = comparar(1310.754, 1310.754);
  assert.equal(r.coincide, true);
  assert.equal(r.ratio, 1);
});

test('el ratio delata el error de 1000× de un vistazo', () => {
  // La hipótesis de Andy: "1.310,754" kg leído como 1.310.754. Si eso hubiera quedado en la
  // base, el ratio contra el valor real de la planilla da 0,001 — no un decimal cualquiera.
  const r = comparar(1310754, 1310.754);
  assert.equal(r.coincide, false);
  assert.equal(r.ratio, 0.001);
  // Y al revés, si la base quedó mil veces por debajo.
  assert.equal(comparar(1310.754, 1310754).ratio, 1000);
});

test('un dólar que había quedado en cero se ve como diferencia entera', () => {
  // El bug original: parseFloat("U$ 510.704") = NaN → 0. Al arreglarse, la suma sube.
  const r = comparar(0, 510704);
  assert.equal(r.coincide, false);
  assert.equal(r.base, 0);
  assert.equal(r.interpretado, 510704);
  // Sin base no hay ratio posible, y no se inventa uno.
  assert.equal(r.ratio, null);
});

test('una celda que sigue llegando como TEXTO se distingue de una que llega como número', () => {
  // Con UNFORMATTED_VALUE la planilla manda números. Si una celda es texto de verdad —tipeada
  // a mano, o una fórmula que devuelve string— sigue pasando por el adivinador de separadores,
  // y eso hay que poder verlo por separado.
  assert.equal(typeof 1310.754, 'number');
  assert.equal(typeof '1.310,754', 'string');
  // El adivinador acierta con la coma decimal…
  assert.equal(num('1.310,754'), 1310.754);
  // …y se equivoca justo donde decía la hipótesis: un punto con 3 dígitos atrás lo lee como
  // separador de miles. Por eso el tipo de la celda va en la respuesta.
  assert.equal(num('1.310'), 1310);
});

test('una diferencia de redondeo no se reporta como error', () => {
  assert.equal(comparar(1310.754, 1310.7541).coincide, true);
  assert.equal(comparar(1310.754, 1310.9).coincide, false);
});
