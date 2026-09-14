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
    'const { RUBROS, SIN_ASIGNAR, esRubro, esCuentaDeResultado, rubroPorDefecto, validarCarga, avisosDeReemplazo, asientosSinPareja, validarAjuste, TIPOS_DOLAR, esTipoDolar, promedioMensual, validarCotizaciones } = SVC;',
    lineaConst('MES'),
    lineaConst('NB_MAX'),
    lineaConst('COTIZ_URL'),
    lineaConst('COTIZ_TIMEOUT_MS'),
    lineaConst('FECHA'),
    detalleMax ? 'const DETALLE_MAX = ' + detalleMax + ';' : lineaConst('DETALLE_MAX'),
    fuente(RUTA, 'function r2('),
    fuente(RUTA, 'function usuarioId('),
    fuente(RUTA, 'function rubrosDeCuentas('),
    fuente(RUTA, 'function contrapartidas('),
    fuente(RUTA, 'function reemplazo('),
    fuente(RUTA, 'function ajusteVivo('),
    fuente(RUTA, 'function escribirMesesDeAjuste('),
    fuente(RUTA, 'function ajustesDelPeriodo('),
    fuente(RUTA, 'function cotizacionesDelPeriodo('),
    fuente(RUTA, 'async function traerCotizaciones('),
    'return {',
    '  previa: ' + handler("router.post('/previa'") + ',',
    '  cargar: ' + handler("router.post('/cargar'") + ',',
    '  resultado: ' + handler("router.get('/resultado'") + ',',
    '  cuentas: ' + handler("router.get('/cuentas'") + ',',
    '  rubros: ' + handler("router.put('/rubros'") + ',',
    '  restablecer: ' + handler("router.delete('/rubros'") + ',',
    '  detalle: ' + handler("router.get('/detalle'") + ',',
    '  noBalancea: ' + handler("router.get('/no-balancea'") + ',',
    '  ajusteNuevo: ' + handler("router.post('/ajustes'") + ',',
    '  ajusteCorregir: ' + handler("router.put('/ajustes/:id'") + ',',
    '  ajusteEliminar: ' + handler("router.delete('/ajustes/:id'") + ',',
    '  cotizaciones: ' + handler("router.get('/cotizaciones'") + ',',
    '  cotizGuardar: ' + handler("router.put('/cotizaciones'") + ',',
    '  traer: traerCotizaciones,',
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

const PANTALLA = (datos, abiertos = {}, unidad, op, moneda) => {
  const tb = { innerHTML: '' };
  new Function('PLA', 'eid', 'escH', [
    /^var PLA_MES = .*;\r?$/m.exec(PANEL)[0],
    hasta(PANEL, 'var PLA_SUBTOTALES = [', '];'),
    fuente(PANEL, 'function plaMesTxt(m){'),
    fuente(PANEL, 'function plaMesCorto(m){'),
    fuente(PANEL, 'function plaImporte(v, usd){'),
    fuente(PANEL, 'function plaTotales(d){'),
    fuente(PANEL, 'function plaUnidadClave(){'),
    fuente(PANEL, 'function plaEnMoneda(d, moneda){'),
    fuente(PANEL, 'function plaUnidadGuardada(){'),
    fuente(PANEL, 'function plaUnidadAuto(T){'),
    fuente(PANEL, 'function plaCelda(v, ventas, conPct){'),
    fuente(PANEL, 'function plaPintar(){'),
    'plaPintar();',
  ].join('\n'))({ datos, abiertos, unidad, op, moneda }, () => tb, (x) => String(x));
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

// ══ 5 · LO QUE NO BALANCEA (V1053) ═══════════════════════════════════════════════════
//
// Pablo, 14/9/2026: «esto de que el asiento no balancea es perfecto, necesito que me lo
// agregues como una solapa, con el detalle de todo lo que no balancea».

test('lo que no balancea: las dos mitades de una operación se compensan, y los que quedan solos suman la diferencia', () => {
  const A = (asiento, fecha, debe, haber) => ({ asiento, fecha, debe, haber });
  const r = SVC.asientosSinPareja([
    A('372811', '2026-07-06', 6795000, 0),      // la compra
    A('372977', '2026-07-06', 0, 6795000),      // su pago, en otro número: se compensan
    A('373340', '2026-07-06', 0, 2762500),      // sola
    A('380001', '2026-07-07', 0, 6795000),      // opuesta a la compra pero de OTRO día: no es su pareja
    A('14', '2026-07-06', 100, 0), A('15', '2026-07-06', 100, 0), A('16', '2026-07-06', 0, 100),
    A('17', '2026-07-06', 50, 50),              // cierra: no es de lo que no balancea
  ]);
  assert.equal(r.emparejados, 4);
  assert.deepEqual(r.solos.map((x) => x.asiento), ['380001', '373340', '15'],
    'el día más nuevo arriba, y adentro la diferencia más grande');
  const delDia = r.solos.filter((x) => x.fecha === '2026-07-06').reduce((s, x) => s + x.debe - x.haber, 0);
  assert.equal(delDia, 6795000 - 6795000 - 2762500 + 100 + 100 - 100, 'los que quedan solos no suman la diferencia del día');
});

test('la solapa No balancea: los días que no cierran, sus asientos sin pareja con renglones, y todo lo cargado', () => {
  const db = base();
  const R = rutas(db);
  const N = Object.assign({}, NOMBRES, { '1.1.01.03.006.0000': 'Cheques Propios', '1.1.03.01.000.6105': 'CENCOSUD' });
  assert.equal(llamar(R.cargar, { body: { cuentas: N, renglones: [
    // 6/7: la compra y su pago en dos números (se compensan), y un cobro de CENCOSUD solo.
    ['2026-07-06', '372811', '4.1.01.01.000.0000', 6795000, 0],
    ['2026-07-06', '372977', '1.1.01.03.006.0000', 0, 6795000],
    ['2026-07-06', '373340', '1.1.03.01.000.6105', 0, 12323225.19],
    // 7/7: un asiento completo.
    ['2026-07-07', '373400', '4.1.01.00.000.0000', 0, 1000], ['2026-07-07', '373400', '1.1.01.03.001.0000', 1000, 0],
    // 8/8: dos asientos que no cierran solos, pero el día sí.
    ['2026-08-08', '374003', '4.1.01.01.000.0000', 4080000, 0],
    ['2026-08-08', '374160', '1.1.01.03.006.0000', 0, 2040000], ['2026-08-08', '374160', '1.1.01.03.006.0000', 0, 2040000],
    // 9/9: una venta al súper que no cierra, con dos renglones.
    ['2026-09-09', '380782', '4.1.01.00.000.0000', 0, 1596672], ['2026-09-09', '380782', '1.1.03.01.000.6105', 1796256, 0],
  ] } }).code, 200);
  const d = llamar(R.noBalancea, {}).body.data;
  assert.equal(d.desde, '2026-07', 'sin período no muestra todo lo cargado');
  assert.equal(d.hasta, '2026-09');
  assert.deepEqual(d.dias.map((x) => [x.fecha, x.diferencia]), [['2026-09-09', 199584], ['2026-07-06', -12323225.19]]);
  assert.equal(d.total.diferencia, -12123641.19);
  assert.equal(d.no_cierran, 4, 'los del 8/8 cuentan, y ese día balancea');
  assert.equal(d.emparejados, 2);
  assert.equal(d.sin_pareja, 2);
  assert.deepEqual(d.dias[1].asientos.map((a) => [a.asiento, a.diferencia]), [['373340', -12323225.19]]);
  assert.deepEqual(d.dias[1].asientos[0].renglones,
    [{ cuenta: '1.1.03.01.000.6105', nombre: 'CENCOSUD', debe: 0, haber: 12323225.19 }]);
  assert.equal(d.dias[0].asientos[0].renglones.length, 2);
  assert.deepEqual(llamar(R.noBalancea, { query: { desde: '2026-09', hasta: '2026-09' } }).body.data.dias.map((x) => x.fecha),
    ['2026-09-09']);
  assert.deepEqual(llamar(R.noBalancea, { query: { desde: '2026-08', hasta: '2026-08' } }).body.data.dias, []);
  // Con más asientos sin pareja que el tope, se recorta y se dice.
  const corto = llamar(rutasConNb(db, 1).noBalancea, {}).body.data;
  assert.equal(corto.recortado, 1);
  assert.equal(corto.dias.reduce((s, x) => s + x.asientos.length, 0), 1);
});

// Las rutas con otro tope de asientos sin pareja.
function rutasConNb(db, max) {
  return new Function('db', 'SVC', [
    'const { asientosSinPareja } = SVC;', lineaConst('MES'), 'const NB_MAX = ' + max + ';', fuente(RUTA, 'function r2('),
    'return { noBalancea: ' + handler("router.get('/no-balancea'") + ' };'].join('\n'))(db, SVC);
}

test('la solapa en la pantalla: el día cerrado, al abrirlo sus asientos y renglones, y el resumen de las parejas', () => {
  const els = { 'pla-nb-tabla': { innerHTML: '' }, 'pla-nb-resumen': { innerHTML: '' } };
  const pintar = (nb, abiertos) => new Function('PLA', 'eid', 'escH', 'nr', [
    /^var PLA_MES = .*;\r?$/m.exec(PANEL)[0],
    fuente(PANEL, 'function plaMesTxt(m){'), fuente(PANEL, 'function plaFechaTxt(f){'), fuente(PANEL, 'function plaImporte(v, usd){'),
    fuente(PANEL, 'function plaNbResumen(d){'), fuente(PANEL, 'function plaNbPintar(){'), 'plaNbPintar();',
  ].join('\n'))({ nb, nbAbiertos: abiertos || {} }, (id) => els[id], String, String);
  const NB = { meses_disponibles: ['2026-07'], desde: '2026-07', hasta: '2026-07', total: { diferencia: -12323225.19 },
    no_cierran: 3, emparejados: 2, sin_pareja: 1, recortado: 0,
    dias: [{ fecha: '2026-07-06', debe: 6795000, haber: 19118225.19, diferencia: -12323225.19, asientos: [
      { asiento: '373340', debe: 0, haber: 12323225.19, diferencia: -12323225.19,
        renglones: [{ cuenta: '1.1.03.01.000.6105', nombre: 'CENCOSUD', debe: 0, haber: 12323225.19 }] }] }] };
  pintar(NB);
  const t = els['pla-nb-tabla'].innerHTML, s = els['pla-nb-resumen'].innerHTML;
  assert.match(t, /<tr class="pla-nb-dia" onclick="plaNbToggle\('2026-07-06'\)"><td>▶ 06\/07\/2026<\/td><td>1 asiento sin pareja<\/td>/);
  assert.ok(!t.includes('CENCOSUD'), 'los renglones se ven sin abrir el día');
  assert.match(t, /<span class="pla-neg">-\$ 12\.323\.225,19<\/span>/);
  assert.match(s, /No balancean <b>1 día<\/b>, y lo explican <b>1 asiento sin pareja<\/b>/);
  assert.match(s, /Otros 2 asientos de esos días no cierran solos pero se compensan de a dos/);
  pintar(NB, { '2026-07-06': true });
  assert.match(els['pla-nb-tabla'].innerHTML, /<td>Asiento 373340<\/td><td>1 renglón<\/td>/);
  assert.match(els['pla-nb-tabla'].innerHTML, /1\.1\.03\.01\.000\.6105 · CENCOSUD/);
  pintar(Object.assign({}, NB, { dias: [] }));
  assert.match(els['pla-nb-resumen'].innerHTML, /✓ Del <b>Jul 2026<\/b> al <b>Jul 2026<\/b> el libro diario balancea/);
  // Se pide sola la primera vez que se abre, y una carga nueva la vuelve a pedir.
  assert.match(fuente(PANEL, 'function plaTab(t){'), /if \(t === 'nobalancea' && !PLA\.nb\) plaNbCargar\(true\);/);
  assert.match(fuente(PANEL, 'function plaCargaGuardar(){'), /PLA\.nb = null;/);
  assert.match(PANEL, /<div class="pla-tab" data-pla="nobalancea" onclick="plaTab\('nobalancea'\)">No balancea<\/div>/);
  assert.match(fuente(PANEL, 'function plaResumenLectura(lec, previa){'), /el detalle queda en la solapa «No balancea»/);
});

test('manual V1053: la solapa No balancea dice lo que la ruta hace', () => {
  const M = manual();
  const nb = handler("router.get('/no-balancea'");
  assert.match(M, /<b>los días en que el debe y el haber del libro diario no dan igual<\/b>, del más nuevo al más viejo/);
  assert.match(nb, /GROUP BY fecha HAVING ABS\(SUM\(debe\) - SUM\(haber\)\) >= 0\.005 ORDER BY fecha DESC/);
  assert.match(M, /Sin elegir nada muestra <b>todo lo cargado<\/b>/);
  assert.match(nb, /desde = disponibles\[0\] \|\| '';/);
  assert.match(M, /Esos asientos <b>suman la diferencia del día<\/b>, a lo sumo con unos centavos de redondeo: el otro sistema lleva cuatro decimales/);
  assert.match(fuente(PANEL, 'function plaLeerLibroDiario(hojas){'), /d = Math\.round\(d \* 10000\) \/ 10000;/);
  assert.match(M, /<b>partida en dos números<\/b>/);
  assert.match(M, /Ésos <b>no se listan<\/b>, porque no son error: se cuentan arriba/);
  assert.match(M, /Un día en que lo que no cierra se compensa entero no aparece: ese día balancea/);
  assert.match(M, /<b>lo avisa y lo guarda igual<\/b>: el detalle queda en la solapa <b>No balancea<\/b>/);
  assert.match(M, /<span class="ver">V1053<\/span> Solapa <b>No balancea<\/b>/);
});

// ══ 6 · AJUSTES MANUALES Y EXPORTAR (V1054) ═════════════════════════════════════════

test('un ajuste manual se valida: nombre, uno de los seis rubros, meses y números', () => {
  const ok = SVC.validarAjuste({ nombre: '  Amortización   rodados ', rubro: 'costos_fijos',
    meses: { '2025-08': -150000.456, '2025-07': '', '2025-09': 0, '2025-10': '-2500.5' } });
  assert.equal(ok.error, undefined, ok.error);
  assert.equal(ok.nombre, 'Amortización rodados');
  assert.deepEqual(ok.meses, { '2025-08': -150000.46, '2025-07': null, '2025-09': null, '2025-10': -2500.5 });
  assert.match(SVC.validarAjuste({ nombre: ' ', rubro: 'otros', meses: {} }).error, /Falta el nombre/);
  assert.match(SVC.validarAjuste({ nombre: 'x'.repeat(81), rubro: 'otros', meses: {} }).error, /muy largo/);
  assert.match(SVC.validarAjuste({ nombre: 'x', rubro: 'sin_asignar', meses: {} }).error, /rubro/,
    'un ajuste sin asignar no entraría a ningún lado');
  assert.match(SVC.validarAjuste({ nombre: 'x', rubro: 'ganancias', meses: {} }).error, /rubro/);
  assert.match(SVC.validarAjuste({ nombre: 'x', rubro: 'otros' }).error, /Faltan los importes/);
  assert.match(SVC.validarAjuste({ nombre: 'x', rubro: 'otros', meses: { '2025-13': 1 } }).error, /mes no se entiende/);
  assert.match(SVC.validarAjuste({ nombre: 'x', rubro: 'otros', meses: { '2025-08': 'mucho' } }).error, /no es un número/);
  assert.match(SVC.validarAjuste({ nombre: 'x', rubro: 'otros', meses: { '2025-08': true } }).error, /no es un número/);
});

test('los ajustes: se agregan, se corrigen sólo en los meses que vienen, no quedan vacíos y se eliminan con baja', () => {
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_A });
  llamar(R.cargar, { body: CARGA_B });
  assert.equal(llamar(R.ajusteNuevo, { body: { nombre: 'Vacío', rubro: 'otros', meses: { '2025-08': '' } } }).code, 400,
    'guardó un ajuste sin importes');
  const n = llamar(R.ajusteNuevo, { body: { nombre: 'Amortización', rubro: 'costos_fijos',
    meses: { '2025-07': -1000, '2025-08': -1000, '2025-09': -1000 } } });
  assert.equal(n.code, 200, JSON.stringify(n.body));
  const id = n.body.data.id;
  const periodo = { query: { desde: '2025-07', hasta: '2025-09' } };
  let d = llamar(R.resultado, periodo).body.data;
  assert.equal(d.ajustes.length, 1);
  assert.deepEqual(d.ajustes[0].meses, { '2025-07': -1000, '2025-08': -1000, '2025-09': -1000 });
  assert.equal(d.ajustes[0].rubro, 'costos_fijos');
  assert.equal(d.ajustes[0].creado_por, 'Pablo');
  assert.deepEqual(Object.keys(llamar(R.resultado, { query: { desde: '2025-08', hasta: '2025-08' } }).body.data.ajustes[0].meses),
    ['2025-08'], 'trae meses fuera del período');
  // Corregir: agosto cambia, septiembre se saca, julio no viene y queda como estaba.
  const c = llamar(R.ajusteCorregir, { params: { id: String(id) }, body: { nombre: 'Amortización rodados',
    rubro: 'costos_fijos', meses: { '2025-08': -2500, '2025-09': null } } });
  assert.equal(c.code, 200, JSON.stringify(c.body));
  d = llamar(R.resultado, periodo).body.data;
  assert.deepEqual(d.ajustes[0].meses, { '2025-07': -1000, '2025-08': -2500 });
  assert.equal(d.ajustes[0].nombre, 'Amortización rodados');
  assert.equal(d.ajustes[0].modificado_por, 'Pablo');
  // Vaciarlo no es la manera de sacarlo.
  const vacio = llamar(R.ajusteCorregir, { params: { id: String(id) }, body: { nombre: 'x', rubro: 'costos_fijos',
    meses: { '2025-07': null, '2025-08': '' } } });
  assert.equal(vacio.code, 400);
  assert.match(vacio.body.error, /eliminalo/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pl_abasto_ajuste_meses WHERE ajuste_id = ?').get(id).n, 2, 'lo vació igual');
  assert.equal(db.prepare('SELECT nombre FROM pl_abasto_ajustes WHERE id = ?').get(id).nombre, 'Amortización rodados');
  assert.equal(llamar(R.ajusteCorregir, { params: { id: '999' }, body: { nombre: 'x', rubro: 'otros',
    meses: { '2025-08': 1 } } }).code, 404);
  // Eliminar: baja lógica, con quién y cuándo, y sale del cuadro.
  assert.equal(llamar(R.ajusteEliminar, { params: { id: String(id) } }).code, 200);
  assert.deepEqual(llamar(R.resultado, periodo).body.data.ajustes, []);
  const baja = db.prepare('SELECT eliminado_en, eliminado_por FROM pl_abasto_ajustes WHERE id = ?').get(id);
  assert.ok(baja.eliminado_en, 'lo borró en vez de darlo de baja');
  assert.equal(baja.eliminado_por, 5);
  assert.equal(llamar(R.ajusteEliminar, { params: { id: String(id) } }).code, 404);
  assert.equal(llamar(R.ajusteCorregir, { params: { id: String(id) }, body: { nombre: 'x', rubro: 'otros',
    meses: { '2025-08': 1 } } }).code, 404, 'corrige un ajuste eliminado');
  // Eliminar va por DELETE, que exigirNivel le pide a quien puede anular.
  assert.match(RUTA, /router\.delete\('\/ajustes\/:id', requireAuth,/);
  assert.deepEqual(llamar(R.resultado, { query: { desde: '2030-01', hasta: '2030-02' } }).body.data.ajustes, []);
});

const AJUSTES = [
  { id: 7, rubro: 'costos_fijos', nombre: 'Amortización', meses: { '2025-07': -100, '2025-08': -300, '2025-06': -9999 } },
  { id: 8, rubro: 'ventas', nombre: 'Venta sin factura', meses: { '2025-08': 500 } },
];

test('la cascada suma los ajustes como una cuenta más, sólo en los meses del cuadro', () => {
  const T = TOTALES(Object.assign({}, DATOS, { ajustes: AJUSTES }));
  assert.deepEqual(T.rubros.costos_fijos, { '2025-07': -100, '2025-08': -300, TOTAL: -400 }, 'un mes fuera del cuadro entró al total');
  assert.deepEqual(T.rubros.ventas, { '2025-07': 1000, '2025-08': 5500, TOTAL: 6500 });
  assert.deepEqual(T.subtotales.margen, { '2025-07': 600, '2025-08': 4600, TOTAL: 5200 });
  assert.deepEqual(T.subtotales.ebitda, { '2025-07': 500, '2025-08': 4300, TOTAL: 4800 });
  assert.deepEqual(T.subtotales.neto, { '2025-07': 450, '2025-08': 4200, TOTAL: 4650 });
  assert.deepEqual(T.ajustes.costos_fijos.map((x) => [x.a.id, x.total]), [[7, -400]]);
});

test('la tabla: el ajuste se ve adentro de su rubro, y un rubro con sólo ajustes aparece', () => {
  const datos = Object.assign({}, DATOS, { ajustes: AJUSTES });
  const h = PANTALLA(datos);
  assert.ok(h.includes('Costos fijos'), 'lo cargado a mano en costos fijos no se ve en ningún lado');
  assert.ok(!h.includes('Ajuste: Amortización'), 'el ajuste se ve sin abrir el rubro');
  const abierto = PANTALLA(datos, { costos_fijos: true });
  assert.match(abierto, /<tr class="pla-aju"><td title="✎ Ajuste: Amortización" onclick="plaAjusteAbrir\(7\)">/);
  assert.match(abierto, /ondblclick="plaAjusteAbrir\(7\)"/);
  assert.ok(!abierto.includes('Agregar un ajuste manual'), 'le ofrece cargar un ajuste a quien sólo mira');
  assert.match(PANTALLA(datos, { costos_fijos: true }, undefined, true),
    /onclick="plaAjusteAbrir\(null,'costos_fijos'\)">\+ Agregar un ajuste manual a Costos fijos</);
});

test('los asientos de un rubro traen sus ajustes, y el saldo da lo mismo que la celda', () => {
  const aj = new Function([fuente(PANEL, 'function plaDetalleAjustes(d, rubro, desde, hasta){'), 'return plaDetalleAjustes;'].join('\n'))();
  const datos = Object.assign({}, DATOS, { ajustes: AJUSTES });
  assert.deepEqual(aj(datos, 'ventas', '2025-07', '2025-08'), [{ mes: '2025-08', nombre: 'Venta sin factura', debe: 0, haber: 500 }]);
  assert.deepEqual(aj(datos, 'costos_fijos', '2025-08', '2025-08').map((f) => [f.mes, f.debe, f.haber]), [['2025-08', 300, 0]],
    'un gasto va al debe, y sólo el mes pedido');
  const els = { 'pla-detalle-q': { value: '' }, 'pla-detalle-nota': {}, 'pla-detalle-tabla': {} };
  const pintar = (D) => new Function('PLA', 'eid', 'sgNorm', 'nr', 'escH', [
    /^var PLA_MES = .*;\r?$/m.exec(PANEL)[0],
    fuente(PANEL, 'function plaMesTxt(m){'), fuente(PANEL, 'function plaFechaTxt(f){'), fuente(PANEL, 'function plaImporte(v, usd){'),
    fuente(PANEL, 'function plaDetallePintar(){'), 'plaDetallePintar();'].join('\n'))(
    { detalle: D }, (id) => els[id], (s) => String(s).toLowerCase(), String, String);
  const D = { tipo: 'rubro', recortado: 0, total: { renglones: 1, debe: 0, haber: 5000 },
    filas: [{ fecha: '2025-08-10', asiento: '1', cuenta: '4.1.01', nombre: 'VENTAS', contrapartida: '', debe: 0, haber: 5000 }],
    ajustes: aj(datos, 'ventas', '2025-08', '2025-08') };
  pintar(D);
  const t = els['pla-detalle-tabla'].innerHTML;
  assert.match(t, /TOTAL \(2 movimientos\)/);
  assert.match(t, /como en el cuadro\)<\/b><\/td><td colspan="2" style="text-align:right"><b>\$ 5\.500,00<\/b>/,
    'el saldo no da lo mismo que la celda: 5.000 del libro más 500 del ajuste');
  assert.match(t, /✎ Venta sin factura/);
  pintar({ tipo: 'rubro', recortado: 0, total: { renglones: 0, debe: 0, haber: 0 }, filas: [],
    ajustes: aj(datos, 'costos_fijos', '2025-07', '2025-08') });
  assert.match(els['pla-detalle-tabla'].innerHTML, /como en el cuadro\)<\/b><\/td><td colspan="2" style="text-align:right"><b>-\$ 400,00<\/b>/);
  els['pla-detalle-q'].value = 'factura';
  pintar(D);
  assert.match(els['pla-detalle-tabla'].innerHTML, /TOTAL \(1 movimientos\)/);
  assert.match(fuente(PANEL, 'function plaDetalle(tipo, clave, mes){'),
    /ajustes: tipo === 'rubro' \? plaDetalleAjustes\(d, clave, desde, hasta\) : \[\]/);
});

test('exportar: el cuadro entero, en pesos con centavos, con punto y coma y coma decimal', () => {
  const csv = new Function('PLA', [
    /^var PLA_MES = .*;\r?$/m.exec(PANEL)[0],
    hasta(PANEL, 'var PLA_SUBTOTALES = [', '];'),
    fuente(PANEL, 'function plaMesTxt(m){'),
    fuente(PANEL, 'function plaTotales(d){'),
    fuente(PANEL, 'function plaCsv(d, usd){'),
    'return plaCsv;'].join('\n'))({ unidad: 1e6 });
  const datos = Object.assign({}, DATOS, { ajustes: AJUSTES, cuentas: DATOS.cuentas.concat([
    { cuenta: '4.2.09', nombre: 'Gastos; "varios"', rubro: 'otros', meses: { '2025-07': -12.3 } },
    { cuenta: '4.2.10', nombre: '=HIPERVINCULO("x")', rubro: 'otros', meses: { '2025-08': -1 } }]) });
  const txt = csv(datos);
  assert.ok(txt.startsWith('\ufeff'), 'sin la marca del principio, el Excel lee mal los acentos');
  assert.deepEqual(txt.slice(1).split('\r\n'), [
    'Tipo;Concepto;Cuenta;TOTAL;Ago 2025;Jul 2025',
    'Rubro;Ventas;;6500,00;5500,00;1000,00',
    'Cuenta;COMISIONES;4.1.02;3500,00;3500,00;0,00',
    'Cuenta;VENTAS;4.1.01;2500,00;1500,00;1000,00',
    'Ajuste manual;Venta sin factura;;500,00;500,00;0,00',
    'Rubro;Costos variables;;-1300,00;-900,00;-400,00',
    'Cuenta;COSTO;4.2.01;-1300,00;-900,00;-400,00',
    'Subtotal;MARGEN BRUTO;;5200,00;4600,00;600,00',
    'Rubro;Costos fijos;;-400,00;-300,00;-100,00',
    'Ajuste manual;Amortización;;-400,00;-300,00;-100,00',
    'Subtotal;EBITDA;;4800,00;4300,00;500,00',
    'Rubro;Costos financieros;;-100,00;-100,00;0,00',
    'Cuenta;INTERESES;4.2.05;-100,00;-100,00;0,00',
    'Subtotal;EBT (antes de impuestos);;4700,00;4200,00;500,00',
    'Rubro;Impuestos;;-50,00;0,00;-50,00',
    'Cuenta;IIBB;4.2.06;-50,00;0,00;-50,00',
    'Rubro;Otros;;-13,30;-1,00;-12,30',
    'Cuenta;"Gastos; ""varios""";4.2.09;-12,30;0,00;-12,30',
    'Cuenta;"\'=HIPERVINCULO(""x"")";4.2.10;-1,00;-1,00;0,00',
    'Resultado;RESULTADO NETO;;4636,70;4199,00;437,70',
  ]);
  // Un rubro vacío también va: la estructura es la misma todos los meses.
  assert.ok(csv(DATOS).includes('\r\nRubro;Costos fijos;;0,00;0,00;0,00\r\n'));
  // Y va en pesos aunque la pantalla esté en millones.
  assert.ok(!/PLA\.unidad/.test(fuente(PANEL, 'function plaCsv(d, usd){')));
});

test('la ventana del ajuste: se abre en blanco o con el ajuste, lee los importes, y eliminar pide anular', () => {
  const abrir = fuente(PANEL, 'function plaAjusteAbrir(id, rubro){');
  assert.match(abrir, /PLA\.ajuste = \{ id: a \? a\.id : null \};/);
  assert.match(abrir, /nom\.value = a \? a\.nombre : '';/);
  assert.match(abrir, /sel\.value = a \? a\.rubro : \(rubro \|\| ''\);/);
  assert.match(abrir, /eid\('pla-ajuste-eliminar'\)\.style\.display = \(a && lnbPuedeAnular\('pl-abasto'\)\) \? '' : 'none';/);
  assert.match(fuente(PANEL, 'function plaAjusteEliminar(){'), /api\('\/api\/pl-abasto\/ajustes\/' \+ A\.id, 'DELETE'\)/);
  assert.match(fuente(PANEL, 'function plaAjusteGuardar(){'), /closeMB\('pla-ajuste-modal'\)/);
  const leerAj = new Function([fuente(PANEL, 'function plaNumero(v){'), fuente(PANEL, 'function plaAjusteLeer(inputs){'),
    'return plaAjusteLeer;'].join('\n'))();
  const inp = (mes, value) => ({ value, getAttribute: () => mes });
  assert.deepEqual(leerAj([inp('2025-08', '-150.000,5'), inp('2025-07', ''), inp('2025-06', '0')]),
    { meses: { '2025-08': -150000.5, '2025-07': null, '2025-06': null }, total: -150000.5, malo: null });
  assert.equal(leerAj([inp('2025-08', 'mucho'), inp('2025-07', '1')]).malo, '2025-08');
  const ini = fuente(PANEL, 'function plaInit(){');
  assert.match(ini, /\['pla-subir-btn', 'pla-rub-guardar', 'pla-ajuste-btn'\]\.forEach/);
  assert.match(ini, /PLA\.op = op;/);
  assert.match(PANEL, /<div class="ab-modal-overlay sg-mod" id="pla-ajuste-modal">/);
});

test('manual V1054: los ajustes van con su signo y se corrigen por mes, eliminar pide anular, y el CSV va en pesos', () => {
  const M = manual();
  assert.match(M, /<b>Cada importe va con el signo con que pesa en el resultado<\/b>: un gasto en negativo/);
  assert.match(fuente(PANEL, 'function plaTotales(d){'), /var v = Number\(a\.meses\[m\]\) \|\| 0; rub\[a\.rubro\]\[m\] \+= v;/);
  assert.match(M, /La ventana muestra <b>los meses del período que se está mirando<\/b>; los otros meses del mismo ajuste quedan como estaban/);
  assert.match(M, /Aparece <b>adentro de su rubro<\/b>/);
  assert.match(M, /En los asientos de un rubro \(doble clic\) aparecen también sus ajustes/);
  assert.match(M, /Un ajuste no puede quedar sin importes: para sacarlo se <b>elimina<\/b>, y eso pide el nivel <b>Anular<\/b>/);
  assert.match(M, /<b>⬇️ Exportar CSV<\/b> baja el cuadro del período elegido/);
  assert.match(M, /Los importes van <b>en pesos con centavos<\/b>, aunque en la pantalla se vean en miles o millones/);
  assert.match(M, /<span class="ver">V1054<\/span> Ajustes manuales por rubro, y exportar el cuadro a CSV/);
});

// ══ 6b · EN DÓLARES (V1055) ═════════════════════════════════════════════════════════

test('en dólares: la cotización de cada mes es el promedio de sus días, y la carga a mano se valida', () => {
  assert.deepEqual(SVC.promedioMensual([
    { fecha: '2025-07-01', venta: 1200 }, { fecha: '2025-07-02', venta: 1300 }, { fecha: '2025-07-03', venta: 1284.03 },
    { fecha: '2025-08-01', venta: 0 }, { fecha: '2025-08-02', venta: null }, { fecha: '2025-09-01', venta: 1400 },
  ], ['2025-07', '2025-08']), { '2025-07': 1261.34 }, 'un día sin venta, o un mes que no se pidió, entró al promedio');
  assert.deepEqual(SVC.TIPOS_DOLAR.map((t) => t.k), ['oficial', 'mayorista', 'bolsa', 'blue']);
  assert.deepEqual(SVC.validarCotizaciones({ meses: { '2025-07': '1284.5', '2025-08': '' } }).meses,
    { '2025-07': 1284.5, '2025-08': null });
  assert.match(SVC.validarCotizaciones({ meses: { '2025-07': 0 } }).error, /mayor que cero/);
  assert.match(SVC.validarCotizaciones({ meses: { '2025-07': 'mucho' } }).error, /mayor que cero/);
  assert.match(SVC.validarCotizaciones({ meses: { julio: 1 } }).error, /mes no se entiende/);
  assert.match(SVC.validarCotizaciones({}).error, /No hay cotizaciones/);
});

test('las cotizaciones: se traen del mercado sin pisar las cargadas a mano, y el cuadro las trae', async () => {
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_A });
  llamar(R.cargar, { body: CARGA_B });
  // Julio a mano, antes de traer. Y una de un mes fuera del período, que el cuadro no trae.
  assert.equal(llamar(R.cotizGuardar, { body: { meses: { '2025-07': 1300, '2025-06': 999 } } }).code, 200);
  const pedidos = [];
  const fetchFalso = async (url) => {
    pedidos.push(url);
    return { ok: true, status: 200, json: async () => [
      { fecha: '2025-07-01', venta: 1000 }, { fecha: '2025-08-01', venta: 1250 }, { fecha: '2025-08-02', venta: 1350 }] };
  };
  const t = await R.traer(db, 'blue', 5, fetchFalso);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.deepEqual(pedidos, ['https://api.argentinadatos.com/v1/cotizaciones/dolares/blue']);
  assert.deepEqual(t.body.data, { tipo: 'blue', traidos: 1, manuales: 1, sin_dato: ['2025-09'] });
  const lista = llamar(R.cotizaciones, {}).body.data.meses;
  assert.deepEqual(lista.map((x) => [x.mes, x.cotizacion, x.origen]),
    [['2025-09', null, undefined], ['2025-08', 1300, 'mercado'], ['2025-07', 1300, 'manual']],
    'traer del mercado pisó la cargada a mano');
  assert.equal(lista[1].tipo, 'blue');
  assert.equal(lista[2].modificado_por, 'Pablo');
  // Una fuente que falla no rompe nada, y lo dice.
  const mal = await R.traer(db, 'blue', 5, async () => ({ ok: false, status: 503 }));
  assert.equal(mal.status, 502);
  assert.match(mal.body.error, /No se pudo consultar la cotización \(respondió 503\)/);
  assert.equal((await R.traer(db, 'cripto', 5, fetchFalso)).status, 400, 'trae un dólar que no se ofrece');
  // El cuadro trae la cotización de cada mes del período.
  const d = llamar(R.resultado, { query: { desde: '2025-07', hasta: '2025-09' } }).body.data;
  assert.deepEqual(Object.keys(d.cotizaciones).sort(), ['2025-07', '2025-08']);
  assert.equal(d.cotizaciones['2025-08'].cotizacion, 1300);
  // A mano: vacío la saca, y un número malo no guarda nada.
  assert.equal(llamar(R.cotizGuardar, { body: { meses: { '2025-08': '' } } }).code, 200);
  assert.equal(llamar(R.cotizaciones, {}).body.data.meses[1].cotizacion, null);
  assert.equal(llamar(R.cotizGuardar, { body: { meses: { '2025-09': -5 } } }).code, 400);
  // La ruta la llama con el fetch de verdad.
  assert.match(RUTA, /traerCotizaciones\(db, String\(\(req\.body && req\.body\.tipo\) \|\| ''\), usuarioId\(req\), fetch\)/);
});

test('en dólares: cada mes con su cotización, el total es la suma, y un mes sin cotización se avisa', () => {
  const conv = new Function([fuente(PANEL, 'function plaEnMoneda(d, moneda){'), 'return plaEnMoneda;'].join('\n'))();
  const datos = Object.assign({}, DATOS, { ajustes: AJUSTES,
    cotizaciones: { '2025-07': { cotizacion: 1000 }, '2025-08': { cotizacion: 1250 } } });
  assert.equal(conv(datos, 'ars').datos, datos, 'en pesos no tiene que tocar nada');
  const u = conv(datos, 'usd');
  assert.deepEqual(u.sin, []);
  assert.deepEqual(u.datos.cuentas[0].meses, { '2025-07': 1, '2025-08': 1.2 });
  assert.equal(datos.cuentas[0].meses['2025-07'], 1000, 'pasar a dólares cambió los pesos');
  const T = TOTALES(u.datos);
  assert.deepEqual(T.rubros.ventas, { '2025-07': 1, '2025-08': 4.4, TOTAL: 5.4 },
    'el total en dólares no es la suma de los meses, cada uno con su cotización (el ajuste también se pasa)');
  const sinAgo = conv(Object.assign({}, datos, { cotizaciones: { '2025-07': { cotizacion: 1000 } } }), 'usd');
  assert.deepEqual(sinAgo.sin, ['2025-08']);
  assert.equal(sinAgo.datos.cuentas[1].meses['2025-08'], undefined);
  // La tabla dice U$S, y el exacto también.
  const h = PANTALLA(datos, {}, 1, false, 'usd');
  assert.match(h, /<th>Concepto \(U\$S\)<\/th>/);
  assert.match(h, /title="U\$S 4,40"/);
  assert.match(PANTALLA(datos, {}, 1), /<th>Concepto<\/th>/);
  // El CSV, en la moneda de la pantalla y sin huecos.
  const csv = new Function('PLA', [
    /^var PLA_MES = .*;\r?$/m.exec(PANEL)[0], hasta(PANEL, 'var PLA_SUBTOTALES = [', '];'),
    fuente(PANEL, 'function plaMesTxt(m){'), fuente(PANEL, 'function plaTotales(d){'), fuente(PANEL, 'function plaCsv(d, usd){'),
    'return plaCsv;'].join('\n'))({});
  assert.equal(csv(u.datos, true).slice(1).split('\r\n')[0], 'Tipo;Concepto;Cuenta;TOTAL U$S;Ago 2025;Jul 2025');
  const exp = fuente(PANEL, 'function plaExportar(){');
  assert.match(exp, /if \(usd && conv\.sin\.length\) \{/);
  assert.match(exp, /plaCsv\(conv\.datos, usd\)/);
  // La unidad se recuerda por moneda, y al cambiar de moneda se vuelve a elegir.
  assert.match(fuente(PANEL, 'function plaUnidadClave(){'), /'pla-unidad' \+ \(PLA\.moneda === 'usd' \? '-usd' : ''\)/);
  assert.match(fuente(PANEL, 'function plaMonedaCambiar(){'), /PLA\.unidad = null;/);
});

test('la ventana de cotizaciones: sin dólar por defecto, guarda sólo lo que se cambió, y traer no la cierra', () => {
  const cambios = new Function([fuente(PANEL, 'function plaNumero(v){'), fuente(PANEL, 'function plaCotizCambios(inputs){'),
    'return plaCotizCambios;'].join('\n'))();
  const inp = (mes, value, antes) => ({ value, getAttribute: (k) => (k === 'data-mes' ? mes : antes) });
  assert.deepEqual(cambios([inp('2025-09', '1284,03', '1284.03'), inp('2025-08', '1.530', '1500'),
    inp('2025-07', '', '1300'), inp('2025-06', '', '')]), { meses: { '2025-08': 1530, '2025-07': null }, n: 2, malo: null },
    'guardar volvería «a mano» una cotización traída que nadie tocó');
  assert.equal(cambios([inp('2025-09', '-3', '')]).malo, '2025-09');
  assert.equal(cambios([inp('2025-09', 'mucho', '')]).malo, '2025-09');
  const abrir = fuente(PANEL, 'function plaCotizAbrir(){');
  assert.match(abrir, /'<option value="">¿Qué dólar\?<\/option>'/);
  assert.match(abrir, /PLA\.cotiz = null;/);
  assert.ok(!/closeMB/.test(fuente(PANEL, 'function plaCotizTraer(){')), 'traer cierra la ventana y no se lee qué trajo');
  assert.match(PANEL, /<div class="ab-modal-overlay sg-mod" id="pla-cotiz-modal">/);
});

test('manual V1055: cada mes con su cotización, el promedio del dólar elegido, lo manual gana', () => {
  const M = manual();
  assert.match(M, /Cada mes se pasa a dólares con <b>su cotización<\/b>/);
  assert.match(M, /el <b>promedio del valor venta<\/b> de los días de ese mes/);
  assert.match(M, /<b>No hay un dólar por defecto<\/b>/);
  assert.match(M, /Una cotización <b>cargada a mano gana siempre<\/b>/);
  assert.match(RUTA, /if \(manuales\.has\(mes\)\) continue;/);
  assert.match(M, /El <b>TOTAL<\/b> en dólares es la suma de los meses/);
  assert.match(M, /Un mes <b>sin cotización<\/b> no suma en dólares, y arriba del cuadro se avisa cuál es/);
  assert.match(M, /Los asientos de un importe \(doble clic\) siguen en pesos/);
  assert.ok(!/plaEnMoneda/.test(fuente(PANEL, 'function plaDetalle(tipo, clave, mes){')));
  assert.match(M, /con el cuadro en dólares, sale en dólares; si falta la cotización de algún mes, no se exporta/);
  assert.match(M, /Traer o cargar las cotizaciones del dólar pide <b>Operar<\/b>/);
  assert.match(M, /<span class="ver">V1055<\/span> El cuadro en dólares/);
});

// ══ 7 · EL MENÚ, LA DIRECCIÓN Y EL PERMISO ═══════════════════════════════════════════

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

// ══ 8 · EL «¿CÓMO SE USA?» DICE LO QUE EL CÓDIGO HACE ═════════════════════════════════

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
  assert.match(M, /Subir el libro diario, guardar los rubros y cargar o corregir un ajuste pide <b>Operar<\/b>; volver los rubros a los de por defecto y eliminar un ajuste, <b>Anular<\/b>/);
});

test('los manuales no citan una versión que el panel todavía no alcanzó', () => {
  const actual = Number((leer('src/sidebar-v2.js').match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const v of (manual().match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
    assert.ok(v <= actual, `el manual cita la V${v} y el panel va en la V${actual}`);
  }
});
