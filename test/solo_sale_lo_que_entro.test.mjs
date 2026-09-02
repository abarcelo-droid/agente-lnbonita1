// ══ SÓLO SALE LO QUE ENTRÓ, Y EL REMITO A LA CADENA LLEVA LO SUYO ══════════
//
// Pablo, 1/9/2026:
//
//   «Separemos la confección en dos: emisión de remitos normales y emisión de
//    remitos para supermercados, para que tengan dos tratamientos distintos. La
//    pantalla básicamente es la misma, pero agreguémosle un campo de TURNO y un
//    campo de OC que salgan impresos.
//
//    Tanto en remitos como en facturación no debés dejarnos seleccionar para
//    remitir o facturar mercadería "en camino", porque eso hace que se rompan los
//    stocks. Directamente nos tenés que dar posibilidad de remitir o facturar sólo
//    mercadería ingresada al stock.»
//
// POR QUÉ ROMPE EL STOCK. El remito podía comprometer una partida que todavía
// venía en la ruta. Ese renglón SALE del depósito sin haber ENTRADO nunca: el piso
// descuenta algo que no existe, y cuando el camión llega —o llega con menos, o no
// llega— el stock ya se movió y no hay contra qué compararlo.
//
// Lo YA remitido en viaje no se toca: existe y hay que poder cerrarlo cuando la
// mercadería baje. Lo que no se puede es abrir uno nuevo, ni facturarlo antes de
// que llegue.
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

// ── 1 · EL REMITO NO ACEPTA MERCADERÍA EN VIAJE ────────────────────────────

test('el servidor rechaza el renglón en viaje, y lo dice en criollo', () => {
  const i = SG.indexOf('const postRemito = (req, res)');
  assert.ok(i > 0);
  const b = SG.slice(i, i + 3000);
  assert.match(b, /if \(items\.some\(\(it\) => String\(it\.origen \|\| ''\) === 'oc_item'\)\) \{\r?\n\s*return res\.status\(400\)\.json\(\{ ok: false, error: ERROR_EN_VIAJE \}\);/);
  assert.match(SG, /const ERROR_EN_VIAJE = 'No se puede remitir mercadería que todavía viene en viaje/);
  assert.match(SG, /Recibí la partida primero y después remitila\./);
});

test('y no quedó la maquinaria vieja apagada esperando que alguien la prenda', () => {
  // Código muerto que parece vivo es lo que hace que dentro de seis meses alguien
  // lo vuelva a encender sin saber por qué se había apagado. Las dos vueltas que
  // armaban y controlaban las líneas en viaje se sacaron enteras.
  const i = SG.indexOf('const postRemito = (req, res)');
  const fin = SG.indexOf('\r\n};', i);
  const b = SG.slice(i, fin);
  assert.ok(!/pedidoCamino/.test(b), 'quedó la cuenta de lo prometido en viaje');
  assert.ok(!/origen: 'oc_item'/.test(b), 'quedó el armado de la línea en viaje');
  assert.ok(!/Partida en viaje inexistente/.test(b));
});

test('la pantalla tampoco lo ofrece — pero el pedido sí lo sigue viendo', () => {
  // Un pedido es lo que el cliente encargó: no mueve un solo cajón, así que
  // prometer contra un camión en ruta es justamente de lo que se trata.
  const i = PANEL.indexOf('function sgIPConCamino(st){');
  assert.ok(i > 0);
  assert.match(PANEL.slice(i, i + 120), /return st\.modo==='pedido';/);
  assert.ok(!/st\.modo==='pedido' \|\| st\.modo==='remito'/.test(PANEL),
    'el remito volvió a mirar lo que viene en viaje');
});

// ── 2 · Y TAMPOCO SE FACTURA ───────────────────────────────────────────────

test('facturar un renglón que no bajó del camión rebota', () => {
  const i = SG.indexOf('const postEmitir');
  const b = SG.slice(i, i + 4000);
  assert.match(b, /if \(di\.origen === 'oc_item' && di\.lote_recibido_id == null\) \{/);
  assert.match(b, /todavía viene en viaje: `\r?\n\s*\+ 'no se factura hasta que la mercadería entre al stock\.'/);
  // Y la consulta trae los dos campos, o la condición miraría undefined y nunca
  // frenaría nada.
  assert.match(b, /di\.origen, di\.lote_recibido_id,/);
});

test('el freno se destraba solo cuando la partida llega', () => {
  // lote_recibido_id se llena al recibir: esto no bloquea para siempre, bloquea
  // HASTA que entre. Es lo que pidió Pablo, no una puerta cerrada con llave.
  assert.match(SG, /Se destraba solo cuando la partida se recibe\./);
});

// ── 3 · LAS DOS PUERTAS DE EMISIÓN ─────────────────────────────────────────

const R = (() => {
  const i = SG.indexOf('const SQL_ES_CADENA = `');
  assert.ok(i > 0);
  return SG.slice(SG.indexOf('`', i) + 1, SG.indexOf('`;', i));
})();

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_cliente_categorias (id INTEGER PRIMARY KEY, nombre TEXT);
    INSERT INTO sg_cliente_categorias VALUES (1,'Retail'),(2,'Mayorista MCBA');
    CREATE TABLE sg_clientes (id INTEGER PRIMARY KEY, razon_social TEXT, tipo TEXT, categoria_id INTEGER);
    INSERT INTO sg_clientes VALUES
      (1,'Coto','supermercado',NULL),   -- tildada a mano
      (2,'Jumbo',NULL,1),               -- del padrón, categoría Retail
      (3,'Verdulería','minorista',2),
      (4,'Sin datos',NULL,NULL);        -- ni tipo ni categoría: el caso normal
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, numero TEXT, cliente_id INTEGER,
      activo INTEGER, sin_remito INTEGER);
    INSERT INTO sg_despachos VALUES
      (10,'R-10',1,1,0), (11,'R-11',2,1,0), (12,'R-12',3,1,0),
      (13,'R-13',4,1,0), (14,'R-14',NULL,1,0),
      (15,'R-15',1,1,1),   -- venta directa: no es un remito
      (16,'R-16',1,0,0);   -- anulado
  `);
  return db;
}

function listar(db, extra) {
  const where = ['d.activo=1', 'COALESCE(d.sin_remito,0)=0'];
  if (extra) where.push(extra);
  return db.prepare(`SELECT d.numero FROM sg_despachos d
    LEFT JOIN sg_clientes c ON c.id=d.cliente_id
    WHERE ${where.join(' AND ')} ORDER BY d.id`).all().map((r) => r.numero);
}

const SIN_CADENAS = '(NOT ' + R + ' OR d.cliente_id IS NULL OR c.id IS NULL)';

test('las dos listas SUMAN el total y ninguna se pisa', () => {
  // Si un remito no cae en ninguna de las dos, desaparece de la pantalla sin que
  // nadie lo haya borrado. Y si cae en las dos, se factura dos veces.
  const db = base();
  const todos = listar(db, null);
  const cadenas = listar(db, R);
  const normales = listar(db, SIN_CADENAS);
  assert.deepEqual([...new Set([...cadenas, ...normales])].sort(), [...todos].sort(),
    'hay remitos que no aparecen en ninguna de las dos pantallas');
  assert.deepEqual(cadenas.filter((x) => normales.includes(x)), [],
    'hay remitos que aparecen en las dos');
  db.close();
});

test('el cliente SIN tipo ni categoría no se pierde: va con los normales', () => {
  // Es el caso NORMAL —el padrón de ABASTO no trae `tipo`— y era el que rompía:
  // con la condición dando NULL, `NOT NULL` también da NULL y el remito no
  // entraba en ninguna lista.
  const db = base();
  assert.ok(listar(db, SIN_CADENAS).includes('R-13'), 'R-13 desapareció');
  assert.ok(!listar(db, R).includes('R-13'));
  db.close();
});

test('y la regla nunca contesta NULL', () => {
  const db = base();
  const n = db.prepare(`SELECT COUNT(*) c FROM sg_clientes c WHERE (${R}) IS NULL`).get().c;
  assert.equal(n, 0, 'la regla devuelve NULL para alguna ficha');
  assert.match(R, /COALESCE\(c\.tipo,''\)='supermercado'/, 'sin COALESCE vuelve el NULL');
  db.close();
});

test('la venta directa y el remito anulado siguen afuera de las dos', () => {
  const db = base();
  for (const l of [listar(db, R), listar(db, SIN_CADENAS)]) {
    assert.ok(!l.includes('R-15'), 'se coló una venta directa en la lista de remitos');
    assert.ok(!l.includes('R-16'), 'se coló un remito anulado');
  }
  db.close();
});

test('el servidor entiende los dos recortes, y el OR va entre paréntesis', () => {
  const i = SG.indexOf("router.get('/despachos'");
  const b = SG.slice(i, i + 2200);
  assert.match(b, /if \(req\.query\.solo_cadenas === '1'\) where\.push\(SQL_ES_CADENA\);/);
  // El paréntesis de afuera no es decorativo: los where se pegan con AND y un OR
  // suelto se comería `activo=1`, devolviendo también los remitos anulados.
  assert.match(b, /where\.push\('\(NOT ' \+ SQL_ES_CADENA \+ ' OR d\.cliente_id IS NULL OR c\.id IS NULL\)'\);/);
});

test('y la pantalla pide el suyo', () => {
  const i = PANEL.indexOf('function sgDespListar(modo){');
  assert.ok(i > 0, 'las dos listas no comparten función');
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /'\/api\/sg\/despachos\?solo_remitos=1&'\+\(sup\?'solo_cadenas=1':'sin_cadenas=1'\)/);
  assert.match(PANEL, /function sgLoadDespachos\(\)\{ sgDespListar\('normal'\); \}/);
  assert.match(PANEL, /function sgRemSuperLoad\(\)\{ sgDespListar\('super'\); \}/);
  // Y la solapa está enganchada.
  const j = PANEL.indexOf('function sgVenSub(s){');
  assert.match(PANEL.slice(j, j + 1000), /else if \(s==='remsuper'\) sgRemSuperLoad\(\);/);
  assert.match(PANEL, /data-sub="remsuper"/);
  assert.match(PANEL, /id="sgv-sub-remsuper"/);
});

// ── 4 · TURNO Y OC ─────────────────────────────────────────────────────────

test('las dos columnas existen, y son del remito', () => {
  // Cambian en cada entrega: no son del cliente.
  assert.match(DBSG, /addCol\('sg_despachos',\s+'turno',\s+'TEXT'\)/);
  assert.match(DBSG, /addCol\('sg_despachos',\s+'oc_cliente',\s+'TEXT'\)/);
});

test('el remito las guarda', () => {
  const i = SG.indexOf('const postRemito = (req, res)');
  const b = SG.slice(i, SG.indexOf('\r\n};', i));
  // El flete se abrio en tres columnas (2/9/2026) con el vocabulario de la orden.
  assert.match(b, /turno, oc_cliente, flete_paga,\r?\n\s*flete_a_cargo, flete_pagado_por, flete_monto\)/);
  assert.match(b, /VALUES \(\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?\)/);
});

test('los pide sólo el remito a cadena', () => {
  // Preguntarle el turno de descarga al que carga una camioneta para el puesto es
  // pedirle un dato que no existe.
  assert.match(PANEL, /<div class="fl sg-desp-super" style="display:none"><label>Turno de descarga<\/label>/);
  assert.match(PANEL, /<div class="fl sg-desp-super" style="display:none"><label>OC del supermercado<\/label>/);
  const i = PANEL.indexOf('function sgDespOpen(modo){');
  assert.ok(i > 0, 'el modal no sabe en qué modo abre');
  const b = PANEL.slice(i, i + 1600);
  assert.match(b, /querySelectorAll\('#sg-desp-modal \.sg-desp-super'\)\)\.forEach\(function\(el\)\{\r?\n\s*el\.style\.display = sup \? '' : 'none';/);
  // Y se limpian al abrir: si no, el turno de la entrega anterior sale impreso en
  // el remito siguiente.
  assert.match(b, /eid\('sg-desp-turno'\)\.value=''; eid\('sg-desp-occli'\)\.value='';/);
});

test('y el cliente sale de la lista que corresponde', () => {
  // Ofrecer el padrón entero en la pantalla de cadenas deja que un remito con
  // turno y OC salga a nombre de una verdulería, y después no aparece en la lista
  // donde lo fueron a buscar.
  const i = PANEL.indexOf('function sgDespOpen(modo){');
  const b = PANEL.slice(i, i + 1600);
  assert.match(b, /\? sgCliOpts\('','','— Elegí la cadena —', sgEsCadena\)/);
  assert.match(b, /if \(sup\) sgCadenaUnico\('sg-desp-cli'\); else sgCliUnico\('sg-desp-cli'\);/);
});

test('viajan al servidor', () => {
  const i = PANEL.indexOf('function sgDespGuardar(){');
  const b = PANEL.slice(i, i + 3200);
  assert.match(b, /turno:\(eid\('sg-desp-turno'\)\.value\|\|''\)\.trim\(\),/);
  assert.match(b, /oc_cliente:\(eid\('sg-desp-occli'\)\.value\|\|''\)\.trim\(\),/);
  // Y al guardar se refresca la lista de la que se salió: el remito a la cadena no
  // aparece en la de normales y parecería no haberse guardado.
  assert.match(b, /if \(sup\) sgRemSuperLoad\(\); else sgLoadDespachos\(\);/);
});

// ── 5 · Y SALEN IMPRESOS ───────────────────────────────────────────────────

test('el remito se imprime, y el turno y la OC van arriba', () => {
  // «Que salgan impresos» — Pablo. No había impresión de remito: el papel que
  // acompaña la mercadería se hacía a mano.
  const i = PANEL.indexOf('function sgDespImprimir(id){');
  assert.ok(i > 0, 'no existe la impresión del remito');
  const b = PANEL.slice(i, i + 3000);
  assert.match(b, /caja\('Turno de descarga', d\.turno\)/);
  assert.match(b, /caja\('OC del cliente', d\.oc_cliente\)/);
  // Si el remito no los trae, no se dibujan: en uno común serían dos rótulos
  // vacíos que no dicen nada.
  assert.match(b, /if \(d\.turno\) cajas\.push/);
  assert.match(b, /if \(d\.oc_cliente\) cajas\.push/);
  assert.match(b, /_ccImprimir\('Remito '\+\(d\.numero\|\|''\), h\);/);
});

test('y el papel trae lo que un remito tiene que traer', () => {
  const i = PANEL.indexOf('function sgDespImprimir(id){');
  const b = PANEL.slice(i, i + 3000);
  // «Flete» y no «Transporte»: el selector de transporte se sacó (2/9/2026), y lo
  // que hace falta en el papel es quién trae el camión y quién lo paga.
  for (const dato of ['Cliente', 'Fecha', 'Flete', 'Chofer / dominio',
                      'Lote', 'Producto', 'Cajones', 'Recib\\u00ed conforme']) {
    assert.match(b, new RegExp(dato), 'al remito impreso le falta: ' + dato);
  }
  // Total de cajones y de kilos: es contra lo que firma el que recibe.
  assert.match(b, /its\.reduce\(function\(a,x\)\{return a\+\(Number\(x\.bultos\)\|\|0\);\},0\)/);
  assert.match(b, /its\.reduce\(function\(a,x\)\{return a\+\(Number\(x\.kg_despachados\)\|\|0\);\},0\)/);
});

test('y se ofrece imprimirlo apenas se guarda', () => {
  const i = PANEL.indexOf('function sgDespGuardar(){');
  assert.match(PANEL.slice(i, i + 3200), /if \(r\.data && r\.data\.id\) sgDespImprimir\(r\.data\.id\);/);
  // También desde el renglón de la lista, para reimprimirlo.
  const j = PANEL.indexOf('function sgDespListar(modo){');
  assert.match(PANEL.slice(j, j + 2600), /onclick="sgDespImprimir\('\+d\.id\+'\)">🖨<\/button>/);
});
