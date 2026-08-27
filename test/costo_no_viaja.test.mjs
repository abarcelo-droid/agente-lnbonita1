// ══ EL COSTO DE COMPRA NO VIAJA A QUIEN NO TIENE QUE VERLO ═════════════════
//
// Pablo, 26/8/2026: «el vendedor ve a cuánto compramos».
//
// Este test no mira el código: LO CORRE. Levanta el servicio real con una base de
// permisos de verdad —usuario_modulos, la misma tabla que consulta el sistema— y le
// pasa respuestas con la forma exacta que devuelven los endpoints.
//
// LA TRAMPA QUE CUIDA: en este sistema conviven `precio_unitario_kg` —lo que se le
// PAGÓ al productor— y `precio_por_kg` —lo que se le COBRA al cliente—. El día que
// alguien cambie la lista explícita por un patrón tipo /precio|costo/, las pantallas
// de venta se quedan sin el número que SÍ tienen que mostrar y nadie se entera hasta
// que un vendedor abre un remito en blanco.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (p) => fs.readFileSync(path.join(RAIZ, p), 'utf8');
const SG = leer('src/rutas/sg.js');

// ── EL SERVICIO REAL, CON UNA BASE DE PERMISOS DE VERDAD ───────────────────
// permisos.js abre la base con better-sqlite3, que no está instalado. Se copia
// servicios/ a un temporal y se reemplaza SÓLO el módulo que abre la base por uno
// que usa node:sqlite —el que viene con Node 24— con la tabla de permisos real.
// Es la técnica que ya usa test/plata_sg.test.mjs.
async function servicioReal(permisos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-costo-'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/servicios'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(RAIZ, 'src/servicios', f), path.join(dir, f));
  }
  const filas = JSON.stringify(permisos);
  fs.writeFileSync(path.join(dir, 'db.js'),
    "import { DatabaseSync } from 'node:sqlite';\n"
    + "const db = new DatabaseSync(':memory:');\n"
    + "db.exec('CREATE TABLE usuario_modulos (usuario_id INTEGER, modulo TEXT, nivel TEXT)');\n"
    + "db.exec('CREATE TABLE modulos_config (modulo TEXT, api_prefijos TEXT, api_lectura TEXT, oculto INTEGER DEFAULT 0, orden INTEGER, label TEXT)');\n"
    + "db.exec('CREATE TABLE sociedades (id INTEGER PRIMARY KEY, nombre TEXT, activa INTEGER)');\n"
    + "db.exec('CREATE TABLE usuario_sociedades (usuario_id INTEGER, sociedad_id INTEGER)');\n"
    + "db.exec('CREATE TABLE usuarios (id INTEGER PRIMARY KEY, secciones TEXT)');\n"
    + "for (const p of " + filas + ") {\n"
    + "  db.prepare('INSERT INTO usuario_modulos (usuario_id, modulo, nivel) VALUES (?,?,?)')\n"
    + "    .run(p.usuario_id, p.modulo, p.nivel);\n"
    + "}\n"
    + "export default db; export const getDb = () => db; export const dbPa = db;\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'db_permisos.js'), 'export default {};\n', 'utf8');
  return import('file:///' + path.join(dir, 'sg_costo_visible.js').replace(/\\/g, '/'));
}

// Los tres personajes: el que vende, el que mira stock, y el dueño.
const VENDEDOR = { id: 10, rol: 'usuario' };
const DEPOSITO = { id: 20, rol: 'usuario' };
const PABLO = { id: 1, rol: 'admin' };
const PERMISOS = [
  { usuario_id: 10, modulo: 'sg-ventas', nivel: 'operar' },
  { usuario_id: 10, modulo: 'sg-pedidos', nivel: 'operar' },
  { usuario_id: 10, modulo: 'sg-vta-comprobantes', nivel: 'operar' },
  { usuario_id: 10, modulo: 'sg-cc-clientes', nivel: 'ver' },
  { usuario_id: 20, modulo: 'sg-stock', nivel: 'operar' },
];

// ── QUIÉN VE EL COSTO ──────────────────────────────────────────────────────
test('el que sólo vende NO ve el costo; el del depósito y el dueño sí', async () => {
  const { puedeVerCosto } = await servicioReal(PERMISOS);
  assert.equal(puedeVerCosto(VENDEDOR), false, 'el vendedor no tiene por qué ver a cuánto compramos');
  assert.equal(puedeVerCosto(DEPOSITO), true, 'la ficha de la partida es su trabajo');
  assert.equal(puedeVerCosto(PABLO), true, 'admin siempre');
  assert.equal(puedeVerCosto(null), false, 'sin sesión no se ve nada');
  assert.equal(puedeVerCosto({ rol: 'usuario' }), false, 'sin id tampoco');
});

test('alcanza UN módulo de costo para verlo en todas las pantallas', async () => {
  // La regla es sobre la PERSONA, no sobre la pantalla: quien lo tiene a un clic en
  // Stock no gana nada con que se lo escondan en Salidas, y esconderlo ahí sí rompe
  // su trabajo. Es la misma lógica que ya usa mejorNivel() para las escrituras.
  const { puedeVerCosto } = await servicioReal(
    PERMISOS.concat([{ usuario_id: 10, modulo: 'sg-compras', nivel: 'ver' }]));
  assert.equal(puedeVerCosto(VENDEDOR), true);
});

// ── QUÉ SE SACA Y QUÉ NO ───────────────────────────────────────────────────
test('la lista de partidas sale sin costo pero con todo lo demás', async () => {
  const { sinCosto } = await servicioReal(PERMISOS);
  // La forma exacta de GET /lotes-disponibles (sg.js:7480).
  const r = sinCosto({ ok: true, data: [{
    id: 7, codigo_lote: 'L-0007', producto_id: 3, producto_nombre: 'Tomate',
    calidad: 'primera', semaforo: 'verde', costo_final: 184000, kg_reales: 900,
    bultos: 60, kg_por_bulto: 15, kg_vigente: 900, precio_unitario_kg: 204.44,
    fecha_vencimiento_estimada: '2026-09-10', dias_restantes: 15, kg_disponibles: 750,
  }] });
  const l = r.data[0];
  assert.equal(l.costo_final, undefined, 'lo que costó la partida no sale');
  assert.equal(l.precio_unitario_kg, undefined, 'lo que se le pagó al productor por kilo, tampoco');
  // Y sigue sirviendo para vender: sin esto el selector queda vacío.
  assert.equal(l.codigo_lote, 'L-0007');
  assert.equal(l.kg_disponibles, 750);
  assert.equal(l.semaforo, 'verde');
  assert.equal(l.kg_por_bulto, 15);
  assert.equal(l.dias_restantes, 15);
  assert.equal(r.ok, true);
});

test('EL PRECIO DE VENTA SOBREVIVE — es la trampa de este arreglo', async () => {
  // precio_unitario_kg (compra) se va; precio_por_kg (venta) se queda. Un patrón
  // /precio|costo/ se llevaría los dos y dejaría el remito sin el número a cobrar.
  const { sinCosto } = await servicioReal(PERMISOS);
  const r = sinCosto({ data: [{
    precio_por_kg: 950, precio_unitario: 14250, subtotal: 142500, total: 172425,
    kg_despachados: 150, iva_monto: 29925, descuento_pct: 5,
    precio_unitario_kg: 204.44, margen_estimado: 40000,
  }] });
  const d = r.data[0];
  assert.equal(d.precio_por_kg, 950, 'lo que se le cobra al cliente TIENE que salir');
  assert.equal(d.precio_unitario, 14250);
  assert.equal(d.subtotal, 142500);
  assert.equal(d.total, 172425);
  assert.equal(d.iva_monto, 29925);
  assert.equal(d.descuento_pct, 5);
  assert.equal(d.kg_despachados, 150);
  assert.equal(d.precio_unitario_kg, undefined, 'lo que se le pagó al productor, no');
  assert.equal(d.margen_estimado, undefined);
});

test('el margen se va: con el subtotal al lado, el costo se despeja exacto', async () => {
  // costo = (subtotal − margen) / kg. Esconder el costo y publicar el margen es no
  // esconder nada.
  const { sinCosto } = await servicioReal(PERMISOS);
  const r = sinCosto({ data: { margen: 40000, margen_neto: 37000, subtotal: 142500,
    items: [{ margen_estimado: 40000, kg_despachados: 150, precio_por_kg: 950 }] } });
  assert.equal(r.data.margen, undefined);
  assert.equal(r.data.margen_neto, undefined);
  assert.equal(r.data.items[0].margen_estimado, undefined);
  assert.equal(r.data.items[0].precio_por_kg, 950);
  assert.equal(r.data.subtotal, 142500);
});

test('llega hasta el fondo de una ficha anidada', async () => {
  // La trazabilidad de una partida anida lote → orden → ítems → despachos. Si el
  // filtro se quedara en el primer nivel, el costo saldría igual dos capas abajo.
  const { sinCosto } = await servicioReal(PERMISOS);
  const r = sinCosto({ data: { lote: { costo_base: 100, codigo_lote: 'L-1' },
    oc: { id: 4, items: [{ precio_unitario_kg: 55, kg: 10,
      despachos: [{ margen_estimado: 9, cliente: 'Coto' }] }] } } });
  assert.equal(r.data.lote.costo_base, undefined);
  assert.equal(r.data.lote.codigo_lote, 'L-1');
  assert.equal(r.data.oc.items[0].precio_unitario_kg, undefined);
  assert.equal(r.data.oc.items[0].kg, 10);
  assert.equal(r.data.oc.items[0].despachos[0].margen_estimado, undefined);
  assert.equal(r.data.oc.items[0].despachos[0].cliente, 'Coto');
});

test('las fechas y los nulos no se rompen al podar', async () => {
  const { sinCosto } = await servicioReal(PERMISOS);
  const r = sinCosto({ data: { fecha: '2026-08-26', nada: null, cero: 0, no: false, lista: [] } });
  assert.equal(r.data.fecha, '2026-08-26');
  assert.equal(r.data.nada, null);
  assert.equal(r.data.cero, 0);
  assert.equal(r.data.no, false);
  assert.deepEqual(r.data.lista, []);
});

// ── EL FILTRO, COMO LO VE EL ROUTER ────────────────────────────────────────
function pedido(metodo, user) {
  const req = { method: metodo, cookies: user ? { lnb_user: JSON.stringify(user) } : {} };
  const res = { enviado: null };
  res.json = (c) => { res.enviado = c; return res; };
  return { req, res };
}

test('el filtro poda las LECTURAS de quien no puede ver el costo', async () => {
  const { filtrarCosto } = await servicioReal(PERMISOS);
  const { req, res } = pedido('GET', VENDEDOR);
  let siguio = false;
  filtrarCosto(req, res, () => { siguio = true; });
  assert.equal(siguio, true, 'el filtro no corta el pedido, sólo poda la respuesta');
  res.json({ data: [{ costo_final: 9, kg_disponibles: 5 }] });
  assert.equal(res.enviado.data[0].costo_final, undefined);
  assert.equal(res.enviado.data[0].kg_disponibles, 5);
});

test('al que puede ver el costo NO se le toca la respuesta', async () => {
  const { filtrarCosto } = await servicioReal(PERMISOS);
  for (const u of [DEPOSITO, PABLO]) {
    const { req, res } = pedido('GET', u);
    filtrarCosto(req, res, () => {});
    const cuerpo = { data: [{ costo_final: 9 }] };
    res.json(cuerpo);
    assert.equal(res.enviado.data[0].costo_final, 9);
    assert.equal(res.enviado, cuerpo, 'ni siquiera se copia');
  }
});

test('escribir no se toca: el que carga el costo ya lo sabe', async () => {
  const { filtrarCosto } = await servicioReal(PERMISOS);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const { req, res } = pedido(m, VENDEDOR);
    filtrarCosto(req, res, () => {});
    res.json({ data: { costo_final: 9 } });
    assert.equal(res.enviado.data.costo_final, 9, m + ' no debería podarse');
  }
});

test('sin sesión también se poda', async () => {
  // No debería llegar —el portón de index.js pide sesión— pero si algún día llega,
  // que no sea el costo lo que se lleva.
  const { filtrarCosto } = await servicioReal(PERMISOS);
  const { req, res } = pedido('GET', null);
  filtrarCosto(req, res, () => {});
  res.json({ data: { costo_final: 9 } });
  assert.equal(res.enviado.data.costo_final, undefined);
});

// ── LA PUERTA ES UNA SOLA ──────────────────────────────────────────────────
test('el filtro se monta sobre el router ENTERO, no endpoint por endpoint', () => {
  // Tapar agujero por agujero es garantizar que el próximo endpoint nazca abierto:
  // a /oferta se le sacó el costo del SELECT y el arreglo se salteaba pidiendo
  // /lotes-disponibles, que devolvía las mismas partidas con el costo puesto.
  assert.match(SG, /router\.use\(filtrarCosto\);/);
  const usoFiltro = SG.indexOf('router.use(filtrarCosto)');
  const primeraRuta = SG.search(/router\.(get|post|put|patch|delete)\(/);
  assert.ok(usoFiltro > 0 && primeraRuta > 0);
  assert.ok(usoFiltro < primeraRuta, 'montado después de la primera ruta no filtra esa ruta');
});

test('el Excel de camiones también pide el permiso', () => {
  // Sale por res.send, así que el filtro —que envuelve res.json— no lo ve. Un archivo
  // que se baja y circula por mail es peor que una pantalla.
  const i = SG.indexOf("router.get('/embarques/export'");
  assert.ok(i > 0);
  const bloque = SG.slice(i, i + 400);
  assert.match(bloque, /if \(!puedeVerCosto\(req\.user\)\)/);
  assert.match(bloque, /res\.status\(403\)/);
});

test('los módulos de venta quedan FUERA de la lista de costo', async () => {
  const { MODULOS_COSTO } = await servicioReal(PERMISOS);
  for (const m of ['sg-ventas', 'sg-pedidos', 'sg-vta-comprobantes', 'sg-remitos-pend',
    'sg-cc-clientes', 'sg-catalogo', 'sg-pisos']) {
    assert.ok(!MODULOS_COSTO.includes(m), m + ' no costea nada: no va en la lista');
  }
  // Y los que sí costean están, porque si falta uno su pantalla se rompe.
  for (const m of ['sg-compras', 'sg-ordenes', 'sg-stock', 'sg-reprocesos',
    'sg-gastos-directos', 'sg-importacion', 'sg-cc-proveedores']) {
    assert.ok(MODULOS_COSTO.includes(m), m + ' necesita el costo para trabajar');
  }
});
