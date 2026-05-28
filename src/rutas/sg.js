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

// ════════════════════════════════════════════════════════════════════════════
// FASE 2 — COMPRAS: OC + Recepción + Lotes + Costeo + Vencimientos
// ════════════════════════════════════════════════════════════════════════════

// ── Helpers ──────────────────────────────────────────────────────────────────

// Numerador correlativo por día: PREFIJO-YYYYMMDD-NNNN
function nextNumero(db, prefijo, tabla, col) {
  const fecha = db.prepare("SELECT strftime('%Y%m%d','now','localtime') d").get().d;
  const like = `${prefijo}-${fecha}-%`;
  const n = db.prepare(`SELECT COUNT(*) c FROM ${tabla} WHERE ${col} LIKE ?`).get(like).c;
  return `${prefijo}-${fecha}-${String(n + 1).padStart(4, '0')}`;
}

// Recalcula costo_final de un lote = costo_base + gastos directos + prorrateo global del período.
// Prorrateo: monto global del período × (kg del lote / total kg activos del período).
function recalcCostoLote(db, loteId) {
  const lote = db.prepare('SELECT id, kg_reales, costo_base, fecha_ingreso FROM sg_lotes WHERE id=?').get(loteId);
  if (!lote) return 0;
  const gd = db.prepare('SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_directos_lote WHERE lote_id=? AND activo=1').get(loteId).s;
  let prorrateo = 0;
  const periodo = (lote.fecha_ingreso || '').slice(0, 7);
  if (periodo) {
    const totalGlob = db.prepare('SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_globales_periodo WHERE periodo=? AND activo=1').get(periodo).s;
    const totalKg = db.prepare("SELECT COALESCE(SUM(kg_reales),0) s FROM sg_lotes WHERE activo=1 AND substr(fecha_ingreso,1,7)=?").get(periodo).s;
    if (totalKg > 0) prorrateo = totalGlob * (lote.kg_reales / totalKg);
  }
  const costoFinal = (lote.costo_base || 0) + gd + prorrateo;
  db.prepare("UPDATE sg_lotes SET costo_final=?, modificado_en=datetime('now','localtime') WHERE id=?").run(costoFinal, loteId);
  return costoFinal;
}

// Recalcula el costo_final de todos los lotes activos de un período (al cambiar un gasto global).
function recalcPeriodo(db, periodo) {
  if (!periodo) return;
  const lotes = db.prepare("SELECT id FROM sg_lotes WHERE activo=1 AND substr(fecha_ingreso,1,7)=?").all(periodo);
  for (const l of lotes) recalcCostoLote(db, l.id);
}

// Explota las cuotas de la condición de pago de la OC en sg_oc_vencimientos.
// Firme: usa total_estimado_monto (o suma real de lotes si ya hay recepción).
// Pizarra: solo genera cuando TODOS los lotes de la OC tienen precio cerrado.
function generarVencimientos(db, ocId) {
  const oc = db.prepare('SELECT * FROM sg_oc WHERE id=?').get(ocId);
  if (!oc || !oc.condicion_pago_id) return;
  // No tocar si ya hay cuotas pagadas (operación liquidada).
  const pagadas = db.prepare('SELECT COUNT(*) c FROM sg_oc_vencimientos WHERE oc_id=? AND pagado=1').get(ocId).c;
  if (pagadas > 0) return;
  const cuotas = db.prepare('SELECT * FROM sg_condiciones_pago_cuotas WHERE condicion_pago_id=? ORDER BY orden').all(oc.condicion_pago_id);
  if (!cuotas.length) return;

  const real = db.prepare(`
    SELECT COALESCE(SUM(l.costo_base),0) s, COUNT(*) n,
           SUM(CASE WHEN l.precio_unitario_kg IS NULL THEN 1 ELSE 0 END) sinprecio
    FROM sg_lotes l JOIN sg_oc_items i ON l.oc_item_id=i.id
    WHERE i.oc_id=? AND l.activo=1`).get(ocId);
  let monto;
  if (real.n > 0) {
    if (real.sinprecio > 0) return; // pizarra con precios pendientes → no generar todavía
    monto = real.s;
  } else {
    monto = oc.total_estimado_monto || 0;
  }
  if (!monto) return;

  const ultRec = db.prepare('SELECT MAX(fecha_recepcion) f FROM sg_recepciones WHERE oc_id=? AND activo=1').get(ocId).f;
  const fechaBase = (bc) => {
    if (bc === 'fecha_recepcion') return ultRec || oc.fecha_recepcion_estimada || oc.fecha_oc;
    if (bc === 'fecha_factura') return ultRec || oc.fecha_oc; // sin factura en V1 (aprox)
    return oc.fecha_oc; // fecha_oc / al_pedido
  };

  db.prepare('DELETE FROM sg_oc_vencimientos WHERE oc_id=? AND pagado=0').run(ocId);
  const ins = db.prepare('INSERT INTO sg_oc_vencimientos (oc_id, cuota_orden, porcentaje, monto, fecha_vencimiento) VALUES (?,?,?,?,?)');
  for (const c of cuotas) {
    const base = fechaBase(c.base_calculo);
    let fv = base;
    if (base && c.dias_offset) fv = db.prepare('SELECT date(?, ?) d').get(base, `+${c.dias_offset} days`).d;
    ins.run(ocId, c.orden, c.porcentaje, monto * (c.porcentaje / 100), fv);
  }
}

// Autocompleta tipo_fiscal/condicion_pago desde el proveedor si no vinieron en el body.
function defaultsProveedor(db, proveedorId, body) {
  const p = proveedorId ? db.prepare('SELECT tipo_fiscal_habitual, condicion_pago_habitual_id FROM sg_proveedores WHERE id=?').get(proveedorId) : null;
  return {
    tipo_fiscal: val(body.tipo_fiscal) || (p && p.tipo_fiscal_habitual) || 'factura_a',
    condicion_pago_id: body.condicion_pago_id != null ? body.condicion_pago_id : (p && p.condicion_pago_habitual_id) || null
  };
}

// Crea los lotes de un item de recepción. Devuelve cantidad creada.
function crearLotesDeItem(db, { recepcionId, ocItem, tipoPrecio, fechaIngreso, lotes, userId }) {
  const prod = db.prepare('SELECT vida_util_dias_default FROM sg_productos WHERE id=?').get(ocItem.producto_id);
  const vida = (prod && prod.vida_util_dias_default) || 0;
  const ins = db.prepare(`INSERT INTO sg_lotes
    (codigo_lote, recepcion_id, oc_item_id, producto_id, kg_reales, precio_unitario_kg, costo_base,
     calidad, calibre, origen, fecha_ingreso, fecha_vencimiento_estimada, estado, costo_final, creado_por)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'disponible', ?, ?)`);
  const ids = [];
  for (const lt of lotes) {
    const kg = Number(lt.kg_reales || 0);
    const precio = tipoPrecio === 'firme' ? (ocItem.precio_estimado_por_kg != null ? Number(ocItem.precio_estimado_por_kg) : null) : null;
    const costoBase = precio != null ? kg * precio : 0;
    let venc = val(lt.fecha_vencimiento_estimada);
    if (!venc && fechaIngreso && vida) venc = db.prepare('SELECT date(?, ?) d').get(fechaIngreso, `+${vida} days`).d;
    const codigo = nextNumero(db, 'SG-LT', 'sg_lotes', 'codigo_lote');
    const info = ins.run(codigo, recepcionId, ocItem.id, ocItem.producto_id, kg, precio, costoBase,
      val(lt.calidad), val(lt.calibre), val(lt.origen), fechaIngreso, venc, costoBase, userId);
    ids.push(info.lastInsertRowid);
  }
  return ids;
}

// Actualiza estado de la OC según kg recibidos vs estimados.
function actualizarEstadoOC(db, ocId) {
  const items = db.prepare('SELECT id, kg_estimados FROM sg_oc_items WHERE oc_id=?').all(ocId);
  if (!items.length) return;
  let completos = 0;
  for (const it of items) {
    const recibido = db.prepare('SELECT COALESCE(SUM(kg_reales),0) s FROM sg_lotes WHERE oc_item_id=? AND activo=1').get(it.id).s;
    if (recibido >= (it.kg_estimados || 0) - 0.01) completos++;
  }
  const estado = completos === 0 ? 'abierta' : (completos === items.length ? 'recibida_total' : 'recibida_parcial');
  db.prepare("UPDATE sg_oc SET estado=?, modificado_en=datetime('now','localtime') WHERE id=?").run(estado, ocId);
}

// ── ÓRDENES DE COMPRA ────────────────────────────────────────────────────────

// Crear OC (cabecera + items) en transacción. "Cerrar OC" en el modal = este POST.
router.post('/oc', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: 'La OC necesita al menos un item' });
    const tipoPrecio = b.tipo_precio === 'pizarra' ? 'pizarra' : 'firme';
    const dft = defaultsProveedor(db, b.proveedor_id, b);

    const tx = db.transaction(() => {
      const numero = nextNumero(db, 'SG-OC', 'sg_oc', 'numero');
      const ocInfo = db.prepare(`INSERT INTO sg_oc
        (numero, modalidad, proveedor_id, tipo_fiscal, tipo_precio, condicion_pago_id, fecha_oc,
         fecha_recepcion_estimada, comercial_id, estado, observaciones, total_estimado_kg, total_estimado_monto, creado_por)
        VALUES (?,?,?,?,?,?,?,?,?, 'abierta', ?, 0, 0, ?)`).run(
        numero, val(b.modalidad) || 'normal', b.proveedor_id || null, dft.tipo_fiscal, tipoPrecio,
        dft.condicion_pago_id, val(b.fecha_oc), val(b.fecha_recepcion_estimada), b.comercial_id || null,
        val(b.observaciones), uid(req));
      const ocId = ocInfo.lastInsertRowid;

      const insItem = db.prepare(`INSERT INTO sg_oc_items
        (oc_id, producto_id, presentacion_id, cantidad_estimada_presentaciones, kg_estimados, precio_estimado_por_kg, observaciones_item)
        VALUES (?,?,?,?,?,?,?)`);
      let totKg = 0, totMonto = 0;
      for (const it of items) {
        const pres = it.presentacion_id ? db.prepare('SELECT factor_conversion FROM sg_presentaciones WHERE id=?').get(it.presentacion_id) : null;
        const factor = pres ? Number(pres.factor_conversion) : 1;
        const cant = Number(it.cantidad_estimada_presentaciones || 0);
        const kg = it.kg_estimados != null ? Number(it.kg_estimados) : cant * factor;
        const precio = tipoPrecio === 'pizarra' ? null : (it.precio_estimado_por_kg != null ? Number(it.precio_estimado_por_kg) : null);
        insItem.run(ocId, it.producto_id, it.presentacion_id || null, cant, kg, precio, val(it.observaciones_item));
        totKg += kg;
        if (precio != null) totMonto += kg * precio;
      }
      db.prepare('UPDATE sg_oc SET total_estimado_kg=?, total_estimado_monto=? WHERE id=?').run(totKg, totMonto, ocId);
      if (tipoPrecio === 'firme') generarVencimientos(db, ocId);
      return ocId;
    });
    const ocId = tx();
    res.json({ ok: true, data: { id: Number(ocId) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Listar OC con filtros
router.get('/oc', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['o.activo=1'], params = [];
    if (req.query.estado) { where.push('o.estado=?'); params.push(req.query.estado); }
    if (req.query.proveedor_id) { where.push('o.proveedor_id=?'); params.push(req.query.proveedor_id); }
    if (req.query.modalidad) { where.push('o.modalidad=?'); params.push(req.query.modalidad); }
    if (req.query.desde) { where.push('o.fecha_oc>=?'); params.push(req.query.desde); }
    if (req.query.hasta) { where.push('o.fecha_oc<=?'); params.push(req.query.hasta); }
    const rows = db.prepare(`
      SELECT o.*, p.razon_social AS proveedor_nombre
      FROM sg_oc o LEFT JOIN sg_proveedores p ON p.id=o.proveedor_id
      WHERE ${where.join(' AND ')} ORDER BY o.id DESC`).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Detalle OC (cabecera + items + vencimientos)
router.get('/oc/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const oc = db.prepare(`SELECT o.*, p.razon_social AS proveedor_nombre FROM sg_oc o
      LEFT JOIN sg_proveedores p ON p.id=o.proveedor_id WHERE o.id=?`).get(req.params.id);
    if (!oc) return res.status(404).json({ ok: false, error: 'No encontrado' });
    oc.items = db.prepare(`SELECT i.*, pr.nombre AS producto_nombre, ps.nombre AS presentacion_nombre,
      (SELECT COALESCE(SUM(kg_reales),0) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS kg_recibidos
      FROM sg_oc_items i
      LEFT JOIN sg_productos pr ON pr.id=i.producto_id
      LEFT JOIN sg_presentaciones ps ON ps.id=i.presentacion_id
      WHERE i.oc_id=?`).all(req.params.id);
    oc.vencimientos = db.prepare('SELECT * FROM sg_oc_vencimientos WHERE oc_id=? ORDER BY cuota_orden').all(req.params.id);
    res.json({ ok: true, data: oc });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Editar cabecera de OC (solo borrador/abierta) + regenerar vencimientos
router.put('/oc/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const oc = db.prepare('SELECT estado FROM sg_oc WHERE id=?').get(req.params.id);
    if (!oc) return res.status(404).json({ ok: false, error: 'No encontrado' });
    if (!['borrador', 'abierta'].includes(oc.estado)) return res.status(400).json({ ok: false, error: 'Solo se edita una OC en borrador/abierta' });
    const campos = ['tipo_fiscal', 'condicion_pago_id', 'fecha_oc', 'fecha_recepcion_estimada', 'comercial_id', 'observaciones'];
    const sets = [], vals = [];
    for (const c of campos) if (req.body[c] !== undefined) { sets.push(`${c}=?`); vals.push(val(req.body[c])); }
    if (sets.length) {
      sets.push(`modificado_en=datetime('now','localtime')`, 'modificado_por=?'); vals.push(uid(req), req.params.id);
      db.prepare(`UPDATE sg_oc SET ${sets.join(',')} WHERE id=?`).run(...vals);
      generarVencimientos(db, Number(req.params.id));
    }
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Anular OC (solo si no tiene recepciones)
router.post('/oc/:id/anular', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const tieneRec = db.prepare('SELECT COUNT(*) c FROM sg_recepciones WHERE oc_id=? AND activo=1').get(req.params.id).c;
    if (tieneRec > 0) return res.status(400).json({ ok: false, error: 'La OC ya tiene recepciones; no se puede anular' });
    db.prepare("UPDATE sg_oc SET estado='anulada', modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?").run(uid(req), req.params.id);
    db.prepare('DELETE FROM sg_oc_vencimientos WHERE oc_id=? AND pagado=0').run(req.params.id);
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── RECEPCIONES ──────────────────────────────────────────────────────────────

// Recibir mercadería: crea recepción + lotes (con división por calidad), recalcula costos y vencimientos.
router.post('/recepciones', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    const oc = db.prepare('SELECT * FROM sg_oc WHERE id=? AND activo=1').get(b.oc_id);
    if (!oc) return res.status(400).json({ ok: false, error: 'OC inexistente' });
    if (oc.estado === 'anulada') return res.status(400).json({ ok: false, error: 'OC anulada' });
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: 'Sin items para recibir' });

    // Validación: suma de kg de los lotes = kg_reales del item (si se informó kg_reales_item)
    for (const it of items) {
      const lotes = Array.isArray(it.lotes) ? it.lotes : [];
      if (!lotes.length) return res.status(400).json({ ok: false, error: 'Cada item debe tener al menos un lote' });
      if (it.kg_reales_item != null) {
        const suma = lotes.reduce((a, l) => a + Number(l.kg_reales || 0), 0);
        if (Math.abs(suma - Number(it.kg_reales_item)) > 0.01) {
          return res.status(400).json({ ok: false, error: `Los lotes (${suma}kg) no coinciden con el total del item (${it.kg_reales_item}kg)` });
        }
      }
    }
    const fechaIngreso = val(b.fecha_recepcion) || db.prepare("SELECT date('now','localtime') d").get().d;

    const tx = db.transaction(() => {
      const numero = nextNumero(db, 'SG-REC', 'sg_recepciones', 'numero_recepcion');
      const recInfo = db.prepare(`INSERT INTO sg_recepciones
        (oc_id, numero_recepcion, fecha_recepcion, recibido_por, numero_remito_proveedor, observaciones, creado_por)
        VALUES (?,?,?,?,?,?,?)`).run(
        b.oc_id, numero, fechaIngreso, b.recibido_por || null, val(b.numero_remito_proveedor), val(b.observaciones), uid(req));
      const recId = recInfo.lastInsertRowid;
      const nuevosLotes = [];
      for (const it of items) {
        const ocItem = db.prepare('SELECT * FROM sg_oc_items WHERE id=? AND oc_id=?').get(it.oc_item_id, b.oc_id);
        if (!ocItem) throw new Error('Item de OC inválido: ' + it.oc_item_id);
        const ids = crearLotesDeItem(db, { recepcionId: recId, ocItem, tipoPrecio: oc.tipo_precio, fechaIngreso, lotes: it.lotes, userId: uid(req) });
        nuevosLotes.push(...ids);
      }
      actualizarEstadoOC(db, b.oc_id);
      recalcPeriodo(db, fechaIngreso.slice(0, 7));
      generarVencimientos(db, Number(b.oc_id));
      return { recId, nuevosLotes };
    });
    const out = tx();
    res.json({ ok: true, data: { id: Number(out.recId), lotes: out.nuevosLotes.length } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.get('/recepciones', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['r.activo=1'], params = [];
    if (req.query.oc_id) { where.push('r.oc_id=?'); params.push(req.query.oc_id); }
    const rows = db.prepare(`
      SELECT r.*, o.numero AS oc_numero, p.razon_social AS proveedor_nombre,
        (SELECT COUNT(*) FROM sg_lotes WHERE recepcion_id=r.id AND activo=1) AS lotes
      FROM sg_recepciones r
      LEFT JOIN sg_oc o ON o.id=r.oc_id
      LEFT JOIN sg_proveedores p ON p.id=o.proveedor_id
      WHERE ${where.join(' AND ')} ORDER BY r.id DESC`).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/recepciones/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rec = db.prepare(`SELECT r.*, o.numero AS oc_numero FROM sg_recepciones r LEFT JOIN sg_oc o ON o.id=r.oc_id WHERE r.id=?`).get(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'No encontrado' });
    rec.lotes = db.prepare(`SELECT l.*, pr.nombre AS producto_nombre FROM sg_lotes l
      LEFT JOIN sg_productos pr ON pr.id=l.producto_id WHERE l.recepcion_id=? AND l.activo=1`).all(req.params.id);
    res.json({ ok: true, data: rec });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── COMPRA RETROACTIVA (OC + recepción + lotes en una transacción) ─────────────
router.post('/compra-retroactiva', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: 'Sin items' });
    const tipoPrecio = b.tipo_precio === 'pizarra' ? 'pizarra' : 'firme';
    const dft = defaultsProveedor(db, b.proveedor_id, b);
    const fechaIngreso = val(b.fecha) || db.prepare("SELECT date('now','localtime') d").get().d;

    const tx = db.transaction(() => {
      const numeroOC = nextNumero(db, 'SG-OC', 'sg_oc', 'numero');
      const ocInfo = db.prepare(`INSERT INTO sg_oc
        (numero, modalidad, proveedor_id, tipo_fiscal, tipo_precio, condicion_pago_id, fecha_oc, fecha_recepcion_estimada,
         comercial_id, estado, observaciones, total_estimado_kg, total_estimado_monto, creado_por)
        VALUES (?, 'retroactiva', ?,?,?,?,?,?,?, 'recibida_total', ?, 0, 0, ?)`).run(
        numeroOC, b.proveedor_id || null, dft.tipo_fiscal, tipoPrecio, dft.condicion_pago_id,
        fechaIngreso, fechaIngreso, b.comercial_id || null, val(b.observaciones), uid(req));
      const ocId = ocInfo.lastInsertRowid;

      const numeroRec = nextNumero(db, 'SG-REC', 'sg_recepciones', 'numero_recepcion');
      const recInfo = db.prepare(`INSERT INTO sg_recepciones
        (oc_id, numero_recepcion, fecha_recepcion, recibido_por, numero_remito_proveedor, observaciones, creado_por)
        VALUES (?,?,?,?,?,?,?)`).run(
        ocId, numeroRec, fechaIngreso, b.recibido_por || null, val(b.numero_remito_proveedor), val(b.observaciones), uid(req));
      const recId = recInfo.lastInsertRowid;

      const insItem = db.prepare(`INSERT INTO sg_oc_items
        (oc_id, producto_id, presentacion_id, cantidad_estimada_presentaciones, kg_estimados, precio_estimado_por_kg, observaciones_item)
        VALUES (?,?,?,?,?,?,?)`);
      let totKg = 0, totMonto = 0;
      for (const it of items) {
        const lotes = Array.isArray(it.lotes) ? it.lotes : [];
        const kgItem = lotes.reduce((a, l) => a + Number(l.kg_reales || 0), 0);
        const precio = tipoPrecio === 'pizarra' ? null : (it.precio_por_kg != null ? Number(it.precio_por_kg) : null);
        const itInfo = insItem.run(ocId, it.producto_id, it.presentacion_id || null, lotes.length, kgItem, precio, val(it.observaciones_item));
        const ocItem = { id: itInfo.lastInsertRowid, producto_id: it.producto_id, precio_estimado_por_kg: precio };
        crearLotesDeItem(db, { recepcionId: recId, ocItem, tipoPrecio, fechaIngreso, lotes, userId: uid(req) });
        totKg += kgItem;
        if (precio != null) totMonto += kgItem * precio;
      }
      db.prepare('UPDATE sg_oc SET total_estimado_kg=?, total_estimado_monto=? WHERE id=?').run(totKg, totMonto, ocId);
      recalcPeriodo(db, fechaIngreso.slice(0, 7));
      generarVencimientos(db, ocId);
      return { ocId, recId };
    });
    const out = tx();
    res.json({ ok: true, data: { oc_id: Number(out.ocId), recepcion_id: Number(out.recId) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── LOTES (lectura mínima para F2; F3 extiende con trazabilidad + bajas) ────────
router.get('/lotes', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['l.activo=1'], params = [];
    if (req.query.estado) { where.push('l.estado=?'); params.push(req.query.estado); }
    if (req.query.producto_id) { where.push('l.producto_id=?'); params.push(req.query.producto_id); }
    if (req.query.recepcion_id) { where.push('l.recepcion_id=?'); params.push(req.query.recepcion_id); }
    if (req.query.oc_id) { where.push('l.oc_item_id IN (SELECT id FROM sg_oc_items WHERE oc_id=?)'); params.push(req.query.oc_id); }
    if (req.query.sin_precio === '1') where.push('l.precio_unitario_kg IS NULL');
    const rows = db.prepare(`
      SELECT l.*, pr.nombre AS producto_nombre,
        CAST(julianday(l.fecha_vencimiento_estimada) - julianday(date('now','localtime')) AS INTEGER) AS dias_restantes
      FROM sg_lotes l LEFT JOIN sg_productos pr ON pr.id=l.producto_id
      WHERE ${where.join(' AND ')} ORDER BY l.fecha_vencimiento_estimada ASC, l.id DESC`).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Cerrar precio de un lote pizarra → setea precio, recalcula costos y genera vencimientos.
router.post('/lotes/:id/cerrar-precio', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const precio = Number(req.body.precio_unitario_kg);
    if (!(precio > 0)) return res.status(400).json({ ok: false, error: 'Precio inválido' });
    const lote = db.prepare('SELECT * FROM sg_lotes WHERE id=? AND activo=1').get(req.params.id);
    if (!lote) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    const tx = db.transaction(() => {
      const costoBase = (lote.kg_reales || 0) * precio;
      db.prepare("UPDATE sg_lotes SET precio_unitario_kg=?, costo_base=?, modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?")
        .run(precio, costoBase, uid(req), req.params.id);
      recalcCostoLote(db, Number(req.params.id));
      // OC del lote (vía oc_item) → regenerar vencimientos si ya están todos los precios
      const ocRow = db.prepare('SELECT i.oc_id FROM sg_oc_items i WHERE i.id=?').get(lote.oc_item_id);
      if (ocRow && ocRow.oc_id) generarVencimientos(db, ocRow.oc_id);
    });
    tx();
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── GASTOS DIRECTOS POR LOTE ───────────────────────────────────────────────────
router.get('/gastos-directos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['g.activo=1'], params = [];
    if (req.query.lote_id) { where.push('g.lote_id=?'); params.push(req.query.lote_id); }
    const rows = db.prepare(`SELECT g.*, l.codigo_lote, pv.razon_social AS proveedor_gasto_nombre
      FROM sg_gastos_directos_lote g
      LEFT JOIN sg_lotes l ON l.id=g.lote_id
      LEFT JOIN sg_proveedores pv ON pv.id=g.proveedor_id_gasto
      WHERE ${where.join(' AND ')} ORDER BY g.id DESC`).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/gastos-directos', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    if (!b.lote_id) return res.status(400).json({ ok: false, error: 'Falta lote_id' });
    const info = db.prepare(`INSERT INTO sg_gastos_directos_lote
      (lote_id, tipo_gasto, proveedor_id_gasto, monto, fecha, observaciones, creado_por)
      VALUES (?,?,?,?,?,?,?)`).run(
      b.lote_id, val(b.tipo_gasto), b.proveedor_id_gasto || null, Number(b.monto || 0), val(b.fecha), val(b.observaciones), uid(req));
    recalcCostoLote(db, Number(b.lote_id));
    res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.put('/gastos-directos/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const g = db.prepare('SELECT lote_id FROM sg_gastos_directos_lote WHERE id=?').get(req.params.id);
    if (!g) return res.status(404).json({ ok: false, error: 'No encontrado' });
    const campos = ['tipo_gasto', 'proveedor_id_gasto', 'monto', 'fecha', 'observaciones'];
    const sets = [], vals = [];
    for (const c of campos) if (req.body[c] !== undefined) { sets.push(`${c}=?`); vals.push(c === 'monto' ? Number(req.body[c] || 0) : val(req.body[c])); }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'Sin cambios' });
    sets.push(`modificado_en=datetime('now','localtime')`, 'modificado_por=?'); vals.push(uid(req), req.params.id);
    db.prepare(`UPDATE sg_gastos_directos_lote SET ${sets.join(',')} WHERE id=?`).run(...vals);
    recalcCostoLote(db, g.lote_id);
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.delete('/gastos-directos/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const g = db.prepare('SELECT lote_id FROM sg_gastos_directos_lote WHERE id=? AND activo=1').get(req.params.id);
    if (!g) return res.status(404).json({ ok: false, error: 'No encontrado o ya eliminado' });
    db.prepare("UPDATE sg_gastos_directos_lote SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=? WHERE id=?").run(uid(req), req.params.id);
    recalcCostoLote(db, g.lote_id);
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── GASTOS GLOBALES DEL PERÍODO ────────────────────────────────────────────────
router.get('/gastos-globales', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['activo=1'], params = [];
    if (req.query.periodo) { where.push('periodo=?'); params.push(req.query.periodo); }
    const rows = db.prepare(`SELECT * FROM sg_gastos_globales_periodo WHERE ${where.join(' AND ')} ORDER BY periodo DESC, id DESC`).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/gastos-globales', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    if (!val(b.periodo)) return res.status(400).json({ ok: false, error: 'Falta período (YYYY-MM)' });
    const info = db.prepare(`INSERT INTO sg_gastos_globales_periodo
      (periodo, tipo_gasto, monto, fecha, observaciones, creado_por) VALUES (?,?,?,?,?,?)`).run(
      val(b.periodo), val(b.tipo_gasto), Number(b.monto || 0), val(b.fecha), val(b.observaciones), uid(req));
    recalcPeriodo(db, val(b.periodo));
    res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.put('/gastos-globales/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const g = db.prepare('SELECT periodo FROM sg_gastos_globales_periodo WHERE id=?').get(req.params.id);
    if (!g) return res.status(404).json({ ok: false, error: 'No encontrado' });
    const campos = ['periodo', 'tipo_gasto', 'monto', 'fecha', 'observaciones'];
    const sets = [], vals = [];
    for (const c of campos) if (req.body[c] !== undefined) { sets.push(`${c}=?`); vals.push(c === 'monto' ? Number(req.body[c] || 0) : val(req.body[c])); }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'Sin cambios' });
    sets.push(`modificado_en=datetime('now','localtime')`, 'modificado_por=?'); vals.push(uid(req), req.params.id);
    db.prepare(`UPDATE sg_gastos_globales_periodo SET ${sets.join(',')} WHERE id=?`).run(...vals);
    recalcPeriodo(db, g.periodo);
    if (req.body.periodo && req.body.periodo !== g.periodo) recalcPeriodo(db, val(req.body.periodo));
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.delete('/gastos-globales/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const g = db.prepare('SELECT periodo FROM sg_gastos_globales_periodo WHERE id=? AND activo=1').get(req.params.id);
    if (!g) return res.status(404).json({ ok: false, error: 'No encontrado o ya eliminado' });
    db.prepare("UPDATE sg_gastos_globales_periodo SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=? WHERE id=?").run(uid(req), req.params.id);
    recalcPeriodo(db, g.periodo);
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

export default router;
