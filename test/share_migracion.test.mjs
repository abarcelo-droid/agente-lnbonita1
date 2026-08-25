// EL TEST QUE FALTABA. Los otros crean el esquema DESDE CERO, y ahí las columnas nuevas ya
// vienen en el CREATE TABLE: todo funciona. El servidor se cayó en una base que YA EXISTÍA,
// donde share_oferta_lineas no tenía las columnas que la vista nombra y el CREATE VIEW se
// ejecutaba antes del ALTER que las agrega.
//
// Así que acá se arma una base con el esquema VIEJO, se corre la secuencia de arranque REAL
// —tablas, ALTERs, vistas— y se comprueba que levante. Con la base en blanco esto pasaba
// igual estando roto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { crearTablas, crearVistas, crearEsquema } from '../src/servicios/share_ddl.js';

// El share_oferta_lineas tal como quedó con el PR de la oferta: sin ean, precio, variedad,
// zona ni observacion. Es el estado que tenía producción.
const ESQUEMA_VIEJO = `
  CREATE TABLE share_ofertas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL, origen TEXT, archivo_nombre TEXT,
    filas INTEGER, bultos_total REAL, notas TEXT, cargado_por TEXT, cargado_por_id INTEGER,
    creado_en TEXT, estado TEXT NOT NULL DEFAULT 'activa', reemplazada_por INTEGER, reemplazada_en TEXT);
  CREATE TABLE share_oferta_lineas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, oferta_id INTEGER NOT NULL, fecha TEXT NOT NULL,
    articulo_raw TEXT NOT NULL, articulo_id INTEGER, cantidad REAL NOT NULL, notas TEXT);
  CREATE TABLE share_articulos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, desc_canonica TEXT NOT NULL UNIQUE, articulo_base TEXT,
    calidad TEXT, familia TEXT, rubro TEXT, unidad TEXT, gramos INTEGER, factor_kg REAL,
    la_vendemos INTEGER NOT NULL DEFAULT 0, pendiente_revision INTEGER NOT NULL DEFAULT 0,
    activo INTEGER NOT NULL DEFAULT 1, creado_en TEXT);
`;

// Las mismas columnas y en el mismo orden que db_share.js. Si allá se agrega una y acá no,
// este test deja de cubrirla — por eso la lista está a la vista y no escondida en un bucle.
const COLUMNAS = [
  ['share_articulos', 'ean', 'TEXT'],
  ['share_oferta_lineas', 'ean', 'TEXT'],
  ['share_oferta_lineas', 'precio', 'REAL'],
  ['share_oferta_lineas', 'variedad', 'TEXT'],
  ['share_oferta_lineas', 'zona', 'TEXT'],
  ['share_oferta_lineas', 'observacion', 'TEXT'],
];
function agregarCols(db) {
  for (const [tabla, col, tipo] of COLUMNAS) {
    const cols = db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${tipo}`);
  }
}

test('arrancar sobre una base VIEJA no explota', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(ESQUEMA_VIEJO);
  // La secuencia de db_share.js, en su orden: tablas, columnas nuevas, y recién ahí las vistas.
  crearTablas(db);
  agregarCols(db);
  crearVistas(db);
  // Si la vista se creó, se puede consultar.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_oferta_v').get().c, 0);
});

test('el orden importa: las vistas ANTES de las columnas se caen', () => {
  // Este es el crash que tuvo producción, reproducido. Sirve para que nadie vuelva a juntar
  // las dos cosas "porque es más prolijo".
  const db = new DatabaseSync(':memory:');
  db.exec(ESQUEMA_VIEJO);
  crearTablas(db);
  assert.throws(() => crearVistas(db), /no such column: ean/);
});

test('sobre una base NUEVA sigue andando igual', () => {
  const db = new DatabaseSync(':memory:');
  crearEsquema(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_oferta_v').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_v').get().c, 0);
});

test('arrancar dos veces seguidas tampoco', () => {
  // El servidor reinicia solo en cada deploy: correr la secuencia entera de nuevo sobre la
  // base ya migrada tiene que ser inocuo.
  const db = new DatabaseSync(':memory:');
  db.exec(ESQUEMA_VIEJO);
  for (let i = 0; i < 3; i++) { crearTablas(db); agregarCols(db); crearVistas(db); }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_oferta_v').get().c, 0);
});

test('las columnas nuevas quedan disponibles y la vista las trae', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(ESQUEMA_VIEJO);
  crearTablas(db); agregarCols(db); crearVistas(db);
  db.prepare("INSERT INTO share_ofertas (fecha, estado) VALUES ('2026-08-25','activa')").run();
  db.prepare(`INSERT INTO share_oferta_lineas
    (oferta_id, fecha, articulo_raw, cantidad, ean, precio, variedad, zona, observacion)
    VALUES (1,'2026-08-25','CEBOLLA X KG',8000,'2320056000006',1600,null,'BRASIL',null)`).run();
  const f = db.prepare('SELECT * FROM share_oferta_v').get();
  assert.equal(f.ean, '2320056000006');
  assert.equal(f.precio, 1600);
  assert.equal(f.zona, 'BRASIL');
});
