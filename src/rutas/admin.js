// src/rutas/admin.js
// Panel de actividad / adopción — Nivel 1 (read-only). Infiere actividad de CARGA a partir
// de las columnas de autoría que YA existen (creado_por / cargado_por / valorizado_por /
// usuario_id) + creado_en. NO instrumenta logins ni toca auth.js. Cross-system: consulta
// tablas de todos los módulos sobre la misma DB SQLite.
import express from 'express';
import { getDb } from '../servicios/db.js';

const router = express.Router();
const db = () => getDb();

// Middleware: parsea la cookie lnb_user → req.user (mismo patrón que org.js).
router.use((req, res, next) => {
  try { const c = req.cookies?.lnb_user; if (c) req.user = JSON.parse(c); } catch (_) {}
  next();
});
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.rol !== 'admin') return res.status(403).json({ ok: false, error: 'Solo admin' });
  next();
};

// Mapa CURADO tabla → (columna de autor, módulo). Cada candidato se VALIDA contra el esquema
// real (PRAGMA) antes de usarse, así si una tabla/columna no existe en una DB dada, se saltea
// (robusto frente a variaciones de prod). Los nombres salen de esta lista, NO de input → sin
// riesgo de inyección. Solo las fechas van parametrizadas.
const CANDIDATOS = [
  ['pa_asistencias',             'cargado_por',    'Personal'],
  ['pa_asistencia_valorizacion', 'valorizado_por', 'Personal'],
  ['pa_cc_movimientos',          'cargado_por',    'Personal'],
  ['pa_semanas_pago',            'creado_por',     'Personal'],
  ['pa_lotes',                   'creado_por',     'Producción'],
  ['pa_compras',                 'usuario_id',     'Producción'],
  ['pa_aplicaciones',            'usuario_id',     'Producción'],
  ['pa_movimientos_stock',       'usuario_id',     'Producción'],
  ['pa_panol_movimientos',       'usuario_id',     'Producción'],
  ['pa_combustible_movimientos', 'usuario_id',     'Producción'],
  ['pa_asientos',                'usuario_id',     'Contabilidad'],
  ['pa_cuentas_log',             'usuario_id',     'Contabilidad'],
  ['fin_movimientos',            'usuario_id',     'Financiero'],
  ['pa_pagos_proveedores',       'usuario_id',     'Financiero'],
  ['ven_liquidaciones',          'usuario_id',     'Ventas'],
  ['ven_facturas',               'usuario_id',     'Ventas'],
  ['ven_cobranzas',              'usuario_id',     'Ventas'],
  ['sg_productos',               'creado_por',     'San Gerónimo'],
  ['sg_clientes',                'creado_por',     'San Gerónimo'],
  ['sg_oc',                      'creado_por',     'San Gerónimo'],
  ['sg_recepciones',             'creado_por',     'San Gerónimo'],
  ['sg_lotes',                   'creado_por',     'San Gerónimo'],
  ['sg_pedidos',                 'creado_por',     'San Gerónimo'],
  ['sg_despachos',               'creado_por',     'San Gerónimo'],
  ['ifco_remitos_super',         'usuario_id',     'Cajones IFCO'],
  ['ifco_movimientos',           'usuario_id',     'Cajones IFCO'],
  ['ifco_recepciones_proveedor', 'usuario_id',     'Cajones IFCO'],
  ['ifco_envios_proveedor',      'usuario_id',     'Cajones IFCO'],
  ['clientes',                   'usuario_id',     'Abasto/Scout'],
  ['pedidos',                    'usuario_id',     'Abasto/Scout'],
  ['facturas',                   'usuario_id',     'Abasto/Scout']
];

// GET /api/admin/actividad?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&modulo=<opcional>
router.get('/actividad', requireAdmin, (req, res) => {
  const d = db();
  try {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const hoy = d.prepare("SELECT date('now','localtime') x").get().x;
    const desde = (req.query.desde && re.test(req.query.desde)) ? req.query.desde
      : d.prepare("SELECT date('now','localtime','-30 days') x").get().x;
    const hasta = (req.query.hasta && re.test(req.query.hasta)) ? req.query.hasta : hoy;
    const filtroMod = req.query.modulo || null;
    const modulos_disponibles = [...new Set(CANDIDATOS.map(c => c[2]))];

    // Validar candidatos contra el esquema real (tabla existe + tiene autor + creado_en).
    const tablas = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const colsDe = (t) => { try { return new Set(d.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name)); } catch (e) { return new Set(); } };
    const usar = CANDIDATOS.filter(([t, a, m]) => {
      if (filtroMod && m !== filtroMod) return false;
      if (!tablas.has(t)) return false;
      const c = colsDe(t);
      return c.has(a) && c.has('creado_en');
    });

    if (!usar.length) {
      return res.json({ ok: true, rango: { desde, hasta }, modulo_filtro: filtroMod, modulos_disponibles, tablas_usadas: 0, por_usuario: [], por_modulo: [] });
    }

    // UNION ALL normalizado: (uid, ts, modulo). Una sola pasada agregando por (uid, modulo).
    const partes = usar.map(([t, a, m]) =>
      `SELECT ${a} AS uid, creado_en AS ts, '${m.replace(/'/g, "''")}' AS modulo FROM ${t} WHERE creado_en IS NOT NULL AND date(creado_en) BETWEEN ? AND ?`);
    const params = [];
    usar.forEach(() => params.push(desde, hasta));
    const grp = d.prepare(
      `SELECT uid, modulo, COUNT(*) AS n, MAX(ts) AS ult FROM ( ${partes.join(' UNION ALL ')} ) GROUP BY uid, modulo`
    ).all(...params);

    // ── por_modulo ──
    const modMap = {};
    for (const r of grp) {
      const mm = modMap[r.modulo] || (modMap[r.modulo] = { modulo: r.modulo, registros: 0, usuarios: new Set(), sin_autor: 0, ultimo: null });
      mm.registros += r.n;
      if (r.uid == null) mm.sin_autor += r.n; else mm.usuarios.add(r.uid);
      if (r.ult && (!mm.ultimo || r.ult > mm.ultimo)) mm.ultimo = r.ult;
    }
    const por_modulo = Object.values(modMap)
      .map(m => ({ modulo: m.modulo, registros: m.registros, usuarios: m.usuarios.size, sin_autor: m.sin_autor, ultimo: m.ultimo }))
      .sort((a, b) => b.registros - a.registros);

    // ── por_usuario (LEFT JOIN desde usuarios → incluye los SIN actividad) ──
    const actByUid = {};
    for (const r of grp) {
      const key = (r.uid == null) ? '__null__' : r.uid;
      const a = actByUid[key] || (actByUid[key] = { total: 0, ult: null, modulos: {} });
      a.total += r.n;
      a.modulos[r.modulo] = (a.modulos[r.modulo] || 0) + r.n;
      if (r.ult && (!a.ult || r.ult > a.ult)) a.ult = r.ult;
    }
    // ultimo_acceso (último login OK; NULL = nunca entró desde que existe la columna).
    // La columna la crea la migración de db.js al boot; igual blindamos por si no existiera.
    const tieneAcceso = colsDe('usuarios').has('ultimo_acceso');
    const usuarios = d.prepare(
      `SELECT id, nombre, rol, activo${tieneAcceso ? ', ultimo_acceso' : ''} FROM usuarios ORDER BY nombre COLLATE NOCASE`
    ).all();
    const por_usuario = usuarios.map(u => {
      const a = actByUid[u.id] || { total: 0, ult: null, modulos: {} };
      return { id: u.id, nombre: u.nombre, rol: u.rol, activo: u.activo, total: a.total, ultimo: a.ult, ultimo_acceso: u.ultimo_acceso || null, modulos: a.modulos };
    });
    if (actByUid['__null__']) {
      const a = actByUid['__null__'];
      por_usuario.push({ id: null, nombre: '(sin autor — legacy)', rol: '—', activo: 1, total: a.total, ultimo: a.ult, ultimo_acceso: null, modulos: a.modulos });
    }
    por_usuario.sort((a, b) => b.total - a.total);

    res.json({ ok: true, rango: { desde, hasta }, modulo_filtro: filtroMod, modulos_disponibles, tablas_usadas: usar.length, por_usuario, por_modulo });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
