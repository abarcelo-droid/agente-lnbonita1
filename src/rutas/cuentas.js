// src/rutas/cuentas.js
// ── PLAN DE CUENTAS — endpoints CRUD + log de auditoría ─────────────────
// Maestro contable: secciones, cuentas, soft-delete, reordenar, log.
// Auth: req.cookies.lnb_user (parseado a mano, mismo patrón que el resto).

import express from 'express';
import db from '../servicios/db.js';

const router = express.Router();

// ── helpers ────────────────────────────────────────────────────────────────
function getUser(req) {
  try {
    const c = req.cookies?.lnb_user;
    return c ? JSON.parse(c) : null;
  } catch (e) {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const u = getUser(req);
  if (!u || u.rol !== 'admin') {
    return res.status(403).json({ error: 'solo admin' });
  }
  req._user = u;
  next();
}

function logAccion({ cuenta_id = null, seccion_id = null, accion, detalle = null, usuario_id = null }) {
  db.prepare(`
    INSERT INTO pa_cuentas_log (cuenta_id, seccion_id, accion, detalle, usuario_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    cuenta_id,
    seccion_id,
    accion,
    detalle ? JSON.stringify(detalle) : null,
    usuario_id
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SECCIONES — listar / crear / editar / desactivar / reactivar
// (van ANTES de las rutas de /:id para que no matcheen mal)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/secciones', (req, res) => {
  const incluirInactivas = req.query.incluir_inactivas === '1';
  let sql = 'SELECT * FROM pa_cuentas_secciones';
  if (!incluirInactivas) sql += ' WHERE activo = 1';
  sql += ' ORDER BY codigo';
  res.json({ ok: true, data: db.prepare(sql).all() });
});

router.post('/secciones', requireAdmin, (req, res) => {
  const { codigo, nombre } = req.body || {};
  if (!codigo || !nombre) return res.status(400).json({ error: 'codigo y nombre son requeridos' });
  const codigoNum = parseInt(codigo, 10);
  if (!Number.isFinite(codigoNum) || codigoNum < 1) {
    return res.status(400).json({ error: 'codigo debe ser un entero >= 1' });
  }
  const existe = db.prepare('SELECT id FROM pa_cuentas_secciones WHERE codigo = ?').get(codigoNum);
  if (existe) return res.status(400).json({ error: 'ya existe una sección con ese código' });
  try {
    const r = db.prepare(`
      INSERT INTO pa_cuentas_secciones (codigo, nombre, orden, activo)
      VALUES (?, ?, ?, 1)
    `).run(codigoNum, String(nombre).trim(), codigoNum);
    logAccion({ seccion_id: r.lastInsertRowid, accion: 'crear', detalle: { codigo: codigoNum, nombre }, usuario_id: req._user?.id });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/secciones/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sec = db.prepare('SELECT * FROM pa_cuentas_secciones WHERE id = ?').get(id);
  if (!sec) return res.status(404).json({ error: 'sección no encontrada' });

  const { nombre, codigo } = req.body || {};
  if (codigo !== undefined && parseInt(codigo, 10) !== sec.codigo) {
    const codigoNum = parseInt(codigo, 10);
    const otra = db.prepare('SELECT id FROM pa_cuentas_secciones WHERE codigo = ? AND id != ?').get(codigoNum, id);
    if (otra) return res.status(400).json({ error: 'ya existe otra sección con ese código' });
    db.prepare("UPDATE pa_cuentas_secciones SET codigo = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(codigoNum, id);
  }
  if (nombre && String(nombre).trim() !== sec.nombre) {
    db.prepare("UPDATE pa_cuentas_secciones SET nombre = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(String(nombre).trim(), id);
  }
  logAccion({ seccion_id: id, accion: 'editar', detalle: { antes: sec, despues: req.body }, usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.delete('/secciones/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const conCuentas = db.prepare('SELECT COUNT(*) AS c FROM pa_cuentas WHERE seccion_id = ? AND activo = 1').get(id);
  if (conCuentas.c > 0) {
    return res.status(400).json({
      error: `la sección tiene ${conCuentas.c} cuenta(s) activa(s); desactivelas o muevalas primero`,
    });
  }
  db.prepare("UPDATE pa_cuentas_secciones SET activo = 0, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  logAccion({ seccion_id: id, accion: 'desactivar', usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.post('/secciones/:id/reactivar', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE pa_cuentas_secciones SET activo = 1, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  logAccion({ seccion_id: id, accion: 'reactivar', usuario_id: req._user?.id });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// LOG GENERAL — esta ruta debe ir ANTES de /:id para que no matchee mal
// ═══════════════════════════════════════════════════════════════════════════

router.get('/log/general', (req, res) => {
  const { desde, hasta, accion, usuario_id } = req.query;
  const params = [];
  let sql = `
    SELECT l.*,
           u.nombre AS usuario_nombre,
           c.codigo AS cuenta_codigo,
           c.nombre AS cuenta_nombre,
           s.nombre AS seccion_nombre
      FROM pa_cuentas_log l
      LEFT JOIN usuarios u            ON u.id = l.usuario_id
      LEFT JOIN pa_cuentas c          ON c.id = l.cuenta_id
      LEFT JOIN pa_cuentas_secciones s ON s.id = l.seccion_id
     WHERE 1 = 1
  `;
  if (desde)        { sql += ' AND l.creado_en >= ?'; params.push(desde); }
  if (hasta)        { sql += ' AND l.creado_en <= ?'; params.push(hasta); }
  if (accion)       { sql += ' AND l.accion = ?';     params.push(accion); }
  if (usuario_id)   { sql += ' AND l.usuario_id = ?'; params.push(parseInt(usuario_id, 10)); }
  sql += ' ORDER BY l.creado_en DESC LIMIT 500';
  res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

// ═══════════════════════════════════════════════════════════════════════════
// CUENTAS — listar / crear / editar / desactivar / reactivar / mover
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/pa/cuentas?seccion_id=&incluir_inactivas=1&q=
router.get('/', (req, res) => {
  const { seccion_id, q } = req.query;
  const incluirInactivas = req.query.incluir_inactivas === '1';
  const params = [];
  let sql = `
    SELECT c.*,
           s.nombre AS seccion_nombre,
           s.codigo AS seccion_codigo
      FROM pa_cuentas c
      JOIN pa_cuentas_secciones s ON s.id = c.seccion_id
     WHERE 1 = 1
  `;
  if (!incluirInactivas) sql += ' AND c.activo = 1';
  if (seccion_id) { sql += ' AND c.seccion_id = ?'; params.push(parseInt(seccion_id, 10)); }
  if (q) {
    sql += ' AND (c.codigo LIKE ? OR c.nombre LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY c.codigo';
  res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

// GET /api/pa/cuentas/:id  (debe ir DESPUÉS de /secciones y /log)
router.get('/:id(\\d+)', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare(`
    SELECT c.*, s.nombre AS seccion_nombre, s.codigo AS seccion_codigo
      FROM pa_cuentas c
      JOIN pa_cuentas_secciones s ON s.id = c.seccion_id
     WHERE c.id = ?
  `).get(id);
  if (!c) return res.status(404).json({ error: 'cuenta no encontrada' });
  res.json({ ok: true, data: c });
});

// POST /api/pa/cuentas
router.post('/', requireAdmin, (req, res) => {
  const {
    codigo,
    nombre,
    seccion_id,
    tipo = 'resultado',
    permite_lote = 0,
    permite_campania = 0,
  } = req.body || {};

  if (!codigo || !nombre || !seccion_id) {
    return res.status(400).json({ error: 'codigo, nombre y seccion_id son requeridos' });
  }
  if (!/^\d+\.\d+$/.test(codigo)) {
    return res.status(400).json({ error: 'codigo debe tener formato S.NN (ej: 1.05)' });
  }
  if (!['resultado', 'patrimonial'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo inválido' });
  }
  const sec = db.prepare('SELECT id FROM pa_cuentas_secciones WHERE id = ?').get(seccion_id);
  if (!sec) return res.status(400).json({ error: 'seccion_id inválido' });

  const existe = db.prepare('SELECT id FROM pa_cuentas WHERE codigo = ?').get(codigo);
  if (existe) return res.status(400).json({ error: 'ya existe una cuenta con ese código' });

  try {
    const ordenMax = db.prepare('SELECT COALESCE(MAX(orden), 0) AS m FROM pa_cuentas WHERE seccion_id = ?').get(seccion_id).m;
    const r = db.prepare(`
      INSERT INTO pa_cuentas
        (codigo, nombre, seccion_id, tipo, permite_lote, permite_campania, es_sistema, orden, activo)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1)
    `).run(
      codigo,
      String(nombre).trim(),
      seccion_id,
      tipo,
      permite_lote ? 1 : 0,
      permite_campania ? 1 : 0,
      ordenMax + 10
    );
    logAccion({ cuenta_id: r.lastInsertRowid, accion: 'crear', detalle: req.body, usuario_id: req._user?.id });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/pa/cuentas/:id
router.put('/:id(\\d+)', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cuenta = db.prepare('SELECT * FROM pa_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });

  const { codigo, nombre, seccion_id, tipo, permite_lote, permite_campania } = req.body || {};

  if (codigo && codigo !== cuenta.codigo) {
    if (!/^\d+\.\d+$/.test(codigo)) {
      return res.status(400).json({ error: 'codigo debe tener formato S.NN' });
    }
    const otra = db.prepare('SELECT id FROM pa_cuentas WHERE codigo = ? AND id != ?').get(codigo, id);
    if (otra) return res.status(400).json({ error: 'ya existe otra cuenta con ese código' });
  }
  if (tipo && !['resultado', 'patrimonial'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo inválido' });
  }
  if (seccion_id) {
    const sec = db.prepare('SELECT id FROM pa_cuentas_secciones WHERE id = ?').get(seccion_id);
    if (!sec) return res.status(400).json({ error: 'seccion_id inválido' });
  }

  try {
    db.prepare(`
      UPDATE pa_cuentas
         SET codigo            = COALESCE(?, codigo),
             nombre            = COALESCE(?, nombre),
             seccion_id        = COALESCE(?, seccion_id),
             tipo              = COALESCE(?, tipo),
             permite_lote      = COALESCE(?, permite_lote),
             permite_campania  = COALESCE(?, permite_campania),
             actualizado_en    = datetime('now','localtime')
       WHERE id = ?
    `).run(
      codigo ?? null,
      nombre ? String(nombre).trim() : null,
      seccion_id ?? null,
      tipo ?? null,
      permite_lote === undefined ? null : (permite_lote ? 1 : 0),
      permite_campania === undefined ? null : (permite_campania ? 1 : 0),
      id
    );
    logAccion({
      cuenta_id: id,
      accion: 'editar',
      detalle: { antes: cuenta, despues: req.body },
      usuario_id: req._user?.id,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/pa/cuentas/:id (soft delete)
router.delete('/:id(\\d+)', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cuenta = db.prepare('SELECT * FROM pa_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });
  if (cuenta.es_sistema) {
    return res.status(400).json({ error: 'cuenta del sistema, no se puede desactivar' });
  }
  db.prepare("UPDATE pa_cuentas SET activo = 0, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  logAccion({ cuenta_id: id, accion: 'desactivar', usuario_id: req._user?.id });
  res.json({ ok: true });
});

// POST /api/pa/cuentas/:id/reactivar
router.post('/:id(\\d+)/reactivar', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE pa_cuentas SET activo = 1, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  logAccion({ cuenta_id: id, accion: 'reactivar', usuario_id: req._user?.id });
  res.json({ ok: true });
});

// POST /api/pa/cuentas/:id/mover  body: { direccion: 'arriba' | 'abajo' }
// Intercambia código con la cuenta vecina dentro de la misma sección
router.post('/:id(\\d+)/mover', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const direccion = req.body?.direccion;
  if (!['arriba', 'abajo'].includes(direccion)) {
    return res.status(400).json({ error: 'direccion debe ser arriba|abajo' });
  }
  const cuenta = db.prepare('SELECT * FROM pa_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });

  const op = direccion === 'arriba' ? '<' : '>';
  const order = direccion === 'arriba' ? 'DESC' : 'ASC';
  const vecina = db.prepare(`
    SELECT * FROM pa_cuentas
     WHERE seccion_id = ?
       AND codigo ${op} ?
       AND activo = 1
     ORDER BY codigo ${order}
     LIMIT 1
  `).get(cuenta.seccion_id, cuenta.codigo);

  if (!vecina) return res.json({ ok: true, sin_cambio: true });

  const tmp = `__TMP_${Date.now()}_${id}`;
  const tx = db.transaction(() => {
    db.prepare('UPDATE pa_cuentas SET codigo = ? WHERE id = ?').run(tmp, cuenta.id);
    db.prepare('UPDATE pa_cuentas SET codigo = ? WHERE id = ?').run(cuenta.codigo, vecina.id);
    db.prepare('UPDATE pa_cuentas SET codigo = ? WHERE id = ?').run(vecina.codigo, cuenta.id);
  });
  tx();

  logAccion({
    cuenta_id: id,
    accion: 'reordenar',
    detalle: { direccion, vecina_id: vecina.id, swap: [cuenta.codigo, vecina.codigo] },
    usuario_id: req._user?.id,
  });

  res.json({ ok: true });
});

// GET /api/pa/cuentas/:id/log
router.get('/:id(\\d+)/log', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const log = db.prepare(`
    SELECT l.*, u.nombre AS usuario_nombre
      FROM pa_cuentas_log l
      LEFT JOIN usuarios u ON u.id = l.usuario_id
     WHERE l.cuenta_id = ?
     ORDER BY l.creado_en DESC
     LIMIT 200
  `).all(id);
  res.json({ ok: true, data: log });
});
// ═══════════════════════════════════════════════════════════════════════════
// ASIENTOS CONTABLES — partida doble manual
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/pa/cuentas/asientos?desde=&hasta=&anulados=1
router.get('/asientos', (req, res) => {
  const { desde, hasta } = req.query;
  const incluirAnulados = req.query.anulados === '1';
  const params = [];
  let sql = `
    SELECT a.*, u.nombre AS usuario_nombre
      FROM pa_asientos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE 1 = 1
  `;
  if (!incluirAnulados) { sql += ' AND a.anulado = 0'; }
  if (desde) { sql += ' AND a.fecha >= ?'; params.push(desde); }
  if (hasta) { sql += ' AND a.fecha <= ?'; params.push(hasta); }
  sql += ' ORDER BY a.fecha DESC, a.id DESC LIMIT 200';
  res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

// GET /api/pa/cuentas/asientos/:id — detalle con líneas
router.get('/asientos/:id(\\d+)', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const asiento = db.prepare(`
    SELECT a.*, u.nombre AS usuario_nombre
      FROM pa_asientos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.id = ?
  `).get(id);
  if (!asiento) return res.status(404).json({ error: 'asiento no encontrado' });
  const lineas = db.prepare(`
    SELECT l.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre
      FROM pa_asientos_lineas l
      JOIN pa_cuentas c ON c.id = l.cuenta_id
     WHERE l.asiento_id = ?
     ORDER BY l.id
  `).all(id);
  res.json({ ok: true, data: { ...asiento, lineas } });
});

// POST /api/pa/cuentas/asientos — crear asiento
router.post('/asientos', requireAdmin, (req, res) => {
  const { fecha, descripcion, lineas } = req.body || {};

  if (!descripcion) return res.status(400).json({ error: 'descripcion es requerida' });
  if (!Array.isArray(lineas) || lineas.length < 2) {
    return res.status(400).json({ error: 'el asiento debe tener al menos 2 líneas' });
  }

  // Validar partida doble: suma debe == suma haber
  const totalDebe  = lineas.reduce((s, l) => s + (parseFloat(l.debe)  || 0), 0);
  const totalHaber = lineas.reduce((s, l) => s + (parseFloat(l.haber) || 0), 0);
  if (Math.abs(totalDebe - totalHaber) > 0.01) {
    return res.status(400).json({
      error: `partida doble no cuadra: debe=${totalDebe.toFixed(2)} haber=${totalHaber.toFixed(2)}`
    });
  }

  // Validar que cada línea tenga cuenta válida
  for (const l of lineas) {
    if (!l.cuenta_id) return res.status(400).json({ error: 'cada línea debe tener cuenta_id' });
    const c = db.prepare('SELECT id FROM pa_cuentas WHERE id = ? AND activo = 1').get(l.cuenta_id);
    if (!c) return res.status(400).json({ error: `cuenta_id ${l.cuenta_id} no existe o está inactiva` });
  }

  try {
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pa_asientos (fecha, descripcion, usuario_id)
        VALUES (?, ?, ?)
      `).run(
        fecha || new Date().toISOString().slice(0, 10),
        String(descripcion).trim(),
        req._user?.id ?? null
      );
      const asientoId = r.lastInsertRowid;
      const insLinea = db.prepare(`
        INSERT INTO pa_asientos_lineas (asiento_id, cuenta_id, debe, haber, descripcion)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const l of lineas) {
        insLinea.run(
          asientoId,
          l.cuenta_id,
          parseFloat(l.debe)  || 0,
          parseFloat(l.haber) || 0,
          l.descripcion ?? null
        );
      }
      return asientoId;
    });
    const asientoId = tx();
    res.json({ ok: true, id: asientoId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/pa/cuentas/asientos/:id/anular
router.post('/asientos/:id(\\d+)/anular', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const asiento = db.prepare('SELECT * FROM pa_asientos WHERE id = ?').get(id);
  if (!asiento) return res.status(404).json({ error: 'asiento no encontrado' });
  if (asiento.anulado) return res.status(400).json({ error: 'el asiento ya está anulado' });
  db.prepare(`
    UPDATE pa_asientos
       SET anulado = 1, anulado_por = ?, anulado_en = datetime('now','localtime')
     WHERE id = ?
  `).run(req._user?.id ?? null, id);
  res.json({ ok: true });
});
export default router;
