// ══ REPROCESOS SE CARGA EN UNA VENTANA ════════════════════════════════════
//
// Pablo, 8/9/2026: «Reprocesos OK para avanzar».
//
// Era la última pantalla de San Gerónimo con el formulario metido adentro: arriba
// se cargaba y abajo estaba el historial, todo en la misma vista. Que se abra una
// ventana es lo que le dice al operador que dejó de mirar y empezó a cargar — y
// acá importa más que en ningún lado, porque las tres operaciones TOCAN EL STOCK
// y dos de ellas no se pueden deshacer.
//
// Las cuatro reglas de una ventana las audita ventanas_del_panel.test.mjs sobre
// TODAS las del panel. Acá se prueba lo que es propio de estas tres: que los
// formularios se hayan ido de verdad, que la puerta quede, que abrir deje la
// ventana limpia, y que la entrada desde Stock siga llegando a algún lado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

const VENTANAS = [
  { modal: 'sgr-rep-modal', sub: 'sgr-sub-reproceso', abrir: 'sgrReprAbrir',
    guardar: 'sgrReprGuardar', confirm: 'sgr-rep-confirm', hist: 'sgrReprHist' },
  { modal: 'sgr-tr-modal', sub: 'sgr-sub-transformacion', abrir: 'sgrTrAbrir',
    guardar: 'sgrTrGuardar', confirm: 'sgr-tr-confirm', hist: 'sgrTrHist' },
  { modal: 'sgr-dec-modal', sub: 'sgr-sub-decomiso', abrir: 'sgrDecAbrir',
    guardar: 'sgrDecGuardar', confirm: 'sgr-dec-confirm', hist: 'sgrDecHist' },
];

// El cuerpo de una ventana, balanceando divs: recortar «hasta la siguiente»
// barrería markup de después y daría falsos positivos.
function cuerpo(id) {
  const i = PANEL.indexOf('id="' + id + '"');
  assert.ok(i > 0, 'no existe la ventana ' + id);
  const ini = PANEL.lastIndexOf('<div', i);
  let prof = 0, j = ini;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = ini;
  let m;
  while ((m = re.exec(PANEL))) {
    prof += m[0] === '</div>' ? -1 : 1;
    if (prof === 0) { j = m.index + m[0].length; break; }
  }
  assert.ok(j > ini, 'la ventana ' + id + ' no cierra');
  return PANEL.slice(ini, j);
}

test('las tres operaciones tienen su ventana, y el formulario está adentro', () => {
  for (const v of VENTANAS) {
    const c = cuerpo(v.modal);
    assert.match(c, /class="ab-modal-overlay sg-mod"/, v.modal + ' sin sg-mod');
    // El formulario, de verdad adentro: los campos, no sólo el título.
    assert.match(c, /class="sgr-card"/, v.modal + ' no tiene el formulario');
    assert.match(c, new RegExp('onclick="' + v.guardar + '\\(\\)"'),
      v.modal + ' no tiene su botón de guardar');
  }
});

test('y el cartel del comprobante también, porque es lo que hay que leer', () => {
  // La ventana NO se cierra al guardar: adentro quedan los códigos de los lotes
  // hijos, la merma y el disponible. Si el cartel se hubiera quedado en la
  // pantalla, guardar lo escribiría atrás de la ventana abierta y no se vería.
  for (const v of VENTANAS) {
    assert.match(cuerpo(v.modal), new RegExp('class="sgr-confirm" id="' + v.confirm + '"'),
      v.confirm + ' quedó afuera de su ventana');
  }
  // Y el escritor sigue buscándolo por el mismo id.
  assert.match(PANEL, /function sgrConfirm\(tab, html\)\{ var el=eid\('sgr-'\+tab\+'-confirm'\)/);
});

test('no quedó ningún formulario de carga suelto en la pantalla', () => {
  // La pantalla es la LISTA de lo que se hizo. Si quedara un campo de carga
  // afuera, habría dos maneras de cargar lo mismo.
  const sec = trozo(PANEL, '<div class="sec sg-mod" id="sec-sg-reprocesos">',
                    '<!-- ══ Módulo Gastos Directos');
  for (const id of ['sgr-rep-kgproc', 'sgr-rep-gasto', 'sgr-rep-hijos', 'sgr-pick-rep',
                    'sgr-tr-dest', 'sgr-tr-kg', 'sgr-pick-tr',
                    'sgr-dec-kg', 'sgr-dec-motivo', 'sgr-pick-dec']) {
    assert.ok(!sec.includes('id="' + id + '"'), id + ' sigue metido en la pantalla');
  }
  // Ni los botones de guardar.
  for (const v of VENTANAS) {
    assert.ok(!sec.includes(v.guardar + '()'), v.guardar + ' sigue en la pantalla');
  }
});

test('en la pantalla queda la puerta de cada una, con su botón', () => {
  const sec = trozo(PANEL, '<div class="sec sg-mod" id="sec-sg-reprocesos">',
                    '<!-- ══ Módulo Gastos Directos');
  for (const v of VENTANAS) {
    const pane = trozo(sec, 'id="' + v.sub + '"', 'Historial de');
    assert.match(pane, new RegExp('onclick="' + v.abrir + '\\(\\)"'),
      v.sub + ' se quedó sin puerta');
  }
  // Y el historial sigue abajo: es lo que se mira cuando no se está cargando.
  for (const tb of ['sgr-tb-reproceso', 'sgr-tb-transformacion', 'sgr-tb-decomiso']) {
    assert.ok(sec.includes('id="' + tb + '"'), 'se fue el historial ' + tb);
  }
});

test('abrir deja la ventana como si fuera la primera vez', () => {
  // Las tres tocan el stock: arrastrar los kilos de la operación anterior es la
  // manera de decomisar dos veces el mismo lote sin darse cuenta.
  const a = trozo(PANEL, 'function sgrReprAbrir(){', '\r\n}');
  assert.match(a, /sgPickerInit\('rep'/);
  assert.match(a, /SG\.reprHijos=\[\]/);
  assert.match(a, /eid\('sgr-rep-kgproc'\)\.value=''/);
  assert.match(a, /eid\('sgr-rep-confirm'\)\.classList\.remove\('on'\)/,
    'deja a la vista el comprobante de la operación anterior');
  assert.match(a, /sgModalArriba\('sgr-rep-modal'\)/);

  const t = trozo(PANEL, 'function sgrTrAbrir(){', '\r\n}');
  assert.match(t, /sgPickerInit\('tr'/);
  assert.match(t, /eid\('sgr-tr-kg'\)\.value=''/);
  assert.match(t, /eid\('sgr-tr-confirm'\)\.classList\.remove\('on'\)/);
  assert.match(t, /sgModalArriba\('sgr-tr-modal'\)/);

  const d = trozo(PANEL, 'function sgrDecAbrir(){', '\r\n}');
  assert.match(d, /sgPickerInit\('dec'/);
  assert.match(d, /eid\('sgr-dec-motivo'\)\.value=''/);
  assert.match(d, /eid\('sgr-dec-confirm'\)\.classList\.remove\('on'\)/);
  assert.match(d, /sgModalArriba\('sgr-dec-modal'\)/);
});

test('cambiar de solapa ya NO arma el formulario: sólo trae el historial', () => {
  // Si lo armara, pasar de Reproceso a Decomiso y volver borraría lo que estaba
  // cargado en la ventana, y el picker se pediría de nuevo sin que nadie lo pida.
  const f = trozo(PANEL, 'function sgrSub(s){', '\r\n}');
  assert.ok(!/sgPickerInit/.test(f), 'sgrSub sigue armando el picker');
  assert.ok(!/kgproc/.test(f), 'sgrSub sigue blanqueando campos del formulario');
  assert.match(f, /s==='reproceso'[\s\S]{0,200}sgrReprHist\(\)/);
  assert.match(f, /s==='transformacion'\) sgrTrHist\(\)/);
  assert.match(f, /s==='decomiso'\) sgrDecHist\(\)/);
});

test('el ♻️ Reprocesar de Stock ABRE la ventana, no deja al operador en blanco', () => {
  // Precarga la madre y viaja a esta pantalla. Con el formulario adentro de una
  // ventana, si no se abre el operador aprieta el botón en Stock y llega a un
  // historial que no muestra nada de lo que pidió.
  const f = trozo(PANEL, 'function sgrSub(s){', '\r\n}');
  assert.match(f, /SG\._reprPre=null; sgrReprAbrir\(\); sgrReprInject\(pre\.loteId, pre\.productoId\)/);
  // Y la entrada desde Stock sigue existiendo.
  assert.match(PANEL, /sgrReprPrecargar\('\+l\.id\+','\+l\.producto_id\+'\)/);
});

test('el botón de guardar del reproceso sigue siendo el que se habilita solo', () => {
  // sgrReprRenderMeta lo prende y lo apaga según cuadre el reparto. Se mudó al
  // pie de la ventana: si hubiera perdido el id, el botón queda apagado para
  // siempre y no se puede registrar nada.
  assert.match(cuerpo('sgr-rep-modal'), /id="sgr-rep-btn"/);
  assert.match(PANEL, /var btn=eid\('sgr-rep-btn'\); btn\.disabled=!valid/);
});

test('el <style> del módulo NO se movió: lo usan otras 16 cajas del panel', () => {
  // Es la única definición de .sg-mod .sgr-card y .sg-mod .sgr-confirm de todo
  // panel.html, incluidas las de Facturar en el puesto y Merma.
  assert.match(PANEL, /\.sg-mod \.sgr-card\{/);
  assert.match(PANEL, /\.sg-mod \.sgr-confirm\{[^}]*display:none\}/);
  const sec = trozo(PANEL, '<div class="sec sg-mod" id="sec-sg-reprocesos">',
                    '<!-- ══ Módulo Gastos Directos');
  assert.match(sec, /\.sg-mod \.sgr-card\{/, 'el <style> del módulo se movió de lugar');
});

test('y la pantalla tiene su «¿Cómo se usa?», que no tenía', () => {
  // Pablo, 8/9/2026: «cada vez que modifiques algo en alguna pantalla tenés que
  // actualizar el Cómo se usa correspondiente. Si no nos perdemos».
  assert.match(PANEL, /onclick="sgManualAbrir\('reprocesos'\)"/);
  assert.match(PANEL, /SG_MANUAL\.reprocesos = \{ titulo: 'Reprocesos'/);
  const m = trozo(PANEL, "SG_MANUAL.reprocesos = { titulo: 'Reprocesos'", '\r\n};');
  // Las tres operaciones explicadas, y lo que no se puede deshacer.
  assert.match(m, /♻️ Reproceso/);
  assert.match(m, /🔄 Transformación/);
  assert.match(m, /🗑️ Decomiso/);
  assert.match(m, /única de las tres que se puede revertir/);
  // Y por qué sube el costo por kilo después de un decomiso, que es la pregunta
  // que se hace el que lo ve.
  assert.match(m, /ese costo <b>se lo lleva lo que /);
  assert.match(m, /Se carga en una ventana <span class="ver">V1025<\/span>/);
});
