// src/rutas/cuentas.js
// ── PLAN DE CUENTAS — endpoints CRUD + log de auditoría ─────────────────
// Maestro contable: secciones, cuentas, soft-delete, reordenar, log.
// Auth: req.cookies.lnb_user (parseado a mano, mismo patrón que el resto).

import express from 'express';
import db from '../servicios/db.js';
// El cerrojo de empresa. Antes cada router tenia su propia copia de esta
// logica y todas ADIVINABAN cuando no les llegaba el dato: siete caian a
// Puente Cordon y dos a San Geronimo. El por que esta en el servicio.
import { exigirEmpresa, empresaFija, PUENTE_CORDON } from '../servicios/sociedad_modulo.js';
// LA MISMA REGLA QUE EN SAN GERÓNIMO. Esta pantalla no tenía NINGÚN freno: se
// anulaba el asiento de una compra, de una liquidación de venta, de una orden de
// pago o de una liquidación de personal, y la operación seguía viva y fuera del
// libro. Una sola regla para las tres pantallas que anulan asientos.
import { origenDeAsientoPa } from '../servicios/asientos.js';

const router = express.Router();

// ── helpers ────────────────────────────────────────────────────────────────
function getUser(req) {
  try {
    const c = req.cookies?.lnb_user;
    return c ? JSON.parse(c) : null;
  } catch (e) {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const u = getUser(req);
  if (!u || u.rol !== 'admin') {
    return res.status(403).json({ error: 'solo admin' });
  }
  req._user = u;
  next();
}

function requireAuth(req, res, next) {
  const u = getUser(req);
  if (!u) {
    return res.status(401).json({ error: 'no autenticado' });
  }
  req._user = u;
  next();
}

function logAccion({ cuenta_id = null, seccion_id = null, accion, detalle = null, usuario_id = null }) {
  db.prepare(`
    INSERT INTO pa_cuentas_log (cuenta_id, seccion_id, accion, detalle, usuario_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    cuenta_id,
    seccion_id,
    accion,
    detalle ? JSON.stringify(detalle) : null,
    usuario_id
  );
}

// ── DE QUÉ HABLA CADA RENGLÓN DEL LOG ──────────────────────────────────────
// El log resolvía el código y el nombre con un JOIN contra la fila. Eso
// funcionaba mientras "borrar" era en realidad "desactivar" y la fila seguía
// ahí. Desde que el borrado es real, la fila NO ESTÁ: el JOIN no encuentra
// nada y el renglón queda "borrar — — —", que en un plan de cuentas no sirve
// para nada, justo en el único caso en que el log importa.
//
// Por eso los borrados guardan código y nombre dentro de `detalle`, y esto los
// lee de ahí cuando la fila ya no existe. El orden es: primero la fila viva
// (puede haberse renombrado desde entonces, y ahí lo que vale es el nombre de
// hoy), y recién si no está, lo que quedó anotado.
//
// El caso del TÍTULO es aparte: su renglón guarda el seccion_id del PADRE, que
// sigue existiendo, así que el JOIN devuelve la sección y no el título. Para
// las acciones de título manda siempre el detalle.
const REF_LOG = `
           CASE WHEN l.cuenta_id IS NOT NULL
                THEN COALESCE(c.codigo, json_extract(l.detalle, '$.codigo')) END AS cuenta_codigo,
           CASE WHEN l.cuenta_id IS NOT NULL
                THEN COALESCE(c.nombre, json_extract(l.detalle, '$.nombre')) END AS cuenta_nombre,
           CASE WHEN l.seccion_id IS NULL THEN NULL ELSE COALESCE(
                CASE WHEN s.id IS NULL OR l.accion LIKE '%titulo%'
                     THEN NULLIF(TRIM(COALESCE(json_extract(l.detalle, '$.codigo'), '') || ' ' ||
                                      COALESCE(json_extract(l.detalle, '$.nombre'), '')), '') END,
                s.codigo || ' — ' || s.nombre) END AS seccion_nombre`;

// ── Multisociedad (Fase 1) ──────────────────────────────────────────────────
// El plan de cuentas es UNO POR SOCIEDAD. Las lecturas/escrituras se acotan a
// una sociedad. Si el request no manda sociedad_id, se usa Puente Cordón (PC)
// por defecto, para mantener compatibilidad con el panel actual (que todavía no
// envía la dimensión). El cableado del selector en la UI es follow-up.

// Resuelve la sociedad del request (query o body). Valida que exista; si no
// viene o es inválida, cae a PC.
// Delega en el cerrojo compartido. Se conserva el nombre para no tocar los
// llamadores: lo que cambia es que ya no adivina.
//
// Para LEER devuelve siempre la empresa de este modulo. Para ESCRIBIR hay que
// usar exigirEmpresa(req, res, ...), que ademas CORTA si el pedido viene con
// otra empresa.
function getSociedadId(req) {
  return empresaFija(PUENTE_CORDON);
}
// ── EL CERROJO, CONECTADO ─────────────────────────────────────────────────
// Corre ANTES que cualquier endpoint de este router. Si el pedido viene con OTRA
// empresa, corta con 403 y explica cuál esperaba.
//
// Estaba escrito y NO se llamaba: el PR que lo introdujo dejó el import puesto y
// ninguna llamada, así que getSociedadId devolvía la empresa del módulo pase lo
// que pase. Parado en San Gerónimo, este router contestaba con los datos de
// Puente Cordón en vez de cortar — exactamente al revés de lo que buscaba.
router.use((req, res, next) => {
  if (exigirEmpresa(req, res, PUENTE_CORDON) === null) return;   // ya contestó 403
  next();
});

// ═══════════════════════════════════════════════════════════════════════════
// TÍTULOS — listar / crear / editar / desactivar
// Nivel intermedio X.XX.XX entre sección (X.XX) y cuenta (X.XX.XX.XXXX).
// No son imputables — solo se usan para organizar el plan de cuentas.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/titulos', (req, res) => {
  const incluirInactivos = req.query.incluir_inactivos === '1';
  const sociedadId = getSociedadId(req);
  const seccionId = req.query.seccion_id ? parseInt(req.query.seccion_id, 10) : null;
  const params = [sociedadId];
  let sql = 'SELECT t.*, s.codigo AS seccion_codigo, s.nombre AS seccion_nombre FROM pa_cuentas_titulos t JOIN pa_cuentas_secciones s ON s.id = t.seccion_id WHERE t.sociedad_id = ?';
  if (!incluirInactivos) sql += ' AND t.activo = 1';
  if (seccionId) { sql += ' AND t.seccion_id = ?'; params.push(seccionId); }
  sql += ' ORDER BY t.codigo';
  res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

router.post('/titulos', requireAdmin, (req, res) => {
  const { codigo, nombre, seccion_id } = req.body || {};
  if (!codigo || !nombre || !seccion_id) {
    return res.status(400).json({ error: 'codigo, nombre y seccion_id son requeridos' });
  }
  const codigoStr = String(codigo).trim();
  // Formato obligatorio: X.XX.XX  (3 partes, ej: 1.01.01)
  if (!RE_TITULO.test(codigoStr)) {
    return res.status(400).json({ error: `"${codigoStr}" no sirve como código de título. ${AYUDA_TITULO}` });
  }
  const sec = db.prepare('SELECT id, sociedad_id, codigo FROM pa_cuentas_secciones WHERE id = ?').get(parseInt(seccion_id, 10));
  if (!sec) return res.status(400).json({ error: 'seccion_id inválido' });
  const sociedadId = sec.sociedad_id;
  const cuelga = noCuelgaDe(codigoStr, sec.codigo, 'la sección');
  if (cuelga) return res.status(400).json({ error: cuelga });
  const choque = codigoEnUso(db, sociedadId, codigoStr);
  if (choque) return res.status(400).json({ error: mensajeChoque(codigoStr, choque) });
  try {
    const r = db.prepare(`
      INSERT INTO pa_cuentas_titulos (sociedad_id, seccion_id, codigo, nombre, orden, activo)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(sociedadId, sec.id, codigoStr, String(nombre).trim(), codigoStr);
    logAccion({ seccion_id: sec.id, accion: 'crear_titulo', detalle: { codigo: codigoStr, nombre }, usuario_id: req._user?.id });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/titulos/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tit = db.prepare('SELECT * FROM pa_cuentas_titulos WHERE id = ?').get(id);
  if (!tit) return res.status(404).json({ error: 'título no encontrado' });
  const { nombre, codigo } = req.body || {};
  if (codigo !== undefined && String(codigo).trim() !== String(tit.codigo)) {
    const codigoStr = String(codigo).trim();
    if (!RE_TITULO.test(codigoStr)) {
      return res.status(400).json({ error: `"${codigoStr}" no sirve como código de título. ${AYUDA_TITULO}` });
    }
    const choque = codigoEnUso(db, tit.sociedad_id, codigoStr, { tabla: 'titulos', id });
    if (choque) return res.status(400).json({ error: mensajeChoque(codigoStr, choque) });
    db.prepare("UPDATE pa_cuentas_titulos SET codigo = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(codigoStr, id);
  }
  if (nombre && String(nombre).trim() !== tit.nombre) {
    db.prepare("UPDATE pa_cuentas_titulos SET nombre = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(String(nombre).trim(), id);
  }
  logAccion({ seccion_id: tit.seccion_id, accion: 'editar_titulo', detalle: { antes: tit, despues: req.body }, usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.delete('/titulos/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Se lee ANTES de borrar: después de un borrado real la fila ya no existe y no
  // hay forma de saber qué era. Va al log en `detalle`, que es lo único que
  // sobrevive. Ver el comentario largo en REF_LOG.
  const tit = db.prepare('SELECT * FROM pa_cuentas_titulos WHERE id = ?').get(id);
  if (!tit) return res.status(404).json({ error: 'título no encontrado' });
  // Mismo criterio que la sección: es estructura, se borra de verdad y libera el
  // código. Se cuentan las cuentas activas Y las desactivadas: las dos apuntan acá.
  const ctas = db.prepare('SELECT COUNT(*) c FROM pa_cuentas WHERE titulo_id = ?').get(id).c;
  if (ctas) {
    return res.status(400).json({
      error: `No se puede borrar: el título todavía tiene ${ctas} cuenta(s). `
           + `Movelas o borralas primero.`,
    });
  }
  db.prepare('DELETE FROM pa_cuentas_titulos WHERE id = ?').run(id);
  logAccion({ seccion_id: tit.seccion_id, accion: 'borrar_titulo',
              detalle: { codigo: tit.codigo, nombre: tit.nombre }, usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.post('/titulos/:id/reactivar', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE pa_cuentas_titulos SET activo = 1, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECCIONES — listar / crear / editar / desactivar / reactivar
// (van ANTES de las rutas de /:id para que no matcheen mal)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/secciones', (req, res) => {
  const incluirInactivas = req.query.incluir_inactivas === '1';
  const sociedadId = getSociedadId(req);
  let sql = 'SELECT * FROM pa_cuentas_secciones WHERE sociedad_id = ?';
  if (!incluirInactivas) sql += ' AND activo = 1';
  sql += ' ORDER BY codigo';
  res.json({ ok: true, data: db.prepare(sql).all(sociedadId) });
});

router.post('/secciones', requireAdmin, (req, res) => {
  const { codigo, nombre, grupo } = req.body || {};
  if (!codigo || !nombre) return res.status(400).json({ error: 'codigo y nombre son requeridos' });
  // Aceptar tanto enteros (5) como decimales (5.08)
  const codigoStr = String(codigo).trim();
  if (!RE_SECCION.test(codigoStr)) {
    return res.status(400).json({ error: `"${codigoStr}" no sirve como código de sección. ${AYUDA_SECCION}` });
  }
  const sociedadId = getSociedadId(req);
  const choque = codigoEnUso(db, sociedadId, codigoStr);
  if (choque) return res.status(400).json({ error: mensajeChoque(codigoStr, choque) });
  try {
    const r = db.prepare(`
      INSERT INTO pa_cuentas_secciones (sociedad_id, codigo, nombre, orden, activo, grupo)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(sociedadId, codigoStr, String(nombre).trim(), codigoStr, grupo||'gastos');
    logAccion({ seccion_id: r.lastInsertRowid, accion: 'crear', detalle: { codigo: codigoStr, nombre }, usuario_id: req._user?.id });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/secciones/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sec = db.prepare('SELECT * FROM pa_cuentas_secciones WHERE id = ?').get(id);
  if (!sec) return res.status(404).json({ error: 'sección no encontrada' });

  const { nombre, codigo, grupo } = req.body || {};
  if (codigo !== undefined && String(codigo).trim() !== String(sec.codigo)) {
    const codigoStr = String(codigo).trim();
    // El alta validaba el formato y la edición NO: por acá se le podía poner a
    // una sección cualquier código, incluso uno donde después no entra ninguna
    // cuenta. Sólo corre cuando el código CAMBIA, así que cambiarle el nombre a
    // una sección vieja de formato raro sigue andando.
    if (!RE_SECCION.test(codigoStr)) {
      return res.status(400).json({ error: `"${codigoStr}" no sirve como código de sección. ${AYUDA_SECCION}` });
    }
    const choque = codigoEnUso(db, sec.sociedad_id, codigoStr, { tabla: 'secciones', id });
    if (choque) return res.status(400).json({ error: mensajeChoque(codigoStr, choque) });
    db.prepare("UPDATE pa_cuentas_secciones SET codigo = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(codigoStr, id);
  }
  if (nombre && String(nombre).trim() !== sec.nombre) {
    db.prepare("UPDATE pa_cuentas_secciones SET nombre = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(String(nombre).trim(), id);
  }
  if (grupo) {
    db.prepare("UPDATE pa_cuentas_secciones SET grupo = ? WHERE id = ?").run(grupo, id);
  }
  logAccion({ seccion_id: id, accion: 'editar', detalle: { antes: sec, despues: req.body }, usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.delete('/secciones/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sec = db.prepare('SELECT * FROM pa_cuentas_secciones WHERE id = ?').get(id);
  if (!sec) return res.status(404).json({ error: 'sección no encontrada' });
  // BORRA DE VERDAD. Antes esto sólo ponía activo = 0: la sección quedaba en la
  // base, invisible en la pantalla, y con su CÓDIGO TOMADO PARA SIEMPRE. Después
  // alguien quería usar ese código y el sistema lo rechazaba por algo que no
  // podía ver ni recuperar.
  //
  // Una sección es estructura, no historia: no hay ningún asiento que dependa de
  // ella. Si no tiene nada colgando, se va y libera el código.
  const tits = db.prepare('SELECT COUNT(*) c FROM pa_cuentas_titulos WHERE seccion_id = ?').get(id).c;
  const ctas = db.prepare('SELECT COUNT(*) c FROM pa_cuentas WHERE seccion_id = ?').get(id).c;
  if (tits || ctas) {
    // Se cuentan TODAS, activas o no: una cuenta desactivada sigue apuntando acá,
    // y borrar el padre la dejaría huérfana.
    const partes = [];
    if (tits) partes.push(`${tits} título(s)`);
    if (ctas) partes.push(`${ctas} cuenta(s)`);
    return res.status(400).json({
      error: `No se puede borrar: la sección todavía tiene ${partes.join(' y ')}. `
           + `Movelos o borralos primero.`,
    });
  }
  db.prepare('DELETE FROM pa_cuentas_secciones WHERE id = ?').run(id);
  logAccion({ seccion_id: id, accion: 'borrar',
              detalle: { codigo: sec.codigo, nombre: sec.nombre, grupo: sec.grupo },
              usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.post('/secciones/:id/reactivar', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE pa_cuentas_secciones SET activo = 1, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  logAccion({ seccion_id: id, accion: 'reactivar', usuario_id: req._user?.id });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// LOG GENERAL — esta ruta debe ir ANTES de /:id para que no matchee mal
// ═══════════════════════════════════════════════════════════════════════════

router.get('/log/general', (req, res) => {
  const { desde, hasta, accion, usuario_id } = req.query;
  const params = [];
  let sql = `
    SELECT l.*,
           u.nombre AS usuario_nombre,
           ${REF_LOG}
      FROM pa_cuentas_log l
      LEFT JOIN usuarios u            ON u.id = l.usuario_id
      LEFT JOIN pa_cuentas c          ON c.id = l.cuenta_id
      LEFT JOIN pa_cuentas_secciones s ON s.id = l.seccion_id
     WHERE 1 = 1
  `;
  if (desde)        { sql += ' AND l.creado_en >= ?'; params.push(desde); }
  if (hasta)        { sql += ' AND l.creado_en <= ?'; params.push(hasta); }
  if (accion)       { sql += ' AND l.accion = ?';     params.push(accion); }
  if (usuario_id)   { sql += ' AND l.usuario_id = ?'; params.push(parseInt(usuario_id, 10)); }
  sql += ' ORDER BY l.creado_en DESC LIMIT 500';
  res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

// ═══════════════════════════════════════════════════════════════════════════
// CUENTAS — listar / crear / editar / desactivar / reactivar / mover
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/pa/cuentas?seccion_id=&incluir_inactivas=1&q=
router.get('/', (req, res) => {
  const { seccion_id, q } = req.query;
  const incluirInactivas = req.query.incluir_inactivas === '1';
  const sociedadId = getSociedadId(req);
  const params = [sociedadId];
  let sql = `
    SELECT c.*,
           s.nombre AS seccion_nombre,
           s.codigo AS seccion_codigo,
           t.nombre AS titulo_nombre,
           t.codigo AS titulo_codigo
      FROM pa_cuentas c
      JOIN pa_cuentas_secciones s ON s.id = c.seccion_id
      LEFT JOIN pa_cuentas_titulos t ON t.id = c.titulo_id
     WHERE c.sociedad_id = ?
  `;
  if (!incluirInactivas) sql += ' AND c.activo = 1';
  if (seccion_id) { sql += ' AND c.seccion_id = ?'; params.push(parseInt(seccion_id, 10)); }
  if (q) {
    sql += ' AND (c.codigo LIKE ? OR c.nombre LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY c.codigo';
  const data = db.prepare(sql).all(...params);
  // Imputable = la cuenta NO es padre de ninguna otra (no tiene subcuentas).
  // Una cuenta cuyo código es prefijo de otra (ej: 1.05 es prefijo de 1.05.01) es un
  // rubro agrupador y NO se puede imputar en asientos.
  const codigos = data.map(c => String(c.codigo));
  data.forEach(c => {
    const cod = String(c.codigo);
    const esPadre = codigos.some(otro => otro !== cod && otro.startsWith(cod + '.'));
    c.imputable = esPadre ? 0 : 1;
  });
  res.json({ ok: true, data });
});

// Helper backend: ¿la cuenta es imputable? (no es padre de ninguna otra)
// Se busca el hijo DENTRO DEL MISMO PLAN. Los códigos se repiten entre empresas
// —el UNIQUE es (sociedad_id, codigo), no codigo— así que sin filtrar, la cuenta
// 1.01.01.0001 de Puente Cordón dejaba de ser imputable porque San Gerónimo
// tenía una 1.01.01.0001.5 en SU plan. El asiento se rechazaba por culpa del
// plan de cuentas de otra empresa.
function cuentaEsImputable(db, cuentaId) {
  const c = db.prepare('SELECT codigo, sociedad_id FROM pa_cuentas WHERE id = ?').get(cuentaId);
  if (!c) return false;
  const cod = String(c.codigo);
  const hijo = db.prepare(
    "SELECT 1 FROM pa_cuentas WHERE codigo LIKE ? AND codigo != ? AND sociedad_id = ? LIMIT 1"
  ).get(cod + '.%', cod, c.sociedad_id);
  return !hijo;
}

// Helper: ¿el código ya está en uso en CUALQUIER nivel (sección, título o cuenta)?
// Evita que un título/sección/cuenta compartan numeración. `excepto` permite
// ignorar el propio registro al editar: { tabla: 'cuentas'|'titulos'|'secciones', id }
//
// EL sociedadId NO ES OPCIONAL. Estas tres tablas guardan el plan de MÁS DE UNA
// sociedad y el UNIQUE es (sociedad_id, codigo): sin filtrar, el 1.01.01.0001 de
// una empresa bloquearía el de la otra. Las siete llamadas lo pasan.
function codigoEnUso(db, sociedadId, codigo, excepto) {
  const cod = String(codigo).trim();
  excepto = excepto || {};
  // Se devuelve el NOMBRE y si está desactivada, no sólo "existe". El chequeo
  // mira TODO el plan —las tres tablas, activas y desactivadas— pero la pantalla
  // muestra sólo las activas del grupo de la pestaña abierta. Así que el choque
  // más común es contra algo que el usuario NO PUEDE VER, y el mensaje anterior
  // lo dejaba buscando un código que no aparecía en ningún lado.
  const buscar = (tabla, etiqueta, extra) => {
    const r = db.prepare(
      `SELECT id, nombre, activo${extra || ''} FROM ${tabla} WHERE codigo = ? AND sociedad_id = ?`
    ).get(cod, sociedadId);
    if (!r) return null;
    if (excepto.tabla === tabla.replace('pa_cuentas_', '').replace('pa_cuentas', 'cuentas') && excepto.id === r.id) return null;
    return { nivel: etiqueta, id: r.id, nombre: r.nombre, activo: !!r.activo, grupo: r.grupo };
  };
  return buscar('pa_cuentas_secciones', 'sección', ', grupo')
      || buscar('pa_cuentas_titulos', 'título')
      || buscar('pa_cuentas', 'cuenta');
}

// ── LOS TRES FORMATOS, Y POR QUÉ SON ASÍ ───────────────────────────────────
// El formato de la CUENTA no es negociable: X.XX.XX.XXXX, con UN SOLO dígito de
// grupo. De ahí para arriba todo lo demás se deduce, porque el código de una
// cuenta es el de su título más cuatro dígitos, y el del título es el de su
// sección más dos.
//
// Antes las tres reglas no encajaban entre sí: la sección aceptaba `\d+` con
// decimales libres ("10.01", "4.1", "4.001") y el título `\d+` de grupo
// ("10.01.01"). Los dos se pueden crear, y los dos son CALLEJONES SIN SALIDA:
// abajo de un título 10.01.01 no entra ninguna cuenta, porque 10.01.01.0001 no
// pasa la regex de cuenta. Se creaban en silencio y el problema aparecía
// después, al intentar colgarles algo.
//
// Ahora no se pueden crear. Lo que YA exista con otra forma no se toca: la
// validación corre sólo cuando el código CAMBIA, así que renombrar una sección
// vieja sigue funcionando.
const RE_SECCION = /^\d(\.\d{2})?$/;        // 4   ó  4.01
const RE_TITULO  = /^\d\.\d{2}\.\d{2}$/;    // 4.01.01
const RE_CUENTA  = /^\d\.\d{2}\.\d{2}\.\d{4}$/;  // 4.01.01.0001

const AYUDA_SECCION = 'El código de una sección es X.XX (por ejemplo 4.01), o el dígito del grupo solo '
                    + '(4). Un grupo es un solo dígito: 1 Activo, 2 Pasivo, 3 Patrimonio, 4 Ingresos, '
                    + '5 Egresos.';
const AYUDA_TITULO  = 'El código de un título es X.XX.XX (por ejemplo 4.01.01), y tiene que empezar con '
                    + 'el código de su sección. El primer dígito es el grupo.';

// El primer código libre bajo un prefijo, barriendo desde 0001. Es el plan B de
// la numeración correlativa: se usa sólo cuando el correlativo llegó al 9999,
// que en la práctica pasa porque alguien cargó UNA cuenta terminada en 9999 y no
// porque haya diez mil. Sin esto, esa única cuenta dejaba el alta por lote sin
// poder crear nada y el arrastre sin poder mover nada.
function primerHueco(prefijo, exceptoId) {
  const excepto = exceptoId ? { tabla: 'cuentas', id: exceptoId } : undefined;
  for (let i = 1; i <= 9999; i++) {
    const cand = `${prefijo}.${String(i).padStart(4, '0')}`;
    if (!codigoEnUso(db, cand, excepto)) return cand;
  }
  return null;
}

// Para el mensaje: qué código VÁLIDO se parece al que está mal. Sirve para no
// dejar al contador adivinando qué le pasa a "10.01.01" — se le muestra el
// "1.00.01" que sí entraría, y de ahí se entiende que el grupo es un dígito.
function sugerir(codigo, tramos) {
  const partes = String(codigo).split('.');
  // El grupo es UN dígito: de "10" se propone el "1". Los tramos de abajo se
  // llevan a dos dígitos, que es lo único que acepta el formato.
  const salida = [(partes[0] || '4').replace(/\D/g, '').charAt(0) || '4'];
  for (let i = 1; i < tramos; i++) {
    const t = (partes[i] || '').replace(/\D/g, '');
    salida.push((t.slice(0, 2) || '01').padStart(2, '0'));
  }
  return salida.join('.');
}
const sugerirSeccion = (codigo) => sugerir(codigo, 2);
const sugerirTitulo  = (codigo) => sugerir(codigo, 3);

// ── EL CÓDIGO TIENE QUE COLGAR DE SU PADRE ─────────────────────────────────
// El plan de cuentas se lee por el código: 4.01.01.0002 se entiende porque
// arranca con el 4.01.01 de su título, que arranca con el 4.01 de su sección.
// Eso no se estaba validando en ningún lado: se podía crear el título 5.01.01
// adentro de la sección 4.01, o colgar la cuenta 4.07.99.0001 del título
// 4.01.01. El árbol de la pantalla los mostraba en su lugar —agrupa por id, no
// por código— pero quedaban ordenados en cualquier parte y el código dejaba de
// querer decir algo.
//
// Devuelve el mensaje de error, o null si está bien.
function noCuelgaDe(codigoHijo, codigoPadre, quePadre) {
  if (String(codigoHijo).startsWith(String(codigoPadre) + '.')) return null;
  const de = quePadre === 'el título' ? 'del título' : `de ${quePadre}`;
  return `El código ${codigoHijo} no cuelga ${de} ${codigoPadre}: tiene que empezar `
       + `con "${codigoPadre}.". Así se lee el plan de cuentas — el código dice dónde está la `
       + `cuenta sin tener que buscarla.`;
}

// El mensaje que ve el usuario. Dice DÓNDE está el código, que es lo único que
// le sirve para poder resolverlo.
function mensajeChoque(codigo, choque) {
  const art = choque.nivel === 'sección' || choque.nivel === 'cuenta' ? 'la' : 'el';
  let m = `El código ${codigo} ya lo usa ${art} ${choque.nivel} "${choque.nombre}"`;
  if (choque.grupo) m += ` (grupo ${choque.grupo})`;
  if (!choque.activo) m += ', que está DESACTIVADA y por eso no aparece en la lista';
  return m + '. Los códigos no se pueden repetir entre secciones, títulos y cuentas.';
}

// GET /api/pa/cuentas/:id  (debe ir DESPUÉS de /secciones y /log)
router.get('/:id(\\d+)', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare(`
    SELECT c.*, s.nombre AS seccion_nombre, s.codigo AS seccion_codigo,
           t.nombre AS titulo_nombre, t.codigo AS titulo_codigo
      FROM pa_cuentas c
      JOIN pa_cuentas_secciones s ON s.id = c.seccion_id
      LEFT JOIN pa_cuentas_titulos t ON t.id = c.titulo_id
     WHERE c.id = ?
  `).get(id);
  if (!c) return res.status(404).json({ error: 'cuenta no encontrada' });
  res.json({ ok: true, data: c });
});

// POST /api/pa/cuentas
router.post('/', requireAdmin, (req, res) => {
  const {
    codigo,
    nombre,
    seccion_id,
    titulo_id,
    tipo = 'resultado',
    permite_lote = 0,
    permite_campania = 0,
  } = req.body || {};

  if (!codigo || !nombre || !seccion_id) {
    return res.status(400).json({ error: 'codigo, nombre y seccion_id son requeridos' });
  }
  // Se trabaja siempre sobre el código YA limpio. Antes se validaba el trim pero
  // se guardaba el original: un espacio de más al pegar el código entraba a la
  // base y después no coincidía con nada.
  const codigoStr = String(codigo).trim();
  // Formato OBLIGATORIO para cuentas imputables: X.XX.XX.XXXX (4 niveles, ej: 1.01.01.0001)
  if (!RE_CUENTA.test(codigoStr)) {
    return res.status(400).json({ error: 'Código inválido. Las cuentas deben respetar el formato X.XX.XX.XXXX (ej: 1.01.01.0001).' });
  }
  if (!['resultado', 'patrimonial'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo inválido' });
  }
  // La cuenta hereda la sociedad de su sección (plan de cuentas por sociedad).
  const sec = db.prepare('SELECT id, sociedad_id FROM pa_cuentas_secciones WHERE id = ?').get(seccion_id);
  if (!sec) return res.status(400).json({ error: 'seccion_id inválido' });
  const sociedadId = sec.sociedad_id;

  // El código no puede coincidir con el de una sección, un título u otra cuenta.
  const choque = codigoEnUso(db, sociedadId, codigoStr);
  if (choque) return res.status(400).json({ error: mensajeChoque(codigoStr, choque) });

  try {
    const ordenMax = db.prepare('SELECT COALESCE(MAX(orden), 0) AS m FROM pa_cuentas WHERE seccion_id = ?').get(seccion_id).m;

    // Validar titulo_id si se manda
    let titIdFinal = null;
    if (titulo_id) {
      const tit = db.prepare('SELECT id, codigo FROM pa_cuentas_titulos WHERE id = ? AND seccion_id = ?').get(parseInt(titulo_id, 10), sec.id);
      if (!tit) return res.status(400).json({ error: 'titulo_id no pertenece a la sección indicada' });
      const cuelga = noCuelgaDe(codigoStr, tit.codigo, 'el título');
      if (cuelga) return res.status(400).json({ error: cuelga });
      titIdFinal = tit.id;
    }

    const r = db.prepare(`
      INSERT INTO pa_cuentas
        (sociedad_id, codigo, nombre, seccion_id, titulo_id, tipo, permite_lote, permite_campania, es_sistema, orden, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1)
    `).run(
      sociedadId,
      codigoStr,
      String(nombre).trim(),
      seccion_id,
      titIdFinal,
      tipo,
      permite_lote ? 1 : 0,
      permite_campania ? 1 : 0,
      ordenMax + 10
    );
    logAccion({ cuenta_id: r.lastInsertRowid, accion: 'crear', detalle: req.body, usuario_id: req._user?.id });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/pa/cuentas/:id
router.put('/:id(\\d+)', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cuenta = db.prepare('SELECT * FROM pa_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });

  const { codigo, nombre, seccion_id, titulo_id, tipo, permite_lote, permite_campania } = req.body || {};

  if (codigo && codigo !== cuenta.codigo) {
    const codigoStr = String(codigo).trim();
    if (!RE_CUENTA.test(codigoStr)) {
      return res.status(400).json({ error: 'Código inválido. Las cuentas deben respetar el formato X.XX.XX.XXXX (ej: 1.01.01.0001).' });
    }
    const choque = codigoEnUso(db, cuenta.sociedad_id, codigoStr, { tabla: 'cuentas', id });
    if (choque) return res.status(400).json({ error: mensajeChoque(codigoStr, choque) });
  }
  if (tipo && !['resultado', 'patrimonial'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo inválido' });
  }
  if (seccion_id) {
    // La sección destino debe pertenecer a la misma sociedad (no se mueve entre sociedades).
    const sec = db.prepare('SELECT id, sociedad_id FROM pa_cuentas_secciones WHERE id = ?').get(seccion_id);
    if (!sec) return res.status(400).json({ error: 'seccion_id inválido' });
    if (sec.sociedad_id !== cuenta.sociedad_id) {
      return res.status(400).json({ error: 'la sección destino pertenece a otra sociedad' });
    }
  }

  try {
    db.prepare(`
      UPDATE pa_cuentas
         SET codigo            = COALESCE(?, codigo),
             nombre            = COALESCE(?, nombre),
             seccion_id        = COALESCE(?, seccion_id),
             titulo_id         = CASE WHEN ? IS NOT NULL THEN ? ELSE titulo_id END,
             tipo              = COALESCE(?, tipo),
             permite_lote      = COALESCE(?, permite_lote),
             permite_campania  = COALESCE(?, permite_campania),
             actualizado_en    = datetime('now','localtime')
       WHERE id = ?
    `).run(
      codigo ?? null,
      nombre ? String(nombre).trim() : null,
      seccion_id ?? null,
      titulo_id !== undefined ? 1 : null, // sentinel para distinguir "no mandado" vs "mandado"
      titulo_id !== undefined ? (titulo_id || null) : null,
      tipo ?? null,
      permite_lote === undefined ? null : (permite_lote ? 1 : 0),
      permite_campania === undefined ? null : (permite_campania ? 1 : 0),
      id
    );
    logAccion({
      cuenta_id: id,
      accion: 'editar',
      detalle: { antes: cuenta, despues: req.body },
      usuario_id: req._user?.id,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/pa/cuentas/:id
router.delete('/:id(\\d+)', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cuenta = db.prepare('SELECT * FROM pa_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });
  if (cuenta.es_sistema) {
    return res.status(400).json({ error: 'Es una cuenta del sistema: no se puede borrar.' });
  }

  // ── ACÁ SÍ HAY UNA DIFERENCIA REAL, Y ES CONTABLE ───────────────────────
  // Una cuenta que YA SE USÓ en un asiento no se puede borrar: el asiento
  // quedaría apuntando a una cuenta que no existe y el libro dejaría de cuadrar.
  // Esa se desactiva, y su código sigue tomado — correctamente, porque esa cuenta
  // existe en la historia.
  //
  // Una cuenta que NUNCA se usó no es historia, es un error de carga: se borra
  // de verdad y libera el código.
  const usos = db.prepare('SELECT COUNT(*) c FROM pa_asientos_lineas WHERE cuenta_id = ?').get(id).c;
  if (usos) {
    db.prepare("UPDATE pa_cuentas SET activo = 0, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
    logAccion({ cuenta_id: id, accion: 'desactivar',
                detalle: { codigo: cuenta.codigo, nombre: cuenta.nombre, usos },
                usuario_id: req._user?.id });
    return res.json({
      ok: true, desactivada: true,
      aviso: `La cuenta se usó en ${usos} línea(s) de asiento, así que no se puede borrar `
           + `sin romper esos asientos: quedó DESACTIVADA. No aparece más para elegir, pero `
           + `sigue en los libros y su código sigue ocupado.`,
    });
  }
  db.prepare('DELETE FROM pa_cuentas WHERE id = ?').run(id);
  // El código y el nombre van en `detalle` porque la fila que los tenía se acaba
  // de ir: el JOIN del log ya no la encuentra. Sin esto el renglón queda
  // "borrar — — —", que en un plan de cuentas no sirve para nada.
  logAccion({ cuenta_id: id, accion: 'borrar',
              detalle: { codigo: cuenta.codigo, nombre: cuenta.nombre },
              usuario_id: req._user?.id });
  res.json({ ok: true, borrada: true });
});

// POST /api/pa/cuentas/:id/reactivar
router.post('/:id(\\d+)/reactivar', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE pa_cuentas SET activo = 1, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  logAccion({ cuenta_id: id, accion: 'reactivar', usuario_id: req._user?.id });
  res.json({ ok: true });
});

// POST /api/pa/cuentas/:id/mover  body: { direccion: 'arriba' | 'abajo' }
// Intercambia código con la cuenta vecina dentro de la misma sección
router.post('/:id(\\d+)/mover', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const direccion = req.body?.direccion;
  if (!['arriba', 'abajo'].includes(direccion)) {
    return res.status(400).json({ error: 'direccion debe ser arriba|abajo' });
  }
  const cuenta = db.prepare('SELECT * FROM pa_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });

  const op = direccion === 'arriba' ? '<' : '>';
  const order = direccion === 'arriba' ? 'DESC' : 'ASC';
  const vecina = db.prepare(`
    SELECT * FROM pa_cuentas
     WHERE seccion_id = ?
       AND codigo ${op} ?
       AND activo = 1
     ORDER BY codigo ${order}
     LIMIT 1
  `).get(cuenta.seccion_id, cuenta.codigo);

  if (!vecina) return res.json({ ok: true, sin_cambio: true });

  const tmp = `__TMP_${Date.now()}_${id}`;
  const tx = db.transaction(() => {
    db.prepare('UPDATE pa_cuentas SET codigo = ? WHERE id = ?').run(tmp, cuenta.id);
    db.prepare('UPDATE pa_cuentas SET codigo = ? WHERE id = ?').run(cuenta.codigo, vecina.id);
    db.prepare('UPDATE pa_cuentas SET codigo = ? WHERE id = ?').run(vecina.codigo, cuenta.id);
  });
  tx();

  logAccion({
    cuenta_id: id,
    accion: 'reordenar',
    detalle: { direccion, vecina_id: vecina.id, swap: [cuenta.codigo, vecina.codigo] },
    usuario_id: req._user?.id,
  });

  res.json({ ok: true });
});

// POST /api/pa/cuentas/:id/reasignar-titulo
// Mueve una cuenta a un título (o la saca de un título) y le asigna automáticamente
// el próximo código libre dentro del destino. Pensado para el "Modo edición" de
// reorganización del plan de cuentas. El ID de la cuenta NO cambia, por lo que los
// asientos contables siguen vinculados y muestran el código nuevo automáticamente.
// body: { titulo_id: number|null, seccion_id?: number }
router.post('/:id(\\d+)/reasignar-titulo', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cuenta = db.prepare('SELECT * FROM pa_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });
  if (cuenta.es_sistema) {
    return res.status(400).json({ error: 'cuenta del sistema, no se puede reorganizar' });
  }

  const tituloIdRaw = req.body?.titulo_id;
  const tituloId = (tituloIdRaw === null || tituloIdRaw === undefined || tituloIdRaw === '')
    ? null : parseInt(tituloIdRaw, 10);

  let seccionId = cuenta.seccion_id;
  let nuevoCodigo = null;

  try {
    if (tituloId) {
      // Destino: un título. La cuenta hereda la sección del título y toma el próximo X.XX.XX.XXXX libre.
      const tit = db.prepare('SELECT * FROM pa_cuentas_titulos WHERE id = ? AND sociedad_id = ?').get(tituloId, cuenta.sociedad_id);
      if (!tit) return res.status(400).json({ error: 'titulo_id inválido' });
      seccionId = tit.seccion_id;

      // Buscar el máximo correlativo (últimos 4 dígitos) entre las cuentas ya asignadas a este título
      const hermanas = db.prepare('SELECT codigo FROM pa_cuentas WHERE titulo_id = ?').all(tituloId);
      let max = 0;
      hermanas.forEach(h => {
        const partes = String(h.codigo).split('.');
        const ult = parseInt(partes[partes.length - 1], 10);
        if (Number.isInteger(ult) && ult > max) max = ult;
      });
      // Generar código y garantizar que no choque con ninguno existente en la sociedad
      let n = max + 1;
      do {
        nuevoCodigo = tit.codigo + '.' + String(n).padStart(4, '0');
        const choca = db.prepare('SELECT id FROM pa_cuentas WHERE codigo = ? AND sociedad_id = ? AND id != ?').get(nuevoCodigo, cuenta.sociedad_id, id);
        if (!choca) break;
        n++;
      } while (n < 10000);
    } else {
      // Destino: "Sin título" dentro de la misma sección. Toma próximo X.XX.NN libre.
      const sec = db.prepare('SELECT * FROM pa_cuentas_secciones WHERE id = ?').get(seccionId);
      if (!sec) return res.status(400).json({ error: 'la cuenta no tiene sección válida' });
      const sinTit = db.prepare('SELECT codigo FROM pa_cuentas WHERE seccion_id = ? AND titulo_id IS NULL AND id != ?').all(seccionId, id);
      let max = 0;
      sinTit.forEach(h => {
        const sub = parseInt(String(h.codigo).split('.')[1] || '0', 10);
        if (Number.isInteger(sub) && sub > max) max = sub;
      });
      let n = max + 5;
      do {
        nuevoCodigo = sec.codigo + '.' + String(n).padStart(2, '0');
        const choca = db.prepare('SELECT id FROM pa_cuentas WHERE codigo = ? AND sociedad_id = ? AND id != ?').get(nuevoCodigo, cuenta.sociedad_id, id);
        if (!choca) break;
        n++;
      } while (n < 100);
    }

    db.prepare(`
      UPDATE pa_cuentas
         SET titulo_id = ?, seccion_id = ?, codigo = ?, actualizado_en = datetime('now','localtime')
       WHERE id = ?
    `).run(tituloId, seccionId, nuevoCodigo, id);

    logAccion({
      cuenta_id: id,
      accion: 'reasignar_titulo',
      detalle: { antes: { codigo: cuenta.codigo, titulo_id: cuenta.titulo_id }, despues: { codigo: nuevoCodigo, titulo_id: tituloId } },
      usuario_id: req._user?.id,
    });

    res.json({ ok: true, codigo: nuevoCodigo, titulo_id: tituloId, seccion_id: seccionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/:id(\\d+)/log', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const log = db.prepare(`
    SELECT l.*, u.nombre AS usuario_nombre
      FROM pa_cuentas_log l
      LEFT JOIN usuarios u ON u.id = l.usuario_id
     WHERE l.cuenta_id = ?
     ORDER BY l.creado_en DESC
     LIMIT 200
  `).all(id);
  res.json({ ok: true, data: log });
});
// ═══════════════════════════════════════════════════════════════════════════
// ASIENTOS CONTABLES — partida doble manual
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/pa/cuentas/asientos?desde=&hasta=&anulados=1
router.get('/asientos', (req, res) => {
  const { desde, hasta } = req.query;
  const incluirAnulados = req.query.anulados === '1';
  const sociedadId = getSociedadId(req);
  const params = [sociedadId];
  let sql = `
    SELECT a.*, u.nombre AS usuario_nombre
      FROM pa_asientos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.sociedad_id = ?
  `;
  if (!incluirAnulados) { sql += ' AND a.anulado = 0'; }
  if (desde) { sql += ' AND a.fecha >= ?'; params.push(desde); }
  if (hasta) { sql += ' AND a.fecha <= ?'; params.push(hasta); }
  sql += ' ORDER BY a.fecha DESC, a.id DESC LIMIT 200';
  const asientos = db.prepare(sql).all(...params);

  // LAS LÍNEAS VIAJAN CON LA CABECERA. Sin esto la tabla muestra Debe y Haber en
  // $0,00 en todas las filas —los suma sobre a.lineas— y el Excel sale con 11
  // valores contra 12 encabezados: el estado cae bajo la columna Haber, el
  // usuario bajo Estado, y no hay ni una cuenta ni un importe en todo el
  // archivo. Un libro diario exportado sin importes no sirve para nada.
  //
  // Se traen todas de una sola consulta y se reparten en JS: una consulta por
  // asiento serían 200 para pintar una tabla.
  //
  // El JOIN a pa_cuentas es LEFT a propósito: si una línea quedó apuntando a una
  // cuenta que ya no está, con un JOIN interno esa línea desaparece y el asiento
  // se muestra descuadrado sin que nada avise. Mejor que aparezca sin nombre de
  // cuenta y se vea el problema.
  if (asientos.length) {
    const ids = asientos.map(a => a.id);
    const lineas = db.prepare(`
      SELECT l.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre
        FROM pa_asientos_lineas l
        LEFT JOIN pa_cuentas c ON c.id = l.cuenta_id
       WHERE l.asiento_id IN (${ids.map(() => '?').join(',')})
       ORDER BY l.id`).all(...ids);
    const porAsiento = {};
    for (const l of lineas) (porAsiento[l.asiento_id] = porAsiento[l.asiento_id] || []).push(l);
    for (const a of asientos) a.lineas = porAsiento[a.id] || [];
  }
  res.json({ ok: true, data: asientos });
});

// GET /api/pa/cuentas/asientos/:id — detalle con líneas
router.get('/asientos/:id(\\d+)', (req, res) => {
  const id = parseInt(req.params.id, 10);
  // El LISTADO filtra por sociedad pero el DETALLE no lo hacía: pegándole
  // directo a /asientos/123 se veía el asiento completo —importes, cuentas y
  // descripción— de otra empresa. Un id es fácil de adivinar: son correlativos.
  const asiento = db.prepare(`
    SELECT a.*, u.nombre AS usuario_nombre
      FROM pa_asientos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.id = ? AND a.sociedad_id = ?
  `).get(id, getSociedadId(req));
  if (!asiento) return res.status(404).json({ error: 'asiento no encontrado' });
  const lineas = db.prepare(`
    SELECT l.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre
      FROM pa_asientos_lineas l
      JOIN pa_cuentas c ON c.id = l.cuenta_id
     WHERE l.asiento_id = ?
     ORDER BY l.id
  `).all(id);
  res.json({ ok: true, data: { ...asiento, lineas } });
});


// ═══════════════════════════════════════════════════════════════════════════
// ASIENTOS MODELO — CRUD
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/pa/cuentas/modelos
router.get('/modelos', (req, res) => {
  // tiene_linea_proveedores: sin una línea marcada 'proveedores' el modelo NO
  // sirve para facturas de compra ni para órdenes de pago — construirLineasAsientoCompra
  // (produccion.js:103) corta con 400, y ordenes.js:222 no encuentra la cuenta.
  // Como tipo_linea se agregó por migración con DEFAULT 'libre', todos los modelos
  // anteriores a esa migración quedaron sin la marca aunque la línea exista.
  const modelos = db.prepare(`
    SELECT m.*, COUNT(l.id) as cant_lineas,
           MAX(CASE WHEN l.tipo_linea = 'proveedores' THEN 1 ELSE 0 END) AS tiene_linea_proveedores
    FROM adm_asientos_modelo m
    LEFT JOIN adm_asientos_modelo_lineas l ON l.modelo_id = m.id
    WHERE m.activo = 1 AND m.sociedad_id = ?
    GROUP BY m.id ORDER BY m.nombre
  `).all(getSociedadId(req));
  res.json({ ok: true, data: modelos });
});

// GET /api/pa/cuentas/modelos/:id — con líneas
router.get('/modelos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const modelo = db.prepare('SELECT * FROM adm_asientos_modelo WHERE id = ?').get(id);
  if (!modelo) return res.status(404).json({ error: 'modelo no encontrado' });
  const lineas = db.prepare(`
    SELECT l.*, c.nombre as cuenta_nombre, c.codigo as cuenta_codigo
    FROM adm_asientos_modelo_lineas l
    JOIN pa_cuentas c ON c.id = l.cuenta_id
    WHERE l.modelo_id = ? ORDER BY l.orden, l.id
  `).all(id);
  res.json({ ok: true, data: { ...modelo, lineas } });
});

// POST /api/pa/cuentas/modelos
router.post('/modelos', requireAdmin, (req, res) => {
  const { nombre, descripcion, lineas } = req.body || {};
  if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });
  if (!Array.isArray(lineas) || lineas.length < 2)
    return res.status(400).json({ error: 'El modelo debe tener al menos 2 líneas' });
  const tieneDebе = lineas.some(l => l.lado === 'debe');
  const tieneHaber = lineas.some(l => l.lado === 'haber');
  if (!tieneDebе || !tieneHaber)
    return res.status(400).json({ error: 'El modelo debe tener al menos 1 línea en el debe y 1 en el haber' });
  // Sin una línea marcada "Proveedores (Haber)" el modelo no sirve: la factura de
  // compra se corta con 400 y la orden de pago no encuentra la cuenta. Se valida
  // acá y no solo en el editor porque cada guardado hace `l.tipo_linea || 'libre'`
  // más abajo: un navegador con el panel cacheado viejo, o cualquier otro cliente
  // HTTP, volvería a romper el modelo en silencio.
  //
  // No se adivina la línea al elegir HABER en el front: en un modelo de venta
  // (HABER Ventas) esa adivinanza marcaría Ventas como cuenta de Proveedores y
  // generaría asientos balanceados pero contablemente falsos, que se descubren
  // meses después. Un 400 con el usuario parado en el editor es preferible.
  const _prov = lineas.filter(l => l.tipo_linea === 'proveedores');
  if (_prov.length > 1)
    return res.status(400).json({ error: 'El modelo no puede tener más de una línea de tipo "Proveedores".' });
  if (_prov.length === 1 && _prov[0].lado !== 'haber')
    return res.status(400).json({ error: 'La línea de tipo "Proveedores" tiene que ir en el HABER.' });
  if (_prov.length === 0 && req.body.permitir_sin_proveedores !== true)
    return res.status(400).json({
      codigo: 'SIN_LINEA_PROVEEDORES',
      error: 'El modelo no tiene ninguna línea marcada como "Proveedores (Haber)". Sin ella no se pueden registrar facturas de compra ni emitir órdenes de pago con este modelo.'
    });
  // Bloquear cuentas NO imputables (rubros agrupadores: cuentas padre)
  for (const l of lineas) {
    if (l.cuenta_id && !cuentaEsImputable(db, parseInt(l.cuenta_id))) {
      const c = db.prepare('SELECT codigo, nombre FROM pa_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(400).json({ error: `La cuenta ${c ? c.codigo+' — '+c.nombre : '#'+l.cuenta_id} no es imputable (es un rubro agrupador). Elegí una cuenta final.` });
    }
  }
  try {
    const tx = db.transaction(() => {
      // La empresa va EXPLICITA. La columna tiene DEFAULT Puente Cordon, asi que
      // sin pasarla todo modelo nuevo nacia marcado como de PC sin importar
      // desde donde se creara — el mismo mecanismo exacto que hacia caer las
      // facturas de compra en la empresa equivocada.
      const r = db.prepare(`INSERT INTO adm_asientos_modelo (nombre, descripcion, sociedad_id) VALUES (?, ?, ?)`)
        .run(String(nombre).trim(), descripcion || null, getSociedadId(req));
      const modeloId = r.lastInsertRowid;
      const ins = db.prepare(`INSERT INTO adm_asientos_modelo_lineas (modelo_id, cuenta_id, lado, descripcion, orden, tipo_linea) VALUES (?, ?, ?, ?, ?, ?)`);
      lineas.forEach((l, i) => ins.run(modeloId, l.cuenta_id, l.lado, l.descripcion || null, i, l.tipo_linea || 'libre'));
      return modeloId;
    });
    res.json({ ok: true, id: tx() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/pa/cuentas/modelos/:id
router.put('/modelos/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { nombre, descripcion, lineas } = req.body || {};
  const existe = db.prepare('SELECT id FROM adm_asientos_modelo WHERE id = ?').get(id);
  if (!existe) return res.status(404).json({ error: 'modelo no encontrado' });
  if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });
  if (!Array.isArray(lineas) || lineas.length < 2)
    return res.status(400).json({ error: 'El modelo debe tener al menos 2 líneas' });
  const tieneDebе = lineas.some(l => l.lado === 'debe');
  const tieneHaber = lineas.some(l => l.lado === 'haber');
  if (!tieneDebе || !tieneHaber)
    return res.status(400).json({ error: 'El modelo debe tener al menos 1 línea en el debe y 1 en el haber' });
  // Sin una línea marcada "Proveedores (Haber)" el modelo no sirve: la factura de
  // compra se corta con 400 y la orden de pago no encuentra la cuenta. Se valida
  // acá y no solo en el editor porque cada guardado hace `l.tipo_linea || 'libre'`
  // más abajo: un navegador con el panel cacheado viejo, o cualquier otro cliente
  // HTTP, volvería a romper el modelo en silencio.
  //
  // No se adivina la línea al elegir HABER en el front: en un modelo de venta
  // (HABER Ventas) esa adivinanza marcaría Ventas como cuenta de Proveedores y
  // generaría asientos balanceados pero contablemente falsos, que se descubren
  // meses después. Un 400 con el usuario parado en el editor es preferible.
  const _prov = lineas.filter(l => l.tipo_linea === 'proveedores');
  if (_prov.length > 1)
    return res.status(400).json({ error: 'El modelo no puede tener más de una línea de tipo "Proveedores".' });
  if (_prov.length === 1 && _prov[0].lado !== 'haber')
    return res.status(400).json({ error: 'La línea de tipo "Proveedores" tiene que ir en el HABER.' });
  if (_prov.length === 0 && req.body.permitir_sin_proveedores !== true)
    return res.status(400).json({
      codigo: 'SIN_LINEA_PROVEEDORES',
      error: 'El modelo no tiene ninguna línea marcada como "Proveedores (Haber)". Sin ella no se pueden registrar facturas de compra ni emitir órdenes de pago con este modelo.'
    });
  for (const l of lineas) {
    if (l.cuenta_id && !cuentaEsImputable(db, parseInt(l.cuenta_id))) {
      const c = db.prepare('SELECT codigo, nombre FROM pa_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(400).json({ error: `La cuenta ${c ? c.codigo+' — '+c.nombre : '#'+l.cuenta_id} no es imputable (es un rubro agrupador). Elegí una cuenta final.` });
    }
  }
  try {
    db.transaction(() => {
      db.prepare('UPDATE adm_asientos_modelo SET nombre=?, descripcion=? WHERE id=?')
        .run(String(nombre).trim(), descripcion || null, id);
      db.prepare('DELETE FROM adm_asientos_modelo_lineas WHERE modelo_id = ?').run(id);
      const ins = db.prepare(`INSERT INTO adm_asientos_modelo_lineas (modelo_id, cuenta_id, lado, descripcion, orden, tipo_linea) VALUES (?, ?, ?, ?, ?, ?)`);
      lineas.forEach((l, i) => ins.run(id, l.cuenta_id, l.lado, l.descripcion || null, i, l.tipo_linea || 'libre'));
    })();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/pa/cuentas/modelos/:id (soft)
router.delete('/modelos/:id', requireAdmin, (req, res) => {
  db.prepare("UPDATE adm_asientos_modelo SET activo = 0 WHERE id = ?").run(parseInt(req.params.id));
  res.json({ ok: true });
});

// POST /api/pa/cuentas/modelos/desde-factura
// Genera asiento contable real desde una factura, usando el modelo del proveedor
router.post('/modelos/desde-factura', requireAuth, (req, res) => {
  const { compra_id, lineas } = req.body || {};
  if (!compra_id) return res.status(400).json({ error: 'compra_id requerido' });

  const compra = db.prepare(`
    SELECT c.*, p.razon_social as prov_nombre
    FROM pa_compras c
    LEFT JOIN adm_proveedores p ON p.id = c.proveedor_id
    WHERE c.id = ?
  `).get(parseInt(compra_id));
  if (!compra) return res.status(404).json({ error: 'compra no encontrada' });

  if (!Array.isArray(lineas) || lineas.length < 2)
    return res.status(400).json({ error: 'El asiento debe tener al menos 2 líneas' });

  const totalDebe  = lineas.reduce((s, l) => s + (parseFloat(l.debe)  || 0), 0);
  const totalHaber = lineas.reduce((s, l) => s + (parseFloat(l.haber) || 0), 0);
  if (Math.abs(totalDebe - totalHaber) > 0.01)
    return res.status(400).json({ error: `Partida doble no cuadra: debe=${totalDebe.toFixed(2)} haber=${totalHaber.toFixed(2)}` });

  // Generar código FAC-YYYY-NNNN
  const año = new Date().getFullYear();
  // EL CORRELATIVO ES POR SOCIEDAD. Sin el filtro, las tres empresas compartían
  // una sola numeración: Puente Cordón sacaba el FAC-2026-0001, San Gerónimo el
  // 0002 y Puente Cordón el 0003. El libro de cada una quedaba con huecos y sin
  // ser correlativo, que es exactamente lo que un libro contable no puede ser.
  // Son sociedades fiscales distintas: cada una lleva su propia serie.
  const ultimo = db.prepare(
    `SELECT ref_codigo FROM pa_asientos
      WHERE ref_codigo LIKE 'FAC-${año}-%' AND sociedad_id = ?
      ORDER BY id DESC LIMIT 1`).get(sociedadPCId());
  let seq = 1;
  if (ultimo?.ref_codigo) {
    const partes = ultimo.ref_codigo.split('-');
    seq = (parseInt(partes[2]) || 0) + 1;
  }
  const refCodigo = `FAC-${año}-${String(seq).padStart(4, '0')}`;
  const descripcion = `${refCodigo} | ${compra.prov_nombre || 'Proveedor'} | ${compra.nro_factura || 'S/N'}`;

  try {
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pa_asientos (fecha, descripcion, usuario_id, ref_compra_id, ref_codigo, sociedad_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(compra.fecha, descripcion, req._user?.id ?? null, compra_id, refCodigo, sociedadPCId());
      const asientoId = r.lastInsertRowid;
      const ins = db.prepare(`INSERT INTO pa_asientos_lineas (asiento_id, cuenta_id, debe, haber, descripcion) VALUES (?, ?, ?, ?, ?)`);
      for (const l of lineas) {
        ins.run(asientoId, l.cuenta_id, parseFloat(l.debe)||0, parseFloat(l.haber)||0, l.descripcion||null);
      }
      return { asientoId, refCodigo };
    });
    const { asientoId, refCodigo: codigo } = tx();
    res.json({ ok: true, id: asientoId, ref_codigo: codigo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pa/cuentas/asientos — crear asiento
router.post('/asientos', requireAdmin, (req, res) => {
  const { fecha, descripcion, lineas } = req.body || {};

  if (!descripcion) return res.status(400).json({ error: 'descripcion es requerida' });
  if (!Array.isArray(lineas) || lineas.length < 2) {
    return res.status(400).json({ error: 'el asiento debe tener al menos 2 líneas' });
  }

  // Validar partida doble: suma debe == suma haber
  const totalDebe  = lineas.reduce((s, l) => s + (parseFloat(l.debe)  || 0), 0);
  const totalHaber = lineas.reduce((s, l) => s + (parseFloat(l.haber) || 0), 0);
  if (Math.abs(totalDebe - totalHaber) > 0.01) {
    return res.status(400).json({
      error: `partida doble no cuadra: debe=${totalDebe.toFixed(2)} haber=${totalHaber.toFixed(2)}`
    });
  }

  // El asiento pertenece a una sociedad; todas sus cuentas deben ser de esa sociedad.
  const sociedadId = getSociedadId(req);

  // Validar que cada línea tenga cuenta válida y de la misma sociedad
  for (const l of lineas) {
    if (!l.cuenta_id) return res.status(400).json({ error: 'cada línea debe tener cuenta_id' });
    const c = db.prepare('SELECT id, sociedad_id FROM pa_cuentas WHERE id = ? AND activo = 1').get(l.cuenta_id);
    if (!c) return res.status(400).json({ error: `cuenta_id ${l.cuenta_id} no existe o está inactiva` });
    if (c.sociedad_id !== sociedadId) {
      return res.status(400).json({ error: `cuenta_id ${l.cuenta_id} pertenece a otra sociedad` });
    }
    if (!cuentaEsImputable(db, parseInt(l.cuenta_id))) {
      const cc = db.prepare('SELECT codigo, nombre FROM pa_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(400).json({ error: `La cuenta ${cc ? cc.codigo+' — '+cc.nombre : '#'+l.cuenta_id} no es imputable (es un rubro agrupador). Elegí una cuenta final.` });
    }
  }

  try {
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pa_asientos (fecha, descripcion, usuario_id, sociedad_id)
        VALUES (?, ?, ?, ?)
      `).run(
        fecha || new Date().toISOString().slice(0, 10),
        String(descripcion).trim(),
        req._user?.id ?? null,
        sociedadId
      );
      const asientoId = r.lastInsertRowid;
      const insLinea = db.prepare(`
        INSERT INTO pa_asientos_lineas (asiento_id, cuenta_id, debe, haber, descripcion)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const l of lineas) {
        insLinea.run(
          asientoId,
          l.cuenta_id,
          parseFloat(l.debe)  || 0,
          parseFloat(l.haber) || 0,
          l.descripcion ?? null
        );
      }
      return asientoId;
    });
    const asientoId = tx();
    res.json({ ok: true, id: asientoId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/pa/cuentas/asientos/:id/anular
router.post('/asientos/:id(\\d+)/anular', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const asiento = db.prepare('SELECT * FROM pa_asientos WHERE id = ?').get(id);
  if (!asiento) return res.status(404).json({ error: 'asiento no encontrado' });
  if (asiento.anulado) return res.status(400).json({ error: 'el asiento ya está anulado' });
  // EL ASIENTO QUE NACIÓ EN UN MÓDULO SE DESHACE DESDE EL MÓDULO. Acá se anulaba
  // cualquier cosa sin preguntar nada.
  const freno = origenDeAsientoPa(db, id);
  if (freno) return res.status(400).json({ ok: false, error: freno.error,
    modulo: freno.modulo, pantalla: freno.pantalla, comprobante: freno.comprobante });
  db.prepare(`
    UPDATE pa_asientos
       SET anulado = 1, anulado_por = ?, anulado_en = datetime('now','localtime')
     WHERE id = ?
  `).run(req._user?.id ?? null, id);
  res.json({ ok: true });
});
// ── GET /api/pa/cuentas/config-impositiva ────────────────────────────────────
router.get('/config-impositiva', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT ci.clave, ci.cuenta_id, ci.descripcion,
        c.nombre as cuenta_nombre, c.codigo as cuenta_codigo
      FROM adm_config_impositiva ci
      LEFT JOIN pa_cuentas c ON c.id = ci.cuenta_id
      WHERE ci.sociedad_id = ?
      ORDER BY ci.clave
    `).all(getSociedadId(req));
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── PUT /api/pa/cuentas/config-impositiva ────────────────────────────────────
router.put('/config-impositiva', requireAuth, (req, res) => {
  const { clave, cuenta_id } = req.body || {};
  if (!clave) return res.status(400).json({ ok: false, error: 'clave requerida' });
  // Whitelist: el UPSERT de abajo crearía una fila nueva con cualquier clave que
  // llegue, y esa fila después aparece en la pantalla de configuración.
  const CLAVES = ['iva_credito_fiscal', 'iva_debito_fiscal', 'percepcion_iva',
                  'percepcion_iibb', 'percepcion_ganancias', 'retencion'];
  if (!CLAVES.includes(clave)) return res.status(400).json({ ok: false, error: 'clave desconocida: ' + clave });
  try {
    // UPSERT y no UPDATE: si la clave no estaba sembrada, el UPDATE afectaba 0
    // filas y el panel igual mostraba "✓ Configuración guardada". Así quedó
    // iva_credito_fiscal, que ni siquiera estaba en el seed: imposible de
    // configurar, y sin ella ninguna factura con IVA se puede registrar.
    // La cuenta que se asigna tiene que ser DE ESTA EMPRESA. Sin este control,
    // configurar el IVA Crédito Fiscal de San Gerónimo apuntando a la cuenta de
    // Puente Cordón deja todas sus facturas imputando al balance de PC — y el
    // asiento se ve perfecto, cuadra, y está en los libros del otro.
    const soc = getSociedadId(req);
    const cid = cuenta_id ? parseInt(cuenta_id) : null;
    if (cid) {
      const cu = db.prepare('SELECT sociedad_id, codigo FROM pa_cuentas WHERE id = ?').get(cid);
      if (!cu) return res.status(400).json({ ok: false, error: 'La cuenta no existe' });
      if (cu.sociedad_id !== soc) {
        return res.status(400).json({ ok: false,
          error: `La cuenta ${cu.codigo} es del plan de cuentas de otra sociedad` });
      }
    }
    const r = db.prepare(`
      INSERT INTO adm_config_impositiva (sociedad_id, clave, cuenta_id) VALUES (?, ?, ?)
      ON CONFLICT(sociedad_id, clave) DO UPDATE SET cuenta_id = excluded.cuenta_id
    `).run(soc, clave, cid);
    if (!r.changes) return res.status(500).json({ ok: false, error: 'No se pudo guardar la configuración' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
