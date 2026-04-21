// src/rutas/produccion.js
// ── API PRODUCCIÓN AGRÍCOLA — PUENTE CORDON SA ────────────────────────────

import express from 'express';
import { getDb } from '../servicios/db.js';
import '../servicios/db_pa.js'; // Asegura que las tablas existan

const router = express.Router();

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

router.get('/campañas', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare("SELECT * FROM pa_campañas ORDER BY fecha_inicio DESC").all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/campañas', requireAuth, (req, res) => {
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

router.patch('/campañas/:id/activar', requireAuth, (req, res) => {
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
    query += " ORDER BY s.nombre, l.nombre";
    const data = db.prepare(query).all(...params);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/lotes', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, sector_id, hectareas, notas } = req.body;
  if (!nombre || !sector_id) return res.status(400).json({ ok: false, error: 'Nombre y sector requeridos' });
  try {
    const r = db.prepare("INSERT INTO pa_lotes (nombre, sector_id, hectareas, notas) VALUES (?,?,?,?)")
      .run(nombre, sector_id, hectareas || 0.5, notas || null);
    res.json({ ok: true, id: r.lastInsertRowid });
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

router.patch('/lotes/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, hectareas, activo, notas } = req.body;
  try {
    const cur = db.prepare("SELECT * FROM pa_lotes WHERE id=?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    db.prepare("UPDATE pa_lotes SET nombre=?, hectareas=?, activo=?, notas=? WHERE id=?")
      .run(nombre||cur.nombre, hectareas||cur.hectareas, activo!==undefined?activo:cur.activo, notas||cur.notas, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// INSUMOS (FERTILIZANTES, AGROQUÍMICOS, ETC.)
// ─────────────────────────────────────────────────────────────────────────

router.get('/insumos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { tipo } = req.query;
    let query = "SELECT * FROM pa_insumos WHERE activo = 1";
    const params = [];
    if (tipo) { query += " AND tipo = ?"; params.push(tipo); }
    query += " ORDER BY tipo, nombre";
    res.json({ ok: true, data: db.prepare(query).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/insumos', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo, unidad, stock_minimo, notas } = req.body;
  if (!nombre || !tipo || !unidad)
    return res.status(400).json({ ok: false, error: 'Nombre, tipo y unidad requeridos' });
  try {
    const r = db.prepare("INSERT INTO pa_insumos (nombre, tipo, unidad, stock_minimo, notas) VALUES (?,?,?,?,?)")
      .run(nombre, tipo, unidad, stock_minimo || 0, notas || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/insumos/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo, unidad, stock_minimo, activo, notas } = req.body;
  try {
    const cur = db.prepare("SELECT * FROM pa_insumos WHERE id=?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    db.prepare("UPDATE pa_insumos SET nombre=?, tipo=?, unidad=?, stock_minimo=?, activo=?, notas=? WHERE id=?")
      .run(nombre||cur.nombre, tipo||cur.tipo, unidad||cur.unidad, stock_minimo??cur.stock_minimo,
           activo!==undefined?activo:cur.activo, notas||cur.notas, req.params.id);
    res.json({ ok: true });
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
  const { fecha, proveedor_id, proveedor_txt, nro_factura, campaña_id, items, notas } = req.body;
  if (!items?.length) return res.status(400).json({ ok: false, error: 'Debe incluir al menos un item' });
  try {
    // Calcular totales
    let subtotal = 0;
    for (const it of items) { subtotal += (it.cantidad * it.precio_unit); }
    const iva_monto = req.body.iva_monto || 0;
    const total = subtotal + Number(iva_monto);

    const nuevaCompra = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pa_compras (fecha, proveedor_id, proveedor_txt, nro_factura, campaña_id, subtotal, iva_monto, total, notas)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(fecha || new Date().toISOString().slice(0,10), proveedor_id||null, proveedor_txt||null,
             nro_factura||null, campaña_id||null, subtotal, iva_monto, total, notas||null);
      const compraId = r.lastInsertRowid;

      for (const it of items) {
        const sub = it.cantidad * it.precio_unit;
        db.prepare("INSERT INTO pa_compras_items (compra_id, insumo_id, cantidad, precio_unit, subtotal) VALUES (?,?,?,?,?)")
          .run(compraId, it.insumo_id, it.cantidad, it.precio_unit, sub);
        // Actualizar stock
        db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual + ? WHERE id = ?")
          .run(it.cantidad, it.insumo_id);
        // Movimiento
        db.prepare(`
          INSERT INTO pa_movimientos_stock (fecha, insumo_id, tipo, cantidad, motivo, referencia_id)
          VALUES (?,?,?,?,?,?)
        `).run(fecha || new Date().toISOString().slice(0,10), it.insumo_id, 'entrada', it.cantidad, 'compra', compraId);
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
      SELECT o.*, u.nombre as creada_por_nombre, ca.nombre as campaña_nombre
      FROM pa_ordenes o
      LEFT JOIN usuarios u ON u.id = o.creada_por
      LEFT JOIN pa_campañas ca ON ca.id = o.campaña_id
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
  const { campaña_id, fecha_orden, fecha_propuesta, tipo_aplicacion, objetivo, notas, lotes, items } = req.body;
  if (!lotes?.length || !items?.length)
    return res.status(400).json({ ok: false, error: 'Debe incluir lotes e items' });
  try {
    const crearOrden = db.transaction(() => {
      // Generar número de orden
      const n = db.prepare("SELECT COUNT(*) as n FROM pa_ordenes").get().n + 1;
      const nro = `OA-${String(n).padStart(5, '0')}`;

      const r = db.prepare(`
        INSERT INTO pa_ordenes (nro_orden, campaña_id, fecha_orden, fecha_propuesta, creada_por, tipo_aplicacion, objetivo, notas, estado)
        VALUES (?,?,?,?,?,?,?,?,'emitida')
      `).run(nro, campaña_id||null, fecha_orden||new Date().toISOString().slice(0,10),
             fecha_propuesta||null, req.user.id, tipo_aplicacion||null, objetivo||null, notas||null);
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

export default router;
