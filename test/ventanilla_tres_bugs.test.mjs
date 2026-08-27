// ══ TRES COSAS ROTAS EN LA VENTA DE VENTANILLA ═════════════════════════════
//
// Aparecieron mapeando el circuito de cobro, antes de tocarlo. Las tres pasan
// DESPUÉS del punto de no retorno —la mercadería ya salió y ARCA ya autorizó— así
// que el operador se entera cuando ya no puede hacer nada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const FIN = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg_finanzas.js'), 'utf8');

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

// ── 1 · TRANSFERENCIA NO OFRECÍA NINGUNA CUENTA ────────────────────────────
test('el tipo «banco» no existe en la base', () => {
  // Las cuentas son 'caja', 'cuenta_corriente' o 'caja_ahorro': son las tres
  // opciones del alta y no hay un solo INSERT que escriba otra cosa.
  assert.match(PANEL, /<option value="cuenta_corriente">Cuenta corriente bancaria<\/option>/);
  assert.match(PANEL, /<option value="caja_ahorro">Caja de ahorro<\/option>/);
  assert.ok(!/<option value="banco">/.test(PANEL), 'no hay forma de dar de alta una cuenta tipo banco');
  assert.ok(!/tipo\s*=\s*'banco'/.test(FIN), 'ni el esquema escribe ese tipo');
});

test('ahora las cuentas bancarias se filtran POR LA NEGATIVA', () => {
  // Preguntar `=== 'banco'` no matchea nada: el desplegable de Transferencia salía
  // SIEMPRE vacío, el operador creía que le faltaban permisos, y el cobro se
  // cortaba después de que el comprobante ya había salido. En la ventanilla sólo
  // se podía cobrar en efectivo.
  const b = cuerpo('sgFdMediosRender');
  assert.match(b, /var caja = String\(c\.tipo\) === 'caja';/);
  assert.match(b, /return \(esCaja \? caja : !caja\)/);
  assert.ok(!/String\(c\.tipo\) === tipo/.test(b), 'quedó el filtro viejo');
  // Y el cartel de vacío distingue una cosa de la otra.
  assert.match(b, /esCaja \? 'cajas' : 'cuentas bancarias'/);
});

// ── 2 · EL CAE SE ESCONDÍA SOLO ────────────────────────────────────────────
test('el número y el CAE no se borran en el mismo tick en que se pintan', () => {
  // sgFdEmitir pintaba el comprobante y llamaba a sgFdInit(), que le sacaba la
  // clase que lo hace visible. El operador veía sólo el toast y perdía el CAE, el
  // número, el remito y el botón del PDF. Peor: los avisos del cobro llegan por
  // promesa MÁS TARDE y se escriben adentro de esa misma caja ya escondida.
  const init = cuerpo('sgFdInit');
  assert.match(init, /if \(!SG\._fdRecienEmitido\) eid\('sgfd-confirm'\)\.classList\.remove\('on'\)/);
  assert.match(init, /SG\._fdRecienEmitido = false;/);
  assert.ok(!/^\s*eid\('sgfd-confirm'\)\.classList\.remove\('on'\);\s*$/m.test(init),
    'quedó el borrado incondicional');
});

test('la bandera se levanta justo antes de que corra el init', () => {
  const em = cuerpo('sgFdEmitir');
  const bandera = em.indexOf('SG._fdRecienEmitido = true;');
  const init = em.indexOf('sgFdInit();');
  assert.ok(bandera > 0, 'sin la bandera, sgFdInit se lleva el cartel puesto');
  assert.ok(init > bandera, 'la bandera tiene que estar puesta antes del init');
});

test('y el cartel se limpia al EMPEZAR una venta nueva', () => {
  // Si no, queda arriba mientras se carga otra venta y hace creer que ésta ya se
  // emitió. Se limpia al agregar el primer renglón, no al terminar de emitir —que
  // es cuando el operador todavía necesita el número.
  const b = cuerpo('sgFdOnAdd');
  assert.match(b, /if \(!SG\.fdItems\.length\) \{/);
  assert.match(b, /cf\.classList\.remove\('on'\); cf\.innerHTML = ''/);
});

// ── 3 · EL DOCUMENTO DEL COMPRADOR SE BORRABA SOLO ─────────────────────────
test('el DNI que se tipeó sobrevive a que se cargue el importe', () => {
  // El bloque se rearma con innerHTML y el input se dibujaba SIN value. Se lo llama
  // en cada tecla del importe del cobro: el operador cargaba el documento, ponía
  // el importe, y el campo se vaciaba sin avisar. Al emitir viajaba vacío y el
  // backend rebotaba — con la mercadería ya descontada del stock.
  const b = cuerpo('sgFdIdentifRender');
  assert.match(b, /var nPrev = \(eid\('sgfd-idnro'\) \|\| \{\}\)\.value \|\| '';/);
  assert.match(b, /value="' \+ escH\(nPrev\) \+ '"/);
  // El tipo también: si volvía a DNI, un CUIT quedaba mal etiquetado.
  assert.match(b, /var tPrev = \(eid\('sgfd-idtipo'\) \|\| \{\}\)\.value \|\| 'dni';/);
  assert.match(b, /tPrev === t \? ' selected' : ''/);
});

test('y ni siquiera se rearma si no cambió nada', () => {
  // Rehacer el nodo en cada tecla se lleva el foco igual, aunque se conserve el
  // valor: el que está tipeando el documento pierde el cursor.
  const b = cuerpo('sgFdIdentifRender');
  assert.match(b, /if \(cont\.dataset\.umbral === String\(umbral\) && eid\('sgfd-idnro'\)\) return;/);
});

test('cuando NO hace falta identificar, el bloque se vacía igual', () => {
  // El umbral y el cliente pueden cambiar en el medio: si quedara dibujado, se
  // mandaría un documento que ya no corresponde.
  const b = cuerpo('sgFdIdentifRender');
  assert.match(b, /if \(!hace\) \{ cont\.innerHTML = ''; return; \}/);
  // Y ese return va ANTES de guardar el dataset, o el bloque no se vuelve a armar.
  assert.ok(b.indexOf("if (!hace)") < b.indexOf('cont.dataset.umbral = String(umbral)'));
});
