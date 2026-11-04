// ══ 🧱 CARGAR Y CERRAR EL PALLET, DE UNA ═════════════════════════════════
//
// Andy, 4/11/2026: «tiene que existir la forma en el proceso de directamente
// cerrar pallet, es decir no procesar y después cerrar el pallet. Hacerlo
// juntos».
//
// Un pallet que se completa con una sola carga eran dos gestos para un hecho.
// Juntarlos arregla eso y abre tres maneras nuevas de que salga mal, y las
// tres salen IMPRESAS y se van en un camión:
//
//   1. EL PALLET FANTASMA. El segundo clic de un doble clic llega con el
//      pallet ya cerrado. Si se abre uno nuevo para una carga que no se va a
//      insertar, queda un pallet vacío abierto que se lleva la primera caja de
//      la mañana siguiente — y nadie sabe de dónde salió.
//   2. CERRAR LO QUE NO SE MIRÓ. El cierre se lleva TODO lo que el pallet
//      tiene adentro, no sólo las cajas que se acaban de tipear. Si el cartel
//      muestra las 40 y el tarjetón sale con 60, el que firma firmó otra cosa.
//   3. DECIR «CERRADO» SIN HABER CERRADO. Son dos escrituras: si la segunda no
//      pasa y se contesta ok igual, el operador se va convencido y la caja
//      siguiente le cae adentro del pallet que creía etiquetado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  guardarPresentacion, guardarDatosDeLote, registrarProceso,
  palletAbierto, contenidoDelPallet,
} from '../src/servicios/galpon.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

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
  guardarDatosDeLote(db, { lote_id: 10, renspa: '12.345.6.78901/00',
    variedad: 'Bulida', cuartel: 'C-07' });
  return db;
}

// Una caja de 10 cubetas de 500 g: 5 kg por bulto, que hace las cuentas legibles.
const art = (db, nombre, calibre) => guardarPresentacion(db, {
  nombre, destino: 'comercial', envase: 'Caja 5 kg', por_bulto: 10, kg_unidad: 0.5,
  calibre, categoria: 'I' }).id;

const abiertos = (db) => db.prepare(
  "SELECT COUNT(*) AS n FROM gal_pallets WHERE estado = 'abierto'"
  + ' AND eliminado_en IS NULL').get().n;

// ══════════════════════════════════════════════════════════════════════════
// 1 · LAS DOS COSAS, EN UNA
// ══════════════════════════════════════════════════════════════════════════
test('CARGAR Y CERRAR: una sola llamada deja el pallet cerrado y con número', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 60, uuid: '1', cerrar_pallet: 1 });

  assert.equal(r.ok, true);
  assert.ok(r.pallet_cerrado, 'no contestó con el pallet que cerró');
  assert.equal(r.pallet_cerrado.numero, 'PC-26-00001');
  assert.equal(r.pallet_cerrado.estado, 'cerrado');
  assert.equal(r.pallet_cerrado.bultos, 60);
  assert.equal(r.pallet_cerrado.kilos, 300);
  assert.equal(r.pallet_cerrado.articulos, 1);
  assert.equal(abiertos(db), 0, 'quedó un pallet abierto después de cerrar');
});

test('la CARGA queda: cerrar no la reemplaza, la envuelve', () => {
  // El pallet no es un movimiento, es dónde está la caja. Las 60 tienen que
  // seguir existiendo —y contadas una sola vez— después del cierre.
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 60, uuid: '1', cerrar_pallet: 1 });
  const c = contenidoDelPallet(db, r.pallet_cerrado.id);
  assert.equal(c.length, 1);
  assert.equal(c[0].bultos, 60);
  assert.equal(c[0].kilos, 300);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gal_procesos').get().n, 1);
});

test('SIN cerrar_pallet no cierra nada: el botón de siempre sigue siendo el de siempre', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 60, uuid: '1' });
  assert.equal(r.ok, true);
  assert.equal(r.pallet_cerrado, null);
  assert.equal(r.cierre_motivo, null);
  assert.ok(palletAbierto(db), 'cerró un pallet que nadie pidió cerrar');
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · SE CIERRA EL PALLET ENTERO, NO ESTA CARGA
// ══════════════════════════════════════════════════════════════════════════
test('EL CIERRE SE LLEVA TODO LO QUE EL PALLET TIENE ADENTRO', () => {
  /* Veinte cajas de un calibre cargadas antes, cuarenta de otro que cierran:
     el tarjetón sale con SESENTA y marcado MIXTO. Cerrar contando sólo las
     cuarenta que se acaban de tipear sería una etiqueta que miente sobre el
     pallet que tiene debajo. */
  const db = base();
  const a = art(db, 'Caja chica', '50/55');
  const b = art(db, 'Caja grande', '60/65');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 20, uuid: '1' });
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: b,
    bultos: 40, uuid: '2', cerrar_pallet: 1 });

  assert.equal(r.pallet_cerrado.bultos, 60);
  assert.equal(r.pallet_cerrado.kilos, 300);
  assert.equal(r.pallet_cerrado.articulos, 2);
  const p = db.prepare('SELECT * FROM gal_pallets WHERE id = ?')
              .get(r.pallet_cerrado.id);
  assert.equal(p.mixto, 1, 'MIXTO lo decide el contenido, y hay dos artículos');
  assert.equal(p.bultos, 60, 'el total congelado en el pallet no es el del tarjetón');
});

test('la carga SIGUIENTE no cae en el pallet cerrado: abre uno nuevo', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r1 = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 60, uuid: '1', cerrar_pallet: 1 });
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 10, uuid: '2' });

  const p2 = palletAbierto(db);
  assert.ok(p2, 'la carga siguiente no abrió ningún pallet');
  assert.notEqual(p2.id, r1.pallet_cerrado.id, 'le metió cajas a un pallet cerrado');
  assert.equal(contenidoDelPallet(db, r1.pallet_cerrado.id)[0].bultos, 60,
    'el pallet cerrado cambió después de cerrado');
});

test('el correlativo no se saltea: dos cierres son 00001 y 00002', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r1 = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 60, uuid: '1', cerrar_pallet: 1 });
  const r2 = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 30, uuid: '2', cerrar_pallet: 1 });
  assert.equal(r1.pallet_cerrado.numero, 'PC-26-00001');
  assert.equal(r2.pallet_cerrado.numero, 'PC-26-00002');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL DOBLE CLIC
// ══════════════════════════════════════════════════════════════════════════
test('EL DOBLE CLIC NO ABRE UN PALLET FANTASMA', () => {
  /* Esto es lo que se rompía al juntar las dos cosas, y de la peor manera:
     callado. El segundo clic llega con el pallet ya cerrado; si abrirPallet()
     corre antes del guard del uuid, abre uno NUEVO —vacío, sin número— para
     una carga que no va a insertar. Ese pallet queda abierto en el playón y se
     lleva la primera caja de la mañana siguiente. */
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r1 = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 60, uuid: 'mismo', cerrar_pallet: 1 });
  const r2 = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 60, uuid: 'mismo', cerrar_pallet: 1 });

  assert.equal(r2.repetido, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gal_procesos').get().n, 1,
    'el doble clic duplicó la carga');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gal_pallets').get().n, 1,
    'el doble clic dejó un pallet de más');
  assert.equal(abiertos(db), 0, 'quedó un pallet fantasma abierto');
  // Y contesta con el MISMO pallet, para que la pantalla vuelva a ofrecer el
  // tarjetón en vez de dejar al que apretó sin número y sin saber si cerró.
  assert.ok(r2.pallet_cerrado, 'el segundo clic no dijo qué pallet se había cerrado');
  assert.equal(r2.pallet_cerrado.numero, r1.pallet_cerrado.numero);
});

test('el doble clic SIN cerrar sigue andando igual que siempre', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 60, uuid: 'mismo' });
  const r2 = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 60, uuid: 'mismo' });
  assert.equal(r2.repetido, true);
  assert.equal(r2.pallet_cerrado, null, 'cerró sin que nadie se lo pidiera');
  assert.equal(abiertos(db), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gal_pallets').get().n, 1);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · PARCIAL, Y LO QUE NO SE PUEDE CERRAR
// ══════════════════════════════════════════════════════════════════════════
test('PARCIAL viaja y queda guardado: va impreso en el tarjetón', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 25, uuid: '1', cerrar_pallet: 1, parcial: 1 });
  assert.equal(r.pallet_cerrado.parcial, 1);
  assert.equal(db.prepare('SELECT parcial FROM gal_pallets WHERE id = ?')
    .get(r.pallet_cerrado.id).parcial, 1);
});

test('sin parcial, va completo', () => {
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 25, uuid: '1', cerrar_pallet: 1 });
  assert.equal(r.pallet_cerrado.parcial, 0);
  assert.equal(db.prepare('SELECT parcial FROM gal_pallets WHERE id = ?')
    .get(r.pallet_cerrado.id).parcial, 0);
});

test('SIN PALLET NO HAY NADA QUE CERRAR, y la carga entra igual', () => {
  /* La fruta ya está en la tolva (CLAUDE.md): si el cierre no se puede hacer,
     lo que NO se hace es rechazar la carga. Se guarda, se contesta ok y se
     dice qué pasó con el pallet. */
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 60, uuid: '1', sin_pallet: 1, cerrar_pallet: 1 });

  assert.equal(r.ok, true, 'rechazó una carga que ya pasó');
  assert.equal(r.pallet_cerrado, null, 'dijo que cerró un pallet que no existe');
  assert.match(r.cierre_motivo, /no fue a ningún pallet/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gal_procesos').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gal_pallets').get().n, 0);
});

test('una MEZCLA de lotes también se cierra entera, y es UN solo pallet', () => {
  /* Las n filas del reparto van todas al mismo pallet: son una sola carga
     física. Cerrar una mezcla no puede dejar la mitad afuera. */
  const db = base();
  const a = art(db, 'Caja', '50/55');
  db.prepare('INSERT INTO gal_volcados (fecha,lote_id,kilos) VALUES (?,?,?)')
    .run(F, 10, 3000);
  db.prepare('INSERT INTO gal_volcados (fecha,lote_id,kilos) VALUES (?,?,?)')
    .run(F, 11, 1000);
  const r = registrarProceso(db, { fecha: F, lote_ids: [10, 11], presentacion_id: a,
    bultos: 40, uuid: 'mz', cerrar_pallet: 1 });

  assert.equal(r.ids.length, 2, 'la mezcla no guardó una fila por lote');
  assert.equal(r.pallet_cerrado.bultos, 40);
  assert.equal(r.pallet_cerrado.kilos, 200);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT pallet_id) AS n FROM gal_procesos')
    .get().n, 1, 'la mezcla se repartió entre dos pallets');
  assert.equal(abiertos(db), 0);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LA PANTALLA, EJECUTADA
// ══════════════════════════════════════════════════════════════════════════
// Lo que puede estar mal acá se ve idéntico en pantalla: que el botón normal
// mande cerrar_pallet sin que nadie se lo pida, que el cartel muestre sólo las
// cajas de esta carga, que el total que se lee no sea el que se va a imprimir.
function elemento(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '', disabled: false,
    style: { display: '' }, offsetWidth: 0,
    classList: { add() {}, remove() {}, contains: () => false },
    focus() { el.focos = (el.focos || 0) + 1; },
    select() {},
  };
  return el;
}

function domFalso() {
  const nodos = {};
  return { nodos,
    document: { getElementById: (id) => (nodos[id] || (nodos[id] = elemento(id))) } };
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
    // El escape, el formato y el destino, de verdad.
    corte('function galPrEsc(s){', 'async function galPrInit(){')
    // La baldosa, el cartel del cierre y la carga.
    + corte('function galPrBaldosa(p, d){', '/* ── ✎ CORREGIR UNA CARGA DE PROCESO')
    // El acuse y la tarjeta del pallet abierto.
    + corte('function galPrAcuseCierre(){', 'async function galPlBorrar(id){');

  const f = new Function('document', 'fetch', 'window', 'alert', 'confirm', 'GPR',
    'galPrPintarZonas', 'galKgNuevoUuid', 'galPrCargar', 'galDibHtml',
    codigo
    + '\nreturn { galPrBaldosa, galPrElegir, galPrPresSel, galPrPedirCierre,'
    + ' galPrCierreNo, galPrCargarUno, galPrAcuseCierre, galPrAcuseNo,'
    + ' galPrPintarPallet, galPlCerrar };');

  dom.pedidos = [];
  dom.abiertas = [];
  dom.avisos = [];
  const GPR = Object.assign({
    fecha: '2026-12-15', hoy: '2026-12-15', lotes: [10], sel: null, uuid: 'u1',
    editId: null, cerrado: null,
    datos: { presentaciones: [], destinos: [], pallet_abierto: null, procesos: [] },
  }, o.GPR || {});

  const api = f(
    dom.document,
    o.fetch || ((url, init) => {
      dom.pedidos.push({ url, body: JSON.parse(init.body || '{}') });
      return Promise.resolve({ json: () => Promise.resolve(o.respuesta || { ok: true }) });
    }),
    { open: (u) => dom.abiertas.push(u) },
    (m) => dom.avisos.push(m),
    () => (o.confirma !== false),
    GPR,
    () => {}, () => 'u-nuevo', () => Promise.resolve(), () => '',
  );
  api.GPR = GPR;
  return api;
}

// Una presentación con cuenta: 10 cubetas de 500 g = 5 kg por bulto.
const PRES = { id: 7, nombre: 'Caja', destino: 'comercial', envase: 'Caja 5 kg',
               por_bulto: 10, kg_unidad: 0.5, granel: 0, categoria: 'I',
               calibre: '50/55' };

function conBaldosa(opts) {
  const o = opts || {};
  const dom = domFalso();
  const api = pantalla(dom, Object.assign({}, o, { GPR: Object.assign({
    sel: 7,
    datos: { presentaciones: [PRES], destinos: [], procesos: [],
             pallet_abierto: o.pallet || null },
  }, o.GPR || {}) }));
  return { dom, api };
}

test('LA BALDOSA TIENE LOS DOS BOTONES, y el de siempre sigue siendo el de siempre', () => {
  const { api } = conBaldosa();
  const h = api.galPrBaldosa(PRES, { clave: 'comercial', color: '#16a34a', label: 'C' });
  assert.match(h, /id="gpr-btn"[^>]*onclick="galPrCargarUno\(\)"/,
    'el botón Cargar dejó de ser el de siempre');
  assert.match(h, /id="gpr-btn-cerrar"[^>]*onclick="galPrPedirCierre\(\)"/,
    'no está el botón de cargar y cerrar');
  // Y el cartel se dibuja ESCONDIDO: mostrarlo repintando la zona le borraría al
  // operador los bultos que acaba de tipear.
  assert.match(h, /id="gpr-cierre"[^>]*style="display:none"/);
});

test('CON EL CASILLERO VACÍO NO CIERRA: manda a la tarjeta del pallet', () => {
  /* Cerrar un pallet sin cargarle nada es otra cosa y ya tiene su botón arriba.
     Acá lo que falta no es confirmar, es el número. */
  const { dom, api } = conBaldosa();
  dom.document.getElementById('gpr-cant').value = '';
  api.galPrPedirCierre();
  assert.equal(dom.document.getElementById('gpr-cierre').style.display, 'none',
    'ofreció cerrar un pallet sin saber cuántas cajas van');
  const err = dom.document.getElementById('gpr-error');
  assert.equal(err.style.display, '');
  assert.match(err.textContent, /bultos/);
  assert.match(err.textContent, /tarjeta del pallet/);
});

test('EL CARTEL MUESTRA EL TOTAL QUE SE VA A IMPRIMIR, no sólo esta carga', () => {
  /* Veinte cajas ya adentro y cuarenta que se cargan: el tarjetón sale con 60.
     Un cartel que dijera 40 haría firmar otra cosa que la que se imprime. */
  const { dom, api } = conBaldosa({
    pallet: { id: 3, contenido: [{ bultos: 20, kilos: 100 }] } });
  dom.document.getElementById('gpr-cant').value = '40';
  api.galPrPedirCierre();
  const box = dom.document.getElementById('gpr-cierre');
  assert.equal(box.style.display, '');
  assert.match(box.innerHTML, /<b>60 bultos<\/b>/, 'el cartel no suma lo que ya estaba');
  assert.match(box.innerHTML, /<b>300 kg<\/b>/);
  assert.match(box.innerHTML, /1 artículo/);
  assert.match(box.innerHTML, /galPrCargarUno\(1, 0\)/);
  assert.match(box.innerHTML, /galPrCargarUno\(1, 1\)/);
});

test('con el pallet vacío el cartel lo dice: sólo esta carga', () => {
  const { dom, api } = conBaldosa();
  dom.document.getElementById('gpr-cant').value = '40';
  api.galPrPedirCierre();
  const box = dom.document.getElementById('gpr-cierre');
  assert.match(box.innerHTML, /<b>40 bultos<\/b>/);
  assert.match(box.innerHTML, /sólo esta carga/);
});

test('PARCIAL ES UN BOTÓN, no un segundo cartel de sí/no', () => {
  /* «Cancelar = no, va completo» se contesta al revés la mitad de las veces, y
     lo que sale mal sale impreso. Acá se elige apretando lo que dice. */
  const { dom, api } = conBaldosa();
  dom.document.getElementById('gpr-cant').value = '40';
  api.galPrPedirCierre();
  const box = dom.document.getElementById('gpr-cierre');
  assert.match(box.innerHTML, />Cargar y cerrar</);
  assert.match(box.innerHTML, />Cerrar y va PARCIAL</);
  assert.match(box.innerHTML, />cancelar</);
});

test('cancelar esconde el cartel y no manda nada', async () => {
  const { dom, api } = conBaldosa();
  dom.document.getElementById('gpr-cant').value = '40';
  api.galPrPedirCierre();
  api.galPrCierreNo();
  assert.equal(dom.document.getElementById('gpr-cierre').style.display, 'none');
  assert.equal(dom.pedidos.length, 0);
});

test('CARGAR Y CERRAR VA EN UN SOLO PEDIDO', async () => {
  /* Dos fetch seguidos son el error que esto viene a evitar: si el segundo no
     llega, el operador se va convencido de que cerró. */
  const { dom, api } = conBaldosa({
    respuesta: { ok: true, pallet_cerrado: { id: 3, numero: 'PC-26-00009',
      bultos: 40, kilos: 200, articulos: 1, parcial: 0 } } });
  dom.document.getElementById('gpr-cant').value = '40';
  await api.galPrCargarUno(1, 0);

  assert.equal(dom.pedidos.length, 1, 'mandó más de un pedido para cerrar');
  assert.equal(dom.pedidos[0].url, '/api/galpon/procesos');
  assert.equal(dom.pedidos[0].body.cerrar_pallet, 1);
  assert.equal(dom.pedidos[0].body.parcial, 0);
  assert.equal(dom.pedidos[0].body.bultos, '40');
  // Y el tarjetón sale enseguida: un pallet cerrado sin etiqueta no se
  // identifica en el playón.
  assert.deepEqual(dom.abiertas, ['/api/galpon/pallets/3/tarjeton.pdf']);
});

test('«va PARCIAL» manda parcial en el mismo pedido', async () => {
  const { dom, api } = conBaldosa({ respuesta: { ok: true } });
  dom.document.getElementById('gpr-cant').value = '40';
  await api.galPrCargarUno(1, 1);
  assert.equal(dom.pedidos[0].body.cerrar_pallet, 1);
  assert.equal(dom.pedidos[0].body.parcial, 1);
});

test('EL BOTÓN DE SIEMPRE NO CIERRA NADA', async () => {
  const { dom, api } = conBaldosa({ respuesta: { ok: true } });
  dom.document.getElementById('gpr-cant').value = '40';
  await api.galPrCargarUno();
  assert.equal(dom.pedidos[0].body.cerrar_pallet, undefined,
    'el botón Cargar empezó a cerrar el pallet');
  assert.equal(dom.pedidos[0].body.parcial, undefined);
  assert.deepEqual(dom.abiertas, [], 'abrió un tarjetón sin cerrar nada');
});

test('SI LA CARGA ENTRÓ PERO EL PALLET NO SE CERRÓ, SE DICE', async () => {
  /* Lo contrario es lo peligroso: contestar ok y dejar que el operador crea que
     cerró. La caja siguiente le cae adentro del pallet que creía etiquetado. */
  const { dom, api } = conBaldosa({
    respuesta: { ok: true, pallet_cerrado: null,
      cierre_motivo: 'La carga no fue a ningún pallet, así que no hay nada que cerrar.' } });
  dom.document.getElementById('gpr-cant').value = '40';
  await api.galPrCargarUno(1, 0);
  assert.equal(dom.avisos.length, 1, 'no avisó que el pallet no se cerró');
  assert.match(dom.avisos[0], /SE GUARDÓ/);
  assert.match(dom.avisos[0], /no hay nada que cerrar/);
  assert.deepEqual(dom.abiertas, [], 'abrió el tarjetón de un pallet que no cerró');
});

// ── EL ACUSE ──────────────────────────────────────────────────────────────
test('EL NÚMERO QUEDA EN PANTALLA, no sólo en la pestaña nueva', async () => {
  /* window.open() después de un await es justo lo que los navegadores bloquean.
     Si el popup no sale, el operador cerró un pallet y no sabe con qué número —
     y el número es lo único que lo identifica en el playón y en un remito. */
  const { dom, api } = conBaldosa({
    respuesta: { ok: true, pallet_cerrado: { id: 3, numero: 'PC-26-00009',
      bultos: 40, kilos: 200, articulos: 2, parcial: 1 } } });
  dom.document.getElementById('gpr-cant').value = '40';
  await api.galPrCargarUno(1, 1);

  api.galPrPintarPallet();
  const h = dom.document.getElementById('gpr-pallet').innerHTML;
  assert.match(h, /PC-26-00009/, 'el número no quedó a la vista');
  assert.match(h, /40 bultos · 200 kg/);
  assert.match(h, /2 artículos/);
  assert.match(h, /PARCIAL/);
  assert.match(h, /href="\/api\/galpon\/pallets\/3\/tarjeton\.pdf"/,
    'el acuse no deja volver a imprimir');
});

test('el acuse convive con el pallet siguiente ya abierto', () => {
  // Al día siguiente el acuse sigue arriba y abajo está la tarjeta del pallet
  // nuevo: son dos cosas distintas y las dos tienen que verse.
  const dom = domFalso();
  const api = pantalla(dom, { GPR: {
    cerrado: { id: 3, numero: 'PC-26-00009', bultos: 40, kilos: 200, articulos: 1 },
    datos: { presentaciones: [], destinos: [], procesos: [],
             pallet_abierto: { id: 4, contenido: [
               { producto: 'Damasco', bultos: 10, kilos: 50, categoria: 'I' }] } },
  } });
  api.galPrPintarPallet();
  const h = dom.document.getElementById('gpr-pallet').innerHTML;
  assert.match(h, /PC-26-00009/);
  assert.match(h, /Pallet abierto/);
  assert.ok(h.indexOf('PC-26-00009') < h.indexOf('Pallet abierto'),
    'el acuse tiene que ir arriba del pallet que se está armando');
});

test('la × saca el acuse', () => {
  const dom = domFalso();
  const api = pantalla(dom, { GPR: {
    cerrado: { id: 3, numero: 'PC-26-00009', bultos: 40, kilos: 200 },
    datos: { presentaciones: [], destinos: [], procesos: [], pallet_abierto: null },
  } });
  api.galPrAcuseNo();
  assert.equal(api.GPR.cerrado, null);
  assert.equal(dom.document.getElementById('gpr-pallet').innerHTML, '');
});

test('el botón de la TARJETA del pallet deja el mismo acuse', async () => {
  /* Dos maneras de cerrar y una sola que avisa es la que no avisa la que se usa. */
  const dom = domFalso();
  const api = pantalla(dom, {
    GPR: { datos: { presentaciones: [], destinos: [], procesos: [],
                    pallet_abierto: { id: 5, contenido: [{ bultos: 12, kilos: 60 }] } } },
    respuesta: { ok: true, numero: 'PC-26-00012',
      pallet: { bultos: 12, kilos: 60 }, contenido: [{ bultos: 12 }] },
  });
  await api.galPlCerrar(5);
  assert.equal(api.GPR.cerrado.numero, 'PC-26-00012');
  assert.equal(api.GPR.cerrado.bultos, 12);
  assert.equal(api.GPR.cerrado.articulos, 1);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · EL MANUAL, CONTRA EL CÓDIGO
// ══════════════════════════════════════════════════════════════════════════
// CLAUDE.md: el manual se prueba contra el código, no contra sí mismo. Cada
// afirmación de abajo tiene su assert al lado.
const MANUAL = (() => {
  const i = PANEL.indexOf("SG_MANUAL['galpon-proceso']");
  assert.ok(i > 0, 'Galpón · Proceso no tiene «¿Cómo se usa?»');
  return PANEL.slice(i, PANEL.indexOf('\n};', i)).replace(/'\s*\r?\n\s*\+\s*'/g, '');
})();
const dice = (re, nota) => assert.ok(re.test(MANUAL),
  'EL MANUAL NO DICE: ' + re.source + (nota ? '\n  (' + nota + ')' : ''));

test('EL MANUAL CUENTA LO NUEVO, con su número de versión', () => {
  dice(/Cargar y cerrar el pallet de una <span class="ver">V1140<\/span>/);
  dice(/Hacerlo juntos/, 'tiene que estar lo que se pidió, con esas palabras');
});

test('el manual dice que hay un botón al lado de Cargar — y lo hay', () => {
  dice(/Cargar y cerrar pallet/);
  assert.ok(PANEL.includes(`id="gpr-btn-cerrar"`),
    'el manual anuncia un botón que no existe');
});

test('el manual dice que muestra el total que va a quedar impreso — y lo muestra', () => {
  dice(/el total que va a quedar impreso/);
  const js = corte('function galPrPedirCierre(){', 'function galPrCierreNo(){');
  assert.match(js, /pallet_abierto/,
    'el cartel no mira lo que el pallet ya tiene: estaría mostrando sólo esta carga');
  assert.match(js, /hb \+ mb/);
});

test('el manual dice que con el casillero vacío no cierra — y no cierra', () => {
  dice(/Con el casillero <b>vacío<\/b> no cierra/);
  const js = corte('function galPrPedirCierre(){', 'function galPrCierreNo(){');
  assert.match(js, /if \(v <= 0\)/);
});

test('el manual dice UN SOLO PEDIDO — y el servicio lo hace adentro', () => {
  dice(/en un solo pedido al servidor/);
  const SERV = fs.readFileSync(path.join(RAIZ, 'src/servicios/galpon.js'), 'utf8');
  assert.match(SERV, /if \(dd\.cerrar_pallet\) \{/,
    'el cierre no vive en registrarProceso: son dos viajes otra vez');
  const js = corte('async function galPrCargarUno(cerrar, parcial){',
    '/* ── ✎ CORREGIR UNA CARGA DE PROCESO');
  assert.equal((js.match(/await fetch\(/g) || []).length, 1,
    'la pantalla hace más de un pedido para cargar y cerrar');
});

test('el manual dice que si el cierre falla la carga queda — y queda', () => {
  dice(/la carga queda igual/);
  const db = base();
  const a = art(db, 'Caja', '50/55');
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: a,
    bultos: 60, uuid: '1', sin_pallet: 1, cerrar_pallet: 1 });
  assert.equal(r.ok, true);
  assert.ok(r.cierre_motivo);
});

test('el manual dice que queda un cartel verde con el número — y queda', () => {
  dice(/cartel verde con el número/);
  assert.ok(PANEL.includes('function galPrAcuseCierre(){'),
    'el manual promete un acuse que nadie dibuja');
  assert.match(PANEL, /#sec-galpon-proceso \.gpr-ack\{/,
    'el acuse no tiene estilo: sin regla CSS no se ve de ningún color');
});
