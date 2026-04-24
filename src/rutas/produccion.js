// src/rutas/produccion.js
// ── API PRODUCCIÓN AGRÍCOLA — PUENTE CORDON SA ────────────────────────────

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../servicios/db.js';
import '../servicios/db_pa.js'; // Asegura que las tablas existan

const router = express.Router();
const __dirnamePA = path.dirname(fileURLToPath(import.meta.url));

// ── Middleware auth básico ─────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    req.user = JSON.parse(cookie);
    next();
  } catch(e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

// ─────────────────────────────────────────────────────────────────────────
// CAMPAÑAS
// ─────────────────────────────────────────────────────────────────────────

router.get('/campanas', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare("SELECT * FROM pa_campañas ORDER BY fecha_inicio DESC").all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/campanas', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, fecha_inicio, fecha_fin } = req.body;
  if (!nombre || !fecha_inicio || !fecha_fin)
    return res.status(400).json({ ok: false, error: 'Nombre, fecha_inicio y fecha_fin requeridos' });
  try {
    const r = db.prepare("INSERT INTO pa_campañas (nombre, fecha_inicio, fecha_fin) VALUES (?,?,?)")
      .run(nombre, fecha_inicio, fecha_fin);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe esa campaña' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/campanas/:id/activar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_campañas SET activa = 0").run();
    db.prepare("UPDATE pa_campañas SET activa = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// SECTORES
// ─────────────────────────────────────────────────────────────────────────

router.get('/sectores', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare("SELECT * FROM pa_sectores WHERE activo = 1 ORDER BY nombre").all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// LOTES
// ─────────────────────────────────────────────────────────────────────────

router.get('/lotes', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { sector_id } = req.query;
    let query = `
      SELECT l.*, s.nombre as sector_nombre, s.tipo as sector_tipo,
             cl.cultivo as cultivo_actual
      FROM pa_lotes l
      JOIN pa_sectores s ON s.id = l.sector_id
      LEFT JOIN pa_cultivos_lote cl ON cl.lote_id = l.id
        AND cl.campaña = (SELECT nombre FROM pa_campañas WHERE activa = 1 LIMIT 1)
      WHERE l.activo = 1
    `;
    const params = [];
    if (sector_id) { query += " AND l.sector_id = ?"; params.push(sector_id); }
    query += " ORDER BY l.finca NULLS LAST, l.nombre";
    const data = db.prepare(query).all(...params);
    // Enriquecer con todos los cultivos por campaña
    const getCultivos = db.prepare(
      "SELECT campaña, cultivo, mes_siembra, mes_cosecha FROM pa_cultivos_lote WHERE lote_id = ?"
    );
    data.forEach(l => {
      l.cultivos = {};
      getCultivos.all(l.id).forEach(r => {
        l.cultivos[r.campaña] = { cultivo: r.cultivo, mes_siembra: r.mes_siembra, mes_cosecha: r.mes_cosecha };
      });
    });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET lote individual con todos sus cultivos por campaña
router.get('/lotes/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const lote = db.prepare(`
      SELECT l.*, s.nombre as sector_nombre, s.tipo as sector_tipo
      FROM pa_lotes l
      JOIN pa_sectores s ON s.id = l.sector_id
      WHERE l.id = ?
    `).get(req.params.id);
    if (!lote) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    // Traer todos los cultivos por campaña
    const cultRows = db.prepare("SELECT campaña, cultivo, mes_siembra, mes_cosecha FROM pa_cultivos_lote WHERE lote_id = ?").all(req.params.id);
    lote.cultivos = {};
    cultRows.forEach(r => { lote.cultivos[r.campaña] = { cultivo: r.cultivo, mes_siembra: r.mes_siembra, mes_cosecha: r.mes_cosecha }; });
    res.json({ ok: true, data: lote });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/lotes', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, sector_id, finca, hectareas, poligono_maps, red_agua, notas, cultivos } = req.body;
  if (!nombre || !sector_id) return res.status(400).json({ ok: false, error: 'Nombre y sector requeridos' });
  try {
    const crearLote = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pa_lotes (nombre, sector_id, finca, hectareas, poligono_maps, red_agua, notas)
        VALUES (?,?,?,?,?,?,?)
      `).run(nombre, sector_id, finca||null, hectareas||0.5, poligono_maps||null, red_agua||null, notas||null);
      const loteId = r.lastInsertRowid;
      // Guardar cultivos por campaña si vienen
      if (cultivos && typeof cultivos === 'object') {
        for (const [campaña, cultivo] of Object.entries(cultivos)) {
          if (!cultivo) continue;
          const campData = db.prepare("SELECT nombre FROM pa_campañas WHERE nombre=?").get(campaña);
          if (!campData) continue;
          const esPerenne = ['Vid','Damasco','Durazno','Ciruela','Manzana'].includes(cultivo) ? 1 : 0;
          db.prepare(`
            INSERT INTO pa_cultivos_lote (lote_id, cultivo, campaña, es_perenne)
            VALUES (?,?,?,?)
            ON CONFLICT(lote_id, campaña) DO UPDATE SET cultivo=excluded.cultivo
          `).run(loteId, cultivo, campaña, esPerenne);
        }
      }
      return loteId;
    });
    const id = crearLote();
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Importar múltiples lotes de una vez (para cuando llegue la planilla)
router.post('/lotes/importar', requireAuth, (req, res) => {
  const db = getDb();
  const { lotes } = req.body; // [{nombre, sector_id, hectareas, cultivo}]
  if (!Array.isArray(lotes) || !lotes.length)
    return res.status(400).json({ ok: false, error: 'Array de lotes requerido' });
  try {
    const campaña = db.prepare("SELECT nombre FROM pa_campañas WHERE activa = 1").get();
    const insertLote = db.prepare("INSERT OR IGNORE INTO pa_lotes (nombre, sector_id, hectareas) VALUES (?,?,?)");
    const insertCultivo = db.prepare(`
      INSERT INTO pa_cultivos_lote (lote_id, cultivo, campaña, es_perenne)
      VALUES (?,?,?,?)
      ON CONFLICT(lote_id, campaña) DO UPDATE SET cultivo = excluded.cultivo
    `);
    let importados = 0;
    const importarTodo = db.transaction(() => {
      for (const l of lotes) {
        if (!l.nombre || !l.sector_id) continue;
        const r = insertLote.run(l.nombre, l.sector_id, l.hectareas || 0.5);
        const loteId = r.lastInsertRowid || db.prepare("SELECT id FROM pa_lotes WHERE nombre=? AND sector_id=?").get(l.nombre, l.sector_id)?.id;
        if (loteId && l.cultivo && campaña) {
          const esPerenne = l.es_perenne ? 1 : 0;
          insertCultivo.run(loteId, l.cultivo, campaña.nombre, esPerenne);
        }
        importados++;
      }
    });
    importarTodo();
    res.json({ ok: true, importados });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Asignar cultivo a un lote por campaña
router.post('/lotes/cultivo', requireAuth, (req, res) => {
  const db = getDb();
  const { lote_id, campaña, cultivo, es_perenne, mes_siembra, mes_cosecha } = req.body;
  if (!lote_id || !campaña) return res.status(400).json({ ok: false, error: 'lote_id y campaña requeridos' });
  try {
    if (!cultivo) {
      db.prepare("DELETE FROM pa_cultivos_lote WHERE lote_id=? AND campaña=?").run(lote_id, campaña);
    } else {
      db.prepare(`
        INSERT INTO pa_cultivos_lote (lote_id, cultivo, campaña, es_perenne, mes_siembra, mes_cosecha)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(lote_id, campaña) DO UPDATE SET
          cultivo=excluded.cultivo, es_perenne=excluded.es_perenne,
          mes_siembra=excluded.mes_siembra, mes_cosecha=excluded.mes_cosecha
      `).run(lote_id, cultivo, campaña, es_perenne ? 1 : 0,
             mes_siembra || null, mes_cosecha || null);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/lotes/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, hectareas, activo, notas, finca, poligono_maps, red_agua } = req.body;
  try {
    const cur = db.prepare("SELECT * FROM pa_lotes WHERE id=?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    db.prepare(`UPDATE pa_lotes SET nombre=?, hectareas=?, activo=?, notas=?, finca=?, poligono_maps=?, red_agua=? WHERE id=?`)
      .run(
        nombre||cur.nombre, hectareas||cur.hectareas,
        activo!==undefined?activo:cur.activo,
        notas!==undefined?notas:cur.notas,
        finca!==undefined?finca:cur.finca,
        poligono_maps!==undefined?poligono_maps:cur.poligono_maps,
        red_agua!==undefined?red_agua:cur.red_agua,
        req.params.id
      );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// INSUMOS (FERTILIZANTES, AGROQUÍMICOS, ETC.)
// ─────────────────────────────────────────────────────────────────────────

router.get('/insumos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { tipo, categoria_principal } = req.query;
    let query = "SELECT * FROM pa_insumos WHERE activo = 1";
    const params = [];
    if (categoria_principal) { query += " AND categoria_principal = ?"; params.push(categoria_principal); }
    if (tipo) { query += " AND tipo = ?"; params.push(tipo); }
    query += " ORDER BY categoria_principal, tipo, nombre";
    res.json({ ok: true, data: db.prepare(query).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/insumos', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo, unidad, stock_minimo, componente_madre, precio_ref_usd, notas, categoria_principal } = req.body;
  if (!nombre || !tipo || !unidad)
    return res.status(400).json({ ok: false, error: 'Nombre, tipo y unidad requeridos' });
  try {
    const r = db.prepare(`
      INSERT INTO pa_insumos (nombre, tipo, unidad, stock_minimo, componente_madre, precio_ref_usd, notas, categoria_principal)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(nombre, tipo, unidad, stock_minimo||0, componente_madre||null, precio_ref_usd||null, notas||null,
           categoria_principal || 'agroinsumos');
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/insumos/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo, unidad, stock_minimo, activo, componente_madre, precio_ref_usd, notas, categoria_principal } = req.body;
  try {
    const cur = db.prepare("SELECT * FROM pa_insumos WHERE id=?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    db.prepare(`UPDATE pa_insumos SET nombre=?, tipo=?, unidad=?, stock_minimo=?, activo=?,
                componente_madre=?, precio_ref_usd=?, notas=?, categoria_principal=? WHERE id=?`)
      .run(nombre||cur.nombre, tipo||cur.tipo, unidad||cur.unidad, stock_minimo??cur.stock_minimo,
           activo!==undefined?activo:cur.activo,
           componente_madre!==undefined?componente_madre:cur.componente_madre,
           precio_ref_usd!==undefined?precio_ref_usd:cur.precio_ref_usd,
           notas!==undefined?notas:cur.notas,
           categoria_principal || cur.categoria_principal,
           req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Upload ficha técnica PDF
router.post('/insumos/:id/ficha', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { filename, data } = req.body; // data = base64
    if (!data) return res.status(400).json({ ok: false, error: 'Sin datos' });
    const dir = path.join(__dirnamePA, '../../data/fichas');
    fs.mkdirSync(dir, { recursive: true });
    const fname = `insumo_${req.params.id}_${Date.now()}.pdf`;
    const fpath = path.join(dir, fname);
    fs.writeFileSync(fpath, Buffer.from(data, 'base64'));
    db.prepare("UPDATE pa_insumos SET ficha_tecnica_path=? WHERE id=?").run('/data/fichas/'+fname, req.params.id);
    res.json({ ok: true, path: '/data/fichas/'+fname });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});


// ─────────────────────────────────────────────────────────────────────────
// PROVEEDORES DE INSUMOS
// ─────────────────────────────────────────────────────────────────────────

router.get('/proveedores', requireAuth, (req, res) => {
  const db = getDb();
  try {
    res.json({ ok: true, data: db.prepare("SELECT * FROM pa_proveedores WHERE activo=1 ORDER BY razon_social").all() });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/proveedores', requireAuth, (req, res) => {
  const db = getDb();
  const { razon_social, cuit, telefono, email } = req.body;
  if (!razon_social) return res.status(400).json({ ok: false, error: 'Razón social requerida' });
  try {
    const r = db.prepare("INSERT INTO pa_proveedores (razon_social, cuit, telefono, email) VALUES (?,?,?,?)")
      .run(razon_social, cuit||null, telefono||null, email||null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// COMPRAS DE INSUMOS
// ─────────────────────────────────────────────────────────────────────────

// Historial de compras por insumo_id o por componente_madre
router.get('/insumos/historial', requireAuth, (req, res) => {
  const db = getDb();
  const { insumo_id, componente } = req.query;
  try {
    let rows;
    if (insumo_id) {
      rows = db.prepare(`
        SELECT ci.cantidad, ci.precio_unit, ci.subtotal,
               c.fecha, c.nro_factura, c.tipo_comprobante,
               COALESCE(p.razon_social, c.proveedor_txt, '—') as proveedor,
               i.nombre as insumo_nombre, i.unidad, i.componente_madre
        FROM pa_compras_items ci
        JOIN pa_compras c ON c.id = ci.compra_id
        JOIN pa_insumos i ON i.id = ci.insumo_id
        LEFT JOIN pa_proveedores p ON p.id = c.proveedor_id
        WHERE ci.insumo_id = ?
        ORDER BY c.fecha DESC LIMIT 20
      `).all(insumo_id);
    } else if (componente) {
      rows = db.prepare(`
        SELECT ci.cantidad, ci.precio_unit, ci.subtotal,
               c.fecha, c.nro_factura, c.tipo_comprobante,
               COALESCE(p.razon_social, c.proveedor_txt, '—') as proveedor,
               i.nombre as insumo_nombre, i.unidad, i.componente_madre
        FROM pa_compras_items ci
        JOIN pa_compras c ON c.id = ci.compra_id
        JOIN pa_insumos i ON i.id = ci.insumo_id
        LEFT JOIN pa_proveedores p ON p.id = c.proveedor_id
        WHERE i.componente_madre = ?
        ORDER BY c.fecha DESC LIMIT 20
      `).all(componente);
    } else {
      return res.status(400).json({ ok: false, error: 'insumo_id o componente requerido' });
    }
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── LECTOR IA DE REMITOS (llama a Anthropic desde el servidor) ────────────
router.post('/leer-remito', requireAuth, async (req, res) => {
  const { imagen_b64, media_type } = req.body;
  if (!imagen_b64) return res.status(400).json({ ok: false, error: 'imagen_b64 requerida' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'API key no configurada' });

  try {
    const db = getDb();
    const insumos = db.prepare('SELECT nombre, componente_madre FROM pa_insumos WHERE activo=1 ORDER BY nombre').all();
    const insNombres = insumos.map(i => i.nombre).join(', ');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: media_type || 'image/jpeg', data: imagen_b64 }
            },
            {
              type: 'text',
              text: `Analizá este remito o factura de insumos agrícolas.
Devolvé SOLO un JSON válido sin markdown ni comentarios:
{
  "tipo_comprobante": "factura|remito|ticket|otro",
  "nro_comprobante": "número del documento o null",
  "fecha": "YYYY-MM-DD o null",
  "proveedor": "nombre del proveedor o null",
  "items": [
    {
      "descripcion": "nombre del producto tal como aparece",
      "cantidad": número,
      "unidad": "kg|lt|unidad",
      "precio_unitario": número o null
    }
  ]
}
Insumos conocidos en el sistema (para ayudar a identificar): ${insNombres}
Solo devolvé el JSON, sin texto adicional.`
            }
          ]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ ok: false, error: data.error?.message || 'Error de API' });
    }

    const txt = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch(e) { return res.status(422).json({ ok: false, error: 'No se pudo parsear la respuesta', raw: txt }); }

    res.json({ ok: true, data: parsed });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/compras', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { campaña_id, desde, hasta } = req.query;
    let query = `
      SELECT c.*, p.razon_social as proveedor_nombre,
             ca.nombre as campaña_nombre
      FROM pa_compras c
      LEFT JOIN pa_proveedores p ON p.id = c.proveedor_id
      LEFT JOIN pa_campañas ca ON ca.id = c.campaña_id
      WHERE 1=1
    `;
    const params = [];
    if (campaña_id) { query += " AND c.campaña_id = ?"; params.push(campaña_id); }
    if (desde) { query += " AND c.fecha >= ?"; params.push(desde); }
    if (hasta) { query += " AND c.fecha <= ?"; params.push(hasta); }
    query += " ORDER BY c.fecha DESC";
    const compras = db.prepare(query).all(...params);
    // Agregar items a cada compra
    const getItems = db.prepare(`
      SELECT ci.*, i.nombre as insumo_nombre, i.unidad
      FROM pa_compras_items ci
      JOIN pa_insumos i ON i.id = ci.insumo_id
      WHERE ci.compra_id = ?
    `);
    const data = compras.map(c => ({ ...c, items: getItems.all(c.id) }));
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/compras', requireAuth, (req, res) => {
  const db = getDb();
  const { fecha, proveedor_id, proveedor_txt, nro_factura, tipo_comprobante, campaña_id, items, notas, remito_foto_b64 } = req.body;
  if (!items?.length) return res.status(400).json({ ok: false, error: 'Debe incluir al menos un item' });
  try {
    let subtotal = 0;
    for (const it of items) { subtotal += (it.cantidad * it.precio_unit); }
    const iva_monto = req.body.iva_monto || 0;
    const total = subtotal + Number(iva_monto);

    // Guardar foto remito si viene
    let remito_foto_path = null;
    if (remito_foto_b64) {
      const dir = path.join(__dirnamePA, '../../data/remitos_pa');
      fs.mkdirSync(dir, { recursive: true });
      const fname = `remito_${Date.now()}.jpg`;
      fs.writeFileSync(path.join(dir, fname), Buffer.from(remito_foto_b64, 'base64'));
      remito_foto_path = '/data/remitos_pa/' + fname;
    }

    const nuevaCompra = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pa_compras (fecha, proveedor_id, proveedor_txt, nro_factura, tipo_comprobante, campaña_id, subtotal, iva_monto, total, notas, remito_foto_path)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(fecha||new Date().toISOString().slice(0,10), proveedor_id||null, proveedor_txt||null,
             nro_factura||null, tipo_comprobante||'factura', campaña_id||null, subtotal, iva_monto, total, notas||null, remito_foto_path);
      const compraId = r.lastInsertRowid;
      for (const it of items) {
        const sub = it.cantidad * it.precio_unit;
        db.prepare("INSERT INTO pa_compras_items (compra_id, insumo_id, cantidad, precio_unit, subtotal) VALUES (?,?,?,?,?)")
          .run(compraId, it.insumo_id, it.cantidad, it.precio_unit, sub);
        db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual + ? WHERE id = ?").run(it.cantidad, it.insumo_id);
        db.prepare("INSERT INTO pa_movimientos_stock (fecha, insumo_id, tipo, cantidad, motivo, referencia_id) VALUES (?,?,?,?,?,?)")
          .run(fecha||new Date().toISOString().slice(0,10), it.insumo_id, 'entrada', it.cantidad, 'compra', compraId);
      }
      return compraId;
    });
    const id = nuevaCompra();
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// ÓRDENES DE APLICACIÓN
// ─────────────────────────────────────────────────────────────────────────

router.get('/ordenes', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { estado, campaña_id } = req.query;
    let query = `
      SELECT o.*, u.nombre as creada_por_nombre, ca.nombre as campaña_nombre,
             ua.nombre as asignado_nombre
      FROM pa_ordenes o
      LEFT JOIN usuarios u ON u.id = o.creada_por
      LEFT JOIN pa_campañas ca ON ca.id = o.campaña_id
      LEFT JOIN usuarios ua ON ua.id = o.asignado_a
      WHERE 1=1
    `;
    const params = [];
    if (estado) { query += " AND o.estado = ?"; params.push(estado); }
    if (campaña_id) { query += " AND o.campaña_id = ?"; params.push(campaña_id); }
    query += " ORDER BY o.fecha_orden DESC";
    const ordenes = db.prepare(query).all(...params);

    // Enriquecer cada orden con lotes e items
    const getLotes = db.prepare(`
      SELECT ol.lote_id, l.nombre as lote_nombre, l.hectareas,
             s.nombre as sector_nombre
      FROM pa_ordenes_lotes ol
      JOIN pa_lotes l ON l.id = ol.lote_id
      JOIN pa_sectores s ON s.id = l.sector_id
      WHERE ol.orden_id = ?
    `);
    const getItems = db.prepare(`
      SELECT oi.*, i.nombre as insumo_nombre, i.unidad
      FROM pa_ordenes_items oi
      JOIN pa_insumos i ON i.id = oi.insumo_id
      WHERE oi.orden_id = ?
    `);

    const data = ordenes.map(o => ({
      ...o,
      lotes: getLotes.all(o.id),
      items: getItems.all(o.id)
    }));
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/ordenes/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const orden = db.prepare(`
      SELECT o.*, u.nombre as creada_por_nombre, ca.nombre as campaña_nombre
      FROM pa_ordenes o
      LEFT JOIN usuarios u ON u.id = o.creada_por
      LEFT JOIN pa_campañas ca ON ca.id = o.campaña_id
      WHERE o.id = ?
    `).get(req.params.id);
    if (!orden) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });

    orden.lotes = db.prepare(`
      SELECT ol.lote_id, l.nombre as lote_nombre, l.hectareas,
             s.nombre as sector_nombre,
             cl.cultivo as cultivo
      FROM pa_ordenes_lotes ol
      JOIN pa_lotes l ON l.id = ol.lote_id
      JOIN pa_sectores s ON s.id = l.sector_id
      LEFT JOIN pa_cultivos_lote cl ON cl.lote_id = l.id
        AND cl.campaña = (SELECT nombre FROM pa_campañas WHERE activa=1 LIMIT 1)
      WHERE ol.orden_id = ?
    `).all(req.params.id);

    orden.items = db.prepare(`
      SELECT oi.*, i.nombre as insumo_nombre, i.unidad, i.stock_actual
      FROM pa_ordenes_items oi
      JOIN pa_insumos i ON i.id = oi.insumo_id
      WHERE oi.orden_id = ?
    `).all(req.params.id);

    orden.aplicaciones = db.prepare(`
      SELECT a.*, l.nombre as lote_nombre, i.nombre as insumo_nombre, i.unidad,
             u.nombre as ejecutado_por_nombre
      FROM pa_aplicaciones a
      JOIN pa_lotes l ON l.id = a.lote_id
      JOIN pa_insumos i ON i.id = a.insumo_id
      LEFT JOIN usuarios u ON u.id = a.ejecutado_por
      WHERE a.orden_id = ?
      ORDER BY a.fecha_real DESC
    `).all(req.params.id);

    res.json({ ok: true, data: orden });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/ordenes', requireAuth, (req, res) => {
  const db = getDb();
  const { campaña_id, fecha_orden, fecha_propuesta, tipo_aplicacion, objetivo, notas, lotes, items, asignado_a } = req.body;
  if (!lotes?.length || !items?.length)
    return res.status(400).json({ ok: false, error: 'Debe incluir lotes e items' });
  try {
    const crearOrden = db.transaction(() => {
      const n = db.prepare("SELECT COUNT(*) as n FROM pa_ordenes").get().n + 1;
      const nro = `OA-${String(n).padStart(5, '0')}`;
      const r = db.prepare(`
        INSERT INTO pa_ordenes (nro_orden, campaña_id, fecha_orden, fecha_propuesta, creada_por, tipo_aplicacion, objetivo, notas, estado, asignado_a)
        VALUES (?,?,?,?,?,?,?,?,'emitida',?)
      `).run(nro, campaña_id||null, fecha_orden||new Date().toISOString().slice(0,10),
             fecha_propuesta||null, req.user.id, tipo_aplicacion||null, objetivo||null, notas||null, asignado_a||null);
      const ordenId = r.lastInsertRowid;
      for (const loteId of lotes) {
        db.prepare("INSERT INTO pa_ordenes_lotes (orden_id, lote_id) VALUES (?,?)").run(ordenId, loteId);
      }
      for (const it of items) {
        db.prepare("INSERT INTO pa_ordenes_items (orden_id, insumo_id, dosis, unidad_dosis, notas) VALUES (?,?,?,?,?)")
          .run(ordenId, it.insumo_id, it.dosis, it.unidad_dosis, it.notas||null);
      }
      return { id: ordenId, nro_orden: nro };
    });
    const result = crearOrden();
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/ordenes/:id/estado', requireAuth, (req, res) => {
  const db = getDb();
  const { estado } = req.body;
  const estadosValidos = ['borrador','emitida','en_ejecucion','ejecutada','parcial','anulada'];
  if (!estadosValidos.includes(estado))
    return res.status(400).json({ ok: false, error: 'Estado inválido' });
  try {
    db.prepare("UPDATE pa_ordenes SET estado = ? WHERE id = ?").run(estado, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// APLICACIONES (ejecución real de una orden)
// ─────────────────────────────────────────────────────────────────────────

router.post('/aplicaciones', requireAuth, (req, res) => {
  const db = getDb();
  const { orden_id, lote_id, insumo_id, fecha_real, cantidad_real, ejecutado_txt, notas } = req.body;
  if (!orden_id || !lote_id || !insumo_id || !cantidad_real)
    return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios' });
  try {
    const registrar = db.transaction(() => {
      // Obtener precio unitario promedio del stock para costear
      const insumo = db.prepare("SELECT * FROM pa_insumos WHERE id=?").get(insumo_id);
      if (!insumo) throw new Error('Insumo no encontrado');

      // Calcular costo unitario (última compra)
      const ultimaCompra = db.prepare(`
        SELECT ci.precio_unit FROM pa_compras_items ci
        JOIN pa_compras c ON c.id = ci.compra_id
        WHERE ci.insumo_id = ?
        ORDER BY c.fecha DESC LIMIT 1
      `).get(insumo_id);
      const costoUnit = ultimaCompra?.precio_unit || 0;
      const costoTotal = costoUnit * cantidad_real;

      const r = db.prepare(`
        INSERT INTO pa_aplicaciones
          (orden_id, lote_id, insumo_id, fecha_real, cantidad_real, ejecutado_por, ejecutado_txt, costo_unitario, costo_total, notas)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(orden_id, lote_id, insumo_id,
             fecha_real || new Date().toISOString().slice(0,10),
             cantidad_real, req.user.id, ejecutado_txt||null, costoUnit, costoTotal, notas||null);

      // Descontar stock
      db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual - ? WHERE id = ?")
        .run(cantidad_real, insumo_id);

      // Movimiento de stock
      db.prepare(`
        INSERT INTO pa_movimientos_stock (fecha, insumo_id, tipo, cantidad, motivo, referencia_id)
        VALUES (?,?,?,?,?,?)
      `).run(fecha_real || new Date().toISOString().slice(0,10), insumo_id, 'salida', cantidad_real, 'aplicacion', r.lastInsertRowid);

      // Registrar costo por lote
      const orden = db.prepare("SELECT campaña_id FROM pa_ordenes WHERE id=?").get(orden_id);
      if (orden?.campaña_id && costoTotal > 0) {
        const insumoData = db.prepare("SELECT tipo FROM pa_insumos WHERE id=?").get(insumo_id);
        const categoria = insumoData?.tipo === 'fertilizante' ? 'fertilizante' : 'agroquimico';
        db.prepare(`
          INSERT INTO pa_costos_lote (lote_id, campaña_id, categoria, referencia_id, fecha, monto, descripcion)
          VALUES (?,?,?,?,?,?,?)
        `).run(lote_id, orden.campaña_id, categoria, r.lastInsertRowid,
               fecha_real || new Date().toISOString().slice(0,10), costoTotal,
               `Aplicación OA: ${insumo?.nombre}`);
      }

      // Actualizar estado de orden
      const totalLotes = db.prepare("SELECT COUNT(*) as n FROM pa_ordenes_lotes WHERE orden_id=?").get(orden_id).n;
      const lotesAplicados = db.prepare("SELECT COUNT(DISTINCT lote_id) as n FROM pa_aplicaciones WHERE orden_id=?").get(orden_id).n;
      const nuevoEstado = lotesAplicados >= totalLotes ? 'ejecutada' : 'en_ejecucion';
      db.prepare("UPDATE pa_ordenes SET estado=? WHERE id=?").run(nuevoEstado, orden_id);

      return r.lastInsertRowid;
    });

    const id = registrar();
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// COSTOS POR LOTE (reportes)
// ─────────────────────────────────────────────────────────────────────────

router.get('/costos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { campaña_id, lote_id } = req.query;

    // Si se pide un lote específico, detalle completo
    if (lote_id) {
      const detalle = db.prepare(`
        SELECT cl.*, l.nombre as lote_nombre, l.hectareas,
               ca.nombre as campaña_nombre
        FROM pa_costos_lote cl
        JOIN pa_lotes l ON l.id = cl.lote_id
        JOIN pa_campañas ca ON ca.id = cl.campaña_id
        WHERE cl.lote_id = ? ${campaña_id ? 'AND cl.campaña_id = ?' : ''}
        ORDER BY cl.fecha DESC
      `).all(...(campaña_id ? [lote_id, campaña_id] : [lote_id]));
      return res.json({ ok: true, data: detalle });
    }

    // Resumen por lote
    const campañaFiltro = campaña_id || db.prepare("SELECT id FROM pa_campañas WHERE activa=1").get()?.id;
    const resumen = db.prepare(`
      SELECT
        l.id as lote_id,
        l.nombre as lote_nombre,
        l.hectareas,
        s.nombre as sector_nombre,
        s.tipo as sector_tipo,
        ca.nombre as campaña_nombre,
        SUM(cl.monto) as costo_total,
        SUM(cl.monto) / NULLIF(l.hectareas, 0) as costo_por_ha,
        GROUP_CONCAT(DISTINCT cl.categoria) as categorias
      FROM pa_costos_lote cl
      JOIN pa_lotes l ON l.id = cl.lote_id
      JOIN pa_sectores s ON s.id = l.sector_id
      JOIN pa_campañas ca ON ca.id = cl.campaña_id
      WHERE cl.campaña_id = ?
      GROUP BY l.id, cl.campaña_id
      ORDER BY s.nombre, l.nombre
    `).all(campañaFiltro);

    // Total por sector
    const porSector = db.prepare(`
      SELECT
        s.nombre as sector_nombre,
        s.tipo as sector_tipo,
        SUM(cl.monto) as costo_total,
        SUM(l.hectareas) as hectareas_total,
        SUM(cl.monto) / NULLIF(SUM(l.hectareas), 0) as costo_por_ha
      FROM pa_costos_lote cl
      JOIN pa_lotes l ON l.id = cl.lote_id
      JOIN pa_sectores s ON s.id = l.sector_id
      WHERE cl.campaña_id = ?
      GROUP BY s.id
      ORDER BY s.nombre
    `).all(campañaFiltro);

    res.json({ ok: true, data: resumen, por_sector: porSector });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// STOCK — consulta general
// ─────────────────────────────────────────────────────────────────────────

router.get('/stock', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT i.*,
        (SELECT SUM(cantidad) FROM pa_movimientos_stock WHERE insumo_id=i.id AND tipo='entrada') as total_entradas,
        (SELECT SUM(cantidad) FROM pa_movimientos_stock WHERE insumo_id=i.id AND tipo='salida') as total_salidas
      FROM pa_insumos i
      WHERE i.activo = 1
      ORDER BY i.tipo, i.nombre
    `).all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Dashboard resumen del día
router.get('/dashboard', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const campaña = db.prepare("SELECT * FROM pa_campañas WHERE activa=1").get();
    const hoy = new Date().toISOString().slice(0,10);
    const data = {
      campaña,
      insumos_bajo_stock: db.prepare("SELECT COUNT(*) as n FROM pa_insumos WHERE activo=1 AND stock_actual <= stock_minimo AND stock_minimo > 0").get().n,
      ordenes_pendientes: db.prepare("SELECT COUNT(*) as n FROM pa_ordenes WHERE estado IN ('emitida','en_ejecucion')").get().n,
      ordenes_hoy:        db.prepare("SELECT COUNT(*) as n FROM pa_ordenes WHERE fecha_orden = ?").get(hoy).n,
      aplicaciones_hoy:   db.prepare("SELECT COUNT(*) as n FROM pa_aplicaciones WHERE fecha_real = ?").get(hoy).n,
      total_lotes:        db.prepare("SELECT COUNT(*) as n FROM pa_lotes WHERE activo=1").get().n,
      costo_campaña:      db.prepare("SELECT COALESCE(SUM(monto),0) as total FROM pa_costos_lote WHERE campaña_id=?").get(campaña?.id)?.total || 0,
    };
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════
// COMBUSTIBLE
// ═════════════════════════════════════════════════════════════════════════

// ── Tanques ────────────────────────────────────────────────────────────────
router.get('/combustible/tanques', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare("SELECT * FROM pa_combustible_tanques WHERE activo=1 ORDER BY tipo").all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/combustible/tanques/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { capacidad_lt, ubicacion, notas } = req.body;
  try {
    const curr = db.prepare("SELECT * FROM pa_combustible_tanques WHERE id=?").get(req.params.id);
    if (!curr) return res.status(404).json({ ok: false, error: 'Tanque no encontrado' });
    db.prepare("UPDATE pa_combustible_tanques SET capacidad_lt=?, ubicacion=?, notas=? WHERE id=?")
      .run(
        capacidad_lt !== undefined ? capacidad_lt : curr.capacidad_lt,
        ubicacion !== undefined ? ubicacion : curr.ubicacion,
        notas !== undefined ? notas : curr.notas,
        req.params.id
      );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Vehículos ──────────────────────────────────────────────────────────────
router.get('/combustible/vehiculos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { combustible, incluir_inactivos } = req.query;
    let q = "SELECT * FROM pa_vehiculos WHERE 1=1";
    const params = [];
    if (!incluir_inactivos) q += " AND activo=1";
    if (combustible) { q += " AND combustible=?"; params.push(combustible); }
    q += " ORDER BY tipo, identificacion";
    res.json({ ok: true, data: db.prepare(q).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/combustible/vehiculos', requireAuth, (req, res) => {
  const db = getDb();
  const { tipo, identificacion, marca_modelo, combustible, tiene_horometro,
          horas_actuales, km_actuales, notas } = req.body;
  if (!tipo || !identificacion || !combustible)
    return res.status(400).json({ ok: false, error: 'tipo, identificacion y combustible requeridos' });
  if (!['tractor','camioneta','moto','otro'].includes(tipo))
    return res.status(400).json({ ok: false, error: 'tipo inválido' });
  if (!['gasoil','nafta'].includes(combustible))
    return res.status(400).json({ ok: false, error: 'combustible inválido' });
  try {
    const r = db.prepare(`INSERT INTO pa_vehiculos
        (tipo, identificacion, marca_modelo, combustible, tiene_horometro, horas_actuales, km_actuales, notas)
        VALUES (?,?,?,?,?,?,?,?)`)
      .run(tipo, identificacion.trim(), marca_modelo || null, combustible,
           tiene_horometro ? 1 : 0, horas_actuales || 0, km_actuales || 0, notas || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un vehículo con esa identificación' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/combustible/vehiculos/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { tipo, identificacion, marca_modelo, combustible, tiene_horometro,
          horas_actuales, km_actuales, activo, notas } = req.body;
  try {
    const curr = db.prepare("SELECT * FROM pa_vehiculos WHERE id=?").get(req.params.id);
    if (!curr) return res.status(404).json({ ok: false, error: 'Vehículo no encontrado' });
    db.prepare(`UPDATE pa_vehiculos SET
        tipo=?, identificacion=?, marca_modelo=?, combustible=?, tiene_horometro=?,
        horas_actuales=?, km_actuales=?, activo=?, notas=?
        WHERE id=?`)
      .run(
        tipo || curr.tipo,
        identificacion || curr.identificacion,
        marca_modelo !== undefined ? marca_modelo : curr.marca_modelo,
        combustible || curr.combustible,
        tiene_horometro !== undefined ? (tiene_horometro ? 1 : 0) : curr.tiene_horometro,
        horas_actuales !== undefined ? horas_actuales : curr.horas_actuales,
        km_actuales !== undefined ? km_actuales : curr.km_actuales,
        activo !== undefined ? (activo ? 1 : 0) : curr.activo,
        notas !== undefined ? notas : curr.notas,
        req.params.id
      );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/combustible/vehiculos/:id/historial', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT m.*, l.nombre as lote_nombre, l.finca as lote_finca,
             u.nombre as cargado_por_nombre
      FROM pa_combustible_movimientos m
      LEFT JOIN pa_lotes l ON l.id=m.lote_id
      LEFT JOIN usuarios u ON u.id=m.cargado_por
      WHERE m.vehiculo_id=?
      ORDER BY m.fecha DESC, m.id DESC
      LIMIT 200
    `).all(req.params.id);

    // Calcular lt/hora entre cargas con horómetro (ordenadas cronológicamente)
    const conHoras = data.filter(d => d.horas_horometro != null).slice().sort((a,b) => a.id - b.id);
    for (let i = 1; i < conHoras.length; i++) {
      const deltaH = conHoras[i].horas_horometro - conHoras[i-1].horas_horometro;
      if (deltaH > 0) {
        const ltph = +(conHoras[i].litros / deltaH).toFixed(2);
        const target = data.find(d => d.id === conHoras[i].id);
        if (target) target.lt_por_hora = ltph;
      }
    }
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Movimientos ────────────────────────────────────────────────────────────
router.get('/combustible/movimientos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { tipo, vehiculo_id, tanque_id, estado, desde, hasta, lote_id, limit } = req.query;
    let q = `
      SELECT m.*,
        v.identificacion as vehiculo_txt, v.tipo as vehiculo_tipo,
        t.nombre as tanque_nombre,
        l.nombre as lote_nombre, l.finca as lote_finca,
        u.nombre as cargado_por_nombre,
        ur.nombre as revisado_por_nombre
      FROM pa_combustible_movimientos m
      LEFT JOIN pa_vehiculos v ON v.id=m.vehiculo_id
      LEFT JOIN pa_combustible_tanques t ON t.id=m.tanque_id
      LEFT JOIN pa_lotes l ON l.id=m.lote_id
      LEFT JOIN usuarios u ON u.id=m.cargado_por
      LEFT JOIN usuarios ur ON ur.id=m.revisado_por
      WHERE 1=1
    `;
    const params = [];
    if (tipo) { q += " AND m.tipo_movimiento=?"; params.push(tipo); }
    if (vehiculo_id) { q += " AND m.vehiculo_id=?"; params.push(vehiculo_id); }
    if (tanque_id) { q += " AND m.tanque_id=?"; params.push(tanque_id); }
    if (estado) { q += " AND m.estado_revision=?"; params.push(estado); }
    if (lote_id) { q += " AND m.lote_id=?"; params.push(lote_id); }
    if (desde) { q += " AND m.fecha>=?"; params.push(desde); }
    if (hasta) { q += " AND m.fecha<=?"; params.push(hasta); }
    q += " ORDER BY m.fecha DESC, m.id DESC LIMIT ?";
    params.push(parseInt(limit) || 200);
    res.json({ ok: true, data: db.prepare(q).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/combustible/movimientos', requireAuth, (req, res) => {
  const db = getDb();
  const {
    fecha, tipo_movimiento, tanque_id, vehiculo_id, combustible,
    litros, precio_unitario, moneda, precio_total,
    proveedor_id, proveedor_txt, tipo_comprobante, nro_comprobante, foto_b64,
    lote_id, orden_id, horas_horometro, km_vehiculo, notas
  } = req.body;

  if (!tipo_movimiento || !combustible || litros == null)
    return res.status(400).json({ ok: false, error: 'tipo_movimiento, combustible y litros requeridos' });
  if (!['gasoil','nafta'].includes(combustible))
    return res.status(400).json({ ok: false, error: 'combustible inválido' });
  if (!['carga_tanque','consumo_tanque','consumo_estacion','ajuste_varilla'].includes(tipo_movimiento))
    return res.status(400).json({ ok: false, error: 'tipo_movimiento inválido' });
  if (tipo_movimiento !== 'ajuste_varilla' && !(litros > 0))
    return res.status(400).json({ ok: false, error: 'litros debe ser > 0' });

  // Permiso específico para "consumo_estacion": solo admin/operador o usuarios con la sección
  if (tipo_movimiento === 'consumo_estacion') {
    const u = req.user || {};
    const rolOk = u.rol === 'admin' || u.rol === 'operador';
    const seccOk = Array.isArray(u.secciones) && (u.secciones.includes('*') || u.secciones.includes('combustible_estacion'));
    if (!rolOk && !seccOk) {
      return res.status(403).json({ ok: false, error: 'No tenés permiso para registrar cargas en estación' });
    }
  }

  try {
    // Guardar foto si viene (dentro de data/scout para aprovechar el estático existente)
    let fotoPath = null;
    if (foto_b64) {
      const dir = path.join(__dirnamePA, '../../data/scout/combustible');
      fs.mkdirSync(dir, { recursive: true });
      const fname = `comb_${Date.now()}_${Math.floor(Math.random()*9999)}.jpg`;
      fs.writeFileSync(path.join(dir, fname),
        Buffer.from(String(foto_b64).replace(/^data:.*?;base64,/,''), 'base64'));
      fotoPath = `/data/scout/combustible/${fname}`;
    }

    // Operarios (rol 'campo') cargan como pendiente; admin/operador quedan revisados
    const esCampo = req.user.rol === 'campo';
    const estado = esCampo ? 'pendiente' : 'revisado';
    const revisadoPor = esCampo ? null : req.user.id;
    const revisadoEn = esCampo ? null : new Date().toISOString();

    const tx = db.transaction(() => {
      const ins = db.prepare(`
        INSERT INTO pa_combustible_movimientos
          (fecha, tipo_movimiento, tanque_id, vehiculo_id, combustible, litros,
           precio_unitario, moneda, precio_total, proveedor_id, proveedor_txt,
           tipo_comprobante, nro_comprobante, foto_path, lote_id, orden_id,
           horas_horometro, km_vehiculo, cargado_por, estado_revision,
           revisado_por, revisado_en, notas)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        fecha || new Date().toISOString().slice(0,10),
        tipo_movimiento,
        tanque_id || null,
        vehiculo_id || null,
        combustible,
        Number(litros),
        Number(precio_unitario) || 0,
        moneda || 'ARS',
        Number(precio_total) || 0,
        proveedor_id || null,
        proveedor_txt || null,
        tipo_comprobante || null,
        nro_comprobante || null,
        fotoPath,
        lote_id || null,
        orden_id || null,
        horas_horometro != null ? Number(horas_horometro) : null,
        km_vehiculo != null ? Number(km_vehiculo) : null,
        req.user.id,
        estado,
        revisadoPor,
        revisadoEn,
        notas || null
      );
      const movId = ins.lastInsertRowid;

      // Stock del tanque
      if (tipo_movimiento === 'carga_tanque' && tanque_id) {
        db.prepare("UPDATE pa_combustible_tanques SET stock_actual = stock_actual + ? WHERE id=?").run(Number(litros), tanque_id);
      } else if (tipo_movimiento === 'consumo_tanque' && tanque_id) {
        db.prepare("UPDATE pa_combustible_tanques SET stock_actual = stock_actual - ? WHERE id=?").run(Number(litros), tanque_id);
      } else if (tipo_movimiento === 'ajuste_varilla' && tanque_id) {
        // En ajuste, 'litros' es la DIFERENCIA (+ sube stock, - baja)
        db.prepare("UPDATE pa_combustible_tanques SET stock_actual = stock_actual + ? WHERE id=?").run(Number(litros), tanque_id);
      }

      // Horómetro / km del vehículo
      if (vehiculo_id) {
        if (horas_horometro != null)
          db.prepare("UPDATE pa_vehiculos SET horas_actuales=? WHERE id=?").run(Number(horas_horometro), vehiculo_id);
        if (km_vehiculo != null)
          db.prepare("UPDATE pa_vehiculos SET km_actuales=? WHERE id=?").run(Number(km_vehiculo), vehiculo_id);
      }

      // Imputar costo a lote si corresponde (consumo con lote asignado)
      if (lote_id && Number(precio_total) > 0 &&
          ['consumo_tanque','consumo_estacion'].includes(tipo_movimiento)) {
        const camp = db.prepare("SELECT id FROM pa_campañas WHERE activa=1 LIMIT 1").get();
        if (camp) {
          db.prepare(`INSERT INTO pa_costos_lote
              (lote_id, campaña_id, categoria, referencia_id, fecha, monto, descripcion)
              VALUES (?,?,'otros',?,?,?,?)`)
            .run(lote_id, camp.id, movId,
                 fecha || new Date().toISOString().slice(0,10),
                 Number(precio_total),
                 `Combustible ${combustible} · ${litros} lt`);
        }
      }

      return movId;
    });

    res.json({ ok: true, id: tx() });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/combustible/movimientos/:id/revisar', requireAuth, (req, res) => {
  const db = getDb();
  const { notas_revision } = req.body;
  try {
    db.prepare(`UPDATE pa_combustible_movimientos
      SET estado_revision='revisado', revisado_por=?, revisado_en=?,
          notas_revision=COALESCE(?, notas_revision)
      WHERE id=?`)
      .run(req.user.id, new Date().toISOString(), notas_revision || null, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/combustible/movimientos/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const m = db.prepare("SELECT * FROM pa_combustible_movimientos WHERE id=?").get(req.params.id);
    if (!m) return res.status(404).json({ ok: false, error: 'Movimiento no encontrado' });
    const tx = db.transaction(() => {
      // Revertir stock
      if (m.tipo_movimiento === 'carga_tanque' && m.tanque_id) {
        db.prepare("UPDATE pa_combustible_tanques SET stock_actual = stock_actual - ? WHERE id=?").run(m.litros, m.tanque_id);
      } else if (m.tipo_movimiento === 'consumo_tanque' && m.tanque_id) {
        db.prepare("UPDATE pa_combustible_tanques SET stock_actual = stock_actual + ? WHERE id=?").run(m.litros, m.tanque_id);
      } else if (m.tipo_movimiento === 'ajuste_varilla' && m.tanque_id) {
        db.prepare("UPDATE pa_combustible_tanques SET stock_actual = stock_actual - ? WHERE id=?").run(m.litros, m.tanque_id);
      }
      // Borrar costo imputado
      db.prepare("DELETE FROM pa_costos_lote WHERE categoria='otros' AND referencia_id=?").run(m.id);
      // Borrar movimiento
      db.prepare("DELETE FROM pa_combustible_movimientos WHERE id=?").run(m.id);
    });
    tx();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Dashboard ──────────────────────────────────────────────────────────────
router.get('/combustible/dashboard', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const tanques = db.prepare("SELECT * FROM pa_combustible_tanques WHERE activo=1 ORDER BY tipo").all();
    const pendientes = db.prepare("SELECT COUNT(*) as n FROM pa_combustible_movimientos WHERE estado_revision='pendiente'").get().n;

    const hoy = new Date();
    const mesIni = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0,10);

    const gastoMes = db.prepare(`
      SELECT combustible, moneda,
             COALESCE(SUM(precio_total),0) as total,
             COALESCE(SUM(litros),0) as litros
      FROM pa_combustible_movimientos
      WHERE tipo_movimiento IN ('carga_tanque','consumo_estacion')
        AND fecha >= ?
      GROUP BY combustible, moneda
    `).all(mesIni);

    const topVehiculos = db.prepare(`
      SELECT v.id, v.identificacion, v.tipo, v.combustible,
             COALESCE(SUM(m.litros),0) as litros,
             COALESCE(SUM(m.precio_total),0) as gasto
      FROM pa_combustible_movimientos m
      JOIN pa_vehiculos v ON v.id=m.vehiculo_id
      WHERE m.tipo_movimiento IN ('consumo_tanque','consumo_estacion')
        AND m.fecha >= ?
      GROUP BY v.id
      ORDER BY litros DESC
      LIMIT 5
    `).all(mesIni);

    const ultimosPendientes = db.prepare(`
      SELECT m.id, m.fecha, m.tipo_movimiento, m.combustible, m.litros,
             v.identificacion as vehiculo_txt, u.nombre as cargado_por_nombre
      FROM pa_combustible_movimientos m
      LEFT JOIN pa_vehiculos v ON v.id=m.vehiculo_id
      LEFT JOIN usuarios u ON u.id=m.cargado_por
      WHERE m.estado_revision='pendiente'
      ORDER BY m.creado_en DESC
      LIMIT 10
    `).all();

    res.json({ ok: true, data: {
      tanques, pendientes,
      gasto_mes: gastoMes,
      top_vehiculos: topVehiculos,
      ultimos_pendientes: ultimosPendientes
    }});
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Lector IA: ticket/remito de combustible ────────────────────────────────
router.post('/combustible/leer-ticket', requireAuth, async (req, res) => {
  const { imagen_b64, media_type } = req.body;
  if (!imagen_b64) return res.status(400).json({ ok: false, error: 'imagen_b64 requerida' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'API key no configurada' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: imagen_b64 } },
            { type: 'text', text: `Analizá este ticket, factura o remito de combustible.
Devolvé SOLO un JSON válido sin markdown ni comentarios:
{
  "tipo_comprobante": "factura|remito|ticket|otro",
  "nro_comprobante": "número o null",
  "fecha": "YYYY-MM-DD o null",
  "proveedor": "YPF, Shell, Axion, u otro proveedor (string o null)",
  "combustible": "gasoil|nafta",
  "litros": número,
  "precio_unitario": número o null,
  "precio_total": número o null,
  "moneda": "ARS|USD"
}
Solo devolvé el JSON, sin texto adicional.` }
          ]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok)
      return res.status(500).json({ ok: false, error: data.error?.message || 'Error de API' });
    const txt = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch(e) { return res.status(422).json({ ok: false, error: 'No se pudo parsear la respuesta', raw: txt }); }
    res.json({ ok: true, data: parsed });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════
// PERSONAL / MANO DE OBRA
// ═════════════════════════════════════════════════════════════════════════

// ── Rubros contables ───────────────────────────────────────────────────────
router.get('/personal/rubros', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare("SELECT * FROM pa_rubros_contables WHERE activo=1 ORDER BY nombre").all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/rubros', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo_labor, cultivo, notas } = req.body;
  if (!nombre || !tipo_labor) return res.status(400).json({ ok: false, error: 'nombre y tipo_labor requeridos' });
  try {
    const r = db.prepare("INSERT INTO pa_rubros_contables (nombre, tipo_labor, cultivo, notas) VALUES (?,?,?,?)")
      .run(nombre, tipo_labor, cultivo || null, notas || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un rubro con ese nombre' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/personal/rubros/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo_labor, cultivo, activo, notas } = req.body;
  try {
    const c = db.prepare("SELECT * FROM pa_rubros_contables WHERE id=?").get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Rubro no encontrado' });
    db.prepare("UPDATE pa_rubros_contables SET nombre=?, tipo_labor=?, cultivo=?, activo=?, notas=? WHERE id=?")
      .run(nombre || c.nombre, tipo_labor || c.tipo_labor,
           cultivo !== undefined ? cultivo : c.cultivo,
           activo !== undefined ? (activo ? 1 : 0) : c.activo,
           notas !== undefined ? notas : c.notas,
           req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Cuadrillas ─────────────────────────────────────────────────────────────
router.get('/personal/cuadrillas', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT c.*, u.nombre as capataz_nombre,
             (SELECT COUNT(*) FROM pa_trabajadores WHERE cuadrilla_habitual_id = c.id AND activo=1) as cantidad
      FROM pa_cuadrillas c
      LEFT JOIN usuarios u ON u.id = c.capataz_id
      WHERE c.activo=1 ORDER BY c.tipo, c.nombre
    `).all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/cuadrillas', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, capataz_id, tipo, notas } = req.body;
  if (!nombre) return res.status(400).json({ ok: false, error: 'nombre requerido' });
  try {
    const r = db.prepare("INSERT INTO pa_cuadrillas (nombre, capataz_id, tipo, notas) VALUES (?,?,?,?)")
      .run(nombre, capataz_id || null, tipo || 'fija', notas || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe una cuadrilla con ese nombre' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/personal/cuadrillas/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, capataz_id, tipo, activo, notas } = req.body;
  try {
    const c = db.prepare("SELECT * FROM pa_cuadrillas WHERE id=?").get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cuadrilla no encontrada' });
    db.prepare("UPDATE pa_cuadrillas SET nombre=?, capataz_id=?, tipo=?, activo=?, notas=? WHERE id=?")
      .run(nombre || c.nombre,
           capataz_id !== undefined ? capataz_id : c.capataz_id,
           tipo || c.tipo,
           activo !== undefined ? (activo ? 1 : 0) : c.activo,
           notas !== undefined ? notas : c.notas,
           req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Trabajadores ───────────────────────────────────────────────────────────
router.get('/personal/trabajadores', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { cuadrilla_id, tipo_relacion, incluir_inactivos } = req.query;
    let q = `SELECT t.*, c.nombre as cuadrilla_nombre
             FROM pa_trabajadores t
             LEFT JOIN pa_cuadrillas c ON c.id = t.cuadrilla_habitual_id
             WHERE 1=1`;
    const params = [];
    if (!incluir_inactivos) q += " AND t.activo=1";
    if (cuadrilla_id) { q += " AND t.cuadrilla_habitual_id=?"; params.push(cuadrilla_id); }
    if (tipo_relacion) { q += " AND t.tipo_relacion=?"; params.push(tipo_relacion); }
    q += " ORDER BY t.nombre";
    res.json({ ok: true, data: db.prepare(q).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/trabajadores', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, dni, cuadrilla_habitual_id, tipo_relacion, jornal_base, unidad_jornal, notas } = req.body;
  if (!nombre) return res.status(400).json({ ok: false, error: 'nombre requerido' });
  try {
    const r = db.prepare(`INSERT INTO pa_trabajadores
        (nombre, dni, cuadrilla_habitual_id, tipo_relacion, jornal_base, unidad_jornal, notas)
        VALUES (?,?,?,?,?,?,?)`)
      .run(nombre, dni || null, cuadrilla_habitual_id || null,
           tipo_relacion || 'fijo',
           Number(jornal_base) || 0,
           unidad_jornal || 'dia',
           notas || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/personal/trabajadores/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, dni, cuadrilla_habitual_id, tipo_relacion, jornal_base, unidad_jornal, activo, notas } = req.body;
  try {
    const c = db.prepare("SELECT * FROM pa_trabajadores WHERE id=?").get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Trabajador no encontrado' });
    db.prepare(`UPDATE pa_trabajadores SET
        nombre=?, dni=?, cuadrilla_habitual_id=?, tipo_relacion=?,
        jornal_base=?, unidad_jornal=?, activo=?, notas=?
        WHERE id=?`)
      .run(nombre || c.nombre,
           dni !== undefined ? dni : c.dni,
           cuadrilla_habitual_id !== undefined ? cuadrilla_habitual_id : c.cuadrilla_habitual_id,
           tipo_relacion || c.tipo_relacion,
           jornal_base !== undefined ? Number(jornal_base) : c.jornal_base,
           unidad_jornal || c.unidad_jornal,
           activo !== undefined ? (activo ? 1 : 0) : c.activo,
           notas !== undefined ? notas : c.notas,
           req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Tipos de tarea ─────────────────────────────────────────────────────────
router.get('/personal/tareas-tipos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT t.*, r.nombre as rubro_fijo_nombre
      FROM pa_tareas_tipos t
      LEFT JOIN pa_rubros_contables r ON r.id = t.rubro_contable_id
      WHERE t.activo=1 ORDER BY t.tipo_labor, t.nombre
    `).all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/tareas-tipos', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo_labor, rubro_contable_id, es_destajo, unidad_destajo } = req.body;
  if (!nombre || !tipo_labor) return res.status(400).json({ ok: false, error: 'nombre y tipo_labor requeridos' });
  try {
    const r = db.prepare(`INSERT INTO pa_tareas_tipos
        (nombre, tipo_labor, rubro_contable_id, es_destajo, unidad_destajo)
        VALUES (?,?,?,?,?)`)
      .run(nombre, tipo_labor,
           rubro_contable_id || null,
           es_destajo ? 1 : 0,
           unidad_destajo || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe una tarea con ese nombre' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/personal/tareas-tipos/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo_labor, rubro_contable_id, es_destajo, unidad_destajo, activo } = req.body;
  try {
    const c = db.prepare("SELECT * FROM pa_tareas_tipos WHERE id=?").get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Tarea no encontrada' });
    db.prepare(`UPDATE pa_tareas_tipos SET nombre=?, tipo_labor=?, rubro_contable_id=?, es_destajo=?, unidad_destajo=?, activo=? WHERE id=?`)
      .run(nombre || c.nombre, tipo_labor || c.tipo_labor,
           rubro_contable_id !== undefined ? rubro_contable_id : c.rubro_contable_id,
           es_destajo !== undefined ? (es_destajo ? 1 : 0) : c.es_destajo,
           unidad_destajo !== undefined ? unidad_destajo : c.unidad_destajo,
           activo !== undefined ? (activo ? 1 : 0) : c.activo,
           req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Sugerir rubro — cruza tipo_labor de la tarea con cultivo del lote ─────
function sugerirRubroContable(db, loteId, tareaTipoId) {
  const tarea = db.prepare("SELECT * FROM pa_tareas_tipos WHERE id=?").get(tareaTipoId);
  if (!tarea) return null;

  // Si la tarea tiene rubro fijo, usarlo directo
  if (tarea.rubro_contable_id) {
    return db.prepare("SELECT * FROM pa_rubros_contables WHERE id=?").get(tarea.rubro_contable_id);
  }

  // Si el tipo_labor es "general" o "otro" sin rubro fijo, fallback a GENERALES
  if (tarea.tipo_labor === 'general' || tarea.tipo_labor === 'otro') {
    return db.prepare("SELECT * FROM pa_rubros_contables WHERE nombre='G -MO GENERALES' OR tipo_labor='general' LIMIT 1").get();
  }

  // Tipos produccion / cosecha_empaque → buscar por cultivo del lote en campaña activa
  const camp = db.prepare("SELECT nombre FROM pa_campañas WHERE activa=1 LIMIT 1").get();
  if (!camp) return null;

  const cult = db.prepare(`
    SELECT cultivo FROM pa_cultivos_lote
    WHERE lote_id=? AND campaña=?
    LIMIT 1
  `).get(loteId, camp.nombre);

  if (!cult || !cult.cultivo) {
    // Sin cultivo asignado → fallback a rubro general del tipo_labor
    return db.prepare("SELECT * FROM pa_rubros_contables WHERE tipo_labor=? AND cultivo IS NULL LIMIT 1").get(tarea.tipo_labor);
  }

  // Normalizar nombre del cultivo a las keys del catálogo de rubros
  const cultNorm = String(cult.cultivo).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // quitar acentos
    .replace(/ó|o/g, 'o');
  // Matcheo flexible: contiene el key del rubro
  const rubros = db.prepare("SELECT * FROM pa_rubros_contables WHERE tipo_labor=? AND cultivo IS NOT NULL").all(tarea.tipo_labor);
  let match = rubros.find(r => cultNorm.includes(r.cultivo));
  if (!match) {
    // Fallback: rubro sin cultivo (ej GENERAL de ese tipo_labor)
    match = db.prepare("SELECT * FROM pa_rubros_contables WHERE tipo_labor=? AND cultivo IS NULL LIMIT 1").get(tarea.tipo_labor);
  }
  return match || db.prepare("SELECT * FROM pa_rubros_contables WHERE nombre LIKE '%GENERALES%' LIMIT 1").get();
}

router.get('/personal/sugerir-rubro', requireAuth, (req, res) => {
  const db = getDb();
  const { lote_id, tarea_tipo_id } = req.query;
  if (!lote_id || !tarea_tipo_id) return res.status(400).json({ ok: false, error: 'lote_id y tarea_tipo_id requeridos' });
  try {
    const rubro = sugerirRubroContable(db, parseInt(lote_id), parseInt(tarea_tipo_id));
    res.json({ ok: true, data: rubro });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Partes de trabajo ──────────────────────────────────────────────────────
router.get('/personal/partes', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { estado, lote_id, cuadrilla_id, desde, hasta, limit } = req.query;
    let q = `
      SELECT p.*,
        c.nombre as cuadrilla_nombre,
        l.nombre as lote_nombre, l.finca as lote_finca,
        t.nombre as tarea_nombre, t.tipo_labor, t.es_destajo, t.unidad_destajo,
        u.nombre as cargado_por_nombre,
        v.monto_total, v.rubro_contable_id as rubro_final_id,
        r.nombre as rubro_final_nombre
      FROM pa_partes_trabajo p
      LEFT JOIN pa_cuadrillas c ON c.id = p.cuadrilla_id
      LEFT JOIN pa_lotes l ON l.id = p.lote_id
      LEFT JOIN pa_tareas_tipos t ON t.id = p.tarea_tipo_id
      LEFT JOIN usuarios u ON u.id = p.cargado_por
      LEFT JOIN pa_partes_valorizacion v ON v.parte_id = p.id
      LEFT JOIN pa_rubros_contables r ON r.id = v.rubro_contable_id
      WHERE 1=1
    `;
    const params = [];
    if (estado) { q += " AND p.estado=?"; params.push(estado); }
    if (lote_id) { q += " AND p.lote_id=?"; params.push(lote_id); }
    if (cuadrilla_id) { q += " AND p.cuadrilla_id=?"; params.push(cuadrilla_id); }
    if (desde) { q += " AND p.fecha>=?"; params.push(desde); }
    if (hasta) { q += " AND p.fecha<=?"; params.push(hasta); }
    q += " ORDER BY p.fecha DESC, p.id DESC LIMIT ?";
    params.push(parseInt(limit) || 200);
    res.json({ ok: true, data: db.prepare(q).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/personal/partes/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const parte = db.prepare(`
      SELECT p.*, c.nombre as cuadrilla_nombre, l.nombre as lote_nombre, l.finca as lote_finca,
             t.nombre as tarea_nombre, t.tipo_labor, t.es_destajo, t.unidad_destajo,
             u.nombre as cargado_por_nombre
      FROM pa_partes_trabajo p
      LEFT JOIN pa_cuadrillas c ON c.id=p.cuadrilla_id
      LEFT JOIN pa_lotes l ON l.id=p.lote_id
      LEFT JOIN pa_tareas_tipos t ON t.id=p.tarea_tipo_id
      LEFT JOIN usuarios u ON u.id=p.cargado_por
      WHERE p.id=?
    `).get(req.params.id);
    if (!parte) return res.status(404).json({ ok: false, error: 'Parte no encontrado' });
    const items = db.prepare(`
      SELECT i.*, tr.nombre as trabajador_nombre, tr.tipo_relacion, tr.jornal_base, tr.unidad_jornal
      FROM pa_partes_trabajo_items i
      JOIN pa_trabajadores tr ON tr.id = i.trabajador_id
      WHERE i.parte_id=?
      ORDER BY tr.nombre
    `).all(parte.id);
    const val = db.prepare(`
      SELECT v.*, r.nombre as rubro_nombre, u.nombre as valorizado_por_nombre
      FROM pa_partes_valorizacion v
      LEFT JOIN pa_rubros_contables r ON r.id=v.rubro_contable_id
      LEFT JOIN usuarios u ON u.id=v.valorizado_por
      WHERE v.parte_id=?
    `).get(parte.id);
    const sugerido = sugerirRubroContable(db, parte.lote_id, parte.tarea_tipo_id);
    res.json({ ok: true, data: { parte, items, valorizacion: val, rubro_sugerido: sugerido } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/partes', requireAuth, (req, res) => {
  const db = getDb();
  const {
    fecha, cuadrilla_id, lote_id, tarea_tipo_id,
    modo_registro, cant_trabajadores, horas_total,
    observaciones, foto_b64, items
  } = req.body;

  if (!lote_id || !tarea_tipo_id) return res.status(400).json({ ok: false, error: 'lote_id y tarea_tipo_id requeridos' });

  const tarea = db.prepare("SELECT * FROM pa_tareas_tipos WHERE id=?").get(tarea_tipo_id);
  if (!tarea) return res.status(400).json({ ok: false, error: 'Tarea inválida' });

  // Validaciones según modo
  const modo = modo_registro || (tarea.es_destajo ? 'individual' : 'cuadrilla');
  if (modo === 'cuadrilla') {
    if (!cant_trabajadores || cant_trabajadores <= 0) return res.status(400).json({ ok: false, error: 'cant_trabajadores requerido' });
    if (!horas_total || horas_total <= 0) return res.status(400).json({ ok: false, error: 'horas_total requerido' });
  } else {
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: 'items requeridos para modo individual' });
  }

  try {
    // Guardar foto si viene
    let fotoPath = null;
    if (foto_b64) {
      const dir = path.join(__dirnamePA, '../../data/scout/personal');
      fs.mkdirSync(dir, { recursive: true });
      const fname = `parte_${Date.now()}_${Math.floor(Math.random()*9999)}.jpg`;
      fs.writeFileSync(path.join(dir, fname),
        Buffer.from(String(foto_b64).replace(/^data:.*?;base64,/,''), 'base64'));
      fotoPath = `/data/scout/personal/${fname}`;
    }

    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pa_partes_trabajo
          (fecha, cuadrilla_id, lote_id, tarea_tipo_id, modo_registro,
           cant_trabajadores, horas_total, observaciones, foto_path, cargado_por, estado)
        VALUES (?,?,?,?,?,?,?,?,?,?,'pendiente_valorizar')
      `).run(
        fecha || new Date().toISOString().slice(0,10),
        cuadrilla_id || null,
        lote_id,
        tarea_tipo_id,
        modo,
        modo === 'cuadrilla' ? Number(cant_trabajadores) : null,
        modo === 'cuadrilla' ? Number(horas_total) : null,
        observaciones || null,
        fotoPath,
        req.user.id
      );
      const parteId = r.lastInsertRowid;

      if (modo === 'individual' && items) {
        const insItem = db.prepare(`INSERT INTO pa_partes_trabajo_items
            (parte_id, trabajador_id, horas, unidades_destajo, notas) VALUES (?,?,?,?,?)`);
        for (const it of items) {
          if (!it.trabajador_id) continue;
          insItem.run(parteId, it.trabajador_id,
            it.horas != null ? Number(it.horas) : null,
            it.unidades_destajo != null ? Number(it.unidades_destajo) : null,
            it.notas || null);
        }
      }
      return parteId;
    });

    res.json({ ok: true, id: tx() });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/personal/partes/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const p = db.prepare("SELECT * FROM pa_partes_trabajo WHERE id=?").get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'Parte no encontrado' });
    if (p.estado === 'valorizado') return res.status(400).json({ ok: false, error: 'No se puede eliminar un parte valorizado. Anulalo primero.' });
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM pa_partes_trabajo_items WHERE parte_id=?").run(p.id);
      db.prepare("DELETE FROM pa_partes_trabajo WHERE id=?").run(p.id);
    });
    tx();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Valorización ───────────────────────────────────────────────────────────
router.post('/personal/partes/:id/valorizar', requireAuth, (req, res) => {
  const db = getDb();
  const { monto_total, rubro_contable_id, detalle_json, observaciones } = req.body;
  if (monto_total == null || monto_total < 0) return res.status(400).json({ ok: false, error: 'monto_total requerido (≥ 0)' });
  if (!rubro_contable_id) return res.status(400).json({ ok: false, error: 'rubro_contable_id requerido' });

  try {
    const parte = db.prepare("SELECT * FROM pa_partes_trabajo WHERE id=?").get(req.params.id);
    if (!parte) return res.status(404).json({ ok: false, error: 'Parte no encontrado' });
    if (parte.estado === 'anulado') return res.status(400).json({ ok: false, error: 'Parte anulado' });

    const rubro = db.prepare("SELECT * FROM pa_rubros_contables WHERE id=?").get(rubro_contable_id);
    if (!rubro) return res.status(400).json({ ok: false, error: 'Rubro inválido' });

    const tarea = db.prepare("SELECT nombre FROM pa_tareas_tipos WHERE id=?").get(parte.tarea_tipo_id);

    const tx = db.transaction(() => {
      // Upsert valorización (permite revalorizar si cambió algo)
      const existente = db.prepare("SELECT id FROM pa_partes_valorizacion WHERE parte_id=?").get(parte.id);
      if (existente) {
        db.prepare(`UPDATE pa_partes_valorizacion SET
            monto_total=?, rubro_contable_id=?, detalle_json=?, valorizado_por=?, fecha_valorizacion=?
            WHERE parte_id=?`)
          .run(Number(monto_total), rubro_contable_id, detalle_json || null,
               req.user.id, new Date().toISOString().slice(0,19).replace('T',' '), parte.id);
        // Borrar costo viejo y recrear
        db.prepare("DELETE FROM pa_costos_lote WHERE categoria='otros' AND referencia_id=?").run(-parte.id);
      } else {
        db.prepare(`INSERT INTO pa_partes_valorizacion
            (parte_id, monto_total, rubro_contable_id, detalle_json, valorizado_por)
            VALUES (?,?,?,?,?)`)
          .run(parte.id, Number(monto_total), rubro_contable_id, detalle_json || null, req.user.id);
      }

      // Cambiar estado del parte
      db.prepare("UPDATE pa_partes_trabajo SET estado='valorizado' WHERE id=?").run(parte.id);

      // Imputar costo al lote (mapear tipo_labor → categoría del enum pa_costos_lote)
      const tipoLabor = rubro.tipo_labor;
      let categoria = 'otros';
      if (tipoLabor === 'cosecha_empaque') categoria = 'cosecha';
      else if (tipoLabor === 'produccion' || tipoLabor === 'general') categoria = 'labor_propia';
      else categoria = 'otros';

      const camp = db.prepare("SELECT id FROM pa_campañas WHERE activa=1 LIMIT 1").get();
      if (camp && Number(monto_total) > 0) {
        // Uso referencia_id = -parte.id para no colisionar con referencias de otros módulos
        db.prepare(`INSERT INTO pa_costos_lote
            (lote_id, campaña_id, categoria, referencia_id, fecha, monto, descripcion)
            VALUES (?,?,?,?,?,?,?)`)
          .run(parte.lote_id, camp.id, categoria, -parte.id, parte.fecha,
               Number(monto_total),
               `MO · ${tarea ? tarea.nombre : 'Parte'} · ${rubro.nombre}${observaciones ? ' · ' + observaciones : ''}`);
      }
    });

    tx();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/partes/:id/anular', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const p = db.prepare("SELECT * FROM pa_partes_trabajo WHERE id=?").get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'Parte no encontrado' });
    const tx = db.transaction(() => {
      db.prepare("UPDATE pa_partes_trabajo SET estado='anulado' WHERE id=?").run(p.id);
      // Revertir costo si estaba valorizado
      db.prepare("DELETE FROM pa_costos_lote WHERE categoria IN ('labor_propia','labor_contratada','cosecha','otros') AND referencia_id=?").run(-p.id);
      db.prepare("DELETE FROM pa_partes_valorizacion WHERE parte_id=?").run(p.id);
    });
    tx();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Dashboard ──────────────────────────────────────────────────────────────
router.get('/personal/dashboard', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const pendientes = db.prepare("SELECT COUNT(*) as n FROM pa_partes_trabajo WHERE estado='pendiente_valorizar'").get().n;
    const hoy = new Date();
    const mesIni = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0,10);

    const gastoMesRubro = db.prepare(`
      SELECT r.nombre, COALESCE(SUM(v.monto_total),0) as total, COUNT(*) as cantidad_partes
      FROM pa_partes_valorizacion v
      JOIN pa_rubros_contables r ON r.id=v.rubro_contable_id
      JOIN pa_partes_trabajo p ON p.id=v.parte_id
      WHERE p.fecha >= ?
      GROUP BY r.id
      ORDER BY total DESC
    `).all(mesIni);

    const partesRecientes = db.prepare(`
      SELECT p.id, p.fecha, p.estado,
        l.nombre as lote_nombre, l.finca as lote_finca,
        t.nombre as tarea_nombre, c.nombre as cuadrilla_nombre,
        p.cant_trabajadores, p.horas_total,
        v.monto_total, r.nombre as rubro_nombre,
        u.nombre as cargado_por_nombre
      FROM pa_partes_trabajo p
      LEFT JOIN pa_lotes l ON l.id=p.lote_id
      LEFT JOIN pa_tareas_tipos t ON t.id=p.tarea_tipo_id
      LEFT JOIN pa_cuadrillas c ON c.id=p.cuadrilla_id
      LEFT JOIN pa_partes_valorizacion v ON v.parte_id=p.id
      LEFT JOIN pa_rubros_contables r ON r.id=v.rubro_contable_id
      LEFT JOIN usuarios u ON u.id=p.cargado_por
      ORDER BY p.creado_en DESC
      LIMIT 15
    `).all();

    const partesViejos = db.prepare(`
      SELECT COUNT(*) as n FROM pa_partes_trabajo
      WHERE estado='pendiente_valorizar' AND fecha < date('now','-14 days','localtime')
    `).get().n;

    res.json({ ok: true, data: {
      pendientes,
      partes_viejos: partesViejos,
      gasto_mes_rubro: gastoMesRubro,
      partes_recientes: partesRecientes
    }});
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
