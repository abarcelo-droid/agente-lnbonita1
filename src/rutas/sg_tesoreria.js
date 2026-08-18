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
import { exigirEmpresa, SAN_GERONIMO } from '../servicios/sociedad_modulo.js';

const router = express.Router();

function getUser(req) {
  try { return req.cookies?.lnb_user ? JSON.parse(req.cookies.lnb_user) : null; }
  catch(e) { return null; }
}

// ── ESTE ROUTER NO TENÍA UN SOLO CONTROL ──────────────────────────────────
// Sus dieciséis endpoints de escritura no llevaban NADA: ni requireAuth, ni
// requireAdmin, ni cerrojo de empresa. Lo único que quedaba era el portón /api,
// que sólo pide que haya una sesión válida. Y el nivel Ver/Operar/Anular tampoco
// actuaba: /api/sg/tesoreria no está declarado en ensure_api_prefijos.js, así
// que moduloDeRuta devuelve null y exigirNivel deja pasar.
//
// Resultado medido, con la cadena real de index.js y un usuario real: la
// contadora de Puente Cordón —rol operador, asignada SOLO a Puente Cordón, con
// un único módulo tildado— creaba una caja en San Gerónimo, le metía un
// movimiento de $999.999 y la borraba. Todo 200. El menú le escondía la pantalla,
// pero la dirección de la API contestaba igual.
//
// Se cierra con las mismas dos llaves que el resto: sesión de admin para
// escribir, y el cerrojo de empresa para que parado en otra sociedad no se
// pueda tocar ésta.
function requireAdmin(req, res, next) {
  const u = getUser(req);
  if (!u || u.rol !== 'admin') return res.status(403).json({ error: 'solo admin' });
  req._user = u;
  next();
}

// OPERAR NO ES SER ADMIN (ver CLAUDE.md). requireAdmin queda para PARAMETRIZAR
// —dar de alta una cuenta, una chequera, decidir quién toca una caja—. El
// trabajo del día —recibir un cheque, depositarlo, conciliar— pide sesión, y el
// nivel lo decide exigirNivel mirando la URL contra ensure_api_prefijos.js.
function requireAuth(req, res, next) {
  const u = getUser(req);
  if (!u || !u.id) return res.status(401).json({ ok: false, error: 'No autenticado' });
  req._user = u;
  next();
}

// Corre ANTES que cualquier endpoint: si el pedido viene con OTRA empresa, corta
// con 403 y dice cuál esperaba.
router.use((req, res, next) => {
  if (exigirEmpresa(req, res, SAN_GERONIMO) === null) return;   // ya contestó 403
  next();
});

// ────────────────────────────────────────────────────────────────────────────
// CUENTAS
// ────────────────────────────────────────────────────────────────────────────

router.get('/cuentas', (req, res) => {
  try {
    const cuentas = db.prepare(`
      SELECT c.*,
        (SELECT GROUP_CONCAT(u.nombre, ' · ') FROM sg_fin_cuenta_usuarios cu
           JOIN usuarios u ON u.id = cu.usuario_id
          WHERE cu.cuenta_id = c.id) AS usuarios_nombres,
        (SELECT COUNT(*) FROM sg_fin_cuenta_usuarios cu WHERE cu.cuenta_id = c.id) AS usuarios_n,
        (SELECT COUNT(*) FROM sg_fin_chequeras q WHERE q.cuenta_id = c.id AND q.activo = 1) AS chequeras_n,
        cc.codigo AS cuenta_codigo, cc.nombre AS cuenta_nombre,
        COALESCE(c.saldo_inicial, 0) +
        COALESCE((SELECT SUM(CASE WHEN tipo='ingreso' THEN monto ELSE -monto END)
                  FROM sg_fin_movimientos WHERE cuenta_id = c.id), 0) AS saldo_actual
      FROM sg_fin_cuentas c
      LEFT JOIN sg_cuentas cc ON cc.id = c.cuenta_contable_id
      WHERE c.activo = 1
      ORDER BY c.tipo, c.nombre
    `).all();
    // Cuál puede mover EL QUE PREGUNTA: la pantalla ofrece "+ Movimiento" sólo
    // donde va a poder, en vez de dejar que lo apriete y coma un 403.
    const u = getUser(req);
    res.json({ ok: true, data: cuentas.map((c) => ({ ...c, puedo: puedeMoverCuenta(u, c.id) ? 1 : 0 })) });
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

router.post('/cuentas', requireAdmin, (req, res) => {
  const { nombre, tipo, banco, nro_cuenta, cbu, alias, moneda, saldo_inicial, cuenta_contable_id, ambito, tiene_chequera } = req.body || {};
  if (!nombre) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
  const ambitoFinal = (tipo === 'caja' && ambito === 'interno') ? 'interno' : 'fiscal';
  // Una caja de efectivo no tiene chequera ni por asomo: la marca es de banco.
  const chq = (tipo !== 'caja' && tiene_chequera) ? 1 : 0;
  try {
    const r = db.prepare(`
      INSERT INTO sg_fin_cuentas (nombre, tipo, banco, nro_cuenta, cbu, alias, moneda, saldo_inicial, cuenta_contable_id, ambito, tiene_chequera)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nombre.trim(), tipo||'cuenta_corriente', banco||null, nro_cuenta||null, cbu||null, alias||null, moneda||'ARS', parseFloat(saldo_inicial||0), cuenta_contable_id?parseInt(cuenta_contable_id):null, ambitoFinal, chq);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.put('/cuentas/:id', requireAdmin, (req, res) => {
  const { nombre, tipo, banco, nro_cuenta, cbu, alias, moneda, saldo_inicial, cuenta_contable_id, ambito, tiene_chequera } = req.body || {};
  try {
    const actual = db.prepare('SELECT * FROM sg_fin_cuentas WHERE id=?').get(req.params.id);
    if (!actual) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });
    const tipoFinal = tipo||actual.tipo;
    const ambitoFinal = (tipoFinal === 'caja' && (ambito||actual.ambito) === 'interno') ? 'interno' : 'fiscal';
    const quiereChq = (tiene_chequera === undefined) ? !!actual.tiene_chequera : !!tiene_chequera;
    const chq = (tipoFinal !== 'caja' && quiereChq) ? 1 : 0;
    // DESTILDAR "tiene chequera" con talonarios cargados dejaría los cheques
    // colgando de una cuenta que dice no tenerlos: se avisa en vez de romperlo.
    if (!chq && actual.tiene_chequera) {
      const n = db.prepare('SELECT COUNT(*) c FROM sg_fin_chequeras WHERE cuenta_id=? AND activo=1')
        .get(actual.id).c;
      if (n) {
        return res.status(400).json({ ok: false,
          error: 'Esta cuenta tiene ' + n + ' chequera(s) cargadas: no se puede marcar como sin chequera.' });
      }
    }
    // LO QUE NO VIENE EN EL PEDIDO, NO SE TOCA.
    // Antes cada campo ausente se guardaba como NULL: un PUT que sólo quería
    // marcar la chequera le borraba a la cuenta el banco, el CBU y —peor— la
    // cuenta contable, y el siguiente pago desde ella fallaba con "no tiene
    // cuenta contable asociada" sin que nadie hubiera tocado eso. Mandar el
    // campo vacío A PROPÓSITO sí lo borra: es la forma de sacarle un dato.
    const q = (v, previo) => (v === undefined ? previo : (v === '' || v === null ? null : v));
    db.prepare(`
      UPDATE sg_fin_cuentas SET nombre=?, tipo=?, banco=?, nro_cuenta=?, cbu=?, alias=?, moneda=?, saldo_inicial=?, cuenta_contable_id=?, ambito=?, tiene_chequera=? WHERE id=?
    `).run(nombre||actual.nombre, tipoFinal, q(banco, actual.banco), q(nro_cuenta, actual.nro_cuenta),
      q(cbu, actual.cbu), q(alias, actual.alias), moneda||actual.moneda,
      parseFloat(saldo_inicial??actual.saldo_inicial),
      (() => { const c = q(cuenta_contable_id, actual.cuenta_contable_id); return c ? parseInt(c) : null; })(),
      ambitoFinal, chq, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/cuentas/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('UPDATE sg_fin_cuentas SET activo=0 WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── QUIÉNES TOCAN ESTA CAJA ─────────────────────────────────────────────
// Sin nadie asignado la abren todos: agregar esta lista no le saca el acceso a
// nadie de un día para el otro. Apenas se asigna a alguien, la caja pasa a ser
// de esa gente.
router.get('/cuentas/:id/usuarios', (req, res) => {
  try {
    const asignados = db.prepare(`SELECT cu.usuario_id, u.nombre, u.email, u.rol
      FROM sg_fin_cuenta_usuarios cu JOIN usuarios u ON u.id = cu.usuario_id
      WHERE cu.cuenta_id = ? ORDER BY u.nombre`).all(req.params.id);
    const todos = db.prepare(`SELECT id, nombre, email, rol FROM usuarios
      WHERE COALESCE(activo,1)=1 ORDER BY nombre`).all();
    res.json({ ok: true, data: { asignados, todos } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.put('/cuentas/:id/usuarios', requireAdmin, (req, res) => {
  try {
    const ids = (Array.isArray(req.body && req.body.usuarios) ? req.body.usuarios : [])
      .map(Number).filter(Boolean);
    const c = db.prepare('SELECT id FROM sg_fin_cuentas WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada' });
    db.transaction(() => {
      db.prepare('DELETE FROM sg_fin_cuenta_usuarios WHERE cuenta_id=?').run(c.id);
      const ins = db.prepare('INSERT OR IGNORE INTO sg_fin_cuenta_usuarios (cuenta_id, usuario_id) VALUES (?,?)');
      for (const u of ids) ins.run(c.id, u);
    })();
    res.json({ ok: true, data: { cuenta_id: Number(c.id), usuarios: ids.length } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// SI ESTA PERSONA PUEDE MOVER ESTA CUENTA.
//
// UNA SOLA REGLA, en toda la aplicación: si la cuenta tiene gente asignada, la
// tocan SOLO ellos; si no tiene a nadie, la toca cualquiera que tenga permiso
// en el módulo. Nada más.
//
// Antes acá había otra regla —"sin lista, sólo admin"— y no era lo que se pidió.
// Se pidió "la caja XXX la tocan nada más que YYY y ZZZ": eso es una
// RESTRICCIÓN sobre cuentas con dueño, no un candado sobre las que no lo tienen.
// Con la regla vieja, el de cuentas a pagar no podía pagar desde el banco de la
// empresa —que no es de nadie en particular— y todo volvía a depender de un
// admin, que es justo lo que había que sacar del medio.
//
// El nivel del módulo sigue decidiendo aparte: sin "operar" en el módulo, ni
// llega hasta acá (exigirNivel corta antes, en index.js).
export function puedeMoverCuenta(u, cuentaId) {
  if (!u) return false;
  if (u.rol === 'admin') return true;
  const n = db.prepare('SELECT COUNT(*) c FROM sg_fin_cuenta_usuarios WHERE cuenta_id=?').get(cuentaId).c;
  if (!n) return true;              // sin dueño: la usa cualquiera con permiso
  return !!db.prepare('SELECT 1 FROM sg_fin_cuenta_usuarios WHERE cuenta_id=? AND usuario_id=?')
    .get(cuentaId, u.id);
}

// Admin, o asignado a ESA cuenta. Lee la cuenta del cuerpo o de la fila que se
// está por tocar, según el verbo.
function requireCuenta(leerId) {
  return (req, res, next) => {
    const u = getUser(req);
    if (!u) return res.status(403).json({ ok: false, error: 'solo admin' });
    const cuentaId = leerId(req);
    if (!cuentaId) return res.status(400).json({ ok: false, error: 'Falta la cuenta' });
    if (!puedeMoverCuenta(u, cuentaId)) {
      return res.status(403).json({ ok: false,
        error: 'Esta cuenta tiene usuarios asignados y no estás entre ellos.' });
    }
    req._user = u;
    next();
  };
}

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

router.post('/chequeras', requireAdmin, (req, res) => {
  const { cuenta_id, nro_chequera, desde, hasta } = req.body || {};
  if (!cuenta_id || !desde || !hasta) return res.status(400).json({ ok: false, error: 'cuenta_id, desde y hasta son requeridos' });
  try {
    const c = db.prepare('SELECT * FROM sg_fin_cuentas WHERE id=? AND activo=1').get(parseInt(cuenta_id));
    if (!c) return res.status(400).json({ ok: false, error: 'La cuenta no existe' });
    // La chequera es de la CUENTA, no del cheque: hay cuentas corrientes sin
    // chequera y cajas de ahorro que nunca la tienen. Se marca en la cuenta.
    if (!c.tiene_chequera) {
      return res.status(400).json({ ok: false,
        error: 'La cuenta "' + c.nombre + '" está marcada como SIN chequera. Marcale "tiene chequera" '
             + 'antes de cargarle uno.' });
    }
    const d = parseInt(desde), h = parseInt(hasta);
    if (!(d > 0) || !(h > 0) || h < d) {
      return res.status(400).json({ ok: false, error: 'El rango de la chequera está al revés o vacío' });
    }
    // DOS CHEQUERAS NO SE PUEDEN PISAR. Si se solapan, el mismo número existe
    // dos veces en la misma cuenta y el control de "número único" se vuelve
    // discutible: cuál de las dos era.
    const choca = db.prepare(`SELECT * FROM sg_fin_chequeras
      WHERE cuenta_id=? AND activo=1 AND desde <= ? AND hasta >= ?`).get(c.id, h, d);
    if (choca) {
      return res.status(400).json({ ok: false,
        error: 'Ese rango se pisa con la chequera ' + (choca.nro_chequera || '#' + choca.id)
             + ' (' + choca.desde + ' a ' + choca.hasta + ')' });
    }
    const r = db.prepare(`INSERT INTO sg_fin_chequeras (cuenta_id, nro_chequera, desde, hasta) VALUES (?,?,?,?)`)
      .run(c.id, nro_chequera||null, d, h);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/chequeras/:id', requireAdmin, (req, res) => {
  try {
    // Con cheques emitidos no se da de baja: quedarían colgados de una chequera
    // que "no existe" y el control de número único dejaría de verlos.
    const n = db.prepare('SELECT COUNT(*) c FROM sg_fin_cheques_propios WHERE chequera_id=?')
      .get(req.params.id).c;
    if (n) {
      return res.status(400).json({ ok: false,
        error: 'Esta chequera ya tiene ' + n + ' cheque(s) emitidos: no se puede dar de baja.' });
    }
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

// EL NÚMERO DE CHEQUE NO SE REPITE NUNCA.
// Dos cheques con el mismo número en la misma cuenta bancaria es la misma orden
// de pago librada dos veces, y eso no se descubre acá: se descubre en el banco,
// cuando presentan el segundo. Se controla contra TODA la cuenta —no contra la
// chequera— porque el número que ve el banco es el de la cuenta, y se cuentan
// también los anulados: un número usado queda quemado para siempre.
export function chequeUsado(db_, cuentaId, nro, exceptoId) {
  let sql = `SELECT cp.id, cp.estado, cp.beneficiario, cp.fecha_emision
    FROM sg_fin_cheques_propios cp
    JOIN sg_fin_chequeras ch ON ch.id = cp.chequera_id
    WHERE ch.cuenta_id = ? AND cp.nro_cheque = ?`;
  const p = [cuentaId, nro];
  if (exceptoId) { sql += ' AND cp.id <> ?'; p.push(exceptoId); }
  return db_.prepare(sql).get(...p) || null;
}

router.post('/cheques-propios', requireAdmin, (req, res) => {
  const { chequera_id, nro_cheque, monto, beneficiario, fecha_emision, fecha_vto, notas, pago_id } = req.body || {};
  if (!chequera_id || !nro_cheque || !monto) return res.status(400).json({ ok: false, error: 'chequera_id, nro_cheque y monto son requeridos' });
  try {
    const ch = db.prepare('SELECT * FROM sg_fin_chequeras WHERE id=? AND activo=1').get(parseInt(chequera_id));
    if (!ch) return res.status(400).json({ ok: false, error: 'La chequera no existe o está dada de baja' });
    const nro = parseInt(nro_cheque);
    if (!(nro > 0)) return res.status(400).json({ ok: false, error: 'El número de cheque no es un número' });
    if (nro < ch.desde || nro > ch.hasta) {
      return res.status(400).json({ ok: false,
        error: 'El cheque ' + nro + ' no pertenece a esta chequera: va del ' + ch.desde + ' al ' + ch.hasta });
    }
    const usado = chequeUsado(db, ch.cuenta_id, nro, null);
    if (usado) {
      return res.status(400).json({ ok: false,
        error: 'El cheque N° ' + nro + ' YA SE EMITIÓ el ' + (usado.fecha_emision || 's/f')
             + (usado.beneficiario ? ' a ' + usado.beneficiario : '') + ' (' + usado.estado + '). '
             + 'Un número de cheque no se usa dos veces.' });
    }
    const r = db.prepare(`INSERT INTO sg_fin_cheques_propios (chequera_id, nro_cheque, monto, beneficiario, fecha_emision, fecha_vto, notas, pago_id)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(ch.id, nro, parseFloat(monto), beneficiario||null,
           fecha_emision||new Date().toISOString().split('T')[0], fecha_vto||null, notas||null, pago_id?parseInt(pago_id):null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// El próximo número libre de la chequera: lo que hay que ofrecer para que nadie
// tenga que ir a mirar el talonario.
router.get('/chequeras/:id/proximo', (req, res) => {
  try {
    const ch = db.prepare('SELECT * FROM sg_fin_chequeras WHERE id=?').get(req.params.id);
    if (!ch) return res.status(404).json({ ok: false, error: 'Chequera no encontrada' });
    let n = ch.desde;
    while (n <= ch.hasta && chequeUsado(db, ch.cuenta_id, n, null)) n++;
    res.json({ ok: true, data: {
      chequera_id: ch.id, desde: ch.desde, hasta: ch.hasta,
      proximo: n <= ch.hasta ? n : null,
      agotada: n > ch.hasta,
    } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ANULAR UN CHEQUE. Va por su propia dirección —y no por /estado— porque el
// control de niveles reconoce la anulación por la URL: con /estado, alguien con
// nivel "operar" anulaba un cheque igual que si lo estuviera editando.
// El número NO se libera: un cheque roto no vuelve al talonario.
router.post('/cheques-propios/:id/anular', requireAdmin, (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM sg_fin_cheques_propios WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cheque no encontrado' });
    if (c.estado === 'anulado') return res.status(400).json({ ok: false, error: 'Ya estaba anulado' });
    if (c.estado === 'cobrado') {
      return res.status(400).json({ ok: false,
        error: 'Ese cheque ya se cobró: no se anula, se registra la contrapartida.' });
    }
    if (c.pago_id) {
      return res.status(400).json({ ok: false,
        error: 'Ese cheque salió de un pago a proveedor. Anulá el pago —así vuelve el saldo a la '
             + 'factura y se anula el asiento— y el cheque se anula con él.' });
    }
    const motivo = (req.body && req.body.motivo ? String(req.body.motivo) : '').trim();
    db.prepare(`UPDATE sg_fin_cheques_propios SET estado='anulado',
      notas = TRIM(COALESCE(notas,'') || ' [ANULADO' || ? || ']') WHERE id=?`)
      .run(motivo ? ': ' + motivo : '', c.id);
    res.json({ ok: true, data: { id: Number(c.id), nro_cheque: c.nro_cheque } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.patch('/cheques-propios/:id/estado', requireAdmin, (req, res) => {
  const { estado } = req.body || {};
  // 'anulado' NO está: si estuviera, esta dirección sería una puerta lateral para
  // anular sin pasar por el control de niveles, que mira la URL.
  const estados = ['emitido','cobrado','rechazado'];
  if (!estados.includes(estado)) {
    return res.status(400).json({ ok: false, error: estado === 'anulado'
      ? 'Para anular un cheque está el botón Anular, que pide el permiso correspondiente.'
      : 'Estado inválido' });
  }
  try {
    const c = db.prepare('SELECT estado FROM sg_fin_cheques_propios WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cheque no encontrado' });
    if (c.estado === 'anulado') {
      return res.status(400).json({ ok: false, error: 'Ese cheque está anulado: no se le cambia el estado.' });
    }
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
    let sql = `SELECT ct.*, c.nombre AS cuenta_destino_nombre,
             cl.razon_social AS cliente_nombre
      FROM sg_fin_cheques_terceros ct
      LEFT JOIN sg_fin_cuentas c ON c.id = ct.cuenta_destino
      LEFT JOIN sg_clientes cl ON cl.id = ct.cliente_id
      WHERE 1 = 1`;
    const params = [];
    if (estado) { sql += ' AND ct.estado=?'; params.push(estado); }
    sql += ' ORDER BY ct.fecha_vto ASC, ct.id DESC';
    const filas = db.prepare(sql).all(...params);
    // Un cheque de tercero vale por lo que dice el papel HASTA que vence. Se
    // marca el que ya venció y sigue en cartera: es plata que había que
    // depositar y quedó en un cajón.
    const hoy = db.prepare("SELECT date('now','localtime') d").get().d;
    res.json({ ok: true, data: filas.map((x) => ({
      ...x,
      vencido: (x.estado === 'en_cartera' && x.fecha_vto && x.fecha_vto < hoy) ? 1 : 0,
    })) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Recibir un cheque de un cliente es OPERAR: lo hace quien atiende el mostrador,
// no el dueño. El nivel lo decide exigirNivel por la URL.
router.post('/cheques-terceros', requireAuth, (req, res) => {
  const { banco, nro_cheque, librador, monto, fecha_recepcion, fecha_vto, notas,
          cuenta_contable_id, cliente_id } = req.body || {};
  if (!monto) return res.status(400).json({ ok: false, error: 'Monto requerido' });
  if (!(parseFloat(monto) > 0)) return res.status(400).json({ ok: false, error: 'El importe tiene que ser mayor a cero' });
  try {
    // EL MISMO CHEQUE NO SE CARGA DOS VECES. Acá el número solo no alcanza —los
    // libradores son distintos y repiten numeración—, así que la identidad es
    // banco + número + librador, que es lo que está impreso en el papel.
    if (nro_cheque && librador) {
      const ya = db.prepare(`SELECT id, estado, monto FROM sg_fin_cheques_terceros
        WHERE COALESCE(banco,'')=COALESCE(?,'') AND nro_cheque=? AND librador=?`)
        .get(banco||null, String(nro_cheque), String(librador));
      if (ya) {
        return res.status(400).json({ ok: false,
          error: 'Ese cheque ya está cargado: N° ' + nro_cheque + ' de ' + librador
               + ' por ' + ya.monto + ' (' + ya.estado + ').' });
      }
    }
    // A quién se le cobró. Se valida que exista: un id suelto que no corresponde
    // a ningún cliente es peor que no tener el dato, porque parece que lo tenés.
    let cli = null;
    if (cliente_id) {
      cli = db.prepare('SELECT id FROM sg_clientes WHERE id=? AND activo=1').get(parseInt(cliente_id));
      if (!cli) return res.status(400).json({ ok: false, error: 'Ese cliente no existe' });
    }
    const r = db.prepare(`INSERT INTO sg_fin_cheques_terceros (banco, nro_cheque, librador, monto, fecha_recepcion, fecha_vto, notas, cuenta_contable_id, cliente_id)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(banco||null, nro_cheque||null, librador||null, parseFloat(monto),
           fecha_recepcion||new Date().toISOString().split('T')[0], fecha_vto||null, notas||null,
           cuenta_contable_id?parseInt(cuenta_contable_id):null, cli ? cli.id : null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/cheques-terceros/:id/estado', requireAuth, (req, res) => {
  const { estado } = req.body || {};
  // 'depositado' NO está: depositar mueve plata a una cuenta, y eso tiene su
  // propia dirección. Si se pudiera marcar acá, el cheque figuraría depositado
  // y el banco no se habría movido nunca.
  const estados = ['en_cartera','endosado','rechazado'];
  if (!estados.includes(estado)) {
    return res.status(400).json({ ok: false, error: estado === 'depositado'
      ? 'Para depositar un cheque está el botón Depositar, que pregunta en qué cuenta entra.'
      : (estado === 'anulado'
          ? 'Para anular un cheque está el botón Anular, que pide el permiso correspondiente.'
          : 'Estado inválido') });
  }
  try {
    const c = db.prepare('SELECT * FROM sg_fin_cheques_terceros WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cheque no encontrado' });
    if (c.estado === 'anulado') {
      return res.status(400).json({ ok: false, error: 'Ese cheque está anulado: no se le cambia el estado.' });
    }
    if (c.estado === 'depositado' && estado !== 'rechazado') {
      return res.status(400).json({ ok: false,
        error: 'Ese cheque ya se depositó. Si el banco lo devolvió, marcalo como rechazado.' });
    }
    db.transaction(() => {
      db.prepare('UPDATE sg_fin_cheques_terceros SET estado=? WHERE id=?').run(estado, c.id);
      // RECHAZADO DESPUÉS DE DEPOSITADO: el banco devolvió la plata que había
      // acreditado. Sin sacar el movimiento, el saldo de la cuenta queda
      // mintiendo con plata que nunca entró.
      if (estado === 'rechazado' && c.estado === 'depositado') {
        db.prepare("DELETE FROM sg_fin_movimientos WHERE referencia = ? AND cuenta_id = ?")
          .run('CHT-' + c.id, c.cuenta_destino);
        db.prepare('UPDATE sg_fin_cheques_terceros SET cuenta_destino=NULL WHERE id=?').run(c.id);
      }
    })();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── DEPOSITAR UN CHEQUE DE TERCEROS ─────────────────────────────────────
// Marcarlo "depositado" en una lista no hace entrar la plata a ningún lado. Se
// pregunta EN QUÉ CUENTA entra y se le carga el movimiento, que es lo que hace
// que el saldo del banco diga la verdad.
router.post('/cheques-terceros/:id/depositar', requireAuth, (req, res) => {
  try {
    const u = getUser(req);
    const c = db.prepare('SELECT * FROM sg_fin_cheques_terceros WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cheque no encontrado' });
    if (c.estado !== 'en_cartera') {
      return res.status(400).json({ ok: false,
        error: 'Ese cheque no está en cartera: está ' + c.estado + '.' });
    }
    const cuenta = db.prepare('SELECT * FROM sg_fin_cuentas WHERE id=? AND activo=1')
      .get(Number((req.body || {}).cuenta_fin_id));
    if (!cuenta) return res.status(400).json({ ok: false, error: 'Elegí en qué cuenta se deposita' });
    if (!puedeMoverCuenta(u, cuenta.id)) {
      return res.status(403).json({ ok: false,
        error: 'La cuenta "' + cuenta.nombre + '" tiene usuarios asignados y no estás entre ellos.' });
    }
    const fecha = (req.body && req.body.fecha) || db.prepare("SELECT date('now','localtime') d").get().d;
    db.transaction(() => {
      db.prepare("UPDATE sg_fin_cheques_terceros SET estado='depositado', cuenta_destino=? WHERE id=?")
        .run(cuenta.id, c.id);
      db.prepare(`INSERT INTO sg_fin_movimientos
        (cuenta_id, fecha, tipo, concepto, monto, referencia, usuario_id)
        VALUES (?,?, 'ingreso', ?,?,?,?)`).run(cuenta.id, fecha,
        'Depósito cheque de terceros' + (c.nro_cheque ? ' N° ' + c.nro_cheque : '')
          + (c.librador ? ' — ' + c.librador : ''),
        c.monto, 'CHT-' + c.id, u ? u.id : null);
    })();
    res.json({ ok: true, data: { id: Number(c.id), cuenta: cuenta.nombre } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ANULAR: se cargó mal, o nunca existió. Por su propia dirección, que es la que
// mira el control de niveles.
router.post('/cheques-terceros/:id/anular', requireAuth, (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM sg_fin_cheques_terceros WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cheque no encontrado' });
    if (c.estado === 'anulado') return res.status(400).json({ ok: false, error: 'Ya estaba anulado' });
    if (c.estado === 'depositado') {
      return res.status(400).json({ ok: false,
        error: 'Ese cheque ya se depositó y la plata entró a una cuenta. Si el banco lo devolvió, '
             + 'marcalo como rechazado: eso saca el movimiento y deja el saldo bien.' });
    }
    const motivo = (req.body && req.body.motivo ? String(req.body.motivo) : '').trim();
    db.prepare(`UPDATE sg_fin_cheques_terceros SET estado='anulado',
      notas = TRIM(COALESCE(notas,'') || ' [ANULADO' || ? || ']') WHERE id=?`)
      .run(motivo ? ': ' + motivo : '', c.id);
    res.json({ ok: true, data: { id: Number(c.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
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

router.post('/movimientos', requireCuenta((req) => Number((req.body || {}).cuenta_id)), (req, res) => {
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

const cuentaDelMovimiento = (req) => {
  const m = db.prepare('SELECT cuenta_id FROM sg_fin_movimientos WHERE id=?').get(req.params.id);
  return m ? Number(m.cuenta_id) : 0;
};

router.delete('/movimientos/:id', requireCuenta(cuentaDelMovimiento), (req, res) => {
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

// ── CONCILIAR ES OPERAR ───────────────────────────────────────────────────
// Cruzar el extracto con el libro lo hace administración todos los meses. Con
// requireAdmin, cada cierre dependía del dueño. El nivel del módulo decide, y
// además la cuenta tiene que ser suya si tiene dueño.
const cuentaDelCuerpo = (req) => Number((req.body || {}).cuenta_id);
const cuentaDeLaLinea = (req) => {
  const l = db.prepare('SELECT cuenta_id FROM sg_fin_extracto_lineas WHERE id=?')
    .get(req.params.id || (req.body || {}).extracto_id);
  return l ? Number(l.cuenta_id) : 0;
};

router.post('/conciliacion/extracto', requireCuenta(cuentaDelCuerpo), (req, res) => {
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

router.patch('/conciliacion/conciliar', requireCuenta(cuentaDeLaLinea), (req, res) => {
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

router.patch('/conciliacion/desconciliar', requireCuenta(cuentaDeLaLinea), (req, res) => {
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

router.delete('/conciliacion/extracto/:id', requireCuenta(cuentaDeLaLinea), (req, res) => {
  try {
    const linea = db.prepare('SELECT * FROM sg_fin_extracto_lineas WHERE id=?').get(req.params.id);
    if (linea?.movimiento_id) {
      db.prepare('UPDATE sg_fin_movimientos SET conciliado=0 WHERE id=?').run(linea.movimiento_id);
    }
    db.prepare('DELETE FROM sg_fin_extracto_lineas WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/conciliacion/auto-match', requireCuenta(cuentaDelCuerpo), (req, res) => {
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
