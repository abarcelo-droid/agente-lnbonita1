// ══ ⚖️ GALPÓN · CARGA DE KILOS — el router, levantado de verdad ══════════
//
// La lógica se prueba al lado, en test/galpon_carga.test.mjs. Acá se monta
// `rutas/galpon.js` en un Express real y se le pega con `fetch`, porque lo que
// importa en este archivo no se ve leyendo el código:
//
//   · que el cerrojo de empresa esté también en las rutas nuevas, y no sólo en
//     las que ya estaban
//   · que cargar kilos NO pida admin — es el trabajo del día, no parametrizar
//   · que la firma de quién cargó salga de la COOKIE y no del cuerpo del pedido
//   · que el lote del día se PROPONGA sin que la carga dependa de él
//
// -- SIN node_modules ESTE ARCHIVO SE SALTEA ENTERO, NO SE CAE -------------
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sociedades (id INTEGER PRIMARY KEY, nombre TEXT);
    INSERT INTO sociedades (id,nombre) VALUES (7,'Puente Cordón SA'), (9,'San Gerónimo SA');

    CREATE TABLE pa_sectores (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT);
    INSERT INTO pa_sectores (id,nombre,tipo) VALUES (1,'Frutales','frutales');

    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, sector_id INTEGER,
                           finca TEXT, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,sector_id,finca,activo) VALUES
      (10,'Cuadro 3',1,'La Esperanza',1),
      (11,'Cuadro 4',1,'La Esperanza',1);

    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY, lote_id INTEGER, cultivo TEXT,
                                   campaña TEXT, es_perenne INTEGER DEFAULT 0);
    INSERT INTO pa_cultivos_lote (lote_id,cultivo,campaña,es_perenne) VALUES
      (10,'Damasco','2026/27',1);

    CREATE TABLE pa_cuadrillas (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT,
                                activo INTEGER DEFAULT 1);
    INSERT INTO pa_cuadrillas (id,nombre,tipo,activo) VALUES
      (1,'Norte','fija',1), (2,'Sur','pool',1);

    CREATE TABLE gal_cuadrilla_tarjetas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, cuadrilla_id INTEGER NOT NULL,
      desde_id INTEGER NOT NULL, hasta_id INTEGER NOT NULL,
      color TEXT NOT NULL DEFAULT '#1a3a5c', activo INTEGER NOT NULL DEFAULT 1,
      notas TEXT, creado_en TEXT);

    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
    INSERT INTO gal_config (clave,valor) VALUES ('kg_max_carga','20000');

    CREATE TABLE gal_lote_vigente (
      id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL,
      desde_hora TEXT NOT NULL DEFAULT '00:00', lote_id INTEGER NOT NULL,
      lote_nombre TEXT, producto TEXT, usuario_id INTEGER, usuario TEXT,
      creado_en TEXT DEFAULT (datetime('now','localtime')));

    CREATE TABLE gal_volcados (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE,
      fecha TEXT NOT NULL, hora TEXT,
      lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT,
      cuadrilla_id INTEGER, cuadrilla TEXT,
      kilos REAL NOT NULL, ifcos INTEGER, bruto REAL, tara REAL, tarjeta_id INTEGER,
      origen TEXT NOT NULL DEFAULT 'manual',
      observacion TEXT, estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT,
      usuario_id INTEGER, usuario TEXT,
      creado_en TEXT DEFAULT (datetime('now','localtime')), eliminado_en TEXT);

    CREATE TABLE gal_lote_datos (lote_id INTEGER PRIMARY KEY, renspa TEXT, variedad TEXT,
      cuartel TEXT, notas TEXT, actualizado TEXT);
    CREATE TABLE gal_presentaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, destino TEXT NOT NULL,
      envase TEXT, por_bulto REAL NOT NULL DEFAULT 1, kg_unidad REAL NOT NULL DEFAULT 1,
      granel INTEGER NOT NULL DEFAULT 0, emoji TEXT, icono TEXT, icono_v TEXT, categoria TEXT NOT NULL DEFAULT 'I', calibre TEXT, color TEXT, orden INTEGER NOT NULL DEFAULT 100,
      activo INTEGER NOT NULL DEFAULT 1, creado_en TEXT, eliminado_en TEXT);

    CREATE TABLE gal_pallets (id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT UNIQUE,
      estado TEXT NOT NULL DEFAULT 'abierto', parcial INTEGER NOT NULL DEFAULT 0,
      mixto INTEGER NOT NULL DEFAULT 0, fecha_empaque TEXT, bultos REAL, kilos REAL,
      observacion TEXT, abierto_en TEXT, cerrado_en TEXT, usuario_id INTEGER,
      usuario TEXT, eliminado_en TEXT);
    CREATE TABLE gal_procesos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, fecha TEXT NOT NULL,
      lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT, destino TEXT NOT NULL,
      presentacion_id INTEGER, presentacion TEXT, envase TEXT, categoria TEXT, calibre TEXT, variedad TEXT, renspa TEXT, cuartel TEXT,
      bultos REAL, por_bulto REAL, kg_unidad REAL, kilos REAL NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'ingreso', reparto TEXT, repartido INTEGER NOT NULL DEFAULT 0, pallet_id INTEGER, partido_de INTEGER, observacion TEXT,
      estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT,
      usuario_id INTEGER, usuario TEXT, creado_en TEXT, eliminado_en TEXT);
  `);
  return db;
}

let express = null;
let falta = false;
try {
  express = (await import('express')).default;
  await import('jspdf');
  await import('qrcode');
} catch { falta = 'falta el paquete express (o jspdf/qrcode): corre npm install para que estos tests corran'; }

const t = (nombre, fn) => test(nombre, { skip: falta }, fn);

async function servidor(db, usuario) {
  const dir = fs.mkdtempSync(path.join(RAIZ, '.tmp-galkg-'));
  fs.mkdirSync(path.join(dir, 'servicios'));
  fs.mkdirSync(path.join(dir, 'rutas'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/servicios'))) {
    if (f.endsWith('.js')) {
      fs.copyFileSync(path.join(RAIZ, 'src/servicios', f), path.join(dir, 'servicios', f));
    }
  }
  fs.copyFileSync(path.join(RAIZ, 'src/rutas/galpon.js'), path.join(dir, 'rutas', 'galpon.js'));
  fs.writeFileSync(path.join(dir, 'servicios', 'db.js'),
    'export default globalThis.__GAL_DB; export const getDb = () => globalThis.__GAL_DB;\n'
    + 'export function rehacerTabla(){}\n', 'utf8');
  globalThis.__GAL_DB = db;

  const mod = await import('file:///' + path.join(dir, 'rutas', 'galpon.js').replace(/\\/g, '/'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.cookies = usuario ? { lnb_user: JSON.stringify(usuario) } : {}; next();
  });
  app.use('/api/galpon', mod.default);
  const srv = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const url = 'http://127.0.0.1:' + srv.address().port;
  return {
    pegar: (ruta, opts) => fetch(url + '/api/galpon' + ruta, opts),
    cerrar: () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const ADMIN    = { id: 1, nombre: 'Andy', rol: 'admin' };
const OPERADOR = { id: 2, nombre: 'Juan', rol: 'operador' };
const json   = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
                         body: JSON.stringify(b) });
const patch  = (b) => Object.assign(json(b), { method: 'PATCH' });
const HOY = new Date().toLocaleDateString('en-CA');

// ══════════════════════════════════════════════════════════════════════════
// 1 · QUIÉN PUEDE
// ══════════════════════════════════════════════════════════════════════════
t('sin sesión no se lee ni se carga nada', async () => {
  const s = await servidor(base(), null);
  try {
    assert.equal((await s.pegar('/volcados')).status, 401);
    assert.equal((await s.pegar('/volcados', json({ fecha: HOY, lote_id: 10, kilos: 100 }))).status, 401);
    assert.equal((await s.pegar('/volcados/1', patch({ kilos: 1 }))).status, 401);
    assert.equal((await s.pegar('/volcados/1', { method: 'DELETE' })).status, 401);
  } finally { s.cerrar(); }
});

t('UN OPERADOR CARGA KILOS: esto no es parametrizar', async () => {
  // Pedir admin acá terminaría con el dueño tipeando los renglones que cuenta
  // otro, que es exactamente lo que CLAUDE.md llama «operar no es ser admin».
  const s = await servidor(base(), OPERADOR);
  try {
    const r = await s.pegar('/volcados', json({ fecha: HOY, lote_id: 10, kilos: 450 }));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.fila.kilos, 450);

    // Y también corrige y borra lo suyo.
    assert.equal((await s.pegar('/volcados/' + j.id, patch({ kilos: 500 }))).status, 200);
    assert.equal((await s.pegar('/volcados/' + j.id, { method: 'DELETE' })).status, 200);
  } finally { s.cerrar(); }
});

t('EL CERROJO DE EMPRESA TAMBIÉN TAPA LAS RUTAS NUEVAS', async () => {
  // El galpón es de Puente Cordón (id 7). La empresa viaja en ?sociedad_id= y
  // en el cuerpo, NO en la cookie del usuario — por eso se prueba así.
  const s = await servidor(base(), ADMIN);
  try {
    for (const [ruta, opts] of [
      ['/volcados?sociedad_id=9', undefined],
      ['/volcados?sociedad_id=9', json({ fecha: HOY, lote_id: 10, kilos: 100 })],
      ['/volcados/1?sociedad_id=9', patch({ kilos: 1 })],
      ['/volcados/1?sociedad_id=9', { method: 'DELETE' }],
    ]) {
      const r = await s.pegar(ruta, opts);
      assert.equal(r.status, 403, 'pasó parado en San Gerónimo: ' + ruta);
      assert.match((await r.json()).error, /Puente Cord/);
    }
    // Y parado donde corresponde, o sin decir nada, entra.
    assert.equal((await s.pegar('/volcados?sociedad_id=7')).status, 200);
    assert.equal((await s.pegar('/volcados')).status, 200);
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LA FIRMA
// ══════════════════════════════════════════════════════════════════════════
t('QUIÉN CARGÓ SALE DE LA COOKIE, no del cuerpo del pedido', async () => {
  // Es la firma de quién contó esos kilos. Una firma que manda el cliente no
  // firma nada: alcanzaría con editar el JSON para cargar a nombre de otro.
  const s = await servidor(base(), OPERADOR);
  try {
    const j = await (await s.pegar('/volcados', json({
      fecha: HOY, lote_id: 10, kilos: 450,
      usuario: 'El Gerente', usuario_id: 999,
    }))).json();
    assert.equal(j.fila.usuario, 'Juan');
    assert.equal(j.fila.usuario_id, 2);
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL DÍA
// ══════════════════════════════════════════════════════════════════════════
t('el día trae las cargas y el resumen en un solo pedido', async () => {
  // Partirlo en dos deja la mitad de arriba contradiciendo a la de abajo
  // mientras llega la segunda respuesta.
  const s = await servidor(base(), OPERADOR);
  try {
    await s.pegar('/volcados', json({ fecha: HOY, lote_id: 10, cuadrilla_id: 1, kilos: 300 }));
    await s.pegar('/volcados', json({ fecha: HOY, lote_id: 11, cuadrilla_id: 2, kilos: 450 }));

    const d = await (await s.pegar('/volcados?fecha=' + HOY)).json();
    assert.equal(d.ok, true);
    assert.equal(d.fecha, HOY);
    assert.equal(d.cargas.length, 2);
    assert.equal(d.resumen.kilos, 750);
    assert.equal(d.resumen.por_cuadrilla.length, 2);
    assert.equal(d.resumen.por_lote.length, 2);
    // La última cargada arriba: es la que se acaba de tipear y la que se mira.
    assert.equal(d.cargas[0].kilos, 450);
  } finally { s.cerrar(); }
});

t('sin fecha contesta por HOY', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    const d = await (await s.pegar('/volcados')).json();
    assert.equal(d.fecha, HOY);
    assert.equal(d.hoy, HOY);
  } finally { s.cerrar(); }
});

t('EL LOTE DEL DÍA SE PROPONE, Y LA CARGA NO DEPENDE DE ÉL', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    // Sin nada declarado no hay propuesta... y se carga igual. La pantalla de
    // kilos no puede quedarse esperando a que alguien declare el lote del día.
    let d = await (await s.pegar('/volcados?fecha=' + HOY)).json();
    assert.equal(d.propuesta, null);
    assert.equal((await s.pegar('/volcados',
      json({ fecha: HOY, lote_id: 11, kilos: 100 }))).status, 200);

    // Con el lote declarado, se propone ése.
    await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10, producto: 'Damasco' }));
    d = await (await s.pegar('/volcados?fecha=' + HOY)).json();
    assert.equal(d.propuesta.lote_id, 10);
    assert.equal(d.propuesta.lote_nombre, 'Cuadro 3');
    assert.equal(d.propuesta.producto, 'Damasco');
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LO QUE NO ENTRA
// ══════════════════════════════════════════════════════════════════════════
t('lo que falta se contesta con 400 y con el motivo, no con un 500', async () => {
  // El que lo lee es el operador parado frente al formulario. Un 500 lo manda
  // a buscar al administrador por algo que puede arreglar él.
  const s = await servidor(base(), OPERADOR);
  try {
    for (const [cuerpo, re] of [
      [{ fecha: 'ayer', lote_id: 10, kilos: 100 }, /YYYY-MM-DD/],
      [{ fecha: HOY, kilos: 100 }, /Falta elegir el lote/],
      [{ fecha: HOY, lote_id: 777, kilos: 100 }, /no existe/],
      [{ fecha: HOY, lote_id: 10 }, /no se entienden/],
      [{ fecha: HOY, lote_id: 10, kilos: 0 }, /mayores que cero/],
      [{ fecha: HOY, lote_id: 10, kilos: 100, cuadrilla_id: 99 }, /cuadrilla 99 no existe/],
    ]) {
      const r = await s.pegar('/volcados', json(cuerpo));
      assert.equal(r.status, 400, JSON.stringify(cuerpo));
      assert.match((await r.json()).error, re);
    }
    assert.equal((await (await s.pegar('/volcados?fecha=' + HOY)).json()).cargas.length, 0);
  } finally { s.cerrar(); }
});

t('corregir o borrar algo que no existe da 404, no 500', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    assert.equal((await s.pegar('/volcados/9999', patch({ kilos: 1 }))).status, 404);
    assert.equal((await s.pegar('/volcados/9999', { method: 'DELETE' })).status, 404);
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · EL CERO DE MÁS, DE PUNTA A PUNTA
// ══════════════════════════════════════════════════════════════════════════
t('un número absurdo entra con 200 y vuelve marcado', async () => {
  // Que NO sea un 400 es el punto: frenarlo enseñaría a partir el renglón en
  // dos para esquivar el tope, y el dato quedaría mal y además irrastreable.
  const s = await servidor(base(), OPERADOR);
  try {
    const r = await s.pegar('/volcados', json({ fecha: HOY, lote_id: 10, kilos: 45000 }));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.fila.estado, 'a_revisar');
    assert.match(j.aviso, /cero de más/);

    const d = await (await s.pegar('/volcados?fecha=' + HOY)).json();
    assert.equal(d.resumen.a_revisar, 1);
    assert.equal(d.resumen.kilos, 45000, 'lo marcado está cargado, no descartado');
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · EL DOBLE CLIC
// ══════════════════════════════════════════════════════════════════════════
t('DOS POST IDÉNTICOS CON EL MISMO UUID SON UNA SOLA CARGA', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    const cuerpo = { uuid: 'abc-123', fecha: HOY, lote_id: 10, kilos: 450 };
    const a = await (await s.pegar('/volcados', json(cuerpo))).json();
    const b = await (await s.pegar('/volcados', json(cuerpo))).json();
    assert.equal(b.ok, true, 'el reintento no puede dar error');
    assert.equal(b.repetido, true);
    assert.equal(b.id, a.id);

    const d = await (await s.pegar('/volcados?fecha=' + HOY)).json();
    assert.equal(d.cargas.length, 1);
    assert.equal(d.resumen.kilos, 450);
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · CORREGIR SIN ROMPER LO DE AL LADO
// ══════════════════════════════════════════════════════════════════════════
t('un PATCH de kilos no se lleva puesta la cuadrilla', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    const j = await (await s.pegar('/volcados', json({
      fecha: HOY, lote_id: 10, cuadrilla_id: 2, producto: 'Damasco', kilos: 450, ifcos: 18,
    }))).json();
    const k = await (await s.pegar('/volcados/' + j.id, patch({ kilos: '500' }))).json();
    assert.equal(k.fila.kilos, 500);
    assert.equal(k.fila.cuadrilla, 'Sur');
    assert.equal(k.fila.producto, 'Damasco');
    assert.equal(k.fila.ifcos, 18);
  } finally { s.cerrar(); }
});

t('borrar saca la carga del día y del resumen', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    const j = await (await s.pegar('/volcados',
      json({ fecha: HOY, lote_id: 10, kilos: 450 }))).json();
    await s.pegar('/volcados', json({ fecha: HOY, lote_id: 10, kilos: 100 }));
    await s.pegar('/volcados/' + j.id, { method: 'DELETE' });

    const d = await (await s.pegar('/volcados?fecha=' + HOY)).json();
    assert.equal(d.cargas.length, 1);
    assert.equal(d.resumen.kilos, 100);
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 8 · LA CARGA MANUAL NO TRABA EL LOTE DEL DÍA
// ══════════════════════════════════════════════════════════════════════════
t('con kilos cargados a mano, el tramo del día SIGUE corrigiéndose', async () => {
  // Una carga manual nombró su lote y no depende de ningún tramo. Si la trabara
  // igual, el que quiere arreglar un lote mal declarado no podría — y el candado
  // no estaría protegiendo nada.
  const s = await servidor(base(), OPERADOR);
  try {
    const l = await (await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10 }))).json();
    await s.pegar('/volcados', json({ fecha: HOY, lote_id: 10, kilos: 450 }));

    const r = await s.pegar('/lote-dia/' + l.id, patch({ lote_id: 11 }));
    assert.equal(r.status, 200, 'la carga manual trabó el tramo');

    const d = await (await s.pegar('/lote-dia?fecha=' + HOY)).json();
    assert.equal(d.tramos[0].lote_nombre, 'Cuadro 4');
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 9 · EL ACUMULADO (V1109)
// ══════════════════════════════════════════════════════════════════════════
// Andy, 31/10/2026: «mostrame algún lugar donde vamos acumulando el total, no
// sólo por día». Las sumas se prueban en test/galpon_acumulado.test.mjs; acá
// se prueba lo que sólo se ve con el router levantado.
t('el acumulado se lee con sesión, sin ser admin y sin salir de Puente Cordón', async () => {
  const sinSesion = await servidor(base(), null);
  try { assert.equal((await sinSesion.pegar('/acumulado')).status, 401); }
  finally { sinSesion.cerrar(); }

  const s = await servidor(base(), OPERADOR);
  try {
    assert.equal((await s.pegar('/acumulado')).status, 200);
    assert.equal((await s.pegar('/acumulado?sociedad_id=7')).status, 200);
    const r = await s.pegar('/acumulado?sociedad_id=9');
    assert.equal(r.status, 403, 'se leyó el galpón parado en San Gerónimo');
    assert.match((await r.json()).error, /Puente Cord/);
  } finally { s.cerrar(); }
});

t('EL ACUMULADO SUMA LO QUE SE CARGÓ, sin ningún cierre de por medio', async () => {
  // No hay tabla de totales ni proceso que correr: la misma carga que entra por
  // POST aparece en el acumulado en el pedido siguiente. Un total guardado
  // aparte se desincroniza justo cuando alguien corrige un error.
  const s = await servidor(base(), OPERADOR);
  try {
    await s.pegar('/volcados', json({ fecha: '2026-11-20', lote_id: 10, kilos: 100,
                                      cuadrilla_id: 1 }));
    await s.pegar('/volcados', json({ fecha: '2026-11-21', lote_id: 10, kilos: 250,
                                      cuadrilla_id: 1 }));

    const a = await (await s.pegar('/acumulado')).json();
    assert.equal(a.ok, true);
    assert.equal(a.total.kilos, 350);
    assert.equal(a.total.dias, 2);
    assert.equal(a.por_dia[0].acumulado, 350);
    assert.equal(a.desde, '2026-11-20');
    assert.equal(a.hasta, '2026-11-21');

    // Y una corrección se ve enseguida en el total.
    const id = (await (await s.pegar('/volcados?fecha=2026-11-21')).json()).cargas[0].id;
    await s.pegar('/volcados/' + id, patch({ kilos: 50 }));
    assert.equal((await (await s.pegar('/acumulado')).json()).total.kilos, 150);
  } finally { s.cerrar(); }
});

t('sin fechas devuelve TODO, y el rango viene aparte para el botón Todo', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    // Con la base vacía la pantalla tiene que poder distinguir «no hay nada
    // cargado» de «no hay nada EN ESTE PERÍODO»: son dos mensajes distintos.
    const v = await (await s.pegar('/acumulado')).json();
    assert.equal(v.rango.primera, null);
    assert.equal(v.total.kilos, 0);

    await s.pegar('/volcados', json({ fecha: '2026-11-20', lote_id: 10, kilos: 100 }));
    await s.pegar('/volcados', json({ fecha: '2026-11-25', lote_id: 10, kilos: 100 }));

    const a = await (await s.pegar('/acumulado')).json();
    assert.equal(a.rango.primera, '2026-11-20');
    assert.equal(a.rango.ultima, '2026-11-25');
    assert.equal(a.total.kilos, 200);

    const b = await (await s.pegar('/acumulado?desde=2026-11-21&hasta=2026-11-30')).json();
    assert.equal(b.total.kilos, 100);
    assert.equal(b.rango.primera, '2026-11-20', 'el rango cargado se recortó al período');
  } finally { s.cerrar(); }
});

t('el acumulado NO ESCRIBE nada: no tiene con qué', async () => {
  // Es la pantalla que mira la plata de toda la temporada. Que sea de sólo
  // lectura no es una opinión del manual: no hay ningún verbo de escritura
  // colgado de esa dirección.
  const s = await servidor(base(), ADMIN);
  try {
    for (const m of ['POST', 'PATCH', 'DELETE', 'PUT']) {
      const r = await s.pegar('/acumulado', Object.assign(json({}), { method: m }));
      assert.equal(r.status, 404, m + ' /acumulado contestó ' + r.status);
    }
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 10 · ⚡ EL ENCABEZADO DE LA CARGA RÁPIDA (V1110)
// ══════════════════════════════════════════════════════════════════════════
t('«LO ÚLTIMO QUE CARGUÉ YO» LO DECIDE LA COOKIE, no el que pregunta', async () => {
  // Si el cliente pudiera decir de quién quiere lo último, cualquiera arrancaría
  // su tanda con el encabezado de otro — y los kilos saldrían firmados por él
  // pero atribuidos a la cuadrilla del compañero.
  const db = base();
  const andy = await servidor(db, ADMIN);
  try {
    await andy.pegar('/volcados', json({ fecha: HOY, lote_id: 10, kilos: 100,
                                         cuadrilla_id: 1, observacion: 'pasada 1' }));
    const j = await (await andy.pegar('/volcados?fecha=' + HOY)).json();
    assert.equal(j.ultimo.cuadrilla, 'Norte');
    assert.equal(j.ultimo.observacion, 'pasada 1');
    assert.equal(j.ultimo.mio, true);
    assert.equal(j.ultimo.de_otro_dia, false);
  } finally { andy.cerrar(); }

  const juan = await servidor(db, OPERADOR);
  try {
    await juan.pegar('/volcados', json({ fecha: HOY, lote_id: 11, kilos: 200,
                                         cuadrilla_id: 2 }));
    const j = await (await juan.pegar('/volcados?fecha=' + HOY)).json();
    assert.equal(j.ultimo.cuadrilla, 'Sur');
    assert.equal(j.ultimo.mio, true);
    // Y el pedido NO puede pedir lo de otro: no hay parámetro que lo permita.
    const k = await (await juan.pegar('/volcados?fecha=' + HOY + '&usuario_id=1')).json();
    assert.equal(k.ultimo.cuadrilla, 'Sur');
  } finally { juan.cerrar(); }
});

t('el encabezado llega en el MISMO pedido con el que abre la pantalla', async () => {
  // Un segundo viaje para traer tres campos deja la ventana medio llena mientras
  // llega, y es justo la ventana que se abre para ir rápido.
  const s = await servidor(base(), OPERADOR);
  try {
    const j = await (await s.pegar('/volcados?fecha=' + HOY)).json();
    for (const k of ['cargas', 'resumen', 'propuesta', 'ultimo']) {
      assert.ok(k in j, 'falta ' + k + ' en la respuesta');
    }
    assert.equal(j.ultimo, null, 'sin nada cargado el encabezado tiene que venir vacío');
  } finally { s.cerrar(); }
});

t('deshacer una carga de la tanda la saca del día', async () => {
  // Es el botón de la lista de la tanda, y es un borrado blando como cualquier
  // otro: la fila queda en la base.
  const s = await servidor(base(), OPERADOR);
  try {
    const a = await (await s.pegar('/volcados', json({ fecha: HOY, lote_id: 10, kilos: 100 }))).json();
    await s.pegar('/volcados', json({ fecha: HOY, lote_id: 10, kilos: 200 }));
    assert.equal((await s.pegar('/volcados/' + a.id, { method: 'DELETE' })).status, 200);

    const d = await (await s.pegar('/volcados?fecha=' + HOY)).json();
    assert.equal(d.resumen.kilos, 200);
    assert.equal(d.cargas.length, 1);
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 11 · 📦 EL PROCESO (V1112)
// ══════════════════════════════════════════════════════════════════════════
// Las cuentas se prueban en test/galpon_proceso.test.mjs. Acá, lo que sólo se
// ve con el router levantado: quién puede qué, y que la pantalla se arme de
// un solo pedido.
t('CARGAR EL PROCESO NO PIDE ADMIN; EL CATÁLOGO SÍ', async () => {
  // Empacar es el trabajo del día. Definir una caja es parametrizar: una caja
  // mal definida multiplica mal todas las cargas que entren con ella.
  const s = await servidor(base(), OPERADOR);
  try {
    const cat = await (await s.pegar('/presentaciones')).json();
    assert.equal(cat.ok, true, 'el que empaca no puede ni leer el catálogo');
    assert.deepEqual(cat.destinos.map((d) => d.clave), ['comercial', 'verde', 'descarte']);

    assert.equal((await s.pegar('/presentaciones', json({ nombre: 'X', destino: 'verde',
      granel: 1 }))).status, 403, 'un operador define presentaciones');
    assert.equal((await s.pegar('/presentaciones/1', patch({ nombre: 'Y' }))).status, 403);
    assert.equal((await s.pegar('/presentaciones/1', { method: 'DELETE' })).status, 403);

    // Y en cambio carga procesos sin problema.
    assert.equal((await s.pegar('/procesos')).status, 200);
  } finally { s.cerrar(); }
});

t('el admin define el catálogo y el operador carga con él', async () => {
  const db = base();
  const a = await servidor(db, ADMIN);
  let id;
  try {
    const r = await a.pegar('/presentaciones', json({ nombre: 'Caja cartón · 10 × 700 g',
      destino: 'comercial', envase: 'Caja cartón', por_bulto: 10, kg_unidad: 0.7 }));
    assert.equal(r.status, 200);
    id = (await r.json()).id;
  } finally { a.cerrar(); }

  const o = await servidor(db, OPERADOR);
  try {
    const r = await o.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: id, bultos: 100 }));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.fila.kilos, 700);
    // La firma sale de la cookie, no del cuerpo.
    assert.equal(j.fila.usuario, 'Juan');
  } finally { o.cerrar(); }
});

t('sin sesión no se lee ni se carga nada del proceso', async () => {
  const s = await servidor(base(), null);
  try {
    for (const [ruta, opts] of [
      ['/procesos', undefined],
      ['/procesos', json({ fecha: HOY, lote_id: 10 })],
      ['/procesos/1', patch({ bultos: 1 })],
      ['/procesos/1', { method: 'DELETE' }],
      ['/presentaciones', undefined],
      ['/stock', undefined],
    ]) assert.equal((await s.pegar(ruta, opts)).status, 401, ruta);
  } finally { s.cerrar(); }
});

t('EL CERROJO DE EMPRESA TAPA TAMBIÉN LAS RUTAS DEL PROCESO', async () => {
  const s = await servidor(base(), ADMIN);
  try {
    for (const [ruta, opts] of [
      ['/procesos?sociedad_id=9', undefined],
      ['/procesos?sociedad_id=9', json({ fecha: HOY, lote_id: 10 })],
      ['/presentaciones?sociedad_id=9', undefined],
      ['/presentaciones?sociedad_id=9', json({ nombre: 'X', destino: 'verde' })],
      ['/stock?sociedad_id=9', undefined],
    ]) {
      const r = await s.pegar(ruta, opts);
      assert.equal(r.status, 403, 'pasó parado en San Gerónimo: ' + ruta);
      assert.match((await r.json()).error, /Puente Cord/);
    }
    assert.equal((await s.pegar('/procesos?sociedad_id=7')).status, 200);
  } finally { s.cerrar(); }
});

t('LA PANTALLA SE ARMA DE UN SOLO PEDIDO', async () => {
  // Cinco llamadas la dejan contradiciéndose a sí misma mientras llegan: el
  // tablero de un lote con el stock de otro, las baldosas sin los lotes.
  //
  // Va con ADMIN porque el armado necesita crear una presentación, que es
  // parametrización. Que el operador NO pueda crearla lo prueba el test de
  // más arriba.
  const db = base();
  const s = await servidor(db, ADMIN);
  try {
    db.prepare("INSERT INTO gal_volcados (fecha,lote_id,lote_nombre,producto,kilos)"
      + " VALUES (?,10,'Cuadro 3','Damasco',5000)").run(HOY);
    const id = (await (await s.pegar('/presentaciones',
      json({ nombre: 'Bin', destino: 'verde', granel: 1 }))).json()).id;
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10, presentacion_id: id,
                                      kilos: 1200 }));

    const j = await (await s.pegar('/procesos?fecha=' + HOY + '&lote_id=10')).json();
    for (const k of ['destinos', 'presentaciones', 'lotes', 'procesos', 'tablero', 'stock']) {
      assert.ok(k in j, 'falta ' + k + ' en la respuesta');
    }
    assert.equal(j.lotes[0].lote_id, 10);
    assert.equal(j.lotes[0].sin_procesar, 3800);
    assert.equal(j.tablero.volcado, 5000);
    assert.equal(j.tablero.destinos.verde, 1200);
    assert.equal(j.stock.kilos, 1200);
    assert.equal(j.procesos.length, 1);
  } finally { s.cerrar(); }
});

t('el catálogo de presentaciones se crea con admin aunque nadie lo pida', async () => {
  // El operador necesita presentaciones el primer día. Sin ninguna, la pantalla
  // de proceso no tiene baldosas y no hay forma de cargar nada.
  const s = await servidor(base(), ADMIN);
  try {
    const mal = await s.pegar('/presentaciones', json({ nombre: 'Caja', destino: 'comercial',
      por_bulto: 0, kg_unidad: 0 }));
    assert.equal(mal.status, 400, 'aceptó una cuenta en cero: multiplicaría por nada');
    assert.match((await mal.json()).error, /mayores que cero/);

    const sinNombre = await s.pegar('/presentaciones', json({ destino: 'comercial',
      granel: 1 }));
    assert.equal(sinNombre.status, 400);
  } finally { s.cerrar(); }
});
