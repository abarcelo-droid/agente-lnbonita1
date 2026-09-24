// ══ EL PLAN NO SE TRABA POR EL SOBRANTE QUE ÉL MISMO MANDÓ COMPRAR ═════════
//
// El motor frena el confirmar cuando el stock supera la necesidad. Ese chequeo se escribió cuando el
// stock se cargaba a mano y era el único origen posible: absorbía en silencio un tipeo de 120.000 por
// 12.000 y la fila mostraba «a comprar 0» como si fuera correcto. Sigue valiendo.
//
// Pero desde que hay recepciones, el módulo MISMO produce sobrantes: manda comprar 80 millares porque
// el pallet viene de a 10 y hacían falta 75, se reciben esos 80, y al confirmar el plan siguiente se
// bloquea por el sobrante que él prescribió. El operador no tiene nada que corregir y la única salida
// es tildar «forzar» todas las veces — que es como se apaga un semáforo.
//
// Corre el MOTOR REAL: el veredicto que se mide es el que decide si el plan se puede confirmar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const RUTA = leer('src/rutas/planificacion.js');
const PANEL = leer('src/panel.html');
const { calcularPlan } = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/pli_motor.js')));

function fuente(txt, firma) {
  const i = txt.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  let prof = 0, k = txt.indexOf('{', i);
  for (; k < txt.length; k++) {
    if (txt[k] === '{') prof++;
    else if (txt[k] === '}') { prof--; if (prof === 0) break; }
  }
  return txt.slice(i, k + 1);
}

// CAJA GRANDE: se compra por millar, el pallet viene de a 10 millares. Es el insumo donde el propio
// loteo genera el sobrante, y es un insumo real del módulo.
const INSUMO = {
  id: 1, nombre: 'CAJA GRANDE 600*400*180', unidad_compra: 'MILLAR', unidad_uso: 'unidad',
  factor_compra: 1000, multiplo_compra: 10, moq: 0, lead_time_dias: 15, modo_provision: 'compra',
  precio_ref: 1811.30, moneda: 'ARS',
};

function correr({ stockUso, necesidadUso, recibidos }) {
  const ctx = {
    plan: { id: 5 },
    productos: [{ id: 1, padre_id: null, nombre: 'MELÓN', unidad: 'kg', activo: 1, receta_version: 1 }],
    objetivos: [{ producto_id: 1, cantidad: necesidadUso, unidad: 'kg', bucket_ini: '2026-11-02' }],
    recetas: new Map([[1, [{ producto_id: 1, insumo_id: 1, cantidad: 1, por_cada: 1,
      unidad: 'unidad', merma_pct: 0, version: 1, orden: 1 }]]]),
    insumos: new Map([[1, INSUMO]]),
    existencias: new Map([[1, stockUso]]),
    comprado: new Map(),
  };
  if (recibidos) ctx.recibidos = new Set([1]);
  const r = calcularPlan(ctx);
  const l = r.lineas.find((x) => x.insumo_id === 1);
  return {
    comprar: l ? l.bultos_a_comprar : 0,
    ok: r.cobertura.ok,
    frena: r.cobertura.existencia_supera_necesidad.length,
    avisa: (r.cobertura.sobra_por_recepcion || []).length,
    advertencias: r.advertencias,
  };
}

test('el módulo manda comprar 80 por el pallet, y recibir esos 80 no traba el plan siguiente', () => {
  // PASO 1 — hacen falta 75 millares y el pallet viene de a 10: el motor manda comprar 80.
  const paso1 = correr({ stockUso: 0, necesidadUso: 75000, recibidos: false });
  assert.equal(paso1.comprar, 80, 'el loteo dejó de redondear al múltiplo');
  assert.equal(paso1.ok, true);

  // PASO 2 — se reciben esos 80: 80.000 unidades en el depósito contra una necesidad de 75.000.
  // El sobrante es de 5.000, y lo prescribió el motor.
  const paso2 = correr({ stockUso: 80000, necesidadUso: 75000, recibidos: true });
  assert.equal(paso2.ok, true, 'el plan se traba por el sobrante que el propio motor mandó comprar');
  assert.equal(paso2.frena, 0);
  assert.equal(paso2.avisa, 1, 'el sobrante tiene que avisarse: es plata parada en el depósito');
  assert.match(paso2.advertencias.join(' | '), /sobrante de lo que ya se recibió/);
  // Y el aviso trae los dos números: sin ellos no se puede decidir si es sobrante o error.
  assert.match(paso2.advertencias.join(' | '), /80.000 unidad/);
  assert.match(paso2.advertencias.join(' | '), /75.000/);
});

test('sin recepciones, el tipeo de 120.000 por 12.000 sigue frenando', () => {
  // Es para lo que se escribió el chequeo, y el caso sigue existiendo: el stock se puede cargar a
  // mano desde la ficha del insumo y desde el arqueo del plan.
  const r = correr({ stockUso: 120000, necesidadUso: 12000, recibidos: false });
  assert.equal(r.ok, false, 'un stock diez veces mayor que la necesidad dejó de frenar');
  assert.equal(r.frena, 1);
  assert.equal(r.avisa, 0);
});

test('el motor sin la lista de recepciones se comporta exactamente como antes', () => {
  // Importa porque calcularPlan lo llaman varios lugares —el costeo de un producto, entre otros— y
  // un plan ya confirmado no puede cambiar de veredicto porque se agregó un parámetro.
  const r = correr({ stockUso: 80000, necesidadUso: 75000, recibidos: false });
  assert.equal(r.ok, false);
  assert.equal(r.frena, 1);
});

test('el sobrante explicable NO entra en el veredicto que bloquea', () => {
  const m = leer('src/servicios/pli_motor.js');
  const veredicto = m.slice(m.indexOf('cobertura.ok = ('), m.indexOf(');', m.indexOf('cobertura.ok = (')));
  assert.match(veredicto, /existencia_supera_necesidad\.length === 0/);
  assert.ok(!/sobra_por_recepcion/.test(veredicto),
    'el sobrante por recepción volvió a bloquear el confirmar');
});

test('la ruta le dice al motor qué insumos tienen recepciones, en los dos caminos', () => {
  // Son dos: el plan en borrador y el confirmado que se recalcula del snapshot. Con uno solo, el
  // veredicto cambiaría al confirmar.
  assert.match(fuente(RUTA, 'function armarContexto(soc, plan)'), /const recibidos = insumosConRecepcion\(\);/);
  assert.match(fuente(RUTA, 'function armarContexto(soc, plan)'), /existencias, comprado, recibidos \};/);
  assert.match(fuente(RUTA, 'function bucketsDesdeSnapshot(plan)'), /recibidos: insumosConRecepcion\(\),/);
  // Y mira TODO el módulo, no sólo este plan: la mercadería que llegó por el plan pasado está en el
  // mismo depósito.
  const f = fuente(RUTA, 'function insumosConRecepcion()');
  assert.match(f, /recibido_cantidad IS NOT NULL AND recibido_cantidad > 0/);
  assert.ok(!/plan_id/.test(f), 'sólo mira las recepciones de un plan');
  assert.match(f, /eliminado_en IS NULL/, 'cuenta las recepciones de compras borradas');
});

test('el cartel no le dice «declaraste» a un número que puso una recepción', () => {
  const f = fuente(PANEL, 'function pliCoberturaHtml');
  assert.match(f, /declaraste ' \+ pliN\(e\.declarada\)/);
  assert.match(f, /el plan consume/);
  assert.match(f, /revisá si es un error de carga/);
  // El sobrante explicable no se dibuja acá: va entre las advertencias, que no exigen tildar nada.
  assert.ok(!/sobra_por_recepcion/.test(f), 'el sobrante explicable volvió al cartel que frena');
});
