// src/rutas/ordenes.js
// ── ÓRDENES DE PAGO ──────────────────────────────────────────────────────────
import express from 'express';
import db from '../servicios/db_pa.js';

const router = express.Router();

function getUser(req) {
  try { return req.cookies?.lnb_user ? JSON.parse(req.cookies.lnb_user) : null; }
  catch(e) { return null; }
}

// ── Multisociedad (Fase 2) ──────────────────────────────────────────────────
// La OP pertenece a la sociedad que paga (la de su cuenta/caja; si paga con cheque,
// la del proveedor). La numeración OP-AAAA-NNNN es por sociedad.
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
function sociedadDeCuenta(cuentaId) {
  const c = db.prepare('SELECT sociedad_id FROM fin_cuentas WHERE id = ?').get(parseInt(cuentaId));
  return c ? c.sociedad_id : null;
}
function sociedadDeProveedor(provId) {
  const p = db.prepare('SELECT sociedad_id FROM adm_proveedores WHERE id = ?').get(parseInt(provId));
  return p ? p.sociedad_id : sociedadPCId();
}

function generarNumero(sociedadId) {
  const año = new Date().getFullYear();
  const ultima = db.prepare("SELECT numero FROM fin_ordenes_pago WHERE sociedad_id = ? AND numero LIKE ? ORDER BY id DESC LIMIT 1")
    .get(sociedadId, `OP-${año}-%`);
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
    const sociedadId = getSociedadId(req);
    let sql = `
      SELECT op.*, pr.razon_social as proveedor_nombre,
        fc.nombre as cuenta_nombre
      FROM fin_ordenes_pago op
      LEFT JOIN adm_proveedores pr ON pr.id = op.proveedor_id
      LEFT JOIN fin_cuentas fc ON fc.id = op.cuenta_fin_id
      WHERE op.sociedad_id = ?
    `;
    const params = [sociedadId];
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

  // La OP pertenece a la sociedad de la cuenta/caja con que se paga; si se paga con
  // cheque (sin cuenta), a la del proveedor.
  const sociedadId = cuenta_fin_id
    ? (sociedadDeCuenta(cuenta_fin_id) || sociedadDeProveedor(proveedor_id))
    : sociedadDeProveedor(proveedor_id);

  try {
    const crear = db.transaction(() => {
      const numero = generarNumero(sociedadId);
      const fechaOp = fecha || new Date().toISOString().split('T')[0];

      // Insertar OP
      const r = db.prepare(`
        INSERT INTO fin_ordenes_pago
          (numero, fecha, proveedor_id, monto_total, forma_pago, cuenta_fin_id,
           cheque_prop_id, cheque_ter_id, referencia, notas, estado, usuario_id, sociedad_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,'emitida',?,?)
      `).run(
        numero, fechaOp, parseInt(proveedor_id), parseFloat(monto_total),
        forma_pago, cuenta_fin_id ? parseInt(cuenta_fin_id) : null,
        cheque_prop_id ? parseInt(cheque_prop_id) : null,
        cheque_ter_id  ? parseInt(cheque_ter_id)  : null,
        referencia || null, notas || null, u ? u.id : null, sociedadId
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
          INSERT INTO fin_movimientos (cuenta_id, fecha, tipo, concepto, monto, referencia, usuario_id, sociedad_id)
          VALUES (?,?,'egreso',?,?,?,?,?)
        `).run(
          parseInt(cuenta_fin_id), fechaOp,
          'Orden de Pago ' + numero + ' - ' + (referencia || ''),
          parseFloat(monto_total), numero, u ? u.id : null, sociedadId
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
      let avisoAsiento = null;   // por qué NO hay asiento, para poder mostrarlo
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
            JOIN pa_cuentas c ON c.id = l.cuenta_id
            WHERE a.ref_compra_id IN (${placeholders})
              AND a.anulado = 0
              AND l.haber > 0
              AND a.sociedad_id = ?
              AND c.sociedad_id = ?
            GROUP BY l.cuenta_id
            ORDER BY total_haber DESC
            LIMIT 1
          `).get(...compraIds, sociedadId, sociedadId);
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
            INSERT INTO pa_asientos (fecha, descripcion, usuario_id, ref_codigo, sociedad_id)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            fechaOp,
            `OP ${numero} | ${nombreProv} | Cancelación`,
            u ? u.id : null,
            numero,
            sociedadId
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
          avisoAsiento = !cuentaProveedorId
            ? 'La orden se emitió SIN asiento contable: no se encontró la cuenta de Proveedores. Revisá que el asiento modelo del proveedor tenga una línea marcada como "Proveedores (Haber)".'
            : 'La orden se emitió SIN asiento contable: la cuenta bancaria no tiene cuenta contable asociada.';
          console.log(`[OP] ${numero} sin asiento: ${avisoAsiento}`);
        }
      } catch(eAsiento) {
        // Este catch está DENTRO de la transacción y no relanza, así que la
        // transacción commitea igual. Sin la limpieza de abajo, un error entre el
        // INSERT de la cabecera y el de las líneas dejaba un asiento con 0 o 1
        // línea: desbalanceado, huérfano (asiento_id se setea recién después) y
        // por lo tanto imposible de anular desde ningún lado.
        //
        // No se relanza a propósito: la OP puede existir sin asiento — es lo que
        // ya pasa cuando falta alguna cuenta. Lo que no puede quedar es un asiento
        // a medias.
        if (asientoId) {
          try {
            db.prepare('DELETE FROM pa_asientos_lineas WHERE asiento_id = ?').run(asientoId);
            db.prepare('DELETE FROM pa_asientos WHERE id = ?').run(asientoId);
            console.error(`[OP] Asiento #${asientoId} incompleto: se descartó entero.`);
          } catch (eLimpieza) {
            console.error('[OP] No se pudo limpiar el asiento incompleto:', eLimpieza.message);
          }
          asientoId = null;
        }
        avisoAsiento = 'La orden se emitió, pero el asiento contable no se pudo generar: ' + eAsiento.message;
        console.error(`[OP] Error generando asiento para ${numero}:`, eAsiento.message);
      }

      return { opId, numero, asientoId, avisoAsiento };
    });

    const result = crear();
    // El aviso viaja al panel: antes esto era solo un console.log del servidor, así
    // que una OP sin asiento se veía idéntica a una con asiento.
    res.json({ ok: true, id: result.opId, numero: result.numero,
               asiento_id: result.asientoId, asiento_aviso: result.avisoAsiento || null });
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
