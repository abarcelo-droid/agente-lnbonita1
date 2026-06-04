// src/rutas/pagos.js
// ── CUENTA CORRIENTE Y PAGOS A PROVEEDORES ───────────────────────────────────
import express from 'express';
import db from '../servicios/db_pa.js';

const router = express.Router();

function getUser(req) {
  try { return req.cookies?.lnb_user ? JSON.parse(req.cookies.lnb_user) : null; }
  catch(e) { return null; }
}

// ── Multisociedad (Fase 3) ──────────────────────────────────────────────────
// Pagos POR sociedad. El pago hereda la sociedad de su proveedor. Lecturas filtran
// por sociedad (default PC si el request no la envía).
let _pcId = null;
function sociedadPCId() {
  if (_pcId) return _pcId;
  const r = db.prepare("SELECT id FROM sociedades WHERE nombre = 'Puente Cordón SA'").get()
         || db.prepare("SELECT id FROM sociedades WHERE funcion = 'productiva' ORDER BY id LIMIT 1").get();
  _pcId = r ? r.id : 1;
  return _pcId;
}
function getSociedadId(req) {
  const raw = req.body?.sociedad_id ?? req.query?.sociedad_id;
  const id = (raw !== undefined && raw !== null && raw !== '') ? parseInt(raw, 10) : null;
  if (Number.isInteger(id)) {
    const ok = db.prepare('SELECT id FROM sociedades WHERE id = ?').get(id);
    if (ok) return id;
  }
  return sociedadPCId();
}

// ── GET /api/pa/pagos/cc/:proveedorId — cuenta corriente de un proveedor ──
// Devuelve todas las facturas activas con su saldo pendiente
router.get('/cc/:proveedorId', (req, res) => {
  try {
    const provId = parseInt(req.params.proveedorId);
    const facturas = db.prepare(`
      SELECT
        c.id, c.fecha, c.nro_factura, c.tipo_comprobante,
        COALESCE(c.neto_total, c.subtotal, 0) AS neto,
        COALESCE(c.iva_total,  c.iva_monto, 0) AS iva,
        COALESCE(c.total, 0)                   AS total,
        COALESCE(c.saldo_pagado, 0)            AS saldo_pagado,
        COALESCE(c.total, 0) - COALESCE(c.saldo_pagado, 0) AS saldo_pendiente,
        c.notas
      FROM pa_compras c
      WHERE c.proveedor_id = ? AND c.activo = 1
      ORDER BY c.fecha DESC, c.id DESC
    `).all(provId);

    const totales = facturas.reduce((acc, f) => {
      acc.total       += f.total;
      acc.pagado      += f.saldo_pagado;
      acc.pendiente   += f.saldo_pendiente;
      return acc;
    }, { total: 0, pagado: 0, pendiente: 0 });

    res.json({ ok: true, data: facturas, totales });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GET /api/pa/pagos?proveedorId= — historial de pagos ──────────────────
router.get('/', (req, res) => {
  try {
    const { proveedorId } = req.query;
    const sociedadId = getSociedadId(req);
    let sql = `
      SELECT p.*, pr.razon_social as proveedor_nombre
      FROM pa_pagos_proveedores p
      LEFT JOIN adm_proveedores pr ON pr.id = p.proveedor_id
      WHERE p.anulado = 0 AND p.sociedad_id = ?
    `;
    const params = [sociedadId];
    if (proveedorId) { sql += ' AND p.proveedor_id = ?'; params.push(parseInt(proveedorId)); }
    sql += ' ORDER BY p.fecha DESC, p.id DESC';
    const pagos = db.prepare(sql).all(...params);
    // Para cada pago, traer las compras que cancela
    for (const p of pagos) {
      p.compras = db.prepare(`
        SELECT pc.compra_id, pc.monto, c.nro_factura, c.fecha
        FROM pa_pagos_compras pc
        JOIN pa_compras c ON c.id = pc.compra_id
        WHERE pc.pago_id = ?
      `).all(p.id);
    }
    res.json({ ok: true, data: pagos });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GET /api/pa/pagos/:id — detalle de un pago ───────────────────────────
router.get('/:id', (req, res) => {
  try {
    const p = db.prepare(`
      SELECT p.*, pr.razon_social as proveedor_nombre
      FROM pa_pagos_proveedores p
      LEFT JOIN adm_proveedores pr ON pr.id = p.proveedor_id
      WHERE p.id = ?
    `).get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'Pago no encontrado' });
    p.compras = db.prepare(`
      SELECT pc.compra_id, pc.monto, c.nro_factura, c.fecha, c.total
      FROM pa_pagos_compras pc
      JOIN pa_compras c ON c.id = pc.compra_id
      WHERE pc.pago_id = ?
    `).all(p.id);
    res.json({ ok: true, data: p });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── POST /api/pa/pagos — registrar un pago ────────────────────────────────
// Body: { proveedor_id, fecha, monto, forma_pago, banco, referencia, notas, compras: [{id, monto}] }
router.post('/', (req, res) => {
  const u = getUser(req);
  const { proveedor_id, fecha, monto, forma_pago, banco, referencia, notas, compras } = req.body || {};
  if (!proveedor_id) return res.status(400).json({ ok: false, error: 'proveedor_id requerido' });
  if (!monto || monto <= 0) return res.status(400).json({ ok: false, error: 'monto inválido' });
  if (!compras || !compras.length) return res.status(400).json({ ok: false, error: 'Seleccioná al menos una factura' });

  // El pago hereda la sociedad de su proveedor (default PC si no se resuelve).
  const prov = db.prepare('SELECT sociedad_id FROM adm_proveedores WHERE id = ?').get(parseInt(proveedor_id));
  const sociedadId = prov ? prov.sociedad_id : sociedadPCId();

  try {
    const registrar = db.transaction(() => {
      // Insertar pago
      const r = db.prepare(`
        INSERT INTO pa_pagos_proveedores
          (fecha, proveedor_id, monto, forma_pago, banco, referencia, notas, usuario_id, sociedad_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fecha || new Date().toISOString().split('T')[0],
        parseInt(proveedor_id),
        parseFloat(monto),
        forma_pago || 'transferencia',
        banco || null,
        referencia || null,
        notas || null,
        u ? u.id : null,
        sociedadId
      );
      const pagoId = r.lastInsertRowid;

      // Vincular con facturas y actualizar saldo_pagado
      for (const c of compras) {
        db.prepare(`INSERT INTO pa_pagos_compras (pago_id, compra_id, monto) VALUES (?, ?, ?)`)
          .run(pagoId, parseInt(c.id), parseFloat(c.monto));
        db.prepare(`UPDATE pa_compras SET saldo_pagado = COALESCE(saldo_pagado,0) + ? WHERE id = ?`)
          .run(parseFloat(c.monto), parseInt(c.id));
      }
      return pagoId;
    });

    const pagoId = registrar();
    res.json({ ok: true, id: pagoId });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── DELETE /api/pa/pagos/:id — anular un pago ────────────────────────────
router.delete('/:id', (req, res) => {
  const u = getUser(req);
  try {
    const pago = db.prepare('SELECT * FROM pa_pagos_proveedores WHERE id = ?').get(req.params.id);
    if (!pago) return res.status(404).json({ ok: false, error: 'Pago no encontrado' });
    if (pago.anulado) return res.json({ ok: true, msg: 'Ya estaba anulado' });

    const anular = db.transaction(() => {
      // Revertir saldo_pagado en cada compra
      const items = db.prepare('SELECT compra_id, monto FROM pa_pagos_compras WHERE pago_id = ?').all(pago.id);
      for (const it of items) {
        db.prepare('UPDATE pa_compras SET saldo_pagado = MAX(0, COALESCE(saldo_pagado,0) - ?) WHERE id = ?')
          .run(it.monto, it.compra_id);
      }
      db.prepare('UPDATE pa_pagos_proveedores SET anulado = 1 WHERE id = ?').run(pago.id);
    });
    anular();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
