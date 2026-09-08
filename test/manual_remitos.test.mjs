// ══ EL «¿CÓMO SE USA?» DE REMITOS Y FACTURACIÓN ═══════════════════════════
//
// Pablo, 8/9/2026: «agregá el "cómo se usa" a Remitos y Facturación. IMPORTANTE:
// cada vez que modifiques algo en alguna pantalla tenés que actualizar el "Cómo
// se usa" correspondiente, si no nos perdemos».
//
// Era la pantalla que más plata mueve del módulo —el remito que sale con el
// camión, la venta del puesto, la facturación a las cadenas y las devoluciones—
// y la única de las grandes sin manual.
//
// ESTE TEST NO CONTROLA QUE EL TEXTO EXISTA. Controla que lo que el manual
// AFIRMA siga siendo cierto en el código: un manual que va una versión atrás es
// peor que no tenerlo, porque el operador hace lo que dice y le sale mal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

const MANUAL = trozo(PANEL, "SG_MANUAL.ventas = { titulo: 'Remitos y Facturación'", '\r\n};');

// ── 1 · EXISTE Y SE PUEDE ABRIR ────────────────────────────────────────────

test('la pantalla tiene su botón, y el manual existe', () => {
  const cab = trozo(PANEL, '<div class="sec sg-mod" id="sec-sg-ventas">', '</div>\r\n    <style>');
  assert.match(cab, /onclick="sgManualAbrir\('ventas'\)"/);
  // La clave tiene que ser la que busca el botón, o contesta «todavía no hay
  // manual de esta pantalla».
  assert.match(PANEL, /SG_MANUAL\.ventas = \{ titulo: 'Remitos y Facturación'/);
});

test('cubre las cinco solapas, no tres', () => {
  const sec = trozo(PANEL, '<div class="sec sg-mod" id="sec-sg-ventas">', '<!-- ══ ↩️ DEVOLUCIÓN');
  const solapas = [...sec.matchAll(/data-sub="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(solapas.sort(),
    ['despachos', 'devoluciones', 'directa', 'remsuper', 'supermercados']);
  for (const t of ['Emisión de Remitos', 'Remitos Supermercados', 'Facturación Puesto',
                   'Facturación Supermercados', 'Devoluciones']) {
    assert.ok(MANUAL.includes(t), 'el manual no menciona la solapa ' + t);
  }
});

test('lo primero que dice es la diferencia entre remito y factura', () => {
  // Es la confusión que genera todo lo demás: se remite cuando sale y se factura
  // cuando corresponde, que casi nunca es el mismo día.
  assert.match(MANUAL, /El <b>remito<\/b> acompaña la mercadería en el camión y <b>descuenta el stock<\/b>/);
  assert.match(MANUAL, /La <b>factura<\/b> es el comprobante fiscal/);
});

// ── 2 · LO QUE AFIRMA, ¿ES CIERTO? ─────────────────────────────────────────

test('«no se puede remitir mercadería en viaje» — y el picker no la ofrece', () => {
  assert.match(MANUAL, /No se puede remitir mercadería en viaje/);
  // La mercadería en camino sólo se puede comprometer en un PEDIDO, no en un
  // remito: el remito descuenta stock de verdad.
  const f = trozo(PANEL, 'function sgIPConCamino(', '\r\n}');
  assert.match(f, /modo\s*===\s*'pedido'/);
});

test('«el precio se guarda siempre por kilo» — y el remito lo guarda así', () => {
  assert.match(MANUAL, /Adentro <b>siempre se guarda por kilo<\/b>/);
  // El selector kilo/bulto es de CARGA: convierte y guarda $/kg. Si guardara las
  // dos unidades, dos ventas del mismo producto no se podrían comparar.
  assert.match(PANEL, /function sgDespPrecioSet\(/);
  const g = trozo(PANEL, 'function sgDespGuardar(', '\r\n}');
  assert.match(g, /modo_precio/);
});

test('«el precio de un remito facturado queda con candado» — y el server lo frena', () => {
  assert.match(MANUAL, /queda <b>cerrado con candado<\/b>/);
  assert.match(MANUAL, /Se corrige con una nota de '\r?\n?\s*\+ 'crédito/);
  const r = trozo(SG, "router.put('/despachos/:id/precios'", '\r\n});');
  assert.match(r, /return res\.status\(409\)/);
  assert.match(r, /Este remito ya se facturó/);
  assert.match(r, /Se corrige con una nota de crédito/);
  // Y pide motivo, como dice el manual.
  assert.match(MANUAL, /Pide <b>motivo<\/b> y rehace el margen/);
  assert.match(r, /motivo/);
});

test('«un remito facturado no se anula hasta la nota de crédito» — y el server también', () => {
  assert.match(MANUAL, /Un <b>remito ya facturado no se anula<\/b>/);
  assert.match(MANUAL, /recién '\r?\n?\s*\+ 'cuando el comprobante queda en cero/);
  const r = trozo(SG, "router.post('/despachos/:id/anular'", '\r\n});');
  // El neto documentado en cero es lo que lo destraba: preguntar sólo «¿existe una
  // factura?» dejaba trabado para siempre un remito ya acreditado.
  assert.match(r, /COALESCE\(SUM\(fd\.kg\),0\) kg/);
  assert.match(r, /neto > 0\.01/);
});

test('«lo devuelto no se factura» — y lo pendiente ya lo resta', () => {
  assert.match(MANUAL, /<b>Lo devuelto no se factura\.<\/b>/);
  assert.match(SG, /descuenta_al_productor/);
  // La consulta de pendientes descuenta lo devuelto: si no, habría que acordarse
  // de restarlo a mano en cada factura.
  assert.match(SG, /kgDevueltoItem|dvi\.kg/);
});

test('«toda devolución entra por un piso, aunque vuelva al productor»', () => {
  assert.match(MANUAL, /<b>Entra por un piso<\/b>, siempre/);
  assert.match(MANUAL, /entra y sale, y el neto es cero/);
  const r = trozo(SG, "router.post('/despachos/:id/devolver'", '\r\n});');
  assert.match(r, /piso/);
  // Entra y sale: el neto es cero pero queda el rastro de por dónde pasó.
  assert.match(r, /ubicMover/);
});

test('«si la partida ya se liquidó no se le descuenta al productor», y queda congelado', () => {
  assert.match(MANUAL, /la devolución NO se le descuenta al '\r?\n?\s*\+ 'productor/);
  assert.match(MANUAL, /queda <b>congelada<\/b>/);
  const r = trozo(SG, "router.post('/despachos/:id/devolver'", '\r\n});');
  // Se guarda en la fila de la devolución, no se recalcula después: si se
  // recalculara, liquidar más tarde cambiaría una devolución ya registrada.
  assert.match(r, /descuenta_al_productor/);
  assert.match(SG, /aviso_liquidada/);
});

test('«aplicar descuentos viene tildado y emitir remito aparte destildado»', () => {
  assert.match(MANUAL, /<b>Aplicar descuentos por proveedor<\/b> viene <b>tildado<\/b>/);
  assert.match(MANUAL, /<b>Emitir remito aparte<\/b> viene <b>destildado<\/b>/);
  const m = trozo(PANEL, 'id="sg-fd-modal"', 'id="sgfd-asiento"');
  assert.match(m, /id="sgfd-aplicar-desc" checked/);
  const remito = m.match(/<input type="checkbox" id="sgfd-emitir-remito[^>]*>/);
  assert.ok(remito, 'no está el tilde de emitir remito aparte');
  assert.ok(!/checked/.test(remito[0]), 'emitir remito aparte viene tildado, y el manual dice que no');
});

test('«la letra sale del cliente: con CUIT es A, si no B»', () => {
  assert.match(MANUAL, /Con CUIT válido es <b>A<\/b>/);
  const f = trozo(PANEL, 'function sgFdCliente(', '\r\n}');
  assert.match(f, /factura_a|'A'/);
});

test('«sin asiento modelo el comprobante sale igual pero no entra al libro»', () => {
  assert.match(MANUAL, /<b>el comprobante sale igual<\/b>/);
  assert.match(MANUAL, /<b>no entra al libro<\/b>/);
  // Y el aviso está en la solapa, sin abrir la ventana — que es lo que el manual
  // dice al final de esa sección.
  const f = trozo(PANEL, 'function sgVenSub(s){', '\r\n}');
  assert.match(f, /s==='directa'\) sgModeloCargar\('venta'\)/);
  assert.match(PANEL, /id="sgfd-modelo-falta"/);
});

test('«varios remitos entran en una sola factura»', () => {
  assert.match(MANUAL, /<b>varios remitos entran en una sola factura<\/b>/);
  // La lista es de checkboxes y la emisión manda un arreglo de remitos.
  assert.match(PANEL, /function sgFacRenderDespachos\(/);
});

// ── 3 · Y LA REGLA DE PABLO: LA VERSIÓN AL LADO ────────────────────────────

test('el manual dice desde cuándo vale cada cosa', () => {
  assert.match(MANUAL, /Qué cambió, y desde cuándo/);
  assert.match(MANUAL, /<b>V1026<\/b> — esta pantalla estrena su <b>¿Cómo se usa\?<\/b>/);
  // Y no cita una versión que el panel todavía no alcanzó.
  const SIDEBAR = fs.readFileSync(path.join(RAIZ, 'src/sidebar-v2.js'), 'utf8');
  const actual = Number((SIDEBAR.match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const v of (MANUAL.match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
    assert.ok(v <= actual, 'el manual cita la V' + v + ' y el panel va en la V' + actual);
  }
});
