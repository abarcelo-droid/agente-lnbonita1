import { Router } from "express";
import multer    from "multer";
import path      from "path";
import fs        from "fs";
import { fileURLToPath } from "url";
import {
  listarProductos, obtenerProducto, upsertProducto,
  actualizarPrecio, eliminarProducto
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

export default router;
