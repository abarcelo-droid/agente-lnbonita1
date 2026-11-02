// ══ 🧱 ARMAR UN PALLET CON LO QUE YA ESTÁ EN CÁMARA ═════════════════════════
//
// Andy, 1/11/2026: «necesito un lugar donde pueda hacer cierre de pallet de
// mercadería que está suelta en el stock, donde puedo agarrar pallets mixtos
// y todo».
//
// UN PALLET ES UNA UBICACIÓN, NO UN MOVIMIENTO: armarlo no saca ni agrega una
// sola caja. Lo que se clava acá, en orden de qué duele más:
//
//   1. QUE EL STOCK CAMBIE AL ARMAR. Mover cajas de un lado al otro de la
//      cámara no puede inventar ni perder ninguna. Es la invariante del
//      módulo entero y se verifica en cada test.
//   2. QUE PARTIR UNA FILA PIERDA KILOS. 267 cajas que se parten en 207 + 60
//      tienen que seguir pesando lo mismo, al centavo de kilo.
//   3. MOVER MÁS DE LO QUE HAY. Un pallet con cajas que no existen se
//      descubre cuando lo van a cargar al camión.
//   4. QUE EL PALLET ARMADO SE LLEVE LA CARGA DEL DÍA SIGUIENTE. El del
//      proceso se abre solo con la primera caja; si el armado se cuela en esa
//      búsqueda, la cosecha de mañana entra en el pallet de ayer.
//   5. SACARLE CAJAS A UN PALLET CERRADO SIN AVISAR. Queda distinto de su
//      tarjetón, que ya está impreso y pegado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  guardarPresentacion, registrarProceso, stockGalpon, stockPorPresentacion,
  palletAbierto, cerrarPallet, reabrirPallet, contenidoDelPallet,
  stockParaArmar, palletsArmados, abrirPalletArmado, moverAlPallet,
  sacarDelPalletArmado, lineasDelPallet, palletResumen,
  abrirDespacho, agregarAlDespacho, emitirDespacho,
} from '../src/servicios/galpon.js';

const F = '2026-12-15';

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
      sector_id INTEGER, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca) VALUES
      (10,'11-12 y 16-17','El Abuelo'), (11,'13','El Abuelo');
    CREATE TABLE pa_sectores (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT);
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER,
      cultivo TEXT, campaña TEXT, es_perenne INTEGER DEFAULT 0);
    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
    INSERT INTO gal_config (clave,valor) VALUES ('pallet_prefijo','PC'),
      ('despacho_prefijo','DG');
    CREATE TABLE gal_volcados (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT,
      lote_id INTEGER, lote_nombre TEXT, producto TEXT, kilos REAL, ifcos INTEGER,
      eliminado_en TEXT);
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
  `);
  return db;
}

const art = (db, nombre, calibre, kg) => guardarPresentacion(db, {
  nombre, destino: 'comercial', envase: 'Caja', por_bulto: 1,
  kg_unidad: kg == null ? 8 : kg, calibre, categoria: 'I' }).id;

const entra = (db, a, cajas, u, lote) => registrarProceso(db,
  { fecha: F, lote_id: lote || 10, presentacion_id: a, bultos: cajas, uuid: u });

// LA INVARIANTE DEL MÓDULO: armar un pallet no cambia el stock. Se mide antes y
// después de cada movimiento, porque es lo único que no puede fallar nunca.
const stock = (db) => {
  const s = stockGalpon(db, {});
  return { kilos: s.kilos,
           bultos: s.destinos.reduce((t, d) => t + (Number(d.bultos) || 0), 0) };
};

// ══════════════════════════════════════════════════════════════════════════
// 1 · EL STOCK NO CAMBIA
// ══════════════════════════════════════════════════════════════════════════
test('ARMAR UN PALLET NO MUEVE EL STOCK: ni una caja', () => {
  const db = base();
  const a = art(db, 'Carton Amarilla', '50/55');
  entra(db, a, 267, '1');
  const antes = stock(db);

  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 60,
    pallet_id: palletAbierto(db) ? null : null });
  // Las cajas están en el pallet del día, así que hay que decir de dónde salen.
  assert.equal(r.ok, false, 'tomó de una ubicación que no se nombró');

  const delDia = db.prepare("SELECT id FROM gal_pallets WHERE origen = 'proceso'").get();
  const r2 = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 60, pallet_id: delDia.id });
  assert.equal(r2.ok, true, r2.motivo);
  assert.deepEqual(stock(db), antes, 'el stock cambió al mover cajas de lugar');
});

test('PARTIR UNA FILA NO PIERDE NI INVENTA KILOS', () => {
  // 267 cajas de 7,7 kg son 2.055,9. Partidas en 207 + 60 tienen que seguir
  // pesando 2.055,9, no 2.055,8 ni 2.056.
  const db = base();
  const a = art(db, 'Carton', '50/55', 7.7);
  entra(db, a, 267, '1');
  const antes = stock(db);
  const delDia = palletAbierto(db).id;

  const p = abrirPalletArmado(db, { fecha: F });
  assert.equal(moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 60, pallet_id: delDia }).ok, true);

  assert.deepEqual(stock(db), antes);
  const enPallet = contenidoDelPallet(db, p.id);
  assert.equal(enPallet[0].bultos, 60);
  assert.equal(enPallet[0].kilos, 462);                 // 60 × 7,7
  assert.equal(contenidoDelPallet(db, delDia)[0].bultos, 207);
  assert.equal(contenidoDelPallet(db, delDia)[0].kilos, 1593.9);
  // Y las dos partes suman exactamente lo de antes.
  assert.equal(round2(462 + 1593.9), antes.kilos);
});
const round2 = (n) => Math.round(n * 100) / 100;

test('LA PARTE QUE SE VA APUNTA A LA CARGA ORIGINAL', () => {
  // Sin partido_de, una fila de 60 cajas con fecha del 15 es indistinguible de
  // una carga que nunca existió: el rinde de ese día sale igual pero no hay
  // forma de reconstruir qué pasó.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  const uno = entra(db, a, 267, '1');
  const delDia = palletAbierto(db).id;
  const p = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 60, pallet_id: delDia });

  const l = lineasDelPallet(db, p.id);
  assert.equal(l.length, 1);
  assert.equal(l[0].partido_de, uno.id, 'la parte movida no dice de dónde salió');
  // Y si esa parte se vuelve a partir, sigue apuntando a la ORIGINAL y no a la
  // parte: una cadena de partido_de no se puede seguir hasta el principio.
  const q = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, q.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 20, pallet_id: p.id });
  assert.equal(lineasDelPallet(db, q.id)[0].partido_de, uno.id);
});

test('mover la fila ENTERA no la parte', () => {
  // Partir una fila de 40 para llevarse 40 dejaría una de cero dando vueltas.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 40, '1');
  const delDia = palletAbierto(db).id;
  const p = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40, pallet_id: delDia });

  assert.equal(lineasDelPallet(db, p.id).length, 1);
  assert.equal(lineasDelPallet(db, p.id)[0].partido_de, null, 'partió una fila entera');
  assert.equal(contenidoDelPallet(db, delDia).length, 0, 'quedó una fila en cero');
});

test('toma de VARIAS filas cuando una sola no alcanza, de la más vieja', () => {
  // En una cámara lo que entró antes sale antes, y si hay que partir algo
  // conviene que sea lo más nuevo.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  registrarProceso(db, { fecha: '2026-12-10', lote_id: 10, presentacion_id: a,
    bultos: 30, uuid: '1' });
  registrarProceso(db, { fecha: '2026-12-14', lote_id: 10, presentacion_id: a,
    bultos: 50, uuid: '2' });
  const antes = stock(db);
  const delDia = palletAbierto(db).id;

  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 45, pallet_id: delDia });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.movidas, 2, 'no tomó de las dos filas');
  assert.deepEqual(stock(db), antes);
  assert.equal(contenidoDelPallet(db, p.id)[0].bultos, 45);
  // La del 10 se fue entera (30) y de la del 14 salieron 15: queda 35.
  assert.equal(contenidoDelPallet(db, delDia)[0].bultos, 35);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · NO SE MUEVE MÁS DE LO QUE HAY
// ══════════════════════════════════════════════════════════════════════════
test('NO SE MUEVE MÁS DE LO QUE HAY, y dice cuánto', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 40, '1');
  const antes = stock(db);
  const delDia = palletAbierto(db).id;
  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 41, pallet_id: delDia });
  assert.equal(r.ok, false, 'movió 41 cajas de un montón de 40');
  assert.equal(r.disponible, 40);
  assert.deepEqual(stock(db), antes);
  assert.equal(contenidoDelPallet(db, p.id).length, 0);
});

test('de una ubicación sólo sale lo que hay EN ESA ubicación', () => {
  // 40 en el pallet del día y 40 sueltas no son 80 disponibles desde el pallet:
  // el que arma está parado frente a un montón, no frente al total.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 40, '1');
  const delDia = palletAbierto(db).id;
  cerrarPallet(db, delDia, {});
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40,
    uuid: '2', sin_pallet: 1 });

  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 80, pallet_id: delDia });
  assert.equal(r.ok, false);
  assert.equal(r.disponible, 40, 'sumó lo suelto a lo del pallet');
});

test('un destino o un lote que no existe en esa ubicación se rechaza', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 40, '1');
  const p = abrirPalletArmado(db, { fecha: F });
  const l = { destino: 'comercial', presentacion_id: a, calibre: '50/55', bultos: 10 };
  assert.equal(moverAlPallet(db, p.id, Object.assign({}, l, { lote_id: 11 })).ok, false);
  assert.equal(moverAlPallet(db, p.id, Object.assign({}, l, { lote_id: 10,
    destino: 'chirimbolo' })).ok, false);
  assert.equal(moverAlPallet(db, 9999, Object.assign({}, l, { lote_id: 10 })).ok, false);
  assert.equal(contenidoDelPallet(db, p.id).length, 0);
});

test('cantidad en cero o negativa no mueve nada', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 40, '1');
  const delDia = palletAbierto(db).id;
  const p = abrirPalletArmado(db, { fecha: F });
  for (const b of [0, -5, null]) {
    assert.equal(moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
      presentacion_id: a, calibre: '50/55', bultos: b, pallet_id: delDia }).ok, false);
  }
  assert.equal(contenidoDelPallet(db, p.id).length, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL ARMADO NO SE MEZCLA CON EL DEL DÍA
// ══════════════════════════════════════════════════════════════════════════
test('UN PALLET ARMADO ABIERTO NO SE LLEVA LA CARGA DEL DÍA SIGUIENTE', () => {
  // palletAbierto() devuelve el último abierto y la primera caja de la mañana
  // entra ahí. Si el armado entrara en esa búsqueda, la cosecha de mañana
  // aparecería adentro de un pallet que alguien dejó a medio armar ayer.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 40, '1');
  const delDia = palletAbierto(db).id;
  const arm = abrirPalletArmado(db, { fecha: F });

  assert.equal(palletAbierto(db).id, delDia, 'el armado se puso de pallet del día');
  entra(db, a, 10, '2');
  assert.equal(contenidoDelPallet(db, arm.id).length, 0,
    'la carga nueva entró al pallet armado');
  assert.equal(contenidoDelPallet(db, delDia)[0].bultos, 50);
});

test('puede haber VARIOS pallets armados abiertos a la vez', () => {
  // Se arman tres para un camión y se llenan en paralelo, que es como se
  // trabaja en el playón. El del proceso es uno solo porque ahí la caja cae
  // sola y tiene que haber un único lugar donde caiga.
  const db = base();
  const uno = abrirPalletArmado(db, { fecha: F });
  const dos = abrirPalletArmado(db, { fecha: F });
  assert.notEqual(uno.id, dos.id);
  assert.equal(palletsArmados(db, { estado: 'abierto' }).length, 2);
});

test('los armados no aparecen en la lista del pallet del día, ni al revés', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 40, '1');
  abrirPalletArmado(db, { fecha: F });
  const arm = palletsArmados(db, {});
  assert.equal(arm.length, 1);
  assert.equal(arm[0].origen, 'armado');
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · DESARMAR UNO CERRADO
// ══════════════════════════════════════════════════════════════════════════
test('SACARLE CAJAS A UN PALLET CERRADO LO DICE, con lo que le queda', () => {
  // Queda distinto de su tarjetón, que ya está impreso y pegado. El que lo
  // hizo tiene que enterarse en el momento y no cuando llega el camión.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
  const delDia = palletAbierto(db).id;
  const cer = cerrarPallet(db, delDia, {});
  assert.equal(cer.numero, 'PC-26-00001');

  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 60, pallet_id: delDia });
  assert.equal(r.ok, true, r.motivo);
  assert.ok(r.desde, 'no dijo de dónde salieron');
  assert.equal(r.desde.numero, 'PC-26-00001');
  assert.equal(r.desde.bultos, 40, 'no dijo cuánto le quedó');
  assert.equal(r.desde.vacio, false);
});

test('y si lo deja VACÍO también lo dice', () => {
  // Un pallet cerrado sin nada adentro es una etiqueta pegada a un armazón de
  // madera: hay que ir a despegarla.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 40, '1');
  const delDia = palletAbierto(db).id;
  cerrarPallet(db, delDia, {});
  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40, pallet_id: delDia });
  assert.equal(r.desde.vacio, true);
  assert.equal(r.desde.bultos, 0);
  // Y el número NO se libera: ese pallet existió y su etiqueta anduvo dando
  // vueltas.
  assert.equal(r.desde.numero, 'PC-26-00001');
});

test('a un pallet CERRADO no se le agrega: hay que reabrirlo', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
  const delDia = palletAbierto(db).id;
  const p = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40, pallet_id: delDia });
  cerrarPallet(db, p.id, {});

  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 10, pallet_id: delDia });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /cerrado/);
  assert.equal(contenidoDelPallet(db, p.id)[0].bultos, 40);

  reabrirPallet(db, p.id);
  assert.equal(moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 10, pallet_id: delDia }).ok, true);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · SACAR DEL PALLET
// ══════════════════════════════════════════════════════════════════════════
test('sacar una línea la devuelve al suelto, sin tocar el stock', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
  const antes = stock(db);
  const delDia = palletAbierto(db).id;
  const p = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40, pallet_id: delDia });

  const linea = lineasDelPallet(db, p.id)[0];
  assert.equal(sacarDelPalletArmado(db, linea.id).ok, true);
  assert.deepEqual(stock(db), antes);
  assert.equal(contenidoDelPallet(db, p.id).length, 0);
  // Queda suelta, lista para armar otro.
  const suelto = stockParaArmar(db).filter((x) => x.ubicacion === 'suelto');
  assert.equal(suelto.length, 1);
  assert.equal(suelto[0].bultos, 40);
});

test('no se saca de un pallet cerrado, ni algo que ya está suelto', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
  const delDia = palletAbierto(db).id;
  const p = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40, pallet_id: delDia });
  const linea = lineasDelPallet(db, p.id)[0];
  cerrarPallet(db, p.id, {});

  assert.equal(sacarDelPalletArmado(db, linea.id).ok, false);
  reabrirPallet(db, p.id);
  assert.equal(sacarDelPalletArmado(db, linea.id).ok, true);
  assert.equal(sacarDelPalletArmado(db, linea.id).ok, false, 'sacó algo ya suelto');
  assert.equal(sacarDelPalletArmado(db, 9999).ok, false);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · UN PALLET MIXTO, DE PUNTA A PUNTA
// ══════════════════════════════════════════════════════════════════════════
test('UN PALLET MIXTO CON TRES ORÍGENES, Y EL STOCK INTACTO', () => {
  // El caso de Andy: juntar lo que quedó de varias tandas y de dos lotes en un
  // pallet para el camión.
  const db = base();
  const a = art(db, 'Carton Amarilla', '50/55', 7.7);
  const b = art(db, 'IFCO', null, 13.9);
  entra(db, a, 267, '1', 10);
  entra(db, a, 17, '2', 11);
  entra(db, b, 49, '3', 10);
  const antes = stock(db);
  const delDia = palletAbierto(db).id;

  const p = abrirPalletArmado(db, { fecha: F, observacion: 'Para el camión del jueves' });
  for (const l of [
    { lote_id: 10, presentacion_id: a, calibre: '50/55', bultos: 60 },
    { lote_id: 11, presentacion_id: a, calibre: '50/55', bultos: 17 },
    { lote_id: 10, presentacion_id: b, calibre: '', bultos: 20 },
  ]) {
    const r = moverAlPallet(db, p.id, Object.assign({ destino: 'comercial',
      pallet_id: delDia }, l));
    assert.equal(r.ok, true, r.motivo);
  }

  assert.deepEqual(stock(db), antes, 'armar el pallet movió el stock');
  const cont = contenidoDelPallet(db, p.id);
  assert.equal(cont.length, 3, 'no quedaron las tres líneas');
  assert.equal(round2(cont.reduce((t, x) => t + x.bultos, 0)), 97);

  // Y al cerrarlo sale MIXTO solo, porque adentro hay más de un artículo.
  const cer = cerrarPallet(db, p.id, { parcial: 1 });
  assert.equal(cer.ok, true, cer.motivo);
  assert.equal(cer.pallet.mixto, 1);
  assert.equal(cer.pallet.bultos, 97);
  assert.equal(cer.numero, 'PC-26-00001');
  assert.deepEqual(stock(db), antes, 'cerrarlo movió el stock');
});

test('Y DESPACHARLO SÍ SACA DEL STOCK: es el único que lo hace', () => {
  // Armar mueve de lugar; despachar saca. Si armar también sacara, la cámara
  // quedaría vacía con toda la fruta adentro.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
  const antes = stock(db);
  const delDia = palletAbierto(db).id;
  const p = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40, pallet_id: delDia });
  cerrarPallet(db, p.id, {});
  assert.deepEqual(stock(db), antes);

  const d = abrirDespacho(db, { fecha: F, destinatario: 'San Gerónimo' });
  assert.equal(agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 }).ok, true);
  emitirDespacho(db, d.id);
  assert.equal(stock(db).bultos, 60, 'el despacho no descontó');
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · LO QUE SE OFRECE PARA ARMAR
// ══════════════════════════════════════════════════════════════════════════
test('el stock para armar dice EN QUÉ PALLET está cada cosa', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
  const delDia = palletAbierto(db).id;
  cerrarPallet(db, delDia, {});
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 30,
    uuid: '2', sin_pallet: 1 });

  const s = stockParaArmar(db);
  assert.equal(s.length, 2, 'no separó por ubicación');
  const enPallet = s.filter((x) => x.pallet_id === delDia)[0];
  const suelto = s.filter((x) => !x.pallet_id)[0];
  assert.equal(enPallet.ubicacion, 'PC-26-00001');
  assert.equal(enPallet.bultos, 100);
  assert.equal(suelto.ubicacion, 'suelto');
  assert.equal(suelto.bultos, 30);
});

test('lo DESPACHADO no se ofrece para armar', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
  const delDia = palletAbierto(db).id;
  const d = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 100 });
  emitirDespacho(db, d.id);
  // Las filas de ingreso siguen ahí —la carga de ese día fue de 100— pero las
  // cajas están en un camión. El saldo por ubicación tiene que decirlo, y para
  // eso la salida lleva el pallet del que salió.
  assert.equal(stock(db).bultos, 0);
  assert.deepEqual(stockParaArmar(db).filter((x) => x.bultos > 0), [],
    'el armado ofrece cajas que ya se despacharon');

  // Y moverlas se FRENA: un pallet con cajas que están en un camión se
  // descubre cuando alguien va al playón a buscarlas.
  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 100, pallet_id: delDia });
  assert.equal(r.ok, false, 'movió al pallet cajas que ya se fueron');
  assert.equal(r.disponible, 0);
  assert.equal(stock(db).bultos, 0, 'mover cambió el stock');
});

test('LA SALIDA DICE DE QUÉ UBICACIÓN SALIÓ, y se parte si toca varias', () => {
  // Un despacho de 97 cajas puede llevarse 60 de un pallet y 37 de otro. Sin
  // esto el total del stock baja y las ubicaciones no, y son dos cuentas que
  // tienen que dar lo mismo.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 60, '1');
  const unoId = palletAbierto(db).id;
  cerrarPallet(db, unoId, {});
  entra(db, a, 40, '2');
  const dosId = palletAbierto(db).id;
  assert.notEqual(unoId, dosId);

  const d = abrirDespacho(db, { fecha: F });
  const r = agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 97 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.partes, 2, 'escribió una sola salida para dos ubicaciones');
  emitirDespacho(db, d.id);

  // El primero quedó vacío y el segundo con 3.
  assert.equal(palletResumen(db, unoId).bultos, 0);
  assert.equal(palletResumen(db, dosId).bultos, 3);
  assert.equal(stock(db).bultos, 3);
  // Y las ubicaciones suman exactamente el stock, que es la invariante.
  assert.equal(stockParaArmar(db).reduce((t, x) => t + x.bultos, 0), 3);
});
