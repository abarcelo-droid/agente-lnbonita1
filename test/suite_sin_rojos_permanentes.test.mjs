// ══ UN SUITE CON DOS ROJOS FIJOS NO ES SEÑAL ══════════════════════════════
//
// `oportunidades_pdf` y `share_import` fallaban SIEMPRE en este repo, porque no
// hay node_modules y sus paquetes —jspdf y xlsx— no están. CLAUDE.md lo tenía
// escrito como ruido conocido: «es ruido conocido: mirar que los demás pasen».
//
// Esa frase era el problema. Un suite que siempre termina con dos rojos deja de
// ser señal a los dos días: se mira el número, se dice «son los de siempre» y el
// rojo número tres pasa de largo. Lo mismo que ya está escrito en el repo sobre
// los avisos que se ignoran.
//
// Ahora se SALTEAN cuando el paquete falta, y la suite queda en verde. Pero eso
// abre un riesgo nuevo y peor: que se salteen SIEMPRE, incluso donde el paquete
// está, y que nadie se entere de que esos 27 tests dejaron de correr. Este archivo
// es el que cierra esa puerta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE = fs.readFileSync(path.join(RAIZ, 'CLAUDE.md'), 'utf8');

const CONDICIONALES = [
  { archivo: 'share_import.test.mjs', paquete: 'xlsx' },
  { archivo: 'oportunidades_pdf.test.mjs', paquete: 'jspdf' },
];

const leer = (f) => fs.readFileSync(path.join(RAIZ, 'test', f), 'utf8');

test('el salteo es CONDICIONAL: arranca en null y sólo lo prende un catch', () => {
  // Si `falta` estuviera puesto a mano —o si el catch abarcara de más— los tests
  // se saltearían también donde el paquete está, y nadie lo notaría: un salteo no
  // se ve, a diferencia de un rojo.
  for (const { archivo } of CONDICIONALES) {
    const s = leer(archivo);
    assert.match(s, /^let falta = null;$/m, archivo + ': falta no arranca en null');
    // La ÚNICA asignación de `falta` está adentro de un catch.
    // Se busca la asignación al MOTIVO (una cadena), no el `= null` de arriba: con
    // el lookahead pegado al \s* la expresión hacía backtracking y contaba las dos.
    const asignaciones = [...s.matchAll(/falta\s*=\s*'/g)];
    assert.equal(asignaciones.length, 1, archivo + ': se le asigna en más de un lugar');
    const antes = s.slice(0, asignaciones[0].index);
    assert.ok(/catch\s*(\([^)]*\))?\s*\{[^{}]*$/.test(antes),
      archivo + ': falta se prende fuera de un catch');
  }
});

test('y el motivo dice qué hacer para que corran', () => {
  // «skipped» sin explicación es indistinguible de un test roto y abandonado.
  for (const { archivo, paquete } of CONDICIONALES) {
    const s = leer(archivo);
    assert.match(s, new RegExp('falta el paquete ' + paquete),
      archivo + ': el motivo no nombra el paquete');
    assert.match(s, /npm install/, archivo + ': el motivo no dice cómo arreglarlo');
  }
});

test('NINGÚN test de esos archivos se saltea el envoltorio', () => {
  // Uno escrito con `test(` directo vuelve a caerse en el import y devuelve el
  // rojo permanente — o peor, corre con el módulo en null y falla por otra razón.
  for (const { archivo } of CONDICIONALES) {
    const s = leer(archivo);
    assert.match(s, /^const t = \(nombre, fn\) => test\(nombre, \{ skip: falta \}, fn\);$/m,
      archivo + ': no está el envoltorio');
    const sueltos = (s.match(/^test\(/gm) || []).length;
    assert.equal(sueltos, 0, archivo + ': hay ' + sueltos + ' test() que no pasan por el envoltorio');
    assert.ok((s.match(/^t\(/gm) || []).length > 5, archivo + ': se perdieron tests');
  }
});

test('los import de los paquetes que pueden faltar son a demanda', () => {
  // Un `import` arriba se resuelve ANTES de que corra nada: el try/catch no llega
  // a existir y el archivo muere igual. Vale también para el módulo del repo que
  // importa el paquete —share_import.js importa xlsx—.
  const sh = leer('share_import.test.mjs');
  assert.ok(!/^import .* from 'xlsx'/m.test(sh), 'xlsx sigue importado arriba');
  assert.ok(!/^import .* from '\.\.\/src\/servicios\/share_import\.js'/m.test(sh),
    'share_import.js sigue importado arriba, y ése importa xlsx');
  assert.match(sh, /await import\('xlsx'\)/);
  assert.match(sh, /await import\('\.\.\/src\/servicios\/share_import\.js'\)/);

  const op = leer('oportunidades_pdf.test.mjs');
  assert.ok(!/^import .* from '\.\.\/src\/servicios\/oportunidadesPDF\.js'/m.test(op),
    'oportunidadesPDF.js sigue importado arriba, y ése importa jspdf');
  assert.match(op, /await import\('\.\.\/src\/servicios\/oportunidadesPDF\.js'\)/);
});

test('y CLAUDE.md dejó de decir que hay dos rojos conocidos', () => {
  // Era la instrucción que enseñaba a ignorar el número. Mientras estuviera
  // escrita, el próximo rojo se leía como «uno de los de siempre».
  // Se mira la INSTRUCCIÓN, no la frase: el texto nuevo cita la vieja para contar
  // qué se cambió, y eso está bien — lo que no puede volver es la orden de
  // ignorar el número.
  assert.ok(!/Es ruido conocido: mirar que los demás pasen/.test(CLAUDE),
    'CLAUDE.md sigue mandando a ignorar los rojos conocidos');
  assert.match(CLAUDE, /`npm test` termina en verde/);
  assert.match(CLAUDE, /Si ves un rojo, es un rojo de verdad/);
});
