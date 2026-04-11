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
    INSERT INTO clientes (telefono, tipo, nombre, empresa, email, direccion, zona, notas, codigo_abasto, metodo_pago)
    VALUES (@telefono, @tipo, @nombre, @empresa, @email, @direccion, @zona, @notas, @codigo_abasto, @metodo_pago)
  `);
  stmt.run({
    ...datos,
    codigo_abasto: datos.codigo_abasto || null,
    metodo_pago:   datos.metodo_pago   || 'cuenta_corriente',
  });
  return obtenerCliente(datos.telefono);
}

export function actualizarCliente(telefono, datos) {
  const campos = Object.keys(datos).map(k => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE clientes SET ${campos} WHERE telefono = @telefono`)
    .run({ ...datos, telefono });
}

export function listarClientes(tipo, excluirCancelados) {
  const condCancelado = excluirCancelados
    ? " AND (metodo_pago IS NULL OR metodo_pago != 'cancelado')"
    : "";
  const query = tipo
    ? "SELECT * FROM clientes WHERE tipo = ? AND activo = 1" + condCancelado + " ORDER BY nombre"
    : "SELECT * FROM clientes WHERE activo = 1" + condCancelado + " ORDER BY tipo, nombre";
  return tipo ? db.prepare(query).all(tipo) : db.prepare(query).all();
}

// Valida si un cliente puede comprar segun su metodo de pago
export function validarPuedeComprar(telefono) {
  const c = obtenerCliente(telefono);
  if (!c) return { puede: true, motivo: null };
  if (c.metodo_pago === 'cancelado') {
    return { puede: false, motivo: 'cuenta_cancelada' };
  }
  return { puede: true, motivo: null, metodo: c.metodo_pago || 'cuenta_corriente' };
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

// ── Migracion: agregar columnas nuevas si no existen ───────────────────────
(function migrar() {
  var cols = db.prepare("PRAGMA table_info(clientes)").all().map(function(c){ return c.name; });
  if (cols.indexOf('codigo_abasto') < 0) {
    db.exec("ALTER TABLE clientes ADD COLUMN codigo_abasto TEXT");
    console.log("[DB] Columna codigo_abasto agregada");
  }
  if (cols.indexOf('metodo_pago') < 0) {
    db.exec("ALTER TABLE clientes ADD COLUMN metodo_pago TEXT DEFAULT 'cuenta_corriente'");
    console.log("[DB] Columna metodo_pago agregada");
  }
})();

// ── Facturas y cobranza ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS facturas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id       INTEGER,
    telefono        TEXT NOT NULL,
    tipo_cliente    TEXT NOT NULL,
    numero_factura  TEXT,
    archivo_path    TEXT NOT NULL,
    nombre_archivo  TEXT,
    fecha_emision   TEXT DEFAULT (date('now','localtime')),
    fecha_vencimiento TEXT,
    monto           REAL,
    estado          TEXT DEFAULT 'subida' CHECK(estado IN ('subida','enviada','pagada','vencida')),
    notas           TEXT,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );
`);

export function crearFactura(datos) {
  return db.prepare(`
    INSERT INTO facturas (pedido_id, telefono, tipo_cliente, numero_factura,
      archivo_path, nombre_archivo, fecha_vencimiento, monto, notas)
    VALUES (@pedido_id, @telefono, @tipo_cliente, @numero_factura,
      @archivo_path, @nombre_archivo, @fecha_vencimiento, @monto, @notas)
  `).run(datos).lastInsertRowid;
}

export function listarFacturas(filtros) {
  filtros = filtros || {};
  var query = "SELECT f.*, c.nombre as cliente_nombre FROM facturas f LEFT JOIN clientes c ON c.telefono = f.telefono WHERE 1=1";
  var params = [];
  if (filtros.estado)       { query += " AND f.estado = ?";        params.push(filtros.estado); }
  if (filtros.tipo_cliente) { query += " AND f.tipo_cliente = ?";   params.push(filtros.tipo_cliente); }
  if (filtros.telefono)     { query += " AND f.telefono = ?";       params.push(filtros.telefono); }
  query += " ORDER BY f.creado_en DESC";
  return db.prepare(query).all(...params);
}

export function actualizarEstadoFactura(id, estado, notas) {
  db.prepare("UPDATE facturas SET estado = ?, notas = COALESCE(?, notas) WHERE id = ?").run(estado, notas || null, id);
}

export function obtenerFactura(id) {
  return db.prepare("SELECT * FROM facturas WHERE id = ?").get(id);
}

export function resumenCobranza() {
  return db.prepare(`
    SELECT
      estado,
      COUNT(*) as cantidad,
      SUM(monto) as total
    FROM facturas
    WHERE tipo_cliente IN ('mayorista_b','minorista','food_service')
    GROUP BY estado
  `).all();
}
