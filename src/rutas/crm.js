import { Router } from "express";
import { listarCRM, upsertCRM, actualizarSituacionCRM, obtenerCRM } from "../servicios/db.js";
import db from "../servicios/db.js";

const router = Router();

// Listar clientes CRM (opcionalmente filtrado por comercial)
router.get("/crm", (req, res) => {
  const { comercial } = req.query;
  res.json(listarCRM(comercial || null));
});

// Crear o actualizar config CRM de un cliente
router.post("/crm", (req, res) => {
  const { telefono, comercial, dias_contacto, tipo_oferta, notas } = req.body;
  if (!telefono || !comercial) return res.status(400).json({ error: "Faltan datos" });
  upsertCRM({ telefono, comercial, dias_contacto: dias_contacto || [], tipo_oferta, notas });
  res.json({ ok: true });
});

// Cambiar situación
router.patch("/crm/:id/situacion", (req, res) => {
  const { situacion, nota } = req.body;
  const validos = ['pendiente','enviado','venta','fallido'];
  if (!validos.includes(situacion)) return res.status(400).json({ error: "Situacion invalida" });
  actualizarSituacionCRM(parseInt(req.params.id), situacion, nota||null);
  res.json({ ok: true });
});

// Obtener config CRM de un cliente + productos según tipo_oferta
router.get("/crm/cliente/:telefono", (req, res) => {
  const crm = obtenerCRM(req.params.telefono);
  if (!crm) return res.status(404).json({ error: "No encontrado" });

  // Traer productos disponibles según tipo_oferta del cliente
  const oferta = ['mayorista_a','mayorista_mcba','minorista_mcba','minorista_entrega','food_service'].includes(crm.tipo_oferta)
    ? (crm.tipo_oferta === 'mayorista_a' || crm.tipo_oferta === 'mayorista_mcba' || crm.tipo_oferta === 'minorista_mcba' || crm.tipo_oferta === 'minorista_entrega' ? 'oferta1' : 'oferta2')
    : 'oferta1';

  const productos = db.prepare(`
    SELECT op.*, p.precio, p.disponible_text
    FROM oferta_productos op
    LEFT JOIN oferta_precios p ON p.producto_id = op.id AND p.tipo_cliente = ?
    WHERE op.oferta = ? AND op.activo = 1 AND op.disponible_general = 1
    ORDER BY op.categoria, op.nombre
  `).all(crm.tipo_oferta, oferta);

  res.json({ crm, productos });
});

// Guardar anotador del cliente CRM
router.patch("/crm/:id/anotador", (req, res) => {
  const { anotador } = req.body;
  db.prepare("UPDATE crm_clientes SET anotador=? WHERE id=?").run(anotador||null, parseInt(req.params.id));
  res.json({ ok: true });
});

export default router;
