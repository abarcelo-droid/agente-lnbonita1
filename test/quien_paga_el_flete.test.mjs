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
  const i = SG.indexOf('const FLETE_SG_PONE_LA_PLATA =');
  assert.ok(i > 0, 'no existe FLETE_SG_PONE_LA_PLATA');
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
// Y la regla sola, para poder correr las cuatro respuestas posibles.
function traerRegla() {
  const i = SG.indexOf('const FLETE_SG_PONE_LA_PLATA =');
  const fin = SG.indexOf(';', SG.indexOf('quien === \'san_geronimo\')', i)) + 1;
  // eslint-disable-next-line no-new-func
  return new Function(SG.slice(i, fin) + '; return FLETE_SG_PONE_LA_PLATA;')();
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

test('las cuatro respuestas, y cuál de ellas hace salir plata nuestra', () => {
  // Pablo, 2/9/2026: «tomemos consideraciones similares a la orden de compra, sobre
  // todo para que quede bien claro si lo tenemos que descontar o no en la
  // liquidación». En una salida son TRES los que pueden tener el flete a cargo, y
  // cuando es del productor todavía falta saber quién pone la plata.
  const pone = traerRegla();
  assert.equal(pone('nosotros', null), true, 'gasto nuestro');
  assert.equal(pone('cliente', null), false, 'lo paga el súper: no tocamos plata');
  assert.equal(pone('productor', 'productor'), false, 'lo paga él directo');
  assert.equal(pone('productor', 'san_geronimo'), true,
    'lo adelantamos: hay que pagarle al fletero y recuperarlo de su liquidación');
});

test('si lo pagamos nosotros, queda el gasto esperando la factura', () => {
  const db = base();
  traerSync()(db, 10, 77, '2026-09-02', 1, { cargo: 'nosotros' });
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
  traerSync()(db, 11, 77, '2026-09-02', 1, { cargo: 'productor', quien: 'productor' });
  assert.equal(pendientes(db, 11).length, 0);
  db.close();
});

test('sin fletero no hay gasto, lo diga quien lo diga', () => {
  const db = base();
  traerSync()(db, 12, null, '2026-09-02', 1, { cargo: 'nosotros' });
  assert.equal(pendientes(db, 12).length, 0);
  db.close();
});

test('cambiar de opinión a «lo paga el vendedor» anula el pendiente', () => {
  // Es lo mismo que ya hacía cuando se le sacaba el fletero: el gasto que nadie va
  // a valorizar no se queda dando vueltas.
  const db = base();
  const sync = traerSync();
  sync(db, 13, 77, '2026-09-02', 1, { cargo: 'nosotros' });
  assert.equal(pendientes(db, 13).length, 1);
  sync(db, 13, 77, '2026-09-02', 1, { cargo: 'cliente' });
  assert.equal(pendientes(db, 13).length, 0);
  assert.equal(db.prepare('SELECT estado FROM sg_gastos_directos WHERE despacho_id=13').get().estado,
    'anulado');
  db.close();
});

test('y lo YA VALORIZADO no se toca: eso es una factura que llegó', () => {
  const db = base();
  db.prepare(`INSERT INTO sg_gastos_directos (tipo_gasto, despacho_id, proveedor_servicio_id, estado, activo)
    VALUES ('flete_salida', 14, 77, 'valorizado', 1)`).run();
  traerSync()(db, 14, 77, '2026-09-02', 1, { cargo: 'cliente' });
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
  sync(db, 15, 77, '2026-09-02', 1, { cargo: 'nosotros' });
  sync(db, 16, 77, '2026-09-02', 1, { cargo: 'nosotros', quien: null });
  sync(db, 17, 77, '2026-09-02', 1, { cargo: 'nosotros', quien: undefined });
  for (const d of [15, 16, 17]) assert.equal(pendientes(db, d).length, 1, 'despacho ' + d);
  db.close();
});

// ── 2 · Y ESTÁ ENGANCHADO ──────────────────────────────────────────────────

test('la columna existe y el remito la guarda', () => {
  assert.match(DBSG, /addCol\('sg_despachos',\s+'flete_paga',\s+'TEXT'\)/);
  const i = SG.indexOf('const postRemito = (req, res)');
  const b = SG.slice(i, SG.indexOf('\r\n};', i));
  assert.match(b, /flete_a_cargo, flete_pagado_por, flete_monto\)/);
  assert.match(b, /fleteDeRemito\(b\)\.cargo, fleteDeRemito\(b\)\.quien,/);
  // Y el que arma el gasto recibe la respuesta entera, no media.
  assert.match(b, /syncGastoFleteDespacho\(db, despachoId, fleteroId, val\(b\.fecha_despacho\), uid\(req\), fleteDeRemito\(b\)\)/);
});

// ── 3 · FUERA EL SELECTOR DE TRANSPORTE ────────────────────────────────────

test('el selector de transporte ya no está en ninguna parte', () => {
  // Se guardaba y no lo leía nadie: un campo que había que contestar y no cambiaba
  // nada.
  assert.ok(!/sg-desp-transp/.test(PANEL), 'quedó el selector de transporte');
  assert.ok(!/transporte:eid\(/.test(PANEL), 'todavía se manda el transporte');
});

test('y la pregunta que sí cambia algo ocupó su lugar', () => {
  // Con las mismas consideraciones que la orden de compra: quién tiene el flete a
  // cargo, y si es del productor, quién pone la plata.
  assert.match(PANEL, /<label>Flete a cargo de <span style="color:var\(--err\)">\*<\/span><\/label>/);
  assert.match(PANEL, /<option value="nosotros">Nosotros \(San Gerónimo\)<\/option>/);
  assert.match(PANEL, /<option value="cliente">El cliente<\/option>/);
  assert.match(PANEL, /<option value="productor">El productor de la mercadería<\/option>/);
  assert.match(PANEL, /<option value="san_geronimo">Lo adelanta San Gerónimo<\/option>/);
  const i = PANEL.indexOf('function sgDespGuardar(){');
  const b = PANEL.slice(i, i + 3600);
  assert.match(b, /flete_a_cargo:eid\('sg-desp-flete-cargo'\)\.value,/);
  assert.match(b, /flete_pagado_por:eid\('sg-desp-flete-quien'\)\.value,/);
  assert.match(b, /flete_monto:eid\('sg-desp-flete-monto'\)\.value!==''/);
});

test('el cartel dice si se descuenta o no en la liquidación', () => {
  // Pablo, 2/9/2026: «sobre todo para que quede bien claro si lo tenemos que
  // descontar o no en la liquidación». Cada texto dice lo que el sistema HACE, no
  // lo que debería hacer.
  const i = PANEL.indexOf('var SG_DESP_FLETE_AYUDA = {');
  assert.ok(i > 0, 'no hay cartel que explique las consecuencias');
  const b = PANEL.slice(i, i + 1600);
  assert.match(b, /'nosotros':.*ese monto es <b>costo nuestro<\/b>\. No se le descuenta a nadie/s);
  assert.match(b, /'cliente':.*no se abre ningún gasto nuestro/s);
  assert.match(b, /'productor\|productor':[\s\S]*?No hay nada que descontar/);
  assert.match(b, /'productor\|san_geronimo':[\s\S]*?se le descuenta de su/);
  // Las cuatro respuestas tienen su texto: una sin cartel es una elección a ciegas.
  assert.equal((b.match(/^  '/gm) || []).length, 4);
});

test('el bloque aparece sólo cuando hay fletero, y el monto sólo si ponemos la plata', () => {
  // Sin camión no hay flete. Y un monto guardado que nadie va a pagar aparece
  // después en un informe como si fuera plata nuestra.
  const i = PANEL.indexOf('function sgDespFleteCargo(){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 1400);
  assert.match(b, /var hay = !!\(eid\('sg-desp-fletero'\)\|\|\{\}\)\.value;/);
  assert.match(b, /qw\.style\.display = \(hay && cargo === 'productor'\) \? '' : 'none';/);
  assert.match(b, /var pide = hay && sgDespFletePideMonto\(cargo, quien\);/);
  assert.match(b, /if \(!pide\) \{ var m=eid\('sg-desp-flete-monto'\); if\(m\) m\.value=''; \}/);
  // Y la regla del front espeja la del servidor.
  const j = PANEL.indexOf('function sgDespFletePideMonto(cargo, quien){');
  const r = PANEL.slice(j, j + 260);
  assert.match(r, /if \(cargo === 'nosotros'\) return true;/);
  assert.match(r, /if \(cargo === 'productor'\) return quien === 'san_geronimo';/);
});

test('viene en «lo pagamos nosotros», que es lo que el sistema hacía antes', () => {
  // El que no mira la pregunta obtiene el comportamiento de siempre, no uno nuevo.
  const i = PANEL.indexOf('function sgDespOpen(modo){');
  const b = PANEL.slice(i, i + 2400);
  assert.match(b, /eid\('sg-desp-flete-cargo'\)\.value='nosotros';/);
  assert.match(b, /eid\('sg-desp-flete-quien'\)\.value='productor';/);
  assert.match(b, /sgDespFleteCargo\(\);/);
});

// ── 4 · Y SE VE DÓNDE IMPORTA ──────────────────────────────────────────────

test('la ficha y el remito impreso dicen quién paga', () => {
  // Es lo que se discute en la puerta del cliente.
  const i = PANEL.indexOf('function sgFletePagaTxt(cargo, quien){');
  assert.ok(i > 0, 'no se dice quién paga');
  const b = PANEL.slice(i, i + 500);
  assert.match(b, /'lo paga el cliente'/);
  assert.match(b, /'lo adelantamos y se le descuenta al productor'/);
  assert.match(b, /'lo paga el productor'/);
  assert.match(b, /return 'lo pagamos nosotros';/);
  // El remito viejo, con el vocabulario anterior, sigue contestando.
  assert.match(PANEL, /sgFletePagaTxt\(d\.flete_a_cargo \|\| d\.flete_paga, d\.flete_pagado_por\)/);
  const j = PANEL.indexOf('function sgDespImprimir(id){');
  assert.match(PANEL.slice(j, j + 3000), /<b>Flete<\/b>/);
});

test('y el vocabulario es el MISMO que el de la orden de compra', () => {
  // Dos nombres para la misma pregunta obligan a traducir en cada informe.
  const DB = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');
  assert.match(DB, /addCol\('sg_despachos',\s+'flete_a_cargo',\s+'TEXT'\)/);
  assert.match(DB, /addCol\('sg_despachos',\s+'flete_pagado_por',\s+'TEXT'\)/);
  assert.match(DB, /addCol\('sg_despachos',\s+'flete_monto',\s+'REAL'\)/);
  assert.match(DB, /flete_a_cargo\s+TEXT CHECK\(flete_a_cargo IN \('comprador','vendedor'\)\)/,
    'la orden dejó de tener sus columnas: el espejo perdió sentido');
});

test('lo cargado con la pregunta vieja se traduce, no se pierde', () => {
  // Sin esto, esos remitos quedan sin decir a cargo de quién estaba el flete.
  const DB = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');
  assert.match(DB, /SET flete_a_cargo = CASE WHEN flete_paga='vendedor' THEN 'productor' ELSE 'nosotros' END/);
  assert.match(DB, /WHERE flete_a_cargo IS NULL AND fletero_id IS NOT NULL/);
  // Y el servidor entiende los dos vocabularios.
  const i = SG.indexOf('function fleteDeRemito(b) {');
  assert.ok(i > 0, 'no hay traductor');
  assert.match(SG.slice(i, i + 600), /String\(b\.flete_paga\) === 'vendedor' \? 'productor' : 'nosotros'/);
});
