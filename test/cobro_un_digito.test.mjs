// ══ LA CASILLA DE «CUÁNTO» DEJABA ESCRIBIR UN SOLO DÍGITO ══════════════════
//
// Pablo, 27/8/2026: «la casilla de cuánto cobrar me permite poner un solo dígito».
//
// LA CAUSA: cada tecla llamaba a sgFdMedioUpd, que redibujaba la LISTA ENTERA de
// medios de pago. El input se destruía y se creaba de nuevo, así que el foco se
// perdía después del primer carácter: se tipeaba un dígito, había que volver a
// hacer clic, tipear otro.
//
// Es el bug clásico de redibujar en cada `oninput`. Sólo la FORMA de pago cambia la
// forma del renglón —aparece el selector de caja, o los campos del cheque—; el
// monto y la referencia no cambian nada que haya que redibujar.
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

test('tipear el monto ya NO redibuja la lista', () => {
  const b = cuerpo('sgFdMedioUpd');
  // Sólo la forma redibuja, y sale antes de llegar al final.
  assert.match(b, /if \(campo === 'forma'\) \{ sgFdMediosRender\(\); return; \}/);
  // Y después de ese return no queda ninguna otra llamada al render.
  const tras = b.slice(b.indexOf("if (campo === 'forma')") + 40);
  assert.ok(!tras.includes('sgFdMediosRender()'),
    'sigue redibujando en cada tecla: el input se destruye y se lleva el foco');
});

test('lo que sí se actualiza es el pie, que es lo único que cambia', () => {
  assert.match(cuerpo('sgFdMedioUpd'), /sgFdCobroPie\(\);/);
  assert.match(PANEL, /function sgFdCobroPie\(\)\{/);
  assert.equal((PANEL.match(/function sgFdCobroPie\(/g) || []).length, 1);
});

test('el pie sale del render: si viviera adentro, actualizarlo obliga a redibujar', () => {
  // Era exactamente de ahí de donde salía el bug.
  const pie = cuerpo('sgFdCobroPie');
  assert.match(pie, /var total = sgFdTotal\(\)/);
  assert.match(pie, /SG_FD_MEDIOS\.reduce/);
  assert.match(pie, /queda saldado/);
  assert.match(pie, /quedan ' \+ sgMoney2\(falta\) \+ ' en la cuenta corriente/);
  assert.match(pie, /te pasaste por/);
  // Y el render lo delega en vez de tener su propia copia.
  const ren = cuerpo('sgFdMediosRender');
  assert.match(ren, /sgFdCobroPie\(\);/);
  assert.ok(!ren.includes('queda saldado'), 'quedó la copia vieja del pie adentro del render');
});

test('la identificación del comprador sigue siguiendo al total', () => {
  // Vivía en el mismo lugar que el pie: si se perdía en la mudanza, la venta de
  // más de $10M a consumidor final dejaría de pedir el documento.
  assert.match(cuerpo('sgFdCobroPie'), /sgFdIdentifRender\(total\)/);
});

test('un cobro parcial sigue siendo válido; pasarse no', () => {
  // El resto queda en la cuenta corriente. Es la regla de negocio que el pie
  // explica, y no cambió con el arreglo.
  const pie = cuerpo('sgFdCobroPie');
  assert.match(pie, /falta > 0/);
  assert.match(pie, /Math\.abs\(falta\) < 0\.01/);
});

test('el modal de cobranza NO tiene el mismo patrón', () => {
  // Ahí los importes se leen por id y no se redibuja nada: se verificó para no
  // arreglar un lado y dejar el otro roto.
  const t = cuerpo('sgCobTotal');
  assert.ok(!/Render\(\)/.test(t), 'sgCobTotal no debería redibujar');
  assert.match(t, /eid\('sg-cob-i-' \+ i\)/);
});
