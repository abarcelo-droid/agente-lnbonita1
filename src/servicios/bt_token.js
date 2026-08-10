// src/servicios/bt_token.js
// ── LA LLAVE DEL AGENTE DE SINCRONIZACIÓN ─────────────────────────────────
//
// POR QUÉ EXISTE
// El agente (scripts/bt_sync.py) corre solo, en el servidor de Transoft, todas las
// noches. Hasta ahora se esperaba que se autenticara con la cookie de sesión de una
// persona, y eso no funciona: la cookie de escritorio dura UN DÍA. Al día siguiente
// el agente devuelve 401 y hay que entrar por escritorio remoto a copiar una cookie
// nueva del navegador. Un proceso desatendido no puede depender de eso.
//
// QUÉ ABRE Y QUÉ NO
// Solo POST /api/bt/sync y /api/bt/sync/cerrar. Con esta llave no se ve un viaje,
// no se lista un cliente y no se opera nada: sirve para empujar datos al espejo y
// nada más. Si el servidor de Transoft se ve comprometido, lo que se pierde es la
// capacidad de escribir en el espejo —que se pisa entero en cada sincronización—,
// no el acceso al ERP.
//
// CÓMO SE MANEJA
//   · Se genera con `node scripts/bt_token.mjs "servidor Transoft"`.
//   · Se muestra UNA sola vez. En la base queda el hash, no el token.
//   · Se pega en bt_sync_config.json, en el servidor. NUNCA por chat ni por mail.
//   · Si se filtra, se revoca y se genera otro: el agente es el único que lo usa.
import crypto from 'crypto';
import db from './db.js';
import './db_bt_op.js';   // la tabla bt_sync_tokens vive ahí

const PREFIJO = 'btsync_';

function hashDe(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

// 32 bytes de aleatoriedad criptográfica. base64url para que entre en un header
// sin escaparse ni cortarse al copiar y pegar.
export function generarToken(nombre, creadoPor = null) {
  const token = PREFIJO + crypto.randomBytes(32).toString('base64url');
  db.prepare(
    'INSERT INTO bt_sync_tokens (nombre, token_hash, creado_por) VALUES (?,?,?)'
  ).run(String(nombre || 'agente'), hashDe(token), creadoPor);
  return token;   // la única vez que existe en texto plano
}

// Devuelve la fila del token si es válido, o null. Registra el uso: es lo que
// después permite contestar "¿el agente sigue corriendo?" sin adivinar.
export function verificarToken(token, ip = null) {
  if (!token || typeof token !== 'string') return null;
  if (!token.startsWith(PREFIJO)) return null;   // corta antes de tocar la base

  const fila = db.prepare(
    'SELECT * FROM bt_sync_tokens WHERE token_hash = ? AND revocado_en IS NULL'
  ).get(hashDe(token));
  if (!fila) return null;

  try {
    db.prepare(
      `UPDATE bt_sync_tokens
          SET ultimo_uso_en = datetime('now','localtime'), ultima_ip = ?, usos = usos + 1
        WHERE id = ?`
    ).run(ip, fila.id);
  } catch { /* que no falle la sincronización por no poder anotar el uso */ }

  return fila;
}

export function revocarToken(id) {
  return db.prepare(
    "UPDATE bt_sync_tokens SET revocado_en = datetime('now','localtime') WHERE id = ? AND revocado_en IS NULL"
  ).run(id).changes > 0;
}

// Para mostrar en pantalla: nunca incluye el token ni el hash.
export function listarTokens() {
  return db.prepare(
    `SELECT id, nombre, creado_en, creado_por, ultimo_uso_en, ultima_ip, usos, revocado_en
       FROM bt_sync_tokens ORDER BY id DESC`
  ).all();
}

export default { generarToken, verificarToken, revocarToken, listarTokens };
