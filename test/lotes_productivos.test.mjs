// test/lotes_productivos.test.mjs
// ══════════════════════════════════════════════════════════════════════════════════════
// 🌱 UN LOTE QUE TODAVÍA NO PRODUCE — y a dónde va su gasto
// ══════════════════════════════════════════════════════════════════════════════════════
// Andy, 2/11/2026: «los gastos en lotes NO PRODUCTIVOS que vayan al centro de costos
// INVERSION».
//
// Lo que estos tests cuidan no es que el código corra: es que un gasto no se vaya a la
// columna equivocada. Una imputación mal puesta NO DA ERROR —da un balance distinto— y
// se descubre meses después, cuando ya está firmado.
//
// Hay dos copias de la misma regla y las dos se prueban acá:
//   · la de JS, en servicios/lotesProductivos.js, que es la que ve la pantalla;
//   · la de SQL, el trigger pa_costo_a_inversion de db_pa.js, que es la que ESCRIBE.
// Si una cambia y la otra no, la pantalla dice una cosa y la base guarda otra. El
// bloque 8 prueba el trigger INSERTANDO y mirando la fila, no leyendo el SQL: un
// trigger es invisible para quien lee el INSERT y lo único que demuestra que corre es
// correrlo.
// ══════════════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  nombreCampania, noProduce, esProductivo, productivosDe, destinoDelGasto,
  rubroInversion, marcarNoProduce, lotesDeTemporada, resumenInversion,
  costosDeInversion,
} from '../src/servicios/lotesProductivos.js';

// ── El molde de base ────────────────────────────────────────────────────────────────
// Se recrea el pedazo de esquema que la regla toca, no la base entera: lo que se prueba
// es a dónde va un peso, y eso depende de cuatro columnas.
function base(opts) {
  const o = opts || {};
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_campañas (id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL, tipo TEXT, activa INTEGER DEFAULT 0);
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
      hectareas REAL, año_plantacion INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT,
      lote_id INTEGER NOT NULL, campaña TEXT NOT NULL, cultivo TEXT,
      es_perenne INTEGER DEFAULT 0, mes_siembra TEXT, mes_cosecha TEXT,
      hectareas_sembradas REAL
      ${o.sinColumnas ? '' : ', en_desarrollo INTEGER DEFAULT 0, productividad_pct INTEGER'},
      UNIQUE(lote_id, campaña));
    CREATE TABLE pa_rubros_contables (id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL, tipo_labor TEXT);
  `);
  // Tres temporadas, como en la base de verdad: dos anuales y una estacional.
  for (const [n, t, a] of [['2026/27', 'anual', 1], ['2027/28', 'anual', 0],
    ['Inv 2026', 'estacional', 1]]) {
    db.prepare('INSERT INTO pa_campañas (nombre,tipo,activa) VALUES (?,?,?)').run(n, t, a);
  }
  // El catálogo siembra INVERSION: no se crea, se usa el que está.
  for (const n of ['MO PRODUCCIÓN DAMASCO', 'INVERSION', 'SANIDAD']) {
    db.prepare('INSERT INTO pa_rubros_contables (nombre,tipo_labor) VALUES (?,?)')
      .run(n, 'otro');
  }
  for (const [id, nom, finca] of [[32, '32-39', 'Puente Cordón'],
    [41, '41 Nuevo', 'Puente Cordón'], [7, '7 Viejo', 'La Esperanza']]) {
    db.prepare('INSERT INTO pa_lotes (id,nombre,finca,hectareas,activo)'
      + ' VALUES (?,?,?,?,1)').run(id, nom, finca, 4.5);
  }
  return db;
}
const cultivo = (db, lote, camp, cultivoNom) => db.prepare(
  'INSERT INTO pa_cultivos_lote (lote_id,campaña,cultivo) VALUES (?,?,?)')
  .run(lote, camp, cultivoNom || 'Damasco');
const marca = (db, lote, camp, ed, pp) => db.prepare(
  'UPDATE pa_cultivos_lote SET en_desarrollo=?, productividad_pct=?'
  + ' WHERE lote_id=? AND campaña=?').run(ed, pp, lote, camp);

// ══════════════════════════════════════════════════════════════════════════════════════
// 1 · LA REGLA
// ══════════════════════════════════════════════════════════════════════════════════════
test('LA REGLA: en desarrollo CON 0% no produce', () => {
  assert.equal(noProduce({ en_desarrollo: 1, productividad_pct: 0 }), true);
});

test('en desarrollo CON un % mayor a 0 YA PRODUCE', () => {
  /* El criterio contable es que una plantación se activa hasta que ENTRA en producción
     comercial, no hasta que llega al 100%. Un lote al 60% ya vende fruta: su gasto es
     costo de producción. */
  assert.equal(noProduce({ en_desarrollo: 1, productividad_pct: 60 }), false);
  assert.equal(noProduce({ en_desarrollo: 1, productividad_pct: 5 }), false);
});

test('UN % VACÍO NO ACTIVA NADA: vacío es «no sé»', () => {
  /* Hay filas con en_desarrollo=1 cargadas antes de que esta regla existiera. Si el
     vacío activara, toda esa historia se mudaría de golpe a inversión sin que nadie lo
     haya decidido — y eso no se nota hasta que el contador mira el balance. */
  assert.equal(noProduce({ en_desarrollo: 1, productividad_pct: null }), false);
  assert.equal(noProduce({ en_desarrollo: 1, productividad_pct: '' }), false);
});

test('un lote maduro no activa nada ni con 0%', () => {
  // Sin en_desarrollo el % no significa nada: el 0 ahí es ruido de una carga vieja.
  assert.equal(noProduce({ en_desarrollo: 0, productividad_pct: 0 }), false);
});

test('sin fila, no hay nada que activar', () => {
  assert.equal(noProduce(null), false);
  assert.equal(noProduce(undefined), false);
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 2 · SIN DATO ES QUE SÍ PRODUCE
// ══════════════════════════════════════════════════════════════════════════════════════
test('UN LOTE SIN MARCAR PRODUCE: es el comportamiento de hoy', () => {
  /* La decisión más importante del módulo. El día que esto se instala ningún lote tiene
     el dato: si la ausencia significara «no produce», toda la temporada se iría a
     inversión sin que nadie haya decidido nada. */
  const db = base();
  cultivo(db, 32, '2026/27');
  assert.equal(esProductivo(db, 32, '2026/27'), true);
});

test('un lote sin cultivo cargado produce', () => {
  const db = base();
  assert.equal(esProductivo(db, 32, '2026/27'), true);
});

test('SIN LAS COLUMNAS TODAVÍA, TODO IMPUTA COMO HASTA HOY', () => {
  // Una base vieja a la que no le corrió la migración: que falte el dato no puede
  // cambiar a dónde va un gasto.
  const db = base({ sinColumnas: true });
  cultivo(db, 41, '2026/27');
  assert.equal(esProductivo(db, 41, '2026/27'), true);
  assert.deepEqual(destinoDelGasto(db, 41, '2026/27'), { a_inversion: 0, motivo: null });
});

test('un lote inválido o una temporada vacía producen', () => {
  const db = base();
  assert.equal(esProductivo(db, null, '2026/27'), true);
  assert.equal(esProductivo(db, 'abc', '2026/27'), true);
  assert.equal(esProductivo(db, 32, ''), true);
  assert.equal(esProductivo(db, 32, null), true);
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 3 · CADA TEMPORADA DECIDE LA SUYA
// ══════════════════════════════════════════════════════════════════════════════════════
test('EL MISMO LOTE: no produce en una temporada y sí en la siguiente', () => {
  /* Por esto el dato va en pa_cultivos_lote y no en pa_lotes. Guardarlo en el lote
     obligaría a reescribir el pasado cada vez que uno entra en producción, y los costos
     ya activados del año anterior dejarían de estar activados. */
  const db = base();
  cultivo(db, 41, '2026/27');
  cultivo(db, 41, '2027/28');
  marca(db, 41, '2026/27', 1, 0);
  assert.equal(esProductivo(db, 41, '2026/27'), false);
  assert.equal(esProductivo(db, 41, '2027/28'), true);
});

test('la campaña entra por nombre o por id, y da lo mismo', () => {
  // pa_cultivos_lote la guarda como TEXTO; un costo la trae como id.
  const db = base();
  cultivo(db, 41, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  assert.equal(esProductivo(db, 41, '2026/27'), false, 'por nombre');
  assert.equal(esProductivo(db, 41, 1), false, 'por id');
});

test('nombreCampania no confunde un nombre con un id', () => {
  const db = base();
  assert.equal(nombreCampania(db, '2026/27'), '2026/27');
  assert.equal(nombreCampania(db, 'Inv 2026'), 'Inv 2026');
  assert.equal(nombreCampania(db, 1), '2026/27');
  assert.equal(nombreCampania(db, '3'), 'Inv 2026');
  assert.equal(nombreCampania(db, 999), '', 'un id que no existe');
  assert.equal(nombreCampania(db, ''), '');
  assert.equal(nombreCampania(db, null), '');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 4 · MUCHOS LOTES DE UNA
// ══════════════════════════════════════════════════════════════════════════════════════
test('productivosDe: una consulta para la orden entera', () => {
  const db = base();
  for (const l of [32, 41, 7]) cultivo(db, l, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  marca(db, 7, '2026/27', 1, 50);        // produce parcialmente
  const m = productivosDe(db, [32, 41, 7], '2026/27');
  assert.equal(m.get(32), true);
  assert.equal(m.get(41), false);
  assert.equal(m.get(7), true, 'el que produce al 50% produce');
});

test('un lote que no está en la base igual viene con su default', () => {
  // Si no apareciera, quien llama tendría que acordarse de tratar el undefined — y la
  // mitad de las veces lo leería como falso.
  const db = base();
  const m = productivosDe(db, [32, 999], '2026/27');
  assert.equal(m.get(999), true);
  assert.equal(m.size, 2);
});

test('ids repetidos o basura no rompen la consulta', () => {
  const db = base();
  cultivo(db, 41, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  const m = productivosDe(db, [41, 41, null, 'x', 32], '2026/27');
  assert.equal(m.size, 2);
  assert.equal(m.get(41), false);
});

test('sin lotes no hay consulta', () => {
  const db = base();
  assert.equal(productivosDe(db, [], '2026/27').size, 0);
  assert.equal(productivosDe(db, null, '2026/27').size, 0);
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 5 · EL DESTINO, Y SU MOTIVO
// ══════════════════════════════════════════════════════════════════════════════════════
test('UN GASTO EN UN LOTE QUE NO PRODUCE SE ACTIVA, Y DICE POR QUÉ', () => {
  /* El motivo no es decorativo: un número que cambió de columna sin razón visible es un
     número que nadie firma. */
  const db = base();
  cultivo(db, 41, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  const d = destinoDelGasto(db, 41, '2026/27');
  assert.equal(d.a_inversion, 1);
  assert.match(d.motivo, /INVERSIÓN/);
  assert.match(d.motivo, /2026\/27/, 'el motivo nombra la temporada');
});

test('EL RUBRO SE BUSCA POR NOMBRE, NO POR UN ID ESCRITO A MANO', () => {
  /* Los ids de un catálogo sembrado cambian entre bases: un id fijo acá apuntaría a
     otro rubro en la próxima instalación, y el gasto se iría a SANIDAD sin avisar. */
  const db = base();
  const r = rubroInversion(db);
  assert.equal(r.nombre, 'INVERSION');
  assert.equal(r.id, 2, 'en esta base quedó segundo — por eso no se escribe el id');
});

test('sin el catálogo cargado, rubroInversion no tira', () => {
  const db = base();
  db.exec('DROP TABLE pa_rubros_contables');
  assert.equal(rubroInversion(db), null);
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 6 · MARCAR UN LOTE
// ══════════════════════════════════════════════════════════════════════════════════════
test('marcar «todavía no produce» escribe el 0 EXPLÍCITO', () => {
  // Explícito y no vacío: el vacío es «no sé» y no activa (bloque 1).
  const db = base();
  cultivo(db, 41, '2026/27');
  const r = marcarNoProduce(db, 41, '2026/27', false);
  assert.equal(r.ok, true);
  assert.equal(r.en_desarrollo, 1);
  assert.equal(r.productividad_pct, 0);
  assert.equal(r.a_inversion, 1);
  assert.equal(esProductivo(db, 41, '2026/27'), false);
});

test('marcar «produce» apaga en_desarrollo entero', () => {
  const db = base();
  cultivo(db, 41, '2026/27');
  marcarNoProduce(db, 41, '2026/27', false);
  const r = marcarNoProduce(db, 41, '2026/27', true);
  assert.equal(r.en_desarrollo, 0);
  assert.equal(r.productividad_pct, null);
  assert.equal(r.a_inversion, 0);
});

test('produce parcialmente guarda el %, y no activa', () => {
  const db = base();
  cultivo(db, 7, '2026/27');
  const r = marcarNoProduce(db, 7, '2026/27', true, 60);
  assert.equal(r.en_desarrollo, 1);
  assert.equal(r.productividad_pct, 60);
  assert.equal(r.a_inversion, 0);
});

test('UN 0% CON «PRODUCE» NO SE GUARDA COMO 0: sería una contradicción', () => {
  /* Guardarlo tal cual lo mandaría a inversión justo cuando se dijo que produce. El
     piso es 1. */
  const db = base();
  cultivo(db, 7, '2026/27');
  const r = marcarNoProduce(db, 7, '2026/27', true, 0);
  assert.equal(r.productividad_pct, 1);
  assert.equal(r.a_inversion, 0);
  assert.equal(esProductivo(db, 7, '2026/27'), true);
});

test('el % se recorta a 1-100', () => {
  const db = base();
  cultivo(db, 7, '2026/27');
  assert.equal(marcarNoProduce(db, 7, '2026/27', true, 500).productividad_pct, 100);
  assert.equal(marcarNoProduce(db, 7, '2026/27', true, -8).productividad_pct, 1);
});

test('NO SE INVENTA UN CULTIVO: sin la fila, no se marca', () => {
  /* La fila la crea quien carga QUÉ se plantó. Inventarla acá dejaría un lote con
     cultivo vacío que después nadie entiende, y encima marcado. */
  const db = base();
  const r = marcarNoProduce(db, 32, '2026/27', false);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no tiene cultivo cargado/);
  assert.match(r.motivo, /2026\/27/, 'el aviso no nombra la temporada');
  /* Y dice QUÉ HACER. Un aviso que sólo nombra el problema deja al operador mirando la
     pantalla: el cultivo se carga en la ficha del lote, que no es donde está parado. */
  assert.match(r.motivo, /Cargalo primero/);
});

test('marcar sin lote o sin temporada avisa, no revienta', () => {
  const db = base();
  assert.equal(marcarNoProduce(db, 'x', '2026/27', false).ok, false);
  assert.equal(marcarNoProduce(db, 41, '', false).ok, false);
  assert.equal(marcarNoProduce(db, 41, 999, false).ok, false, 'campaña inexistente');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 7 · LA PANTALLA
// ══════════════════════════════════════════════════════════════════════════════════════
test('LOS LOTES SIN CULTIVO CARGADO APARECEN IGUAL', () => {
  /* Un LEFT JOIN desde los LOTES y no desde los cultivos. Si el lote sin cultivo no
     apareciera, el que revisa no lo ve y cree que está todo marcado. */
  const db = base();
  cultivo(db, 41, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  const ls = lotesDeTemporada(db, '2026/27');
  assert.equal(ls.length, 3, 'los tres lotes activos');
  const sin = ls.filter((l) => l.sin_cultivo === 1).map((l) => l.id).sort((a,b)=>a-b);
  assert.deepEqual(sin, [7, 32]);
});

test('la pantalla recibe el destino ya resuelto', () => {
  // Que no haya dos versiones de la regla, una en el JS del navegador y otra en SQL.
  const db = base();
  for (const l of [32, 41, 7]) cultivo(db, l, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  marca(db, 7, '2026/27', 1, 40);
  const por = {};
  for (const l of lotesDeTemporada(db, '2026/27')) por[l.id] = l.a_inversion;
  assert.deepEqual(por, { 32: 0, 41: 1, 7: 0 });
});

test('un lote dado de baja no se lista', () => {
  const db = base();
  db.prepare('UPDATE pa_lotes SET activo=0 WHERE id=?').run(7);
  assert.equal(lotesDeTemporada(db, '2026/27').length, 2);
});

test('el cultivo de OTRA temporada no se cuela en esta', () => {
  // El JOIN lleva la campaña: sin eso, un lote mostraría la marca del año pasado.
  const db = base();
  cultivo(db, 41, '2027/28');
  marca(db, 41, '2027/28', 1, 0);
  const l = lotesDeTemporada(db, '2026/27').find((x) => x.id === 41);
  assert.equal(l.sin_cultivo, 1);
  assert.equal(l.a_inversion, 0);
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 8 · EL TRIGGER: lo clasifica la base, no los cuatro INSERT
// ══════════════════════════════════════════════════════════════════════════════════════
// Hay CUATRO INSERT INTO pa_costos_lote en rutas/produccion.js y son distintos entre sí:
// dos listan las columnas y dos no. Tocar los cuatro son cuatro oportunidades de
// escribirlo mal, y el quinto que alguien agregue mañana quedaría afuera.
//
// Se prueba INSERTANDO y mirando la fila, no leyendo el SQL: un trigger es invisible
// para quien lee el INSERT, y lo único que demuestra que corre es correrlo.
function conCostos(opts) {
  const db = base(opts);
  db.exec(`
    CREATE TABLE pa_costos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT,
      lote_id INTEGER NOT NULL, campaña_id INTEGER NOT NULL,
      campaña_anual_id INTEGER, campaña_estacional_id INTEGER,
      categoria TEXT NOT NULL, referencia_id INTEGER, fecha TEXT,
      monto REAL NOT NULL DEFAULT 0, descripcion TEXT,
      a_inversion INTEGER NOT NULL DEFAULT 0);
    DROP TRIGGER IF EXISTS pa_costo_a_inversion;
    CREATE TRIGGER pa_costo_a_inversion AFTER INSERT ON pa_costos_lote
    WHEN NEW.a_inversion = 0
    BEGIN
      UPDATE pa_costos_lote SET a_inversion = 1
       WHERE id = NEW.id AND EXISTS (
         SELECT 1 FROM pa_cultivos_lote cl
           JOIN pa_campañas c ON c.nombre = cl.campaña
          WHERE cl.lote_id = NEW.lote_id
            AND c.id = COALESCE(NEW.campaña_anual_id, NEW.campaña_id)
            AND cl.en_desarrollo = 1
            AND cl.productividad_pct = 0
       );
    END;
  `);
  return db;
}
// El SQL de arriba está copiado a mano del que instala db_pa.js, y el último test de
// este bloque lo compara con el archivo para que las dos copias no se separen.
const costo = (db, lote, campId, cat, monto) => {
  db.prepare('INSERT INTO pa_costos_lote (lote_id,campaña_id,campaña_anual_id,'
    + 'categoria,monto) VALUES (?,?,?,?,?)')
    .run(lote, campId, campId, cat || 'otros', monto == null ? 100 : monto);
  return db.prepare('SELECT * FROM pa_costos_lote ORDER BY id DESC LIMIT 1').get();
};

test('UN COSTO EN UN LOTE QUE NO PRODUCE SE ACTIVA SOLO', () => {
  const db = conCostos();
  cultivo(db, 41, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  assert.equal(costo(db, 41, 1, 'fertilizante', 5000).a_inversion, 1);
});

test('y en un lote que produce NO se activa', () => {
  const db = conCostos();
  cultivo(db, 32, '2026/27');
  assert.equal(costo(db, 32, 1, 'fertilizante', 5000).a_inversion, 0);
});

test('un lote al 60% tampoco: ya produce', () => {
  const db = conCostos();
  cultivo(db, 7, '2026/27');
  marca(db, 7, '2026/27', 1, 60);
  assert.equal(costo(db, 7, 1, 'cosecha', 9000).a_inversion, 0);
});

test('EL TRIGGER NO ACTIVA CON EL % VACÍO, igual que el JS', () => {
  // Las dos copias de la regla tienen que decir lo mismo. Ésta es la que escribe.
  const db = conCostos();
  cultivo(db, 41, '2026/27');
  marca(db, 41, '2026/27', 1, null);
  assert.equal(costo(db, 41, 1).a_inversion, 0);
  assert.equal(esProductivo(db, 41, '2026/27'), true, 'y el JS dice lo mismo');
});

test('LA CATEGORÍA NO CAMBIA: un fertilizante sigue siendo fertilizante', () => {
  /* Son dos dimensiones —qué se gastó y dónde imputa— y meterlas en un solo campo
     perdería la primera para siempre: después nadie puede decir cuánto se gastó en
     fertilizante, sólo cuánto se activó. */
  const db = conCostos();
  cultivo(db, 41, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  const c = costo(db, 41, 1, 'fertilizante', 5000);
  assert.equal(c.categoria, 'fertilizante');
  assert.equal(c.monto, 5000);
  assert.equal(c.a_inversion, 1);
});

test('EL DESTINO QUEDA CONGELADO: que el lote entre en producción no lo cambia', () => {
  /* El día que el lote pase a productivo, lo que se activó el año pasado tiene que
     SEGUIR activado. Un informe que cambia de un año para otro porque una plantación
     creció no es un informe, y esa diferencia ya está en un balance firmado. */
  const db = conCostos();
  cultivo(db, 41, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  const c = costo(db, 41, 1, 'fertilizante', 5000);
  assert.equal(c.a_inversion, 1);

  marcarNoProduce(db, 41, '2026/27', true);
  const despues = db.prepare('SELECT * FROM pa_costos_lote WHERE id=?').get(c.id);
  assert.equal(despues.a_inversion, 1, 'el costo ya activado cambió de destino');
});

test('cada temporada clasifica la suya', () => {
  const db = conCostos();
  cultivo(db, 41, '2026/27');
  cultivo(db, 41, '2027/28');
  marca(db, 41, '2026/27', 1, 0);
  assert.equal(costo(db, 41, 1).a_inversion, 1, 'la temporada en desarrollo');
  assert.equal(costo(db, 41, 2).a_inversion, 0, 'la temporada que ya produce');
});

test('LA ANUAL MANDA sobre la estacional', () => {
  /* Una estacional vive adentro de un año agrícola, y es el año el que define si la
     plantación ya produce. */
  const db = conCostos();
  cultivo(db, 41, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  db.prepare('INSERT INTO pa_costos_lote (lote_id,campaña_id,campaña_anual_id,'
    + 'campaña_estacional_id,categoria,monto) VALUES (41,3,1,3,?,?)')
    .run('labor_propia', 2000);
  assert.equal(db.prepare('SELECT a_inversion AS a FROM pa_costos_lote'
    + ' ORDER BY id DESC LIMIT 1').get().a, 1);
});

test('un INSERT viejo que sólo llena campaña_id igual se clasifica', () => {
  // El COALESCE los cubre: si no, esos costos nunca se clasificarían y nadie lo notaría.
  const db = conCostos();
  cultivo(db, 41, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  db.prepare('INSERT INTO pa_costos_lote (lote_id,campaña_id,categoria,monto)'
    + " VALUES (41,1,'otros',100)").run();
  assert.equal(db.prepare('SELECT a_inversion AS a FROM pa_costos_lote'
    + ' ORDER BY id DESC LIMIT 1').get().a, 1);
});

test('un INSERT que ya trae a_inversion en 1 no se pisa', () => {
  // Si algún día hay que forzar la imputación a mano, el trigger no la toca.
  const db = conCostos();
  cultivo(db, 32, '2026/27');
  db.prepare('INSERT INTO pa_costos_lote (lote_id,campaña_id,campaña_anual_id,'
    + "categoria,monto,a_inversion) VALUES (32,1,1,'otros',100,1)").run();
  assert.equal(db.prepare('SELECT a_inversion AS a FROM pa_costos_lote'
    + ' ORDER BY id DESC LIMIT 1').get().a, 1);
});

test('un lote sin marca no se activa, venga de donde venga el INSERT', () => {
  const db = conCostos();
  // Ni siquiera tiene cultivo cargado: es el estado del día que esto se instala.
  assert.equal(costo(db, 32, 1, 'cosecha', 9000).a_inversion, 0);
});

// ── Y las dos copias de la regla no se separan ──────────────────────────────────────
// Si alguien cambia el trigger de db_pa.js y no éste, los tests de arriba pasan igual y
// la base clasifica distinto que la pantalla. Esto lo clava comparando con el archivo.
test('EL TRIGGER DEL TEST ES EL MISMO QUE INSTALA db_pa.js', async () => {
  const fs = await import('node:fs');
  const todo = fs.readFileSync(
    new URL('../src/servicios/db_pa.js', import.meta.url), 'utf8');
  /* Se recorta el SQL DEL TRIGGER y no se mira el archivo entero: arriba del trigger
     hay un comentario que explica por qué dice `WHEN NEW.a_inversion = 0`, y con el
     archivo completo ese comentario hacía pasar el test aunque el SQL dijera otra
     cosa. Lo encontró la prueba de mutación. */
  const i = todo.indexOf('DROP TRIGGER IF EXISTS pa_costo_a_inversion;');
  assert.ok(i > 0, 'db_pa.js ya no instala el trigger');
  const fuente = todo.slice(i, todo.indexOf('END;', i) + 4);
  for (const linea of [
    'CREATE TRIGGER pa_costo_a_inversion AFTER INSERT ON pa_costos_lote',
    'WHEN NEW.a_inversion = 0',
    'UPDATE pa_costos_lote SET a_inversion = 1',
    'AND c.id = COALESCE(NEW.campaña_anual_id, NEW.campaña_id)',
    'AND cl.en_desarrollo = 1',
    'AND cl.productividad_pct = 0',
  ]) {
    assert.ok(fuente.includes(linea),
      'db_pa.js ya no instala esta línea del trigger: ' + linea);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 9 · EL NÚMERO QUE JUSTIFICA TODO ESTO
// ══════════════════════════════════════════════════════════════════════════════════════
// Sin un total y su detalle, marcar un lote no se ve en ninguna parte y nadie lo hace.
test('el resumen separa lo activado de lo gastado', () => {
  const db = conCostos();
  cultivo(db, 41, '2026/27');
  cultivo(db, 32, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  costo(db, 41, 1, 'fertilizante', 5000);
  costo(db, 41, 1, 'labor_propia', 3000);
  costo(db, 32, 1, 'cosecha', 12000);
  const r = resumenInversion(db, 1);
  assert.equal(r.inversion, 8000);
  assert.equal(r.produccion, 12000);
  assert.equal(r.costos, 3);
});

test('el resumen de otra temporada no mezcla', () => {
  const db = conCostos();
  cultivo(db, 41, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  costo(db, 41, 1, 'fertilizante', 5000);
  const r = resumenInversion(db, 2);
  assert.equal(r.inversion, 0);
  assert.equal(r.costos, 0);
});

test('EL DETALLE SE PUEDE MIRAR: un total sin detalle no se revisa', () => {
  const db = conCostos();
  cultivo(db, 41, '2026/27');
  marca(db, 41, '2026/27', 1, 0);
  costo(db, 41, 1, 'fertilizante', 5000);
  costo(db, 32, 1, 'cosecha', 12000);
  const d = costosDeInversion(db, 1);
  assert.equal(d.length, 1, 'sólo lo activado');
  assert.equal(d[0].lote, '41 Nuevo');
  assert.equal(d[0].monto, 5000);
  assert.equal(d[0].categoria, 'fertilizante');
});

test('sin la tabla de costos, el resumen da 0 y no tira', () => {
  const db = base();
  assert.deepEqual(resumenInversion(db, 1),
    { inversion: 0, produccion: 0, costos: 0 });
  assert.deepEqual(costosDeInversion(db, 1), []);
});
