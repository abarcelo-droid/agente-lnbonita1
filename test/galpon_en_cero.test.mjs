// ══ 🧹 EL GALPÓN EN CERO (5/11/2026) ════════════════════════════════════════
//
// Andy: «dejame todo el proceso en cero y los pallets también porque habíamos
// cargado algo mal. Por otro lado volvé el numerador al pallet 269».
//
// Corre una sola vez en producción, sola, al desplegar. Lo que se clava acá:
//
//   1. QUE BORRE DE MÁS. Los volcados, la configuración y las presentaciones se
//      quedan: son lo que el galpón NO cargó mal.
//   2. QUE EL PRÓXIMO PALLET NO SEA EL 269. Un número viejo en una fila borrada
//      empuja el correlativo, porque proximoNumero() mira el más alto.
//   3. QUE CORRA DOS VECES. Sin la marca, cada deploy borraría lo cargado desde
//      entonces.
//   4. QUE NO SE PUEDA RECUPERAR. Se marca, no se destruye.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  ponerEnCero, guardarPresentacion, registrarProceso, palletAbierto, cerrarPallet,
  proximoNumero, abrirDespacho, agregarPalletAlDespacho, stockGalpon,
} from '../src/servicios/galpon.js';

const F = '2026-11-05';

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
      ('despacho_prefijo','DG'), ('pallet_desde','500'), ('pallet_desde_anio','26'),
      ('tara_ifco','2');
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
      usuario_id INTEGER, usuario TEXT, eliminado_en TEXT);
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
    INSERT INTO gal_volcados (fecha, lote_id, kilos) VALUES ('${F}', 10, 1200);
  `);
  return db;
}

// Un galpón con lo que se cargó mal: tres pallets cerrados que llegaron hasta el
// 502, uno abierto, un despacho, y un pallet borrado de antes que también tiene número.
function conAlgoCargado() {
  const db = base();
  const a = guardarPresentacion(db, { nombre: 'Caja', destino: 'comercial', envase: 'x',
    por_bulto: 1, kg_unidad: 8, categoria: 'I' }).id;
  for (let i = 1; i <= 3; i++) {
    registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 50,
      uuid: 'u' + i });
    cerrarPallet(db, palletAbierto(db).id, {});
  }
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 7, uuid: 'u9' });
  const d = abrirDespacho(db, { fecha: F, destinatario: 'San Gerónimo' });
  agregarPalletAlDespacho(db, d.id, db.prepare(
    "SELECT id FROM gal_pallets WHERE estado = 'cerrado' ORDER BY id LIMIT 1").get().id);
  db.exec("INSERT INTO gal_pallets (numero, estado, eliminado_en)"
    + " VALUES ('PC-26-00600', 'cerrado', '2026-11-01 10:00:00')");
  return { db, a };
}

const vivos = (db, t) => db.prepare(
  'SELECT COUNT(*) AS n FROM ' + t + ' WHERE eliminado_en IS NULL').get().n;

test('el galpón de prueba es el que dice ser: sin esto el resto no mide nada', () => {
  const { db } = conAlgoCargado();
  assert.ok(vivos(db, 'gal_procesos') >= 4);
  assert.equal(vivos(db, 'gal_pallets'), 4);
  assert.equal(vivos(db, 'gal_despachos'), 1);
  // El 502 y el borrado 600 empujan el correlativo: sin la puesta en cero, el
  // próximo sería el 601.
  assert.equal(proximoNumero(db, F), 'PC-26-00601');
});

test('BORRA PROCESO, PALLETS Y DESPACHOS', () => {
  const { db } = conAlgoCargado();
  const r = ponerEnCero(db, { anio: 2026 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(vivos(db, 'gal_procesos'), 0);
  assert.equal(vivos(db, 'gal_pallets'), 0);
  assert.equal(vivos(db, 'gal_despachos'), 0);
  // Y la cámara queda vacía de verdad, que es lo que se mira en pantalla.
  assert.equal(stockGalpon(db, {}).kilos, 0);
  assert.equal(palletAbierto(db), null, 'quedó un pallet abierto llevándose la próxima caja');
  assert.equal(r.pallets, 4);
  assert.equal(r.despachos, 1);
});

test('Y NO BORRA DE MÁS: volcados, configuración y presentaciones se quedan', () => {
  const { db } = conAlgoCargado();
  ponerEnCero(db, { anio: 2026 });
  assert.equal(vivos(db, 'gal_volcados'), 1, 'borró lo que entró a la tolva');
  assert.equal(vivos(db, 'gal_presentaciones'), 1, 'borró el catálogo');
  assert.equal(db.prepare("SELECT valor FROM gal_config WHERE clave = 'tara_ifco'").get().valor,
    '2', 'tocó la configuración que no tenía que tocar');
});

test('EL PRÓXIMO PALLET ES EL 269, aunque hubiera números más altos y borrados', () => {
  const { db, a } = conAlgoCargado();
  ponerEnCero(db, { anio: 2026 });
  assert.equal(proximoNumero(db, F), 'PC-26-00269');
  // Y de punta a punta: cargar y cerrar da el 269, y el siguiente el 270.
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 10, uuid: 'n1' });
  assert.equal(cerrarPallet(db, palletAbierto(db).id, {}).numero, 'PC-26-00269');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 10, uuid: 'n2' });
  assert.equal(cerrarPallet(db, palletAbierto(db).id, {}).numero, 'PC-26-00270');
});

test('el arranque vuelve a 269 aunque en Configuración dijera otra cosa', () => {
  // La base de prueba arranca con pallet_desde = 500: es lo que se pidió pisar.
  const { db } = conAlgoCargado();
  ponerEnCero(db, { anio: 2026 });
  const v = (k) => db.prepare('SELECT valor FROM gal_config WHERE clave = ?').get(k).valor;
  assert.equal(v('pallet_desde'), '269');
  assert.equal(v('pallet_desde_anio'), '26');
});

test('SE PUEDE RECUPERAR: se marca con un solo momento, no se destruye', () => {
  const { db } = conAlgoCargado();
  const antes = db.prepare('SELECT COUNT(*) AS n FROM gal_procesos').get().n;
  const r = ponerEnCero(db, { anio: 2026, cuando: '2026-11-05 18:00:00' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gal_procesos').get().n, antes,
    'destruyó filas en vez de marcarlas');
  assert.equal(r.cuando, '2026-11-05 18:00:00');
  // Todo lo de hoy lleva ese momento, que es la llave para deshacerlo; el pallet que
  // ya estaba borrado de antes conserva su fecha.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gal_pallets"
    + " WHERE eliminado_en = '2026-11-05 18:00:00'").get().n, 4);
  assert.equal(db.prepare("SELECT eliminado_en FROM gal_pallets"
    + " WHERE numero = 'BORRADO-PC-26-00600'").get().eliminado_en, '2026-11-01 10:00:00');
  // Y el número viejo sigue ahí, para quien lo busque en un tarjetón impreso.
  assert.ok(db.prepare("SELECT 1 FROM gal_pallets WHERE numero = 'BORRADO-PC-26-00500'").get());
});

test('correrla dos veces no rompe el UNIQUE ni borra lo nuevo dos veces', () => {
  const { db } = conAlgoCargado();
  ponerEnCero(db, { anio: 2026 });
  const r = ponerEnCero(db, { anio: 2026 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.numeros, 0, 'le antepuso BORRADO- dos veces');
});

test('LA MIGRACIÓN CORRE UNA SOLA VEZ: marcada en gal_config', () => {
  /* Sin la marca, cada deploy volvería a borrar lo que el galpón cargó desde
     entonces. Se lee el arranque porque es ahí donde vive la decisión. */
  const ddl = fs.readFileSync(new URL('../src/servicios/db_galpon.js', import.meta.url), 'utf8');
  const i = ddl.indexOf("clave = 'migr_cero_20261105'");
  assert.ok(i > 0, 'no hay marca');
  const tramo = ddl.slice(i - 200, i + 900);
  assert.match(tramo, /if \(!hecha\) \{/);
  assert.match(tramo, /const r = ponerEnCero\(db\);/);
  assert.match(tramo, /INSERT INTO gal_config \(clave, valor\) VALUES \('migr_cero_20261105', \?\)/);
  // Y la marca se escribe DESPUÉS de borrar y sólo si salió bien: al revés, un
  // fallo a mitad de camino la dejaría puesta con nada borrado.
  assert.ok(tramo.indexOf('if (!r.ok) throw') < tramo.indexOf("VALUES ('migr_cero_20261105'"));
});

test('si algo falla a mitad de camino, no borra la mitad', () => {
  const { db } = conAlgoCargado();
  // Sin tabla de despachos, el segundo UPDATE revienta después del primero.
  db.exec('DROP TABLE gal_despachos');
  const r = ponerEnCero(db, { anio: 2026 });
  assert.equal(r.ok, false);
  assert.ok(vivos(db, 'gal_procesos') >= 4, 'borró el proceso y dejó todo lo demás');
});

test('MANUAL CFG: lo que dice de la puesta en cero es lo que hace el código', () => {
  const panel = fs.readFileSync(new URL('../src/panel.html', import.meta.url), 'utf8');
  const i = panel.indexOf("SG_MANUAL['galpon-config']");
  const man = panel.slice(i, panel.indexOf('\n};', i)).replace(/'\s*\r?\n\s*\+\s*'/g, '');
  assert.match(man, /El galpón se puso en cero el 5\/11\/2026 <span class="ver">V1147<\/span>/);
  const svc = fs.readFileSync(new URL('../src/servicios/galpon.js', import.meta.url), 'utf8');
  const f = svc.slice(svc.indexOf('export function ponerEnCero('));
  // «figura como BORRADO-PC-26-…»
  assert.match(man, /BORRADO-PC-26-/);
  assert.match(f, /SET numero = 'BORRADO-' \|\| numero/);
  // «el próximo pallet que se cierre es el 269»
  assert.match(man, /El próximo pallet que se cierre es el <b>269<\/b>/);
  assert.match(f, /cfg\.run\('pallet_desde', '269'\)/);
  // «los volcados se quedaron»: el código no los nombra.
  assert.match(man, /Los '?\s*'?<b>volcados<\/b>/);
  assert.ok(!/gal_volcados/.test(f.slice(0, f.indexOf('\n}'))), 'el código toca los volcados');
  // «no se destruyó»: no hay un DELETE.
  assert.match(man, /no se destruyó/);
  assert.ok(!/DELETE FROM/.test(f.slice(0, f.indexOf('\n}'))), 'el código destruye filas');
});
