// ══ EL PRECIO DE LA ORDEN SE LLAMA PRECIO, Y VA CON IVA ════════════════════
//
// Pablo, 27/8/2026: «para el comprador es mejor ver el precio CON IVA. Después
// nosotros cuando saquemos costos lo vamos a ajustar tranquilo, pero que la
// columna se llame PRECIO y mostralo con IVA».
//
// El campo decía «$/bulto» a secas y no decía si ese número llevaba IVA: eso vivía
// en dos radios arriba de todo, fuera de la vista mientras se cargan los renglones.
// El comprador cierra en bruto —«el cajón me sale 25 lucas»— y ése es el número que
// tiene que poder tipear sin hacer ninguna cuenta.
//
// Y el subtotal del renglón mostraba lo tipeado × la cantidad: con el precio
// cargado en NETO, ese número no es lo que se le va a pagar al proveedor. El
// comprador lo comparaba contra el remito y no le daba.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const bloque = (nombre, largo = 2600) => {
  const i = PANEL.indexOf('function ' + nombre + '(');
  assert.ok(i > 0, 'no encontré ' + nombre);
  return PANEL.slice(i, i + largo);
};

test('el campo se llama Precio', () => {
  const b = bloque('sgOcRenderItems', 5000);
  assert.match(b, /var precioPh = 'Precio ' \+ unidadPh/);
  // Y ya no se dibuja el placeholder pelado de antes.
  assert.ok(!/var precioPh = bulto \? '\$\/bulto' : '\$\/kg';/.test(PANEL),
    'quedó el placeholder viejo');
});

test('y dice si el número lleva IVA o no', () => {
  // Sin esto hay que subir a mirar dos radios para saber qué se está tipeando.
  const b = bloque('sgOcRenderItems', 5000);
  assert.match(b, /\? ' c\/IVA' : ' neto'/);
  assert.match(b, /var conIva = sgOcDiscrimina\(\) && sgOcIncluyeIva\(\)/);
  // Con un comprobante que no discrimina, no se dice nada: no habría qué decir.
  assert.match(b, /sgOcDiscrimina\(\) \? \(conIva \? ' c\/IVA' : ' neto'\) : ''/);
});

test('arranca en «el precio ya incluye IVA»', () => {
  // Es como se compra: el comprador cierra en bruto.
  assert.match(PANEL, /name="sg-oc-inciva" value="si" checked/);
  assert.match(PANEL, /input\[name="sg-oc-inciva"\]\[value="si"\]'\)\.checked=true/);
});

test('el renglón muestra lo que se va a PAGAR, con IVA', () => {
  const b = bloque('sgOcTotales', 3000);
  assert.match(b, /var lineaNeto = bruto, lineaIva = 0;/);
  assert.match(b, /var lineaTotal = lineaNeto \+ lineaIva;/);
  assert.match(b, /subEl\.textContent = sgMoney\(Math\.round\(lineaTotal\)\)/);
  // Y ya no muestra lo tipeado × cantidad a secas.
  assert.ok(!/if\(subEl\) subEl\.textContent=sgMoney\(Math\.round\(bruto\)\);/.test(PANEL),
    'quedó el subtotal viejo, que con precio neto miente');
});

test('el desglose queda a mano, sin ocupar lugar', () => {
  const b = bloque('sgOcTotales', 3000);
  assert.match(b, /subEl\.title = lineaIva > 0/);
  assert.match(b, /'Neto ' \+ sgMoney\(Math\.round\(lineaNeto\)\)/);
  assert.match(b, /' \+ IVA ' \+ sgMoney\(Math\.round\(lineaIva\)\)/);
});

test('el total de la orden sigue saliendo de la misma cuenta', () => {
  // El renglón cambió cómo MUESTRA, no cómo suma: los acumuladores del total
  // siguen siendo los mismos, o el pie de la orden diría otra cosa que los
  // renglones que tiene arriba.
  const b = bloque('sgOcTotales', 3000);
  assert.match(b, /tNeto\+=neto; tIva\+=bruto-neto;/);
  assert.match(b, /tNeto\+=bruto; tIva\+=bruto\*alic\/100;/);
  assert.match(b, /tBruto \+= bruto;/);
});

test('la cuenta del neto y el IVA, corriéndola', () => {
  // 45 cajones a $25.000 con IVA adentro, alícuota 10,5%.
  const bruto = 45 * 25000;
  const neto = bruto / 1.105;
  assert.equal(Math.round(neto), 1018100);
  assert.equal(Math.round(bruto - neto), 106900);
  assert.equal(Math.round(neto) + Math.round(bruto - neto), 1125000);
  // Y al revés: cargado en neto, el IVA se adiciona y el renglón muestra el total.
  const netoCargado = 45 * 25000;
  assert.equal(Math.round(netoCargado * 1.105), 1243125);
});

test('una familia sin alícuota no inventa un IVA', () => {
  // Se suma al neto y el renglón muestra ese mismo número: mejor un total sin
  // desglose que un IVA salido de una alícuota que nadie cargó.
  const b = bloque('sgOcTotales', 3000);
  assert.match(b, /if\(alic==null\)\{ tNeto \+= bruto; \}/);
});
