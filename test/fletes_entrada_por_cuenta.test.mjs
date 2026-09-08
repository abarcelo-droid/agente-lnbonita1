// ══ FLETES DE ENTRADA SE VALORIZA COMO FLETES DE SALIDA ═══════════════════
//
// Pablo, 8/9/2026: «usá el mismo modelo de trabajo para Fletes de entrada que el
// que ya tenemos para Fletes de salida... si no las dos pantallas confunden».
//
// Y es el mismo trabajo: el fletero trae ocho camiones en la semana y manda UNA
// cuenta. En salida eso se valoriza junto —se elige el fletero, se ven sus remitos
// y se pone un total que se reparte—; en entrada había que entrar viaje por viaje
// y tipear ocho veces.
//
// LA DIFERENCIA REAL ES DE DÓNDE SALE EL FLETERO. En salida viene del remito
// (sg_despachos.fletero_id), así que los pendientes ya vienen agrupados por él. En
// entrada no existe en ningún lado hasta que alguien lo dice: la orden de compra
// guarda el monto del flete, no quién lo hace. Por eso acá se elige primero y se
// tildan los viajes después — mismo trabajo, orden invertido.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const DBSG = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

const CUENTA = trozo(SG, "router.post('/fletes-entrada/valorizar-cuenta'", '\r\n});');

// ══════════════════════════════════════════════════════════════════════════
// 1 · POR QUÉ NO ALCANZABA CON EL DE SALIDA
// ══════════════════════════════════════════════════════════════════════════

test('la orden de compra NO guarda quién hace el flete, y el remito sí', () => {
  // Es lo que obliga a invertir el orden. Si la OC lo guardara, esta pantalla
  // podría agrupar como la de salida y no haría falta elegirlo antes.
  assert.match(DBSG, /ALTER TABLE sg_despachos ADD COLUMN fletero_id/);
  const oc = trozo(DBSG, 'CREATE TABLE IF NOT EXISTS sg_oc (', '\n  );');
  assert.match(oc, /flete_monto/);
  assert.ok(!/fletero_id/.test(oc), 'la orden guarda el fletero: se podría agrupar como salida');
});

test('el gasto puede no existir todavía: se crea o se actualiza', () => {
  // El de salida actualiza POR ID DE GASTO. Un flete de entrada pendiente puede no
  // tener fila: la lista se arma desde las recepciones y el gasto nace al
  // valorizar. Con el endpoint de salida no se habría guardado nada.
  assert.match(CUENTA, /const ya = db\.prepare\(`SELECT \* FROM sg_gastos_directos WHERE recepcion_id=\?/);
  assert.match(CUENTA, /if \(ya\) \{[\s\S]{0,400}UPDATE sg_gastos_directos/);
  assert.match(CUENTA, /\} else \{[\s\S]{0,400}INSERT INTO sg_gastos_directos/);
});

test('y el fletero se asigna acá, porque antes no lo tenía', () => {
  // El de salida exige que el gasto YA tenga fletero (WHERE proveedor_servicio_id=?)
  // y no le cambia el que tiene: con él, ninguna fila habría coincidido.
  assert.match(CUENTA, /proveedor_servicio_id=\?/);
  const salida = trozo(SG, "router.post('/gastos-servicio/valorizar'", '\r\n});');
  assert.match(salida, /WHERE id=\? AND proveedor_servicio_id=\?/,
    'el de salida dejó de exigir el fletero: revisá si sigue haciendo falta el nuevo');
});

test('el flete de entrada ENTRA AL COSTO, y por eso se recalculan los lotes', () => {
  // Es el error más caro y el que no se ve: la plata se carga y la partida sigue
  // costando lo mismo. El endpoint de salida recalcula sólo para la descarga.
  assert.match(CUENTA, /recalcCostoLote\(db, Number\(l\.id\)\)/);
  const salida = trozo(SG, "router.post('/gastos-servicio/valorizar'", '\r\n});');
  assert.match(salida, /g\.tipo_gasto === 'descarga_ingreso'/,
    'el de salida ya recalcula para el flete de entrada: el endpoint nuevo sobra');
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LOS FRENOS NO SE PIERDEN POR LA PUERTA NUEVA
// ══════════════════════════════════════════════════════════════════════════

test('el flete que paga el productor sigue sin poder valorizarse', () => {
  // Ya viene adentro del precio. Sin repetir el freno acá, la puerta nueva se lo
  // saltearía y se le pagaría al fletero algo que ya está pago.
  assert.match(CUENTA, /rec\.flete_a_cargo === 'vendedor' && rec\.flete_pagado_por !== 'san_geronimo'/);
  assert.match(CUENTA, /lo paga el productor/);
  // Y dice DE QUÉ PARTIDA, o con ocho viajes tildados no se sabe cuál sacar.
  assert.match(CUENTA, /rec\.numero_recepcion \|\| rec\.id/);
});

test('un importe en cero o vacío corta, y corta TODO', () => {
  // La transacción se cae entera: media cuenta valorizada es peor que ninguna,
  // porque el fletero cobra una cosa y el sistema dice otra.
  assert.match(CUENTA, /if \(!\(monto > 0\)\) throw new Error\('Cada viaje necesita su importe'\)/);
  assert.match(CUENTA, /db\.transaction\(\(\) => \{/);
});

test('sin fletero o sin viajes no se guarda nada', () => {
  assert.match(CUENTA, /Elegí a qué fletero se le paga/);
  assert.match(CUENTA, /Elegí al menos un viaje/);
  assert.match(CUENTA, /Ese fletero no existe/);
});

test('queda el agrupador de la cuenta, como en salida', () => {
  // Es lo que después permite ver qué viajes entraron en la misma valorización.
  assert.match(CUENTA, /cuenta_ref/);
  assert.match(CUENTA, /SG-FE-/);
});

test('y el asiento sigue saliendo de la factura, no de acá', () => {
  // Valorizar pone el precio; el papel, la deuda y el asiento van después.
  assert.ok(!/crearAsiento/.test(CUENTA), 'la valorización volvió a asentar');
  assert.match(CUENTA, /cargá su factura con «🧾 Ingresar factura»/);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LA PANTALLA
// ══════════════════════════════════════════════════════════════════════════

test('el cuadro que reparte es EL MISMO de salida, no uno nuevo', () => {
  // Escribir otro serían dos maneras de repartir la misma plata.
  const f = trozo(PANEL, 'function sgFeCuentaAbrir(){', '\r\n}');
  assert.match(f, /sgGdsValAbrir\(\{/);
  assert.match(f, /ruta: '\/api\/sg\/fletes-entrada\/valorizar-cuenta'/);
  // Y el cuadro dejó de tener la dirección clavada: por eso se puede reusar.
  const a = trozo(PANEL, 'function sgGdsValAbrir(opts){', '\r\n}');
  assert.match(a, /SGGD\.valRuta=opts\.ruta\|\|'\/api\/sg\/gastos-servicio\/valorizar'/);
  const g = trozo(PANEL, 'function sgGdsValGuardar(){', '\r\n}');
  assert.match(g, /api\(SGGD\.valRuta/);
  assert.match(g, /SGGD\.valCuerpo\s*\r?\n?\s*\? SGGD\.valCuerpo\(items\)/);
});

test('los ids que viajan son RECEPCIONES, no gastos', () => {
  // El gasto puede no existir todavía. Mandar su id sería mandar undefined.
  const f = trozo(PANEL, 'function sgFeCuentaAbrir(){', '\r\n}');
  assert.match(f, /return \{ recepcion_id: i\.id, monto: i\.monto \}/);
  assert.match(f, /id: x\.recepcion_id/);
});

test('el reparto es por KILOS, que es como se cobra un flete de entrada', () => {
  const f = trozo(PANEL, 'function sgFeCuentaAbrir(){', '\r\n}');
  assert.match(f, /base: Number\(x\.kg\) \|\| 0, unidadLbl: 'kg'/);
});

test('y arranca con lo que dijo la orden, como al valorizar de a uno', () => {
  const f = trozo(PANEL, 'function sgFeCuentaAbrir(){', '\r\n}');
  assert.match(f, /monto: x\.estimado \|\| ''/);
});

test('los tildes y el selector son de «A valorizar», no de «Valorizados»', () => {
  // En Valorizados cada viaje ya tiene su fletero: tildarlos no significaría nada.
  const f = trozo(PANEL, 'function sgFePintar(){', '\r\nfunction ');
  assert.match(f, /var porCuenta = SGFE\.estado === 'pendiente_valorizar'/);
  assert.match(f, /cb\.style\.display = porCuenta \? '' : 'none'/);
  assert.match(f, /porCuenta\s*\r?\n?\s*\? '<td style="text-align:center"><input type="checkbox"/);
});

test('el botón dice cuántos viajes entran, y no se ofrece vacío', () => {
  // Un «Valorizar cuenta» que abre un cuadro vacío hace pensar que se perdió la
  // selección.
  const f = trozo(PANEL, 'function sgFeCuentaBoton(){', '\r\n}');
  assert.match(f, /viaje\(s\)/);
  assert.match(f, /b\.disabled = !puede/);
  assert.match(f, /n > 0[\s\S]{0,80}sgfe-cuenta-fletero/);
});

test('al guardar se sueltan los tildes: la cuenta ya se armó', () => {
  // Si quedaran puestos, el próximo total se repartiría entre viajes que ya se
  // valorizaron.
  const f = trozo(PANEL, 'function sgFeCuentaAbrir(){', '\r\n}');
  assert.match(f, /reload: function\(\)\{ SGFE\.sel = \{\}; sgFeLoad\(\); \}/);
});

test('la tabla tiene su columna, y los «no hay nada» la cuentan', () => {
  // Un colspan corto deja el mensaje desalineado y la tabla partida.
  assert.match(PANEL, /<th style="width:34px" id="sgfe-th-chk"><\/th>/);
  const f = trozo(PANEL, 'function sgFePintar(){', '\r\nfunction ');
  assert.match(f, /<tr><td colspan="9" class="emp">/);
  assert.match(PANEL, /<tbody id="sgfe-tb"><tr><td colspan="9" class="emp">/);
});

test('el manual lo cuenta, con su versión', () => {
  assert.match(PANEL, /La cuenta del fletero, de una vez[\s\S]{0,90}V1031/);
  // Y por qué las dos pantallas se parecen pero el orden es distinto.
  assert.match(PANEL, /El orden es al revés que en salida, y por una razón/);
  assert.match(PANEL, /guarda quién hace el flete/);
});
