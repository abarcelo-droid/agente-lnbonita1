// ══ NO SE OFRECE LO QUE NO SE PUEDE VENDER ═════════════════════════════
//
// Pablo, 25/8/2026: "a la hora de facturar no deberías traer productos con stock
// en 0". La lista mostraba partidas con 0,4 kg sueltos como "0 cj" con el puntito
// verde — y al apretarlas el servidor las rechazaba, porque el remito valida en
// cajones enteros. Se ofrecía lo que la validación ya sabía que iba a rebotar.
//
// El filtro de la consulta se extrae POR TEXTO de sg.js y se corre contra una base
// real: si alguien lo cambia, el test falla en vez de pasar en falso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');

// Saca una constante de fragmento SQL del fuente, tal como está escrita.
function fragmento(nombre) {
  const re = new RegExp('const ' + nombre + ' = `([\\s\\S]*?)`;');
  const m = SG.match(re);
  assert.ok(m, `no está la constante ${nombre} en sg.js — ¿se renombró? el test dejó de cubrirla`);
  return m[1];
}
const KPB_EFECTIVO_SQL = fragmento('KPB_EFECTIVO_SQL');
const HAY_UN_BULTO = fragmento('HAY_UN_BULTO');

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, bultos REAL, kg_reales REAL,
      kg_por_bulto REAL, presentacion_id INTEGER);
    CREATE TABLE sg_presentaciones (id INTEGER PRIMARY KEY, factor_conversion REAL);
    INSERT INTO sg_presentaciones VALUES (1, 20);
  `);
  return db;
}

// Corre el mismo par de expresiones que la consulta real.
function vendible(db, { bultos, kg_reales, kg_por_bulto, presentacion_id, kg_disponibles }) {
  db.exec('DELETE FROM sg_lotes');
  db.prepare('INSERT INTO sg_lotes VALUES (1,?,?,?,?)')
    .run(bultos, kg_reales, kg_por_bulto, presentacion_id);
  const r = db.prepare(`
    SELECT * FROM (
      SELECT ${kg_disponibles} AS kg_disponibles, ${KPB_EFECTIVO_SQL} AS kpb_ef
      FROM sg_lotes l LEFT JOIN sg_presentaciones ps ON ps.id = l.presentacion_id
    ) WHERE kg_disponibles > 0.01 AND ${HAY_UN_BULTO}`).all();
  return r.length === 1;
}

test('una partida entera se ofrece', () => {
  const db = base();
  assert.equal(vendible(db, { bultos: 64, kg_reales: 1184, kg_por_bulto: 20,
    presentacion_id: 1, kg_disponibles: '1184' }), true);
});

test('el resto suelto de menos de un cajón NO se ofrece', () => {
  const db = base();
  // 64 cajones de 18,5; queda 0,4 kg — la pantalla mostraba "0 cj" con puntito verde.
  assert.equal(vendible(db, { bultos: 64, kg_reales: 1184, kg_por_bulto: 20,
    presentacion_id: 1, kg_disponibles: '0.4' }), false);
});

test('un cajón justo SÍ se ofrece', () => {
  const db = base();
  assert.equal(vendible(db, { bultos: 64, kg_reales: 1184, kg_por_bulto: 20,
    presentacion_id: 1, kg_disponibles: '18.5' }), true);
  // Y el que en punto flotante da un pelo menos, también: por eso la tolerancia.
  assert.equal(vendible(db, { bultos: 64, kg_reales: 1184, kg_por_bulto: 20,
    presentacion_id: 1, kg_disponibles: '18.4999' }), true);
});

test('la partida SIN factor conocido se sigue ofreciendo por kilos', () => {
  const db = base();
  // Sin bultos, sin kg_por_bulto y sin presentación no se puede hablar de cajones:
  // esconderla sería esconder mercadería de verdad.
  assert.equal(vendible(db, { bultos: null, kg_reales: 500, kg_por_bulto: null,
    presentacion_id: null, kg_disponibles: '3' }), true);
});

test('el factor efectivo no se calcula con división entera', () => {
  const db = base();
  // Sin el *1.0, SQLite haría 1184/64 = 18 y un resto de 18,2 kg pasaría como
  // "un cajón" cuando el cajón pesa 18,5.
  const r = db.prepare(`SELECT ${KPB_EFECTIVO_SQL} AS kpb FROM sg_lotes l
    LEFT JOIN sg_presentaciones ps ON ps.id = l.presentacion_id`);
  db.exec('DELETE FROM sg_lotes');
  db.prepare('INSERT INTO sg_lotes VALUES (1,64,1184,20,1)').run();
  assert.equal(r.get().kpb, 18.5);
});

test('sin conteo cae al factor nominal, y sin nada queda en null', () => {
  const db = base();
  db.exec('DELETE FROM sg_lotes');
  db.prepare('INSERT INTO sg_lotes VALUES (1,NULL,1184,20,1)').run();
  const q = db.prepare(`SELECT ${KPB_EFECTIVO_SQL} AS kpb FROM sg_lotes l
    LEFT JOIN sg_presentaciones ps ON ps.id = l.presentacion_id`);
  assert.equal(q.get().kpb, 20);
  db.exec('DELETE FROM sg_lotes');
  db.prepare('INSERT INTO sg_lotes VALUES (1,NULL,1184,NULL,NULL)').run();
  assert.equal(q.get().kpb, null);
});

test('el fragmento SQL y kpbEfectivo() dicen lo mismo', () => {
  // Son el mismo número escrito dos veces —uno en SQL para filtrar, otro en JS para
  // mostrar—. Si se separan, la lista vuelve a ofrecer lo que la validación rechaza.
  const i = SG.indexOf('function kpbEfectivo(');
  assert.ok(i >= 0, 'no está kpbEfectivo en sg.js');
  const js = SG.slice(i, SG.indexOf('\n}', i));
  assert.match(js, /kgr \/ b/, 'kpbEfectivo tiene que seguir siendo kg_reales / bultos');
  assert.match(KPB_EFECTIVO_SQL, /l\.kg_reales\s*\*\s*1\.0\s*\/\s*l\.bultos/,
    'y el fragmento SQL también, con el *1.0 para que no sea división entera');
});
