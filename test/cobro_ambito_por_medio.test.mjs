// ══ CONTRA QUÉ MITAD VA CADA MEDIO DE COBRO ════════════════════════════════
//
// Pablo, 27/8/2026: «la forma de pago tiene que viajar en cada renglón de plata».
//
// Es además la regla del repo: el ámbito viaja en la LÍNEA, nunca en el
// recipiente. Hasta acá se elegía UNA vez para toda la cobranza y la parte de
// gestión se repartía entre los medios EN PROPORCIÓN al importe. No había forma de
// decir «estos 10.000 son lo facturado y entraron en efectivo, y estos otros
// 10.000 son los de gestión y vinieron por transferencia»: había que cargar dos
// cobranzas para lo que el cliente vivió como un solo pago.
//
// Esto es aritmética de PLATA: un centavo perdido en el reparto es un asiento que
// no balancea. Por eso el test la CORRE, no la mira.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repartirAmbito, partesDeMedio, ambitoDeMedio }
  from '../src/servicios/sg_cobro_ambito.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENTAS = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');

const suma = (a) => Math.round(a.reduce((x, y) => x + y, 0) * 100) / 100;

// ── EL CASO DE PABLO ───────────────────────────────────────────────────────
test('los 10.000 facturados en efectivo y los 10.000 de gestión por transferencia', () => {
  // Se facturó 10.000, se acordó 20.000. El cliente paga las dos mitades con
  // medios distintos, en UN solo pago.
  const medios = [
    { monto: 10000, ambito: 'fiscal' },
    { monto: 10000, ambito: 'gestion' },
  ];
  const g = repartirAmbito(medios, 10000, 20000);
  assert.deepEqual(g, [0, 10000]);
  // El efectivo cancela sólo lo facturado; la transferencia sólo lo de gestión.
  assert.deepEqual(partesDeMedio(10000, g[0], 'ajuste_gestion'),
    [{ ambito: 'fiscal', monto: 10000, motivo: null }]);
  assert.deepEqual(partesDeMedio(10000, g[1], 'ajuste_gestion'),
    [{ ambito: 'gestion', monto: 10000, motivo: 'ajuste_gestion' }]);
});

test('al revés también: lo de gestión en efectivo y lo facturado por transferencia', () => {
  const g = repartirAmbito([
    { monto: 10000, ambito: 'gestion' },
    { monto: 10000, ambito: 'fiscal' },
  ], 10000, 20000);
  assert.deepEqual(g, [10000, 0]);
});

// ── LO QUE NO SE DECLARA SIGUE COMO ANTES ──────────────────────────────────
test('sin declarar nada, se prorratea — la ventanilla no cambia', () => {
  // La venta de ventanilla y el payload viejo no mandan ámbito. Tienen que seguir
  // funcionando exactamente igual, o el cambio rompe lo que ya andaba.
  const g = repartirAmbito([{ monto: 12000 }, { monto: 8000 }], 10000, 20000);
  assert.deepEqual(g, [6000, 4000]);
  assert.equal(suma(g), 10000, 'la gestión repartida tiene que dar el total de gestión');
});

test('un solo medio sin declarar se lleva toda la gestión', () => {
  assert.deepEqual(repartirAmbito([{ monto: 20000 }], 10000, 20000), [10000]);
});

test('sin parte de gestión, todo es fiscal', () => {
  const g = repartirAmbito([{ monto: 5000 }, { monto: 3000 }], 0, 8000);
  assert.deepEqual(g, [0, 0]);
});

// ── MEZCLAR DECLARADO Y SIN DECLARAR ───────────────────────────────────────
test('lo declarado manda y el resto se reparte entre los que no dijeron nada', () => {
  // 30.000 en total, 12.000 de gestión. Un medio declara 5.000 de gestión; los
  // otros dos se reparten los 7.000 que quedan, en proporción.
  const g = repartirAmbito([
    { monto: 5000, ambito: 'gestion' },
    { monto: 15000 },
    { monto: 10000 },
  ], 12000, 30000);
  assert.equal(g[0], 5000);
  assert.equal(suma(g), 12000, 'entre todos tienen que dar la gestión de la cobranza');
  assert.equal(g[1], 4200);   // 7000 × 15/25
  assert.equal(g[2], 2800);   // el último se lleva el resto
});

test('un medio fiscal declarado NO recibe gestión aunque quede libre', () => {
  const g = repartirAmbito([
    { monto: 10000, ambito: 'fiscal' },
    { monto: 10000 },
  ], 6000, 20000);
  assert.equal(g[0], 0, 'dijo fiscal: no se le puede meter gestión');
  assert.equal(g[1], 6000);
});

// ── EL CENTAVO ─────────────────────────────────────────────────────────────
test('el último se lleva el resto de redondeo: la suma SIEMPRE da', () => {
  // Un centavo perdido acá es un asiento que no balancea, y el error aparece en
  // el mayor tres meses después.
  for (const [ges, tot, ms] of [
    [1000, 3000, [1000, 1000, 1000]],
    [33.33, 100, [33.33, 33.33, 33.34]],
    [0.01, 3, [1, 1, 1]],
    [777.77, 1000, [333.33, 333.33, 333.34]],
  ]) {
    const g = repartirAmbito(ms.map((m) => ({ monto: m })), ges, tot);
    assert.equal(suma(g), Math.round(ges * 100) / 100,
      'con ges=' + ges + ' la suma dio ' + suma(g));
  }
});

test('ningún medio cancela más gestión que su propio importe', () => {
  // Si el reparto le diera de más a uno, su parte fiscal saldría NEGATIVA y el
  // asiento tendría una línea con importe negativo.
  const ms = [{ monto: 1 }, { monto: 1 }, { monto: 998 }];
  const g = repartirAmbito(ms, 999, 1000);
  ms.forEach((m, i) => assert.ok(g[i] <= m.monto + 0.001, 'medio ' + i + ' recibió de más'));
  for (const p of ms.flatMap((m, i) => partesDeMedio(m.monto, g[i], 'ajuste_gestion'))) {
    assert.ok(p.monto > 0, 'ninguna parte puede ser cero o negativa');
  }
});

// ── LO QUE NO ENTRA, SE FRENA ANTES DE ESCRIBIR ────────────────────────────
test('no se puede cobrar más gestión de la que el comprobante debe sin facturar', () => {
  // Dejaría el libro de gestión con un cobro por algo que nadie debía.
  assert.throws(
    () => repartirAmbito([{ monto: 15000, ambito: 'gestion' }, { monto: 5000 }], 10000, 20000),
    /contra la parte sin facturar/);
});

test('ni más facturado del que hay', () => {
  assert.throws(
    () => repartirAmbito([{ monto: 15000, ambito: 'fiscal' }, { monto: 5000 }], 10000, 20000),
    /contra lo facturado/);
});

test('justo en el límite entra', () => {
  assert.doesNotThrow(() => repartirAmbito([
    { monto: 10000, ambito: 'gestion' }, { monto: 10000, ambito: 'fiscal' }], 10000, 20000));
});

// ── LO QUE SE ACEPTA COMO ÁMBITO ───────────────────────────────────────────
test('vacío es «lo que toque», y cualquier cosa rara también', () => {
  // Un typo del front no puede inventar un ámbito nuevo: cae en el reparto de
  // siempre, que es el comportamiento seguro.
  assert.equal(ambitoDeMedio({ ambito: 'fiscal' }), 'fiscal');
  assert.equal(ambitoDeMedio({ ambito: 'gestion' }), 'gestion');
  assert.equal(ambitoDeMedio({ ambito: '' }), null);
  assert.equal(ambitoDeMedio({ ambito: 'FISCAL' }), null);
  assert.equal(ambitoDeMedio({ ambito: 'otra_cosa' }), null);
  assert.equal(ambitoDeMedio({}), null);
  assert.equal(ambitoDeMedio(null), null);
});

// ── LA CUENTA VIVE EN UN SOLO LUGAR ────────────────────────────────────────
test('el router usa el servicio, no una copia de la cuenta', () => {
  // Dos copias de una cuenta de plata son dos respuestas, y gana la que nadie mira.
  assert.match(VENTAS, /import \{ repartirAmbito, partesDeMedio \} from '\.\.\/servicios\/sg_cobro_ambito\.js'/);
  assert.match(VENTAS, /const gesPorMedio = repartirAmbito\(medios, ges, total\)/);
  assert.match(VENTAS, /const partesM = partesDeMedio\(m\.monto, gesM, motivoGes\)/);
  // Y no quedó el reparto viejo escrito adentro.
  assert.ok(!/r2c2\(ges \* \(m\.monto \/ total\)\)/.test(VENTAS), 'quedó el prorrateo viejo');
});

test('el ámbito del medio llega desde el pedido, en los DOS caminos', () => {
  // El del cheque y el de las cuentas. Si se sumara a uno solo, la mitad de los
  // medios lo perdería en silencio.
  assert.match(VENTAS, /const ambM = \['fiscal', 'gestion'\]\.includes\(String\(m\.ambito \|\| ''\)\)/);
  assert.equal((VENTAS.match(/medios\.push\(\{ forma, monto, ambito: ambM,/g) || []).length, 2);
});
