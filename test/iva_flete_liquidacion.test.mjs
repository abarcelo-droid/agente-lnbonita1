// ══ EL IVA DEL FLETE, QUE NO SE LE COBRABA AL PRODUCTOR ════════════════════
//
// La liquidación al productor le cobra cuatro servicios: comisión, descarga, FLETE y
// gastos administrativos. Los cuatro llevan IVA débito —se lo estamos facturando— y
// así está declarado en FILAS_LIQ.
//
// Pero el asiento sumaba el IVA de TRES: la línea decía
// `iva_comision + iva_descarga + iva_gastos_admin`, escrita a mano. El flete se
// agregó después ("flete lo estoy agregando ya que me lo había olvidado") y esa suma
// quedó vieja.
//
// ── Y POR QUÉ NADIE LO VIO ─────────────────────────────────────────────────
// El asiento balanceaba igual. La cuenta de Proveedores sale por DIFERENCIA, así que
// el IVA que no se cobraba engrosaba lo que se le queda debiendo al productor y las
// dos columnas cerraban lo mismo. El cartel decía «balancea» y estaba diciendo la
// verdad sobre una liquidación mal hecha.
//
// Lo que NO cerraba eran tres números que tienen que ser el mismo:
//   · la PANTALLA ya descontaba el IVA del flete de «neto a pagar al productor»,
//   · el `total` que se guarda —y con él la cuenta corriente— sale de esa pantalla,
//   · y el ASIENTO le acreditaba ese IVA de más.
// O sea: el mayor de Proveedores decía un número y la cuenta corriente, otro.
// Y el Diario de IVA Ventas —que sí cuenta el flete— declaraba ante ARCA un débito
// que el asiento nunca había registrado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILAS_LIQ } from '../src/servicios/asiento-liquidacion.js';
import { ivaDeLiquidacion } from '../src/servicios/sg_libros_iva.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(RAIZ, 'src/servicios/asiento-liquidacion.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Saca lineasAsientoLiquidacion del archivo y la vuelve ejecutable con un modelo
// mínimo, sin abrir la base. Salta la lista de parámetros antes de contar llaves.
function extraer(src, firma, deps) {
  const i = src.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  let d = 0, j = src.indexOf('(', i);
  for (; j < src.length; j++) {
    if (src[j] === '(') d++;
    else if (src[j] === ')') { d--; if (d === 0) { j++; break; } }
  }
  let k = src.indexOf('{', j); d = 0;
  for (; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) { k++; break; } }
  }
  const nombre = firma.replace(/^export\s+function\s+/, '').replace(/\s*\(.*$/s, '');
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps),
    src.slice(i, k).replace(/^export\s+/, '') + '; return ' + nombre + ';')(...Object.values(deps));
}

const CUENTAS = {
  iva_credito_fiscal: 1, iva_debito_fiscal: 2,
  liq_comision: 3, liq_descarga: 4, liq_flete: 5, liq_gastos_admin: 6,
};
function armar(fiscal, gestion) {
  const fn = extraer(SRC, 'export function lineasAsientoLiquidacion', {
    MOTIVOS: { ajuste_gestion: 1 },
    FILAS_LIQ,
    r2l: r2,
    modeloLiqLineas: () => ({ id: 1, lineas: [
      { tipo_linea: 'mercaderia', lado: 'debe', cuenta_id: 100, descripcion: null },
      { tipo_linea: 'proveedores', lado: 'haber', cuenta_id: 200, descripcion: null },
    ] }),
    cuentaConfig: (db, clave) => (CUENTAS[clave] ? { cuenta_id: CUENTAS[clave] } : null),
  });
  return fn({}, { fiscal, gestion: gestion || {}, numero: '1-205', motivo_gestion: 'ajuste_gestion' });
}

// La liquidación del test de libros: mercadería 100.000 (10,5%) y cuatro servicios.
const FISCAL = {
  ventas: 100000, iva_ventas: 10500,
  comision: 12000, iva_comision: 1260,
  descarga: 3000, iva_descarga: 630,
  flete: 5000, iva_flete: 1050,
  gastos_admin: 1000, iva_gastos_admin: 210,
};

test('el flete es un servicio con IVA DÉBITO, como los otros tres', () => {
  const f = FILAS_LIQ.find((x) => x.clave === 'flete');
  assert.ok(f, 'el flete está en la lista de filas');
  assert.equal(f.iva, 'debito', 'se lo facturamos al productor');
  const debito = FILAS_LIQ.filter((x) => x.iva === 'debito').map((x) => x.clave);
  assert.deepEqual(debito, ['comision', 'descarga', 'flete', 'gastos_admin']);
});

test('el IVA débito del asiento incluye el del flete', () => {
  const { lineas, falta } = armar(FISCAL);
  assert.deepEqual(falta, []);
  const ivaDeb = lineas.find((l) => l.cuenta_id === 2);
  assert.equal(ivaDeb.haber, 3150, '1.260 + 630 + 1.050 + 210');
  // Sin el flete daban 2.100: son 1.050 que se declaraban y no se cobraban.
  assert.notEqual(ivaDeb.haber, 2100);
});

test('y por eso al productor se le acreditan 1.050 MENOS', () => {
  const { lineas } = armar(FISCAL);
  const prov = lineas.find((l) => l.cuenta_id === 200);
  // 110.500 − 21.000 de servicios − 3.150 de su IVA
  assert.equal(prov.haber, 86350);
  assert.equal(prov.debe, 0);
  // Con la suma vieja le quedaban 87.400: 1.050 de más, todas las veces.
  assert.notEqual(prov.haber, 87400);
});

test('el asiento balanceaba ANTES y balancea AHORA: por eso no se veía', () => {
  const { lineas } = armar(FISCAL);
  const debe = r2(lineas.reduce((a, l) => a + (l.debe || 0), 0));
  const haber = r2(lineas.reduce((a, l) => a + (l.haber || 0), 0));
  assert.equal(debe, haber, 'balancea');
  assert.equal(debe, 110500, 'lo que el productor vendió, más su IVA');
  // Proveedores sale por DIFERENCIA, así que cualquier IVA que se olvide de cobrar
  // se le acredita a él y el asiento cierra igual. El cartel «balancea» no es
  // prueba de que la liquidación esté bien.
});

test('el asiento le cobra al productor lo MISMO que le dice la liquidación', () => {
  // La pantalla suma los cuatro servicios CON su IVA para el «neto a pagar»
  // (liqTotales), y de ese número sale el `total` que se guarda y la cuenta
  // corriente del productor. El asiento tiene que dar ese mismo número o el mayor
  // y la cuenta corriente dicen cosas distintas.
  const pantalla = r2(FILAS_LIQ.reduce((a, x) => {
    const signo = (x.clave === 'ventas') ? 1 : -1;
    return a + signo * (r2(FISCAL[x.clave]) + r2(FISCAL['iva_' + x.clave]));
  }, 0));
  const { lineas } = armar(FISCAL);
  const prov = lineas.find((l) => l.cuenta_id === 200);
  assert.equal(prov.haber - prov.debe, pantalla);
  assert.equal(pantalla, 86350);
  // Y es la misma cuenta que hace el panel, escrita igual.
  assert.match(PANEL, /pagarF \+= signo \* \(d\.fiscal\[x\.k\] \+ d\.fiscal\['iva_' \+ x\.k\]\);/);
});

test('y lo MISMO que declara el Diario de IVA Ventas', () => {
  // El libro cuenta el flete como servicio desde que se hizo (sg_libros_iva.js).
  // Con la suma vieja, se le declaraba a ARCA un débito de 3.150 y el asiento sólo
  // registraba 2.100: el libro y el mayor no podían cerrar.
  const libro = ivaDeLiquidacion({ grilla_json: JSON.stringify({ fiscal: FISCAL }) });
  assert.equal(libro.ventas.iva, 3150);
  const { lineas } = armar(FISCAL);
  assert.equal(lineas.find((l) => l.cuenta_id === 2).haber, libro.ventas.iva);
});

test('la suma sale de la LISTA, no escrita a mano', () => {
  // Es exactamente por escribirla a mano que el flete quedó afuera cuando se agregó.
  // El próximo servicio tiene que entrar solo.
  assert.doesNotMatch(SRC, /n\(f\.iva_comision\) \+ n\(f\.iva_descarga\) \+ n\(f\.iva_gastos_admin\)/);
  assert.match(SRC, /FILAS_LIQ\s*\n?\s*\.filter\(\(x\) => x\.iva === 'debito'\)/);
});

test('una liquidación sin flete sigue dando lo mismo que antes', () => {
  const sin = { ...FISCAL, flete: 0, iva_flete: 0 };
  const { lineas } = armar(sin);
  assert.equal(lineas.find((l) => l.cuenta_id === 2).haber, 2100);
  assert.equal(lineas.find((l) => l.cuenta_id === 200).haber, 92400,
    'sin flete: 110.500 − 16.000 − 2.100');
  const debe = r2(lineas.reduce((a, l) => a + (l.debe || 0), 0));
  const haber = r2(lineas.reduce((a, l) => a + (l.haber || 0), 0));
  assert.equal(debe, haber);
});
