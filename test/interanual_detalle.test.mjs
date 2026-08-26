// El detalle por producto y el de los clientes perdidos.
//
// Lo delicado acá es el PROVEEDOR. `sheet_ventas.proveedor` es el origen de la mercadería de
// la línea de venta, no una operación de compra: "le dejamos de comprar a X" quiere decir
// "dejó de aparecer mercadería suya en lo que vendimos ese mes". El test clava esa lectura,
// incluido el caso que más se malinterpreta: cuando un proveedor se fue porque OTRO lo
// reemplazó, que es un cambio de origen y no un faltante.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { detallePorProducto, detalleClientesPerdidos } from '../src/servicios/interanualDetalle.js';

const DDL = `CREATE TABLE sheet_ventas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente TEXT, cate_clie TEXT, vendedor TEXT, producto TEXT, categoria TEXT, proveedor TEXT,
  periodo TEXT, mes_ok TEXT, kilos_tot REAL, total REAL, tot_dol REAL, rent_dol REAL, rent REAL
)`;
const ACT = '2026-2027', ANT = '2025-2026';
const V = { actual: ACT, anterior: ANT, mes: '02-AGOSTO', mesTexto: 'AGOSTO' };
const WHERE = "WHERE periodo IN ('" + ACT + "','" + ANT + "') AND mes_ok = '02-AGOSTO'";
// El que manda el router: con `?`. Es el que destapó los dos bugs silenciosos del radar.
const WHERE_P = "WHERE periodo IS NOT NULL AND periodo <> '' AND periodo IN (?,?) AND mes_ok = ?";
const PARAMS = [ACT, ANT, '02-AGOSTO'];

function base(filas) {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const ins = db.prepare(`INSERT INTO sheet_ventas
    (cliente, vendedor, producto, proveedor, periodo, mes_ok, kilos_tot, tot_dol, rent_dol)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const f of filas) ins.run(...f);
  return db;
}
// cliente, vendedor, producto, proveedor, periodo, kilos, usd, rent
const F = [
  // CEBOLLA: COTO se fue del todo, INC compra la mitad, y el proveedor GIGLIO desapareció
  ['COTO', 'ANA',  'CEBOLLA', 'GIGLIO',    ANT, '02-AGOSTO', 3000, 30000, 3000],
  ['INC',  'ANA',  'CEBOLLA', 'GIGLIO',    ANT, '02-AGOSTO', 2000, 20000, 2000],
  ['INC',  'ANA',  'CEBOLLA', 'EXPOVERDE', ACT, '02-AGOSTO',  900,  9000,  900],
  ['S1',   'BETO', 'CEBOLLA', 'EXPOVERDE', ACT, '02-AGOSTO', 1000, 10000, 1000],
  // PAPA: sin cambios de proveedor, y un cliente que baja poco (no llega al umbral)
  ['INC',  'ANA',  'PAPA',    'MEDINA',    ANT, '02-AGOSTO', 1000, 12000, 1200],
  ['INC',  'ANA',  'PAPA',    'MEDINA',    ACT, '02-AGOSTO',  950, 11400, 1140],
  // COTO además llevaba TOMATE de otro proveedor: entra en su detalle de cliente perdido
  ['COTO', 'ANA',  'TOMATE',  'ROMERO',    ANT, '02-AGOSTO',  500,  7000,  700],
];

// ── POR PRODUCTO ──────────────────────────────────────────────────────────────────────
test('los productos se ordenan por cuánto se movieron, no por cuánto facturan', () => {
  const r = detallePorProducto(base(F), WHERE, [], V, { tope: 10 });
  // CEBOLLA se movió 50.000 → 19.000 (−31.000). PAPA casi no se movió (−600), aunque factura.
  assert.equal(r[0].producto, 'CEBOLLA');
  assert.equal(r[0].var_usd, -31000);
  assert.ok(Math.abs(r[0].var_usd) > Math.abs(r[1].var_usd));
});

test('dice a qué cliente le dejamos de vender ese producto', () => {
  const ceb = detallePorProducto(base(F), WHERE, [], V, { tope: 10 })[0];
  assert.deepEqual(ceb.clientes_perdidos.map(x => x.cliente), ['COTO']);
  assert.equal(ceb.clientes_perdidos[0].usd_ant, 30000);
  assert.equal(ceb.clientes_perdidos[0].kg_ant, 3000);
});

test('y a cuál le vendemos bastante menos, con cuánto menos', () => {
  const ceb = detallePorProducto(base(F), WHERE, [], V, { tope: 10 })[0];
  assert.deepEqual(ceb.clientes_menos.map(x => x.cliente), ['INC']);
  assert.equal(ceb.clientes_menos[0].usd_ant, 20000);
  assert.equal(ceb.clientes_menos[0].usd_act, 9000);
  assert.equal(ceb.clientes_menos[0].caida_pct, -55);
});

test('el que baja poco NO entra: una baja del 5% no es una noticia', () => {
  const papa = detallePorProducto(base(F), WHERE, [], V, { tope: 10 }).find(p => p.producto === 'PAPA');
  assert.deepEqual(papa.clientes_menos, []);
  assert.deepEqual(papa.clientes_perdidos, []);
});

test('el cliente NUEVO no aparece como pérdida', () => {
  // S1 sólo compró este año: no tiene con qué comparar y no es una caída.
  const ceb = detallePorProducto(base(F), WHERE, [], V, { tope: 10 })[0];
  const nombres = [...ceb.clientes_perdidos, ...ceb.clientes_menos].map(x => x.cliente);
  assert.ok(!nombres.includes('S1'), JSON.stringify(nombres));
});

// ── EL PROVEEDOR ──────────────────────────────────────────────────────────────────────
test('dice de qué proveedor dejó de venir la mercadería de ese producto', () => {
  const ceb = detallePorProducto(base(F), WHERE, [], V, { tope: 10 })[0];
  assert.deepEqual(ceb.proveedores_perdidos.map(x => x.proveedor), ['GIGLIO']);
  assert.equal(ceb.proveedores_perdidos[0].usd_ant, 50000);
});

test('y con quién se está trabajando ahora — porque muchas veces es un REEMPLAZO', () => {
  // Sin esto, "dejamos de comprarle a GIGLIO" se lee como un faltante. Con EXPOVERDE al lado
  // se ve que la mercadería siguió viniendo, de otro lado: son dos conversaciones distintas.
  const ceb = detallePorProducto(base(F), WHERE, [], V, { tope: 10 })[0];
  assert.deepEqual(ceb.proveedores_hoy.map(x => x.proveedor), ['EXPOVERDE']);
  assert.equal(ceb.proveedores_hoy[0].es_nuevo, true);
});

test('un proveedor que sigue no se marca como nuevo', () => {
  const papa = detallePorProducto(base(F), WHERE, [], V, { tope: 10 }).find(p => p.producto === 'PAPA');
  assert.deepEqual(papa.proveedores_hoy.map(x => x.proveedor), ['MEDINA']);
  assert.equal(papa.proveedores_hoy[0].es_nuevo, false);
  assert.deepEqual(papa.proveedores_perdidos, []);
});

// ── CLIENTES PERDIDOS EN DETALLE ──────────────────────────────────────────────────────
test('el cliente que se fue, abierto en qué llevaba y de qué proveedor era', () => {
  const r = detalleClientesPerdidos(base(F), WHERE, [], V, { tope: 10 });
  assert.deepEqual(r.map(x => x.cliente), ['COTO']);
  const c = r[0];
  assert.equal(c.usd, 37000);           // 30.000 de cebolla + 7.000 de tomate
  assert.equal(c.kg, 3500);
  assert.equal(c.vendedor, 'ANA');      // a quién preguntarle qué pasó
  assert.deepEqual(c.lineas.map(l => l.producto + '/' + l.proveedor), ['CEBOLLA/GIGLIO', 'TOMATE/ROMERO']);
  assert.equal(c.lineas[0].usd, 30000);
});

test('las líneas van de mayor a menor: lo primero que se mira es lo que más pesaba', () => {
  const c = detalleClientesPerdidos(base(F), WHERE, [], V, { tope: 10 })[0];
  const usds = c.lineas.map(l => l.usd);
  assert.deepEqual(usds, [...usds].sort((a, b) => b - a));
});

test('el que sigue comprando no entra, aunque compre mucho menos', () => {
  const r = detalleClientesPerdidos(base(F), WHERE, [], V, { tope: 10 });
  assert.ok(!r.map(x => x.cliente).includes('INC'), JSON.stringify(r.map(x => x.cliente)));
});

test('sin proveedor cargado se dice, no se inventa', () => {
  const filas = [['X', 'ANA', 'UVA', '', ANT, '02-AGOSTO', 100, 5000, 500]];
  const c = detalleClientesPerdidos(base(filas), WHERE, [], V, { tope: 10 })[0];
  assert.equal(c.lineas[0].proveedor, '(sin proveedor)');
});

test('lo chico no entra: es ruido', () => {
  const filas = [['MIGAJA', 'ANA', 'UVA', 'P', ANT, '02-AGOSTO', 5, 50, 5]];
  assert.deepEqual(detalleClientesPerdidos(base(filas), WHERE, [], V, {}), []);
});

test('sin datos devuelve listas vacías, no explota', () => {
  assert.deepEqual(detallePorProducto(base([]), WHERE, [], V, {}), []);
  assert.deepEqual(detalleClientesPerdidos(base([]), WHERE, [], V, {}), []);
});

// ── LAS DOS TRAMPAS DE SQLITE, OTRA VEZ ───────────────────────────────────────────────
test('con el WHERE parametrizado da EXACTAMENTE lo mismo que con los valores escritos', () => {
  // El router manda el WHERE con `?`. Si el orden de los parámetros no coincide con el orden
  // de los `?` en el TEXTO, SQLite no da error: devuelve otra cosa. Ya pasó en el radar.
  const a = detallePorProducto(base(F), WHERE, [], V, { tope: 10 });
  const b = detallePorProducto(base(F), WHERE_P, PARAMS, V, { tope: 10 });
  assert.equal(JSON.stringify(b), JSON.stringify(a));
  assert.ok(a.length > 0, 'ni siquiera con el WHERE inline devolvió algo');

  const c = detalleClientesPerdidos(base(F), WHERE, [], V, { tope: 10 });
  const d = detalleClientesPerdidos(base(F), WHERE_P, PARAMS, V, { tope: 10 });
  assert.equal(JSON.stringify(d), JSON.stringify(c));
  assert.ok(c.length > 0);
});

test('ningún alias del SQL se llama como una columna de sheet_ventas', () => {
  // `rent` y `pct` EXISTEN en la tabla. Un alias con ese nombre en un HAVING mira la columna
  // —vacía— y no la suma: no da error y no devuelve nada nunca.
  const src = readFileSync(new URL('../src/servicios/interanualDetalle.js', import.meta.url), 'utf8');
  const sql = [...src.matchAll(/db\.prepare\(`([\s\S]*?)`\)/g)].map(m => m[1]).join('\n');
  const columnas = ['rent', 'total', 'cantidad', 'precio', 'des', 'pct', 'boni', 'partida', 'sem', 'mes', 'anio'];
  const alias = [...sql.matchAll(/\bAS\s+(\w+)/gi)].map(m => m[1].toLowerCase());
  assert.deepEqual(alias.filter(a => columnas.includes(a)), []);
});

test('el WHERE va siempre en un WITH base al principio', () => {
  const src = readFileSync(new URL('../src/servicios/interanualDetalle.js', import.meta.url), 'utf8');
  for (const m of src.matchAll(/db\.prepare\(`([\s\S]*?)`\)/g)) {
    const q = m[1];
    if (!q.includes('${where}')) continue;
    assert.equal(q.slice(0, q.indexOf('${where}')).includes('?'), false,
      'hay un ? antes del ${where} en:\n' + q.trim().slice(0, 200));
  }
});
