// src/rutas/sg.js
// ── API SAN GERÓNIMO — PUENTE CORDON SA ───────────────────────────────────────
// Operatoria mayorista frutihortícola. Universo sg_* independiente.
// Fase 1: catálogo (productos, presentaciones, proveedores, clientes,
// condiciones de pago + cuotas). Compras/Stock/Ventas/Reportes en fases siguientes.

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getDb } from '../servicios/db.js';
import '../servicios/db_sg.js'; // corre el DDL sg_* al importarse
import { detectarDuplicado } from '../servicios/dedup.js';
import { generarOcPDF } from '../servicios/ocPDF.js';
import { generarRecepcionCalidadPDF } from '../servicios/recepcionCalidadPDF.js';

const router = express.Router();

// ── BLOQUE B — almacenamiento de fotos del informe de calidad (REUSA patrón IFCO:
// archivo físico en data/sg/, en DB solo la ruta; servido estático en index.js). ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SG_UPLOAD_DIR = path.join(__dirname, '../../data/sg');
fs.mkdirSync(SG_UPLOAD_DIR, { recursive: true });
const sgStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SG_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase();
    // único aún con varias fotos en el mismo request (timestamp + random)
    cb(null, 'calidad_' + (req.params.id || 'x') + '_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + ext);
  }
});
const sgUpload = multer({ storage: sgStorage, limits: { fileSize: 10 * 1024 * 1024 } });
// Vista previa PDF: las fotos NO se persisten (van a memoria) → sin archivos huérfanos.
const sgUploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
  // dedup: nombre de columna a chequear contra duplicados al crear (null = sin chequeo).
  // selectExtra: expresiones SELECT extra (display) para el listado, ej. nombre de una FK.
  const { orderBy = 'id DESC', listExtra = null, dedup = null, selectExtra = null } = opts;

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
      const sel = selectExtra ? `*, ${selectExtra}` : '*';
      const rows = db.prepare(`SELECT ${sel} FROM ${tabla} WHERE ${where} ORDER BY ${orderBy}`).all(...params);
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
  router.post(`/${path}`, requireAdmin, async (req, res) => {
    const db = getDb();
    try {
      // Detección de duplicados con bloqueo. Válvula de escape: un admin puede forzar
      // con { forzar:true } (confirmación explícita en el front). Sin forzar, si hay
      // un parecido por encima del umbral → 409 con el candidato existente.
      if (dedup && !(req.body.forzar === true && req.user && req.user.rol === 'admin')) {
        const hit = await detectarDuplicado(db, { tabla, columna: dedup, nombre: req.body[dedup] });
        if (hit.bloqueado) {
          return res.status(409).json({
            ok: false, duplicado: true, motivo: hit.motivo, candidato: hit.candidato, score: hit.score,
            error: `Ya existe un ítem muy parecido: "${hit.candidato.nombre}". Usá ese en lugar de crear uno nuevo.`,
          });
        }
      }
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

// ── TAXONOMÍA DE PRODUCTOS: Familia → Especie → Variedad ──────────────────────
// Código jerárquico FF.EE.VV. Cada nivel tiene un 'codigo' INTEGER de 2 díg,
// correlativo dentro de su padre (patrón plan de cuentas: max(codigo)+1 con loop
// anti-colisión contra el UNIQUE). El código del producto se arma desde los 3.
const pad2 = (n) => String(n).padStart(2, '0');

// Próximo correlativo libre dentro del padre (whereSql = '' para familias).
function nextCodigoNivel(db, tabla, whereSql, params) {
  const row = db.prepare(`SELECT MAX(codigo) AS m FROM ${tabla}${whereSql ? ' WHERE ' + whereSql : ''}`).get(...params);
  return (row && row.m ? Number(row.m) : 0) + 1;
}

// INSERT con autonumeración correlativa + loop anti-colisión contra el UNIQUE.
// cols/vals NO incluyen 'codigo' ni 'creado_por' (los agrega el helper).
function insertConCodigo(db, req, res, tabla, codigoInicial, whereSql, whereParams, cols, vals) {
  let n = codigoInicial;
  for (let intento = 0; intento < 200; intento++) {
    try {
      const allCols = ['codigo', ...cols, 'creado_por'];
      const allVals = [n, ...vals, uid(req)];
      const info = db.prepare(
        `INSERT INTO ${tabla} (${allCols.join(',')}) VALUES (${allCols.map(() => '?').join(',')})`
      ).run(...allVals);
      const row = db.prepare(`SELECT * FROM ${tabla} WHERE id=?`).get(info.lastInsertRowid);
      return res.json({ ok: true, data: row });
    } catch (e) {
      if (String(e.message).includes('UNIQUE') && intento < 199) { n++; continue; }
      return res.status(400).json({ ok: false, error: e.message });
    }
  }
}

// ── Familias ──
router.get('/familias', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = req.query.todos === '1' ? '1=1' : 'activo=1';
    res.json({ ok: true, data: db.prepare(`SELECT * FROM sg_familias WHERE ${where} ORDER BY codigo`).all() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/familias', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const nombre = val(req.body.nombre);
    if (!nombre) return res.status(400).json({ ok: false, error: 'Falta nombre' });
    const n = nextCodigoNivel(db, 'sg_familias', '', []);
    insertConCodigo(db, req, res, 'sg_familias', n, '', [], ['nombre'], [nombre]);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// IVA Fase 2 — editar familia (nombre y/o alícuota de IVA). La alícuota la hereda el
// producto vía familia_id; acá es donde se ve/configura. iva_alicuota: REAL en % (ej. 10.5)
// o null para "sin definir" (se resolverá en recepción/liquidación).
router.patch('/familias/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const fam = db.prepare('SELECT id FROM sg_familias WHERE id=? AND activo=1').get(req.params.id);
    if (!fam) return res.status(404).json({ ok: false, error: 'Familia no encontrada' });
    const sets = [], vals = [];
    if (req.body.nombre !== undefined) {
      const nombre = val(req.body.nombre);
      if (!nombre) return res.status(400).json({ ok: false, error: 'Nombre vacío' });
      sets.push('nombre=?'); vals.push(nombre);
    }
    if (req.body.iva_alicuota !== undefined) {
      const a = req.body.iva_alicuota;
      const alic = (a === null || a === '') ? null : Number(a);
      if (alic !== null && (isNaN(alic) || alic < 0 || alic > 100)) return res.status(400).json({ ok: false, error: 'Alícuota inválida (0–100)' });
      sets.push('iva_alicuota=?'); vals.push(alic);
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'Nada para actualizar' });
    sets.push(`modificado_en=datetime('now','localtime')`, 'modificado_por=?'); vals.push(uid(req), req.params.id);
    db.prepare(`UPDATE sg_familias SET ${sets.join(',')} WHERE id=?`).run(...vals);
    res.json({ ok: true, data: db.prepare('SELECT * FROM sg_familias WHERE id=?').get(req.params.id) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── Especies (correlativo dentro de la familia) ──
router.get('/especies', requireAuth, (req, res) => {
  const db = getDb();
  try {
    let where = req.query.todos === '1' ? '1=1' : 'activo=1';
    const params = [];
    if (req.query.familia_id) { where += ' AND familia_id=?'; params.push(req.query.familia_id); }
    res.json({ ok: true, data: db.prepare(`SELECT * FROM sg_especies WHERE ${where} ORDER BY codigo`).all(...params) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/especies', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const familia_id = req.body.familia_id, nombre = val(req.body.nombre);
    if (!familia_id) return res.status(400).json({ ok: false, error: 'Falta familia_id' });
    if (!nombre) return res.status(400).json({ ok: false, error: 'Falta nombre' });
    if (!db.prepare('SELECT id FROM sg_familias WHERE id=?').get(familia_id)) return res.status(400).json({ ok: false, error: 'familia_id inválido' });
    const n = nextCodigoNivel(db, 'sg_especies', 'familia_id=?', [familia_id]);
    insertConCodigo(db, req, res, 'sg_especies', n, '', [], ['familia_id', 'nombre'], [familia_id, nombre]);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── Variedades (correlativo dentro de la especie) ──
router.get('/variedades', requireAuth, (req, res) => {
  const db = getDb();
  try {
    let where = req.query.todos === '1' ? '1=1' : 'activo=1';
    const params = [];
    if (req.query.especie_id) { where += ' AND especie_id=?'; params.push(req.query.especie_id); }
    res.json({ ok: true, data: db.prepare(`SELECT * FROM sg_variedades WHERE ${where} ORDER BY codigo`).all(...params) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/variedades', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const especie_id = req.body.especie_id, nombre = val(req.body.nombre);
    if (!especie_id) return res.status(400).json({ ok: false, error: 'Falta especie_id' });
    if (!nombre) return res.status(400).json({ ok: false, error: 'Falta nombre' });
    if (!db.prepare('SELECT id FROM sg_especies WHERE id=?').get(especie_id)) return res.status(400).json({ ok: false, error: 'especie_id inválido' });
    const n = nextCodigoNivel(db, 'sg_variedades', 'especie_id=?', [especie_id]);
    insertConCodigo(db, req, res, 'sg_variedades', n, '', [], ['especie_id', 'nombre'], [especie_id, nombre]);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── DELETE de niveles de taxonomía (soft-delete) CON chequeo de uso obligatorio ──
// `bloqueos` = lista de { count: SQL SELECT COUNT(*) AS n ..., params, etiqueta }.
// Si algún conteo > 0 → rechaza (409) sin borrar y devuelve qué lo bloquea. Soft-delete
// con el mismo patrón que sg_productos (activo=0 + eliminado_en/eliminado_por_id). El número
// de código queda ocupado por el UNIQUE → nextCodigoNivel (MAX+1) NO lo reusa (intencional).
function borrarNivelTax(db, req, res, tabla, id, bloqueos) {
  const fila = db.prepare(`SELECT id FROM ${tabla} WHERE id=? AND activo=1`).get(id);
  if (!fila) return res.status(404).json({ ok: false, error: 'No encontrado o ya eliminado' });
  const detalle = [];
  for (const b of bloqueos) {
    const n = db.prepare(b.count).get(...(b.params || [])).n;
    if (n > 0) detalle.push(`${n} ${b.etiqueta}`);
  }
  if (detalle.length) {
    return res.status(409).json({ ok: false, bloqueado: true, detalle,
      error: 'No se puede borrar: ' + detalle.join(' y ') + '. Reasignalos primero.' });
  }
  db.prepare(`UPDATE ${tabla} SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=? WHERE id=? AND activo=1`)
    .run(uid(req), id);
  res.json({ ok: true, data: { id: Number(id) } });
}

router.delete('/variedades/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    borrarNivelTax(db, req, res, 'sg_variedades', req.params.id, [
      { count: 'SELECT COUNT(*) AS n FROM sg_productos WHERE variedad_id=? AND activo=1', params: [req.params.id], etiqueta: 'producto(s) la usan' }
    ]);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.delete('/especies/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    borrarNivelTax(db, req, res, 'sg_especies', req.params.id, [
      { count: 'SELECT COUNT(*) AS n FROM sg_variedades WHERE especie_id=? AND activo=1', params: [req.params.id], etiqueta: 'variedad(es) hija(s) activa(s)' },
      { count: 'SELECT COUNT(*) AS n FROM sg_productos WHERE especie_id=? AND activo=1',  params: [req.params.id], etiqueta: 'producto(s) la usan' }
    ]);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.delete('/familias/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    borrarNivelTax(db, req, res, 'sg_familias', req.params.id, [
      { count: 'SELECT COUNT(*) AS n FROM sg_especies  WHERE familia_id=? AND activo=1', params: [req.params.id], etiqueta: 'especie(s) hija(s) activa(s)' },
      { count: 'SELECT COUNT(*) AS n FROM sg_productos WHERE familia_id=? AND activo=1', params: [req.params.id], etiqueta: 'producto(s) la usan' }
    ]);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── PRODUCTOS (código autogenerado FF.EE.VV desde la taxonomía) ───────────────
// Resuelve la taxonomía, valida la jerarquía, arma el código y DENORMALIZA
// familia/nombre/variedad (los consumen Compras/Lotes/Pedidos/Despachos/Reportes
// por producto_id). El código queda fijado por (familia, especie, variedad): un
// duplicado de esa terna choca con el UNIQUE → error claro (no auto-incrementa).
function resolverProducto(db, body) {
  const familia = db.prepare('SELECT * FROM sg_familias WHERE id=?').get(body.familia_id);
  if (!familia) return { error: 'Elegí una familia' };
  const especie = db.prepare('SELECT * FROM sg_especies WHERE id=?').get(body.especie_id);
  if (!especie) return { error: 'Elegí una especie' };
  if (Number(especie.familia_id) !== Number(familia.id)) return { error: 'La especie no pertenece a la familia elegida' };
  let variedad = null;
  if (body.variedad_id) {
    variedad = db.prepare('SELECT * FROM sg_variedades WHERE id=?').get(body.variedad_id);
    if (!variedad) return { error: 'Variedad inválida' };
    if (Number(variedad.especie_id) !== Number(especie.id)) return { error: 'La variedad no pertenece a la especie elegida' };
  }
  return {
    codigo: `${pad2(familia.codigo)}.${pad2(especie.codigo)}.${variedad ? pad2(variedad.codigo) : '00'}`,
    familia_id: familia.id, especie_id: especie.id, variedad_id: variedad ? variedad.id : null,
    nombre: especie.nombre, variedad: variedad ? variedad.nombre : null, familia: familia.nombre
  };
}

router.get('/productos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = req.query.todos === '1' ? '1=1' : 'activo=1';
    res.json({ ok: true, data: db.prepare(`SELECT * FROM sg_productos WHERE ${where} ORDER BY codigo`).all() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/productos/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const row = db.prepare('SELECT * FROM sg_productos WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'No encontrado' });
    res.json({ ok: true, data: row });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/productos', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const r = resolverProducto(db, req.body || {});
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    try {
      const info = db.prepare(`INSERT INTO sg_productos
        (codigo, familia_id, especie_id, variedad_id, nombre, variedad, familia, creado_por)
        VALUES (?,?,?,?,?,?,?,?)`).run(r.codigo, r.familia_id, r.especie_id, r.variedad_id, r.nombre, r.variedad, r.familia, uid(req));
      res.json({ ok: true, data: db.prepare('SELECT * FROM sg_productos WHERE id=?').get(info.lastInsertRowid) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(400).json({ ok: false, error: `Ya existe un producto con código ${r.codigo} (misma familia/especie/variedad)` });
      throw e;
    }
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
router.put('/productos/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const r = resolverProducto(db, req.body || {});
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    try {
      const info = db.prepare(`UPDATE sg_productos SET
        codigo=?, familia_id=?, especie_id=?, variedad_id=?, nombre=?, variedad=?, familia=?,
        modificado_en=datetime('now','localtime'), modificado_por=?
        WHERE id=?`).run(r.codigo, r.familia_id, r.especie_id, r.variedad_id, r.nombre, r.variedad, r.familia, uid(req), req.params.id);
      if (!info.changes) return res.status(404).json({ ok: false, error: 'No encontrado' });
      res.json({ ok: true, data: db.prepare('SELECT * FROM sg_productos WHERE id=?').get(req.params.id) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(400).json({ ok: false, error: `Ya existe un producto con código ${r.codigo} (misma familia/especie/variedad)` });
      throw e;
    }
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
router.delete('/productos/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const info = db.prepare(`UPDATE sg_productos SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=? WHERE id=? AND activo=1`).run(uid(req), req.params.id);
    if (!info.changes) return res.status(404).json({ ok: false, error: 'No encontrado o ya eliminado' });
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── ENVASES (catálogo editable: cajón, bolsa, bin, IFCO…) ─────────────────────────
// CRUD completo vía helper (GET/POST/PUT/DELETE). El dropdown de presentaciones lo
// lee por GET; el alta al vuelo usa POST. nombre es UNIQUE → duplicado da 400.
montarCRUD('envases', 'sg_envases', ['nombre'], { orderBy: 'nombre COLLATE NOCASE', dedup: 'nombre' });

// ── PRESENTACIONES (filtra por producto_id) ──────────────────────────────────────
// envase_id/paletizado son aditivos; factor_conversion (cálculo de kg) no se toca.
montarCRUD('presentaciones', 'sg_presentaciones',
  ['producto_id', 'nombre', 'factor_conversion', 'envase_id', 'paletizado'],
  {
    orderBy: 'nombre COLLATE NOCASE',
    listExtra: (req, params) => {
      if (req.query.producto_id) { params.push(req.query.producto_id); return 'producto_id=?'; }
      return null;
    }
  });

// ── PROVEEDORES ──────────────────────────────────────────────────────────────────
montarCRUD('proveedores', 'sg_proveedores',
  ['razon_social', 'nombre_comercial', 'origen', 'cuit', 'tipo', 'categoria_fiscal', 'tipo_fiscal_habitual',
   'condicion_pago_habitual_id', 'cbu', 'alias_cbu', 'comercial_responsable_id', 'localidad', 'provincia',
   'telefono', 'email', 'observaciones', 'adm_proveedor_id', 'es_servicio'],   // es_servicio: 1 = fletero/cooperativa
  { orderBy: 'razon_social COLLATE NOCASE' });

// Fleteros / proveedores de servicio (es_servicio=1). Alimenta el selector del despacho y
// el filtro del módulo Gastos Directos.
router.get('/proveedores-servicio', requireAuth, (req, res) => {
  const db = getDb();
  try {
    res.json({ ok: true, data: db.prepare("SELECT * FROM sg_proveedores WHERE activo=1 AND es_servicio=1 ORDER BY razon_social COLLATE NOCASE").all() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── CLIENTES ──────────────────────────────────────────────────────────────────
montarCRUD('clientes', 'sg_clientes',
  ['razon_social', 'cuit', 'tipo', 'categoria_fiscal', 'tipo_fiscal_habitual',
   'condicion_pago_habitual_id', 'comercial_responsable_id', 'modalidad_pedido',
   'limite_credito', 'localidad', 'provincia', 'direccion_entrega', 'telefono',
   'email', 'observaciones'],
  { orderBy: 'razon_social COLLATE NOCASE',
    // nombre de la categoría comercial (categoria_id → sg_cliente_categorias) para la grilla
    selectExtra: '(SELECT nombre FROM sg_cliente_categorias WHERE id = sg_clientes.categoria_id) AS categoria_nombre' });

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
  const lote = db.prepare('SELECT id, kg_reales, costo_base, fecha_ingreso, precio_unitario_kg, recepcion_id, transformado_de FROM sg_lotes WHERE id=?').get(loteId);
  if (!lote) return 0;
  // LOTE TRANSFORMADO (caso 2): su costo viene CARGADO (snapshot del costo/kg del origen,
  // guardado en costo_base). NO corre prorrateo (no es compra → excluido del pool) ni descarga
  // (la absorbió el lote-origen). costo_final = costo_base cargado + sus propios gastos directos.
  if (lote.transformado_de != null) {
    const gdT = db.prepare('SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_directos_lote WHERE lote_id=? AND activo=1').get(loteId).s;
    // resta lo que ESTE lote transfirió a su vez (ej. reversión cubeta→lote nuevo) → su costo/kg
    // queda estable al re-consolidar. (mismo descuento que el path de compra, decisión 3.)
    const cfT = (lote.costo_base || 0) + gdT - costoTransferido(db, loteId);
    db.prepare("UPDATE sg_lotes SET costo_final=?, modificado_en=datetime('now','localtime') WHERE id=?").run(cfT, loteId);
    return cfT;
  }
  // COSTO PENDIENTE: lote sin precio (recepción sin OC, o pizarra sin cerrar) → costo_final=0 y
  // NO se le suma prorrateo (sería un costo parcial engañoso que ensucia la rentabilidad).
  // Se completa cuando se vincula la OC / se cierra el precio (ahí vuelve a correr este recalc).
  if (lote.precio_unitario_kg == null) {
    db.prepare("UPDATE sg_lotes SET costo_final=0, modificado_en=datetime('now','localtime') WHERE id=?").run(loteId);
    return 0;
  }
  const gd = db.prepare('SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_directos_lote WHERE lote_id=? AND activo=1').get(loteId).s;
  let prorrateo = 0;
  const periodo = (lote.fecha_ingreso || '').slice(0, 7);
  if (periodo) {
    const totalGlob = db.prepare('SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_globales_periodo WHERE periodo=? AND activo=1').get(periodo).s;
    // Pool de prorrateo: solo lotes de COMPRA (transformado_de IS NULL). Los transformados ya
    // computaron sus kg vía el lote-origen → incluirlos duplicaría kg y diluiría el prorrateo.
    const totalKg = db.prepare("SELECT COALESCE(SUM(kg_reales),0) s FROM sg_lotes WHERE activo=1 AND transformado_de IS NULL AND substr(fecha_ingreso,1,7)=?").get(periodo).s;
    if (totalKg > 0) prorrateo = totalGlob * (lote.kg_reales / totalKg);
  }
  // FASE 2 — descarga de ingreso (cooperativa) VALORIZADA de la recepción del lote, prorrateada
  // por kg entre los lotes de esa recepción (es costo de ingreso, igual que el flete de ingreso).
  let descarga = 0;
  if (lote.recepcion_id) {
    const dt = db.prepare("SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_directos WHERE recepcion_id=? AND tipo_gasto='descarga_ingreso' AND estado='valorizado' AND activo=1").get(lote.recepcion_id).s;
    if (dt > 0) {
      const totKgRec = db.prepare("SELECT COALESCE(SUM(kg_reales),0) s FROM sg_lotes WHERE recepcion_id=? AND activo=1").get(lote.recepcion_id).s;
      if (totKgRec > 0) descarga = dt * (lote.kg_reales / totKgRec);
    }
  }
  // Caso 2 (decisión 3/opción B): el costo que SALIÓ por transformaciones se descuenta del
  // origen, así inventario (origen remanente + lotes-cubeta) suma el total sin doble conteo.
  const transferido = costoTransferido(db, loteId);
  const costoFinal = (lote.costo_base || 0) + gd + prorrateo + descarga - transferido;
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
// #reproceso item 3: si la recepción está observada (observada=1), el lote nace en 'amarillo'
// con origen='observado' y se registra en el historial. Solo suma el seteo del semáforo; no
// toca kg/costo/estado. _rec = fila de sg_recepciones con observada/calidad. No-op si no observada.
function _aplicarObservado(db, loteId, _rec, userId) {
  if (!_rec || !_rec.observada) return;
  const partes = ['Recepción observada'];
  if (_rec.calidad_pct_afectado != null && _rec.calidad_pct_afectado !== '') partes.push(_rec.calidad_pct_afectado + '% afectado');
  if (_rec.calidad_observaciones) partes.push(String(_rec.calidad_observaciones));
  db.prepare("UPDATE sg_lotes SET semaforo='amarillo', modificado_en=datetime('now','localtime') WHERE id=?").run(loteId);
  db.prepare(`INSERT INTO sg_lote_semaforo_historial (lote_id, color_anterior, color_nuevo, motivo, origen, usuario_id)
    VALUES (?, 'verde', 'amarillo', ?, 'observado', ?)`).run(loteId, partes.join(' · '), userId || null);
}
function _recObservada(db, recepcionId) {
  return db.prepare('SELECT observada, calidad_pct_afectado, calidad_observaciones FROM sg_recepciones WHERE id=?').get(recepcionId);
}

function crearLotesDeItem(db, { recepcionId, ocItem, tipoPrecio, fechaIngreso, lotes, userId }) {
  const prod = db.prepare('SELECT vida_util_dias_default FROM sg_productos WHERE id=?').get(ocItem.producto_id);
  const vida = (prod && prod.vida_util_dias_default) || 0;
  const _rec = _recObservada(db, recepcionId);
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
    _aplicarObservado(db, info.lastInsertRowid, _rec, userId);
  }
  return ids;
}

// Lotes de una recepción SIN OC: producto elegido a mano, sin oc_item_id y SIN precio
// (costo pendiente). precio_unitario_kg=NULL → recalcCostoLote los deja en costo_final=0 y
// los reportes los marcan "costo pendiente". Se completa al vincular la OC (baja el precio).
function crearLotesSinOC(db, { recepcionId, productoId, fechaIngreso, lotes, userId }) {
  const prod = db.prepare('SELECT vida_util_dias_default FROM sg_productos WHERE id=?').get(productoId);
  if (!prod) throw new Error('Producto inválido: ' + productoId);
  const vida = prod.vida_util_dias_default || 0;
  const _rec = _recObservada(db, recepcionId);
  const ins = db.prepare(`INSERT INTO sg_lotes
    (codigo_lote, recepcion_id, oc_item_id, producto_id, kg_reales, precio_unitario_kg, costo_base,
     calidad, calibre, origen, fecha_ingreso, fecha_vencimiento_estimada, estado, costo_final, creado_por)
    VALUES (?,?, NULL, ?,?, NULL, 0, ?, NULL, NULL, ?, ?, 'disponible', 0, ?)`);
  const ids = [];
  for (const lt of lotes) {
    const kg = Number(lt.kg_reales || 0);
    let venc = val(lt.fecha_vencimiento_estimada);
    if (!venc && fechaIngreso && vida) venc = db.prepare('SELECT date(?, ?) d').get(fechaIngreso, `+${vida} days`).d;
    const codigo = nextNumero(db, 'SG-LT', 'sg_lotes', 'codigo_lote');
    const info = ins.run(codigo, recepcionId, productoId, kg, val(lt.calidad), fechaIngreso, venc, userId);
    ids.push(info.lastInsertRowid);
    _aplicarObservado(db, info.lastInsertRowid, _rec, userId);
  }
  return ids;
}

// #reproceso caso 2: crea el lote-DESTINO de una transformación (ej. caja → cubetas) y mueve el
// costo del origen. El lote-destino: producto_id distinto, hereda traza física + semáforo del
// origen, recepcion_id/oc_item_id=NULL (NO es compra → fuera de OC/recepción/proveedor/prorrateo),
// transformado_de=origen, costo CARGADO = snapshot (kg × costo/kg vigente del origen). Registra
// la fila en sg_transformaciones y reduce costo_final + estado del origen (recalc). Devuelve datos.
function crearLoteTransformado(db, { origen, productoDestinoId, kg, factor, userId }) {
  const kgVigOrigen = (origen.kg_reales || 0) - kgDecomisado(db, origen.id) - kgTransformado(db, origen.id);
  const costoKgOrigen = kgVigOrigen > 0 ? (origen.costo_final || 0) / kgVigOrigen : 0;
  const costoTransf = +(kg * costoKgOrigen).toFixed(2);
  const codigo = nextNumero(db, 'SG-LT', 'sg_lotes', 'codigo_lote');
  const info = db.prepare(`INSERT INTO sg_lotes
    (codigo_lote, recepcion_id, oc_item_id, producto_id, kg_reales, precio_unitario_kg, costo_base,
     calidad, calibre, origen, fecha_ingreso, fecha_vencimiento_estimada, estado, costo_final,
     semaforo, transformado_de, creado_por)
    VALUES (?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'disponible', ?, ?, ?, ?)`).run(
    codigo, productoDestinoId, kg, costoTransf,
    origen.calidad, origen.calibre, origen.origen, origen.fecha_ingreso, origen.fecha_vencimiento_estimada,
    costoTransf, origen.semaforo || 'verde', origen.id, userId || null);
  const destinoId = info.lastInsertRowid;
  db.prepare(`INSERT INTO sg_transformaciones
    (lote_origen_id, lote_destino_id, kg_transformados, factor, costo_transferido, usuario_id)
    VALUES (?,?,?,?,?,?)`).run(origen.id, destinoId, kg, factor != null ? factor : null, costoTransf, userId || null);
  // el origen pierde el costo transferido (recalc resta Σcosto_transferido) y recalcula su estado.
  recalcCostoLote(db, origen.id);
  recalcEstadoLote(db, origen.id);
  return { loteId: destinoId, codigoLote: codigo, costoTransferido: costoTransf, costoKgOrigen: +costoKgOrigen.toFixed(4) };
}

// #reproceso caso 1: crea un lote-HIJO de un reproceso (clasificación). Hermano de
// crearLoteTransformado pero: producto_id LIBRE (igual o distinto a la madre), costo CARGADO =
// costo_asignado (definido caso por caso, NO snapshot), y calidad + semáforo los ELIGE quien carga
// (no se heredan: primera puede ser verde, segunda amarilla). transformado_de=madre → queda fuera
// de prorrateo/compra. reproceso_id agrupa los hijos. NO recalcula la madre (lo hace el endpoint
// una sola vez al cerrar). Hereda fecha_ingreso/vencimiento/origen de la madre (misma mercadería).
function crearLoteHijo(db, { madre, reprocesoId, productoId, kg, costoAsignado, calidad, semaforo, userId }) {
  const costo = +(+costoAsignado || 0).toFixed(2);
  const codigo = nextNumero(db, 'SG-LT', 'sg_lotes', 'codigo_lote');
  const info = db.prepare(`INSERT INTO sg_lotes
    (codigo_lote, recepcion_id, oc_item_id, producto_id, kg_reales, precio_unitario_kg, costo_base,
     calidad, calibre, origen, fecha_ingreso, fecha_vencimiento_estimada, estado, costo_final,
     semaforo, transformado_de, reproceso_id, creado_por)
    VALUES (?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'disponible', ?, ?, ?, ?, ?)`).run(
    codigo, productoId, kg, costo,
    val(calidad), madre.calibre, madre.origen, madre.fecha_ingreso, madre.fecha_vencimiento_estimada,
    costo, semaforo || 'verde', madre.id, reprocesoId, userId || null);
  return { loteId: info.lastInsertRowid, codigoLote: codigo, costo };
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
    // Flete INFORMATIVO: se guarda quién paga + el monto que carga el comercial, pero
    // NO entra al total (el total sigue saliendo solo del loop de items, más abajo).
    const fleteCargo = (b.flete_a_cargo === 'comprador' || b.flete_a_cargo === 'vendedor') ? b.flete_a_cargo : null;
    const fleteMonto = (b.flete_monto != null && b.flete_monto !== '') ? Number(b.flete_monto) : null;
    const dft = defaultsProveedor(db, b.proveedor_id, b);
    // ── IVA Fase 2 — la OC discrimina IVA solo con Factura A + precio firme. En Liquidación
    // (o pizarra) NO se discrimina (el IVA se resuelve después). precio_incluye_iva: el
    // comercial define si el $/kg ya trae IVA o si se le adiciona. iva_alicuota_oc: override
    // opcional; si es null, la alícuota sale de la familia de cada item.
    const discrimina = (dft.tipo_fiscal === 'factura_a') && (tipoPrecio === 'firme');
    const incluyeIva = b.precio_incluye_iva ? 1 : 0;
    const alicOverride = (b.iva_alicuota_oc != null && b.iva_alicuota_oc !== '') ? Number(b.iva_alicuota_oc) : null;
    const alicFamStmt = db.prepare('SELECT f.iva_alicuota AS a FROM sg_productos p LEFT JOIN sg_familias f ON f.id=p.familia_id WHERE p.id=?');

    const tx = db.transaction(() => {
      const numero = nextNumero(db, 'SG-OC', 'sg_oc', 'numero');
      const ocInfo = db.prepare(`INSERT INTO sg_oc
        (numero, modalidad, proveedor_id, tipo_fiscal, tipo_precio, condicion_pago_id, fecha_oc,
         fecha_recepcion_estimada, comercial_id, estado, observaciones, flete_a_cargo, flete_monto,
         precio_incluye_iva, iva_alicuota_oc, total_estimado_kg, total_estimado_monto, creado_por)
        VALUES (?,?,?,?,?,?,?,?,?, 'abierta', ?,?,?, ?,?, 0, 0, ?)`).run(
        numero, val(b.modalidad) || 'normal', b.proveedor_id || null, dft.tipo_fiscal, tipoPrecio,
        dft.condicion_pago_id, val(b.fecha_oc), val(b.fecha_recepcion_estimada), b.comercial_id || null,
        val(b.observaciones), fleteCargo, fleteMonto, (discrimina ? incluyeIva : null), alicOverride, uid(req));
      const ocId = ocInfo.lastInsertRowid;

      const insItem = db.prepare(`INSERT INTO sg_oc_items
        (oc_id, producto_id, presentacion_id, cantidad_estimada_presentaciones, kg_estimados, precio_estimado_por_kg, observaciones_item, modo_carga,
         iva_alicuota, neto_estimado, iva_estimado)
        VALUES (?,?,?,?,?,?,?,?, ?,?,?)`);
      let totKg = 0, totMonto = 0, totNeto = 0, totIva = 0;
      for (const it of items) {
        const pres = it.presentacion_id ? db.prepare('SELECT factor_conversion FROM sg_presentaciones WHERE id=?').get(it.presentacion_id) : null;
        const factor = pres ? Number(pres.factor_conversion) : 1;
        const cant = Number(it.cantidad_estimada_presentaciones || 0);
        // El front manda kg_estimados y precio_estimado_por_kg YA canónicos (kg y $/kg efectivo),
        // sin importar el modo de carga → el costeo/stock siguen 100% en kg, intactos.
        const kg = it.kg_estimados != null ? Number(it.kg_estimados) : cant * factor;
        const precio = tipoPrecio === 'pizarra' ? null : (it.precio_estimado_por_kg != null ? Number(it.precio_estimado_por_kg) : null);
        const modo = it.modo_carga === 'bulto' ? 'bulto' : 'kilo';   // CAMBIO 2: solo registro del modo de ingreso
        // ── IVA por línea (snapshot). Alícuota = override de OC, o la heredada de la familia.
        const bruto = (precio != null) ? kg * precio : 0;
        let alic = null, neto = (precio != null) ? bruto : null, iva = (precio != null) ? 0 : null;
        if (discrimina && precio != null) {
          if (alicOverride != null) alic = alicOverride;
          else { const fa = alicFamStmt.get(it.producto_id); alic = (fa && fa.a != null) ? Number(fa.a) : null; }
          if (alic != null) {
            if (incluyeIva) { neto = bruto / (1 + alic / 100); iva = bruto - neto; } // precio trae IVA
            else            { neto = bruto;                     iva = bruto * alic / 100; } // se adiciona
          }
        }
        insItem.run(ocId, it.producto_id, it.presentacion_id || null, cant, kg, precio, val(it.observaciones_item), modo,
          alic, neto, iva);
        totKg += kg;
        if (precio != null) { totMonto += neto + iva; totNeto += neto; totIva += iva; } // total con IVA = neto+iva (= bruto si no discrimina o precio incluye IVA)
      }
      db.prepare('UPDATE sg_oc SET total_estimado_kg=?, total_estimado_monto=?, total_neto=?, total_iva=? WHERE id=?')
        .run(totKg, totMonto, (discrimina ? totNeto : null), (discrimina ? totIva : null), ocId);
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

// PDF formal de la OC. Reusa el detalle + joins extra (proveedor completo, nombre de
// condición de pago y del comercial) que generarOcPDF necesita para el membrete/firma.
router.get('/oc/:id/pdf', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const oc = db.prepare(`SELECT o.*,
        p.razon_social AS prov_razon, p.cuit AS prov_cuit, p.categoria_fiscal AS prov_catfisc,
        p.localidad AS prov_localidad, p.provincia AS prov_provincia, p.nombre_comercial AS prov_fantasia,
        c.nombre AS cond_nombre,
        COALESCE(uc.nombre, ucr.nombre) AS comercial_nombre
      FROM sg_oc o
      LEFT JOIN sg_proveedores p ON p.id=o.proveedor_id
      LEFT JOIN sg_condiciones_pago c ON c.id=o.condicion_pago_id
      LEFT JOIN usuarios uc  ON uc.id  = o.comercial_id
      LEFT JOIN usuarios ucr ON ucr.id = o.creado_por
      WHERE o.id=?`).get(req.params.id);
    if (!oc) return res.status(404).json({ ok: false, error: 'No encontrado' });
    oc.items = db.prepare(`SELECT i.*, pr.codigo AS producto_codigo, pr.nombre AS producto_nombre,
        pr.variedad AS producto_variedad, ps.nombre AS presentacion_nombre
      FROM sg_oc_items i
      LEFT JOIN sg_productos pr ON pr.id=i.producto_id
      LEFT JOIN sg_presentaciones ps ON ps.id=i.presentacion_id
      WHERE i.oc_id=?`).all(req.params.id);
    const pdf = generarOcPDF(oc);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${(oc.numero || 'OC').replace(/[^\w.-]/g, '_')}.pdf"`,
    });
    res.send(pdf);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Editar cabecera de OC (solo borrador/abierta) + regenerar vencimientos
router.put('/oc/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const oc = db.prepare('SELECT estado FROM sg_oc WHERE id=?').get(req.params.id);
    if (!oc) return res.status(404).json({ ok: false, error: 'No encontrado' });
    if (!['borrador', 'abierta'].includes(oc.estado)) return res.status(400).json({ ok: false, error: 'Solo se edita una OC en borrador/abierta' });
    const campos = ['tipo_fiscal', 'condicion_pago_id', 'fecha_oc', 'fecha_recepcion_estimada', 'comercial_id', 'observaciones', 'flete_a_cargo', 'flete_monto'];
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
// BLOQUE A+B — multipart: campos de texto en req.body.payload (JSON) + fotos en req.files.
// upload.array corre primero para poblar req.body/req.files; requireAdmin no lee el body.
router.post('/recepciones', sgUpload.array('fotos', 12), requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body && req.body.payload ? JSON.parse(req.body.payload) : (req.body || {});
    const numN = (v) => (v != null && v !== '' && !isNaN(Number(v))) ? Number(v) : null; // BLOQUE A
    // RECEPCIÓN SIN OC: si no viene oc_id, se recibe igual y queda "OC pendiente" (lotes con
    // costo pendiente). Se vincula a una OC después (POST /recepciones/:id/vincular-oc).
    const sinOC = !b.oc_id;
    let oc = null;
    if (!sinOC) {
      oc = db.prepare('SELECT * FROM sg_oc WHERE id=? AND activo=1').get(b.oc_id);
      if (!oc) return res.status(400).json({ ok: false, error: 'OC inexistente' });
      if (oc.estado === 'anulada') return res.status(400).json({ ok: false, error: 'OC anulada' });
    }
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: 'Sin items para recibir' });

    // Validación: cada item con lotes; sin OC además exige producto; y suma de kg coincide.
    for (const it of items) {
      const lotes = Array.isArray(it.lotes) ? it.lotes : [];
      if (!lotes.length) return res.status(400).json({ ok: false, error: 'Cada item debe tener al menos un lote' });
      if (sinOC && !it.producto_id) return res.status(400).json({ ok: false, error: 'Cada línea sin OC necesita un producto' });
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
      // BLOQUE A (doc + paletizado) + BLOQUE B (calidad) + oc_pendiente se persisten en la recepción.
      const recInfo = db.prepare(`INSERT INTO sg_recepciones
        (oc_id, numero_recepcion, fecha_recepcion, recibido_por, numero_remito_proveedor, observaciones, creado_por,
         factura_numero, dtv_codigo, pallets_recibidos, bultos_recibidos,
         observada, calidad_estado_general, calidad_defectos, calidad_pct_afectado, calidad_observaciones, oc_pendiente)
        VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?)`).run(
        sinOC ? null : b.oc_id, numero, fechaIngreso, b.recibido_por || null, val(b.numero_remito_proveedor), val(b.observaciones), uid(req),
        val(b.factura_numero), val(b.dtv_codigo), numN(b.pallets_recibidos), numN(b.bultos_recibidos),
        b.observada ? 1 : 0, val(b.calidad_estado_general), val(b.calidad_defectos), numN(b.calidad_pct_afectado), val(b.calidad_observaciones),
        sinOC ? 1 : 0);
      const recId = recInfo.lastInsertRowid;
      // BLOQUE B — fotos del informe (patrón IFCO: ruta /data/sg/<archivo>).
      for (const f of (req.files || [])) {
        db.prepare('INSERT INTO sg_recepcion_fotos (recepcion_id, ruta, nombre_original, creado_por) VALUES (?,?,?,?)')
          .run(recId, '/data/sg/' + f.filename, f.originalname || null, uid(req));
      }
      // FASE 2 — si se asignó cooperativa, queda una DESCARGA DE INGRESO pendiente. La unidad
      // (bulto/pallet) define la cantidad: bultos_recibidos o pallets_recibidos de la recepción.
      const coopId = b.cooperativa_id ? Number(b.cooperativa_id) : null;
      const coopUnidad = b.cooperativa_unidad === 'pallet' ? 'pallet' : 'bulto';
      const coopCant = coopUnidad === 'pallet' ? numN(b.pallets_recibidos) : numN(b.bultos_recibidos);
      syncGastoCoop(db, { tipo: 'descarga_ingreso', recepcionId: recId, proveedorId: coopId, unidad: coopUnidad, cantidad: coopCant, fechaServicio: fechaIngreso, userId: uid(req) });
      const nuevosLotes = [];
      for (const it of items) {
        if (sinOC) {
          const ids = crearLotesSinOC(db, { recepcionId: recId, productoId: Number(it.producto_id), fechaIngreso, lotes: it.lotes, userId: uid(req) });
          nuevosLotes.push(...ids);
        } else {
          const ocItem = db.prepare('SELECT * FROM sg_oc_items WHERE id=? AND oc_id=?').get(it.oc_item_id, b.oc_id);
          if (!ocItem) throw new Error('Item de OC inválido: ' + it.oc_item_id);
          const ids = crearLotesDeItem(db, { recepcionId: recId, ocItem, tipoPrecio: oc.tipo_precio, fechaIngreso, lotes: it.lotes, userId: uid(req) });
          nuevosLotes.push(...ids);
        }
      }
      if (!sinOC) {
        actualizarEstadoOC(db, b.oc_id);
        generarVencimientos(db, Number(b.oc_id));
      }
      recalcPeriodo(db, fechaIngreso.slice(0, 7));
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
    // BLOQUE B — fotos del informe de calidad asociadas a la recepción.
    rec.fotos = db.prepare('SELECT id, ruta, nombre_original FROM sg_recepcion_fotos WHERE recepcion_id=? ORDER BY id').all(req.params.id);
    res.json({ ok: true, data: rec });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Vincular una recepción "OC pendiente" a una OC: setea oc_id, quita la marca y BAJA el precio
// de la OC a los lotes (match por producto_id con un item de la OC), recalculando el costo.
// Lotes cuyo producto no esté en la OC (o OC pizarra sin precio) quedan pendientes.
router.post('/recepciones/:id/vincular-oc', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const rec = db.prepare('SELECT * FROM sg_recepciones WHERE id=? AND activo=1').get(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'Recepción no encontrada' });
    if (rec.oc_id) return res.status(400).json({ ok: false, error: 'La recepción ya está vinculada a una OC' });
    const ocId = Number(req.body.oc_id);
    const oc = ocId ? db.prepare('SELECT * FROM sg_oc WHERE id=? AND activo=1').get(ocId) : null;
    if (!oc) return res.status(400).json({ ok: false, error: 'OC inexistente' });
    if (oc.estado === 'anulada') return res.status(400).json({ ok: false, error: 'OC anulada' });

    const out = db.transaction(() => {
      db.prepare("UPDATE sg_recepciones SET oc_id=?, oc_pendiente=0, modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?")
        .run(ocId, uid(req), req.params.id);
      const lotes = db.prepare('SELECT id, producto_id, kg_reales FROM sg_lotes WHERE recepcion_id=? AND activo=1').all(req.params.id);
      let conPrecio = 0;
      for (const l of lotes) {
        const ocItem = db.prepare('SELECT id, precio_estimado_por_kg FROM sg_oc_items WHERE oc_id=? AND producto_id=? ORDER BY id LIMIT 1').get(ocId, l.producto_id);
        if (!ocItem) continue; // producto no está en la OC → el lote queda pendiente
        const precio = (oc.tipo_precio === 'firme' && ocItem.precio_estimado_por_kg != null) ? Number(ocItem.precio_estimado_por_kg) : null;
        const costoBase = precio != null ? l.kg_reales * precio : 0;
        db.prepare("UPDATE sg_lotes SET oc_item_id=?, precio_unitario_kg=?, costo_base=?, modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?")
          .run(ocItem.id, precio, costoBase, uid(req), l.id);
        recalcCostoLote(db, l.id);
        if (precio != null) conPrecio++;
      }
      actualizarEstadoOC(db, ocId);
      generarVencimientos(db, ocId);
      recalcPeriodo(db, (rec.fecha_recepcion || '').slice(0, 7));
      return { lotes: lotes.length, conPrecio };
    })();
    res.json({ ok: true, data: out });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── BLOQUE B — PDF del informe de calidad (REUSA jsPDF, patrón ordenPDF.js). Embebe las
// fotos (leídas de disco → base64) + datos de recepción / proveedor / OC. Link directo
// (GET con cookie → requireAuth). ──
router.get('/recepciones/:id/calidad.pdf', requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const rec = db.prepare(`SELECT r.*, o.numero AS oc_numero, o.tipo_precio,
        p.razon_social AS proveedor_nombre, p.cuit AS proveedor_cuit
      FROM sg_recepciones r
      LEFT JOIN sg_oc o ON o.id=r.oc_id
      LEFT JOIN sg_proveedores p ON p.id=o.proveedor_id
      WHERE r.id=?`).get(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'No encontrado' });
    rec.lotes = db.prepare(`SELECT l.*, pr.nombre AS producto_nombre, pr.variedad AS producto_variedad
      FROM sg_lotes l LEFT JOIN sg_productos pr ON pr.id=l.producto_id
      WHERE l.recepcion_id=? AND l.activo=1`).all(rec.id);
    // Leer las fotos físicas → base64 para embeber en el PDF (jsPDF.addImage).
    const fotosRows = db.prepare('SELECT ruta FROM sg_recepcion_fotos WHERE recepcion_id=? ORDER BY id').all(rec.id);
    const fotos = fotosRows.map((f) => {
      try {
        const fp = path.join(SG_UPLOAD_DIR, path.basename(f.ruta));
        const buf = fs.readFileSync(fp);
        const ext = path.extname(fp).toLowerCase();
        const fmt = (ext === '.png') ? 'PNG' : 'JPEG';
        return { dataUri: 'data:image/' + (fmt === 'PNG' ? 'png' : 'jpeg') + ';base64,' + buf.toString('base64'), fmt };
      } catch (_) { return null; }
    }).filter(Boolean);
    const pdf = await generarRecepcionCalidadPDF(rec, fotos);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="informe-calidad-${(rec.numero_recepcion || rec.id)}.pdf"`
    });
    res.send(pdf);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── PASO 2 — VISTA PREVIA del informe de calidad (sin persistir). Recibe el payload de la
// recepción en curso + las fotos (en memoria) y devuelve el PDF para previsualizar antes de
// confirmar. NO escribe en DB ni en disco. Reusa el mismo generador que el PDF definitivo. ──
router.post('/recepciones/preview-calidad.pdf', sgUploadMem.array('fotos', 12), requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const b = (req.body && req.body.payload) ? JSON.parse(req.body.payload) : {};
    const oc = b.oc_id ? db.prepare(`SELECT o.numero AS oc_numero, p.razon_social AS proveedor_nombre, p.cuit AS proveedor_cuit
      FROM sg_oc o LEFT JOIN sg_proveedores p ON p.id=o.proveedor_id WHERE o.id=?`).get(b.oc_id) : null;
    const rec = {
      id: null, numero_recepcion: '(vista previa)', fecha_recepcion: b.fecha_recepcion,
      oc_numero: oc && oc.oc_numero, proveedor_nombre: oc && oc.proveedor_nombre, proveedor_cuit: oc && oc.proveedor_cuit,
      numero_remito_proveedor: b.numero_remito_proveedor, factura_numero: b.factura_numero, dtv_codigo: b.dtv_codigo,
      pallets_recibidos: b.pallets_recibidos, bultos_recibidos: b.bultos_recibidos,
      observada: b.observada ? 1 : 0, calidad_estado_general: b.calidad_estado_general, calidad_defectos: b.calidad_defectos,
      calidad_pct_afectado: b.calidad_pct_afectado, calidad_observaciones: b.calidad_observaciones, observaciones: b.observaciones,
      lotes: []
    };
    // Lotes-display desde los items del formulario (sin códigos aún; es una previa).
    for (const it of (b.items || [])) for (const l of (it.lotes || [])) {
      rec.lotes.push({ codigo_lote: '—', producto_nombre: it.producto_nombre || '', producto_variedad: '', calidad: l.calidad, kg_reales: l.kg_reales });
    }
    // Fotos desde memoria (buffer → base64), sin tocar disco.
    const fotos = (req.files || []).map((f) => ({
      dataUri: 'data:' + (f.mimetype || 'image/jpeg') + ';base64,' + f.buffer.toString('base64'),
      fmt: (f.mimetype || '').includes('png') ? 'PNG' : 'JPEG'
    }));
    const pdf = await generarRecepcionCalidadPDF(rec, fotos);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="vista-previa-calidad.pdf"' });
    res.send(pdf);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
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
    if (req.query.calidad) { where.push('l.calidad=?'); params.push(req.query.calidad); }
    if (req.query.recepcion_id) { where.push('l.recepcion_id=?'); params.push(req.query.recepcion_id); }
    if (req.query.oc_id) { where.push('l.oc_item_id IN (SELECT id FROM sg_oc_items WHERE oc_id=?)'); params.push(req.query.oc_id); }
    if (req.query.sin_precio === '1') where.push('l.precio_unitario_kg IS NULL');
    if (req.query.ingreso_desde) { where.push('l.fecha_ingreso>=?'); params.push(req.query.ingreso_desde); }
    if (req.query.ingreso_hasta) { where.push('l.fecha_ingreso<=?'); params.push(req.query.ingreso_hasta); }
    // Próximos a vencer: dentro de N días (incluye vencidos), y no dados de baja.
    if (req.query.por_vencer) {
      where.push("l.estado!='bajado' AND l.fecha_vencimiento_estimada IS NOT NULL AND julianday(l.fecha_vencimiento_estimada) - julianday(date('now','localtime')) <= ?");
      params.push(Number(req.query.por_vencer));
    }
    const rows = db.prepare(`
      SELECT l.*, pr.nombre AS producto_nombre, pr.familia AS producto_familia,
        r.numero_recepcion, o.numero AS oc_numero, pv.razon_social AS proveedor_nombre,
        CAST(julianday(l.fecha_vencimiento_estimada) - julianday(date('now','localtime')) AS INTEGER) AS dias_restantes
      FROM sg_lotes l
      LEFT JOIN sg_productos pr ON pr.id=l.producto_id
      LEFT JOIN sg_recepciones r ON r.id=l.recepcion_id
      LEFT JOIN sg_oc o ON o.id=r.oc_id
      LEFT JOIN sg_proveedores pv ON pv.id=o.proveedor_id
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

// ════════════════════════════════════════════════════════════════════════════
// FASE 3 — STOCK: edición de lote + Trazabilidad backward + Bajas
// ════════════════════════════════════════════════════════════════════════════

// Editar campos manuales del lote (vencimiento, calibre, origen, calidad).
router.put('/lotes/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const lote = db.prepare('SELECT id FROM sg_lotes WHERE id=? AND activo=1').get(req.params.id);
    if (!lote) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    const campos = ['fecha_vencimiento_estimada', 'calibre', 'origen', 'calidad'];
    const sets = [], vals = [];
    for (const c of campos) if (req.body[c] !== undefined) { sets.push(`${c}=?`); vals.push(val(req.body[c])); }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'Sin cambios' });
    sets.push(`modificado_en=datetime('now','localtime')`, 'modificado_por=?'); vals.push(uid(req), req.params.id);
    db.prepare(`UPDATE sg_lotes SET ${sets.join(',')} WHERE id=?`).run(...vals);
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Semáforo del lote — cambio MANUAL (un comercial lo baja a amarillo/rojo). Pide motivo y
// registra el cambio en el historial con origen='manual'. (reproceso/observado/devolucion
// van por sus propios flujos.) requireAuth: cualquier usuario autenticado.
const SEM_COLORES = ['verde', 'amarillo', 'rojo'];
router.patch('/lotes/:id/semaforo', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const color = String(req.body?.color || '');
    const motivo = String(req.body?.motivo || '').trim();
    if (!SEM_COLORES.includes(color)) return res.status(400).json({ ok: false, error: 'color inválido (verde/amarillo/rojo)' });
    if (!motivo) return res.status(400).json({ ok: false, error: 'motivo requerido' });
    const lote = db.prepare('SELECT id, semaforo FROM sg_lotes WHERE id=?').get(req.params.id);
    if (!lote) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    const anterior = lote.semaforo;
    db.transaction(() => {
      db.prepare("UPDATE sg_lotes SET semaforo=?, modificado_en=datetime('now','localtime') WHERE id=?").run(color, lote.id);
      db.prepare(`INSERT INTO sg_lote_semaforo_historial (lote_id, color_anterior, color_nuevo, motivo, origen, usuario_id)
        VALUES (?,?,?,?, 'manual', ?)`).run(lote.id, anterior, color, motivo, uid(req));
    })();
    res.json({ ok: true, data: { id: lote.id, color_anterior: anterior, color_nuevo: color } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Trazabilidad backward: proveedor → OC → recepción → gastos → (despachos: F4) → clientes.
router.get('/lotes/:id/trazabilidad', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const lote = db.prepare(`SELECT l.*, pr.nombre AS producto_nombre, pr.familia AS producto_familia,
        pr.vida_util_dias_default,
        CAST(julianday(l.fecha_vencimiento_estimada) - julianday(date('now','localtime')) AS INTEGER) AS dias_restantes
      FROM sg_lotes l LEFT JOIN sg_productos pr ON pr.id=l.producto_id WHERE l.id=?`).get(req.params.id);
    if (!lote) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });

    const recepcion = lote.recepcion_id ? db.prepare('SELECT * FROM sg_recepciones WHERE id=?').get(lote.recepcion_id) : null;
    const oc = recepcion ? db.prepare('SELECT * FROM sg_oc WHERE id=?').get(recepcion.oc_id) : null;
    const proveedor = oc && oc.proveedor_id ? db.prepare('SELECT id, razon_social, cuit, tipo, localidad, provincia FROM sg_proveedores WHERE id=?').get(oc.proveedor_id) : null;
    const ocItem = lote.oc_item_id ? db.prepare('SELECT * FROM sg_oc_items WHERE id=?').get(lote.oc_item_id) : null;
    const gastosDirectos = db.prepare('SELECT * FROM sg_gastos_directos_lote WHERE lote_id=? AND activo=1 ORDER BY id').all(lote.id);

    // Prorrateo global del período
    const periodo = (lote.fecha_ingreso || '').slice(0, 7);
    let prorrateo = null;
    if (periodo) {
      const totalGlob = db.prepare('SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_globales_periodo WHERE periodo=? AND activo=1').get(periodo).s;
      const totalKg = db.prepare("SELECT COALESCE(SUM(kg_reales),0) s FROM sg_lotes WHERE activo=1 AND transformado_de IS NULL AND substr(fecha_ingreso,1,7)=?").get(periodo).s;
      const share = totalKg > 0 ? totalGlob * (lote.kg_reales / totalKg) : 0;
      prorrateo = { periodo, total_global: totalGlob, kg_periodo: totalKg, kg_lote: lote.kg_reales, share };
    }

    // Forward (despachos donde se usó este lote) — se completa en Fase 4.
    const despachos = db.prepare(`SELECT di.kg_despachados, di.precio_por_kg, di.subtotal, di.margen_estimado,
        d.id AS despacho_id, d.numero AS despacho_numero, d.fecha_despacho, c.razon_social AS cliente_nombre
      FROM sg_despacho_items di
      JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
      LEFT JOIN sg_clientes c ON c.id=d.cliente_id
      WHERE di.lote_id=? ORDER BY d.fecha_despacho`).all(lote.id);

    res.json({ ok: true, data: { lote, producto: { id: lote.producto_id, nombre: lote.producto_nombre, familia: lote.producto_familia }, oc_item: ocItem, recepcion, oc, proveedor, gastos_directos: gastosDirectos, prorrateo, despachos } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Baja de lote: destino_baja (venta/liquidacion/donacion/disposal). Donación exige receptor.
router.post('/lotes/:id/baja', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const destino = req.body.destino_baja;
    if (!['venta', 'liquidacion', 'donacion', 'disposal'].includes(destino)) {
      return res.status(400).json({ ok: false, error: 'destino_baja inválido' });
    }
    if (destino === 'donacion' && !val(req.body.receptor_donacion)) {
      return res.status(400).json({ ok: false, error: 'La donación requiere receptor' });
    }
    const lote = db.prepare('SELECT estado FROM sg_lotes WHERE id=? AND activo=1').get(req.params.id);
    if (!lote) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    if (lote.estado === 'bajado') return res.status(400).json({ ok: false, error: 'El lote ya está dado de baja' });
    db.prepare(`UPDATE sg_lotes SET estado='bajado', destino_baja=?, receptor_donacion=?,
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
      .run(destino, destino === 'donacion' ? val(req.body.receptor_donacion) : null, uid(req), req.params.id);
    res.json({ ok: true, data: { id: Number(req.params.id), destino_baja: destino } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Decomiso PARCIAL de un lote: saca X kg (merma) SIN tocar kg_reales. Baja el disponible y revalúa
// el costo/kg (costo_final fijo / kg vigentes). El lote SIGUE activo; pasa a 'amarillo' si estaba
// verde. requireAuth (cualquiera con acceso, incl. operario). La baja TOTAL (disposal) es aparte.
router.post('/lotes/:id/decomiso', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const kg = Number(req.body?.kg);
    const motivo = String(req.body?.motivo || '').trim();
    if (!(kg > 0)) return res.status(400).json({ ok: false, error: 'kg debe ser > 0' });
    if (!motivo) return res.status(400).json({ ok: false, error: 'motivo requerido' });
    const lote = db.prepare('SELECT id, kg_reales, estado, semaforo FROM sg_lotes WHERE id=? AND activo=1').get(req.params.id);
    if (!lote) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    if (lote.estado === 'bajado') return res.status(400).json({ ok: false, error: 'El lote está dado de baja' });
    const disp = (lote.kg_reales || 0) - kgDespachados(db, lote.id) - kgDecomisado(db, lote.id) - kgTransformado(db, lote.id);
    if (kg > disp + 0.01) return res.status(400).json({ ok: false, error: `No podés decomisar ${kg}kg: hay ${disp.toFixed(1)}kg disponibles` });
    db.transaction(() => {
      db.prepare('INSERT INTO sg_lote_decomisos (lote_id, kg, motivo, usuario_id) VALUES (?,?,?,?)').run(lote.id, kg, motivo, uid(req));
      // semáforo → amarillo SOLO si estaba verde (si ya amarillo/rojo, no lo cambia ni registra).
      if (lote.semaforo === 'verde') {
        db.prepare("UPDATE sg_lotes SET semaforo='amarillo', modificado_en=datetime('now','localtime') WHERE id=?").run(lote.id);
        db.prepare(`INSERT INTO sg_lote_semaforo_historial (lote_id, color_anterior, color_nuevo, motivo, origen, usuario_id)
          VALUES (?, 'verde', 'amarillo', ?, 'decomiso', ?)`).run(lote.id, `Decomiso ${kg}kg · ${motivo}`, uid(req));
      }
      recalcEstadoLote(db, lote.id);   // umbral sobre kg vigentes → si no queda stock, despachado_total
    })();
    res.json({ ok: true, data: { id: lote.id, kg_decomisado: kg, kg_disponible: +(disp - kg).toFixed(2) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// #reproceso caso 2: TRANSFORMACIÓN de unidad. Convierte stock del lote (producto-caja) en un lote
// NUEVO de otro producto (producto-cubeta: mismo especie/variedad, otro envase). Operación INTERNA:
// NO toca kg_reales del origen (el proveedor lo sigue viendo en cajas); baja su disponible por Σ
// transformado y mueve su costo proporcional al lote-cubeta (sin merma → costo/kg estable). Dos
// formas: { kg } explícito, o sin kg = "1 caja entera" (transforma todo el disponible del lote).
router.post('/lotes/:id/transformar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const productoDestinoId = Number(req.body?.producto_destino_id);
    const factor = (req.body?.factor != null && req.body?.factor !== '') ? Number(req.body.factor) : null;
    if (!productoDestinoId) return res.status(400).json({ ok: false, error: 'Falta producto_destino_id' });
    const origen = db.prepare(`SELECT id, producto_id, kg_reales, costo_final, calidad, calibre, origen,
      fecha_ingreso, fecha_vencimiento_estimada, semaforo, estado FROM sg_lotes WHERE id=? AND activo=1`).get(req.params.id);
    if (!origen) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    if (origen.estado === 'bajado') return res.status(400).json({ ok: false, error: 'El lote está dado de baja' });
    if (productoDestinoId === origen.producto_id) return res.status(400).json({ ok: false, error: 'El producto destino debe ser distinto al de origen' });
    if (!db.prepare('SELECT id FROM sg_productos WHERE id=? AND activo=1').get(productoDestinoId)) {
      return res.status(400).json({ ok: false, error: 'Producto destino inválido' });
    }
    const disp = (origen.kg_reales || 0) - kgDespachados(db, origen.id) - kgDecomisado(db, origen.id) - kgTransformado(db, origen.id);
    // forma "1 caja entera": sin kg → todo el disponible; forma "X kg": kg explícito del body.
    const kg = (req.body?.kg != null && req.body?.kg !== '') ? Number(req.body.kg) : +disp.toFixed(2);
    if (!(kg > 0)) return res.status(400).json({ ok: false, error: 'kg a transformar debe ser > 0' });
    if (kg > disp + 0.01) return res.status(400).json({ ok: false, error: `No podés transformar ${kg}kg: hay ${disp.toFixed(1)}kg disponibles` });
    let out;
    db.transaction(() => { out = crearLoteTransformado(db, { origen, productoDestinoId, kg, factor, userId: uid(req) }); })();
    res.json({ ok: true, data: { lote_origen_id: origen.id, lote_destino_id: out.loteId, codigo_destino: out.codigoLote,
      kg_transformados: kg, factor, costo_transferido: out.costoTransferido, costo_kg_origen: out.costoKgOrigen,
      kg_disponible_origen: +(disp - kg).toFixed(2) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// #reproceso caso 2 — REVERSIÓN PARCIAL: re-consolida lo que QUEDA del lote-cubeta en un lote NUEVO
// del producto-origen (decisión 2: NO devuelve al lote-caja original; lote nuevo = traza limpia).
// El costo se RECALCULA al costo/kg VIGENTE del cubeta: si cambió por una merma en el medio, el
// lote re-consolidado refleja el costo correcto. Internamente es otra transformación (cubeta→nuevo).
router.post('/transformaciones/:id/revertir', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const tr = db.prepare('SELECT * FROM sg_transformaciones WHERE id=?').get(req.params.id);
    if (!tr) return res.status(404).json({ ok: false, error: 'Transformación no encontrada' });
    const cubeta = db.prepare(`SELECT id, producto_id, kg_reales, costo_final, calidad, calibre, origen,
      fecha_ingreso, fecha_vencimiento_estimada, semaforo, estado FROM sg_lotes WHERE id=? AND activo=1`).get(tr.lote_destino_id);
    if (!cubeta) return res.status(404).json({ ok: false, error: 'Lote-cubeta no encontrado' });
    if (cubeta.estado === 'bajado') return res.status(400).json({ ok: false, error: 'El lote-cubeta está dado de baja' });
    const prodOrigen = db.prepare('SELECT producto_id FROM sg_lotes WHERE id=?').get(tr.lote_origen_id);
    if (!prodOrigen) return res.status(404).json({ ok: false, error: 'Lote-origen no encontrado' });
    const dispCubeta = (cubeta.kg_reales || 0) - kgDespachados(db, cubeta.id) - kgDecomisado(db, cubeta.id) - kgTransformado(db, cubeta.id);
    const kg = (req.body?.kg != null && req.body?.kg !== '') ? Number(req.body.kg) : +dispCubeta.toFixed(2);
    if (!(kg > 0)) return res.status(400).json({ ok: false, error: 'kg a revertir debe ser > 0' });
    if (kg > dispCubeta + 0.01) return res.status(400).json({ ok: false, error: `No podés revertir ${kg}kg: el lote-cubeta tiene ${dispCubeta.toFixed(1)}kg disponibles` });
    let out;
    db.transaction(() => {
      // lote NUEVO del producto-origen; el costo se snapshotea al costo/kg vigente del cubeta.
      out = crearLoteTransformado(db, { origen: cubeta, productoDestinoId: prodOrigen.producto_id, kg,
        factor: (tr.factor && tr.factor !== 0) ? +(1 / tr.factor).toFixed(6) : null, userId: uid(req) });
      // auditoría: si el cubeta quedó sin stock vigente, la transformación original pasa a 'revertida'.
      const restante = (cubeta.kg_reales || 0) - kgDespachados(db, cubeta.id) - kgDecomisado(db, cubeta.id) - kgTransformado(db, cubeta.id);
      if (restante <= 0.01) db.prepare("UPDATE sg_transformaciones SET estado='revertida' WHERE id=?").run(tr.id);
    })();
    res.json({ ok: true, data: { transformacion_id: tr.id, lote_cubeta_id: cubeta.id, lote_nuevo_id: out.loteId,
      codigo_nuevo: out.codigoLote, kg_revertidos: kg, costo_recalculado: out.costoTransferido, costo_kg_cubeta: out.costoKgOrigen,
      kg_disponible_cubeta: +(dispCubeta - kg).toFixed(2) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// #reproceso caso 1: REPROCESO con clasificación. Entra 1 lote madre + un gasto de proceso; salen
// N lotes hijos de distinta calidad + una merma. El costo (madre consumida + gasto) se reparte
// entre los hijos vendibles; la merma NO recibe costo (su parte la absorben los hijos → el costo/kg
// de lo aprovechable sube). La madre baja disponible por kg_procesados (incl. merma) y costo_final
// por costo_madre_consumido; kg_reales INTACTO. requireAuth.
// Body: { kg_procesados, gasto_proceso?, gasto_descripcion?, hijos:[{ producto_id, kg, calidad,
//   semaforo, costo_asignado? }] }. Si los hijos no traen costo_asignado, se auto-reparte por kg
//   el total (costo_madre_consumido + gasto_proceso); si lo traen, se valida conservación (±0.01).
router.post('/lotes/:id/reproceso', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const hijos = Array.isArray(b.hijos) ? b.hijos : [];
    if (!hijos.length) return res.status(400).json({ ok: false, error: 'El reproceso necesita al menos un lote hijo' });
    const gasto = (b.gasto_proceso != null && b.gasto_proceso !== '') ? Number(b.gasto_proceso) : 0;
    if (!(gasto >= 0)) return res.status(400).json({ ok: false, error: 'gasto_proceso inválido' });

    const madre = db.prepare(`SELECT id, producto_id, kg_reales, costo_final, calibre, origen,
      fecha_ingreso, fecha_vencimiento_estimada, estado FROM sg_lotes WHERE id=? AND activo=1`).get(req.params.id);
    if (!madre) return res.status(404).json({ ok: false, error: 'Lote madre no encontrado' });
    if (madre.estado === 'bajado') return res.status(400).json({ ok: false, error: 'El lote madre está dado de baja' });

    // Validar/normalizar hijos: kg>0, producto válido (default=madre), calidad/semáforo válidos.
    const SEM = ['verde', 'amarillo', 'rojo'];
    let sumaKgHijos = 0;
    for (const h of hijos) {
      h.kg = Number(h.kg);
      if (!(h.kg > 0)) return res.status(400).json({ ok: false, error: 'Cada hijo necesita kg > 0' });
      h.producto_id = h.producto_id != null ? Number(h.producto_id) : madre.producto_id;
      if (!db.prepare('SELECT id FROM sg_productos WHERE id=? AND activo=1').get(h.producto_id)) {
        return res.status(400).json({ ok: false, error: 'Producto inválido en hijo: ' + h.producto_id });
      }
      if (h.semaforo && !SEM.includes(h.semaforo)) return res.status(400).json({ ok: false, error: 'semaforo inválido: ' + h.semaforo });
      sumaKgHijos += h.kg;
    }

    // kg_procesados: si no viene, = aprovechable (sin merma). Debe ser ≥ Σ kg hijos (la diferencia
    // es la merma) y ≤ disponible de la madre.
    const disp = (madre.kg_reales || 0) - kgDespachados(db, madre.id) - kgDecomisado(db, madre.id) - kgTransformado(db, madre.id);
    const kgProcesados = (b.kg_procesados != null && b.kg_procesados !== '') ? Number(b.kg_procesados) : +sumaKgHijos.toFixed(2);
    if (!(kgProcesados > 0)) return res.status(400).json({ ok: false, error: 'kg_procesados debe ser > 0' });
    if (kgProcesados < sumaKgHijos - 0.01) return res.status(400).json({ ok: false, error: `kg_procesados (${kgProcesados}) no puede ser menor que la suma de los hijos (${sumaKgHijos.toFixed(2)})` });
    if (kgProcesados > disp + 0.01) return res.status(400).json({ ok: false, error: `No podés reprocesar ${kgProcesados}kg: hay ${disp.toFixed(1)}kg disponibles` });
    const kgMerma = +(kgProcesados - sumaKgHijos).toFixed(2);

    // costo que SALE de la madre = kg_procesados × costo/kg vigente (incluye el costo de la merma).
    const kgVigMadre = (madre.kg_reales || 0) - kgDecomisado(db, madre.id) - kgTransformado(db, madre.id);
    const costoKgMadre = kgVigMadre > 0 ? (madre.costo_final || 0) / kgVigMadre : 0;
    const costoMadreConsumido = +(kgProcesados * costoKgMadre).toFixed(2);
    const totalRepartir = +(costoMadreConsumido + gasto).toFixed(2);

    // costo_asignado por hijo: default auto-repartido por kg (proporcional) si no vino; si vino,
    // se valida conservación (Σ = costoMadreConsumido + gasto, ±0.01).
    const traenCosto = hijos.some(h => h.costo_asignado != null && h.costo_asignado !== '');
    if (traenCosto) {
      const sumaCosto = hijos.reduce((a, h) => a + Number(h.costo_asignado || 0), 0);
      if (Math.abs(sumaCosto - totalRepartir) > 0.01) {
        return res.status(400).json({ ok: false, error: `La suma de costo_asignado (${sumaCosto.toFixed(2)}) debe igualar el total a repartir (${totalRepartir.toFixed(2)} = costo madre ${costoMadreConsumido.toFixed(2)} + gasto ${gasto.toFixed(2)})` });
      }
      for (const h of hijos) h._costo = +Number(h.costo_asignado || 0).toFixed(2);
    } else {
      // auto-reparto por kg; el último hijo absorbe el redondeo para que cuadre exacto.
      let acum = 0;
      hijos.forEach((h, i) => {
        h._costo = i === hijos.length - 1 ? +(totalRepartir - acum).toFixed(2) : +(totalRepartir * (h.kg / sumaKgHijos)).toFixed(2);
        acum = +(acum + h._costo).toFixed(2);
      });
    }

    let out;
    db.transaction(() => {
      const info = db.prepare(`INSERT INTO sg_reprocesos
        (lote_madre_id, kg_procesados, kg_merma, costo_madre_consumido, gasto_proceso, gasto_descripcion, usuario_id)
        VALUES (?,?,?,?,?,?,?)`).run(madre.id, kgProcesados, kgMerma, costoMadreConsumido, gasto, val(b.gasto_descripcion), uid(req));
      const reprocesoId = info.lastInsertRowid;
      const hijosOut = hijos.map(h => {
        const r = crearLoteHijo(db, { madre, reprocesoId, productoId: h.producto_id, kg: h.kg, costoAsignado: h._costo,
          calidad: h.calidad, semaforo: h.semaforo, userId: uid(req) });
        return { lote_id: r.loteId, codigo: r.codigoLote, producto_id: h.producto_id, kg: h.kg, calidad: val(h.calidad),
          semaforo: h.semaforo || 'verde', costo_asignado: r.costo, costo_por_kg: +(r.costo / h.kg).toFixed(4) };
      });
      // la madre pierde kg_procesados de disponible y costo_madre_consumido de costo_final (recalc).
      recalcCostoLote(db, madre.id);
      recalcEstadoLote(db, madre.id);
      out = { reprocesoId, hijosOut };
    })();

    res.json({ ok: true, data: {
      reproceso_id: out.reprocesoId, lote_madre_id: madre.id,
      kg_procesados: kgProcesados, kg_merma: kgMerma, kg_aprovechable: +sumaKgHijos.toFixed(2),
      costo_madre_consumido: costoMadreConsumido, gasto_proceso: gasto, total_repartido: totalRepartir,
      costo_kg_madre: +costoKgMadre.toFixed(4), kg_disponible_madre: +(disp - kgProcesados).toFixed(2),
      hijos: out.hijosOut
    } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── HISTORIALES #reproceso (read-only para la UI) ──────────────────────────────
// Decomisos recientes (todos los lotes): código, producto, kg, motivo, fecha, usuario.
router.get('/decomisos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT d.id, d.lote_id, l.codigo_lote, pr.nombre AS producto, d.kg, d.motivo, d.fecha, u.nombre AS usuario
      FROM sg_lote_decomisos d
      JOIN sg_lotes l ON l.id=d.lote_id
      LEFT JOIN sg_productos pr ON pr.id=l.producto_id
      LEFT JOIN usuarios u ON u.id=d.usuario_id
      ORDER BY d.id DESC LIMIT 300`).all();
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Transformaciones recientes: origen→destino (códigos+productos), kg, costo, estado, fecha.
// destino_disponible permite a la UI ofrecer "Revertir" solo si queda stock vigente del destino.
router.get('/transformaciones', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT t.id, t.lote_origen_id, lo.codigo_lote AS origen_codigo, po.nombre AS origen_producto,
        t.lote_destino_id, ld.codigo_lote AS destino_codigo, pd.nombre AS destino_producto,
        t.kg_transformados, t.factor, t.costo_transferido, t.estado, t.fecha,
        (ld.kg_reales
          - COALESCE((SELECT SUM(kg) FROM sg_lote_decomisos WHERE lote_id=ld.id),0)
          - COALESCE((SELECT SUM(kg_transformados) FROM sg_transformaciones WHERE lote_origen_id=ld.id),0)
          - COALESCE((SELECT SUM(kp.kg_procesados) FROM sg_reprocesos kp WHERE kp.lote_madre_id=ld.id AND kp.estado='activo'),0)
          - COALESCE((SELECT SUM(di.kg_despachados) FROM sg_despacho_items di JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1 WHERE di.lote_id=ld.id),0)
        ) AS destino_disponible
      FROM sg_transformaciones t
      JOIN sg_lotes lo ON lo.id=t.lote_origen_id
      LEFT JOIN sg_productos po ON po.id=lo.producto_id
      JOIN sg_lotes ld ON ld.id=t.lote_destino_id
      LEFT JOIN sg_productos pd ON pd.id=ld.producto_id
      ORDER BY t.id DESC LIMIT 300`).all();
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Reprocesos recientes: madre, kg procesados/merma, costo madre, gasto, + códigos de los hijos.
router.get('/reprocesos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT rp.id, rp.lote_madre_id, lm.codigo_lote AS madre_codigo, pm.nombre AS madre_producto,
        rp.kg_procesados, rp.kg_merma, rp.costo_madre_consumido, rp.gasto_proceso, rp.gasto_descripcion,
        rp.estado, rp.fecha,
        (SELECT COUNT(*) FROM sg_lotes WHERE reproceso_id=rp.id) AS hijos_n,
        (SELECT GROUP_CONCAT(codigo_lote, ', ') FROM sg_lotes WHERE reproceso_id=rp.id) AS hijos_codigos
      FROM sg_reprocesos rp
      JOIN sg_lotes lm ON lm.id=rp.lote_madre_id
      LEFT JOIN sg_productos pm ON pm.id=lm.producto_id
      ORDER BY rp.id DESC LIMIT 300`).all();
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// FASE 4 — VENTAS: Pedidos + Despachos (FEFO + margen) + CC clientes + traza forward
// ════════════════════════════════════════════════════════════════════════════

// Recalcula el estado de un lote según lo despachado (no toca lotes 'bajado').
function recalcEstadoLote(db, loteId) {
  const l = db.prepare('SELECT kg_reales, estado FROM sg_lotes WHERE id=?').get(loteId);
  if (!l || l.estado === 'bajado') return;
  const desp = db.prepare(`SELECT COALESCE(SUM(di.kg_despachados),0) s
    FROM sg_despacho_items di JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
    WHERE di.lote_id=?`).get(loteId).s;
  // umbral sobre kg VIGENTES (kg_reales − Σ decomiso − Σ transformado): si se despachó todo
  // lo que quedaba vendible (descontada merma y lo transformado a otro lote) → total.
  const kgVig = (l.kg_reales || 0) - kgDecomisado(db, loteId) - kgTransformado(db, loteId);
  let estado = 'disponible';
  if (desp >= kgVig - 0.01 && desp > 0) estado = 'despachado_total';
  else if (desp > 0) estado = 'despachado_parcial';
  db.prepare("UPDATE sg_lotes SET estado=?, modificado_en=datetime('now','localtime') WHERE id=?").run(estado, loteId);
}

// Autocompleta tipo_fiscal/condicion/direccion desde el cliente si no vinieron.
function defaultsCliente(db, clienteId, body) {
  const c = clienteId ? db.prepare('SELECT tipo_fiscal_habitual, condicion_pago_habitual_id, direccion_entrega FROM sg_clientes WHERE id=?').get(clienteId) : null;
  return {
    tipo_fiscal: val(body.tipo_fiscal) || (c && c.tipo_fiscal_habitual) || 'factura_a',
    condicion_pago_id: body.condicion_pago_id != null ? body.condicion_pago_id : (c && c.condicion_pago_habitual_id) || null,
    direccion_entrega: val(body.direccion_entrega) || (c && c.direccion_entrega) || null
  };
}

// kg ya despachados de un lote (despachos activos)
function kgDespachados(db, loteId) {
  return db.prepare(`SELECT COALESCE(SUM(di.kg_despachados),0) s
    FROM sg_despacho_items di JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
    WHERE di.lote_id=?`).get(loteId).s;
}

// kg decomisados (merma) de un lote — Σ de sg_lote_decomisos. NO toca kg_reales.
function kgDecomisado(db, loteId) {
  return db.prepare('SELECT COALESCE(SUM(kg),0) s FROM sg_lote_decomisos WHERE lote_id=?').get(loteId).s;
}

// kg que SALIERON de este lote = transformaciones (caso 2) + reprocesos (caso 1, kg_procesados
// incluye la merma). NO toca kg_reales. Descuento PERMANENTE (la reversión crea lote nuevo, no
// devuelve acá): por eso NO se filtra por estado en sg_transformaciones. El reproceso sí filtra
// estado='activo' (la reversión de reproceso, V2, marcará 'revertido'). Baja disponible + KG_VIGENTE.
function kgTransformado(db, loteId) {
  const t = db.prepare('SELECT COALESCE(SUM(kg_transformados),0) s FROM sg_transformaciones WHERE lote_origen_id=?').get(loteId).s;
  const r = db.prepare("SELECT COALESCE(SUM(kg_procesados),0) s FROM sg_reprocesos WHERE lote_madre_id=? AND estado='activo'").get(loteId).s;
  return t + r;
}
// Costo total que SALIÓ de este lote = transformaciones + reprocesos (costo_madre_consumido). Reduce
// su costo_final en recalcCostoLote → la valuación de inventario suma sin doble conteo (decisión 3/B).
function costoTransferido(db, loteId) {
  const t = db.prepare('SELECT COALESCE(SUM(costo_transferido),0) s FROM sg_transformaciones WHERE lote_origen_id=?').get(loteId).s;
  const r = db.prepare("SELECT COALESCE(SUM(costo_madre_consumido),0) s FROM sg_reprocesos WHERE lote_madre_id=? AND estado='activo'").get(loteId).s;
  return t + r;
}
// Fragmento SQL reutilizable: Σ kg que salieron del lote 'l' (transformaciones + reprocesos activos).
const SUM_TRANSF = "(COALESCE((SELECT SUM(kg_transformados) FROM sg_transformaciones WHERE lote_origen_id=l.id),0)"
  + " + COALESCE((SELECT SUM(kg_procesados) FROM sg_reprocesos WHERE lote_madre_id=l.id AND estado='activo'),0))";

// ── PEDIDOS ──────────────────────────────────────────────────────────────────
router.post('/pedidos', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    const items = Array.isArray(b.items) ? b.items : [];
    if (!b.cliente_id) return res.status(400).json({ ok: false, error: 'Falta cliente' });
    if (!items.length) return res.status(400).json({ ok: false, error: 'El pedido necesita al menos un item' });
    const dft = defaultsCliente(db, b.cliente_id, b);
    const tx = db.transaction(() => {
      const numero = nextNumero(db, 'SG-PED', 'sg_pedidos', 'numero');
      const info = db.prepare(`INSERT INTO sg_pedidos
        (numero, cliente_id, comercial_id, tipo_fiscal, condicion_pago_id, fecha_pedido, fecha_entrega_solicitada,
         direccion_entrega, estado, observaciones, creado_por)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        numero, b.cliente_id, b.comercial_id || null, dft.tipo_fiscal, dft.condicion_pago_id,
        val(b.fecha_pedido), val(b.fecha_entrega_solicitada), dft.direccion_entrega,
        val(b.estado) || 'confirmado', val(b.observaciones), uid(req));
      const pedidoId = info.lastInsertRowid;
      const ins = db.prepare(`INSERT INTO sg_pedido_items
        (pedido_id, producto_id, presentacion_id, cantidad_presentaciones, kg_solicitados, precio_por_kg, subtotal)
        VALUES (?,?,?,?,?,?,?)`);
      for (const it of items) {
        const pres = it.presentacion_id ? db.prepare('SELECT factor_conversion FROM sg_presentaciones WHERE id=?').get(it.presentacion_id) : null;
        const factor = pres ? Number(pres.factor_conversion) : 1;
        const cant = Number(it.cantidad_presentaciones || 0);
        const kg = it.kg_solicitados != null ? Number(it.kg_solicitados) : cant * factor;
        const precio = Number(it.precio_por_kg || 0);
        ins.run(pedidoId, it.producto_id, it.presentacion_id || null, cant, kg, precio, kg * precio);
      }
      return pedidoId;
    });
    res.json({ ok: true, data: { id: Number(tx()) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.get('/pedidos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['p.activo=1'], params = [];
    if (req.query.estado) { where.push('p.estado=?'); params.push(req.query.estado); }
    if (req.query.cliente_id) { where.push('p.cliente_id=?'); params.push(req.query.cliente_id); }
    const rows = db.prepare(`
      SELECT p.*, c.razon_social AS cliente_nombre,
        (SELECT COALESCE(SUM(subtotal),0) FROM sg_pedido_items WHERE pedido_id=p.id) AS total
      FROM sg_pedidos p LEFT JOIN sg_clientes c ON c.id=p.cliente_id
      WHERE ${where.join(' AND ')} ORDER BY p.id DESC`).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/pedidos/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const p = db.prepare(`SELECT p.*, c.razon_social AS cliente_nombre FROM sg_pedidos p
      LEFT JOIN sg_clientes c ON c.id=p.cliente_id WHERE p.id=?`).get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'No encontrado' });
    p.items = db.prepare(`SELECT i.*, pr.nombre AS producto_nombre, ps.nombre AS presentacion_nombre
      FROM sg_pedido_items i LEFT JOIN sg_productos pr ON pr.id=i.producto_id
      LEFT JOIN sg_presentaciones ps ON ps.id=i.presentacion_id WHERE i.pedido_id=?`).all(req.params.id);
    res.json({ ok: true, data: p });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/pedidos/:id/anular', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE sg_pedidos SET estado='anulado', modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?").run(uid(req), req.params.id);
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── LOTES DISPONIBLES (FEFO) ───────────────────────────────────────────────────
// Ordenados por fecha_vencimiento_estimada ASC; el front marca el primero como sugerido.
router.get('/lotes-disponibles', requireAuth, (req, res) => {
  const db = getDb();
  try {
    if (!req.query.producto_id) return res.status(400).json({ ok: false, error: 'Falta producto_id' });
    const rows = db.prepare(`
      SELECT * FROM (
        SELECT l.id, l.codigo_lote, l.producto_id, pr.nombre AS producto_nombre, l.calidad, l.semaforo,
          l.costo_final, l.kg_reales,
          (l.kg_reales - COALESCE((SELECT SUM(kg) FROM sg_lote_decomisos WHERE lote_id=l.id),0) - ${SUM_TRANSF}) AS kg_vigente,
          l.precio_unitario_kg, l.fecha_vencimiento_estimada,
          CAST(julianday(l.fecha_vencimiento_estimada) - julianday(date('now','localtime')) AS INTEGER) AS dias_restantes,
          (l.kg_reales
             - COALESCE((SELECT SUM(kg) FROM sg_lote_decomisos WHERE lote_id=l.id),0)
             - ${SUM_TRANSF}
             - COALESCE((SELECT SUM(di.kg_despachados) FROM sg_despacho_items di
                 JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1 WHERE di.lote_id=l.id),0)) AS kg_disponibles
        FROM sg_lotes l LEFT JOIN sg_productos pr ON pr.id=l.producto_id
        WHERE l.activo=1 AND l.estado IN ('disponible','reservado','despachado_parcial') AND l.producto_id=?
      ) WHERE kg_disponibles > 0.01
      ORDER BY fecha_vencimiento_estimada ASC, id ASC`).all(req.query.producto_id);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── DESPACHOS ──────────────────────────────────────────────────────────────────
// PARTE B — sincroniza el gasto de FLETE DE SALIDA (pendiente_valorizar) de un despacho con el
// fletero elegido. Idempotente: solo toca el gasto PENDIENTE (nunca uno ya valorizado).
//  - sin fletero → anula el pendiente si existía.
//  - con fletero → si ya hay pendiente, reasigna; si no, crea uno nuevo sin monto.
function syncGastoFleteDespacho(db, despachoId, fleteroId, fechaServicio, userId) {
  const existente = db.prepare(
    "SELECT id, estado FROM sg_gastos_directos WHERE despacho_id=? AND tipo_gasto='flete_salida' AND activo=1 AND estado!='anulado'"
  ).get(despachoId);
  if (!fleteroId) {
    if (existente && existente.estado === 'pendiente_valorizar') {
      db.prepare("UPDATE sg_gastos_directos SET estado='anulado' WHERE id=?").run(existente.id);
    }
    return;
  }
  if (existente) {
    if (existente.estado === 'pendiente_valorizar') {
      db.prepare("UPDATE sg_gastos_directos SET proveedor_servicio_id=?, fecha_servicio=? WHERE id=?").run(fleteroId, fechaServicio, existente.id);
    }
    return; // si ya está valorizado, no se re-asigna acá
  }
  db.prepare(`INSERT INTO sg_gastos_directos
    (tipo_gasto, despacho_id, proveedor_servicio_id, estado, fecha_servicio, creado_por)
    VALUES ('flete_salida', ?, ?, 'pendiente_valorizar', ?, ?)`).run(despachoId, fleteroId, fechaServicio, userId);
}

// FASE 2 — sincroniza el gasto de la COOPERATIVA (carga/descarga) de una operación. Genérico:
// tipo='descarga_ingreso' cuelga de recepcion_id; tipo='carga_salida' cuelga de despacho_id.
// Idempotente: un solo pendiente por (operación, tipo). Sin proveedor → anula el pendiente.
function syncGastoCoop(db, { tipo, despachoId, recepcionId, proveedorId, unidad, cantidad, fechaServicio, userId }) {
  const col = despachoId ? 'despacho_id' : 'recepcion_id';
  const opId = despachoId || recepcionId;
  if (!opId) return;
  const existente = db.prepare(`SELECT id, estado FROM sg_gastos_directos WHERE ${col}=? AND tipo_gasto=? AND activo=1 AND estado!='anulado'`).get(opId, tipo);
  if (!proveedorId) {
    if (existente && existente.estado === 'pendiente_valorizar') db.prepare("UPDATE sg_gastos_directos SET estado='anulado' WHERE id=?").run(existente.id);
    return;
  }
  if (existente) {
    if (existente.estado === 'pendiente_valorizar') {
      db.prepare("UPDATE sg_gastos_directos SET proveedor_servicio_id=?, unidad=?, cantidad=?, fecha_servicio=? WHERE id=?")
        .run(proveedorId, unidad || null, (cantidad != null ? Number(cantidad) : null), fechaServicio, existente.id);
    }
    return; // ya valorizado → no se re-asigna
  }
  db.prepare(`INSERT INTO sg_gastos_directos
    (tipo_gasto, ${col}, proveedor_servicio_id, unidad, cantidad, estado, fecha_servicio, creado_por)
    VALUES (?,?,?,?,?, 'pendiente_valorizar', ?, ?)`).run(tipo, opId, proveedorId, unidad || null, (cantidad != null ? Number(cantidad) : null), fechaServicio, userId);
}

router.post('/despachos', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    const items = Array.isArray(b.items) ? b.items : [];
    if (!b.cliente_id) return res.status(400).json({ ok: false, error: 'Falta cliente' });
    if (!items.length) return res.status(400).json({ ok: false, error: 'El despacho necesita al menos un item' });

    // Validar disponibilidad por lote (suma de líneas del mismo lote incluida)
    const pedidoLote = {};
    for (const it of items) {
      if (!it.lote_id || !(Number(it.kg_despachados) > 0)) return res.status(400).json({ ok: false, error: 'Cada línea necesita lote y kg' });
      pedidoLote[it.lote_id] = (pedidoLote[it.lote_id] || 0) + Number(it.kg_despachados);
    }
    for (const loteId of Object.keys(pedidoLote)) {
      const lote = db.prepare('SELECT kg_reales, estado FROM sg_lotes WHERE id=? AND activo=1').get(loteId);
      if (!lote) return res.status(400).json({ ok: false, error: 'Lote inexistente: ' + loteId });
      if (lote.estado === 'bajado') return res.status(400).json({ ok: false, error: 'Lote dado de baja: ' + loteId });
      const disp = (lote.kg_reales || 0) - kgDespachados(db, loteId) - kgDecomisado(db, loteId) - kgTransformado(db, loteId);
      if (pedidoLote[loteId] > disp + 0.01) {
        return res.status(400).json({ ok: false, error: `Lote ${loteId}: pedís ${pedidoLote[loteId]}kg pero hay ${disp.toFixed(1)}kg disponibles` });
      }
    }

    const tx = db.transaction(() => {
      const numero = nextNumero(db, 'SG-DESP', 'sg_despachos', 'numero');
      const fleteroId = b.fletero_id ? Number(b.fletero_id) : null;
      const info = db.prepare(`INSERT INTO sg_despachos
        (numero, pedido_id, cliente_id, comercial_id, fecha_despacho, transporte, transportista, chofer, dominio, fletero_id, estado, observaciones, creado_por)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        numero, b.pedido_id || null, b.cliente_id, b.comercial_id || null, val(b.fecha_despacho),
        val(b.transporte), val(b.transportista), val(b.chofer), val(b.dominio), fleteroId,
        val(b.estado) || 'despachado', val(b.observaciones), uid(req));
      const despachoId = info.lastInsertRowid;
      // PARTE B — si se asignó fletero, queda un gasto de flete de salida PENDIENTE de valorizar.
      syncGastoFleteDespacho(db, despachoId, fleteroId, val(b.fecha_despacho), uid(req));
      const ins = db.prepare(`INSERT INTO sg_despacho_items
        (despacho_id, lote_id, producto_id, presentacion_id, cantidad_presentaciones, kg_despachados, precio_por_kg, subtotal, margen_estimado)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      const lotesAfectados = new Set();
      let totalBultos = 0;   // FASE 2 — bultos del despacho (para la carga de la cooperativa)
      for (const it of items) {
        const lote = db.prepare('SELECT producto_id, costo_final, kg_reales FROM sg_lotes WHERE id=?').get(it.lote_id);
        const kg = Number(it.kg_despachados);
        const precio = Number(it.precio_por_kg || 0);
        const subtotal = kg * precio;
        // costo_final del lote es el costo TOTAL → costo/kg sobre kg VIGENTES (kg_reales − decomiso
        // − transformado), así la merma revalúa lo despachado. (mismo cálculo que el front del modal.)
        const kgVig = (lote.kg_reales || 0) - kgDecomisado(db, it.lote_id) - kgTransformado(db, it.lote_id);
        const costoPorKg = kgVig > 0 ? (lote.costo_final || 0) / kgVig : 0;
        const margen = subtotal - kg * costoPorKg;
        const bultos = Number(it.cantidad_presentaciones || 0);
        ins.run(despachoId, it.lote_id, lote.producto_id, it.presentacion_id || null,
          bultos, kg, precio, subtotal, margen);
        totalBultos += bultos;
        lotesAfectados.add(it.lote_id);
      }
      for (const loteId of lotesAfectados) recalcEstadoLote(db, loteId);
      // FASE 2 — si se asignó cooperativa, queda una CARGA DE SALIDA pendiente (cobra por bulto).
      // El despacho es kg-based y no captura bultos por línea → se usa el total de bultos que
      // carga el operador (cooperativa_bultos); como fallback, la suma de presentaciones (si la hubiera).
      const coopId = b.cooperativa_id ? Number(b.cooperativa_id) : null;
      const coopBultos = (b.cooperativa_bultos != null && b.cooperativa_bultos !== '') ? Number(b.cooperativa_bultos) : (totalBultos || null);
      syncGastoCoop(db, { tipo: 'carga_salida', despachoId, proveedorId: coopId, unidad: 'bulto', cantidad: coopBultos, fechaServicio: val(b.fecha_despacho), userId: uid(req) });
      if (b.pedido_id) {
        db.prepare("UPDATE sg_pedidos SET estado='despachado_parcial', modificado_en=datetime('now','localtime') WHERE id=? AND estado IN ('borrador','confirmado')").run(b.pedido_id);
      }
      return despachoId;
    });
    res.json({ ok: true, data: { id: Number(tx()) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.get('/despachos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['d.activo=1'], params = [];
    if (req.query.cliente_id) { where.push('d.cliente_id=?'); params.push(req.query.cliente_id); }
    if (req.query.estado) { where.push('d.estado=?'); params.push(req.query.estado); }
    const rows = db.prepare(`
      SELECT d.*, c.razon_social AS cliente_nombre, p.numero AS pedido_numero,
        f.razon_social AS fletero_nombre,
        (SELECT COALESCE(SUM(subtotal),0) FROM sg_despacho_items WHERE despacho_id=d.id) AS total,
        (SELECT COALESCE(SUM(margen_estimado),0) FROM sg_despacho_items WHERE despacho_id=d.id) AS margen,
        (SELECT COALESCE(SUM(monto),0) FROM sg_gastos_directos WHERE despacho_id=d.id AND tipo_gasto='flete_salida' AND estado='valorizado' AND activo=1) AS flete_salida,
        (SELECT COALESCE(SUM(monto),0) FROM sg_gastos_directos WHERE despacho_id=d.id AND tipo_gasto='carga_salida' AND estado='valorizado' AND activo=1) AS carga_salida
      FROM sg_despachos d
      LEFT JOIN sg_clientes c ON c.id=d.cliente_id
      LEFT JOIN sg_pedidos p ON p.id=d.pedido_id
      LEFT JOIN sg_proveedores f ON f.id=d.fletero_id
      WHERE ${where.join(' AND ')} ORDER BY d.id DESC`).all(...params);
    // PARTE D + FASE 2 — margen NETO = margen de items − costos de venta valorizados (flete de
    // salida + carga de salida de la cooperativa). Son costo de la VENTA, no del lote.
    for (const r of rows) r.margen_neto = (r.margen || 0) - (r.flete_salida || 0) - (r.carga_salida || 0);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/despachos/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const d = db.prepare(`SELECT d.*, c.razon_social AS cliente_nombre, p.numero AS pedido_numero,
        f.razon_social AS fletero_nombre
      FROM sg_despachos d LEFT JOIN sg_clientes c ON c.id=d.cliente_id
      LEFT JOIN sg_pedidos p ON p.id=d.pedido_id
      LEFT JOIN sg_proveedores f ON f.id=d.fletero_id WHERE d.id=?`).get(req.params.id);
    if (!d) return res.status(404).json({ ok: false, error: 'No encontrado' });
    d.items = db.prepare(`SELECT di.*, l.codigo_lote, pr.nombre AS producto_nombre, ps.nombre AS presentacion_nombre
      FROM sg_despacho_items di
      LEFT JOIN sg_lotes l ON l.id=di.lote_id
      LEFT JOIN sg_productos pr ON pr.id=di.producto_id
      LEFT JOIN sg_presentaciones ps ON ps.id=di.presentacion_id WHERE di.despacho_id=?`).all(req.params.id);
    // PARTE D — flete de salida (gasto de servicio) ligado al despacho + margen neto.
    d.flete_salida_estado = db.prepare("SELECT estado, monto FROM sg_gastos_directos WHERE despacho_id=? AND tipo_gasto='flete_salida' AND activo=1 AND estado!='anulado' ORDER BY id DESC LIMIT 1").get(req.params.id) || null;
    d.flete_salida = db.prepare("SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_directos WHERE despacho_id=? AND tipo_gasto='flete_salida' AND estado='valorizado' AND activo=1").get(req.params.id).s;
    d.carga_salida = db.prepare("SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_directos WHERE despacho_id=? AND tipo_gasto='carga_salida' AND estado='valorizado' AND activo=1").get(req.params.id).s;
    d.carga_salida_estado = db.prepare("SELECT estado, monto, unidad, cantidad FROM sg_gastos_directos WHERE despacho_id=? AND tipo_gasto='carga_salida' AND activo=1 AND estado!='anulado' ORDER BY id DESC LIMIT 1").get(req.params.id) || null;
    const margen = db.prepare("SELECT COALESCE(SUM(margen_estimado),0) s FROM sg_despacho_items WHERE despacho_id=?").get(req.params.id).s;
    d.margen = margen; d.margen_neto = margen - (d.flete_salida || 0) - (d.carga_salida || 0);
    res.json({ ok: true, data: d });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Trazabilidad forward (inversa): cliente → items → lotes → recepciones → OCs → proveedores.
router.get('/despachos/:id/trazabilidad', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const d = db.prepare(`SELECT d.*, c.razon_social AS cliente_nombre, c.cuit AS cliente_cuit
      FROM sg_despachos d LEFT JOIN sg_clientes c ON c.id=d.cliente_id WHERE d.id=?`).get(req.params.id);
    if (!d) return res.status(404).json({ ok: false, error: 'No encontrado' });
    const items = db.prepare(`SELECT di.*, l.codigo_lote, l.recepcion_id, l.costo_final, pr.nombre AS producto_nombre
      FROM sg_despacho_items di
      LEFT JOIN sg_lotes l ON l.id=di.lote_id
      LEFT JOIN sg_productos pr ON pr.id=di.producto_id WHERE di.despacho_id=?`).all(req.params.id);
    for (const it of items) {
      const rec = it.recepcion_id ? db.prepare('SELECT id, numero_recepcion, fecha_recepcion, oc_id FROM sg_recepciones WHERE id=?').get(it.recepcion_id) : null;
      const oc = rec ? db.prepare('SELECT id, numero, fecha_oc, tipo_precio, proveedor_id FROM sg_oc WHERE id=?').get(rec.oc_id) : null;
      const prov = oc && oc.proveedor_id ? db.prepare('SELECT razon_social, cuit FROM sg_proveedores WHERE id=?').get(oc.proveedor_id) : null;
      it.recepcion = rec; it.oc = oc; it.proveedor = prov;
    }
    res.json({ ok: true, data: { despacho: d, items } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/despachos/:id/anular', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const d = db.prepare('SELECT id FROM sg_despachos WHERE id=? AND activo=1').get(req.params.id);
    if (!d) return res.status(404).json({ ok: false, error: 'No encontrado o ya anulado' });
    const tx = db.transaction(() => {
      const lotes = db.prepare('SELECT DISTINCT lote_id FROM sg_despacho_items WHERE despacho_id=?').all(req.params.id).map(r => r.lote_id);
      db.prepare("UPDATE sg_despachos SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=? WHERE id=?").run(uid(req), req.params.id);
      for (const loteId of lotes) recalcEstadoLote(db, loteId);
      // PARTE B — anular el gasto de flete PENDIENTE (no toca los ya valorizados: son deuda real).
      db.prepare("UPDATE sg_gastos_directos SET estado='anulado' WHERE despacho_id=? AND tipo_gasto IN ('flete_salida','carga_salida') AND estado='pendiente_valorizar' AND activo=1").run(req.params.id);
    });
    tx();
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ══ MÓDULO GASTOS DIRECTOS (servicio, valorización diferida) — Fase 1: Flete de Salida ══
// Listado de gastos de servicio con datos de la operación (despacho → remito, cliente, kg).
// Filtros: tipo (default flete_salida), estado (pendiente_valorizar/valorizado), proveedor.
router.get('/gastos-servicio', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ["g.activo=1", "g.estado!='anulado'"], params = [];
    // tipo admite lista separada por coma (ej. carga_salida,descarga_ingreso para la cuenta
    // de la cooperativa). Default flete_salida (compat Fase 1).
    const tipos = String(req.query.tipo || 'flete_salida').split(',').map(s => s.trim()).filter(Boolean);
    where.push('g.tipo_gasto IN (' + tipos.map(() => '?').join(',') + ')'); params.push(...tipos);
    if (req.query.estado) { where.push('g.estado=?'); params.push(req.query.estado); }
    if (req.query.proveedor_id) { where.push('g.proveedor_servicio_id=?'); params.push(req.query.proveedor_id); }
    const rows = db.prepare(`
      SELECT g.*, pv.razon_social AS fletero_nombre,
        d.numero AS despacho_numero, d.fecha_despacho, c.razon_social AS cliente_nombre,
        r.numero_recepcion,
        COALESCE(d.numero, r.numero_recepcion) AS operacion_ref,
        COALESCE(d.fecha_despacho, r.fecha_recepcion, g.fecha_servicio) AS operacion_fecha,
        (SELECT COALESCE(SUM(kg_despachados),0) FROM sg_despacho_items WHERE despacho_id=d.id) AS kg,
        uv.nombre AS valorizado_por_nombre
      FROM sg_gastos_directos g
      LEFT JOIN sg_proveedores pv ON pv.id=g.proveedor_servicio_id
      LEFT JOIN sg_despachos d ON d.id=g.despacho_id
      LEFT JOIN sg_clientes c ON c.id=d.cliente_id
      LEFT JOIN sg_recepciones r ON r.id=g.recepcion_id
      LEFT JOIN usuarios uv ON uv.id=g.valorizado_por
      WHERE ${where.join(' AND ')} ORDER BY g.id DESC`).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Valorizar la cuenta de un fletero: asigna monto + fecha + cuenta_ref común a sus gastos
// pendientes. items=[{id, monto}] (el front ya calculó montos, sea a mano o por prorrateo).
router.post('/gastos-servicio/valorizar', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    const items = Array.isArray(b.items) ? b.items : [];
    if (!b.proveedor_servicio_id) return res.status(400).json({ ok: false, error: 'Falta fletero' });
    if (!items.length) return res.status(400).json({ ok: false, error: 'Nada para valorizar' });
    const ref = val(b.cuenta_ref) || db.prepare("SELECT 'SG-VAL-'||strftime('%Y%m%d%H%M%S','now','localtime') r").get().r;
    const fecha = db.prepare("SELECT date('now','localtime') d").get().d;
    const upd = db.prepare(`UPDATE sg_gastos_directos
      SET estado='valorizado', monto=?, fecha_valorizacion=?, valorizado_por=?, cuenta_ref=?
      WHERE id=? AND proveedor_servicio_id=? AND estado='pendiente_valorizar' AND activo=1`);
    const tx = db.transaction(() => {
      let n = 0;
      const recepciones = new Set();   // FASE 2 — recepciones con descarga valorizada → recalcular costo
      for (const it of items) {
        const monto = Number(it.monto);
        if (!(monto >= 0)) throw new Error('Monto inválido en una operación');
        const ch = upd.run(monto, fecha, uid(req), ref, it.id, b.proveedor_servicio_id).changes;
        n += ch;
        if (ch) {
          const g = db.prepare('SELECT tipo_gasto, recepcion_id FROM sg_gastos_directos WHERE id=?').get(it.id);
          if (g && g.tipo_gasto === 'descarga_ingreso' && g.recepcion_id) recepciones.add(g.recepcion_id);
        }
      }
      // DESCARGA (ingreso) → impacta el costo del lote: recalcular los lotes de esas recepciones.
      for (const recId of recepciones) {
        const lotes = db.prepare('SELECT id FROM sg_lotes WHERE recepcion_id=? AND activo=1').all(recId);
        for (const l of lotes) recalcCostoLote(db, l.id);
      }
      return n;
    });
    const n = tx();
    res.json({ ok: true, data: { valorizados: n, cuenta_ref: ref } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── CUENTA CORRIENTE CLIENTES (V1 simple) ──────────────────────────────────────
// total_cobrado queda en 0 en V1 (no hay cobranzas de SG todavía). // TODO V2: cobranzas/DSO.
router.get('/cc-clientes', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT c.id, c.razon_social, c.limite_credito,
        COALESCE(SUM(di.subtotal),0) AS total_facturado,
        0 AS total_cobrado
      FROM sg_clientes c
      JOIN sg_despachos d ON d.cliente_id=c.id AND d.activo=1
      JOIN sg_despacho_items di ON di.despacho_id=d.id
      WHERE c.activo=1
      GROUP BY c.id, c.razon_social, c.limite_credito
      ORDER BY total_facturado DESC`).all();
    for (const r of rows) r.saldo = (r.total_facturado || 0) - (r.total_cobrado || 0);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// FASE 5 — DASHBOARD + REPORTES (solo lectura, depende de F1-F4)
// ════════════════════════════════════════════════════════════════════════════

// Costo por kg de un lote = costo_final / kg VIGENTES (costo_final es TOTAL del lote).
// kg vigentes = kg_reales − Σ decomiso (merma) − Σ transformado (caso 2). El decomiso NO
// baja costo_final → el costo/kg sube (concentración). La transformación SÍ baja costo_final
// (decisión 3) y a la vez el denominador → el costo/kg queda ESTABLE (sin merma, el costo
// viaja con la mercadería al lote-cubeta).
const KG_VIGENTE = "(l.kg_reales - COALESCE((SELECT SUM(kg) FROM sg_lote_decomisos WHERE lote_id=l.id),0) - COALESCE((SELECT SUM(kg_transformados) FROM sg_transformaciones WHERE lote_origen_id=l.id),0))";
const COSTO_KG = `(COALESCE(l.costo_final,0)/NULLIF(${KG_VIGENTE},0))`;
// Margen de una línea de despacho calculado desde el costo por kg (no depende del
// margen_estimado guardado → robusto frente a datos viejos).
const MARGEN_LINEA = `(di.subtotal - di.kg_despachados*${COSTO_KG})`;

// Valida YYYY-MM; default = mes en curso.
function periodoActual(db, q) {
  return /^\d{4}-\d{2}$/.test(q || '') ? q : db.prepare("SELECT strftime('%Y-%m','now','localtime') p").get().p;
}
// Construye filtro de rango sobre una columna de fecha (desde/hasta inclusive).
function rangoFecha(col, q, where, params) {
  if (q.desde) { where.push(`${col}>=?`); params.push(q.desde); }
  if (q.hasta) { where.push(`${col}<=?`); params.push(q.hasta); }
}

// ── DASHBOARD ──────────────────────────────────────────────────────────────────
router.get('/dashboard', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const periodo = periodoActual(db, req.query.periodo);

    // Compras del período (por fecha de ingreso del lote): kg + costo cargado
    const compras = db.prepare(`
      SELECT COALESCE(SUM(kg_reales),0) AS kg, COALESCE(SUM(costo_final),0) AS monto, COUNT(*) AS lotes
      FROM sg_lotes WHERE activo=1 AND transformado_de IS NULL AND substr(fecha_ingreso,1,7)=?`).get(periodo);

    // Ventas del período (por fecha de despacho): kg + facturado + margen (desde costo por kg)
    const ventas = db.prepare(`
      SELECT COALESCE(SUM(di.kg_despachados),0) AS kg,
             COALESCE(SUM(di.subtotal),0) AS monto,
             COALESCE(SUM(${MARGEN_LINEA}),0) AS margen
      FROM sg_despacho_items di
      JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
      JOIN sg_lotes l ON l.id=di.lote_id
      WHERE substr(d.fecha_despacho,1,7)=?`).get(periodo);
    const margen_pct = ventas.monto > 0 ? (ventas.margen / ventas.monto) * 100 : 0;

    // Stock actual por familia (snapshot): kg restantes + valor a costo
    const stock_familia = db.prepare(`
      WITH desp AS (
        SELECT di.lote_id, SUM(di.kg_despachados) kg
        FROM sg_despacho_items di JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
        GROUP BY di.lote_id)
      SELECT pr.familia AS familia,
        COALESCE(SUM(l.kg_reales - COALESCE(de.kg,0) - ${SUM_TRANSF}),0) AS kg,
        COALESCE(SUM((l.kg_reales - COALESCE(de.kg,0) - ${SUM_TRANSF})*${COSTO_KG}),0) AS valor
      FROM sg_lotes l
      JOIN sg_productos pr ON pr.id=l.producto_id
      LEFT JOIN desp de ON de.lote_id=l.id
      WHERE l.activo=1 AND l.estado NOT IN ('bajado','despachado_total')
        AND (l.kg_reales - COALESCE(de.kg,0) - ${SUM_TRANSF}) > 0.01
      GROUP BY pr.familia ORDER BY valor DESC`).all();

    // Lotes próximos a vencer (≤5 días, incluye vencidos) con stock disponible
    const por_vencer = db.prepare(`
      WITH desp AS (
        SELECT di.lote_id, SUM(di.kg_despachados) kg
        FROM sg_despacho_items di JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
        GROUP BY di.lote_id)
      SELECT l.id, l.codigo_lote, pr.nombre AS producto_nombre, l.calidad,
        (l.kg_reales - COALESCE(de.kg,0) - ${SUM_TRANSF}) AS kg_disponibles,
        l.fecha_vencimiento_estimada,
        CAST(julianday(l.fecha_vencimiento_estimada)-julianday(date('now','localtime')) AS INTEGER) AS dias_restantes
      FROM sg_lotes l
      JOIN sg_productos pr ON pr.id=l.producto_id
      LEFT JOIN desp de ON de.lote_id=l.id
      WHERE l.activo=1 AND l.estado NOT IN ('bajado','despachado_total')
        AND l.fecha_vencimiento_estimada IS NOT NULL
        AND julianday(l.fecha_vencimiento_estimada)-julianday(date('now','localtime')) <= 5
        AND (l.kg_reales - COALESCE(de.kg,0) - ${SUM_TRANSF}) > 0.01
      ORDER BY l.fecha_vencimiento_estimada ASC LIMIT 20`).all();

    // Top 5 productos por margen del período
    const top_productos = db.prepare(`
      SELECT pr.nombre AS producto,
        COALESCE(SUM(di.kg_despachados),0) AS kg,
        COALESCE(SUM(di.subtotal),0) AS venta,
        COALESCE(SUM(${MARGEN_LINEA}),0) AS margen
      FROM sg_despacho_items di
      JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
      JOIN sg_lotes l ON l.id=di.lote_id
      JOIN sg_productos pr ON pr.id=di.producto_id
      WHERE substr(d.fecha_despacho,1,7)=?
      GROUP BY pr.id, pr.nombre ORDER BY margen DESC LIMIT 5`).all(periodo);

    // Top 5 clientes por venta del período
    const top_clientes = db.prepare(`
      SELECT c.razon_social AS cliente,
        COALESCE(SUM(di.subtotal),0) AS venta,
        COALESCE(SUM(${MARGEN_LINEA}),0) AS margen
      FROM sg_despacho_items di
      JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
      JOIN sg_lotes l ON l.id=di.lote_id
      JOIN sg_clientes c ON c.id=d.cliente_id
      WHERE substr(d.fecha_despacho,1,7)=?
      GROUP BY c.id, c.razon_social ORDER BY venta DESC LIMIT 5`).all(periodo);

    res.json({ ok: true, data: {
      periodo,
      compras, ventas, margen_pct,
      stock_familia, por_vencer, top_productos, top_clientes
    } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── REPORTE: Compras por proveedor ──────────────────────────────────────────────
// Por fecha de ingreso del lote. Lotes finca_propia (sin recepción) quedan fuera (stub V1).
router.get('/reportes/compras-proveedor', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['l.activo=1'], params = [];
    rangoFecha('l.fecha_ingreso', req.query, where, params);
    const rows = db.prepare(`
      SELECT pv.id AS proveedor_id, COALESCE(pv.razon_social,'(sin proveedor)') AS proveedor,
        COUNT(DISTINCT o.id) AS ocs, COUNT(l.id) AS lotes,
        COALESCE(SUM(l.kg_reales),0) AS kg, COALESCE(SUM(l.costo_final),0) AS monto
      FROM sg_lotes l
      JOIN sg_recepciones r ON r.id=l.recepcion_id
      JOIN sg_oc o ON o.id=r.oc_id
      LEFT JOIN sg_proveedores pv ON pv.id=o.proveedor_id
      WHERE ${where.join(' AND ')}
      GROUP BY pv.id, pv.razon_social ORDER BY monto DESC`).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── REPORTE: Ventas por cliente ─────────────────────────────────────────────────
router.get('/reportes/ventas-cliente', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['d.activo=1'], params = [];
    rangoFecha('d.fecha_despacho', req.query, where, params);
    const rows = db.prepare(`
      SELECT c.id AS cliente_id, COALESCE(c.razon_social,'(sin cliente)') AS cliente,
        COUNT(DISTINCT d.id) AS despachos,
        COALESCE(SUM(di.kg_despachados),0) AS kg,
        COALESCE(SUM(di.subtotal),0) AS venta,
        COALESCE(SUM(${MARGEN_LINEA}),0) AS margen
      FROM sg_despacho_items di
      JOIN sg_despachos d ON d.id=di.despacho_id
      JOIN sg_lotes l ON l.id=di.lote_id
      LEFT JOIN sg_clientes c ON c.id=d.cliente_id
      WHERE ${where.join(' AND ')}
      GROUP BY c.id, c.razon_social ORDER BY venta DESC`).all(...params);
    for (const r of rows) r.margen_pct = r.venta > 0 ? (r.margen / r.venta) * 100 : 0;
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── REPORTE: Margen por producto ────────────────────────────────────────────────
router.get('/reportes/margen-producto', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['d.activo=1'], params = [];
    rangoFecha('d.fecha_despacho', req.query, where, params);
    const rows = db.prepare(`
      SELECT pr.id AS producto_id, pr.nombre AS producto, pr.familia AS familia,
        COALESCE(SUM(di.kg_despachados),0) AS kg,
        COALESCE(SUM(di.subtotal),0) AS venta,
        COALESCE(SUM(di.kg_despachados*${COSTO_KG}),0) AS costo,
        COALESCE(SUM(${MARGEN_LINEA}),0) AS margen
      FROM sg_despacho_items di
      JOIN sg_despachos d ON d.id=di.despacho_id
      JOIN sg_lotes l ON l.id=di.lote_id
      JOIN sg_productos pr ON pr.id=di.producto_id
      WHERE ${where.join(' AND ')}
      GROUP BY pr.id, pr.nombre, pr.familia ORDER BY margen DESC`).all(...params);
    for (const r of rows) r.margen_pct = r.venta > 0 ? (r.margen / r.venta) * 100 : 0;
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── REPORTE: Merma por destino ──────────────────────────────────────────────────
// Lotes dados de baja, agrupados por destino. Fecha de baja ≈ modificado_en (no hay
// columna propia de baja en V1). Valor a costo = kg_reales × costo por kg = costo_final.
router.get('/reportes/merma-destino', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ["l.activo=1", "l.estado='bajado'"], params = [];
    rangoFecha("date(l.modificado_en)", req.query, where, params);
    const rows = db.prepare(`
      SELECT COALESCE(l.destino_baja,'(sin destino)') AS destino,
        COUNT(*) AS lotes,
        COALESCE(SUM(l.kg_reales),0) AS kg,
        COALESCE(SUM(l.costo_final),0) AS valor_costo
      FROM sg_lotes l
      WHERE ${where.join(' AND ')}
      GROUP BY l.destino_baja ORDER BY valor_costo DESC`).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// F0 — RENTABILIDAD PUNTA A PUNTA (read-only, sin tocar el modelo)
// Lee SOLO datos que ya existen hoy: costo_final del lote (= costo_base + gastos
// directos + prorrateo global) vs lo vendido, con margen DINÁMICO (decisión #1:
// nunca se lee el margen congelado, siempre se recalcula desde costo_final/kg_reales).
// Pendiente de F1+ (NO incluido acá): gastos de salida, M:N gasto↔partida,
// prorrateo manual, cierre de partida. El margen es BRUTO mientras falten esos.
// ════════════════════════════════════════════════════════════════════════════

// ── REPORTE F0: Rentabilidad × PARTIDA (cada sg_lotes = una partida) ─────────────
router.get('/reportes/rentabilidad-partida', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['l.activo=1'], params = [];
    rangoFecha('l.fecha_ingreso', req.query, where, params);
    const rows = db.prepare(`
      WITH desp AS (
        SELECT di.lote_id, SUM(di.kg_despachados) kg, SUM(di.subtotal) venta
        FROM sg_despacho_items di JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
        GROUP BY di.lote_id)
      SELECT l.id, l.codigo_lote, pr.nombre AS producto, pr.familia, l.estado,
        COALESCE(pv.razon_social, CASE WHEN l.recepcion_id IS NULL THEN '(finca propia)' ELSE '(sin proveedor)' END) AS proveedor,
        l.fecha_ingreso, l.kg_reales,
        COALESCE(de.kg,0) AS kg_vendidos,
        COALESCE(l.costo_final,0) AS costo_total,
        COALESCE(de.venta,0) AS venta,
        (COALESCE(de.kg,0) * (COALESCE(l.costo_final,0)/NULLIF(l.kg_reales,0))) AS costo_vendido,
        (COALESCE(de.venta,0) - COALESCE(de.kg,0)*(COALESCE(l.costo_final,0)/NULLIF(l.kg_reales,0))) AS margen,
        CASE WHEN l.precio_unitario_kg IS NULL THEN 1 ELSE 0 END AS costo_incompleto
      FROM sg_lotes l
      JOIN sg_productos pr ON pr.id=l.producto_id
      LEFT JOIN sg_recepciones r ON r.id=l.recepcion_id
      LEFT JOIN sg_oc o ON o.id=r.oc_id
      LEFT JOIN sg_proveedores pv ON pv.id=o.proveedor_id
      LEFT JOIN desp de ON de.lote_id=l.id
      WHERE ${where.join(' AND ')}
      ORDER BY l.fecha_ingreso DESC, l.codigo_lote`).all(...params);
    for (const r of rows) r.margen_pct = r.venta > 0 ? (r.margen / r.venta) * 100 : 0;
    // Fila TOTAL (agregado) — se marca con _total para que el front la pinte distinta.
    if (rows.length) {
      const t = rows.reduce((a, r) => ({
        kg_reales: a.kg_reales + (r.kg_reales || 0), kg_vendidos: a.kg_vendidos + (r.kg_vendidos || 0),
        costo_total: a.costo_total + (r.costo_total || 0), venta: a.venta + (r.venta || 0),
        costo_vendido: a.costo_vendido + (r.costo_vendido || 0), margen: a.margen + (r.margen || 0)
      }), { kg_reales: 0, kg_vendidos: 0, costo_total: 0, venta: 0, costo_vendido: 0, margen: 0 });
      t._total = 1; t.codigo_lote = 'TOTAL'; t.margen_pct = t.venta > 0 ? (t.margen / t.venta) * 100 : 0;
      rows.push(t);
    }
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── REPORTE F0: Rentabilidad × VENTA (cada sg_despachos = una venta) ─────────────
router.get('/reportes/rentabilidad-venta', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['d.activo=1'], params = [];
    rangoFecha('d.fecha_despacho', req.query, where, params);
    const rows = db.prepare(`
      SELECT d.id, d.numero, d.fecha_despacho,
        COALESCE(c.razon_social,'(sin cliente)') AS cliente,
        COALESCE(SUM(di.kg_despachados),0) AS kg,
        COALESCE(SUM(di.subtotal),0) AS venta,
        COALESCE(SUM(di.kg_despachados*${COSTO_KG}),0) AS costo,
        COALESCE(SUM(${MARGEN_LINEA}),0) AS margen
      FROM sg_despacho_items di
      JOIN sg_despachos d ON d.id=di.despacho_id
      JOIN sg_lotes l ON l.id=di.lote_id
      LEFT JOIN sg_clientes c ON c.id=d.cliente_id
      WHERE ${where.join(' AND ')}
      GROUP BY d.id, d.numero, d.fecha_despacho, c.razon_social
      ORDER BY d.fecha_despacho DESC, d.numero`).all(...params);
    for (const r of rows) r.margen_pct = r.venta > 0 ? (r.margen / r.venta) * 100 : 0;
    if (rows.length) {
      const t = rows.reduce((a, r) => ({
        kg: a.kg + (r.kg || 0), venta: a.venta + (r.venta || 0),
        costo: a.costo + (r.costo || 0), margen: a.margen + (r.margen || 0)
      }), { kg: 0, venta: 0, costo: 0, margen: 0 });
      t._total = 1; t.numero = 'TOTAL'; t.cliente = ''; t.margen_pct = t.venta > 0 ? (t.margen / t.venta) * 100 : 0;
      rows.push(t);
    }
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
