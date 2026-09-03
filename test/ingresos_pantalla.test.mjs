// ══ INGRESOS: EL CAMPO QUE DEJABA ESCRIBIR UNA LETRA, Y LAS CABECERAS ══════
//
// Pablo, 2/9/2026: «ya dentro de Ingresos, en la última —la de calidad— me permite
// escribir un solo carácter; así que revisá los campos de esa pantalla para que nos
// deje escribir algo más».
//
// LA CAUSA. El paso 6 del asistente de recepción se volvía a dibujar ENTERO con
// cada tecla: el `oninput` llamaba a sgRecCalUpd, que guardaba la letra y llamaba a
// sgRecRenderCalidad, que hace `innerHTML=` sobre el cuadro que contiene a ese
// mismo input. El input se destruye, el foco se pierde, y la segunda letra va a
// ningún lado. Eran CUATRO campos, no uno: estado general, % afectado, defectos
// detectados y observaciones.
//
// Es el defecto más difícil de ver leyendo el código —la función hace exactamente
// lo que dice— y el más obvio usando la pantalla. Por eso el test no lee el
// código: EJECUTA sgRecCalUpd tecla por tecla y cuenta los redibujados.
//
// Y en el mismo viaje: Órdenes de Compra era la única pantalla de San Gerónimo sin
// encabezado —se entraba desde el menú y nada decía dónde estabas parado— e
// Ingresos no tenía su «¿Cómo se usa?».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SIDEBAR = fs.readFileSync(path.join(RAIZ, 'src/sidebar-v2.js'), 'utf8');

// ── 1 · SE PUEDE ESCRIBIR, CORRIDO DE VERDAD ───────────────────────────────

// Monta sgRecCalUpd con el resto del mundo simulado, y cuenta cuántas veces se
// redibuja el cuadro. Redibujarlo es exactamente lo que borraba el input.
function calidad() {
  const i = PANEL.indexOf('function sgRecCalUpd(i, campo, v){');
  assert.ok(i > 0, 'no existe sgRecCalUpd');
  const j = PANEL.indexOf('\r\n}', i);
  assert.ok(j > i);
  const cuenta = { render: 0, validar: 0 };
  const SG = { recItems: [{ producto_nombre: 'Tomate Redondo' }] };
  const src = [
    'function sgRecRenderCalidad(){ cuenta.render++; }',
    'function sgRecValidar(){ cuenta.validar++; }',
    PANEL.slice(i, j + 3),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const F = new Function('SG', 'cuenta', src + '\nreturn sgRecCalUpd;')(SG, cuenta);
  return { sgRecCalUpd: F, SG, cuenta };
}

test('escribir «pudrición» deja escrita «pudrición», no la «p»', () => {
  const { sgRecCalUpd, SG, cuenta } = calidad();
  const palabra = 'pudrición';
  for (let n = 1; n <= palabra.length; n++) sgRecCalUpd(0, 'defectos', palabra.slice(0, n));
  assert.equal(SG.recItems[0].calidad.defectos, 'pudrición');
  assert.equal(cuenta.render, 0,
    'el cuadro se redibujó mientras se escribía: eso borra el input y sólo entra una letra');
  // Y sigue avisando qué falta para poder confirmar, que es lo otro que hacía.
  assert.equal(cuenta.validar, palabra.length);
});

test('los cuatro campos del paso 6, no sólo el que se reportó', () => {
  const { sgRecCalUpd, SG, cuenta } = calidad();
  for (const campo of ['estado_general', 'pct_afectado', 'defectos', 'observaciones']) {
    for (const v of ['a', 'ab', 'abc']) sgRecCalUpd(0, campo, v);
    assert.equal(SG.recItems[0].calidad[campo], 'abc', 'se perdió lo tipeado en ' + campo);
  }
  assert.equal(cuenta.render, 0, 'alguno de los cuatro sigue redibujando el cuadro');
});

test('pero el tilde de «entró con problemas» SÍ redibuja: abre y cierra los campos', () => {
  const { sgRecCalUpd, SG, cuenta } = calidad();
  sgRecCalUpd(0, 'observada', true);
  assert.equal(SG.recItems[0].calidad.observada, true);
  assert.equal(cuenta.render, 1, 'sin redibujar, los campos de abajo no aparecen nunca');
  sgRecCalUpd(0, 'observada', false);
  assert.equal(cuenta.render, 2, 'destildar tiene que volver a cerrar el cuadro');
});

test('y una fila que no existe no rompe nada', () => {
  const { sgRecCalUpd, cuenta } = calidad();
  sgRecCalUpd(9, 'defectos', 'x');
  assert.equal(cuenta.validar, 0);
});

// ── 2 · Y NINGÚN OTRO CAMPO DE LA PANTALLA TIENE EL MISMO DEFECTO ──────────

test('los campos de bultos y de peso tampoco redibujan su propio cuadro', () => {
  // Paso 2 y paso 4. Comparten sgRecArtUpd: si esa función llamara al render de
  // su contenedor, el defecto sería el mismo y en pantallas que se usan más.
  const i = PANEL.indexOf('function sgRecArtUpd(i, campo, v){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, PANEL.indexOf('\r\n}', i));
  for (const render of ['sgRecRenderPesos', 'sgRecRenderArts', 'sgRecRenderCalidad']) {
    assert.ok(!b.includes(render + '('),
      'sgRecArtUpd redibuja con ' + render + ': se pierde el foco al segundo carácter');
  }
});

test('el único oninput del asistente en el HTML es el que sólo valida', () => {
  // El resto de los campos fijos del asistente no tienen oninput: se leen por id
  // al guardar. El que lo tiene llama a sgRecValidar, que sólo pinta el cartel de
  // «qué falta» — no toca el formulario.
  const i = PANEL.indexOf('id="sg-rec-modal"');
  const j = PANEL.indexOf('id="sg-coop-modal"', i);
  assert.ok(i > 0 && j > i);
  const wizard = PANEL.slice(i, j);
  const handlers = [...wizard.matchAll(/oninput="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(handlers)], ['sgRecValidar()']);
});

// ── 3 · ÓRDENES DE COMPRA TIENE ENCABEZADO ─────────────────────────────────

test('Órdenes de Compra dice dónde estás parado', () => {
  // Era la ÚNICA de las 21 pantallas de San Gerónimo que abría directo con las
  // solapas: entrando desde el menú, nada decía en qué pantalla estabas.
  const i = PANEL.indexOf('id="sec-sg-ordenes"');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 900);
  // Con el «San Gerónimo ·» que llevan las otras veinte: sin eso, la pantalla
  // parece de otro sistema.
  assert.match(b, /<div class="ph"><div><div class="ph-t">📋 San Gerónimo · Órdenes de Compra<\/div>/);
  assert.match(b, /<div class="ph-s">Lo que se le encargó a cada productor/);
  // Con su Actualizar, como el de Liquidaciones. Y que apunte a algo que existe:
  // un botón que llama a una función inexistente falla recién cuando se aprieta.
  const fn = (b.match(/<button class="btn bo" onclick="(\w+)\(/) || [])[1];
  assert.ok(fn, 'el encabezado no tiene botón de Actualizar');
  assert.ok(new RegExp('function\\s+' + fn + '\\s*\\(').test(PANEL),
    'el Actualizar llama a ' + fn + ', que no está definida');
});

test('y usa la misma cabecera que las otras veinte de San Gerónimo', () => {
  // .ph es la convención del panel (99 usos); .ab-section-header es la de Abasto.
  // Se ven igual —mismo tamaño, mismo borde abajo—, pero mezclarlas deja dos
  // familias de pantallas que envejecen distinto.
  const secciones = [...PANEL.matchAll(/<div class="sec sg-mod" id="(sec-sg-[\w-]+)"/g)]
    .map((m) => ({ id: m[1], i: m.index }));
  assert.ok(secciones.length >= 15);
  // La ventana tiene que aguantar el <style> propio que algunas traen antes del
  // encabezado: con 1.200 caracteres, Caja y Bancos e Importación daban falso.
  const sin = secciones.filter((s) => !PANEL.slice(s.i, s.i + 2400).includes('class="ph"'));
  assert.deepEqual(sin.map((s) => s.id), [],
    'estas pantallas de San Gerónimo no tienen encabezado');
});

// ── 4 · INGRESOS: SU ÍCONO Y SU MANUAL ─────────────────────────────────────

test('el tomate se fue de Ingresos: el ícono dice qué se hace ahí', () => {
  const i = PANEL.indexOf('id="sec-sg-compras"');
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /<div class="ph-t">📥 San Gerónimo · Ingresos<\/div>/);
  assert.ok(!b.includes('🍅 San Gerónimo · Ingresos'));
});

test('y tiene su «¿Cómo se usa?», en el mismo lugar que las otras dos', () => {
  // El botón va al lado de las solapas, como en Órdenes de Compra y en Stock.
  // El mismo botón en tres lugares distintos es el mismo botón que no se
  // encuentra: el que aprende en una pantalla no lo ubica en la siguiente.
  const i = PANEL.indexOf('id="sec-sg-compras"');
  assert.match(PANEL.slice(i, i + 12000),
    /onclick="sgManualAbrir\('ingresos'\)">❓ ¿Cómo se usa\?<\/button>/);
  // Y no en la cabecera, que queda con el título y nada más.
  assert.ok(!PANEL.slice(i, i + 400).includes('sgManualAbrir'), 'el botón volvió a la cabecera');
  // Y los tres se DIBUJAN igual: mismo botón, mismo tamaño, mismo texto. Dónde
  // se apoya cambia porque las dos familias de solapas del panel son distintas
  // —Stock usa botones, Ingresos y OC usan pastillas—, pero lo que el operador
  // reconoce es el botón, no el margen.
  const botones = [...PANEL.matchAll(/<button class="([^"]*)"[^>]*onclick="sgManualAbrir\('(\w+)'\)">([^<]*)</g)];
  assert.ok(botones.length >= 3, 'faltan botones de manual');
  assert.equal(new Set(botones.map((m) => m[1])).size, 1,
    'los botones de manual no usan todos la misma clase');
  assert.equal(new Set(botones.map((m) => m[3])).size, 1,
    'los botones de manual no dicen todos lo mismo');
});

// ── 5 · Y NINGÚN BOTÓN DE MANUAL APUNTA A UN MANUAL QUE NO EXISTE ──────────

test('cada «¿Cómo se usa?» tiene su manual escrito', () => {
  // sgManualAbrir contesta «todavía no hay manual de esta pantalla» y el operador
  // se queda igual. El chequeo de sintaxis no lo ve: es una clave, no un símbolo.
  const claves = [...new Set([...PANEL.matchAll(/sgManualAbrir\('(\w+)'\)/g)].map((m) => m[1]))];
  assert.ok(claves.length >= 3, 'no se encontraron los botones de manual');
  for (const c of claves) {
    assert.ok(PANEL.includes('SG_MANUAL.' + c + ' = {'),
      'hay un botón que abre el manual «' + c + '» y ese manual no existe');
  }
});

test('el manual de Ingresos explica los seis pasos, campo por campo', () => {
  const i = PANEL.indexOf('SG_MANUAL.ingresos = {');
  assert.ok(i > 0, 'Ingresos no tiene manual');
  const m = PANEL.slice(i, PANEL.indexOf('\r\n};', i));
  const plano = m.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
  for (const paso of ['Documentación', 'Artículos recibidos', 'Descarga',
    'Peso por bulto', 'Resumen', 'Control de calidad']) {
    assert.ok(plano.includes(paso), 'al manual de Ingresos le falta el paso: ' + paso);
  }
  // Los campos que más plata mueven, cada uno con su «con qué se enlaza».
  for (const campo of ['Orden de compra', 'Fecha de recepción', 'Peso de UN bulto',
    '¿En qué piso quedó?', 'Justificación de las diferencias']) {
    assert.ok(m.includes(campo), 'al manual le falta el campo: ' + campo);
  }
  const ligas = (m.match(/<span class="liga">/g) || []).length;
  assert.ok(ligas === 0, 'la liga la pone sgManCampo, no el texto');
  assert.ok((m.match(/sgManCampo\(/g) || []).length >= 10,
    'el manual describe menos de diez campos: no alcanza para una pantalla de seis pasos');
});

test('el manual no promete lo que el circuito no hace', () => {
  // Escribirlo campo por campo es la única forma de descubrir que el sistema
  // promete cosas que no cumple — que es la mitad del punto del manual. Cinco de
  // estas frases estaban escritas al revés de lo que pasa de verdad, y sólo se
  // vieron al ir a buscar en el código qué hacía cada campo.
  const i = PANEL.indexOf('SG_MANUAL.ingresos = {');
  const m = PANEL.slice(i, PANEL.indexOf('\r\n};', i));
  const plano = m.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');

  assert.ok(plano.includes('Una orden se recibe una sola vez'),
    'no avisa que la orden queda firme con lo que entró');
  // Los kilos SÍ se pueden corregir después, desde Stock.
  assert.ok(!plano.includes('las cantidades no se corrigen'),
    'volvió a prometer que las cantidades quedan clavadas');
  // NADIE marca la orden como «sin justificar»: hay_variaciones viaja siempre null.
  assert.ok(!plano.includes('sin justificar'),
    'volvió a prometer una marca que el circuito no pone');
  assert.ok(plano.includes('Nadie la exige'),
    'no dice que la justificación no la exige nadie');
  // El piso vacío NO entra sin ubicar si la orden proponía uno.
  assert.ok(plano.includes('había propuesto la orden'),
    'no dice que el piso cae al que proponía la orden');
  // Y manda a mirar el informe antes de confirmar, ahora que sale completo.
  assert.ok(plano.includes('Miralo antes de mandarlo'),
    'no manda a revisar el informe con la vista previa');
  // Vincular la orden de una recepción sin OC es de administrador.
  assert.ok(plano.includes('administrador'),
    'no dice quién puede vincular la orden de una recepción sin OC');
});

test('LA REGLA: lo que se tocó quedó anotado con su versión', () => {
  const i = PANEL.indexOf('SG_MANUAL.ingresos = {');
  const m = PANEL.slice(i, PANEL.indexOf('\r\n};', i));
  assert.match(m, /Qué cambió, y desde cuándo/);
  assert.match(m, /una<\/b> \n?.*sola letra|sola letra/s);
  const actual = Number((SIDEBAR.match(/const VERSION = 'V(\d+)'/) || [])[1]);
  const vs = (m.match(/<span class="ver">V(\d+)<\/span>/g) || [])
    .map((v) => Number(v.match(/V(\d+)/)[1]));
  assert.ok(vs.length >= 5, 'el manual no anota las versiones de sus campos');
  assert.ok(vs.includes(actual), 'el cambio de esta versión (V' + actual + ') no está anotado');
  for (const n of vs) {
    assert.ok(n <= actual, 'el manual cita la V' + n + ' y el panel va en la V' + actual);
  }
});


// ── 6 · EL MISMO DEFECTO EN OTRA PANTALLA ──────────────────────────────────
//
// Buscando por qué el campo de calidad dejaba escribir una letra apareció otro
// igual: el buscador de Solicitudes de Pago vive DENTRO del contenedor que la
// lista vuelve a dibujar. Ahí el debounce de 350 ms lo disimula —se alcanzan a
// escribir dos o tres letras antes de que se corte—, que es peor que el de
// calidad: parece que anda a veces.
//
// La fila de filtros tiene que seguir adentro de la lista (si desapareciera al
// no haber resultados, no habría forma de deshacer el filtro que dejó vacío),
// así que lo que se arregla es devolver el cursor a donde estaba.

// Un DOM de mentira, con lo justo: quién tiene el foco, y dónde está el cursor.
function domFalso() {
  const nodos = {};
  const fuera = {};   // lo que vive en otra parte de la pantalla y NO se redibuja
  const doc = {
    activeElement: null,
    getElementById(id) { return nodos[id] || fuera[id] || null; },
  };
  const cont = {
    _html: '',
    contains(n) { return !!n && n._dentro === cont; },
    set innerHTML(v) {
      this._html = v;
      // Redibujar DESTRUYE los nodos viejos y crea otros: es exactamente lo que
      // hace el navegador, y por eso se perdía lo que se estaba escribiendo.
      for (const k of Object.keys(nodos)) delete nodos[k];
      for (const m of String(v).matchAll(/id="([\w-]+)"/g)) {
        nodos[m[1]] = { id: m[1], _dentro: cont, value: '', selectionStart: 0, selectionEnd: 0,
          focus() { doc.activeElement = this; },
          setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } };
      }
    },
    get innerHTML() { return this._html; },
  };
  return { doc, cont, nodos, fuera };
}

function pintor() {
  const i = PANEL.indexOf('function spPintar(cont, html) {');
  assert.ok(i > 0, 'no existe spPintar');
  const j = PANEL.indexOf('\r\n}', i);
  // eslint-disable-next-line no-new-func
  return new Function('document', PANEL.slice(i, j + 3) + '\nreturn spPintar;');
}

test('el buscador de Solicitudes de Pago no se lleva el cursor al repintar', () => {
  const { doc, cont, nodos } = domFalso();
  const spPintar = pintor()(doc);
  spPintar(cont, '<input id="sp-f-q-pendiente"><table></table>');
  // El operador está escribiendo «flete» y ya movió el cursor al medio.
  const antes = nodos['sp-f-q-pendiente'];
  antes.focus();
  antes.value = 'flete';
  antes.selectionStart = antes.selectionEnd = 3;
  // Llega la respuesta del servidor y la lista se vuelve a dibujar entera.
  spPintar(cont, '<input id="sp-f-q-pendiente"><table><tr></tr></table>');
  assert.ok(doc.activeElement, 'el foco se perdió: la próxima letra va a ningún lado');
  // El nodo VIEJO ya no está en la pantalla: tener el foco puesto ahí es lo
  // mismo que no tenerlo. Tiene que estar en el que se acaba de dibujar.
  assert.notEqual(doc.activeElement, antes, 'el foco quedó en el input que se destruyó');
  assert.equal(doc.activeElement, nodos['sp-f-q-pendiente']);
  assert.equal(doc.activeElement.selectionStart, 3, 'el cursor saltó al principio');
  assert.equal(doc.activeElement.selectionEnd, 3);
});

test('y si nadie estaba escribiendo, no le roba el foco a nadie', () => {
  const { doc, cont } = domFalso();
  const spPintar = pintor()(doc);
  spPintar(cont, '<input id="sp-f-q-pendiente">');
  assert.equal(doc.activeElement, null);
});

test('un foco de otra parte de la pantalla no se toca', () => {
  // Sólo se restituye lo que estaba ADENTRO de lo que se redibujó. Si no se
  // mirara eso, refrescar la lista le sacaría el cursor a alguien que está
  // escribiendo en un modal abierto encima.
  const { doc, cont, fuera } = domFalso();
  const spPintar = pintor()(doc);
  let foqueado = 0;
  const ajeno = { id: 'otra-cosa', _dentro: null, focus() { foqueado++; },
    setSelectionRange() { throw new Error('no se le toca el cursor a un campo ajeno'); } };
  fuera['otra-cosa'] = ajeno;
  doc.activeElement = ajeno;
  spPintar(cont, '<input id="sp-f-q-pendiente">');
  assert.equal(doc.activeElement, ajeno);
  assert.equal(foqueado, 0, 'le devolvió el foco a un campo que no había perdido');
});

test('las tres salidas de la lista pintan con spPintar, no con innerHTML', () => {
  // Son tres: con resultados, vacía por filtro, y la vista «me toca a mí». Si
  // una sola quedara con innerHTML=, el cursor se pierde justo en el caso que
  // más se usa: escribir hasta que la lista quede en una fila.
  const i = PANEL.indexOf('function spListaRender(vista, r) {');
  const j = PANEL.indexOf('\r\n// ── ORDENAR LOS LISTADOS', i);
  assert.ok(i > 0 && j > i);
  const b = PANEL.slice(i, j);
  assert.equal((b.match(/spPintar\(cont,/g) || []).length, 3);
  assert.ok(!b.includes('cont.innerHTML ='), 'quedó una salida que repinta a lo bruto');
});


// ── 7 · EL CONTADOR DE FOTOS, QUE VIVÍA DE PRESTADO ────────────────────────
//
// El «✓ 3» de fotos vive en el cuadro del artículo, y ese cuadro lo arma
// sgRecRenderCalidad. sgRecRenderFotos sólo pinta las miniaturas.
//
// Antes el contador se ponía al día por accidente: cualquier tecla del paso 6
// redibujaba el cuadro entero — que era exactamente el bug. Al sacar ese
// redibujado había que darle al contador su propia razón de existir, o quedaba
// mostrando el número viejo hasta que alguien tocara el tilde.

test('el contador se pone al día SIN rearmar el cuadro', () => {
  // Rearmarlo para actualizar un número es volver a la trampa del principio: la
  // foto se comprime en segundo plano, y si mientras tanto el operador volvió al
  // campo de texto, el redibujado se lo borra. El contador tiene su propio lugar.
  const i = PANEL.indexOf('function sgRecRenderFotos(){');
  const b = PANEL.slice(i, i + 2000);
  assert.match(b, /var cnt = eid\('sg-rec-fc-' \+ pref \+ '-' \+ i\);/);
  assert.match(b, /if \(cnt\) cnt\.textContent = n \? \('✓ ' \+ n\) : '';/);
  // Y los dos pasos que lo muestran le dan ese id.
  assert.ok(PANEL.includes('\'<span id="sg-rec-fc-cal-\' + i + \'"'));
  assert.ok(PANEL.includes('\'<span id="sg-rec-fc-peso-\' + i + \'"'));
});

test('y nadie redibuja un paso entero para contar fotos', () => {
  const add = PANEL.indexOf('async function sgRecAddFotos(');
  const b = PANEL.slice(add, PANEL.indexOf('\r\n}', add));
  for (const render of ['sgRecRenderCalidad', 'sgRecRenderPesos']) {
    assert.ok(!b.includes(render), 'agregar una foto rearma ' + render + ' y roba el cursor');
  }
  const del = PANEL.indexOf('function sgRecDelFoto(i){');
  const d = PANEL.slice(del, del + 200);
  for (const render of ['sgRecRenderCalidad', 'sgRecRenderPesos']) {
    assert.ok(!d.includes(render), 'borrar una foto rearma ' + render);
  }
});

test('«faltaron <100 kg» no rompe la pantalla al volver al paso', () => {
  // esc() escapa comillas para meter texto en un atributo; no toca el «<». El
  // contenido de un <textarea> es texto DIBUJADO: con esc(), escribir un «<» y
  // volver a entrar se comía el resto del cuadro.
  const i = PANEL.indexOf('function sgRecRenderCalidad(){');
  const b = PANEL.slice(i, PANEL.indexOf('sgRecRenderFotos();', i));
  assert.ok(/<textarea rows="2"[^\n]*escH\(c\.observaciones \|\| ''\)/.test(b),
    'el textarea de observaciones no escapa el HTML');
  assert.ok(!/textarea[^\n]*esc\(c\.observaciones/.test(b), 'el textarea volvió a esc()');
});

test('el % afectado se recorta a 0–100 en el servidor, que es el que decide', () => {
  // El input dice min=0 max=100 y eso no bloquea nada: se tipea 500 y así sale
  // impreso en el informe al proveedor. «Afectado el 500%» no se reclama.
  const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
  const i = SG.indexOf("router.post('/recepciones'");
  const b = SG.slice(i, SG.indexOf('\r\n});', i));
  assert.match(b, /const pct = \(v\) => \{ const n = numN\(v\); return n == null \? null : Math\.max\(0, Math\.min\(100, n\)\); \};/);
  assert.match(b, /pct\(c\.pct_afectado\)/);
  assert.match(b, /pct\(b\.calidad_pct_afectado\)/);
});


// ── 8 · EL INFORME QUE SE LE MANDA AL PROVEEDOR ────────────────────────────
//
// Escribir el manual campo por campo destapó esto, que es la mitad del punto de
// tener manual: el paso 6 se carga POR PRODUCTO y se guarda en
// sg_recepcion_calidad, y el generador del PDF ya sabía imprimirlo así —mira
// rec.calidad—. Pero las dos rutas que arman el PDF nunca le pasaban ese
// arreglo: leían las columnas viejas de la recepción, que desde que la calidad
// es por producto viajan siempre en null.
//
// El informe salía con la carátula, los lotes y las fotos, y en blanco
// justamente el renglón por el que se reclama.

test('el PDF definitivo trae el informe por producto', () => {
  const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
  const i = SG.indexOf("router.get('/recepciones/:id/calidad.pdf'");
  assert.ok(i > 0);
  const b = SG.slice(i, SG.indexOf('\r\n});', i));
  assert.match(b, /rec\.calidad = db\.prepare\(`SELECT c\.\*, p\.nombre AS producto_nombre/);
  assert.match(b, /FROM sg_recepcion_calidad c/);
  assert.match(b, /WHERE c\.recepcion_id = \? ORDER BY c\.id`\)\.all\(rec\.id\);/);
});

test('y la vista previa muestra lo que se acaba de tipear', () => {
  // Si la previa saliera en blanco, el operador la mira, la ve vacía y concluye
  // que no cargó nada — justo después de haberlo cargado.
  const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
  const i = SG.indexOf("router.post('/recepciones/preview-calidad.pdf'");
  assert.ok(i > 0);
  const b = SG.slice(i, SG.indexOf('\r\n});', i));
  assert.match(b, /calidad: \(Array\.isArray\(b\.calidad_items\) \? b\.calidad_items : \[\]\)/);
  assert.match(b, /\.filter\(\(c\) => c && c\.observada\)/);
  // Y con el mismo recorte del porcentaje que al guardar: la previa no puede
  // prometer un número que el informe definitivo no va a tener.
  assert.match(b, /Math\.max\(0, Math\.min\(100, Number\(c\.pct_afectado\)\)\)/);
});

test('el nombre del producto viaja para que la previa no diga «—»', () => {
  const i = PANEL.indexOf('calidad_items:');
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /producto_nombre: it\.producto_nombre \|\| null,/);
});

test('el generador imprime por producto, que ya sabía hacerlo', () => {
  const GEN = fs.readFileSync(path.join(RAIZ, 'src/servicios/recepcionCalidadPDF.js'), 'utf8');
  assert.match(GEN, /const porProducto = Array\.isArray\(rec\.calidad\) \? rec\.calidad\.filter\(\(c\) => c\.observada\) : \[\];/);
  assert.match(GEN, /row\("Producto", c\.producto_nombre \|\| "—"\);/);
});


// ── 9 · LO QUE SE ESCRIBE AL RECIBIR, DONDE SE PUEDE LEER ──────────────────
//
// El asistente pide dos textos: la justificación de las diferencias (paso 5) y
// las observaciones generales. Los dos se guardaban bien y viajaban en el GET…
// y ninguna pantalla los mostraba.
//
// Un campo que sólo se escribe es un campo que a la tercera vez nadie completa,
// y peor: el que lo completó cree que quedó dicho. Escribir el manual fue lo que
// lo destapó — al ir a poner «con qué se enlaza» no había con qué.

test('la lista de Recepciones muestra lo que se escribió al recibir', () => {
  const i = PANEL.indexOf('function sgRecListPintar(){');
  const b = PANEL.slice(i, PANEL.indexOf('\r\n}', i));
  assert.match(b, /escH\(x\.variacion_motivo\)/);
  assert.match(b, /escH\(x\.observaciones\)/);
  // Como segundo renglón de la partida, no como columna: siete columnas ya son
  // las que entran sin barra lateral, y el texto es de largo variable.
  assert.match(b, /white-space:normal/);
  assert.ok(!/<th>/.test(b), 'la cabecera de la tabla se toca en el HTML, no acá');
});

test('y el buscador los mira: «pesaron de menos» encuentra su recepción', () => {
  const i = PANEL.indexOf('function sgRecListPintar(){');
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /\(x\.observaciones\|\|''\)/);
  assert.match(b, /\(x\.variacion_motivo\|\|''\)/);
});

test('el servidor ya los mandaba: no hacía falta tocarlo', () => {
  // SELECT r.* trae las dos columnas. El agujero estaba entero en la pantalla.
  const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
  const i = SG.indexOf("router.get('/recepciones', requireAuth");
  const b = SG.slice(i, SG.indexOf('\r\n});', i));
  assert.match(b, /SELECT r\.\*, o\.numero AS oc_numero/);
});
