// src/rutas/auth.js
import express from 'express';
import { getDb } from '../servicios/db.js';

const router = express.Router();

// ── Login con PIN ────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { email, pin } = req.body;
  if (!email || !pin) return res.status(400).json({ ok: false, error: 'Email y PIN requeridos' });

  const db = getDb();
  try {
    const user = db.prepare('SELECT * FROM usuarios WHERE email = ? AND activo = 1').get(email.trim().toLowerCase());
    if (!user) return res.status(401).json({ ok: false, error: 'Usuario no encontrado' });
    if (user.pin !== String(pin).trim()) return res.status(401).json({ ok: false, error: 'PIN incorrecto' });

    // Guardar sesión en cookie de sesión (sin expiración = dura hasta cerrar browser)
    req.session = req.session || {};
    res.cookie('lnb_user', JSON.stringify({
      id: user.id,
      nombre: user.nombre,
      email: user.email,
      rol: user.rol,
      depositos: JSON.parse(user.depositos || '["MCBA","FINCA","SAN PEDRO"]')
    }), {
      httpOnly: false,  // necesitamos leerla en JS del panel
      sameSite: 'lax',
      path: '/'
      // sin maxAge = sesión de browser
    });

    res.json({
      ok: true,
      user: {
        id: user.id,
        nombre: user.nombre,
        email: user.email,
        rol: user.rol,
        depositos: JSON.parse(user.depositos || '["MCBA","FINCA","SAN PEDRO"]')
      }
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Logout ──────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('lnb_user', { path: '/' });
  res.json({ ok: true });
});

// ── Usuario actual ───────────────────────────────────────────
router.get('/me', (req, res) => {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    const user = JSON.parse(cookie);
    // Verificar que sigue activo en DB
    const db = getDb();
    const u = db.prepare('SELECT activo FROM usuarios WHERE id=?').get(user.id);
    if (!u || !u.activo) {
      res.clearCookie('lnb_user', { path: '/' });
      return res.status(401).json({ ok: false, error: 'Sesión expirada' });
    }
    res.json({ ok: true, user });
  } catch(e) {
    res.clearCookie('lnb_user', { path: '/' });
    res.status(401).json({ ok: false, error: 'Sesión inválida' });
  }
});

// ── ABM Usuarios (solo admin) ────────────────────────────────
function soloAdmin(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    const u = JSON.parse(cookie);
    if (u.rol !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    next();
  } catch(e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

router.get('/usuarios', soloAdmin, (req, res) => {
  const db = getDb();
  try {
    const usuarios = db.prepare('SELECT id, nombre, email, rol, depositos, activo, creado_en FROM usuarios ORDER BY nombre').all();
    res.json({ ok: true, data: usuarios });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/usuarios', soloAdmin, (req, res) => {
  const db = getDb();
  const { nombre, email, pin, rol, depositos } = req.body;
  if (!nombre || !email || !pin) return res.status(400).json({ ok: false, error: 'Nombre, email y PIN requeridos' });
  if (String(pin).length !== 4 || !/^\d{4}$/.test(String(pin))) return res.status(400).json({ ok: false, error: 'El PIN debe ser de 4 dígitos' });
  try {
    const r = db.prepare(`
      INSERT INTO usuarios (nombre, email, pin, rol, depositos)
      VALUES (?, ?, ?, ?, ?)
    `).run(nombre.trim(), email.trim().toLowerCase(), String(pin), rol || 'operador',
           JSON.stringify(depositos || ['MCBA','FINCA','SAN PEDRO']));
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un usuario con ese email' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/usuarios/:id', soloAdmin, (req, res) => {
  const db = getDb();
  const { nombre, email, pin, rol, depositos, activo } = req.body;
  if (pin && (String(pin).length !== 4 || !/^\d{4}$/.test(String(pin)))) {
    return res.status(400).json({ ok: false, error: 'El PIN debe ser de 4 dígitos' });
  }
  try {
    const current = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.params.id);
    if (!current) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    db.prepare(`
      UPDATE usuarios SET nombre=?, email=?, pin=?, rol=?, depositos=?, activo=? WHERE id=?
    `).run(
      nombre || current.nombre,
      (email || current.email).toLowerCase(),
      pin ? String(pin) : current.pin,
      rol || current.rol,
      depositos ? JSON.stringify(depositos) : current.depositos,
      activo !== undefined ? (activo ? 1 : 0) : current.activo,
      req.params.id
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
