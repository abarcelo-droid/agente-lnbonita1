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

// ── 4 · LA LUPA ────────────────────────────────────────────────────────────
//
// Pablo, 2/9/2026: «podés agregarle una lupita para buscar; por ejemplo poner Flete
// y que busque todo lo que sea relativo a flete y lo resalte, para encontrarlo más
// fácil». El manual se lee entero la primera vez y después se CONSULTA: el que
// vuelve ya sabe qué busca.

test('el manual se puede buscar, y lo encontrado se resalta', () => {
  assert.match(PANEL, /id="sg-manual-q"/);
  assert.match(PANEL, /oninput="sgManualBuscar\(this\.value\)"/);
  const i = PANEL.indexOf('function sgManualBuscar(q){');
  assert.ok(i > 0, 'no existe el buscador');
  const b = PANEL.slice(i, i + 2600);
  // Se camina por los NODOS DE TEXTO. Reemplazar sobre el string de etiquetas
  // parte un atributo al medio y rompe la página.
  assert.match(b, /if \(h\.nodeType === 3\)/);
  assert.match(b, /createElement\('mark'\)/);
  assert.ok(!/innerHTML\s*=\s*[^;]*replace\(/.test(b), 'está reemplazando sobre el HTML');
});

test('lo que no viene al caso se apaga, no se esconde', () => {
  // Esconderlo deja al que busca «flete» con tres renglones sueltos y sin saber en
  // qué parte del circuito está parado.
  const i = PANEL.indexOf('function sgManualBuscar(q){');
  const b = PANEL.slice(i, i + 2600);
  assert.match(b, /classList\.toggle\('apagado', !el\.querySelector\('mark'\)/);
  assert.match(PANEL, /#sg-manual-modal \.man \.apagado\{opacity:/);
  assert.match(PANEL, /#sg-manual-modal \.man mark\{background:/);
});

test('busca sin tildes, y con una sola letra no pinta media pantalla', () => {
  const i = PANEL.indexOf('function sgManualBuscar(q){');
  const b = PANEL.slice(i, i + 2600);
  assert.match(b, /var t = sgNorm\(String\(q \|\| ''\)\.trim\(\)\);/);
  assert.match(b, /if \(t\.length < 2\)/);
  // Y dice cuántas encontró, o que no hay nada: una búsqueda sin respuesta que no
  // dice nada parece un error de la pantalla.
  assert.match(b, /No hay nada sobre/);
});

test('sgNorm no cambia el largo del texto, o el resaltado cae corrido', () => {
  // El resaltado usa las posiciones del texto normalizado sobre el original: si
  // sgNorm sacara o agregara letras, el <mark> caería en el lugar equivocado.
  const i = PANEL.indexOf('function sgNorm(s){');
  assert.ok(i > 0);
  const src = PANEL.slice(i, PANEL.indexOf('\n}', i) + 2);
  // eslint-disable-next-line no-new-func
  const f = new Function(src + '; return sgNorm;')();
  for (const t of ['flete', 'liquidación', 'piña', 'año', 'ÓRDENES', 'José Ñandú']) {
    assert.equal(f(t).length, t.length, 'sgNorm cambia el largo de: ' + t);
  }
});

test('la búsqueda arranca limpia cada vez que se abre', () => {
  // La de la vez pasada no tiene por qué seguir puesta.
  const i = PANEL.indexOf('function sgManualAbrir(clave){');
  assert.match(PANEL.slice(i, i + 700), /eid\('sg-manual-q'\)\.value = '';/);
});

// ── 5 · LA RENTABILIDAD ESTIMADA ───────────────────────────────────────────
//
// Pablo, 2/9/2026: «en nueva OC debemos poner Rentabilidad Estimada para que
// complete el comprador. Primero porque más adelante vamos a poner algún tipo de
// traba para que órdenes superiores a X pesos requieran autorización. Y además para
// hacer un seguimiento de si los compradores están o no forecasteando bien. Al
// poner 10%, automáticamente necesito que nos calcule la venta estimada también».

test('el campo existe, va en % y se manda al guardar', () => {
  assert.match(PANEL, /<label>Rentabilidad estimada<\/label>/);
  assert.match(PANEL, /id="sg-oc-rent"/);
  assert.match(PANEL, /sobre el costo/);
  const i = PANEL.indexOf('function sgOcGuardar(){');
  assert.match(PANEL.slice(i, i + 3000),
    /rentabilidad_estimada:\(eid\('sg-oc-rent'\)\.value!==''\?Number\(eid\('sg-oc-rent'\)\.value\):null\)/);
});

test('la venta estimada se calcula sola, sobre el costo', () => {
  // «Al poner 10%, automáticamente necesito que nos calcule la venta estimada
  // también (obviamente en función al costo)» — Pablo.
  const i = PANEL.indexOf('function sgOcVentaEstimada(costo, kg, hayPrecio){');
  assert.ok(i > 0, 'no se calcula la venta estimada');
  const b = PANEL.slice(i, i + 1800);
  assert.match(b, /var venta = costo \* \(1 \+ pct \/ 100\);/);
  // Y el precio POR KILO, que es la unidad en la que se vende.
  assert.match(b, /var porKg = \(kg > 0\) \? \(venta \/ kg\) : null;/);
  assert.match(b, /por kilo/);
  // Se dispara sola al escribir y al cambiar los ítems.
  assert.match(PANEL, /id="sg-oc-rent"[\s\S]{0,200}oninput="sgOcTotales\(\)"/);
});

test('estima sobre el NETO cuando se discrimina IVA', () => {
  // El IVA no es costo: se recupera. Estimar sobre el bruto sería pronosticar
  // margen sobre plata que vuelve.
  const i = PANEL.indexOf('function sgOcTotales(){');
  const b = PANEL.slice(i, i + 4200);
  assert.match(b, /sgOcVentaEstimada\(disc \? tNeto : tBruto, tk, true\);/);
  // Y esta escrito por que: el IVA se recupera, no es costo.
  assert.match(b, /estimar sobre plata que vuelve/);
});

test('con precio abierto lo dice, y no inventa un número', () => {
  const i = PANEL.indexOf('function sgOcVentaEstimada(costo, kg, hayPrecio){');
  const b = PANEL.slice(i, i + 1800);
  assert.match(b, /todavía no hay costo/);
  assert.match(b, /la rentabilidad queda anotada igual/);
  // Y si se estima cero o menos, se avisa: es una respuesta válida pero rara.
  assert.match(b, /Estás estimando que esta orden no deja nada/);
});

test('el servidor la guarda, y acota lo que no tiene sentido', () => {
  const DB = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');
  assert.match(DB, /addCol\('sg_oc',\s+'rentabilidad_estimada', 'REAL'\)/);
  const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
  // Un −200% o un 5.000% son un dedo que se resbaló: ensucian el seguimiento.
  assert.match(SG, /Math\.max\(-100, Math\.min\(1000, rEst\)\)/);
  // Y cero es una respuesta, no «sin contestar».
  assert.match(SG, /const rentabilidadEstimada = \(rEst == null\) \? null :/);
  assert.match(SG, /documenta,\r?\n\s*rentabilidad_estimada\)/);
});

test('y no se arrastra de la orden anterior', () => {
  // El pronóstico de otra compra guardado como si fuera el de ésta arruina
  // justamente el seguimiento para el que se pide.
  assert.match(PANEL, /eid\('sg-oc-rent'\)\.value='';/);
});

test('LA REGLA: el campo nuevo ya está en el manual, con su versión', () => {
  // Es el primer cambio después de escribir la regla. Si esto no estuviera, la
  // regla habría nacido incumplida.
  const m = manualDe('oc');
  assert.ok(m.includes('Rentabilidad estimada'), 'el campo nuevo no está en el manual');
  assert.match(m, /<span class="ver">V992<\/span>/);
  assert.match(m.replace(/\s+/g, ' '), /Se pide la <b>rentabilidad estimada<\/b> al armar/);
  assert.match(m.replace(/\s+/g, ' '), /El manual tiene <b>buscador<\/b>/);
});
