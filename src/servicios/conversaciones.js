// Gestión de conversaciones activas y comandos internos del equipo
import { obtenerSesion, guardarSesion, listarClientes } from "./db.js";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "../../data/clientes.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ── Esquema adicional ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS conversaciones (
    telefono       TEXT PRIMARY KEY,
    tipo_cliente   TEXT,
    nombre         TEXT,
    estado         TEXT DEFAULT 'activo',
    requiere_atencion INTEGER DEFAULT 0,
    motivo_atencion   TEXT,
    pausado_por    TEXT,
    instruccion_pendiente TEXT,
    ultimo_mensaje TEXT,
    actualizado    TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS instrucciones (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono     TEXT NOT NULL,
    tipo         TEXT NOT NULL,
    contenido    TEXT NOT NULL,
    autor        TEXT NOT NULL,
    aplicada     INTEGER DEFAULT 0,
    creado_en    TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── Conversaciones ─────────────────────────────────────────────────────────

export function registrarActividad(telefono, tipoCliente, nombre, ultimoMensaje) {
  db.prepare(`
    INSERT INTO conversaciones (telefono, tipo_cliente, nombre, ultimo_mensaje, actualizado)
    VALUES (?, ?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(telefono) DO UPDATE SET
      ultimo_mensaje = excluded.ultimo_mensaje,
      actualizado    = excluded.actualizado,
      tipo_cliente   = COALESCE(excluded.tipo_cliente, tipo_cliente),
      nombre         = COALESCE(excluded.nombre, nombre)
  `).run(telefono, tipoCliente, nombre, ultimoMensaje);
}

export function marcarRequiereAtencion(telefono, motivo) {
  db.prepare(`
    UPDATE conversaciones SET requiere_atencion = 1, motivo_atencion = ?,
    actualizado = datetime('now','localtime') WHERE telefono = ?
  `).run(motivo, telefono);
}

export function limpiarAtencion(telefono) {
  db.prepare(`
    UPDATE conversaciones SET requiere_atencion = 0, motivo_atencion = NULL,
    instruccion_pendiente = NULL WHERE telefono = ?
  `).run(telefono);
}

export function pausarConversacion(telefono, autor) {
  db.prepare(`
    UPDATE conversaciones SET estado = 'pausado', pausado_por = ?,
    actualizado = datetime('now','localtime') WHERE telefono = ?
  `).run(autor, telefono);
}

export function reactivarConversacion(telefono) {
  db.prepare(`
    UPDATE conversaciones SET estado = 'activo', pausado_por = NULL,
    instruccion_pendiente = NULL, requiere_atencion = 0, motivo_atencion = NULL,
    actualizado = datetime('now','localtime') WHERE telefono = ?
  `).run(telefono);
}

export function estaActiva(telefono) {
  const row = db.prepare("SELECT estado FROM conversaciones WHERE telefono = ?").get(telefono);
  return !row || row.estado === 'activo';
}

export function listarConversaciones(filtro) {
  let query = "SELECT * FROM conversaciones WHERE 1=1";
  const params = [];
  if (filtro === 'atencion') { query += " AND requiere_atencion = 1"; }
  else if (filtro === 'pausadas') { query += " AND estado = 'pausado'"; }
  query += " ORDER BY requiere_atencion DESC, actualizado DESC";
  return db.prepare(query).all(...params);
}

export function obtenerConversacion(telefono) {
  return db.prepare("SELECT * FROM conversaciones WHERE telefono = ?").get(telefono);
}

// ── Instrucciones del equipo ───────────────────────────────────────────────

export function agregarInstruccion(telefono, tipo, contenido, autor) {
  const id = db.prepare(`
    INSERT INTO instrucciones (telefono, tipo, contenido, autor)
    VALUES (?, ?, ?, ?)
  `).run(telefono, tipo, contenido, autor).lastInsertRowid;

  // Guardar como pendiente en la conversación
  db.prepare(`
    UPDATE conversaciones SET instruccion_pendiente = ?, requiere_atencion = 0,
    actualizado = datetime('now','localtime') WHERE telefono = ?
  `).run(contenido, telefono);

  return id;
}

export function obtenerInstruccionPendiente(telefono) {
  const conv = db.prepare("SELECT instruccion_pendiente FROM conversaciones WHERE telefono = ?").get(telefono);
  return conv?.instruccion_pendiente || null;
}

export function marcarInstruccionAplicada(telefono) {
  db.prepare("UPDATE conversaciones SET instruccion_pendiente = NULL WHERE telefono = ?").run(telefono);
  db.prepare(`
    UPDATE instrucciones SET aplicada = 1 WHERE telefono = ? AND aplicada = 0
  `).run(telefono);
}

export function historialInstrucciones(telefono) {
  return db.prepare(`
    SELECT * FROM instrucciones WHERE telefono = ? ORDER BY creado_en DESC LIMIT 20
  `).all(telefono);
}
