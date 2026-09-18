// ══ UN PASO NO SE GUARDA SIN NADIE QUE PUEDA RESOLVERLO (V1066) ════════════════════
//
// Pablo, 18/9/2026, con la solapa en rojo: «revisá el circuito porque hay un error raro».
//
// Qué había pasado: en «OK del supervisor» y «Confección de la orden» todas las personas
// quedaron marcadas «solo aviso» —reciben el mail pero no resuelven—, así que esos pasos
// se quedaron sin dueño. Y eso no rompe sólo esos pasos: validarDefinicion los marca como
// error y POST /solicitudes deja de aceptar solicitudes NUEVAS. El configurador lo dejó
// guardar y lo dijo después, en rojo.
//
// Y había un agujero que empuja a ese estado: tildar «Solo aviso» sin tildar «Sí» no
// guardaba a esa persona, porque el guardado sólo recorre los tildados en «Sí». Para dejar
// a alguien como watcher había que tildar las dos casillas — y quien hace eso con todas las
// personas se queda sin nadie que resuelva.
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
const MOTOR = leer('src/servicios/sp_motor.js');
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
function handler(firma) {
  const i = SP.indexOf(firma);
  assert.ok(i >= 0, 'no está la ruta: ' + firma);
  const j = SP.indexOf('(req, res) => {', i);
  const re = /\r?\n\}\)\);/g;
  re.lastIndex = j;
  const m = re.exec(SP);
  assert.ok(m, 'no cierra la ruta');
  return SP.slice(j, m.index + m[0].length - 3);
}
const linea = (re) => {
  const m = re.exec(SP);
  assert.ok(m, 'no está: ' + re);
  return m[0];
};

// ── El guardado real, sobre una base de mentira ────────────────────────────────
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE usuarios (id INTEGER PRIMARY KEY, nombre TEXT, email TEXT, rol TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sp_pasos (id INTEGER PRIMARY KEY, version_id INTEGER, clave TEXT, nombre TEXT, tipo TEXT);
    CREATE TABLE sp_paso_autorizados (id INTEGER PRIMARY KEY AUTOINCREMENT, paso_id INTEGER,
      tipo TEXT, usuario_id INTEGER, rol TEXT, area_id INTEGER, watcher INTEGER DEFAULT 0);
    INSERT INTO usuarios (id, nombre, email, rol) VALUES (1,'Pablo','pablo@lnb.com','admin'),(2,'Andres','a@lnb.com','admin');
    INSERT INTO sp_pasos (id, version_id, clave, nombre, tipo) VALUES
      (10, 1, 'autorizacion', 'OK del supervisor', 'normal'),
      (11, 1, 'fin', 'Pagada', 'final_ok');
  `);
  db.transaction = (fn) => (...a) => {
    db.exec('BEGIN');
    try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return db;
}

function rutas(db) {
  return new Function('db', 'versionActiva', 'armarSnapshot', 'validarDefinicion', [
    linea(/^const bad = .*;$/m),
    linea(/^const noEncontrado = .*;$/m),
    linea(/^const esAdmin = .*;$/m),
    SP.slice(SP.indexOf('const wrap = (fn) => (req, res) => {'), SP.indexOf('\n};', SP.indexOf('const wrap = (fn)')) + 3),
    'return { autorizados: wrap(' + handler("router.put('/circuito/pasos/:clave/autorizados'") + ') };',
  ].join('\n'))(db, () => ({ id: 1 }), () => ({ pasos: [], autorizados: {} }), () => ({ ok: true, errores: [], warnings: [] }));
}
const llamar = (h, req) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  h(Object.assign({ body: {}, params: {}, user: { id: 1, rol: 'admin' } }, req), res);
  return res;
};
// Las filas se copian a objetos comunes: node:sqlite las devuelve sin prototipo y la
// comparación estricta las distinguiría de un literal aunque digan exactamente lo mismo.
const autsDe = (db) => db.prepare('SELECT tipo, usuario_id, watcher FROM sp_paso_autorizados WHERE paso_id=10 ORDER BY id')
  .all().map((x) => ({ tipo: x.tipo, usuario_id: x.usuario_id, watcher: x.watcher }));

// ══ 1 · EL CERROJO ════════════════════════════════════════════════════════════════

test('no se puede dejar un paso con todos en «solo aviso»', () => {
  const db = base();
  const R = rutas(db);
  // El paso venía funcionando, con alguien que lo resolvía: un intento fallido no puede
  // llevarse puesta la configuración que había.
  db.prepare("INSERT INTO sp_paso_autorizados (paso_id, tipo, usuario_id, watcher) VALUES (10,'usuario',1,0)").run();
  // Lo que Pablo tenía el 18/9: las dos personas del paso, las dos como watchers.
  const r = llamar(R.autorizados, {
    params: { clave: 'autorizacion' },
    body: { autorizados: [{ tipo: 'usuario', usuario_id: 1, watcher: 1 }, { tipo: 'usuario', usuario_id: 2, watcher: 1 }] },
  });
  assert.equal(r.code, 400, 'lo guardó igual y dejó el circuito sin poder crear solicitudes');
  assert.match(r.body.error, /«OK del supervisor» quedaría sin nadie que pueda resolverlo/);
  assert.match(r.body.error, /«solo aviso» reciben el mail pero no resuelven el paso/);
  assert.match(r.body.error, /Todos los administradores/, 'no dice cómo se arregla');
  assert.deepEqual(autsDe(db), [{ tipo: 'usuario', usuario_id: 1, watcher: 0 }],
    'el intento rechazado borró la configuración que ya andaba');
});

test('con una sola persona que resuelva, se guarda —y los «solo aviso» van con ella', () => {
  const db = base();
  const R = rutas(db);
  const r = llamar(R.autorizados, {
    params: { clave: 'autorizacion' },
    body: { autorizados: [{ tipo: 'usuario', usuario_id: 1, watcher: 0 }, { tipo: 'usuario', usuario_id: 2, watcher: 1 }] },
  });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(autsDe(db), [
    { tipo: 'usuario', usuario_id: 1, watcher: 0 },
    { tipo: 'usuario', usuario_id: 2, watcher: 1 },
  ]);
  // El rol y el solicitante también cuentan como quien resuelve.
  assert.equal(llamar(R.autorizados, { params: { clave: 'autorizacion' },
    body: { autorizados: [{ tipo: 'rol', rol: 'admin' }, { tipo: 'usuario', usuario_id: 2, watcher: 1 }] } }).code, 200);
  assert.equal(llamar(R.autorizados, { params: { clave: 'autorizacion' },
    body: { autorizados: [{ tipo: 'solicitante' }] } }).code, 200);
  // Y una lista vacía sigue sin entrar.
  assert.equal(llamar(R.autorizados, { params: { clave: 'autorizacion' }, body: { autorizados: [] } }).code, 400);
});

test('en un paso final no aplica: ahí no hay nada que resolver', () => {
  const db = base();
  const R = rutas(db);
  const r = llamar(R.autorizados, {
    params: { clave: 'fin' },
    body: { autorizados: [{ tipo: 'usuario', usuario_id: 1, watcher: 1 }] },
  });
  assert.equal(r.code, 200, 'un paso final no puede quedar trabado por no tener quien lo resuelva');
});

test('el cerrojo usa la misma definición de «resuelve» que el validador', () => {
  // Si una de las dos cambiara, se podría guardar algo que el validador marca en rojo.
  assert.match(MOTOR, /const resolutores = auts\.filter\(a => !a\.watcher\);/);
  assert.match(MOTOR, /no tiene nadie habilitado para resolverlo/);
  assert.match(fuente(SP, "router.put('/circuito/pasos/:clave/autorizados'"), /!lista\.some\(a => !a\.watcher\)/);
});

// ══ 2 · LA VENTANA NO EMPUJA MÁS AL ERROR ═════════════════════════════════════════

// Las dos casillas de una persona, como en la pantalla.
function casillas(estado, extra = {}) {
  const els = [];
  const mk = (cls, uid, checked) => {
    const e = { cls, uid, checked, classList: { contains: (c) => c === cls },
      getAttribute: (k) => (k === 'data-uid' ? String(uid) : null) };
    els.push(e);
    return e;
  };
  const filas = estado.map(([uid, si, w]) => ({ si: mk('sp-aut-u', uid, si), w: mk('sp-aut-w', uid, w) }));
  const doc = {
    querySelector: (sel) => {
      const m = /\.(sp-aut-[uw])\[data-uid="(\d+)"\]/.exec(sel);
      if (m) return els.find((e) => e.cls === m[1] && e.uid === Number(m[2])) || null;
      return null;   // no hay rol admin ni solicitante tildados
    },
    querySelectorAll: (sel) => {
      const cls = sel.replace('.', '');
      const arr = els.filter((e) => e.cls === cls);
      return { forEach: (f) => arr.forEach(f), length: arr.length };
    },
    // «Todos los administradores» y «el propio solicitante» son casillas sueltas, fuera de
    // la tabla de personas, y también son gente que resuelve.
    getElementById: (id) => {
      if (id === 'sp-aut-rol-admin' && 'rolAdmin' in extra) return { checked: !!extra.rolAdmin };
      if (id === 'sp-aut-solicitante' && 'solicitante' in extra) return { checked: !!extra.solicitante };
      return null;
    },
  };
  return { filas, doc };
}
const fns = (doc) => new Function('document', [
  fuente(PANEL, 'function spAutSync(chk) {'),
  fuente(PANEL, 'function spAutResuelven() {'),
  fuente(PANEL, 'function spAutCuenta() {'),
  'return { sync: spAutSync, resuelven: spAutResuelven };',
].join('\n'))(doc);

test('tildar «solo aviso» incluye a la persona: antes ese tilde se perdía al guardar', () => {
  const { filas, doc } = casillas([[1, false, false]]);
  const F = fns(doc);
  filas[0].w.checked = true;
  F.sync(filas[0].w);
  assert.equal(filas[0].si.checked, true, 'quedó un «solo aviso» que el guardado iba a tirar a la basura');
  // Y sacar a la persona del paso le saca también el «solo aviso».
  filas[0].si.checked = false;
  F.sync(filas[0].si);
  assert.equal(filas[0].w.checked, false);
});

test('la ventana cuenta cuántos pueden resolver, y no son los que miran', () => {
  const dos = casillas([[1, true, true], [2, true, true]]);
  assert.equal(fns(dos.doc).resuelven(), 0, 'cuenta como habilitado a alguien que sólo mira');
  const mixto = casillas([[1, true, false], [2, true, true]]);
  assert.equal(fns(mixto.doc).resuelven(), 1);
  const ninguno = casillas([[1, false, false]]);
  assert.equal(fns(ninguno.doc).resuelven(), 0);
  // Tildar «Todos los administradores» alcanza, aunque todas las personas estén en «solo
  // aviso»: es la salida que el propio cartel recomienda.
  const conAdmins = casillas([[1, true, true]], { rolAdmin: true });
  assert.equal(fns(conAdmins.doc).resuelven(), 1, 'no cuenta a los administradores como quien resuelve');
  assert.equal(fns(casillas([[1, true, true]], { rolAdmin: false }).doc).resuelven(), 0);
  // Y en el paso inicial, el propio solicitante.
  assert.equal(fns(casillas([], { solicitante: true }).doc).resuelven(), 1);
});

test('sin nadie que resuelva, el botón de guardar queda frenado y dice qué tilde mover', () => {
  const cuenta = fuente(PANEL, 'function spAutCuenta() {');
  assert.match(cuenta, /Nadie puede resolver este paso/);
  assert.match(cuenta, /destildá|Dejá a alguien sin <em>solo aviso<\/em>/);
  assert.match(cuenta, /if \(btn\) \{ btn\.disabled = !n;/);
  assert.match(PANEL, /<button class="btn bb" id="sp-aut-btn" onclick="spAutGuardar\(\)">/);
  // Y el guardado tampoco lo manda, aunque alguien fuerce el botón.
  assert.match(fuente(PANEL, 'function spAutGuardar() {'), /if \(!spAutResuelven\(\)\) \{/);
  // Las tres casillas recalculan: si no, el número miente hasta reabrir la ventana.
  assert.match(PANEL, /class="sp-aut-u" data-uid="' \+ u\.id \+ '"'\s*\+ \(marcado\[u\.id\] \? ' checked' : ''\) \+ ' onchange="spAutSync\(this\)"/);
  assert.match(PANEL, /id="sp-aut-rol-admin"' \+ \(rolAdmin \? ' checked' : ''\) \+ ' onchange="spAutCuenta\(\)"/);
});

test('el cartel rojo del circuito dice cómo se arregla, no sólo qué está mal', () => {
  const render = fuente(PANEL, 'function spCircuitoRender() {');
  assert.match(render, /no tiene nadie habilitado/);
  assert.match(render, /destildá <em>solo aviso<\/em> a alguien o tildá <strong>Todos los administradores<\/strong>/);
  // Y el instructivo lo explica para todos, no sólo para el que abre el configurador.
  const ayuda = fuente(PANEL, 'function spAyudaHtml(d) {').replace(/'\r?\n\s*\+ '/g, '');
  assert.match(ayuda, /<strong>«Solo aviso» no es «habilitado»<\/strong>/);
  assert.match(ayuda, /no puede resolverlo<\/strong>/);
  assert.match(ayuda, /queda sin dueño y no se pueden crear solicitudes nuevas/);
});
