// src/rutas/ordenes_trabajo.js
// ── API ÓRDENES DE TRABAJO — /api/pa/ordenes-trabajo ───────────────────────
// Orden de servicio de terceros sobre lotes: un proveedor externo hace una
// tarea (ARMAR CAMAS, PODA, ...) en uno o más lotes por un monto total que se
// prorratea entre los lotes en proporción a las hectáreas trabajadas.
//
// Solo LEE proveedores (adm_proveedores) y plan de cuentas (pa_cuentas).
// NO modifica cuentas.js ni el módulo contable.

import express from 'express';
import db from '../servicios/db.js';
import '../servicios/db_ot.js';   // crea tablas + siembra el catálogo de tareas
// Validaciones puras (sin dependencia de db.js) — testeadas en test/ordenes_trabajo.test.js
import { prorratear, normalizarLotes, validarCabecera } from '../servicios/ot_validaciones.js';

export { prorratear };

const router = express.Router();

// ── Auth (mismo patrón que produccion.js: cookie lnb_user) ─────────────────
function requireAuth(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    req.user = JSON.parse(cookie);
    next();
  } catch (e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

function requireAdmin(req, res, next) {
  if (req.user?.rol !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
  next();
}

// ── Sociedad (obligatoria y transversal) ───────────────────────────────────
// Mismo contrato que bancos.js: si el request no manda sociedad_id (selector en
// "Todas"), las LECTURAS caen a Puente Cordón. Las escrituras del panel ya vienen
// bloqueadas por el interceptor de sociedad del frontend.
function sociedadPCId() {
  const r = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE ?").get('Puente Cord%')
         || db.prepare("SELECT id FROM sociedades WHERE funcion = 'productiva' ORDER BY id LIMIT 1").get();
  return r ? r.id : null;
}
function getSociedadId(req) {
  const raw = req.body?.sociedad_id ?? req.query?.sociedad_id;
  const id = parseInt(raw, 10);
  if (Number.isInteger(id) && id > 0) {
    const ok = db.prepare('SELECT id FROM sociedades WHERE id = ?').get(id);
    if (ok) return id;
  }
  return sociedadPCId();
}

// Lee el detalle de lotes de una orden, enriquecido para la UI.
const SQL_LOTES = `
  SELECT otl.id, otl.lote_id, otl.hectareas, otl.monto_asignado,
         l.nombre AS lote_nombre, l.finca, l.hectareas AS lote_hectareas,
         s.nombre AS sector_nombre
    FROM pa_ordenes_trabajo_lotes otl
    JOIN pa_lotes l    ON l.id = otl.lote_id
    LEFT JOIN pa_sectores s ON s.id = l.sector_id
   WHERE otl.orden_id = ?
   ORDER BY l.finca, l.nombre
`;

// ═══════════════════════════════════════════════════════════════════════════
// CATÁLOGO DE TAREAS
// IMPORTANTE: /tareas va ANTES de /:id para que el param no lo capture.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/tareas', requireAuth, (req, res) => {
  try {
    const sociedadId = getSociedadId(req);
    const incluirInactivas = req.query.incluir_inactivas === '1';
    let sql = `SELECT * FROM pa_tareas WHERE (sociedad_id = ? OR sociedad_id IS NULL)`;
    if (!incluirInactivas) sql += ' AND activo = 1';
    sql += ' ORDER BY nombre';
    res.json({ ok: true, data: db.prepare(sql).all(sociedadId) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/tareas', requireAuth, requireAdmin, (req, res) => {
  try {
    const nombre = (req.body?.nombre || '').trim().toUpperCase();
    if (!nombre) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
    const sociedadId = getSociedadId(req);

    // Si ya existe pero está dada de baja, la reactivamos en lugar de duplicar.
    const previa = db.prepare(
      'SELECT id, activo FROM pa_tareas WHERE nombre = ? AND (sociedad_id = ? OR sociedad_id IS NULL)'
    ).get(nombre, sociedadId);
    if (previa) {
      if (previa.activo) return res.status(409).json({ ok: false, error: 'Esa tarea ya existe' });
      db.prepare('UPDATE pa_tareas SET activo = 1 WHERE id = ?').run(previa.id);
      return res.json({ ok: true, id: previa.id, reactivada: true });
    }

    const r = db.prepare('INSERT INTO pa_tareas (nombre, sociedad_id) VALUES (?, ?)').run(nombre, sociedadId);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Baja lógica de una tarea (el ABM del modal chico).
router.delete('/tareas/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const r = db.prepare('UPDATE pa_tareas SET activo = 0 WHERE id = ?').run(parseInt(req.params.id, 10));
    if (!r.changes) return res.status(404).json({ ok: false, error: 'Tarea no encontrada' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ÓRDENES DE TRABAJO
// ═══════════════════════════════════════════════════════════════════════════

// GET / — listado con filtros
router.get('/', requireAuth, (req, res) => {
  try {
    const sociedadId = getSociedadId(req);
    const { campania, temporada, proveedor_id, tarea_id, estado, desde, hasta } = req.query;

    const conds = ['ot.activo = 1', 'ot.sociedad_id = ?'];
    const params = [sociedadId];
    if (campania)     { conds.push('ot.campania = ?');     params.push(Number(campania)); }
    if (temporada)    { conds.push('ot.temporada = ?');    params.push(Number(temporada)); }
    if (proveedor_id) { conds.push('ot.proveedor_id = ?'); params.push(Number(proveedor_id)); }
    if (tarea_id)     { conds.push('ot.tarea_id = ?');     params.push(Number(tarea_id)); }
    if (estado)       { conds.push('ot.estado = ?');       params.push(estado); }
    if (desde)        { conds.push('ot.fecha >= ?');       params.push(String(desde).slice(0, 10)); }
    if (hasta)        { conds.push('ot.fecha <= ?');       params.push(String(hasta).slice(0, 10)); }

    const filas = db.prepare(`
      SELECT ot.*,
             p.razon_social  AS proveedor_nombre,
             t.nombre        AS tarea_nombre,
             c.codigo        AS cuenta_codigo,
             c.nombre        AS cuenta_nombre,
             can.nombre      AS campania_nombre,
             ces.nombre      AS temporada_nombre,
             u.nombre        AS usuario_nombre,
             (SELECT COUNT(*) FROM pa_ordenes_trabajo_lotes WHERE orden_id = ot.id) AS lotes_count,
             (SELECT COALESCE(SUM(hectareas),0) FROM pa_ordenes_trabajo_lotes WHERE orden_id = ot.id) AS hectareas_total
        FROM pa_ordenes_trabajo ot
        JOIN adm_proveedores p   ON p.id = ot.proveedor_id
        LEFT JOIN pa_tareas t    ON t.id = ot.tarea_id
        LEFT JOIN pa_cuentas c   ON c.id = ot.cuenta_gasto_id
        LEFT JOIN pa_campañas can ON can.id = ot.campania
        LEFT JOIN pa_campañas ces ON ces.id = ot.temporada
        LEFT JOIN usuarios u     ON u.id = ot.usuario_id
       WHERE ${conds.join(' AND ')}
       ORDER BY ot.fecha DESC, ot.numero DESC
    `).all(...params);

    const getLotes = db.prepare(SQL_LOTES);
    const data = filas.map(o => ({
      ...o,
      tarea_label: o.tarea_nombre || o.tarea_otra || '—',
      lotes: getLotes.all(o.id),
    }));
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /:id — cabecera + lotes
router.get('/:id', requireAuth, (req, res) => {
  try {
    const orden = db.prepare(`
      SELECT ot.*,
             p.razon_social AS proveedor_nombre, p.cuit AS proveedor_cuit,
             t.nombre       AS tarea_nombre,
             c.codigo       AS cuenta_codigo, c.nombre AS cuenta_nombre,
             can.nombre     AS campania_nombre,
             ces.nombre     AS temporada_nombre,
             u.nombre       AS usuario_nombre
        FROM pa_ordenes_trabajo ot
        JOIN adm_proveedores p   ON p.id = ot.proveedor_id
        LEFT JOIN pa_tareas t    ON t.id = ot.tarea_id
        LEFT JOIN pa_cuentas c   ON c.id = ot.cuenta_gasto_id
        LEFT JOIN pa_campañas can ON can.id = ot.campania
        LEFT JOIN pa_campañas ces ON ces.id = ot.temporada
        LEFT JOIN usuarios u     ON u.id = ot.usuario_id
       WHERE ot.id = ? AND ot.activo = 1
    `).get(parseInt(req.params.id, 10));
    if (!orden) return res.status(404).json({ ok: false, error: 'Orden de trabajo no encontrada' });

    orden.tarea_label = orden.tarea_nombre || orden.tarea_otra || '—';
    orden.lotes = db.prepare(SQL_LOTES).all(orden.id);
    res.json({ ok: true, data: orden });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST / — alta (cabecera + detalle + prorrateo)
router.post('/', requireAuth, (req, res) => {
  try {
    const sociedadId = getSociedadId(req);
    if (!sociedadId) return res.status(400).json({ ok: false, error: 'No se pudo determinar la sociedad' });

    const cab = validarCabecera(db, req.body || {}, sociedadId);
    if (cab.error) return res.status(400).json({ ok: false, error: cab.error });

    const det = normalizarLotes(db, req.body?.lotes);
    if (det.error) return res.status(400).json({ ok: false, error: det.error });

    const repartidos = prorratear(det.lotes, cab.datos.monto_total);

    const crear = db.transaction(() => {
      const numero = db.prepare(
        'SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM pa_ordenes_trabajo WHERE sociedad_id = ?'
      ).get(sociedadId).n;

      const r = db.prepare(`
        INSERT INTO pa_ordenes_trabajo
          (numero, fecha, campania, temporada, proveedor_id, tarea_id, tarea_otra,
           cuenta_gasto_id, monto_total, observaciones, estado, sociedad_id, usuario_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(numero, cab.datos.fecha, cab.datos.campania, cab.datos.temporada,
             cab.datos.proveedor_id, cab.datos.tarea_id, cab.datos.tarea_otra,
             cab.datos.cuenta_gasto_id, cab.datos.monto_total, cab.datos.observaciones,
             cab.datos.estado, sociedadId, req.user?.id || null);

      const ordenId = r.lastInsertRowid;
      const insLote = db.prepare(
        'INSERT INTO pa_ordenes_trabajo_lotes (orden_id, lote_id, hectareas, monto_asignado) VALUES (?,?,?,?)'
      );
      for (const l of repartidos) insLote.run(ordenId, l.lote_id, l.hectareas, l.monto_asignado);
      return { id: ordenId, numero };
    });

    const out = crear();
    res.json({ ok: true, ...out, nro: `OT-${String(out.numero).padStart(5, '0')}` });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PUT /:id — edición (reemplaza el detalle y recalcula el prorrateo)
router.put('/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const actual = db.prepare('SELECT * FROM pa_ordenes_trabajo WHERE id = ? AND activo = 1').get(id);
    if (!actual) return res.status(404).json({ ok: false, error: 'Orden de trabajo no encontrada' });

    // La sociedad de una OT no se cambia por edición: es su contexto de origen.
    const cab = validarCabecera(db, req.body || {}, actual.sociedad_id);
    if (cab.error) return res.status(400).json({ ok: false, error: cab.error });

    const det = normalizarLotes(db, req.body?.lotes);
    if (det.error) return res.status(400).json({ ok: false, error: det.error });

    const repartidos = prorratear(det.lotes, cab.datos.monto_total);

    db.transaction(() => {
      db.prepare(`
        UPDATE pa_ordenes_trabajo
           SET fecha = ?, campania = ?, temporada = ?, proveedor_id = ?, tarea_id = ?,
               tarea_otra = ?, cuenta_gasto_id = ?, monto_total = ?, observaciones = ?, estado = ?
         WHERE id = ?
      `).run(cab.datos.fecha, cab.datos.campania, cab.datos.temporada, cab.datos.proveedor_id,
             cab.datos.tarea_id, cab.datos.tarea_otra, cab.datos.cuenta_gasto_id,
             cab.datos.monto_total, cab.datos.observaciones, cab.datos.estado, id);

      db.prepare('DELETE FROM pa_ordenes_trabajo_lotes WHERE orden_id = ?').run(id);
      const insLote = db.prepare(
        'INSERT INTO pa_ordenes_trabajo_lotes (orden_id, lote_id, hectareas, monto_asignado) VALUES (?,?,?,?)'
      );
      for (const l of repartidos) insLote.run(id, l.lote_id, l.hectareas, l.monto_asignado);
    })();

    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /:id — soft delete. Hard delete (?hard=1) SOLO para rol admin.
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const orden = db.prepare('SELECT id, numero FROM pa_ordenes_trabajo WHERE id = ?').get(id);
    if (!orden) return res.status(404).json({ ok: false, error: 'Orden de trabajo no encontrada' });

    const quiereHard = req.query.hard === '1' || req.query.hard === 'true';
    if (quiereHard) {
      if (req.user?.rol !== 'admin') {
        return res.status(403).json({ ok: false, error: 'El borrado definitivo es solo para administradores' });
      }
      db.transaction(() => {
        db.prepare('DELETE FROM pa_ordenes_trabajo_lotes WHERE orden_id = ?').run(id);
        db.prepare('DELETE FROM pa_ordenes_trabajo WHERE id = ?').run(id);
      })();
      return res.json({ ok: true, hard: true });
    }

    db.prepare('UPDATE pa_ordenes_trabajo SET activo = 0 WHERE id = ?').run(id);
    res.json({ ok: true, hard: false });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
