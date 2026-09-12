// ══ LA CARGA DE SALIDA, CON SU PROPIO ASIENTO MODELO (V1051) ══════════════════
//
// Pablo, 12/9/2026: «separalos, permitime hacer asientos modelos distintos».
//
// La cooperativa factura en un mismo papel lo que descargó y lo que cargó. La descarga
// es costo de la mercadería y la carga es costo de la venta: con un solo modelo iban a
// la misma cuenta. La factura sigue siendo una; su asiento lleva cada parte contra su
// modelo, con el IVA y la deuda con la cooperativa en una sola línea.
//
// Los tests arman el asiento con las funciones REALES del router sobre una base en
// memoria con los dos modelos parametrizados, y corren las rutas reales del modelo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const SG = leer('src/rutas/sg.js');
const CONT = leer('src/rutas/sg_contable.js');
const PANEL = leer('src/panel.html');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
function pedazo(txt, desde, hasta) {
  const i = txt.indexOf(desde);
  assert.ok(i >= 0, 'no está: ' + desde.slice(0, 70));
  const j = txt.indexOf(hasta, i);
  assert.ok(j > i, 'no cierra: ' + desde.slice(0, 70));
  return txt.slice(i, j + hasta.length);
}
function ruta(firma) {
  const i = SG.indexOf(firma);
  assert.ok(i > 0, 'no está la ruta: ' + firma);
  const j = SG.indexOf('(req, res) => {', i);
  return SG.slice(j, SG.indexOf('\r\n});', j) + 3);
}

const API = new Function([
  'const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;',
  "const CLAVE_MODELO_GASTO = 'asiento_modelo_descarga';",
  "const CLAVE_MODELO_FLETE = 'asiento_modelo_flete';",
  "const CLAVE_MODELO_FLETE_SALIDA = 'asiento_modelo_flete_salida';",
  "const CLAVE_MODELO_CARGA = 'asiento_modelo_carga_salida';",
  pedazo(SG, 'function queLeFaltaAlModelo(', '\r\n}'),
  pedazo(SG, 'function armarAsientoFactura(', '\r\n}'),
  pedazo(SG, 'function lineasModeloDe(db, CLAVE) {', '\r\n}'),
  pedazo(SG, 'function lineasGestionFactura(', '\r\n}'),
  pedazo(SG, 'function montosDeFlete(', '\r\n}'),
  pedazo(SG, 'function montosDeFacturaGasto(', '\r\n}'),
  pedazo(SG, 'function difDeFacturaGasto(', '\r\n}'),
  pedazo(SG, 'function asientoDeFacturaGasto(', '\r\n}'),
  pedazo(SG, 'function asientoCompuestoDeFacturaGasto(', '\r\n}'),
  pedazo(SG, 'function gruposDeFacturaGasto(', '\r\n}'),
  pedazo(SG, 'const ETIQUETA_TIPO_GASTO = ', ';'),
  pedazo(SG, 'function etiquetaDeFacturaGasto(', '\r\n}'),
  pedazo(SG, 'function operacionesValorizadas(', '\r\n}'),
  pedazo(SG, 'const CIRCUITOS_FACTURA = {', '\r\n};'),
  pedazo(SG, 'function circuitoFactura(v) {', '\r\n}'),
  'return { queLeFaltaAlModelo, lineasModeloDe, asientoDeFacturaGasto, gruposDeFacturaGasto,',
  '  etiquetaDeFacturaGasto, operacionesValorizadas, circuitoFactura };',
].join('\n'))();

// ── la base: la cuenta de la descarga, la de la carga, la cooperativa y el IVA ─────
function base({ descarga = true, carga = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_config (clave TEXT PRIMARY KEY, valor TEXT);
    CREATE TABLE sg_cuentas (id INTEGER PRIMARY KEY, codigo TEXT, nombre TEXT);
    CREATE TABLE sg_asientos_modelo (id INTEGER PRIMARY KEY, nombre TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_asientos_modelo_lineas (id INTEGER PRIMARY KEY, modelo_id INTEGER, cuenta_id INTEGER,
      lado TEXT, descripcion TEXT, orden INTEGER, tipo_linea TEXT, jurisdiccion TEXT);
    CREATE TABLE sg_config_impositiva (clave TEXT, cuenta_id INTEGER);
    INSERT INTO sg_cuentas VALUES (10, '5.01.03.0001', 'Servicios de descarga'), (11, '5.02.01.0004', 'Cargas de salida'),
                                  (20, '2.01.01.0001', 'Proveedores'), (30, '1.01.05.0001', 'IVA Crédito Fiscal');
    INSERT INTO sg_asientos_modelo VALUES (1, 'Descarga', 1), (2, 'Carga de salida', 1);
    INSERT INTO sg_asientos_modelo_lineas (modelo_id, cuenta_id, lado, descripcion, orden, tipo_linea) VALUES
      (1, 10, 'debe', 'Descarga', 1, 'libre'), (1, 20, 'haber', 'Cooperativa', 2, 'proveedores'),
      (2, 11, 'debe', 'Carga', 1, 'libre'),    (2, 20, 'haber', 'Cooperativa', 2, 'proveedores');
    INSERT INTO sg_config_impositiva VALUES ('iva_credito_fiscal', 30);
  `);
  if (descarga) db.exec("INSERT INTO sg_config VALUES ('asiento_modelo_descarga', '1')");
  if (carga) db.exec("INSERT INTO sg_config VALUES ('asiento_modelo_carga_salida', '2')");
  return db;
}
const DESCARGA = API.circuitoFactura('descarga');
const ops = (desc, carga) => [
  ...(desc ? [{ id: 1, monto: desc, tipo_gasto: 'descarga_ingreso' }] : []),
  ...(carga ? [{ id: 2, monto: carga, tipo_gasto: 'carga_salida' }] : []),
];
const asiento = (db, operaciones, b) => {
  const grupos = API.gruposDeFacturaGasto(db, DESCARGA, operaciones);
  const valorizado = r2(operaciones.reduce((a, o) => a + o.monto, 0));
  return API.asientoDeFacturaGasto(db, Object.assign({ iva_alicuota: 21 }, b), valorizado, DESCARGA.clave, grupos);
};
const de = (as, cuenta, ambito = 'fiscal') => as.lineas.filter((l) => l.cuenta_id === cuenta && l.ambito === ambito);
const suma = (ls, lado) => r2(ls.reduce((a, l) => a + (l[lado] || 0), 0));

// ══ 1 · EL ASIENTO ════════════════════════════════════════════════════════════

test('cada parte va contra la cuenta de su modelo, con el IVA y la deuda en una sola línea', () => {
  const as = asiento(base(), ops(600, 400), { total: 1210 });
  assert.equal(suma(de(as, 10), 'debe'), 600, 'la descarga no fue a su cuenta');
  assert.equal(suma(de(as, 11), 'debe'), 400, 'la carga no fue a la cuenta de su modelo');
  assert.equal(de(as, 30).length, 1, 'el IVA quedó partido en dos líneas');
  assert.equal(suma(de(as, 30), 'debe'), 210);
  assert.equal(de(as, 20).length, 1, 'la deuda con la cooperativa quedó partida en dos líneas');
  assert.equal(suma(de(as, 20), 'haber'), 1210);
  assert.equal(as.balancea, true);
  assert.deepEqual(as.partes.map((p) => p.clave), ['asiento_modelo_descarga', 'asiento_modelo_carga_salida']);
});

test('con diferencia contra lo valorizado, cada parte lleva la suya y suman la de la factura', () => {
  // Valorizado 700 + 400 = 1.100; la factura dice 1.000 de neto.
  const as = asiento(base(), ops(700, 400), { total: 1210, dif_motivo: 'comprobante_pendiente' });
  assert.equal(suma(de(as, 10), 'debe'), 636.36);
  assert.equal(suma(de(as, 11), 'debe'), 363.64);
  assert.equal(suma(de(as, 10, 'gestion'), 'debe'), 63.64);
  assert.equal(suma(de(as, 11, 'gestion'), 'debe'), 36.36);
  assert.equal(de(as, 20, 'gestion').length, 1);
  assert.equal(suma(de(as, 20, 'gestion'), 'haber'), 100);
  assert.equal(as.dif_gestion, 100);
  assert.equal(as.totales.fiscal.balancea, true);
  assert.equal(as.totales.gestion.balancea, true);
});

test('un papel que no cierra con su neto y su IVA tampoco balancea repartido', () => {
  const as = asiento(base(), ops(600, 400), { total: 1300, neto: 1000, iva_monto: 210 });
  assert.equal(suma(de(as, 20), 'haber'), 1300, 'la deuda no es la del papel');
  assert.equal(as.balancea, false, 'el reparto tapó que el papel no cierra');
});

test('sin modelo propio elegido, la carga va con el de la descarga, como hasta la V1050', () => {
  const as = asiento(base({ carga: false }), ops(600, 400), { total: 1210 });
  assert.equal(suma(de(as, 10), 'debe'), 1000);
  assert.equal(de(as, 11).length, 0);
  assert.equal(as.balancea, true);
});

test('una factura sólo de cargas va entera contra el modelo de la carga', () => {
  const as = asiento(base(), ops(0, 400), { total: 484 });
  assert.equal(suma(de(as, 11), 'debe'), 400);
  assert.equal(de(as, 10).length, 0);
});

test('si falta el modelo de la descarga, la factura mezclada queda sin asiento, igual que con uno solo', () => {
  assert.equal(asiento(base({ descarga: false }), ops(600, 400), { total: 1210 }).sin_modelo, true);
});

test('las partes suman exacto lo valorizado, aunque un importe tenga más de dos decimales', () => {
  const db = base();
  const operaciones = [{ id: 1, monto: 456.765, tipo_gasto: 'descarga_ingreso' },
                       { id: 2, monto: 100.005, tipo_gasto: 'carga_salida' }];
  const grupos = API.gruposDeFacturaGasto(db, DESCARGA, operaciones);
  assert.equal(r2(grupos.reduce((a, g) => a + g.valorizado, 0)), r2(456.765 + 100.005));
  // La factura coincide con lo valorizado: no hay diferencia que inventar.
  const as = asiento(db, operaciones, { total: 673.69 });
  assert.equal(as.lineas.filter((l) => l.ambito === 'gestion').length, 0, 'inventó una diferencia de gestión de un centavo');
  assert.equal(as.balancea, true);
});

// ══ 2 · DE DÓNDE SALEN LAS PARTES ══════════════════════════════════════════════

test('el circuito de la descarga sabe qué tipo tiene modelo propio', () => {
  assert.deepEqual(DESCARGA.tipos, ['descarga_ingreso', 'carga_salida']);
  assert.deepEqual(DESCARGA.claves, { carga_salida: 'asiento_modelo_carga_salida' });
  assert.equal(API.circuitoFactura('flete_salida').claves, undefined);
});

test('las operaciones y su tipo se leen de la base, con los filtros de la suma', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sg_gastos_directos (id INTEGER PRIMARY KEY, monto REAL, tipo_gasto TEXT,
             proveedor_servicio_id INTEGER, estado TEXT, activo INTEGER);
           INSERT INTO sg_gastos_directos VALUES (1, 600, 'descarga_ingreso', 5, 'valorizado', 1),
             (2, 400, 'carga_salida', 5, 'valorizado', 1), (3, 99, 'carga_salida', 6, 'valorizado', 1),
             (4, 77, 'carga_salida', 5, 'pendiente_valorizar', 1), (5, 55, 'flete_salida', 5, 'valorizado', 1);`);
  const r = API.operacionesValorizadas(db, [1, 2, 3, 4, 5], 5, DESCARGA.tipos);
  assert.deepEqual(r.map((x) => [x.id, x.tipo_gasto]), [[1, 'descarga_ingreso'], [2, 'carga_salida']]);
});

test('la preview y el alta arman el asiento con esas partes, y el mayor dice qué se facturó', () => {
  const pv = ruta("router.post('/gastos-factura/asiento-preview'");
  assert.match(pv, /const grupos = gruposDeFacturaGasto\(db, c,\r?\n\s+operacionesValorizadas\(db, ids, Number\(b\.proveedor_servicio_id\), c\.tipos\)\);/);
  assert.match(pv, /asientoDeFacturaGasto\(db, b, valorizado, c\.clave, grupos\),\r?\n\s+\{ valorizado, modelos: grupos\.map\(\(g\) => g\.clave\) \}/);
  const alta = pedazo(SG, "router.post('/gastos-factura', ", '\r\n});');
  assert.match(alta, /END AS asiento_id, g\.tipo_gasto/);
  assert.match(alta, /gruposDeFacturaGasto\(db, c, elegidos\)\);/);
  assert.match(alta, /descripcion: 'Factura de ' \+ etiquetaDeFacturaGasto\(c, elegidos\) \+ ' ' \+ numero,/);
  assert.equal(API.etiquetaDeFacturaGasto(DESCARGA, ops(600, 400)), 'descarga y carga de salida');
  assert.equal(API.etiquetaDeFacturaGasto(DESCARGA, ops(0, 400)), 'carga de salida');
  assert.equal(API.etiquetaDeFacturaGasto(API.circuitoFactura('flete_salida'), [{ tipo_gasto: 'flete_salida' }]), 'flete de salida');
});

// ══ 3 · DÓNDE SE ELIGE ═════════════════════════════════════════════════════════

test('el modelo de la carga se guarda en su propia clave, y la pantalla lo lee de ahí', () => {
  const db = base({ carga: false });
  const correr = (firma, req) => {
    const h = new Function('getDb', 'lineasModeloDe', 'queLeFaltaAlModelo', 'CLAVE_MODELO_CARGA', 'return ' + ruta(firma))(
      () => db, API.lineasModeloDe, API.queLeFaltaAlModelo, 'asiento_modelo_carga_salida');
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
    h(req, res);
    return res;
  };
  assert.equal(correr("router.get('/gastos-factura/modelo-carga'", {}).body.data.modelo, null);
  assert.equal(correr("router.put('/gastos-factura/modelo-carga'", { body: { modelo_id: 2 } }).code, 200);
  assert.equal(db.prepare("SELECT valor FROM sg_config WHERE clave = 'asiento_modelo_carga_salida'").get().valor, '2');
  assert.equal(db.prepare("SELECT valor FROM sg_config WHERE clave = 'asiento_modelo_descarga'").get().valor, '1',
    'elegir el de la carga pisó el de la descarga');
  const d = correr("router.get('/gastos-factura/modelo-carga'", {}).body.data;
  assert.equal(d.modelo.nombre, 'Carga de salida');
  assert.deepEqual(d.faltan, []);
  // Elegirlo es parametrizar: sólo el administrador.
  assert.match(SG, /router\.put\('\/gastos-factura\/modelo-carga', requireAdmin,/);
});

test('dejar la carga sin modelo avisa que va con el de la descarga, no que no asienta', () => {
  const sel = new Function('SGCTCIRC', 'sgctEsc', pedazo(PANEL, 'function sgctCircSelect(c) {', '\r\n}')
    + '\nreturn sgctCircSelect;')({ modelos: [{ id: 2, nombre: 'Carga de salida' }] }, (x) => String(x));
  assert.match(sel({ clave: 'asiento_modelo_carga_salida', modelo_id: null }), /— Sin elegir: va con el de la descarga —/);
  assert.match(sel({ clave: 'asiento_modelo_descarga', modelo_id: null }), /— Sin elegir: no genera asiento —/);
  assert.match(pedazo(PANEL, 'function sgctCircGuardar(clave, sel) {', '\r\n}'),
    /clave === 'asiento_modelo_carga_salida' \? 'Sin modelo propio: las cargas van con el de la descarga'/);
  assert.match(pedazo(PANEL, 'function sgModeloGuardar(k){', '\r\n}'),
    /k === 'carga' \? 'Sin modelo propio: las cargas van con el de la descarga'/);
});

test('Contabilidad SG tiene el circuito «Carga de salida»', () => {
  const lista = pedazo(CONT, 'const CIRCUITOS = [', '];');
  assert.match(lista, /\{ clave: 'asiento_modelo_carga_salida', label: 'Carga de salida',/);
  assert.match(lista, /Es costo de la venta\. Mientras no se elija, va con el modelo de la descarga\./);
});

test('Control Cooperativa tiene su botón y su aviso, que dice que va con el de la descarga', () => {
  const SGM = new Function(pedazo(PANEL, 'var SG_MODELOS = {', '\r\n};') + '\r\nreturn SG_MODELOS;')();
  assert.equal(SGM.carga.ruta, '/api/sg/gastos-factura/modelo-carga');
  assert.equal(SGM.carga.btn, 'sgcarga-modelo-btn');
  assert.equal(SGM.carga.av, 'sgcarga-modelo-falta');
  assert.ok(!SGM.carga.facturaTit, 'la carga no tiene ventana propia: se factura con la descarga');
  assert.match(PANEL, /id="sgcarga-modelo-btn" style="display:none"\r?\n\s+onclick="sgModeloAbrir\('carga'\)"/);
  assert.match(PANEL, /id="sgcarga-modelo-falta" style="display:none/);
  assert.match(pedazo(PANEL, 'function sgAsientoModeloVisible(){', '\r\n}'), /'sgcarga-modelo-btn'/);
  const i = PANEL.indexOf('function sgCcoopInit(){');
  assert.match(PANEL.slice(i, i + 500), /sgModeloCargar\('carga'\)/);

  // El aviso, corrido: sin modelo propio NO dice que no se contabiliza.
  const els = { 'sgcarga-modelo-btn': { style: {}, textContent: '', title: '' },
                'sgcarga-modelo-falta': { style: {}, innerHTML: '' } };
  new Function('SG_MODELOS', 'SG_MODELO_EST', 'eid', 'sgAsientoEsAdmin', 'escH',
    pedazo(PANEL, 'function sgModeloEstado(k){', '\r\n}') + '\nsgModeloEstado("carga");')(
    SGM, { carga: { modelo: null, modelos: [] } }, (id) => els[id], () => true, (x) => String(x));
  assert.equal(els['sgcarga-modelo-btn'].textContent, '⚠️ Asiento modelo de cargas');
  assert.match(els['sgcarga-modelo-falta'].innerHTML, /se están contabilizando con el asiento modelo de la descarga/);
  assert.ok(!/no se están contabilizando/.test(els['sgcarga-modelo-falta'].innerHTML));
  assert.equal(els['sgcarga-modelo-falta'].style.display, '');
  // Si la descarga TAMPOCO tiene modelo, no va con nada: el aviso no puede decir que sí.
  const estado = (k, est) => {
    const e = { [SGM[k].btn]: { style: {}, textContent: '', title: '' }, [SGM[k].av]: { style: {}, innerHTML: '' } };
    new Function('SG_MODELOS', 'SG_MODELO_EST', 'eid', 'sgAsientoEsAdmin', 'escH',
      pedazo(PANEL, 'function sgModeloEstado(k){', '\r\n}') + '\nsgModeloEstado(' + JSON.stringify(k) + ');')(
      SGM, est, (id) => e[id], () => true, (x) => String(x));
    return e[SGM[k].av].innerHTML;
  };
  assert.match(estado('carga', { carga: { modelo: null }, descarga: { modelo: null } }),
    /Las cargas de salida no se están contabilizando:<\/b> no tienen asiento modelo propio y la descarga tampoco/);
  assert.match(estado('descarga', { descarga: { modelo: null } }),
    /Una factura de la cooperativa con descargas queda entera sin asiento, también su parte de cargas/);
  // Las dos respuestas llegan por separado: cuando llega la de la descarga, se rehace el de la carga.
  assert.match(pedazo(PANEL, 'function sgModeloCargar(k){', '\r\n}'),
    /if \(k === 'descarga' && SG_MODELO_EST\.carga !== undefined\) sgModeloEstado\('carga'\);/);
  assert.match(pedazo(PANEL, 'function sgModeloPintar(k){', '\r\n}'),
    /k === 'carga' && \(!SG_MODELO_EST\.descarga \|\| SG_MODELO_EST\.descarga\.modelo\)\r?\n\s+\? 'mientras tanto van con el modelo de la descarga\.'/);
  // Y el cuadro del asiento de la factura nombra los dos modelos.
  const fa = pedazo(PANEL, 'function sgFgAsiento(){', '\r\n}');
  assert.match(fa, /usados\.length > 1 \? 'el asiento modelo de las descargas y el de las cargas de salida'/);
  assert.match(fa, /usados\[0\] === 'asiento_modelo_carga_salida' \? 'el asiento modelo de las cargas de salida'/);
});

// ══ 4 · LOS «¿CÓMO SE USA?» ════════════════════════════════════════════════

const manual = (clave) => {
  const i = PANEL.indexOf('SG_MANUAL.' + clave + ' = {');
  assert.ok(i > 0, 'no está el manual de ' + clave);
  return PANEL.slice(i, PANEL.indexOf('\r\n};', i)).replace(/'\r?\n\s*\+ '/g, '');
};

test('manuales: la carga tiene su propio asiento modelo, y se sigue facturando con la descarga', () => {
  const G = manual('gastos');
  assert.match(G, /<span class="ver">V1051<\/span> Tiene su <b>propio asiento modelo<\/b>, aparte del de la descarga: la carga es costo de la venta y la descarga es costo de la mercadería/);
  assert.match(G, /Se sigue facturando <b>junto con la descarga<\/b>, en la misma factura: la parte de las cargas va contra su modelo y la de las descargas contra el suyo, con el IVA y la deuda con la cooperativa en el mismo asiento/);
  assert.match(G, /Mientras no se elija, va con el de la descarga, como hasta la V1050/);
  assert.match(G, /Al lado está <b>⚙️ Asiento modelo de cargas<\/b>, para las cargas de salida/);
  const M = manual('modelos');
  assert.match(M, /<span class="ver">V1051<\/span> <b>Carga de salida<\/b> — la parte de esa misma factura que cargó el camión que sale al cliente/);
  assert.match(M, /Al lado está el de <b>Carga de salida<\/b>, con su propio botón: <b>⚙️ Asiento modelo de cargas<\/b>/);
  const actual = Number((leer('src/sidebar-v2.js').match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const k of ['gastos', 'modelos']) {
    for (const v of (manual(k).match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
      assert.ok(v <= actual, `el manual de ${k} cita la V${v} y el panel va en la V${actual}`);
    }
  }
});
