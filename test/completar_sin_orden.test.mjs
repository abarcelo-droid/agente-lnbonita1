// ══ EL BOTÓN «COMPLETAR» DE LO QUE ENTRÓ SIN ORDEN ═════════════════════════
//
// Pablo, 3/9/2026: «fijate que cuando se recibe mercadería sin orden de compra
// no funciona el botón de completar».
//
// Y no funcionaba de la peor manera: NO PASABA NADA. Ni un cartel, ni un error en
// la consola. Se apretaba y el modal no abría.
//
// LA CAUSA. sgSoOpen buscaba la orden en SG_SO.filas, que la llena sgLoadSinOrden
// —el circuito de la bandeja «Ingresó sin orden»—. Pero esa bandeja dejó de ser
// una solapa: el botón ahora cuelga del listado de Órdenes de Compra, donde
// SG_SO.filas nunca se llenó. El `if (!o) return` se cumplía y ahí terminaba todo.
//
// Es el defecto más caro de los baratos: el comprador aprieta, no pasa nada, y
// concluye que la pantalla está rota. La orden se queda meses sin precio, que es
// justo lo que el botón vino a resolver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const SALTO = String.fromCharCode(13, 10);

// ── Se corre sgSoOpen de verdad, con el mundo simulado ─────────────────────

function abridor({ filasEnCache = [], respuesta = null }) {
  const i = PANEL.indexOf('function sgSoOpen(id){');
  assert.ok(i > 0, 'no existe sgSoOpen');
  // Las dos: sgSoOpen decide de dónde sale la orden, sgSoAbrirCon la pinta.
  const j = PANEL.indexOf('function sgSoAbrirCon(o){');
  assert.ok(j > i, 'no existe sgSoAbrirCon: volvió a estar todo en una función');
  const fin = PANEL.indexOf(SALTO + '}' + SALTO, j) + 3;
  const src = PANEL.slice(i, fin);

  const pedidos = [];
  const avisos = [];
  const hecho = { render: 0, arriba: 0, recargoOC: 0 };
  const SG_SO = { filas: filasEnCache.slice(), sel: null, items: [] };
  const campos = {};
  const eid = (id) => (campos[id] || (campos[id] = { value: '', textContent: '', innerHTML: '' }));

  const entorno = {
    SG_SO,
    eid,
    escH: (x) => String(x == null ? '' : x),
    sgOpts: () => '',
    SG: { cacheCond: [] },
    toast: (m) => avisos.push(m),
    sgSoDocCambio: () => { hecho.render++; },
    sgSoRender: () => { hecho.render++; },
    sgModalArriba: () => { hecho.arriba++; },
    sgLoadOC: () => { hecho.recargoOC++; },
    api: (url) => {
      pedidos.push(url);
      // Los ítems de la orden, que el modal pide siempre al final.
      if (url.indexOf('/items-sin-orden') >= 0) return Promise.resolve({ ok: true, data: [] });
      return Promise.resolve(respuesta || { ok: true, data: [] });
    },
  };
  const nombres = Object.keys(entorno);
  // eslint-disable-next-line no-new-func
  const sgSoOpen = new Function(...nombres, src + SALTO + 'return sgSoOpen;')(
    ...nombres.map((n) => entorno[n]));

  return { sgSoOpen, pedidos, avisos, hecho, SG_SO };
}

const ORDEN = {
  id: 42, numero: 'OC-42', trazabilidad: '0008.03.09.2026.02', fecha_oc: '2026-09-03',
  proveedor_nombre: 'ABRAHAM VICTOR', bultos: 176, documenta: 'factura',
  tipo_precio: 'firme', condicion_pago_id: null, observaciones: '', completada_en: null,
};

// ── 1 · EL BUG ─────────────────────────────────────────────────────────────

test('con la caché vacía —entrando desde Órdenes de Compra— igual abre', async () => {
  // Antes: `if (!o) return;` y no pasaba nada.
  const a = abridor({ filasEnCache: [], respuesta: { ok: true, data: [ORDEN] } });
  a.sgSoOpen(42);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(a.hecho.arriba, 1, 'el modal no se abrió: el botón no hace nada');
  assert.equal(a.SG_SO.sel && a.SG_SO.sel.id, 42, 'no quedó seleccionada la orden');
  // Y los artículos se piden con el ID de la orden. Al partir la función en dos,
  // adentro seguía usando `id` —el parámetro de la otra— y el modal se abría
  // vacío: se ve el encabezado y ni un renglón para ponerle precio.
  assert.ok(a.pedidos.includes('/api/sg/oc/42/items-sin-orden'),
    'los artículos se piden con otra cosa: ' + JSON.stringify(a.pedidos));
});

test('y la va a buscar al servidor, con las ya completadas incluidas', () => {
  // Sin ?todas=1 el servidor devuelve sólo las pendientes: entrando a mirar una
  // que ya se completó, el modal volvería a no abrir.
  const a = abridor({ filasEnCache: [], respuesta: { ok: true, data: [ORDEN] } });
  a.sgSoOpen(42);
  assert.deepEqual(a.pedidos, ['/api/sg/oc/sin-orden?todas=1']);
});

test('si ya la tiene a mano no pide nada', () => {
  // Entrando desde la bandeja, la caché ya está llena: un pedido de más por cada
  // clic sería pagar el arreglo dos veces.
  const a = abridor({ filasEnCache: [ORDEN] });
  a.sgSoOpen(42);
  assert.ok(!a.pedidos.some((u) => u.indexOf('/sin-orden') >= 0), 'pidió la lista teniéndola');
  assert.equal(a.hecho.arriba, 1);
});

test('si la orden ya no está pendiente, lo dice en vez de quedarse mudo', async () => {
  // Alguien la completó o la anuló desde otra pantalla mientras tanto. Quedarse
  // callado es el bug que se está arreglando.
  const a = abridor({ filasEnCache: [], respuesta: { ok: true, data: [] } });
  a.sgSoOpen(42);
  await new Promise((r) => setImmediate(r));
  assert.equal(a.hecho.arriba, 0, 'abrió un modal sin datos');
  assert.match(a.avisos.join(' '), /ya no está pendiente/);
  assert.equal(a.hecho.recargoOC, 1, 'no refrescó el listado, que quedó mintiendo');
});

test('y si el servidor falla tampoco abre el modal en blanco', async () => {
  const a = abridor({ filasEnCache: [], respuesta: { ok: false, error: 'se cayó' } });
  a.sgSoOpen(42);
  await new Promise((r) => setImmediate(r));
  assert.equal(a.hecho.arriba, 0);
  assert.match(a.avisos.join(' '), /ya no está pendiente/);
});

test('no puede llamarse a sí mismo en círculos', async () => {
  // Después de traer la lista se llama a sgSoAbrirCon, NO a sgSoOpen otra vez:
  // con una llamada de vuelta, un servidor que nunca devuelve esa orden deja al
  // navegador pidiéndola para siempre. Que no pueda pasar es mejor que cuidarlo.
  const i = PANEL.indexOf('function sgSoOpen(id){');
  const b = PANEL.slice(i, PANEL.indexOf('function sgSoAbrirCon(o){', i));
  assert.ok(!/sgSoOpen\(/.test(b.slice(b.indexOf('api('))),
    'sgSoOpen se vuelve a llamar a sí mismo después de pedir la lista');
  assert.match(b, /sgSoAbrirCon\(hay\);/);
  // Y una sola vuelta al servidor.
  const a = abridor({ filasEnCache: [], respuesta: { ok: true, data: [] } });
  a.sgSoOpen(42);
  for (let k = 0; k < 5; k++) await new Promise((r) => setImmediate(r));
  assert.equal(a.pedidos.filter((u) => u.indexOf('/sin-orden') >= 0).length, 1);
});

// ── 2 · Y DESPUÉS DE COMPLETARLA, LA CACHÉ NO MIENTE ───────────────────────

test('al guardar se tira la caché, o la próxima abre con datos viejos', () => {
  // sgLoadSinOrden se va sin hacer nada cuando la bandeja no está en pantalla
  // —que es siempre, desde que dejó de ser una solapa—. Sin tirarla, SG_SO.filas
  // se queda diciendo que esta orden sigue pendiente.
  const i = PANEL.indexOf('function sgSoGuardar(){');
  const b = PANEL.slice(i, PANEL.indexOf(SALTO + '}', i));
  assert.match(b, /SG_SO\.filas = \[\];/);
  assert.ok(b.indexOf('SG_SO.filas = [];') < b.indexOf('sgLoadSinOrden();'),
    'se recarga antes de tirar la caché');
  assert.match(b, /sgLoadOC\(\);/);
});

// ── 3 · EL BOTÓN SALE DONDE TIENE QUE SALIR ────────────────────────────────

test('el botón aparece sólo en las retroactivas que están sin completar', () => {
  const i = PANEL.indexOf("acc += '<button class=\"btn bb bs\" onclick=\"sgSoOpen(");
  assert.ok(i > 0, 'no está el botón Completar en el listado de órdenes');
  // Sólo el renglón del if, sin los comentarios de arriba: ahí también está
  // escrita la condición, y el test pasaba aunque el if dijera otra cosa.
  const linea = PANEL.slice(PANEL.lastIndexOf('if (', i), i);
  assert.match(linea, /^if \(o\.modalidad === 'retroactiva' && !o\.completada_en/);
  assert.match(linea, /\(Number\(o\.items_sin_precio\) \|\| 0\) > 0/);
});

test('y el servidor sólo deja completar las retroactivas', () => {
  // El botón se esconde, pero lo que decide es el servidor.
  const i = SG.indexOf("router.post('/oc/:id/completar'");
  assert.ok(i > 0);
  const b = SG.slice(i, SG.indexOf(SALTO + '});', i));
  assert.match(b, /retroactiva/);
});
