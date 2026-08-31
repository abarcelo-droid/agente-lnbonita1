// ══ BUSCAR SIN TILDES ══════════════════════════════════════════════════════
//
// Pablo, 27/8/2026: «en el maestro de productos, si escribo melon no me figura
// nada; si escribo melón sí. Evitemos los tildes para no complicar. Y podríamos
// revisar todas las listas de búsqueda».
//
// Nadie escribe los acentos cuando busca, y el que carga el producto sí los pone.
// Así que la lista se vaciaba y parecía que el producto no existía — que es peor
// que no encontrarlo: hace pensar que hay que darlo de alta otra vez.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

function fn(nombre) {
  const i = PANEL.indexOf('function ' + nombre + '(');
  assert.ok(i > 0, 'no encontré ' + nombre);
  let d = 0, j = PANEL.indexOf('{', i);
  for (; j < PANEL.length; j++) {
    if (PANEL[j] === '{') d++;
    else if (PANEL[j] === '}') { d--; if (d === 0) { j++; break; } }
  }
  return new Function(PANEL.slice(i, j) + '; return ' + nombre + ';')();
}

const norm = fn('sgNorm');

// ── EL CASO DE PABLO ───────────────────────────────────────────────────────
test('«melon» encuentra «Melón»', () => {
  assert.equal(norm('Melón'), 'melon');
  assert.equal(norm('melon'), 'melon');
  assert.ok(norm('Melón').indexOf(norm('melon')) >= 0);
});

test('y al revés también: «melón» encuentra «Melon»', () => {
  // El que carga a veces NO pone el acento. Si sólo se normalizara un lado, el
  // problema se daría vuelta en vez de resolverse.
  assert.ok(norm('Melon').indexOf(norm('melón')) >= 0);
});

test('las cinco vocales y las mayúsculas', () => {
  assert.equal(norm('ÁÉÍÓÚ'), 'aeiou');
  assert.equal(norm('áéíóú'), 'aeiou');
  assert.equal(norm('Manzana Fují'), 'manzana fuji');
  assert.equal(norm('DURAZNO'), 'durazno');
});

test('LA Ñ NO SE TOCA: es una letra, no una n con algo encima', () => {
  // Si se le sacara el acento, «piña» pasaría a ser «pina» y ahí sí se
  // encontrarían cosas que no son. Es una letra propia del idioma.
  assert.equal(norm('Piña'), 'piña');
  assert.equal(norm('NIÑO'), 'niño');
  assert.ok(norm('Piña').indexOf(norm('piña')) >= 0);
  assert.ok(norm('Piña').indexOf('pina') < 0, 'la ñ no puede volverse n');
});

test('la diéresis sí, que es un acento', () => {
  assert.equal(norm('Güemes'), 'guemes');
});

test('nulo, vacío y números no rompen', () => {
  assert.equal(norm(null), '');
  assert.equal(norm(undefined), '');
  assert.equal(norm(''), '');
  assert.equal(norm(0), '0');
  assert.equal(norm(123), '123');
});

// ── DÓNDE QUEDÓ APLICADO ───────────────────────────────────────────────────
test('una sola definición: no otra copia más', () => {
  // Ya había cuatro normalizadores en este archivo, cada uno en su módulo. Éste
  // es el de las búsquedas de San Gerónimo, y es uno: si hubiera dos, habría
  // pantallas que encuentran el melón y otras que no.
  assert.equal((PANEL.match(/function sgNorm\(/g) || []).length, 1);
});

test('el filtro de texto de TODOS los maestros — el caso reportado', () => {
  // Es el que usa la grilla de productos, familias, especies, variedades,
  // envases, clientes y proveedores.
  assert.match(PANEL, /if \(c\.filtro==='texto'\)\{ var q = sgNorm\(fv\); rows = rows\.filter\(function\(r\)\{ return sgNorm\(sgGridVal\(c,r\)\)\.indexOf\(q\) >= 0; \}\); \}/);
});

test('el buscador de clientes y proveedores', () => {
  const i = PANEL.indexOf('var pintar = function(){');
  const b = PANEL.slice(i, i + 1800);
  assert.match(b, /var q = sgNorm\(String\(inp\.value \|\| ''\)\.trim\(\)\)/);
  assert.match(b, /return sgNorm\(x\)\.indexOf\(q\) >= 0;/);
  // Y las dos listas que arman el desplegable escondido.
  // El 4º parámetro es el recorte opcional del padrón (lo usa la solapa de cadenas).
  // La búsqueda sigue siendo la misma: sgNorm sobre lo tipeado, y sgNorm sobre cada
  // nombre — se busca "gerónimo" escribiendo "geronimo".
  assert.match(PANEL, /function sgCliOpts\(query, sel, blank, filtro\)\{\s*var q=sgNorm/);
  assert.match(PANEL, /var a=sgNorm\(c\.nombre_comercial\), r=sgNorm\(c\.razon_social\)/);
  assert.match(PANEL, /return sgNorm\(x\)\.indexOf\(q\) >= 0; \}\);/);
});

test('el selector de producto de la orden de compra', () => {
  const i = PANEL.indexOf('function sgOcBuscar(i, q){');
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /var ql = sgNorm\(String\(q\|\|''\)\.trim\(\)\)/);
  assert.match(b, /var hay = sgNorm\(sgOcProdLabel\(p\)\)/);
});

test('el selector de mercadería de pedidos, remitos y facturación', () => {
  const i = PANEL.indexOf('function sgIPRenderList(key){');
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /q=sgNorm\(st\.q\)/);
  assert.match(b, /return sgNorm\(String\(p\.nombre\|\|''\)/);
});

test('y las listas de recepciones, cuenta corriente, fletes y cheques', () => {
  // «Revisemos todas las listas de búsqueda».
  for (const p of [
    /return sgNorm\(\(x\.partida\|\|''\)/,                          // recepciones
    /return !q \|\| sgNorm\(sgCcClNombre\(c\)\)\.indexOf\(q\) >= 0;/, // CC clientes
    /return sgNorm\(\(x\.partida \|\| ''\) \+ ' ' \+ \(x\.oc_numero/,  // fletes de entrada
    /return sgNorm\(\(c\.cliente_nombre \|\| ''\)/,                   // cheques en cartera
  ]) {
    assert.match(PANEL, p, 'falta normalizar: ' + p);
  }
});

test('los DOS lados se normalizan, no sólo lo escrito', () => {
  // Normalizar sólo el query no arregla nada: lo cargado sigue teniendo el acento
  // y la comparación falla igual. Es el error fácil de este arreglo.
  for (const q of [
    /var q = sgNorm\(String\(\(eid\('sgfe-q'\) \|\| \{\}\)\.value \|\| ''\)\.trim\(\)\)/,
    /var q = sgNorm\(\(\(eid\('cb-ct-q'\) \|\| \{\}\)\.value \|\| ''\)\.trim\(\)\)/,
  ]) {
    assert.match(PANEL, q, 'quedó un query sin normalizar: ' + q);
  }
  // Y que no queden restos del toLowerCase viejo en esas mismas búsquedas.
  assert.ok(!/\(x\.numero_remito_proveedor\|\|''\)\)\.toLowerCase\(\)/.test(PANEL));
  assert.ok(!/\(c\.nro_cheque \|\| ''\)\)\.toLowerCase\(\)/.test(PANEL));
});

test('la eñe se protege con una secuencia de escape, no con un carácter invisible', () => {
  // La primera versión usó un carácter de control LITERAL, que en el archivo no se
  // ve: cualquier copiado o reencodeo lo pierde y la eñe deja de estar protegida sin
  // que nada avise. Tiene que estar escrito como escape, a la vista.
  const i = PANEL.indexOf('function sgNorm(s){');
  const b = PANEL.slice(i, i + 900);
  const esc = String.fromCharCode(92) + 'u' + "0001";
  assert.ok(b.includes(esc), 'el marcador tiene que ser un escape visible, no un carácter');
  // Y que no quede ningún carácter de control suelto en TODO el archivo. La clase se
  // arma por código para que este test no traiga uno adentro.
  const control = new RegExp(String.fromCharCode(1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15)
    .split('').map(function(c){ return c; }).join('|'), 'g');
  assert.equal((PANEL.match(control) || []).length, 0,
    'quedó un carácter de control invisible en panel.html');
});
