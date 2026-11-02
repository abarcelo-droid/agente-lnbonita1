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
      mixto INTEGER NOT NULL DEFAULT 0, origen TEXT NOT NULL DEFAULT 'proceso', fecha_empaque TEXT, bultos REAL, kilos REAL,
      observacion TEXT, abierto_en TEXT, cerrado_en TEXT, usuario_id INTEGER,
      usuario TEXT, eliminado_en TEXT);
    CREATE TABLE gal_procesos (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE,
      fecha TEXT NOT NULL, lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT,
      destino TEXT NOT NULL, presentacion_id INTEGER, presentacion TEXT, envase TEXT,
      categoria TEXT, calibre TEXT, variedad TEXT, renspa TEXT, cuartel TEXT,
      bultos REAL, por_bulto REAL, kg_unidad REAL, kilos REAL NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'ingreso', reparto TEXT,
      repartido INTEGER NOT NULL DEFAULT 0, pallet_id INTEGER, partido_de INTEGER, observacion TEXT,
      estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT, usuario_id INTEGER,
      usuario TEXT, creado_en TEXT, eliminado_en TEXT);
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

test('EL TARJETÓN MIXTO lleva una línea por artículo, con su lote', async () => {
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
                          'Ciruela Red Beaut', 'L-1215-A', 'L-1215-C', '40', '30', '25',
                          'TOTAL · Empaque 15/12/2026', '95', '550']) {
    assert.ok(t.includes(esperado), 'al tarjetón mixto le falta ' + esperado + '\n' + t);
  }
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
