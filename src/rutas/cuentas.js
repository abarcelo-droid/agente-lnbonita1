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

function requireAuth(req, res, next) {
  const u = getUser(req);
  if (!u) {
    return res.status(401).json({ error: 'no autenticado' });
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

// ── Multisociedad (Fase 1) ──────────────────────────────────────────────────
// El plan de cuentas es UNO POR SOCIEDAD. Las lecturas/escrituras se acotan a
// una sociedad. Si el request no manda sociedad_id, se usa Puente Cordón (PC)
// por defecto, para mantener compatibilidad con el panel actual (que todavía no
// envía la dimensión). El cableado del selector en la UI es follow-up.
let _pcId = null;
function sociedadPCId() {
  if (_pcId) return _pcId;
  const r = db.prepare("SELECT id FROM sociedades WHERE nombre = 'Puente Cordón SA'").get()
         || db.prepare("SELECT id FROM sociedades WHERE funcion = 'productiva' ORDER BY id LIMIT 1").get();
  _pcId = r ? r.id : 1;
  return _pcId;
}
// Resuelve la sociedad del request (query o body). Valida que exista; si no
// viene o es inválida, cae a PC.
function getSociedadId(req) {
  const raw = req.body?.sociedad_id ?? req.query?.sociedad_id;
  const id = (raw !== undefined && raw !== null && raw !== '') ? parseInt(raw, 10) : null;
  if (Number.isInteger(id)) {
    const ok = db.prepare('SELECT id FROM sociedades WHERE id = ?').get(id);
    if (ok) return id;
  }
  return sociedadPCId();
}

// ═══════════════════════════════════════════════════════════════════════════
// TÍTULOS — listar / crear / editar / desactivar
// Nivel intermedio X.XX.XX entre sección (X.XX) y cuenta (X.XX.XX.XXXX).
// No son imputables — solo se usan para organizar el plan de cuentas.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/titulos', (req, res) => {
  const incluirInactivos = req.query.incluir_inactivos === '1';
  const sociedadId = getSociedadId(req);
  const seccionId = req.query.seccion_id ? parseInt(req.query.seccion_id, 10) : null;
  const params = [sociedadId];
  let sql = 'SELECT t.*, s.codigo AS seccion_codigo, s.nombre AS seccion_nombre FROM pa_cuentas_titulos t JOIN pa_cuentas_secciones s ON s.id = t.seccion_id WHERE t.sociedad_id = ?';
  if (!incluirInactivos) sql += ' AND t.activo = 1';
  if (seccionId) { sql += ' AND t.seccion_id = ?'; params.push(seccionId); }
  sql += ' ORDER BY t.codigo';
  res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

router.post('/titulos', requireAdmin, (req, res) => {
  const { codigo, nombre, seccion_id } = req.body || {};
  if (!codigo || !nombre || !seccion_id) {
    return res.status(400).json({ error: 'codigo, nombre y seccion_id son requeridos' });
  }
  const codigoStr = String(codigo).trim();
  // Formato obligatorio: X.XX.XX  (3 partes, ej: 1.01.01)
  if (!/^\d+\.\d{2}\.\d{2}$/.test(codigoStr)) {
    return res.status(400).json({ error: 'El código del título debe tener formato X.XX.XX (ej: 1.01.01)' });
  }
  const sec = db.prepare('SELECT id, sociedad_id FROM pa_cuentas_secciones WHERE id = ?').get(parseInt(seccion_id, 10));
  if (!sec) return res.status(400).json({ error: 'seccion_id inválido' });
  const sociedadId = sec.sociedad_id;
  const existe = db.prepare('SELECT id FROM pa_cuentas_titulos WHERE codigo = ? AND sociedad_id = ?').get(codigoStr, sociedadId);
  if (existe) return res.status(400).json({ error: 'ya existe un título con ese código en esta sociedad' });
  try {
    const r = db.prepare(`
      INSERT INTO pa_cuentas_titulos (sociedad_id, seccion_id, codigo, nombre, orden, activo)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(sociedadId, sec.id, codigoStr, String(nombre).trim(), codigoStr);
    logAccion({ seccion_id: sec.id, accion: 'crear_titulo', detalle: { codigo: codigoStr, nombre }, usuario_id: req._user?.id });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/titulos/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tit = db.prepare('SELECT * FROM pa_cuentas_titulos WHERE id = ?').get(id);
  if (!tit) return res.status(404).json({ error: 'título no encontrado' });
  const { nombre, codigo } = req.body || {};
  if (codigo !== undefined && String(codigo).trim() !== String(tit.codigo)) {
    const codigoStr = String(codigo).trim();
    if (!/^\d+\.\d{2}\.\d{2}$/.test(codigoStr)) {
      return res.status(400).json({ error: 'El código del título debe tener formato X.XX.XX (ej: 1.01.01)' });
    }
    const otra = db.prepare('SELECT id FROM pa_cuentas_titulos WHERE codigo = ? AND sociedad_id = ? AND id != ?').get(codigoStr, tit.sociedad_id, id);
    if (otra) return res.status(400).json({ error: 'ya existe otro título con ese código en esta sociedad' });
    db.prepare("UPDATE pa_cuentas_titulos SET codigo = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(codigoStr, id);
  }
  if (nombre && String(nombre).trim() !== tit.nombre) {
    db.prepare("UPDATE pa_cuentas_titulos SET nombre = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(String(nombre).trim(), id);
  }
  logAccion({ seccion_id: tit.seccion_id, accion: 'editar_titulo', detalle: { antes: tit, despues: req.body }, usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.delete('/titulos/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const conCuentas = db.prepare('SELECT COUNT(*) AS c FROM pa_cuentas WHERE titulo_id = ? AND activo = 1').get(id);
  if (conCuentas.c > 0) {
    return res.status(400).json({
      error: `el título tiene ${conCuentas.c} cuenta(s) activa(s); desactivelas o muevalas primero`,
    });
  }
  db.prepare("UPDATE pa_cuentas_titulos SET activo = 0, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  res.json({ ok: true });
});

router.post('/titulos/:id/reactivar', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE pa_cuentas_titulos SET activo = 1, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECCIONES — listar / crear / editar / desactivar / reactivar
// (van ANTES de las rutas de /:id para que no matcheen mal)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/secciones', (req, res) => {
  const incluirInactivas = req.query.incluir_inactivas === '1';
  const sociedadId = getSociedadId(req);
  let sql = 'SELECT * FROM pa_cuentas_secciones WHERE sociedad_id = ?';
  if (!incluirInactivas) sql += ' AND activo = 1';
  sql += ' ORDER BY codigo';
  res.json({ ok: true, data: db.prepare(sql).all(sociedadId) });
});

router.post('/secciones', requireAdmin, (req, res) => {
  const { codigo, nombre, grupo } = req.body || {};
  if (!codigo || !nombre) return res.status(400).json({ error: 'codigo y nombre son requeridos' });
  // Aceptar tanto enteros (5) como decimales (5.08)
  const codigoStr = String(codigo).trim();
  if (!/^\d+(\.\d+)?$/.test(codigoStr)) {
    return res.status(400).json({ error: 'codigo debe tener formato N o N.NN (ej: 5 o 5.08)' });
  }
  const sociedadId = getSociedadId(req);
  const existe = db.prepare('SELECT id FROM pa_cuentas_secciones WHERE codigo = ? AND sociedad_id = ?').get(codigoStr, sociedadId);
  if (existe) return res.status(400).json({ error: 'ya existe una sección con ese código en esta sociedad' });
  try {
    const r = db.prepare(`
      INSERT INTO pa_cuentas_secciones (sociedad_id, codigo, nombre, orden, activo, grupo)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(sociedadId, codigoStr, String(nombre).trim(), codigoStr, grupo||'gastos');
    logAccion({ seccion_id: r.lastInsertRowid, accion: 'crear', detalle: { codigo: codigoStr, nombre }, usuario_id: req._user?.id });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/secciones/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sec = db.prepare('SELECT * FROM pa_cuentas_secciones WHERE id = ?').get(id);
  if (!sec) return res.status(404).json({ error: 'sección no encontrada' });

  const { nombre, codigo, grupo } = req.body || {};
  if (codigo !== undefined && String(codigo).trim() !== String(sec.codigo)) {
    const codigoStr = String(codigo).trim();
    const otra = db.prepare('SELECT id FROM pa_cuentas_secciones WHERE codigo = ? AND sociedad_id = ? AND id != ?').get(codigoStr, sec.sociedad_id, id);
    if (otra) return res.status(400).json({ error: 'ya existe otra sección con ese código en esta sociedad' });
    db.prepare("UPDATE pa_cuentas_secciones SET codigo = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(codigoStr, id);
  }
  if (nombre && String(nombre).trim() !== sec.nombre) {
    db.prepare("UPDATE pa_cuentas_secciones SET nombre = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(String(nombre).trim(), id);
  }
  if (grupo) {
    db.prepare("UPDATE pa_cuentas_secciones SET grupo = ? WHERE id = ?").run(grupo, id);
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
  const sociedadId = getSociedadId(req);
  const params = [sociedadId];
  let sql = `
    SELECT c.*,
           s.nombre AS seccion_nombre,
           s.codigo AS seccion_codigo,
           t.nombre AS titulo_nombre,
           t.codigo AS titulo_codigo
      FROM pa_cuentas c
      JOIN pa_cuentas_secciones s ON s.id = c.seccion_id
      LEFT JOIN pa_cuentas_titulos t ON t.id = c.titulo_id
     WHERE c.sociedad_id = ?
  `;
  if (!incluirInactivas) sql += ' AND c.activo = 1';
  if (seccion_id) { sql += ' AND c.seccion_id = ?'; params.push(parseInt(seccion_id, 10)); }
  if (q) {
    sql += ' AND (c.codigo LIKE ? OR c.nombre LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY c.codigo';
  const data = db.prepare(sql).all(...params);
  // Imputable = la cuenta NO es padre de ninguna otra (no tiene subcuentas).
  // Una cuenta cuyo código es prefijo de otra (ej: 1.05 es prefijo de 1.05.01) es un
  // rubro agrupador y NO se puede imputar en asientos.
  const codigos = data.map(c => String(c.codigo));
  data.forEach(c => {
    const cod = String(c.codigo);
    const esPadre = codigos.some(otro => otro !== cod && otro.startsWith(cod + '.'));
    c.imputable = esPadre ? 0 : 1;
  });
  res.json({ ok: true, data });
});

// Helper backend: ¿la cuenta es imputable? (no es padre de ninguna otra)
function cuentaEsImputable(db, cuentaId) {
  const c = db.prepare('SELECT codigo FROM pa_cuentas WHERE id = ?').get(cuentaId);
  if (!c) return false;
  const cod = String(c.codigo);
  const hijo = db.prepare("SELECT 1 FROM pa_cuentas WHERE codigo LIKE ? AND codigo != ? LIMIT 1").get(cod + '.%', cod);
  return !hijo;
}

// GET /api/pa/cuentas/:id  (debe ir DESPUÉS de /secciones y /log)
router.get('/:id(\\d+)', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare(`
    SELECT c.*, s.nombre AS seccion_nombre, s.codigo AS seccion_codigo,
           t.nombre AS titulo_nombre, t.codigo AS titulo_codigo
      FROM pa_cuentas c
      JOIN pa_cuentas_secciones s ON s.id = c.seccion_id
      LEFT JOIN pa_cuentas_titulos t ON t.id = c.titulo_id
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
    titulo_id,
    tipo = 'resultado',
    permite_lote = 0,
    permite_campania = 0,
  } = req.body || {};

  if (!codigo || !nombre || !seccion_id) {
    return res.status(400).json({ error: 'codigo, nombre y seccion_id son requeridos' });
  }
  // Formato nuevo obligatorio para cuentas: X.XX.XX.XXXX (4 partes)
  // Se acepta también el formato legacy X.XX o X.XX.XX para cuentas existentes editadas.
  if (!/^\d+(\.\d+){1,3}$/.test(codigo)) {
    return res.status(400).json({ error: 'codigo inválido. El formato requerido para nuevas cuentas es X.XX.XX.XXXX (ej: 1.01.01.0001)' });
  }
  if (!['resultado', 'patrimonial'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo inválido' });
  }
  // La cuenta hereda la sociedad de su sección (plan de cuentas por sociedad).
  const sec = db.prepare('SELECT id, sociedad_id FROM pa_cuentas_secciones WHERE id = ?').get(seccion_id);
  if (!sec) return res.status(400).json({ error: 'seccion_id inválido' });
  const sociedadId = sec.sociedad_id;

  const existe = db.prepare('SELECT id FROM pa_cuentas WHERE codigo = ? AND sociedad_id = ?').get(codigo, sociedadId);
  if (existe) return res.status(400).json({ error: 'ya existe una cuenta con ese código en esta sociedad' });

  try {
    const ordenMax = db.prepare('SELECT COALESCE(MAX(orden), 0) AS m FROM pa_cuentas WHERE seccion_id = ?').get(seccion_id).m;

    // Validar titulo_id si se manda
    let titIdFinal = null;
    if (titulo_id) {
      const tit = db.prepare('SELECT id FROM pa_cuentas_titulos WHERE id = ? AND seccion_id = ?').get(parseInt(titulo_id, 10), sec.id);
      if (!tit) return res.status(400).json({ error: 'titulo_id no pertenece a la sección indicada' });
      titIdFinal = tit.id;
    }

    const r = db.prepare(`
      INSERT INTO pa_cuentas
        (sociedad_id, codigo, nombre, seccion_id, titulo_id, tipo, permite_lote, permite_campania, es_sistema, orden, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1)
    `).run(
      sociedadId,
      codigo,
      String(nombre).trim(),
      seccion_id,
      titIdFinal,
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

  const { codigo, nombre, seccion_id, titulo_id, tipo, permite_lote, permite_campania } = req.body || {};

  if (codigo && codigo !== cuenta.codigo) {
    if (!/^\d+(\.\d+)+$/.test(codigo)) {
      return res.status(400).json({ error: 'codigo debe tener formato S.NN o S.NN.NN (ej: 2.02.04)' });
    }
    const otra = db.prepare('SELECT id FROM pa_cuentas WHERE codigo = ? AND sociedad_id = ? AND id != ?').get(codigo, cuenta.sociedad_id, id);
    if (otra) return res.status(400).json({ error: 'ya existe otra cuenta con ese código en esta sociedad' });
  }
  if (tipo && !['resultado', 'patrimonial'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo inválido' });
  }
  if (seccion_id) {
    // La sección destino debe pertenecer a la misma sociedad (no se mueve entre sociedades).
    const sec = db.prepare('SELECT id, sociedad_id FROM pa_cuentas_secciones WHERE id = ?').get(seccion_id);
    if (!sec) return res.status(400).json({ error: 'seccion_id inválido' });
    if (sec.sociedad_id !== cuenta.sociedad_id) {
      return res.status(400).json({ error: 'la sección destino pertenece a otra sociedad' });
    }
  }

  try {
    db.prepare(`
      UPDATE pa_cuentas
         SET codigo            = COALESCE(?, codigo),
             nombre            = COALESCE(?, nombre),
             seccion_id        = COALESCE(?, seccion_id),
             titulo_id         = CASE WHEN ? IS NOT NULL THEN ? ELSE titulo_id END,
             tipo              = COALESCE(?, tipo),
             permite_lote      = COALESCE(?, permite_lote),
             permite_campania  = COALESCE(?, permite_campania),
             actualizado_en    = datetime('now','localtime')
       WHERE id = ?
    `).run(
      codigo ?? null,
      nombre ? String(nombre).trim() : null,
      seccion_id ?? null,
      titulo_id !== undefined ? 1 : null, // sentinel para distinguir "no mandado" vs "mandado"
      titulo_id !== undefined ? (titulo_id || null) : null,
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

// POST /api/pa/cuentas/:id/reasignar-titulo
// Mueve una cuenta a un título (o la saca de un título) y le asigna automáticamente
// el próximo código libre dentro del destino. Pensado para el "Modo edición" de
// reorganización del plan de cuentas. El ID de la cuenta NO cambia, por lo que los
// asientos contables siguen vinculados y muestran el código nuevo automáticamente.
// body: { titulo_id: number|null, seccion_id?: number }
router.post('/:id(\\d+)/reasignar-titulo', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cuenta = db.prepare('SELECT * FROM pa_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });
  if (cuenta.es_sistema) {
    return res.status(400).json({ error: 'cuenta del sistema, no se puede reorganizar' });
  }

  const tituloIdRaw = req.body?.titulo_id;
  const tituloId = (tituloIdRaw === null || tituloIdRaw === undefined || tituloIdRaw === '')
    ? null : parseInt(tituloIdRaw, 10);

  let seccionId = cuenta.seccion_id;
  let nuevoCodigo = null;

  try {
    if (tituloId) {
      // Destino: un título. La cuenta hereda la sección del título y toma el próximo X.XX.XX.XXXX libre.
      const tit = db.prepare('SELECT * FROM pa_cuentas_titulos WHERE id = ? AND sociedad_id = ?').get(tituloId, cuenta.sociedad_id);
      if (!tit) return res.status(400).json({ error: 'titulo_id inválido' });
      seccionId = tit.seccion_id;

      // Buscar el máximo correlativo (últimos 4 dígitos) entre las cuentas ya asignadas a este título
      const hermanas = db.prepare('SELECT codigo FROM pa_cuentas WHERE titulo_id = ?').all(tituloId);
      let max = 0;
      hermanas.forEach(h => {
        const partes = String(h.codigo).split('.');
        const ult = parseInt(partes[partes.length - 1], 10);
        if (Number.isInteger(ult) && ult > max) max = ult;
      });
      // Generar código y garantizar que no choque con ninguno existente en la sociedad
      let n = max + 1;
      do {
        nuevoCodigo = tit.codigo + '.' + String(n).padStart(4, '0');
        const choca = db.prepare('SELECT id FROM pa_cuentas WHERE codigo = ? AND sociedad_id = ? AND id != ?').get(nuevoCodigo, cuenta.sociedad_id, id);
        if (!choca) break;
        n++;
      } while (n < 10000);
    } else {
      // Destino: "Sin título" dentro de la misma sección. Toma próximo X.XX.NN libre.
      const sec = db.prepare('SELECT * FROM pa_cuentas_secciones WHERE id = ?').get(seccionId);
      if (!sec) return res.status(400).json({ error: 'la cuenta no tiene sección válida' });
      const sinTit = db.prepare('SELECT codigo FROM pa_cuentas WHERE seccion_id = ? AND titulo_id IS NULL AND id != ?').all(seccionId, id);
      let max = 0;
      sinTit.forEach(h => {
        const sub = parseInt(String(h.codigo).split('.')[1] || '0', 10);
        if (Number.isInteger(sub) && sub > max) max = sub;
      });
      let n = max + 5;
      do {
        nuevoCodigo = sec.codigo + '.' + String(n).padStart(2, '0');
        const choca = db.prepare('SELECT id FROM pa_cuentas WHERE codigo = ? AND sociedad_id = ? AND id != ?').get(nuevoCodigo, cuenta.sociedad_id, id);
        if (!choca) break;
        n++;
      } while (n < 100);
    }

    db.prepare(`
      UPDATE pa_cuentas
         SET titulo_id = ?, seccion_id = ?, codigo = ?, actualizado_en = datetime('now','localtime')
       WHERE id = ?
    `).run(tituloId, seccionId, nuevoCodigo, id);

    logAccion({
      cuenta_id: id,
      accion: 'reasignar_titulo',
      detalle: { antes: { codigo: cuenta.codigo, titulo_id: cuenta.titulo_id }, despues: { codigo: nuevoCodigo, titulo_id: tituloId } },
      usuario_id: req._user?.id,
    });

    res.json({ ok: true, codigo: nuevoCodigo, titulo_id: tituloId, seccion_id: seccionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
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
  const sociedadId = getSociedadId(req);
  const params = [sociedadId];
  let sql = `
    SELECT a.*, u.nombre AS usuario_nombre
      FROM pa_asientos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.sociedad_id = ?
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


// ═══════════════════════════════════════════════════════════════════════════
// ASIENTOS MODELO — CRUD
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/pa/cuentas/modelos
router.get('/modelos', (req, res) => {
  const modelos = db.prepare(`
    SELECT m.*, COUNT(l.id) as cant_lineas
    FROM adm_asientos_modelo m
    LEFT JOIN adm_asientos_modelo_lineas l ON l.modelo_id = m.id
    WHERE m.activo = 1
    GROUP BY m.id ORDER BY m.nombre
  `).all();
  res.json({ ok: true, data: modelos });
});

// GET /api/pa/cuentas/modelos/:id — con líneas
router.get('/modelos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const modelo = db.prepare('SELECT * FROM adm_asientos_modelo WHERE id = ?').get(id);
  if (!modelo) return res.status(404).json({ error: 'modelo no encontrado' });
  const lineas = db.prepare(`
    SELECT l.*, c.nombre as cuenta_nombre, c.codigo as cuenta_codigo
    FROM adm_asientos_modelo_lineas l
    JOIN pa_cuentas c ON c.id = l.cuenta_id
    WHERE l.modelo_id = ? ORDER BY l.orden, l.id
  `).all(id);
  res.json({ ok: true, data: { ...modelo, lineas } });
});

// POST /api/pa/cuentas/modelos
router.post('/modelos', requireAdmin, (req, res) => {
  const { nombre, descripcion, lineas } = req.body || {};
  if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });
  if (!Array.isArray(lineas) || lineas.length < 2)
    return res.status(400).json({ error: 'El modelo debe tener al menos 2 líneas' });
  const tieneDebе = lineas.some(l => l.lado === 'debe');
  const tieneHaber = lineas.some(l => l.lado === 'haber');
  if (!tieneDebе || !tieneHaber)
    return res.status(400).json({ error: 'El modelo debe tener al menos 1 línea en el debe y 1 en el haber' });
  // Bloquear cuentas NO imputables (rubros agrupadores: cuentas padre)
  for (const l of lineas) {
    if (l.cuenta_id && !cuentaEsImputable(db, parseInt(l.cuenta_id))) {
      const c = db.prepare('SELECT codigo, nombre FROM pa_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(400).json({ error: `La cuenta ${c ? c.codigo+' — '+c.nombre : '#'+l.cuenta_id} no es imputable (es un rubro agrupador). Elegí una cuenta final.` });
    }
  }
  try {
    const tx = db.transaction(() => {
      const r = db.prepare(`INSERT INTO adm_asientos_modelo (nombre, descripcion) VALUES (?, ?)`)
        .run(String(nombre).trim(), descripcion || null);
      const modeloId = r.lastInsertRowid;
      const ins = db.prepare(`INSERT INTO adm_asientos_modelo_lineas (modelo_id, cuenta_id, lado, descripcion, orden, tipo_linea) VALUES (?, ?, ?, ?, ?, ?)`);
      lineas.forEach((l, i) => ins.run(modeloId, l.cuenta_id, l.lado, l.descripcion || null, i, l.tipo_linea || 'libre'));
      return modeloId;
    });
    res.json({ ok: true, id: tx() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/pa/cuentas/modelos/:id
router.put('/modelos/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { nombre, descripcion, lineas } = req.body || {};
  const existe = db.prepare('SELECT id FROM adm_asientos_modelo WHERE id = ?').get(id);
  if (!existe) return res.status(404).json({ error: 'modelo no encontrado' });
  if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });
  if (!Array.isArray(lineas) || lineas.length < 2)
    return res.status(400).json({ error: 'El modelo debe tener al menos 2 líneas' });
  const tieneDebе = lineas.some(l => l.lado === 'debe');
  const tieneHaber = lineas.some(l => l.lado === 'haber');
  if (!tieneDebе || !tieneHaber)
    return res.status(400).json({ error: 'El modelo debe tener al menos 1 línea en el debe y 1 en el haber' });
  for (const l of lineas) {
    if (l.cuenta_id && !cuentaEsImputable(db, parseInt(l.cuenta_id))) {
      const c = db.prepare('SELECT codigo, nombre FROM pa_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(400).json({ error: `La cuenta ${c ? c.codigo+' — '+c.nombre : '#'+l.cuenta_id} no es imputable (es un rubro agrupador). Elegí una cuenta final.` });
    }
  }
  try {
    db.transaction(() => {
      db.prepare('UPDATE adm_asientos_modelo SET nombre=?, descripcion=? WHERE id=?')
        .run(String(nombre).trim(), descripcion || null, id);
      db.prepare('DELETE FROM adm_asientos_modelo_lineas WHERE modelo_id = ?').run(id);
      const ins = db.prepare(`INSERT INTO adm_asientos_modelo_lineas (modelo_id, cuenta_id, lado, descripcion, orden, tipo_linea) VALUES (?, ?, ?, ?, ?, ?)`);
      lineas.forEach((l, i) => ins.run(id, l.cuenta_id, l.lado, l.descripcion || null, i, l.tipo_linea || 'libre'));
    })();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/pa/cuentas/modelos/:id (soft)
router.delete('/modelos/:id', requireAdmin, (req, res) => {
  db.prepare("UPDATE adm_asientos_modelo SET activo = 0 WHERE id = ?").run(parseInt(req.params.id));
  res.json({ ok: true });
});

// POST /api/pa/cuentas/modelos/desde-factura
// Genera asiento contable real desde una factura, usando el modelo del proveedor
router.post('/modelos/desde-factura', requireAuth, (req, res) => {
  const { compra_id, lineas } = req.body || {};
  if (!compra_id) return res.status(400).json({ error: 'compra_id requerido' });

  const compra = db.prepare(`
    SELECT c.*, p.razon_social as prov_nombre
    FROM pa_compras c
    LEFT JOIN adm_proveedores p ON p.id = c.proveedor_id
    WHERE c.id = ?
  `).get(parseInt(compra_id));
  if (!compra) return res.status(404).json({ error: 'compra no encontrada' });

  if (!Array.isArray(lineas) || lineas.length < 2)
    return res.status(400).json({ error: 'El asiento debe tener al menos 2 líneas' });

  const totalDebe  = lineas.reduce((s, l) => s + (parseFloat(l.debe)  || 0), 0);
  const totalHaber = lineas.reduce((s, l) => s + (parseFloat(l.haber) || 0), 0);
  if (Math.abs(totalDebe - totalHaber) > 0.01)
    return res.status(400).json({ error: `Partida doble no cuadra: debe=${totalDebe.toFixed(2)} haber=${totalHaber.toFixed(2)}` });

  // Generar código FAC-YYYY-NNNN
  const año = new Date().getFullYear();
  const ultimo = db.prepare(`SELECT ref_codigo FROM pa_asientos WHERE ref_codigo LIKE 'FAC-${año}-%' ORDER BY id DESC LIMIT 1`).get();
  let seq = 1;
  if (ultimo?.ref_codigo) {
    const partes = ultimo.ref_codigo.split('-');
    seq = (parseInt(partes[2]) || 0) + 1;
  }
  const refCodigo = `FAC-${año}-${String(seq).padStart(4, '0')}`;
  const descripcion = `${refCodigo} | ${compra.prov_nombre || 'Proveedor'} | ${compra.nro_factura || 'S/N'}`;

  try {
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pa_asientos (fecha, descripcion, usuario_id, ref_compra_id, ref_codigo, sociedad_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(compra.fecha, descripcion, req._user?.id ?? null, compra_id, refCodigo, sociedadPCId());
      const asientoId = r.lastInsertRowid;
      const ins = db.prepare(`INSERT INTO pa_asientos_lineas (asiento_id, cuenta_id, debe, haber, descripcion) VALUES (?, ?, ?, ?, ?)`);
      for (const l of lineas) {
        ins.run(asientoId, l.cuenta_id, parseFloat(l.debe)||0, parseFloat(l.haber)||0, l.descripcion||null);
      }
      return { asientoId, refCodigo };
    });
    const { asientoId, refCodigo: codigo } = tx();
    res.json({ ok: true, id: asientoId, ref_codigo: codigo });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

  // El asiento pertenece a una sociedad; todas sus cuentas deben ser de esa sociedad.
  const sociedadId = getSociedadId(req);

  // Validar que cada línea tenga cuenta válida y de la misma sociedad
  for (const l of lineas) {
    if (!l.cuenta_id) return res.status(400).json({ error: 'cada línea debe tener cuenta_id' });
    const c = db.prepare('SELECT id, sociedad_id FROM pa_cuentas WHERE id = ? AND activo = 1').get(l.cuenta_id);
    if (!c) return res.status(400).json({ error: `cuenta_id ${l.cuenta_id} no existe o está inactiva` });
    if (c.sociedad_id !== sociedadId) {
      return res.status(400).json({ error: `cuenta_id ${l.cuenta_id} pertenece a otra sociedad` });
    }
    if (!cuentaEsImputable(db, parseInt(l.cuenta_id))) {
      const cc = db.prepare('SELECT codigo, nombre FROM pa_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(400).json({ error: `La cuenta ${cc ? cc.codigo+' — '+cc.nombre : '#'+l.cuenta_id} no es imputable (es un rubro agrupador). Elegí una cuenta final.` });
    }
  }

  try {
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pa_asientos (fecha, descripcion, usuario_id, sociedad_id)
        VALUES (?, ?, ?, ?)
      `).run(
        fecha || new Date().toISOString().slice(0, 10),
        String(descripcion).trim(),
        req._user?.id ?? null,
        sociedadId
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
// ── GET /api/pa/cuentas/config-impositiva ────────────────────────────────────
router.get('/config-impositiva', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT ci.clave, ci.cuenta_id, ci.descripcion,
        c.nombre as cuenta_nombre, c.codigo as cuenta_codigo
      FROM adm_config_impositiva ci
      LEFT JOIN pa_cuentas c ON c.id = ci.cuenta_id
      ORDER BY ci.clave
    `).all();
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── PUT /api/pa/cuentas/config-impositiva ────────────────────────────────────
router.put('/config-impositiva', requireAuth, (req, res) => {
  const { clave, cuenta_id } = req.body || {};
  if (!clave) return res.status(400).json({ ok: false, error: 'clave requerida' });
  try {
    db.prepare(`
      UPDATE adm_config_impositiva SET cuenta_id = ? WHERE clave = ?
    `).run(cuenta_id ? parseInt(cuenta_id) : null, clave);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
