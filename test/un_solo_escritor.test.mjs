// UN SOLO LUGAR ESCRIBE ASIENTOS.
//
// Este es el test que `servicios/asientos.js` promete en su comentario de arriba
// de todo. Estuvo prometido y no existía: un comentario que promete una red que
// no está es peor que no tener nada, porque el próximo que toque el archivo
// confía en ella.
//
// POR QUÉ IMPORTA. Antes había nueve `INSERT INTO sg_asientos` repartidos en
// cuatro archivos, cada uno armando sus líneas a mano. Mientras la única regla
// era "debe = haber" eso se podía sostener. Ahora hay dos más —cada ámbito
// balancea por su cuenta, y una línea de gestión sin motivo no entra— y nueve
// copias de una regla son nueve lugares donde puede estar mal una.
//
// Corre con `npm test` (node --test). No abre la base: lee el código fuente, que
// es donde se comete el error que busca.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const RAIZ = path.join(import.meta.dirname, '..', 'src');
const ESCRITOR = path.join('servicios', 'asientos.js');

// Todos los .js/.mjs de src/, sin node_modules.
function archivos(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') archivos(p, acc); }
    else if (/\.(js|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const FUENTES = archivos(RAIZ).map((p) => ({ rel: path.relative(RAIZ, p), txt: fs.readFileSync(p, 'utf8') }));

test('el único INSERT en sg_asientos vive en servicios/asientos.js', () => {
  const culpables = FUENTES
    .filter((f) => /INSERT\s+INTO\s+sg_asientos\b/i.test(f.txt))
    .map((f) => f.rel);
  assert.deepEqual(culpables, [ESCRITOR],
    'Apareció un INSERT INTO sg_asientos fuera del escritor: ' + culpables.join(', ')
    + '. Las líneas se arman con crearAsiento() — ahí viven las tres reglas '
    + '(cada ámbito balancea solo, sin motivo la línea de gestión no entra, y un '
    + 'importe negativo no existe).');
});

test('y el único INSERT en sg_asientos_lineas también', () => {
  const culpables = FUENTES
    .filter((f) => /INSERT\s+INTO\s+sg_asientos_lineas\b/i.test(f.txt))
    .map((f) => f.rel);
  assert.deepEqual(culpables, [ESCRITOR],
    'Escribir una línea sin pasar por crearAsiento saltea las validaciones: ' + culpables.join(', '));
});

// ── LEER TAMBIÉN TIENE REGLA ────────────────────────────────────────────────
// Una consulta sobre las líneas del libro que no dice qué ámbito quiere está
// mezclando lo fiscal con lo de gestión sin decirlo, y el número que devuelve no
// se puede explicar. Si de verdad necesita los dos, se declara con el marcador
// `ambito: todos` y su razón, en la línea de arriba o al lado.
test('nadie consulta las líneas del libro sin decir qué ámbito quiere', () => {
  const sinDeclarar = [];
  for (const f of FUENTES) {
    if (f.rel === ESCRITOR) continue;
    const lineas = f.txt.split(/\r?\n/);
    lineas.forEach((l, i) => {
      if (!/\bFROM\s+sg_asientos_lineas\b/i.test(l) && !/\bJOIN\s+sg_asientos_lineas\b/i.test(l)) return;
      // La consulta puede seguir varias líneas, y el marcador va en el comentario
      // que la precede —que puede tener tres o cuatro renglones—: la ventana mira
      // bastante hacia atrás a propósito. Con tres líneas daba un falso positivo
      // sobre una consulta que sí estaba declarada.
      const bloque = lineas.slice(Math.max(0, i - 10), i + 12).join('\n');
      const declara = /ambito\s*:\s*todos/i.test(bloque)          // el marcador explícito
        || /\bambito\b\s*=\s*\?/i.test(bloque)                    // filtra por parámetro
        || /filtroAmbito\s*\(/.test(bloque)                       // usa el helper
        || /\bambito\s*=\s*'(fiscal|gestion)'/i.test(bloque)      // fija uno
        || /GROUP\s+BY\s+ambito/i.test(bloque)                    // los abre por separado
        || /\bl?\.?ambito\b/i.test(bloque);                       // al menos lo devuelve
      if (!declara) sinDeclarar.push(f.rel + ':' + (i + 1));
    });
  }
  assert.deepEqual(sinDeclarar, [],
    'Estas consultas leen sg_asientos_lineas sin decir de qué libro son: '
    + sinDeclarar.join(', ') + '. Filtrá con filtroAmbito(), o si de verdad '
    + 'necesitás los dos escribí el marcador «ambito: todos» y por qué.');
});

test('y el escritor sigue exportando lo que los demás usan', async () => {
  const m = await import('../src/servicios/asientos.js');
  for (const fn of ['crearAsiento', 'filtroAmbito', 'totalesDeAsiento',
                    'origenDeAsiento', 'origenDeAsientoPa']) {
    assert.equal(typeof m[fn], 'function', 'falta ' + fn);
  }
  // Los cuatro motivos son una lista corta, no texto libre: texto libre son
  // cuarenta maneras de escribir lo mismo y ningún informe posible.
  assert.deepEqual(Object.keys(m.MOTIVOS).sort(),
    ['ajuste_gestion', 'comprobante_pendiente', 'diferencia_peso_calidad', 'error_proveedor']);
  assert.deepEqual(m.AMBITOS, ['fiscal', 'gestion']);
});
