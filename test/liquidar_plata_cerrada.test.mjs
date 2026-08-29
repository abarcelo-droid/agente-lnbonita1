// ══ NO SE LIQUIDA CON PLATA SIN CERRAR ═════════════════════════════════════
//
// Pablo, 29/8/2026: «no se debe poder liquidar si la mercadería no está
// facturada. Hay que esperar a cerrar la facturación para liquidar, siempre.
// Debemos tener la descarga por lo menos valorizada. Lo mismo con el flete: debe
// estar valorizado. Después se puede ingresar la factura, pero deben estar
// valorizados sí o sí».
//
// Las tres son la misma idea: la liquidación es el papel donde el productor
// cobra y se armaba con números que todavía no estaban. Sin la venta facturada
// sale de menos; sin la descarga o el flete valorizados esos gastos no se le
// descuentan —o alguien los tipea a ojo— y el que pierde es siempre el mismo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERV = fs.readFileSync(path.join(RAIZ, 'src/servicios/sg_partida_terminada.js'), 'utf8');
const LIQ = fs.readFileSync(path.join(RAIZ, 'src/rutas/liquidaciones.js'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// ── LO QUE FRENA ───────────────────────────────────────────────────────────

test('existe un solo freno y mira las tres cosas', () => {
  // Una sola puerta: si cada control viviera aparte, agregar el cuarto sería
  // acordarse de tocar tres lugares.
  assert.match(SERV, /export function frenoParaLiquidar\(db, ocId, facturaCuenta\) \{/);
  const i = SERV.indexOf('export function frenoParaLiquidar(');
  const b = SERV.slice(i, i + 2200);
  assert.match(b, /const terminada = frenoPartidaSinTerminar\(db, ocId\);/);
  assert.match(b, /sinFacturarDePartida\(db, ocId, facturaCuenta\)/);
  assert.match(b, /gastosSinValorizar\(db, ocId\)/);
});

test('la partida terminada se sigue mirando PRIMERO', () => {
  // Si todavía hay mercadería en el depósito, no importa si está facturada: el
  // mensaje que sirve es el otro.
  const i = SERV.indexOf('export function frenoParaLiquidar(');
  const b = SERV.slice(i, i + 2200);
  const term = b.indexOf('frenoPartidaSinTerminar');
  const fac = b.indexOf('sinFacturarDePartida');
  assert.ok(term > 0 && fac > term);
});

test('sin facturar frena, y dice cuánto y a dónde ir', () => {
  const i = SERV.indexOf('export function frenoParaLiquidar(');
  const b = SERV.slice(i, i + 2200);
  assert.match(b, /if \(sinFac > 0\.01\)/);
  assert.match(b, /al productor se le pagaría/);
  assert.match(b, /Remitos pendientes de comprobante/);
});

test('la descarga sin valorizar frena, y manda a valorizarla', () => {
  const i = SERV.indexOf('export function frenoParaLiquidar(');
  const b = SERV.slice(i, i + 2200);
  assert.match(b, /if \(g\.descarga > 0\)/);
  assert.match(b, /Gastos Directos → Cargas y Descargas/);
  // Y dice que alcanza con el importe: es la distinción que hizo Pablo.
  assert.match(b, /alcanza con el importe, la factura puede/);
});

test('el flete sin valorizar también', () => {
  const i = SERV.indexOf('export function frenoParaLiquidar(');
  const b = SERV.slice(i, i + 2200);
  assert.match(b, /if \(g\.flete > 0\)/);
  assert.match(b, /Gastos Directos → Fletes de entrada/);
});

test('lo que se exige es la VALORIZACIÓN, no la factura del fletero', () => {
  // «Después se puede ingresar la factura, pero deben estar valorizados sí o sí».
  assert.match(SERV, /LO QUE SE EXIGE ES LA VALORIZACIÓN, NO LA FACTURA DEL FLETERO/);
  const i = SERV.indexOf('export function gastosSinValorizar(');
  const b = SERV.slice(i, i + 900);
  assert.match(b, /g\.estado='pendiente_valorizar'/);
  assert.ok(!/factura/i.test(b.slice(b.indexOf('SELECT'), b.indexOf('.get('))));
});

// ── LA CUENTA, CORRIDA ─────────────────────────────────────────────────────

test('sólo cuenta lo que está pendiente, no lo ya valorizado ni lo anulado', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sg_gastos_directos (id INTEGER PRIMARY KEY, recepcion_id INTEGER,
    tipo_gasto TEXT, estado TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_recepciones (id INTEGER PRIMARY KEY, oc_id INTEGER, activo INTEGER DEFAULT 1)`);
  db.prepare('INSERT INTO sg_recepciones (id, oc_id) VALUES (5, 7)').run();
  const ins = db.prepare(`INSERT INTO sg_gastos_directos (recepcion_id, tipo_gasto, estado, activo)
    VALUES (?,?,?,?)`);
  ins.run(5, 'descarga_ingreso', 'pendiente_valorizar', 1);
  ins.run(5, 'flete_entrada', 'valorizado', 1);            // ya valorizado: no frena
  ins.run(5, 'flete_entrada', 'pendiente_valorizar', 0);   // inactivo: no frena
  ins.run(5, 'descarga_ingreso', 'anulado', 1);            // anulado: no frena
  const f = db.prepare(`SELECT
      SUM(CASE WHEN g.tipo_gasto='descarga_ingreso' AND g.estado='pendiente_valorizar' THEN 1 ELSE 0 END) AS descarga,
      SUM(CASE WHEN g.tipo_gasto='flete_entrada'    AND g.estado='pendiente_valorizar' THEN 1 ELSE 0 END) AS flete
      FROM sg_gastos_directos g
      JOIN sg_recepciones r ON r.id = g.recepcion_id AND r.activo = 1
     WHERE r.oc_id = ? AND g.activo = 1 AND g.estado != 'anulado'`).get(7);
  assert.equal(f.descarga, 1, 'la descarga pendiente tiene que frenar');
  assert.equal(f.flete, 0, 'el flete ya valorizado no frena');
});

test('una partida sin gastos cargados no frena por eso', () => {
  // No haber tenido descarga es distinto de tenerla sin valorizar.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sg_gastos_directos (id INTEGER PRIMARY KEY, recepcion_id INTEGER,
    tipo_gasto TEXT, estado TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_recepciones (id INTEGER PRIMARY KEY, oc_id INTEGER, activo INTEGER DEFAULT 1)`);
  db.prepare('INSERT INTO sg_recepciones (id, oc_id) VALUES (5, 7)').run();
  const f = db.prepare(`SELECT
      SUM(CASE WHEN g.tipo_gasto='descarga_ingreso' AND g.estado='pendiente_valorizar' THEN 1 ELSE 0 END) AS descarga
      FROM sg_gastos_directos g
      JOIN sg_recepciones r ON r.id = g.recepcion_id AND r.activo = 1
     WHERE r.oc_id = ? AND g.activo = 1 AND g.estado != 'anulado'`).get(7);
  assert.equal(Number(f.descarga) || 0, 0);
});

// ── EL SERVIDOR DECIDE ─────────────────────────────────────────────────────

test('el POST usa el freno nuevo, antes de mirar el precio', () => {
  assert.match(LIQ, /import \{ frenoParaLiquidar \}/);
  assert.match(LIQ, /const frena = frenoParaLiquidar\(db, ocIdBody, facturaCuenta\);/);
  const freno = LIQ.indexOf('frenoParaLiquidar(db, ocIdBody, facturaCuenta)');
  const precio = LIQ.indexOf("String(d.modo_precio || '') !== 'cerrado'");
  assert.ok(freno > 0 && precio > freno, 'el freno va antes que el control de precio');
});

test('y una factura acreditada no cuenta como facturada', () => {
  // La nota de crédito dejó la mercadería entregada sin documentar: ahí falta
  // facturar de vuelta.
  assert.match(LIQ, /import \{ facturaCuenta \}/);
  const i = SERV.indexOf('export function sinFacturarDePartida(');
  const b = SERV.slice(i, i + 1200);
  assert.match(b, /\$\{facturaCuenta\('fv'\)\}/);
});

// ── LA PANTALLA AVISA ANTES ────────────────────────────────────────────────

test('la pantalla frena y dice las tres cosas con su camino', () => {
  // Antes era un aviso al pasar y la liquidación se emitía igual.
  const i = PANEL.indexOf('var frenos = [];');
  assert.ok(i > 0, 'no está el bloque de frenos');
  const b = PANEL.slice(i, i + 2400);
  assert.match(b, /Remitos pendientes de comprobante/);
  assert.match(b, /Gastos Directos → Cargas y Descargas/);
  assert.match(b, /Gastos Directos → Fletes de entrada/);
  assert.match(b, /Esta partida todavía no se puede liquidar/);
});

test('y no deja emitir', () => {
  // El servidor lo vuelve a mirar, pero rebotar acá evita que el operador
  // descubra después de llenar la pantalla que no se podía.
  const i = PANEL.indexOf('async function liqGuardar() {');
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /if \(\(LIQ\.frenos \|\| \[\]\)\.length\) \{/);
  assert.match(b, /Esta partida todavía no se puede liquidar/);
});

test('el servidor le manda a la pantalla qué falta valorizar', () => {
  assert.match(SG, /sin_valorizar: gastosSinValorizar\(db, ocId\),/);
  assert.match(SG, /import \{ gastosSinValorizar \} from '\.\.\/servicios\/sg_partida_terminada\.js';/);
});

test('el aviso se lee sin etiquetas cuando va al cartel del navegador', () => {
  // El texto lleva <b> para la pantalla; en el alert saldría crudo.
  const i = PANEL.indexOf('async function liqGuardar() {');
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /replace\(\/<\[\^>\]\*>\/g, ''\)/);
});
