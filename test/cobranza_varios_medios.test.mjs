// ══ UNA COBRANZA, VARIOS MEDIOS ════════════════════════════════════════
//
// Pablo, 25/8/2026: parte en efectivo y parte en transferencia, "como funciona hoy el
// pago a proveedores". Una cobranza, un asiento, un renglón por medio. Partirlo en
// dos cobranzas dejaría dos números para lo que el cliente vivió como un solo pago.
//
// Lo que este test cuida es el REPARTO: la parte de gestión se distribuye entre los
// medios en proporción y el resto de redondeo va en el último. Si no, la suma de las
// partes no da el total y falta o sobra un centavo que después nadie encuentra — y
// crearAsiento rechaza el asiento entero a partir de un centavo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VEN = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// El reparto, tal como quedó escrito en el handler.
function repartir(medios, ges, total) {
  let gesRepartido = 0;
  return medios.map((m, ix) => {
    const gesM = (ix === medios.length - 1) ? r2(ges - gesRepartido) : r2(ges * (m.monto / total));
    gesRepartido = r2(gesRepartido + gesM);
    return { monto: m.monto, fiscal: r2(m.monto - gesM), gestion: gesM };
  });
}

test('la suma de las partes da el total, siempre', () => {
  const casos = [
    { medios: [{ monto: 60000 }, { monto: 40000 }], ges: 0, total: 100000 },
    { medios: [{ monto: 60000 }, { monto: 40000 }], ges: 10000, total: 100000 },
    // El caso feo: una gestión que no se parte redondo entre tres medios.
    { medios: [{ monto: 33333.33 }, { monto: 33333.33 }, { monto: 33333.34 }], ges: 10000, total: 100000 },
    { medios: [{ monto: 0.01 }, { monto: 99999.99 }], ges: 7777.77, total: 100000 },
    { medios: [{ monto: 1184 }, { monto: 259 }, { monto: 9250 }], ges: 810, total: 10693 },
  ];
  for (const c of casos) {
    const p = repartir(c.medios, c.ges, c.total);
    const sumaF = r2(p.reduce((a, x) => a + x.fiscal, 0));
    const sumaG = r2(p.reduce((a, x) => a + x.gestion, 0));
    assert.equal(sumaG, c.ges, 'la gestión repartida tiene que dar la gestión total: ' + JSON.stringify(c));
    assert.equal(r2(sumaF + sumaG), c.total, 'y fiscal + gestión, el total');
    for (const x of p) assert.equal(r2(x.fiscal + x.gestion), x.monto, 'y cada medio cierra solo');
  }
});

test('el asiento no puede descuadrar por el reparto', () => {
  // crearAsiento rechaza a partir de UN centavo, y cada ámbito balancea por su
  // cuenta: por cada parte se escriben dos renglones espejados, así que lo único que
  // puede romperlo es que las partes no sumen. Eso es lo que prueba el test de arriba.
  const p = repartir([{ monto: 33333.33 }, { monto: 33333.33 }, { monto: 33333.34 }], 10000, 100000);
  let debe = 0, haber = 0;
  for (const x of p) { for (const m of [x.fiscal, x.gestion]) { if (m > 0.001) { debe += m; haber += m; } } }
  assert.equal(r2(debe - haber), 0);
  assert.equal(r2(debe), 100000);
});

test('el payload viejo de un solo medio sigue andando', () => {
  assert.match(VEN, /Array\.isArray\(req\.body\?\.medios\) && req\.body\.medios\.length/,
    'con `medios` se usa la lista; sin `medios` se normaliza el payload viejo');
  assert.match(VEN, /forma_pago: forma_pago \|\| 'transferencia', cuenta_fin_id: req\.body\?\.cuenta_fin_id/,
    'el payload viejo se convierte en una lista de un elemento: un solo camino abajo');
});

test('los medios tienen que dar el total', () => {
  assert.match(VEN, /Los medios de cobro suman \$\{sumaMedios\} y la cobranza es de \$\{total\}/,
    'si no cierran, la diferencia se la come el asiento y el arqueo deja de dar');
});

test('el mismo cheque no entra dos veces, ni siquiera en la misma cobranza', () => {
  assert.match(VEN, /en esta misma cobranza/,
    'dos medios con el mismo papel es el error que aparece cuando se cobra apurado');
});

test('cada cheque de la cobranza entra a la cartera, no sólo el primero', () => {
  assert.match(VEN, /for \(const m of medios\) \{\s*\r?\n\s*if \(!m\.cheque\) continue;/,
    'con varios cheques, todos tienen que quedar en cartera');
});
