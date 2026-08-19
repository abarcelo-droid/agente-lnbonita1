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
import { consultarBcra } from '../servicios/bcra.js';
import { crearAsiento, AMBITOS, MOTIVOS } from '../servicios/asientos.js';

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
                  FROM sg_fin_movimientos WHERE cuenta_id = c.id), 0) AS saldo_actual,
        -- EL SALDO ABIERTO POR ÁMBITO. Desde que el ámbito lo lleva el MOVIMIENTO
        -- y no la caja, una misma caja puede tener los dos: el arqueo total no
        -- alcanza para saber cuánto de eso es fiscal. El saldo de apertura va
        -- entero al lado fiscal — es el punto de partida declarado.
        COALESCE(c.saldo_inicial, 0) +
        COALESCE((SELECT SUM(CASE WHEN tipo='ingreso' THEN monto ELSE -monto END)
                  FROM sg_fin_movimientos WHERE cuenta_id = c.id AND ambito='fiscal'), 0) AS saldo_fiscal,
        COALESCE((SELECT SUM(CASE WHEN tipo='ingreso' THEN monto ELSE -monto END)
                  FROM sg_fin_movimientos WHERE cuenta_id = c.id AND ambito='gestion'), 0) AS saldo_gestion
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
             cl.razon_social AS cliente_nombre,
             pr.razon_social AS endosado_a_nombre
      FROM sg_fin_cheques_terceros ct
      LEFT JOIN sg_fin_cuentas c ON c.id = ct.cuenta_destino
      LEFT JOIN sg_clientes cl ON cl.id = ct.cliente_id
      LEFT JOIN sg_proveedores pr ON pr.id = ct.endosado_a
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
          cuenta_contable_id, cliente_id, cuit_librador } = req.body || {};
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
      cli = db.prepare('SELECT id, razon_social, cuenta_contable_id FROM sg_clientes WHERE id=? AND activo=1')
        .get(parseInt(cliente_id));
      if (!cli) return res.status(400).json({ ok: false, error: 'Ese cliente no existe' });
    }

    // ── UN CHEQUE QUE ENTRA A LA CARTERA ENTRA AL LIBRO ──────────────────
    // Antes esta alta no asentaba nada: el cheque aparecía en la lista y para la
    // contabilidad no existía. Después se lo depositaba o se lo endosaba, y ESAS
    // operaciones sí descargan la cuenta de cheques en cartera — contra un saldo
    // que nunca se había cargado. La cuenta quedaba en negativo por cada cheque
    // que había entrado por acá.
    //
    // Recibir un cheque de un cliente ES una cobranza a cuenta: la cartera al
    // debe contra la cuenta corriente del cliente. Si el cheque no viene de un
    // cliente —una devolución, un cheque viejo que se está regularizando— hay
    // que decir contra qué cuenta entra. Una de las dos, pero alguna.
    const ctaCart = ctaConfig('cheques_cartera');
    if (!ctaCart) {
      return res.status(400).json({ ok: false,
        error: 'Falta decir contra qué cuenta contable van los cheques en cartera. Configurala en '
             + 'Contabilidad SG antes de cargar cheques.' });
    }
    const contra = (cli && cli.cuenta_contable_id) || (cuenta_contable_id ? parseInt(cuenta_contable_id) : null);
    if (!contra) {
      return res.status(400).json({ ok: false,
        error: cli
          ? `El cliente "${cli.razon_social}" no tiene cuenta contable asignada: no se sabe contra qué `
            + `cuenta corriente entra el cheque. Asignásela en su ficha.`
          : 'Decí de quién es el cheque —el cliente— o contra qué cuenta contable entra: sin eso no '
            + 'puede entrar al libro, y la cuenta de cartera queda cargada con algo que nunca ingresó.' });
    }
    if (!db.prepare('SELECT 1 FROM sg_cuentas WHERE id=?').get(contra)) {
      return res.status(400).json({ ok: false, error: 'Esa cuenta contable no existe en el plan de SG' });
    }

    const fRec = fecha_recepcion || new Date().toISOString().split('T')[0];
    let id = null, asientoId = null;
    db.transaction(() => {
      id = db.prepare(`INSERT INTO sg_fin_cheques_terceros (banco, nro_cheque, librador, monto, fecha_recepcion, fecha_vto, notas, cuenta_contable_id, cliente_id, cuit_librador)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(banco||null, nro_cheque||null, librador||null, parseFloat(monto),
             fRec, fecha_vto||null, notas||null, contra, cli ? cli.id : null,
             String(cuit_librador || '').replace(/[^0-9]/g, '') || null).lastInsertRowid;
      const u = getUser(req);
      asientoId = crearAsiento(db, {
        fecha: fRec, usuario_id: u ? u.id : null, ref_codigo: 'CHT-A-' + id,
        descripcion: 'Cheque de terceros N° ' + (nro_cheque || 's/n') + ' en cartera'
          + (librador ? ' — ' + librador : ''),
      }, [
        { cuenta_id: ctaCart, debe: parseFloat(monto), haber: 0, descripcion: 'Cheques en cartera' },
        { cuenta_id: contra, debe: 0, haber: parseFloat(monto),
          descripcion: cli ? cli.razon_social : 'Contrapartida del cheque' },
      ]).id;
    })();
    res.json({ ok: true, id: Number(id), asiento_id: Number(asientoId) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/cheques-terceros/:id/estado', requireAuth, (req, res) => {
  const { estado } = req.body || {};
  // NINGÚN ESTADO QUE MUEVA PLATA SE PONE ACÁ. Depositar, endosar y rechazar
  // cambian el libro y el saldo de una cuenta: cada uno tiene su dirección, que
  // pregunta lo que hace falta y arma el asiento. Marcar el estado a mano dejaba
  // el cheque diciendo "endosado" con la deuda del proveedor intacta.
  const estados = ['en_cartera'];
  if (!estados.includes(estado)) {
    const A_DONDE = {
      depositado: 'Para depositar un cheque está el botón Depositar, que pregunta en qué cuenta entra.',
      endosado: 'Para endosar un cheque está el botón Endosar, que pregunta a qué proveedor se le da y '
              + 'qué facturas cancela: si no, la deuda del proveedor no baja.',
      rechazado: 'Para marcar un cheque rechazado está el botón Rechazado, que lo saca del banco o del '
               + 'proveedor y arma el asiento.',
      anulado: 'Para anular un cheque está el botón Anular, que pide el permiso correspondiente.',
    };
    return res.status(400).json({ ok: false, error: A_DONDE[estado] || 'Estado inválido' });
  }
  try {
    const c = db.prepare('SELECT * FROM sg_fin_cheques_terceros WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cheque no encontrado' });
    // Y TAMPOCO SE VUELVE PARA ATRÁS POR ACÁ. Un cheque depositado, endosado,
    // rechazado o devuelto ya movió el libro: devolverlo a "en cartera" con un
    // PATCH deshace el estado y NO deshace el asiento ni la deuda. Cada vuelta
    // atrás tiene su camino —anular el pago, rechazar, anular la cobranza— y
    // todos hacen las dos cosas.
    if (c.estado !== 'en_cartera') {
      const COMO = {
        depositado: 'Ya se depositó y la plata entró a una cuenta. Si el banco lo devolvió, marcalo como rechazado.',
        endosado: 'Ya se endosó y canceló facturas de un proveedor. Para deshacerlo, anulá esa orden de pago: '
                + 'ahí el cheque vuelve solo a la cartera.',
        rechazado: 'Ya rebotó. Lo que sigue es devolvérselo al cliente.',
        devuelto: 'Ya se le devolvió al cliente.',
        anulado: 'Ese cheque está anulado: no se le cambia el estado.',
      };
      return res.status(400).json({ ok: false,
        error: COMO[c.estado] || 'Ese cheque ya no está en cartera.' });
    }
    db.prepare('UPDATE sg_fin_cheques_terceros SET estado=? WHERE id=?').run(estado, c.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── LAS CUENTAS QUE EL CIRCUITO DEL CHEQUE NECESITA ──────────────────────
// Las dos se parametrizan en Contabilidad SG. Ninguna se adivina: si falta, se
// dice cuál falta y no se hace nada, porque un asiento contra una cuenta
// inventada es peor que no tener el asiento.
function ctaConfig(clave) {
  const r = db.prepare('SELECT cuenta_id FROM sg_config_impositiva WHERE clave=?').get(clave);
  return (r && r.cuenta_id) || null;
}

// De qué cuenta contable es "Proveedores": la MISMA que usa el asiento modelo de
// las facturas de compra. Es la regla que ya sigue el circuito de pagos
// (cuentaProveedoresDeModelo, en rutas/sg.js) — parametrizarla aparte serían dos
// lugares para decir lo mismo, y el día que no coincidan el mayor no cierra.
function ctaProveedoresDeModelo() {
  try {
    const cfg = db.prepare(
      "SELECT valor FROM sg_config WHERE clave='asiento_modelo_factura_mercaderia'").get();
    const id = cfg && cfg.valor ? Number(cfg.valor) : null;
    if (!id) return null;
    const l = db.prepare(`SELECT cuenta_id FROM sg_asientos_modelo_lineas
      WHERE modelo_id=? AND tipo_linea='proveedores' AND cuenta_id IS NOT NULL
      ORDER BY orden, id LIMIT 1`).get(id);
    return l ? l.cuenta_id : null;
  } catch (_) { return null; }
}

// ── EL BANCO LO RECHAZÓ (O EL PROVEEDOR NOS LO DEVOLVIÓ) ─────────────────
// Un cheque que rebota no es "cambiarle el estado". Hay que sacarlo de donde
// esté —del banco donde se depositó, o del proveedor al que se lo endosamos— y
// eso son dos asientos distintos:
//
//   · depositado → Cheques rechazados al DEBE contra el BANCO al haber. Y un
//     movimiento de egreso, porque el banco acreditó y después debitó: el
//     extracto muestra las dos cosas y el nuestro tiene que mostrarlas también.
//     (Borrar el ingreso original haría desaparecer un movimiento que existió.)
//
//   · endosado → Cheques rechazados al DEBE contra PROVEEDORES al haber: el
//     proveedor nos devolvió el papel, así que volvemos a deberle. Y las
//     facturas que ese cheque había cancelado vuelven a estar pendientes.
//
// En los dos casos el cheque queda en "rechazados", que es una etapa: todavía no
// es deuda del cliente. Eso pasa cuando se le devuelve.
router.post('/cheques-terceros/:id/rechazar', requireAuth, (req, res) => {
  try {
    const u = getUser(req);
    const motivo = String((req.body || {}).motivo || '').trim();
    if (!motivo) return res.status(400).json({ ok: false, error: 'Escribí por qué rebotó: queda registrado' });
    const c = db.prepare('SELECT * FROM sg_fin_cheques_terceros WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cheque no encontrado' });
    if (c.estado === 'rechazado') return res.status(400).json({ ok: false, error: 'Ese cheque ya está rechazado' });
    if (!['depositado', 'endosado'].includes(c.estado)) {
      return res.status(400).json({ ok: false,
        error: 'Un cheque sólo puede rebotar donde se presentó. Éste está ' + c.estado
             + ': si nunca se depositó ni se endosó, lo que corresponde es anularlo.' });
    }
    const ctaRech = ctaConfig('cheques_rechazados');
    if (!ctaRech) {
      return res.status(400).json({ ok: false,
        error: 'Falta decir contra qué cuenta contable van los cheques rechazados. Configurala en '
             + 'Contabilidad SG.' });
    }
    const fecha = (req.body && req.body.fecha) || db.prepare("SELECT date('now','localtime') d").get().d;

    let contra = null, contraNombre = '', deDonde = '';
    if (c.estado === 'depositado') {
      const cta = db.prepare('SELECT * FROM sg_fin_cuentas WHERE id=?').get(c.cuenta_destino);
      if (!cta) return res.status(400).json({ ok: false, error: 'No se sabe en qué cuenta se había depositado' });
      if (!puedeMoverCuenta(u, cta.id)) {
        return res.status(403).json({ ok: false,
          error: 'La cuenta "' + cta.nombre + '" tiene usuarios asignados y no estás entre ellos.' });
      }
      if (!cta.cuenta_contable_id) {
        return res.status(400).json({ ok: false,
          error: 'La cuenta "' + cta.nombre + '" no tiene cuenta contable asociada: el rechazo no puede '
               + 'entrar al libro.' });
      }
      contra = cta.cuenta_contable_id; contraNombre = cta.nombre; deDonde = 'banco';
    } else {
      contra = ctaProveedoresDeModelo();
      if (!contra) {
        return res.status(400).json({ ok: false,
          error: 'El asiento modelo de las facturas no tiene línea de Proveedores: sin esa cuenta no se '
               + 'sabe a quién volvemos a deberle.' });
      }
      const pr = c.endosado_a
        ? db.prepare('SELECT razon_social FROM sg_proveedores WHERE id=?').get(c.endosado_a) : null;
      contraNombre = (pr && pr.razon_social) || 'Proveedores'; deDonde = 'proveedor';
    }

    let asientoId = null;
    const vuelven = [];
    db.transaction(() => {
      asientoId = crearAsiento(db, {
        fecha, usuario_id: u ? u.id : null, ref_codigo: 'CHT-R-' + c.id,
        descripcion: 'Cheque N° ' + c.nro_cheque + ' RECHAZADO' + (c.librador ? ' — ' + c.librador : '')
          + ' — ' + motivo,
      }, [
        { cuenta_id: ctaRech, debe: c.monto, haber: 0, descripcion: 'Cheque rechazado N° ' + c.nro_cheque },
        { cuenta_id: contra, debe: 0, haber: c.monto, descripcion: contraNombre },
      ]).id;

      if (deDonde === 'banco') {
        db.prepare(`INSERT INTO sg_fin_movimientos
          (cuenta_id, fecha, tipo, concepto, monto, referencia, usuario_id)
          VALUES (?,?, 'egreso', ?,?,?,?)`).run(c.cuenta_destino, fecha,
          'Cheque rechazado N° ' + c.nro_cheque + (c.librador ? ' — ' + c.librador : ''),
          c.monto, 'CHT-R-' + c.id, u ? u.id : null);
      } else {
        // LA DEUDA CON EL PROVEEDOR VUELVE. Las facturas que ese cheque había
        // cancelado quedan otra vez pendientes: se descuenta de la ÚLTIMA
        // imputación hacia atrás, hasta cubrir el importe del cheque.
        let falta = Math.round(c.monto * 100) / 100;
        const imps = db.prepare(`SELECT * FROM sg_pagos_compras WHERE pago_id=? ORDER BY id DESC`)
          .all(c.pago_id || -1);
        for (const im of imps) {
          if (falta <= 0.001) break;
          const saca = Math.round(Math.min(im.monto, falta) * 100) / 100;
          if (saca >= im.monto - 0.001) db.prepare('DELETE FROM sg_pagos_compras WHERE id=?').run(im.id);
          else db.prepare('UPDATE sg_pagos_compras SET monto=ROUND(monto-?,2) WHERE id=?').run(saca, im.id);
          db.prepare(`UPDATE sg_facturas_compra
            SET saldo_pagado = MAX(0, ROUND(COALESCE(saldo_pagado,0) - ?, 2)),
                modificado_en=datetime('now','localtime') WHERE id=?`).run(saca, im.compra_id);
          const f = db.prepare('SELECT numero FROM sg_facturas_compra WHERE id=?').get(im.compra_id);
          vuelven.push({ factura: f ? f.numero : im.compra_id, monto: saca });
          falta = Math.round((falta - saca) * 100) / 100;
        }
      }

      db.prepare(`UPDATE sg_fin_cheques_terceros SET estado='rechazado', rechazado_en=?, rechazado_por=?,
        rechazado_motivo=?, rechazado_de=? WHERE id=?`)
        .run(fecha, u ? u.id : null, motivo, deDonde, c.id);
    })();
    res.json({ ok: true, data: { id: Number(c.id), asiento_id: Number(asientoId),
      de: deDonde, vuelven } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── Y SE LO DEVOLVEMOS AL CLIENTE ────────────────────────────────────────
// El papel vuelve a manos del que nos lo dio, y con él vuelve la deuda: lo que
// esa cobranza había cancelado queda otra vez pendiente.
//
// El asiento del cobro original NO se anula: el cobro pasó de verdad. Se
// contra-asienta —Cliente al DEBE contra Cheques rechazados al haber— y los dos
// asientos se cancelan entre sí, que es lo que muestra la historia completa.
router.post('/cheques-terceros/:id/devolver', requireAuth, (req, res) => {
  try {
    const u = getUser(req);
    const c = db.prepare('SELECT * FROM sg_fin_cheques_terceros WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cheque no encontrado' });
    if (c.estado !== 'rechazado') {
      return res.status(400).json({ ok: false,
        error: 'Sólo se le devuelve al cliente un cheque rechazado. Éste está ' + c.estado + '.' });
    }
    const ctaRech = ctaConfig('cheques_rechazados');
    if (!ctaRech) {
      return res.status(400).json({ ok: false,
        error: 'Falta la cuenta contable de cheques rechazados. Configurala en Contabilidad SG.' });
    }
    const cli = c.cliente_id
      ? db.prepare('SELECT id, razon_social, cuenta_contable_id FROM sg_clientes WHERE id=?').get(c.cliente_id)
      : null;
    if (!cli) {
      return res.status(400).json({ ok: false,
        error: 'Este cheque no tiene cliente: no vino de una cobranza, así que no hay a quién devolvérselo '
             + 'en la cuenta corriente. Anulalo.' });
    }
    if (!cli.cuenta_contable_id) {
      return res.status(400).json({ ok: false,
        error: 'El cliente "' + cli.razon_social + '" no tiene cuenta contable asignada: no se sabe contra '
             + 'qué cuenta corriente vuelve la deuda.' });
    }
    const fecha = (req.body && req.body.fecha) || db.prepare("SELECT date('now','localtime') d").get().d;
    const cob = db.prepare('SELECT * FROM sg_ven_cobranzas WHERE cheque_terceros_id=? AND anulada=0').get(c.id);

    let asientoId = null;
    const vuelven = [];
    db.transaction(() => {
      asientoId = crearAsiento(db, {
        fecha, usuario_id: u ? u.id : null, ref_codigo: 'CHT-D-' + c.id,
        descripcion: 'Cheque N° ' + c.nro_cheque + ' devuelto a ' + cli.razon_social + ' — vuelve la deuda',
      }, [
        { cuenta_id: cli.cuenta_contable_id, debe: c.monto, haber: 0, descripcion: cli.razon_social },
        { cuenta_id: ctaRech, debe: 0, haber: c.monto, descripcion: 'Cheque rechazado N° ' + c.nro_cheque },
      ]).id;

      // LA COBRANZA DEJA DE CONTAR. Se marca anulada —que es lo que mira la
      // cuenta corriente para no sumarla— pero su asiento queda VIVO: ese cobro
      // existió y lo que lo revierte es el asiento de arriba. Los comprobantes
      // que había cancelado vuelven a estar pendientes.
      if (cob) {
        db.prepare(`UPDATE sg_ven_cobranzas SET anulada=1, anulada_en=datetime('now','localtime'),
          anulada_por=?, anulada_motivo=? WHERE id=?`)
          .run(u ? u.id : null, 'Cheque N° ' + c.nro_cheque + ' rechazado y devuelto al cliente', cob.id);
        for (const d of db.prepare('SELECT * FROM sg_ven_cobranza_docs WHERE cobranza_id=?').all(cob.id)) {
          const tabla = d.tipo === 'liquidacion' ? 'sg_ven_liquidaciones' : 'sg_ven_facturas';
          const r = db.prepare(`UPDATE ${tabla} SET estado='pendiente' WHERE id=? AND estado='cobrada'`)
            .run(d.doc_id);
          if (r.changes) {
            const doc = db.prepare(`SELECT numero FROM ${tabla} WHERE id=?`).get(d.doc_id);
            vuelven.push({ doc: doc ? doc.numero : d.doc_id, monto: d.monto });
          }
        }
      }
      db.prepare(`UPDATE sg_fin_cheques_terceros SET estado='devuelto', devuelto_en=?, devuelto_por=?
        WHERE id=?`).run(fecha, u ? u.id : null, c.id);
    })();
    res.json({ ok: true, data: { id: Number(c.id), asiento_id: Number(asientoId), vuelven } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
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
    // ── EL DEPÓSITO DESCARGA LA CARTERA ─────────────────────────────────
    // El cheque entró al libro cuando se cobró, contra la cuenta de "cheques en
    // cartera". Depositarlo es sacarlo de ahí y meterlo en el banco: si el
    // depósito no asentara, esa cuenta se llenaría de cheques que ya se
    // cobraron y nunca bajaría.
    //
    // Sólo asienta si el cheque tiene con qué: los que se cargaron a mano en la
    // cartera, sin pasar por una cobranza, nunca entraron al libro — para esos
    // el depósito es sólo el movimiento, como era antes.
    const ctaCartera = (db.prepare("SELECT cuenta_id FROM sg_config_impositiva WHERE clave='cheques_cartera'")
      .get() || {}).cuenta_id || null;
    const vinoDeCobranza = !!db.prepare(
      'SELECT 1 FROM sg_ven_cobranzas WHERE cheque_terceros_id=? AND anulada=0').get(c.id);
    if (vinoDeCobranza && (!ctaCartera || !cuenta.cuenta_contable_id)) {
      // Este cheque SÍ está en el libro, cargado en la cuenta de cartera. Si el
      // depósito no puede asentar, esa cuenta queda con un cheque que ya se
      // cobró y no baja nunca. Antes de dejar un agujero así, se frena y se dice
      // qué falta configurar.
      return res.status(400).json({ ok: false, error: !ctaCartera
        ? 'Falta la cuenta contable de "cheques en cartera". Configurala antes de depositar.'
        : `La cuenta "${cuenta.nombre}" no tiene cuenta contable asociada: el depósito no puede `
          + `entrar al libro. Asignásela en Caja y Bancos.` });
    }
    const asienta = !!(ctaCartera && cuenta.cuenta_contable_id && vinoDeCobranza);
    let asientoId = null;
    db.transaction(() => {
      db.prepare("UPDATE sg_fin_cheques_terceros SET estado='depositado', cuenta_destino=? WHERE id=?")
        .run(cuenta.id, c.id);
      db.prepare(`INSERT INTO sg_fin_movimientos
        (cuenta_id, fecha, tipo, concepto, monto, referencia, usuario_id)
        VALUES (?,?, 'ingreso', ?,?,?,?)`).run(cuenta.id, fecha,
        'Depósito cheque de terceros' + (c.nro_cheque ? ' N° ' + c.nro_cheque : '')
          + (c.librador ? ' — ' + c.librador : ''),
        c.monto, 'CHT-' + c.id, u ? u.id : null);
      if (asienta) {
        asientoId = crearAsiento(db, {
          fecha, usuario_id: u ? u.id : null, ref_codigo: 'CHT-' + c.id,
          descripcion: 'Depósito cheque N° ' + c.nro_cheque + (c.librador ? ' de ' + c.librador : ''),
        }, [
          { cuenta_id: cuenta.cuenta_contable_id, debe: c.monto, haber: 0, descripcion: cuenta.nombre },
          { cuenta_id: ctaCartera, debe: 0, haber: c.monto, descripcion: 'Cheques en cartera' },
        ]).id;
      }
    })();
    res.json({ ok: true, data: { id: Number(c.id), cuenta: cuenta.nombre,
      asiento_id: asientoId ? Number(asientoId) : null } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ANULAR: se cargó mal, o nunca existió. Por su propia dirección, que es la que
// mira el control de niveles.
router.post('/cheques-terceros/:id/anular', requireAuth, (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM sg_fin_cheques_terceros WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cheque no encontrado' });
    if (c.estado === 'anulado') return res.status(400).json({ ok: false, error: 'Ya estaba anulado' });
    // ANULAR ES DECIR QUE NUNCA EXISTIÓ, y eso sólo vale mientras el cheque no
    // hizo nada. Uno depositado, endosado o rechazado ya movió plata y deuda:
    // anularlo dejaría el asiento del depósito o el pago al proveedor en pie,
    // apoyados en un cheque que el sistema dice que no existe.
    const NO_SE_ANULA = {
      depositado: 'Ese cheque ya se depositó y la plata entró a una cuenta. Si el banco lo devolvió, '
                + 'marcalo como rechazado: eso la saca y deja el saldo bien.',
      endosado: 'Ese cheque ya se endosó y canceló facturas de un proveedor. Para deshacerlo, anulá esa '
              + 'orden de pago: ahí el cheque vuelve solo a la cartera.',
      rechazado: 'Ese cheque ya rebotó y su rechazo está asentado. Lo que sigue es devolvérselo al cliente.',
      devuelto: 'Ese cheque ya se le devolvió al cliente.',
    };
    if (NO_SE_ANULA[c.estado]) return res.status(400).json({ ok: false, error: NO_SE_ANULA[c.estado] });
    const motivo = (req.body && req.body.motivo ? String(req.body.motivo) : '').trim();
    db.transaction(() => {
      db.prepare(`UPDATE sg_fin_cheques_terceros SET estado='anulado',
        notas = TRIM(COALESCE(notas,'') || ' [ANULADO' || ? || ']') WHERE id=?`)
        .run(motivo ? ': ' + motivo : '', c.id);
      // El asiento del alta se anula: si el cheque no existió, la cuenta de
      // cartera no puede quedar cargada con él. (El de una COBRANZA no se toca
      // acá — ése lo maneja anular la cobranza, que además devuelve el saldo a
      // los comprobantes.)
      db.prepare(`UPDATE sg_asientos SET anulado=1, anulado_en=datetime('now','localtime'),
        descripcion = descripcion || ' — ANULADO' || ?
        WHERE ref_codigo=? AND COALESCE(anulado,0)=0`)
        .run(motivo ? ': ' + motivo : '', 'CHT-A-' + c.id);
    })();
    res.json({ ok: true, data: { id: Number(c.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── ¿EL QUE FIRMA ESTE CHEQUE ES BUENO? ──────────────────────────────────
// La Central de Deudores del BCRA es pública y contesta dos cosas por CUIT: en
// qué situación está en el sistema financiero (1 normal … 6 irrecuperable) y qué
// cheques suyos rebotaron y siguen impagos. Es exactamente lo que uno querría
// saber ANTES de aceptar el papel.
//
// Es sólo lectura y no toca nada nuestro, así que va con requireAuth y sin más
// ceremonia. Y NUNCA bloquea: si el BCRA no contesta —se cae seguido— la
// respuesta lo dice y el cheque se carga igual.
router.get('/bcra/:cuit', requireAuth, async (req, res) => {
  try {
    const r = await consultarBcra(req.params.cuit, { forzar: req.query.forzar === '1' });
    res.json(r.ok ? { ok: true, data: r } : { ok: false, error: r.error });
  } catch (e) {
    res.json({ ok: false, error: 'No se pudo consultar el BCRA: ' + e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// MOVIMIENTOS
// ────────────────────────────────────────────────────────────────────────────

router.get('/movimientos', (req, res) => {
  try {
    const { cuentaId, desde, hasta, solo_caja, ambito } = req.query;
    let sql = `SELECT m.*, c.nombre as cuenta_nombre, c.ambito as cuenta_ambito, c.tipo as cuenta_tipo FROM sg_fin_movimientos m JOIN sg_fin_cuentas c ON c.id=m.cuenta_id WHERE 1 = 1`;
    const params = [];
    if (cuentaId)  { sql += ' AND m.cuenta_id=?'; params.push(parseInt(cuentaId)); }
    // El ámbito del MOVIMIENTO, no el de la caja: la caja sólo propone.
    if (AMBITOS.includes(String(ambito || ''))) { sql += ' AND m.ambito=?'; params.push(ambito); }
    if (solo_caja === '1') { sql += " AND c.tipo='caja'"; }
    if (desde)     { sql += ' AND m.fecha>=?'; params.push(desde); }
    if (hasta)     { sql += ' AND m.fecha<=?'; params.push(hasta); }
    sql += ' ORDER BY m.fecha DESC, m.id DESC';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/movimientos', requireCuenta((req) => Number((req.body || {}).cuenta_id)), (req, res) => {
  const u = getUser(req);
  const { cuenta_id, fecha, tipo, concepto, monto, referencia, pago_id, ambito, motivo } = req.body || {};
  if (!cuenta_id || !tipo || !concepto || !monto) return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  try {
    // ── DE QUÉ ÁMBITO ES ESTE MOVIMIENTO ────────────────────────────────
    // Lo decide quien lo carga. Si no dice nada se toma el de la caja, que es
    // apenas lo habitual de esa caja y no una regla: una misma caja puede tener
    // los dos. Y uno de gestión sin motivo no entra, igual que en el libro.
    const cta = db.prepare('SELECT ambito FROM sg_fin_cuentas WHERE id=?').get(parseInt(cuenta_id));
    let amb = String(ambito || '').trim();
    if (!AMBITOS.includes(amb)) {
      amb = (cta && cta.ambito === 'interno') ? 'gestion' : 'fiscal';
    }
    let mot = null;
    if (amb === 'gestion') {
      mot = String(motivo || '').trim();
      if (!MOTIVOS[mot]) {
        return res.status(400).json({ ok: false,
          error: 'Un movimiento de gestión tiene que decir por qué. Elegí el motivo: '
               + Object.values(MOTIVOS).map((m) => m.label).join(', ') + '.' });
      }
    }
    const r = db.prepare(`INSERT INTO sg_fin_movimientos (cuenta_id, fecha, tipo, concepto, monto, referencia, pago_id, usuario_id, ambito, motivo)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(parseInt(cuenta_id), fecha||new Date().toISOString().split('T')[0], tipo, concepto.trim(),
           parseFloat(monto), referencia||null, pago_id?parseInt(pago_id):null, u?u.id:null, amb, mot);
    res.json({ ok: true, id: r.lastInsertRowid, ambito: amb });
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
