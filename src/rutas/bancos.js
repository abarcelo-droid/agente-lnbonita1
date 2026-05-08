// src/rutas/bancos.js
// ── MÓDULO CAJA Y BANCOS ─────────────────────────────────────────────────────
import express from 'express';
import db from '../servicios/db_pa.js';

const router = express.Router();

function getUser(req) {
  try { return req.cookies?.lnb_user ? JSON.parse(req.cookies.lnb_user) : null; }
  catch(e) { return null; }
}

// ────────────────────────────────────────────────────────────────────────────
// CUENTAS
// ────────────────────────────────────────────────────────────────────────────

// GET /api/fin/cuentas
router.get('/cuentas', (req, res) => {
  try {
    const cuentas = db.prepare(`
      SELECT c.*,
        COALESCE(c.saldo_inicial, 0) +
        COALESCE((SELECT SUM(CASE WHEN tipo='ingreso' THEN monto ELSE -monto END)
                  FROM fin_movimientos WHERE cuenta_id = c.id), 0) AS saldo_actual
      FROM fin_cuentas c
      WHERE c.activo = 1
      ORDER BY c.tipo, c.nombre
    `).all();
    res.json({ ok: true, data: cuentas });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/fin/cuentas/:id
router.get('/cuentas/:id', (req, res) => {
  try {
    const c = db.prepare(`
      SELECT c.*,
        COALESCE(c.saldo_inicial, 0) +
        COALESCE((SELECT SUM(CASE WHEN tipo='ingreso' THEN monto ELSE -monto END)
                  FROM fin_movimientos WHERE cuenta_id = c.id), 0) AS saldo_actual
      FROM fin_cuentas c WHERE c.id = ?
    `).get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });
    res.json({ ok: true, data: c });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/fin/cuentas
router.post('/cuentas', (req, res) => {
  const { nombre, tipo, banco, nro_cuenta, cbu, alias, moneda, saldo_inicial } = req.body || {};
  if (!nombre) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
  try {
    const r = db.prepare(`
      INSERT INTO fin_cuentas (nombre, tipo, banco, nro_cuenta, cbu, alias, moneda, saldo_inicial)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nombre.trim(), tipo||'cuenta_corriente', banco||null, nro_cuenta||null, cbu||null, alias||null, moneda||'ARS', parseFloat(saldo_inicial||0));
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PUT /api/fin/cuentas/:id
router.put('/cuentas/:id', (req, res) => {
  const { nombre, tipo, banco, nro_cuenta, cbu, alias, moneda, saldo_inicial } = req.body || {};
  try {
    const actual = db.prepare('SELECT * FROM fin_cuentas WHERE id=?').get(req.params.id);
    if (!actual) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });
    db.prepare(`
      UPDATE fin_cuentas SET nombre=?, tipo=?, banco=?, nro_cuenta=?, cbu=?, alias=?, moneda=?, saldo_inicial=? WHERE id=?
    `).run(nombre||actual.nombre, tipo||actual.tipo, banco||null, nro_cuenta||null, cbu||null, alias||null, moneda||actual.moneda, parseFloat(saldo_inicial??actual.saldo_inicial), req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/fin/cuentas/:id (soft)
router.delete('/cuentas/:id', (req, res) => {
  try {
    db.prepare('UPDATE fin_cuentas SET activo=0 WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────
// CHEQUERAS
// ────────────────────────────────────────────────────────────────────────────

// GET /api/fin/chequeras?cuentaId=
router.get('/chequeras', (req, res) => {
  try {
    const { cuentaId } = req.query;
    let sql = `SELECT ch.*, c.nombre as cuenta_nombre, c.banco FROM fin_chequeras ch JOIN fin_cuentas c ON c.id=ch.cuenta_id WHERE ch.activo=1`;
    const params = [];
    if (cuentaId) { sql += ' AND ch.cuenta_id=?'; params.push(parseInt(cuentaId)); }
    sql += ' ORDER BY ch.id DESC';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/fin/chequeras
router.post('/chequeras', (req, res) => {
  const { cuenta_id, nro_chequera, desde, hasta } = req.body || {};
  if (!cuenta_id || !desde || !hasta) return res.status(400).json({ ok: false, error: 'cuenta_id, desde y hasta son requeridos' });
  try {
    const r = db.prepare(`INSERT INTO fin_chequeras (cuenta_id, nro_chequera, desde, hasta) VALUES (?,?,?,?)`)
      .run(parseInt(cuenta_id), nro_chequera||null, parseInt(desde), parseInt(hasta));
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/fin/chequeras/:id
router.delete('/chequeras/:id', (req, res) => {
  try {
    db.prepare('UPDATE fin_chequeras SET activo=0 WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────
// CHEQUES PROPIOS
// ────────────────────────────────────────────────────────────────────────────

// GET /api/fin/cheques-propios?cuentaId=&estado=
router.get('/cheques-propios', (req, res) => {
  try {
    const { cuentaId, estado } = req.query;
    let sql = `SELECT cp.*, ch.cuenta_id, c.nombre as cuenta_nombre, c.banco FROM fin_cheques_propios cp JOIN fin_chequeras ch ON ch.id=cp.chequera_id JOIN fin_cuentas c ON c.id=ch.cuenta_id WHERE 1=1`;
    const params = [];
    if (cuentaId) { sql += ' AND ch.cuenta_id=?'; params.push(parseInt(cuentaId)); }
    if (estado)   { sql += ' AND cp.estado=?'; params.push(estado); }
    sql += ' ORDER BY cp.fecha_emision DESC, cp.nro_cheque DESC';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/fin/cheques-propios
router.post('/cheques-propios', (req, res) => {
  const { chequera_id, nro_cheque, monto, beneficiario, fecha_emision, fecha_vto, notas, pago_id } = req.body || {};
  if (!chequera_id || !nro_cheque || !monto) return res.status(400).json({ ok: false, error: 'chequera_id, nro_cheque y monto son requeridos' });
  try {
    const r = db.prepare(`INSERT INTO fin_cheques_propios (chequera_id, nro_cheque, monto, beneficiario, fecha_emision, fecha_vto, notas, pago_id)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(parseInt(chequera_id), parseInt(nro_cheque), parseFloat(monto), beneficiario||null,
           fecha_emision||new Date().toISOString().split('T')[0], fecha_vto||null, notas||null, pago_id?parseInt(pago_id):null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PATCH /api/fin/cheques-propios/:id/estado
router.patch('/cheques-propios/:id/estado', (req, res) => {
  const { estado } = req.body || {};
  const estados = ['emitido','cobrado','rechazado','anulado'];
  if (!estados.includes(estado)) return res.status(400).json({ ok: false, error: 'Estado inválido' });
  try {
    db.prepare('UPDATE fin_cheques_propios SET estado=? WHERE id=?').run(estado, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────
// CHEQUES DE TERCEROS
// ────────────────────────────────────────────────────────────────────────────

// GET /api/fin/cheques-terceros?estado=
router.get('/cheques-terceros', (req, res) => {
  try {
    const { estado } = req.query;
    let sql = `SELECT * FROM fin_cheques_terceros WHERE 1=1`;
    const params = [];
    if (estado) { sql += ' AND estado=?'; params.push(estado); }
    sql += ' ORDER BY fecha_vto ASC, id DESC';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/fin/cheques-terceros
router.post('/cheques-terceros', (req, res) => {
  const { banco, nro_cheque, librador, monto, fecha_recepcion, fecha_vto, notas } = req.body || {};
  if (!monto) return res.status(400).json({ ok: false, error: 'Monto requerido' });
  try {
    const r = db.prepare(`INSERT INTO fin_cheques_terceros (banco, nro_cheque, librador, monto, fecha_recepcion, fecha_vto, notas)
      VALUES (?,?,?,?,?,?,?)`)
      .run(banco||null, nro_cheque||null, librador||null, parseFloat(monto),
           fecha_recepcion||new Date().toISOString().split('T')[0], fecha_vto||null, notas||null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PATCH /api/fin/cheques-terceros/:id/estado
router.patch('/cheques-terceros/:id/estado', (req, res) => {
  const { estado } = req.body || {};
  const estados = ['en_cartera','depositado','endosado','rechazado'];
  if (!estados.includes(estado)) return res.status(400).json({ ok: false, error: 'Estado inválido' });
  try {
    db.prepare('UPDATE fin_cheques_terceros SET estado=? WHERE id=?').run(estado, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────
// MOVIMIENTOS
// ────────────────────────────────────────────────────────────────────────────

// GET /api/fin/movimientos?cuentaId=&desde=&hasta=
router.get('/movimientos', (req, res) => {
  try {
    const { cuentaId, desde, hasta } = req.query;
    let sql = `SELECT m.*, c.nombre as cuenta_nombre FROM fin_movimientos m JOIN fin_cuentas c ON c.id=m.cuenta_id WHERE 1=1`;
    const params = [];
    if (cuentaId) { sql += ' AND m.cuenta_id=?'; params.push(parseInt(cuentaId)); }
    if (desde)    { sql += ' AND m.fecha>=?'; params.push(desde); }
    if (hasta)    { sql += ' AND m.fecha<=?'; params.push(hasta); }
    sql += ' ORDER BY m.fecha DESC, m.id DESC';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/fin/movimientos
router.post('/movimientos', (req, res) => {
  const u = getUser(req);
  const { cuenta_id, fecha, tipo, concepto, monto, referencia, pago_id } = req.body || {};
  if (!cuenta_id || !tipo || !concepto || !monto) return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  try {
    const r = db.prepare(`INSERT INTO fin_movimientos (cuenta_id, fecha, tipo, concepto, monto, referencia, pago_id, usuario_id)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(parseInt(cuenta_id), fecha||new Date().toISOString().split('T')[0], tipo, concepto.trim(),
           parseFloat(monto), referencia||null, pago_id?parseInt(pago_id):null, u?u.id:null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/fin/movimientos/:id
router.delete('/movimientos/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM fin_movimientos WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
