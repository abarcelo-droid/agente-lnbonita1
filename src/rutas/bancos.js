// src/rutas/bancos.js
// ── MÓDULO CAJA Y BANCOS ─────────────────────────────────────────────────────
import express from 'express';
import db from '../servicios/db_pa.js';

const router = express.Router();

function getUser(req) {
  try { return req.cookies?.lnb_user ? JSON.parse(req.cookies.lnb_user) : null; }
  catch(e) { return null; }
}

// ── Multisociedad (Fase 2) ──────────────────────────────────────────────────
// Cada caja/cuenta pertenece a una sociedad. Cheques/movimientos/OP derivan la
// sociedad de su cuenta raíz. Si el request no manda sociedad_id, se usa PC por
// defecto (selector UI = follow-up).
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
  return c ? c.sociedad_id : sociedadPCId();
}
function sociedadDeChequera(chequeraId) {
  const ch = db.prepare('SELECT sociedad_id FROM fin_chequeras WHERE id = ?').get(parseInt(chequeraId));
  return ch ? ch.sociedad_id : sociedadPCId();
}

// ────────────────────────────────────────────────────────────────────────────
// CUENTAS
// ────────────────────────────────────────────────────────────────────────────

// GET /api/fin/cuentas
router.get('/cuentas', (req, res) => {
  try {
    const sociedadId = getSociedadId(req);
    const cuentas = db.prepare(`
      SELECT c.*,
        COALESCE(c.saldo_inicial, 0) +
        COALESCE((SELECT SUM(CASE WHEN tipo='ingreso' THEN monto ELSE -monto END)
                  FROM fin_movimientos WHERE cuenta_id = c.id), 0) AS saldo_actual
      FROM fin_cuentas c
      WHERE c.activo = 1 AND c.sociedad_id = ?
      ORDER BY c.tipo, c.nombre
    `).all(sociedadId);
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
  const { nombre, tipo, banco, nro_cuenta, cbu, alias, moneda, saldo_inicial, cuenta_contable_id, ambito } = req.body || {};
  if (!nombre) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
  const sociedadId = getSociedadId(req);
  // El ámbito interno solo aplica a cajas de efectivo; banco/cheque/transferencia siempre fiscal.
  const ambitoFinal = (tipo === 'caja' && ambito === 'interno') ? 'interno' : 'fiscal';
  try {
    const r = db.prepare(`
      INSERT INTO fin_cuentas (sociedad_id, nombre, tipo, banco, nro_cuenta, cbu, alias, moneda, saldo_inicial, cuenta_contable_id, ambito)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sociedadId, nombre.trim(), tipo||'cuenta_corriente', banco||null, nro_cuenta||null, cbu||null, alias||null, moneda||'ARS', parseFloat(saldo_inicial||0), cuenta_contable_id?parseInt(cuenta_contable_id):null, ambitoFinal);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PUT /api/fin/cuentas/:id
router.put('/cuentas/:id', (req, res) => {
  const { nombre, tipo, banco, nro_cuenta, cbu, alias, moneda, saldo_inicial, cuenta_contable_id, ambito } = req.body || {};
  try {
    const actual = db.prepare('SELECT * FROM fin_cuentas WHERE id=?').get(req.params.id);
    if (!actual) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });
    const tipoFinal = tipo||actual.tipo;
    const ambitoFinal = (tipoFinal === 'caja' && (ambito||actual.ambito) === 'interno') ? 'interno' : 'fiscal';
    db.prepare(`
      UPDATE fin_cuentas SET nombre=?, tipo=?, banco=?, nro_cuenta=?, cbu=?, alias=?, moneda=?, saldo_inicial=?, cuenta_contable_id=?, ambito=? WHERE id=?
    `).run(nombre||actual.nombre, tipoFinal, banco||null, nro_cuenta||null, cbu||null, alias||null, moneda||actual.moneda, parseFloat(saldo_inicial??actual.saldo_inicial), cuenta_contable_id?parseInt(cuenta_contable_id):null, ambitoFinal, req.params.id);
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
    const sociedadId = getSociedadId(req);
    let sql = `SELECT ch.*, c.nombre as cuenta_nombre, c.banco FROM fin_chequeras ch JOIN fin_cuentas c ON c.id=ch.cuenta_id WHERE ch.activo=1 AND ch.sociedad_id = ?`;
    const params = [sociedadId];
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
    const r = db.prepare(`INSERT INTO fin_chequeras (cuenta_id, nro_chequera, desde, hasta, sociedad_id) VALUES (?,?,?,?,?)`)
      .run(parseInt(cuenta_id), nro_chequera||null, parseInt(desde), parseInt(hasta), sociedadDeCuenta(cuenta_id));
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
    const sociedadId = getSociedadId(req);
    let sql = `SELECT cp.*, ch.cuenta_id, c.nombre as cuenta_nombre, c.banco FROM fin_cheques_propios cp JOIN fin_chequeras ch ON ch.id=cp.chequera_id JOIN fin_cuentas c ON c.id=ch.cuenta_id WHERE cp.sociedad_id = ?`;
    const params = [sociedadId];
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
    const r = db.prepare(`INSERT INTO fin_cheques_propios (chequera_id, nro_cheque, monto, beneficiario, fecha_emision, fecha_vto, notas, pago_id, sociedad_id)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(parseInt(chequera_id), parseInt(nro_cheque), parseFloat(monto), beneficiario||null,
           fecha_emision||new Date().toISOString().split('T')[0], fecha_vto||null, notas||null, pago_id?parseInt(pago_id):null, sociedadDeChequera(chequera_id));
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
    const sociedadId = getSociedadId(req);
    let sql = `SELECT * FROM fin_cheques_terceros WHERE sociedad_id = ?`;
    const params = [sociedadId];
    if (estado) { sql += ' AND estado=?'; params.push(estado); }
    sql += ' ORDER BY fecha_vto ASC, id DESC';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/fin/cheques-terceros
router.post('/cheques-terceros', (req, res) => {
  const { banco, nro_cheque, librador, monto, fecha_recepcion, fecha_vto, notas, cuenta_contable_id } = req.body || {};
  if (!monto) return res.status(400).json({ ok: false, error: 'Monto requerido' });
  const sociedadId = getSociedadId(req);
  try {
    const r = db.prepare(`INSERT INTO fin_cheques_terceros (banco, nro_cheque, librador, monto, fecha_recepcion, fecha_vto, notas, cuenta_contable_id, sociedad_id)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(banco||null, nro_cheque||null, librador||null, parseFloat(monto),
           fecha_recepcion||new Date().toISOString().split('T')[0], fecha_vto||null, notas||null,
           cuenta_contable_id?parseInt(cuenta_contable_id):null, sociedadId);
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
    const { cuentaId, desde, hasta, solo_caja } = req.query;
    const sociedadId = getSociedadId(req);
    let sql = `SELECT m.*, c.nombre as cuenta_nombre, c.ambito as cuenta_ambito, c.tipo as cuenta_tipo FROM fin_movimientos m JOIN fin_cuentas c ON c.id=m.cuenta_id WHERE m.sociedad_id = ?`;
    const params = [sociedadId];
    if (cuentaId)  { sql += ' AND m.cuenta_id=?'; params.push(parseInt(cuentaId)); }
    if (solo_caja === '1') { sql += " AND c.tipo='caja'"; }
    if (desde)     { sql += ' AND m.fecha>=?'; params.push(desde); }
    if (hasta)     { sql += ' AND m.fecha<=?'; params.push(hasta); }
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
    const r = db.prepare(`INSERT INTO fin_movimientos (cuenta_id, fecha, tipo, concepto, monto, referencia, pago_id, usuario_id, sociedad_id)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(parseInt(cuenta_id), fecha||new Date().toISOString().split('T')[0], tipo, concepto.trim(),
           parseFloat(monto), referencia||null, pago_id?parseInt(pago_id):null, u?u.id:null, sociedadDeCuenta(cuenta_id));
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

// ────────────────────────────────────────────────────────────────────────────
// CONCILIACIÓN BANCARIA
// ────────────────────────────────────────────────────────────────────────────

// GET /api/fin/conciliacion?cuentaId=&periodo=
router.get('/conciliacion', (req, res) => {
  try {
    const { cuentaId, periodo } = req.query;
    if (!cuentaId) return res.status(400).json({ ok: false, error: 'cuentaId requerido' });

    // Movimientos propios del período
    let sqlMov = `SELECT m.*, 'libro' as origen FROM fin_movimientos m WHERE m.cuenta_id=?`;
    const params = [parseInt(cuentaId)];
    if (periodo) { sqlMov += ` AND strftime('%Y-%m', m.fecha)=?`; params.push(periodo); }
    sqlMov += ' ORDER BY m.fecha, m.id';
    const movimientos = db.prepare(sqlMov).all(...params);

    // Líneas del extracto del período
    let sqlExt = `SELECT * FROM fin_extracto_lineas WHERE cuenta_id=?`;
    const paramsExt = [parseInt(cuentaId)];
    if (periodo) { sqlExt += ` AND strftime('%Y-%m', fecha)=?`; paramsExt.push(periodo); }
    sqlExt += ' ORDER BY fecha, id';
    const extracto = db.prepare(sqlExt).all(...paramsExt);

    // Saldo libro = saldo_inicial + movimientos hasta fin del período
    const cuenta = db.prepare('SELECT * FROM fin_cuentas WHERE id=?').get(parseInt(cuentaId));
    const saldoLibro = movimientos.reduce((s, m) => s + (m.tipo === 'ingreso' ? m.monto : -m.monto),
      parseFloat(cuenta?.saldo_inicial || 0));
    const saldoExtracto = extracto.reduce((s, e) => s + (e.tipo === 'ingreso' ? e.monto : -e.monto), 0);

    res.json({ ok: true, movimientos, extracto, saldo_libro: saldoLibro, saldo_extracto: saldoExtracto,
      diferencia: saldoLibro - saldoExtracto });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/fin/conciliacion/extracto — cargar líneas del extracto
router.post('/conciliacion/extracto', (req, res) => {
  const { cuenta_id, periodo, lineas } = req.body || {};
  if (!cuenta_id || !lineas?.length) return res.status(400).json({ ok: false, error: 'cuenta_id y lineas requeridos' });
  try {
    const sociedadId = sociedadDeCuenta(cuenta_id);
    const ins = db.prepare(`INSERT INTO fin_extracto_lineas (cuenta_id, fecha, concepto, monto, tipo, referencia, periodo, sociedad_id)
      VALUES (?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      for (const l of lineas) {
        ins.run(parseInt(cuenta_id), l.fecha, l.concepto||null, Math.abs(parseFloat(l.monto)),
          l.tipo || (parseFloat(l.monto) >= 0 ? 'ingreso' : 'egreso'),
          l.referencia||null, periodo||null, sociedadId);
      }
    });
    tx();
    res.json({ ok: true, insertadas: lineas.length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PATCH /api/fin/conciliacion/conciliar — marcar línea extracto como conciliada con movimiento
router.patch('/conciliacion/conciliar', (req, res) => {
  const { extracto_id, movimiento_id } = req.body || {};
  if (!extracto_id) return res.status(400).json({ ok: false, error: 'extracto_id requerido' });
  try {
    db.prepare('UPDATE fin_extracto_lineas SET conciliado=1, movimiento_id=? WHERE id=?')
      .run(movimiento_id ? parseInt(movimiento_id) : null, parseInt(extracto_id));
    if (movimiento_id) {
      db.prepare('UPDATE fin_movimientos SET conciliado=1 WHERE id=?').run(parseInt(movimiento_id));
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PATCH /api/fin/conciliacion/desconciliar
router.patch('/conciliacion/desconciliar', (req, res) => {
  const { extracto_id } = req.body || {};
  if (!extracto_id) return res.status(400).json({ ok: false, error: 'extracto_id requerido' });
  try {
    const linea = db.prepare('SELECT * FROM fin_extracto_lineas WHERE id=?').get(parseInt(extracto_id));
    if (linea?.movimiento_id) {
      db.prepare('UPDATE fin_movimientos SET conciliado=0 WHERE id=?').run(linea.movimiento_id);
    }
    db.prepare('UPDATE fin_extracto_lineas SET conciliado=0, movimiento_id=NULL WHERE id=?').run(parseInt(extracto_id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/fin/conciliacion/extracto/:id
router.delete('/conciliacion/extracto/:id', (req, res) => {
  try {
    const linea = db.prepare('SELECT * FROM fin_extracto_lineas WHERE id=?').get(req.params.id);
    if (linea?.movimiento_id) {
      db.prepare('UPDATE fin_movimientos SET conciliado=0 WHERE id=?').run(linea.movimiento_id);
    }
    db.prepare('DELETE FROM fin_extracto_lineas WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/fin/conciliacion/auto-match
router.post('/conciliacion/auto-match', (req, res) => {
  const { cuenta_id, periodo } = req.body || {};
  if (!cuenta_id) return res.status(400).json({ ok:false, error:'cuenta_id requerido' });
  try {
    let sqlExt='SELECT * FROM fin_extracto_lineas WHERE cuenta_id=? AND conciliado=0';
    const pe=[parseInt(cuenta_id)];
    if(periodo){sqlExt+=" AND strftime('%Y-%m',fecha)=?";pe.push(periodo);}
    const lineasPend=db.prepare(sqlExt).all(...pe);
    let sqlMov='SELECT * FROM fin_movimientos WHERE cuenta_id=? AND conciliado=0';
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
            db.prepare('UPDATE fin_extracto_lineas SET conciliado=1,movimiento_id=? WHERE id=?').run(mov.id,ext.id);
            db.prepare('UPDATE fin_movimientos SET conciliado=1 WHERE id=?').run(mov.id);
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
