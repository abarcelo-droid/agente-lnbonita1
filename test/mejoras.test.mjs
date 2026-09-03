// ══ MEJORAS — EL BUZÓN DE LO QUE HAY QUE ARREGLAR ══════════════════════════
//
// Pablo, 2/9/2026: «cada usuario puede proponer ahí algo para mejorar en cada uno
// de los menús con los que le toca interactuar. Es para UNIFICAR CANALES DE
// COMUNICACIÓN. Obviamente sólo podrá proponer cosas sobre los menús en los que
// TIENE ACCESO. Los administradores vamos a poder asignarles prioridad del 1 al 5
// para que vean en qué estado están sus pedidos, y cuando estén resueltos
// marcarlos como resueltos».
//
// LO QUE ESTE ARCHIVO PROTEGE, EN ORDEN DE IMPORTANCIA:
//
//  1. «Sólo sobre los menús en los que tiene acceso». Es la única regla del pedido
//     que puede fallar en silencio, y se prueba CORRIENDO permisos.js de verdad
//     contra una base real — no leyendo el código.
//  2. Que la validación esté también en el POST y no sólo en el selector: un
//     <select> del navegador se edita en diez segundos.
//  3. Que cada uno vea lo suyo y el administrador vea todo.
//  4. Que el orden de la lista responda la pregunta del pedido —«en qué estado
//     están mis pedidos»—: lo pendiente arriba, y adentro lo urgente primero.
//
// CÓMO CORRE SIN node_modules. Igual que plata_sg.test.mjs: se copia
// src/servicios a un temporal y se reemplaza SÓLO db.js por un doble que abre una
// base de node:sqlite de verdad. Lo que se ejecuta es el permisos.js del repo, sin
// ninguna rama «si estoy en un test».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUTA = fs.readFileSync(path.join(RAIZ, 'src/rutas/mejoras.js'), 'utf8');
const DDL = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_mejoras.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SIDEBAR = fs.readFileSync(path.join(RAIZ, 'src/sidebar-v2.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(RAIZ, 'src/index.js'), 'utf8');

// ── 1 · SÓLO SOBRE LOS MENÚS QUE USA — CORRIENDO permisos.js DE VERDAD ─────

let _mod = null;
async function permisosReales(db) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mejoras-'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/servicios'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(RAIZ, 'src/servicios', f), path.join(dir, f));
  }
  // El único doble: db.js. Devuelve la base REAL de este test, así que las
  // consultas de permisos.js corren contra tablas de verdad.
  fs.writeFileSync(path.join(dir, 'db.js'),
    'export default globalThis.__MEJ_DB; export const getDb = () => globalThis.__MEJ_DB;\n'
    + 'export function rehacerTabla(){}\n', 'utf8');
  // db_permisos crea usuario_modulos con better-sqlite3: acá la crea el test.
  fs.writeFileSync(path.join(dir, 'db_permisos.js'), 'export default globalThis.__MEJ_DB;\n', 'utf8');
  globalThis.__MEJ_DB = db;
  _mod = await import('file:///' + path.join(dir, 'permisos.js').replace(/\\/g, '/') + '?t=' + dir);
  return _mod;
}

function baseConMenus() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE modulos_config (modulo TEXT PRIMARY KEY, label TEXT, grupo TEXT,
      sociedad_id INTEGER, area_id INTEGER, tipo TEXT, orden INTEGER, oculto INTEGER DEFAULT 0);
    CREATE TABLE usuario_modulos (usuario_id INTEGER, modulo TEXT, nivel TEXT);
    INSERT INTO modulos_config (modulo, label, grupo, orden, oculto) VALUES
      ('sg-stock',   'Stock',              'Administración de ventas', 200, 0),
      ('sg-ordenes', 'Órdenes de Compra',  'Administración de compras', 210, 0),
      ('fp',         'Planificación Financiera', 'Contabilidad', 300, 0),
      ('oculto-x',   'Pantalla apagada',   'Contabilidad', 310, 1);
    -- Camila trabaja en stock y mira las órdenes; de finanzas no sabe nada.
    INSERT INTO usuario_modulos VALUES (7,'sg-stock','operar'), (7,'sg-ordenes','ver');
  `);
  return db;
}

const CAMILA = { id: 7, rol: 'operador', nombre: 'Camila' };
const JEFE = { id: 1, rol: 'admin', nombre: 'Pablo' };

test('el selector trae SÓLO las pantallas que la persona usa', async () => {
  const db = baseConMenus();
  const { modulosVisibles } = await permisosReales(db);
  const mods = modulosVisibles(CAMILA).map((m) => m.modulo).sort();
  assert.deepEqual(mods, ['sg-ordenes', 'sg-stock']);
  db.close();
});

test('el administrador las ve todas, menos las apagadas', async () => {
  const db = baseConMenus();
  const { modulosVisibles } = await permisosReales(db);
  const mods = modulosVisibles(JEFE).map((m) => m.modulo).sort();
  assert.deepEqual(mods, ['fp', 'sg-ordenes', 'sg-stock'],
    'una pantalla oculta no se puede proponer: no existe para nadie');
  db.close();
});

test('sin permisos cargados no puede proponer sobre nada', async () => {
  // Y eso NO es un error: es la respuesta. Que le pida los permisos a un
  // administrador, que es la única manera de avanzar.
  const db = baseConMenus();
  const { modulosVisibles } = await permisosReales(db);
  assert.deepEqual(modulosVisibles({ id: 99, rol: 'operador' }), []);
  db.close();
});

test('y la regla que valida el POST es la MISMA, no una copia', async () => {
  // Si el POST usara su propia consulta, el día que cambie la regla de permisos
  // el selector diría una cosa y el servidor otra. Ya pasó dos veces en el repo.
  const db = baseConMenus();
  const { nivelEnModulo } = await permisosReales(db);
  assert.equal(nivelEnModulo(CAMILA, 'sg-stock'), 'operar');
  assert.equal(nivelEnModulo(CAMILA, 'fp'), null, 'no trabaja en finanzas: no propone ahí');
  assert.equal(nivelEnModulo(JEFE, 'fp'), 'anular');
  db.close();
});

test('el router usa esas dos funciones y no inventa una consulta propia', () => {
  assert.match(RUTA, /import \{ modulosVisibles, nivelEnModulo \} from '\.\.\/servicios\/permisos\.js';/);
  assert.match(RUTA, /modulosVisibles\(req\.user\)/);
  assert.match(RUTA, /!esAdmin\(req\) && !nivelEnModulo\(req\.user, modulo\)/);
  // Y no hay ningún SELECT sobre usuario_modulos acá: la regla vive en un lugar.
  assert.ok(!/usuario_modulos/.test(RUTA), 'el router se copió la regla de permisos');
});

test('el <select> se edita: el POST rebota igual', () => {
  const i = RUTA.indexOf("router.post('/', conFoto");
  const b = RUTA.slice(i, RUTA.indexOf('\n}));', i));
  assert.match(b, /Sólo se pueden proponer mejoras sobre las pantallas que usás/);
  assert.match(b, /rechazar\(req, res, 403,/);
  // Y una pantalla que no existe tampoco entra.
  assert.match(b, /SELECT modulo, label FROM modulos_config WHERE modulo = \? AND oculto = 0/);
  assert.match(b, /Esa pantalla no existe/);
});

// ── 2 · CADA UNO VE LO SUYO ────────────────────────────────────────────────

test('el que propone ve las suyas; el administrador ve todas', () => {
  const i = RUTA.indexOf("router.get('/', wrap");
  const b = RUTA.slice(i, RUTA.indexOf('\n}));', i));
  assert.match(b, /if \(!esAdmin\(req\)\) \{ cond\.push\('m\.usuario_id = \?'\); params\.push\(req\.user\.id\); \}/);
  assert.match(b, /soy_admin: esAdmin\(req\) \? 1 : 0/);
});

// ── 3 · EL ORDEN CONTESTA LA PREGUNTA DEL PEDIDO ───────────────────────────
//
// «Para que vean en qué estado están sus pedidos». Se corre contra SQLite con el
// ORDER BY sacado del router: si alguien lo toca, el test lo dice.

function baseConMejoras() {
  const db = new DatabaseSync(':memory:');
  // El DDL sale del archivo del repo, no de una copia: si cambia una columna, el
  // test corre contra la tabla nueva.
  const ddl = DDL.slice(DDL.indexOf('CREATE TABLE IF NOT EXISTS mejoras'), DDL.indexOf('`);'));
  db.exec(ddl);
  db.exec(`CREATE TABLE modulos_config (modulo TEXT PRIMARY KEY, label TEXT, oculto INTEGER DEFAULT 0);
    INSERT INTO modulos_config VALUES ('sg-stock','Stock',0);`);
  const ins = db.prepare(`INSERT INTO mejoras (id, modulo, texto, usuario_id, prioridad, estado)
    VALUES (?,?,?,?,?,?)`);
  ins.run(1, 'sg-stock', 'sin prioridad, vieja', 7, null, 'propuesta');
  ins.run(2, 'sg-stock', 'urgente', 7, 1, 'propuesta');
  ins.run(3, 'sg-stock', 'algún día', 7, 5, 'propuesta');
  ins.run(4, 'sg-stock', 'ya está hecha', 7, 1, 'resuelta');
  ins.run(5, 'sg-stock', 'sin prioridad, nueva', 7, null, 'propuesta');
  return db;
}

// El ORDER BY se extrae del router: no se copia acá, o el test protegería su
// propia copia.
function ordenDelRouter() {
  const i = RUTA.indexOf('ORDER BY (m.estado');
  assert.ok(i > 0, 'no está el ORDER BY de la lista — ¿se reescribió la consulta?');
  return RUTA.slice(i, RUTA.indexOf('`', i)).trim();
}

test('lo pendiente arriba, lo urgente primero, y lo que nadie miró antes que lo resuelto', () => {
  const db = baseConMejoras();
  const ids = db.prepare('SELECT id FROM mejoras m ' + ordenDelRouter()).all().map((r) => r.id);
  // Adentro de cada escalón manda el id descendente: entre dos que nadie miró,
  // arriba la más nueva — es la que el que la propuso está esperando ver.
  assert.deepEqual(ids, [2, 3, 5, 1, 4],
    'urgente(2) → algún día(3) → las sin prioridad, la nueva primero (5,1) → la resuelta(4)');
  db.close();
});

test('«sin prioridad» va al fondo de lo pendiente, no al final de todo', () => {
  // Son las que NADIE MIRÓ todavía: si quedaran abajo de las resueltas, el
  // administrador no las ve nunca y el que las propuso tampoco entiende por qué.
  const db = baseConMejoras();
  const filas = db.prepare('SELECT id, estado, prioridad FROM mejoras m ' + ordenDelRouter()).all();
  const iSinPrio = filas.findIndex((f) => f.prioridad == null);
  const iResuelta = filas.findIndex((f) => f.estado === 'resuelta');
  assert.ok(iSinPrio < iResuelta, 'lo que nadie miró quedó abajo de lo ya hecho');
  db.close();
});

// ── 4 · PRIORIZAR Y RESOLVER SON DE ADMINISTRADOR ──────────────────────────

test('poner prioridad y marcar resuelta las hace un administrador', () => {
  for (const ruta of ["router.patch('/:id/prioridad', soloAdmin",
    "router.post('/:id/resolver', soloAdmin", "router.post('/:id/reabrir', soloAdmin"]) {
    assert.ok(RUTA.includes(ruta), 'falta el candado de administrador en: ' + ruta);
  }
  assert.match(RUTA, /Priorizar y marcar resuelto es de administradores/);
  // Proponer NO: eso lo hace cualquiera. Es el punto del buzón.
  const i = RUTA.indexOf("router.post('/', conFoto");
  assert.ok(!RUTA.slice(i, i + 120).includes('soloAdmin'), 'proponer se volvió de administradores');
});

test('la prioridad va del 1 al 5, y vaciarla es válido', () => {
  const i = RUTA.indexOf("router.patch('/:id/prioridad'");
  const b = RUTA.slice(i, RUTA.indexOf('\n}));', i));
  assert.match(b, /if \(!Number\.isInteger\(p\) \|\| p < 1 \|\| p > 5\)/);
  assert.match(b, /La prioridad va del 1 al 5/);
  // Vacío vuelve a «sin prioridad», que es el estado de lo que nadie miró.
  assert.match(b, /UPDATE mejoras SET prioridad = NULL WHERE id = \?/);
});

test('reabrir borra el rastro de la resolución anterior', () => {
  // Si no, la pantalla muestra «resuelta el 2/9» en algo que está abierto.
  const i = RUTA.indexOf("router.post('/:id/reabrir'");
  const b = RUTA.slice(i, RUTA.indexOf('\n}));', i));
  assert.match(b, /resuelta_en = NULL, resuelta_por = NULL, resuelta_nota = NULL/);
});

// ── 5 · LA FOTO ────────────────────────────────────────────────────────────

test('la foto es opcional y se guarda donde se puede ver', () => {
  // '/data/sg/' es la carpeta que index.js sirve estática: con otra ruta el
  // archivo se guarda igual y la foto no se ve nunca.
  assert.match(RUTA, /const UPLOAD_DIR = path\.join\(__dirname, '\.\.\/\.\.\/data\/sg'\);/);
  assert.match(RUTA, /req\.file \? \('\/data\/sg\/' \+ req\.file\.filename\) : null,/);
  assert.match(INDEX, /app\.use\("\/data\/sg",\s+express\.static/);
  // Nada la exige.
  const i = RUTA.indexOf("router.post('/', conFoto");
  const b = RUTA.slice(i, RUTA.indexOf('\n}));', i));
  assert.ok(!/falta la foto|foto requerida/i.test(b), 'la foto se volvió obligatoria');
});

test('una foto de 12 MB contesta en castellano, no un HTML roto', () => {
  // Sin envolver a multer, pasarse del límite devuelve un HTML 500 y el panel se
  // come un error de JSON en vez de decir qué pasó.
  assert.match(RUTA, /function conFoto\(req, res, next\) \{/);
  assert.match(RUTA, /err\.code === 'LIMIT_FILE_SIZE'/);
  assert.match(RUTA, /La foto no puede pesar más de 10 MB\./);
  assert.match(RUTA, /limits: \{ fileSize: 10 \* 1024 \* 1024 \}/);
});

// ── 6 · LA TABLA, SIN ATARSE A OTROS MÓDULOS ───────────────────────────────

test('sin foreign keys hacia usuarios ni hacia modulos_config', () => {
  // db.js corre con foreign_keys=ON: una FK desde acá haría fallar los DELETE de
  // esos módulos. Es la regla del repo.
  assert.ok(!/REFERENCES/i.test(DDL), 'la tabla se ató a otro módulo con una FK');
  assert.match(DDL, /usuario_id\s+INTEGER NOT NULL/);
  assert.match(DDL, /modulo\s+TEXT NOT NULL/);
});

test('guarda el nombre de la pantalla y de quien propuso, no sólo los ids', () => {
  // A los seis meses un módulo se renombra o alguien se va, y la mejora tiene que
  // seguir diciendo sobre qué pantalla era y quién la pidió.
  assert.match(DDL, /modulo_label\s+TEXT/);
  assert.match(DDL, /usuario_nombre TEXT/);
  assert.match(RUTA, /modulo, mod\.label \|\| null, texto,/);
  assert.match(RUTA, /req\.user\.id, req\.user\.nombre \|\| null\);/);
  // Y la lista muestra el label de HOY cuando el módulo todavía existe.
  assert.match(RUTA, /LEFT JOIN modulos_config c ON c\.modulo = m\.modulo/);
});

// ── 7 · LA PANTALLA ────────────────────────────────────────────────────────

test('el ítem está FUERA de todos los menús y arriba de COMERCIAL', () => {
  // Pablo: «como un menú aparte arriba de donde dice comercial». Va suelto,
  // arriba del divisor de «Menú completo», con favoritos y recientes.
  const i = SIDEBAR.indexOf('sb2-fastlane mej');
  assert.ok(i > 0, 'no está el ítem de Mejoras en el sidebar');
  const j = SIDEBAR.indexOf('<div class="sb2-divider">', i);
  const k = SIDEBAR.indexOf('id="sb2-grupos"', i);
  assert.ok(j > i && k > j, 'el ítem quedó abajo del menú completo');
  assert.match(SIDEBAR.slice(i, j), /data-sec="mejoras"/);
});
test('y SE VE: lleva rótulo propio, como Favoritos y Recientes', () => {
  // Sin el rótulo era una cajita con un renglón suelto adentro, y a simple vista
  // parecía un hueco entre Recientes y «Menú completo». Pablo: «no me aparece».
  //
  // Los tres bloques sueltos del menú se arman igual: .sb2-fastlane con su
  // .sb2-group-sec arriba. El que no lo lleva no se lee como una sección.
  const i = SIDEBAR.indexOf('sb2-fastlane mej');
  const b = SIDEBAR.slice(i, SIDEBAR.indexOf('<div class="sb2-divider">', i));
  assert.match(b, /<div class="sb2-group-sec">/);
  assert.ok(b.includes('<span class="sb2-label">\u{1F4A1} Mejoras</span>'),
    'el bloque no lleva su rótulo');
  // Y el renglón dice qué se hace, no repite el título.
  assert.ok(b.includes('<span class="sb2-ni-text">Proponer una mejora</span>'),
    'el renglón no dice qué se hace ahí');
});

test('el CSS le da color propio al rótulo y al renglón, como a los otros dos', () => {
  const CSS = fs.readFileSync(path.join(RAIZ, 'src/sidebar-v2.css'), 'utf8');
  assert.ok(CSS.includes('.sb2-fastlane.mej .sb2-group-sec{ color: #9FE3B8 }'),
    'el rótulo no tiene color propio');
  assert.ok(CSS.includes('.sb2-fastlane.mej .sb2-ni{ color: rgba(255,255,255,.92) }'),
    'el renglón no tiene color propio');
  // El tinte tiene que verse sobre un fondo oscuro: con 7% no se distinguía del
  // hueco que había al lado.
  const m = CSS.match(/\.sb2-fastlane\.mej\{ background: rgba\(\d+,\d+,\d+,\.(\d+)\)/);
  assert.ok(m, 'no está el fondo del bloque');
  assert.ok(Number(m[1]) >= 10, 'el fondo del bloque quedó demasiado transparente');
});


test('y navega: existe el .ni puente del nav viejo', () => {
  // El menú que se ve lo dibuja sidebar-v2, pero el que NAVEGA es el <nav>
  // escondido: navigateTo busca ahí el .ni y le simula un click. Sin ese
  // renglón el ítem se pinta y no abre nada.
  assert.match(PANEL, /<div class="ni" data-sec="mejoras">/);
  assert.match(PANEL, /<div class="sec sg-mod" id="sec-mejoras">/);
  // Y entrar a la pantalla la carga.
  // Hay cuatro «var m = {» en el panel: se ancla en el mapa de secciones.
  const i = PANEL.indexOf('inicio: loadInicio, pedidos: loadPedidos');
  assert.ok(i > 0, 'no se encontró el mapa de carga de secciones');
  assert.match(PANEL.slice(i - 300, i + 60), /mejoras: mejLoad,/);
});

test('la tabla no pide barra de desplazamiento lateral', () => {
  const i = PANEL.indexOf('id="sec-mejoras"');
  const b = PANEL.slice(i, i + 2600);
  assert.match(b, /overflow-x:hidden !important/);
  assert.match(b, /table-layout:fixed/);
  const anchos = [...b.matchAll(/<th style="width:(\d+)%/g)].map((m) => Number(m[1]));
  assert.equal(anchos.length, 6, 'la tabla no tiene seis columnas con ancho fijo');
  assert.equal(anchos.reduce((a, x) => a + x, 0), 100, 'los anchos no suman 100%');
});

test('al que no es administrador no se le ofrece el selector de prioridad', () => {
  // Ofrecer un control que va a contestar 403 hace creer que se rompió algo.
  const i = PANEL.indexOf('function mejCeldaPrioridad(x){');
  const b = PANEL.slice(i, PANEL.indexOf('\r\n}', i));
  assert.match(b, /if \(!MEJ\.admin\)\{/);
  assert.ok(b.indexOf('<select') > b.indexOf('if (!MEJ.admin)'),
    'el selector se dibuja antes de preguntar quién es');
  // Y «quién soy» sale de la RESPUESTA DEL SERVIDOR, no de la cookie: la cookie
  // se edita y lo que decide es el servidor.
  const j = PANEL.indexOf('function mejLoad(){');
  assert.match(PANEL.slice(j, j + 500), /MEJ\.admin = !!\(r && r\.soy_admin\);/);
});

test('el texto que escribe el operador no puede romper la pantalla', () => {
  // Lo escribe una persona: si va con esc(), un «<» se come el resto de la fila.
  const i = PANEL.indexOf('function mejPintar(){');
  const b = PANEL.slice(i, PANEL.indexOf('\r\n}', i));
  assert.match(b, /escH\(x\.texto \|\| ''\)/);
  assert.match(b, /escH\(x\.resuelta_nota\)/);
  assert.match(b, /escH\(x\.usuario_nombre \|\| '—'\)/);
  assert.ok(!/esc\(x\.texto/.test(b), 'el texto libre volvió a esc()');
});

test('tiene su «¿Cómo se usa?», con su versión', () => {
  assert.match(PANEL, /onclick="sgManualAbrir\('mejoras'\)">❓ ¿Cómo se usa\?<\/button>/);
  const i = PANEL.indexOf('SG_MANUAL.mejoras = {');
  assert.ok(i > 0, 'Mejoras no tiene manual');
  const m = PANEL.slice(i, PANEL.indexOf('\r\n};', i));
  const plano = m.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
  for (const campo of ['¿Sobre qué pantalla?', '¿Qué habría que mejorar?', 'Foto',
    'Prioridad', 'Marcar como resuelta']) {
    assert.ok(m.includes(campo), 'al manual le falta: ' + campo);
  }
  assert.ok(plano.includes('sólo las que usás') || plano.includes('sólo las que usás'),
    'el manual no dice que aparecen sólo las pantallas que usa');
  assert.match(m, /Qué cambió, y desde cuándo/);
  const actual = Number((SIDEBAR.match(/const VERSION = 'V(\d+)'/) || [])[1]);
  const vs = (m.match(/<span class="ver">V(\d+)<\/span>/g) || [])
    .map((v) => Number(v.match(/V(\d+)/)[1]));
  assert.ok(vs.length >= 3, 'el manual no lleva el registro de versiones');
  // Y cada campo lleva la suya, que la arma sgManCampo al dibujar.
  assert.ok((m.match(/, 'V\d+'\)/g) || []).length >= 5,
    'los campos del manual no están anotados con su versión');
  for (const v of [997, 998]) {
    assert.ok(vs.includes(v), 'falta anotar el cambio de la V' + v + ' en el manual de Mejoras');
  }
  for (const n of vs) assert.ok(n <= actual, 'el manual cita la V' + n + ' y el panel va en la V' + actual);
});

// ── 8 · Y ESTÁ MONTADO ─────────────────────────────────────────────────────

test('el router está montado, y proponer no exige nivel en ningún módulo', () => {
  assert.match(INDEX, /import mejorasRouter\s+from "\.\/rutas\/mejoras\.js";/);
  assert.match(INDEX, /app\.use\("\/api\/mejoras", mejorasRouter\);/);
  // A propósito NO se declara el prefijo en ensure_api_prefijos: proponer lo hace
  // cualquiera, y sobre qué pantalla lo decide el router mirando sus permisos.
  const PREF = fs.readFileSync(path.join(RAIZ, 'src/servicios/ensure_api_prefijos.js'), 'utf8');
  assert.ok(!/['"]mejoras['"]/.test(PREF),
    'se declaró el prefijo: ahora proponer una mejora necesita permisos sobre Mejoras');
});


// ── 9 · UN VISOR TAMBIÉN TIENE QUE PODER PROPONER ──────────────────────────
//
// index.js monta bloquearSiSoloLectura sobre TODO /api y rebota cualquier POST de
// un usuario con solo_lectura=1. Ese usuario es JUSTAMENTE el que se pasa el día
// mirando pantallas: dejarlo afuera del único canal que hay lo manda de vuelta al
// WhatsApp, que es lo que este módulo vino a sacar.

test('el usuario de sólo lectura puede proponer una mejora', () => {
  const AUTH = fs.readFileSync(path.join(RAIZ, 'src/rutas/auth.js'), 'utf8');
  const i = AUTH.indexOf('function bloquearSiSoloLectura');
  assert.ok(i > 0);
  const b = AUTH.slice(i, i + 3000);
  assert.match(b, /url\.indexOf\('\/api\/mejoras'\) === 0 && metodo === 'POST'/);
  // Y la excepción está entre las demás excepciones, no antes del chequeo.
  assert.ok(b.indexOf("/api/auth/logout") < b.indexOf('/api/mejoras'),
    'la excepción quedó fuera del bloque de excepciones');
});

test('…pero no puede priorizar ni marcar resuelto', () => {
  // Eso es de administradores, y un administrador nunca llega a este middleware.
  const AUTH = fs.readFileSync(path.join(RAIZ, 'src/rutas/auth.js'), 'utf8');
  const i = AUTH.indexOf("url.indexOf('/api/mejoras') === 0");
  const linea = AUTH.slice(i, AUTH.indexOf('return next();', i));
  assert.ok(linea.includes('(prioridad|resolver|reabrir)'),
    'la excepción no distingue el alta de las acciones de administrador');
  // Y se corre la regla, no se la lee: sólo el alta pasa.
  const pasa = (u, m) => u.indexOf('/api/mejoras') === 0 && m === 'POST'
    && !/\/(prioridad|resolver|reabrir)$/.test(u.split('?')[0]);
  assert.equal(pasa('/api/mejoras', 'POST'), true);
  assert.equal(pasa('/api/mejoras/12/resolver', 'POST'), false);
  assert.equal(pasa('/api/mejoras/12/reabrir', 'POST'), false);
  assert.equal(pasa('/api/mejoras/12/prioridad', 'PATCH'), false);
  assert.equal(pasa('/api/sg/lotes', 'POST'), false, 'la excepción se abrió a otras rutas');
});

test('Mejoras no le come un lugar a los Recientes', () => {
  // renderRecientes filtra por MODULO_INDEX y «mejoras» no está ahí, así que se
  // descartaba al dibujar — pero antes le sacaba uno de los cuatro lugares a un
  // módulo de verdad. Y no lo necesita: ya está fijo arriba de todo.
  const i = SIDEBAR.indexOf('function pushReciente(modulo){');
  const b = SIDEBAR.slice(i, SIDEBAR.indexOf('\n}', i));
  assert.match(b, /if \(modulo === 'mejoras'\) return;/);
  assert.ok(b.indexOf("modulo === 'mejoras'") < b.indexOf('unshift'),
    'se guarda antes de descartarlo');
});


// ── 10 · LA FOTO NO PUEDE SER UN .html ─────────────────────────────────────
//
// Esto lo encontró la revisión adversarial y es lo más caro del cambio.
//
// data/sg la sirve express.static ANTES del portón de sesión, así que todo lo que
// entre por acá queda en una URL del MISMO ORIGEN que el panel y alcanzable sin
// cookie. Sin lista blanca, un archivo llamado «foto.html» con un <script> se
// guarda igual; el administrador —que es el que revisa el buzón— lo abre con un
// clic, y ese script corre con su sesión contra toda la API.
//
// Y esta puerta es la MÁS abierta del sistema: proponer lo puede hacer cualquiera,
// hasta un usuario de sólo lectura.

// Se ejecuta el filtro DEL REPO, no una copia: se corta desde la lista blanca
// hasta el cierre de las opciones de multer, y se le pasan dobles mínimos de
// `path` y de `multer` para poder evaluarlo sin node_modules.
function filtroDeFotos() {
  const i = RUTA.indexOf('const EXT_IMAGEN =');
  assert.ok(i > 0, 'no existe la lista blanca de extensiones');
  const fin = RUTA.indexOf('\n});', RUTA.indexOf('fileFilter:', i));
  assert.ok(fin > i, 'no se pudo cortar la configuración de multer');
  const src = RUTA.slice(i, fin + 4);
  const pathDoble = {
    extname: (n) => { const k = String(n).lastIndexOf('.'); return k < 0 ? '' : String(n).slice(k); },
  };
  // multer(opciones) devuelve las opciones: lo que se quiere probar es el filtro.
  const multerDoble = (o) => o;
  multerDoble.diskStorage = (o) => o;
  // eslint-disable-next-line no-new-func
  return new Function('path', 'multer', src + '\nreturn { EXT_IMAGEN, opciones: subir };')(
    pathDoble, multerDoble);
}

test('un archivo .html con un script adentro NO se guarda', () => {
  const { opciones } = filtroDeFotos();
  let err = null, ok = null;
  opciones.fileFilter({}, { originalname: 'foto.html', mimetype: 'text/html' },
    (e, v) => { err = e; ok = v; });
  assert.ok(err, 'dejó subir un .html: el administrador lo abre y el script corre con su sesión');
  assert.equal(err.code, 'TIPO_NO_PERMITIDO');
  assert.match(err.message, /Se puede adjuntar una foto/);
});

test('ni un .svg, que también ejecuta script al abrirlo', () => {
  const { opciones } = filtroDeFotos();
  let err = null;
  opciones.fileFilter({}, { originalname: 'x.svg', mimetype: 'image/svg+xml' }, (e) => { err = e; });
  assert.ok(err, 'un .svg abierto en una pestaña ejecuta su <script> igual que un .html');
});

test('ni un .html disfrazado de image/png', () => {
  // El mimetype lo manda el que sube: no se le puede creer solo.
  const { opciones } = filtroDeFotos();
  let err = null;
  opciones.fileFilter({}, { originalname: 'x.html', mimetype: 'image/png' }, (e) => { err = e; });
  assert.ok(err, 'alcanzó con mentir el mimetype');
});

test('ni un .jpg cuyo mimetype dice text/html', () => {
  const { opciones } = filtroDeFotos();
  let err = null;
  opciones.fileFilter({}, { originalname: 'x.jpg', mimetype: 'text/html' }, (e) => { err = e; });
  assert.ok(err, 'alcanzó con mentir la extensión');
});

test('y una foto de verdad entra', () => {
  const { opciones } = filtroDeFotos();
  for (const [n, t] of [['a.jpg', 'image/jpeg'], ['b.PNG', 'image/png'],
    ['c.webp', 'image/webp'], ['d.heic', 'image/heic']]) {
    let err = null, ok = null;
    opciones.fileFilter({}, { originalname: n, mimetype: t }, (e, v) => { err = e; ok = v; });
    assert.equal(err, null, 'rebotó una foto legítima: ' + n);
    assert.equal(ok, true);
  }
});

test('el nombre del archivo escrito sale de la lista blanca, no del que subieron', () => {
  // Aunque el filtro dejara pasar algo, el archivo en disco nunca puede terminar
  // en .html: la extensión se elige, no se copia.
  const i = RUTA.indexOf('const storage = multer.diskStorage');
  const b = RUTA.slice(i, RUTA.indexOf('});', i));
  assert.match(b, /const ext = EXT_IMAGEN\.includes\(extDe\(file\)\) \? extDe\(file\) : '\.jpg';/);
});

// ── 11 · NADA QUEDA COLGADO, NI SE RESUELVE DOS VECES ──────────────────────

test('si la propuesta se rechaza, la foto no queda colgada en el volumen', () => {
  // multer escribe el archivo ANTES del handler: sin esto queda un archivo sin
  // ninguna fila que lo nombre y sin nadie que lo borre nunca.
  assert.match(RUTA, /function rechazar\(req, res, codigo, error\) \{/);
  assert.match(RUTA, /if \(req\.file\) \{ try \{ fs\.unlinkSync\(req\.file\.path\); \}/);
  const i = RUTA.indexOf("router.post('/', conFoto");
  const b = RUTA.slice(i, RUTA.indexOf('\n}));', i));
  // TODAS las salidas de error del alta pasan por ahí.
  assert.equal((b.match(/rechazar\(req, res,/g) || []).length, 5);
  assert.ok(!/return res\.status\(4\d\d\)/.test(b), 'quedó una salida que no borra la foto');
});

test('dos administradores a la vez no la resuelven dos veces', () => {
  // Mirar el estado y escribirlo son dos momentos: el segundo pisaba la nota del
  // primero y quedaba figurando él como quien la resolvió.
  const i = RUTA.indexOf("router.post('/:id/resolver'");
  const b = RUTA.slice(i, RUTA.indexOf('\n}));', i));
  assert.match(b, /WHERE id = \? AND estado <> 'resuelta'/);
  assert.match(b, /if \(!r\.changes\)/);
  const j = RUTA.indexOf("router.post('/:id/reabrir'");
  const c = RUTA.slice(j, RUTA.indexOf('\n}));', j));
  assert.match(c, /WHERE id = \? AND estado = 'resuelta'/);
  assert.match(c, /if \(!r\.changes\)/);
});

// ── 12 · LA QUE SALIÓ MAL SE PUEDE BORRAR, HASTA QUE ALGUIEN LA MIRE ───────

test('el autor borra la suya mientras nadie le puso prioridad', () => {
  const i = RUTA.indexOf("router.delete('/:id'");
  assert.ok(i > 0, 'no se puede borrar una propuesta mal cargada');
  const b = RUTA.slice(i, RUTA.indexOf('\n}));', i));
  assert.match(b, /Number\(fila\.usuario_id\) !== Number\(req\.user\.id\)/);
  assert.match(b, /Sólo podés borrar las que propusiste vos/);
  assert.match(b, /fila\.estado === 'resuelta' \|\| fila\.prioridad != null/);
  assert.match(b, /Ya la miró un administrador/);
  // Y la foto se va con ella.
  assert.match(b, /fs\.unlinkSync\(path\.join\(UPLOAD_DIR, path\.basename\(fila\.foto_ruta\)\)\)/);
});

test('y el botón sólo aparece mientras se puede', () => {
  const i = PANEL.indexOf('function mejCeldaEstado(x){');
  const b = PANEL.slice(i, PANEL.indexOf('\r\n}', i));
  assert.match(b, /x\.prioridad == null/);
  assert.match(b, /onclick="mejBorrar\(' \+ x\.id \+ '\)"/);
  assert.ok(PANEL.includes('function mejBorrar(id){'), 'mejBorrar no está definida');
});

test('el manual no promete una agrupación que la pantalla no hace', () => {
  const i = PANEL.indexOf('SG_MANUAL.mejoras = {');
  const m = PANEL.slice(i, PANEL.indexOf('\r\n};', i));
  const plano = m.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
  assert.ok(!plano.includes('tres personas piden lo mismo'),
    'volvió a prometer que se agrupa lo repetido');
  assert.ok(plano.includes('Borrar la propia'), 'no cuenta que la propia se puede borrar');
});
