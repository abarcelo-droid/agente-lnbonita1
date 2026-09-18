// test/pantalla_completa.test.mjs
// ══ ESCONDER EL MENÚ PARA TRABAJAR A PANTALLA COMPLETA (V1063) ═══════════════════════
//
// Pablo, 17/9/2026: «¿podemos hacer que la barra de costado se esconda para tener pantalla
// completa en donde estamos trabajando? Eso ahorra espacio y podemos ver mejor».
//
// No es de una pantalla: es del panel entero. Por eso el manual va en SG_MANUAL_COMUN, que
// sgManualHtml le pega a CUALQUIER manual, y no copiado en los doce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const JS = leer('src/sidebar-v2.js');
const CSS = leer('src/sidebar-v2.css');
const PANEL = leer('src/panel.html');

function fuente(txt, firma) {
  const i = txt.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  let prof = 0, k = txt.indexOf('{', i);
  for (; k < txt.length; k++) {
    if (txt[k] === '{') prof++;
    else if (txt[k] === '}') { prof--; if (prof === 0) break; }
  }
  return txt.slice(i, k + 1);
}

test('el botón esconde el menú entero, y la elección se recuerda', () => {
  assert.match(JS, /data-action="full" title="Pantalla completa: esconder el menú"/);
  assert.match(JS, /if \(action === 'full'\)\s+\{ esconderMenu\(true\); return; \}/);
  const esc = fuente(JS, 'function esconderMenu(si){');
  assert.match(esc, /document\.body\.classList\.toggle\('lnb-menu-oculto', !!si\)/);
  assert.match(esc, /localStorage\.setItem\(LS_MENU, si \? '1' : ''\)/);
  assert.match(JS, /const LS_MENU\s+= 'lnb-sidebar-oculto';/);
  // Y al entrar se respeta lo que quedó la vez anterior.
  assert.match(fuente(JS, 'function menuGuardado(){'), /if \(g\) esconderMenu\(true\);/);
  assert.match(JS, /menuGuardado\(\);/);
  // localStorage puede estar bloqueado: que eso no deje el panel sin menú ni sin botón.
  assert.match(esc, /try \{ localStorage/);
  assert.match(fuente(JS, 'function menuGuardado(){'), /try \{ g = localStorage/);
});

test('la pestaña que lo trae de vuelta no cuelga del menú, o se escondería con él', () => {
  assert.match(JS, /volver\.className = 'sb2-volver';/);
  assert.match(JS, /volver\.addEventListener\('click', \(\) => esconderMenu\(false\)\);/);
  assert.match(JS, /document\.body\.appendChild\(volver\);/);
  const sb = JS.indexOf("shell.insertBefore(sb, shell.firstChild)");
  assert.ok(sb > 0 && JS.indexOf('appendChild(volver)') > sb, 'la pestaña se arma antes que el menú');
  // El CSS: el menú se va, la pestaña aparece, y sin esconder nada la pestaña no está.
  assert.match(CSS, /body\.lnb-menu-oculto \.sb2\{ display: none \}/);
  assert.match(CSS, /\.sb2-volver\{ display: none \}/);
  assert.match(CSS, /body\.lnb-menu-oculto \.sb2-volver\{[^}]*position: fixed;[^}]*left: 0/);
  // En el teléfono no aplica: ahí el menú ya se abre y se cierra con el dedo, y quien lo
  // escondió en la computadora se quedaría sin manera de abrirlo.
  assert.match(CSS, /@media \(max-width: 760px\)\{\r?\n\s+body\.lnb-menu-oculto \.sb2\{ display: flex \}\r?\n\s+body\.lnb-menu-oculto \.sb2-volver\{ display: none \}/);
  // Angostar el menú sigue existiendo: son dos cosas distintas.
  assert.match(JS, /data-action="density" title="Angostar \/ ensanchar el menú"/);
  assert.match(CSS, /\.sb2-acciones\{/);
});

test('el manual común lo cuenta, y se lo pega a todos los manuales', () => {
  const i = PANEL.indexOf('var SG_MANUAL_COMUN =');
  assert.ok(i > 0);
  const M = PANEL.slice(i, PANEL.indexOf("';", i) + 2).replace(/'\r?\n\s*\+ '/g, '');
  assert.match(M, /<h3>🖥️ Trabajar a pantalla completa <span class="ver">V1063<\/span><\/h3>/);
  assert.match(M, /uno lo <b>angosta<\/b> —quedan sólo los iconos— y el otro lo <b>esconde del todo<\/b>/);
  assert.match(M, /queda una <b>pestaña ☰<\/b> pegada al borde izquierdo: un clic y vuelve/);
  assert.match(M, /El panel se acuerda de cómo se dejó/);
  assert.match(PANEL, /function sgManualHtml\(m\)\{\r?\n\s+return String\(\(m && m\.html\) \|\| ''\) \+ SG_MANUAL_COMUN;/);
  // La versión que cita tiene que existir.
  const v = Number((JS.match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const c of (M.match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
    assert.ok(c <= v, `el manual común cita la V${c} y el panel va en la V${v}`);
  }
});
