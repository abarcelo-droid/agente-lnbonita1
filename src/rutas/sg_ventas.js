// src/rutas/sg_ventas.js
// ── MÓDULO VENTAS SG — copia de rutas/ventas.js repuntada a tablas sg_ven_* ───
// Copia física del Ventas de PC para que SG diverja. Clientes, liquidaciones de
// producto, facturas, cobranzas y cuenta corriente, sobre sg_ven_*. Los asientos
// automáticos van a sg_asientos (libros de SG) y la config fiscal a
// sg_config_impositiva. SIN dimensión sociedad_id (tablas SG-only).
// Montado en /api/sg/ventas. NO toca ninguna tabla ven_*/pa_*.

import express from 'express';
import db from '../servicios/db_sg_finanzas.js';

const router = express.Router();

function validarCuit(cuit) {
  if (!cuit) return { valido: true };
  const limpio = String(cuit).replace(/[-\s]/g, '');
  if (!/^\d{11}$/.test(limpio)) return { valido: false, msg: 'CUIT debe tener 11 dígitos' };
  const mult = [5,4,3,2,7,6,5,4,3,2];
  const suma = mult.reduce((s, m, i) => s + parseInt(limpio[i]) * m, 0);
  const resto = suma % 11;
  const dv = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
  if (dv !== parseInt(limpio[10])) return { valido: false, msg: 'Dígito verificador incorrecto' };
  return { valido: true, cuit_formateado: `${limpio.substring(0,2)}-${limpio.substring(2,10)}-${limpio[10]}` };
}

function getUser(req) {
  try { return req.cookies?.lnb_user ? JSON.parse(req.cookies.lnb_user) : null; }
  catch(e) { return null; }
}

function requireAuth(req, res, next) {
  const u = getUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'no autenticado' });
  req._user = u;
  next();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PADRÓN DE CLIENTES — opera sobre sg_clientes (#401 Camino A; sg_ven_clientes DEPRECADA)
// ═══════════════════════════════════════════════════════════════════════════════

// Mapea la condición de IVA del front a la categoria_fiscal de sg_clientes (respeta el CHECK).
// Valor no reconocido → null (la columna es nullable, no viola el CHECK).
function condIvaToCatFiscal(v) {
  const m = {
    responsable_inscripto: 'resp_inscripto', resp_inscripto: 'resp_inscripto',
    monotributo: 'monotributista', monotributista: 'monotributista',
    exento: 'exento',
    consumidor_final: 'no_inscripto', no_inscripto: 'no_inscripto',
  };
  return m[String(v || '').trim().toLowerCase()] || null;
}

router.get('/clientes', (req, res) => {
  try {
    const { q, incluir_inactivos } = req.query;
    let sql = `SELECT c.*, pc.nombre as cuenta_nombre
               FROM sg_clientes c
               LEFT JOIN sg_cuentas pc ON pc.id = c.cuenta_contable_id
               WHERE 1 = 1`;
    const params = [];
    if (!incluir_inactivos) { sql += ' AND c.activo=1'; }
    if (q) { sql += ' AND (c.razon_social LIKE ? OR c.cuit LIKE ? OR c.nombre_comercial LIKE ?)';
      const like = '%'+q+'%'; params.push(like, like, like); }
    sql += ' ORDER BY c.razon_social';
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/clientes/:id', (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM sg_clientes WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });
    res.json({ ok: true, data: c });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/clientes', requireAuth, (req, res) => {
  // contacto/rubro se descartan (no van a sg_clientes, decisión #401). direccion→direccion_entrega,
  // notas→observaciones, condicion_iva→categoria_fiscal.
  const { razon_social, nombre_comercial, cuit, condicion_iva, direccion,
          telefono, email, notas, cuenta_contable_id } = req.body || {};
  if (!razon_social?.trim()) return res.status(400).json({ ok: false, error: 'Razón social requerida' });
  if (cuit) {
    const cv = validarCuit(cuit);
    if (!cv.valido) return res.status(400).json({ ok: false, error: 'CUIT inválido: ' + cv.msg });
  }
  try {
    const r = db.prepare(`INSERT INTO sg_clientes
      (razon_social, nombre_comercial, cuit, categoria_fiscal, direccion_entrega, telefono, email, observaciones, cuenta_contable_id)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(razon_social.trim(), nombre_comercial||null, cuit||null,
           condIvaToCatFiscal(condicion_iva), direccion||null, telefono||null,
           email||null, notas||null,
           cuenta_contable_id ? parseInt(cuenta_contable_id) : null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.put('/clientes/:id', requireAuth, (req, res) => {
  const { razon_social, nombre_comercial, cuit, condicion_iva, direccion,
          telefono, email, notas, cuenta_contable_id } = req.body || {};
  try {
    const actual = db.prepare('SELECT * FROM sg_clientes WHERE id=?').get(req.params.id);
    if (!actual) return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });
    db.prepare(`UPDATE sg_clientes SET razon_social=?, nombre_comercial=?, cuit=?, categoria_fiscal=?,
      direccion_entrega=?, telefono=?, email=?, observaciones=?, cuenta_contable_id=? WHERE id=?`)
      .run(razon_social||actual.razon_social, nombre_comercial||null, cuit||null,
           condicion_iva ? condIvaToCatFiscal(condicion_iva) : actual.categoria_fiscal,
           direccion||null, telefono||null, email||null, notas||null,
           cuenta_contable_id ? parseInt(cuenta_contable_id) : null, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/clientes/:id', requireAuth, (req, res) => {
  try {
    db.prepare('UPDATE sg_clientes SET activo=0 WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIQUIDACIONES DE PRODUCTO
// ═══════════════════════════════════════════════════════════════════════════════

function generarNumLiq() {
  const año = new Date().getFullYear();
  const ult = db.prepare("SELECT numero FROM sg_ven_liquidaciones WHERE numero LIKE ? ORDER BY id DESC LIMIT 1")
    .get(`LIQ-${año}-%`);
  let n = 1;
  if (ult) { const p = ult.numero.split('-'); n = parseInt(p[p.length-1]) + 1; }
  return `LIQ-${año}-${String(n).padStart(4,'0')}`;
}

router.get('/liquidaciones', (req, res) => {
  try {
    const { clienteId, estado } = req.query;
    let sql = `SELECT l.*, c.razon_social as cliente_nombre
               FROM sg_ven_liquidaciones l
               JOIN sg_clientes c ON c.id = l.cliente_id
               WHERE 1 = 1`;
    const params = [];
    if (clienteId) { sql += ' AND l.cliente_id=?'; params.push(parseInt(clienteId)); }
    if (estado)    { sql += ' AND l.estado=?'; params.push(estado); }
    sql += ' ORDER BY l.fecha DESC, l.id DESC';
    const liq = db.prepare(sql).all(...params);
    for (const l of liq) {
      l.items = db.prepare('SELECT * FROM sg_ven_liquidacion_items WHERE liquidacion_id=? ORDER BY id').all(l.id);
    }
    res.json({ ok: true, data: liq });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/liquidaciones/:id', (req, res) => {
  try {
    const l = db.prepare(`SELECT l.*, c.razon_social as cliente_nombre, c.cuit as cliente_cuit
      FROM sg_ven_liquidaciones l JOIN sg_clientes c ON c.id=l.cliente_id WHERE l.id=?`).get(req.params.id);
    if (!l) return res.status(404).json({ ok: false, error: 'Liquidación no encontrada' });
    l.items = db.prepare('SELECT * FROM sg_ven_liquidacion_items WHERE liquidacion_id=? ORDER BY id').all(l.id);
    res.json({ ok: true, data: l });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/liquidaciones', requireAuth, (req, res) => {
  const u = req._user;
  const { fecha, cliente_id, nro_remito, observaciones, items,
          desc_comision, desc_flete, desc_carga_descarga, desc_otros,
          ret_iva, ret_ganancias, ret_iibb, ret_otras, nro_liquidacion } = req.body || {};

  if (!cliente_id) return res.status(400).json({ ok: false, error: 'cliente_id requerido' });
  if (!items?.length) return res.status(400).json({ ok: false, error: 'Ingresá al menos un ítem' });

  if (nro_liquidacion?.trim()) {
    const existe = db.prepare('SELECT id FROM sg_ven_liquidaciones WHERE numero=? AND cliente_id=?')
      .get(nro_liquidacion.trim(), parseInt(cliente_id));
    if (existe) return res.status(400).json({ ok: false, error: `Ya existe la liquidación ${nro_liquidacion} para este cliente` });
  }

  try {
    const tx = db.transaction(() => {
      const numero = nro_liquidacion?.trim() || generarNumLiq();
      const fechaLiq = fecha || new Date().toISOString().split('T')[0];

      const precio_bruto = items.reduce((s, it) => s + (parseFloat(it.subtotal)||0), 0);
      const descuentos = (parseFloat(desc_comision)||0) + (parseFloat(desc_flete)||0)
        + (parseFloat(desc_carga_descarga)||0) + (parseFloat(desc_otros)||0);
      const retenciones = (parseFloat(ret_iva)||0) + (parseFloat(ret_ganancias)||0)
        + (parseFloat(ret_iibb)||0) + (parseFloat(ret_otras)||0);
      const neto_acreditar = precio_bruto - descuentos - retenciones;

      const r = db.prepare(`INSERT INTO sg_ven_liquidaciones
        (numero, fecha, cliente_id, nro_remito, observaciones, precio_bruto,
         desc_comision, desc_flete, desc_carga_descarga, desc_otros,
         ret_iva, ret_ganancias, ret_iibb, ret_otras, neto_acreditar, usuario_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(numero, fechaLiq, parseInt(cliente_id), nro_remito||null, observaciones||null,
             precio_bruto, parseFloat(desc_comision)||0, parseFloat(desc_flete)||0,
             parseFloat(desc_carga_descarga)||0, parseFloat(desc_otros)||0,
             parseFloat(ret_iva)||0, parseFloat(ret_ganancias)||0,
             parseFloat(ret_iibb)||0, parseFloat(ret_otras)||0,
             neto_acreditar, u.id);
      const liqId = r.lastInsertRowid;

      for (const it of items) {
        db.prepare(`INSERT INTO sg_ven_liquidacion_items (liquidacion_id, descripcion, kilos, precio_unitario, subtotal)
          VALUES (?,?,?,?,?)`)
          .run(liqId, it.descripcion||'', parseFloat(it.kilos)||null,
               parseFloat(it.precio_unitario)||null, parseFloat(it.subtotal)||0);
      }

      // Generar asiento contable automático (libros SG)
      let asientoId = null;
      try {
        const cliente = db.prepare('SELECT * FROM sg_clientes WHERE id=?').get(parseInt(cliente_id));
        const configImp = {};
        db.prepare('SELECT clave, cuenta_id FROM sg_config_impositiva WHERE cuenta_id IS NOT NULL').all()
          .forEach(row => { configImp[row.clave] = row.cuenta_id; });

        const cuentaCliente   = cliente?.cuenta_contable_id || null;
        const cuentaVentas    = configImp['ventas']          || null;
        const cuentaRetIva    = configImp['percepcion_iva']  || null;
        const cuentaRetGan    = configImp['percepcion_ganancias'] || null;
        const cuentaRetIibb   = configImp['percepcion_iibb'] || null;

        if (cuentaCliente && cuentaVentas) {
          const asiento = db.prepare(`INSERT INTO sg_asientos (fecha, descripcion, usuario_id, ref_codigo)
            VALUES (?,?,?,?)`)
            .run(fechaLiq, `${numero} | ${cliente?.razon_social||''} | Liq. Producto`, u.id, numero);
          asientoId = asiento.lastInsertRowid;
          const ins = db.prepare(`INSERT INTO sg_asientos_lineas (asiento_id, cuenta_id, debe, haber, descripcion)
            VALUES (?,?,?,?,?)`);

          ins.run(asientoId, cuentaCliente, neto_acreditar, 0, `Neto liquidación ${numero}`);
          if (ret_iva    > 0 && cuentaRetIva)  ins.run(asientoId, cuentaRetIva,  parseFloat(ret_iva),  0, 'Retención IVA');
          if (ret_ganancias>0 && cuentaRetGan) ins.run(asientoId, cuentaRetGan, parseFloat(ret_ganancias), 0, 'Retención Ganancias');
          if (ret_iibb   > 0 && cuentaRetIibb) ins.run(asientoId, cuentaRetIibb, parseFloat(ret_iibb), 0, 'Retención IIBB');
          ins.run(asientoId, cuentaVentas, 0, precio_bruto, `Venta bruta ${numero}`);

          db.prepare('UPDATE sg_ven_liquidaciones SET asiento_id=? WHERE id=?').run(asientoId, liqId);
        }
      } catch(eA) { console.error('[SG-VEN] Error asiento liq:', eA.message); }

      return { liqId, numero };
    });

    const result = tx();
    res.json({ ok: true, id: result.liqId, numero: result.numero });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/liquidaciones/:id/anular', requireAuth, (req, res) => {
  try {
    const l = db.prepare('SELECT * FROM sg_ven_liquidaciones WHERE id=?').get(req.params.id);
    if (!l) return res.status(404).json({ ok: false, error: 'No encontrada' });
    if (l.estado === 'anulada') return res.json({ ok: true, msg: 'Ya estaba anulada' });
    db.transaction(() => {
      if (l.asiento_id) db.prepare("UPDATE sg_asientos SET anulado=1 WHERE id=?").run(l.asiento_id);
      const docs = db.prepare("SELECT cobranza_id, monto FROM sg_ven_cobranza_docs WHERE tipo='liquidacion' AND doc_id=?").all(l.id);
      for (const d of docs) {
        db.prepare('UPDATE sg_ven_cobranzas SET anulada=1 WHERE id=?').run(d.cobranza_id);
      }
      db.prepare("UPDATE sg_ven_liquidaciones SET estado='anulada' WHERE id=?").run(l.id);
    })();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// FACTURAS DE VENTA
// ═══════════════════════════════════════════════════════════════════════════════

function generarNumFac(tipo) {
  const año = new Date().getFullYear();
  const prefix = `FAV-${tipo}-${año}`;
  const ult = db.prepare("SELECT numero FROM sg_ven_facturas WHERE numero LIKE ? ORDER BY id DESC LIMIT 1")
    .get(`${prefix}-%`);
  let n = 1;
  if (ult) { const p = ult.numero.split('-'); n = parseInt(p[p.length-1]) + 1; }
  return `${prefix}-${String(n).padStart(4,'0')}`;
}

router.get('/facturas', (req, res) => {
  try {
    const { clienteId, estado } = req.query;
    let sql = `SELECT f.*, c.razon_social as cliente_nombre
               FROM sg_ven_facturas f JOIN sg_clientes c ON c.id=f.cliente_id WHERE 1 = 1`;
    const params = [];
    if (clienteId) { sql += ' AND f.cliente_id=?'; params.push(parseInt(clienteId)); }
    if (estado)    { sql += ' AND f.estado=?'; params.push(estado); }
    sql += ' ORDER BY f.fecha DESC, f.id DESC';
    const facs = db.prepare(sql).all(...params);
    for (const f of facs) {
      f.items = db.prepare('SELECT * FROM sg_ven_factura_items WHERE factura_id=? ORDER BY id').all(f.id);
    }
    res.json({ ok: true, data: facs });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/facturas', requireAuth, (req, res) => {
  const u = req._user;
  const { fecha, cliente_id, tipo, concepto, items, notas, nro_factura } = req.body || {};
  if (!cliente_id) return res.status(400).json({ ok: false, error: 'cliente_id requerido' });
  if (!items?.length) return res.status(400).json({ ok: false, error: 'Ingresá al menos un ítem' });

  if (nro_factura?.trim()) {
    const existe = db.prepare('SELECT id FROM sg_ven_facturas WHERE numero=? AND cliente_id=?')
      .get(nro_factura.trim(), parseInt(cliente_id));
    if (existe) return res.status(400).json({ ok: false, error: `Ya existe la factura ${nro_factura} para este cliente` });
  }
  try {
    const tx = db.transaction(() => {
      const numero = nro_factura?.trim() || generarNumFac(tipo||'A');
      const fechaFac = fecha || new Date().toISOString().split('T')[0];
      const neto  = items.reduce((s, it) => s + (parseFloat(it.subtotal)||0), 0);
      const iva   = parseFloat(req.body.iva)||0;
      const total = neto + iva;

      const r = db.prepare(`INSERT INTO sg_ven_facturas (numero, fecha, cliente_id, tipo, concepto, neto, iva, total, notas, usuario_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(numero, fechaFac, parseInt(cliente_id), tipo||'A', concepto||null, neto, iva, total, notas||null, u.id);
      const facId = r.lastInsertRowid;

      for (const it of items) {
        db.prepare(`INSERT INTO sg_ven_factura_items (factura_id, descripcion, cantidad, precio_unitario, subtotal)
          VALUES (?,?,?,?,?)`)
          .run(facId, it.descripcion||'', parseFloat(it.cantidad)||1,
               parseFloat(it.precio_unitario)||0, parseFloat(it.subtotal)||0);
      }
      return { facId, numero };
    });
    const result = tx();
    res.json({ ok: true, id: result.facId, numero: result.numero });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/facturas/:id/anular', requireAuth, (req, res) => {
  try {
    const f = db.prepare('SELECT * FROM sg_ven_facturas WHERE id=?').get(req.params.id);
    if (!f) return res.status(404).json({ ok: false, error: 'No encontrada' });
    if (f.estado === 'anulada') return res.json({ ok: true });
    if (f.asiento_id) db.prepare("UPDATE sg_asientos SET anulado=1 WHERE id=?").run(f.asiento_id);
    db.prepare("UPDATE sg_ven_facturas SET estado='anulada' WHERE id=?").run(f.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CUENTA CORRIENTE CLIENTES
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/cc/:clienteId', (req, res) => {
  try {
    const cid = parseInt(req.params.clienteId);
    const liquidaciones = db.prepare(`
      SELECT l.id, l.numero, l.fecha, l.neto_acreditar as total, l.estado,
        COALESCE((SELECT SUM(cd.monto) FROM sg_ven_cobranza_docs cd
          JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
          WHERE cd.tipo='liquidacion' AND cd.doc_id=l.id AND co.anulada=0), 0) as cobrado,
        l.neto_acreditar - COALESCE((SELECT SUM(cd.monto) FROM sg_ven_cobranza_docs cd
          JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
          WHERE cd.tipo='liquidacion' AND cd.doc_id=l.id AND co.anulada=0), 0) as pendiente,
        'liquidacion' as tipo_doc
      FROM sg_ven_liquidaciones l WHERE l.cliente_id=? AND l.estado != 'anulada'
    `).all(cid);

    const facturas = db.prepare(`
      SELECT f.id, f.numero, f.fecha, f.total, f.estado,
        COALESCE((SELECT SUM(cd.monto) FROM sg_ven_cobranza_docs cd
          JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
          WHERE cd.tipo='factura' AND cd.doc_id=f.id AND co.anulada=0), 0) as cobrado,
        f.total - COALESCE((SELECT SUM(cd.monto) FROM sg_ven_cobranza_docs cd
          JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
          WHERE cd.tipo='factura' AND cd.doc_id=f.id AND co.anulada=0), 0) as pendiente,
        'factura' as tipo_doc
      FROM sg_ven_facturas f WHERE f.cliente_id=? AND f.estado != 'anulada'
    `).all(cid);

    const docs = [...liquidaciones, ...facturas].sort((a,b) => a.fecha < b.fecha ? 1 : -1);
    const totales = docs.reduce((acc, d) => {
      acc.total    += d.total;
      acc.cobrado  += d.cobrado;
      acc.pendiente+= d.pendiente;
      return acc;
    }, { total: 0, cobrado: 0, pendiente: 0 });

    const cobranzas = db.prepare(`
      SELECT co.*, u.nombre as usuario_nombre
      FROM sg_ven_cobranzas co LEFT JOIN usuarios u ON u.id=co.usuario_id
      WHERE co.cliente_id=? AND co.anulada=0
      ORDER BY co.fecha DESC
    `).all(cid);

    res.json({ ok: true, docs, totales, cobranzas });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// COBRANZAS
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/cobranzas', requireAuth, (req, res) => {
  const u = req._user;
  const { fecha, cliente_id, monto, forma_pago, referencia, notas, docs } = req.body || {};
  if (!cliente_id) return res.status(400).json({ ok: false, error: 'cliente_id requerido' });
  if (!monto || monto <= 0) return res.status(400).json({ ok: false, error: 'monto inválido' });
  if (!docs?.length) return res.status(400).json({ ok: false, error: 'Seleccioná al menos un documento' });
  try {
    const tx = db.transaction(() => {
      const r = db.prepare(`INSERT INTO sg_ven_cobranzas (fecha, cliente_id, monto, forma_pago, referencia, notas, usuario_id)
        VALUES (?,?,?,?,?,?,?)`)
        .run(fecha||new Date().toISOString().split('T')[0], parseInt(cliente_id),
             parseFloat(monto), forma_pago||'transferencia', referencia||null, notas||null, u.id);
      const cobId = r.lastInsertRowid;

      for (const d of docs) {
        db.prepare(`INSERT INTO sg_ven_cobranza_docs (cobranza_id, tipo, doc_id, monto) VALUES (?,?,?,?)`)
          .run(cobId, d.tipo, parseInt(d.doc_id), parseFloat(d.monto));
        if (d.tipo === 'liquidacion') {
          const liq = db.prepare('SELECT neto_acreditar FROM sg_ven_liquidaciones WHERE id=?').get(d.doc_id);
          const cobrado = db.prepare(`SELECT COALESCE(SUM(cd.monto),0) as tot FROM sg_ven_cobranza_docs cd
            JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
            WHERE cd.tipo='liquidacion' AND cd.doc_id=? AND co.anulada=0`).get(d.doc_id);
          if (cobrado.tot >= liq.neto_acreditar - 0.01)
            db.prepare("UPDATE sg_ven_liquidaciones SET estado='cobrada' WHERE id=?").run(d.doc_id);
        } else if (d.tipo === 'factura') {
          const fac = db.prepare('SELECT total FROM sg_ven_facturas WHERE id=?').get(d.doc_id);
          const cobrado = db.prepare(`SELECT COALESCE(SUM(cd.monto),0) as tot FROM sg_ven_cobranza_docs cd
            JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
            WHERE cd.tipo='factura' AND cd.doc_id=? AND co.anulada=0`).get(d.doc_id);
          if (cobrado.tot >= fac.total - 0.01)
            db.prepare("UPDATE sg_ven_facturas SET estado='cobrada' WHERE id=?").run(d.doc_id);
        }
      }
      return cobId;
    });
    const cobId = tx();
    res.json({ ok: true, id: cobId });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/cobranzas/:id', requireAuth, (req, res) => {
  try {
    const co = db.prepare('SELECT * FROM sg_ven_cobranzas WHERE id=?').get(req.params.id);
    if (!co) return res.status(404).json({ ok: false, error: 'No encontrada' });
    db.transaction(() => {
      const docs = db.prepare('SELECT * FROM sg_ven_cobranza_docs WHERE cobranza_id=?').all(co.id);
      for (const d of docs) {
        if (d.tipo === 'liquidacion')
          db.prepare("UPDATE sg_ven_liquidaciones SET estado='pendiente' WHERE id=? AND estado='cobrada'").run(d.doc_id);
        else if (d.tipo === 'factura')
          db.prepare("UPDATE sg_ven_facturas SET estado='pendiente' WHERE id=? AND estado='cobrada'").run(d.doc_id);
      }
      db.prepare('UPDATE sg_ven_cobranzas SET anulada=1 WHERE id=?').run(co.id);
    })();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
