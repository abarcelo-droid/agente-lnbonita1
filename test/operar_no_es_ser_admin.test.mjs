// ══ OPERAR NO ES SER ADMIN ═════════════════════════════════════════════════
//
// Pablo, 27/8/2026: «Camila quiso cargar una Orden de Compra pero sólo la habilitó
// siendo ADM. Eso no está bien: si tiene permiso para operar en el menú, tiene
// permiso para cargar una orden de compra. Lo mismo pasa con el resto: no hace
// falta ser ADM, si no nadie va a poder operar». Y después: «no es sólo Camila,
// son TODOS los usuarios que tengan permiso para operar».
//
// La regla ya estaba escrita en CLAUDE.md y se estaba violando en 86 endpoints:
// requireAdmin es para PARAMETRIZAR —dar de alta una cuenta bancaria, elegir el
// asiento modelo—; el trabajo del día va con requireAuth y el nivel lo decide
// exigirNivel mirando la URL.
//
// LA TRAMPA QUE ESTE TEST CUIDA: pasar algo a requireAuth NO lo deja controlado
// por sí solo. exigirNivel resuelve el módulo mirando la URL contra
// ensure_api_prefijos.js; si la URL no matchea ningún prefijo, modulosDeRuta
// devuelve vacío y exigirNivel hace `return next()` SIN CONTROLAR NADA. O sea: un
// endpoint sin prefijo declarado que se pase a requireAuth queda abierto a
// cualquiera con sesión — peor que el problema que veníamos a resolver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (p) => fs.readFileSync(path.join(RAIZ, p), 'utf8');
const PRE = leer('src/servicios/ensure_api_prefijos.js');
const SG = leer('src/rutas/sg.js');

// La tabla de prefijos de ESCRITURA, tal como la lee el arranque.
function prefijosEscritura() {
  const i = PRE.indexOf('const PREFIJOS = [');
  assert.ok(i > 0);
  const fin = PRE.indexOf('\n];', i);
  const out = [];
  for (const m of PRE.slice(i, fin).matchAll(/\[\s*'([^']+)',\s*'([^']+)'\s*\]/g)) {
    for (const p of m[2].split(',').map((x) => x.trim()).filter(Boolean)) {
      out.push({ modulo: m[1], prefijo: '/api/' + p.replace(/^\/*(api\/)?/i, '').replace(/\/+$/, '').toLowerCase() });
    }
  }
  return out;
}

// La MISMA comparación que permisos.js: por segmento completo, no startsWith pelado.
const cubre = (p, url) => url === p || url.startsWith(p + '/');
const tienePrefijo = (url) => prefijosEscritura().some((e) => cubre(e.prefijo, url.toLowerCase()));

// Todas las escrituras de los routers de San Gerónimo, con su middleware.
function escrituras() {
  const out = [];
  for (const [arch, base] of [['sg.js', '/api/sg'], ['sg_ventas.js', '/api/sg/ventas'],
    ['sg_tesoreria.js', '/api/sg/tesoreria'], ['sg_contable.js', '/api/sg/contable']]) {
    let src;
    try { src = leer('src/rutas/' + arch); } catch (_) { continue; }
    for (const m of src.matchAll(/router\.(post|put|patch|delete)\('([^']+)',\s*([^,)]+)/g)) {
      const url = (base + m[2]).replace(/:[a-zA-Z_]+(\([^)]*\))?/g, '9');
      out.push({ arch, metodo: m[1], ruta: base + m[2], url, guarda: m[3].trim() });
    }
  }
  return out;
}

// ── EL CASO QUE REPORTÓ PABLO ──────────────────────────────────────────────
test('cargar una orden de compra ya no pide ser administrador', () => {
  assert.match(SG, /router\.post\('\/oc', requireAuth,/);
  assert.ok(!/router\.post\('\/oc', requireAdmin,/.test(SG));
});

test('y el circuito del día completo tampoco', () => {
  // Recibir el camión, corregir la orden, cargar un gasto, valorizar el flete,
  // tomar un pedido. Todo eso esperaba al dueño.
  for (const r of [
    "router.post('/recepciones', sgUpload.array('fotos', 40), requireAuth",
    "router.put('/oc/:id', requireAuth",
    "router.post('/oc/:id/completar', requireAuth",
    "router.post('/oc/:id/reabrir', requireAuth",
    "router.post('/gastos-directos', requireAuth",
    "router.put('/gastos-directos/:id', requireAuth",
    "router.post('/gastos-globales', requireAuth",
    "router.post('/gastos-servicio/valorizar', requireAuth",
    "router.post('/fletes-entrada/:recepcionId/valorizar', requireAuth",
    "router.post('/pedidos', requireAuth",
    "router.post('/productos', requireAuth",
    "router.post('/familias', requireAuth",
    "router.post('/especies', requireAuth",
    "router.post('/variedades', requireAuth",
  ]) {
    assert.ok(SG.includes(r), 'sigue pidiendo admin: ' + r);
  }
});

// ── LO QUE NO SE ABRIÓ, Y ESTÁ BIEN ────────────────────────────────────────
test('parametrizar sigue siendo del dueño', () => {
  // Dar de alta una cuenta bancaria, elegir el asiento modelo, tocar la config
  // impositiva o el plan de cuentas define CÓMO funciona el sistema.
  const TES = leer('src/rutas/sg_tesoreria.js');
  assert.match(TES, /router\.post\('\/cuentas', requireAdmin/);
  assert.match(TES, /router\.put\('\/cuentas\/:id\/usuarios', requireAdmin/);
  assert.match(SG, /router\.put\('\/factura-mercaderia\/modelo', requireAdmin/);
  assert.match(SG, /router\.put\('\/flete\/modelo', requireAdmin/);
  assert.match(SG, /router\.put\('\/config', requireAdmin/);
  // Y borrar los datos de prueba, que es lo más destructivo que hay.
  assert.match(SG, /router\.post\('\/limpieza\/todo\/borrar', requireAdmin/);
});

test('los cuatro maestros que monta la misma función se abrieron', () => {
  // Los cuatro los monta montarCRUD. La primera pasada dejó cliente y proveedor en
  // admin —llevan CUIT, categoría fiscal y límite de crédito— y Pablo lo revisó el
  // 27/8/2026: «sí, abrilo a nivel operar». El comercial que toma un pedido de un
  // cliente nuevo, o el que recibe un camión de un proveedor que nunca vino, no
  // puede quedarse esperando.
  //
  // No quedan abiertos: el nivel los sigue mirando contra sg-catalogo. Lo que se
  // sacó es la exigencia de ser el DUEÑO, no el control.
  assert.match(SG, /const escribir = opts\.operativo \? requireAuth : requireAdmin;/);
  for (const m of ['envases', 'presentaciones', 'proveedores', 'clientes']) {
    const j = SG.indexOf("montarCRUD('" + m + "'");
    assert.ok(j > 0, m);
    assert.match(SG.slice(j, j + 1200), /operativo: true/, m + ' quedó pidiendo admin');
  }
});

// ── LA TRAMPA: SIN PREFIJO NO HAY CONTROL ──────────────────────────────────
test('TODO lo que se abrió tiene su prefijo declarado', () => {
  // Es la regla que hace que esto sea seguro. Sin prefijo, exigirNivel hace
  // return next() y el endpoint queda abierto a cualquiera con sesión.
  const sin = escrituras()
    .filter((e) => e.guarda === 'requireAuth' || e.guarda.startsWith('sgUpload'))
    .filter((e) => !tienePrefijo(e.url))
    .map((e) => e.metodo.toUpperCase() + ' ' + e.ruta);
  assert.deepEqual(sin, [], 'quedaron escrituras con requireAuth y SIN prefijo declarado');
});

test('el prefijo del flete de entrada quedó declarado', () => {
  // Era el único operativo que no se podía abrir: sin él, valorizar un flete
  // —que graba un asiento y genera deuda— quedaba sin ningún control.
  assert.match(PRE, /sg\/cooperativas,sg\/fletes-entrada/);
  assert.ok(tienePrefijo('/api/sg/fletes-entrada/9/valorizar'));
  // Y de paso cierra el preview del asiento, que ya salía con requireAuth.
  assert.ok(tienePrefijo('/api/sg/fletes-entrada/asiento-preview'));
});

test('la comparación es por SEGMENTO COMPLETO, no startsWith pelado', () => {
  // Si el test usara startsWith, 'sg/oc' cubriría 'sg/ocupacion' y daría por
  // controlado algo que no lo está.
  assert.equal(cubre('/api/sg/oc', '/api/sg/oc'), true);
  assert.equal(cubre('/api/sg/oc', '/api/sg/oc/9/anular'), true);
  assert.equal(cubre('/api/sg/oc', '/api/sg/ocupacion'), false);
  assert.equal(cubre('/api/sg/despachos', '/api/sg/despachos-pendientes'), false);
});

// ── QUE NO VUELVA ──────────────────────────────────────────────────────────
test('quedan menos de 60 escrituras pidiendo admin', () => {
  // Eran 86. Este número no tiene que volver a subir sin que alguien lo decida:
  // cada requireAdmin nuevo sobre una acción operativa vuelve a dejar a la gente
  // sin poder trabajar, que es lo que Pablo reportó.
  const n = escrituras().filter((e) => e.guarda === 'requireAdmin').length;
  assert.ok(n <= 60, 'subió a ' + n + ': revisá si alguno es trabajo del día');
});
