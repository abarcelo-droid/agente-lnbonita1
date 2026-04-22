// src/rutas/auth.js
import express from 'express';
import { getDb } from '../servicios/db.js';

const router = express.Router();

const parseSecciones = (s) => { try { return JSON.parse(s || '["*"]'); } catch(e) { return ['*']; } };
const parseDepositos = (s) => { try { return JSON.parse(s || '["MCBA","FINCA","SAN PEDRO"]'); } catch(e) { return ['MCBA','FINCA','SAN PEDRO']; } };

// Login por email+PIN o por nombre+PIN (para usuarios de campo sin email)
router.post('/login', (req, res) => {
  const { email, pin } = req.body;
  if (!pin) return res.status(400).json({ ok: false, error: 'PIN requerido' });
  const db = getDb();
  try {
    let user = null;
    if (email) {
      // Intentar por email primero
      user = db.prepare('SELECT * FROM usuarios WHERE email = ? AND activo = 1').get(email.trim().toLowerCase());
      // Si no encuentra por email, intentar por nombre (para usuarios sin email)
      if (!user) {
        user = db.prepare('SELECT * FROM usuarios WHERE nombre = ? AND activo = 1').get(email.trim());
      }
    }
    if (!user) return res.status(401).json({ ok: false, error: 'Usuario no encontrado' });
    if (user.pin !== String(pin).trim()) return res.status(401).json({ ok: false, error: 'PIN incorrecto' });
    const userData = {
      id: user.id, nombre: user.nombre, email: user.email, rol: user.rol,
      depositos: parseDepositos(user.depositos),
      secciones: parseSecciones(user.secciones)
    };
    res.cookie('lnb_user', JSON.stringify(userData), { httpOnly: false, sameSite: 'lax', path: '/' });
    res.json({ ok: true, user: userData });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/logout', (req, res) => {
  res.clearCookie('lnb_user', { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    const user = JSON.parse(cookie);
    const db = getDb();
    const u = db.prepare('SELECT activo FROM usuarios WHERE id=?').get(user.id);
    if (!u || !u.activo) { res.clearCookie('lnb_user', { path: '/' }); return res.status(401).json({ ok: false, error: 'Sesión expirada' }); }
    res.json({ ok: true, user });
  } catch(e) { res.clearCookie('lnb_user', { path: '/' }); res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
});

function requireAuth(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try { req.user = JSON.parse(cookie); next(); }
  catch(e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

function soloAdmin(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    const u = JSON.parse(cookie);
    if (u.rol !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    next();
  } catch(e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

// GET usuarios — accesible para cualquier usuario autenticado (necesario para Scout y asignaciones)
router.get('/usuarios', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const usuarios = db.prepare('SELECT id, nombre, email, rol, depositos, secciones, activo, creado_en FROM usuarios ORDER BY nombre').all();
    res.json({ ok: true, data: usuarios });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST usuarios — solo admin, email opcional
router.post('/usuarios', soloAdmin, (req, res) => {
  const db = getDb();
  const { nombre, email, pin, rol, depositos, secciones } = req.body;
  if (!nombre || !pin) return res.status(400).json({ ok: false, error: 'Nombre y PIN requeridos' });
  if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ ok: false, error: 'El PIN debe ser de 4 dígitos' });
  // Si no viene email, generar uno interno para mantener unicidad en la DB
  const emailFinal = email
    ? email.trim().toLowerCase()
    : `campo_${nombre.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'')}@interno.lnb`;
  try {
    const r = db.prepare(`INSERT INTO usuarios (nombre, email, pin, rol, depositos, secciones) VALUES (?,?,?,?,?,?)`)
      .run(nombre.trim(), emailFinal, String(pin), rol||'operador',
           JSON.stringify(depositos||['MCBA','FINCA','SAN PEDRO']), JSON.stringify(secciones||['*']));
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un usuario con ese nombre o email' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/usuarios/:id', soloAdmin, (req, res) => {
  const db = getDb();
  const { nombre, email, pin, rol, depositos, secciones, activo } = req.body;
  if (pin && !/^\d{4}$/.test(String(pin))) return res.status(400).json({ ok: false, error: 'El PIN debe ser de 4 dígitos' });
  try {
    const current = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.params.id);
    if (!current) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    // Si viene email nuevo, usarlo; si no, mantener el actual
    const emailFinal = email ? email.trim().toLowerCase() : current.email;
    db.prepare(`UPDATE usuarios SET nombre=?, email=?, pin=?, rol=?, depositos=?, secciones=?, activo=? WHERE id=?`)
      .run(nombre||current.nombre, emailFinal, pin?String(pin):current.pin,
           rol||current.rol, depositos?JSON.stringify(depositos):current.depositos,
           secciones?JSON.stringify(secciones):current.secciones,
           activo!==undefined?(activo?1:0):current.activo, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;


const parseSecciones = (s) => { try { return JSON.parse(s || '["*"]'); } catch(e) { return ['*']; } };
const parseDepositos = (s) => { try { return JSON.parse(s || '["MCBA","FINCA","SAN PEDRO"]'); } catch(e) { return ['MCBA','FINCA','SAN PEDRO']; } };

router.post('/login', (req, res) => {
  const { email, pin } = req.body;
  if (!email || !pin) return res.status(400).json({ ok: false, error: 'Email y PIN requeridos' });
  const db = getDb();
  try {
    const user = db.prepare('SELECT * FROM usuarios WHERE email = ? AND activo = 1').get(email.trim().toLowerCase());
    if (!user) return res.status(401).json({ ok: false, error: 'Usuario no encontrado' });
    if (user.pin !== String(pin).trim()) return res.status(401).json({ ok: false, error: 'PIN incorrecto' });
    const userData = {
      id: user.id, nombre: user.nombre, email: user.email, rol: user.rol,
      depositos: parseDepositos(user.depositos),
      secciones: parseSecciones(user.secciones)
    };
    res.cookie('lnb_user', JSON.stringify(userData), { httpOnly: false, sameSite: 'lax', path: '/' });
    res.json({ ok: true, user: userData });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/logout', (req, res) => {
  res.clearCookie('lnb_user', { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    const user = JSON.parse(cookie);
    const db = getDb();
    const u = db.prepare('SELECT activo FROM usuarios WHERE id=?').get(user.id);
    if (!u || !u.activo) { res.clearCookie('lnb_user', { path: '/' }); return res.status(401).json({ ok: false, error: 'Sesión expirada' }); }
    res.json({ ok: true, user });
  } catch(e) { res.clearCookie('lnb_user', { path: '/' }); res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
});

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
    const usuarios = db.prepare('SELECT id, nombre, email, rol, depositos, secciones, activo, creado_en FROM usuarios ORDER BY nombre').all();
    res.json({ ok: true, data: usuarios });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/usuarios', soloAdmin, (req, res) => {
  const db = getDb();
  const { nombre, email, pin, rol, depositos, secciones } = req.body;
  if (!nombre || !email || !pin) return res.status(400).json({ ok: false, error: 'Nombre, email y PIN requeridos' });
  if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ ok: false, error: 'El PIN debe ser de 4 dígitos' });
  try {
    const r = db.prepare(`INSERT INTO usuarios (nombre, email, pin, rol, depositos, secciones) VALUES (?,?,?,?,?,?)`)
      .run(nombre.trim(), email.trim().toLowerCase(), String(pin), rol||'operador',
           JSON.stringify(depositos||['MCBA','FINCA','SAN PEDRO']), JSON.stringify(secciones||['*']));
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un usuario con ese email' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/usuarios/:id', soloAdmin, (req, res) => {
  const db = getDb();
  const { nombre, email, pin, rol, depositos, secciones, activo } = req.body;
  if (pin && !/^\d{4}$/.test(String(pin))) return res.status(400).json({ ok: false, error: 'El PIN debe ser de 4 dígitos' });
  try {
    const current = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.params.id);
    if (!current) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    db.prepare(`UPDATE usuarios SET nombre=?, email=?, pin=?, rol=?, depositos=?, secciones=?, activo=? WHERE id=?`)
      .run(nombre||current.nombre, (email||current.email).toLowerCase(), pin?String(pin):current.pin,
           rol||current.rol, depositos?JSON.stringify(depositos):current.depositos,
           secciones?JSON.stringify(secciones):current.secciones,
           activo!==undefined?(activo?1:0):current.activo, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
