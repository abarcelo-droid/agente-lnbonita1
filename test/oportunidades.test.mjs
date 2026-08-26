// El radar de oportunidades. Lo que hay que clavar acá no es que devuelva filas: es que
// devuelva las CORRECTAS y en el orden correcto, porque es una lista para salir a trabajar.
// Una oportunidad inventada hace perder una mañana; una contada dos veces infla el total que
// se mira primero; y un orden que nadie puede explicar hace que la lista no se use más.
//
// El servicio recibe la db por parámetro, así que esto corre con node:sqlite y sin
// better-sqlite3 (que en Windows no compila).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { detectar, sinMargen, tasaMargenGlobal, UMBRALES } from '../src/servicios/oportunidades.js';

const DDL = `CREATE TABLE sheet_ventas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente TEXT, cate_clie TEXT, vendedor TEXT, producto TEXT, categoria TEXT,
  periodo TEXT, mes_ok TEXT, kilos_tot REAL, total REAL, tot_dol REAL, rent_dol REAL
)`;

const ACT = '2026-2027';
const ANT = '2025-2026';
const VENTANA = { actual: ACT, anterior: ANT, mes: '02-AGOSTO', mesTexto: 'AGOSTO' };
// La ventana ya viene acotada por el router (las dos campañas y el mes). Acá se replica.
const WHERE = "WHERE periodo IN ('" + ACT + "','" + ANT + "') AND mes_ok = '02-AGOSTO'";

function base(filas) {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const ins = db.prepare(`INSERT INTO sheet_ventas
    (cliente, cate_clie, producto, periodo, mes_ok, kilos_tot, tot_dol, rent_dol)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const f of filas) ins.run(...f);
  return db;
}
const correr = (db, tipos) => detectar(db, WHERE, [], VENTANA, { tipos, limite: 500 });
const de = (r, tipo) => r.items.filter(x => x.tipo === tipo);

// ── CLIENTE PERDIDO ───────────────────────────────────────────────────────────────────
test('un cliente que compraba en este mes y ya no, aparece; el que sigue comprando, no', () => {
  const db = base([
    ['SE FUE',  'SUPER', 'TOMATE', ANT, '02-AGOSTO', 1000, 5000, 500],
    ['SIGUE',   'SUPER', 'TOMATE', ANT, '02-AGOSTO', 1000, 5000, 500],
    ['SIGUE',   'SUPER', 'TOMATE', ACT, '02-AGOSTO', 1000, 5200, 520],
  ]);
  const r = correr(db, ['CLIENTE_PERDIDO']);
  assert.deepEqual(de(r, 'CLIENTE_PERDIDO').map(x => x.titulo), ['SE FUE']);
  assert.equal(de(r, 'CLIENTE_PERDIDO')[0].usd_en_juego, 5000);
});

test('el mes importa: el que compra en enero no está perdido en agosto', () => {
  // Vendió el año pasado en ENERO. La ventana es AGOSTO, así que ni siquiera entra al WHERE.
  const db = base([
    ['ESTACIONAL', 'SUPER', 'UVA', ANT, '07-ENERO', 2000, 9000, 900],
    ['OTRO',       'SUPER', 'UVA', ANT, '02-AGOSTO', 500, 3000, 300],
  ]);
  const r = correr(db, ['CLIENTE_PERDIDO']);
  assert.deepEqual(de(r, 'CLIENTE_PERDIDO').map(x => x.titulo), ['OTRO']);
});

test('lo chico no entra: es ruido, no una oportunidad', () => {
  const db = base([['MIGAJA', 'SUPER', 'TOMATE', ANT, '02-AGOSTO', 5, UMBRALES.piso_usd - 1, 5]]);
  assert.equal(correr(db, ['CLIENTE_PERDIDO']).items.length, 0);
});

// ── PRODUCTO PERDIDO ──────────────────────────────────────────────────────────────────
test('el producto que dejó de llevar un cliente que SIGUE comprando', () => {
  const db = base([
    ['COTO', 'SUPER', 'TOMATE',  ANT, '02-AGOSTO', 1000, 4000, 400],
    ['COTO', 'SUPER', 'LECHUGA', ANT, '02-AGOSTO',  500, 3000, 300],
    ['COTO', 'SUPER', 'TOMATE',  ACT, '02-AGOSTO', 1000, 4100, 410],
  ]);
  const r = correr(db, ['PRODUCTO_PERDIDO']);
  const p = de(r, 'PRODUCTO_PERDIDO');
  assert.deepEqual(p.map(x => x.detalle), ['LECHUGA']);
  assert.equal(p[0].titulo, 'COTO');
  assert.equal(p[0].usd_en_juego, 3000);
});

test('NO se cuenta dos veces: los productos de un cliente que se fue entero quedan afuera', () => {
  // Si además de "SE FUE" salieran sus dos productos, el total de la lista diría 2× la plata
  // que realmente hay en juego — y ese total es lo primero que se mira.
  const db = base([
    ['SE FUE', 'SUPER', 'TOMATE',  ANT, '02-AGOSTO', 1000, 4000, 400],
    ['SE FUE', 'SUPER', 'LECHUGA', ANT, '02-AGOSTO',  500, 3000, 300],
  ]);
  const r = correr(db, ['CLIENTE_PERDIDO', 'PRODUCTO_PERDIDO']);
  assert.equal(de(r, 'CLIENTE_PERDIDO').length, 1);
  assert.equal(de(r, 'PRODUCTO_PERDIDO').length, 0);
  assert.equal(r.margen_en_juego_total, 700);   // 7000 × 10%, una sola vez
});

// ── CAÍDA FUERTE ──────────────────────────────────────────────────────────────────────
test('lo que está en juego en una caída es la DIFERENCIA, no la venta entera', () => {
  const db = base([
    ['COTO', 'SUPER', 'TOMATE', ANT, '02-AGOSTO', 2000, 10000, 1000],
    ['COTO', 'SUPER', 'TOMATE', ACT, '02-AGOSTO',  600,  3000,  300],
  ]);
  const c = de(correr(db, ['CAIDA_FUERTE']), 'CAIDA_FUERTE');
  assert.equal(c.length, 1);
  assert.equal(c[0].usd_en_juego, 7000);
  assert.equal(c[0].caida_pct, 70);
  assert.equal(c[0].act_usd, 3000);
  assert.equal(c[0].ref_usd, 10000);
});

test('una caída por debajo del umbral no es noticia', () => {
  const db = base([
    ['COTO', 'SUPER', 'TOMATE', ANT, '02-AGOSTO', 2000, 10000, 1000],
    ['COTO', 'SUPER', 'TOMATE', ACT, '02-AGOSTO', 1900,  9500,  950],   // −5%
  ]);
  assert.equal(correr(db, ['CAIDA_FUERTE']).items.length, 0);
});

test('el que dejó de comprar el producto va a PRODUCTO_PERDIDO y no a CAIDA_FUERTE', () => {
  const db = base([
    ['COTO', 'SUPER', 'TOMATE',  ANT, '02-AGOSTO', 2000, 10000, 1000],
    ['COTO', 'SUPER', 'LECHUGA', ACT, '02-AGOSTO',  100,  1000,  100],
  ]);
  const r = correr(db, ['CAIDA_FUERTE', 'PRODUCTO_PERDIDO']);
  assert.equal(de(r, 'CAIDA_FUERTE').length, 0);
  assert.deepEqual(de(r, 'PRODUCTO_PERDIDO').map(x => x.detalle), ['TOMATE']);
});

// ── NO LE VENDEMOS ────────────────────────────────────────────────────────────────────
function baseCross() {
  // Tres supermercados compran BROCOLI; el cuarto, del mismo rubro, no. Todos del mismo
  // tamaño, para que el ajuste por tamaño no ensucie la lectura del test.
  const filas = [];
  for (const c of ['S1', 'S2', 'S3']) {
    filas.push([c, 'SUPER', 'BROCOLI', ACT, '02-AGOSTO', 100, 3000, 300]);
    filas.push([c, 'SUPER', 'TOMATE',  ACT, '02-AGOSTO', 100, 3000, 300]);
  }
  filas.push(['S4', 'SUPER', 'TOMATE', ACT, '02-AGOSTO', 200, 6000, 600]);
  return filas;
}
test('el producto que compra el rubro y a este cliente no se lo vendemos', () => {
  const r = correr(base(baseCross()), ['CROSS_SELL']);
  const x = de(r, 'CROSS_SELL');
  assert.deepEqual(x.map(i => i.titulo + '/' + i.detalle), ['S4/BROCOLI']);
  assert.equal(x[0].n_comparables, 3);
  // Los cuatro facturan 6.000, así que el ajuste por tamaño es ×1 y el estimado queda en
  // el promedio del rubro: 9.000 de BROCOLI repartidos entre los 3 que lo compran.
  assert.equal(x[0].usd_en_juego, 3000);
});

test('con menos de tres clientes comprándolo es una casualidad, no un patrón', () => {
  const filas = baseCross().filter(f => !(f[0] === 'S3' && f[2] === 'BROCOLI'));
  assert.equal(correr(base(filas), ['CROSS_SELL']).items.length, 0);
});

test('si ya se lo vendimos el año pasado no es una oportunidad nueva', () => {
  const filas = baseCross();
  filas.push(['S4', 'SUPER', 'BROCOLI', ANT, '02-AGOSTO', 50, 1500, 150]);
  assert.equal(correr(base(filas), ['CROSS_SELL']).items.length, 0);
});

test('el rubro separa: lo que compran los supers no se le ofrece a un mayorista', () => {
  const filas = baseCross();
  filas.push(['M1', 'MAYORISTA', 'TOMATE', ACT, '02-AGOSTO', 500, 15000, 1500]);
  const x = de(correr(base(filas), ['CROSS_SELL']), 'CROSS_SELL');
  assert.equal(x.filter(i => i.titulo === 'M1').length, 0);
});

test('un cliente chico no recibe la expectativa de un rubro con un gigante adentro', () => {
  const filas = [];
  for (const c of ['G1', 'G2', 'G3']) filas.push([c, 'SUPER', 'BROCOLI', ACT, '02-AGOSTO', 1000, 100000, 10000]);
  for (const c of ['G1', 'G2', 'G3']) filas.push([c, 'SUPER', 'TOMATE',  ACT, '02-AGOSTO', 1000, 100000, 10000]);
  filas.push(['CHICO', 'SUPER', 'TOMATE', ACT, '02-AGOSTO', 10, 1000, 100]);
  const x = de(correr(base(filas), ['CROSS_SELL']), 'CROSS_SELL');
  assert.equal(x.length, 1);
  // Sin tope inferior el estimado sería 100.000; el piso de escala lo deja en 0,2 → 20.000.
  // Sigue siendo optimista, pero no le atribuye a un cliente de 1.000 la compra de uno de
  // 100.000, que es lo que hace que una lista así deje de creerse.
  assert.equal(x[0].usd_en_juego, 100000 * UMBRALES.cross_piso_escala);
});

// ── VENDE Y PIERDE PLATA ──────────────────────────────────────────────────────────────
test('lo que está en juego es dejar de perder, así que el puntaje es positivo', () => {
  const db = base([
    ['COTO', 'SUPER', 'NARANJA', ACT, '02-AGOSTO', 3000, 20000, -1500],
    ['COTO', 'SUPER', 'TOMATE',  ACT, '02-AGOSTO', 1000, 10000,  1000],
  ]);
  const x = de(correr(db, ['MARGEN_NEGATIVO']), 'MARGEN_NEGATIVO');
  assert.deepEqual(x.map(i => i.detalle), ['NARANJA']);
  assert.equal(x[0].margen_en_juego, 1500);
  assert.equal(x[0].score, 1500);
  assert.equal(x[0].act_usd, 20000);
});

test('la pérdida del año pasado no cuenta: la oportunidad es la de ahora', () => {
  const db = base([['COTO', 'SUPER', 'NARANJA', ANT, '02-AGOSTO', 3000, 20000, -1500]]);
  assert.equal(correr(db, ['MARGEN_NEGATIVO']).items.length, 0);
});

// ── EL ORDEN ──────────────────────────────────────────────────────────────────────────
test('ordena por margen en juego, no por facturación', () => {
  // GORDO factura el triple pero deja 2%; FINO deja 40%. La plata está en FINO.
  const db = base([
    ['GORDO', 'SUPER', 'TOMATE', ANT, '02-AGOSTO', 5000, 30000,  600],
    ['FINO',  'SUPER', 'UVA',    ANT, '02-AGOSTO',  500, 10000, 4000],
  ]);
  const r = correr(db, ['CLIENTE_PERDIDO']);
  assert.deepEqual(r.items.map(x => x.titulo), ['FINO', 'GORDO']);
  assert.equal(r.items[0].margen_en_juego, 4000);
  assert.equal(r.items[1].margen_en_juego, 600);
  // Y el de más facturación es el otro: si ordenara por dólares, el orden sería al revés.
  assert.ok(r.items[1].usd_en_juego > r.items[0].usd_en_juego);
});

test('sin margen propio cae a la tasa global de la ventana, y la fila lo dice', () => {
  const db = base([
    ['SIN RENT', 'SUPER', 'TOMATE', ANT, '02-AGOSTO', 1000, 5000, null],
    ['CON RENT', 'SUPER', 'TOMATE', ANT, '02-AGOSTO', 1000, 5000, 1000],
  ]);
  // Global: 1000 de margen sobre 10.000 = 10%.
  assert.equal(tasaMargenGlobal(db, WHERE, []), 0.1);
  const r = correr(db, ['CLIENTE_PERDIDO']);
  const sin = r.items.find(x => x.titulo === 'SIN RENT');
  const con = r.items.find(x => x.titulo === 'CON RENT');
  assert.equal(sin.tasa_propia, false);
  assert.equal(sin.tasa_margen, 0.1);
  assert.equal(con.tasa_propia, true);
  assert.equal(con.tasa_margen, 0.2);
});

// ── EL NIVEL CAMBIA LO QUE SE VE, NO EL ORDEN ─────────────────────────────────────────
test('el que no ve margen recibe la MISMA lista en el MISMO orden, sin las columnas', () => {
  // Decisión de Andy, 24/8/2026: "si el comercial trabaja una lista y yo veo otra, cuando
  // discutamos no vamos a estar hablando de lo mismo".
  const db = base([
    ['GORDO', 'SUPER', 'TOMATE', ANT, '02-AGOSTO', 5000, 30000,  600],
    ['FINO',  'SUPER', 'UVA',    ANT, '02-AGOSTO',  500, 10000, 4000],
  ]);
  const full = correr(db, ['CLIENTE_PERDIDO']);
  const pelado = sinMargen(full);
  assert.deepEqual(pelado.items.map(x => x.titulo), full.items.map(x => x.titulo));
  assert.deepEqual(pelado.items.map(x => x.titulo), ['FINO', 'GORDO']);
  for (const x of pelado.items) {
    assert.equal(x.margen_en_juego, undefined);
    assert.equal(x.score, undefined);
    assert.equal(x.tasa_margen, undefined);
    // Los dólares en juego SÍ quedan: sin ellos el orden sería inexplicable.
    assert.ok(x.usd_en_juego > 0);
    assert.ok(x.regla.length > 10);
  }
  assert.equal(pelado.tasa_margen_global, undefined);
  assert.equal(pelado.margen_en_juego_total, undefined);
  assert.equal(pelado.por_tipo.CLIENTE_PERDIDO.n, 2);
  assert.equal(pelado.por_tipo.CLIENTE_PERDIDO.margen_en_juego, undefined);
});

// ── LA LISTA SE EXPLICA SOLA ──────────────────────────────────────────────────────────
test('cada oportunidad viaja con la regla que la puso ahí', () => {
  const filas = baseCross();
  filas.push(['SE FUE', 'SUPER', 'PAPA', ANT, '02-AGOSTO', 900, 5000, 500]);
  filas.push(['COTO', 'SUPER', 'NARANJA', ACT, '02-AGOSTO', 3000, 20000, -1500]);
  filas.push(['COTO', 'SUPER', 'PERA', ANT, '02-AGOSTO', 2000, 10000, 1000]);
  filas.push(['COTO', 'SUPER', 'PERA', ACT, '02-AGOSTO',  200,  1000,  100]);
  const r = correr(base(filas));
  assert.ok(r.items.length >= 4);
  for (const x of r.items) {
    assert.ok(x.regla && x.regla.length > 15, 'sin regla: ' + JSON.stringify(x));
    assert.ok(x.tipo && x.titulo != null, JSON.stringify(x));
    // El filtro que deja la pantalla mirando esa oportunidad.
    assert.ok(x.filtro && x.filtro.cliente, JSON.stringify(x));
  }
  // Los cinco tipos se cuentan por separado, para poder mirar uno solo.
  assert.ok(r.por_tipo.CLIENTE_PERDIDO.n >= 1);
  assert.ok(r.por_tipo.CROSS_SELL.n >= 1);
  assert.ok(r.por_tipo.MARGEN_NEGATIVO.n >= 1);
  assert.ok(r.por_tipo.CAIDA_FUERTE.n >= 1);
});

test('el límite recorta pero avisa cuántas había', () => {
  const filas = [];
  for (let i = 0; i < 20; i++) filas.push(['C' + i, 'SUPER', 'TOMATE', ANT, '02-AGOSTO', 100, 1000 + i, 100]);
  const r = detectar(base(filas), WHERE, [], VENTANA, { tipos: ['CLIENTE_PERDIDO'], limite: 5 });
  assert.equal(r.items.length, 5);
  assert.equal(r.total, 20);
  assert.equal(r.truncado, true);
  // El total de plata en juego es el de TODAS, no el de las cinco que se muestran.
  assert.ok(r.por_tipo.CLIENTE_PERDIDO.margen_en_juego > r.items.reduce((a, x) => a + x.margen_en_juego, 0));
});

test('sin datos no explota: devuelve una lista vacía', () => {
  const r = correr(base([]));
  assert.equal(r.items.length, 0);
  assert.equal(r.total, 0);
  assert.equal(r.margen_en_juego_total, 0);
  assert.equal(r.tasa_margen_global, 0);
});

// ── LAS DOS TRAMPAS DE SQLITE QUE YA COSTARON CARO ────────────────────────────────────
// Los tests de arriba pasan un WHERE con los valores escritos adentro. El router NO: manda
// un WHERE con `?` y los valores aparte. Es la misma consulta y da resultados distintos si
// el orden de los parámetros no coincide con el orden de los `?` en el TEXTO — que es como
// SQLite los ata. Un `?` en el SELECT le roba el valor al del WHERE, no da error, y el radar
// devuelve cero: se lee como "no hay nada que hacer".
//
// Este test corre CADA detector de las dos formas y exige el mismo resultado.
const TIPOS_TODOS = ['CLIENTE_PERDIDO', 'PRODUCTO_PERDIDO', 'CAIDA_FUERTE', 'CROSS_SELL', 'MARGEN_NEGATIVO'];
const WHERE_PARAM = "WHERE periodo IS NOT NULL AND periodo <> '' AND periodo IN (?,?) AND mes_ok = ?";
const PARAMS = [ACT, ANT, '02-AGOSTO'];

function baseCompleta() {
  const filas = baseCross();
  filas.push(['SE FUE', 'SUPER', 'PAPA',    ANT, '02-AGOSTO', 900, 5000, 500]);
  filas.push(['S1',     'SUPER', 'PERA',    ANT, '02-AGOSTO', 2000, 10000, 1000]);
  filas.push(['S1',     'SUPER', 'PERA',    ACT, '02-AGOSTO',  200,  1000,  100]);
  filas.push(['S1',     'SUPER', 'MELON',   ANT, '02-AGOSTO',  800,  4000,  400]);
  filas.push(['S2',     'SUPER', 'NARANJA', ACT, '02-AGOSTO', 3000, 20000, -1500]);
  return base(filas);
}

test('con el WHERE parametrizado da EXACTAMENTE lo mismo que con los valores escritos', () => {
  for (const t of TIPOS_TODOS) {
    const inline = detectar(baseCompleta(), WHERE, [], VENTANA, { tipos: [t], limite: 500 });
    const conParams = detectar(baseCompleta(), WHERE_PARAM, PARAMS, VENTANA, { tipos: [t], limite: 500 });
    const clave = (r) => r.items.map(x => x.tipo + '|' + x.titulo + '|' + x.detalle + '|' + x.usd_en_juego).join(' / ');
    assert.equal(clave(conParams), clave(inline), t + ' cambia según cómo venga el WHERE');
    assert.ok(inline.items.length > 0, t + ' no encontró nada ni siquiera con el WHERE inline');
  }
});

test('ningún alias del SQL se llama como una columna de sheet_ventas', () => {
  // `rent` EXISTE en la tabla. Un `SUM(rent_dol) AS rent` seguido de `HAVING rent < 0` mira
  // la COLUMNA —que viene vacía— y no la suma: no da error y no devuelve nada nunca.
  const src = readFileSync(new URL('../src/servicios/oportunidades.js', import.meta.url), 'utf8');
  const columnas = ['rent', 'total', 'cantidad', 'precio', 'des', 'pct', 'boni', 'partida', 'sem', 'mes', 'anio'];
  // Sólo dentro del SQL: el comentario del encabezado NOMBRA la trampa ("SUM(rent_dol) AS
  // rent") para explicarla, y un grep sobre el archivo entero se lo comería como si fuera
  // código — el test fallaría por la explicación de por qué existe el test.
  const sql = [...src.matchAll(/db\.prepare\(`([\s\S]*?)`\)/g)].map(m => m[1]).join('\n');
  const alias = [...sql.matchAll(/\bAS\s+(\w+)/gi)].map(m => m[1].toLowerCase());
  const choques = alias.filter(a => columnas.includes(a));
  assert.deepEqual(choques, [], 'alias que se pisan con columnas reales: ' + choques.join(', '));
});

test('el WHERE va siempre en un WITH base al principio, para que sus ? queden primeros', () => {
  const src = readFileSync(new URL('../src/servicios/oportunidades.js', import.meta.url), 'utf8');
  // Cada consulta que interpola ${where} tiene que hacerlo dentro de un WITH ... AS (SELECT
  // ... ${where}) y no en el medio, que es donde un ? del SELECT se le adelanta.
  for (const m of src.matchAll(/db\.prepare\(`([\s\S]*?)`\)/g)) {
    const q = m[1];
    if (!q.includes('${where}')) continue;
    const antes = q.slice(0, q.indexOf('${where}'));
    assert.equal(antes.includes('?'), false,
      'hay un ? antes del ${where} en:\n' + q.trim().slice(0, 200));
  }
});
