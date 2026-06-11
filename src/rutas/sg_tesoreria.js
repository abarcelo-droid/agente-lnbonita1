// src/rutas/sg_tesoreria.js
// ── CAJA Y BANCOS SG — copia de rutas/bancos.js repuntada a tablas sg_fin_* ───
// Copia física de la Tesorería de PC para que SG diverja. Cuentas/cajas,
// chequeras, cheques propios y de terceros, movimientos y conciliación bancaria,
// sobre sg_fin_*. cuenta_contable_id apunta a sg_cuentas. SIN dimensión
// sociedad_id (tablas SG-only). Montado en /api/sg/tesoreria.
//
// NOTA — Órdenes de Pago / Pagos a proveedores: NO se portan acá. Su circuito en
// PC paga facturas de compra (pa_compras) vía proveedores (adm_proveedores), que
// son de PC; en SG el circuito de compras vive en Abasto SG. El vínculo OP→compra
// SG es una decisión de divergencia futura. Las tablas sg_fin_ordenes_pago /
// sg_pagos_proveedores existen (db_sg_finanzas.js) por paridad estructural, pero
// su backend/UI quedan pendientes a propósito.

import express from 'express';
import db from '../servicios/db_sg_finanzas.js';

const router = express.Router();

function getUser(req) {
  try { return req.cookies?.lnb_user ? JSON.parse(req.cookies.lnb_user) : null; }
  catch(e) { return null; }
}

// ────────────────────────────────────────────────────────────────────────────
// CUENTAS
// ────────────────────────────────────────────────────────────────────────────

router.get('/cuentas', (req, res) => {
  try {
    const cuentas = db.prepare(`
      SELECT c.*,
        COALESCE(c.saldo_inicial, 0) +
        COALESCE((SELECT SUM(CASE WHEN tipo='ingreso' THEN monto ELSE -monto END)
                  FROM sg_fin_movimientos WHERE cuenta_id = c.id), 0) AS saldo_actual
      FROM sg_fin_cuentas c
      WHERE c.activo = 1
      ORDER BY c.tipo, c.nombre
    `).all();
    res.json({ ok: true, data: cuentas });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/cuentas/:id', (req, res) => {
  try {
    const c = db.prepare(`
      SELECT c.*,
        COALESCE(c.saldo_inicial, 0) +
        COALESCE((SELECT SUM(CASE WHEN tipo='ingreso' THEN monto ELSE -monto END)
                  FROM sg_fin_movimientos WHERE cuenta_id = c.id), 0) AS saldo_actual
      FROM sg_fin_cuentas c WHERE c.id = ?
    `).get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });
    res.json({ ok: true, data: c });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/cuentas', (req, res) => {
  const { nombre, tipo, banco, nro_cuenta, cbu, alias, moneda, saldo_inicial, cuenta_contable_id, ambito } = req.body || {};
  if (!nombre) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
  const ambitoFinal = (tipo === 'caja' && ambito === 'interno') ? 'interno' : 'fiscal';
  try {
    const r = db.prepare(`
      INSERT INTO sg_fin_cuentas (nombre, tipo, banco, nro_cuenta, cbu, alias, moneda, saldo_inicial, cuenta_contable_id, ambito)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nombre.trim(), tipo||'cuenta_corriente', banco||null, nro_cuenta||null, cbu||null, alias||null, moneda||'ARS', parseFloat(saldo_inicial||0), cuenta_contable_id?parseInt(cuenta_contable_id):null, ambitoFinal);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.put('/cuentas/:id', (req, res) => {
  const { nombre, tipo, banco, nro_cuenta, cbu, alias, moneda, saldo_inicial, cuenta_contable_id, ambito } = req.body || {};
  try {
    const actual = db.prepare('SELECT * FROM sg_fin_cuentas WHERE id=?').get(req.params.id);
    if (!actual) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });
    const tipoFinal = tipo||actual.tipo;
    const ambitoFinal = (tipoFinal === 'caja' && (ambito||actual.ambito) === 'interno') ? 'interno' : 'fiscal';
    db.prepare(`
      UPDATE sg_fin_cuentas SET nombre=?, tipo=?, banco=?, nro_cuenta=?, cbu=?, alias=?, moneda=?, saldo_inicial=?, cuenta_contable_id=?, ambito=? WHERE id=?
    `).run(nombre||actual.nombre, tipoFinal, banco||null, nro_cuenta||null, cbu||null, alias||null, moneda||actual.moneda, parseFloat(saldo_inicial??actual.saldo_inicial), cuenta_contable_id?parseInt(cuenta_contable_id):null, ambitoFinal, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/cuentas/:id', (req, res) => {
  try {
    db.prepare('UPDATE sg_fin_cuentas SET activo=0 WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────
// CHEQUERAS
// ────────────────────────────────────────────────────────────────────────────

router.get('/chequeras', (req, res) => {
  try {
    const { cuentaId } = req.query;
    let sql = `SELECT ch.*, c.nombre as cuenta_nombre, c.banco FROM sg_fin_chequeras ch JOIN sg_fin_cuentas c ON c.id=ch.cuenta_id WHERE ch.activo=1`;
    const params = [];
    if (cuentaId) { sql += ' AND ch.cuenta_id=?'; params.push(parseInt(cuentaId)); }
    sql += ' ORDER BY ch.id DESC';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/chequeras', (req, res) => {
  const { cuenta_id, nro_chequera, desde, hasta } = req.body || {};
  if (!cuenta_id || !desde || !hasta) return res.status(400).json({ ok: false, error: 'cuenta_id, desde y hasta son requeridos' });
  try {
    const r = db.prepare(`INSERT INTO sg_fin_chequeras (cuenta_id, nro_chequera, desde, hasta) VALUES (?,?,?,?)`)
      .run(parseInt(cuenta_id), nro_chequera||null, parseInt(desde), parseInt(hasta));
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/chequeras/:id', (req, res) => {
  try {
    db.prepare('UPDATE sg_fin_chequeras SET activo=0 WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────
// CHEQUES PROPIOS
// ────────────────────────────────────────────────────────────────────────────

router.get('/cheques-propios', (req, res) => {
  try {
    const { cuentaId, estado } = req.query;
    let sql = `SELECT cp.*, ch.cuenta_id, c.nombre as cuenta_nombre, c.banco FROM sg_fin_cheques_propios cp JOIN sg_fin_chequeras ch ON ch.id=cp.chequera_id JOIN sg_fin_cuentas c ON c.id=ch.cuenta_id WHERE 1 = 1`;
    const params = [];
    if (cuentaId) { sql += ' AND ch.cuenta_id=?'; params.push(parseInt(cuentaId)); }
    if (estado)   { sql += ' AND cp.estado=?'; params.push(estado); }
    sql += ' ORDER BY cp.fecha_emision DESC, cp.nro_cheque DESC';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/cheques-propios', (req, res) => {
  const { chequera_id, nro_cheque, monto, beneficiario, fecha_emision, fecha_vto, notas, pago_id } = req.body || {};
  if (!chequera_id || !nro_cheque || !monto) return res.status(400).json({ ok: false, error: 'chequera_id, nro_cheque y monto son requeridos' });
  try {
    const r = db.prepare(`INSERT INTO sg_fin_cheques_propios (chequera_id, nro_cheque, monto, beneficiario, fecha_emision, fecha_vto, notas, pago_id)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(parseInt(chequera_id), parseInt(nro_cheque), parseFloat(monto), beneficiario||null,
           fecha_emision||new Date().toISOString().split('T')[0], fecha_vto||null, notas||null, pago_id?parseInt(pago_id):null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/cheques-propios/:id/estado', (req, res) => {
  const { estado } = req.body || {};
  const estados = ['emitido','cobrado','rechazado','anulado'];
  if (!estados.includes(estado)) return res.status(400).json({ ok: false, error: 'Estado inválido' });
  try {
    db.prepare('UPDATE sg_fin_cheques_propios SET estado=? WHERE id=?').run(estado, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────
// CHEQUES DE TERCEROS
// ────────────────────────────────────────────────────────────────────────────

router.get('/cheques-terceros', (req, res) => {
  try {
    const { estado } = req.query;
    let sql = `SELECT * FROM sg_fin_cheques_terceros WHERE 1 = 1`;
    const params = [];
    if (estado) { sql += ' AND estado=?'; params.push(estado); }
    sql += ' ORDER BY fecha_vto ASC, id DESC';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/cheques-terceros', (req, res) => {
  const { banco, nro_cheque, librador, monto, fecha_recepcion, fecha_vto, notas, cuenta_contable_id } = req.body || {};
  if (!monto) return res.status(400).json({ ok: false, error: 'Monto requerido' });
  try {
    const r = db.prepare(`INSERT INTO sg_fin_cheques_terceros (banco, nro_cheque, librador, monto, fecha_recepcion, fecha_vto, notas, cuenta_contable_id)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(banco||null, nro_cheque||null, librador||null, parseFloat(monto),
           fecha_recepcion||new Date().toISOString().split('T')[0], fecha_vto||null, notas||null,
           cuenta_contable_id?parseInt(cuenta_contable_id):null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/cheques-terceros/:id/estado', (req, res) => {
  const { estado } = req.body || {};
  const estados = ['en_cartera','depositado','endosado','rechazado'];
  if (!estados.includes(estado)) return res.status(400).json({ ok: false, error: 'Estado inválido' });
  try {
    db.prepare('UPDATE sg_fin_cheques_terceros SET estado=? WHERE id=?').run(estado, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────
// MOVIMIENTOS
// ────────────────────────────────────────────────────────────────────────────

router.get('/movimientos', (req, res) => {
  try {
    const { cuentaId, desde, hasta, solo_caja } = req.query;
    let sql = `SELECT m.*, c.nombre as cuenta_nombre, c.ambito as cuenta_ambito, c.tipo as cuenta_tipo FROM sg_fin_movimientos m JOIN sg_fin_cuentas c ON c.id=m.cuenta_id WHERE 1 = 1`;
    const params = [];
    if (cuentaId)  { sql += ' AND m.cuenta_id=?'; params.push(parseInt(cuentaId)); }
    if (solo_caja === '1') { sql += " AND c.tipo='caja'"; }
    if (desde)     { sql += ' AND m.fecha>=?'; params.push(desde); }
    if (hasta)     { sql += ' AND m.fecha<=?'; params.push(hasta); }
    sql += ' ORDER BY m.fecha DESC, m.id DESC';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/movimientos', (req, res) => {
  const u = getUser(req);
  const { cuenta_id, fecha, tipo, concepto, monto, referencia, pago_id } = req.body || {};
  if (!cuenta_id || !tipo || !concepto || !monto) return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  try {
    const r = db.prepare(`INSERT INTO sg_fin_movimientos (cuenta_id, fecha, tipo, concepto, monto, referencia, pago_id, usuario_id)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(parseInt(cuenta_id), fecha||new Date().toISOString().split('T')[0], tipo, concepto.trim(),
           parseFloat(monto), referencia||null, pago_id?parseInt(pago_id):null, u?u.id:null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/movimientos/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM sg_fin_movimientos WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────
// CONCILIACIÓN BANCARIA
// ────────────────────────────────────────────────────────────────────────────

router.get('/conciliacion', (req, res) => {
  try {
    const { cuentaId, periodo } = req.query;
    if (!cuentaId) return res.status(400).json({ ok: false, error: 'cuentaId requerido' });

    let sqlMov = `SELECT m.*, 'libro' as origen FROM sg_fin_movimientos m WHERE m.cuenta_id=?`;
    const params = [parseInt(cuentaId)];
    if (periodo) { sqlMov += ` AND strftime('%Y-%m', m.fecha)=?`; params.push(periodo); }
    sqlMov += ' ORDER BY m.fecha, m.id';
    const movimientos = db.prepare(sqlMov).all(...params);

    let sqlExt = `SELECT * FROM sg_fin_extracto_lineas WHERE cuenta_id=?`;
    const paramsExt = [parseInt(cuentaId)];
    if (periodo) { sqlExt += ` AND strftime('%Y-%m', fecha)=?`; paramsExt.push(periodo); }
    sqlExt += ' ORDER BY fecha, id';
    const extracto = db.prepare(sqlExt).all(...paramsExt);

    const cuenta = db.prepare('SELECT * FROM sg_fin_cuentas WHERE id=?').get(parseInt(cuentaId));
    const saldoLibro = movimientos.reduce((s, m) => s + (m.tipo === 'ingreso' ? m.monto : -m.monto),
      parseFloat(cuenta?.saldo_inicial || 0));
    const saldoExtracto = extracto.reduce((s, e) => s + (e.tipo === 'ingreso' ? e.monto : -e.monto), 0);

    res.json({ ok: true, movimientos, extracto, saldo_libro: saldoLibro, saldo_extracto: saldoExtracto,
      diferencia: saldoLibro - saldoExtracto });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/conciliacion/extracto', (req, res) => {
  const { cuenta_id, periodo, lineas } = req.body || {};
  if (!cuenta_id || !lineas?.length) return res.status(400).json({ ok: false, error: 'cuenta_id y lineas requeridos' });
  try {
    const ins = db.prepare(`INSERT INTO sg_fin_extracto_lineas (cuenta_id, fecha, concepto, monto, tipo, referencia, periodo)
      VALUES (?,?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      for (const l of lineas) {
        ins.run(parseInt(cuenta_id), l.fecha, l.concepto||null, Math.abs(parseFloat(l.monto)),
          l.tipo || (parseFloat(l.monto) >= 0 ? 'ingreso' : 'egreso'),
          l.referencia||null, periodo||null);
      }
    });
    tx();
    res.json({ ok: true, insertadas: lineas.length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/conciliacion/conciliar', (req, res) => {
  const { extracto_id, movimiento_id } = req.body || {};
  if (!extracto_id) return res.status(400).json({ ok: false, error: 'extracto_id requerido' });
  try {
    db.prepare('UPDATE sg_fin_extracto_lineas SET conciliado=1, movimiento_id=? WHERE id=?')
      .run(movimiento_id ? parseInt(movimiento_id) : null, parseInt(extracto_id));
    if (movimiento_id) {
      db.prepare('UPDATE sg_fin_movimientos SET conciliado=1 WHERE id=?').run(parseInt(movimiento_id));
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/conciliacion/desconciliar', (req, res) => {
  const { extracto_id } = req.body || {};
  if (!extracto_id) return res.status(400).json({ ok: false, error: 'extracto_id requerido' });
  try {
    const linea = db.prepare('SELECT * FROM sg_fin_extracto_lineas WHERE id=?').get(parseInt(extracto_id));
    if (linea?.movimiento_id) {
      db.prepare('UPDATE sg_fin_movimientos SET conciliado=0 WHERE id=?').run(linea.movimiento_id);
    }
    db.prepare('UPDATE sg_fin_extracto_lineas SET conciliado=0, movimiento_id=NULL WHERE id=?').run(parseInt(extracto_id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/conciliacion/extracto/:id', (req, res) => {
  try {
    const linea = db.prepare('SELECT * FROM sg_fin_extracto_lineas WHERE id=?').get(req.params.id);
    if (linea?.movimiento_id) {
      db.prepare('UPDATE sg_fin_movimientos SET conciliado=0 WHERE id=?').run(linea.movimiento_id);
    }
    db.prepare('DELETE FROM sg_fin_extracto_lineas WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/conciliacion/auto-match', (req, res) => {
  const { cuenta_id, periodo } = req.body || {};
  if (!cuenta_id) return res.status(400).json({ ok:false, error:'cuenta_id requerido' });
  try {
    let sqlExt='SELECT * FROM sg_fin_extracto_lineas WHERE cuenta_id=? AND conciliado=0';
    const pe=[parseInt(cuenta_id)];
    if(periodo){sqlExt+=" AND strftime('%Y-%m',fecha)=?";pe.push(periodo);}
    const lineasPend=db.prepare(sqlExt).all(...pe);
    let sqlMov='SELECT * FROM sg_fin_movimientos WHERE cuenta_id=? AND conciliado=0';
    const pm=[parseInt(cuenta_id)];
    if(periodo){sqlMov+=" AND strftime('%Y-%m',fecha)=?";pm.push(periodo);}
    const movPend=db.prepare(sqlMov).all(...pm);
    let matches=0;
    const usados=new Set();
    const tx=db.transaction(()=>{
      for(const ext of lineasPend){
        const extFecha=new Date(ext.fecha);
        for(const mov of movPend){
          if(usados.has(mov.id)) continue;
          if(mov.tipo!==ext.tipo) continue;
          if(Math.abs(mov.monto-ext.monto)>0.01) continue;
          const diff=Math.abs((extFecha-new Date(mov.fecha))/86400000);
          if(diff<=3){
            db.prepare('UPDATE sg_fin_extracto_lineas SET conciliado=1,movimiento_id=? WHERE id=?').run(mov.id,ext.id);
            db.prepare('UPDATE sg_fin_movimientos SET conciliado=1 WHERE id=?').run(mov.id);
            usados.add(mov.id); matches++; break;
          }
        }
      }
    });
    tx();
    res.json({ok:true,matches});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

export default router;
