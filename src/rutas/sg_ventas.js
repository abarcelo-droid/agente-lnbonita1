// src/rutas/sg_ventas.js
// ── MÓDULO VENTAS SG — copia de rutas/ventas.js repuntada a tablas sg_ven_* ───
// Copia física del Ventas de PC para que SG diverja. Clientes, liquidaciones de
// producto, facturas, cobranzas y cuenta corriente, sobre sg_ven_*. Los asientos
// automáticos van a sg_asientos (libros de SG) y la config fiscal a
// sg_config_impositiva. SIN dimensión sociedad_id (tablas SG-only).
// Montado en /api/sg/ventas. NO toca ninguna tabla ven_*/pa_*.

import express from 'express';
import db from '../servicios/db_sg_finanzas.js';
import { crearAsiento, MOTIVOS } from '../servicios/asientos.js';
// EL ASIENTO DE VENTA VIVE EN UN SOLO LUGAR. Estaba acá adentro y el otro
// camino que emite facturas —la facturación directa, por afip-wsfe-emision—
// no lo usaba: esas ventas salían sin asiento.
import { modeloVentaLineas, modeloVentaFaltan, lineasAsientoVenta, r2v }
  from '../servicios/asiento-venta.js';
import { generarFacturaPDF } from '../servicios/facturaPDF.js';
import { enviarMail } from '../servicios/mail.js';
import * as XLSX from 'xlsx';
import { exigirEmpresa, SAN_GERONIMO } from '../servicios/sociedad_modulo.js';

const router = express.Router();

// ── EL CERROJO DE EMPRESA, CONECTADO ──────────────────────────────────────
// Corre ANTES que cualquier endpoint de este router. Si el pedido viene con OTRA
// empresa, corta con 403 y explica cuál esperaba.
//
// Puente Cordón ya lo tenía en sus nueve routers; el lado de San Gerónimo había
// quedado sin poner. La regla del dueño vale para los dos lados: parado en una
// sociedad no se tocan las tablas de otra, ni siquiera teniendo permiso para
// entrar a esa otra — hay que cambiar el selector y operar desde ahí.
router.use((req, res, next) => {
  if (exigirEmpresa(req, res, SAN_GERONIMO) === null) return;   // ya contestó 403
  next();
});

// Filtros compartidos por GET /facturas y GET /facturas/export.xlsx. Devuelve {sql, params}.
// alias = nombre_comercial del cliente. solo_afip → solo comprobantes fiscales (con afip_estado).
function buildFacturasQuery(req) {
  const { clienteId, estado, afip_estado, tipo, desde, hasta, solo_afip } = req.query;
  // El mail del cliente y el último envío viajan con cada fila: la pantalla
  // tiene que poder decir «ésta ya se mandó» sin un pedido por renglón.
  let sql = `SELECT f.*, c.razon_social as cliente_nombre, c.nombre_comercial as alias,
               c.email as cliente_email,
               (SELECT MAX(e.enviado_en) FROM sg_ven_envios e
                 WHERE e.factura_id = f.id AND e.ok = 1) AS ultimo_envio
             FROM sg_ven_facturas f JOIN sg_clientes c ON c.id=f.cliente_id WHERE 1 = 1`;
  const params = [];
  if (clienteId)   { sql += ' AND f.cliente_id=?'; params.push(parseInt(clienteId)); }
  if (estado)      { sql += ' AND f.estado=?'; params.push(estado); }
  if (afip_estado) { sql += ' AND f.afip_estado=?'; params.push(afip_estado); }
  if (tipo)        { sql += ' AND f.tipo=?'; params.push(tipo); }
  if (desde)       { sql += ' AND f.fecha>=?'; params.push(desde); }
  if (hasta)       { sql += ' AND f.fecha<=?'; params.push(hasta); }
  if (solo_afip)   { sql += ' AND f.afip_estado IS NOT NULL'; }
  sql += ' ORDER BY f.fecha DESC, f.id DESC';
  return { sql, params };
}

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

// PARAMETRIZAR ES DE ADMIN. Elegir con qué asiento modelo se contabilizan TODAS
// las ventas es la misma clase de decisión que dar de alta una cuenta bancaria:
// no es el trabajo del día, es la forma en que ese trabajo queda registrado.
function requireAdmin(req, res, next) {
  const u = getUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'no autenticado' });
  if (u.rol !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
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
          const lineas = [
            { cuenta_id: cuentaCliente, debe: neto_acreditar, haber: 0,
              descripcion: `Neto liquidación ${numero}` },
          ];
          if (ret_iva > 0 && cuentaRetIva) {
            lineas.push({ cuenta_id: cuentaRetIva, debe: parseFloat(ret_iva), haber: 0, descripcion: 'Retención IVA' });
          }
          if (ret_ganancias > 0 && cuentaRetGan) {
            lineas.push({ cuenta_id: cuentaRetGan, debe: parseFloat(ret_ganancias), haber: 0, descripcion: 'Retención Ganancias' });
          }
          if (ret_iibb > 0 && cuentaRetIibb) {
            lineas.push({ cuenta_id: cuentaRetIibb, debe: parseFloat(ret_iibb), haber: 0, descripcion: 'Retención IIBB' });
          }
          lineas.push({ cuenta_id: cuentaVentas, debe: 0, haber: precio_bruto, descripcion: `Venta bruta ${numero}` });
          // EL ESPEJO DE LA COMPRA. Si se acordó más de lo que se facturó, la
          // diferencia entra como dos líneas de gestión en el MISMO asiento: el
          // cliente al debe —debe más— contra Ventas al haber. Sin IVA: el
          // débito fiscal sale del comprobante y de nada más.
          const difLiq = Math.round((parseFloat(req.body.dif_gestion) || 0) * 100) / 100;
          const difMotLiq = String(req.body.dif_motivo || '').trim();
          if (difLiq > 0 && MOTIVOS[difMotLiq]) {
            lineas.push({ cuenta_id: cuentaCliente, debe: difLiq, haber: 0, ambito: 'gestion',
              motivo: difMotLiq, descripcion: 'Diferencia con lo acordado' });
            lineas.push({ cuenta_id: cuentaVentas, debe: 0, haber: difLiq, ambito: 'gestion',
              motivo: difMotLiq, descripcion: 'Diferencia con lo acordado' });
            db.prepare('UPDATE sg_ven_liquidaciones SET dif_gestion=?, dif_motivo=? WHERE id=?')
              .run(difLiq, difMotLiq, liqId);
          }
          asientoId = crearAsiento(db, {
            fecha: fechaLiq, usuario_id: u.id, ref_codigo: numero,
            descripcion: `${numero} | ${cliente?.razon_social||''} | Liq. Producto`,
          }, lineas).id;

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
    const { sql, params } = buildFacturasQuery(req);
    const facs = db.prepare(sql).all(...params);
    for (const f of facs) {
      f.items = db.prepare('SELECT * FROM sg_ven_factura_items WHERE factura_id=? ORDER BY id').all(f.id);
    }
    res.json({ ok: true, data: facs });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /facturas/export.xlsx → genera el XLSX EN EL SERVIDOR (lib xlsx) respetando los mismos
// filtros que el listado. Columnas = las de la tabla del front. Ruta literal: NO choca con
// /facturas/:id/pdf (3 segmentos) ni /facturas/:id (handlers con :id).
router.get('/facturas/export.xlsx', (req, res) => {
  try {
    const { sql, params } = buildFacturasQuery(req);
    const facs = db.prepare(sql).all(...params);
    const filas = facs.map(f => ({
      'N°': String(f.punto_venta || 0).padStart(4, '0') + '-' + String(f.cbte_nro || 0).padStart(8, '0'),
      'Fecha': f.fecha || '',
      'Tipo': f.tipo || '',
      'Alias': f.alias || '',
      'Cliente': f.cliente_nombre || '',
      'Total': Number(f.total) || 0,
      'Estado': f.afip_estado || '',
      'CAE': f.cae || '',
      'Vto CAE': f.cae_vto || ''
    }));
    const ws = XLSX.utils.json_to_sheet(filas, { header: ['N°','Fecha','Tipo','Alias','Cliente','Total','Estado','CAE','Vto CAE'] });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Facturas');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="facturas-sg.xlsx"'
    });
    res.send(buf);
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// El modelo elegido, con sus líneas y con la verificación de que sirve.
router.get('/modelo-venta', requireAuth, (req, res) => {
  try {
    const m = modeloVentaLineas(db);
    if (!m.id) {
      return res.json({ ok: true, data: { modelo: null, id_perdido: m.perdido || null } });
    }
    const cab = db.prepare('SELECT * FROM sg_asientos_modelo WHERE id=?').get(m.id);
    cab.lineas = m.lineas;
    res.json({ ok: true, data: { modelo: cab, faltan: modeloVentaFaltan(m.lineas) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Elegir con qué modelo se contabilizan las ventas. Sólo admin: define cómo entra
// la plata de TODAS las ventas.
router.put('/modelo-venta', requireAdmin, (req, res) => {
  try {
    const modeloId = req.body && req.body.modelo_id ? Number(req.body.modelo_id) : null;
    if (modeloId) {
      const m = db.prepare('SELECT id FROM sg_asientos_modelo WHERE id=? AND activo=1').get(modeloId);
      if (!m) return res.status(400).json({ ok: false, error: 'Ese asiento modelo no existe o está dado de baja' });
    }
    db.prepare(`INSERT INTO sg_config (clave, valor, modificado_en, modificado_por)
      VALUES (?,?,datetime('now','localtime'),?)
      ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor,
        modificado_en=excluded.modificado_en, modificado_por=excluded.modificado_por`)
      .run(CLAVE_MODELO_VENTA, modeloId == null ? null : String(modeloId), req._user?.id || null);
    res.json({ ok: true, data: { modelo_id: modeloId } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── EL ASIENTO DE UNA FACTURA DE VENTA ──────────────────────────────────
//
// La factura de venta NO generaba asiento. La columna asiento_id existía y se
// usaba para anular, pero nadie la escribía: la venta salía del depósito, el
// cliente quedaba debiendo, y en el libro no pasaba nada.
//
// NO SE COPIA EL MOLDE DE LA LIQUIDACIÓN. La liquidación es cómo se le paga al
// productor —es un instrumento de COMPRA, aunque en este sistema viva del lado
// de ventas—. Una factura de venta lleva su propio asiento de ventas.
//
//   DEBE    Deudores por ventas (la cuenta del cliente)      total
//   HABER   Ventas                                            neto
//   HABER   IVA Débito Fiscal                                  iva
//
// Y EL DESCUENTO COMERCIAL VA EN GESTIÓN, igual que la diferencia de la compra.
// Si al proveedor de esa mercadería se le acordó un 30%, la factura sale por el
// 70% —eso es lo que va al libro fiscal— y el 30% restante se registra como
// venta de gestión: es lo que la empresa pone sobre la mesa en cada acuerdo, y
// sin medirlo no hay con qué sentarse a renegociarlo.
//
// SIN IVA del lado de gestión: el débito fiscal sale del comprobante y de nada
// más. Misma regla que en compras.
//
// Devuelve {lineas, falta} — `falta` dice qué cuenta no está parametrizada, para
// que la pantalla lo diga en vez de guardar un asiento a medias.

// EL CUADRO ANTES DE GUARDAR. Regla del repo: toda operación que asienta
// muestra el asiento, con sus totales y el cartel de si balancea. El asiento se
// arma en el backend y el usuario lo veía recién después, entrando a Asientos
// Contables — y si estaba mal, ya estaba hecho. El cuadro es el único momento
// en que se puede frenar.
//
// Devuelve EXACTAMENTE lo que se va a escribir: es la misma función.
router.post('/facturas/preview-asiento', requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    const neto = r2v(b.neto), iva = r2v(b.iva);
    const arm = lineasAsientoVenta(db, {
      clienteId: parseInt(b.cliente_id), neto, iva,
      total: (b.total != null ? r2v(b.total) : r2v(neto + iva)),
      descuento: r2v(b.descuento_gestion), numero: String(b.numero || '—'),
    });
    // Los nombres de las cuentas, para que el cuadro se lea sin buscarlas.
    const nom = db.prepare('SELECT id, codigo, nombre FROM sg_cuentas');
    const mapa = {};
    try { nom.all().forEach((c) => { mapa[c.id] = c; }); } catch (_) {}
    const lineas = arm.lineas.map((l) => Object.assign({}, l, {
      cuenta_codigo: (mapa[l.cuenta_id] || {}).codigo || null,
      cuenta_nombre: (mapa[l.cuenta_id] || {}).nombre || null,
      ambito: l.ambito || 'fiscal',
    }));
    // El balance se informa POR ÁMBITO: que el total cierre no alcanza —lo
    // fiscal puede estar descuadrado y lo de gestión compensarlo al revés.
    const tot = {};
    for (const l of lineas) {
      const a = l.ambito;
      tot[a] = tot[a] || { debe: 0, haber: 0 };
      tot[a].debe = r2v(tot[a].debe + (l.debe || 0));
      tot[a].haber = r2v(tot[a].haber + (l.haber || 0));
    }
    for (const k of Object.keys(tot)) tot[k].balancea = Math.abs(tot[k].debe - tot[k].haber) < 0.01;
    res.json({ ok: true, data: { lineas, totales: tot, falta: arm.falta } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
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
  // Lo acordado contra lo facturado, igual que en compras.
  //
  // EL DESCUENTO COMERCIAL ES UNA DIFERENCIA DE GESTIÓN, no una cosa aparte: la
  // factura sale por menos de lo que vale la venta, y esa parte se mide. Tenía
  // columna propia (descuento_gestion) y por eso la cuenta corriente no lo veía:
  // toda la pantalla —saldo, pendiente, controles— lee dif_gestion.
  const desc = Math.round((parseFloat(req.body.descuento_gestion) || 0) * 100) / 100;
  const difG = Math.round(((parseFloat(req.body.dif_gestion) || 0) + desc) * 100) / 100;
  // Un descuento acordado no va a tener comprobante nunca: ese es su motivo.
  const difM = String(req.body.dif_motivo || (desc > 0 ? 'ajuste_gestion' : '')).trim();
  if (difG < 0) {
    return res.status(400).json({ ok: false,
      error: 'La diferencia de gestión no puede ser negativa: si se facturó de MÁS, manda el comprobante.' });
  }
  if (difG > 0 && !MOTIVOS[difM]) {
    return res.status(400).json({ ok: false,
      error: 'Poné por qué la factura no coincide con lo acordado. Elegí el motivo: '
           + Object.values(MOTIVOS).map((m) => m.label).join(', ') + '.' });
  }
  try {
    const tx = db.transaction(() => {
      const numero = nro_factura?.trim() || generarNumFac(tipo||'A');
      const fechaFac = fecha || new Date().toISOString().split('T')[0];
      const neto  = items.reduce((s, it) => s + (parseFloat(it.subtotal)||0), 0);
      const iva   = parseFloat(req.body.iva)||0;
      const total = neto + iva;

      const r = db.prepare(`INSERT INTO sg_ven_facturas (numero, fecha, cliente_id, tipo, concepto, neto, iva, total, notas, usuario_id, dif_gestion, dif_motivo)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(numero, fechaFac, parseInt(cliente_id), tipo||'A', concepto||null, neto, iva, total, notas||null, u.id,
             difG, difG > 0 ? difM : null);
      const facId = r.lastInsertRowid;

      for (const it of items) {
        db.prepare(`INSERT INTO sg_ven_factura_items (factura_id, descripcion, cantidad, precio_unitario, subtotal)
          VALUES (?,?,?,?,?)`)
          .run(facId, it.descripcion||'', parseFloat(it.cantidad)||1,
               parseFloat(it.precio_unitario)||0, parseFloat(it.subtotal)||0);
      }
      // EL ASIENTO, EN LA MISMA TRANSACCIÓN. O entran la factura y su asiento, o
      // no entra ninguno: una venta fuera del libro es plata que el cliente debe
      // y que la contabilidad no sabe que existe.
      const arm = lineasAsientoVenta(db, { clienteId: parseInt(cliente_id),
        neto, iva, total, descuento: difG, numero });
      if (arm.falta.length) {
        throw new Error('No se puede contabilizar la venta: falta ' + arm.falta.join(' y ')
          + '. Se arregla en el asiento modelo de venta, en Contabilidad SG.');
      }
      const cliNom = (db.prepare('SELECT razon_social r FROM sg_clientes WHERE id=?')
        .get(parseInt(cliente_id)) || {}).r;
      const asientoId = crearAsiento(db, {
        fecha: fechaFac, usuario_id: u.id, ref_codigo: numero,
        descripcion: 'Venta — ' + (cliNom || '') + ' — Factura ' + numero,
      }, arm.lineas).id;
      db.prepare('UPDATE sg_ven_facturas SET asiento_id=? WHERE id=?').run(asientoId, facId);
      return { facId, numero, asientoId };
    });
    const result = tx();
    res.json({ ok: true, id: result.facId, numero: result.numero, asiento_id: result.asientoId });
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

// PDF del comprobante fiscal AFIP (RG 1415 + QR ARCA). Solo si AFIP lo autorizó (tiene CAE).
router.get('/facturas/:id/pdf', async (req, res) => {
  try {
    const f = db.prepare(`SELECT f.*, c.razon_social, c.cuit, c.categoria_fiscal,
        c.direccion_entrega, c.localidad, c.provincia
      FROM sg_ven_facturas f JOIN sg_clientes c ON c.id=f.cliente_id WHERE f.id=?`).get(req.params.id);
    if (!f) return res.status(404).json({ ok: false, error: 'Factura no encontrada' });
    // EL COMPROBANTE MANUAL TAMBIÉN SE IMPRIME. Antes esto pedía CAE siempre, así
    // que un comprobante emitido desde un punto de venta manual no se podía ver
    // ni mandar — y sin eso no se puede probar el circuito, que es para lo que
    // existe ese punto de venta.
    //
    // Lo que NO se hace es disfrazarlo: sale sin CAE ni QR, y con la leyenda de
    // que no es un comprobante fiscal. Un papel que parece una factura y no lo
    // es, es peor que no tenerlo.
    const esManual = String(f.afip_estado || '').startsWith('MANUAL');
    if (!esManual && (f.afip_estado !== 'autorizado' || !f.cae)) {
      return res.status(400).json({ ok: false, error: 'La factura no está autorizada por AFIP (sin CAE)' });
    }
    f.sin_valor_fiscal = esManual ? 1 : 0;
    f.cliente = { razon_social: f.razon_social, cuit: f.cuit, categoria_fiscal: f.categoria_fiscal,
      direccion_entrega: f.direccion_entrega, localidad: f.localidad, provincia: f.provincia };
    f.items = db.prepare('SELECT * FROM sg_ven_factura_items WHERE factura_id=? ORDER BY id').all(f.id);
    const pdf = await generarFacturaPDF(f);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="comprobante-${String(f.punto_venta||0).padStart(4,'0')}-${String(f.cbte_nro||0).padStart(8,'0')}.pdf"`
    });
    res.send(pdf);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── MANDAR EL COMPROBANTE POR MAIL ───────────────────────────────────────────
// Hasta ahora el comprobante se bajaba y se mandaba desde el mail de alguien.
// Eso funciona hasta que hay que contestar «¿se la mandamos?», y ahí no lo sabe
// nadie: cada uno mira su propia casilla de enviados.
//
// Va el MISMO PDF que imprime el botón de al lado — el que tiene el CAE y el QR
// de ARCA. No se arma otro documento para el mail: dos versiones del mismo
// comprobante es exactamente lo que no puede pasar.
router.post('/facturas/:id/mail', requireAuth, async (req, res) => {
  try {
    const f = db.prepare(`SELECT f.*, c.razon_social, c.cuit, c.categoria_fiscal, c.email,
        c.direccion_entrega, c.localidad, c.provincia
      FROM sg_ven_facturas f JOIN sg_clientes c ON c.id=f.cliente_id WHERE f.id=?`).get(req.params.id);
    if (!f) return res.status(404).json({ ok: false, error: 'Factura no encontrada' });
    // Sin CAE no hay comprobante que mandar: lo que saldría es un borrador con
    // pinta de factura, y del otro lado lo van a registrar como si lo fuera.
    if (f.afip_estado !== 'autorizado' || !f.cae) {
      return res.status(400).json({ ok: false,
        error: 'La factura no está autorizada por AFIP (sin CAE): todavía no hay comprobante que mandar.' });
    }
    const para = String(req.body?.to || f.email || '').trim();
    if (!para) {
      return res.status(400).json({ ok: false,
        error: 'El cliente no tiene mail cargado. Poné la dirección, o cargásela en la ficha del cliente.' });
    }
    const num = String(f.punto_venta || 0).padStart(4, '0') + '-'
              + String(f.cbte_nro || 0).padStart(8, '0');
    f.cliente = { razon_social: f.razon_social, cuit: f.cuit, categoria_fiscal: f.categoria_fiscal,
      direccion_entrega: f.direccion_entrega, localidad: f.localidad, provincia: f.provincia };
    f.items = db.prepare('SELECT * FROM sg_ven_factura_items WHERE factura_id=? ORDER BY id').all(f.id);
    const pdf = await generarFacturaPDF(f);

    const esc = (t) => String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const asunto = 'Comprobante ' + (f.tipo || '') + ' N° ' + num + ' — San Gerónimo';
    const cuerpo = String(req.body?.mensaje || '').trim();
    const html = '<p>Estimados de <b>' + esc(f.razon_social) + '</b>:</p>'
      + '<p>Adjuntamos el comprobante <b>' + esc(f.tipo) + ' N° ' + esc(num) + '</b> '
      + 'de fecha ' + esc(f.fecha) + ' por <b>$ '
      + Number(f.total || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 }) + '</b>.</p>'
      + (cuerpo ? '<p>' + esc(cuerpo).split('\n').join('<br>') + '</p>' : '')
      + '<p style="color:#666;font-size:12px">CAE ' + esc(f.cae)
      + ' — vence ' + esc(f.cae_vto) + '</p>'
      + '<p style="color:#666;font-size:12px">San Gerónimo S.A.</p>';

    const r = await enviarMail({
      to: para, asunto, cuerpo_html: html,
      adjuntos: [{ filename: 'comprobante-' + num + '.pdf', content: pdf.toString('base64') }],
      sender_name: 'San Gerónimo S.A.'
    });
    // Se anota el intento aunque haya fallado: un rebote dice que la dirección
    // del cliente está mal, y eso hay que poder verlo.
    db.prepare(`INSERT INTO sg_ven_envios (factura_id, para, asunto, ok, error, usuario_id)
      VALUES (?,?,?,?,?,?)`).run(f.id, para, asunto, r.success ? 1 : 0,
        r.success ? null : String(r.error || '').slice(0, 300), req._user?.id ?? null);
    if (!r.success) return res.status(502).json({ ok: false, error: r.error || 'No se pudo enviar' });
    res.json({ ok: true, para });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// El historial de envíos de un comprobante: quién, cuándo y a dónde.
router.get('/facturas/:id/envios', (req, res) => {
  try {
    res.json({ ok: true, data: db.prepare(`SELECT e.*, u.nombre AS usuario
      FROM sg_ven_envios e LEFT JOIN usuarios u ON u.id = e.usuario_id
      WHERE e.factura_id = ? ORDER BY e.id DESC`).all(req.params.id) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
        COALESCE(l.dif_gestion,0) AS dif_gestion, l.dif_motivo,
        l.neto_acreditar + COALESCE(l.dif_gestion,0)
          - COALESCE((SELECT SUM(cd.monto) FROM sg_ven_cobranza_docs cd
          JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
          WHERE cd.tipo='liquidacion' AND cd.doc_id=l.id AND co.anulada=0), 0) as pendiente,
        'liquidacion' as tipo_doc
      FROM sg_ven_liquidaciones l WHERE l.cliente_id=? AND l.estado != 'anulada'
    `).all(cid);

    const facturas = db.prepare(`
      SELECT f.id, f.numero, f.fecha, f.total, f.estado,
        f.punto_venta, f.cbte_tipo, f.cbte_nro, f.cae, f.ambiente,
        COALESCE((SELECT SUM(cd.monto) FROM sg_ven_cobranza_docs cd
          JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
          WHERE cd.tipo='factura' AND cd.doc_id=f.id AND co.anulada=0), 0) as cobrado,
        COALESCE(f.dif_gestion,0) AS dif_gestion, f.dif_motivo,
        f.total + COALESCE(f.dif_gestion,0)
          - COALESCE((SELECT SUM(cd.monto) FROM sg_ven_cobranza_docs cd
          JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
          WHERE cd.tipo='factura' AND cd.doc_id=f.id AND co.anulada=0), 0) as pendiente,
        'factura' as tipo_doc
      FROM sg_ven_facturas f WHERE f.cliente_id=? AND f.estado != 'anulada'
    `).all(cid);

    const docs = [...liquidaciones, ...facturas].sort((a,b) => a.fecha < b.fecha ? 1 : -1);
    const totales = docs.reduce((acc, d) => {
      acc.total    += d.total;
      // La parte de gestión se suma aparte y se muestra aparte: el total del
      // comprobante es lo que dice el papel y no se toca. Lo que el cliente debe
      // es total + gestión, y hay que poder ver las dos mitades por separado o
      // el saldo no se puede explicar.
      acc.gestion  += (d.dif_gestion || 0);
      acc.cobrado  += d.cobrado;
      acc.pendiente+= d.pendiente;
      return acc;
    }, { total: 0, gestion: 0, cobrado: 0, pendiente: 0 });

    const cobranzas = db.prepare(`
      SELECT co.*, u.nombre as usuario_nombre
      FROM sg_ven_cobranzas co LEFT JOIN usuarios u ON u.id=co.usuario_id
      WHERE co.cliente_id=? AND co.anulada=0
      ORDER BY co.fecha DESC
    `).all(cid);

    // La cuenta contable del cliente va en la ficha para que la pantalla pueda
    // MOSTRAR el asiento del cobro antes de confirmarlo (convención del
    // proyecto), y para avisar cuando falta en vez de fallar al guardar.
    const cli = db.prepare(`SELECT c.razon_social, cc.id, cc.codigo, cc.nombre
      FROM sg_clientes c LEFT JOIN sg_cuentas cc ON cc.id = c.cuenta_contable_id
      WHERE c.id = ?`).get(cid);
    res.json({ ok: true, docs, totales, cobranzas,
      cuenta_cliente: (cli && cli.id) ? { id: cli.id, codigo: cli.codigo, nombre: cli.nombre } : null });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// COBRANZAS
// ═══════════════════════════════════════════════════════════════════════════════

// De dónde sale la cuenta contable del cliente: de su ficha. Es la misma que usa
// el asiento de la liquidación —donde el cliente va al DEBE— así que la cobranza
// la usa al HABER y el mayor del cliente cierra solo.
function ctaContableCliente(clienteId) {
  const c = db.prepare('SELECT id, razon_social, cuenta_contable_id FROM sg_clientes WHERE id=? AND activo=1')
    .get(clienteId);
  return c || null;
}

// Lo que le queda por cobrar a un documento, mirando SOLO las cobranzas vivas.
function pendienteDeDoc(tipo, docId) {
  const tabla = tipo === 'liquidacion' ? 'sg_ven_liquidaciones' : 'sg_ven_facturas';
  const campo = tipo === 'liquidacion' ? 'neto_acreditar' : 'total';
  const d = db.prepare(`SELECT id, numero, cliente_id, estado, ${campo} AS total,
      COALESCE(dif_gestion,0) AS dif_gestion, dif_motivo FROM ${tabla} WHERE id=?`)
    .get(docId);
  if (!d) return null;
  const cob = db.prepare(`SELECT COALESCE(SUM(cd.monto),0) t FROM sg_ven_cobranza_docs cd
    JOIN sg_ven_cobranzas co ON co.id = cd.cobranza_id
    WHERE cd.tipo=? AND cd.doc_id=? AND co.anulada=0`).get(tipo, docId).t;
  // LO QUE EL CLIENTE DEBE ES LO ACORDADO, no lo facturado: el total del
  // comprobante más lo que quedó sin facturar. Es el espejo exacto de lo que se
  // le debe a un proveedor cuando su factura vino corta.
  const acordado = (d.total || 0) + (d.dif_gestion || 0);
  return { ...d, total: acordado, total_fiscal: d.total || 0, cobrado: cob,
    pendiente: Math.round((acordado - cob) * 100) / 100 };
}

// Las cuentas de donde puede entrar la plata, para el desplegable de la pantalla.
router.get('/cobranzas/cuentas', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`SELECT c.id, c.nombre, c.tipo, c.banco, c.cuenta_contable_id,
        cc.codigo AS cuenta_codigo, cc.nombre AS cuenta_nombre
      FROM sg_fin_cuentas c LEFT JOIN sg_cuentas cc ON cc.id = c.cuenta_contable_id
      WHERE c.activo = 1 ORDER BY c.tipo, c.nombre`).all();
    // La cuenta de cheques en cartera va acá porque el cobro con cheque asienta
    // contra ELLA, no contra un banco: la pantalla necesita el nombre para poder
    // mostrar el asiento antes de confirmar, como todo lo que toca el libro.
    const cartera = db.prepare(`SELECT cu.id, cu.codigo, cu.nombre
      FROM sg_config_impositiva ci JOIN sg_cuentas cu ON cu.id = ci.cuenta_id
      WHERE ci.clave='cheques_cartera'`).get() || null;
    res.json({ ok: true, data: rows, cartera });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── REGISTRAR UNA COBRANZA ─────────────────────────────────────────────────
// Hacía tres cosas y le faltaban dos. Anotaba la cobranza, la imputaba a los
// documentos y los marcaba cobrados; pero NO generaba asiento y NO movía ninguna
// cuenta. Entraba la plata y no subía nada: por eso la cuenta corriente de
// clientes mostraba "cobrado = 0" — no faltaba la consulta, faltaba que la
// cobranza existiera para la contabilidad.
//
// Y no controlaba nada: se podía imputar a un documento de OTRO cliente, por más
// de lo que ese documento debía, o contra uno anulado.
router.post('/cobranzas', requireAuth, (req, res) => {
  const u = req._user;
  const { fecha, cliente_id, monto, forma_pago, referencia, notas, docs } = req.body || {};
  const cli = ctaContableCliente(parseInt(cliente_id));
  if (!cli) return res.status(400).json({ ok: false, error: 'Elegí el cliente' });
  const total = Math.round(parseFloat(monto || 0) * 100) / 100;
  if (!(total > 0)) return res.status(400).json({ ok: false, error: 'Poné cuánto se cobró' });

  const lista = (Array.isArray(docs) ? docs : [])
    .map((d) => ({ tipo: d.tipo, doc_id: parseInt(d.doc_id), monto: Math.round(parseFloat(d.monto || 0) * 100) / 100 }))
    .filter((d) => d.doc_id && d.monto > 0);
  if (lista.some((d) => !['liquidacion', 'factura'].includes(d.tipo))) {
    return res.status(400).json({ ok: false, error: 'Tipo de documento inválido' });
  }

  // Cada imputación contra un documento DE ESE CLIENTE, vivo, y sin pasarse de
  // lo que le queda. Sin esto se podía cancelar la factura de otro.
  for (const d of lista) {
    const doc = pendienteDeDoc(d.tipo, d.doc_id);
    if (!doc) return res.status(400).json({ ok: false, error: 'Uno de los documentos no existe' });
    if (Number(doc.cliente_id) !== cli.id) {
      return res.status(400).json({ ok: false,
        error: `El comprobante ${doc.numero} es de otro cliente.` });
    }
    if (doc.estado === 'anulada') {
      return res.status(400).json({ ok: false,
        error: `El comprobante ${doc.numero} está anulado: no se le puede imputar un cobro.` });
    }
    if (d.monto > doc.pendiente + 0.01) {
      return res.status(400).json({ ok: false,
        error: `Al comprobante ${doc.numero} le quedan ${doc.pendiente} y le estás imputando ${d.monto}.` });
    }
  }
  const imputado = Math.round(lista.reduce((a, d) => a + d.monto, 0) * 100) / 100;
  if (imputado > total + 0.01) {
    return res.status(400).json({ ok: false,
      error: `Estás imputando ${imputado} y la cobranza es de ${total}.` });
  }

  // ── CON CHEQUE NO ENTRA PLATA A NINGÚN BANCO ─────────────────────────
  // Un cheque en cartera es un papel que vale el día que se deposita. Hasta
  // entonces el banco no recibió nada: cargarlo contra una cuenta bancaria haría
  // subir un saldo que no existe, y el día que se deposite subiría otra vez.
  //
  // Va contra la cuenta de "cheques en cartera" —valores a depositar—, y cuando
  // se deposita, esa cuenta se descarga contra el banco. El cheque además entra
  // a la CARTERA de Caja y Bancos, que es donde se lo sigue.
  const conCheque = String(forma_pago || '') === 'cheque';
  let ctaCartera = null, cheque = null;
  if (conCheque) {
    ctaCartera = (db.prepare("SELECT cuenta_id FROM sg_config_impositiva WHERE clave='cheques_cartera'")
      .get() || {}).cuenta_id || null;
    if (!ctaCartera) {
      return res.status(400).json({ ok: false,
        error: 'Falta decir contra qué cuenta contable van los cheques en cartera. Configurala en el '
             + 'plan de cuentas (clave "cheques_cartera") antes de cobrar con cheque.' });
    }
    const ch = req.body?.cheque || {};
    const nro = String(ch.nro_cheque || '').trim();
    const librador = String(ch.librador || '').trim();
    if (!nro || !librador) {
      return res.status(400).json({ ok: false,
        error: 'De un cheque hay que anotar por lo menos el número y quién lo firma.' });
    }
    // EL MISMO CHEQUE NO ENTRA DOS VECES. La identidad es banco + número +
    // librador, que es lo que está impreso en el papel.
    const ya = db.prepare(`SELECT id, estado, monto FROM sg_fin_cheques_terceros
      WHERE COALESCE(banco,'')=COALESCE(?,'') AND nro_cheque=? AND librador=?`)
      .get(String(ch.banco || '').trim() || null, nro, librador);
    if (ya) {
      return res.status(400).json({ ok: false,
        error: `Ese cheque ya está en la cartera: N° ${nro} de ${librador} por ${ya.monto} (${ya.estado}).` });
    }
    cheque = { banco: String(ch.banco || '').trim() || null, nro, librador,
               fecha_vto: ch.fecha_vto || null,
               // El CUIT del que firma: es la clave con la que se le pregunta al
               // BCRA si ese librador tiene deudas o cheques rechazados.
               cuit: String(ch.cuit_librador || '').replace(/[^0-9]/g, '') || null };
  }

  // LA PLATA ENTRA A ALGÚN LADO, y ese lado tiene que tener cuenta contable: sin
  // ella el asiento no se puede armar. Con cheque no hace falta: no entra a
  // ninguna cuenta todavía.
  // El id se limpia ANTES de la consulta: better-sqlite3 tira una excepción si le
  // pasan undefined, así que sin este paso "no elegí la cuenta" salía como un
  // error 500 del servidor en vez de decir qué falta.
  const ctaFinId = parseInt(req.body?.cuenta_fin_id, 10);
  const cuenta = Number.isInteger(ctaFinId)
    ? db.prepare(`SELECT c.*, cc.id AS cta FROM sg_fin_cuentas c
        LEFT JOIN sg_cuentas cc ON cc.id = c.cuenta_contable_id
        WHERE c.id=? AND c.activo=1`).get(ctaFinId)
    : null;
  if (!conCheque) {
    if (!cuenta) return res.status(400).json({ ok: false, error: 'Elegí en qué cuenta entra la plata' });
    if (!cuenta.cta) {
      return res.status(400).json({ ok: false,
        error: `La cuenta "${cuenta.nombre}" no tiene cuenta contable asociada, así que la cobranza no `
             + `puede entrar al libro. Asignásela en Caja y Bancos.` });
    }
  }
  if (!cli.cuenta_contable_id) {
    return res.status(400).json({ ok: false,
      error: `El cliente ${cli.razon_social} no tiene cuenta contable asignada: sin ella no se sabe `
           + `contra qué cuenta corriente se cancela el cobro. Asignásela en su ficha.` });
  }

  try {
    let cobId = null, asientoId = null;
    db.transaction(() => {
      const f = fecha || new Date().toISOString().split('T')[0];
      cobId = db.prepare(`INSERT INTO sg_ven_cobranzas
        (fecha, cliente_id, monto, forma_pago, referencia, notas, usuario_id, cuenta_fin_id)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(f, cli.id, total, forma_pago || 'transferencia', referencia || null, notas || null,
             u.id, conCheque ? null : cuenta.id).lastInsertRowid;

      // EL CHEQUE ENTRA A LA CARTERA, que vive en Caja y Bancos. Desde ahí se lo
      // sigue: qué hay, qué vence, y el día que se deposita entra la plata de
      // verdad al banco. Queda con el cliente del que vino, que no siempre es
      // quien firmó el papel: muchas veces al cliente le pagaron con ese cheque.
      if (cheque) {
        const chId = db.prepare(`INSERT INTO sg_fin_cheques_terceros
          (banco, nro_cheque, librador, monto, fecha_recepcion, fecha_vto, cliente_id, notas, cuit_librador)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(cheque.banco, cheque.nro, cheque.librador, total,
          f, cheque.fecha_vto, cli.id,
          'Cobranza ' + (referencia || '#' + cobId), cheque.cuit).lastInsertRowid;
        db.prepare('UPDATE sg_ven_cobranzas SET cheque_terceros_id=? WHERE id=?').run(chId, cobId);
      }

      const insDoc = db.prepare('INSERT INTO sg_ven_cobranza_docs (cobranza_id, tipo, doc_id, monto) VALUES (?,?,?,?)');
      for (const d of lista) {
        insDoc.run(cobId, d.tipo, d.doc_id, d.monto);
        // El documento queda cobrado cuando no le falta nada. Se recalcula con
        // TODAS las cobranzas vivas, no con la de ahora: puede haberse cobrado
        // en tres veces.
        const doc = pendienteDeDoc(d.tipo, d.doc_id);
        const tabla = d.tipo === 'liquidacion' ? 'sg_ven_liquidaciones' : 'sg_ven_facturas';
        if (doc.pendiente <= 0.01) {
          db.prepare(`UPDATE ${tabla} SET estado='cobrada' WHERE id=?`).run(d.doc_id);
        }
      }

      // ── EL ASIENTO ────────────────────────────────────────────────────
      // La plata entra: la cuenta del banco o de la caja al DEBE, contra la
      // cuenta corriente del cliente al HABER — que es el espejo exacto del
      // asiento de la liquidación, donde el cliente va al debe.
      asientoId = crearAsiento(db, {
        fecha: f, usuario_id: u.id, ref_codigo: referencia || null,
        descripcion: 'Cobranza de ' + cli.razon_social + (referencia ? ' — ' + referencia : '')
          + (lista.length ? ' — ' + lista.length + ' comprobante(s)' : ' (a cuenta)'),
      }, [
        { cuenta_id: conCheque ? ctaCartera : cuenta.cta, debe: total, haber: 0,
          descripcion: conCheque ? ('Cheque N° ' + cheque.nro + ' en cartera') : cuenta.nombre },
        { cuenta_id: cli.cuenta_contable_id, debe: 0, haber: total, descripcion: cli.razon_social },
      ]).id;
      db.prepare('UPDATE sg_ven_cobranzas SET asiento_id=? WHERE id=?').run(asientoId, cobId);

      // ── Y LA CUENTA SUBE ──────────────────────────────────────────────
      // El saldo de Caja y Bancos se calcula con los movimientos, no con el
      // libro: sin esto la plata entraba y el banco seguía igual.
      //
      // Con CHEQUE no se mueve ninguna cuenta: el banco todavía no recibió nada.
      // El movimiento lo hace el depósito, desde la cartera.
      if (!conCheque) {
        db.prepare(`INSERT INTO sg_fin_movimientos
          (cuenta_id, fecha, tipo, concepto, monto, referencia, usuario_id)
          VALUES (?,?, 'ingreso', ?,?,?,?)`).run(cuenta.id, f,
          'Cobranza de ' + cli.razon_social, total, 'COB-' + cobId, u.id);
      }
    })();
    res.json({ ok: true, id: Number(cobId), asiento_id: Number(asientoId),
      total, imputado, a_cuenta: Math.round((total - imputado) * 100) / 100 });
  } catch(e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── ANULAR UNA COBRANZA ────────────────────────────────────────────────────
// Devuelve todo: el saldo a los comprobantes, la plata a la cuenta y el asiento
// queda anulado —no borrado, como todo lo que ya tocó la contabilidad—.
//
// Es una función y no sólo una ruta porque el DELETE viejo tiene que hacer lo
// MISMO: había pantallas llamándolo, y un borrado que no devolviera la plata ni
// tocara el asiento dejaría la cuenta corriente diciendo cualquier cosa.
function anularCobranza(id, motivo, usuarioId) {
  if (!motivo) return { status: 400, error: 'Escribí por qué se anula: queda registrado' };
  const co = db.prepare('SELECT * FROM sg_ven_cobranzas WHERE id=?').get(id);
  if (!co) return { status: 404, error: 'Cobranza no encontrada' };
  if (co.anulada) return { status: 400, error: 'Esa cobranza ya está anulada' };
  {
    const req = { _user: { id: usuarioId } };
    db.transaction(() => {
      db.prepare(`UPDATE sg_ven_cobranzas SET anulada=1, anulada_en=datetime('now','localtime'),
        anulada_por=?, anulada_motivo=? WHERE id=?`).run(req._user?.id || null, motivo, co.id);
      // Los comprobantes vuelven a estar pendientes. Se mira el pendiente ya SIN
      // esta cobranza —arriba se marcó anulada— así que si otra la cubría, sigue
      // cobrada.
      for (const d of db.prepare('SELECT * FROM sg_ven_cobranza_docs WHERE cobranza_id=?').all(co.id)) {
        const doc = pendienteDeDoc(d.tipo, d.doc_id);
        const tabla = d.tipo === 'liquidacion' ? 'sg_ven_liquidaciones' : 'sg_ven_facturas';
        if (doc && doc.pendiente > 0.01) {
          db.prepare(`UPDATE ${tabla} SET estado='pendiente' WHERE id=? AND estado='cobrada'`).run(d.doc_id);
        }
      }
      // La plata se va de la cuenta. El movimiento se BORRA en vez de marcarse:
      // el saldo se calcula sumando movimientos, y uno "anulado" seguiría sumando.
      db.prepare("DELETE FROM sg_fin_movimientos WHERE referencia=?").run('COB-' + co.id);
      // Y si el cobro fue con cheque, ese cheque sale de la cartera. Si ya se
      // depositó no se toca: la plata entró al banco y anular la cobranza no la
      // saca de ahí — eso se resuelve marcando el cheque rechazado.
      if (co.cheque_terceros_id) {
        const ch = db.prepare('SELECT estado FROM sg_fin_cheques_terceros WHERE id=?')
          .get(co.cheque_terceros_id);
        if (ch && ch.estado === 'en_cartera') {
          db.prepare(`UPDATE sg_fin_cheques_terceros SET estado='anulado',
            notas = TRIM(COALESCE(notas,'') || ' [ANULADO con la cobranza: ' || ? || ']')
            WHERE id=?`).run(motivo, co.cheque_terceros_id);
        }
      }
      if (co.asiento_id) {
        db.prepare(`UPDATE sg_asientos SET anulado=1, anulado_por=?, anulado_en=datetime('now','localtime'),
          descripcion = descripcion || ' — ANULADO: ' || ? WHERE id=?`)
          .run(req._user?.id || null, motivo, co.asiento_id);
      }
    })();
  }
  return { ok: true, id: Number(co.id) };
}

router.post('/cobranzas/:id/anular', requireAuth, (req, res) => {
  try {
    const r = anularCobranza(parseInt(req.params.id), String(req.body?.motivo || '').trim(),
      req._user?.id || null);
    if (r.error) return res.status(r.status).json({ ok: false, error: r.error });
    res.json({ ok: true, data: { id: r.id } });
  } catch(e) { res.status(400).json({ ok: false, error: e.message }); }
});

// El DELETE viejo hace exactamente lo mismo: hay pantallas que lo llaman.
router.delete('/cobranzas/:id', requireAuth, (req, res) => {
  try {
    const r = anularCobranza(parseInt(req.params.id),
      String(req.body?.motivo || '').trim() || 'Anulada desde la pantalla', req._user?.id || null);
    if (r.error) return res.status(r.status).json({ ok: false, error: r.error });
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ ok: false, error: e.message }); }
});

export default router;
