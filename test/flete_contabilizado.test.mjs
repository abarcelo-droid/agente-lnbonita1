// ══ EL FLETE DEL FLETERO: PRIMERO SE VALORIZA, DESPUÉS SE FACTURA ══════════
//
// Pablo, 7/9/2026: «el modelo de flete de entrada es este, para valorizar: acá
// simplifiquemos, sólo poner precio, que justamente es valorizar. Y luego
// necesito lo que me pusiste de contabilizar factura en cooperativas: replicá lo
// mismo para fletes de entrada».
//
// ── QUÉ DECÍA ESTE ARCHIVO ANTES, Y POR QUÉ CAMBIÓ ─────────────────────────
//
// Nació el 27/8/2026 con otro pedido: «deberíamos poder cargar y contabilizar la
// factura de los fleteros ahí mismo». Y se resolvió metiendo la factura ADENTRO
// de la pantalla de valorizar: número de comprobante, alícuota de IVA, PDF y
// asiento, todo en el modal que se llama «Valorizar». Los tests de acá clavaban
// eso: «no hay factura sin su asiento, van en la misma transacción».
//
// El circuito correcto es el de tres tiempos que ya usa Control Cooperativa: el
// flete existe, se VALORIZA (cuánto vale, y con eso entra al costo del lote) y
// después llega el papel, que lo pisa y lo contabiliza. Los tests que clavaban el
// asiento al valorizar se reescribieron; los de la aritmética siguen igual,
// porque la cuenta no cambió de lugar.
//
// Y ADEMÁS ARREGLA UN PROBLEMA DE PLATA. Se cargaba el TOTAL del papel y ese
// total entraba al costo del lote CON EL IVA ADENTRO: la mercadería figuraba
// costando un 21% más de lo que costó y el margen de todo lo que se vendiera de
// ella salía bajo. El IVA es crédito fiscal recuperable, no es costo. Ahora se
// carga el precio SIN IVA, como en la descarga.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// Las funciones puras del router, sacadas del archivo y ejecutadas. Son la
// aritmética donde un signo cambia lo que se le paga al fletero.
function fn(nombre, extra = '') {
  const i = SG.indexOf('function ' + nombre + '(');
  assert.ok(i > 0, 'no encontré ' + nombre);
  let d = 0, j = SG.indexOf('{', i);
  for (; j < SG.length; j++) {
    if (SG[j] === '{') d++;
    else if (SG[j] === '}') { d--; if (d === 0) { j++; break; } }
  }
  return new Function('r2', extra + SG.slice(i, j) + '; return ' + nombre + ';')(
    (n) => Math.round((Number(n) || 0) * 100) / 100);
}

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  return txt.slice(i, txt.indexOf(cierre, i) + cierre.length);
};

// ── EL NETO Y EL IVA ───────────────────────────────────────────────────────
//
// montosDeFlete sigue existiendo y sigue siendo la misma cuenta: ahora la usa la
// FACTURA (montosDeFacturaGasto la llama), que es donde está el total del papel.

test('del total se despeja el neto a la alícuota general', () => {
  const m = fn('montosDeFlete')({ monto: 121000 });
  assert.equal(m.total, 121000);
  assert.equal(m.neto, 100000);
  assert.equal(m.iva_monto, 21000);
  assert.equal(m.iva_alicuota, 21);
});

test('EL TOTAL NO SE TOCA NUNCA', () => {
  // Es lo que dice el papel y lo que se le paga al fletero. El neto es una
  // cuenta que se hace para el asiento, no un número que reemplace al total.
  for (const t of [1, 999.99, 121000, 1234567.89]) {
    assert.equal(fn('montosDeFlete')({ monto: t }).total, t);
  }
});

test('otra alícuota se respeta', () => {
  const m = fn('montosDeFlete')({ monto: 110500, iva_alicuota: 10.5 });
  assert.equal(m.neto, 100000);
  assert.equal(m.iva_monto, 10500);
});

test('exento: todo va al neto y no hay IVA', () => {
  const m = fn('montosDeFlete')({ monto: 50000, iva_alicuota: 0 });
  assert.equal(m.neto, 50000);
  assert.equal(m.iva_monto, 0);
});

test('si la factura trae neto e IVA por separado, mandan esos', () => {
  // Un comprobante con percepciones no cierra con la cuenta de arriba. Lo que
  // dice el papel gana sobre lo que se despeja.
  const m = fn('montosDeFlete')({ monto: 130000, neto: 100000, iva_monto: 21000 });
  assert.equal(m.total, 130000);
  assert.equal(m.neto, 100000);
  assert.equal(m.iva_monto, 21000);
});

// ── VALORIZAR ES PONER EL PRECIO ───────────────────────────────────────────

function valorizar() {
  return trozo(SG, "router.post('/fletes-entrada/:recepcionId/valorizar'", '\r\n});');
}

test('valorizar NO genera asiento: eso ahora sale de la factura', () => {
  // Asentar sin comprobante era anotar en el libro una compra que todavía no
  // tenía papel — y obligaba a tipear el número de la factura en la pantalla de
  // valorizar, que es lo que Pablo pidió sacar.
  const v = valorizar();
  assert.ok(!/crearAsiento\(/.test(v), 'valorizar sigue escribiendo un asiento');
  assert.ok(!/asientoDeFlete\(/.test(v));
  assert.match(v, /NO SE ASIENTA ACÁ/);
  // Y el armador del asiento del flete y su preview se fueron: sin llamador eran
  // código que dice que existe un asiento que ya no se hace ahí.
  assert.ok(!/function asientoDeFlete\(/.test(SG), 'quedó el armador sin usar');
  assert.ok(!/fletes-entrada\/asiento-preview/.test(SG), 'quedó el preview sin usar');
});

test('valorizar sólo pide a quién se le paga y cuánto', () => {
  const v = valorizar();
  assert.match(v, /const monto = r2\(b\.monto\);/);
  assert.match(v, /const fletero = Number\(b\.proveedor_servicio_id\);/);
  // Lo que se fue: el comprobante y la alícuota son de la factura, no de acá.
  assert.ok(!/cuenta_ref/.test(v), 'sigue pidiendo el número de comprobante');
  assert.ok(!/montosDeFlete\(b\)/.test(v), 'sigue despejando el IVA al valorizar');
  assert.ok(!/iva_alicuota/.test(v));
});

test('y el precio es SIN IVA, porque es lo que entra al costo', () => {
  // recalcCostoLote suma sg_gastos_directos.monto. Con el total del papel, ese
  // monto traía el IVA adentro y la partida salía un 21% más cara.
  const r = trozo(SG, 'function recalcCostoLote(', '\r\n}');
  assert.match(r, /SUM\(g\.monto\)/);
  assert.match(r, /g\.tipo_gasto IN \('descarga_ingreso','flete_entrada'\)/);
  // Y la pantalla lo dice, o el que carga pone el total del papel igual.
  const i = PANEL.indexOf('id="sgfe-modal"');
  const m = PANEL.slice(i, i + 3000);
  assert.match(m, /Cuánto vale el flete \(sin IVA\)/);
  assert.match(m, /va <b>sin IVA<\/b>/);
});

test('el modal de valorizar ya no es una carga de factura', () => {
  const i = PANEL.indexOf('id="sgfe-modal"');
  const m = PANEL.slice(i, i + 3000);
  for (const id of ['sgfe-ref', 'sgfe-alic', 'sgfe-arch-file', 'sgfe-asiento', 'sgfe-desglose']) {
    assert.ok(!m.includes('id="' + id + '"'), 'sigue estando el campo ' + id);
  }
  // Queda lo que es valorizar: a quién, cuánto y cuándo.
  assert.match(m, /id="sgfe-fletero"/);
  assert.match(m, /id="sgfe-monto"/);
  assert.match(m, /id="sgfe-fecha"/);
  // Y manda al lugar donde sí se contabiliza.
  assert.match(m, /🧾 Ingresar factura/);
});

test('el PDF de los fletes ya valorizados sigue siendo alcanzable', () => {
  // Subirlo se fue a la factura, pero los que ya lo tenían colgado del gasto
  // quedaban guardados y sin forma de abrirlos. Se muestra el link cuando existe.
  // Se EJECUTA, no se le mira el texto: un `return ''` antes del link deja la
  // cadena en el archivo y el test pasaría igual con la pantalla rota.
  const f = new Function(trozo(PANEL, 'function sgFeArchLink(x){', '\r\n}')
    + '\r\nreturn sgFeArchLink;')();
  const html = f({ tiene_archivo: 1, gasto_id: 42 });
  assert.match(html, /\/api\/sg\/gastos-directos\/42\/archivo\?inline=1/);
  assert.match(html, /target="_blank"/);
  // Y sin archivo no se ofrece un link que no abre nada.
  assert.equal(f({ tiene_archivo: 0, gasto_id: 42 }), '');
  assert.equal(f(null), '');
  // Y no hay dónde subir uno nuevo desde acá.
  assert.ok(!/function sgFeArchSubir\(/.test(PANEL), 'quedó el botón de subir');
});

test('lo que sí sigue igual: el flete del vendedor no se valoriza', () => {
  // Si lo paga el productor ya viene adentro del precio y no hay factura de
  // fletero que cargar. Se valoriza sólo si lo ADELANTÓ San Gerónimo.
  const v = valorizar();
  assert.match(v, /rec\.flete_a_cargo === 'vendedor' && rec\.flete_pagado_por !== 'san_geronimo'/);
  assert.match(v, /ya viene adentro del precio/);
});

test('y que el costo del lote se rehace en la misma transacción', () => {
  // Valorizar sin rehacer el costo deja la partida con el costo viejo y nadie se
  // entera: el número sigue estando, sólo que mal.
  const v = valorizar();
  assert.match(v, /recalcCostoLote\(db, Number\(l\.id\)\)/);
  assert.match(v, /db\.transaction\(\(\) => \{/);
});

test('al guardar se dice qué falta para que el circuito termine', () => {
  // El flete entró al costo, pero al fletero todavía no se le debe nada en el
  // libro. Sin decirlo, el operador cree que terminó.
  const v = valorizar();
  assert.match(v, /aviso: 'El flete entró al costo\./);
  assert.match(v, /Ingresar factura/);
});
