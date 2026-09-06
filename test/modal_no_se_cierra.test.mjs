// ══════════════════════════════════════════════════════════════════════════
// UN MODAL NO SE CIERRA AL CLIC AFUERA
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 6/9/2026: «en cargar una factura de cooperativa es como que se abre una
// subventana. Eso me encanta porque queda claro que estamos trabajando ahí, pero
// si hago click fuera de esa ventana se cierra... y pierdo toda la info que
// cargué. Sería bueno que sólo me deje salir de esa ventana con los dos botones
// de abajo, de cancelar o cargar factura».
//
// Un clic al costado es un accidente, no una decisión, y descartaba trabajo de
// varios minutos sin ningún deshacer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const IFCO = fs.readFileSync(path.join(RAIZ, 'src/ifco2.js'), 'utf8');
const CLAUDE = fs.readFileSync(path.join(RAIZ, 'CLAUDE.md'), 'utf8');

test('ningún overlay del panel se cierra por clic en el fondo', () => {
  // Era UN handler que los alcanzaba a todos: se registraba sobre cada
  // .ab-modal-overlay y quitaba la clase «on» cuando el click caía en el fondo.
  assert.ok(!/e\.target\s*===\s*el\)\s*el\.classList\.remove\('on'\)/.test(PANEL),
    'volvió el cierre por clic afuera');
  assert.ok(!/Cerrar modales abasto al click fuera/.test(PANEL),
    'quedó el handler viejo');
  // Y no hay ningún otro que haga lo mismo sobre un overlay con formulario.
  const sospechosos = [...PANEL.matchAll(/e\.target\s*===\s*(\w+)\)\s*\{?\s*(\w+)/g)]
    .map((m) => m[0]);
  for (const x of sospechosos) {
    assert.ok(!/classList\.remove/.test(x), 'hay un cierre por clic afuera: ' + x);
  }
});

test('el asistente de recepción ya no necesita su excepción escrita a mano', () => {
  // Tenía la única excepción del handler, con el comentario «un click al costado
  // cerraba todo y no había forma de recuperarlo». Esa excepción ERA la regla:
  // vale igual para la factura de la cooperativa y para cualquier carga.
  assert.ok(!/if \(el\.id === 'sg-rec-modal'\) return;/.test(PANEL),
    'quedó la excepción de un modal solo, con la regla puesta para todos');
});

test('se sale con los botones de abajo y con la ×, que se aprietan a propósito', () => {
  // La factura de servicio es la que Pablo nombró: tiene las tres salidas.
  const i = PANEL.indexOf('id="sg-fg-modal"');
  assert.ok(i > 0);
  const m = PANEL.slice(i, PANEL.indexOf('</div>\r\n</div>\r\n\r\n', i) + 40);
  assert.match(m, /class="mcl" onclick="closeMB\('sg-fg-modal'\)"/);
  assert.match(m, /onclick="closeMB\('sg-fg-modal'\)">Cancelar</);
  assert.match(m, /id="sg-fg-btn" onclick="sgFgGuardar\(\)"/);
});

test('los diálogos de confirmación SÍ se pueden cerrar al costado', () => {
  // Ahí no hay nada cargado que perder, y en el de borrado definitivo un clic al
  // costado CANCELA una operación irreversible: cerrarlo es lo seguro.
  assert.match(IFCO, /ov\.onclick = function \(e\) \{ if \(e\.target === ov\) close\(\); \};/);
  const i = IFCO.indexOf('window.__ifco2HardDelete');
  assert.match(IFCO.slice(i, i + 2600), /Eliminar definitivamente/);
});

test('y la regla queda escrita donde se la va a leer', () => {
  // Es una regla de todo el panel, no de esta pantalla: si vive sólo en un
  // comentario del código, la próxima pantalla la vuelve a romper.
  assert.match(CLAUDE, /### UN MODAL NO SE CIERRA AL CLIC AFUERA/);
  assert.match(CLAUDE, /Se sale con[\s\S]{0,20}\*\*Cancelar\*\*/);
  assert.match(CLAUDE, /### LO QUE YA ESTÁ PARAMETRIZADO NO OCUPA EL ENCABEZADO/);
});
