// src/rutas/proveedores.js
// ── PADRÓN DE PROVEEDORES — CRUD completo ─────────────────────────────────
import express from 'express';
import db from '../servicios/db.js';

const router = express.Router();

function getUser(req) {
  try {
    const c = req.cookies?.lnb_user;
    return c ? JSON.parse(c) : null;
  } catch(e) { return null; }
}

// ── Multisociedad (Fase 3) ──────────────────────────────────────────────────
// Padrón de proveedores POR sociedad. Si el request no manda sociedad_id, se usa
// Puente Cordón (PC) por defecto (compat con el panel actual; selector UI = follow-up).
let _pcId = null;
function sociedadPCId() {
  if (_pcId) return _pcId;
  const r = db.prepare("SELECT id FROM sociedades WHERE nombre = 'Puente Cordón SA'").get()
         || db.prepare("SELECT id FROM sociedades WHERE funcion = 'productiva' ORDER BY id LIMIT 1").get();
  _pcId = r ? r.id : 1;
  return _pcId;
}
function getSociedadId(req) {
  const raw = req.body?.sociedad_id ?? req.query?.sociedad_id;
  const id = (raw !== undefined && raw !== null && raw !== '') ? parseInt(raw, 10) : null;
  if (Number.isInteger(id)) {
    const ok = db.prepare('SELECT id FROM sociedades WHERE id = ?').get(id);
    if (ok) return id;
  }
  return sociedadPCId();
}

// GET /api/pa/proveedores?q=&rubro=&activo=todos&sin_modelo=1
router.get('/', (req, res) => {
  const { q, rubro } = req.query;
  const verTodos = req.query.activo === 'todos';
  const soloSinModelo = req.query.sin_modelo === '1';
  const sociedadId = getSociedadId(req);
  const params = [sociedadId];
  let sql = 'SELECT * FROM adm_proveedores WHERE sociedad_id = ?';
  if (!verTodos) { sql += ' AND activo = 1'; }
  if (q) {
    sql += ' AND (razon_social LIKE ? OR nombre_comercial LIKE ? OR cuit LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (rubro) { sql += ' AND rubro = ?'; params.push(rubro); }
  if (soloSinModelo) { sql += ' AND (asiento_modelo_id IS NULL)'; }
  sql += ' ORDER BY razon_social';
  const data = db.prepare(sql).all(...params);
  // Flag derivado para la UI: el proveedor tiene asiento modelo asignado
  data.forEach(p => { p.tiene_asiento_modelo = p.asiento_modelo_id ? 1 : 0; });
  res.json({ ok: true, data });
});

// GET /api/pa/proveedores/:id
router.get('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM adm_proveedores WHERE id = ?').get(parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: 'proveedor no encontrado' });
  res.json({ ok: true, data: p });
});

// POST /api/pa/proveedores
router.post('/', (req, res) => {
  const {
    razon_social, nombre_comercial, cuit, condicion_iva,
    direccion, telefono, email, rubro,
    cbu, alias_cbu, condicion_pago, contacto, notas, asiento_modelo_id
  } = req.body || {};
  if (!razon_social) return res.status(400).json({ error: 'razon_social es requerida' });
  const sociedadId = getSociedadId(req);
  try {
    const r = db.prepare(`
      INSERT INTO adm_proveedores
        (sociedad_id, razon_social, nombre_comercial, cuit, condicion_iva,
         direccion, telefono, email, rubro,
         cbu, alias_cbu, condicion_pago, contacto, notas, asiento_modelo_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sociedadId,
      String(razon_social).trim(),
      nombre_comercial || null,
      cuit || null,
      condicion_iva || 'responsable_inscripto',
      direccion || null,
      telefono || null,
      email || null,
      rubro || null,
      cbu || null,
      alias_cbu || null,
      condicion_pago || null,
      contacto || null,
      notas || null,
      asiento_modelo_id ? parseInt(asiento_modelo_id) : null
    );
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/pa/proveedores/:id
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const existe = db.prepare('SELECT id FROM adm_proveedores WHERE id = ?').get(id);
  if (!existe) return res.status(404).json({ error: 'proveedor no encontrado' });
  const {
    razon_social, nombre_comercial, cuit, condicion_iva,
    direccion, telefono, email, rubro,
    cbu, alias_cbu, condicion_pago, contacto, notas, asiento_modelo_id
  } = req.body || {};
  if (razon_social !== undefined && !razon_social)
    return res.status(400).json({ error: 'razon_social no puede estar vacía' });
  try {
    db.prepare(`
      UPDATE adm_proveedores SET
        razon_social    = COALESCE(?, razon_social),
        nombre_comercial = ?,
        cuit            = ?,
        condicion_iva   = COALESCE(?, condicion_iva),
        direccion       = ?,
        telefono        = ?,
        email           = ?,
        rubro           = ?,
        cbu             = ?,
        alias_cbu       = ?,
        condicion_pago  = ?,
        contacto        = ?,
        notas           = ?,
        asiento_modelo_id = ?,
        actualizado_en  = datetime('now','localtime')
      WHERE id = ?
    `).run(
      razon_social ? String(razon_social).trim() : null,
      nombre_comercial || null,
      cuit || null,
      condicion_iva || null,
      direccion || null,
      telefono || null,
      email || null,
      rubro || null,
      cbu || null,
      alias_cbu || null,
      condicion_pago || null,
      contacto || null,
      notas || null,
      asiento_modelo_id ? parseInt(asiento_modelo_id) : null,
      id
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/pa/proveedores/:id — soft delete
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare("UPDATE adm_proveedores SET activo = 0, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  res.json({ ok: true });
});

// POST /api/pa/proveedores/:id/reactivar
router.post('/:id/reactivar', (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare("UPDATE adm_proveedores SET activo = 1, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  res.json({ ok: true });
});

export default router;
