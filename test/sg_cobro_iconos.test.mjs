// ══ EL COBRO SE ELIGE COMO EL PAGO ═════════════════════════════════════════
//
// Pablo, 28/8/2026: «en los circuitos de cobranzas usemos íconos como tenemos en
// los de pagos: es más lindo y más intuitivo para los cajeros».
//
// El pago a proveedores elige el medio con botones grandes y un ícono; el cobro
// lo elegía con un desplegable adentro de un renglón ya cargado. Es el mismo
// gesto —«con qué entra o sale esta plata»— y el cajero, que hace veinte por
// día, tenía que abrir una lista y leer para hacer lo que del otro lado se hace
// de un vistazo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const cuerpo = (nombre, largo = 2600) => {
  const i = PANEL.indexOf(nombre);
  assert.ok(i > 0, 'no existe ' + nombre);
  return PANEL.slice(i, i + largo);
};

// ── UNA SOLA DEFINICIÓN ────────────────────────────────────────────────────

test('los íconos se definen UNA vez para las dos pantallas de cobro', () => {
  // Si cada una eligiera el suyo, en tres meses el efectivo sería un billete en
  // una y una caja en la otra.
  assert.match(PANEL, /var SG_MEDIO = \{/);
  assert.equal((PANEL.match(/var SG_MEDIO = \{/g) || []).length, 1);
  const b = cuerpo('var SG_MEDIO = {', 400);
  assert.match(b, /efectivo:\s+\{ i: '💵', t: 'Efectivo' \}/);
  assert.match(b, /transferencia: \{ i: '🏦', t: 'Transferencia' \}/);
  assert.match(b, /cheque:\s+\{ i: '🧾', t: 'Cheque de tercero' \}/);
});

test('y son los MISMOS que ya usa el pago a proveedores', () => {
  // Es el punto del pedido: que las dos pantallas hablen igual.
  const i = PANEL.indexOf("onclick=\"sgPagoMedioAdd('efectivo')\"");
  assert.ok(i > 0, 'no está la botonera del pago');
  const b = PANEL.slice(i - 200, i + 700);
  assert.match(b, /<span class="sg-fp-i">💵<\/span><span>Caja<\/span>/);
  assert.match(b, /<span class="sg-fp-i">🧾<\/span><span>Cheque<\/span>/);
  assert.match(b, /<span class="sg-fp-i">🏦<\/span><span>Transferencia<\/span>/);
  // Y el cobro reusa la MISMA clase de botón, no una copia.
  assert.match(PANEL, /function sgMedioBotones\(onAdd, formas\)\{/);
  assert.match(cuerpo('function sgMedioBotones(onAdd, formas){', 900), /class="sg-fp-b"/);
  assert.equal((PANEL.match(/\.sg-fp-b\{/g) || []).length, 1);
});

test('el orden es el del pago: caja, cheque, transferencia', () => {
  const b = cuerpo('function sgMedioBotones(onAdd, formas){', 900);
  assert.match(b, /\['efectivo', 'cheque', 'transferencia'\]/);
});

// ── LAS DOS PANTALLAS ──────────────────────────────────────────────────────

test('facturación directa: se agrega el medio desde la botonera', () => {
  assert.match(PANEL, /id="sgfd-cobro-botones"/);
  assert.match(PANEL, /sgMedioBotones\('sgFdMedioAdd'\)/);
  // Y el «+ otro medio» que agregaba un renglón vacío ya no está.
  assert.ok(!/onclick="sgFdMedioAdd\(\)">\+ otro medio/.test(PANEL));
});

test('cobranzas: lo mismo', () => {
  assert.match(PANEL, /id="sg-cob-botones"/);
  assert.match(PANEL, /sgMedioBotones\('sgCobMedioAdd'\)/);
  assert.ok(!/onclick="sgCobMedioAdd\(\)">\+ otro medio/.test(PANEL));
});

test('el botón dice QUÉ agrega, y la función lo recibe', () => {
  // Antes se agregaba un renglón vacío y después había que decirle qué era: dos
  // pasos para una sola decisión.
  const b = cuerpo('function sgMedioBotones(onAdd, formas){', 900);
  assert.match(b, /onclick="' \+ onAdd \+ '\(/);
  assert.match(b, /\+ f \+ /);
  assert.match(cuerpo('function sgFdMedioAdd(forma){', 400), /SG_MEDIO\[forma\] \? forma : 'efectivo'/);
  assert.match(cuerpo('function sgCobMedioAdd(forma){', 500), /SG_MEDIO\[forma\] \? forma : 'transferencia'/);
});

test('y sin forma sigue andando: el default es el de antes', () => {
  // Por si algo llama a la función sin argumento, no queda un renglón roto.
  const i = PANEL.indexOf('function sgFdMedioAdd(forma){');
  const src = PANEL.slice(i, PANEL.indexOf('\n}', i) + 2);
  // eslint-disable-next-line no-new-func
  const f = new Function('SG_MEDIO', 'SG_FD_MEDIOS', 'sgFdMediosRender', src + '; return sgFdMedioAdd;');
  const arr = [];
  f({ efectivo: 1, cheque: 1, transferencia: 1 }, arr, function(){})();
  assert.equal(arr[0].forma, 'efectivo');
  const arr2 = [];
  f({ efectivo: 1, cheque: 1, transferencia: 1 }, arr2, function(){})('cheque');
  assert.equal(arr2[0].forma, 'cheque');
  const arr3 = [];
  f({ efectivo: 1 }, arr3, function(){})('inventado');
  assert.equal(arr3[0].forma, 'efectivo', 'una forma que no existe no entra');
});

// ── EL RENGLÓN YA CARGADO ──────────────────────────────────────────────────

test('el renglón dice qué es con el mismo ícono, no con un desplegable', () => {
  // Una vez elegida, la forma es un hecho: repetir la lista en cada renglón
  // invita a cambiarla por accidente mientras se tipea el importe.
  assert.match(PANEL, /function sgMedioChip\(forma\)\{/);
  assert.match(cuerpo('function sgFdMediosRender(){', 4000), /sgMedioChip\(m\.forma\)/);
  assert.match(cuerpo('function sgCobMediosRender(){', 6000), /sgMedioChip\(m\.forma\)/);
  // Y los dos desplegables de «Cómo» ya no están.
  assert.ok(!/>Cómo<br>'\s*\n?\s*\+ '<select onchange="' \+ up\(i, 'forma'\)/.test(PANEL));
});

test('el chip tiene su propio estilo, no el del botón', () => {
  // Es un hecho, no algo para apretar: sin borde de botón y más chico.
  assert.match(PANEL, /\.sg-fp-chip\{display:inline-flex/);
  assert.match(PANEL, /\.sg-fp-chip \.sg-fp-i\{font-size:15px\}/);
});

test('se saca con la ×, que es como se cambia de forma', () => {
  // Sacar y volver a agregar es un clic, igual que en el pago.
  assert.match(cuerpo('function sgFdMediosRender(){', 4000), /sgFdMedioDel\(' \+ i \+ '\)/);
  assert.match(cuerpo('function sgCobMediosRender(){', 6000), /sgCobMedioDel\(' \+ i \+ '\)/);
});

// ── LO QUE NO CAMBIÓ ───────────────────────────────────────────────────────

test('cada forma sigue pidiendo lo suyo', () => {
  const fd = cuerpo('function sgFdMediosRender(){', 4000);
  assert.match(fd, /A qué caja' : 'A qué cuenta'/);
  assert.match(fd, /N° de cheque' : 'Referencia'/);
  const cob = cuerpo('function sgCobMediosRender(){', 6000);
  assert.match(cob, /Banco<br>/);
  assert.match(cob, /CUIT del librador<br>/);
  // Y el ámbito, que es de esta pantalla y no del pago.
  assert.match(cob, /\['', 'Lo que toque'\], \['fiscal', 'Lo facturado'\], \['gestion', 'Lo que falta facturar'\]/);
});

test('el pie sigue diciendo cuánto falta', () => {
  assert.match(PANEL, /queda saldado/);
  assert.match(PANEL, /quedan ' \+ sgMoney2\(falta\) \+ ' en la cuenta corriente/);
});
