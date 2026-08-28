// ══ CUÁNTO DE LA ORDEN ENTRÓ ═══════════════════════════════════════════════
//
// Pablo, 27/8/2026: «en órdenes recibidas sería bueno que las columnas sean
// Bultos Pedidos, Bultos Recibidos y % de Recepción, para ver rápido qué
// porcentaje de la orden de compra se recepcionó».
//
// El estado de esa solapa miente: actualizarEstadoOC pone 'recibida_total'
// apenas hay UNA recepción, sin comparar nada contra lo pedido. Una orden de
// 1.188 kg de la que bajaron 38 está ahí adentro diciendo «Rec. total».
//
// Estos tests CORREN la función real del panel. El riesgo de una columna así no
// es que no aparezca: es que muestre un número inventado y nadie lo note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');

// Las tres funciones del panel, extraídas y evaluadas de verdad.
function cargar() {
  const i = PANEL.indexOf('function sgOcRecepcion(o){');
  assert.ok(i > 0, 'no existe sgOcRecepcion');
  const fin = PANEL.indexOf('// Las órdenes ya recibidas.', i);
  assert.ok(fin > i);
  const src = PANEL.slice(i, fin);
  // eslint-disable-next-line no-new-func
  return new Function('esc', 'nr', src
    + '; return { rec: sgOcRecepcion, barra: sgOcRecepBarra, num: sgOcRecepNum };')(
    (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    (x) => String(Math.round(Number(x) || 0)),
  );
}
const F = cargar();

// Una orden pactada por cajón, con dos renglones, para no depender de defaults.
const porBulto = (extra) => Object.assign({
  modalidad: 'normal', items_total: 2, items_pactados_bulto: 2, pactada_por_bulto: 1,
  bultos_estimados: 90, bultos_equivalentes: 90, bultos_recibidos_total: 90,
  lotes_sin_contar: 0, lotes_sin_factor: 0,
  total_estimado_kg: 810, kg_recibidos_total: 810,
}, extra || {});

// ── LO QUE PABLO PIDIÓ ─────────────────────────────────────────────────────
test('entró todo: 100%', () => {
  const r = F.rec(porBulto());
  assert.equal(r.unidad, 'bultos');
  assert.equal(r.pedido, 90);
  assert.equal(r.recibido, 90);
  assert.equal(r.pct, 100);
  assert.equal(r.confiable, true);
});

test('entró la mitad: la orden dice «Rec. total» y el porcentaje dice 50', () => {
  // ÉSTE es el caso por el que existe la columna. Sin ella hay que abrir la
  // orden de a una para enterarse.
  const r = F.rec(porBulto({ bultos_equivalentes: 45, bultos_recibidos_total: 45 }));
  assert.equal(r.pct, 50);
  const html = F.barra(r);
  assert.match(html, /#dc2626/, 'menos de 80% va en rojo');
  assert.match(html, /50%/);
  assert.match(html, /45 de 90/);
});

test('el corte de color es el mismo que ya usa la otra barra del módulo', () => {
  // 100 verde, 80-99 amarillo, menos de 80 rojo. Es de Pablo, 24/8/2026, y ya
  // está escrito en sgAvanceBarra: dos escalas distintas en la misma pantalla
  // se leen como dos cosas distintas.
  assert.match(F.barra(F.rec(porBulto({ bultos_equivalentes: 90 }))), /#16a34a/);
  assert.match(F.barra(F.rec(porBulto({ bultos_equivalentes: 80 }))), /#d19a1a/);
  assert.match(F.barra(F.rec(porBulto({ bultos_equivalentes: 71 }))), /#dc2626/);
});

test('un decimal, como la otra barra', () => {
  // 45,01 bultos sobre 90 no es "50%": el redondeo grueso es de donde salieron
  // los carteles que no cerraban al centavo.
  const r = F.rec(porBulto({ bultos_estimados: 3, bultos_equivalentes: 1 }));
  assert.equal(r.pct, 33.3);
});

// ── ENTRÓ DE MÁS ───────────────────────────────────────────────────────────
test('más del 100% se muestra como es, no se recorta a 100', () => {
  // Recibir de más es un hecho: no hay ningún tope al recibir. Recortarlo a 100
  // borra el único caso que obliga a hacer algo.
  const r = F.rec(porBulto({ bultos_equivalentes: 100, bultos_recibidos_total: 100 }));
  assert.equal(r.pct, 111.1);
  assert.match(F.barra(r), /111\.1%/);
});

test('pero la BARRA sí se topea, o se sale de la celda', () => {
  const html = F.barra(F.rec(porBulto({ bultos_equivalentes: 180, bultos_recibidos_total: 180 })));
  assert.match(html, /width:100%/);
  assert.ok(!/width:200%/.test(html));
});

test('y entró de más NO es verde', () => {
  // El conteo ya no se corrige; lo que se arregla es el precio, y eso alguien lo
  // tiene que hacer. Verde diría «está todo bien».
  const html = F.barra(F.rec(porBulto({ bultos_equivalentes: 100, bultos_recibidos_total: 100 })));
  assert.match(html, /#9a3412/);
  assert.ok(!/#16a34a/.test(html));
});

test('99,6 y 100,4 son «completa», no una anomalía', () => {
  // bultos_equivalentes sale de una división cuando el camión se pesó: exigir
  // el 100,0 exacto pintaría de rojo o de naranja órdenes que entraron enteras.
  assert.match(F.barra(F.rec(porBulto({ bultos_estimados: 1000, bultos_equivalentes: 996 }))), /#16a34a/);
  assert.match(F.barra(F.rec(porBulto({ bultos_estimados: 1000, bultos_equivalentes: 1004 }))), /#16a34a/);
});

// ── LA UNIDAD, QUE ES DONDE ESTO SE ROMPE ──────────────────────────────────
test('la orden comprada POR KILO habla en kilos, no en bultos inventados', () => {
  // El propio SELECT del listado lo dice: los bultos estimados de una compra por
  // kilo salen de dividir kilos por el factor y dan números que nadie pactó.
  const r = F.rec(porBulto({ items_pactados_bulto: 0, pactada_por_bulto: 0,
    bultos_estimados: 55.55, total_estimado_kg: 1000, kg_recibidos_total: 900 }));
  assert.equal(r.unidad, 'kg');
  assert.equal(r.pedido, 1000);
  assert.equal(r.recibido, 900);
  assert.equal(r.pct, 90);
  // Y la celda escribe la unidad, o el número se lee como cajones.
  assert.match(F.num(r.pedido, r), /kg/);
});

test('la celda de bultos NO escribe «kg» cuando son bultos', () => {
  assert.ok(!/kg/.test(F.num(90, F.rec(porBulto()))));
});

test('TODOS los renglones por cajón, no alguno', () => {
  // Con un renglón de cajones y otro de kilos, los bultos pedidos suman cajones
  // pactados con kilos÷factor: es sumar dos cosas distintas.
  const r = F.rec(porBulto({ items_total: 2, items_pactados_bulto: 1, pactada_por_bulto: 0 }));
  assert.equal(r.modo, 'mixta');
  assert.equal(r.unidad, 'kg');
});

test('la orden mixta informa el porcentaje pero SIN color', () => {
  // Los kilos de un renglón pactado por cajón los calculó la pantalla (cajones ×
  // kilos por cajón). El repo ya decidió que contra esos no se dispara aviso, y
  // el color es el aviso.
  const r = F.rec(porBulto({ items_total: 2, items_pactados_bulto: 1, pactada_por_bulto: 0,
    total_estimado_kg: 1000, kg_recibidos_total: 500 }));
  assert.equal(r.pct, 50);
  assert.equal(r.confiable, false);
  const html = F.barra(r);
  assert.ok(!/#dc2626/.test(html), 'una orden mixta no se pinta de rojo');
  assert.match(html, /renglones mixtos/);
});

test('las órdenes viejas, sin modo_carga, se cuentan por cajón igual', () => {
  // modo_carga llegó por migración. La regla tolerante (null con bultos
  // cargados = se pactó por cajón) es la MISMA que ya usa diferenciasDeOC: si
  // acá fuera otra, la orden se compararía en bultos en una pantalla y en kilos
  // en la otra.
  assert.match(SG, /i\.modo_carga IS NULL\s*\n?\s*AND COALESCE\(i\.cantidad_estimada_presentaciones, 0\) > 0/);
  assert.match(SG, /AS items_pactados_bulto/);
  assert.match(SG, /AS items_total/);
});

// ── LA QUE ENTRÓ SIN ORDEN ─────────────────────────────────────────────────
test('la orden retroactiva no tiene pedido: «—», no 6.000%', () => {
  // Su "cantidad pedida" guarda lotes.length —cuántos renglones se tipearon en
  // el formulario, no cuántos cajones—. Una descarga de un renglón con 60
  // cajones daría 60 sobre 1.
  const r = F.rec({ modalidad: 'retroactiva', items_total: 1, items_pactados_bulto: 1,
    pactada_por_bulto: 1,
    bultos_estimados: 1, bultos_equivalentes: 60, bultos_recibidos_total: 60,
    total_estimado_kg: 540, kg_recibidos_total: 540, lotes_sin_contar: 0, lotes_sin_factor: 0 });
  assert.equal(r.pedido, null);
  assert.equal(r.pct, null);
  assert.equal(r.nota, 'entró sin orden');
  assert.match(F.barra(r), /—/);
  assert.match(F.num(r.pedido, r), /—/);
  // Y no hay ningún 6000 ni 60 escondido en la celda del porcentaje.
  assert.ok(!/6000/.test(F.barra(r)));
});

test('la retroactiva se chequea PRIMERO, antes que la regla de la unidad', () => {
  // Con modo_carga en NULL y bultos cargados, la regla tolerante la clasificaría
  // como pactada por cajón y dispararía justamente ese 6.000%.
  const i = PANEL.indexOf('function sgOcRecepcion(o){');
  const b = PANEL.slice(i, i + 3000);
  const retro = b.indexOf("o.modalidad === 'retroactiva'");
  const unidad = b.indexOf('pactada_por_bulto');
  assert.ok(retro > 0 && unidad > retro, 'la unidad se decide antes que la retroactiva');
});

// ── LO QUE NADIE CONTÓ ─────────────────────────────────────────────────────
test('el camión que se pesó sin contar cajones no muestra «0 de 90»', () => {
  // bultos_recibidos_total da 0 y bultos_equivalentes saca los cajones del peso.
  const r = F.rec(porBulto({ bultos_recibidos_total: 0, bultos_equivalentes: 90, lotes_sin_contar: 2 }));
  assert.equal(r.recibido, 90);
  assert.equal(r.pct, 100);
  assert.equal(r.nota, 'por peso');
  assert.equal(r.confiable, true);
});

test('y si entró mitad contado y mitad pesado, se dice', () => {
  const r = F.rec(porBulto({ bultos_recibidos_total: 40, bultos_equivalentes: 90, lotes_sin_contar: 1 }));
  assert.equal(r.nota, 'parte por peso');
});

test('el caso mudo: sin conteo y sin kilos por bulto, el número está incompleto', () => {
  // bultos_equivalentes tiene un ELSE 0: un lote sin conteo, sin kg_por_bulto y
  // sin presentación aporta cero aunque aporte sus kilos. Sin esto la pantalla
  // pintaría rojo intenso una orden que entró completa.
  const r = F.rec(porBulto({ bultos_recibidos_total: 40, bultos_equivalentes: 40,
    lotes_sin_contar: 1, lotes_sin_factor: 1 }));
  assert.equal(r.confiable, false);
  assert.equal(r.nota, 'faltan contar');
  const html = F.barra(r);
  assert.ok(!/#dc2626/.test(html), 'no se pinta de rojo un dato incompleto');
  assert.ok(!/height:8px/.test(html), 'sin barra: dibujarla sería afirmar el número');
});

// ── SIN DENOMINADOR ────────────────────────────────────────────────────────
test('pedido en cero no es 0%: es que no hay contra qué comparar', () => {
  const r = F.rec(porBulto({ bultos_estimados: 0 }));
  assert.equal(r.pct, null);
  assert.equal(r.nota, 'sin pedido cargado');
  const html = F.barra(r);
  assert.match(html, /—/);
  assert.ok(!/0%/.test(html));
});

test('sin renglones tampoco se inventa una unidad', () => {
  const r = F.rec(porBulto({ items_total: 0, items_pactados_bulto: 0, pactada_por_bulto: 0,
    bultos_estimados: 0, total_estimado_kg: 0, kg_recibidos_total: 0 }));
  assert.equal(r.pct, null);
});

// ── LA PANTALLA ────────────────────────────────────────────────────────────
test('las tres columnas están en el encabezado, y el colspan las cuenta', () => {
  assert.match(PANEL, />Bultos pedidos<\/th>/);
  assert.match(PANEL, />Bultos recibidos<\/th>/);
  assert.match(PANEL, />% de recepción<\/th>/);
  assert.match(PANEL, /<tbody id="sg-tb-ocrecibidas"><tr><td colspan="10"/);
  assert.match(PANEL, /colspan="10" class="emp">Todavía no se recibió ninguna orden/);
  // Y ya no queda ningún colspan de 9 en esa tabla.
  const i = PANEL.indexOf('id="sg-tb-ocrecibidas"');
  assert.ok(!/colspan="9"/.test(PANEL.slice(i - 300, i + 300)));
});

test('las diez columnas del thead son diez, y los anchos suman 100', () => {
  const i = PANEL.indexOf('<thead><tr><th style="width:11%">Partida</th>');
  assert.ok(i > 0, 'no está el thead nuevo');
  const th = PANEL.slice(i, PANEL.indexOf('</tr></thead>', i));
  assert.equal((th.match(/<th[ >]/g) || []).length, 10);
  const suma = (th.match(/width:(\d+)%/g) || []).reduce((a, w) => a + Number(w.match(/\d+/)[0]), 0);
  assert.equal(suma, 100);
});

test('NINGUNA BARRA DE DESPLAZAMIENTO LATERAL', () => {
  // Once columnas dentro de un .ab-table-wrap, que trae su propio overflow-x:auto
  // desde la clase. Sin el !important la barra vuelve igual.
  assert.match(PANEL, /#sg-ocrec-wrap\{overflow-x:hidden !important\}/);
  assert.match(PANEL, /#sg-ocrec-wrap \.pa-tbl\{width:100%;table-layout:fixed\}/);
  assert.match(PANEL, /#sg-ocrec-wrap \.pa-tbl td\{[\s\S]{0,120}text-overflow:ellipsis\}/);
  assert.match(PANEL, /@media\(max-width:900px\)\{ #sg-ocrec-wrap\{overflow-x:auto !important\}/);
});

test('el wrapper lleva id propio, o le impone los anchos a la tabla de al lado', () => {
  // Dentro de #sgc-sub-ocrecibidas vive también la tabla "Entró sin orden de
  // compra", que es de cinco columnas: scopear por el id del bloque se la
  // llevaría puesta.
  assert.match(PANEL, /<div class="ab-table-wrap" id="sg-ocrec-wrap">/);
  assert.equal((PANEL.match(/id="sg-ocrec-wrap"/g) || []).length, 1);
  const i = PANEL.indexOf('id="sg-ocrec-wrap"');
  const j = PANEL.indexOf('id="sg-sinoc-wrap"');
  assert.ok(j > i, 'la tabla de sin-orden viene después, en el mismo bloque');
});

test('el ENCABEZADO va aparte, o las dos columnas nuevas quedan con el mismo título', () => {
  // Metido en la misma regla que las celdas, el th subía de 10px a 12,5px y se
  // quedaba con el nowrap+ellipsis: "BULTOS PEDIDOS" y "BULTOS RECIBIDOS" se
  // cortaban en el MISMO prefijo —"BULT…"— y quedaban dos columnas de números
  // con el mismo encabezado. A 10px y en dos renglones entran enteros.
  assert.match(PANEL, /#sg-ocrec-wrap \.pa-tbl th\{[^}]*font-size:10px/);
  assert.match(PANEL, /#sg-ocrec-wrap \.pa-tbl th\{[^}]*white-space:normal/);
  // Y no puede volver a compartir la regla del td.
  assert.ok(!/#sg-ocrec-wrap \.pa-tbl th,#sg-ocrec-wrap \.pa-tbl td/.test(PANEL));
});

test('la píldora de situación trunca ADENTRO suyo', () => {
  // Es un inline-block: el text-overflow del td no le llega, se cortaba al ras
  // y sin puntos suspensivos — el borde redondeado partido por la mitad.
  assert.match(PANEL, /#sg-ocrec-wrap \.pa-tbl td \.bdg,#sg-ocrec-wrap \.pa-tbl td>b\{/);
  assert.match(PANEL, /#sg-ocrec-wrap \.pa-tbl td \.bdg[\s\S]{0,140}text-overflow:ellipsis/);
});

test('la partida NO esconde dígitos: parte en dos renglones', () => {
  // Son 18 caracteres fijos y el último par es el número de partida del día:
  // recortarlo deja dos partidas que se leen iguales en la misma pantalla.
  assert.match(PANEL, /#sg-ocrec-wrap \.pa-tbl td\.ocr-part\{white-space:normal;word-break:break-word\}/);
  assert.match(PANEL, /<td class="ocr-part"/);
});

test('el detalle del porcentaje también trunca: el td no se lo hereda al hijo', () => {
  assert.match(PANEL, /#sg-ocrec-wrap \.ocr-det\{white-space:nowrap;overflow:hidden;text-overflow:ellipsis\}/);
  assert.match(PANEL, /class="ocr-det"/);
});

test('la celda de los botones no se recorta', () => {
  // Un botón cortado por la mitad no se aprieta.
  assert.match(PANEL, /#sg-ocrec-wrap \.pa-tbl td\.ocr-acc\{overflow:visible\}/);
  assert.match(PANEL, /<td class="ocr-acc"/);
});

test('TODA celda que pueda recortarse lleva el texto completo en el title', () => {
  // Con ancho fijo, una fecha recortada («2026-08-2…») parece una fecha entera:
  // es la peor forma de truncar, porque no se nota.
  const i = PANEL.indexOf('var rec = sgOcRecepcion(o);');
  const b = PANEL.slice(i, i + 2200);
  assert.match(b, /<td title="' \+ esc\(o\.proveedor_nombre \|\| ''\) \+ '">/);
  assert.match(b, /<td class="ocr-part" title="' \+ esc\(sgOcId\(o\)\) \+ '"><code>/);
  assert.match(b, /<td title="' \+ esc\(o\.fecha_oc \|\| ''\) \+ '">/);
  assert.match(b, /<td title="' \+ esc\(o\.remitos_proveedor \|\| ''\) \+ '">/);
  assert.match(b, /title="' \+ \(Number\(o\.importe\) > 0 \? esc\(sgMoney\(o\.importe\)\) : ''\)/);
  assert.match(b, /title="' \+ esc\(sit\[1\]\)/);
});

// ── LO QUE NO SE TOCÓ ──────────────────────────────────────────────────────
test('sgOcCantidad sigue viva: la usa el otro listado', () => {
  // Es la columna "Bultos" de Emisión de órdenes. Cambiarla acá le rompía la
  // pantalla a la otra solapa.
  assert.match(PANEL, /function sgOcCantidad\(o\)\{/);
  assert.equal((PANEL.match(/sgOcCantidad\(o\)/g) || []).length, 2);
});

test('sgAvanceBarra tampoco se tocó: la usan las liquidaciones', () => {
  assert.match(PANEL, /function sgAvanceBarra\(vendidos, ingresados, merma\)\{/);
  // Y allá ≥100 sigue siendo verde, que es lo correcto para lo vendido.
  assert.match(PANEL, /var col = pct >= 100 \? '#16a34a'/);
});

// ══ LO QUE ENCONTRÓ LA REVISIÓN ════════════════════════════════════════════

test('el porcentaje sale del número CRUDO, no del redondeado', () => {
  // 59,45 bultos sobre 60 es 99,1%. Redondear antes de dividir daba 98,3% y
  // pintaba de amarillo una orden que entró completa.
  const r = F.rec(porBulto({ bultos_estimados: 60, bultos_equivalentes: 59.45,
    bultos_recibidos_total: 59, lotes_sin_contar: 1 }));
  assert.equal(r.pct, 99.1);
  // (99,1 cae en amarillo: el verde arranca en 99,5. Lo que importa acá es que
  // el número sea 99,1 y no el 98,3 que daba redondeando primero.)
  assert.ok(!/98\.3/.test(F.barra(r)));
});

test('un resto pesado chico NO apaga la señal de «faltan contar»', () => {
  // Éste es el bug que casi se va a producción: la señal se deducía restando
  // totales —«equivalentes menos contados»— y los equivalentes son
  // fraccionarios. Con 59 cajones contados y 9 kg sueltos, Math.round(59,45)
  // daba 59 y la resta daba cero: la pantalla decía «faltan contar» en una
  // orden que estaba perfecta. Ahora lo cuenta el servidor.
  const r = F.rec(porBulto({ bultos_estimados: 60, bultos_equivalentes: 59.45,
    bultos_recibidos_total: 59, lotes_sin_contar: 1, lotes_sin_factor: 0 }));
  assert.equal(r.confiable, true);
  assert.equal(r.nota, 'parte por peso');
});

test('y la señal la contesta el servidor, no una resta de totales', () => {
  assert.match(SG, /AS lotes_sin_factor/);
  // El MISMO COALESCE que usa bultos_equivalentes, o las dos preguntas pueden
  // contestar distinto sobre el mismo lote.
  assert.match(SG, /AND COALESCE\(i\.kg_por_bulto, ps\.factor_conversion, 0\) <= 0\) AS lotes_sin_factor/);
  const i = PANEL.indexOf('function sgOcRecepcion(o){');
  const b = PANEL.slice(i, i + 3600);
  assert.match(b, /\(Number\(o\.lotes_sin_factor\) \|\| 0\) > 0/);
  // Y ya no queda la resta vieja.
  assert.ok(!/r\.recibido <= contados \+ 0\.01/.test(b));
});

test('UNA sola regla de unidad: la misma orden no se cuenta de dos maneras', () => {
  // sgOcCantidad (Emisión de órdenes) preguntaba «¿algún renglón es por cajón?»
  // y esta pantalla «¿todos?». Una orden vieja, de cuando modo_carga no existía,
  // salía en kilos en una solapa y en cajones en la otra — la misma orden.
  assert.match(SG, /o\.pactada_por_bulto = \(itTot > 0 && Number\(o\.items_pactados_bulto\) === itTot\) \? 1 : 0;/);
  assert.match(PANEL, /var porBultos = Number\(o\.pactada_por_bulto\) === 1;/);
  // Las DOS funciones la leen del mismo lado.
  assert.equal((PANEL.match(/Number\(o\.pactada_por_bulto\) === 1/g) || []).length, 2);
  // Y ninguna vuelve a preguntar por su cuenta.
  assert.ok(!/var porBultos = Number\(o\.items_por_bulto\) > 0;/.test(PANEL));
});

test('los KILOS no se perdieron: van debajo del número de cajones', () => {
  // La columna vieja los mostraba como sub-línea. El remito del proveedor viene
  // en kilos: sacarlos para agregar el porcentaje habría sido cambiar un dato
  // por otro.
  const r = F.rec(porBulto());
  assert.equal(r.kgPedido, 810);
  assert.equal(r.kgRecibido, 810);
  const i = PANEL.indexOf('function sgOcRecepKg(kg, r){');
  assert.ok(i > 0, 'no existe sgOcRecepKg');
  assert.match(PANEL, /sgOcRecepNum\(rec\.pedido, rec\)\s*\n?\s*\+ sgOcRecepKg\(rec\.kgPedido, rec\)/);
  assert.match(PANEL, /sgOcRecepKg\(rec\.kgRecibido, rec\)/);
});

test('pero NO se repiten los kilos cuando la fila ya habla en kilos', () => {
  // En una orden por kilo el número principal YA son los kilos: repetirlos
  // abajo es la misma cifra dos veces.
  const src = PANEL.slice(PANEL.indexOf('function sgOcRecepKg(kg, r){'), PANEL.indexOf('function sgOcRecepKg(kg, r){') + 300);
  assert.match(src, /r\.modo !== 'bulto'/);
  const porKilo = F.rec(porBulto({ pactada_por_bulto: 0, items_pactados_bulto: 0 }));
  assert.equal(porKilo.modo, 'kilo');
});

test('«Entradas» dejó de ser columna y pasó a colgar de lo recibido', () => {
  // Decía "1" en el 99% de las filas y se llevaba el ancho que necesitaban los
  // dos números que Pablo pidió. Y es información SOBRE lo recibido: entró en
  // dos veces.
  const i = PANEL.indexOf('var rec = sgOcRecepcion(o);');
  const b = PANEL.slice(i - 700, i + 2200);
  assert.match(b, /var entradas = n > 1 \? 'en ' \+ n \+ ' entregas' : '';/);
  assert.match(b, /entradas \? '<div class="sg-oc-sub ocr-det">' \+ entradas/);
  // Y ya no está en el encabezado.
  const th = PANEL.slice(PANEL.indexOf('<thead><tr><th style="width:11%">Partida</th>'),
                         PANEL.indexOf('<tbody id="sg-tb-ocrecibidas"'));
  assert.ok(!/Entradas/.test(th), 'quedó la columna vieja en el encabezado');
});

test('el encabezado y la fila tienen la MISMA cantidad de celdas', () => {
  // Con table-layout:fixed, una celda de más corre todos los anchos.
  const th = PANEL.slice(PANEL.indexOf('<thead><tr><th style="width:11%">Partida</th>'),
                         PANEL.indexOf('</tr></thead>', PANEL.indexOf('<thead><tr><th style="width:11%">Partida</th>')));
  const i = PANEL.indexOf('var rec = sgOcRecepcion(o);');
  const fila = PANEL.slice(i, PANEL.indexOf("+ '</td></tr>';", i));
  assert.equal((th.match(/<th[ >]/g) || []).length, 10);
  assert.equal((fila.match(/\+ '<td[ >]/g) || []).length, 10);
});

test('el filtro de costos no borra las cantidades', () => {
  // filtrarCosto vacía campos de las respuestas GET a quien no puede ver costos.
  // Si alguno de estos entrara en esa lista, el que recibe la mercadería vería
  // las tres columnas nuevas en blanco y no habría forma de darse cuenta: el
  // front no distingue "sin dato" de "borrado".
  //
  // Y no deben entrar: cuántos cajones entraron NO es el precio de nada.
  const COSTO = fs.readFileSync(path.join(RAIZ, 'src/servicios/sg_costo_visible.js'), 'utf8');
  const lista = COSTO.slice(COSTO.indexOf('CAMPOS_COSTO'), COSTO.indexOf('])', COSTO.indexOf('CAMPOS_COSTO')));
  for (const campo of ['bultos_estimados', 'bultos_equivalentes', 'bultos_recibidos_total',
    'total_estimado_kg', 'kg_recibidos_total', 'items_total', 'items_pactados_bulto',
    'pactada_por_bulto', 'lotes_sin_contar', 'lotes_sin_factor']) {
    assert.ok(!new RegExp("'" + campo + "'").test(lista), campo + ' quedó tapado por el filtro de costos');
  }
});
