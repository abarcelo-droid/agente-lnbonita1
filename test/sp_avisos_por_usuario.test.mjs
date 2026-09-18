// ══ APAGARLE LOS MAILS A UNA PERSONA, SIN SACARLE EL PERMISO (V1065) ═══════════════
//
// Pablo, 18/9/2026: «un tema en solicitudes de órdenes de pago: necesito que me dejes
// configurar si llega mail al usuario o no, porque me llegan demasiados mails».
//
// Preguntado, eligió UN SOLO interruptor por persona —recibe los mails de pagos o no—
// y que lo configure el administrador, no cada uno el suyo.
//
// Lo que estos tests clavan:
//   · sin fila, se recibe: un usuario nuevo no nace mudo;
//   · las DOS puertas de mail (el «te toca a vos» de cada paso y las novedades al
//     solicitante) pasan por la misma función, así la tercera que alguien escriba
//     mañana no queda sin interruptor;
//   · apagar el aviso NO es sacar el permiso;
//   · si un paso queda sin nadie a quien avisar, se dice.
//
// CÓMO CORRE SIN node_modules: no se importa el router (arrastra better-sqlite3 y
// multer). Se extraen del TEXTO de src/rutas/sp.js las funciones y los dos handlers, y
// se corren sobre node:sqlite, que viene con Node 24. Lo que se ejecuta es el código
// del repo, no una copia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const SP = leer('src/rutas/sp.js');
const DBSP = leer('src/servicios/db_sp.js');
const OUTBOX = leer('src/servicios/sp_outbox.js');
const PANEL = leer('src/panel.html');

function fuente(txt, firma) {
  const i = txt.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  let prof = 0, k = txt.indexOf('{', i);
  for (; k < txt.length; k++) {
    if (txt[k] === '{') prof++;
    else if (txt[k] === '}') { prof--; if (prof === 0) break; }
  }
  return txt.slice(i, k + 1);
}
function hasta(txt, desde, fin) {
  const i = txt.indexOf(desde);
  assert.ok(i >= 0, 'no está: ' + desde.slice(0, 50));
  const j = txt.indexOf(fin, i);
  assert.ok(j > i, 'no cierra: ' + desde.slice(0, 50));
  return txt.slice(i, j + fin.length);
}
// Una ruta envuelta en wrap(): desde su (req, res) => { hasta el })); que la cierra.
function handler(firma) {
  const i = SP.indexOf(firma);
  assert.ok(i >= 0, 'no está la ruta: ' + firma);
  const j = SP.indexOf('(req, res) => {', i);
  const re = /\r?\n\}\)\);/g;
  re.lastIndex = j;
  const m = re.exec(SP);
  assert.ok(m, 'no cierra la ruta: ' + firma);
  return SP.slice(j, m.index + m[0].length - 3);
}
const linea = (re, donde = SP) => {
  const m = re.exec(donde);
  assert.ok(m, 'no está: ' + re);
  return m[0];
};

// La tabla, con el DDL de verdad: si alguien le cambia el default, estos tests lo ven.
const DDL_AVISOS = (() => {
  const i = DBSP.indexOf('CREATE TABLE IF NOT EXISTS sp_avisos_usuario');
  assert.ok(i > 0, 'no existe la tabla sp_avisos_usuario');
  return DBSP.slice(i, DBSP.indexOf(');', i) + 2);
})();

const USUARIOS = [
  [1, 'Pablo', 'pablo@lnb.com', 'admin'],
  [2, 'Ana', 'ana@lnb.com', 'operador'],
  [3, 'Beto', 'beto@lnb.com', 'operador'],
  [4, 'Sin Mail', null, 'operador'],
];

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE usuarios (id INTEGER PRIMARY KEY, nombre TEXT, email TEXT, rol TEXT,
             activo INTEGER NOT NULL DEFAULT 1);`);
  db.exec(DDL_AVISOS);
  const ins = db.prepare('INSERT INTO usuarios (id, nombre, email, rol, activo) VALUES (?,?,?,?,1)');
  for (const u of USUARIOS) ins.run(...u);
  db.transaction = (fn) => (...a) => {
    db.exec('BEGIN');
    try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return db;
}

// El circuito de mentira: dos pasos, con quién está habilitado en cada uno. Alcanza
// para preguntar "¿este paso quedaría sin nadie a quien avisar?".
const CIRCUITO = {
  pasos: [
    { clave: 'autorizacion', nombre: 'Autorización', tipo: 'normal' },
    { clave: 'tesoreria', nombre: 'Tesorería', tipo: 'normal' },
    { clave: 'nadie', nombre: 'Paso sin gente', tipo: 'normal' },
    { clave: 'fin', nombre: 'Pagada', tipo: 'final_ok' },
  ],
};
const HABILITADOS = {
  autorizacion: { resolutores: [USUARIOS[0], USUARIOS[1]].map(u => ({ id: u[0], nombre: u[1], email: u[2] })), watchers: [] },
  tesoreria: { resolutores: [{ id: 3, nombre: 'Beto', email: 'beto@lnb.com' }], watchers: [] },
  nadie: { resolutores: [{ id: 4, nombre: 'Sin Mail', email: null }], watchers: [] },
  // El paso final SÍ tiene a alguien mirando —querer enterarse de que se pagó es normal—
  // y aun así no cuenta: un paso final no manda «te toca a vos», así que apagarle el
  // aviso a Beto no deja ningún pedido esperando.
  fin: { resolutores: [], watchers: [{ id: 3, nombre: 'Beto', email: 'beto@lnb.com' }] },
};

function armar(db) {
  return new Function('db', 'versionActiva', 'armarSnapshot', 'resolverAutorizados', [
    linea(/^const bad = .*;$/m),
    linea(/^const esAdmin = .*;$/m),
    hasta(SP, 'const wrap = (fn) => (req, res) => {', '\n};'),
    fuente(SP, 'function apagados() {'),
    fuente(SP, 'function mailsDe(usuarios) {'),
    fuente(SP, 'function motivoSinDestino(usuarios) {'),
    fuente(SP, 'function pasosSinAviso(off) {'),
    'return { apagados, mailsDe, motivoSinDestino, pasosSinAviso,',
    '  ver: wrap(' + handler("router.get('/avisos-usuarios'") + '),',
    '  guardar: wrap(' + handler("router.put('/avisos-usuarios'") + ') };',
  ].join('\n'))(db, () => ({ id: 1 }), () => CIRCUITO, (def, clave) => HABILITADOS[clave] || { resolutores: [], watchers: [] });
}

const llamar = (h, req) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  h(Object.assign({ body: {}, query: {}, user: { id: 1, nombre: 'Pablo', rol: 'admin' } }, req), res);
  return res;
};
const apagar = (db, ids) => {
  const ins = db.prepare('INSERT INTO sp_avisos_usuario (usuario_id, recibe) VALUES (?,0)');
  for (const id of ids) ins.run(id);
};

// ══ 1 · EL DEFAULT ES ENTERARSE ═══════════════════════════════════════════════════

test('sin fila, se recibe: un usuario nuevo no nace mudo', () => {
  const db = base();
  const A = armar(db);
  const gente = USUARIOS.map(u => ({ id: u[0], nombre: u[1], email: u[2] }));
  assert.deepEqual(A.mailsDe(gente), ['pablo@lnb.com', 'ana@lnb.com', 'beto@lnb.com'],
    'el que no tiene mail cargado no puede recibir, pero los demás sí');
  assert.equal(A.apagados().size, 0);
  // Y el default de la tabla también lo dice, por si algún día se inserta una fila a mano.
  assert.match(DDL_AVISOS, /recibe\s+INTEGER NOT NULL DEFAULT 1/);
});

test('apagado no recibe, y apagar a uno no toca a los demás', () => {
  const db = base();
  const A = armar(db);
  apagar(db, [1]);
  const gente = USUARIOS.map(u => ({ id: u[0], nombre: u[1], email: u[2] }));
  assert.deepEqual(A.mailsDe(gente), ['ana@lnb.com', 'beto@lnb.com']);
  assert.deepEqual([...A.apagados()], [1]);
});

// ══ 2 · UNA SOLA PUERTA ═══════════════════════════════════════════════════════════
//
// Las dos funciones que mandan mail tienen que armar su lista con mailsDe(). Si una se
// arma la lista a mano, ese aviso se le sigue mandando al que lo apagó.

test('las dos puertas de mail pasan por la misma función', () => {
  const paso = fuente(SP, 'function avisarPaso(def, sol, pasoClave, eventoId) {');
  assert.match(paso, /const dest = mailsDe\(gente\);/);
  assert.ok(!/\[\.\.\.destinatarios, \.\.\.watchers\]\.map\(u => u\.email\)/.test(paso),
    'avisarPaso se volvió a armar la lista de mails a mano');
  const sol = fuente(SP, 'function avisarSolicitante(def, sol, evento, eventoId, extra) {');
  assert.match(sol, /const dest = mailsDe\(u \? \[u\] : \[\]\);/);
  assert.ok(!/destinatarios: \(u && u\.email\) \? \[u\.email\] : \[\]/.test(sol),
    'el aviso al solicitante volvió a armar la lista a mano');
  // Y el solicitante se busca CON su id: sin id no hay preferencia que mirar.
  assert.match(sol, /SELECT id, nombre, email FROM usuarios WHERE id=\?/);
});

test('apagar el aviso no es sacar el permiso', () => {
  // Quién puede resolver un paso lo decide el motor, y ahí la preferencia no entra.
  const motor = leer('src/servicios/sp_motor.js');
  assert.ok(!/sp_avisos_usuario|mailsDe|apagados\(/.test(motor),
    'la preferencia de mails se metió en quién puede resolver');
  // En el router, el filtro vive sólo en las funciones de aviso: su definición y las dos
  // puertas. Se cuenta el CÓDIGO, no los comentarios que la nombran.
  const usos = SP.split(/\r?\n/)
    .filter(l => !l.trim().startsWith('//') && l.includes('mailsDe(')).length;
  assert.equal(usos, 3, 'mailsDe se usa en otro lado además de las dos puertas (y su definición)');
  // Y la pantalla lo dice, porque es lo que evita que alguien crea que apagó un permiso.
  assert.match(PANEL, /<strong>No le saca el permiso<\/strong>: las solicitudes le siguen apareciendo en su bandeja/);
});

// ══ 3 · EL SILENCIO SE EXPLICA ════════════════════════════════════════════════════

test('el outbox dice si el mail no salió por falta de dirección o porque lo apagaron', () => {
  const db = base();
  const A = armar(db);
  const conMail = [{ id: 1, email: 'pablo@lnb.com' }];
  const sinMail = [{ id: 4, email: null }];
  assert.equal(A.motivoSinDestino(conMail), 'todos los que correspondían tienen los avisos de pagos apagados');
  assert.equal(A.motivoSinDestino(sinMail), null, 'sin mail cargado tiene que seguir diciendo lo de siempre');
  assert.equal(A.motivoSinDestino([]), null);
  // El motivo viaja hasta el registro: el outbox lo escribe en ultimo_error.
  assert.match(OUTBOX, /export function encolar\(\{ solicitudId, eventoId, dedupKey, destinatarios, asunto, cuerpo, html, motivo \}\)/);
  assert.match(OUTBOX, /motivo \|\| 'sin destinatarios con mail cargado'/);
  // Y las dos puertas lo pasan.
  assert.match(fuente(SP, 'function avisarPaso(def, sol, pasoClave, eventoId) {'),
    /motivo: dest\.length \? null : motivoSinDestino\(gente\)/);
  assert.match(fuente(SP, 'function avisarSolicitante(def, sol, evento, eventoId, extra) {'),
    /motivo: dest\.length \? null : motivoSinDestino\(u \? \[u\] : \[\]\)/);
});

test('avisa qué paso queda sin nadie a quien avisarle, y no inventa los que ya estaban vacíos', () => {
  const db = base();
  const A = armar(db);
  assert.deepEqual(A.pasosSinAviso(new Set()), [], 'con todos encendidos no hay nada que avisar');
  // Apagando a los dos de Autorización, ese paso se queda sin aviso; Tesorería no.
  assert.deepEqual(A.pasosSinAviso(new Set([1, 2])), ['Autorización']);
  assert.deepEqual(A.pasosSinAviso(new Set([1, 2, 3])), ['Autorización', 'Tesorería']);
  // El paso cuya única persona no tiene mail NO se reporta acá: ese problema es otro
  // —falta cargar la dirección— y ya lo avisa la solapa con los descartados.
  assert.ok(!A.pasosSinAviso(new Set([4])).includes('Paso sin gente'));
  // Y un paso FINAL no se reporta aunque tenga gente y esté toda apagada: ahí no hay
  // nada esperando a nadie, así que avisarlo sería ruido sobre el ruido.
  assert.ok(!A.pasosSinAviso(new Set([3])).includes('Pagada'), 'cuenta un paso final como si trabara algo');
  assert.ok(!A.pasosSinAviso(new Set([1, 2, 3, 4])).includes('Pagada'));
});

// ══ 4 · LO CONFIGURA UN ADMINISTRADOR ═════════════════════════════════════════════

test('ver y cambiar quién recibe es de administradores', () => {
  const db = base();
  const A = armar(db);
  const operador = { user: { id: 2, nombre: 'Ana', rol: 'operador' } };
  assert.equal(llamar(A.ver, operador).code, 403);
  assert.equal(llamar(A.guardar, Object.assign({ body: { apagados: [1] } }, operador)).code, 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sp_avisos_usuario').get().n, 0, 'un operador cambió la configuración');
});

test('la lista muestra a cada uno con su estado, y guardar reemplaza la lista entera', () => {
  const db = base();
  const A = armar(db);
  apagar(db, [2]);
  const ver = llamar(A.ver, {});
  assert.equal(ver.code, 200);
  assert.deepEqual(ver.body.data.map(u => [u.nombre, u.recibe]),
    [['Ana', 0], ['Beto', 1], ['Pablo', 1], ['Sin Mail', 1]]);
  assert.deepEqual(ver.body.sin_aviso, [], 'con Ana apagada, Autorización todavía tiene a Pablo');

  // Se manda la lista COMPLETA: lo que no viene, vuelve a recibir.
  const g = llamar(A.guardar, { body: { apagados: [1, 3] } });
  assert.equal(g.code, 200);
  assert.equal(g.body.apagados, 2);
  assert.deepEqual(db.prepare('SELECT usuario_id FROM sp_avisos_usuario ORDER BY usuario_id').all().map(x => x.usuario_id),
    [1, 3], 'Ana tenía que volver a recibir');
  assert.deepEqual(g.body.sin_aviso, ['Tesorería'], 'apagar a Beto deja Tesorería sin nadie a quien avisar');
  // Queda quién lo cambió: es una parametrización que después alguien va a preguntar.
  assert.equal(db.prepare('SELECT actualizado_por FROM sp_avisos_usuario WHERE usuario_id=1').get().actualizado_por, 1);

  // Una lista vacía deja a todos recibiendo.
  assert.equal(llamar(A.guardar, { body: { apagados: [] } }).body.apagados, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sp_avisos_usuario').get().n, 0);
  // Y lo que no es una lista se rechaza: un body mal armado no puede dejar a todos sin avisos.
  assert.equal(llamar(A.guardar, { body: {} }).code, 400);
  assert.equal(llamar(A.guardar, { body: { apagados: 'todos' } }).code, 400);
});

// ══ 5 · LA PANTALLA ═══════════════════════════════════════════════════════════════

test('la ventana está fuera de toda pantalla, y el botón la abre desde Circuito y avisos', () => {
  // Regla del panel: una ventana que cuelga de una .sec sólo se abre desde ésa.
  const i = PANEL.indexOf('<div class="ab-modal-overlay" id="sp-mb-avisos">');
  assert.ok(i > 0, 'no está la ventana');
  const secAntes = PANEL.lastIndexOf('<div class="sec', i);
  const cierreSec = PANEL.lastIndexOf('</div>\n\n<!-- Modal', i);
  assert.ok(secAntes < cierreSec || PANEL.slice(secAntes, i).includes('</div>'), 'la ventana quedó adentro de una pantalla');
  assert.match(PANEL, /<button class="btn bo bs" onclick="spAvisosAbrir\(\)" style="font-size:11px">🔕 Quién recibe los avisos<\/button>/);
  assert.match(fuente(PANEL, 'function spAvisosAbrir() {'), /spApi\('\/avisos-usuarios'\)/);
});

test('se guardan los DESTILDADOS, y si algún paso queda sin aviso se dice al guardar', () => {
  const g = fuente(PANEL, 'function spAvisosGuardar() {');
  assert.match(g, /if \(!chk\.checked\) apagados\.push/, 'manda los que SÍ reciben: quedaría al revés');
  assert.match(g, /method: 'PUT', body: JSON\.stringify\(\{ apagados: apagados \}\)/);
  assert.match(g, /if \(r\.sin_aviso && r\.sin_aviso\.length\)/);
  assert.match(g, /nadie va a recibir el aviso de/);
  // Al abrir también se ve el estado de hoy.
  assert.match(fuente(PANEL, 'function spAvisosPintar(sinAviso) {'), /spAvisosAlerta\(sinAviso\)/);
  assert.match(fuente(PANEL, 'function spAvisosAlerta(sinAviso) {'), /nadie recibe el aviso/);
});

test('el instructivo dice dónde se apagan los mails, y que apagarlos no saca nada', () => {
  // El texto viaja partido en varios strings concatenados: se unen para leerlo como lo
  // lee el operador, o una frase cortada al medio parecería no estar.
  const ayuda = fuente(PANEL, 'function spAyudaHtml(d) {').replace(/'\r?\n\s*\+ '/g, '');
  assert.match(ayuda, /<strong>Si te llegan demasiados mails<\/strong>, un administrador te los puede apagar desde/);
  assert.match(ayuda, /Circuito y avisos → Quién recibe los avisos/);
  assert.match(ayuda, /las solicitudes te siguen apareciendo en tu bandeja y las seguís pudiendo resolver/);
  // Y el bloque de la solapa ya no dice que no se puede configurar, porque ahora se puede.
  assert.ok(!/No hay una configuración de mails aparte/.test(PANEL), 'la solapa sigue diciendo que no se configura');
  assert.ok(!/No se configura aparte: si la dirección está mal/.test(PANEL));
});
