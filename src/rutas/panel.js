import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Router } from "express";
import {
  listarClientes, crearCliente, actualizarCliente,
  listarPedidos, actualizarEstadoPedido
} from "../servicios/db.js";
import { listarCatalogo, catalogoComoTexto, upsertItem, actualizarStock, eliminarItem } from "../servicios/catalogo.js";

const __dirnameP = path.dirname(fileURLToPath(import.meta.url));
const UP = path.join(__dirnameP, "../../data/uploads/fotos");
fs.mkdirSync(UP, { recursive: true });
const upload = multer({ dest: UP });

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
router.get("/catalogo/:tipo", (req, res) => {
  const { tipo } = req.params;
  if (!["mayorista","mayorista_b","minorista","food_service"].includes(tipo)) {
    return res.status(400).json({ error: "Tipo invalido" });
  }
  const productos = listarCatalogo(tipo);
  res.json({ tipo, productos, texto: catalogoComoTexto(tipo) });
});

router.post("/catalogo/invalidar", (req, res) => {
  res.json({ ok: true, mensaje: "Catalogo integrado - no requiere recarga" });
});

// CRUD catalogo integrado
router.post("/catalogo", upload.single("foto"), (req, res) => {
  const datos = { ...req.body };
  if (req.file) datos.foto_path = "/data/uploads/fotos/" + req.file.filename;
  upsertItem(datos);
  res.status(201).json({ ok: true });
});

router.patch("/catalogo/:id/stock", (req, res) => {
  actualizarStock(req.params.id, req.body.stock_qty);
  res.json({ ok: true });
});

router.delete("/catalogo/:id", (req, res) => {
  eliminarItem(req.params.id);
  res.json({ ok: true });
});

// ── Envío masivo de listados (botón del panel) ─────────────────────────────

// POST /api/enviar-listado  — body: { tipo: "mayorista" | "food_service" }
// Etapa 4: esto disparará los mensajes reales por Twilio.
// Por ahora devuelve el listado que se enviaría para que puedas verificarlo.
router.post("/enviar-listado", async (req, res) => {
  const { tipo } = req.body;
  if (!["mayorista","mayorista_b","minorista","food_service"].includes(tipo)) {
    return res.status(400).json({ error: "Tipo invalido" });
  }

  const clientes  = listarClientes(tipo, true); // excluir cuentas canceladas
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

// ── Conversaciones en vivo ─────────────────────────────────────────────────
import {
  listarConversaciones, obtenerConversacion,
  pausarConversacion, reactivarConversacion,
  agregarInstruccion, historialInstrucciones,
} from "../servicios/conversaciones.js";
import { generarResumen } from "../agentes/base.js";
import { obtenerSesion }  from "../servicios/db.js";

// GET /api/conversaciones?filtro=atencion|pausadas|todas
router.get("/conversaciones", (req, res) => {
  const convs = listarConversaciones(req.query.filtro || "todas");
  res.json(convs);
});

// GET /api/conversaciones/:telefono — detalle + historial de mensajes
router.get("/conversaciones/:telefono", (req, res) => {
  const tel  = decodeURIComponent(req.params.telefono);
  const conv = obtenerConversacion(tel);
  const ses  = obtenerSesion(tel);
  const hist = historialInstrucciones(tel);
  res.json({ conversacion: conv, mensajes: ses.mensajes || [], instrucciones: hist });
});

// POST /api/conversaciones/:telefono/pausar
router.post("/conversaciones/:telefono/pausar", (req, res) => {
  const tel   = decodeURIComponent(req.params.telefono);
  const autor = req.body.autor || "equipo";
  pausarConversacion(tel, autor);
  res.json({ ok: true });
});

// POST /api/conversaciones/:telefono/reactivar
router.post("/conversaciones/:telefono/reactivar", (req, res) => {
  const tel = decodeURIComponent(req.params.telefono);
  reactivarConversacion(tel);
  res.json({ ok: true });
});

// POST /api/conversaciones/:telefono/instruccion
// body: { tipo, contenido, autor }
// tipos: descuento | rechazo | info_extra | reclamo | libre
router.post("/conversaciones/:telefono/instruccion", (req, res) => {
  const tel = decodeURIComponent(req.params.telefono);
  const { tipo, contenido, autor } = req.body;
  if (!contenido) return res.status(400).json({ error: "contenido requerido" });
  const id = agregarInstruccion(tel, tipo || "libre", contenido, autor || "equipo");
  res.json({ ok: true, id });
});

// GET /api/conversaciones/:telefono/resumen — resumen IA de la charla
router.get("/conversaciones/:telefono/resumen", async (req, res) => {
  const tel    = decodeURIComponent(req.params.telefono);
  const resumen = await generarResumen(tel);
  res.json({ resumen });
});

// ── Logistica: pedidos pendientes agrupados por dia de entrega ─────────────
router.get("/logistica", (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().slice(0,10);
  const todos = listarPedidos({ estado: "pendiente" });

  // Agrupar por horario_entrega (dia de retiro o entrega)
  const grupos = {};
  const sinFecha = [];

  todos.forEach(p => {
    const esMayorista = ["mayorista","mayorista_b"].includes(p.tipo_cliente);
    const esEntrega   = ["minorista","food_service"].includes(p.tipo_cliente);
    const key = p.horario_entrega || null;

    const item = {
      ...p,
      modo_entrega: esMayorista ? "retiro_cd" : "entrega_directa",
    };

    if (key) {
      if (!grupos[key]) grupos[key] = [];
      grupos[key].push(item);
    } else {
      sinFecha.push(item);
    }
  });

  // Ordenar dias: primero Domingo, Martes, Jueves noche, luego resto
  const ordenDias = ["Domingo noche","Martes noche","Jueves noche"];
  const diasOrdenados = [
    ...ordenDias.filter(d => grupos[d]),
    ...Object.keys(grupos).filter(d => !ordenDias.includes(d))
  ];

  const resultado = diasOrdenados.map(dia => ({
    dia,
    pedidos: grupos[dia],
    total_cd:      grupos[dia].filter(p => p.modo_entrega === "retiro_cd").length,
    total_entrega: grupos[dia].filter(p => p.modo_entrega === "entrega_directa").length,
  }));

  if (sinFecha.length) {
    resultado.push({
      dia: "Sin fecha asignada",
      pedidos: sinFecha,
      total_cd:      sinFecha.filter(p => p.modo_entrega === "retiro_cd").length,
      total_entrega: sinFecha.filter(p => p.modo_entrega === "entrega_directa").length,
    });
  }

  res.json(resultado);
});

