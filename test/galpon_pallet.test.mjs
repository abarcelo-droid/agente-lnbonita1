// ══ 🧱 EL PALLET Y SU TARJETÓN ═══════════════════════════════════════════
//
// Andy, 1/11/2026: «la parte donde cargamos el proceso tiene que ser algo más
// parecido a "Cierre de Pallet", de ahí quiero que salga un tarjetón para
// imprimir».
//
// El pallet no reemplaza la carga: la envuelve. Lo que falla callado acá sale
// IMPRESO y se va en un camión:
//
//   1. EL NÚMERO REPETIDO. Dos pallets con el mismo número es lo peor que le
//      puede pasar a un remito: no hay forma de saber cuál llegó.
//   2. UN HUECO EN EL CORRELATIVO. Un número que se saltea es un número que
//      después nadie puede explicar.
//   3. «MIXTO» DECIDIDO A MANO. Una etiqueta que dice homogéneo sobre un
//      pallet que abajo tiene ciruela.
//   4. CERRAR UN PALLET VACÍO. Gasta un número del correlativo en una etiqueta
//      de cero cajas.
//   5. BORRAR UN PALLET CON CARGAS ADENTRO. Esas cajas existen y quedarían
//      contadas en el stock y en ningún pallet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  guardarPresentacion, guardarDatosDeLote, registrarProceso, borrarProceso,
  palletAbierto, abrirPallet, contenidoDelPallet, cerrarPallet, proximoNumero,
  reabrirPallet, borrarPallet, sacarDelPallet, pallets, palletPorNumero,
  stockGalpon,
} from '../src/servicios/galpon.js';

const F = '2026-12-15';

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_sectores (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT);
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
                           sector_id INTEGER, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca) VALUES
      (10,'L-1215-A','El Abuelo'), (11,'L-1215-C','La Estación');
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER,
      cultivo TEXT, campaña TEXT, es_perenne INTEGER DEFAULT 0);
    INSERT INTO pa_cultivos_lote (lote_id,cultivo,es_perenne) VALUES
      (10,'Damasco',1), (11,'Ciruela',1);
    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
    INSERT INTO gal_config (clave,valor) VALUES ('pallet_prefijo','PC');
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
      granel INTEGER DEFAULT 0, emoji TEXT, icono TEXT, icono_v TEXT, categoria TEXT NOT NULL DEFAULT 'I', calibre TEXT,
      color TEXT, orden INTEGER DEFAULT 100, activo INTEGER DEFAULT 1,
      creado_en TEXT, eliminado_en TEXT);
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
      repartido INTEGER NOT NULL DEFAULT 0, pallet_id INTEGER, partido_de INTEGER,
      despacho_id INTEGER, observacion TEXT,
      estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT, usuario_id INTEGER,
      usuario TEXT, creado_en TEXT, eliminado_en TEXT);
    -- REABRIR UN PALLET MIRA SI ESTÁ EN UN DESPACHO (V1143): reabrirlo lo devolvería
    -- al piso y el remito pasaría a llevar cajas sueltas donde decía un pallet, con
    -- el tarjetón ya impreso. Por eso esta base necesita la tabla aunque el archivo
    -- no pruebe despachos: la dependencia es de verdad.
    CREATE TABLE gal_despachos (id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT UNIQUE,
      estado TEXT NOT NULL DEFAULT 'borrador', fecha TEXT NOT NULL, destinatario TEXT,
      bultos REAL, kilos REAL, eliminado_en TEXT);
  `);
  guardarDatosDeLote(db, { lote_id: 10, renspa: '12.345.6.78901/00',
    variedad: 'Bulida', cuartel: 'C-07' });
  guardarDatosDeLote(db, { lote_id: 11, renspa: '12.345.6.78901/00',
    variedad: 'Red Beaut', cuartel: 'C-09' });
  return db;
}

const art = (db, nombre, calibre, cat) => guardarPresentacion(db, {
  nombre, destino: 'comercial', envase: 'Caja 5 kg', por_bulto: 10, kg_unidad: 0.5,
  calibre, categoria: cat }).id;

// ══════════════════════════════════════════════════════════════════════════
// 1 · UN SOLO PALLET ABIERTO
// ══════════════════════════════════════════════════════════════════════════
test('LA PRIMERA CARGA ABRE EL PALLET SOLA', () => {
  // Pedirle al operador que lo abra antes de la primera caja es un paso que se
  // va a saltear, y esa caja quedaría suelta sin que nada avise.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  assert.equal(palletAbierto(db), null);
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40, uuid: '1' });
  const p = palletAbierto(db);
  assert.ok(p, 'la carga no abrió ningún pallet');
  assert.equal(p.estado, 'abierto');
  assert.equal(contenidoDelPallet(db, p.id).length, 1);
});

test('TODAS LAS CARGAS VAN AL MISMO PALLET hasta que se cierre', () => {
  // Dos abiertos a la vez son dos montones en el playón y ninguna forma de
  // saber a cuál fue la caja que se acaba de cargar.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  for (const u of ['1', '2', '3']) {
    registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 10, uuid: u });
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gal_pallets WHERE estado = 'abierto'")
    .get().n, 1);
  assert.equal(contenidoDelPallet(db, palletAbierto(db).id)[0].bultos, 30);
});

test('abrir cuando ya hay uno abierto devuelve el que hay', () => {
  const db = base();
  const a = abrirPallet(db, { fecha_empaque: F });
  const b = abrirPallet(db, { fecha_empaque: F });
  assert.equal(b.id, a.id);
  assert.equal(b.ya_estaba, true);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LO QUE TIENE ADENTRO
// ══════════════════════════════════════════════════════════════════════════
test('EL CONTENIDO SE AGRUPA POR ARTÍCULO, que es un renglón del tarjetón', () => {
  // Dos cargas del mismo artículo y el mismo lote son un solo renglón: la
  // etiqueta dice cuántas cajas hay, no cuántas veces se apretó Enter.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 20, uuid: '1' });
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 20, uuid: '2' });
  const c = contenidoDelPallet(db, palletAbierto(db).id);
  assert.equal(c.length, 1);
  assert.equal(c[0].bultos, 40);
  assert.equal(c[0].cargas, 2);
});

test('DOS CALIBRES DEL MISMO ENVASE SON DOS RENGLONES', () => {
  // Es la razón de que el calibre viva en el artículo: cada uno es una línea
  // distinta del tarjetón.
  const db = base();
  const a = art(db, 'Caja I', '50/55');
  const b = art(db, 'Caja II', '45/50', 'II');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40, uuid: '1' });
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: b, bultos: 30, uuid: '2' });
  const c = contenidoDelPallet(db, palletAbierto(db).id);
  assert.equal(c.length, 2);
  assert.deepEqual(c.map((x) => x.calibre).sort(), ['45/50', '50/55']);
});

test('cada renglón lleva SU lote y SU renspa', () => {
  // Un pallet mixto puede tener fruta de dos cuadros, y el que lo recibe
  // necesita saber de cuál es cada caja.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40, uuid: '1' });
  registrarProceso(db, { fecha: F, lote_id: 11, presentacion_id: a, bultos: 25, uuid: '2' });
  const c = contenidoDelPallet(db, palletAbierto(db).id);
  const porLote = {};
  for (const x of c) porLote[x.lote_nombre] = x;
  assert.equal(porLote['L-1215-A'].variedad, 'Bulida');
  assert.equal(porLote['L-1215-C'].variedad, 'Red Beaut');
  assert.equal(porLote['L-1215-C'].cuartel, 'C-09');
});

test('lo borrado no cuenta en el pallet', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 40, uuid: '1' });
  borrarProceso(db, r.id);
  assert.deepEqual(contenidoDelPallet(db, palletAbierto(db).id), []);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL CIERRE Y EL NÚMERO
// ══════════════════════════════════════════════════════════════════════════
test('EL NÚMERO SE PONE AL CERRAR, NO AL ABRIR', () => {
  // Un pallet abierto que ya tiene número es un número que se saltea cada vez
  // que alguien abre uno y se arrepiente.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40, uuid: '1' });
  const p = palletAbierto(db);
  assert.equal(p.numero, null);
  const r = cerrarPallet(db, p.id, {});
  assert.equal(r.numero, 'PC-26-00001');
  assert.equal(r.pallet.estado, 'cerrado');
});

test('EL CORRELATIVO ES CORRELATIVO, y lleva el año', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const nums = [];
  for (const u of ['1', '2', '3']) {
    registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 10, uuid: u });
    nums.push(cerrarPallet(db, palletAbierto(db).id, {}).numero);
  }
  assert.deepEqual(nums, ['PC-26-00001', 'PC-26-00002', 'PC-26-00003']);
  // Y el año sale de la fecha de empaque, no del reloj.
  registrarProceso(db, { fecha: '2027-01-10', lote_id: 10, presentacion_id: a,
    bultos: 10, uuid: '4' });
  assert.match(cerrarPallet(db, palletAbierto(db).id, {}).numero, /^PC-27-00001$/);
});

test('MIXTO LO DECIDE EL CONTENIDO, no el que cierra', () => {
  // Dejarlo a criterio de quien cierra es una etiqueta que dice homogéneo
  // sobre un pallet que abajo tiene ciruela.
  const db = base();
  const a = art(db, 'Caja I', '50/55');
  const b = art(db, 'Caja II', '45/50', 'II');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40, uuid: '1' });
  assert.equal(cerrarPallet(db, palletAbierto(db).id, { mixto: 1 }).pallet.mixto, 0);

  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40, uuid: '2' });
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: b, bultos: 30, uuid: '3' });
  assert.equal(cerrarPallet(db, palletAbierto(db).id, { mixto: 0 }).pallet.mixto, 1);
});

test('PARCIAL sí lo elige el operador: el sistema no sabe si va completo', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40, uuid: '1' });
  assert.equal(cerrarPallet(db, palletAbierto(db).id, { parcial: 1 }).pallet.parcial, 1);
});

test('LOS TOTALES SE CONGELAN AL CERRAR', () => {
  // Una carga corregida después no puede cambiar la etiqueta que se fue en el
  // camión.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r1 = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 40, uuid: '1' });
  const cer = cerrarPallet(db, palletAbierto(db).id, {});
  assert.equal(cer.pallet.bultos, 40);
  assert.equal(cer.pallet.kilos, 200);

  borrarProceso(db, r1.id);
  const p = db.prepare('SELECT * FROM gal_pallets WHERE id = ?').get(cer.id);
  assert.equal(p.bultos, 40, 'borrar una carga cambió una etiqueta ya emitida');
});

test('UN PALLET VACÍO NO SE CIERRA: gastaría un número', () => {
  // Es la única excepción a «nada se rechaza después del hecho»: acá no pasó
  // nada todavía.
  const db = base();
  const p = abrirPallet(db, { fecha_empaque: F });
  const r = cerrarPallet(db, p.id, {});
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no tiene nada cargado/);
  assert.equal(proximoNumero(db, F), 'PC-26-00001', 'igual gastó el número');
});

test('cerrar dos veces no es un error ni gasta otro número', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40, uuid: '1' });
  const id = palletAbierto(db).id;
  const uno = cerrarPallet(db, id, {});
  const dos = cerrarPallet(db, id, {});
  assert.equal(dos.ok, true);
  assert.equal(dos.ya_estaba, true);
  assert.equal(dos.pallet.numero, uno.numero);
  assert.equal(proximoNumero(db, F), 'PC-26-00002');
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · REABRIR, BORRAR Y SACAR
// ══════════════════════════════════════════════════════════════════════════
test('REABRIR CONSERVA EL NÚMERO: es el mismo pallet', () => {
  // Soltarlo tiene dos caminos y los dos son malos: reutilizarlo deja DOS pallets con
  // el mismo número —lo peor que le puede pasar a un remito— y dejarlo libre abre un
  // hueco en el correlativo que después nadie puede explicar.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40, uuid: '1' });
  const cer = cerrarPallet(db, palletAbierto(db).id, {});
  assert.equal(cer.numero, 'PC-26-00001');

  const re = reabrirPallet(db, cer.id);
  assert.equal(re.ok, true);
  assert.equal(re.numero, 'PC-26-00001');
  assert.equal(palletAbierto(db).numero, 'PC-26-00001', 'le sacó el número');
  assert.equal(palletAbierto(db).bultos, null, 'dejó los totales congelados de antes');

  // Al volver a cerrarlo es el MISMO número, y el siguiente pallet toma el 2.
  assert.equal(cerrarPallet(db, cer.id, {}).numero, 'PC-26-00001');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 10, uuid: '2' });
  assert.equal(cerrarPallet(db, palletAbierto(db).id, {}).numero, 'PC-26-00002');
});

test('y el correlativo nunca entrega un número dos veces', () => {
  // Con reaperturas en el medio: el próximo siempre sale del MÁXIMO que haya, así que
  // no hay forma de que dos pallets terminen con el mismo.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const vistos = new Set();
  for (let i = 0; i < 4; i++) {
    registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 10,
      uuid: 'u' + i });
    const id = palletAbierto(db).id;
    const n = cerrarPallet(db, id, {}).numero;
    assert.ok(!vistos.has(n), 'el número ' + n + ' se entregó dos veces');
    vistos.add(n);
    if (i === 1) { reabrirPallet(db, id); cerrarPallet(db, id, {}); }
  }
  assert.equal(vistos.size, 4);
});


test('no se reabre si ya hay otro abierto', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 10, uuid: '1' });
  const cer = cerrarPallet(db, palletAbierto(db).id, {});
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 10, uuid: '2' });
  assert.equal(reabrirPallet(db, cer.id).ok, false);
});

test('UN PALLET CON CARGAS ADENTRO NO SE BORRA', () => {
  // Esas cajas existen: borrar el pallet las dejaría contadas en el stock y en
  // ningún pallet.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40, uuid: '1' });
  const id = palletAbierto(db).id;
  assert.equal(borrarPallet(db, id).ok, false);
  assert.equal(stockGalpon(db).kilos, 200, 'las cajas dejaron de contar');
  // Vacío sí.
  assert.equal(borrarPallet(db, abrirPallet(db, {}).id).ok, false);  // sigue el de arriba
});

test('sacar una carga del pallet no la borra', () => {
  // La caja existe, estaba en el montón equivocado.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 40, uuid: '1' });
  assert.equal(sacarDelPallet(db, r.id).ok, true);
  assert.deepEqual(contenidoDelPallet(db, palletAbierto(db).id), []);
  assert.equal(stockGalpon(db).kilos, 200, 'sacarla del pallet la borró del stock');
});

test('de un pallet CERRADO no se saca nada sin reabrirlo', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 40, uuid: '1' });
  cerrarPallet(db, palletAbierto(db).id, {});
  const x = sacarDelPallet(db, r.id);
  assert.equal(x.ok, false);
  assert.match(x.motivo, /cerrado/);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LA LISTA Y LA BÚSQUEDA
// ══════════════════════════════════════════════════════════════════════════
test('el ABIERTO trae sus totales al vuelo, aunque no estén congelados', () => {
  // Mostrar su casillero vacío sería esconder lo único que importa de un
  // pallet abierto: cuánto lleva.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40, uuid: '1' });
  const ls = pallets(db);
  assert.equal(ls[0].estado, 'abierto');
  assert.equal(ls[0].bultos, 40);
  assert.equal(ls[0].kilos, 200);
});

test('BUSCAR POR NÚMERO: es lo único que tiene quien llama con un reclamo', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a, bultos: 40, uuid: '1' });
  const cer = cerrarPallet(db, palletAbierto(db).id, {});
  const p = palletPorNumero(db, cer.numero);
  assert.ok(p);
  assert.equal(p.contenido.length, 1);
  assert.equal(p.contenido[0].renspa, '12.345.6.78901/00');
  assert.equal(palletPorNumero(db, 'PC-26-99999'), null);
  assert.equal(palletPorNumero(db, ''), null);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · EL TARJETÓN
// ══════════════════════════════════════════════════════════════════════════
// Se GENERA de verdad y se lee el texto DIBUJADO, inflando los streams: es más
// fiel que buscar en el binario, porque lee lo que el PDF manda a dibujar.
async function textoDelPDF(buf) {
  const zlib = await import('node:zlib');
  let txt = '';
  const s = buf.toString('latin1');
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    try {
      txt += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch (e) { /* no todos los streams son texto */ }
  }
  const octal = new RegExp('\\\\([0-7]{3})', 'g');
  return [...txt.matchAll(/\(([^)]*)\)\s*Tj/g)].map((x) => x[1])
    .join(' | ').replace(octal, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

/* Y lo mismo CON la posición y el tamaño de letra. La hoja es A4 apaisada, así que
   la `y` se cuenta desde arriba en milímetros: es como se mira una etiqueta. */
const PT = 2.8346457;          // puntos por milímetro
const ALTO = 210;

async function dibujadoDelPDF(buf) {
  const zlib = await import('node:zlib');
  let t = '';
  const s = buf.toString('latin1');
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    try { t += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); }
    catch (e) { /* no todos los streams son texto */ }
  }
  const re = /\/[A-Za-z0-9]+\s+([\d.]+)\s+Tf[\s\S]*?([\d.-]+)\s+([\d.-]+)\s+Td\s*\(([^)]*)\)\s*Tj/g;
  return [...t.matchAll(re)].map((m) => ({ tam: Number(m[1]),
    x: Number(m[2]) / PT, y: ALTO - Number(m[3]) / PT, texto: m[4] }));
}

const CFG = { marca: 'LA NIÑA BONITA', comercializa: 'San Gerónimo S.A. · CUIT 30-67325443-4',
              origen: 'Carpintería, San Juan · Producto argentino' };

test('EL TARJETÓN HOMOGÉNEO lleva el producto grande y los seis datos', async () => {
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const buf = await galponPalletPDF(
    { numero: 'PC-26-01234', parcial: 0, mixto: 0, fecha_empaque: '2026-12-15',
      bultos: 120, kilos: 600 },
    [{ producto: 'Damasco', variedad: 'Bulida', categoria: 'I', calibre: '50/55',
       envase: 'Caja 5 kg', lote_nombre: 'L-1215-A', renspa: '12.345.6.78901/00',
       cuartel: 'C-07', bultos: 120, kilos: 600 }], CFG);
  const t = await textoDelPDF(buf);
  for (const esperado of ['PC-26-01234', 'DAMASCO', 'BULIDA', 'CAT. I', 'CALIBRE 50/55',
                          'CAJA 5 KG', '120', '600', 'L-1215-A', '15/12/2026', 'C-07',
                          '12.345.6.78901/00']) {
    assert.ok(t.includes(esperado), 'al tarjetón le falta ' + esperado + '\n' + t);
  }
  // Sin chapas: no es ni mixto ni parcial, y una chapa que aparece siempre no la
  // mira nadie — y entonces tampoco la miran el día que dice PARCIAL.
  assert.ok(!t.includes('MIXTO'), 'un pallet de un solo artículo salió marcado mixto');
  assert.ok(!t.includes('PARCIAL'));
});

test('EL TARJETÓN MIXTO lleva una línea por artículo, SIN su lote', async () => {
  /* Andy, 5/11/2026: «no pongas el detalle de cada lote en el tarjetón, que
     confunde». Hasta la V1147 este test exigía que los lotes estuvieran. */
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const buf = await galponPalletPDF(
    { numero: 'PC-26-01235', parcial: 1, mixto: 1, fecha_empaque: '2026-12-15',
      bultos: 95, kilos: 550 },
    [{ producto: 'Damasco', variedad: 'Bulida', categoria: 'I', calibre: '50/55',
       envase: 'Caja 5 kg', lote_nombre: 'L-1215-A', renspa: 'R1', bultos: 40, kilos: 200 },
     { producto: 'Damasco', variedad: 'Bulida', categoria: 'II', calibre: '45/50',
       envase: 'Caja 5 kg', lote_nombre: 'L-1215-B', renspa: 'R1', bultos: 30, kilos: 150 },
     { producto: 'Ciruela', variedad: 'Red Beaut', categoria: 'I', calibre: '60/65',
       envase: 'Caja 8 kg', lote_nombre: 'L-1215-C', renspa: 'R2', bultos: 25, kilos: 200 }],
    CFG);
  const t = await textoDelPDF(buf);
  for (const esperado of ['PC-26-01235', 'MIXTO', 'PARCIAL', 'Damasco Bulida',
                          'Ciruela Red Beaut', '40', '30', '25',
                          'TOTAL · Empaque 15/12/2026', '95', '550']) {
    assert.ok(t.includes(esperado), 'al tarjetón mixto le falta ' + esperado + '\n' + t);
  }
  for (const sobra of ['L-1215-A', 'L-1215-C', 'LOTE', 'RENSPA']) {
    assert.ok(!t.includes(sobra), 'el tarjetón mixto sigue diciendo ' + sobra);
  }
});

test('EL MISMO CARTÓN DE TRES LOTES ES UN SOLO RENGLÓN, con las cajas sumadas', async () => {
  /* Es la foto del PC-26-00269: «Caja cartón 35-55» tres veces, 25 + 22 + 2. */
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const caja = (lote, b, k) => ({ producto: 'Damasco', categoria: 'I', calibre: '35-55',
    envase: 'Caja cartón', presentacion: 'Carton', destino: 'comercial',
    lote_nombre: lote, bultos: b, kilos: k });
  const ifco = (lote, b, k) => ({ producto: 'Damasco', categoria: 'I', calibre: '35-55',
    envase: 'IFCO', presentacion: 'IFCO', destino: 'comercial',
    lote_nombre: lote, bultos: b, kilos: k });
  const d = await dibujadoDelPDF(await galponPalletPDF(
    Object.assign({}, unPallet, { mixto: 1, bultos: 63, kilos: 489 }),
    [caja('11-12 y 16-17', 25, 177.94), caja('Damasco', 22, 153.55), caja('13', 2, 11.51),
     ifco('11-12 y 16-17', 8, 108.94), ifco('Damasco', 6, 37.06)], CFG));
  const envases = d.filter((x) => x.texto === 'Caja cartón' || x.texto === 'IFCO');
  assert.equal(envases.length, 2, 'repite el artículo por lote: ' + envases.length);
  // Las cajas sumadas, al centavo de kilo.
  assert.ok(d.some((x) => x.texto === '49'), 'no sumó 25 + 22 + 2');
  // 177,94 + 153,55 + 11,51 = 343 justo, y n2() no escribe decimales en cero.
  assert.ok(d.some((x) => x.texto === '343'), 'no sumó los kilos del cartón');
  assert.ok(d.some((x) => x.texto === '14'), 'no sumó los IFCO');
});

test('UN SOLO ARTÍCULO DE DOS LOTES NO ES MIXTO: modelo grande y «Varios»', async () => {
  /* Antes salía MIXTO, con una tabla de dos renglones iguales. Y un pallet cerrado
     antes de la V1148 trae mixto=1 guardado: la etiqueta no puede creerle a eso. */
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const l = (lote, renspa) => ({ producto: 'Damasco', categoria: 'I', calibre: '35-55',
    envase: 'Caja cartón', presentacion: 'Carton', destino: 'comercial',
    lote_nombre: lote, renspa, cuartel: 'C-1', bultos: 20, kilos: 140 });
  const t = await textoDelPDF(await galponPalletPDF(
    Object.assign({}, unPallet, { mixto: 1, bultos: 40, kilos: 280 }),
    [l('Lote A', 'R-1'), l('Lote B', 'R-2')], CFG));
  assert.ok(!t.includes('MIXTO'), 'un solo artículo salió MIXTO');
  assert.ok(t.includes('DAMASCO'), 'no usó el modelo de un artículo');
  assert.ok(t.includes('40'), 'no sumó las cajas de los dos lotes');
  assert.ok(t.includes('Varios'), 'no dice que son varios lotes');
  assert.ok(!t.includes('Lote A') && !t.includes('R-2'), 'lista los lotes');
  // El cuartel es el mismo en los dos: ése sí se dice.
  assert.ok(t.includes('C-1'), 'tiró un dato que era el mismo para todos');
});

test('con UN solo lote, el homogéneo lo sigue diciendo', async () => {
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const t = await textoDelPDF(await galponPalletPDF(unPallet,
    [{ producto: 'Damasco', categoria: 'I', calibre: '35-55', envase: 'Caja',
       lote_nombre: 'Cuadro 3', renspa: 'R-9', cuartel: 'C-2', bultos: 10, kilos: 70 }],
    CFG));
  for (const e of ['Cuadro 3', 'R-9', 'C-2']) assert.ok(t.includes(e), 'falta ' + e);
  assert.ok(!t.includes('Varios'));
});

test('EL QR LLEVA EL NÚMERO PELADO, no una URL', async () => {
  // La lectora USB se comporta como un teclado: una URL adentro del QR
  // escribiría la URL entera en el casillero donde se espera el número.
  const fuente = (await import('node:fs')).readFileSync(
    (await import('node:url')).fileURLToPath(
      new URL('../src/servicios/galponPalletPDF.js', import.meta.url)), 'utf8');
  assert.match(fuente, /QRCode\.toDataURL\(String\(pallet\.numero\)/);
  assert.ok(!/toDataURL\([^)]*http/.test(fuente), 'el QR lleva una URL adentro');
});

test('el tarjetón de muchos artículos no achica la letra hasta que no se lea', async () => {
  // Una etiqueta que no se lee no sirve. Se dice cuántos quedaron afuera y el
  // detalle completo está en el sistema, con el número.
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const lineas = [];
  for (let i = 0; i < 14; i++) {
    lineas.push({ producto: 'Damasco', variedad: 'Bulida', categoria: 'I',
      calibre: '5' + i + '/6' + i, envase: 'Caja 5 kg', lote_nombre: 'L-' + i,
      renspa: 'R', bultos: 10, kilos: 50 });
  }
  const buf = await galponPalletPDF(
    { numero: 'PC-26-00009', parcial: 0, mixto: 1, fecha_empaque: '2026-12-15',
      bultos: 140, kilos: 700 }, lineas, CFG);
  const t = await textoDelPDF(buf);
  assert.match(t, /y 5 artículos más/);
  assert.ok(t.includes('PC-26-00009'));
});

test('un pallet sin número igual imprime, diciendo que no está cerrado', async () => {
  // Pasa si alguien pide la etiqueta de uno abierto: es mejor una hoja que
  // dice SIN CERRAR que un error que no explica nada.
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const buf = await galponPalletPDF(
    { numero: null, parcial: 0, mixto: 0, fecha_empaque: '2026-12-15', bultos: 10, kilos: 50 },
    [{ producto: 'Damasco', categoria: 'I', envase: 'Caja', lote_nombre: 'L',
       bultos: 10, kilos: 50 }], CFG);
  const t = await textoDelPDF(buf);
  assert.match(t, /SIN CERRAR/);
});

// ══ 📐 LA ETIQUETA USA LA HOJA ENTERA ════════════════════════════════════
//
// Andy, 5/11/2026, con el tarjetón enfrente: «este formato de tarjetón quiero».
//
// Las dos filas de cajas medían 24 mm fijos y terminaban en 130: quedaban
// SESENTA milímetros de hoja en blanco entre el último dato y el pie, casi un
// tercio de la etiqueta. En una hoja que se lee desde un autoelevador eso no
// es aire, es tamaño de letra que se está tirando.
const unaLinea = [{ producto: 'Damasco', variedad: 'Bulida', categoria: 'I',
  calibre: '50/55', envase: 'Caja 5 kg', lote_nombre: 'L-1215-A',
  renspa: '12.345.6.78901/00', cuartel: 'C-07', bultos: 120, kilos: 600 }];
const unPallet = { numero: 'PC-26-01234', parcial: 0, mixto: 0,
  fecha_empaque: '2026-12-15', bultos: 120, kilos: 600 };

test('LAS DOS FILAS DE CAJAS SE REPARTEN LA HOJA, no se amontonan arriba', async () => {
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const d = await dibujadoDelPDF(await galponPalletPDF(unPallet, unaLinea, CFG));
  const uno = d.find((x) => x.texto === 'BULTOS');
  const dos = d.find((x) => x.texto.startsWith('FECHA'));
  const pie = d.find((x) => x.texto.startsWith('Comercializa'));
  assert.ok(uno && dos && pie, 'falta alguno de los tres puntos de referencia');
  /* La segunda fila arranca pasada la mitad de la hoja. Cuando medían 24 mm fijos
     caía en 111 y abajo no había nada hasta el pie, en 196. */
  assert.ok(dos.y > 130, 'la segunda fila quedó arriba, en y=' + dos.y.toFixed(1));
  // Y las dos filas están igual de separadas entre sí que la primera del título.
  assert.ok(dos.y - uno.y > 45,
    'las filas siguen pegadas: ' + (dos.y - uno.y).toFixed(1) + ' mm');
});

test('y el dato crece con la caja: «C-07» sale igual de grande que «120»', async () => {
  /* Había seis tamaños escritos a mano —22, 22, 20, 17, 17, 13— elegidos para que
     el dato más largo entrara a lo ancho. Eso ya lo hace medida(), dato por dato:
     el 13 del RENSPA le bajaba la letra también al CUARTEL, que dice «C-07». */
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const d = await dibujadoDelPDF(await galponPalletPDF(unPallet, unaLinea, CFG));
  const t = (txt) => d.find((x) => x.texto === txt);
  assert.ok(t('120').tam >= 28, 'los bultos salieron a ' + t('120').tam);
  assert.equal(t('C-07').tam, t('120').tam,
    'el cuartel sigue atado a un tamaño propio: ' + t('C-07').tam);
  assert.equal(t('15/12/2026').tam, t('120').tam);
});

test('pero el RENSPA, que es largo, se sigue achicando para entrar', async () => {
  // Es lo que hace que el tamaño pueda salir de la caja y no de una tabla: lo
  // que no entra a lo ancho se achica solo, y sólo eso.
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const d = await dibujadoDelPDF(await galponPalletPDF(unPallet, unaLinea, CFG));
  const renspa = d.find((x) => x.texto.startsWith('12.345'));
  const bultos = d.find((x) => x.texto === '120');
  assert.ok(renspa.tam < bultos.tam, 'el RENSPA no se achicó y se sale de la caja');
  assert.ok(renspa.tam > 13, 'se achicó de más: ' + renspa.tam);
});

test('NADA SE DIBUJA ABAJO DEL PIE, en ninguno de los dos modelos', async () => {
  /* El pie lleva quién comercializa y el origen, que son los datos fiscales de la
     etiqueta. Un dato encima de otro no se lee ninguno de los dos. */
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const muchas = [];
  for (let i = 0; i < 14; i++) {
    muchas.push({ producto: 'Damasco', categoria: 'I', calibre: '5' + i + '/6' + i,
      envase: 'Caja 5 kg', lote_nombre: 'L-' + i, renspa: '12.345.6.78901/00',
      bultos: 10, kilos: 50 });
  }
  for (const [que, lineas] of [['homogéneo', unaLinea], ['mixto', muchas.slice(0, 2)],
                               ['mixto lleno', muchas]]) {
    const d = await dibujadoDelPDF(await galponPalletPDF(
      Object.assign({}, unPallet, { observacion: 'Carga controlada por Juan' }),
      lineas, CFG));
    for (const x of d) {
      // El pie y la observación tienen su lugar reservado abajo de todo.
      if (/^(Comercializa|Origen|Carga controlada)/.test(x.texto)) continue;
      /* 185 y no 189: la observación se dibuja en 188 y la raya del pie en 191, así
         que el contenido tiene que terminar en 184. Con 189 pasaba un total de mixto
         que caía justo encima de la observación — lo encontró la prueba de mutación. */
      assert.ok(x.y <= 185, que + ': «' + x.texto.slice(0, 20) + '» cayó en y='
        + x.y.toFixed(1) + ', encima del pie');
    }
  }
});

test('EL TOTAL DEL MIXTO SE APOYA EN EL PIE, esté lleno o tenga dos artículos', async () => {
  /* Es el número que se controla contra el remito al cargar. Buscarlo a una altura
     distinta en cada etiqueta obliga a leer la hoja entera cada vez. */
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const alturas = [];
  for (const n of [2, 9]) {
    const lineas = [];
    for (let i = 0; i < n; i++) {
      lineas.push({ producto: 'Damasco', categoria: 'I', calibre: '5' + i + '/6' + i,
        envase: 'Caja 5 kg', lote_nombre: 'L-' + i, bultos: 10, kilos: 50 });
    }
    const d = await dibujadoDelPDF(await galponPalletPDF(
      Object.assign({}, unPallet, { mixto: 1 }), lineas, CFG));
    const tot = d.find((x) => x.texto.startsWith('TOTAL'));
    assert.ok(tot, 'no está el total con ' + n + ' artículos');
    assert.ok(tot.y > 170, 'el total quedó colgando en y=' + tot.y.toFixed(1));
    alturas.push(tot.y);
  }
  assert.equal(alturas[0].toFixed(1), alturas[1].toFixed(1),
    'el total cambia de altura según cuántos artículos hay: ' + alturas);
});

test('y el renglón del mixto crece cuando hay pocos artículos', async () => {
  // Con dos artículos, nueve renglones de 8,5 mm dejaban media etiqueta en blanco
  // y la letra igual de chica que con nueve.
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const tam = [];
  for (const n of [2, 9]) {
    const lineas = [];
    for (let i = 0; i < n; i++) {
      lineas.push({ producto: 'Damasco', categoria: 'I', calibre: '5' + i + '/6' + i,
        envase: 'Caja 5 kg', lote_nombre: 'L-' + i, bultos: 10, kilos: 50 });
    }
    const d = await dibujadoDelPDF(await galponPalletPDF(
      Object.assign({}, unPallet, { mixto: 1 }), lineas, CFG));
    tam.push(d.find((x) => x.texto === '50/60').tam);
  }
  assert.ok(tam[0] > tam[1], 'con dos artículos la letra salió igual: ' + tam);
  assert.ok(tam[1] >= 9, 'con nueve se achicó hasta no leerse: ' + tam[1]);
});

test('CADA RENGLÓN DEL MIXTO ESCRIBE ADENTRO DE SU PROPIO RENGLÓN', async () => {
  /* Lo pidió la prueba de mutación: correr el texto hacia abajo dentro de la fila lo
     deja pisando la raya y el renglón siguiente, y como todo sigue arriba del pie,
     ningún otro test lo veía. Se mide contra el PASO entre filas: si la primera está
     más de un renglón abajo del encabezado, el texto se salió de su banda. */
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const lineas = [];
  for (let i = 0; i < 4; i++) {
    lineas.push({ producto: 'Damasco', categoria: 'I', calibre: '5' + i + '/6' + i,
      envase: 'Caja 5 kg', lote_nombre: 'L-' + i, bultos: 10, kilos: 50 });
  }
  const d = await dibujadoDelPDF(await galponPalletPDF(
    Object.assign({}, unPallet, { mixto: 1 }), lineas, CFG));
  const cab = d.find((x) => x.texto === 'PRODUCTO');
  const filas = d.filter((x) => /^5\d\/6\d$/.test(x.texto)).sort((a, b) => a.y - b.y);
  assert.equal(filas.length, 4);
  const paso = filas[1].y - filas[0].y;
  assert.ok(paso > 8, 'las filas quedaron encimadas: paso de ' + paso.toFixed(1) + ' mm');
  assert.ok(filas[0].y - cab.y < paso,
    'la primera fila escribe abajo de su renglón: está a '
    + (filas[0].y - cab.y).toFixed(1) + ' mm del encabezado y el paso es '
    + paso.toFixed(1));
  // Y todas se escriben a la misma distancia de su propia raya.
  for (let i = 1; i < filas.length; i++) {
    assert.ok(Math.abs((filas[i].y - filas[i - 1].y) - paso) < 0.2,
      'la fila ' + i + ' no respeta el paso');
  }
});

test('el pie lleva el CUIT que usa todo el repo', async () => {
  /* 30-67325443-4, el mismo de abasto, liquidaciones y pdfComun.js. Sale de la
     configuración y no del código —el día que cambie lo cambia quien lo sabe— pero
     el seed tiene que coincidir con el resto, o hay dos CUIT en la empresa. */
  const comun = (await import('../src/servicios/pdfComun.js')).EMISOR.cuit;
  const ddl = (await import('node:fs')).readFileSync((await import('node:url'))
    .fileURLToPath(new URL('../src/servicios/db_galpon.js', import.meta.url)), 'utf8');
  assert.ok(ddl.includes("'etq_comercializa', 'San Gerónimo S.A. · CUIT " + comun + "'"),
    'el CUIT del tarjetón no es el de pdfComun.js (' + comun + ')');
});

// ── EL MANUAL CONTRA EL CÓDIGO ───────────────────────────────────────────
// Lo que el manual AFIRMA tiene que seguir siendo cierto (CLAUDE.md). No que
// el texto exista: que lo que promete pase.
const PANEL = (await import('node:fs')).readFileSync((await import('node:url'))
  .fileURLToPath(new URL('../src/panel.html', import.meta.url)), 'utf8');

test('el manual dice que la etiqueta usa la hoja entera, con su versión', () => {
  assert.match(PANEL, /La etiqueta usa la hoja entera<\/b> <span class="ver">V1144<\/span>/,
    'el manual no dice que la etiqueta usa la hoja entera');
});

test('el manual dice que el tamaño lo decide el lugar, y así se calcula', async () => {
  // Sin el «el » de adelante: ahí el manual corta la línea de JavaScript.
  assert.match(PANEL, /tamaño de cada dato lo decide <b>el lugar que tiene<\/b>/);
  const fuente = (await import('node:fs')).readFileSync((await import('node:url'))
    .fileURLToPath(new URL('../src/servicios/galponPalletPDF.js', import.meta.url)), 'utf8');
  assert.match(fuente, /tamDato \|\| Math\.min\(30, h \* 0\.6\)/,
    'el dato no toma su tamaño del alto de la caja');
  // Y ninguna de las seis cajas le pasa un tamaño propio.
  // Las LLAMADAS, que van indentadas; la definición dice `function caja(doc, ...`.
  const cajas = [...fuente.matchAll(/^ +caja\(doc, [^;]*?\);/gms)].map((m) => m[0]);
  assert.equal(cajas.length, 6, 'cambió la cantidad de cajas: ' + cajas.length);
  for (const c of cajas) {
    assert.ok(!/,\s*\d+\s*\);\s*$/.test(c.replace(/\r?\n\s*/g, ' ')),
      'una caja sigue con su tamaño escrito a mano: ' + c.replace(/\s+/g, ' '));
  }
});
