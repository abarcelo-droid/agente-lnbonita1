// ══ EL PRECIO DEL REMITO, EN LA UNIDAD EN QUE SE VENDE ═════════════════════
//
// Pablo, 30/8/2026: «en el remito necesito poder poner el precio por bulto también,
// no sólo por kilo. En la modificación del remito también».
//
// Es la misma regla que del lado de la compra: el precio se pacta en cajones —«el
// morrón a $60.000 el cajón»— y obligar a dividir por los kilos del cajón es pedir
// una cuenta a mano, que es justo donde se cuela el cero de más.
//
// LO QUE VIAJA AL SERVIDOR ES SIEMPRE $/kg: es la unidad con la que corren el
// subtotal, el margen y lo que se le factura al cliente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// Las funciones reales del armado, corridas de verdad.
function traer(nombre, extra) {
  const i = PANEL.indexOf(nombre);
  assert.ok(i > 0, 'no existe ' + nombre);
  const src = PANEL.slice(i, PANEL.indexOf('\n}', i) + 2);
  const clave = nombre.replace('function ', '').replace(/\(.*/, '');
  // eslint-disable-next-line no-new-func
  return new Function('SG', 'SG_DESP_UNI', 'sgDespKpb', 'sgDespPorBulto',
    (extra || '') + src + '; return ' + clave + ';');
}

// ── 1 · LA CONVERSIÓN, CORRIDA ─────────────────────────────────────────────

test('el factor sale del ítem, y si no lo tiene se despeja de kilos y cajones', () => {
  const kpb = traer('function sgDespKpb(it){')(null, 'kg', null, null);
  assert.equal(kpb({ kg_por_bulto: 18 }), 18);
  assert.equal(kpb({ bultos: 45, kg: 810 }), 18, 'se despeja');
  assert.equal(kpb({}), 0, 'sin nada, no hay conversión posible');
  assert.equal(kpb(null), 0);
});

test('sin factor, el renglón se queda en $/kg aunque se elija bulto', () => {
  // Es mejor un renglón que dice su unidad que uno que miente.
  const kpb = traer('function sgDespKpb(it){')(null, 'kg', null, null);
  const porB = traer('function sgDespPorBulto(it){')(null, 'bulto', kpb, null);
  assert.equal(porB({ kg_por_bulto: 18 }), true);
  assert.equal(porB({}), false, 'sin factor no hay precio por cajón');
});

test('lo que se MUESTRA es el guardado llevado a la unidad elegida', () => {
  const kpb = traer('function sgDespKpb(it){')(null, 'kg', null, null);
  const porBulto = traer('function sgDespPorBulto(it){')(null, 'bulto', kpb, null);
  const vista = traer('function sgDespPrecioVista(it){')(null, 'bulto', kpb, porBulto);
  // $3.333,33/kg × 18 kg = $60.000 el cajón, que es como se habló.
  assert.equal(vista({ precio: 3333.3333, kg_por_bulto: 18 }), 60000);
  const enKg = traer('function sgDespPrecioVista(it){')(
    null, 'kg', kpb, traer('function sgDespPorBulto(it){')(null, 'kg', kpb, null));
  assert.equal(enKg({ precio: 3333.3333, kg_por_bulto: 18 }), 3333.3333);
});

test('y lo que se GUARDA vuelve a kilo', () => {
  // Mandar la otra unidad dejaría dos renglones del mismo remito como números
  // incomparables.
  const kpb = traer('function sgDespKpb(it){')(null, 'kg', null, null);
  const porBulto = traer('function sgDespPorBulto(it){')(null, 'bulto', kpb, null);
  const SG = { despItems: [{ kg_por_bulto: 18, precio: 0 }] };
  const set = new Function('SG', 'SG_DESP_UNI', 'sgDespKpb', 'sgDespPorBulto', 'sgDespRender',
    PANEL.slice(PANEL.indexOf('function sgDespPrecioSet(i, valor){'),
      PANEL.indexOf('\n}', PANEL.indexOf('function sgDespPrecioSet(i, valor){')) + 2)
    + '; return sgDespPrecioSet;')(SG, 'bulto', kpb, porBulto, () => {});
  set(0, 60000);
  assert.equal(SG.despItems[0].precio, 3333.333333, '60.000 el cajón de 18 kg');
});

// ── 2 · LAS DOS PANTALLAS ──────────────────────────────────────────────────

test('el remito se ARMA en la unidad elegida', () => {
  const i = PANEL.indexOf('function sgDespRender(){');
  const b = PANEL.slice(i, i + 3000);
  assert.match(b, /El precio se pone por/);
  assert.match(b, /sgDespUniCambio\(this\.value\)/);
  assert.match(b, /sgDespPrecioVista\(it\)/);
  assert.match(b, /sgDespPrecioSet\('\+i\+',this\.value\)/);
  assert.match(b, /\(sgDespPorBulto\(it\)\?'\$\/bulto':'\$\/kg'\)/);
});

test('y se MODIFICA en la unidad elegida', () => {
  // «En la modificación del remito también» — Pablo.
  const i = PANEL.indexOf('function sgDespVer(id){');
  const b = PANEL.slice(i, i + 6200);
  assert.match(b, /sgDespEdUniCambio\(this\.value\)/);
  assert.match(b, /SG_DPED_UNI==='bulto'\?'\$\/bulto':'\$\/kg'/);
  assert.match(b, /var vista = porB \? Math\.round\(pk \* kpbF \* 100\) \/ 100 : pk;/);
});

test('lo tipeado al modificar también vuelve a kilo', () => {
  const i = PANEL.indexOf('function sgDespEdUpd(i, valor){');
  const b = PANEL.slice(i, i + 1400);
  assert.match(b, /SG\.despEd\.items\[i\]\.precio = \(sgDespEdPorBulto\(i\) && v > 0\)\r?\n?\s*\? Math\.round\(\(v \/ sgDespEdKpb\(i\)\) \* 1000000\) \/ 1000000 : v;/);
});

test('y al servidor sigue viajando $/kg en las dos pantallas', () => {
  // Es la unidad con la que corren el subtotal, el margen y la factura.
  assert.match(PANEL, /precio_por_kg:Number\(it\.precio\|\|0\), nota_precio:it\.nota\|\|''/);
  assert.match(PANEL, /items: SG\.despEd\.items\.map\(function\(x\)\{ return \{ item_id: x\.id, precio_por_kg: x\.precio \}; \}\)/);
});

test('la otra unidad queda SIEMPRE a la vista', () => {
  // Es el control que evita guardar $/bulto creyendo que son $/kg — el mismo que ya
  // tiene la corrección de la partida del lado de la compra.
  const i = PANEL.indexOf('function sgDespRender(){');
  assert.match(PANEL.slice(i, i + 4200), /cajones de ' \+ nr\(sgDespKpb\(it\)\)/);
  const j = PANEL.indexOf('function sgDespEdUpd(i, valor){');
  assert.match(PANEL.slice(j, j + 1600), /var e = eid\('sg-dpeq-' \+ i\);/);
});

// ── 3 · LA CUENTA QUE FALTABA PARA ASENTAR LA LIQUIDACIÓN RECIBIDA ─────────

test('la cuenta de gastos de liquidaciones recibidas se puede cargar', () => {
  // Pablo, 30/8/2026: «acá no me agregaste para poder generar los asientos de
  // liquidaciones recibidas». La clave existía en la base y la exigía el asiento
  // desde el primer día, pero no tenía dónde cargarse: el armador la pedía, no la
  // encontraba nunca y la liquidación no se podía registrar. Un cerrojo sin llave.
  assert.match(PANEL, /id="sgct-cfg-imp-liq_recibida_gastos"/);
  assert.match(PANEL, /sgctGuardarConfigImp\('liq_recibida_gastos',this\.value\)/);
});

test('y la clave está en la lista que llena los selectores', () => {
  // Si no está, el select queda vacío y no se puede elegir nada aunque exista en la
  // pantalla — el propio archivo lo dice tres líneas más abajo.
  const i = PANEL.indexOf("'cheques_rechazados',", PANEL.indexOf("'percepcion_ganancias','retencion','ventas','cheques_cartera'"));
  assert.ok(i > 0);
  assert.match(PANEL.slice(i, i + 500), /'liq_recibida_gastos',/);
});
