// src/rutas/sg.js
// ── API SAN GERÓNIMO — PUENTE CORDON SA ───────────────────────────────────────
// Operatoria mayorista frutihortícola. Universo sg_* independiente.
// Fase 1: catálogo (productos, presentaciones, proveedores, clientes,
// condiciones de pago + cuotas). Compras/Stock/Ventas/Reportes en fases siguientes.

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';
import { subirArchivo, obtenerArchivo, storageConfigurado } from '../servicios/storage.js';
import { getDb } from '../servicios/db.js';
import '../servicios/db_sg.js'; // corre el DDL sg_* al importarse
// Las condiciones de pago que se usan de verdad, y el código de trazabilidad
// de las órdenes que se cargaron antes de que existiera.
import '../servicios/sg_oc_condiciones_y_traza.js';
import { detectarDuplicado } from '../servicios/dedup.js';
// El model ID sale SIEMPRE de config/ia.js: es la fuente única del repo.
import { MODELO_CHAT } from '../config/ia.js';
import { generarOcPDF } from '../servicios/ocPDF.js';
import { generarRecepcionCalidadPDF } from '../servicios/recepcionCalidadPDF.js';
import { autenticar as afipAutenticar, ambienteActual as afipAmbiente } from '../servicios/afip-wsaa.js';
import { feDummy as afipFeDummy, ultimoComprobante as afipUltimoCbte, tiposCbte as afipTiposCbte, tiposIva as afipTiposIva, ptosVenta as afipPtosVenta, condicionesIvaReceptor as afipCondIva } from '../servicios/afip-wsfe.js';
import { emitir as afipEmitir } from '../servicios/afip-wsfe-emision.js';
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
// EXPORT XLSX — una fila por producto para limpiar el catálogo fuera del sistema (read-only).
// Ruta LITERAL: va ANTES de /productos/:id para no ser capturada por el handler con :id. Patrón
// de generación server-side espejado de sg_ventas.js /facturas/export.xlsx (lib xlsx). Las columnas
// de conteo (presentaciones, envases usados, lotes, OC, despachos) sirven para detectar duplicados
// (mismo nombre+variedad) y productos con el envase metido en el nombre/variedad.
router.get('/productos/export.xlsx', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const prods = db.prepare(`
      SELECT p.id, p.codigo, p.nombre, p.variedad, p.familia, p.unidad_base, p.activo,
             es.nombre AS especie,
             (SELECT COUNT(*) FROM sg_presentaciones ps WHERE ps.producto_id=p.id AND ps.activo=1) AS presentaciones_count,
             (SELECT GROUP_CONCAT(DISTINCT e.nombre) FROM sg_presentaciones ps
                JOIN sg_envases e ON e.id=ps.envase_id WHERE ps.producto_id=p.id AND ps.activo=1) AS envases_usados,
             (SELECT COUNT(*) FROM sg_lotes l WHERE l.producto_id=p.id AND l.activo=1) AS lotes_count,
             (SELECT COUNT(*) FROM sg_oc_items oi WHERE oi.producto_id=p.id) AS oc_count,
             (SELECT COUNT(*) FROM sg_despacho_items di WHERE di.producto_id=p.id) AS despachos_count
      FROM sg_productos p
      LEFT JOIN sg_especies es ON es.id=p.especie_id
      WHERE p.activo=1 OR ?=1
      ORDER BY p.nombre COLLATE NOCASE, p.variedad COLLATE NOCASE`).all(req.query.todos === '1' ? 1 : 0);
    const header = ['id','codigo','nombre','variedad','especie','familia','unidad_base',
      'presentaciones_count','envases_usados','lotes_count','oc_count','despachos_count','activo'];
    const filas = prods.map(p => ({
      id: p.id, codigo: p.codigo || '', nombre: p.nombre || '', variedad: p.variedad || '',
      especie: p.especie || '', familia: p.familia || '', unidad_base: p.unidad_base || '',
      presentaciones_count: p.presentaciones_count || 0, envases_usados: p.envases_usados || '',
      lotes_count: p.lotes_count || 0, oc_count: p.oc_count || 0, despachos_count: p.despachos_count || 0,
      activo: p.activo ? 1 : 0
    }));
    const ws = XLSX.utils.json_to_sheet(filas, { header });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Productos');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="productos-sg.xlsx"'
    });
    res.send(buf);
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

// ── TEMPORAL (A REMOVER) — counts del maestro de artículos ─────────────────────────
// Relevamiento del patrón real (productos/presentaciones/envases) para evaluar
// simplificación del maestro. No hay consola SQL web → se lee por navegador y se
// saca en el mismo PR. Admin-only. BORRAR junto con su registro tras leer.
router.get('/_tmp_counts_articulos', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const scalar = (sql) => db.prepare(sql).get().n;
    // Presentaciones por producto (solo productos vivos, presentaciones activas).
    const porProducto = db.prepare(`
      SELECT p.id, COUNT(pr.id) AS n
      FROM sg_productos p
      LEFT JOIN sg_presentaciones pr ON pr.producto_id = p.id AND pr.activo = 1
      WHERE p.eliminado_en IS NULL
      GROUP BY p.id`).all();
    const conPres = porProducto.filter(r => r.n >= 1);
    const promedio = conPres.length
      ? +(conPres.reduce((a, r) => a + r.n, 0) / conPres.length).toFixed(2)
      : 0;

    res.json({
      ok: true,
      data: {
        total_productos:              scalar('SELECT COUNT(*) n FROM sg_productos WHERE eliminado_en IS NULL'),
        total_presentaciones:         scalar('SELECT COUNT(*) n FROM sg_presentaciones WHERE activo=1'),
        total_envases:                scalar('SELECT COUNT(*) n FROM sg_envases WHERE activo=1'),
        productos_sin_presentacion:   porProducto.filter(r => r.n === 0).length,
        productos_1_presentacion:     porProducto.filter(r => r.n === 1).length,
        productos_2mas_presentaciones: porProducto.filter(r => r.n >= 2).length,
        promedio_pres_por_producto:   promedio,
        distribucion_factor: db.prepare(`
          SELECT factor_conversion AS factor, COUNT(*) AS cantidad
          FROM sg_presentaciones WHERE activo=1
          GROUP BY factor_conversion ORDER BY cantidad DESC`).all(),
        distribucion_unidad_base: db.prepare(`
          SELECT unidad_base, COUNT(*) AS cantidad
          FROM sg_productos WHERE eliminado_en IS NULL
          GROUP BY unidad_base ORDER BY cantidad DESC`).all(),
        uso_envase: {
          con_envase: scalar('SELECT COUNT(*) n FROM sg_presentaciones WHERE activo=1 AND envase_id IS NOT NULL'),
          sin_envase: scalar('SELECT COUNT(*) n FROM sg_presentaciones WHERE activo=1 AND envase_id IS NULL')
        },
        uso_paletizado: scalar('SELECT COUNT(*) n FROM sg_presentaciones WHERE activo=1 AND paletizado=1')
      }
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
   'telefono', 'email', 'observaciones', 'adm_proveedor_id', 'es_servicio', 'saldo_inicial'],   // es_servicio: 1 = fletero/cooperativa · saldo_inicial: apertura al corte (BRIEF 10)
  { orderBy: 'razon_social COLLATE NOCASE',
    // nombre de la categoría comercial (categoria_id → sg_proveedor_categorias). La usa el front
    // para filtrar el selector de la OC de mercadería (solo Mercaderia Nacional/Importada).
    selectExtra: '(SELECT nombre FROM sg_proveedor_categorias WHERE id = sg_proveedores.categoria_id) AS categoria_nombre' });

// Fleteros / proveedores de servicio (es_servicio=1). Alimenta el selector del despacho y
// el filtro del módulo Gastos Directos.
router.get('/proveedores-servicio', requireAuth, (req, res) => {
  const db = getDb();
  try {
    res.json({ ok: true, data: db.prepare("SELECT * FROM sg_proveedores WHERE activo=1 AND es_servicio=1 ORDER BY razon_social COLLATE NOCASE").all() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── CONFIG SG (clave/valor) — BRIEF 10: fecha_corte del corte operativo (apertura) ──
function getConfig(db, clave, def) {
  const r = db.prepare('SELECT valor FROM sg_config WHERE clave=?').get(clave);
  return (r && r.valor != null) ? r.valor : def;
}
router.get('/config', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare('SELECT clave, valor FROM sg_config').all();
    const cfg = {}; for (const r of rows) cfg[r.clave] = r.valor;
    if (cfg.fecha_corte == null) cfg.fecha_corte = '2026-06-30';
    res.json({ ok: true, data: cfg });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/config', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const up = db.prepare(`INSERT INTO sg_config (clave, valor, modificado_en, modificado_por)
      VALUES (?,?,datetime('now','localtime'),?)
      ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor, modificado_en=excluded.modificado_en, modificado_por=excluded.modificado_por`);
    for (const k of Object.keys(b)) up.run(k, b[k] == null ? null : String(b[k]), uid(req));
    res.json({ ok: true, data: { actualizadas: Object.keys(b) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── AFIP/ARCA Paso 1 — prueba de AUTENTICACIÓN (WSAA). NO emite comprobantes ──────
// Dispara el login contra WSAA (homologación) y confirma que cert + firma CMS + conectividad
// andan. NO devuelve el token/sign (sensibles): solo hasta cuándo es válido. requireAdmin.
router.get('/afip/test-auth', requireAdmin, async (req, res) => {
  try {
    const ta = await afipAutenticar('wsfe');
    res.json({ ok: true, ambiente: afipAmbiente(), cacheado: !!ta.cacheado, token_valido_hasta: ta.expira || null });
  } catch (e) {
    res.status(502).json({ ok: false, ambiente: afipAmbiente(), error: e.message });
  }
});

// ── AFIP/ARCA Paso 2 — WSFE en modo LECTURA (consulta, NO emite) ──────────────────
// FEDummy: ping de salud del WSFE (appserver/dbserver/authserver).
router.get('/afip/test-wsfe', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, ambiente: afipAmbiente(), servicio: await afipFeDummy() });
  } catch (e) { res.status(502).json({ ok: false, ambiente: afipAmbiente(), error: e.message }); }
});

// Último comprobante autorizado por punto de venta + tipo (ej. pv=7&tipo=6 → Factura B).
router.get('/afip/ultimo-comprobante', requireAdmin, async (req, res) => {
  try {
    const pv = Number(req.query.pv), tipo = Number(req.query.tipo);
    if (!(pv > 0) || !(tipo > 0)) return res.status(400).json({ ok: false, error: 'Faltan pv y tipo (> 0)' });
    res.json({ ok: true, ambiente: afipAmbiente(), data: await afipUltimoCbte(pv, tipo) });
  } catch (e) { res.status(502).json({ ok: false, ambiente: afipAmbiente(), error: e.message }); }
});

// Parámetros de AFIP (para validar contra lo esperado): tipos de cbte, alícuotas IVA, PVs.
router.get('/afip/parametros', requireAdmin, async (req, res) => {
  try {
    const [tipos_cbte, tipos_iva, ptos_venta] = await Promise.all([afipTiposCbte(), afipTiposIva(), afipPtosVenta()]);
    res.json({ ok: true, ambiente: afipAmbiente(), tipos_cbte, tipos_iva, ptos_venta });
  } catch (e) { res.status(502).json({ ok: false, ambiente: afipAmbiente(), error: e.message }); }
});

// Condiciones IVA del receptor (RG 5616) — para verificar los IDs contra AFIP en vivo.
router.get('/afip/condiciones-iva', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, ambiente: afipAmbiente(), condiciones: await afipCondIva() });
  } catch (e) { res.status(502).json({ ok: false, ambiente: afipAmbiente(), error: e.message }); }
});

// ── AFIP/ARCA Paso 3 — EMISIÓN de prueba (FECAESolicitar). Homologación, PV 7. ──────
// Arma el comprobante desde cliente_id + items, emite contra homologación y devuelve el CAE
// (o el rechazo/obs). Persiste en sg_ven_facturas con las columnas fiscales (ambiente=homologacion).
router.post('/afip/emitir-test', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const pv = Number(b.pv);
    if (!(pv > 0)) return res.status(400).json({ ok: false, error: 'Falta pv (> 0)' });
    if (!b.cliente_id) return res.status(400).json({ ok: false, error: 'Falta cliente_id' });
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: 'Sin items' });
    const r = await afipEmitir(getDb(), { ptoVta: pv, clienteId: Number(b.cliente_id), items, userId: uid(req) });
    res.status(r.ok ? 200 : 200).json(r);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ── FACTURACIÓN (puente despacho → factura) ───────────────────────────────────────
// kg ya facturados de un despacho_item = Σ kg de sg_factura_despachos cuyas facturas están
// reservadas o autorizadas (las rechazadas no cuentan → ese kg sigue pendiente).
function kgFacturadoItem(db, despachoItemId) {
  return db.prepare(`SELECT COALESCE(SUM(fd.kg),0) s FROM sg_factura_despachos fd
    JOIN sg_ven_facturas f ON f.id=fd.factura_id
    WHERE fd.despacho_item_id=? AND f.afip_estado IN ('reservado','autorizado')`).get(despachoItemId).s;
}
// GET /facturable?cliente_id=X → despachos pendientes/parciales del cliente (solo kg_pendiente > 0).
router.get('/facturable', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const clienteId = Number(req.query.cliente_id);
    if (!(clienteId > 0)) return res.status(400).json({ ok: false, error: 'Falta cliente_id' });
    const cliente = db.prepare('SELECT id, razon_social, cuit FROM sg_clientes WHERE id=?').get(clienteId);
    if (!cliente) return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });
    const cuit = String(cliente.cuit || '').replace(/\D/g, '');
    const tipo_cbte_sugerido = (/^\d{11}$/.test(cuit) && !/^0+$/.test(cuit)) ? 1 : 6; // con CUIT→A, sin→B
    const rows = db.prepare(`
      SELECT d.id AS despacho_id, d.numero AS despacho_numero, d.fecha_despacho,
        di.id AS despacho_item_id, di.producto_id, pr.nombre AS producto_nombre,
        fam.iva_alicuota, di.lote_id, l.codigo_lote, di.kg_despachados, di.precio_por_kg
      FROM sg_despachos d
      JOIN sg_despacho_items di ON di.despacho_id=d.id
      LEFT JOIN sg_productos pr ON pr.id=di.producto_id
      LEFT JOIN sg_familias fam ON fam.id=pr.familia_id
      LEFT JOIN sg_lotes l ON l.id=di.lote_id
      WHERE d.activo=1 AND d.cliente_id=? AND d.estado<>'rechazado_total'
      ORDER BY d.fecha_despacho DESC, d.id, di.id`).all(clienteId);
    const mapa = new Map();
    for (const r of rows) {
      const kgFact = kgFacturadoItem(db, r.despacho_item_id);
      const kgDesp = Number(r.kg_despachados) || 0;
      const kgPend = +(kgDesp - kgFact).toFixed(2);
      if (!mapa.has(r.despacho_id)) mapa.set(r.despacho_id, { despacho_id: r.despacho_id, numero: r.despacho_numero, fecha: r.fecha_despacho, _desp: 0, _fact: 0, items: [] });
      const g = mapa.get(r.despacho_id);
      g._desp += kgDesp; g._fact += kgFact;
      if (kgPend > 0.01) {
        g.items.push({
          despacho_item_id: r.despacho_item_id, producto_id: r.producto_id, producto: r.producto_nombre || '',
          lote_id: r.lote_id, lote: r.codigo_lote || '', kg_despachado: kgDesp, kg_facturado: +kgFact.toFixed(2),
          kg_pendiente: kgPend, precio_por_kg: Number(r.precio_por_kg) || 0,
          alicuota: r.iva_alicuota != null ? Number(r.iva_alicuota) : null, exento: r.iva_alicuota == null
        });
      }
    }
    const despachos = [];
    for (const g of mapa.values()) {
      if (!g.items.length) continue;   // todo facturado → fuera de la lista
      despachos.push({ despacho_id: g.despacho_id, numero: g.numero, fecha: g.fecha, estado_facturacion: g._fact <= 0.01 ? 'pendiente' : 'parcial', items: g.items });
    }
    res.json({ ok: true, cliente: { id: cliente.id, razon_social: cliente.razon_social, cuit: cliente.cuit }, tipo_cbte_sugerido, despachos });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /despachos-pendientes → MISMA lógica de kg_pendiente que /facturable pero para TODOS los
// clientes (listado "Pendientes de comprobante"). Filtros opcionales: cliente_id, desde, hasta
// (fecha_despacho). Devuelve por despacho: alias/cliente, qué se vendió (producto + kg pend),
// total neto pendiente y estado (pendiente/parcial). Solo despachos con algún kg pendiente.
router.get('/despachos-pendientes', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['d.activo=1', "d.estado<>'rechazado_total'"], params = [];
    if (req.query.cliente_id) { where.push('d.cliente_id=?'); params.push(Number(req.query.cliente_id)); }
    if (req.query.desde)      { where.push('d.fecha_despacho>=?'); params.push(String(req.query.desde)); }
    if (req.query.hasta)      { where.push('d.fecha_despacho<=?'); params.push(String(req.query.hasta)); }
    const rows = db.prepare(`
      SELECT d.id AS despacho_id, d.numero AS despacho_numero, d.fecha_despacho, d.cliente_id,
        c.razon_social, c.nombre_comercial,
        di.id AS despacho_item_id, pr.nombre AS producto_nombre,
        di.kg_despachados, di.precio_por_kg
      FROM sg_despachos d
      JOIN sg_despacho_items di ON di.despacho_id=d.id
      LEFT JOIN sg_clientes c ON c.id=d.cliente_id
      LEFT JOIN sg_productos pr ON pr.id=di.producto_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.fecha_despacho DESC, d.id, di.id`).all(...params);
    const mapa = new Map();
    for (const r of rows) {
      const kgFact = kgFacturadoItem(db, r.despacho_item_id);
      const kgDesp = Number(r.kg_despachados) || 0;
      const kgPend = +(kgDesp - kgFact).toFixed(2);
      if (!mapa.has(r.despacho_id)) mapa.set(r.despacho_id, {
        despacho_id: r.despacho_id, numero: r.despacho_numero, fecha: r.fecha_despacho,
        cliente_id: r.cliente_id, razon_social: r.razon_social || '', alias: r.nombre_comercial || '',
        _fact: 0, total_pendiente: 0, items: [] });
      const g = mapa.get(r.despacho_id);
      g._fact += kgFact;
      if (kgPend > 0.01) {
        g.items.push({ producto: r.producto_nombre || '', kg_pendiente: kgPend });
        g.total_pendiente += kgPend * (Number(r.precio_por_kg) || 0);
      }
    }
    const despachos = [];
    for (const g of mapa.values()) {
      if (!g.items.length) continue;
      despachos.push({
        despacho_id: g.despacho_id, numero: g.numero, fecha: g.fecha, cliente_id: g.cliente_id,
        razon_social: g.razon_social, alias: g.alias,
        estado_facturacion: g._fact <= 0.01 ? 'pendiente' : 'parcial',
        total_pendiente: +g.total_pendiente.toFixed(2), items: g.items });
    }
    res.json({ ok: true, despachos });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /facturas/emitir → orquesta la emisión desde despachos seleccionados. Convierte el precio a
// NETO (si incluye IVA) y llama al motor con vinculos atómicos (E1). NO toca la facturación interna.
router.post('/facturas/emitir', requireAdmin, async (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const clienteId = Number(b.cliente_id), pv = Number(b.punto_venta);
    if (!(clienteId > 0)) return res.status(400).json({ ok: false, error: 'Falta cliente_id' });
    if (!(pv > 0)) return res.status(400).json({ ok: false, error: 'Falta punto_venta' });
    const seleccion = Array.isArray(b.seleccion) ? b.seleccion : [];
    if (!seleccion.length) return res.status(400).json({ ok: false, error: 'Sin selección de despachos' });
    const facturaIncluyeIva = b.precio_incluye_iva === true;
    const items = [], vinculos = [];
    for (const sel of seleccion) {
      const despachoId = Number(sel.despacho_id);
      const desp = db.prepare('SELECT id, cliente_id, activo FROM sg_despachos WHERE id=?').get(despachoId);
      if (!desp || !desp.activo) return res.status(400).json({ ok: false, error: 'Despacho inválido: ' + despachoId });
      if (Number(desp.cliente_id) !== clienteId) return res.status(400).json({ ok: false, error: 'El despacho ' + despachoId + ' no es del cliente seleccionado' });
      for (const it of (Array.isArray(sel.items) ? sel.items : [])) {
        const diId = Number(it.despacho_item_id), kg = Number(it.kg);
        if (!(kg > 0)) continue;
        const di = db.prepare(`SELECT di.id, di.producto_id, di.kg_despachados, di.precio_por_kg, di.presentacion_id,
            COALESCE(di.kg_por_bulto, ps.factor_conversion) AS kg_por_bulto, fam.iva_alicuota
          FROM sg_despacho_items di
          LEFT JOIN sg_productos pr ON pr.id=di.producto_id
          LEFT JOIN sg_familias fam ON fam.id=pr.familia_id
          LEFT JOIN sg_presentaciones ps ON ps.id=di.presentacion_id
          WHERE di.id=? AND di.despacho_id=?`).get(diId, despachoId);
        if (!di) return res.status(400).json({ ok: false, error: 'Ítem de despacho inválido: ' + diId });
        const kgPend = (Number(di.kg_despachados) || 0) - kgFacturadoItem(db, diId);
        if (kg > kgPend + 0.01) return res.status(400).json({ ok: false, error: `Ítem ${diId}: pedís ${kg}kg pero quedan ${kgPend.toFixed(2)}kg pendientes` });
        const alic = di.iva_alicuota != null ? Number(di.iva_alicuota) : null;
        const incluyeIva = (it.incluye_iva != null) ? (it.incluye_iva === true) : facturaIncluyeIva;
        const precioBruto = Number(di.precio_por_kg) || 0;
        const precioNeto = (incluyeIva && alic != null) ? +(precioBruto / (1 + alic / 100)).toFixed(4) : precioBruto; // al motor SIEMPRE neto
        // F5 — metadata de presentación por bulto (cajón), SOLO para el detalle local + PDF. cantidad
        // (kg) y precio (precio_kg neto) NO cambian → el payload e importes a AFIP son idénticos a hoy.
        const kpb = (di.kg_por_bulto != null && Number(di.kg_por_bulto) > 0) ? Number(di.kg_por_bulto) : null;
        const bultosLinea = kpb != null ? +(kg / kpb).toFixed(4) : null;          // bultos facturados (display)
        const precioPorBulto = kpb != null ? +(precioNeto * kpb).toFixed(4) : null; // = precio_kg neto × kg_por_bulto
        items.push({ producto_id: Number(di.producto_id), cantidad: kg, precio: precioNeto,
          bultos: bultosLinea, kg_por_bulto: kpb, precio_por_bulto: precioPorBulto, unidad: kpb != null ? 'cajón' : null });
        vinculos.push({ despacho_id: despachoId, despacho_item_id: diId, kg });
      }
    }
    if (!items.length) return res.status(400).json({ ok: false, error: 'No hay líneas válidas para facturar' });
    const r = await afipEmitir(db, { ptoVta: pv, clienteId, items, esNC: b.es_nc === true, userId: uid(req), vinculos });
    if (r.ok) r.pdf_url = '/api/sg/ventas/facturas/' + r.factura_id + '/pdf';
    res.json(r);
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// BRIEF 10 — CARGA INICIAL DE INVENTARIO (lotes de apertura, sin compra/proveedor/OC).
// Valuación al corte DIRECTA (Andy). origen='apertura' → entran al stock/FEFO/despacho pero quedan
// FUERA de prorrateo y de los reportes de compra/deuda (mismo criterio que transformado_de).
// body: { fecha_corte?, items:[{producto_id, kg, costo_total | costo_kg, calidad, semaforo}] }.
router.post('/lotes/apertura', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: 'Sin items para cargar' });
    const fechaCorte = val(b.fecha_corte) || getConfig(db, 'fecha_corte', '2026-06-30');
    const SEM = ['verde', 'amarillo', 'rojo'], CAL = ['primera', 'segunda', 'tercera'];
    // Validación previa (toda la carga o nada).
    for (const it of items) {
      if (!it.producto_id || !db.prepare('SELECT id FROM sg_productos WHERE id=? AND activo=1').get(it.producto_id)) {
        return res.status(400).json({ ok: false, error: 'Producto inválido: ' + it.producto_id });
      }
      if (!(Number(it.kg) > 0)) return res.status(400).json({ ok: false, error: 'Cada item necesita kg > 0' });
      const total = (it.costo_total != null && it.costo_total !== '') ? Number(it.costo_total)
        : ((it.costo_kg != null && it.costo_kg !== '') ? Number(it.costo_kg) * Number(it.kg) : null);
      if (total == null || !(total >= 0)) return res.status(400).json({ ok: false, error: 'Cada item necesita costo (total o $/kg)' });
      if (it.semaforo && !SEM.includes(it.semaforo)) return res.status(400).json({ ok: false, error: 'semaforo inválido: ' + it.semaforo });
      if (it.calidad && !CAL.includes(it.calidad)) return res.status(400).json({ ok: false, error: 'calidad inválida: ' + it.calidad });
      it._total = +total.toFixed(2);
    }
    const ins = db.prepare(`INSERT INTO sg_lotes
      (codigo_lote, recepcion_id, oc_item_id, producto_id, kg_reales, precio_unitario_kg, costo_base,
       calidad, calibre, origen, fecha_ingreso, fecha_vencimiento_estimada, estado, costo_final, semaforo, creado_por)
      VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, NULL, 'apertura', ?, NULL, 'disponible', ?, ?, ?)`);
    const out = [];
    db.transaction(() => {
      for (const it of items) {
        const kg = Number(it.kg);
        const precioKg = kg > 0 ? +(it._total / kg).toFixed(4) : 0;   // para que NO figure "pendiente" en Stock
        const codigo = nextNumero(db, 'SG-LT', 'sg_lotes', 'codigo_lote');
        const info = ins.run(codigo, Number(it.producto_id), kg, precioKg, it._total,
          val(it.calidad), fechaCorte, it._total, it.semaforo || 'verde', uid(req));
        out.push({ lote_id: info.lastInsertRowid, codigo_lote: codigo, kg, costo_total: it._total, costo_kg: precioKg });
      }
    })();
    res.json({ ok: true, data: { fecha_corte: fechaCorte, lotes: out } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── CLIENTES ──────────────────────────────────────────────────────────────────
montarCRUD('clientes', 'sg_clientes',
  ['razon_social', 'cuit', 'tipo', 'categoria_fiscal', 'tipo_fiscal_habitual',
   'condicion_pago_habitual_id', 'comercial_responsable_id', 'modalidad_pedido',
   'limite_credito', 'localidad', 'provincia', 'direccion_entrega', 'telefono',
   'email', 'observaciones', 'saldo_inicial'],   // saldo_inicial: apertura al corte (BRIEF 10)
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
// EL NÚMERO QUE SIGUE SALE DEL MÁS ALTO YA USADO, no de contar filas.
//
// Contar filas da el número equivocado apenas falta uno del medio, y entonces
// propone un número que YA EXISTE. codigo_lote y numero son UNIQUE: eso no da un
// número feo, tira una excepción y voltea la transacción entera — la recepción
// no se guarda y el operador ve un error sin sentido con el camión en la puerta.
//
// Los huecos aparecen solos: la migración que renumera los lotes viejos para que
// se llamen como su partida libera números de la serie SG-LT, y cualquier borrado
// hace lo mismo. Es el mismo problema que ya se había arreglado en el código de
// partida de las órdenes (ver maxSecuenciaDelDia): dos formas de contar lo mismo
// que se desincronizan.
//
// Tomar el máximo no reusa nunca un número, y un número que existió no vuelve a
// existir con otra mercadería adentro.
function nextNumero(db, prefijo, tabla, col) {
  const fecha = db.prepare("SELECT strftime('%Y%m%d','now','localtime') d").get().d;
  const pre = `${prefijo}-${fecha}-`;
  const filas = db.prepare(`SELECT ${col} v FROM ${tabla} WHERE ${col} LIKE ?`).all(pre + '%');
  let max = 0;
  for (const f of filas) {
    const n = parseInt(String(f.v).slice(pre.length), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return `${prefijo}-${fecha}-${String(max + 1).padStart(4, '0')}`;
}

// Recalcula costo_final de un lote = costo_base + gastos directos del lote + descarga de ingreso
// − transferido (según rama). CG1: los gastos GLOBALES del período (fijos + IIBB) YA NO se
// prorratean al costo — van a resultado del período (margen bruto real).
function recalcCostoLote(db, loteId) {
  const lote = db.prepare('SELECT id, kg_reales, costo_base, fecha_ingreso, precio_unitario_kg, recepcion_id, transformado_de, origen FROM sg_lotes WHERE id=?').get(loteId);
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
  // LOTE DE APERTURA (BRIEF 10): valuación al corte cargada DIRECTA (Andy). No es compra → fuera
  // del prorrateo/descarga; un cambio de gasto global del período NO lo pisa. costo_final = costo
  // cargado + sus propios gastos directos (si los hubiera). Mismo criterio que transformado_de.
  if (lote.origen === 'apertura') {
    const gdA = db.prepare('SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_directos_lote WHERE lote_id=? AND activo=1').get(loteId).s;
    const cfA = (lote.costo_base || 0) + gdA;
    db.prepare("UPDATE sg_lotes SET costo_final=?, modificado_en=datetime('now','localtime') WHERE id=?").run(cfA, loteId);
    return cfA;
  }
  // LOTE IMPORTADO (Importación F2): nace de un embarque recibido con costo PROVISORIO cargado en
  // costo_base (= costo_caja_neto del embarque × cajas del lote, ya convertido USD→ARS). Igual que
  // apertura/transformado: es un costo cargado, NO es compra nacional → fuera de prorrateo y de la
  // descarga de ingreso. costo_final = costo_base provisorio + sus propios gastos directos. El
  // cierre de cambio (F3, ZONA PABLO) ajustará este costo_base más adelante y re-correrá este recalc.
  if (lote.origen === 'importado') {
    const gdI = db.prepare('SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_directos_lote WHERE lote_id=? AND activo=1').get(loteId).s;
    const cfI = (lote.costo_base || 0) + gdI;
    db.prepare("UPDATE sg_lotes SET costo_final=?, modificado_en=datetime('now','localtime') WHERE id=?").run(cfI, loteId);
    return cfI;
  }
  // COSTO PENDIENTE: lote sin precio (recepción sin OC, o pizarra sin cerrar) → costo_final=0 y
  // NO se le suma prorrateo (sería un costo parcial engañoso que ensucia la rentabilidad).
  // Se completa cuando se vincula la OC / se cierra el precio (ahí vuelve a correr este recalc).
  if (lote.precio_unitario_kg == null) {
    db.prepare("UPDATE sg_lotes SET costo_final=0, modificado_en=datetime('now','localtime') WHERE id=?").run(loteId);
    return 0;
  }
  const gd = db.prepare('SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_directos_lote WHERE lote_id=? AND activo=1').get(loteId).s;
  // CG1 — los gastos GLOBALES del período (alquiler, sueldo_descarga, iibb, luz_camara) son costos
  // FIJOS/estructura + un impuesto de ventas: NO se capitalizan al inventario, van a RESULTADO del
  // período. El costo del lote = mercadería (costo_base) + gastos DIRECTOS del lote + descarga de
  // ingreso valorizada − lo transferido. sg_gastos_globales_periodo se sigue cargando; solo dejó de
  // prorratearse al costo. (OJO: 'descarga' de acá es descarga_ingreso valorizada de sg_gastos_directos,
  // un directo genuino que SE QUEDA — NO confundir con el 'sueldo_descarga' del pool global.)
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
  const costoFinal = (lote.costo_base || 0) + gd + descarga - transferido;
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
  let tipo = val(body.tipo_fiscal) || (p && p.tipo_fiscal_habitual) || 'factura_a';
  // ── EL COMPROBANTE TIENE QUE ENCAJAR CON LA CONDICIÓN COMERCIAL ────────
  // Una liquidación de venta no se factura: su comprobante es "liquidación".
  // Y una compra a precio cerrado se factura, así que no puede ser liquidación.
  // La pantalla ya sólo ofrece lo que corresponde, pero el habitual del
  // proveedor entra por atrás y podía dejar la combinación imposible guardada.
  // Precio cerrado admite las tres: hay productores que facturan y otros que
  // liquidan. Lo único imposible es al revés — una liquidación de venta no se
  // documenta con factura.
  const esLiquidacion = (val(body.tipo_precio) || 'firme') === 'pizarra';
  if (esLiquidacion) tipo = 'liquidacion';
  return {
    tipo_fiscal: tipo,
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

// EL CÓDIGO DEL LOTE SALE DE LA PARTIDA. Una compra tiene UN número —el de la
// orden— y ese número identifica la mercadería toda su vida. Cada línea de
// producto agrega un dígito: la partida 0008.12.08.2026.02 con dos productos da
// 0008.12.08.2026.02.1 y 0008.12.08.2026.02.2.
//
// El dígito cuenta los lotes que ya cuelgan de esa orden, incluidos los dados de
// baja: un código que existió no puede volver a existir con otra mercadería
// adentro. Si la orden se recibe en dos veces, la numeración sigue.
//
// Sin partida (recepción sin OC, apertura de inventario, reproceso,
// transformación, importación) se conserva el SG-LT de siempre: esos lotes no
// vienen de ninguna compra y no hay partida de la cual colgar.
function codigoLoteDePartida(db, ocItemId) {
  if (!ocItemId) return nextNumero(db, 'SG-LT', 'sg_lotes', 'codigo_lote');
  const oc = db.prepare(`SELECT o.id, o.trazabilidad FROM sg_oc_items i
                          JOIN sg_oc o ON o.id = i.oc_id WHERE i.id = ?`).get(ocItemId);
  if (!oc || !oc.trazabilidad) return nextNumero(db, 'SG-LT', 'sg_lotes', 'codigo_lote');
  const usados = db.prepare(`SELECT COUNT(*) c FROM sg_lotes l
                              JOIN sg_oc_items i ON i.id = l.oc_item_id
                             WHERE i.oc_id = ?`).get(oc.id).c;
  // codigo_lote es UNIQUE: si por lo que sea el número ya está tomado, se sigue
  // buscando en vez de reventar la transacción entera de la recepción.
  for (let n = usados + 1; n <= usados + 50; n++) {
    const codigo = `${oc.trazabilidad}.${n}`;
    if (!db.prepare('SELECT 1 FROM sg_lotes WHERE codigo_lote = ?').get(codigo)) return codigo;
  }
  return nextNumero(db, 'SG-LT', 'sg_lotes', 'codigo_lote');
}

function crearLotesDeItem(db, { recepcionId, ocItem, tipoPrecio, fechaIngreso, lotes, userId }) {
  const prod = db.prepare('SELECT vida_util_dias_default FROM sg_productos WHERE id=?').get(ocItem.producto_id);
  const vida = (prod && prod.vida_util_dias_default) || 0;
  const _rec = _recObservada(db, recepcionId);
  const ins = db.prepare(`INSERT INTO sg_lotes
    (codigo_lote, recepcion_id, oc_item_id, producto_id, kg_reales, precio_unitario_kg, costo_base,
     calidad, calibre, origen, fecha_ingreso, fecha_vencimiento_estimada, estado, costo_final,
     presentacion_id, bultos, kg_por_bulto, envase_id, creado_por)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'disponible', ?, ?, ?, ?, ?, ?)`);
  const ids = [];
  for (const lt of lotes) {
    // LOS KILOS YA NO SE TIPEAN EN EL CONTEO. El operador cuenta bultos; los
    // kilos salen de bultos × kg por bulto, que es el factor que la propia orden
    // ya trae (el despacho hace exactamente lo mismo al revés). Si en el paso de
    // la balanza se pesó de verdad, ese peso manda: es el dato medido.
    //
    // Un lote en 0 kg no es "un lote sin peso": es mercadería que no se puede
    // vender, no cierra la orden, no toma el costo de la descarga y queda de
    // fantasma en la planilla de stock. Por eso, si no hay ni peso ni factor, la
    // recepción se corta acá y dice qué falta.
    // El factor sale, en orden: del sub-lote, del ítem de la orden, o de la
    // PRESENTACIÓN del ítem. Ese último escalón faltaba y es el que rompía las
    // órdenes viejas: kg_por_bulto se agregó por migración y en las filas de
    // antes quedó en NULL, aunque su presentación sí diga cuántos kilos entran
    // por cajón. El resto del módulo —la oferta, los pedidos, el despacho— ya
    // cae a factor_conversion; acá no, y la recepción moría con un error que
    // además mandaba a "poné los kg por bulto en la orden", que no se puede
    // hacer: no hay pantalla que edite los ítems de una orden ya cargada.
    const kpbItem = (lt.kg_por_bulto != null && lt.kg_por_bulto !== '') ? Number(lt.kg_por_bulto)
      : (ocItem.kg_por_bulto != null ? Number(ocItem.kg_por_bulto)
        : (ocItem.presentacion_id
            ? (db.prepare('SELECT factor_conversion f FROM sg_presentaciones WHERE id=?')
                 .get(ocItem.presentacion_id) || {}).f ?? null
            : null));
    const bultosLt = (lt.bultos != null && lt.bultos !== '') ? Number(lt.bultos) : null;
    let kg = Number(lt.kg_reales || 0);
    if (!(kg > 0) && bultosLt > 0 && kpbItem > 0) kg = bultosLt * kpbItem;
    if (!(kg > 0)) {
      throw new Error('No se puede sacar el peso de "' + (ocItem.producto_nombre || 'un artículo')
        + '": cargá el peso de la balanza, o poné los kg por bulto en la orden de compra.');
    }
    const precio = tipoPrecio === 'firme' ? (ocItem.precio_estimado_por_kg != null ? Number(ocItem.precio_estimado_por_kg) : null) : null;
    const costoBase = precio != null ? kg * precio : 0;
    let venc = val(lt.fecha_vencimiento_estimada);
    if (!venc && fechaIngreso && vida) venc = db.prepare('SELECT date(?, ?) d').get(fechaIngreso, `+${vida} days`).d;
    // Identidad de bulto (aditivo): presentación del sub-lote o, en su defecto, la del ítem de OC;
    // bultos solo si el payload lo trae por sub-lote. Ambos null si no se conocen (no rompe).
    const presId = (lt.presentacion_id != null && lt.presentacion_id !== '') ? Number(lt.presentacion_id)
      : (ocItem.presentacion_id != null ? Number(ocItem.presentacion_id) : null);
    const bultos = (lt.bultos != null && lt.bultos !== '') ? Math.round(Number(lt.bultos)) : null;
    // F2 — herencia del factor tipeado y el envase desde el oc_item (F1). kg_por_bulto: sub-lote
    // o, en su defecto, el del oc_item; envase: el del oc_item. Ambos null si no se conocen (legacy
    // con presentación → las lecturas caen a la presentación vía COALESCE).
    const kpb = (lt.kg_por_bulto != null && lt.kg_por_bulto !== '') ? Number(lt.kg_por_bulto)
      : (ocItem.kg_por_bulto != null ? Number(ocItem.kg_por_bulto) : null);
    const envId = (ocItem.envase_id != null && ocItem.envase_id !== '') ? Number(ocItem.envase_id) : null;
    const codigo = codigoLoteDePartida(db, ocItem.id);
    const info = ins.run(codigo, recepcionId, ocItem.id, ocItem.producto_id, kg, precio, costoBase,
      val(lt.calidad), val(lt.calibre), val(lt.origen), fechaIngreso, venc, costoBase, presId, bultos, kpb, envId, userId);
    ids.push(info.lastInsertRowid);
    _aplicarObservado(db, info.lastInsertRowid, _rec, userId);
  }
  return ids;
}

// BRIEF 8 (D4) — al recibir una OC, concreta las reservas tipo='oc_item' activas de un oc_item
// sobre los lotes recién creados: FIFO por fecha de pedido × FEFO por vencimiento de lote.
// Cubierto → reservas tipo='lote' 'concretada'. Remanente no cubierto (lotes agotados) → 'cancelada'
// (D2: el proveedor no cumplió, no queda esperando). La reserva oc_item original pasa a 'concretada'.
// Reserva BLANDA (D1): esto NO descuenta disponible ni toca el lote; es trazabilidad informativa.
function concretarReservasOcItem(db, ocItemId, nuevosLoteIds, userId) {
  if (!nuevosLoteIds || !nuevosLoteIds.length) return;
  const reservas = db.prepare(`
    SELECT rs.id, rs.kg, rs.pedido_item_id
    FROM sg_reservas rs
    JOIN sg_pedido_items pi ON pi.id=rs.pedido_item_id
    JOIN sg_pedidos pe ON pe.id=pi.pedido_id
    WHERE rs.oc_item_id=? AND rs.tipo='oc_item' AND rs.estado='activa'
    ORDER BY pe.fecha_pedido ASC, rs.id ASC`).all(ocItemId);   // FIFO por pedido
  if (!reservas.length) return;
  const ph = nuevosLoteIds.map(() => '?').join(',');
  const lotes = db.prepare(`SELECT id, kg_reales FROM sg_lotes WHERE id IN (${ph})
    ORDER BY (fecha_vencimiento_estimada IS NULL), fecha_vencimiento_estimada ASC, id ASC`).all(...nuevosLoteIds); // FEFO
  const cap = {}; lotes.forEach(l => { cap[l.id] = l.kg_reales || 0; });
  const insLote = db.prepare(`INSERT INTO sg_reservas
    (pedido_item_id, tipo, lote_id, kg, estado, origen_oc_item_id, usuario_id, concretada_en)
    VALUES (?, 'lote', ?, ?, 'concretada', ?, ?, datetime('now','localtime'))`);
  const insCancel = db.prepare(`INSERT INTO sg_reservas
    (pedido_item_id, tipo, oc_item_id, kg, estado, origen_oc_item_id, usuario_id)
    VALUES (?, 'oc_item', ?, ?, 'cancelada', ?, ?)`);
  for (const r of reservas) {
    let restante = r.kg;
    for (const l of lotes) {
      if (restante <= 0.01) break;
      if (cap[l.id] <= 0.01) continue;
      const take = Math.min(restante, cap[l.id]);
      insLote.run(r.pedido_item_id, l.id, +take.toFixed(2), ocItemId, userId || null);
      cap[l.id] -= take; restante -= take;
    }
    db.prepare("UPDATE sg_reservas SET estado='concretada', concretada_en=datetime('now','localtime') WHERE id=?").run(r.id);
    if (restante > 0.01) insCancel.run(r.pedido_item_id, ocItemId, +restante.toFixed(2), ocItemId, userId || null); // D2
  }
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
     calidad, calibre, origen, fecha_ingreso, fecha_vencimiento_estimada, estado, costo_final,
     presentacion_id, bultos, creado_por)
    VALUES (?,?, NULL, ?,?, NULL, 0, ?, NULL, ?, ?, ?, 'disponible', 0, ?, ?, ?)`);
  const ids = [];
  for (const lt of lotes) {
    const kg = Number(lt.kg_reales || 0);
    let venc = val(lt.fecha_vencimiento_estimada);
    if (!venc && fechaIngreso && vida) venc = db.prepare('SELECT date(?, ?) d').get(fechaIngreso, `+${vida} days`).d;
    // Sin OC no hay ítem del que heredar: presentación/bultos solo si el payload los trae (null si no).
    // F4-C2 — origen del sub-lote (ej. 'granel'): se persiste si viene; null si no (backward-compatible).
    const presId = (lt.presentacion_id != null && lt.presentacion_id !== '') ? Number(lt.presentacion_id) : null;
    const bultos = (lt.bultos != null && lt.bultos !== '') ? Math.round(Number(lt.bultos)) : null;
    const codigo = nextNumero(db, 'SG-LT', 'sg_lotes', 'codigo_lote');
    const info = ins.run(codigo, recepcionId, productoId, kg, val(lt.calidad), val(lt.origen), fechaIngreso, venc, presId, bultos, userId);
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
function crearLoteTransformado(db, { origen, productoDestinoId, kg, factor, presentacionId, bultos, userId }) {
  const kgVigOrigen = (origen.kg_reales || 0) - kgDecomisado(db, origen.id) - kgTransformado(db, origen.id);
  const costoKgOrigen = kgVigOrigen > 0 ? (origen.costo_final || 0) / kgVigOrigen : 0;
  const costoTransf = +(kg * costoKgOrigen).toFixed(2);
  // F4-A — identidad de bulto OPCIONAL en el destino: si vienen, nace lote-bulto; si no, kg puro (igual que hoy).
  const presId = (presentacionId != null && presentacionId !== '') ? Number(presentacionId) : null;
  const blt = (bultos != null && bultos !== '') ? Math.round(Number(bultos)) : null;
  const codigo = nextNumero(db, 'SG-LT', 'sg_lotes', 'codigo_lote');
  const info = db.prepare(`INSERT INTO sg_lotes
    (codigo_lote, recepcion_id, oc_item_id, producto_id, kg_reales, precio_unitario_kg, costo_base,
     calidad, calibre, origen, fecha_ingreso, fecha_vencimiento_estimada, estado, costo_final,
     semaforo, transformado_de, presentacion_id, bultos, creado_por)
    VALUES (?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'disponible', ?, ?, ?, ?, ?, ?)`).run(
    codigo, productoDestinoId, kg, costoTransf,
    origen.calidad, origen.calibre, origen.origen, origen.fecha_ingreso, origen.fecha_vencimiento_estimada,
    costoTransf, origen.semaforo || 'verde', origen.id, presId, blt, userId || null);
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
function crearLoteHijo(db, { madre, reprocesoId, productoId, kg, costoAsignado, calidad, semaforo, presentacionId, bultos, userId }) {
  const costo = +(+costoAsignado || 0).toFixed(2);
  // F4-A — identidad de bulto OPCIONAL en el hijo: si vienen, nace lote-bulto (habilita granel→bulto y
  // bulto→bulto); si no, kg puro (igual que hoy). NO toca el reparto de costo (sigue por kg en F4-A).
  const presId = (presentacionId != null && presentacionId !== '') ? Number(presentacionId) : null;
  const blt = (bultos != null && bultos !== '') ? Math.round(Number(bultos)) : null;
  const codigo = nextNumero(db, 'SG-LT', 'sg_lotes', 'codigo_lote');
  const info = db.prepare(`INSERT INTO sg_lotes
    (codigo_lote, recepcion_id, oc_item_id, producto_id, kg_reales, precio_unitario_kg, costo_base,
     calidad, calibre, origen, fecha_ingreso, fecha_vencimiento_estimada, estado, costo_final,
     semaforo, transformado_de, reproceso_id, presentacion_id, bultos, creado_por)
    VALUES (?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'disponible', ?, ?, ?, ?, ?, ?, ?)`).run(
    codigo, productoId, kg, costo,
    val(calidad), madre.calibre, madre.origen, madre.fecha_ingreso, madre.fecha_vencimiento_estimada,
    costo, semaforo || 'verde', madre.id, reprocesoId, presId, blt, userId || null);
  return { loteId: info.lastInsertRowid, codigoLote: codigo, costo, presentacion_id: presId, bultos: blt };
}

// Actualiza estado de la OC según kg recibidos vs estimados.
//
// SALVO QUE YA ESTÉ CONFIRMADA. Cuando alguien da la orden por terminada, esa
// decisión gana sobre la cuenta de kilos: si no, la próxima recepción contra esa
// orden —o el vincular una recepción huérfana— recalcularía desde cero y la
// devolvería a 'recibida_parcial'. La orden reaparecería en la bandeja de
// pendientes sin que nadie haya hecho nada, que es el peor final posible para un
// botón que dice "Terminada". Para volver a recibir hay que reabrirla, y ahí sí
// se recalcula.
// ── LA ORDEN SE RECIBE UNA SOLA VEZ, Y LO QUE ENTRÓ ES LO QUE VALE ────────
//
// Antes el estado salía de comparar kilos recibidos contra pedidos, y la orden
// podía recibirse de a pedazos: una compra de 1188 kg terminaba partida en cinco
// lotes de 18 y 20 kg, con la orden colgada en la bandeja de pendientes para
// siempre. La regla ahora es la del negocio: el camión llega, se cuenta, se pesa,
// y con eso la orden QUEDA FIRME por las cantidades que entraron de verdad.
//
// No se pisa lo pactado. kg_estimados y cantidad_estimada_presentaciones quedan
// como se compraron: son la prueba de lo que se acordó con el productor y lo que
// permite mostrar la diferencia para ajustar el precio. Lo recibido vive en los
// lotes, que es donde siempre vivió. "Firme" es que la orden ya no espera nada
// más, no que se borre lo que se había pactado.
function actualizarEstadoOC(db, ocId) {
  const cerrojo = db.prepare('SELECT cerrada_en FROM sg_oc WHERE id=?').get(ocId);
  if (cerrojo && cerrojo.cerrada_en) return;
  const items = db.prepare('SELECT id FROM sg_oc_items WHERE oc_id=?').all(ocId);
  if (!items.length) return;
  // Con una recepción alcanza: la orden se recibe entera de una vez.
  const entradas = db.prepare('SELECT COUNT(*) c FROM sg_recepciones WHERE oc_id=? AND activo=1').get(ocId).c;
  const estado = entradas > 0 ? 'recibida_total' : 'abierta';
  db.prepare("UPDATE sg_oc SET estado=?, modificado_en=datetime('now','localtime') WHERE id=?").run(estado, ocId);
}

// Lo pactado contra lo que entró, por ítem. Es lo que dibuja la tabla de la
// orden recibida y lo que dispara la alerta de diferencia: el comprador la ve y
// decide si ajusta el precio.
function diferenciasDeOC(db, ocId) {
  const items = db.prepare(`SELECT i.id, i.kg_estimados, i.cantidad_estimada_presentaciones,
      i.kg_por_bulto, i.presentacion_id, pr.nombre AS producto_nombre,
      (SELECT COALESCE(SUM(kg_reales),0) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS kg_recibidos,
      (SELECT COALESCE(SUM(bultos),0)    FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS bultos_recibidos
    FROM sg_oc_items i LEFT JOIN sg_productos pr ON pr.id=i.producto_id
    WHERE i.oc_id=?`).all(ocId);
  const out = [];
  for (const it of items) {
    const bultosPact = it.cantidad_estimada_presentaciones || 0;
    const bultosRec = Number(it.bultos_recibidos) || 0;
    const kgPact = it.kg_estimados || 0;
    const kgRec = Number(it.kg_recibidos) || 0;

    // ── NO SE CUENTAN BULTOS QUE NADIE CONTÓ ───────────────────────────
    // Si la mercadería entró PESADA y sin contar cajones, bultos_recibidos es
    // 0 — y comparar 100 pactados contra ese 0 decía "faltan 100 bultos"
    // cuando en realidad entró todo. No faltaban: nadie los contó.
    //
    // Ese caso no es una diferencia, es una forma distinta de haber recibido, y
    // se avisa aparte: los kilos son los que mandan y contra esos se compara.
    const seContaron = bultosRec > 0;
    const difBultos = seContaron ? Math.round(bultosRec - bultosPact) : 0;
    const difKg = +(kgRec - kgPact).toFixed(2);

    // Un kilo de más o de menos en una balanza de camión no es una diferencia.
    const hayDifKg = Math.abs(difKg) > 1;
    const sinContar = !seContaron && bultosPact > 0 && kgRec > 0;
    if (!hayDifKg && !difBultos && !sinContar) continue;

    out.push({ oc_item_id: it.id, producto_nombre: it.producto_nombre,
      kg_pactados: kgPact, kg_recibidos: kgRec, dif_kg: hayDifKg ? difKg : 0,
      bultos_pactados: bultosPact, bultos_recibidos: bultosRec, dif_bultos: difBultos,
      // Entró pesado, sin contar cajones: no es que falten bultos.
      sin_contar_bultos: sinContar });
  }
  return out;
}

// ── ÓRDENES DE COMPRA ────────────────────────────────────────────────────────

// Crear OC (cabecera + items) en transacción. "Cerrar OC" en el modal = este POST.
// ── EL CÓDIGO CON EL QUE SE RASTREA LA PARTIDA ────────────────────────────
// PPPP.DD.MM.AAAA.XX
//   PPPP  el proveedor, en cuatro dígitos
//   DD.MM.AAAA  la fecha de la orden
//   XX    en qué lugar entró esa orden dentro del día: 01, 02, 03…
//
// Para qué: identificar la partida que entra por esta compra sin depender del
// número interno del sistema. El código se lee y dice de quién vino, cuándo, y
// cuál de las del día es — que es lo que se necesita cuando hay que rastrear una
// mercadería hacia atrás con el remito en la mano.
//
// LOS CUATRO DÍGITOS DEL PROVEEDOR son su id con ceros adelante. La tabla de
// proveedores no tiene un código propio, y hacer uno nuevo ahora sería inventar
// una segunda identidad para lo mismo: el id ya es único y no cambia nunca.
//
// EL XX CUENTA POR DÍA, no por proveedor: es "la orden número tal de hoy". Con
// el proveedor ya en el código, igual no se repite.
// El XX más alto ya usado en un día. Lee el propio código, que es la única
// fuente que no puede desincronizarse de sí misma.
function maxSecuenciaDelDia(db, fechaISO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fechaISO || ''));
  if (!m) return 0;
  const sufijo = `.${m[3]}.${m[2]}.${m[1]}.`;          // .DD.MM.AAAA.
  const filas = db.prepare(
    "SELECT trazabilidad FROM sg_oc WHERE trazabilidad LIKE ?").all('%' + sufijo + '%');
  let max = 0;
  for (const f of filas) {
    // El código es PPPP.DD.MM.AAAA.XX — la secuencia es el último tramo.
    const p = String(f.trazabilidad).split('.');
    if (p.length < 5) continue;
    const xx = parseInt(p[4], 10);
    if (!isNaN(xx) && xx > max) max = xx;
  }
  return max;
}

function codigoTrazabilidad(db, proveedorId, fechaISO) {
  const prov = String(parseInt(proveedorId, 10) || 0).padStart(4, '0');
  // La fecha llega como YYYY-MM-DD del <input type=date>. Si viene vacía o rara,
  // se usa hoy: un código sin fecha no sirve para rastrear nada.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fechaISO || ''));
  const hoy = new Date();
  const [aaaa, mm, dd] = m
    ? [m[1], m[2], m[3]]
    : [String(hoy.getFullYear()), String(hoy.getMonth() + 1).padStart(2, '0'),
       String(hoy.getDate()).padStart(2, '0')];
  const fecha = `${aaaa}-${mm}-${dd}`;

  // El número que sigue sale de MIRAR LOS CÓDIGOS YA ASIGNADOS de ese día, no de
  // contar filas. Contar filas era el problema: el alta contaba TODAS las órdenes
  // del día y el backfill de arranque contaba sólo las que ya tenían código, así
  // que los dos podían llegar al mismo XX. Con la partida identificando toda la
  // vida de la partida, dos órdenes con el mismo código es un error que se
  // arrastra hasta el último lote.
  //
  // Se toma el máximo asignado y se le suma uno: no reusa el número de una
  // anulada (su código ya existió y no puede volver a existir) y no depende de
  // cuántas filas haya.
  const n = maxSecuenciaDelDia(db, fecha);
  return { codigo: `${prov}.${dd}.${mm}.${aaaa}.${String(n + 1).padStart(2, '0')}`, fecha };
}

// Lo que la pantalla muestra en el encabezado MIENTRAS se arma la orden. Es una
// previsión: el definitivo se asigna al guardar, porque hasta ese momento otro
// puede haber cargado una orden y quedarse con el número.
router.get('/oc/trazabilidad-preview', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const t = codigoTrazabilidad(db, req.query.proveedor_id, req.query.fecha_oc);
    res.json({ ok: true, codigo: t.codigo, provisorio: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

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
    // ── EL FLETE: TOTAL, POR BULTO O POR PALLET ─────────────────────────
    // El total se CALCULA acá y no se le pide al usuario: si lo multiplicara él
    // y se equivocara, el número guardado y el pacto real dirían cosas
    // distintas, y meses después nadie sabría cuál valía.
    const fleteModalidad = ['total', 'bulto', 'pallet'].includes(b.flete_modalidad)
      ? b.flete_modalidad : (b.flete_monto != null && b.flete_monto !== '' ? 'total' : null);
    const nOno = (v) => (v != null && v !== '' && !isNaN(Number(v))) ? Number(v) : null;
    const fleteCantidad = fleteModalidad && fleteModalidad !== 'total' ? nOno(b.flete_cantidad) : null;
    const fletePrecioUnit = fleteModalidad && fleteModalidad !== 'total' ? nOno(b.flete_precio_unit) : null;
    const fleteMonto = fleteModalidad === 'total'
      ? nOno(b.flete_monto)
      : (fleteCantidad != null && fletePrecioUnit != null
          ? Math.round(fleteCantidad * fletePrecioUnit * 100) / 100
          : null);
    // Si no se dijo nada del IVA queda en null: null es "no se aclaró", que no es
    // lo mismo que "sin IVA". Con el flete informativo, inventar el dato sería
    // peor que no tenerlo.
    const fleteConIva = (b.flete_con_iva === undefined || b.flete_con_iva === null || b.flete_con_iva === '')
      ? null : (b.flete_con_iva ? 1 : 0);
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
      // El código de trazabilidad de la partida. Se calcula ACÁ ADENTRO de la
      // transacción, junto con el número: si se calculara antes, dos altas
      // simultáneas podrían llevarse el mismo XX.
      const traza = codigoTrazabilidad(db, b.proveedor_id, val(b.fecha_oc)).codigo;
      const ocInfo = db.prepare(`INSERT INTO sg_oc
        (numero, modalidad, proveedor_id, tipo_fiscal, tipo_precio, condicion_pago_id, fecha_oc,
         fecha_recepcion_estimada, comercial_id, estado, observaciones, flete_a_cargo, flete_monto,
         precio_incluye_iva, iva_alicuota_oc, total_estimado_kg, total_estimado_monto, creado_por,
         trazabilidad, flete_modalidad, flete_cantidad, flete_precio_unit, flete_con_iva)
        VALUES (?,?,?,?,?,?,?,?,?, 'abierta', ?,?,?, ?,?, 0, 0, ?, ?, ?,?,?,?)`).run(
        numero, val(b.modalidad) || 'normal', b.proveedor_id || null, dft.tipo_fiscal, tipoPrecio,
        dft.condicion_pago_id, val(b.fecha_oc), val(b.fecha_recepcion_estimada), b.comercial_id || null,
        val(b.observaciones), fleteCargo, fleteMonto, (discrimina ? incluyeIva : null), alicOverride, uid(req),
        traza, fleteModalidad, fleteCantidad, fletePrecioUnit, fleteConIva);
      const ocId = ocInfo.lastInsertRowid;

      const insItem = db.prepare(`INSERT INTO sg_oc_items
        (oc_id, producto_id, presentacion_id, envase_id, kg_por_bulto, cantidad_estimada_presentaciones, kg_estimados, precio_estimado_por_kg, observaciones_item, modo_carga,
         iva_alicuota, neto_estimado, iva_estimado)
        VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?)`);
      let totKg = 0, totMonto = 0, totNeto = 0, totIva = 0;
      for (const it of items) {
        // F1 — factor por item: kg por bulto tipeado al vuelo; fallback a la presentación
        // legacy y, en última instancia, 1. Solo se usa como fallback de kg_estimados.
        const kgPorBulto = (it.kg_por_bulto != null && it.kg_por_bulto !== '') ? Number(it.kg_por_bulto) : null;
        const envaseId = (it.envase_id != null && it.envase_id !== '') ? Number(it.envase_id) : null;
        const pres = it.presentacion_id ? db.prepare('SELECT factor_conversion FROM sg_presentaciones WHERE id=?').get(it.presentacion_id) : null;
        const factor = kgPorBulto != null ? kgPorBulto : (pres ? Number(pres.factor_conversion) : 1);
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
        insItem.run(ocId, it.producto_id, it.presentacion_id || null, envaseId, kgPorBulto, cant, kg, precio, val(it.observaciones_item), modo,
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

// ── LA PARTIDA RECIBIDA, ¿A DÓNDE VA? ────────────────────────────────────
// Una vez que la mercadería entró, la orden todavía tiene algo pendiente, y
// depende de cómo se pactó el precio:
//
//   Liquidación de Venta (pizarra) → hay que LIQUIDARLA: el precio se define
//     cuando se vende, cerrando el precio de cada lote.
//   Precio Cerrado (firme)         → hay que cargarle la FACTURA del proveedor.
//
// Son dos bandejas de trabajo distintas, para dos personas distintas, y hasta
// ahora no existía ninguna: la orden se recibía y desaparecía del circuito.
//
// El criterio de "pendiente" sale de datos que ya existen, sin tabla nueva:
//   pendiente de liquidar  = tiene lotes sin precio cerrado (precio_unitario_kg NULL)
//   pendiente de facturar  = ninguna de sus recepciones tiene número de factura
function partidasRecibidas(db, tipoPrecio) {
  return db.prepare(`
    SELECT o.id, o.numero, o.trazabilidad, o.fecha_oc, o.tipo_precio, o.tipo_fiscal, o.estado,
           o.cerrada_en, o.total_estimado_kg,
           p.razon_social AS proveedor_nombre,
           (SELECT COALESCE(SUM(l.kg_reales),0) FROM sg_lotes l
              JOIN sg_oc_items i ON i.id = l.oc_item_id
             WHERE i.oc_id = o.id AND l.activo = 1) AS kg_recibidos,
           (SELECT COALESCE(SUM(l.bultos),0) FROM sg_lotes l
              JOIN sg_oc_items i ON i.id = l.oc_item_id
             WHERE i.oc_id = o.id AND l.activo = 1) AS bultos_recibidos,
           (SELECT COUNT(*) FROM sg_lotes l
              JOIN sg_oc_items i ON i.id = l.oc_item_id
             WHERE i.oc_id = o.id AND l.activo = 1) AS lotes,
           (SELECT COUNT(*) FROM sg_lotes l
              JOIN sg_oc_items i ON i.id = l.oc_item_id
             WHERE i.oc_id = o.id AND l.activo = 1 AND l.precio_unitario_kg IS NULL) AS lotes_sin_precio,
           (SELECT GROUP_CONCAT(r.factura_numero, ' · ') FROM sg_recepciones r
             WHERE r.oc_id = o.id AND r.activo = 1
               AND r.factura_numero IS NOT NULL AND r.factura_numero <> '') AS facturas,
           (SELECT MAX(r.fecha_recepcion) FROM sg_recepciones r
             WHERE r.oc_id = o.id AND r.activo = 1) AS fecha_recepcion
      FROM sg_oc o LEFT JOIN sg_proveedores p ON p.id = o.proveedor_id
     WHERE o.activo = 1 AND o.tipo_precio = ?
       AND o.estado IN ('recibida_total','cerrada')
     ORDER BY o.id DESC`).all(tipoPrecio);
}

// Partidas de liquidación que todavía no se liquidaron: les falta cerrar el
// precio de algún lote.
router.get('/partidas-a-liquidar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = partidasRecibidas(db, 'pizarra').filter((r) => r.lotes_sin_precio > 0);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── EL ASIENTO CON EL QUE SE CONTABILIZA UNA FACTURA DE MERCADERÍA ───────
//
// Todas las facturas de mercadería se contabilizan IGUAL, así que el modelo se
// elige UNA vez y queda parametrizado para el módulo. No se elige factura por
// factura: eso abriría la puerta a que dos compras iguales entren con asientos
// distintos según quién las cargó, y a los tres meses el mayor no cierra y nadie
// sabe por qué.
//
// La clave vive en sg_config, que es donde ya viven los otros parámetros del
// módulo. Sin tabla nueva.
const CLAVE_MODELO_FACT = 'asiento_modelo_factura_mercaderia';

// El modelo elegido, con sus líneas y con la verificación de que sirve. Lo lee
// la pantalla de Facturas por mercadería para mostrar contra qué se va a
// contabilizar antes de cargar nada.
router.get('/factura-mercaderia/modelo', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const id = db.prepare('SELECT valor FROM sg_config WHERE clave=?').get(CLAVE_MODELO_FACT);
    const modeloId = id && id.valor ? Number(id.valor) : null;
    if (!modeloId) return res.json({ ok: true, data: { modelo: null } });

    const m = db.prepare('SELECT * FROM sg_asientos_modelo WHERE id=? AND activo=1').get(modeloId);
    if (!m) {
      // El modelo parametrizado se dio de baja: hay que avisar, no devolver
      // null como si nunca se hubiera elegido uno.
      return res.json({ ok: true, data: { modelo: null, id_perdido: modeloId } });
    }
    // Las líneas EFECTIVAS: las del modelo más las que completa la configuración
    // impositiva global. Es exactamente lo que se va a usar al contabilizar, así
    // que es lo que tiene que ver la pantalla — si mostrara sólo las del modelo,
    // el asiento de la pantalla no sería el que se graba.
    m.lineas = lineasModeloFactura(db) || [];

    // Qué le falta al modelo para poder contabilizar una compra. Se avisa acá y
    // no cuando ya está la factura cargada y el operador esperando.
    const faltan = [];
    if (!m.lineas.length) faltan.push('no tiene ninguna línea');
    if (!m.lineas.some((l) => l.tipo_linea === 'proveedores')) {
      faltan.push('no tiene la línea de Proveedores, que es el haber de la compra');
    }
    if (!m.lineas.some((l) => l.lado === 'debe')) faltan.push('no tiene ninguna línea en el debe');
    if (!m.lineas.some((l) => l.lado === 'haber')) faltan.push('no tiene ninguna línea en el haber');
    const sinCuenta = m.lineas.filter((l) => !l.cuenta_codigo).length;
    if (sinCuenta) faltan.push(sinCuenta + ' línea(s) apuntan a una cuenta que ya no existe');

    res.json({ ok: true, data: { modelo: m, faltan } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Elegir con qué modelo se contabilizan. Sólo admin: define cómo entra la plata
// de todas las compras de mercadería.
router.put('/factura-mercaderia/modelo', requireAdmin, (req, res) => {
  const db = getDb();
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
      .run(CLAVE_MODELO_FACT, modeloId == null ? null : String(modeloId), uid(req));
    res.json({ ok: true, data: { modelo_id: modeloId } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── SUBIR LA FACTURA DEL PROVEEDOR ───────────────────────────────────────
// El PDF se guarda en data/sg/ como cualquier otro adjunto del módulo, y los
// datos fiscales quedan desglosados: cada uno va a una línea distinta del
// asiento. Un total no se puede imputar.
const facturaStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SG_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '.pdf').toLowerCase();
    cb(null, 'factura_' + (req.params.id || 'x') + '_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + ext);
  },
});
const facturaUpload = multer({ storage: facturaStorage, limits: { fileSize: 15 * 1024 * 1024 } });

const numF = (v) => (v != null && v !== '' && !isNaN(Number(v))) ? Number(v) : null;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── CUÁNTO SE ACORDÓ PAGAR POR UNA PARTIDA ───────────────────────────────
// LA CUENTA SE HACE EN BULTOS. La compra se pacta en bultos y a tanto el bulto
// —"100 cajones a $15.000"— y así la controla el comprador contra la factura,
// no multiplicando kilos por $/kg. El sistema costea en kilos, pero eso es
// asunto suyo: acá manda la unidad en la que se cerró el trato.
//
// Si la mercadería entró pesada y sin contar bultos, no hay con qué: ahí se cae
// a kilos. Cada ítem dice cuál de las dos cuentas se le hizo.
//
// Está en UNA sola función porque la usan tres lugares —la pantalla de carga, el
// control contra la factura y el listado de partidas agrupables— y si cada uno
// la calculara por su cuenta, alcanzaría con tocar una para que el aviso de "no
// da contra lo acordado" empezara a mentir.
function acordadoDeOC(db, ocId) {
  const its = db.prepare(`SELECT i.id, i.precio_estimado_por_kg,
      COALESCE(i.kg_por_bulto, ps.factor_conversion) AS kg_por_bulto,
      (SELECT COALESCE(SUM(kg_reales),0) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS kg_recibidos,
      (SELECT COALESCE(SUM(bultos),0)    FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS bultos_recibidos
    FROM sg_oc_items i
    LEFT JOIN sg_presentaciones ps ON ps.id=i.presentacion_id
    WHERE i.oc_id=?`).all(ocId);
  let total = 0;
  const detalle = [];
  for (const it of its) {
    const pk = it.precio_estimado_por_kg != null ? Number(it.precio_estimado_por_kg) : null;
    const kpb = Number(it.kg_por_bulto) || 0;
    const bultos = Number(it.bultos_recibidos) || 0;
    const precioBulto = (pk != null && kpb > 0) ? r2(pk * kpb) : null;
    let importe = null, base = null;
    if (pk != null) {
      if (bultos > 0 && precioBulto != null) { importe = r2(bultos * precioBulto); base = 'bulto'; }
      else { importe = r2(it.kg_recibidos * pk); base = 'kilo'; }
      total = r2(total + importe);
    }
    detalle.push({ oc_item_id: it.id, precio_por_bulto: precioBulto, importe, base });
  }
  return { total, detalle };
}

// ── EL ASIENTO DE UNA FACTURA DE MERCADERÍA ──────────────────────────────
// Reparte los importes de la factura entre las líneas del asiento modelo, cada
// uno según el TIPO de línea. Es la MISMA cuenta que hace la pantalla: si las
// dos no dan igual, lo que se ve no es lo que se graba.
//
// La percepción de Ingresos Brutos va a la línea de SU JURISDICCIÓN. El modelo
// puede tener una línea por provincia; si no se elige jurisdicción, o la elegida
// no está en el modelo, la percepción no tiene dónde imputarse y el asiento no
// va a balancear — que es exactamente lo que tiene que pasar.
function armarAsientoFactura(lineas, fac) {
  // LAS PERCEPCIONES DE IIBB, UNA POR JURISDICCIÓN. Una factura puede traer
  // percepción de dos o tres provincias, y cada una va a la cuenta de la suya.
  // Si dos percepciones caen en la misma jurisdicción se suman: es la misma
  // cuenta, y el asiento no puede tener dos veces la misma línea.
  const percs = Array.isArray(fac.percepciones_iibb) ? fac.percepciones_iibb
    : (fac.percepcion_iibb ? [{ jurisdiccion: fac.iibb_jurisdiccion, monto: fac.percepcion_iibb }] : []);
  const porLinea = {};             // id de línea → monto acumulado
  const sinLinea = [];             // las que no tienen dónde imputarse
  const lineasIibb = lineas.filter((l) => l.tipo_linea === 'percepcion_iibb');
  for (const p of percs) {
    const monto = r2(p.monto);
    if (!(monto > 0)) continue;
    const j = String(p.jurisdiccion || '').trim();
    const l = j
      ? lineasIibb.find((x) => (x.jurisdiccion || '').trim().toLowerCase() === j.toLowerCase())
      // Sin jurisdicción sólo sirve si el modelo tiene UNA sola línea de IIBB y
      // tampoco la tiene: es el caso de quien opera en una provincia y nunca
      // necesitó abrirlas.
      : (lineasIibb.length === 1 && !lineasIibb[0].jurisdiccion ? lineasIibb[0] : null);
    if (!l) { sinLinea.push(j || '(sin jurisdicción)'); continue; }
    porLinea[l.id] = r2((porLinea[l.id] || 0) + monto);
  }

  const porTipo = {
    iva: r2(fac.iva_monto),
    percepcion_iva: r2(fac.percepcion_iva),
    percepcion_ganancias: r2(fac.percepcion_ganancias),
    proveedores: r2(fac.total),
  };

  let gastoPuesto = false;
  const out = [];
  for (const l of lineas) {
    let monto = 0;
    if (l.tipo_linea === 'percepcion_iibb') {
      monto = porLinea[l.id] || 0;
    } else if (porTipo[l.tipo_linea] != null) {
      monto = porTipo[l.tipo_linea];
    } else if (l.lado === 'debe' && !gastoPuesto) {
      // La línea de gasto —ni IVA, ni percepción, ni proveedores— se lleva el
      // neto de la mercadería. Es la única que no se deduce de un tipo.
      monto = r2(fac.neto);
      gastoPuesto = true;
    }
    out.push({ linea_id: l.id, cuenta_id: l.cuenta_id, cuenta_codigo: l.cuenta_codigo,
      cuenta_nombre: l.cuenta_nombre, lado: l.lado, tipo_linea: l.tipo_linea,
      jurisdiccion: l.jurisdiccion || null, descripcion: l.descripcion, monto });
  }
  const debe = r2(out.filter((x) => x.lado === 'debe').reduce((a, x) => a + x.monto, 0));
  const haber = r2(out.filter((x) => x.lado === 'haber').reduce((a, x) => a + x.monto, 0));
  return { lineas: out, debe, haber, diferencia: r2(debe - haber),
    balancea: Math.abs(r2(debe - haber)) < 0.01,
    // Las jurisdicciones que no tienen línea en el modelo. Es la causa más
    // común de que no cierre, y decirla ahorra buscarla.
    iibb_sin_linea: sinLinea };
}

// Las líneas del modelo parametrizado, con su cuenta. null si no hay modelo.
//
// ── Y LAS CUENTAS DE LA CONFIGURACIÓN IMPOSITIVA GLOBAL ─────────────────
// El asiento modelo describe la COMPRA: mercadería contra proveedores. El IVA y
// las percepciones no son del modelo, son de la empresa — la misma cuenta de IVA
// Crédito Fiscal sirve para todas las compras, y por eso ya está cargada una
// sola vez en la Configuración Impositiva Global.
//
// Pedirle al modelo que además repita esas cuentas obligaba a cargarlas dos
// veces y a mantenerlas sincronizadas a mano. Peor: un modelo sin línea de IVA
// dejaba el impuesto afuera del asiento y no balanceaba nunca, sin que se
// entendiera por qué si la cuenta estaba configurada.
//
// Ahora se completan solas: lo que el modelo no cubre lo pone la config global.
// Si el modelo SÍ tiene la línea, gana el modelo — es más específico.
function lineasModeloFactura(db) {
  const cfg = db.prepare('SELECT valor FROM sg_config WHERE clave=?').get(CLAVE_MODELO_FACT);
  const id = cfg && cfg.valor ? Number(cfg.valor) : null;
  if (!id) return null;
  const m = db.prepare('SELECT id FROM sg_asientos_modelo WHERE id=? AND activo=1').get(id);
  if (!m) return null;
  const lineas = db.prepare(`SELECT l.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre
    FROM sg_asientos_modelo_lineas l
    LEFT JOIN sg_cuentas c ON c.id = l.cuenta_id
    WHERE l.modelo_id=? ORDER BY l.orden, l.id`).all(id);

  // clave de la config global → tipo de línea del asiento. Todas van al DEBE:
  // en una compra, el IVA y las percepciones son crédito nuestro.
  const DE_CONFIG = [
    ['iva_credito_fiscal',   'iva'],
    ['percepcion_iva',       'percepcion_iva'],
    ['percepcion_iibb',      'percepcion_iibb'],
    ['percepcion_ganancias', 'percepcion_ganancias'],
  ];
  let cfgImp = [];
  try {
    cfgImp = db.prepare(`SELECT ci.clave, ci.cuenta_id, c.codigo, c.nombre
      FROM sg_config_impositiva ci LEFT JOIN sg_cuentas c ON c.id = ci.cuenta_id
      WHERE ci.cuenta_id IS NOT NULL`).all();
  } catch (_) { cfgImp = []; }

  let extra = -1;   // id negativo: son líneas que no existen en la tabla
  for (const [clave, tipo] of DE_CONFIG) {
    if (lineas.some((l) => l.tipo_linea === tipo)) continue;   // el modelo ya la tiene
    const c = cfgImp.find((x) => x.clave === clave);
    if (!c) continue;
    lineas.push({ id: extra--, modelo_id: id, cuenta_id: c.cuenta_id, lado: 'debe',
      descripcion: c.nombre, orden: 900, tipo_linea: tipo, jurisdiccion: null,
      cuenta_codigo: c.codigo, cuenta_nombre: c.nombre, de_config_global: 1 });
  }
  return lineas;
}

// ── LO QUE SE COMPRÓ, PARA CONTROLAR LA FACTURA ──────────────────────────
// Producto, lo que ENTRÓ DE VERDAD y el precio que acordó el comprador. Las
// cantidades salen de la RECEPCIÓN, no de la orden: la orden es lo que se pidió
// y puede diferir de lo que bajó del camión. Lo que se paga es lo que entró.
//
// El total que sale de acá es contra el que se controla la factura del
// proveedor: si no dan iguales, el costo de la partida deja de ser el que se
// acordó y el margen de esa mercadería queda mal para siempre.
router.get('/oc/:id/para-facturar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const oc = db.prepare(`SELECT o.id, o.trazabilidad, o.numero, o.tipo_precio, o.estado,
        p.razon_social AS proveedor_nombre, p.cuit AS proveedor_cuit
      FROM sg_oc o LEFT JOIN sg_proveedores p ON p.id=o.proveedor_id
      WHERE o.id=? AND o.activo=1`).get(req.params.id);
    if (!oc) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });

    const items = db.prepare(`SELECT i.id, i.precio_estimado_por_kg, i.kg_estimados,
        i.cantidad_estimada_presentaciones, i.modo_carga, pr.nombre AS producto_nombre,
        -- Los kilos que entran en un bulto: del ítem o, si no lo tiene (las
        -- órdenes viejas), de su presentación.
        COALESCE(i.kg_por_bulto, ps.factor_conversion) AS kg_por_bulto,
        (SELECT COALESCE(SUM(kg_reales),0) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS kg_recibidos,
        (SELECT COALESCE(SUM(bultos),0)    FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS bultos_recibidos
      FROM sg_oc_items i
      LEFT JOIN sg_productos pr ON pr.id=i.producto_id
      LEFT JOIN sg_presentaciones ps ON ps.id=i.presentacion_id
      WHERE i.oc_id=? ORDER BY i.id`).all(oc.id);

    // La cuenta la hace acordadoDeOC: en BULTOS por el precio del bulto, que es
    // como se pactó. Una sola función para los tres lugares que la necesitan.
    const ac = acordadoDeOC(db, oc.id);
    const porItem = {};
    for (const d of ac.detalle) porItem[d.oc_item_id] = d;
    for (const it of items) {
      const d = porItem[it.id] || {};
      it.precio_por_bulto = d.precio_por_bulto != null ? d.precio_por_bulto : null;
      it.importe = d.importe != null ? d.importe : null;
      it.base = d.base || null;
    }
    const total = ac.total;
    res.json({ ok: true, data: { oc, items,
      total_acordado: oc.tipo_precio === 'pizarra' ? null : total } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Las OTRAS partidas del mismo proveedor que también esperan factura. Son las
// que se pueden agrupar en este comprobante: el proveedor junta dos o tres
// camiones en una sola factura.
router.get('/oc/:id/agrupables', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const oc = db.prepare('SELECT id, proveedor_id FROM sg_oc WHERE id=? AND activo=1').get(req.params.id);
    if (!oc) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });
    const rows = db.prepare(`
      SELECT o.id, o.trazabilidad, o.numero,
             (SELECT MAX(r.fecha_recepcion) FROM sg_recepciones r WHERE r.oc_id=o.id AND r.activo=1) AS fecha_recepcion,
             (SELECT COALESCE(SUM(l.kg_reales),0) FROM sg_lotes l
                JOIN sg_oc_items i ON i.id=l.oc_item_id WHERE i.oc_id=o.id AND l.activo=1) AS kg_recibidos
        FROM sg_oc o
       WHERE o.activo=1 AND o.proveedor_id = ? AND o.id <> ?
         AND o.tipo_precio = 'firme'
         AND o.estado IN ('recibida_total','cerrada')
         -- Sin factura todavía: una partida no puede estar en dos facturas.
         AND NOT EXISTS (SELECT 1 FROM sg_recepciones r
                          WHERE r.oc_id=o.id AND r.activo=1
                            AND r.factura_numero IS NOT NULL AND r.factura_numero <> '')
       ORDER BY o.id DESC`).all(oc.proveedor_id, oc.id);

    // Cuánto se acordó por cada una, que es lo que hay que sumar al total.
    for (const r0 of rows) {
      r0.total_acordado = acordadoDeOC(db, r0.id).total;
    }
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Lo que ya se cargó de una partida. La pantalla lo usa para no pedir dos veces
// lo mismo y para mostrar el asiento con los importes reales.
router.get('/oc/:id/factura', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const f = db.prepare(`SELECT * FROM sg_facturas_compra
      WHERE oc_id=? AND activo=1 ORDER BY id DESC LIMIT 1`).get(req.params.id);
    res.json({ ok: true, data: f || null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Guardar la factura: el PDF y sus datos fiscales. multipart, igual que las
// fotos de la recepción — el archivo en disco, en la base sólo la ruta.
router.post('/oc/:id/factura-completa', facturaUpload.single('archivo'), requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body && req.body.payload ? JSON.parse(req.body.payload) : (req.body || {});
    const oc = db.prepare('SELECT id, proveedor_id, estado FROM sg_oc WHERE id=? AND activo=1').get(req.params.id);
    if (!oc) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });
    if (!(oc.estado === 'recibida_total' || oc.estado === 'cerrada')) {
      return res.status(400).json({ ok: false,
        error: 'Esa orden todavía no recibió la mercadería: no se le puede cargar la factura.' });
    }
    if (!val(b.numero)) return res.status(400).json({ ok: false, error: 'Falta el número de la factura' });
    // Sólo A o B. Una liquidación NO es una factura de compra: es el
    // comprobante de una venta por cuenta y orden, y se contabiliza distinto.
    const TIPOS_OK = ['factura_a', 'factura_b'];
    if (!TIPOS_OK.includes(val(b.tipo_comprobante))) {
      return res.status(400).json({ ok: false,
        error: 'La factura de compra de mercadería tiene que ser A o B.' });
    }

    // ── TODAS LAS PARTIDAS QUE CUBRE ESTA FACTURA ────────────────────────
    // El proveedor junta dos o tres camiones en un solo comprobante. Tienen que
    // ser del MISMO proveedor y estar todas recibidas: si no, no hay contra qué
    // controlar el total.
    const ocIds = [oc.id];
    for (const x of (Array.isArray(b.ocs) ? b.ocs : [])) {
      const n = Number(x);
      if (n && !ocIds.includes(n)) ocIds.push(n);
    }
    if (ocIds.length > 1) {
      const ph = ocIds.map(() => '?').join(',');
      const otras = db.prepare(`SELECT id, proveedor_id, estado, trazabilidad FROM sg_oc
        WHERE id IN (${ph}) AND activo=1`).all(...ocIds);
      if (otras.length !== ocIds.length) {
        return res.status(400).json({ ok: false, error: 'Alguna de las partidas elegidas no existe' });
      }
      const distinta = otras.find((o) => o.proveedor_id !== oc.proveedor_id);
      if (distinta) {
        return res.status(400).json({ ok: false,
          error: 'La partida ' + (distinta.trazabilidad || distinta.id) + ' es de otro proveedor. '
               + 'Una factura es de un solo proveedor.' });
      }
      const sinRecibir = otras.find((o) => !(o.estado === 'recibida_total' || o.estado === 'cerrada'));
      if (sinRecibir) {
        return res.status(400).json({ ok: false,
          error: 'La partida ' + (sinRecibir.trazabilidad || sinRecibir.id) + ' todavía no recibió la mercadería.' });
      }
      // Una partida no puede estar en dos facturas: sería pagarla dos veces.
      const yaFacturada = db.prepare(`SELECT o.trazabilidad FROM sg_factura_compra_ocs fo
        JOIN sg_oc o ON o.id = fo.oc_id
        JOIN sg_facturas_compra fa ON fa.id = fo.factura_id
        WHERE fo.oc_id IN (${ph}) AND fa.activo=1 AND fa.oc_id <> ?`).all(...ocIds, oc.id)[0];
      if (yaFacturada) {
        return res.status(400).json({ ok: false,
          error: 'La partida ' + yaFacturada.trazabilidad + ' ya está en otra factura.' });
      }
    }

    // El total tiene que dar contra el desglose, o el asiento no va a balancear
    // nunca. Se controla ACÁ y no después: es más barato que descubrirlo con el
    // asiento a medio armar.
    const neto = numF(b.neto) || 0, iva = numF(b.iva_monto) || 0;
    const pIva = numF(b.percepcion_iva) || 0;
    const pGan = numF(b.percepcion_ganancias) || 0, otros = numF(b.otros_conceptos) || 0;
    // Hasta tres percepciones de IIBB, cada una con su provincia. El campo viejo
    // sigue entrando, para no romper lo que ya mandaba una sola.
    const percsIibb = (Array.isArray(b.percepciones_iibb) ? b.percepciones_iibb : [])
      .map((p) => ({ jurisdiccion: val(p.jurisdiccion), monto: numF(p.monto) || 0 }))
      .filter((p) => p.monto > 0);
    if (!percsIibb.length && numF(b.percepcion_iibb) > 0) {
      percsIibb.push({ jurisdiccion: val(b.iibb_jurisdiccion), monto: numF(b.percepcion_iibb) });
    }
    if (percsIibb.length > 3) {
      return res.status(400).json({ ok: false,
        error: 'Como mucho tres jurisdicciones de Ingresos Brutos en una factura.' });
    }
    const pIibb = r2(percsIibb.reduce((a, p) => a + p.monto, 0));
    const total = numF(b.total);
    const suma = +(neto + iva + pIva + pIibb + pGan + otros).toFixed(2);
    if (total != null && Math.abs(total - suma) > 0.01) {
      return res.status(400).json({ ok: false,
        error: 'El total (' + total + ') no da contra el desglose (' + suma + '). '
             + 'Revisá neto, IVA, percepciones y otros conceptos antes de guardar.' });
    }

    // ── LA FACTURA CONTRA LO QUE SE ACORDÓ ───────────────────────────────
    // El NETO de la factura tiene que dar contra lo que entró por el precio
    // pactado. Si no da, el costo de esa partida deja de ser el que acordó el
    // comprador y el margen de esa mercadería queda mal para siempre.
    //
    // Se compara el neto y no el total: el IVA y las percepciones no son costo
    // de la mercadería, son crédito fiscal y pagos a cuenta.
    //
    // Es un AVISO, no un bloqueo: puede haber una diferencia legítima (un ajuste
    // de precio por la calidad que entró, un flete facturado aparte) y quien
    // carga la factura es el que sabe. Lo que no puede es pasar sin verse.
    // Con varias partidas, lo acordado es la SUMA de todas: la factura las
    // cubre a todas juntas.
    // La misma cuenta que muestra la pantalla: BULTOS por el precio del bulto,
    // que es como se pactó y como el comprador la controla. A kilos sólo se cae
    // cuando la mercadería entró pesada, sin contar bultos.
    let avisoAcordado = null;
    const acordadoPorOc = {};
    for (const id of ocIds) acordadoPorOc[id] = acordadoDeOC(db, id).total;
    const acordado = r2(Object.values(acordadoPorOc).reduce((a, x) => a + x, 0));
    if (acordado > 0 && Math.abs(r2(neto - acordado)) > 0.01) {
      avisoAcordado = 'El neto de la factura (' + r2(neto) + ') no da contra lo acordado por lo que entró ('
        + acordado + (ocIds.length > 1 ? ', sumando las ' + ocIds.length + ' partidas' : '')
        + '). Diferencia: ' + r2(neto - acordado) + '.';
    }

    // ── CUÁNTO LE TOCA A CADA PARTIDA ────────────────────────────────────
    // Una factura, un asiento. Pero el neto se reparte entre las partidas EN
    // PROPORCIÓN a lo acordado de cada una, para que cada una se quede con su
    // costo real. Si se repartiera en partes iguales, un camión de 200 kg
    // cargaría lo mismo que uno de 2000.
    //
    // El redondeo se acumula en la última: si no, la suma de las partes no da
    // el neto y falta o sobra un centavo que después nadie encuentra.
    const netoPorOc = {};
    if (acordado > 0) {
      let repartido = 0;
      ocIds.forEach((id, i) => {
        if (i === ocIds.length - 1) { netoPorOc[id] = r2(neto - repartido); return; }
        const parte = r2(neto * (acordadoPorOc[id] / acordado));
        netoPorOc[id] = parte;
        repartido = r2(repartido + parte);
      });
    } else {
      // Sin precio acordado (no debería pasar en precio cerrado) se reparte en
      // partes iguales antes que dejarlo sin repartir.
      ocIds.forEach((id, i) => {
        netoPorOc[id] = (i === ocIds.length - 1)
          ? r2(neto - r2(Math.floor(neto / ocIds.length * 100) / 100) * (ocIds.length - 1))
          : r2(Math.floor(neto / ocIds.length * 100) / 100);
      });
    }

    // ── LA REGLA: SI EL ASIENTO NO BALANCEA, NO SE GRABA ─────────────────
    // Un asiento que no cierra no es un asiento: es un error esperando a que
    // alguien lo encuentre tres meses después conciliando el mayor. Se corta
    // acá, con el mensaje de qué falta.
    const lineasMod = lineasModeloFactura(db);
    if (!lineasMod || !lineasMod.length) {
      return res.status(400).json({ ok: false,
        error: 'Todavía no se eligió el asiento modelo con el que se contabilizan las facturas de mercadería. '
             + 'Configuralo arriba, en Facturas por mercadería.' });
    }
    const asiento = armarAsientoFactura(lineasMod, {
      neto, iva_monto: iva, percepcion_iva: pIva, percepcion_ganancias: pGan,
      total: total != null ? total : suma, percepciones_iibb: percsIibb,
    });
    if (!asiento.balancea) {
      // Por qué no cierra, en criollo. El caso más común es una percepción que
      // no tiene línea en el modelo: el importe queda afuera del asiento.
      const pistas = [];
      if ((asiento.iibb_sin_linea || []).length) {
        pistas.push('la percepción de Ingresos Brutos no tiene línea en el modelo para '
          + asiento.iibb_sin_linea.join(' ni para '));
      }
      if (pIva > 0 && !asiento.lineas.some((l) => l.tipo_linea === 'percepcion_iva')) {
        pistas.push('la percepción de IVA no tiene línea en el modelo');
      }
      if (pGan > 0 && !asiento.lineas.some((l) => l.tipo_linea === 'percepcion_ganancias')) {
        pistas.push('la percepción de Ganancias no tiene línea en el modelo');
      }
      if (iva > 0 && !asiento.lineas.some((l) => l.tipo_linea === 'iva')) {
        pistas.push('el IVA no tiene línea en el modelo');
      }
      if (otros > 0) pistas.push('"otros conceptos" no tiene dónde imputarse: agregale una línea al modelo');
      return res.status(400).json({ ok: false,
        error: 'El asiento no balancea (debe ' + asiento.debe + ' contra haber ' + asiento.haber
             + ', diferencia ' + asiento.diferencia + '). No se graba.'
             + (pistas.length ? ' ' + pistas.join('. ') + '.' : ''),
        asiento });
    }

    const prev = db.prepare('SELECT id, archivo_ruta FROM sg_facturas_compra WHERE oc_id=? AND activo=1').get(oc.id);
    const ruta = req.file ? ('/data/sg/' + req.file.filename) : (prev ? prev.archivo_ruta : null);
    const nombre = req.file ? (req.file.originalname || null) : null;

    const campos = [oc.id, oc.proveedor_id || null, val(b.tipo_comprobante), val(b.punto_venta),
      val(b.numero), val(b.fecha_emision), val(b.cuit_emisor), neto, numF(b.iva_alicuota), iva,
      pIva, pIibb, pGan, otros, val(b.iibb_jurisdiccion), total != null ? total : suma, val(b.cae), val(b.cae_vencimiento),
      ruta, nombre, b.leido_por_ia ? 1 : 0, val(b.observaciones), uid(req)];

    let id;
    db.transaction(() => {
      if (prev) {
        db.prepare(`UPDATE sg_facturas_compra SET proveedor_id=?, tipo_comprobante=?, punto_venta=?,
          numero=?, fecha_emision=?, cuit_emisor=?, neto=?, iva_alicuota=?, iva_monto=?,
          percepcion_iva=?, percepcion_iibb=?, percepcion_ganancias=?, otros_conceptos=?, iibb_jurisdiccion=?, total=?,
          cae=?, cae_vencimiento=?, archivo_ruta=?, archivo_nombre=?, leido_por_ia=?, observaciones=?,
          modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
          .run(...campos.slice(1), prev.id);
        id = prev.id;
      } else {
        id = db.prepare(`INSERT INTO sg_facturas_compra
          (oc_id, proveedor_id, tipo_comprobante, punto_venta, numero, fecha_emision, cuit_emisor,
           neto, iva_alicuota, iva_monto, percepcion_iva, percepcion_iibb, percepcion_ganancias,
           otros_conceptos, iibb_jurisdiccion, total, cae, cae_vencimiento, archivo_ruta, archivo_nombre,
           leido_por_ia, observaciones, creado_por)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...campos).lastInsertRowid;
      }
      // Las partidas que cubre, con lo que le toca a cada una. Se rehace entera:
      // corregir una factura puede sacar o agregar partidas.
      db.prepare('DELETE FROM sg_factura_compra_ocs WHERE factura_id=?').run(id);
      const insOc = db.prepare('INSERT INTO sg_factura_compra_ocs (factura_id, oc_id, neto) VALUES (?,?,?)');
      for (const ocId of ocIds) insOc.run(id, ocId, netoPorOc[ocId] != null ? netoPorOc[ocId] : null);

      // Y las percepciones, una fila por jurisdicción.
      db.prepare('DELETE FROM sg_factura_percepciones WHERE factura_id=?').run(id);
      const insP = db.prepare('INSERT INTO sg_factura_percepciones (factura_id, tipo, jurisdiccion, monto) VALUES (?,?,?,?)');
      for (const p of percsIibb) insP.run(id, 'percepcion_iibb', p.jurisdiccion || null, p.monto);
      if (pIva > 0) insP.run(id, 'percepcion_iva', null, pIva);
      if (pGan > 0) insP.run(id, 'percepcion_ganancias', null, pGan);

      // El número queda en la recepción de CADA partida: es de ahí que la
      // bandeja lee que ya no están pendientes de facturar.
      const nro = (val(b.punto_venta) ? val(b.punto_venta) + '-' : '') + val(b.numero);
      for (const ocId of ocIds) {
        const rec = db.prepare('SELECT id FROM sg_recepciones WHERE oc_id=? AND activo=1 ORDER BY id DESC LIMIT 1').get(ocId);
        if (!rec) continue;
        db.prepare(`UPDATE sg_recepciones SET factura_numero=?,
          modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`).run(nro, uid(req), rec.id);
      }
    })();
    res.json({ ok: true, data: { id: Number(id), archivo_ruta: ruta,
      asiento, aviso_acordado: avisoAcordado } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── LEERLE LOS DATOS FISCALES AL COMPROBANTE ─────────────────────────────
// Copia el patrón de /api/factura/analizar (buscar.js), que es el único del
// repo que acepta PDF: bloque 'document' para PDF y 'image' para una foto.
//
// LO QUE DEVUELVE ES UNA PROPUESTA, NO UN DATO. De acá sale el primer asiento
// contable de la mercadería: nada se guarda sin que una persona lo mire. La
// pantalla llena los campos y el operador confirma.
//
// Va con requireAdmin — el de buscar.js quedó sin auth y gasta la API key.
router.post('/factura-mercaderia/leer', requireAdmin, async (req, res) => {
  try {
    const { base64, mediaType, oc_id } = req.body || {};
    if (!base64 || !mediaType) return res.status(400).json({ ok: false, error: 'Falta el archivo' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ ok: false, error: 'La lectura automática no está configurada en este servidor' });
    }
    const db = getDb();

    // A quién le compramos, según la orden. Sirve para que la lectura pueda
    // contrastar el CUIT del comprobante contra el del proveedor: si no dan,
    // la factura puede ser de otro y eso hay que verlo ANTES de contabilizar.
    let prov = null;
    if (oc_id) {
      prov = db.prepare(`SELECT p.razon_social, p.cuit FROM sg_oc o
        LEFT JOIN sg_proveedores p ON p.id=o.proveedor_id WHERE o.id=?`).get(oc_id);
    }

    const esPDF = mediaType === 'application/pdf';
    const contenido = esPDF
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

    const prompt = `Sos un asistente contable argentino. Leé esta factura de compra de mercadería y extraé
sus datos fiscales. Respondé ÚNICAMENTE un JSON válido, sin markdown ni backticks, con estas claves:

{"tipo_comprobante":"factura_a|factura_b|liquidacion","punto_venta":"","numero":"","fecha_emision":"AAAA-MM-DD",
 "cuit_emisor":"","razon_social_emisor":"","neto":0,"iva_alicuota":0,"iva_monto":0,
 "percepcion_iva":0,"percepcion_iibb":0,"percepcion_ganancias":0,"otros_conceptos":0,"total":0,
 "cae":"","cae_vencimiento":"AAAA-MM-DD","confianza":"alta|media|baja","observaciones":""}

REGLAS:
- Los montos son NÚMEROS en pesos, sin separador de miles. iva_alicuota es el PORCENTAJE (21, 10.5) y
  iva_monto es el MONTO en pesos. No los confundas.
- El punto de venta y el número van por separado. En "0001-00012345", punto_venta es "0001" y numero
  "00012345".
- Las percepciones son las que figuran discriminadas (IVA, Ingresos Brutos, Ganancias). Si no hay, 0.
- Lo que no puedas leer con seguridad va en null, NUNCA inventado. Si dudás de un monto, poné
  confianza "baja" y explicá qué no se lee en observaciones.
- neto + iva_monto + percepciones + otros_conceptos tiene que dar total. Si no da, decilo en
  observaciones en vez de forzar los números.${prov && prov.cuit ? `
- La orden es del proveedor "${prov.razon_social}", CUIT ${prov.cuit}. Si el CUIT del comprobante NO
  coincide, dejá igual el que leíste y avisalo en observaciones: puede ser una factura de otro.` : ''}`;

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };
    if (esPDF) headers['anthropic-beta'] = 'pdfs-2024-09-25';

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers,
      body: JSON.stringify({ model: MODELO_CHAT, max_tokens: 1500,
        messages: [{ role: 'user', content: [contenido, { type: 'text', text: prompt }] }] }),
    });
    const data = await resp.json();
    const txt = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (!txt) return res.status(502).json({ ok: false, error: 'La lectura no devolvió nada' });

    let leido;
    try {
      leido = JSON.parse(txt.replace(/```json|```/g, '').trim());
    } catch (_) {
      // El 422 con el texto crudo deja ver QUÉ contestó cuando no parsea. Un 500
      // pelado esconde el problema.
      return res.status(422).json({ ok: false, error: 'No se pudo interpretar la lectura', raw: txt.slice(0, 800) });
    }

    // El control de suma se hace ACÁ y viaja con la propuesta: que el operador
    // vea de entrada si los números que se leyeron cierran entre sí.
    const n = (v) => (v != null && !isNaN(Number(v))) ? Number(v) : 0;
    const suma = +(n(leido.neto) + n(leido.iva_monto) + n(leido.percepcion_iva)
      + n(leido.percepcion_iibb) + n(leido.percepcion_ganancias) + n(leido.otros_conceptos)).toFixed(2);
    const cierra = leido.total == null || Math.abs(n(leido.total) - suma) < 0.01;

    res.json({ ok: true, data: {
      leido,
      suma_desglose: suma,
      cierra,
      proveedor_oc: prov || null,
      cuit_coincide: !!(prov && prov.cuit && leido.cuit_emisor
        && String(prov.cuit).replace(/\D/g, '') === String(leido.cuit_emisor).replace(/\D/g, '')),
    } });
  } catch (e) {
    console.error('[SG] Lectura de factura:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── CORREGIR LO QUE YA SE CARGÓ ──────────────────────────────────────────
// Un bulto mal contado, un peso mal tipeado, un precio con un cero de más. El
// error existe y hay que poder arreglarlo — pero queda registrado QUÉ decía
// antes, no sólo quién lo tocó.
//
// Los tres frenos, en orden de gravedad:
//   1. La partida YA ESTÁ CONTABILIZADA. El asiento en el libro dice 1.500.000
//      porque los kilos decían 2.000: cambiarlos deja el asiento mintiendo.
//      Primero se anula el asiento, después se corrige.
//   2. La mercadería YA SE DESPACHÓ. Bajarle los kilos a un lote del que ya
//      salieron 1.800 dejaría stock negativo, y el costo del cliente calculado
//      sobre un número que ya no existe.
//   3. El lote se TRANSFORMÓ o se REPROCESÓ: su costo ya viajó a otro lote.
function frenosDeEdicionLote(db, loteId) {
  const l = db.prepare(`SELECT l.id, l.kg_reales, l.transformado_de, l.reproceso_id, i.oc_id
    FROM sg_lotes l LEFT JOIN sg_oc_items i ON i.id = l.oc_item_id
    WHERE l.id=? AND l.activo=1`).get(loteId);
  if (!l) return { error: 'Lote no encontrado' };

  if (l.oc_id) {
    const fac = db.prepare(`SELECT f.id, f.asiento_id, a.anulado FROM sg_facturas_compra f
      LEFT JOIN sg_asientos a ON a.id = f.asiento_id
      WHERE f.oc_id=? AND f.activo=1 AND f.asiento_id IS NOT NULL`).get(l.oc_id);
    if (fac && !fac.anulado) {
      return { error: 'Esta partida ya está contabilizada en el asiento ' + fac.asiento_id
        + '. Anulá el asiento primero: si se corrigen los kilos o el precio, el asiento que está en el '
        + 'libro deja de corresponder con el dato.' };
    }
  }
  const desp = db.prepare(`SELECT COALESCE(SUM(di.kg_despachados),0) s FROM sg_despacho_items di
    JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1 WHERE di.lote_id=?`).get(loteId).s;
  if (desp > 0) {
    return { error: 'De este lote ya se despacharon ' + r2(desp) + ' kg. No se pueden corregir sus '
      + 'cantidades: el stock y el costo del cliente ya salieron con el número viejo.' };
  }
  if (l.transformado_de != null || l.reproceso_id != null) {
    return { error: 'Este lote vino de una transformación o un reproceso: su costo se calculó a partir '
      + 'de otro lote y no se corrige acá.' };
  }
  return { ok: true, lote: l };
}

// Deja constancia del cambio. Se llama DENTRO de la transacción que edita, para
// que no pueda quedar el cambio sin registro ni el registro sin cambio.
function anotarEdicion(db, { tabla, registroId, campo, antes, despues, motivo, ocId, userId }) {
  if (String(antes == null ? '' : antes) === String(despues == null ? '' : despues)) return;
  db.prepare(`INSERT INTO sg_ediciones
    (tabla, registro_id, campo, valor_anterior, valor_nuevo, motivo, oc_id, usuario_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(tabla, registroId, campo,
      antes == null ? null : String(antes), despues == null ? null : String(despues),
      motivo || null, ocId || null, userId || null);
}

// Corregir un lote: kilos, bultos, calidad y precio. Sólo admin.
router.put('/lotes/:id/corregir', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const motivo = val(b.motivo);
    if (!motivo) return res.status(400).json({ ok: false, error: 'Escribí por qué se corrige: queda registrado' });

    const chk = frenosDeEdicionLote(db, req.params.id);
    if (chk.error) return res.status(400).json({ ok: false, error: chk.error });

    const prev = db.prepare('SELECT * FROM sg_lotes WHERE id=?').get(req.params.id);
    const nuevo = {
      kg_reales: numF(b.kg_reales) != null ? numF(b.kg_reales) : prev.kg_reales,
      bultos: (b.bultos === '' || b.bultos == null) ? prev.bultos : Math.round(Number(b.bultos)),
      calidad: b.calidad !== undefined ? val(b.calidad) : prev.calidad,
      precio_unitario_kg: b.precio_unitario_kg !== undefined
        ? numF(b.precio_unitario_kg) : prev.precio_unitario_kg,
    };
    if (!(nuevo.kg_reales > 0)) {
      return res.status(400).json({ ok: false, error: 'Los kilos tienen que ser mayores a cero' });
    }

    db.transaction(() => {
      for (const campo of ['kg_reales', 'bultos', 'calidad', 'precio_unitario_kg']) {
        anotarEdicion(db, { tabla: 'sg_lotes', registroId: prev.id, campo,
          antes: prev[campo], despues: nuevo[campo], motivo, ocId: chk.lote.oc_id, userId: uid(req) });
      }
      // El costo base sale de los kilos por el precio: si cambia cualquiera de
      // los dos, hay que rehacerlo antes de recalcular.
      const costoBase = nuevo.precio_unitario_kg != null
        ? r2(nuevo.kg_reales * nuevo.precio_unitario_kg) : 0;
      db.prepare(`UPDATE sg_lotes SET kg_reales=?, bultos=?, calidad=?, precio_unitario_kg=?,
        costo_base=?, modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
        .run(nuevo.kg_reales, nuevo.bultos, nuevo.calidad, nuevo.precio_unitario_kg,
             costoBase, uid(req), prev.id);
      // Y lo que cuelga de esos kilos: el costo con sus gastos, y el período.
      recalcCostoLote(db, prev.id);
      if (prev.fecha_ingreso) recalcPeriodo(db, String(prev.fecha_ingreso).slice(0, 7));
    })();
    const l = db.prepare('SELECT * FROM sg_lotes WHERE id=?').get(prev.id);
    res.json({ ok: true, data: l });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Lo que se corrigió de una partida: quién, cuándo, qué decía antes.
router.get('/oc/:id/ediciones', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`SELECT e.*, u.nombre AS usuario_nombre
      FROM sg_ediciones e LEFT JOIN usuarios u ON u.id = e.usuario_id
      WHERE e.oc_id = ? ORDER BY e.id DESC`).all(req.params.id);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── CONTABILIZAR LA FACTURA ──────────────────────────────────────────────
// Acá se escribe en la contabilidad. Hasta este punto todo era preparar el
// asiento; esto lo graba.
//
// LA FECHA ES LA DE LA FACTURA, no la de hoy ni la de la recepción: el hecho
// imponible es la emisión del comprobante, y de eso dependen el período de IVA
// y el libro donde cae.
//
// UN ASIENTO NO SE BORRA NUNCA. Si está mal, se ANULA —queda a la vista, con
// quién y cuándo— y se hace uno nuevo. Un asiento borrado es un agujero en el
// libro que nadie puede explicar después.
router.post('/oc/:id/contabilizar', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const fac = db.prepare(`SELECT * FROM sg_facturas_compra
      WHERE oc_id=? AND activo=1 ORDER BY id DESC LIMIT 1`).get(req.params.id);
    if (!fac) return res.status(400).json({ ok: false, error: 'Esa partida todavía no tiene factura cargada' });
    if (fac.asiento_id) {
      const a = db.prepare('SELECT id, anulado FROM sg_asientos WHERE id=?').get(fac.asiento_id);
      if (a && !a.anulado) {
        return res.status(400).json({ ok: false,
          error: 'Esta factura ya está contabilizada en el asiento ' + a.id + '. Si está mal, anulalo.' });
      }
    }
    if (!val(fac.fecha_emision)) {
      return res.status(400).json({ ok: false,
        error: 'La factura no tiene fecha de emisión, y el asiento va con esa fecha.' });
    }

    const lineasMod = lineasModeloFactura(db);
    if (!lineasMod || !lineasMod.length) {
      return res.status(400).json({ ok: false, error: 'No hay asiento modelo parametrizado' });
    }
    const percs = db.prepare(`SELECT jurisdiccion, monto FROM sg_factura_percepciones
      WHERE factura_id=? AND tipo='percepcion_iibb'`).all(fac.id);
    const asiento = armarAsientoFactura(lineasMod, {
      neto: fac.neto, iva_monto: fac.iva_monto, percepcion_iva: fac.percepcion_iva,
      percepcion_ganancias: fac.percepcion_ganancias, total: fac.total,
      percepciones_iibb: percs.length ? percs
        : (fac.percepcion_iibb ? [{ jurisdiccion: fac.iibb_jurisdiccion, monto: fac.percepcion_iibb }] : []),
    });
    // La regla otra vez, acá donde de verdad importa: es lo último antes de
    // escribir en la contabilidad.
    if (!asiento.balancea) {
      return res.status(400).json({ ok: false,
        error: 'El asiento no balancea (debe ' + asiento.debe + ' contra haber ' + asiento.haber
             + '). No se contabiliza.', asiento });
    }
    const conCuenta = asiento.lineas.filter((l) => l.monto > 0);
    if (conCuenta.some((l) => !l.cuenta_id)) {
      return res.status(400).json({ ok: false, error: 'Hay líneas con importe que no tienen cuenta' });
    }

    const partidas = db.prepare(`SELECT o.trazabilidad FROM sg_factura_compra_ocs fo
      JOIN sg_oc o ON o.id=fo.oc_id WHERE fo.factura_id=?`).all(fac.id).map((x) => x.trazabilidad);
    const nroFac = (fac.punto_venta ? fac.punto_venta + '-' : '') + (fac.numero || '');
    const desc = 'Compra de mercadería — Factura ' + nroFac
      + (partidas.length ? ' — Partida' + (partidas.length > 1 ? 's ' : ' ') + partidas.join(', ') : '');

    let asientoId;
    db.transaction(() => {
      asientoId = db.prepare(`INSERT INTO sg_asientos (fecha, descripcion, usuario_id, ref_compra_id, ref_codigo)
        VALUES (?,?,?,?,?)`).run(fac.fecha_emision, desc, uid(req), fac.id, nroFac).lastInsertRowid;

      // El asiento va a sg_asientos_lineas, que es de donde el módulo contable
      // arma el mayor y el balance. sg_movimientos_contables existe pero no la
      // lee nadie —se creó "por paridad estructural" con Puente Cordón—, así
      // que escribir ahí sería inventar un segundo lugar para lo mismo y que
      // dentro de un año no se sepa cuál de los dos manda.
      const insL = db.prepare(`INSERT INTO sg_asientos_lineas (asiento_id, cuenta_id, debe, haber, descripcion)
        VALUES (?,?,?,?,?)`);
      for (const l of conCuenta) {
        insL.run(asientoId, l.cuenta_id,
          l.lado === 'debe' ? l.monto : 0,
          l.lado === 'haber' ? l.monto : 0,
          l.descripcion || null);
      }
      db.prepare(`UPDATE sg_facturas_compra SET asiento_id=?, confirmada_en=datetime('now','localtime'),
        confirmada_por=?, modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
        .run(asientoId, uid(req), uid(req), fac.id);
    })();
    res.json({ ok: true, data: { asiento_id: Number(asientoId), fecha: fac.fecha_emision, asiento } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ANULAR un asiento. Con la clave del administrador: no se borra, queda a la
// vista con quién lo anuló y cuándo, y la factura vuelve a poder contabilizarse.
router.post('/asientos/:id/anular', requireAdmin, async (req, res) => {
  const db = getDb();
  try {
    const motivo = val(req.body && req.body.motivo);
    const password = (req.body && req.body.password) || '';
    if (!motivo) return res.status(400).json({ ok: false, error: 'Escribí por qué se anula: queda en el libro' });
    if (!password) return res.status(400).json({ ok: false, error: 'Falta la clave del administrador' });

    // La clave del que está anulando. Anular un asiento mueve la contabilidad:
    // no puede salir de una sesión abierta y olvidada.
    const u = db.prepare('SELECT id, password_hash FROM usuarios WHERE id=?').get(uid(req));
    if (!u || !u.password_hash) {
      return res.status(400).json({ ok: false, error: 'Tu usuario no tiene clave configurada' });
    }
    const bcrypt = (await import('bcrypt')).default;
    if (!(await bcrypt.compare(String(password), u.password_hash))) {
      return res.status(403).json({ ok: false, error: 'La clave no es correcta' });
    }

    const a = db.prepare('SELECT id, anulado FROM sg_asientos WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ ok: false, error: 'Asiento no encontrado' });
    if (a.anulado) return res.status(400).json({ ok: false, error: 'Ese asiento ya está anulado' });

    db.transaction(() => {
      // El asiento NO se borra: queda con su marca de anulado, quién y cuándo,
      // y el motivo pegado a la descripción para que se lea en el libro.
      db.prepare(`UPDATE sg_asientos SET anulado=1, anulado_por=?, anulado_en=datetime('now','localtime'),
        descripcion = descripcion || ' — ANULADO: ' || ? WHERE id=?`).run(uid(req), motivo, a.id);
      // Las líneas se dejan: son la prueba de qué decía el asiento que se anuló.
      // El módulo contable ya filtra por sg_asientos.anulado.
      // La factura vuelve a quedar sin contabilizar, para poder rehacerla.
      db.prepare('UPDATE sg_facturas_compra SET asiento_id=NULL WHERE asiento_id=?').run(a.id);
    })();
    res.json({ ok: true, data: { id: Number(a.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── DIARIO IVA COMPRAS ───────────────────────────────────────────────────
// Todas las facturas de compra CONTABILIZADAS, vengan de donde vengan. Es el
// libro que se mira para el IVA del período y del que salen los datos que pide
// AFIP: fecha, comprobante, CUIT, neto, IVA discriminado y percepciones.
//
// Las anuladas se listan igual, marcadas: un libro con agujeros no se puede
// explicar. Por eso también se ven las que perdieron su asiento.
router.get('/diario-iva-compras', requireAuth, (req, res) => {
  const db = getDb();
  try {
    // Al anular, la factura pierde su asiento_id: por eso "incluir anulados" es
    // dejar de exigir que lo tenga, y el asiento anulado se encuentra por su
    // ref_compra_id. Antes esto hacía where.pop(), que con fechas se llevaba el
    // filtro de "hasta" y dejaba un parámetro suelto.
    const verAnulados = req.query.incluir_anulados === '1';
    const where = ['f.activo=1'], params = [];
    if (!verAnulados) where.push('f.asiento_id IS NOT NULL');
    else where.push(`(f.asiento_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM sg_asientos an WHERE an.ref_compra_id = f.id AND an.anulado = 1))`);
    if (req.query.desde) { where.push('f.fecha_emision >= ?'); params.push(req.query.desde); }
    if (req.query.hasta) { where.push('f.fecha_emision <= ?'); params.push(req.query.hasta); }
    const rows = db.prepare(`
      SELECT f.id, f.fecha_emision, f.tipo_comprobante, f.punto_venta, f.numero, f.cuit_emisor,
             f.neto, f.iva_alicuota, f.iva_monto, f.percepcion_iva, f.percepcion_iibb,
             f.percepcion_ganancias, f.otros_conceptos, f.total, f.cae, f.asiento_id,
             p.razon_social AS proveedor_nombre,
             -- El asiento vigente si lo tiene; si se anuló, el anulado, que es
             -- el que hay que mostrar tachado.
             COALESCE(a.anulado, an.anulado) AS anulado,
             COALESCE(a.anulado_en, an.anulado_en) AS anulado_en,
             COALESCE(f.asiento_id, an.id) AS asiento_ref,
             (SELECT GROUP_CONCAT(o.trazabilidad, ' · ') FROM sg_factura_compra_ocs fo
                JOIN sg_oc o ON o.id=fo.oc_id WHERE fo.factura_id=f.id) AS partidas
        FROM sg_facturas_compra f
        LEFT JOIN sg_proveedores p ON p.id = f.proveedor_id
        LEFT JOIN sg_asientos a ON a.id = f.asiento_id
        LEFT JOIN sg_asientos an ON an.ref_compra_id = f.id AND an.anulado = 1
       WHERE ${where.join(' AND ')}
       ORDER BY f.fecha_emision DESC, f.id DESC`).all(...params);

    // Los totales del período: es lo que se compara contra la declaración.
    const t = { neto: 0, iva: 0, percepciones: 0, total: 0 };
    for (const x of rows) {
      if (x.anulado) continue;                    // lo anulado no suma
      t.neto = r2(t.neto + (x.neto || 0));
      t.iva = r2(t.iva + (x.iva_monto || 0));
      t.percepciones = r2(t.percepciones + (x.percepcion_iva || 0) + (x.percepcion_iibb || 0)
        + (x.percepcion_ganancias || 0));
      t.total = r2(t.total + (x.total || 0));
    }
    res.json({ ok: true, data: { filas: rows, totales: t } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Partidas de precio cerrado a las que todavía no se les cargó la factura del
// proveedor. El número de factura se carga en el paso 1 de la recepción.
router.get('/partidas-a-facturar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = partidasRecibidas(db, 'firme').filter((r) => !r.facturas);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Cargar la factura del proveedor sobre una partida ya recibida. Se guarda en su
// recepción, que es donde vive el resto de la documentación del camión.
router.post('/oc/:id/factura', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const numero = val(req.body && req.body.factura_numero);
    if (!numero) return res.status(400).json({ ok: false, error: 'Escribí el número de factura' });
    const rec = db.prepare(`SELECT id FROM sg_recepciones
      WHERE oc_id=? AND activo=1 ORDER BY id DESC LIMIT 1`).get(req.params.id);
    if (!rec) return res.status(400).json({ ok: false, error: 'Esa orden todavía no recibió mercadería' });
    db.prepare(`UPDATE sg_recepciones SET factura_numero=?,
      modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
      .run(numero, uid(req), rec.id);
    res.json({ ok: true, data: { id: Number(req.params.id), factura_numero: numero } });
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
      SELECT o.*, p.razon_social AS proveedor_nombre,
             -- Kilos que ya entraron por esta orden. La bandeja de recepciones
             -- necesita saber cuánto falta sin abrir cada orden de a una.
             (SELECT COALESCE(SUM(l.kg_reales), 0)
                FROM sg_lotes l
                JOIN sg_oc_items i ON i.id = l.oc_item_id
               WHERE i.oc_id = o.id AND l.activo = 1) AS kg_recibidos_total,
             -- En cuántas veces entró la mercadería, y con qué remitos. Sin
             -- esto había que listar las recepciones en una tabla aparte, que
             -- para la orden que entró de una sola vez repetía la misma fila.
             (SELECT COUNT(*) FROM sg_recepciones r
               WHERE r.oc_id = o.id AND r.activo = 1) AS entradas,
             (SELECT GROUP_CONCAT(r.numero_remito_proveedor, ' · ')
                FROM sg_recepciones r
               WHERE r.oc_id = o.id AND r.activo = 1
                 AND r.numero_remito_proveedor IS NOT NULL
                 AND r.numero_remito_proveedor <> '') AS remitos_proveedor
      FROM sg_oc o LEFT JOIN sg_proveedores p ON p.id=o.proveedor_id
      WHERE ${where.join(' AND ')} ORDER BY o.id DESC`).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Detalle OC (cabecera + items + vencimientos)
router.get('/oc/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const oc = db.prepare(`SELECT o.*, p.razon_social AS proveedor_nombre,
      -- En cuántas veces entró mercadería por esta orden. La bandeja de
      -- pendientes lo necesita para saber si la orden ya recibió algo: una que
      -- no recibió nada se anula, no se da por terminada.
      (SELECT COUNT(*) FROM sg_recepciones r WHERE r.oc_id=o.id AND r.activo=1) AS entradas
      FROM sg_oc o
      LEFT JOIN sg_proveedores p ON p.id=o.proveedor_id WHERE o.id=?`).get(req.params.id);
    if (!oc) return res.status(404).json({ ok: false, error: 'No encontrado' });
    oc.items = db.prepare(`SELECT i.*, pr.nombre AS producto_nombre, ps.nombre AS presentacion_nombre,
      -- Los kilos por cajón, con el mismo escalón que usa la recepción: si el
      -- ítem no los tiene (las órdenes viejas quedaron en NULL), los da la
      -- presentación. Sin esto el asistente muestra 0 kg y el operador cree que
      -- tiene que pesar sí o sí.
      COALESCE(i.kg_por_bulto, ps.factor_conversion) AS kg_por_bulto_efectivo,
      (SELECT COALESCE(SUM(kg_reales),0) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS kg_recibidos,
      -- Los BULTOS que entraron de verdad. La orden se pacta en bultos y se
      -- controla en bultos: es la columna que mira el comprador contra el remito.
      (SELECT COALESCE(SUM(bultos),0) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS bultos_recibidos
      FROM sg_oc_items i
      LEFT JOIN sg_productos pr ON pr.id=i.producto_id
      LEFT JOIN sg_presentaciones ps ON ps.id=i.presentacion_id
      WHERE i.oc_id=?`).all(req.params.id);
    oc.vencimientos = db.prepare('SELECT * FROM sg_oc_vencimientos WHERE oc_id=? ORDER BY cuota_orden').all(req.params.id);
    // Lo pactado contra lo que entró. Si algo no da, la orden recibida lo avisa
    // arriba de todo para que el comprador pueda ajustar el precio.
    oc.diferencias = diferenciasDeOC(db, req.params.id);
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
    // BRIEF 8 (D3) — al anular la OC, cancelar las reservas tipo='oc_item' activas de sus items y
    // avisar qué pedidos quedan afectados (su reserva en tránsito ya no existe).
    const itemIds = db.prepare('SELECT id FROM sg_oc_items WHERE oc_id=?').all(req.params.id).map(x => x.id);
    let pedidosAfectados = [];
    const tx = db.transaction(() => {
      db.prepare("UPDATE sg_oc SET estado='anulada', modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?").run(uid(req), req.params.id);
      db.prepare('DELETE FROM sg_oc_vencimientos WHERE oc_id=? AND pagado=0').run(req.params.id);
      if (itemIds.length) {
        const ph = itemIds.map(() => '?').join(',');
        pedidosAfectados = db.prepare(`SELECT DISTINCT pe.numero FROM sg_reservas rs
          JOIN sg_pedido_items pi ON pi.id=rs.pedido_item_id JOIN sg_pedidos pe ON pe.id=pi.pedido_id
          WHERE rs.oc_item_id IN (${ph}) AND rs.tipo='oc_item' AND rs.estado='activa'`).all(...itemIds).map(x => x.numero);
        db.prepare(`UPDATE sg_reservas SET estado='cancelada' WHERE oc_item_id IN (${ph}) AND tipo='oc_item' AND estado='activa'`).run(...itemIds);
      }
    });
    tx();
    if (pedidosAfectados.length) console.warn(`[SG] OC ${req.params.id} anulada — reservas en tránsito canceladas. Pedidos afectados: ${pedidosAfectados.join(', ')}`);
    res.json({ ok: true, data: { id: Number(req.params.id), pedidos_afectados: pedidosAfectados } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── DAR POR TERMINADA UNA ORDEN ──────────────────────────────────────────────
// El estado se recalculaba solo, por kilos, y no había forma de decir "esto ya
// está". Una orden de 1188 kg de la que entraron 38 quedaba en 'recibida_parcial'
// para siempre: seguía en la bandeja de pendientes y sus 1150 kg se seguían
// ofreciendo como mercadería en camino cada vez que alguien armaba un pedido.
//
// El estado que se escribe es 'cerrada', que ya existía en el CHECK de la tabla,
// ya tenía badge y ya estaba en el filtro de OC recibidas, pero no lo escribía
// nadie. Se muestra como "Confirmada". Marcarla 'recibida_total' hubiera sido
// mentir en tres pantallas: 'Recibida total' sobre 38 de 1188 kg.
router.post('/oc/:id/cerrar', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const oc = db.prepare('SELECT id, estado, cerrada_en FROM sg_oc WHERE id=? AND activo=1').get(req.params.id);
    if (!oc) return res.status(404).json({ ok: false, error: 'No encontrada' });
    if (oc.estado === 'anulada') return res.status(400).json({ ok: false, error: 'La orden está anulada' });
    if (oc.cerrada_en) return res.status(400).json({ ok: false, error: 'La orden ya está confirmada' });

    // Sin una sola recepción no hay nada que confirmar: una orden que no recibió
    // NADA se anula, no se da por terminada. Cerrarla dejaría su deuda estimada
    // en la cuenta del proveedor como si la mercadería hubiera entrado.
    const entradas = db.prepare('SELECT COUNT(*) c FROM sg_recepciones WHERE oc_id=? AND activo=1').get(oc.id).c;
    if (!entradas) {
      return res.status(400).json({ ok: false,
        error: 'Esta orden todavía no recibió nada. Si no va a entrar, anulala en vez de confirmarla.' });
    }

    // ¿Quedó saldo? Se mide por ítem, igual que el estado.
    const items = db.prepare(`SELECT i.id, i.kg_estimados,
      (SELECT COALESCE(SUM(kg_reales),0) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS recibido
      FROM sg_oc_items i WHERE i.oc_id=?`).all(oc.id);
    const falta = items.reduce((a, it) => a + Math.max(0, (it.kg_estimados || 0) - it.recibido), 0);
    const motivo = val(req.body && req.body.motivo);
    // Con saldo, el motivo es obligatorio: la orden va a quedar diciendo que
    // faltaron kilos y alguien tiene que poder leer por qué no van a venir.
    if (falta > 0.01 && !motivo) {
      return res.status(400).json({ ok: false,
        error: 'Faltan ' + Math.round(falta) + ' kg de esta orden: escribí por qué se da por terminada.' });
    }

    // Los lotes de pizarra sin precio cerrado se AVISAN, no se bloquean. Una
    // compra de liquidación se cierra cuando se vende la mercadería, y eso puede
    // ser semanas después de recibirla: exigir el precio para dar la orden por
    // terminada mezclaría terminar de RECIBIR con terminar de LIQUIDAR. Y no hay
    // nada que se pierda: POST /lotes/:id/cerrar-precio no mira el estado de la
    // orden, así que el precio se sigue pudiendo cerrar después.
    const sinPrecio = db.prepare(`SELECT l.codigo_lote FROM sg_lotes l
      JOIN sg_oc_items i ON i.id=l.oc_item_id
      WHERE i.oc_id=? AND l.activo=1 AND l.precio_unitario_kg IS NULL`).all(oc.id).map(x => x.codigo_lote);

    // Las reservas en tránsito contra esta orden se cancelan, igual que al anular:
    // la mercadería que se decidió que no llega no puede seguir comprometida con
    // un cliente. Es la doctrina que el módulo ya tenía escrita (D2).
    const itemIds = items.map(x => x.id);
    let pedidosAfectados = [];
    db.transaction(() => {
      db.prepare(`UPDATE sg_oc SET estado='cerrada', cerrada_en=datetime('now','localtime'),
        cerrada_por=?, cierre_motivo=?, modificado_en=datetime('now','localtime'), modificado_por=?
        WHERE id=?`).run(uid(req), motivo, uid(req), oc.id);
      if (itemIds.length) {
        const ph = itemIds.map(() => '?').join(',');
        pedidosAfectados = db.prepare(`SELECT DISTINCT pe.numero FROM sg_reservas rs
          JOIN sg_pedido_items pi ON pi.id=rs.pedido_item_id JOIN sg_pedidos pe ON pe.id=pi.pedido_id
          WHERE rs.oc_item_id IN (${ph}) AND rs.tipo='oc_item' AND rs.estado='activa'`).all(...itemIds).map(x => x.numero);
        db.prepare(`UPDATE sg_reservas SET estado='cancelada'
          WHERE oc_item_id IN (${ph}) AND tipo='oc_item' AND estado='activa'`).run(...itemIds);
      }
    })();
    if (pedidosAfectados.length) {
      console.warn(`[SG] OC ${oc.id} confirmada — reservas en tránsito canceladas. Pedidos afectados: ${pedidosAfectados.join(', ')}`);
    }
    res.json({ ok: true, data: { id: Number(oc.id), kg_faltantes: +falta.toFixed(2),
      pedidos_afectados: pedidosAfectados, lotes_sin_precio: sinPrecio } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Reabrir: la mercadería que se daba por perdida apareció. Se saca el cerrojo y
// el estado vuelve a salir de la cuenta de kilos.
//
// LAS RESERVAS CANCELADAS NO VUELVEN. Cancelar es definitivo —el comercial ya
// rearmó el pedido con otra mercadería— y resucitarlas comprometería kilos que
// hoy pueden estar prometidos a otro cliente. Hay que volver a reservar a mano.
router.post('/oc/:id/reabrir', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const oc = db.prepare('SELECT id, cerrada_en FROM sg_oc WHERE id=? AND activo=1').get(req.params.id);
    if (!oc) return res.status(404).json({ ok: false, error: 'No encontrada' });
    if (!oc.cerrada_en) return res.status(400).json({ ok: false, error: 'La orden no está confirmada' });
    // Vuelve a 'abierta', no a lo que digan los kilos: reabrir es decir "esta
    // orden espera mercadería otra vez". Recalculando, una orden que ya recibió
    // algo volvería a quedar 'recibida_total' y no podría recibir nada — reabrir
    // no serviría para nada.
    db.transaction(() => {
      db.prepare(`UPDATE sg_oc SET estado='abierta', cerrada_en=NULL, cerrada_por=NULL, cierre_motivo=NULL,
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`).run(uid(req), oc.id);
    })();
    const est = db.prepare('SELECT estado FROM sg_oc WHERE id=?').get(oc.id).estado;
    res.json({ ok: true, data: { id: Number(oc.id), estado: est } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── RECEPCIONES ──────────────────────────────────────────────────────────────

// Recibir mercadería: crea recepción + lotes (con división por calidad), recalcula costos y vencimientos.
// BLOQUE A+B — multipart: campos de texto en req.body.payload (JSON) + fotos en req.files.
// upload.array corre primero para poblar req.body/req.files; requireAdmin no lee el body.
router.post('/recepciones', sgUpload.array('fotos', 40), requireAdmin, (req, res) => {
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
      // Confirmada = alguien dijo que esta orden terminó. Si igual apareció
      // mercadería, primero se reabre: recibir con el cerrojo puesto grabaría
      // los lotes sin que el estado se entere, y la orden quedaría diciendo que
      // recibió menos de lo que tiene adentro.
      if (oc.cerrada_en) {
        return res.status(400).json({ ok: false,
          error: 'La orden está confirmada. Reabrila desde OC recibidas para poder recibir.' });
      }
      // UNA ORDEN SE RECIBE UNA SOLA VEZ. El camión llega, se cuenta, se pesa, y
      // con eso la orden queda firme por lo que entró. Recibir de a pedazos
      // partía la partida en lotes sueltos y dejaba la orden colgada en la
      // bandeja de pendientes para siempre.
      //
      // Se mira el ESTADO y no la cantidad de recepciones, porque reabrir una
      // orden es la excepción deliberada: la vuelve a poner en 'abierta' y con
      // eso vuelve a aceptar mercadería. Contando recepciones, reabrir no habría
      // servido para nada — que es de lo único que sirve.
      if (oc.estado === 'recibida_total' || oc.estado === 'cerrada') {
        return res.status(400).json({ ok: false,
          error: 'Esta orden ya se recibió. La mercadería de una orden entra de una sola vez: '
               + 'si llegó algo más, reabrila desde OC recibidas, o hacé una orden nueva.' });
      }
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
         observada, calidad_estado_general, calidad_defectos, calidad_pct_afectado, calidad_observaciones, oc_pendiente,
         con_descarga, hay_variaciones, variacion_motivo, peso_recepcionado)
        VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?, ?,?,?,?)`).run(
        sinOC ? null : b.oc_id, numero, fechaIngreso, b.recibido_por || null, val(b.numero_remito_proveedor), val(b.observaciones), uid(req),
        val(b.factura_numero), val(b.dtv_codigo), numN(b.pallets_recibidos), numN(b.bultos_recibidos),
        b.observada ? 1 : 0, val(b.calidad_estado_general), val(b.calidad_defectos), numN(b.calidad_pct_afectado), val(b.calidad_observaciones),
        sinOC ? 1 : 0,
        // "Hubo descarga" se pregunta y se guarda. Antes el único indicio era si
        // habían elegido cooperativa: "no hubo" y "me olvidé" se veían igual.
        (b.con_descarga === undefined || b.con_descarga === null) ? null : (b.con_descarga ? 1 : 0),
        (b.hay_variaciones === undefined || b.hay_variaciones === null) ? null : (b.hay_variaciones ? 1 : 0),
        val(b.variacion_motivo), numN(b.peso_recepcionado));
      const recId = recInfo.lastInsertRowid;
      // ── LAS FOTOS, SIEMPRE Y ROTULADAS ────────────────────────────────
      // Antes sólo se guardaban las del informe de calidad. Ahora entra todo lo
      // que el operador saca —el remito, la mercadería, la balanza, lo que
      // justifica una diferencia— y cada foto sabe de qué es. Un montón de
      // fotos sin decir qué muestran no sirve cuando hay que reclamarle a un
      // proveedor tres semanas después.
      //
      // La categoría viaja en un arreglo paralelo, en el mismo orden en que se
      // subieron los archivos: multer conserva el orden dentro de un mismo
      // campo. Si falta o no coincide, la foto se guarda igual sin categoría —
      // perder la foto por no saber rotularla sería peor.
      // La metadata viaja como UN arreglo de objetos alineado con los archivos,
      // no como dos arreglos paralelos. Con dos, un desfase de un solo elemento
      // no perdía la foto: le adjudicaba la balanza AL ARTÍCULO EQUIVOCADO, que
      // es peor, porque nadie lo nota.
      const meta = Array.isArray(b.fotos_meta) ? b.fotos_meta
        : (Array.isArray(b.fotos_categorias) ? b.fotos_categorias.map((c) => ({ categoria: c })) : []);
      const VALIDAS = ['documentacion', 'mercaderia', 'peso', 'variacion', 'calidad'];
      // Los ítems que de verdad son de esta orden: una foto no puede quedar
      // colgada de un ítem de otra compra.
      const itemsOk = new Set(items.map((it) => Number(it.oc_item_id)).filter(Boolean));
      (req.files || []).forEach((f, i) => {
        const m = meta[i] || {};
        const cat = VALIDAS.includes(m.categoria) ? m.categoria : null;
        const it = itemsOk.has(Number(m.oc_item_id)) ? Number(m.oc_item_id) : null;
        db.prepare(`INSERT INTO sg_recepcion_fotos
          (recepcion_id, ruta, nombre_original, creado_por, categoria, oc_item_id) VALUES (?,?,?,?,?,?)`)
          .run(recId, '/data/sg/' + f.filename, f.originalname || null, uid(req), cat, it);
      });
      // EL INFORME DE CALIDAD, PRODUCTO POR PRODUCTO. Se ata al ítem de la
      // ORDEN porque los lotes todavía no existen y un ítem puede dar varios.
      // Sólo se guarda la línea del producto que vino observado: guardar una
      // fila vacía por cada producto sano llenaría la tabla de nada.
      for (const c of (Array.isArray(b.calidad_items) ? b.calidad_items : [])) {
        if (!c || !c.observada) continue;
        const itemOk = items.some((it) => Number(it.oc_item_id) === Number(c.oc_item_id));
        db.prepare(`INSERT INTO sg_recepcion_calidad
          (recepcion_id, oc_item_id, producto_id, observada, estado_general, defectos, pct_afectado, observaciones, creado_por)
          VALUES (?,?,?,1,?,?,?,?,?)`).run(
            recId, itemOk ? Number(c.oc_item_id) : null,
            c.producto_id ? Number(c.producto_id) : null,
            val(c.estado_general), val(c.defectos), numN(c.pct_afectado), val(c.observaciones), uid(req));
      }

      // FASE 2 — si se asignó cooperativa, queda una DESCARGA DE INGRESO pendiente. La unidad
      // (bulto/pallet) define la cantidad: bultos_recibidos o pallets_recibidos de la recepción.
      // La cooperativa se elige del catálogo (Control Cooperativa) y de ahí sale
      // el proveedor al que se le paga. El gasto sigue apuntando al PROVEEDOR
      // —de ahí cuelga toda la valorización— y además guarda qué cuadrilla
      // trabajó. Se acepta todavía un proveedor suelto para no romper lo que ya
      // esté cargado, pero lo que manda el asistente es la cooperativa.
      const coopCatId = b.cooperativa_catalogo_id ? Number(b.cooperativa_catalogo_id) : null;
      let coopId = b.cooperativa_id ? Number(b.cooperativa_id) : null;
      if (coopCatId) {
        const c = db.prepare('SELECT id, proveedor_id FROM sg_cooperativas WHERE id=? AND activo=1').get(coopCatId);
        if (!c) throw new Error('La cooperativa elegida no existe o está dada de baja');
        coopId = c.proveedor_id;
      }
      const coopUnidad = b.cooperativa_unidad === 'pallet' ? 'pallet' : 'bulto';
      const coopCant = coopUnidad === 'pallet' ? numN(b.pallets_recibidos) : numN(b.bultos_recibidos);
      syncGastoCoop(db, { tipo: 'descarga_ingreso', recepcionId: recId, proveedorId: coopId, cooperativaId: coopCatId, unidad: coopUnidad, cantidad: coopCant, fechaServicio: fechaIngreso, userId: uid(req) });
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
          concretarReservasOcItem(db, ocItem.id, ids, uid(req));   // BRIEF 8 — reservas oc_item → lote (FIFO×FEFO)
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
      SELECT r.*, o.numero AS oc_numero, o.trazabilidad AS partida, p.razon_social AS proveedor_nombre,
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
    const rec = db.prepare(`SELECT r.*, o.numero AS oc_numero, o.trazabilidad AS partida
      FROM sg_recepciones r LEFT JOIN sg_oc o ON o.id=r.oc_id WHERE r.id=?`).get(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'No encontrado' });
    // El informe de calidad POR PRODUCTO, para la pantalla y para el PDF.
    rec.calidad = db.prepare(`SELECT c.*, p.nombre AS producto_nombre
      FROM sg_recepcion_calidad c
      LEFT JOIN sg_productos p ON p.id = c.producto_id
      WHERE c.recepcion_id = ? ORDER BY c.id`).all(req.params.id);
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
    // Mismo motivo que al recibir: con el cerrojo puesto los lotes entrarían sin
    // que el estado de la orden se entere.
    if (oc.cerrada_en) {
      return res.status(400).json({ ok: false,
        error: 'La orden está confirmada. Reabrila desde OC recibidas para poder vincularle esta recepción.' });
    }

    const out = db.transaction(() => {
      db.prepare("UPDATE sg_recepciones SET oc_id=?, oc_pendiente=0, modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?")
        .run(ocId, uid(req), req.params.id);
      const lotes = db.prepare('SELECT id, producto_id, kg_reales, codigo_lote FROM sg_lotes WHERE recepcion_id=? AND activo=1').all(req.params.id);
      let conPrecio = 0;
      for (const l of lotes) {
        const ocItem = db.prepare('SELECT id, precio_estimado_por_kg FROM sg_oc_items WHERE oc_id=? AND producto_id=? ORDER BY id LIMIT 1').get(ocId, l.producto_id);
        if (!ocItem) continue; // producto no está en la OC → el lote queda pendiente
        const precio = (oc.tipo_precio === 'firme' && ocItem.precio_estimado_por_kg != null) ? Number(ocItem.precio_estimado_por_kg) : null;
        const costoBase = precio != null ? l.kg_reales * precio : 0;
        // Y AHORA EL LOTE SE LLAMA COMO LA PARTIDA. Este es el camino del camión
        // que llega sin la orden cargada: la recepción entra sin OC y sus lotes
        // nacen con el número viejo, que ahí es lo correcto porque todavía no hay
        // partida de la cual colgar. Al vincularla, esa mercadería SÍ pasa a
        // tener número de orden — y si no se renumera acá, queda para siempre
        // identificada con un número paralelo.
        //
        // El código se calcula ANTES de atar el lote al ítem: codigoLoteDePartida
        // cuenta los lotes que ya cuelgan de la orden, y si este ya estuviera
        // atado se contaría a sí mismo. El primero saldría .2 y el .1 no
        // existiría nunca — un lote que parece perdido al rastrear el remito.
        const codigoNuevo = codigoLoteDePartida(db, ocItem.id) || l.codigo_lote;
        db.prepare(`UPDATE sg_lotes SET oc_item_id=?, codigo_lote=?, precio_unitario_kg=?, costo_base=?,
          modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
          .run(ocItem.id, codigoNuevo, precio, costoBase, uid(req), l.id);
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
router.post('/recepciones/preview-calidad.pdf', sgUploadMem.array('fotos', 40), requireAuth, async (req, res) => {
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
      // EL NÚMERO DE PARTIDA, TAMBIÉN ACÁ. La compra retroactiva nacía sin él, y
      // eso se veía dos pantallas más adelante: sin trazabilidad en la orden,
      // codigoLoteDePartida() no tiene de dónde sacar el código y el lote caía al
      // numerador viejo (SG-LT-AAAAMMDD-NNNN). Después el backfill del arranque le
      // ponía la partida a la orden, pero el lote ya había nacido con otro número:
      // la cabecera decía 0034.12.08.2026.03 y el lote de abajo, SG-LT-20260812-0001.
      // Se calcula adentro de la transacción, igual que en el alta normal.
      const trazaRetro = codigoTrazabilidad(db, b.proveedor_id, fechaIngreso).codigo;
      const ocInfo = db.prepare(`INSERT INTO sg_oc
        (numero, modalidad, proveedor_id, tipo_fiscal, tipo_precio, condicion_pago_id, fecha_oc, fecha_recepcion_estimada,
         comercial_id, estado, observaciones, total_estimado_kg, total_estimado_monto, creado_por, trazabilidad)
        VALUES (?, 'retroactiva', ?,?,?,?,?,?,?, 'recibida_total', ?, 0, 0, ?, ?)`).run(
        numeroOC, b.proveedor_id || null, dft.tipo_fiscal, tipoPrecio, dft.condicion_pago_id,
        fechaIngreso, fechaIngreso, b.comercial_id || null, val(b.observaciones), uid(req), trazaRetro);
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
        const ocItem = { id: itInfo.lastInsertRowid, producto_id: it.producto_id, precio_estimado_por_kg: precio, presentacion_id: it.presentacion_id || null };
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
    if (req.query.semaforo) { where.push('l.semaforo=?'); params.push(req.query.semaforo); }       // filtro planilla de stock
    if (req.query.familia) { where.push('pr.familia=?'); params.push(req.query.familia); }           // categoría = familia del producto
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
        COALESCE(l.kg_por_bulto, ps.factor_conversion) AS kg_por_bulto,
        CAST(julianday(l.fecha_vencimiento_estimada) - julianday(date('now','localtime')) AS INTEGER) AS dias_restantes,
        ${KG_VIGENTE_STOCK} AS kg_vigente,     -- vigentes = kg_reales − decomiso − transf/reproceso
        ${KG_DISPONIBLE} AS kg_disponibles     -- disponibles = vigentes − despachado
      FROM sg_lotes l
      LEFT JOIN sg_productos pr ON pr.id=l.producto_id
      LEFT JOIN sg_presentaciones ps ON ps.id=l.presentacion_id
      LEFT JOIN sg_recepciones r ON r.id=l.recepcion_id
      LEFT JOIN sg_oc o ON o.id=r.oc_id
      LEFT JOIN sg_proveedores pv ON pv.id=o.proveedor_id
      WHERE ${where.join(' AND ')} ORDER BY l.fecha_vencimiento_estimada ASC, l.id DESC`).all(...params);
    res.json({ ok: true, data: rows.map(derivarBultosLote) });
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
    // CG1 — un gasto global ya no afecta ningún costo_final (va a resultado) → no se recalcula nada.
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
    // CG1 — un gasto global ya no afecta ningún costo_final (va a resultado) → no se recalcula nada.
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.delete('/gastos-globales/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const g = db.prepare('SELECT periodo FROM sg_gastos_globales_periodo WHERE id=? AND activo=1').get(req.params.id);
    if (!g) return res.status(404).json({ ok: false, error: 'No encontrado o ya eliminado' });
    db.prepare("UPDATE sg_gastos_globales_periodo SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=? WHERE id=?").run(uid(req), req.params.id);
    // CG1 — un gasto global ya no afecta ningún costo_final (va a resultado) → no se recalcula nada.
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

    // CG1 — los gastos del período ya NO se capitalizan al lote (van a resultado), así que el detalle
    // de trazabilidad no muestra prorrateo. El front omite la línea (render guardado por `if(d.prorrateo)`);
    // la limpieza de ese branch muerto + el rename del módulo es CG2.
    const prorrateo = null;

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
    db.transaction(() => { out = crearLoteTransformado(db, { origen, productoDestinoId, kg, factor,
      presentacionId: req.body?.presentacion_id, bultos: req.body?.bultos, userId: uid(req) }); })();
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

    const madre = db.prepare(`SELECT id, producto_id, kg_reales, bultos, costo_final, calibre, origen,
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

    // F4-C1 — CONSERVACIÓN EN CAJONES (cuando hay bultos). El cajón es indivisible: rechazar
    // fracciones en cualquier hijo. Si la madre opera en cajones → igualdad exacta entera
    // bultos_procesados == Σ bultos hijos + bultos merma, y ≤ bultos disponibles. Si la madre es
    // GRANEL (kg, sin cajones) pero los hijos nacen en cajones → NO hay igualdad madre↔hijos (la
    // madre no tiene cajones que conservar): solo se exigen hijos enteros (>0). Full kg legacy
    // (sin bultos en ningún lado) → el check kg de arriba basta.
    for (const h of hijos) {
      if (h.bultos != null && h.bultos !== '' && Math.abs(Number(h.bultos) - Math.round(Number(h.bultos))) > 1e-6) {
        return res.status(400).json({ ok: false, error: `Hijo con fracción de cajón (${Number(h.bultos)} bultos): el cajón es entero` });
      }
    }
    const sumaBultosHijos = hijos.reduce((a, h) => a + (Number(h.bultos) || 0), 0);
    let bultosProcReproceso = null, bultosMermaReproceso = null;
    if (madre.bultos != null) {
      // madre-bulto: conservación completa.
      if (!hijos.every(h => Number(h.bultos) > 0)) {
        return res.status(400).json({ ok: false, error: 'La madre opera en cajones: cada hijo necesita bultos enteros > 0' });
      }
      const bultosMerma = (b.bultos_merma != null && b.bultos_merma !== '') ? Number(b.bultos_merma) : 0;
      if (bultosMerma < 0 || Math.abs(bultosMerma - Math.round(bultosMerma)) > 1e-6) {
        return res.status(400).json({ ok: false, error: 'bultos_merma debe ser un entero ≥ 0 (cajón indivisible)' });
      }
      const bultosProcesados = (b.bultos_procesados != null && b.bultos_procesados !== '') ? Number(b.bultos_procesados) : (sumaBultosHijos + bultosMerma);
      if (Math.abs(bultosProcesados - Math.round(bultosProcesados)) > 1e-6) {
        return res.status(400).json({ ok: false, error: 'bultos_procesados debe ser entero (cajón indivisible)' });
      }
      if (Math.round(bultosProcesados) !== sumaBultosHijos + Math.round(bultosMerma)) {
        return res.status(400).json({ ok: false, error: `Los cajones no cuadran: procesados ${Math.round(bultosProcesados)}, hijos ${sumaBultosHijos}, merma ${Math.round(bultosMerma)} (${sumaBultosHijos}+${Math.round(bultosMerma)}=${sumaBultosHijos + Math.round(bultosMerma)})` });
      }
      const dispB = bultosDisponibles(db, madre.id);
      if (dispB != null && Math.round(bultosProcesados) > dispB) {
        return res.status(400).json({ ok: false, error: `No podés reprocesar ${Math.round(bultosProcesados)} cajón(es): la madre tiene ${dispB} disponible(s)` });
      }
      bultosProcReproceso = Math.round(bultosProcesados);
      bultosMermaReproceso = Math.round(bultosMerma);
    }
    // CASO GRANEL→BULTO (madre.bultos == null y algún hijo con bultos): solo se exigen hijos enteros
    // (ya validado arriba). La madre se procesa por kg (el check kg gobierna kg_procesados); el
    // reproceso no registra bultos_procesados (la madre no tiene cajones). bultos_merma no aplica.

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
      // F4-B — reparto PLANO POR CAJÓN cuando todos los hijos vendibles tienen bultos (>0): mismo
      // costo a cada cajón (1ra y 2da igual) = totalRepartir / Σ bultos. El costo de la merma lo
      // absorben los cajones vendibles (totalRepartir ya incluye el costo de los kg de merma).
      // FALLBACK: si algún hijo no tiene bultos (granel/kg puro legacy) → reparto por kg como antes.
      // En ambos casos el último hijo absorbe el redondeo para que Σ costo_final == totalRepartir exacto.
      const totalBultos = hijos.reduce((a, h) => a + (Number(h.bultos) || 0), 0);
      const planoPorCajon = totalBultos > 0 && hijos.every(h => Number(h.bultos) > 0);
      let acum = 0;
      hijos.forEach((h, i) => {
        const cuota = planoPorCajon
          ? (totalRepartir * (Number(h.bultos) / totalBultos))
          : (totalRepartir * (h.kg / sumaKgHijos));
        h._costo = i === hijos.length - 1 ? +(totalRepartir - acum).toFixed(2) : +cuota.toFixed(2);
        acum = +(acum + h._costo).toFixed(2);
      });
    }

    let out;
    db.transaction(() => {
      const info = db.prepare(`INSERT INTO sg_reprocesos
        (lote_madre_id, kg_procesados, kg_merma, bultos_procesados, bultos_merma, costo_madre_consumido, gasto_proceso, gasto_descripcion, usuario_id)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(madre.id, kgProcesados, kgMerma, bultosProcReproceso, bultosMermaReproceso, costoMadreConsumido, gasto, val(b.gasto_descripcion), uid(req));
      const reprocesoId = info.lastInsertRowid;
      const hijosOut = hijos.map(h => {
        const r = crearLoteHijo(db, { madre, reprocesoId, productoId: h.producto_id, kg: h.kg, costoAsignado: h._costo,
          calidad: h.calidad, semaforo: h.semaforo, presentacionId: h.presentacion_id, bultos: h.bultos, userId: uid(req) });
        return { lote_id: r.loteId, codigo: r.codigoLote, producto_id: h.producto_id, kg: h.kg, calidad: val(h.calidad),
          semaforo: h.semaforo || 'verde', costo_asignado: r.costo, costo_por_kg: +(r.costo / h.kg).toFixed(4),
          presentacion_id: r.presentacion_id, bultos: r.bultos };
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
  const l = db.prepare('SELECT kg_reales, bultos, estado FROM sg_lotes WHERE id=?').get(loteId);
  if (!l || l.estado === 'bajado') return;   // bajado/reservado se preservan igual que antes
  let estado = 'disponible';
  if (l.bultos != null) {
    // F3-C — umbral en BULTOS (cajón entero). vigentes = lote.bultos − Σ bultos decomisados − Σ
    // bultos transformados/reprocesados (activos). Si se despacharon todos los cajones vigentes →
    // total. Son enteros: comparación exacta, sin tolerancia.
    const bultosVig = l.bultos - bultosDecomisado(db, loteId) - bultosTransformado(db, loteId);
    const despB = bultosDespachados(db, loteId);
    if (despB > 0 && despB >= bultosVig) estado = 'despachado_total';
    else if (despB > 0) estado = 'despachado_parcial';
  } else {
    // FALLBACK legacy: lote sin bultos (sin presentación / no migrado) → umbral por kg como antes,
    // sobre kg VIGENTES (kg_reales − Σ decomiso − Σ transformado), con tolerancia 0.01.
    const desp = db.prepare(`SELECT COALESCE(SUM(di.kg_despachados),0) s
      FROM sg_despacho_items di JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
      WHERE di.lote_id=?`).get(loteId).s;
    const kgVig = (l.kg_reales || 0) - kgDecomisado(db, loteId) - kgTransformado(db, loteId);
    if (desp >= kgVig - 0.01 && desp > 0) estado = 'despachado_total';
    else if (desp > 0) estado = 'despachado_parcial';
  }
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

// ── F3-A: disponibilidad en BULTOS, EN PARALELO al de kg (NO conectada a validación/estado/reservas
// todavía; queda disponible para F3-B+). Mismo criterio de estado que kg: decomisos sin estado;
// transformaciones permanentes; reprocesos estado='activo'. Las reservas (blandas) NO se restan. ──
function bultosDespachados(db, loteId) {
  return db.prepare(`SELECT COALESCE(SUM(di.bultos),0) s
    FROM sg_despacho_items di JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
    WHERE di.lote_id=?`).get(loteId).s;
}
function bultosDecomisado(db, loteId) {
  return db.prepare('SELECT COALESCE(SUM(bultos),0) s FROM sg_lote_decomisos WHERE lote_id=?').get(loteId).s;
}
function bultosTransformado(db, loteId) {
  const t = db.prepare('SELECT COALESCE(SUM(bultos_transformados),0) s FROM sg_transformaciones WHERE lote_origen_id=?').get(loteId).s;
  const r = db.prepare("SELECT COALESCE(SUM(bultos_procesados),0) s FROM sg_reprocesos WHERE lote_madre_id=? AND estado='activo'").get(loteId).s;
  return t + r;
}
// bultos disponibles = lote.bultos − Σ bultos de movimientos activos. null si el lote no tiene
// bultos cargados (no contable en cajones). NO toca kg ni se conecta a nada aún.
function bultosDisponibles(db, loteId) {
  const l = db.prepare('SELECT bultos FROM sg_lotes WHERE id=?').get(loteId);
  if (!l || l.bultos == null) return null;
  return l.bultos - bultosDespachados(db, loteId) - bultosDecomisado(db, loteId) - bultosTransformado(db, loteId);
}
// Fragmento SQL espejo de SUM_TRANSF en bultos (transformaciones + reprocesos activos del lote 'l').
const SUM_TRANSF_BULTOS = "(COALESCE((SELECT SUM(bultos_transformados) FROM sg_transformaciones WHERE lote_origen_id=l.id),0)"
  + " + COALESCE((SELECT SUM(bultos_procesados) FROM sg_reprocesos WHERE lote_madre_id=l.id AND estado='activo'),0))";

// ── FUENTE ÚNICA de la fórmula de kg de un lote (ligada al alias `l`) ────────────
// Antes copy-pasteada en /lotes, /lotes-disponibles, /oferta y /disponibilidad. Estos fragmentos
// son la verdad única; cualquier endpoint de lectura los compone. (KG_VIGENTE de costeo —línea
// ~2760— es OTRA cosa: NO resta reprocesos; no se toca acá.)
const SUM_DECOMISO   = "COALESCE((SELECT SUM(kg) FROM sg_lote_decomisos WHERE lote_id=l.id),0)";
const SUM_DESPACHADO = "COALESCE((SELECT SUM(di.kg_despachados) FROM sg_despacho_items di"
  + " JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1 WHERE di.lote_id=l.id),0)";
// kg vigentes (disponibilidad) = kg_reales − Σ decomisos − (transformaciones + reprocesos activos).
const KG_VIGENTE_STOCK = `(l.kg_reales - ${SUM_DECOMISO} - ${SUM_TRANSF})`;
// kg disponibles (vendibles) = kg vigentes − Σ despachado.
const KG_DISPONIBLE = `(l.kg_reales - ${SUM_DECOMISO} - ${SUM_TRANSF} - ${SUM_DESPACHADO})`;

// F2 — bultos derivados de kg (DISPLAY, no altera kg). kg_por_bulto = factor_conversion de la
// presentación del lote (null si no hay presentacion_id). bultos_* = kg_* / kg_por_bulto SIN
// redondear (puede dar fracción — esperado en F2; F3 lo corrige). Muta y devuelve la fila.
function derivarBultosLote(row) {
  const kpb = (row.kg_por_bulto != null && Number(row.kg_por_bulto) > 0) ? Number(row.kg_por_bulto) : null;
  row.kg_por_bulto = kpb;
  row.bultos_vigente     = (kpb != null && row.kg_vigente     != null) ? Number(row.kg_vigente)     / kpb : null;
  row.bultos_disponibles = (kpb != null && row.kg_disponibles != null) ? Number(row.kg_disponibles) / kpb : null;
  // bultos_reservado: si el SQL ya lo trae (F3-D: Σ bultos reservas), se respeta; si no (callers sin
  // esa columna), se deriva de kg_reservado / kg_por_bulto como en F2 (fallback legacy).
  if (row.bultos_reservado == null && row.kg_reservado != null) row.bultos_reservado = (kpb != null) ? Number(row.kg_reservado) / kpb : null;
  return row;
}

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
      // F3-D — reserva en BULTOS ENTEROS (sigue BLANDA: no resta disponible, igual que D1). La unidad
      // operativa es el cajón; se valida entero + ≤ disponible (sanity, no descuento). kg se DERIVA =
      // bultos × kg_por_bulto. FALLBACK: lote/oc_item sin presentación (kpb desconocido) → reserva
      // legacy en kg sin validar por bulto. Ahora persiste también la columna bultos (F3-A).
      const insReserva = db.prepare(`INSERT INTO sg_reservas
        (pedido_item_id, tipo, lote_id, oc_item_id, kg, bultos, origen_oc_item_id, usuario_id)
        VALUES (?,?,?,?,?,?,?,?)`);
      for (const it of items) {
        const pres = it.presentacion_id ? db.prepare('SELECT factor_conversion FROM sg_presentaciones WHERE id=?').get(it.presentacion_id) : null;
        // F3 — factor del pedido: kg por bulto tipeado al vuelo (F1); fallback a la presentación → 1.
        const factor = (it.kg_por_bulto != null && it.kg_por_bulto !== '') ? Number(it.kg_por_bulto) : (pres ? Number(pres.factor_conversion) : 1);
        const cant = Number(it.cantidad_presentaciones || 0);
        const kg = it.kg_solicitados != null ? Number(it.kg_solicitados) : cant * factor;
        const precio = Number(it.precio_por_kg || 0);
        const pedItemId = ins.run(pedidoId, it.producto_id, it.presentacion_id || null, cant, kg, precio, kg * precio).lastInsertRowid;
        for (const rv of (Array.isArray(it.reservas) ? it.reservas : [])) {
          const kgRv = Number(rv.kg || 0);
          // bultos de la reserva: input rv.bultos o, si el front manda kg, derivado del kg. Entero.
          const derivarBultosRv = (kpb) => {
            let bl = (rv.bultos != null && rv.bultos !== '') ? Number(rv.bultos) : kgRv / kpb;
            if (!(bl > 0)) return 0;
            if (Math.abs(bl - Math.round(bl)) > 1e-6) throw new Error(`Reserva: el cajón es entero, no se admiten fracciones (${+bl.toFixed(3)} bultos)`);
            return Math.round(bl);
          };
          if (rv.tipo === 'lote' && rv.lote_id) {
            const loteId = Number(rv.lote_id);
            const lp = db.prepare(`SELECT l.bultos, COALESCE(l.kg_por_bulto, ps.factor_conversion) AS kg_por_bulto
              FROM sg_lotes l LEFT JOIN sg_presentaciones ps ON ps.id=l.presentacion_id WHERE l.id=?`).get(loteId);
            const kpb = (lp && lp.bultos != null && lp.kg_por_bulto != null && Number(lp.kg_por_bulto) > 0) ? Number(lp.kg_por_bulto) : null;
            if (kpb != null) {
              const bultos = derivarBultosRv(kpb);
              if (bultos <= 0) continue;
              const dispB = bultosDisponibles(db, loteId);
              if (dispB != null && bultos > dispB) throw new Error(`Reserva lote ${loteId}: pedís ${bultos} cajón(es) pero hay ${dispB} disponible(s)`);
              insReserva.run(pedItemId, 'lote', loteId, null, +(bultos * kpb).toFixed(4), bultos, null, uid(req));
            } else if (kgRv > 0) {   // legacy: lote sin presentación/bultos
              insReserva.run(pedItemId, 'lote', loteId, null, kgRv, null, null, uid(req));
            }
          } else if (rv.tipo === 'oc_item' && rv.oc_item_id) {
            const ocItemId = Number(rv.oc_item_id);
            // NO SE RESERVA CONTRA UNA ORDEN TERMINADA. Los caminos de lectura
            // (/oferta y /disponibilidad) ya filtran por estado, pero este es el
            // único de ESCRITURA y no miraba nada: con la pantalla abierta de
            // antes, o llamando derecho a la API, se podían comprometer con un
            // cliente los kilos que se acaban de dar por perdidos.
            const ocRv = db.prepare(`SELECT o.estado, o.cerrada_en FROM sg_oc_items i
              JOIN sg_oc o ON o.id=i.oc_id WHERE i.id=?`).get(ocItemId);
            if (ocRv && (ocRv.cerrada_en || ['cerrada', 'anulada', 'recibida_total'].includes(ocRv.estado))) {
              throw new Error('Esa orden de compra ya no tiene mercadería en camino: no se puede reservar contra ella');
            }
            const oi = db.prepare(`SELECT oi.cantidad_estimada_presentaciones, oi.presentacion_id, ps.factor_conversion AS kg_por_bulto
              FROM sg_oc_items oi LEFT JOIN sg_presentaciones ps ON ps.id=oi.presentacion_id WHERE oi.id=?`).get(ocItemId);
            const kpb = (oi && oi.presentacion_id != null && oi.kg_por_bulto != null && Number(oi.kg_por_bulto) > 0) ? Number(oi.kg_por_bulto) : null;
            if (kpb != null) {
              const bultos = derivarBultosRv(kpb);
              if (bultos <= 0) continue;
              // bultos en tránsito = estimados − recibidos (Σ bultos de lotes de la OC) − Σ reservados oc_item activas.
              const estim = Number(oi.cantidad_estimada_presentaciones) || 0;
              const recib = db.prepare('SELECT COALESCE(SUM(bultos),0) s FROM sg_lotes WHERE oc_item_id=? AND activo=1').get(ocItemId).s;
              const reserv = db.prepare("SELECT COALESCE(SUM(bultos),0) s FROM sg_reservas WHERE oc_item_id=? AND tipo='oc_item' AND estado='activa'").get(ocItemId).s;
              const dispCamB = estim - recib - reserv;
              if (bultos > dispCamB) throw new Error(`Reserva OC ${ocItemId}: pedís ${bultos} cajón(es) pero quedan ${dispCamB} en tránsito`);
              insReserva.run(pedItemId, 'oc_item', null, ocItemId, +(bultos * kpb).toFixed(4), bultos, ocItemId, uid(req));
            } else if (kgRv > 0) {   // legacy: oc_item sin presentación
              insReserva.run(pedItemId, 'oc_item', null, ocItemId, kgRv, null, ocItemId, uid(req));
            }
          }
        }
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
    // BRIEF 8 — reservas por ítem (fuente + estado): la UI muestra firme/tránsito/pendiente.
    const qRes = db.prepare(`
      SELECT rs.id, rs.tipo, rs.kg, rs.estado, rs.lote_id, rs.oc_item_id,
        l.codigo_lote, l.semaforo, o.numero AS oc_numero, o.fecha_oc
      FROM sg_reservas rs
      LEFT JOIN sg_lotes l ON l.id=rs.lote_id
      LEFT JOIN sg_oc_items oi ON oi.id=rs.oc_item_id
      LEFT JOIN sg_oc o ON o.id=oi.oc_id
      WHERE rs.pedido_item_id=? ORDER BY rs.id`);
    for (const it of p.items) it.reservas = qRes.all(it.id);
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
          l.costo_final, l.kg_reales, l.presentacion_id, COALESCE(l.kg_por_bulto, ps.factor_conversion) AS kg_por_bulto,
          ${KG_VIGENTE_STOCK} AS kg_vigente,
          l.precio_unitario_kg, l.fecha_vencimiento_estimada,
          CAST(julianday(l.fecha_vencimiento_estimada) - julianday(date('now','localtime')) AS INTEGER) AS dias_restantes,
          ${KG_DISPONIBLE} AS kg_disponibles
        FROM sg_lotes l LEFT JOIN sg_productos pr ON pr.id=l.producto_id
        LEFT JOIN sg_presentaciones ps ON ps.id=l.presentacion_id
        WHERE l.activo=1 AND NOT (COALESCE(l.origen,'')='granel' AND l.presentacion_id IS NULL) AND l.estado IN ('disponible','reservado','despachado_parcial') AND l.producto_id=?
      ) WHERE kg_disponibles > 0.01
      ORDER BY fecha_vencimiento_estimada ASC, id ASC`).all(req.query.producto_id);
    res.json({ ok: true, data: rows.map(derivarBultosLote) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// BRIEF 8 §2 — OFERTA de un producto: lo que hay para armar un pedido.
//   stock     = lotes disponibles (FEFO) + semáforo + costo/kg + kg_reservado (info, D1 blanda).
//   en_camino = oc_items de OCs abiertas/parciales con disponible_camino = (estimado − recibido)
//               − Σ reservas tipo='oc_item' activas. Ordenado FIFO por fecha de OC.
router.get('/oferta', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const pid = req.query.producto_id;
    if (!pid) return res.status(400).json({ ok: false, error: 'Falta producto_id' });
    const stock = db.prepare(`
      SELECT * FROM (
        SELECT l.id AS lote_id, l.codigo_lote, l.producto_id, pr.nombre AS producto_nombre, l.calidad, l.semaforo,
          l.costo_final, l.fecha_vencimiento_estimada, l.presentacion_id, COALESCE(l.kg_por_bulto, ps.factor_conversion) AS kg_por_bulto,
          ${KG_VIGENTE_STOCK} AS kg_vigente,
          CAST(julianday(l.fecha_vencimiento_estimada) - julianday(date('now','localtime')) AS INTEGER) AS dias_restantes,
          ${KG_DISPONIBLE} AS kg_disponibles,
          COALESCE((SELECT SUM(kg) FROM sg_reservas WHERE lote_id=l.id AND estado IN ('activa','concretada')),0) AS kg_reservado,
          COALESCE((SELECT SUM(bultos) FROM sg_reservas WHERE lote_id=l.id AND estado IN ('activa','concretada')),0) AS bultos_reservado
        FROM sg_lotes l LEFT JOIN sg_productos pr ON pr.id=l.producto_id
        LEFT JOIN sg_presentaciones ps ON ps.id=l.presentacion_id
        WHERE l.activo=1 AND NOT (COALESCE(l.origen,'')='granel' AND l.presentacion_id IS NULL) AND l.estado IN ('disponible','reservado','despachado_parcial') AND l.producto_id=?
      ) WHERE kg_disponibles > 0.01
      ORDER BY fecha_vencimiento_estimada ASC, lote_id ASC`).all(pid);
    const en_camino = db.prepare(`
      SELECT * FROM (
        SELECT i.id AS oc_item_id, i.oc_id, o.numero AS oc_numero, o.fecha_oc, o.estado AS oc_estado,
          i.kg_estimados, i.presentacion_id, ps.factor_conversion AS kg_por_bulto,
          i.cantidad_estimada_presentaciones AS bultos_estimados, pv.razon_social AS proveedor_nombre,
          COALESCE((SELECT SUM(kg_reales) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1),0) AS kg_recibidos,
          COALESCE((SELECT SUM(bultos) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1),0) AS bultos_recibidos,
          COALESCE((SELECT SUM(bultos) FROM sg_reservas WHERE oc_item_id=i.id AND tipo='oc_item' AND estado='activa'),0) AS bultos_reservado_camino,
          ( i.kg_estimados
            - COALESCE((SELECT SUM(kg_reales) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1),0)
            - COALESCE((SELECT SUM(kg) FROM sg_reservas WHERE oc_item_id=i.id AND tipo='oc_item' AND estado='activa'),0)
          ) AS disponible_camino
        FROM sg_oc_items i
        JOIN sg_oc o ON o.id=i.oc_id
        LEFT JOIN sg_proveedores pv ON pv.id=o.proveedor_id
        LEFT JOIN sg_presentaciones ps ON ps.id=i.presentacion_id
        WHERE i.producto_id=? AND o.activo=1 AND o.estado IN ('abierta','recibida_parcial')
      ) WHERE disponible_camino > 0.01
      ORDER BY fecha_oc ASC, oc_item_id ASC`).all(pid);
    // bultos_camino = bultos estimados − recibidos − reservados en tránsito (null si el oc_item no
    // tiene presentación → cae al disponible_camino en kg, fallback legacy). disponible_camino (kg) se
    // mantiene para compat del front; bultos_camino es la unidad operativa F3-D.
    const en_caminoB = en_camino.map(function(r) {
      const kpb = (r.kg_por_bulto != null && Number(r.kg_por_bulto) > 0) ? Number(r.kg_por_bulto) : null;
      r.kg_por_bulto = kpb;
      r.bultos_camino = (r.presentacion_id != null && kpb != null)
        ? (Number(r.bultos_estimados || 0) - Number(r.bultos_recibidos || 0) - Number(r.bultos_reservado_camino || 0))
        : null;
      return r;
    });
    res.json({ ok: true, data: { stock: stock.map(derivarBultosLote), en_camino: en_caminoB } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DISPONIBILIDAD por producto (panel maestro del sgItemPicker). Usa las MISMAS expresiones que
// /oferta agregadas por producto → "Tomate 160kg" == Σ kg_disponibles de sus lotes en el detalle.
// NO descuenta kg_reservado (reserva blanda, igual que /oferta). kg_camino=0 si incluir_camino=0.
router.get('/disponibilidad', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const incluirCamino = req.query.incluir_camino === '1' || req.query.incluir_camino === 'true';
    const stock = db.prepare(`
      SELECT producto_id, nombre, SUM(kg_disp) AS kg_stock, COUNT(*) AS n_lotes FROM (
        SELECT l.producto_id, pr.nombre,
          ${KG_DISPONIBLE} AS kg_disp
        FROM sg_lotes l LEFT JOIN sg_productos pr ON pr.id=l.producto_id
        WHERE l.activo=1 AND NOT (COALESCE(l.origen,'')='granel' AND l.presentacion_id IS NULL) AND l.estado IN ('disponible','reservado','despachado_parcial')
      ) WHERE kg_disp > 0.01
      GROUP BY producto_id, nombre`).all();
    const camino = incluirCamino ? db.prepare(`
      SELECT producto_id, SUM(disp) AS kg_camino FROM (
        SELECT i.producto_id,
          ( i.kg_estimados
            - COALESCE((SELECT SUM(kg_reales) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1),0)
            - COALESCE((SELECT SUM(kg) FROM sg_reservas WHERE oc_item_id=i.id AND tipo='oc_item' AND estado='activa'),0)
          ) AS disp
        FROM sg_oc_items i JOIN sg_oc o ON o.id=i.oc_id
        WHERE o.activo=1 AND o.estado IN ('abierta','recibida_parcial')
      ) WHERE disp > 0.01
      GROUP BY producto_id`).all() : [];
    const mapa = new Map();
    for (const s of stock) mapa.set(s.producto_id, { producto_id: s.producto_id, nombre: s.nombre || '', kg_stock: +Number(s.kg_stock).toFixed(2), kg_camino: 0, n_lotes: s.n_lotes });
    for (const c of camino) {
      let e = mapa.get(c.producto_id);
      if (!e) { const pr = db.prepare('SELECT nombre FROM sg_productos WHERE id=?').get(c.producto_id); e = { producto_id: c.producto_id, nombre: (pr && pr.nombre) || '', kg_stock: 0, kg_camino: 0, n_lotes: 0 }; mapa.set(c.producto_id, e); }
      e.kg_camino = +Number(c.kg_camino).toFixed(2);
    }
    const data = [...mapa.values()]
      .filter(e => e.kg_stock > 0.01 || (incluirCamino && e.kg_camino > 0.01))
      .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
    res.json({ ok: true, data });
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
function syncGastoCoop(db, { tipo, despachoId, recepcionId, proveedorId, cooperativaId, unidad, cantidad, fechaServicio, userId }) {
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
      db.prepare("UPDATE sg_gastos_directos SET proveedor_servicio_id=?, cooperativa_id=?, unidad=?, cantidad=?, fecha_servicio=? WHERE id=?")
        .run(proveedorId, cooperativaId || null, unidad || null, (cantidad != null ? Number(cantidad) : null), fechaServicio, existente.id);
    }
    return; // ya valorizado → no se re-asigna
  }
  // proveedor_servicio_id = a quién se le paga (de ahí cuelga la valorización).
  // cooperativa_id = qué cuadrilla trabajó. Son dos datos distintos.
  db.prepare(`INSERT INTO sg_gastos_directos
    (tipo_gasto, ${col}, proveedor_servicio_id, cooperativa_id, unidad, cantidad, estado, fecha_servicio, creado_por)
    VALUES (?,?,?,?,?,?, 'pendiente_valorizar', ?, ?)`).run(tipo, opId, proveedorId, cooperativaId || null, unidad || null, (cantidad != null ? Number(cantidad) : null), fechaServicio, userId);
}

router.post('/despachos', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    const items = Array.isArray(b.items) ? b.items : [];
    if (!b.cliente_id) return res.status(400).json({ ok: false, error: 'Falta cliente' });
    if (!items.length) return res.status(400).json({ ok: false, error: 'El despacho necesita al menos un item' });

    // F3-B — el despacho mueve BULTOS ENTEROS (cajón indivisible). La cantidad operativa por línea
    // es bultos; kg_despachados se DERIVA = bultos × kg_por_bulto nominal (factor_conversion de la
    // presentación del lote). Se rechaza fracción de cajón y se valida contra bultosDisponibles
    // (helper F3-A). NO se acepta kg libre: si el front manda kg, se deriva el bulto y debe ser entero.
    const pedidoLote = {};   // Σ bultos por lote
    const lineas = [];       // {it, loteId, bultos, kgPorBulto, kg}
    for (const it of items) {
      const loteId = Number(it.lote_id);
      if (!loteId) return res.status(400).json({ ok: false, error: 'Cada línea necesita lote' });
      const lp = db.prepare(`SELECT l.presentacion_id, l.origen, l.envase_id, COALESCE(l.kg_por_bulto, ps.factor_conversion) AS kg_por_bulto
        FROM sg_lotes l LEFT JOIN sg_presentaciones ps ON ps.id=l.presentacion_id WHERE l.id=? AND l.activo=1`).get(loteId);
      if (!lp) return res.status(400).json({ ok: false, error: 'Lote inexistente: ' + loteId });
      // F3 — el gate del despacho por bulto ahora es el FACTOR (kg por bulto coalesced: tipeado al
      // vuelo o heredado de la presentación), NO la presentación en sí. Lotes al-vuelo (sin
      // presentación pero con kg_por_bulto) pasan a despachables; para legacy el resultado es idéntico.
      const kgPorBulto = (Number(lp.kg_por_bulto) > 0) ? Number(lp.kg_por_bulto) : null;
      // F4-C2 — el granel-de-entrada (origen='granel' sin factor conocido) no se vende directo: entra a
      // la venta como hijos-bulto post-reproceso (que SÍ tienen factor, aunque hereden el origen).
      if (String(lp.origen || '') === 'granel' && kgPorBulto == null) return res.status(400).json({ ok: false, error: `Lote ${loteId} es GRANEL: no se despacha directo, primero reprocesalo a cajones` });
      if (kgPorBulto == null) return res.status(400).json({ ok: false, error: `Lote ${loteId} sin factor: no despachable por bulto (cargá su envase/kg por bulto o presentación primero)` });
      // bultos: input canónico it.bultos; si no vino, se deriva del kg_despachados que manda el front.
      let bultos;
      if (it.bultos != null && it.bultos !== '') bultos = Number(it.bultos);
      else if (it.kg_despachados != null && it.kg_despachados !== '') bultos = Number(it.kg_despachados) / kgPorBulto;
      else return res.status(400).json({ ok: false, error: `Lote ${loteId}: falta la cantidad de bultos` });
      if (!(bultos > 0)) return res.status(400).json({ ok: false, error: `Lote ${loteId}: la cantidad de bultos debe ser > 0` });
      if (Math.abs(bultos - Math.round(bultos)) > 1e-6) {
        return res.status(400).json({ ok: false, error: `Lote ${loteId}: el despacho es por cajón entero, no se admiten fracciones (${+bultos.toFixed(3)} bultos)` });
      }
      bultos = Math.round(bultos);
      const kg = +(bultos * kgPorBulto).toFixed(4);   // kg DERIVADO (nominal), nunca input libre
      pedidoLote[loteId] = (pedidoLote[loteId] || 0) + bultos;
      lineas.push({ it, loteId, bultos, kgPorBulto, kg, presentacionId: lp.presentacion_id, envaseId: lp.envase_id });
    }
    for (const loteId of Object.keys(pedidoLote)) {
      const lote = db.prepare('SELECT estado FROM sg_lotes WHERE id=? AND activo=1').get(loteId);
      if (!lote) return res.status(400).json({ ok: false, error: 'Lote inexistente: ' + loteId });
      if (lote.estado === 'bajado') return res.status(400).json({ ok: false, error: 'Lote dado de baja: ' + loteId });
      const dispB = bultosDisponibles(db, Number(loteId));   // lote.bultos − Σ bultos de movimientos
      if (dispB == null) return res.status(400).json({ ok: false, error: `Lote ${loteId} sin bultos cargados: no despachable por bulto` });
      if (pedidoLote[loteId] > dispB) {
        return res.status(400).json({ ok: false, error: `Lote ${loteId}: pedís ${pedidoLote[loteId]} cajón(es) pero hay ${dispB} disponible(s)` });
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
        (despacho_id, lote_id, producto_id, presentacion_id, envase_id, kg_por_bulto, cantidad_presentaciones, bultos, kg_despachados, precio_por_kg, subtotal, margen_estimado)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      const lotesAfectados = new Set();
      let totalBultos = 0;   // FASE 2 — bultos del despacho (para la carga de la cooperativa)
      for (const ln of lineas) {
        const it = ln.it;
        const lote = db.prepare('SELECT producto_id, costo_final, kg_reales FROM sg_lotes WHERE id=?').get(ln.loteId);
        const kg = ln.kg;                       // DERIVADO = bultos × kg_por_bulto
        const bultos = ln.bultos;
        const precio = Number(it.precio_por_kg || 0);
        const subtotal = kg * precio;
        // costo_final del lote es el costo TOTAL → costo/kg sobre kg VIGENTES (kg_reales − decomiso
        // − transformado), así la merma revalúa lo despachado. (mismo cálculo que el front del modal.)
        const kgVig = (lote.kg_reales || 0) - kgDecomisado(db, ln.loteId) - kgTransformado(db, ln.loteId);
        const costoPorKg = kgVig > 0 ? (lote.costo_final || 0) / kgVig : 0;
        const margen = subtotal - kg * costoPorKg;
        // bultos va tanto a la columna F3-A (sg_despacho_items.bultos, que lee bultosDisponibles)
        // como a cantidad_presentaciones (compat). presentacion_id se toma de la línea o del lote.
        const presId = it.presentacion_id != null ? it.presentacion_id : (ln.presentacionId || null);
        // F3 — snapshot inmutable del factor+envase usados en este despacho (no se re-lee del lote).
        ins.run(despachoId, ln.loteId, lote.producto_id, presId,
          (ln.envaseId != null ? ln.envaseId : null), (ln.kgPorBulto != null ? ln.kgPorBulto : null),
          bultos, bultos, kg, precio, subtotal, margen);
        totalBultos += bultos;
        lotesAfectados.add(ln.loteId);
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
      SELECT d.*, c.razon_social AS cliente_nombre, c.nombre_comercial AS cliente_alias,
        p.numero AS pedido_numero,
        f.razon_social AS fletero_nombre,
        (SELECT GROUP_CONCAT(pr.nombre || ' ×' || COALESCE(di.bultos,'?') || ' cj', ', ')
           FROM sg_despacho_items di JOIN sg_productos pr ON pr.id=di.producto_id
          WHERE di.despacho_id=d.id) AS vendido,
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
// ── ALTA DE COOPERATIVAS ────────────────────────────────────────────────────
// El catálogo vive en Control Cooperativa. Una cooperativa es la CUADRILLA que
// descarga; el proveedor asociado es a QUIÉN SE LE PAGA, y por eso es
// obligatorio: una descarga cargada a una cuadrilla sin proveedor no se puede
// liquidar y termina siendo un dato que no sirve.
router.get('/cooperativas', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT c.*, p.razon_social AS proveedor_nombre, p.cuit AS proveedor_cuit,
             (SELECT COUNT(*) FROM sg_gastos_directos g
               WHERE g.cooperativa_id = c.id AND g.activo = 1 AND g.estado != 'anulado') AS descargas
      FROM sg_cooperativas c
      LEFT JOIN sg_proveedores p ON p.id = c.proveedor_id
      WHERE c.activo = 1
      ORDER BY c.nombre COLLATE NOCASE`).all();
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/cooperativas', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const nombre = val(b.nombre);
    if (!nombre) return res.status(400).json({ ok: false, error: 'Falta el nombre de la cooperativa' });
    // La atadura al proveedor no es opcional: es la única forma de pagarle.
    const provId = b.proveedor_id ? Number(b.proveedor_id) : null;
    if (!provId) return res.status(400).json({ ok: false, error: 'Elegí el proveedor al que se le factura esta cooperativa' });
    const prov = db.prepare('SELECT id FROM sg_proveedores WHERE id=? AND activo=1').get(provId);
    if (!prov) return res.status(400).json({ ok: false, error: 'Ese proveedor no existe o está dado de baja' });
    const rep = db.prepare('SELECT id FROM sg_cooperativas WHERE nombre = ? COLLATE NOCASE AND activo=1').get(nombre);
    if (rep) return res.status(400).json({ ok: false, error: 'Ya hay una cooperativa con ese nombre' });

    const info = db.prepare(`INSERT INTO sg_cooperativas (nombre, proveedor_id, contacto, notas, creado_por)
      VALUES (?,?,?,?,?)`).run(nombre, provId, val(b.contacto), val(b.notas), uid(req));
    res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.put('/cooperativas/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const c = db.prepare('SELECT * FROM sg_cooperativas WHERE id=? AND activo=1').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'No encontrada' });
    const nombre = val(b.nombre) || c.nombre;
    const provId = b.proveedor_id ? Number(b.proveedor_id) : c.proveedor_id;
    if (!provId) return res.status(400).json({ ok: false, error: 'La cooperativa tiene que tener un proveedor' });
    const prov = db.prepare('SELECT id FROM sg_proveedores WHERE id=? AND activo=1').get(provId);
    if (!prov) return res.status(400).json({ ok: false, error: 'Ese proveedor no existe o está dado de baja' });
    const rep = db.prepare('SELECT id FROM sg_cooperativas WHERE nombre = ? COLLATE NOCASE AND activo=1 AND id<>?').get(nombre, c.id);
    if (rep) return res.status(400).json({ ok: false, error: 'Ya hay otra cooperativa con ese nombre' });

    db.prepare(`UPDATE sg_cooperativas SET nombre=?, proveedor_id=?, contacto=?, notas=?,
      modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
      .run(nombre, provId, val(b.contacto), val(b.notas), uid(req), c.id);
    res.json({ ok: true, data: { id: c.id } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Baja lógica. Las descargas ya cargadas la siguen nombrando: borrarla de verdad
// dejaría gastos apuntando a una cooperativa que no existe.
router.delete('/cooperativas/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const c = db.prepare('SELECT * FROM sg_cooperativas WHERE id=? AND activo=1').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'No encontrada' });
    db.prepare(`UPDATE sg_cooperativas SET activo=0, eliminado_en=datetime('now','localtime'),
      eliminado_por_id=? WHERE id=?`).run(uid(req), c.id);
    res.json({ ok: true, data: { id: c.id } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── CONTROL COOPERATIVA ─────────────────────────────────────────────────────
// Todo lo que la cooperativa descargó, junto y en un solo lugar. Hasta ahora la
// descarga sólo se veía dentro de "Gastos Directos → Cargas y Descargas",
// mezclada con las cargas de salida y sin poder filtrar por fecha: para saber
// cuánto se le debe a una cooperativa por un mes había que ir recepción por
// recepción.
//
// La fila SALE DE LA RECEPCIÓN, no del gasto. Es a propósito: si el operador
// dijo "hubo descarga" y no cargó la cooperativa, el gasto nunca se crea
// (syncGastoCoop necesita proveedor) y esa descarga desaparecía sin dejar
// rastro. Acá aparece igual, marcada como incompleta, que es justamente lo que
// hay que controlar.
router.get('/control-coop', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['r.activo=1'], params = [];
    // Recepciones con descarga declarada. El OR cubre las de antes de que
    // existiera con_descarga: ahí el único indicio es que tengan el gasto.
    where.push('(r.con_descarga=1 OR g.id IS NOT NULL)');
    if (req.query.desde) { where.push('COALESCE(r.fecha_recepcion, date(r.creado_en)) >= ?'); params.push(String(req.query.desde)); }
    if (req.query.hasta) { where.push('COALESCE(r.fecha_recepcion, date(r.creado_en)) <= ?'); params.push(String(req.query.hasta)); }
    if (req.query.cooperativa_id) { where.push('g.proveedor_servicio_id = ?'); params.push(Number(req.query.cooperativa_id)); }
    // estado: sin_coop | pendiente_valorizar | valorizado
    if (req.query.estado === 'sin_coop') where.push('g.id IS NULL');
    else if (req.query.estado) { where.push('g.estado = ?'); params.push(String(req.query.estado)); }

    const filas = db.prepare(`
      SELECT r.id                AS recepcion_id,
             r.numero_recepcion,
             COALESCE(r.fecha_recepcion, date(r.creado_en)) AS fecha,
             r.bultos_recibidos, r.pallets_recibidos, r.con_descarga,
             o.trazabilidad     AS partida,
             pr.razon_social    AS proveedor_nombre,
             g.id               AS gasto_id,
             g.proveedor_servicio_id AS cooperativa_id,
             co.razon_social    AS cooperativa_nombre,
             g.unidad, g.cantidad, g.estado, g.monto, g.fecha_valorizacion, g.cuenta_ref,
             u.nombre           AS recibido_por_nombre
      FROM sg_recepciones r
      LEFT JOIN sg_gastos_directos g
             ON g.recepcion_id = r.id AND g.tipo_gasto='descarga_ingreso'
            AND g.activo=1 AND g.estado!='anulado'
      LEFT JOIN sg_oc o          ON o.id  = r.oc_id
      LEFT JOIN sg_proveedores pr ON pr.id = o.proveedor_id
      LEFT JOIN sg_proveedores co ON co.id = g.proveedor_servicio_id
      LEFT JOIN usuarios u        ON u.id  = r.creado_por
      WHERE ${where.join(' AND ')}
      ORDER BY fecha DESC, r.id DESC
    `).all(...params);

    // Los totales salen de las MISMAS filas que se muestran: si se calcularan
    // con otra consulta, un filtro nuevo tendría que acordarse de los dos lados.
    const num = (v) => Number(v) || 0;
    const totales = {
      descargas: filas.length,
      bultos:    filas.reduce((a, f) => a + num(f.bultos_recibidos), 0),
      pallets:   filas.reduce((a, f) => a + num(f.pallets_recibidos), 0),
      sin_coop:  filas.filter((f) => !f.gasto_id).length,
      pendientes: filas.filter((f) => f.estado === 'pendiente_valorizar').length,
      valorizadas: filas.filter((f) => f.estado === 'valorizado').length,
      monto:     filas.reduce((a, f) => a + num(f.monto), 0),
    };
    // Y el corte por cooperativa, que es como se paga.
    const porCoop = {};
    for (const f of filas) {
      const k = f.cooperativa_id || 0;
      if (!porCoop[k]) porCoop[k] = { cooperativa_id: f.cooperativa_id || null, cooperativa_nombre: f.cooperativa_nombre || null, descargas: 0, bultos: 0, pallets: 0, pendientes: 0, sin_asignar: 0, monto: 0 };
      const c = porCoop[k];
      c.descargas++;
      c.bultos += num(f.bultos_recibidos);
      c.pallets += num(f.pallets_recibidos);
      if (f.estado === 'pendiente_valorizar') c.pendientes++;
      if (!f.gasto_id) c.sin_asignar++;
      c.monto += num(f.monto);
    }
    res.json({ ok: true, data: { filas, totales, por_cooperativa: Object.values(porCoop) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Asignar (o corregir) la cooperativa de una descarga ya declarada. Es la
// contracara de la salida "no sé todavía" del paso 3: la recepción no se traba
// en la tranquera, pero la descarga queda marcada acá hasta que alguien diga de
// quién fue. Sin esto, la fila sin cooperativa sería un callejón sin salida —
// no hay PUT de recepciones.
//
// Reusa syncGastoCoop, que ya es idempotente y no pisa un gasto ya valorizado.
router.post('/control-coop/:id/cooperativa', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const rec = db.prepare('SELECT * FROM sg_recepciones WHERE id=? AND activo=1').get(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'Recepción inexistente' });
    // Del catálogo, que es lo que manda la pantalla. Se sigue aceptando un id
    // de proveedor suelto para no romper lo que ya estuviera cargado.
    const coopId = req.body && req.body.cooperativa_id ? Number(req.body.cooperativa_id) : null;
    if (!coopId && !req.body.cooperativa_catalogo_id) return res.status(400).json({ ok: false, error: 'Falta la cooperativa' });
    if (coopId && !req.body.cooperativa_catalogo_id) {
      const coop = db.prepare('SELECT id FROM sg_proveedores WHERE id=? AND activo=1 AND es_servicio=1').get(coopId);
      if (!coop) return res.status(400).json({ ok: false, error: 'Esa no es una cooperativa / proveedor de servicio activo' });
    }

    const yaVal = db.prepare(`SELECT id FROM sg_gastos_directos
      WHERE recepcion_id=? AND tipo_gasto='descarga_ingreso' AND activo=1 AND estado='valorizado'`).get(rec.id);
    // Ya se le pagó: cambiarle la cooperativa acá dejaría la cuenta pagada a
    // nombre de otro. Hay que anular esa valorización primero.
    if (yaVal) return res.status(400).json({ ok: false, error: 'Esa descarga ya está valorizada: no se le puede cambiar la cooperativa sin dar de baja la valorización' });

    // Desde el catálogo: la cooperativa dice a qué proveedor se le paga.
    const coopCat = req.body.cooperativa_catalogo_id
      ? db.prepare('SELECT id, proveedor_id FROM sg_cooperativas WHERE id=? AND activo=1').get(Number(req.body.cooperativa_catalogo_id))
      : null;
    const unidad = (req.body.unidad === 'pallet') ? 'pallet' : 'bulto';
    const cantidad = unidad === 'pallet' ? rec.pallets_recibidos : rec.bultos_recibidos;
    // Sin cantidad, el gasto queda en NULL y cuando se valoriza la cuenta el
    // prorrateo le asigna $0 a esta descarga sin decir nada. Mejor no dejar
    // crearla: que elija la unidad que la recepción sí contó.
    if (!cantidad) {
      return res.status(400).json({ ok: false,
        error: 'La recepción no tiene ' + (unidad === 'pallet' ? 'pallets' : 'bultos')
          + ' cargados: elegí la otra unidad o corregí la recepción, o la descarga se valoriza en cero.' });
    }
    db.transaction(() => {
      // Si la recepción venía sin declarar descarga, asignarle cooperativa ES
      // declararla: si no, la fila desaparecería del listado al recargar.
      if (rec.con_descarga !== 1) db.prepare('UPDATE sg_recepciones SET con_descarga=1 WHERE id=?').run(rec.id);
      syncGastoCoop(db, {
        tipo: 'descarga_ingreso', recepcionId: rec.id,
        proveedorId: coopCat ? coopCat.proveedor_id : coopId,
        cooperativaId: coopCat ? coopCat.id : null,
        unidad, cantidad, fechaServicio: rec.fecha_recepcion, userId: uid(req),
      });
    })();
    res.json({ ok: true, data: { recepcion_id: rec.id, cooperativa_id: coopId, unidad, cantidad } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

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
    // BRIEF 10 — LEFT JOIN para que un cliente con SOLO saldo de apertura (sin despachos) aparezca.
    // saldo = saldo_inicial (apertura al corte) + (facturado − cobrado) post-corte. saldo_inicial va aparte.
    const rows = db.prepare(`
      SELECT c.id, c.razon_social, c.limite_credito, COALESCE(c.saldo_inicial,0) AS saldo_inicial,
        COALESCE(SUM(di.subtotal),0) AS total_facturado,
        0 AS total_cobrado
      FROM sg_clientes c
      LEFT JOIN sg_despachos d ON d.cliente_id=c.id AND d.activo=1
      LEFT JOIN sg_despacho_items di ON di.despacho_id=d.id
      WHERE c.activo=1
      GROUP BY c.id, c.razon_social, c.limite_credito, c.saldo_inicial
      HAVING total_facturado > 0 OR saldo_inicial <> 0
      ORDER BY (COALESCE(c.saldo_inicial,0) + COALESCE(SUM(di.subtotal),0)) DESC`).all();
    for (const r of rows) r.saldo = (r.saldo_inicial || 0) + (r.total_facturado || 0) - (r.total_cobrado || 0);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// BRIEF 10 — CC de proveedores: deuda derivada de vencimientos de OC no pagados + saldo de apertura.
// saldo = saldo_inicial (al corte) + Σ vencimientos pendientes post-corte. NO toca contabilidad.
router.get('/cc-proveedores', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT p.id, p.razon_social, COALESCE(p.saldo_inicial,0) AS saldo_inicial,
        COALESCE((SELECT SUM(v.monto) FROM sg_oc_vencimientos v
          JOIN sg_oc o ON o.id=v.oc_id
          WHERE o.proveedor_id=p.id AND o.activo=1 AND o.estado<>'anulada' AND v.pagado=0),0) AS total_pendiente
      FROM sg_proveedores p WHERE p.activo=1`).all();
    const data = rows.map(r => ({ ...r, saldo: (r.saldo_inicial || 0) + (r.total_pendiente || 0) }))
      .filter(r => r.total_pendiente !== 0 || r.saldo_inicial !== 0)
      .sort((a, b) => b.saldo - a.saldo);
    res.json({ ok: true, data });
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

    // Compras del período (por fecha de ingreso del lote): kg + costo cargado. Excluye transformados
    // y aperturas (BRIEF 10): no son compra (no generan deuda a proveedor).
    const compras = db.prepare(`
      SELECT COALESCE(SUM(kg_reales),0) AS kg, COALESCE(SUM(costo_final),0) AS monto, COUNT(*) AS lotes
      FROM sg_lotes WHERE activo=1 AND transformado_de IS NULL AND COALESCE(origen,'')<>'apertura' AND substr(fecha_ingreso,1,7)=?`).get(periodo);

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

// ── REPORTE CG3: Resultado del período (margen bruto − gastos fijos) ─────────────
// 100% ADITIVO y read-only. Cruza el MARGEN BRUTO (reusa MARGEN_LINEA/COSTO_KG/KG_VIGENTE,
// que tras CG1 es margen bruto verdadero) por mes de VENTA, con los GASTOS FIJOS del período
// (sg_gastos_globales_periodo, imputados al mes en que se incurren). resultado = margen − fijos.
// Reconocimiento: margen al mes de fecha_despacho; fijos al mes 'periodo'. Ambos YYYY-MM.
router.get('/reportes/resultado-periodo', requireAuth, (req, res) => {
  const db = getDb();
  try {
    // Acepta YYYY-MM o YYYY-MM-DD (recorta a mes). Default: últimos 12 meses.
    const mes = (s) => { const m = /^(\d{4}-\d{2})/.exec(s || ''); return m ? m[1] : null; };
    const hasta = mes(req.query.hasta) || db.prepare("SELECT strftime('%Y-%m','now','localtime') p").get().p;
    const desde = mes(req.query.desde) || db.prepare("SELECT strftime('%Y-%m','now','localtime','-11 months') p").get().p;

    // A — margen bruto por mes de VENTA (fecha_despacho). Misma expresión que los otros reportes.
    const ventas = db.prepare(`
      SELECT substr(d.fecha_despacho,1,7) AS periodo,
             COALESCE(SUM(di.subtotal),0) AS ventas,
             COALESCE(SUM(${MARGEN_LINEA}),0) AS margen_bruto
      FROM sg_despacho_items di
      JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
      JOIN sg_lotes l ON l.id=di.lote_id
      WHERE substr(d.fecha_despacho,1,7) BETWEEN ? AND ?
      GROUP BY periodo`).all(desde, hasta);

    // B — gastos fijos por período (mes en que se incurren) + breakdown por tipo (drill-down).
    const fijos = db.prepare(`
      SELECT periodo, COALESCE(SUM(monto),0) AS fijos
      FROM sg_gastos_globales_periodo
      WHERE activo=1 AND periodo BETWEEN ? AND ?
      GROUP BY periodo`).all(desde, hasta);
    const fijosDet = db.prepare(`
      SELECT periodo, tipo_gasto, COALESCE(SUM(monto),0) AS monto
      FROM sg_gastos_globales_periodo
      WHERE activo=1 AND periodo BETWEEN ? AND ?
      GROUP BY periodo, tipo_gasto`).all(desde, hasta);

    // Merge por período (no perder meses con solo ventas o solo fijos).
    const map = {};
    const slot = (p) => (map[p] || (map[p] = { periodo: p, ventas: 0, margen_bruto: 0, gastos_fijos: 0, fijos_detalle: [] }));
    for (const v of ventas) { const r = slot(v.periodo); r.ventas = v.ventas; r.margen_bruto = v.margen_bruto; }
    for (const f of fijos) { slot(f.periodo).gastos_fijos = f.fijos; }
    for (const d of fijosDet) { slot(d.periodo).fijos_detalle.push({ tipo_gasto: d.tipo_gasto, monto: d.monto }); }
    const rows = Object.values(map).map((r) => ({
      periodo: r.periodo,
      ventas: r.ventas,
      costo_vendido: r.ventas - r.margen_bruto,   // MVP: una sola columna (no separa mercadería vs directos)
      margen_bruto: r.margen_bruto,
      gastos_fijos: r.gastos_fijos,
      resultado: r.margen_bruto - r.gastos_fijos,
      fijos_detalle: r.fijos_detalle
    })).sort((a, b) => (a.periodo < b.periodo ? 1 : -1));   // más reciente primero

    if (rows.length) {
      const t = rows.reduce((a, r) => ({
        ventas: a.ventas + r.ventas, costo_vendido: a.costo_vendido + r.costo_vendido,
        margen_bruto: a.margen_bruto + r.margen_bruto, gastos_fijos: a.gastos_fijos + r.gastos_fijos,
        resultado: a.resultado + r.resultado
      }), { ventas: 0, costo_vendido: 0, margen_bruto: 0, gastos_fijos: 0, resultado: 0 });
      t._total = 1; t.periodo = 'TOTAL'; t.fijos_detalle = [];
      rows.push(t);
    }
    res.json({ ok: true, data: rows, rango: { desde, hasta } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO IMPORTACIÓN (F1) — cotizador standalone de embarque. ADITIVO Y AISLADO:
// no toca sg_lotes, recalcCostoLote, OC nacional, despacho ni factura. El USD + tc
// viven solo acá; la conversión USD→ARS es intra-módulo. Enganche al lote = F2.
// ══════════════════════════════════════════════════════════════════════════════
const EMB_CONCEPTOS = ['costo_mercaderia','anticipo_impuesto','gastos_despachante','fletes','diferencia_cotizacion','gastos_bancarios','iva_credito_computable','percepcion_iva_computable','percepcion_iibb'];
const EMB_CREDITOS  = new Set(['iva_credito_computable','percepcion_iva_computable','percepcion_iibb']);

// Cálculo del embarque (server-side). Todos los montos se llevan a ARS con tc (real ?? estimado)
// para los rubros en USD. Usa COALESCE(monto_real, monto_estimado) como monto EFECTIVO.
function calcEmbarque(emb, costos) {
  const tc = emb.tc_real != null ? Number(emb.tc_real) : (emb.tc_estimado != null ? Number(emb.tc_estimado) : null);
  const aARS = (monto, moneda) => {
    if (monto == null) return null;
    const m = Number(monto) || 0;
    return ((moneda || 'ARS') === 'USD' && tc) ? m * tc : m;
  };
  let bruto = 0, creditos = 0, total_estimado = 0, total_real = 0, gap_total = 0;
  const detalle = costos.map(c => {
    const est  = aARS(c.monto_estimado, c.moneda);
    const real = aARS(c.monto_real, c.moneda);
    const efectivo = real != null ? real : (est != null ? est : 0);   // COALESCE(real, estimado)
    if (c.es_credito) creditos += efectivo; else bruto += efectivo;
    if (est != null) total_estimado += est;
    if (real != null) total_real += real;
    const gap = (real != null && est != null) ? real - est : null;
    if (gap != null) gap_total += gap;
    return { ...c, monto_estimado_ars: est, monto_real_ars: real, efectivo_ars: efectivo, gap };
  });
  const neto  = bruto - creditos;
  const cajas = Number(emb.cantidad_cajas) || 0;
  const merma = Number(emb.merma_esperada_pct) || 0;
  const precioRef = emb.precio_referencia != null ? Number(emb.precio_referencia) : null;
  const costo_caja_neto        = cajas > 0 ? neto  / cajas : null;
  const costo_caja_c_impuestos = cajas > 0 ? bruto / cajas : null;
  const costo_caja_vendible    = (costo_caja_neto != null && merma < 100) ? costo_caja_neto / (1 - merma / 100) : costo_caja_neto;
  const margen_proyectado_pct  = (precioRef && precioRef > 0 && costo_caja_vendible != null) ? (precioRef - costo_caja_vendible) / precioRef * 100 : null;
  return { bruto, creditos, neto, costo_caja_neto, costo_caja_c_impuestos, costo_caja_vendible,
    margen_proyectado_pct, total_estimado, total_real, gap_total, tc_aplicado: tc, detalle };
}

function embCostos(db, embId) {
  return db.prepare('SELECT * FROM sg_embarque_costos WHERE embarque_id=? AND activo=1 ORDER BY id').all(embId);
}

// Crea UN lote SG a partir de una línea de embarque recibido (Importación F2). Espeja
// crearLotesDeItem pero para origen='importado': el costo es PROVISORIO y viene del embarque:
// costo_base = costo_caja_neto (ARS, ya convertido USD→ARS por calcEmbarque) × cajas de la línea.
// kg_reales = cajas × kg_por_bulto; precio_unitario_kg = costo_base/kg (informativo). No hay
// recepción ni OC (recepcion_id/oc_item_id NULL); bultos = cajas; presentacion_id NULL (la
// identidad de bulto vive en envase_id + kg_por_bulto, como en la OC al vuelo). El cierre de
// cambio (F3, ZONA PABLO) ajustará costo_base y re-correrá recalcCostoLote.
// F7 — costo_base por línea con FOB unitario. El FOB (precio_unitario_usd → ARS con tc) DIFERENCIA las
// líneas; el RESTO del neto (otros gastos − créditos) se reparte PAREJO POR CAJA (la carga es homogénea:
// mismo producto, distinto calibre). Σ costo_base = costo NETO del embarque EXACTO (el último lote absorbe
// el redondeo). Degrada a F5 (todo parejo por caja) si ninguna línea trae precio. Devuelve un array
// alineado con `lineas`.
function costoBaseLineasEmbarque(emb, costos, lineas) {
  const calc = calcEmbarque(emb, costos);
  const neto = calc.neto || 0;
  const tc = calc.tc_aplicado;
  const merc = costos.find(c => c.concepto === 'costo_mercaderia');
  const mercUSD = merc && (merc.moneda || 'ARS') === 'USD';
  const fobConv = p => { const v = Number(p) || 0; return (mercUSD && tc) ? v * tc : v; };   // FOB USD→ARS
  const cajasTot = lineas.reduce((s, l) => s + (Number(l.cajas) || 0), 0);
  const fobArs = lineas.map(l => (Number(l.cajas) || 0) * fobConv(l.precio_unitario_usd));
  const restoNeto = neto - fobArs.reduce((a, b) => a + b, 0);   // gastos netos, parejo por caja
  const bases = lineas.map((l, i) => fobArs[i] + (cajasTot > 0 ? restoNeto * ((Number(l.cajas) || 0) / cajasTot) : 0));
  if (bases.length) {
    const sumButLast = bases.slice(0, -1).reduce((a, b) => a + b, 0);
    bases[bases.length - 1] = neto - sumButLast;   // el último absorbe el redondeo → Σ = neto exacto
  }
  return bases;
}

function crearLoteDeEmbarque(db, { emb, linea, costoBase, fechaIngreso, userId }) {
  const prod = db.prepare('SELECT vida_util_dias_default FROM sg_productos WHERE id=?').get(linea.producto_id);
  const vida = (prod && prod.vida_util_dias_default) || 0;
  const cajas = Math.round(Number(linea.cajas) || 0);
  const kpb = (linea.kg_por_bulto != null && linea.kg_por_bulto !== '') ? Number(linea.kg_por_bulto) : null;
  const kg = kpb != null ? cajas * kpb : 0;
  const base = Number(costoBase) || 0;   // F7 — costo_base ya prorrateado (FOB por línea + gastos parejos)
  const precio = kg > 0 ? base / kg : null;
  let venc = null;
  if (fechaIngreso && vida) venc = db.prepare('SELECT date(?, ?) d').get(fechaIngreso, `+${vida} days`).d;
  const envId = (linea.envase_id != null && linea.envase_id !== '') ? Number(linea.envase_id) : null;
  const codigo = nextNumero(db, 'SG-LT', 'sg_lotes', 'codigo_lote');
  const info = db.prepare(`INSERT INTO sg_lotes
    (codigo_lote, recepcion_id, oc_item_id, producto_id, kg_reales, precio_unitario_kg, costo_base,
     calidad, calibre, origen, fecha_ingreso, fecha_vencimiento_estimada, estado, costo_final,
     presentacion_id, bultos, kg_por_bulto, envase_id, embarque_id, creado_por)
    VALUES (?,?,?,?,?,?,?,?,?,'importado',?,?, 'disponible', ?, NULL, ?, ?, ?, ?, ?)`)
    .run(codigo, null, null, linea.producto_id, kg, precio, base,
      val(linea.calidad), val(linea.calibre), fechaIngreso, venc, base, cajas, kpb, envId, emb.id, userId);
  const loteId = info.lastInsertRowid;
  recalcCostoLote(db, loteId);
  return loteId;
}

// LISTA — cada embarque con su cálculo resumido.
router.get('/embarques', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const embs = db.prepare(`SELECT e.*, p.razon_social AS proveedor_nombre
      FROM sg_embarques e LEFT JOIN sg_proveedores p ON p.id=e.proveedor_id
      WHERE e.activo=1 ORDER BY e.id DESC`).all();
    const data = embs.map(e => {
      const calc = calcEmbarque(e, embCostos(db, e.id));
      return { ...e, costo_caja_neto: calc.costo_caja_neto, costo_caja_c_impuestos: calc.costo_caja_c_impuestos,
        costo_caja_vendible: calc.costo_caja_vendible, margen_proyectado_pct: calc.margen_proyectado_pct,
        neto: calc.neto, bruto: calc.bruto, creditos: calc.creditos };
    });
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DETALLE — cabecera + rubros + cálculo completo.
router.get('/embarques/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const emb = db.prepare(`SELECT e.*, p.razon_social AS proveedor_nombre
      FROM sg_embarques e LEFT JOIN sg_proveedores p ON p.id=e.proveedor_id
      WHERE e.id=? AND e.activo=1`).get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    const costos = embCostos(db, emb.id);
    const lineas = db.prepare(`SELECT l.*, pr.nombre AS producto_nombre, pr.variedad AS producto_variedad, e.nombre AS envase_nombre
      FROM sg_embarque_lineas l
      LEFT JOIN sg_productos pr ON pr.id=l.producto_id
      LEFT JOIN sg_envases e ON e.id=l.envase_id
      WHERE l.embarque_id=? AND l.activo=1 ORDER BY l.id`).all(emb.id);
    res.json({ ok: true, data: { ...emb, costos, lineas, calculo: calcEmbarque(emb, costos) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// F5 — persiste el desglose de líneas de un embarque (replace-all) y DERIVA cantidad_cajas = Σ cajas.
// Solo reemplaza si el body trae un array `lineas` (backward-compat: un PUT sin líneas no las pisa) y
// el embarque no fue recibido/cerrado (después ya generó lotes, las líneas quedan congeladas). Siempre
// recalcula cantidad_cajas desde las líneas activas si hay alguna. Reutiliza embLineasDelBody.
function embSyncLineas(db, embId, body, userId, estado) {
  const puedeEditar = estado !== 'recibido' && estado !== 'cerrado';
  if (Array.isArray(body.lineas) && puedeEditar) {
    db.prepare(`UPDATE sg_embarque_lineas SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=?
      WHERE embarque_id=? AND activo=1`).run(userId, embId);
    const ins = db.prepare(`INSERT INTO sg_embarque_lineas
      (embarque_id, producto_id, envase_id, kg_por_bulto, cajas, precio_unitario_usd, calidad, calibre, observaciones, creado_por)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const l of embLineasDelBody(body)) ins.run(embId, l.producto_id, l.envase_id, l.kg_por_bulto, l.cajas, l.precio_unitario_usd, l.calidad, l.calibre, l.observaciones, userId);
  }
  const agg = db.prepare('SELECT COALESCE(SUM(cajas),0) s, COUNT(*) c FROM sg_embarque_lineas WHERE embarque_id=? AND activo=1').get(embId);
  if (agg.c > 0) db.prepare('UPDATE sg_embarques SET cantidad_cajas=? WHERE id=?').run(agg.s, embId);   // derivado
  // F7 — costo_mercaderia DERIVADO = Σ(cajas × precio_unitario_usd) de las líneas con precio, en USD.
  // Solo si hay al menos una línea con precio; si no, respeta el valor manual del rubro. Upsert por concepto.
  const fob = db.prepare("SELECT COALESCE(SUM(cajas*precio_unitario_usd),0) s, COUNT(precio_unitario_usd) c FROM sg_embarque_lineas WHERE embarque_id=? AND activo=1").get(embId);
  if (fob.c > 0) {
    const r = db.prepare(`UPDATE sg_embarque_costos SET monto_estimado=?, moneda='USD',
      modificado_en=datetime('now','localtime'), modificado_por=? WHERE embarque_id=? AND concepto='costo_mercaderia' AND activo=1`).run(fob.s, userId, embId);
    if (r.changes === 0) db.prepare(`INSERT INTO sg_embarque_costos (embarque_id, concepto, es_credito, moneda, monto_estimado, creado_por)
      VALUES (?, 'costo_mercaderia', 0, 'USD', ?, ?)`).run(embId, fob.s, userId);
  }
}

// Normaliza el array de costos del body → filas válidas (concepto conocido).
function embCostosDelBody(body) {
  const arr = Array.isArray(body.costos) ? body.costos : [];
  return arr.filter(c => EMB_CONCEPTOS.includes(c.concepto)).map(c => ({
    concepto: c.concepto,
    es_credito: EMB_CREDITOS.has(c.concepto) ? 1 : 0,
    moneda: (c.moneda === 'USD' ? 'USD' : 'ARS'),
    monto_estimado: (c.monto_estimado != null && c.monto_estimado !== '') ? Number(c.monto_estimado) : null,
    monto_real: (c.monto_real != null && c.monto_real !== '') ? Number(c.monto_real) : null,
    observaciones: val(c.observaciones)
  }));
}

const EMB_HEADER_COLS = ['nombre','proveedor_id','pais_origen','incoterm','certificado_origen_mercosur','ncm','moneda','tc_estimado','tc_real','estado','cantidad_cajas','merma_esperada_pct','precio_referencia','fecha_etd','fecha_eta','observaciones'];
function embHeaderVals(b) {
  return {
    nombre: val(b.nombre),
    proveedor_id: b.proveedor_id ? Number(b.proveedor_id) : null,
    pais_origen: val(b.pais_origen),
    incoterm: val(b.incoterm) || 'FOB',
    certificado_origen_mercosur: b.certificado_origen_mercosur ? 1 : 0,
    ncm: val(b.ncm),
    moneda: (b.moneda === 'ARS' ? 'ARS' : 'USD'),
    tc_estimado: (b.tc_estimado != null && b.tc_estimado !== '') ? Number(b.tc_estimado) : null,
    tc_real: (b.tc_real != null && b.tc_real !== '') ? Number(b.tc_real) : null,
    estado: EMB_ESTADOS.has(b.estado) ? b.estado : 'cotizacion',
    cantidad_cajas: (b.cantidad_cajas != null && b.cantidad_cajas !== '') ? Math.round(Number(b.cantidad_cajas)) : null,
    merma_esperada_pct: (b.merma_esperada_pct != null && b.merma_esperada_pct !== '') ? Number(b.merma_esperada_pct) : 0,
    precio_referencia: (b.precio_referencia != null && b.precio_referencia !== '') ? Number(b.precio_referencia) : null,
    fecha_etd: val(b.fecha_etd),
    fecha_eta: val(b.fecha_eta),
    observaciones: val(b.observaciones)
  };
}
const EMB_ESTADOS = new Set(['cotizacion','abierto','transito','recibido','cerrado']);

// CREAR — cabecera + rubros en una transacción (patrón POST /oc).
router.post('/embarques', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    if (!val(b.nombre)) return res.status(400).json({ ok: false, error: 'Falta el nombre del embarque' });
    const h = embHeaderVals(b);
    const costos = embCostosDelBody(b);
    const tx = db.transaction(() => {
      const info = db.prepare(`INSERT INTO sg_embarques
        (${EMB_HEADER_COLS.join(', ')}, creado_por)
        VALUES (${EMB_HEADER_COLS.map(() => '?').join(', ')}, ?)`).run(...EMB_HEADER_COLS.map(k => h[k]), uid(req));
      const embId = info.lastInsertRowid;
      const ins = db.prepare(`INSERT INTO sg_embarque_costos
        (embarque_id, concepto, es_credito, moneda, monto_estimado, monto_real, observaciones, creado_por)
        VALUES (?,?,?,?,?,?,?,?)`);
      for (const c of costos) ins.run(embId, c.concepto, c.es_credito, c.moneda, c.monto_estimado, c.monto_real, c.observaciones, uid(req));
      embSyncLineas(db, embId, b, uid(req), h.estado);   // F5 — desglose de productos + cantidad_cajas derivada
      return embId;
    });
    res.json({ ok: true, data: { id: Number(tx()) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// EDITAR — cabecera y/o rubros. Upsert de costos por concepto (los 9 llegan del form).
router.put('/embarques/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const emb = db.prepare('SELECT id, estado FROM sg_embarques WHERE id=? AND activo=1').get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    const b = req.body || {};
    const h = embHeaderVals(b);
    const costos = embCostosDelBody(b);
    const tx = db.transaction(() => {
      db.prepare(`UPDATE sg_embarques SET ${EMB_HEADER_COLS.map(k => k + '=?').join(', ')},
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
        .run(...EMB_HEADER_COLS.map(k => h[k]), uid(req), emb.id);
      const upd = db.prepare(`UPDATE sg_embarque_costos SET es_credito=?, moneda=?, monto_estimado=?, monto_real=?, observaciones=?,
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE embarque_id=? AND concepto=? AND activo=1`);
      const ins = db.prepare(`INSERT INTO sg_embarque_costos
        (embarque_id, concepto, es_credito, moneda, monto_estimado, monto_real, observaciones, creado_por)
        VALUES (?,?,?,?,?,?,?,?)`);
      for (const c of costos) {
        const r = upd.run(c.es_credito, c.moneda, c.monto_estimado, c.monto_real, c.observaciones, uid(req), emb.id, c.concepto);
        if (r.changes === 0) ins.run(emb.id, c.concepto, c.es_credito, c.moneda, c.monto_estimado, c.monto_real, c.observaciones, uid(req));
      }
      embSyncLineas(db, emb.id, b, uid(req), emb.estado);   // F5 — replace-all de líneas (si no está recibido) + cantidad_cajas derivada
    });
    tx();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// SOFT DELETE — no borra físico (patrón eliminado_en).
router.delete('/embarques/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const info = db.prepare(`UPDATE sg_embarques SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=?
      WHERE id=? AND activo=1`).run(uid(req), req.params.id);
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── LÍNEAS DE PRODUCTO DEL EMBARQUE (Importación F2) ────────────────────────────
// Definen QUÉ lleva cada lote: producto, envase, kg por bulto y cajas. Al recibir se crea un
// sg_lote importado por línea. Normaliza el array del body (descarta filas sin producto).
function embLineasDelBody(body) {
  const arr = Array.isArray(body.lineas) ? body.lineas : [];
  return arr
    .filter(l => l.producto_id != null && l.producto_id !== '')
    .map(l => ({
      producto_id: Number(l.producto_id),
      envase_id: (l.envase_id != null && l.envase_id !== '') ? Number(l.envase_id) : null,
      kg_por_bulto: (l.kg_por_bulto != null && l.kg_por_bulto !== '') ? Number(l.kg_por_bulto) : null,
      cajas: (l.cajas != null && l.cajas !== '') ? Math.round(Number(l.cajas)) : 0,
      precio_unitario_usd: (l.precio_unitario_usd != null && l.precio_unitario_usd !== '') ? Number(l.precio_unitario_usd) : null,   // F7 — FOB USD/caja
      calidad: val(l.calidad),
      calibre: val(l.calibre),
      observaciones: val(l.observaciones)
    }));
}

// LISTA de líneas (con nombre de producto y envase).
router.get('/embarques/:id/lineas', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const lineas = db.prepare(`SELECT l.*, pr.nombre AS producto_nombre, pr.variedad AS producto_variedad, e.nombre AS envase_nombre
      FROM sg_embarque_lineas l
      LEFT JOIN sg_productos pr ON pr.id=l.producto_id
      LEFT JOIN sg_envases e ON e.id=l.envase_id
      WHERE l.embarque_id=? AND l.activo=1 ORDER BY l.id`).all(req.params.id);
    res.json({ ok: true, data: lineas });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// REEMPLAZAR líneas (replace-all). Solo si el embarque no fue recibido/cerrado (después ya generó
// lotes y no se toca). Soft-delete de las activas + insert del set nuevo, en una transacción.
router.put('/embarques/:id/lineas', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const emb = db.prepare('SELECT id, estado FROM sg_embarques WHERE id=? AND activo=1').get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    if (emb.estado === 'recibido' || emb.estado === 'cerrado')
      return res.status(409).json({ ok: false, error: 'El embarque ya fue recibido: sus líneas no se pueden editar' });
    const lineas = embLineasDelBody(req.body || {});
    const tx = db.transaction(() => {
      db.prepare(`UPDATE sg_embarque_lineas SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=?
        WHERE embarque_id=? AND activo=1`).run(uid(req), emb.id);
      const ins = db.prepare(`INSERT INTO sg_embarque_lineas
        (embarque_id, producto_id, envase_id, kg_por_bulto, cajas, calidad, calibre, observaciones, creado_por)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const l of lineas) ins.run(emb.id, l.producto_id, l.envase_id, l.kg_por_bulto, l.cajas, l.calidad, l.calibre, l.observaciones, uid(req));
    });
    tx();
    res.json({ ok: true, data: { lineas: lineas.length } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── RECIBIR EL EMBARQUE (Importación F2) — goods-in-transit → stock ─────────────
// Transición transito→recibido. Crea un sg_lote importado por línea con costo PROVISORIO del
// embarque (costo_caja_neto × cajas, ya en ARS). El lote entra a stock, se vende; el cierre de
// cambio (F3, ZONA PABLO) ajustará el costo más adelante. Idempotente por estado: no recibe 2 veces.
router.post('/embarques/:id/recibir', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const emb = db.prepare('SELECT * FROM sg_embarques WHERE id=? AND activo=1').get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    if (emb.estado === 'recibido' || emb.estado === 'cerrado')
      return res.status(409).json({ ok: false, error: 'El embarque ya fue recibido' });
    const lineas = db.prepare('SELECT * FROM sg_embarque_lineas WHERE embarque_id=? AND activo=1 ORDER BY id').all(emb.id);
    if (!lineas.length) return res.status(400).json({ ok: false, error: 'El embarque no tiene líneas de producto. Cargá el desglose de productos antes de recibir.' });
    if (lineas.some(l => !(Number(l.cajas) > 0)))
      return res.status(400).json({ ok: false, error: 'Todas las líneas deben tener cajas > 0' });
    if (lineas.some(l => !(Number(l.kg_por_bulto) > 0)))
      return res.status(400).json({ ok: false, error: 'Todas las líneas deben tener kg por bulto > 0 (si no, el lote nace con 0 kg y no es despachable)' });
    const calc = calcEmbarque(emb, embCostos(db, emb.id));
    if (calc.costo_caja_neto == null)
      return res.status(400).json({ ok: false, error: 'No se puede costear el embarque (falta cantidad de cajas o costos cargados)' });
    const fechaIngreso = val(req.body && req.body.fecha_ingreso) || db.prepare("SELECT date('now','localtime') d").get().d;
    // F7 — costo_base por línea: FOB unitario diferencia; gastos parejos por caja; Σ = neto exacto.
    const bases = costoBaseLineasEmbarque(emb, embCostos(db, emb.id), lineas);
    const tx = db.transaction(() => {
      const ids = [];
      lineas.forEach((linea, i) => ids.push(crearLoteDeEmbarque(db, { emb, linea, costoBase: bases[i], fechaIngreso, userId: uid(req) })));
      db.prepare("UPDATE sg_embarques SET estado='recibido', modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?").run(uid(req), emb.id);
      return ids;
    });
    const loteIds = tx();
    res.json({ ok: true, data: { lotes: loteIds, costo_caja_neto: calc.costo_caja_neto } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── EXPEDIENTE DOCUMENTAL DEL EMBARQUE (Importación F6) ──────────────────────────
// Archiva los documentos de importación en Cloudflare R2 (persistente). Upload en MEMORIA
// (memoryStorage: nunca toca el disco efímero) → subirArchivo() a R2 → fila con la storage_key.
// El serving es por PROXY con requireAuth (no URL firmada). Molde: sg_gastos_directos.
const DOC_TIPOS = new Set(['factura_comercial','packing_list','bl','poliza_seguro','despacho_aduana','cert_fitosanitario','cert_origen','otro']);
const DOC_MIMES = new Set(['application/pdf','image/jpeg','image/png']);
const DOC_MAX_BYTES = 10 * 1024 * 1024;
const uploadDocMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: DOC_MAX_BYTES } });

// Sanitiza el nombre para usarlo en la storage_key: sin separadores de path ni '..', solo
// alfanumérico + . _ - (evita path traversal y keys raras). El nombre_original SÍ se guarda tal cual.
function sanitizarNombreDoc(n) {
  return String(n || 'documento')
    .replace(/[\/\\]/g, '_')       // sin separadores de path
    .replace(/\.{2,}/g, '_')       // sin '..' (traversal)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'documento';
}

// Envuelve multer para devolver JSON limpio si el archivo excede el límite (en vez del HTML 500 de express).
function uploadDoc(req, res, next) {
  uploadDocMem.single('archivo')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera 10MB' : err.message });
    next();
  });
}

// SUBIR — multer en memoria → R2 → INSERT. requireAdmin.
router.post('/embarques/:id/documentos', requireAdmin, uploadDoc, async (req, res) => {
  const db = getDb();
  try {
    if (!storageConfigurado()) return res.status(503).json({ ok: false, error: 'Almacenamiento R2 no configurado (faltan credenciales)' });
    const emb = db.prepare('SELECT id FROM sg_embarques WHERE id=? AND activo=1').get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    const f = req.file;
    if (!f) return res.status(400).json({ ok: false, error: 'Falta el archivo' });
    const tipo = val(req.body.tipo);
    if (!DOC_TIPOS.has(tipo)) return res.status(400).json({ ok: false, error: 'Tipo de documento inválido' });
    if (!DOC_MIMES.has(f.mimetype)) return res.status(400).json({ ok: false, error: 'Formato no permitido (solo PDF, JPG o PNG)' });
    if (f.size > DOC_MAX_BYTES) return res.status(400).json({ ok: false, error: 'El archivo supera 10MB' });
    const key = `embarques/${emb.id}/${randomUUID()}-${sanitizarNombreDoc(f.originalname)}`;
    await subirArchivo(f.buffer, key, f.mimetype);
    const info = db.prepare(`INSERT INTO sg_embarque_documentos
      (embarque_id, tipo, storage_key, nombre_original, mime, tamano_bytes, fecha_documento, observaciones, creado_por)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(emb.id, tipo, key, String(f.originalname || 'documento').slice(0, 255), f.mimetype, f.size, val(req.body.fecha_documento), val(req.body.observaciones), uid(req));
    res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// LISTAR — metadata de los documentos del embarque (no expone la storage_key). requireAuth.
router.get('/embarques/:id/documentos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const docs = db.prepare(`SELECT id, embarque_id, tipo, nombre_original, mime, tamano_bytes, fecha_documento, observaciones, creado_en
      FROM sg_embarque_documentos WHERE embarque_id=? AND activo=1 ORDER BY id DESC`).all(req.params.id);
    res.json({ ok: true, data: docs });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DESCARGAR — PROXY por el backend. Verifica que el docId pertenezca al embarque (anti-IDOR)
// → stream desde R2 con Content-Type y Content-Disposition. requireAuth.
router.get('/embarques/:id/documentos/:docId/descargar', requireAuth, async (req, res) => {
  const db = getDb();
  try {
    if (!storageConfigurado()) return res.status(503).json({ ok: false, error: 'Almacenamiento R2 no configurado' });
    // El WHERE ata docId + embarque_id: un docId de otro embarque no matchea → 404 (evita IDOR).
    const doc = db.prepare('SELECT * FROM sg_embarque_documentos WHERE id=? AND embarque_id=? AND activo=1').get(req.params.docId, req.params.id);
    if (!doc) return res.status(404).json({ ok: false, error: 'Documento no encontrado' });
    const stream = await obtenerArchivo(doc.storage_key);
    res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(doc.nombre_original || 'documento'));
    if (doc.tamano_bytes) res.setHeader('Content-Length', doc.tamano_bytes);
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    stream.pipe(res);
  } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, error: e.message }); }
});

// ELIMINAR — soft delete (conserva el expediente; NO borra de R2). requireAdmin. Anti-IDOR en el WHERE.
router.delete('/embarques/:id/documentos/:docId', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const info = db.prepare(`UPDATE sg_embarque_documentos SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=?
      WHERE id=? AND embarque_id=? AND activo=1`).run(uid(req), req.params.docId, req.params.id);
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Documento no encontrado' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
