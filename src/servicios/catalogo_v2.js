// Catalogo v2 — Oferta 1 y Oferta 2 con precios por tipo de cliente
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "../../data/clientes.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

// Tipos de cliente del sistema
export const TIPOS_CLIENTE = [
  'mayorista_a',
  'mayorista_mcba',
  'minorista_mcba',
  'minorista_entrega',
  'food_service',
  'consumidor_final',
];

export const LABEL_TIPO = {
  mayorista_a:       'Mayorista A',
  mayorista_mcba:    'Mayorista MCBA',
  minorista_mcba:    'Minorista MCBA',
  minorista_entrega: 'Minorista Entrega',
  dedicados:         'Dedicados',
  food_service:      'Food Service',
  consumidor_final:  'Consumidor Final',
};

export const OFERTA_POR_TIPO = {
  mayorista_a:       'oferta1',
  mayorista_mcba:    'oferta1',
  minorista_mcba:    'oferta1',
  minorista_entrega: 'oferta1',
  food_service:      'oferta2',
  consumidor_final:  'oferta2',
};

// Tabla principal de productos del catalogo
db.exec(`
  CREATE TABLE IF NOT EXISTS oferta_productos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    oferta      TEXT NOT NULL CHECK(oferta IN ('oferta1','oferta2')),
    codigo      TEXT NOT NULL,
    nombre      TEXT NOT NULL,
    categoria   TEXT,
    descripcion TEXT,
    unidad      TEXT,
    origen      TEXT,
    kilaje      TEXT,
    marca       TEXT,
    foto_path   TEXT,
    proveedor   TEXT,
    costo       REAL DEFAULT 0,
    flete       REAL DEFAULT 0,
    consignacion INTEGER DEFAULT 0,
    notas       TEXT,
    activo      INTEGER DEFAULT 1,
    actualizado TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(oferta, codigo)
  );

  -- Precios y disponibilidad por tipo de cliente
  CREATE TABLE IF NOT EXISTS oferta_precios (
    producto_id  INTEGER NOT NULL,
    tipo_cliente TEXT NOT NULL,
    precio       REAL DEFAULT 0,
    disponible   INTEGER DEFAULT 1,
    PRIMARY KEY (producto_id, tipo_cliente)
  );
`);

// ── Productos ──────────────────────────────────────────────────────────────
export function listarProductos(oferta) {
  const productos = db.prepare(
    "SELECT * FROM oferta_productos WHERE oferta = ? AND activo = 1 ORDER BY categoria, nombre"
  ).all(oferta);

  // Para cada producto traer sus precios por tipo
  return productos.map(p => {
    const precios = db.prepare(
      "SELECT tipo_cliente, precio, disponible FROM oferta_precios WHERE producto_id = ?"
    ).all(p.id);
    const preciosMap = {};
    precios.forEach(pr => { preciosMap[pr.tipo_cliente] = { precio: pr.precio, disponible: pr.disponible }; });
    return { ...p, precios: preciosMap };
  });
}

export function obtenerProducto(id) {
  const p = db.prepare("SELECT * FROM oferta_productos WHERE id = ?").get(id);
  if (!p) return null;
  const precios = db.prepare("SELECT tipo_cliente, precio, disponible FROM oferta_precios WHERE producto_id = ?").all(p.id);
  const preciosMap = {};
  precios.forEach(pr => { preciosMap[pr.tipo_cliente] = { precio: pr.precio, disponible: pr.disponible }; });
  return { ...p, precios: preciosMap };
}

export function upsertProducto(datos) {
  const result = db.prepare(`
    INSERT INTO oferta_productos (oferta, codigo, nombre, categoria, descripcion, origen, kilaje, marca, proveedor, costo, flete, consignacion, foto_path, notas)
    VALUES (@oferta, @codigo, @nombre, @categoria, @descripcion, @origen, @kilaje, @marca, @proveedor, @costo, @flete, @consignacion, @foto_path, @notas)
    ON CONFLICT(oferta, codigo) DO UPDATE SET
      nombre=excluded.nombre, categoria=excluded.categoria, descripcion=excluded.descripcion,
      origen=excluded.origen, kilaje=excluded.kilaje, marca=excluded.marca, proveedor=excluded.proveedor, costo=excluded.costo, flete=excluded.flete, consignacion=excluded.consignacion,
      foto_path=COALESCE(excluded.foto_path, foto_path), notas=excluded.notas,
      actualizado=datetime('now','localtime')
  `).run({
    oferta: datos.oferta, codigo: datos.codigo, nombre: datos.nombre,
    categoria: datos.categoria || '', descripcion: datos.descripcion || '',
    origen: datos.origen || '', kilaje: datos.kilaje || '', marca: datos.marca || '',
    proveedor: datos.proveedor || '', costo: parseFloat(datos.costo) || 0, flete: parseFloat(datos.flete) || 0, consignacion: parseInt(datos.consignacion) || 0,
    foto_path: datos.foto_path || null, notas: datos.notas || '',
  });
  return result.lastInsertRowid || db.prepare("SELECT id FROM oferta_productos WHERE oferta=? AND codigo=?").get(datos.oferta, datos.codigo).id;
}

export function actualizarPrecio(productoId, tipoCliente, precio, disponible) {
  db.prepare(`
    INSERT INTO oferta_precios (producto_id, tipo_cliente, precio, disponible)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(producto_id, tipo_cliente) DO UPDATE SET precio=excluded.precio, disponible=excluded.disponible
  `).run(productoId, tipoCliente, parseFloat(precio) || 0, disponible ? 1 : 0);
}

export function eliminarProducto(id) {
  db.prepare("UPDATE oferta_productos SET activo = 0 WHERE id = ?").run(id);
}

// Texto para el agente — catalogo filtrado por tipo de cliente
export function catalogoParaTipo(tipoCliente) {
  const oferta = OFERTA_POR_TIPO[tipoCliente] || 'oferta1';
  const productos = listarProductos(oferta);
  const disponibles = productos.filter(p => {
    const prec = p.precios[tipoCliente];
    return prec && prec.disponible;
  });
  const agotados = productos.filter(p => {
    const prec = p.precios[tipoCliente];
    return !prec || !prec.disponible;
  });

  if (!disponibles.length) return "Catalogo no disponible en este momento.";

  let texto = "";
  let catActual = "";
  disponibles.forEach(p => {
    if (p.categoria !== catActual) {
      catActual = p.categoria;
      if (catActual) texto += `\n${catActual.toUpperCase()}:\n`;
    }
    const prec = p.precios[tipoCliente];
    texto += `- [${p.codigo}] ${p.nombre}`;
    if (p.descripcion) texto += ` - ${p.descripcion}`;
    texto += ` | $${Number(prec?.precio || 0).toLocaleString("es-AR")}`;
    if (p.unidad) texto += ` por ${p.unidad}`;
    if (p.origen) texto += ` | Origen: ${p.origen}`;
    if (p.kilaje) texto += ` | ${p.kilaje}`;
    if (p.marca)  texto += ` | ${p.marca}`;
    if (p.consignacion) texto += " (consignacion)";
    if (p.notas)  texto += ` (${p.notas})`;
    texto += "\n";
  });

  if (agotados.length) {
    texto += `\nSin stock para vos: ${agotados.map(p => p.nombre).join(", ")}\n`;
  }

  return texto.trim();
}
