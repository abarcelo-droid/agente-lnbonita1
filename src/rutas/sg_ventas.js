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
import { repartirAmbito, partesDeMedio } from '../servicios/sg_cobro_ambito.js';
import { puedeMoverCuenta } from './sg_tesoreria.js';
// EL ASIENTO DE VENTA VIVE EN UN SOLO LUGAR. Estaba acá adentro y el otro
// camino que emite facturas —la facturación directa, por afip-wsfe-emision—
// no lo usaba: esas ventas salían sin asiento.
import { modeloVentaLineas, modeloVentaFaltan, lineasAsientoVenta, r2v }
  from '../servicios/asiento-venta.js';
import { recontabilizarVenta, emitir as afipEmitir, pctDeAlicuotaId }
  from '../servicios/afip-wsfe-emision.js';
// QUÉ FACTURA CUENTA: una sola definición, la misma que usa la cuenta corriente.
// Escribir la lista a mano acá es lo que dejó una factura RECHAZADA figurando como
// deuda viva en la ficha del cliente y cobrable desde la pantalla de cobranzas.
import { facturaCuenta, noEsNotaDeCredito, ncAplicadas, ncAplicadasFiscal,
  ncAplicadasGestion, esNotaDeCredito, esNotaDeDebito, ES_NOTA_CREDITO }
  from '../servicios/factura-cuenta.js';
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
// ══ DIEZ LECTURAS QUE NO PEDÍAN SESIÓN ═════════════════════════════════════
//
// Estos diez GET no tenían requireAuth: el libro de ventas entero en Excel
// (/facturas/export.xlsx), la cuenta corriente de cualquier cliente con su CUIT
// (/cc/:clienteId), el PDF de cualquier comprobante. No estaban abiertos a
// internet —el portón de index.js exige sesión para todo /api— pero sí a
// cualquiera con usuario, sin importar qué módulos tenga.
//
// Es la misma puerta que se acaba de cerrar en /sg/oferta, del otro lado del
// pasillo. Poner requireAuth no cambia nada para el que trabaja: el panel manda
// la cookie en cada pedido. Lo que cambia es que deja de contestar sin ella.
//
// FALTA la otra mitad, y queda anotada: el control por NIVEL de módulo sobre
// estas lecturas necesita agregarlas a LECTURA_CONTROLADA (servicios/permisos.js)
// y relevar qué pantallas las leen, una por una — igual que se hizo con /oferta.
// Declararlas de memoria dejaría pantallas vacías sin mensaje.
function buildFacturasQuery(req) {
  const { clienteId, estado, afip_estado, tipo, desde, hasta, solo_afip } = req.query;
  // El mail del cliente y el último envío viajan con cada fila: la pantalla
  // tiene que poder decir «ésta ya se mandó» sin un pedido por renglón.
  let sql = `SELECT f.*, c.razon_social as cliente_nombre, c.nombre_comercial as alias,
               c.email as cliente_email,
               (SELECT MAX(e.enviado_en) FROM sg_ven_envios e
                 WHERE e.factura_id = f.id AND e.ok = 1) AS ultimo_envio,
               -- CUÁNTO SE LE ACREDITÓ YA. No alcanza con «tiene o no tiene nota»:
               -- desde que la nota puede ser PARCIAL, una factura acreditada a medias
               -- sigue teniendo saldo y sigue pudiendo recibir otra nota. Con el flag
               -- binario, la primera nota parcial apagaba el botón y el resto de la
               -- devolución no se podía hacer nunca.
               ${ncAplicadas('f')} AS nc_acreditado,
               (SELECT n.id FROM sg_ven_facturas n
                 WHERE n.nc_de_factura_id = f.id AND ${facturaCuenta('n')}
                   AND ${ES_NOTA_CREDITO('n')} LIMIT 1) AS nc_id,
               -- Y lo que se le cobró DE MÁS con notas de débito, que va para el otro
               -- lado: suma a la deuda del cliente y no se descuenta de nada.
               COALESCE((SELECT SUM(COALESCE(n.total,0)) FROM sg_ven_facturas n
                 WHERE n.nc_de_factura_id = f.id AND ${facturaCuenta('n')}
                   AND COALESCE(n.cbte_tipo,0) IN (2,7)),0) AS nd_cargado,
               (SELECT o.punto_venta || '-' || o.cbte_nro FROM sg_ven_facturas o
                 WHERE o.id = f.nc_de_factura_id) AS nc_de_numero
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

router.get('/clientes', requireAuth, (req, res) => {
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

router.get('/clientes/:id', requireAuth, (req, res) => {
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

router.get('/liquidaciones', requireAuth, (req, res) => {
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

router.get('/liquidaciones/:id', requireAuth, (req, res) => {
  try {
    const l = db.prepare(`SELECT l.*, c.razon_social as cliente_nombre, c.cuit as cliente_cuit
      FROM sg_ven_liquidaciones l JOIN sg_clientes c ON c.id=l.cliente_id WHERE l.id=?`).get(req.params.id);
    if (!l) return res.status(404).json({ ok: false, error: 'Liquidación no encontrada' });
    l.items = db.prepare('SELECT * FROM sg_ven_liquidacion_items WHERE liquidacion_id=? ORDER BY id').all(l.id);
    res.json({ ok: true, data: l });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══ LAS LÍNEAS DEL ASIENTO DE UNA LIQUIDACIÓN RECIBIDA ════════════════
//
// Estaban escritas adentro del POST, dentro de un try que se comía el error con
// un console.error: si al cliente le faltaba la cuenta contable, la liquidación
// se guardaba igual y NO entraba al libro -- sin que nadie se enterara.
//
// Ahora salen de acá y las usan las dos: el preview que muestra la pantalla antes
// de emitir (convención del repo: toda operación que asienta muestra el asiento) y
// el POST que lo graba. Así lo que se ve es lo que se guarda.
//
// El cliente va al DEBE por el neto a acreditar --nos debe eso-- más las
// retenciones que nos practicó, contra Ventas al haber por el bruto.
export function armarLineasLiq(db, d) {
  const falta = [];
  const cliente = db.prepare('SELECT id, razon_social, cuenta_contable_id FROM sg_clientes WHERE id=?')
    .get(parseInt(d.cliente_id));
  const configImp = {};
  db.prepare('SELECT clave, cuenta_id FROM sg_config_impositiva WHERE cuenta_id IS NOT NULL').all()
    .forEach((row) => { configImp[row.clave] = row.cuenta_id; });

  const cuentaCliente = (cliente && cliente.cuenta_contable_id) || null;
  const cuentaVentas  = configImp['ventas'] || null;
  if (!cuentaCliente) falta.push('la cuenta contable del cliente ' + ((cliente && cliente.razon_social) || ''));
  if (!cuentaVentas)  falta.push('la cuenta de Ventas en la configuración impositiva');
  // ── EL IVA DE LA LIQUIDACIÓN ES DÉBITO FISCAL ──────────────────────────
  // La liquidación que nos emite el mercado o la cooperativa es NUESTRO comprobante
  // de venta. Sin esta línea, el asiento acreditaba Ventas por el bruto y la
  // operación no entraba al libro de IVA ventas.
  const ivaLiq = Math.round(((parseFloat(d.iva) || 0)) * 100) / 100;
  if (ivaLiq > 0 && !configImp['iva_debito_fiscal']) {
    falta.push('la cuenta de IVA Débito Fiscal en la configuración impositiva');
  }

  const n = (x) => Math.round(((parseFloat(x) || 0)) * 100) / 100;
  const ret = { percepcion_iva: n(d.ret_iva), percepcion_ganancias: n(d.ret_ganancias),
                percepcion_iibb: n(d.ret_iibb) };
  const rotulo = { percepcion_iva: 'Retención IVA', percepcion_ganancias: 'Retención Ganancias',
                   percepcion_iibb: 'Retención IIBB' };
  for (const k of Object.keys(ret)) {
    if (ret[k] > 0 && !configImp[k]) falta.push('la cuenta de ' + rotulo[k]);
  }
  // Lo que falta se junta y se dice TODO junto, más abajo: avisar de a una cuenta
  // por vez obliga a cargar, guardar, volver y descubrir la siguiente.
  const lineas = [
    { cuenta_id: cuentaCliente, debe: n(d.neto_acreditar), haber: 0,
      descripcion: `Neto liquidación ${d.numero}` },
  ];
  for (const k of Object.keys(ret)) {
    if (ret[k] > 0 && configImp[k]) {
      lineas.push({ cuenta_id: configImp[k], debe: ret[k], haber: 0, descripcion: rotulo[k] });
    }
  }
  // CADA COSA A SU CUENTA, Y SI NO ESTÁ SE AVISA. Acá había un "si no existe la
  // cuenta de gastos, usá la de percepción de IVA": una comisión imputada a una
  // cuenta de retenciones descuadra el libro impositivo y nadie lo mira hasta que
  // no cierra. Un asiento que no se puede armar bien no se arma.
  const otras = n(d.ret_otras);
  if (otras > 0 && !configImp['retencion']) falta.push('la cuenta de Retenciones');
  // Comisión, flete y carga los cobra el cliente: para nosotros son GASTO.
  const gastos = n(d.desc_comision) + n(d.desc_flete) + n(d.desc_carga_descarga) + n(d.desc_otros);
  if (gastos > 0 && !configImp['liq_recibida_gastos']) {
    falta.push('la cuenta de Gastos de liquidaciones recibidas '
      + '(se elige en Contabilidad SG → Configuración impositiva)');
  }
  if (falta.length) return { lineas: [], falta };
  if (otras > 0)  lineas.push({ cuenta_id: configImp['retencion'], debe: otras, haber: 0,
    descripcion: 'Otras retenciones' });
  if (gastos > 0) lineas.push({ cuenta_id: configImp['liq_recibida_gastos'], debe: gastos, haber: 0,
    descripcion: 'Descuentos de la liquidación' });

  lineas.push({ cuenta_id: cuentaVentas, debe: 0, haber: n(d.precio_bruto),
    descripcion: `Venta neta ${d.numero}` });
  if (ivaLiq > 0) {
    lineas.push({ cuenta_id: configImp['iva_debito_fiscal'], debe: 0, haber: ivaLiq,
      descripcion: `IVA débito ${d.numero}` });
  }

  // EL ESPEJO DE LA COMPRA. Si se acordó más de lo que dice el comprobante, la
  // diferencia entra como dos líneas de gestión en el MISMO asiento: el cliente al
  // debe --debe más-- contra Ventas al haber. Sin IVA: el débito fiscal sale del
  // comprobante y de nada más.
  const dif = n(d.dif_gestion);
  const mot = String(d.dif_motivo || '').trim();
  if (dif > 0 && MOTIVOS[mot]) {
    lineas.push({ cuenta_id: cuentaCliente, debe: dif, haber: 0, ambito: 'gestion',
      motivo: mot, descripcion: 'Diferencia con lo acordado' });
    lineas.push({ cuenta_id: cuentaVentas, debe: 0, haber: dif, ambito: 'gestion',
      motivo: mot, descripcion: 'Diferencia con lo acordado' });
  }
  return { lineas, falta: [] };
}

// El cuadro que la pantalla muestra ANTES de emitir. Espeja lo que arma el
// backend porque es literalmente la misma función.
router.post('/liquidaciones/preview-asiento', requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    const arm = armarLineasLiq(db, b);
    if (arm.falta.length) return res.json({ ok: true, falta: arm.falta, lineas: [], totales: {} });
    const conNombre = arm.lineas.map((l) => {
      const c = db.prepare('SELECT codigo, nombre FROM sg_cuentas WHERE id=?').get(l.cuenta_id) || {};
      return { ...l, ambito: l.ambito || 'fiscal',
        cuenta_codigo: c.codigo || '', cuenta_nombre: c.nombre || '' };
    });
    const totales = {};
    for (const l of conNombre) {
      const t = (totales[l.ambito] = totales[l.ambito] || { debe: 0, haber: 0 });
      t.debe = Math.round((t.debe + (l.debe || 0)) * 100) / 100;
      t.haber = Math.round((t.haber + (l.haber || 0)) * 100) / 100;
    }
    // EL FLAG QUE MIRA LA PANTALLA. Sin él, sgAsientoCuadro cae siempre en la rama
    // roja y el cuadro grita "NO balancea · diferencia $0" en TODAS las
    // liquidaciones, incluso en las que cierran perfecto. Un cartel que grita
    // siempre deja de ser señal a los dos días, y el día que de verdad descuadre
    // nadie lo va a mirar. Es la misma línea que usa el preview de facturas.
    for (const k of Object.keys(totales)) {
      totales[k].balancea = Math.abs(totales[k].debe - totales[k].haber) < 0.01;
    }
    res.json({ ok: true, falta: [], lineas: conNombre, totales });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.post('/liquidaciones', requireAuth, (req, res) => {
  const u = req._user;
  const { fecha, cliente_id, nro_remito, observaciones, items,
          desc_comision, desc_flete, desc_carga_descarga, desc_otros,
          ret_iva, ret_ganancias, ret_iibb, ret_otras, nro_liquidacion } = req.body || {};

  if (!cliente_id) return res.status(400).json({ ok: false, error: 'cliente_id requerido' });
  if (!items?.length) return res.status(400).json({ ok: false, error: 'Ingresá al menos un ítem' });

  // UNA DIFERENCIA DE GESTIÓN SIN MOTIVO NO ENTRA, y tampoco se descarta callada.
  // Acá el único control era `if (dif > 0 && MOTIVOS[mot])` adentro del armado del
  // asiento: con un motivo vacío o mal escrito, la diferencia desaparecía ENTERA
  // —ni líneas en el asiento ni número guardado— sin decir nada. La factura de
  // compra y la de venta cortan con un 400 pidiendo el motivo; ésta no.
  const difLiqIn = Math.round((parseFloat(req.body.dif_gestion) || 0) * 100) / 100;
  if (difLiqIn !== 0 && !MOTIVOS[String(req.body.dif_motivo || '').trim()]) {
    return res.status(400).json({ ok: false,
      error: 'Poné por qué la liquidación no coincide con lo acordado. Elegí el motivo: '
           + Object.values(MOTIVOS).map((m) => m.label).join(', ') + '.' });
  }

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
      // EL IVA SUMA a lo que el cliente nos tiene que acreditar: es plata que él nos
      // debe y que nosotros le debemos a la AFIP, no un descuento.
      const ivaLiq = Math.round(((parseFloat(req.body.iva) || 0)) * 100) / 100;
      const neto_acreditar = precio_bruto + ivaLiq - descuentos - retenciones;

      const r = db.prepare(`INSERT INTO sg_ven_liquidaciones
        (numero, fecha, cliente_id, nro_remito, observaciones, precio_bruto,
         desc_comision, desc_flete, desc_carga_descarga, desc_otros,
         ret_iva, ret_ganancias, ret_iibb, ret_otras, neto_acreditar, usuario_id, iva)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(numero, fechaLiq, parseInt(cliente_id), nro_remito||null, observaciones||null,
             precio_bruto, parseFloat(desc_comision)||0, parseFloat(desc_flete)||0,
             parseFloat(desc_carga_descarga)||0, parseFloat(desc_otros)||0,
             parseFloat(ret_iva)||0, parseFloat(ret_ganancias)||0,
             parseFloat(ret_iibb)||0, parseFloat(ret_otras)||0,
             neto_acreditar, u.id, ivaLiq);
      const liqId = r.lastInsertRowid;

      for (const it of items) {
        db.prepare(`INSERT INTO sg_ven_liquidacion_items (liquidacion_id, descripcion, kilos, precio_unitario, subtotal)
          VALUES (?,?,?,?,?)`)
          .run(liqId, it.descripcion||'', parseFloat(it.kilos)||null,
               parseFloat(it.precio_unitario)||null, parseFloat(it.subtotal)||0);
      }

      // ══ QUÉ REMITO DOCUMENTA ══════════════════════════════
      // Sin esto, los kilos del remito no se descontaban nunca: el despacho
      // quedaba pendiente para siempre y después se le podía emitir ADEMÁS una
      // factura por la misma mercadería.
      const vinculos = Array.isArray(req.body.vinculos) ? req.body.vinculos : [];
      if (vinculos.length) {
        const insV = db.prepare(`INSERT INTO sg_liquidacion_despachos
          (liquidacion_id, despacho_id, despacho_item_id, kg) VALUES (?,?,?,?)`);
        for (const v of vinculos) {
          if (!v || v.despacho_id == null) continue;
          const kg = v.kg != null ? Number(v.kg) : null;
          const diId = v.despacho_item_id != null ? Number(v.despacho_item_id) : null;
          // NO SE LIQUIDA MÁS DE LO QUE SALIÓ. El control estaba sólo en la
          // pantalla, y un control que vive sólo en el front no es un control:
          // basta con otra pestaña abierta --o alguien que facturó el mismo remito
          // hace un minuto-- para documentar dos veces los mismos kilos. La
          // transacción se cae entera, así que no queda media liquidación.
          if (diId != null && kg > 0) {
            const di = db.prepare('SELECT kg_despachados FROM sg_despacho_items WHERE id=?').get(diId);
            if (!di) throw new Error('El renglón ' + diId + ' del remito no existe');
            const yaFac = db.prepare(`SELECT COALESCE(SUM(fd.kg),0) s FROM sg_factura_despachos fd
              JOIN sg_ven_facturas f ON f.id=fd.factura_id
              WHERE fd.despacho_item_id=? AND COALESCE(f.afip_estado,'') <> 'rechazado'
                AND COALESCE(f.estado,'') <> 'anulada'`).get(diId).s;
            const yaLiq = db.prepare(`SELECT COALESCE(SUM(ld.kg),0) s FROM sg_liquidacion_despachos ld
              JOIN sg_ven_liquidaciones l ON l.id=ld.liquidacion_id
              WHERE ld.despacho_item_id=? AND COALESCE(l.estado,'') <> 'anulada'`).get(diId).s;
            const pend = Math.round(((Number(di.kg_despachados) || 0) - yaFac - yaLiq) * 100) / 100;
            if (kg > pend + 0.01) {
              throw new Error('Ese renglón del remito tiene ' + pend + ' kg pendientes y se '
                + 'quieren liquidar ' + kg + '. Puede que lo hayan facturado desde otra pantalla.');
            }
          }
          insV.run(liqId, Number(v.despacho_id), diId, kg);
        }
      }

      // Generar asiento contable automático (libros SG)
      let asientoId = null;
      try {
        const cliente = db.prepare('SELECT * FROM sg_clientes WHERE id=?').get(parseInt(cliente_id));
        const arm = armarLineasLiq(db, {
          cliente_id, numero, precio_bruto, neto_acreditar, iva: ivaLiq,
          desc_comision, desc_flete, desc_carga_descarga, desc_otros,
          ret_iva, ret_ganancias, ret_iibb, ret_otras,
          dif_gestion: req.body.dif_gestion, dif_motivo: req.body.dif_motivo,
        });
        if (arm.falta.length) {
          // NO SE GUARDA UNA VENTA FUERA DEL LIBRO. Acá el catch escribía en la
          // consola del servidor y devolvía ok:true, y eso ahora es peor que antes:
          // los kilos del remito SE CONSUMEN igual, así que el despacho sale de
          // «pendientes», no queda asiento, y no hay ninguna pantalla que liste las
          // liquidaciones sin contabilizar para volver a ellas.
          //
          // Se tira, y la transacción se cae entera: no queda ni la liquidación ni
          // el vínculo. La pantalla ya avisó lo mismo en el cuadro del asiento
          // antes de apretar; esto es el cerrojo.
          throw new Error('No se puede contabilizar: falta ' + arm.falta.join(' y ')
            + '. La liquidación NO se guardó.');
        } else {
          const difLiq = Math.round((parseFloat(req.body.dif_gestion) || 0) * 100) / 100;
          const difMotLiq = String(req.body.dif_motivo || '').trim();
          if (difLiq > 0 && MOTIVOS[difMotLiq]) {
            db.prepare('UPDATE sg_ven_liquidaciones SET dif_gestion=?, dif_motivo=? WHERE id=?')
              .run(difLiq, difMotLiq, liqId);
          }
          asientoId = crearAsiento(db, {
            fecha: fechaLiq, usuario_id: u.id, ref_codigo: numero,
            descripcion: `${numero} | ${cliente?.razon_social||''} | Liq. Producto`,
          }, arm.lineas).id;
          db.prepare('UPDATE sg_ven_liquidaciones SET asiento_id=? WHERE id=?').run(asientoId, liqId);
        }
      } catch(eA) {
        // TAMPOCO SE TRAGA UN ERROR DE crearAsiento. Un neto negativo --al
        // productor le descontaron más de lo que vendió-- o un asiento en cero
        // hacen fallar el escritor, y antes eso quedaba en la consola del
        // servidor mientras la liquidación se guardaba igual.
        console.error('[SG-VEN] Error asiento liq:', eA.message);
        throw new Error('No se pudo contabilizar: ' + eA.message + '. La liquidación NO se guardó.');
      }

      return { liqId, numero, asientoId };
    });

    const result = tx();
    res.json({ ok: true, id: result.liqId, numero: result.numero,
      asiento_id: result.asientoId });
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

router.get('/facturas', requireAuth, (req, res) => {
  try {
    const { sql, params } = buildFacturasQuery(req);
    const facs = db.prepare(sql).all(...params);
    for (const f of facs) {
      f.items = db.prepare('SELECT * FROM sg_ven_factura_items WHERE factura_id=? ORDER BY id').all(f.id);
    }
    res.json({ ok: true, data: facs });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══ LAS VENTAS QUE SE CAYERON DEL LIBRO ════════════════════════════
//
// El espejo de «Facturas cargadas sin contabilizar» de compras. Un comprobante
// emitido cuyo asiento se anuló --o que nunca llegó a tenerlo porque al modelo de
// venta le faltaba una cuenta-- es una venta que el cliente debe y que la
// contabilidad no sabe que existe. Hasta ahora no había ninguna pantalla que lo
// mostrara, así que se enteraba el que cerraba el mes.
//
// Ruta LITERAL: va antes que cualquier /facturas/:id.
router.get('/facturas-sin-asiento', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT f.id, f.numero, f.fecha, f.punto_venta, f.cbte_nro, f.total, f.estado,
             f.asiento_id, c.razon_social AS cliente,
             CASE WHEN f.asiento_id IS NULL THEN 'nunca se contabilizó'
                  ELSE 'su asiento se anuló' END AS por_que
        FROM sg_ven_facturas f
        LEFT JOIN sg_clientes c ON c.id = f.cliente_id
       WHERE COALESCE(f.estado,'') <> 'anulada'
         AND (f.asiento_id IS NULL
              OR EXISTS (SELECT 1 FROM sg_asientos a
                          WHERE a.id = f.asiento_id AND a.anulado = 1))
       ORDER BY f.fecha DESC, f.id DESC`).all();
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Y la vuelta: se le arma un asiento NUEVO con los importes del mismo
// comprobante. El anulado queda donde está --con su marca, su motivo y sus
// líneas--, que es la prueba de qué decía. Un asiento no se resucita: se rehace.
router.post('/facturas/:id(\\d+)/recontabilizar', requireAuth, (req, res) => {
  try {
    const u = req._user || req.user || {};
    const r = recontabilizarVenta(db, parseInt(req.params.id, 10), u.id || null);
    res.json({ ok: true, data: r });
  } catch (e) {
    // Son todos errores de lo que falta configurar o del estado del comprobante:
    // van con su texto, que es lo único que el usuario puede corregir.
    res.status(400).json({ ok: false, error: e.message });
  }
});

// GET /facturas/export.xlsx → genera el XLSX EN EL SERVIDOR (lib xlsx) respetando los mismos
// filtros que el listado. Columnas = las de la tabla del front. Ruta literal: NO choca con
// /facturas/:id/pdf (3 segmentos) ni /facturas/:id (handlers con :id).
router.get('/facturas/export.xlsx', requireAuth, (req, res) => {
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
      // El preview tiene que espejar lo que se graba, motivo incluido: si acá
      // dijera otro, el cuadro y el libro se leerían distinto.
      motivo: b.dif_motivo || b.motivo_gestion,
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
        neto, iva, total, descuento: difG, numero, motivo: difM });
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


const r2n = (x) => Math.round((Number(x) || 0) * 100) / 100;

// ══ A QUIÉN SE LE INFORMÓ LA FACTURA, PARA REUSARLO EN SU NOTA ═════════════
//
// Si la venta superó el umbral de la RG 5700/2025 y salió a consumidor final, hubo
// que pedirle el documento al comprador. Ese dato ahora queda guardado con el
// comprobante, así que la nota que lo corrige NO tiene que volver a pedirlo: el
// operador tendría que ir a buscar el papel de una venta de hace un mes.
//
// ARCA: 80 = CUIT, 86 = CUIL, 96 = DNI. El 99 es «sin identificar» y no es un
// documento: ahí no hay nada que reusar.
const DOC_TIPO_CLAVE = { 80: 'cuit', 86: 'cuil', 96: 'dni' };
function identificacionDe(f) {
  const t = (f && f.doc_tipo != null) ? Number(f.doc_tipo) : null;
  const clave = t != null ? DOC_TIPO_CLAVE[t] : null;
  if (!clave || !f.doc_nro) return null;
  return { tipo: clave, numero: String(f.doc_nro) };
}

// ══ QUÉ QUEDA POR ACREDITAR DE UN COMPROBANTE ══════════════════════════════
//
// Una nota de crédito puede ser PARCIAL —vuelven 300 de los 1.000 kg, o se corrige
// el precio de un renglón— y puede haber varias sobre la misma factura. Lo único que
// no puede pasar es que entre todas se le devuelva al cliente más de lo que compró:
// ahí la deuda queda a favor del cliente y el mayor de Deudores, acreedor.
//
// Así que la cuenta se lleva POR RENGLÓN: cuántas unidades y cuánta plata de cada uno
// ya se acreditaron. La atadura es `nc_de_item_id`, que cada renglón de nota escribe
// apuntando al renglón de la factura que corrige.
//
// Y de paso trae el renglón del REMITO del que salió (`despacho_item_id`), que es a
// dónde hay que devolverle los kilos. En los comprobantes viejos esa columna está en
// NULL: ahí se cae a la correspondencia POSICIONAL, que es como se emitieron —ítem y
// vínculo se empujan en la misma vuelta del for de postEmitir— y sólo si las dos
// listas tienen el mismo largo. Adivinar con largos distintos sería devolverle kilos
// al remito equivocado.
function baseDeNotaCredito(facturaId) {
  const f = db.prepare('SELECT * FROM sg_ven_facturas WHERE id=?').get(facturaId);
  const items = db.prepare('SELECT * FROM sg_ven_factura_items WHERE factura_id=? ORDER BY id')
    .all(facturaId);
  const puente = db.prepare(`SELECT despacho_id, despacho_item_id, kg, neto, iva, gestion
     FROM sg_factura_despachos WHERE factura_id=? ORDER BY rowid`).all(facturaId);
  const porDesp = new Map();
  for (const v of puente) if (v.despacho_item_id != null) porDesp.set(Number(v.despacho_item_id), v);
  const alineado = puente.length === items.length;

  // Lo ya acreditado, renglón por renglón, mirando sólo las notas que siguen en pie.
  //
  // LA PLATA SE CUENTA SIEMPRE; LOS KILOS, SÓLO SI VOLVIERON. Un ajuste de precio se
  // emite con la cantidad ENTERA del renglón —eso es lo que ARCA espera— pero la
  // mercadería sigue en la casa del cliente. Contarla como devuelta dejaba la
  // devolución de verdad bloqueada para siempre: "de este renglón ya volvió todo".
  const yaPorItem = new Map();
  for (const n of db.prepare(`SELECT ni.nc_de_item_id AS ref,
        SUM(CASE WHEN COALESCE(ni.nc_modo,'') = 'precio' THEN 0 ELSE ni.cantidad END) AS cant,
        SUM(ni.subtotal) AS neto
      FROM sg_ven_factura_items ni
      JOIN sg_ven_facturas nf ON nf.id = ni.factura_id
     WHERE nf.nc_de_factura_id = ? AND ${facturaCuenta('nf')} AND ${ES_NOTA_CREDITO('nf')}
       AND ni.nc_de_item_id IS NOT NULL
     GROUP BY ni.nc_de_item_id`).all(facturaId)) {
    yaPorItem.set(Number(n.ref), { cant: Number(n.cant) || 0, neto: r2n(n.neto) });
  }
  // Las notas VIEJAS —las que se emitieron por el total antes de que existiera el
  // puntero por renglón— no dicen a qué renglón corresponden. Se cuentan enteras
  // contra el comprobante, que es lo que eran.
  const sinRef = db.prepare(`SELECT COALESCE(SUM(nf.total),0) AS total,
        COALESCE(SUM(nf.dif_gestion),0) AS gestion
      FROM sg_ven_facturas nf
     WHERE nf.nc_de_factura_id = ? AND ${facturaCuenta('nf')} AND ${ES_NOTA_CREDITO('nf')}
       AND NOT EXISTS (SELECT 1 FROM sg_ven_factura_items ni
                        WHERE ni.factura_id = nf.id AND ni.nc_de_item_id IS NOT NULL)`)
    .get(facturaId);

  let netoTotal = 0, netoAcreditado = 0;
  const renglones = items.map((it, ix) => {
    const v = (it.despacho_item_id != null ? porDesp.get(Number(it.despacho_item_id)) : null)
      || (alineado ? puente[ix] : null);
    const ya = yaPorItem.get(Number(it.id)) || { cant: 0, neto: 0 };
    const cantidad = Number(it.cantidad) || 0;
    const neto = r2n(it.subtotal);
    netoTotal = r2n(netoTotal + neto);
    netoAcreditado = r2n(netoAcreditado + ya.neto);
    return {
      id: it.id, descripcion: it.descripcion, producto_id: it.producto_id,
      cantidad, neto, precio_unitario: Number(it.precio_unitario) || 0,
      alicuota: pctDeAlicuotaId(it.alicuota_id),
      bultos: it.bultos, kg_por_bulto: it.kg_por_bulto, unidad: it.unidad,
      despacho_id: v ? v.despacho_id : null,
      despacho_item_id: v ? v.despacho_item_id : (it.despacho_item_id != null ? Number(it.despacho_item_id) : null),
      kg_documentados: v ? Math.abs(Number(v.kg) || 0) : 0,
      gestion: v ? Math.abs(Number(v.gestion) || 0) : 0,
      // CERO NO ES LO MISMO QUE «NO SE SABE». Un renglón sin acuerdo tiene gestión 0
      // —es el caso normal— y un renglón viejo no tiene la columna. Si el que decide
      // mira el VALOR, devolver un renglón sin acuerdo se lleva gestión ajena.
      gestion_conocida: !!(v && v.gestion != null),
      // El IVA que ESE renglón le puso a la factura, tal como se emitió. Rehacerlo
      // desde el neto y la alícuota da distinto por centavos cuando el precio se
      // tipeó CON IVA (ahí el IVA salió por diferencia, no de multiplicar).
      iva_documentado: (v && v.iva != null) ? Math.abs(Number(v.iva)) : null,
      cantidad_acreditada: ya.cant, neto_acreditado: ya.neto,
      cantidad_pendiente: Math.max(0, +(cantidad - ya.cant).toFixed(6)),
      neto_pendiente: Math.max(0, r2n(neto - ya.neto)),
    };
  });
  // Lo que queda del comprobante entero: lo acordado (total + gestión) menos todo lo
  // que las notas —con puntero y sin él— ya devolvieron.
  const acordado = r2n((Number(f.total) || 0) + Math.abs(Number(f.dif_gestion) || 0));
  const devuelto = r2n(db.prepare(`SELECT COALESCE(SUM(nf.total + COALESCE(nf.dif_gestion,0)),0) AS t
      FROM sg_ven_facturas nf
     WHERE nf.nc_de_factura_id = ? AND ${facturaCuenta('nf')}
       AND ${ES_NOTA_CREDITO('nf')}`).get(facturaId).t);
  return { factura: f, renglones, alineado,
    neto_total: netoTotal, neto_acreditado: netoAcreditado,
    gestion_acreditada: r2n(db.prepare(`SELECT COALESCE(SUM(nf.dif_gestion),0) AS g
        FROM sg_ven_facturas nf
       WHERE nf.nc_de_factura_id = ? AND ${facturaCuenta('nf')}
         AND ${ES_NOTA_CREDITO('nf')}`).get(facturaId).g),
    acordado, acreditado: devuelto, pendiente: r2n(acordado - devuelto),
    notas_sin_renglon: r2n(sinRef.total) };
}

// Lo que la pantalla necesita para armar la nota: los renglones con lo que queda de
// cada uno. Es el MISMO cálculo que usa el POST — si fueran dos, un día la pantalla
// ofrecería devolver algo que el servidor rechaza.
router.get('/facturas/:id(\\d+)/nota-credito/base', requireAuth, (req, res) => {
  try {
    const b = baseDeNotaCredito(parseInt(req.params.id, 10));
    if (!b.factura) return res.status(404).json({ ok: false, error: 'Comprobante no encontrado' });
    res.json({ ok: true, data: {
      numero: (b.factura.punto_venta && b.factura.cbte_nro)
        ? String(b.factura.punto_venta).padStart(4, '0') + '-' + String(b.factura.cbte_nro).padStart(8, '0')
        : b.factura.numero,
      tipo: b.factura.tipo, total: b.factura.total,
      dif_gestion: Math.abs(Number(b.factura.dif_gestion) || 0),
      acordado: b.acordado, acreditado: b.acreditado, pendiente: b.pendiente,
      renglones: b.renglones, alineado: b.alineado,
      notas_sin_renglon: b.notas_sin_renglon,
    } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});


// ══ LA NOTA DE DÉBITO ══════════════════════════════════════════════════════
//
// Es el espejo de la nota de crédito, y por eso reusa casi todo: mismo motor, misma
// asociación al comprobante que corrige, mismo listado. Lo que cambia es el sentido.
//
//   · La de CRÉDITO le devuelve plata al cliente: baja su deuda, resta débito fiscal
//     y el asiento va invertido.
//   · La de DÉBITO le COBRA más —intereses por mora, un flete que no se había
//     facturado, gastos—: SUMA a su deuda, SUMA débito fiscal, y el asiento es el de
//     una venta común.
//
// LA MERCADERÍA NO SE MUEVE. No vuelven ni salen kilos: no se escribe una sola fila
// del puente con el remito. Es plata sobre una operación que ya pasó.
//
// Y NO SALE DE LOS RENGLONES DE LA FACTURA, que es la otra diferencia grande con la
// nota de crédito: una nota de débito es un CONCEPTO nuevo ("Intereses por mora,
// 30 días"), no una parte de lo que se vendió. Por eso el renglón va sin producto —
// el motor lo admite si dice qué es y con qué alícuota— y el comprobante va con
// Concepto 2 (Servicios) ante ARCA, que es lo que corresponde y lo que obliga a
// informar el período.
router.post('/facturas/:id(\\d+)/nota-debito', requireAuth, async (req, res) => {
  try {
    const u = req._user || req.user || {};
    const f = db.prepare('SELECT * FROM sg_ven_facturas WHERE id=?').get(parseInt(req.params.id, 10));
    if (!f) return res.status(404).json({ ok: false, error: 'Comprobante no encontrado' });
    if (esNotaDeCredito(f.cbte_tipo) || esNotaDeDebito(f.cbte_tipo)) {
      return res.status(400).json({ ok: false, error:
        'Esto ya es una nota. La nota de débito cuelga de una factura, no de otra nota.' });
    }
    if (String(f.estado || '') === 'anulada' || String(f.afip_estado || '') === 'rechazado') {
      return res.status(400).json({ ok: false, error:
        'Ese comprobante no está vivo: no hay nada que ajustar.' });
    }
    if (!f.punto_venta || !f.cbte_nro) {
      return res.status(400).json({ ok: false, error:
        'El comprobante no tiene número fiscal, así que no se lo puede asociar a una nota.' });
    }
    const motivo = String(req.body?.motivo || '').trim();
    if (motivo.length < 3) {
      return res.status(400).json({ ok: false, error:
        'Poné el motivo de la nota de débito: es lo que después explica el asiento.' });
    }
    // Los conceptos que se le cobran. Cada uno dice QUÉ es, cuánto y con qué alícuota:
    // sin producto no hay de dónde sacar la alícuota, así que se elige.
    const pedidos = Array.isArray(req.body?.items) ? req.body.items : [];
    const lineas = [];
    for (const p of pedidos) {
      const desc = String((p && p.descripcion) || '').trim();
      const neto = r2n(p && p.importe);
      const alic = (p && p.alicuota != null && p.alicuota !== '') ? Number(p.alicuota) : null;
      if (!desc || !(neto > 0.009)) continue;
      if (alic == null || isNaN(alic)) {
        return res.status(400).json({ ok: false, error:
          'El concepto "' + desc + '" no dice con qué alícuota de IVA va.' });
      }
      lineas.push({ producto_id: null, descripcion: desc, cantidad: 1, precio: neto,
        alicuota: alic, importe_neto: neto, importe_iva: r2n(neto * alic / 100) });
    }
    if (!lineas.length) {
      return res.status(400).json({ ok: false, error:
        'Poné al menos un concepto con su importe: una nota de débito por cero no existe.' });
    }

    const r = await afipEmitir(db, {
      ptoVta: Number(f.punto_venta), clienteId: f.cliente_id, items: lineas,
      // esNC es la CLASE, no un booleano: 'nd' pide los tipos 2 y 7.
      esNC: 'nd', userId: u.id || null,
      // SIN VÍNCULOS: la mercadería no se mueve. Escribir el puente haría figurar
      // kilos documentados que esta nota nunca documentó.
      vinculos: [],
      // Ni parte de gestión: lo que se le cobra de más está EN el comprobante.
      descuentoGestion: 0,
      identificacion: req.body?.identificacion || identificacionDe(f),
      // Servicios: intereses, fletes y gastos no son productos, y con este concepto
      // ARCA pide además el período, que el motor completa con la fecha del día.
      concepto: 2,
      asociado: { cbte_tipo: f.cbte_tipo, punto_venta: f.punto_venta, cbte_nro: f.cbte_nro,
        fecha: f.fecha },
      ncDeFacturaId: f.id, ncMotivo: motivo,
    });
    if (r.ok) r.pdf_url = '/api/sg/ventas/facturas/' + r.factura_id + '/pdf';
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ══ UN COMPROBANTE CON CAE NO SE ANULA: SE ACREDITA ═══════════════════════
//
// Hasta acá la única salida era «anular», que marcaba estado='anulada' y anulaba el
// asiento. Para un comprobante MANUAL está bien: no salió de ARCA y no existe para
// nadie más. Para uno con CAE es imposible: ARCA ya lo tiene, el cliente ya lo tiene
// y el número se declaró. Lo que corresponde es emitir una NOTA DE CRÉDITO, que es
// otro comprobante —con su propio número y su propio CAE— y dice cuánto de aquél se
// devuelve.
//
// La nota copia los renglones de su factura, sale por el MISMO punto de venta, va
// asociada a ella (CbtesAsoc) y arrastra tres cosas para atrás:
//   · el ASIENTO invertido —Deudores al haber: la deuda del cliente BAJA—,
//   · los KILOS del remito, que vuelven a figurar entregados sin comprobante y se
//     pueden volver a facturar,
//   · lo PENDIENTE de la factura, que deja de ofrecerse para cobrar.
router.post('/facturas/:id(\\d+)/nota-credito', requireAuth, async (req, res) => {
  try {
    const u = req._user || req.user || {};
    const f = db.prepare('SELECT * FROM sg_ven_facturas WHERE id=?').get(parseInt(req.params.id, 10));
    if (!f) return res.status(404).json({ ok: false, error: 'Comprobante no encontrado' });
    if (esNotaDeCredito(f.cbte_tipo) || esNotaDeDebito(f.cbte_tipo)) {
      return res.status(400).json({ ok: false, error:
        'Esto ya es una nota. No se le hace una nota de crédito a otra nota: la nota se '
        + 'anula, o se corrige la factura de la que cuelga.' });
    }
    if (String(f.estado || '') === 'anulada' || String(f.afip_estado || '') === 'rechazado') {
      return res.status(400).json({ ok: false, error:
        'Ese comprobante no está vivo: no hay nada que acreditar.' });
    }
    if (!f.punto_venta || !f.cbte_nro) {
      return res.status(400).json({ ok: false, error:
        'El comprobante no tiene número fiscal, así que no se lo puede asociar a una nota.' });
    }
    const motivo = String(req.body?.motivo || '').trim();
    if (motivo.length < 3) {
      return res.status(400).json({ ok: false, error:
        'Poné el motivo de la nota de crédito: es lo que después explica el asiento.' });
    }
    const modo = (String(req.body?.modo || '') === 'precio') ? 'precio' : 'devolucion';
    const base = baseDeNotaCredito(f.id);
    if (!base.renglones.length) {
      return res.status(400).json({ ok: false, error: 'El comprobante no tiene renglones' });
    }
    if (!(base.pendiente > 0.009)) {
      return res.status(400).json({ ok: false, error:
        'Ese comprobante ya está acreditado entero: no queda nada para devolver.' });
    }

    // ── QUÉ RENGLONES ENTRAN, Y POR CUÁNTO ────────────────────────────────
    // Sin lista, la nota es por TODO lo que queda: es el caso de siempre (la venta
    // se cayó entera) y no hay que hacerle elegir nada a nadie.
    const pedido = Array.isArray(req.body?.items) ? req.body.items : null;
    const porId = new Map(base.renglones.map((r) => [Number(r.id), r]));
    const elegidos = [];
    for (const p of (pedido || base.renglones.map((r) => ({ id: r.id })))) {
      const ren = porId.get(Number(p && p.id));
      if (!ren) return res.status(400).json({ ok: false, error:
        'Ese renglón no es de este comprobante: ' + (p && p.id) });
      if (elegidos.some((x) => x.ren.id === ren.id)) {
        return res.status(400).json({ ok: false, error:
          'El renglón "' + ren.descripcion + '" está dos veces en la nota.' });
      }
      if (modo === 'precio') {
        // AJUSTE DE PRECIO: la mercadería NO vuelve. Se acredita plata sobre los
        // mismos kilos, que siguen entregados y siguen documentados.
        const neto = (p && p.importe != null) ? r2n(p.importe) : ren.neto_pendiente;
        if (!(neto > 0.009)) continue;
        if (neto > ren.neto_pendiente + 0.009) {
          return res.status(400).json({ ok: false, error:
            'De "' + ren.descripcion + '" quedan $' + ren.neto_pendiente.toFixed(2)
            + ' por acreditar y estás pidiendo $' + neto.toFixed(2) + '.' });
        }
        elegidos.push({ ren, cantidad: ren.cantidad, neto, devuelveKg: false });
      } else {
        // DEVOLUCIÓN: vuelven kilos, y con ellos la parte de plata que les toca.
        const cant = (p && p.cantidad != null) ? Number(p.cantidad) : ren.cantidad_pendiente;
        if (!(cant > 0)) continue;
        if (cant > ren.cantidad_pendiente + 1e-6) {
          return res.status(400).json({ ok: false, error:
            'De "' + ren.descripcion + '" quedan ' + ren.cantidad_pendiente
            + ' sin acreditar y estás devolviendo ' + cant + '. '
            + 'Devolver más de lo que salió del depósito lo dejaría figurando como disponible.' });
        }
        // El neto sale de la PROPORCIÓN de kilos, salvo que vuelva el renglón
        // entero: ahí es el número exacto que se facturó, sin residuo de división.
        const entero = Math.abs(cant - ren.cantidad_pendiente) < 1e-6
          && Math.abs(ren.cantidad_pendiente - ren.cantidad) < 1e-6;
        const neto = entero ? ren.neto : r2n(ren.neto * (cant / ren.cantidad));
        if (!(neto > 0.009)) continue;
        elegidos.push({ ren, cantidad: cant, neto: Math.min(neto, ren.neto_pendiente),
          devuelveKg: true });
      }
    }
    if (!elegidos.length) {
      return res.status(400).json({ ok: false, error:
        'No elegiste nada para acreditar. Poné la cantidad o el importe de al menos un renglón.' });
    }

    // ── EL IVA DE CADA RENGLÓN ────────────────────────────────────────────
    // Sale del IVA que ESE renglón le puso a la factura, guardado en el puente
    // (`fd.iva`), por la parte que vuelve. Rehacerlo desde el neto y la alícuota da
    // distinto por centavos cuando el precio se tipeó CON IVA: ahí el IVA salió por
    // DIFERENCIA contra el bruto —no de multiplicar— y una nota por el total dejaba
    // un centavo pegado a la factura para siempre.
    // Sin puente (renglón viejo) se multiplica, que es lo único que hay.
    const ivaDe = (e) => {
      const doc = e.ren.iva_documentado;
      if (doc == null || !(e.ren.neto > 0)) return r2n(e.neto * e.ren.alicuota / 100);
      return r2n(doc * (e.neto / e.ren.neto));
    };

    // ── LOS RENGLONES DE LA NOTA ──────────────────────────────────────────
    const lineas = elegidos.map((e) => {
      const alic = e.ren.alicuota;
      if (alic == null) throw new Error('El renglón "' + e.ren.descripcion
        + '" quedó guardado con una alícuota que no se reconoce; no se puede rehacer la nota.');
      // A precio, la cantidad es la misma y lo que cambia es el unitario: es lo que
      // ARCA espera de una nota de ajuste, y deja el renglón legible en el papel.
      const precio = e.cantidad > 0 ? +(e.neto / e.cantidad).toFixed(6) : 0;
      const kpb = (e.ren.kg_por_bulto != null && Number(e.ren.kg_por_bulto) > 0)
        ? Number(e.ren.kg_por_bulto) : null;
      return { producto_id: e.ren.producto_id, cantidad: e.cantidad, precio, alicuota: alic,
        importe_neto: e.neto, importe_iva: ivaDe(e),
        bultos: kpb != null ? +(e.cantidad / kpb).toFixed(4) : null,
        kg_por_bulto: kpb,
        precio_por_bulto: kpb != null ? +(precio * kpb).toFixed(6) : null,
        unidad: e.ren.unidad, despacho_item_id: e.ren.despacho_item_id,
        nc_de_item_id: e.ren.id,
        // De qué tipo es este renglón de nota. Lo lee baseDeNotaCredito para no
        // contar como devueltos los kilos de un ajuste de precio.
        nc_modo: modo,
        descripcion: (modo === 'precio' ? 'Ajuste de precio — ' : '') + e.ren.descripcion };
    });

    // ── EL PUENTE: LA PLATA SIEMPRE, LOS KILOS SÓLO SI VUELVEN ────────────
    //
    // El puente factura↔despacho hace DOS cosas a la vez, y la nota de crédito las
    // separa: dice cuántos kilos de un remito tienen comprobante, y dice cuánta plata
    // le entró a esa partida —de ahí sale lo que se le liquida al productor—.
    //
    // Una DEVOLUCIÓN mueve las dos: vuelven los kilos y vuelve la plata.
    // Un AJUSTE DE PRECIO mueve sólo la plata: la mercadería está en la casa del
    // cliente y sigue documentada, pero se cobró menos. Por eso se escribe igual una
    // fila, con kg = 0: si no se escribiera ninguna, al productor se le liquidaría
    // sobre plata que ya se le devolvió al cliente.
    const vinculos = [];
    for (const e of elegidos) {
      if (e.ren.despacho_item_id == null || e.ren.despacho_id == null) continue;
      const prop = e.ren.neto > 0 ? (e.neto / e.ren.neto) : 0;
      vinculos.push({ despacho_id: e.ren.despacho_id, despacho_item_id: e.ren.despacho_item_id,
        // NUNCA MÁS KILOS DE LOS QUE ESA FACTURA DOCUMENTÓ. Si se pasara, el
        // pendiente del remito quedaría por encima de lo despachado y se podría
        // facturar mercadería que nunca salió del depósito.
        kg: e.devuelveKg ? Math.min(e.cantidad, e.ren.kg_documentados) : 0,
        neto: e.neto, iva: ivaDe(e),
        gestion: r2n(e.ren.gestion * prop) });
    }

    // ── LA PARTE DE GESTIÓN QUE VUELVE ────────────────────────────────────
    // Sale de la columna `gestion` de CADA renglón del puente, que es lo que se
    // resignó en ESE renglón — no de un prorrateo del total de la factura.
    //
    // Y el que decide es si la columna EXISTE, no si vale cero: un renglón sin
    // acuerdo tiene gestión 0 y es el caso normal. Mirando el valor, devolver un
    // renglón sin acuerdo se llevaba gestión del renglón de al lado, que el cliente
    // sigue teniendo. Sólo se prorratea cuando NINGUNO de los renglones elegidos
    // tiene la columna — comprobantes anteriores a que se guardara.
    const conocidos = elegidos.filter((e) => e.ren.gestion_conocida).length;
    const gesRenglones = r2n(vinculos.reduce((a, v) => a + (Number(v.gestion) || 0), 0));
    const netoNota = r2n(elegidos.reduce((a, e) => a + e.neto, 0));
    const difFactura = Math.abs(Number(f.dif_gestion) || 0);
    const tope = r2n(difFactura - base.gestion_acreditada);
    const gestionNota = conocidos > 0
      ? Math.min(gesRenglones, tope)
      : (base.neto_total > 0
          ? Math.min(r2n(difFactura * (netoNota / base.neto_total)), tope)
          : 0);

    const r = await afipEmitir(db, {
      ptoVta: Number(f.punto_venta), clienteId: f.cliente_id, items: lineas,
      esNC: true, userId: u.id || null, vinculos,
      // La parte de GESTIÓN también vuelve: si la venta se resignó 30.000 por un
      // acuerdo, la devolución los devuelve. Dejarla afuera haría que la deuda de
      // gestión sobreviviera a una venta que ya no existe.
      descuentoGestion: Math.max(0, gestionNota),
      identificacion: req.body?.identificacion || identificacionDe(f),
      asociado: { cbte_tipo: f.cbte_tipo, punto_venta: f.punto_venta, cbte_nro: f.cbte_nro,
        fecha: f.fecha },
      ncDeFacturaId: f.id, ncMotivo: motivo,
    });
    if (r.ok) r.pdf_url = '/api/sg/ventas/facturas/' + r.factura_id + '/pdf';
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.patch('/facturas/:id/anular', requireAuth, (req, res) => {
  try {
    const f = db.prepare('SELECT * FROM sg_ven_facturas WHERE id=?').get(req.params.id);
    if (!f) return res.status(404).json({ ok: false, error: 'No encontrada' });
    if (f.estado === 'anulada') return res.json({ ok: true });
    // ── LO QUE TIENE CAE NO SE BORRA ────────────────────────────────────
    // Marcarlo 'anulada' acá lo sacaba de la cuenta corriente y del libro de este
    // sistema, y ARCA seguía teniéndolo igual: los dos libros dejaban de decir lo
    // mismo y no quedaba rastro de la diferencia. La salida es la nota de crédito.
    if (f.cae && !esNotaDeCredito(f.cbte_tipo)) {
      return res.status(400).json({ ok: false, error:
        'Ese comprobante tiene CAE: ARCA ya lo tiene y no se puede borrar de acá. '
        + 'Para dejarlo sin efecto hacele una NOTA DE CRÉDITO.' });
    }
    if (f.asiento_id) db.prepare("UPDATE sg_asientos SET anulado=1 WHERE id=?").run(f.asiento_id);
    db.prepare("UPDATE sg_ven_facturas SET estado='anulada' WHERE id=?").run(f.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PDF del comprobante fiscal AFIP (RG 1415 + QR ARCA). Solo si AFIP lo autorizó (tiene CAE).
router.get('/facturas/:id/pdf', requireAuth, async (req, res) => {
  try {
    const f = db.prepare(`SELECT f.*, c.razon_social, c.cuit, c.categoria_fiscal,
        c.direccion_entrega, c.localidad, c.provincia,
        (SELECT printf('%04d-%08d', o.punto_venta, o.cbte_nro) FROM sg_ven_facturas o
          WHERE o.id = f.nc_de_factura_id) AS asociado_numero
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
// ══ QUÉ SE LE VENDIÓ EN ESE COMPROBANTE ════════════════════════════════
//
// Pablo, 25/8/2026: "haciendo click en cada renglón que me muestre el detalle de
// lo que se vendió, precio, partida, etc."
//
// La cuenta corriente decía cuánto debe y de qué comprobante, y ahí se terminaba:
// para saber QUÉ tenía adentro la factura había que salir a otra pantalla y
// buscarla por número. Discutir un saldo con el cliente enfrente así no se puede.
//
// Dos niveles, porque son dos preguntas distintas: los RENGLONES son lo que dice
// el papel —lo que el cliente ve—, y las PARTIDAS son de qué lote salió cada kilo,
// con el proveedor y lo que se resignó. La segunda es la que contesta "¿por qué
// este precio?" y la que ata la venta con la liquidación al productor.
router.get('/facturas/:id/detalle', requireAuth, (req, res) => {
  try {
    const f = db.prepare(`SELECT f.id, f.numero, f.fecha, f.total, f.neto, f.iva, f.estado,
        f.afip_estado, f.cae, f.punto_venta, f.cbte_tipo, f.cbte_nro,
        COALESCE(f.dif_gestion,0) AS dif_gestion, f.dif_motivo,
        c.razon_social AS cliente
      FROM sg_ven_facturas f LEFT JOIN sg_clientes c ON c.id=f.cliente_id
      WHERE f.id=?`).get(req.params.id);
    if (!f) return res.status(404).json({ ok: false, error: 'Comprobante no encontrado' });
    // Los renglones tal como salieron impresos.
    const items = db.prepare(`SELECT descripcion, cantidad, precio_unitario, subtotal,
        alicuota_id, bultos, kg_por_bulto, precio_por_bulto, unidad
      FROM sg_ven_factura_items WHERE factura_id=? ORDER BY id`).all(f.id);
    // Y de qué partida salió cada kilo. sg_factura_despachos es el puente, y ahí
    // están además el neto, el IVA y lo resignado DE ESE RENGLÓN — que es de donde
    // sale la liquidación del productor.
    const partidas = db.prepare(`SELECT fd.kg, fd.neto, fd.iva, fd.gestion,
        l.codigo_lote, pr.nombre AS producto, pr.variedad,
        di.precio_por_kg, di.precio_lista_por_kg,
        COALESCE(di.kg_por_bulto, ps.factor_conversion) AS kg_por_bulto,
        d.numero AS remito, prov.razon_social AS proveedor
      FROM sg_factura_despachos fd
      LEFT JOIN sg_despacho_items di ON di.id = fd.despacho_item_id
      LEFT JOIN sg_despachos d ON d.id = fd.despacho_id
      LEFT JOIN sg_lotes l ON l.id = di.lote_id
      LEFT JOIN sg_productos pr ON pr.id = di.producto_id
      LEFT JOIN sg_presentaciones ps ON ps.id = di.presentacion_id
      LEFT JOIN sg_recepciones rec ON rec.id = l.recepcion_id
      LEFT JOIN sg_oc o ON o.id = rec.oc_id
      LEFT JOIN sg_proveedores prov ON prov.id = o.proveedor_id
      WHERE fd.factura_id = ? ORDER BY fd.id`).all(f.id);
    // Y qué se le cobró contra este comprobante, que es la otra mitad de la
    // pregunta cuando se está discutiendo un saldo.
    const cobros = db.prepare(`SELECT co.id, co.fecha, co.forma_pago, co.referencia,
        cd.monto, COALESCE(cd.monto_gestion,0) AS monto_gestion
      FROM sg_ven_cobranza_docs cd JOIN sg_ven_cobranzas co ON co.id = cd.cobranza_id
      WHERE cd.tipo='factura' AND cd.doc_id = ? AND co.anulada = 0
      ORDER BY co.fecha, co.id`).all(f.id);
    res.json({ ok: true, data: { doc: f, items, partidas, cobros } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/facturas/:id/envios', requireAuth, (req, res) => {
  try {
    res.json({ ok: true, data: db.prepare(`SELECT e.*, u.nombre AS usuario
      FROM sg_ven_envios e LEFT JOIN usuarios u ON u.id = e.usuario_id
      WHERE e.factura_id = ? ORDER BY e.id DESC`).all(req.params.id) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CUENTA CORRIENTE CLIENTES
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/cc/:clienteId', requireAuth, (req, res) => {
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
        -- ABIERTO POR MITAD. La pantalla de cobro necesita saber cuánto queda de
        -- lo facturado y cuánto de lo que no lleva comprobante: son dos libros
        -- distintos y el asiento del cobro cae en uno o en el otro.
        l.neto_acreditar - COALESCE((SELECT SUM(cd.monto - COALESCE(cd.monto_gestion,0))
            FROM sg_ven_cobranza_docs cd JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
           WHERE cd.tipo='liquidacion' AND cd.doc_id=l.id AND co.anulada=0), 0) as pendiente_fiscal,
        COALESCE(l.dif_gestion,0) - COALESCE((SELECT SUM(COALESCE(cd.monto_gestion,0))
            FROM sg_ven_cobranza_docs cd JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
           WHERE cd.tipo='liquidacion' AND cd.doc_id=l.id AND co.anulada=0), 0) as pendiente_gestion,
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
        -- ── LO QUE LA NOTA DE CRÉDITO YA DEVOLVIÓ NO SE COBRA ─────────────
        -- Una factura acreditada entera seguía figurando con todo su pendiente y
        -- se la podía tildar para cobrar: se le reclamaba al cliente algo que ya
        -- se le había devuelto.
        ${ncAplicadas('f')} AS acreditado,
        f.total + COALESCE(f.dif_gestion,0) - ${ncAplicadas('f')}
          - COALESCE((SELECT SUM(cd.monto) FROM sg_ven_cobranza_docs cd
          JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
          WHERE cd.tipo='factura' AND cd.doc_id=f.id AND co.anulada=0), 0) as pendiente,
        -- ABIERTO POR MITAD. La pantalla de cobro necesita saber cuánto queda de
        -- lo facturado y cuánto de lo que no lleva comprobante: son dos libros
        -- distintos y el asiento del cobro cae en uno o en el otro.
        f.total - ${ncAplicadasFiscal('f')}
          - COALESCE((SELECT SUM(cd.monto - COALESCE(cd.monto_gestion,0))
            FROM sg_ven_cobranza_docs cd JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
           WHERE cd.tipo='factura' AND cd.doc_id=f.id AND co.anulada=0), 0) as pendiente_fiscal,
        COALESCE(f.dif_gestion,0) - ${ncAplicadasGestion('f')}
          - COALESCE((SELECT SUM(COALESCE(cd.monto_gestion,0))
            FROM sg_ven_cobranza_docs cd JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
           WHERE cd.tipo='factura' AND cd.doc_id=f.id AND co.anulada=0), 0) as pendiente_gestion,
        'factura' as tipo_doc
      -- MISMA REGLA QUE EL LISTADO: una factura RECHAZADA por AFIP no es deuda.
      -- Acá estaba escrita a mano y por eso una rechazada figuraba en la ficha como
      -- documento vivo, con su pendiente, y se la podía tildar para cobrarla — contra
      -- una deuda que nunca subió al libro, porque sin autorización no hay asiento.
      -- LA NOTA DE CRÉDITO NO ES UN DOCUMENTO A COBRAR. Vive en esta misma tabla,
      -- así que sin este filtro aparecía como un renglón más con su pendiente en
      -- POSITIVO: algo para ir a cobrarle al cliente. Lo que hace la nota es bajar
      -- lo pendiente de la factura que corrige, arriba.
      FROM sg_ven_facturas f
       WHERE f.cliente_id=? AND ${facturaCuenta('f')} AND ${noEsNotaDeCredito('f')}
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
  // afip_estado sólo existe en las facturas: una liquidación la emite el cliente y
  // no pasa por AFIP. Se pide sólo donde está, para no romper la consulta.
  const colAfip = tipo === 'liquidacion' ? "'' AS afip_estado" : 'afip_estado';
  const d = db.prepare(`SELECT id, numero, cliente_id, estado, ${colAfip}, ${campo} AS total,
      COALESCE(dif_gestion,0) AS dif_gestion, dif_motivo FROM ${tabla} WHERE id=?`)
    .get(docId);
  if (!d) return null;
  const c = db.prepare(`SELECT COALESCE(SUM(cd.monto),0) t,
      COALESCE(SUM(cd.monto_gestion),0) g FROM sg_ven_cobranza_docs cd
    JOIN sg_ven_cobranzas co ON co.id = cd.cobranza_id
    WHERE cd.tipo=? AND cd.doc_id=? AND co.anulada=0`).get(tipo, docId);
  const cob = c.t, cobGes = c.g || 0;
  // ── Y LO QUE LA NOTA DE CRÉDITO YA DEVOLVIÓ NO SE COBRA ────────────────
  // Una factura acreditada —entera o en parte— seguía ofreciéndose para imputar un
  // cobro por todo su importe: se le reclamaba al cliente algo que ya se le había
  // devuelto, y la plata quedaba pegada a un comprobante que no debía eso.
  // Las liquidaciones no tienen notas de crédito: son del cliente, no nuestras.
  const nc = (tipo === 'factura')
    ? db.prepare(`SELECT COALESCE(SUM(n.total),0) AS fiscal,
           COALESCE(SUM(n.dif_gestion),0) AS gestion
        FROM sg_ven_facturas n
       WHERE n.nc_de_factura_id = ? AND ${facturaCuenta('n')}
         AND ${ES_NOTA_CREDITO('n')}`).get(docId)
    : { fiscal: 0, gestion: 0 };
  // LO QUE EL CLIENTE DEBE ES LO ACORDADO, no lo facturado: el total del
  // comprobante más lo que quedó sin facturar. Es el espejo exacto de lo que se
  // le debe a un proveedor cuando su factura vino corta.
  const r2c = (n2) => Math.round((Number(n2) || 0) * 100) / 100;
  const acordado = r2c((d.total || 0) + (d.dif_gestion || 0)
    - (Number(nc.fiscal) || 0) - (Number(nc.gestion) || 0));
  // Y ABIERTO POR MITAD, porque de eso depende en qué libro cae el asiento del
  // cobro: lo que se cobra de la parte sin comprobante no puede aparecer en el
  // fiscal, donde esa deuda nunca subió.
  const pendFis = r2c((d.total || 0) - (Number(nc.fiscal) || 0) - (cob - cobGes));
  const pendGes = r2c((d.dif_gestion || 0) - (Number(nc.gestion) || 0) - cobGes);
  return { ...d, total: acordado, total_fiscal: d.total || 0, cobrado: cob,
    cobrado_gestion: cobGes,
    pendiente_fiscal: pendFis, pendiente_gestion: pendGes,
    pendiente: r2c(acordado - cob) };
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
  // CONTRA QUÉ SE COBRA. Igual que en el pago a proveedores: lo facturado, lo que
  // quedó sin comprobante, o las dos en proporción --que es la única regla que no
  // depende del orden en que se hayan cargado los comprobantes--.
  const ambitoCobro = ['fiscal', 'gestion'].includes(String(req.body?.ambito || ''))
    ? String(req.body.ambito) : 'todo';
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
    // ── NI CONTRA UNA QUE AFIP RECHAZÓ ────────────────────────────────────
    // Una factura rechazada no tiene asiento —asentarVenta sólo corre con el
    // resultado 'A'—, así que esa deuda nunca subió al libro. Cobrar contra ella
    // acredita la cuenta corriente del cliente por algo que nadie debía y deja el
    // mayor del cliente acreedor. El pago a proveedores ya tiene el freno
    // equivalente y lo dice con todas las letras: "todavía no está contabilizada,
    // no es deuda registrada".
    if (String(doc.afip_estado || '') === 'rechazado') {
      return res.status(400).json({ ok: false,
        error: `AFIP rechazó el comprobante ${doc.numero}: no está contabilizado y no es deuda `
             + `registrada. Volvé a emitirlo desde Remitos pendientes de comprobante.` });
    }
    // EL TOPE ES EL DE LA MITAD QUE SE ESTÁ COBRANDO. Con «sólo lo facturado» no
    // se puede imputar contra la parte que no lleva comprobante, y al revés.
    const tope = ambitoCobro === 'fiscal' ? doc.pendiente_fiscal
      : (ambitoCobro === 'gestion' ? doc.pendiente_gestion : doc.pendiente);
    if (d.monto > tope + 0.01) {
      return res.status(400).json({ ok: false,
        error: `Al comprobante ${doc.numero} le quedan ${tope}`
             + (ambitoCobro === 'fiscal' ? ' facturados'
                : (ambitoCobro === 'gestion' ? ' sin facturar' : ''))
             + ` y le estás imputando ${d.monto}.` });
    }
    // Cuánto de esto va contra la parte SIN comprobante. Nunca negativo: si el
    // comprobante salió por más de lo acordado, esa mitad no se cancela cobrando.
    const crudo = ambitoCobro === 'gestion' ? d.monto
      : (ambitoCobro === 'fiscal' ? 0
         : (doc.pendiente > 0 ? Math.round(d.monto * doc.pendiente_gestion / doc.pendiente * 100) / 100 : 0));
    d.gestion = crudo > 0 ? crudo : 0;
    d.motivo = doc.dif_motivo || null;
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
  // ══ VARIOS MEDIOS EN UNA MISMA COBRANZA ════════════════════════════
  //
  // Pablo, 25/8/2026: parte en efectivo y parte en transferencia, "como funciona hoy
  // el pago a proveedores". Y así se hace: UNA cobranza, UN asiento, y un renglón
  // por cada medio. Partirlo en dos cobranzas dejaría dos números para lo que el
  // cliente vivió como un solo pago.
  //
  // El payload viejo —forma_pago + cuenta_fin_id + cheque sueltos— sigue andando: se
  // normaliza a una lista de un elemento y de ahí para abajo hay un solo camino. Dos
  // caminos serían dos lugares donde arreglar el próximo bug.
  const mediosRaw = Array.isArray(req.body?.medios) && req.body.medios.length
    ? req.body.medios
    : [{ forma_pago: forma_pago || 'transferencia', cuenta_fin_id: req.body?.cuenta_fin_id,
         referencia: referencia || null, cheque: req.body?.cheque || null, monto: total }];
  // Cada medio, validado. El que no cierra corta acá: mejor un error antes de
  // escribir nada que una cobranza a medias.
  const medios = [];
  let ctaCartera = null;
  for (const m of mediosRaw) {
    const forma = String(m.forma_pago || 'transferencia');
    // CONTRA QUÉ MITAD VA ESTE MEDIO. Vacío = «lo que toque», que es el reparto
    // proporcional de siempre: así el que no lo declara —la venta de ventanilla, el
    // payload viejo— sigue funcionando igual.
    const ambM = ['fiscal', 'gestion'].includes(String(m.ambito || '')) ? String(m.ambito) : null;
    const monto = (mediosRaw.length === 1 && !(Math.round(parseFloat(m.monto || 0) * 100) / 100 > 0))
      ? total : Math.round(parseFloat(m.monto || 0) * 100) / 100;
    if (!(monto > 0)) return res.status(400).json({ ok: false, error: 'Cada medio de cobro necesita un monto' });

    if (forma === 'cheque') {
      // EL CHEQUE ENTRA A LA CARTERA, no a una cuenta: el banco todavía no recibió
      // nada. La cuenta contable de la cartera se pide una sola vez.
      if (!ctaCartera) {
        ctaCartera = (db.prepare("SELECT cuenta_id FROM sg_config_impositiva WHERE clave='cheques_cartera'")
          .get() || {}).cuenta_id || null;
        if (!ctaCartera) {
          return res.status(400).json({ ok: false,
            error: 'Falta decir contra qué cuenta contable van los cheques en cartera. Configurala en el '
                 + 'plan de cuentas (clave "cheques_cartera") antes de cobrar con cheque.' });
        }
      }
      const ch = m.cheque || {};
      const nro = String(ch.nro_cheque || '').trim();
      const librador = String(ch.librador || '').trim();
      if (!nro || !librador) {
        return res.status(400).json({ ok: false,
          error: 'De un cheque hay que anotar por lo menos el número y quién lo firma.' });
      }
      // EL MISMO CHEQUE NO ENTRA DOS VECES. La identidad es banco + número +
      // librador, que es lo que está impreso en el papel. Se mira también contra los
      // otros medios de ESTA cobranza: dos veces el mismo papel en el mismo cobro.
      const banco = String(ch.banco || '').trim() || null;
      const ya = db.prepare(`SELECT id, estado, monto FROM sg_fin_cheques_terceros
        WHERE COALESCE(banco,'')=COALESCE(?,'') AND nro_cheque=? AND librador=?`)
        .get(banco, nro, librador);
      const repe = medios.some((x) => x.cheque && x.cheque.nro === nro && x.cheque.librador === librador
        && (x.cheque.banco || '') === (banco || ''));
      if (ya || repe) {
        return res.status(400).json({ ok: false,
          error: `Ese cheque ya está${ya ? ' en la cartera' : ' en esta misma cobranza'}: `
               + `N° ${nro} de ${librador}${ya ? ` por ${ya.monto} (${ya.estado})` : ''}.` });
      }
      medios.push({ forma, monto, ambito: ambM, cuenta: null, referencia: m.referencia || referencia || null,
        cheque: { banco, nro, librador, fecha_vto: ch.fecha_vto || null,
          cuit: String(ch.cuit_librador || '').replace(/[^0-9]/g, '') || null } });
      continue;
    }

    // LA PLATA ENTRA A ALGÚN LADO, y ese lado tiene que tener cuenta contable: sin
    // ella el asiento no se puede armar.
    // El id se limpia ANTES de la consulta: better-sqlite3 tira una excepción si le
    // pasan undefined, así que sin este paso "no elegí la cuenta" salía como un
    // error 500 del servidor en vez de decir qué falta.
    const ctaFinId = parseInt(m.cuenta_fin_id, 10);
    const cuenta = Number.isInteger(ctaFinId)
      ? db.prepare(`SELECT c.*, cc.id AS cta FROM sg_fin_cuentas c
          LEFT JOIN sg_cuentas cc ON cc.id = c.cuenta_contable_id
          WHERE c.id=? AND c.activo=1`).get(ctaFinId)
      : null;
    if (!cuenta) return res.status(400).json({ ok: false, error: 'Elegí en qué cuenta entra la plata' });
    if (!cuenta.cta) {
      return res.status(400).json({ ok: false,
        error: `La cuenta "${cuenta.nombre}" no tiene cuenta contable asociada, así que la cobranza no `
             + `puede entrar al libro. Asignásela en Caja y Bancos.` });
    }
    // ── LA CAJA TIENE DUEÑO ───────────────────────────────────────────────
    // UNA sola regla en todo el sistema: si la cuenta tiene gente asignada la
    // tocan sólo ellos; si no tiene a nadie, la toca cualquiera con permiso en el
    // módulo. El pago a proveedores la aplica desde siempre (sg.js:9555) y el
    // cobro no: el front escondía las cuentas ajenas, pero eso es cortesía del
    // front — el servidor aceptaba cualquier cuenta_fin_id que le mandaran, así
    // que se podía meter plata en la caja de otro escribiendo el número.
    if (!puedeMoverCuenta(u, cuenta.id)) {
      return res.status(403).json({ ok: false,
        error: `La cuenta "${cuenta.nombre}" la maneja otra persona. Elegí una tuya, o pedile a un `
             + `administrador que te asigne ésa en Caja y Bancos.` });
    }
    medios.push({ forma, monto, ambito: ambM, cuenta, referencia: m.referencia || referencia || null, cheque: null });
  }
  // LOS MEDIOS TIENEN QUE DAR EL TOTAL. Si no, la diferencia se la come el asiento y
  // el arqueo de la caja deja de dar. Es el mismo control que el pago a proveedores.
  const sumaMedios = Math.round(medios.reduce((a, m) => a + m.monto, 0) * 100) / 100;
  if (Math.abs(sumaMedios - total) > 0.009) {
    return res.status(400).json({ ok: false,
      error: `Los medios de cobro suman ${sumaMedios} y la cobranza es de ${total}.` });
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
      // La cabecera guarda el medio PRINCIPAL —el de mayor monto— para que el
      // listado diga algo útil de un vistazo. El detalle real son los medios.
      const principal = medios.slice().sort((a, b) => b.monto - a.monto)[0];
      cobId = db.prepare(`INSERT INTO sg_ven_cobranzas
        (fecha, cliente_id, monto, forma_pago, referencia, notas, usuario_id, cuenta_fin_id)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(f, cli.id, total,
             medios.length > 1 ? 'varios' : principal.forma,
             referencia || null, notas || null, u.id,
             principal.cheque ? null : principal.cuenta.id).lastInsertRowid;

      // EL CHEQUE ENTRA A LA CARTERA, que vive en Caja y Bancos. Desde ahí se lo
      // sigue: qué hay, qué vence, y el día que se deposita entra la plata de
      // verdad al banco. Queda con el cliente del que vino, que no siempre es
      // quien firmó el papel: muchas veces al cliente le pagaron con ese cheque.
      let primerCheque = null;
      for (const m of medios) {
        if (!m.cheque) continue;
        // DE QUÉ COBRANZA VINO, en una columna y no en una nota. Atarlos por el
        // texto 'Cobranza #123' no se puede consultar, y por eso al anular sólo
        // volvía el primero a la cartera.
        //
        // El ÁMBITO no se sabe todavía: el reparto entre las dos mitades corre más
        // abajo. Se escribe después, con un UPDATE, cuando ya está resuelto.
        const chId = db.prepare(`INSERT INTO sg_fin_cheques_terceros
          (banco, nro_cheque, librador, monto, fecha_recepcion, fecha_vto, cliente_id, notas, cuit_librador,
           cobranza_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(m.cheque.banco, m.cheque.nro, m.cheque.librador, m.monto,
          f, m.cheque.fecha_vto, cli.id,
          'Cobranza ' + (referencia || '#' + cobId), m.cheque.cuit, cobId).lastInsertRowid;
        m._chId = chId;
        if (primerCheque == null) primerCheque = chId;
      }
      // La columna de la cabecera es una sola y los cheques pueden ser varios: queda
      // el primero, para no romper lo que ya la lee. La vuelta atrás NO usa ésta:
      // usa cobranza_id, que los tiene a todos.
      if (primerCheque != null) {
        db.prepare('UPDATE sg_ven_cobranzas SET cheque_terceros_id=? WHERE id=?').run(primerCheque, cobId);
      }

      const insDoc = db.prepare(`INSERT INTO sg_ven_cobranza_docs
        (cobranza_id, tipo, doc_id, monto, monto_gestion) VALUES (?,?,?,?,?)`);
      for (const d of lista) {
        insDoc.run(cobId, d.tipo, d.doc_id, d.monto, d.gestion || 0);
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
      // ── Y CADA MITAD EN SU LIBRO ─────────────────────────────
      // Un cobro que cancela la parte SIN comprobante no puede aparecer en el
      // libro fiscal: ahí esa deuda nunca subió, así que la cuenta corriente del
      // cliente bajaría por algo que nunca entró --y podía quedar acreedor--. Va
      // marcado como gestión, y el asiento cierra dos veces, una por mitad.
      //
      // Lo que se cobra a cuenta --sin imputar a ningún comprobante-- es fiscal
      // salvo que se haya elegido expresamente cobrar lo de gestión.
      const gesTotal = Math.round(lista.reduce((a, d) => a + (d.gestion || 0), 0) * 100) / 100;
      const aCuenta = Math.round((total - imputado) * 100) / 100;
      let ges = gesTotal;
      if (aCuenta > 0 && ambitoCobro === 'gestion') ges = Math.round((ges + aCuenta) * 100) / 100;
      if (ges > total) ges = total;
      if (ges < 0) ges = 0;
      const motivoGes = (lista.find((d) => (d.gestion || 0) > 0 && d.motivo) || {}).motivo
        || 'ajuste_gestion';
      // ── EL ASIENTO: UN RENGLÓN POR MEDIO Y POR ÁMBITO ────────────────
      // La parte de gestión se reparte entre los medios EN PROPORCIÓN, y el resto de
      // redondeo se acumula en el último: si no, la suma de las partes no da el
      // total y falta o sobra un centavo que después nadie encuentra. Es el mismo
      // criterio que usa el reparto del neto de una factura entre varias partidas.
      const r2c2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
      const lineasCob = [];

      // ── LO QUE CADA MEDIO DECLARÓ MANDA; EL RESTO SE PRORRATEA ──────
      //
      // Un medio que dice «gestión» cancela SÓLO la parte sin comprobante, y uno que
      // dice «fiscal» sólo lo facturado. Los que no dicen nada se reparten lo que
      // quedó, en proporción, como se hacía antes con todos — así la venta de
      // ventanilla y el payload viejo, que no lo declaran, siguen funcionando igual.
      //
      // La cuenta vive en servicios/sg_cobro_ambito.js: es aritmética de plata, y un
      // centavo perdido en el reparto es un asiento que no balancea. Ahí se prueba
      // corriéndola. Si lo declarado no entra, tira ACÁ, antes de escribir nada.
      const gesPorMedio = repartirAmbito(medios, ges, total);
      medios.forEach((m, ix) => {
        const gesM = gesPorMedio[ix];
        const partesM = partesDeMedio(m.monto, gesM, motivoGes);
        m._partes = partesM;
        // ── EL CHEQUE SE LLEVA SU MITAD PUESTA ──────────────────────────
        // Hace falta al depositarlo: sin esto el depósito escribía el movimiento y
        // el asiento sin ámbito —o sea fiscal— y un cheque que cobró la parte SIN
        // comprobante volvía al libro fiscal. Quedaba un débito de gestión en
        // cartera que no se cancelaba nunca.
        //
        // Sólo se marca cuando el cheque es ENTERO de una mitad. Si cubre las dos
        // —pasa cuando nadie declaró el ámbito y hay parte de gestión— se deja en
        // blanco: partir un cheque al depositarlo es otro problema, y poner una de
        // las dos sería elegir por el que cobra.
        if (m._chId && partesM.length === 1) {
          db.prepare('UPDATE sg_fin_cheques_terceros SET ambito=?, motivo=? WHERE id=?')
            .run(partesM[0].ambito, partesM[0].motivo || null, m._chId);
        }
        for (const x of partesM) {
          lineasCob.push({ cuenta_id: m.cheque ? ctaCartera : m.cuenta.cta, debe: x.monto, haber: 0,
            ambito: x.ambito, motivo: x.motivo,
            descripcion: m.cheque ? ('Cheque N° ' + m.cheque.nro + ' en cartera') : m.cuenta.nombre });
          lineasCob.push({ cuenta_id: cli.cuenta_contable_id, debe: 0, haber: x.monto,
            ambito: x.ambito, motivo: x.motivo, descripcion: cli.razon_social });
        }
      });
      asientoId = crearAsiento(db, {
        fecha: f, usuario_id: u.id, ref_codigo: referencia || null,
        descripcion: 'Cobranza de ' + cli.razon_social + (referencia ? ' — ' + referencia : '')
          + (lista.length ? ' — ' + lista.length + ' comprobante(s)' : ' (a cuenta)')
          + (medios.length > 1 ? ' — ' + medios.length + ' medios' : ''),
      }, lineasCob).id;
      db.prepare('UPDATE sg_ven_cobranzas SET asiento_id=? WHERE id=?').run(asientoId, cobId);

      // ── Y LA CUENTA SUBE ──────────────────────────────────────────────
      // El saldo de Caja y Bancos se calcula con los movimientos, no con el
      // libro: sin esto la plata entraba y el banco seguía igual.
      //
      // Con CHEQUE no se mueve ninguna cuenta: el banco todavía no recibió nada.
      // El movimiento lo hace el depósito, desde la cartera.
      // Y EL MOVIMIENTO TAMBIÉN SE PARTE, para que el arqueo fiscal no se lleve
      // lo que entró por la parte sin comprobante.
      const insMovC = db.prepare(`INSERT INTO sg_fin_movimientos
        (cuenta_id, fecha, tipo, concepto, monto, referencia, usuario_id, ambito, motivo)
        VALUES (?,?, 'ingreso', ?,?,?,?,?,?)`);
      for (const m of medios) {
        if (m.cheque) continue;
        for (const x of m._partes) {
          insMovC.run(m.cuenta.id, f, 'Cobranza de ' + cli.razon_social, x.monto,
            'COB-' + cobId, u.id, x.ambito, x.motivo);
        }
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
      // TODOS los cheques de esta cobranza, no sólo el de la cabecera. Esa columna
      // guarda UNO y los cheques pueden ser varios: el segundo quedaba vivo y bueno
      // en la cartera contra una cobranza que ya no existe. Se buscan por
      // cobranza_id, y se deja el id de la cabecera como respaldo para las cobranzas
      // viejas, cargadas antes de que existiera la columna.
      const chIds = db.prepare(`SELECT id FROM sg_fin_cheques_terceros
        WHERE cobranza_id=? AND estado='en_cartera'`).all(co.id).map((x) => x.id);
      if (!chIds.length && co.cheque_terceros_id) chIds.push(co.cheque_terceros_id);
      for (const chId of chIds) {
        const ch = db.prepare('SELECT estado FROM sg_fin_cheques_terceros WHERE id=?').get(chId);
        // Si ya se depositó no se toca: la plata entró al banco y anular la cobranza
        // no la saca de ahí — eso se resuelve marcando el cheque rechazado.
        if (ch && ch.estado === 'en_cartera') {
          db.prepare(`UPDATE sg_fin_cheques_terceros SET estado='anulado',
            notas = TRIM(COALESCE(notas,'') || ' [ANULADO con la cobranza: ' || ? || ']')
            WHERE id=?`).run(motivo, chId);
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
