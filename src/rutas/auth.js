// src/rutas/auth.js
import express from 'express';
import { getDb } from '../servicios/db.js';

const router = express.Router();

// ── Migración inline: campos para "depósito asignado" en flujo IFCO mobile ─
// deposito_tipo: 'san_geronimo' | 'proveedor' | NULL (sin asignación, comportamiento default)
// deposito_proveedor_id: FK a proveedores cuando deposito_tipo='proveedor', NULL en otro caso
try { getDb().exec("ALTER TABLE usuarios ADD COLUMN deposito_tipo TEXT"); } catch(e) { /* ya existe */ }
try { getDb().exec("ALTER TABLE usuarios ADD COLUMN deposito_proveedor_id INTEGER"); } catch(e) { /* ya existe */ }

const parseSecciones = (s) => { try { return JSON.parse(s || '["*"]'); } catch(e) { return ['*']; } };
const parseDepositos = (s) => { try { return JSON.parse(s || '["MCBA","FINCA","SAN PEDRO"]'); } catch(e) { return ['MCBA','FINCA','SAN PEDRO']; } };

// Login por email+PIN o por nombre+PIN (para usuarios de campo sin email)
router.post('/login', (req, res) => {
  const { email, pin, next } = req.body;
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
      secciones: parseSecciones(user.secciones),
      deposito_tipo: user.deposito_tipo || null,
      deposito_proveedor_id: user.deposito_proveedor_id || null
    };
    res.cookie('lnb_user', JSON.stringify(userData), { httpOnly: false, sameSite: 'lax', path: '/' });

    // Whitelist de rutas internas válidas para el parámetro ?next=
    // Se aceptan rutas que empiecen con /scout, /panel o /m (mobile IFCO)
    const RUTAS_VALIDAS = ['/scout', '/panel', '/m'];
    const esNextValido = (n) => {
      if (!n || typeof n !== 'string') return false;
      if (!n.startsWith('/') || n.startsWith('//')) return false;  // evita redirects externos
      return RUTAS_VALIDAS.some(r => n === r || n.startsWith(r + '/') || n.startsWith(r + '?') || n.startsWith(r + '#'));
    };

    // Determinar destino: ?next= si es válido, si no default por rol.
    // El rol "campo" SIEMPRE va a /scout (no puede entrar al panel).
    let redirectTo;
    if (userData.rol === 'campo') {
      redirectTo = '/scout';
    } else if (esNextValido(next)) {
      redirectTo = next;
    } else {
      redirectTo = '/panel';
    }

    res.json({ ok: true, user: userData, redirect_to: redirectTo });
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
    const u = db.prepare('SELECT activo, deposito_tipo, deposito_proveedor_id FROM usuarios WHERE id=?').get(user.id);
    if (!u || !u.activo) { res.clearCookie('lnb_user', { path: '/' }); return res.status(401).json({ ok: false, error: 'Sesión expirada' }); }
    // Refrescar campos que pueden cambiar desde admin sin re-loguear
    user.deposito_tipo = u.deposito_tipo || null;
    user.deposito_proveedor_id = u.deposito_proveedor_id || null;
    // Si es depósito de un proveedor, traer el nombre para mostrar en UI
    if (user.deposito_tipo === 'proveedor' && user.deposito_proveedor_id) {
      const p = db.prepare('SELECT nombre FROM proveedores WHERE id=?').get(user.deposito_proveedor_id);
      user.deposito_proveedor_nombre = p ? p.nombre : null;
    }
    // TEMPORAL: forzar acceso total hasta que se corrijan permisos desde el panel
    user.secciones = ['*'];
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
    const usuarios = db.prepare(`
      SELECT u.id, u.nombre, u.email, u.rol, u.depositos, u.secciones, u.activo, u.creado_en,
             u.deposito_tipo, u.deposito_proveedor_id, p.nombre AS deposito_proveedor_nombre
      FROM usuarios u
      LEFT JOIN proveedores p ON u.deposito_proveedor_id = p.id
      ORDER BY u.nombre
    `).all();
    res.json({ ok: true, data: usuarios });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST usuarios — solo admin, email opcional
router.post('/usuarios', soloAdmin, (req, res) => {
  const db = getDb();
  const { nombre, email, pin, rol, depositos, secciones, deposito_tipo, deposito_proveedor_id } = req.body;
  if (!nombre || !pin) return res.status(400).json({ ok: false, error: 'Nombre y PIN requeridos' });
  if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ ok: false, error: 'El PIN debe ser de 4 dígitos' });
  // Validar depósito IFCO si vino
  let depTipo = deposito_tipo || null;
  let depProvId = null;
  if (depTipo) {
    if (depTipo !== 'san_geronimo' && depTipo !== 'proveedor') {
      return res.status(400).json({ ok: false, error: 'deposito_tipo debe ser "san_geronimo" o "proveedor"' });
    }
    if (depTipo === 'proveedor') {
      depProvId = parseInt(deposito_proveedor_id) || null;
      if (!depProvId) return res.status(400).json({ ok: false, error: 'Falta el proveedor para depósito tipo "proveedor"' });
      const exProv = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(depProvId);
      if (!exProv) return res.status(400).json({ ok: false, error: 'Proveedor inexistente' });
    }
  }
  // Si no viene email, generar uno interno para mantener unicidad en la DB
  const emailFinal = email
    ? email.trim().toLowerCase()
    : `campo_${nombre.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'')}@interno.lnb`;
  try {
    const r = db.prepare(`INSERT INTO usuarios (nombre, email, pin, rol, depositos, secciones, deposito_tipo, deposito_proveedor_id) VALUES (?,?,?,?,?,?,?,?)`)
      .run(nombre.trim(), emailFinal, String(pin), rol||'operador',
           JSON.stringify(depositos||['MCBA','FINCA','SAN PEDRO']), JSON.stringify(secciones||['*']),
           depTipo, depProvId);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un usuario con ese nombre o email' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/usuarios/:id', soloAdmin, (req, res) => {
  const db = getDb();
  const { nombre, email, pin, rol, depositos, secciones, activo, deposito_tipo, deposito_proveedor_id } = req.body;
  if (pin && !/^\d{4}$/.test(String(pin))) return res.status(400).json({ ok: false, error: 'El PIN debe ser de 4 dígitos' });
  try {
    const current = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.params.id);
    if (!current) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    // Si viene email nuevo, usarlo; si no, mantener el actual
    const emailFinal = email ? email.trim().toLowerCase() : current.email;
    // Depósito IFCO: solo cambia si vienen los campos en el body (undefined = no tocar)
    let depTipo = current.deposito_tipo;
    let depProvId = current.deposito_proveedor_id;
    if (deposito_tipo !== undefined) {
      // null o '' significa "limpiar"
      if (!deposito_tipo) {
        depTipo = null;
        depProvId = null;
      } else {
        if (deposito_tipo !== 'san_geronimo' && deposito_tipo !== 'proveedor') {
          return res.status(400).json({ ok: false, error: 'deposito_tipo debe ser "san_geronimo" o "proveedor"' });
        }
        depTipo = deposito_tipo;
        if (depTipo === 'proveedor') {
          depProvId = parseInt(deposito_proveedor_id) || null;
          if (!depProvId) return res.status(400).json({ ok: false, error: 'Falta el proveedor' });
          const exProv = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(depProvId);
          if (!exProv) return res.status(400).json({ ok: false, error: 'Proveedor inexistente' });
        } else {
          depProvId = null;
        }
      }
    }
    db.prepare(`UPDATE usuarios SET nombre=?, email=?, pin=?, rol=?, depositos=?, secciones=?, activo=?, deposito_tipo=?, deposito_proveedor_id=? WHERE id=?`)
      .run(nombre||current.nombre, emailFinal, pin?String(pin):current.pin,
           rol||current.rol, depositos?JSON.stringify(depositos):current.depositos,
           secciones?JSON.stringify(secciones):current.secciones,
           activo!==undefined?(activo?1:0):current.activo,
           depTipo, depProvId,
           req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
