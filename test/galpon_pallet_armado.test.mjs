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
//   5. SACARLE CAJAS A UN PALLET DESDE AFUERA. Andy, 5/11/2026: «tiene que
//      estar disponible solo lo que está SIN PALLET... sino va a quedar
//      duplicado». Un pallet es una pila física con su tarjetón pegado:
//      moverle cajas con el mouse no las baja de ahí, y quedan dos etiquetas
//      impresas reclamando las mismas sesenta cajas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  guardarPresentacion, registrarProceso, stockGalpon, stockPorPresentacion,
  palletAbierto, cerrarPallet, reabrirPallet, contenidoDelPallet,
  stockParaArmar, stockPorArticulo, enPallets, palletsArmados, abrirPalletArmado,
  moverAlPallet,
  sacarDelPalletArmado, lineasDelPallet, palletResumen,
  abrirDespacho, agregarAlDespacho, agregarPalletAlDespacho, emitirDespacho,
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
    -- El reparto por cuadrilla de cada carga. Un cajon puede ser de dos (V1133).
    CREATE TABLE gal_volcado_cuadrillas (
      volcado_id INTEGER NOT NULL, cuadrilla_id INTEGER NOT NULL,
      cuadrilla TEXT, kilos REAL NOT NULL,
      PRIMARY KEY (volcado_id, cuadrilla_id));
    CREATE TABLE gal_volcados (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT,
      lote_id INTEGER, lote_nombre TEXT, producto TEXT, kilos REAL, ifcos INTEGER, viaje INTEGER, sanitario TEXT,
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

/* LO QUE ENTRA SUELTO, sin caer en el pallet del día. La mayoría de los tests de
   mover cuentan lo que quedó suelto después, y con el pallet del día en el medio
   esa cuenta mezclaría dos cosas. */
const entra = (db, a, cajas, u, lote) => registrarProceso(db,
  { fecha: F, lote_id: lote || 10, presentacion_id: a, bultos: cajas, uuid: u,
    sin_pallet: 1 });

// Y lo que cae en el pallet del día, que es el camino normal de una carga.
const entraAlDia = (db, a, cajas, u, lote) => registrarProceso(db,
  { fecha: F, lote_id: lote || 10, presentacion_id: a, bultos: cajas, uuid: u });

// Lo que quedó SUELTO —en ningún pallet—, que es contra lo que se mide casi todo acá.
// Ojo: no es { suelto: true }, que desde la V1146 trae también lo de los pallets
// abiertos, incluido el que se está armando.
const piso = (db) => stockParaArmar(db).filter((x) => !x.pallet_id);

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
    presentacion_id: a, calibre: '50/55', bultos: 60 });
  assert.equal(r.ok, true, r.motivo);
  assert.deepEqual(stock(db), antes, 'el stock cambió al mover cajas de lugar');
  assert.equal(contenidoDelPallet(db, p.id)[0].bultos, 60);
});

test('PARTIR UNA FILA NO PIERDE NI INVENTA KILOS', () => {
  // 267 cajas de 7,7 kg son 2.055,9. Partidas en 207 + 60 tienen que seguir
  // pesando 2.055,9, no 2.055,8 ni 2.056.
  const db = base();
  const a = art(db, 'Carton', '50/55', 7.7);
  entra(db, a, 267, '1');
  const antes = stock(db);

  const p = abrirPalletArmado(db, { fecha: F });
  assert.equal(moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 60 }).ok, true);

  assert.deepEqual(stock(db), antes);
  const enPallet = contenidoDelPallet(db, p.id);
  assert.equal(enPallet[0].bultos, 60);
  assert.equal(enPallet[0].kilos, 462);                 // 60 × 7,7
  assert.equal(piso(db)[0].bultos, 207);
  assert.equal(piso(db)[0].kilos, 1593.9);
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
  const p = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 60 });

  const l = lineasDelPallet(db, p.id);
  assert.equal(l.length, 1);
  // El renglón agrupa, así que de qué carga salió se pregunta a la base.
  const parte = db.prepare('SELECT id, partido_de FROM gal_procesos WHERE pallet_id = ?')
    .get(p.id);
  assert.equal(parte.partido_de, uno.id, 'la parte movida no dice de dónde salió');

  /* Y si esa parte se vuelve a partir, sigue apuntando a la ORIGINAL y no a la
     parte: una cadena de partido_de no se puede seguir hasta el principio.

     Para que la parte sea lo único que queda en el piso hay que sacar las 207 del
     medio: desde la V1146 no se le saca nada a un pallet desde afuera, así que la
     parte vuelve al piso bajándola de su pallet, que es como se hace de verdad. */
  const q = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, q.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 207 });
  assert.equal(piso(db).length, 0, 'quedó algo más suelto que la parte');
  assert.equal(sacarDelPalletArmado(db, parte.id).ok, true);

  const r = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, r.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 20 });
  assert.equal(db.prepare('SELECT partido_de FROM gal_procesos WHERE pallet_id = ?')
    .get(r.id).partido_de, uno.id);
});

test('mover la fila ENTERA no la parte', () => {
  // Partir una fila de 40 para llevarse 40 dejaría una de cero dando vueltas.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 40, '1');
  const p = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });

  assert.equal(lineasDelPallet(db, p.id).length, 1);
  assert.equal(db.prepare('SELECT partido_de FROM gal_procesos WHERE pallet_id = ?')
    .get(p.id).partido_de, null, 'partió una fila entera');
  assert.equal(piso(db).length, 0, 'quedó una fila en cero');
});

test('toma de VARIAS filas cuando una sola no alcanza, de la más vieja', () => {
  // En una cámara lo que entró antes sale antes, y si hay que partir algo
  // conviene que sea lo más nuevo.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  registrarProceso(db, { fecha: '2026-12-10', lote_id: 10, presentacion_id: a,
    bultos: 30, uuid: '1', sin_pallet: 1 });
  registrarProceso(db, { fecha: '2026-12-14', lote_id: 10, presentacion_id: a,
    bultos: 50, uuid: '2', sin_pallet: 1 });
  const antes = stock(db);

  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 45 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.movidas, 2, 'no tomó de las dos filas');
  assert.deepEqual(stock(db), antes);
  assert.equal(contenidoDelPallet(db, p.id)[0].bultos, 45);
  // La del 10 se fue entera (30) y de la del 14 salieron 15: queda 35.
  assert.equal(piso(db).reduce((t, x) => t + x.bultos, 0), 35);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · NO SE MUEVE MÁS DE LO QUE HAY
// ══════════════════════════════════════════════════════════════════════════
test('NO SE MUEVE MÁS DE LO QUE HAY, y dice cuánto', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 40, '1');
  const antes = stock(db);
  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 41 });
  assert.equal(r.ok, false, 'movió 41 cajas de un montón de 40');
  assert.equal(r.disponible, 40);
  assert.deepEqual(stock(db), antes);
  assert.equal(contenidoDelPallet(db, p.id).length, 0);
});

test('NOMBRAR UN PALLET DE ORIGEN SE RECHAZA, y dice cuál y qué hacer', () => {
  /* Andy, 5/11/2026: «al momento de armar un pallet tiene que estar disponible
     solo lo que está SIN PALLET... sino va a quedar duplicado».

     Hasta la V1145 esto pasaba en verde y partía el pallet cerrado: las cajas
     cambiaban de pallet en la base sin que nadie las bajara de la pila, y quedaban
     dos tarjetones impresos reclamando las mismas. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entraAlDia(db, a, 40, '1');
  const delDia = palletAbierto(db).id;
  cerrarPallet(db, delDia, {});
  entra(db, a, 40, '2');

  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 10, pallet_id: delDia });
  assert.equal(r.ok, false, 'le sacó cajas a un pallet desde afuera');
  assert.equal(r.en_pallet, 1);
  assert.match(r.motivo, /PC-26-00001/, 'no dice de qué pallet: ' + r.motivo);
  assert.match(r.motivo, /reabrilo/, 'no dice que hay que reabrirlo: ' + r.motivo);
  assert.equal(palletResumen(db, delDia).bultos, 40, 'igual le sacó cajas');
  assert.equal(contenidoDelPallet(db, p.id).length, 0);

  // Y las 40 del piso entran sin decir nada.
  assert.equal(moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 }).ok, true);
});

test('de un pallet ABIERTO sí se toma: todavía no es una unidad', () => {
  /* Andy, 5/11/2026: «me tiene que aparecer solo lo que no tiene pallet
     cerrado». Uno abierto no tiene tarjetón que contradecir, y el del día es
     donde cae TODA carga de Proceso: excluirlo dejaba la lista vacía todo el día.
     Por los dos caminos: nombrándolo y sin nombrar nada. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entraAlDia(db, a, 40, '1');
  const delDia = palletAbierto(db).id;
  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 10, pallet_id: delDia });
  assert.equal(r.ok, true, r.motivo);
  const r2 = moverAlPallet(db, p.id, { destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 10 });
  assert.equal(r2.ok, true, r2.motivo);
  assert.equal(palletResumen(db, delDia).bultos, 20);
  assert.equal(contenidoDelPallet(db, p.id)[0].bultos, 20);
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
  const p = abrirPalletArmado(db, { fecha: F });
  for (const b of [0, -5, null]) {
    assert.equal(moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
      presentacion_id: a, calibre: '50/55', bultos: b }).ok, false);
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
  entraAlDia(db, a, 40, '1');
  const delDia = palletAbierto(db).id;
  const arm = abrirPalletArmado(db, { fecha: F });

  assert.equal(palletAbierto(db).id, delDia, 'el armado se puso de pallet del día');
  entraAlDia(db, a, 10, '2');
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
  entraAlDia(db, a, 40, '1');
  abrirPalletArmado(db, { fecha: F });
  const arm = palletsArmados(db, {});
  assert.equal(arm.length, 1);
  assert.equal(arm[0].origen, 'armado');
});

test('CON { todos } SALEN LOS DOS: es lo que hay en la cámara', () => {
  /* Desde la V1146 a un pallet no se le sacan cajas desde afuera, así que la
     única manera de desarmar uno es abrirlo. Si la pantalla de Stock lista sólo
     los armados, los del proceso no tienen desde dónde abrirse y su mercadería
     queda congelada hasta que alguien la despache entera. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entraAlDia(db, a, 40, '1');
  const delDia = palletAbierto(db).id;
  cerrarPallet(db, delDia, {});
  const arm = abrirPalletArmado(db, { fecha: F });

  const todos = palletsArmados(db, { todos: true });
  assert.deepEqual(todos.map((x) => x.id).sort((x, y) => x - y),
    [delDia, arm.id].sort((x, y) => x - y), 'no están los dos');
  assert.equal(todos.filter((x) => x.id === delDia)[0].origen, 'proceso');
  // El armado está VACÍO y aparece igual: es el que alguien acaba de empezar.
  assert.equal(todos.filter((x) => x.id === arm.id)[0].contenido.length, 0);
});

test('un pallet despachado entero DEJA DE FIGURAR en la cámara', () => {
  // Queda en cero. Listarlo para siempre convierte la lista de la cámara en el
  // historial de la temporada.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entraAlDia(db, a, 40, '1');
  const delDia = palletAbierto(db).id;
  cerrarPallet(db, delDia, {});
  assert.equal(palletsArmados(db, { todos: true }).length, 1);

  const d = abrirDespacho(db, { fecha: F });
  assert.equal(agregarPalletAlDespacho(db, d.id, delDia).ok, true);
  emitirDespacho(db, d.id);
  assert.equal(palletsArmados(db, { todos: true }).length, 0,
    'el pallet que se fue en el camión sigue en la lista de la cámara');
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · DESARMAR UNO CERRADO
// ══════════════════════════════════════════════════════════════════════════
test('DESARMAR UN PALLET CERRADO: reabrirlo, y recién ahí mover', () => {
  /* El camino honesto, y el único que hay desde la V1146. Reabrirlo es la
     decisión que se ve: deja de ser una unidad y su tarjetón pasa a ser papel
     para tirar. Sin reabrir, lo frena. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entraAlDia(db, a, 100, '1');
  const delDia = palletAbierto(db).id;
  const cer = cerrarPallet(db, delDia, {});
  assert.equal(cer.numero, 'PC-26-00001');
  const antes = stock(db);

  const p = abrirPalletArmado(db, { fecha: F });
  // 1 · De afuera no sale: no hay piso.
  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.en_pallet, 1, 'no distingue «no hay» de «está apilado»');
  assert.match(r.motivo, /100 cajas/, 'no dice cuántas hay apiladas: ' + r.motivo);

  // 2 · Reabierto, se ofrece y se mueve: no hace falta bajarlo a mano.
  assert.equal(reabrirPallet(db, delDia).ok, true);
  assert.equal(stockParaArmar(db, { suelto: true })[0].bultos, 100);
  assert.equal(moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 60 }).ok, true);
  assert.equal(contenidoDelPallet(db, p.id)[0].bultos, 60);
  assert.equal(palletResumen(db, delDia).bultos, 40);
  assert.deepEqual(stock(db), antes, 'desarmar movió el stock');
});

test('y el número del pallet desarmado NO se libera', () => {
  // Ese pallet existió y su etiqueta anduvo dando vueltas por el playón.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entraAlDia(db, a, 40, '1');
  const delDia = palletAbierto(db).id;
  cerrarPallet(db, delDia, {});
  reabrirPallet(db, delDia);
  sacarDelPalletArmado(db, lineasDelPallet(db, delDia)[0].ids[0]);
  assert.equal(palletResumen(db, delDia).vacio, true);
  assert.equal(palletResumen(db, delDia).numero, 'PC-26-00001');
});

test('a un pallet CERRADO no se le agrega: hay que reabrirlo', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
  const p = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  cerrarPallet(db, p.id, {});

  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 10 });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /cerrado/);
  assert.equal(contenidoDelPallet(db, p.id)[0].bultos, 40);

  reabrirPallet(db, p.id);
  assert.equal(moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 10 }).ok, true);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · SACAR DEL PALLET
// ══════════════════════════════════════════════════════════════════════════
test('sacar una línea la devuelve al suelto, sin tocar el stock', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
  const antes = stock(db);
  const p = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });

  const linea = { id: lineasDelPallet(db, p.id)[0].ids[0] };
  assert.equal(sacarDelPalletArmado(db, linea.id).ok, true);
  assert.deepEqual(stock(db), antes);
  assert.equal(contenidoDelPallet(db, p.id).length, 0);
  // Queda suelta, lista para armar otro: las 60 que nunca se movieron y las 40.
  assert.equal(piso(db).reduce((t, x) => t + x.bultos, 0), 100);
});

test('no se saca de un pallet cerrado, ni algo que ya está suelto', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
  const p = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  const linea = { id: lineasDelPallet(db, p.id)[0].ids[0] };
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

  const p = abrirPalletArmado(db, { fecha: F, observacion: 'Para el camión del jueves' });
  for (const l of [
    { lote_id: 10, presentacion_id: a, calibre: '50/55', bultos: 60 },
    { lote_id: 11, presentacion_id: a, calibre: '50/55', bultos: 17 },
    { lote_id: 10, presentacion_id: b, calibre: '', bultos: 20 },
  ]) {
    const r = moverAlPallet(db, p.id, Object.assign({ destino: 'comercial' }, l));
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
  const p = abrirPalletArmado(db, { fecha: F });
  moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
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
  entraAlDia(db, a, 100, '1');
  const delDia = palletAbierto(db).id;
  cerrarPallet(db, delDia, {});
  entra(db, a, 30, '2');

  const s = stockParaArmar(db);
  assert.equal(s.length, 2, 'no separó por ubicación');
  const enPallet = s.filter((x) => x.pallet_id === delDia)[0];
  const suelto = s.filter((x) => !x.pallet_id)[0];
  assert.equal(enPallet.ubicacion, 'PC-26-00001');
  assert.equal(enPallet.bultos, 100);
  assert.equal(suelto.ubicacion, 'suelto');
  assert.equal(suelto.bultos, 30);
});

test('PERO PARA ARMAR SE OFRECE EL PISO: { suelto } deja afuera los pallets CERRADOS', () => {
  /* Andy, 5/11/2026: «me tiene que aparecer solo lo que no tiene pallet
     cerrado». Lo suelto y el pallet del día —abierto— entran; el cerrado no. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entraAlDia(db, a, 100, '1');
  const cerrado = palletAbierto(db).id;
  cerrarPallet(db, cerrado, {});
  entraAlDia(db, a, 50, '2');                 // el del día, abierto
  entra(db, a, 30, '3');                      // el piso

  assert.equal(stockParaArmar(db).length, 3, 'la lista completa cambió');
  const libre = stockParaArmar(db, { suelto: true });
  assert.equal(libre.length, 2, 'no son el suelto y el abierto');
  assert.ok(!libre.some((x) => x.pallet_id === cerrado), 'ofrece un pallet cerrado');
  assert.equal(libre.reduce((t, x) => t + x.bultos, 0), 80);
  // Y por artículo, igual: es el mismo corte.
  assert.equal(stockPorArticulo(db, { suelto: true })[0].bultos, 80);
  assert.equal(stockPorArticulo(db)[0].bultos, 180);
});

test('Y LO QUE NO SE OFRECE SE PUEDE DECIR: enPallets() lo cuenta', () => {
  /* El contrapeso. Sin esto la pantalla pasa de ofrecer 180 cajas a ofrecer 30 y
     parece que se perdió mercadería. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entraAlDia(db, a, 100, '1');
  const uno = palletAbierto(db).id;
  cerrarPallet(db, uno, {});
  entraAlDia(db, a, 50, '2');
  entra(db, a, 30, '3');

  // Sólo el CERRADO: el abierto y lo suelto se ofrecen, así que no faltan.
  const e = enPallets(db);
  assert.equal(e.bultos, 100, 'contó lo que se ofrece como si no se ofreciera');
  assert.equal(e.pallets, 1);

  /* Y un pallet despachado entero NO cuenta: sus cajas están en un camión. El
     COUNT(DISTINCT) sobre las filas lo seguiría contando, porque las de ingreso
     siguen ahí con su pallet_id. */
  const d = abrirDespacho(db, { fecha: F });
  assert.equal(agregarPalletAlDespacho(db, d.id, uno).ok, true);
  emitirDespacho(db, d.id);
  const e2 = enPallets(db);
  assert.equal(e2.bultos, 0);
  assert.equal(e2.pallets, 0, 'cuenta un pallet que ya se fue en el camión');
});

test('lo DESPACHADO no se ofrece para armar', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
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
    presentacion_id: a, calibre: '50/55', bultos: 100 });
  assert.equal(r.ok, false, 'movió al pallet cajas que ya se fueron');
  assert.equal(r.disponible, 0);
  assert.equal(stock(db).bultos, 0, 'mover cambió el stock');
});

test('UN DESPACHO POR CANTIDAD NO PARTE UN PALLET CERRADO', () => {
  /* Andy, 5/11/2026: «una vez que está armado el pallet no puede cargarse sólo
     una parte del pallet».

     Hasta la V1143 este MISMO caso pasaba en verde y era el bug: 97 cajas se
     llevaban 60 de un pallet cerrado y 37 del piso, el pallet quedaba en 0 y su
     tarjetón —impreso, pegado y diciendo 60— se iba con el camión. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entraAlDia(db, a, 60, '1');
  const unoId = palletAbierto(db).id;
  cerrarPallet(db, unoId, {});
  entraAlDia(db, a, 40, '2');
  const dosId = palletAbierto(db).id;
  assert.notEqual(unoId, dosId);

  const d = abrirDespacho(db, { fecha: F });
  const r = agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 97 });
  assert.equal(r.ok, false, 'partió el pallet cerrado');
  assert.match(r.motivo, /Hay 40 cajas/, 'no dice cuánto hay en el piso: ' + r.motivo);
  // Y no escribió NADA: el pallet sigue entero y el stock no se movió.
  assert.equal(palletResumen(db, unoId).bultos, 60);
  assert.equal(stock(db).bultos, 100);
});

test('el pallet cerrado va ENTERO, y el piso aparte', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entraAlDia(db, a, 60, '1');
  const unoId = palletAbierto(db).id;
  cerrarPallet(db, unoId, {});
  entraAlDia(db, a, 40, '2');

  const d = abrirDespacho(db, { fecha: F });
  const rp = agregarPalletAlDespacho(db, d.id, unoId);
  assert.equal(rp.ok, true, rp.motivo);
  assert.equal(rp.bultos, 60);
  const r2 = agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 37 });
  assert.equal(r2.ok, true, r2.motivo);
  emitirDespacho(db, d.id);

  assert.equal(palletResumen(db, unoId).bultos, 0, 'el pallet no salió entero');
  assert.equal(stock(db).bultos, 3);
  // Y las ubicaciones suman exactamente el stock, que es la invariante.
  assert.equal(stockParaArmar(db).reduce((t, x) => t + x.bultos, 0), 3);
});

test('LA SALIDA DICE DE QUÉ UBICACIÓN SALIÓ, y se parte entre varias DEL PISO', () => {
  /* Partir entre ubicaciones del piso sigue estando bien: son cajas sueltas y
     apiladas, nadie las enzunchó. Sin esto el total del stock baja y las
     ubicaciones no, y son dos cuentas que tienen que dar lo mismo. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  // Una suelta de verdad y otra en el pallet del día, que todavía está abierto.
  entra(db, a, 60, 's1');
  entraAlDia(db, a, 40, '2');
  const delDia = palletAbierto(db).id;

  const d = abrirDespacho(db, { fecha: F });
  const r = agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 97 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.partes, 2, 'escribió una sola salida para dos ubicaciones');
  emitirDespacho(db, d.id);

  assert.equal(stock(db).bultos, 3);
  assert.equal(stockParaArmar(db).reduce((t, x) => t + x.bultos, 0), 3);
  void delDia;
});

// ══════════════════════════════════════════════════════════════════════════
// 8 · ELEGIR SIN DECIR EL LOTE: LO REPARTE EL SISTEMA
// ══════════════════════════════════════════════════════════════════════════
// Andy, 1/11/2026: «dame la opción de elegir independientemente del lote, es
// decir que lo haga solo el sistema. Es más: es más importante el día de
// proceso que el lote».
test('LA LISTA POR ARTÍCULO JUNTA LOS LOTES Y LAS UBICACIONES', () => {
  // Eran diecinueve renglones —la misma caja repetida por cada lote y cada
  // pallet— y armar un pallet de 100 cajas pedía elegir tres veces y sumar de
  // memoria.
  const db = base();
  const a = art(db, 'Carton Amarilla', '50/55');
  const b = art(db, 'IFCO', null);
  entra(db, a, 267, '1', 10);
  entra(db, a, 17, '2', 11);
  entra(db, b, 49, '3', 10);

  const g = stockPorArticulo(db);
  assert.equal(g.length, 2, 'no juntó los lotes: ' + g.map((x) => x.presentacion).join(', '));
  const am = g.filter((x) => x.calibre === '50/55')[0];
  assert.equal(am.bultos, 284, '267 + 17 de dos lotes tienen que dar 284');
  assert.equal(am.lotes.length, 2);
  // Y las ubicaciones quedan adentro, en el orden en que se van a tomar.
  assert.equal(am.ubicaciones.length, 2);
});

test('EL DÍA DE PROCESO VIENE EN EL RENGLÓN: es con lo que se elige', () => {
  // Andy: «es más importante el día de proceso que el lote». Sin la fecha, el
  // renglón no puede contestar la pregunta con la que se arma un camión: cuál
  // hay que sacar primero.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  registrarProceso(db, { fecha: '2026-12-10', lote_id: 10, presentacion_id: a,
    bultos: 30, uuid: '1' });
  registrarProceso(db, { fecha: '2026-12-14', lote_id: 11, presentacion_id: a,
    bultos: 50, uuid: '2' });
  const g = stockPorArticulo(db)[0];
  assert.equal(g.desde, '2026-12-10', 'no dice desde cuándo está');
  assert.equal(g.hasta, '2026-12-14');
  // La ubicación más vieja primero: es de la que va a salir.
  assert.equal(g.ubicaciones[0].desde, '2026-12-10');
});

test('y lo MÁS VIEJO va arriba dentro de cada destino', () => {
  const db = base();
  const viejo = art(db, 'Viejo', '50/55');
  const nuevo = art(db, 'Nuevo', '60/70');
  registrarProceso(db, { fecha: '2026-12-14', lote_id: 10, presentacion_id: nuevo,
    bultos: 10, uuid: '1' });
  registrarProceso(db, { fecha: '2026-12-10', lote_id: 10, presentacion_id: viejo,
    bultos: 10, uuid: '2' });
  assert.deepEqual(stockPorArticulo(db).map((x) => x.presentacion), ['Viejo', 'Nuevo']);
});

test('SIN LOTE, TOMA DEL DÍA MÁS VIEJO PRIMERO', () => {
  // El reparto lo hace el sistema y el criterio es la fecha, no el lote ni el
  // montón más grande: en una cámara lo que entró antes sale antes.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  registrarProceso(db, { fecha: '2026-12-10', lote_id: 11, presentacion_id: a,
    bultos: 30, uuid: '1', sin_pallet: 1 });
  registrarProceso(db, { fecha: '2026-12-14', lote_id: 10, presentacion_id: a,
    bultos: 50, uuid: '2', sin_pallet: 1 });
  const antes = stock(db);

  const p = abrirPalletArmado(db, { fecha: F });
  // Sin lote_id NI pallet_id: que elija el sistema.
  const r = moverAlPallet(db, p.id, { destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 45 });
  assert.equal(r.ok, true, r.motivo);
  assert.deepEqual(stock(db), antes, 'repartir movió el stock');

  // Las 30 del 10 enteras, y 15 de las del 14.
  assert.equal(r.detalle.length, 2, 'no dice de dónde salió');
  assert.equal(r.detalle[0].fecha, '2026-12-10');
  assert.equal(r.detalle[0].bultos, 30);
  assert.equal(r.detalle[0].lote_id, 11);
  assert.equal(r.detalle[1].fecha, '2026-12-14');
  assert.equal(r.detalle[1].bultos, 15);
  assert.equal(contenidoDelPallet(db, p.id).reduce((t, x) => t + x.bultos, 0), 45);
});

test('sin lote el TOPE es el del artículo entero, no el de un montón', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 30, '1', 10);
  entra(db, a, 50, '2', 11);
  const p = abrirPalletArmado(db, { fecha: F });
  // 80 hay, 81 no.
  assert.equal(moverAlPallet(db, p.id, { destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 80 }).ok, true);
  const r = moverAlPallet(db, p.id, { destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.disponible, 0);
});

test('CON lote sigue tomando sólo de ése', () => {
  // La opción detallada no se va: hace falta cuando el RENSPA importa.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  registrarProceso(db, { fecha: '2026-12-10', lote_id: 11, presentacion_id: a,
    bultos: 30, uuid: '1', sin_pallet: 1 });
  registrarProceso(db, { fecha: '2026-12-14', lote_id: 10, presentacion_id: a,
    bultos: 50, uuid: '2', sin_pallet: 1 });
  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 45 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.detalle.length, 1, 'tomó de más de un lote habiéndolo nombrado');
  assert.equal(r.detalle[0].lote_id, 10);
  // Y el tope del lote nombrado: del 11 hay 30, no 80.
  const q = abrirPalletArmado(db, { fecha: F });
  assert.equal(moverAlPallet(db, q.id, { lote_id: 11, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 }).ok, false);
});

test('SIN UBICACIÓN NO SE LLEVA LO DE SU PROPIO PALLET', () => {
  // Tomar del montón que uno mismo está armando es no hacer nada, y además
  // haría que el tope cuente dos veces lo que ya está adentro.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
  const p = abrirPalletArmado(db, { fecha: F });
  assert.equal(moverAlPallet(db, p.id, { destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 60 }).ok, true);
  // Quedan 40 afuera: pedir 50 tiene que frenarse aunque adentro haya 60.
  const r = moverAlPallet(db, p.id, { destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 50 });
  assert.equal(r.ok, false, 'se tomó a sí mismo');
  assert.equal(r.disponible, 40);
});

test('pedir lo SUELTO explícitamente sigue siendo otra cosa que no pedir nada', () => {
  /* pallet_id: null es «lo que no está en ningún pallet». No nombrar el campo es
     «de donde sea, menos de un pallet cerrado» — y eso incluye el del día, que
     está abierto. Son dos pedidos distintos y tienen que dar distinto. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entraAlDia(db, a, 100, '1');               // en el del día, abierto
  entra(db, a, 20, '2');                     // el piso
  const p = abrirPalletArmado(db, { fecha: F });

  const soloSuelto = moverAlPallet(db, p.id, { destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 30, pallet_id: null });
  assert.equal(soloSuelto.ok, false, 'tomó del pallet habiendo pedido lo suelto');
  assert.equal(soloSuelto.disponible, 20);

  const deDondeSea = moverAlPallet(db, p.id, { destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 30 });
  assert.equal(deDondeSea.ok, true, deDondeSea.motivo);

  // Y si el del día se CIERRA, «de donde sea» ya no lo alcanza.
  cerrarPallet(db, palletAbierto(db).id, {});
  const r = moverAlPallet(db, p.id, { destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 500 });
  assert.equal(r.ok, false);
  assert.ok(r.disponible < 100, 'cuenta lo del pallet cerrado: ' + r.disponible);
});

test('EL REPARTO AUTOMÁTICO NO DESARMA NINGÚN PALLET', () => {
  /* Era el caso más feo del modelo viejo: pedir 45 cajas sin decir de dónde
     desarmaba DOS pallets cerrados de una, y los dos quedaban con su tarjetón
     impreso diciendo otra cosa. El cartel que los enumeraba era el parche; la
     V1146 saca la causa. */
  const db = base();
  const a = art(db, 'Carton', '50/55');
  registrarProceso(db, { fecha: '2026-12-10', lote_id: 10, presentacion_id: a,
    bultos: 30, uuid: '1' });
  const uno = palletAbierto(db).id;
  cerrarPallet(db, uno, {});
  registrarProceso(db, { fecha: '2026-12-14', lote_id: 11, presentacion_id: a,
    bultos: 50, uuid: '2' });
  const dos = palletAbierto(db).id;
  cerrarPallet(db, dos, {});

  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 45 });
  assert.equal(r.ok, false, 'el reparto automático desarmó pallets cerrados');
  assert.equal(r.en_pallet, 1);
  assert.match(r.motivo, /80 cajas/, 'no dice cuántas hay apiladas: ' + r.motivo);
  assert.equal(palletResumen(db, uno).bultos, 30, 'igual le sacó cajas al primero');
  assert.equal(palletResumen(db, dos).bultos, 50);
});

test('lo DESPACHADO no se ofrece ni se puede repartir', () => {
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
  const d = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, d.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 100 });
  emitirDespacho(db, d.id);

  assert.deepEqual(stockPorArticulo(db), [], 'ofrece lo que ya se fue en un camión');
  const p = abrirPalletArmado(db, { fecha: F });
  assert.equal(moverAlPallet(db, p.id, { destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 10 }).ok, false);
});

test('DOS CALIBRES DE LA MISMA CAJA SON DOS ARTÍCULOS', () => {
  // Juntarlos haría que pedir «Carton Amarilla» mezcle 50/55 con 60/70 en el
  // mismo pallet sin que nadie lo decida — y el calibre va impreso en el
  // tarjetón, así que la etiqueta diría una cosa y el pallet tendría otra.
  const db = base();
  const a = art(db, 'Carton Amarilla', '50/55');
  const b = art(db, 'Carton Amarilla', '60/70');
  entra(db, a, 30, '1');
  entra(db, b, 50, '2');
  const g = stockPorArticulo(db);
  assert.equal(g.length, 2, 'juntó dos calibres en un artículo');
  assert.deepEqual(g.map((x) => x.calibre).sort(), ['50/55', '60/70']);
});

test('LAS UBICACIONES SALEN EN EL ORDEN EN QUE SE VAN A TOMAR', () => {
  // La pantalla las muestra para decir de dónde VA a salir antes de apretar.
  // Si no vienen por fecha, dice que va a sacar del montón equivocado — y el
  // que va al playón a buscarlo no lo encuentra.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  // El lote 10 entra DESPUÉS: por lote iría primero, por fecha va segundo.
  registrarProceso(db, { fecha: '2026-12-14', lote_id: 10, presentacion_id: a,
    bultos: 50, uuid: '1', sin_pallet: 1 });
  registrarProceso(db, { fecha: '2026-12-10', lote_id: 11, presentacion_id: a,
    bultos: 30, uuid: '2', sin_pallet: 1 });

  const u = stockPorArticulo(db)[0].ubicaciones;
  assert.equal(u.length, 2);
  assert.equal(u[0].desde, '2026-12-10', 'la más vieja no quedó primera');
  assert.equal(u[0].lote_id, 11);
  // Y el movimiento sale en ese mismo orden: lo que se anuncia es lo que pasa.
  const p = abrirPalletArmado(db, { fecha: F });
  const r = moverAlPallet(db, p.id, { destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 40 });
  assert.equal(r.detalle[0].fecha, '2026-12-10');
  assert.equal(r.detalle[0].bultos, 30);
});

test('SIN UBICACIÓN NO SE SACA DE SÍ MISMO, ni siquiera cuando el tope da', () => {
  // El tope ya excluye lo propio, pero la consulta tiene que excluirlo
  // también: si no, pedir 40 cuando hay 40 afuera y 60 adentro se lleva las
  // de adentro —que ya estaban— y deja las de afuera sin mover. El pallet
  // queda igual y el que lo armó cree que puso 100.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 100, '1');
  const p = abrirPalletArmado(db, { fecha: F });
  assert.equal(moverAlPallet(db, p.id, { destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 60 }).ok, true);
  assert.equal(contenidoDelPallet(db, p.id)[0].bultos, 60);

  // Las 40 que quedan afuera: tienen que entrar y el pallet quedar en 100.
  const r = moverAlPallet(db, p.id, { destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 40 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(contenidoDelPallet(db, p.id)[0].bultos, 100,
    'se movió a sí mismo: el pallet no creció');
  // Las 40 salieron del pallet DEL DÍA, que es donde estaban, y de ninguna
  // manera del que se está armando.
  assert.ok(!r.detalle.some((x) => x.pallet_id === p.id),
    'se sacó cajas a sí mismo para ponérselas de nuevo');
});

test('un calibre CAMBIADO en el catálogo no junta lo viejo con lo nuevo', () => {
  // Dos calibres son dos presentaciones del catálogo, así que agrupar por
  // presentación ya los separa... hasta que alguien le cambia el calibre a
  // una. El calibre queda congelado en cada carga, y sin él en la clave las
  // cajas 50/55 de ayer se juntarían con las 60/70 de hoy en un renglón — y
  // el calibre va impreso en el tarjetón.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  entra(db, a, 30, '1');
  guardarPresentacion(db, { id: a, nombre: 'Carton', destino: 'comercial',
    envase: 'Caja', por_bulto: 1, kg_unidad: 8, calibre: '60/70', categoria: 'I' });
  entra(db, a, 50, '2');

  const g = stockPorArticulo(db);
  assert.equal(g.length, 2, 'juntó dos calibres de la misma presentación');
  assert.deepEqual(g.map((x) => x.calibre).sort(), ['50/55', '60/70']);
});

test('no se saca de sí mismo NI cuando lo propio es lo más viejo', () => {
  // El orden es por fecha, así que si lo que está adentro del pallet es más
  // viejo que lo de afuera, es lo primero que la consulta devuelve. Sin el
  // filtro, mover 40 se lleva 40 que ya estaban adentro: el pallet no crece y
  // el que lo armó cree que le puso 40 más.
  const db = base();
  const a = art(db, 'Carton', '50/55');
  registrarProceso(db, { fecha: '2026-12-10', lote_id: 10, presentacion_id: a,
    bultos: 60, uuid: '1', sin_pallet: 1 });
  const p = abrirPalletArmado(db, { fecha: F });
  // Las 60 VIEJAS entran al pallet armado.
  assert.equal(moverAlPallet(db, p.id, { destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 60 }).ok, true);
  // Y después entran 40 NUEVAS a la cámara.
  registrarProceso(db, { fecha: '2026-12-20', lote_id: 10, presentacion_id: a,
    bultos: 40, uuid: '2', sin_pallet: 1 });

  const r = moverAlPallet(db, p.id, { destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 40 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(contenidoDelPallet(db, p.id)[0].bultos, 100,
    'se llevó las suyas de nuevo: el pallet no creció');
  assert.equal(r.detalle[0].fecha, '2026-12-20',
    'tomó las viejas, que ya estaban adentro de este mismo pallet');
});
