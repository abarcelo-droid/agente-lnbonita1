// ══ 📲 CARGAR EL CAMIÓN, ESCANEANDO (V1149) ══════════════════════════════════
//
// Andy, 6/11/2026: «quiero que scanee cada pallet mientras está en la culata del
// camión cargando». Lo que se clava acá, en orden de qué duele más:
//
//   1. QUE SUBA UN PALLET QUE NO VA SIN QUE NADIE SE ENTERE. Es el error que la app
//      viene a evitar: frena, y agregarlo es una decisión que queda escrita.
//   2. QUE SE CUENTE DOS VECES. Escanear el mismo tarjetón dos veces no es «2 de 14».
//   3. QUE «CARGADO» MIENTA. Con faltantes se puede, pero diciendo cuáles; y cualquier
//      cambio posterior lo deshace.
//   4. QUE UN PALLET SE MUEVA DE CAMIÓN DESDE LA CULATA. Lo resuelve la oficina.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  guardarPresentacion, registrarProceso, palletAbierto, cerrarPallet,
  abrirDespacho, agregarPalletAlDespacho, agregarAlDespacho, emitirDespacho,
  camion, camionesParaCargar, nuevoCamion, escanearPallet, bajarPallet, marcarCargado,
} from '../src/servicios/galpon.js';

const F = new Date().toLocaleDateString('en-CA');
const AA = F.slice(2, 4);
const U = { usuario_id: 7, usuario: 'Juan' };

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
      ('despacho_prefijo','DG'), ('pallet_desde','269'), ('pallet_desde_anio','${AA}');
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
    CREATE TABLE gal_pallets (id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT UNIQUE,
      estado TEXT NOT NULL DEFAULT 'abierto', parcial INTEGER NOT NULL DEFAULT 0,
      mixto INTEGER NOT NULL DEFAULT 0, origen TEXT NOT NULL DEFAULT 'proceso',
      fecha_empaque TEXT, bultos REAL, kilos REAL, observacion TEXT, abierto_en TEXT,
      cerrado_en TEXT, usuario_id INTEGER, usuario TEXT, eliminado_en TEXT);
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

// Una cámara con N pallets cerrados: PC-AA-00269, 00270, ...
function conPallets(n) {
  const db = base();
  const a = guardarPresentacion(db, { nombre: 'Carton Amarilla', destino: 'comercial',
    envase: 'Caja', por_bulto: 1, kg_unidad: 7, calibre: '35-55', categoria: 'I' }).id;
  const ids = [];
  for (let i = 0; i < n; i++) {
    registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 50 + i,
      uuid: 'u' + i });
    const id = palletAbierto(db).id;
    cerrarPallet(db, id, {});
    ids.push(id);
  }
  return { db, a, ids, num: (k) => 'PC-' + AA + '-' + String(269 + k).padStart(5, '0') };
}

// Un despacho de la oficina con los dos primeros pallets.
function conLista() {
  const x = conPallets(4);
  const d = abrirDespacho(x.db, { fecha: F, destinatario: 'San Gerónimo', patente: 'AB123CD' });
  agregarPalletAlDespacho(x.db, d.id, x.ids[0], {});
  agregarPalletAlDespacho(x.db, d.id, x.ids[1], {});
  return Object.assign(x, { d: Number(d.id) });
}

const leidas = (db) => db.prepare('SELECT * FROM gal_camion_escaneos ORDER BY id').all();

// ══════════════════════════════════════════════════════════════════════════
// 1 · CONTRA LA LISTA DE LA OFICINA
// ══════════════════════════════════════════════════════════════════════════
test('el camión dice cuántos van y cuáles faltan, antes de escanear nada', () => {
  const { db, d, num } = conLista();
  const c = camion(db, d);
  assert.equal(c.modo, 'lista');
  assert.equal(c.total, 2);
  assert.equal(c.subidos, 0);
  assert.deepEqual(c.faltan, [num(0), num(1)]);
  assert.equal(c.listo, true);
  // Lo que lleva, en una línea: es lo que se lee en la culata.
  assert.match(c.pallets[0].lleva, /Carton Amarilla 35-55 · 50/);
});

test('ESCANEAR UNO DE LA LISTA LO SUBE, y el contador avanza', () => {
  const { db, d, num } = conLista();
  const r = escanearPallet(db, d, num(0), U);
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.resultado, 'subido');
  assert.equal(r.camion.subidos, 1);
  assert.deepEqual(r.camion.faltan, [num(1)]);
  // Y queda escrito quién, que es lo que se pregunta cuando falta algo en destino.
  const p = r.camion.pallets.find((x) => x.numero === num(0));
  assert.equal(p.subido_por, 'Juan');
  assert.ok(p.subido_en);
});

test('EL MISMO TARJETÓN DOS VECES NO CUENTA DOS', () => {
  const { db, d, num } = conLista();
  escanearPallet(db, d, num(0), U);
  const r = escanearPallet(db, d, num(0), U);
  assert.equal(r.ok, true);
  assert.equal(r.resultado, 'ya_estaba');
  assert.equal(r.camion.subidos, 1, 'contó dos veces el mismo pallet');
});

test('UN PALLET QUE NO VA FRENA, y no cambia nada', () => {
  const { db, d, num, ids } = conLista();
  const r = escanearPallet(db, d, num(2), U);
  assert.equal(r.ok, false);
  assert.equal(r.resultado, 'no_va');
  assert.equal(r.puede_agregar, 1);
  assert.match(r.motivo, /NO VA EN ESTE CAMIÓN/);
  assert.equal(r.camion.total, 2, 'lo agregó sin que nadie lo decidiera');
  // Y la lectura queda anotada aunque no haya hecho nada.
  const l = leidas(db).at(-1);
  assert.equal(l.resultado, 'no_va');
  assert.equal(l.pallet_id, ids[2]);
});

test('...y AGREGARLO IGUAL es una decisión que queda escrita', () => {
  const { db, d, num } = conLista();
  const r = escanearPallet(db, d, num(2), Object.assign({ agregar: 1 }, U));
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.resultado, 'agregado');
  assert.equal(r.camion.total, 3);
  assert.equal(r.camion.subidos, 1);
  assert.equal(r.camion.pallets.find((x) => x.numero === num(2)).agregado, 1);
  assert.equal(leidas(db).at(-1).agregado, 1);
  // Sigue siendo un camión con lista: el agregado no lo convierte en libre.
  assert.equal(r.camion.modo, 'lista');
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LO QUE NO SE PUEDE SUBIR, DICHO
// ══════════════════════════════════════════════════════════════════════════
test('NO SE MUEVE UN PALLET DE OTRO CAMIÓN desde la culata, ni agregándolo', () => {
  const { db, d, num, ids } = conLista();
  const otro = abrirDespacho(db, { fecha: F, destinatario: 'Feria' });
  agregarPalletAlDespacho(db, otro.id, ids[3], {});
  for (const agregar of [0, 1]) {
    const r = escanearPallet(db, d, num(3), Object.assign({ agregar }, U));
    assert.equal(r.ok, false);
    assert.equal(r.resultado, 'otro_despacho');
    assert.match(r.motivo, /Feria/, 'no dice en qué camión está: ' + r.motivo);
  }
  assert.equal(camion(db, otro.id).total, 1, 'se lo sacó al otro camión');
});

test('un pallet que YA SALIÓ lo dice con el número del despacho', () => {
  const { db, d, num, ids } = conLista();
  const otro = abrirDespacho(db, { fecha: F, destinatario: 'Feria' });
  agregarPalletAlDespacho(db, otro.id, ids[3], {});
  const e = emitirDespacho(db, otro.id);
  const r = escanearPallet(db, d, num(3), U);
  assert.equal(r.resultado, 'despachado');
  assert.ok(r.motivo.includes(e.numero || e.despacho.numero), r.motivo);
});

test('un pallet ABIERTO no se sube: no tiene tarjetón cerrado', () => {
  const { db, d, a } = conLista();
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 5, uuid: 'x' });
  db.prepare("UPDATE gal_pallets SET numero = 'PC-" + AA + "-00900' WHERE estado = 'abierto'")
    .run();
  const r = escanearPallet(db, d, 'PC-' + AA + '-00900', Object.assign({ agregar: 1 }, U));
  assert.equal(r.resultado, 'abierto');
});

test('lo que no es ningún pallet, y un despacho ya emitido', () => {
  const { db, d } = conLista();
  assert.equal(escanearPallet(db, d, 'PC-' + AA + '-09999', U).resultado, 'no_existe');
  assert.equal(escanearPallet(db, d, '   ', U).resultado, 'vacio');
  emitirDespacho(db, d);
  assert.equal(escanearPallet(db, d, 'PC-' + AA + '-00269', U).resultado, 'despacho_cerrado');
});

test('TIPEADO: «269», «00269» y «pc-26-269» encuentran el mismo pallet', () => {
  const { db, d, num } = conLista();
  for (const t of ['269', '00269', ('pc-' + AA + '-269'), (' ' + num(0).toLowerCase() + ' ')]) {
    const r = escanearPallet(db, d, t, U);
    assert.ok(r.ok, t + ': ' + r.motivo);
    assert.ok(['subido', 'ya_estaba'].includes(r.resultado), t + ': ' + r.resultado);
  }
  assert.equal(camion(db, d).subidos, 1);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LO BAJÉ
// ══════════════════════════════════════════════════════════════════════════
test('LO BAJÉ vuelve a pendiente; el de la lista sigue en la lista', () => {
  const { db, d, num, ids } = conLista();
  escanearPallet(db, d, num(0), U);
  const r = bajarPallet(db, d, ids[0], U);
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.resultado, 'bajado');
  assert.equal(r.camion.subidos, 0);
  assert.equal(r.camion.total, 2, 'sacó de la lista uno que había puesto la oficina');
  // Y volver a subirlo funciona: la última fila manda.
  assert.equal(escanearPallet(db, d, num(0), U).resultado, 'subido');
});

test('...y el AGREGADO EN LA CULATA, al bajarlo, sale del despacho', () => {
  const { db, d, num, ids } = conLista();
  escanearPallet(db, d, num(2), Object.assign({ agregar: 1 }, U));
  const r = bajarPallet(db, d, ids[2], U);
  assert.equal(r.resultado, 'bajado_y_sacado');
  assert.equal(r.camion.total, 2, 'quedó en el despacho un pallet que se bajó');
  // Y vuelve a estar libre para otro camión.
  const otro = abrirDespacho(db, { fecha: F });
  assert.equal(agregarPalletAlDespacho(db, otro.id, ids[2], {}).ok, true);
});

test('no se baja lo que no está arriba', () => {
  const { db, d, ids } = conLista();
  assert.equal(bajarPallet(db, d, ids[0], U).ok, false);
  assert.equal(bajarPallet(db, d, 999, U).ok, false);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · CAMIÓN CARGADO
// ══════════════════════════════════════════════════════════════════════════
test('CARGADO con todo arriba: queda quién y cuándo, y no emite', () => {
  const { db, d, num } = conLista();
  escanearPallet(db, d, num(0), U);
  escanearPallet(db, d, num(1), U);
  const r = marcarCargado(db, d, U);
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.camion.cargado.por, 'Juan');
  assert.ok(r.camion.cargado.en);
  assert.deepEqual(r.camion.cargado.faltaron, []);
  assert.equal(r.camion.estado, 'borrador', 'emitió el remito desde la culata');
});

test('CON FALTANTES PIDE CONFIRMAR, y si se confirma quedan escritos', () => {
  const { db, d, num } = conLista();
  escanearPallet(db, d, num(0), U);
  const r = marcarCargado(db, d, U);
  assert.equal(r.ok, false);
  assert.equal(r.necesita_confirmar, 1);
  assert.deepEqual(r.faltan, [num(1)]);
  const r2 = marcarCargado(db, d, Object.assign({ confirmar: 1 }, U));
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.camion.cargado.faltaron, [num(1)]);
});

test('TOCAR EL CAMIÓN DESPUÉS DESHACE EL «CARGADO»', () => {
  const { db, d, num, ids } = conLista();
  escanearPallet(db, d, num(0), U);
  escanearPallet(db, d, num(1), U);
  marcarCargado(db, d, U);
  bajarPallet(db, d, ids[1], U);
  assert.equal(camion(db, d).cargado, null, 'sigue diciendo cargado con un pallet abajo');
  escanearPallet(db, d, num(1), U);
  marcarCargado(db, d, U);
  escanearPallet(db, d, num(2), Object.assign({ agregar: 1 }, U));
  assert.equal(camion(db, d).cargado, null, 'un agregado no deshizo el cargado');
});

test('CON CAJAS SUELTAS NO ESTÁ LISTO: en camión no se cargan sueltas', () => {
  const { db, d, num, a } = conLista();
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 30,
    uuid: 's', sin_pallet: 1 });
  assert.equal(agregarAlDespacho(db, d, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '35-55', bultos: 10 }).ok, true);
  const c = camion(db, d);
  assert.equal(c.listo, false);
  assert.equal(c.piso.length, 1);
  escanearPallet(db, d, num(0), U);
  escanearPallet(db, d, num(1), U);
  const r = marcarCargado(db, d, Object.assign({ confirmar: 1 }, U));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /sueltas/);
});

test('sin nada subido no se da por cargado', () => {
  const { db, d } = conLista();
  assert.equal(marcarCargado(db, d, Object.assign({ confirmar: 1 }, U)).ok, false);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · EL CAMIÓN QUE SE ARMA ESCANEANDO
// ══════════════════════════════════════════════════════════════════════════
test('NUEVO CAMIÓN pide a dónde va y la patente', () => {
  const { db } = conPallets(1);
  assert.equal(nuevoCamion(db, Object.assign({ patente: 'AB123CD' }, U)).ok, false);
  assert.equal(nuevoCamion(db, Object.assign({ destinatario: 'Feria' }, U)).ok, false);
  const r = nuevoCamion(db, Object.assign({ destinatario: 'Feria', patente: 'ab 123 cd' }, U));
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.camion.modo, 'libre');
  assert.equal(r.camion.estado, 'borrador');
});

test('EN UN CAMIÓN SIN LISTA, cada escaneo suma: no hay «no va»', () => {
  const { db, num } = conPallets(3);
  const { id } = nuevoCamion(db, Object.assign({ destinatario: 'Feria', patente: 'AA1' }, U));
  for (let k = 0; k < 3; k++) {
    const r = escanearPallet(db, id, num(k), U);
    assert.equal(r.ok, true, r.motivo);
    assert.equal(r.resultado, 'subido', 'dio ' + r.resultado + ' en un camión sin lista');
  }
  const c = camion(db, id);
  assert.equal(c.total, 3);
  assert.equal(c.subidos, 3);
  assert.equal(c.modo, 'libre');
  // Y bajarlo lo saca del todo: ahí no había otra lista que lo pidiera.
  const r = bajarPallet(db, id, c.pallets[0].pallet_id, U);
  assert.equal(r.camion.total, 2);
});

test('la lista de camiones son los BORRADORES, con cuántos van arriba', () => {
  const { db, d, num } = conLista();
  escanearPallet(db, d, num(0), U);
  const otro = abrirDespacho(db, { fecha: F });
  emitirDespacho(db, otro.id);   // vacío: no emite, sigue borrador
  const l = camionesParaCargar(db);
  const este = l.find((x) => x.id === d);
  assert.ok(este, 'no está el camión en la lista');
  assert.equal(este.total, 2);
  assert.equal(este.subidos, 1);
  emitirDespacho(db, d);
  assert.ok(!camionesParaCargar(db).some((x) => x.id === d), 'ofrece cargar uno emitido');
});
