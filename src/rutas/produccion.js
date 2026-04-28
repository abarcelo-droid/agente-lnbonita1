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
    const { sector_id, incluir_inactivos } = req.query;
    let query = `
      SELECT l.*, s.nombre as sector_nombre, s.tipo as sector_tipo,
             cl.cultivo as cultivo_actual
      FROM pa_lotes l
      JOIN pa_sectores s ON s.id = l.sector_id
      LEFT JOIN pa_cultivos_lote cl ON cl.lote_id = l.id
        AND cl.campaña = (SELECT nombre FROM pa_campañas WHERE activa = 1 LIMIT 1)
      WHERE 1=1
    `;
    const params = [];
    if (!incluir_inactivos) { query += " AND (l.activo IS NULL OR l.activo = 1)"; }
    if (sector_id) { query += " AND l.sector_id = ?"; params.push(sector_id); }
    query += " ORDER BY l.finca NULLS LAST, l.nombre";
    const data = db.prepare(query).all(...params);
    // Enriquecer con todos los cultivos por campaña
    const getCultivos = db.prepare(
      "SELECT campaña, cultivo, mes_siembra, mes_cosecha, hectareas_sembradas, en_desarrollo, productividad_pct FROM pa_cultivos_lote WHERE lote_id = ?"
    );
    data.forEach(l => {
      l.cultivos = {};
      getCultivos.all(l.id).forEach(r => {
        l.cultivos[r.campaña] = {
          cultivo: r.cultivo,
          mes_siembra: r.mes_siembra,
          mes_cosecha: r.mes_cosecha,
          hectareas_sembradas: r.hectareas_sembradas,
          en_desarrollo: r.en_desarrollo,
          productividad_pct: r.productividad_pct
        };
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
    const cultRows = db.prepare("SELECT campaña, cultivo, mes_siembra, mes_cosecha, hectareas_sembradas, en_desarrollo, productividad_pct FROM pa_cultivos_lote WHERE lote_id = ?").all(req.params.id);
    lote.cultivos = {};
    cultRows.forEach(r => {
      lote.cultivos[r.campaña] = {
        cultivo: r.cultivo,
        mes_siembra: r.mes_siembra,
        mes_cosecha: r.mes_cosecha,
        hectareas_sembradas: r.hectareas_sembradas,
        en_desarrollo: r.en_desarrollo,
        productividad_pct: r.productividad_pct
      };
    });
    res.json({ ok: true, data: lote });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/lotes', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, sector_id, finca, hectareas, poligono_maps, red_agua, notas, año_plantacion, cultivos } = req.body;
  if (!nombre || !sector_id) return res.status(400).json({ ok: false, error: 'Nombre y sector requeridos' });
  try {
    const crearLote = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pa_lotes (nombre, sector_id, finca, hectareas, poligono_maps, red_agua, notas, año_plantacion)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(nombre, sector_id, finca||null, hectareas||0.5, poligono_maps||null, red_agua||null, notas||null, año_plantacion||null);
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
  const { lote_id, campaña, cultivo, es_perenne, mes_siembra, mes_cosecha, hectareas_sembradas, en_desarrollo, productividad_pct } = req.body;
  if (!lote_id || !campaña) return res.status(400).json({ ok: false, error: 'lote_id y campaña requeridos' });
  try {
    if (!cultivo) {
      db.prepare("DELETE FROM pa_cultivos_lote WHERE lote_id=? AND campaña=?").run(lote_id, campaña);
    } else {
      // hectareas_sembradas: NULL si no viene o es <=0; valor numérico si viene válido
      let haSemb = null;
      if (hectareas_sembradas !== undefined && hectareas_sembradas !== null && hectareas_sembradas !== '') {
        const n = parseFloat(hectareas_sembradas);
        if (!isNaN(n) && n > 0) haSemb = n;
      }
      // en_desarrollo: 0/1; productividad_pct: 0-100 entero, NULL si en_desarrollo=0
      const enDes = en_desarrollo ? 1 : 0;
      let prodPct = null;
      if (enDes && productividad_pct !== undefined && productividad_pct !== null && productividad_pct !== '') {
        const p = parseInt(productividad_pct, 10);
        if (!isNaN(p)) prodPct = Math.max(0, Math.min(100, p));
      }
      db.prepare(`
        INSERT INTO pa_cultivos_lote (lote_id, cultivo, campaña, es_perenne, mes_siembra, mes_cosecha, hectareas_sembradas, en_desarrollo, productividad_pct)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(lote_id, campaña) DO UPDATE SET
          cultivo=excluded.cultivo, es_perenne=excluded.es_perenne,
          mes_siembra=excluded.mes_siembra, mes_cosecha=excluded.mes_cosecha,
          hectareas_sembradas=excluded.hectareas_sembradas,
          en_desarrollo=excluded.en_desarrollo,
          productividad_pct=excluded.productividad_pct
      `).run(lote_id, cultivo, campaña, es_perenne ? 1 : 0,
             mes_siembra || null, mes_cosecha || null, haSemb, enDes, prodPct);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/lotes/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, hectareas, activo, notas, finca, poligono_maps, red_agua, año_plantacion } = req.body;
  try {
    const cur = db.prepare("SELECT * FROM pa_lotes WHERE id=?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    // año_plantacion: null explícito permitido (limpia el campo); undefined deja como estaba
    let anioPlant = cur.año_plantacion;
    if (año_plantacion !== undefined) {
      if (año_plantacion === null || año_plantacion === '') anioPlant = null;
      else {
        const n = parseInt(año_plantacion, 10);
        anioPlant = (!isNaN(n) && n > 1900 && n < 2200) ? n : null;
      }
    }
    db.prepare(`UPDATE pa_lotes SET nombre=?, hectareas=?, activo=?, notas=?, finca=?, poligono_maps=?, red_agua=?, año_plantacion=? WHERE id=?`)
      .run(
        nombre||cur.nombre, hectareas||cur.hectareas,
        activo!==undefined?activo:cur.activo,
        notas!==undefined?notas:cur.notas,
        finca!==undefined?finca:cur.finca,
        poligono_maps!==undefined?poligono_maps:cur.poligono_maps,
        red_agua!==undefined?red_agua:cur.red_agua,
        anioPlant,
        req.params.id
      );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Guardar polígono dibujado en Leaflet ──
// body: { geojson, centroide_lat, centroide_lng, hectareas_calculadas (opcional) }
router.post('/lotes/:id/poligono', requireAuth, (req, res) => {
  const db = getDb();
  const { geojson, centroide_lat, centroide_lng, hectareas_calculadas } = req.body;
  if (!geojson) return res.status(400).json({ ok: false, error: 'geojson requerido' });
  try {
    const cur = db.prepare("SELECT id, hectareas FROM pa_lotes WHERE id=?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    // Validar geojson mínimamente
    let parsed;
    try { parsed = typeof geojson === 'string' ? JSON.parse(geojson) : geojson; }
    catch(e) { return res.status(400).json({ ok: false, error: 'geojson inválido' }); }
    const geoStr = JSON.stringify(parsed);
    // Si vino hectáreas calculadas, la actualiza también (opcional)
    const haFinal = (hectareas_calculadas != null && hectareas_calculadas > 0) ? Number(hectareas_calculadas) : cur.hectareas;
    db.prepare(`UPDATE pa_lotes SET poligono_geojson=?, centroide_lat=?, centroide_lng=?, hectareas=? WHERE id=?`)
      .run(geoStr,
           centroide_lat != null ? Number(centroide_lat) : null,
           centroide_lng != null ? Number(centroide_lng) : null,
           haFinal,
           req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Eliminar polígono ──
router.delete('/lotes/:id/poligono', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_lotes SET poligono_geojson=NULL, centroide_lat=NULL, centroide_lng=NULL WHERE id=?")
      .run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// INSUMOS (FERTILIZANTES, AGROQUÍMICOS, ETC.)
// ─────────────────────────────────────────────────────────────────────────

router.get('/insumos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { tipo, categoria_principal, incluir_inactivos } = req.query;
    let query = "SELECT * FROM pa_insumos WHERE 1=1";
    const params = [];
    if (!incluir_inactivos) { query += " AND activo = 1"; }
    if (categoria_principal) { query += " AND categoria_principal = ?"; params.push(categoria_principal); }
    if (tipo) { query += " AND tipo = ?"; params.push(tipo); }
    query += " ORDER BY categoria_principal, tipo, nombre";
    res.json({ ok: true, data: db.prepare(query).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/insumos', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo, unidad, stock_minimo, componente_madre, precio_ref_usd, notas, categoria_principal,
          presentacion_tipo, presentacion_base } = req.body;
  if (!nombre || !tipo || !unidad)
    return res.status(400).json({ ok: false, error: 'Nombre, tipo y unidad requeridos' });
  try {
    const r = db.prepare(`
      INSERT INTO pa_insumos (nombre, tipo, unidad, stock_minimo, componente_madre, precio_ref_usd, notas, categoria_principal,
                              presentacion_tipo, presentacion_base)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(nombre, tipo, unidad, stock_minimo||0, componente_madre||null, precio_ref_usd||null, notas||null,
           categoria_principal || 'agroinsumos',
           presentacion_tipo || null,
           presentacion_base != null ? Number(presentacion_base) : null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/insumos/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo, unidad, stock_minimo, activo, componente_madre, precio_ref_usd, notas, categoria_principal,
          presentacion_tipo, presentacion_base } = req.body;
  try {
    const cur = db.prepare("SELECT * FROM pa_insumos WHERE id=?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    db.prepare(`UPDATE pa_insumos SET nombre=?, tipo=?, unidad=?, stock_minimo=?, activo=?,
                componente_madre=?, precio_ref_usd=?, notas=?, categoria_principal=?,
                presentacion_tipo=?, presentacion_base=? WHERE id=?`)
      .run(nombre||cur.nombre, tipo||cur.tipo, unidad||cur.unidad, stock_minimo??cur.stock_minimo,
           activo!==undefined?activo:cur.activo,
           componente_madre!==undefined?componente_madre:cur.componente_madre,
           precio_ref_usd!==undefined?precio_ref_usd:cur.precio_ref_usd,
           notas!==undefined?notas:cur.notas,
           categoria_principal || cur.categoria_principal,
           presentacion_tipo!==undefined?presentacion_tipo:cur.presentacion_tipo,
           presentacion_base!==undefined?(presentacion_base!=null?Number(presentacion_base):null):cur.presentacion_base,
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
  "iva_total": número o null,
  "neto_total": número o null,
  "total_final": número o null,
  "items": [
    {
      "descripcion": "nombre del producto tal como aparece",
      "cantidad": número (cantidad principal, ver abajo),
      "unidad": "kg|lt|unidad|gramos|c.c|bolsa|bidon|rollos|sobres",
      "presentacion_base": número (lt/kg por bulto, ej: 20 si son latas de 20lt) o null,
      "cant_bultos": número (si se ve claro cuántos bultos) o null,
      "precio_unitario": número o null (si hay bultos, es el precio POR BULTO),
      "iva_porcentaje": número (ej: 21, 10.5, 0) o null si no está claro,
      "subtotal_neto": número o null,
      "iva_monto": número o null
    }
  ]
}

Notas importantes para el IVA:
- En Argentina, los agroinsumos suelen estar a 21% o 10.5%.
- Si la factura tiene una sola alícuota general, asignala a todos los items.
- Si un item está al 0% (exento), ponelo como 0.
- Si no podés determinar la alícuota con certeza, poné null.
- iva_total e iva_monto son el monto en pesos, no el porcentaje.

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
    const { campaña_id, desde, hasta, incluir_inactivos } = req.query;
    let query = `
      SELECT c.*, p.razon_social as proveedor_nombre,
             ca.nombre as campaña_nombre
      FROM pa_compras c
      LEFT JOIN pa_proveedores p ON p.id = c.proveedor_id
      LEFT JOIN pa_campañas ca ON ca.id = c.campaña_id
      WHERE 1=1
    `;
    const params = [];
    if (!incluir_inactivos) { query += " AND (c.activo IS NULL OR c.activo = 1)"; }
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
    // ── Normalizar items
    //
    // Modo "presentacion": se compra por bultos. Ej: 4 latas × 20 lt a $120.000/lata
    //   - cant_bultos = 4
    //   - presentacion_base = 20
    //   - precio_unit = 120000 (por bulto, tal cual aparece en la factura)
    //   - MONTO de la compra = 4 × 120.000 = $480.000  (cant_bultos × precio_unit)
    //   - STOCK que se suma    = 4 × 20 = 80 lt        (cant_bultos × presentacion_base)
    //
    // Modo "base": se compra directo en unidad base. Ej: 80 lt a $6.000/lt
    //   - cantidad = 80, precio_unit = 6000
    //   - MONTO = 80 × 6.000 = $480.000  (cantidad × precio_unit)
    //   - STOCK = 80 lt (= cantidad)
    for (const it of items) {
      const modoPres = (it.cant_bultos != null && it.presentacion_base != null);
      if (modoPres) {
        const cantBultos = Number(it.cant_bultos);
        const presBase   = Number(it.presentacion_base);
        it._stockASumar   = cantBultos * presBase;    // unidad base (lt/kg)
        it._montoNeto     = cantBultos * Number(it.precio_unit); // cant_bultos × precio directo
      } else {
        // Modo simple: cantidad directo en unidad base
        it._stockASumar = Number(it.cantidad);
        it._montoNeto   = Number(it.cantidad) * Number(it.precio_unit);
      }
    }

    // Calcular totales netos + IVA por item
    let neto_total = 0;
    let iva_total = 0;
    for (const it of items) {
      const subNeto = it._montoNeto;
      const pct = it.iva_porcentaje != null ? Number(it.iva_porcentaje) : 0;
      const ivaItem = subNeto * (pct / 100);
      it._subNeto = subNeto;
      it._ivaMonto = ivaItem;
      neto_total += subNeto;
      iva_total += ivaItem;
    }
    if (req.body.iva_monto != null && !items.some(it => it.iva_porcentaje != null)) {
      iva_total = Number(req.body.iva_monto);
    }
    const total = neto_total + iva_total;

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
        INSERT INTO pa_compras (fecha, proveedor_id, proveedor_txt, nro_factura, tipo_comprobante, campaña_id,
                                subtotal, iva_monto, total, notas, remito_foto_path,
                                iva_total, neto_total)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(fecha||new Date().toISOString().slice(0,10), proveedor_id||null, proveedor_txt||null,
             nro_factura||null, tipo_comprobante||'factura', campaña_id||null,
             neto_total, iva_total, total, notas||null, remito_foto_path,
             iva_total, neto_total);
      const compraId = r.lastInsertRowid;
      for (const it of items) {
        // En pa_compras_items guardamos:
        //   - cantidad: el total en UNIDAD BASE (el que se suma al stock)
        //   - precio_unit: precio en unidad base ($/lt o $/kg)
        //   - cant_bultos / presentacion_base: info original para trazabilidad
        const cantidadBase = it._stockASumar;
        // Precio unitario en unidad base (para reportes, ranking proveedores, etc.)
        const precioBase = cantidadBase > 0 ? (it._montoNeto / cantidadBase) : Number(it.precio_unit);

        db.prepare(`
          INSERT INTO pa_compras_items
            (compra_id, insumo_id, cantidad, precio_unit, subtotal, iva_porcentaje, iva_monto, subtotal_neto,
             presentacion_base, cant_bultos, precio_modo)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(compraId, it.insumo_id,
               cantidadBase,
               precioBase,
               it._subNeto + it._ivaMonto,
               it.iva_porcentaje != null ? Number(it.iva_porcentaje) : null,
               it._ivaMonto,
               it._subNeto,
               it.presentacion_base != null ? Number(it.presentacion_base) : null,
               it.cant_bultos != null ? Number(it.cant_bultos) : null,
               it.precio_modo || 'bulto');

        // Actualizar stock del insumo en unidad base
        db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual + ? WHERE id = ?")
          .run(cantidadBase, it.insumo_id);

        // Aprender la presentación default si el insumo no la tenía (solo base numérica, sin tipo)
        if (it.presentacion_base != null) {
          const ins = db.prepare("SELECT presentacion_base FROM pa_insumos WHERE id = ?").get(it.insumo_id);
          if (ins && !ins.presentacion_base) {
            db.prepare("UPDATE pa_insumos SET presentacion_base = ? WHERE id = ?")
              .run(Number(it.presentacion_base), it.insumo_id);
          }
        }

        db.prepare("INSERT INTO pa_movimientos_stock (fecha, insumo_id, tipo, cantidad, motivo, referencia_id) VALUES (?,?,?,?,?,?)")
          .run(fecha||new Date().toISOString().slice(0,10), it.insumo_id, 'entrada', cantidadBase, 'compra', compraId);
      }
      return compraId;
    });
    const id = nuevaCompra();
    res.json({ ok: true, id, neto_total, iva_total, total });
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

// DELETE — eliminar orden de aplicación (HARD DELETE, solo admin).
// Limpia: pa_aplicaciones, pa_ordenes_items, pa_ordenes_lotes, pa_ordenes.
// Revierte: stock descontado en pa_insumos, pa_movimientos_stock (motivo=aplicacion),
//           pa_costos_lote (referencia_id de las aplicaciones borradas).
// Desvincula (NO borra): pa_combustible_movimientos.orden_id -> NULL.
router.delete('/ordenes/:id', requireAuth, (req, res) => {
  if (req.user.rol !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Solo admin puede eliminar órdenes' });
  }
  const db = getDb();
  const ordenId = req.params.id;
  try {
    const orden = db.prepare("SELECT * FROM pa_ordenes WHERE id=?").get(ordenId);
    if (!orden) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });

    const tx = db.transaction(() => {
      // 1) Leer aplicaciones para revertir efectos colaterales
      const aplicaciones = db.prepare(
        "SELECT id, insumo_id, cantidad_real FROM pa_aplicaciones WHERE orden_id=?"
      ).all(ordenId);

      let stockRevertido = 0;
      let movStockBorrados = 0;
      let costosLoteBorrados = 0;

      for (const a of aplicaciones) {
        // Restaurar stock del insumo
        if (a.insumo_id && a.cantidad_real) {
          db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual + ? WHERE id = ?")
            .run(a.cantidad_real, a.insumo_id);
          stockRevertido++;
        }
        // Borrar movimiento de stock asociado a esta aplicación
        movStockBorrados += db.prepare(
          "DELETE FROM pa_movimientos_stock WHERE motivo='aplicacion' AND referencia_id=?"
        ).run(a.id).changes;
        // Borrar costo por lote asociado a esta aplicación
        costosLoteBorrados += db.prepare(
          "DELETE FROM pa_costos_lote WHERE categoria IN ('fertilizante','agroquimico') AND referencia_id=?"
        ).run(a.id).changes;
      }

      // 2) Desvincular movimientos de combustible (no borrar)
      const combDesvinc = db.prepare(
        "UPDATE pa_combustible_movimientos SET orden_id=NULL WHERE orden_id=?"
      ).run(ordenId).changes;

      // 3) Borrar dependencias directas
      const aplicsBorradas = db.prepare("DELETE FROM pa_aplicaciones WHERE orden_id=?").run(ordenId).changes;
      const itemsBorrados  = db.prepare("DELETE FROM pa_ordenes_items WHERE orden_id=?").run(ordenId).changes;
      const lotesBorrados  = db.prepare("DELETE FROM pa_ordenes_lotes WHERE orden_id=?").run(ordenId).changes;

      // 4) Borrar la orden
      db.prepare("DELETE FROM pa_ordenes WHERE id=?").run(ordenId);

      return {
        nro_orden: orden.nro_orden,
        aplicaciones: aplicsBorradas,
        items: itemsBorrados,
        lotes: lotesBorrados,
        stock_revertido: stockRevertido,
        movimientos_stock_borrados: movStockBorrados,
        costos_lote_borrados: costosLoteBorrados,
        combustible_desvinculado: combDesvinc
      };
    });

    const detalle = tx();
    res.json({ ok: true, eliminada: detalle });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

// ── Grupos / Colectivos (administrativo de trabajadores) ───────────────────
router.get('/personal/grupos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT g.*, (SELECT COUNT(*) FROM pa_trabajadores WHERE grupo_id = g.id AND activo=1) as cantidad
      FROM pa_grupos g WHERE g.activo=1 ORDER BY g.nombre
    `).all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/grupos', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, descripcion } = req.body;
  if (!nombre) return res.status(400).json({ ok: false, error: 'nombre requerido' });
  try {
    const r = db.prepare("INSERT INTO pa_grupos (nombre, descripcion) VALUES (?,?)")
      .run(nombre.trim(), descripcion || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un grupo con ese nombre' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/personal/grupos/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, descripcion, activo } = req.body;
  try {
    const g = db.prepare("SELECT * FROM pa_grupos WHERE id=?").get(req.params.id);
    if (!g) return res.status(404).json({ ok: false, error: 'Grupo no encontrado' });
    db.prepare("UPDATE pa_grupos SET nombre=?, descripcion=?, activo=? WHERE id=?")
      .run(nombre || g.nombre,
           descripcion !== undefined ? descripcion : g.descripcion,
           activo !== undefined ? (activo ? 1 : 0) : g.activo,
           req.params.id);
    res.json({ ok: true });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un grupo con ese nombre' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Trabajadores ───────────────────────────────────────────────────────────
router.get('/personal/trabajadores', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { cuadrilla_id, grupo_id, tipo_relacion, incluir_inactivos } = req.query;
    let q = `SELECT t.*, c.nombre as cuadrilla_nombre, g.nombre as grupo_nombre
             FROM pa_trabajadores t
             LEFT JOIN pa_cuadrillas c ON c.id = t.cuadrilla_habitual_id
             LEFT JOIN pa_grupos g ON g.id = t.grupo_id
             WHERE 1=1`;
    const params = [];
    if (!incluir_inactivos) q += " AND t.activo=1";
    if (cuadrilla_id) { q += " AND t.cuadrilla_habitual_id=?"; params.push(cuadrilla_id); }
    if (grupo_id) { q += " AND t.grupo_id=?"; params.push(grupo_id); }
    if (tipo_relacion) { q += " AND t.tipo_relacion=?"; params.push(tipo_relacion); }
    q += " ORDER BY g.nombre, t.nombre";
    res.json({ ok: true, data: db.prepare(q).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/trabajadores', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, dni, grupo_id, cuadrilla_habitual_id, tipo_relacion, jornal_base, unidad_jornal, notas } = req.body;
  if (!nombre) return res.status(400).json({ ok: false, error: 'nombre requerido' });
  try {
    // Si no viene grupo_id, asignar al grupo "Sin asignar" por default
    let gId = grupo_id ? Number(grupo_id) : null;
    if (!gId) {
      const sa = db.prepare("SELECT id FROM pa_grupos WHERE nombre='Sin asignar'").get();
      if (sa) gId = sa.id;
    }
    const r = db.prepare(`INSERT INTO pa_trabajadores
        (nombre, dni, grupo_id, cuadrilla_habitual_id, tipo_relacion, jornal_base, unidad_jornal, notas)
        VALUES (?,?,?,?,?,?,?,?)`)
      .run(nombre, dni || null, gId, cuadrilla_habitual_id || null,
           tipo_relacion || 'fijo',
           Number(jornal_base) || 0,
           unidad_jornal || 'dia',
           notas || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/personal/trabajadores/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, dni, grupo_id, cuadrilla_habitual_id, tipo_relacion, jornal_base, unidad_jornal, activo, notas } = req.body;
  try {
    const c = db.prepare("SELECT * FROM pa_trabajadores WHERE id=?").get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Trabajador no encontrado' });
    db.prepare(`UPDATE pa_trabajadores SET
        nombre=?, dni=?, grupo_id=?, cuadrilla_habitual_id=?, tipo_relacion=?,
        jornal_base=?, unidad_jornal=?, activo=?, notas=?
        WHERE id=?`)
      .run(nombre || c.nombre,
           dni !== undefined ? dni : c.dni,
           grupo_id !== undefined ? grupo_id : c.grupo_id,
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

// ═══════════════════════════════════════════════════════════════════════════
// FICHAJES DE CUADRILLA (mñna/tarde con GPS)
// ═══════════════════════════════════════════════════════════════════════════

// Capataz ficha entrada o salida desde el Scout
router.post('/personal/fichajes', requireAuth, (req, res) => {
  const db = getDb();
  const u = req.user || {};
  const { cuadrilla_id, momento, hora_declarada, tarea_texto, cant_personas, lat, lng, accuracy_metros, gps_ok } = req.body;

  // Validaciones
  if (!cuadrilla_id) return res.status(400).json({ ok: false, error: 'cuadrilla_id requerido' });
  if (!['entrada','salida'].includes(momento)) return res.status(400).json({ ok: false, error: 'momento debe ser entrada o salida' });
  if (!hora_declarada || !/^\d{2}:\d{2}$/.test(hora_declarada)) return res.status(400).json({ ok: false, error: 'hora_declarada debe tener formato HH:MM' });
  if (!tarea_texto || !tarea_texto.trim()) return res.status(400).json({ ok: false, error: 'tarea_texto requerido' });

  // Verificar que la cuadrilla existe
  const cuad = db.prepare("SELECT id, capataz_id FROM pa_cuadrillas WHERE id = ? AND activo = 1").get(cuadrilla_id);
  if (!cuad) return res.status(404).json({ ok: false, error: 'Cuadrilla no encontrada' });

  try {
    const r = db.prepare(`
      INSERT INTO pa_fichajes_cuadrilla
        (capataz_id, cuadrilla_id, momento, hora_declarada, tarea_texto, cant_personas, lat, lng, accuracy_metros, gps_ok)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      u.id || cuad.capataz_id,
      cuadrilla_id,
      momento,
      hora_declarada,
      tarea_texto.trim(),
      cant_personas != null ? Number(cant_personas) : null,
      lat != null ? Number(lat) : null,
      lng != null ? Number(lng) : null,
      accuracy_metros != null ? Number(accuracy_metros) : null,
      gps_ok ? 1 : 0
    );
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Lista de fichajes (filtros: estado, fecha_desde, fecha_hasta, capataz_id)
router.get('/personal/fichajes', requireAuth, (req, res) => {
  const db = getDb();
  const { estado, fecha_desde, fecha_hasta, capataz_id } = req.query;
  try {
    let sql = `
      SELECT f.*,
             c.nombre as cuadrilla_nombre,
             u.nombre as capataz_nombre,
             l.nombre as lote_nombre, l.finca as lote_finca,
             r.nombre as rubro_nombre
      FROM pa_fichajes_cuadrilla f
      JOIN pa_cuadrillas c ON c.id = f.cuadrilla_id
      LEFT JOIN usuarios u ON u.id = f.capataz_id
      LEFT JOIN pa_lotes l ON l.id = f.lote_id
      LEFT JOIN pa_rubros_contables r ON r.id = f.rubro_contable_id
      WHERE 1=1
    `;
    const params = [];
    if (estado) { sql += " AND f.estado = ?"; params.push(estado); }
    if (fecha_desde) { sql += " AND f.fecha >= ?"; params.push(fecha_desde); }
    if (fecha_hasta) { sql += " AND f.fecha <= ?"; params.push(fecha_hasta); }
    if (capataz_id) { sql += " AND f.capataz_id = ?"; params.push(capataz_id); }
    sql += " ORDER BY f.fecha DESC, f.hora_real DESC";
    const data = db.prepare(sql).all(...params);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Admin completa fichaje con lote + rubro (y cambia a estado=completado)
router.patch('/personal/fichajes/:id', requireAuth, (req, res) => {
  const db = getDb();
  const u = req.user || {};
  const { lote_id, rubro_contable_id, estado, notas_admin, cant_personas, tarea_texto } = req.body;
  try {
    const cur = db.prepare("SELECT * FROM pa_fichajes_cuadrilla WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Fichaje no encontrado' });

    // Si se está completando (asignando lote + rubro), marcar completado_por y fecha
    let nuevoEstado = estado != null ? estado : cur.estado;
    const asignandoLoteYRubro = (lote_id != null || rubro_contable_id != null);
    if (asignandoLoteYRubro && nuevoEstado === 'pendiente') {
      // Solo se marca completado si quedaron ambos asignados
      const loteFinal = lote_id != null ? lote_id : cur.lote_id;
      const rubroFinal = rubro_contable_id != null ? rubro_contable_id : cur.rubro_contable_id;
      if (loteFinal && rubroFinal) nuevoEstado = 'completado';
    }
    const marcaCompletado = nuevoEstado === 'completado' && cur.estado !== 'completado';

    db.prepare(`
      UPDATE pa_fichajes_cuadrilla SET
        lote_id = ?, rubro_contable_id = ?, estado = ?, notas_admin = ?,
        cant_personas = ?, tarea_texto = ?,
        completado_por = ?, fecha_completado = ?
      WHERE id = ?
    `).run(
      lote_id != null ? lote_id : cur.lote_id,
      rubro_contable_id != null ? rubro_contable_id : cur.rubro_contable_id,
      nuevoEstado,
      notas_admin != null ? notas_admin : cur.notas_admin,
      cant_personas != null ? cant_personas : cur.cant_personas,
      tarea_texto != null ? tarea_texto : cur.tarea_texto,
      marcaCompletado ? (u.id || null) : cur.completado_por,
      marcaCompletado ? new Date().toISOString().slice(0,19).replace('T',' ') : cur.fecha_completado,
      req.params.id
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Eliminar / anular fichaje
router.delete('/personal/fichajes/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_fichajes_cuadrilla SET estado='anulado' WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Stats para el dashboard admin de fichajes
router.get('/personal/fichajes-stats', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const pendientes = db.prepare("SELECT COUNT(*) as n FROM pa_fichajes_cuadrilla WHERE estado='pendiente'").get().n;
    const hoy = db.prepare("SELECT COUNT(*) as n FROM pa_fichajes_cuadrilla WHERE fecha = date('now','localtime') AND estado != 'anulado'").get().n;
    const semana = db.prepare("SELECT COUNT(*) as n FROM pa_fichajes_cuadrilla WHERE fecha >= date('now','localtime','-7 days') AND estado != 'anulado'").get().n;
    const ultimos = db.prepare(`
      SELECT f.*, c.nombre as cuadrilla_nombre, u.nombre as capataz_nombre
      FROM pa_fichajes_cuadrilla f
      JOIN pa_cuadrillas c ON c.id = f.cuadrilla_id
      LEFT JOIN usuarios u ON u.id = f.capataz_id
      WHERE f.estado != 'anulado'
      ORDER BY f.creado_en DESC LIMIT 5
    `).all();
    res.json({ ok: true, data: { pendientes, hoy, semana, ultimos } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SOFT DELETE — DESACTIVAR registros sin borrarlos de DB
// ═══════════════════════════════════════════════════════════════════════════

// Desactivar / reactivar COMPRA (revierte stock y movimientos si desactiva)
router.delete('/compras/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const cur = db.prepare("SELECT id, activo FROM pa_compras WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Compra no encontrada' });
    if (!cur.activo) return res.json({ ok: true, msg: 'Ya estaba desactivada' });

    // Revertir stock y borrar movimientos generados por esta compra
    const revertir = db.transaction(() => {
      const items = db.prepare("SELECT insumo_id, cantidad FROM pa_compras_items WHERE compra_id = ?").all(req.params.id);
      for (const it of items) {
        db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual - ? WHERE id = ?")
          .run(it.cantidad, it.insumo_id);
      }
      db.prepare("DELETE FROM pa_movimientos_stock WHERE motivo = 'compra' AND referencia_id = ?")
        .run(req.params.id);
      db.prepare("UPDATE pa_compras SET activo = 0 WHERE id = ?").run(req.params.id);
    });
    revertir();
    res.json({ ok: true, msg: 'Compra desactivada y stock revertido' });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Reactivar compra
router.post('/compras/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const cur = db.prepare("SELECT id, activo, fecha FROM pa_compras WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Compra no encontrada' });
    if (cur.activo) return res.json({ ok: true, msg: 'Ya estaba activa' });

    const reactivar = db.transaction(() => {
      const items = db.prepare("SELECT insumo_id, cantidad FROM pa_compras_items WHERE compra_id = ?").all(req.params.id);
      for (const it of items) {
        db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual + ? WHERE id = ?")
          .run(it.cantidad, it.insumo_id);
        db.prepare("INSERT INTO pa_movimientos_stock (fecha, insumo_id, tipo, cantidad, motivo, referencia_id) VALUES (?,?,?,?,?,?)")
          .run(cur.fecha, it.insumo_id, 'entrada', it.cantidad, 'compra', req.params.id);
      }
      db.prepare("UPDATE pa_compras SET activo = 1 WHERE id = ?").run(req.params.id);
    });
    reactivar();
    res.json({ ok: true, msg: 'Compra reactivada y stock sumado' });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Desactivar insumo (soft delete)
router.delete('/insumos/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const cur = db.prepare("SELECT id, activo FROM pa_insumos WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    db.prepare("UPDATE pa_insumos SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Reactivar insumo
router.post('/insumos/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_insumos SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Desactivar vehículo (soft delete)
router.delete('/combustible/vehiculos/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const cur = db.prepare("SELECT id FROM pa_vehiculos WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Vehículo no encontrado' });
    db.prepare("UPDATE pa_vehiculos SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Reactivar vehículo
router.post('/combustible/vehiculos/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_vehiculos SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Trabajadores / Grupos / Cuadrillas / Rubros / Proveedores / Lotes ──

router.delete('/personal/trabajadores/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_trabajadores SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/personal/trabajadores/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_trabajadores SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/personal/grupos/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    // No se puede desactivar el grupo "Sin asignar" (id=1)
    if (Number(req.params.id) === 1) return res.status(400).json({ ok: false, error: 'No se puede desactivar el grupo "Sin asignar"' });
    db.prepare("UPDATE pa_grupos SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/personal/grupos/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_grupos SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/personal/cuadrillas/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_cuadrillas SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/personal/cuadrillas/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_cuadrillas SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/personal/rubros/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_rubros_contables SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/personal/rubros/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_rubros_contables SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/proveedores/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_proveedores SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/proveedores/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_proveedores SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/lotes/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_lotes SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/lotes/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_lotes SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
