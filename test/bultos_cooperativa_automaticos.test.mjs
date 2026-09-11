// ══════════════════════════════════════════════════════════════════════════
// LOS BULTOS DE LA COOPERATIVA DE CARGA SE CUENTAN SOLOS
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 9/9/2026: «Bultos para la cooperativa: debería sumar la cantidad de bultos
// que se declaren en el remito, que salga automático».
//
// Se tipeaban en un casillero aparte y LO TIPEADO LE GANABA A LA SUMA: la suma de los
// renglones sólo entraba si el casillero quedaba vacío. Dos números para lo mismo
// —cuántos cajones subieron al camión— y el que se le pagaba a la cuadrilla era el
// escrito de memoria.
//
// No es cosmético: con esa cantidad la valorización REPARTE la factura de la
// cooperativa entre los remitos. Un número mal tipeado le pasa costo de un remito a
// otro, y el margen de los dos queda mal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const hasta = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i >= 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

// ══════════════════════════════════════════════════════════════════════════
// 1 · EL SERVIDOR
// ══════════════════════════════════════════════════════════════════════════

test('la cantidad de la carga es la suma de los cajones del remito', () => {
  const post = hasta(SG, 'const postRemito = (req, res) => {', '\r\n};');
  // La suma se arma renglón por renglón, con los mismos cajones que bajan el stock.
  assert.match(post, /let totalBultos = 0;/);
  assert.match(post, /totalBultos \+= bultos;/);
  // Y ESO es lo que se le carga a la cooperativa, sin otra fuente posible.
  assert.match(post, /const coopBultos = totalBultos \|\| null;/);
  assert.match(post, /syncGastoCoop\(db, \{ tipo: 'carga_salida', despachoId, proveedorId: coopId, cooperativaId: coopCatId, unidad: 'bulto', cantidad: coopBultos,/);
});

test('lo que venga tipeado en el pedido se ignora', () => {
  // Si el servidor lo siguiera leyendo, bastaría con que una pantalla vieja —o
  // alguien llamando a la dirección— lo mande para volver al número de memoria.
  assert.ok(!/cooperativa_bultos/.test(hasta(SG, 'const postRemito = (req, res) => {', '\r\n};')),
    'el remito sigue leyendo los bultos tipeados');
  // Ni en ningún otro lado del router: la Facturación Puesto también lo mandaba.
  assert.ok(!/cooperativa_bultos/.test(SG), 'quedó alguien mandando o leyendo los bultos tipeados');
});

test('es la misma regla que la descarga de la recepción', () => {
  // Del otro lado del galpón ya era así: la descarga cuenta los bultos que se
  // recibieron y no pregunta. El remito era el único que pedía un número aparte.
  assert.match(SG, /const cantidad = unidad === 'pallet' \? rec\.pallets_recibidos : rec\.bultos_recibidos;/);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LA VENTANA
// ══════════════════════════════════════════════════════════════════════════

function contar(items) {
  const src = hasta(PANEL, 'function sgDespBultosCoop(){', '\r\n}');
  const el = { innerHTML: '' };
  const SGx = { despItems: items };
  // eslint-disable-next-line no-new-func
  const f = new Function('SG', 'eid', 'nr', src + '\nreturn sgDespBultosCoop;')(
    SGx, (id) => (id === 'sg-desp-bultos-coop' ? el : null),
    (n) => Math.round(parseFloat(n) || 0).toLocaleString('es-AR'));
  const n = f();
  return { n, html: el.innerHTML };
}

test('la ventana muestra la suma de los renglones', () => {
  const r = contar([{ bultos: 40 }, { bultos: '25' }, { bultos: '' }]);
  assert.equal(r.n, 65);
  assert.equal(r.html, '<b>65</b> bultos');
  // Uno es «bulto», no «bultos».
  assert.equal(contar([{ bultos: 1 }]).html, '<b>1</b> bulto');
  // Sin renglones, cero — no un casillero vacío que parezca que falta algo.
  assert.equal(contar([]).html, '<b>0</b> bultos');
  // Con miles, con el punto de miles de acá.
  assert.equal(contar([{ bultos: 1200 }]).html, '<b>1.200</b> bultos');
});

test('se actualiza sola en cada cambio del remito', () => {
  // sgDespTotal corre cada vez que se agrega, borra o cambia un renglón: colgarla
  // de ahí es lo que hace que no haya que acordarse de llamarla en cada lugar.
  const f = hasta(PANEL, 'function sgDespTotal(){', '\r\n}');
  assert.match(f, /sgDespBultosCoop\(\);/);
  // Y al abrir un remito nuevo arranca en cero, no con la suma del anterior.
  const open = hasta(PANEL, 'function sgDespOpen(modo){', '\r\n}');
  assert.match(open, /sgDespBultosCoop\(\);/);
});

test('ya no hay casillero para tipearlos, ni se mandan', () => {
  assert.ok(!/id="sg-desp-bultos"/.test(PANEL), 'sigue el casillero para escribir los bultos');
  assert.ok(!/cooperativa_bultos/.test(PANEL), 'la pantalla sigue mandando los bultos tipeados');
  // En su lugar, lo que se ve — dentro del bloque de la cooperativa, al lado del
  // selector, que es donde se va a buscar.
  const bloque = hasta(PANEL, '<label>Cooperativa de carga</label>', 'se cuentan solos</div>');
  assert.match(bloque, /<select id="sg-desp-coop">/);
  assert.match(bloque, /id="sg-desp-bultos-coop"/);
  assert.ok(!/poné cuántos cargaron/.test(PANEL), 'la ayuda sigue pidiendo que se escriban');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL MANUAL DICE LO QUE EL CÓDIGO HACE
// ══════════════════════════════════════════════════════════════════════════

const plano = (txt) => String(txt).replace(/'\s*\+\s*'/g, '');
const MAN = plano(hasta(PANEL, 'SG_MANUAL.ventas = ', 'SG_MANUAL.reprocesos = '));

test('«los bultos no se escriben: son la suma de los cajones del remito»', () => {
  assert.match(MAN, /<span class="ver">V1041<\/span> <b>Los bultos no se escriben<\/b>: son la suma de los cajones del remito/);
  assert.match(MAN, /<b>V1041<\/b> — los <b>bultos de la cooperativa de carga<\/b> se cuentan solos/);
  // Y es cierto del lado que decide.
  assert.match(hasta(SG, 'const postRemito = (req, res) => {', '\r\n};'), /const coopBultos = totalBultos \|\| null;/);
});

test('«se actualizan solos a medida que se cargan renglones»', () => {
  assert.match(MAN, /se actualizan solos a medida que se cargan renglones/);
  assert.match(hasta(PANEL, 'function sgDespTotal(){', '\r\n}'), /sgDespBultosCoop\(\);/);
});
