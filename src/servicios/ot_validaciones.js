// src/servicios/ot_validaciones.js
// ── Validaciones puras de Órdenes de Trabajo ────────────────────────────────
// Extraído de rutas/ordenes_trabajo.js para poder testearlo: este módulo NO
// importa servicios/db.js — recibe el handle de DB por parámetro. Así la suite
// (test/ordenes_trabajo.test.js) lo ejercita con una base node:sqlite en memoria
// sin arrastrar better-sqlite3, que no compila en Windows.
//
// El `db` que se inyecta solo necesita .prepare(sql).get(...) — contrato común
// entre better-sqlite3 (producción) y node:sqlite (tests).

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Reparte `montoTotal` entre `lotes` proporcionalmente a las hectáreas.
// Si la suma de hectáreas es 0, reparte en partes iguales. Redondea a 2
// decimales y ajusta la diferencia en el último lote para que la suma de los
// montos asignados cierre EXACTA con monto_total.
export function prorratear(lotes, montoTotal) {
  const n = lotes.length;
  if (!n) return [];
  const total = round2(montoTotal);
  const sumHa = lotes.reduce((s, l) => s + (Number(l.hectareas) || 0), 0);
  let acumulado = 0;
  return lotes.map((l, i) => {
    let monto;
    if (i === n - 1) {
      monto = round2(total - acumulado);          // el último absorbe el redondeo
    } else {
      const peso = sumHa > 0 ? (Number(l.hectareas) || 0) / sumHa : 1 / n;
      monto = round2(total * peso);
      acumulado = round2(acumulado + monto);
    }
    return { ...l, monto_asignado: monto };
  });
}

// Normaliza y valida el detalle de lotes del body.
// Devuelve { error } o { lotes: [{lote_id, hectareas}] }.
//
// NOTA (multisociedad): no se valida que el lote pertenezca a la sociedad de la
// orden porque pa_lotes NO tiene columna sociedad_id (ver db_pa.js, CREATE TABLE
// pa_lotes) — ni la hereda de pa_sectores, que tampoco la tiene. Cuando exista,
// el chequeo va acá, con la misma forma que el de cuenta_gasto_id.
export function normalizarLotes(db, rawLotes) {
  if (!Array.isArray(rawLotes) || !rawLotes.length) {
    return { error: 'Seleccioná al menos un lote' };
  }
  const vistos = new Set();
  const lotes = [];
  for (const raw of rawLotes) {
    const loteId = Number(raw?.lote_id ?? raw);
    if (!Number.isInteger(loteId) || loteId <= 0) return { error: 'lote_id inválido' };
    if (vistos.has(loteId)) return { error: 'Hay un lote repetido en el detalle' };
    vistos.add(loteId);

    const lote = db.prepare('SELECT id, nombre, hectareas FROM pa_lotes WHERE id = ?').get(loteId);
    if (!lote) return { error: `El lote ${loteId} no existe` };

    // ha vacío/null ⇒ lote completo
    const rawHa = (raw && typeof raw === 'object') ? raw.hectareas : null;
    const ha = (rawHa === null || rawHa === undefined || rawHa === '')
      ? Number(lote.hectareas) || 0
      : Number(rawHa);
    if (!Number.isFinite(ha) || ha < 0) {
      return { error: `Hectáreas inválidas en el lote ${lote.nombre}` };
    }
    if (ha > (Number(lote.hectareas) || 0) + 1e-6) {
      return { error: `Lote ${lote.nombre}: ${ha} ha supera las ${lote.hectareas} ha del lote` };
    }
    lotes.push({ lote_id: loteId, hectareas: round2(ha) });
  }
  return { lotes };
}

// Valida la cabecera contra la sociedad de la orden. Devuelve { error } o { datos }.
export function validarCabecera(db, body, sociedadId) {
  const fecha = (body.fecha || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { error: 'Fecha requerida' };

  const proveedorId = Number(body.proveedor_id);
  if (!Number.isInteger(proveedorId) || proveedorId <= 0) return { error: 'Proveedor requerido' };
  // NOTA (multisociedad): adm_proveedores tampoco tiene sociedad_id, así que el
  // padrón de proveedores es global. Solo se verifica existencia.
  const prov = db.prepare('SELECT id FROM adm_proveedores WHERE id = ?').get(proveedorId);
  if (!prov) return { error: 'El proveedor no existe en el padrón' };

  const campania = body.campania ? Number(body.campania) : null;
  if (!campania) return { error: 'Campaña requerida' };
  const temporada = body.temporada ? Number(body.temporada) : null;

  // Tarea: del catálogo (tarea_id) o "Otra" (tarea_id null + tarea_otra libre).
  // "Otra" es una opción del <select> en el front, NO una fila de pa_tareas: el
  // centinela '__otra__' se traduce ahí y nunca llega acá. El Number() explícito
  // evita que un tarea_id no numérico posteado a mano se cuele como NaN.
  const tareaOtra = (body.tarea_otra || '').trim();
  let tareaId = null;
  if (body.tarea_id !== null && body.tarea_id !== undefined && body.tarea_id !== '') {
    tareaId = Number(body.tarea_id);
    if (!Number.isInteger(tareaId) || tareaId <= 0) return { error: 'tarea_id inválido' };
    const t = db.prepare('SELECT id FROM pa_tareas WHERE id = ?').get(tareaId);
    if (!t) return { error: 'La tarea no existe en el catálogo' };
  } else if (!tareaOtra) {
    // Sin tarea del catálogo: es "Otra" y el texto es obligatorio.
    return { error: 'Elegí una tarea del catálogo o escribí cuál es la tarea' };
  }

  const cuentaGastoId = Number(body.cuenta_gasto_id);
  if (!Number.isInteger(cuentaGastoId) || cuentaGastoId <= 0) return { error: 'Cuenta de gasto requerida' };
  const cta = db.prepare('SELECT id, codigo, nombre, sociedad_id FROM pa_cuentas WHERE id = ?').get(cuentaGastoId);
  if (!cta) return { error: 'La cuenta de gasto no existe' };
  // El plan de cuentas es por sociedad (UNIQUE(sociedad_id, codigo)): una OT no
  // puede imputar a una cuenta de otra sociedad.
  if (Number(cta.sociedad_id) !== Number(sociedadId)) {
    const soc = db.prepare('SELECT nombre FROM sociedades WHERE id = ?').get(cta.sociedad_id);
    return {
      error: `La cuenta ${cta.codigo} — ${cta.nombre} pertenece a ${soc?.nombre || 'otra sociedad'}`
           + ' y la orden es de otra sociedad. Elegí una cuenta del plan de la sociedad de la orden.',
    };
  }

  const montoTotal = Number(body.monto_total);
  if (!Number.isFinite(montoTotal) || montoTotal < 0) return { error: 'El monto total no puede ser negativo' };

  const estado = body.estado === 'ejecutada' ? 'ejecutada' : 'pendiente';

  return {
    datos: {
      fecha,
      campania,
      temporada,
      proveedor_id: proveedorId,
      tarea_id: tareaId,
      tarea_otra: tareaId ? null : tareaOtra,
      cuenta_gasto_id: cuentaGastoId,
      monto_total: round2(montoTotal),
      observaciones: (body.observaciones || '').trim() || null,
      estado,
      sociedad_id: sociedadId,
    },
  };
}
