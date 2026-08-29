// ══ EL IMPORTE DEL FLETE, SÓLO CUANDO ES PLATA NUESTRA ═════════════════════
//
// Pablo, 28/8/2026: «si el vendedor paga el flete no hace falta cargar los datos
// de importes ni nada porque no nos interesa el costo».
//
// Con el flete del productor, San Gerónimo no le paga a ningún fletero y el
// monto no entra a ningún lado: el campo decía «informativo» y pedía un número
// que nadie iba a usar.
//
// PERO NO ES «TODO FLETE DEL VENDEDOR». Cuando lo ADELANTA San Gerónimo el monto
// sí hace falta: se le paga al fletero y se le recupera al productor de su
// liquidación. Sin el monto no hay nada que recuperar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');

// La regla real del panel, sin inyectarle nada.
function cargarRegla() {
  const i = PANEL.indexOf('function sgOcFletePideImporte(cargo, quien){');
  assert.ok(i > 0, 'no existe sgOcFletePideImporte');
  const src = PANEL.slice(i, PANEL.indexOf('\n}', i) + 2);
  // eslint-disable-next-line no-new-func
  return new Function(src + '; return sgOcFletePideImporte;')();
}
const pide = cargarRegla();

// ── LA REGLA ───────────────────────────────────────────────────────────────

test('el flete del productor NO pide importe', () => {
  // Es el caso que reportó: San Gerónimo no toca plata, el monto no entra al
  // costo ni a la liquidación y no aparece en la bandeja de fletes.
  assert.equal(pide('vendedor', 'productor'), false);
});

test('pero el que ADELANTA San Gerónimo sí', () => {
  // Se le paga al fletero y se le recupera al productor de su liquidación: sin
  // el monto no hay nada que recuperar.
  assert.equal(pide('vendedor', 'san_geronimo'), true);
});

test('y el del comprador también: es gasto nuestro y entra al costo', () => {
  assert.equal(pide('comprador', 'productor'), true);
  assert.equal(pide('comprador', ''), true);
});

test('sin flete no se pregunta nada', () => {
  assert.equal(pide('', 'productor'), false);
  assert.equal(pide(null, null), false);
});

test('la regla coincide con lo que dice la ayuda de la pantalla', () => {
  // El texto ya explicaba los tres casos; ahora la pantalla se comporta como el
  // texto en vez de pedir un número en el caso que el propio texto llama
  // «no entra al costo de la partida».
  assert.match(PANEL, /'vendedor\|productor': '<b>Lo paga el productor\.<\/b>/);
  assert.match(PANEL, /no entra al costo de la partida<\/b>/);
  assert.match(PANEL, /'vendedor\|san_geronimo': '<b>Lo adelanta San Gerónimo y se le recupera al productor\./);
});

test('y con lo que hace el costo del lote, que es de donde sale la regla', () => {
  // recalcCostoLote excluye del costo el flete a cargo del vendedor — los dos
  // casos— pero el adelantado igual se paga y se recupera.
  assert.match(SG, /AND NOT \(g\.tipo_gasto='flete_entrada' AND COALESCE\(o\.flete_a_cargo,''\) = 'vendedor'\)/);
});

// ── LA PANTALLA ────────────────────────────────────────────────────────────

test('los importes se esconden ENTEROS, no a medias', () => {
  // Dejar el «cómo se pactó» solo, sin monto, es peor que no mostrar nada.
  const i = PANEL.indexOf('function sgOcFleteCargo(){');
  const b = PANEL.slice(i, i + 1800);
  for (const id of ['sg-oc-flete-modo-wrap', 'sg-oc-flete-total-wrap', 'sg-oc-flete-cant-wrap',
                    'sg-oc-flete-pu-wrap', 'sg-oc-flete-iva-wrap']) {
    assert.ok(b.includes("'" + id + "'"), 'falta esconder ' + id);
  }
  assert.match(b, /e\.style\.display = pide \? '' : 'none';/);
});

test('y los envoltorios existen en el HTML', () => {
  assert.match(PANEL, /id="sg-oc-flete-modo-wrap"/);
  assert.match(PANEL, /id="sg-oc-flete-iva-wrap"/);
});

test('al volver a mostrarlos manda el «cómo se pactó»', () => {
  // Por bulto no se pide la cantidad y por total no se pide el precio unitario:
  // mostrarlos todos juntos rompería esa regla.
  const i = PANEL.indexOf('function sgOcFleteCargo(){');
  const b = PANEL.slice(i, i + 1800);
  assert.match(b, /if \(pide\) \{[\s\S]{0,200}sgOcFleteModo\(\);/);
});

test('cuando se esconden, se LIMPIAN', () => {
  // Un monto escrito antes de cambiar la opción se guardaría como un flete que
  // nadie va a pagar, y aparecería en el costo o en la liquidación.
  const i = PANEL.indexOf('function sgOcFleteCargo(){');
  const b = PANEL.slice(i, i + 1800);
  assert.match(b, /\['sg-oc-flete-monto','sg-oc-flete-cant','sg-oc-flete-pu'\]/);
  assert.match(b, /if \(iva\) iva\.checked = false;/);
  assert.match(b, /if \(c\) c\.textContent = '';/);
});

// ── Y NO SE GUARDA ─────────────────────────────────────────────────────────

test('el mismo cerrojo en lo que se manda al servidor', () => {
  // La pantalla ya los limpia, pero si un valor viejo quedara escrito por
  // cualquier camino, igual no se guarda.
  const i = PANEL.indexOf('flete_a_cargo:eid(');
  const b = PANEL.slice(i, i + 2200);
  assert.match(b, /flete_monto:\(sgOcFletePideImporte\(/);
  assert.match(b, /flete_modalidad:\(sgOcFletePideImporte\(/);
  assert.match(b, /flete_precio_unit:\(sgOcFletePideImporte\(/);
  assert.match(b, /!sgOcFletePideImporte\([\s\S]{0,90}\? null/);
  assert.match(b, /if\(!sgOcFletePideImporte\([\s\S]{0,90}\) return null;/);
});

test('lo que SÍ se sigue guardando: a cargo de quién y quién lo paga', () => {
  // Eso no es un importe: es cómo se pactó la compra, y define los tres
  // circuitos. Sin eso no se sabría ni que hay flete.
  const i = PANEL.indexOf('flete_a_cargo:eid(');
  const b = PANEL.slice(i, i + 2200);
  assert.match(b, /flete_a_cargo:eid\('sg-oc-flete-cargo'\)\.value\|\|null,/);
  assert.match(b, /flete_pagado_por:\(eid\('sg-oc-flete-cargo'\)\.value==='vendedor'/);
});
