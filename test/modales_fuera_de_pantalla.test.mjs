// ══ UN MODAL QUE SE MUDA SE LLEVA SU FORMATO PUESTO ═══════════════════════
//
// 31/8/2026. Los modales de facturar el remito y de recibir la liquidación vivían
// adentro de la pantalla «Remitos pendientes de comprobante». Con `.sec{display:none}`
// eso alcanzaba mientras se abrieran sólo desde ahí; cuando la solapa «Facturación
// Supermercados» empezó a abrirlos desde otra pantalla, el botón corría y no se veía
// nada. Se los sacó al nivel de arriba y eso quedó arreglado.
//
// PERO SE LLEVARON PUESTA OTRA COSA. Al salir de la sección perdieron el ancestro
// `.sg-mod`, y de ese ancestro colgaban dos reglas escritas como DESCENDIENTE:
//
//   .sg-mod .sgr-confirm{…;display:none}   ← la ÚNICA que esconde el cartel
//   .sg-mod .sgr-card    {…}               ← el formato de todos los campos
//
// Sin la primera, el cartel de confirmación queda visible SIEMPRE. Y como el código
// se confiaba de ese display:none —sólo le sacaba la clase, nunca el contenido—, el
// modal se abría con el CAE y el botón «Ver comprobante» de la factura ANTERIOR: se
// factura a Coto, se cierra, se abre el remito de Jumbo y ahí está el comprobante de
// Coto, con su botón funcionando. El que lo mira cree que ya la emitió y no la emite,
// o la emite dos veces.
//
// Este archivo prueba las tres cosas que lo evitan:
//   1. Los modales están FUERA de toda pantalla (para que se abran desde cualquiera).
//   2. Y SIN EMBARGO conservan `sg-mod`, así que las reglas que los formatean —y la
//      que esconde el cartel— los siguen alcanzando.
//   3. El cartel se LIMPIA, no sólo se esconde: el estado del modal no puede depender
//      de que una hoja de estilos siga alcanzándolo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const MODALES = ['sg-fac-modal', 'sg-liqrec-modal'];

// Recorre las etiquetas div y devuelve la pila de ancestros abiertos en `pos`.
function ancestros(pos) {
  const pila = [];
  for (const m of PANEL.matchAll(/<div\b[^>]*>|<\/div>/g)) {
    if (m.index >= pos) break;
    if (m[0] === '</div>') pila.pop();
    else pila.push(m[0]);
  }
  return pila;
}

function abreDe(id) {
  const j = PANEL.indexOf('id="' + id + '"');
  assert.ok(j > 0, 'no existe ' + id);
  return PANEL.lastIndexOf('<div', j);
}

// ── 1 · FUERA DE TODA PANTALLA ─────────────────────────────────────────────

test('los modales no están adentro de ninguna pantalla', () => {
  // Una pantalla que no está abierta está escondida, y todo lo que tiene adentro
  // también: un modal ahí sólo se puede abrir desde su propia pantalla.
  for (const id of MODALES) {
    const a = ancestros(abreDe(id));
    const sec = a.filter((t) => /class="[^"]*\bsec\b/.test(t));
    assert.deepEqual(sec, [], id + ' quedó adentro de una pantalla');
  }
});

// ── 2 · PERO CON SU MÓDULO PUESTO ──────────────────────────────────────────

test('y sin embargo conservan sg-mod, que es de donde cuelga su formato', () => {
  // Las reglas están escritas como DESCENDIENTE de .sg-mod. Sacarles el ancestro sin
  // reponer la clase les saca el formato de todos los campos y —lo grave— la única
  // regla que esconde el cartel del comprobante.
  for (const id of MODALES) {
    const a = ancestros(abreDe(id));
    const propia = PANEL.slice(abreDe(id), PANEL.indexOf('>', abreDe(id)));
    const tiene = a.some((t) => /class="[^"]*\bsg-mod\b/.test(t))
      || /class="[^"]*\bsg-mod\b/.test(propia);
    assert.ok(tiene, id + ' se quedó sin sg-mod: pierde el formato y el cartel queda a la vista');
  }
});

test('la regla que esconde el cartel sigue siendo de descendiente, y es la única', () => {
  // Si mañana alguien la reescribe sin el ancestro, este test deja de tener sentido y
  // hay que revisarlo. Y si aparece OTRA regla para .sgr-confirm, saber cuál manda
  // deja de ser obvio.
  const reglas = (PANEL.match(/[^{}\r\n]*\.sgr-confirm[^{}\r\n]*\{/g) || []);
  assert.deepEqual(reglas.map((r) => r.trim()),
    ['.sg-mod .sgr-confirm{', '.sg-mod .sgr-confirm.on{'],
    'cambiaron las reglas del cartel de confirmación');
  assert.match(PANEL, /\.sg-mod \.sgr-confirm\{[^}]*display:none\}/);
});

// ── 3 · Y EL CARTEL SE LIMPIA, NO SÓLO SE ESCONDE ──────────────────────────

test('esconder no es borrar: el cartel se vacía al abrir el modal', () => {
  // Mientras el texto siga escrito abajo, alcanza con que una regla de CSS deje de
  // alcanzarlo para que el CAE de otro cliente vuelva a aparecer. Ya pasó una vez.
  const i = PANEL.indexOf('function sgFacConfirmLimpiar(){');
  assert.ok(i > 0, 'no existe el limpiador del cartel');
  const b = PANEL.slice(i, i + 400);
  assert.match(b, /c\.classList\.remove\('on'\);/);
  assert.match(b, /c\.innerHTML = '';/, 'el contenido se borra');
  // El camino de rechazo pinta el borde en rojo con estilo inline, y eso tampoco se
  // sacaba nunca: el modal siguiente abría con el borde del error anterior.
  assert.match(b, /c\.style\.borderColor = '';/);
});

test('y lo llaman los dos caminos que abren el modal', () => {
  for (const f of ['function sgFacInit(){', 'function sgFacCliente(){']) {
    const i = PANEL.indexOf(f);
    assert.ok(i > 0, 'no existe ' + f);
    assert.match(PANEL.slice(i, i + 1200), /sgFacConfirmLimpiar\(\);/, f + ' no limpia el cartel');
  }
  // Y ya no queda ningún remove('on') suelto sobre el cartel, que es lo que hacía
  // creer que estaba resuelto.
  assert.ok(!/eid\('sgf-confirm'\)\.classList\.remove\('on'\)/.test(PANEL),
    'quedó un lugar que sólo esconde el cartel sin borrarlo');
});

// ── 4 · LA LISTA DE ATRÁS QUE SE REFRESCA ES LA QUE SE ESTÁ MIRANDO ────────

test('después de documentar, se refresca la lista que el usuario tiene delante', () => {
  // Si el remito recién facturado sigue en la lista, alguien lo factura de nuevo.
  // Son DOS listas que hacen la misma pregunta —todos los clientes, y las cadenas—:
  // refrescar siempre la primera dejaba la segunda mostrando un remito ya facturado.
  const i = PANEL.indexOf('function sgPendRefrescar(){');
  assert.ok(i > 0, 'no existe el refresco compartido');
  const b = PANEL.slice(i, i + 500);
  assert.match(b, /pe\.offsetParent !== null && typeof sgPendLoad === 'function'\) sgPendLoad\(\)/);
  assert.match(b, /su\.offsetParent !== null && typeof sgSuperLoad === 'function'\) sgSuperLoad\(\)/);
  // Y lo usan los dos caminos que documentan un remito: la factura que emitimos
  // nosotros y la liquidación que nos manda el cliente.
  assert.equal((PANEL.match(/\bsgPendRefrescar\(\);/g) || []).length, 2);
  // Ya no queda ningún refresco que apunte sólo a la lista vieja.
  assert.ok(!/if \(typeof sgPendLoad === 'function' && eid\('sgpe-tabla'\)\) sgPendLoad\(\);/.test(PANEL),
    'quedó un refresco que ignora la pantalla de cadenas');
});
