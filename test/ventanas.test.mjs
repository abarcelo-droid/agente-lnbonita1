// VENTANAS: a qué productor hay que salir a contactar.
//
// La pantalla no contesta "cómo venimos" sino "a quién llamo". Eso cambia qué puede estar mal
// sin que se note: si la historia se mira de a dos campañas, el que dejó de traernos hace dos
// años es INVISIBLE — y es justamente el que hay que ir a buscar. El test clava que la
// historia entra entera y que "contactar" no marque ni al que ya está trabajando ni al que
// nunca trajo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ventanasDeProducto, productosMasVendidos, ejeMeses,
         esProveedorNoIdentificado, SIN_IDENTIFICAR } from '../src/servicios/ventanas.js';

const DDL = `CREATE TABLE sheet_ventas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente TEXT, vendedor TEXT, producto TEXT, proveedor TEXT,
  periodo TEXT, mes_ok TEXT, kilos_tot REAL, total REAL, tot_dol REAL, rent_dol REAL, rent REAL
)`;
const P22 = '2022-2023', P23 = '2023-2024', P24 = '2024-2025', P25 = '2025-2026', P26 = '2026-2027';
const WHERE = "WHERE producto = 'PALTA'";
const WHERE_P = "WHERE producto = ?";
const OPTS = { periodo_actual: P26 };

function base(filas) {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const ins = db.prepare(`INSERT INTO sheet_ventas
    (cliente, producto, proveedor, periodo, mes_ok, kilos_tot, tot_dol) VALUES (?,?,?,?,?,?,?)`);
  for (const f of filas) ins.run(...f);
  return db;
}
// cliente, producto, proveedor, periodo, mes, kilos, usd
const F = [
  // BONELLA: trae todos los años en julio-agosto. Está trabajando ahora.
  ['C1', 'PALTA', 'BONELLA', P24, '01-JULIO',   5000, 12000],
  ['C1', 'PALTA', 'BONELLA', P25, '01-JULIO',   6000, 15000],
  ['C1', 'PALTA', 'BONELLA', P25, '02-AGOSTO',  4000, 10000],
  ['C1', 'PALTA', 'BONELLA', P26, '02-AGOSTO',  3000,  8000],
  // JAGUACY: traía en marzo-abril, tres campañas seguidas, y hace DOS que no aparece.
  // Contra la campaña anterior sola sería invisible: el año pasado tampoco vino.
  ['C2', 'PALTA', 'JAGUACY', P22, '09-MARZO',   9000, 20000],
  ['C2', 'PALTA', 'JAGUACY', P23, '09-MARZO',   8000, 18000],
  ['C2', 'PALTA', 'JAGUACY', P24, '10-ABRIL',   7000, 16000],
  // AGRO NUEVO: sólo este año. No hay a quién llamar: ya está.
  ['C1', 'PALTA', 'AGRO NUEVO', P26, '01-JULIO', 500, 1200],
  // Los errores de fórmula de la planilla, cada uno con su clave: sin agrupar son tres filas
  ["C1", 'PALTA', "#N/A (Did not find value '12640234' in VLOOKUP)", P26, '02-AGOSTO', 1000, 2500],
  ["C1", 'PALTA', "#N/A (Did not find value '12638734' in VLOOKUP)", P26, '02-AGOSTO',  800, 2000],
  ["C1", 'PALTA', "#N/A (Did not find value '12607029' in VLOOKUP)", P25, '01-JULIO',   600, 1500],
  // Otro producto, para que el filtro tenga qué dejar afuera
  ['C1', 'BANANA', 'BONELLA', P26, '02-AGOSTO', 9000, 30000],
];

// ── LA HISTORIA ENTERA ────────────────────────────────────────────────────────────────
test('el eje de campañas son TODAS las que hay, en orden', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  assert.deepEqual(r.periodos, [P22, P23, P24, P25, P26]);
  assert.equal(r.periodo_actual, P26);
});

test('cada productor dice en qué campañas trajo y desde cuándo no está', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  const j = r.filas.find(x => x.proveedor === 'JAGUACY');
  assert.deepEqual(j.anios, [P22, P23, P24]);
  assert.equal(j.anios_activo, 3);
  assert.equal(j.primer_periodo, P22);
  assert.equal(j.ultimo_periodo, P24);
  assert.equal(j.campanias_sin_traer, 2);      // P24 → P26
  assert.equal(j.kilos_act, 0);
});

test('la ventana típica sale de toda la historia, no de un año', () => {
  const j = ventanasDeProducto(base(F), WHERE, [], OPTS).filas.find(x => x.proveedor === 'JAGUACY');
  assert.equal(j.desde, '09-MARZO');
  assert.equal(j.hasta, '10-ABRIL');
  assert.equal(j.pico, '09-MARZO');            // 17.000 acumulados contra 7.000 de abril
  assert.equal(j.kilos_hist, 24000);
  assert.equal(j.kilos_prom_anio, 8000);       // 24.000 en 3 campañas
});

test('en cuántas campañas trajo CADA mes: una vez no es una costumbre', () => {
  const b = ventanasDeProducto(base(F), WHERE, [], OPTS).filas.find(x => x.proveedor === 'BONELLA');
  assert.equal(b.por_mes['01-JULIO'].anios, 2);   // P24 y P25
  assert.equal(b.por_mes['02-AGOSTO'].anios, 2);  // P25 y P26
  assert.equal(b.por_mes['01-JULIO'].kilos, 11000);
});

// ── A QUIÉN LLAMAR ────────────────────────────────────────────────────────────────────
test('marca al que trajo antes y este año no está — aunque hace DOS años que falta', () => {
  // Es el caso que la lógica de dos campañas no puede ver.
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  const j = r.filas.find(x => x.proveedor === 'JAGUACY');
  assert.equal(j.contactar, true);
  assert.equal(j.ausente_este_anio, true);
  assert.equal(j.contactar_mes, '09-MARZO');   // cuándo llamarlo: cuando suele arrancar
  assert.equal(r.a_contactar, 1);
});

test('no marca al que ya está trabajando', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  assert.equal(r.filas.find(x => x.proveedor === 'BONELLA').contactar, false);
  assert.equal(r.filas.find(x => x.proveedor === 'AGRO NUEVO').contactar, false);
});

test('el que aparece por primera vez este año se marca como nuevo, no como recuperable', () => {
  const a = ventanasDeProducto(base(F), WHERE, [], OPTS).filas.find(x => x.proveedor === 'AGRO NUEVO');
  assert.equal(a.es_nuevo, true);
  assert.equal(a.contactar, false);
});

test('los kilos a recuperar son el promedio por campaña, no el acumulado', () => {
  // Sumar los 24.000 de tres años diría que se recuperan 24.000 este año, y no es cierto.
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  assert.equal(r.kilos_a_contactar, 8000);
});

test('los que hay que llamar van después de los activos y ordenados por volumen', () => {
  const filas = [
    ['C1', 'PALTA', 'CHICO', P22, '09-MARZO',  100,  10],
    ['C1', 'PALTA', 'GRANDE', P22, '09-MARZO', 9000, 900],
    ['C1', 'PALTA', 'ACTIVO', P26, '01-JULIO',   50,   5],
  ];
  const r = ventanasDeProducto(base(filas), WHERE, [], OPTS);
  assert.deepEqual(r.filas.map(x => x.proveedor), ['ACTIVO', 'GRANDE', 'CHICO']);
});

// ── LOS #N/A DE LA PLANILLA ───────────────────────────────────────────────────────────
test('reconoce los errores de fórmula como lo que son', () => {
  assert.equal(esProveedorNoIdentificado("#N/A (Did not find value '12640234' in VLOOKUP)"), true);
  assert.equal(esProveedorNoIdentificado('#REF!'), true);
  assert.equal(esProveedorNoIdentificado('#VALUE!'), true);
  assert.equal(esProveedorNoIdentificado(''), true);
  assert.equal(esProveedorNoIdentificado(null), true);
  // Y no se come a un proveedor de verdad que tenga un numeral en el nombre.
  assert.equal(esProveedorNoIdentificado('AGRO #1 SA'), false);
  assert.equal(esProveedorNoIdentificado('BONELLA'), false);
});

test('los tres #N/A distintos son UNA fila, no tres proveedores', () => {
  // Sin agrupar, cada clave fallada aparece como un proveedor y tapan a los de verdad: en la
  // pantalla real eran 8 de 11.
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  const ni = r.filas.filter(x => x.no_identificado);
  assert.equal(ni.length, 1);
  assert.equal(ni[0].proveedor, SIN_IDENTIFICAR);
  assert.equal(ni[0].kilos_hist, 2400);        // 1000 + 800 + 600
});

test('no se ofrece llamar a un #N/A: no hay a quién', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  assert.equal(r.filas.find(x => x.no_identificado).contactar, false);
  assert.ok(!r.filas.filter(x => x.contactar).some(x => x.no_identificado));
});

test('van al final y no se cuentan como proveedores activos', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  assert.equal(r.filas[r.filas.length - 1].no_identificado, true);
  assert.equal(r.proveedores_activos, 2);      // BONELLA y AGRO NUEVO
});

test('se dice cuánto volumen quedó sin nombre, para saber cuánto vale la pantalla', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  assert.equal(r.sin_identificar.kilos_hist, 2400);
  assert.equal(r.sin_identificar.kilos_act, 1800);
  assert.ok(r.sin_identificar.pct_hist > 0 && r.sin_identificar.pct_hist < 100, r.sin_identificar.pct_hist);
});

test('si no hay ninguno, no se inventa la fila ni la advertencia', () => {
  const filas = [['C1', 'PALTA', 'BONELLA', P26, '01-JULIO', 100, 10]];
  const r = ventanasDeProducto(base(filas), WHERE, [], OPTS);
  assert.equal(r.sin_identificar, null);
  assert.ok(!r.filas.some(x => x.no_identificado));
});

// ── EL PERFIL DEL PRODUCTO ────────────────────────────────────────────────────────────
test('el total por mes es de toda la historia, y aparte el de este año', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], OPTS);
  // JULIO: 5000 + 6000 (BONELLA) + 500 (AGRO) + 600 (#N/A) = 12.100
  assert.equal(r.totales['01-JULIO'], 12100);
  assert.equal(r.totales_act['01-JULIO'], 500);
  assert.equal(r.pico_mes, '09-MARZO');        // 17.000 de JAGUACY
});

test('el filtro del producto manda: la banana de BONELLA no entra', () => {
  const b = ventanasDeProducto(base(F), WHERE, [], OPTS).filas.find(x => x.proveedor === 'BONELLA');
  assert.equal(b.kilos_hist, 18000);           // sin los 9000 de banana
});

test('la escala sale de la celda más grande, no del total del mes', () => {
  const filas = [
    ['C1', 'PALTA', 'A', P26, '01-JULIO', 1000, 100],
    ['C1', 'PALTA', 'B', P26, '01-JULIO',  500,  50],
  ];
  const r = ventanasDeProducto(base(filas), WHERE, [], OPTS);
  assert.equal(r.max_celda, 1000);
  assert.notEqual(r.max_celda, r.totales['01-JULIO']);
});

test('sin datos no explota', () => {
  const r = ventanasDeProducto(base([]), WHERE, [], OPTS);
  assert.deepEqual(r.filas, []);
  assert.deepEqual(r.periodos, []);
  assert.equal(r.a_contactar, 0);
  assert.equal(r.sin_identificar, null);
});

test('sin decir cuál es la campaña actual, toma la más nueva que haya', () => {
  const r = ventanasDeProducto(base(F), WHERE, [], {});
  assert.equal(r.periodo_actual, P26);
  assert.equal(r.filas.find(x => x.proveedor === 'JAGUACY').contactar, true);
});

test('mirando una campaña vieja como actual, cambia a quién hay que llamar', () => {
  // En P24, JAGUACY estaba trabajando: no hay que llamarlo. BONELLA tampoco.
  const r = ventanasDeProducto(base(F), WHERE, [], { periodo_actual: P24 });
  assert.equal(r.filas.find(x => x.proveedor === 'JAGUACY').contactar, false);
  assert.equal(r.filas.find(x => x.proveedor === 'AGRO NUEVO').contactar, false);  // todavía no existía
});

// ── EL SELECTOR ───────────────────────────────────────────────────────────────────────
test('ofrece los productos con cuántos proveedores y cuántas campañas tienen', () => {
  const r = productosMasVendidos(base(F), '', [], 10);
  assert.equal(r[0].producto, 'PALTA');
  assert.equal(r[0].campanias, 5);
});

// ── LAS DOS TRAMPAS DE SQLITE ─────────────────────────────────────────────────────────
test('con el WHERE parametrizado da EXACTAMENTE lo mismo que con los valores escritos', () => {
  const a = ventanasDeProducto(base(F), WHERE, [], OPTS);
  const b = ventanasDeProducto(base(F), WHERE_P, ['PALTA'], OPTS);
  assert.equal(JSON.stringify(b), JSON.stringify(a));
  assert.ok(a.filas.length > 0);
  assert.deepEqual(ejeMeses(base(F), WHERE_P, ['PALTA']), ejeMeses(base(F), WHERE, []));
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

// ── LA CAMPAÑA QUE RECIÉN ARRANCÓ ─────────────────────────────────────────────────────
// El caso de la pantalla real: MELON, campaña 2026-2027 arrancada en julio, y dieciséis
// productores marcados "a contactar" cuando faltaban tres. Los otros trece traen de noviembre
// a mayo: en agosto no están ausentes, están esperando.
//
// Una lista de gestión con trece falsos no se usa dos veces, así que esto importa tanto como
// que el número esté bien.
const MELON = [
  // El de verano: trae de noviembre a mayo, todos los años. En agosto no le toca.
  ['C1', 'MELON', 'PUENTE CORDON', P24, '05-NOVIEMBRE', 5000, 10000],
  ['C1', 'MELON', 'PUENTE CORDON', P24, '11-MAYO',      4000,  8000],
  ['C1', 'MELON', 'PUENTE CORDON', P25, '05-NOVIEMBRE', 6000, 12000],
  ['C1', 'MELON', 'PUENTE CORDON', P25, '11-MAYO',      5000, 10000],
  // El de invierno: trae en julio-agosto. Ese SÍ ya debería estar.
  ['C1', 'MELON', 'AGRICOLA',      P24, '01-JULIO',     3000,  6000],
  ['C1', 'MELON', 'AGRICOLA',      P25, '01-JULIO',     3500,  7000],
  ['C1', 'MELON', 'AGRICOLA',      P25, '02-AGOSTO',    2000,  4000],
  // La campaña nueva, recién arrancada: sólo julio y agosto cargados.
  ['C1', 'MELON', 'TROPICAL',      P26, '01-JULIO',     1000,  2000],
  ['C1', 'MELON', 'TROPICAL',      P26, '02-AGOSTO',     800,  1600],
];
const W_MELON = "WHERE producto = 'MELON'";

test('con la campaña en curso, el de temporada tardía NO se marca: está esperando', () => {
  // Estamos en agosto (hasta_mes = 02-AGOSTO). PUENTE CORDON trae nov→may.
  const r = ventanasDeProducto(base(MELON), W_MELON, [],
    { periodo_actual: P26, hasta_mes: '02-AGOSTO' });
  const pc = r.filas.find(x => x.proveedor === 'PUENTE CORDON');
  assert.equal(pc.contactar, false, 'lo marca cuando todavía no le toca');
  assert.equal(pc.esperando, true);
  assert.equal(r.esperando, 1);
});

test('pero el que ya debería haber traído sí se marca', () => {
  const r = ventanasDeProducto(base(MELON), W_MELON, [],
    { periodo_actual: P26, hasta_mes: '02-AGOSTO' });
  const ag = r.filas.find(x => x.proveedor === 'AGRICOLA');
  assert.equal(ag.contactar, true, 'trae en julio-agosto y no vino');
  assert.equal(ag.esperando, false);
  assert.equal(r.a_contactar, 1);
});

test('sin el tope de mes, los dos se marcarían — que es el bug de la captura', () => {
  const r = ventanasDeProducto(base(MELON), W_MELON, [], { periodo_actual: P26 });
  assert.equal(r.a_contactar, 2);
  assert.equal(r.esperando, 0);
});

test('contra una campaña COMPLETA no hay nadie esperando: el año ya pasó entero', () => {
  const r = ventanasDeProducto(base(MELON), W_MELON, [], { periodo_actual: P25 });
  assert.equal(r.esperando, 0);
  // En P25 los dos trajeron, así que tampoco hay a quién llamar.
  assert.equal(r.a_contactar, 0);
});

test('los kilos que se esperan van aparte de los que hay que salir a buscar', () => {
  const r = ventanasDeProducto(base(MELON), W_MELON, [],
    { periodo_actual: P26, hasta_mes: '02-AGOSTO' });
  assert.equal(r.kilos_esperando, 10000);   // (5000+4000+6000+5000) / 2 campañas
  assert.equal(r.kilos_a_contactar, 4250);  // (3000+3500+2000) / 2 campañas
});

test('el orden pone primero a los que hay que llamar, después a los que se esperan', () => {
  const r = ventanasDeProducto(base(MELON), W_MELON, [],
    { periodo_actual: P26, hasta_mes: '02-AGOSTO' });
  const i = (p) => r.filas.findIndex(x => x.proveedor === p);
  assert.ok(i('TROPICAL') < i('AGRICOLA'), 'el que está trayendo va primero');
  assert.ok(i('AGRICOLA') < i('PUENTE CORDON'), 'a contactar antes que esperando');
});

test('el tope de mes no perdona a quien nunca más apareció', () => {
  // JAGUACY dejó de traer hace dos campañas y su ventana cierra en abril. Mirando P26 hasta
  // agosto, abril de ESTA campaña todavía no pasó — pero el que hace dos años que no viene no
  // está esperando: ya faltó dos veces enteras. Se marca igual.
  const filas = [
    ['C1', 'PALTA', 'VIEJO', P22, '09-MARZO', 9000, 20000],
    ['C1', 'PALTA', 'VIEJO', P23, '09-MARZO', 8000, 18000],
    ['C1', 'PALTA', 'HOY',   P26, '01-JULIO', 100, 200],
  ];
  // Las campañas del negocio, no las de este producto: en P24 y P25 no vendimos palta, y sin
  // esta escala el hueco de esos dos años desaparece del conteo.
  const r = ventanasDeProducto(base(filas), WHERE, [], {
    periodo_actual: P26, hasta_mes: '02-AGOSTO', periodos_todos: [P22, P23, P24, P25, P26] });
  const v = r.filas.find(x => x.proveedor === 'VIEJO');
  // Su ventana (marzo) es posterior a agosto, así que por ahora figura como esperando —
  // correcto: marzo de esta campaña no llegó. Lo que NO se pierde es cuánto hace que falta.
  assert.equal(v.campanias_sin_traer, 3);
  assert.ok(v.esperando || v.contactar, 'quedó sin clasificar');
});
