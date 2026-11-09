// ══ ✏️ CAMBIAR EL NÚMERO DE UN PALLET (V1151) ═════════════════════════════════
//
// Andy, 9/11/2026: «¿ves difícil que el sistema permita modificar el número de
// romaneo? De última si hay dos con el mismo que salga un cartel en rojo... Se
// equivoca de número entonces deja de cargar en el nuevo».
//
// Lo que se clava acá, en orden de qué duele más:
//
//   1. QUE UN REPETIDO TRABE. Es lo que hacía dejar de usar el sistema: se guarda
//      y se marca en rojo. Por eso el número deja de ser UNIQUE en la base, y la
//      migración que lo saca se prueba corriendo SU SQL contra una tabla vieja.
//   2. QUE UN REPETIDO NO SE VEA. En las tres listas y con la de Proceso plegada.
//   3. QUE SE CAMBIE LO QUE YA ESTÁ IMPRESO EN UN REMITO.
//   4. QUE LA CULATA SUBA EL PALLET EQUIVOCADO por tener el mismo número que otro.
//   5. QUE EL FORMATO SE DESPAREJE: el correlativo ordena texto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  guardarPresentacion, registrarProceso, palletAbierto, cerrarPallet, proximoNumero,
  abrirDespacho, agregarPalletAlDespacho, emitirDespacho, pallets, palletsArmados,
  palletsParaDespacho, palletPorNumero, numerosRepetidos, normalizarNumeroPallet,
  cambiarNumeroPallet, escanearPallet,
} from '../src/servicios/galpon.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
const PANEL = leer('src/panel.html');
const DDL = leer('src/servicios/db_galpon.js');

const F = '2026-11-09';

// La tabla de pallets como queda DESPUÉS de la V1151: sin UNIQUE en el número.
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
      sector_id INTEGER, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca) VALUES (10,'Cuadro 3','El Abuelo');
    CREATE TABLE pa_sectores (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT);
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER,
      cultivo TEXT, campaña TEXT, es_perenne INTEGER DEFAULT 0);
    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
    INSERT INTO gal_config (clave,valor) VALUES ('pallet_prefijo','PC'),
      ('despacho_prefijo','DG'), ('pallet_desde','269'), ('pallet_desde_anio','26');
    CREATE TABLE gal_volcado_cuadrillas (volcado_id INTEGER NOT NULL,
      cuadrilla_id INTEGER NOT NULL, cuadrilla TEXT, kilos REAL NOT NULL,
      PRIMARY KEY (volcado_id, cuadrilla_id));
    CREATE TABLE gal_volcados (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT,
      lote_id INTEGER, lote_nombre TEXT, producto TEXT, kilos REAL, ifcos INTEGER,
      viaje INTEGER, sanitario TEXT, eliminado_en TEXT);
    CREATE TABLE gal_lote_datos (lote_id INTEGER PRIMARY KEY, renspa TEXT, variedad TEXT,
      cuartel TEXT, notas TEXT, actualizado TEXT);
    CREATE TABLE gal_presentaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT,
      destino TEXT, envase TEXT, por_bulto REAL DEFAULT 1, kg_unidad REAL DEFAULT 1,
      granel INTEGER DEFAULT 0, emoji TEXT, icono TEXT, icono_v TEXT,
      categoria TEXT NOT NULL DEFAULT 'I', calibre TEXT, color TEXT,
      orden INTEGER DEFAULT 100, activo INTEGER DEFAULT 1, creado_en TEXT,
      eliminado_en TEXT);
    CREATE TABLE gal_pallets (id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT,
      estado TEXT NOT NULL DEFAULT 'abierto', parcial INTEGER NOT NULL DEFAULT 0,
      mixto INTEGER NOT NULL DEFAULT 0, origen TEXT NOT NULL DEFAULT 'proceso',
      fecha_empaque TEXT, bultos REAL, kilos REAL, observacion TEXT, abierto_en TEXT,
      cerrado_en TEXT, usuario_id INTEGER, usuario TEXT, eliminado_en TEXT,
      numero_original TEXT);
    CREATE TABLE gal_despachos (id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT UNIQUE,
      estado TEXT NOT NULL DEFAULT 'borrador', fecha TEXT NOT NULL, destinatario TEXT,
      transporte TEXT, patente TEXT, remito TEXT, observacion TEXT, bultos REAL,
      kilos REAL, emitido_en TEXT, anulado_en TEXT, anulado_motivo TEXT, creado_en TEXT,
      usuario_id INTEGER, usuario TEXT, eliminado_en TEXT,
      cargado_en TEXT, cargado_por TEXT, cargado_por_id INTEGER, cargado_faltan TEXT);
    CREATE TABLE gal_procesos (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE,
      fecha TEXT NOT NULL, lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT,
      destino TEXT NOT NULL, presentacion_id INTEGER, presentacion TEXT, envase TEXT,
      categoria TEXT, calibre TEXT, variedad TEXT, renspa TEXT, cuartel TEXT,
      bultos REAL, por_bulto REAL, kg_unidad REAL, kilos REAL NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'ingreso', reparto TEXT,
      repartido INTEGER NOT NULL DEFAULT 0, pallet_id INTEGER, partido_de INTEGER,
      despacho_id INTEGER, observacion TEXT, estado TEXT NOT NULL DEFAULT 'ok',
      revision_motivo TEXT, usuario_id INTEGER, usuario TEXT, creado_en TEXT,
      eliminado_en TEXT);
    CREATE TABLE gal_camion_escaneos (id INTEGER PRIMARY KEY AUTOINCREMENT,
      despacho_id INTEGER NOT NULL, pallet_id INTEGER, numero TEXT, accion TEXT NOT NULL,
      resultado TEXT, agregado INTEGER NOT NULL DEFAULT 0,
      creado_en TEXT DEFAULT (datetime('now','localtime')), usuario_id INTEGER,
      usuario TEXT);
  `);
  return db;
}

// Tres pallets cerrados: PC-26-00269, 00270, 00271.
function conTres() {
  const db = base();
  const a = guardarPresentacion(db, { nombre: 'Caja', destino: 'comercial', envase: 'x',
    por_bulto: 1, kg_unidad: 7, calibre: '35-55', categoria: 'I' }).id;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 30, uuid: 'u' + i });
    const id = palletAbierto(db).id;
    cerrarPallet(db, id, {});
    ids.push(id);
  }
  return { db, a, ids };
}
const numDe = (db, id) => db.prepare('SELECT numero FROM gal_pallets WHERE id = ?').get(id).numero;

// ══════════════════════════════════════════════════════════════════════════
// 1 · EL FORMATO
// ══════════════════════════════════════════════════════════════════════════
test('LO TIPEADO SE LLEVA AL FORMATO DEL TARJETÓN', () => {
  const db = base();
  assert.equal(normalizarNumeroPallet(db, '274', 'PC-26-00280'), 'PC-26-00274');
  assert.equal(normalizarNumeroPallet(db, ' 00274 ', 'PC-26-00280'), 'PC-26-00274');
  assert.equal(normalizarNumeroPallet(db, 'pc-26-274', 'PC-26-00280'), 'PC-26-00274');
  // El año es el del pallet, no el de hoy: uno del 25 corregido no pasa al 26.
  assert.equal(normalizarNumeroPallet(db, '12', 'PC-25-00300'), 'PC-25-00012');
  // Los espacios se sacan, igual que en la app del cargador: «27 4» es 274.
  assert.equal(normalizarNumeroPallet(db, '27 4', 'PC-26-00280'), 'PC-26-00274');
  for (const malo of ['', 'abc', '123456', 'PC-2026-1', 'PC-26-']) {
    assert.equal(normalizarNumeroPallet(db, malo, 'PC-26-00280'), null, JSON.stringify(malo));
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · CAMBIARLO
// ══════════════════════════════════════════════════════════════════════════
test('SE CAMBIA, y el número que dio el sistema queda guardado UNA vez', () => {
  const { db, ids } = conTres();
  const r = cambiarNumeroPallet(db, ids[2], '275');
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.numero, 'PC-26-00275');
  assert.equal(r.anterior, 'PC-26-00271');
  assert.equal(r.cambio, 1);
  assert.deepEqual(r.repetidos, []);
  assert.equal(numDe(db, ids[2]), 'PC-26-00275');
  // Una segunda corrección no pisa el original.
  cambiarNumeroPallet(db, ids[2], '276');
  assert.equal(db.prepare('SELECT numero_original FROM gal_pallets WHERE id = ?').get(ids[2])
    .numero_original, 'PC-26-00271');
  // Lo mismo que ya tenía no es un cambio.
  assert.equal(cambiarNumeroPallet(db, ids[2], '276').cambio, 0);
});

test('UN REPETIDO SE GUARDA IGUAL y dice con quién choca', () => {
  const { db, ids } = conTres();
  const r = cambiarNumeroPallet(db, ids[2], '269');
  assert.equal(r.ok, true, 'trabó el cambio: es lo que hacía dejar de usar el sistema');
  assert.equal(numDe(db, ids[2]), 'PC-26-00269');
  assert.equal(r.repetidos.length, 1);
  assert.equal(r.repetidos[0].id, ids[0]);
  assert.equal(numerosRepetidos(db).get('PC-26-00269'), 2);
});

test('...Y SE VE EN LAS TRES LISTAS', () => {
  const { db, ids } = conTres();
  cambiarNumeroPallet(db, ids[2], '269');
  const rep = (l) => l.filter((x) => x.repetido > 1).map((x) => x.id).sort((a, b) => a - b);
  assert.deepEqual(rep(pallets(db, {})), [ids[0], ids[2]], 'Proceso no lo marca');
  assert.deepEqual(rep(palletsArmados(db, { todos: true })), [ids[0], ids[2]], 'Stock no lo marca');
  assert.deepEqual(rep(palletsParaDespacho(db, {})), [ids[0], ids[2]], 'el despacho no lo marca');
  // Y corregir uno lo saca de todas.
  cambiarNumeroPallet(db, ids[2], '271');
  assert.deepEqual(rep(pallets(db, {})), []);
});

test('UN BORRADO NO CUENTA COMO REPETIDO', () => {
  const { db, ids } = conTres();
  db.prepare("UPDATE gal_pallets SET eliminado_en = '2026-11-01' WHERE id = ?").run(ids[0]);
  cambiarNumeroPallet(db, ids[2], '269');
  assert.equal(numerosRepetidos(db).size, 0, 'un pallet borrado le estorba a uno vivo');
});

test('LO QUE NO SE PUEDE: formato, sin número, y un remito emitido', () => {
  const { db, ids, a } = conTres();
  assert.match(cambiarNumeroPallet(db, ids[0], 'abc').motivo, /274/);
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 5, uuid: 'x' });
  assert.match(cambiarNumeroPallet(db, palletAbierto(db).id, '300').motivo, /al cerrarlo/);
  assert.equal(cambiarNumeroPallet(db, 9999, '300').ok, false);
  // Un pallet en un despacho EMITIDO: el número está impreso en el remito.
  const d = abrirDespacho(db, { fecha: F, destinatario: 'Feria' });
  agregarPalletAlDespacho(db, d.id, ids[1], {});
  const e = emitirDespacho(db, d.id);
  const r = cambiarNumeroPallet(db, ids[1], '300');
  assert.equal(r.ok, false);
  assert.ok(r.motivo.includes(e.numero || e.despacho.numero), r.motivo);
  assert.equal(numDe(db, ids[1]), 'PC-26-00270');
});

test('...pero en un despacho TODAVÍA EN BORRADOR sí se cambia', () => {
  const { db, ids } = conTres();
  const d = abrirDespacho(db, { fecha: F });
  agregarPalletAlDespacho(db, d.id, ids[1], {});
  assert.equal(cambiarNumeroPallet(db, ids[1], '300').ok, true);
});

test('EL CORRELATIVO SIGUE AL MÁS ALTO, y la respuesta lo dice', () => {
  // Subir uno a 280 hace que el próximo sea el 281: se avisa en el momento para que
  // un número de más se vea cuando todavía se puede corregir.
  const { db, ids, a } = conTres();
  const r = cambiarNumeroPallet(db, ids[2], '280');
  assert.equal(r.proximo, 'PC-26-00281');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 5, uuid: 'n' });
  assert.equal(cerrarPallet(db, palletAbierto(db).id, {}).numero, 'PC-26-00281');
  // Y como todos tienen el mismo ancho, el orden de texto sigue siendo el de número.
  cambiarNumeroPallet(db, ids[0], '1000');
  assert.equal(proximoNumero(db, F), 'PC-26-01001');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · DONDE SE BUSCA POR NÚMERO
// ══════════════════════════════════════════════════════════════════════════
test('BUSCAR POR NÚMERO con dos iguales: el más nuevo, y dice que hay otro', () => {
  const { db, ids } = conTres();
  cambiarNumeroPallet(db, ids[2], '269');
  const p = palletPorNumero(db, 'PC-26-00269');
  assert.equal(p.id, ids[2]);
  assert.equal(p.repetido, 2);
  assert.deepEqual(p.mismo_numero.map((x) => x.id), [ids[0]]);
  assert.equal(palletPorNumero(db, 'PC-26-00270').repetido, 0);
});

test('LA CULATA con un número repetido: si uno va en ese camión, es ése', () => {
  const { db, ids } = conTres();
  const d = abrirDespacho(db, { fecha: F, destinatario: 'Feria' });
  agregarPalletAlDespacho(db, d.id, ids[2], {});
  agregarPalletAlDespacho(db, d.id, ids[1], {});
  cambiarNumeroPallet(db, ids[2], '269');          // ahora 269 son ids[0] e ids[2]
  const r = escanearPallet(db, d.id, '269', { usuario: 'Juan' });
  assert.equal(r.resultado, 'subido', r.motivo);
  assert.equal(r.camion.pallets.find((x) => x.pallet_id === ids[2]).subido, 1);
});

test('...y si NINGUNO va, no sube ninguno y avisa', () => {
  const { db, ids } = conTres();
  const d = abrirDespacho(db, { fecha: F, destinatario: 'Feria' });
  agregarPalletAlDespacho(db, d.id, ids[1], {});
  cambiarNumeroPallet(db, ids[2], '269');
  for (const agregar of [0, 1]) {
    const r = escanearPallet(db, d.id, '269', { usuario: 'Juan', agregar });
    assert.equal(r.ok, false);
    assert.equal(r.resultado, 'repetido');
    assert.match(r.motivo, /2 pallets/);
  }
  assert.equal(r2total(db, d.id), 1, 'subió uno de los dos a ciegas');
});
const r2total = (db, d) => db.prepare(
  "SELECT COUNT(DISTINCT pallet_id) AS n FROM gal_procesos WHERE despacho_id = ? AND tipo = 'salida' AND eliminado_en IS NULL")
  .get(d).n;

// ══════════════════════════════════════════════════════════════════════════
// 4 · LA BASE: EL NÚMERO DEJA DE SER ÚNICO
// ══════════════════════════════════════════════════════════════════════════
test('UNA BASE NUEVA nace sin UNIQUE en el número', () => {
  const i = DDL.indexOf('CREATE TABLE IF NOT EXISTS gal_pallets (');
  const t = DDL.slice(i, DDL.indexOf(');', i));
  assert.match(t, /\n\s+numero\s+TEXT,/);
  assert.ok(!/numero\s+TEXT UNIQUE/.test(t), 'la tabla nueva sigue con UNIQUE');
  assert.match(DDL, /CREATE INDEX IF NOT EXISTS gal_pallet_numero_idx ON gal_pallets\(numero\);/);
});

test('LA MIGRACIÓN, CORRIDA: saca el UNIQUE sin perder un pallet', () => {
  /* rehacerTabla() es de better-sqlite3 y acá no corre, así que se ejecuta SU SQL —el
     mismo texto que va a correr en producción— contra una tabla vieja con datos. */
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE gal_pallets (id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT UNIQUE,
      estado TEXT NOT NULL DEFAULT 'abierto', parcial INTEGER NOT NULL DEFAULT 0,
      mixto INTEGER NOT NULL DEFAULT 0, fecha_empaque TEXT, bultos REAL, kilos REAL,
      observacion TEXT, abierto_en TEXT, cerrado_en TEXT, usuario_id INTEGER,
      usuario TEXT, eliminado_en TEXT);
    ALTER TABLE gal_pallets ADD COLUMN origen TEXT NOT NULL DEFAULT 'proceso';
    ALTER TABLE gal_pallets ADD COLUMN numero_original TEXT;
    INSERT INTO gal_pallets (numero, estado, bultos, kilos, origen, observacion)
      VALUES ('PC-26-00269','cerrado',40,280,'proceso','uno'),
             ('PC-26-00270','cerrado',38,266,'armado','dos'),
             (NULL,'abierto',null,null,'proceso',null);
  `);
  // ¿Lo detecta la condición que decide correr la migración?
  const unico = db.prepare("PRAGMA index_list('gal_pallets')").all()
    .filter((x) => x.unique && x.origin === 'u')
    .some((x) => db.prepare("PRAGMA index_info('" + x.name + "')").all()
      .some((c) => c.name === 'numero'));
  assert.equal(unico, true, 'la condición no reconoce el UNIQUE viejo');

  const k = DDL.indexOf("rehacerTabla('gal_pallets', `") + "rehacerTabla('gal_pallets', `".length;
  const cols = /const COLS = \[([^\]]+)\]/.exec(DDL)[1].match(/'([a-z_]+)'/g)
    .map((x) => x.slice(1, -1));
  const sql = DDL.slice(k, DDL.indexOf('`);', k)).split('${COLS.join(\', \')}').join(cols.join(', '));
  // Las columnas que la migración copia son EXACTAMENTE las de la tabla.
  const hay = db.prepare("PRAGMA table_info('gal_pallets')").all().map((c) => c.name);
  assert.deepEqual([...cols].sort(), [...hay].sort());

  db.exec('BEGIN'); db.exec(sql); db.exec('COMMIT');
  const filas = db.prepare('SELECT * FROM gal_pallets ORDER BY id').all();
  assert.equal(filas.length, 3, 'se perdieron pallets');
  assert.equal(filas[1].origen, 'armado');
  assert.equal(filas[1].observacion, 'dos');
  assert.equal(filas[0].kilos, 280);
  // Y ahora entran dos iguales.
  db.prepare("UPDATE gal_pallets SET numero = 'PC-26-00269' WHERE id = 2").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gal_pallets WHERE numero = 'PC-26-00269'")
    .get().n, 2);
  // El índice para buscar sigue estando.
  assert.ok(db.prepare("PRAGMA index_list('gal_pallets')").all()
    .some((x) => x.name === 'gal_pallet_numero_idx'));
  // Y el próximo id no pisa uno viejo.
  db.prepare("INSERT INTO gal_pallets (estado) VALUES ('abierto')").run();
  assert.equal(db.prepare('SELECT MAX(id) AS m FROM gal_pallets').get().m, 4);
});

test('LA MIGRACIÓN NO CORRE si la tabla tiene columnas que no conoce', () => {
  assert.match(DDL, /if \(raras\.length \|\| COLS\.some\(\(c\) => !hay\.includes\(c\)\)\) \{/);
  assert.match(DDL, /no le saco el UNIQUE al número para no perder datos/);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LA LISTA DE PROCESO, EJECUTADA
// ══════════════════════════════════════════════════════════════════════════
function corte(desde, hasta) {
  const a = PANEL.indexOf(desde);
  assert.ok(a > 0, 'no encontré ' + desde);
  const b = PANEL.indexOf(hasta, a);
  assert.ok(b > a, 'no encontré ' + hasta);
  return PANEL.slice(a, b);
}
function lista(datos, fetchFalso) {
  const nodos = {};
  const nodo = (id) => nodos[id] || (nodos[id] = { id, innerHTML: '', value: '',
    style: {}, focus() {}, select() {} });
  const GPR = { datos, cerrado: null };
  const codigo = corte('function galPrEsc(s){', 'async function galPrInit(){')
    + corte('async function galPlBorrar(id){', '/* ── LO CARGADO ESTE DÍA');
  const f = new Function('document', 'fetch', 'GPR', 'galPrCargar', 'galPrPintarPallet',
    'galAcFechaCorta', 'confirm', 'alert', codigo
    + '\nreturn { galPrPintarPallets, galPlNumero, galPlNumeroGuardar, galPlNumeroTecla,'
    + ' galPlVer, get edit(){ return GPL_EDIT; } };');
  const api = f({ getElementById: nodo }, fetchFalso || (async () => ({ json: async () => ({}) })),
    GPR, async () => {}, () => {}, (x) => String(x || '').slice(5).split('-').reverse().join('/'),
    () => true, () => {});
  return Object.assign(api, { nodos, nodo, GPR });
}
const P = (id, numero, repetido) => ({ id, numero, estado: 'cerrado', fecha_empaque: F,
  bultos: 30, kilos: 210, repetido: repetido || 0 });

test('EL CARTEL ROJO SE VE CON LA LISTA PLEGADA', () => {
  const l = lista({ pallets: [P(1, 'PC-26-00269', 2), P(3, 'PC-26-00269', 2), P(2, 'PC-26-00270')] });
  l.galPrPintarPallets();
  const h = l.nodo('gpr-pallets').innerHTML;
  assert.match(h, /class="gpl-av-err"[^>]*><b>⚠ Número de pallet repetido:<\/b> PC-26-00269 \(2 pallets\)/);
  assert.ok(!/<table/.test(h), 'la lista se desplegó sola');
});

test('DESPLEGADA: REPETIDO en rojo en los dos, y el ✏️ en cada uno', () => {
  const l = lista({ pallets: [P(1, 'PC-26-00269', 2), P(3, 'PC-26-00269', 2), P(2, 'PC-26-00270')] });
  l.galPlVer();
  const h = l.nodo('gpr-pallets').innerHTML;
  assert.equal((h.match(/>REPETIDO</g) || []).length, 2);
  assert.equal((h.match(/onclick="galPlNumero\(\d+\)"/g) || []).length, 3);
  // Las columnas siguen sumando 100: sin barra lateral.
  const cols = [...h.matchAll(/<col style="width:(\d+)%">/g)].map((m) => Number(m[1]));
  assert.equal(cols.reduce((x, y) => x + y, 0), 100);
});

test('EL LÁPIZ VUELVE LA CELDA UN CASILLERO; Escape la deja como estaba', () => {
  const l = lista({ pallets: [P(2, 'PC-26-00270')] });
  l.galPlNumero(2);
  assert.match(l.nodo('gpr-pallets').innerHTML, /<input id="gpl-num-in"[^>]*value="PC-26-00270"/);
  l.galPlNumeroTecla({ key: 'Escape', preventDefault() {} });
  assert.equal(l.edit, null);
  assert.ok(!/gpl-num-in/.test(l.nodo('gpr-pallets').innerHTML));
});

test('GUARDAR UN REPETIDO: se guarda y el cartel lo dice en rojo', async () => {
  const pedidos = [];
  const l = lista({ pallets: [P(2, 'PC-26-00270')] }, async (url, init) => {
    pedidos.push({ url, init });
    return { json: async () => ({ ok: true, numero: 'PC-26-00269', anterior: 'PC-26-00270',
      cambio: 1, repetidos: [{ id: 1, fecha_empaque: '2026-11-05' }], proximo: 'PC-26-00271' }) };
  });
  l.galPlNumero(2);
  l.nodo('gpl-num-in').value = '269';
  await l.galPlNumeroGuardar();
  assert.equal(pedidos[0].url, '/api/galpon/pallets/2/numero');
  assert.equal(pedidos[0].init.method, 'PATCH');
  assert.equal(JSON.parse(pedidos[0].init.body).numero, '269');
  const h = l.nodo('gpr-pallets').innerHTML;
  assert.match(h, /class="gpl-av-err"[^>]*><b>PC-26-00269 quedó repetido:<\/b>/);
  assert.match(h, /Se guardó igual/);
  assert.equal(l.edit, null);
});

test('GUARDAR UNO SIN CHOQUE: verde, con el anterior y el próximo', async () => {
  const l = lista({ pallets: [P(2, 'PC-26-00270')] }, async () => ({ json: async () => ({
    ok: true, numero: 'PC-26-00274', anterior: 'PC-26-00270', cambio: 1, repetidos: [],
    proximo: 'PC-26-00275' }) }));
  l.galPlNumero(2);
  await l.galPlNumeroGuardar();
  const h = l.nodo('gpr-pallets').innerHTML;
  assert.match(h, /class="gpl-av-ok"/);
  assert.match(h, /Ahora es <b>PC-26-00274<\/b> \(era PC-26-00270\)/);
  assert.match(h, /Reimprimí el tarjetón/);
  assert.match(h, /va a ser <b>PC-26-00275<\/b>/);
});

test('LO QUE NO SE PUEDE: el error se ve y el casillero queda abierto', async () => {
  const l = lista({ pallets: [P(2, 'PC-26-00270')] }, async () => ({ json: async () => ({
    ok: false, error: 'Este pallet ya salió con el remito DG-26-00003' }) }));
  l.galPlNumero(2);
  await l.galPlNumeroGuardar();
  assert.match(l.nodo('gpr-pallets').innerHTML, /DG-26-00003/);
  assert.equal(l.edit, 2, 'cerró el casillero y el operador no puede corregir');
});

test('EL AVISO DEL CIERRE TIENE EL LÁPIZ', () => {
  /* Ejecutado y no leído: la prueba de mutación mostró que buscar el texto del botón
     en el código pasaba igual con el botón escondido detrás de un `false ?`. */
  const codigo = corte('function galPrEsc(s){', 'async function galPrInit(){')
    + corte('function galPrAcuseCierre(){', 'function galPrAcuseNo(){');
  const GPR = { cerrado: { id: 7, numero: 'PC-26-00275', bultos: 40, kilos: 280 } };
  const acuse = new Function('GPR', 'document', codigo + '\nreturn galPrAcuseCierre;')(GPR, {});
  assert.match(acuse(), /onclick="galPlNumero\(7\)">✏️ número<\/button>/);
  // Un pallet sin número todavía no ofrece cambiarlo.
  GPR.cerrado.numero = null;
  assert.ok(!/galPlNumero/.test(acuse()));
});

test('MANUAL: lo que dice es lo que hace', () => {
  const man = (k) => { const i = PANEL.indexOf("SG_MANUAL['" + k + "']");
    return PANEL.slice(i, PANEL.indexOf('\n};', i)).replace(/'\s*\r?\n\s*\+\s*'/g, ''); };
  const pr = man('galpon-proceso');
  assert.match(pr, /Cambiar el número de un pallet <span class="ver">V1151<\/span>/);
  assert.match(pr, /alcanza con <b>274<\/b>/);
  assert.match(pr, /Si queda repetido, se guarda igual<\/b>/);
  assert.match(pr, /<b>remito emitido<\/b>/);
  assert.match(pr, /número que le había dado el sistema <b>queda guardado<\/b>/);
  // Y la frase vieja de Configuración, que dejó de ser cierta, no está más.
  const cfg = man('galpon-config');
  assert.ok(!/los pallets cerrados no cambian de número/.test(cfg),
    'el manual de Configuración sigue diciendo que el número no cambia');
  assert.match(cfg, /<b>mueve el correlativo<\/b>/);
});
