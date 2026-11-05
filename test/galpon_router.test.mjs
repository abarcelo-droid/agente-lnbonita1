// ══ 🏭 GALPÓN — el router, levantado de verdad ════════════════════════════
//
// No se leen las rutas con una expresión regular: se monta `rutas/galpon.js`
// en un Express real, se le pega con `fetch` y se mira qué contesta. Lo que
// importa acá son cosas que un chequeo de texto no ve:
//
//   · que el cerrojo de empresa esté puesto en TODAS las rutas, y no en las
//     cuatro que alguien se acordó de decorar
//   · que configurar pida admin y leer no
//   · que dos rangos que se pisan den 409 ANTES de escribir
//   · que el PDF salga con Content-Type de PDF y no un JSON de error
//
// ── POR QUÉ EL TEMPORAL VA ADENTRO DEL REPO ───────────────────────────────
// El arnés es el de `mejoras.test.mjs`: se copia `src/servicios` a un
// directorio nuevo y se reemplaza `db.js` por un doble que devuelve la base de
// este test, así todo lo demás corre tal cual. La diferencia es que este
// router importa `jspdf` y `qrcode`, y Node busca `node_modules` subiendo
// desde el archivo: desde `os.tmpdir()` no llega nunca. Así que el temporal va
// colgado de la raíz del repo y se borra al final.
//
// -- SIN node_modules ESTE ARCHIVO SE SALTEA, NO SE CAE --------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let express = null;
let falta = false;
try {
  express = (await import('express')).default;
  await import('jspdf');
  await import('qrcode');
} catch { falta = 'falta el paquete express (o jspdf/qrcode): corre npm install para que estos tests corran'; }

const t = (nombre, fn) => test(nombre, { skip: falta }, fn);

// ── LA BASE ───────────────────────────────────────────────────────────────
// Sólo las tablas de OTROS módulos que el galpón lee. Las suyas las crea el
// DDL de verdad, que se importa, no se copia.
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sociedades (id INTEGER PRIMARY KEY, nombre TEXT);
    INSERT INTO sociedades (id, nombre) VALUES (7,'Puente Cordón SA'), (9,'San Gerónimo SA');
    CREATE TABLE pa_cuadrillas (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT,
                                activo INTEGER DEFAULT 1);
    INSERT INTO pa_cuadrillas (id,nombre,tipo,activo) VALUES
      (1,'Cuadrilla Norte','fija',1), (2,'Cuadrilla Sur','fija',1), (3,'Pool','pool',1);
  `);
  return db;
}

// Levanta el router de verdad y devuelve una función para pegarle.
async function servidor(db, usuario) {
  const dir = fs.mkdtempSync(path.join(RAIZ, '.tmp-galpon-'));
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
  // El único doble. Todo lo demás —el DDL, la lógica, el PDF— es el del repo.
  fs.writeFileSync(path.join(dir, 'servicios', 'db.js'),
    'export default globalThis.__GAL_DB; export const getDb = () => globalThis.__GAL_DB;\n'
    + 'export function rehacerTabla(){}\n', 'utf8');
  globalThis.__GAL_DB = db;

  const mod = await import('file:///' + path.join(dir, 'rutas', 'galpon.js').replace(/\\/g, '/'));
  const app = express();
  app.use(express.json());
  // El usuario llega por la cookie `lnb_user`, igual que en producción; acá se
  // inyecta ya parseada para no arrastrar cookie-parser.
  app.use((req, _res, next) => { req.cookies = usuario ? { lnb_user: JSON.stringify(usuario) } : {}; next(); });
  app.use('/api/galpon', mod.default);

  const srv = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const url = 'http://127.0.0.1:' + srv.address().port;
  return {
    pegar: (ruta, opts) => fetch(url + '/api/galpon' + ruta, opts),
    cerrar: () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const ADMIN = { id: 1, nombre: 'Andy', rol: 'admin' };
const OPERADOR = { id: 2, nombre: 'Juan', rol: 'operador' };
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(body) });
const put = (body) => Object.assign(json(body), { method: 'PUT' });
const patch = (body) => Object.assign(json(body), { method: 'PATCH' });

// ── QUIÉN ENTRA ───────────────────────────────────────────────────────────
t('SIN SESIÓN NO SE LEE NI LA CONFIGURACIÓN', async () => {
  const s = await servidor(base(), null);
  try {
    assert.equal((await s.pegar('/config')).status, 401);
    assert.equal((await s.pegar('/cuadrillas')).status, 401);
    assert.equal((await s.pegar('/tarjetas.pdf?desde=1&hasta=2')).status, 401);
  } finally { s.cerrar(); }
});

t('un operador LEE y IMPRIME, pero no configura', async () => {
  // Imprimir tarjetas a las seis de la mañana no lo hace el admin. Configurar
  // los rangos sí: uno mal puesto desvía los kilos de una cuadrilla entera.
  const s = await servidor(base(), OPERADOR);
  try {
    assert.equal((await s.pegar('/config')).status, 200);
    assert.equal((await s.pegar('/cuadrillas')).status, 200);
    assert.equal((await s.pegar('/tarjetas.pdf?desde=1&hasta=2')).status, 200);

    assert.equal((await s.pegar('/config', put({ tara_ifco: 9 }))).status, 403);
    assert.equal((await s.pegar('/cuadrillas/1/tarjetas', json({ desde_id: 1, hasta_id: 9 }))).status, 403);
    assert.equal((await s.pegar('/tarjetas/1', { method: 'DELETE' })).status, 403);
  } finally { s.cerrar(); }
});

t('y el 403 dice POR QUÉ, no "sin permiso"', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    const r = await (await s.pegar('/config', put({ tara_ifco: 9 }))).json();
    assert.match(r.error, /administrador/i);
    assert.match(r.error, /temporada|kilos/i, 'no explica la consecuencia: ' + r.error);
  } finally { s.cerrar(); }
});

// ── EL CERROJO DE EMPRESA ─────────────────────────────────────────────────
t('EL CERROJO DE EMPRESA ESTÁ EN TODAS LAS RUTAS, no en las que alguien decoró', async () => {
  // Parado en San Gerónimo (id 9) no se toca el galpón de Puente Cordón. Se
  // barren TODAS las rutas del router: una sola sin cerrojo es la que se usa.
  const s = await servidor(base(), ADMIN);
  try {
    const rutas = [
      ['/config?sociedad_id=9', undefined],
      ['/cuadrillas?sociedad_id=9', undefined],
      ['/tarjetas.pdf?sociedad_id=9&desde=1&hasta=2', undefined],
      ['/config?sociedad_id=9', put({ tara_ifco: 9 })],
      ['/cuadrillas/1/tarjetas?sociedad_id=9', json({ desde_id: 1, hasta_id: 9 })],
      ['/cuadrillas/1/color?sociedad_id=9', patch({ color: '#d62828' })],
      ['/tarjetas/1?sociedad_id=9', { method: 'DELETE' }],
    ];
    for (const [ruta, opts] of rutas) {
      const r = await s.pegar(ruta, opts);
      assert.equal(r.status, 403, 'sin cerrojo: ' + ruta);
      assert.match((await r.json()).error, /Puente Cordón/, ruta);
    }
  } finally { s.cerrar(); }
});

t('y parado en Puente Cordón, o sin decir nada, pasa', async () => {
  // Sin `sociedad_id` es el panel de siempre y tiene que seguir andando.
  const s = await servidor(base(), ADMIN);
  try {
    assert.equal((await s.pegar('/config?sociedad_id=7')).status, 200);
    assert.equal((await s.pegar('/config')).status, 200);
  } finally { s.cerrar(); }
});

// ── LA CONFIGURACIÓN ──────────────────────────────────────────────────────
t('la configuración viene sembrada, con los números ya convertidos', async () => {
  const s = await servidor(base(), ADMIN);
  try {
    const r = await (await s.pegar('/config')).json();
    assert.equal(typeof r.config.tara_ifco, 'number');
    assert.ok(r.config.tara_ifco > 0, 'la tara arranca en 0: nadie la va a cargar a mano');
    assert.ok(Array.isArray(r.config.motivos_calidad) && r.config.motivos_calidad.length >= 4);
    assert.ok(r.colores.length >= 5, 'la pantalla no tiene paleta para elegir');
  } finally { s.cerrar(); }
});

t('guardar la tara la pisa, y se lee enseguida', async () => {
  const s = await servidor(base(), ADMIN);
  try {
    const r = await (await s.pegar('/config', put({ tara_ifco: 2.4 }))).json();
    assert.equal(r.ok, true);
    assert.equal(r.config.tara_ifco, 2.4);
    assert.equal((await (await s.pegar('/config')).json()).config.tara_ifco, 2.4);
  } finally { s.cerrar(); }
});

t('UNA TARA QUE NO ES UN NÚMERO SE RECHAZA: entra a todas las restas del día', async () => {
  const s = await servidor(base(), ADMIN);
  try {
    for (const malo of ['dos kilos', '', -1, null]) {
      const r = await s.pegar('/config', put({ tara_ifco: malo }));
      assert.equal(r.status, 400, 'pasó tara_ifco=' + JSON.stringify(malo));
    }
    // Y la de antes sigue en pie: un rechazo no puede dejar la tara en blanco.
    assert.ok((await (await s.pegar('/config')).json()).config.tara_ifco > 0);
  } finally { s.cerrar(); }
});

t('una clave inventada no ensucia la tabla', async () => {
  // Sin la lista declarada, gal_config se llena de filas que no lee nadie y
  // que la próxima pantalla tiene que adivinar si significan algo.
  const s = await servidor(base(), ADMIN);
  try {
    const r = await (await s.pegar('/config', put({ color_favorito: 'verde', tara_ifco: 3 }))).json();
    assert.deepEqual(r.guardadas, ['tara_ifco']);
  } finally { s.cerrar(); }
});

// ── LAS CUADRILLAS ────────────────────────────────────────────────────────
t('LAS CUADRILLAS SALEN DE PERSONAL, incluidas las que no tienen rango', async () => {
  // La que no tiene rango es justamente la que hay que configurar: si no
  // apareciera, la pantalla de configuración no serviría para configurar.
  const s = await servidor(base(), ADMIN);
  try {
    const r = await (await s.pegar('/cuadrillas')).json();
    assert.deepEqual(r.cuadrillas.map((c) => c.nombre), ['Cuadrilla Norte', 'Cuadrilla Sur', 'Pool']);
    assert.deepEqual(r.cuadrillas.map((c) => c.tarjetas), [0, 0, 0]);
  } finally { s.cerrar(); }
});

t('asignar un rango y verlo contado en la cuadrilla', async () => {
  const s = await servidor(base(), ADMIN);
  try {
    const a = await (await s.pegar('/cuadrillas/1/tarjetas',
      json({ desde_id: 1, hasta_id: 120, color: '#d62828' }))).json();
    assert.equal(a.ok, true);
    const r = await (await s.pegar('/cuadrillas')).json();
    const n = r.cuadrillas.find((c) => c.id === 1);
    assert.equal(n.tarjetas, 120, 'cuenta mal: es el número que dice si alcanzan');
    assert.equal(n.color, '#d62828');
  } finally { s.cerrar(); }
});

t('DOS RANGOS QUE SE PISAN DAN 409 Y NO SE ESCRIBEN', async () => {
  // Acá sí se rechaza, y es la excepción del módulo: no pasó nada todavía. Una
  // tarjeta que es de dos cuadrillas se le atribuye a una para siempre, y los
  // kilos de la otra desaparecen sin dejar rastro.
  const s = await servidor(base(), ADMIN);
  try {
    await s.pegar('/cuadrillas/1/tarjetas', json({ desde_id: 1, hasta_id: 120 }));
    const r = await s.pegar('/cuadrillas/2/tarjetas', json({ desde_id: 100, hasta_id: 200 }));
    assert.equal(r.status, 409);
    const b = await r.json();
    assert.match(b.error, /Cuadrilla Norte/, 'no dice con quién se pisa: ' + b.error);
    // Y no quedó escrito.
    const c = await (await s.pegar('/cuadrillas')).json();
    assert.equal(c.cuadrillas.find((x) => x.id === 2).tarjetas, 0);
  } finally { s.cerrar(); }
});

t('pegado pero sin pisarse, pasa', async () => {
  const s = await servidor(base(), ADMIN);
  try {
    await s.pegar('/cuadrillas/1/tarjetas', json({ desde_id: 1, hasta_id: 120 }));
    const r = await s.pegar('/cuadrillas/2/tarjetas', json({ desde_id: 121, hasta_id: 240 }));
    assert.equal(r.status, 200, await r.text());
  } finally { s.cerrar(); }
});

t('un rango al revés o en cero se rechaza con el motivo', async () => {
  const s = await servidor(base(), ADMIN);
  try {
    for (const malo of [{ desde_id: 100, hasta_id: 10 }, { desde_id: 0, hasta_id: 10 },
                        { desde_id: 'a', hasta_id: 10 }, {}]) {
      const r = await s.pegar('/cuadrillas/1/tarjetas', json(malo));
      assert.equal(r.status, 400, 'pasó ' + JSON.stringify(malo));
    }
  } finally { s.cerrar(); }
});

t('EL COLOR SE CAMBIA EN TODOS LOS RANGOS DE LA CUADRILLA A LA VEZ', async () => {
  // El color identifica a la cuadrilla, no al rango. Dos tandas del mismo
  // equipo con colores distintos es justo lo que el color venía a evitar.
  const s = await servidor(base(), ADMIN);
  try {
    await s.pegar('/cuadrillas/1/tarjetas', json({ desde_id: 1, hasta_id: 100, color: '#d62828' }));
    await s.pegar('/cuadrillas/1/tarjetas', json({ desde_id: 300, hasta_id: 400, color: '#d62828' }));
    const r = await (await s.pegar('/cuadrillas/1/color', patch({ color: '#2a9d8f' }))).json();
    assert.equal(r.rangos, 2, 'cambió sólo uno');
    const c = await (await s.pegar('/cuadrillas')).json();
    const n = c.cuadrillas.find((x) => x.id === 1);
    assert.deepEqual([...new Set(n.rangos.map((x) => x.color))], ['#2a9d8f']);
  } finally { s.cerrar(); }
});

t('y un rango nuevo HEREDA el color de la cuadrilla sin que haya que repetirlo', async () => {
  // Ampliar la tanda a mitad de temporada es lo normal. Si hubiera que volver a
  // elegir el color, tarde o temprano sale otro y el campo deja de servir.
  const s = await servidor(base(), ADMIN);
  try {
    await s.pegar('/cuadrillas/1/tarjetas', json({ desde_id: 1, hasta_id: 100, color: '#7209b7' }));
    await s.pegar('/cuadrillas/1/tarjetas', json({ desde_id: 500, hasta_id: 520 }));
    const c = await (await s.pegar('/cuadrillas')).json();
    const n = c.cuadrillas.find((x) => x.id === 1);
    assert.deepEqual([...new Set(n.rangos.map((x) => x.color))], ['#7209b7']);
  } finally { s.cerrar(); }
});

t('SIN ELEGIR COLOR, A CADA CUADRILLA LE TOCA UNO DISTINTO', async () => {
  // Nadie lo elige salvo que quiera. Dejarlo a mano termina en dos cuadrillas del
  // mismo color, que es el único error que el color no puede corregir: el
  // cuadrillero agarra la tarjeta mirando el color, no leyendo el nombre.
  const s = await servidor(base(), ADMIN);
  try {
    const a = await (await s.pegar('/cuadrillas/1/tarjetas', json({ desde_id: 1, hasta_id: 10 }))).json();
    const b = await (await s.pegar('/cuadrillas/2/tarjetas', json({ desde_id: 11, hasta_id: 20 }))).json();
    const c = await (await s.pegar('/cuadrillas/3/tarjetas', json({ desde_id: 21, hasta_id: 30 }))).json();
    assert.equal(new Set([a.color, b.color, c.color]).size, 3,
      'se repitieron: ' + [a.color, b.color, c.color].join(' '));
    for (const x of [a, b, c]) assert.match(x.color, /^#[0-9a-f]{6}$/i);
  } finally { s.cerrar(); }
});

t('DAR DE BAJA UN RANGO NO BORRA LA FILA', async () => {
  // Un volcado viejo guardó la cuadrilla congelada, pero el rango sigue siendo
  // cómo se explica de dónde salió esa atribución.
  const s = await servidor(base(), ADMIN);
  try {
    const a = await (await s.pegar('/cuadrillas/1/tarjetas', json({ desde_id: 1, hasta_id: 50 }))).json();
    assert.equal((await s.pegar('/tarjetas/' + a.id, { method: 'DELETE' })).status, 200);
    const c = await (await s.pegar('/cuadrillas')).json();
    assert.equal(c.cuadrillas.find((x) => x.id === 1).tarjetas, 0);
    // La fila sigue, apagada.
    const vivas = globalThis.__GAL_DB.prepare(
      'SELECT activo FROM gal_cuadrilla_tarjetas WHERE id = ?').get(a.id);
    assert.equal(vivas.activo, 0, 'se borró la fila en vez de apagarla');
    // Y el rango queda libre para otra cuadrilla.
    assert.equal((await s.pegar('/cuadrillas/2/tarjetas', json({ desde_id: 1, hasta_id: 50 }))).status, 200);
  } finally { s.cerrar(); }
});

t('dar de baja algo que no existe es 404, no un 200 que miente', async () => {
  const s = await servidor(base(), ADMIN);
  try {
    assert.equal((await s.pegar('/tarjetas/999', { method: 'DELETE' })).status, 404);
  } finally { s.cerrar(); }
});

// ── EL PDF ────────────────────────────────────────────────────────────────
t('el PDF sale como PDF, para abrirse en el visor y mandarse a imprimir', async () => {
  const s = await servidor(base(), ADMIN);
  try {
    const r = await s.pegar('/tarjetas.pdf?desde=1&hasta=16');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    // `inline`, no `attachment`: se abre y se imprime, sin pasar por Descargas.
    assert.match(r.headers.get('content-disposition'), /^inline/);
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(b.slice(0, 5).toString(), '%PDF-');
  } finally { s.cerrar(); }
});

t('PEDIRLO POR CUADRILLA IMPRIME SU TANDA ENTERA, y sus dos rangos', async () => {
  const s = await servidor(base(), ADMIN);
  try {
    await s.pegar('/cuadrillas/1/tarjetas', json({ desde_id: 1, hasta_id: 10, color: '#d62828' }));
    await s.pegar('/cuadrillas/1/tarjetas', json({ desde_id: 50, hasta_id: 55 }));
    const r = await s.pegar('/tarjetas.pdf?cuadrilla_id=1');
    assert.equal(r.status, 200);
    // 16 tarjetas = 2 hojas de 8.
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal((b.toString('latin1').match(/\/MediaBox/g) || []).length, 2);
    assert.match(r.headers.get('content-disposition'), /Cuadrilla_Norte/);
  } finally { s.cerrar(); }
});

t('UN RANGO QUE CRUZA DOS CUADRILLAS le pone a cada tarjeta la suya', async () => {
  // Pasa al tipear un rango a mano. Que salieran todas con el nombre de la
  // primera sería peor que salir sin nombre: la tarjeta diría algo falso.
  const s = await servidor(base(), ADMIN);
  try {
    await s.pegar('/cuadrillas/1/tarjetas', json({ desde_id: 1, hasta_id: 4, color: '#d62828' }));
    await s.pegar('/cuadrillas/2/tarjetas', json({ desde_id: 5, hasta_id: 8, color: '#2a9d8f' }));
    const r = await s.pegar('/tarjetas.pdf?desde=1&hasta=8');
    const b = Buffer.from(await r.arrayBuffer());
    const zlib = await import('node:zlib');
    let txt = '';
    const re = /\/Filter \/FlateDecode\s*>>\s*stream\n/g;
    const s2 = b.toString('latin1');
    let m;
    while ((m = re.exec(s2))) {
      const i = m.index + m[0].length, f = s2.indexOf('\nendstream', i);
      try { txt += zlib.inflateSync(Buffer.from(s2.slice(i, f), 'latin1')).toString('latin1'); } catch { /* el QR */ }
    }
    const esc = [...txt.matchAll(/\((.*?)\) Tj/g)].map((x) => x[1]);
    assert.equal(esc[esc.indexOf('3') + 1], 'Cuadrilla Norte');
    assert.equal(esc[esc.indexOf('6') + 1], 'Cuadrilla Sur');
  } finally { s.cerrar(); }
});

t('la reposición por ids sueltos imprime sólo esas', async () => {
  const s = await servidor(base(), ADMIN);
  try {
    const r = await s.pegar('/tarjetas.pdf?ids=7,9,11');
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal((b.toString('latin1').match(/\/MediaBox/g) || []).length, 1);
  } finally { s.cerrar(); }
});

t('UN RANGO ABSURDO NO CUELGA EL SERVIDOR', async () => {
  // "1 a 999999" es un error de tipeo. Sin tope, el servidor se queda armando
  // un millón de QR mientras el operador mira una rueda girar.
  const s = await servidor(base(), ADMIN);
  try {
    const r = await s.pegar('/tarjetas.pdf?desde=1&hasta=999999');
    assert.equal(r.status, 200);
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal((b.toString('latin1').match(/\/MediaBox/g) || []).length, 63, '500 / 8 = 63 hojas');
  } finally { s.cerrar(); }
});

// ── 📋 A TRAVÉS DE LOS DÍAS ───────────────────────────────────────────────
// Andy, 4/11/2026: «quiero un lugar que sea transversal a los días». Lo que
// se prueba acá es el CABLEADO: que la ruta esté montada, que las fechas y el
// destino lleguen, y que sin fechas conteste todo lo que hay en vez de nada.
const cargas = (db, filas) => {
  const ins = db.prepare(
    " INSERT INTO gal_procesos (fecha,lote_id,lote_nombre,producto,destino,"
    + " presentacion,bultos,kilos,tipo) VALUES (?,?,'Cuadro 3','Damasco',?,?,?,?,'ingreso')");
  for (const f of filas) ins.run(f[0], 10, f[1], f[2], f[3], f[4]);
};

t('GET /procesos/rango trae las cargas de varios días', async () => {
  const db = base();
  const s = await servidor(db, OPERADOR);
  try {
    cargas(db, [['2026-11-02', 'comercial', 'IFCO HN', 10, 50],
                ['2026-11-04', 'comercial', 'IFCO HN', 20, 100],
                ['2026-11-04', 'verde', 'Blanca Verde', 5, 25]]);
    const j = await (await s.pegar('/procesos/rango?desde=2026-11-01&hasta=2026-11-30')).json();
    assert.equal(j.ok, true);
    assert.deepEqual(j.dias.map((d) => d.fecha), ['2026-11-04', '2026-11-02']);
    assert.equal(j.total.cargas, 3);
    assert.equal(j.total.kilos, 175);
    assert.equal(j.dias[0].cargas.length, 2);
  } finally { s.cerrar(); }
});

t('el destino llega por la query', async () => {
  const db = base();
  const s = await servidor(db, OPERADOR);
  try {
    cargas(db, [['2026-11-04', 'comercial', 'IFCO HN', 20, 100],
                ['2026-11-04', 'verde', 'Blanca Verde', 5, 25]]);
    const j = await (await s.pegar(
      '/procesos/rango?desde=2026-11-01&hasta=2026-11-30&destino=verde')).json();
    assert.equal(j.total.cargas, 1);
    assert.equal(j.total.kilos, 25);
  } finally { s.cerrar(); }
});

t('SIN FECHAS CONTESTA TODO LO QUE HAY, no una lista vacía', async () => {
  /* Abrir la pantalla en blanco porque faltó un parámetro es la peor respuesta
     posible a «mostrame todos los días» — el mismo criterio que /acumulado. */
  const db = base();
  const s = await servidor(db, OPERADOR);
  try {
    /* Y un volcado SUELTO el 2, para que el rango de lo volcado termine ahí: si
       el período saliera de gal_volcados, la carga del 9 —procesar lo que entró
       antes— quedaría afuera y nadie lo notaría. */
    db.prepare("INSERT INTO gal_volcados (fecha,lote_id,kilos) VALUES ('2026-11-02',10,900)").run();
    cargas(db, [['2026-11-02', 'comercial', 'IFCO HN', 10, 50],
                ['2026-11-09', 'comercial', 'IFCO HN', 7, 35]]);
    const j = await (await s.pegar('/procesos/rango')).json();
    assert.equal(j.ok, true);
    assert.equal(j.total.cargas, 2, 'sin fechas contestó vacío');
    assert.equal(j.desde, '2026-11-02', 'no arrancó en la primera carga que hay');
  } finally { s.cerrar(); }
});

t('sin sesión tampoco se lee el período', async () => {
  const s = await servidor(base(), null);
  try {
    const r = await s.pegar('/procesos/rango?desde=2026-11-01&hasta=2026-11-30');
    assert.ok(r.status === 401 || r.status === 403, 'contestó ' + r.status);
  } finally { s.cerrar(); }
});

// ── 🔢 DE DÓNDE ARRANCA EL NÚMERO DE PALLET ───────────────────────────────
// Andy, 5/11/2026: «dejame el primer pallet a armar el 269 así hacemos match
// con el sistema viejo». Acá se prueba el CABLEADO: que la pantalla pueda
// leer el próximo número, guardar el arranque, y que un valor que no puede
// funcionar se rechace ANTES de quedar escrito y sin efecto.
//
// EL AÑO NO VA ESCRITO A MANO EN NINGÚN ASSERT. La base de este archivo usa
// el DDL de verdad, que siembra el arranque del año 26: un test que diga
// «PC-26-...» pasa hoy y se cae solo en enero, sin que nada haya cambiado.
const AA = String(new Date().getFullYear()).slice(2);

t('GET /config dice cuál va a ser el próximo número de pallet', async () => {
  const s = await servidor(base(), OPERADOR);
  try {
    const r = await (await s.pegar('/config')).json();
    assert.match(r.proximo_pallet, /^PC-\d{2}-\d{5}$/,
      'el próximo número no tiene la forma del número de pallet: ' + r.proximo_pallet);
    assert.equal(typeof r.config.pallet_desde, 'number');
    assert.equal(r.config.pallet_desde_anio.length, 2, 'el año del arranque no son dos dígitos');
  } finally { s.cerrar(); }
});

t('EL ARRANQUE SE GUARDA Y EL PRÓXIMO NÚMERO LO REFLEJA', async () => {
  /* Es lo único que deja ver, ANTES de cerrar un pallet, si el arranque está
     bien: el que lo configura escribe «500» y tiene que leer «...00500». */
  const s = await servidor(base(), ADMIN);
  try {
    const g = await (await s.pegar('/config',
      put({ pallet_desde: 500, pallet_desde_anio: AA }))).json();
    assert.equal(g.ok, true, g.error);
    assert.equal(g.config.pallet_desde, 500);
    const r = await (await s.pegar('/config')).json();
    assert.equal(r.proximo_pallet, 'PC-' + AA + '-00500');
  } finally { s.cerrar(); }
});

t('un arranque con decimales se RECHAZA, no se trunca', async () => {
  /* Truncar en silencio un dato que se imprime y se pega es peor que no
     guardarlo: nadie se enteraría hasta ver el tarjetón. */
  const s = await servidor(base(), ADMIN);
  try {
    const r = await s.pegar('/config', put({ pallet_desde: '269,5' }));
    assert.equal(r.status, 400);
    const j = await (await s.pegar('/config', put({ pallet_desde: 269.5 }))).json();
    assert.equal(j.ok, false);
    assert.match(j.error, /entero/i, 'no dice qué está mal: ' + j.error);
  } finally { s.cerrar(); }
});

t('UN AÑO DE CUATRO DÍGITOS SE RECHAZA, porque quedaría sin efecto', async () => {
  /* Guardado así, el arranque está escrito en la base y el pallet sale 00001:
     el que lo configuró ve su 269 en la pantalla y le cree. */
  const s = await servidor(base(), ADMIN);
  try {
    const j = await (await s.pegar('/config',
      put({ pallet_desde: 269, pallet_desde_anio: '2026' }))).json();
    assert.equal(j.ok, false);
    assert.match(j.error, /dos dígitos/i, 'no dice qué está mal: ' + j.error);
    // Y no se guardó nada: el PUT corta antes de escribir.
    const r = await (await s.pegar('/config')).json();
    assert.notEqual(r.config.pallet_desde_anio, '2026');
  } finally { s.cerrar(); }
});

t('un arranque negativo se rechaza', async () => {
  // Un piso negativo es inerte —el máximo gana— y por eso queda guardado y sin
  // efecto: el que escribió «-269» ve su número en la pantalla y le cree.
  const s = await servidor(base(), ADMIN);
  try {
    const j = await (await s.pegar('/config', put({ pallet_desde: -269 }))).json();
    assert.equal(j.ok, false);
    assert.match(j.error, /entero/i, 'no dice qué está mal: ' + j.error);
  } finally { s.cerrar(); }
});

t('el arranque lo toca sólo el administrador', async () => {
  // Es PARAMETRIZACIÓN: un número de pallet mal empalmado se descubre con el
  // camión cargado y los tarjetones ya pegados.
  const s = await servidor(base(), OPERADOR);
  try {
    assert.equal((await s.pegar('/config', put({ pallet_desde: 1 }))).status, 403);
  } finally { s.cerrar(); }
});
