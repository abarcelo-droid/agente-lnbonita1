import { Router } from 'express';
import { buscarProductoCompras, buscarProductoVentas, buscarClienteVentas, historialClienteVentas, estadoSync, syncSheets } from '../servicios/sheets.js';

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

export default router;
