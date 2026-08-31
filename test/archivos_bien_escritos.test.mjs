// ══ LOS ARCHIVOS ESTÁN EN UTF-8, SIN BOM Y SIN DOBLE CODIFICAR ═════════════
//
// 31/8/2026: cambiar el número de versión de `sidebar-v2.js` con PowerShell rompió
// TODOS los acentos del archivo de una sola vez. `Get-Content -Raw` lo leyó como
// ANSI —porque no tenía BOM— y `Set-Content -Encoding utf8` lo escribió de vuelta
// ya mal: "módulos" quedó "mÃ³dulos", y las rayas de los comentarios explotaron en
// tres caracteres cada una. Un commit de una línea, 225 líneas rotas.
//
// El daño es de los que no avisan: el JS sigue corriendo, `node --check` pasa, y
// lo que se nota recién es un cartel del panel con la palabra torcida.
//
// Este test mira los archivos que se sirven y se leen en pantalla:
//
//   1. NADA DE BOM. Es lo que hace que la próxima herramienta lea bien o mal el
//      archivo, y es exactamente lo que dejó PowerShell.
//   2. NADA DE MOJIBAKE. Las marcas de UTF-8 leído como cp1252 —"Ã³", "â€", "Â"—
//      no aparecen en castellano ni en código: si están, alguien recodificó.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Todo lo que se sirve al navegador o se lee en pantalla. panel.html entra: es el
// más grande y el que más se parchea a mano.
function archivos(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivos(p, acc);
    else if (/\.(js|mjs|html|css|json|md)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const TODOS = archivos(path.join(RAIZ, 'src'), [])
  .concat(archivos(path.join(RAIZ, 'test'), []));

test('ningun archivo arranca con BOM', () => {
  // El BOM es invisible y decide como lo lee la herramienta siguiente: sin el,
  // PowerShell leyo sidebar-v2.js como ANSI y lo devolvio roto. En un .js servido,
  // ademas, viaja al navegador.
  const con = TODOS.filter((p) => {
    const b = fs.readFileSync(p);
    return b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
  });
  assert.deepEqual(con.map((p) => path.relative(RAIZ, p)), [],
    'estos archivos tienen BOM: casi seguro los escribio Set-Content -Encoding utf8');
});

test('ningun archivo quedo doble codificado', () => {
  // Las firmas de UTF-8 leido como cp1252, escritas con escapes para que este mismo
  // archivo no sea el primer falso positivo.
  const MOJI = new RegExp('\\u00C3[\\u00A0-\\u00BF\\u2013\\u2014\\u00A9\\u00AE]'
    + '|\\u00E2\\u20AC[\\u201C\\u201D\\u2122\\u0153\\u009D]'
    + '|\\u00C2[\\u00A0\\u00B0\\u00BF\\u00A1\\u00B7]', 'g');
  //
  // SE CUENTA, NO SE BUSCA UNA. Recodificar un archivo rompe TODOS sus acentos a la
  // vez -fueron 225 lineas de un tiron-, asi que aparecen de a decenas. De a una o
  // dos es un comentario que HABLA del problema: panel.html explica en el CSV por que
  // le pone BOM, y para explicarlo escribe la palabra rota. Prohibirla seria prohibir
  // documentar el bug.
  const UMBRAL = 5;
  const rotos = [];
  for (const p of TODOS) {
    const n = (fs.readFileSync(p, 'utf8').match(MOJI) || []).length;
    if (n >= UMBRAL) rotos.push(path.relative(RAIZ, p) + ' -> ' + n + ' acentos rotos');
  }
  assert.deepEqual(rotos, [],
    'estos archivos tienen acentos doble codificados: se recodifico el archivo entero');
});

test('y sidebar-v2.js en particular, que es el que se toca a cada merge', () => {
  // Es el archivo del número de versión: se edita en TODOS los merges, y por eso
  // es el que más chances tiene de que lo escriba la herramienta equivocada.
  const p = path.join(RAIZ, 'src/sidebar-v2.js');
  const b = fs.readFileSync(p);
  assert.notEqual([b[0], b[1], b[2]].join(','), '239,187,191', 'volvió el BOM');
  const s = b.toString('utf8');
  assert.match(s, /Sidebar dinámico v2 para LNB Panel/, 'los acentos siguen enteros');
  assert.match(s, /^const VERSION = 'V\d+';$/m, 'y la versión se sigue leyendo');
});
