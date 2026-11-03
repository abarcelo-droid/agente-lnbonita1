// ══ 📷 GALPÓN · LA RUTA QUE LEE LA PLANILLA ══════════════════════════════
//
// La lógica está al lado, en test/galpon_planilla_ocr.test.mjs. Acá se monta
// el router de verdad y se le pega, con la IA REEMPLAZADA por un doble: lo que
// importa en este archivo no se ve leyendo el código y tampoco hace falta
// gastar un centavo para verlo.
//
//   · que leer NO escriba. Es la regla que sostiene todo: si la lectura
//     guardara, una foto mal leída serían veintiún renglones de kilos
//     inventados en vez de un rato perdido.
//   · que sin clave conteste «cargalo a mano» y no un 500 ni el JSON de
//     facturación de Anthropic en inglés, que es lo que le pasó a Santiago.
//   · que el cerrojo de empresa tape también esta dirección.
//   · que la foto se valide ANTES de gastar una llamada.
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
const HOY = new Date().toLocaleDateString('en-CA');
const BARRA = String.fromCharCode(92);

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sociedades (id INTEGER PRIMARY KEY, nombre TEXT);
    INSERT INTO sociedades (id,nombre) VALUES (7,'Puente Cordón SA'), (9,'San Gerónimo SA');

    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, sector_id INTEGER,
                           finca TEXT, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca,activo) VALUES (10,'Cuadro 3','La Estación',1);
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY, lote_id INTEGER, cultivo TEXT,
                                   campaña TEXT, es_perenne INTEGER DEFAULT 0);
    CREATE TABLE pa_cuadrillas (id INTEGER PRIMARY KEY, nombre TEXT, activo INTEGER DEFAULT 1);
    INSERT INTO pa_cuadrillas (id,nombre,activo) VALUES (1,'Norte',1);
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
      lote_nombre TEXT, producto TEXT, usuario_id INTEGER, usuario TEXT, creado_en TEXT);
    CREATE TABLE gal_volcados (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE,
      fecha TEXT NOT NULL, hora TEXT, lote_id INTEGER NOT NULL, lote_nombre TEXT,
      producto TEXT, cuadrilla_id INTEGER, cuadrilla TEXT,
      kilos REAL NOT NULL, ifcos INTEGER, bruto REAL, tara REAL, tarjeta_id INTEGER,
      viaje INTEGER, sanitario TEXT, origen TEXT NOT NULL DEFAULT 'manual',
      observacion TEXT, estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT,
      usuario_id INTEGER, usuario TEXT, creado_en TEXT, eliminado_en TEXT);
    CREATE TABLE gal_volcado_cuadrillas (
      volcado_id INTEGER NOT NULL, cuadrilla_id INTEGER NOT NULL,
      cuadrilla TEXT, kilos REAL NOT NULL,
      PRIMARY KEY (volcado_id, cuadrilla_id));
    CREATE TABLE gal_lote_datos (lote_id INTEGER PRIMARY KEY, renspa TEXT, variedad TEXT,
      cuartel TEXT, notas TEXT, actualizado TEXT);
    CREATE TABLE gal_presentaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, destino TEXT NOT NULL,
      envase TEXT, por_bulto REAL NOT NULL DEFAULT 1, kg_unidad REAL NOT NULL DEFAULT 1,
      granel INTEGER NOT NULL DEFAULT 0, emoji TEXT, icono TEXT, icono_v TEXT,
      categoria TEXT NOT NULL DEFAULT 'I', calibre TEXT, color TEXT,
      orden INTEGER NOT NULL DEFAULT 100, activo INTEGER NOT NULL DEFAULT 1,
      creado_en TEXT, eliminado_en TEXT);
    CREATE TABLE gal_pallets (id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT UNIQUE,
      estado TEXT NOT NULL DEFAULT 'abierto', parcial INTEGER NOT NULL DEFAULT 0,
      mixto INTEGER NOT NULL DEFAULT 0, fecha_empaque TEXT, bultos REAL, kilos REAL,
      observacion TEXT, abierto_en TEXT, cerrado_en TEXT, usuario_id INTEGER,
      usuario TEXT, eliminado_en TEXT);
    CREATE TABLE gal_procesos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, fecha TEXT NOT NULL,
      lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT, destino TEXT NOT NULL,
      presentacion_id INTEGER, presentacion TEXT, envase TEXT, categoria TEXT,
      calibre TEXT, variedad TEXT, renspa TEXT, cuartel TEXT,
      bultos REAL, por_bulto REAL, kg_unidad REAL, kilos REAL NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'ingreso', reparto TEXT,
      repartido INTEGER NOT NULL DEFAULT 0, pallet_id INTEGER, partido_de INTEGER,
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

/* EL DOBLE DE LA IA. Se escribe un servicios/ia.js de mentira en el temporal con la
   misma firma que el de verdad: el router importa ése y no se entera. Así se prueba
   todo el camino —la foto, el parseo, la respuesta— sin red, sin clave y sin gastar.

   Lo que el doble devuelve lo decide cada test con globalThis.__IA. */
async function servidor(db, usuario, ia) {
  const dir = fs.mkdtempSync(path.join(RAIZ, '.tmp-galpla-'));
  fs.mkdirSync(path.join(dir, 'servicios'));
  fs.mkdirSync(path.join(dir, 'rutas'));
  fs.mkdirSync(path.join(dir, 'config'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/servicios'))) {
    if (f.endsWith('.js')) {
      fs.copyFileSync(path.join(RAIZ, 'src/servicios', f), path.join(dir, 'servicios', f));
    }
  }
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/config'))) {
    if (f.endsWith('.js')) {
      fs.copyFileSync(path.join(RAIZ, 'src/config', f), path.join(dir, 'config', f));
    }
  }
  fs.copyFileSync(path.join(RAIZ, 'src/rutas/galpon.js'), path.join(dir, 'rutas', 'galpon.js'));
  fs.writeFileSync(path.join(dir, 'servicios', 'db.js'),
    'export default globalThis.__GAL_DB; export const getDb = () => globalThis.__GAL_DB;\n'
    + 'export function rehacerTabla(){}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'servicios', 'ia.js'),
    "export const MODELO_CHAT = 'modelo-de-mentira';\n"
    + 'export function hayIA(){ return !!globalThis.__IA.hay; }\n'
    + 'export function motivoFalla(e){\n'
    + "  return { operador: 'La IA no está disponible. Cargalo a mano y avisá a la oficina.',\n"
    + "           admin: String(e && e.message), crudo: String(e && e.message) };\n"
    + '}\n'
    + 'export async function llamarIA(funcion, params, opts){\n'
    + '  globalThis.__IA.llamadas.push({ funcion, params, opts });\n'
    + '  if (globalThis.__IA.tira) throw new Error(globalThis.__IA.tira);\n'
    + "  return { content: [{ type: 'text', text: globalThis.__IA.texto }] };\n"
    + '}\n', 'utf8');

  globalThis.__GAL_DB = db;
  globalThis.__IA = Object.assign({ hay: true, texto: '{"filas":[]}', tira: null, llamadas: [] },
    ia || {});

  const mod = await import('file:///'
    + path.join(dir, 'rutas', 'galpon.js').split(BARRA).join('/'));
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use((req, _res, next) => {
    req.cookies = usuario ? { lnb_user: JSON.stringify(usuario) } : {}; next();
  });
  app.use('/api/galpon', mod.default);
  const srv = await new Promise((ok) => { const x = app.listen(0, () => ok(x)); });
  const u = 'http://127.0.0.1:' + srv.address().port;
  return {
    ia: globalThis.__IA,
    pegar: (ruta, opts) => fetch(u + '/api/galpon' + ruta, opts),
    cerrar: () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const OPERADOR = { id: 2, nombre: 'Juan', rol: 'operador' };
const json = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
                       body: JSON.stringify(b) });
const JPG = 'data:image/jpeg;base64,'
  + Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]).toString('base64');

// Lo que devolvería el modelo leyendo la primera foto del 2/11.
const LECTURA = JSON.stringify({
  fecha: null, cultivo: null,
  filas: [
    { viaje: 13, finca: null, lote: null, numero: 48, kilos: 15.9, sanitario: 'B' },
    { viaje: 14, finca: 'La Estación', lote: null, numero: 1, kilos: 9.7, sanitario: 'B' },
    { viaje: null, finca: null, lote: null, numero: 2, kilos: 15.4, sanitario: null },
  ],
});

// ══════════════════════════════════════════════════════════════════════════
// 1 · LEER NO ESCRIBE
// ══════════════════════════════════════════════════════════════════════════
t('LEER NO CREA NINGUNA CARGA: devuelve una propuesta y nada más', () => {
  /* Es la regla que sostiene todo el diseño. Si la lectura guardara, una foto
     mal leída serían veintiún renglones de kilos inventados en vez de un rato
     perdido — y nadie los encontraría, porque son números creíbles. */
  return (async () => {
    const db = base();
    const s = await servidor(db, OPERADOR, { texto: LECTURA });
    try {
      const r = await s.pegar('/volcados/leer-foto', json({ imagen: JPG }));
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.ok, true);
      assert.equal(j.filas.length, 3);
      // Y el libro quedó intacto.
      assert.equal(db.prepare('SELECT COUNT(*) n FROM gal_volcados').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM gal_volcado_cuadrillas').get().n, 0);
    } finally { s.cerrar(); }
  })();
});

t('la propuesta viene con el ídem resuelto y lista para la pantalla', async () => {
  const s = await servidor(base(), OPERADOR, { texto: LECTURA });
  try {
    const j = await (await s.pegar('/volcados/leer-foto', json({ imagen: JPG }))).json();
    assert.deepEqual(j.filas.map((f) => f.viaje), [13, 14, 14]);
    assert.deepEqual(j.filas.map((f) => f.kilos), [15.9, 9.7, 15.4]);
    assert.deepEqual(j.filas.map((f) => f.sanitario), ['B', 'B', null]);
    assert.ok(j.filas.every((f) => f.ok));
  } finally { s.cerrar(); }
});

t('se le manda la foto y el pedido al modelo, con la función declarada', async () => {
  // La función tiene que estar en FUNCIONES (servicios/ia_costo.js) o el
  // registro de consumo no sabe de quién es el gasto — que es por lo que el
  // 14/10 nadie pudo decir qué se había comido el crédito.
  const s = await servidor(base(), OPERADOR, { texto: LECTURA });
  try {
    await s.pegar('/volcados/leer-foto', json({ imagen: JPG }));
    assert.equal(s.ia.llamadas.length, 1);
    const [l] = s.ia.llamadas;
    assert.equal(l.funcion, 'galpon-leer-planilla');
    const { FUNCIONES } = await import('../src/servicios/ia_costo.js');
    assert.ok(FUNCIONES['galpon-leer-planilla'], 'la función no está declarada en FUNCIONES');
    const partes = l.params.messages[0].content;
    assert.equal(partes[0].type, 'image');
    assert.equal(partes[0].source.media_type, 'image/jpeg');
    assert.match(partes[1].text, /REGISTRO DE CONTROL EN GALPÓN/);
    // Y queda anotado a nombre de quien la pidió.
    assert.equal(l.opts.usuario, 'Juan');
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · CUANDO LA IA NO ESTÁ
// ══════════════════════════════════════════════════════════════════════════
t('SIN CLAVE CONTESTA «cargá a mano», no un 500', async () => {
  /* Y no se gasta una llamada para enterarse. El que está con la planilla en
     la mano necesita saber que puede seguir trabajando, no por qué se cayó. */
  const s = await servidor(base(), OPERADOR, { hay: false });
  try {
    const r = await s.pegar('/volcados/leer-foto', json({ imagen: JPG }));
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.ia_caida, true);
    assert.match(j.error, /a mano/);
    assert.equal(s.ia.llamadas.length, 0, 'intentó llamar igual');
  } finally { s.cerrar(); }
});

t('SI LA IA FALLA, EL ERROR TÉCNICO NO LLEGA A LA PANTALLA', async () => {
  /* Lo que Santiago vio en el teléfono, en inglés, fue el JSON de facturación
     de Anthropic. Eso va al log y a motivo_admin. */
  const s = await servidor(base(), OPERADOR, {
    tira: 'Your credit balance is too low to access the Anthropic API.',
  });
  try {
    const r = await s.pegar('/volcados/leer-foto', json({ imagen: JPG }));
    assert.equal(r.status, 502);
    const j = await r.json();
    assert.equal(j.ia_caida, true);
    assert.ok(!/credit balance/i.test(j.error), 'le mostró el error de facturación al operador');
    assert.match(j.error, /a mano/);
    assert.match(j.motivo_admin, /credit balance/i);
  } finally { s.cerrar(); }
});

t('una respuesta que no es JSON se contesta como «no se pudo leer»', async () => {
  const s = await servidor(base(), OPERADOR, { texto: 'No pude leer la foto, perdón.' });
  try {
    const r = await s.pegar('/volcados/leer-foto', json({ imagen: JPG }));
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /No se reconoció|no devolvió nada/);
  } finally { s.cerrar(); }
});

t('y una planilla sin filas dice qué hacer con la foto', async () => {
  const s = await servidor(base(), OPERADOR, { texto: '{"filas":[]}' });
  try {
    const j = await (await s.pegar('/volcados/leer-foto', json({ imagen: JPG }))).json();
    assert.equal(j.ok, false);
    assert.match(j.error, /más derecha|mejor luz/);
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LA FOTO SE MIRA ANTES DE GASTAR UNA LLAMADA
// ══════════════════════════════════════════════════════════════════════════
t('LO QUE NO ES UNA FOTO NO LLEGA AL MODELO', async () => {
  // Cada llamada cuesta. Mandar un PDF o un texto para que conteste que no
  // puede es pagar por enterarse de algo que se sabe mirando el encabezado.
  const s = await servidor(base(), OPERADOR, { texto: LECTURA });
  try {
    for (const mala of ['', 'hola', 'data:text/plain;base64,aG9sYQ==',
                        'data:image/svg+xml;base64,PHN2Zy8+']) {
      const r = await s.pegar('/volcados/leer-foto', json({ imagen: mala }));
      assert.equal(r.status, 400, JSON.stringify(mala) + ' pasó');
    }
    assert.equal(s.ia.llamadas.length, 0, 'gastó llamadas con archivos que no son fotos');
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · QUIÉN PUEDE
// ══════════════════════════════════════════════════════════════════════════
t('sin sesión no lee nada', async () => {
  const s = await servidor(base(), null, { texto: LECTURA });
  try {
    assert.equal((await s.pegar('/volcados/leer-foto', json({ imagen: JPG }))).status, 401);
    assert.equal(s.ia.llamadas.length, 0);
  } finally { s.cerrar(); }
});

t('UN OPERADOR SÍ: leer la planilla es el trabajo del día, no parametrizar', async () => {
  const s = await servidor(base(), OPERADOR, { texto: LECTURA });
  try {
    assert.equal((await s.pegar('/volcados/leer-foto', json({ imagen: JPG }))).status, 200);
  } finally { s.cerrar(); }
});

t('EL CERROJO DE EMPRESA TAPA TAMBIÉN ESTA DIRECCIÓN', async () => {
  // El galpón es de Puente Cordón. Parado en San Gerónimo no se lee nada de acá
  // — y tampoco se gasta una llamada.
  const s = await servidor(base(), { id: 1, nombre: 'Andy', rol: 'admin' }, { texto: LECTURA });
  try {
    const r = await s.pegar('/volcados/leer-foto?sociedad_id=9', json({ imagen: JPG }));
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /Puente Cord/);
    assert.equal(s.ia.llamadas.length, 0);
  } finally { s.cerrar(); }
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LA DIRECCIÓN NO SE COME A OTRA
// ══════════════════════════════════════════════════════════════════════════
t('POST /volcados/leer-foto NO ENTRA POR POST /volcados', async () => {
  /* Express se queda con la primera que matchea. Si ésta quedara después de
     una ruta con parámetro, la foto entraría como si fuera una carga y
     devolvería «Falta elegir el lote» — sin un solo error en el log. */
  const s = await servidor(base(), OPERADOR, { texto: LECTURA });
  try {
    const j = await (await s.pegar('/volcados/leer-foto', json({ imagen: JPG }))).json();
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.filas));
  } finally { s.cerrar(); }
});

t('y las cargas se siguen creando por el POST de siempre, una por fila', async () => {
  /* La pantalla manda las filas por /volcados, que es el mismo camino que una
     carga tipeada a mano: la misma validación, el mismo tope de kilos y la
     misma cola sin señal. No hay un endpoint que las cree todas de golpe. */
  const db = base();
  const s = await servidor(db, OPERADOR, { texto: LECTURA });
  try {
    const j = await (await s.pegar('/volcados/leer-foto', json({ imagen: JPG }))).json();
    for (const f of j.filas) {
      const r = await s.pegar('/volcados', json({
        uuid: 'u-' + f.numero, fecha: HOY, lote_id: 10, kilos: f.kilos,
        ifcos: 1, viaje: f.viaje, sanitario: f.sanitario, cuadrilla_ids: [1],
      }));
      assert.equal(r.status, 200);
    }
    const d = await (await s.pegar('/volcados?fecha=' + HOY)).json();
    assert.equal(d.resumen.cargas, 3);
    assert.equal(d.resumen.kilos, 41);
    assert.equal(d.resumen.ifcos, 3);
    // Y el uuid hace que repetir el mismo envío no duplique.
    await s.pegar('/volcados', json({ uuid: 'u-48', fecha: HOY, lote_id: 10, kilos: 15.9 }));
    assert.equal((await (await s.pegar('/volcados?fecha=' + HOY)).json()).resumen.cargas, 3);
  } finally { s.cerrar(); }
});
