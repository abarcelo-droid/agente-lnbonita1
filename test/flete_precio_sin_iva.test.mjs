// ══ EL PRECIO DEL FLETE: LA ORDEN PROPONE, SE CONFIRMA SIN IVA ════════════
//
// Pablo, 8/9/2026: «la valorización de los fletes debe venir propuesta SIEMPRE de
// la orden de compra. El administrativo "valoriza" para rechequear, y ahí debe
// ponerlo SIN IVA — aclará esto en algún lado. Y cuando se ingresa la factura,
// ahí se le adiciona el IVA».
//
// El número de la orden ya se calculaba, pero vivía en una línea gris del
// encabezado: para usarlo había que leerlo y tipearlo, y si el flete ya estaba
// valorizado quedaba de adorno.
//
// Y en el mismo viaje, los fletes valorizados ANTES de la V1015: se cargaron con
// el total del papel y tienen el IVA adentro del costo de su partida. Hasta ahora
// no había forma de saber cuáles eran sin abrirlos de a uno.
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

// ══════════════════════════════════════════════════════════════════════════
// 1 · RECONOCER UN FLETE CON EL IVA ADENTRO, CORRIDO DE VERDAD
// ══════════════════════════════════════════════════════════════════════════
//
// Es una decisión sobre plata: si se equivoca de más, le baja el costo a una
// partida que estaba bien. Se ejecuta la función, no se lee.
const detectar = (() => {
  const src = trozo(PANEL, 'function sgFeConIvaAdentro(x){', '\r\n}');
  return new Function(src + '\nreturn sgFeConIvaAdentro;')();
})();

const VIEJO = { gasto_estado: 'valorizado', gasto_monto: 121000, neto: 100000, iva_alicuota: 21 };

test('un flete valorizado con el total del papel se reconoce, y dice cuánto sobra', () => {
  const v = detectar(VIEJO);
  assert.ok(v, 'no lo reconoció');
  assert.equal(v.neto, 100000);
  assert.equal(v.iva, 21000, 'el de más tiene que ser la diferencia exacta, no una estimación');
  assert.equal(v.alic, 21);
});

test('el neto sale de lo GUARDADO, no de una cuenta con la alícuota', () => {
  // El comprobante pudo tener percepciones o redondeos: recalcular monto/1,21
  // daría otro número que el que decía el papel. El neto de entonces quedó
  // guardado y es el que vale.
  const v = detectar({ gasto_estado: 'valorizado', gasto_monto: 121000, neto: 99000, iva_alicuota: 21 });
  assert.equal(v.neto, 99000, 'lo recalculó en vez de usar el neto guardado');
});

test('uno cargado bien —sin alícuota— NO se toca', () => {
  // Desde la V1015 valorizar no guarda alícuota nunca. Es la marca.
  assert.equal(detectar({ gasto_estado: 'valorizado', gasto_monto: 100000, neto: null, iva_alicuota: null }), null);
});

test('ni uno donde el neto YA es el monto, aunque le haya quedado la alícuota', () => {
  // Alguien pudo corregirlo a mano y dejar la alícuota dando vueltas. Ofrecerle
  // «sacale el IVA» a un flete que ya está en el neto lo dejaría más barato de lo
  // que costó.
  assert.equal(detectar({ gasto_estado: 'valorizado', gasto_monto: 100000, neto: 100000, iva_alicuota: 21 }), null);
  // Y con la diferencia de un centavo por redondeo, tampoco.
  assert.equal(detectar({ gasto_estado: 'valorizado', gasto_monto: 100000.004, neto: 100000, iva_alicuota: 21 }), null);
});

test('ni uno que todavía no se valorizó', () => {
  assert.equal(detectar({ gasto_estado: 'pendiente_valorizar', gasto_monto: 121000, neto: 100000, iva_alicuota: 21 }), null);
  assert.equal(detectar(null), null);
});

test('ni uno con alícuota 0: exento no es «tiene IVA adentro»', () => {
  assert.equal(detectar({ gasto_estado: 'valorizado', gasto_monto: 121000, neto: 100000, iva_alicuota: 0 }), null);
});

test('y el neto viaja desde el backend, o no hay con qué corregir', () => {
  const q = trozo(SG, "router.get('/fletes-entrada'", '\r\n});');
  assert.match(q, /g\.iva_alicuota, g\.neto, g\.asiento_id/);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LA ORDEN PROPONE, Y SE PUEDE USAR
// ══════════════════════════════════════════════════════════════════════════

test('lo que dice la orden está al lado del campo y se toma de un clic', () => {
  const f = trozo(PANEL, 'function sgFePropuesta(x){', '\r\n}');
  assert.match(f, /La orden dice/);
  assert.match(f, /onclick="sgFeUsarOrden\(\);return false"/);
  assert.match(f, /x\.estimado_base/, 'no dice de dónde salió el número');
  assert.match(PANEL, /id="sgfe-prop"/);
});

test('y si la orden no pactó nada, lo dice en vez de dejar el campo mudo', () => {
  const f = trozo(PANEL, 'function sgFePropuesta(x){', '\r\n}');
  assert.match(f, /La orden no dejó pactado el flete/);
});

test('usar el de la orden pone el número y recalcula la diferencia', () => {
  const f = trozo(PANEL, 'function sgFeUsarOrden(){', '\r\n}');
  assert.match(f, /m\.value = sgMilShow\(x\.estimado\)/);
  assert.match(f, /sgFeDif\(\)/, 'no recalcula el aviso de diferencia contra lo estimado');
});

test('lo ya valorizado NO se pisa con la propuesta', () => {
  // Alguien lo confirmó mirando el viaje: reemplazarlo al abrir sería borrar esa
  // decisión sin avisar. La propuesta queda al lado.
  const f = trozo(PANEL, 'function sgFeOpen(recId){', '\r\n}');
  assert.match(f, /m\.value = x\.gasto_monto \? sgMilShow\(x\.gasto_monto\) : \(x\.estimado \? sgMilShow\(x\.estimado\) : ''\)/);
  assert.match(f, /sgFePropuesta\(x\);/);
});

test('sacarle el IVA deja el neto y NO guarda solo', () => {
  // Valorizar es una confirmación de una persona: que el sistema lo guarde solo
  // cambiaría el costo de una partida sin que nadie lo haya decidido.
  const f = trozo(PANEL, 'function sgFeSacarIva(){', '\r\n}');
  assert.match(f, /m\.value = sgMilShow\(v\.neto\)/);
  assert.ok(!/api\(/.test(f), 'guarda solo: tiene que confirmarlo una persona');
  assert.match(f, /Confirmá con «Guardar»/);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · SIN IVA, DICHO DONDE SE OPERA
// ══════════════════════════════════════════════════════════════════════════

test('el campo dice SIN IVA en la cara, no en una ayuda gris', () => {
  const m = trozo(PANEL, '<div class="ab-modal-overlay" id="sgfe-modal">', 'id="sgfe-arch"');
  assert.match(m, /Cuánto vale el flete <b style="color:#b45309">SIN IVA<\/b>/);
});

test('y los tres momentos están escritos en la pantalla, no sólo en el manual', () => {
  // El que valoriza no abre el manual.
  const m = trozo(PANEL, '<div class="ab-modal-overlay" id="sgfe-modal">', 'id="sgfe-arch"');
  assert.match(m, /<b>1\.<\/b> La <b>orden de compra<\/b> propone/);
  assert.match(m, /<b>2\.<\/b>[\s\S]{0,200}rechequea[\s\S]{0,200}SIN IVA/);
  assert.match(m, /<b>3\.<\/b> El <b>IVA se suma después<\/b>/);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · Y LOS VIEJOS SE VEN SIN ABRIRLOS
// ══════════════════════════════════════════════════════════════════════════

test('la fila lo dice, el pie los cuenta y el buscador los junta', () => {
  const f = trozo(PANEL, 'function sgFePintar(){', '\r\nfunction ');
  assert.match(f, /sgFeConIvaAdentro\(x\)[\s\S]{0,300}con IVA adentro/);
  assert.match(f, /var conIva = SGFE\.filas\.filter\(sgFeConIvaAdentro\)\.length/);
  assert.match(f, /conIva \+ ' flete\(s\) valorizados con el <b>IVA adentro<\/b>/);
  // Y se llega a ellos: sin esto el número dice «hay 40» y no hay cómo verlos.
  assert.match(f, /sgFeConIvaAdentro\(x\) \? ' iva adentro' : ''/);
});

test('el aviso del modal dice cuánto sobra y ofrece el neto', () => {
  const f = trozo(PANEL, 'function sgFePropuesta(x){', '\r\n}');
  assert.match(f, /Este flete tiene el IVA adentro/);
  assert.match(f, /sgMoney\(v\.iva\)/, 'no dice cuánto está de más');
  assert.match(f, /sgMoney\(v\.neto\)/);
  assert.match(f, /onclick="sgFeSacarIva\(\);return false"/);
  assert.match(PANEL, /id="sgfe-iva-viejo"/);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · EL MANUAL VA CON EL CAMBIO
// ══════════════════════════════════════════════════════════════════════════

test('el «¿cómo se usa?» explica los tres momentos y los viejos, con su versión', () => {
  assert.match(PANEL, /El precio del flete: la orden propone, vos confirmás sin IVA[\s\S]{0,90}V1024/);
  assert.match(PANEL, /Los fletes viejos que tienen el IVA adentro[\s\S]{0,90}V1024/);
  // Y dice POR QUÉ sin IVA, que es lo que hace que no se lo saltee nadie.
  assert.match(PANEL, /el IVA es <b>crédito fiscal recuperable<\/b>, no es costo/);
});
