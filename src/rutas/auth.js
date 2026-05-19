// src/rutas/auth.js
import express from 'express';
import bcrypt from 'bcrypt';
import { getDb } from '../servicios/db.js';

const router = express.Router();
const BCRYPT_ROUNDS = 10;

// ── Migración inline: campos para "depósito asignado" en flujo IFCO mobile ─
// deposito_tipo: 'san_geronimo' | 'proveedor' | NULL (sin asignación, comportamiento default)
// deposito_proveedor_id: FK a proveedores cuando deposito_tipo='proveedor', NULL en otro caso
try { getDb().exec("ALTER TABLE usuarios ADD COLUMN deposito_tipo TEXT"); } catch(e) { /* ya existe */ }
try { getDb().exec("ALTER TABLE usuarios ADD COLUMN deposito_proveedor_id INTEGER"); } catch(e) { /* ya existe */ }

const parseSecciones = (s) => { try { return JSON.parse(s || '["*"]'); } catch(e) { return ['*']; } };
const parseDepositos = (s) => { try { return JSON.parse(s || '["MCBA","FINCA","SAN PEDRO"]'); } catch(e) { return ['MCBA','FINCA','SAN PEDRO']; } };

// ─── FASE 2.B: helpers de auto-generación de username ──────────────────────
// Convención: inicial(nombre) + apellido, minúsculas, sin tildes ni espacios
// Ejemplo: "Andres Barceló" → "abarcelo"
//          "María José González" → "mgonzalez"
//          Colisión: se agrega número (mlopez, mlopez2, mlopez3, ...)
function quitarTildes(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function generarUsername(nombreCompleto, db) {
  // El campo `nombre` en LNB suele ser "Nombre Apellido" todo junto.
  // Split por espacio: primera palabra = nombre, resto = apellido.
  const partes = (nombreCompleto || '').trim().split(/\s+/);
  let nombre = partes[0] || '';
  let apellido = partes.slice(1).join('') || partes[0] || 'usuario';
  const inicial = quitarTildes(nombre).toLowerCase().replace(/[^a-z0-9]/g, '')[0] || 'x';
  const ape = quitarTildes(apellido).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
  let base = (inicial + ape) || 'usuario';
  // Buscar el primero disponible
  let candidate = base;
  let n = 2;
  while (db.prepare("SELECT 1 FROM usuarios WHERE LOWER(username) = ?").get(candidate)) {
    candidate = base + n;
    n++;
    if (n > 999) { candidate = base + Date.now(); break; } // safety
  }
  return candidate;
}

// Sanea un username escrito a mano: minúsculas, sin tildes, solo a-z0-9
function sanearUsername(s) {
  return quitarTildes(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
}

// ─── FASE 2.C: política de password ────────────────────────────────────────
// Política: mínimo 8 chars + letra + número + no obvio + no igual al username
const PASSWORDS_BLOQUEADOS = new Set([
  '12345678','password','password1','passw0rd','contraseña','contrasena',
  'qwerty','qwerty12','qwerty123','asdf1234','abcd1234','abc12345',
  'lnbonita','lnbonita1','lnbonita2026','barcelo','barcelo123',
  'admin','admin123','admin1234','administrador','usuario','usuario1',
  '11111111','00000000','12341234','passwd','iloveyou'
]);

function validatePassword(password, username) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'La contraseña debe tener al menos 8 caracteres';
  }
  if (!/[a-zA-Z]/.test(password)) {
    return 'La contraseña debe contener al menos una letra';
  }
  if (!/[0-9]/.test(password)) {
    return 'La contraseña debe contener al menos un número';
  }
  const lower = password.toLowerCase();
  if (PASSWORDS_BLOQUEADOS.has(lower)) {
    return 'Esa contraseña es demasiado común, elegí otra';
  }
  if (username && lower === username.toLowerCase()) {
    return 'La contraseña no puede ser igual al usuario';
  }
  return null; // OK
}

// Auto-generar usernames para usuarios que todavía no tienen
// Corre 1 vez al cargar el módulo. Idempotente.
(function generarUsernamesIniciales() {
  try {
    const db = getDb();
    const sinUsername = db.prepare("SELECT id, nombre FROM usuarios WHERE username IS NULL OR username = ''").all();
    if (sinUsername.length === 0) return;
    const updateStmt = db.prepare("UPDATE usuarios SET username = ? WHERE id = ?");
    for (const u of sinUsername) {
      const username = generarUsername(u.nombre, db);
      updateStmt.run(username, u.id);
    }
    console.log(`[AUTH] Fase 2.B: ${sinUsername.length} usernames auto-generados`);
  } catch(e) { console.error('[AUTH] Error generando usernames iniciales:', e.message); }
})();

// Login por email+PIN, username+PIN, password (post-fase 2.C), o nombre+PIN
// El campo del body sigue siendo `email` por compatibilidad con el frontend actual,
// pero el backend prueba 3 caminos: email exacto → username → nombre exacto.
// Acepta `pin` (modo viejo) o `password` (modo nuevo post-migración).
router.post('/login', async (req, res) => {
  const { email, pin, password, next } = req.body;
  if (!pin && !password) return res.status(400).json({ ok: false, error: 'Ingresá tu PIN o contraseña' });
  const db = getDb();
  try {
    let user = null;
    const identifier = (email || '').trim();
    if (identifier) {
      const ilower = identifier.toLowerCase();
      // 1. Intentar por email
      user = db.prepare('SELECT * FROM usuarios WHERE email = ? AND activo = 1').get(ilower);
      // 2. Intentar por username (case-insensitive)
      if (!user) {
        user = db.prepare('SELECT * FROM usuarios WHERE LOWER(username) = ? AND activo = 1').get(ilower);
      }
      // 3. Intentar por nombre exacto (transición, usuarios de campo sin email)
      if (!user) {
        user = db.prepare('SELECT * FROM usuarios WHERE nombre = ? AND activo = 1').get(identifier);
      }
    }
    if (!user) return res.status(401).json({ ok: false, error: 'Usuario no encontrado' });

    // ── Modo contraseña (post-fase 2.C) ──────────────────────────────────
    if (password) {
      if (!user.password_hash) {
        return res.status(401).json({ ok: false, error: 'Este usuario todavía no seteó contraseña. Entrá con tu PIN.' });
      }
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
      // OK, seguimos al setear cookie
    } else {
      // ── Modo PIN (transición) ──────────────────────────────────────────
      if (user.pin !== String(pin).trim()) return res.status(401).json({ ok: false, error: 'PIN incorrecto' });

      // FASE 2.C: si el usuario nunca seteó contraseña, lo mandamos a setearla
      // antes de entrar. Devolvemos requiere_setear_password SIN setear la cookie.
      if (!user.migrado_a_v2 || user.migrado_a_v2 === 0) {
        return res.json({
          ok: true,
          requiere_setear_password: true,
          user_id: user.id,
          username: user.username || null,
          nombre: user.nombre
        });
      }
    }

    const userData = {
      id: user.id, nombre: user.nombre, email: user.email, rol: user.rol,
      username: user.username || null,
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

// ─── FASE 2.C: setear contraseña en primer login ───────────────────────────
// El cliente llega acá después de un login exitoso con PIN cuando migrado_a_v2 = 0.
// Re-verifica el PIN por seguridad, valida la nueva contraseña contra la política,
// la hashea con bcrypt, marca migrado_a_v2 = 1 y setea la cookie de sesión.
router.post('/setear-password', async (req, res) => {
  const { user_id, pin, password, next } = req.body || {};
  if (!user_id || !pin || !password) {
    return res.status(400).json({ ok: false, error: 'Faltan datos' });
  }
  const db = getDb();
  try {
    const user = db.prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1').get(parseInt(user_id));
    if (!user) return res.status(401).json({ ok: false, error: 'Usuario no encontrado' });
    if (user.pin !== String(pin).trim()) return res.status(401).json({ ok: false, error: 'PIN incorrecto' });
    // Validar política
    const error = validatePassword(password, user.username);
    if (error) return res.status(400).json({ ok: false, error });
    // Hashear y guardar
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    db.prepare("UPDATE usuarios SET password_hash = ?, migrado_a_v2 = 1, debe_cambiar_password = 0 WHERE id = ?")
      .run(hash, user.id);
    console.log(`[AUTH] Usuario ${user.username || user.email} migró a v2`);

    // Setear cookie (login completo)
    const userData = {
      id: user.id, nombre: user.nombre, email: user.email, rol: user.rol,
      username: user.username || null,
      depositos: parseDepositos(user.depositos),
      secciones: parseSecciones(user.secciones),
      deposito_tipo: user.deposito_tipo || null,
      deposito_proveedor_id: user.deposito_proveedor_id || null
    };
    res.cookie('lnb_user', JSON.stringify(userData), { httpOnly: false, sameSite: 'lax', path: '/' });

    // Mismo manejo de redirect que el login
    const RUTAS_VALIDAS = ['/scout', '/panel', '/m'];
    const esNextValido = (n) => {
      if (!n || typeof n !== 'string') return false;
      if (!n.startsWith('/') || n.startsWith('//')) return false;
      return RUTAS_VALIDAS.some(r => n === r || n.startsWith(r + '/') || n.startsWith(r + '?') || n.startsWith(r + '#'));
    };
    let redirectTo;
    if (userData.rol === 'campo') redirectTo = '/scout';
    else if (esNextValido(next)) redirectTo = next;
    else redirectTo = '/panel';

    res.json({ ok: true, user: userData, redirect_to: redirectTo });
  } catch(e) {
    console.error('[AUTH] Error en setear-password:', e.message);
    res.status(500).json({ ok: false, error: 'Error al guardar la contraseña' });
  }
});

router.get('/me', (req, res) => {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    const user = JSON.parse(cookie);
    const db = getDb();
    const u = db.prepare('SELECT activo, deposito_tipo, deposito_proveedor_id, username FROM usuarios WHERE id=?').get(user.id);
    if (!u || !u.activo) { res.clearCookie('lnb_user', { path: '/' }); return res.status(401).json({ ok: false, error: 'Sesión expirada' }); }
    // Refrescar campos que pueden cambiar desde admin sin re-loguear
    user.deposito_tipo = u.deposito_tipo || null;
    user.deposito_proveedor_id = u.deposito_proveedor_id || null;
    user.username = u.username || null;
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
      SELECT u.id, u.nombre, u.email, u.username, u.rol, u.depositos, u.secciones, u.activo, u.creado_en,
             u.deposito_tipo, u.deposito_proveedor_id, u.migrado_a_v2, p.nombre AS deposito_proveedor_nombre
      FROM usuarios u
      LEFT JOIN proveedores p ON u.deposito_proveedor_id = p.id
      ORDER BY u.nombre
    `).all();
    res.json({ ok: true, data: usuarios });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// FASE 2.B: estado de la migración a username + password (solo admin)
// Útil para saber cuándo podemos hacer el corte definitivo (fase 2.D).
router.get('/migracion-status', soloAdmin, (req, res) => {
  const db = getDb();
  try {
    const total = db.prepare("SELECT COUNT(*) as n FROM usuarios WHERE activo = 1").get().n;
    const migrados = db.prepare("SELECT COUNT(*) as n FROM usuarios WHERE activo = 1 AND migrado_a_v2 = 1").get().n;
    const pendientes = db.prepare(`
      SELECT id, nombre, username, rol
      FROM usuarios
      WHERE activo = 1 AND (migrado_a_v2 IS NULL OR migrado_a_v2 = 0)
      ORDER BY nombre
    `).all();
    res.json({ ok: true, total, migrados, pendientes });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST usuarios — solo admin, email opcional
router.post('/usuarios', soloAdmin, (req, res) => {
  const db = getDb();
  const { nombre, email, pin, rol, depositos, secciones, deposito_tipo, deposito_proveedor_id } = req.body;
  if (!nombre || !pin) return res.status(400).json({ ok: false, error: 'Nombre y PIN requeridos' });
  if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ ok: false, error: 'El PIN debe ser de 4 dígitos' });
  // Username: si viene en el body lo usamos saneado; si no, auto-generamos
  let usernameFinal = req.body.username
    ? sanearUsername(req.body.username)
    : generarUsername(nombre, db);
  if (!usernameFinal) return res.status(400).json({ ok: false, error: 'Username inválido' });
  // Verificar que no colisione (sanearUsername puede haber producido un duplicado)
  const colision = db.prepare("SELECT id FROM usuarios WHERE LOWER(username) = ?").get(usernameFinal);
  if (colision) return res.status(400).json({ ok: false, error: 'Ya existe un usuario con ese username' });
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
    const r = db.prepare(`INSERT INTO usuarios (nombre, email, pin, rol, depositos, secciones, deposito_tipo, deposito_proveedor_id, username) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(nombre.trim(), emailFinal, String(pin), rol||'operador',
           JSON.stringify(depositos||['MCBA','FINCA','SAN PEDRO']), JSON.stringify(secciones||['*']),
           depTipo, depProvId, usernameFinal);
    res.json({ ok: true, id: r.lastInsertRowid, username: usernameFinal });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un usuario con ese nombre, email o username' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/usuarios/:id', soloAdmin, (req, res) => {
  const db = getDb();
  const { nombre, email, pin, rol, depositos, secciones, activo, deposito_tipo, deposito_proveedor_id, username } = req.body;
  if (pin && !/^\d{4}$/.test(String(pin))) return res.status(400).json({ ok: false, error: 'El PIN debe ser de 4 dígitos' });
  try {
    const current = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.params.id);
    if (!current) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    // Si viene email nuevo, usarlo; si no, mantener el actual
    const emailFinal = email ? email.trim().toLowerCase() : current.email;
    // Username: si vino en el body, sanear y validar unicidad. Si no, mantener actual.
    let usernameFinal = current.username;
    if (username !== undefined) {
      const u = sanearUsername(username);
      if (!u) return res.status(400).json({ ok: false, error: 'Username inválido' });
      if (u !== current.username) {
        const colision = db.prepare("SELECT id FROM usuarios WHERE LOWER(username) = ? AND id != ?").get(u, req.params.id);
        if (colision) return res.status(400).json({ ok: false, error: 'Ya existe un usuario con ese username' });
      }
      usernameFinal = u;
    }
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
    db.prepare(`UPDATE usuarios SET nombre=?, email=?, pin=?, rol=?, depositos=?, secciones=?, activo=?, deposito_tipo=?, deposito_proveedor_id=?, username=? WHERE id=?`)
      .run(nombre||current.nombre, emailFinal, pin?String(pin):current.pin,
           rol||current.rol, depositos?JSON.stringify(depositos):current.depositos,
           secciones?JSON.stringify(secciones):current.secciones,
           activo!==undefined?(activo?1:0):current.activo,
           depTipo, depProvId, usernameFinal,
           req.params.id);
    res.json({ ok: true, username: usernameFinal });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un usuario con ese username, email o nombre' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
