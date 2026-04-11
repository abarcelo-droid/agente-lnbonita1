// Extensión del esquema para los módulos nuevos
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "../../data/clientes.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  -- Comerciales del equipo
  CREATE TABLE IF NOT EXISTS comerciales (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre   TEXT NOT NULL,
    email    TEXT,
    telefono TEXT,
    activo   INTEGER DEFAULT 1
  );

  -- Turnos base semanales (lun-dom x franja horaria)
  CREATE TABLE IF NOT EXISTS turnos_base (
    comercial_id INTEGER NOT NULL,
    dia_semana   INTEGER NOT NULL, -- 0=lun ... 6=dom
    franja       TEXT NOT NULL,    -- "manana" | "tarde" | "noche"
    PRIMARY KEY (comercial_id, dia_semana, franja)
  );

  -- Guardias reales (calendario)
  CREATE TABLE IF NOT EXISTS guardias (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    comercial_id INTEGER NOT NULL,
    fecha        TEXT NOT NULL,   -- YYYY-MM-DD
    franja       TEXT NOT NULL,   -- "manana" | "tarde" | "noche"
    estado       TEXT DEFAULT 'asignado', -- asignado | confirmado | cubierto
    nota         TEXT,
    creado_en    TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(fecha, franja)
  );

  -- Catálogo editable con fotos (mayorista A y B)
  CREATE TABLE IF NOT EXISTS catalogo_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo         TEXT NOT NULL CHECK(tipo IN ('mayorista','mayorista_b')),
    codigo       TEXT NOT NULL,
    nombre       TEXT NOT NULL,
    descripcion  TEXT,
    precio       REAL,
    unidad       TEXT,
    stock        INTEGER DEFAULT 1,
    foto_path    TEXT,
    notas        TEXT,
    activo       INTEGER DEFAULT 1,
    actualizado  TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(tipo, codigo)
  );

  -- Facturas adjuntas a pedidos
  CREATE TABLE IF NOT EXISTS facturas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id    INTEGER NOT NULL,
    archivo_path TEXT NOT NULL,
    nombre       TEXT,
    enviada      INTEGER DEFAULT 0,
    creado_en    TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── Comerciales ────────────────────────────────────────────────────────────
export function listarComerciales() {
  return db.prepare("SELECT * FROM comerciales WHERE activo = 1 ORDER BY nombre").all();
}
export function crearComercial(datos) {
  return db.prepare("INSERT INTO comerciales (nombre, email, telefono) VALUES (@nombre, @email, @telefono)").run(datos);
}
export function actualizarComercial(id, datos) {
  const campos = Object.keys(datos).map(k => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE comerciales SET ${campos} WHERE id = @id`).run({ ...datos, id });
}

// ── Turnos base ────────────────────────────────────────────────────────────
export function obtenerTurnosBase(comercialId) {
  return db.prepare("SELECT * FROM turnos_base WHERE comercial_id = ?").all(comercialId);
}
export function guardarTurnoBase(comercialId, diaSemana, franja, activo) {
  if (activo) {
    db.prepare("INSERT OR IGNORE INTO turnos_base (comercial_id, dia_semana, franja) VALUES (?,?,?)").run(comercialId, diaSemana, franja);
  } else {
    db.prepare("DELETE FROM turnos_base WHERE comercial_id=? AND dia_semana=? AND franja=?").run(comercialId, diaSemana, franja);
  }
}

// ── Guardias ───────────────────────────────────────────────────────────────
export function obtenerGuardias(desde, hasta) {
  return db.prepare(`
    SELECT g.*, c.nombre as comercial_nombre
    FROM guardias g JOIN comerciales c ON c.id = g.comercial_id
    WHERE g.fecha BETWEEN ? AND ? ORDER BY g.fecha, g.franja
  `).all(desde, hasta);
}
export function asignarGuardia(comercialId, fecha, franja, nota) {
  return db.prepare(`
    INSERT INTO guardias (comercial_id, fecha, franja, nota)
    VALUES (?,?,?,?)
    ON CONFLICT(fecha, franja) DO UPDATE SET comercial_id=excluded.comercial_id, nota=excluded.nota
  `).run(comercialId, fecha, franja, nota || null);
}
export function comercialDeGuardia() {
  const ahora  = new Date();
  const fecha  = ahora.toISOString().slice(0, 10);
  const hora   = ahora.getHours();
  const franja = hora >= 8 && hora < 16 ? 'manana' : hora >= 16 ? 'tarde' : 'noche';
  return db.prepare(`
    SELECT g.*, c.nombre, c.telefono FROM guardias g
    JOIN comerciales c ON c.id = g.comercial_id
    WHERE g.fecha = ? AND g.franja = ?
  `).get(fecha, franja);
}
export function generarGuardiasDesdeBase(semanaInicio) {
  const comerciales = listarComerciales();
  const dias = 7;
  const start = new Date(semanaInicio);
  const insertados = [];
  for (let d = 0; d < dias; d++) {
    const fecha = new Date(start);
    fecha.setDate(start.getDate() + d);
    const fechaStr  = fecha.toISOString().slice(0, 10);
    const diaSemana = fecha.getDay() === 0 ? 6 : fecha.getDay() - 1; // lun=0
    for (const com of comerciales) {
      const turnos = obtenerTurnosBase(com.id);
      for (const t of turnos) {
        if (t.dia_semana === diaSemana) {
          asignarGuardia(com.id, fechaStr, t.franja, null);
          insertados.push({ comercial: com.nombre, fecha: fechaStr, franja: t.franja });
        }
      }
    }
  }
  return insertados;
}

// ── Catálogo editable ──────────────────────────────────────────────────────
export function listarCatalogoEditable(tipo) {
  return db.prepare("SELECT * FROM catalogo_items WHERE tipo = ? ORDER BY codigo").all(tipo);
}
export function upsertCatalogoItem(datos) {
  return db.prepare(`
    INSERT INTO catalogo_items (tipo, codigo, nombre, descripcion, precio, unidad, stock, foto_path, notas)
    VALUES (@tipo, @codigo, @nombre, @descripcion, @precio, @unidad, @stock, @foto_path, @notas)
    ON CONFLICT(tipo, codigo) DO UPDATE SET
      nombre=excluded.nombre, descripcion=excluded.descripcion, precio=excluded.precio,
      unidad=excluded.unidad, stock=excluded.stock, foto_path=excluded.foto_path,
      notas=excluded.notas, actualizado=datetime('now','localtime')
  `).run(datos);
}
export function eliminarCatalogoItem(id) {
  db.prepare("UPDATE catalogo_items SET activo = 0 WHERE id = ?").run(id);
}
export function obtenerFotoItem(tipo, codigo) {
  const row = db.prepare("SELECT foto_path FROM catalogo_items WHERE tipo=? AND codigo=?").get(tipo, codigo);
  return row?.foto_path || null;
}

// ── Facturas ───────────────────────────────────────────────────────────────
export function adjuntarFactura(pedidoId, archivoPath, nombre) {
  return db.prepare("INSERT INTO facturas (pedido_id, archivo_path, nombre) VALUES (?,?,?)").run(pedidoId, archivoPath, nombre).lastInsertRowid;
}
export function obtenerFacturas(pedidoId) {
  return db.prepare("SELECT * FROM facturas WHERE pedido_id = ?").all(pedidoId);
}
export function marcarFacturaEnviada(id) {
  db.prepare("UPDATE facturas SET enviada = 1 WHERE id = ?").run(id);
}

// ── Historial de compras (para repetición minorista) ───────────────────────
export function ultimaCompraMinorista(telefono) {
  const lunes = new Date();
  lunes.setDate(lunes.getDate() - lunes.getDay() - 6); // lunes semana pasada
  const lunesStr   = lunes.toISOString().slice(0,10);
  const domingoStr = new Date(lunes.getTime() + 6*86400000).toISOString().slice(0,10);
  return db.prepare(`
    SELECT * FROM pedidos
    WHERE telefono = ? AND tipo_cliente = 'minorista'
    AND date(creado_en) BETWEEN ? AND ?
    ORDER BY creado_en DESC LIMIT 1
  `).get(telefono, lunesStr, domingoStr);
}
export function clientesMinoristasSemanaAnterior() {
  const lunes = new Date();
  lunes.setDate(lunes.getDate() - lunes.getDay() - 6);
  const lunesStr   = lunes.toISOString().slice(0,10);
  const domingoStr = new Date(lunes.getTime() + 6*86400000).toISOString().slice(0,10);
  return db.prepare(`
    SELECT DISTINCT p.telefono, p.detalle, p.total, c.nombre
    FROM pedidos p LEFT JOIN clientes c ON c.telefono = p.telefono
    WHERE p.tipo_cliente = 'minorista'
    AND date(p.creado_en) BETWEEN ? AND ?
  `).all(lunesStr, domingoStr);
}

export default db;
