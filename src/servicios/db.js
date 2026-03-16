import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../../data/clientes.db");

// Asegurar que existe el directorio de datos
import fs from "fs";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ── Esquema ────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    telefono     TEXT PRIMARY KEY,
    tipo         TEXT NOT NULL CHECK(tipo IN ('mayorista','mayorista_b','minorista','food_service')),
    nombre       TEXT,
    empresa      TEXT,
    email        TEXT,
    direccion    TEXT,
    zona         TEXT,
    horario_entrega TEXT,
    cuenta_corriente INTEGER DEFAULT 0,
    activo       INTEGER DEFAULT 1,
    creado_en    TEXT DEFAULT (datetime('now','localtime')),
    notas        TEXT
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    telefono     TEXT PRIMARY KEY,
    mensajes     TEXT NOT NULL DEFAULT '[]',
    estado       TEXT DEFAULT 'activo',
    actualizado  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS pedidos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono     TEXT NOT NULL,
    tipo_cliente TEXT NOT NULL,
    detalle      TEXT NOT NULL,
    total        REAL,
    estado       TEXT DEFAULT 'pendiente',
    horario_entrega TEXT,
    creado_en    TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── Clientes ───────────────────────────────────────────────────────────────
export function obtenerCliente(telefono) {
  return db.prepare("SELECT * FROM clientes WHERE telefono = ?").get(telefono);
}

export function crearCliente(datos) {
  const stmt = db.prepare(`
    INSERT INTO clientes (telefono, tipo, nombre, empresa, email, direccion, zona, notas)
    VALUES (@telefono, @tipo, @nombre, @empresa, @email, @direccion, @zona, @notas)
  `);
  stmt.run(datos);
  return obtenerCliente(datos.telefono);
}

export function actualizarCliente(telefono, datos) {
  const campos = Object.keys(datos).map(k => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE clientes SET ${campos} WHERE telefono = @telefono`)
    .run({ ...datos, telefono });
}

export function listarClientes(tipo) {
  const query = tipo
    ? "SELECT * FROM clientes WHERE tipo = ? AND activo = 1 ORDER BY nombre"
    : "SELECT * FROM clientes WHERE activo = 1 ORDER BY tipo, nombre";
  return tipo ? db.prepare(query).all(tipo) : db.prepare(query).all();
}

// ── Sesiones ───────────────────────────────────────────────────────────────
export function obtenerSesion(telefono) {
  const row = db.prepare("SELECT * FROM sesiones WHERE telefono = ?").get(telefono);
  if (!row) return { telefono, mensajes: [] };
  return { ...row, mensajes: JSON.parse(row.mensajes) };
}

export function guardarSesion(telefono, mensajes) {
  db.prepare(`
    INSERT INTO sesiones (telefono, mensajes, actualizado)
    VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(telefono) DO UPDATE SET
      mensajes = excluded.mensajes,
      actualizado = excluded.actualizado
  `).run(telefono, JSON.stringify(mensajes));
}

export function limpiarSesion(telefono) {
  db.prepare("DELETE FROM sesiones WHERE telefono = ?").run(telefono);
}

// ── Pedidos ────────────────────────────────────────────────────────────────
export function crearPedido(datos) {
  const result = db.prepare(`
    INSERT INTO pedidos (telefono, tipo_cliente, detalle, total, horario_entrega)
    VALUES (@telefono, @tipo_cliente, @detalle, @total, @horario_entrega)
  `).run(datos);
  return result.lastInsertRowid;
}

export function listarPedidos(filtros = {}) {
  let query = "SELECT * FROM pedidos WHERE 1=1";
  const params = [];
  if (filtros.tipo_cliente) { query += " AND tipo_cliente = ?"; params.push(filtros.tipo_cliente); }
  if (filtros.estado)       { query += " AND estado = ?";       params.push(filtros.estado); }
  if (filtros.fecha)        { query += " AND date(creado_en) = ?"; params.push(filtros.fecha); }
  query += " ORDER BY creado_en DESC";
  return db.prepare(query).all(...params);
}

export function actualizarEstadoPedido(id, estado) {
  db.prepare("UPDATE pedidos SET estado = ? WHERE id = ?").run(estado, id);
}

export default db;
