// src/rutas/fp.js
// ── API del módulo PLANIFICACIÓN FINANCIERA (esqueleto) ───────────────────
// Montado en /api/fp. Universo independiente: solo toca tablas fp_*.
//
// PROYECTAR ES GET, A PROPÓSITO: index.js monta `bloquearSiSoloLectura` sobre todo
// /api y devuelve 403 a cualquier POST/PUT/PATCH/DELETE de un usuario con
// solo_lectura=1. Si "Proyectar" fuera POST, un visor recibiría "Tu usuario es
// solo lectura" al intentar mirar un flujo, que es un mensaje engañoso sobre una
// operación que no escribe nada.
//   GET /proyeccion -> corre el motor, no persiste.
//
// ACCESO RESTRINGIDO A ADMIN. Esto es el flujo de fondos de la empresa: saldos de
// banco, deuda bancaria y cheques a pagar. El sidebar NO filtra por permisos
// (GET /api/org/sidebar filtra solo por oculto=0, sin mirar rol ni secciones), o
// sea que el ítem le aparece a cualquier usuario autenticado. La única defensa
// real es el guard del backend, acá abajo.

import express from 'express';
import db from '../servicios/db_fp.js';   // este import es el que crea el schema fp_*
import { proyectar, generarCuotas, lunesDe, sumarMeses } from '../servicios/fp_motor.js';
import { cronograma, flujoMensual, kpisPrestamos, interesesPorEjercicio,
         pendientesDe, mesDeCuota, bancoDe } from '../servicios/fp_prestamos.js';

const router = express.Router();

// ── Helpers de request ────────────────────────────────────────────────────

router.use((req, res, next) => {
  try {
    const c = req.cookies?.lnb_user;
    if (c) req.user = JSON.parse(c);
  } catch (_) { /* cookie corrupta: se trata como no autenticado */ }
  next();
});

// auth.js no exporta requireAuth ni soloAdmin: sus únicos exports son
// bloquearSiSoloLectura y el router. Cada módulo define los suyos.
function requireAuth(req, res, next) {
  if (!req.user || !req.user.id) return res.status(401).json({ ok: false, error: 'No autenticado' });
  next();
}
function soloAdmin(req, res, next) {
  if (req.user?.rol !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Este módulo es solo para administradores' });
  }
  next();
}
router.use(requireAuth);
router.use(soloAdmin);

// La sociedad la resuelve el backend: el interceptor de fetch del panel inyecta
// sociedad_id solo a un whitelist de rutas que no incluye /api/fp. Default a San
// Gerónimo, que es de quien es este flujo.
let _sgId = null;
function sociedadSGId() {
  if (_sgId) return _sgId;
  const r = db.prepare("SELECT id FROM sociedades WHERE nombre = 'San Gerónimo SA'").get()
         || db.prepare('SELECT id FROM sociedades ORDER BY id LIMIT 1').get();
  _sgId = r ? r.id : 1;
  return _sgId;
}
function getSociedadId(req) {
  const raw = req.body?.sociedad_id ?? req.query?.sociedad_id;
  const id = (raw !== undefined && raw !== null && raw !== '') ? parseInt(raw, 10) : null;
  if (Number.isInteger(id)) {
    const ok = db.prepare('SELECT id FROM sociedades WHERE id = ?').get(id);
    if (ok) return id;
  }
  return sociedadSGId();
}

// Errores tipados: el wrap los convierte en la respuesta correcta.
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const notFound = (msg) => Object.assign(new Error(msg || 'No encontrado'), { status: 404 });
const conflict = (msg, extra) => Object.assign(new Error(msg), { status: 409, extra });

// No hay error middleware global en index.js: un throw sin catch devuelve HTML y
// rompe el r.json() del panel. Por eso CADA handler va envuelto.
const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    const body = { ok: false, error: e.message };
    if (e.extra) Object.assign(body, e.extra);
    res.status(e.status || 500).json(body);
  }
};

// ── Validadores (400 en castellano, nunca un 500 con el CHECK de SQLite) ──

function vTexto(v, campo, { req: obligatorio = false, max = 200 } = {}) {
  const s = (v === undefined || v === null) ? '' : String(v).trim();
  if (!s && obligatorio) throw bad(`${campo} es obligatorio`);
  if (s.length > max) throw bad(`${campo} no puede superar los ${max} caracteres`);
  return s || null;
}
function vNum(v, campo, { min = -Infinity, max = Infinity, def = null, entero = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (def !== null) return def;
    throw bad(`${campo} es obligatorio`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${campo} tiene que ser un número`);
  if (entero && !Number.isInteger(n)) throw bad(`${campo} tiene que ser un número entero`);
  if (n < min) throw bad(`${campo} no puede ser menor que ${min}`);
  if (n > max) throw bad(`${campo} no puede ser mayor que ${max}`);
  return n;
}
function vFecha(v, campo, { req: obligatorio = false } = {}) {
  const s = vTexto(v, campo, { req: obligatorio });
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${campo} tiene que tener formato AAAA-MM-DD`);
  return s;
}
function vPeriodo(v, campo, { req: obligatorio = false } = {}) {
  const s = vTexto(v, campo, { req: obligatorio });
  if (s && !/^\d{4}-\d{2}$/.test(s)) throw bad(`${campo} tiene que tener formato AAAA-MM`);
  return s;
}
function vEnum(v, campo, validos, def) {
  const s = vTexto(v, campo);
  if (!s) return def;
  if (!validos.includes(s)) throw bad(`${campo} tiene que ser uno de: ${validos.join(', ')}`);
  return s;
}

// Todo acceso por :id pasa por acá. Sin el filtro de sociedad, cualquier admin
// puede leer o modificar un préstamo de otra empresa poniendo el id en la URL —
// el guard de admin no alcanza, porque hay admins de sociedades distintas.
function unoDe(tabla, req, id, etiqueta) {
  const r = db.prepare(`SELECT * FROM ${tabla} WHERE id = ? AND sociedad_id = ? AND eliminado_en IS NULL`)
    .get(id, getSociedadId(req));
  if (!r) throw notFound(etiqueta + ' no encontrado');
  return r;
}

function logFp(entidad, entidadId, accion, detalle, userId) {
  try {
    db.prepare('INSERT INTO fp_log (entidad, entidad_id, accion, detalle, usuario_id) VALUES (?,?,?,?,?)')
      .run(entidad, entidadId || null, accion, detalle ? JSON.stringify(detalle) : null, userId || null);
  } catch (e) {
    console.error('[FP] Error escribiendo log:', e.message);
  }
}

const AHORA = "datetime('now','localtime')";
// 'cuota_unica' se conserva junto a 'americano': son el mismo sistema y hay
// préstamos ya cargados con el nombre viejo.
const SISTEMAS = ['frances', 'aleman', 'americano', 'cuota_unica'];
const PERIODICIDADES = ['Mensual', 'Bimestral', 'Trimestral', 'Semestral', 'Anual'];
const TASAS = ['fija', 'variable'];

// ══════════════════════════════════════════════════════════════════════════
// PRÉSTAMOS
// ══════════════════════════════════════════════════════════════════════════

router.get('/prestamos', wrap((req, res) => {
  const soc = getSociedadId(req);
  const filas = db.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM fp_prestamo_cuotas c WHERE c.prestamo_id = p.id) AS cuotas_cargadas,
           (SELECT COUNT(*) FROM fp_prestamo_cuotas c WHERE c.prestamo_id = p.id AND c.estado = 'pendiente') AS cuotas_pendientes,
           (SELECT IFNULL(SUM(c.capital + c.interes), 0) FROM fp_prestamo_cuotas c
              WHERE c.prestamo_id = p.id AND c.estado = 'pendiente') AS saldo_pendiente
      FROM fp_prestamos p
     WHERE p.sociedad_id = ? AND p.eliminado_en IS NULL
     ORDER BY p.banco COLLATE NOCASE, p.numero COLLATE NOCASE
  `).all(soc);
  res.json({ ok: true, data: filas });
}));

// Un préstamo con su calendario completo.
router.get('/prestamos/:id', wrap((req, res) => {
  const p = unoDe('fp_prestamos', req, req.params.id, 'Préstamo');
  const cuotas = db.prepare('SELECT * FROM fp_prestamo_cuotas WHERE prestamo_id = ? ORDER BY nro_cuota').all(p.id);
  res.json({ ok: true, data: { ...p, cuotas } });
}));

function leerPrestamo(body, parcialDe) {
  const p = parcialDe || {};
  const tomar = (campo, fn) => (body[campo] === undefined && parcialDe) ? p[campo] : fn();
  return {
    banco:          tomar('banco',          () => vTexto(body.banco, 'Banco', { req: true, max: 80 })),
    numero:         tomar('numero',         () => vTexto(body.numero, 'Número de préstamo', { req: true, max: 60 })),
    sistema:        tomar('sistema',        () => vEnum(body.sistema, 'Sistema', SISTEMAS, 'frances')),
    tipo_tasa:      tomar('tipo_tasa',      () => vEnum(body.tipo_tasa, 'Tipo de tasa', TASAS, 'fija')),
    tna_texto:      tomar('tna_texto',      () => vTexto(body.tna_texto, 'Tasa', { max: 60 })),
    tna:            tomar('tna',            () => vNum(body.tna, 'TNA', { min: 0, max: 10, def: 0 })),
    fecha_inicio:   tomar('fecha_inicio',   () => vFecha(body.fecha_inicio, 'Fecha de inicio')),
    fecha_fin:      tomar('fecha_fin',      () => vFecha(body.fecha_fin, 'Fecha de fin')),
    cuotas_totales: tomar('cuotas_totales', () => vNum(body.cuotas_totales, 'Cuotas totales', { min: 0, max: 600, def: 0, entero: true })),
    semana_debito:  tomar('semana_debito',  () => vNum(body.semana_debito, 'Semana de débito', { min: 1, max: 4, def: 1, entero: true })),
    condicion:      tomar('condicion',      () => vTexto(body.condicion, 'Condición', { max: 80 })),
    monto_origen:   tomar('monto_origen',   () => vNum(body.monto_origen, 'Monto de origen', { min: 0, def: 0 })),
    estado:         tomar('estado',         () => vEnum(body.estado, 'Estado', ['vigente', 'cancelado'], 'vigente')),
    notas:          tomar('notas',          () => vTexto(body.notas, 'Notas', { max: 1000 })),
    // ── Ficha del préstamo financiero ──────────────────────────────────────
    alias:          tomar('alias',          () => vTexto(body.alias, 'Alias', { max: 120 })),
    periodicidad:   tomar('periodicidad',   () => vEnum(body.periodicidad, 'Periodicidad', PERIODICIDADES, 'Mensual')),
    // null = manda el calendario. Un número gana sobre el calendario, porque el
    // banco a veces adelanta o difiere cuotas.
    cuotas_pend_manual: tomar('cuotas_pend_manual', () =>
      (body.cuotas_pend_manual === '' || body.cuotas_pend_manual === null || body.cuotas_pend_manual === undefined)
        ? null : vNum(body.cuotas_pend_manual, 'Cuotas pendientes', { min: 0, max: 600, entero: true })),
    // La cuota real que debita el banco, con impuestos y sellos. 0 o vacío = usar
    // la estimada.
    cuota_fin:      tomar('cuota_fin',      () => vNum(body.cuota_fin, 'Cuota fin', { min: 0, def: 0 })),
  };
}

router.post('/prestamos', wrap((req, res) => {
  const soc = getSociedadId(req);
  const d = leerPrestamo(req.body || {});
  const dup = db.prepare(`SELECT id FROM fp_prestamos
     WHERE sociedad_id = ? AND banco = ? COLLATE NOCASE AND numero = ? COLLATE NOCASE AND eliminado_en IS NULL`)
    .get(soc, d.banco, d.numero);
  if (dup) throw conflict(`Ya existe un préstamo ${d.numero} en ${d.banco}`, { id: dup.id });

  const info = db.prepare(`INSERT INTO fp_prestamos
      (sociedad_id, banco, numero, sistema, tipo_tasa, tna_texto, tna, fecha_inicio, fecha_fin,
       cuotas_totales, semana_debito, condicion, monto_origen, estado, notas,
       alias, periodicidad, cuotas_pend_manual, cuota_fin, creado_por_id)
      VALUES (@sociedad_id,@banco,@numero,@sistema,@tipo_tasa,@tna_texto,@tna,@fecha_inicio,@fecha_fin,
              @cuotas_totales,@semana_debito,@condicion,@monto_origen,@estado,@notas,
              @alias,@periodicidad,@cuotas_pend_manual,@cuota_fin,@uid)`)
    .run({ ...d, sociedad_id: soc, uid: req.user.id });

  logFp('prestamo', info.lastInsertRowid, 'alta', { banco: d.banco, numero: d.numero }, req.user.id);
  res.json({ ok: true, id: info.lastInsertRowid });
}));

router.patch('/prestamos/:id', wrap((req, res) => {
  const p = unoDe('fp_prestamos', req, req.params.id, 'Préstamo');
  const d = leerPrestamo(req.body || {}, p);
  db.prepare(`UPDATE fp_prestamos SET banco=@banco, numero=@numero, sistema=@sistema, tipo_tasa=@tipo_tasa,
      tna_texto=@tna_texto, tna=@tna, fecha_inicio=@fecha_inicio, fecha_fin=@fecha_fin,
      cuotas_totales=@cuotas_totales, semana_debito=@semana_debito, condicion=@condicion,
      monto_origen=@monto_origen, estado=@estado, notas=@notas,
      alias=@alias, periodicidad=@periodicidad, cuotas_pend_manual=@cuotas_pend_manual,
      cuota_fin=@cuota_fin,
      actualizado_en=${AHORA}, actualizado_por_id=@uid WHERE id=@id`)
    .run({ ...d, id: p.id, uid: req.user.id });
  logFp('prestamo', p.id, 'edicion', null, req.user.id);
  res.json({ ok: true });
}));

router.delete('/prestamos/:id', wrap((req, res) => {
  const p = unoDe('fp_prestamos', req, req.params.id, 'Préstamo');
  db.prepare(`UPDATE fp_prestamos SET eliminado_en=${AHORA}, eliminado_por_id=? WHERE id=?`).run(req.user.id, p.id);
  logFp('prestamo', p.id, 'baja', { banco: p.banco, numero: p.numero }, req.user.id);
  res.json({ ok: true });
}));

// Genera el calendario. Reemplaza el que hubiera: cargar 24 cuotas a mano es lo
// que hace que en la planilla nadie las corrija cuando cambia algo.
router.post('/prestamos/:id/generar-cuotas', wrap((req, res) => {
  const p = unoDe('fp_prestamos', req, req.params.id, 'Préstamo');
  const periodoInicio = vPeriodo(req.body?.periodo_inicio, 'Período de inicio')
    || (p.fecha_inicio ? p.fecha_inicio.slice(0, 7) : null);
  if (!periodoInicio) throw bad('Falta el período de la primera cuota (AAAA-MM)');
  if (!p.cuotas_totales) throw bad('El préstamo no tiene cantidad de cuotas cargada');

  const cuotas = generarCuotas({
    sistema: p.sistema, monto: p.monto_origen, cuotas: p.cuotas_totales,
    tna: p.tna, periodoInicio,
  });
  if (!cuotas.length) throw bad('No se pudo generar el calendario: revisá monto, cuotas y tasa');

  // Las cuotas ya marcadas pagadas se respetan: regenerar el calendario no puede
  // "despagar" lo que ya se debitó. Y se conserva la FECHA original de pago —
  // ponerle la de hoy falsearía cuándo salió la plata, que es justamente el dato
  // por el que existe este módulo.
  const pagadas = new Map(
    db.prepare("SELECT nro_cuota, pagada_en FROM fp_prestamo_cuotas WHERE prestamo_id = ? AND estado = 'pagada'")
      .all(p.id).map(r => [r.nro_cuota, r.pagada_en])
  );

  db.transaction(() => {
    db.prepare('DELETE FROM fp_prestamo_cuotas WHERE prestamo_id = ?').run(p.id);
    const ins = db.prepare(`INSERT INTO fp_prestamo_cuotas
        (prestamo_id, nro_cuota, periodo, capital, interes, estado, pagada_en)
        VALUES (?,?,?,?,?,?,?)`);
    for (const c of cuotas) {
      const pag = pagadas.has(c.nro_cuota);
      ins.run(p.id, c.nro_cuota, c.periodo, c.capital, c.interes,
        pag ? 'pagada' : 'pendiente', pag ? pagadas.get(c.nro_cuota) : null);
    }
  })();

  logFp('prestamo', p.id, 'generar_cuotas', { cuotas: cuotas.length, conservadas: pagadas.size }, req.user.id);
  res.json({ ok: true, generadas: cuotas.length, conservadas_pagadas: pagadas.size });
}));

// Marcar una cuota pagada / pendiente. ESTO ES LO QUE EN LA PLANILLA ERA EL COLOR.
router.patch('/cuotas/:id', wrap((req, res) => {
  // La cuota no tiene sociedad_id: se valida por su préstamo.
  const c = db.prepare(`SELECT c.* FROM fp_prestamo_cuotas c
     JOIN fp_prestamos p ON p.id = c.prestamo_id
    WHERE c.id = ? AND p.sociedad_id = ? AND p.eliminado_en IS NULL`)
    .get(req.params.id, getSociedadId(req));
  if (!c) throw notFound('Cuota no encontrada');
  const estado = vEnum(req.body?.estado, 'Estado', ['pendiente', 'pagada'], null);
  const capital = req.body?.capital === undefined ? c.capital : vNum(req.body.capital, 'Capital', { min: 0 });
  const interes = req.body?.interes === undefined ? c.interes : vNum(req.body.interes, 'Interés', { min: 0 });
  db.prepare(`UPDATE fp_prestamo_cuotas SET estado=?, pagada_en=?, capital=?, interes=?, actualizado_en=${AHORA} WHERE id=?`)
    .run(estado || c.estado, (estado || c.estado) === 'pagada' ? (c.pagada_en || new Date().toISOString().slice(0, 10)) : null,
         capital, interes, c.id);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════════════════
// PRÉSTAMOS FINANCIEROS — flujo mensual, KPIs y previsión de intereses
// ══════════════════════════════════════════════════════════════════════════

// La fila de la base tiene los nombres del schema; el motor trabaja con los
// nombres de la ficha. El mapeo va en un solo lugar para que no se desincronice.
function fichaDe(row) {
  return {
    id: row.id,
    alias: row.alias || null,
    entidad: row.banco || '',
    numero: row.numero || '',
    monto: Number(row.monto_origen) || 0,
    tna: Number(row.tna) || 0,
    cuotas: parseInt(row.cuotas_totales, 10) || 0,
    cuotasPend: (row.cuotas_pend_manual === null || row.cuotas_pend_manual === undefined)
      ? null : parseInt(row.cuotas_pend_manual, 10),
    periodicidad: row.periodicidad || 'Mensual',
    sistema: row.sistema || 'frances',
    fecha1: row.fecha_inicio || null,
    cuotaFin: Number(row.cuota_fin) || 0,
  };
}

// GET, no POST: no persiste nada y un usuario de solo lectura tiene que poder
// mirarlo (bloquearSiSoloLectura corta todo POST sobre /api).
router.get('/flujo-prestamos', wrap((req, res) => {
  const soc = getSociedadId(req);
  const hoy = new Date().toISOString().slice(0, 10);
  // Mes de inicio del ejercicio fiscal. Julio por defecto; se puede pasar 1 para
  // ejercicio calendario sin tocar nada más.
  const mesEjercicio = vNum(req.query.mes_ejercicio, 'Mes de ejercicio',
    { min: 1, max: 12, def: 7, entero: true });

  // Los cancelados no proyectan pero se siguen viendo en la lista.
  const filas = db.prepare(`SELECT * FROM fp_prestamos
     WHERE sociedad_id = ? AND eliminado_en IS NULL
     ORDER BY banco COLLATE NOCASE, numero COLLATE NOCASE`).all(soc);
  const vigentes = filas.filter(r => r.estado !== 'cancelado');

  const meses = flujoMensual(vigentes.map(fichaDe), hoy);
  const kpis = kpisPrestamos(meses);
  const ejercicios = interesesPorEjercicio(meses, mesEjercicio);

  // La lista de tarjetas, con todo lo derivado ya calculado: si lo calculara el
  // front, la misma cuenta viviría en dos lados y se separarían.
  const prestamos = filas.map(row => {
    const f = fichaDe(row);
    const plan = cronograma(f);
    const pend = pendientesDe(f, hoy);
    const prox = plan[pend.pagadas] || null;
    return {
      ...row,
      alias_mostrar: f.alias || (f.entidad + (f.numero ? ' ' + f.numero : '')),
      banco_info: bancoDe(f.entidad),
      periodicidad: f.periodicidad,
      cuotas_pend: pend.pendientes,
      cuotas_pend_es_manual: !!pend.manual,
      proxima_cuota_estimada: prox ? prox.cuota : 0,
      proxima_cuota_mes: prox ? mesDeCuota(f.fecha1, pend.pagadas, f.periodicidad) : null,
      // Lo que efectivamente sale de caja: la cuota fin manda sobre la estimada.
      proxima_cuota_ff: f.cuotaFin > 0 ? f.cuotaFin : (prox ? prox.cuota : 0),
      saldado: pend.pendientes === 0,
    };
  });

  res.json({ ok: true, data: {
    hoy, mes_ejercicio: mesEjercicio, kpis, ejercicios, prestamos,
    // Array ordenado y no un objeto: el orden de las claves de un objeto no está
    // garantizado al serializar y la tabla va cronológica.
    meses: Object.keys(meses).sort().map(m => ({ mes: m, ...meses[m] })),
  } });
}));

// El cronograma completo de un préstamo, para revisarlo contra el del banco.
router.get('/prestamos/:id/cronograma', wrap((req, res) => {
  const row = unoDe('fp_prestamos', req, req.params.id, 'Préstamo');
  const f = fichaDe(row);
  const hoy = new Date().toISOString().slice(0, 10);
  const pend = pendientesDe(f, hoy);
  const filas = cronograma(f).map((c, k) => ({
    ...c,
    mes: mesDeCuota(f.fecha1, k, f.periodicidad),
    pagada: k < pend.pagadas,
  }));
  res.json({ ok: true, data: { prestamo: { ...row, alias_mostrar: f.alias || f.entidad },
                               cuotas: filas, pagadas: pend.pagadas, pendientes: pend.pendientes } });
}));

// ══════════════════════════════════════════════════════════════════════════
// CHEQUES
// ══════════════════════════════════════════════════════════════════════════

router.get('/cheques', wrap((req, res) => {
  const soc = getSociedadId(req);
  const cond = ['sociedad_id = ?', 'eliminado_en IS NULL'];
  const args = [soc];
  const tipo = vEnum(req.query.tipo, 'Tipo', ['emitido', 'recibido'], null);
  if (tipo) { cond.push('tipo = ?'); args.push(tipo); }
  const estado = vEnum(req.query.estado, 'Estado', ['pendiente', 'pagado', 'anulado'], null);
  if (estado) { cond.push('estado = ?'); args.push(estado); }
  const q = vTexto(req.query.q, 'Búsqueda', { max: 80 });
  if (q) { cond.push('(numero LIKE ? OR beneficiario LIKE ? OR banco LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const filas = db.prepare(`SELECT * FROM fp_cheques WHERE ${cond.join(' AND ')}
    ORDER BY fecha_pago, numero LIMIT 500`).all(...args);
  const total = db.prepare(`SELECT COUNT(*) n, IFNULL(SUM(monto),0) m FROM fp_cheques WHERE ${cond.join(' AND ')}`).get(...args);
  res.json({ ok: true, data: filas, total: total.n, monto_total: total.m, tope: 500 });
}));

/**
 * Import de cheques. Es una carga RECURRENTE, no una migración de una sola vez:
 * cada semana se baja el Excel del sistema y se sube acá. Por eso:
 *   - un cheque ya cargado se ACTUALIZA en vez de duplicarse (índice único por
 *     sociedad+tipo+banco+número);
 *   - el import NUNCA toca `estado` ni `pagado_en`: si acá ya lo marcaste pagado,
 *     que vuelva a venir en el Excel no lo revive.
 * `preview: true` no escribe nada — para ver qué va a pasar antes de aceptarlo.
 */
router.post('/cheques/importar', wrap((req, res) => {
  const soc = getSociedadId(req);
  const filas = Array.isArray(req.body?.filas) ? req.body.filas : null;
  if (!filas) throw bad('Falta la lista de cheques');
  if (!filas.length) throw bad('No hay filas para importar');
  if (filas.length > 2000) throw bad(`Son ${filas.length} filas y el máximo es 2000. Subilas en tandas.`);
  const preview = req.body?.preview === true;
  const tipoDefault = vEnum(req.body?.tipo, 'Tipo', ['emitido', 'recibido'], 'emitido');

  const buscar = db.prepare(`SELECT id, estado, monto, fecha_pago FROM fp_cheques
     WHERE sociedad_id = ? AND tipo = ? AND IFNULL(banco,'') = ? COLLATE NOCASE
       AND numero = ? COLLATE NOCASE AND eliminado_en IS NULL`);

  const nuevos = [], actualizados = [], errores = [];
  const vistos = new Set();

  filas.forEach((f, i) => {
    const linea = i + 1;
    try {
      const tipo = vEnum(f.tipo, 'Tipo', ['emitido', 'recibido'], tipoDefault);
      const numero = vTexto(f.numero, 'Número', { req: true, max: 60 });
      const banco = vTexto(f.banco, 'Banco', { max: 80 }) || '';
      const fecha_pago = vFecha(f.fecha_pago, 'Fecha de pago', { req: true });
      const monto = vNum(f.monto, 'Monto', { min: 0 });
      const clave = [tipo, banco.toLowerCase(), numero.toLowerCase()].join('|');
      if (vistos.has(clave)) throw bad(`El cheque ${numero} viene repetido dentro del mismo archivo`);
      vistos.add(clave);

      const reg = {
        // Cadena vacía, NUNCA null: SQLite considera distintos a dos NULL en un
        // índice único, así que con banco=null el índice que evita duplicados
        // dejaría de funcionar justo para los cheques sin banco.
        tipo, numero, banco, fecha_pago, monto,
        fecha_emision: vFecha(f.fecha_emision, 'Fecha de emisión'),
        beneficiario: vTexto(f.beneficiario, 'Beneficiario', { max: 160 }),
        notas: vTexto(f.notas, 'Notas', { max: 500 }),
        linea,
      };
      const ya = buscar.get(soc, tipo, banco, numero);
      if (ya) {
        reg.id = ya.id;
        reg.cambia = (Math.abs((Number(ya.monto) || 0) - monto) > 0.009) || (ya.fecha_pago !== fecha_pago);
        reg.estado_actual = ya.estado;
        actualizados.push(reg);
      } else {
        nuevos.push(reg);
      }
    } catch (e) {
      errores.push({ linea, error: e.message });
    }
  });

  const resumen = {
    nuevos: nuevos.length,
    ya_estaban: actualizados.length,
    con_cambios: actualizados.filter(a => a.cambia).length,
    ya_pagados_intactos: actualizados.filter(a => a.estado_actual === 'pagado').length,
    errores,
  };

  // Todo-o-nada: una sola fila mala no deja a medias una importación de 800.
  if (errores.length) return res.status(400).json({ ok: false, error: `Hay ${errores.length} fila(s) con problemas`, ...resumen });
  if (preview) return res.json({ ok: true, preview: true, ...resumen, muestra: nuevos.slice(0, 20) });

  db.transaction(() => {
    const ins = db.prepare(`INSERT INTO fp_cheques
      (sociedad_id, tipo, banco, numero, fecha_emision, fecha_pago, monto, beneficiario, notas, importado_en, creado_por_id)
      VALUES (?,?,?,?,?,?,?,?,?,${AHORA},?)`);
    for (const r of nuevos) ins.run(soc, r.tipo, r.banco, r.numero, r.fecha_emision, r.fecha_pago, r.monto, r.beneficiario, r.notas, req.user.id);
    // Ojo: el UPDATE deja `estado` y `pagado_en` afuera a propósito.
    const upd = db.prepare(`UPDATE fp_cheques SET fecha_emision=?, fecha_pago=?, monto=?, beneficiario=?,
      importado_en=${AHORA}, actualizado_en=${AHORA}, actualizado_por_id=? WHERE id=?`);
    for (const r of actualizados) upd.run(r.fecha_emision, r.fecha_pago, r.monto, r.beneficiario, req.user.id, r.id);
  })();

  logFp('cheques', null, 'import', resumen, req.user.id);
  res.json({ ok: true, ...resumen });
}));

router.patch('/cheques/:id', wrap((req, res) => {
  const c = unoDe('fp_cheques', req, req.params.id, 'Cheque');
  const estado = vEnum(req.body?.estado, 'Estado', ['pendiente', 'pagado', 'anulado'], c.estado);
  db.prepare(`UPDATE fp_cheques SET estado=?, pagado_en=?, actualizado_en=${AHORA}, actualizado_por_id=? WHERE id=?`)
    .run(estado, estado === 'pagado' ? (c.pagado_en || new Date().toISOString().slice(0, 10)) : null, req.user.id, c.id);
  res.json({ ok: true });
}));

router.delete('/cheques/:id', wrap((req, res) => {
  const c = unoDe('fp_cheques', req, req.params.id, 'Cheque');
  db.prepare(`UPDATE fp_cheques SET eliminado_en=${AHORA}, eliminado_por_id=? WHERE id=?`).run(req.user.id, c.id);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════════════════
// SALDOS DE BANCO
// ══════════════════════════════════════════════════════════════════════════

router.get('/saldos', wrap((req, res) => {
  const soc = getSociedadId(req);
  const filas = db.prepare(`SELECT * FROM fp_saldos WHERE sociedad_id = ? AND eliminado_en IS NULL
     ORDER BY fecha DESC, banco COLLATE NOCASE`).all(soc);
  res.json({ ok: true, data: filas });
}));

router.post('/saldos', wrap((req, res) => {
  const soc = getSociedadId(req);
  const banco = vTexto(req.body?.banco, 'Banco', { req: true, max: 80 });
  const fecha = vFecha(req.body?.fecha, 'Fecha', { req: true });
  const saldo = vNum(req.body?.saldo, 'Saldo', {});   // negativo es válido: descubierto
  const notas = vTexto(req.body?.notas, 'Notas', { max: 500 });
  const ya = db.prepare(`SELECT id FROM fp_saldos WHERE sociedad_id=? AND banco=? COLLATE NOCASE
     AND fecha=? AND eliminado_en IS NULL`).get(soc, banco, fecha);
  if (ya) {
    db.prepare(`UPDATE fp_saldos SET saldo=?, notas=?, actualizado_en=${AHORA}, actualizado_por_id=? WHERE id=?`)
      .run(saldo, notas, req.user.id, ya.id);
    return res.json({ ok: true, id: ya.id, actualizado: true });
  }
  const info = db.prepare(`INSERT INTO fp_saldos (sociedad_id, banco, fecha, saldo, notas, creado_por_id)
     VALUES (?,?,?,?,?,?)`).run(soc, banco, fecha, saldo, notas, req.user.id);
  res.json({ ok: true, id: info.lastInsertRowid });
}));

router.delete('/saldos/:id', wrap((req, res) => {
  const s = unoDe('fp_saldos', req, req.params.id, 'Saldo');
  db.prepare(`UPDATE fp_saldos SET eliminado_en=${AHORA}, eliminado_por_id=? WHERE id=?`).run(req.user.id, s.id);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════════════════
// CONCEPTOS (las filas del flujo)
// ══════════════════════════════════════════════════════════════════════════

router.get('/conceptos', wrap((req, res) => {
  const soc = getSociedadId(req);
  res.json({ ok: true, data: conceptosDe(soc) });
}));

function conceptosDe(soc) {
  let filas = db.prepare(`SELECT * FROM fp_conceptos WHERE sociedad_id = ? AND eliminado_en IS NULL
     ORDER BY orden, id`).all(soc);
  // La siembra mira si hubo conceptos ALGUNA VEZ, incluidos los borrados. Con
  // `!filas.length` a secas, borrar todas las filas hace que la próxima
  // proyección las resucite, y no habría forma de dejar el flujo vacío.
  const hubo = db.prepare('SELECT COUNT(*) n FROM fp_conceptos WHERE sociedad_id = ?').get(soc).n;
  if (!filas.length && !hubo) {
    // Siembra con las filas de la planilla, para que la primera pantalla no esté
    // vacía. Las calculadas (préstamos y cheques) reemplazan el pase a mano entre
    // la hoja Prestamos y la hoja Flujo.
    const base = [
      ['Cheques a cobrar',            'ingreso', 'cheques',   null,        10],
      ['Cobranzas estimadas',         'ingreso', 'manual',    null,        20],
      ['FCI / colocaciones',          'ingreso', 'manual',    null,        30],
      ['Cheques a pagar',             'egreso',  'cheques',   null,       100],
      ['Préstamos — BBVA',            'egreso',  'prestamos', 'BBVA',     110],
      ['Préstamos — Galicia',         'egreso',  'prestamos', 'Galicia',  120],
      ['Préstamos — San Juan',        'egreso',  'prestamos', 'San Juan', 130],
      ['Préstamos — Nación',          'egreso',  'prestamos', 'Nacion',   140],
      ['Préstamos — Santander',       'egreso',  'prestamos', 'Santander',150],
      ['Préstamos — Bice',            'egreso',  'prestamos', 'Bice',     160],
      ['Planes de pago AFIP',         'egreso',  'manual',    null,       200],
      ['IVA',                         'egreso',  'manual',    null,       210],
      ['Ingresos Brutos',             'egreso',  'manual',    null,       220],
      ['F931',                        'egreso',  'manual',    null,       230],
      ['Presupuesto semanal',         'egreso',  'manual',    null,       240],
      ['Importación',                 'egreso',  'manual',    null,       250],
    ];
    const ins = db.prepare(`INSERT INTO fp_conceptos (sociedad_id, nombre, naturaleza, origen, banco, orden)
       VALUES (?,?,?,?,?,?)`);
    db.transaction(() => { for (const b of base) ins.run(soc, b[0], b[1], b[2], b[3], b[4]); })();
    filas = db.prepare(`SELECT * FROM fp_conceptos WHERE sociedad_id = ? AND eliminado_en IS NULL
       ORDER BY orden, id`).all(soc);
  }
  return filas;
}

router.post('/conceptos', wrap((req, res) => {
  const soc = getSociedadId(req);
  const nombre = vTexto(req.body?.nombre, 'Nombre', { req: true, max: 120 });
  const naturaleza = vEnum(req.body?.naturaleza, 'Naturaleza', ['ingreso', 'egreso'], 'egreso');
  const origen = vEnum(req.body?.origen, 'Origen', ['manual', 'prestamos', 'cheques'], 'manual');
  const banco = vTexto(req.body?.banco, 'Banco', { max: 80 });
  const orden = vNum(req.body?.orden, 'Orden', { min: 0, max: 9999, def: 500, entero: true });
  const info = db.prepare(`INSERT INTO fp_conceptos (sociedad_id, nombre, naturaleza, origen, banco, orden, creado_por_id)
     VALUES (?,?,?,?,?,?,?)`).run(soc, nombre, naturaleza, origen, banco, orden, req.user.id);
  res.json({ ok: true, id: info.lastInsertRowid });
}));

router.delete('/conceptos/:id', wrap((req, res) => {
  const c = unoDe('fp_conceptos', req, req.params.id, 'Concepto');
  db.prepare(`UPDATE fp_conceptos SET eliminado_en=${AHORA}, eliminado_por_id=? WHERE id=?`).run(req.user.id, c.id);
  res.json({ ok: true });
}));

// Carga manual de una celda. Monto 0 borra la celda en vez de guardar un cero:
// una grilla llena de ceros no se lee.
router.put('/valores', wrap((req, res) => {
  const concepto_id = vNum(req.body?.concepto_id, 'Concepto', { min: 1, entero: true });
  const semana = vFecha(req.body?.semana, 'Semana', { req: true });
  const monto = vNum(req.body?.monto, 'Monto', { def: 0 });
  const c = unoDe('fp_conceptos', req, concepto_id, 'Concepto');
  if (c.origen !== 'manual') throw bad(`"${c.nombre}" se calcula solo desde ${c.origen}; no se carga a mano`);
  if (lunesDe(semana) !== semana) throw bad('La semana tiene que ser un lunes');

  if (!monto) {
    db.prepare('DELETE FROM fp_valores WHERE concepto_id = ? AND semana = ?').run(concepto_id, semana);
    return res.json({ ok: true, borrado: true });
  }
  db.prepare(`INSERT INTO fp_valores (concepto_id, semana, monto, nota, actualizado_por_id) VALUES (?,?,?,?,?)
     ON CONFLICT(concepto_id, semana) DO UPDATE SET monto=excluded.monto, nota=excluded.nota,
       actualizado_en=${AHORA}, actualizado_por_id=excluded.actualizado_por_id`)
    .run(concepto_id, semana, monto, vTexto(req.body?.nota, 'Nota', { max: 300 }), req.user.id);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════════════════
// PROYECCIÓN — el módulo entero existe para esto
// ══════════════════════════════════════════════════════════════════════════

router.get('/proyeccion', wrap((req, res) => {
  const soc = getSociedadId(req);
  const hoy = new Date().toISOString().slice(0, 10);
  const desde = vFecha(req.query.desde, 'Desde') || hoy;
  const semanas = vNum(req.query.semanas, 'Semanas', { min: 1, max: 104, def: 13, entero: true });
  const arranque = lunesDe(desde);

  const conceptos = conceptosDe(soc);

  // El saldo inicial es el ÚLTIMO saldo cargado de cada banco que no sea posterior
  // al arranque del horizonte. Entra una vez y como punto de partida, no como un
  // ingreso: ese es exactamente el error que hace que el acumulado de la planilla
  // llegue a -2.309 millones.
  const saldos = db.prepare(`
    SELECT s.banco, s.fecha, s.saldo FROM fp_saldos s
     WHERE s.sociedad_id = ? AND s.eliminado_en IS NULL AND s.fecha <= ?
       AND s.fecha = (SELECT MAX(s2.fecha) FROM fp_saldos s2
                       WHERE s2.sociedad_id = s.sociedad_id AND s2.banco = s.banco
                         AND s2.eliminado_en IS NULL AND s2.fecha <= ?)
     ORDER BY s.banco COLLATE NOCASE`).all(soc, arranque, arranque);
  const saldoInicial = saldos.reduce((a, s) => a + (Number(s.saldo) || 0), 0);

  // Sumar el saldo de un banco de hace tres meses con el de otro de ayer da un
  // número que no es la posición de ninguna fecha, y peor: lo que se pagó en el
  // medio ya está marcado 'pagado', así que tampoco aparece en la proyección.
  // No se bloquea (obligaría a cargar los 6 bancos el mismo día para poder mirar
  // el flujo), pero se informa la dispersión para que el front avise.
  const fechas = saldos.map(s => s.fecha).filter(Boolean).sort();
  const dias = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const saldoFechas = fechas.length
    ? { min: fechas[0], max: fechas[fechas.length - 1], dispersion_dias: dias(fechas[0], fechas[fechas.length - 1]) }
    : { min: null, max: null, dispersion_dias: 0 };

  const cuotas = db.prepare(`
    SELECT c.periodo, c.capital, c.interes, c.nro_cuota, p.semana_debito, p.banco, p.numero
      FROM fp_prestamo_cuotas c
      JOIN fp_prestamos p ON p.id = c.prestamo_id
     WHERE p.sociedad_id = ? AND p.eliminado_en IS NULL AND p.estado = 'vigente'
       AND c.estado = 'pendiente'`).all(soc);

  const cheques = db.prepare(`SELECT tipo, banco, numero, beneficiario, fecha_pago, monto
      FROM fp_cheques WHERE sociedad_id = ? AND eliminado_en IS NULL AND estado = 'pendiente'`).all(soc);

  const ids = conceptos.filter(c => c.origen === 'manual').map(c => c.id);
  const valores = ids.length
    ? db.prepare(`SELECT concepto_id, semana, monto FROM fp_valores
        WHERE concepto_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : [];

  const r = proyectar({ desde: arranque, semanas, saldoInicial, conceptos, valores, cuotas, cheques });
  res.json({ ok: true, data: { ...r, saldos_banco: saldos, saldo_fechas: saldoFechas, hoy } });
}));

export default router;
