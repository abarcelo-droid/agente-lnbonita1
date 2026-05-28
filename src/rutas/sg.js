// src/rutas/sg.js
// ── API SAN GERÓNIMO — PUENTE CORDON SA ───────────────────────────────────────
// Operatoria mayorista frutihortícola. Universo sg_* independiente.
// Fase 1: catálogo (productos, presentaciones, proveedores, clientes,
// condiciones de pago + cuotas). Compras/Stock/Ventas/Reportes en fases siguientes.

import express from 'express';
import { getDb } from '../servicios/db.js';
import '../servicios/db_sg.js'; // corre el DDL sg_* al importarse

const router = express.Router();

// ── Auth (copia local, patrón del repo: produccion.js) ──────────────────────────
function requireAuth(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    req.user = JSON.parse(cookie);
    next();
  } catch (e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

// Escritura/borrado: solo admin en V1 (el sidebar también es admin-only).
function requireAdmin(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    req.user = JSON.parse(cookie);
    if (req.user.rol !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    next();
  } catch (e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const uid = (req) => (req.user && req.user.id) || null;

// Limpia undefined → null y recorta strings.
function val(v) {
  if (v === undefined || v === '') return null;
  if (typeof v === 'string') return v.trim();
  return v;
}

// CRUD genérico soft-delete sobre una tabla con columnas de auditoría estándar.
// fields: lista de columnas asignables desde el body.
function montarCRUD(path, tabla, fields, opts = {}) {
  const { orderBy = 'id DESC', listExtra = null } = opts;

  // LISTAR (incluye inactivos solo si ?todos=1)
  router.get(`/${path}`, requireAuth, (req, res) => {
    const db = getDb();
    try {
      const incluirInactivos = req.query.todos === '1';
      let where = incluirInactivos ? '1=1' : 'activo=1';
      const params = [];
      if (listExtra) {
        const ex = listExtra(req, params);
        if (ex) where += ` AND ${ex}`;
      }
      const rows = db.prepare(`SELECT * FROM ${tabla} WHERE ${where} ORDER BY ${orderBy}`).all(...params);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // OBTENER uno
  router.get(`/${path}/:id`, requireAuth, (req, res) => {
    const db = getDb();
    try {
      const row = db.prepare(`SELECT * FROM ${tabla} WHERE id=?`).get(req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: 'No encontrado' });
      res.json({ ok: true, data: row });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // CREAR
  router.post(`/${path}`, requireAdmin, (req, res) => {
    const db = getDb();
    try {
      const cols = [], place = [], vals = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) { cols.push(f); place.push('?'); vals.push(val(req.body[f])); }
      }
      cols.push('creado_por'); place.push('?'); vals.push(uid(req));
      const info = db.prepare(`INSERT INTO ${tabla} (${cols.join(',')}) VALUES (${place.join(',')})`).run(...vals);
      const row = db.prepare(`SELECT * FROM ${tabla} WHERE id=?`).get(info.lastInsertRowid);
      res.json({ ok: true, data: row });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // EDITAR
  router.put(`/${path}/:id`, requireAdmin, (req, res) => {
    const db = getDb();
    try {
      const sets = [], vals = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) { sets.push(`${f}=?`); vals.push(val(req.body[f])); }
      }
      if (!sets.length) return res.status(400).json({ ok: false, error: 'Sin cambios' });
      sets.push(`modificado_en=datetime('now','localtime')`);
      sets.push('modificado_por=?'); vals.push(uid(req));
      vals.push(req.params.id);
      const info = db.prepare(`UPDATE ${tabla} SET ${sets.join(',')} WHERE id=?`).run(...vals);
      if (!info.changes) return res.status(404).json({ ok: false, error: 'No encontrado' });
      const row = db.prepare(`SELECT * FROM ${tabla} WHERE id=?`).get(req.params.id);
      res.json({ ok: true, data: row });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // BORRAR (soft)
  router.delete(`/${path}/:id`, requireAdmin, (req, res) => {
    const db = getDb();
    try {
      const info = db.prepare(
        `UPDATE ${tabla} SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=? WHERE id=? AND activo=1`
      ).run(uid(req), req.params.id);
      if (!info.changes) return res.status(404).json({ ok: false, error: 'No encontrado o ya eliminado' });
      res.json({ ok: true, data: { id: Number(req.params.id) } });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
}

// ── PRODUCTOS ──────────────────────────────────────────────────────────────────
montarCRUD('productos', 'sg_productos',
  ['codigo', 'nombre', 'familia', 'unidad_base', 'vida_util_dias_default'],
  { orderBy: 'nombre COLLATE NOCASE' });

// ── PRESENTACIONES (filtra por producto_id) ──────────────────────────────────────
montarCRUD('presentaciones', 'sg_presentaciones',
  ['producto_id', 'nombre', 'factor_conversion'],
  {
    orderBy: 'nombre COLLATE NOCASE',
    listExtra: (req, params) => {
      if (req.query.producto_id) { params.push(req.query.producto_id); return 'producto_id=?'; }
      return null;
    }
  });

// ── PROVEEDORES ──────────────────────────────────────────────────────────────────
montarCRUD('proveedores', 'sg_proveedores',
  ['razon_social', 'cuit', 'tipo', 'categoria_fiscal', 'tipo_fiscal_habitual',
   'condicion_pago_habitual_id', 'comercial_responsable_id', 'localidad', 'provincia',
   'telefono', 'email', 'observaciones', 'adm_proveedor_id'],
  { orderBy: 'razon_social COLLATE NOCASE' });

// ── CLIENTES ──────────────────────────────────────────────────────────────────
montarCRUD('clientes', 'sg_clientes',
  ['razon_social', 'cuit', 'tipo', 'categoria_fiscal', 'tipo_fiscal_habitual',
   'condicion_pago_habitual_id', 'comercial_responsable_id', 'modalidad_pedido',
   'limite_credito', 'localidad', 'provincia', 'direccion_entrega', 'telefono',
   'email', 'observaciones'],
  { orderBy: 'razon_social COLLATE NOCASE' });

// ── CONDICIONES DE PAGO (+ cuotas) ────────────────────────────────────────────────
// Las cuotas se manejan junto a la cabecera (deben sumar 100%).

function leerCuotas(db, condId) {
  return db.prepare(
    'SELECT id, condicion_pago_id, orden, porcentaje, base_calculo, dias_offset FROM sg_condiciones_pago_cuotas WHERE condicion_pago_id=? ORDER BY orden'
  ).all(condId);
}

function validarCuotas(cuotas) {
  if (!Array.isArray(cuotas) || cuotas.length === 0) return 'Debe haber al menos una cuota';
  const suma = cuotas.reduce((a, c) => a + Number(c.porcentaje || 0), 0);
  if (Math.abs(suma - 100) > 0.01) return `Las cuotas deben sumar 100% (suman ${suma})`;
  for (const c of cuotas) {
    if (!['fecha_oc', 'fecha_recepcion', 'fecha_factura', 'al_pedido'].includes(c.base_calculo)) {
      return `base_calculo inválida: ${c.base_calculo}`;
    }
  }
  return null;
}

// LISTAR condiciones (con sus cuotas embebidas)
router.get('/condiciones-pago', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const incluirInactivos = req.query.todos === '1';
    const rows = db.prepare(
      `SELECT * FROM sg_condiciones_pago WHERE ${incluirInactivos ? '1=1' : 'activo=1'} ORDER BY nombre COLLATE NOCASE`
    ).all();
    for (const r of rows) r.cuotas = leerCuotas(db, r.id);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// OBTENER una condición (con cuotas)
router.get('/condiciones-pago/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const row = db.prepare('SELECT * FROM sg_condiciones_pago WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'No encontrado' });
    row.cuotas = leerCuotas(db, row.id);
    res.json({ ok: true, data: row });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// CREAR condición + cuotas (transacción)
router.post('/condiciones-pago', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const { nombre, cuotas } = req.body;
    if (!val(nombre)) return res.status(400).json({ ok: false, error: 'Falta nombre' });
    const err = validarCuotas(cuotas);
    if (err) return res.status(400).json({ ok: false, error: err });

    const tx = db.transaction(() => {
      const info = db.prepare(
        'INSERT INTO sg_condiciones_pago (nombre, creado_por) VALUES (?,?)'
      ).run(val(nombre), uid(req));
      const condId = info.lastInsertRowid;
      const ins = db.prepare(
        'INSERT INTO sg_condiciones_pago_cuotas (condicion_pago_id, orden, porcentaje, base_calculo, dias_offset) VALUES (?,?,?,?,?)'
      );
      cuotas.forEach((c, i) => ins.run(condId, c.orden || i + 1, Number(c.porcentaje), c.base_calculo, Number(c.dias_offset || 0)));
      return condId;
    });
    const condId = tx();
    const row = db.prepare('SELECT * FROM sg_condiciones_pago WHERE id=?').get(condId);
    row.cuotas = leerCuotas(db, condId);
    res.json({ ok: true, data: row });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// EDITAR condición + reemplazar cuotas (transacción)
router.put('/condiciones-pago/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const { nombre, cuotas } = req.body;
    const existe = db.prepare('SELECT id FROM sg_condiciones_pago WHERE id=?').get(req.params.id);
    if (!existe) return res.status(404).json({ ok: false, error: 'No encontrado' });
    if (cuotas !== undefined) {
      const err = validarCuotas(cuotas);
      if (err) return res.status(400).json({ ok: false, error: err });
    }
    const tx = db.transaction(() => {
      if (val(nombre) !== null) {
        db.prepare(
          `UPDATE sg_condiciones_pago SET nombre=?, modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`
        ).run(val(nombre), uid(req), req.params.id);
      }
      if (cuotas !== undefined) {
        db.prepare('DELETE FROM sg_condiciones_pago_cuotas WHERE condicion_pago_id=?').run(req.params.id);
        const ins = db.prepare(
          'INSERT INTO sg_condiciones_pago_cuotas (condicion_pago_id, orden, porcentaje, base_calculo, dias_offset) VALUES (?,?,?,?,?)'
        );
        cuotas.forEach((c, i) => ins.run(req.params.id, c.orden || i + 1, Number(c.porcentaje), c.base_calculo, Number(c.dias_offset || 0)));
      }
    });
    tx();
    const row = db.prepare('SELECT * FROM sg_condiciones_pago WHERE id=?').get(req.params.id);
    row.cuotas = leerCuotas(db, req.params.id);
    res.json({ ok: true, data: row });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// BORRAR condición (soft)
router.delete('/condiciones-pago/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const info = db.prepare(
      `UPDATE sg_condiciones_pago SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=? WHERE id=? AND activo=1`
    ).run(uid(req), req.params.id);
    if (!info.changes) return res.status(404).json({ ok: false, error: 'No encontrado o ya eliminado' });
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

export default router;
