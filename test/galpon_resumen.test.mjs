// ══ 📄 LA PLANILLA, EL PRODUCTO Y EL NÚMERO QUE SE MULTIPLICABA ══════════
//
// Andy, 1/11/2026: «quiero que en acumulado se pueda descargar un archivo como
// el que te saco foto» y «creo que en ningún lado detallamos que es damasco...
// necesito diferenciarlo porque después viene uva y melón».
//
// Y arriba de todo, el error más caro que apareció en esta pantalla:
//
//   kilos(12.345) DEVOLVÍA 12345.
//
// La regla de los miles —«1.250» son mil doscientos cincuenta— se aplicaba
// también a lo que YA llegaba como número. String(12.345) es "12.345", que
// calza con el patrón. Dos caminos lo pisaban todos los días:
//
//   · LA BALANZA, que devuelve hasta tres decimales y los escribía con punto.
//     Una pesada de 12,345 kg entraba como 12.345, por debajo del tope, sin
//     marca y sin que nadie la viera.
//   · EL CATÁLOGO, que pide gramos y divide por mil: 615 g dan 0.615, que
//     entraba como 615 kg POR UNIDAD y después multiplicaba cada carga.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  kilos, guardarPresentacion, presentaciones, registrarProceso, editarProceso,
  resumenParaPlanilla, stockPorProducto, procesosDelDia,
  guardarDatosDeLote, lotesConDatos, variedadATodos,
} from '../src/servicios/galpon.js';

// ══════════════════════════════════════════════════════════════════════════
// 1 · UN NÚMERO YA ES UN NÚMERO
// ══════════════════════════════════════════════════════════════════════════
test('UN NÚMERO NO PASA POR LA REGLA DE LOS MILES', () => {
  // Es para interpretar lo que TIPEA una persona. Aplicársela a un número hace
  // que 12,345 entre como 12.345 — y 12.345 kg es un número perfectamente
  // creíble para un día de galpón.
  assert.equal(kilos(12.345), 12.35);
  assert.equal(kilos(1.234), 1.23);
  assert.equal(kilos(0.615), 0.62);
  assert.equal(kilos(450.5), 450.5);
  assert.equal(kilos(0.7), 0.7);
});

test('«0.615» ES SEIS COMA QUINCE, no seiscientos quince', () => {
  // Nadie escribe un separador de miles después de un cero.
  assert.equal(kilos('0.615'), 0.62);
  assert.equal(kilos('0.700'), 0.7);
  assert.equal(kilos('-0.500'), -0.5);
});

test('y la regla de los miles SIGUE VALIENDO para lo que se tipea', () => {
  // Es para lo que se escribió, y el manual lo promete con esas palabras.
  assert.equal(kilos('1.250'), 1250);
  assert.equal(kilos('12.500'), 12500);
  assert.equal(kilos('1.234.567'), 1234567);
  assert.equal(kilos('1.25'), 1.25);
  assert.equal(kilos('1.2'), 1.2);
  assert.equal(kilos('450,5'), 450.5);
});

test('EL PESO POR UNIDAD SE GUARDA CON TRES DECIMALES', () => {
  // Una cubeta de 615 g son 0,615 kg. Redondeada a 0,62 son cinco gramos por
  // cubeta — y esa presentación multiplica todas las cargas que entren con
  // ella: sesenta kilos inventados cada mil doscientas cajas de diez.
  const db = base();
  const id = guardarPresentacion(db, { nombre: 'Cubeta 615', destino: 'comercial',
    por_bulto: 10, kg_unidad: 0.615 }).id;
  const p = presentaciones(db).filter((x) => x.id === id)[0];
  assert.equal(p.kg_unidad, 0.615);
  // Y la cuenta sale con el peso entero, no con el redondeado.
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: id,
    bultos: 100, uuid: 'a' });
  assert.equal(r.fila.kilos, 615);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL PRODUCTO
// ══════════════════════════════════════════════════════════════════════════
const F = '2026-11-20';

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    -- lotesConDatos lee la lista completa con lotesParaElDia, que junta el sector.
    CREATE TABLE pa_sectores (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT);
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
                           sector_id INTEGER, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca) VALUES (10,'Cuadro 3','El Abuelo'), (11,'Cuadro 4','La Estación'),
                                (12,'Parral 1','El Abuelo'), (13,'Sin cultivo','El Abuelo');
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER,
      cultivo TEXT, campaña TEXT, es_perenne INTEGER DEFAULT 0);
    INSERT INTO pa_cultivos_lote (lote_id,cultivo,campaña,es_perenne) VALUES
      (10,'Damasco','2026/27',1), (11,'Damasco','2026/27',1), (12,'Uva','2026/27',1);
    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
    CREATE TABLE gal_volcados (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT,
      lote_id INTEGER, lote_nombre TEXT, producto TEXT, kilos REAL, ifcos INTEGER,
      eliminado_en TEXT);
    CREATE TABLE gal_lote_datos (lote_id INTEGER PRIMARY KEY, renspa TEXT, variedad TEXT,
      cuartel TEXT, notas TEXT, actualizado TEXT);
    CREATE TABLE gal_presentaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT,
      destino TEXT, envase TEXT, por_bulto REAL DEFAULT 1, kg_unidad REAL DEFAULT 1,
      granel INTEGER DEFAULT 0, categoria TEXT NOT NULL DEFAULT 'I', calibre TEXT, color TEXT, orden INTEGER DEFAULT 100,
      activo INTEGER DEFAULT 1, creado_en TEXT, eliminado_en TEXT);
    CREATE TABLE gal_procesos (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE,
      fecha TEXT NOT NULL, lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT,
      destino TEXT NOT NULL, presentacion_id INTEGER, presentacion TEXT, envase TEXT, categoria TEXT, calibre TEXT, variedad TEXT, renspa TEXT, cuartel TEXT,
      bultos REAL, por_bulto REAL, kg_unidad REAL, kilos REAL NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'ingreso', reparto TEXT,
      repartido INTEGER NOT NULL DEFAULT 0, observacion TEXT,
      estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT, usuario_id INTEGER,
      usuario TEXT, creado_en TEXT, eliminado_en TEXT);
  `);
  return db;
}
const conCaja = (db) => guardarPresentacion(db, { nombre: 'Caja', destino: 'comercial',
  por_bulto: 10, kg_unidad: 0.7 }).id;

test('EL PRODUCTO SE CONGELA DESDE EL LOTE, no lo manda la pantalla', () => {
  // La columna existía y estaba SIEMPRE EN NULL: la pantalla nunca la mandaba,
  // y con un solo producto el corte se veía igual de bien contando todo junto.
  const db = base();
  const c = conCaja(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 12, presentacion_id: c,
    bultos: 10, producto: 'lo que yo diga', uuid: 'a' });
  assert.equal(r.fila.producto, 'Uva');
});

test('con la mezcla, CADA FILA LLEVA EL PRODUCTO DE SU LOTE', () => {
  // Es justamente el caso que preocupa: damasco y uva en la misma tolva. Una
  // sola etiqueta para las dos filas sería la mezcla que esto viene a evitar.
  const db = base();
  const c = conCaja(db);
  const r = registrarProceso(db, { fecha: F, lote_ids: [10, 12], presentacion_id: c,
    bultos: 100, uuid: 'm' });
  assert.equal(r.ok, true);
  const por = {};
  for (const f of procesosDelDia(db, F)) por[f.lote_id] = f.producto;
  assert.equal(por[10], 'Damasco');
  assert.equal(por[12], 'Uva');
});

test('CORREGIR EL LOTE SE LLEVA EL PRODUCTO', () => {
  // Mover una carga de un cuadro de damasco a uno de uva y dejarla diciendo
  // «damasco» es la mezcla que esto viene a evitar.
  const db = base();
  const c = conCaja(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: c,
    bultos: 10, uuid: 'a' });
  assert.equal(r.fila.producto, 'Damasco');
  assert.equal(editarProceso(db, r.id, { lote_id: 12 }).fila.producto, 'Uva');
});

test('un lote sin cultivo cargado no borra el producto que tenía', () => {
  const db = base();
  const c = conCaja(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: c,
    bultos: 10, uuid: 'a' });
  assert.equal(editarProceso(db, r.id, { lote_id: 13 }).fila.producto, 'Damasco');
});

test('el stock se abre por producto', () => {
  const db = base();
  const c = conCaja(db);
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: c, bultos: 100, uuid: 'a' });
  registrarProceso(db, { fecha: F, lote_id: 12, presentacion_id: c, bultos: 50, uuid: 'b' });
  const ps = stockPorProducto(db);
  assert.equal(ps.length, 2);
  assert.equal(ps[0].producto, 'Damasco');
  assert.equal(ps[0].bultos, 100);
  assert.equal(ps[0].comercial, 700);
  assert.equal(ps.filter((x) => x.producto === 'Uva')[0].kilos, 350);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LA PLANILLA
// ══════════════════════════════════════════════════════════════════════════
function conPlanilla() {
  const db = base();
  db.prepare('INSERT INTO gal_volcados (fecha,lote_id,lote_nombre,producto,kilos,ifcos)'
    + " VALUES ('2026-10-28',10,'Cuadro 3','Damasco',674.30,42)").run();
  db.prepare('INSERT INTO gal_volcados (fecha,lote_id,lote_nombre,producto,kilos,ifcos)'
    + " VALUES ('2026-10-30',10,'Cuadro 3','Damasco',3611.50,280)").run();
  const carton = guardarPresentacion(db, { nombre: 'Cartón', destino: 'comercial',
    por_bulto: 10, kg_unidad: 0.66, orden: 10 }).id;
  const ifco = guardarPresentacion(db, { nombre: 'Ifcos', destino: 'comercial',
    por_bulto: 20, kg_unidad: 0.615, orden: 20 }).id;
  const verde = guardarPresentacion(db, { nombre: 'Caj verde', destino: 'verde',
    granel: 1, orden: 10 }).id;
  const desc = guardarPresentacion(db, { nombre: 'Caj descarte', destino: 'descarte',
    granel: 1, orden: 10 }).id;
  registrarProceso(db, { fecha: '2026-10-28', lote_id: 10, presentacion_id: carton,
    bultos: 49, uuid: '1' });
  registrarProceso(db, { fecha: '2026-10-28', lote_id: 10, presentacion_id: ifco,
    bultos: 10, uuid: '2' });
  registrarProceso(db, { fecha: '2026-10-28', lote_id: 10, presentacion_id: verde,
    kilos: 20.4, uuid: '3' });
  registrarProceso(db, { fecha: '2026-10-28', lote_id: 10, presentacion_id: desc,
    kilos: 91.8, uuid: '4' });
  return db;
}

test('UNA FILA POR DÍA, con el ingreso y la producción abierta', () => {
  const filas = resumenParaPlanilla(conPlanilla(), '2026-10-01', '2026-10-31');
  assert.equal(filas.length, 2);
  const d = filas[0];
  assert.equal(d.fecha, '2026-10-28');
  assert.equal(d.ifcos, 42, 'perdió la cantidad de IFCOs que entraron');
  assert.equal(d.volcado, 674.3);
  assert.equal(d.comercial, 446.4);     // 49×6,6 + 10×12,3
  assert.equal(d.verde, 20.4);
  assert.equal(d.descarte, 91.8);
  assert.equal(d.bultos, 59);
});

test('EL VERDE Y EL DESCARTE NO ENTRAN EN LAS COLUMNAS DEL MEDIO', () => {
  // Tienen sus dos columnas propias a la derecha. Meterlos también en el medio
  // los contaría dos veces en el total de la fila — y el total de la fila es
  // la columna con la que se controla la planilla.
  const d = resumenParaPlanilla(conPlanilla(), '2026-10-01', '2026-10-31')[0];
  const nombres = d.presentaciones.map((p) => p.nombre);
  assert.deepEqual(nombres.sort(), ['Cartón', 'Ifcos']);
  assert.equal(d.descarte_bultos, 0);
  assert.equal(d.verde_bultos, 0);
  // Y la suma de las columnas del medio es lo comercial, no el total del día.
  const suma = d.presentaciones.reduce((t, p) => t + p.kilos, 0);
  assert.equal(Math.round(suma * 100) / 100, d.comercial);
});

test('las columnas salen de los datos, no de una lista escrita a mano', async () => {
  // La planilla de papel las tiene escritas en el encabezado, y el día que
  // agreguen una quinta hay que rehacerla.
  const { columnasDelResumen } = await import('../src/servicios/galponResumenExcel.js');
  const filas = resumenParaPlanilla(conPlanilla(), '2026-10-01', '2026-10-31');
  const cols = columnasDelResumen(filas);
  assert.deepEqual(cols.map((c) => c.nombre), ['Cartón', 'Ifcos']);
  // Y en el orden del catálogo, no alfabético ni el de aparición.
  assert.ok(cols[0].orden <= cols[1].orden);
  assert.deepEqual(columnasDelResumen([]), []);
});

test('un día que se volcó y no se procesó aparece igual', () => {
  // Es la mitad de para qué sirve la planilla: ver que el 30 entraron 3.611 kg
  // y no salió nada todavía.
  const filas = resumenParaPlanilla(conPlanilla(), '2026-10-01', '2026-10-31');
  const d30 = filas.filter((x) => x.fecha === '2026-10-30')[0];
  assert.ok(d30);
  assert.equal(d30.volcado, 3611.5);
  assert.equal(d30.procesado, 0);
  assert.deepEqual(d30.presentaciones, []);
});

test('el rango se respeta, y una fecha mala no devuelve media planilla', () => {
  const db = conPlanilla();
  assert.equal(resumenParaPlanilla(db, '2026-10-28', '2026-10-28').length, 1);
  assert.deepEqual(resumenParaPlanilla(db, '2026-11-01', '2026-11-30'), []);
  assert.deepEqual(resumenParaPlanilla(db, 'cualquiera', '2026-10-31'), []);
});

test('lo borrado no sale en la planilla', () => {
  const db = conPlanilla();
  db.prepare("UPDATE gal_procesos SET eliminado_en = '2026-10-29' WHERE destino = 'descarte'")
    .run();
  const d = resumenParaPlanilla(db, '2026-10-01', '2026-10-31')[0];
  assert.equal(d.descarte, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LA MIGRACIÓN DEL PRODUCTO, EJECUTADA
// ══════════════════════════════════════════════════════════════════════════
// Se saca el bloque de db_galpon.js y se CORRE contra una base de mentira. Leer
// que dice `if (!hecha)` no prueba nada: lo que puede estar mal es que la marca
// no se escriba y el UPDATE vuelva a correr en el arranque siguiente, pisando la
// primera carga de uva que entre sin cultivo en su lote.
import fsNode from 'node:fs';
import pathNode from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || pathNode.resolve(pathNode.dirname(fileURLToPath(import.meta.url)), '..');

function correrMigracion(db) {
  const src = fsNode.readFileSync(pathNode.join(RAIZ, 'src/servicios/db_galpon.js'), 'utf8');
  const i = src.indexOf('// ── LO QUE SE CARGÓ ANTES DE QUE EL PRODUCTO VIAJARA');
  assert.ok(i > 0, 'no encontré el bloque de la migración');
  const j = src.indexOf('console.log("[GALPON] Tablas', i);
  assert.ok(j > i, 'no encontré el final del bloque');
  new Function('db', src.slice(i, j))(db);
}

test('LA MIGRACIÓN PONE «DAMASCO» EN LO QUE YA ESTABA CARGADO', () => {
  const db = base();
  const c = conCaja(db);
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: c, bultos: 10, uuid: 'a' });
  db.prepare('UPDATE gal_procesos SET producto = NULL').run();
  db.prepare("INSERT INTO gal_volcados (fecha,lote_id,kilos) VALUES (?,10,100)").run(F);

  correrMigracion(db);
  assert.equal(db.prepare('SELECT producto FROM gal_procesos').get().producto, 'Damasco');
  assert.equal(db.prepare('SELECT producto FROM gal_volcados').get().producto, 'Damasco');
});

test('Y CORRE UNA SOLA VEZ: lo que entre después no se toca', () => {
  // Un UPDATE ... WHERE producto IS NULL en cada arranque le pondría «Damasco» a la
  // primera carga de uva que entre sin cultivo cargado en su lote. Eso ya no sería
  // arreglar el pasado: sería ensuciar el futuro, y en silencio.
  const db = base();
  correrMigracion(db);
  const marca = db.prepare("SELECT valor FROM gal_config WHERE clave = 'migr_producto_damasco'").get();
  assert.ok(marca, 'no dejó la marca: va a volver a correr');

  const c = conCaja(db);
  registrarProceso(db, { fecha: F, lote_id: 13, presentacion_id: c, bultos: 1, uuid: 'x' });
  db.prepare('UPDATE gal_procesos SET producto = NULL').run();
  correrMigracion(db);
  assert.equal(db.prepare('SELECT producto FROM gal_procesos').get().producto, null,
    'volvió a correr y le puso Damasco a una carga nueva');
  // Y la marca no se duplica ni se pisa.
  assert.equal(db.prepare("SELECT valor FROM gal_config WHERE clave = 'migr_producto_damasco'").get().valor,
    marca.valor);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · EL ARTÍCULO Y LOS DATOS DEL TARJETÓN (V1119)
// ══════════════════════════════════════════════════════════════════════════
// Andy, 1/11/2026: «categoría siempre CAT 1 a menos que modifiquemos», «RENSPA
// los voy a cargar en los lotes», «variedad del damasco es siempre Castle
// Brite», «los calibres en damasco los definimos en el artículo que hacemos
// del proceso».
//
// Todo esto se IMPRIME en el tarjetón. Lo que falla callado acá no es un
// número: es una etiqueta que sale con el RENSPA de otro cuadro y se va en un
// camión.
test('LA CATEGORÍA ARRANCA EN I, y el calibre es parte del artículo', () => {
  const db = base();
  const id = guardarPresentacion(db, { nombre: 'Caja 5 kg', destino: 'comercial',
    por_bulto: 10, kg_unidad: 0.5, calibre: '50/55' }).id;
  const p = presentaciones(db).filter((x) => x.id === id)[0];
  assert.equal(p.categoria, 'I', 'no arrancó en CAT I');
  assert.equal(p.calibre, '50/55');
});

test('y la categoría se puede cambiar cuando hace falta', () => {
  const db = base();
  const id = guardarPresentacion(db, { nombre: 'Caja', destino: 'comercial',
    por_bulto: 10, kg_unidad: 0.5, categoria: 'II', calibre: '45/50' }).id;
  assert.equal(presentaciones(db).filter((x) => x.id === id)[0].categoria, 'II');
});

test('EL ARTÍCULO SE CONGELA EN CADA CARGA', () => {
  // Lo que se imprimió es lo que viajó: cambiar el calibre del catálogo el mes
  // que viene no puede reescribir la etiqueta que se fue en el camión.
  const db = base();
  const id = guardarPresentacion(db, { nombre: 'Caja 5 kg', destino: 'comercial',
    por_bulto: 10, kg_unidad: 0.5, calibre: '50/55' }).id;
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: id,
    bultos: 40, uuid: 'a' });
  assert.equal(r.fila.categoria, 'I');
  assert.equal(r.fila.calibre, '50/55');

  guardarPresentacion(db, { id, nombre: 'Caja 5 kg', destino: 'comercial',
    por_bulto: 10, kg_unidad: 0.5, calibre: '60/65', categoria: 'II' });
  assert.equal(procesosDelDia(db, F)[0].calibre, '50/55',
    'cambiar el catálogo reescribió una etiqueta ya emitida');
});

test('EL RENSPA Y LA VARIEDAD SALEN DEL LOTE, y se congelan', () => {
  const db = base();
  guardarDatosDeLote(db, { lote_id: 10, renspa: '12.345.6.78901/00',
    variedad: 'Castle Brite', cuartel: 'C-07' });
  const id = conCaja(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: id,
    bultos: 10, uuid: 'a' });
  assert.equal(r.fila.renspa, '12.345.6.78901/00');
  assert.equal(r.fila.variedad, 'Castle Brite');
  assert.equal(r.fila.cuartel, 'C-07');

  // Corregir el RENSPA del lote no toca la etiqueta ya emitida.
  guardarDatosDeLote(db, { lote_id: 10, renspa: 'OTRO', variedad: 'Castle Brite',
    cuartel: 'C-07' });
  assert.equal(procesosDelDia(db, F)[0].renspa, '12.345.6.78901/00');
});

test('CORREGIR EL LOTE SE LLEVA EL RENSPA, o la etiqueta miente', () => {
  // Una carga movida a otro cuadro con el RENSPA del anterior es una etiqueta
  // que miente sobre su procedencia — y el RENSPA es el dato sanitario.
  const db = base();
  guardarDatosDeLote(db, { lote_id: 10, renspa: 'AAA', variedad: 'Castle Brite' });
  guardarDatosDeLote(db, { lote_id: 11, renspa: 'BBB', variedad: 'Castle Brite' });
  const id = conCaja(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: id,
    bultos: 10, uuid: 'a' });
  assert.equal(editarProceso(db, r.id, { lote_id: 11 }).fila.renspa, 'BBB');
});

test('un lote sin datos cargados no rompe la carga', () => {
  // El galpón no se para porque falte un RENSPA: la carga entra y el dato se
  // completa después. Nada se rechaza después del hecho.
  const db = base();
  const id = conCaja(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: id,
    bultos: 10, uuid: 'a' });
  assert.equal(r.ok, true);
  assert.equal(r.fila.renspa, null);
});

test('la lista de Configuración trae TODOS los lotes, con datos o sin ellos', () => {
  // Mostrar sólo los que ya tienen cargado algo esconde justamente los que
  // faltan, que son los que hay que completar.
  const db = base();
  guardarDatosDeLote(db, { lote_id: 10, renspa: 'AAA' });
  const ls = lotesConDatos(db);
  assert.ok(ls.length >= 4);
  assert.equal(ls.filter((l) => l.id === 10)[0].renspa, 'AAA');
  assert.equal(ls.filter((l) => l.id === 11)[0].renspa, null);
});

test('LA VARIEDAD SE COPIA A TODOS LOS LOTES DE UN CULTIVO', () => {
  // «La variedad del damasco es siempre Castle Brite». Cargarla lote por lote
  // en veinte cuadros son veinte oportunidades de escribirla distinto, y
  // «Castle Brite» y «Castle brite» son dos variedades para cualquier informe.
  const db = base();
  guardarDatosDeLote(db, { lote_id: 10, renspa: 'NO ME TOQUES' });
  const r = variedadATodos(db, 'Damasco', 'Castle Brite');
  assert.equal(r.ok, true);
  assert.equal(r.lotes_tocados, 2);          // los dos de damasco, no el de uva
  const ls = lotesConDatos(db);
  assert.equal(ls.filter((l) => l.id === 10)[0].variedad, 'Castle Brite');
  assert.equal(ls.filter((l) => l.id === 11)[0].variedad, 'Castle Brite');
  assert.equal(ls.filter((l) => l.id === 12)[0].variedad, null, 'le puso la variedad a la uva');
  // Y NO pisa el RENSPA, que es distinto en cada lote y el más caro de recargar.
  assert.equal(ls.filter((l) => l.id === 10)[0].renspa, 'NO ME TOQUES');
});

test('copiar una variedad a un cultivo que no existe no hace nada', () => {
  const db = base();
  assert.equal(variedadATodos(db, 'Mango', 'X').ok, false);
  assert.equal(variedadATodos(db, 'Damasco', '').ok, false);
});

test('CAMBIAR LA PRESENTACIÓN SE LLEVA EL CALIBRE', () => {
  // Cargar como 50/55 lo que era 45/50 es un error de un clic, y el calibre va
  // impreso: una etiqueta con el calibre de otro artículo es mercadería que el
  // cliente rechaza en la recepción.
  const db = base();
  const a = guardarPresentacion(db, { nombre: 'Caja I', destino: 'comercial',
    por_bulto: 10, kg_unidad: 0.5, calibre: '50/55' }).id;
  const b = guardarPresentacion(db, { nombre: 'Caja II', destino: 'comercial',
    por_bulto: 10, kg_unidad: 0.5, calibre: '45/50', categoria: 'II' }).id;
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 10, uuid: 'x' });
  const e = editarProceso(db, r.id, { presentacion_id: b, bultos: 10 });
  assert.equal(e.fila.calibre, '45/50');
  assert.equal(e.fila.categoria, 'II');
});

test('no se le cargan datos de etiqueta a un lote que no existe', () => {
  // Una fila huérfana en la tabla satélite no se ve en ninguna pantalla y queda
  // ahí para siempre.
  const db = base();
  assert.equal(guardarDatosDeLote(db, { lote_id: 999, renspa: 'X' }).ok, false);
  assert.equal(guardarDatosDeLote(db, { renspa: 'X' }).ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gal_lote_datos').get().n, 0);
});
