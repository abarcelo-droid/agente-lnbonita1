// src/rutas/scout.js
// ── MÓDULO SCOUT — Scouting agrícola móvil ────────────────────────────────

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../servicios/db.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Middleware auth ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try { req.user = JSON.parse(cookie); next(); }
  catch(e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

// ── Crear tablas Scout ─────────────────────────────────────────────────────
const db = getDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS pa_scout_reportes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id         INTEGER NOT NULL REFERENCES pa_lotes(id),
    usuario_id      INTEGER NOT NULL REFERENCES usuarios(id),
    tipo            TEXT NOT NULL CHECK(tipo IN ('Plaga','Enfermedad','Maleza','Déficit hídrico','Daño por helada','Sistema de riego','Desorden')),
    severidad       INTEGER NOT NULL CHECK(severidad BETWEEN 1 AND 4),
    descripcion     TEXT,
    lat             REAL,
    lng             REAL,
    foto_path       TEXT,
    estado          TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente','en_proceso','resuelto')),
    prioridad_alta  INTEGER DEFAULT 0,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS pa_scout_asignaciones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reporte_id  INTEGER NOT NULL REFERENCES pa_scout_reportes(id),
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
    asignado_por INTEGER REFERENCES usuarios(id),
    frecuencia  TEXT DEFAULT 'semanal' CHECK(frecuencia IN ('diario','semanal')),
    activo      INTEGER DEFAULT 1,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS pa_scout_seguimientos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reporte_id  INTEGER NOT NULL REFERENCES pa_scout_reportes(id),
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
    nota        TEXT,
    foto_path   TEXT,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── Helpers ────────────────────────────────────────────────────────────────

// Calcular distancia entre dos puntos GPS (en metros)
function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Extraer coordenadas del campo poligono_maps (puede ser lat,lng o URL de maps)
function parseCoordenadas(str) {
  if (!str) return null;
  // Formato: lat,lng
  const m = str.match(/([-\d.]+)[,\s]+([-\d.]+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  // URL Google Maps con @lat,lng
  const u = str.match(/@([-\d.]+),([-\d.]+)/);
  if (u) return { lat: parseFloat(u[1]), lng: parseFloat(u[2]) };
  return null;
}

function enriquecer(reportes) {
  return reportes.map(rep => {
    const asig = db.prepare(`
      SELECT a.*, u.nombre as usuario_nombre
      FROM pa_scout_asignaciones a
      JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.reporte_id = ? AND a.activo = 1
      ORDER BY a.creado_en DESC LIMIT 1
    `).get(rep.id);
    rep.asignado_nombre = asig?.usuario_nombre || null;
    rep.frecuencia = asig?.frecuencia || null;
    const segs = db.prepare("SELECT * FROM pa_scout_seguimientos WHERE reporte_id = ? ORDER BY creado_en DESC").all(rep.id);
    rep.seguimientos = segs;
    return rep;
  });
}

// ── DETECCIÓN DE LOTE POR GPS ──────────────────────────────────────────────
router.get('/detectar', requireAuth, (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ ok: false, error: 'lat y lng requeridos' });
  const latN = parseFloat(lat), lngN = parseFloat(lng);

  // Traer todos los lotes con coordenadas
  const lotes = db.prepare(`
    SELECT l.*, s.nombre as sector_nombre,
           cl.cultivo as cultivo_actual
    FROM pa_lotes l
    JOIN pa_sectores s ON s.id = l.sector_id
    LEFT JOIN pa_cultivos_lote cl ON cl.lote_id = l.id
      AND cl.campaña = (SELECT nombre FROM pa_campañas WHERE activa=1 LIMIT 1)
    WHERE l.activo = 1
  `).all();

  let mejorLote = null;
  let mejorDist = Infinity;
  const UMBRAL = 800; // metros — radio máximo para detectar un lote

  for (const lote of lotes) {
    const coords = parseCoordenadas(lote.poligono_maps);
    if (!coords) continue;
    const dist = distanciaMetros(latN, lngN, coords.lat, coords.lng);
    if (dist < mejorDist) {
      mejorDist = dist;
      mejorLote = lote;
    }
  }

  if (mejorLote && mejorDist <= UMBRAL) {
    res.json({ ok: true, lote: mejorLote, distancia_metros: Math.round(mejorDist) });
  } else {
    res.json({ ok: false, error: 'Sin lote cercano', distancia_metros: Math.round(mejorDist) });
  }
});

// ── REPORTES ───────────────────────────────────────────────────────────────

router.get('/reportes', requireAuth, (req, res) => {
  const { estado } = req.query;
  let query = `
    SELECT r.*, l.nombre as lote_nombre, l.finca as lote_finca,
           u.nombre as creado_por_nombre, u.rol as creado_por_rol
    FROM pa_scout_reportes r
    JOIN pa_lotes l ON l.id = r.lote_id
    JOIN usuarios u ON u.id = r.usuario_id
    WHERE 1=1
  `;
  const params = [];
  if (estado) {
    const estados = estado.split(',');
    query += ` AND r.estado IN (${estados.map(() => '?').join(',')})`;
    params.push(...estados);
  }
  query += " ORDER BY r.prioridad_alta DESC, r.severidad DESC, r.creado_en DESC";

  try {
    const data = enriquecer(db.prepare(query).all(...params));
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/reportes', requireAuth, (req, res) => {
  const { lote_id, tipo, severidad, descripcion, lat, lng, foto_b64 } = req.body;
  if (!lote_id || !tipo || !severidad)
    return res.status(400).json({ ok: false, error: 'lote_id, tipo y severidad requeridos' });

  try {
    // Es prioridad alta si lo reporta admin o si severidad >= 3
    const esAlta = req.user.rol === 'admin' || severidad >= 3 ? 1 : 0;

    // Guardar foto si viene
    let fotoPath = null;
    if (foto_b64) {
      const dir = path.join(__dirname, '../../data/scout');
      fs.mkdirSync(dir, { recursive: true });
      const fname = `scout_${Date.now()}_${req.user.id}.jpg`;
      fs.writeFileSync(path.join(dir, fname), Buffer.from(foto_b64, 'base64'));
      fotoPath = '/data/scout/' + fname;
    }

    const r = db.prepare(`
      INSERT INTO pa_scout_reportes
        (lote_id, usuario_id, tipo, severidad, descripcion, lat, lng, foto_path, prioridad_alta)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(lote_id, req.user.id, tipo, severidad, descripcion||null, lat||null, lng||null, fotoPath, esAlta);

    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/reportes/:id/estado', requireAuth, (req, res) => {
  const { estado } = req.body;
  const validos = ['pendiente','en_proceso','resuelto'];
  if (!validos.includes(estado)) return res.status(400).json({ ok: false, error: 'Estado inválido' });
  try {
    db.prepare("UPDATE pa_scout_reportes SET estado=? WHERE id=?").run(estado, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── MIS TAREAS ─────────────────────────────────────────────────────────────
router.get('/mis-tareas', requireAuth, (req, res) => {
  try {
    const data = enriquecer(db.prepare(`
      SELECT r.*, l.nombre as lote_nombre, l.finca as lote_finca,
             u.nombre as creado_por_nombre, u.rol as creado_por_rol
      FROM pa_scout_reportes r
      JOIN pa_lotes l ON l.id = r.lote_id
      JOIN usuarios u ON u.id = r.usuario_id
      JOIN pa_scout_asignaciones a ON a.reporte_id = r.id
      WHERE a.usuario_id = ? AND a.activo = 1 AND r.estado != 'resuelto'
      ORDER BY r.prioridad_alta DESC, r.severidad DESC, r.creado_en DESC
    `).all(req.user.id));
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── ASIGNACIONES ───────────────────────────────────────────────────────────
router.post('/asignar', requireAuth, (req, res) => {
  const { reporte_id, usuario_id, frecuencia } = req.body;
  if (!reporte_id || !usuario_id) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  try {
    // Desactivar asignación anterior
    db.prepare("UPDATE pa_scout_asignaciones SET activo=0 WHERE reporte_id=?").run(reporte_id);
    db.prepare(`
      INSERT INTO pa_scout_asignaciones (reporte_id, usuario_id, asignado_por, frecuencia)
      VALUES (?,?,?,?)
    `).run(reporte_id, usuario_id, req.user.id, frecuencia||'semanal');
    // Cambiar estado a en_proceso
    db.prepare("UPDATE pa_scout_reportes SET estado='en_proceso' WHERE id=?").run(reporte_id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── SEGUIMIENTOS ───────────────────────────────────────────────────────────
router.post('/seguimiento', requireAuth, (req, res) => {
  const { reporte_id, nota, foto_b64 } = req.body;
  if (!reporte_id || !nota) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  try {
    let fotoPath = null;
    if (foto_b64) {
      const dir = path.join(__dirname, '../../data/scout');
      fs.mkdirSync(dir, { recursive: true });
      const fname = `seg_${Date.now()}.jpg`;
      fs.writeFileSync(path.join(dir, fname), Buffer.from(foto_b64, 'base64'));
      fotoPath = '/data/scout/' + fname;
    }
    db.prepare(`
      INSERT INTO pa_scout_seguimientos (reporte_id, usuario_id, nota, foto_path)
      VALUES (?,?,?,?)
    `).run(reporte_id, req.user.id, nota, fotoPath);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
