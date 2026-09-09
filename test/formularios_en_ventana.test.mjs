// ══ LOS ÚLTIMOS CUATRO FORMULARIOS QUE CARGABAN SIN ABRIR NADA ════════════
//
// Pablo, 7/9/2026: «veamos la manera de unificar este tipo de conceptos para que
// todo el panel funcione de la misma manera, que cuando tengamos que abrir abra
// una ventana».
//
// Quedaban cuatro, y no eran de San Gerónimo:
//   · Scout — asignar un reporte a alguien
//   · Personal — crear una semana de pago
//   · Personal — agregar una vigencia de tarifa
//   · Flujo de fondos — cargar el saldo de un banco
//
// Los tres primeros aparecían y desaparecían con `display`, y el de Scout además
// hacía scroll solo hasta él: el operador veía la pantalla moverse y tenía que
// darse cuenta de que ahora estaba cargando. El cuarto vivía siempre abierto
// arriba de su lista.
//
// EL RIESGO REAL NO ERA VISUAL. Un formulario que sólo se esconde CONSERVA lo que
// tenía: la persona del reporte anterior, la fecha de la semana pasada, la tarifa
// del otro. Se abría «de nuevo» y ya venía cargado.
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

const CUATRO = [
  { modal: 'scout-asig-modal', abrir: 'scoutAbrirAsig', guardar: 'scoutGuardarAsig',
    campos: ['scout-asig-usr', 'scout-asig-frec'] },
  { modal: 'pp-sem-modal', abrir: 'ppSemAbrir', guardar: 'ppSemCrear',
    campos: ['pp-sem-apertura', 'pp-sem-cierre', 'pp-sem-notas'] },
  { modal: 'pp-tarper-modal', abrir: 'ppTarperAbrir', guardar: 'ppGuardarTarifaPersona',
    campos: ['pp-tarper-persona', 'pp-tarper-tarifa', 'pp-tarper-desde'] },
  { modal: 'fp-sal-modal', abrir: 'fpSaldoAbrir', guardar: 'fpSaldoGuardar',
    campos: ['fp-sal-banco', 'fp-sal-fecha', 'fp-sal-monto'] },
];

// El cuerpo real de una ventana, balanceando divs.
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

test('los cuatro tienen su ventana, con los campos adentro', () => {
  for (const v of CUATRO) {
    const c = cuerpo(v.modal);
    assert.match(c, /class="ab-modal-overlay"/, v.modal + ' no es una ventana del panel');
    for (const campo of v.campos) {
      assert.ok(c.includes('id="' + campo + '"'), v.modal + ': falta el campo ' + campo);
    }
    assert.match(c, new RegExp('onclick="' + v.guardar + '\\(\\)"'),
      v.modal + ' no tiene su botón de guardar');
    // Y su salida: se sale con Cancelar, con guardar, o con la ×.
    assert.match(c, new RegExp("closeMB\\('" + v.modal + "'\\)"), v.modal + ' no se puede cerrar');
  }
});

test('cada campo está UNA sola vez: no quedó el formulario viejo', () => {
  // Dos elementos con el mismo id y getElementById devuelve el primero — que
  // sería el escondido. Se cargaría en la ventana y se guardaría lo de atrás.
  for (const v of CUATRO) {
    for (const campo of v.campos) {
      const n = (PANEL.match(new RegExp('id="' + campo + '"', 'g')) || []).length;
      assert.equal(n, 1, 'el id ' + campo + ' aparece ' + n + ' veces');
    }
  }
});

test('abrir deja la ventana en blanco', () => {
  // Es lo que el formulario escondido NO hacía: conservaba lo de la vez
  // anterior. En Scout eso era mandarle un reporte a la persona equivocada con
  // sólo apretar Asignar.
  for (const v of CUATRO) {
    const f = trozo(PANEL, 'function ' + v.abrir + '(', '\r\n}');
    assert.match(f, new RegExp("sgModalArriba\\('" + v.modal + "'\\)"),
      v.abrir + ' no abre la ventana');
    assert.match(f, /value = ''|value=''/, v.abrir + ' no limpia los campos');
  }
});

test('y en Scout se limpia la PERSONA, que es lo que se manda', () => {
  const f = trozo(PANEL, 'function scoutAbrirAsig(', '\r\n}');
  assert.match(f, /var u = document\.getElementById\('scout-asig-usr'\); if \(u\) u\.value = ''/);
  // El id del reporte SÍ se pisa con el nuevo, que es lo correcto.
  assert.match(f, /document\.getElementById\('scout-asig-rep-id'\)\.value = id/);
});

test('guardar cierra la ventana: adentro no queda nada que leer', () => {
  // Al revés que Reprocesos, donde queda el comprobante y por eso NO se cierra.
  for (const v of CUATRO) {
    const f = trozo(PANEL, 'function ' + v.guardar + '(', '\r\n}');
    assert.match(f, new RegExp("closeMB\\('" + v.modal + "'\\)"),
      v.guardar + ' no cierra la ventana al guardar');
  }
});

test('y la lista se recarga después, o no se ve lo que se acaba de cargar', () => {
  const recarga = { scoutGuardarAsig: 'paLoadScout', ppSemCrear: 'ppLoadSemanas',
    ppGuardarTarifaPersona: 'ppLoadTarifasPersona', fpSaldoGuardar: 'fpSaldosCargar' };
  for (const v of CUATRO) {
    const f = trozo(PANEL, 'function ' + v.guardar + '(', '\r\n}');
    assert.match(f, new RegExp(recarga[v.guardar] + '\\(\\)'), v.guardar + ' no recarga la lista');
  }
});

test('en la pantalla quedó la puerta, no el formulario', () => {
  for (const v of CUATRO) {
    assert.match(PANEL, new RegExp('onclick="' + v.abrir + '\\(\\)"|onclick="' + v.abrir + '\\('),
      'no hay botón que abra ' + v.modal);
  }
  // Y el de Scout dejó de aparecer con display + scrollIntoView.
  assert.ok(!/scout-asig-form/.test(PANEL), 'quedó el formulario inline de Scout');
  assert.ok(!/getElementById\('scout-asig-form'\)/.test(PANEL));
});

test('ninguna de las cuatro vive adentro de una pantalla', () => {
  // Lo audita ventanas_del_panel sobre las 201, pero acá se dice por qué importa
  // para éstas: con .sec{display:none}, una ventana que cuelga de una pantalla
  // sólo se abre desde ésa.
  const clases = (t) => (t.match(/class="([^"]*)"/) || [])[1] || '';
  for (const v of CUATRO) {
    const i = PANEL.indexOf('id="' + v.modal + '"');
    const antes = PANEL.slice(0, i);
    // Se cuentan las .sec abiertas y cerradas antes de la ventana.
    let abiertas = 0;
    const re = /<div\b[^>]*>|<\/div>/g;
    let m, pila = [];
    while ((m = re.exec(antes))) {
      if (m[0] === '</div>') pila.pop();
      else pila.push(clases(m[0]).split(/\s+/).includes('sec'));
    }
    abiertas = pila.filter(Boolean).length;
    assert.equal(abiertas, 0, v.modal + ' está adentro de ' + abiertas + ' pantalla(s)');
  }
});

test('y la regla queda escrita donde se la va a leer', () => {
  const CLAUDE = fs.readFileSync(path.join(RAIZ, 'CLAUDE.md'), 'utf8');
  assert.match(CLAUDE, /no queda ningún formulario cargando adentro de una pantalla/);
  // Lo que importa no es la lista, es la razón: esconder no es limpiar.
  assert.match(CLAUDE, /un formulario que sólo se esconde CONSERVA lo que\r?\n?tenía/);
});
