// src/rutas/sp.js
// ── API del módulo SP · Seguimiento de Órdenes de Pago ────────────────────
// Montado en /api/sp. Solo toca tablas sp_*.
//
// El envío de mails NUNCA va dentro de la transacción: se encola adentro y se
// procesa después de responder (ver servicios/sp_outbox.js).

import express from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import db from '../servicios/db_sp.js';     // este import crea el schema sp_*
import { subirArchivo, obtenerArchivo, storageConfigurado } from '../servicios/storage.js';
import {
  armarSnapshot, validarDefinicion, resolverAutorizados, bloqueadoPorSoD, sodOmitida,
  accionesDisponibles, aplicarCambioDePaso, registrarEvento
} from '../servicios/sp_motor.js';
import { encolar, render, procesarEnBackground } from '../servicios/sp_outbox.js';

const router = express.Router();

// Los adjuntos van a R2 y no a disco: el disco del contenedor de Railway es
// efímero y se pierde en cada redeploy. Un PDF de cuenta corriente que respalda
// una orden de pago no puede desaparecer en el próximo deploy.
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Vocabulario de tipos de adjunto. Se valida acá y no con un CHECK en la tabla:
// ampliar un CHECK en SQLite exige recrear la tabla, y el repo ya se comió esa.
const TIPOS_ADJUNTO = {
  cuenta_corriente: 'PDF de cuenta corriente del proveedor',
  factura: 'Factura',
  orden: 'Orden de pago',
  comprobante_pago: 'Comprobante de pago',
  otro: 'Otro'
};

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

// La cuenta corriente es OBLIGATORIA y NUMÉRICA: es el número con el que se
// rastrea el pago en el otro sistema, así que una cuenta vacía o escrita a mano
// como texto rompe justamente lo que este módulo tiene que permitir.
// Se aceptan solo dígitos (se conservan los ceros a la izquierda, por eso queda
// como texto y no como entero).
// Condición de pago. Obligatoria y de TEXTO LIBRE: manejan varias y una lista
// cerrada obligaría a elegir "otro" en la mitad de los casos, que es peor que
// escribirla. Es lo que Tesorería necesita leer para poner la fecha.
function vCondicion(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) throw bad('Escribí la condición de pago acordada con el proveedor');
  if (s.length < 3) throw bad('La condición de pago es demasiado corta para que se entienda');
  if (s.length > 300) throw bad('La condición de pago no puede superar los 300 caracteres');
  return s;
}

function vCuenta(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) throw bad('La cuenta corriente es obligatoria: es el número con el que se rastrea el pago en el sistema');
  if (!/^\d{1,20}$/.test(s)) {
    throw bad(`La cuenta corriente tiene que ser un número (llegó "${s.slice(0, 30)}")`);
  }
  return s;
}

const PANEL_URL = process.env.PANEL_BASE_URL || 'https://agente-lnbonita1-production.up.railway.app';
// El link apunta DIRECTO al panel con la solicitud (y opcionalmente la acción) en la
// URL. Si hay sesión abierta —lo normal en la oficina— es un solo click; si no, el
// guard de /panel manda al login preservando el destino y vuelve acá.
//
// A propósito NO se usa un token que apruebe sin iniciar sesión: un mail reenviado
// lo aprieta cualquiera y la autorización dejaría de ser atribuible, que es lo único
// que este circuito tiene que garantizar. Con la sesión abierta, la diferencia en
// clicks es cero.
const linkA = (id, accion) =>
  `${PANEL_URL}/panel?sp=${id}` + (accion ? `&accion=${encodeURIComponent(accion)}` : '');

const plantillaDe = (def, clave) => (def.plantillas || []).find(p => p.clave === clave) || null;
const money = (m, mon) => (mon || 'ARS') + ' ' + Number(m || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function varsDe(sol, extra) {
  return {
    numero: sol.numero, proveedor: sol.proveedor_texto, cuenta: sol.cuenta_texto,
    monto: money(sol.monto, sol.moneda), concepto: sol.concepto,
    condicion_pago: sol.condicion_pago,
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

  // A quien la segregación de funciones le impide resolver ESTE paso en ESTA
  // solicitud NO se le avisa: recibiría un "te toca a vos" sobre algo que no puede
  // tocar, y después la bandeja le aparece vacía. El caso típico es el solicitante,
  // que suele estar habilitado para autorizar pero no sobre su propio pedido.
  const puedenActuar = resolutores.filter(u => !bloqueadoPorSoD(def, sol, pasoClave, u.id));

  // Si el solicitante eligió a quién le pide el OK, el aviso va SOLO a esa persona.
  // "rol admin" se expande a todos los administradores, así que sin esto una
  // solicitud dispara un mail a cada uno y nadie se siente responsable.
  //
  // Dirige el AVISO, no el permiso: los demás habilitados siguen viendo la
  // solicitud en su bandeja y pueden resolverla. Si el elegido está de licencia, el
  // pedido no se traba, solo que los otros no recibieron el mail.
  let destinatarios = puedenActuar;
  if (paso.hito === 'autorizacion' && sol.autorizador_id) {
    const elegido = puedenActuar.filter(u => u.id === sol.autorizador_id);
    if (elegido.length) destinatarios = elegido;
  }
  const dest = [...destinatarios, ...watchers].map(u => u.email).filter(Boolean);

  const pl = plantillaDe(def, 'paso:' + pasoClave);
  const asunto = pl ? pl.asunto : 'Te toca revisar {{numero}} · {{proveedor}}';
  const cuerpo = pl ? pl.cuerpo
    : 'Hola {{destinatario}},\n\nTenés una solicitud de pago esperándote: {{numero}} · {{proveedor}} · {{monto}}.\n\n{{link}}\n';
  // La composición del pago viaja al que confecciona: sin ella tiene que entrar al
  // panel a averiguar cuántos cheques emitir y por cuánto.
  const comp = textoComposicion(pagosDe(sol.id), sol.moneda);
  const vars = varsDe(sol, { destinatario: 'equipo', composicion: comp });
  let texto = render(cuerpo, vars);
  // Los bloques que la plantilla no tiene se agregan igual, pero ANTES del link:
  // pegados al final quedan después del "entrá al panel", que es donde el ojo deja
  // de leer. Si la plantilla ya los trae, no se duplican.
  const url = linkA(sol.id);
  const insertar = (txt, bloque) => {
    if (!bloque) return txt;
    const i = txt.indexOf(url);
    if (i === -1) return txt + '\n' + bloque + '\n';
    return txt.slice(0, i) + bloque + '\n\n' + txt.slice(i);
  };

  // La condición de pago la escribió el comprador y es lo que hace falta para
  // decidir: el que autoriza necesita saber si corresponde pagar ahora, Tesorería
  // para poner la fecha, y el que confecciona y firma para controlar contra ella.
  if (sol.condicion_pago && texto.indexOf(sol.condicion_pago) === -1) {
    texto = insertar(texto, 'Condición de pago: ' + sol.condicion_pago);
  }
  if (comp && paso.hito === 'confeccion' && texto.indexOf(comp) === -1) {
    texto = insertar(texto, 'Cómo se paga:\n' + comp);
  }

  // Botones de acción en el mail. Llevan al panel con la acción ya elegida: si hay
  // sesión abierta es un click, y si no, pasa por el login y vuelve acá. La acción
  // se ejecuta DENTRO del panel autenticado, así queda atribuida a una persona.
  const acciones = (def.transiciones || [])
    .filter(t => t.desde === pasoClave)
    .map(t => ({ etiqueta: t.etiqueta, clase: t.clase, url: linkA(sol.id, t.accion) }));

  encolar({
    solicitudId: sol.id, eventoId,
    dedupKey: `paso:${sol.id}:${pasoClave}:${eventoId}`,
    destinatarios: dest,
    asunto: render(asunto, vars),
    cuerpo: texto,
    html: htmlConBotones(texto, acciones)
  });
}

// Mail en HTML con botones. Se arma acá y no en una plantilla editable a propósito:
// si el HTML fuera configurable, un error de tipeo rompe el mail de todo el
// circuito. Lo editable es el TEXTO; los botones los pone el sistema.
function htmlConBotones(texto, acciones) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const color = (c) => c === 'rechaza' ? '#b91c1c' : (c === 'avanza' ? '#15803d' : '#475569');
  const botones = (acciones || []).map(a =>
    `<a href="${esc(a.url)}" style="display:inline-block;padding:10px 18px;margin:4px 6px 4px 0;`
    + `background:${color(a.clase)};color:#fff;text-decoration:none;border-radius:6px;`
    + `font-family:system-ui,sans-serif;font-size:14px;font-weight:600">${esc(a.etiqueta)}</a>`
  ).join('');
  return '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.55;color:#1e293b">'
    + '<div style="white-space:pre-wrap">' + esc(texto) + '</div>'
    + (botones ? '<div style="margin-top:16px">' + botones + '</div>' : '')
    + '<div style="margin-top:14px;font-size:12px;color:#64748b">'
    + 'Los botones te llevan al panel. Si ya tenés la sesión abierta es un solo click; '
    + 'si no, te pide iniciar sesión y después te deja en la solicitud. '
    + 'La aprobación se registra a tu nombre, así que no se puede resolver desde un mail reenviado.'
    + '</div></div>';
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

// A quién le puede pedir el OK el solicitante: los habilitados del paso de
// autorización, sacando a los que la separación de funciones dejaría afuera para
// ESTE solicitante (empezando por él mismo).
router.get('/autorizadores', wrap((req, res) => {
  const v = versionActiva();
  if (!v) throw noEncontrado('No hay circuito activo');
  const def = armarSnapshot(v.id);
  const paso = (def.pasos || []).find(p => p.hito === 'autorizacion');
  if (!paso) return res.json({ ok: true, data: [], paso: null });

  // Solicitud ficticia con el usuario actual como solicitante: alcanza para que la
  // separación de funciones descarte a quien no podría autorizarle a él.
  const ficticia = { id: 0, solicitante_id: req.user.id };
  const { resolutores } = resolverAutorizados(def, paso.clave, ficticia);
  const data = resolutores
    .filter(u => u.email)
    .filter(u => !bloqueadoPorSoD(def, ficticia, paso.clave, u.id))
    .map(u => ({ id: u.id, nombre: u.nombre, email: u.email, rol: u.rol }))
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
  res.json({ ok: true, data, paso: { clave: paso.clave, nombre: paso.nombre } });
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

// ── Composición del pago ──────────────────────────────────────────────────
// Transferencia, cheque propio, cheque de terceros, o el mix de los tres.

const TIPOS_PAGO = ['transferencia', 'cheque_propio', 'cheque_terceros'];
const ETIQUETA_PAGO = {
  transferencia: 'Transferencia',
  cheque_propio: 'Cheque propio',
  cheque_terceros: 'Cheque de terceros'
};
const MAX_POR_TIPO = 20;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function validarComposicion(lista, sol, fechaPago) {
  if (!Array.isArray(lista) || !lista.length) {
    throw bad('Cargá cómo se va a pagar: transferencia, cheques, o la combinación');
  }
  const cuenta = {};
  const out = lista.map((p, i) => {
    const tipo = String(p.tipo || '').trim();
    if (!TIPOS_PAGO.includes(tipo)) throw bad(`La línea ${i + 1} no tiene un medio de pago válido`);
    cuenta[tipo] = (cuenta[tipo] || 0) + 1;
    if (cuenta[tipo] > MAX_POR_TIPO) {
      throw bad(`Máximo ${MAX_POR_TIPO} ${ETIQUETA_PAGO[tipo].toLowerCase()}(s) por solicitud`);
    }
    const importe = vNum(p.importe, `El importe de la línea ${i + 1}`, { min: 0.01 });
    // El cheque de terceros se identifica por su código: sin eso, el que confecciona
    // no sabe qué cheque endosar.
    let codigo = null;
    if (tipo === 'cheque_terceros') {
      codigo = vTexto(p.codigo, `El código del cheque de la línea ${i + 1}`, { req: true, max: 40 });
    }
    // Los cheques llevan su propia fecha de vencimiento, que es justamente el punto
    // de un cheque diferido. Si no viene, se asume la fecha de pago.
    const fecha = vFecha(p.fecha, `La fecha de la línea ${i + 1}`) || fechaPago;
    return { tipo, importe: round2(importe), fecha, codigo, notas: vTexto(p.notas, 'Las notas', { max: 200 }) };
  });

  // La suma tiene que dar el monto: si no, la orden se confecciona por un importe
  // distinto al autorizado. Se informa la diferencia exacta para que sea corregible
  // de una, en vez de un "no coincide" que obliga a sacar la cuenta a mano.
  const suma = round2(out.reduce((a, p) => a + p.importe, 0));
  const monto = round2(sol.monto);
  if (Math.abs(suma - monto) > 0.009) {
    const dif = round2(Math.abs(suma - monto));
    throw bad(
      `La composición suma ${money(suma, sol.moneda)} y el pago autorizado es ${money(monto, sol.moneda)}. `
      + (suma < monto ? `Faltan ${money(dif, sol.moneda)}.` : `Sobran ${money(dif, sol.moneda)}.`)
    );
  }
  return out;
}

// Texto de la composición para el mail y las pantallas.
function textoComposicion(pagos, moneda) {
  if (!pagos || !pagos.length) return '';
  const porTipo = {};
  for (const p of pagos) (porTipo[p.tipo] = porTipo[p.tipo] || []).push(p);
  const lineas = [];
  for (const tipo of TIPOS_PAGO) {
    const arr = porTipo[tipo];
    if (!arr || !arr.length) continue;
    const sub = round2(arr.reduce((a, p) => a + p.importe, 0));
    lineas.push(`${ETIQUETA_PAGO[tipo]} — ${arr.length} — ${money(sub, moneda)}`);
    for (const p of arr) {
      lineas.push('   · ' + money(p.importe, moneda)
        + (p.fecha ? ' · ' + p.fecha : '')
        + (p.codigo ? ' · cheque ' + p.codigo : ''));
    }
  }
  const total = round2(pagos.reduce((a, p) => a + p.importe, 0));
  lineas.push(`TOTAL: ${money(total, moneda)}`);
  return lineas.join('\n');
}

function pagosDe(solicitudId) {
  return db.prepare('SELECT * FROM sp_pago_detalle WHERE solicitud_id=? ORDER BY orden, id').all(solicitudId);
}

const nombreDe = (uid) => {
  try {
    const u = db.prepare('SELECT nombre FROM usuarios WHERE id=?').get(uid);
    return u ? u.nombre : null;
  } catch (e) { return null; }
};

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
  // Texto libre y obligatoria: manejan varias condiciones y no entran en una lista
  // fija. La escribe el comprador, que es el que la negoció.
  const condicion = vCondicion(b.condicion_pago);

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

  // A quién le pide el OK. Se valida contra los elegibles reales: si el solicitante
  // manda cualquier id, el aviso iría a alguien que no puede resolver.
  let autorizadorId = null;
  if (b.autorizador_id) {
    const pasoAut = (def.pasos || []).find(p => p.hito === 'autorizacion');
    const ficticia = { id: 0, solicitante_id: req.user.id };
    const elegibles = pasoAut
      ? resolverAutorizados(def, pasoAut.clave, ficticia).resolutores
          .filter(u => u.email && !bloqueadoPorSoD(def, ficticia, pasoAut.clave, u.id))
      : [];
    const el = elegibles.filter(u => u.id === Number(b.autorizador_id))[0];
    if (!el) throw bad('La persona elegida para autorizar no está habilitada para este paso');
    autorizadorId = el.id;
  }

  const id = db.transaction(() => {
    const numero = numeroNuevo(soc);
    const r = db.prepare(`
      INSERT INTO sp_solicitudes
        (sociedad_id, numero, flujo_version_id, def_snapshot_json, solicitante_id, solicitante_nombre,
         proveedor_texto, cuenta_texto, concepto, monto, moneda, comprobante_tipo, comprobante_numero,
         fecha_necesidad, prioridad, justificacion_duplicado, autorizador_id, condicion_pago,
         paso_actual_clave, paso_actual_hito, paso_actual_desde, estado_global)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),'en_curso')
    `).run(soc, numero, v.id, JSON.stringify(def), req.user.id, req.user.nombre || null,
           proveedor, vCuenta(b.cuenta_texto), concepto, monto, moneda,
           vTexto(b.comprobante_tipo, 'El tipo de comprobante', { max: 30 }), cbteNum,
           vFecha(b.fecha_necesidad, 'La fecha de necesidad'),
           b.prioridad === 'urgente' ? 'urgente' : 'normal',
           vTexto(b.justificacion_duplicado, 'La justificación', { max: 500 }), autorizadorId, condicion,
           inicio.clave, inicio.hito || null);
    const solId = r.lastInsertRowid;
    registrarEvento(solId, {
      paso_hasta: inicio.clave, accion: 'crear', hito: null,
      actor_id: req.user.id, actor_nombre: req.user.nombre, actor_rol: req.user.rol,
      // Queda registrado A QUIÉN se le pidió el OK. Sirve para el seguimiento y
      // para que se pueda ver si alguien siempre le pide a la misma persona.
      datos_json: { monto, moneda, proveedor, autorizador_id: autorizadorId }
    });
    return solId;
  })();

  res.json({ ok: true, id, siguiente: 'Cargala y usá "Enviar a autorizar" cuando esté lista.' });
}));

// A quién se le pidió ESTE paso, si es que se le pidió a alguien. Hoy solo el
// hito de autorización lo tiene: el comprador elige a qué administrador le manda
// el OK, justamente para no dispararle un mail a todos.
//
// Devuelve null cuando no hay nadie designado, o cuando el designado no puede
// resolverlo (lo dieron de baja, o la segregación de funciones lo frena): en ese
// caso vuelve a ser de todos, que es lo que evita que un pedido quede trabado.
function dirigidaA(def, sol, puedenActuar) {
  const paso = (def.pasos || []).find(p => p.clave === sol.paso_actual_clave);
  if (!paso || paso.hito !== 'autorizacion' || !sol.autorizador_id) return null;
  return puedenActuar.filter(u => u.id === sol.autorizador_id)[0] || null;
}

// Bandejas. Todo GET: tienen que funcionar para usuarios solo lectura.
//   mias      — lo que pedí yo (la vista del comprador)
//   pendiente — lo que me toca resolver A MÍ
//   otros     — lo que puedo resolver pero se lo pidieron a otro
//   todas     — el tablero (admin)
router.get('/solicitudes', wrap((req, res) => {
  const soc = getSociedadId(req);
  const vista = ['mias', 'pendiente', 'otros', 'todas'].includes(req.query.vista) ? req.query.vista : 'mias';
  // Los filtros van en SQL y NO en el navegador, justamente por el LIMIT 400:
  // filtrando del lado del cliente, buscar un proveedor de hace cuatro meses
  // devolvería vacío —porque esa fila nunca llegó— y el comprador concluiría que
  // el pago no existe. Filtrando en la consulta, el límite recorta lo que sobra
  // del resultado ya filtrado.
  const params = [soc];
  let where = ' WHERE s.sociedad_id=? AND s.eliminado_en IS NULL';
  if (vista === 'mias') { where += ' AND s.solicitante_id = ?'; params.push(req.user.id); }
  if (req.query.estado) { where += ' AND s.estado_global = ?'; params.push(req.query.estado); }
  if (req.query.paso)   { where += ' AND s.paso_actual_clave = ?'; params.push(req.query.paso); }
  if (req.query.solicitante_id) {
    where += ' AND s.solicitante_id = ?';
    params.push(parseInt(req.query.solicitante_id, 10) || 0);
  }
  // Buscador libre: número, proveedor, concepto y cuenta corriente. Son los
  // cuatro campos por los que se busca un pago en la vida real — y la cuenta
  // corriente entra porque es con lo que se rastrea en el otro sistema.
  const q = String(req.query.q || '').trim();
  if (q) {
    where += ` AND (s.numero LIKE ? OR s.proveedor_texto LIKE ? OR s.concepto LIKE ?
                    OR s.cuenta_texto LIKE ?)`;
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  // Cuántas hay ANTES del tope, para poder decir "400 de 1.230" en vez de mostrar
  // 400 como si fueran todas.
  const total = db.prepare(`SELECT COUNT(*) AS n FROM sp_solicitudes s${where}`).get(...params).n;

  const sql = `
    SELECT s.*, (SELECT COUNT(*) FROM sp_eventos e WHERE e.solicitud_id = s.id) AS n_eventos
    FROM sp_solicitudes s${where}
    ORDER BY CASE s.prioridad WHEN 'urgente' THEN 0 ELSE 1 END, s.id DESC LIMIT 400`;
  let filas = db.prepare(sql).all(...params);

  // Se calculan las acciones POR FILA: una bandeja que no dice qué hacer obliga a
  // abrir cada solicitud de a una, y con 40 pedidos nadie hace eso.
  filas = filas.map(s => {
    const def = defDe(s);
    const acciones = accionesDisponibles(def, s, req.user);
    const paso = (def.pasos || []).find(p => p.clave === s.paso_actual_clave);
    // Habilitado en el paso pero frenado por segregación de funciones. Se informa
    // en vez de esconderse: si no, el usuario ve la bandeja vacía sabiendo que le
    // llegó un aviso, y concluye que la herramienta no funciona.
    const { resolutores } = resolverAutorizados(def, s.paso_actual_clave, s);
    const habilitado = req.user.rol === 'admin' || resolutores.some(u => u.id === req.user.id);
    const bloqueo = (habilitado && s.estado_global === 'en_curso')
      ? bloqueadoPorSoD(def, s, s.paso_actual_clave, req.user.id) : null;
    const puedenActuar = resolutores.filter(u => !bloqueadoPorSoD(def, s, s.paso_actual_clave, u.id));
    // El comprador eligió a quién le pide el OK. Si se lo pidió a OTRO, esto no
    // es "me toca a mí": puedo resolverlo, pero la pelota es de esa persona.
    // Sin esta distinción, la semilla habilita rol=admin en todos los pasos y
    // entonces cada administrador ve TODO en su bandeja, que es lo mismo que no
    // tener bandeja.
    const dirig = dirigidaA(def, s, puedenActuar);

    // "ME TOCA A MÍ" = SOY UNO DE LOS DESIGNADOS PARA ESTE PASO.
    // Poder resolverlo por ser administrador NO es lo mismo. Esa regla existe
    // para DESTRABAR —que un pago no quede clavado porque el responsable no
    // está— no para meterle en la bandeja a cada admin el trabajo de todos.
    //
    // Sin esta distinción, un admin ve la confección, la firma y el envío de
    // comprobantes de todas las solicitudes, aunque haya alguien designado para
    // cada paso. Con seis pagos en curso la bandeja deja de significar algo.
    const soyDesignado = puedenActuar.some(u => u.id === req.user.id);
    // Si NADIE puede resolverlo, la solicitud está trabada de verdad: ahí sí
    // tiene que aparecerle al admin, que es el único que puede destrabarla.
    const nadiePuede = puedenActuar.length === 0;
    const soloPorSerAdmin = !soyDesignado && !nadiePuede && acciones.length > 0;

    return {
      ...s, def_snapshot_json: undefined,
      paso_nombre: paso ? paso.nombre : s.paso_actual_clave,
      paso_instrucciones: paso ? paso.instrucciones : null,
      acciones, bloqueo_sod: bloqueo,
      autorizador_nombre: s.autorizador_id ? nombreDe(s.autorizador_id) : null,
      dirigida_a: dirig ? dirig.nombre : null,
      dirigida_a_otro: !!(dirig && dirig.id !== req.user.id) || soloPorSerAdmin,
      // Para que la pantalla pueda decir POR QUÉ no es suya: se la pidieron a
      // alguien, o simplemente el paso es de otro.
      solo_por_ser_admin: soloPorSerAdmin,
      // A quién le toca de verdad: es lo que el usuario necesita saber cuando no
      // puede actuar él.
      esperando_a: puedenActuar.map(u => u.nombre),
      vencida: !!(s.vence_en && s.estado_global === 'en_curso' && s.vence_en < new Date().toISOString().slice(0, 19).replace('T', ' '))
    };
  });
  // "Me toca a mí" es lo que está esperando POR MÍ. Lo que le toca a otro sigue
  // siendo resolvible —si esa persona no está, el pedido no se traba— pero vive
  // en su propia solapa en vez de ensuciar la bandeja.
  if (vista === 'pendiente') {
    filas = filas.filter(s => (s.acciones.length > 0 || s.bloqueo_sod) && !s.dirigida_a_otro);
  }
  if (vista === 'otros') filas = filas.filter(s => s.acciones.length > 0 && s.dirigida_a_otro);

  // Las opciones de los filtros salen de la definición vigente del circuito y de
  // los solicitantes que REALMENTE pidieron algo, no de una lista escrita a mano:
  // si mañana se agrega un paso al circuito, aparece solo en el desplegable.
  // defDe() lee el snapshot congelado de UNA solicitud; para las opciones hace
  // falta la definición VIGENTE, que es la de la versión activa del circuito.
  let pasos = [];
  try {
    const v = versionActiva();
    if (v) {
      pasos = (armarSnapshot(v.id).pasos || [])
        .filter(p => p.tipo !== 'final_ok' && p.tipo !== 'final_rechazo')
        .map(p => ({ clave: p.clave, nombre: p.nombre }));
    }
  } catch (e) {
    console.error('[SP] No se pudieron armar las opciones de paso:', e.message);
  }
  const solicitantes = db.prepare(`
    SELECT DISTINCT s.solicitante_id AS id, s.solicitante_nombre AS nombre
      FROM sp_solicitudes s
     WHERE s.sociedad_id=? AND s.eliminado_en IS NULL AND s.solicitante_nombre IS NOT NULL
     ORDER BY s.solicitante_nombre COLLATE NOCASE
  `).all(soc);

  res.json({
    ok: true, data: filas, vista,
    // total es ANTES del tope de 400 y ANTES del filtrado por bandeja; sirve para
    // avisar que hay más de lo que se está viendo.
    total, tope: 400,
    opciones: { pasos, solicitantes }
  });
}));

router.get('/solicitudes/:id', wrap((req, res) => {
  const soc = getSociedadId(req);
  const s = getSol(soc, parseInt(req.params.id, 10));
  const def = defDe(s);
  const paso = (def.pasos || []).find(p => p.clave === s.paso_actual_clave);
  const eventos = db.prepare('SELECT * FROM sp_eventos WHERE solicitud_id=? ORDER BY seq').all(s.id);
  const adjuntos = db.prepare('SELECT id, nombre, mime, tamano, tipo, creado_en FROM sp_adjuntos WHERE solicitud_id=? AND eliminado_en IS NULL').all(s.id);
  const { resolutores } = resolverAutorizados(def, s.paso_actual_clave, s);
  // tiempos.tramos trae la duración de cada paso resuelto, en el mismo orden que
  // los eventos que lo resolvieron: el historial dice quién hizo qué, y esto dice
  // cuánto tardó cada tramo.
  const t = tiemposDe(s, eventos);
  res.json({
    ok: true,
    data: {
      solicitud: { ...s, def_snapshot_json: undefined,
                   autorizador_nombre: s.autorizador_id ? nombreDe(s.autorizador_id) : null,
                   // Mismo dato que en la bandeja, para que el diálogo de acción
                   // avise igual cuando se entra por el link del mail y no por la lista.
                   dirigida_a_otro: !!dirigidaA(def, s,
                     resolutores.filter(u => !bloqueadoPorSoD(def, s, s.paso_actual_clave, u.id))
                   ) && s.autorizador_id !== req.user.id },
      paso: paso || null,
      pasos: def.pasos,
      acciones: accionesDisponibles(def, s, req.user),
      bloqueo_sod: bloqueadoPorSoD(def, s, s.paso_actual_clave, req.user.id),
      // Para admins: qué separación estarían salteando si resuelven. Se avisa antes
      // de actuar, no después.
      sod_omitida: sodOmitida(def, s, s.paso_actual_clave, req.user.id),
      esperando_a: resolutores.map(u => ({ id: u.id, nombre: u.nombre })),
      eventos, adjuntos,
      pagos: pagosDe(s.id),
      tiempos: t
    }
  });
}));

// ── Adjuntos ──────────────────────────────────────────────────────────────

router.get('/solicitudes/:id/adjuntos', wrap((req, res) => {
  const soc = getSociedadId(req);
  const s = getSol(soc, parseInt(req.params.id, 10));
  const data = db.prepare(`
    SELECT id, nombre, mime, tamano, tipo, descripcion, creado_en, creado_por_id
    FROM sp_adjuntos WHERE solicitud_id=? AND eliminado_en IS NULL ORDER BY id DESC
  `).all(s.id);
  res.json({ ok: true, data, tipos: TIPOS_ADJUNTO, storage_ok: storageConfigurado() });
}));

// No usa wrap() porque subir a R2 es async y el helper es síncrono.
router.post('/solicitudes/:id/adjuntos', subida.single('archivo'), async (req, res) => {
  try {
    const soc = getSociedadId(req);
    const s = db.prepare('SELECT * FROM sp_solicitudes WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL')
      .get(parseInt(req.params.id, 10), soc);
    if (!s) return res.status(404).json({ ok: false, error: 'Solicitud no encontrada' });
    if (!storageConfigurado()) {
      return res.status(503).json({ ok: false, error: 'El almacenamiento de archivos no está configurado (faltan credenciales de R2)' });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: 'Falta el archivo' });
    const tipo = TIPOS_ADJUNTO[req.body?.tipo] ? req.body.tipo : 'otro';

    const limpio = String(req.file.originalname || 'archivo').replace(/[^\w.\-]+/g, '_').slice(-80);
    const key = `sp/solicitudes/${s.id}/${randomUUID()}-${limpio}`;
    await subirArchivo(req.file.buffer, key, req.file.mimetype || 'application/octet-stream');

    const r = db.prepare(`
      INSERT INTO sp_adjuntos (solicitud_id, storage_key, nombre, mime, tamano, tipo, descripcion, creado_por_id)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(s.id, key, req.file.originalname || limpio, req.file.mimetype || null,
           req.file.size || null, tipo, (req.body?.descripcion || '').slice(0, 300) || null, req.user.id);

    // Queda en el historial: un adjunto que respalda una orden de pago tiene que
    // poder rastrearse igual que una decisión.
    registrarEvento(s.id, {
      paso_desde: s.paso_actual_clave, paso_hasta: s.paso_actual_clave, accion: 'adjuntar',
      actor_id: req.user.id, actor_nombre: req.user.nombre, actor_rol: req.user.rol,
      datos_json: { adjunto_id: r.lastInsertRowid, nombre: req.file.originalname, tipo }
    });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    console.error('[SP] Error subiendo adjunto:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/adjuntos/:adjId', async (req, res) => {
  try {
    const soc = getSociedadId(req);
    const a = db.prepare(`
      SELECT a.* FROM sp_adjuntos a JOIN sp_solicitudes s ON s.id = a.solicitud_id
      WHERE a.id=? AND s.sociedad_id=? AND a.eliminado_en IS NULL
    `).get(parseInt(req.params.adjId, 10), soc);
    if (!a) return res.status(404).json({ ok: false, error: 'Adjunto no encontrado' });
    if (!storageConfigurado()) return res.status(503).json({ ok: false, error: 'Almacenamiento no configurado' });
    const stream = await obtenerArchivo(a.storage_key);
    res.set({
      'Content-Type': a.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${String(a.nombre).replace(/"/g, '')}"`
    });
    stream.pipe(res);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Baja lógica. El archivo se conserva en R2: un respaldo de pago no se borra por
// un click equivocado.
router.delete('/adjuntos/:adjId', wrap((req, res) => {
  const soc = getSociedadId(req);
  const a = db.prepare(`
    SELECT a.* FROM sp_adjuntos a JOIN sp_solicitudes s ON s.id = a.solicitud_id
    WHERE a.id=? AND s.sociedad_id=? AND a.eliminado_en IS NULL
  `).get(parseInt(req.params.adjId, 10), soc);
  if (!a) throw noEncontrado('Adjunto no encontrado');
  db.prepare("UPDATE sp_adjuntos SET eliminado_en=datetime('now','localtime') WHERE id=?").run(a.id);
  registrarEvento(a.solicitud_id, {
    accion: 'quitar_adjunto', actor_id: req.user.id, actor_nombre: req.user.nombre,
    actor_rol: req.user.rol, datos_json: { adjunto_id: a.id, nombre: a.nombre, tipo: a.tipo }
  });
  res.json({ ok: true });
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
  // Segregación de funciones. Los administradores pasan por encima (decisión del
  // dueño del sistema); para el resto bloquea.
  const sod = bloqueadoPorSoD(def, s, paso.clave, req.user.id);
  if (sod) throw Object.assign(new Error(sod), { status: 403 });
  // Si un admin está salteando una separación, queda registrado en el evento: es lo
  // que permite distinguir después una autorización sobre la propia solicitud de
  // una normal.
  const omitida = sodOmitida(def, s, paso.clave, req.user.id);

  const comentario = vTexto(b.comentario, 'El comentario', { max: 1000 });
  if ((tr.requiere_comentario || paso.requiere_comentario) && !comentario) {
    throw bad('Este paso pide que dejes un comentario explicando por qué');
  }

  // Requisitos por modo de captura
  const datos = {};
  let pagos = null;
  if (paso.modo_captura === 'informa_fecha' && tr.clase === 'avanza') {
    datos.fecha_pago = vFecha(b.fecha_pago, 'La fecha de pago');
    if (!datos.fecha_pago) throw bad('Tenés que informar la fecha de pago');
    pagos = validarComposicion(b.pagos, s, datos.fecha_pago);
    datos.composicion = pagos.map(p => ({ tipo: p.tipo, importe: p.importe, fecha: p.fecha, codigo: p.codigo }));
  }
  // Adjunto OBLIGATORIO del paso. El caso concreto: no se puede mandar a firmar una
  // orden sin el PDF de cuenta corriente del proveedor que la respalda.
  // El paso de comprobantes queda afuera porque tiene su propia regla blanda.
  if (paso.requiere_adjunto_tipo && tr.clase === 'avanza' && paso.modo_captura !== 'envia_comprobantes') {
    // '*' = hace falta un respaldo pero el tipo lo decide quien lo sube: el del
    // comprador puede ser factura, proforma o remito según el caso.
    const cualquiera = paso.requiere_adjunto_tipo === '*';
    const n = cualquiera
      ? db.prepare('SELECT COUNT(*) AS n FROM sp_adjuntos WHERE solicitud_id=? AND eliminado_en IS NULL').get(s.id).n
      : db.prepare(`
          SELECT COUNT(*) AS n FROM sp_adjuntos
          WHERE solicitud_id=? AND tipo=? AND eliminado_en IS NULL
        `).get(s.id, paso.requiere_adjunto_tipo).n;
    if (!n) {
      throw bad(cualquiera
        ? 'Antes de enviarla tenés que adjuntar el respaldo (factura, proforma o remito).'
        : `Antes de avanzar tenés que adjuntar: ${TIPOS_ADJUNTO[paso.requiere_adjunto_tipo] || paso.requiere_adjunto_tipo}.`);
    }
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
    if (pagos) {
      // Reemplazo total: si vuelve a pasar por el paso (devolución), la composición
      // se rehace entera y no quedan líneas viejas mezcladas con las nuevas.
      db.prepare('DELETE FROM sp_pago_detalle WHERE solicitud_id=?').run(s.id);
      const insP = db.prepare(`
        INSERT INTO sp_pago_detalle (solicitud_id, tipo, importe, fecha, codigo, notas, orden, creado_por_id)
        VALUES (?,?,?,?,?,?,?,?)
      `);
      pagos.forEach((p, i) => insP.run(s.id, p.tipo, p.importe, p.fecha, p.codigo, p.notas, i, req.user.id));
    }
    const detalle = { ...datos };
    if (omitida) detalle.sod_omitida = omitida;
    // Resolver un paso que el comprador le pidió a OTRA persona queda registrado.
    // No está prohibido —para eso está la solapa "Dirigidas a otro", que es lo que
    // destraba un pedido cuando el elegido no está— pero después alguien va a
    // preguntar por qué firmó quien firmó, y el historial tiene que contestarlo.
    if (paso.hito === 'autorizacion' && s.autorizador_id && s.autorizador_id !== req.user.id) {
      detalle.en_lugar_de = nombreDe(s.autorizador_id);
    }
    const evId = registrarEvento(s.id, {
      paso_desde: paso.clave, paso_hasta: tr.hasta, accion, hito: paso.hito, clase: tr.clase,
      actor_id: req.user.id, actor_nombre: req.user.nombre, actor_rol: req.user.rol,
      comentario, datos_json: Object.keys(detalle).length ? detalle : null,
      via: omitida ? 'admin' : 'panel'
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
    // FIRMADA: para el comprador, acá termina el proceso de pago. La orden está
    // autorizada, con fecha, confeccionada y firmada — puede cerrar el seguimiento
    // con el proveedor. Antes solo se enteraba al llegar a "cerrada", que depende
    // de que alguien mande los comprobantes y puede tardar días o no pasar nunca.
    //
    // No se manda si el destino ya es el cierre (circuito sin paso de
    // comprobantes): ahí alcanza con el aviso de cerrado y serían dos mails por el
    // mismo click. Y tampoco si el que firmó ES el comprador: ya lo sabe.
    if (paso.hito === 'firma' && tr.clase === 'avanza'
        && cambio.estado !== 'aprobada_final' && req.user.id !== s.solicitante_id) {
      avisarSolicitante(def, solFresca, 'firmado', evId, { actor: req.user.nombre });
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
      comprobante_tipo=?, comprobante_numero=?, fecha_necesidad=?, prioridad=?, condicion_pago=?, rev=rev+1
    WHERE id=?
  `).run(
    b.proveedor_texto === undefined ? s.proveedor_texto : vTexto(b.proveedor_texto, 'El proveedor', { req: true, max: 200 }),
    // Se valida el valor FINAL, no solo el que llega: si la solicitud es vieja y
    // tiene la cuenta vacía, editarla obliga a completarla, que es lo que hace que
    // el dato sirva para rastrear.
    vCuenta(b.cuenta_texto === undefined ? s.cuenta_texto : b.cuenta_texto),
    b.concepto === undefined ? s.concepto : vTexto(b.concepto, 'El concepto', { req: true, max: 500 }),
    b.monto === undefined ? s.monto : vNum(b.monto, 'El monto', { min: 0.01 }),
    b.moneda === undefined ? s.moneda : String(b.moneda).toUpperCase(),
    b.comprobante_tipo === undefined ? s.comprobante_tipo : vTexto(b.comprobante_tipo, 'El tipo', { max: 30 }),
    b.comprobante_numero === undefined ? s.comprobante_numero : vTexto(b.comprobante_numero, 'El número', { max: 60 }),
    b.fecha_necesidad === undefined ? s.fecha_necesidad : vFecha(b.fecha_necesidad, 'La fecha'),
    b.prioridad === undefined ? s.prioridad : (b.prioridad === 'urgente' ? 'urgente' : 'normal'),
    // Se valida el valor FINAL: una solicitud vieja sin condición obliga a
    // completarla al editarla.
    vCondicion(b.condicion_pago === undefined ? s.condicion_pago : b.condicion_pago),
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

// ══════════════════════════════════════════════════════════════════════════
// TIEMPOS — dónde están las demoras
// ══════════════════════════════════════════════════════════════════════════
// Los timestamps se guardan como texto 'YYYY-MM-DD HH:MM:SS'. Se parsean con
// Date.UTC a propósito: los dos lados de cada resta salen del mismo reloj, así que
// la diferencia es exacta sin importar la zona horaria del contenedor.
function msDe(t) {
  const m = String(t || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
const horasEntre = (a, b) => {
  const x = msDe(a), y = msDe(b);
  return (x === null || y === null) ? null : (y - x) / 3600000;
};
function percentil(arr, p) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}
const prom = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

// Duración de cada paso de UNA solicitud. El tiempo en un paso va desde que se
// entró (el evento anterior, o la creación) hasta que se resolvió.
function tiemposDe(sol, eventos) {
  const evs = eventos.slice().sort((a, b) => a.seq - b.seq);
  const tramos = [];
  let entradaEn = sol.creado_en;
  let entradaPaso = evs.length ? (evs[0].paso_hasta || sol.paso_actual_clave) : sol.paso_actual_clave;

  for (const e of evs) {
    if (e.accion === 'crear' || e.accion === 'editar') { entradaEn = e.creado_en; continue; }
    tramos.push({
      paso: e.paso_desde, accion: e.accion, hito: e.hito, clase: e.clase,
      desde: entradaEn, hasta: e.creado_en,
      horas: horasEntre(entradaEn, e.creado_en),
      actor: e.actor_nombre
    });
    entradaEn = e.creado_en;
    entradaPaso = e.paso_hasta;
  }
  // Si sigue abierta, el paso actual lleva tiempo corriendo.
  let abierto = null;
  if (sol.estado_global === 'en_curso') {
    abierto = { paso: sol.paso_actual_clave, desde: sol.paso_actual_desde || entradaEn, horas: null };
    abierto.horas = horasEntre(abierto.desde, new Date().toISOString().slice(0, 19).replace('T', ' '));
  }

  const evFirma = evs.find(e => e.hito === 'firma' && e.clase === 'avanza');
  const devoluciones = evs.filter(e => e.clase === 'devuelve').length;

  return {
    tramos, abierto, devoluciones,
    horas_hasta_firma: evFirma ? horasEntre(sol.creado_en, evFirma.creado_en) : null,
    horas_hasta_cierre: sol.cerrado_en ? horasEntre(sol.creado_en, sol.cerrado_en) : null,
    horas_transcurridas: horasEntre(sol.creado_en,
      sol.cerrado_en || new Date().toISOString().slice(0, 19).replace('T', ' '))
  };
}

// Tablero de tiempos: es lo que responde "dónde tenemos las demoras".
// SOLO ADMINISTRADORES. Es un tablero de desempeño: dice cuánto tarda cada paso y,
// por lo tanto, quién demora. Esconder la solapa en el panel no alcanza — el
// endpoint responde igual a cualquiera con sesión, y la URL está a la vista en el
// código que el navegador se descarga.
router.get('/metricas', wrap((req, res) => {
  if (!esAdmin(req)) throw Object.assign(new Error('Solo administradores'), { status: 403 });
  const soc = getSociedadId(req);
  const sols = db.prepare(`
    SELECT * FROM sp_solicitudes WHERE sociedad_id=? AND eliminado_en IS NULL
  `).all(soc);
  if (!sols.length) return res.json({ ok: true, data: { vacio: true } });

  const evs = db.prepare(`
    SELECT e.* FROM sp_eventos e JOIN sp_solicitudes s ON s.id = e.solicitud_id
    WHERE s.sociedad_id=? AND s.eliminado_en IS NULL ORDER BY e.solicitud_id, e.seq
  `).all(soc);
  const porSol = new Map();
  for (const e of evs) {
    if (!porSol.has(e.solicitud_id)) porSol.set(e.solicitud_id, []);
    porSol.get(e.solicitud_id).push(e);
  }

  // Nombres de paso: se toman del snapshot de cada solicitud, que es la definición
  // con la que efectivamente se rigió.
  const nombrePaso = {};
  const porPaso = {};          // clave -> horas[]
  const esperandoAhora = {};   // clave -> horas[] de las que están frenadas ahí
  const hastaFirma = [];
  const hastaCierre = [];
  let devolucionesTot = 0;
  const detalle = [];

  for (const s of sols) {
    let def = null;
    try { def = JSON.parse(s.def_snapshot_json); } catch (_) {}
    (def?.pasos || []).forEach(p => { nombrePaso[p.clave] = p.nombre; });

    const t = tiemposDe(s, porSol.get(s.id) || []);
    devolucionesTot += t.devoluciones;
    for (const tr of t.tramos) {
      if (tr.horas === null || !tr.paso) continue;
      (porPaso[tr.paso] = porPaso[tr.paso] || []).push(tr.horas);
    }
    if (t.abierto && t.abierto.horas !== null) {
      (esperandoAhora[t.abierto.paso] = esperandoAhora[t.abierto.paso] || []).push(t.abierto.horas);
    }
    if (t.horas_hasta_firma !== null) hastaFirma.push(t.horas_hasta_firma);
    if (t.horas_hasta_cierre !== null) hastaCierre.push(t.horas_hasta_cierre);

    detalle.push({
      id: s.id, numero: s.numero, proveedor: s.proveedor_texto,
      monto: s.monto, moneda: s.moneda, estado: s.estado_global,
      paso: s.paso_actual_clave, paso_nombre: nombrePaso[s.paso_actual_clave] || s.paso_actual_clave,
      devoluciones: t.devoluciones,
      horas_hasta_firma: t.horas_hasta_firma,
      horas_transcurridas: t.horas_transcurridas,
      esperando_horas: t.abierto ? t.abierto.horas : null
    });
  }

  const pasos = Object.keys(porPaso).map(clave => ({
    clave, nombre: nombrePaso[clave] || clave,
    n: porPaso[clave].length,
    horas_prom: prom(porPaso[clave]),
    horas_p50: percentil(porPaso[clave], 50),
    horas_max: Math.max(...porPaso[clave]),
    // Lo que está frenado AHÍ en este momento: distingue "este paso es lento" de
    // "este paso está tapado hoy".
    en_espera: (esperandoAhora[clave] || []).length,
    en_espera_horas_max: (esperandoAhora[clave] || []).length ? Math.max(...esperandoAhora[clave]) : null
  })).sort((a, b) => (b.horas_prom || 0) - (a.horas_prom || 0));

  res.json({
    ok: true,
    data: {
      global: {
        n_total: sols.length,
        n_firmadas: hastaFirma.length,
        n_cerradas: hastaCierre.length,
        n_en_curso: sols.filter(s => s.estado_global === 'en_curso').length,
        devoluciones: devolucionesTot,
        horas_prom_hasta_firma: prom(hastaFirma),
        horas_p50_hasta_firma: percentil(hastaFirma, 50),
        horas_max_hasta_firma: hastaFirma.length ? Math.max(...hastaFirma) : null,
        horas_prom_hasta_cierre: prom(hastaCierre)
      },
      pasos,
      // Las más demoradas, que es donde se mira primero.
      mas_demoradas: detalle.slice()
        .filter(d => d.estado === 'en_curso')
        .sort((a, b) => (b.esperando_horas || 0) - (a.esperando_horas || 0)).slice(0, 15),
      mas_lentas_firmadas: detalle.slice()
        .filter(d => d.horas_hasta_firma !== null)
        .sort((a, b) => b.horas_hasta_firma - a.horas_hasta_firma).slice(0, 10)
    }
  });
}));

// Mail de prueba: sirve para verificar, ANTES de lanzar, que Brevo esté
// configurado y que la dirección del usuario sea la correcta. Encola igual que un
// aviso real, así se prueba el camino completo y no solo la API de Brevo.
router.post('/probar-mail', wrap((req, res) => {
  if (!esAdmin(req)) throw Object.assign(new Error('Solo administradores'), { status: 403 });
  const uid = vNum(req.body?.usuario_id, 'El usuario', { min: 1 });
  const u = db.prepare('SELECT id, nombre, email FROM usuarios WHERE id=? AND activo=1').get(uid);
  if (!u) throw bad('El usuario no existe o está inactivo');
  if (!u.email) throw bad(`${u.nombre} no tiene mail cargado en su usuario: no hay a dónde avisarle.`);

  // dedup_key con marca de tiempo para poder mandar varias pruebas.
  const marca = new Date().toISOString().replace(/[^0-9]/g, '');
  encolar({
    solicitudId: null, eventoId: null,
    dedupKey: 'prueba:' + uid + ':' + marca,
    destinatarios: [u.email],
    asunto: 'Prueba de avisos · Órdenes de Pago',
    cuerpo: `Hola ${u.nombre},\n\n`
      + 'Este es un mail de prueba del circuito de órdenes de pago. Si lo estás leyendo, '
      + 'los avisos del circuito te van a llegar a esta dirección.\n\n'
      + `Enviado por ${req.user.nombre || 'un administrador'} desde el panel.\n\n${PANEL_URL}\n`
  });
  procesarEnBackground();
  res.json({ ok: true, email: u.email, nombre: u.nombre });
}));

// ══════════════════════════════════════════════════════════════════════════
// INSTRUCTIVO DE USO
// ══════════════════════════════════════════════════════════════════════════
// Se arma desde el CIRCUITO configurado, no escrito a mano: los nombres de cada
// paso salen de los habilitados de verdad, así el instructivo no queda
// desactualizado cuando cambia quién hace qué. Para capacitar a alguien nuevo, el
// "quién lo hace hoy" es lo que traduce el rol a una persona.

router.get('/instructivo', wrap((req, res) => {
  const v = versionActiva();
  if (!v) throw noEncontrado('No hay circuito activo');
  const def = armarSnapshot(v.id);
  const ficticia = { id: 0, solicitante_id: 0 };

  const pasos = (def.pasos || [])
    .filter(p => p.tipo !== 'final_ok' && p.tipo !== 'final_rechazo')
    .map(p => {
      const { resolutores, watchers } = resolverAutorizados(def, p.clave, ficticia);
      const salidas = (def.transiciones || [])
        .filter(t => t.desde === p.clave)
        .map(t => ({ etiqueta: t.etiqueta, clase: t.clase, hasta: t.hasta,
                     hasta_nombre: (def.pasos.find(x => x.clave === t.hasta) || {}).nombre || t.hasta }));
      return {
        clave: p.clave, nombre: p.nombre, hito: p.hito, orden: p.orden,
        modo_captura: p.modo_captura, sla_horas: p.sla_horas,
        instrucciones: p.instrucciones,
        // Quién lo hace HOY. Es lo que traduce "rol admin" a nombres concretos.
        personas: resolutores.map(u => ({ nombre: u.nombre, email: u.email })),
        avisados: watchers.map(u => ({ nombre: u.nombre, email: u.email })),
        acciones: salidas
      };
    })
    .sort((a, b) => a.orden - b.orden);

  const incomp = (def.incompatibilidades || []).map(i => ({ a: i.hito_a, b: i.hito_b }));
  res.json({
    ok: true,
    data: {
      flujo: { nombre: v.flujo_nombre, version: v.version },
      pasos,
      incompatibilidades: incomp,
      generado_en: new Date().toISOString().slice(0, 10)
    }
  });
}));

// Se manda el instructivo por mail. Va por la misma cola que los avisos del
// circuito, así queda registrado a quién se le mandó y cuándo.
router.post('/instructivo/enviar', wrap((req, res) => {
  const uid = vNum(req.body?.usuario_id, 'El usuario', { min: 1 });
  const u = db.prepare('SELECT id, nombre, email FROM usuarios WHERE id=? AND activo=1').get(uid);
  if (!u) throw bad('El usuario no existe o está inactivo');
  if (!u.email) throw bad(`${u.nombre} no tiene mail cargado en su usuario`);
  const texto = vTexto(req.body?.texto, 'El texto', { req: true, max: 60000 });

  const marca = new Date().toISOString().replace(/[^0-9]/g, '');
  encolar({
    solicitudId: null, eventoId: null,
    dedupKey: 'instructivo:' + uid + ':' + marca,
    destinatarios: [u.email],
    asunto: 'Cómo usar el circuito de Órdenes de Pago',
    cuerpo: `Hola ${u.nombre},\n\n${texto}\n\nEntrá al panel: ${PANEL_URL}/panel\n`
  });
  procesarEnBackground();
  res.json({ ok: true, email: u.email, nombre: u.nombre });
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
