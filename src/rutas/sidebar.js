// src/rutas/sidebar.js
// ─── Sidebar dinámico + Favoritos por usuario ──────────────────────────
// Endpoints:
//   GET    /api/org/sidebar              → módulos visibles agrupados (auth requerido)
//   GET    /api/usuario/favoritos        → favoritos del usuario actual
//   POST   /api/usuario/favoritos/:modulo → agregar favorito
//   DELETE /api/usuario/favoritos/:modulo → quitar favorito
//   POST   /api/usuario/recientes/:modulo → track navegación reciente (opcional, hoy todo en localStorage)

import express from 'express';
import { getDb } from '../servicios/db.js';
import '../servicios/db_favoritos.js';  // inicializa schema al primer import

const router = express.Router();
const db = () => getDb();

// Middleware: parsea cookie lnb_user → req.user (mismo patrón que org.js)
router.use((req, res, next) => {
  try {
    const cookie = req.cookies?.lnb_user;
    if (cookie) req.user = JSON.parse(cookie);
  } catch (_) {}
  next();
});

const requireAuth = (req, res, next) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ ok: false, error: 'No autenticado' });
  }
  next();
};

// ═══════════ GET /api/org/sidebar ═══════════
// Devuelve la estructura del sidebar para el usuario actual.
// Cualquier autenticado puede consultarlo. Filtra los ocultos.
router.get('/sidebar', requireAuth, (req, res) => {
  try {
    const modulos = db().prepare(`
      SELECT m.modulo, m.label, m.grupo, m.sociedad_id, m.area_id, m.tipo, m.orden,
             s.nombre AS sociedad_nombre,
             a.nombre AS area_nombre
      FROM modulos_config m
      LEFT JOIN sociedades s ON s.id = m.sociedad_id
      LEFT JOIN areas a      ON a.id = m.area_id
      WHERE m.oculto = 0
      ORDER BY m.orden ASC, m.label ASC
    `).all();

    // Agrupar por `grupo`
    const grupos = {};
    for (const m of modulos) {
      const g = m.grupo || 'General';
      if (!grupos[g]) grupos[g] = { grupo: g, sociedad_nombre: m.sociedad_nombre, items: [] };
      grupos[g].items.push(m);
    }

    res.json({ ok: true, grupos: Object.values(grupos), total: modulos.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════ GET /api/usuario/favoritos ═══════════
router.get('/usuario/favoritos', requireAuth, (req, res) => {
  try {
    const rows = db().prepare(`
      SELECT f.modulo, f.orden,
             m.label, m.grupo, m.tipo,
             s.nombre AS sociedad_nombre
      FROM usuarios_favoritos f
      JOIN modulos_config m ON m.modulo = f.modulo
      LEFT JOIN sociedades s ON s.id = m.sociedad_id
      WHERE f.usuario_id = ? AND m.oculto = 0
      ORDER BY f.orden ASC, m.label ASC
    `).all(req.user.id);
    res.json({ ok: true, favoritos: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════ POST /api/usuario/favoritos/:modulo ═══════════
router.post('/usuario/favoritos/:modulo', requireAuth, (req, res) => {
  const modulo = req.params.modulo;
  try {
    // Validar que el módulo existe y no está oculto
    const m = db().prepare("SELECT modulo FROM modulos_config WHERE modulo = ? AND oculto = 0").get(modulo);
    if (!m) return res.status(404).json({ ok: false, error: 'Módulo no existe o está oculto' });

    // Calcular siguiente orden
    const maxRow = db().prepare("SELECT MAX(orden) AS mx FROM usuarios_favoritos WHERE usuario_id = ?").get(req.user.id);
    const nextOrden = (maxRow?.mx || 0) + 1;

    db().prepare(`
      INSERT OR IGNORE INTO usuarios_favoritos (usuario_id, modulo, orden)
      VALUES (?, ?, ?)
    `).run(req.user.id, modulo, nextOrden);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════ DELETE /api/usuario/favoritos/:modulo ═══════════
router.delete('/usuario/favoritos/:modulo', requireAuth, (req, res) => {
  try {
    db().prepare("DELETE FROM usuarios_favoritos WHERE usuario_id = ? AND modulo = ?")
      .run(req.user.id, req.params.modulo);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════ POST /api/usuario/favoritos/reorder ═══════════
// Body: { modulos: ['ab-mandata', 'ab-stock', ...] } — orden nuevo
router.post('/usuario/favoritos/reorder', requireAuth, (req, res) => {
  const modulos = req.body?.modulos;
  if (!Array.isArray(modulos)) return res.status(400).json({ ok: false, error: 'Falta array modulos' });
  try {
    db().transaction(() => {
      const upd = db().prepare("UPDATE usuarios_favoritos SET orden = ? WHERE usuario_id = ? AND modulo = ?");
      modulos.forEach((m, i) => upd.run(i + 1, req.user.id, m));
    })();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
