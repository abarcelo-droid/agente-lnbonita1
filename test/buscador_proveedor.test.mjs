// ══ EL PROVEEDOR SE BUSCA ESCRIBIENDO, COMO EL CLIENTE ═════════════════════
//
// Pablo, 27/8/2026: «cuando escribimos los proveedores en la OC está raro. Me
// gusta que a medida que vas escribiendo te acorte la lista con los que CONTIENEN
// lo que estás escribiendo. También podemos usarlo para clientes cuando
// facturamos o emitimos remitos».
//
// El de clientes existía; el de proveedores era un desplegable plano con el padrón
// entero adentro, que se recorría a rueda de mouse. Ahora es UN solo control para
// los dos: si fueran dos implementaciones, la del proveedor se quedaría vieja.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

function fn(nombre, deps = {}) {
  const i = PANEL.indexOf('function ' + nombre + '(');
  assert.ok(i > 0, 'no encontré ' + nombre);
  let d = 0, j = PANEL.indexOf('{', i);
  for (; j < PANEL.length; j++) {
    if (PANEL[j] === '{') d++;
    else if (PANEL[j] === '}') { d--; if (d === 0) { j++; break; } }
  }
  const ns = Object.keys(deps);
  return new Function(...ns, PANEL.slice(i, j) + '; return ' + nombre + ';')(...ns.map((k) => deps[k]));
}

const PROVS = [
  { id: 1, razon_social: 'ABRAHAM VICTOR', nombre_comercial: '', cuit: '20-11222333-9' },
  { id: 2, razon_social: 'PUENTE CORDON SA', nombre_comercial: 'Puente', cuit: '30-99887766-1' },
  { id: 3, razon_social: 'FRUTAS DEL VALLE SRL', nombre_comercial: 'Del Valle', cuit: '30-55443322-7' },
];

// ── LA ETIQUETA ────────────────────────────────────────────────────────────
test('el proveedor se muestra por razón social, con el alias al lado si lo tiene', () => {
  const lbl = fn('sgProvLabel');
  assert.equal(lbl(PROVS[0]), 'ABRAHAM VICTOR');
  assert.equal(lbl(PROVS[1]), 'PUENTE CORDON SA  ·  Puente');
  assert.equal(lbl(null), '');
  // Si el alias es el mismo nombre, no se repite.
  assert.equal(lbl({ razon_social: 'ZETA', nombre_comercial: 'zeta' }), 'ZETA');
});

// ── EL FILTRO, CORRIÉNDOLO ─────────────────────────────────────────────────
test('escribiendo se acorta la lista, por CONTIENE', () => {
  // Es lo que pidió Pablo: no «empieza por», sino que contenga.
  const opts = fn('sgProvOpts', {
    sgOcProvOpts: () => PROVS, SG: { cacheProv: PROVS },
    esc: (x) => String(x),
    sgProvLabel: fn('sgProvLabel'),
  });
  const h = opts('cordon', '', '— Elegir —');
  assert.ok(h.includes('PUENTE CORDON SA'));
  assert.ok(!h.includes('ABRAHAM'));
  assert.ok(!h.includes('FRUTAS DEL VALLE'));
});

test('busca también por alias y por CUIT', () => {
  // Uno busca por lo que tiene a mano: a veces el papel sólo trae el CUIT.
  const opts = fn('sgProvOpts', {
    sgOcProvOpts: () => PROVS, SG: { cacheProv: PROVS },
    esc: (x) => String(x), sgProvLabel: fn('sgProvLabel'),
  });
  assert.ok(opts('valle', '', '').includes('FRUTAS DEL VALLE'));      // alias
  assert.ok(opts('99887766', '', '').includes('PUENTE CORDON'));      // CUIT
  assert.ok(!opts('99887766', '', '').includes('ABRAHAM'));
});

test('sin texto están todos, y ordenados', () => {
  const opts = fn('sgProvOpts', {
    sgOcProvOpts: () => PROVS, SG: { cacheProv: PROVS },
    esc: (x) => String(x), sgProvLabel: fn('sgProvLabel'),
  });
  const h = opts('', '', '— Elegir —');
  for (const p of PROVS) assert.ok(h.includes(p.razon_social), p.razon_social);
  assert.ok(h.indexOf('ABRAHAM') < h.indexOf('FRUTAS'));
  assert.ok(h.indexOf('FRUTAS') < h.indexOf('PUENTE'));
});

test('respeta el que ya estaba elegido', () => {
  const opts = fn('sgProvOpts', {
    sgOcProvOpts: () => PROVS, SG: { cacheProv: PROVS },
    esc: (x) => String(x), sgProvLabel: fn('sgProvLabel'),
  });
  assert.match(opts('', 2, ''), /<option value="2" selected>/);
});

test('la orden de compra filtra por categoría, no por el padrón entero', () => {
  // sgOcProvOpts deja sólo las categorías que pueden vender mercadería. El
  // buscador tiene que trabajar sobre ESA lista, no sobre todo el padrón.
  const opts = fn('sgProvOpts', {
    sgOcProvOpts: () => [PROVS[0]], SG: { cacheProv: PROVS },
    esc: (x) => String(x), sgProvLabel: fn('sgProvLabel'),
  });
  const h = opts('', '', '');
  assert.ok(h.includes('ABRAHAM'));
  assert.ok(!h.includes('PUENTE CORDON'), 'se coló uno que la orden no admite');
});

// ── UN SOLO CONTROL PARA LOS DOS ───────────────────────────────────────────
test('cliente y proveedor usan el MISMO buscador', () => {
  // Dos implementaciones de lo mismo terminan diciendo cosas distintas, y la del
  // proveedor —la nueva— es la que se iba a quedar vieja.
  assert.match(PANEL, /function sgBuscador\(selectId, cfg\)\{/);
  assert.match(PANEL, /function sgCliUnico\(selectId\)\{\s*return sgBuscador\(selectId, \{/);
  assert.match(PANEL, /function sgProvUnico\(selectId, fuente\)\{\s*return sgBuscador\(selectId, \{/);
  assert.equal((PANEL.match(/function sgBuscador\(/g) || []).length, 1);
});

test('el buscador CREA el campo de texto si no está', () => {
  // El de clientes exigía un <input> escrito antes en el HTML. El desplegable de
  // proveedores no tenía ninguno: sin esto no se podía montar encima.
  const b = PANEL.slice(PANEL.indexOf('function sgBuscador(selectId, cfg){'), PANEL.indexOf('function sgBuscador(selectId, cfg){') + 1600);
  assert.match(b, /inp = document\.createElement\('input'\)/);
  assert.match(b, /sel\.parentNode\.insertBefore\(inp, sel\)/);
});

test('el <select> se esconde pero sigue existiendo', () => {
  // El resto de la pantalla lee .value y engancha .onchange: si el select se
  // reemplazara, habría que tocar todas las pantallas.
  const i = PANEL.indexOf('function sgBuscador(selectId, cfg){');
  const b = PANEL.slice(i, i + 2600);
  assert.match(b, /sel\.style\.display = 'none'/);
  assert.match(b, /if \(typeof sel\.onchange === 'function'\) sel\.onchange\(\)/);
});

// ── DONDE QUEDÓ MONTADO ────────────────────────────────────────────────────
test('está en la orden de compra, que es lo que reportó Pablo', () => {
  assert.match(PANEL, /eid\('sg-oc-prov'\)\.innerHTML=sgProvOpts\('','','— Elegir —'\);/);
  assert.match(PANEL, /sgProvUnico\('sg-oc-prov'\);/);
  // Y ya no se arma con el desplegable plano de antes.
  assert.ok(!/sg-oc-prov'\)\.innerHTML=sgOpts\(sgOcProvOpts\(\)/.test(PANEL));
});

test('y en las otras pantallas donde se elige un proveedor', () => {
  for (const id of ['sg-retro-prov', 'sg-gd-prov', 'sg-emb-prov']) {
    assert.ok(PANEL.includes("sgProvUnico('" + id + "'"), 'falta en ' + id);
  }
});

test('el cliente ahora también se busca por CUIT', () => {
  // Es lo que suma del lado de clientes: la lista ya se acortaba escribiendo, pero
  // sólo por alias y razón social.
  const i = PANEL.indexOf('function sgCliUnico(selectId){');
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /\[c\.nombre_comercial, c\.razon_social, c\.cuit\]/);
});

test('no quedó una función de montaje que no llame nadie', () => {
  // El de clientes ya tenía una (sgCliUnicoTodos) que no la llama nadie: cada
  // pantalla monta el suyo donde llena el desplegable. No hacía falta una segunda.
  assert.ok(!PANEL.includes('function sgProvUnicoTodos'));
});
