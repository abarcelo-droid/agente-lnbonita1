// ══ 🔢 DE DÓNDE ARRANCA EL NÚMERO DE PALLET ═══════════════════════════════
//
// Andy, 5/11/2026: «dejame el primer pallet a armar el 269 así hacemos match
// con el sistema viejo».
//
// El galpón venía numerando con otro sistema y esos números están PEGADOS en
// pallets que hoy están en cámara. Lo que puede salir mal es todo silencioso y
// se descubre con el camión cargado:
//
//   1. EMPEZAR EN 1 y repetir un número que ya está pegado en otro pallet.
//      Dos pallets con el mismo número no se pueden distinguir en un remito.
//   2. QUE EL PISO SE APLIQUE DOS VECES y el segundo pallet salga 269 otra vez
//      —o que el piso reaparezca el año que viene y queden 268 números que no
//      existen y que nadie pueda explicar.
//   3. QUE EL PISO RETROCEDA: bajarlo no puede reutilizar un número impreso.
//   4. QUE EL AÑO SE GUARDE CON CUATRO DÍGITOS. Nunca va a coincidir con el
//      «26» que arma el número, así que el arranque quedaría guardado y SIN
//      EFECTO, que es la peor de las tres respuestas posibles.
//
// Y del tarjetón: que el número sea lo más grande de la hoja, y que las chapas
// de estado no terminen debajo de los dígitos —una chapa negra pisada por un
// número bordó no se lee, y la que importa es la que dice PARCIAL.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  guardarPresentacion, guardarDatosDeLote, registrarProceso,
  cerrarPallet, proximoNumero, guardarConfig, config,
} from '../src/servicios/galpon.js';

// ── LA BASE ───────────────────────────────────────────────────────────────
// Lo mínimo que `proximoNumero` y `cerrarPallet` tocan. El prefijo se siembra
// acá y NO el arranque: cada test dice cuál es el suyo, porque el arranque es
// justamente lo que se está probando.
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
                           sector_id INTEGER, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca) VALUES (10,'L-A','El Abuelo');
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER,
      cultivo TEXT, campaña TEXT, es_perenne INTEGER DEFAULT 0);
    INSERT INTO pa_cultivos_lote (lote_id,cultivo,es_perenne) VALUES (10,'Damasco',1);
    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
    INSERT INTO gal_config (clave,valor) VALUES ('pallet_prefijo','PC');
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
    CREATE TABLE gal_procesos (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE,
      fecha TEXT NOT NULL, lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT,
      destino TEXT NOT NULL, presentacion_id INTEGER, presentacion TEXT, envase TEXT,
      categoria TEXT, calibre TEXT, variedad TEXT, renspa TEXT, cuartel TEXT,
      bultos REAL, por_bulto REAL, kg_unidad REAL, kilos REAL NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'ingreso', reparto TEXT,
      repartido INTEGER NOT NULL DEFAULT 0, pallet_id INTEGER, partido_de INTEGER,
      observacion TEXT, estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT,
      usuario_id INTEGER, usuario TEXT, creado_en TEXT, eliminado_en TEXT);
  `);
  guardarDatosDeLote(db, { lote_id: 10, renspa: 'R1', variedad: 'Bulida', cuartel: 'C-07' });
  return db;
}

const art = (db) => guardarPresentacion(db, { nombre: 'Caja', destino: 'comercial',
  envase: 'Caja 5 kg', por_bulto: 10, kg_unidad: 0.5, categoria: 'I' }).id;

// Un pallet YA CERRADO con ese número, para probar qué pasa cuando el año ya
// tiene correlativo. Se escribe directo porque lo que se prueba es el número
// que viene DESPUÉS, no cómo se cerró ese.
const yaHay = (db, numero) => db.prepare(
  " INSERT INTO gal_pallets (numero,estado,fecha_empaque) VALUES (?,'cerrado','2026-11-05')")
  .run(numero);

const arranque = (db, n, anio) => {
  guardarConfig(db, 'pallet_desde', String(n));
  guardarConfig(db, 'pallet_desde_anio', String(anio));
};

// ══════════════════════════════════════════════════════════════════════════
// 1 · EL PISO
// ══════════════════════════════════════════════════════════════════════════
test('CON EL ARRANQUE EN 269, EL PRIMER PALLET DEL AÑO SALE 00269', () => {
  const db = base();
  arranque(db, 269, '26');
  assert.equal(proximoNumero(db, '2026-11-05'), 'PC-26-00269');
});

test('y el segundo sale 00270: es un PISO, no un número fijo', () => {
  // El error de leerlo como «el número es 269» es que todos los pallets de la
  // temporada saldrían 269, y el UNIQUE de la columna haría fallar el cierre
  // del segundo sin explicar por qué.
  const db = base();
  arranque(db, 269, '26');
  yaHay(db, 'PC-26-00269');
  assert.equal(proximoNumero(db, '2026-11-05'), 'PC-26-00270');
});

test('una vez pasado, el piso deja de aplicarse y manda el último usado', () => {
  const db = base();
  arranque(db, 269, '26');
  yaHay(db, 'PC-26-00300');
  assert.equal(proximoNumero(db, '2026-11-05'), 'PC-26-00301');
});

test('EL PISO NO PUEDE RETROCEDER: bajarlo no reutiliza un número impreso', () => {
  // Bajar el arranque a 10 cuando el 300 ya está pegado en un pallet daría dos
  // pallets con el mismo número — y en un remito no hay forma de saber cuál es.
  const db = base();
  arranque(db, 10, '26');
  yaHay(db, 'PC-26-00300');
  assert.equal(proximoNumero(db, '2026-11-05'), 'PC-26-00301');
});

test('el 0 lo apaga y el correlativo arranca en 1', () => {
  const db = base();
  arranque(db, 0, '26');
  assert.equal(proximoNumero(db, '2026-11-05'), 'PC-26-00001');
});

test('sin el arranque configurado, arranca en 1 como siempre', () => {
  // Las bases de los otros tests del galpón no tienen estas claves: el día que
  // este piso rompiera el 00001 de todas ellas, el rojo saldría en ocho
  // archivos y ninguno hablaría de esto.
  const db = base();
  assert.equal(proximoNumero(db, '2026-11-05'), 'PC-26-00001');
});

test('un arranque con basura adentro no ensucia el número', () => {
  const db = base();
  arranque(db, 'doscientos sesenta y nueve', '26');
  assert.equal(proximoNumero(db, '2026-11-05'), 'PC-26-00001');
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL AÑO
// ══════════════════════════════════════════════════════════════════════════
test('EL PISO VA ATADO A UN AÑO: en el siguiente arranca en 1', () => {
  /* El año va ADENTRO del número, así que el correlativo arranca de nuevo cada
     temporada. Un piso sin año se volvería a aplicar y el primer pallet de 2027
     saldría 00269, dejando 268 números que no existen. */
  const db = base();
  arranque(db, 269, '26');
  assert.equal(proximoNumero(db, '2026-11-05'), 'PC-26-00269');
  assert.equal(proximoNumero(db, '2027-11-05'), 'PC-27-00001');
});

test('y el año anterior tampoco lo hereda', () => {
  const db = base();
  arranque(db, 269, '26');
  assert.equal(proximoNumero(db, '2025-12-28'), 'PC-25-00001');
});

test('UN AÑO DE CUATRO DÍGITOS NO COINCIDE CON NADA, y por eso la ruta lo rechaza', () => {
  /* Es la razón de que PUT /config valide el formato. Guardado así, el arranque
     queda escrito en la base y sin efecto: el que lo configuró ve su 269 en la
     pantalla y el pallet sale 00001. */
  const db = base();
  arranque(db, 269, '2026');
  assert.equal(proximoNumero(db, '2026-11-05'), 'PC-26-00001');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · DE PUNTA A PUNTA: CERRAR EL PALLET
// ══════════════════════════════════════════════════════════════════════════
test('CERRAR EL PRIMER PALLET LE PONE EL 00269', () => {
  const db = base();
  arranque(db, 269, '26');
  const a = art(db);
  registrarProceso(db, { fecha: '2026-11-05', lote_id: 10, presentacion_id: a,
    bultos: 40, uuid: 'u1' });
  const c = cerrarPallet(db, db.prepare('SELECT id FROM gal_pallets').get().id);
  assert.equal(c.ok, true);
  assert.equal(c.numero, 'PC-26-00269');
});

test('y cerrar el siguiente no repite el número', () => {
  const db = base();
  arranque(db, 269, '26');
  const a = art(db);
  const nums = [];
  for (const u of ['u1', 'u2']) {
    registrarProceso(db, { fecha: '2026-11-05', lote_id: 10, presentacion_id: a,
      bultos: 40, uuid: u });
    const p = db.prepare("SELECT id FROM gal_pallets WHERE estado = 'abierto'").get();
    nums.push(cerrarPallet(db, p.id).numero);
  }
  assert.deepEqual(nums, ['PC-26-00269', 'PC-26-00270']);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LO QUE LA PANTALLA NECESITA PARA MOSTRARLO
// ══════════════════════════════════════════════════════════════════════════
test('config() devuelve el arranque y su año, para que la pantalla los muestre', () => {
  const db = base();
  arranque(db, 269, '26');
  const c = config(db);
  assert.equal(c.pallet_desde, 269);
  assert.equal(c.pallet_desde_anio, '26');
  assert.equal(c.pallet_prefijo, 'PC');
  assert.equal(typeof c.pallet_desde, 'number', 'la pantalla lo pone en un input number');
});

test('y sin arranque configurado devuelve los dos campos igual, no indefinidos', () => {
  /* La pantalla los pone en dos casilleros y el router mira el largo del año: un
     campo que a veces viene y a veces no se cae del JSON sin que nada avise, y el
     casillero queda con lo que tenía escrito de antes. */
  const c = config(base());
  assert.equal(c.pallet_desde, 0);
  assert.equal(c.pallet_desde_anio, '');
  assert.equal(typeof c.pallet_desde_anio, 'string',
    'el año volvió como ' + typeof c.pallet_desde_anio);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · EL TARJETÓN
// ══════════════════════════════════════════════════════════════════════════
// Se GENERA de verdad y se lee lo DIBUJADO, inflando los streams: cada texto
// con el tamaño de letra y la posición con la que salió. Es más fiel que leer
// el fuente, porque lo que se quiere probar es lo que se ve en el papel.
let faltaPDF = false;
try { await import('jspdf'); await import('qrcode'); }
catch { faltaPDF = 'falta jspdf o qrcode: corré npm install para que estos tests corran'; }
const tp = (nombre, fn) => test(nombre, { skip: faltaPDF }, fn);

const PT = 2.8346457;          // puntos por milímetro
const ALTO = 210;              // la hoja es A4 apaisada

function dibujado(buf) {
  let t = '';
  const s = buf.toString('latin1');
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    try { t += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); }
    catch (e) { /* no todos los streams son texto */ }
  }
  const salida = [];
  const re = /\/[A-Za-z0-9]+\s+([\d.]+)\s+Tf[\s\S]*?([\d.-]+)\s+([\d.-]+)\s+Td\s*\(([^)]*)\)\s*Tj/g;
  for (const m of t.matchAll(re)) {
    salida.push({ tam: Number(m[1]), x: Number(m[2]) / PT,
                  y: ALTO - Number(m[3]) / PT, texto: m[4] });
  }
  return salida;
}

const CFG = { marca: 'LA NIÑA BONITA', comercializa: 'San Gerónimo S.A.',
              origen: 'Carpintería, San Juan' };
const UNO = [{ producto: 'Damasco', variedad: 'Bulida', categoria: 'I', calibre: '50/55',
               envase: 'Caja 5 kg', lote_nombre: 'L-A', renspa: 'R1', cuartel: 'C-07',
               bultos: 120, kilos: 600 }];

tp('EL NÚMERO ES EL TEXTO MÁS GRANDE DE LA HOJA', async () => {
  /* Es el único dato que alguien busca a tres metros y con un pallet de por
     medio: el producto se adivina mirando las cajas, el número no. */
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const d = dibujado(await galponPalletPDF(
    { numero: 'PC-26-00269', parcial: 0, mixto: 0, fecha_empaque: '2026-11-05',
      bultos: 120, kilos: 600 }, UNO, CFG));
  const num = d.filter((x) => x.texto === 'PC-26-00269');
  assert.ok(num.length >= 2, 'el número no está arriba y abajo del QR: ' + num.length);
  const grande = num.reduce((a, b) => (b.tam > a.tam ? b : a));
  const mayor = d.reduce((a, b) => (b.tam > a.tam ? b : a));
  assert.equal(mayor.texto, 'PC-26-00269',
    'hay algo más grande que el número: «' + mayor.texto + '» a ' + mayor.tam);
  assert.ok(grande.tam >= 40, 'el número salió a ' + grande.tam + ', que no se lee de lejos');
});

tp('y el que va debajo del QR también creció, porque es el que se tipea', async () => {
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const d = dibujado(await galponPalletPDF(
    { numero: 'PC-26-00269', parcial: 0, mixto: 0, fecha_empaque: '2026-11-05',
      bultos: 120, kilos: 600 }, UNO, CFG));
  const chico = d.filter((x) => x.texto === 'PC-26-00269')
    .reduce((a, b) => (b.tam < a.tam ? b : a));
  assert.ok(chico.tam >= 15, 'el número del QR salió a ' + chico.tam);
  // Y está abajo del QR, no arriba con el grande.
  assert.ok(chico.y > 80, 'el número del QR quedó en el encabezado: y=' + chico.y);
});

tp('LAS CHAPAS QUEDAN AL COSTADO DEL NÚMERO, NO DEBAJO', async () => {
  /* Con el número a 46 el renglón de abajo queda TAPADO por los dígitos: una
     chapa negra pisada por un número bordó no se lee, y la que importa es la
     que avisa que no vienen las cajas que el otro esperaba. */
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const d = dibujado(await galponPalletPDF(
    { numero: 'PC-26-00270', parcial: 1, mixto: 1, fecha_empaque: '2026-11-05',
      bultos: 95, kilos: 550 },
    [{ producto: 'Damasco', categoria: 'I', envase: 'Caja', lote_nombre: 'A',
       bultos: 40, kilos: 200 },
     { producto: 'Ciruela', categoria: 'I', envase: 'Caja', lote_nombre: 'B',
       bultos: 55, kilos: 350 }], CFG));
  const num = d.filter((x) => x.texto === 'PC-26-00270')
    .reduce((a, b) => (b.tam > a.tam ? b : a));
  for (const chapa of ['PARCIAL', 'MIXTO']) {
    const c = d.filter((x) => x.texto === chapa);
    assert.equal(c.length, 1, 'no se dibujó la chapa ' + chapa);
    assert.ok(c[0].x < num.x - 8,
      chapa + ' no está a la izquierda del número: x=' + c[0].x.toFixed(1)
      + ' contra ' + num.x.toFixed(1));
    /* Y en el MISMO renglón: la base de la chapa cae dentro de la franja que
       ocupan los dígitos. Se mira la franja y no una distancia máxima porque la
       prueba de mutación encontró el borde exacto: con «menos de 14 mm», una
       chapa corrida 14,0 mm pasaba o no según el redondeo del milímetro. */
    const alto = (num.tam * 0.72) / PT;
    assert.ok(c[0].y > num.y - alto && c[0].y <= num.y,
      chapa + ' quedó fuera del renglón del número: y=' + c[0].y.toFixed(1)
      + ', y los dígitos van de ' + (num.y - alto).toFixed(1) + ' a ' + num.y.toFixed(1));
  }
});

tp('el número no se mete abajo del rótulo ni pasa la raya del encabezado', async () => {
  /* Las tres medidas se mueven juntas y están con nombre arriba del archivo por
     esto: subir el tamaño sin bajar la base mete los dígitos adentro del rótulo
     «PALLET N°», y bajar la base de más los apoya sobre la raya. */
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const d = dibujado(await galponPalletPDF(
    { numero: 'PC-26-00269', parcial: 0, mixto: 0, fecha_empaque: '2026-11-05',
      bultos: 120, kilos: 600 }, UNO, CFG));
  const rot = d.find((x) => x.texto.startsWith('PALLET N'));
  const num = d.filter((x) => x.texto === 'PC-26-00269')
    .reduce((a, b) => (b.tam > a.tam ? b : a));
  assert.ok(rot, 'no está el rótulo PALLET N°');
  /* La altura de los dígitos: ~0,72 em, y un milímetro son 2,83 puntos. Se piden
     3 mm de aire y no sólo que no se toquen: pegados se leen como un solo bloque
     y el rótulo deja de leerse como rótulo. Lo pidió la prueba de mutación —con
     la base vieja quedaban 0,3 mm y el test pasaba igual. */
  const arriba = num.y - (num.tam * 0.72) / PT;
  assert.ok(arriba > rot.y + 3, 'el número se mete abajo del rótulo: arranca en '
    + arriba.toFixed(1) + ' y el rótulo se apoya en ' + rot.y.toFixed(1));
  assert.ok(num.y < 41, 'el número se apoya sobre la raya del encabezado: ' + num.y);
});

tp('un prefijo largo achica la letra en vez de salirse del marco', async () => {
  const { galponPalletPDF } = await import('../src/servicios/galponPalletPDF.js');
  const largo = 'PUENTE-CORDON-2026-00269';
  const d = dibujado(await galponPalletPDF(
    { numero: largo, parcial: 0, mixto: 0, fecha_empaque: '2026-11-05',
      bultos: 120, kilos: 600 }, UNO, CFG));
  const num = d.filter((x) => x.texto === largo)
    .reduce((a, b) => (b.tam > a.tam ? b : a));
  assert.ok(num.tam < 46, 'no se achicó: salió a ' + num.tam);
  assert.ok(num.x > 12, 'se salió del marco: arranca en x=' + num.x.toFixed(1));
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · EL MANUAL CONTRA EL CÓDIGO
// ══════════════════════════════════════════════════════════════════════════
// Lo que el manual AFIRMA tiene que seguir siendo cierto. Un test que sólo
// verifica que el texto existe no sirve para nada (CLAUDE.md).
const leer = (r) => fs.readFileSync(fileURLToPath(new URL(r, import.meta.url)), 'utf8');
const PANEL = leer('../src/panel.html');
const SVC = leer('../src/servicios/galpon.js');
const DDL = leer('../src/servicios/db_galpon.js');
const RUTA = leer('../src/rutas/galpon.js');
const dice = (re, que) => assert.match(PANEL, re, 'el manual no dice: ' + (que || re));

test('el manual explica de dónde arranca el número, con su versión', () => {
  dice(/De dónde arranca el número de pallet <span class="ver">V1142<\/span>/);
  dice(/dejame el primer pallet a armar el 269/);
});

test('el manual dice que es un PISO, y el código lo aplica como piso', () => {
  dice(/piso, no un contador/);
  assert.match(SVC, /Math\.max\(n \+ 1, piso\)/,
    'el manual promete un piso y el código no usa el máximo');
});

test('el manual dice que va atado a un año, y el código lo compara', () => {
  dice(/Año de ese arranque<\/b>, dos dígitos/);
  assert.match(SVC, /valorConfig\(db, 'pallet_desde_anio'\)[^\n]*\)\.trim\(\) === anio/,
    'el manual dice que el piso es de un año y el código no lo compara');
});

test('el manual dice que 0 lo apaga, y 0 lo apaga', () => {
  dice(/<b>0 lo apaga<\/b>/);
  const db = base();
  arranque(db, 0, '26');
  assert.equal(proximoNumero(db, '2026-11-05'), 'PC-26-00001');
});

test('el manual dice que se ve el próximo número, y la ruta lo manda', () => {
  dice(/El próximo que se cierre<\/b> no se escribe: lo calcula el sistema/);
  assert.match(RUTA, /proximo_pallet: proximoNumero\(db, hoy\(\)\)/,
    'el manual promete el próximo número y la ruta no lo devuelve');
  assert.match(PANEL, /px\.textContent = j\.proximo_pallet/,
    'la ruta lo manda y la pantalla no lo muestra');
});

test('el manual dice que se recalcula al guardar, y la pantalla lo vuelve a leer', () => {
  /* El PUT devuelve la config pero NO recalcula el próximo número: sin volver a
     leer, en pantalla queda el número viejo justo después de cambiar el
     arranque — que es el único dato que se vino a mirar. */
  dice(/Se recalcula al guardar/);
  const i = PANEL.indexOf('async function galCfgGuardar(');
  assert.ok(i > 0, 'no está galCfgGuardar');
  const cuerpo = PANEL.slice(i, PANEL.indexOf('\r\n}', i));
  assert.match(cuerpo, /await galCargar\(\)/,
    'galCfgGuardar no vuelve a leer la configuración');
});

test('el manual del tarjetón dice que el número es lo más grande, con su versión', () => {
  dice(/El número es lo más grande de la hoja<\/b> <span class="ver">V1142<\/span>/);
  dice(/<b>PARCIAL<\/b> y <b>MIXTO<\/b> van a su izquierda/);
});

test('EL 269 ESTÁ SEMBRADO: en una base nueva el primer pallet ya sale 00269', () => {
  /* Sin el seed, el arranque habría que cargarlo a mano en la pantalla — y la
     primera temporada se numeraría desde 1 hasta que alguien se acuerde. */
  assert.match(DDL, /\['pallet_desde', '269'\]/, 'no está sembrado el 269');
  assert.match(DDL, /\['pallet_desde_anio', '26'\]/, 'no está sembrado el año del arranque');
});

test('la ruta deja tocar el arranque, y sólo esas claves', () => {
  assert.match(RUTA, /'pallet_desde', 'pallet_desde_anio'\]/,
    'el arranque no está en la lista de claves que se pueden guardar');
});
