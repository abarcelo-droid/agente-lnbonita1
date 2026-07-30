// src/rutas/sp.js
// ── API del módulo SP · Seguimiento de Órdenes de Pago ────────────────────
// Montado en /api/sp. Solo toca tablas sp_*.
//
// El envío de mails NUNCA va dentro de la transacción: se encola adentro y se
// procesa después de responder (ver servicios/sp_outbox.js).

import express from 'express';
import db from '../servicios/db_sp.js';     // este import crea el schema sp_*
import {
  armarSnapshot, validarDefinicion, resolverAutorizados, bloqueadoPorSoD,
  accionesDisponibles, aplicarCambioDePaso, registrarEvento
} from '../servicios/sp_motor.js';
import { encolar, render, procesarEnBackground } from '../servicios/sp_outbox.js';

const router = express.Router();

router.use((req, res, next) => {
  try { const c = req.cookies?.lnb_user; if (c) req.user = JSON.parse(c); } catch (_) {}
  next();
});
function requireAuth(req, res, next) {
  if (!req.user || !req.user.id) return res.status(401).json({ ok: false, error: 'No autenticado' });
  next();
}
router.use(requireAuth);

const esAdmin = (req) => req.user.rol === 'admin';

// Sociedad resuelta en el backend: el interceptor del panel solo inyecta
// sociedad_id a un whitelist de rutas que no incluye /api/sp. Molde de proveedores.js.
let _socId = null;
function sociedadDefault() {
  if (_socId) return _socId;
  const r = db.prepare("SELECT id FROM sociedades WHERE nombre = 'San Gerónimo SA'").get()
         || db.prepare('SELECT id FROM sociedades ORDER BY id LIMIT 1').get();
  _socId = r ? r.id : 1;
  return _socId;
}
function getSociedadId(req) {
  const raw = req.body?.sociedad_id ?? req.query?.sociedad_id;
  const id = (raw !== undefined && raw !== null && raw !== '') ? parseInt(raw, 10) : null;
  if (Number.isInteger(id) && db.prepare('SELECT id FROM sociedades WHERE id=?').get(id)) return id;
  return sociedadDefault();
}

const bad = (m) => Object.assign(new Error(m), { status: 400 });
const noEncontrado = (m) => Object.assign(new Error(m || 'No encontrado'), { status: 404 });
const conflicto = (m, extra) => Object.assign(new Error(m), { status: 409, extra });

// No hay error middleware global en index.js: un throw sin catch devuelve HTML y
// rompe el r.json() del panel. Cada handler va envuelto.
const wrap = (fn) => (req, res) => {
  try { fn(req, res); }
  catch (e) {
    const b = { ok: false, error: e.message };
    if (e.extra) Object.assign(b, e.extra);
    res.status(e.status || 500).json(b);
  }
};

const vTexto = (v, campo, { req: obl = false, max = 300 } = {}) => {
  const s = (v === undefined || v === null) ? '' : String(v).trim();
  if (!s && obl) throw bad(`${campo} es obligatorio`);
  if (s.length > max) throw bad(`${campo} no puede superar los ${max} caracteres`);
  return s || null;
};
const vNum = (v, campo, { min = -Infinity, def = null } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (def !== null) return def;
    throw bad(`${campo} es obligatorio`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${campo} tiene que ser un número`);
  if (n < min) throw bad(`${campo} no puede ser menor que ${min}`);
  return n;
};
const vFecha = (v, campo) => {
  const s = vTexto(v, campo, { max: 10 });
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${campo} tiene que ser AAAA-MM-DD`);
  return s;
};

const PANEL_URL = process.env.PANEL_BASE_URL || 'https://agente-lnbonita1-production.up.railway.app';
// El mail LINKEA al panel y la acción exige login. Un botón "Aprobar" que funciona
// desde el mail se reenvía y lo aprieta cualquiera: la autorización dejaría de ser
// atribuible, que es justo lo único que este circuito tiene que garantizar.
const linkA = (id) => `${PANEL_URL}/login?next=${encodeURIComponent('/panel?sp=' + id)}`;

const plantillaDe = (def, clave) => (def.plantillas || []).find(p => p.clave === clave) || null;
const money = (m, mon) => (mon || 'ARS') + ' ' + Number(m || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function varsDe(sol, extra) {
  return {
    numero: sol.numero, proveedor: sol.proveedor_texto, cuenta: sol.cuenta_texto,
    monto: money(sol.monto, sol.moneda), concepto: sol.concepto,
    solicitante: sol.solicitante_nombre, fecha_pago: sol.fecha_pago_confirmada,
    link: linkA(sol.id), ...(extra || {})
  };
}

// Encola el aviso de "te toca a vos" a los habilitados del paso destino, más los
// watchers. Se llama DENTRO de la transacción.
function avisarPaso(def, sol, pasoClave, eventoId) {
  const paso = (def.pasos || []).find(p => p.clave === pasoClave);
  if (!paso || paso.tipo === 'final_ok' || paso.tipo === 'final_rechazo') return;
  const { resolutores, watchers } = resolverAutorizados(def, pasoClave, sol);
  const dest = [...resolutores, ...watchers].map(u => u.email).filter(Boolean);
  const pl = plantillaDe(def, 'paso:' + pasoClave);
  const asunto = pl ? pl.asunto : 'Te toca revisar {{numero}} · {{proveedor}}';
  const cuerpo = pl ? pl.cuerpo
    : 'Hola {{destinatario}},\n\nTenés una solicitud de pago esperándote: {{numero}} · {{proveedor}} · {{monto}}.\n\n{{link}}\n';
  const vars = varsDe(sol, { destinatario: 'equipo' });
  encolar({
    solicitudId: sol.id, eventoId,
    dedupKey: `paso:${sol.id}:${pasoClave}:${eventoId}`,
    destinatarios: dest,
    asunto: render(asunto, vars), cuerpo: render(cuerpo, vars)
  });
}

// Avisos al SOLICITANTE. El destinatario es fijo en el código, no configurable:
// es lo que hace que el comprador no tenga que entrar a mirar todos los días.
function avisarSolicitante(def, sol, evento, eventoId, extra) {
  const u = db.prepare('SELECT nombre, email FROM usuarios WHERE id=?').get(sol.solicitante_id);
  if (!u || !u.email) return;
  const pl = plantillaDe(def, 'evento:' + evento);
  if (!pl) return;
  const vars = varsDe(sol, { destinatario: u.nombre, ...(extra || {}) });
  encolar({
    solicitudId: sol.id, eventoId,
    dedupKey: `sol:${sol.id}:${evento}:${eventoId}`,
    destinatarios: [u.email],
    asunto: render(pl.asunto, vars), cuerpo: render(pl.cuerpo, vars)
  });
}

// ══════════════════════════════════════════════════════════════════════════
// CIRCUITO (definición)
// ══════════════════════════════════════════════════════════════════════════

function versionActiva() {
  const v = db.prepare(`
    SELECT v.*, f.clave AS flujo_clave, f.nombre AS flujo_nombre, f.email_fallback
    FROM sp_flujo_versiones v JOIN sp_flujos f ON f.id = v.flujo_id
    WHERE v.estado='activa' AND f.activo=1 AND f.clave='pago_proveedor'
  `).get();
  return v || null;
}

router.get('/circuito', wrap((req, res) => {
  const v = versionActiva();
  if (!v) throw noEncontrado('No hay ningún circuito activo');
  const def = armarSnapshot(v.id);
  res.json({ ok: true, data: { version: v, def, validacion: validarDefinicion(def) } });
}));

// Validar la definición activa sin activar nada. Útil para ver si la configuración
// quedó consistente después de tocar autorizados.
router.get('/circuito/validar', wrap((req, res) => {
  const v = versionActiva();
  if (!v) throw noEncontrado('No hay ningún circuito activo');
  res.json({ ok: true, data: validarDefinicion(armarSnapshot(v.id)) });
}));

// Asignar quién está habilitado en un paso. Es lo mínimo del configurador que hace
// falta para que el módulo sirva: sin esto, todo queda en manos de los admin.
router.put('/circuito/pasos/:clave/autorizados', wrap((req, res) => {
  if (!esAdmin(req)) throw Object.assign(new Error('Solo administradores'), { status: 403 });
  const v = versionActiva();
  if (!v) throw noEncontrado('No hay circuito activo');
  const paso = db.prepare('SELECT * FROM sp_pasos WHERE version_id=? AND clave=?').get(v.id, req.params.clave);
  if (!paso) throw noEncontrado('Paso no encontrado');
  const lista = req.body?.autorizados;
  if (!Array.isArray(lista)) throw bad('Faltan los autorizados');

  db.transaction(() => {
    db.prepare('DELETE FROM sp_paso_autorizados WHERE paso_id=?').run(paso.id);
    const ins = db.prepare(`
      INSERT INTO sp_paso_autorizados (paso_id, tipo, usuario_id, rol, area_id, watcher)
      VALUES (?,?,?,?,?,?)
    `);
    for (const a of lista) {
      if (!['usuario', 'rol', 'area', 'solicitante'].includes(a.tipo)) throw bad('Tipo de autorizado inválido');
      if (a.tipo === 'usuario') {
        const u = db.prepare('SELECT id FROM usuarios WHERE id=? AND activo=1').get(a.usuario_id);
        if (!u) throw bad('Hay un usuario habilitado que no existe o está inactivo');
      }
      ins.run(paso.id, a.tipo, a.usuario_id || null, a.rol || null, a.area_id || null, a.watcher ? 1 : 0);
    }
  })();

  // Se revalida DESPUÉS de guardar y se devuelve el resultado: si la edición dejó
  // el circuito trabado, el usuario tiene que verlo ahora, no cuando una solicitud
  // se clave.
  const val = validarDefinicion(armarSnapshot(v.id));
  res.json({ ok: true, validacion: val });
}));

// Usuarios elegibles para el configurador
router.get('/usuarios', wrap((req, res) => {
  const data = db.prepare(`
    SELECT id, nombre, email, rol FROM usuarios
    WHERE activo=1 AND email IS NOT NULL AND email <> '' ORDER BY nombre
  `).all();
  res.json({ ok: true, data });
}));

// ══════════════════════════════════════════════════════════════════════════
// SOLICITUDES
// ══════════════════════════════════════════════════════════════════════════

function getSol(soc, id) {
  const s = db.prepare('SELECT * FROM sp_solicitudes WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(id, soc);
  if (!s) throw noEncontrado('Solicitud no encontrada');
  return s;
}
const defDe = (sol) => JSON.parse(sol.def_snapshot_json);

function numeroNuevo(soc) {
  const anio = new Date().getFullYear();
  const pre = `SP-${anio}-`;
  const ult = db.prepare(`
    SELECT numero FROM sp_solicitudes WHERE sociedad_id=? AND numero LIKE ?
    ORDER BY numero DESC LIMIT 1
  `).get(soc, pre + '%');
  const n = ult ? parseInt(String(ult.numero).slice(pre.length), 10) + 1 : 1;
  return pre + String(n).padStart(4, '0');
}

router.post('/solicitudes', wrap((req, res) => {
  const soc = getSociedadId(req);
  const b = req.body || {};
  const v = versionActiva();
  if (!v) throw bad('No hay circuito activo. Avisale a un administrador.');

  const def = armarSnapshot(v.id);
  const val = validarDefinicion(def);
  if (!val.ok) {
    throw conflicto('El circuito tiene problemas de configuración y no se puede usar todavía.', { validacion: val });
  }
  const inicio = def.pasos.find(p => p.tipo === 'inicio');

  const proveedor = vTexto(b.proveedor_texto, 'El proveedor', { req: true, max: 200 });
  const concepto = vTexto(b.concepto, 'El concepto', { req: true, max: 500 });
  const monto = vNum(b.monto, 'El monto', { min: 0.01 });
  const moneda = (vTexto(b.moneda, 'La moneda') || 'ARS').toUpperCase();
  if (!['ARS', 'USD'].includes(moneda)) throw bad('La moneda tiene que ser ARS o USD');

  // Control BLANDO de comprobante repetido: pagar una factura en dos veces
  // (anticipo y saldo, cuotas) es rutina, así que no se bloquea. Se avisa, se
  // muestran las anteriores y se exige una justificación que queda registrada.
  const cbteNum = vTexto(b.comprobante_numero, 'El número de comprobante', { max: 60 });
  if (cbteNum && !b.justificacion_duplicado) {
    const previas = db.prepare(`
      SELECT id, numero, monto, moneda, estado_global, paso_actual_clave
      FROM sp_solicitudes
      WHERE sociedad_id=? AND comprobante_numero=? AND proveedor_texto=? COLLATE NOCASE
        AND eliminado_en IS NULL AND estado_global <> 'cancelada'
    `).all(soc, cbteNum, proveedor);
    if (previas.length) {
      throw conflicto(`Ya hay ${previas.length} solicitud(es) con el comprobante ${cbteNum} de ${proveedor}.`,
        { codigo: 'comprobante_ya_solicitado', solicitudes: previas });
    }
  }

  const id = db.transaction(() => {
    const numero = numeroNuevo(soc);
    const r = db.prepare(`
      INSERT INTO sp_solicitudes
        (sociedad_id, numero, flujo_version_id, def_snapshot_json, solicitante_id, solicitante_nombre,
         proveedor_texto, cuenta_texto, concepto, monto, moneda, comprobante_tipo, comprobante_numero,
         fecha_necesidad, prioridad, justificacion_duplicado,
         paso_actual_clave, paso_actual_hito, paso_actual_desde, estado_global)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),'en_curso')
    `).run(soc, numero, v.id, JSON.stringify(def), req.user.id, req.user.nombre || null,
           proveedor, vTexto(b.cuenta_texto, 'La cuenta', { max: 200 }), concepto, monto, moneda,
           vTexto(b.comprobante_tipo, 'El tipo de comprobante', { max: 30 }), cbteNum,
           vFecha(b.fecha_necesidad, 'La fecha de necesidad'),
           b.prioridad === 'urgente' ? 'urgente' : 'normal',
           vTexto(b.justificacion_duplicado, 'La justificación', { max: 500 }),
           inicio.clave, inicio.hito || null);
    const solId = r.lastInsertRowid;
    registrarEvento(solId, {
      paso_hasta: inicio.clave, accion: 'crear', hito: null,
      actor_id: req.user.id, actor_nombre: req.user.nombre, actor_rol: req.user.rol,
      datos_json: { monto, moneda, proveedor }
    });
    return solId;
  })();

  res.json({ ok: true, id, siguiente: 'Cargala y usá "Enviar a autorizar" cuando esté lista.' });
}));

// Bandejas. Todo GET: tienen que funcionar para usuarios solo lectura.
//   mias      — lo que pedí yo (la vista del comprador)
//   pendiente — lo que me toca resolver a mí
//   todas     — el tablero (admin)
router.get('/solicitudes', wrap((req, res) => {
  const soc = getSociedadId(req);
  const vista = ['mias', 'pendiente', 'todas'].includes(req.query.vista) ? req.query.vista : 'mias';
  const params = [soc];
  let sql = `
    SELECT s.*, (SELECT COUNT(*) FROM sp_eventos e WHERE e.solicitud_id = s.id) AS n_eventos
    FROM sp_solicitudes s WHERE s.sociedad_id=? AND s.eliminado_en IS NULL`;
  if (vista === 'mias') { sql += ' AND s.solicitante_id = ?'; params.push(req.user.id); }
  if (req.query.estado) { sql += ' AND s.estado_global = ?'; params.push(req.query.estado); }
  sql += ' ORDER BY CASE s.prioridad WHEN \'urgente\' THEN 0 ELSE 1 END, s.id DESC LIMIT 400';
  let filas = db.prepare(sql).all(...params);

  // Se calculan las acciones POR FILA: una bandeja que no dice qué hacer obliga a
  // abrir cada solicitud de a una, y con 40 pedidos nadie hace eso.
  filas = filas.map(s => {
    const def = defDe(s);
    const acciones = accionesDisponibles(def, s, req.user);
    const paso = (def.pasos || []).find(p => p.clave === s.paso_actual_clave);
    return {
      ...s, def_snapshot_json: undefined,
      paso_nombre: paso ? paso.nombre : s.paso_actual_clave,
      paso_instrucciones: paso ? paso.instrucciones : null,
      acciones,
      vencida: !!(s.vence_en && s.estado_global === 'en_curso' && s.vence_en < new Date().toISOString().slice(0, 19).replace('T', ' '))
    };
  });
  if (vista === 'pendiente') filas = filas.filter(s => s.acciones.length > 0);
  res.json({ ok: true, data: filas, vista });
}));

router.get('/solicitudes/:id', wrap((req, res) => {
  const soc = getSociedadId(req);
  const s = getSol(soc, parseInt(req.params.id, 10));
  const def = defDe(s);
  const paso = (def.pasos || []).find(p => p.clave === s.paso_actual_clave);
  const eventos = db.prepare('SELECT * FROM sp_eventos WHERE solicitud_id=? ORDER BY seq').all(s.id);
  const adjuntos = db.prepare('SELECT id, nombre, mime, tamano, tipo, creado_en FROM sp_adjuntos WHERE solicitud_id=? AND eliminado_en IS NULL').all(s.id);
  const { resolutores } = resolverAutorizados(def, s.paso_actual_clave, s);
  res.json({
    ok: true,
    data: {
      solicitud: { ...s, def_snapshot_json: undefined },
      paso: paso || null,
      pasos: def.pasos,
      acciones: accionesDisponibles(def, s, req.user),
      bloqueo_sod: bloqueadoPorSoD(def, s, s.paso_actual_clave, req.user.id),
      esperando_a: resolutores.map(u => ({ id: u.id, nombre: u.nombre })),
      eventos, adjuntos
    }
  });
}));

// ── La acción: avanzar, devolver o rechazar ───────────────────────────────
router.post('/solicitudes/:id/accion', wrap((req, res) => {
  const soc = getSociedadId(req);
  const s = getSol(soc, parseInt(req.params.id, 10));
  const def = defDe(s);
  const b = req.body || {};
  const accion = vTexto(b.accion, 'La acción', { req: true, max: 40 });

  if (s.estado_global !== 'en_curso') throw bad('Esta solicitud ya está cerrada');
  // Lock optimista: es la barrera contra el doble click y contra dos personas
  // resolviendo el mismo paso al mismo tiempo.
  if (b.rev !== undefined && Number(b.rev) !== s.rev) {
    throw conflicto('Alguien más movió esta solicitud mientras la mirabas. Recargá.');
  }

  const paso = (def.pasos || []).find(p => p.clave === s.paso_actual_clave);
  if (!paso) throw Object.assign(new Error('El circuito de esta solicitud está corrupto'), { status: 500 });

  const tr = (def.transiciones || []).find(t => t.desde === paso.clave && t.accion === accion);
  if (!tr) throw bad(`"${accion}" no es una acción válida desde "${paso.nombre}"`);

  // Permiso: habilitado en el paso, o admin
  const { resolutores } = resolverAutorizados(def, paso.clave, s);
  if (!esAdmin(req) && !resolutores.some(u => u.id === req.user.id)) {
    throw Object.assign(new Error('No estás habilitado para resolver este paso'), { status: 403 });
  }
  // Segregación de funciones. Aplica también a los admin: si no, el control se cae
  // con el usuario que más lo necesita.
  const sod = bloqueadoPorSoD(def, s, paso.clave, req.user.id);
  if (sod) throw Object.assign(new Error(sod), { status: 403 });

  const comentario = vTexto(b.comentario, 'El comentario', { max: 1000 });
  if ((tr.requiere_comentario || paso.requiere_comentario) && !comentario) {
    throw bad('Este paso pide que dejes un comentario explicando por qué');
  }

  // Requisitos por modo de captura
  const datos = {};
  if (paso.modo_captura === 'informa_fecha' && tr.clase === 'avanza') {
    datos.fecha_pago = vFecha(b.fecha_pago, 'La fecha de pago');
    if (!datos.fecha_pago) throw bad('Tenés que informar la fecha de pago');
  }
  if (paso.modo_captura === 'envia_comprobantes' && tr.clase === 'avanza') {
    const tieneAdj = db.prepare(`
      SELECT COUNT(*) AS n FROM sp_adjuntos
      WHERE solicitud_id=? AND tipo='comprobante_pago' AND eliminado_en IS NULL
    `).get(s.id).n > 0;
    // Requisito BLANDO: el comprobante de transferencia vive en el homebanking y
    // muchas veces se manda por WhatsApp. Exigir la subida dejaría todas las
    // solicitudes acumuladas en este paso para siempre.
    if (!tieneAdj && !b.enviado_por_otro_medio) {
      throw bad('Adjuntá el comprobante o marcá que lo enviaste por otro medio explicando cómo');
    }
    if (!tieneAdj) {
      if (!comentario) throw bad('Si lo enviaste por otro medio, decí por dónde en el comentario');
      datos.enviado_por_otro_medio = true;
    }
  }

  const salida = db.transaction(() => {
    const cambio = aplicarCambioDePaso(def, s, tr.hasta, { sumaCiclo: tr.clase === 'devuelve' });
    if (datos.fecha_pago) {
      db.prepare('UPDATE sp_solicitudes SET fecha_pago_confirmada=? WHERE id=?').run(datos.fecha_pago, s.id);
    }
    const evId = registrarEvento(s.id, {
      paso_desde: paso.clave, paso_hasta: tr.hasta, accion, hito: paso.hito, clase: tr.clase,
      actor_id: req.user.id, actor_nombre: req.user.nombre, actor_rol: req.user.rol,
      comentario, datos_json: Object.keys(datos).length ? datos : null
    });

    // Los mails se ENCOLAN acá (dentro de la transacción, así el aviso existe si y
    // solo si el cambio se guardó) y se mandan después, afuera.
    const solFresca = { ...s, ...datos, fecha_pago_confirmada: datos.fecha_pago || s.fecha_pago_confirmada };
    avisarPaso(def, solFresca, tr.hasta, evId);
    if (tr.clase === 'devuelve' && tr.hasta === (def.pasos.find(p => p.tipo === 'inicio') || {}).clave) {
      avisarSolicitante(def, solFresca, 'devuelto', evId, { actor: req.user.nombre, comentario });
    }
    if (tr.clase === 'rechaza') {
      avisarSolicitante(def, solFresca, 'rechazado', evId, { actor: req.user.nombre, comentario });
    }
    if (datos.fecha_pago) {
      // El paso que más le importa al comprador: es lo único que tiene que
      // contestarle al proveedor. Sin este aviso entra al panel todos los días o
      // le escribe por WhatsApp a Tesorería.
      avisarSolicitante(def, solFresca, 'fecha_confirmada', evId, {});
    }
    if (cambio.estado === 'aprobada_final') {
      avisarSolicitante(def, solFresca, 'cerrado', evId, {});
    }
    return { estado: cambio.estado, destino: cambio.destino };
  })();

  // Fuera de la transacción, sin bloquear la respuesta.
  procesarEnBackground();

  res.json({
    ok: true,
    estado_global: salida.estado,
    paso: salida.destino.clave,
    paso_nombre: salida.destino.nombre
  });
}));

// Editar mientras está en el paso inicial. Después de la primera autorización el
// monto y la cuenta no se tocan: cambiarlos invalidaría lo aprobado.
router.patch('/solicitudes/:id', wrap((req, res) => {
  const soc = getSociedadId(req);
  const s = getSol(soc, parseInt(req.params.id, 10));
  const def = defDe(s);
  const inicio = def.pasos.find(p => p.tipo === 'inicio');
  if (s.estado_global !== 'en_curso') throw bad('La solicitud está cerrada');
  if (s.paso_actual_clave !== inicio.clave) {
    throw conflicto('La solicitud ya salió a autorizar. Si hay que cambiarla, pedí que te la devuelvan.');
  }
  if (s.solicitante_id !== req.user.id && !esAdmin(req)) {
    throw Object.assign(new Error('Solo el solicitante puede editarla'), { status: 403 });
  }
  const b = req.body || {};
  db.prepare(`
    UPDATE sp_solicitudes SET proveedor_texto=?, cuenta_texto=?, concepto=?, monto=?, moneda=?,
      comprobante_tipo=?, comprobante_numero=?, fecha_necesidad=?, prioridad=?, rev=rev+1
    WHERE id=?
  `).run(
    b.proveedor_texto === undefined ? s.proveedor_texto : vTexto(b.proveedor_texto, 'El proveedor', { req: true, max: 200 }),
    b.cuenta_texto === undefined ? s.cuenta_texto : vTexto(b.cuenta_texto, 'La cuenta', { max: 200 }),
    b.concepto === undefined ? s.concepto : vTexto(b.concepto, 'El concepto', { req: true, max: 500 }),
    b.monto === undefined ? s.monto : vNum(b.monto, 'El monto', { min: 0.01 }),
    b.moneda === undefined ? s.moneda : String(b.moneda).toUpperCase(),
    b.comprobante_tipo === undefined ? s.comprobante_tipo : vTexto(b.comprobante_tipo, 'El tipo', { max: 30 }),
    b.comprobante_numero === undefined ? s.comprobante_numero : vTexto(b.comprobante_numero, 'El número', { max: 60 }),
    b.fecha_necesidad === undefined ? s.fecha_necesidad : vFecha(b.fecha_necesidad, 'La fecha'),
    b.prioridad === undefined ? s.prioridad : (b.prioridad === 'urgente' ? 'urgente' : 'normal'),
    s.id
  );
  registrarEvento(s.id, {
    paso_desde: s.paso_actual_clave, paso_hasta: s.paso_actual_clave, accion: 'editar',
    actor_id: req.user.id, actor_nombre: req.user.nombre, actor_rol: req.user.rol,
    datos_json: { antes: { monto: s.monto, proveedor: s.proveedor_texto, cuenta: s.cuenta_texto } }
  });
  res.json({ ok: true });
}));

// Cancelar. El solicitante puede mientras nadie autorizó nada; después es admin y
// con motivo. Si no, se podría firmar, pagar, cancelar el expediente y volver a
// cargar la misma factura sin que ningún control salte.
router.post('/solicitudes/:id/cancelar', wrap((req, res) => {
  const soc = getSociedadId(req);
  const s = getSol(soc, parseInt(req.params.id, 10));
  const def = defDe(s);
  if (s.estado_global !== 'en_curso') throw bad('La solicitud ya está cerrada');
  const motivo = vTexto(req.body?.motivo, 'El motivo', { req: true, max: 500 });
  if (motivo.length < 10) throw bad('El motivo tiene que explicar por qué (al menos 10 caracteres)');

  const hubodecision = db.prepare(`
    SELECT COUNT(*) AS n FROM sp_eventos
    WHERE solicitud_id=? AND hito IN ('autorizacion','fechas','confeccion','firma','comprobantes')
  `).get(s.id).n > 0;
  const esSolicitante = s.solicitante_id === req.user.id;
  if (hubodecision && !esAdmin(req)) {
    throw Object.assign(new Error('Ya hubo decisiones sobre esta solicitud: solo un administrador puede cancelarla.'), { status: 403 });
  }
  if (!hubodecision && !esSolicitante && !esAdmin(req)) {
    throw Object.assign(new Error('Solo el solicitante puede cancelarla'), { status: 403 });
  }

  db.transaction(() => {
    const r = db.prepare(`
      UPDATE sp_solicitudes SET estado_global='cancelada', cerrado_en=datetime('now','localtime'), rev=rev+1
      WHERE id=? AND rev=?
    `).run(s.id, s.rev);
    if (!r.changes) throw conflicto('Alguien más la movió. Recargá.');
    const evId = registrarEvento(s.id, {
      paso_desde: s.paso_actual_clave, accion: 'cancelar', clase: 'rechaza',
      actor_id: req.user.id, actor_nombre: req.user.nombre, actor_rol: req.user.rol,
      comentario: motivo, via: esAdmin(req) && !esSolicitante ? 'admin' : 'panel'
    });
    if (!esSolicitante) avisarSolicitante(def, s, 'rechazado', evId, { actor: req.user.nombre, comentario: motivo });
  })();
  procesarEnBackground();
  res.json({ ok: true });
}));

// Estado de la cola de mails: es lo que permite decir "esto se avisó" o "no salió".
router.get('/outbox', wrap((req, res) => {
  if (!esAdmin(req)) throw Object.assign(new Error('Solo administradores'), { status: 403 });
  const data = db.prepare(`
    SELECT o.id, o.solicitud_id, s.numero, o.destinatarios, o.asunto, o.estado,
           o.intentos, o.ultimo_error, o.creado_en, o.enviado_en
    FROM sp_outbox o LEFT JOIN sp_solicitudes s ON s.id = o.solicitud_id
    ORDER BY o.id DESC LIMIT 200
  `).all();
  const resumen = db.prepare('SELECT estado, COUNT(*) AS n FROM sp_outbox GROUP BY estado').all();
  res.json({ ok: true, data, resumen });
}));

export default router;
