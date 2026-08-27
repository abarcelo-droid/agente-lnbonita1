// VENTANAS: de quién vendimos cada producto y cuándo.
//
// Lo que hay que clavar es la VENTANA —dónde arranca, dónde termina, dónde pega el pico— y el
// CORRIMIENTO contra el año pasado, que es lo que se usa para decidir cuándo comprar. Un
// corrimiento mal calculado no se nota mirando el gráfico: las barras se ven bien igual, y el
// número de abajo dice que un proveedor arranca un mes antes de lo que arranca.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ventanasDeProducto, productosMasVendidos, ejeMeses } from '../src/servicios/ventanas.js';

const DDL = `CREATE TABLE sheet_ventas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente TEXT, vendedor TEXT, producto TEXT, proveedor TEXT,
  periodo TEXT, mes_ok TEXT, kilos_tot REAL, total REAL, tot_dol REAL, rent_dol REAL, rent REAL
)`;
const ACT = '2026-2027', ANT = '2025-2026';
const WHERE = "WHERE producto = 'CEBOLLA' AND periodo IN ('" + ACT + "','" + ANT + "')";
const WHERE_P = "WHERE producto = ? AND periodo IN (?,?)";
const PARAMS = ['CEBOLLA', ACT, ANT];
const OPTS = { periodo_actual: ACT, periodo_anterior: ANT };

function base(filas) {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const ins = db.prepare(`INSERT INTO sheet_ventas
    (cliente, producto, proveedor, periodo, mes_ok, kilos_tot, tot_dol)
    VALUES (?,?,?,?,?,?,?)`);
  for (const f of filas) ins.run(...f);
  return db;
}
// cliente, producto, proveedor, periodo, mes, kilos, usd
const F = [
  // GIGLIO: noviembre a enero, pico en diciembre
  ['C1', 'CEBOLLA', 'GIGLIO', ACT, '05-NOVIEMBRE', 1000, 5000],
  ['C1', 'CEBOLLA', 'GIGLIO', ACT, '06-DICIEMBRE', 4000, 20000],
  ['C2', 'CEBOLLA', 'GIGLIO', ACT, '07-ENERO',     1500, 7500],
  // El año pasado GIGLIO arrancaba en OCTUBRE: se corrió un mes más tarde
  ['C1', 'CEBOLLA', 'GIGLIO', ANT, '04-OCTUBRE',   1200, 6000],
  ['C1', 'CEBOLLA', 'GIGLIO', ANT, '05-NOVIEMBRE', 3000, 15000],
  // MEDINA: marzo a mayo, sin historia — es nuevo
  ['C1', 'CEBOLLA', 'MEDINA', ACT, '09-MARZO',      800, 4000],
  ['C3', 'CEBOLLA', 'MEDINA', ACT, '10-ABRIL',     2000, 9000],
  // ROMERO: sólo el año pasado — lo perdimos
  ['C1', 'CEBOLLA', 'ROMERO', ANT, '06-DICIEMBRE', 2500, 12000],
  // Otro producto, para que el filtro tenga algo que dejar afuera
  ['C1', 'PAPA',    'GIGLIO', ACT, '06-DICIEMBRE', 9000, 40000],
];

// ── LA VENTANA ────────────────────────────────────────────────────────────────────────
test('cada proveedor con su ventana: desde, hasta y el pico', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  const g = r.filas.find(x => x.proveedor === 'GIGLIO');
  assert.equal(g.desde, '05-NOVIEMBRE');
  assert.equal(g.hasta, '07-ENERO');
  assert.equal(g.pico, '06-DICIEMBRE');
  assert.equal(g.pico_kilos, 4000);
  assert.equal(g.meses_activo, 3);
});

test('el eje son los meses que hay, en orden comercial (julio primero)', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  assert.deepEqual(r.meses, ['04-OCTUBRE', '05-NOVIEMBRE', '06-DICIEMBRE', '07-ENERO', '09-MARZO', '10-ABRIL']);
  // Y sale ordenado por el número, no alfabéticamente: ENERO va después de DICIEMBRE.
  assert.ok(r.meses.indexOf('07-ENERO') > r.meses.indexOf('06-DICIEMBRE'));
});

test('el filtro del producto manda: la papa de GIGLIO no entra', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  const g = r.filas.find(x => x.proveedor === 'GIGLIO');
  assert.equal(g.kilos, 6500);              // 1000 + 4000 + 1500, sin los 9000 de papa
  assert.equal(r.total_kilos, 6500 + 2800); // GIGLIO + MEDINA
});

// ── EL CORRIMIENTO ────────────────────────────────────────────────────────────────────
test('dice cuántos meses se corrió el arranque contra el año pasado', () => {
  const g = ventanasDeProducto(base(F), WHERE, [], OPTS).filas.find(x => x.proveedor === 'GIGLIO');
  assert.equal(g.desde_prev, '04-OCTUBRE');
  assert.equal(g.corrimiento, 1);           // arrancó UN mes más tarde
});

test('sin ventana del año pasado NO se inventa un corrimiento', () => {
  // MEDINA es nuevo: "se corrió" no significa nada. Un cero acá se leería como "arrancó igual
  // que siempre", que es lo contrario de lo que pasa.
  const m = ventanasDeProducto(base(F), WHERE, [], OPTS).filas.find(x => x.proveedor === 'MEDINA');
  assert.equal(m.corrimiento, null);
  assert.equal(m.desde_prev, null);
  assert.equal(m.es_nuevo, true);
});

test('un proveedor que arrancó ANTES da corrimiento negativo', () => {
  const filas = [
    ['C1', 'CEBOLLA', 'X', ANT, '06-DICIEMBRE', 100, 500],
    ['C1', 'CEBOLLA', 'X', ACT, '04-OCTUBRE',   100, 500],
  ];
  const x = ventanasDeProducto(base(filas), WHERE, [], OPTS).filas[0];
  assert.equal(x.corrimiento, -2);
});

// ── EL QUE SE FUE ─────────────────────────────────────────────────────────────────────
test('el proveedor que sólo tiene historia se marca y va al final', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  const ro = r.filas.find(x => x.proveedor === 'ROMERO');
  assert.equal(ro.solo_anterior, true);
  assert.equal(ro.kilos, 0);
  assert.equal(ro.kilos_prev, 2500);
  assert.equal(r.filas[r.filas.length - 1].proveedor, 'ROMERO');
  // Y no ensucia el conteo de con cuántos estamos trabajando.
  assert.equal(r.proveedores, 2);
  assert.equal(r.proveedores_perdidos, 1);
});

test('los que trajeron van ordenados por volumen', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  assert.deepEqual(r.filas.map(x => x.proveedor), ['GIGLIO', 'MEDINA', 'ROMERO']);
});

// ── LOS NÚMEROS DE ARRIBA ─────────────────────────────────────────────────────────────
test('el share de cada proveedor suma 100', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  const suma = r.filas.filter(x => !x.solo_anterior).reduce((a, x) => a + x.share_pct, 0);
  assert.ok(Math.abs(suma - 100) < 0.2, 'suma ' + suma);
});

test('el mes pico del producto es el de más kilos entre todos los proveedores', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  assert.equal(r.pico_mes, '06-DICIEMBRE');
  assert.equal(r.pico_kilos, 4000);
  assert.equal(r.totales['06-DICIEMBRE'], 4000);
});

test('los totales por mes son la suma de las celdas de ese mes', () => {
  const filas = [
    ['C1', 'CEBOLLA', 'A', ACT, '06-DICIEMBRE', 1000, 100],
    ['C1', 'CEBOLLA', 'B', ACT, '06-DICIEMBRE',  500,  50],
  ];
  const r = ventanasDeProducto(base(filas), WHERE, [], OPTS);
  assert.equal(r.totales['06-DICIEMBRE'], 1500);
  assert.equal(r.pico_kilos, 1500);
});

test('la escala del gráfico sale de la celda más grande, no del total del mes', () => {
  // Con diez proveedores en el mismo mes, escalar contra el total dejaría todas las barras
  // aplastadas contra el piso y el gráfico no diría nada.
  const filas = [
    ['C1', 'CEBOLLA', 'A', ACT, '06-DICIEMBRE', 1000, 100],
    ['C1', 'CEBOLLA', 'B', ACT, '06-DICIEMBRE',  500,  50],
  ];
  const r = ventanasDeProducto(base(filas), WHERE, [], OPTS);
  assert.equal(r.max_celda, 1000);
  assert.notEqual(r.max_celda, r.totales['06-DICIEMBRE']);
});

test('la escala también mira la campaña anterior, para que el contorno entre', () => {
  const filas = [
    ['C1', 'CEBOLLA', 'A', ACT, '06-DICIEMBRE',  100, 10],
    ['C1', 'CEBOLLA', 'A', ANT, '06-DICIEMBRE', 9000, 900],
  ];
  assert.equal(ventanasDeProducto(base(filas), WHERE, [], OPTS).max_celda, 9000);
});

test('sin proveedor cargado se dice, no se inventa', () => {
  const filas = [['C1', 'CEBOLLA', '', ACT, '06-DICIEMBRE', 100, 10]];
  assert.equal(ventanasDeProducto(base(filas), WHERE, [], OPTS).filas[0].proveedor, '(sin proveedor)');
});

test('sin datos no explota', () => {
  const r = ventanasDeProducto(base([]), WHERE, [], OPTS);
  assert.deepEqual(r.filas, []);
  assert.deepEqual(r.meses, []);
  assert.equal(r.total_kilos, 0);
  assert.equal(r.max_celda, 0);
  assert.equal(r.pico_mes, null);
});

test('sin campaña anterior elegida, sigue andando y no marca corrimientos', () => {
  const r = ventanasDeProducto(base(F), "WHERE producto = 'CEBOLLA' AND periodo = '" + ACT + "'", [],
    { periodo_actual: ACT });
  const g = r.filas.find(x => x.proveedor === 'GIGLIO');
  assert.equal(g.corrimiento, null);
  assert.equal(g.kilos, 6500);
  assert.ok(!r.filas.some(x => x.proveedor === 'ROMERO'), 'trajo un proveedor de otra campaña');
});

// ── EL SELECTOR DE PRODUCTOS ──────────────────────────────────────────────────────────
test('ofrece los productos más vendidos, con cuántos proveedores tiene cada uno', () => {
  const r = productosMasVendidos(base(F), "WHERE periodo IN ('" + ACT + "','" + ANT + "')", [], 10);
  assert.equal(r[0].producto, 'CEBOLLA');   // 12.000 kg contra 9.000 de papa
  assert.equal(r[0].proveedores, 3);
  assert.equal(r[1].producto, 'PAPA');
});

// ── LAS DOS TRAMPAS DE SQLITE ─────────────────────────────────────────────────────────
test('con el WHERE parametrizado da EXACTAMENTE lo mismo que con los valores escritos', () => {
  const a = ventanasDeProducto(base(F), WHERE, [], OPTS);
  const b = ventanasDeProducto(base(F), WHERE_P, PARAMS, OPTS);
  assert.equal(JSON.stringify(b), JSON.stringify(a));
  assert.ok(a.filas.length > 0);
  assert.deepEqual(ejeMeses(base(F), WHERE_P, PARAMS), ejeMeses(base(F), WHERE, []));
});

test('ningún alias del SQL se llama como una columna de sheet_ventas', () => {
  const src = readFileSync(new URL('../src/servicios/ventanas.js', import.meta.url), 'utf8');
  const sql = [...src.matchAll(/db\.prepare\(`([\s\S]*?)`\)/g)].map(m => m[1]).join('\n');
  const columnas = ['rent', 'total', 'cantidad', 'precio', 'des', 'pct', 'boni', 'partida', 'sem', 'mes', 'anio'];
  const alias = [...sql.matchAll(/\bAS\s+(\w+)/gi)].map(m => m[1].toLowerCase());
  assert.deepEqual(alias.filter(a => columnas.includes(a)), []);
});

test('el WHERE va siempre en un WITH base al principio', () => {
  const src = readFileSync(new URL('../src/servicios/ventanas.js', import.meta.url), 'utf8');
  for (const m of src.matchAll(/db\.prepare\(`([\s\S]*?)`\)/g)) {
    const q = m[1];
    if (!q.includes('${where}')) continue;
    assert.equal(q.slice(0, q.indexOf('${where}')).includes('?'), false,
      'hay un ? antes del ${where} en:\n' + q.trim().slice(0, 200));
  }
});
