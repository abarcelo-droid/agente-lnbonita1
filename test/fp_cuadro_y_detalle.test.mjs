// ══ EL CUADRO Y SU DETALLE NO PUEDEN DECIR COSAS DISTINTAS ═════════════════
//
// Pablo, 20/10/2026: «revisá que la suma en el detalle no me coincide con lo que me informás en la
// tabla general… siempre en cheques guiate por el archivo de Excel que subo».
//
// Y no coincidía. Medido contra su Excel de cheques emitidos: para la semana del 19/10 el archivo
// tiene 48 cheques por 76.691.813,50 — exactamente lo que mostraba el DETALLE. El cuadro decía
// 407.527.803,46.
//
// LA CAUSA: el cuadro se calculaba UNA sola vez, al apretar Proyectar, y ninguna de las cinco cosas
// que cambian la plata lo volvía a calcular —importar el Excel, marcar un cheque pagado, borrarlo,
// cargar un saldo o borrarlo—. El detalle de la celda consulta en vivo. Después de subir el Excel,
// el cuadro mostraba la foto anterior y el detalle la de ahora: dos números verdaderos de dos
// momentos distintos, sin nada que lo dijera.
//
// Este archivo clava las tres cosas que lo cierran: que se recalcule, que el detalle avise si no
// coincide, y que un movimiento con fecha ilegible no se caiga del cuadro en silencio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const PANEL = leer('src/panel.html');
const { proyectar } = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/fp_motor.js')));

function fuente(txt, firma) {
  const i = txt.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  let prof = 0, k = txt.indexOf('{', i);
  for (; k < txt.length; k++) {
    if (txt[k] === '{') prof++;
    else if (txt[k] === '}') { prof--; if (prof === 0) break; }
  }
  return txt.slice(i, k + 1);
}
function lineaArr(txt, nombre) {
  const i = txt.indexOf('var ' + nombre + ' = [');
  assert.ok(i >= 0, 'no está el arreglo ' + nombre);
  return txt.slice(i, txt.indexOf('];', i) + 2);
}

// ── 1 · LA PLATA QUE EL MOTOR NO PUEDE UBICAR ──────────────────────────────

const CONCEPTOS = [
  { id: 1, nombre: 'Cheques a cobrar', naturaleza: 'ingreso', origen: 'cheques', banco: null },
  { id: 4, nombre: 'Cheques a pagar', naturaleza: 'egreso', origen: 'cheques', banco: null },
];
const correr = (cheques, cuotas = []) => proyectar({
  desde: '2026-10-19', semanas: 26, saldoInicial: 0, conceptos: CONCEPTOS, valores: [], cuotas, cheques,
});
const chq = (fecha_pago, monto) => ({ tipo: 'emitido', banco: 'FRANCES', numero: 'X', fecha_pago, monto });

test('un cheque con fecha ilegible no desaparece del cuadro en silencio', () => {
  // Antes se salteaba con un `continue` y su plata no quedaba en ningún total ni en ningún aviso.
  // Son las fechas que de verdad llegan: el formato argentino, el vacío y el nulo.
  const r = correr([chq('20/10/2026', 8000000), chq('', 10000000), chq(null, 9000000)]);
  assert.equal(r.sin_fecha.items, 3);
  assert.equal(r.sin_fecha.monto, 27000000);
  // Y no se suman a ninguna semana, que sería peor: estarían en la semana equivocada.
  assert.equal(r.egresos.reduce((a, b) => a + b, 0), 0);
});

test('lo que cae fuera del horizonte NO cuenta como fecha ilegible', () => {
  // Un cheque a dos años es correcto que no entre, y decir que «no se pudo leer» sería un aviso
  // rojo por algo que está bien — que es la manera de que dejen de leerse los avisos.
  const r = correr([chq('2029-06-01', 5000000)]);
  assert.equal(r.sin_fecha.items, 0);
  assert.equal(r.sin_fecha.monto, 0);
});

test('lo vencido sigue cayendo en la primera semana, no en el cartel de ilegibles', () => {
  const r = correr([chq('2026-01-15', 1000000), chq('2026-10-19', 3000000)]);
  assert.equal(r.sin_fecha.items, 0);
  assert.equal(r.egresos[0], 4000000, 'lo vencido tiene que seguir sumando en la primera columna');
  assert.equal(r.vencido.items, 1);
});

test('una cuota con fecha ilegible también se cuenta', () => {
  const r = correr([], [{ periodo: 'no es un período', semana_debito: 1, capital: 500000, interes: 100000,
    banco: 'FRANCES', numero: 'P1', nro_cuota: 1 }]);
  assert.equal(r.sin_fecha.items, 1);
  assert.equal(r.sin_fecha.monto, 600000);
});

test('se informa SIEMPRE, aunque sea cero: es el molde de los huérfanos', () => {
  const r = correr([chq('2026-10-20', 1000)]);
  assert.deepEqual(r.sin_fecha, { items: 0, monto: 0 });
  assert.ok(r.huerfanos, 'el aviso de huérfanos tiene que seguir estando');
});

test('la pantalla lo dice, en rojo y con el número', () => {
  const k = fuente(PANEL, 'function fpPintarKpis()');
  assert.match(k, /if \(p\.sin_fecha && p\.sin_fecha\.items\)/);
  assert.match(k, /quedaron fuera del flujo/);
  assert.match(k, /fecha que no se puede leer/);
  assert.match(k, /fpMonto\(p\.sin_fecha\.monto\)/, 'el aviso tiene que decir cuánta plata es');
});

// ── 2 · TODO LO QUE CAMBIA LA PLATA RECALCULA EL CUADRO ────────────────────

test('las cinco puertas que cambian la plata recalculan el cuadro', () => {
  // Es la causa de la diferencia que encontró Pablo: ninguna de las cinco lo hacía.
  for (const [fn, firma] of [
    ['fpChequeEstado', 'function fpChequeEstado(id, estado)'],
    ['fpChequeBorrar', 'function fpChequeBorrar(id)'],
    ['fpImportar', 'function fpImportar(preview)'],
    ['fpSaldoGuardar', 'function fpSaldoGuardar()'],
    ['fpSaldoBorrar', 'function fpSaldoBorrar(id)'],
  ]) {
    assert.match(fuente(PANEL, firma), /fpRecalcular\(\)/, fn + ' no recalcula el cuadro');
  }
});

test('pero no le pide la cuenta al servidor al que todavía no apretó Proyectar', () => {
  let pedidos = 0;
  const hacer = (proy) => {
    const f = new Function('FP', 'fpProyectar', [
      fuente(PANEL, 'function fpRecalcular()'), 'return fpRecalcular;',
    ].join('\n'))({ proy }, () => { pedidos++; });
    f();
  };
  hacer(null);
  assert.equal(pedidos, 0, 'recalculó un cuadro que nadie está mirando');
  hacer({ semanas: [] });
  assert.equal(pedidos, 1, 'no recalculó el cuadro que sí está en pantalla');
});

// ── 3 · EL DETALLE AVISA CUANDO NO COINCIDE CON LA CELDA ───────────────────

function pantalla(filas, enElCuadro) {
  let html = '';
  const doc = { getElementById: () => ({ set innerHTML(v) { html = v; }, get innerHTML() { return html; } }) };
  const ctx = new Function('document', [
    'var FP = { sem: { filas: [], orden: "fecha_pago", desc: false, aviso: "", enElCuadro: 0 } };',
    fuente(PANEL, 'function fpN(n, dec)'),
    fuente(PANEL, 'function fpNum(n)'),
    fuente(PANEL, 'function fpMonto(n)'),
    fuente(PANEL, 'function fpEsc(s)'),
    fuente(PANEL, 'function fpFecha(f)'),
    lineaArr(PANEL, 'FP_SEM_COLS'),
    fuente(PANEL, 'function fpSemPintar()'),
    'return { FP: FP, pintar: fpSemPintar };',
  ].join('\n'))(doc);
  ctx.FP.sem.filas = filas;
  ctx.FP.sem.enElCuadro = enElCuadro;
  ctx.pintar();
  return html;
}

const CH = (numero, monto) =>
  ({ numero, banco: 'FRANCES', beneficiario: 'X SA', fecha_pago: '2026-10-21', monto });
const TRES = [CH('1', 4000000), CH('2', 3000000), CH('3', 2000000)];   // 9.000.000

test('si el cuadro dice otra cosa, el detalle lo dice en la cara', () => {
  // Los dos números salen de los mismos cheques: una diferencia significa que el cuadro quedó
  // viejo. Mostrarlos en dos ventanas sin decir nada es lo que hace dudar de todo el módulo.
  const h = pantalla(TRES, 407527803.46);
  assert.match(h, /El cuadro dice 407\.527\.803,46 y acá hay 9\.000\.000/);
  assert.match(h, /diferencia de 398\.527\.803,46/);
  assert.match(h, /apretá <b>Proyectar<\/b>/, 'tiene que decir qué hacer, no sólo que está mal');
  assert.match(h, /Lo de esta ventana es lo que hay <b>ahora<\/b>/, 'y cuál de los dos creer');
});

test('cuando coinciden no molesta con nada', () => {
  const h = pantalla(TRES, 9000000);
  assert.ok(!/El cuadro dice/.test(h), 'avisó una diferencia que no existe');
  assert.match(h, /<b>3<\/b> cheque\(s\)/);
});

test('un centavo de diferencia se avisa; el redondeo del coma cero cero uno, no', () => {
  // El motor redondea a dos decimales, así que una diferencia real nunca es de milésimas. Avisar
  // por un 0,0001 sería el cartel que nadie vuelve a leer.
  assert.match(pantalla(TRES, 9000000.01), /El cuadro dice/);
  assert.ok(!/El cuadro dice/.test(pantalla(TRES, 9000000.001)));
});

test('la celda contra la que compara suma TODAS las filas de cheques de ese signo', () => {
  // La consulta del detalle no filtra por banco, así que si hubiera una fila por banco habría que
  // sumarlas todas: comparar contra una sola daría un cartel rojo permanente y falso.
  const f = fuente(PANEL, 'function fpChequesDeSemana(i, esIngreso)');
  assert.match(f, /f\.origen === 'cheques' && \(f\.naturaleza === 'ingreso'\) === !!esIngreso/);
  assert.match(f, /reduce\(function\(a, f\) \{ return a \+ \(Number\(\(f\.montos \|\| \[\]\)\[i\]\) \|\| 0\); \}, 0\)/);
  // Y viaja hasta el pintado, que es donde se compara.
  assert.match(f, /enElCuadro: enElCuadro/);
});

test('el que compara el detalle y el motor cuentan lo mismo', () => {
  // La prueba de fondo: para una misma celda, lo que suma el cuadro y lo que devolvería la
  // consulta del detalle tienen que dar igual. Si alguna vez dejan de hacerlo, el cartel salta.
  const cheques = [chq('2026-01-15', 1000000), chq('2026-10-19', 3000000),
    chq('2026-10-25', 4000000), chq('2026-10-26', 5000000)];
  const r = correr(cheques);
  const celda = r.filas.filter((f) => f.origen === 'cheques' && f.naturaleza === 'egreso')
    .reduce((a, f) => a + f.montos[0], 0);
  // Lo que trae el detalle de la primera semana: todo lo pendiente hasta el domingo 25.
  const detalle = cheques.filter((c) => c.fecha_pago <= '2026-10-25')
    .reduce((a, c) => a + c.monto, 0);
  assert.equal(celda, detalle);
  assert.equal(celda, 8000000);
});
