// ══ QUÉ COMPROBANTE LE CORRESPONDE A CADA CLIENTE ══════════════════════
//
// Hasta hoy la letra salía SÓLO de si el cliente tenía CUIT: con CUIT → Factura A y
// "Responsable Inscripto" a AFIP; sin CUIT → B y "Consumidor Final". La categoría
// fiscal, que está en la ficha desde siempre, no se miraba al emitir. Un
// MONOTRIBUTISTA con CUIT recibía una Factura A y se lo informaba como RI: las dos
// cosas mal, en cada venta.
//
// Esto es fiscal y sale a AFIP, así que se prueba caso por caso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fiscalDeCliente, cuitValido, discriminaIva, REGLA_FISCAL } from '../src/servicios/sg_fiscal.js';

// CUITs con dígito verificador correcto, para no probar contra números inventados.
const CUIT_OK = '30712400125';         // el de un cliente real del panel
const CUIT_ROTO = '30712400126';       // mismo, con el DV cambiado

test('el validador de CUIT mira el dígito verificador', () => {
  assert.equal(cuitValido(CUIT_OK), true);
  assert.equal(cuitValido(CUIT_ROTO), false, 'un DV que no cierra no es un CUIT');
  assert.equal(cuitValido('30-71240012-5'), true, 'con guiones también');
  assert.equal(cuitValido('123'), false);
  assert.equal(cuitValido('00000000000'), false);
  assert.equal(cuitValido(null), false);
});

test('Responsable Inscripto con CUIT → Factura A', () => {
  const f = fiscalDeCliente({ razon_social: 'ASUNCION 4054 S.A.', cuit: CUIT_OK, categoria_fiscal: 'resp_inscripto' });
  assert.equal(f.ok, true);
  assert.equal(f.letra, 'A');
  assert.equal(f.cbte_tipo, 1);
  assert.equal(f.cond_iva, 1, 'y se le informa a AFIP como Responsable Inscripto');
  assert.equal(f.doc_tipo, 80);
  assert.equal(f.doc_nro, CUIT_OK);
});

test('MONOTRIBUTISTA con CUIT → Factura B, no A', () => {
  // Éste es el bug: hoy sale A y se informa como Responsable Inscripto.
  const f = fiscalDeCliente({ razon_social: 'ACCHURA SILVIA VERONICA', cuit: CUIT_OK, categoria_fiscal: 'monotributista' });
  assert.equal(f.letra, 'B');
  assert.equal(f.cbte_tipo, 6);
  assert.equal(f.cond_iva, 6, 'Responsable Monotributo, no Responsable Inscripto');
  assert.equal(f.doc_tipo, 80, 'igual se lo identifica: tiene CUIT');
});

test('exento → Factura B con su propia condición', () => {
  const f = fiscalDeCliente({ razon_social: 'X', cuit: CUIT_OK, categoria_fiscal: 'exento' });
  assert.equal(f.letra, 'B');
  assert.equal(f.cond_iva, 4);
});

test('un exento sin CUIT se frena: informarlo sin identificar es una contradicción', () => {
  // Decirle a AFIP "Sujeto Exento" y a la vez "consumidor final sin identificar" es
  // algo que el comprobante puede rebotar — y rebota DESPUÉS de pedir el número.
  const f = fiscalDeCliente({ razon_social: 'Fundación X', cuit: null, categoria_fiscal: 'exento' });
  assert.equal(f.ok, false);
  assert.match(f.error, /sin CUIT no existe/i);
});

test('consumidor final sin CUIT → Factura B sin identificar', () => {
  const f = fiscalDeCliente({ razon_social: 'ALBERTO', cuit: null, categoria_fiscal: 'no_inscripto' });
  assert.equal(f.letra, 'B');
  assert.equal(f.cbte_tipo, 6);
  assert.equal(f.cond_iva, 5);
  assert.equal(f.doc_tipo, 99);
  assert.equal(f.doc_nro, '0');
});

test('sin categoría y SIN CUIT no se frena: es consumidor final y no hay otra opción', () => {
  // No tiene sentido trabar una venta de mostrador por un dato que no cambia nada:
  // sin CUIT no puede ser Responsable Inscripto.
  const f = fiscalDeCliente({ razon_social: 'Mostrador', cuit: '', categoria_fiscal: '' });
  assert.equal(f.ok, true);
  assert.equal(f.letra, 'B');
  assert.equal(f.cond_iva, 5);
});

test('sin categoría y CON CUIT sí se frena: de eso depende la letra', () => {
  const f = fiscalDeCliente({ razon_social: 'ASUNCION 4054 S.A.', cuit: CUIT_OK, categoria_fiscal: null });
  assert.equal(f.ok, false);
  assert.match(f.error, /categor[ií]a fiscal/i);
  assert.match(f.error, /ASUNCION 4054/, 'y dice cuál es el cliente');
});

test('un Responsable Inscripto sin CUIT válido se frena', () => {
  const f = fiscalDeCliente({ razon_social: 'X', cuit: null, categoria_fiscal: 'resp_inscripto' });
  assert.equal(f.ok, false);
  assert.match(f.error, /sin CUIT no existe/i);
});

test('un CUIT roto frena en cualquier categoría, no cae a consumidor final', () => {
  for (const cat of ['resp_inscripto', 'monotributista', 'exento', 'no_inscripto', '']) {
    const f = fiscalDeCliente({ razon_social: 'X', cuit: CUIT_ROTO, categoria_fiscal: cat });
    assert.equal(f.ok, false, `categoría ${cat || '(vacía)'}`);
    assert.match(f.error, /no es v[aá]lido/i);
  }
});

test('las notas de crédito llevan la letra que corresponde', () => {
  assert.equal(fiscalDeCliente({ cuit: CUIT_OK, categoria_fiscal: 'resp_inscripto' }, { esNC: true }).cbte_tipo, 3);
  assert.equal(fiscalDeCliente({ cuit: CUIT_OK, categoria_fiscal: 'monotributista' }, { esNC: true }).cbte_tipo, 8);
});

test('una categoría que el sistema no sabe emitir se frena y las nombra', () => {
  const f = fiscalDeCliente({ razon_social: 'X', cuit: CUIT_OK, categoria_fiscal: 'algo_raro' });
  assert.equal(f.ok, false);
  for (const c of Object.keys(REGLA_FISCAL)) assert.match(f.error, new RegExp(c));
});

test('sólo la A discrimina el IVA en el papel', () => {
  assert.equal(discriminaIva(1), true, 'Factura A');
  assert.equal(discriminaIva(3), true, 'NC A');
  assert.equal(discriminaIva(6), false, 'Factura B: el impuesto va adentro del precio');
  assert.equal(discriminaIva(8), false, 'NC B');
});

test('el módulo es puro: se importa sin base ni node_modules', () => {
  // Si alguien le agrega un import de db.js, este archivo deja de poder correr y el
  // test se cae al cargar — que es la señal.
  const src = fsLeer('src/servicios/sg_fiscal.js');
  assert.doesNotMatch(src, /^import .*db/m,
    'sg_fiscal.js tiene que seguir siendo puro: recibe el cliente ya leído');
});

function fsLeer(rel) {
  const { readFileSync } = require('node:fs');
  const { fileURLToPath } = require('node:url');
  const { resolve, dirname } = require('node:path');
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');
}
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
