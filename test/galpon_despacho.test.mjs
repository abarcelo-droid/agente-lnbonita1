// ══ 🚚 STOCK Y DESPACHOS ════════════════════════════════════════════════════
//
// Andy, 1/11/2026: «quiero un módulo separado con Stock (de ahí vamos a hacer
// los despachos)... la vuelta sería primero procesar y una vez que está en
// stock lo despachamos».
//
// Lo que se clava acá, en orden de qué duele más:
//
//   1. DESPACHAR MÁS DE LO QUE HAY. Es la ÚNICA validación del galpón que
//      frena, porque la fruta todavía está en la cámara. Un camión al que le
//      van a faltar 50 cajas no es un dato que se corrige mañana.
//   2. CONTAR DOS VECES LO MISMO. Pedir 250 y después 250 más tiene que
//      frenarse en la segunda, no sumar 300 cuando hay 250 y avisar al cargar.
//   3. EL NÚMERO REPETIDO. Igual que en el pallet: dos remitos con el mismo
//      número y no hay forma de saber cuál llegó.
//   4. ANULAR QUE NO DEVUELVE EL STOCK. La fruta volvió a la cámara y el
//      sistema la sigue contando despachada: el stock miente.
//   5. BORRAR UN DESPACHO EMITIDO. Haría desaparecer un remito que alguien
//      tiene en la mano.
//   6. EDITAR UN DESPACHO EMITIDO. Lo que dice el remito que salió tiene que
//      quedar congelado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  guardarPresentacion, guardarDatosDeLote, registrarProceso,
  disponibleParaDespacho, despachos, itemsDelDespacho, abrirDespacho,
  editarDespacho, agregarAlDespacho, sacarDelDespacho, emitirDespacho,
  anularDespacho, borrarDespacho, despachoPorNumero, proximoNumeroDespacho,
  stockGalpon, stockPorProducto, stockPorLote, stockPorPresentacion, presentaciones,
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
    INSERT INTO pa_cultivos_lote (lote_id,cultivo,es_perenne) VALUES (10,'Damasco',1);
    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
    INSERT INTO gal_config (clave,valor) VALUES ('despacho_prefijo','DG');
    CREATE TABLE gal_volcados (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT,
      lote_id INTEGER, lote_nombre TEXT, producto TEXT, kilos REAL, ifcos INTEGER,
      eliminado_en TEXT);
    CREATE TABLE gal_lote_datos (lote_id INTEGER PRIMARY KEY, renspa TEXT, variedad TEXT,
      cuartel TEXT, notas TEXT, actualizado TEXT);
    CREATE TABLE gal_presentaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT,
      destino TEXT, envase TEXT, por_bulto REAL DEFAULT 1, kg_unidad REAL DEFAULT 1,
      granel INTEGER DEFAULT 0, emoji TEXT, icono TEXT, icono_v TEXT, categoria TEXT NOT NULL DEFAULT 'I', calibre TEXT,
      color TEXT, orden INTEGER DEFAULT 100, activo INTEGER DEFAULT 1,
      creado_en TEXT, eliminado_en TEXT);
    CREATE TABLE gal_pallets (id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT UNIQUE,
      estado TEXT NOT NULL DEFAULT 'abierto', parcial INTEGER NOT NULL DEFAULT 0,
      mixto INTEGER NOT NULL DEFAULT 0, fecha_empaque TEXT, bultos REAL, kilos REAL,
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
      repartido INTEGER NOT NULL DEFAULT 0, pallet_id INTEGER, despacho_id INTEGER,
      observacion TEXT, estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT,
      usuario_id INTEGER, usuario TEXT, creado_en TEXT, eliminado_en TEXT);
  `);
  guardarDatosDeLote(db, { lote_id: 10, renspa: '12.345.6.78901/00',
    variedad: 'Castlebrite', cuartel: 'C-07' });
  return db;
}

const art = (db, nombre, calibre, kg) => guardarPresentacion(db, {
  nombre, destino: 'comercial', envase: 'Caja 8 kg', por_bulto: 1,
  kg_unidad: kg == null ? 8 : kg, calibre, categoria: 'I' }).id;

// Mete kilos al stock: N cajas del artículo a.
// stockGalpon() devuelve { destinos, kilos } y NO un total de bultos: sumar cajas de 8 kg
// con bines de 400 daria un numero que no significa nada fisico. Para el test, donde todo
// es la misma caja, se suman los destinos.
const cajasEnStock = (db) => stockGalpon(db, {}).destinos
  .reduce((t, d) => t + (Number(d.bultos) || 0), 0);

const entra = (db, a, cajas, u, lote) => registrarProceso(db,
  { fecha: F, lote_id: lote || 10, presentacion_id: a, bultos: cajas, uuid: u });

// ══════════════════════════════════════════════════════════════════════════
// 1 · QUÉ SE PUEDE DESPACHAR
// ══════════════════════════════════════════════════════════════════════════
test('el disponible es el stock, no el catálogo', () => {
  // El selector del despacho sale de acá: no se puede tipear un lote que no
  // tiene nada. Un artículo del catálogo sin cargas no aparece.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  art(db, 'Caja', '60/70');          // en el catálogo y sin una sola caja
  entra(db, a, 40, '1');
  const d = disponibleParaDespacho(db);
  assert.equal(d.length, 1, 'apareció un artículo que no tiene stock');
  assert.equal(d[0].bultos, 40);
  assert.equal(d[0].calibre, '50/55');
});

test('EL PESO DE UNA CAJA SALE DEL STOCK, NO DEL CATÁLOGO', () => {
  // Si entraron cajas de 8,2 kg y el catálogo dice 8,0, despachar 100 tiene
  // que sacar los 820 que hay. Si no, el stock queda con 20 kg fantasma que
  // nadie puede despachar nunca.
  const db = base();
  const a = art(db, 'Caja', '50/55', 8);
  // Entran 100 cajas pero pesan 820 kg: el kg_unidad real es 8,2.
  db.prepare("INSERT INTO gal_procesos (uuid,fecha,lote_id,destino,presentacion_id,"
    + "presentacion,calibre,bultos,kg_unidad,kilos,tipo) "
    + "VALUES ('x',?,10,'comercial',?,'Caja','50/55',100,8.2,820,'ingreso')").run(F, a);
  const d = disponibleParaDespacho(db)[0];
  assert.equal(d.kg_unidad, 8.2, 'tomó el peso del catálogo en vez del stock');

  const x = abrirDespacho(db, { fecha: F, destinatario: 'San Gerónimo' });
  const r = agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.kilos, 820);
  // Y el stock queda en CERO, no en 20.
  assert.equal(disponibleParaDespacho(db).length, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · NO SE DESPACHA MÁS DE LO QUE HAY
// ══════════════════════════════════════════════════════════════════════════
test('NO SE DESPACHA MÁS DE LO QUE HAY: frena y dice cuánto', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 250, '1');
  const x = abrirDespacho(db, { fecha: F });
  const r = agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.disponible, 250);
  assert.equal(r.pedido, 300);
  assert.match(r.motivo, /250/, 'no dijo cuántas hay');
  assert.equal(itemsDelDespacho(db, x.id).length, 0, 'guardó igual');
});

test('LO YA CARGADO EN EL MISMO BORRADOR CUENTA', () => {
  // 250 y después 250: la segunda se frena. Si el disponible no viera las
  // salidas del propio borrador se cargarían 500 contra un stock de 250, y
  // recién se vería cuando el camión está cargado.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 250, '1');
  const x = abrirDespacho(db, { fecha: F });
  const uno = { lote_id: 10, destino: 'comercial', presentacion_id: a,
    calibre: '50/55', bultos: 250 };
  assert.equal(agregarAlDespacho(db, x.id, uno).ok, true);
  const dos = agregarAlDespacho(db, x.id, uno);
  assert.equal(dos.ok, false, 'dejó despachar 500 de un stock de 250');
  assert.equal(dos.disponible, 0);
});

test('despachar exactamente lo que hay sí se puede', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 40, '1');
  const x = abrirDespacho(db, { fecha: F });
  assert.equal(agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 }).ok, true);
});

test('el granel se despacha en kilos y también tiene tope', () => {
  const db = base();
  const g = guardarPresentacion(db, { nombre: 'Bin', destino: 'comercial',
    envase: 'Bin', granel: 1, por_bulto: 0, kg_unidad: 0, categoria: 'I' }).id;
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: g, kilos: 1200, uuid: 'g' });
  const x = abrirDespacho(db, { fecha: F });
  const mal = agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: g, kilos: 1500 });
  assert.equal(mal.ok, false);
  assert.equal(mal.disponible, 1200);
  const bien = agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: g, kilos: 1200 });
  assert.equal(bien.ok, true);
  assert.equal(bien.kilos, 1200);
  assert.equal(bien.bultos, null, 'le puso cajas a un granel');
});

test('cada línea tiene su propio tope: dos calibres no se mezclan', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const b = art(db, 'Caja', '60/70');
  entra(db, a, 100, '1');
  entra(db, b, 20, '2');
  const x = abrirDespacho(db, { fecha: F });
  // 50 del 60/70 cuando hay 20, aunque en total haya 120 cajas.
  const r = agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: b, calibre: '60/70', bultos: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.disponible, 20, 'sumó los dos calibres en un solo tope');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL NÚMERO
// ══════════════════════════════════════════════════════════════════════════
test('EL NÚMERO SE PONE AL EMITIR, no al abrir', () => {
  // Un borrador con número es un número gastado cada vez que alguien abre uno
  // y se arrepiente: huecos en el correlativo que nadie puede explicar.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 40, '1');
  const x = abrirDespacho(db, { fecha: F });
  assert.equal(x.despacho.numero, null, 'le puso número a un borrador');
  assert.equal(x.despacho.estado, 'borrador');
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  const e = emitirDespacho(db, x.id);
  assert.equal(e.numero, 'DG-26-00001');
});

test('el correlativo nunca entrega un número dos veces', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const vistos = new Set();
  for (let i = 0; i < 4; i++) {
    entra(db, a, 10, 'u' + i);
    const x = abrirDespacho(db, { fecha: F });
    agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
      presentacion_id: a, calibre: '50/55', bultos: 10 });
    const n = emitirDespacho(db, x.id).numero;
    assert.ok(!vistos.has(n), 'el número ' + n + ' se usó dos veces');
    vistos.add(n);
    if (i === 1) anularDespacho(db, x.id, 'prueba');
  }
  assert.equal(vistos.size, 4);
});

test('un despacho ANULADO no libera su número', () => {
  // Liberarlo daría dos remitos con el mismo número: el anulado que alguien
  // tiene en la mano y el nuevo.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  assert.equal(emitirDespacho(db, x.id).numero, 'DG-26-00001');
  anularDespacho(db, x.id, 'se cayó el camión');

  const y = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, y.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  assert.equal(emitirDespacho(db, y.id).numero, 'DG-26-00002',
    'reutilizó el número del anulado');
});

test('el número lleva el año de la FECHA del despacho, no la de hoy', () => {
  const db = base();
  assert.match(proximoNumeroDespacho(db, '2027-01-10'), /^DG-27-/);
});

test('emitir dos veces es idempotente: el segundo clic no cambia nada', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 40, '1');
  const x = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  const n = emitirDespacho(db, x.id).numero;
  const dos = emitirDespacho(db, x.id);
  assert.equal(dos.ok, true);
  assert.equal(dos.ya_estaba, true);
  assert.equal(dos.despacho.numero, n);
});

test('un despacho VACÍO no se emite', () => {
  const db = base();
  const x = abrirDespacho(db, { fecha: F });
  const r = emitirDespacho(db, x.id);
  assert.equal(r.ok, false);
  assert.equal(x.despacho.numero, null);
  assert.equal(proximoNumeroDespacho(db, F), 'DG-26-00001', 'gastó el número');
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · EL STOCK SE DESCUENTA Y VUELVE
// ══════════════════════════════════════════════════════════════════════════
test('despachar DESCUENTA del stock en los tres cortes', () => {
  // Los tres leen gal_procesos con el mismo CASE sobre tipo: si uno se olvida
  // de descontar, el stock dice una cosa en una pantalla y otra en la otra.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });

  assert.equal(disponibleParaDespacho(db)[0].bultos, 60);
  assert.equal(cajasEnStock(db), 60);
  assert.equal(stockPorProducto(db)[0].bultos, 60);
  assert.equal(stockPorLote(db)[0].kilos, 480);
});

test('ANULAR DEVUELVE LAS CAJAS AL STOCK', () => {
  // Si no vuelven, la fruta está en la cámara y el sistema la cuenta
  // despachada: nadie la puede despachar de nuevo.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  emitirDespacho(db, x.id);
  assert.equal(cajasEnStock(db), 60);

  anularDespacho(db, x.id, 'no vino el camión');
  assert.equal(cajasEnStock(db), 100, 'las cajas no volvieron');
  assert.equal(disponibleParaDespacho(db)[0].bultos, 100);
  assert.equal(itemsDelDespacho(db, x.id).length, 0);
  const d = despachos(db, {}).filter((y) => y.id === x.id)[0];
  assert.equal(d.estado, 'anulado');
  assert.equal(d.anulado_motivo, 'no vino el camión');
  assert.equal(d.numero, 'DG-26-00001', 'le sacó el número');
});

test('sacar una línea del borrador la devuelve al stock', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  const r = agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  assert.equal(sacarDelDespacho(db, r.id).ok, true);
  assert.equal(cajasEnStock(db), 100);
  assert.equal(itemsDelDespacho(db, x.id).length, 0);
});

test('NO SE SACA UNA LÍNEA DE UN DESPACHO EMITIDO: se anula entero', () => {
  // Sacarle una línea a un remito que ya salió lo deja distinto de lo que
  // dice el papel que está en la mano del transportista.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  const r = agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  emitirDespacho(db, x.id);
  const s = sacarDelDespacho(db, r.id);
  assert.equal(s.ok, false);
  assert.equal(itemsDelDespacho(db, x.id).length, 1);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LO QUE SE CONGELA
// ══════════════════════════════════════════════════════════════════════════
test('LO QUE SE DESPACHÓ QUEDA CONGELADO en la línea', () => {
  // Un calibre corregido en el catálogo el mes que viene no cambia lo que
  // decía el remito que se fue en el camión.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  emitirDespacho(db, x.id);

  guardarPresentacion(db, { id: a, nombre: 'Caja', destino: 'comercial',
    envase: 'Caja 8 kg', por_bulto: 1, kg_unidad: 8, calibre: '45/50',
    categoria: 'II' });
  guardarDatosDeLote(db, { lote_id: 10, renspa: '99.999.9.99999/99',
    variedad: 'Otra', cuartel: 'Z-99' });

  const it = itemsDelDespacho(db, x.id)[0];
  assert.equal(it.calibre, '50/55', 'el calibre cambió después del despacho');
  assert.equal(it.categoria, 'I');
  assert.equal(it.lote_nombre, 'L-1215-A');
});

test('un despacho EMITIDO no se edita; sólo se le agrega observación', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 40, '1');
  const x = abrirDespacho(db, { fecha: F, destinatario: 'San Gerónimo' });
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  emitirDespacho(db, x.id);

  const mal = editarDespacho(db, x.id, { destinatario: 'Otro' });
  assert.equal(mal.ok, false);
  assert.equal(despachos(db, {})[0].destinatario, 'San Gerónimo');

  const obs = editarDespacho(db, x.id, { observacion: 'lo llevó otro camión' });
  assert.equal(obs.ok, true);
  assert.equal(obs.solo_observacion, true);
  assert.equal(obs.despacho.observacion, 'lo llevó otro camión');
  assert.equal(obs.despacho.destinatario, 'San Gerónimo', 'editó el destinatario igual');
});

test('a un despacho emitido no se le agregan líneas', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  emitirDespacho(db, x.id);
  const r = agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 10 });
  assert.equal(r.ok, false);
  assert.equal(itemsDelDespacho(db, x.id).length, 1);
});

test('los totales del borrador se recalculan; al emitir se congelan', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  const uno = agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  assert.equal(uno.despacho.bultos, 40);
  assert.equal(uno.despacho.kilos, 320);
  const dos = agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 10 });
  assert.equal(dos.despacho.bultos, 50);
  const e = emitirDespacho(db, x.id);
  assert.equal(e.despacho.bultos, 50);
  assert.equal(e.despacho.kilos, 400);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · BORRAR vs ANULAR
// ══════════════════════════════════════════════════════════════════════════
test('UN DESPACHO EMITIDO NO SE BORRA: se anula', () => {
  // Borrarlo haría desaparecer un remito que alguien tiene en la mano.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 40, '1');
  const x = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  emitirDespacho(db, x.id);
  const r = borrarDespacho(db, x.id);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /anula/);
  assert.equal(despachos(db, {}).length, 1);
});

test('un BORRADOR se borra y devuelve lo cargado al stock', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  assert.equal(borrarDespacho(db, x.id).ok, true);
  assert.equal(despachos(db, {}).length, 0);
  assert.equal(cajasEnStock(db), 100, 'las cajas no volvieron');
});

test('anular dos veces no vuelve a sumar el stock', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  emitirDespacho(db, x.id);
  anularDespacho(db, x.id, 'uno');
  const dos = anularDespacho(db, x.id, 'dos');
  assert.equal(dos.ya_estaba, true);
  assert.equal(cajasEnStock(db), 100);
  assert.equal(despachos(db, {})[0].anulado_motivo, 'uno', 'pisó el motivo');
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · BUSCAR POR NÚMERO
// ══════════════════════════════════════════════════════════════════════════
test('buscar por número trae el despacho con sus líneas', () => {
  // Es lo que se hace cuando llega un reclamo: el número es lo único que tiene
  // quien llama.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 40, '1');
  const x = abrirDespacho(db, { fecha: F, destinatario: 'San Gerónimo' });
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  const n = emitirDespacho(db, x.id).numero;
  const d = despachoPorNumero(db, n);
  assert.equal(d.destinatario, 'San Gerónimo');
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].bultos, 40);
  assert.equal(despachoPorNumero(db, 'DG-26-09999'), null);
});

// ══════════════════════════════════════════════════════════════════════════
// 8 · LOS BORDES
// ══════════════════════════════════════════════════════════════════════════
test('cantidad en cero o negativa se rechaza', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  const l = { lote_id: 10, destino: 'comercial', presentacion_id: a, calibre: '50/55' };
  assert.equal(agregarAlDespacho(db, x.id, Object.assign({}, l, { bultos: 0 })).ok, false);
  assert.equal(agregarAlDespacho(db, x.id, Object.assign({}, l, { bultos: -5 })).ok, false);
  assert.equal(itemsDelDespacho(db, x.id).length, 0);
});

test('un lote o destino que no existe en stock se rechaza', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  assert.equal(agregarAlDespacho(db, x.id, { lote_id: 11, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 10 }).ok, false);
  assert.equal(agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'verde',
    presentacion_id: a, calibre: '50/55', bultos: 10 }).ok, false);
  assert.equal(agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'chirimbolo',
    presentacion_id: a, calibre: '50/55', bultos: 10 }).ok, false);
});

test('un id que no existe no explota: contesta ok:false', () => {
  const db = base();
  for (const f of [emitirDespacho, anularDespacho, borrarDespacho]) {
    assert.equal(f(db, 9999).ok, false);
    assert.equal(f(db, 'pepe').ok, false);
  }
  assert.equal(agregarAlDespacho(db, 9999, { lote_id: 10 }).ok, false);
  assert.deepEqual(itemsDelDespacho(db, 'pepe'), []);
});

test('un despacho BORRADO no figura ni cuenta', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  borrarDespacho(db, x.id);
  assert.equal(despachos(db, {}).length, 0);
  assert.equal(agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 10 }).ok, false,
    'le cargó una línea a un despacho borrado');
});

test('el filtro por estado y por fecha no se come lo que pide', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 40 });
  emitirDespacho(db, x.id);
  const y = abrirDespacho(db, { fecha: '2026-12-20' });

  assert.deepEqual(despachos(db, { estado: 'emitido' }).map((d) => d.id), [x.id]);
  assert.deepEqual(despachos(db, { estado: 'borrador' }).map((d) => d.id), [y.id]);
  assert.deepEqual(despachos(db, { desde: '2026-12-18' }).map((d) => d.id), [y.id]);
  // Una fecha imposible se DESCARTA, no filtra: descartar un filtro no pierde
  // nada, aplicarlo mal esconde despachos que existen.
  assert.equal(despachos(db, { desde: '2026-02-31' }).length, 2);
  assert.equal(despachos(db, { estado: 'chirimbolo' }).length, 2);
});

// ══════════════════════════════════════════════════════════════════════════
// 9 · LOS BORDES EXACTOS
// ══════════════════════════════════════════════════════════════════════════
// Estos tres salieron de la mutación: los de arriba pasaban igual con el
// código roto, o sea pasaban por la razón equivocada.
test('UNA CAJA DE MÁS YA SE FRENA', () => {
  // El test del tope prueba 300 contra 250, y eso pasa igual con un tope
  // corrido en uno. El borde exacto es N+1 cuando hay N: es el caso real —
  // nadie pide 300 de 250, pero sí 41 de 40 cuando contó mal.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 40, '1');
  const x = abrirDespacho(db, { fecha: F });
  const r = agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 41 });
  assert.equal(r.ok, false, 'dejó despachar 41 cajas de un stock de 40');
  assert.equal(r.disponible, 40);
});

test('un kilo de más en el granel también se frena', () => {
  const db = base();
  const g = guardarPresentacion(db, { nombre: 'Bin', destino: 'comercial',
    envase: 'Bin', granel: 1, por_bulto: 0, kg_unidad: 0, categoria: 'I' }).id;
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: g, kilos: 1200, uuid: 'g' });
  const x = abrirDespacho(db, { fecha: F });
  assert.equal(agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: g, kilos: 1201 }).ok, false);
});

test('un destino inválido lo dice ASÍ, no «nunca entró nada»', () => {
  // El test de más arriba verificaba sólo ok:false, y eso pasaba igual sin la
  // validación: el saldo no encuentra nada con destino 'chirimbolo' y contesta
  // «nunca entró nada». Es verdad y es inútil — manda a mirar el stock cuando
  // el problema es que el destino no existe.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  const r = agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'chirimbolo',
    presentacion_id: a, calibre: '50/55', bultos: 10 });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /[Dd]estino/, 'no dijo que el problema es el destino');
});

test('UNA FECHA IMPOSIBLE SE DESCARTA DE VERDAD', () => {
  // El test de los filtros usaba '2026-02-31', que como TEXTO es menor que
  // '2026-12-15', así que el filtro mal aplicado devolvía los dos igual y el
  // assert pasaba sin probar nada. Una fecha imposible que además sea
  // string-MAYOR que los datos sí distingue los dos comportamientos.
  const db = base();
  abrirDespacho(db, { fecha: F });
  abrirDespacho(db, { fecha: '2026-12-20' });
  assert.equal(despachos(db, { desde: '2026-13-45' }).length, 2,
    'aplicó una fecha que no existe en el almanaque y escondió los dos');
  assert.equal(despachos(db, { hasta: '2026-02-30' }).length, 2);
  // Y una fecha REAL sí filtra: si no, el descarte se estaría comiendo todo.
  assert.equal(despachos(db, { desde: '2026-12-18' }).length, 1);
});

// ══════════════════════════════════════════════════════════════════════════
// 10 · EL STOCK POR PRESENTACIÓN
// ══════════════════════════════════════════════════════════════════════════
// Andy, 1/11/2026: «no me interesa por lote. Me interesa PRESENTACIÓN Y
// CAJAS». Eran diecinueve renglones para contestar «cuántas cajas de cartón
// amarillo tengo» — la misma caja repetida en cada lote.
test('AGRUPA POR PRESENTACIÓN Y SUMA LOS LOTES', () => {
  const db = base();
  const a = art(db, 'Carton Amarilla', '50/55');
  const b = art(db, 'IFCO', null);
  entra(db, a, 267, '1', 10);
  entra(db, a, 17, '2', 11);     // la MISMA caja, otro lote
  entra(db, b, 49, '3', 10);

  const g = stockPorPresentacion(db);
  assert.equal(g.length, 2, 'no agrupó: ' + g.map((x) => x.nombre).join(', '));
  const am = g.filter((x) => x.nombre === 'Carton Amarilla')[0];
  assert.equal(am.bultos, 284, '267 + 17 de dos lotes tienen que dar 284');
  assert.equal(am.kilos, 2272);
  // Y el lote sigue adentro: el despacho lo necesita, porque el RENSPA que va
  // impreso sale del lote.
  assert.equal(am.lotes.length, 2);
  assert.equal(am.lotes[0].bultos, 267, 'el montón más grande no quedó arriba');
  assert.equal(am.lotes[0].nombre, 'L-1215-A');
});

test('la presentación trae su dibujito y sus calibres', () => {
  const db = base();
  guardarPresentacion(db, { id: art(db, 'Carton Amarilla', '50/55'),
    nombre: 'Carton Amarilla', destino: 'comercial', envase: 'Caja 8 kg',
    por_bulto: 1, kg_unidad: 8, calibre: '50/55', categoria: 'I', emoji: '📦' });
  const b = art(db, 'Carton Amarilla', '60/70');
  entra(db, 1, 10, '1');
  entra(db, b, 20, '2');
  const g = stockPorPresentacion(db);
  const uno = g.filter((x) => x.emoji === '📦')[0];
  assert.ok(uno, 'no devolvió el emoji');
  assert.deepEqual(uno.calibres, ['50/55']);
});

test('UN SOLO CARÁCTER DE DIBUJITO, aunque peguen tres', () => {
  // Pegar «📦📦📦» o una palabra rompe el alto de la baldosa y desalinea la
  // fila entera.
  const db = base();
  const id = guardarPresentacion(db, { nombre: 'X', destino: 'comercial',
    por_bulto: 1, kg_unidad: 8, emoji: '📦📦📦' }).id;
  assert.equal(presentaciones(db).filter((x) => x.id === id)[0].emoji, '📦');
  // Y un emoji COMPUESTO no se parte al medio: 🗳️ son dos code points y
  // cortar con slice(0,1) devuelve medio dibujo.
  const dos = guardarPresentacion(db, { nombre: 'Y', destino: 'comercial',
    por_bulto: 1, kg_unidad: 8, emoji: '🗳️' }).id;
  assert.equal(presentaciones(db).filter((x) => x.id === dos)[0].emoji, '🗳️');
  // Sin dibujito se guarda NULL, no una cadena vacía: la pantalla pregunta
  // por la verdad o la mentira del campo.
  const tres = guardarPresentacion(db, { nombre: 'Z', destino: 'comercial',
    por_bulto: 1, kg_unidad: 8, emoji: '' }).id;
  assert.equal(presentaciones(db).filter((x) => x.id === tres)[0].emoji, null);
});

test('lo que se despachó NO figura en el stock por presentación', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  entra(db, a, 100, '1');
  const x = abrirDespacho(db, { fecha: F });
  agregarAlDespacho(db, x.id, { lote_id: 10, destino: 'comercial',
    presentacion_id: a, calibre: '50/55', bultos: 100 });
  assert.equal(stockPorPresentacion(db).length, 0,
    'una presentación agotada sigue apareciendo');
});

test('se ordena por destino y después por el orden del catálogo', () => {
  // La pantalla los pinta en bandas por destino: si no vienen juntos, una
  // misma banda aparece dos veces.
  const db = base();
  const c = guardarPresentacion(db, { nombre: 'Caja', destino: 'comercial',
    por_bulto: 1, kg_unidad: 8, orden: 50 }).id;
  const v = guardarPresentacion(db, { nombre: 'Verde', destino: 'verde',
    por_bulto: 1, kg_unidad: 8, orden: 10 }).id;
  const d = guardarPresentacion(db, { nombre: 'Descarte', destino: 'descarte',
    por_bulto: 1, kg_unidad: 8, orden: 10 }).id;
  entra(db, c, 10, '1'); entra(db, v, 10, '2'); entra(db, d, 10, '3');
  const g = stockPorPresentacion(db);
  const dest = g.map((x) => x.destino);
  assert.deepEqual([...new Set(dest)], dest, 'un destino aparece en dos tandas');
});

test('EL ORDEN ES COMERCIAL, VERDE, DESCARTE — no alfabético', () => {
  // Alfabético pone el descarte antes que el verde, y la pantalla muestra lo
  // que se tira arriba de lo que se reprocesa. El orden es de mejor a peor,
  // que es el de DESTINOS. Y el SQL de abajo ordena alfabético, así que esto
  // NO sale solo: depender de ese ORDER BY sería una trampa para el día que
  // cambie.
  const db = base();
  for (const [n, d] of [['Caja', 'comercial'], ['Blanca Verde', 'verde'],
    ['Blanca Descarte', 'descarte']]) {
    const id = guardarPresentacion(db, { nombre: n, destino: d, por_bulto: 1,
      kg_unidad: 8 }).id;
    entra(db, id, 10, 'u' + id);
  }
  assert.deepEqual(stockPorPresentacion(db).map((x) => x.destino),
    ['comercial', 'verde', 'descarte']);
});

test('una presentación que CAMBIÓ de destino no junta los dos en una baldosa', () => {
  // El destino se congela en cada carga, así que cambiarlo en el catálogo deja
  // filas viejas con el anterior. Agrupar sólo por presentación las juntaría:
  // una baldosa que dice «comercial» con cajas de descarte adentro.
  const db = base();
  const a = guardarPresentacion(db, { nombre: 'Caja', destino: 'comercial',
    por_bulto: 1, kg_unidad: 8 }).id;
  entra(db, a, 40, '1');
  guardarPresentacion(db, { id: a, nombre: 'Caja', destino: 'descarte',
    por_bulto: 1, kg_unidad: 8 });
  entra(db, a, 10, '2');

  const g = stockPorPresentacion(db);
  assert.equal(g.length, 2, 'juntó dos destinos en una sola baldosa');
  assert.equal(g.filter((x) => x.destino === 'comercial')[0].bultos, 40);
  assert.equal(g.filter((x) => x.destino === 'descarte')[0].bultos, 10);
});
