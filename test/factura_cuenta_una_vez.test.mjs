// QUÉ FACTURA CUENTA SE DECIDE EN UN SOLO LUGAR.
//
// Este es el test que `servicios/factura-cuenta.js` promete en su comentario.
// Estuvo prometido y no existía.
//
// POR QUÉ IMPORTA. Había tres listas de estados escritas a mano —variantes de
// `afip_estado IN ('reservado','autorizado')`— y ninguna incluía el comprobante
// MANUAL. Un remito ya facturado a mano volvía a aparecer como pendiente: los kg
// quedaban disponibles otra vez y nada frenaba una segunda factura por la misma
// mercadería. La regla de verdad no es una lista de estados buenos: es que una
// factura cuenta SALVO que se haya caído, y se cae de dos maneras y sólo de dos.
//
// Corre con `npm test` (node --test). Lee el código fuente, que es donde se
// comete el error que busca.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { facturaCuenta } from '../src/servicios/factura-cuenta.js';

const RAIZ = path.join(import.meta.dirname, '..', 'src');
const DUENO = path.join('servicios', 'factura-cuenta.js');

function archivos(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') archivos(p, acc); }
    else if (/\.(js|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const FUENTES = archivos(RAIZ).map((p) => ({ rel: path.relative(RAIZ, p), txt: fs.readFileSync(p, 'utf8') }));

test('la regla dice qué NO cuenta, no qué sí: un estado nuevo entra contando', () => {
  const sql = facturaCuenta('f');
  assert.match(sql, /<>\s*'rechazado'/, 'una factura rechazada por AFIP no cuenta');
  assert.match(sql, /<>\s*'anulada'/, 'y una anulada tampoco');
  assert.doesNotMatch(sql, /\bIN\s*\(/i,
    'con una lista de estados BUENOS, el estado que se agregue mañana queda afuera '
    + 'en silencio — que es exactamente lo que pasó con el comprobante manual.');
  // El alias es parámetro: la misma regla sirve en cualquier consulta.
  assert.match(facturaCuenta('fv'), /fv\.afip_estado/);
});

test('y no vuelve a aparecer una lista de estados escrita a mano', () => {
  // El patrón del error: enumerar los estados que SÍ cuentan.
  const patron = /afip_estado\s+IN\s*\(/i;
  const culpables = FUENTES
    .filter((f) => f.rel !== DUENO && patron.test(f.txt))
    .map((f) => f.rel);
  assert.deepEqual(culpables, [],
    'Volvió a aparecer una lista de estados a mano en: ' + culpables.join(', ')
    + '. Usá facturaCuenta(alias): la regla vive en un solo lugar porque tres '
    + 'copias son tres lugares donde puede faltar un estado.');
});

test('los que deciden si un remito ya está documentado usan la regla compartida', () => {
  const sg = FUENTES.find((f) => f.rel === path.join('rutas', 'sg.js'));
  assert.ok(sg, 'no encontré rutas/sg.js');
  assert.match(sg.txt, /import \{ facturaCuenta \}/,
    'sg.js tiene que importar la regla, no reescribirla');
  // La cuenta de kg documentados es la que decide si se puede volver a facturar.
  assert.match(sg.txt, /function kgDocumentadoItem\(/,
    'la función se llama kgDocumentadoItem: un remito se documenta con factura O '
    + 'con liquidación, así que «facturado» ya no era cierto');
  assert.match(sg.txt, /FROM sg_liquidacion_despachos/,
    'y cuenta las dos fuentes: si mirara sólo las facturas, un remito documentado '
    + 'con liquidación quedaría pendiente para siempre');
});
