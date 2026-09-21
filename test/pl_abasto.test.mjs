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
// La lista y las cajas de Configurar rubros (V1059: se dibujan por separado).
const PINTAR_RUBROS = () => ['function plaRubrosFila(c, titulo){', 'function plaRubrosTitulos(){', 'function plaRubrosBusca(){',
  'function plaRubrosListaPintar(){', 'function plaRubrosZonasPintar(){', 'function plaRubrosTocar(cuenta){',
  'function plaRubrosPintar(){'].map((f) => fuente(PANEL, f));
const lineaVar = (nombre) => {
  const m = new RegExp('^var ' + nombre + ' = .*;\\r?$', 'm').exec(PANEL);
  assert.ok(m, 'no está ' + nombre);
  return m[0];
};
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
    fuente(RUTA, 'function marcarSinPareja('),
    fuente(RUTA, 'function reemplazo('),
    fuente(RUTA, 'function migrarTitulos('),
    fuente(RUTA, 'function ajusteVivo('),
    fuente(RUTA, 'function escribirMesesDeAjuste('),
    fuente(RUTA, 'function ajustesDelPeriodo('),
    fuente(RUTA, 'function cotizacionesDelPeriodo('),
    fuente(RUTA, 'function volverAlPropuesto('),
    fuente(RUTA, 'function migrarCotizaciones('),
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
    '  cotizLimpiar: ' + handler("router.delete('/cotizaciones'") + ',',
    '  traer: traerCotizaciones,',
    '  migrar: migrarTitulos,',
    '  migrarCotiz: migrarCotizaciones,',
    '  asiento: ' + handler("router.get('/asiento'") + ',',
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

test('el título por defecto, con las cuentas reales del libro diario de Abasto', () => {
  const casos = [
    ['4.1.01.00.000.0000', 'VENTAS', 'ventas'],
    ['4.1.02.00.000.0000', 'Comisiones Ganadas - Liquidaciones', 'ventas'],
    ['4.1.05.00.000.0000', 'Fletes Ganados - Liquidaciones', 'ventas'],
    ['4.1.07.01.000.0000', 'Descuentos super', 'descuentos_super'],
    ['4.1.07.03.000.0000', 'Descuento Super - por Ac comerciales', 'descuentos_super'],
    ['4.2.04.19.000.0000', 'G- Descuentos Super - SS On line', 'descuentos_super'],
    // Pablo, 14/9/2026: «yo decido manualmente dónde va cada rubro».
    ['4.1.01.01.000.0000', 'G - COMPRA MERCADERIA', 'sin_asignar'],
    ['4.2.01.00.000.0000', 'Costo de Mercadería Vendida', 'sin_asignar'],
    ['4.1.03.00.000.0001', 'G - Descargas Pagadas', 'sin_asignar'],
    ['4.2.06.07.000.0000', 'Descuentos Cedidos', 'sin_asignar'],
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
    ['4.2.04.14.000.0000', 'G - Electricidad', 'sin_asignar'],
    ['1.1.01.03.001.0000', 'BANCO FRANCES', 'sin_asignar'],
    ['2.1.03.01.000.0000', 'IVA Debito Fiscal', 'sin_asignar'],
    ['3.1.01.00.000.0000', 'Capital', 'sin_asignar'],
  ];
  for (const [c, n, r] of casos) assert.equal(SVC.rubroPorDefecto(c, n), r, c + ' ' + n);
  // Los títulos, en el orden y con las palabras de Pablo.
  assert.deepEqual(SVC.RUBROS.map((x) => x.label), ['VENTAS', 'UTILIDAD', 'DESCUENTOS SUPER',
    'COSTOS ASOCIADOS A LAS VENTAS', 'COSTOS FIJOS', 'COSTOS VARIABLES', 'COSTOS FINANCIEROS', 'IMPUESTOS']);
  assert.ok(!SVC.RUBROS.some((x) => x.k === 'otros'), '«Otros» dejó de existir');
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
  assert.equal(porCuenta['4.1.01.01.000.0000'].rubro, 'sin_asignar');
  assert.equal(porCuenta['4.2.04.14.000.0000'].rubro, 'sin_asignar');
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
  assert.equal(llamar(R.rubros, { body: { rubros: { '9.9.99.99.999.9999': 'costos_fijos' } } }).code, 400,
    'deja clasificar una cuenta que no está en el libro diario');
  assert.equal(llamar(R.rubros, { body: { rubros: { '4.2.04.14.000.0000': 'costos_fijos' } } }).code, 200);
  const c = llamar(R.cuentas, {}).body.data.cuentas.find((x) => x.cuenta === '4.2.04.14.000.0000');
  assert.equal(c.rubro, 'costos_fijos');
  assert.equal(c.rubro_defecto, 'sin_asignar');
  assert.equal(c.elegido, 1);
  assert.equal(llamar(R.restablecer, {}).body.data.borradas, 1);
  assert.equal(llamar(R.cuentas, {}).body.data.cuentas.find((x) => x.cuenta === '4.2.04.14.000.0000').rubro, 'sin_asignar');
  // Las del patrimonio también se ofrecen, marcadas, y arrancan sin título.
  const banco = llamar(R.cuentas, {}).body.data.cuentas.find((x) => x.cuenta === '1.1.01.03.001.0000');
  assert.equal(banco.resultado, 0);
  assert.equal(banco.rubro, 'sin_asignar');
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
    { query: { rubro: 'costos_fijos', desde: '2025-08', hasta: '2025-08' } }).body.data;
  assert.equal(todo.filas.length, 0, 'intereses es financiero, no costos fijos');
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

let TABLA = null;   // la tabla del último PANTALLA(), para mirarle el ancho (V1063)
const PANTALLA = (datos, abiertos = {}, unidad, op, moneda, caja = 1180, busca = '') => {
  const tb = { innerHTML: '', style: {}, parentNode: { clientWidth: caja } };
  TABLA = tb;
  new Function('PLA', 'eid', 'escH', [
    /^var PLA_MES = .*;\r?$/m.exec(PANEL)[0],
    hasta(PANEL, 'var PLA_SUBTOTALES = [', '];'),
    lineaVar('PLA_ANCHO'),
    fuente(PANEL, 'function plaAnchos(caja, columnas){'),
    fuente(PANEL, 'function plaMesTxt(m){'),
    fuente(PANEL, 'function plaMesCorto(m){'),
    fuente(PANEL, 'function plaImporte(v, usd){'),
    fuente(PANEL, 'function plaTotales(d){'),
    fuente(PANEL, 'function plaUnidadClave(){'),
    fuente(PANEL, 'function plaEnMoneda(d, moneda){'),
    fuente(PANEL, 'function plaMonedaCartel(sin){'),
    fuente(PANEL, 'function sgNorm(s){'),
    fuente(PANEL, 'function plaBuscaNorm(){'),
    fuente(PANEL, 'function plaCoincide(txt, q){'),
    fuente(PANEL, 'function plaTextoCuenta(c, rubro){'),
    fuente(PANEL, 'function plaTextoAjuste(a, rubro){'),
    fuente(PANEL, 'function plaFiltrar(d, q){'),
    fuente(PANEL, 'function plaBuscaCartel(d, q){'),
    fuente(PANEL, 'function plaUnidadGuardada(){'),
    fuente(PANEL, 'function plaUnidadAuto(T){'),
    fuente(PANEL, 'function plaCelda(v, ventas, conPct){'),
    fuente(PANEL, 'function plaAltoDisponible(alto, top, abajo){'),
    fuente(PANEL, 'function plaAltoCaja(){'),
    fuente(PANEL, 'function plaBarraArriba(){'),
    fuente(PANEL, 'function plaPintar(){'),
    'plaPintar();',
  ].join('\n'))({ datos, abiertos, unidad, op, moneda, busca }, () => tb, (x) => String(x));
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
    { cuenta: '4.2.01', nombre: 'COSTO', rubro: 'costos_ventas', meses: { '2025-07': -400, '2025-08': -900 } },
    { cuenta: '4.2.05', nombre: 'INTERESES', rubro: 'costos_financieros', meses: { '2025-08': -100 } },
    { cuenta: '4.2.06', nombre: 'IIBB', rubro: 'impuestos', meses: { '2025-07': -50 } },
    { cuenta: '4.9.99', nombre: 'FUERA', rubro: 'sin_asignar', meses: { '2025-07': -99999 } },
  ],
};

test('la cascada suma: margen bruto, EBITDA, EBT y resultado neto', () => {
  const T = TOTALES(DATOS);
  assert.deepEqual(T.rubros.ventas, { '2025-07': 1000, '2025-08': 5000, TOTAL: 6000 });
  // V1062: VENTAS no entra a la cascada; es la base de los porcentajes.
  assert.deepEqual(T.subtotales.margen, { '2025-07': -400, '2025-08': -900, TOTAL: -1300 });
  assert.deepEqual(T.subtotales.ebitda, T.subtotales.margen, 'sin costos fijos, el EBITDA es el margen');
  assert.deepEqual(T.subtotales.ebt, { '2025-07': -400, '2025-08': -1000, TOTAL: -1400 });
  assert.deepEqual(T.subtotales.neto, { '2025-07': -450, '2025-08': -1000, TOTAL: -1450 }, 'sin asignar entró al resultado');
  assert.deepEqual(T.cuentas.ventas.map((x) => x.c.cuenta), ['4.1.02', '4.1.01']);
  // Adentro de los gastos, el más negativo arriba.
  assert.deepEqual(TOTALES(Object.assign({}, DATOS, { cuentas: [
    { cuenta: 'a', rubro: 'costos_fijos', meses: { '2025-07': -10 } },
    { cuenta: 'b', rubro: 'costos_fijos', meses: { '2025-07': -500 } }] })).cuentas.costos_fijos.map((x) => x.c.cuenta), ['b', 'a']);
});

test('la tabla: el mes más nuevo a la izquierda, los subtotales siempre, y las cuentas al abrir', () => {
  const h = PANTALLA(DATOS);
  assert.ok(h.indexOf('>TOTAL</th>') < h.indexOf('>Ago 25</th>'));
  assert.ok(h.indexOf('>Ago 25</th>') < h.indexOf('>Jul 25</th>'), 'los meses no van del más nuevo al más viejo');
  assert.match(h, /<th title="Ago 2025">Ago 25<\/th>/);
  for (const t of ['MARGEN BRUTO', 'EBITDA', 'EBT (antes de impuestos)', '⭐ RESULTADO NETO']) assert.ok(h.includes(t), t);
  assert.ok(!h.includes('COSTOS FIJOS'), 'muestra un título vacío');
  assert.ok(!h.includes('FUERA'));
  assert.ok(!h.includes('4.1.01 · VENTAS'), 'las cuentas se ven sin abrir el rubro');
  // V1062: el margen ya no suma la venta, así que sobre las ventas de agosto da -18%.
  assert.match(h, /<span class="pla-pct pla-pct-neg">-18%<\/span>/, 'el % sobre ventas del margen de agosto');
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

test('hasta 24 meses CON DATOS por vez, y la ventana de subir se abre en blanco', () => {
  const c = fuente(PANEL, 'function plaCargar(inicial){');
  assert.match(c, /var dentro = \(\(PLA\.datos \|\| \{\}\)\.meses_disponibles \|\| \[\]\)\.filter\(function\(m\)\{ return m >= de && m <= ha; \}\)\.length;/);
  assert.match(c, /if \(dentro > 24\) \{ toast\('Elegí hasta 24 meses por vez'/);
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
    fuente(PANEL, 'function plaNbEsResultado(c){'), fuente(PANEL, 'function plaNbTipo(a){'),
    fuente(PANEL, 'function plaNbPatron(a){'), fuente(PANEL, 'function plaNbAgrupar(d, clave){'),
    fuente(PANEL, 'function plaNbPatronTxt(d){'),
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
  assert.match(els['pla-nb-tabla'].innerHTML,
    /<td>Asiento 373340<\/td><td>1 renglón · <span style="font-weight:400;color:var\(--mut\)">Un solo renglón<\/span><\/td>/);
  // Con un solo asiento no hay patrón que contar: el resumen no inventa uno.
  assert.ok(!els['pla-nb-resumen'].innerHTML.includes('El patrón que más se repite'));
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

test('un ajuste manual se valida: nombre, uno de los títulos, meses y números', () => {
  const ok = SVC.validarAjuste({ nombre: '  Amortización   rodados ', rubro: 'costos_fijos',
    meses: { '2025-08': -150000.456, '2025-07': '', '2025-09': 0, '2025-10': '-2500.5' } });
  assert.equal(ok.error, undefined, ok.error);
  assert.equal(ok.nombre, 'Amortización rodados');
  assert.deepEqual(ok.meses, { '2025-08': -150000.46, '2025-07': null, '2025-09': null, '2025-10': -2500.5 });
  assert.match(SVC.validarAjuste({ nombre: ' ', rubro: 'costos_fijos', meses: {} }).error, /Falta el nombre/);
  assert.match(SVC.validarAjuste({ nombre: 'x'.repeat(81), rubro: 'costos_fijos', meses: {} }).error, /muy largo/);
  assert.match(SVC.validarAjuste({ nombre: 'x', rubro: 'sin_asignar', meses: {} }).error, /rubro/,
    'un ajuste sin asignar no entraría a ningún lado');
  assert.match(SVC.validarAjuste({ nombre: 'x', rubro: 'ganancias', meses: {} }).error, /rubro/);
  assert.match(SVC.validarAjuste({ nombre: 'x', rubro: 'costos_fijos' }).error, /Faltan los importes/);
  assert.match(SVC.validarAjuste({ nombre: 'x', rubro: 'costos_fijos', meses: { '2025-13': 1 } }).error, /mes no se entiende/);
  assert.match(SVC.validarAjuste({ nombre: 'x', rubro: 'costos_fijos', meses: { '2025-08': 'mucho' } }).error, /no es un número/);
  assert.match(SVC.validarAjuste({ nombre: 'x', rubro: 'costos_fijos', meses: { '2025-08': true } }).error, /no es un número/);
});

test('los ajustes: se agregan, se corrigen sólo en los meses que vienen, no quedan vacíos y se eliminan con baja', () => {
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_A });
  llamar(R.cargar, { body: CARGA_B });
  assert.equal(llamar(R.ajusteNuevo, { body: { nombre: 'Vacío', rubro: 'costos_fijos', meses: { '2025-08': '' } } }).code, 400,
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
  assert.equal(llamar(R.ajusteCorregir, { params: { id: '999' }, body: { nombre: 'x', rubro: 'costos_fijos',
    meses: { '2025-08': 1 } } }).code, 404);
  // Eliminar: baja lógica, con quién y cuándo, y sale del cuadro.
  assert.equal(llamar(R.ajusteEliminar, { params: { id: String(id) } }).code, 200);
  assert.deepEqual(llamar(R.resultado, periodo).body.data.ajustes, []);
  const baja = db.prepare('SELECT eliminado_en, eliminado_por FROM pl_abasto_ajustes WHERE id = ?').get(id);
  assert.ok(baja.eliminado_en, 'lo borró en vez de darlo de baja');
  assert.equal(baja.eliminado_por, 5);
  assert.equal(llamar(R.ajusteEliminar, { params: { id: String(id) } }).code, 404);
  assert.equal(llamar(R.ajusteCorregir, { params: { id: String(id) }, body: { nombre: 'x', rubro: 'costos_fijos',
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
  assert.deepEqual(T.subtotales.margen, { '2025-07': -400, '2025-08': -900, TOTAL: -1300 });
  assert.deepEqual(T.subtotales.ebitda, { '2025-07': -500, '2025-08': -1200, TOTAL: -1700 });
  assert.deepEqual(T.subtotales.neto, { '2025-07': -550, '2025-08': -1300, TOTAL: -1850 });
  assert.deepEqual(T.ajustes.costos_fijos.map((x) => [x.a.id, x.total]), [[7, -400]]);
});

test('la tabla: el ajuste se ve adentro de su rubro, y un rubro con sólo ajustes aparece', () => {
  const datos = Object.assign({}, DATOS, { ajustes: AJUSTES });
  const h = PANTALLA(datos);
  assert.ok(h.includes('COSTOS FIJOS'), 'lo cargado a mano en costos fijos no se ve en ningún lado');
  assert.ok(!h.includes('Ajuste: Amortización'), 'el ajuste se ve sin abrir el rubro');
  const abierto = PANTALLA(datos, { costos_fijos: true });
  assert.match(abierto, /<tr class="pla-aju"><td title="✎ Ajuste: Amortización" onclick="plaAjusteAbrir\(7\)">/);
  assert.match(abierto, /ondblclick="plaAjusteAbrir\(7\)"/);
  assert.ok(!abierto.includes('Agregar un ajuste manual'), 'le ofrece cargar un ajuste a quien sólo mira');
  assert.match(PANTALLA(datos, { costos_fijos: true }, undefined, true),
    /onclick="plaAjusteAbrir\(null,'costos_fijos'\)">\+ Agregar un ajuste manual a COSTOS FIJOS</);
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
    { cuenta: '4.2.09', nombre: 'Gastos; "varios"', rubro: 'costos_fijos', meses: { '2025-07': -12.3 } },
    { cuenta: '4.2.10', nombre: '=HIPERVINCULO("x")', rubro: 'costos_fijos', meses: { '2025-08': -1 } }]) });
  const txt = csv(datos);
  assert.ok(txt.startsWith('\ufeff'), 'sin la marca del principio, el Excel lee mal los acentos');
  assert.deepEqual(txt.slice(1).split('\r\n'), [
    'Tipo;Concepto;Cuenta;TOTAL;Ago 2025;Jul 2025',
    'Rubro;VENTAS;;6500,00;5500,00;1000,00',
    'Cuenta;COMISIONES;4.1.02;3500,00;3500,00;0,00',
    'Cuenta;VENTAS;4.1.01;2500,00;1500,00;1000,00',
    'Ajuste manual;Venta sin factura;;500,00;500,00;0,00',
    'Rubro;UTILIDAD;;0,00;0,00;0,00',
    'Rubro;DESCUENTOS SUPER;;0,00;0,00;0,00',
    'Rubro;COSTOS ASOCIADOS A LAS VENTAS;;-1300,00;-900,00;-400,00',
    'Cuenta;COSTO;4.2.01;-1300,00;-900,00;-400,00',
    'Subtotal;MARGEN BRUTO;;-1300,00;-900,00;-400,00',
    'Rubro;COSTOS FIJOS;;-413,30;-301,00;-112,30',
    'Cuenta;"Gastos; ""varios""";4.2.09;-12,30;0,00;-12,30',
    'Cuenta;"\'=HIPERVINCULO(""x"")";4.2.10;-1,00;-1,00;0,00',
    'Ajuste manual;Amortización;;-400,00;-300,00;-100,00',
    'Rubro;COSTOS VARIABLES;;0,00;0,00;0,00',
    'Subtotal;EBITDA;;-1713,30;-1201,00;-512,30',
    'Rubro;COSTOS FINANCIEROS;;-100,00;-100,00;0,00',
    'Cuenta;INTERESES;4.2.05;-100,00;-100,00;0,00',
    'Subtotal;EBT (antes de impuestos);;-1813,30;-1301,00;-512,30',
    'Rubro;IMPUESTOS;;-50,00;0,00;-50,00',
    'Cuenta;IIBB;4.2.06;-50,00;0,00;-50,00',
    'Resultado;RESULTADO NETO;;-1863,30;-1301,00;-562,30',
  ]);
  // Un título vacío también va: la estructura es la misma todos los meses.
  assert.ok(csv(DATOS).includes('\r\nRubro;COSTOS FIJOS;;0,00;0,00;0,00\r\n'));
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
  // V1070: un ajuste SI puede quedar sin importes (nace pendiente). Lo que sigue valiendo, y
  // es lo que este test cuida desde la V1054, es que VACIAR uno cargado no sea la puerta de
  // atras para sacarlo: para eso se elimina, con el nivel que elimina.
  assert.match(M, /<b>Vaciar<\/b> un ajuste que ya tenía importes <b>no<\/b> es la manera de sacarlo: para eso se <b>elimina<\/b>, y eso pide el nivel <b>Anular<\/b>/);
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
  assert.deepEqual(t.body.data, { tipo: 'blue', traidos: 1, propuestos: 1, manuales: 1, sin_dato: ['2025-09'] });
  const lista = llamar(R.cotizaciones, {}).body.data.meses;
  // V1071: la lista son TODOS los meses, los del libro y los que sólo tienen cotización —junio
  // se cargó a mano y su libro todavía no se subió: esconderlo sería perderlo de vista—.
  assert.deepEqual(lista.map((x) => [x.mes, x.cotizacion, x.origen, x.sin_libro]),
    [['2025-09', null, null, 0], ['2025-08', 1300, 'mercado', 0], ['2025-07', 1300, 'manual', 0],
      ['2025-06', 999, 'manual', 1]],
    'traer del mercado pisó la cargada a mano');
  assert.equal(lista[1].tipo, 'blue');
  assert.equal(lista[2].modificado_por, 'Pablo');
  // V1071: al mes confirmado a mano NO se le toca la cotización, pero sí se le guarda lo que
  // propone el mercado. Sin eso no hay contra qué comparar ni a qué volver.
  assert.equal(lista[2].cotizacion, 1300, 'traer del mercado pisó la confirmada a mano');
  assert.equal(lista[2].propuesto, 1000);
  assert.equal(lista[2].propuesto_tipo, 'blue');
  assert.ok(lista[2].propuesto_en, 'no quedó cuándo se trajo esa propuesta');
  // Una fuente que falla no rompe nada, y lo dice.
  const mal = await R.traer(db, 'blue', 5, async () => ({ ok: false, status: 503 }));
  assert.equal(mal.status, 502);
  assert.match(mal.body.error, /No se pudo consultar la cotización \(respondió 503\)/);
  assert.equal((await R.traer(db, 'cripto', 5, fetchFalso)).status, 400, 'trae un dólar que no se ofrece');
  // El cuadro trae la cotización de cada mes del período.
  const d = llamar(R.resultado, { query: { desde: '2025-07', hasta: '2025-09' } }).body.data;
  assert.deepEqual(Object.keys(d.cotizaciones).sort(), ['2025-07', '2025-08']);
  assert.equal(d.cotizaciones['2025-08'].cotizacion, 1300);
  // V1071 · BORRAR LO CONFIRMADO VUELVE AL PROPUESTO, no tira el mes. Julio está a mano en
  // 1300 y el mercado propuso 1000: al borrarlo queda en 1000, marcado como del mercado.
  const vaciarJulio = llamar(R.cotizGuardar, { body: { meses: { '2025-07': '' } } });
  assert.equal(vaciarJulio.code, 200);
  assert.deepEqual(vaciarJulio.body.data, { guardadas: 1, volvieron: 1, borradas: 0 });
  const trasBorrar = llamar(R.cotizaciones, {}).body.data.meses;
  assert.deepEqual([trasBorrar[2].mes, trasBorrar[2].cotizacion, trasBorrar[2].origen, trasBorrar[2].tipo],
    ['2025-07', 1000, 'mercado', 'blue']);
  // Y un mes que NUNCA se trajo no tiene a qué volver: ahí sí se borra la fila.
  const vaciarJunio = llamar(R.cotizGuardar, { body: { meses: { '2025-06': '' } } });
  assert.deepEqual(vaciarJunio.body.data, { guardadas: 1, volvieron: 0, borradas: 1 });
  assert.ok(!llamar(R.cotizaciones, {}).body.data.meses.some((x) => x.mes === '2025-06'),
    'un mes sin libro ni cotización no tiene por qué seguir en la lista');
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
  // V1074: con un filtro puesto, el CSV baja LO QUE SE VE.
  assert.match(exp, /var datos = q \? plaFiltrar\(conv\.datos, q\) : conv\.datos;/,
    'el CSV baja el cuadro entero aunque en pantalla haya tres cuentas');
  assert.match(exp, /plaCsv\(datos, usd\)/);
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

// ══ 5b · CADA MES, DOS NÚMEROS: EL PROPUESTO Y EL CONFIRMADO (V1071) ════════════════
//
// El brief que dejó Pablo: «el blue automático es una estimación. El dueño/contadora confirma
// el tipo de cambio real que quiere usar para cada mes. Lo confirmado tiene prioridad».
// La regla de la V1055 —lo de a mano gana— no cambia; lo que se agrega es PODER VER contra qué
// se está decidiendo, y poder volver.

const PLA_COTIZ_DIAS = Number(/^var PLA_COTIZ_VIEJA_DIAS = (\d+);\r?$/m.exec(PANEL)[1]);
const COTIZ = (PLA, eid) => new Function('PLA', 'eid', 'escH', [
  /^var PLA_MES = .*;\r?$/m.exec(PANEL)[0],
  fuente(PANEL, 'function plaMesTxt(m){'),
  fuente(PANEL, 'function plaImporte(v, usd){'),
  /^var PLA_COTIZ_VIEJA_DIAS = .*;\r?$/m.exec(PANEL)[0],
  fuente(PANEL, 'function plaCotizTipoTxt(tipo, tipos){'),
  fuente(PANEL, 'function plaCotizEstado(x, C){'),
  fuente(PANEL, 'function plaCotizNotaMes(x, C){'),
  fuente(PANEL, 'function plaCotizNotaAyuda(x, C){'),
  fuente(PANEL, 'function plaCotizFrescura(C){'),
  fuente(PANEL, 'function plaCotizConPropuesto(C){'),
  fuente(PANEL, 'function plaCotizAccion(x, op){'),
  fuente(PANEL, 'function plaCotizFila(x, C, op){'),
  fuente(PANEL, 'function plaCotizPintar(op){'),
  ['return { estado: plaCotizEstado, nota: plaCotizNotaMes, ayuda: plaCotizNotaAyuda, frescura: plaCotizFrescura,',
    '  conProp: plaCotizConPropuesto, accion: plaCotizAccion, fila: plaCotizFila, pintar: plaCotizPintar };'].join('\n'),
].join('\n'))(PLA, eid, (x) => String(x));
// Un timestamp local de hace n días, escrito como lo escribe SQLite.
const haceDias = (n) => {
  const d = new Date(Date.now() - n * 86400000), p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':00';
};
const MESES_CZ = () => ({ tipos: [{ k: 'blue', label: 'Blue' }, { k: 'oficial', label: 'Oficial' }],
  mes_actual: '2025-09',
  meses: [
    { mes: '2025-09', cotizacion: 1400, origen: 'mercado', tipo: 'blue', propuesto: 1400, propuesto_tipo: 'blue',
      propuesto_en: haceDias(0), modificado_por: 'Pablo', modificado_en: haceDias(0), sin_libro: 0 },
    { mes: '2025-08', cotizacion: 1300, origen: 'manual', tipo: null, propuesto: 1250, propuesto_tipo: 'blue',
      propuesto_en: haceDias(0), modificado_por: 'Pablo', modificado_en: '2025-09-20 18:30:00', sin_libro: 0 },
    { mes: '2025-07', cotizacion: 1100, origen: 'manual', tipo: null, propuesto: null, propuesto_tipo: null,
      propuesto_en: null, modificado_por: 'Pablo', modificado_en: '2025-09-19 10:00:00', sin_libro: 1 },
    { mes: '2025-06', cotizacion: null, origen: null, tipo: null, propuesto: null, propuesto_tipo: null,
      propuesto_en: null, modificado_por: null, modificado_en: null, sin_libro: 0 },
  ] });

test('la ventana de cotizaciones: un renglón por mes, el propuesto al lado del confirmado', () => {
  const C = MESES_CZ(), E = {};
  const eid = (id) => (E[id] || (E[id] = { innerHTML: '', textContent: '', style: {} }));
  const F = COTIZ({ cotiz: C }, eid);
  // QUÉ SE ESTÁ USANDO EN ESE MES, en dos palabras.
  assert.equal(F.estado(C.meses[0], C).txt, 'Del mercado · Blue');
  assert.equal(F.estado(C.meses[1], C).txt, '✓ Confirmado a mano');
  assert.equal(F.estado(C.meses[3], C).txt, '⚠ Sin cotización');
  // Las dos cosas que hay que saber de un mes antes de decidir: en el renglón van en dos
  // palabras —entero no entra y se corta con puntos suspensivos— y enteras, en el globito.
  assert.equal(F.nota(C.meses[0], C), 'mes en curso');
  assert.equal(F.nota(C.meses[2], C), 'sin libro');
  assert.equal(F.nota(C.meses[1], C), '');
  assert.match(F.ayuda(C.meses[0], C), /el promedio es el de los días que van/);
  assert.match(F.ayuda(C.meses[2], C), /el libro diario de este mes todavía no se subió/);
  // EL INPUT LLEVA SÓLO LO CONFIRMADO. Si también trajera lo del mercado, el mismo número
  // estaría escrito dos veces en el renglón y no se sabría cuál de los dos se decidió —y
  // guardar lo volvería «a mano» sin que nadie lo haya confirmado—.
  const fMer = F.fila(C.meses[0], C, true), fMan = F.fila(C.meses[1], C, true);
  assert.match(fMer, /data-antes=""/);
  assert.match(fMer, /placeholder="\(sin confirmar\)"/);
  assert.ok(!/value="1400"/.test(fMer), 'lo del mercado también se escribió en Confirmado');
  assert.match(fMan, /data-antes="1300"/);
  assert.match(fMan, /value="1300"/);
  // Y el propuesto se ve IGUAL en el mes confirmado a mano: es contra qué se está decidiendo.
  assert.match(fMan, /<td class="n" title="[^"]*">\$ 1\.250,00<\/td>/,
    'el propuesto no se ve en su columna: queda sólo en el globito de la acción');
  assert.match(fMan, /title="Blue · traído el \d{4}-\d{2}-\d{2}"/, 'no dice qué dólar propuso ni cuándo');
  assert.match(fMer, /<td title="Sep 2025 — mes en curso: el promedio es el de los días que van">Sep 2025<\/td>/,
    'la explicación del renglón no queda ni en el globito del mes');
  assert.ok(fMan.indexOf('Pablo') >= 0 && fMan.indexOf('20/09') >= 0, 'no se ve quién lo confirmó ni cuándo');
  // UNA acción con dos finales, y el botón dice cuál toca ANTES de apretarlo.
  assert.match(F.accion(C.meses[1], true), /⚡ Usar el propuesto/);
  assert.match(F.accion(C.meses[1], true), /plaCotizVolver\(&quot;2025-08&quot;\)/);
  assert.match(F.accion(C.meses[2], true), /🗑️ Borrar/);
  assert.ok(!/Usar el propuesto/.test(F.accion(C.meses[2], true)), 'ofrece volver a un propuesto que no existe');
  assert.ok(!/plaCotizVolver/.test(F.accion(C.meses[0], true)), 'un mes del mercado no tiene nada que sacar');
  assert.ok(!/plaCotizVolver/.test(F.accion(C.meses[1], false)), 'al que sólo mira se le ofrece igual');
  // La tabla entera.
  F.pintar(true);
  const h = E['pla-cotiz-tabla'].innerHTML;
  assert.equal((h.match(/<tr/g) || []).length, 5, 'una fila por mes, más el encabezado');
  assert.match(h, /<th>Mes<\/th><th class="n">Propuesto<\/th><th class="n">Confirmado<\/th><th>Estado<\/th>/);
  assert.match(h, /<th class="pla-cz-quien">Quién y cuándo<\/th><th>Acciones<\/th>/);
  assert.match(h, /<tr class="pla-cz-hoy">/, 'el mes en curso no queda marcado');
  assert.equal((h.match(/input data-mes=/g) || []).length, 4);
  // El global sólo cuenta los que TIENEN a qué volver: el de julio se quedaría sin cotización.
  assert.deepEqual(F.conProp(C).map((x) => x.mes), ['2025-08']);
  assert.equal(E['pla-cotiz-todos'].textContent, '⚡ Usar el propuesto');
  assert.equal(E['pla-cotiz-todos'].style.display, '');
  F.pintar(false);
  assert.equal(E['pla-cotiz-todos'].style.display, 'none', 'al que sólo mira se le ofrece usar los propuestos');
  assert.equal((E['pla-cotiz-tabla'].innerHTML.match(/ disabled value=/g) || []).length, 4,
    'al que sólo mira le quedan casillas donde escribir');
  // Sin libro diario, la tabla no sale vacía sin decir por qué.
  const V = COTIZ({ cotiz: { tipos: [], meses: [] } }, eid);
  V.pintar(true);
  assert.match(E['pla-cotiz-tabla'].innerHTML, /Todavía no hay libro diario cargado/);
  assert.equal(E['pla-cotiz-todos'].style.display, 'none');
});

test('la ventana dice cuándo se trajo por última vez, y avisa cuando eso ya quedó viejo', () => {
  const F = COTIZ({}, () => ({ style: {} }));
  assert.equal(PLA_COTIZ_DIAS, 3);
  assert.match(F.frescura({ meses: [{ propuesto_en: null }] }), /Todavía no trajiste ninguna cotización/);
  assert.ok(!/⚠️/.test(F.frescura({ meses: [{ propuesto_en: haceDias(PLA_COTIZ_DIAS - 1) }] })));
  const viejo = F.frescura({ meses: [{ propuesto_en: haceDias(5) }] });
  assert.match(viejo, /⚠️/);
  assert.match(viejo, /hace 5 días/);
  assert.match(viejo, /conviene traerlo de nuevo/);
  // Se queda con la MÁS NUEVA de todas, venga en el orden que venga: la cotización vieja de un
  // mes cerrado es lo normal, y no tiene por qué hacer parecer vieja a la de ayer.
  const hoy = haceDias(0);
  const mezcla = F.frescura({ meses: [{ propuesto_en: hoy }, { propuesto_en: haceDias(90) }] });
  assert.ok(!/⚠️/.test(mezcla), 'un mes viejo hace parecer viejo a todo lo demás');
  assert.match(mezcla, new RegExp('es del ' + hoy.slice(8, 10) + '/' + hoy.slice(5, 7) + '/' + hoy.slice(0, 4)));
});

test('la moneda se recuerda, pero no se entra en dólares a un cuadro que no tiene ninguna', () => {
  const mk = (guardado) => new Function('localStorage', [
    fuente(PANEL, 'function plaMonedaGuardada(){'),
    fuente(PANEL, 'function plaHayCotizacion(d){'),
    fuente(PANEL, 'function plaMonedaInicial(d){'),
    'return { guardada: plaMonedaGuardada, inicial: plaMonedaInicial };',
  ].join('\n'))({ getItem: () => guardado });
  const conCotiz = { cotizaciones: { '2025-08': { cotizacion: 1300 } } };
  assert.equal(mk('usd').inicial(conCotiz), 'usd');
  assert.equal(mk('ars').inicial(conCotiz), 'ars');
  assert.equal(mk(null).guardada(), 'ars');
  // LO QUE SE RECUERDA ES LA PREFERENCIA, NO EL DATO: un cuadro en dólares con todas las celdas
  // vacías no informa nada, así que si todavía no hay ninguna cotización se vuelve a pesos.
  assert.equal(mk('usd').inicial({ cotizaciones: {} }), 'ars');
  assert.equal(mk('usd').inicial({ cotizaciones: { '2025-08': { cotizacion: null } } }), 'ars');
  assert.equal(mk('usd').inicial({}), 'ars');
  // Y sin almacenamiento —una ventana privada— la pantalla abre igual.
  assert.equal(new Function([fuente(PANEL, 'function plaMonedaGuardada(){'), 'return plaMonedaGuardada;'].join('\n'))()(),
    'ars', 'sin localStorage la pantalla no abre');
  const carg = fuente(PANEL, 'function plaCargar(inicial){');
  assert.match(carg, /PLA\.moneda = plaMonedaInicial\(r\.data\);/);
  assert.match(carg, /if \(plaMonedaGuardada\(\) === 'usd' && PLA\.moneda !== 'usd'\)/, 'vuelve a pesos sin decirlo');
  assert.match(fuente(PANEL, 'function plaMonedaCambiar(){'), /localStorage\.setItem\('pla-moneda', PLA\.moneda\)/);
  // Y el selector muestra siempre la moneda de verdad, no la que quedó escrita en el HTML.
  assert.match(fuente(PANEL, 'function plaPintar(){'), /var sm = eid\('pla-moneda'\); if \(sm\) sm\.value = PLA\.moneda;/);
  // El cartel de arriba dice en qué moneda se está leyendo: un número sin moneda se lee en la otra.
  const cartel = (moneda) => new Function('PLA', [/^var PLA_MES = .*;\r?$/m.exec(PANEL)[0],
    fuente(PANEL, 'function plaMesTxt(m){'), fuente(PANEL, 'function plaMonedaCartel(sin){'),
    'return plaMonedaCartel;'].join('\n'))({ moneda: moneda });
  assert.equal(cartel('ars')(['2025-08']), '', 'en pesos no hay nada que aclarar');
  assert.match(cartel('usd')([]), /En dólares: cada mes dividido por <b>su<\/b> cotización/);
  assert.match(cartel('usd')(['2025-08']), /Sin cotización: <b>Ago 2025<\/b>/);
});

test('las cotizaciones: borrar todo lo cargado a mano deja cada mes en lo que propone el mercado', async () => {
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_A });
  llamar(R.cargar, { body: CARGA_B });
  const fetchFalso = async () => ({ ok: true, status: 200, json: async () => [
    { fecha: '2025-07-05', venta: 1000 }, { fecha: '2025-08-05', venta: 1200 }] });
  assert.equal((await R.traer(db, 'blue', 5, fetchFalso)).status, 200);
  // Dos a mano: una sobre un mes que el mercado propuso, y una sobre uno que nunca se trajo.
  assert.equal(llamar(R.cotizGuardar, { body: { meses: { '2025-07': 1500, '2025-09': 1800 } } }).code, 200);
  const l = llamar(R.cotizLimpiar, {});
  assert.equal(l.code, 200);
  assert.deepEqual(l.body.data, { limpiadas: 2, volvieron: 1, borradas: 1 });
  const m = llamar(R.cotizaciones, {}).body.data.meses;
  assert.deepEqual(m.map((x) => [x.mes, x.cotizacion, x.origen]),
    [['2025-09', null, null], ['2025-08', 1200, 'mercado'], ['2025-07', 1000, 'mercado']],
    'limpiar dejó meses sin cotización que el mercado sí había propuesto');
  assert.match(llamar(R.cotizaciones, {}).body.data.mes_actual, /^\d{4}-\d{2}$/);
  // Y limpiar de nuevo no tiene nada que hacer: no borra lo que trajo el mercado.
  assert.deepEqual(llamar(R.cotizLimpiar, {}).body.data, { limpiadas: 0, volvieron: 0, borradas: 0 });
  assert.equal(llamar(R.cotizaciones, {}).body.data.meses.length, 3);
});

test('las cotizaciones de antes se migran: la traída queda como su propia propuesta, la de a mano no', () => {
  const db = base();
  const R = rutas(db);
  db.exec('DROP TABLE pl_abasto_cotizaciones');
  db.exec(`CREATE TABLE pl_abasto_cotizaciones (mes TEXT PRIMARY KEY, cotizacion REAL NOT NULL,
    origen TEXT NOT NULL DEFAULT 'manual', tipo TEXT, modificado_por INTEGER, modificado_en TEXT)`);
  db.exec(`INSERT INTO pl_abasto_cotizaciones (mes, cotizacion, origen, tipo, modificado_en) VALUES
    ('2025-08', 1200, 'mercado', 'blue', '2025-09-01 10:00:00'),
    ('2025-07', 1500, 'manual', NULL, '2025-09-01 10:00:00')`);
  R.migrarCotiz(db);
  const f = db.prepare('SELECT mes, propuesto, propuesto_tipo, propuesto_en FROM pl_abasto_cotizaciones ORDER BY mes')
    .all();
  // UNA CARGADA A MANO NO SE INVENTA UNA PROPUESTA: nadie la trajo del mercado, y si se la
  // copiara, «⚡ usar el propuesto» la devolvería a ella misma diciendo que es del mercado.
  assert.deepEqual(f.map((x) => [x.mes, x.propuesto, x.propuesto_tipo]),
    [['2025-07', null, null], ['2025-08', 1200, 'blue']]);
  assert.equal(f[1].propuesto_en, '2025-09-01 10:00:00', 'la propuesta migrada perdió la fecha en que se trajo');
  // Y correrla de nuevo no pisa lo que ya está.
  db.prepare("UPDATE pl_abasto_cotizaciones SET cotizacion = 1250 WHERE mes = '2025-08'").run();
  R.migrarCotiz(db);
  assert.equal(db.prepare("SELECT propuesto FROM pl_abasto_cotizaciones WHERE mes = '2025-08'").get().propuesto, 1200);
});

test('manual V1071: los dos números de cada mes, la acción que vuelve, y la moneda recordada', () => {
  const M = manual();
  assert.match(M, /Cada mes tiene <b>dos números<\/b>/);
  assert.match(M, /Manda el confirmado —traer del mercado no lo pisa—/);
  assert.match(M, /el mismo botón dice <b>🗑️ Borrar<\/b>/);
  assert.match(M, /<b>🧹 Borrar todo lo cargado a mano<\/b>/);
  assert.match(M, /Borra decisiones de otro, así que pide el nivel <b>Anular<\/b>/);
  assert.match(M, /cada mes es un <b>renglón<\/b>: Mes · Propuesto · Confirmado · Estado · Quién y cuándo · Acciones/);
  assert.match(M, /borrar de una vez todas las cargadas a mano, <b>Anular<\/b>/);
  assert.match(M, /<b>más de 3 días<\/b>/);
  assert.equal(PLA_COTIZ_DIAS, 3, 'el manual dice 3 días y el panel usa otro número');
  assert.match(M, /La <b>moneda elegida se recuerda<\/b> en cada navegador/);
  assert.match(M, /<span class="ver">V1071<\/span> Las cotizaciones, mes por mes/);
  // Lo que el manual AFIRMA, contra el código:
  assert.match(PANEL, /eid\('pla-cotiz-limpiar'\)\.style\.display = lnbPuedeAnular\('pl-abasto'\) \? '' : 'none';/);
  assert.match(RUTA, /router\.delete\('\/cotizaciones', requireAuth/);
  assert.match(fuente(PANEL, 'function plaCotizVolver(mes){'),
    /nunca se trajo del mercado[\s\S]*queda sin cotización/, 'saca la última cotización sin avisar');
  assert.match(PANEL, /<table class="pla-cz-tbl" id="pla-cotiz-tabla"><\/table>/);
});

test('manual V1055: cada mes con su cotización, el promedio del dólar elegido, lo manual gana', () => {
  const M = manual();
  assert.match(M, /Cada mes se pasa a dólares con <b>su cotización<\/b>/);
  assert.match(M, /el <b>promedio del valor venta<\/b> de los días de ese mes/);
  assert.match(M, /<b>No hay un dólar por defecto<\/b>/);
  assert.match(M, /Manda el confirmado —traer del mercado no lo pisa—/);
  // V1071: la regla sigue siendo la misma —lo confirmado a mano no se pisa— pero ahora el mes
  // manual igual recibe la propuesta del mercado, en sus propias columnas.
  assert.match(RUTA, /if \(manuales\.has\(mes\)\) \{ upPropuesto\.run\(v, tipo, mes\); propuestos\+\+; continue; \}/);
  assert.match(RUTA, /SET propuesto = \?, propuesto_tipo = \?, propuesto_en = datetime\('now','localtime'\)/);
  assert.match(M, /El <b>TOTAL<\/b> en dólares es la suma de los meses/);
  assert.match(M, /Un mes <b>sin cotización<\/b> no suma en dólares, y arriba del cuadro se avisa cuál es/);
  assert.match(M, /Los asientos de un importe \(doble clic\) siguen en pesos/);
  assert.ok(!/plaEnMoneda/.test(fuente(PANEL, 'function plaDetalle(tipo, clave, mes){')));
  assert.match(M, /con el cuadro en dólares, sale en dólares; si falta la cotización de algún mes, no se exporta/);
  assert.match(M, /Traer o cargar las cotizaciones del dólar pide <b>Operar<\/b>/);
  assert.match(M, /<span class="ver">V1055<\/span> El cuadro en dólares/);
});

// ══ 6c · LOS TÍTULOS NUEVOS Y LA LISTA ENTERA (V1056) ═══════════════════════════════
//
// Pablo, 14/9/2026: «en la parte izquierda deben figurarme la TOTALIDAD de los rubros que
// tienen movimientos. Si están seleccionados en algún Título debe mostrarme en cuál... no
// quiero perder ninguno de vista. Además vamos a cambiar los TÍTULOS».

test('la cascada con los títulos nuevos: margen, EBITDA y EBT donde los puso Pablo', () => {
  const uno = (rubro, v) => ({ cuenta: rubro, nombre: rubro, rubro, meses: { '2025-07': v } });
  const d = { rubros: RUBROS, meses: ['2025-07'], meses_disponibles: ['2025-07'], cuentas: [
    uno('ventas', 1000), uno('utilidad', 200), uno('descuentos_super', -100), uno('costos_ventas', -300),
    uno('costos_fijos', -50), uno('costos_variables', -40), uno('costos_financieros', -20), uno('impuestos', -10),
    uno('sin_asignar', -9999)] };
  const T = TOTALES(d);
  assert.equal(T.subtotales.margen.TOTAL, -200, 'el margen bruto es utilidad + descuentos + costos asociados');
  assert.equal(T.subtotales.ebitda.TOTAL, -290, 'el EBITDA suma costos fijos y costos variables');
  assert.equal(T.subtotales.ebt.TOTAL, -310);
  assert.equal(T.subtotales.neto.TOTAL, -320, 'una cuenta sin título, o VENTAS, sumó al resultado');
  const h = PANTALLA(d);
  const pos = (t) => { const i = h.indexOf(t); assert.ok(i > 0, 'no está ' + t); return i; };
  assert.ok(pos('COSTOS ASOCIADOS A LAS VENTAS') < pos('MARGEN BRUTO') && pos('MARGEN BRUTO') < pos('COSTOS FIJOS'));
  assert.ok(pos('COSTOS VARIABLES') < pos('EBITDA') && pos('EBITDA') < pos('COSTOS FINANCIEROS'));
  assert.ok(pos('COSTOS FINANCIEROS') < pos('EBT (antes') && pos('EBT (antes') < pos('IMPUESTOS'));
});

test('lo guardado con un título que ya no existe se migra, y un ajuste no deja de sumar', () => {
  const db = base();
  const R = rutas(db);
  db.exec(`INSERT INTO pl_abasto_rubros (cuenta, rubro) VALUES ('4.2.04.14.000.0000', 'otros'),
    ('4.2.05.02.006.0000', 'costos_financieros'), ('4.2.04.15.000.0000', 'sin_asignar');
    INSERT INTO pl_abasto_ajustes (id, rubro, nombre) VALUES (1, 'otros', 'Viejo'), (2, 'ventas', 'Bien');`);
  assert.deepEqual({ ...R.migrar(db) }, { rubros: 1, ajustes: 1 });
  assert.deepEqual(db.prepare('SELECT cuenta, rubro FROM pl_abasto_rubros ORDER BY cuenta').all().map((x) => [x.cuenta, x.rubro]),
    [['4.2.04.15.000.0000', 'sin_asignar'], ['4.2.05.02.006.0000', 'costos_financieros']]);
  assert.deepEqual(db.prepare('SELECT rubro FROM pl_abasto_ajustes ORDER BY id').all().map((x) => x.rubro),
    ['costos_variables', 'ventas'], 'un ajuste en «otros» dejaría de sumar sin que nadie lo vea');
  assert.deepEqual({ ...R.migrar(db) }, { rubros: 0, ajustes: 0 });
  assert.match(RUTA, /^migrarTitulos\(db\);\r?$/m, 'la migración no corre al arrancar');
});

test('la lista de cuentas: todas las que tienen movimientos, también las del patrimonio, y ninguna que ya no los tenga', () => {
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_A });
  // La segunda carga reemplaza agosto: los intereses del 20/8 ya no tienen movimientos.
  llamar(R.cargar, { body: CARGA_B });
  const cs = llamar(R.cuentas, {}).body.data.cuentas.map((x) => x.cuenta);
  // Pablo, 14/9/2026: «¿por qué me escondés algunos rubros, por ejemplo COTO, IVA?».
  assert.deepEqual(cs, ['1.1.01.03.001.0000', '1.1.03.01.000.6427', '2.1.01.01.000.0012', '2.1.03.01.000.0000',
    '4.1.01.00.000.0000', '4.1.01.01.000.0000', '4.2.04.14.000.0000']);
});

test('una cuenta del patrimonio arranca sin título, y si se le pone uno entra al cuadro y a sus asientos', () => {
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_A });
  const periodo = { query: { desde: '2025-07', hasta: '2025-08' } };
  assert.ok(!llamar(R.resultado, periodo).body.data.cuentas.some((c) => c.cuenta === '2.1.03.01.000.0000'),
    'una del patrimonio sin título entró al cuadro');
  const julio = { desde: '2025-07', hasta: '2025-07' };
  assert.equal(llamar(R.detalle, { query: Object.assign({ cuenta: '2.1.03.01.000.0000' }, julio) }).code, 400);
  assert.equal(llamar(R.rubros, { body: { rubros: { '2.1.03.01.000.0000': 'impuestos' } } }).code, 200);
  const iva = llamar(R.resultado, periodo).body.data.cuentas.find((c) => c.cuenta === '2.1.03.01.000.0000');
  assert.ok(iva, 'con título no entra al cuadro');
  assert.equal(iva.rubro, 'impuestos');
  assert.equal(iva.meses['2025-07'], 91221.72);
  assert.deepEqual(llamar(R.detalle, { query: Object.assign({ rubro: 'impuestos' }, julio) }).body.data.filas.map((f) => f.cuenta),
    ['2.1.03.01.000.0000']);
  assert.equal(llamar(R.detalle, { query: Object.assign({ cuenta: '2.1.03.01.000.0000' }, julio) }).code, 200);
});

test('la lista en la pantalla: todas, con el grupo del plan, la etiqueta de su título, y sin etiqueta la que no tiene', () => {
  const els = { 'pla-rub-q': { value: '' }, 'pla-rub-solo': { checked: false } };
  const eid = (id) => (els[id] = els[id] || {});
  const pintar = (pend) => new Function('PLA', 'eid', 'escH', 'sgNorm', [
    hasta(PANEL, 'var PLA_GRUPOS = {', '};'),
    fuente(PANEL, 'function plaGrupoCuenta(cuenta){'),
    hasta(PANEL, 'var PLA_COLOR = {', '};'),
    fuente(PANEL, 'function plaImporte(v, usd){'),
    fuente(PANEL, 'function plaRubroActual(c){'),
    fuente(PANEL, 'function plaTambienVentas(c){'),
    ...PINTAR_RUBROS(), 'plaRubrosPintar();'].join('\n'))(
    { pend, pendVentas: {}, cuentas: { rubros: RUBROS, cuentas: [
      { cuenta: '1.1.03.01.000.6105', nombre: 'COTO', rubro: 'sin_asignar', elegido: 0, importe: 5, resultado: 0 },
      { cuenta: '2.1.03.01.000.0000', nombre: 'IVA Debito Fiscal', rubro: 'sin_asignar', elegido: 0, importe: 1, resultado: 0 },
      { cuenta: '4.1.01', nombre: 'VENTAS', rubro: 'ventas', elegido: 0, importe: 1, resultado: 1 },
      { cuenta: '4.2.04', nombre: 'ELECTRICIDAD', rubro: 'sin_asignar', elegido: 0, importe: -1, resultado: 1 },
      { cuenta: '4.2.05', nombre: 'SUELDOS', rubro: 'costos_fijos', elegido: 1, importe: -1, resultado: 1 },
      { cuenta: '4.2.06', nombre: 'FLETES', rubro: 'sin_asignar', elegido: 0, importe: -1, resultado: 1 }] } },
    eid, String, (s) => String(s).toLowerCase());
  pintar({ '4.2.06': 'costos_ventas' });
  const L = els['pla-rub-lista'].innerHTML;
  assert.equal((L.match(/class="pla-fila/g) || []).length, 6, 'la lista no las muestra a todas');
  assert.match(L, /<div class="pla-grupo">1 · ACTIVO<\/div><div class="pla-fila"[^>]*><code>1\.1\.03\.01\.000\.6105<\/code><span class="n">COTO<\/span><\/div>/,
    'COTO no está, o tiene una etiqueta que no le corresponde');
  assert.match(L, /<div class="pla-grupo">2 · PASIVO<\/div>/);
  assert.equal((L.match(/4 · RESULTADOS/g) || []).length, 1, 'el encabezado del grupo se repite');
  assert.match(L, /<span class="n">VENTAS<\/span><span class="pla-badge def" style="color:#15803d" title="VENTAS · por defecto">Ventas<\/span>/);
  assert.match(L, /<span class="n">SUELDOS<\/span><span class="pla-badge" style="color:#1d4ed8" title="COSTOS FIJOS">C\. fijos<\/span>/);
  assert.match(L, /<span class="n">ELECTRICIDAD<\/span><\/div>/, 'una cuenta sin título lleva etiqueta');
  assert.match(L, /<span class="n">FLETES<\/span><span class="pla-badge" style="color:#9a3412" title="COSTOS ASOCIADOS A LAS VENTAS">C\. asoc\. ventas<\/span>/,
    'la etiqueta no muestra el título recién arrastrado');
  assert.equal(els['pla-rub-cuenta'].textContent, '6 con movimientos · 1 de resultado sin título',
    'las del patrimonio sin título cuentan como si faltara clasificarlas');
  els['pla-rub-solo'].checked = true;
  pintar({});
  const solo = els['pla-rub-lista'].innerHTML;
  assert.equal((solo.match(/class="pla-fila/g) || []).length, 2, 'sólo las de resultado sin título');
  assert.ok(!solo.includes('COTO'), 'la casilla trae las del patrimonio');
  assert.match(els['pla-zonas'].innerHTML, /COSTOS ASOCIADOS A LAS VENTAS <small[^>]*>\(0\)<\/small>/);
  // Soltar en la lista le saca el título.
  assert.match(PANEL, /<div class="pla-lista" data-rubro="sin_asignar">/);
});

test('el cuadro avisa cuántas cuentas no tienen título, porque no suman', () => {
  const caja = {};
  new Function('eid', 'escH', 'lnbPuedeOperar', [fuente(PANEL, 'function plaFechaTxt(f){'), fuente(PANEL, 'function plaAviso(d){'),
    'plaAviso({ ultima_carga: { archivo: "d.xls", desde: "2026-07-01", hasta: "2026-09-14" }, cuentas: ['
    + '{ rubro: "sin_asignar", elegido: 0 }, { rubro: "sin_asignar", elegido: 1 }, { rubro: "ventas", elegido: 0 }] });'].join('\n'))(
    () => caja, String, () => true);
  assert.match(caja.innerHTML, /⚠️ 2 cuentas con movimientos no tienen título y no suman al resultado: asignalas en «Configurar rubros»/);
});

test('manual V1056: los títulos, la lista entera, y lo que no es obvio arranca sin título', () => {
  const M = manual();
  assert.match(M, /Los títulos son <b>VENTAS, UTILIDAD, DESCUENTOS SUPER, COSTOS ASOCIADOS A LAS VENTAS, COSTOS FIJOS, COSTOS VARIABLES, COSTOS FINANCIEROS e IMPUESTOS<\/b>/);
  assert.match(M, /A la izquierda está la <b>lista entera de las cuentas con movimientos<\/b>, cada una con la etiqueta del título que tiene/);
  assert.match(M, /Arrastrar una cuenta a la lista le saca el título/);
  assert.match(M, /Una cuenta <b>sin título no suma al resultado<\/b>, y arriba del cuadro se avisa cuántas hay/);
  assert.match(fuente(PANEL, 'function plaTotales(d){'), /if \(!rub\[c\.rubro\]\) return;/);
  assert.match(M, /<b>MARGEN BRUTO<\/b> = utilidad \+ descuentos super \+ costos asociados a las ventas; <b>EBITDA<\/b> = margen bruto \+ costos fijos \+ costos variables/);
  assert.match(M, /<span class="ver">V1056<\/span> Los títulos nuevos/);
});

test('manual V1057: la lista tiene también las del patrimonio, y lo que falta clasificar son las de resultado', () => {
  const M = manual();
  assert.match(M, /Están <b>todas<\/b>, también las del patrimonio —clientes, proveedores, bancos, IVA—, agrupadas en activo, pasivo, patrimonio neto y resultados/);
  assert.match(M, /se pueden ver <b>sólo las de resultado sin título<\/b>, que son las que faltan clasificar/);
  assert.match(PANEL, /id="pla-rub-solo" onchange="plaRubrosPintar\(\)" style="[^"]*"> Sólo las de resultado sin título<\/label>/);
  assert.match(M, /<span class="ver">V1057<\/span> La lista de cuentas muestra también las del patrimonio/);
});

// ══ 6d · SÓLO VENTAS SE REPITE (V1058) ═══════════════════════════════════════════════
//
// Pablo, 14/9/2026: «sólo para el título VENTAS, permitime repetir rubros: que un rubro esté
// categorizado en ventas y un subrubro más». Y ante la pregunta, que cuente dos veces, en los dos.

test('también en VENTAS: se guarda con su título, y se saca al pasarla a VENTAS, a la lista, con la × o volviendo a los de por defecto', () => {
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_A });
  llamar(R.cargar, { body: CARGA_B });
  const E = '4.2.04.14.000.0000';   // G - Electricidad
  const repetidas = () => db.prepare('SELECT COUNT(*) n FROM pl_abasto_ventas_extra').get().n;
  assert.equal(llamar(R.rubros, { body: { ventas: { [E]: 1 } } }).code, 400, 'repitió en VENTAS una cuenta sin título');
  // Con su título en el mismo guardado, sí.
  assert.equal(llamar(R.rubros, { body: { rubros: { [E]: 'costos_fijos' }, ventas: { [E]: 1 } } }).code, 200);
  const e = llamar(R.resultado, { query: { desde: '2025-07', hasta: '2025-09' } }).body.data.cuentas.find((c) => c.cuenta === E);
  assert.equal(e.rubro, 'costos_fijos');
  assert.equal(e.tambien_ventas, 1);
  assert.equal(llamar(R.cuentas, {}).body.data.cuentas.find((c) => c.cuenta === E).tambien_ventas, 1);
  // Los asientos de VENTAS la traen, y los de su título también.
  const sept = { desde: '2025-09', hasta: '2025-09' };
  assert.deepEqual(llamar(R.detalle, { query: Object.assign({ rubro: 'ventas' }, sept) }).body.data.filas.map((f) => f.cuenta), [E]);
  assert.deepEqual(llamar(R.detalle, { query: Object.assign({ rubro: 'costos_fijos' }, sept) }).body.data.filas.map((f) => f.cuenta), [E]);
  // Una con VENTAS de título no se repite, ni aunque haya quedado marcada.
  assert.equal(llamar(R.rubros, { body: { ventas: { '4.1.01.00.000.0000': 1 } } }).code, 400);
  db.prepare("INSERT INTO pl_abasto_ventas_extra (cuenta) VALUES ('4.1.01.00.000.0000')").run();
  assert.equal(llamar(R.cuentas, {}).body.data.cuentas.find((c) => c.cuenta === '4.1.01.00.000.0000').tambien_ventas, 0,
    'una cuenta con VENTAS de título figura también en VENTAS');
  db.prepare("DELETE FROM pl_abasto_ventas_extra WHERE cuenta = '4.1.01.00.000.0000'").run();
  // Pasarla a VENTAS como título le saca la repetición; sacarle el título, también.
  assert.equal(llamar(R.rubros, { body: { rubros: { [E]: 'ventas' } } }).code, 200);
  assert.equal(repetidas(), 0);
  llamar(R.rubros, { body: { rubros: { [E]: 'impuestos' }, ventas: { [E]: 1 } } });
  assert.equal(repetidas(), 1);
  llamar(R.rubros, { body: { rubros: { [E]: 'sin_asignar' } } });
  assert.equal(repetidas(), 0);
  // La ×.
  llamar(R.rubros, { body: { rubros: { [E]: 'impuestos' }, ventas: { [E]: 1 } } });
  assert.equal(llamar(R.rubros, { body: { ventas: { [E]: 0 } } }).code, 200);
  assert.equal(repetidas(), 0);
  // Volver a los de por defecto.
  llamar(R.rubros, { body: { ventas: { [E]: 1 } } });
  assert.equal(repetidas(), 1);
  llamar(R.restablecer, {});
  assert.equal(repetidas(), 0, 'volver a los de por defecto dejó la repetición');
  assert.equal(llamar(R.rubros, { body: {} }).code, 400);
});

test('también en VENTAS suma en los dos: el resultado neto la cuenta dos veces, y cada subtotal debajo de los dos', () => {
  const uno = (cuenta, rubro, v, tambien) => ({ cuenta, nombre: cuenta, rubro, tambien_ventas: tambien ? 1 : 0, meses: { '2025-07': v } });
  const d = { rubros: RUBROS, meses: ['2025-07'], meses_disponibles: ['2025-07'], cuentas: [
    uno('4.1.01', 'ventas', 1000), uno('4.1.02', 'utilidad', 200, true), uno('4.2.05', 'costos_fijos', -50, true)] };
  const T = TOTALES(d);
  assert.deepEqual(T.rubros.ventas, { '2025-07': 1150, TOTAL: 1150 }, 'VENTAS no suma las que están también ahí');
  assert.equal(T.rubros.utilidad.TOTAL, 200);
  assert.equal(T.rubros.costos_fijos.TOTAL, -50);
  // V1062: en VENTAS suman para la base de los porcentajes; al resultado suman desde su título.
  assert.equal(T.subtotales.margen.TOTAL, 200, 'la repetida en VENTAS se contó dos veces en el margen');
  assert.equal(T.subtotales.ebitda.TOTAL, 150);
  assert.equal(T.subtotales.neto.TOTAL, 150, 'el resultado neto cuenta dos veces las repetidas');
  assert.deepEqual(T.cuentas.ventas.map((x) => [x.c.cuenta, x.tambien || null]),
    [['4.1.01', null], ['4.1.02', 'utilidad'], ['4.2.05', 'costos_fijos']]);
  // Una con VENTAS de título no se suma dos veces en VENTAS.
  assert.equal(TOTALES({ rubros: RUBROS, meses: ['2025-07'], cuentas: [uno('4.1.01', 'ventas', 1000, true)] }).rubros.ventas.TOTAL, 1000);
  assert.ok(PANTALLA(d, { ventas: true }).includes('>4.1.02 · también en UTILIDAD</td>'), 'en VENTAS no dice en qué otro título está');
});

test('también en VENTAS en la pantalla: soltarla en VENTAS la deja en los dos, con su etiqueta y su ×', () => {
  const els = { 'pla-rub-q': { value: '' }, 'pla-rub-solo': { checked: false } };
  const eid = (id) => (els[id] = els[id] || {});
  const PLA = { pend: {}, pendVentas: {}, cuentas: { rubros: RUBROS, cuentas: [
    { cuenta: '4.1.02', nombre: 'COMISIONES', rubro: 'utilidad', elegido: 1, importe: 1, resultado: 1, tambien_ventas: 0 },
    { cuenta: '4.2.04', nombre: 'ELECTRICIDAD', rubro: 'sin_asignar', elegido: 0, importe: -1, resultado: 1, tambien_ventas: 0 },
    { cuenta: '4.2.05', nombre: 'SUELDOS', rubro: 'costos_fijos', elegido: 1, importe: -1, resultado: 1, tambien_ventas: 1 }] } };
  const F = new Function('PLA', 'eid', 'escH', 'sgNorm', [
    hasta(PANEL, 'var PLA_GRUPOS = {', '};'), fuente(PANEL, 'function plaGrupoCuenta(cuenta){'),
    hasta(PANEL, 'var PLA_COLOR = {', '};'), fuente(PANEL, 'function plaImporte(v, usd){'),
    fuente(PANEL, 'function plaRubroActual(c){'), ...PINTAR_RUBROS(),
    fuente(PANEL, 'function plaCuentaDe(cuenta){'), fuente(PANEL, 'function plaSoltarEn(cuenta, rubro){'),
    fuente(PANEL, 'function plaVentasPend(c, si){'),
    fuente(PANEL, 'function plaTambienVentas(c){'), fuente(PANEL, 'function plaQuitarVentas(cuenta){'),
    'return { pintar: plaRubrosPintar, soltar: plaSoltarEn, quitar: plaQuitarVentas };'].join('\n'))(
    PLA, eid, String, (s) => String(s).toLowerCase());
  const soltar = (cuenta, rubro) => F.soltar(cuenta, rubro);
  F.pintar();
  assert.match(els['pla-rub-lista'].innerHTML,
    /<span class="n">SUELDOS<\/span><span class="pla-badge"[^>]*>C\. fijos<\/span><span class="pla-badge" style="color:#15803d" title="También en VENTAS">\+ Ventas<\/span>/);
  assert.match(els['pla-zonas'].innerHTML,
    /SUELDOS <small>4\.2\.05<\/small><span class="pla-def">también en COSTOS FIJOS<\/span><button type="button" class="pla-x" title="Sacarla de VENTAS" onclick="plaQuitarVentas\('4\.2\.05'\)">×<\/button>/);
  // Soltar en VENTAS una con otro título: queda en los dos, y su título no cambia.
  soltar('4.1.02', 'ventas');
  assert.deepEqual(PLA.pendVentas, { '4.1.02': 1 });
  assert.deepEqual(PLA.pend, {}, 'soltarla en VENTAS le cambió el título');
  // Soltar en VENTAS una sin título: VENTAS es su título, no una repetición.
  soltar('4.2.04', 'ventas');
  assert.deepEqual(PLA.pend, { '4.2.04': 'ventas' });
  assert.equal(PLA.pendVentas['4.2.04'], undefined);
  // La × la saca de VENTAS, y deja de verse ahí.
  F.quitar('4.2.05');
  assert.deepEqual(PLA.pendVentas, { '4.1.02': 1, '4.2.05': 0 });
  assert.ok(!els['pla-zonas'].innerHTML.includes("plaQuitarVentas('4.2.05')"), 'sacada con la ×, sigue en VENTAS');
  // Volver a ponerla no es un cambio.
  soltar('4.2.05', 'ventas');
  assert.equal(PLA.pendVentas['4.2.05'], undefined);
  // Llevarla a la lista le saca el título y la repetición.
  soltar('4.2.05', 'sin_asignar');
  assert.deepEqual(PLA.pend, { '4.2.04': 'ventas', '4.2.05': 'sin_asignar' });
  assert.equal(PLA.pendVentas['4.2.05'], 0);
  assert.equal(els['pla-rub-pend'].textContent, '4 cambio(s) sin guardar');
  assert.match(fuente(PANEL, 'function plaRubrosGuardar(){'), /\{ rubros: PLA\.pend, ventas: PLA\.pendVentas \}/);
});

test('manual V1058: sólo VENTAS se repite, y suma en los dos', () => {
  const M = manual();
  assert.match(M, /<b>Sólo VENTAS se puede repetir<\/b>: una cuenta que ya tiene otro título se arrastra también a VENTAS y queda en los dos/);
  assert.match(M, /<b>Repetirla en VENTAS no la cuenta dos veces<\/b>: suma al resultado desde su propio título, y en VENTAS suma sólo para la base de los porcentajes/);
  assert.match(M, /Pasarla a VENTAS como su título, o sacarle el título, le saca la repetición/);
  assert.match(RUTA, /if \(r === 'ventas' \|\| r === SIN_ASIGNAR\) sinVentas\.run\(c\);/);
  assert.match(M, /<span class="ver">V1058<\/span> Una cuenta puede estar también en VENTAS/);
});

// ══ 6e · QUE NO SE TILDE (V1059) ════════════════════════════════════════════════════
//
// Pablo, 14/9/2026: «no anda arrastrar rubros de un lado a otro, y cuando quiero operar es como
// que se tilda». En un Chrome de verdad, con las 873 cuentas reales y el procesador de una
// notebook común, cada soltada congelaba el panel casi un segundo: volvía a dibujar la lista
// entera. Y con 768 de alto, la caja de destino quedaba fuera de la vista.

test('soltar una cuenta cambia sólo su fila y las cajas, sin volver a dibujar la lista entera', () => {
  let pintadasLista = 0, filaNueva = null;
  const lista = { querySelector: (sel) => (sel === '.pla-fila[data-cuenta="4.2.04"]' ? { set outerHTML(h) { filaNueva = h; } } : null) };
  Object.defineProperty(lista, 'innerHTML', { set() { pintadasLista++; }, get() { return ''; } });
  const els = { 'pla-rub-lista': lista, 'pla-rub-q': { value: '' }, 'pla-rub-solo': { checked: false } };
  const eid = (id) => (els[id] = els[id] || {});
  const PLA = { pend: {}, pendVentas: {}, cuentas: { rubros: RUBROS, cuentas: [
    { cuenta: '4.2.04', nombre: 'ELECTRICIDAD', rubro: 'sin_asignar', elegido: 0, importe: -1, resultado: 1, tambien_ventas: 0 }] } };
  const soltar = new Function('PLA', 'eid', 'escH', 'sgNorm', [
    hasta(PANEL, 'var PLA_GRUPOS = {', '};'), fuente(PANEL, 'function plaGrupoCuenta(cuenta){'),
    hasta(PANEL, 'var PLA_COLOR = {', '};'), fuente(PANEL, 'function plaImporte(v, usd){'),
    fuente(PANEL, 'function plaRubroActual(c){'), ...PINTAR_RUBROS(),
    fuente(PANEL, 'function plaCuentaDe(cuenta){'), fuente(PANEL, 'function plaSoltarEn(cuenta, rubro){'),
    fuente(PANEL, 'function plaVentasPend(c, si){'),
    fuente(PANEL, 'function plaTambienVentas(c){'), 'return plaSoltarEn;'].join('\n'))(PLA, eid, String, (s) => String(s).toLowerCase());
  const a = (rubro) => soltar('4.2.04', rubro);
  a('costos_fijos');
  assert.equal(pintadasLista, 0, 'soltar volvió a dibujar la lista entera');
  assert.match(filaNueva, /<span class="n">ELECTRICIDAD<\/span><span class="pla-badge" style="color:#1d4ed8" title="COSTOS FIJOS">C\. fijos<\/span>/);
  assert.match(els['pla-zonas'].innerHTML, /ELECTRICIDAD <small>4\.2\.04<\/small>/);
  assert.equal(els['pla-rub-pend'].textContent, '1 cambio(s) sin guardar');
  // Con la casilla de «sólo sin título» la fila tiene que salir de la lista: ahí sí va entera.
  els['pla-rub-solo'].checked = true;
  a('costos_variables');
  assert.equal(pintadasLista, 1);
});

test('arrastrar con el puntero: un clic elige, moverse arrastra, soltar lleva al título, y nada queda colgado', () => {
  // Pablo, 14/9/2026: «no hay caso, se me queda la manito seleccionada y no puedo hacer nada» (V1060).
  const clases = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) }; };
  const body = { hijos: [], classList: clases(),
    appendChild(e) { this.hijos.push(e); e.parentNode = this; },
    removeChild(e) { this.hijos.splice(this.hijos.indexOf(e), 1); e.parentNode = null; } };
  const zona = { classList: clases(), getAttribute: () => 'costos_fijos' };
  let debajo = null;
  const documento = { body, createElement: () => ({ style: {}, className: '', textContent: '' }),
    elementFromPoint: () => (debajo ? { closest: (sel) => (sel === '#sec-pl-abasto [data-rubro]' ? debajo : null) } : null),
    querySelectorAll: () => [], querySelector: () => null };
  const els = { 'pla-rub-q': { value: '' }, 'pla-rub-solo': { checked: false } };
  const eid = (id) => (els[id] = els[id] || {});
  const PLA = { pend: {}, pendVentas: {}, sel: null, cuentas: { rubros: RUBROS, cuentas: [
    { cuenta: '4.2.04', nombre: 'ELECTRICIDAD', rubro: 'sin_asignar', elegido: 0, importe: -1, resultado: 1, tambien_ventas: 0 }] } };
  const F = new Function('PLA', 'eid', 'escH', 'sgNorm', 'document', [
    hasta(PANEL, 'var PLA_GRUPOS = {', '};'), fuente(PANEL, 'function plaGrupoCuenta(cuenta){'),
    hasta(PANEL, 'var PLA_COLOR = {', '};'), fuente(PANEL, 'function plaImporte(v, usd){'),
    fuente(PANEL, 'function plaRubroActual(c){'), ...PINTAR_RUBROS(), 'var PLA_DRAG = null;',
    ...['function plaCuentaDe(cuenta){', 'function plaTomar(ev, el){', 'function plaZonaEn(x, y){', 'function plaMover(ev){',
      'function plaAutoScroll(x, y){', 'function plaLargar(ev){', 'function plaCancelarArrastre(){', 'function plaElegir(cuenta){',
      'function plaClicZona(ev, zona){', 'function plaSoltarEn(cuenta, rubro){', 'function plaVentasPend(c, si){',
      'function plaTambienVentas(c){'].map((f) => fuente(PANEL, f)),
    'return { tomar: plaTomar, mover: plaMover, largar: plaLargar, clicZona: plaClicZona, drag: function(){ return PLA_DRAG; } };',
  ].join('\n'))(PLA, eid, String, (s) => String(s).toLowerCase(), documento);
  let liberadas = 0;
  const fila = { getAttribute: () => '4.2.04', setPointerCapture() {}, releasePointerCapture() { liberadas++; } };
  const ev = (x, y, id = 1) => ({ button: 0, pointerId: id, clientX: x, clientY: y, target: {}, preventDefault() {} });
  // Un clic, aunque la mano tiemble tres píxeles: elige la cuenta, no la arrastra.
  F.tomar(ev(100, 100), fila); F.mover(ev(102, 101)); F.largar(ev(102, 101));
  assert.equal(PLA.sel, '4.2.04', 'un clic no elige la cuenta');
  assert.equal(body.hijos.length, 0, 'un clic dejó una cuenta volando');
  assert.match(els['pla-rub-sel'].innerHTML, /Elegida: <b>ELECTRICIDAD<\/b>/);
  // Otro clic en la misma la suelta.
  F.tomar(ev(100, 100), fila); F.largar(ev(100, 100));
  assert.equal(PLA.sel, null);
  // Arrastrar: viaja con el puntero, marca la caja de abajo y al soltar la lleva ahí.
  F.tomar(ev(100, 100), fila);
  debajo = zona;
  F.mover(ev(160, 140));
  assert.equal(body.hijos.length, 1, 'no se ve la cuenta viajando con el puntero');
  assert.ok(body.classList.contains('pla-arrastrando'));
  assert.ok(zona.classList.contains('sobre'), 'no marca la caja de abajo');
  F.mover(ev(170, 150, 2));
  assert.equal(body.hijos[0].style.left, '174px', 'otro puntero movió la cuenta');
  F.largar(ev(170, 150));
  assert.deepEqual(PLA.pend, { '4.2.04': 'costos_fijos' });
  assert.equal(body.hijos.length, 0, 'quedó la cuenta volando después de soltar');
  assert.ok(!body.classList.contains('pla-arrastrando'), 'quedó la manito tomada');
  assert.ok(!zona.classList.contains('sobre'));
  assert.equal(liberadas, 3, 'no suelta el puntero');
  assert.equal(F.drag(), null);
  // Soltar fuera de toda caja no cambia nada.
  F.tomar(ev(100, 100), fila); debajo = null; F.mover(ev(300, 300)); F.largar(ev(300, 300));
  assert.deepEqual(PLA.pend, { '4.2.04': 'costos_fijos' });
  assert.equal(body.hijos.length, 0);
  // Dos clics: elegirla y clic en un título. Un clic en una cuenta de adentro de la caja no la lleva.
  F.tomar(ev(100, 100), fila); F.largar(ev(100, 100));
  F.clicZona({ target: { closest: (s) => (s === '.pla-chip, button' ? {} : null) } }, { getAttribute: () => 'impuestos' });
  assert.deepEqual(PLA.pend, { '4.2.04': 'costos_fijos' }, 'el clic en una cuenta de la caja llevó la elegida');
  F.clicZona({ target: { closest: () => null } }, { getAttribute: () => 'impuestos' });
  assert.deepEqual(PLA.pend, { '4.2.04': 'impuestos' });
  assert.equal(PLA.sel, null, 'después de llevarla sigue elegida');
});

test('sin el arrastre del navegador: ninguna cuenta es draggable, y el puntero y Esc quedan escuchados', () => {
  const funcs = PINTAR_RUBROS().join('\n');
  assert.ok(!/draggable|ondragstart|ondrop|ondragover/.test(funcs), 'queda el arrastre del navegador en las cuentas o las cajas');
  assert.ok(!/ondragover|ondrop|draggable/.test(hasta(PANEL, '<div class="sec sg-mod" id="sec-pl-abasto">',
    '<div class="sec sg-mod" id="sec-informes-comercial">')));
  assert.equal((funcs.match(/onpointerdown="plaTomar\(event,this\)"/g) || []).length, 3, 'las filas y las cuentas de las cajas se toman con el puntero');
  assert.match(funcs, /onclick="plaClicZona\(event,this\)"/);
  assert.match(PANEL, /document\.addEventListener\('pointermove', plaMover\);\r?\n\s+document\.addEventListener\('pointerup', plaLargar\);\r?\n\s+document\.addEventListener\('pointercancel', plaCancelarArrastre\);/);
  assert.match(PANEL, /if \(e\.key === 'Escape' && \(PLA_DRAG \|\| PLA\.sel\)\) \{ plaCancelarArrastre\(\); plaElegir\(null\); \}/);
  assert.match(PANEL, /window\.addEventListener\('blur', plaCancelarArrastre\);/);
  assert.match(PANEL, /#sec-pl-abasto \.pla-fila,#sec-pl-abasto \.pla-chip\{touch-action:none;user-select:none;-webkit-user-select:none\}/);
  assert.match(PANEL, /<div id="pla-rub-sel" class="pla-sel"><\/div>/);
});

test('los importes salen de un solo formateador, y dicen lo mismo que antes', () => {
  const imp = new Function(fuente(PANEL, 'function plaImporte(v, usd){') + '\nreturn plaImporte;')();
  assert.equal(imp(-1234.5), '-$ 1.234,50');
  assert.equal(imp(1234.5, true), 'U$S 1.234,50');
  const f = imp.fmt;
  assert.ok(f instanceof Intl.NumberFormat, 'arma un formateador por cada número');
  imp(1);
  assert.equal(imp.fmt, f);
});

test('la lista no dibuja las filas que no se ven, y los títulos quedan a la vista mientras se baja', () => {
  // Sin content-visibility: con filas que se dibujan recién al verse, la lista se corría al bajar y en
  // Chrome se agarró la cuenta de al lado. El dibujo se aísla con contain, que no cambia tamaños.
  assert.ok(!/content-visibility/.test(hasta(PANEL, '<div class="sec sg-mod" id="sec-pl-abasto">', '</style>')),
    'las filas se corren al bajar por la lista');
  assert.match(PANEL, /#sec-pl-abasto \.pla-lista-cuerpo\{[^}]*contain:content\}/);
  assert.match(PANEL, /#sec-pl-abasto \.pla-zona\{[^}]*contain:content\}/);
  assert.match(PANEL, /#sec-pl-abasto \.pla-zonas\{[^}]*position:sticky;top:8px;max-height:calc\(100vh - 120px\);overflow-y:auto/);
  assert.match(PANEL, /#sec-pl-abasto \.pla-lista\{[^}]*max-height:calc\(100vh - 120px\)\}/);
  assert.match(PANEL, /<input type="checkbox" id="pla-rub-solo" onchange="plaRubrosPintar\(\)" style="width:auto;margin:0 5px 0 0;vertical-align:middle">/);
  const soltar = fuente(PANEL, 'function plaSoltarEn(cuenta, rubro){');
  assert.equal((soltar.match(/plaRubrosTocar\(cuenta\);/g) || []).length, 1);
  assert.ok(!/plaRubrosPintar\(\)/.test(soltar), 'soltar vuelve a dibujar todo');
  assert.match(fuente(PANEL, 'function plaQuitarVentas(cuenta){'), /plaRubrosTocar\(cuenta\);/);
});

test('manual V1059: los títulos quedan a la vista mientras se baja por la lista', () => {
  const M = manual();
  assert.match(M, /Los títulos quedan <b>fijos a la derecha<\/b> mientras se baja por la lista, así se arrastra sin perderlos de vista/);
  assert.match(M, /<span class="ver">V1059<\/span> Configurar rubros responde enseguida con cientos de cuentas/);
});

test('manual V1060: arrastrar con el puntero, dos clics, y Esc cancela', () => {
  const M = manual();
  assert.match(M, /<b>Arrastrar<\/b>: se aprieta sobre la cuenta, se mueve y se suelta sobre el título; la cuenta viaja con el puntero/);
  assert.match(M, /Soltar afuera o apretar <b>Esc<\/b> cancela/);
  assert.match(M, /<b>Sin arrastrar<\/b>: un clic en la cuenta la elige y un clic en el título la lleva ahí/);
  assert.match(M, /<span class="ver">V1060<\/span> Arrastrar ya no se engancha, y también se puede clasificar con dos clics/);
});

// ══ 6f · LA ×, LOS NOMBRES ENTEROS Y EL EXCEL DE LO QUE NO BALANCEA (V1061) ═════════════
//
// Pablo, 15/9/2026: «agregame en cada uno de los rubros una pequeña cruz, para que vuelvan al
// general de rubros. En el cuadro de resultados no es tan importante el número de rubro, pero sí
// que la descripción se lea completa. Por último, en el No balancea debés permitirme bajar un
// Excel para enviar a revisar».

test('cada cuenta de un título tiene su ×, que la devuelve a la lista sin título', () => {
  const els = { 'pla-rub-q': { value: '' }, 'pla-rub-solo': { checked: false } };
  const eid = (id) => (els[id] = els[id] || {});
  const PLA = { pend: {}, pendVentas: {}, sel: null, cuentas: { rubros: RUBROS, cuentas: [
    { cuenta: '4.2.05', nombre: 'SUELDOS', rubro: 'costos_fijos', elegido: 1, importe: -1, resultado: 1, tambien_ventas: 1 },
    { cuenta: '4.1.02', nombre: 'COMISIONES', rubro: 'ventas', elegido: 0, importe: 1, resultado: 1, tambien_ventas: 0 }] } };
  const F = new Function('PLA', 'eid', 'escH', 'sgNorm', [
    hasta(PANEL, 'var PLA_GRUPOS = {', '};'), fuente(PANEL, 'function plaGrupoCuenta(cuenta){'),
    hasta(PANEL, 'var PLA_COLOR = {', '};'), fuente(PANEL, 'function plaImporte(v, usd){'),
    fuente(PANEL, 'function plaRubroActual(c){'), ...PINTAR_RUBROS(),
    fuente(PANEL, 'function plaCuentaDe(cuenta){'), fuente(PANEL, 'function plaSoltarEn(cuenta, rubro){'),
    fuente(PANEL, 'function plaVentasPend(c, si){'), fuente(PANEL, 'function plaTambienVentas(c){'),
    'return { pintar: plaRubrosPintar, soltarEn: plaSoltarEn };'].join('\n'))(PLA, eid, String, (s) => String(s).toLowerCase());
  F.pintar();
  const Z = els['pla-zonas'].innerHTML;
  assert.match(Z, /SUELDOS <small>4\.2\.05<\/small><button type="button" class="pla-x" title="Devolverla a la lista, sin título" onclick="plaSoltarEn\('4\.2\.05','sin_asignar'\)">×<\/button><\/div>/,
    'la cuenta de COSTOS FIJOS no tiene su ×');
  assert.match(Z, /COMISIONES <small>4\.1\.02<\/small><span class="pla-def">por defecto<\/span><button type="button" class="pla-x" title="Devolverla a la lista, sin título"/);
  // La repetida en VENTAS conserva su × de «sacarla de VENTAS».
  assert.match(Z, /también en COSTOS FIJOS<\/span><button type="button" class="pla-x" title="Sacarla de VENTAS"/);
  // Y la × hace lo que dice: vuelve a la lista, y le saca también la repetición.
  F.soltarEn('4.2.05', 'sin_asignar');
  assert.deepEqual(PLA.pend, { '4.2.05': 'sin_asignar' });
  assert.equal(PLA.pendVentas['4.2.05'], 0);
  // Tocar la × no arrastra ni elige: el puntero ignora los botones.
  assert.match(fuente(PANEL, 'function plaTomar(ev, el){'), /ev\.target\.closest\('button'\)\)\) return;/);
  assert.match(fuente(PANEL, 'function plaClicZona(ev, zona){'), /closest\('\.pla-chip, button'\)\) return;/);
});

test('en el cuadro cada cuenta se ve con su nombre entero; el número queda al pasar el mouse', () => {
  const datos = Object.assign({}, DATOS, { cuentas: DATOS.cuentas.concat([
    { cuenta: '4.1.07.03.000.0000', nombre: 'Descuento Super - por Ac comerciales', rubro: 'ventas', meses: { '2025-08': -10 } }]) });
  const h = PANTALLA(datos, { ventas: true });
  assert.match(h, /<tr class="pla-cta"><td title="4\.1\.07\.03\.000\.0000 · Descuento Super - por Ac comerciales">Descuento Super - por Ac comerciales<\/td>/,
    'la fila de la cuenta sigue empezando por el número');
  assert.match(PANEL, /#sec-pl-abasto \.pla-cta td:first-child,#sec-pl-abasto \.pla-aju td:first-child\{white-space:normal;overflow:visible;\r?\n\s+text-overflow:clip;overflow-wrap:anywhere\}/);
  // V1063: el concepto va angosto y en píxeles, y con dos meses las columnas se estiran para
  // llenar la pantalla. El concepto ya no se lleva dos tercios del cuadro.
  assert.match(h, /^<colgroup><col style="width:248px"><col style="width:365px"><col style="width:281px"><col style="width:281px"><\/colgroup>/);
  // Con doce meses las columnas llegan a su mínimo, y ahí es donde aparece la barra de abajo.
  const doce = Object.assign({}, DATOS, { meses: ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'] });
  assert.match(PANTALLA(doce), /^<colgroup><col style="width:248px"><col style="width:120px">(<col style="width:92px">){12}<\/colgroup>/);
  // Con doce meses los meses ya están en su mínimo, así que el colchón de la barra vertical no
  // los toca: lo que cambia es cuándo aparece la barra, no el ancho mínimo de una columna.
});

const NB_PLANILLA = { desde: '2026-07', hasta: '2026-09', total: { diferencia: -12123641.19 }, sin_pareja: 2, emparejados: 2, recortado: 0,
  dias: [
    { fecha: '2026-09-09', debe: 1796256, haber: 1596672, diferencia: 199584, asientos: [
      { asiento: '380782', debe: 1796256, haber: 1596672, diferencia: 199584, renglones: [
        { cuenta: '4.1.01.00.000.0000', nombre: 'VENTAS', debe: 0, haber: 1596672 },
        { cuenta: '1.1.03.01.000.6105', nombre: 'CENCOSUD', debe: 1796256, haber: 0 }] }] },
    { fecha: '2026-07-06', debe: 6795000, haber: 19118225.194, diferencia: -12323225.19, asientos: [
      { asiento: '373340', debe: 0, haber: 12323225.19, diferencia: -12323225.19, renglones: [
        { cuenta: '1.1.03.01.000.6105', nombre: 'CENCOSUD', debe: 0, haber: 12323225.19 }] }] }] };
const NB_EXCEL = () => new Function('PLA', 'toast', 'XLSX', [
  /^var PLA_MES = .*;\r?$/m.exec(PANEL)[0], fuente(PANEL, 'function plaMesTxt(m){'), fuente(PANEL, 'function plaFechaTxt(f){'),
  fuente(PANEL, 'function plaNbEsResultado(c){'), fuente(PANEL, 'function plaNbTipo(a){'),
  fuente(PANEL, 'function plaNbPatron(a){'), fuente(PANEL, 'function plaNbAgrupar(d, clave){'),
  fuente(PANEL, 'function plaNbFilas(d){'), fuente(PANEL, 'function plaNbFormato(hoja, desdeFila, columnas){'),
  fuente(PANEL, 'function plaNbExcel(){'),
  'return { filas: plaNbFilas, excel: plaNbExcel, tipo: plaNbTipo, patron: plaNbPatron, agrupar: plaNbAgrupar };'].join('\n'));

// Pablo, 18/9/2026: «me inclino porque sea más simple: una hoja donde muestre todos los
// asientos que no balancean y el total, tipo diario de IVA; y en la otra solapa un detalle de
// cada asiento y la diferencia por la que no balancea, separando con una fila en blanco».

test('No balancea: la hoja de asientos lleva uno por fila y cierra con el total del período', () => {
  const F = NB_EXCEL()({}, () => {}, {});
  const P = F.filas(NB_PLANILLA);
  assert.deepEqual(P.asientos, [
    ['P&L Abasto — asientos que no balancean'],
    ['Período', 'Jul 2026 a Sep 2026'],
    [],
    ['Fecha', 'Asiento', 'Cuentas del asiento', 'Debe', 'Haber', 'Diferencia (debe − haber)'],
    ['09/09/2026', '380782', 'CENCOSUD + VENTAS', 1796256, 1596672, 199584],
    ['06/07/2026', '373340', 'CENCOSUD', 0, 12323225.19, -12323225.19],
    [],
    ['TOTAL', '2 asientos', '', 1796256, 13919897.19, -12123641.19]]);
  // El total del pie tiene que dar la diferencia que el servidor informa para el período: si
  // no, la planilla y la pantalla estarían contando cosas distintas.
  assert.equal(P.asientos[P.asientos.length - 1][5], NB_PLANILLA.total.diferencia);
  // Un solo asiento se dice en singular, que es lo que se lee al pie.
  const uno = F.filas(Object.assign({}, NB_PLANILLA, { dias: [NB_PLANILLA.dias[1]] }));
  assert.equal(uno.asientos[uno.asientos.length - 1][1], '1 asiento');
  // Y si hay más de los que entran, se avisa arriba de todo.
  assert.match(F.filas(Object.assign({}, NB_PLANILLA, { recortado: 1 })).asientos[2][1], /Hay más asientos sin pareja/);
});

test('No balancea: el detalle va un asiento abajo del otro, con su diferencia y una fila en blanco', () => {
  const F = NB_EXCEL()({}, () => {}, {});
  const P = F.filas(NB_PLANILLA);
  assert.deepEqual(P.detalle, [
    ['Fecha', 'Asiento', 'Cuenta', 'Nombre de la cuenta', 'Debe', 'Haber', 'Diferencia'],
    ['09/09/2026', '380782', '4.1.01.00.000.0000', 'VENTAS', 0, 1596672, ''],
    ['', '', '1.1.03.01.000.6105', 'CENCOSUD', 1796256, 0, ''],
    ['', '', '', 'No balancea por', 1796256, 1596672, 199584],
    [],
    ['06/07/2026', '373340', '1.1.03.01.000.6105', 'CENCOSUD', 0, 12323225.19, ''],
    ['', '', '', 'No balancea por', 0, 12323225.19, -12323225.19],
    []],
    'la fecha y el número van sólo en el primer renglón, y entre asiento y asiento va una fila en blanco');
});

test('No balancea: el botón arma un .xlsx de tres hojas, con los importes como números con dos decimales', () => {
  // Un SheetJS de mentira que arma las celdas como el de verdad: A1, B1… con t 'n' o 's'.
  const letra = (c) => String.fromCharCode(65 + c);
  let bajado = null, avisos = [];
  const XLSX = {
    utils: {
      book_new: () => ({ hojas: [] }),
      aoa_to_sheet: (aoa) => { const h = {}; aoa.forEach((f, r) => f.forEach((v, c) => { h[letra(c) + (r + 1)] = { t: typeof v === 'number' ? 'n' : 's', v }; })); return h; },
      decode_cell: (k) => ({ c: k.charCodeAt(0) - 65, r: Number(k.slice(1)) - 1 }),
      book_append_sheet: (l, h, n) => l.hojas.push([n, h]),
    },
    writeFile: (l, nombre) => { bajado = { l, nombre }; },
  };
  const F = NB_EXCEL()({ nb: NB_PLANILLA }, (t) => avisos.push(t), XLSX);
  F.excel();
  assert.ok(bajado, 'no bajó nada');
  assert.equal(bajado.nombre, 'No_balancea_2026-07_a_2026-09.xlsx');
  assert.deepEqual(bajado.l.hojas.map((x) => x[0]), ['Asientos', 'Detalle', 'Patrones']);
  const [asientos, detalle, patrones] = bajado.l.hojas.map((x) => x[1]);
  // La hoja de asientos: cada fila con sus tres importes, y el total del pie también.
  assert.equal(asientos.F5.v, 199584);
  assert.equal(asientos.D5.z, '#,##0.00');
  assert.equal(asientos.E5.z, '#,##0.00');
  assert.equal(asientos.F5.z, '#,##0.00', 'la diferencia del asiento no tiene formato de importe');
  assert.equal(asientos.C5.z, undefined, 'las cuentas no son un importe');
  assert.equal(asientos.F8.v, -12123641.19, 'el total no quedó al pie de la hoja');
  assert.equal(asientos.F8.z, '#,##0.00', 'el total no tiene formato de importe');
  // El detalle: debe, haber y la diferencia del cierre de cada asiento.
  assert.equal(detalle.E2.z, '#,##0.00');
  assert.equal(detalle.F2.z, '#,##0.00');
  assert.equal(detalle.G4.v, 199584);
  assert.equal(detalle.G4.z, '#,##0.00');
  assert.equal(detalle.C2.z, undefined, 'el número de cuenta no es un importe');
  // La hoja de patrones: la diferencia con formato de importe, y las cantidades sin decimales.
  assert.equal(patrones.D7.z, '#,##0.00');
  assert.equal(patrones.B7.z, undefined, 'la cantidad de asientos salió con decimales');
  assert.equal(patrones.C7.z, undefined, 'la cantidad de renglones salió con decimales');
  assert.ok(asientos['!cols'] && detalle['!cols'] && patrones['!cols'], 'sin ancho de columnas');
  // Sin nada que no balancee, o sin el armador del Excel, avisa y no baja nada.
  bajado = null;
  NB_EXCEL()({ nb: Object.assign({}, NB_PLANILLA, { dias: [] }) }, (t) => avisos.push(t), XLSX).excel();
  assert.equal(bajado, null);
  assert.match(avisos.pop(), /no hay nada que no balancee/);
  assert.match(PANEL, /<button class="btn bo" onclick="plaNbExcel\(\)">⬇️ Descargar Excel<\/button>/);
});

test('el asiento completo: todos sus renglones, del patrimonio también, con sus totales', () => {
  // Pablo, 15/9/2026: «aquí sería bueno que me muestre el asiento completo».
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_A });
  const a = llamar(R.asiento, { query: { asiento: '373353', fecha: '2025-07-13' } });
  assert.equal(a.code, 200, JSON.stringify(a.body));
  assert.deepEqual(a.body.data.renglones.map((x) => [x.cuenta, x.nombre, x.debe, x.haber]), [
    ['4.1.01.00.000.0000', 'VENTAS', 0, 868778.2805], ['2.1.03.01.000.0000', 'IVA Debito Fiscal', 0, 91221.7195],
    ['1.1.03.01.000.6427', 'CRUZ OSCAR FABIAN', 960000, 0]]);
  assert.deepEqual([a.body.data.debe, a.body.data.haber, a.body.data.diferencia], [960000, 960000, 0]);
  // El mismo número en otra fecha es otro asiento.
  assert.equal(llamar(R.asiento, { query: { asiento: '373353', fecha: '2025-07-14' } }).code, 404);
  assert.equal(llamar(R.asiento, { query: { asiento: '373353' } }).code, 400);
});

test('los asientos de un importe: un clic abre el asiento entero debajo, dice si balancea, y otro clic lo cierra', () => {
  const A = { asiento: '380782', fecha: '2026-09-11', debe: 2013984, haber: 1796256, renglones: [
    { cuenta: '4.1.01.00.000.0000', nombre: 'VENTAS', debe: 0, haber: 1596672 },
    { cuenta: '4.1.07.01.000.0000', nombre: 'Descuentos super', debe: 217728, haber: 0 },
    { cuenta: '2.1.03.02.000.0000', nombre: 'Percepciones Ingresos Brutos a Pagar', debe: 0, haber: 199584 },
    { cuenta: '1.1.03.01.000.6105', nombre: 'CENCOSUD', debe: 1796256, haber: 0 }] };
  const fuentes = [/^var PLA_MES = .*;\r?$/m.exec(PANEL)[0], fuente(PANEL, 'function plaFechaTxt(f){'),
    fuente(PANEL, 'function plaImporte(v, usd){'), fuente(PANEL, 'function plaAsientoHtml(a){')];
  const html = new Function('escH', fuentes.concat('return plaAsientoHtml;').join('\n'))(String);
  const h = html(A);
  assert.match(h, /Asiento <b>380782<\/b> del 11\/09\/2026 · 4 renglones/);
  assert.match(h, /<td>2\.1\.03\.02\.000\.0000<\/td><td title="Percepciones Ingresos Brutos a Pagar">Percepciones Ingresos Brutos a Pagar<\/td>/,
    'no están las cuentas del patrimonio');
  assert.match(h, /⚠️ No balancea por \$ 217\.728,00/);
  assert.match(html(Object.assign({}, A, { haber: 2013984 })), /✓ Balancea/);
  // La lista: cada renglón con asiento se abre con un clic.
  assert.match(fuente(PANEL, 'function plaDetallePintar(){'), /class="pla-det-fila" title="Clic: ver el asiento completo" onclick="plaAsientoVer\(this,/);
  // Abrir, cerrar, y volver a abrir sin pedirlo de nuevo.
  const cls = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) }; };
  const doc = { createElement: () => ({ attrs: {}, firstChild: { innerHTML: '' }, classList: cls(),
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } }) };
  const tbody = { hijos: [], insertBefore(e) { this.hijos.push(e); e.parentNode = this; }, removeChild(e) { this.hijos.splice(this.hijos.indexOf(e), 1); } };
  const tr = { parentNode: tbody, nextSibling: null, children: { length: 6 }, classList: cls() };
  let pedidos = [];
  const PLA = { detalle: { filas: [] } };
  const ver = new Function('PLA', 'document', 'api', 'escH', fuentes.concat(fuente(PANEL, 'function plaAsientoVer(tr, asiento, fecha){'),
    'return plaAsientoVer;').join('\n'))(PLA, doc, (url) => { pedidos.push(url); return { then(cb) { cb({ ok: true, data: A }); } }; }, String);
  ver(tr, '380782', '2026-09-11');
  assert.deepEqual(pedidos, ['/api/pl-abasto/asiento?asiento=380782&fecha=2026-09-11']);
  assert.equal(tbody.hijos.length, 1, 'no abre el asiento debajo del renglón');
  assert.match(tbody.hijos[0].firstChild.innerHTML, /No balancea por/);
  assert.ok(tr.classList.contains('abierta'));
  tr.nextSibling = tbody.hijos[0];
  ver(tr, '380782', '2026-09-11');
  assert.equal(tbody.hijos.length, 0, 'un segundo clic no lo cierra');
  assert.ok(!tr.classList.contains('abierta'));
  tr.nextSibling = null;
  ver(tr, '380782', '2026-09-11');
  assert.equal(pedidos.length, 1, 'lo vuelve a pedir al servidor');
  assert.equal(tbody.hijos.length, 1);
});

test('manual V1061: la ×, los nombres enteros, y el Excel de lo que no balancea', () => {
  assert.match(manual(), /En los asientos de un importe, <b>un clic en un renglón abre el asiento completo<\/b> debajo: todas sus cuentas —las del patrimonio también— con su debe y su haber, y abajo si balancea o por cuánto no/);
  const M = manual();
  assert.match(M, /Cada cuenta adentro de un título tiene una <b>×<\/b> que la devuelve a la lista, sin título/);
  assert.match(M, /cada cuenta se ve con su <b>nombre completo<\/b>: si es largo baja de renglón\. El número de la cuenta aparece pasando el mouse/);
  assert.match(M, /<b>⬇️ Descargar Excel<\/b> baja lo que no balancea del período elegido para mandarlo a revisar, en dos hojas simples: <b>Asientos<\/b>, con <b>un asiento por fila<\/b>/);
  assert.match(M, /<span class="ver">V1061<\/span> Una × en cada cuenta de un título/);
});

// ══ 6g · LA VENTA NO SE CUENTA DOS VECES (V1062) ═══════════════════════════════════════
//
// Pablo, 17/9/2026: «estamos sumando ventas y Utilidad; en realidad la venta la estamos tomando
// dos veces. Entonces las cuentas para ir descontando siempre hacelas a partir de Utilidad, pero
// para calcular los porcentajes hacelas siempre sobre la base de VENTAS».

test('la cascada arranca en UTILIDAD, y los porcentajes van sobre VENTAS', () => {
  const uno = (rubro, v) => ({ cuenta: rubro, nombre: rubro, rubro, meses: { '2025-07': v } });
  const d = { rubros: RUBROS, meses: ['2025-07'], meses_disponibles: ['2025-07'], cuentas: [
    uno('ventas', 1000), uno('utilidad', 300), uno('descuentos_super', -100), uno('costos_ventas', -60),
    uno('costos_fijos', -50), uno('costos_variables', -40), uno('costos_financieros', -20), uno('impuestos', -10)] };
  const T = TOTALES(d);
  assert.equal(T.rubros.ventas.TOTAL, 1000, 'VENTAS sigue mostrando su total');
  assert.equal(T.subtotales.margen.TOTAL, 140, 'el margen bruto todavía suma las ventas');
  assert.equal(T.subtotales.ebitda.TOTAL, 50);
  assert.equal(T.subtotales.ebt.TOTAL, 30);
  assert.equal(T.subtotales.neto.TOTAL, 20, 'el resultado neto suma las ventas además de su título');
  // Los porcentajes, sobre VENTAS: el margen es el 14% de 1.000.
  const h = PANTALLA(d);
  assert.match(h, /<span class="pla-pos">140<\/span><span class="pla-pct pla-pct-pos">14%<\/span>/);
  assert.match(h, /<span class="pla-pos">1\.000<\/span><span class="pla-pct pla-pct-pos">100%<\/span>/);
  // Y se dice dónde: en la fila de VENTAS, pasando el mouse.
  assert.match(h, /<td title="VENTAS es la base de los porcentajes: no suma al resultado, sus cuentas suman desde su título"/);
});

test('el cuadro avisa si una cuenta quedó con VENTAS como título: no sumaría a ningún lado', () => {
  const caja = {};
  const aviso = (cuentas) => {
    new Function('eid', 'escH', 'lnbPuedeOperar', [fuente(PANEL, 'function plaFechaTxt(f){'), fuente(PANEL, 'function plaAviso(d){'),
      'plaAviso({ ultima_carga: { archivo: "d.xls", desde: "2026-07-01", hasta: "2026-09-14" }, cuentas: ' + JSON.stringify(cuentas) + ' });'].join('\n'))(
      () => caja, String, () => true);
    return caja.innerHTML;
  };
  assert.match(aviso([{ rubro: 'ventas' }, { rubro: 'ventas' }, { rubro: 'utilidad' }]),
    /⚠️ 2 cuentas tienen <b>VENTAS<\/b> como título: VENTAS es la base de los porcentajes y no suma al resultado/);
  assert.ok(!/como título/.test(aviso([{ rubro: 'utilidad' }, { rubro: 'costos_fijos' }])), 'avisa sin que haya ninguna');
});

test('manual V1062: la cascada arranca en UTILIDAD y VENTAS es la base de los porcentajes', () => {
  const M = manual();
  assert.match(M, /<b>VENTAS no suma al resultado<\/b>: es la <b>base de los porcentajes<\/b>/);
  assert.match(M, /Sus cuentas suman desde el título donde están —por ejemplo, repetidas en UTILIDAD—, así la venta no se cuenta dos veces/);
  assert.match(M, /Si una cuenta queda con <b>VENTAS como título<\/b>, no suma a ningún lado y el cuadro lo avisa arriba/);
  assert.match(M, /<span class="ver">V1062<\/span> La cascada arranca en UTILIDAD y VENTAS queda como base de los porcentajes/);
  assert.match(fuente(PANEL, 'function plaTotales(d){'), /sub\.neto = sumar\(Object\.keys\(rub\)\.filter\(function\(k\)\{ return k !== 'ventas'; \}\)\);/);
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

// ══ 7c · EL CUADRO ENTRA AUNQUE SE AGREGUEN MESES (V1063) ═════════════════════════════
//
// Pablo, 17/9/2026: «donde están encolumnados los conceptos ocupa mucho lugar, hacé esa columna
// más fina para darle más protagonismo a los números. Se van a ir agregando meses, por lo que es
// necesario que la columna Concepto y la columna Total queden siempre fijas y tener una barra
// desplazadora lateral para el detalle de cada uno de los meses».

const ANCHOS = new Function([lineaVar('PLA_ANCHO'), fuente(PANEL, 'function plaAnchos(caja, columnas){'),
  'return { anchos: plaAnchos, PLA_ANCHO: PLA_ANCHO };'].join('\n'))();

test('los anchos del cuadro: el concepto fijo y angosto, y los meses repartiéndose lo que sobra', () => {
  const { anchos, PLA_ANCHO } = ANCHOS;
  // Con tres meses entra todo: no hace falta barra y las columnas se estiran.
  const pocos = anchos(1180, 4);
  assert.ok(pocos.tabla <= 1180, 'con tres meses ya hay barra, y no hacía falta: ' + pocos.tabla);
  assert.ok(pocos.mes > PLA_ANCHO.mes, 'con pocos meses las columnas no se estiran');
  // Con dos años no entra: ahí la barra es la única manera de ver los meses viejos.
  const muchos = anchos(1180, 25);
  assert.equal(muchos.mes, PLA_ANCHO.mes, 'con 24 meses las columnas se achican más allá del mínimo');
  assert.ok(muchos.tabla > 1180, 'con 24 meses la tabla entra en la pantalla: no habría nada que recorrer');
  // El concepto NUNCA cambia: es el lugar exacto donde el CSS pega la columna del TOTAL.
  assert.equal(anchos(420, 25).concepto, PLA_ANCHO.concepto);
  assert.equal(anchos(2400, 2).concepto, PLA_ANCHO.concepto);
  assert.ok(PLA_ANCHO.concepto <= 260, 'la columna del concepto dejó de ser angosta');
  // El TOTAL, más ancho que un mes: es la columna con más cifras.
  assert.ok(pocos.total > pocos.mes && muchos.total > muchos.mes);
  // Y una caja que todavía no se midió no rompe el cuadro.
  assert.equal(anchos(0, 4).tabla, anchos(PLA_ANCHO.caja, 4).tabla);
});

test('el cuadro sale con esos anchos, y Concepto y TOTAL quedan pegados mientras los meses corren', () => {
  const h = PANTALLA(DATOS);
  const { anchos, PLA_ANCHO } = ANCHOS;
  const A = anchos(1180, 3);   // TOTAL + dos meses
  assert.ok(h.startsWith('<colgroup><col style="width:' + PLA_ANCHO.concepto + 'px"><col style="width:'
    + A.total + 'px"><col style="width:' + A.mes + 'px"><col style="width:' + A.mes + 'px"></colgroup>'), h.slice(0, 200));
  // EL HUECO DE LA BARRA VERTICAL LO RESERVA EL CSS (V1073), así que el ancho que llega acá ya
  // viene sin él y no hay que descontarlo otra vez: los 18 px que se restaban eran ese mismo
  // hueco por segunda vez —21 a 23 px de tabla sin usar—. Queda un respiro de 4.
  assert.ok(A.tabla <= 1180, 'la tabla sale más ancha que su caja: ' + A.tabla);
  assert.ok(A.tabla > 1180 - 16, 'se sigue descontando la barra dos veces: ' + A.tabla);
  assert.match(PANEL, /\.ab-table-wrap\{overflow:auto !important;scrollbar-gutter:stable;/);
  assert.equal(TABLA.style.width, A.tabla + 'px', 'la tabla no se lleva su ancho: las columnas pegadas se desalinean');
  // Sin meses no queda el ancho de la vez anterior.
  PANTALLA({ rubros: RUBROS, meses: [], meses_disponibles: [] });
  assert.equal(TABLA.style.width, '');
  // La caja del cuadro scrollea sola y llega hasta el pie de la pantalla; No balancea, no.
  assert.match(PANEL, /#pla-pane-resultado \.ab-table-wrap\{overflow:auto !important;scrollbar-gutter:stable;\r?\n\s+max-height:max\(320px,calc\(100vh - 300px\)\)\}/);
  assert.match(PANEL, /#sec-pl-abasto \.ab-table-wrap\{overflow-x:hidden !important\}/);
  // Las dos primeras columnas, pegadas, y la del TOTAL justo donde termina el concepto.
  assert.match(PANEL, /#pla-pane-resultado \.pla-tbl th:first-child,#pla-pane-resultado \.pla-tbl td:first-child\{\r?\n\s+position:sticky;left:0;z-index:2\}/);
  assert.match(PANEL, new RegExp('#pla-pane-resultado \\.pla-tbl th:nth-child\\(2\\),#pla-pane-resultado \\.pla-tbl td:nth-child\\(2\\)\\{\r?\n\\s+position:sticky;left:'
    + ANCHOS.PLA_ANCHO.concepto + 'px'));
  // Y con fondo propio: una celda pegada transparente deja leer los meses por debajo.
  for (const [clase, fondo] of [['pla-rub', '#f8fafc'], ['pla-sub', '#dbeafe'], ['pla-res', '#0a2744']]) {
    assert.ok(PANEL.includes('#pla-pane-resultado .' + clase + ' td:first-child,#pla-pane-resultado .'
      + clase + ' td:nth-child(2){background:' + fondo + '}'), clase + ' pegada sin fondo');
  }
  assert.match(PANEL, /#pla-pane-resultado \.pla-aju-add td,#pla-pane-resultado \.pla-aju-pend td\{position:static\}/,
    'la fila de agregar un ajuste es un colspan: pegada taparía los meses');
});

// ══ 7d · INVESTIGAR LOS QUE NO BALANCEAN (V1063) ══════════════════════════════════════
//
// Pablo, 17/9/2026: «se me ocurre también, dentro del detalle de asientos, tener un tilde para
// ver los "no balancea" así podemos investigarlos más fácilmente».

// Los movimientos que el otro sistema dejó descuadrados, para la prueba de abajo.
const CARGA_NB = (N) => ({ cuentas: N, renglones: [
  // 6/7: la compra y su pago en dos números —se compensan— y una sola que queda sin pareja.
  ['2026-07-06', '372811', '4.1.01.01.000.0000', 6795000, 0],
  ['2026-07-06', '372977', '1.1.01.03.006.0000', 0, 6795000],
  ['2026-07-06', '373340', '4.1.01.01.000.0000', 0, 2762500],
  // 7/7: un asiento que cierra.
  ['2026-07-07', '373400', '4.1.01.01.000.0000', 0, 1000], ['2026-07-07', '373400', '1.1.01.03.001.0000', 1000, 0],
  // 8/8: dos que no cierran solos, pero el día sí: no son error.
  ['2026-08-08', '374003', '4.1.01.01.000.0000', 4080000, 0],
  ['2026-08-08', '374160', '1.1.01.03.006.0000', 0, 2040000], ['2026-08-08', '374160', '1.1.01.03.006.0000', 0, 2040000],
  // 9/9: el día también cierra, pero acá lo que no cierra NO se compensa de a dos —100 contra
  // 60 y 40—, así que mirar sólo los asientos marcaría los tres. El día es lo que manda.
  ['2026-09-09', '380001', '4.1.01.01.000.0000', 100, 0],
  ['2026-09-09', '380002', '1.1.01.03.006.0000', 0, 60],
  ['2026-09-09', '380003', '1.1.01.03.006.0000', 0, 40],
] });

test('los asientos de un importe marcan cuáles no balancean, con la misma regla que la solapa', () => {
  const db = base();
  const R = rutas(db);
  const N = Object.assign({}, NOMBRES, { '1.1.01.03.006.0000': 'Cheques Propios' });
  assert.equal(llamar(R.cargar, { body: CARGA_NB(N) }).code, 200);
  const d = llamar(R.detalle, { query: { cuenta: '4.1.01.01.000.0000', desde: '2026-07', hasta: '2026-09' } }).body.data;
  assert.deepEqual(d.filas.map((f) => [f.asiento, f.sin_pareja]),
    [['380001', 0], ['374003', 0], ['373400', 0], ['373340', 1], ['372811', 0]],
    'marca de más: los del 8/8 y el 9/9 no cierran solos, pero esos días balancean, y el del 6/7 tiene su pareja');
  // Y son EXACTAMENTE los que lista la solapa No balancea: una sola regla para las dos pantallas.
  const nb = llamar(R.noBalancea, {}).body.data;
  assert.deepEqual(nb.dias.map((x) => x.fecha), ['2026-07-06'], 'un día que cierra no es de lo que no balancea');
  assert.deepEqual(nb.dias.flatMap((x) => x.asientos.map((a) => a.asiento)), ['373340']);
});

const DETALLE = (filas, o = {}) => {
  const els = { 'pla-detalle-q': { value: o.q || '' }, 'pla-detalle-nb': { checked: !!o.soloNb },
    'pla-detalle-nb-n': { textContent: 'sin tocar' }, 'pla-detalle-nota': { textContent: '' },
    'pla-detalle-tabla': { innerHTML: '' } };
  const D = { tipo: 'cuenta', filas, ajustes: [], recortado: 0,
    total: { renglones: filas.length, debe: filas.reduce((s, f) => s + (f.debe || 0), 0),
      haber: filas.reduce((s, f) => s + (f.haber || 0), 0) } };
  new Function('PLA', 'eid', 'escH', 'nr', 'sgNorm', [
    /^var PLA_MES = .*;\r?$/m.exec(PANEL)[0],
    fuente(PANEL, 'function plaMesTxt(m){'), fuente(PANEL, 'function plaFechaTxt(f){'),
    fuente(PANEL, 'function plaImporte(v, usd){'), fuente(PANEL, 'function plaDetallePintar(){'),
    'plaDetallePintar();'].join('\n'))({ detalle: D }, (id) => els[id], String, String,
    (x) => String(x).toLowerCase());
  return els;
};

test('el tilde de «sólo los que no balancean»: filtra, los marca igual, y los totales son de lo que se ve', () => {
  const filas = [
    { fecha: '2026-09-09', asiento: '380782', cuenta: '4.1.01', nombre: 'VENTAS', contrapartida: 'CENCOSUD',
      debe: 0, haber: 1596672, sin_pareja: 1 },
    { fecha: '2026-09-08', asiento: '380700', cuenta: '4.1.01', nombre: 'VENTAS', contrapartida: 'COTO',
      debe: 0, haber: 1000, sin_pareja: 0 },
  ];
  const todo = DETALLE(filas), t = todo['pla-detalle-tabla'].innerHTML;
  assert.equal(todo['pla-detalle-nb-n'].textContent, ' (1)', 'no dice cuántos no balancean');
  assert.match(t, /⚠️<\/span> 380782/, 'el que no balancea no se ve marcado sin poner el tilde');
  assert.ok(!/⚠️<\/span> 380700/.test(t), 'marca uno que sí balancea');
  assert.match(t, /TOTAL \(2 movimientos\)/);
  const solo = DETALLE(filas, { soloNb: true }), s = solo['pla-detalle-tabla'].innerHTML;
  assert.ok(s.includes('380782'), 'el tilde se lleva puesto el que no balancea');
  assert.ok(!s.includes('380700'), 'el tilde no filtra');
  assert.match(s, /TOTAL \(1 movimientos\)/);
  assert.match(s, /1\.596\.672,00/, 'el total no es el de lo que se ve');
  assert.match(solo['pla-detalle-nota'].textContent, /Sólo los que no balancean: 1 de 2/);
  // Y si están todos bien, lo dice en vez de dejar la lista muda.
  const ninguno = DETALLE([filas[1]], { soloNb: true });
  assert.match(ninguno['pla-detalle-nota'].textContent, /Ninguno de estos movimientos está en un asiento sin pareja/);
  assert.equal(ninguno['pla-detalle-nb-n'].textContent, '');
  // El tilde arranca sin tildar cada vez que se abre la ventana.
  assert.match(fuente(PANEL, 'function plaDetalle(tipo, clave, mes){'),
    /var nb = eid\('pla-detalle-nb'\); if \(nb\) nb\.checked = false;/);
  assert.match(PANEL, /<input type="checkbox" id="pla-detalle-nb" onchange="plaDetallePintar\(\)"/);
});

// ══ 7e · LOS PATRONES DE LO QUE NO BALANCEA (V1063) ═══════════════════════════════════
//
// Pablo, 17/9/2026: «mejorá mucho el Excel de NO BALANCEA: si podés separalos por tipo, si hay
// algún patrón o algo, para pasarle al programador actual y que pueda mejorarlos».

test('cada asiento sin pareja dice de qué tipo es y con qué cuentas está hecho', () => {
  const F = NB_EXCEL()({}, () => {}, {});
  const R = (...cuentas) => ({ renglones: cuentas.map((c) => ({ cuenta: c, nombre: 'C' + c })) });
  assert.equal(F.tipo(R('4.1.01')), 'Un solo renglón');
  assert.equal(F.tipo(R('1.1.03')), 'Un solo renglón', 'un renglón solo es un renglón solo, sea de lo que sea');
  assert.equal(F.tipo(R('4.1.01', '4.1.07')), 'Sólo cuentas de resultado');
  assert.equal(F.tipo(R('1.1.03', '2.1.03')), 'Sólo cuentas del patrimonio');
  assert.equal(F.tipo(R('3.1.02', '5.1.01')), 'Mezcla de resultado y patrimonio');
  assert.equal(F.tipo({ renglones: [] }), 'Un solo renglón');
  // Y «de resultado» quiere decir lo mismo en la pantalla que en el servidor: el panel no puede
  // importar el servicio, así que la regla está escrita dos veces y acá se atan.
  const esRes = new Function([fuente(PANEL, 'function plaNbEsResultado(c){'), 'return plaNbEsResultado;'].join('\n'))();
  for (const c of ['4.1.01', '5.2.03', '1.1.03', '2.1.03', '3.1.02', '9.9', '', 'x', null]) {
    assert.equal(esRes(c), SVC.esCuentaDeResultado(c), 'la pantalla y el servidor no dicen lo mismo de ' + c);
  }
  // El patrón: las cuentas sin repetir y siempre en el mismo orden, o dos asientos iguales
  // contarían como dos patrones distintos.
  const P = (...nombres) => ({ renglones: nombres.map((n) => ({ cuenta: '1.1', nombre: n })) });
  assert.equal(F.patron(P('VENTAS', 'CENCOSUD', 'VENTAS')), 'CENCOSUD + VENTAS');
  assert.equal(F.patron(P('CENCOSUD', 'VENTAS')), F.patron(P('VENTAS', 'CENCOSUD')));
  // Y el resumen: lo más repetido arriba, con un asiento para ir a buscarlo al otro sistema.
  const dia = (fecha, asientos) => ({ fecha, asientos });
  const as = (asiento, dif, ...nombres) => ({ asiento, diferencia: dif,
    renglones: nombres.map((n) => ({ cuenta: '4.1.01', nombre: n })) });
  const d = { dias: [dia('2026-09-09', [as('1', 100, 'VENTAS', 'COTO'), as('2', 200, 'COTO', 'VENTAS')]),
    dia('2026-09-08', [as('3', -5000, 'Cheques Propios')])] };
  assert.deepEqual(F.agrupar(d, F.patron).map((x) => [x.k, x.n, x.dif, x.renglones, x.ejemplo]), [
    ['COTO + VENTAS', 2, 300, 4, '1 del 09/09/2026'],
    ['Cheques Propios', 1, -5000, 1, '3 del 08/09/2026']]);
});

test('la hoja Patrones del Excel: por tipo y por combinación, de lo más repetido a lo menos', () => {
  const F = NB_EXCEL()({}, () => {}, {});
  const P = F.filas(NB_PLANILLA).patrones;
  const cab = ['Tipo o combinación de cuentas', 'Asientos', 'Renglones', 'Diferencia (debe − haber)', 'Un asiento de ejemplo'];
  assert.deepEqual(P.slice(0, 6), [['P&L Abasto — los patrones de lo que no balancea'],
    ['Período', 'Jul 2026 a Sep 2026'], ['Asientos sin pareja', 2], [], ['POR TIPO DE ASIENTO'], cab]);
  assert.deepEqual(P.slice(6), [
    ['Un solo renglón', 1, 1, -12323225.19, '373340 del 06/07/2026'],
    ['Mezcla de resultado y patrimonio', 1, 2, 199584, '380782 del 09/09/2026'],
    [], ['POR COMBINACIÓN DE CUENTAS — de la que más se repite a la que menos'], cab,
    ['CENCOSUD', 1, 1, -12323225.19, '373340 del 06/07/2026'],
    ['CENCOSUD + VENTAS', 1, 2, 199584, '380782 del 09/09/2026']]);
});

test('el patrón que más se repite se lee en la pantalla, sin bajar el Excel', () => {
  const els = { 'pla-nb-tabla': { innerHTML: '' }, 'pla-nb-resumen': { innerHTML: '' } };
  const d = { meses_disponibles: ['2026-09'], desde: '2026-09', hasta: '2026-09', sin_pareja: 2, emparejados: 0,
    recortado: 0, total: { diferencia: 300 },
    dias: [{ fecha: '2026-09-09', debe: 300, haber: 0, diferencia: 300, asientos: [
      { asiento: '1', debe: 100, haber: 0, diferencia: 100, renglones: [
        { cuenta: '4.1.01', nombre: 'VENTAS', debe: 100, haber: 0 },
        { cuenta: '1.1.03', nombre: 'CENCOSUD', debe: 0, haber: 0 }] },
      { asiento: '2', debe: 200, haber: 0, diferencia: 200, renglones: [
        { cuenta: '1.1.03', nombre: 'CENCOSUD', debe: 200, haber: 0 },
        { cuenta: '4.1.01', nombre: 'VENTAS', debe: 0, haber: 0 }] }] }] };
  new Function('PLA', 'eid', 'escH', 'nr', [
    /^var PLA_MES = .*;\r?$/m.exec(PANEL)[0],
    fuente(PANEL, 'function plaMesTxt(m){'), fuente(PANEL, 'function plaFechaTxt(f){'),
    fuente(PANEL, 'function plaImporte(v, usd){'), fuente(PANEL, 'function plaNbEsResultado(c){'),
    fuente(PANEL, 'function plaNbTipo(a){'), fuente(PANEL, 'function plaNbPatron(a){'),
    fuente(PANEL, 'function plaNbAgrupar(d, clave){'), fuente(PANEL, 'function plaNbPatronTxt(d){'),
    fuente(PANEL, 'function plaNbResumen(d){'), fuente(PANEL, 'function plaNbPintar(){'), 'plaNbPintar();',
  ].join('\n'))({ nb: d, nbAbiertos: {} }, (id) => els[id], String, String);
  assert.match(els['pla-nb-resumen'].innerHTML,
    /El patrón que más se repite es <b>CENCOSUD \+ VENTAS<\/b>: 2 asientos/);
});

// ══ 7f · EL MARGEN ES LO QUE SE MIRA (V1064) ══════════════════════════════════════════
//
// Pablo, 18/9/2026: «una cuestión de diseño nomás: me gustaría ver mejor y más grande los %
// márgenes, que son en definitiva lo que revisamos».

// El font-size de una regla del CSS del módulo, para comparar jerarquías de verdad y no
// confiar en que el número esté escrito en algún lado.
const tamano = (selector) => {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{}]*\\{[^}]*font-size:([\\d.]+)px');
  const m = re.exec(PANEL);
  assert.ok(m, 'no está el tamaño de ' + selector);
  return Number(m[1]);
};

test('el % de los márgenes se ve más grande que el del rubro y que el propio importe', () => {
  const pctRubro = tamano('#sec-pl-abasto .pla-pct');
  const pctMargen = tamano('#sec-pl-abasto .pla-sub .pla-pct,#sec-pl-abasto .pla-res .pla-pct');
  const importe = tamano('#sec-pl-abasto .pla-tbl');
  assert.ok(pctMargen > pctRubro + 2, 'el % del margen no se despega del de los rubros: ' + pctMargen + ' vs ' + pctRubro);
  assert.ok(pctMargen > importe, 'el % del margen no manda sobre el importe: ' + pctMargen + ' vs ' + importe);
  assert.ok(pctRubro >= 10, 'el % de los rubros quedó ilegible: ' + pctRubro);
  // Y las filas de subtotal respiran, o el número grande queda apretado contra el de arriba.
  assert.match(PANEL, /#sec-pl-abasto \.pla-sub td,#sec-pl-abasto \.pla-res td\{padding-top:7px;padding-bottom:7px\}/);
  // El NOMBRE del margen también pesa: con el % a 14 px y la etiqueta a 11, la fila quedaba a
  // media máquina.
  assert.ok(tamano('#sec-pl-abasto .pla-sub td:first-child') > importe,
    'la etiqueta del subtotal quedó del tamaño de una fila cualquiera');
  assert.ok(tamano('#sec-pl-abasto .pla-res td:first-child') >= tamano('#sec-pl-abasto .pla-sub td:first-child'),
    'el resultado neto no manda sobre los subtotales');
});

test('el % lleva el color de su signo, y sobre el azul del resultado no se pierde', () => {
  const h = PANTALLA(DATOS);
  // Agosto: el margen es -18% de las ventas → rojo. Las ventas, 100% → verde.
  assert.match(h, /<span class="pla-pct pla-pct-neg">-18%<\/span>/);
  assert.match(h, /<span class="pla-pct pla-pct-pos">100%<\/span>/);
  // El color lo decide el PORCENTAJE que se lee, no el importe: con ventas negativas el % da
  // positivo y tiene que verse verde aunque el importe esté en rojo.
  const alReves = { rubros: RUBROS, meses: ['2025-07'], meses_disponibles: ['2025-07'], cuentas: [
    { cuenta: '4.1.01', nombre: 'VENTAS', rubro: 'ventas', meses: { '2025-07': -1000 } },
    { cuenta: '4.2.01', nombre: 'COSTO', rubro: 'costos_ventas', meses: { '2025-07': -500 } }] };
  assert.match(PANTALLA(alReves), /<span class="pla-neg">-500<\/span><span class="pla-pct pla-pct-pos">50%<\/span>/);
  // Los colores: verde y rojo en los subtotales; los claros sobre el azul del resultado neto.
  assert.match(PANEL, /#sec-pl-abasto \.pla-sub \.pla-pct-pos\{color:#15803d\} #sec-pl-abasto \.pla-sub \.pla-pct-neg\{color:#b91c1c\}/);
  assert.match(PANEL, /#sec-pl-abasto \.pla-res \.pla-pct-pos\{color:#4ade80\} #sec-pl-abasto \.pla-res \.pla-pct-neg\{color:#fca5a5\}/);
  // Sin base de ventas no hay % que pintar: la celda queda con su importe y nada más.
  const sinVentas = { rubros: RUBROS, meses: ['2025-07'], meses_disponibles: ['2025-07'], cuentas: [
    { cuenta: '4.2.01', nombre: 'COSTO', rubro: 'costos_ventas', meses: { '2025-07': -500 } }] };
  assert.ok(!PANTALLA(sinVentas).includes('pla-pct'), 'inventa un porcentaje sin ventas contra qué medir');
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
  assert.match(M, /<b>Hasta 24 meses por vez<\/b>/);
  assert.match(M, /Los importes se ven en <b>pesos, miles o millones<\/b>/);
  assert.match(M, /Entran las <b>cuentas de resultado<\/b>\. Las que empiezan con 1, 2 o 3 son del patrimonio —caja, clientes, proveedores, IVA—: <span class="ver">V1057<\/span> se ven igual en la lista de Configurar rubros, arrancan sin título y no están en el cuadro; si alguien les pone uno, entran/);
  assert.equal(SVC.esCuentaDeResultado('1.1.01'), false);
  assert.match(M, /Lee <b>todas las hojas<\/b>/);
  assert.match(fuente(PANEL, 'function plaCargaArchivo(input){'), /wb\.SheetNames\.map\(function\(n\)\{/);
  assert.match(M, /<b>lo avisa y lo guarda igual<\/b>/);
  assert.match(M, /el resto del 4\.1 que no es gasto «G -» —ventas, y comisiones, descargas y fletes ganados— a ventas/);
  assert.equal(SVC.rubroPorDefecto('4.1.13.00.000.0000', 'G - Alquiler espacio físico'), 'sin_asignar');
  assert.match(M, /<b>Todo lo demás arranca sin título<\/b>, la compra de mercadería también/);
  assert.equal(SVC.rubroPorDefecto('4.1.01.01.000.0000', 'G - COMPRA MERCADERIA'), 'sin_asignar');
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

test('manual V1063: el cuadro que entra con más meses, el tilde de los que no balancean, y la hoja de patrones', () => {
  const M = manual();
  assert.match(M, /<b>Hasta 24 meses por vez<\/b>: dos años/);
  assert.match(fuente(PANEL, 'function plaCargar(inicial){'), /dentro > 24/);
  assert.match(M, /La columna del <b>concepto es angosta<\/b>, para que manden los números, y <b>Concepto y TOTAL quedan fijos<\/b>/);
  assert.match(M, /los meses se recorren con la barra del cuadro/);
  assert.match(M, /Con pocos meses no hay barra: las columnas se estiran y ocupan la pantalla/);
  assert.match(M, /el tilde <b>⚠️ Sólo los que no balancean<\/b> deja únicamente los movimientos cuyo asiento <b>quedó sin pareja<\/b>/);
  assert.match(M, /con el tilde puesto el total de abajo es el de lo que se ve/);
  assert.match(M, /<b>Patrones<\/b>, que es lo que se le manda a quien mantiene el otro sistema/);
  assert.match(M, /agrupados <b>por tipo<\/b> —un solo renglón, sólo cuentas de resultado, sólo del patrimonio, o mezcla de las dos— y <b>por combinación de cuentas<\/b>/);
  assert.match(M, /<b>un asiento de ejemplo<\/b> para ir a buscarlo/);
  assert.match(M, /<span class="ver">V1063<\/span> El cuadro con el concepto angosto y las columnas Concepto y TOTAL fijas/);
});

test('manual V1064: el % de los márgenes, grande y con el color de su signo', () => {
  const M = manual();
  assert.match(M, /El de los <b>márgenes<\/b> —margen bruto, EBITDA, EBT y resultado neto— se ve <b>grande y con el color de su signo<\/b>: verde si es positivo, rojo si es negativo/);
  assert.match(M, /el de cada rubro queda más chico, un escalón atrás/);
  assert.match(M, /<span class="ver">V1064<\/span> Los márgenes se leen de un vistazo/);
});

test('manual V1067: el Excel de No balancea, en dos hojas simples', () => {
  const M = manual();
  assert.match(M, /y el <b>TOTAL<\/b> del período al pie, como un libro/);
  assert.match(M, /<b>Detalle<\/b>, con los renglones de cada asiento, abajo la línea <b>No balancea por<\/b>, y una <b>fila en blanco<\/b> antes del asiento siguiente/);
  assert.match(M, /<span class="ver">V1067<\/span> El Excel de No balancea, más simple/);
  // Y la hoja de patrones sigue siendo la tercera, no la que se lee todos los días.
  assert.match(M, /Y una tercera hoja, <b>Patrones<\/b>/);
});

// ══ 7g · EL TILDE NO SE MONTA SOBRE LA NOTA (V1068) ═══════════════════════════════════
//
// Pablo, 20/9/2026, con la ventana abierta y el tilde puesto: «corregime esto, que cuando
// tildo asientos que no cuadran se solapa todo».
//
// El <label> del tilde iba con white-space:nowrap y sin frenar la compresión del flex. Con
// la nota larga al lado —«Ninguno de estos movimientos está en un asiento sin pareja»— el
// navegador lo comprimía, y como el texto no se puede partir, DESBORDABA por encima de ella.

test('el tilde no se comprime, la que envuelve es la nota', () => {
  const i = PANEL.indexOf('#pla-detalle-modal .pla-det-filtros');
  assert.ok(i > 0, 'no está el estilo de los filtros de la ventana');
  const css = PANEL.slice(i, PANEL.indexOf('</style>', i));
  // Lo que causaba el solapamiento: el tilde tiene que quedar fijo.
  assert.match(css, /\.pla-det-nb\{[^}]*flex:0 0 auto/);
  assert.match(css, /\.pla-det-nb\{[^}]*white-space:nowrap/);
  // Y la nota es la que cede: puede achicarse hasta cero y bajar de renglón.
  assert.match(css, /#pla-detalle-nota\{[^}]*flex:1 1 200px;min-width:0/);
  // El buscador también cede, en vez de clavar su ancho y empujar a los otros dos.
  assert.match(css, /#pla-detalle-q\{[^}]*flex:1 1 220px/);
  // La casilla no se estira con los inputs de la ventana.
  assert.match(css, /\.pla-det-nb input\{flex:0 0 auto;width:auto;margin:0\}/);
});

test('el tilde se lee como una frase, no como un rótulo de campo', () => {
  const i = PANEL.indexOf('#pla-detalle-modal .pla-det-filtros');
  const css = PANEL.slice(i, PANEL.indexOf('</style>', i));
  // El panel pone TODOS los label en mayúsculas y con letter-spacing. Acá no: es una frase,
  // y en mayúsculas ocupa más ancho, que era justo lo que faltaba.
  assert.match(css, /\.pla-det-nb\{[^}]*text-transform:none/);
  assert.match(css, /\.pla-det-nb\{[^}]*letter-spacing:0/);
  // Y el HTML usa la clase: los estilos sueltos del label viejo no vuelven.
  assert.match(PANEL, /<label class="pla-det-nb"><input type="checkbox" id="pla-detalle-nb" onchange="plaDetallePintar\(\)">/);
  assert.ok(!/<label style="font-size:11\.5px;color:var\(--mut\);cursor:pointer;white-space:nowrap">/.test(PANEL),
    'volvió el label con estilos sueltos');
  // Y queda anotado en el historial del manual, que es donde Pablo mira qué cambió.
  assert.match(manual(), /<span class="ver">V1068<\/span> En los asientos de un importe, el tilde de los que no balancean dejó de montarse sobre el texto de al lado/);
});

// ══ 7h · LA BARRA DE LOS MESES, TAMBIÉN ARRIBA (V1069) ════════════════════════════════
//
// Pablo, 20/9/2026: «poné la barra arriba y abajo si no». La de abajo existe desde la V1063,
// pero vive al final de la tabla: medido en Chrome, con los rubros abiertos el cuadro mide
// 1.342 px y su borde inferior queda 648 px POR DEBAJO de la pantalla. O sea: estaba, y no se
// podía tocar sin bajar hasta el fondo.

// La barra con un DOM de mentira: dos cajas que scrollean y un fantasma que les da el ancho.
//
// DOS COSAS QUE EL MOCK VIEJO NO TENÍA, Y QUE SON EL BUG ENTERO (V1072):
//   1) LAS DOS CAJAS NO MIDEN IGUAL. El cuadro pierde el ancho de su barra VERTICAL; la de
//      arriba, que no la tiene, es esos ~15 px más ancha.
//   2) EL NAVEGADOR RECORTA. Escribir un scrollLeft más allá del tope deja el tope, no el número
//      que se escribió — y es justamente ahí donde las dos barras se peleaban.
const recorta = (o) => {
  let v = 0;
  Object.defineProperty(o, 'scrollLeft', {
    get() { return v; },
    set(x) { v = Math.min(Math.max(0, x), Math.max(0, o.scrollWidth - o.clientWidth)); },
  });
  return o;
};
const BARRA = (anchoTabla, anchoVisible, barraVertical = 15) => {
  const clases = new Set();
  const fantasma = { style: {} };
  const caja = recorta({ clientWidth: anchoVisible + barraVertical, style: {},
    get scrollWidth() { return Math.max(this.clientWidth, parseInt(fantasma.style.width, 10) || 0); },
    classList: { toggle: (c, v) => { if (v) clases.add(c); else clases.delete(c); } },
    h: {}, addEventListener(t, f) { this.h[t] = f; } });
  const wrap = recorta({ clientWidth: anchoVisible, scrollWidth: Math.max(anchoVisible, anchoTabla),
    h: {}, addEventListener(t, f) { this.h[t] = f; } });
  const els = { 'pla-barra-arriba': caja, 'pla-barra-fantasma': fantasma };
  new Function('eid', 'document', [
    fuente(PANEL, 'function plaBarraArriba(){'),
    'plaBarraArriba();',
  ].join('\n'))((id) => els[id], { querySelector: () => wrap });
  const tope = (e) => Math.max(0, e.scrollWidth - e.clientWidth);
  // El aviso de scroll le llega SÓLO a la que se movió de verdad —eso es lo que hace el
  // navegador— y se sigue la cadena hasta que ninguna se mueva más. Devuelve cuántas vueltas
  // hicieron falta: si se pelean, no termina nunca.
  let avisoC = 0, avisoW = 0;
  const asentar = () => {
    let vueltas = 0;
    for (; vueltas < 20; vueltas++) {
      let hubo = false;
      if (wrap.scrollLeft !== avisoW) { avisoW = wrap.scrollLeft; hubo = true; if (wrap.h.scroll) wrap.h.scroll(); }
      if (caja.scrollLeft !== avisoC) { avisoC = caja.scrollLeft; hubo = true; if (caja.h.scroll) caja.h.scroll(); }
      if (!hubo) break;
    }
    return vueltas;
  };
  return { caja, fantasma, wrap, clases, tope, asentar };
};

// ══ 7h-bis · EL TEMBLOR DEL CUADRO (V1072) ═══════════════════════════════════════════
//
// Pablo, 21/9/2026: «pasa algo con la pantalla del P&L que se tilda y no para de parpadear…
// me da la impresión que es algo con las barras de desplazamiento, es en el único lugar
// donde pasa». Medido en Chrome con el libro diario real: la de abajo llegaba a 58 y la de
// arriba sólo a 43 —los 15 px de la barra vertical del cuadro—, así que al llegar al final la
// de arriba le devolvía el cuadro para atrás. Con la rueda, el recorrido era 58 → 43 → 58.

test('las dos barras corren EXACTAMENTE lo mismo: el cuadro no salta para atrás en el final', () => {
  const b = BARRA(1564, 1506);   // los números medidos en Chrome con los rubros abiertos
  assert.equal(b.tope(b.wrap), 58);
  assert.equal(b.tope(b.caja), 58,
    'las dos barras llegan a lugares distintos: al final, una le devuelve el cuadro a la otra');
  // El fantasma NO lleva el ancho de la tabla: lleva lo que desborda más la caja de arriba. Con
  // el ancho de la tabla, la de arriba —15 px más ancha— se queda corta por esos mismos 15 px.
  assert.equal(b.fantasma.style.width, '1579px');
  // El usuario lleva el cuadro hasta el final y suelta: tiene que QUEDARSE ahí.
  b.wrap.scrollLeft = 99999;
  assert.equal(b.wrap.scrollLeft, 58);
  const vueltas = b.asentar();
  assert.equal(b.wrap.scrollLeft, 58, 'el cuadro se volvió para atrás solo al llegar al final');
  assert.equal(b.caja.scrollLeft, 58);
  assert.ok(vueltas <= 2, 'las barras se siguen peleando el scroll: ' + vueltas + ' vueltas');
  // Y al revés, desde la de arriba.
  b.caja.scrollLeft = 99999;
  assert.equal(b.asentar() <= 2, true);
  assert.equal(b.wrap.scrollLeft, 58);
  // CON ZOOM, EL SCROLL TRAE DECIMALES. Dos números que caen en el mismo píxel son el mismo lugar
  // de la pantalla: copiar uno sobre el otro sería moverse, moverse avisa, y avisar vuelve a
  // copiar. Una pelea de a fracciones de píxel se ve exactamente igual que el temblor.
  const z = BARRA(1564, 1506);
  z.wrap.scrollLeft = 30.4;
  z.asentar();
  z.caja.scrollLeft = 30.2;
  const vueltasZ = z.asentar();
  assert.ok(vueltasZ <= 2, 'se pelean por decimales: ' + vueltasZ + ' vueltas');
  assert.equal(z.wrap.scrollLeft, 30.4, 'un decimal de diferencia movió el cuadro');
});

test('manual V1073: el cuadro dejó de dibujarse dos veces, y llega justo al pie', () => {
  const M = manual();
  assert.match(M, /<span class="ver">V1073<\/span> Y dejó de dibujarse dos veces/);
  assert.match(M, /El lugar de la barra de bajar ahora está reservado desde el principio/);
  assert.match(M, /la página quedaba con una barra de bajar al pedo/);
  // Lo que el manual AFIRMA, contra el código.
  assert.match(PANEL, /\.ab-table-wrap\{overflow:auto !important;scrollbar-gutter:stable;/);
  assert.match(fuente(PANEL, 'function plaAltoCaja(){'), /getComputedStyle\(m\)\.paddingBottom/);
});

test('manual V1072: el cuadro dejó de temblar, y las dos barras llegan al final', () => {
  const M = manual();
  assert.match(M, /<span class="ver">V1072<\/span> El cuadro dejó de temblar al llegar al final de los meses/);
  assert.match(M, /las dos llegan hasta el final/);
  // Lo que el manual AFIRMA, contra el código: el fantasma se mide con la caja de arriba, no con
  // el ancho de la tabla, que es lo que dejaba a una 15 px corta.
  const b = fuente(PANEL, 'function plaBarraArriba(){');
  assert.match(b, /fantasma\.style\.width = \(desborde \+ caja\.clientWidth\) \+ 'px';/);
  assert.ok(!/plaBarraArriba\(ancho\)/.test(PANEL), 'todavía se dibuja con el ancho de la tabla');
});

test('aunque una barra no llegue tan lejos como la otra, no la arrastra para atrás', () => {
  // El cinturón de seguridad: si por lo que sea los topes quedan distintos —un decimal del zoom,
  // un repintado a mitad de camino— el que no llega deja al otro donde está.
  const b = BARRA(1564, 1506);
  b.caja.clientWidth = 1572;            // la de arriba se queda sin recorrido
  assert.equal(b.tope(b.caja), 7);
  b.wrap.scrollLeft = 58;
  const vueltas = b.asentar();
  assert.equal(b.wrap.scrollLeft, 58, 'la barra corta arrastró el cuadro para atrás');
  assert.ok(vueltas <= 2, 'se pelean: ' + vueltas + ' vueltas');
  // Y mientras el cuadro esté dentro de lo que la corta SÍ alcanza, se siguen como siempre.
  b.wrap.scrollLeft = 5;
  b.asentar();
  assert.equal(b.caja.scrollLeft, 5, 'dejaron de seguirse cuando sí podían');
});

test('las dos barras se mueven juntas, y ninguna le devuelve el eco a la otra', () => {
  const b = BARRA(2576, 1536);
  assert.equal(b.fantasma.style.width, '2591px', 'sin fantasma, la barra de arriba no corre nada');
  assert.ok(b.clases.has('on'), 'con 24 meses la barra de arriba tiene que verse');
  // Mover la de arriba mueve el cuadro...
  b.caja.scrollLeft = 420;
  b.caja.h.scroll();
  assert.equal(b.wrap.scrollLeft, 420);
  // ...y el eco de ese movimiento no lo devuelve, porque ya están en el mismo lugar.
  b.wrap.h.scroll();
  assert.equal(b.caja.scrollLeft, 420, 'las barras se empujan solas');
  // Y al revés: mover el cuadro mueve la de arriba.
  b.wrap.scrollLeft = 900;
  b.wrap.h.scroll();
  assert.equal(b.caja.scrollLeft, 900);
  // EL CASO QUE TRABABA EL MECANISMO VIEJO. Con un flag de «esto es un eco», copiar un valor que
  // YA ERA IGUAL no dispara el evento de vuelta, el flag queda encendido y se come el movimiento
  // siguiente. Acá se copia un valor igual a propósito, dos veces, y el de después tiene que pasar.
  b.caja.h.scroll();
  b.wrap.h.scroll();
  b.wrap.scrollLeft = 300;
  b.wrap.h.scroll();
  assert.equal(b.caja.scrollLeft, 300, 'el mecanismo se trabó: la barra dejó de seguir al cuadro');
  b.caja.scrollLeft = 77;
  b.caja.h.scroll();
  assert.equal(b.wrap.scrollLeft, 77);
});

test('si el cuadro entra entero, la barra de arriba no se muestra ni engancha nada', () => {
  const b = BARRA(1100, 1536);
  assert.equal(b.fantasma.style.width, '0px', 'le queda un fantasma ancho y la barra corre sin nada detrás');
  assert.ok(!b.clases.has('on'), 'una barra que no corre nada es ruido');
  assert.deepEqual(Object.keys(b.caja.h), [], 'engancha el scroll aunque no haga falta');
});

test('la barra va arriba del cuadro, pegada, y se dibuja en cada pintada', () => {
  assert.match(PANEL, /#pla-pane-resultado \.pla-barra\{position:sticky;top:0;z-index:10;display:none;/);
  assert.match(PANEL, /#pla-pane-resultado \.pla-barra\.on\{display:block\}/);
  const i = PANEL.indexOf('<div class="pla-barra" id="pla-barra-arriba"');
  const j = PANEL.indexOf('<div class="ab-table-wrap"><table class="pla-tbl" id="pla-tabla">');
  assert.ok(i > 0 && j > i, 'la barra de arriba no está arriba del cuadro');
  // Se pinta con el mismo ancho que se le puso a la tabla, y sin meses no queda colgada.
  const p = fuente(PANEL, 'function plaPintar(){');
  assert.equal((p.match(/plaBarraArriba\(\);/g) || []).length, 2, 'sin meses la barra queda colgada');
  // El alto se mide DOS veces: la barra de arriba, al aparecer, empuja el cuadro 16 px para
  // abajo, y medido antes de eso el cuadro se pasa de la pantalla por esos mismos 16 px.
  assert.match(p, /plaAltoCaja\(\);\r?\n  plaBarraArriba\(\);\r?\n  plaAltoCaja\(\);/);
  // Y la de abajo sigue estando: son las dos, no una en lugar de la otra. Vive en el borde de
  // la caja, que está acotada al alto de la pantalla, así que ahora también se alcanza.
  assert.match(PANEL, /#pla-pane-resultado \.ab-table-wrap\{overflow:auto !important;scrollbar-gutter:stable;/);
  assert.match(PANEL, /max-height:max\(320px,calc\(100vh - 300px\)\)\}/);
  // El manual lo cuenta: son dos y da igual cuál se use.
  const M = manual();
  assert.match(M, /hay <b>dos barras para correr los meses<\/b>, una <b>arriba<\/b> y otra <b>abajo<\/b> del cuadro, las dos siempre a la vista y moviéndose juntas/);
  assert.match(M, /el <b>encabezado de meses queda fijo arriba<\/b>/);
  assert.match(M, /Aparecen sólo cuando hay meses que no entran/);
  assert.match(M, /<span class="ver">V1069<\/span> El cuadro se lee como una planilla/);
});

test('el alto de la caja se mide contra la ventana, y nunca queda una ranura', () => {
  const alto = new Function([fuente(PANEL, 'function plaAltoDisponible(alto, top, abajo){'),
    'return plaAltoDisponible;'].join('\n'))();
  // Una ventana de 1000, el cuadro arrancando a 307 y 28 px de aire abajo: hasta el pie.
  assert.equal(alto(1000, 307, 28), 657);
  assert.equal(alto(1000, 307, 0), 685, 'el aire de abajo no se descuenta');
  // En una notebook baja, o con el cuadro muy abajo, no se achica mas alla del piso.
  assert.equal(alto(700, 520, 28), 320);
  assert.equal(alto(0, 0, 0), 320, 'sin medida todavia, la caja no puede nacer en cero');
  // EL AIRE DE ABAJO SE MIDE (V1073). Con 16 px fijos el cuadro terminaba mas abajo del pie de la
  // ventana —el panel tiene 28 de relleno— y la PAGINA se quedaba con una barra de bajar que no
  // hacia falta: medido en Chrome antes del arreglo, 13 px de sobra, siempre.
  // Se mide, no se estima: sale de la ventana y de donde arranca la caja.
  const caja = fuente(PANEL, 'function plaAltoCaja(){');
  assert.match(caja, /getComputedStyle\(m\)\.paddingBottom/);
  assert.ok(!/getBoundingClientRect\(\)\.bottom - r\.bottom/.test(caja),
    'el aire se mide contra el pie de main, que contiene al cuadro: la cuenta se muerde la cola');
  // Y NO SE ESCRIBE SI NO CAMBIO: escribirlo le cambia el tamano a lo que el observador mira, y
  // ese aviso se lo manda este mismo codigo a si mismo.
  assert.match(caja, /if \(wrap\.style\.maxHeight !== v\) wrap\.style\.maxHeight = v;/);
  assert.match(caja, /getBoundingClientRect\(\)/);
  assert.match(caja, /window\.innerHeight/);
  assert.match(caja, /if \(window\.innerWidth <= 900\) \{ wrap\.style\.maxHeight = ''; return; \}/);
  // Y se recalcula al pintar: ANTES de decidir si hace falta la barra de los meses —la barra
  // vertical le come unos 15 px al ancho visible y es con ese número que se decide— y OTRA VEZ
  // después, porque la barra de arriba, al aparecer, empuja el cuadro 16 px para abajo.
  // Se mira el final de la función: arriba de todo hay otra llamada a la barra, la del caso
  // «no hay meses», y con un indexOf a secas el orden parecería estar al revés.
  const p = fuente(PANEL, 'function plaPintar(){');
  const cola = p.slice(p.lastIndexOf("tb.innerHTML = h + '</tbody>';"));
  const iAlto = cola.indexOf('plaAltoCaja();'), iBarra = cola.indexOf('plaBarraArriba();');
  assert.ok(iAlto > 0, 'el alto de la caja no se recalcula al pintar');
  assert.ok(iBarra > iAlto, 'la barra decide con el ancho de antes de que aparezca la barra vertical');
  assert.ok(cola.indexOf('plaAltoCaja();', iBarra) > iBarra,
    'el alto queda medido con el cuadro 16 px más arriba de donde termina');
});

test('el encabezado de meses queda fijo, y las esquinas por encima de todo', () => {
  assert.match(PANEL, /#pla-pane-resultado \.pla-tbl thead th\{position:sticky;top:0;z-index:6;/);
  assert.match(PANEL, /#pla-pane-resultado \.pla-tbl thead th:nth-child\(2\)\{left:248px;z-index:7\}/);
  assert.match(PANEL, /#pla-pane-resultado \.pla-tbl thead th:first-child\{left:0;z-index:8\}/);
  // La esquina esta pegada en los dos ejes: tiene que ir arriba del resto del encabezado.
  const z = (re) => Number(re.exec(PANEL)[1]);
  const thead = z(/thead th\{position:sticky;top:0;z-index:(\d+);/);
  const esq2 = z(/thead th:nth-child\(2\)\{left:248px;z-index:(\d+)\}/);
  const esq1 = z(/thead th:first-child\{left:0;z-index:(\d+)\}/);
  const barra = z(/\.pla-barra\{position:sticky;top:0;z-index:(\d+);/);
  assert.ok(esq1 > esq2 && esq2 > thead, 'la escalera de z-index quedo mal: se montan entre si');
  assert.ok(barra > esq1, 'la barra de arriba queda debajo del encabezado');
  // Con los bordes de la tabla, una celda pegada se lleva el fondo pero no la linea.
  assert.match(PANEL, /#pla-pane-resultado \.pla-tbl\{border-collapse:separate;border-spacing:0\}/);
  assert.match(PANEL, /box-shadow:inset 0 -2px 0 var\(--bor\)/);
});

test('en el telefono se suelta todo, y al imprimir no sale cortado', () => {
  const movil = hasta(PANEL, '@media(max-width:900px){ #sec-pl-abasto .ab-table-wrap', '} }');
  assert.match(movil, /#pla-pane-resultado \.ab-table-wrap\{max-height:none !important;scrollbar-gutter:auto\}/,
    'el hueco de la barra vertical sirve donde el alto esta acotado; en el telefono es margen de mas');
  assert.match(movil, /#pla-pane-resultado \.pla-tbl th,#pla-pane-resultado \.pla-tbl td\{position:static !important\}/,
    'en el telefono el concepto puede pasar los 248px y el TOTAL se le monta encima');
  assert.match(movil, /#pla-pane-resultado \.pla-barra\{display:none !important\}/);
  const print = hasta(PANEL, '@media print{', '} }');
  assert.match(print, /max-height:none !important;overflow:visible !important/,
    'el alto va como estilo inline: sin !important, imprimir sale cortado');
  assert.match(print, /scrollbar-gutter:auto/, 'en el papel no hay barras que reservar');
  assert.match(print, /#pla-pane-resultado \.pla-barra\{display:none !important\}/);
});

test('el ancho se vuelve a calcular cuando cambia la caja, sin repintar de mas', () => {
  const o = fuente(PANEL, 'function plaObservarCaja(){');
  assert.match(o, /new ResizeObserver/);
  assert.match(o, /if \(w > 0 && Math\.abs\(w - PLA_ANCHO_PREV\) > 2\) \{ PLA_ANCHO_PREV = w; plaPintar\(\); \}/,
    'sin el umbral y el ancho > 0, repinta en bucle o con la pantalla cerrada');
  assert.match(o, /else plaAltoCaja\(\);/);
  assert.match(o, /if \(!wrap \|\| PLA_RO\) return;/, 'se engancharia un observador nuevo por cada visita');
  assert.match(fuente(PANEL, 'function plaInit(){'), /plaObservarCaja\(\);/);
  // EL OBSERVADOR MIRA EL BORDE, NO EL CONTENIDO (V1073). El ancho de contenido baja unos 15 px
  // en cuanto la caja saca su barra vertical —o sea en cuanto se abre un rubro—, y eso lo provoca
  // el propio dibujo: leido como «cambio la ventana», mandaba a dibujar todo de nuevo. Medido en
  // Chrome: dos reconstrucciones completas por cada clic, con 150 ms entre una y otra, y las
  // columnas cambiando de ancho en el medio. El borde exterior no se mueve por una barra de
  // adentro. Las dos mediciones tienen que ser del borde, o la comparacion no significa nada.
  assert.equal((o.match(/wrap\.offsetWidth/g) || []).length, 2, 'todavia se mide el ancho de contenido');
  assert.ok(!/wrap\.clientWidth/.test(o), 'el observador se despierta con su propia barra vertical');
  // Y el dibujo deja anotado el ancho con el que termino: si no, el primero de cada entrada se
  // compara contra una medicion vieja —la tomada con el cartel «Cargando…» puesto— y dispara otro.
  assert.match(fuente(PANEL, 'function plaPintar(){'),
    /if \(tb\.parentNode && tb\.parentNode\.offsetWidth\) PLA_ANCHO_PREV = tb\.parentNode\.offsetWidth;/);
  const car = fuente(PANEL, 'function plaCargar(inicial){');
  assert.match(car, /Cargando…/, 'ya no hay cartel de carga: revisar de nuevo este test');
});

// ══ 7j · LA LUPA DEL CUADRO (V1074) ══════════════════════════════════════════════════
//
// Pablo, 21/9/2026: «abajo poné una lupa con un campo para buscar… SIEMPRE la búsqueda debe ser
// con CONTIENE porque puedo buscar el nombre del proveedor o cualquier cosa ahí».
//
// Se busca con sgNorm, el único normalizador del panel: sin acentos y con la ñ intacta.

const BUSCA = new Function('PLA', [
  fuente(PANEL, 'function sgNorm(s){'),
  fuente(PANEL, 'function plaBuscaNorm(){'),
  fuente(PANEL, 'function plaCoincide(txt, q){'),
  fuente(PANEL, 'function plaTextoCuenta(c, rubro){'),
  fuente(PANEL, 'function plaTextoAjuste(a, rubro){'),
  fuente(PANEL, 'function plaFiltrar(d, q){'),
  fuente(PANEL, 'function plaBuscaCartel(d, q){'),
  ['return { norm: plaBuscaNorm, coincide: plaCoincide, filtrar: plaFiltrar,',
    '  cartel: plaBuscaCartel, cuenta: plaTextoCuenta };'].join('\n'),
].join('\n'));

const DATOS_B = {
  rubros: RUBROS, meses: ['2026-07', '2026-08'], meses_disponibles: ['2026-07', '2026-08'],
  cuentas: [
    { cuenta: '4.1.01.01.0001', nombre: 'VENTAS COTO CICSA', rubro: 'ventas', meses: { '2026-07': 1000, '2026-08': 1500 } },
    { cuenta: '4.2.04.14.0000', nombre: 'FLETES PEÑA S.A.', rubro: 'costos_fijos', meses: { '2026-07': -300, '2026-08': -200 } },
    { cuenta: '4.2.04.15.0000', nombre: 'COMISIÓN DEL DISTRIBUIDOR', rubro: 'costos_variables', meses: { '2026-08': -120 } },
    { cuenta: '4.2.09.99.0000', nombre: 'GASTOS VARIOS', rubro: 'costos_fijos', meses: { '2026-07': -50 } },
  ],
  ajustes: [
    { id: 7, rubro: 'costos_fijos', nombre: 'Seguro de la flota de PEÑA', meses: { '2026-07': -80 } },
    { id: 8, rubro: 'impuestos', nombre: 'IIBB del trimestre', meses: { '2026-08': -40 } },
  ],
};

test('la lupa busca CONTIENE, sin acentos y con la ñ intacta', () => {
  const B = BUSCA({ busca: '' });
  // CONTIENE, no «empieza con»: el nombre del otro sistema trae el proveedor en el medio.
  assert.ok(B.coincide('VENTAS COTO CICSA', 'coto'));
  assert.ok(B.coincide('VENTAS COTO CICSA', 'cicsa'));
  assert.ok(!B.coincide('VENTAS COTO CICSA', 'carrefour'));
  // Sin acentos: nadie los escribe al buscar.
  assert.ok(B.coincide('COMISIÓN DEL DISTRIBUIDOR', 'comision'));
  // Y al reves, escrito con acento en la lupa: lo que se escribe pasa por el mismo molde antes
  // de comparar, asi que encuentra igual.
  const conAcento = BUSCA({ busca: 'COMISIÓN' });
  assert.deepEqual(conAcento.filtrar(DATOS_B, conAcento.norm()).cuentas.map((x) => x.nombre),
    ['COMISIÓN DEL DISTRIBUIDOR']);
  // PERO LA Ñ SE RESPETA: es una letra del idioma y tiene tecla propia. Si se cayera, «peña»
  // encontraría «pena» y al revés, que es justo el error que la regla del panel no quiere.
  assert.ok(B.coincide('FLETES PEÑA S.A.', 'peña'));
  assert.ok(!B.coincide('FLETES PEÑA S.A.', 'pena'));
  assert.ok(!B.coincide('PENALIDADES', 'peña'));
  // Lo que se escribe en la lupa pasa por el mismo molde, y los espacios de los costados no cuentan.
  assert.equal(BUSCA({ busca: '  PEÑA  ' }).norm(), 'peña');
  assert.equal(BUSCA({ busca: 'Comisión' }).norm(), 'comision');
  assert.equal(BUSCA({ busca: '' }).norm(), '');
});

test('se busca por todo lo que se lee en el renglón, y por el número con y sin puntos', () => {
  const B = BUSCA({ busca: '' });
  const c = DATOS_B.cuentas[1];
  // EL NÚMERO VA DOS VECES: nadie lo escribe igual, y «4.2.04» y «4204» son la misma cuenta.
  assert.ok(B.coincide(B.cuenta(c, 'COSTOS FIJOS'), '4.2.04'));
  assert.ok(B.coincide(B.cuenta(c, 'COSTOS FIJOS'), '42041'));
  // Y el nombre del rubro, para poder pedir el rubro entero.
  assert.ok(B.coincide(B.cuenta(c, 'COSTOS FIJOS'), 'costos fijos'));
  const f = (q) => B.filtrar(DATOS_B, q);
  assert.deepEqual(f('coto').cuentas.map((x) => x.nombre), ['VENTAS COTO CICSA']);
  assert.deepEqual(f('coto').ajustes, []);
  // Un proveedor que está en una cuenta Y en un ajuste manual aparece en los dos lados.
  assert.deepEqual(f('peña').cuentas.map((x) => x.nombre), ['FLETES PEÑA S.A.']);
  assert.deepEqual(f('peña').ajustes.map((x) => x.nombre), ['Seguro de la flota de PEÑA']);
  // Un ajuste se encuentra también por la palabra «ajuste», que es como se ve en el cuadro.
  assert.equal(f('ajuste').ajustes.length, 2);
  // Y el período no se toca: buscar filtra el cuadro, no vuelve a pedir datos.
  assert.deepEqual(f('coto').meses, DATOS_B.meses);
});

test('con la lupa puesta el cuadro muestra lo encontrado, y lo dice: no es el resultado del mes', () => {
  // Sin filtro, el cuadro de siempre: subtotales y RESULTADO NETO.
  const todo = PANTALLA(DATOS_B, {}, 1, false, 'ars', 1180, '');
  assert.match(todo, /RESULTADO NETO/);
  assert.match(todo, /EBITDA/);
  assert.ok(!/TOTAL DE LO ENCONTRADO/.test(todo));
  // Con filtro: sólo los rubros con coincidencias, y ABIERTOS aunque nadie los haya abierto.
  const h = PANTALLA(DATOS_B, {}, 1, false, 'ars', 1180, 'peña');
  assert.match(h, /FLETES PEÑA S\.A\./, 'encontró la cuenta pero no la muestra: el rubro quedó cerrado');
  assert.match(h, /Seguro de la flota de PEÑA/);
  assert.ok(!/GASTOS VARIOS/.test(h), 'muestra cuentas que no coinciden');
  assert.ok(!/COTO/.test(h));
  // NI SUBTOTALES NI RESULTADO NETO: un «EBITDA» de dos renglones sueltos no es un EBITDA, y
  // decirle RESULTADO NETO a la suma de una búsqueda es pedir que alguien lea otra cosa.
  assert.ok(!/EBITDA/.test(h), 'un subtotal de lo filtrado no significa nada');
  assert.ok(!/MARGEN BRUTO/.test(h));
  assert.ok(!/RESULTADO NETO/.test(h));
  assert.match(h, /⭐ TOTAL DE LO ENCONTRADO/);
  // Y los importes son los de lo encontrado: -380 (la cuenta) y -80 (el ajuste) = -460.
  const T = TOTALES(BUSCA({ busca: '' }).filtrar(DATOS_B, 'peña'));
  assert.equal(T.subtotales.neto.TOTAL, -580);
  assert.equal(T.rubros.costos_fijos.TOTAL, -580);
  // EL % SOBRE VENTAS NO SE DIBUJA con el filtro puesto: la base también quedó filtrada, así que
  // seria un porcentaje sobre unas ventas que no son las del período. Se prueba buscando algo que
  // SI deja ventas en pie —si no quedan ventas, el % no se dibuja igual y el test no diría nada—.
  assert.ok(!/pla-pct/.test(h), 'con el filtro puesto el % se calcula sobre unas ventas que no son');
  const soloVentas = PANTALLA(DATOS_B, {}, 1, false, 'ars', 1180, 'coto');
  assert.match(soloVentas, /VENTAS COTO CICSA/);
  assert.ok(!/pla-pct/.test(soloVentas), 'el % del rubro se sigue dibujando sobre la base filtrada');
  assert.match(PANTALLA(DATOS_B, {}, 1, false, 'ars', 1180, ''), /pla-pct/, 'sin filtro el % tiene que estar');
  // Al que puede operar no se le ofrece agregar un ajuste desde una lista filtrada.
  assert.ok(!/Agregar un ajuste manual/.test(PANTALLA(DATOS_B, {}, 1, true, 'ars', 1180, 'peña')));
  assert.match(PANTALLA(DATOS_B, { costos_fijos: true }, 1, true, 'ars', 1180, ''), /Agregar un ajuste manual/);
});

test('la lupa avisa cuántos encontró, y cuando no encuentra nada lo dice en el cuadro', () => {
  const B = BUSCA({ busca: '' });
  assert.equal(B.cartel(DATOS_B, ''), '', 'sin buscar nada no hay nada que aclarar');
  const c1 = B.cartel(B.filtrar(DATOS_B, 'peña'), 'peña');
  assert.match(c1, /<b>1 cuenta y 1 ajuste<\/b>/);
  assert.match(c1, /los importes son los de lo encontrado, no los del período/);
  assert.match(B.cartel(B.filtrar(DATOS_B, 'costos fijos'), 'costos fijos'), /<b>2 cuentas y 1 ajuste<\/b>/);
  assert.match(B.cartel(B.filtrar(DATOS_B, 'coto'), 'coto'), /<b>1 cuenta<\/b>/);
  assert.match(B.cartel(B.filtrar(DATOS_B, 'nada'), 'nada'), /No hay nada que diga eso/);
  // Y en el cuadro, en vez de un total en cero que parece un dato.
  const h = PANTALLA(DATOS_B, {}, 1, false, 'ars', 1180, 'carrefour');
  assert.match(h, /No hay ninguna cuenta ni ajuste que diga «carrefour»/);
  assert.ok(!/TOTAL DE LO ENCONTRADO/.test(h), 'un total de nada se lee como un dato');
});

test('la lupa está pegada al cuadro, y los botones quedaron arriba', () => {
  // Pegada a lo que filtra: puesta arriba, al lado de Desde y Hasta, se leería como si filtrara
  // el período.
  const iBotones = PANEL.indexOf('onclick="plaExportar()"');
  const iLupa = PANEL.indexOf('<div class="pla-busca">');
  const iBarra = PANEL.indexOf('<div class="pla-barra" id="pla-barra-arriba"');
  const iCuadro = PANEL.indexOf('<div class="ab-table-wrap"><table class="pla-tbl" id="pla-tabla">');
  assert.ok(iBotones > 0 && iLupa > iBotones, 'la lupa quedó arriba de los botones');
  assert.ok(iBarra > iLupa && iCuadro > iBarra, 'la lupa no está pegada al cuadro');
  assert.match(PANEL, /<input id="pla-buscar" autocomplete="off" oninput="plaBuscarTeclas\(\)"/);
  assert.match(PANEL, /placeholder="Buscar una cuenta, un ajuste, un proveedor…"/);
  assert.match(PANEL, /<button class="pla-bx" id="pla-buscar-x"/);
  // Se entra sin filtro puesto: si no, la visita siguiente arranca con medio cuadro escondido.
  const init = fuente(PANEL, 'function plaInit(){');
  assert.match(init, /PLA\.busca = '';/);
  assert.match(init, /var eb = eid\('pla-buscar'\); if \(eb\) eb\.value = '';/);
  // Escribir no dibuja en cada tecla: con novecientas cuentas eso se siente.
  const teclas = fuente(PANEL, 'function plaBuscarTeclas(){');
  assert.match(teclas, /clearTimeout\(PLA_BUSCA_TMR\)/);
  assert.match(teclas, /setTimeout\(function\(\)\{ PLA\.busca = v; plaPintar\(\); \}, 150\)/);
  // Y la ✕ deja el cuadro entero y el foco donde estaba.
  const limpiar = fuente(PANEL, 'function plaBuscarLimpiar(){');
  assert.match(limpiar, /PLA\.busca = '';/);
  assert.match(limpiar, /e\.focus\(\)/);
});

test('manual V1074: la lupa, el contenido, y que los importes son los de lo encontrado', () => {
  const M = manual();
  assert.match(M, /<span class="ver">V1074<\/span>/);
  assert.match(M, /<span class="ver">V1074<\/span> Una <b>lupa<\/b> abajo del cuadro para buscar cualquier cosa/,
    'no quedó anotado en «Qué cambió, y desde cuándo»');
  assert.match(M, /La <b>lupa<\/b> de abajo del todo filtra el cuadro/);
  assert.match(M, /alcanza con que <b>lo contenga<\/b>/);
  assert.match(M, /los importes que se ven pasan a ser los de <b>lo encontrado<\/b>/);
  assert.match(M, /el renglón de abajo dice <b>TOTAL DE LO ENCONTRADO<\/b>/);
  // Lo que el manual AFIRMA, contra el código.
  assert.match(fuente(PANEL, 'function plaCoincide(txt, q){'), /sgNorm/);
  assert.match(fuente(PANEL, 'function plaPintar(){'), /q \? '⭐ TOTAL DE LO ENCONTRADO' : '⭐ RESULTADO NETO'/);
});

// ══ 7i · UN AJUSTE PUEDE QUEDAR PENDIENTE (V1070) ═════════════════════════════════════
//
// Pablo, 20/9/2026: «dejame agregar los ajustes manuales con todos los valores en cero, a
// medida que voy consiguiendo la info lo voy agregando, pero es importante que los impute a
// todos ahí para no olvidarme ninguno».
//
// No se guardan ceros —un cero sigue queriendo decir «sacá el importe de ese mes»—: el estado
// PENDIENTE se deriva de no tener ninguna fila de mes. Así no hay columna nueva ni migración, y
// un pendiente se ve en todos los períodos, que es justamente lo que se pidió.

test('un ajuste nace sin importes sólo si se pide, y se ve en cualquier período', () => {
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_A });
  // Sin la bandera, un alta sin importes sigue siendo el error de siempre.
  const sinBandera = llamar(R.ajusteNuevo, { body: { nombre: 'Seguro anual', rubro: 'costos_fijos', meses: {} } });
  assert.equal(sinBandera.code, 400);
  assert.match(sinBandera.body.error, /Cargá el importe de al menos un mes/);
  // Con la bandera, se guarda.
  const alta = llamar(R.ajusteNuevo, { body: { nombre: 'Seguro anual', rubro: 'costos_fijos', meses: {}, pendiente: true } });
  assert.equal(alta.code, 200, JSON.stringify(alta.body));
  // Y vuelve en CUALQUIER período: no tiene mes al que pertenecer.
  for (const [desde, hasta] of [['2025-07', '2025-07'], ['2025-08', '2025-08'], ['2025-07', '2025-09']]) {
    const d = llamar(R.resultado, { query: { desde, hasta } }).body.data;
    const p = (d.ajustes || []).filter((a) => a.nombre === 'Seguro anual')[0];
    assert.ok(p, 'el pendiente no volvió en ' + desde + '..' + hasta);
    assert.equal(p.pendiente, 1);
    assert.deepEqual(p.meses, {});
  }
  // Si vienen importes, la bandera se ignora: gana lo cargado.
  const conPlata = llamar(R.ajusteNuevo, { body: { nombre: 'Con plata', rubro: 'costos_fijos',
    meses: { '2025-08': -500 }, pendiente: true } });
  assert.equal(conPlata.code, 200);
  const d2 = llamar(R.resultado, { query: { desde: '2025-08', hasta: '2025-08' } }).body.data;
  assert.equal((d2.ajustes || []).filter((a) => a.nombre === 'Con plata')[0].pendiente, 0);
});

test('un ajuste con importes fuera del período sigue sin volver: el pendiente no es un colador', () => {
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_A });
  llamar(R.ajusteNuevo, { body: { nombre: 'Sólo en julio', rubro: 'costos_fijos', meses: { '2025-07': -100 } } });
  const d = llamar(R.resultado, { query: { desde: '2025-08', hasta: '2025-08' } }).body.data;
  assert.deepEqual((d.ajustes || []).map((a) => a.nombre), [],
    'con el LEFT JOIN pelado, un ajuste de otro mes vuelve vacío y parece pendiente');
});

test('al pendiente se le puede corregir el nombre, y deja de serlo con el primer importe', () => {
  const db = base();
  const R = rutas(db);
  llamar(R.cargar, { body: CARGA_A });
  const id = llamar(R.ajusteNuevo, { body: { nombre: 'Seguro', rubro: 'costos_fijos', meses: {}, pendiente: true } }).body.data.id;
  // Corregirle el nombre sin cargarle plata: se puede, porque NO tenía importes.
  assert.equal(llamar(R.ajusteCorregir, { params: { id: String(id) },
    body: { nombre: 'Seguro anual de la flota', rubro: 'costos_fijos', meses: {} } }).code, 200);
  // Cargarle el primero lo saca de pendiente.
  assert.equal(llamar(R.ajusteCorregir, { params: { id: String(id) },
    body: { nombre: 'Seguro anual de la flota', rubro: 'costos_fijos', meses: { '2025-08': -750 } } }).code, 200);
  const d = llamar(R.resultado, { query: { desde: '2025-08', hasta: '2025-08' } }).body.data;
  const a = (d.ajustes || []).filter((x) => x.id === id)[0];
  assert.equal(a.pendiente, 0);
  assert.deepEqual(a.meses, { '2025-08': -750 });
  // Y VACIAR uno que YA tenía importes sigue sin ser la manera de sacarlo.
  const vaciar = llamar(R.ajusteCorregir, { params: { id: String(id) },
    body: { nombre: 'Seguro anual de la flota', rubro: 'costos_fijos', meses: { '2025-08': null } } });
  assert.equal(vaciar.code, 400);
  assert.match(vaciar.body.error, /para sacarlo, eliminalo/);
});

const PEND = { id: 9, rubro: 'costos_fijos', nombre: 'Seguro anual', meses: {}, pendiente: 1 };

test('un pendiente no mueve ni un peso del resultado', () => {
  const conPend = TOTALES(Object.assign({}, DATOS, { ajustes: AJUSTES.concat([PEND]) }));
  const sinPend = TOTALES(Object.assign({}, DATOS, { ajustes: AJUSTES }));
  assert.deepEqual(conPend.rubros.costos_fijos, sinPend.rubros.costos_fijos);
  assert.deepEqual(conPend.subtotales.neto, sinPend.subtotales.neto);
});

test('el pendiente se ve en su rubro, con su propio renglón y sin una fila de guiones', () => {
  const datos = Object.assign({}, DATOS, { ajustes: [PEND] });
  const h = PANTALLA(datos, { costos_fijos: true });
  // El rubro se dibuja aunque su único contenido sea un pendiente, y avisa cuántos tiene.
  assert.match(h, /<tr class="pla-rub"><td title="Tiene 1 ajuste manual sin importe todavía"[^>]*>▼ 🏢 COSTOS FIJOS ⏳1<\/td>/);
  // Y el pendiente va en un renglón propio, que es además su única puerta de vuelta.
  assert.match(h, /<tr class="pla-aju-pend" onclick="plaAjusteAbrir\(9\)"><td colspan="4" title="Clic: cargarle el importe">⏳ Seguro anual — falta cargar el importe: todavía no suma al resultado<\/td><\/tr>/);
  // Nada de «✎ Ajuste: … — — —»: eso se lee como un dato roto, no como algo que falta.
  assert.ok(!h.includes('✎ Ajuste: Seguro anual'), 'el pendiente salió como una fila de guiones');
  // El fondo ambar es lo que lo hace leer como algo que falta, y la regla de las celdas pegadas
  // lo pisaba: medido en Chrome daba blanco.
  assert.match(PANEL, /#pla-pane-resultado \.pla-tbl \.pla-aju-pend td\{background:#fffbeb\}/);
});

test('el aviso de arriba cuenta los ajustes que esperan su importe', () => {
  const aviso = (d) => {
    const caja = { innerHTML: '' };
    new Function('eid', 'escH', 'plaFechaTxt', 'lnbPuedeOperar', [
      fuente(PANEL, 'function plaAviso(d){'), 'plaAviso(' + JSON.stringify(d) + ');',
    ].join('\n'))(() => caja, (x) => String(x), (f) => String(f), () => true);
    return caja.innerHTML;
  };
  const base = { ultima_carga: { archivo: 'diario.xls', desde: '2026-07-01', hasta: '2026-09-14', creado_en: '2026-09-18 09:36' }, cuentas: [] };
  const con = aviso(Object.assign({}, base, { ajustes: [PEND, { id: 10, pendiente: 1 }, { id: 11, meses: { '2025-08': -5 } }] }));
  assert.match(con, /⏳ 2 ajustes manuales todavía sin importe: no suman al resultado hasta que se les cargue\./);
  assert.match(con, /<span style="color:#92400e">⏳ 2/, 'el aviso tiene que ir con el color de los otros avisos');
  const uno = aviso(Object.assign({}, base, { ajustes: [PEND] }));
  assert.match(uno, /⏳ 1 ajuste manual todavía sin importe/);
  assert.ok(!aviso(Object.assign({}, base, { ajustes: [] })).includes('⏳'), 'sin pendientes no se avisa nada');
});

test('el CSV lleva los pendientes con su tipo y en cero', () => {
  const csv = new Function('PLA', [
    /^var PLA_MES = .*;\r?$/m.exec(PANEL)[0],
    hasta(PANEL, 'var PLA_SUBTOTALES = [', '];'),
    fuente(PANEL, 'function plaMesTxt(m){'),
    fuente(PANEL, 'function plaTotales(d){'),
    fuente(PANEL, 'function plaCsv(d, usd){'),
    'return plaCsv;'].join('\n'))({ unidad: 1e6 });
  const filas = csv(Object.assign({}, DATOS, { ajustes: [PEND] })).slice(1).split('\r\n');
  const pend = filas.filter((f) => f.indexOf('Ajuste pendiente') === 0);
  assert.deepEqual(pend, ['Ajuste pendiente;Seguro anual;;0,00;0,00;0,00'],
    'el pendiente no salió al Excel, o salió con otro número');
});

test('la ventana avisa que va a quedar pendiente antes de guardar', () => {
  const total = fuente(PANEL, 'function plaAjusteTotal(){');
  assert.match(total, /var vacio = !Object\.keys\(L\.meses\)\.some\(function\(m\)\{ return L\.meses\[m\] != null; \}\);/);
  // El cartel tiene que decir QUE va a pasar: donde queda anotado y que no suma. En el fuente
  // la frase viaja partida en dos strings, asi que se clava en dos.
  assert.match(total, /queda <b>pendiente<\/b>/);
  assert.match(total, /anotado en su rubro para no olvidarlo\. No suma al resultado/);
  assert.match(total, /btn\.textContent = 'Guardar como pendiente'/);
  // Y al guardar se pide explícitamente: sin la bandera, el servidor lo rechaza.
  const guardar = fuente(PANEL, 'function plaAjusteGuardar(){');
  assert.match(guardar, /var pendiente = !Object\.keys\(L\.meses\)\.some\(function\(m\)\{ return L\.meses\[m\] != null; \}\);/);
  assert.match(guardar, /meses: L\.meses, pendiente: pendiente/);
  assert.match(guardar, /'Ajuste anotado como pendiente'/);
});

test('manual V1070: el ajuste pendiente, y lo que sigue valiendo', () => {
  const M = manual();
  assert.match(M, /Un ajuste puede <b>nacer sin importes<\/b>, como recordatorio de algo que todavía no se sabe cuánto es/);
  assert.match(M, /Aparece dentro de su rubro con un <b>⏳<\/b> diciendo que falta cargarlo/);
  assert.match(M, /sale al CSV como <b>Ajuste pendiente<\/b>/);
  assert.match(M, /Un pendiente se ve en <b>todos los períodos<\/b>/);
  // La mitad que NO cambió: vaciar no es la manera de sacarlo.
  assert.match(M, /<b>Vaciar<\/b> un ajuste que ya tenía importes <b>no<\/b> es la manera de sacarlo/);
  assert.ok(!/Un ajuste no puede quedar sin importes/.test(M), 'el manual sigue diciendo lo contrario');
  assert.match(M, /<span class="ver">V1070<\/span> Un ajuste manual puede quedar pendiente/);
});
