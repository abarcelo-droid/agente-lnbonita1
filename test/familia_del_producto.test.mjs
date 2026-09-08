// ══ LA FAMILIA QUE NO EXISTE ══════════════════════════════════════════════
//
// Pablo, 8/9/2026: «la familia Cítricos no existe... no entiendo de dónde sale».
//
// Salía de `sg_productos.familia`, que NO es la familia del producto: es una
// COPIA del nombre, guardada al lado para que los informes no tengan que hacer el
// join. La familia de verdad es `familia_id`.
//
// Renombrar una familia recién propaga a esa copia desde que se agregó el UPDATE
// en rutas/sg.js. Los productos que ya existían cuando alguien renombró antes de
// eso se quedaron con el nombre viejo pegado: la solapa Productos mostraba
// «Cítricos» y la solapa Familias —que cuenta por familia_id— mostraba
// «Hortalizas Livianas». Dos pantallas del MISMO maestro diciendo cosas distintas.
//
// El test no lee el código: corre la migración y la consulta contra un SQLite de
// verdad, porque lo que hay que probar es qué queda en la base.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const DBSG = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');

// El SQL REAL del repo, no una copia escrita en el test: si alguien lo cambia,
// acá se prueba lo cambiado.
function sqlEntre(txt, desde, hasta) {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(hasta, i + desde.length);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i + desde.length, j).trim();
}

const SQL_CUENTA = sqlEntre(DBSG, 'const desfasados = db.prepare(`', '`).get().n;');
const SQL_ARREGLO = sqlEntre(DBSG, `      UPDATE sg_productos SET familia`, '`).run();')
  .replace(/^/, 'UPDATE sg_productos SET familia ');
const SQL_LISTA = sqlEntre(SG, 'res.json({ ok: true, data: db.prepare(`\r\n      SELECT p.*, f.nombre AS familia_real', '`).all() });')
  .replace(/^/, 'SELECT p.*, f.nombre AS familia_real ');

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_familias (id INTEGER PRIMARY KEY, codigo INTEGER, nombre TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_productos (id INTEGER PRIMARY KEY, codigo TEXT, familia_id INTEGER,
                               familia TEXT, nombre TEXT, activo INTEGER DEFAULT 1);
    INSERT INTO sg_familias (id, codigo, nombre) VALUES (3, 3, 'Hortalizas Livianas'), (1, 1, 'Frutas');
    -- El caso de Pablo: colgado de la familia 3, con el nombre viejo pegado.
    INSERT INTO sg_productos (id, codigo, familia_id, familia, nombre)
      VALUES (1, '03.03.01.04', 3, 'Cítricos', 'Mandarina'),
             (2, '03.01.01.04', 3, 'Cítricos', 'Lima'),
             -- Uno que ya estaba bien: no se tiene que tocar.
             (3, '01.02.00.00', 1, 'Frutas', 'Pera'),
             -- Y uno sin familia: no hay de dónde sacarle el nombre.
             (4, '18.01.00.00', NULL, 'Lo que sea', 'Rúcula');
  `);
  return db;
}

test('la copia vieja se pone al día con la familia de verdad', () => {
  const db = base();
  db.prepare(SQL_ARREGLO).run();
  const f = (id) => db.prepare('SELECT familia FROM sg_productos WHERE id=?').get(id).familia;
  assert.equal(f(1), 'Hortalizas Livianas', 'la Mandarina sigue diciendo Cítricos');
  assert.equal(f(2), 'Hortalizas Livianas');
});

test('y no toca al que ya estaba bien ni al que no tiene familia', () => {
  // Un UPDATE sin el filtro correcto le pondría NULL al que no tiene familia_id:
  // pasaría de tener un nombre viejo a no tener ninguno, que es peor.
  const db = base();
  db.prepare(SQL_ARREGLO).run();
  const f = (id) => db.prepare('SELECT familia FROM sg_productos WHERE id=?').get(id).familia;
  assert.equal(f(3), 'Frutas');
  assert.equal(f(4), 'Lo que sea', 'le borró el nombre al producto sin familia');
});

test('correrla dos veces no cambia nada: es idempotente', () => {
  // Corre en cada arranque del server, y hay tres Railway escuchando este repo.
  const db = base();
  db.prepare(SQL_ARREGLO).run();
  const antes = db.prepare('SELECT id, familia FROM sg_productos ORDER BY id').all();
  db.prepare(SQL_ARREGLO).run();
  assert.deepEqual(db.prepare('SELECT id, familia FROM sg_productos ORDER BY id').all(), antes);
});

test('el contador dice cuántos estaban mal, y después cero', () => {
  // Sin el contador la migración corre el UPDATE en cada arranque sin decir nada:
  // no habría forma de saber si esto pasó una vez o pasa todos los días.
  const db = base();
  assert.equal(db.prepare(SQL_CUENTA).get().n, 2);
  db.prepare(SQL_ARREGLO).run();
  assert.equal(db.prepare(SQL_CUENTA).get().n, 0);
});

test('el contador NO cuenta al producto sin familia', () => {
  // Está en la base con un nombre viejo y no hay con qué corregirlo: contarlo
  // dejaría el aviso encendido para siempre.
  const db = base();
  db.exec("UPDATE sg_productos SET familia='Cítricos' WHERE id=3");  // 3 desfasados
  assert.equal(db.prepare(SQL_CUENTA).get().n, 3);
});

test('la lista de productos trae la familia de verdad, aunque la copia esté vieja', () => {
  // La reparación corre al arrancar; la consulta es la segunda línea de defensa.
  // Si mañana algo vuelve a dejar la copia vieja, la pantalla igual no muestra
  // una familia que no existe.
  const db = base();               // sin correr el arreglo, a propósito
  const rows = db.prepare(SQL_LISTA.replace('${where}', 'p.activo=1')).all();
  const m = rows.find((r) => r.id === 1);
  assert.equal(m.familia_real, 'Hortalizas Livianas');
  assert.equal(m.familia, 'Cítricos', 'la copia se sigue devolviendo tal cual está');
  // Y el que no tiene familia no rompe la consulta: sale con familia_real en null.
  assert.equal(rows.find((r) => r.id === 4).familia_real, null);
});

test('y sigue trayendo todas las columnas del producto', () => {
  // El join no puede achicar lo que devuelve: la pantalla de productos y los
  // selectores de todo el módulo leen de acá.
  const db = base();
  const r = db.prepare(SQL_LISTA.replace('${where}', 'p.activo=1')).get();
  for (const c of ['id', 'codigo', 'familia_id', 'familia', 'nombre', 'activo']) {
    assert.ok(c in r, 'falta la columna ' + c);
  }
});

// ── Y la pantalla pregunta en un solo lugar ────────────────────────────────

test('la grilla, el filtro y el orden preguntan lo mismo', () => {
  // Estaban leyendo r.familia cada uno por su cuenta: por eso «Cítricos»
  // aparecía además como opción del filtro, una familia que no existe.
  const f = PANEL.slice(PANEL.indexOf('function sgProdFamiliaNom(r){'),
                        PANEL.indexOf('\r\n}', PANEL.indexOf('function sgProdFamiliaNom(r){')));
  assert.match(f, /r\.familia_real \|\| r\.familia/);
  // La copia queda como respaldo, no como primera opción: al revés no arreglaría nada.
  assert.ok(f.indexOf('familia_real') < f.indexOf('|| r.familia'));

  const grid = PANEL.slice(PANEL.indexOf('var SG_GRID = {'), PANEL.indexOf('\r\n};', PANEL.indexOf('var SG_GRID = {')));
  assert.match(grid, /\{k:'familia',[\s\S]{0,120}disp:function\(r\)\{ return sgProdFamiliaNom\(r\); \}\}/);

  const sgRowI = PANEL.indexOf('function sgRow(entity, r){');
  const fila = PANEL.slice(PANEL.indexOf("if (entity==='productos'){", sgRowI),
                           PANEL.indexOf("if (entity==='presentaciones'){", sgRowI));
  assert.ok(fila.length > 100, 'no se encontró la rama de productos de sgRow');
  assert.match(fila, /escH\(sgProdFamiliaNom\(r\)\|\|'—'\)/);
  assert.ok(!/escH\(r\.familia\|\|'—'\)/.test(fila), 'la fila sigue leyendo la copia');
});

test('y la pantalla de Familias lo explica, con su versión', () => {
  assert.match(PANEL, /los productos guardan además una <b>copia<\/b> del nombre de su familia/);
  assert.match(PANEL, /<b>V1023:<\/b>/);
});
