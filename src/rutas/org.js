// src/rutas/org.js
// ─── CRUD del organigrama LNB ──────────────────────────────────────────
// Mountar en index.js como: app.use('/api/org', orgRouter);
// Solo admin puede modificar. Todos los autenticados pueden leer.

import express from 'express';
import { getDb } from '../servicios/db.js';
import '../servicios/db_org.js';  // inicializa schema al primer import

const router = express.Router();
const db = () => getDb();

// Middleware local: parsea la cookie lnb_user para poblar req.user
// (consistente con cómo el resto del sistema maneja la sesión)
router.use((req, res, next) => {
  try {
    const cookie = req.cookies?.lnb_user;
    if (cookie) req.user = JSON.parse(cookie);
  } catch(_) {}
  next();
});

const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.rol !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Solo admin' });
  }
  next();
};

// ─── SOCIEDADES ────────────────────────────────────────────────────────
router.get('/sociedades', (req, res) => {
  try {
    const rows = db().prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM areas WHERE sociedad_id = s.id AND activa = 1) AS areas_count
      FROM sociedades s
      WHERE s.activa = 1
      ORDER BY s.tipo, s.nombre
    `).all();
    res.json({ ok: true, sociedades: rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/sociedades', requireAdmin, (req, res) => {
  const { nombre, cuit, tipo = 'externa', funcion } = req.body || {};
  if (!nombre) return res.status(400).json({ ok: false, error: 'nombre requerido' });
  try {
    const r = db().prepare(
      "INSERT INTO sociedades (nombre, cuit, tipo, funcion) VALUES (?,?,?,?)"
    ).run(nombre.trim(), cuit || null, tipo, funcion || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/sociedades/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { nombre, cuit, tipo, funcion, activa } = req.body || {};
  try {
    const cur = db().prepare("SELECT * FROM sociedades WHERE id = ?").get(id);
    if (!cur) return res.status(404).json({ ok: false, error: 'No existe' });
    db().prepare(`
      UPDATE sociedades SET nombre = ?, cuit = ?, tipo = ?, funcion = ?, activa = ?
      WHERE id = ?
    `).run(
      nombre ?? cur.nombre,
      cuit ?? cur.cuit,
      tipo ?? cur.tipo,
      funcion ?? cur.funcion,
      activa ?? cur.activa,
      id
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── ÁREAS ─────────────────────────────────────────────────────────────
router.get('/areas', (req, res) => {
  const sociedad_id = req.query.sociedad_id ? parseInt(req.query.sociedad_id) : null;
  try {
    const base = `
      SELECT a.*, s.nombre AS sociedad_nombre
      FROM areas a JOIN sociedades s ON s.id = a.sociedad_id
      WHERE a.activa = 1
    `;
    const rows = sociedad_id
      ? db().prepare(base + ` AND a.sociedad_id = ? ORDER BY a.nombre`).all(sociedad_id)
      : db().prepare(base + ` ORDER BY s.nombre, a.nombre`).all();
    res.json({ ok: true, areas: rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/areas', requireAdmin, (req, res) => {
  const { sociedad_id, nombre, descripcion } = req.body || {};
  if (!sociedad_id || !nombre) return res.status(400).json({ ok: false, error: 'sociedad_id y nombre requeridos' });
  try {
    const r = db().prepare(
      "INSERT INTO areas (sociedad_id, nombre, descripcion) VALUES (?,?,?)"
    ).run(parseInt(sociedad_id), nombre.trim(), descripcion || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/areas/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { nombre, descripcion, activa } = req.body || {};
  try {
    const cur = db().prepare("SELECT * FROM areas WHERE id = ?").get(id);
    if (!cur) return res.status(404).json({ ok: false, error: 'No existe' });
    db().prepare(
      "UPDATE areas SET nombre = ?, descripcion = ?, activa = ? WHERE id = ?"
    ).run(nombre ?? cur.nombre, descripcion ?? cur.descripcion, activa ?? cur.activa, id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/areas/:id', requireAdmin, (req, res) => {
  // Soft delete (activa = 0). Las asignaciones quedan, pero el área no aparece.
  try {
    db().prepare("UPDATE areas SET activa = 0 WHERE id = ?").run(parseInt(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── UBICACIONES ───────────────────────────────────────────────────────
router.get('/ubicaciones', (req, res) => {
  try {
    res.json({ ok: true, ubicaciones: db().prepare("SELECT * FROM ubicaciones ORDER BY nombre").all() });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/ubicaciones', requireAdmin, (req, res) => {
  const { nombre, direccion, lat, lng, notas } = req.body || {};
  if (!nombre) return res.status(400).json({ ok: false, error: 'nombre requerido' });
  try {
    const r = db().prepare(
      "INSERT INTO ubicaciones (nombre, direccion, lat, lng, notas) VALUES (?,?,?,?,?)"
    ).run(nombre.trim(), direccion || null, lat || null, lng || null, notas || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/ubicaciones/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { nombre, direccion, lat, lng, notas } = req.body || {};
  try {
    const cur = db().prepare("SELECT * FROM ubicaciones WHERE id = ?").get(id);
    if (!cur) return res.status(404).json({ ok: false, error: 'No existe' });
    db().prepare(
      "UPDATE ubicaciones SET nombre = ?, direccion = ?, lat = ?, lng = ?, notas = ? WHERE id = ?"
    ).run(
      nombre ?? cur.nombre,
      direccion ?? cur.direccion,
      lat ?? cur.lat,
      lng ?? cur.lng,
      notas ?? cur.notas,
      id
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/ubicaciones/:id', requireAdmin, (req, res) => {
  try {
    const enUso = db().prepare("SELECT COUNT(*) AS n FROM personas WHERE ubicacion_id = ?").get(parseInt(req.params.id));
    if (enUso.n > 0) return res.status(400).json({ ok: false, error: `En uso por ${enUso.n} persona(s)` });
    db().prepare("DELETE FROM ubicaciones WHERE id = ?").run(parseInt(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── PERSONAS ──────────────────────────────────────────────────────────
router.get('/personas', (req, res) => {
  const q = (req.query.q || '').trim();
  const sociedad_id = req.query.sociedad_id ? parseInt(req.query.sociedad_id) : null;
  const area_id = req.query.area_id ? parseInt(req.query.area_id) : null;
  const include_inactivos = req.query.include_inactivos === '1';

  try {
    let sql = `
      SELECT p.*,
        u.nombre AS ubicacion_nombre,
        (SELECT COUNT(*) FROM personas_areas WHERE persona_id = p.id) AS areas_count,
        (SELECT id FROM usuarios WHERE persona_id = p.id LIMIT 1) AS usuario_id,
        m.nombre   AS reporta_a_nombre,
        m.apellido AS reporta_a_apellido
      FROM personas p
      LEFT JOIN ubicaciones u ON u.id = p.ubicacion_id
      LEFT JOIN personas m    ON m.id = p.reporta_a_id
      WHERE 1=1
    `;
    const params = [];
    if (!include_inactivos) sql += ` AND p.activo = 1`;
    if (q) {
      sql += ` AND (p.nombre LIKE ? OR p.apellido LIKE ? OR p.dni LIKE ? OR p.mail LIKE ?)`;
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (area_id) {
      sql += ` AND p.id IN (SELECT persona_id FROM personas_areas WHERE area_id = ?)`;
      params.push(area_id);
    }
    if (sociedad_id) {
      sql += ` AND p.id IN (
        SELECT pa.persona_id FROM personas_areas pa
        JOIN areas a ON a.id = pa.area_id
        WHERE a.sociedad_id = ?
      )`;
      params.push(sociedad_id);
    }
    sql += ` ORDER BY p.apellido, p.nombre`;
    res.json({ ok: true, personas: db().prepare(sql).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/personas/:id', (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const persona = db().prepare(`
      SELECT p.*, u.nombre AS ubicacion_nombre,
        m.nombre AS reporta_a_nombre, m.apellido AS reporta_a_apellido
      FROM personas p
      LEFT JOIN ubicaciones u ON u.id = p.ubicacion_id
      LEFT JOIN personas m    ON m.id = p.reporta_a_id
      WHERE p.id = ?
    `).get(id);
    if (!persona) return res.status(404).json({ ok: false, error: 'No existe' });
    const areas = db().prepare(`
      SELECT pa.area_id, pa.rol_en_area, pa.desde, pa.hasta,
        a.nombre AS area_nombre, s.id AS sociedad_id, s.nombre AS sociedad_nombre
      FROM personas_areas pa
      JOIN areas a ON a.id = pa.area_id
      JOIN sociedades s ON s.id = a.sociedad_id
      WHERE pa.persona_id = ?
      ORDER BY s.nombre, a.nombre
    `).all(id);
    const usuario = db().prepare(
      "SELECT id, email, nombre AS nombre_login, rol FROM usuarios WHERE persona_id = ?"
    ).get(id);
    res.json({ ok: true, persona, areas, usuario: usuario || null });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personas', requireAdmin, (req, res) => {
  const { dni, nombre, apellido, mail, telefono, ubicacion_id, notas, areas, reporta_a_id } = req.body || {};
  if (!nombre) return res.status(400).json({ ok: false, error: 'nombre requerido' });
  try {
    const r = db().prepare(`
      INSERT INTO personas (dni, nombre, apellido, mail, telefono, ubicacion_id, notas, reporta_a_id)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      dni || null, nombre.trim(), apellido || null, mail || null, telefono || null,
      ubicacion_id ? parseInt(ubicacion_id) : null, notas || null,
      reporta_a_id ? parseInt(reporta_a_id) : null
    );
    const personaId = r.lastInsertRowid;
    if (Array.isArray(areas) && areas.length > 0) {
      const ins = db().prepare(
        "INSERT OR IGNORE INTO personas_areas (persona_id, area_id, rol_en_area) VALUES (?,?,?)"
      );
      for (const a of areas) ins.run(personaId, parseInt(a.area_id), a.rol_en_area || null);
    }
    res.json({ ok: true, id: personaId });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/personas/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { dni, nombre, apellido, mail, telefono, ubicacion_id, notas, activo, reporta_a_id } = req.body || {};
  try {
    const cur = db().prepare("SELECT * FROM personas WHERE id = ?").get(id);
    if (!cur) return res.status(404).json({ ok: false, error: 'No existe' });

    // Validación: reporta_a_id no puede ser uno mismo ni crear ciclo
    let nuevoReportaA = cur.reporta_a_id;
    if (reporta_a_id !== undefined) {
      const r = reporta_a_id ? parseInt(reporta_a_id) : null;
      if (r === id) return res.status(400).json({ ok: false, error: 'Una persona no puede reportarse a sí misma' });
      if (r) {
        // Subir por la cadena: si encuentro `id`, hay ciclo
        let visited = new Set();
        let actual = r;
        while (actual && !visited.has(actual)) {
          if (actual === id) return res.status(400).json({ ok: false, error: 'Crea un ciclo en la jerarquía' });
          visited.add(actual);
          const row = db().prepare("SELECT reporta_a_id FROM personas WHERE id = ?").get(actual);
          actual = row ? row.reporta_a_id : null;
        }
      }
      nuevoReportaA = r;
    }

    db().prepare(`
      UPDATE personas SET dni = ?, nombre = ?, apellido = ?, mail = ?, telefono = ?,
        ubicacion_id = ?, notas = ?, activo = ?, reporta_a_id = ?
      WHERE id = ?
    `).run(
      dni ?? cur.dni,
      nombre ?? cur.nombre,
      apellido ?? cur.apellido,
      mail ?? cur.mail,
      telefono ?? cur.telefono,
      ubicacion_id !== undefined ? (ubicacion_id ? parseInt(ubicacion_id) : null) : cur.ubicacion_id,
      notas ?? cur.notas,
      activo ?? cur.activo,
      nuevoReportaA,
      id
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/personas/:id', requireAdmin, (req, res) => {
  // Soft delete
  try {
    db().prepare("UPDATE personas SET activo = 0 WHERE id = ?").run(parseInt(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── ASIGNACIONES persona ↔ área ───────────────────────────────────────
router.post('/personas/:id/areas', requireAdmin, (req, res) => {
  const personaId = parseInt(req.params.id);
  const { area_id, rol_en_area } = req.body || {};
  if (!area_id) return res.status(400).json({ ok: false, error: 'area_id requerido' });
  try {
    db().prepare(`
      INSERT INTO personas_areas (persona_id, area_id, rol_en_area)
      VALUES (?,?,?)
      ON CONFLICT(persona_id, area_id) DO UPDATE SET rol_en_area = excluded.rol_en_area, hasta = NULL
    `).run(personaId, parseInt(area_id), rol_en_area || null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/personas/:id/areas/:area_id', requireAdmin, (req, res) => {
  try {
    db().prepare("DELETE FROM personas_areas WHERE persona_id = ? AND area_id = ?")
      .run(parseInt(req.params.id), parseInt(req.params.area_id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── ORGANIGRAMA: vista jerárquica con conteos ─────────────────────────
router.get('/organigrama', (req, res) => {
  try {
    const sociedades = db().prepare(`
      SELECT * FROM sociedades WHERE activa = 1 ORDER BY tipo, nombre
    `).all();
    for (const s of sociedades) {
      s.areas = db().prepare(`
        SELECT a.*,
          (SELECT COUNT(*) FROM personas_areas pa
           JOIN personas p ON p.id = pa.persona_id
           WHERE pa.area_id = a.id AND p.activo = 1) AS personas_count
        FROM areas a
        WHERE a.sociedad_id = ? AND a.activa = 1
        ORDER BY a.nombre
      `).all(s.id);
    }
    res.json({ ok: true, sociedades });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── JERARQUÍA: árbol de personas armado por reporta_a_id ──────────────
router.get('/jerarquia', (req, res) => {
  try {
    const personas = db().prepare(`
      SELECT p.id, p.nombre, p.apellido, p.reporta_a_id,
        (SELECT GROUP_CONCAT(s.nombre || ' / ' || a.nombre, ' · ')
         FROM personas_areas pa
         JOIN areas a     ON a.id = pa.area_id
         JOIN sociedades s ON s.id = a.sociedad_id
         WHERE pa.persona_id = p.id AND a.activa = 1) AS areas_str
      FROM personas p
      WHERE p.activo = 1
      ORDER BY p.apellido, p.nombre
    `).all();

    // Armar mapa id → persona y agregar reportes[]
    const map = {};
    for (const p of personas) { p.reportes = []; map[p.id] = p; }

    const raices = [];
    const huerfanos = [];
    for (const p of personas) {
      if (!p.reporta_a_id) {
        raices.push(p);
      } else if (map[p.reporta_a_id]) {
        map[p.reporta_a_id].reportes.push(p);
      } else {
        // Tiene reporta_a_id pero el padre no está activo / no existe
        huerfanos.push(p);
      }
    }

    res.json({ ok: true, raices, huerfanos });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
