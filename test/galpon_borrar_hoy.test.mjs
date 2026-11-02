// ══ 🗑️ GALPÓN · BORRAR LO DEL DÍA LO PUEDE CUALQUIERA ════════════════════
//
// Andy, 2/11/2026: «necesito que todos los usuarios puedan borrar algo del día
// vigente (fecha día hoy)».
//
// Un renglón de kilos tipeado hace diez segundos con un cero de más es un error
// de tipeo, no una anulación. Con nivel «anular» de por medio, el operario va a
// buscar al dueño y mientras tanto el renglón mal queda cargado.
//
// ── LA DECISIÓN ESTÁ ESCRITA EN DOS ARCHIVOS Y TIENEN QUE ESTAR LOS DOS ───
// permisos.js afloja el NIVEL para esa dirección; la ruta verifica que la fila
// sea de HOY. Falta una de las dos mitades y el agujero no se ve igual:
//
//   · sin la lista de permisos.js  → un operador no puede borrar nada, ni lo de
//     hoy. Eso se nota: alguien se queja el primer día.
//   · sin el control de la fecha    → cualquiera con nivel «operar» borra la
//     temporada pasada. Eso NO se nota: nadie prueba borrar algo de marzo.
//
// Por eso acá se levanta la CADENA COMPLETA —exigirNivel delante del router,
// como en index.js— y no las dos mitades por separado: probada cada una sola,
// las dos pasan y el agujero del medio queda igual.
//
// -- SIN node_modules ESTE ARCHIVO SE SALTEA ENTERO, NO SE CAE -------------
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { borrarVolcado, borrarVolcados, registrarVolcado, resumenDelDia }
  from '../src/servicios/galpon.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HOY = new Date().toLocaleDateString('en-CA');
const AYER = (() => { const d = new Date(); d.setDate(d.getDate() - 1);
                      return d.toLocaleDateString('en-CA'); })();

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sociedades (id INTEGER PRIMARY KEY, nombre TEXT, activa INTEGER DEFAULT 1);
    INSERT INTO sociedades (id,nombre,activa) VALUES (7,'Puente Cordón SA',1), (9,'San Gerónimo SA',1);

    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, sector_id INTEGER,
                           finca TEXT, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca,activo) VALUES (10,'Cuadro 3','La Esperanza',1);

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
      fecha TEXT NOT NULL, hora TEXT,
      lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT,
      cuadrilla_id INTEGER, cuadrilla TEXT,
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

// ══════════════════════════════════════════════════════════════════════════
// 1 · LA REGLA, SOLA
// ══════════════════════════════════════════════════════════════════════════
const meter = (db, fecha) => registrarVolcado(db, { fecha, lote_id: 10, kilos: 450 }).id;

test('LO DE HOY SE BORRA SIN NINGÚN PERMISO ESPECIAL', () => {
  const db = base();
  const id = meter(db, HOY);
  const r = borrarVolcado(db, id, { hoy: HOY, puede_anular: false });
  assert.equal(r.ok, true);
  assert.equal(resumenDelDia(db, HOY).cargas, 0);
});

test('LO DE AYER NO, Y EL MOTIVO DICE POR QUÉ', () => {
  const db = base();
  const id = meter(db, AYER);
  const r = borrarVolcado(db, id, { hoy: HOY, puede_anular: false });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.motivo, new RegExp(AYER));
  assert.match(r.motivo, /jornal/, 'no dice por qué un día cerrado es distinto');
  // Y la carga sigue ahí: un 403 no puede dejar la fila a medias.
  assert.equal(resumenDelDia(db, AYER).cargas, 1);
});

test('con permiso de anular, lo de ayer sí', () => {
  const db = base();
  const id = meter(db, AYER);
  assert.equal(borrarVolcado(db, id, { hoy: HOY, puede_anular: true }).ok, true);
  assert.equal(resumenDelDia(db, AYER).cargas, 0);
});

test('SIN la fecha de hoy no hay control, y eso es lo que la ruta no puede olvidarse', () => {
  /* La función sola no inventa un «hoy»: lo pone el SERVIDOR (hoy() en
     rutas/galpon.js), porque tomado del navegador alcanzaría con adelantar el
     reloj del equipo del galpón para que «hoy» fuera cualquier día.

     La contra es que llamarla sin opts no controla nada. Por eso está el test de
     la ruta más abajo, que verifica que la ruta sí la pasa. */
  const db = base();
  const id = meter(db, AYER);
  assert.equal(borrarVolcado(db, id).ok, true);
});

test('una carga que ya se borró no se vuelve a borrar, y no dice 403', () => {
  // El motivo importa: «ya se borró» es 404 y «es de otro día» es 403. Mezclarlos
  // haría que el que borró dos veces crea que le falta un permiso.
  const db = base();
  const id = meter(db, HOY);
  borrarVolcado(db, id, { hoy: HOY });
  const r = borrarVolcado(db, id, { hoy: HOY });
  assert.equal(r.ok, false);
  assert.equal(r.status, undefined);
  assert.match(r.motivo, /no existe o ya se borró/);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL NIVEL: la mitad que vive en permisos.js
// ══════════════════════════════════════════════════════════════════════════
/* exigirNivel resuelve de qué menú es una dirección leyendo
   modulos_config.api_prefijos. Con esa tabla vacía NO BLOQUEA NADA —deja pasar
   todo— así que un test que se olvide de llenarla pasa sin probar nada. Acá se
   llena a mano, y el assert del final de este bloque la ata a lo que
   ensure_api_prefijos.js declara de verdad: si alguien cambia el prefijo allá,
   este archivo cae y hay que venir a mirar. */
const PREFIJOS = [
  ['galpon-carga',    'galpon/volcados,galpon/planilla'],
  ['galpon-proceso',  'galpon/procesos,galpon/pallets,galpon/armado'],
  ['galpon-stock',    'galpon/stock,galpon/despachos'],
  ['galpon-config',   'galpon/config,galpon/cuadrillas,galpon/tarjetas,galpon/presentaciones,galpon/lote-datos'],
];

async function conPermisos(niveles) {
  const dir = fs.mkdtempSync(path.join(RAIZ, '.tmp-galbh-'));
  fs.mkdirSync(path.join(dir, 'servicios'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/servicios'))) {
    if (f.endsWith('.js')) {
      fs.copyFileSync(path.join(RAIZ, 'src/servicios', f), path.join(dir, 'servicios', f));
    }
  }
  const db = new DatabaseSync(':memory:');
  /* better-sqlite3 tiene db.transaction y node:sqlite no. Varios módulos del arranque
     lo usan para sembrar, y sin esto fallan en silencio (están en try/catch) dejando
     modulos_config vacía — o sea, el guardián apagado y el test en verde. */
  db.transaction = (fn) => (...a) => {
    db.exec('BEGIN');
    try { const r = fn(...a); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* ya estaba cerrada */ } throw e; }
  };
  fs.writeFileSync(path.join(dir, 'servicios', 'db.js'),
    'export default globalThis.__GAL_DB2; export const getDb = () => globalThis.__GAL_DB2;\n'
    + 'export function rehacerTabla(){}\n', 'utf8');
  globalThis.__GAL_DB2 = db;

  const BARRA = String.fromCharCode(92);
  const perm = await import('file:///'
    + path.join(dir, 'servicios', 'permisos.js').split(BARRA).join('/'));

  // modulos_config la crea db_org.js al importar la cadena de permisos.
  const ins = db.prepare(
    'INSERT OR REPLACE INTO modulos_config (modulo, label, grupo, api_prefijos)'
    + ' VALUES (?,?,?,?)');
  for (const [m, pre] of PREFIJOS) ins.run(m, m, 'Galpón', pre);
  const insN = db.prepare(
    'INSERT OR REPLACE INTO usuario_modulos (usuario_id, modulo, nivel) VALUES (2,?,?)');
  for (const [m, n] of Object.entries(niveles || {})) insN.run(m, n);

  return {
    /* Devuelve { paso, estado, cuerpo }: si el middleware llamó a next() o contestó. */
    correr: (url, metodo, rol) => {
      const req = { method: metodo, originalUrl: url, url, body: {}, query: {},
                    cookies: { lnb_user: JSON.stringify({ id: 2, nombre: 'Juan',
                                                          rol: rol || 'operador' }) } };
      let paso = false; let estado = null; let cuerpo = null;
      const res = { status(n) { estado = n; return this; },
                    json(x) { cuerpo = x; return this; } };
      perm.exigirNivel(req, res, () => { paso = true; });
      return { paso, estado, cuerpo };
    },
    borrarEsOperar: perm.borrarEsOperar,
    cerrar: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('CON NIVEL «operar» EL DELETE DE UNA CARGA PASA EL MIDDLEWARE', async () => {
  // Es la mitad que vive en permisos.js. Sin ella el operario no puede borrar ni lo
  // que acaba de tipear, y tiene que ir a buscar al dueño.
  const p = await conPermisos({ 'galpon-carga': 'operar' });
  try {
    const r = p.correr('/api/galpon/volcados/12', 'DELETE');
    assert.equal(r.paso, true, 'el DELETE de una carga sigue pidiendo nivel de anulación');
  } finally { p.cerrar(); }
});

test('pero con «ver» no pasa: aflojar el nivel no es abrirlo', async () => {
  const p = await conPermisos({ 'galpon-carga': 'ver' });
  try {
    const r = p.correr('/api/galpon/volcados/12', 'DELETE');
    assert.equal(r.paso, false);
    assert.equal(r.estado, 403);
    assert.equal(r.cuerpo.solo_lectura, true);
  } finally { p.cerrar(); }
});

test('y sin el módulo tampoco', async () => {
  const p = await conPermisos({});
  try {
    const r = p.correr('/api/galpon/volcados/12', 'DELETE');
    assert.equal(r.paso, false);
    assert.equal(r.estado, 403);
  } finally { p.cerrar(); }
});

test('LA EXCEPCIÓN NO SE LE ESCAPA A OTRAS DIRECCIONES DEL GALPÓN', async () => {
  // Borrar un pallet, un proceso, un despacho o un rango de tarjetas sigue siendo
  // anular. Si la excepción se hubiera escrito como «los DELETE del galpón», esto
  // pasaría — y un pallet borrado se lleva puesto el stock de un camión.
  const p = await conPermisos({
    'galpon-carga': 'operar', 'galpon-proceso': 'operar',
    'galpon-stock': 'operar', 'galpon-config': 'operar',
  });
  try {
    for (const u of ['/api/galpon/pallets/3', '/api/galpon/procesos/3',
                     '/api/galpon/despachos/3', '/api/galpon/tarjetas/3']) {
      const r = p.correr(u, 'DELETE');
      assert.equal(r.paso, false, u + ' pasa con nivel operar');
      assert.equal(r.estado, 403);
      assert.match(r.cuerpo.error, /no anular/);
    }
  } finally { p.cerrar(); }
});

test('un admin pasa por todo, como en el resto del sistema', async () => {
  const p = await conPermisos({});
  try {
    assert.equal(p.correr('/api/galpon/volcados/12', 'DELETE', 'admin').paso, true);
    assert.equal(p.correr('/api/galpon/pallets/12', 'DELETE', 'admin').paso, true);
  } finally { p.cerrar(); }
});

test('borrarEsOperar reconoce la carga y nada más', async () => {
  const p = await conPermisos({});
  try {
    const f = p.borrarEsOperar;
    assert.equal(f('/api/galpon/volcados'), true);
    assert.equal(f('/api/galpon/volcados/19'), true);
    assert.equal(f('/API/GALPON/VOLCADOS/19?x=1'), true);
    assert.equal(f('/api/galpon/volcadosx/19'), false);
    assert.equal(f('/api/galpon/procesos/19'), false);
    assert.equal(f('/api/sg/ven/facturas/19'), false);
    assert.equal(f(''), false);
    assert.equal(f(null), false);
  } finally { p.cerrar(); }
});

test('EL MAPA DE ESTE ARCHIVO ES EL QUE SE DECLARA DE VERDAD', () => {
  /* Lo de arriba se siembra a mano, así que podría quedar diciendo lo que me
     conviene. Esto lo ata a ensure_api_prefijos.js: si allá alguien le saca
     'galpon/volcados' a galpon-carga, o se lo pasa a otro menú, este archivo cae en
     vez de seguir probando un mundo que ya no existe. */
  const ens = fs.readFileSync(path.join(RAIZ, 'src/servicios/ensure_api_prefijos.js'), 'utf8');
  for (const [m, pre] of PREFIJOS) {
    assert.ok(ens.includes("['" + m + "',") , 'ensure_api_prefijos.js no declara ' + m);
    const re = new RegExp("\\['" + m + "',\\s*'([^']*)'\\]");
    const x = re.exec(ens);
    assert.ok(x, 'no pude leer los prefijos de ' + m + ' en ensure_api_prefijos.js');
    assert.equal(x[1], pre, 'los prefijos de ' + m + ' cambiaron: actualizá PREFIJOS acá');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 2b · LA FECHA: la mitad que vive en la ruta
// ══════════════════════════════════════════════════════════════════════════
// -- SIN node_modules ESTE BLOQUE SE SALTEA, NO SE CAE --------------------
let express = null;
let falta = false;
try {
  express = (await import('express')).default;
  await import('jspdf');
  await import('qrcode');
} catch { falta = 'falta el paquete express (o jspdf/qrcode): corre npm install para que estos tests corran'; }

const t = (nombre, fn) => test(nombre, { skip: falta }, fn);

/* El arnés de test/galpon_carga_router.test.mjs: el router de verdad, sin
   exigirNivel delante. Acá lo que se prueba es lo que el middleware NO puede
   saber —la fecha de la fila— y para eso el pedido tiene que llegar. */
async function servidor(db, usuario) {
  const dir = fs.mkdtempSync(path.join(RAIZ, '.tmp-galbh-'));
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

  const BARRA = String.fromCharCode(92);
  const mod = await import('file:///'
    + path.join(dir, 'rutas', 'galpon.js').split(BARRA).join('/'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.cookies = usuario ? { lnb_user: JSON.stringify(usuario) } : {}; next();
  });
  app.use('/api/galpon', mod.default);
  const srv = await new Promise((ok) => { const x = app.listen(0, () => ok(x)); });
  const u = 'http://127.0.0.1:' + srv.address().port;
  return {
    pegar: (ruta, opts) => fetch(u + '/api/galpon' + ruta, opts),
    cerrar: () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const OPERADOR = { id: 2, nombre: 'Juan', rol: 'operador' };
const ADMIN    = { id: 1, nombre: 'Andy', rol: 'admin' };

const json = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
                       body: JSON.stringify(b) });

t('UN OPERADOR BORRA LO QUE ACABA DE CARGAR HOY', async () => {
  const db = base();
  const s = await servidor(db, OPERADOR);
  try {
    const id = meter(db, HOY);
    const r = await s.pegar('/volcados/' + id, { method: 'DELETE' });
    assert.equal(r.status, 200, 'el operador no pudo borrar lo de hoy');
    assert.equal((await (await s.pegar('/volcados?fecha=' + HOY)).json()).resumen.cargas, 0);
  } finally { s.cerrar(); }
});

t('EL MISMO OPERADOR NO BORRA LO DE AYER, y le dice por qué', async () => {
  // Es el agujero que no se nota: si la ruta no controlara la fecha, esto
  // devolvería 200 y nadie lo probaría nunca.
  const db = base();
  const s = await servidor(db, OPERADOR);
  try {
    const id = meter(db, AYER);
    const r = await s.pegar('/volcados/' + id, { method: 'DELETE' });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /jornal/);
    assert.equal((await (await s.pegar('/volcados?fecha=' + AYER)).json()).resumen.cargas, 1);
  } finally { s.cerrar(); }
});

t('un admin sí borra lo de ayer', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  try {
    assert.equal((await s.pegar('/volcados/' + meter(db, AYER), { method: 'DELETE' })).status, 200);
  } finally { s.cerrar(); }
});

t('EL GET DICE SI SE PUEDE, para no ofrecer un botón que va a rebotar', async () => {
  const db = base();
  const s = await servidor(db, OPERADOR);
  try {
    assert.equal((await (await s.pegar('/volcados')).json()).puede_anular, false);
  } finally { s.cerrar(); }
  const s2 = await servidor(base(), ADMIN);
  try {
    assert.equal((await (await s2.pegar('/volcados')).json()).puede_anular, true);
  } finally { s2.cerrar(); }
});
// ══════════════════════════════════════════════════════════════════════════
// 3 · LAS DOS MITADES SON UNA SOLA DECISIÓN
// ══════════════════════════════════════════════════════════════════════════
test('CADA DIRECCIÓN DE LA LISTA TIENE QUE TENER SU CONTROL DEL OTRO LADO', () => {
  /* Hoy la lista tiene UNA dirección. El día que alguien agregue la segunda, su
     control de fila no se escribe solo — y el agujero que deja no se nota,
     porque nadie prueba borrar algo de marzo.

     Este test no puede adivinar qué control le toca a una dirección nueva, así
     que hace lo único que sirve: FRENA. El que la agregue tiene que venir acá,
     escribir cómo se verifica la suya, y recién entonces pasa. */
  const perm = fs.readFileSync(path.join(RAIZ, 'src/servicios/permisos.js'), 'utf8');
  const m = /const BORRAR_ES_OPERAR = \[([^\]]*)\]/.exec(perm);
  assert.ok(m, 'no encontré la lista BORRAR_ES_OPERAR en permisos.js');
  const dirs = m[1].split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  assert.deepEqual(dirs, ['/api/galpon/volcados'],
    'la lista cambió: cada dirección que se agregue necesita su propio control de fila '
    + 'del lado de la ruta, y su test acá. Agregala a este assert cuando lo hayas escrito.');
});

test('EL CONTROL DE LA FECHA ESTÁ EN LA RUTA, y usa la hora del servidor', () => {
  const ruta = fs.readFileSync(path.join(RAIZ, 'src/rutas/galpon.js'), 'utf8');
  const i = ruta.indexOf("router.delete('/volcados/:id'");
  assert.ok(i > 0, 'no está el DELETE de volcados');
  const bloque = ruta.slice(i, i + 900);
  assert.match(bloque, /hoy: hoy\(\)/,
    'el DELETE no le pasa la fecha del servidor: sin eso borrarVolcado no controla nada');
  assert.match(bloque, /puede_anular: puedeAnularCargas\(req\._user\)/);
  assert.match(bloque, /r\.status \|\| 404/, 'el 403 de un día cerrado sale como 404');
  // Y el nivel se lee con la MISMA escala que el servidor, no con una copia.
  assert.match(ruta, /import \{ nivelEnModulo \} from '\.\.\/servicios\/permisos\.js'/);
  const pa = ruta.slice(ruta.indexOf('function puedeAnularCargas(u) {'), 400 + ruta.indexOf(
    'function puedeAnularCargas(u) {'));
  assert.match(pa, /u\.rol === 'admin'/, 'un admin no puede anular');
  assert.match(pa, /nivelEnModulo\(u, 'galpon-carga'\)/);
});

test('Y LA PANTALLA MIRA LA FECHA JUNTO CON EL PERMISO, no en lugar de él', () => {
  const panel = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
  assert.match(panel, /var puedoBorrar = \(GKG\.fecha === GKG\.hoy\) \|\| !!GKG\.puedeAnular;/);
  assert.match(panel, /GKG\.puedeAnular = !!j\.puede_anular;/);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · ☑️ BORRAR VARIAS DE UNA VEZ
// ══════════════════════════════════════════════════════════════════════════
// Andy, 2/11/2026: «quiero poder seleccionar varios para eliminar, como si
// tuvieran un casillero».
//
// O TODAS O NINGUNA. Un borrado a medias de una tanda es peor que ninguno: el
// que apretó no sabe cuáles quedaron y tiene que mirar renglón por renglón,
// que es el trabajo que el casillero venía a sacar.

test('BORRA LAS QUE SE LE PASAN, y dice cuántas y cuántos kilos', () => {
  const db = base();
  const a = meter(db, HOY); const b = meter(db, HOY); const c = meter(db, HOY);
  const r = borrarVolcados(db, [a, b], { hoy: HOY });
  assert.equal(r.ok, true);
  assert.equal(r.borradas, 2);
  assert.equal(r.kilos, 900);
  // Y la tercera queda: se borra lo que se pidió, no 'todo el día'.
  assert.equal(resumenDelDia(db, HOY).cargas, 1);
  assert.equal(resumenDelDia(db, HOY).kilos, 450);
  assert.ok(c);
});

test('SI UNA NO SE PUEDE, NO SE BORRA NINGUNA', () => {
  /* Es la razón de ser de la validación previa. Borrando al pasar, las dos
     primeras se irían y la tercera no: el que apretó ve un error y no tiene
     cómo saber que igual perdió dos renglones. */
  const db = base();
  const a = meter(db, HOY); const b = meter(db, HOY); const viejo = meter(db, AYER);
  const r = borrarVolcados(db, [a, b, viejo], { hoy: HOY, puede_anular: false });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.motivo, new RegExp(AYER));
  assert.match(r.motivo, /No se borró ninguna/, 'no aclara que no se borró nada');
  assert.equal(resumenDelDia(db, HOY).cargas, 2);
  assert.equal(resumenDelDia(db, AYER).cargas, 1);
});

test('una que ya no está frena la tanda, y lo dice', () => {
  // Pasa de verdad: dos personas mirando el mismo día. Seguir adelante dejaría
  // a la segunda creyendo que borró algo que ya no existía.
  const db = base();
  const a = meter(db, HOY); const b = meter(db, HOY);
  borrarVolcado(db, b, { hoy: HOY });
  const r = borrarVolcados(db, [a, b], { hoy: HOY });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.match(r.motivo, /ya la borró/);
  assert.equal(resumenDelDia(db, HOY).cargas, 1, 'borró la primera igual');
});

test('con permiso de anular se puede mezclar días', () => {
  const db = base();
  const r = borrarVolcados(db, [meter(db, HOY), meter(db, AYER)],
    { hoy: HOY, puede_anular: true });
  assert.equal(r.ok, true);
  assert.equal(r.borradas, 2);
});

test('el id repetido es un clic de más, no un error', () => {
  const db = base();
  const a = meter(db, HOY);
  const r = borrarVolcados(db, [a, a, String(a)], { hoy: HOY });
  assert.equal(r.ok, true);
  assert.equal(r.borradas, 1, 'contó la misma carga dos veces');
  assert.equal(r.kilos, 450);
  /* Y LA LISTA QUE DEVUELVE TAMBIÉN VIENE SIN REPETIDOS. El total salía bien igual
     —el UPDATE no hace nada la segunda vez— así que sin este assert la
     deduplicación se podía borrar sin que nada cayera. Importa porque esta lista es
     lo que la función dice haber tocado, y además es lo que se cuenta contra el
     tope de 500. */
  assert.deepEqual(r.ids, [a]);
});

test('una lista vacía o con basura no borra nada y dice qué pasó', () => {
  const db = base();
  meter(db, HOY);
  for (const malo of [[], null, undefined, 'x']) {
    const r = borrarVolcados(db, malo, { hoy: HOY });
    assert.equal(r.ok, false, JSON.stringify(malo) + ' borró algo');
    assert.match(r.motivo, /ninguna carga/);
  }
  const r2 = borrarVolcados(db, [1, 'tres'], { hoy: HOY });
  assert.equal(r2.ok, false);
  assert.match(r2.motivo, /no se entiende/);
  assert.equal(resumenDelDia(db, HOY).cargas, 1);
});

test('HAY UN TECHO: la lista la manda el navegador', () => {
  // Mil ids son mil consultas antes de contestar, y nadie selecciona mil a mano.
  const db = base();
  const muchos = [];
  for (let i = 1; i <= 501; i++) muchos.push(i);
  const r = borrarVolcados(db, muchos, { hoy: HOY });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /demasiadas/);
});

t('LA RUTA: un operador borra varias de hoy en un solo pedido', async () => {
  const db = base();
  const s = await servidor(db, OPERADOR);
  try {
    const ids = [meter(db, HOY), meter(db, HOY), meter(db, HOY)];
    const r = await s.pegar('/volcados/borrar', json({ ids }));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.borradas, 3);
    assert.equal((await (await s.pegar('/volcados?fecha=' + HOY)).json()).resumen.cargas, 0);
  } finally { s.cerrar(); }
});

t('LA RUTA CONTROLA LA FECHA TAMBIÉN ACÁ', async () => {
  /* Es la segunda mitad de la misma decisión. El nivel ya lo aflojó permisos.js
     para todo lo que cuelga de /api/galpon/volcados —y esta dirección cuelga de
     ahí— así que sin este control un operador borraría la temporada pasada de a
     quinientas por pedido. */
  const db = base();
  const s = await servidor(db, OPERADOR);
  try {
    const ids = [meter(db, HOY), meter(db, AYER)];
    const r = await s.pegar('/volcados/borrar', json({ ids }));
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /No se borró ninguna/);
    assert.equal((await (await s.pegar('/volcados?fecha=' + HOY)).json()).resumen.cargas, 1);
  } finally { s.cerrar(); }
});

t('y un admin sí puede', async () => {
  const db = base();
  const s = await servidor(db, ADMIN);
  try {
    const ids = [meter(db, HOY), meter(db, AYER)];
    assert.equal((await s.pegar('/volcados/borrar', json({ ids }))).status, 200);
  } finally { s.cerrar(); }
});

t('sin sesión no borra nada', async () => {
  const db = base();
  const s = await servidor(db, null);
  try {
    assert.equal((await s.pegar('/volcados/borrar', json({ ids: [1] }))).status, 401);
  } finally { s.cerrar(); }
});

t('EL CERROJO DE EMPRESA TAPA TAMBIÉN ESTA DIRECCIÓN', async () => {
  // El galpón es de Puente Cordón. Parado en San Gerónimo no se borra nada de acá.
  const db = base();
  const s = await servidor(db, ADMIN);
  try {
    const id = meter(db, HOY);
    const r = await s.pegar('/volcados/borrar?sociedad_id=9', json({ ids: [id] }));
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /Puente Cord/);
    assert.equal(resumenDelDia(db, HOY).cargas, 1);
  } finally { s.cerrar(); }
});

test('LA DIRECCIÓN NUEVA CUELGA DE LA QUE YA TENÍA EL NIVEL AFLOJADO', async () => {
  /* No hizo falta tocar BORRAR_ES_OPERAR: /api/galpon/volcados/borrar empieza con
     '/api/galpon/volcados/'. Esto lo clava, porque si mañana alguien acortara ese
     prefijo la dirección nueva pediría nivel de anulación y el casillero dejaría
     de funcionar para el operario — sin que nada más se rompa. */
  const p = await conPermisos({});
  try {
    assert.equal(p.borrarEsOperar('/api/galpon/volcados/borrar'), true);
  } finally { p.cerrar(); }
  const pp = await conPermisos({ 'galpon-carga': 'operar' });
  try {
    assert.equal(pp.correr('/api/galpon/volcados/borrar', 'POST').paso, true,
      'el borrado múltiple pide nivel de anulación');
  } finally { pp.cerrar(); }
  const pv = await conPermisos({ 'galpon-carga': 'ver' });
  try {
    assert.equal(pv.correr('/api/galpon/volcados/borrar', 'POST').paso, false);
  } finally { pv.cerrar(); }
});

test('SIN TRANSACCIÓN, A PROPÓSITO, Y POR ESO SE VALIDA ANTES', () => {
  /* db.transaction() no existe en node:sqlite, así que usarlo partiría los tests
     en dos. No hace falta: después de validar lo único que queda es un UPDATE por
     fila que no puede fallar. Lo que sí hace falta es que la validación esté
     COMPLETA antes del primer UPDATE — y eso es lo que mira este assert. */
  const f = fs.readFileSync(path.join(RAIZ, 'src/servicios/galpon.js'), 'utf8');
  const i = f.indexOf('export function borrarVolcados(db, ids, opts)');
  assert.ok(i > 0, 'no está borrarVolcados');
  const cuerpo = f.slice(i, f.indexOf('\r\n}', i));
  const iVal = cuerpo.indexOf('filas.push(f);');
  const iUpd = cuerpo.indexOf('UPDATE gal_volcados SET eliminado_en');
  assert.ok(iVal > 0 && iUpd > iVal,
    'borra antes de terminar de validar: una tanda puede quedar a medias');
  assert.ok(!/db\.transaction/.test(cuerpo), 'db.transaction no corre con node:sqlite');
  /* Y el UPDATE sigue siendo blando e idempotente. Acotado AL UPDATE: buscado en la
     función entera, el "AND eliminado_en IS NULL" del SELECT de arriba lo cumple
     solo, y el assert pasaba con el UPDATE sin guardia. Lo destapó la prueba de
     mutación.

     Y la guardia está por la CARRERA: entre la validación y el UPDATE un compañero
     puede borrar una. Sin ella se le pisaría la fecha de borrado con la de ahora, y
     el renglón diría que lo sacó el que apretó el casillero. */
  const iUp = cuerpo.indexOf('UPDATE gal_volcados SET eliminado_en');
  assert.match(cuerpo.slice(iUp, iUp + 220), /WHERE id = \? AND eliminado_en IS NULL/,
    'el UPDATE del borrado múltiple no lleva su guardia');
  assert.ok(!/DELETE FROM gal_volcados/.test(cuerpo), 'borra duro los kilos');
});
