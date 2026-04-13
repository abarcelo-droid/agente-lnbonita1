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
  listarRetailProductos, crearRetailProducto, eliminarRetailProducto, actualizarRetailProducto,
  listarGastos, crearGasto, actualizarGasto, eliminarGasto,
  guardarSeleccion, vistaRetail,
  guardarPreciosCanal,
  obtenerEANs, guardarEAN,
  guardarObservacionRetail
} from "../servicios/catalogo_v2.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FOTOS_DIR = path.join(__dirname, "../../data/uploads/fotos");
fs.mkdirSync(FOTOS_DIR, { recursive: true });
const upload = multer({ dest: FOTOS_DIR });

const router = Router();

// Listar productos de una oferta con precios
router.get("/oferta/:oferta", (req, res) => {
  const { oferta } = req.params;
  const soloDisponibles = req.query.disponibles === "1";
  if (!['oferta1','oferta2'].includes(oferta)) return res.status(400).json({ error: "Oferta invalida" });
  let productos = listarProductos(oferta);
  if (soloDisponibles) productos = productos.filter(p => p.disponible_general !== 0);
  res.json(productos);
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

// Editar producto retail
router.patch("/retail/productos/:id", (req, res) => {
  const { nombre, categoria } = req.body;
  if (!nombre) return res.status(400).json({ error: "Falta nombre" });
  actualizarRetailProducto(req.params.id, nombre.trim(), categoria||null);
  res.json({ ok: true });
});

// EANs por supermercado
router.get("/retail/ean/:id", (req, res) => {
  res.json(obtenerEANs(req.params.id));
});
router.post("/retail/ean", (req, res) => {
  const { retail_producto_id, supermercado, ean } = req.body;
  guardarEAN(retail_producto_id, supermercado, ean);
  res.json({ ok: true });
});

// Archivos maestros: matriz de gastos
router.get("/retail/gastos", (req, res) => res.json(listarGastos()));
router.post("/retail/gastos", (req, res) => {
  const { nombre, proveedor, monto, kg_bulto } = req.body;
  if (!nombre) return res.status(400).json({ error: "Falta nombre" });
  crearGasto(nombre.trim(), proveedor||null, monto, kg_bulto);
  res.status(201).json({ ok: true });
});
router.patch("/retail/gastos/:id", (req, res) => {
  actualizarGasto(req.params.id, req.body.nombre, req.body.proveedor, req.body.monto, req.body.kg_bulto);
  res.json({ ok: true });
});
router.delete("/retail/gastos/:id", (req, res) => {
  eliminarGasto(req.params.id);
  res.json({ ok: true });
});

// Vista retail completa
router.get("/retail/vista", (req, res) => res.json(vistaRetail()));

// Guardar observacion de producto retail
router.post("/retail/observacion", (req, res) => {
  const { retail_producto_id, observaciones } = req.body;
  guardarObservacionRetail(retail_producto_id, observaciones);
  res.json({ ok: true });
});

// PDF de pricing por tipo de cliente
router.get("/pricing/pdf/:tipo", async (req, res) => {
  const { tipo } = req.params;
  const LABELS = {
    mayorista_a:'Mayorista A', mayorista_mcba:'Mayorista MCBA',
    minorista_mcba:'Minorista MCBA', minorista_entrega:'Minorista Entrega',
    food_service:'Food Service', consumidor_final:'Consumidor Final'
  };
  const OFERTA = ['mayorista_a','mayorista_mcba','minorista_mcba','minorista_entrega'].includes(tipo) ? 'oferta1' : 'oferta2';
  const label = LABELS[tipo] || tipo;

  const prods = db.prepare("SELECT * FROM oferta_productos WHERE oferta = ? AND activo = 1 ORDER BY categoria, nombre").all(OFERTA);
  const precios = db.prepare("SELECT producto_id, precio, disponible FROM oferta_precios WHERE tipo_cliente = ?").all(tipo);
  const precMap = {};
  precios.forEach(function(p){ precMap[p.producto_id] = p; });

  const fecha = new Date().toLocaleDateString('es-AR', {day:'2-digit',month:'2-digit',year:'numeric'});

  let rows = '';
  let catActual = '';
  prods.forEach(function(p) {
    const prec = precMap[p.id];
    if (!prec || !prec.disponible) return;
    if (p.categoria !== catActual) {
      catActual = p.categoria;
      rows += '<tr class="cat"><td colspan="4">' + (catActual||'Sin categoria') + '</td></tr>';
    }
    rows += '<tr><td>' + p.nombre + '</td><td style="color:#7a6055">' + (p.descripcion||'') + '</td><td style="color:#7a6055">' + (p.origen||'') + ' ' + (p.kilaje||'') + '</td><td class="num">$' + Number(prec.precio||0).toLocaleString('es-AR') + '</td></tr>';
  });

  const html = [
    '<!DOCTYPE html><html><head><meta charset="UTF-8">',
    '<style>',
    'body{font-family:Arial,sans-serif;font-size:13px;color:#2c1810;margin:0;padding:32px}',
    '.header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #6b1212}',
    '.logo-text{font-size:22px;font-weight:700;color:#6b1212}',
    'table{width:100%;border-collapse:collapse;margin-top:8px}',
    'th{padding:9px 12px;background:#6b1212;color:#fff;text-align:left;font-size:11px;text-transform:uppercase}',
    'th.num{text-align:right}',
    'td{padding:8px 12px;border-bottom:1px solid #e8ddd0;vertical-align:top}',
    'td.num{text-align:right;font-weight:600;color:#6b1212;font-variant-numeric:tabular-nums}',
    'tr.cat td{background:#faf3dc;font-size:11px;font-weight:700;color:#6b1212;text-transform:uppercase;padding:7px 12px}',
    '.footer{margin-top:32px;font-size:10px;color:#b09080;text-align:center;border-top:1px solid #e8ddd0;padding-top:12px}',
    '</style></head><body>',
    '<div class="header">',
    '<div><div class="logo-text">La Nina Bonita</div><div style="font-size:11px;color:#7a6055">Frutas y Hortalizas - desde 1945</div></div>',
    '<div style="text-align:right;font-size:12px;color:#7a6055"><strong style="color:#2c1810;font-size:15px;display:block;margin-bottom:4px">Lista de precios - ' + label + '</strong>Fecha: ' + fecha + '</div>',
    '</div>',
    '<table>',
    '<thead><tr><th>Producto</th><th>Variedad</th><th>Origen / Presentacion</th><th class="num">Precio</th></tr></thead>',
    '<tbody>' + rows + '</tbody>',
    '</table>',
    '<div class="footer">La Nina Bonita - Mercado Central de Buenos Aires, Nave 4, Puestos 2-4-6 | a.barcelo@lnbonita.com.ar</div>',
    '</body></html>'
  ].join('');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="precios-' + tipo + '.html"');
  res.send(html);
});

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

// Actualizar disponibilidad general del producto
router.post("/oferta/producto/disponibilidad", (req, res) => {
  const { producto_id, disponible } = req.body;
  db.prepare("UPDATE oferta_productos SET disponible_general = ? WHERE id = ?").run(parseInt(disponible), parseInt(producto_id));
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

// Limpiar duplicados — mantiene el de menor id por cada nombre+proveedor+oferta
router.post("/oferta/limpiar-duplicados", (req, res) => {
  const dups = db.prepare(`
    SELECT MIN(id) as keep_id, nombre, proveedor, oferta, COUNT(*) as cnt
    FROM oferta_productos
    WHERE activo = 1
    GROUP BY nombre, proveedor, oferta
    HAVING cnt > 1
  `).all();
  let borrados = 0;
  dups.forEach(function(d) {
    const result = db.prepare(
      "UPDATE oferta_productos SET activo = 0 WHERE nombre = ? AND (proveedor = ? OR (proveedor IS NULL AND ? IS NULL)) AND oferta = ? AND id != ?"
    ).run(d.nombre, d.proveedor, d.proveedor, d.oferta, d.keep_id);
    borrados += result.changes;
  });
  res.json({ ok: true, borrados });
});

export default router;
