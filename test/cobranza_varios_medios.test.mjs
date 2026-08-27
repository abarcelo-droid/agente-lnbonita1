// ══ LA COBRANZA ACEPTA VARIOS MEDIOS, Y CADA UNO SU MITAD ══════════════════
//
// Pablo, 27/8/2026: «debe seleccionar cómo cancela la parte que se facturó y cómo
// la parte que es de gestión».
//
// El modal aceptaba UN solo medio, aunque el servidor los acepta desde el 25/8 y
// la venta de ventanilla ya los usaba. Un cliente que pagaba mitad en efectivo y
// mitad por transferencia obligaba a cargar DOS cobranzas para un solo pago — y no
// había forma de decir qué medio cancelaba qué mitad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const cuerpo = (nombre) => {
  const i = PANEL.indexOf('function ' + nombre + '(');
  assert.ok(i > 0, 'no encontré ' + nombre);
  let d = 0, j = PANEL.indexOf('{', i);
  for (; j < PANEL.length; j++) {
    if (PANEL[j] === '{') d++;
    else if (PANEL[j] === '}') { d--; if (d === 0) { j++; break; } }
  }
  return PANEL.slice(i, j);
};

test('el modal tiene renglones de pago, no un medio suelto', () => {
  assert.match(PANEL, /id="sg-cob-medios"/);
  assert.match(PANEL, /onclick="sgCobMedioAdd\(\)"/);
  assert.match(PANEL, /function sgCobMediosRender\(\)\{/);
  // Y los campos sueltos de antes ya no están.
  assert.ok(!PANEL.includes('id="sg-cob-forma"'), 'quedó el selector único de forma');
  assert.ok(!PANEL.includes('id="sg-cob-cuenta"'), 'quedó el selector único de cuenta');
});

test('cada renglón dice contra qué mitad va', () => {
  const b = cuerpo('sgCobMediosRender');
  assert.match(b, /\['', 'Lo que toque'\], \['fiscal', 'Lo facturado'\], \['gestion', 'Lo que falta facturar'\]/);
  // Y sólo se pregunta si hay una mitad sin facturar: si no, es una pregunta sin
  // respuesta posible.
  assert.match(b, /var hayGes = sgCobHayGestion\(\)/);
  assert.match(b, /hayGes \? '<label/);
  assert.match(cuerpo('sgCobHayGestion'), /Number\(d\.pendiente_gestion\) > 0\.009/);
});

test('el ámbito viaja al servidor en cada medio', () => {
  const b = cuerpo('sgCobGuardar');
  assert.match(b, /ambito: m\.ambito \|\| null/);
  assert.match(b, /medios: medios,/);
  // Y ya no manda el medio suelto de antes.
  assert.ok(!/cuenta_fin_id: esChq \? null : Number\(cuenta\)/.test(b));
});

test('tipear el importe NO redibuja el renglón', () => {
  // Es el bug del «un dígito por vez» que ya se arregló en la ventanilla: no hay
  // que repetirlo acá.
  const b = cuerpo('sgCobMedioUpd');
  assert.match(b, /if \(campo === 'forma'\) \{ sgCobMediosRender\(\); return; \}/);
  const tras = b.slice(b.indexOf("if (campo === 'forma')") + 40);
  assert.ok(!tras.includes('sgCobMediosRender()'));
  assert.match(b, /sgCobMediosPie\(\);/);
});

test('las cuentas bancarias se filtran por la negativa', () => {
  // El tipo «banco» no existe: son caja, cuenta_corriente y caja_ahorro. Es el
  // mismo error que dejaba la ventanilla sin poder cobrar por transferencia.
  const b = cuerpo('sgCobMediosRender');
  assert.match(b, /var caja = String\(c\.tipo\) === 'caja';/);
  assert.match(b, /esCaja \? caja : !caja/);
});

test('el total es la SUMA de los renglones, no un campo aparte', () => {
  // Tenerlo en dos lados era la forma más fácil de que dijeran cosas distintas.
  assert.match(PANEL, /<input type="hidden" id="sg-cob-monto">/);
  const b = cuerpo('sgCobMediosPie');
  assert.match(b, /var h = eid\('sg-cob-monto'\); if \(h\) h\.value = String\(t\);/);
});

test('un renglón sin cuenta o un cheque sin número no salen', () => {
  const b = cuerpo('sgCobGuardar');
  assert.match(b, /elegí en qué cuenta entra la plata/);
  assert.match(b, /por lo menos el número y quién lo firma/);
  assert.match(b, /if \(!medios\.length\) \{ toast\('Poné cuánto se cobró'/);
});

test('DOS CHEQUES NO: al anular sólo vuelve el primero a la cartera', () => {
  // Es un bug conocido del backend. Ofrecerlo sería dejar el segundo vivo contra
  // una cobranza que ya no existe. Se avisa en vez de romper.
  const b = cuerpo('sgCobGuardar');
  assert.match(b, /if \(cheques > 1\)/);
  assert.match(b, /sólo vuelve el primero a la cartera/);
});

test('el cuadro del asiento ESPEJA los renglones', () => {
  // Dibujaba siempre dos renglones por el total. El servidor arma un par por cada
  // medio y por cada ámbito: con dos medios y dos mitades el asiento real tiene
  // cuatro y el cuadro mostraba dos. El cuadro existe para poder frenar antes de
  // confirmar; si miente, no sirve.
  const b = cuerpo('sgCobAsientoPintar');
  assert.match(b, /\(SG_COB\.medios \|\| \[\]\)\.forEach/);
  assert.match(b, /m\.ambito === 'gestion' \? ' · gestión'/);
  assert.match(b, /SG_COB\.cartera/, 'el cheque va contra cheques en cartera, no contra el banco');
  assert.ok(!/debe: total, haber: 0/.test(b), 'quedó el cuadro viejo de dos renglones');
});

test('el modal arranca limpio: ni renglones ni ámbito de la vez anterior', () => {
  const b = cuerpo('sgCobOpen');
  assert.match(b, /sgCobMedioAdd\(\);/);
  assert.match(b, /var amb = eid\('sg-cob-ambito'\); if \(amb\) amb\.value = 'todo';/);
});

test('los renglones se repintan cuando llegan las cuentas', () => {
  // Se dibujan antes de que la respuesta vuelva, así que sus desplegables salen
  // vacíos. Y acá había un `return` temprano que cortaba el repintado.
  assert.match(PANEL, /sgCobMediosRender\(\);\r?\n\s*sgCobAsientoPintar\(\);/);
  assert.ok(!/var sel = eid\('sg-cob-cuenta'\); if \(!sel\) return;/.test(PANEL));
});
