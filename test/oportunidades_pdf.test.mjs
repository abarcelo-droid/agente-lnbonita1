// El informe de oportunidades en PDF.
//
// Dos cosas que pueden estar mal sin que se note abriendo el archivo:
//
// 1. QUÉ ENTRA. El informe promete "las más importantes". Si agrupara por cliente ANTES de
//    recortar, un cliente con quince cosas chicas entraría entero y dejaría afuera la
//    oportunidad más grande de otro: el papel diría una cosa y sería otra.
// 2. QUÉ SE VE. El que no puede ver margen no lo puede ver tampoco en el PDF. Un informe es
//    justamente lo que se manda por mail y se reenvía.
//
// El resto —que el PDF se genere, que tenga el membrete, que la explicación esté— se prueba
// generándolo de verdad y leyendo el texto del archivo: jsPDF no comprime los streams, así
// que lo escrito aparece tal cual adentro.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generarOportunidadesPDF, agruparPorCliente, GUIA } from '../src/servicios/oportunidadesPDF.js';

const op = (tipo, cliente, detalle, usd, margen) => ({
  tipo, titulo: cliente, detalle,
  regla: 'Regla de prueba para ' + cliente + (detalle ? ' / ' + detalle : '') + '.',
  usd_en_juego: usd, margen_en_juego: margen,
  filtro: { cliente },
});

// Ordenadas por margen, como las devuelve el radar.
const ITEMS = [
  op('CLIENTE_PERDIDO',  'COTO',     '',        50000, 5000),
  op('CROSS_SELL',       'INC S.A.', 'BROCOLI', 20000, 2000),
  op('PRODUCTO_PERDIDO', 'COTO',     'PAPA',    10000, 1000),
  op('CAIDA_FUERTE',     'COTO',     'CEBOLLA',  9000,  900),
  op('MARGEN_NEGATIVO',  'CENCOSUD', 'NARANJA',  8000,  800),
];

const DATA = {
  ventana: { mes: '02-AGOSTO', actual: '2026-2027', anterior: '2025-2026', en_curso: true },
  ve_margen: true, total: 137, margen_en_juego_total: 41200,
  umbrales: { piso_usd: 200, caida_pct: 30, cross_min_clientes: 3 },
  sync: { ultimo_ok: '2026-08-26 00:01' },
  items: ITEMS,
};

// ── QUÉ ENTRA ─────────────────────────────────────────────────────────────────────────
test('entran las N más importantes de la lista, no los N primeros clientes', () => {
  // Con tope 2 entran COTO (50.000) e INC (20.000) — las dos primeras de la lista.
  const { elegidas, grupos } = agruparPorCliente(ITEMS, 2, true);
  assert.equal(elegidas.length, 2);
  assert.deepEqual(grupos.map(g => g.cliente), ['COTO', 'INC S.A.']);
  // Y NO entran las otras dos de COTO, aunque sean del mismo cliente que la primera: son
  // menos importantes que la de INC.
  assert.deepEqual(grupos[0].lista.map(x => x.detalle), ['']);
});

test('agrupa por cliente y suma lo de cada uno', () => {
  const { grupos } = agruparPorCliente(ITEMS, 25, true);
  assert.deepEqual(grupos.map(g => g.cliente), ['COTO', 'INC S.A.', 'CENCOSUD']);
  const coto = grupos[0];
  assert.equal(coto.lista.length, 3);
  assert.equal(coto.usd, 69000);
  assert.equal(coto.margen, 6900);
});

test('sin margen, los clientes se ordenan por dólares', () => {
  // Un caso donde los dos criterios NO dan lo mismo: A factura más, B deja más margen.
  const items = [
    op('CLIENTE_PERDIDO', 'B FINO',  '', 10000, 4000),
    op('CLIENTE_PERDIDO', 'A GORDO', '', 30000, 600),
  ];
  assert.deepEqual(agruparPorCliente(items, 25, true).grupos.map(g => g.cliente), ['B FINO', 'A GORDO']);
  assert.deepEqual(agruparPorCliente(items, 25, false).grupos.map(g => g.cliente), ['A GORDO', 'B FINO']);
});

test('el tope tiene techo y piso: ni cero hojas ni doscientas', () => {
  const muchas = Array.from({ length: 400 }, (_, i) => op('CLIENTE_PERDIDO', 'C' + i, '', 1000 - i, 100));
  assert.equal(agruparPorCliente(muchas, 500, true).elegidas.length, 200);
  assert.equal(agruparPorCliente(muchas, 0, true).elegidas.length, 25);
  assert.equal(agruparPorCliente(muchas, -3, true).elegidas.length, 25);
});

test('una lista vacía no explota', () => {
  const r = agruparPorCliente([], 25, true);
  assert.deepEqual(r.elegidas, []);
  assert.deepEqual(r.grupos, []);
});

test('cada tipo del radar tiene su explicación y su qué hacer', () => {
  // Si aparece un tipo nuevo en oportunidades.js y nadie escribe su guía, el PDF lo listaría
  // sin decir qué es — que es justamente lo que este informe viene a evitar.
  for (const t of ['CLIENTE_PERDIDO', 'PRODUCTO_PERDIDO', 'CAIDA_FUERTE', 'CROSS_SELL', 'MARGEN_NEGATIVO']) {
    assert.ok(GUIA[t], 'falta la guía de ' + t);
    assert.ok(GUIA[t].que.length > 30, t + ' no explica qué es');
    assert.ok(GUIA[t].hacer.length > 30, t + ' no dice qué hacer');
    assert.ok(Array.isArray(GUIA[t].color) && GUIA[t].color.length === 3, t + ' sin color');
  }
});

// ── EL ARCHIVO ────────────────────────────────────────────────────────────────────────
// jsPDF no comprime los streams, así que lo escrito se lee tal cual dentro del binario.
const texto = (buf) => buf.toString('latin1');

test('genera un PDF de verdad', () => {
  const buf = generarOportunidadesPDF(DATA, { tope: 25, hoy: '26/08/2026' });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(texto(buf).slice(0, 5), '%PDF-');
  assert.ok(buf.length > 3000, 'salió sospechosamente chico: ' + buf.length);
});

test('lleva el membrete de la casa y de qué ventana habla', () => {
  const t = texto(generarOportunidadesPDF(DATA, { tope: 25, hoy: '26/08/2026' }));
  assert.ok(t.includes('OPORTUNIDADES COMERCIALES'));
  assert.ok(t.includes('San') && t.includes('nimo'));      // "San Gerónimo", con la ó escapada
  assert.ok(t.includes('AGOSTO'));
  assert.ok(t.includes('2026-2027') && t.includes('2025-2026'));
});

test('la leyenda explica los CINCO tipos, aparezcan o no en este informe', () => {
  // Cambió a propósito: la leyenda pasó a la última página y es una hoja de REFERENCIA. El
  // que la guarda se va a encontrar el mes que viene con los tipos que hoy no salieron, así
  // que están todos — y los que no aparecen se marcan, para no hacerlos buscar en el informe.
  const uno = texto(generarOportunidadesPDF(
    Object.assign({}, DATA, { items: [ITEMS[0]] }), { tope: 25, hoy: '26/08/2026' }));
  for (const g of Object.values(GUIA)) assert.ok(uno.includes(g.label), 'falta ' + g.label);
  assert.ok(uno.includes('no aparece en este informe'));
  assert.ok(uno.includes('hacer'), 'no aparece el "qué hacer"');
});

test('la leyenda va DESPUÉS de todo lo demás', () => {
  // Es de consulta: adelante empujaba hacia abajo lo único que se mira todos los días, y la
  // primera hoja de un informe es la que se mira.
  const t = texto(generarOportunidadesPDF(Object.assign({}, DATA, {
    por_producto: [{ producto: 'CEBOLLA', usd_act: 100, usd_ant: 900, kg_act: 10, kg_ant: 90,
      clientes_act: 1, clientes_ant: 3, var_usd: -800, var_usd_pct: -88.9, var_kg: -80, var_kg_pct: -88.9,
      clientes_perdidos: [{ cliente: 'COTO', usd_ant: 800, kg_ant: 80 }],
      clientes_menos: [], proveedores_perdidos: [], proveedores_hoy: [] }],
  }), { tope: 25, hoy: '26/08/2026' }));
  const iSecciones = t.indexOf('Por producto');
  const iLeyenda = t.indexOf('significa cada cosa');
  assert.ok(iSecciones > 0, 'no salió la sección por producto');
  assert.ok(iLeyenda > iSecciones, 'la leyenda quedó antes de las secciones');
});

test('avisa del mes en curso, y no lo hace cuando el mes está cerrado', () => {
  const conAviso = texto(generarOportunidadesPDF(DATA, { tope: 25, hoy: '26/08/2026' }));
  assert.ok(conAviso.includes('medio facturar'));
  const cerrado = Object.assign({}, DATA, {
    ventana: Object.assign({}, DATA.ventana, { en_curso: false }) });
  assert.ok(!texto(generarOportunidadesPDF(cerrado, { tope: 25, hoy: '26/08/2026' })).includes('medio facturar'));
});

test('el que no ve margen no lo ve tampoco en el papel', () => {
  // Es el punto delicado: un PDF se manda por mail y se reenvía.
  const sinM = {
    ...DATA, ve_margen: false, margen_en_juego_total: undefined,
    items: ITEMS.map(({ margen_en_juego, ...resto }) => resto),
  };
  const t = texto(generarOportunidadesPDF(sinM, { tope: 25, hoy: '26/08/2026' }));
  assert.ok(!t.includes('margen sobre la mesa'), 'muestra el total de margen');
  assert.ok(!t.includes('de margen'), 'muestra margen por cliente');
  // Pero sigue diciendo lo que sí puede ver, y explicando el orden.
  assert.ok(t.includes('en juego'));
  assert.ok(t.includes('COTO'));
  assert.ok(t.includes('la misma') || t.includes('mismos'), 'no explica por qué el orden es ese');
});

test('con muchas oportunidades pagina en vez de escribir encima', () => {
  const muchas = Array.from({ length: 60 }, (_, i) =>
    op('CLIENTE_PERDIDO', 'CLIENTE NUMERO ' + i, '', 5000 - i, 500 - i));
  const buf = generarOportunidadesPDF(Object.assign({}, DATA, { items: muchas }), { tope: 60, hoy: '26/08/2026' });
  const paginas = (texto(buf).match(/\/Type \/Page[^s]/g) || []).length;
  assert.ok(paginas >= 2, 'quedó en ' + paginas + ' página(s): 60 oportunidades no entran en una');
  // Y cada página tiene su membrete: si no, la segunda hoja suelta no dice de qué es.
  const membretes = (texto(buf).match(/OPORTUNIDADES COMERCIALES/g) || []).length;
  assert.equal(membretes, paginas);
});

test('el pie dice de cuándo son los datos, que es lo que envejece', () => {
  const t = texto(generarOportunidadesPDF(DATA, { tope: 25, hoy: '26/08/2026' }));
  assert.ok(t.includes('26/08/2026'));
  assert.ok(t.includes('2026-08-26'), 'no dice la fecha del último sync');
});
