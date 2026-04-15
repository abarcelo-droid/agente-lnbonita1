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
    tipo         TEXT NOT NULL CHECK(tipo IN ('mayorista_a','mayorista_mcba','minorista_mcba','minorista_entrega','dedicados','food_service','consumidor_final','nuevo')),
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
    : "SELECT * FROM clientes WHERE activo = 1 AND tipo != 'nuevo'" + condCancelado + " ORDER BY tipo, nombre";
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

// ── CRM Dedicados ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS crm_clientes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono        TEXT NOT NULL,
    comercial       TEXT NOT NULL,
    situacion       TEXT DEFAULT 'pendiente' CHECK(situacion IN ('pendiente','enviado','venta','fallido')),
    dias_contacto   TEXT DEFAULT '[]',
    tipo_oferta     TEXT DEFAULT 'mayorista_mcba',
    notas           TEXT,
    ultima_gestion  TEXT DEFAULT (date('now','localtime')),
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// Migracion crm_clientes
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(crm_clientes)").all().map(c => c.name);
    if (!cols.includes('tipo_oferta')) {
      db.exec("ALTER TABLE crm_clientes ADD COLUMN tipo_oferta TEXT DEFAULT 'mayorista_mcba'");
    }
  } catch(e) {}
})();

export function listarCRM(comercial) {
  const hoy = new Date();
  const diasSemana = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
  const diaHoy = diasSemana[hoy.getDay()];

  // Auto-reset: clientes que hoy les toca y están en venta/fallido → pendiente
  const todos = db.prepare("SELECT * FROM crm_clientes WHERE activo = 1 OR activo IS NULL").all();
  todos.forEach(function(c) {
    if (c.situacion === 'venta' || c.situacion === 'fallido') {
      const dias = JSON.parse(c.dias_contacto || '[]');
      if (dias.includes(diaHoy) && c.ultima_gestion !== hoy.toISOString().slice(0,10)) {
        db.prepare("UPDATE crm_clientes SET situacion='pendiente', ultima_gestion=? WHERE id=?")
          .run(hoy.toISOString().slice(0,10), c.id);
      }
    }
  });

  const query = comercial
    ? "SELECT cr.*, c.nombre, c.empresa, c.telefono as tel FROM crm_clientes cr LEFT JOIN clientes c ON c.telefono = cr.telefono WHERE cr.comercial = ? ORDER BY cr.situacion, c.nombre"
    : "SELECT cr.*, c.nombre, c.empresa, c.telefono as tel FROM crm_clientes cr LEFT JOIN clientes c ON c.telefono = cr.telefono ORDER BY cr.comercial, cr.situacion, c.nombre";
  return comercial ? db.prepare(query).all(comercial) : db.prepare(query).all();
}

export function upsertCRM(datos) {
  const existe = db.prepare("SELECT id FROM crm_clientes WHERE telefono = ?").get(datos.telefono);
  if (existe) {
    db.prepare(`UPDATE crm_clientes SET comercial=?, dias_contacto=?, tipo_oferta=?, notas=? WHERE telefono=?`)
      .run(datos.comercial, JSON.stringify(datos.dias_contacto||[]), datos.tipo_oferta||'mayorista_mcba', datos.notas||null, datos.telefono);
  } else {
    db.prepare(`INSERT INTO crm_clientes (telefono, comercial, dias_contacto, tipo_oferta, notas) VALUES (?,?,?,?,?)`)
      .run(datos.telefono, datos.comercial, JSON.stringify(datos.dias_contacto||[]), datos.tipo_oferta||'mayorista_mcba', datos.notas||null);
  }
}

export function actualizarSituacionCRM(id, situacion) {
  const hoy = new Date().toISOString().slice(0,10);
  db.prepare("UPDATE crm_clientes SET situacion=?, ultima_gestion=? WHERE id=?").run(situacion, hoy, id);
}

export function obtenerCRM(telefono) {
  return db.prepare("SELECT * FROM crm_clientes WHERE telefono = ?").get(telefono);
}
