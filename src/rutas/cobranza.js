import { Router } from "express";
import multer    from "multer";
import path      from "path";
import fs        from "fs";
import { fileURLToPath } from "url";
import {
  crearFactura, listarFacturas, actualizarEstadoFactura,
  obtenerFactura, resumenCobranza
} from "../servicios/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FACTURAS_DIR = path.join(__dirname, "../../data/uploads/facturas");
fs.mkdirSync(FACTURAS_DIR, { recursive: true });

const upload = multer({
  dest: FACTURAS_DIR,
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype === "application/pdf");
  }
});

const router = Router();

// GET /api/cobranza — listado con filtros
router.get("/cobranza", (req, res) => {
  const facturas = listarFacturas(req.query);
  res.json(facturas);
});

// GET /api/cobranza/resumen — stats para el dashboard
router.get("/cobranza/resumen", (req, res) => {
  res.json(resumenCobranza());
});

// POST /api/cobranza — subir nueva factura
router.post("/cobranza", upload.single("factura"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Falta el archivo PDF" });
  const { telefono, tipo_cliente, numero_factura, pedido_id, fecha_vencimiento, monto, notas } = req.body;
  if (!telefono || !tipo_cliente) return res.status(400).json({ error: "Falta telefono o tipo_cliente" });

  const archivoPath = "/data/uploads/facturas/" + req.file.filename;
  const id = crearFactura({
    pedido_id:         pedido_id || null,
    telefono,
    tipo_cliente,
    numero_factura:    numero_factura || null,
    archivo_path:      archivoPath,
    nombre_archivo:    req.file.originalname || "factura.pdf",
    fecha_vencimiento: fecha_vencimiento || null,
    monto:             parseFloat(monto) || null,
    notas:             notas || null,
  });
  res.status(201).json({ ok: true, id });
});

// PATCH /api/cobranza/:id — cambiar estado
router.patch("/cobranza/:id", (req, res) => {
  actualizarEstadoFactura(req.params.id, req.body.estado, req.body.notas);
  res.json({ ok: true });
});

// GET /api/cobranza/:id/archivo — descargar el PDF
router.get("/cobranza/:id/archivo", (req, res) => {
  const factura = obtenerFactura(req.params.id);
  if (!factura) return res.status(404).json({ error: "Factura no encontrada" });
  const fullPath = path.join(__dirname, "../..", factura.archivo_path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "Archivo no encontrado" });
  res.download(fullPath, factura.nombre_archivo || "factura.pdf");
});

// POST /api/cobranza/:id/enviar — marcar como enviada (Twilio en Etapa 4)
router.post("/cobranza/:id/enviar", (req, res) => {
  const factura = obtenerFactura(req.params.id);
  if (!factura) return res.status(404).json({ error: "Factura no encontrada" });

  // TODO Etapa 4: enviar PDF por WhatsApp via Twilio Media
  // await twilioClient.messages.create({
  //   from: process.env.TWILIO_WHATSAPP_NUMBER,
  //   to: `whatsapp:${factura.telefono}`,
  //   mediaUrl: [`https://tu-servidor.com${factura.archivo_path}`],
  //   body: `Hola! Te adjuntamos la factura ${factura.numero_factura || '#'+factura.id}. Ante cualquier consulta no dudes en escribirnos. Gracias!`
  // });

  actualizarEstadoFactura(factura.id, "enviada", null);
  res.json({
    ok: true,
    mensaje: "Marcada como enviada (envio real por WhatsApp disponible en Etapa 4)",
    telefono: factura.telefono,
  });
});

export default router;
