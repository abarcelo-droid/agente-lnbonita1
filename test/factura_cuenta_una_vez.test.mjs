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

// ══ LA MITAD DE ABAJO DE LA REGLA ══════════════════════════════════════
//
// El test de arriba busca el patrón "afip_estado IN (…)" — la forma vieja del
// error. Pero la regla tiene DOS mitades y sólo se estaba vigilando una: la de
// AFIP. La otra se seguía escribiendo a mano como "estado <> 'anulada'", y por
// ahí volvió el doble conteo, con más plata que la primera vez.
//
// Una factura RECHAZADA por AFIP queda en la tabla con estado 'pendiente' y sus
// importes escritos. La cuenta corriente la sumaba entera como deuda —porque
// 'pendiente' no es 'anulada'— y al mismo tiempo los kg de esa venta volvían a
// "entregado sin comprobante", porque ESA consulta sí usaba facturaCuenta. La
// misma venta, dos veces, y el cliente figurando debiendo casi el doble.
//
// Este test mira las consultas SOBRE sg_ven_facturas: si una filtra por estado a
// mano en vez de usar la regla, falla.
test('nadie filtra sg_ven_facturas por estado a mano: se usa la regla completa', () => {
  const patron = /sg_ven_facturas\s+(\w+)(?![\s\S]{0,400}?facturaCuenta)[\s\S]{0,400}?\1\.estado\s*(<>|!=)\s*'anulada'/gi;
  const culpables = [];
  for (const f of FUENTES) {
    if (f.rel === DUENO) continue;
    // Se mira consulta por consulta: FROM sg_ven_facturas <alias> … y qué hace
    // con el estado de ESE alias antes de que aparezca la regla compartida.
    const re = /FROM\s+sg_ven_facturas\s+(\w+)/gi;
    let m;
    while ((m = re.exec(f.txt))) {
      const alias = m[1];
      const tramo = f.txt.slice(m.index, m.index + 600);
      const aMano = new RegExp('\\b' + alias + "\\.estado\\s*(<>|!=)\\s*'anulada'").test(tramo);
      const conRegla = tramo.includes('facturaCuenta') || tramo.includes(alias + '.afip_estado');
      if (aMano && !conRegla) culpables.push(f.rel + ' (alias ' + alias + ')');
    }
  }
  assert.deepEqual(culpables, [],
    'Filtran las facturas por estado a mano, sin mirar si AFIP las rechazó: '
    + culpables.join(', ') + '. Una rechazada no es deuda, y si una consulta la '
    + 'cuenta y la de al lado no, la misma venta se suma dos veces. Usá '
    + 'facturaCuenta(alias).');
});

test('los que deciden si un remito ya está documentado usan la regla compartida', () => {
  const sg = FUENTES.find((f) => f.rel === path.join('rutas', 'sg.js'));
  assert.ok(sg, 'no encontré rutas/sg.js');
  // El nombre puede venir acompañado de otros del mismo módulo (deudaFactura, el
  // signo de la nota de crédito): lo que se cuida es que la regla se IMPORTE.
  assert.match(sg.txt, /import \{[^}]*\bfacturaCuenta\b[^}]*\}\s*from '\.\.\/servicios\/factura-cuenta\.js'/s,
    'sg.js tiene que importar la regla, no reescribirla');
  // La cuenta de kg documentados es la que decide si se puede volver a facturar.
  assert.match(sg.txt, /function kgDocumentadoItem\(/,
    'la función se llama kgDocumentadoItem: un remito se documenta con factura O '
    + 'con liquidación, así que «facturado» ya no era cierto');
  assert.match(sg.txt, /FROM sg_liquidacion_despachos/,
    'y cuenta las dos fuentes: si mirara sólo las facturas, un remito documentado '
    + 'con liquidación quedaría pendiente para siempre');
});
