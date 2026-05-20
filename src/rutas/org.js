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
        m.apellido AS reporta_a_apellido,
        (SELECT GROUP_CONCAT(DISTINCT s.nombre)
         FROM personas_areas pa
         JOIN areas a     ON a.id = pa.area_id
         JOIN sociedades s ON s.id = a.sociedad_id
         WHERE pa.persona_id = p.id AND a.activa = 1) AS sociedades_str
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
    const usuario = db().prepare(`
      SELECT id, email, nombre AS nombre_login, username, rol, activo,
             depositos, deposito_tipo, deposito_proveedor_id,
             password_hash IS NOT NULL AS tiene_password,
             debe_cambiar_password, migrado_a_v2
      FROM usuarios WHERE persona_id = ?
    `).get(id);
    res.json({ ok: true, persona, areas, usuario: usuario || null });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personas', requireAdmin, (req, res) => {
  const { dni, nombre, apellido, mail, telefono, ubicacion_id, notas, areas, reporta_a_id, cargo, reporta_a_directorio, nivel_acceso } = req.body || {};
  if (!nombre) return res.status(400).json({ ok: false, error: 'nombre requerido' });
  // Mutuamente excluyente: o reporta a una persona, o al Directorio
  const repDir = reporta_a_directorio ? 1 : 0;
  const repId  = repDir ? null : (reporta_a_id ? parseInt(reporta_a_id) : null);
  // Nivel de acceso 0-4 (default 0 = admin total)
  const nivel = (nivel_acceso !== undefined && nivel_acceso !== null && nivel_acceso !== '')
    ? Math.max(0, Math.min(4, parseInt(nivel_acceso)))
    : 0;
  try {
    const r = db().prepare(`
      INSERT INTO personas (dni, nombre, apellido, mail, telefono, ubicacion_id, notas, reporta_a_id, cargo, reporta_a_directorio, nivel_acceso)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      dni || null, nombre.trim(), apellido || null, mail || null, telefono || null,
      ubicacion_id ? parseInt(ubicacion_id) : null, notas || null,
      repId, cargo || null, repDir, nivel
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
  const { dni, nombre, apellido, mail, telefono, ubicacion_id, notas, activo, reporta_a_id, cargo, reporta_a_directorio, nivel_acceso } = req.body || {};
  try {
    const cur = db().prepare("SELECT * FROM personas WHERE id = ?").get(id);
    if (!cur) return res.status(404).json({ ok: false, error: 'No existe' });

    // Determinar nuevos valores de reporte. Mutuamente excluyentes:
    // si reporta_a_directorio = 1 → reporta_a_id se fuerza a null.
    let nuevoReportaA = cur.reporta_a_id;
    let nuevoReportaDir = (reporta_a_directorio !== undefined)
      ? (reporta_a_directorio ? 1 : 0)
      : (cur.reporta_a_directorio || 0);

    if (nuevoReportaDir === 1) {
      nuevoReportaA = null;
    } else if (reporta_a_id !== undefined) {
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

    // Nivel de acceso (0-4) — si vino en body lo aplico, si no mantengo el actual
    let nuevoNivel = cur.nivel_acceso || 0;
    if (nivel_acceso !== undefined && nivel_acceso !== null && nivel_acceso !== '') {
      nuevoNivel = Math.max(0, Math.min(4, parseInt(nivel_acceso)));
    }

    db().prepare(`
      UPDATE personas SET dni = ?, nombre = ?, apellido = ?, mail = ?, telefono = ?,
        ubicacion_id = ?, notas = ?, activo = ?, reporta_a_id = ?, cargo = ?, reporta_a_directorio = ?, nivel_acceso = ?
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
      cargo ?? cur.cargo,
      nuevoReportaDir,
      nuevoNivel,
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

// ─── JERARQUÍA: lista plana de personas activas con campos para armar árbol
// El frontend arma el árbol y aplica filtros (por sociedad, etc.)
router.get('/jerarquia', (req, res) => {
  try {
    const personas = db().prepare(`
      SELECT p.id, p.nombre, p.apellido, p.cargo, p.reporta_a_id, p.reporta_a_directorio, p.nivel_acceso,
        (SELECT GROUP_CONCAT(s.nombre || ' / ' || a.nombre, ' · ')
         FROM personas_areas pa
         JOIN areas a     ON a.id = pa.area_id
         JOIN sociedades s ON s.id = a.sociedad_id
         WHERE pa.persona_id = p.id AND a.activa = 1) AS areas_str,
        (SELECT GROUP_CONCAT(DISTINCT s.nombre)
         FROM personas_areas pa
         JOIN areas a     ON a.id = pa.area_id
         JOIN sociedades s ON s.id = a.sociedad_id
         WHERE pa.persona_id = p.id AND a.activa = 1) AS sociedades_str,
        EXISTS (
          SELECT 1 FROM personas_areas pa
          JOIN areas a ON a.id = pa.area_id
          JOIN sociedades s ON s.id = a.sociedad_id
          WHERE pa.persona_id = p.id
            AND a.nombre = 'Directorio'
            AND s.nombre = 'Familia'
        ) AS en_directorio
      FROM personas p
      WHERE p.activo = 1
      ORDER BY p.apellido, p.nombre
    `).all();
    res.json({ ok: true, personas });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── FASE 3.A: CONFIGURACIÓN DE MÓDULOS ────────────────────────────────
// El admin define qué sociedad y tipo tiene cada módulo del panel.
// Esto se usa después en /me para calcular permisos efectivos por usuario.

// GET /modulos-ocultos — lista de módulos marcados como ocultos
// Cualquier usuario autenticado puede consultar esto (lo usa el sidebar para filtrar)
router.get('/modulos-ocultos', (req, res) => {
  try {
    const rows = db().prepare("SELECT modulo FROM modulos_config WHERE oculto = 1").all();
    res.json({ ok: true, modulos: rows.map(r => r.modulo) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /modulos — lista todos los módulos con su configuración (admin only)
router.get('/modulos', requireAdmin, (req, res) => {
  try {
    const rows = db().prepare(`
      SELECT m.modulo, m.label, m.grupo, m.sociedad_id, m.area_id, m.tipo, m.oculto, m.orden,
             s.nombre AS sociedad_nombre,
             a.nombre AS area_nombre
      FROM modulos_config m
      LEFT JOIN sociedades s ON s.id = m.sociedad_id
      LEFT JOIN areas a      ON a.id = m.area_id
      ORDER BY m.orden ASC, m.label ASC
    `).all();
    res.json({ ok: true, modulos: rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PATCH /modulos/:modulo — actualizar sociedad, área, tipo y/o oculto
router.patch('/modulos/:modulo', requireAdmin, (req, res) => {
  const modulo = req.params.modulo;
  const { sociedad_id, area_id, tipo, oculto } = req.body || {};
  try {
    const cur = db().prepare("SELECT * FROM modulos_config WHERE modulo = ?").get(modulo);
    if (!cur) return res.status(404).json({ ok: false, error: 'Módulo no encontrado' });

    // sociedad_id: null = transversal, número = sociedad específica
    let nuevaSoc = cur.sociedad_id;
    if (sociedad_id !== undefined) {
      nuevaSoc = sociedad_id ? parseInt(sociedad_id) : null;
      if (nuevaSoc) {
        const exSoc = db().prepare("SELECT id FROM sociedades WHERE id = ?").get(nuevaSoc);
        if (!exSoc) return res.status(400).json({ ok: false, error: 'Sociedad inexistente' });
      }
    }

    // area_id: null = todas las áreas de la sociedad. Si está set, fuerza la sociedad a la del área (consistencia)
    let nuevaArea = cur.area_id;
    if (area_id !== undefined) {
      nuevaArea = area_id ? parseInt(area_id) : null;
      if (nuevaArea) {
        const exArea = db().prepare("SELECT sociedad_id FROM areas WHERE id = ?").get(nuevaArea);
        if (!exArea) return res.status(400).json({ ok: false, error: 'Área inexistente' });
        nuevaSoc = exArea.sociedad_id;
      }
    }
    // Si cambió la sociedad y el área actual no pertenece a la nueva, limpio el área
    if (sociedad_id !== undefined && nuevaArea && area_id === undefined) {
      const exArea = db().prepare("SELECT sociedad_id FROM areas WHERE id = ?").get(nuevaArea);
      if (!exArea || exArea.sociedad_id !== nuevaSoc) nuevaArea = null;
    }

    let nuevoTipo = cur.tipo;
    if (tipo !== undefined) {
      if (!['numero','operativo','mobile','externo','sistema'].includes(tipo)) {
        return res.status(400).json({ ok: false, error: 'Tipo inválido' });
      }
      nuevoTipo = tipo;
    }

    let nuevoOculto = cur.oculto || 0;
    if (oculto !== undefined) nuevoOculto = oculto ? 1 : 0;

    db().prepare("UPDATE modulos_config SET sociedad_id = ?, area_id = ?, tipo = ?, oculto = ? WHERE modulo = ?")
      .run(nuevaSoc, nuevaArea, nuevoTipo, nuevoOculto, modulo);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /modulos/bulk — actualización masiva (filtros por grupo o prefijo)
// Body: { filter: { grupo?, prefix? }, update: { sociedad_id?, area_id?, tipo?, oculto? } }
router.post('/modulos/bulk', requireAdmin, (req, res) => {
  const { filter, update } = req.body || {};
  if (!filter || !update) return res.status(400).json({ ok: false, error: 'Falta filter o update' });

  try {
    let sql = "UPDATE modulos_config SET ";
    const sets = [];
    const params = [];

    if (update.sociedad_id !== undefined) {
      sets.push("sociedad_id = ?");
      params.push(update.sociedad_id ? parseInt(update.sociedad_id) : null);
      sets.push("area_id = NULL");
    }
    if (update.area_id !== undefined) {
      const aid = update.area_id ? parseInt(update.area_id) : null;
      if (aid) {
        const exArea = db().prepare("SELECT sociedad_id FROM areas WHERE id = ?").get(aid);
        if (!exArea) return res.status(400).json({ ok: false, error: 'Área inexistente' });
        sets.push("area_id = ?", "sociedad_id = ?");
        params.push(aid, exArea.sociedad_id);
      } else {
        sets.push("area_id = NULL");
      }
    }
    if (update.tipo !== undefined) {
      if (!['numero','operativo','mobile','externo','sistema'].includes(update.tipo)) {
        return res.status(400).json({ ok: false, error: 'Tipo inválido' });
      }
      sets.push("tipo = ?");
      params.push(update.tipo);
    }
    if (update.oculto !== undefined) {
      sets.push("oculto = ?");
      params.push(update.oculto ? 1 : 0);
    }
    if (sets.length === 0) return res.status(400).json({ ok: false, error: 'Nada para actualizar' });

    sql += sets.join(', ') + " WHERE 1=1";
    if (filter.grupo) { sql += " AND grupo = ?"; params.push(filter.grupo); }
    if (filter.prefix) { sql += " AND modulo LIKE ?"; params.push(filter.prefix + '%'); }

    const r = db().prepare(sql).run(...params);
    res.json({ ok: true, actualizados: r.changes });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── FASE 2.D: GESTIÓN DE LOGIN DESDE PERSONA ──────────────────────────────
// Una persona puede tener 0 o 1 usuario activo vinculado. Estos endpoints permiten:
//   - Crear el usuario inicial para una persona (POST /personas/:id/usuario)
//   - Actualizar credenciales de la persona (PATCH /personas/:id/usuario)
//   - Quitar el acceso (DELETE /personas/:id/usuario → soft delete del usuario)

// Helpers (duplicados intencionalmente desde auth.js para no acoplar archivos)
function quitarTildesOrg(s) { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function sanearUsernameOrg(s) { return quitarTildesOrg(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30); }
function generarUsernameOrg(nombre, apellido) {
  const ini = quitarTildesOrg(nombre || '').toLowerCase().replace(/[^a-z0-9]/g, '')[0] || 'x';
  const ape = quitarTildesOrg(apellido || nombre || 'user').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
  let base = (ini + ape) || 'usuario';
  let candidate = base, n = 2;
  while (db().prepare("SELECT 1 FROM usuarios WHERE LOWER(username) = ?").get(candidate)) {
    candidate = base + n;
    n++;
    if (n > 999) { candidate = base + Date.now(); break; }
  }
  return candidate;
}

// POST /personas/:id/usuario — Crear usuario para una persona que aún no tiene
// Body: { username?, rol?, pin?, depositos?, deposito_tipo?, deposito_proveedor_id? }
// Si no viene username, se auto-genera. PIN es obligatorio (default '0000' si no se da).
router.post('/personas/:id/usuario', requireAdmin, (req, res) => {
  const personaId = parseInt(req.params.id);
  const { username, rol = 'operador', pin = '0000', depositos, deposito_tipo, deposito_proveedor_id } = req.body || {};

  try {
    const persona = db().prepare("SELECT * FROM personas WHERE id = ?").get(personaId);
    if (!persona) return res.status(404).json({ ok: false, error: 'Persona no existe' });
    if (!persona.activo) return res.status(400).json({ ok: false, error: 'La persona está dada de baja' });

    // ¿Ya tiene un usuario activo?
    const yaTiene = db().prepare("SELECT id FROM usuarios WHERE persona_id = ? AND activo = 1").get(personaId);
    if (yaTiene) return res.status(400).json({ ok: false, error: 'Esta persona ya tiene un usuario vinculado' });

    if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ ok: false, error: 'El PIN debe ser de 4 dígitos' });

    // Username: saneado o auto-generado a partir del nombre+apellido
    let usernameFinal = username
      ? sanearUsernameOrg(username)
      : generarUsernameOrg(persona.nombre, persona.apellido);
    if (!usernameFinal) return res.status(400).json({ ok: false, error: 'Username inválido' });
    const colision = db().prepare("SELECT id FROM usuarios WHERE LOWER(username) = ?").get(usernameFinal);
    if (colision) return res.status(400).json({ ok: false, error: 'Ya existe un usuario con ese username' });

    // Email: si la persona tiene mail real lo uso; si no, genero uno interno
    const nombreCompleto = (persona.nombre + ' ' + (persona.apellido || '')).trim();
    const emailFinal = persona.mail
      ? persona.mail.trim().toLowerCase()
      : `campo_${nombreCompleto.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'')}@interno.lnb`;

    // Validar depósito IFCO si vino
    let depTipo = deposito_tipo || null;
    let depProvId = null;
    if (depTipo) {
      if (depTipo !== 'san_geronimo' && depTipo !== 'proveedor') {
        return res.status(400).json({ ok: false, error: 'deposito_tipo inválido' });
      }
      if (depTipo === 'proveedor') {
        depProvId = parseInt(deposito_proveedor_id) || null;
        if (!depProvId) return res.status(400).json({ ok: false, error: 'Falta el proveedor' });
        const exProv = db().prepare("SELECT id FROM proveedores WHERE id = ?").get(depProvId);
        if (!exProv) return res.status(400).json({ ok: false, error: 'Proveedor inexistente' });
      }
    }

    const rolesValidos = ['admin', 'operador', 'consulta', 'campo'];
    const rolFinal = rolesValidos.includes(rol) ? rol : 'operador';

    const r = db().prepare(`
      INSERT INTO usuarios (nombre, email, pin, rol, depositos, secciones, deposito_tipo, deposito_proveedor_id, username, persona_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      nombreCompleto, emailFinal, String(pin), rolFinal,
      JSON.stringify(depositos || ['MCBA','FINCA','SAN PEDRO']),
      JSON.stringify(['*']),  // Fase 3.B derivará esto del nivel + áreas; por ahora '*'
      depTipo, depProvId, usernameFinal, personaId
    );
    res.json({ ok: true, usuario_id: r.lastInsertRowid, username: usernameFinal });
  } catch(e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Conflicto: username, email o nombre ya existe' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /personas/:id/usuario — Editar credenciales del usuario vinculado
// Body: { username?, rol?, pin?, depositos?, deposito_tipo?, deposito_proveedor_id? }
router.patch('/personas/:id/usuario', requireAdmin, (req, res) => {
  const personaId = parseInt(req.params.id);
  const { username, rol, pin, depositos, deposito_tipo, deposito_proveedor_id } = req.body || {};
  try {
    const u = db().prepare("SELECT * FROM usuarios WHERE persona_id = ? AND activo = 1").get(personaId);
    if (!u) return res.status(404).json({ ok: false, error: 'La persona no tiene usuario vinculado' });

    if (pin !== undefined && !/^\d{4}$/.test(String(pin))) {
      return res.status(400).json({ ok: false, error: 'El PIN debe ser de 4 dígitos' });
    }

    let usernameFinal = u.username;
    if (username !== undefined) {
      const san = sanearUsernameOrg(username);
      if (!san) return res.status(400).json({ ok: false, error: 'Username inválido' });
      if (san !== u.username) {
        const colision = db().prepare("SELECT id FROM usuarios WHERE LOWER(username) = ? AND id != ?").get(san, u.id);
        if (colision) return res.status(400).json({ ok: false, error: 'Ya existe un usuario con ese username' });
      }
      usernameFinal = san;
    }

    const rolesValidos = ['admin', 'operador', 'consulta', 'campo'];
    const rolFinal = (rol && rolesValidos.includes(rol)) ? rol : u.rol;

    let depTipo = u.deposito_tipo;
    let depProvId = u.deposito_proveedor_id;
    if (deposito_tipo !== undefined) {
      if (!deposito_tipo) { depTipo = null; depProvId = null; }
      else {
        if (deposito_tipo !== 'san_geronimo' && deposito_tipo !== 'proveedor') {
          return res.status(400).json({ ok: false, error: 'deposito_tipo inválido' });
        }
        depTipo = deposito_tipo;
        if (depTipo === 'proveedor') {
          depProvId = parseInt(deposito_proveedor_id) || null;
          if (!depProvId) return res.status(400).json({ ok: false, error: 'Falta el proveedor' });
        } else {
          depProvId = null;
        }
      }
    }

    db().prepare(`
      UPDATE usuarios
      SET username = ?, rol = ?, pin = ?, depositos = ?, deposito_tipo = ?, deposito_proveedor_id = ?
      WHERE id = ?
    `).run(
      usernameFinal, rolFinal,
      pin !== undefined ? String(pin) : u.pin,
      depositos ? JSON.stringify(depositos) : u.depositos,
      depTipo, depProvId, u.id
    );
    res.json({ ok: true, username: usernameFinal });
  } catch(e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Conflicto con datos existentes' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /personas/:id/usuario — Quitar el acceso (soft delete del usuario)
router.delete('/personas/:id/usuario', requireAdmin, (req, res) => {
  const personaId = parseInt(req.params.id);
  try {
    const u = db().prepare("SELECT id FROM usuarios WHERE persona_id = ? AND activo = 1").get(personaId);
    if (!u) return res.status(404).json({ ok: false, error: 'La persona no tiene usuario vinculado' });
    db().prepare("UPDATE usuarios SET activo = 0 WHERE id = ?").run(u.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /usuarios-con-personas — Vista para el "ex-módulo Usuarios"
// Lista todas las personas activas con el estado de su login.
router.get('/usuarios-con-personas', requireAdmin, (req, res) => {
  try {
    const rows = db().prepare(`
      SELECT p.id AS persona_id, p.nombre, p.apellido, p.cargo, p.nivel_acceso,
             p.mail AS persona_mail,
             u.id AS usuario_id, u.username, u.rol, u.activo AS usuario_activo,
             u.password_hash IS NOT NULL AS tiene_password,
             u.migrado_a_v2, u.debe_cambiar_password
      FROM personas p
      LEFT JOIN usuarios u ON u.persona_id = p.id AND u.activo = 1
      WHERE p.activo = 1
      ORDER BY p.apellido, p.nombre
    `).all();
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
