// ══ EL SIGNO PESOS DONDE HAY PLATA ════════════════════════════════════════
//
// Pablo, 8/9/2026: «poneme signo pesos donde corresponda».
//
// En Facturar en el puesto los campos de plata se veían pelados —25000, 500000,
// 350000— mientras el resto de la pantalla habla en $1.100.000. Un campo que dice
// 25000 al lado de uno que dice 44 no se distingue de una cantidad, y es la manera
// de tipear el precio en el campo de los cajones.
//
// El riesgo del arreglo NO es visual: es que un campo que muestra «$25.000» se lea
// con Number() y dé NaN, o que «500.000» se lea como 500. Por eso el test se mete
// con la lectura y no con el formato.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

// ── El lector de plata del panel, corrido de verdad ────────────────────────
const liqNum = (() => {
  const src = trozo(PANEL, 'function liqNum(el){', '\r\n}');
  return new Function(src + '\nreturn liqNum;')();
})();
const liqPlata = (() => {
  const src = trozo(PANEL, 'function liqPlata(n){', '\r\n}');
  return new Function(src + '\nreturn liqPlata;')();
})();

test('lo que el campo muestra, el sistema lo vuelve a leer igual', () => {
  // Es la ida y vuelta completa: se guarda 25000, se muestra con signo, y al
  // volver a leerlo tiene que dar 25000. Si no, el precio cambia solo al salir
  // del campo.
  for (const n of [25000, 500000, 350000, 1100000, 2083.5, 0.5, 1500002.4]) {
    assert.equal(liqNum({ value: liqPlata(n) }), n, 'no vuelve el mismo número: ' + n);
  }
});

test('«500.000» son quinientos mil, no quinientos', () => {
  // Number('500.000') da 500: el punto de mil leído como decimal es la forma de
  // cobrar mil veces menos sin que nadie toque nada.
  assert.equal(liqNum({ value: '500.000' }), 500000);
  assert.equal(liqNum({ value: '$500.000,00' }), 500000);
  assert.equal(liqNum({ value: '1.100.000' }), 1100000);
  // Y un punto que SÍ es decimal se sigue leyendo bien.
  assert.equal(liqNum({ value: '1500002.4' }), 1500002.4);
});

test('el signo no rompe la lectura', () => {
  assert.equal(liqNum({ value: '$25.000,00' }), 25000);
  assert.equal(liqNum({ value: '$ 25000' }), 25000);
  assert.equal(liqNum({ value: '' }), 0);
});

// ── El precio de cada renglón ──────────────────────────────────────────────

test('el precio se muestra con signo', () => {
  const f = trozo(PANEL, 'function sgFdPrecioTexto(it){', '\r\n}');
  assert.match(f, /liqPlata\(v\)/);
  // Vacío es vacío: un «$0,00» en un campo sin precio parece un precio cargado.
  assert.match(f, /v === '' \? '' :/);
});

test('y el campo del precio dejó de ser un número pelado', () => {
  const r = trozo(PANEL, "+'<input type=\"text\" inputmode=\"decimal\" placeholder=\"'+(u==='bulto'?'$/bulto':'$/kg')", '>\'');
  assert.match(r, /onfocus="liqNumFoco\(this\)" onblur="liqNumSalida\(this\)"/);
  assert.match(r, /sgFdPrecioTexto\(it\)/);
  // Y ya no queda el type="number" viejo, que no admite el punto de mil.
  assert.ok(!/type="number" placeholder='\+\(u==='bulto'/.test(PANEL));
});

test('guardar el precio LEE el formato, no Number()', () => {
  // Con «$25.000», Number() da NaN y el precio se borraba solo al salir del campo.
  const f = trozo(PANEL, 'function sgFdSetPrecio(i, v){', '\r\n}');
  assert.match(f, /var n = liqNum\(\{ value: v \}\)/);
  assert.ok(!/var n = Number\(v\)/.test(f), 'sigue leyendo con Number()');
  // Y un campo vacío o un cero siguen borrando el precio, no poniendo NaN.
  assert.match(f, /if \(!v \|\| !n\) \{ it\.precio = ''/);
});

test('el precio por bulto sigue guardándose por kilo', () => {
  // Lo que cambió es cómo se lee el campo, no la cuenta: adentro siempre va $/kg.
  const f = trozo(PANEL, 'function sgFdSetPrecio(i, v){', '\r\n}');
  assert.match(f, /sgFdUnidad\(it\) === 'bulto' && kpb > 0\) \? \+\(n \/ kpb\)\.toFixed\(6\) : n/);
});

// ── Lo que se cobra ────────────────────────────────────────────────────────

test('cada medio de pago muestra su importe con signo', () => {
  const f = trozo(PANEL, 'function sgFdMedioMonto(m){', '\r\n}');
  assert.match(f, /liqNum\(\{ value: m\.monto \}\)/);
  assert.match(f, /n \? liqPlata\(n\) : ''/);
  const r = trozo(PANEL, "+ '<label style=\"font-size:11px;color:var(--mut)\">Cuánto<br>'", '</label>\'');
  assert.match(r, /sgFdMedioMonto\(m\)/);
  assert.match(r, /onfocus="liqNumFoco\(this\)"/);
});

test('y al salir del campo el valor formateado vuelve al modelo', () => {
  // Si sólo se formateara el input, el próximo redibujado lo mostraría pelado
  // otra vez y parecería que se perdió lo cargado.
  const r = trozo(PANEL, "+ '<label style=\"font-size:11px;color:var(--mut)\">Cuánto<br>'", '</label>\'');
  assert.match(r, /onblur="liqNumSalida\(this\);' \+ up\(i, 'monto'\)/);
});

test('la suma de lo cobrado sigue leyéndose con liqNum', () => {
  // Es el número que decide cuánto queda en cuenta corriente. Con Number() sobre
  // «$500.000,00» daría 0 y el comprobante saldría entero a la cuenta.
  const f = trozo(PANEL, 'function sgFdCobroPie(){', '\r\n}');
  assert.match(f, /liqNum\(\{ value: m\.monto \}\)/);
  const g = trozo(PANEL, 'function sgFdPagoFalta(){', '\r\n}');
  assert.match(g, /liqNum\(\{ value: m\.monto \}\)/);
});

test('y lo que se manda a emitir, también', () => {
  const i = PANEL.indexOf('SG_FD_MEDIOS.forEach(function(m){');
  assert.ok(i > 0);
  assert.match(PANEL.slice(i, i + 400), /liqNum\(\{ value: m\.monto \}\)/);
});

test('los cajones NO llevan signo: no son plata', () => {
  // El campo de al lado dice 44 y es una cantidad. Ponerle $ sería peor que no
  // ponérselo al precio.
  assert.match(PANEL, /<input type="number" placeholder="cj"/);
});

// ── Y la pantalla de Cobranzas, que es la misma caja con otro prefijo ──────

test('en Cobranzas cada medio también muestra su importe con signo', () => {
  // Pablo, 8/9/2026: «acá también arreglame los signos pesos».
  const f = trozo(PANEL, 'function sgCobMedioMonto(m){', '\r\n}');
  assert.match(f, /liqNum\(\{ value: m\.monto \}\)/);
  assert.match(f, /n \? liqPlata\(n\) : ''/);
  const r = trozo(PANEL, "+ '<label style=\"font-size:11px;color:var(--mut)\">Cuánto<br>'\r\n        + '<input type=\"text\" inputmode=\"decimal\" value=\"' + escH(sgCobMedioMonto(m))", '</label>\'');
  assert.match(r, /onfocus="liqNumFoco\(this\)"/);
  assert.match(r, /onblur="liqNumSalida\(this\);' \+ up\(i, 'monto'\)/);
});

test('y lo que Cobranzas suma sigue leyendo bien el formato', () => {
  // sgMilParse es el lector de esa pantalla: tiene que devolver el mismo número
  // que se muestra, o el total cobrado no coincide con la suma de los renglones.
  const parse = (() => {
    const src = trozo(PANEL, 'function sgMilParse(str){', '\r\n}');
    return new Function(src + '\nreturn sgMilParse;')();
  })();
  for (const n of [1000000, 350000, 1350000, 2083.5]) {
    assert.equal(parse(liqPlata(n)), n, 'no vuelve el mismo número: ' + n);
  }
  assert.equal(parse('$1.000.000,00'), 1000000);
});
