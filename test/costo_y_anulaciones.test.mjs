// ══ TRES BUGS QUE NO SE VEÍAN ══════════════════════════════════════════
//
// Aparecieron barriendo los caminos de la plata, no buscándolos. Los tres tienen la
// misma forma: algo que se deshace vuelve al lugar equivocado, o un número que se
// guarda con algo adentro que no le corresponde.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const TESO = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_tesoreria.js'), 'utf8');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── 1. ANULAR UN PAGO ───────────────────────────────────────────────────
test('anular un pago devuelve la deuda al comprobante que se pagó, no a otro', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_facturas_compra (id INTEGER PRIMARY KEY, numero TEXT, saldo_pagado REAL DEFAULT 0,
      saldo_pagado_gestion REAL DEFAULT 0, modificado_en TEXT, modificado_por INTEGER);
    CREATE TABLE liquidaciones (id INTEGER PRIMARY KEY, n_liquidacion TEXT, saldo_pagado REAL DEFAULT 0,
      saldo_pagado_gestion REAL DEFAULT 0);
    CREATE TABLE sg_pagos_compras (id INTEGER PRIMARY KEY, pago_id INTEGER, compra_id INTEGER,
      monto REAL, monto_gestion REAL, tipo TEXT);
    -- Misma id en las dos tablas: es exactamente el caso que rompía.
    INSERT INTO sg_facturas_compra (id,numero,saldo_pagado) VALUES (7,'FC-7',0);
    INSERT INTO liquidaciones (id,n_liquidacion,saldo_pagado,saldo_pagado_gestion) VALUES (7,'1-205',50000,8000);
    INSERT INTO sg_pagos_compras VALUES (1,1,7,50000,8000,'liquidacion');
  `);
  // El reparto tal como quedó escrito en sg.js.
  const imps = db.prepare('SELECT * FROM sg_pagos_compras WHERE pago_id=?').all(1);
  const baja = db.prepare(`UPDATE sg_facturas_compra
    SET saldo_pagado = MAX(0, ROUND(COALESCE(saldo_pagado,0) - ?, 2)),
        saldo_pagado_gestion = MAX(0, ROUND(COALESCE(saldo_pagado_gestion,0) - ?, 2)),
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`);
  const bajaLiq = db.prepare(`UPDATE liquidaciones
    SET saldo_pagado = MAX(0, ROUND(COALESCE(saldo_pagado,0) - ?, 2)),
        saldo_pagado_gestion = MAX(0, ROUND(COALESCE(saldo_pagado_gestion,0) - ?, 2)) WHERE id=?`);
  for (const im of imps) {
    const g = Number(im.monto_gestion) || 0;
    if (String(im.tipo || '') === 'liquidacion') bajaLiq.run(im.monto, g, im.compra_id);
    else baja.run(im.monto, g, 1, im.compra_id);
  }
  assert.equal(db.prepare('SELECT saldo_pagado FROM liquidaciones WHERE id=7').get().saldo_pagado, 0,
    'la liquidación vuelve a estar pendiente');
  assert.equal(db.prepare('SELECT saldo_pagado FROM sg_facturas_compra WHERE id=7').get().saldo_pagado, 0,
    'y la factura de OTRO proveedor con el mismo id no se toca');
  assert.equal(db.prepare('SELECT saldo_pagado_gestion FROM liquidaciones WHERE id=7').get().saldo_pagado_gestion, 0,
    'y vuelven LAS DOS columnas: si sólo vuelve una, el pendiente queda en total + gestión');
});

test('el código de la anulación mira el tipo y las dos columnas', () => {
  assert.match(SG, /if \(String\(im\.tipo \|\| ''\) === 'liquidacion'\) bajaLiq\.run/,
    'sin mirar `tipo`, la deuda vuelve al comprobante equivocado');
  assert.match(SG, /saldo_pagado_gestion = MAX\(0, ROUND\(COALESCE\(saldo_pagado_gestion,0\) - \?, 2\)\)/,
    'el pago escribe las dos columnas: al anular tienen que volver las dos');
  assert.match(TESO, /String\(im\.tipo \|\| ''\) === 'liquidacion'/,
    'el rebote de un cheque tiene el mismo problema y el mismo arreglo');
});

// ── 2. ANULAR UN REMITO YA FACTURADO ────────────────────────────────────
test('un remito ya facturado no se puede anular a secas', () => {
  assert.match(SG, /El remito \$\{d\.numero \|\| d\.id\} ya está facturado/,
    'devolver el stock y dejar la factura viva deja vender dos veces lo mismo');
  // Y que el freno use la regla compartida de qué factura cuenta: una rechazada
  // por AFIP no debería trabar la anulación del remito.
  const i = SG.indexOf('ya está facturado');
  const tramo = SG.slice(Math.max(0, i - 800), i);
  assert.match(tramo, /facturaCuenta\('f'\)/,
    'el freno tiene que usar facturaCuenta: una factura rechazada no cuenta');
});

// ── 3. EL IVA NO ES COSTO ───────────────────────────────────────────────
test('el costo del lote es el neto cuando la orden se cargó con IVA adentro', () => {
  // La cuenta, tal como quedó en sg.js.
  const neto = (precio, alic, incluye) =>
    (precio != null && incluye === 1 && alic != null) ? +(precio / (1 + alic / 100)).toFixed(6) : precio;

  assert.equal(r2(neto(1105, 10.5, 1) * 100), 100000,
    '1.105 el kilo con IVA adentro son 1.000 de costo, no 1.105');
  assert.equal(neto(1000, 10.5, 0), 1000, 'si el precio NO incluía IVA, no se toca');
  assert.equal(neto(1000, null, 1), 1000, 'sin alícuota conocida tampoco se inventa');
  assert.equal(neto(null, 10.5, 1), null, 'a precio abierto no hay costo todavía');

  // El 10,5% de diferencia es exactamente lo que inflaba el margen.
  const conIva = 1105 * 100, sinIva = neto(1105, 10.5, 1) * 100;
  assert.ok(Math.abs(conIva / sinIva - 1.105) < 1e-6);
});

test('el precio unitario guardado es el mismo del que sale el costo', () => {
  assert.match(SG, /ins\.run\(codigo, recepcionId, ocItem\.id, ocItem\.producto_id, kg, precioNetoKg, costoBase/,
    'si uno llevara IVA y el otro no, el costo por kilo no daría contra el total de la partida');
});
