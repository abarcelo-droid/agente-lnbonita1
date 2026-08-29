// ══ VARIAS PARTIDAS, UNA SOLA LIQUIDACIÓN ══════════════════════════════════
//
// Pablo, 29/8/2026: «si un productor o proveedor tiene 2 o más partidas para
// liquidar debemos poder agruparlas y liquidarlas en una sola liquidación,
// MANTENIENDO LOS PRECIOS Y CANTIDADES DE CADA PARTIDA. Lo fiscal y lo de gestión
// se debe mantener… simplemente tener la posibilidad de agrupar y que sumen los
// montos a la hora de hacer la liquidación».
//
// Por eso todo lo de acá SUMA y nada promedia: cada partida entra con sus renglones,
// su precio, su alícuota y su propia respuesta sobre la merma. Un precio promedio del
// grupo sería un número que no se pactó con nadie, y el día que una no cierre no se
// sabría cuál.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { objetivoCerrado, objetivoCerradoGrupo,
  cierraContraLoAcordado } from '../src/servicios/sg_acordado.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const LIQ = fs.readFileSync(path.join(RAIZ, 'src/rutas/liquidaciones.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// Dos camiones del mismo productor. El 1: 100 cajones de 20 kg a $500/kg
// ($10.000 el cajón, $1.000.000). El 2: 40 cajones de 20 kg a $250/kg ($5.000 el
// cajón, $200.000).
function dosPartidas(opts = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, tipo_precio TEXT,
      precio_incluye_iva INTEGER, iva_alicuota_oc REAL);
    CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY, oc_id INTEGER, precio_estimado_por_kg REAL,
      modo_carga TEXT, kg_por_bulto REAL, presentacion_id INTEGER);
    CREATE TABLE sg_presentaciones (id INTEGER PRIMARY KEY, factor_conversion REAL);
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, oc_item_id INTEGER, kg_reales REAL,
      bultos REAL, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_lote_decomisos (id INTEGER PRIMARY KEY, lote_id INTEGER, kg REAL,
      bultos INTEGER, motivo TEXT, fecha TEXT);
  `);
  const oc = db.prepare('INSERT INTO sg_oc VALUES (?,?,?,?)');
  oc.run(1, 'firme', opts.incluye1 === undefined ? 1 : opts.incluye1, opts.alic1 === undefined ? 10.5 : opts.alic1);
  oc.run(2, 'firme', opts.incluye2 === undefined ? 1 : opts.incluye2, opts.alic2 === undefined ? 10.5 : opts.alic2);
  db.prepare('INSERT INTO sg_oc_items VALUES (1,1,500,?,20,NULL)').run('bulto');
  db.prepare('INSERT INTO sg_oc_items VALUES (2,2,250,?,20,NULL)').run('bulto');
  db.prepare('INSERT INTO sg_lotes VALUES (1,1,2000,100,1)').run();
  db.prepare('INSERT INTO sg_lotes VALUES (2,2,800,40,1)').run();
  return db;
}
const tirar = (db, lote, bultos, kg) =>
  db.prepare('INSERT INTO sg_lote_decomisos (lote_id, kg, bultos, motivo) VALUES (?,?,?,?)')
    .run(lote, kg, bultos, 'podrido');

const G = (db, partes) => objetivoCerradoGrupo(db, partes);

// ── 1 · EL OBJETIVO ES LA SUMA ─────────────────────────────────────────────

test('el objetivo del grupo es la suma de lo pactado en cada partida', () => {
  const db = dosPartidas();
  const g = G(db, [{ ocId: 1, cantidad: 100 }, { ocId: 2, cantidad: 40 }]);
  assert.equal(g.ok, true);
  assert.equal(g.objetivo, 1200000);
  assert.equal(g.grupo, 2);
  assert.deepEqual(g.partes.map((o) => o.objetivo), [1000000, 200000]);
});

test('y NO promedia: cada partida conserva su precio', () => {
  // 140 cajones al promedio ($8.571,43) daría $1.200.000 por casualidad en este
  // ejemplo, pero liquidando una parte se desarma. Se controla que cada objetivo
  // sea el de SU orden, no una porción del total.
  const db = dosPartidas();
  const g = G(db, [{ ocId: 1, cantidad: 50 }, { ocId: 2, cantidad: 40 }]);
  assert.equal(g.partes[0].objetivo, 500000, '50 cajones del camión caro');
  assert.equal(g.partes[1].objetivo, 200000, 'el barato entero');
  assert.equal(g.objetivo, 700000);
});

test('una sola partida es el grupo de una: la misma cuenta de siempre', () => {
  // Si el caso simple fuera un camino aparte, el día que una cosa cambie habría que
  // acordarse de tocar los dos.
  const db = dosPartidas();
  const solo = objetivoCerrado(db, { ocId: 1, cantidad: 100 });
  const g = G(db, [{ ocId: 1, cantidad: 100 }]);
  assert.equal(g.objetivo, solo.objetivo);
  assert.deepEqual(g.admitidos, solo.admitidos);
  assert.equal(g.grupo, 1);
});

test('lo que da la suma cierra, y un peso más no', () => {
  const db = dosPartidas();
  const g = G(db, [{ ocId: 1, cantidad: 100 }, { ocId: 2, cantidad: 40 }]);
  assert.equal(cierraContraLoAcordado(1200000, g), true);
  assert.equal(cierraContraLoAcordado(1200001, g), false);
  assert.equal(cierraContraLoAcordado(1000000, g), false, 'pagó sólo una de las dos');
});

// ── 2 · LA MERMA ES DE CADA PARTIDA ────────────────────────────────────────

test('cada partida contesta su propia merma', () => {
  // Un grupo no tiene «una» merma: tiene la de cada partida, y se pueden querer
  // resolver distinto.
  const db = dosPartidas();
  tirar(db, 1, 5, 100);    // 5 cajones del caro: $50.000
  tirar(db, 2, 4, 80);     // 4 cajones del barato: $20.000
  const g = G(db, [
    { ocId: 1, cantidad: 100, mermaLiquidada: true },   // se los pago: $1.000.000
    { ocId: 2, cantidad: 40, mermaLiquidada: false },   // no: $200.000 − $20.000
  ]);
  assert.equal(g.ok, true);
  assert.equal(g.partes[0].objetivo, 1000000);
  assert.equal(g.partes[1].objetivo, 180000);
  assert.equal(g.objetivo, 1180000);
});

test('y si a una le falta la respuesta, se frena el grupo entero', () => {
  // Con una sin contestar no hay un importe: el comprobante es uno solo.
  const db = dosPartidas();
  tirar(db, 2, 4, 80);
  const g = G(db, [{ ocId: 1, cantidad: 100 }, { ocId: 2, cantidad: 40 }]);
  assert.equal(g.ok, false);
  assert.match(g.motivo, /4 bultos de merma/);
});

test('la que no tiene merma no necesita contestar nada', () => {
  const db = dosPartidas();
  tirar(db, 2, 4, 80);
  const g = G(db, [{ ocId: 1, cantidad: 100 }, { ocId: 2, cantidad: 40, mermaLiquidada: false }]);
  assert.equal(g.ok, true);
  assert.equal(g.objetivo, 1180000);
});

// ── 3 · LAS LECTURAS DE CADA ORDEN SE COMBINAN ─────────────────────────────

test('una orden vieja sin IVA declarado admite sus lecturas dentro del grupo', () => {
  // La orden 2 no dice si el precio traía IVA ni con qué alícuota: admite varias
  // lecturas por su cuenta, y el grupo tiene que admitir cualquier combinación.
  // Rechazarlas dejaría el grupo imposible de liquidar por culpa de una orden vieja.
  const db = dosPartidas({ incluye2: null, alic2: null });
  const g = G(db, [{ ocId: 1, cantidad: 100 }, { ocId: 2, cantidad: 40 }]);
  assert.equal(g.ok, true);
  assert.equal(cierraContraLoAcordado(1200000, g), true, 'el precio de la 2 ya traía IVA');
  assert.equal(cierraContraLoAcordado(1221000, g), true, 'a la 2 se le suma el 10,5%');
  assert.equal(cierraContraLoAcordado(1242000, g), true, 'a la 2 se le suma el 21%');
  assert.equal(cierraContraLoAcordado(1300000, g), false, 'eso no sale de ninguna orden');
});

test('si una partida no da su precio, el grupo se frena con SU motivo', () => {
  // «No cierra» a secas sobre tres camiones no dice cuál mirar.
  const db = dosPartidas();
  db.prepare('UPDATE sg_oc_items SET precio_estimado_por_kg = NULL WHERE oc_id = 2').run();
  const g = G(db, [{ ocId: 1, cantidad: 100 }, { ocId: 2, cantidad: 40 }]);
  assert.equal(g.ok, false);
  assert.match(g.motivo, /no tiene cargado el precio acordado/);
});

test('y el tope de cada una se sigue midiendo contra lo que entró', () => {
  const db = dosPartidas();
  const g = G(db, [{ ocId: 1, cantidad: 100 }, { ocId: 2, cantidad: 400 }]);
  assert.equal(g.ok, false);
  assert.match(g.motivo, /mercadería que no recibimos/);
});

// ── 4 · LA VENTA DE VARIAS PARTIDAS SE FUSIONA ─────────────────────────────

// La función real, sacada del router y corrida de verdad.
function traerFusion() {
  const i = SG.indexOf('function fusionarVentas(partes) {');
  assert.ok(i > 0, 'no existe fusionarVentas');
  const src = SG.slice(i, SG.indexOf('\n}', i) + 2);
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  // eslint-disable-next-line no-new-func
  return new Function('r2', src + '; return fusionarVentas;')(r2);
}
const fusionar = traerFusion();

const parte = (o = {}) => Object.assign({
  ok: true, oc_id: 1, partida: 'P1', unidad: 'bulto',
  tipo_precio: 'firme', es_precio_cerrado: 1,
  acordado: { total: 1000000, total_sin_mermas: 950000, precio_por_bulto: 10000, base: 'bulto', items: 1 },
  comision_pct: 12, iva_servicios_pct: 21,
  descarga: { monto: 1000, n: 1, sin_valorizar: 0, iva: 210 },
  flete: { monto: 2000, iva: 420 },
  proveedor: { id: 7, razon_social: 'Don Juan' },
  articulos: [{ articulo: 'Durazno', unidad: 'bulto', cantidad: 95, precio: 10000, importe: 950000 }],
  mermas: [], bultos_ingresados: 100, bultos_vendidos: 95, bultos_merma: 5, kg_merma: 100,
  bultos_terminados: 100, bultos_en_deposito: 0, kg_ingresados: 2000, kg_vendidos: 1900,
  neto: 1100000, gestion: 0, iva: 115500, sin_facturar: 0,
  sin_valorizar: { descarga: 0, flete: 0 }, lineas_estimadas: 0, lineas_sin_atribuir: 0,
  lineas: [],
}, o);

test('los montos se suman y los renglones se concatenan', () => {
  const f = fusionar([parte(), parte({
    oc_id: 2, partida: 'P2',
    acordado: { total: 200000, total_sin_mermas: 200000, precio_por_bulto: 5000, base: 'bulto', items: 1 },
    articulos: [{ articulo: 'Ciruela', unidad: 'bulto', cantidad: 40, precio: 5000, importe: 200000 }],
    bultos_ingresados: 40, bultos_vendidos: 40, bultos_merma: 0, kg_merma: 0,
    neto: 230000, iva: 24150,
  })]);
  assert.equal(f.acordado.total, 1200000);
  assert.equal(f.acordado.total_sin_mermas, 1150000);
  assert.equal(f.neto, 1330000);
  assert.equal(f.bultos_ingresados, 140);
  assert.equal(f.articulos.length, 2);
  assert.deepEqual(f.oc_ids, [1, 2]);
  assert.equal(f.partida, 'P1 + P2');
});

test('cada renglón dice de qué partida es', () => {
  // En un comprobante con dos camiones del mismo producto, dos renglones iguales
  // con precios distintos se leen como un error de carga.
  const f = fusionar([parte(), parte({ oc_id: 2, partida: 'P2' })]);
  assert.match(f.articulos[0].articulo, /Durazno · P1/);
  assert.match(f.articulos[1].articulo, /Durazno · P2/);
  assert.equal(f.articulos[0].oc_id, 1);
  assert.equal(f.articulos[1].oc_id, 2);
});

test('el precio del grupo sólo existe si TODAS coinciden', () => {
  // Poner el de una sería inventar el de las otras.
  const iguales = fusionar([parte(), parte({ oc_id: 2, partida: 'P2' })]);
  assert.equal(iguales.acordado.precio_por_bulto, 10000);
  const distintos = fusionar([parte(), parte({ oc_id: 2, partida: 'P2',
    acordado: { total: 200000, total_sin_mermas: 200000, precio_por_bulto: 5000 } })]);
  assert.equal(distintos.acordado.precio_por_bulto, null);
});

test('viaja el detalle de cada partida, con su acordado y su merma', () => {
  // Es lo que la pantalla necesita para preguntar la merma de cada una y para sumar
  // los objetivos uno por uno.
  const f = fusionar([parte(), parte({ oc_id: 2, partida: 'P2', bultos_merma: 0, kg_merma: 0 })]);
  assert.equal(f.partidas.length, 2);
  assert.equal(f.partidas[0].bultos_merma, 5);
  assert.equal(f.partidas[0].acordado_total, 1000000);
  assert.equal(f.partidas[0].acordado_sin_mermas, 950000);
  assert.equal(f.partidas[0].precio_por_bulto, 10000);
  assert.equal(f.partidas[1].bultos_merma, 0);
});

test('dos productores distintos NO se juntan', () => {
  // La liquidación se emite a nombre de uno solo.
  assert.throws(() => fusionar([parte(), parte({ oc_id: 2, proveedor: { id: 9, razon_social: 'Otro' } })]),
    /no son del mismo productor/);
});

test('precio abierto y precio cerrado tampoco', () => {
  // Una se liquida por lo que rindió y la otra por lo pactado: son dos cuentas
  // distintas para el mismo papel.
  assert.throws(() => fusionar([parte(), parte({ oc_id: 2, es_precio_cerrado: 0, tipo_precio: 'pizarra' })]),
    /precio abierto y a precio cerrado/);
});

test('si alguna se pactó por bulto, el grupo cuenta bultos', () => {
  // Es la unidad más gruesa y la que el productor cuenta. Misma regla que dentro de
  // una partida.
  const f = fusionar([parte({ unidad: 'kilo' }), parte({ oc_id: 2, unidad: 'bulto' })]);
  assert.equal(f.unidad, 'bulto');
  const g = fusionar([parte({ unidad: 'kilo' }), parte({ oc_id: 2, unidad: 'kilo' })]);
  assert.equal(g.unidad, 'kilo');
});

test('el flete suma SÓLO el que se le cobra al productor', () => {
  // Pablo, 27/8/2026: «si el vendedor paga el flete no hace falta cargar los datos de
  // importes porque no nos interesa el costo». El monto del que paga el vendedor viaja
  // igual —que exista y no se cobre es una decisión, no un olvido—, y la pantalla
  // prellena el campo con el NETO cuando se_cobra. Sumar los dos le descontaba al
  // productor un viaje que no pagó nadie de este lado.
  const f = fusionar([
    parte({ flete: { a_cargo: 'vendedor', monto: 9000, neto: 9000, iva: 1890, se_cobra: 0 } }),
    parte({ oc_id: 2, partida: 'P2',
      flete: { a_cargo: 'comprador', monto: 2000, neto: 2000, iva: 420, se_cobra: 1 } }),
  ]);
  assert.equal(f.flete.neto, 2000, 'le está cobrando el flete que pagó el vendedor');
  assert.equal(f.flete.iva, 420);
  assert.equal(f.flete.se_cobra, 1);
});

test('y si ninguna se le cobra, no se le cobra nada', () => {
  const f = fusionar([
    parte({ flete: { a_cargo: 'vendedor', monto: 9000, neto: 9000, iva: 1890, se_cobra: 0 } }),
    parte({ oc_id: 2, flete: { a_cargo: 'vendedor', monto: 3000, neto: 3000, iva: 630, se_cobra: 0 } }),
  ]);
  assert.equal(f.flete.se_cobra, 0);
  assert.equal(f.flete.neto, 0);
});

test('las descargas sí se suman: todas se le descuentan', () => {
  const f = fusionar([parte(), parte({ oc_id: 2,
    descarga: { monto: 500, n: 2, sin_valorizar: 0, iva: 105 } })]);
  assert.equal(f.descarga.monto, 1500);
  assert.equal(f.descarga.iva, 315);
  assert.equal(f.descarga.n, 3);
});

test('lo que falta facturar o valorizar se suma, no se pierde', () => {
  // Con una sola partida sin facturar, la liquidación entera sale de menos.
  const f = fusionar([parte({ sin_facturar: 5000, sin_valorizar: { descarga: 1, flete: 0 } }),
    parte({ oc_id: 2, sin_facturar: 3000, sin_valorizar: { descarga: 0, flete: 2 } })]);
  assert.equal(f.sin_facturar, 8000);
  assert.deepEqual(f.sin_valorizar, { descarga: 1, flete: 2 });
});

// ── 5 · EL SERVIDOR ────────────────────────────────────────────────────────

test('la dirección es la misma: el permiso se resuelve igual', () => {
  // exigirNivel reconoce el módulo por la URL. Una dirección nueva sería un permiso
  // nuevo que hay que acordarse de dar de alta.
  assert.match(SG, /function idsDelGrupo\(req\) \{/);
  assert.match(SG, /req\.query\.mas/);
  assert.match(SG, /router\.get\('\/partidas\/:id\/venta', requireAuth/);
  const i = SG.indexOf("router.get('/partidas/:id/venta', requireAuth");
  const b = SG.slice(i, i + 700);
  assert.match(b, /const partes = ids\.map\(\(id\) => ventaDePartida\(db, id\)\);/);
  assert.match(b, /partes\.length === 1 \? partes\[0\] : fusionarVentas\(partes\)/);
  assert.match(b, /ids\.length > 20/, 'sin tope, un pedido con mil ids cuelga la base');
});

test('el freno de cada partida corre por separado', () => {
  // Agrupar no puede ser la forma de colar la que no estaba lista.
  assert.match(LIQ, /for \(const p of partidas\) \{\r?\n\s*const frena = frenoParaLiquidar\(db, p\.oc_id, facturaCuenta\);/);
  assert.match(LIQ, /Una de las partidas del grupo no se puede liquidar todavía/);
});

test('la liquidación guarda de qué partidas es', () => {
  assert.match(LIQ, /CREATE TABLE IF NOT EXISTS liquidacion_partidas/);
  assert.match(LIQ, /liquidacion_id  INTEGER NOT NULL REFERENCES liquidaciones\(id\)/);
  // SIN foreign key hacia sg_oc: con foreign_keys=ON, una FK hacia otro módulo hace
  // fallar los DELETE de ese módulo (regla del repo).
  const i = LIQ.indexOf('CREATE TABLE IF NOT EXISTS liquidacion_partidas');
  const b = LIQ.slice(i, i + 600);
  assert.ok(!/REFERENCES sg_oc/.test(b), 'quedó una FK hacia otro módulo');
  assert.match(LIQ, /INSERT INTO liquidacion_partidas \(liquidacion_id, oc_id, bultos, merma_liquidada\)/);
});

test('y una fila también cuando es UNA sola partida', () => {
  // Si el caso simple no dejara rastro acá, «qué partidas ya se liquidaron» habría
  // que preguntarlo en dos lados y un día se olvidaría de uno.
  const i = LIQ.indexOf('INSERT INTO liquidacion_partidas');
  const b = LIQ.slice(i - 500, i + 300);
  assert.match(b, /for \(const p of partidas\) \{/);
  assert.ok(!/partidas\.length > 1/.test(b), 'sólo guarda el grupo cuando son varias');
});

test('las agrupadas también salen de la bandeja', () => {
  // La columna oc_id guarda sólo la PRIMERA del grupo: sin esto, liquidar tres
  // partidas juntas sacaba una y dejaba las otras dos esperando una liquidación que
  // ya se emitió — y alguien se la volvería a hacer.
  //
  // La función real, corrida contra una base: mirar el texto no alcanza, porque la
  // consulta puede estar escrita y traer la columna equivocada.
  const i = SG.indexOf('function partidasConLiquidacion(db) {');
  assert.ok(i > 0);
  const src = SG.slice(i, SG.indexOf('\n}', i) + 2);
  // eslint-disable-next-line no-new-func
  const conLiq = new Function(src + '; return partidasConLiquidacion;')();

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE liquidaciones (id INTEGER PRIMARY KEY, oc_id INTEGER, eliminado_en TEXT);
    CREATE TABLE liquidacion_partidas (id INTEGER PRIMARY KEY, liquidacion_id INTEGER, oc_id INTEGER)`);
  // Una liquidación agrupada: las partidas 10, 11 y 12. oc_id guarda la 10.
  db.prepare('INSERT INTO liquidaciones VALUES (1, 10, NULL)').run();
  for (const oc of [10, 11, 12]) {
    db.prepare('INSERT INTO liquidacion_partidas (liquidacion_id, oc_id) VALUES (1, ?)').run(oc);
  }
  // Y una anulada sobre la 20: esa partida tiene que quedar libre.
  db.prepare("INSERT INTO liquidaciones VALUES (2, 20, '2026-08-29')").run();
  db.prepare('INSERT INTO liquidacion_partidas (liquidacion_id, oc_id) VALUES (2, 20)').run();

  const con = conLiq(db);
  assert.equal(con.has(10), true);
  assert.equal(con.has(11), true, 'la segunda del grupo quedó esperando una liquidación ya emitida');
  assert.equal(con.has(12), true, 'y la tercera');
  assert.equal(con.has(20), false, 'una anulada tiene que liberar la partida');
  assert.equal(con.has(99), false);
});

test('el tope de lo ya pagado mira las dos formas', () => {
  const i = LIQ.indexOf('const yaLiq = db.prepare(');
  const b = LIQ.slice(i, i + 800);
  assert.match(b, /l\.oc_id IN \(\$\{enIn\}\)/);
  assert.match(b, /EXISTS \(SELECT 1 FROM liquidacion_partidas lp/);
});

test('la misma partida dos veces en el mismo comprobante no entra', () => {
  // Le pagaría dos veces al productor y el cerrojo del precio cerrado lo daría por
  // bueno: dos objetivos sumados dan justo el doble.
  const i = LIQ.indexOf('const vistas = new Set();');
  assert.ok(i > 0, 'no se filtran las repetidas');
  assert.match(LIQ.slice(i, i + 300), /if \(vistas\.has\(p\.oc_id\)\) return false;/);
});

// ── 6 · LA PANTALLA ────────────────────────────────────────────────────────

test('la bandeja deja tildar varias, y sólo las que ya se pueden liquidar', () => {
  // Tildar una que todavía tiene mercadería en el depósito armaría un grupo que el
  // servidor rechaza entero, y el que lo arma no sabría cuál de las tres fue.
  const i = PANEL.indexOf("var ck = sgPartTerminada(p)");
  assert.ok(i > 0, 'no está el tilde de la bandeja');
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /class="liq-part-ck"/);
  assert.match(b, /data-prov=/);
  assert.match(b, /data-modo=/);
  assert.match(b, /: '<td><\/td>'/, 'la que no está terminada no se puede tildar');
});

test('y dice por qué no se pueden juntar, en vez de rebotar después', () => {
  const i = PANEL.indexOf('function sgLiqSelCambio(){');
  const b = PANEL.slice(i, i + 1800);
  assert.match(b, /if \(s\.length < 2\) \{ bar\.style\.display = 'none'/);
  assert.match(b, /productores distintos/);
  assert.match(b, /precio abierto y a precio cerrado/);
  assert.match(b, /Liquidar las '\r?\n?\s*\+ s\.length \+ ' juntas/);
});

test('el modal es el mismo: cambia de dónde viene la venta', () => {
  // Un modal aparte para el grupo serían dos pantallas que hacen lo mismo y que hay
  // que arreglar de a dos.
  const i = PANEL.indexOf('function liqDeGrupo(ocIds, codigos, proveedor){');
  assert.ok(i > 0, 'no existe liqDeGrupo');
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /LIQ\.partida = \{ oc_id: ocIds\[0\], oc_ids: ocIds\.slice\(\)/);
  assert.match(b, /liqVentaCab\(ocIds\[0\], ocIds\.slice\(1\)\)/);
  assert.match(PANEL, /'\/api\/sg\/partidas\/' \+ ocId \+ '\/venta' \+ \(varias \? '\?mas=' \+ mas\.join\(','\) : ''\)/);
});

test('la pantalla trabaja siempre con una LISTA de partidas', () => {
  // El caso de una es el grupo de una, no un camino aparte que haya que mantener en
  // paralelo.
  const i = PANEL.indexOf('function liqPartidasVenta(){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /if \(v\.partidas && v\.partidas\.length\) return v\.partidas;/);
  assert.match(b, /acordado_total: ac\.total, acordado_sin_mermas: ac\.total_sin_mermas/);
});

test('y el objetivo de la pantalla es la suma, partida por partida', () => {
  const i = PANEL.indexOf('var sumaAc = 0, hayAc = false, mNoPaga = 0;');
  assert.ok(i > 0, 'el despeje no suma por partida');
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /var paga = mc > 0 \? liqMermaPagaDe\(p\.oc_id\) : true;/);
  assert.match(b, /paga === false && p\.acordado_sin_mermas != null/);
  assert.match(b, /if \(hayAc && _entera\) \{/);
});
