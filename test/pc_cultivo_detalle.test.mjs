// ══ DE QUÉ ESTÁ HECHO EL COSTO DE UN CULTIVO ═══════════════════════════════
//
// Pablo, 28/8/2026: «haciendo click en cada uno de los tarjetones de productos
// deberíamos poder tener un detalle de cómo se compone ese costo; que se abra
// una pantalla con el detalle de todas las órdenes».
//
// El tarjetón decía «Brócoli · $24.696.169 · 52 órdenes» y ahí se terminaba:
// para saber de dónde salía ese número había que filtrar por cultivo y sumar a
// mano.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const PROD = fs.readFileSync(path.join(RAIZ, 'src/rutas/produccion.js'), 'utf8');

const cuerpo = (nombre, largo = 9000) => {
  const i = PANEL.indexOf(nombre);
  assert.ok(i > 0, 'no existe ' + nombre);
  return PANEL.slice(i, i + largo);
};

// ── SE ABRE ────────────────────────────────────────────────────────────────

test('el tarjetón se puede apretar y dice que se puede', () => {
  // Una tarjeta clickeable que no se ve clickeable no la aprieta nadie.
  const b = cuerpo('cont.innerHTML=cultivos.map(function(c){', 900);
  assert.match(b, /cursor:pointer/);
  assert.match(b, /onclick="paCultivoDetalle\('\+paQ\(c\)\+'\)"/);
  assert.match(b, /· ver detalle/);
  assert.match(b, /title="Ver de qué está hecho este costo"/);
});

test('el nombre del cultivo se escapa antes de entrar al onclick', () => {
  // Un apóstrofo en un nombre nuevo rompería el atributo y el botón dejaría de
  // andar sin que nadie lo note.
  const i = PANEL.indexOf('function paQ(t){');
  assert.ok(i > 0, 'no existe paQ');
  const src = PANEL.slice(i, PANEL.indexOf('\n', i));
  // eslint-disable-next-line no-new-func
  const paQ = new Function(src + '; return paQ;')();
  assert.equal(paQ('Brócoli'), "'Brócoli'");
  assert.equal(paQ("Uva d'Oro"), "'Uva d\\'Oro'");
  assert.equal(paQ(null), "''");
  assert.equal(paQ('a\\b'), "'a\\\\b'");
});

test('el modal existe y se cierra', () => {
  assert.match(PANEL, /<div class="ab-modal-overlay" id="pa-mb-cul-detalle">/);
  assert.match(PANEL, /id="pa-cul-tit"/);
  assert.match(PANEL, /id="pa-cul-body"/);
  assert.match(PANEL, /getElementById\('pa-mb-cul-detalle'\)\.classList\.remove\('on'\)/);
  assert.match(PANEL, /getElementById\('pa-mb-cul-detalle'\)\.classList\.add\('on'\)/);
});

// ── LO QUE MUESTRA ─────────────────────────────────────────────────────────

test('muestra las órdenes, que es lo que se pidió', () => {
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /Las '\+rows\.length\+' '\+\(rows\.length===1\?'orden':'órdenes'\)/);
  for (const c of ['N° Orden', 'Fecha', 'Tipo', 'Lotes', 'Productos', 'Costo', 'Estado']) {
    assert.ok(b.includes('>' + c + '<'), 'falta la columna ' + c);
  }
  // Y cada fila abre la orden: es lo primero que uno quiere después de verla.
  assert.match(b, /onclick="paVerOrden\('\+o\.id\+'\)"/);
});

test('y ANTES, de qué está hecho: por producto', () => {
  // «Cómo se compone ese costo» es literalmente la primera mitad del pedido, y
  // el costo de una orden es la suma de lo que se aplicó.
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /De qué está hecho/);
  // De las aplicaciones QUE SALIERON A LOS LOTES DE ESTE CULTIVO, no de todas
  // las de la orden.
  assert.match(b, /\(partes\[String\(o\.id\)\]\.apl\|\|\[\]\)\.forEach/);
  assert.match(b, />Usado</);
  assert.match(b, />%</);
  // El servidor manda el costo por producto, que es de donde sale.
  assert.match(PROD, /COALESCE\(SUM\(a\.costo_total\),0\) AS costo/);
  assert.match(PROD, /unidad: a\.unidad, usado: a\.usado, costo: a\.costo,/);
});

test('los productos se ordenan por plata, de mayor a menor', () => {
  // El que abre esto quiere saber qué le está costando caro, y eso está arriba.
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /ordenIns\.sort\(function\(a,b\)\{ return porIns\[b\]\.costo-porIns\[a\]\.costo; \}\)/);
});

test('las órdenes se ordenan por fecha, de la más nueva a la más vieja', () => {
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /String\(b\.fecha_orden\|\|''\)\.localeCompare\(String\(a\.fecha_orden\|\|''\)\)/);
});

// ── EL NÚMERO TIENE QUE CERRAR ─────────────────────────────────────────────

test('el total del detalle es el mismo que el del tarjetón', () => {
  // Es la misma cuenta y sale de la misma función: si el detalle diera otro
  // número, el tarjetón dejaría de ser confiable.
  const card = cuerpo('function paOrdRenderCards(rows){', 1400);
  assert.match(card, /mapa\[c\]\.costo\+=\(p\?p\.costo:0\);/);
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /total\+=p\.costo;/);
  assert.match(b, />TOTAL</);
});

test('y el filtro del cultivo es EL MISMO que el del tarjetón', () => {
  // Los dos preguntan por la misma función. Si uno mirara o.cultivo y el otro
  // o.cultivos, el detalle mostraría otras órdenes que las que se contaron.
  const card = cuerpo('function paOrdRenderCards(rows){', 1400);
  assert.match(card, /var p=paCultivoParte\(o,c\);/);
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /var p=paCultivoParte\(o,cultivo\);/);
  assert.match(b, /if\(!p\) return;/);
  // Y la función es la única que decide de qué cultivo es una orden.
  const f = cuerpo('function paCultivoParte(o, cultivo){', 1400);
  assert.match(f, /var cs=o\.cultivo\?\[o\.cultivo\]:\(o\.cultivos\|\|\[\]\);/);
  assert.match(f, /if\(cs\.indexOf\(cultivo\)<0\) return null;/);
});

test('lo que de verdad puede no cerrar se avisa', () => {
  // Un detalle que no cuadra y se calla es peor que no tenerlo. Lo que no cierra
  // es la orden repartida entre dos cultivos: acá figura con su parte, así que
  // su número no coincide con el de la orden abierta.
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /if\(compartidas>0\)\{/);
  assert.match(b, /de más de un cultivo/);
  assert.match(b, /el costo de esas órdenes es menor al que muestran abiertas/);
});

test('la aritmética del reparto, corriéndola', () => {
  // Es lo que arma la tabla por producto: juntar las aplicaciones de todas las
  // órdenes del cultivo, sumando cantidad y plata por insumo.
  const juntar = (rows) => {
    const porIns = {}, orden = [];
    for (const o of rows) {
      for (const a of (o.aplicado || [])) {
        const k = String(a.insumo_id);
        if (!porIns[k]) { porIns[k] = { nombre: a.insumo_nombre, unidad: a.unidad, usado: 0, costo: 0, ord: {} }; orden.push(k); }
        porIns[k].usado += Number(a.usado) || 0;
        porIns[k].costo += Number(a.costo) || 0;
        porIns[k].ord[String(o.id)] = 1;
      }
    }
    orden.sort((x, y) => porIns[y].costo - porIns[x].costo);
    return orden.map((k) => porIns[k]);
  };
  const filas = juntar([
    { id: 1, aplicado: [{ insumo_id: 5, insumo_nombre: 'Hydro', unidad: 'kg', usado: 25, costo: 100000 },
                        { insumo_id: 7, insumo_nombre: 'Poliet', unidad: 'lt', usado: 3, costo: 900000 }] },
    { id: 2, aplicado: [{ insumo_id: 5, insumo_nombre: 'Hydro', unidad: 'kg', usado: 50, costo: 200000 }] },
    // La misma orden aplicada en dos lotes trae dos filas del mismo producto:
    // son DOS renglones pero UNA sola orden.
    { id: 3, aplicado: [{ insumo_id: 7, insumo_nombre: 'Poliet', unidad: 'lt', usado: 1, costo: 50000 },
                        { insumo_id: 7, insumo_nombre: 'Poliet', unidad: 'lt', usado: 2, costo: 100000 }] },
    { id: 4, aplicado: [] },
  ]);
  assert.equal(filas.length, 2);
  // El más caro arriba.
  assert.equal(filas[0].nombre, 'Poliet');
  assert.equal(filas[0].costo, 1050000);
  assert.equal(Object.keys(filas[0].ord).length, 2, 'contó renglones en vez de órdenes');
  // Y el que apareció en dos órdenes suma las dos.
  assert.equal(filas[1].usado, 75);
  assert.equal(filas[1].costo, 300000);
  assert.equal(Object.keys(filas[1].ord).length, 2);
});

// ── LOS BORDES ─────────────────────────────────────────────────────────────

test('respeta los filtros de la pantalla, y lo dice', () => {
  // Trabaja sobre las órdenes que ya están en pantalla: si el tarjetón dice 52,
  // el detalle muestra esas 52. Decirlo evita la pregunta «¿y las otras?».
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /\(PA\._ordenesFiltradas\|\|\[\]\)\.forEach/);
  assert.match(b, /con los filtros que tenés puestos/);
});

test('un cultivo sin órdenes ejecutadas explica el cero', () => {
  // Costo cero porque no se aplicó nada todavía, no porque falte cargarlo. Sin
  // esta línea, un tarjetón en $0 parece un dato faltante.
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /Ninguna de estas órdenes se ejecutó todavía/);
  assert.match(b, /no porque falte cargarlo/);
});

test('y si no hay ni una orden con esos filtros, se dice', () => {
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /Ninguna orden de este cultivo con esos filtros/);
});

test('NINGUNA BARRA DE DESPLAZAMIENTO LATERAL', () => {
  assert.match(PANEL, /#pa-mb-cul-detalle \.ab-table-wrap\{overflow-x:hidden !important\}/);
  assert.match(PANEL, /#pa-mb-cul-detalle table\.pa-tbl\{width:100%;table-layout:fixed\}/);
  assert.match(PANEL, /#pa-mb-cul-detalle table\.pa-tbl td\{[\s\S]{0,140}text-overflow:ellipsis\}/);
  assert.match(PANEL, /@media\(max-width:900px\)\{ #pa-mb-cul-detalle \.ab-table-wrap\{overflow-x:auto !important\}/);
  // El encabezado aparte, para que no se corte y deje la columna sin nombre.
  assert.match(PANEL, /#pa-mb-cul-detalle table\.pa-tbl th\{[\s\S]{0,120}white-space:normal/);
});

test('los anchos de las dos tablas suman 100', () => {
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  const th1 = b.slice(b.indexOf('<th style="width:38%">Producto'), b.indexOf('</thead>'));
  const s1 = (th1.match(/width:(\d+)%/g) || []).reduce((a, w) => a + Number(w.match(/\d+/)[0]), 0);
  assert.equal(s1, 100, 'la tabla por producto no suma 100');
  const i2 = b.indexOf('<th style="width:13%">N° Orden');
  const th2 = b.slice(i2, b.indexOf('</thead>', i2));
  const s2 = (th2.match(/width:(\d+)%/g) || []).reduce((a, w) => a + Number(w.match(/\d+/)[0]), 0);
  assert.equal(s2, 100, 'la tabla de órdenes no suma 100');
});

test('lo que se trunca lleva el texto completo en el title', () => {
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /<td title="'\+esc\(lts\)\+'"/);
  assert.match(b, /<td title="'\+esc\(prs\)\+'"/);
  assert.match(b, /<td title="'\+esc\(e\.nombre\)\+'"/);
});

test('las cantidades usan el formateador que NO redondea a entero', () => {
  // Mismo problema que el Excel: un producto a 0,4 lt no puede decir «0 lt».
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /paOrdCant\(e\.usado,e\.unidad\)/);
  const f = PANEL.indexOf('function paOrdCant(n, unidad){');
  assert.ok(!/\bnr\(/.test(PANEL.slice(f, f + 400)));
});

// ══ LO QUE ENCONTRÓ LA REVISIÓN ════════════════════════════════════════════

// La función REAL que reparte, importada del panel sin inyectarle nada.
function cargarReparto() {
  const i = PANEL.indexOf('function paCultivoParte(o, cultivo){');
  assert.ok(i > 0, 'no existe paCultivoParte');
  const src = PANEL.slice(i, PANEL.indexOf('\n}', i) + 2);
  // eslint-disable-next-line no-new-func
  return new Function(src + '; return paCultivoParte;')();
}
const parte = cargarReparto();

test('LA ORDEN DE DOS CULTIVOS NO SE CUENTA ENTERA EN LOS DOS', () => {
  // Una orden vieja no tiene cultivo propio: se le deduce de los lotes, y puede
  // tocar lotes de dos cultivos. Sumarle a cada uno el costo entero contaba la
  // misma plata dos veces, y —peor— los KILOS: entre las dos pantallas
  // aparecían más litros de un producto de los que salieron del depósito.
  //
  // El reparto es EXACTO: cada aplicación dice a qué lote salió.
  const o = {
    id: 1, cultivo: null, cultivos: ['Brócoli', 'Cebolla'], costo_total: 500000,
    lotes: [{ lote_id: 10, cultivo: 'Brócoli' }, { lote_id: 11, cultivo: 'Cebolla' }],
    aplicado: [
      { insumo_id: 5, insumo_nombre: 'Hydro', unidad: 'kg', lote_id: 10, usado: 200, costo: 200000 },
      { insumo_id: 5, insumo_nombre: 'Hydro', unidad: 'kg', lote_id: 11, usado: 300, costo: 300000 },
    ],
  };
  const br = parte(o, 'Brócoli');
  const ce = parte(o, 'Cebolla');
  assert.equal(br.costo, 200000);
  assert.equal(ce.costo, 300000);
  // Los kilos tampoco se duplican: 200 + 300 = los 500 que salieron.
  assert.equal(br.apl.reduce((a, x) => a + x.usado, 0), 200);
  assert.equal(ce.apl.reduce((a, x) => a + x.usado, 0), 300);
  // Y los dos tarjetones juntos dan lo que se gastó, no el doble.
  assert.equal(br.costo + ce.costo, 500000);
  assert.equal(br.compartida, true);
  assert.deepEqual(br.con, ['Cebolla']);
});

test('la orden de un solo cultivo no se reparte: va entera', () => {
  // Y con su costo_total, que puede tener plata que no viene de una aplicación.
  const o = { id: 2, cultivo: 'Melón', costo_total: 80000, lotes: [{ lote_id: 3, cultivo: 'Melón' }],
    aplicado: [{ insumo_id: 9, lote_id: 3, usado: 10, costo: 70000 }] };
  const p = parte(o, 'Melón');
  assert.equal(p.costo, 80000);
  assert.equal(p.compartida, false);
  assert.equal(p.apl.length, 1);
});

test('una orden que no es de ese cultivo devuelve null', () => {
  const o = { id: 3, cultivo: 'Cebolla', costo_total: 10, lotes: [], aplicado: [] };
  assert.equal(parte(o, 'Brócoli'), null);
});

test('el lote sin cultivo cargado no se le adjudica a ninguno', () => {
  // Inventarle un cultivo sería peor que dejarlo afuera: el número quedaría mal
  // y nadie sabría por qué.
  const o = {
    id: 4, cultivo: null, cultivos: ['Brócoli', 'Cebolla'], costo_total: 300,
    lotes: [{ lote_id: 10, cultivo: 'Brócoli' }, { lote_id: 12, cultivo: null }],
    aplicado: [{ insumo_id: 5, lote_id: 10, usado: 1, costo: 100 },
               { insumo_id: 5, lote_id: 12, usado: 2, costo: 200 }],
  };
  assert.equal(parte(o, 'Brócoli').costo, 100);
});

test('y el tarjetón usa EL MISMO reparto que el detalle', () => {
  // Si uno repartiera y el otro no, el detalle dejaría de dar el número del
  // tarjetón y el aviso saltaría en todas las órdenes viejas.
  const card = cuerpo('function paOrdRenderCards(rows){', 1400);
  assert.match(card, /var p=paCultivoParte\(o,c\);/);
  assert.match(card, /mapa\[c\]\.costo\+=\(p\?p\.costo:0\);/);
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /var p=paCultivoParte\(o,cultivo\);/);
  assert.match(b, /total\+=p\.costo;/);
});

test('la orden repartida se marca en la lista', () => {
  // Su número no va a coincidir con el de la orden abierta, y sin decirlo eso
  // parece un error del sistema.
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /p\.compartida/);
  assert.match(b, />parte<\/span>/);
  assert.match(b, /Esta orden también tocó lotes de: /);
  assert.match(b, /órdenes tocaron lotes'\)\+' de más de un cultivo/);
});

test('y se sacó el aviso que no podía dispararse nunca', () => {
  // Comparaba la suma por producto contra el total de las órdenes: son las
  // mismas filas de la misma tabla sumadas dos veces, así que daba cero siempre
  // y se leía como «está todo bien» sin haber mirado nada.
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.ok(!/var dif=Math\.round\(\(total-sumaIns\)/.test(b), 'volvió el aviso muerto');
  assert.ok(!/Suele ser una aplicación cargada sin producto/.test(PANEL));
  assert.match(b, /son las MISMAS filas de\s*\n?\s*\/\/ la misma tabla sumadas dos veces/);
});

test('un producto usado sin precio de compra lo dice, no muestra $0', () => {
  // El costo sale del precio de la última compra: si el insumo nunca se compró
  // queda en cero, y «$0 · 0%» se lee como que salió gratis.
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /var sinPrecio = e\.usado>0 && !\(e\.costo>0\);/);
  assert.match(b, />sin precio de compra</);
  assert.match(b, /El costo sale del precio de la última compra del insumo/);
});

test('la columna Órdenes cuenta ÓRDENES, no renglones', () => {
  // Una orden aplicada en tres lotes trae tres filas del mismo producto: contar
  // filas diría «3 órdenes» donde hay una.
  const b = cuerpo('function paCultivoDetalle(cultivo){');
  assert.match(b, /porIns\[k\]\.ord\[String\(o\.id\)\]=1;/);
  assert.match(b, /var nOrd = Object\.keys\(e\.ord\)\.length;/);
});

test('el servidor manda el lote de cada aplicación', () => {
  // Sin el lote no hay reparto exacto posible: habría que prorratear a ojo.
  assert.match(PROD, /GROUP BY a\.orden_id, a\.lote_id, a\.insumo_id/);
  assert.match(PROD, /lote_id: a\.lote_id,/);
  assert.match(PROD, /lote_id es NOT NULL en pa_aplicaciones, así que el reparto/);
});

// ── LO QUE HABRÍA ROTO LA PANTALLA ─────────────────────────────────────────

test('el id del modal no choca con el que ya existía', () => {
  // «pa-mb-cultivo» ya era el modal de Editar lote: con dos elementos con el
  // mismo id, getElementById devuelve el primero y se rompen los dos.
  assert.equal((PANEL.match(/id="pa-mb-cul-detalle"/g) || []).length, 1);
  // El otro sigue existiendo y sigue siendo suyo: es el modal de Editar lote.
  assert.equal((PANEL.match(/id="pa-mb-cultivo"/g) || []).length, 1);
  const i = PANEL.indexOf('id="pa-mb-cultivo"');
  assert.match(PANEL.slice(i, i + 400), /Editar lote|pa-cl-/);
});

test('el pie del modal usa una clase que existe', () => {
  const i = PANEL.indexOf('id="pa-cul-body"');
  const b = PANEL.slice(i, i + 400);
  assert.match(b, /<div class="ab-modal-footer">/);
  assert.ok(!/class="mft"/.test(b));
});

test('el detalle se repinta si se ejecuta una orden desde adentro', () => {
  // Desde el detalle se abre la orden y se puede ejecutar: al volver, el detalle
  // mostraría los números viejos sin ninguna señal de estar desactualizado.
  const b = cuerpo('function paOrdAplicarFiltros(){', 1400);
  assert.match(b, /mb\.classList\.contains\('on'\) && PA\._culAbierto\) paCultivoDetalle\(PA\._culAbierto\)/);
  assert.match(PANEL, /PA\._culAbierto=cultivo;/);
});
