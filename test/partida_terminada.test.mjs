// ══ UNA PARTIDA SE LIQUIDA CUANDO ESTÁ TERMINADA ═══════════════════════════
//
// Pablo, 27/8/2026: «solamente se puede liquidar una partida si está 100%
// terminada, o sea todos los bultos vendidos o mermados».
//
// Este test no mira el código: LO CORRE. Levanta el esquema real de db_sg.js con
// las claves foráneas encendidas, arma una partida con sus lotes, sus despachos y
// sus decomisos, y le pregunta al mismo servicio que decide en producción.
//
// La merma cuenta igual que la venta. Pablo, 24/8/2026: «en una de 60 bultos
// puede pasar que tengamos vendidos 55 y 5 sean merma. Esos 5 van a precio de
// venta 0 — están "vendidos" pero suman cero». Sin eso, una partida que salió
// entera —parte vendida, parte tirada— no se podría liquidar nunca.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { avanceDePartida, frenoPartidaSinTerminar } from '../src/servicios/sg_partida_terminada.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIQ = fs.readFileSync(path.join(RAIZ, 'src/rutas/liquidaciones.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// ── EL ESQUEMA REAL ────────────────────────────────────────────────────────
function creates(archivo) {
  const src = fs.readFileSync(path.join(RAIZ, archivo), 'utf8');
  const out = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let m;
  while ((m = re.exec(src))) {
    let d = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') d++;
      else if (src[i] === ')') { d--; if (d === 0) { i++; break; } }
    }
    const sql = src.slice(m.index, i);
    if (/_new\b|_v2\b|_vieja\b/i.test(m[1])) continue;
    if (/\$\{/.test(sql)) continue;
    out.push({ tabla: m[1], sql });
  }
  return out;
}

function baseReal() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const puestas = new Set();
  for (const c of creates('src/servicios/db_sg.js')) {
    if (puestas.has(c.tabla)) continue;
    try { db.exec(c.sql + ';'); puestas.add(c.tabla); } catch (_) { /* depende de otra */ }
  }
  const src = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');
  for (const m of src.matchAll(/ALTER TABLE ([a-z_]+) ADD COLUMN ([^"'`]+)/gi)) {
    try { db.exec('ALTER TABLE ' + m[1] + ' ADD COLUMN ' + m[2].trim() + ';'); } catch (_) { /* ya está */ }
  }
  // Y las que el arranque agrega por el helper addCol('tabla','columna','TIPO'), que
  // no son un ALTER literal y por eso el barrido de arriba no las ve. Sin esto falta,
  // por ejemplo, sg_despacho_items.bultos — que es justo la columna con la que se
  // cuenta lo que salió.
  for (const m of src.matchAll(/addCol\(\s*'([a-z_]+)',\s*'([a-z_0-9]+)',\s*'([^']+)'/gi)) {
    try { db.exec('ALTER TABLE ' + m[1] + ' ADD COLUMN ' + m[2] + ' ' + m[3] + ';'); } catch (_) { /* ya está */ }
  }
  return db;
}

// Una partida: la orden, su ítem, un lote de N bultos. Devuelve { ocId, loteId }.
function partida(db, bultos) {
  db.prepare(`INSERT INTO sg_proveedores (id, razon_social) VALUES (1,'ABRAHAM VICTOR')`).run();
  db.prepare(`INSERT INTO sg_productos (id, codigo, nombre) VALUES (1,'P1','Uva')`).run();
  db.prepare(`INSERT INTO sg_oc (id, numero, proveedor_id, tipo_precio, estado)
    VALUES (7,'0549.27.08.2026.02',1,'pizarra','abierta')`).run();
  db.prepare(`INSERT INTO sg_oc_items (id, oc_id, producto_id) VALUES (70,7,1)`).run();
  db.prepare(`INSERT INTO sg_lotes (id, codigo_lote, oc_item_id, producto_id, bultos, activo)
    VALUES (700,'L-700',70,1,?,1)`).run(bultos);
  return { ocId: 7, loteId: 700 };
}

function vender(db, loteId, bultos, id) {
  db.prepare(`INSERT INTO sg_despachos (id, activo) VALUES (?,1)`).run(id);
  db.prepare(`INSERT INTO sg_despacho_items (despacho_id, lote_id, bultos) VALUES (?,?,?)`)
    .run(id, loteId, bultos);
}
// El decomiso lleva los kilos como obligatorios —es la columna vieja, de antes de que
// se contara por bulto— así que hay que ponerlos aunque la cuenta que importa acá sea
// la de bultos.
const tirar = (db, loteId, bultos) =>
  db.prepare(`INSERT INTO sg_lote_decomisos (lote_id, bultos, kg) VALUES (?,?,?)`)
    .run(loteId, bultos, bultos * 9);

// ── LA CUENTA ──────────────────────────────────────────────────────────────
test('con todo en el depósito, la partida NO está terminada', () => {
  const db = baseReal();
  const { ocId } = partida(db, 45);
  const a = avanceDePartida(db, ocId);
  assert.equal(a.recibidos, 45);
  assert.equal(a.terminado, 0);
  assert.equal(a.faltan, 45);
  assert.equal(a.terminada, false);
  assert.match(frenoPartidaSinTerminar(db, ocId) || '', /quedan 45 en el depósito/);
});

test('vendida entera, se liquida', () => {
  const db = baseReal();
  const { ocId, loteId } = partida(db, 45);
  vender(db, loteId, 45, 1);
  const a = avanceDePartida(db, ocId);
  assert.equal(a.vendidos, 45);
  assert.equal(a.terminada, true);
  assert.equal(frenoPartidaSinTerminar(db, ocId), null);
});

test('LA MERMA TERMINA LA PARTIDA IGUAL QUE LA VENTA', () => {
  // 60 ingresados, 55 vendidos y 5 tirados. Sin contar la merma, esta partida se
  // veía en rojo para siempre y nunca daba lista para liquidar.
  const db = baseReal();
  const { ocId, loteId } = partida(db, 60);
  vender(db, loteId, 55, 1);
  tirar(db, loteId, 5);
  const a = avanceDePartida(db, ocId);
  assert.equal(a.vendidos, 55);
  assert.equal(a.merma, 5);
  assert.equal(a.terminado, 60);
  assert.equal(a.terminada, true);
  assert.equal(frenoPartidaSinTerminar(db, ocId), null);
});

test('con un solo bulto adentro, todavía no', () => {
  // No hay tolerancia en bultos: se cuenta por unidad. Un bulto que queda es un
  // bulto al que todavía no se le sabe el precio.
  const db = baseReal();
  const { ocId, loteId } = partida(db, 45);
  vender(db, loteId, 44, 1);
  const f = frenoPartidaSinTerminar(db, ocId);
  assert.ok(f, 'con 44 de 45 no se liquida');
  assert.match(f, /quedan 1 en el depósito/);
  assert.match(f, /44 vendidos/);
});

test('el mensaje nombra la merma sólo si la hubo', () => {
  const db = baseReal();
  const { ocId, loteId } = partida(db, 100);
  vender(db, loteId, 50, 1);
  tirar(db, loteId, 10);
  const f = frenoPartidaSinTerminar(db, ocId);
  assert.match(f, /10 de merma/);
  assert.match(f, /quedan 40 en el depósito/);
});

test('varios despachos y varios decomisos suman', () => {
  const db = baseReal();
  const { ocId, loteId } = partida(db, 90);
  vender(db, loteId, 30, 1);
  vender(db, loteId, 25, 2);
  tirar(db, loteId, 20);
  tirar(db, loteId, 15);
  const a = avanceDePartida(db, ocId);
  assert.equal(a.vendidos, 55);
  assert.equal(a.merma, 35);
  assert.equal(a.terminada, true);
});

test('el remito ANULADO no cuenta como salida', () => {
  // Si contara, anular un remito dejaría la partida "terminada" con la mercadería
  // de vuelta en el depósito, y se liquidaría lo que no se vendió.
  const db = baseReal();
  const { ocId, loteId } = partida(db, 45);
  vender(db, loteId, 45, 1);
  db.prepare('UPDATE sg_despachos SET activo=0 WHERE id=1').run();
  assert.equal(avanceDePartida(db, ocId).vendidos, 0);
  assert.ok(frenoPartidaSinTerminar(db, ocId));
});

test('una partida SIN mercadería recibida no está «terminada»: está sin empezar', () => {
  // Son dos cosas distintas, y 0 de 0 daría "terminada" con la cuenta ingenua.
  // Liquidar aire es el peor caso de todos.
  const db = baseReal();
  const { ocId } = partida(db, 0);
  const a = avanceDePartida(db, ocId);
  assert.equal(a.terminada, false);
  assert.equal(a.sin_recibir, true);
  assert.match(frenoPartidaSinTerminar(db, ocId), /no tiene mercadería recibida/);
});

test('sin partida no frena nada: la liquidación suelta sigue existiendo', () => {
  const db = baseReal();
  assert.equal(frenoPartidaSinTerminar(db, null), null);
  assert.equal(frenoPartidaSinTerminar(db, 0), null);
});

// ── LAS DOS PUERTAS ────────────────────────────────────────────────────────
test('el servidor lo frena, y ANTES de mirar el precio', () => {
  // Si la partida no está terminada no importa a qué precio se liquida, y el
  // mensaje que sirve es el de la partida, no el del precio.
  assert.match(LIQ, /import \{ frenoPartidaSinTerminar \}/);
  const freno = LIQ.indexOf('frenoPartidaSinTerminar(db, ocIdBody)');
  const precio = LIQ.indexOf("String(d.modo_precio || '') !== 'cerrado'");
  assert.ok(freno > 0 && precio > 0);
  assert.ok(freno < precio, 'el freno de partida va antes que el de precio');
  assert.match(LIQ, /if \(frena\) return res\.status\(400\)\.json\(\{ error: frena \}\)/);
});

test('la pantalla no ofrece el botón que va a rebotar, y dice por qué', () => {
  assert.match(PANEL, /function sgPartTerminada\(p\)\{/);
  assert.match(PANEL, /function sgPartFaltaTxt\(p\)\{/);
  assert.match(PANEL, /sgPartTerminada\(p\)\s*\?/);
  assert.match(PANEL, /disabled style="opacity:\.5;cursor:not-allowed" title="'/);
  // Y espeja la misma cuenta del servidor: vendidos + merma contra recibidos.
  const i = PANEL.indexOf('function sgPartTerminada(p){');
  const b = PANEL.slice(i, i + 500);
  assert.match(b, /bultos_vendidos/);
  assert.match(b, /bultos_merma/);
  assert.match(b, /bultos_recibidos/);
  assert.match(b, /rec <= 0\) return false/, 'sin recibir no es terminada');
});
