// src/rutas/ordenes.js
// ── ÓRDENES DE PAGO ──────────────────────────────────────────────────────────
import express from 'express';
import db from '../servicios/db_pa.js';

const router = express.Router();

function getUser(req) {
  try { return req.cookies?.lnb_user ? JSON.parse(req.cookies.lnb_user) : null; }
  catch(e) { return null; }
}

function generarNumero() {
  const año = new Date().getFullYear();
  const ultima = db.prepare("SELECT numero FROM fin_ordenes_pago WHERE numero LIKE ? ORDER BY id DESC LIMIT 1")
    .get(`OP-${año}-%`);
  let n = 1;
  if (ultima) {
    const partes = ultima.numero.split('-');
    n = parseInt(partes[partes.length - 1]) + 1;
  }
  return `OP-${año}-${String(n).padStart(4, '0')}`;
}

// ── GET /api/fin/ordenes — listar OPs ────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { estado, proveedorId } = req.query;
    let sql = `
      SELECT op.*, pr.razon_social as proveedor_nombre,
        fc.nombre as cuenta_nombre
      FROM fin_ordenes_pago op
      LEFT JOIN adm_proveedores pr ON pr.id = op.proveedor_id
      LEFT JOIN fin_cuentas fc ON fc.id = op.cuenta_fin_id
      WHERE 1=1
    `;
    const params = [];
    if (estado)      { sql += ' AND op.estado=?'; params.push(estado); }
    if (proveedorId) { sql += ' AND op.proveedor_id=?'; params.push(parseInt(proveedorId)); }
    sql += ' ORDER BY op.fecha DESC, op.id DESC';
    const ops = db.prepare(sql).all(...params);
    for (const op of ops) {
      op.compras = db.prepare(`
        SELECT oc.compra_id, oc.monto, c.nro_factura, c.fecha
        FROM fin_op_compras oc
        JOIN pa_compras c ON c.id = oc.compra_id
        WHERE oc.op_id = ?
      `).all(op.id);
    }
    res.json({ ok: true, data: ops });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GET /api/fin/ordenes/:id — detalle de una OP ────────────────────────
router.get('/:id', (req, res) => {
  try {
    const op = db.prepare(`
      SELECT op.*, pr.razon_social as proveedor_nombre, pr.cuit as proveedor_cuit,
        fc.nombre as cuenta_nombre, fc.banco as cuenta_banco, fc.cbu as cuenta_cbu,
        fc.cuenta_contable_id as cuenta_contable_id
      FROM fin_ordenes_pago op
      LEFT JOIN adm_proveedores pr ON pr.id = op.proveedor_id
      LEFT JOIN fin_cuentas fc ON fc.id = op.cuenta_fin_id
      WHERE op.id = ?
    `).get(req.params.id);
    if (!op) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });
    op.compras = db.prepare(`
      SELECT oc.compra_id, oc.monto, c.nro_factura, c.fecha, c.total
      FROM fin_op_compras oc
      JOIN pa_compras c ON c.id = oc.compra_id
      WHERE oc.op_id = ?
    `).all(op.id);
    res.json({ ok: true, data: op });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── POST /api/fin/ordenes — crear nueva OP ───────────────────────────────
router.post('/', (req, res) => {
  const u = getUser(req);
  const {
    fecha, proveedor_id, monto_total, forma_pago,
    cuenta_fin_id, cheque_prop_id, cheque_ter_id,
    referencia, notas, compras
  } = req.body || {};

  if (!proveedor_id)  return res.status(400).json({ ok: false, error: 'proveedor_id requerido' });
  if (!monto_total)   return res.status(400).json({ ok: false, error: 'monto_total requerido' });
  if (!compras?.length) return res.status(400).json({ ok: false, error: 'Seleccioná al menos una factura' });

  // Validar forma de pago con recurso disponible
  if ((forma_pago === 'transferencia' || forma_pago === 'efectivo') && !cuenta_fin_id)
    return res.status(400).json({ ok: false, error: 'Seleccioná una cuenta bancaria o caja' });
  if (forma_pago === 'cheque_propio' && !cheque_prop_id)
    return res.status(400).json({ ok: false, error: 'Seleccioná un cheque propio' });
  if (forma_pago === 'cheque_tercero' && !cheque_ter_id)
    return res.status(400).json({ ok: false, error: 'Seleccioná un cheque de tercero' });

  try {
    const crear = db.transaction(() => {
      const numero = generarNumero();
      const fechaOp = fecha || new Date().toISOString().split('T')[0];

      // Insertar OP
      const r = db.prepare(`
        INSERT INTO fin_ordenes_pago
          (numero, fecha, proveedor_id, monto_total, forma_pago, cuenta_fin_id,
           cheque_prop_id, cheque_ter_id, referencia, notas, estado, usuario_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,'emitida',?)
      `).run(
        numero, fechaOp, parseInt(proveedor_id), parseFloat(monto_total),
        forma_pago, cuenta_fin_id ? parseInt(cuenta_fin_id) : null,
        cheque_prop_id ? parseInt(cheque_prop_id) : null,
        cheque_ter_id  ? parseInt(cheque_ter_id)  : null,
        referencia || null, notas || null, u ? u.id : null
      );
      const opId = r.lastInsertRowid;

      // Vincular facturas y actualizar saldo_pagado
      for (const c of compras) {
        db.prepare('INSERT INTO fin_op_compras (op_id, compra_id, monto) VALUES (?,?,?)')
          .run(opId, parseInt(c.id), parseFloat(c.monto));
        db.prepare('UPDATE pa_compras SET saldo_pagado = COALESCE(saldo_pagado,0) + ? WHERE id=?')
          .run(parseFloat(c.monto), parseInt(c.id));
      }

      // Generar movimiento bancario si hay cuenta
      let movId = null;
      if (cuenta_fin_id) {
        const mv = db.prepare(`
          INSERT INTO fin_movimientos (cuenta_id, fecha, tipo, concepto, monto, referencia, usuario_id)
          VALUES (?,?,'egreso',?,?,?,?)
        `).run(
          parseInt(cuenta_fin_id), fechaOp,
          'Orden de Pago ' + numero + ' - ' + (referencia || ''),
          parseFloat(monto_total), numero, u ? u.id : null
        );
        movId = mv.lastInsertRowid;
        db.prepare('UPDATE fin_ordenes_pago SET movimiento_id=? WHERE id=?').run(movId, opId);
      }

      // Actualizar cheque propio a "emitido" si aplica
      if (cheque_prop_id) {
        db.prepare("UPDATE fin_cheques_propios SET estado='emitido', pago_id=? WHERE id=?")
          .run(opId, parseInt(cheque_prop_id));
      }

      // ── Asiento contable automático ────────────────────────────────────────
      // Debe: cuenta Proveedores (tomada del asiento de la factura original)
      // Haber: cuenta bancaria/caja con que se pagó
      let asientoId = null;
      try {
        // 1. Cuenta contable del banco
        let cuentaBancariaContableId = null;
        if (cuenta_fin_id) {
          const cuentaFin = db.prepare('SELECT cuenta_contable_id FROM fin_cuentas WHERE id=?')
            .get(parseInt(cuenta_fin_id));
          cuentaBancariaContableId = cuentaFin?.cuenta_contable_id || null;
        }

        // 2. Cuenta Proveedores — buscar en los asientos de las facturas que cancela esta OP
        //    Tomamos la línea con mayor Haber de los asientos vinculados a esas compras
        let cuentaProveedorId = null;
        const compraIds = compras.map(c => parseInt(c.id));
        if (compraIds.length) {
          const placeholders = compraIds.map(() => '?').join(',');
          const lineaProv = db.prepare(`
            SELECT l.cuenta_id, SUM(l.haber) as total_haber
            FROM pa_asientos a
            JOIN pa_asientos_lineas l ON l.asiento_id = a.id
            WHERE a.ref_compra_id IN (${placeholders})
              AND a.anulado = 0
              AND l.haber > 0
            GROUP BY l.cuenta_id
            ORDER BY total_haber DESC
            LIMIT 1
          `).get(...compraIds);
          cuentaProveedorId = lineaProv?.cuenta_id || null;
        }

        // 3. Fallback: buscar en el modelo del proveedor si no encontramos en los asientos
        if (!cuentaProveedorId) {
          const lineaMod = db.prepare(`
            SELECT aml.cuenta_id
            FROM adm_asientos_modelo_lineas aml
            JOIN adm_proveedores ap ON ap.asiento_modelo_id = aml.modelo_id
            WHERE ap.id = ? AND aml.tipo_linea = 'proveedores'
            LIMIT 1
          `).get(parseInt(proveedor_id));
          cuentaProveedorId = lineaMod?.cuenta_id || null;
        }

        if (cuentaBancariaContableId && cuentaProveedorId) {
          const prov = db.prepare('SELECT razon_social FROM adm_proveedores WHERE id=?')
            .get(parseInt(proveedor_id));
          const nombreProv = prov?.razon_social || `Prov. #${proveedor_id}`;

          const asiento = db.prepare(`
            INSERT INTO pa_asientos (fecha, descripcion, usuario_id, ref_codigo)
            VALUES (?, ?, ?, ?)
          `).run(
            fechaOp,
            `OP ${numero} | ${nombreProv} | Cancelación`,
            u ? u.id : null,
            numero
          );
          asientoId = asiento.lastInsertRowid;

          // Debe: cuenta Proveedores (cancela el pasivo)
          db.prepare(`
            INSERT INTO pa_asientos_lineas (asiento_id, cuenta_id, debe, haber, descripcion)
            VALUES (?, ?, ?, 0, ?)
          `).run(asientoId, cuentaProveedorId, parseFloat(monto_total),
            `Cancelación deuda — ${numero}`);

          // Haber: cuenta bancaria/caja
          db.prepare(`
            INSERT INTO pa_asientos_lineas (asiento_id, cuenta_id, debe, haber, descripcion)
            VALUES (?, ?, 0, ?, ?)
          `).run(asientoId, cuentaBancariaContableId, parseFloat(monto_total),
            `Pago ${forma_pago} — ${numero}`);

          db.prepare('UPDATE fin_ordenes_pago SET asiento_id=? WHERE id=?').run(asientoId, opId);
          console.log(`[OP] Asiento #${asientoId} generado para ${numero} — Prov. cta ${cuentaProveedorId} / Banco cta ${cuentaBancariaContableId}`);
        } else {
          console.log(`[OP] ${numero} sin asiento: falta ${!cuentaProveedorId ? 'cuenta proveedores (cargá la factura con asiento primero)' : 'cuenta contable del banco'}`);
        }
      } catch(eAsiento) {
        console.error(`[OP] Error generando asiento para ${numero}:`, eAsiento.message);
      }

      return { opId, numero, asientoId };
    });

    const result = crear();
    res.json({ ok: true, id: result.opId, numero: result.numero, asiento_id: result.asientoId });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── PATCH /api/fin/ordenes/:id/anular ───────────────────────────────────
router.patch('/:id/anular', (req, res) => {
  try {
    const op = db.prepare('SELECT * FROM fin_ordenes_pago WHERE id=?').get(req.params.id);
    if (!op) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });
    if (op.estado === 'anulada') return res.json({ ok: true, msg: 'Ya estaba anulada' });

    const anular = db.transaction(() => {
      // Revertir saldo_pagado
      const items = db.prepare('SELECT compra_id, monto FROM fin_op_compras WHERE op_id=?').all(op.id);
      for (const it of items) {
        db.prepare('UPDATE pa_compras SET saldo_pagado = MAX(0, COALESCE(saldo_pagado,0) - ?) WHERE id=?')
          .run(it.monto, it.compra_id);
      }
      // Eliminar movimiento bancario
      if (op.movimiento_id) {
        db.prepare('DELETE FROM fin_movimientos WHERE id=?').run(op.movimiento_id);
      }
      // Revertir cheque propio
      if (op.cheque_prop_id) {
        db.prepare("UPDATE fin_cheques_propios SET estado='disponible', pago_id=NULL WHERE id=?")
          .run(op.cheque_prop_id);
      }
      // Anular asiento contable si existe
      if (op.asiento_id) {
        db.prepare("UPDATE pa_asientos SET anulado=1, anulado_en=datetime('now','localtime') WHERE id=?")
          .run(op.asiento_id);
        console.log(`[OP] Asiento #${op.asiento_id} anulado junto con OP #${op.id}`);
      }
      db.prepare("UPDATE fin_ordenes_pago SET estado='anulada' WHERE id=?").run(op.id);
    });
    anular();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
