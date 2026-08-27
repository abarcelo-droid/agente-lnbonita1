// ══ «¿CÓMO SE PAGA?» ES OBLIGATORIO ════════════════════════════════════════
//
// Pablo, 27/8/2026: «todas las facturas deberían tener un ¿cómo se paga?
// obligatorio, donde una de las opciones sea Cuenta corriente».
//
// Era un TILDE apagado. O sea: «cuenta corriente» no era una opción ELEGIDA, era lo
// que pasaba cuando no se elegía nada — el saldo quedaba en la cuenta del cliente
// sin que nadie lo decidiera y SIN FECHA DE VENCIMIENTO.
//
// Y peor: nada del cobro se validaba antes de emitir. Si faltaba la caja o el número
// del cheque, el comprobante salía igual, la mercadería se descontaba, ARCA
// autorizaba, y recién ahí el cobro se cortaba. La plata se perdía del lado
// equivocado del punto de no retorno.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const AFIP = fs.readFileSync(path.join(RAIZ, 'src/servicios/afip-wsfe-emision.js'), 'utf8');

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

// ── EN LOS DOS LUGARES DONDE SE EMITE ──────────────────────────────────────
test('la pregunta está en la ventanilla y en el editor de comprobante', () => {
  // Definición de Pablo: «en los dos lugares donde se emite».
  //
  // Se cuentan las OBLIGATORIAS —las que llevan el asterisco—. Hay una tercera
  // «¿cómo se paga?» en otro módulo, preexistente y sin relación con esto.
  assert.equal((PANEL.match(/¿Cómo se paga\? <span style="color:var\(--err\)">\*<\/span>/g) || []).length, 2);
  assert.match(PANEL, /id="sgfd-pago-cc"/);
  assert.match(PANEL, /id="sgfd-pago-ya"/);
  assert.match(PANEL, /id="sgf-pago-cc"/);
});

test('el tilde opcional dejó de ser la puerta', () => {
  // Sigue existiendo escondido porque de él cuelga la mecánica del bloque de
  // medios; lo que cambió es QUIÉN lo prende.
  assert.match(cuerpo('sgFdPago'), /chk\.checked = \(cual === 'ya'\)/);
  assert.match(PANEL, /<label style="display:none"><input type="checkbox" id="sgfd-cobrar"/);
});

// ── NO SE EMITE SIN CONTESTAR ──────────────────────────────────────────────
test('sin elegir cómo se paga, no se emite', () => {
  assert.match(cuerpo('sgFdPagoFalta'), /if \(!SG\._fdPago\) return/);
  const em = cuerpo('sgFdEmitir');
  assert.match(em, /var faltaPago = sgFdPagoFalta\(\);/);
  assert.match(em, /if \(faltaPago\) \{ toast\(faltaPago, 'er'\); return; \}/);
  // Y el freno va ANTES del POST: después ya no se puede volver.
  assert.ok(em.indexOf('sgFdPagoFalta()') < em.indexOf('/api/sg/facturas/directa'));
});

test('el cobro se valida ANTES del punto de no retorno', () => {
  // Faltaba la caja, el número del cheque o el librador y el comprobante salía
  // igual: la mercadería se descontaba, ARCA autorizaba, y la plata se perdía.
  const b = cuerpo('sgFdPagoFalta');
  assert.match(b, /Falta el número del cheque/);
  assert.match(b, /Falta quién firma el cheque/);
  assert.match(b, /Falta elegir/);
  assert.match(b, /Cargá con qué se paga, o mandalo a cuenta corriente/);
  // Y que no se cobre de más.
  assert.match(b, /Estás cobrando más que el total del comprobante/);
});

test('el editor de comprobante también frena antes', () => {
  const b = cuerpo('sgFacEmitir');
  assert.match(b, /if \(SG\._facPago !== 'cc'\)/);
  assert.match(b, /Poné a cuántos días vence/);
  assert.ok(b.indexOf('_facPago') < b.indexOf('/api/sg/facturas/emitir'));
});

// ── EL VENCIMIENTO ─────────────────────────────────────────────────────────
test('se propone la condición del cliente y se puede cambiar', () => {
  // Definición de Pablo: «la que tiene el cliente, y se puede cambiar».
  const b = cuerpo('sgFdCcDefecto');
  assert.match(b, /cli\.condicion_pago_habitual_id/);
  assert.match(b, /if \(!String\(d\.value \|\| ''\)\.trim\(\)\)/, 'si ya lo tocó, no se le pisa');
  assert.match(b, /no tiene condición de pago cargada/);
});

test('de una condición con cuotas se toma el ÚLTIMO vencimiento', () => {
  // El de la primera cuota dejaría media deuda marcada como vencida el día que
  // vence la cuota uno.
  for (const f of ['sgFdCcDefecto', 'sgFacPago']) {
    assert.match(cuerpo(f), /if \(x > dias\) dias = x;/, f + ' no toma el último vencimiento');
  }
});

test('la fecha se calcula y se muestra', () => {
  const b = cuerpo('sgFdCcVenc');
  assert.match(b, /f\.setDate\(f\.getDate\(\) \+ d\)/);
  assert.match(b, /SG\._fdVenc = f\.toISOString\(\)\.slice\(0, 10\)/);
  assert.match(b, /split\('-'\)\.reverse\(\)\.join\('\/'\)/, 'se muestra en formato de acá');
});

// ── HASTA LA BASE ──────────────────────────────────────────────────────────
test('el vencimiento llega a la factura', () => {
  assert.match(AFIP, /_alter\('sg_ven_facturas', 'vencimiento', 'vencimiento TEXT'\)/);
  assert.match(AFIP, /_alter\('sg_ven_facturas', 'condicion_pago_id', 'condicion_pago_id INTEGER'\)/);
  assert.match(AFIP, /dif_gestion, dif_motivo, vencimiento, condicion_pago_id\)/);
});

test('las columnas y los signos de pregunta dan', () => {
  // Un placeholder de menos corre TODOS los valores un lugar: la factura sale con
  // el neto en la columna del IVA y nadie lo ve hasta el cierre.
  const i = AFIP.indexOf('INSERT INTO sg_ven_facturas');
  const b = AFIP.slice(i, i + 800);
  const cols = b.slice(b.indexOf('(numero') + 1, b.indexOf(')\r') > 0 ? b.indexOf(')\r') : b.indexOf('VALUES'));
  const vals = b.slice(b.indexOf('VALUES'), b.indexOf('`).run'));
  const nCols = cols.split(',').filter((x) => x.trim()).length;
  const nVals = (vals.match(/\?/g) || []).length + (vals.match(/'[a-z]+'/g) || []).length;
  assert.equal(nCols, nVals, 'columnas ' + nCols + ' vs valores ' + nVals);
});

test('viaja por los DOS caminos de emisión', () => {
  // El manual (sin AFIP) y el de AFIP. Si se sumara a uno solo, la mitad de los
  // comprobantes quedaría sin fecha y nadie se enteraría.
  assert.equal((AFIP.match(/vencimiento, condicionPagoId \}\);/g) || []).length, 2);
  assert.match(AFIP, /ncMotivo, vencimiento, condicionPagoId \}\) \{/);
});

test('el router lo pasa, y sirve para los dos lugares', () => {
  // postEmitir es el mismo para la ventanilla y para el editor de comprobante.
  assert.match(SG, /vencimiento: val\(b\.vencimiento\) \|\| null,/);
  assert.match(SG, /condicionPagoId: b\.condicion_pago_id \? Number\(b\.condicion_pago_id\) : null,/);
  assert.match(SG, /router\.post\('\/facturas\/emitir', requireAuth, postEmitir\)/);
});

test('el vencimiento va aunque se cobre en el acto', () => {
  // Si el cobro no alcanza a cubrir el total, el resto queda en la cuenta corriente
  // y también vence. Sin fecha esa deuda no aparece en ningún informe de vencidos.
  const b = cuerpo('sgFdEmitir');
  assert.match(b, /vencimiento: SG\._fdVenc \|\| null,/);
});

// ── LA PREGUNTA VUELVE A ESTAR SIN CONTESTAR ───────────────────────────────
test('la venta siguiente no hereda la respuesta de la anterior', () => {
  // Si quedara elegida, la próxima saldría por cuenta corriente sin que nadie lo
  // decidiera — que es exactamente lo que esto viene a cerrar.
  const b = cuerpo('sgFdInit');
  assert.match(b, /SG\._fdPago = null; SG\._fdVenc = null; SG\._fdCondId = null;/);
  const f = cuerpo('sgFacInit');
  assert.match(f, /SG\._facPago = null; SG\._facVenc = null; SG\._facCondId = null;/);
});
