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
  arrastrarMailesDePersonas, mailesQueNoCoinciden,
} from '../src/servicios/mail_persona.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG = fs.readFileSync(path.join(RAIZ, 'src/rutas/org.js'), 'utf8');
const AUTH = fs.readFileSync(path.join(RAIZ, 'src/rutas/auth.js'), 'utf8');
const DBORG = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_org.js'), 'utf8');

// La base de la captura de pantalla: los mismos nombres y los mismos mails.
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE personas (id INTEGER PRIMARY KEY, nombre TEXT, apellido TEXT, mail TEXT);
    CREATE TABLE usuarios (id INTEGER PRIMARY KEY, nombre TEXT, email TEXT UNIQUE,
      activo INTEGER DEFAULT 1, persona_id INTEGER);
    INSERT INTO personas VALUES
      (1,'Alejandro','Aracena','a.aracena@lnbonita.com.ar'),  -- se le cargó el mail después
      (2,'Camila','Persampieri','c.persampieri@lnbonita.com.ar'),
      (3,'Belen','Argañaras',NULL),                            -- todavía sin mail
      (4,'Carlos','Barcelo','carlos.nuevo@barcelotransporte.com.ar');
    INSERT INTO usuarios VALUES
      (1,'Alejandro Aracena','campo_alejandro_aracena@interno.lnb',1,1),
      (2,'Camila Persampieri','c.persampieri@lnbonita.com.ar',1,2),
      (3,'Belen Argañaras','campo_belen_argaaras@interno.lnb',1,3),
      (4,'Carlos Barcelo','carlos@barcelotransporte.com.ar',1,4),
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
  assert.equal(r.arrastrados, 1);
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

// ── 6 · Y LOS AVISOS SIGUEN MIRANDO usuarios ───────────────────────────────

test('las notificaciones leen usuarios.email — por eso había que sincronizarlo', () => {
  // Es la razón de todo esto: si el aviso saliera de personas.mail, no haría falta
  // nada. Sale de usuarios, así que usuarios tiene que estar al día.
  const SP = fs.readFileSync(path.join(RAIZ, 'src/rutas/sp.js'), 'utf8');
  assert.match(SP, /SELECT nombre, email FROM usuarios WHERE id=\?/);
  assert.match(SP, /SELECT id, nombre, email, rol FROM usuarios/);
});
