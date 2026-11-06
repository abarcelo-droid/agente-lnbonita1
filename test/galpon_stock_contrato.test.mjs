// ══ 🚚 EL CONTRATO ENTRE EL ROUTER Y LA PANTALLA DE STOCK ═══════════════════
//
// Andy, 1/11/2026, mirando la pantalla recién subida: «dest.reduce is not a
// function». La pantalla entera en blanco con un renglón de error arriba.
//
// Lo que había era TRES bugs encadenados, y ninguno de los tres lo podía ver
// el audit de panel.html, que mira el TEXTO del JS:
//
//   1. DOS RUTAS GET /stock. Express se queda con la PRIMERA y la segunda no
//      se ejecuta nunca. La vieja devolvía otra cosa, y compila igual: una
//      ruta tapada no tiene un solo síntoma hasta que alguien la llama.
//   2. stockGalpon() devuelve { destinos, kilos } y el front lo trataba como
//      un ARRAY. De ahí el dest.reduce.
//   3. Los despachos salían SIN sus líneas, así que reabrir un borrador con
//      diez cajas mostraba «todavía no cargaste nada».
//
// Por eso este archivo no mira código: levanta el router de verdad, le pega
// con fetch, y le da la respuesta TAL CUAL al JS de la pantalla, ejecutándolo
// contra un DOM de mentira. Si el contrato se rompe, se rompe acá.
//
// -- SIN node_modules ESTE ARCHIVO SE SALTEA ENTERO, NO SE CAE -------------
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sociedades (id INTEGER PRIMARY KEY, nombre TEXT);
    INSERT INTO sociedades (id,nombre) VALUES (7,'Puente Cordón SA');
    CREATE TABLE pa_sectores (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT);
    INSERT INTO pa_sectores (id,nombre,tipo) VALUES (1,'Frutales','frutales');
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, sector_id INTEGER,
      finca TEXT, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,sector_id,finca,activo) VALUES
      (10,'Cuadro 3',1,'La Esperanza',1);
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY, lote_id INTEGER, cultivo TEXT,
      campaña TEXT, es_perenne INTEGER DEFAULT 0);
    INSERT INTO pa_cultivos_lote (lote_id,cultivo,es_perenne) VALUES (10,'Damasco',1);
    CREATE TABLE pa_cuadrillas (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT,
      activo INTEGER DEFAULT 1);
    CREATE TABLE gal_cuadrilla_tarjetas (id INTEGER PRIMARY KEY AUTOINCREMENT,
      cuadrilla_id INTEGER NOT NULL, desde_id INTEGER NOT NULL, hasta_id INTEGER NOT NULL,
      color TEXT NOT NULL DEFAULT '#1a3a5c', activo INTEGER NOT NULL DEFAULT 1,
      notas TEXT, creado_en TEXT);
    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
    INSERT INTO gal_config (clave,valor) VALUES
      ('kg_max_carga','20000'), ('despacho_prefijo','DG'), ('pallet_prefijo','PC');
    CREATE TABLE gal_lote_vigente (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL,
      desde_hora TEXT NOT NULL DEFAULT '00:00', lote_id INTEGER NOT NULL, lote_nombre TEXT,
      producto TEXT, usuario_id INTEGER, usuario TEXT, creado_en TEXT);
    -- El reparto por cuadrilla de cada carga. Un cajon puede ser de dos (V1133).
    CREATE TABLE gal_volcado_cuadrillas (
      volcado_id INTEGER NOT NULL, cuadrilla_id INTEGER NOT NULL,
      cuadrilla TEXT, kilos REAL NOT NULL,
      PRIMARY KEY (volcado_id, cuadrilla_id));
    CREATE TABLE gal_volcados (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE,
      fecha TEXT NOT NULL, hora TEXT, lote_id INTEGER NOT NULL, lote_nombre TEXT,
      producto TEXT, cuadrilla_id INTEGER, cuadrilla TEXT, kilos REAL NOT NULL,
      ifcos INTEGER, bruto REAL, tara REAL, tarjeta_id INTEGER, viaje INTEGER, sanitario TEXT,
      origen TEXT NOT NULL DEFAULT 'manual', observacion TEXT,
      estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT, usuario_id INTEGER,
      usuario TEXT, creado_en TEXT, eliminado_en TEXT);
    CREATE TABLE gal_lote_datos (lote_id INTEGER PRIMARY KEY, renspa TEXT, variedad TEXT,
      cuartel TEXT, notas TEXT, actualizado TEXT);
    CREATE TABLE gal_presentaciones (id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL, destino TEXT NOT NULL, envase TEXT,
      por_bulto REAL NOT NULL DEFAULT 1, kg_unidad REAL NOT NULL DEFAULT 1,
      granel INTEGER NOT NULL DEFAULT 0, emoji TEXT, icono TEXT, icono_v TEXT, categoria TEXT NOT NULL DEFAULT 'I',
      calibre TEXT, color TEXT, orden INTEGER NOT NULL DEFAULT 100,
      activo INTEGER NOT NULL DEFAULT 1, creado_en TEXT, eliminado_en TEXT);
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
      repartido INTEGER NOT NULL DEFAULT 0, pallet_id INTEGER, partido_de INTEGER, despacho_id INTEGER,
      observacion TEXT, estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT,
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
  const dir = fs.mkdtempSync(path.join(RAIZ, '.tmp-galst-'));
  fs.mkdirSync(path.join(dir, 'servicios'));
  fs.mkdirSync(path.join(dir, 'rutas'));
  /* src/config también: servicios/ia_costo.js importa ../config/ia.js, que es
     donde viven los model IDs. Sin esta carpeta el router no arranca y el test
     muere con ERR_MODULE_NOT_FOUND, que no dice nada de lo que se está probando. */
  fs.mkdirSync(path.join(dir, 'config'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/config'))) {
    if (f.endsWith('.js')) {
      fs.copyFileSync(path.join(RAIZ, 'src/config', f), path.join(dir, 'config', f));
    }
  }
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

  const mod = await import('file:///' + path.join(dir, 'rutas', 'galpon.js').replace(/\\/g, '/')
    + '?t=' + Date.now());
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

const ADMIN = { id: 1, nombre: 'Andy', rol: 'admin' };
const json = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
                       body: JSON.stringify(b) });
const HOY = new Date().toLocaleDateString('en-CA');

/* BAJAR AL PISO LO QUE CAYÓ EN EL PALLET DEL DÍA. Una carga de /procesos entra
   siempre al pallet que se está llenando, y desde la V1146 lo que está en un
   pallet no se ofrece para armar otro. Esto hace por la API lo que el operador
   hace a mano: reabre lo que esté cerrado y le saca los renglones.

   Y es el camino de verdad, no un atajo del test: el mismo que recorre el que
   junta tres pallets parciales en uno para el camión. */
async function alPiso(s, db) {
  const vaciar = async (pid) => {
    for (const r of db.prepare('SELECT id FROM gal_procesos WHERE pallet_id = ?'
      + " AND eliminado_en IS NULL AND tipo = 'ingreso'").all(pid)) {
      await s.pegar('/pallets/sacar/' + r.id, json({}));
    }
    await s.pegar('/pallets/' + pid, { method: 'DELETE' });
  };
  /* DE A UNO Y EL ABIERTO PRIMERO: un pallet del proceso no se reabre mientras
     haya otro abierto (sería la ambigüedad de a dónde cae la caja siguiente), así
     que el vacío se saca del medio antes de reabrir el que sigue. */
  for (;;) {
    const ab = db.prepare("SELECT id FROM gal_pallets WHERE estado = 'abierto'"
      + ' AND eliminado_en IS NULL').get();
    if (!ab) break;
    await vaciar(ab.id);
  }
  for (;;) {
    const ce = db.prepare("SELECT id FROM gal_pallets WHERE estado = 'cerrado'"
      + ' AND eliminado_en IS NULL').get();
    if (!ce) break;
    await s.pegar('/pallets/' + ce.id + '/reabrir', json({}));
    await vaciar(ce.id);
  }
}

// ── EL DOM DE MENTIRA ──────────────────────────────────────────────────────
// Lo mínimo para que el JS de la pantalla corra: los contenedores que pinta y
// los casilleros de la ventana. Guarda el innerHTML para poder mirarlo.
function domFalso() {
  const nodos = {};
  const crear = (id) => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false,
    style: { display: '' }, className: '',
    classList: { add() {}, remove() {} },
  });
  for (const id of ['gst-aviso', 'gst-bal', 'gst-stock', 'gst-lotes', 'gst-desp',
    'gal-dsp-modal', 'gal-dsp-rep', 'gal-dsp-tit', 'gal-dsp-items', 'gal-dsp-cargar',
    'gal-dsp-emitir', 'gal-dsp-anular', 'gal-dsp-item', 'gal-dsp-cant', 'gal-dsp-cl',
    'gal-dsp-disp', 'gal-dsp-fecha', 'gal-dsp-dest', 'gal-dsp-transp', 'gal-dsp-pat',
    'gal-dsp-rem', 'gal-dsp-obs', 'gal-dsp-culata',
    'gst-arm', 'gal-arm-modal', 'gal-arm-rep', 'gal-arm-tit', 'gal-arm-lineas',
    'gal-arm-cargar', 'gal-arm-cerrarp', 'gal-arm-reabrir', 'gal-arm-tarj',
    'gal-arm-item', 'gal-arm-cant', 'gal-arm-cl', 'gal-arm-disp',
    'gal-arm-fecha', 'gal-arm-obs', 'gal-arm-detalle', 'gal-arm-enp',
    'gal-arm-lab']) nodos[id] = crear(id);
  return { nodos, document: { getElementById: (id) => nodos[id] || null } };
}

// El bloque de JS de la pantalla, sacado de panel.html y ejecutado de verdad.
function pantalla(dom, pegar) {
  /* Desde el bloque COMÚN del dibujito: galDibHtml y galDibUrl se usan adentro de
     GST pero viven afuera, porque las comparten cuatro pantallas. */
  const marca = PANEL.indexOf('   🖼️ EL DIBUJITO DE UNA PRESENTACIÓN');
  assert.ok(marca > 0, 'no encontré el bloque del dibujito en panel.html');
  // Desde el /* del banner: arrancar a mitad de un comentario deja el cierre
  // suelto y new Function tira SyntaxError sin decir dónde.
  const i = PANEL.lastIndexOf('/*', marca);
  assert.ok(i > 0 && marca - i < 400, 'el banner del dibujito no abre comentario');
  const fin = PANEL.indexOf('function galStInit(){', i);
  assert.ok(fin > i, 'no encontré el final del bloque GST');
  const codigo = PANEL.slice(i, fin);
  // Las dos cosas del navegador que el bloque usa: fetch contra el router de
  // verdad, y document contra el DOM de mentira.
  const f = new Function('document', 'fetch', 'confirm', 'prompt', 'window',
    'sgModalArriba',
    codigo + '\nreturn { GST, galStCargar, galStPintar, galDspAbrir, galDspPintar,'
    + ' galDspItems, galDspAgregar, galDspItemPick, galDspEmitir,'
    + ' galArmCargar, galArmAbrir, galArmPintar, galArmMover, galArmItemPick,'
    + ' galArmLineas, galArmLista, galArmCerrarPallet, galArmSacar,'
    + ' galArmReabrir, galArmBorrar, galArmCerrar };');
  dom.abiertas = [];
  return f(dom.document,
    (u, o) => pegar(String(u).replace('/api/galpon', ''), o),
    () => true, () => 'motivo', { location: '' },
    (id) => dom.abiertas.push(id));
}

// ══════════════════════════════════════════════════════════════════════════
// 1 · UNA SOLA RUTA /stock
// ══════════════════════════════════════════════════════════════════════════
t('HAY UNA SOLA RUTA GET /stock', async () => {
  // Dos con la misma dirección: Express se queda con la primera y la segunda
  // no corre nunca. Es el bug que dejó la pantalla en blanco, y no tiene
  // ningún síntoma hasta que alguien la llama.
  const src = fs.readFileSync(path.join(RAIZ, 'src/rutas/galpon.js'), 'utf8');
  const rutas = [...src.matchAll(/router\.(get|post|patch|delete)\('([^']+)'/g)]
    .map((m) => m[1] + ' ' + m[2]);
  const vistas = new Set();
  const repes = rutas.filter((r) => (vistas.has(r) ? true : (vistas.add(r), false)));
  assert.deepEqual(repes, [], 'hay rutas duplicadas: la segunda no se ejecuta nunca');
});

t('la respuesta de /stock trae TODO lo que la pantalla lee', async () => {
  const s = await servidor(base(), ADMIN);
  try {
    const j = await (await s.pegar('/stock')).json();
    assert.equal(j.ok, true);
    /* «piso» y «pallets» son las DOS maneras de cargar un camión (V1143). Antes
       había una sola lista, «disponible», que mezclaba lo suelto con lo que estaba
       adentro de un pallet cerrado — y por eso se podía pedir una cantidad que
       terminaba partiendo un pallet armado. */
    for (const k of ['hoy', 'destinos', 'stock', 'lotes', 'piso', 'pallets', 'despachos']) {
      assert.ok(k in j, 'falta ' + k + ' en la respuesta de /stock');
    }
    assert.ok(!('disponible' in j),
      'volvió la lista que mezclaba el piso con los pallets cerrados');
    // Y el stock es un OBJETO con destinos, no un array: tratarlo como array
    // es exactamente lo que rompió la pantalla.
    assert.ok(!Array.isArray(j.stock), 'stock volvió a ser un array');
    assert.ok(Array.isArray(j.stock.destinos));
    assert.equal(typeof j.stock.kilos, 'number');
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LA PANTALLA CORRE CONTRA LA RESPUESTA DE VERDAD
// ══════════════════════════════════════════════════════════════════════════
t('LA PANTALLA SE PINTA SIN ERRORES con la base vacía', async () => {
  // El caso del día uno: nadie cargó nada todavía. Una pantalla que se rompe
  // con la base vacía es una pantalla que nadie puede ni abrir para empezar.
  const s = await servidor(base(), ADMIN);
  const dom = domFalso();
  try {
    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    assert.equal(dom.nodos['gst-aviso'].innerHTML, '',
      'la pantalla avisó un error: ' + dom.nodos['gst-aviso'].innerHTML);
    assert.match(dom.nodos['gst-bal'].innerHTML, /kg en cámara/);
    assert.match(dom.nodos['gst-stock'].innerHTML, /No hay nada en cámara|Todavía/);
    assert.match(dom.nodos['gst-desp'].innerHTML, /Todavía no se despachó nada/);
  } finally { s.cerrar(); }
});

t('LA PANTALLA SE PINTA SIN ERRORES con stock cargado', async () => {
  // Éste es el que agarra el dest.reduce: con la base vacía un bug de forma
  // puede pasar de largo, porque el array vacío y el objeto sin destinos se
  // pintan igual de vacíos.
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'Caja 8 kg', por_bulto: 1, kg_unidad: 8,
      calibre: '50/55', categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 100, uuid: 'u1' }));

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    assert.equal(dom.nodos['gst-aviso'].innerHTML, '',
      'la pantalla avisó un error: ' + dom.nodos['gst-aviso'].innerHTML);
    // Las cajas, grandes; los kilos, al lado.
    assert.match(dom.nodos['gst-bal'].innerHTML, /800/, 'no pintó los kilos');
    assert.match(dom.nodos['gst-bal'].innerHTML, />100</, 'no pintó las cajas');
    assert.match(dom.nodos['gst-stock'].innerHTML, /Cuadro 3/);
    assert.match(dom.nodos['gst-stock'].innerHTML, /50\/55/);
    // El lote ya no tiene su propia sección: vive adentro de la baldosa de su
    // presentación, plegado. Andy: «no me interesa por lote».
    assert.match(dom.nodos['gst-stock'].innerHTML, /gst-lot/);
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LA VENTANA, CON SUS LÍNEAS
// ══════════════════════════════════════════════════════════════════════════
t('REABRIR UN BORRADOR MUESTRA LO QUE TIENE ADENTRO', async () => {
  // Los despachos venían sin sus líneas, así que un borrador con diez cajas
  // decía «todavía no cargaste nada» — y el que lo mira vuelve a cargarlas.
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'Caja 8 kg', por_bulto: 1, kg_unidad: 8,
      calibre: '50/55', categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 100, uuid: 'u1' }));
    const d = await (await s.pegar('/despachos', json({ fecha: HOY,
      destinatario: 'San Gerónimo' }))).json();
    const r = await (await s.pegar('/despachos/' + d.id + '/items', json({
      lote_id: 10, destino: 'comercial', presentacion_id: a.id,
      calibre: '50/55', bultos: 40 }))).json();
    assert.equal(r.ok, true, r.error);

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galDspAbrir(d.id);
    assert.equal(dom.nodos['gst-aviso'].innerHTML, '',
      'la pantalla avisó un error: ' + dom.nodos['gst-aviso'].innerHTML);
    assert.match(dom.nodos['gal-dsp-items'].innerHTML, /Cuadro 3/,
      'la ventana no muestra las líneas que el despacho ya tiene');
    assert.match(dom.nodos['gal-dsp-items'].innerHTML, />40</);
    assert.equal(dom.nodos['gal-dsp-dest'].value, 'San Gerónimo',
      'no cargó los datos del despacho');
  } finally { s.cerrar(); }
});

t('el selector de qué cargar se llena con lo que hay', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'Caja 8 kg', por_bulto: 1, kg_unidad: 8,
      calibre: '50/55', categoria: 'I' }))).json();
    // Un segundo artículo en el catálogo SIN una sola caja: no tiene que salir.
    await s.pegar('/presentaciones', json({ nombre: 'Caja', destino: 'comercial',
      envase: 'Caja 8 kg', por_bulto: 1, kg_unidad: 8, calibre: '60/70',
      categoria: 'I' }));
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 100, uuid: 'u1' }));

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galDspAbrir();
    assert.equal(dom.nodos['gst-aviso'].innerHTML, '',
      'la pantalla avisó un error: ' + dom.nodos['gst-aviso'].innerHTML);
    assert.deepEqual(dom.abiertas, ['gal-dsp-modal'], 'no abrió la ventana');
    const op = dom.nodos['gal-dsp-item'].innerHTML;
    assert.match(op, /50\/55/, 'no ofrece lo que hay');
    assert.ok(!op.includes('60/70'), 'ofrece un artículo que no tiene stock');
    assert.match(dom.nodos['gal-dsp-fecha'].value, /^\d{4}-\d{2}-\d{2}$/,
      'el despacho nuevo salió sin fecha');
  } finally { s.cerrar(); }
});

t('CARGAR UNA LÍNEA DE MÁS AVISA EN LA PANTALLA, no en la consola', async () => {
  // El tope frena en el servidor; lo que se prueba acá es que el aviso LLEGUE
  // a la pantalla con el número adentro. Un 400 que nadie muestra es una
  // pantalla donde el botón no hace nada.
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'Caja 8 kg', por_bulto: 1, kg_unidad: 8,
      calibre: '50/55', categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 40, uuid: 'u1' }));

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galDspAbrir();
    dom.nodos['gal-dsp-item'].value = '0';
    dom.nodos['gal-dsp-cant'].value = '41';
    await p.galDspAgregar();
    assert.match(dom.nodos['gst-aviso'].innerHTML, /40/,
      'el aviso del tope no llegó a la pantalla');
    assert.match(dom.nodos['gal-dsp-items'].innerHTML, /Todavía no cargaste/,
      'guardó igual');
  } finally { s.cerrar(); }
});

t('EMITIR DEJA EL NÚMERO A LA VISTA en la ventana', async () => {
  // La regla 4 de CLAUDE.md: la ventana no se cierra al guardar porque adentro
  // queda lo que hay que leer. Acá se verifica que además se VEA.
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'Caja 8 kg', por_bulto: 1, kg_unidad: 8,
      calibre: '50/55', categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 100, uuid: 'u1' }));

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galDspAbrir();
    dom.nodos['gal-dsp-item'].value = '0';
    dom.nodos['gal-dsp-cant'].value = '40';
    await p.galDspAgregar();
    await p.galDspEmitir();
    assert.equal(dom.nodos['gst-aviso'].innerHTML, '',
      'la pantalla avisó un error: ' + dom.nodos['gst-aviso'].innerHTML);
    assert.match(dom.nodos['gal-dsp-rep'].innerHTML, /DG-\d\d-00001/,
      'el número emitido no quedó a la vista');
    assert.match(dom.nodos['gal-dsp-rep'].innerHTML, /40/);
    // Y el stock quedó descontado en la lista de atrás.
    assert.match(dom.nodos['gst-stock'].innerHTML, />60</,
      'la pantalla de atrás no se actualizó');
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · EL STOCK EN BALDOSAS, POR PRESENTACIÓN
// ══════════════════════════════════════════════════════════════════════════
t('LA MISMA CAJA DE DOS LOTES ES UNA SOLA BALDOSA', async () => {
  // Andy, 1/11/2026: «no me interesa por lote. Me interesa PRESENTACIÓN Y
  // CAJAS». Lo que vio eran diecinueve renglones y la misma caja repetida en
  // cada lote: para saber cuántas había de cartón amarillo había que sumar
  // tres números de memoria.
  const db = base();
  db.exec("INSERT INTO pa_lotes (id,nombre,sector_id,finca,activo) "
    + "VALUES (11,'Cuadro 4',1,'La Esperanza',1)");
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Carton Amarilla',
      destino: 'comercial', envase: 'Caja', por_bulto: 10, kg_unidad: 0.7,
      emoji: '📦', categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 267, uuid: 'u1' }));
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 11,
      presentacion_id: a.id, bultos: 17, uuid: 'u2' }));

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    assert.equal(dom.nodos['gst-aviso'].innerHTML, '',
      'la pantalla avisó un error: ' + dom.nodos['gst-aviso'].innerHTML);
    const h = dom.nodos['gst-stock'].innerHTML;
    // UNA baldosa, con los dos lotes sumados.
    assert.equal((h.match(/gst-card/g) || []).length, 1,
      'pintó más de una baldosa para la misma presentación');
    assert.match(h, />284</, 'no sumó los dos lotes (267 + 17)');
    assert.match(h, /📦/, 'no pintó el dibujito');
    // Y los lotes siguen adentro, plegados: el despacho los necesita.
    assert.match(h, /Cuadro 3/);
    assert.match(h, /Cuadro 4/);
    assert.match(h, /gst-lot/);
  } finally { s.cerrar(); }
});

t('las baldosas salen agrupadas por destino, cada banda una sola vez', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    for (const [nombre, destino] of [['Caja', 'comercial'], ['Blanca Verde', 'verde'],
      ['Blanca Descarte', 'descarte'], ['IFCO', 'comercial']]) {
      const a = await (await s.pegar('/presentaciones', json({ nombre, destino,
        envase: 'x', por_bulto: 1, kg_unidad: 8, categoria: 'I' }))).json();
      await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
        presentacion_id: a.id, bultos: 10, uuid: 'u' + a.id }));
    }
    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    const h = dom.nodos['gst-stock'].innerHTML;
    assert.equal((h.match(/gst-card/g) || []).length, 4);
    // Tres bandas, no cuatro: las dos comerciales van juntas.
    assert.equal((h.match(/gst-dh/g) || []).length, 3,
      'un destino apareció en dos bandas distintas');
    // Y el markup cierra parejo: una grilla sin cerrar se come el resto de la
    // pantalla adentro, y el navegador no se queja.
    assert.equal((h.match(/<div\b/g) || []).length, (h.match(/<\/div>/g) || []).length,
      'quedó un <div> sin cerrar');
    assert.equal((h.match(/<div class="gst-grid">/g) || []).length, 3);
  } finally { s.cerrar(); }
});

t('una presentación A GRANEL muestra kilos, no cajas', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Bin',
      destino: 'verde', envase: 'Bin', granel: 1, categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, kilos: 1200, uuid: 'u1' }));
    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    const h = dom.nodos['gst-stock'].innerHTML;
    assert.match(h, /1\.200<span class="gst-cu">kg/,
      'un granel tiene que decir kg, no cajas');
    assert.ok(!/>cajas</.test(h), 'le puso cajas a un granel');
  } finally { s.cerrar(); }
});

t('el DIBUJITO se esconde del lector de pantalla', async () => {
  // Leído en voz alta, «caja envuelta para regalo Carton Amarilla» es peor
  // que el nombre solo: el emoji acelera encontrar con la vista y no aporta
  // nada a quien no la usa.
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      emoji: '📦', categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 10, uuid: 'u1' }));
    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    /* Se verifica la CONDICIÓN —que el dibujito esté escondido del lector— y
       no el markup exacto, que ahora lo arma galDibHtml en un solo lugar para
       las cuatro pantallas. Un assert pegado al markup se cae cada vez que se
       toca un atributo y no prueba nada más que eso. */
    const h = dom.nodos['gst-stock'].innerHTML;
    const m = /<span[^>]*>📦<\/span>/.exec(h);
    assert.ok(m, 'no pintó el dibujito');
    assert.match(m[0], /aria-hidden="true"/,
      'el lector de pantalla le lee el dibujito');
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · EL DIBUJO PROPIO, PUNTA A PUNTA
// ══════════════════════════════════════════════════════════════════════════
// Andy, 1/11/2026: «quiero yo poder subirle algún dibujito desde la
// computadora». Acá se sube por la ruta de verdad, se pide por la ruta de
// verdad, y se mira que la baldosa lo pinte.
function pngDePrueba(ancho, alto) {
  const crc32 = (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (tipo, datos) => {
    const largo = Buffer.alloc(4); largo.writeUInt32BE(datos.length);
    const cuerpo = Buffer.concat([Buffer.from(tipo, 'latin1'), datos]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cuerpo));
    return Buffer.concat([largo, cuerpo, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0); ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(alto * (1 + ancho * 4)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const dataUrlPNG = (a, b) => 'data:image/png;base64,'
  + pngDePrueba(a, b).toString('base64');

t('SE SUBE, SE PIDE Y LA BALDOSA LO PINTA', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Carton Amarilla',
      destino: 'comercial', envase: 'Caja', por_bulto: 1, kg_unidad: 8,
      emoji: '📦', categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 40, uuid: 'u1' }));

    const sub = await (await s.pegar('/presentaciones/' + a.id + '/icono',
      json({ imagen: dataUrlPNG(96, 96) }))).json();
    assert.equal(sub.ok, true, sub.error);
    assert.ok(sub.icono_v);

    // Se pide por la ruta de verdad y vuelve un PNG.
    const img = await s.pegar('/presentaciones/' + a.id + '/icono');
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await img.arrayBuffer());
    assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47],
      'lo que volvió no es un PNG');

    // Y la baldosa lo pinta EN VEZ del emoji: el dibujo propio gana.
    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    const h = dom.nodos['gst-stock'].innerHTML;
    assert.match(h, new RegExp('<img src="[^"]*presentaciones/' + a.id + '/icono'),
      'la baldosa no pinta el dibujo subido');
    assert.match(h, new RegExp('v=' + sub.icono_v),
      'la URL no lleva la versión: el navegador va a mostrar el anterior para siempre');
    assert.ok(!h.includes('📦'), 'pintó el emoji además del dibujo');
  } finally { s.cerrar(); }
});

t('LA RUTA DEL ARCHIVO NO VIAJA EN NINGUNA RESPUESTA', async () => {
  // Misma regla que la foto de la tarjeta de un contacto: lo que se guarda
  // queda en el disco del servidor y sale sólo por su endpoint con sesión.
  const db = base();
  const s = await servidor(db, ADMIN);
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8 }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 10, uuid: 'u1' }));
    await s.pegar('/presentaciones/' + a.id + '/icono', json({ imagen: dataUrlPNG(96, 96) }));

    for (const ruta of ['/presentaciones', '/stock', '/procesos']) {
      const txt = await (await s.pegar(ruta)).text();
      assert.ok(!/"icono"\s*:/.test(txt), 'la ruta del archivo salió en ' + ruta);
      assert.ok(!/data[\\/]galpon/.test(txt), 'salió la carpeta en ' + ruta);
    }
  } finally { s.cerrar(); }
});

t('UN SVG SE RECHAZA POR LA RUTA DE VERDAD', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8 }))).json();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const r = await s.pegar('/presentaciones/' + a.id + '/icono',
      json({ imagen: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') }));
    assert.equal(r.status, 400);
    // Y tampoco entra disfrazado de PNG.
    const r2 = await s.pegar('/presentaciones/' + a.id + '/icono',
      json({ imagen: 'data:image/png;base64,' + Buffer.from(svg).toString('base64') }));
    assert.equal(r2.status, 400);
    assert.equal((await s.pegar('/presentaciones/' + a.id + '/icono')).status, 404);
  } finally { s.cerrar(); }
});

t('SUBIR EL DIBUJO ES PARAMETRIZAR: un operador no puede', async () => {
  // Es el catálogo, igual que el resto de /presentaciones. Pero VERLO sí: lo
  // mira todo el que abre el stock.
  const db = base();
  const s = await servidor(db, { id: 2, nombre: 'Juan', rol: 'operador' });
  try {
    const r = await s.pegar('/presentaciones/1/icono', json({ imagen: dataUrlPNG(96, 96) }));
    assert.equal(r.status, 403);
    assert.equal((await s.pegar('/presentaciones/1/icono', { method: 'DELETE' })).status, 403);
    // Verlo no da 403 (da 404 porque no hay ninguno, que es otra cosa).
    assert.equal((await s.pegar('/presentaciones/1/icono')).status, 404);
  } finally { s.cerrar(); }
});

t('quitar el dibujo lo saca de la baldosa y vuelve el emoji', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      emoji: '📦' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 10, uuid: 'u1' }));
    await s.pegar('/presentaciones/' + a.id + '/icono', json({ imagen: dataUrlPNG(96, 96) }));
    await s.pegar('/presentaciones/' + a.id + '/icono', { method: 'DELETE' });

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    const h = dom.nodos['gst-stock'].innerHTML;
    assert.ok(!h.includes('<img'), 'la baldosa sigue pintando el dibujo borrado');
    assert.match(h, /📦/, 'no volvió el emoji');
    assert.equal((await s.pegar('/presentaciones/' + a.id + '/icono')).status, 404);
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · ARMAR UN PALLET DESDE EL STOCK, PUNTA A PUNTA
// ══════════════════════════════════════════════════════════════════════════
// Andy, 1/11/2026: «necesito un lugar donde pueda hacer cierre de pallet de
// mercadería que está suelta en el stock, donde puedo agarrar pallets mixtos
// y todo».
t('UN PALLET MIXTO ARMADO DESDE LA PANTALLA, y el stock intacto', async () => {
  const db = base();
  db.exec("INSERT INTO pa_lotes (id,nombre,sector_id,finca,activo) "
    + "VALUES (11,'Cuadro 4',1,'La Esperanza',1)");
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Carton Amarilla',
      destino: 'comercial', envase: 'Caja', por_bulto: 1, kg_unidad: 8,
      categoria: 'I', calibre: '50/55' }))).json();
    const b = await (await s.pegar('/presentaciones', json({ nombre: 'IFCO',
      destino: 'comercial', envase: 'IFCO', por_bulto: 1, kg_unidad: 14,
      categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 267, uuid: 'u1' }));
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 11,
      presentacion_id: a.id, bultos: 17, uuid: 'u2' }));
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: b.id, bultos: 49, uuid: 'u3' }));

    await alPiso(s, db);
    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    const stockAntes = (await (await s.pegar('/stock')).json()).stock.kilos;

    await p.galArmAbrir();
    assert.equal(dom.nodos['gst-aviso'].innerHTML, '',
      'la pantalla avisó un error: ' + dom.nodos['gst-aviso'].innerHTML);
    assert.deepEqual(dom.abiertas, ['gal-arm-modal'], 'no abrió la ventana');
    const ops = dom.nodos['gal-arm-item'].innerHTML;
    /* TRES opciones y no veinte: el vacío y los dos artículos. Por ubicación eran
       cuatro montones —el cartón repetido por cada lote— y lo que Andy vio en
       pantalla fueron diecinueve renglones. */
    assert.equal((ops.match(/<option/g) || []).length, 3,
      'el selector no agrupó por artículo: ' + ops);
    assert.match(ops, /50\/55/);
    assert.match(ops, /IFCO/);
    // Con el DÍA, que es con lo que se elige, y sin el lote, que lo decide el
    // sistema. Andy: «es más importante el día de proceso que el lote».
    assert.match(ops, /desde el \d\d\/\d\d/, 'el renglón no dice desde cuándo está');
    assert.ok(!ops.includes('Cuadro 3'), 'el renglón por artículo nombra un lote');

    // Se mueven tres montones distintos al mismo pallet.
    for (let i = 1; i <= 3; i++) {
      dom.nodos['gal-arm-item'].value = String(i - 1);
      dom.nodos['gal-arm-cant'].value = '10';
      await p.galArmMover();
    }
    assert.match(dom.nodos['gal-arm-lineas'].innerHTML, /MIXTO/,
      'tres artículos distintos y no dice mixto');

    // Y EL STOCK NO SE MOVIÓ: es la invariante del módulo.
    const stockDespues = (await (await s.pegar('/stock')).json()).stock.kilos;
    assert.equal(stockDespues, stockAntes, 'armar el pallet movió el stock');

    // Al cerrarlo queda el número a la vista y la ventana NO se cierra.
    await p.galArmCerrarPallet();
    assert.match(dom.nodos['gal-arm-rep'].innerHTML, /PC-\d\d-\d{5}/,
      'el número del pallet no quedó a la vista');
    assert.match(dom.nodos['gal-arm-rep'].innerHTML, /MIXTO/);
    assert.equal((await (await s.pegar('/stock')).json()).stock.kilos, stockAntes);
  } finally { s.cerrar(); }
});

t('UN PALLET CERRADO NO APARECE EN EL SELECTOR, y la pantalla dice por qué', async () => {
  /* Andy, 5/11/2026: «al momento de armar un pallet tiene que estar disponible
     solo lo que está SIN PALLET... sino va a quedar duplicado».

     Hasta la V1145 esto se podía y la pantalla avisaba DESPUÉS, con el pallet ya
     distinto de su tarjetón. El aviso era el parche; acá se saca la causa — y
     hace falta decir dónde está la mercadería, o la lista vacía se lee como
     mercadería perdida. */
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 100, uuid: 'u1' }));
    const abierto = (await (await s.pegar('/pallets')).json()).abierto;
    await s.pegar('/pallets/' + abierto.id + '/cerrar', json({}));

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galArmAbrir();
    const ops = dom.nodos['gal-arm-item'].innerHTML;
    assert.equal((ops.match(/<option value="\d/g) || []).length, 0,
      'ofrece cajas que están apiladas: ' + ops);
    assert.match(ops, /No hay nada fuera de pallets cerrados/,
      'el selector vacío no dice nada');
    const enp = dom.nodos['gal-arm-enp'].innerHTML;
    assert.match(enp, /100/, 'no dice cuántas cajas hay apiladas: ' + enp);
    assert.match(enp, /1 pallet cerrado/, 'no dice en cuántos pallets están');
    assert.match(enp, /entero/, 'no explica por qué no se ofrecen');
    assert.match(enp, /reabre/, 'no dice cómo se usan esas cajas');
  } finally { s.cerrar(); }
});

t('Y DESARMARLO DESDE LA PANTALLA LO DEVUELVE AL SELECTOR', async () => {
  // El camino honesto, entero y por la API: reabrir, sacar el renglón, y la
  // mercadería vuelve al piso lista para apilarse en otro.
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 40, uuid: 'u1' }));
    const abierto = (await (await s.pegar('/pallets')).json()).abierto;
    await s.pegar('/pallets/' + abierto.id + '/cerrar', json({}));
    const antes = (await (await s.pegar('/stock')).json()).stock.kilos;

    await alPiso(s, db);
    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galArmAbrir();
    assert.match(dom.nodos['gal-arm-item'].innerHTML, /40 cj/,
      'lo desarmado no volvió al selector');
    assert.equal(dom.nodos['gal-arm-enp'].innerHTML, '',
      'sigue diciendo que hay cajas apiladas');
    dom.nodos['gal-arm-item'].value = '0';
    dom.nodos['gal-arm-cant'].value = '40';
    await p.galArmMover();
    assert.match(dom.nodos['gal-arm-lineas'].innerHTML, />40</);
    assert.equal((await (await s.pegar('/stock')).json()).stock.kilos, antes,
      'desarmar y rearmar movió el stock');
  } finally { s.cerrar(); }
});

t('mover de más avisa en la pantalla y no guarda nada', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 40, uuid: 'u1' }));
    await alPiso(s, db);

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galArmAbrir();
    dom.nodos['gal-arm-item'].value = '0';
    dom.nodos['gal-arm-cant'].value = '41';
    await p.galArmMover();
    assert.match(dom.nodos['gst-aviso'].innerHTML, /40/,
      'el tope no llegó a la pantalla');
    assert.match(dom.nodos['gal-arm-lineas'].innerHTML, /Todavía no le pusiste/);
  } finally { s.cerrar(); }
});

t('el selector NO ofrece el pallet que se está armando', async () => {
  /* Sale gratis desde la V1146: lo que entró al pallet dejó de estar suelto, así
     que el corte del piso ya no lo trae. Antes había que descontarlo a mano en
     la pantalla, y ese descuento era una resta que podía quedar en negativo. */
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 100, uuid: 'u1' }));
    await alPiso(s, db);

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galArmAbrir();
    dom.nodos['gal-arm-item'].value = '0';
    dom.nodos['gal-arm-cant'].value = '40';
    await p.galArmMover();
    // Ahora hay 40 en este pallet y 60 en el piso: sólo tiene que ofrecer 60.
    const ops = [...dom.nodos['gal-arm-item'].innerHTML.matchAll(/<option value="\d/g)];
    assert.equal(ops.length, 1, 'se ofrece a sí mismo');
    assert.match(dom.nodos['gal-arm-item'].innerHTML, /60 cj/);
  } finally { s.cerrar(); }
});

t('EL INTERRUPTOR VUELVE AL DETALLE POR LOTE', async () => {
  // El camino normal es por artículo, pero el RENSPA de un remito sale del lote,
  // así que a veces hay que nombrarlo. Son dos cortes del mismo piso y el
  // interruptor es lo único que los separa.
  const db = base();
  db.exec("INSERT INTO pa_lotes (id,nombre,sector_id,finca,activo) "
    + "VALUES (11,'Cuadro 4',1,'La Esperanza',1)");
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      categoria: 'I', calibre: '50/55' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 60, uuid: 'u1' }));
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 11,
      presentacion_id: a.id, bultos: 40, uuid: 'u2' }));
    await alPiso(s, db);

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galArmAbrir();
    // Por artículo: UN renglón con las 100.
    assert.equal((dom.nodos['gal-arm-item'].innerHTML.match(/<option/g) || []).length, 2);
    assert.match(dom.nodos['gal-arm-item'].innerHTML, /100 cj/);

    // Con el interruptor: DOS renglones, cada uno con su lote.
    dom.nodos['gal-arm-detalle'].checked = true;
    p.galArmPintar();
    const ops = dom.nodos['gal-arm-item'].innerHTML;
    assert.equal((ops.match(/<option/g) || []).length, 3, 'no volvió al detalle');
    assert.match(ops, /Cuadro 3/);
    assert.match(ops, /Cuadro 4/);
    assert.ok(!/suelto/.test(ops),
      'el renglón sigue diciendo la ubicación, que ahora es siempre la misma');

    // Y moviendo de ahí sale de ESE lote y de ninguno más. El lote se verifica
    // en la base y no en la tabla: la tabla ya no lo muestra, porque Andy
    // (2/11/2026) pidió «me interesa fecha de proceso pero no lote».
    dom.nodos['gal-arm-item'].value = '1';
    dom.nodos['gal-arm-cant'].value = '40';
    await p.galArmMover();
    const lotes = db.prepare(
      " SELECT DISTINCT lote_id FROM gal_procesos"
      + "  WHERE pallet_id = (SELECT id FROM gal_pallets WHERE origen = 'armado')"
      + "    AND eliminado_en IS NULL AND tipo = 'ingreso'").all().map((r) => r.lote_id);
    assert.deepEqual(lotes, [11], 'tomó de un lote que no se nombró');
    // Y la tabla muestra el DÍA, no el lote.
    const l = dom.nodos['gal-arm-lineas'].innerHTML;
    assert.match(l, /<th>Día de proceso<\/th>/);
    assert.ok(!l.includes('Cuadro 4'), 'la tabla del pallet sigue nombrando el lote');
  } finally { s.cerrar(); }
});

t('EL RENGLÓN DICE DE DÓNDE VA A SALIR antes de apretar', async () => {
  // Con el sistema eligiendo, el que arma no sabe qué lotes ni qué días se va
  // a llevar — y es lo que va a mirar si algo no cuadra. Se dice antes, no
  // después.
  const db = base();
  db.exec("INSERT INTO pa_lotes (id,nombre,sector_id,finca,activo) "
    + "VALUES (11,'Cuadro 4',1,'La Esperanza',1)");
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      categoria: 'I', calibre: '50/55' }))).json();
    await s.pegar('/procesos', json({ fecha: '2026-12-10', lote_id: 10,
      presentacion_id: a.id, bultos: 30, uuid: 'u1' }));
    const uno = (await (await s.pegar('/pallets')).json()).abierto;
    await s.pegar('/pallets/' + uno.id + '/cerrar', json({}));
    await s.pegar('/procesos', json({ fecha: '2026-12-14', lote_id: 11,
      presentacion_id: a.id, bultos: 50, uuid: 'u2' }));
    await alPiso(s, db);

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galArmAbrir();
    dom.nodos['gal-arm-item'].value = '0';
    p.galArmItemPick();
    const d = dom.nodos['gal-arm-disp'].innerHTML;
    assert.match(d, /2 lotes/, 'no dice de cuántos lotes sale');
    assert.match(d, /más viejo primero/);
    assert.match(d, /10\/12/, 'no dice el día del más viejo');
    // Y de qué LOTE, que es lo que queda por decir: la ubicación ya es siempre
    // el piso, así que repetirla en cada renglón era ruido.
    assert.match(d, /Cuadro 3/, 'no dice de qué lote sale el más viejo: ' + d);
    assert.ok(!/CERRADOS/.test(d), 'sigue avisando que va a desarmar un pallet');
  } finally { s.cerrar(); }
});

t('EL REPARTO NO DESARMA NINGÚN PALLET, y lo dice antes de apretar', async () => {
  /* Era el caso más feo del modelo viejo: pedir 45 cajas sin decir de dónde
     desarmaba DOS pallets cerrados de una, y los dos quedaban con su tarjetón
     impreso diciendo otra cosa. Se avisaba después; ahora no pasa. */
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      categoria: 'I' }))).json();
    for (const [f, u] of [['2026-12-10', 'u1'], ['2026-12-14', 'u2']]) {
      await s.pegar('/procesos', json({ fecha: f, lote_id: 10,
        presentacion_id: a.id, bultos: 30, uuid: u }));
      const ab = (await (await s.pegar('/pallets')).json()).abierto;
      await s.pegar('/pallets/' + ab.id + '/cerrar', json({}));
    }

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galArmAbrir();
    // No hay nada que elegir: las 60 cajas están en los dos pallets cerrados.
    assert.equal((dom.nodos['gal-arm-item'].innerHTML.match(/<option value="\d/g)
      || []).length, 0, 'ofrece repartir entre dos pallets cerrados');
    assert.match(dom.nodos['gal-arm-enp'].innerHTML, /2 pallets/,
      'no dice en cuántos pallets está: ' + dom.nodos['gal-arm-enp'].innerHTML);
    // Y los dos siguen enteros, con su tarjetón diciendo la verdad.
    for (const q of db.prepare("SELECT id FROM gal_pallets WHERE estado = 'cerrado'")
      .all()) {
      assert.equal(db.prepare('SELECT COALESCE(SUM(bultos),0) AS b FROM gal_procesos'
        + ' WHERE pallet_id = ? AND eliminado_en IS NULL').get(q.id).b, 30);
    }
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · EL DÍA, NO EL LOTE — Y BORRAR LO QUE SE EMPEZÓ
// ══════════════════════════════════════════════════════════════════════════
t('EL CARTEL DE CERRADO SE APAGA AL REABRIR', async () => {
  // Andy, 2/11/2026, mandó la captura: el cartel decía «Pallet PC-26-00001
  // cerrado» y al lado el botón decía «Cerrar el pallet», con la lista de
  // atrás diciendo ABIERTO. Se pintaba al cerrar y no se escondía nunca, así
  // que sobrevivía a la reapertura: la pantalla afirmando dos cosas opuestas,
  // y la que se lee primero es la equivocada.
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 40, uuid: 'u1' }));
    await alPiso(s, db);

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galArmAbrir();
    dom.nodos['gal-arm-item'].value = '0';
    dom.nodos['gal-arm-cant'].value = '40';
    await p.galArmMover();
    await p.galArmCerrarPallet();

    // Cerrado: el cartel se ve y el botón de cerrar no.
    assert.notEqual(dom.nodos['gal-arm-rep'].style.display, 'none');
    assert.match(dom.nodos['gal-arm-rep'].innerHTML, /cerrado/);
    assert.equal(dom.nodos['gal-arm-cerrarp'].style.display, 'none');

    await p.galArmReabrir();
    // Abierto: el cartel SE APAGA y vuelve el botón. No pueden verse los dos.
    assert.equal(dom.nodos['gal-arm-rep'].style.display, 'none',
      'el cartel de cerrado sobrevivió a la reapertura');
    assert.notEqual(dom.nodos['gal-arm-cerrarp'].style.display, 'none');
  } finally { s.cerrar(); }
});

t('LA TABLA DEL PALLET MUESTRA EL DÍA Y NO REPITE EL ARTÍCULO', async () => {
  // Andy, 2/11/2026: «me seguís poniendo muchas cosas del LOTE, me interesa
  // fecha de proceso pero no lote». Lo que vio: tres renglones de «Carton
  // Amarilla 10 × 700 g» para 49 cajas del mismo artículo, y la única columna
  // que los distinguía era el lote.
  const db = base();
  db.exec("INSERT INTO pa_lotes (id,nombre,sector_id,finca,activo) "
    + "VALUES (11,'Cuadro 4',1,'La Esperanza',1), (12,'Damasco',1,'El Abuelo',1)");
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Carton Amarilla',
      destino: 'comercial', envase: 'Caja', por_bulto: 1, kg_unidad: 7.7,
      categoria: 'I' }))).json();
    for (const [lote, n, u] of [[10, 28, 'u1'], [11, 2, 'u2'], [12, 19, 'u3']]) {
      await s.pegar('/procesos', json({ fecha: HOY, lote_id: lote,
        presentacion_id: a.id, bultos: n, uuid: u }));
    }
    await alPiso(s, db);

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galArmAbrir();
    dom.nodos['gal-arm-item'].value = '0';
    dom.nodos['gal-arm-cant'].value = '49';
    await p.galArmMover();

    const l = dom.nodos['gal-arm-lineas'].innerHTML;
    // UN renglón, no tres: es el mismo artículo del mismo día.
    assert.equal((l.match(/<tr><td>/g) || []).length, 1,
      'repitió el artículo una vez por lote: ' + l);
    assert.match(l, /<th>Día de proceso<\/th>/, 'la columna sigue siendo el lote');
    assert.ok(!/Cuadro 4|Damasco/.test(l), 'la tabla nombra lotes');
    assert.match(l, />49</, 'no sumó las tres cargas');
  } finally { s.cerrar(); }
});

t('DOS DÍAS DEL MISMO ARTÍCULO SON DOS RENGLONES', async () => {
  // El día sí separa: la antigüedad es lo que se mira para decidir qué sale
  // primero, así que juntarlos escondería justo el dato que importa.
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: '2026-12-10', lote_id: 10,
      presentacion_id: a.id, bultos: 30, uuid: 'u1' }));
    await s.pegar('/procesos', json({ fecha: '2026-12-14', lote_id: 10,
      presentacion_id: a.id, bultos: 20, uuid: 'u2' }));
    await alPiso(s, db);

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galArmAbrir();
    dom.nodos['gal-arm-item'].value = '0';
    dom.nodos['gal-arm-cant'].value = '50';
    await p.galArmMover();

    const l = dom.nodos['gal-arm-lineas'].innerHTML;
    assert.equal((l.match(/<tr><td>/g) || []).length, 2,
      'juntó dos días en un renglón');
    /* EN ORDEN, lo más viejo arriba: la tabla es lo que se mira para decidir
       qué sale primero, y verificar sólo que los dos días APAREZCAN pasa
       igual con la lista dada vuelta. */
    const dias = [...l.matchAll(/<tr><td>(\d\d\/\d\d)</g)].map((m) => m[1]);
    assert.deepEqual(dias, ['10/12', '14/12'],
      'los días no salen con el más viejo arriba');
  } finally { s.cerrar(); }
});

t('SACAR UN RENGLÓN SACA TODAS SUS FILAS', async () => {
  // El renglón agrupa varias cargas: en pantalla se ve como uno, así que
  // dejar la mitad adentro sería un renglón que no se puede sacar.
  const db = base();
  db.exec("INSERT INTO pa_lotes (id,nombre,sector_id,finca,activo) "
    + "VALUES (11,'Cuadro 4',1,'La Esperanza',1)");
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 30, uuid: 'u1' }));
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 11,
      presentacion_id: a.id, bultos: 20, uuid: 'u2' }));
    await alPiso(s, db);

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galArmAbrir();
    dom.nodos['gal-arm-item'].value = '0';
    dom.nodos['gal-arm-cant'].value = '50';
    await p.galArmMover();
    assert.equal((dom.nodos['gal-arm-lineas'].innerHTML.match(/<tr><td>/g) || []).length, 1);

    // El × del único renglón saca las DOS filas que lo componen.
    const m = /galArmSacar\('([^']+)'\)/.exec(dom.nodos['gal-arm-lineas'].innerHTML);
    assert.ok(m, 'el renglón no ofrece sacarse');
    assert.equal(m[1].split(',').length, 2, 'el botón saca una sola de las dos filas');
    await p.galArmSacar(m[1]);
    assert.match(dom.nodos['gal-arm-lineas'].innerHTML, /Todavía no le pusiste/,
      'quedó media carga adentro');
  } finally { s.cerrar(); }
});

t('UN PALLET VACÍO SE PUEDE BORRAR; uno con cajas no lo ofrece', async () => {
  // Andy, 2/11/2026: «ahí me tenés que dejar eliminar los pallets que empecé a
  // armar». Le quedaron cuatro «sin número» vacíos de probar y no había cómo
  // sacarlos.
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 40, uuid: 'u1' }));
    await alPiso(s, db);

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galArmAbrir();            // uno con cajas
    dom.nodos['gal-arm-item'].value = '0';
    dom.nodos['gal-arm-cant'].value = '40';
    await p.galArmMover();
    await p.galArmAbrir();            // y dos vacíos
    await p.galArmAbrir();
    await p.galArmCerrar();

    const lista = dom.nodos['gst-arm'].innerHTML;
    // Los vacíos ofrecen el ×, el que tiene cajas no.
    assert.equal((lista.match(/galArmBorrar\(/g) || []).length, 2,
      'no ofrece borrar los vacíos, u ofrece borrar el que tiene cajas');
    // Tres pallets en la lista y dos botones de borrar: el que tiene cajas no
    // lo ofrece. Sin este conteo, el de arriba pasaría con cualquier lista.
    assert.equal((lista.match(/galArmAbrir\(/g) || []).length, 3,
      'no hay tres pallets en la lista');

    // Y borrar uno lo saca de la lista.
    const id = /galArmBorrar\((\d+)\)/.exec(lista)[1];
    await p.galArmBorrar(Number(id));
    assert.equal((dom.nodos['gst-arm'].innerHTML.match(/galArmBorrar\(/g) || []).length, 1);
    assert.equal(dom.nodos['gst-aviso'].innerHTML, '');
  } finally { s.cerrar(); }
});


t('LA LISTA ES LA DE LA CÁMARA: el del proceso también está, y marcado', async () => {
  /* Desde la V1146 a un pallet no se le sacan cajas desde afuera, así que la
     única manera de desarmar uno del proceso es abrirlo — y si la lista de Stock
     muestra sólo los armados, no hay desde dónde. Pero hay que poder
     distinguirlos: el del proceso se llena solo con cada caja que se tipea. */
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      categoria: 'I' }))).json();
    const r = await (await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 40, uuid: 'u1' }))).json();
    await s.pegar('/armado', json({ fecha: HOY }));
    /* Y el del proceso se deja VACÍO, bajando su carga al piso. Es la única
       manera de que los dos pallets estén en la misma condición —vacíos y
       abiertos— y que lo único que los distinga sea de dónde salieron. Con
       cajas adentro, el × no se ofrece por tener cajas y no por ser del
       proceso, y el test pasaría por la razón equivocada. */
    await s.pegar('/pallets/sacar/' + r.id, json({}));

    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galArmCargar();
    const lista = dom.nodos['gst-arm'].innerHTML;
    assert.equal((lista.match(/galArmAbrir\(/g) || []).length, 2,
      'falta el pallet del proceso en la lista de la cámara: ' + lista);
    assert.equal((lista.match(/del proceso/g) || []).length, 1,
      'no se distingue cuál es el del proceso');
    /* Y al del proceso no se le ofrece el ×, aunque esté igual de vacío que el
       armado, que sí lo ofrece: el del día lo abre solo la primera caja de la
       mañana, así que borrarlo es apretar un botón para que vuelva. */
    assert.equal((lista.match(/galArmBorrar\(/g) || []).length, 1,
      'ofrece borrar el pallet del proceso, o no ofrece borrar el armado vacío');
  } finally { s.cerrar(); }
});

t('el pallet con cajas adentro NO se borra, y lo dice', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  try {
    const a = await (await s.pegar('/presentaciones', json({ nombre: 'Caja',
      destino: 'comercial', envase: 'x', por_bulto: 1, kg_unidad: 8,
      categoria: 'I' }))).json();
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10,
      presentacion_id: a.id, bultos: 40, uuid: 'u1' }));
    await alPiso(s, db);
    const arm = await (await s.pegar('/armado', json({ fecha: HOY }))).json();
    await s.pegar('/armado/' + arm.id + '/mover', json({ destino: 'comercial',
      presentacion_id: a.id, calibre: '', bultos: 40 }));

    const r = await s.pegar('/pallets/' + arm.id, { method: 'DELETE' });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /cargas adentro/);
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 8 · LO QUE LA OFICINA VE DE LA CULATA (V1150)
// ══════════════════════════════════════════════════════════════════════════
// La app del cargador escribe; la oficina lee acá, antes de emitir. Todo por la
// API: los pallets se cargan y se cierran como en Proceso, el despacho se arma
// como en esta pantalla, y se escanea como en la culata.
async function camionArmado(s) {
  const a = await (await s.pegar('/presentaciones', json({ nombre: 'Carton Amarilla',
    destino: 'comercial', envase: 'Caja', por_bulto: 1, kg_unidad: 7, calibre: '35-55',
    categoria: 'I' }))).json();
  const pal = [];
  for (let i = 0; i < 3; i++) {
    await s.pegar('/procesos', json({ fecha: HOY, lote_id: 10, presentacion_id: a.id,
      bultos: 40 + i, uuid: 'cu' + i }));
    const ab = (await (await s.pegar('/pallets')).json()).abierto;
    const c = await (await s.pegar('/pallets/' + ab.id + '/cerrar', json({}))).json();
    pal.push({ id: ab.id, numero: c.numero });
  }
  const d = (await (await s.pegar('/despachos', json({ fecha: HOY }))).json()).despacho;
  await s.pegar('/despachos/' + d.id + '/pallets', json({ pallet_id: pal[0].id }));
  await s.pegar('/despachos/' + d.id + '/pallets', json({ pallet_id: pal[1].id }));
  return { d: d.id, pal };
}
const escanear = (s, d, numero, agregar) =>
  s.pegar('/camion/' + d + '/escanear', json({ numero, agregar: agregar ? 1 : 0 }));

t('LA LISTA DE DESPACHOS DICE CÓMO VA EL CAMIÓN', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const { d, pal } = await camionArmado(s);
    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    assert.match(dom.nodos['gst-desp'].innerHTML, /sin escanear/);

    await escanear(s, d, pal[0].numero);
    await p.galStCargar();
    assert.match(dom.nodos['gst-desp'].innerHTML, /1\/2 subidos/);

    await s.pegar('/camion/' + d + '/cargado', json({ confirmar: 1 }));
    await p.galStCargar();
    const h = dom.nodos['gst-desp'].innerHTML;
    assert.match(h, /✅ <b>Cargado<\/b> 1\/2 · Andy/);
    assert.match(h, /faltaron 1/, 'no dice que salió con un pallet de menos');
    // Y el título, sin HTML, nombra cuál.
    assert.ok(h.includes('salió sin ' + pal[1].numero), 'el título no nombra el que faltó');
  } finally { s.cerrar(); }
});

t('LA LISTA TIENE TANTOS <col> COMO <th>, y suman 100', async () => {
  // Sin barra de desplazamiento lateral (CLAUDE.md): la columna nueva le saca ancho a
  // otras, no se suma por encima.
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    await camionArmado(s);
    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    const h = dom.nodos['gst-desp'].innerHTML;
    const cols = [...h.matchAll(/<col style="width:(\d+)%">/g)].map((m) => Number(m[1]));
    const ths = (h.slice(0, h.indexOf('</thead>')).match(/<th[\s>]/g) || []).length;
    assert.equal(cols.length, ths);
    assert.equal(cols.reduce((x, y) => x + y, 0), 100);
  } finally { s.cerrar(); }
});

t('ADENTRO DEL DESPACHO: ✓ en los que subieron, y lo que faltó con número', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const { d, pal } = await camionArmado(s);
    await escanear(s, d, pal[0].numero);
    await s.pegar('/camion/' + d + '/cargado', json({ confirmar: 1 }));
    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galDspAbrir(d);
    const h = dom.nodos['gal-dsp-items'].innerHTML;
    // La ✓ va pegada al número del que subió, y NO al otro.
    const subio = new RegExp('✓</span> 📦 <b>' + pal[0].numero);
    assert.match(h, subio, 'el que subió no tiene la ✓');
    assert.ok(!new RegExp('✓</span> 📦 <b>' + pal[1].numero).test(h),
      'el que no subió tiene la ✓');
    assert.match(h, /Salió sin: <b>/);
    assert.ok(h.includes(pal[1].numero));
  } finally { s.cerrar(); }
});

t('EL REGISTRO DE LA CULATA: cada lectura, y lo que no iba en rojo', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const { d, pal } = await camionArmado(s);
    await escanear(s, d, pal[0].numero);
    await escanear(s, d, pal[2].numero);            // no va: no se sube
    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galDspAbrir(d);
    const h = dom.nodos['gal-dsp-culata'].innerHTML;
    assert.match(h, /2 lecturas/);
    assert.match(h, /1 fuera de lo previsto/, 'el título no avisa que hubo algo raro');
    assert.match(h, /<tr style="color:#b91c1c">[^]*NO IBA — no se subió/);
    assert.ok(h.includes(pal[2].numero));
    assert.match(h, /">subió<\/td>/);
    assert.match(h, /<details>/, 'el registro no va plegado');
  } finally { s.cerrar(); }
});

t('ABRIR OTRO DESPACHO NO ARRASTRA EL REGISTRO DEL ANTERIOR', async () => {
  // Un formulario que sólo se esconde conserva lo que tenía.
  const db = base();
  const s = await servidor(db, ADMIN);
  const dom = domFalso();
  try {
    const { d, pal } = await camionArmado(s);
    await escanear(s, d, pal[0].numero);
    const otro = (await (await s.pegar('/despachos', json({ fecha: HOY }))).json()).despacho;
    const p = pantalla(dom, s.pegar);
    await p.galStCargar();
    await p.galDspAbrir(d);
    assert.match(dom.nodos['gal-dsp-culata'].innerHTML, /1 lectura/);
    await p.galDspAbrir(otro.id);
    assert.equal(dom.nodos['gal-dsp-culata'].innerHTML, '',
      'el despacho nuevo muestra las lecturas del anterior');

    /* Y SI EL PEDIDO DEL REGISTRO FALLA, tampoco. Es el caso en que se nota: cuando
       anda, el registro nuevo pisa al viejo igual. Acá el otro despacho se borra
       entre que se cargó la lista y que se abre, y el registro contesta 404. */
    await p.galDspAbrir(d);
    assert.match(dom.nodos['gal-dsp-culata'].innerHTML, /1 lectura/);
    db.prepare("UPDATE gal_despachos SET eliminado_en = '2026-01-01' WHERE id = ?")
      .run(otro.id);
    await p.galDspAbrir(otro.id);
    assert.equal(dom.nodos['gal-dsp-culata'].innerHTML, '',
      'un pedido que falló dejó las lecturas del despacho anterior');
  } finally { s.cerrar(); }
});

t('LA RUTA DEL REGISTRO es de la oficina y dice lo que pasó', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  try {
    const { d, pal } = await camionArmado(s);
    await escanear(s, d, pal[2].numero);
    await escanear(s, d, pal[2].numero, 1);
    const j = await (await s.pegar('/despachos/' + d + '/culata')).json();
    assert.deepEqual(j.registro.map((r) => r.resultado), ['no_va', 'agregado']);
    assert.equal(j.carga.total, 3);
    assert.equal(j.carga.rechazos, 1);
    assert.equal((await s.pegar('/despachos/9999/culata')).status, 404);
  } finally { s.cerrar(); }
});

test('MANUAL ST: «lo que pasó en la culata» es lo que hace la pantalla', () => {
  const i = PANEL.indexOf("SG_MANUAL['galpon-stock']");
  const man = PANEL.slice(i, PANEL.indexOf('\n};', i)).replace(/'\s*\r?\n\s*\+\s*'/g, '');
  assert.match(man, /Lo que pasó en la culata <span class="ver">V1150<\/span>/);
  assert.match(man, /una columna <b>Camión<\/b>/);
  assert.match(PANEL, /'<th>Camión<\/th><th><\/th><\/tr><\/thead><tbody>'/);
  assert.match(man, /cada pallet que subió lleva una <b>✓<\/b>/);
  assert.match(man, /<b>Emitir sigue siendo de acá\.<\/b>/);
});
