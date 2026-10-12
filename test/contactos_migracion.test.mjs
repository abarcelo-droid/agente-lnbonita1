// ══ LA MIGRACIÓN A EMPRESAS ═══════════════════════════════════════════════════
//
// Es lo único de este módulo que NO se puede "arreglar después": si parte mal los
// datos, no hay vuelta. Por eso tiene su propio archivo.
//
// La V1090 colgaba los productos, el tipo, la zona y el vínculo con la planilla de
// la PERSONA. Esta migración los sube a la EMPRESA y agrupa a las personas que
// compartían el texto del campo `empresa`.
//
// Pablo, 9/10/2026: «tenés que dejar relacionar a dos personas con la misma
// empresa, donde la empresa es la que tiene la venta de producción de cada
// producto».
//
// El test corre el MÓDULO DE VERDAD —db_sg_contactos.js— contra una base armada con
// el DDL VIEJO, que es el que está en producción. Un test que armara la base con el
// DDL nuevo no probaría nada: la migración sólo tiene trabajo que hacer sobre la
// forma anterior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/servicios/db_sg_contactos.js', import.meta.url), 'utf8');

// El DDL tal como quedó en main con el #1090. Escrito a mano a propósito: es una foto de
// lo que hay en producción, y tiene que quedar fija aunque el archivo del repo cambie.
const VIEJO = `
CREATE TABLE sg_contactos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, empresa TEXT, cargo TEXT,
  tipo TEXT NOT NULL DEFAULT 'otro', zona TEXT, localidad TEXT,
  cliente_nombre TEXT, proveedor_nombre TEXT, vendedor TEXT, etiquetas TEXT, notas TEXT,
  activo INTEGER NOT NULL DEFAULT 1, creado_por_id INTEGER,
  creado_en TEXT, actualizado_en TEXT, eliminado_en TEXT);
CREATE TABLE sg_contacto_medios (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contacto_id INTEGER NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'telefono', valor TEXT NOT NULL, nota TEXT,
  preferido INTEGER NOT NULL DEFAULT 0, creado_en TEXT);
CREATE TABLE sg_contacto_productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contacto_id INTEGER NOT NULL, producto TEXT NOT NULL,
  variedad TEXT, meses TEXT NOT NULL DEFAULT '000000000000', volumen TEXT, notas TEXT,
  creado_en TEXT);
CREATE TABLE sg_contacto_charlas (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contacto_id INTEGER NOT NULL, fecha TEXT NOT NULL,
  canal TEXT NOT NULL DEFAULT 'telefono', resumen TEXT NOT NULL, proximo_paso TEXT,
  proximo_el TEXT, hecho_en TEXT, usuario_id INTEGER, usuario TEXT, creado_en TEXT,
  eliminado_en TEXT);
`;

// Corre el módulo real con la db de prueba en lugar de la del repo.
function migrar(db) {
  globalThis.__dbMig = db;
  new Function(SRC.replace('import db from "./db.js";', 'const db = globalThis.__dbMig;')
                  .replace(/export default db;\s*$/, ''))();
}
const vieja = () => { const db = new DatabaseSync(':memory:'); db.exec(VIEJO); return db; };
const cols = (db, t) => db.prepare('SELECT name FROM pragma_table_info(?)').all(t).map((r) => r.name);

// ── EL CASO QUE MOTIVÓ EL CAMBIO ──────────────────────────────────────────────
function dosPersonasDeLaMismaFinca() {
  const db = vieja();
  const c = db.prepare(`INSERT INTO sg_contactos
    (nombre,empresa,cargo,tipo,zona,localidad,proveedor_nombre,vendedor,etiquetas,notas)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const juan = Number(c.run('Juan Giglio', 'GIGLIO HNOS SRL', 'Dueño', 'proveedor',
    'San Juan', 'Pocito', 'GIGLIO', 'ANA', 'confiable', null).lastInsertRowid);
  // El encargado, cargado después y con la mitad de los datos en blanco. Es como pasa de
  // verdad: el segundo contacto de una finca lo carga otra persona y otro día.
  const pepe = Number(c.run('Pepe Giglio', 'GIGLIO HNOS SRL', 'Encargado', 'proveedor',
    null, null, null, null, null, 'Atiende el galpón').lastInsertRowid);
  const prod = db.prepare(
    'INSERT INTO sg_contacto_productos (contacto_id,producto,variedad,meses,volumen) VALUES (?,?,?,?,?)');
  prod.run(juan, 'MELON', 'Amarillo', '000011111000', '2 camiones');   // NOV a MAR
  prod.run(pepe, 'MELON', null, '000001111100', null);                 // DIC a ABR, el mismo corrido
  prod.run(juan, 'CEBOLLA', null, '110000000000', null);
  db.prepare("INSERT INTO sg_contacto_medios (contacto_id,tipo,valor,preferido) VALUES (?,'telefono','264 155-8899',1)").run(juan);
  db.prepare("INSERT INTO sg_contacto_charlas (contacto_id,fecha,canal,resumen) VALUES (?,'2026-08-20','telefono','Planta brócoli')").run(pepe);
  return { db, juan, pepe };
}

test('las dos personas quedan en UNA empresa', () => {
  const { db } = dosPersonasDeLaMismaFinca();
  migrar(db);
  const emps = db.prepare('SELECT * FROM sg_contacto_empresas').all();
  assert.equal(emps.length, 1, 'quedaron ' + emps.map((e) => e.nombre).join(' | '));
  assert.equal(emps[0].nombre, 'GIGLIO HNOS SRL');
  assert.equal(db.prepare('SELECT COUNT(DISTINCT empresa_id) n FROM sg_contactos').get().n, 1);
});

test('lo que era de la cuenta sube a la empresa', () => {
  const { db } = dosPersonasDeLaMismaFinca();
  migrar(db);
  const e = db.prepare('SELECT * FROM sg_contacto_empresas').get();
  assert.equal(e.tipo, 'proveedor');
  assert.equal(e.zona, 'San Juan');
  assert.equal(e.localidad, 'Pocito');
  assert.equal(e.proveedor_nombre, 'GIGLIO', 'se perdió el vínculo con la planilla');
  assert.equal(e.vendedor, 'ANA');
  assert.equal(e.etiquetas, 'confiable');
});

test('y lo que es de la persona se queda con la persona', () => {
  const { db } = dosPersonasDeLaMismaFinca();
  migrar(db);
  const ps = db.prepare('SELECT nombre, cargo, notas FROM sg_contactos ORDER BY id').all();
  assert.equal(ps[0].cargo, 'Dueño');
  assert.equal(ps[1].cargo, 'Encargado');
  assert.equal(ps[1].notas, 'Atiende el galpón');
});

test('el teléfono y la charla no se mueven de su persona', () => {
  const { db, juan, pepe } = dosPersonasDeLaMismaFinca();
  migrar(db);
  assert.equal(db.prepare('SELECT contacto_id FROM sg_contacto_medios').get().contacto_id, juan);
  assert.equal(db.prepare('SELECT contacto_id FROM sg_contacto_charlas').get().contacto_id, pepe);
});

test('EL MELÓN DUPLICADO QUEDA EN UNO SOLO', () => {
  // Es el destrozo que la migración viene a arreglar: dos filas del mismo melón, una por
  // persona, con ventanas que se contradicen y ninguna pantalla capaz de decir cuál vale.
  const { db } = dosPersonasDeLaMismaFinca();
  migrar(db);
  const melones = db.prepare("SELECT * FROM sg_contacto_productos WHERE producto='MELON'").all();
  assert.equal(melones.length, 1, 'quedaron ' + melones.map((m) => m.meses).join(' y '));
});

test('y las dos ventanas SE SUMAN, no se descarta una', () => {
  // NOV-MAR del dueño y DIC-ABR del encargado dan NOV-ABR. Quedarse con una sola sería
  // tirar lo que la otra persona contó, y nadie puede saber cuál de las dos estaba mejor
  // informada.
  const { db } = dosPersonasDeLaMismaFinca();
  migrar(db);
  const melon = db.prepare("SELECT * FROM sg_contacto_productos WHERE producto='MELON'").get();
  assert.equal(melon.meses, '000011111100');
  // Y lo que una de las dos tenía cargado y la otra no, se conserva.
  assert.equal(melon.variedad, 'Amarillo');
});

test('la cebolla, que estaba una sola vez, pasa sin tocarse', () => {
  const { db } = dosPersonasDeLaMismaFinca();
  migrar(db);
  const c = db.prepare("SELECT * FROM sg_contacto_productos WHERE producto='CEBOLLA'").all();
  assert.equal(c.length, 1);
  assert.equal(c[0].meses, '110000000000');
});

test('todos los productos cuelgan de la empresa', () => {
  const { db } = dosPersonasDeLaMismaFinca();
  migrar(db);
  const e = db.prepare('SELECT id FROM sg_contacto_empresas').get();
  const pr = db.prepare('SELECT empresa_id FROM sg_contacto_productos').all();
  assert.ok(pr.length > 0);
  assert.ok(pr.every((p) => p.empresa_id === e.id), JSON.stringify(pr));
});

// ── CORRE DOS VECES SIN HACER DESTROZOS ───────────────────────────────────────
test('CORRERLA DE NUEVO NO DUPLICA NADA', () => {
  // Railway reinicia el server cada deploy, así que esto corre muchas veces. Una migración
  // que no es idempotente duplica la agenda entera en el segundo arranque.
  const { db } = dosPersonasDeLaMismaFinca();
  migrar(db);
  migrar(db);
  migrar(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contacto_empresas').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contacto_productos').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contactos').get().n, 2);
});

// ── EL QUE TRABAJA SOLO ───────────────────────────────────────────────────────
test('sin empresa escrita, LA EMPRESA ES LA PERSONA', () => {
  // La alternativa era un empresa_id nulo y los mismos campos duplicados en las dos
  // tablas — o sea dos lugares de donde leer el tipo y la zona, y dos respuestas distintas
  // el día que una se toque y la otra no. Un fletero que trabaja solo ES una cuenta
  // comercial de una persona.
  const db = vieja();
  db.prepare("INSERT INTO sg_contactos (nombre,tipo,empresa) VALUES ('Raúl el fletero','otro',NULL)").run();
  db.prepare("INSERT INTO sg_contactos (nombre,tipo,empresa) VALUES ('Ana sin nada','cliente','   ')").run();
  migrar(db);
  const nombres = db.prepare('SELECT nombre FROM sg_contacto_empresas ORDER BY nombre').all().map((e) => e.nombre);
  assert.deepEqual(nombres, ['Ana sin nada', 'Raúl el fletero']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contactos WHERE empresa_id IS NULL').get().n, 0);
});

test('un espacio en blanco no crea una empresa llamada "   "', () => {
  const db = vieja();
  db.prepare("INSERT INTO sg_contactos (nombre,tipo,empresa) VALUES ('Ana','cliente','   ')").run();
  migrar(db);
  assert.equal(db.prepare('SELECT nombre FROM sg_contacto_empresas').get().nombre, 'Ana');
});

test('el tipo de cada uno se respeta', () => {
  const db = vieja();
  db.prepare("INSERT INTO sg_contactos (nombre,tipo,empresa) VALUES ('A','cliente','UNA SA')").run();
  db.prepare("INSERT INTO sg_contactos (nombre,tipo,empresa) VALUES ('B','proveedor','OTRA SA')").run();
  migrar(db);
  const t = {};
  for (const e of db.prepare('SELECT nombre, tipo FROM sg_contacto_empresas').all()) t[e.nombre] = e.tipo;
  assert.deepEqual(t, { 'UNA SA': 'cliente', 'OTRA SA': 'proveedor' });
});

test('si la primera persona dejó el tipo en "otro", la segunda lo completa', () => {
  // Pasa seguido: el primero se carga rápido y sin elegir nada, y el segundo viene con el
  // dato. Dejar 'otro' haría que la finca no aparezca al filtrar por proveedor.
  const db = vieja();
  db.prepare("INSERT INTO sg_contactos (nombre,tipo,empresa) VALUES ('A','otro','FINCA SA')").run();
  db.prepare("INSERT INTO sg_contactos (nombre,tipo,empresa,zona) VALUES ('B','proveedor','FINCA SA','San Juan')").run();
  migrar(db);
  const e = db.prepare('SELECT * FROM sg_contacto_empresas').get();
  assert.equal(e.tipo, 'proveedor');
  assert.equal(e.zona, 'San Juan');
});

// ── UNA INSTALACIÓN NUEVA ─────────────────────────────────────────────────────
test('ARRANCA EN UNA BASE VACÍA SIN EXPLOTAR', () => {
  // Es donde la migración se puede caer con «no such column: tipo» — y se caería ANTES de
  // que nadie llegue a usar el módulo, llevándose el arranque del server.
  const db = new DatabaseSync(':memory:');
  assert.doesNotThrow(() => migrar(db));
  const tablas = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sg_%' ORDER BY name")
    .all().map((t) => t.name);
  assert.deepEqual(tablas, ['sg_contacto_charlas', 'sg_contacto_empresas',
    'sg_contacto_medios', 'sg_contacto_productos', 'sg_contactos']);
});

test('en una base nueva la persona ya NO tiene lo que es de la cuenta', () => {
  const db = new DatabaseSync(':memory:');
  migrar(db);
  const c = cols(db, 'sg_contactos');
  assert.ok(c.includes('empresa_id'));
  for (const x of ['tipo', 'zona', 'localidad', 'cliente_nombre', 'proveedor_nombre',
                   'vendedor', 'etiquetas']) {
    assert.ok(!c.includes(x), 'la persona todavía tiene ' + x);
  }
  const p = cols(db, 'sg_contacto_productos');
  assert.ok(p.includes('empresa_id'));
  assert.ok(!p.includes('contacto_id'), 'el producto todavía cuelga de la persona');
});

// ── LOS BORDES ────────────────────────────────────────────────────────────────
test('un producto cuya persona ya no existe no queda colgado sin empresa', () => {
  // No entra al JOIN, así que el bucle no lo toca: se quedaría con empresa_id nulo para
  // siempre — una fila inalcanzable violando un NOT NULL, y el chequeo de "ya migré" no
  // podría distinguirla de trabajo pendiente. Ya era inalcanzable antes de esta migración.
  const db = vieja();
  db.prepare("INSERT INTO sg_contactos (nombre,empresa,tipo) VALUES ('Alguien','EMP SA','proveedor')").run();
  db.prepare("INSERT INTO sg_contacto_productos (contacto_id,producto,meses) VALUES (999,'FANTASMA','100000000000')").run();
  db.prepare("INSERT INTO sg_contacto_productos (contacto_id,producto,meses) VALUES (1,'PAPA','100000000000')").run();
  migrar(db);
  const pr = db.prepare('SELECT producto, empresa_id FROM sg_contacto_productos').all();
  assert.ok(!pr.some((x) => x.empresa_id == null), JSON.stringify(pr));
  assert.ok(pr.some((x) => x.producto === 'PAPA' && x.empresa_id === 1), JSON.stringify(pr));
});

test('una persona dada de baja no arrastra una empresa fantasma', () => {
  const db = vieja();
  db.prepare("INSERT INTO sg_contactos (nombre,empresa,tipo,eliminado_en) VALUES ('Ex','BORRADA SA','otro','2026-01-01')").run();
  db.prepare("INSERT INTO sg_contactos (nombre,empresa,tipo) VALUES ('Vivo','VIVA SA','cliente')").run();
  migrar(db);
  const nombres = db.prepare('SELECT nombre FROM sg_contacto_empresas').all().map((e) => e.nombre);
  assert.deepEqual(nombres, ['VIVA SA']);
});

test('EL MISMO NOMBRE NO PUEDE ENTRAR DOS VECES', () => {
  // Dos fichas de la misma finca son dos historiales con la mitad de las charlas cada uno,
  // que es justamente lo que este módulo viene a evitar. Lo frena la base, no sólo el
  // router: un script o una importación entran por abajo.
  const db = new DatabaseSync(':memory:');
  migrar(db);
  db.prepare("INSERT INTO sg_contacto_empresas (nombre,tipo) VALUES ('GIGLIO HNOS SRL','proveedor')").run();
  assert.throws(() =>
    db.prepare("INSERT INTO sg_contacto_empresas (nombre,tipo) VALUES ('GIGLIO HNOS SRL','cliente')").run());
});

test('pero una dada de baja libera su nombre', () => {
  const db = new DatabaseSync(':memory:');
  migrar(db);
  db.prepare("INSERT INTO sg_contacto_empresas (nombre,tipo) VALUES ('X SA','proveedor')").run();
  db.prepare("UPDATE sg_contacto_empresas SET eliminado_en = datetime('now')").run();
  assert.doesNotThrow(() =>
    db.prepare("INSERT INTO sg_contacto_empresas (nombre,tipo) VALUES ('X SA','cliente')").run());
});

test('una agenda grande se agrupa bien', () => {
  // Diez fincas de tres personas cada una. Lo que se mira es que no queden treinta
  // empresas, que es lo que pasaría si la agrupación mirara el id en vez del nombre.
  const db = vieja();
  const c = db.prepare("INSERT INTO sg_contactos (nombre,empresa,tipo,cargo) VALUES (?,?,'proveedor',?)");
  const prod = db.prepare("INSERT INTO sg_contacto_productos (contacto_id,producto,meses) VALUES (?,?,?)");
  for (let f = 0; f < 10; f++) {
    for (let p = 0; p < 3; p++) {
      const id = Number(c.run('Persona ' + f + '-' + p, 'FINCA ' + f + ' SA', 'Cargo ' + p).lastInsertRowid);
      prod.run(id, 'MELON', '000011111000');        // los tres cargan el mismo melón
    }
  }
  migrar(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contacto_empresas').get().n, 10);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contactos').get().n, 30);
  // Y un melón por finca, no tres.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contacto_productos').get().n, 10);
});
