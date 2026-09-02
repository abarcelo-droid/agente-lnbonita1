// ══ EL MANUAL DE CADA MÓDULO, Y LA REGLA QUE LO MANTIENE VIVO ══════════════
//
// Pablo, 2/9/2026: «quiero un pequeño ícono con un "¿cómo se usa?" para que los
// operadores puedan consultar operaciones básicas por ahí. Es importante que sea
// fácil de leer, y que especifiques lo que esperamos de cada campo, con qué otros
// módulos se vincula esa info de cada campo específico y algún significado».
//
// Y la regla:
//
//   «De ahora en más, como REGLA: si modificás algo en el módulo lo agregás al
//    "cómo se usa" con el número de versión, de esa manera si introducimos cambios
//    pueden ver en el nuevo manual cómo usarlo.»
//
// El manual tiene TRES propósitos y sólo uno es documentar. Los otros dos: que el
// operador sepa qué se espera de cada campo sin preguntar, y que desde ahí se
// REVISE si el proceso está bien — un campo que no se puede explicar en una línea
// es un campo que sobra o que está mal pensado.
//
// Este archivo existe para que la regla no dependa de que alguien se acuerde.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const CLAUDE = fs.readFileSync(path.join(RAIZ, 'CLAUDE.md'), 'utf8');
const SIDEBAR = fs.readFileSync(path.join(RAIZ, 'src/sidebar-v2.js'), 'utf8');

// El texto del manual de un módulo, tal como está escrito en el panel.
function manualDe(clave) {
  const i = PANEL.indexOf('SG_MANUAL.' + clave + ' = {');
  assert.ok(i > 0, 'no hay manual para "' + clave + '"');
  const fin = PANEL.indexOf('\r\n};', i);
  assert.ok(fin > i, 'el manual de "' + clave + '" no cierra');
  return PANEL.slice(i, fin);
}

// ── 1 · LA PUERTA ──────────────────────────────────────────────────────────

test('el botón está en Órdenes de Compra y abre su manual', () => {
  assert.match(PANEL, /onclick="sgManualAbrir\('oc'\)">❓ ¿Cómo se usa\?<\/button>/);
  const i = PANEL.indexOf('function sgManualAbrir(clave){');
  assert.ok(i > 0, 'no existe el que lo abre');
  const b = PANEL.slice(i, i + 500);
  assert.match(b, /var m = SG_MANUAL\[clave\];/);
  // Un módulo sin manual todavía lo dice, no abre un modal vacío.
  assert.match(b, /Todavía no hay manual de esta pantalla/);
});

test('el modal está fuera de toda pantalla, o no se puede abrir desde otra', () => {
  // `.sec{display:none}`: un modal adentro de una pantalla sólo se ve desde esa
  // pantalla. Ya nos pasó con los de facturar y recibir liquidación.
  const j = PANEL.indexOf('id="sg-manual-modal"');
  assert.ok(j > 0, 'no existe el modal');
  const abre = PANEL.lastIndexOf('<div', j);
  const pila = [];
  for (const m of PANEL.matchAll(/<div\b[^>]*>|<\/div>/g)) {
    if (m.index >= abre) break;
    if (m[0] === '</div>') pila.pop(); else pila.push(m[0]);
  }
  assert.deepEqual(pila.filter((t) => /class="[^"]*\bsec\b/.test(t)), [],
    'el manual quedó adentro de una pantalla');
  // Y con sg-mod, que es de donde cuelga el formato de los modales de este módulo.
  assert.match(PANEL.slice(abre, j), /class="ab-modal-overlay sg-mod"/);
});

test('uno solo para todos los módulos', () => {
  // Uno por pantalla sería un modal nuevo cada vez y ninguno se actualizaría.
  assert.equal((PANEL.match(/id="sg-manual-modal"/g) || []).length, 1);
  assert.equal((PANEL.match(/function sgManualAbrir\(/g) || []).length, 1);
});

// ── 2 · QUÉ TIENE QUE DECIR ────────────────────────────────────────────────

test('el manual de Órdenes de Compra explica los campos que la pantalla pide', () => {
  // «Especificá lo que esperamos de cada campo» — Pablo. Los campos que decide el
  // que carga la orden tienen que estar; si mañana se agrega uno, este test cae.
  const m = manualDe('oc');
  for (const campo of ['¿Cómo se documenta esta compra?', '¿Cómo se pactó el precio?',
    'Proveedor', 'Comprobante Fiscal', 'Condición de pago', 'Producto y presentación',
    'Cómo se carga: por bulto o por kilo', 'Cantidad estimada', 'Precio',
    'A cargo de / ¿Quién lo paga?']) {
    assert.ok(m.includes(campo), 'al manual le falta el campo: ' + campo);
  }
});

test('y de cada uno dice CON QUÉ SE ENLAZA, que es la mitad del punto', () => {
  // «Con qué otros módulos se vincula esa info de cada campo específico» — Pablo.
  // La mitad de los errores de carga son de alguien que no sabía a dónde iba a
  // parar lo que escribía.
  const m = manualDe('oc');
  const fichas = (m.match(/sgManCampo\(/g) || []).length;
  const ligas = (m.match(/<span class="liga">/g) || []).length
    + (m.match(/sgManCampo\([^)]*?,[^)]*?,[^)]*?['"]/gs) || []).length;
  assert.ok(fichas >= 10, 'el manual tiene menos campos de los que la pantalla pide');
  // Cada ficha lleva su enlace: el tercer argumento de sgManCampo.
  const helper = PANEL.indexOf('function sgManCampo(nombre, espera, liga, ver){');
  assert.ok(helper > 0);
  assert.match(PANEL.slice(helper, helper + 400), /liga \? \('<span class="liga">↔ ' \+ liga/);
  // Y nombra los módulos con los que se cruza: son los que el operador va a abrir.
  // Se junta el texto en una sola línea: las fichas se escriben partidas en
  // varios renglones para que entren, y una frase puede quedar cortada al medio.
  const plano = m.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
  for (const mod of ['Maestros', 'Liquidaciones', 'Gastos Directos',
    'cuenta corriente', 'Diario de IVA']) {
    assert.ok(plano.includes(mod), 'el manual no dice que se enlaza con: ' + mod);
  }
});

test('avisa lo que NO se puede deshacer', () => {
  // El precio firme es la trampa más cara del módulo: se descubre cuando ya está.
  const m = manualDe('oc');
  assert.match(m, /queda FIRME y la orden no se toca/);
  assert.match(m, /anular ese comprobante primero/);
  // Y el peso que manda es el que pesó la balanza, no el del cajón.
  assert.match(m, /El peso que manda es el que pesó la balanza/);
});

// ── 3 · LA REGLA ───────────────────────────────────────────────────────────

test('la regla está escrita donde se lee antes de tocar el repo', () => {
  assert.match(CLAUDE, /SI TOCÁS UN MÓDULO, ACTUALIZÁS SU «¿CÓMO SE USA\?»/);
  assert.match(CLAUDE, /en el mismo commit/);
  assert.match(CLAUDE.replace(/\s+/g, ' '), /Un manual que va una versión atrás es peor que no tenerlo/);
});

test('cada cambio queda anotado con su número de versión', () => {
  // «Con el número de versión, de esa manera si introducimos cambios pueden ver en
  // el nuevo manual cómo usarlo» — Pablo. Sin el número, el manual dice qué hace
  // hoy pero no desde cuándo, y el que lo usó ayer no sabe qué se le movió.
  const m = manualDe('oc');
  assert.match(m, /Qué cambió, y desde cuándo/);
  const versiones = m.match(/<span class="ver">V(\d+)<\/span>/g) || [];
  assert.ok(versiones.length >= 3, 'el manual no lleva el registro de versiones');
});

test('y ninguna versión del manual es mayor que la del panel', () => {
  // Un manual que promete algo que todavía no salió es peor que uno viejo: el
  // operador lo busca en la pantalla y no está.
  const actual = Number((SIDEBAR.match(/const VERSION = 'V(\d+)'/) || [])[1]);
  assert.ok(actual > 0, 'no se pudo leer la versión del panel');
  for (const clave of Object.keys({ oc: 1 })) {
    for (const v of (manualDe(clave).match(/<span class="ver">V(\d+)<\/span>/g) || [])) {
      const n = Number(v.match(/V(\d+)/)[1]);
      assert.ok(n <= actual,
        'el manual de "' + clave + '" cita la V' + n + ' y el panel va en la V' + actual);
    }
  }
});
