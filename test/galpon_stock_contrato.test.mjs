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
    CREATE TABLE gal_volcados (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE,
      fecha TEXT NOT NULL, hora TEXT, lote_id INTEGER NOT NULL, lote_nombre TEXT,
      producto TEXT, cuadrilla_id INTEGER, cuadrilla TEXT, kilos REAL NOT NULL,
      ifcos INTEGER, bruto REAL, tara REAL, tarjeta_id INTEGER,
      origen TEXT NOT NULL DEFAULT 'manual', observacion TEXT,
      estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT, usuario_id INTEGER,
      usuario TEXT, creado_en TEXT, eliminado_en TEXT);
    CREATE TABLE gal_lote_datos (lote_id INTEGER PRIMARY KEY, renspa TEXT, variedad TEXT,
      cuartel TEXT, notas TEXT, actualizado TEXT);
    CREATE TABLE gal_presentaciones (id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL, destino TEXT NOT NULL, envase TEXT,
      por_bulto REAL NOT NULL DEFAULT 1, kg_unidad REAL NOT NULL DEFAULT 1,
      granel INTEGER NOT NULL DEFAULT 0, emoji TEXT, categoria TEXT NOT NULL DEFAULT 'I',
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
      repartido INTEGER NOT NULL DEFAULT 0, pallet_id INTEGER, despacho_id INTEGER,
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
    'gal-dsp-rem', 'gal-dsp-obs']) nodos[id] = crear(id);
  return { nodos, document: { getElementById: (id) => nodos[id] || null } };
}

// El bloque de JS de la pantalla, sacado de panel.html y ejecutado de verdad.
function pantalla(dom, pegar) {
  const i = PANEL.indexOf('var GST = { datos:null');
  assert.ok(i > 0, 'no encontré el bloque GST en panel.html');
  const fin = PANEL.indexOf('function galStInit(){', i);
  assert.ok(fin > i, 'no encontré el final del bloque GST');
  const codigo = PANEL.slice(i, fin);
  // Las dos cosas del navegador que el bloque usa: fetch contra el router de
  // verdad, y document contra el DOM de mentira.
  const f = new Function('document', 'fetch', 'confirm', 'prompt', 'window',
    'sgModalArriba',
    codigo + '\nreturn { GST, galStCargar, galStPintar, galDspAbrir, galDspPintar,'
    + ' galDspItems, galDspAgregar, galDspItemPick, galDspEmitir };');
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
    for (const k of ['hoy', 'destinos', 'stock', 'lotes', 'disponible', 'despachos']) {
      assert.ok(k in j, 'falta ' + k + ' en la respuesta de /stock');
    }
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
    assert.match(dom.nodos['gst-stock'].innerHTML,
      /<span class="gst-emo" aria-hidden="true">📦<\/span>/);
  } finally { s.cerrar(); }
});
