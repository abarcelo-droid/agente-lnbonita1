// ══ LA PLATA SE MUESTRA EXACTA, Y EL DETALLE SE ORDENA ═════════════════════
//
// Pablo, 7/10/2026, sobre Planificación Financiera de San Gerónimo: «quiero ver el monto exacto de
// los cheques… no me los muestres ni en miles ni en millones. Cuando pido detalle tampoco, y
// permitime ordenar por cualquiera de las columnas».
//
// El cuadro abreviaba a millones —«3.646,2M»— porque con 26 columnas de 9 dígitos no entra nada en
// pantalla. El problema del ancho es cierto y la respuesta era la equivocada: un número redondeado
// no se puede cruzar contra el resumen del banco, que es para lo que se mira este cuadro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

function fuente(txt, firma) {
  const i = txt.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  let prof = 0, k = txt.indexOf('{', i);
  for (; k < txt.length; k++) {
    if (txt[k] === '{') prof++;
    else if (txt[k] === '}') { prof--; if (prof === 0) break; }
  }
  return txt.slice(i, k + 1);
}

// Un `var X = [...]` tal como está escrito.
function lineaArr(txt, nombre) {
  const i = txt.indexOf('var ' + nombre + ' = [');
  assert.ok(i >= 0, 'no está el arreglo ' + nombre);
  return txt.slice(i, txt.indexOf('];', i) + 2);
}

const fmt = new Function([
  fuente(PANEL, 'function fpN(n, dec)'),
  fuente(PANEL, 'function fpNum(n)'),
  fuente(PANEL, 'function fpMonto(n)'),
  'return fpMonto;',
].join('\n'))();

// ── EL NÚMERO ──────────────────────────────────────────────────────────────

test('la plata se escribe entera, sin «k» ni «M»', () => {
  assert.equal(fmt(4500000), '4.500.000');
  assert.equal(fmt(3646200000), '3.646.200.000');
  assert.equal(fmt(155700000), '155.700.000');
  assert.equal(fmt(37000000), '37.000.000');
  // Los que antes se iban a «k»: tampoco.
  assert.equal(fmt(2500), '2.500');
  assert.equal(fmt(999), '999');
  for (const v of [1e3, 1e6, 1e9, 1234, 1234567, 999999]) {
    assert.ok(!/[kM]/.test(fmt(v)), 'quedó abreviado: ' + fmt(v));
  }
});

test('los centavos salen sólo si los hay, y no se redondean', () => {
  // El listado de cheques mostraba 4.500.000,50 como «4.500.001»: medio peso de diferencia contra
  // el banco es media hora de buscar dónde está.
  assert.equal(fmt(4500000.5), '4.500.000,50');
  assert.equal(fmt(1234.56), '1.234,56');
  assert.equal(fmt(4500000), '4.500.000', 'le puso «,00» a un número redondo');
});

test('el cero se ve como un guión, para que el cuadro se pueda leer', () => {
  assert.equal(fmt(0), '—');
  assert.equal(fmt(null), '—');
  assert.equal(fmt(undefined), '—');
  assert.equal(fmt(''), '—');
});

test('los negativos también salen enteros, que es donde se mira el rojo', () => {
  assert.equal(fmt(-2500000), '-2.500.000');
  assert.equal(fmt(-999), '-999');
});

test('no quedó ningún monto abreviado en todo el módulo', () => {
  // El abreviador se SACA, no se deja sin usar: el que lo encuentre mañana lo va a volver a llamar.
  assert.ok(!/function fpM\(n\)/.test(PANEL), 'el abreviador a millones sigue definido');
  assert.ok(!/\bfpM\(/.test(PANEL), 'alguna pantalla sigue abreviando la plata');
  // Y el cuadro usa el exacto en TODAS sus filas: los conceptos, los totales, el neto y el
  // acumulado. Si una sola quedara abreviada, la columna dejaría de sumar a la vista.
  const g = fuente(PANEL, 'function fpPintarGrilla()');
  assert.equal((g.match(/fpMonto\(/g) || []).length, 10, 'cambió la cantidad de montos del cuadro');
  assert.ok(!/fpN\(m\)/.test(g), 'quedó un monto del cuadro redondeado a entero');
  // Y la casilla que se carga a mano tampoco: abrirla y volver a guardar le comía los centavos.
  assert.match(g, /value="' \+ \(m \? fpNum\(m\) : ''\)/);
});

// ── EL ORDEN DEL DETALLE ───────────────────────────────────────────────────

function pantalla(filas) {
  let html = '';
  const doc = { getElementById: () => ({ set innerHTML(v) { html = v; }, get innerHTML() { return html; } }) };
  const ctx = new Function('document', [
    'var FP = { sem: { filas: [], orden: "fecha_pago", desc: false, aviso: "" } };',
    fuente(PANEL, 'function fpN(n, dec)'),
    fuente(PANEL, 'function fpNum(n)'),
    fuente(PANEL, 'function fpMonto(n)'),
    fuente(PANEL, 'function fpEsc(s)'),
    fuente(PANEL, 'function fpFecha(f)'),
    fuente(PANEL, 'function sgNorm(s)'),
    lineaArr(PANEL, 'FP_SEM_COLS'),
    fuente(PANEL, 'function fpSemOrdenar(k)'),
    fuente(PANEL, 'function fpSemPintar()'),
    'return { FP: FP, ordenar: fpSemOrdenar, pintar: fpSemPintar };',
  ].join('\n'))(doc);
  ctx.FP.sem.filas = filas;
  ctx.pintar();
  return {
    ordenar: (k) => { ctx.ordenar(k); return null; },
    html: () => html,
    // Los números de cheque en el orden en que quedaron dibujados.
    orden: () => (html.match(/monospace">([^<]*)</g) || []).map((m) => m.replace(/.*">/, '').replace('<', '')),
    estado: () => ctx.FP.sem,
  };
}

const CH = (numero, banco, beneficiario, fecha_pago, monto) =>
  ({ numero, banco, beneficiario, fecha_pago, monto });

// LOS NÚMEROS ESTÁN ELEGIDOS PARA QUE ORDENAR COMO TEXTO Y COMO NÚMERO DEN DISTINTO. Con los
// números reales de la pantalla —todos de 8 o 9 dígitos y todos empezando con 9— las dos maneras
// dan el mismo orden, y un ejemplo así no prueba nada: la prueba pasaba igual con el bug puesto.
// Lo mismo con los importes: '900.000' empieza con 9 y de mayor a menor como texto se iría arriba
// de todo siendo el más chico.
const MUESTRA = [
  CH('90035062', 'FRANCES', 'TRANSLAIS S.R.L', '2026-10-05', 4500000),
  CH('10000045', 'GALICIA', 'EMPAQUE SATIVA S.R.L.', '2026-10-07', 900000),
  CH('9500123', 'FRANCES', 'Ñandú SA', '2026-10-05', 4200000),
  CH('90035290', 'NACION', '', '2026-10-06', 4100000),
  CH('90035227', '', 'PABLO GIGLIO', '2026-10-05', 4000000.5),
];

test('ordena por monto de mayor a menor, que es lo que se busca al apretar Monto', () => {
  const p = pantalla(MUESTRA.slice());
  p.ordenar('monto');
  assert.equal(p.estado().desc, true, 'la plata tiene que arrancar de mayor a menor');
  assert.deepEqual(p.orden(), ['90035062', '9500123', '90035290', '90035227', '10000045']);
  // Y apretándola de nuevo, al revés.
  p.ordenar('monto');
  assert.deepEqual(p.orden(), ['10000045', '90035227', '90035290', '9500123', '90035062']);
});

test('el N° se ordena como NÚMERO, no como texto', () => {
  // 900353433 tiene nueve dígitos y 90035337 tiene ocho: alfabéticamente el de nueve queda ANTES,
  // y la lista no se puede seguir con el talonario en la mano.
  const p = pantalla(MUESTRA.slice());
  p.ordenar('numero');
  // Como texto, '10000045' se iría primero y '9500123' último: así estaba antes.
  assert.deepEqual(p.orden(), ['9500123', '10000045', '90035062', '90035227', '90035290']);
});

test('ordena por banco, por beneficiario y por fecha', () => {
  const p = pantalla(MUESTRA.slice());
  p.ordenar('banco');
  assert.deepEqual(p.orden().slice(0, 3), ['90035062', '9500123', '10000045'],
    'FRANCES, FRANCES, GALICIA');
  p.ordenar('fecha_pago');
  assert.deepEqual(p.orden().slice(0, 3), ['90035062', '9500123', '90035227'],
    'los tres del 05/10 primero');
  // Y los acentos y la ñ no mandan a «Ñandú» al final de todo, que es donde lo pone el orden
  // crudo de la computadora.
  p.ordenar('beneficiario');
  const b = p.orden();
  assert.ok(b.indexOf('10000045') < b.indexOf('9500123'), 'EMPAQUE tiene que ir antes que Ñandú');
  assert.ok(b.indexOf('9500123') < b.indexOf('90035062'), 'Ñandú tiene que ir antes que TRANSLAIS');
});

test('un espacio de más al principio no manda el renglón arriba de todo', () => {
  // Es lo único que hay que emparejar antes de comparar: el orden de la computadora pone el
  // espacio antes que cualquier letra, así que un beneficiario tipeado con un espacio adelante se
  // iría al principio de la lista por un error invisible.
  const p = pantalla(MUESTRA.concat([CH('70001', 'MACRO', '  ZZZ ULTIMO SA', '2026-10-09', 100)]));
  p.ordenar('beneficiario');
  assert.equal(p.orden()[4], '70001', 'el que empieza con espacio se fue al principio');
});

test('los vacíos van al final, se ordene para donde se ordene', () => {
  // Un banco en blanco arriba de todo tapa la lista justo cuando se la está mirando ordenada por
  // banco, que es cuando se la ordena para encontrar algo.
  const p = pantalla(MUESTRA.slice());
  p.ordenar('banco');
  assert.equal(p.orden()[4], '90035227', 'el del banco vacío no quedó al final');
  p.ordenar('banco');
  assert.equal(p.orden()[4], '90035227', 'dado vuelta, el vacío se fue arriba');
  p.ordenar('beneficiario');
  assert.equal(p.orden()[4], '90035290', 'el del beneficiario vacío no quedó al final');
  p.ordenar('beneficiario');
  assert.equal(p.orden()[4], '90035290');
});

test('apretar la misma columna da vuelta el orden; apretar otra arranca de nuevo', () => {
  const p = pantalla(MUESTRA.slice());
  p.ordenar('banco');
  assert.equal(p.estado().desc, false, 'el texto arranca de la A a la Z');
  p.ordenar('banco');
  assert.equal(p.estado().desc, true);
  p.ordenar('fecha_pago');
  assert.equal(p.estado().desc, false, 'cambiar de columna tiene que volver a empezar');
});

test('ordenar no cambia cuánta plata hay', () => {
  // El total es el de TODOS los cheques de la ventana. Si se recalculara sobre lo que se ve, un
  // orden distinto daría otro número y nadie sabría cuál creer.
  const p = pantalla(MUESTRA.slice());
  const total = '17.700.000,50';
  assert.match(p.html(), new RegExp('total <b>' + total.replace(/\./g, '\\.') + '</b>'));
  p.ordenar('monto');
  assert.match(p.html(), new RegExp('total <b>' + total.replace(/\./g, '\\.') + '</b>'));
  // Y los cinco cheques siguen estando: ordenar no filtra.
  assert.equal(p.orden().length, 5);
  assert.match(p.html(), /<b>5<\/b> cheque\(s\)/);
});

test('el detalle muestra el monto exacto de cada cheque', () => {
  const p = pantalla(MUESTRA.slice());
  assert.match(p.html(), /4\.500\.000/);
  assert.match(p.html(), /4\.000\.000,50/, 'le comió los centavos a un cheque');
  assert.ok(!/4,5M|4,2M|2M</.test(p.html()), 'el detalle sigue abreviando');
});

test('cada encabezado se puede apretar y dice para dónde está ordenando', () => {
  const p = pantalla(MUESTRA.slice());
  for (const c of ['numero', 'banco', 'beneficiario', 'fecha_pago', 'monto']) {
    assert.match(p.html(), new RegExp('onclick="fpSemOrdenar\\(\'' + c + '\'\\)"'),
      'no se puede ordenar por ' + c);
  }
  // La flecha marca cuál manda y hacia dónde; las otras muestran que también se pueden apretar.
  assert.match(p.html(), /class="fp-ord on"[^>]*>Fecha<span class="fp-flecha">▲</);
  assert.equal((p.html().match(/↕/g) || []).length, 4, 'las otras cuatro tienen que ofrecerse');
  p.ordenar('fecha_pago');
  assert.match(p.html(), /class="fp-ord on"[^>]*>Fecha<span class="fp-flecha">▼</);
});

test('la tabla del detalle no saca barra de costado', () => {
  // Con el monto entero la columna crece; el beneficiario, que es lo único de largo variable,
  // parte de renglón en vez de empujar la tabla.
  assert.match(PANEL, /#fp-mb-semana table \{ table-layout:fixed; width:100% \}/);
  assert.match(PANEL, /#fp-mb-semana td \{ word-break:break-word \}/);
  const p = pantalla(MUESTRA.slice());
  assert.equal((p.html().match(/<col[ >]/g) || []).length, 5, 'faltan anchos de columna');
});
