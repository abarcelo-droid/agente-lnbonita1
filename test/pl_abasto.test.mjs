// ══ P&L ABASTO (V1052) ═══════════════════════════════════════════════════════════
//
// Pablo, 12/9/2026: «dentro de Informes vamos a agregar un submódulo que se llama P&L
// Abasto... voy a subir un Excel con el libro diario que nos trae el otro sistema».
//
// Los tests corren el lector REAL del panel sobre hojas con la forma del archivo real
// (títulos corridos, dos hojas, fila de total y de página), las rutas REALES sobre una base
// en memoria, y la cascada y la tabla REALES de la pantalla.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const RUTA = leer('src/rutas/pl_abasto.js');
const PANEL = leer('src/panel.html');
const SVC = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/pl_abasto.js')).href);

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
function hasta(txt, desde, fin) {
  const i = txt.indexOf(desde);
  assert.ok(i >= 0, 'no está: ' + desde.slice(0, 60));
  const j = txt.indexOf(fin, i);
  assert.ok(j > i, 'no cierra: ' + desde.slice(0, 60));
  return txt.slice(i, j + fin.length);
}
// Una ruta: desde su (req, res) => { hasta el }); que cierra la línea.
function handler(firma) {
  const i = RUTA.indexOf(firma);
  assert.ok(i >= 0, 'no está la ruta: ' + firma);
  const j = RUTA.indexOf('(req, res) => {', i);
  const re = /\r?\n\}\);/g;
  re.lastIndex = j;
  const m = re.exec(RUTA);
  return RUTA.slice(j, m.index + m[0].length - 2);
}
const lineaConst = (nombre) => {
  const m = new RegExp('^const ' + nombre + ' = .*;\\r?$', 'm').exec(RUTA);
  assert.ok(m, 'no está ' + nombre);
  return m[0];
};

// ── las rutas, sobre una base en memoria ────────────────────────────────────────
function base() {
  const db = new DatabaseSync(':memory:');
  const i = RUTA.indexOf('db.exec(`');
  db.exec(RUTA.slice(i + 9, RUTA.indexOf('`);', i)));
  db.exec("CREATE TABLE usuarios (id INTEGER PRIMARY KEY, nombre TEXT); INSERT INTO usuarios VALUES (5, 'Pablo');");
  db.transaction = (fn) => (...a) => {
    db.exec('BEGIN');
    try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return db;
}
function rutas(db, { detalleMax } = {}) {
  return new Function('db', 'SVC', [
    'const { RUBROS, SIN_ASIGNAR, esRubro, esCuentaDeResultado, rubroPorDefecto, validarCarga, avisosDeReemplazo } = SVC;',
    lineaConst('MES'),
    lineaConst('FECHA'),
    detalleMax ? 'const DETALLE_MAX = ' + detalleMax + ';' : lineaConst('DETALLE_MAX'),
    fuente(RUTA, 'function r2('),
    fuente(RUTA, 'function usuarioId('),
    fuente(RUTA, 'function rubrosDeCuentas('),
    fuente(RUTA, 'function contrapartidas('),
    fuente(RUTA, 'function reemplazo('),
    'return {',
    '  previa: ' + handler("router.post('/previa'") + ',',
    '  cargar: ' + handler("router.post('/cargar'") + ',',
    '  resultado: ' + handler("router.get('/resultado'") + ',',
    '  cuentas: ' + handler("router.get('/cuentas'") + ',',
    '  rubros: ' + handler("router.put('/rubros'") + ',',
    '  restablecer: ' + handler("router.delete('/rubros'") + ',',
    '  detalle: ' + handler("router.get('/detalle'") + ',',
    '};',
  ].join('\n'))(db, SVC);
}
const llamar = (h, req) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  h(Object.assign({ body: {}, query: {}, user: { id: 5 } }, req), res);
  return res;
};

const NOMBRES = {
  '4.1.01.00.000.0000': 'VENTAS', '2.1.03.01.000.0000': 'IVA Debito Fiscal',
  '1.1.03.01.000.6427': 'CRUZ OSCAR FABIAN', '4.1.01.01.000.0000': 'G - COMPRA MERCADERIA',
  '2.1.01.01.000.0012': 'PABLO GIGLIO', '4.2.05.02.006.0000': 'G - Intereses por Descubierto',
  '1.1.01.03.001.0000': 'BANCO FRANCES', '4.2.04.14.000.0000': 'G - Electricidad',
};
const CARGA_A = { archivo: 'diario_a.xls', cuentas: NOMBRES, renglones: [
  ['2025-07-13', '373353', '4.1.01.00.000.0000', 0, 868778.2805],
  ['2025-07-13', '373353', '2.1.03.01.000.0000', 0, 91221.7195],
  ['2025-07-13', '373353', '1.1.03.01.000.6427', 960000, 0],
  ['2025-08-02', '380001', '4.1.01.01.000.0000', 500000, 0],
  ['2025-08-02', '380001', '2.1.01.01.000.0012', 0, 500000],
  ['2025-08-20', '381000', '4.2.05.02.006.0000', 12000, 0],
  ['2025-08-20', '381000', '1.1.01.03.001.0000', 0, 12000],
] };
const CARGA_B = { archivo: 'diario_b.xls', cuentas: NOMBRES, renglones: [
  ['2025-08-02', '390001', '4.1.01.01.000.0000', 700000, 0],
  ['2025-08-02', '390001', '2.1.01.01.000.0012', 0, 700000],
  ['2025-09-10', '391000', '4.2.04.14.000.0000', 25000, 0],
  ['2025-09-10', '391000', '1.1.01.03.001.0000', 0, 25000],
] };

// ══ 1 · LAS REGLAS ═══════════════════════════════════════════════════════════════

test('el rubro por defecto, con las cuentas reales del libro diario de Abasto', () => {
  const casos = [
    ['4.1.01.00.000.0000', 'VENTAS', 'ventas'],
    ['4.1.02.00.000.0000', 'Comisiones Ganadas - Liquidaciones', 'ventas'],
    ['4.1.07.03.000.0000', 'Descuento Super - por Ac comerciales', 'ventas'],
    ['4.1.01.01.000.0000', 'G - COMPRA MERCADERIA', 'costos_variables'],
    ['4.2.01.00.000.0000', 'Costo de Mercadería Vendida', 'costos_variables'],
    ['4.1.03.00.000.0001', 'G - Descargas Pagadas', 'otros'],
    ['4.2.05.02.006.0000', 'G - Intereses por Descubierto', 'costos_financieros'],
    ['4.2.05.02.009.0002', 'Comision plataforma InvoiTrade', 'costos_financieros'],
    ['4.1.08.01.000.0000', 'Diferencia Cierre de Cambio', 'costos_financieros'],
    ['4.2.06.08.000.0000', 'Gastos Bancarios Cierre de Cam', 'costos_financieros'],
    ['4.2.07.01.000.0000', 'G - Intereses Pagados', 'costos_financieros'],
    ['4.1.07.05.000.0000', 'Rendimiento FCI - Finvoi', 'costos_financieros'],
    ['4.2.06.09.000.0000', 'Impuesto sobre los Ingresos Br', 'impuestos'],
    ['4.2.05.04.005.0000', 'Imp. Sellos', 'impuestos'],
    ['4.2.05.04.001.0000', 'Impuesto Ley 25413 debito', 'impuestos'],
    ['4.1.06.01.000.0000', 'Desc obtenidos IIBB', 'impuestos'],
    ['4.1.06.02.000.0000', 'DETRACCION ART 23 LEY 27541 / DTO 438-2', 'impuestos'],
    ['4.1.06.03.000.0000', 'Decreto 814', 'impuestos'],
    ['4.2.04.14.000.0000', 'G - Electricidad', 'otros'],
    ['1.1.01.03.001.0000', 'BANCO FRANCES', 'sin_asignar'],
    ['2.1.03.01.000.0000', 'IVA Debito Fiscal', 'sin_asignar'],
    ['3.1.01.00.000.0000', 'Capital', 'sin_asignar'],
  ];
  for (const [c, n, r] of casos) assert.equal(SVC.rubroPorDefecto(c, n), r, c + ' ' + n);
  assert.deepEqual(SVC.RUBROS.map((x) => x.k),
    ['ventas', 'costos_variables', 'costos_fijos', 'costos_financieros', 'impuestos', 'otros']);
});

test('la carga se valida renglón por renglón, y uno malo frena todo', () => {
  const v = SVC.validarCarga(CARGA_A);
  assert.equal(v.renglones.length, 7);
  assert.equal(v.desde, '2025-07-13');
  assert.equal(v.hasta, '2025-08-20');
  assert.equal(v.cuentas['4.1.01.00.000.0000'], 'VENTAS');
  // Un renglón en cero no entra.
  assert.equal(SVC.validarCarga({ renglones: [...CARGA_A.renglones, ['2025-07-14', '1', '4.1.01.00.000.0000', 0, 0]] })
    .renglones.length, 7);
  assert.match(SVC.validarCarga({ renglones: [['13/07/2025', '1', '4.1', 1, 0]] }).error, /renglón 1 tiene una fecha/);
  assert.match(SVC.validarCarga({ renglones: [['2025-07-13', '1', 'VENTAS', 1, 0]] }).error, /tiene una cuenta/);
  assert.match(SVC.validarCarga({ renglones: [['2025-07-13', '1', '4.1', 'mucho', 0]] }).error, /no es un número/);
  assert.match(SVC.validarCarga({ renglones: [] }).error, /no trae renglones/);
});

// ══ 2 · LEER EL EXCEL, COMO VIENE ═══════════════════════════════════════════════════

const LECTOR = new Function([
  /^var PLA_COD = .*;\r?$/m.exec(PANEL)[0],
  fuente(PANEL, 'function plaFecha(v){'),
  fuente(PANEL, 'function plaNumero(v){'),
  fuente(PANEL, 'function plaColumnas(hojas){'),
  fuente(PANEL, 'function plaLeerLibroDiario(hojas){'),
  'return plaLeerLibroDiario;',
].join('\n'))();

const TITULOS = ['Codigo de Cuenta', 'Nombre de Cuenta', 'Debe', 'Haber', 'Saldo', null];
const HOJAS_REALES = () => [
  [TITULOS,
   [new Date(2025, 6, 1), 327231, '1.1.01.05.000.0000', 'Valores a Depositar', 38002002.5, 0],
   [new Date(2025, 6, 1), 327231, '1.1.03.01.000.6239', 'INC S.A', 0, 38002002.5],
   [new Date(2025, 6, 13), 373353, '4.1.01.00.000.0000', 'VENTAS', 0, 868778.2805],
   [new Date(2025, 6, 13), 373353, '2.1.03.01.000.0000', 'IVA Debito Fiscal', 0, 91221.7195],
   // Un renglón en cero: no es un movimiento.
   [new Date(2025, 6, 13), 373353, '4.1.01.00.000.0000', 'VENTAS', 0, 0],
   // La hora corrida de una fecha del Excel: sigue siendo el 13.
   [new Date(2025, 6, 12, 23, 59, 59), 373353, '1.1.03.01.000.6427', 'CRUZ OSCAR FABIAN', 960000, 0]],
  [TITULOS,
   [new Date(2025, 11, 19), 347589, '4.1.01.01.000.0000', 'G - COMPRA MERCADERIA', '3.543.142,94', 0],
   [new Date(2025, 11, 19), 347589, '2.1.01.01.000.0012', 'PABLO GIGLIO', 0, '3.543.142,94'],
   [-997999.9684999943, null, null, null, null, null],
   ['Pagina:', 1, 'de', 1, null, null]],
];

test('lee el libro diario real: títulos corridos, dos hojas, total y número de página', () => {
  const l = LECTOR(HOJAS_REALES());
  assert.equal(l.error, undefined, l.error);
  assert.equal(l.renglones.length, 7);
  assert.equal(l.descartadas, 5, 'los dos títulos, el renglón en cero, el total y la página');
  assert.equal(l.desde, '2025-07-01');
  assert.equal(l.hasta, '2025-12-19');
  assert.deepEqual(l.meses, ['2025-07', '2025-12']);
  assert.equal(l.cuentas_resultado, 2);
  assert.deepEqual(l.renglones[0], ['2025-07-01', '327231', '1.1.01.05.000.0000', 38002002.5, 0]);
  assert.equal(l.renglones[4][0], '2025-07-13', 'la hora corrida lo pasó al día anterior');
  assert.deepEqual(l.renglones[5], ['2025-12-19', '347589', '4.1.01.01.000.0000', 3543142.94, 0]);
  assert.equal(l.cuentas['4.1.01.01.000.0000'], 'G - COMPRA MERCADERIA');
});

test('reconoce las columnas por lo que traen, aunque estén en otro lugar', () => {
  const corridas = HOJAS_REALES().map((h) => h.map((f) => ['x'].concat(f)));
  const l = LECTOR(corridas);
  assert.equal(l.renglones.length, 7);
  assert.equal(l.renglones[2][2], '4.1.01.00.000.0000');
  assert.equal(l.renglones[2][4], 868778.2805);
  assert.match(LECTOR([[['hola', 'chau'], [1, 2]]]).error, /No reconozco este archivo como un libro diario/);
});

// ══ 3 · GUARDAR, Y QUE LA SEGUNDA CARGA REEMPLACE SU PERÍODO ══════════════════════════

test('cada carga reemplaza su período, de la primera a la última fecha, y lo de afuera queda', () => {
  const db = base();
  const R = rutas(db);
  const a = llamar(R.cargar, { body: CARGA_A });
  assert.equal(a.code, 200, JSON.stringify(a.body));
  assert.equal(a.body.data.reemplazados, 0);
  const b = llamar(R.cargar, { body: CARGA_B });
  assert.equal(b.body.data.desde, '2025-08-02');
  assert.equal(b.body.data.hasta, '2025-09-10');
  assert.equal(b.body.data.reemplazados, 4, 'reemplaza los cuatro renglones de agosto de la primera');
  const fechas = db.prepare('SELECT fecha, COUNT(*) n FROM pl_abasto_movimientos GROUP BY fecha ORDER BY fecha').all()
    .map((x) => [x.fecha, x.n]);
  assert.deepEqual(fechas, [['2025-07-13', 3], ['2025-08-02', 2], ['2025-09-10', 2]]);
  const cargas = db.prepare('SELECT archivo, usuario_id, renglones FROM pl_abasto_cargas ORDER BY id').all();
  assert.deepEqual(cargas.map((x) => [x.archivo, x.usuario_id, x.renglones]), [['diario_a.xls', 5, 7], ['diario_b.xls', 5, 4]]);
  // Uno malo no guarda nada.
  const mala = llamar(R.cargar, { body: { renglones: [['2025-10-01', '1', '4.1', 1, 0], ['no', '1', '4.1', 1, 0]] } });
  assert.equal(mala.code, 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pl_abasto_movimientos WHERE fecha = '2025-10-01'").get().n, 0);
});

test('un archivo que borra más de lo que trae, o le cambia el nombre a las cuentas, pide confirmar', () => {
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_A });
  // El mismo período con menos renglones: parece otro archivo, o uno recortado.
  const recortado = { archivo: 'otro.xls', cuentas: NOMBRES, renglones: CARGA_A.renglones.slice(0, 3)
    .concat([['2025-08-20', '381000', '4.2.05.02.006.0000', 12000, 0]]) };
  const p = llamar(R.previa, { body: { desde: '2025-07-13', hasta: '2025-08-20', entran: 4, cuentas: NOMBRES } }).body.data;
  assert.equal(p.existentes, 7);
  assert.equal(p.avisos.length, 1);
  assert.match(p.avisos[0], /trae 4 renglones y reemplaza 7/);
  const sin = llamar(R.cargar, { body: recortado });
  assert.equal(sin.code, 409);
  assert.equal(sin.body.requiere_confirmar, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pl_abasto_movimientos').get().n, 7, 'borró sin confirmar');
  const con = llamar(R.cargar, { body: Object.assign({ confirmar: true }, recortado) });
  assert.equal(con.code, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pl_abasto_movimientos').get().n, 4);
  // Seis cuentas conocidas con otro nombre: de otra empresa.
  const otrosNombres = Object.fromEntries(Object.keys(NOMBRES).map((c) => [c, 'OTRA ' + c]));
  const q = llamar(R.previa, { body: { desde: '2026-01-01', hasta: '2026-01-31', entran: 10, cuentas: otrosNombres } }).body.data;
  assert.equal(q.existentes, 0);
  // Las siete que ya se conocían (la de electricidad nunca se cargó).
  assert.equal(q.distintos, 7);
  assert.match(q.avisos[0], /7 cuentas que ya estaban cargadas tienen otro nombre/);
  assert.equal(q.ejemplos.length, 5);
  const deOtra = Object.keys(NOMBRES).map((c, i) => ['2026-01-05', String(900 + i), c, 0, 1]);
  assert.equal(llamar(R.cargar, { body: { cuentas: otrosNombres, renglones: deOtra } }).code, 409);
  assert.equal(db.prepare("SELECT nombre FROM pl_abasto_cuentas WHERE cuenta = '4.1.01.00.000.0000'").get().nombre, 'VENTAS',
    'le cambió el nombre a las cuentas sin confirmar');
  assert.equal(llamar(R.previa, { body: { desde: 'ayer', hasta: '2026-01-31' } }).code, 400);
});

test('el cuadro: haber − debe por cuenta y mes, sólo las de resultado, con su rubro', () => {
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_A });
  llamar(R.cargar, { body: CARGA_B });
  const d = llamar(R.resultado, { query: { desde: '2025-07', hasta: '2025-09' } }).body.data;
  assert.deepEqual(d.meses, ['2025-07', '2025-08', '2025-09']);
  const porCuenta = Object.fromEntries(d.cuentas.map((c) => [c.cuenta, c]));
  assert.deepEqual(Object.keys(porCuenta).sort(), ['4.1.01.00.000.0000', '4.1.01.01.000.0000', '4.2.04.14.000.0000']);
  assert.equal(porCuenta['4.1.01.00.000.0000'].meses['2025-07'], 868778.28, 'la venta es positiva');
  assert.equal(porCuenta['4.1.01.01.000.0000'].meses['2025-08'], -700000, 'la compra es negativa, y es la de la segunda carga');
  assert.equal(porCuenta['4.1.01.01.000.0000'].rubro, 'costos_variables');
  assert.equal(porCuenta['4.2.04.14.000.0000'].rubro, 'otros');
  assert.equal(porCuenta['4.2.04.14.000.0000'].elegido, 0);
  assert.equal(d.ultima_carga.archivo, 'diario_b.xls');
  assert.equal(d.ultima_carga.usuario, 'Pablo');
  // Sin período: los últimos doce meses que haya.
  const sin = llamar(R.resultado, {}).body.data;
  assert.equal(sin.desde, '2025-07');
  assert.equal(sin.hasta, '2025-09');
});

test('la clasificación se guarda, pisa la de por defecto, y se puede volver atrás', () => {
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_B });
  assert.equal(llamar(R.rubros, { body: { rubros: { '4.2.04.14.000.0000': 'ganancias' } } }).code, 400);
  assert.equal(llamar(R.rubros, { body: { rubros: { '1.1.01.03.001.0000': 'otros' } } }).code, 400,
    'deja clasificar una cuenta del patrimonio');
  assert.equal(llamar(R.rubros, { body: { rubros: { '4.2.04.14.000.0000': 'costos_fijos' } } }).code, 200);
  const c = llamar(R.cuentas, {}).body.data.cuentas.find((x) => x.cuenta === '4.2.04.14.000.0000');
  assert.equal(c.rubro, 'costos_fijos');
  assert.equal(c.rubro_defecto, 'otros');
  assert.equal(c.elegido, 1);
  assert.equal(llamar(R.restablecer, {}).body.data.borradas, 1);
  assert.equal(llamar(R.cuentas, {}).body.data.cuentas.find((x) => x.cuenta === '4.2.04.14.000.0000').rubro, 'otros');
  // Las cuentas del patrimonio no se ofrecen para clasificar.
  assert.ok(!llamar(R.cuentas, {}).body.data.cuentas.some((x) => /^[123]/.test(x.cuenta)));
  // Volver a los de por defecto borra trabajo hecho: va por DELETE, que pide anular.
  assert.match(RUTA, /router\.delete\('\/rubros', requireAuth,/);
  assert.ok(!/rubros\/restablecer/.test(RUTA));
});

test('los asientos de un importe: con la contrapartida, y el total de todos aunque se recorten', () => {
  const db = base();
  llamar(rutas(db).cargar, { body: CARGA_A });
  const d = llamar(rutas(db).detalle, { query: { rubro: 'ventas', desde: '2025-07', hasta: '2025-07' } }).body.data;
  assert.equal(d.filas.length, 1);
  assert.equal(d.filas[0].contrapartida, 'IVA Debito Fiscal · CRUZ OSCAR FABIAN');
  assert.deepEqual({ ...d.total }, { renglones: 1, debe: 0, haber: 868778.28 });
  assert.equal(d.recortado, 0);
  const todo = llamar(rutas(db, { detalleMax: 1 }).detalle,
    { query: { rubro: 'otros', desde: '2025-08', hasta: '2025-08' } }).body.data;
  assert.equal(todo.filas.length, 0, 'intereses es financiero, no otros');
  assert.equal(llamar(rutas(db).detalle, { query: { cuenta: '1.1.01.03.001.0000', desde: '2025-08', hasta: '2025-08' } }).code, 400);
  assert.equal(llamar(rutas(db).detalle, { query: { rubro: 'ventas' } }).code, 400);
  llamar(rutas(db).cargar, { body: { cuentas: NOMBRES, renglones: [
    ['2025-07-14', '400', '4.1.01.00.000.0000', 0, 10], ['2025-07-15', '401', '4.1.01.00.000.0000', 0, 20]] } });
  const corto = llamar(rutas(db, { detalleMax: 2 }).detalle, { query: { rubro: 'ventas', desde: '2025-07', hasta: '2025-07' } }).body.data;
  assert.equal(corto.filas.length, 2);
  assert.equal(corto.total.renglones, 3);
  assert.equal(corto.recortado, 1);
  assert.equal(corto.filas[0].fecha, '2025-07-15', 'los más recientes primero');
});

// ══ 4 · LA PANTALLA ════════════════════════════════════════════════════════════════

const PANTALLA = (datos, abiertos = {}, unidad) => {
  const tb = { innerHTML: '' };
  new Function('PLA', 'eid', 'escH', [
    /^var PLA_MES = .*;\r?$/m.exec(PANEL)[0],
    hasta(PANEL, 'var PLA_SUBTOTALES = [', '];'),
    fuente(PANEL, 'function plaMesTxt(m){'),
    fuente(PANEL, 'function plaMesCorto(m){'),
    fuente(PANEL, 'function plaImporte(v){'),
    fuente(PANEL, 'function plaTotales(d){'),
    fuente(PANEL, 'function plaUnidadGuardada(){'),
    fuente(PANEL, 'function plaUnidadAuto(T){'),
    fuente(PANEL, 'function plaCelda(v, ventas, conPct){'),
    fuente(PANEL, 'function plaPintar(){'),
    'plaPintar();',
  ].join('\n'))({ datos, abiertos, unidad }, () => tb, (x) => String(x));
  return tb.innerHTML;
};
const TOTALES = new Function([
  hasta(PANEL, 'var PLA_SUBTOTALES = [', '];'),
  fuente(PANEL, 'function plaTotales(d){'),
  'return plaTotales;',
].join('\n'))();
const RUBROS = SVC.RUBROS;
const DATOS = {
  rubros: RUBROS, meses: ['2025-07', '2025-08'], meses_disponibles: ['2025-07', '2025-08'],
  cuentas: [
    { cuenta: '4.1.01', nombre: 'VENTAS', rubro: 'ventas', meses: { '2025-07': 1000, '2025-08': 1500 } },
    { cuenta: '4.1.02', nombre: 'COMISIONES', rubro: 'ventas', meses: { '2025-08': 3500 } },
    { cuenta: '4.2.01', nombre: 'COSTO', rubro: 'costos_variables', meses: { '2025-07': -400, '2025-08': -900 } },
    { cuenta: '4.2.05', nombre: 'INTERESES', rubro: 'costos_financieros', meses: { '2025-08': -100 } },
    { cuenta: '4.2.06', nombre: 'IIBB', rubro: 'impuestos', meses: { '2025-07': -50 } },
    { cuenta: '4.9.99', nombre: 'FUERA', rubro: 'sin_asignar', meses: { '2025-07': -99999 } },
  ],
};

test('la cascada suma: margen bruto, EBITDA, EBT y resultado neto', () => {
  const T = TOTALES(DATOS);
  assert.deepEqual(T.rubros.ventas, { '2025-07': 1000, '2025-08': 5000, TOTAL: 6000 });
  assert.deepEqual(T.subtotales.margen, { '2025-07': 600, '2025-08': 4100, TOTAL: 4700 });
  assert.deepEqual(T.subtotales.ebitda, T.subtotales.margen, 'sin costos fijos, el EBITDA es el margen');
  assert.deepEqual(T.subtotales.ebt, { '2025-07': 600, '2025-08': 4000, TOTAL: 4600 });
  assert.deepEqual(T.subtotales.neto, { '2025-07': 550, '2025-08': 4000, TOTAL: 4550 }, 'sin asignar entró al resultado');
  assert.deepEqual(T.cuentas.ventas.map((x) => x.c.cuenta), ['4.1.02', '4.1.01']);
  // Adentro de los gastos, el más negativo arriba.
  assert.deepEqual(TOTALES(Object.assign({}, DATOS, { cuentas: [
    { cuenta: 'a', rubro: 'otros', meses: { '2025-07': -10 } },
    { cuenta: 'b', rubro: 'otros', meses: { '2025-07': -500 } }] })).cuentas.otros.map((x) => x.c.cuenta), ['b', 'a']);
});

test('la tabla: el mes más nuevo a la izquierda, los subtotales siempre, y las cuentas al abrir', () => {
  const h = PANTALLA(DATOS);
  assert.ok(h.indexOf('>TOTAL</th>') < h.indexOf('>Ago 25</th>'));
  assert.ok(h.indexOf('>Ago 25</th>') < h.indexOf('>Jul 25</th>'), 'los meses no van del más nuevo al más viejo');
  assert.match(h, /<th title="Ago 2025">Ago 25<\/th>/);
  for (const t of ['MARGEN BRUTO', 'EBITDA', 'EBT (antes de impuestos)', '⭐ RESULTADO NETO']) assert.ok(h.includes(t), t);
  assert.ok(!h.includes('Costos fijos'), 'muestra un rubro vacío');
  assert.ok(!h.includes('FUERA'));
  assert.ok(!h.includes('4.1.01 · VENTAS'), 'las cuentas se ven sin abrir el rubro');
  assert.match(h, /<span class="pla-pct">82%<\/span>/, 'el % sobre ventas del margen de agosto');
  assert.match(h, /ondblclick="plaDetalle\('rubro','ventas','2025-08'\)"/);
  const abierto = PANTALLA(DATOS, { ventas: true });
  assert.ok(abierto.includes('4.1.01 · VENTAS'));
  assert.match(abierto, /ondblclick="plaDetalle\('cuenta','4\.1\.01','TOTAL'\)"/);
  assert.match(h, /<span class="pla-neg">-400<\/span>/, 'el gasto no sale en rojo con el signo');
});

test('los importes grandes se ven en millones, y el exacto queda en el título', () => {
  const grande = { rubros: RUBROS, meses: ['2026-03'], meses_disponibles: ['2026-03'], cuentas: [
    { cuenta: '4.1.01', nombre: 'VENTAS', rubro: 'ventas', meses: { '2026-03': 11318576484 } }] };
  const h = PANTALLA(grande);
  assert.match(h, /<span class="pla-pos">11\.318,6<\/span>/, 'once cifras no entran en la columna');
  assert.match(h, /title="\$ 11\.318\.576\.484,00"/);
  // Si alguien eligió pesos, se respeta.
  assert.match(PANTALLA(grande, {}, 1), /<span class="pla-pos">11\.318\.576\.484<\/span>/);
  assert.match(PANEL, /<select id="pla-unidad" data-sin-buscador="1" onchange="plaUnidadCambiar\(\)">/);
});

test('hasta doce meses CON DATOS por vez, y la ventana de subir se abre en blanco', () => {
  const c = fuente(PANEL, 'function plaCargar(inicial){');
  assert.match(c, /var dentro = \(\(PLA\.datos \|\| \{\}\)\.meses_disponibles \|\| \[\]\)\.filter\(function\(m\)\{ return m >= de && m <= ha; \}\)\.length;/);
  assert.match(c, /if \(dentro > 12\) \{ toast\('Elegí hasta 12 meses por vez'/);
  const abrir = fuente(PANEL, 'function plaCargaAbrir(){');
  assert.match(abrir, /PLA\.lectura = null;/);
  assert.match(abrir, /PLA\.previa = null;/);
  assert.match(abrir, /if \(a\) a\.value = '';/);
  assert.match(abrir, /b\.disabled = true;/);
  // Y guardar no la cierra: queda lo que se reemplazó.
  assert.ok(!/closeMB/.test(fuente(PANEL, 'function plaCargaGuardar(){')));
});

test('antes de guardar pide la previa, y con avisos no deja guardar sin tildar', () => {
  assert.match(fuente(PANEL, 'function plaCargaArchivo(input){'), /api\('\/api\/pl-abasto\/previa', 'POST'/);
  const boton = new Function('PLA', 'eid', fuente(PANEL, 'function plaCargaBoton(){') + '\nreturn plaCargaBoton;');
  const els = { 'pla-carga-btn': { disabled: false }, 'pla-carga-confirma': null };
  const eid = (id) => els[id];
  boton({ lectura: {}, previa: { avisos: ['x'] } }, eid)();
  assert.equal(els['pla-carga-btn'].disabled, true, 'deja guardar un archivo sospechoso sin confirmar');
  els['pla-carga-confirma'] = { checked: true };
  boton({ lectura: {}, previa: { avisos: ['x'] } }, eid)();
  assert.equal(els['pla-carga-btn'].disabled, false);
  els['pla-carga-confirma'] = null;
  boton({ lectura: {}, previa: { avisos: [] } }, eid)();
  assert.equal(els['pla-carga-btn'].disabled, false);
  boton({ lectura: {}, previa: null }, eid)();
  assert.equal(els['pla-carga-btn'].disabled, true, 'deja guardar antes de saber qué se reemplaza');
  assert.match(fuente(PANEL, 'function plaCargaGuardar(){'), /confirmar: !!\(chk && chk\.checked\)/);
});

test('el saldo del detalle tiene el signo de la celda: haber − debe', () => {
  const p = fuente(PANEL, 'function plaDetallePintar(){');
  assert.match(p, /SALDO \(Haber − Debe, como en el cuadro\)/);
  assert.match(p, /plaImporte\(Math\.round\(\(tH - tD\) \* 100\) \/ 100\)/);
});

// ══ 5 · EL MENÚ, LA DIRECCIÓN Y EL PERMISO ═══════════════════════════════════════════

test('está en el menú de Informes, con su dirección controlada al leer y al escribir', () => {
  const IX = leer('src/index.js');
  assert.match(IX, /import plAbastoRouter\s+from "\.\/rutas\/pl_abasto\.js";/);
  assert.match(IX, /app\.use\("\/api\/pl-abasto", plAbastoRouter\);/);
  const ORG = leer('src/servicios/db_org.js');
  const i = ORG.indexOf('import "./ensure_modulo_pl_abasto.js";');
  assert.ok(i > 0 && i < ORG.indexOf('import "./ensure_modulo_empresas.js";') && i < ORG.indexOf('import "./ensure_api_prefijos.js";'));
  const MOD = leer('src/servicios/ensure_modulo_pl_abasto.js');
  assert.match(MOD, /\.run\('pl-abasto', '📊 P&L Abasto', 'Informes', socId, 'numero', 682\)/);
  assert.match(MOD, /nombre LIKE '%Ger%nimo%'/);
  assert.match(leer('src/servicios/ensure_api_prefijos.js'), /\['pl-abasto', 'pl-abasto'\],/);
  const PER = leer('src/servicios/permisos.js');
  assert.match(hasta(PER, 'const LECTURA_CONTROLADA = new Set([', ']);'), /'\/api\/pl-abasto',/);
  assert.match(PANEL, /<div class="ni" data-sec="pl-abasto"><\/div>/);
  assert.match(PANEL, /'pl-abasto': function\(\)\{ plaInit\(\); \},/);
  assert.match(PANEL, /<div class="sec sg-mod" id="sec-pl-abasto">/);
  const ini = fuente(PANEL, 'function plaInit(){');
  // Al que sólo mira no se le ofrece subir ni guardar; volver a los de por defecto pide anular.
  assert.match(ini, /var op = lnbPuedeOperar\('pl-abasto'\), an = lnbPuedeAnular\('pl-abasto'\);/);
  assert.match(ini, /var rs = eid\('pla-rub-reset'\); if \(rs\) rs\.style\.display = an \? '' : 'none';/);
  // Y se entra limpio: lo arrastrado sin guardar no queda esperando.
  assert.match(ini, /PLA\.cuentas = null;\r?\n\s+PLA\.pend = \{\};/);
  assert.match(fuente(PANEL, 'function plaRubrosRestablecer(){'), /api\('\/api\/pl-abasto\/rubros', 'DELETE'\)/);
});

// ══ 6 · EL «¿CÓMO SE USA?» DICE LO QUE EL CÓDIGO HACE ═════════════════════════════════

const manual = () => {
  const i = PANEL.indexOf('SG_MANUAL.plabasto = {');
  assert.ok(i > 0, 'la pantalla no tiene manual');
  return PANEL.slice(i, PANEL.indexOf('\r\n};', i)).replace(/'\r?\n\s*\+ '/g, '');
};

test('manual: reemplaza el período del archivo, haber − debe, hasta 12 meses, sólo resultado', () => {
  const M = manual();
  assert.match(PANEL, /onclick="sgManualAbrir\('plabasto'\)">❓ ¿Cómo se usa\?<\/button>/);
  assert.match(M, /<b>reemplaza lo cargado entre la primera y la última fecha del archivo<\/b>; lo de afuera no se toca/);
  assert.match(RUTA, /DELETE FROM pl_abasto_movimientos WHERE fecha BETWEEN \? AND \?/);
  assert.match(M, /Si el archivo trae menos de los que borra, o le cambia el nombre a varias cuentas conocidas —puede ser de otra empresa o estar recortado—, <b>pide confirmar<\/b>/);
  assert.match(M, /El importe de cada cuenta es <b>haber − debe<\/b>/);
  assert.match(RUTA, /ROUND\(SUM\(haber\) - SUM\(debe\), 2\) AS importe/);
  assert.match(M, /<b>Hasta 12 meses por vez<\/b>/);
  assert.match(M, /Los importes se ven en <b>pesos, miles o millones<\/b>/);
  assert.match(M, /Sólo entran las <b>cuentas de resultado<\/b>\. Las que empiezan con 1, 2 o 3 son del patrimonio/);
  assert.equal(SVC.esCuentaDeResultado('1.1.01'), false);
  assert.match(M, /Lee <b>todas las hojas<\/b>/);
  assert.match(fuente(PANEL, 'function plaCargaArchivo(input){'), /wb\.SheetNames\.map\(function\(n\)\{/);
  assert.match(M, /<b>lo avisa y lo guarda igual<\/b>/);
  assert.match(M, /el resto del 4\.1, a ventas —salvo lo que el mismo plan marca como gasto con «G -», que va a Otros—/);
  assert.equal(SVC.rubroPorDefecto('4.1.13.00.000.0000', 'G - Alquiler espacio físico'), 'otros');
  assert.match(M, /<b>Costos fijos arranca vacío\.<\/b>/);
  assert.ok(!SVC.RUBROS.some((r) => r.k === 'costos_fijos' && /costos_fijos/.test(fuente(leer('src/servicios/pl_abasto.js'), 'export function rubroPorDefecto('))));
  assert.match(M, /cuando el otro sistema la cargó con su cobro en el mismo asiento/);
  assert.match(M, /<b>Volver a los de por defecto<\/b> borra toda la clasificación guardada, y por eso pide el nivel <b>Anular<\/b>/);
  assert.match(M, /Subir el libro diario y guardar los rubros pide <b>Operar<\/b>; volver los rubros a los de por defecto, <b>Anular<\/b>/);
});

test('los manuales no citan una versión que el panel todavía no alcanzó', () => {
  const actual = Number((leer('src/sidebar-v2.js').match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const v of (manual().match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
    assert.ok(v <= actual, `el manual cita la V${v} y el panel va en la V${actual}`);
  }
});
