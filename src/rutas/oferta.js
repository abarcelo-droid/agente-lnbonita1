import { Router } from "express";
import multer    from "multer";
import path      from "path";
import fs        from "fs";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { fileURLToPath as ftu } from "url";
const __d2 = path.dirname(ftu(import.meta.url));
const db = new Database(path.join(__d2, "../../data/clientes.db"));

import {
  listarProductos, obtenerProducto, upsertProducto,
  actualizarPrecio, eliminarProducto,
  listarRetailProductos, crearRetailProducto, eliminarRetailProducto,
  listarGastos, crearGasto, actualizarGasto, eliminarGasto,
  guardarSeleccion, vistaRetail,
  guardarPreciosCanal
} from "../servicios/catalogo_v2.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FOTOS_DIR = path.join(__dirname, "../../data/uploads/fotos");
fs.mkdirSync(FOTOS_DIR, { recursive: true });
const upload = multer({ dest: FOTOS_DIR });

const router = Router();

// Listar productos de una oferta con precios
router.get("/oferta/:oferta", (req, res) => {
  const { oferta } = req.params;
  if (!['oferta1','oferta2'].includes(oferta)) return res.status(400).json({ error: "Oferta invalida" });
  res.json(listarProductos(oferta));
});

// Obtener un producto
router.get("/oferta/producto/:id", (req, res) => {
  const p = obtenerProducto(parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: "No encontrado" });
  res.json(p);
});

// Crear/actualizar producto
router.post("/oferta/producto", upload.single("foto"), (req, res) => {
  const datos = { ...req.body };
  if (req.file) datos.foto_path = "/data/uploads/fotos/" + req.file.filename;
  const id = upsertProducto(datos);
  res.status(201).json({ ok: true, id });
});

// Eliminar producto
router.delete("/oferta/producto/:id", (req, res) => {
  eliminarProducto(parseInt(req.params.id));
  res.json({ ok: true });
});

// Actualizar precio/disponibilidad por tipo de cliente
router.post("/oferta/precio", (req, res) => {
  const { producto_id, tipo_cliente, precio, disponible } = req.body;
  actualizarPrecio(producto_id, tipo_cliente, precio, disponible);
  res.json({ ok: true });
});

// Archivos maestros: productos retail
router.get("/retail/productos", (req, res) => res.json(listarRetailProductos()));
router.post("/retail/productos", (req, res) => {
  const { nombre, categoria } = req.body;
  if (!nombre) return res.status(400).json({ error: "Falta nombre" });
  crearRetailProducto(nombre.trim(), categoria||null);
  res.status(201).json({ ok: true });
});
router.delete("/retail/productos/:id", (req, res) => {
  eliminarRetailProducto(req.params.id);
  res.json({ ok: true });
});

// Archivos maestros: matriz de gastos
router.get("/retail/gastos", (req, res) => res.json(listarGastos()));
router.post("/retail/gastos", (req, res) => {
  const { nombre, monto, kg_bulto } = req.body;
  if (!nombre) return res.status(400).json({ error: "Falta nombre" });
  crearGasto(nombre.trim(), monto, kg_bulto);
  res.status(201).json({ ok: true });
});
router.patch("/retail/gastos/:id", (req, res) => {
  actualizarGasto(req.params.id, req.body.nombre, req.body.monto, req.body.kg_bulto);
  res.json({ ok: true });
});
router.delete("/retail/gastos/:id", (req, res) => {
  eliminarGasto(req.params.id);
  res.json({ ok: true });
});

// Vista retail completa
router.get("/retail/vista", (req, res) => res.json(vistaRetail()));

// Guardar precios por canal
router.post("/retail/precios-canal", (req, res) => {
  const { retail_producto_id, precios } = req.body;
  guardarPreciosCanal(retail_producto_id, precios);
  res.json({ ok: true });
});

// Guardar seleccion proveedor + gastos
router.post("/retail/seleccion", (req, res) => {
  const { retail_producto_id, oferta_producto_id, gastos_ids } = req.body;
  guardarSeleccion(retail_producto_id, oferta_producto_id, gastos_ids);
  res.json({ ok: true });
});

// Actualizar nombre_retail de un producto de oferta
router.post("/oferta/producto/nombre-retail", (req, res) => {
  const { producto_id, nombre_retail } = req.body;
  db.prepare("UPDATE oferta_productos SET nombre_retail = ? WHERE id = ?").run(nombre_retail || null, parseInt(producto_id));
  res.json({ ok: true });
});

// Actualizar campo retail de un producto
router.post("/oferta/producto/retail", (req, res) => {
  const { producto_id, retail } = req.body;
  db.prepare("UPDATE oferta_productos SET retail = ? WHERE id = ?").run(parseInt(retail) || 0, parseInt(producto_id));
  res.json({ ok: true });
});

export default router;
