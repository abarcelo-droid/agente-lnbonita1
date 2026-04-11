import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "../../data/clientes.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS catalogo_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo         TEXT NOT NULL CHECK(tipo IN ('mayorista','mayorista_b','minorista','food_service')),
    codigo       TEXT NOT NULL,
    nombre       TEXT NOT NULL,
    descripcion  TEXT,
    precio       REAL DEFAULT 0,
    unidad       TEXT,
    stock_qty    INTEGER DEFAULT 0,
    foto_path    TEXT,
    origen       TEXT,
    kilaje       TEXT,
    marca        TEXT,
    notas        TEXT,
    activo       INTEGER DEFAULT 1,
    actualizado  TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(tipo, codigo)
  );
`);

(function migrar() {
  var cols = db.prepare("PRAGMA table_info(catalogo_items)").all().map(function(c){ return c.name; });
  if (cols.indexOf('stock_qty') < 0) {
    try { db.exec("ALTER TABLE catalogo_items ADD COLUMN stock_qty INTEGER DEFAULT 0"); } catch(e) {}
  }
  if (cols.indexOf('origen') < 0) {
    try { db.exec("ALTER TABLE catalogo_items ADD COLUMN origen TEXT"); } catch(e) {}
  }
  if (cols.indexOf('kilaje') < 0) {
    try { db.exec("ALTER TABLE catalogo_items ADD COLUMN kilaje TEXT"); } catch(e) {}
  }
  if (cols.indexOf('marca') < 0) {
    try { db.exec("ALTER TABLE catalogo_items ADD COLUMN marca TEXT"); } catch(e) {}
  }
})();

export function listarCatalogo(tipo) {
  return db.prepare("SELECT * FROM catalogo_items WHERE tipo = ? AND activo = 1 ORDER BY nombre ASC").all(tipo);
}

export function upsertItem(datos) {
  return db.prepare(`
    INSERT INTO catalogo_items (tipo, codigo, nombre, descripcion, precio, unidad, stock_qty, foto_path, origen, kilaje, marca, notas)
    VALUES (@tipo, @codigo, @nombre, @descripcion, @precio, @unidad, @stock_qty, @foto_path, @origen, @kilaje, @marca, @notas)
    ON CONFLICT(tipo, codigo) DO UPDATE SET
      nombre = excluded.nombre, descripcion = excluded.descripcion,
      precio = excluded.precio, unidad = excluded.unidad,
      stock_qty = excluded.stock_qty,
      foto_path = COALESCE(excluded.foto_path, foto_path),
      origen = excluded.origen, kilaje = excluded.kilaje, marca = excluded.marca,
      notas = excluded.notas, actualizado = datetime('now','localtime')
  `).run({
    tipo: datos.tipo, codigo: datos.codigo, nombre: datos.nombre,
    descripcion: datos.descripcion || '', precio: parseFloat(datos.precio) || 0,
    unidad: datos.unidad || '', stock_qty: parseInt(datos.stock_qty) || 0,
    foto_path: datos.foto_path || null,
    origen: datos.origen || '', kilaje: datos.kilaje || '', marca: datos.marca || '',
    notas: datos.notas || '',
  });
}

export function actualizarStock(id, qty) {
  db.prepare("UPDATE catalogo_items SET stock_qty = ?, actualizado = datetime('now','localtime') WHERE id = ?").run(parseInt(qty), id);
}

export function eliminarItem(id) {
  db.prepare("UPDATE catalogo_items SET activo = 0 WHERE id = ?").run(id);
}

export function obtenerItem(id) {
  return db.prepare("SELECT * FROM catalogo_items WHERE id = ?").get(id);
}

export function catalogoComoTexto(tipo) {
  const productos  = listarCatalogo(tipo);
  if (!productos.length) return "Catalogo no disponible.";
  const disponibles = productos.filter(function(p){ return p.stock_qty > 0; });
  const agotados    = productos.filter(function(p){ return p.stock_qty <= 0; });
  var texto = "";
  disponibles.forEach(function(p) {
    texto += "- [" + p.codigo + "] " + p.nombre;
    if (p.descripcion) texto += " - " + p.descripcion;
    texto += " | $" + Number(p.precio).toLocaleString("es-AR");
    if (p.unidad)  texto += " por " + p.unidad;
    texto += " | Stock: " + p.stock_qty + " " + (p.unidad || "unidades");
    if (p.origen)  texto += " | Origen: " + p.origen;
    if (p.kilaje)  texto += " | Kilaje: " + p.kilaje;
    if (p.marca)   texto += " | Marca: " + p.marca;
    if (p.notas)   texto += " (" + p.notas + ")";
    texto += "\n";
  });
  if (agotados.length) {
    texto += "\nSin stock: " + agotados.map(function(p){ return p.nombre; }).join(", ") + "\n";
  }
  return texto.trim();
}
