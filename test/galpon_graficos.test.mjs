// ══ 📊 LOS GRÁFICOS Y EL STOCK ═══════════════════════════════════════════
//
// Andy, 31/10/2026: «quiero más gráficos. Más visual respecto a cuánto
// procesamos cada día y cómo rindió» y «quiero el stock bien claro, por
// ejemplo cuánto quedó guardado en el frío».
//
// LOS ARMADORES SE EJECUTAN, no se leen como texto. Un gráfico roto no tiene
// un error de sintaxis: tiene una columna con `height:NaN%`, que el navegador
// ignora y deja la barra en cero. Mirando el código eso se ve perfecto.
//
// Lo que falla CALLADO, y por eso tiene test:
//
//   1. NaN Y undefined EN EL HTML. Un alto de NaN% no rompe nada: la barra no
//      se dibuja y el día parece vacío.
//   2. DIVIDIR POR CERO. El primer día de la temporada tiene un máximo de 0, y
//      todas las alturas salen NaN o Infinity.
//   3. ALTURAS FUERA DE 0–100. Un 140% se sale del cuadro y tapa el de arriba.
//   4. EL RINDE DEL DÍA CONTRA EL VOLCADO DEL DÍA. Lo que entra el martes se
//      procesa el jueves: contra el volcado del mismo día, cualquier jueves da
//      más de 100% y el gráfico miente para arriba.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { procesoPorDia, stockGalpon, stockPorLote, guardarPresentacion,
         registrarProceso, borrarProceso } from '../src/servicios/galpon.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const F1 = '2026-11-20', F2 = '2026-11-22';

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT);
    INSERT INTO pa_lotes VALUES (10,'Cuadro 3','La Esperanza'), (11,'Cuadro 4','Cochahual');
    -- El proceso congela el PRODUCTO desde el cultivo del lote, igual que el nombre.
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER,
                                   cultivo TEXT, campaña TEXT, es_perenne INTEGER DEFAULT 0);
    INSERT INTO pa_cultivos_lote (lote_id,cultivo,campaña,es_perenne) VALUES
      (10,'Damasco','2026/27',1), (11,'Damasco','2026/27',1);
    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
    CREATE TABLE gal_volcados (
      id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT, lote_id INTEGER, lote_nombre TEXT,
      producto TEXT, kilos REAL, eliminado_en TEXT);
    CREATE TABLE gal_lote_datos (lote_id INTEGER PRIMARY KEY, renspa TEXT, variedad TEXT,
      cuartel TEXT, notas TEXT, actualizado TEXT);
    CREATE TABLE gal_presentaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, destino TEXT, envase TEXT,
      por_bulto REAL DEFAULT 1, kg_unidad REAL DEFAULT 1, granel INTEGER DEFAULT 0, emoji TEXT, icono TEXT, icono_v TEXT, categoria TEXT NOT NULL DEFAULT 'I', calibre TEXT,
      color TEXT, orden INTEGER DEFAULT 100, activo INTEGER DEFAULT 1,
      creado_en TEXT, eliminado_en TEXT);
    CREATE TABLE gal_pallets (id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT UNIQUE,
      estado TEXT NOT NULL DEFAULT 'abierto', parcial INTEGER NOT NULL DEFAULT 0,
      mixto INTEGER NOT NULL DEFAULT 0, fecha_empaque TEXT, bultos REAL, kilos REAL,
      observacion TEXT, abierto_en TEXT, cerrado_en TEXT, usuario_id INTEGER,
      usuario TEXT, eliminado_en TEXT);
    CREATE TABLE gal_procesos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, fecha TEXT NOT NULL,
      lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT, destino TEXT NOT NULL,
      presentacion_id INTEGER, presentacion TEXT, envase TEXT, categoria TEXT, calibre TEXT, variedad TEXT, renspa TEXT, cuartel TEXT, bultos REAL, por_bulto REAL,
      kg_unidad REAL, kilos REAL NOT NULL, tipo TEXT NOT NULL DEFAULT 'ingreso',
      reparto TEXT, repartido INTEGER NOT NULL DEFAULT 0, pallet_id INTEGER, observacion TEXT,
      estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT, usuario_id INTEGER,
      usuario TEXT, creado_en TEXT, eliminado_en TEXT);
  `);
  return db;
}

const volcar = (db, f, lote, kg) => db.prepare(
  'INSERT INTO gal_volcados (fecha,lote_id,lote_nombre,kilos) VALUES (?,?,?,?)')
  .run(f, lote, lote === 10 ? 'Cuadro 3' : 'Cuadro 4', kg);

function conDatos() {
  const db = base();
  const caja = guardarPresentacion(db, { nombre: 'Caja · 10 × 700 g', destino: 'comercial',
    envase: 'Caja', por_bulto: 10, kg_unidad: 0.7 }).id;
  const verde = guardarPresentacion(db, { nombre: 'Bin de verde', destino: 'verde',
    granel: 1 }).id;
  const desc = guardarPresentacion(db, { nombre: 'Bin de descarte', destino: 'descarte',
    granel: 1 }).id;
  volcar(db, F1, 10, 3000);
  volcar(db, '2026-11-21', 11, 1000);
  registrarProceso(db, { fecha: F1, lote_id: 10, presentacion_id: caja, bultos: 200, uuid: '1' });
  registrarProceso(db, { fecha: F1, lote_id: 10, presentacion_id: verde, kilos: 300, uuid: '2' });
  registrarProceso(db, { fecha: F2, lote_id: 11, presentacion_id: caja, bultos: 50, uuid: '3' });
  registrarProceso(db, { fecha: F2, lote_id: 11, presentacion_id: desc, kilos: 120, uuid: '4' });
  return { db, caja, verde, desc };
}

// ══════════════════════════════════════════════════════════════════════════
// 1 · QUÉ SE PROCESÓ CADA DÍA
// ══════════════════════════════════════════════════════════════════════════
test('cada día trae sus kilos abiertos por destino', () => {
  const { db } = conDatos();
  const ds = procesoPorDia(db, '2026-11-01', '2026-11-30');
  const por = {};
  for (const d of ds) por[d.fecha] = d;

  assert.equal(por[F1].comercial, 1400);
  assert.equal(por[F1].verde, 300);
  assert.equal(por[F1].descarte, 0);
  assert.equal(por[F1].procesado, 1700);
  assert.equal(por[F1].volcado, 3000);
  assert.equal(por[F2].comercial, 350);
  assert.equal(por[F2].descarte, 120);
});

test('EL RINDE DEL DÍA ES SOBRE LO PROCESADO, no sobre lo volcado', () => {
  // Lo que entra el martes se procesa el jueves. Contra el volcado del MISMO
  // día, cualquier jueves daría más de 100% — y un gráfico que pasa de 100%
  // no se lee como un error, se lee como un día muy bueno.
  const { db } = conDatos();
  const ds = procesoPorDia(db, '2026-11-01', '2026-11-30');
  const j = ds.filter((x) => x.fecha === F2)[0];
  assert.equal(j.volcado, 0, 'el armado de la prueba cambió');
  assert.equal(j.procesado, 470);
  assert.equal(j.rinde, 74.5);           // 350 / 470
  assert.ok(j.rinde <= 100, 'el rinde diario se fue por arriba de 100%');
});

test('un día sin proceso no inventa un rinde', () => {
  const { db } = conDatos();
  const d = procesoPorDia(db, '2026-11-01', '2026-11-30')
    .filter((x) => x.fecha === '2026-11-21')[0];
  assert.equal(d.procesado, 0);
  assert.equal(d.rinde, null, 'dividió por cero');
  assert.equal(d.volcado, 1000, 'perdió el volcado de un día sin proceso');
});

test('LOS DÍAS VIENEN EN ORDEN, aunque se hayan cargado al revés', () => {
  // La prueba de antes los traía ordenados por casualidad —los volcados primero y
  // justo en orden—, así que pasaba igual sin ordenar. Acá el proceso más viejo se
  // carga último: sin el sort, el gráfico arranca por el final.
  const { db, caja } = conDatos();
  registrarProceso(db, { fecha: '2026-11-02', lote_id: 10, presentacion_id: caja,
    bultos: 10, uuid: 'viejo' });
  const ds = procesoPorDia(db, '2026-11-01', '2026-11-30');
  assert.deepEqual(ds.map((x) => x.fecha), ['2026-11-02', F1, '2026-11-21', F2]);
});

test('lo borrado no aparece en el gráfico', () => {
  const { db } = conDatos();
  const id = db.prepare("SELECT id FROM gal_procesos WHERE destino = 'descarte'").get().id;
  borrarProceso(db, id);
  const d = procesoPorDia(db, '2026-11-01', '2026-11-30').filter((x) => x.fecha === F2)[0];
  assert.equal(d.descarte, 0);
  assert.equal(d.procesado, 350);
  assert.equal(d.rinde, 100);
});

test('el rango se respeta en las dos puntas', () => {
  const { db } = conDatos();
  assert.deepEqual(procesoPorDia(db, F2, F2).map((x) => x.fecha), [F2]);
  assert.deepEqual(procesoPorDia(db, '2026-12-01', '2026-12-31'), []);
  assert.deepEqual(procesoPorDia(db, 'cualquiera', F2), []);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL STOCK
// ══════════════════════════════════════════════════════════════════════════
test('EL STOCK DICE DESDE CUÁNDO, que es la pregunta de una cámara', () => {
  // 4.000 kg de ayer y 4.000 kg de hace tres semanas se escriben igual y no
  // son lo mismo.
  const { db } = conDatos();
  const st = stockGalpon(db);
  const por = {};
  for (const d of st.destinos) por[d.clave] = d;
  assert.equal(por.comercial.desde, F1);
  assert.equal(por.descarte.desde, F2);
  assert.equal(por.verde.desde, F1);
});

test('el stock suma los bultos y las cargas de cada destino', () => {
  const { db } = conDatos();
  const com = stockGalpon(db).destinos.filter((d) => d.clave === 'comercial')[0];
  assert.equal(com.kilos, 1750);
  assert.equal(com.bultos, 250);
  assert.equal(com.cargas, 2);
});

test('EL STOCK POR LOTE ES OTRA PREGUNTA, y no se deduce de la de arriba', () => {
  // «Cuánto hay de cada cosa» y «de dónde salió lo que hay» son las dos
  // preguntas que se le hacen a una cámara llena.
  const { db } = conDatos();
  // Al Cuadro 4 se le carga de más para que el ORDEN por kilos no coincida con el
  // orden por id: así el test mira el criterio y no la casualidad.
  const { db: db2, caja: caja2 } = conDatos();
  registrarProceso(db2, { fecha: F2, lote_id: 11, presentacion_id: caja2,
    bultos: 500, uuid: 'grande' });
  assert.equal(stockPorLote(db2)[0].lote_id, 11, 'no ordenó por kilos');

  const ls = stockPorLote(db);
  assert.equal(ls.length, 2);
  assert.equal(ls[0].lote_id, 10, 'no ordenó por kilos');
  assert.equal(ls[0].kilos, 1700);
  assert.equal(ls[0].comercial, 1400);
  assert.equal(ls[0].verde, 300);
  assert.equal(ls[0].finca, 'La Esperanza');
  assert.equal(ls[0].desde, F1);
  const c4 = ls.filter((x) => x.lote_id === 11)[0];
  assert.equal(c4.descarte, 120);
});

test('las salidas restan también en el stock por lote', () => {
  const { db } = conDatos();
  db.prepare("UPDATE gal_procesos SET tipo = 'salida' WHERE destino = 'verde'").run();
  const c3 = stockPorLote(db).filter((x) => x.lote_id === 10)[0];
  assert.equal(c3.verde, -300);
  assert.equal(c3.kilos, 1100);
});

test('sin nada guardado no se cae', () => {
  assert.deepEqual(stockPorLote(base()), []);
  const st = stockGalpon(base());
  assert.equal(st.kilos, 0);
  for (const d of st.destinos) assert.equal(d.desde, null);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LOS ARMADORES, EJECUTADOS
// ══════════════════════════════════════════════════════════════════════════
// Se sacan del panel y se corren de verdad. Un gráfico roto no tiene un error
// de sintaxis: tiene un `height:NaN%` que el navegador ignora en silencio.
function armadores() {
  const desde = PANEL.indexOf('var GAC = {');
  assert.ok(desde > 0, 'no encontré el bloque del acumulado');
  const hasta = PANEL.indexOf('function galAcPintar(){', desde);
  assert.ok(hasta > desde, 'no encontré el final del bloque');
  const fuente = PANEL.slice(desde, hasta);

  // Nada del bloque corre al evaluarse: lo que toca el DOM vive adentro de funciones.
  const fake = { innerHTML: '', scrollTop: 0, scrollHeight: 0 };
  return new Function('document', 'fetch', 'window',
    fuente
    + '\nreturn { galAcPintarGraficos, galAcBarrasLote, galAcColumna, GAC_COL,'
    + ' galAcFechaCorta, galAcNum, GAC };')(
    { getElementById: () => fake },
    () => Promise.reject(new Error('sin red')),
    {});
}


test('los armadores se pueden ejecutar', () => {
  const A = armadores();
  assert.equal(typeof A.galAcPintarGraficos, 'function');
  assert.equal(typeof A.galAcBarrasLote, 'function');
});

test('NINGUNA COLUMNA SALE CON NaN NI undefined', () => {
  const A = armadores();
  const dia = { fecha: '2026-11-20', comercial: 1400, verde: 300, descarte: 0,
                procesado: 1700, volcado: 3000, rinde: 82.4 };
  const html = A.galAcColumna(dia, 1700);
  assert.ok(html.length > 0);
  assert.ok(!/NaN|undefined|Infinity/.test(html), 'el HTML salió con ' + html);
  // Y el destino en cero no dibuja un tramo invisible que igual come 2px.
  assert.equal((html.match(/<i /g) || []).length, 2);
});

test('LAS ALTURAS CAEN ENTRE 0 Y 100, siempre', () => {
  const A = armadores();
  const casos = [
    [{ fecha: '2026-11-20', comercial: 1400, verde: 300, descarte: 0 }, 1700],
    [{ fecha: '2026-11-20', comercial: 1, verde: 0, descarte: 0 }, 1],
    // El primer día de la temporada: el máximo todavía es cero.
    [{ fecha: '2026-11-20', comercial: 0, verde: 0, descarte: 0 }, 0],
    /* UNA SALIDA deja el total procesado POR DEBAJO de uno de sus tramos: 500 de
       comercial sobre 300 procesados son 166%, y la columna se sale del cuadro. */
    [{ fecha: '2026-11-20', comercial: 500, verde: -200, descarte: 0 }, 300],
    [{ fecha: '2026-11-20', comercial: -50, verde: 0, descarte: 0 }, 100],
  ];
  for (const [dia, max] of casos) {
    const html = A.galAcColumna(dia, max);
    for (const m of html.matchAll(/height:([\d.]+)%/g)) {
      const h = Number(m[1]);
      assert.ok(h >= 0 && h <= 100, 'altura fuera de rango: ' + m[1] + '%');
    }
    assert.ok(!/NaN|Infinity/.test(html), 'con max=' + max + ' salió ' + html);
  }
});

test('UN DÍA QUE NETEA EN CERO NO DIBUJA UNA COLUMNA LLENA', () => {
  // Con una salida que cancela todo, lo procesado del día es 0 y el máximo también.
  // Sin la guarda, 500 dividido 0 es Infinity y la columna sale ENTERA: un día que
  // no dejó nada se vería como el más grande de la temporada.
  const A = armadores();
  const html = A.galAcColumna({ fecha: '2026-11-20', comercial: 500, verde: 0, descarte: 0 }, 0);
  for (const m of html.matchAll(/height:([\d.]+)%/g)) {
    assert.equal(Number(m[1]), 0, 'dibujó una columna con el total en cero');
  }
  assert.ok(!/NaN|Infinity/.test(html), html);
});

test('la barra del lote no se pasa del ancho ni con el rinde dado vuelta', () => {
  const A = armadores();
  const casos = [
    { volcado: 1000, procesado: 700, comercial: 500, verde: 150, descarte: 50,
      sin_procesar: 300 },
    // Se procesó MÁS de lo volcado: la barra no puede desbordar el renglón.
    { volcado: 500, procesado: 900, comercial: 900, verde: 0, descarte: 0,
      sin_procesar: -400 },
    { volcado: 0, procesado: 0, comercial: 0, verde: 0, descarte: 0, sin_procesar: 0 },
  ];
  for (const f of casos) {
    const html = A.galAcBarrasLote(f);
    let suma = 0;
    for (const m of html.matchAll(/width:([\d.]+)%/g)) suma += Number(m[1]);
    assert.ok(suma <= 100.01, 'la barra suma ' + suma + '%');
    assert.ok(!/NaN|undefined|Infinity/.test(html), html);
  }
});

test('CADA TRAMO LLEVA SU NÚMERO: el color no es lo único que distingue', () => {
  const A = armadores();
  const html = A.galAcColumna(
    { fecha: '2026-11-20', comercial: 1400, verde: 300, descarte: 0 }, 1700);
  assert.match(html, /title="[^"]*Comercial: 1\.400 kg/);
  assert.match(html, /title="[^"]*Verde: 300 kg/);
});

test('los colores son los validados, no los de antes', () => {
  // Los que estaban tenían el rojo y el naranja a ΔE 14,4: por debajo del piso
  // con visión NORMAL, o sea difíciles de separar incluso sin daltonismo.
  const A = armadores();
  assert.deepEqual(A.GAC_COL,
    { comercial: '#15803d', verde: '#f59e0b', descarte: '#b91c1c' });
});

test('el día sin rinde no dibuja una barra de cero', () => {
  // Una columna en cero se lee como «ese día rindió 0%», que es otra cosa que
  // «ese día no se procesó».
  assert.match(PANEL, /x\.rinde == null \? ''/);
});

test('los dos cuadros van SEPARADOS, no en uno con dos ejes', () => {
  // Kilos y porcentaje no comparten escala: un solo cuadro con dos ejes deja
  // elegir cuál sube y cuál baja según dónde se corte cada uno.
  assert.match(PANEL, /Cuánto se procesó cada día/);
  assert.match(PANEL, /Cómo rindió cada día/);
  assert.match(PANEL, /DOS CUADROS Y NO UNO/);
});

test('LAS COLUMNAS SE REPARTEN EL ANCHO: no pueden desbordar', () => {
  // Un mes entero con columnas de ancho fijo se sale de la pantalla, y lo que pasa
  // entonces es la barra lateral que CLAUDE.md prohíbe. Con flex:1 1 0 el desborde
  // es imposible por construcción, sin necesidad de recortar nada.
  assert.match(PANEL, /#sec-galpon-acumulado \.gac-col\{flex:1 1 0;/);
  assert.match(PANEL, /max-width:48px/);
});

test('EL ÁREA DE DIBUJO NO FIJA NINGÚN EJE', () => {
  // Poner overflow-x:hidden le hace poner al navegador una barra VERTICAL —fijar un
  // eje convierte el otro en auto— y aparecía una barrita adentro de cada cuadro.
  const i = PANEL.indexOf('#sec-galpon-acumulado .gac-plot{');
  assert.ok(i > 0, 'no encontré la regla del área de dibujo');
  const regla = PANEL.slice(i, PANEL.indexOf('}', i));
  assert.ok(!/overflow/.test(regla), 'volvió el overflow: ' + regla);
});

test('EL NÚMERO NO VA EN TODAS LAS COLUMNAS', () => {
  // Uno por columna no entra, y lo que no entra se recorta: «1.030» recortado es
  // «1.03» — un número equivocado y perfectamente creíble. Va en el día más grande
  // y en el último, y el resto se lee en el tooltip.
  assert.match(PANEL, /var destaca = i === iMax \|\| i === dias\.length - 1;/);
  assert.match(PANEL, /function galAcCadaCuantos\(n, cabenPx\)\{/);
  // Y las fechas tampoco: con veinte días se pisan y el navegador las recorta.
  assert.match(PANEL, /i === 0 \|\| i === dias\.length - 1 \|\| i % cada === 0/);
});
