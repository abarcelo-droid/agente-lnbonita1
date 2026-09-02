// ══ EL FLETE ES GASTO NUESTRO SÓLO SI LO PAGAMOS NOSOTROS ══════════════════
//
// Pablo, 2/9/2026: «en remitos, tanto para cadenas como para el resto, saquemos el
// selector de transporte, dejemos sólo fletero. Pero sí preguntemos si el flete lo
// pagamos nosotros o el vendedor. Si lo pagamos nosotros debe ir a gastos directos,
// fletes de salida».
//
// DOS COSAS DISTINTAS QUE ESTABAN JUNTAS:
//
//   · QUIÉN TRAE EL CAMIÓN (el fletero) — es trazabilidad del remito y se anota
//     siempre, lo paguemos o no.
//   · QUIÉN LO PAGA — de eso depende que salga plata nuestra.
//
// Antes alcanzaba con elegir un fletero para que quedara un gasto nuestro esperando
// la factura, aunque el camión fuera del otro. Ese pendiente esperaba una cuenta que
// no iba a llegar nunca: ensuciaba el listado de Gastos Directos hasta que alguien
// se acordaba de anularlo a mano.
//
// Y el selector de TRANSPORTE (propio / cliente / tercero) se fue: se guardaba y no
// lo leía nadie — ni un informe, ni un asiento, ni una pantalla. Un campo que había
// que contestar y no cambiaba nada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const DBSG = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');

// La función real del router, sacada del fuente y corrida de verdad. Si alguien la
// renombra, esto revienta en vez de pasar en falso.
function traerSync() {
  const i = SG.indexOf('const FLETE_LO_PAGAMOS =');
  assert.ok(i > 0, 'no existe FLETE_LO_PAGAMOS');
  const j = SG.indexOf('function syncGastoFleteDespacho(');
  assert.ok(j > i, 'no existe syncGastoFleteDespacho');
  let prof = 0, k = SG.indexOf('{', j);
  for (; k < SG.length; k++) {
    if (SG[k] === '{') prof++;
    else if (SG[k] === '}') { prof--; if (prof === 0) break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(SG.slice(i, k + 1) + '; return syncGastoFleteDespacho;')();
}

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_gastos_directos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tipo_gasto TEXT, despacho_id INTEGER,
      proveedor_servicio_id INTEGER, estado TEXT, fecha_servicio TEXT,
      creado_por INTEGER, activo INTEGER DEFAULT 1);
  `);
  return db;
}
const pendientes = (db, despachoId) => db.prepare(
  `SELECT * FROM sg_gastos_directos WHERE despacho_id=? AND tipo_gasto='flete_salida'
     AND activo=1 AND estado!='anulado'`).all(despachoId);

// ── 1 · LA REGLA, CORRIDA ──────────────────────────────────────────────────

test('si lo pagamos nosotros, queda el gasto esperando la factura', () => {
  const db = base();
  traerSync()(db, 10, 77, '2026-09-02', 1, 'nosotros');
  const g = pendientes(db, 10);
  assert.equal(g.length, 1);
  assert.equal(g[0].tipo_gasto, 'flete_salida');
  assert.equal(g[0].estado, 'pendiente_valorizar');
  assert.equal(g[0].proveedor_servicio_id, 77, 'el fletero queda anotado');
  db.close();
});

test('si lo paga el vendedor, el camión se anota pero NO hay gasto nuestro', () => {
  // ES EL BUG. Un pendiente que espera una cuenta que no va a llegar nunca sólo
  // ensucia el listado hasta que alguien lo anula a mano.
  const db = base();
  traerSync()(db, 11, 77, '2026-09-02', 1, 'vendedor');
  assert.equal(pendientes(db, 11).length, 0);
  db.close();
});

test('sin fletero no hay gasto, lo diga quien lo diga', () => {
  const db = base();
  traerSync()(db, 12, null, '2026-09-02', 1, 'nosotros');
  assert.equal(pendientes(db, 12).length, 0);
  db.close();
});

test('cambiar de opinión a «lo paga el vendedor» anula el pendiente', () => {
  // Es lo mismo que ya hacía cuando se le sacaba el fletero: el gasto que nadie va
  // a valorizar no se queda dando vueltas.
  const db = base();
  const sync = traerSync();
  sync(db, 13, 77, '2026-09-02', 1, 'nosotros');
  assert.equal(pendientes(db, 13).length, 1);
  sync(db, 13, 77, '2026-09-02', 1, 'vendedor');
  assert.equal(pendientes(db, 13).length, 0);
  assert.equal(db.prepare('SELECT estado FROM sg_gastos_directos WHERE despacho_id=13').get().estado,
    'anulado');
  db.close();
});

test('y lo YA VALORIZADO no se toca: eso es una factura que llegó', () => {
  const db = base();
  db.prepare(`INSERT INTO sg_gastos_directos (tipo_gasto, despacho_id, proveedor_servicio_id, estado, activo)
    VALUES ('flete_salida', 14, 77, 'valorizado', 1)`).run();
  traerSync()(db, 14, 77, '2026-09-02', 1, 'vendedor');
  assert.equal(db.prepare('SELECT estado FROM sg_gastos_directos WHERE despacho_id=14').get().estado,
    'valorizado', 'se anuló un gasto que ya tenía su factura');
  db.close();
});

test('el remito viejo, sin el dato, sigue teniendo su gasto', () => {
  // NULL = 'nosotros'. Es lo que el sistema venía haciendo con todos los remitos
  // que ya existen: si un fletero tenía gasto, era nuestro. Cambiar eso les
  // borraría gastos reales de un plumazo.
  const db = base();
  const sync = traerSync();
  sync(db, 15, 77, '2026-09-02', 1, null);
  sync(db, 16, 77, '2026-09-02', 1, undefined);
  sync(db, 17, 77, '2026-09-02', 1, '');
  for (const d of [15, 16, 17]) assert.equal(pendientes(db, d).length, 1, 'despacho ' + d);
  db.close();
});

// ── 2 · Y ESTÁ ENGANCHADO ──────────────────────────────────────────────────

test('la columna existe y el remito la guarda', () => {
  assert.match(DBSG, /addCol\('sg_despachos',\s+'flete_paga',\s+'TEXT'\)/);
  const i = SG.indexOf('const postRemito = (req, res)');
  const b = SG.slice(i, SG.indexOf('\r\n};', i));
  assert.match(b, /turno, oc_cliente, flete_paga\)/);
  assert.match(b, /FLETE_LO_PAGAMOS\(b\.flete_paga\) \? 'nosotros' : 'vendedor'\);/);
  // Y el que arma el gasto recibe la respuesta.
  assert.match(b, /syncGastoFleteDespacho\(db, despachoId, fleteroId, val\(b\.fecha_despacho\), uid\(req\), val\(b\.flete_paga\)\)/);
});

// ── 3 · FUERA EL SELECTOR DE TRANSPORTE ────────────────────────────────────

test('el selector de transporte ya no está en ninguna parte', () => {
  // Se guardaba y no lo leía nadie: un campo que había que contestar y no cambiaba
  // nada.
  assert.ok(!/sg-desp-transp/.test(PANEL), 'quedó el selector de transporte');
  assert.ok(!/transporte:eid\(/.test(PANEL), 'todavía se manda el transporte');
});

test('y la pregunta que sí cambia algo ocupó su lugar', () => {
  assert.match(PANEL, /<label>¿Quién paga el flete\?/);
  assert.match(PANEL, /<option value="nosotros">Lo pagamos nosotros<\/option>/);
  assert.match(PANEL, /<option value="vendedor">Lo paga el vendedor<\/option>/);
  const i = PANEL.indexOf('function sgDespGuardar(){');
  assert.match(PANEL.slice(i, i + 3400), /flete_paga:eid\('sg-desp-flete-paga'\)\.value,/);
});

test('la pregunta aparece sólo cuando hay fletero, y dice qué va a pasar', () => {
  // Sin camión no hay flete que pagar. Y antes abajo del fletero decía fijo «queda
  // un gasto esperando su factura», que era mentira la mitad de las veces.
  const i = PANEL.indexOf('function sgDespFletePagaPintar(){');
  assert.ok(i > 0, 'la pregunta no se muestra ni se esconde');
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /var hay=!!\(eid\('sg-desp-fletero'\)\|\|\{\}\)\.value;/);
  assert.match(b, /box\.style\.display = hay \? '' : 'none';/);
  assert.match(b, /Queda un gasto en Gastos Directos → Fletes de salida, esperando su factura/);
  assert.match(b, /no se abre ningún gasto nuestro/);
  // El fletero la vuelve a pintar al cambiar, o queda escondida con fletero puesto.
  assert.match(PANEL, /<select id="sg-desp-fletero" onchange="sgDespFletePagaPintar\(\)">/);
  // Y no quedó el cartel FIJO de antes, que decía siempre lo mismo aunque el
  // camión fuera del otro. (Se busca la frase completa: el comentario que explica
  // por qué se sacó cita el texto viejo, y es un comentario, no un cartel.)
  assert.ok(!/Si ponés uno, queda un gasto esperando su factura/.test(PANEL),
    'quedó el cartel viejo, que mentía la mitad de las veces');
});

test('viene en «lo pagamos nosotros», que es lo que el sistema hacía antes', () => {
  // El que no mira la pregunta obtiene el comportamiento de siempre, no uno nuevo.
  const i = PANEL.indexOf('function sgDespOpen(modo){');
  assert.match(PANEL.slice(i, i + 2200), /eid\('sg-desp-flete-paga'\)\.value='nosotros';/);
});

// ── 4 · Y SE VE DÓNDE IMPORTA ──────────────────────────────────────────────

test('la ficha y el remito impreso dicen quién paga', () => {
  // Es lo que se discute en la puerta del cliente.
  assert.match(PANEL, /function sgFletePagaTxt\(v\)\{/);
  assert.match(PANEL, /'lo pagamos nosotros' : 'lo paga el vendedor'/);
  const i = PANEL.indexOf('function sgDespImprimir(id){');
  assert.match(PANEL.slice(i, i + 3000), /<b>Flete<\/b>/);
  assert.match(PANEL.slice(i, i + 3000), /sgFletePagaTxt\(d\.flete_paga\)/);
  // Y en la ficha, al lado del estado.
  const j = PANEL.indexOf('function sgDespVer(id){');
  assert.match(PANEL.slice(j, j + 1800), /' · flete '\+esc\(sgFletePagaTxt\(d\.flete_paga\)\)/);
});
