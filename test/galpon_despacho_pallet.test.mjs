// ══ 📦 UN PALLET ARMADO VA ENTERO, O NO VA ═══════════════════════════════
//
// Andy, 5/11/2026: «en los despachos tenés que tener la opción de cargar del
// "piso" o pallets. Pero una vez que está armado el pallet no puede cargarse
// sólo una parte del pallet».
//
// Hasta la V1143 el despacho pedía una CANTIDAD y el servicio la juntaba de
// donde hubiera, de lo más viejo a lo más nuevo, partiendo el pallet que
// hiciera falta. En el papel cerraba perfecto. En el playón alguien tenía que
// cortarle el film a un pallet terminado, y el tarjetón —impreso, pegado y
// diciendo 100— se iba en el camión arriba de 40 cajas.
//
// Lo que se clava acá:
//
//   1. QUE EL PISO SEA EL PISO. Lo suelto y lo que está en un pallet ABIERTO,
//      porque eso todavía no es un pallet: no tiene número ni tarjetón. Un
//      pallet CERRADO queda afuera, y por eso no se lo puede partir.
//   2. QUE NADA SE PIERDA ENTRE LAS DOS LISTAS. Un pallet borrado deja cajas
//      que están en algún lado: si no caen en el piso, son kilos que el stock
//      cuenta y que nadie puede despachar nunca.
//   3. QUE EL PALLET ENTRE Y SALGA ENTERO, también el mixto, también cuando
//      alguien hace clic dos veces.
//   4. QUE NO SE PUEDA ESQUIVAR LA REGLA por el costado: sacando un renglón
//      suelto de un pallet mixto, o reabriendo un pallet que ya está en un
//      remito.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  guardarPresentacion, guardarDatosDeLote, registrarProceso,
  pisoParaDespacho, palletsParaDespacho, unidadesDelDespacho,
  abrirDespacho, agregarAlDespacho, agregarPalletAlDespacho,
  sacarDelDespacho, sacarPalletDelDespacho, itemsDelDespacho,
  emitirDespacho, anularDespacho,
  palletAbierto, cerrarPallet, reabrirPallet, palletResumen, stockGalpon,
  borrarProceso,
} from '../src/servicios/galpon.js';

const F = '2026-12-15';

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
                           sector_id INTEGER, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca) VALUES
      (10,'L-1215-A','El Abuelo'), (11,'L-1215-C','La Estación');
    CREATE TABLE pa_sectores (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT);
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER,
      cultivo TEXT, campaña TEXT, es_perenne INTEGER DEFAULT 0);
    INSERT INTO pa_cultivos_lote (lote_id,cultivo,es_perenne) VALUES
      (10,'Damasco',1), (11,'Ciruela',1);
    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
    INSERT INTO gal_config (clave,valor) VALUES ('despacho_prefijo','DG'),
      ('pallet_prefijo','PC');
    CREATE TABLE gal_volcado_cuadrillas (
      volcado_id INTEGER NOT NULL, cuadrilla_id INTEGER NOT NULL,
      cuadrilla TEXT, kilos REAL NOT NULL,
      PRIMARY KEY (volcado_id, cuadrilla_id));
    CREATE TABLE gal_volcados (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT,
      lote_id INTEGER, lote_nombre TEXT, producto TEXT, kilos REAL, ifcos INTEGER,
      viaje INTEGER, sanitario TEXT, eliminado_en TEXT);
    CREATE TABLE gal_lote_datos (lote_id INTEGER PRIMARY KEY, renspa TEXT, variedad TEXT,
      cuartel TEXT, notas TEXT, actualizado TEXT);
    CREATE TABLE gal_presentaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT,
      destino TEXT, envase TEXT, por_bulto REAL DEFAULT 1, kg_unidad REAL DEFAULT 1,
      granel INTEGER DEFAULT 0, emoji TEXT, icono TEXT, icono_v TEXT,
      categoria TEXT NOT NULL DEFAULT 'I', calibre TEXT,
      color TEXT, orden INTEGER DEFAULT 100, activo INTEGER DEFAULT 1,
      creado_en TEXT, eliminado_en TEXT);
    CREATE TABLE gal_pallets (id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT UNIQUE,
      estado TEXT NOT NULL DEFAULT 'abierto', parcial INTEGER NOT NULL DEFAULT 0,
      mixto INTEGER NOT NULL DEFAULT 0, origen TEXT NOT NULL DEFAULT 'proceso',
      fecha_empaque TEXT, bultos REAL, kilos REAL,
      observacion TEXT, abierto_en TEXT, cerrado_en TEXT, usuario_id INTEGER,
      usuario TEXT, eliminado_en TEXT);
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
  `);
  guardarDatosDeLote(db, { lote_id: 10, renspa: 'R-10', variedad: 'Castlebrite',
    cuartel: 'C-07' });
  return db;
}

const art = (db, nombre, calibre) => guardarPresentacion(db, {
  nombre, destino: 'comercial', envase: 'Caja 8 kg', por_bulto: 1, kg_unidad: 8,
  calibre, categoria: 'I' }).id;

const entra = (db, a, cajas, u, lote) => registrarProceso(db,
  { fecha: F, lote_id: lote || 10, presentacion_id: a, bultos: cajas, uuid: u });

const suelto = (db, a, cajas, u, lote) => registrarProceso(db,
  { fecha: F, lote_id: lote || 10, presentacion_id: a, bultos: cajas, uuid: u,
    sin_pallet: 1 });

// Un pallet cerrado con `cajas` cajas del artículo, y su id.
function palletCon(db, a, cajas, u, lote) {
  entra(db, a, cajas, u, lote);
  const id = palletAbierto(db).id;
  cerrarPallet(db, id, {});
  return id;
}

const enStock = (db) => stockGalpon(db, {}).destinos
  .reduce((t, d) => t + (Number(d.bultos) || 0), 0);

// ══════════════════════════════════════════════════════════════════════════
// 1 · QUÉ ES EL PISO
// ══════════════════════════════════════════════════════════════════════════
test('LO QUE ESTÁ EN UN PALLET CERRADO NO ESTÁ EN EL PISO', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  palletCon(db, a, 60, '1');
  assert.deepEqual(pisoParaDespacho(db), [], 'el piso ofrece cajas de un pallet cerrado');
  // Pero el stock total no cambió: las cajas están, en otro lado.
  assert.equal(enStock(db), 60);
});

test('lo que está en un pallet ABIERTO sí: todavía no es un pallet', () => {
  /* El del día mientras se llena. No tiene número, no tiene tarjetón y nadie lo
     enzunchó: son cajas apiladas, y de ahí se saca de a cuántas haga falta. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 60, '1');
  assert.ok(palletAbierto(db), 'la carga no abrió el pallet del día');
  assert.equal(pisoParaDespacho(db).length, 1);
  assert.equal(pisoParaDespacho(db)[0].bultos, 60);
  assert.deepEqual(palletsParaDespacho(db), [], 'ofreció un pallet sin cerrar');
});

test('y lo suelto de verdad también', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  suelto(db, a, 25, '1');
  assert.equal(pisoParaDespacho(db)[0].bultos, 25);
});

test('CERRAR EL PALLET LO SACA DEL PISO Y LO PONE EN LA OTRA LISTA', () => {
  // Es el momento exacto en que un montón de cajas se vuelve una unidad.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 60, '1');
  assert.equal(pisoParaDespacho(db).length, 1);
  cerrarPallet(db, palletAbierto(db).id, {});
  assert.deepEqual(pisoParaDespacho(db), []);
  const lp = palletsParaDespacho(db);
  assert.equal(lp.length, 1);
  assert.equal(lp[0].numero, 'PC-26-00001');
  assert.equal(lp[0].bultos, 60);
  assert.equal(lp[0].kilos, 480);
  assert.equal(lp[0].articulos, 1);
});

test('UN PALLET BORRADO DEJA SUS CAJAS EN EL PISO, no en la nada', () => {
  /* Si cayeran fuera de las dos listas serían kilos que el stock cuenta y que
     nadie puede despachar nunca — y el inventario no cerraría jamás. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const pid = palletCon(db, a, 60, '1');
  db.prepare("UPDATE gal_pallets SET eliminado_en = '2026-12-16' WHERE id = ?").run(pid);
  assert.equal(enStock(db), 60);
  assert.equal(pisoParaDespacho(db).length, 1, 'las cajas desaparecieron de las dos listas');
  assert.equal(pisoParaDespacho(db)[0].bultos, 60);
  assert.deepEqual(palletsParaDespacho(db), []);
});

test('un pallet cerrado y VACÍO no se ofrece', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const pid = palletCon(db, a, 60, '1');
  const d = abrirDespacho(db, { fecha: F });
  agregarPalletAlDespacho(db, d.id, pid);
  emitirDespacho(db, d.id);
  assert.deepEqual(palletsParaDespacho(db), [], 'ofreció un pallet que ya se fue');
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · PEDIR POR CANTIDAD NO TOCA UN PALLET CERRADO
// ══════════════════════════════════════════════════════════════════════════
test('NO SE PUEDE SACAR UNA PARTE DE UN PALLET CERRADO', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const pid = palletCon(db, a, 100, '1');
  const d = abrirDespacho(db, { fecha: F });
  const r = agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 60 });
  assert.equal(r.ok, false, 'le sacó 60 cajas a un pallet cerrado');
  assert.equal(r.en_pallet, 1);
  assert.match(r.motivo, /pallet/i);
  assert.match(r.motivo, /entero/i, 'no dice cuál es el camino: ' + r.motivo);
  assert.equal(palletResumen(db, pid).bultos, 100, 'igual le sacó cajas');
  assert.equal(itemsDelDespacho(db, d.id).length, 0);
});

test('y de algo que nunca entró dice otra cosa', () => {
  // Las dos respuestas se parecen y mandan a lugares distintos: una a cerrar o
  // elegir el pallet, la otra a mirar si el artículo es el que se cargó.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const d = abrirDespacho(db, { fecha: F });
  const r = agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.en_pallet, 0);
  assert.match(r.motivo, /nunca entró/);
});

test('con piso Y pallet, del piso sale sólo lo del piso', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const pid = palletCon(db, a, 60, '1');
  entra(db, a, 40, '2');                       // al pallet del día, abierto = piso
  assert.equal(pisoParaDespacho(db)[0].bultos, 40, 'el piso contó las del pallet cerrado');

  const d = abrirDespacho(db, { fecha: F });
  const r = agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(palletResumen(db, pid).bultos, 60, 'tocó el pallet cerrado');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL PALLET ENTERO
// ══════════════════════════════════════════════════════════════════════════
test('AGREGAR UN PALLET LO LLEVA ENTERO, sin pedir cantidad', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const pid = palletCon(db, a, 60, '1');
  const d = abrirDespacho(db, { fecha: F });
  const r = agregarPalletAlDespacho(db, d.id, pid);
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.numero, 'PC-26-00001');
  assert.equal(r.bultos, 60);
  assert.equal(r.kilos, 480);
  assert.equal(r.articulos, 1);
  assert.equal(palletResumen(db, pid).bultos, 0, 'no salió entero');
  assert.equal(enStock(db), 0);
  assert.equal(r.despacho.bultos, 60, 'el total del despacho no se recalculó');
});

test('UN PALLET MIXTO ENTRA ENTERO, con una línea por artículo', () => {
  /* Un mixto son varios artículos y cada uno tiene que quedar como su propia
     línea de salida: el remito y el stock se leen por artículo, no por bulto. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const b = art(db, 'IFCO', '60/70');
  entra(db, a, 40, '1');
  entra(db, b, 20, '2', 11);
  const pid = palletAbierto(db).id;
  cerrarPallet(db, pid, {});

  const d = abrirDespacho(db, { fecha: F });
  const r = agregarPalletAlDespacho(db, d.id, pid);
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.articulos, 2);
  assert.equal(r.bultos, 60);
  const it = itemsDelDespacho(db, d.id);
  assert.equal(it.length, 2);
  assert.ok(it.every((f) => f.pallet_id === pid), 'alguna línea perdió el pallet');
  assert.deepEqual(it.map((f) => f.presentacion).sort(), ['Carton', 'IFCO']);
  assert.equal(palletResumen(db, pid).bultos, 0);
});

test('un pallet ABIERTO no se agrega: primero se cierra', () => {
  // Cerrarlo le pone el número y le saca el tarjetón, que es con lo que después
  // se controla el camión. Sin eso el camión lleva un bulto sin identificar.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 60, '1');
  const pid = palletAbierto(db).id;
  const d = abrirDespacho(db, { fecha: F });
  const r = agregarPalletAlDespacho(db, d.id, pid);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /cerralo primero/i, r.motivo);
  assert.match(r.motivo, /tarjetón|número/i, 'no dice para qué sirve cerrarlo');
  assert.equal(itemsDelDespacho(db, d.id).length, 0);
});

test('EL MISMO PALLET NO ENTRA DOS VECES en el mismo despacho', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const pid = palletCon(db, a, 60, '1');
  const d = abrirDespacho(db, { fecha: F });
  assert.equal(agregarPalletAlDespacho(db, d.id, pid).ok, true);
  const r = agregarPalletAlDespacho(db, d.id, pid);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /ya está en este despacho/i, r.motivo);
  assert.equal(itemsDelDespacho(db, d.id).length, 1, 'duplicó las líneas');
});

test('ni en otro, y dice en cuál está', () => {
  // Sin el número, el que lo intenta tiene que abrir los despachos de a uno.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const pid = palletCon(db, a, 60, '1');
  const uno = abrirDespacho(db, { fecha: F });
  agregarPalletAlDespacho(db, uno.id, pid);
  emitirDespacho(db, uno.id);

  const dos = abrirDespacho(db, { fecha: F });
  const r = agregarPalletAlDespacho(db, dos.id, pid);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /DG-26-00001/, 'no dice en qué despacho está: ' + r.motivo);
  assert.equal(r.ya_en, uno.id);
});

test('pero si ese despacho se ANULÓ, el pallet vuelve a estar libre', () => {
  // Anular devuelve las cajas al stock: si el pallet quedara trabado, la fruta
  // estaría en la cámara y no habría forma de volver a despacharla.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const pid = palletCon(db, a, 60, '1');
  const uno = abrirDespacho(db, { fecha: F });
  agregarPalletAlDespacho(db, uno.id, pid);
  emitirDespacho(db, uno.id);
  anularDespacho(db, uno.id, 'no vino el camión');

  assert.equal(palletResumen(db, pid).bultos, 60, 'las cajas no volvieron al pallet');
  const dos = abrirDespacho(db, { fecha: F });
  const r = agregarPalletAlDespacho(db, dos.id, pid);
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.bultos, 60);
});

test('UN PALLET CERRADO AL QUE LE BORRARON LAS CARGAS NO SE AGREGA EN SILENCIO', () => {
  /* Lo pidió la prueba de mutación: sin el corte, el bucle no inserta nada y la
     función contesta que sí, con cero cajas. El despacho se queda con un pallet que
     no está y nadie se entera hasta que el camión llega con un bulto de menos.

     Y es alcanzable: borrarProceso() no mira si el pallet está cerrado. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const pid = palletCon(db, a, 60, '1');
  const carga = db.prepare("SELECT id FROM gal_procesos WHERE tipo = 'ingreso'").get();
  borrarProceso(db, carga.id);
  assert.equal(palletResumen(db, pid).bultos, 0);

  const d = abrirDespacho(db, { fecha: F });
  const r = agregarPalletAlDespacho(db, d.id, pid);
  assert.equal(r.ok, false, 'agregó un pallet vacío y dijo que sí');
  assert.match(r.motivo, /no tiene nada adentro/i);
  assert.equal(itemsDelDespacho(db, d.id).length, 0);
});

test('un mixto con uuid entra entero: el uuid es del pedido, no del renglón', () => {
  /* uuid es UNIQUE. Si fuera a las dos líneas, un pallet de dos artículos reventaría
     contra el índice y el operador vería «se rompió» en vez de su pallet cargado. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const b = art(db, 'IFCO', '60/70');
  entra(db, a, 40, '1');
  entra(db, b, 20, '2', 11);
  const pid = palletAbierto(db).id;
  cerrarPallet(db, pid, {});

  const d = abrirDespacho(db, { fecha: F });
  const r = agregarPalletAlDespacho(db, d.id, pid, { uuid: 'clic-1' });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(itemsDelDespacho(db, d.id).length, 2);
  const conUuid = itemsDelDespacho(db, d.id).filter((f) => f.uuid === 'clic-1');
  assert.equal(conUuid.length, 1, 'el uuid se repitió en las dos líneas');
});

test('un despacho ya emitido no recibe pallets', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const uno = palletCon(db, a, 60, '1');
  const dos = palletCon(db, a, 40, '2');
  const d = abrirDespacho(db, { fecha: F });
  agregarPalletAlDespacho(db, d.id, uno);
  emitirDespacho(db, d.id);
  const r = agregarPalletAlDespacho(db, d.id, dos);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /emitido/);
});

test('un pallet que no existe, y un id cualquiera, contestan sin romperse', () => {
  const db = base();
  const d = abrirDespacho(db, { fecha: F });
  assert.equal(agregarPalletAlDespacho(db, d.id, 999).ok, false);
  assert.equal(agregarPalletAlDespacho(db, d.id, 'hola').ok, false);
  assert.equal(agregarPalletAlDespacho(db, 999, 1).ok, false);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · Y SALE ENTERO TAMBIÉN
// ══════════════════════════════════════════════════════════════════════════
test('SACAR EL PALLET SACA TODAS SUS LÍNEAS Y DEVUELVE EL STOCK', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const b = art(db, 'IFCO', '60/70');
  entra(db, a, 40, '1');
  entra(db, b, 20, '2', 11);
  const pid = palletAbierto(db).id;
  cerrarPallet(db, pid, {});

  const d = abrirDespacho(db, { fecha: F });
  agregarPalletAlDespacho(db, d.id, pid);
  assert.equal(itemsDelDespacho(db, d.id).length, 2);

  const r = sacarPalletDelDespacho(db, d.id, pid);
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.lineas, 2, 'sacó una sola línea de un pallet de dos artículos');
  assert.equal(itemsDelDespacho(db, d.id).length, 0);
  assert.equal(palletResumen(db, pid).bultos, 60, 'las cajas no volvieron al pallet');
  assert.equal(r.despacho.bultos, 0);
});

test('NO SE SACA UN RENGLÓN SUELTO DE UN PALLET: dejaría medio pallet arriba', () => {
  /* Es la puerta de atrás de la regla. Un mixto son varios renglones y sacar uno
     deja el camión con una parte del pallet y el tarjetón diciendo el total. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const b = art(db, 'IFCO', '60/70');
  entra(db, a, 40, '1');
  entra(db, b, 20, '2', 11);
  const pid = palletAbierto(db).id;
  cerrarPallet(db, pid, {});

  const d = abrirDespacho(db, { fecha: F });
  agregarPalletAlDespacho(db, d.id, pid);
  const uno = itemsDelDespacho(db, d.id)[0];
  const r = sacarDelDespacho(db, uno.id);
  assert.equal(r.ok, false, 'sacó un renglón suelto de un pallet');
  assert.equal(r.pallet_id, pid);
  assert.match(r.motivo, /PC-26-00001/, 'no dice de qué pallet es: ' + r.motivo);
  assert.match(r.motivo, /entero/i);
  assert.equal(itemsDelDespacho(db, d.id).length, 2);
});

test('pero un renglón del piso se saca de a uno, como siempre', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  suelto(db, a, 40, '1');
  const d = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 10 });
  const uno = itemsDelDespacho(db, d.id)[0];
  assert.equal(sacarDelDespacho(db, uno.id).ok, true);
  assert.equal(itemsDelDespacho(db, d.id).length, 0);
});

test('sacar un pallet que no está en ese despacho lo dice', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const pid = palletCon(db, a, 60, '1');
  const d = abrirDespacho(db, { fecha: F });
  const r = sacarPalletDelDespacho(db, d.id, pid);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no está en este despacho/i);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LA PUERTA DE ATRÁS: REABRIR
// ══════════════════════════════════════════════════════════════════════════
test('UN PALLET QUE ESTÁ EN UN DESPACHO NO SE REABRE', () => {
  /* Reabrirlo lo devuelve al piso, y entonces el remito pasa a llevar cajas
     sueltas donde decía un pallet — con el tarjetón ya impreso y pegado. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const pid = palletCon(db, a, 60, '1');
  const d = abrirDespacho(db, { fecha: F });
  agregarPalletAlDespacho(db, d.id, pid);
  const r = reabrirPallet(db, pid);
  assert.equal(r.ok, false, 'reabrió un pallet que está en un remito');
  assert.match(r.motivo, /despacho/i);
  assert.equal(palletResumen(db, pid).estado, 'cerrado');
});

test('sacado del despacho, sí se reabre — y ahí sí se lo puede partir', () => {
  /* Éste es el camino cuando de verdad hay que llevar una parte: se reabre, se
     sacan las cajas —vuelven al piso— y se cierra. La regla no es una pared. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const pid = palletCon(db, a, 60, '1');
  const d = abrirDespacho(db, { fecha: F });
  agregarPalletAlDespacho(db, d.id, pid);
  sacarPalletDelDespacho(db, d.id, pid);
  const r = reabrirPallet(db, pid);
  assert.equal(r.ok, true, r.motivo);
  // Abierto = piso: desde acá se despacha la cantidad que haga falta.
  assert.equal(pisoParaDespacho(db)[0].bultos, 60);
  const r2 = agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 20 });
  assert.equal(r2.ok, true, r2.motivo);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · LO QUE LLEVA EL CAMIÓN, COMO SE CARGA
// ══════════════════════════════════════════════════════════════════════════
test('LAS UNIDADES SON LOS BULTOS QUE ALGUIEN SUBE, no los artículos', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const b = art(db, 'IFCO', '60/70');
  // Un pallet mixto de dos artículos, otro simple, y algo suelto.
  entra(db, a, 40, '1');
  entra(db, b, 20, '2', 11);
  const uno = palletAbierto(db).id;
  cerrarPallet(db, uno, {});
  const dos = palletCon(db, a, 30, '3');
  suelto(db, a, 15, '4');

  const d = abrirDespacho(db, { fecha: F });
  agregarPalletAlDespacho(db, d.id, uno);
  agregarPalletAlDespacho(db, d.id, dos);
  agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 15 });

  // Cuatro líneas de artículo, pero TRES cosas que subir al camión.
  assert.equal(itemsDelDespacho(db, d.id).length, 4);
  const u = unidadesDelDespacho(db, d.id);
  assert.equal(u.length, 3);
  assert.deepEqual(u.map((x) => x.tipo), ['pallet', 'pallet', 'piso']);
  assert.equal(u[0].numero, 'PC-26-00001');
  assert.equal(u[0].articulos, 2);
  assert.equal(u[0].bultos, 60);
  assert.equal(u[0].lineas.length, 2);
  assert.equal(u[1].bultos, 30);
  assert.equal(u[2].bultos, 15);
  // Y los totales no cambian por agrupar: es la misma plata contada igual.
  assert.equal(u.reduce((t, x) => t + x.bultos, 0), 105);
});

test('lo que salió de un pallet ABIERTO cuenta como piso', () => {
  // Ahí no había ninguna unidad: eran cajas apiladas que alguien va a subir a
  // mano. Agruparlas bajo un número de pallet que no existe sería inventarlo.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 40, '1');
  const d = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 10 });
  const u = unidadesDelDespacho(db, d.id);
  assert.equal(u.length, 1);
  assert.equal(u[0].tipo, 'piso');
});

test('un despacho sin nada no tiene unidades', () => {
  const db = base();
  const d = abrirDespacho(db, { fecha: F });
  assert.deepEqual(unidadesDelDespacho(db, d.id), []);
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · LA PANTALLA
// ══════════════════════════════════════════════════════════════════════════
const leer = (r) => fs.readFileSync(fileURLToPath(new URL(r, import.meta.url)), 'utf8');
const PANEL = leer('../src/panel.html');
const SVC = leer('../src/servicios/galpon.js');
const RUTA = leer('../src/rutas/galpon.js');
const MODAL = PANEL.slice(PANEL.indexOf('id="gal-dsp-modal"'),
                          PANEL.indexOf('id="gal-proc-modal"'));

test('LA VENTANA TIENE LAS DOS PUERTAS', () => {
  assert.match(MODAL, /Un pallet entero/);
  assert.match(MODAL, /Del piso/);
  assert.match(MODAL, /id="gal-dsp-pal"/, 'no está el selector de pallets');
  assert.match(MODAL, /id="gal-dsp-item"/, 'no está el selector del piso');
});

test('EL PALLET NO TIENE CASILLERO DE CANTIDAD', () => {
  /* Es la regla hecha pantalla: si hubiera dónde escribir «60», alguien lo iba a
     escribir y el servidor tendría que contestarle que no. */
  const pal = MODAL.slice(MODAL.indexOf('Un pallet entero'), MODAL.indexOf('Del piso'));
  assert.ok(!/type="number"/.test(pal), 'el pallet tiene casillero de cantidad');
  assert.match(pal, /galDspAgregarPallet\(\)/);
  // Y el del piso sí lo tiene.
  const piso = MODAL.slice(MODAL.indexOf('Del piso'));
  assert.match(piso, /id="gal-dsp-cant"/);
});

test('la ventana explica cómo partir un pallet de verdad', () => {
  // Sin esto la regla es una pared y el operador se queda sin salida: la
  // salida existe y es reabrir, sacar y cerrar.
  assert.match(MODAL, /reabre<\/b>/);
  assert.match(MODAL, /vuelven al piso/);
});

test('el selector de pallets avisa cuando no hay ninguno', () => {
  // Un selector vacío sin texto parece una pantalla rota.
  const js = PANEL.slice(PANEL.indexOf('function galDspPintar()'),
                         PANEL.indexOf('function galDspPalPick()'));
  assert.match(js, /No hay pallets cerrados con stock/);
});

test('LA TABLA AGRUPA POR UNIDAD Y EL PALLET TIENE UNA SOLA ×', () => {
  const js = PANEL.slice(PANEL.indexOf('function galDspItems()'),
                         PANEL.indexOf('async function galDspGuardar()'));
  assert.match(js, /x\.unidades\|\|\[\]/, 'la tabla sigue pintando los items sueltos');
  assert.match(js, /galDspSacarPallet\(/, 'no hay manera de sacar el pallet entero');
  assert.match(js, /f\.tipo==='pallet'/);
});

test('y la tabla del despacho no tiene barra lateral', () => {
  // CLAUDE.md: ninguna pantalla ni modal del proyecto.
  const js = PANEL.slice(PANEL.indexOf('function galDspItems()'),
                         PANEL.indexOf('async function galDspGuardar()'));
  assert.match(js, /table-layout:fixed/);
  const cols = [...js.matchAll(/<col style="width:(\d+)%"/g)].map((m) => Number(m[1]));
  const ths = (js.match(/<th[ >]/g) || []).length;
  assert.equal(cols.length, ths, 'hay ' + cols.length + ' columnas y ' + ths + ' títulos');
  assert.equal(cols.reduce((t, x) => t + x, 0), 100,
    'los anchos suman ' + cols.reduce((t, x) => t + x, 0));
});

// ══════════════════════════════════════════════════════════════════════════
// 8 · EL MANUAL CONTRA EL CÓDIGO
// ══════════════════════════════════════════════════════════════════════════
const dice = (re, que) => assert.match(PANEL, re, 'el manual no dice: ' + (que || re));

test('el manual explica las dos maneras, con su versión', () => {
  dice(/Un pallet entero, o 🧺 del piso <span class="ver">V1143<\/span>/);
  dice(/no puede cargarse sólo una/);
});

test('el manual dice que el pallet no tiene cantidad, y no la tiene', () => {
  dice(/no tiene casillero '/);
  assert.match(SVC, /export function agregarPalletAlDespacho\(db, despachoId, palletId, d\)/);
  // La firma no recibe cantidad: lo que entra es lo que el pallet tiene adentro.
  assert.match(SVC, /const lineas = lineasDePalletParaSalida\(db, pid\);/);
});

test('el manual dice que el piso incluye el pallet abierto, y el SQL lo hace', () => {
  dice(/lo que está en un pallet todavía '/);
  assert.match(SVC, /p\.estado = 'abierto'\)";/,
    'el SQL del piso no deja entrar al pallet abierto');
});

test('el manual dice que sólo salen los cerrados, y la lista los filtra', () => {
  dice(/sólo salen los cerrados/);
  assert.match(SVC, /AND estado = 'cerrado'"/);
});

test('el manual dice que se reabre para partirlo, y reabrir lo devuelve al piso', () => {
  dice(/se <b>reabre<\/b> el '/);
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const pid = palletCon(db, a, 60, '1');
  assert.deepEqual(pisoParaDespacho(db), []);
  reabrirPallet(db, pid);
  assert.equal(pisoParaDespacho(db)[0].bultos, 60, 'reabrir no devolvió las cajas al piso');
});

test('las dos rutas del pallet existen', () => {
  assert.match(RUTA, /router\.post\('\/despachos\/:id\/pallets'/);
  assert.match(RUTA, /router\.delete\('\/despachos\/:id\/pallets\/:palletId'/);
  assert.match(RUTA, /piso: pisoParaDespacho\(db/);
  assert.match(RUTA, /pallets: palletsParaDespacho\(db/);
});
