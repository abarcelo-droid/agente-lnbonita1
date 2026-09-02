// ══ EL MAIL DE UNA PERSONA ES UNO SOLO ═════════════════════════════════════
//
// Pablo, 1/9/2026: «actualicé un mail en usuarios pero no se me actualiza acá para
// enviarle las notificaciones. Fijate que los mails que tenés son distintos».
//
// El dato vivía en DOS tablas:
//
//   personas.mail    — la ficha del organigrama, que es donde se edita
//   usuarios.email   — a dónde salen los avisos (órdenes de pago y todo lo demás)
//
// Y se copiaba UNA sola vez, al crear el usuario desde la persona. Después nunca
// más. El que corregía el mail en la ficha lo daba por hecho, y los avisos seguían
// saliendo al viejo — o al `campo_nombre@interno.lnb` que el sistema le había
// inventado cuando la persona todavía no tenía mail cargado.
//
// Nadie se entera de que un mail no llegó: simplemente no llega.
//
// NO SE JUNTAN LAS DOS TABLAS: `usuarios` es la credencial y `personas` la ficha, y
// hay usuarios sin persona. Lo que se hace es que no puedan decir cosas distintas.
//
// Y se puede cambiar sin dejar a nadie afuera: el login entra por username, por
// mail o por nombre, así que cambiar el mail no le cierra la puerta a nadie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  esMailReal, normalizarMail, sincronizarMailAUsuario, sincronizarMailAPersona,
  arrastrarMailesDePersonas, mailesQueNoCoinciden, buscarUsuarioDePersona,
} from '../src/servicios/mail_persona.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG = fs.readFileSync(path.join(RAIZ, 'src/rutas/org.js'), 'utf8');
const AUTH = fs.readFileSync(path.join(RAIZ, 'src/rutas/auth.js'), 'utf8');
const DBORG = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_org.js'), 'utf8');

// La base de la captura de pantalla: los mismos nombres y los mismos mails.
//
// `personas.activo` va porque está en el esquema real (db_org.js) y el arrastre lo
// filtra: una tabla de prueba a la que le falta una columna hace que la consulta
// tire, el catch se lo coma y el test pase por una razón que no es la que dice.
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE personas (id INTEGER PRIMARY KEY, nombre TEXT, apellido TEXT, mail TEXT,
      activo INTEGER DEFAULT 1);
    CREATE TABLE usuarios (id INTEGER PRIMARY KEY, nombre TEXT, email TEXT UNIQUE,
      activo INTEGER DEFAULT 1, persona_id INTEGER);
    INSERT INTO personas (id,nombre,apellido,mail) VALUES
      (1,'Alejandro','Aracena','a.aracena@lnbonita.com.ar'),  -- se le cargó el mail después
      (2,'Camila','Persampieri','c.persampieri@lnbonita.com.ar'),
      (3,'Belen','Argañaras',NULL),                            -- todavía sin mail
      (4,'Carlos','Barcelo','carlos.nuevo@barcelotransporte.com.ar'),
      -- EL CASO DE CAMILA: el usuario existe desde antes que el organigrama, así
      -- que NO tiene persona_id. Es el que el primer arreglo no encontraba.
      (5,'Sergio','Viduherio','s.viduherio@lnbonita.com.ar'),
      -- Y dos homónimos: no se elige, mandar el mail de uno al otro es peor.
      (6,'Juan','Perez','juan.nuevo@lnbonita.com.ar');
    INSERT INTO usuarios VALUES
      (1,'Alejandro Aracena','campo_alejandro_aracena@interno.lnb',1,1),
      (2,'Camila Persampieri','c.persampieri@lnbonita.com.ar',1,2),
      (3,'Belen Argañaras','campo_belen_argaaras@interno.lnb',1,3),
      (4,'Carlos Barcelo','carlos@barcelotransporte.com.ar',1,4),
      (5,'Sergio Viduherio','campo_sergio_viduherio@interno.lnb',1,NULL),
      (6,'Juan Perez','juan1@lnbonita.com.ar',1,NULL),
      (7,'Juan Perez','juan2@lnbonita.com.ar',1,NULL),
      (9,'Usuario suelto','suelto@lnbonita.com.ar',1,NULL);
  `);
  return db;
}

// ── 1 · QUÉ ES UN MAIL DE VERDAD ───────────────────────────────────────────

test('el interno autogenerado no es una dirección', () => {
  // Es un relleno para cumplir con el NOT NULL de la columna. No le llega nada, y
  // por eso se puede pisar sin preguntarle a nadie.
  assert.equal(esMailReal('campo_alejandro_aracena@interno.lnb'), false);
  assert.equal(esMailReal('a.aracena@lnbonita.com.ar'), true);
  assert.equal(esMailReal(''), false);
  assert.equal(esMailReal(null), false);
  assert.equal(esMailReal('   '), false);
  assert.equal(esMailReal('sinarroba'), false);
});

test('y se compara sin distinguir mayúsculas ni espacios', () => {
  assert.equal(normalizarMail('  A.Aracena@LNBonita.com.ar '), 'a.aracena@lnbonita.com.ar');
});

test('el mismo mail con otra capitalización cuenta como el mismo', () => {
  // Si la comparación fuera literal, este caso se "arrastraría" en cada arranque:
  // el UPDATE corre siempre, la fila queda igual, y el contador dice que hizo algo
  // que no hizo. Nunca converge y el log miente todos los deploys.
  const db = base();
  db.prepare("UPDATE usuarios SET email='C.Persampieri@LNBonita.com.ar' WHERE id=2").run();
  assert.equal(sincronizarMailAUsuario(db, 2, 'c.persampieri@lnbonita.com.ar').estado, 'ya_estaba');
  const p = db.prepare("SELECT mail FROM personas WHERE id=2").get();
  db.prepare("UPDATE personas SET mail='C.Persampieri@LNBonita.com.ar' WHERE id=2").run();
  assert.equal(sincronizarMailAPersona(db, 2, p.mail).estado, 'ya_estaba');
  db.close();
});

// ── 1b · ENCONTRAR AL USUARIO DE UNA PERSONA ───────────────────────────────
//
// Pablo, después del primer arreglo: «no estás tomando bien el mail de Camila, no
// funciona». El vínculo `usuarios.persona_id` SÓLO se escribe cuando el usuario se
// crea desde la ficha; los que ya existían antes del organigrama lo tienen en NULL.
// El primer arreglo buscaba sólo por ahí, no encontraba nada, y se callaba.

test('lo encuentra por el vínculo cuando existe', () => {
  const db = base();
  const h = buscarUsuarioDePersona(db, 2);
  assert.equal(h.como, 'vinculo');
  assert.equal(h.usuario.id, 2);
  db.close();
});

test('y SIN vínculo lo encuentra igual, por el nombre completo', () => {
  // ES EL CASO QUE FALLABA. El usuario de Sergio existe desde antes que el
  // organigrama: persona_id en NULL, mail interno autogenerado.
  const db = base();
  const h = buscarUsuarioDePersona(db, 5);
  assert.equal(h.como, 'nombre');
  assert.equal(h.usuario.id, 5);
  db.close();
});

test('o por el mail que la ficha tenía antes, que no admite duda', () => {
  // Si la ficha decía X y hay un usuario con X, es la misma persona.
  const db = base();
  db.prepare("UPDATE usuarios SET persona_id=NULL WHERE id=4").run();
  db.prepare("UPDATE personas SET mail='carlos@barcelotransporte.com.ar' WHERE id=4").run();
  const h = buscarUsuarioDePersona(db, 4);
  assert.equal(h.como, 'mail_anterior');
  assert.equal(h.usuario.id, 4);
  db.close();
});

test('con dos homónimos NO elige', () => {
  // Mandarle el mail de uno al otro es peor que no mandarlo.
  const db = base();
  const h = buscarUsuarioDePersona(db, 6);
  assert.equal(h.como, 'homonimos');
  assert.equal(h.usuario, null);
  assert.equal(sincronizarMailAUsuario(db, 6, 'juan.nuevo@lnbonita.com.ar').estado, 'homonimos');
  assert.equal(db.prepare('SELECT email FROM usuarios WHERE id=6').get().email, 'juan1@lnbonita.com.ar');
  db.close();
});

test('y al encontrarlo sin vínculo, lo deja vinculado', () => {
  // Para que la próxima vez entre por el camino firme y esto no se vuelva a apoyar
  // en adivinar.
  const db = base();
  assert.equal(db.prepare('SELECT persona_id FROM usuarios WHERE id=5').get().persona_id, null);
  sincronizarMailAUsuario(db, 5, 's.viduherio@lnbonita.com.ar');
  assert.equal(db.prepare('SELECT persona_id FROM usuarios WHERE id=5').get().persona_id, 5);
  assert.equal(db.prepare('SELECT email FROM usuarios WHERE id=5').get().email,
    's.viduherio@lnbonita.com.ar');
  db.close();
});

// ── 2 · LA FICHA EMPUJA AL USUARIO ─────────────────────────────────────────

test('corregir el mail en la ficha llega al usuario', () => {
  // ES EL BUG. Antes esto no pasaba y los avisos seguían al mail viejo.
  const db = base();
  const r = sincronizarMailAUsuario(db, 1, 'a.aracena@lnbonita.com.ar');
  assert.equal(r.estado, 'actualizado');
  assert.equal(db.prepare('SELECT email FROM usuarios WHERE id=1').get().email,
    'a.aracena@lnbonita.com.ar');
  db.close();
});

test('la persona sin usuario no rompe nada', () => {
  const db = base();
  db.prepare('DELETE FROM usuarios WHERE persona_id=1').run();
  assert.equal(sincronizarMailAUsuario(db, 1, 'x@y.com').estado, 'sin_usuario');
  db.close();
});

test('y si el mail ya está ocupado por otro, la ficha se guarda igual', () => {
  // La columna es UNIQUE. Voltear el guardado de la ficha por el sincronismo sería
  // peor que la desincronización: se informa y se sigue.
  const db = base();
  const r = sincronizarMailAUsuario(db, 1, 'c.persampieri@lnbonita.com.ar');
  assert.equal(r.estado, 'ocupado');
  assert.equal(db.prepare('SELECT email FROM usuarios WHERE id=1').get().email,
    'campo_alejandro_aracena@interno.lnb', 'no se pisó');
  db.close();
});

test('vaciar el mail en la ficha NO deja al usuario sin dirección', () => {
  // La columna es NOT NULL, y además dejar a alguien sin mail por un campo que
  // quedó en blanco es sacarlo de todos los avisos sin decírselo.
  const db = base();
  assert.equal(sincronizarMailAUsuario(db, 2, '').estado, 'sin_mail');
  assert.equal(sincronizarMailAUsuario(db, 2, null).estado, 'sin_mail');
  assert.equal(db.prepare('SELECT email FROM usuarios WHERE id=2').get().email,
    'c.persampieri@lnbonita.com.ar');
  db.close();
});

// ── 3 · Y EL USUARIO DEVUELVE A LA FICHA ───────────────────────────────────

test('corregirlo en Usuarios vuelve a la ficha', () => {
  // Sin esto se arregla de un lado y al rato alguien lo "arregla" del otro, y las
  // dos pantallas vuelven a decir cosas distintas.
  const db = base();
  const r = sincronizarMailAPersona(db, 4, 'carlos@barcelotransporte.com.ar');
  assert.equal(r.estado, 'actualizado');
  assert.equal(db.prepare('SELECT mail FROM personas WHERE id=4').get().mail,
    'carlos@barcelotransporte.com.ar');
  db.close();
});

test('el usuario sin persona vinculada no rompe nada', () => {
  const db = base();
  assert.equal(sincronizarMailAPersona(db, 9, 'otro@lnbonita.com.ar').estado, 'sin_persona');
  db.close();
});

// ── 4 · LO QUE YA QUEDÓ DESFASADO ──────────────────────────────────────────

test('el arrastre pisa el interno y deja quieto lo que es una decisión', () => {
  // Sincronizar de acá en adelante no arregla lo de atrás, y nadie va a reabrir
  // dieciocho fichas para guardarlas de nuevo.
  const db = base();
  mailesQueNoCoinciden.length = 0;
  const r = arrastrarMailesDePersonas(db);

  // Alejandro tenía el interno y la ficha ya traía su mail: se pisa.
  assert.equal(db.prepare('SELECT email FROM usuarios WHERE id=1').get().email,
    'a.aracena@lnbonita.com.ar');
  // Belén no tiene mail en la ficha: se queda con el interno, no se le inventa nada.
  assert.equal(db.prepare('SELECT email FROM usuarios WHERE id=3').get().email,
    'campo_belen_argaaras@interno.lnb');
  // Camila ya coincidía: no se toca ni se cuenta.
  assert.equal(db.prepare('SELECT email FROM usuarios WHERE id=2').get().email,
    'c.persampieri@lnbonita.com.ar');
  // Carlos tiene DOS mails reales distintos: elegir uno es adivinar. Queda anotado.
  assert.equal(db.prepare('SELECT email FROM usuarios WHERE id=4').get().email,
    'carlos@barcelotransporte.com.ar', 'se pisó un mail real');
  // Y SERGIO, que es el caso que el primer arreglo no encontraba: su usuario existe
  // desde antes que el organigrama y no tiene el vínculo. Se lo encuentra por el
  // nombre completo y se le arrastra el mail.
  assert.equal(db.prepare('SELECT email FROM usuarios WHERE id=5').get().email,
    's.viduherio@lnbonita.com.ar');
  assert.equal(r.arrastrados, 2, 'Alejandro (por vínculo) y Sergio (por nombre)');
  assert.equal(mailesQueNoCoinciden.length, 1);
  assert.equal(mailesQueNoCoinciden[0].motivo, 'los_dos_son_reales');
  assert.equal(mailesQueNoCoinciden[0].usuario, 'Carlos Barcelo');
  db.close();
});

test('correrlo dos veces no cambia nada la segunda', () => {
  // Corre en cada arranque: si no fuera idempotente, cada deploy haría algo
  // distinto.
  const db = base();
  mailesQueNoCoinciden.length = 0;
  arrastrarMailesDePersonas(db);
  const foto = db.prepare('SELECT id, email FROM usuarios ORDER BY id').all();
  const r2 = arrastrarMailesDePersonas(db);
  assert.deepEqual(db.prepare('SELECT id, email FROM usuarios ORDER BY id').all(), foto);
  assert.equal(r2.arrastrados, 0);
  db.close();
});

test('y una base sin la tabla personas no tumba el arranque', () => {
  // Corre al importar db_org.js. Si tirara, no levanta el servidor.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE usuarios (id INTEGER PRIMARY KEY, email TEXT)');
  const r = arrastrarMailesDePersonas(db);
  assert.equal(r.arrastrados, 0);
  db.close();
});

// ── 5 · Y ESTÁ ENGANCHADO DONDE SE EDITA ───────────────────────────────────

test('la ficha lo dispara al guardar, y contesta qué pasó', () => {
  // Un sincronismo silencioso que a veces no ocurre es peor que ninguno.
  const i = ORG.indexOf("router.patch('/personas/:id'");
  assert.ok(i > 0);
  const b = ORG.slice(i, i + 4000);
  assert.match(b, /if \(mail !== undefined && esMailReal\(mail\)\) \{\r?\n\s*mailUsuario = sincronizarMailAUsuario\(db\(\), id, mail\);/);
  assert.match(b, /res\.json\(\{ ok: true, mail_usuario: mailUsuario \}\);/);
  assert.match(ORG, /import \{ sincronizarMailAUsuario, esMailReal \} from '\.\.\/servicios\/mail_persona\.js';/);
});

test('y la pantalla de Usuarios también, en el otro sentido', () => {
  const i = AUTH.indexOf("router.patch('/usuarios/:id'");
  assert.ok(i > 0);
  const b = AUTH.slice(i, i + 4200);
  assert.match(b, /sincronizarMailAPersona\(db, Number\(req\.params\.id\), emailFinal\)/);
  assert.match(b, /mail_persona: mailPersona/);
  assert.match(AUTH, /import \{ sincronizarMailAPersona \} from '\.\.\/servicios\/mail_persona\.js';/);
});

test('el arrastre corre al arrancar, después de crear el vínculo', () => {
  // persona_id se agrega con un ALTER en ese mismo archivo: correr antes sería
  // consultar una columna que todavía no existe.
  const i = DBORG.indexOf('ALTER TABLE usuarios ADD COLUMN persona_id');
  // Al arranque del renglón: comentada, la llamada sigue estando en el texto y el
  // test seguiría en verde con el arrastre apagado.
  const j = DBORG.search(/\r?\narrastrarMailesDePersonas\(db\);/);
  assert.ok(i > 0, 'no está el ALTER de persona_id');
  assert.ok(j > i, 'el arrastre no corre, o corre antes de que exista persona_id');
});

// ── 5b · Y LA PANTALLA LO DICE ─────────────────────────────────────────────
//
// El primer arreglo sincronizaba y no se veía: el cartel decía «Persona guardada»
// tanto cuando el mail viajaba como cuando no encontraba a quién actualizarlo.
// Justamente el error que estos avisos existen para evitar —enterarse de que algo
// no llegó— estaba en la pantalla que lo arregla.

test('el cartel dice a dónde van a salir los avisos, o por qué no van a salir', () => {
  const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
  const i = PANEL.indexOf('function eqMailAviso(m) {');
  assert.ok(i > 0, 'el guardado no dice nada del mail');
  const b = PANEL.slice(i, i + 1400);
  // Los tres casos en que el mail NO llega tienen que decirlo, no pasar por «ok».
  assert.match(b, /no tiene usuario en el sistema: no le van a llegar avisos/);
  assert.match(b, /hay dos usuarios con ese mismo nombre y no se sabe cuál es/);
  assert.match(b, /ese mail ya lo tiene otro usuario: los avisos siguen /);
  // Y cuando sí llega, dice a dónde.
  assert.match(b, /'Persona guardada · los avisos ya salen a ' \+ m\.email/);
  // Los tres problemas salen en rojo.
  const j = PANEL.indexOf('function eqMailProblema(m) {');
  assert.match(PANEL.slice(j, j + 250),
    /\['sin_usuario', 'homonimos', 'ocupado'\]\.indexOf\(m\.estado\) >= 0/);
  // Y el guardado lo usa.
  const k = PANEL.indexOf('function eqGuardarPersona() {');
  assert.match(PANEL.slice(k, k + 2200), /toast\(eqMailAviso\(r\.mail_usuario\)/);
});

// ── 6 · Y LOS AVISOS SIGUEN MIRANDO usuarios ───────────────────────────────

test('las notificaciones leen usuarios.email — por eso había que sincronizarlo', () => {
  // Es la razón de todo esto: si el aviso saliera de personas.mail, no haría falta
  // nada. Sale de usuarios, así que usuarios tiene que estar al día.
  const SP = fs.readFileSync(path.join(RAIZ, 'src/rutas/sp.js'), 'utf8');
  assert.match(SP, /SELECT nombre, email FROM usuarios WHERE id=\?/);
  assert.match(SP, /SELECT id, nombre, email, rol FROM usuarios/);
});
