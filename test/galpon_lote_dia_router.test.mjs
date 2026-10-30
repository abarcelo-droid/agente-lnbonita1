// ══ 🗓️ GALPÓN · LOTE DEL DÍA — el router, levantado de verdad ════════════
//
// La lógica se prueba al lado, en test/galpon_lote_dia.test.mjs. Acá se monta
// `rutas/galpon.js` en un Express real y se le pega con `fetch`, porque lo que
// importa en este archivo no se ve leyendo el código:
//
//   · que el cerrojo de empresa esté en TODAS las rutas y no en las que alguien
//     se acordó de decorar
//   · que cargar el lote del día NO pida admin — es el trabajo de la mañana
//   · que el primer tramo arranque solo a las 00:00, y que un cambio sin hora
//     se rechace
//   · que un tramo con volcados encima no se pueda tocar, y que el 409 corte
//     ANTES de escribir
//
// ── POR QUÉ EL TEMPORAL VA ADENTRO DEL REPO ───────────────────────────────
// El arnés es el de galpon_router.test.mjs: se copia `src/servicios` y se
// reemplaza `db.js` por un doble que devuelve la base de este test. El router
// importa `jspdf` y `qrcode`, y Node busca `node_modules` subiendo desde el
// archivo: desde os.tmpdir() no llega nunca.
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

// ── UNA BASE CON LO QUE EL GALPÓN LEE DE OTROS MÓDULOS ────────────────────
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sociedades (id INTEGER PRIMARY KEY, nombre TEXT);
    INSERT INTO sociedades (id,nombre) VALUES (7,'Puente Cordón SA'), (9,'San Gerónimo SA');

    CREATE TABLE pa_sectores (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT);
    INSERT INTO pa_sectores (id,nombre,tipo) VALUES
      (1,'Frutales','frutales'), (2,'Chacra','chacra_mercado');

    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, sector_id INTEGER,
                           finca TEXT, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,sector_id,finca,activo) VALUES
      (10,'Cuadro 3',1,'La Esperanza',1),
      (11,'Cuadro 4',1,'La Esperanza',1),
      (12,'Cuadro 1',1,'Alto Verde',1),
      (13,'Arrancado', 1,'Alto Verde',0);

    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY, lote_id INTEGER, cultivo TEXT,
                                   campaña TEXT, es_perenne INTEGER DEFAULT 0);
    INSERT INTO pa_cultivos_lote (lote_id,cultivo,campaña,es_perenne) VALUES
      (10,'Damasco','2026/27',1),
      (11,'Zapallo','2025/26',0),
      (11,'Tomate','2026/27',0);

    CREATE TABLE pa_cuadrillas (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT,
                                activo INTEGER DEFAULT 1);
    INSERT INTO pa_cuadrillas (id,nombre,tipo,activo) VALUES (1,'Norte','fija',1);

    CREATE TABLE gal_lote_vigente (
      id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL,
      desde_hora TEXT NOT NULL DEFAULT '00:00', lote_id INTEGER NOT NULL,
      lote_nombre TEXT, producto TEXT, usuario_id INTEGER, usuario TEXT,
      creado_en TEXT DEFAULT (datetime('now','localtime')));
  `);
  return db;
}
const tramo = (db, fecha, hora, loteId, nombre) => db.prepare(
  'INSERT INTO gal_lote_vigente (fecha,desde_hora,lote_id,lote_nombre) VALUES (?,?,?,?)')
  .run(fecha, hora, loteId, nombre || ('Lote ' + loteId));

function conVolcados(db, filas) {
  // Desde la V1108 el libro guarda la fecha y la hora por separado, y lo que traba un
  // tramo son SÓLO los que sacaron su lote del reloj: los que tienen hora. Una carga
  // manual nombra su lote y no depende de ningún tramo.
  // IF NOT EXISTS: desde la V1108 la tabla la crea db_galpon.js, que el router
  // importa al levantarse. Crearla de nuevo revienta; así se usa la de verdad.
  db.exec('CREATE TABLE IF NOT EXISTS gal_volcados (id INTEGER PRIMARY KEY, fecha TEXT,'
        + ' hora TEXT, lote_id INTEGER, kilos REAL, eliminado_en TEXT)');
  for (const f of filas) {
    // lote_id y kilos van porque la tabla de verdad los tiene NOT NULL: cuando el
    // router ya la creó, esta función INSERTA en la buena y no en una de mentira.
    db.prepare('INSERT INTO gal_volcados (fecha,hora,lote_id,kilos) VALUES (?,?,?,?)')
      .run(String(f).slice(0, 10), String(f).slice(11, 16), 10, 100);
  }
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
  const dir = fs.mkdtempSync(path.join(RAIZ, '.tmp-galld-'));
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
const json  = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(b) });
const patch = (b) => Object.assign(json(b), { method: 'PATCH' });
const HOY = new Date().toLocaleDateString('en-CA');

t('sin sesión no se lee ni se carga nada', async () => {
  const s = await servidor(base(), null);
  try {
    assert.equal((await s.pegar('/lote-dia')).status, 401);
    assert.equal((await s.pegar('/lote-vigente')).status, 401);
    assert.equal((await s.pegar('/lotes')).status, 401);
    assert.equal((await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10 }))).status, 401);
  } finally { s.cerrar(); }
});

t('UN OPERADOR CARGA EL LOTE DEL DÍA: no hace falta ser admin', async () => {
  // Es la regla de CLAUDE.md puesta a prueba. Configurar las cuadrillas sí pide
  // admin —se toca una vez por temporada—; esto se carga todas las mañanas y lo
  // hace el que abre el galpón. Con admin, lo termina cargando el dueño por
  // teléfono mientras el primer camión espera.
  const s = await servidor(base(), OPERADOR);
  try {
    const r = await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10 }));
    assert.equal(r.status, 200, 'un operador no pudo cargar el lote del día');
    const j = await r.json();
    assert.equal(j.ok, true);
    // y lo puede corregir y borrar
    assert.equal((await s.pegar('/lote-dia/' + j.id, patch({ producto: 'Damasco' }))).status, 200);
    assert.equal((await s.pegar('/lote-dia/' + j.id, { method: 'DELETE' })).status, 200);
  } finally { s.cerrar(); }
});

t('EL PRIMER TRAMO DEL DÍA ARRANCA A LAS 00:00 SOLO', async () => {
  // El caso normal —un lote, toda la jornada— no puede dejar la mañana sin
  // cubrir sólo porque el que cargó no dijo una hora.
  const s = await servidor(base(), OPERADOR);
  try {
    const j = await (await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10 }))).json();
    assert.equal(j.desde_hora, '00:00');
  } finally { s.cerrar(); }
});

t('pero un CAMBIO de lote sin hora se rechaza', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10 }));
    const r = await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 11 }));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /hora/i);
  } finally { s.cerrar(); }
});

t('la hora se guarda normalizada, venga como venga', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10, desde_hora: '00:00' }));
    const j = await (await s.pegar('/lote-dia',
      json({ fecha: HOY, lote_id: 11, desde_hora: '9:30' }))).json();
    assert.equal(j.desde_hora, '09:30', 'guardó la hora sin el cero adelante');
  } finally { s.cerrar(); }
});

t('DOS LOTES A LA MISMA HORA: 409, y dice con cuál se pisa', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    // El PRIMERO del día va a las 00:00 lo que se mande (V1108), así que el choque
    // se arma entre dos CAMBIOS, que es donde la hora significa algo.
    await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 12 }));
    await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10, desde_hora: '08:00' }));
    const r = await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 11, desde_hora: '08:00' }));
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.match(j.error, /Cuadro 3/, 'no nombra el lote que ya está: ' + j.error);
    assert.match(j.error, /no se atribuyen|kilos/i, 'no dice la consecuencia: ' + j.error);
    assert.equal(j.choca_con.lote_id, 10);
  } finally { s.cerrar(); }
});

t('EL NOMBRE DEL LOTE LO PONE EL SERVIDOR, aunque el cliente mande otro', async () => {
  // Está denormalizado para que la etiqueta del pallet no salga a buscarlo. Si lo
  // mandara la pantalla, el tramo podría decir una cosa y apuntar a otra.
  const s = await servidor(base(), OPERADOR);
  try {
    await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10, lote_nombre: 'INVENTADO' }));
    const d = await (await s.pegar('/lote-dia?fecha=' + HOY)).json();
    assert.equal(d.tramos[0].lote_nombre, 'Cuadro 3');
  } finally { s.cerrar(); }
});

t('un lote que no existe no entra', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    assert.equal((await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 999 }))).status, 400);
    assert.equal((await s.pegar('/lote-dia', json({ fecha: 'ayer', lote_id: 10 }))).status, 400);
  } finally { s.cerrar(); }
});

t('EL VIGENTE LO RESUELVE EL SERVIDOR, y viene en la respuesta del día', async () => {
  // Para que la pantalla no repita la regla. Dos copias de la única cosa que este
  // módulo tiene que contestar igual en los dos lados terminan dando distinto.
  const s = await servidor(base(), OPERADOR);
  try {
    await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10 }));
    const d = await (await s.pegar('/lote-dia')).json();
    assert.equal(d.fecha, d.hoy, 'sin fecha, el día lo pone el servidor');
    assert.ok(d.vigente, 'no vino el vigente resuelto');
    assert.equal(d.vigente.lote_id, 10);
    assert.match(d.ahora, /^\d{2}:\d{2}$/, 'la hora del servidor no vino en HH:MM');
  } finally { s.cerrar(); }
});

t('y mirando otro día no hay "ahora mismo"', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    await s.pegar('/lote-dia', json({ fecha: '2026-03-04', lote_id: 10 }));
    const d = await (await s.pegar('/lote-dia?fecha=2026-03-04')).json();
    assert.equal(d.tramos.length, 1);
    assert.equal(d.vigente, null, 'puso un cartel de "se está cosechando" sobre un día viejo');
  } finally { s.cerrar(); }
});

t('SIN LOTE CARGADO, /lote-vigente contesta 200 y lo dice adentro', async () => {
  // El que pregunta está por guardar un IFCO que YA ESTÁ EN LA TOLVA. Un 404 lo
  // dejaría sin saber qué hacer con la fruta. Nada se rechaza después del hecho.
  const s = await servidor(base(), OPERADOR);
  try {
    const r = await s.pegar('/lote-vigente?fecha=' + HOY + '&hora=10:00');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.match(j.motivo, /No se cargó el lote del día/);
  } finally { s.cerrar(); }
});

t('y con el cambio de lote cargado, contesta el de SU hora', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10 }));
    await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 11, desde_hora: '13:30' }));
    const a = await (await s.pegar('/lote-vigente?fecha=' + HOY + '&hora=13:29')).json();
    const b = await (await s.pegar('/lote-vigente?fecha=' + HOY + '&hora=13:30')).json();
    assert.equal(a.lote_id, 10);
    assert.equal(b.lote_id, 11);
  } finally { s.cerrar(); }
});

t('LA HORA DEL PRIMER TRAMO SE IGNORA: arranca a las 00:00 (V1108)', async () => {
  // Antes era un default que el cliente podía pisar, y el que ponía 07:00 —la
  // hora en que abre el galpón— se comía un cartel avisándole de un agujero.
  // Ahora el servidor la ignora, para que lo que dice la pantalla y lo que hace
  // el sistema sean la misma cosa.
  const s = await servidor(base(), OPERADOR);
  try {
    const j = await (await s.pegar('/lote-dia',
      json({ fecha: HOY, lote_id: 10, desde_hora: '08:00' }))).json();
    assert.equal(j.ok, true);
    assert.equal(j.desde_hora, '00:00', 'el primero del día se guardó a las 08:00');

    // Y el SEGUNDO sí la respeta: ahí la hora significa algo.
    const k = await (await s.pegar('/lote-dia',
      json({ fecha: HOY, lote_id: 11, desde_hora: '13:30' }))).json();
    assert.equal(k.desde_hora, '13:30');
  } finally { s.cerrar(); }
});

t('y la respuesta del día ya no trae «hueco»', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10 }));
    const d = await (await s.pegar('/lote-dia?fecha=' + HOY)).json();
    assert.ok(!('hueco' in d), 'la pantalla volvería a pintar el cartel');
  } finally { s.cerrar(); }
});

t('corregir el lote de un tramo le cambia también el nombre guardado', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    const j = await (await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10 }))).json();
    await s.pegar('/lote-dia/' + j.id, patch({ lote_id: 12 }));
    const d = await (await s.pegar('/lote-dia?fecha=' + HOY)).json();
    assert.equal(d.tramos[0].lote_id, 12);
    assert.equal(d.tramos[0].lote_nombre, 'Cuadro 1', 'quedó el nombre del lote anterior');
  } finally { s.cerrar(); }
});

t('un tramo que no existe da 404, no 500', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    assert.equal((await s.pegar('/lote-dia/999', { method: 'DELETE' })).status, 404);
    assert.equal((await s.pegar('/lote-dia/999', patch({ producto: 'x' }))).status, 404);
  } finally { s.cerrar(); }
});

// ── EL CANDADO ────────────────────────────────────────────────────────────
t('UN TRAMO CON VOLCADOS ENCIMA NO SE TOCA', async () => {
  // Cada volcado congeló su lote_id. Corregir el tramo no los arregla: los deja
  // apuntando a un lote que ya nadie declaró, y no se descubre hasta que no
  // cierran los números de la temporada.
  const db = base();
  const s = await servidor(db, OPERADOR);
  try {
    const j = await (await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10 }))).json();
    // Antes de que exista el volcado, se corrige libremente.
    assert.equal((await s.pegar('/lote-dia/' + j.id, patch({ producto: 'Damasco' }))).status, 200);

    conVolcados(db, [HOY + ' 09:15:00', HOY + ' 09:40:00']);

    const rp = await s.pegar('/lote-dia/' + j.id, patch({ lote_id: 11 }));
    assert.equal(rp.status, 409);
    const e = (await rp.json()).error;
    assert.match(e, /2 IFCOs volcados/, 'no dice cuántos: ' + e);
    assert.match(e, /Tablero/, 'no dice dónde se corrige: ' + e);

    assert.equal((await s.pegar('/lote-dia/' + j.id, { method: 'DELETE' })).status, 409);

    // Y el tramo quedó como estaba: el 409 cortó ANTES de escribir.
    const d = await (await s.pegar('/lote-dia?fecha=' + HOY)).json();
    assert.equal(d.tramos.length, 1);
    assert.equal(d.tramos[0].lote_id, 10);
    assert.equal(d.tramos[0].volcados, 2, 'la pantalla no sabe que hay que poner el candado');
  } finally { s.cerrar(); }
});

t('y un tramo sin volcados se sigue pudiendo borrar aunque el día tenga otros', async () => {
  const db = base();
  const s = await servidor(db, OPERADOR);
  try {
    await s.pegar('/lote-dia', json({ fecha: HOY, lote_id: 10 }));
    const b = await (await s.pegar('/lote-dia',
      json({ fecha: HOY, lote_id: 11, desde_hora: '13:30' }))).json();
    conVolcados(db, [HOY + ' 09:15:00']);   // cae en el PRIMER tramo, no en el segundo
    assert.equal((await s.pegar('/lote-dia/' + b.id, { method: 'DELETE' })).status, 200);
  } finally { s.cerrar(); }
});

// ── EL CERROJO DE EMPRESA ─────────────────────────────────────────────────
t('parado en San Gerónimo no se carga nada del galpón', async () => {
  // La empresa viaja en el pedido (?sociedad_id=), que es lo que inyecta el
  // selector del panel. Y va en TODAS las rutas, no en las que alguien decoró:
  // por eso el cerrojo está en un router.use y acá se recorren una por una.
  const s = await servidor(base(), ADMIN);
  try {
    for (const [ruta, opts] of [
      ['/lote-dia?sociedad_id=9', undefined],
      ['/lote-vigente?sociedad_id=9', undefined],
      ['/lotes?sociedad_id=9', undefined],
      ['/lote-dia?sociedad_id=9', json({ fecha: HOY, lote_id: 10 })],
      ['/lote-dia/1?sociedad_id=9', patch({ producto: 'x' })],
      ['/lote-dia/1?sociedad_id=9', { method: 'DELETE' }],
    ]) {
      const r = await s.pegar(ruta, opts);
      assert.equal(r.status, 403, ruta + ' dejó entrar parado en otra empresa');
      assert.match((await r.json()).error, /Puente Cordón/);
    }
    // Y parado en la propia, o sin decir ninguna, anda como siempre.
    assert.equal((await s.pegar('/lote-dia?sociedad_id=7')).status, 200);
    assert.equal((await s.pegar('/lote-dia')).status, 200);
  } finally { s.cerrar(); }
});
