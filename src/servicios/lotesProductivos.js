// src/servicios/lotesProductivos.js
// ══════════════════════════════════════════════════════════════════════════════════════
// 🌱 UN LOTE QUE TODAVÍA NO PRODUCE — y a dónde va su gasto
// ══════════════════════════════════════════════════════════════════════════════════════
// Andy, 2/11/2026: «necesito agregar un campo que permita identificar si cada lote es
// productivo o no según cada temporada... los gastos en lotes NO PRODUCTIVOS que vayan
// al centro de costos INVERSION».
//
// ── EL CAMPO YA ESTABA ─────────────────────────────────────────────────────────────
// `pa_cultivos_lote.en_desarrollo` es por (lote, campaña) y su casillero en el panel
// dice, con esas palabras, «En desarrollo (no productivo al 100%)». Al lado tiene
// `productividad_pct`. Agregar un `productivo` nuevo serían dos columnas con el mismo
// significado y la polaridad invertida: el día que una se cargue y la otra no, no hay
// manera de saber cuál tiene razón.
//
// Lo que faltaba no era el campo. Era la CONSECUENCIA CONTABLE, que es este archivo.
//
// ── NO ES UNA ETIQUETA, ES UNA REGLA CONTABLE ──────────────────────────────────────
// Lo que se gasta en una plantación que todavía no produce NO ES GASTO DEL EJERCICIO:
// se ACTIVA. Una poda en un lote de dos años es inversión en la plantación; la misma
// poda en uno de ocho es costo de producción. La tarea es idéntica y el destino
// contable es el opuesto — y hasta hoy el sistema no tenía cómo distinguirlos.
//
// ── EL LOTE GANA SOBRE LA TAREA ────────────────────────────────────────────────────
// Hasta ahora el destino de un costo lo decidía QUÉ se hizo: el rubro contable sale de
// pa_tareas_tipos. Esta regla agrega DÓNDE, y el dónde manda: en un lote que no produce
// no hay costo de producción posible, porque no hay producción. Da igual que la tarea
// diga «MO PRODUCCIÓN DAMASCO».
//
// ── Y SE CONGELA ───────────────────────────────────────────────────────────────────
// El destino se escribe en el costo (`pa_costos_lote.a_inversion`), no se deduce al
// leer. El día que el lote entre en producción, lo que se activó el año pasado tiene
// que SEGUIR activado: un informe que cambia de un año para otro porque una plantación
// creció no es un informe, y esa diferencia ya está en un balance firmado.
// ══════════════════════════════════════════════════════════════════════════════════════

/* La campaña se guarda en pa_cultivos_lote como TEXTO —el nombre, '2026/27'—, pero un
   costo la trae como id. Esta función acepta las dos y devuelve el nombre, así quien
   llama no tiene que saber con qué se quedó en la mano. */
export function nombreCampania(db, campania) {
  if (campania == null || campania === '') return '';
  const s = String(campania);
  // '2026/27' no es un id. Tampoco 'Inv 2026'.
  if (!/^\d+$/.test(s.trim())) return s;
  try {
    const c = db.prepare('SELECT nombre FROM pa_campañas WHERE id = ?').get(Number(s));
    return c ? c.nombre : '';
  } catch (e) { return ''; }
}

/* El corazón de la regla, en un solo lugar: lo usan esProductivo, productivosDe,
   lotesDeTemporada y el trigger de db_pa.js, que la escribe en SQL. Si cambia, cambia
   en los dos.

   LA REGLA: `en_desarrollo = 1` Y `productividad_pct = 0`. Un % mayor a 0 ya produce
   —parcialmente, pero produce— y su gasto es costo de producción, como hasta hoy. Es el
   criterio contable: una plantación se activa hasta que ENTRA en producción comercial,
   no hasta que llega al 100%.

   Y `productividad_pct` VACÍO no activa nada. Vacío es «no sé», y no saber no puede
   cambiar a dónde imputa un gasto. Hay filas con en_desarrollo=1 cargadas antes de que
   esta regla existiera: si el vacío activara, toda esa historia se mudaría de golpe a
   inversión sin que nadie lo haya decidido — y eso no se nota hasta que el contador
   mira el balance. */
export function noProduce(fila) {
  if (!fila) return false;
  if (Number(fila.en_desarrollo) !== 1) return false;
  if (fila.productividad_pct == null || fila.productividad_pct === '') return false;
  return Number(fila.productividad_pct) === 0;
}

/* ¿Este lote produce en esta temporada?

   SIN DATO ES QUE SÍ, y es la decisión más importante del archivo: lo peor que puede
   pasar es que un lote en desarrollo siga imputando a producción como hasta hoy, hasta
   que alguien lo marque. Es el comportamiento actual, que es lo que un default tiene
   que ser. Al revés, un default en «no produce» mandaría toda la temporada a inversión
   el día que esto se instala. */
export function esProductivo(db, loteId, campania) {
  const id = parseInt(loteId, 10);
  if (!Number.isFinite(id)) return true;
  const c = String(nombreCampania(db, campania) || '').trim();
  if (!c) return true;
  let f = null;
  try {
    f = db.prepare(
      ' SELECT en_desarrollo, productividad_pct FROM pa_cultivos_lote'
      + '  WHERE lote_id = ? AND campaña = ?').get(id, c);
  } catch (e) {
    /* Las columnas pueden no existir todavía en una base vieja. Que falte el dato no
       puede cambiar a dónde imputa un gasto: se comporta como hasta hoy. */
    return true;
  }
  return !noProduce(f);
}

// Lo mismo para muchos lotes de una, que es como lo necesita una orden: una consulta y
// no una por lote. Devuelve un Map lote_id → boolean.
export function productivosDe(db, loteIds, campania) {
  const m = new Map();
  const ids = [...new Set((loteIds || [])
    .map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x)))];
  if (!ids.length) return m;
  for (const id of ids) m.set(id, true);          // el default, antes de leer
  const c = String(nombreCampania(db, campania) || '').trim();
  if (!c) return m;
  try {
    for (const f of db.prepare(
      ' SELECT lote_id, en_desarrollo, productividad_pct FROM pa_cultivos_lote'
      + '  WHERE campaña = ? AND lote_id IN (' + ids.map(() => '?').join(',') + ')')
      .all(c, ...ids)) {
      if (noProduce(f)) m.set(f.lote_id, false);
    }
  } catch (e) { /* sin las columnas, todos quedan en el default */ }
  return m;
}

/* ── A DÓNDE VA EL GASTO ────────────────────────────────────────────────────────────
   La única función que decide, para que la pantalla y el informe digan lo mismo que
   escribió el trigger. Devuelve `a_inversion` (0/1) y POR QUÉ, para poder explicarlo:
   un número que cambió de columna sin motivo visible es un número que nadie firma. */
export function destinoDelGasto(db, loteId, campania) {
  const prod = esProductivo(db, loteId, campania);
  return {
    a_inversion: prod ? 0 : 1,
    motivo: prod ? null
      : 'El lote no produce en ' + (campania || 'esta temporada')
        + ': el gasto se activa como INVERSIÓN.',
  };
}

/* El rubro al que imputa. INVERSION ya existe en pa_rubros_contables —se siembra con el
   catálogo— así que no se crea nada: se usa el que está.

   Se busca por NOMBRE y no por un id fijo porque los ids de un catálogo sembrado cambian
   entre bases, y un id escrito a mano acá apuntaría a otro rubro en la próxima
   instalación. */
export function rubroInversion(db) {
  try {
    const r = db.prepare(
      'SELECT id, nombre FROM pa_rubros_contables WHERE nombre = ?').get('INVERSION');
    return r || null;
  } catch (e) { return null; }
}

/* ── MARCAR UN LOTE ─────────────────────────────────────────────────────────────────
   Escribe en la fila de (lote, campaña) que ya existe. Si no existe no se inventa un
   cultivo: la fila la crea quien carga QUÉ se plantó, y adivinarlo acá dejaría un lote
   con cultivo vacío que después nadie entiende.

   `produce === false` es «todavía no produce» y escribe el 0 explícito. `true` apaga
   en_desarrollo entero, que es lo que significa un lote maduro. */
export function marcarNoProduce(db, loteId, campania, produce, pct) {
  const id = parseInt(loteId, 10);
  if (!Number.isFinite(id)) return { ok: false, motivo: 'Lote inválido' };
  const c = String(nombreCampania(db, campania) || '').trim();
  if (!c) return { ok: false, motivo: 'Falta la temporada' };

  let ed = 0; let pp = null;
  if (produce === false) {                       // todavía no produce
    ed = 1; pp = 0;
  } else if (pct != null && pct !== '') {        // produce, parcialmente
    const n = Math.max(1, Math.min(100, parseInt(pct, 10) || 1));
    /* El piso es 1 y no 0 a propósito: un 0 con produce=true es una contradicción, y
       guardarlo tal cual lo mandaría a inversión justo cuando se dijo que produce. */
    ed = 1; pp = n;
  }
  const r = db.prepare(
    ' UPDATE pa_cultivos_lote SET en_desarrollo = ?, productividad_pct = ?'
    + '  WHERE lote_id = ? AND campaña = ?').run(ed, pp, id, c);
  if (!r.changes) {
    return { ok: false,
      motivo: 'Ese lote no tiene cultivo cargado en ' + c
        + '. Cargalo primero y después marcalo.' };
  }
  return { ok: true, lote_id: id, campaña: c, en_desarrollo: ed, productividad_pct: pp,
    a_inversion: ed === 1 && pp === 0 ? 1 : 0 };
}

/* Los lotes de una temporada con su marca, para la pantalla. Un LEFT JOIN desde los
   LOTES y no desde los cultivos: un lote sin cultivo cargado en esa campaña tiene que
   APARECER —con su casillero vacío— porque si no, el que revisa no lo ve y cree que está
   todo marcado. */
export function lotesDeTemporada(db, campania) {
  const c = String(nombreCampania(db, campania) || '').trim();
  try {
    return db.prepare(
      ' SELECT l.id, l.nombre, l.hectareas, l.finca, l.año_plantacion,'
      + '       cl.cultivo, cl.en_desarrollo, cl.productividad_pct,'
      + '       CASE WHEN cl.id IS NULL THEN 1 ELSE 0 END AS sin_cultivo'
      + '  FROM pa_lotes l'
      + '  LEFT JOIN pa_cultivos_lote cl ON cl.lote_id = l.id AND cl.campaña = ?'
      + '  WHERE COALESCE(l.activo, 1) = 1'
      + '  ORDER BY l.finca, l.nombre').all(c)
      .map((f) => Object.assign(f, {
        // El destino, resuelto acá y no en la pantalla: que no haya dos versiones de la
        // regla, una en el JS del navegador y otra en SQL.
        a_inversion: noProduce(f) ? 1 : 0,
      }));
  } catch (e) { return []; }
}

/* Cuánto se activó y cuánto se gastó, por temporada. Es el número que justifica todo
   esto: sin él, marcar un lote no se ve en ninguna parte. */
export function resumenInversion(db, campaniaId) {
  const id = parseInt(campaniaId, 10);
  try {
    return db.prepare(
      ' SELECT COALESCE(SUM(CASE WHEN a_inversion = 1 THEN monto ELSE 0 END), 0) AS inversion,'
      + '       COALESCE(SUM(CASE WHEN a_inversion = 0 THEN monto ELSE 0 END), 0) AS produccion,'
      + '       COUNT(*) AS costos'
      + '  FROM pa_costos_lote'
      + '  WHERE COALESCE(campaña_anual_id, campaña_id) = ?')
      .get(Number.isFinite(id) ? id : -1) || { inversion: 0, produccion: 0, costos: 0 };
  } catch (e) { return { inversion: 0, produccion: 0, costos: 0 }; }
}

/* Los costos activados de una temporada, con su lote. Para poder MIRAR qué se activó:
   un total sin detalle no se puede revisar, y el que firma el balance va a preguntar
   cuáles son. */
export function costosDeInversion(db, campaniaId) {
  const id = parseInt(campaniaId, 10);
  try {
    return db.prepare(
      ' SELECT c.id, c.lote_id, l.nombre AS lote, l.finca, c.categoria, c.fecha,'
      + '       c.monto, c.descripcion'
      + '  FROM pa_costos_lote c'
      + '  LEFT JOIN pa_lotes l ON l.id = c.lote_id'
      + '  WHERE c.a_inversion = 1'
      + '    AND COALESCE(c.campaña_anual_id, c.campaña_id) = ?'
      + '  ORDER BY l.nombre, c.fecha').all(Number.isFinite(id) ? id : -1);
  } catch (e) { return []; }
}
