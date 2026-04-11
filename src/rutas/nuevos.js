import { Router } from "express";
import multer    from "multer";
import path      from "path";
import fs        from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS   = path.join(__dirname, "../../data/uploads");
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(path.join(UPLOADS, "fotos"),    { recursive: true });
fs.mkdirSync(path.join(UPLOADS, "facturas"), { recursive: true });

const uploadFoto    = multer({ dest: path.join(UPLOADS, "fotos") });
const uploadFactura = multer({ dest: path.join(UPLOADS, "facturas") });

import {
  listarComerciales, crearComercial, actualizarComercial,
  obtenerTurnosBase, guardarTurnoBase,
  obtenerGuardias, asignarGuardia, comercialDeGuardia, generarGuardiasDesdeBase,
  listarCatalogoEditable, upsertCatalogoItem, eliminarCatalogoItem,
  adjuntarFactura, obtenerFacturas, marcarFacturaEnviada,
  clientesMinoristasSemanaAnterior, ultimaCompraMinorista,
} from "../servicios/db2.js";
import { listarPedidos, actualizarEstadoPedido } from "../servicios/db.js";
import { generarOrdenPDF }   from "../servicios/ordenPDF.js";
import { generarOrdenExcel } from "../servicios/ordenExcel.js";

const router = Router();

// ── Comerciales ────────────────────────────────────────────────────────────
router.get("/comerciales", (req, res) => res.json(listarComerciales()));
router.post("/comerciales", (req, res) => {
  crearComercial(req.body);
  res.status(201).json({ ok: true });
});
router.patch("/comerciales/:id", (req, res) => {
  actualizarComercial(req.params.id, req.body);
  res.json({ ok: true });
});

// ── Guardias ───────────────────────────────────────────────────────────────
router.get("/guardias", (req, res) => {
  const desde = req.query.desde || new Date().toISOString().slice(0,10);
  const hasta = req.query.hasta || desde;
  res.json(obtenerGuardias(desde, hasta));
});
router.get("/guardias/ahora", (req, res) => res.json(comercialDeGuardia() || null));
router.post("/guardias", (req, res) => {
  const { comercial_id, fecha, franja, nota } = req.body;
  asignarGuardia(comercial_id, fecha, franja, nota);
  res.json({ ok: true });
});
router.post("/guardias/generar", (req, res) => {
  const semana = req.body.semana || new Date().toISOString().slice(0,10);
  const result = generarGuardiasDesdeBase(semana);
  res.json({ ok: true, insertados: result.length, detalle: result });
});
router.get("/turnos-base/:comercialId", (req, res) => {
  res.json(obtenerTurnosBase(req.params.comercialId));
});
router.post("/turnos-base", (req, res) => {
  const { comercial_id, dia_semana, franja, activo } = req.body;
  guardarTurnoBase(comercial_id, dia_semana, franja, activo !== false);
  res.json({ ok: true });
});

// ── Catálogo editable ──────────────────────────────────────────────────────
router.get("/catalogo-editable/:tipo", (req, res) => {
  res.json(listarCatalogoEditable(req.params.tipo));
});
router.post("/catalogo-editable", uploadFoto.single("foto"), (req, res) => {
  const datos = { ...req.body, stock: req.body.stock === "true" ? 1 : 0, foto_path: null };
  if (req.file) datos.foto_path = `/data/uploads/fotos/${req.file.filename}`;
  upsertCatalogoItem(datos);
  res.status(201).json({ ok: true });
});
router.delete("/catalogo-editable/:id", (req, res) => {
  eliminarCatalogoItem(req.params.id);
  res.json({ ok: true });
});
router.get("/catalogo-editable/:tipo/:codigo/foto", async (req, res) => {
  const { tipo, codigo } = req.params;
  const { obtenerFotoItem } = await import("../servicios/db2.js");
  const fotoPath = obtenerFotoItem(tipo, codigo);
  if (!fotoPath || !fs.existsSync(path.join(__dirname, "../..", fotoPath))) {
    return res.status(404).json({ error: "Sin foto" });
  }
  res.sendFile(path.join(__dirname, "../..", fotoPath));
});

// ── Facturas ───────────────────────────────────────────────────────────────
router.get("/pedidos/:id/facturas", (req, res) => {
  res.json(obtenerFacturas(req.params.id));
});
router.post("/pedidos/:id/facturas", uploadFactura.single("factura"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Falta archivo" });
  const archivoPath = `/data/uploads/facturas/${req.file.filename}`;
  const nombre      = req.body.nombre || req.file.originalname;
  const factId = adjuntarFactura(req.params.id, archivoPath, nombre);
  res.status(201).json({ ok: true, id: factId });
});
router.post("/pedidos/:id/facturas/:factId/enviar", (req, res) => {
  marcarFacturaEnviada(req.params.factId);
  // TODO Etapa 4: enviar el PDF al cliente por WhatsApp via Twilio
  res.json({ ok: true, mensaje: "Marcada como enviada (envío real disponible en Etapa 4)" });
});

// ── Órdenes de trabajo ─────────────────────────────────────────────────────
router.get("/pedidos/:id/orden/pdf", async (req, res) => {
  const pedidos = listarPedidos({ id: req.params.id });
  if (!pedidos.length) return res.status(404).json({ error: "Pedido no encontrado" });
  const pdfBuffer = await generarOrdenPDF(pedidos[0]);
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="orden-${req.params.id}.pdf"` });
  res.send(pdfBuffer);
});
router.get("/pedidos/:id/orden/excel", async (req, res) => {
  const pedidos = listarPedidos({ id: req.params.id });
  if (!pedidos.length) return res.status(404).json({ error: "Pedido no encontrado" });
  const xlsBuffer = await generarOrdenExcel(pedidos[0]);
  res.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="orden-${req.params.id}.xlsx"` });
  res.send(xlsBuffer);
});

// ── Envío a minoristas semana anterior (repetición de compra) ──────────────
router.get("/minoristas/semana-anterior", (req, res) => {
  res.json(clientesMinoristasSemanaAnterior());
});
router.post("/enviar-repeticion", async (req, res) => {
  const clientes = clientesMinoristasSemanaAnterior();
  // TODO Etapa 4: enviar mensaje por Twilio a cada cliente
  // El mensaje incluirá su último pedido y los precios actualizados
  res.json({
    ok: true,
    destinatarios: clientes.length,
    estado: "simulado — activar en Etapa 4",
    clientes: clientes.map(c => ({ telefono: c.telefono, nombre: c.nombre })),
  });
});

export default router;
