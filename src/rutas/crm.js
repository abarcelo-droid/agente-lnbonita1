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

  // ── Caso: dedicado con supermercado → traer productos retail filtrados por categoría ──
  const retailCats = (() => {
    try { return JSON.parse(crm.retail_cats || '[]'); } catch { return []; }
  })();

  if (crm.supermercado && retailCats.length > 0) {
    const placeholders = retailCats.map(() => '?').join(',');
    const retailProds = db.prepare(`
      SELECT rp.id, rp.nombre, rp.categoria
      FROM retail_productos rp
      WHERE rp.activo = 1 AND rp.categoria IN (${placeholders})
      ORDER BY rp.categoria, rp.nombre
    `).all(...retailCats);

    const prods = retailProds.map(rp => {
      const canales = db.prepare(`
        SELECT canal, precio FROM retail_precios_canal WHERE retail_producto_id = ?
      `).all(rp.id);
      const precios_canal = {};
      canales.forEach(c => { precios_canal[c.canal] = c.precio; });
      return { ...rp, precios_canal };
    });

    return res.json({
      crm,
      productos: prods,
      es_retail: true,
      supermercado: crm.supermercado,
    });
  }

  // ── Caso normal: oferta 1 o 2 según tipo de cliente ──
  const oferta = ['mayorista_a','mayorista_mcba','minorista_mcba','minorista_entrega'].includes(crm.tipo_oferta)
    ? 'oferta1' : 'oferta2';

  const productos = db.prepare(`
    SELECT op.*, p.precio, p.disponible_text
    FROM oferta_productos op
    LEFT JOIN oferta_precios p ON p.producto_id = op.id AND p.tipo_cliente = ?
    WHERE op.oferta = ? AND op.activo = 1 AND op.disponible_general = 1
    ORDER BY op.categoria, op.nombre
  `).all(crm.tipo_oferta, oferta);

  res.json({ crm, productos, es_retail: false });
});

// Guardar anotador del cliente CRM
router.patch("/crm/:id/anotador", (req, res) => {
  const { anotador } = req.body;
  db.prepare("UPDATE crm_clientes SET anotador=? WHERE id=?").run(anotador||null, parseInt(req.params.id));
  res.json({ ok: true });
});

export default router;
