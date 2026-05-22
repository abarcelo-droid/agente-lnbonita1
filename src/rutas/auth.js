// src/rutas/auth.js
import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { getDb } from '../servicios/db.js';
import { enviarMail } from '../servicios/mail.js';

const router = express.Router();
const BCRYPT_ROUNDS = 10;

// ── Migración inline: campos para "depósito asignado" en flujo IFCO mobile ─
// deposito_tipo: 'san_geronimo' | 'proveedor' | NULL (sin asignación, comportamiento default)
// deposito_proveedor_id: FK a proveedores cuando deposito_tipo='proveedor', NULL en otro caso
try { getDb().exec("ALTER TABLE usuarios ADD COLUMN deposito_tipo TEXT"); } catch(e) { /* ya existe */ }
try { getDb().exec("ALTER TABLE usuarios ADD COLUMN deposito_proveedor_id INTEGER"); } catch(e) { /* ya existe */ }

// ── Tabla password_reset_tokens (recuperación de contraseña por mail) ──────
// Tokens de un solo uso, expiran en 1 hora.
// Se purgan automáticamente los vencidos al crear uno nuevo.
try {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token       TEXT PRIMARY KEY,
      usuario_id  INTEGER NOT NULL,
      creado_en   TEXT DEFAULT (datetime('now')),
      expira_en   TEXT NOT NULL,
      usado_en    TEXT,
      ip          TEXT,
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
  `);
  getDb().exec("CREATE INDEX IF NOT EXISTS idx_prt_usuario ON password_reset_tokens(usuario_id)");
} catch(e) { console.error('[AUTH] Error creando tabla password_reset_tokens:', e.message); }

// URL base del panel (para los links del mail de recuperación)
const PANEL_BASE_URL = process.env.PANEL_BASE_URL || 'https://agente-lnbonita1-production.up.railway.app';

// ─── DURACIÓN DE SESIÓN SEGÚN DISPOSITIVO ─────────────────────────────────
// Móviles: cookie de 30 días (queremos que la app del celular quede siempre abierta)
// Desktop: cookie de 1 día (al día siguiente requiere reloguearse)
// La detección es por User-Agent. No es 100% confiable pero alcanza para 99% de los casos.
const COOKIE_MAX_AGE_MOBILE  = 30 * 24 * 60 * 60 * 1000; // 30 días en ms
const COOKIE_MAX_AGE_DESKTOP =  1 * 24 * 60 * 60 * 1000; //  1 día en ms

function esMovil(req) {
  const ua = String(req?.headers?.['user-agent'] || '').toLowerCase();
  // Match conservador: tablets caen como mobile, modo escritorio fuerza desktop
  return /android|iphone|ipad|ipod|iemobile|blackberry|opera mini|mobile/i.test(ua);
}

function cookieOpts(req) {
  return {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: esMovil(req) ? COOKIE_MAX_AGE_MOBILE : COOKIE_MAX_AGE_DESKTOP
  };
}

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

// Login por email+password, username+password, o nombre+password
// El campo del body sigue siendo `email` por compatibilidad con el frontend actual,
// pero el backend prueba 3 caminos: email exacto → username → nombre exacto.
// Solo acepta `password`. Los usuarios viejos con solo PIN deben pedirle al admin
// que les asigne una password inicial.
router.post('/login', async (req, res) => {
  const { email, password, next } = req.body;
  if (!password) return res.status(400).json({ ok: false, error: 'Ingresá tu contraseña' });
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
    if (!user) return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });

    // Si el usuario todavía no tiene password configurada (legacy con solo PIN),
    // no puede entrar. Tiene que pedirle al admin que le asigne una password inicial.
    if (!user.password_hash) {
      return res.status(401).json({
        ok: false,
        error: 'Tu cuenta todavía no tiene contraseña configurada. Pedile a tu administrador que te asigne una.'
      });
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });

    // FASE 2.C: si el admin le asignó password inicial con debe_cambiar_password=1,
    // forzar el cambio antes de entrar al panel.
    if (user.debe_cambiar_password) {
      return res.json({
        ok: true,
        requiere_setear_password: true,
        user_id: user.id,
        username: user.username || null,
        nombre: user.nombre
      });
    }

    const userData = {
      id: user.id, nombre: user.nombre, email: user.email, rol: user.rol,
      username: user.username || null,
      depositos: parseDepositos(user.depositos),
      secciones: parseSecciones(user.secciones),
      deposito_tipo: user.deposito_tipo || null,
      deposito_proveedor_id: user.deposito_proveedor_id || null
    };
    res.cookie('lnb_user', JSON.stringify(userData), cookieOpts(req));

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
// El cliente llega acá cuando el admin le asignó una password inicial
// con debe_cambiar_password = 1. Re-verifica la password actual, valida la nueva
// contra la política, la hashea con bcrypt, marca migrado_a_v2 = 1,
// debe_cambiar_password = 0 y setea la cookie.
router.post('/setear-password', async (req, res) => {
  const { user_id, password_actual, password, next } = req.body || {};
  if (!user_id || !password) {
    return res.status(400).json({ ok: false, error: 'Faltan datos' });
  }
  if (!password_actual) {
    return res.status(400).json({ ok: false, error: 'Confirmá tu contraseña actual' });
  }
  const db = getDb();
  try {
    const user = db.prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1').get(parseInt(user_id));
    if (!user) return res.status(401).json({ ok: false, error: 'Usuario no encontrado' });

    // Verificar password actual
    if (!user.password_hash) return res.status(401).json({ ok: false, error: 'Sin contraseña actual configurada' });
    const ok = await bcrypt.compare(password_actual, user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'Contraseña actual incorrecta' });

    // Validar política
    const error = validatePassword(password, user.username);
    if (error) return res.status(400).json({ ok: false, error });
    // No permitir reusar la misma contraseña
    if (password_actual === password) {
      return res.status(400).json({ ok: false, error: 'La nueva contraseña debe ser distinta a la actual' });
    }
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
    res.cookie('lnb_user', JSON.stringify(userData), cookieOpts(req));

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
// Incluye datos de la persona vinculada (nivel_acceso, áreas, cargo)
router.get('/usuarios', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const usuarios = db.prepare(`
      SELECT u.id, u.nombre, u.email, u.username, u.rol, u.depositos, u.secciones, u.activo, u.creado_en,
             u.deposito_tipo, u.deposito_proveedor_id, u.migrado_a_v2, u.debe_cambiar_password,
             u.password_hash IS NOT NULL AS tiene_password,
             u.persona_id,
             p.nombre AS persona_nombre, p.apellido AS persona_apellido,
             p.cargo AS persona_cargo, p.nivel_acceso AS persona_nivel_acceso,
             pr.nombre AS deposito_proveedor_nombre
      FROM usuarios u
      LEFT JOIN proveedores pr ON u.deposito_proveedor_id = pr.id
      LEFT JOIN personas p ON u.persona_id = p.id
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

// ─── FASE 2.C: ASIGNAR PASSWORD INICIAL (admin) ────────────────────────────
// El admin elige una contraseña genérica para el usuario.
// El usuario podrá entrar UNA VEZ con esa password y será forzado a cambiarla.
// Setea password_hash + debe_cambiar_password=1 + migrado_a_v2=0.
router.post('/asignar-password-inicial/:id', soloAdmin, async (req, res) => {
  const { password } = req.body || {};
  const userId = parseInt(req.params.id);
  if (!userId || !password) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  const db = getDb();
  try {
    const user = db.prepare('SELECT id, username, nombre FROM usuarios WHERE id = ? AND activo = 1').get(userId);
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });

    // Validar política (misma que setear-password)
    const error = validatePassword(password, user.username);
    if (error) return res.status(400).json({ ok: false, error });

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    db.prepare(`
      UPDATE usuarios
      SET password_hash = ?, debe_cambiar_password = 1, migrado_a_v2 = 0
      WHERE id = ?
    `).run(hash, userId);
    console.log(`[AUTH] Admin asignó password inicial a ${user.username || user.nombre}`);
    res.json({ ok: true, mensaje: `Password inicial asignada. ${user.nombre} deberá cambiarla al ingresar.` });
  } catch(e) {
    console.error('[AUTH] Error asignar-password-inicial:', e.message);
    res.status(500).json({ ok: false, error: 'Error al asignar contraseña' });
  }
});

// NOTA: El antiguo endpoint /resetear-password/:id se eliminó.
// Antes ponía password_hash = NULL para que el usuario volviera a entrar con PIN.
// Como ya no aceptamos PIN, ese flow no tiene sentido.
// Si el admin necesita "resetear" a un usuario, debe asignar una password inicial
// nueva vía POST /asignar-password-inicial/:id (el usuario será forzado a cambiarla).

// ─── RECUPERACIÓN DE CONTRASEÑA POR MAIL ────────────────────────────────────
// Flujo:
//   1. POST /solicitar-reset → genera token + manda mail (público, sin auth)
//   2. GET  /validar-token?token=X → la pantalla del link verifica antes de mostrar form
//   3. POST /resetear-con-token → recibe token + nueva pwd, valida, guarda
//
// Seguridad:
//   - Tokens de 32 bytes hex (criptográficamente seguros)
//   - Expiran en 1 hora
//   - Un solo uso (al usar se marca usado_en)
//   - Nunca revelar si un email existe en DB (anti-enumeration)

const TOKEN_TTL_HORAS = 1;

// POST /solicitar-reset — Genera token y manda mail
router.post('/solicitar-reset', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ ok: false, error: 'Email requerido' });

  // RESPUESTA UNIFORME: siempre devolvemos OK aunque el email no exista.
  // Esto evita que un atacante enumere mails válidos probando uno por uno.
  const respuestaUniforme = {
    ok: true,
    mensaje: 'Si el email está registrado, vas a recibir un link en tu casilla.'
  };

  try {
    const db = getDb();
    const user = db.prepare("SELECT id, nombre, username, email FROM usuarios WHERE LOWER(email) = ? AND activo = 1").get(email);
    if (!user) {
      // No existe → respondemos OK igual (sin hacer nada)
      console.log('[AUTH] Reset solicitado para email inexistente:', email);
      return res.json(respuestaUniforme);
    }

    // Purgar tokens vencidos para no acumular basura
    db.prepare("DELETE FROM password_reset_tokens WHERE expira_en < datetime('now')").run();

    // Invalidar tokens previos del mismo usuario (que no haya 2 válidos a la vez)
    db.prepare("UPDATE password_reset_tokens SET usado_en = datetime('now') WHERE usuario_id = ? AND usado_en IS NULL").run(user.id);

    // Generar token nuevo
    const token = crypto.randomBytes(32).toString('hex');
    const expiraEn = new Date(Date.now() + TOKEN_TTL_HORAS * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim() || null;

    db.prepare("INSERT INTO password_reset_tokens (token, usuario_id, expira_en, ip) VALUES (?, ?, ?, ?)").run(token, user.id, expiraEn, ip);

    // Armar link y mandar mail
    const link = `${PANEL_BASE_URL}/login.html?reset=${token}`;
    const nombre = user.nombre || user.username || 'usuario';
    const username = user.username || '—';

    const cuerpoHtml = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a2332">
        <div style="background:#0f2540;padding:24px;text-align:center;border-radius:8px 8px 0 0">
          <div style="color:#fff;font-size:22px;font-weight:bold">La Niña Bonita</div>
          <div style="color:#a8b5c8;font-size:12px;margin-top:4px;letter-spacing:1px">PANEL DE CONTROL</div>
        </div>
        <div style="background:#fff;padding:32px 24px;border:1px solid #dde3ea;border-top:none;border-radius:0 0 8px 8px">
          <h2 style="margin:0 0 16px;color:#1a3a5c;font-size:20px">🔑 Recuperar contraseña</h2>
          <p style="margin:0 0 12px;line-height:1.5">Hola <strong>${nombre}</strong>,</p>
          <p style="margin:0 0 12px;line-height:1.5">Recibimos una solicitud para restablecer la contraseña de tu cuenta (<code style="background:#f0f4f8;padding:2px 6px;border-radius:3px">${username}</code>) en el panel de La Niña Bonita.</p>
          <p style="margin:0 0 24px;line-height:1.5">Hacé click en el botón para elegir una nueva contraseña:</p>
          <div style="text-align:center;margin:28px 0">
            <a href="${link}" style="display:inline-block;background:#1a3a5c;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:bold;font-size:15px">Resetear contraseña →</a>
          </div>
          <p style="margin:24px 0 0;font-size:12px;color:#5a6a7e;line-height:1.5">
            Este link expira en <strong>1 hora</strong> y solo se puede usar una vez.<br>
            Si no fuiste vos quien lo pidió, ignorá este mail. Tu contraseña no se modifica.
          </p>
          <hr style="border:none;border-top:1px solid #dde3ea;margin:24px 0">
          <p style="margin:0;font-size:11px;color:#8a9bb0;text-align:center">
            ¿Problemas con el botón? Copiá este link en tu navegador:<br>
            <span style="word-break:break-all;color:#1a3a5c">${link}</span>
          </p>
        </div>
      </div>
    `;
    const cuerpoTexto =
      `Hola ${nombre},\n\n` +
      `Recibimos una solicitud para restablecer la contraseña de tu cuenta (${username}) en el panel de La Niña Bonita.\n\n` +
      `Para elegir una nueva contraseña, entrá a este link:\n${link}\n\n` +
      `Este link expira en 1 hora y solo se puede usar una vez.\n` +
      `Si no fuiste vos quien lo pidió, ignorá este mail. Tu contraseña no se modifica.\n\n` +
      `— ERP LNB`;

    const mailRes = await enviarMail({
      to: user.email,
      asunto: '🔑 Recuperá tu contraseña — La Niña Bonita',
      cuerpo_html: cuerpoHtml,
      cuerpo_texto: cuerpoTexto
    });

    if (!mailRes.success) {
      console.error('[AUTH] Error enviando mail de reset a', user.email, ':', mailRes.error);
      // Igual devolvemos OK al cliente (no revelamos errores internos)
    } else {
      console.log('[AUTH] Mail de reset enviado a', user.email, '· messageId:', mailRes.messageId);
    }

    res.json(respuestaUniforme);
  } catch(e) {
    console.error('[AUTH] Error solicitar-reset:', e.message);
    // Igual devolvemos OK uniforme al cliente
    res.json(respuestaUniforme);
  }
});

// GET /validar-token?token=X — Verifica si un token es válido (público)
// Lo usa la pantalla del link antes de mostrar el form de nueva password.
router.get('/validar-token', (req, res) => {
  const token = String(req.query?.token || '').trim();
  if (!token || token.length < 32) return res.json({ ok: false, error: 'Token inválido' });
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT prt.usuario_id, prt.expira_en, prt.usado_en,
             u.nombre, u.username, u.activo
      FROM password_reset_tokens prt
      LEFT JOIN usuarios u ON prt.usuario_id = u.id
      WHERE prt.token = ?
    `).get(token);
    if (!row) return res.json({ ok: false, error: 'Link inválido o no encontrado' });
    if (row.usado_en) return res.json({ ok: false, error: 'Este link ya fue utilizado' });
    if (new Date(row.expira_en) < new Date()) return res.json({ ok: false, error: 'Este link expiró. Solicitá uno nuevo.' });
    if (!row.activo) return res.json({ ok: false, error: 'La cuenta está dada de baja' });
    res.json({ ok: true, nombre: row.nombre, username: row.username });
  } catch(e) {
    console.error('[AUTH] Error validar-token:', e.message);
    res.status(500).json({ ok: false, error: 'Error al validar el link' });
  }
});

// POST /resetear-con-token — Recibe token + nueva password, valida, guarda
router.post('/resetear-con-token', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const password = req.body?.password;
  if (!token || !password) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT prt.usuario_id, prt.expira_en, prt.usado_en,
             u.username, u.activo
      FROM password_reset_tokens prt
      LEFT JOIN usuarios u ON prt.usuario_id = u.id
      WHERE prt.token = ?
    `).get(token);
    if (!row) return res.status(400).json({ ok: false, error: 'Link inválido' });
    if (row.usado_en) return res.status(400).json({ ok: false, error: 'Este link ya fue utilizado' });
    if (new Date(row.expira_en) < new Date()) return res.status(400).json({ ok: false, error: 'Este link expiró' });
    if (!row.activo) return res.status(400).json({ ok: false, error: 'Cuenta dada de baja' });

    // Validar política de password (misma que setear-password)
    const error = validatePassword(password, row.username);
    if (error) return res.status(400).json({ ok: false, error });

    // Hashear y guardar
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    db.prepare("UPDATE usuarios SET password_hash = ?, migrado_a_v2 = 1, debe_cambiar_password = 0 WHERE id = ?")
      .run(hash, row.usuario_id);
    // Marcar token como usado
    db.prepare("UPDATE password_reset_tokens SET usado_en = datetime('now') WHERE token = ?").run(token);
    console.log('[AUTH] Password reseteada vía mail para usuario_id', row.usuario_id);
    res.json({ ok: true, mensaje: 'Contraseña actualizada. Ya podés ingresar con tu nueva contraseña.' });
  } catch(e) {
    console.error('[AUTH] Error resetear-con-token:', e.message);
    res.status(500).json({ ok: false, error: 'Error al actualizar la contraseña' });
  }
});

export default router;
