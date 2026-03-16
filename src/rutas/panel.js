import { Router } from "express";
import {
  listarClientes, crearCliente, actualizarCliente,
  listarPedidos, actualizarEstadoPedido
} from "../servicios/db.js";
import { obtenerCatalogo, catalogoComoTexto, invalidarCache } from "../servicios/sheets.js";

const router = Router();

// ── Clientes ───────────────────────────────────────────────────────────────

// GET /api/clientes?tipo=mayorista
router.get("/clientes", (req, res) => {
  const clientes = listarClientes(req.query.tipo);
  res.json(clientes);
});

// POST /api/clientes  — para cargar mayoristas y food service manualmente
router.post("/clientes", (req, res) => {
  const { telefono, tipo, nombre, empresa, email, direccion, zona, notas } = req.body;
  if (!telefono || !tipo) return res.status(400).json({ error: "telefono y tipo son requeridos" });
  try {
    const cliente = crearCliente({ telefono, tipo, nombre, empresa, email, direccion, zona, notas });
    res.status(201).json(cliente);
  } catch (e) {
    res.status(409).json({ error: "El teléfono ya está registrado" });
  }
});

// PATCH /api/clientes/:telefono
router.patch("/clientes/:telefono", (req, res) => {
  actualizarCliente(req.params.telefono, req.body);
  res.json({ ok: true });
});

// ── Pedidos ────────────────────────────────────────────────────────────────

// GET /api/pedidos?tipo_cliente=mayorista&estado=pendiente&fecha=2025-03-14
router.get("/pedidos", (req, res) => {
  const pedidos = listarPedidos(req.query);
  res.json(pedidos);
});

// PATCH /api/pedidos/:id  — para confirmar horario o marcar entregado
router.patch("/pedidos/:id", (req, res) => {
  actualizarEstadoPedido(req.params.id, req.body.estado);
  res.json({ ok: true });
});

// ── Catálogos ──────────────────────────────────────────────────────────────

// GET /api/catalogo/:tipo  — previsualizar el catálogo cargado en Sheets
router.get("/catalogo/:tipo", async (req, res) => {
  const { tipo } = req.params;
  if (!["mayorista","mayorista_b","minorista","food_service"].includes(tipo)) {
    return res.status(400).json({ error: "Tipo inválido" });
  }
  const productos = await obtenerCatalogo(tipo);
  res.json({ tipo, productos, texto: catalogoComoTexto(productos) });
});

// POST /api/catalogo/invalidar  — forzar recarga desde Sheets
router.post("/catalogo/invalidar", (req, res) => {
  invalidarCache(req.body.tipo || null);
  res.json({ ok: true, mensaje: "Cache invalidado. Próxima consulta leerá Sheets." });
});

// ── Envío masivo de listados (botón del panel) ─────────────────────────────

// POST /api/enviar-listado  — body: { tipo: "mayorista" | "food_service" }
// Etapa 4: esto disparará los mensajes reales por Twilio.
// Por ahora devuelve el listado que se enviaría para que puedas verificarlo.
router.post("/enviar-listado", async (req, res) => {
  const { tipo } = req.body;
  if (!["mayorista","mayorista_b","food_service"].includes(tipo)) {
    return res.status(400).json({ error: "Solo disponible para mayorista, mayorista_b y food_service" });
  }

  const clientes  = listarClientes(tipo);
  const productos = await obtenerCatalogo(tipo);
  const texto     = catalogoComoTexto(productos);

  // TODO Etapa 4: iterar clientes y enviar por Twilio
  // for (const cliente of clientes) {
  //   await twilioClient.messages.create({
  //     from: process.env.TWILIO_WHATSAPP_NUMBER,
  //     to: `whatsapp:${cliente.telefono}`,
  //     body: `Hola ${cliente.nombre}! 👋 El listado de hoy:\n\n${texto}\n\nRespondé este mensaje para hacer tu pedido.`,
  //   });
  // }

  console.log(`[PANEL] Listado ${tipo} listo para enviar a ${clientes.length} clientes`);
  res.json({
    ok: true,
    tipo,
    destinatarios: clientes.length,
    vista_previa: texto,
    // En Etapa 4 esto dirá "enviado" en lugar de "simulado"
    estado: "simulado — activar en Etapa 4 con Twilio",
  });
});

export default router;
