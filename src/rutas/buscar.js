import { Router } from 'express';
import db from '../servicios/db.js';
import { buscarProductoCompras, buscarProductoVentas, buscarClienteVentas, historialClienteVentas, estadoSync, syncSheets, calendarioEstacional, proveedoresPorProductoMes, debugCalendario } from '../servicios/sheets.js';

const router = Router();

// Búsqueda unificada
router.get('/buscar', (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ proveedores: [], productos: [], clientes: [] });
  try {
    const proveedores = buscarProductoCompras(q);
    const productos   = buscarProductoVentas(q);
    const clientes    = buscarClienteVentas(q);
    res.json({ q, proveedores, productos, clientes });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Historial completo de un cliente
router.get('/buscar/cliente', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  try {
    res.json(historialClienteVentas(q));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Estado del sync
router.get('/buscar/sync', (req, res) => {
  try { res.json(estadoSync()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Forzar sync manual (para el panel)
router.post('/buscar/sync', async (req, res) => {
  res.json({ ok: true, mensaje: 'Sync iniciado en background' });
  syncSheets().catch(e => console.error('[Sheets] Sync manual error:', e.message));
});

// Calendario estacional
router.get('/calendario/estacional', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        producto,
        categoria,
        CAST(mes AS INTEGER) as mes_num,
        ROUND(SUM(kilos_tot),0) as kilos,
        ROUND(AVG(CASE WHEN rent IS NOT NULL AND rent != 0 THEN rent ELSE NULL END),1) as rent_pct,
        ROUND(AVG(CASE WHEN prec_dol IS NOT NULL AND prec_dol > 0 THEN prec_dol ELSE NULL END),2) as valor_kg_dol,
        COUNT(DISTINCT anio) as anios_con_datos
      FROM sheet_ventas
      WHERE producto IS NOT NULL AND producto != ''
        AND mes IS NOT NULL AND mes != '' AND mes != '0'
        AND kilos_tot > 0
      GROUP BY producto, mes_num
      ORDER BY producto, mes_num
    `).all();
    res.json(rows);
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Proveedores por producto y mes
router.get('/calendario/proveedores', (req, res) => {
  const { producto, mes } = req.query;
  if (!producto || !mes) return res.status(400).json({ error: 'Faltan producto y mes' });
  try { res.json(proveedoresPorProductoMes(producto, mes)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Diagnóstico de sheet_ventas
router.get('/calendario/debug', (req, res) => {
  try { res.json(debugCalendario()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Análisis de factura con Claude Vision
router.post('/factura/analizar', async (req, res) => {
  const { base64, mediaType } = req.body;
  if (!base64 || !mediaType) return res.status(400).json({ error: 'Faltan datos' });

  const esPDF = mediaType === 'application/pdf';
  const contenido = esPDF
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const prompt = 'Sos un asistente de carga de facturas argentinas. Analizá esta factura de proveedor y extraé los datos. Respondé ÚNICAMENTE con un JSON válido, sin texto adicional, sin markdown, sin backticks. El JSON debe tener exactamente estas claves: {"razon_social": "", "cuit": "", "tipo_comprobante": "", "numero_factura": "", "fecha_emision": "", "fecha_vencimiento": "", "condicion_pago": "", "subtotal": 0, "iva": 0, "total": 0, "moneda": "ARS", "items": [{"descripcion": "", "cantidad": 0, "precio_unitario": 0, "subtotal": 0}], "notas": ""}. Si algún dato no está visible ponés null. Las fechas en formato DD/MM/YYYY. Los montos como número sin punto ni coma de miles, solo el valor numérico.';

  try {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };
    if (esPDF) headers['anthropic-beta'] = 'pdfs-2024-09-25';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: [contenido, { type: 'text', text: prompt }] }]
      })
    });

    const data = await response.json();
    const txt = data.content && data.content[0] && data.content[0].text;
    if (!txt) return res.status(500).json({ error: 'Sin respuesta de IA' });

    const clean = txt.replace(/```json|```/g, '').trim();
    const factura = JSON.parse(clean);
    res.json({ ok: true, factura });
  } catch(e) {
    console.error('[Factura] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
