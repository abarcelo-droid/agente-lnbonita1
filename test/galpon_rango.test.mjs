// ══ 📋 TODAS LAS CARGAS, A TRAVÉS DE LOS DÍAS ════════════════════════════
//
// Andy, 4/11/2026: «quiero un lugar que sea transversal a los días, es decir
// que pueda ver todos los procesos de cada día».
//
// Una lista que cruza días tiene tres maneras de mentir, y las tres se leen
// como un número normal:
//
//   1. DESAGRUPAR LA MEZCLA. Una carga que salió de tres lotes vuelve a verse
//      en tres renglones con los bultos prorrateados —0,33 · 3,53 · 5,14, que
//      la pantalla redondea a 0, 4 y 5—. Un renglón de «0 bultos» no es nada
//      que exista en el galpón. Es el mismo error que la V1139 sacó de la
//      pantalla de Proceso.
//   2. TOTALIZAR SÓLO LO QUE SE DIBUJÓ. Con un tope de filas, un total que
//      cuente nada más que las que entraron cambia según cuánto se pidió, y
//      nada lo dice.
//   3. RECORTAR POR EL LADO EQUIVOCADO. El tope tiene que llevarse lo más
//      viejo; si se lleva lo último, falta justo el día que se vino a mirar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  guardarPresentacion, guardarDatosDeLote, registrarProceso, borrarProceso,
  procesosDelRango, TOPE_CARGAS_RANGO,
} from '../src/servicios/galpon.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_sectores (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT);
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
                           sector_id INTEGER, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca) VALUES
      (10,'Cuadro 3','El Abuelo'), (11,'Cuadro 4','La Estación');
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER,
      cultivo TEXT, campaña TEXT, es_perenne INTEGER DEFAULT 0);
    INSERT INTO pa_cultivos_lote (lote_id,cultivo,es_perenne) VALUES
      (10,'Damasco',1), (11,'Damasco',1);
    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
    INSERT INTO gal_config (clave,valor) VALUES ('pallet_prefijo','PC');
    CREATE TABLE gal_volcado_cuadrillas (
      volcado_id INTEGER NOT NULL, cuadrilla_id INTEGER NOT NULL,
      cuadrilla TEXT, kilos REAL NOT NULL, PRIMARY KEY (volcado_id, cuadrilla_id));
    CREATE TABLE gal_volcados (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT,
      lote_id INTEGER, lote_nombre TEXT, producto TEXT, kilos REAL, ifcos INTEGER,
      viaje INTEGER, sanitario TEXT, eliminado_en TEXT);
    CREATE TABLE gal_lote_datos (lote_id INTEGER PRIMARY KEY, renspa TEXT, variedad TEXT,
      cuartel TEXT, notas TEXT, actualizado TEXT);
    CREATE TABLE gal_presentaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT,
      destino TEXT, envase TEXT, por_bulto REAL DEFAULT 1, kg_unidad REAL DEFAULT 1,
      granel INTEGER DEFAULT 0, emoji TEXT, icono TEXT, icono_v TEXT,
      categoria TEXT NOT NULL DEFAULT 'I', calibre TEXT, color TEXT,
      orden INTEGER DEFAULT 100, activo INTEGER DEFAULT 1, creado_en TEXT, eliminado_en TEXT);
    CREATE TABLE gal_pallets (id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT UNIQUE,
      estado TEXT NOT NULL DEFAULT 'abierto', parcial INTEGER NOT NULL DEFAULT 0,
      mixto INTEGER NOT NULL DEFAULT 0, origen TEXT NOT NULL DEFAULT 'proceso',
      fecha_empaque TEXT, bultos REAL, kilos REAL, observacion TEXT, abierto_en TEXT,
      cerrado_en TEXT, usuario_id INTEGER, usuario TEXT, eliminado_en TEXT);
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
  guardarDatosDeLote(db, { lote_id: 10, renspa: '12.345.6.78901/00', variedad: 'Bulida' });
  return db;
}

// 10 cubetas de 500 g = 5 kg por bulto.
const art = (db, nombre, destino) => guardarPresentacion(db, {
  nombre, destino: destino || 'comercial', envase: 'Caja', por_bulto: 10,
  kg_unidad: 0.5, categoria: 'I' }).id;

let n = 0;
const cargar = (db, fecha, pres, bultos, extra) => registrarProceso(db,
  Object.assign({ fecha, lote_id: 10, presentacion_id: pres, bultos,
                  uuid: 'u' + (++n) }, extra || {}));

// ══════════════════════════════════════════════════════════════════════════
// 1 · CRUZA LOS DÍAS
// ══════════════════════════════════════════════════════════════════════════
test('TRAE VARIOS DÍAS, agrupados, el más nuevo arriba', () => {
  const db = base();
  const a = art(db, 'Caja');
  cargar(db, '2026-11-02', a, 10);
  cargar(db, '2026-11-04', a, 20);
  cargar(db, '2026-11-04', a, 5, { presentacion_id: art(db, 'Bin', 'verde') });

  const r = procesosDelRango(db, '2026-11-01', '2026-11-30');
  assert.deepEqual(r.dias.map((d) => d.fecha), ['2026-11-04', '2026-11-02'],
    'los días no vienen del más nuevo al más viejo');
  assert.equal(r.dias[0].cargas.length, 2);
  assert.equal(r.dias[1].cargas.length, 1);
  assert.equal(r.total.cargas, 3);
  assert.equal(r.total.dias, 2);
  assert.equal(r.total.bultos, 35);
  assert.equal(r.total.kilos, 175);
});

test('el día trae su propio total, que es el que se lee en su renglón', () => {
  const db = base();
  const a = art(db, 'Caja');
  cargar(db, '2026-11-04', a, 20);
  cargar(db, '2026-11-04', a, 30);
  const d = procesosDelRango(db, '2026-11-01', '2026-11-30').dias[0];
  assert.equal(d.bultos, 50);
  assert.equal(d.kilos, 250);
});

test('fuera del rango NO entra', () => {
  const db = base();
  const a = art(db, 'Caja');
  cargar(db, '2026-10-31', a, 10);
  cargar(db, '2026-11-04', a, 20);
  cargar(db, '2026-12-01', a, 30);
  const r = procesosDelRango(db, '2026-11-01', '2026-11-30');
  assert.equal(r.total.cargas, 1);
  assert.equal(r.dias[0].fecha, '2026-11-04');
});

test('una carga BORRADA no aparece', () => {
  const db = base();
  const a = art(db, 'Caja');
  const x = cargar(db, '2026-11-04', a, 20);
  cargar(db, '2026-11-04', a, 30);
  borrarProceso(db, x.ids[0]);
  const r = procesosDelRango(db, '2026-11-01', '2026-11-30');
  assert.equal(r.total.cargas, 1);
  assert.equal(r.total.bultos, 30);
});

test('sin fechas válidas devuelve vacío y no revienta', () => {
  const db = base();
  for (const [d, h] of [[null, null], ['', '2026-11-04'], ['ayer', 'hoy']]) {
    const r = procesosDelRango(db, d, h);
    assert.deepEqual(r.dias, []);
    assert.equal(r.total.cargas, 0);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · UNA CARGA ES UN RENGLÓN (el error de la V1139, otra vez)
// ══════════════════════════════════════════════════════════════════════════
test('LA MEZCLA ES UN SOLO RENGLÓN, con los bultos enteros', () => {
  /* Nueve cajones entre tres lotes son 0,33 · 3,53 · 5,14. Mostrados a pedazos
     se redondean a 0, 4 y 5 — y un renglón de «0 bultos · 0,74 kg» no se puede
     contar, ni subir a un camión, ni comparar contra la pila. */
  const db = base();
  const a = art(db, 'Caja');
  db.prepare('INSERT INTO gal_volcados (fecha,lote_id,kilos) VALUES (?,?,?)')
    .run('2026-11-04', 10, 3000);
  db.prepare('INSERT INTO gal_volcados (fecha,lote_id,kilos) VALUES (?,?,?)')
    .run('2026-11-04', 11, 1000);
  const x = registrarProceso(db, { fecha: '2026-11-04', lote_ids: [10, 11],
    presentacion_id: a, bultos: 9, uuid: 'mz' });
  assert.equal(x.ids.length, 2, 'por dentro se siguen guardando dos filas');

  const r = procesosDelRango(db, '2026-11-01', '2026-11-30');
  assert.equal(r.total.cargas, 1, 'la carga mezclada se desarmó en la lista');
  assert.equal(r.dias[0].cargas.length, 1);
  assert.equal(r.dias[0].cargas[0].bultos, 9, 'los bultos sólo son ciertos enteros');
  assert.equal(r.dias[0].cargas[0].lotes, 2, 'no dice de cuántos lotes salió');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL TOPE
// ══════════════════════════════════════════════════════════════════════════
test('EL TOTAL CUENTA TODAS, también las que el tope dejó afuera', () => {
  /* Un total que contara sólo las filas dibujadas cambiaría según cuánto se
     pidió, y nada lo diría. */
  const db = base();
  const a = art(db, 'Caja');
  const cuantas = TOPE_CARGAS_RANGO + 7;
  for (let i = 0; i < cuantas; i++) cargar(db, '2026-11-04', a, 1);

  const r = procesosDelRango(db, '2026-11-01', '2026-11-30');
  assert.equal(r.total.cargas, cuantas, 'el total se achicó con el tope');
  assert.equal(r.total.bultos, cuantas);
  assert.equal(r.hay_mas, 7);
  assert.equal(r.tope, TOPE_CARGAS_RANGO);
  assert.equal(r.dias[0].cargas.length, TOPE_CARGAS_RANGO);
});

test('el tope se lleva lo MÁS VIEJO, no lo último', () => {
  // Lo que se vino a mirar es lo de arriba. Recortar por ahí es no mostrar nada.
  const db = base();
  const a = art(db, 'Caja');
  for (let i = 0; i < TOPE_CARGAS_RANGO; i++) cargar(db, '2026-11-01', a, 1);
  cargar(db, '2026-11-20', a, 99);

  const r = procesosDelRango(db, '2026-11-01', '2026-11-30');
  assert.equal(r.hay_mas, 1);
  assert.equal(r.dias[0].fecha, '2026-11-20', 'se comió el día más nuevo');
  assert.equal(r.dias[0].cargas[0].bultos, 99);
});

test('UN DÍA QUE EL TOPE SE LLEVÓ ENTERO NO APARECE, Y MENOS VACÍO', () => {
  /* Lo agarró la prueba de mutación. Los días se arman con TODAS las cargas —hay
     que sumarlas para el total— y recién después se les cuelgan las que entraron en
     el tope. Si el tope se llevó el día completo queda un renglón de día sin una
     sola fila debajo: un encabezado que anuncia cargas que no están. */
  const db = base();
  const a = art(db, 'Caja');
  cargar(db, '2026-11-01', a, 7);                                   // la más vieja
  for (let i = 0; i < TOPE_CARGAS_RANGO; i++) cargar(db, '2026-11-20', a, 1);

  const r = procesosDelRango(db, '2026-11-01', '2026-11-30');
  assert.equal(r.hay_mas, 1);
  assert.deepEqual(r.dias.map((d) => d.fecha), ['2026-11-20'],
    'apareció un día sin ninguna carga adentro');
  assert.ok(r.dias.every((d) => d.cargas.length), 'hay un día vacío en la lista');
  // Y el total lo sigue contando: no se mostró, pero pasó.
  assert.equal(r.total.cargas, TOPE_CARGAS_RANGO + 1);
  assert.equal(r.total.dias, 2, 'el total dejó de contar el día que no se mostró');
});

test('sin tope alcanzado, hay_mas es 0', () => {
  const db = base();
  const a = art(db, 'Caja');
  cargar(db, '2026-11-04', a, 10);
  assert.equal(procesosDelRango(db, '2026-11-01', '2026-11-30').hay_mas, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · DESTINO, SALIDAS, PALLET Y ⚠
// ══════════════════════════════════════════════════════════════════════════
test('el filtro POR DESTINO filtra la lista Y los totales', () => {
  const db = base();
  const a = art(db, 'Caja', 'comercial');
  const v = art(db, 'Bin', 'verde');
  cargar(db, '2026-11-04', a, 20);
  cargar(db, '2026-11-04', v, 6);

  const todo = procesosDelRango(db, '2026-11-01', '2026-11-30');
  assert.equal(todo.total.cargas, 2);
  assert.equal(todo.total.destinos.comercial, 100);
  assert.equal(todo.total.destinos.verde, 30);

  const sol = procesosDelRango(db, '2026-11-01', '2026-11-30', { destino: 'verde' });
  assert.equal(sol.total.cargas, 1);
  assert.equal(sol.total.kilos, 30);
  assert.equal(sol.dias[0].cargas[0].destino, 'verde');
});

test('un destino inventado no filtra nada: se ignora en vez de vaciar la pantalla', () => {
  const db = base();
  const a = art(db, 'Caja');
  cargar(db, '2026-11-04', a, 20);
  const r = procesosDelRango(db, '2026-11-01', '2026-11-30', { destino: 'rosa' });
  assert.equal(r.total.cargas, 1);
});

test('LAS SALIDAS RESTAN: lo verde que volvió a la tolva no se cuenta dos veces', () => {
  const db = base();
  const a = art(db, 'Caja');
  cargar(db, '2026-11-04', a, 20);
  // Una salida escrita a mano: hoy sólo las escribe el reproceso, pero la
  // columna existe desde el día uno y la suma tiene que respetarla.
  db.prepare(
    " INSERT INTO gal_procesos (fecha,lote_id,destino,presentacion_id,bultos,kilos,tipo)"
    + " VALUES ('2026-11-04',10,'comercial',?,5,25,'salida')").run(a);

  const r = procesosDelRango(db, '2026-11-01', '2026-11-30');
  assert.equal(r.total.bultos, 15);
  assert.equal(r.total.kilos, 75);
  assert.equal(r.total.destinos.comercial, 75);
  assert.equal(r.dias[0].kilos, 75);
});

test('EL PALLET VIAJA: su número si está cerrado, nada inventado si no', () => {
  const db = base();
  const a = art(db, 'Caja');
  const x = cargar(db, '2026-11-04', a, 20, { cerrar_pallet: 1 });
  cargar(db, '2026-11-05', a, 10);

  const r = procesosDelRango(db, '2026-11-01', '2026-11-30');
  const abierta = r.dias[0].cargas[0];   // 05, el pallet quedó abierto
  const cerrada = r.dias[1].cargas[0];   // 04, cerrado
  assert.equal(cerrada.pallet_numero, x.pallet_cerrado.numero);
  assert.equal(cerrada.pallet_estado, 'cerrado');
  assert.equal(abierta.pallet_numero, null, 'le inventó un número a un pallet abierto');
  assert.ok(abierta.pallet_id, 'perdió el pallet al que fue a parar');
});

test('lo marcado a revisar se cuenta, en el día y en el total', () => {
  const db = base();
  const a = art(db, 'Caja');
  db.prepare("INSERT INTO gal_config (clave,valor) VALUES ('kg_max_proceso','100')").run();
  cargar(db, '2026-11-04', a, 10);    // 50 kg, entra bien
  cargar(db, '2026-11-04', a, 100);   // 500 kg, pasa el tope

  const r = procesosDelRango(db, '2026-11-01', '2026-11-30');
  assert.equal(r.total.a_revisar, 1);
  assert.equal(r.dias[0].a_revisar, 1);
  assert.ok(r.dias[0].cargas.some((c) => c.estado === 'a_revisar'));
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LA PANTALLA, EJECUTADA
// ══════════════════════════════════════════════════════════════════════════
function elemento(id) {
  const el = { id, innerHTML: '', textContent: '', value: '', disabled: false,
               style: { display: '' },
               classList: { add() {}, remove() {}, contains: () => false } };
  return el;
}

function domFalso() {
  const nodos = {};
  const clics = [];
  return { nodos, clics,
    document: {
      getElementById: (id) => (nodos[id] || (nodos[id] = elemento(id))),
      querySelector: (q) => {
        const m = /data-sec="([^"]+)"/.exec(q);
        return m ? { click() { clics.push(m[1]); } } : null;
      },
    } };
}

function corte(desde, hasta) {
  const a = PANEL.indexOf(desde);
  assert.ok(a > 0, 'no encontré en panel.html: ' + desde);
  const b = PANEL.indexOf(hasta, a);
  assert.ok(b > a, 'no encontré el final: ' + hasta);
  return PANEL.slice(a, b);
}

function pantalla(dom, opts) {
  const o = opts || {};
  const codigo =
    // El escape, el formato y la fecha corta, de verdad.
    corte('function galAcEsc(s){', 'async function galAcInit(){')
    // La puerta de ida, con su variable: el día pedido desde la otra pantalla.
    + corte('var GPR_PEDIDO = null;', 'function galPrHoy(){')
    // Y el detalle.
    + corte('function galAcProcVer(){', 'function galAcRango(tipo){');

  const f = new Function('document', 'fetch', 'GAC', 'GPR', 'galPrCargar', 'loadSec',
    codigo
    + '\nreturn { galAcProcVer, galAcProcDest, galAcProcCargar, galAcProcPintar,'
    + ' galAcProcIrAlDia, galPrVerTodosLosDias, galPrInit,'
    + ' pedido: function(){ return GPR_PEDIDO; } };');

  dom.pedidos = [];
  const GAC = Object.assign({ datos: { desde: '2026-11-01', hasta: '2026-11-30' },
    rango: null, hoy: '2026-11-30', proc: null, procVer: false, procDest: '',
    procCargando: false }, o.GAC || {});
  const GPR = Object.assign({ lotes: [10], fecha: null }, o.GPR || {});

  const api = f(
    dom.document,
    (url) => {
      dom.pedidos.push(url);
      return Promise.resolve({ json: () => Promise.resolve(
        o.respuesta || { ok: true, dias: [], total: { cargas: 0, bultos: 0, kilos: 0,
          dias: 0, a_revisar: 0 }, hay_mas: 0, tope: 400 }) });
    },
    GAC, GPR,
    () => Promise.resolve(),
    undefined,
  );
  api.GAC = GAC; api.GPR = GPR;
  return api;
}

const RESP = { ok: true, tope: 400, hay_mas: 0,
  total: { cargas: 3, bultos: 35, kilos: 175, dias: 2, a_revisar: 0,
           destinos: { comercial: 150, verde: 25, descarte: 0 } },
  dias: [
    { fecha: '2026-11-04', bultos: 25, kilos: 125, a_revisar: 0, cargas: [
      { destino: 'comercial', producto: 'Damasco', presentacion: 'IFCO HN',
        bultos: 20, kilos: 100, estado: 'ok', pallet_id: 3,
        pallet_numero: 'PC-26-00003', pallet_estado: 'cerrado' },
      { destino: 'verde', producto: 'Damasco', presentacion: 'Blanca Verde',
        bultos: 5, kilos: 25, estado: 'ok', pallet_id: 4, pallet_numero: null,
        pallet_estado: 'abierto' }] },
    { fecha: '2026-11-02', bultos: 10, kilos: 50, a_revisar: 1, cargas: [
      { destino: 'comercial', producto: 'Damasco', presentacion: 'Caja cartón',
        bultos: 10, kilos: 50, estado: 'a_revisar', pallet_id: null,
        pallet_numero: null }] }] };

test('ARRANCA PLEGADO Y NO PIDE NADA', () => {
  /* Son cientos de renglones y la pregunta con la que se entra a Acumulado es
     «cuánto llevamos», no «qué se cargó el martes». */
  const dom = domFalso();
  const api = pantalla(dom);
  api.galAcProcPintar();
  assert.deepEqual(dom.pedidos, [], 'pidió el detalle sin que nadie lo abriera');
  const h = dom.document.getElementById('gac-proc').innerHTML;
  assert.match(h, /ver qué se cargó cada día del período/);
  assert.ok(!/<table/.test(h), 'dibujó la tabla estando plegado');
});

test('PLEGADO NO DIBUJA LA TABLA NI CON EL DETALLE YA CARGADO', () => {
  /* Lo agarró la prueba de mutación: con GAC.proc en null el test de arriba pasaba
     igual sin el corte, porque más abajo hay otro «si no hay datos, sólo el botón».
     El caso de verdad es el de siempre: se abre, se mira y se vuelve a plegar. */
  const dom = domFalso();
  const api = pantalla(dom, { GAC: { procVer: false, proc: RESP } });
  api.galAcProcPintar();
  const h = dom.document.getElementById('gac-proc').innerHTML;
  assert.ok(!/<table/.test(h), 'dibujó la tabla estando plegado');
  assert.ok(!/IFCO HN/.test(h));
  assert.match(h, /ver qué se cargó cada día del período/);
});

test('AL ABRIRLO LO PIDE UNA SOLA VEZ, con el período de arriba', async () => {
  const dom = domFalso();
  const api = pantalla(dom, { respuesta: RESP });
  api.galAcProcVer();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(dom.pedidos.length, 1);
  assert.match(dom.pedidos[0], /^\/api\/galpon\/procesos\/rango\?/);
  assert.match(dom.pedidos[0], /desde=2026-11-01/);
  assert.match(dom.pedidos[0], /hasta=2026-11-30/);
  // Y cerrarlo y volver a abrirlo no lo pide de nuevo: ya está en memoria.
  api.galAcProcVer();
  api.galAcProcVer();
  assert.equal(dom.pedidos.length, 1, 'lo volvió a pedir sin que cambiara nada');
});

test('LA TABLA MUESTRA LOS DÍAS Y SUS CARGAS', async () => {
  const dom = domFalso();
  const api = pantalla(dom, { respuesta: RESP, GAC: { procVer: true } });
  await api.galAcProcCargar();
  const h = dom.document.getElementById('gac-proc').innerHTML;

  assert.match(h, /mié 04\/11/, 'no está el día');
  assert.match(h, /lun 02\/11/);
  assert.match(h, /IFCO HN/);
  assert.match(h, /Blanca Verde/);
  assert.match(h, /PC-26-00003/, 'no dice en qué pallet quedó');
  assert.match(h, /sin cerrar/, 'un pallet abierto tiene que decirse, no inventar número');
  assert.match(h, /⚠/, 'no marca la carga a revisar');
  assert.match(h, /1 a revisar/, 'el día no dice cuántas tiene a revisar');
  // Los totales de arriba son los del servidor, no una suma de lo dibujado.
  assert.match(h, />3<\/b> cargas/);
  /* Con la unidad pegada a lo que sigue: />175<\/b> kg/ a secas matchea también
     «kg2», y así el renglón podía terminar diciendo cualquier cosa al lado del
     número sin que nada se pusiera rojo. */
  assert.match(h, />175<\/b> kg en <b/, 'el total de kilos no se lee como kilos');
});

test('SIN BARRA LATERAL: tantos <col> como <th>, 100% y el colspan al día', () => {
  /* CLAUDE.md: anchos por columna y nada que se arrastre. Y un colspan que no
     cubra las columnas que hay corre todo el encabezado medio casillero. */
  const js = corte('function galAcProcPintar(){', '/* LA PUERTA DE VUELTA.');
  const cols = js.match(/<col style="width:(\d+)%">/g) || [];
  const ths = js.match(/<th[\s>]/g) || [];
  assert.equal(cols.length, ths.length,
    'hay ' + cols.length + ' <col> y ' + ths.length + ' <th>');
  const suma = cols.reduce((t, c) => t + Number(/width:(\d+)%/.exec(c)[1]), 0);
  assert.equal(suma, 100, 'los anchos suman ' + suma + ' y no 100');
  assert.ok(js.includes('colspan="' + ths.length + '"'),
    'el renglón del día no abarca las columnas que hay');
  assert.match(PANEL, /#sec-galpon-acumulado \.gac-ptbl\{table-layout:fixed/,
    'la tabla nueva no tiene anchos fijos');
});

test('EL CHIP DE DESTINO VUELVE A PEDIR, con el destino puesto', async () => {
  const dom = domFalso();
  const api = pantalla(dom, { respuesta: RESP, GAC: { procVer: true, proc: RESP } });
  api.galAcProcDest('verde');
  await new Promise((r) => setTimeout(r, 0));
  assert.match(dom.pedidos[0], /destino=verde/);
  // Y apretarlo de nuevo lo saca: es un filtro, no un camino de ida.
  api.galAcProcDest('verde');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!/destino=/.test(dom.pedidos[1]), 'el chip no se puede apagar');
  assert.equal(api.GAC.procDest, '');
});

test('EL AVISO DEL TOPE DICE QUE LOS TOTALES CUENTAN TODAS', async () => {
  const dom = domFalso();
  const api = pantalla(dom, { GAC: { procVer: true },
    respuesta: Object.assign({}, RESP, { hay_mas: 112, tope: 400 }) });
  await api.galAcProcCargar();
  const h = dom.document.getElementById('gac-proc').innerHTML;
  assert.match(h, /112/);
  assert.match(h, /cuentan <b>todas<\/b>/,
    'no aclara que el total no se recortó: el número parecería de las 400');
  assert.match(h, /achicá el período/);
});

test('un período sin nada lo dice, y dice si fue el filtro', async () => {
  const dom = domFalso();
  const api = pantalla(dom, { GAC: { procVer: true, procDest: 'descarte' },
    respuesta: { ok: true, dias: [], hay_mas: 0, tope: 400,
      total: { cargas: 0, bultos: 0, kilos: 0, dias: 0 } } });
  await api.galAcProcCargar();
  const h = dom.document.getElementById('gac-proc').innerHTML;
  assert.match(h, /No se cargó ningún proceso en este período para ese destino/);
});

// ── LAS DOS PUERTAS ───────────────────────────────────────────────────────
test('DESDE PROCESO SE VA AL DETALLE, Y YA ABIERTO', () => {
  /* Llegar a una pantalla donde hay que apretar otro plegable es media puerta. */
  const dom = domFalso();
  const api = pantalla(dom);
  api.galPrVerTodosLosDias();
  assert.equal(api.GAC.procVer, true, 'llega plegado');
  assert.deepEqual(dom.clics, ['galpon-acumulado']);
});

test('Y DESDE EL DETALLE SE VUELVE AL DÍA, con el almanaque puesto', async () => {
  const dom = domFalso();
  const api = pantalla(dom, { GPR: { lotes: [10, 11] } });
  api.galAcProcIrAlDia('2026-11-02');
  assert.deepEqual(dom.clics, ['galpon-proceso']);
  assert.equal(api.pedido(), '2026-11-02');

  // El init lo consume: escribe la fecha, la olvida y SUELTA LOS LOTES.
  await api.galPrInit();
  assert.equal(dom.document.getElementById('gpr-fecha').value, '2026-11-02');
  assert.equal(api.pedido(), null, 'el día pedido quedó pegado para la próxima vez');
  assert.deepEqual(api.GPR.lotes, [],
    'quedó filtrado por los lotes de antes: faltaría la mitad de las cargas del día');
});

test('sin día pedido, el init no toca nada', async () => {
  const dom = domFalso();
  const api = pantalla(dom, { GPR: { lotes: [10] } });
  dom.document.getElementById('gpr-fecha').value = '2026-11-30';
  await api.galPrInit();
  assert.equal(dom.document.getElementById('gpr-fecha').value, '2026-11-30');
  assert.deepEqual(api.GPR.lotes, [10], 'le soltó los lotes a quien no pidió nada');
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · EL MANUAL, CONTRA EL CÓDIGO
// ══════════════════════════════════════════════════════════════════════════
function manualDe(modulo) {
  const i = PANEL.indexOf("SG_MANUAL['" + modulo + "']");
  assert.ok(i > 0, modulo + ' no tiene «¿Cómo se usa?»');
  return PANEL.slice(i, PANEL.indexOf('\n};', i)).replace(/'\s*\r?\n\s*\+\s*'/g, '');
}
const lector = (t) => (re, nota) => assert.ok(re.test(t),
  'EL MANUAL NO DICE: ' + re.source + (nota ? '\n  (' + nota + ')' : ''));
const diceAc = lector(manualDe('galpon-acumulado'));
const dicePr = lector(manualDe('galpon-proceso'));

test('LOS DOS MANUALES CUENTAN LO NUEVO, con su versión', () => {
  diceAc(/Todas las cargas, día por día <span class="ver">V1141<\/span>/);
  dicePr(/Un día por vez, y dónde están todos juntos <span class="ver">V1141<\/span>/);
  diceAc(/transversal a los días/);
});

test('el manual dice que usa el MISMO período de arriba — y lo usa', () => {
  diceAc(/el mismo período de arriba/);
  const js = corte('async function galAcProcCargar(){', 'function galAcProcDestInfo(');
  assert.match(js, /GAC\.datos\.desde/);
  assert.match(js, /GAC\.datos\.hasta/);
  assert.ok(!/gac-desde/.test(js), 'se armó un segundo selector de fechas');
});

test('el manual dice que se pide RECIÉN al abrirlo — y así es', () => {
  diceAc(/recién al abrirlo/);
  const js = corte('function galAcProcVer(){', 'function galAcProcDest(');
  assert.match(js, /if \(GAC\.procVer && !GAC\.proc\) galAcProcCargar\(\);/);
});

test('el manual dice tope de 400 y totales completos — y el servicio lo hace así', () => {
  diceAc(/tope de 400 cargas/);
  assert.equal(TOPE_CARGAS_RANGO, 400, 'el manual dice un número y el código tiene otro');
  diceAc(/cuentan <b>todas<\/b>/);
  const db = base();
  const a = art(db, 'Caja');
  for (let i = 0; i < TOPE_CARGAS_RANGO + 3; i++) cargar(db, '2026-11-04', a, 1);
  const r = procesosDelRango(db, '2026-11-01', '2026-11-30');
  assert.equal(r.total.cargas, TOPE_CARGAS_RANGO + 3);
});

test('el manual dice que desde Acumulado NO se corrige — y no hay con qué', () => {
  diceAc(/Desde acá no se corrige/);
  const js = corte('function galAcProcPintar(){', '/* LA PUERTA DE VUELTA.');
  assert.ok(!/galProcAbrir|galPrBorrar/.test(js),
    'la lista del período ofrece editar: es el mecanismo escrito dos veces');
  assert.match(js, /abrir el día →/);
});

test('el manual de Proceso manda al botón que existe', () => {
  /* Y explica POR QUÉ esta pantalla está parada en un día. Sin esa línea el manual
     dice que no se puede y suena a que falta hacerlo, cuando es la respuesta: lo que
     se tipea entra en el día del almanaque, y un rango no diría en cuál se guarda. */
  dicePr(/no es una limitación: es con lo que se carga/);
  dicePr(/Ver todos los días/);
  assert.ok(PANEL.includes('onclick="galPrVerTodosLosDias()"'),
    'el manual anuncia un botón que nadie dibujó');
  dicePr(/abrir el día →/);
});

test('el manual dice que al volver no queda ningún lote elegido — y no queda', () => {
  dicePr(/sin ningún lote elegido/);
  const js = corte('async function galPrInit(){', 'function galPrVerTodosLosDias(){');
  assert.match(js, /GPR\.lotes = \[\];/);
});
