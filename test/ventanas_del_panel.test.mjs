// ══════════════════════════════════════════════════════════════════════════
// TODO EL PANEL ABRE VENTANAS DE LA MISMA MANERA
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 7/9/2026: «veamos la manera de unificar este tipo de conceptos para que
// todo el panel funcione de la misma manera: que cuando tengamos que abrir, abra
// una ventana y eso».
//
// Hasta acá las reglas de las ventanas estaban clavadas de a una:
// test/modales_fuera_de_pantalla.test.mjs audita TRES ids escritos a mano, y las
// otras 138 ventanas del panel no las miraba nadie. Una lista a mano sólo
// protege lo que alguien se acordó de anotar.
//
// Este archivo audita TODAS las que hay, sin lista: se sacan del propio HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const CLAUDE = fs.readFileSync(path.join(RAIZ, 'CLAUDE.md'), 'utf8');

// Los tokens del atributo class. Se compara por TOKEN y no con \bsec\b: ese
// límite de palabra da positivo dentro de class="sec-chk", que existe en el
// archivo, y marcaría como «adentro de una pantalla» algo que no lo está.
function clases(tag) {
  return ((tag.match(/class="([^"]*)"/) || [, ''])[1]).split(/\s+/).filter(Boolean);
}

// LAS VENTANAS, TODAS. La primera versión de este audit sólo miraba
// `ab-modal-overlay` y auditaba 141 de 201: se le escapaban las 58 con
// class="mb" —que tienen el CSS byte por byte idéntico— y las 2 escritas a mano
// con position:fixed. Y justamente en esas 60 estaba la ÚNICA violación del
// panel: #pp-val-pwd-overlay vivía adentro de .sec#sec-personal-valorizar.
//
// Un audit que no ve la mitad de lo que audita da una tranquilidad falsa, que es
// peor que no tenerlo.
function ventanas() {
  const out = [];
  for (const m of PANEL.matchAll(/<div\b[^>]*>/g)) {
    const c = clases(m[0]);
    const aMano = /position:fixed;inset:0/.test(m[0]) && /z-index/.test(m[0]);
    if (!c.includes('ab-modal-overlay') && !c.includes('mb') && !aMano) continue;
    out.push({
      clases: c.join(' '),
      id: (m[0].match(/id="([^"]+)"/) || [, null])[1],
      pos: m.index,
    });
  }
  return out;
}

// El cuerpo de una ventana, balanceando <div>: desde su apertura hasta su cierre.
function cuerpoDe(pos) {
  const ini = PANEL.lastIndexOf('<div', pos);
  let d = 0;
  for (const m of PANEL.slice(ini).matchAll(/<div\b|<\/div>/g)) {
    d += m[0] === '</div>' ? -1 : 1;
    if (d === 0) return PANEL.slice(ini, ini + m.index + m[0].length);
  }
  return PANEL.slice(ini);
}

// La pila de <div> abiertos en una posición: sirve para saber de quién cuelga.
function ancestros(pos) {
  const pila = [];
  for (const m of PANEL.matchAll(/<div\b[^>]*>|<\/div>/g)) {
    if (m.index >= pos) break;
    if (m[0] === '</div>') pila.pop();
    else pila.push(m[0]);
  }
  return pila;
}

test('hay ventanas que auditar, y son las que se esperan', () => {
  // Si el regex deja de encontrarlas, todos los tests de abajo pasarían vacíos.
  const v = ventanas();
  assert.ok(v.length > 190, 'sólo se encontraron ' + v.length + ' ventanas: el regex se rompió');
  // Una de cada familia: las tres tienen que entrar al audit.
  assert.ok(v.some((x) => x.id === 'sg-fd-modal'), 'falta una .ab-modal-overlay');
  assert.ok(v.some((x) => x.id === 'mb-ped'), 'faltan las 58 con class="mb"');
  assert.ok(v.some((x) => x.id === 'pp-val-pwd-overlay'), 'faltan las escritas a mano');
  // Y todas tienen id: sin id no hay forma de abrirlas ni de nombrarlas en un
  // informe de este test.
  assert.deepEqual(v.filter((x) => !x.id).map((x) => x.pos), []);
});

test('NINGUNA ventana vive adentro de una pantalla', () => {
  // Con .sec{display:none}, una ventana que cuelga de una pantalla sólo se puede
  // abrir desde ESA pantalla: desde cualquier otra el botón corre y no se ve
  // nada. Ya pasó con los modales de facturar el remito y recibir la
  // liquidación, y es lo que documenta modales_fuera_de_pantalla.
  const malas = ventanas()
    .filter((v) => ancestros(v.pos).some((t) => clases(t).includes('sec')))
    .map((v) => v.id);
  assert.deepEqual(malas, [], 'estas ventanas están adentro de una pantalla');
});

test('la que usa las clases .sgr-* lleva sg-mod, o pierde su formato', () => {
  // .sgr-card (el formato de todos los campos) y .sgr-confirm (la ÚNICA regla que
  // esconde el cartel del comprobante) están escritas como DESCENDIENTES de
  // .sg-mod. Una ventana que las use sin ese ancestro se abre desarmada y con el
  // cartel de la operación anterior a la vista.
  assert.match(PANEL, /\.sg-mod \.sgr-card\{/);
  assert.match(PANEL, /\.sg-mod \.sgr-confirm\{[^}]*display:none\}/);

  const malas = [];
  for (const v of ventanas()) {
    // El cuerpo REAL, balanceando divs. Recortar «hasta la ventana siguiente»
    // barría el markup de después del modal y daba tres falsos positivos:
    // ab-modal-gasto, sg-pipase-modal y sg-mailfac-modal no usan .sgr-* — lo
    // usaba lo que venía atrás.
    const usaSgr = /class="[^"]*\bsgr-(card|confirm)\b/.test(cuerpoDe(v.pos));
    if (usaSgr && !/\bsg-mod\b/.test(v.clases)) malas.push(v.id);
  }
  assert.deepEqual(malas, [], 'usan .sgr-* sin llevar sg-mod puesto');
});

test('UNA sola manera de darle altura a la ventana, la abra quien la abra', () => {
  // De las 141 ventanas, 26 usaban el helper y 113 hacían classList.add('on') a
  // mano. El z-index lo ponía sólo el helper, así que una ventana abierta desde
  // adentro de otra quedaba DETRÁS: se ve el fondo gris, no se puede tocar nada,
  // y parece que el panel se colgó.
  //
  // Se arregla el mecanismo y no las 113 llamadas: tocar 113 lugares son 113
  // oportunidades de romper algo, y la 114ª que se escriba mañana vuelve a quedar
  // afuera.
  const z = PANEL.slice(PANEL.indexOf('function sgModalZ(el){'),
                        PANEL.indexOf('function sgModalZ(el){') + 700);
  assert.match(z, /\.ab-modal-overlay\.on, \.mb\.on/);
  assert.match(z, /if \(x !== el\) abiertos\+\+;/, 'se cuenta a sí misma y queda una altura de más');

  const obs = PANEL.slice(PANEL.indexOf('new MutationObserver(function(muts){'),
                          PANEL.indexOf('new MutationObserver(function(muts){') + 800);
  assert.match(obs, /attributeFilter: \['class'\], subtree: true/);
  assert.match(obs, /classList\.contains\('ab-modal-overlay'\) \|\| t\.classList\.contains\('mb'\)/);
  // Y el helper sigue existiendo: es la forma explícita de abrir.
  assert.match(PANEL, /function sgModalArriba\(id\)\{/);
});

test('y ninguna se cierra al clic afuera', () => {
  // Un clic al costado es un accidente, no una decisión: descartaba lo cargado
  // sin ningún deshacer. Se sale con Cancelar, con el botón de guardar o con la ×.
  assert.ok(!/e\.target\s*===\s*el\)\s*el\.classList\.remove\('on'\)/.test(PANEL));
  assert.ok(!/Cerrar modales abasto al click fuera/.test(PANEL));
});

test('la regla queda escrita donde se la va a leer', () => {
  assert.match(CLAUDE, /### CUANDO HAY QUE ABRIR ALGO, ABRE UNA VENTANA/);
  assert.match(CLAUDE, /### UN MODAL NO SE CIERRA AL CLIC AFUERA/);
});
