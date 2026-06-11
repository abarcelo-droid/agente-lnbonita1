// src/rutas/sg_contable.js
// ── PLAN DE CUENTAS SG — copia de rutas/cuentas.js repuntada a tablas sg_* ────
// Copia física del Contable de PC para que SG diverja. Mismas reglas (formato de
// códigos, partida doble, imputabilidad, soft-delete, log) pero sobre sg_cuentas/
// sg_asientos/etc. SIN dimensión sociedad_id: estas tablas son SG-only.
// Montado en /api/sg/contable. NO toca ninguna tabla pa_*.

import express from 'express';
import db from '../servicios/db_sg_finanzas.js';

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
    INSERT INTO sg_cuentas_log (cuenta_id, seccion_id, accion, detalle, usuario_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    cuenta_id,
    seccion_id,
    accion,
    detalle ? JSON.stringify(detalle) : null,
    usuario_id
  );
}

// Helper backend: ¿la cuenta es imputable? (no es padre de ninguna otra)
function cuentaEsImputable(db, cuentaId) {
  const c = db.prepare('SELECT codigo FROM sg_cuentas WHERE id = ?').get(cuentaId);
  if (!c) return false;
  const cod = String(c.codigo);
  const hijo = db.prepare("SELECT 1 FROM sg_cuentas WHERE codigo LIKE ? AND codigo != ? LIMIT 1").get(cod + '.%', cod);
  return !hijo;
}

// Helper: ¿el código ya está en uso en CUALQUIER nivel (sección, título o cuenta)?
// `excepto` permite ignorar el propio registro al editar.
function codigoEnUso(db, codigo, excepto) {
  const cod = String(codigo).trim();
  excepto = excepto || {};
  const sec = db.prepare('SELECT id FROM sg_cuentas_secciones WHERE codigo = ?').get(cod);
  if (sec && !(excepto.tabla === 'secciones' && excepto.id === sec.id)) return { nivel: 'sección', id: sec.id };
  const tit = db.prepare('SELECT id FROM sg_cuentas_titulos WHERE codigo = ?').get(cod);
  if (tit && !(excepto.tabla === 'titulos' && excepto.id === tit.id)) return { nivel: 'título', id: tit.id };
  const cta = db.prepare('SELECT id FROM sg_cuentas WHERE codigo = ?').get(cod);
  if (cta && !(excepto.tabla === 'cuentas' && excepto.id === cta.id)) return { nivel: 'cuenta', id: cta.id };
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// TÍTULOS — nivel intermedio X.XX.XX (no imputables)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/titulos', (req, res) => {
  const incluirInactivos = req.query.incluir_inactivos === '1';
  const seccionId = req.query.seccion_id ? parseInt(req.query.seccion_id, 10) : null;
  const params = [];
  let sql = 'SELECT t.*, s.codigo AS seccion_codigo, s.nombre AS seccion_nombre FROM sg_cuentas_titulos t JOIN sg_cuentas_secciones s ON s.id = t.seccion_id WHERE 1 = 1';
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
  if (!/^\d+\.\d{2}\.\d{2}$/.test(codigoStr)) {
    return res.status(400).json({ error: 'El código del título debe tener formato X.XX.XX (ej: 1.01.01)' });
  }
  const sec = db.prepare('SELECT id FROM sg_cuentas_secciones WHERE id = ?').get(parseInt(seccion_id, 10));
  if (!sec) return res.status(400).json({ error: 'seccion_id inválido' });
  const choque = codigoEnUso(db, codigoStr);
  if (choque) return res.status(400).json({ error: `El código ${codigoStr} ya está en uso por un${choque.nivel === 'sección' ? 'a' : ''} ${choque.nivel}. No puede repetirse entre secciones, títulos y cuentas.` });
  try {
    const r = db.prepare(`
      INSERT INTO sg_cuentas_titulos (seccion_id, codigo, nombre, orden, activo)
      VALUES (?, ?, ?, ?, 1)
    `).run(sec.id, codigoStr, String(nombre).trim(), codigoStr);
    logAccion({ seccion_id: sec.id, accion: 'crear_titulo', detalle: { codigo: codigoStr, nombre }, usuario_id: req._user?.id });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/titulos/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tit = db.prepare('SELECT * FROM sg_cuentas_titulos WHERE id = ?').get(id);
  if (!tit) return res.status(404).json({ error: 'título no encontrado' });
  const { nombre, codigo } = req.body || {};
  if (codigo !== undefined && String(codigo).trim() !== String(tit.codigo)) {
    const codigoStr = String(codigo).trim();
    if (!/^\d+\.\d{2}\.\d{2}$/.test(codigoStr)) {
      return res.status(400).json({ error: 'El código del título debe tener formato X.XX.XX (ej: 1.01.01)' });
    }
    const choque = codigoEnUso(db, codigoStr, { tabla: 'titulos', id });
    if (choque) return res.status(400).json({ error: `El código ${codigoStr} ya está en uso por un${choque.nivel === 'sección' ? 'a' : ''} ${choque.nivel}. No puede repetirse entre secciones, títulos y cuentas.` });
    db.prepare("UPDATE sg_cuentas_titulos SET codigo = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(codigoStr, id);
  }
  if (nombre && String(nombre).trim() !== tit.nombre) {
    db.prepare("UPDATE sg_cuentas_titulos SET nombre = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(String(nombre).trim(), id);
  }
  logAccion({ seccion_id: tit.seccion_id, accion: 'editar_titulo', detalle: { antes: tit, despues: req.body }, usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.delete('/titulos/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const conCuentas = db.prepare('SELECT COUNT(*) AS c FROM sg_cuentas WHERE titulo_id = ? AND activo = 1').get(id);
  if (conCuentas.c > 0) {
    return res.status(400).json({
      error: `el título tiene ${conCuentas.c} cuenta(s) activa(s); desactivelas o muevalas primero`,
    });
  }
  db.prepare("UPDATE sg_cuentas_titulos SET activo = 0, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  res.json({ ok: true });
});

router.post('/titulos/:id/reactivar', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE sg_cuentas_titulos SET activo = 1, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECCIONES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/secciones', (req, res) => {
  const incluirInactivas = req.query.incluir_inactivas === '1';
  let sql = 'SELECT * FROM sg_cuentas_secciones WHERE 1 = 1';
  if (!incluirInactivas) sql += ' AND activo = 1';
  sql += ' ORDER BY codigo';
  res.json({ ok: true, data: db.prepare(sql).all() });
});

router.post('/secciones', requireAdmin, (req, res) => {
  const { codigo, nombre, grupo } = req.body || {};
  if (!codigo || !nombre) return res.status(400).json({ error: 'codigo y nombre son requeridos' });
  const codigoStr = String(codigo).trim();
  if (!/^\d+(\.\d+)?$/.test(codigoStr)) {
    return res.status(400).json({ error: 'codigo debe tener formato N o N.NN (ej: 5 o 5.08)' });
  }
  const choque = codigoEnUso(db, codigoStr);
  if (choque) return res.status(400).json({ error: `El código ${codigoStr} ya está en uso por un${choque.nivel === 'sección' ? 'a' : ''} ${choque.nivel}. No puede repetirse entre secciones, títulos y cuentas.` });
  try {
    const r = db.prepare(`
      INSERT INTO sg_cuentas_secciones (codigo, nombre, orden, activo, grupo)
      VALUES (?, ?, ?, 1, ?)
    `).run(codigoStr, String(nombre).trim(), codigoStr, grupo || 'gastos');
    logAccion({ seccion_id: r.lastInsertRowid, accion: 'crear', detalle: { codigo: codigoStr, nombre }, usuario_id: req._user?.id });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/secciones/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sec = db.prepare('SELECT * FROM sg_cuentas_secciones WHERE id = ?').get(id);
  if (!sec) return res.status(404).json({ error: 'sección no encontrada' });

  const { nombre, codigo, grupo } = req.body || {};
  if (codigo !== undefined && String(codigo).trim() !== String(sec.codigo)) {
    const codigoStr = String(codigo).trim();
    const choque = codigoEnUso(db, codigoStr, { tabla: 'secciones', id });
    if (choque) return res.status(400).json({ error: `El código ${codigoStr} ya está en uso por un${choque.nivel === 'sección' ? 'a' : ''} ${choque.nivel}. No puede repetirse entre secciones, títulos y cuentas.` });
    db.prepare("UPDATE sg_cuentas_secciones SET codigo = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(codigoStr, id);
  }
  if (nombre && String(nombre).trim() !== sec.nombre) {
    db.prepare("UPDATE sg_cuentas_secciones SET nombre = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(String(nombre).trim(), id);
  }
  if (grupo) {
    db.prepare("UPDATE sg_cuentas_secciones SET grupo = ? WHERE id = ?").run(grupo, id);
  }
  logAccion({ seccion_id: id, accion: 'editar', detalle: { antes: sec, despues: req.body }, usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.delete('/secciones/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const conCuentas = db.prepare('SELECT COUNT(*) AS c FROM sg_cuentas WHERE seccion_id = ? AND activo = 1').get(id);
  if (conCuentas.c > 0) {
    return res.status(400).json({
      error: `la sección tiene ${conCuentas.c} cuenta(s) activa(s); desactivelas o muevalas primero`,
    });
  }
  db.prepare("UPDATE sg_cuentas_secciones SET activo = 0, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  logAccion({ seccion_id: id, accion: 'desactivar', usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.post('/secciones/:id/reactivar', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE sg_cuentas_secciones SET activo = 1, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  logAccion({ seccion_id: id, accion: 'reactivar', usuario_id: req._user?.id });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// LOG GENERAL — antes de /:id
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
      FROM sg_cuentas_log l
      LEFT JOIN usuarios u             ON u.id = l.usuario_id
      LEFT JOIN sg_cuentas c           ON c.id = l.cuenta_id
      LEFT JOIN sg_cuentas_secciones s ON s.id = l.seccion_id
     WHERE 1 = 1
  `;
  if (desde)      { sql += ' AND l.creado_en >= ?'; params.push(desde); }
  if (hasta)      { sql += ' AND l.creado_en <= ?'; params.push(hasta); }
  if (accion)     { sql += ' AND l.accion = ?';     params.push(accion); }
  if (usuario_id) { sql += ' AND l.usuario_id = ?'; params.push(parseInt(usuario_id, 10)); }
  sql += ' ORDER BY l.creado_en DESC LIMIT 500';
  res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

// ═══════════════════════════════════════════════════════════════════════════
// CUENTAS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/', (req, res) => {
  const { seccion_id, q } = req.query;
  const incluirInactivas = req.query.incluir_inactivas === '1';
  const params = [];
  let sql = `
    SELECT c.*,
           s.nombre AS seccion_nombre,
           s.codigo AS seccion_codigo,
           t.nombre AS titulo_nombre,
           t.codigo AS titulo_codigo
      FROM sg_cuentas c
      JOIN sg_cuentas_secciones s ON s.id = c.seccion_id
      LEFT JOIN sg_cuentas_titulos t ON t.id = c.titulo_id
     WHERE 1 = 1
  `;
  if (!incluirInactivas) sql += ' AND c.activo = 1';
  if (seccion_id) { sql += ' AND c.seccion_id = ?'; params.push(parseInt(seccion_id, 10)); }
  if (q) {
    sql += ' AND (c.codigo LIKE ? OR c.nombre LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY c.codigo';
  const data = db.prepare(sql).all(...params);
  const codigos = data.map(c => String(c.codigo));
  data.forEach(c => {
    const cod = String(c.codigo);
    const esPadre = codigos.some(otro => otro !== cod && otro.startsWith(cod + '.'));
    c.imputable = esPadre ? 0 : 1;
  });
  res.json({ ok: true, data });
});

router.get('/:id(\\d+)', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare(`
    SELECT c.*, s.nombre AS seccion_nombre, s.codigo AS seccion_codigo,
           t.nombre AS titulo_nombre, t.codigo AS titulo_codigo
      FROM sg_cuentas c
      JOIN sg_cuentas_secciones s ON s.id = c.seccion_id
      LEFT JOIN sg_cuentas_titulos t ON t.id = c.titulo_id
     WHERE c.id = ?
  `).get(id);
  if (!c) return res.status(404).json({ error: 'cuenta no encontrada' });
  res.json({ ok: true, data: c });
});

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
  if (!/^\d\.\d{2}\.\d{2}\.\d{4}$/.test(String(codigo).trim())) {
    return res.status(400).json({ error: 'Código inválido. Las cuentas deben respetar el formato X.XX.XX.XXXX (ej: 1.01.01.0001).' });
  }
  if (!['resultado', 'patrimonial'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo inválido' });
  }
  const sec = db.prepare('SELECT id FROM sg_cuentas_secciones WHERE id = ?').get(seccion_id);
  if (!sec) return res.status(400).json({ error: 'seccion_id inválido' });

  const choque = codigoEnUso(db, codigo);
  if (choque) return res.status(400).json({ error: `El código ${codigo} ya está en uso por un${choque.nivel === 'sección' ? 'a' : ''} ${choque.nivel}. No puede repetirse entre secciones, títulos y cuentas.` });

  try {
    const ordenMax = db.prepare('SELECT COALESCE(MAX(orden), 0) AS m FROM sg_cuentas WHERE seccion_id = ?').get(seccion_id).m;

    let titIdFinal = null;
    if (titulo_id) {
      const tit = db.prepare('SELECT id FROM sg_cuentas_titulos WHERE id = ? AND seccion_id = ?').get(parseInt(titulo_id, 10), sec.id);
      if (!tit) return res.status(400).json({ error: 'titulo_id no pertenece a la sección indicada' });
      titIdFinal = tit.id;
    }

    const r = db.prepare(`
      INSERT INTO sg_cuentas
        (codigo, nombre, seccion_id, titulo_id, tipo, permite_lote, permite_campania, es_sistema, orden, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1)
    `).run(
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

router.put('/:id(\\d+)', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cuenta = db.prepare('SELECT * FROM sg_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });

  const { codigo, nombre, seccion_id, titulo_id, tipo, permite_lote, permite_campania } = req.body || {};

  if (codigo && codigo !== cuenta.codigo) {
    if (!/^\d\.\d{2}\.\d{2}\.\d{4}$/.test(String(codigo).trim())) {
      return res.status(400).json({ error: 'Código inválido. Las cuentas deben respetar el formato X.XX.XX.XXXX (ej: 1.01.01.0001).' });
    }
    const choque = codigoEnUso(db, codigo, { tabla: 'cuentas', id });
    if (choque) return res.status(400).json({ error: `El código ${codigo} ya está en uso por un${choque.nivel === 'sección' ? 'a' : ''} ${choque.nivel}. No puede repetirse entre secciones, títulos y cuentas.` });
  }
  if (tipo && !['resultado', 'patrimonial'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo inválido' });
  }
  if (seccion_id) {
    const sec = db.prepare('SELECT id FROM sg_cuentas_secciones WHERE id = ?').get(seccion_id);
    if (!sec) return res.status(400).json({ error: 'seccion_id inválido' });
  }

  try {
    db.prepare(`
      UPDATE sg_cuentas
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
      titulo_id !== undefined ? 1 : null,
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

router.delete('/:id(\\d+)', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cuenta = db.prepare('SELECT * FROM sg_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });
  if (cuenta.es_sistema) {
    return res.status(400).json({ error: 'cuenta del sistema, no se puede desactivar' });
  }
  db.prepare("UPDATE sg_cuentas SET activo = 0, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  logAccion({ cuenta_id: id, accion: 'desactivar', usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.post('/:id(\\d+)/reactivar', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE sg_cuentas SET activo = 1, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  logAccion({ cuenta_id: id, accion: 'reactivar', usuario_id: req._user?.id });
  res.json({ ok: true });
});

// POST /:id/mover  body: { direccion: 'arriba' | 'abajo' }
router.post('/:id(\\d+)/mover', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const direccion = req.body?.direccion;
  if (!['arriba', 'abajo'].includes(direccion)) {
    return res.status(400).json({ error: 'direccion debe ser arriba|abajo' });
  }
  const cuenta = db.prepare('SELECT * FROM sg_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });

  const op = direccion === 'arriba' ? '<' : '>';
  const order = direccion === 'arriba' ? 'DESC' : 'ASC';
  const vecina = db.prepare(`
    SELECT * FROM sg_cuentas
     WHERE seccion_id = ?
       AND codigo ${op} ?
       AND activo = 1
     ORDER BY codigo ${order}
     LIMIT 1
  `).get(cuenta.seccion_id, cuenta.codigo);

  if (!vecina) return res.json({ ok: true, sin_cambio: true });

  const tmp = `__TMP_${Date.now()}_${id}`;
  const tx = db.transaction(() => {
    db.prepare('UPDATE sg_cuentas SET codigo = ? WHERE id = ?').run(tmp, cuenta.id);
    db.prepare('UPDATE sg_cuentas SET codigo = ? WHERE id = ?').run(cuenta.codigo, vecina.id);
    db.prepare('UPDATE sg_cuentas SET codigo = ? WHERE id = ?').run(vecina.codigo, cuenta.id);
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

// POST /:id/reasignar-titulo  body: { titulo_id: number|null, seccion_id?: number }
router.post('/:id(\\d+)/reasignar-titulo', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cuenta = db.prepare('SELECT * FROM sg_cuentas WHERE id = ?').get(id);
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
      const tit = db.prepare('SELECT * FROM sg_cuentas_titulos WHERE id = ?').get(tituloId);
      if (!tit) return res.status(400).json({ error: 'titulo_id inválido' });
      seccionId = tit.seccion_id;

      const hermanas = db.prepare('SELECT codigo FROM sg_cuentas WHERE titulo_id = ?').all(tituloId);
      let max = 0;
      hermanas.forEach(h => {
        const partes = String(h.codigo).split('.');
        const ult = parseInt(partes[partes.length - 1], 10);
        if (Number.isInteger(ult) && ult > max) max = ult;
      });
      let n = max + 1;
      do {
        nuevoCodigo = tit.codigo + '.' + String(n).padStart(4, '0');
        const choca = db.prepare('SELECT id FROM sg_cuentas WHERE codigo = ? AND id != ?').get(nuevoCodigo, id);
        if (!choca) break;
        n++;
      } while (n < 10000);
    } else {
      const sec = db.prepare('SELECT * FROM sg_cuentas_secciones WHERE id = ?').get(seccionId);
      if (!sec) return res.status(400).json({ error: 'la cuenta no tiene sección válida' });
      const sinTit = db.prepare('SELECT codigo FROM sg_cuentas WHERE seccion_id = ? AND titulo_id IS NULL AND id != ?').all(seccionId, id);
      let max = 0;
      sinTit.forEach(h => {
        const sub = parseInt(String(h.codigo).split('.')[1] || '0', 10);
        if (Number.isInteger(sub) && sub > max) max = sub;
      });
      let n = max + 5;
      do {
        nuevoCodigo = sec.codigo + '.' + String(n).padStart(2, '0');
        const choca = db.prepare('SELECT id FROM sg_cuentas WHERE codigo = ? AND id != ?').get(nuevoCodigo, id);
        if (!choca) break;
        n++;
      } while (n < 100);
    }

    db.prepare(`
      UPDATE sg_cuentas
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
      FROM sg_cuentas_log l
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

router.get('/asientos', (req, res) => {
  const { desde, hasta } = req.query;
  const incluirAnulados = req.query.anulados === '1';
  const params = [];
  let sql = `
    SELECT a.*, u.nombre AS usuario_nombre
      FROM sg_asientos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE 1 = 1
  `;
  if (!incluirAnulados) { sql += ' AND a.anulado = 0'; }
  if (desde) { sql += ' AND a.fecha >= ?'; params.push(desde); }
  if (hasta) { sql += ' AND a.fecha <= ?'; params.push(hasta); }
  sql += ' ORDER BY a.fecha DESC, a.id DESC LIMIT 200';
  res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

router.get('/asientos/:id(\\d+)', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const asiento = db.prepare(`
    SELECT a.*, u.nombre AS usuario_nombre
      FROM sg_asientos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.id = ?
  `).get(id);
  if (!asiento) return res.status(404).json({ error: 'asiento no encontrado' });
  const lineas = db.prepare(`
    SELECT l.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre
      FROM sg_asientos_lineas l
      JOIN sg_cuentas c ON c.id = l.cuenta_id
     WHERE l.asiento_id = ?
     ORDER BY l.id
  `).all(id);
  res.json({ ok: true, data: { ...asiento, lineas } });
});

// ═══════════════════════════════════════════════════════════════════════════
// ASIENTOS MODELO — CRUD
// ═══════════════════════════════════════════════════════════════════════════

router.get('/modelos', (req, res) => {
  const modelos = db.prepare(`
    SELECT m.*, COUNT(l.id) as cant_lineas
    FROM sg_asientos_modelo m
    LEFT JOIN sg_asientos_modelo_lineas l ON l.modelo_id = m.id
    WHERE m.activo = 1
    GROUP BY m.id ORDER BY m.nombre
  `).all();
  res.json({ ok: true, data: modelos });
});

router.get('/modelos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const modelo = db.prepare('SELECT * FROM sg_asientos_modelo WHERE id = ?').get(id);
  if (!modelo) return res.status(404).json({ error: 'modelo no encontrado' });
  const lineas = db.prepare(`
    SELECT l.*, c.nombre as cuenta_nombre, c.codigo as cuenta_codigo
    FROM sg_asientos_modelo_lineas l
    JOIN sg_cuentas c ON c.id = l.cuenta_id
    WHERE l.modelo_id = ? ORDER BY l.orden, l.id
  `).all(id);
  res.json({ ok: true, data: { ...modelo, lineas } });
});

router.post('/modelos', requireAdmin, (req, res) => {
  const { nombre, descripcion, lineas } = req.body || {};
  if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });
  if (!Array.isArray(lineas) || lineas.length < 2)
    return res.status(400).json({ error: 'El modelo debe tener al menos 2 líneas' });
  const tieneDebe = lineas.some(l => l.lado === 'debe');
  const tieneHaber = lineas.some(l => l.lado === 'haber');
  if (!tieneDebe || !tieneHaber)
    return res.status(400).json({ error: 'El modelo debe tener al menos 1 línea en el debe y 1 en el haber' });
  for (const l of lineas) {
    if (l.cuenta_id && !cuentaEsImputable(db, parseInt(l.cuenta_id))) {
      const c = db.prepare('SELECT codigo, nombre FROM sg_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(400).json({ error: `La cuenta ${c ? c.codigo + ' — ' + c.nombre : '#' + l.cuenta_id} no es imputable (es un rubro agrupador). Elegí una cuenta final.` });
    }
  }
  try {
    const tx = db.transaction(() => {
      const r = db.prepare(`INSERT INTO sg_asientos_modelo (nombre, descripcion) VALUES (?, ?)`)
        .run(String(nombre).trim(), descripcion || null);
      const modeloId = r.lastInsertRowid;
      const ins = db.prepare(`INSERT INTO sg_asientos_modelo_lineas (modelo_id, cuenta_id, lado, descripcion, orden, tipo_linea) VALUES (?, ?, ?, ?, ?, ?)`);
      lineas.forEach((l, i) => ins.run(modeloId, l.cuenta_id, l.lado, l.descripcion || null, i, l.tipo_linea || 'libre'));
      return modeloId;
    });
    res.json({ ok: true, id: tx() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/modelos/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { nombre, descripcion, lineas } = req.body || {};
  const existe = db.prepare('SELECT id FROM sg_asientos_modelo WHERE id = ?').get(id);
  if (!existe) return res.status(404).json({ error: 'modelo no encontrado' });
  if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });
  if (!Array.isArray(lineas) || lineas.length < 2)
    return res.status(400).json({ error: 'El modelo debe tener al menos 2 líneas' });
  const tieneDebe = lineas.some(l => l.lado === 'debe');
  const tieneHaber = lineas.some(l => l.lado === 'haber');
  if (!tieneDebe || !tieneHaber)
    return res.status(400).json({ error: 'El modelo debe tener al menos 1 línea en el debe y 1 en el haber' });
  for (const l of lineas) {
    if (l.cuenta_id && !cuentaEsImputable(db, parseInt(l.cuenta_id))) {
      const c = db.prepare('SELECT codigo, nombre FROM sg_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(400).json({ error: `La cuenta ${c ? c.codigo + ' — ' + c.nombre : '#' + l.cuenta_id} no es imputable (es un rubro agrupador). Elegí una cuenta final.` });
    }
  }
  try {
    db.transaction(() => {
      db.prepare('UPDATE sg_asientos_modelo SET nombre=?, descripcion=? WHERE id=?')
        .run(String(nombre).trim(), descripcion || null, id);
      db.prepare('DELETE FROM sg_asientos_modelo_lineas WHERE modelo_id = ?').run(id);
      const ins = db.prepare(`INSERT INTO sg_asientos_modelo_lineas (modelo_id, cuenta_id, lado, descripcion, orden, tipo_linea) VALUES (?, ?, ?, ?, ?, ?)`);
      lineas.forEach((l, i) => ins.run(id, l.cuenta_id, l.lado, l.descripcion || null, i, l.tipo_linea || 'libre'));
    })();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/modelos/:id', requireAdmin, (req, res) => {
  db.prepare("UPDATE sg_asientos_modelo SET activo = 0 WHERE id = ?").run(parseInt(req.params.id));
  res.json({ ok: true });
});

// POST /asientos — crear asiento (partida doble)
router.post('/asientos', requireAdmin, (req, res) => {
  const { fecha, descripcion, lineas } = req.body || {};

  if (!descripcion) return res.status(400).json({ error: 'descripcion es requerida' });
  if (!Array.isArray(lineas) || lineas.length < 2) {
    return res.status(400).json({ error: 'el asiento debe tener al menos 2 líneas' });
  }

  const totalDebe  = lineas.reduce((s, l) => s + (parseFloat(l.debe)  || 0), 0);
  const totalHaber = lineas.reduce((s, l) => s + (parseFloat(l.haber) || 0), 0);
  if (Math.abs(totalDebe - totalHaber) > 0.01) {
    return res.status(400).json({
      error: `partida doble no cuadra: debe=${totalDebe.toFixed(2)} haber=${totalHaber.toFixed(2)}`
    });
  }

  for (const l of lineas) {
    if (!l.cuenta_id) return res.status(400).json({ error: 'cada línea debe tener cuenta_id' });
    const c = db.prepare('SELECT id FROM sg_cuentas WHERE id = ? AND activo = 1').get(l.cuenta_id);
    if (!c) return res.status(400).json({ error: `cuenta_id ${l.cuenta_id} no existe o está inactiva` });
    if (!cuentaEsImputable(db, parseInt(l.cuenta_id))) {
      const cc = db.prepare('SELECT codigo, nombre FROM sg_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(400).json({ error: `La cuenta ${cc ? cc.codigo + ' — ' + cc.nombre : '#' + l.cuenta_id} no es imputable (es un rubro agrupador). Elegí una cuenta final.` });
    }
  }

  try {
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO sg_asientos (fecha, descripcion, usuario_id)
        VALUES (?, ?, ?)
      `).run(
        fecha || new Date().toISOString().slice(0, 10),
        String(descripcion).trim(),
        req._user?.id ?? null
      );
      const asientoId = r.lastInsertRowid;
      const insLinea = db.prepare(`
        INSERT INTO sg_asientos_lineas (asiento_id, cuenta_id, debe, haber, descripcion)
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

router.post('/asientos/:id(\\d+)/anular', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const asiento = db.prepare('SELECT * FROM sg_asientos WHERE id = ?').get(id);
  if (!asiento) return res.status(404).json({ error: 'asiento no encontrado' });
  if (asiento.anulado) return res.status(400).json({ error: 'el asiento ya está anulado' });
  db.prepare(`
    UPDATE sg_asientos
       SET anulado = 1, anulado_por = ?, anulado_en = datetime('now','localtime')
     WHERE id = ?
  `).run(req._user?.id ?? null, id);
  res.json({ ok: true });
});

// ── config-impositiva ────────────────────────────────────────────────────────
router.get('/config-impositiva', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT ci.clave, ci.cuenta_id, ci.descripcion,
        c.nombre as cuenta_nombre, c.codigo as cuenta_codigo
      FROM sg_config_impositiva ci
      LEFT JOIN sg_cuentas c ON c.id = ci.cuenta_id
      ORDER BY ci.clave
    `).all();
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.put('/config-impositiva', requireAuth, (req, res) => {
  const { clave, cuenta_id } = req.body || {};
  if (!clave) return res.status(400).json({ ok: false, error: 'clave requerida' });
  try {
    db.prepare(`UPDATE sg_config_impositiva SET cuenta_id = ? WHERE clave = ?`)
      .run(cuenta_id ? parseInt(cuenta_id) : null, clave);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
