// ══ 🖼️ EL DIBUJO PROPIO DE UNA PRESENTACIÓN ════════════════════════════════
//
// Andy, 1/11/2026: «quiero yo poder subirle algún dibujito desde la
// computadora, ya estuve armando unos emoticones».
//
// La pantalla lo achica a 96 × 96 PNG con un <canvas> antes de mandarlo, pero
// ESO NO ES UNA GARANTÍA DE NADA: el endpoint se llama igual con curl, y la
// pantalla de mañana puede tener un bug. Lo que se clava acá es lo que pasa
// cuando llega algo que no es lo que la pantalla manda:
//
//   1. UN SVG. Es un documento, no una imagen: puede traer un <script> adentro,
//      y servido desde el mismo origen que el panel ese script corre con la
//      sesión de quien lo abra.
//   2. ALGO QUE DICE SER PNG Y NO LO ES. El "data:image/png" del encabezado lo
//      escribe quien manda el pedido y no prueba nada.
//   3. UNA IMAGEN ENORME. Se muestra a 24 píxeles; 4 MB es ancho de banda
//      tirado en cada carga de la pantalla.
//   4. UN NOMBRE DE ARCHIVO QUE VIENE DE AFUERA. Es por donde entra un "../..".
//   5. LA RUTA DEL ARCHIVO EN UN JSON. Es la misma regla que la foto de la
//      tarjeta de un contacto, y la tabla se lee con SELECT *.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

import {
  guardarPresentacion, presentaciones, guardarIcono, borrarIcono, rutaDelIcono,
  iconoDesdeDataUrl, medidaPNG, sinRutaDeIcono, stockPorPresentacion,
  registrarProceso, ICONO_MAX_BYTES, ICONO_MAX_LADO,
} from '../src/servicios/galpon.js';

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
      sector_id INTEGER, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca) VALUES (10,'L-1','El Abuelo');
    CREATE TABLE pa_sectores (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT);
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER,
      cultivo TEXT, campaña TEXT, es_perenne INTEGER DEFAULT 0);
    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
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
      mixto INTEGER NOT NULL DEFAULT 0, origen TEXT NOT NULL DEFAULT 'proceso', fecha_empaque TEXT, bultos REAL, kilos REAL,
      observacion TEXT, abierto_en TEXT, cerrado_en TEXT, usuario_id INTEGER,
      usuario TEXT, eliminado_en TEXT);
    CREATE TABLE gal_procesos (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE,
      fecha TEXT NOT NULL, lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT,
      destino TEXT NOT NULL, presentacion_id INTEGER, presentacion TEXT, envase TEXT,
      categoria TEXT, calibre TEXT, variedad TEXT, renspa TEXT, cuartel TEXT,
      bultos REAL, por_bulto REAL, kg_unidad REAL, kilos REAL NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'ingreso', reparto TEXT,
      repartido INTEGER NOT NULL DEFAULT 0, pallet_id INTEGER, partido_de INTEGER, despacho_id INTEGER,
      observacion TEXT, estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT,
      usuario_id INTEGER, usuario TEXT, creado_en TEXT, eliminado_en TEXT);
  `);
  return db;
}

const art = (db, nombre) => guardarPresentacion(db, { nombre, destino: 'comercial',
  envase: 'Caja', por_bulto: 1, kg_unidad: 8 }).id;

// ── UN PNG DE VERDAD, armado a mano ───────────────────────────────────────
// Se construye en vez de traerse de un archivo: así el test dice exactamente
// qué se está probando, y cambiar el ancho para el caso de la imagen enorme es
// cambiar un número.
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(tipo, datos) {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'latin1'), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([largo, cuerpo, crc]);
}
function png(ancho, alto) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; ihdr[9] = 6;          // 8 bits, RGBA
  // Una fila de ceros por línea, con su byte de filtro adelante.
  const crudo = Buffer.alloc(alto * (1 + ancho * 4));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(crudo)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const url = (buf) => 'data:image/png;base64,' + buf.toString('base64');

// Un disco de mentira: el servicio recibe el io por parámetro justamente para
// que estos tests no escriban un archivo en ningún lado.
function discoFalso() {
  const files = new Map();
  return {
    files,
    escribir(nombre, buf) { files.set(nombre, buf); return { ok: true, ruta: '/x/' + nombre }; },
    borrar(ruta) { files.delete(String(ruta).replace('/x/', '')); },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 1 · QUÉ SE ACEPTA
// ══════════════════════════════════════════════════════════════════════════
test('un PNG de 96 × 96 entra', () => {
  const r = iconoDesdeDataUrl(url(png(96, 96)));
  assert.equal(r.ok, true, r.motivo);
  assert.deepEqual(r.medida, { ancho: 96, alto: 96 });
});

test('UN SVG NO ENTRA, aunque sea una imagen', () => {
  // Un SVG es un DOCUMENTO: puede traer un <script> adentro, y servido desde
  // el mismo origen que el panel ese script corre con la sesión de quien lo
  // abra. El que quiera subir uno lo exporta a PNG.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const r = iconoDesdeDataUrl('data:image/svg+xml;base64,'
    + Buffer.from(svg).toString('base64'));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /PNG/);
});

test('ALGO QUE DICE SER PNG Y NO LO ES tampoco entra', () => {
  // El "data:image/png" del encabezado lo escribe quien manda el pedido: lo
  // que decide son los magic bytes.
  const r = iconoDesdeDataUrl('data:image/png;base64,'
    + Buffer.from('<svg onload=alert(1)>').toString('base64'));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no es un PNG/i);
});

test('un JPG renombrado a PNG no entra', () => {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
  assert.equal(iconoDesdeDataUrl(url(jpg)).ok, false);
});

test('UNA IMAGEN ENORME no entra: se muestra a 24 píxeles', () => {
  const r = iconoDesdeDataUrl(url(png(4000, 4000)));
  assert.equal(r.ok, false);
  assert.match(r.motivo, new RegExp(String(ICONO_MAX_LADO)));
});

test('el límite de lado es exacto: el máximo entra, uno más no', () => {
  assert.equal(iconoDesdeDataUrl(url(png(ICONO_MAX_LADO, ICONO_MAX_LADO))).ok, true);
  assert.equal(iconoDesdeDataUrl(url(png(ICONO_MAX_LADO + 1, ICONO_MAX_LADO))).ok, false);
  assert.equal(iconoDesdeDataUrl(url(png(ICONO_MAX_LADO, ICONO_MAX_LADO + 1))).ok, false);
});

test('un PNG que pesa de más no entra aunque sea chico de lado', () => {
  // Un PNG de 200 × 200 con basura incompresible adentro: las dimensiones
  // pasan y el peso no. Son dos chequeos distintos y hacen falta los dos.
  const base = png(200, 200);
  const relleno = Buffer.alloc(ICONO_MAX_BYTES + 1000, 7);
  const r = iconoDesdeDataUrl(url(Buffer.concat([base, relleno])));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /KB/);
});

test('vacío, basura y un data url de otra cosa no explotan', () => {
  for (const v of [null, '', '   ', 'pepe', 'data:image/png;base64,',
    'data:text/html;base64,aGk=', 'data:image/png;base64,no-es-base64!!']) {
    const r = iconoDesdeDataUrl(v);
    assert.equal(r.ok, false, 'aceptó ' + JSON.stringify(v));
    assert.ok(r.motivo, 'rechazó sin decir por qué: ' + JSON.stringify(v));
  }
});

test('medidaPNG lee el IHDR y no se cree cualquier cosa', () => {
  assert.deepEqual(medidaPNG(png(120, 64)), { ancho: 120, alto: 64 });
  assert.equal(medidaPNG(Buffer.alloc(10)), null, 'leyó un buffer corto');
  assert.equal(medidaPNG(null), null);
  // La firma correcta pero sin IHDR: un PNG al que le cambiaron el primer chunk.
  const falso = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4), Buffer.from('IDAT'), Buffer.alloc(12)]);
  assert.equal(medidaPNG(falso), null);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · GUARDARLO
// ══════════════════════════════════════════════════════════════════════════
test('guardar el dibujo deja la versión, que es lo que rompe la caché', () => {
  const db = base();
  const id = art(db, 'Caja');
  const io = discoFalso();
  const r = guardarIcono(db, id, url(png(96, 96)), io);
  assert.equal(r.ok, true, r.motivo);
  assert.ok(r.icono_v, 'no devolvió la versión');
  // Sin ?v= el navegador seguiría mostrando el anterior: misma dirección,
  // misma caché, y la caché es de un año.
  const dos = guardarIcono(db, id, url(png(64, 64)), io);
  assert.notEqual(dos.icono_v, r.icono_v, 'la versión no cambió al subir otro');
});

test('EL NOMBRE DEL ARCHIVO LO PONE EL SERVIDOR, sale del id', () => {
  // Un nombre que viene de afuera es por donde entra un "../.." y se escribe
  // en cualquier lado del disco.
  const db = base();
  const id = art(db, 'Caja');
  const io = discoFalso();
  guardarIcono(db, id, url(png(96, 96)), io);
  assert.deepEqual([...io.files.keys()], ['pres-' + id + '.png']);
  assert.equal(rutaDelIcono(db, id), '/x/pres-' + id + '.png');
});

test('si el disco falla, la base NO queda apuntando a un archivo que no está', () => {
  const db = base();
  const id = art(db, 'Caja');
  const io = { escribir: () => ({ ok: false, motivo: 'disco lleno' }), borrar() {} };
  const r = guardarIcono(db, id, url(png(96, 96)), io);
  assert.equal(r.ok, false);
  assert.equal(rutaDelIcono(db, id), null, 'grabó la ruta igual');
});

test('una presentación que no existe no guarda nada', () => {
  const db = base();
  const io = discoFalso();
  assert.equal(guardarIcono(db, 9999, url(png(96, 96)), io).ok, false);
  assert.equal(guardarIcono(db, 'pepe', url(png(96, 96)), io).ok, false);
  assert.equal(io.files.size, 0, 'escribió un archivo igual');
});

test('quitar el dibujo borra el archivo Y la referencia', () => {
  const db = base();
  const id = art(db, 'Caja');
  const io = discoFalso();
  guardarIcono(db, id, url(png(96, 96)), io);
  assert.equal(borrarIcono(db, id, io).ok, true);
  assert.equal(rutaDelIcono(db, id), null);
  assert.equal(io.files.size, 0, 'el archivo quedó huérfano en el disco');
  // Y la presentación sigue existiendo: se quitó el dibujo, no la caja.
  assert.equal(presentaciones(db).filter((x) => x.id === id).length, 1);
});

test('quitar un dibujo que no está no explota', () => {
  const db = base();
  const id = art(db, 'Caja');
  const io = discoFalso();
  assert.equal(borrarIcono(db, id, io).ok, true);
  assert.equal(borrarIcono(db, 9999, io).ok, false);
});

test('si borrar el archivo falla, la referencia se suelta igual', () => {
  // Al revés —borrar el archivo primero y la fila después— un error del disco
  // deja la fila apuntando a algo que ya no existe, y la pantalla muestra un
  // cuadradito roto que nadie puede sacar.
  const db = base();
  const id = art(db, 'Caja');
  const io = discoFalso();
  guardarIcono(db, id, url(png(96, 96)), io);
  const r = borrarIcono(db, id, { borrar() { throw new Error('permiso denegado'); } });
  assert.equal(r.ok, true);
  assert.equal(rutaDelIcono(db, id), null);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LA RUTA NO SALE EN NINGÚN JSON
// ══════════════════════════════════════════════════════════════════════════
test('LA RUTA DEL ARCHIVO NO SALE EN EL LISTADO', () => {
  // Misma regla que la foto de la tarjeta de un contacto. La tabla se lee con
  // SELECT *, así que la columna viaja sola si nadie la saca.
  const db = base();
  const id = art(db, 'Caja');
  guardarIcono(db, id, url(png(96, 96)), discoFalso());
  const p = presentaciones(db).filter((x) => x.id === id)[0];
  assert.ok(!('icono' in p), 'la ruta del archivo salió en el JSON');
  assert.equal(p.tiene_icono, 1);
  assert.ok(p.icono_v, 'sin la versión la pantalla no puede armar la URL');
});

test('tiene_icono dice 0 cuando no hay, y la ruta tampoco está', () => {
  const db = base();
  const id = art(db, 'Caja');
  const p = presentaciones(db).filter((x) => x.id === id)[0];
  assert.ok(!('icono' in p));
  assert.equal(p.tiene_icono, 0);
});

test('sinRutaDeIcono sirve para una fila sola y para una lista', () => {
  assert.equal('icono' in sinRutaDeIcono({ id: 1, icono: '/x/a.png' }), false);
  assert.equal(sinRutaDeIcono({ id: 1, icono: '/x/a.png' }).tiene_icono, 1);
  assert.equal(sinRutaDeIcono([{ id: 1, icono: null }])[0].tiene_icono, 0);
  // Y no explota con lo que no es una fila.
  assert.equal(sinRutaDeIcono(null), null);
  assert.deepEqual(sinRutaDeIcono([]), []);
});

test('EL STOCK TRAE LA VERSIÓN Y NUNCA LA RUTA', () => {
  // La baldosa necesita saber si hay dibujo y poder romper la caché; la ruta
  // del archivo no tiene por qué viajar.
  const db = base();
  const id = art(db, 'Caja');
  guardarIcono(db, id, url(png(96, 96)), discoFalso());
  registrarProceso(db, { fecha: '2026-12-15', lote_id: 10, presentacion_id: id,
    bultos: 40, uuid: '1' });
  const g = stockPorPresentacion(db)[0];
  assert.ok(g.icono_v, 'la baldosa no sabe que hay dibujo');
  assert.ok(!('icono' in g), 'la ruta del archivo salió en el stock');
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LAS DOS DEFENSAS, POR SEPARADO
// ══════════════════════════════════════════════════════════════════════════
// Estas cuatro salieron de la mutación: los tests de arriba pasaban igual con
// cada defensa rota, porque la otra tapaba el agujero. Un test que pasa por la
// segunda defensa no prueba la primera, y el día que la segunda se mueva nadie
// se entera de que la primera no estaba.
test('EL TIPO SE RECHAZA ANTES DE DECODIFICAR, y lo dice distinto', () => {
  // El regex del tipo corta antes de pasar megabytes de base64 por
  // Buffer.from para algo que nunca va a servir. Y el mensaje es otro: «tiene
  // que ser un PNG» manda a exportar el archivo, «eso no es un PNG» manda a
  // mirar si el archivo está roto. Son dos problemas distintos.
  const jpgReal = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
  const porTipo = iconoDesdeDataUrl('data:image/jpeg;base64,'
    + jpgReal.toString('base64'));
  assert.equal(porTipo.ok, false);
  assert.match(porTipo.motivo, /tiene que ser un PNG/,
    'rechazó por el contenido cuando el tipo ya decía que no era PNG');

  // El mismo archivo DISFRAZADO de PNG cae por la otra defensa, con el otro
  // mensaje.
  const porContenido = iconoDesdeDataUrl('data:image/png;base64,'
    + jpgReal.toString('base64'));
  assert.equal(porContenido.ok, false);
  assert.match(porContenido.motivo, /Eso no es un PNG/);
});

test('LA FIRMA SE VERIFICA, no alcanza con que diga IHDR', () => {
  // Un archivo armado a mano con "IHDR" en la posición 12 pero sin los ocho
  // bytes de firma: el chequeo del IHDR lo deja pasar y el de la firma no.
  // El 0x89 inicial está justamente para que un archivo corrupto o pasado por
  // un conversor de texto se note.
  const falso = Buffer.alloc(30);
  falso.write('IHDR', 12, 'latin1');
  falso.writeUInt32BE(96, 16);
  falso.writeUInt32BE(96, 20);
  assert.equal(medidaPNG(falso), null, 'aceptó un archivo sin la firma PNG');
  assert.equal(iconoDesdeDataUrl(url(falso)).ok, false);
});

test('LA VERSIÓN SALE DEL CONTENIDO, no de la hora', () => {
  // Con la hora, dos subidas en el mismo milisegundo —un doble clic— daban la
  // MISMA versión, o sea la misma URL, o sea el navegador seguía mostrando el
  // anterior durante el año que dura la caché. Se prueba al revés, que es
  // determinista: el MISMO archivo tiene que dar la MISMA versión.
  const db = base();
  const id = art(db, 'Caja');
  const io = discoFalso();
  const buf = png(96, 96);
  const a = guardarIcono(db, id, url(buf), io);
  /* Contra el hash del contenido y no contra otra subida: «dos subidas dan lo
     mismo» se cumple con la hora cada vez que caen en el mismo milisegundo, o
     sea casi siempre, y entonces el test pasa con el código roto. */
  assert.equal(a.icono_v,
    crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12),
    'la versión no sale del contenido del archivo');
  // El mismo archivo, la misma versión: no se le pide al navegador que vuelva
  // a bajar algo que ya tiene.
  assert.equal(guardarIcono(db, id, url(buf), io).icono_v, a.icono_v);
  // Y uno distinto, una distinta.
  assert.notEqual(guardarIcono(db, id, url(png(64, 64)), io).icono_v, a.icono_v);
});

test('EL STOCK COPIA CAMPO POR CAMPO, no el catálogo entero', () => {
  // El SELECT nombra las columnas Y el armado copia sólo las que necesita. Son
  // dos defensas y hacen falta las dos: con un SELECT * y una copia entera, la
  // ruta del archivo viaja en cada carga del stock sin que nadie lo note.
  const db = base();
  const id = art(db, 'Caja');
  guardarIcono(db, id, url(png(96, 96)), discoFalso());
  registrarProceso(db, { fecha: '2026-12-15', lote_id: 10, presentacion_id: id,
    bultos: 40, uuid: '1' });
  const g = stockPorPresentacion(db)[0];
  /* El conjunto EXACTO, no una lista de ausencias: «no está icono» pasa igual
     con el catálogo entero copiado adentro, porque el SELECT ya lo dejó afuera
     — las dos defensas se tapaban y ninguna quedaba probada. Así, cualquier
     clave que aparezca sin querer se cae acá y hay que decidirla a mano. */
  assert.deepEqual(Object.keys(g).sort(), [
    'bultos', 'calibres', 'destino', 'emoji', 'granel', 'icono_v', 'kilos',
    'lotes', 'nombre', 'orden', 'presentacion_id',
  ]);
});
