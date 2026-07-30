// src/servicios/auth_sesion.js
// ════════════════════════════════════════════════════════════════════════════
// IDENTIDAD FIRMADA — cierra la escalada de privilegios de la cookie lnb_user
// ════════════════════════════════════════════════════════════════════════════
//
// EL PROBLEMA
// La cookie `lnb_user` es JSON plano, sin firma, y se emite con httpOnly:false
// (auth.js:58) para que scout.html pueda leerla desde el navegador. Pero unos 30
// endpoints autorizan directamente contra ella:
//
//   if (!req.user || req.user.rol !== 'admin') return res.status(403)...
//
// (org.js:24, admin.js:18, sg.js:59, produccion.js:31, ifco.js en ~20 lugares, y
// el propio bloquearSiSoloLectura en auth.js:372).
//
// Como el usuario puede editar su propia cookie desde la consola del navegador,
// alcanzaba con poner "rol":"admin" —o con poner el id de otro usuario— para
// obtener admin en todos esos endpoints, y para saltear el bloqueo de solo lectura.
//
// LA SOLUCIÓN, EN UN SOLO PUNTO
// Se emite una SEGUNDA cookie, `lnb_auth`, que va FIRMADA y httpOnly, y que solo
// contiene el id del usuario. Un middleware global:
//
//   1. lee `lnb_auth` de req.signedCookies (si la firma no valida, cookie-parser
//      no la expone ahí, así que una cookie falsificada simplemente no existe);
//   2. relee el usuario de la base por ese id;
//   3. REESCRIBE req.cookies.lnb_user con los datos verdaderos.
//
// Así los ~30 endpoints que hacen JSON.parse(req.cookies.lnb_user) siguen
// funcionando sin tocar una línea, pero ahora leen rol e id verificados contra la
// base. Y si NO hay identidad firmada válida, se borra req.cookies.lnb_user: una
// cookie falsificada deja de existir para el backend.
//
// La cookie `lnb_user` se sigue emitiendo igual que antes (sin firmar, legible por
// JS) porque scout.html:1498 la lee. Pasa a ser solo de presentación: el backend
// ya no le cree nada.
//
// NADA SE HEREDA DE LA COOKIE
// La identidad se arma SOLO con la fila de la base. No se hace spread del JSON que
// vino en lnb_user: si se heredara, cualquier clave fuera de la lista sobreviviría
// tal como la escribió el usuario y viajaría como si fuera identidad verificada.
// Y no es hipotético: `secciones` SÍ autoriza del lado del server —
// produccion.js:2516 permite registrar cargas de combustible en estación con
// `u.secciones.includes(...)`— así que también se relee de la base.
// Para los honestos no cambia nada: la cookie ya traía el valor de la base
// (auth.js la emite con parseSecciones(user.secciones) al loguear). Lo único que
// deja de funcionar es editarla a mano.
//
// LÍMITE CONOCIDO (documentado a propósito, no olvidado)
// No hay revocación del lado del server: una cookie robada sirve hasta que expira
// (1 día en desktop, 30 en móvil). Para revocar haría falta una tabla de sesiones o
// una columna de época en usuarios; queda como paso siguiente.

import crypto from 'crypto';
import { getDb } from './db.js';

// ── Secreto de firma ──────────────────────────────────────────────────────
// Se guarda en la base y no en una variable de entorno a propósito: la base vive
// en el volumen persistente de Railway, así que el secreto sobrevive los deploys
// sin que nadie tenga que configurar nada. Con un secreto de entorno faltante o
// regenerado en cada arranque, todas las sesiones se caerían en cada deploy.
let _secreto = null;

export function cookieSecret() {
  if (_secreto) return _secreto;
  try {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_config (
        clave     TEXT PRIMARY KEY,
        valor     TEXT NOT NULL,
        creado_en TEXT DEFAULT (datetime('now','localtime'))
      );
    `);
    const fila = db.prepare("SELECT valor FROM auth_config WHERE clave='cookie_secret'").get();
    if (fila && fila.valor) {
      _secreto = fila.valor;
    } else {
      _secreto = crypto.randomBytes(48).toString('hex');
      db.prepare("INSERT OR REPLACE INTO auth_config (clave, valor) VALUES ('cookie_secret', ?)").run(_secreto);
      console.log('[AUTH] Secreto de firma de cookies generado y guardado');
    }
  } catch (e) {
    // Nunca tumbar el arranque: sin secreto persistido se usa uno efímero, que
    // invalida las sesiones en cada reinicio pero deja la app funcionando.
    console.error('[AUTH] No se pudo persistir el secreto de cookies:', e.message);
    _secreto = _secreto || crypto.randomBytes(48).toString('hex');
  }
  return _secreto;
}

// ── Opciones de la cookie de identidad ────────────────────────────────────
// httpOnly y signed, al revés de lnb_user. maxAge lo decide el caller para que
// coincida con el de lnb_user (30 días en móvil, 1 día en desktop).
export function authCookieOpts(maxAge) {
  return { httpOnly: true, signed: true, sameSite: 'lax', path: '/', maxAge };
}

export const AUTH_COOKIE = 'lnb_auth';

// ── Middleware ────────────────────────────────────────────────────────────
// Se monta después de cookieParser(secreto) y ANTES de cualquier router y del
// guard de solo lectura, porque todos ellos leen req.cookies.lnb_user.

const CAMPOS_DB = `id, nombre, email, rol, username, activo, solo_lectura,
                   deposito_tipo, deposito_proveedor_id, secciones, depositos`;

// Mismos defaults que auth.js, para no cambiarle el comportamiento a los usuarios
// que todavía no tienen el campo seteado.
const parseSecciones = (s) => { try { return JSON.parse(s || '["*"]'); } catch (e) { return ['*']; } };
const parseDepositos = (s) => {
  try { return JSON.parse(s || '["MCBA","FINCA","SAN PEDRO"]'); }
  catch (e) { return ['MCBA', 'FINCA', 'SAN PEDRO']; }
};

export function sesionFirmada(req, res, next) {
  const descartar = () => {
    // Sin identidad firmada válida, la cookie de presentación no autoriza nada.
    if (req.cookies && req.cookies.lnb_user !== undefined) delete req.cookies.lnb_user;
  };

  try {
    const firmado = req.signedCookies ? req.signedCookies[AUTH_COOKIE] : null;
    const id = firmado !== undefined && firmado !== null && firmado !== false
      ? parseInt(String(firmado), 10) : NaN;
    if (!Number.isInteger(id) || id <= 0) { descartar(); return next(); }

    const u = getDb().prepare(`SELECT ${CAMPOS_DB} FROM usuarios WHERE id = ?`).get(id);
    if (!u || !u.activo) { descartar(); return next(); }

    // Se arma DESDE CERO con la fila de la base. Sin spread de la cookie: cualquier
    // clave heredada de ahí sería forjable y viajaría como identidad verificada.
    req.cookies = req.cookies || {};
    req.cookies.lnb_user = JSON.stringify({
      id: u.id,
      nombre: u.nombre,
      email: u.email,
      rol: u.rol,
      username: u.username || null,
      solo_lectura: !!u.solo_lectura,
      deposito_tipo: u.deposito_tipo || null,
      deposito_proveedor_id: u.deposito_proveedor_id || null,
      secciones: parseSecciones(u.secciones),
      depositos: parseDepositos(u.depositos)
    });
    // Para quien quiera la fila cruda sin volver a consultar.
    req.usuarioDb = u;
  } catch (e) {
    console.error('[AUTH][sesionFirmada]', e.message);
    descartar();
  }
  next();
}

export default sesionFirmada;
