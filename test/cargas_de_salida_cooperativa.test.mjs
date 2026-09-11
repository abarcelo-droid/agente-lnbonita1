// ══ LAS CARGAS DE SALIDA DE LA COOPERATIVA SE VALORIZAN (V1047) ════════════
//
// Pablo, 11/9/2026: «punto 2 OK avanzar». Un remito con cooperativa de carga dejaba
// anotados los bultos que se le pagan a la cuadrilla, y no había ninguna pantalla
// donde ponerles el importe: la carga no llegaba nunca a la factura de la
// cooperativa, ni a su cuenta corriente, ni al margen del remito. Control
// Cooperativa sólo miraba recepciones, y la vieja solapa «Cargas y Descargas» se
// había ido dejando su código huérfano.
//
// Estos tests corren la ruta REAL sobre una base en memoria, y la tabla y el botón
// REALES de la pantalla.
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
const PANEL = leer('src/panel.html');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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
function ruta(firma) {
  const i = SG.indexOf(firma);
  assert.ok(i > 0, 'no está la ruta: ' + firma);
  const j = SG.indexOf('(req, res) => {', i);
  return SG.slice(j, SG.indexOf('\r\n});', j) + 3);
}
const SQL_F = SG.match(/const SQL_GASTO_FACTURADO = `([\s\S]*?)`;/)[1];

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_recepciones (id INTEGER PRIMARY KEY, numero_recepcion TEXT, fecha_recepcion TEXT,
      creado_en TEXT, bultos_recibidos INTEGER, pallets_recibidos INTEGER, con_descarga INTEGER,
      oc_id INTEGER, creado_por INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, trazabilidad TEXT, proveedor_id INTEGER);
    CREATE TABLE sg_proveedores (id INTEGER PRIMARY KEY, razon_social TEXT);
    CREATE TABLE usuarios (id INTEGER PRIMARY KEY, nombre TEXT);
    CREATE TABLE sg_gastos_directos (id INTEGER PRIMARY KEY, tipo_gasto TEXT, recepcion_id INTEGER,
      despacho_id INTEGER, proveedor_servicio_id INTEGER, cooperativa_id INTEGER, unidad TEXT,
      cantidad REAL, estado TEXT, monto REAL, fecha_servicio TEXT, fecha_valorizacion TEXT,
      cuenta_ref TEXT, valorizado_por INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, numero TEXT, fecha_despacho TEXT,
      cliente_id INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_clientes (id INTEGER PRIMARY KEY, razon_social TEXT);
    CREATE TABLE sg_cooperativas (id INTEGER PRIMARY KEY, nombre TEXT, proveedor_id INTEGER);
    CREATE TABLE sg_facturas_gasto (id INTEGER PRIMARY KEY, numero TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_factura_gasto_items (id INTEGER PRIMARY KEY, factura_id INTEGER, gasto_id INTEGER);
    INSERT INTO sg_proveedores VALUES (30, 'COOP LA UNION LTDA'), (31, 'COOP OTRA LTDA');
    INSERT INTO sg_cooperativas VALUES (5, 'Cuadrilla Norte', 30), (6, 'Cuadrilla Sur', 31);
    INSERT INTO sg_clientes VALUES (1, 'COTO CICSA');
    INSERT INTO sg_despachos VALUES (10, 'SG-DESP-10', '2026-09-10', 1, 1),
                                    (11, 'SG-DESP-11', '2026-08-01', 1, 1),
                                    (12, 'SG-DESP-12', '2026-09-11', 1, 0),
                                    (13, 'SG-DESP-13', '2026-07-15', 1, 1);
    INSERT INTO sg_gastos_directos (id, tipo_gasto, despacho_id, proveedor_servicio_id, cooperativa_id,
        unidad, cantidad, estado, monto, fecha_servicio) VALUES
      (1, 'carga_salida', 10, 30, 5, 'bulto', 150, 'pendiente_valorizar', NULL, '2026-09-10'),
      (2, 'carga_salida', 11, 31, 6, 'bulto', 40, 'valorizado', 8000, '2026-08-01'),
      (3, 'carga_salida', 12, 30, 5, 'bulto', 20, 'valorizado', 1000, '2026-09-11'),
      (4, 'carga_salida', 10, 30, 5, 'bulto', 99, 'anulado', NULL, '2026-09-10'),
      (5, 'flete_salida', 10, 30, NULL, NULL, NULL, 'pendiente_valorizar', NULL, '2026-09-10'),
      -- Una carga a valorizar de un remito de julio: fuera de cualquier período reciente.
      (6, 'carga_salida', 13, 31, 6, 'bulto', 30, 'pendiente_valorizar', NULL, '2026-07-15');
  `);
  return db;
}
function controlCoop(db, query = {}) {
  const h = new Function('getDb', 'SQL_GASTO_FACTURADO', 'r2', 'return ' + ruta("router.get('/control-coop'"))(
    () => db, SQL_F, r2);
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  h({ query }, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  return res.body.data;
}
const ids = (d) => d.cargas.map((c) => c.gasto_id);

// ══ 1 · LA RUTA, CORRIDA ═══════════════════════════════════════════════════

test('Control Cooperativa trae las cargas de salida, sin las anuladas ni los fletes', () => {
  const d = controlCoop(base());
  assert.deepEqual(ids(d), [3, 1, 2, 6], 'no son las cargas vivas, de la más nueva a la más vieja');
  const c1 = d.cargas.find((c) => c.gasto_id === 1);
  assert.equal(c1.numero_remito, 'SG-DESP-10');
  assert.equal(c1.cliente_nombre, 'COTO CICSA');
  assert.equal(c1.cooperativa_nombre, 'Cuadrilla Norte', 'el nombre es el de la cuadrilla, no el de su proveedor');
  assert.equal(c1.cooperativa_id, 30, 'se valoriza contra el PROVEEDOR al que se le paga');
  assert.equal(c1.proveedor_servicio_nombre, 'COOP LA UNION LTDA');
  assert.equal(c1.cantidad, 150);
  assert.equal(d.cargas.find((c) => c.gasto_id === 3).remito_activo, 0);
  assert.deepEqual(d.totales_cargas, { cargas: 4, bultos: 240, pendientes: 2, monto: 9000 });
  // Y las descargas siguen donde estaban.
  assert.ok(Array.isArray(d.filas));
});

test('los mismos filtros de fecha, cooperativa y estado valen para las cargas', () => {
  const db = base();
  // «Desde» no esconde lo que falta valorizar: la de julio aparece igual.
  assert.deepEqual(ids(controlCoop(db, { desde: '2026-09-01' })), [3, 1, 6]);
  assert.deepEqual(ids(controlCoop(db, { desde: '2026-09-01', estado: 'valorizado' })), [3]);
  assert.deepEqual(ids(controlCoop(db, { hasta: '2026-08-31' })), [2, 6]);
  assert.deepEqual(ids(controlCoop(db, { cooperativa_id: '31' })), [2, 6]);
  assert.deepEqual(ids(controlCoop(db, { estado: 'pendiente_valorizar' })), [1, 6]);
  assert.deepEqual(ids(controlCoop(db, { estado: 'valorizado' })), [3, 2]);
  assert.deepEqual(ids(controlCoop(db, { estado: 'sin_coop' })), [], 'una carga siempre tiene cooperativa');
});

test('la carga ya facturada lo dice; con la factura anulada, no', () => {
  const db = base();
  db.exec("INSERT INTO sg_facturas_gasto VALUES (9, 'F-9', 1), (10, 'F-10', 0);"
    + 'INSERT INTO sg_factura_gasto_items VALUES (1, 9, 2), (2, 10, 3);');
  const d = controlCoop(db);
  assert.equal(d.cargas.find((c) => c.gasto_id === 2).facturada, 1);
  assert.equal(d.cargas.find((c) => c.gasto_id === 3).facturada, 0);
});

// ══ 2 · LA PANTALLA, CORRIDA ═══════════════════════════════════════════════

// Un escH que escapa de verdad: con uno que devuelve lo mismo, un nombre con < pasaría.
const escapa = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function pintar(SGCC) {
  const box = { innerHTML: '' };
  new Function('SGCC', 'eid', 'nr', 'sgMoney', 'escH', FN('function sgCcoopRenderCargas(){') + '; sgCcoopRenderCargas();')(
    SGCC, (id) => (id === 'sgcc-cargas' ? box : null), (n) => String(n), (n) => '$' + n, escapa);
  return box.innerHTML;
}
const FN = (firma) => fuente(PANEL, firma);
const FILAS = [
  { gasto_id: 1, numero_remito: 'SG-DESP-10', cliente_nombre: 'COTO', cooperativa_id: 30, cooperativa_nombre: 'Norte',
    proveedor_servicio_nombre: 'COOP LA UNION LTDA',
    fecha: '2026-09-10', cantidad: 150, unidad: 'bulto', estado: 'pendiente_valorizar', monto: null, remito_activo: 1 },
  { gasto_id: 2, numero_remito: 'SG-DESP-11', cliente_nombre: 'COTO', cooperativa_id: 31, cooperativa_nombre: 'Sur',
    fecha: '2026-08-01', cantidad: 40, unidad: 'bulto', estado: 'valorizado', monto: 8000, facturada: 0, remito_activo: 1 },
  { gasto_id: 3, numero_remito: 'SG-DESP-12', cliente_nombre: 'COTO', cooperativa_id: 30, cooperativa_nombre: 'Norte',
    fecha: '2026-09-11', cantidad: 20, unidad: 'bulto', estado: 'valorizado', monto: 1000, facturada: 1, remito_activo: 0 },
];

test('cada carga tiene su botón: valorizar, editar, o el candado si ya está facturada', () => {
  const h = pintar({ estado: '', cargas: FILAS, totCargas: { cargas: 3, bultos: 210, pendientes: 1, monto: 9000 } });
  assert.match(h, /onclick="sgCcoopValorizarCarga\(1\)">💵 Valorizar<\/button>/);
  assert.match(h, /onclick="sgCcoopValorizarCarga\(2\)">✏️ Editar<\/button>/);
  assert.ok(!/sgCcoopValorizarCarga\(3\)/.test(h), 'ofrece corregir una carga que ya está en la factura');
  assert.match(h, /🔒 facturada/);
  assert.match(h, /remito anulado/);
  assert.match(h, /\$200 \/ bulto/, 'el precio por bulto de la valorizada');
  assert.match(h, /3 carga\(s\) · 210 bultos · <b style="color:#9a3412">1 a valorizar<\/b> · valorizado \$9000/);
  // Sin barra lateral: anchos fijos, que suman el ancho entero, y lugar para el botón.
  assert.match(h, /<div class="ab-table-wrap" style="overflow-x:hidden !important"><table class="pa-tbl" style="table-layout:fixed;width:100%">/);
  const anchos = [...h.slice(0, h.indexOf('</thead>')).matchAll(/<th style="width:(\d+)%/g)].map((m) => Number(m[1]));
  assert.equal(anchos.reduce((a, x) => a + x, 0), 100);
  assert.ok(anchos[anchos.length - 1] >= 12, 'la columna del botón corta «💵 Valorizar»');
  // La cuadrilla y, abajo, a quién se le factura.
  assert.match(h, /Norte<div style="font-size:10\.5px;color:var\(--mut\);[^"]*">COOP LA UNION LTDA<\/div>/);
});

test('sin remito, no dice «remito anulado»; y lo que se escribe se escapa', () => {
  const h = pintar({ estado: '', cargas: [Object.assign({}, FILAS[0], { remito_activo: null, cliente_nombre: '<b>COTO</b>' })] });
  assert.ok(!/remito anulado/.test(h), 'dice anulado un remito que no existe');
  assert.ok(!h.includes('<b>COTO</b>'), 'el nombre del cliente no se escapa');
  assert.match(h, /&lt;b&gt;COTO&lt;\/b&gt;/);
});

test('si la lista no se pudo leer, las cargas también lo dicen', () => {
  assert.match(FN('function sgCcoopLoad(){'), /Tampoco se pudieron leer las cargas de salida\./);
});

// ── valorizar una carga, con la ruta REAL ────────────────────────────────────
const AYUDAS = new Function(fuente(SG, 'function importeValido(') + '\n' + fuente(SG, 'function facturaVivaDelGasto(')
  + '\n' + fuente(SG, 'function mensajeFacturaViva(') + '\nreturn { importeValido, facturaVivaDelGasto, mensajeFacturaViva };')();
function valorizarRuta(db, body) {
  db.transaction = (fn) => (...a) => {
    db.exec('BEGIN');
    try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const h = new Function('getDb', 'val', 'uid', 'r2', 'recalcCostoLote', 'importeValido', 'facturaVivaDelGasto',
    'mensajeFacturaViva', 'return ' + ruta("router.post('/gastos-servicio/valorizar'"))(
    () => db, (x) => (x == null || x === '' ? null : x), () => 5, r2, () => {},
    AYUDAS.importeValido, AYUDAS.facturaVivaDelGasto, AYUDAS.mensajeFacturaViva);
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  h({ body }, res);
  return res;
}

test('una carga se valoriza con su monto, contra su proveedor; facturada, no se toca', () => {
  const db = base();
  const g = (id) => db.prepare('SELECT estado, monto FROM sg_gastos_directos WHERE id=?').get(id);
  const ok = valorizarRuta(db, { proveedor_servicio_id: 30, items: [{ id: 1, monto: 7500 }] });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.data.valorizados, 1);
  assert.deepEqual({ ...g(1) }, { estado: 'valorizado', monto: 7500 });
  // Otro proveedor: no toca nada.
  assert.equal(valorizarRuta(db, { proveedor_servicio_id: 31, items: [{ id: 1, monto: 1 }] }).body.data.valorizados, 0);
  assert.equal(g(1).monto, 7500);
  // Ya en la factura de la cooperativa: no se revaloriza.
  db.exec("INSERT INTO sg_facturas_gasto VALUES (9, 'F-9', 1); INSERT INTO sg_factura_gasto_items VALUES (1, 9, 2);");
  const fac = valorizarRuta(db, { proveedor_servicio_id: 31, items: [{ id: 2, monto: 1 }] });
  assert.equal(fac.code, 400);
  assert.match(fac.body.error, /primero hay que anular esa factura/);
  assert.equal(g(2).monto, 8000);
});

test('sin cargas, o con el filtro «sin cooperativa», lo dice en vez de una tabla vacía', () => {
  assert.match(pintar({ estado: '', cargas: [] }), /Ninguna carga de salida con estos filtros/);
  assert.match(pintar({ estado: 'sin_coop', cargas: FILAS }), /Una carga sin cooperativa no deja nada que pagar/);
});

function valorizarCarga(SGCC, id) {
  let opts = null;
  const toasts = [];
  let recargo = 0;
  new Function('SGCC', 'toast', 'sgGdsValAbrir', 'sgCcoopLoad', FN('function sgCcoopValorizarCarga(gastoId){') + '; sgCcoopValorizarCarga(' + id + ');')(
    SGCC, (t) => toasts.push(t), (o) => { opts = o; }, () => { recargo++; });
  return { opts, toasts, recargo };
}

test('valorizar abre el mismo cuadro, contra el proveedor de la cooperativa y por bulto', () => {
  const r = valorizarCarga({ cargas: FILAS }, 1);
  assert.equal(r.opts.prov, 30);
  assert.equal(r.opts.refLbl, 'Remito');
  assert.equal(r.opts.subLbl, 'Cliente');
  assert.equal(r.opts.editando, false);
  assert.deepEqual(r.opts.items, [{ id: 1, ref: 'SG-DESP-10', sub: 'COTO', fecha: '2026-09-10',
    base: 150, unidadLbl: 'bulto', monto: null }]);
  assert.equal(valorizarCarga({ cargas: FILAS }, 2).opts.editando, true);
});

test('una facturada no se abre, y una que desapareció recarga la lista', () => {
  const f = valorizarCarga({ cargas: FILAS }, 3);
  assert.equal(f.opts, null);
  assert.match(f.toasts[0], /primero anulá la factura/);
  const g = valorizarCarga({ cargas: FILAS }, 99);
  assert.equal(g.opts, null);
  assert.equal(g.recargo, 1);
});

test('la lista guarda las cargas y las pinta aunque no haya descargas', () => {
  const l = FN('function sgCcoopLoad(){');
  assert.match(l, /SGCC\.cargas = d\.cargas \|\| \[\]; SGCC\.totCargas = d\.totales_cargas \|\| null;/);
  assert.ok(l.indexOf('sgCcoopRender();') < l.indexOf('sgCcoopRenderCargas();'), 'no pinta las cargas');
  const pane = PANEL.slice(PANEL.indexOf('id="sggd-pane-coop"'), PANEL.indexOf('id="sggd-pane-repaso"'));
  assert.ok(pane.indexOf('<div id="sgcc-detalle">') < pane.indexOf('<div id="sgcc-cargas">'), 'no está la tabla de cargas');
});

test('en la factura de la cooperativa, la carga muestra su cliente', () => {
  assert.match(FN('function sgFgPintar(){'), /escH\(f\[cc\.refCol\] \|\| \(f\.cliente \? \('cliente: ' \+ f\.cliente\) : '—'\)\)/);
  // Y la factura ya las acepta: es el mismo circuito que la descarga.
  assert.match(SG, /descarga:\s+\{ tipos: \['descarga_ingreso', 'carga_salida'\]/);
});

test('el código huérfano de «Cargas y Descargas» ya no está', () => {
  // Apuntaba a ids que no existen y nadie lo llamaba: el que lo encontraba creía que
  // las cargas se valorizaban por ahí.
  assert.ok(!/SGCD|sgCds|sgcd-/.test(PANEL), 'quedó código de la solapa vieja');
});

// ══ 3 · LOS «¿CÓMO SE USA?» DICEN LO QUE EL CÓDIGO HACE ════════════════════

const manual = (clave) => {
  const i = PANEL.indexOf('SG_MANUAL.' + clave + ' = {');
  assert.ok(i > 0, 'no está el manual de ' + clave);
  return PANEL.slice(i, PANEL.indexOf('\r\n};', i)).replace(/'\r?\n\s*\+ '/g, '');
};

test('manual de Gastos Directos: cada afirmación de las cargas, contra el código', () => {
  const M = manual('gastos');
  assert.match(M, /<h3>📦 Las cargas de salida <span class="ver">V1047<\/span><\/h3>/);
  assert.match(M, /en su propia tabla <b>📦 Cargas de salida<\/b>, abajo de las descargas/);
  assert.match(M, /Los mismos filtros de fecha, cooperativa y estado valen para las dos/);
  assert.match(M, /<b>las que faltan valorizar aparecen aunque el remito sea de antes del período<\/b>/);
  assert.match(SG, /OR g\.estado = 'pendiente_valorizar'\)"\); pc\.push\(String\(req\.query\.desde\)\);/);
  assert.match(M, /la <b>cuadrilla<\/b> y, abajo, <b>a quién se le factura<\/b>/);
  assert.match(M, /Se valorizan con <b>💵 Valorizar<\/b> en la fila/);
  assert.match(M, /Una ya valorizada se corrige con <b>✏️ Editar<\/b>; si ya está en la factura, la fila muestra 🔒/);
  assert.match(M, /la carga muestra el cliente del remito/);
  assert.match(M, /<b>no se le descuenta al productor<\/b>\. Resta del <b>margen del remito<\/b>/);
  // La carga no está entre lo que se le descuenta al productor, y el margen la resta.
  assert.match(leer('src/servicios/sg_gastos_facturados.js'), /export const TIPOS_DESCONTABLES = \['flete_entrada', 'descarga_ingreso'\];/);
  assert.match(SG, /- \(r\.carga_salida \|\| 0\);/);
});

test('manual de Remitos: dónde se pone el importe de la carga', () => {
  const M = manual('ventas');
  // Y el historial va en orden de versión.
  const vs = [...M.slice(M.indexOf('Qué cambió, y desde cuándo')).matchAll(/<li><b>V(\d+)<\/b>/g)].map((m) => Number(m[1]));
  assert.deepEqual(vs, [...vs].sort((a, b) => a - b), 'el historial de cambios quedó desordenado');
  assert.match(M, /<span class="ver">V1047<\/span> El importe se pone en <b>Gastos Directos → Control Cooperativa → 📦 Cargas de salida<\/b>/);
  assert.match(M, /<b>V1047<\/b> — la carga de la cooperativa se valoriza en Control Cooperativa/);
});

test('los manuales no citan una versión que el panel todavía no alcanzó', () => {
  const actual = Number((leer('src/sidebar-v2.js').match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const k of ['gastos', 'ventas']) {
    for (const v of (manual(k).match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
      assert.ok(v <= actual, `el manual de ${k} cita la V${v} y el panel va en la V${actual}`);
    }
  }
});
