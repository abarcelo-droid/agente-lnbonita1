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

  // Enriquecer con nombre desde dedicados_clientes
  const ded = db.prepare("SELECT nombre, empresa, tipo_oferta, retail_cats, supermercado FROM dedicados_clientes WHERE telefono = ? OR id = ?").get(
    crm.telefono,
    crm.telefono && crm.telefono.startsWith('ded-') ? parseInt(crm.telefono.slice(4)) : -1
  );

  const tipoOferta = (ded && ded.tipo_oferta) || crm.tipo_oferta || 'mayorista_mcba';
  const retailCats = ded && ded.retail_cats ? JSON.parse(ded.retail_cats) : [];
  const supermercado = (ded && ded.supermercado) || null;

  let productos = [];

  if (tipoOferta === 'retail') {
    // Traer productos retail con precios por canal
    let query = `
      SELECT rp.nombre, rp.categoria,
        rpc_cen.precio as precio_cencosud,
        rpc_car.precio as precio_carrefour,
        rpc_cot.precio as precio_coto,
        rpc_cha.precio as precio_chango,
        rpc_coo.precio as precio_coop
      FROM retail_productos rp
      LEFT JOIN retail_precios_canal rpc_cen ON rpc_cen.retail_producto_id = rp.id AND rpc_cen.canal = 'cencosud'
      LEFT JOIN retail_precios_canal rpc_car ON rpc_car.retail_producto_id = rp.id AND rpc_car.canal = 'carrefour'
      LEFT JOIN retail_precios_canal rpc_cot ON rpc_cot.retail_producto_id = rp.id AND rpc_cot.canal = 'coto'
      LEFT JOIN retail_precios_canal rpc_cha ON rpc_cha.retail_producto_id = rp.id AND rpc_cha.canal = 'chango'
      LEFT JOIN retail_precios_canal rpc_coo ON rpc_coo.retail_producto_id = rp.id AND rpc_coo.canal = 'coop'
      WHERE rp.activo = 1
    `;
    let allRetail = db.prepare(query).all();
    // Filtrar por categorías seleccionadas si hay alguna
    if (retailCats.length > 0) {
      allRetail = allRetail.filter(p => retailCats.includes(p.categoria));
    }
    productos = allRetail.map(p => ({
      nombre: p.nombre,
      categoria: p.categoria,
      proveedor: '',
      descripcion: '',
      precio: null,
      disponible_text: 'disponible',
      precios_canal: {
        cencosud: p.precio_cencosud,
        carrefour: p.precio_carrefour,
        coto: p.precio_coto,
        chango: p.precio_chango,
        coop: p.precio_coop,
      }
    }));
  } else {
    const oferta = ['food_service','consumidor_final'].includes(tipoOferta) ? 'oferta2' : 'oferta1';
    productos = db.prepare(`
      SELECT op.*, p.precio, p.disponible_text
      FROM oferta_productos op
      LEFT JOIN oferta_precios p ON p.producto_id = op.id AND p.tipo_cliente = ?
      WHERE op.oferta = ? AND op.activo = 1 AND op.disponible_general = 1
      ORDER BY op.categoria, op.nombre
    `).all(tipoOferta, oferta);
  }

  res.json({
    crm: { ...crm, nombre: (ded && ded.nombre) || crm.nombre, tipo_oferta: tipoOferta },
    productos,
    es_retail: tipoOferta === 'retail',
    retail_cats: retailCats,
    supermercado
  });
});

export default router;
