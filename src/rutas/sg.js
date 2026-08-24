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
import { facturaCuenta } from '../servicios/factura-cuenta.js';
import { previewAsientoLiquidacion, lineasAsientoLiquidacion } from '../servicios/asiento-liquidacion.js';
import { crearAsiento, MOTIVOS, frenoAsientoDeCompra } from '../servicios/asientos.js';

// El nombre del motivo para mostrarlo en una ficha. La clave sola no le dice
// nada a nadie.
const MOTIVOS_TXT = (k) => (MOTIVOS[k] ? MOTIVOS[k].label : k);
import { getDb } from '../servicios/db.js';
import '../servicios/db_sg.js'; // corre el DDL sg_* al importarse
// Las condiciones de pago que se usan de verdad, y el código de trazabilidad
// de las órdenes que se cargaron antes de que existiera.
import '../servicios/sg_oc_condiciones_y_traza.js';
// normalizar/ratio: el mismo fuzzy del detector de duplicados, reusado para enganchar los
// textos libres de una factura con el catálogo (productos, envases, proveedores).
import { detectarDuplicado, normalizar, ratio } from '../servicios/dedup.js';
import Anthropic from '@anthropic-ai/sdk';
// El model ID sale SIEMPRE de config/ia.js: es la fuente única del repo.
import { MODELO_CHAT } from '../config/ia.js';
import { generarOcPDF } from '../servicios/ocPDF.js';
import { generarRecepcionCalidadPDF } from '../servicios/recepcionCalidadPDF.js';
import { autenticar as afipAutenticar, ambienteActual as afipAmbiente } from '../servicios/afip-wsaa.js';
import { feDummy as afipFeDummy, ultimoComprobante as afipUltimoCbte, tiposCbte as afipTiposCbte, tiposIva as afipTiposIva, ptosVenta as afipPtosVenta, condicionesIvaReceptor as afipCondIva } from '../servicios/afip-wsfe.js';
import { emitir as afipEmitir } from '../servicios/afip-wsfe-emision.js';
import { exigirEmpresa, SAN_GERONIMO } from '../servicios/sociedad_modulo.js';

import { chequeUsado, puedeMoverCuenta } from './sg_tesoreria.js';

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
  // ANULAR ES UN NIVEL, NO UN ROL (CLAUDE.md). Este delete es el de los cuatro
  // maestros que se montan con esta función —envases, presentaciones,
  // proveedores y clientes—, y los cuatro son de sg-catalogo, que es quien
  // decide el nivel. Es soft delete: la fila queda, con su eliminado_en.
  router.delete(`/${path}/:id`, requireAuth, (req, res) => {
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

// ANULAR ES UN NIVEL, NO UN ROL (CLAUDE.md). exigirNivel reconoce la anulación
// por la URL —el DELETE y los sufijos /anular, /baja— y pide nivel "anular" en
// el módulo dueño de la dirección. Con requireAdmin, todo esto lo tenía que
// hacer el dueño de la empresa.
router.delete('/variedades/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    borrarNivelTax(db, req, res, 'sg_variedades', req.params.id, [
      { count: 'SELECT COUNT(*) AS n FROM sg_productos WHERE variedad_id=? AND activo=1', params: [req.params.id], etiqueta: 'producto(s) la usan' }
    ]);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.delete('/especies/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    borrarNivelTax(db, req, res, 'sg_especies', req.params.id, [
      { count: 'SELECT COUNT(*) AS n FROM sg_variedades WHERE especie_id=? AND activo=1', params: [req.params.id], etiqueta: 'variedad(es) hija(s) activa(s)' },
      { count: 'SELECT COUNT(*) AS n FROM sg_productos WHERE especie_id=? AND activo=1',  params: [req.params.id], etiqueta: 'producto(s) la usan' }
    ]);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.delete('/familias/:id', requireAuth, (req, res) => {
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
router.delete('/productos/:id', requireAuth, (req, res) => {
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
// ── LOS ENVASES, CON EN CUÁNTO SE USA CADA UNO ───────────────────────────
// Dar de baja un envase a ciegas es lo que deja el maestro peor de lo que
// estaba: el que limpia no sabe si "Cajón" se usa en tres presentaciones o en
// ninguna, así que no toca nada — o borra el que estaba en uso.
//
// Se declara ANTES que el GET genérico de montarCRUD para que gane esta ruta.
// (Express toma la primera que matchea, y ésta es más específica.)
router.get('/envases/uso', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`SELECT e.*,
        (SELECT COUNT(*) FROM sg_presentaciones ps
          WHERE ps.envase_id = e.id AND ps.activo = 1) AS presentaciones,
        (SELECT COUNT(*) FROM sg_oc_items i WHERE i.envase_id = e.id) AS en_ordenes,
        (SELECT COUNT(*) FROM sg_lotes l WHERE l.envase_id = e.id AND l.activo = 1) AS en_partidas
      FROM sg_envases e
      WHERE ${req.query.todos === '1' ? '1=1' : 'e.activo = 1'}
      ORDER BY e.nombre COLLATE NOCASE`).all();
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

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
   'telefono', 'email', 'observaciones', 'adm_proveedor_id', 'es_servicio', 'saldo_inicial',
   // El acuerdo comercial con este proveedor: 0% a más de 50%. Al facturar una
   // venta, su mercadería sale por el precio menos este porcentaje, y la
   // diferencia se mide aparte como venta de gestión.
   'descuento_pct'],   // es_servicio: 1 = fletero/cooperativa · saldo_inicial: apertura al corte (BRIEF 10)
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
// kg ya facturados de un despacho_item. Lo que NO cuenta es una factura que se
// cayó —rechazada por AFIP o anulada—: esos kg vuelven a estar pendientes.
//
// Acá había una lista de estados escrita a mano que no incluía el comprobante
// manual, y entonces los kg de una venta YA FACTURADA volvían a aparecer
// disponibles: nada frenaba una segunda factura por la misma mercadería. La
// regla vive ahora en servicios/factura-cuenta.js, una sola vez.
function kgFacturadoItem(db, despachoItemId) {
  return db.prepare(`SELECT COALESCE(SUM(fd.kg),0) s FROM sg_factura_despachos fd
    JOIN sg_ven_facturas f ON f.id=fd.factura_id
    WHERE fd.despacho_item_id=? AND ${facturaCuenta('f')}`).get(despachoItemId).s;
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
        fam.iva_alicuota, di.lote_id, l.codigo_lote, di.kg_despachados, di.precio_por_kg,
        di.origen, di.oc_item_id, di.nota_precio, di.lote_recibido_id, oc.numero AS oc_numero
      FROM sg_despachos d
      JOIN sg_despacho_items di ON di.despacho_id=d.id
      LEFT JOIN sg_productos pr ON pr.id=di.producto_id
      LEFT JOIN sg_familias fam ON fam.id=pr.familia_id
      LEFT JOIN sg_lotes l ON l.id=di.lote_id
      LEFT JOIN sg_oc_items oi ON oi.id=di.oc_item_id
      LEFT JOIN sg_oc oc ON oc.id=oi.oc_id
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
          // LO QUE DIJO EL QUE HIZO EL REMITO. El precio es una SUGERENCIA suya,
          // y la razón de ese precio vivía en un chat de WhatsApp: el que
          // factura no la tenía y llamaba a preguntar.
          nota_precio: r.nota_precio || '',
          // Y si todavía no llegó, se dice. Facturar mercadería que no bajó del
          // camión se arregla después con una nota de crédito.
          origen: r.origen || 'lote',
          en_viaje: r.origen === 'oc_item' && r.lote_recibido_id == null,
          oc_numero: r.oc_numero || '',
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
        di.origen, di.lote_recibido_id,
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
        // El renglon dice si esa parte todavia viene en viaje: no es lo mismo
        // deber una factura de mercaderia entregada que de una que no bajo.
        g.items.push({ producto: r.producto_nombre || '', kg_pendiente: kgPend,
          en_viaje: r.origen === 'oc_item' && r.lote_recibido_id == null });
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
//
// Sale con requireAuth, no con requireAdmin. Facturar es el trabajo del día, y
// hasta ahora lo tenía que hacer el dueño. El nivel lo decide exigirNivel por la
// dirección — que para esto hubo que DECLARARLA: 'sg/facturas' no estaba en el
// mapa, y por eso requireAdmin era la única barrera que tenía.
const postEmitir = async (req, res) => {
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
        const di = db.prepare(`SELECT di.id, di.producto_id, di.kg_despachados, di.precio_por_kg,
            di.precio_lista_por_kg, di.presentacion_id,
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
        // EL PRECIO DE LA PANTALLA MANDA. El del remito es una SUGERENCIA de
        // quien lo armó; el que factura lo puede cambiar, y hasta ahora ese
        // cambio no llegaba: el comprobante salía con el precio viejo mientras
        // la pantalla mostraba el total nuevo. Dos números distintos para la
        // misma factura, y el que valía era el que no se veía.
        const precioBruto = (it.precio_por_kg != null && Number(it.precio_por_kg) >= 0)
          ? Number(it.precio_por_kg)
          : (Number(di.precio_por_kg) || 0);
        const precioNeto = (incluyeIva && alic != null) ? +(precioBruto / (1 + alic / 100)).toFixed(4) : precioBruto; // al motor SIEMPRE neto
        // F5 — metadata de presentación por bulto (cajón), SOLO para el detalle local + PDF. cantidad
        // (kg) y precio (precio_kg neto) NO cambian → el payload e importes a AFIP son idénticos a hoy.
        const kpb = (di.kg_por_bulto != null && Number(di.kg_por_bulto) > 0) ? Number(di.kg_por_bulto) : null;
        const bultosLinea = kpb != null ? +(kg / kpb).toFixed(4) : null;          // bultos facturados (display)
        const precioPorBulto = kpb != null ? +(precioNeto * kpb).toFixed(4) : null; // = precio_kg neto × kg_por_bulto
        items.push({ producto_id: Number(di.producto_id), cantidad: kg, precio: precioNeto,
          bultos: bultosLinea, kg_por_bulto: kpb, precio_por_bulto: precioPorBulto, unidad: kpb != null ? 'cajón' : null });
        // ── LOS PESOS DE ESTA LÍNEA, GUARDADOS ACÁ Y NO RECALCULADOS DESPUÉS ──
        //
        // Este es el único momento en que se sabe si el precio tipeado traía IVA
        // adentro. Reconstruirlo más tarde sería adivinar, y de esto sale la
        // liquidación del productor.
        const netoLinea = r2(kg * precioNeto);
        const ivaLinea = alic != null ? r2(netoLinea * (alic / 100)) : 0;
        // Lo resignado por el acuerdo con el proveedor DE ESTA partida. Se mide
        // contra el precio de lista de la misma línea, con la misma conversión de
        // IVA: comparar un precio con IVA contra uno sin IVA da una diferencia
        // que no existe.
        const listaBruto = (di.precio_lista_por_kg != null && Number(di.precio_lista_por_kg) > precioBruto)
          ? Number(di.precio_lista_por_kg) : precioBruto;
        const listaNeto = (incluyeIva && alic != null) ? +(listaBruto / (1 + alic / 100)).toFixed(4) : listaBruto;
        const gestionLinea = r2(kg * (listaNeto - precioNeto));
        vinculos.push({ despacho_id: despachoId, despacho_item_id: diId, kg,
          neto: netoLinea, iva: ivaLinea, gestion: gestionLinea > 0 ? gestionLinea : 0 });
      }
    }
    if (!items.length) return res.status(400).json({ ok: false, error: 'No hay líneas válidas para facturar' });
    // LA MITAD DE GESTIÓN VIAJA HASTA EL FINAL. Acá se cortaba: la pantalla
    // mandaba lo resignado por los acuerdos, este handler lo leía —y no se lo
    // pasaba a nadie—. La columna quedaba en NULL y el asiento salía con las tres
    // líneas fiscales, sin la parte de gestión. El preview mostraba cinco líneas
    // y el libro guardaba tres: exactamente lo que el preview promete no hacer.
    // EL TOTAL DE GESTIÓN SALE DE LAS LÍNEAS, no del número que manda la pantalla.
    // La pantalla muestra un preview; el backend es el que decide. Si los dos
    // calcularan por su cuenta, un día no van a coincidir y va a ganar el que
    // nadie mira.
    const gestionLineas = r2(vinculos.reduce((a, v) => a + (Number(v.gestion) || 0), 0));
    const r = await afipEmitir(db, { ptoVta: pv, clienteId, items, esNC: b.es_nc === true,
      userId: uid(req), vinculos,
      descuentoGestion: gestionLineas || (Number(b.descuento_gestion) || 0) });
    if (r.ok) r.pdf_url = '/api/sg/ventas/facturas/' + r.factura_id + '/pdf';
    res.json(r);
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
};
router.post('/facturas/emitir', requireAuth, postEmitir);

// ── FACTURACIÓN DIRECTA ──────────────────────────────────────────────────────
// Se le factura a un cliente mercadería que está en el stock, sin tener que
// armar antes un remito en otra pantalla y volver.
//
// Por dentro SÍ hay una SALIDA, y tiene que haberla: la mercadería sale del
// depósito igual. Sin ella, el lote quedaría figurando como disponible después
// de haberse vendido, y la trazabilidad —qué partida se le mandó a qué
// cliente— se perdería.
//
// PERO NO TODA VENTA EMITE UN REMITO NUEVO (Pablo, 24/8/2026). Acá el papel que
// acompaña la mercadería es la FACTURA: emitir además un remito propio son dos
// documentos del mismo viaje y el operador no sabe cuál mostrar. Así que la
// salida se registra con sin_remito=1 salvo que pidan lo contrario
// (`emitir_remito`), para el caso en que el cliente exige su remito aparte.
//
// EL ORDEN IMPORTA. Primero la salida, después el comprobante. Si AFIP rechaza,
// la salida queda hecha y aparece en «Remitos pendientes de comprobante», que es
// exactamente donde hay que ir a buscarla. Al revés —comprobante primero— un
// error dejaría una factura sin mercadería descontada, y eso no se ve en ningún
// lado hasta que no cierra el stock.
router.post('/facturas/directa', requireAuth, async (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const clienteId = Number(b.cliente_id);
  const items = Array.isArray(b.items) ? b.items : [];
  if (!(clienteId > 0)) return res.status(400).json({ ok: false, error: 'Falta cliente_id' });
  if (!(Number(b.punto_venta) > 0)) return res.status(400).json({ ok: false, error: 'Falta punto de venta' });
  if (!items.length) return res.status(400).json({ ok: false, error: 'No hay nada para facturar' });
  // Se factura lo que ESTÁ. Lo que viene en viaje se anota con un remito y se
  // factura cuando llega: un comprobante de mercadería que no bajó del camión se
  // arregla después con una nota de crédito.
  if (items.some((it) => String(it.origen || 'lote') !== 'lote')) {
    return res.status(400).json({ ok: false,
      error: 'La facturación directa es de mercadería en stock. Lo que viene en viaje se asigna con un remito.' });
  }

  const emiteRemito = b.emitir_remito === true || b.emitir_remito === 1 || b.emitir_remito === '1';
  const rem = crearRemitoInterno(req, {
    sin_remito: emiteRemito ? 0 : 1,
    cliente_id: clienteId,
    fecha_despacho: b.fecha || new Date().toISOString().slice(0, 10),
    transporte: b.transporte || null, chofer: b.chofer || null, dominio: b.dominio || null,
    fletero_id: b.fletero_id || null,
    cooperativa_id: b.cooperativa_id || null, cooperativa_bultos: b.cooperativa_bultos,
    observaciones: b.observaciones || 'Facturación directa',
    items: items.map((it) => ({ origen: 'lote', lote_id: it.lote_id, bultos: it.bultos,
      kg_despachados: it.kg_despachados, precio_por_kg: it.precio_por_kg,
      // EL PRECIO DE LISTA VIAJA HASTA LA LÍNEA. Acá se caía: lo resignado llegaba
      // sólo como un total de la factura, y después no había forma de decir cuánto
      // resignó CADA partida — que es lo que hay que liquidarle a cada productor.
      precio_lista_por_kg: it.precio_lista_por_kg,
      nota_precio: it.nota_precio })),
  });
  if (rem.status !== 200 || !rem.body?.ok) return res.status(rem.status).json(rem.body);
  const despachoId = Number(rem.body.data.id);

  // El comprobante sale del remito recién hecho, por el mismo camino que el de
  // siempre: mismos vínculos, mismo descuento de lo pendiente, mismo PDF.
  const lineas = db.prepare('SELECT id, kg_despachados FROM sg_despacho_items WHERE despacho_id=? ORDER BY id')
    .all(despachoId);
  const fakeReq = Object.create(req);
  fakeReq.body = {
    cliente_id: clienteId, punto_venta: Number(b.punto_venta), es_nc: false,
    precio_incluye_iva: b.precio_incluye_iva === true,
    // LO RESIGNADO POR LOS ACUERDOS. El precio de cada línea ya viene con el
    // descuento aplicado —eso es lo que se factura y lo que va al libro
    // fiscal— y esto es la diferencia contra el precio de lista, que entra al
    // asiento como venta de GESTIÓN: es lo que la empresa pone sobre la mesa
    // en cada acuerdo con un proveedor.
    descuento_gestion: Number(b.descuento_gestion) || 0,
    aplica_descuentos: b.aplica_descuentos ? 1 : 0,
    seleccion: [{ despacho_id: despachoId,
      items: lineas.map((l) => ({ despacho_item_id: l.id, kg: Number(l.kg_despachados) })) }],
  };
  let salida = null;
  const fakeRes = { _st: 200, status(c) { this._st = c; return this; },
    json(o) { salida = { status: this._st, body: o }; return this; } };
  await postEmitir(fakeReq, fakeRes);
  const out = salida || { status: 502, body: { ok: false, error: 'La emisión no contestó' } };
  // El número de la salida viaja siempre: si AFIP rechazó, es el dato con el que
  // se vuelve a intentar desde Remitos pendientes de comprobante. Que no se haya
  // emitido el remito no significa que no haya salida — la hay, y hay que poder
  // nombrarla. Lo que cambia es cómo se la llama en pantalla.
  out.body.remito_id = despachoId;
  out.body.salida_numero = db.prepare('SELECT numero FROM sg_despachos WHERE id=?').get(despachoId)?.numero || null;
  out.body.emitio_remito = emiteRemito ? 1 : 0;
  // Sólo se anuncia como remito si de verdad se emitió uno.
  out.body.remito_numero = emiteRemito ? out.body.salida_numero : null;
  if (!out.body.ok && !out.body.aviso) {
    out.body.aviso = 'La salida ' + out.body.salida_numero + ' quedó hecha y la mercadería salió del stock. '
                   + 'El comprobante se puede volver a emitir desde Remitos pendientes de comprobante.';
  }
  res.status(out.status).json(out.body);
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
router.delete('/condiciones-pago/:id', requireAuth, (req, res) => {
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
  // EL FLETE DE ENTRADA VA EN LA MISMA BOLSA que la descarga: los dos son lo
  // que costó meter esa mercadería adentro, y los dos se reparten por kilo entre
  // los lotes de la recepción. Antes el flete de entrada no llegaba al costo del
  // lote por ningún camino: el comprador lo anotaba en la orden y ahí moría.
  //
  // EL FLETE QUE SAN GERÓNIMO ADELANTÓ POR EL PRODUCTOR NO ES COSTO DE LA
  // PARTIDA. Es plata que se le recupera descontándola de su liquidación: si
  // entrara acá, la mercadería figuraría costando más de lo que costó y el
  // margen de todo lo que se venda de ella saldría bajo por un gasto ajeno.
  // Se mira el flete_a_cargo de la ORDEN y no una marca en el gasto: así hay
  // una sola verdad y no dos que se pueden contradecir.
  let descarga = 0;
  if (lote.recepcion_id) {
    const dt = db.prepare(`SELECT COALESCE(SUM(g.monto),0) s FROM sg_gastos_directos g
      LEFT JOIN sg_recepciones r ON r.id = g.recepcion_id
      LEFT JOIN sg_oc o ON o.id = r.oc_id
      WHERE g.recepcion_id=? AND g.tipo_gasto IN ('descarga_ingreso','flete_entrada')
        AND g.estado='valorizado' AND g.activo=1
        AND NOT (g.tipo_gasto='flete_entrada' AND COALESCE(o.flete_a_cargo,'') = 'vendedor')`)
      .get(lote.recepcion_id).s;
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

// ══════════════════════════════════════════════════════════════════════════
// PISOS — DÓNDE ESTÁ LA MERCADERÍA
// ══════════════════════════════════════════════════════════════════════════
//
// El piso es la APERTURA del inventario: el total sigue siendo uno y el piso lo
// desglosa. Una partida puede estar repartida —entran 100 cajones y se guardan
// 60 arriba y 40 abajo—, así que el saldo se lleva por (partida, piso).
//
// LA REGLA QUE NO SE PUEDE ROMPER: la suma de los pisos de una partida da
// exactamente lo disponible de esa partida. Si algo sale y no se descuenta de
// ningún piso, el total sigue bien y la apertura queda mintiendo — que es peor
// que no tener apertura, porque nadie la va a dudar.
//
// Por eso TODO lo que saca mercadería pasa por descontarDeUbicacion(): el
// despacho, el decomiso, la transformación y el reproceso. Un solo lugar.

// Sumar o restar en un piso. Cantidades en bultos y kg a la vez, porque el stock
// se cuenta en cajones pero se costea en kilos.
function ubicMover(db, loteId, pisoId, dBultos, dKg) {
  const ex = db.prepare('SELECT * FROM sg_lote_ubicaciones WHERE lote_id=? AND piso_id=?')
    .get(loteId, pisoId);
  if (!ex) {
    db.prepare('INSERT INTO sg_lote_ubicaciones (lote_id, piso_id, bultos, kg) VALUES (?,?,?,?)')
      .run(loteId, pisoId, r2(dBultos), r2(dKg));
    return;
  }
  const b = r2((ex.bultos || 0) + dBultos), k = r2((ex.kg || 0) + dKg);
  // La fila en cero se borra: una lista de pisos con ceros hace buscar en
  // lugares donde no hay nada.
  if (Math.abs(b) < 0.001 && Math.abs(k) < 0.01) {
    db.prepare('DELETE FROM sg_lote_ubicaciones WHERE id=?').run(ex.id);
  } else {
    db.prepare('UPDATE sg_lote_ubicaciones SET bultos=?, kg=? WHERE id=?').run(b, k, ex.id);
  }
}

// CUÁNTOS BULTOS SON ESOS KILOS. El decomiso y la transformación se cargan en
// kilos, pero la ubicación lleva las dos unidades: sin esto, el saldo en kilos
// bajaría y el de bultos quedaría intacto, y la misma partida diría dos cosas.
// Si el lote no tiene factor conocido, devuelve 0: es preferible no mover los
// bultos a inventar una cantidad.
function bultosDeKg(db, loteId, kg) {
  const l = db.prepare(`SELECT COALESCE(l.kg_por_bulto, ps.factor_conversion) AS kpb
    FROM sg_lotes l LEFT JOIN sg_presentaciones ps ON ps.id=l.presentacion_id
    WHERE l.id=?`).get(loteId);
  const kpb = l && Number(l.kpb) > 0 ? Number(l.kpb) : 0;
  return kpb > 0 ? r2(Number(kg || 0) / kpb) : 0;
}
const bultosDecomisados = bultosDeKg;

// Dónde está una partida, ordenado como se ordenan los pisos.
function ubicacionesDeLote(db, loteId) {
  return db.prepare(`SELECT u.*, p.nombre AS piso_nombre, p.codigo AS piso_codigo, p.orden
    FROM sg_lote_ubicaciones u JOIN sg_pisos p ON p.id=u.piso_id
    WHERE u.lote_id=? ORDER BY p.orden, p.id`).all(loteId);
}

// UBICAR lo que entra. `reparto` es [{piso_id, bultos, kg}]; si no viene, entra
// todo al piso que se indique.
function ubicarLote(db, loteId, reparto) {
  for (const r of (reparto || [])) {
    const piso = Number(r.piso_id);
    if (!piso) continue;
    ubicMover(db, loteId, piso, Number(r.bultos) || 0, Number(r.kg) || 0);
  }
}

// SACAR de los pisos. Si viene pisoId, sale de ahí y sólo de ahí —el que armó el
// remito dijo de dónde lo bajó—. Si no viene, sale por orden de piso hasta
// completar: es determinístico, así que dos personas obtienen lo mismo.
//
// Si la partida no está ubicada en ningún lado —lo que pasa con todo lo que se
// recibió antes de que existieran los pisos— no se descuenta nada y no se corta:
// la mercadería vieja no tiene por qué frenar una venta.
function descontarDeUbicacion(db, loteId, bultos, kg, pisoId) {
  const ubic = ubicacionesDeLote(db, loteId);
  if (!ubic.length) return { ok: true, sinUbicar: true };
  let restB = Number(bultos) || 0, restK = Number(kg) || 0;
  if (pisoId) {
    const u = ubic.find((x) => x.piso_id === Number(pisoId));
    if (!u) {
      return { ok: false, error: 'Esa partida no tiene mercadería en el piso elegido.' };
    }
    if (restB - (u.bultos || 0) > 0.001) {
      return { ok: false,
        error: `En ${u.piso_nombre} hay ${u.bultos} bulto(s) de esa partida y se piden ${restB}.` };
    }
    ubicMover(db, loteId, u.piso_id, -restB, -restK);
    return { ok: true };
  }
  for (const u of ubic) {
    if (restB <= 0.001 && restK <= 0.01) break;
    const tomaB = Math.min(u.bultos || 0, restB);
    // Los kilos se llevan en la misma proporción que los bultos, salvo en el
    // último piso, donde se lleva lo que reste: así no queda un resto de
    // decimales colgado que después nadie sabe de dónde salió.
    const tomaK = (u.bultos > 0 && restB > 0)
      ? Math.min(u.kg || 0, r2(restK * (tomaB / restB)))
      : Math.min(u.kg || 0, restK);
    ubicMover(db, loteId, u.piso_id, -tomaB, -tomaK);
    restB = r2(restB - tomaB); restK = r2(restK - tomaK);
  }
  return { ok: true, faltante: (restB > 0.001 || restK > 0.01) ? { bultos: restB, kg: restK } : null };
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

  // ── SI YA HAY FACTURA, MANDA LA FACTURA ─────────────────────────────────
  // Lo que se le debe al proveedor es lo que dice su comprobante: el TOTAL, con
  // IVA y percepciones adentro. El costo de los lotes es otra cosa —es neto, y
  // es lo que vale la mercadería para el stock—, y usarlo como deuda dejaba la
  // cuenta corriente corta justo por el IVA.
  //
  // Cuando la factura cubre varias partidas, a cada una le toca su parte, en la
  // proporción de su neto: la deuda es una sola y no se puede contar entera en
  // cada partida.
  const fac = db.prepare(`SELECT f.id, f.total, f.neto, f.fecha_emision
      FROM sg_facturas_compra f
     WHERE f.activo = 1
       AND (f.oc_id = ? OR EXISTS (SELECT 1 FROM sg_factura_compra_ocs fo
                                    WHERE fo.factura_id = f.id AND fo.oc_id = ?))
     ORDER BY f.id DESC LIMIT 1`).get(ocId, ocId);
  let montoFactura = null;
  if (fac && Number(fac.total) > 0) {
    const partes = db.prepare('SELECT oc_id, neto FROM sg_factura_compra_ocs WHERE factura_id=?').all(fac.id);
    const sumaNetos = partes.reduce((a, p) => a + (Number(p.neto) || 0), 0);
    const mio = partes.find((p) => Number(p.oc_id) === Number(ocId));
    montoFactura = (partes.length > 1 && sumaNetos > 0 && mio)
      ? r2(Number(fac.total) * (Number(mio.neto) || 0) / sumaNetos)
      : r2(Number(fac.total));
  }

  const real = db.prepare(`
    SELECT COALESCE(SUM(l.costo_base),0) s, COUNT(*) n,
           SUM(CASE WHEN l.precio_unitario_kg IS NULL THEN 1 ELSE 0 END) sinprecio
    FROM sg_lotes l JOIN sg_oc_items i ON l.oc_item_id=i.id
    WHERE i.oc_id=? AND l.activo=1`).get(ocId);
  let monto;
  if (montoFactura != null) {
    monto = montoFactura;
  } else if (real.n > 0) {
    if (real.sinprecio > 0) return; // pizarra con precios pendientes → no generar todavía
    monto = real.s;
  } else {
    monto = oc.total_estimado_monto || 0;
  }
  if (!monto) return;

  const ultRec = db.prepare('SELECT MAX(fecha_recepcion) f FROM sg_recepciones WHERE oc_id=? AND activo=1').get(ocId).f;
  const fechaBase = (bc) => {
    if (bc === 'fecha_recepcion') return ultRec || oc.fecha_recepcion_estimada || oc.fecha_oc;
    // "A tantos días de la factura" ahora es de verdad la fecha de la factura.
    // Antes se aproximaba con la de recepción porque no había comprobante.
    if (bc === 'fecha_factura') return (fac && fac.fecha_emision) || ultRec || oc.fecha_oc;
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

// ── ¿LIQUIDAMOS O RECIBIMOS FACTURA DE COMPRA? ────────────────────────────────
// Es lo primero que se define en una compra, y de ahí sale el resto: a qué
// bandeja va la partida cuando se reciba, con qué comprobante, y si el precio
// puede ser de pizarra.
//
// Antes esto se DEDUCÍA de la condición comercial y quedaba ambiguo: Precio
// Cerrado podía ser con factura o con liquidación, y la partida caía en la
// bandeja equivocada — la de facturas, que sólo acepta A o B — y ahí se trababa.
// Ahora se pregunta.
//
// Si no se preguntó (una carga vieja, o un llamado que no manda el campo) se
// deduce igual que la migración de arranque, para no cambiarle el circuito a
// nada que ya estaba cargado.
function circuitoDeCompra(b, tipoFiscalDefault) {
  let doc = (b.documenta === 'liquidacion' || b.documenta === 'factura') ? b.documenta : null;
  if (!doc) {
    doc = (val(b.tipo_precio) === 'pizarra' || tipoFiscalDefault === 'liquidacion')
      ? 'liquidacion' : 'factura';
  }
  // ── CÓMO SE PACTÓ EL PRECIO Y CÓMO SE DOCUMENTA SON DOS PREGUNTAS ──────
  // Antes esto forzaba: "con factura no hay precio de pizarra". Y no es cierto
  // —se puede acordar liquidación de venta con un productor que igual emite
  // factura: el precio se cierra cuando la mercadería se vendió, y la factura
  // llega después con ese número—. Esa combinación quedaba bloqueada y la orden
  // no se podía cargar como era.
  //
  // Las cuatro valen:
  //   precio cerrado      + recibimos factura
  //   precio cerrado      + emitimos liquidación
  //   liquidación de venta + emitimos liquidación
  //   liquidación de venta + recibimos factura   ← ésta no se podía
  const tipoPrecio = (val(b.tipo_precio) === 'pizarra') ? 'pizarra' : 'firme';
  // Y el comprobante tiene que decir lo mismo que el circuito. El habitual del
  // proveedor entra por atrás y si no se corrige queda la combinación imposible
  // guardada: una compra que se documenta con factura y dice comprobante
  // "liquidación", o al revés.
  let tipoFiscal = tipoFiscalDefault;
  if (doc === 'liquidacion') tipoFiscal = 'liquidacion';
  else if (tipoFiscal === 'liquidacion') tipoFiscal = 'factura_a';
  return { documenta: doc, tipoPrecio, tipoFiscal };
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

function crearLotesDeItem(db, { recepcionId, ocItem, tipoPrecio, fechaIngreso, lotes, userId, req }) {
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
    const nuevoLoteId = info.lastInsertRowid;
    // ── DONDE QUEDO LA MERCADERIA ────────────────────────────────────────
    // El sub-lote puede traer un reparto —60 cajones arriba y 40 abajo— o un
    // solo piso para todo. Si no viene nada, se cae al piso que PROPUSO la orden
    // de compra: al comprar ya se suele saber donde va a ir, y el que recibe no
    // tiene por que volver a elegirlo si no cambio.
    //
    // Si no hay ni una cosa ni la otra, la partida queda SIN UBICAR. No se
    // inventa un piso: figurar en un lugar donde no esta es peor que no figurar,
    // porque el que va a buscarla pierde el viaje.
    let reparto = Array.isArray(lt.ubicaciones) ? lt.ubicaciones.slice() : [];
    if (!reparto.length) {
      const pedido = (lt.piso_id != null && lt.piso_id !== '') ? Number(lt.piso_id) : (ocItem.piso_id != null ? Number(ocItem.piso_id) : null);
      const elec = pisoParaRecibir(db, req, pedido);
      if (elec.error) throw new Error(elec.error);
      if (elec.piso) reparto = [{ piso_id: elec.piso, bultos: bultos || 0, kg: kg }];
    }
    // Lo repartido no puede sumar mas de lo que entro: si no, el piso mostraria
    // mercaderia que no existe.
    const sumaB = reparto.reduce((a, x) => a + (Number(x.bultos) || 0), 0);
    if (bultos != null && sumaB - bultos > 0.001) {
      throw new Error('El reparto por piso suma ' + sumaB + ' bulto(s) y entraron ' + bultos + '.');
    }
    ubicarLote(db, nuevoLoteId, reparto);
    ids.push(nuevoLoteId);
    _aplicarObservado(db, nuevoLoteId, _rec, userId);
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
function crearLotesSinOC(db, { recepcionId, productoId, fechaIngreso, lotes, userId, req }) {
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
    const nuevoLoteId = info.lastInsertRowid;
    // ── DONDE QUEDO LA MERCADERIA ────────────────────────────────────────
    // El sub-lote puede traer un reparto —60 cajones arriba y 40 abajo— o un
    // solo piso para todo. Si no viene nada, se cae al piso que PROPUSO la orden
    // de compra: al comprar ya se suele saber donde va a ir, y el que recibe no
    // tiene por que volver a elegirlo si no cambio.
    //
    // Si no hay ni una cosa ni la otra, la partida queda SIN UBICAR. No se
    // inventa un piso: figurar en un lugar donde no esta es peor que no figurar,
    // porque el que va a buscarla pierde el viaje.
    let reparto = Array.isArray(lt.ubicaciones) ? lt.ubicaciones.slice() : [];
    if (!reparto.length) {
      const pedido = (lt.piso_id != null && lt.piso_id !== '') ? Number(lt.piso_id) : null;
      const elec = pisoParaRecibir(db, req, pedido);
      if (elec.error) throw new Error(elec.error);
      if (elec.piso) reparto = [{ piso_id: elec.piso, bultos: bultos || 0, kg: kg }];
    }
    // Lo repartido no puede sumar mas de lo que entro: si no, el piso mostraria
    // mercaderia que no existe.
    const sumaB = reparto.reduce((a, x) => a + (Number(x.bultos) || 0), 0);
    if (bultos != null && sumaB - bultos > 0.001) {
      throw new Error('El reparto por piso suma ' + sumaB + ' bulto(s) y entraron ' + bultos + '.');
    }
    ubicarLote(db, nuevoLoteId, reparto);
    ids.push(nuevoLoteId);
    _aplicarObservado(db, nuevoLoteId, _rec, userId);
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
  // LA MERCADERÍA NO SE TELETRANSPORTA. Lo que sale del lote madre sale del
  // piso donde estaba, y el lote hijo nace EN ESE MISMO LUGAR: nadie lo movió,
  // se le cambió el envase o la clasificación ahí mismo.
  const dondeEstaba = ubicacionesDeLote(db, origen.id);
  descontarDeUbicacion(db, origen.id, bultosDeKg(db, origen.id, kg), kg, null);
  if (dondeEstaba.length) {
    // Al piso donde había más de la madre: es de donde salió la mayor parte.
    const principal = dondeEstaba.slice().sort((a, b) => (b.bultos || 0) - (a.bultos || 0))[0];
    ubicarLote(db, destinoId, [{ piso_id: principal.piso_id, bultos: blt || 0, kg: kg }]);
  }
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
//
// Y NO SE INFORMA NADA HASTA QUE LA ORDEN SE RECEPCIONÓ. Sobre una orden que
// todavía no recibió nada, "faltan 1.000 kg" no es una diferencia: es la orden
// entera esperando el camión. El comprador ve una alerta roja sobre algo que
// no pasó, y el día que la alerta importa de verdad ya aprendió a no mirarla.
//
// EL CORTE ES "TIENE AL MENOS UNA RECEPCIÓN", que es lo que pidió Pablo.
// Se probó con `cerrada_en` --dar la orden por terminada-- y es MÁS estricto de
// lo que se pidió: rompe el caso normal de recibir y mirar el detalle sin haber
// cerrado nada.
//
// LO QUE ESTO NO TAPA, y hay que decirlo: con recepciones parciales la alerta
// aparece desde el primer camión, porque después de la primera entrada ya no hay
// forma de distinguir "falta" de "todavía no llegó". El estado tampoco ayuda:
// actualizarEstadoOC() pone 'recibida_total' apenas hay UNA recepción. Para
// cortarlo del todo habría que mirar `cerrada_en`, y eso es otra decisión.
function diferenciasDeOC(db, ocId) {
  const recibida = db.prepare(`SELECT COUNT(*) c FROM sg_recepciones
    WHERE oc_id = ? AND activo = 1`).get(ocId).c;
  if (!recibida) return [];
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
    // Flete INFORMATIVO: se guarda quién paga + el monto que carga el comercial, pero
    // NO entra al total (el total sigue saliendo solo del loop de items, más abajo).
    const fleteCargo = (b.flete_a_cargo === 'comprador' || b.flete_a_cargo === 'vendedor') ? b.flete_a_cargo : null;
    // Quién puso la plata. Sólo aplica al flete del vendedor; en cualquier otro
    // caso queda en null para que no quede un dato que contradice al de al lado.
    const fletePagadoPor = (fleteCargo === 'vendedor'
      && (b.flete_pagado_por === 'san_geronimo' || b.flete_pagado_por === 'productor'))
      ? b.flete_pagado_por
      : (fleteCargo === 'vendedor' ? 'productor' : null);
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
    const { documenta, tipoPrecio, tipoFiscal } = circuitoDeCompra(b, dft.tipo_fiscal);
    // ── EL IVA NO ES SÓLO DE LA FACTURA ───────────────────────────────────
    // La liquidación que emitimos también lleva IVA, así que "el precio ya
    // incluye IVA" vale igual ahí. Antes el bloque decía "Factura A" y sólo se
    // guardaba con factura: el que emitía liquidación no tenía dónde decirlo y
    // el neto salía mal.
    //
    // Factura B queda afuera a propósito: no discrimina IVA, siempre va incluido.
    // Y la PIZARRA también: todavía no hay precio al que aplicarle nada — se
    // resuelve cuando se cierra.
    //
    // precio_incluye_iva: el comercial define si el $/kg ya trae IVA o si se le
    // adiciona. iva_alicuota_oc: override opcional; si es null, la alícuota sale
    // de la familia de cada item.
    const discrimina = (tipoFiscal === 'factura_a' || tipoFiscal === 'liquidacion')
      && (tipoPrecio === 'firme');
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
         fecha_recepcion_estimada, comercial_id, estado, observaciones, flete_a_cargo, flete_pagado_por, flete_monto,
         precio_incluye_iva, iva_alicuota_oc, total_estimado_kg, total_estimado_monto, creado_por,
         trazabilidad, flete_modalidad, flete_cantidad, flete_precio_unit, flete_con_iva, documenta)
        VALUES (?,?,?,?,?,?,?,?,?, 'abierta', ?,?,?,?, ?,?, 0, 0, ?, ?, ?,?,?,?,?)`).run(
        numero, val(b.modalidad) || 'normal', b.proveedor_id || null, tipoFiscal, tipoPrecio,
        dft.condicion_pago_id, val(b.fecha_oc), val(b.fecha_recepcion_estimada), b.comercial_id || null,
        val(b.observaciones), fleteCargo, fletePagadoPor, fleteMonto, (discrimina ? incluyeIva : null), alicOverride, uid(req),
        traza, fleteModalidad, fleteCantidad, fletePrecioUnit, fleteConIva, documenta);
      const ocId = ocInfo.lastInsertRowid;

      const insItem = db.prepare(`INSERT INTO sg_oc_items
        (oc_id, producto_id, presentacion_id, envase_id, kg_por_bulto, cantidad_estimada_presentaciones, kg_estimados, precio_estimado_por_kg, observaciones_item, modo_carga,
         iva_alicuota, neto_estimado, iva_estimado, precio_referencia_venta)
        VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?, ?)`);
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
        // EL PRECIO DE REFERENCIA es informativo y sólo tiene sentido cuando el
        // precio se cierra despues (liquidacion de venta). Con precio cerrado no
        // se guarda: al lado ya esta el precio de verdad, y dos numeros
        // parecidos en la misma linea es una manera de equivocarse.
        const refVenta = (tipoPrecio === 'pizarra'
          && it.precio_referencia_venta != null && it.precio_referencia_venta !== ''
          && Number(it.precio_referencia_venta) > 0)
          ? Number(it.precio_referencia_venta) : null;
        insItem.run(ocId, it.producto_id, it.presentacion_id || null, envaseId, kgPorBulto, cant, kg, precio, val(it.observaciones_item), modo,
          alic, neto, iva, refVenta);
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
// Una vez que la mercadería entró, la orden todavía tiene algo pendiente: el
// papel. Y lo decide 'documenta', que es lo que se contestó al cargar la compra:
//
//   Emitimos liquidación      → hay que LIQUIDARLA.
//   Recibimos factura         → hay que cargarle la FACTURA del proveedor.
//
// Son dos bandejas de trabajo distintas, para dos personas distintas, y hasta
// ahora no existía ninguna: la orden se recibía y desaparecía del circuito.
//
// ANTES LO DECIDÍA LA CONDICIÓN COMERCIAL, y ahí estaba el error: una compra a
// Precio Cerrado cuyo comprobante era una Liquidación caía en la bandeja de
// facturas y quedaba trabada — esa pantalla sólo carga Factura A o B, y ninguna
// de las dos era la que declaraba la orden. Precio Cerrado y Liquidación no son
// lo mismo: se puede comprar a precio cerrado y documentarlo con liquidación.
//
// El COALESCE es para las órdenes anteriores a la pregunta: se deduce lo mismo
// que hizo la migración de arranque, así una fila sin migrar no cambia de lado.
//   pendiente de liquidar  = todavía no tiene su liquidación cargada
//   pendiente de facturar  = ninguna de sus recepciones tiene número de factura
// Las partidas que ya tienen su liquidación cargada. En UNA consulta para todas:
// preguntarlo por fila serían N consultas para pintar una lista. La tabla es del
// módulo de Abasto, así que si por orden de carga todavía no existe se sigue sin
// ella en vez de romper la pantalla entera.
function partidasConLiquidacion(db) {
  try {
    return new Set(db.prepare(
      'SELECT DISTINCT oc_id FROM liquidaciones WHERE oc_id IS NOT NULL AND eliminado_en IS NULL')
      .all().map((r) => Number(r.oc_id)));
  } catch (_) { return new Set(); }
}

function partidasRecibidas(db, comoSeDocumenta) {
  return db.prepare(`
    SELECT o.id, o.numero, o.trazabilidad, o.fecha_oc, o.tipo_precio, o.tipo_fiscal, o.estado,
           o.cerrada_en, o.liquidada_en, o.total_estimado_kg,
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
           -- ── CUÁNTO DE ESTA PARTIDA YA SALIÓ ────────────────────────
           -- Una partida a precio abierto se liquida cuando se vendió: liquidar
           -- con la mitad en el depósito es fijarle precio a lo que todavía no
           -- se sabe cuánto va a rendir. En BULTOS, que es como se cuenta el
           -- camión y como lo cuenta el proveedor.
           (SELECT COALESCE(SUM(di.bultos),0) FROM sg_despacho_items di
              JOIN sg_despachos d ON d.id = di.despacho_id AND d.activo = 1
              JOIN sg_lotes l ON l.id = di.lote_id AND l.activo = 1
              JOIN sg_oc_items i ON i.id = l.oc_item_id
             WHERE i.oc_id = o.id) AS bultos_vendidos,
           -- LA MERMA TAMBIÉN TERMINA LA PARTIDA. Pablo, 24/8/2026: "lo que tiene
           -- que estar terminada es la partida: en una de 60 bultos ingresados
           -- puede pasar que tengamos vendidos 55 y 5 sean merma. Obviamente esos
           -- 5 van a precio de venta 0 — están 'vendidos' pero suman cero."
           --
           -- Sin esto, una partida que salió entera —parte vendida, parte tirada—
           -- se veía en rojo para siempre y nunca daba "lista para liquidar".
           (SELECT COALESCE(SUM(dc.bultos),0) FROM sg_lote_decomisos dc
              JOIN sg_lotes l ON l.id = dc.lote_id AND l.activo = 1
              JOIN sg_oc_items i ON i.id = l.oc_item_id
             WHERE i.oc_id = o.id) AS bultos_merma,
           (SELECT COUNT(*) FROM sg_lotes l
              JOIN sg_oc_items i ON i.id = l.oc_item_id
             WHERE i.oc_id = o.id AND l.activo = 1 AND l.precio_unitario_kg IS NULL) AS lotes_sin_precio,
           -- ── "YA ESTÁ FACTURADA" ES QUE EXISTE LA FACTURA DE COMPRA ────
           -- Antes se leía de sg_recepciones.factura_numero, que es un campo
           -- del PASO 1 de la recepción: la documentación que trae el camión.
           -- El operador anotaba ahí el número del remito o de la factura y la
           -- partida desaparecía de "pendientes de facturar" y se pintaba verde
           -- "Facturada", sin que existiera ninguna factura cargada, ningún
           -- asiento y ninguna deuda registrada.
           (SELECT GROUP_CONCAT((CASE WHEN f.punto_venta IS NOT NULL AND f.punto_venta <> ''
                                      THEN f.punto_venta || '-' ELSE '' END) || f.numero, ' · ')
              FROM sg_facturas_compra f
             WHERE f.activo = 1
               AND (f.oc_id = o.id
                    OR EXISTS (SELECT 1 FROM sg_factura_compra_ocs fo
                                WHERE fo.factura_id = f.id AND fo.oc_id = o.id))) AS facturas,
           -- El número que anotó el que recibió el camión. Se sigue mostrando
           -- —es un dato del remito— pero ya no decide nada.
           (SELECT GROUP_CONCAT(r.factura_numero, ' · ') FROM sg_recepciones r
             WHERE r.oc_id = o.id AND r.activo = 1
               AND r.factura_numero IS NOT NULL AND r.factura_numero <> '') AS remito_factura,
           (SELECT MAX(r.fecha_recepcion) FROM sg_recepciones r
             WHERE r.oc_id = o.id AND r.activo = 1) AS fecha_recepcion
      FROM sg_oc o LEFT JOIN sg_proveedores p ON p.id = o.proveedor_id
     WHERE o.activo = 1 AND COALESCE(o.documenta, CASE
            WHEN o.tipo_precio = 'pizarra' THEN 'liquidacion'
            WHEN o.tipo_fiscal = 'liquidacion' THEN 'liquidacion'
            ELSE 'factura' END) = ?
       AND o.estado IN ('recibida_total','cerrada')
     ORDER BY o.id DESC`).all(comoSeDocumenta);
}

// ── PARTIDAS QUE TODAVÍA NO SE LIQUIDARON ───────────────────────────────
//
// UNA PARTIDA SALE DE LA BANDEJA CUANDO SE LE CARGA SU LIQUIDACIÓN, y no antes.
// El criterio de antes era "tiene lotes sin precio cerrado", y dejaba afuera
// justo la mitad del circuito: una compra a Precio Cerrado que se documenta con
// liquidación llega con el precio ya puesto desde la recepción, así que nunca
// aparecía acá y la liquidación quedaba sin emitir sin que nadie lo viera.
// Al revés también fallaba: la de pizarra se iba de la bandeja apenas alguien
// cerraba el precio a mano, con la liquidación todavía sin cargar.
//
// El precio sigue mostrándose en la lista (lotes_sin_precio), pero como dato de
// la partida, no como criterio.
// ── ADMINISTRAR LOS PISOS ────────────────────────────────────────────────
// Se dan de alta y de baja desde Stock. No se borran: una partida vieja puede
// haber estado ahí, y borrar el piso dejaría ese historial apuntando a la nada.
// ── DE QUIÉN ES CADA PISO ────────────────────────────────────────────────
// UNA sola regla, la misma que la de las cuentas de tesorería
// (puedeMoverCuenta en rutas/sg_tesoreria.js): si tiene gente asignada lo tocan
// sólo ellos; si no tiene a nadie, lo toca cualquiera que tenga permiso en el
// módulo. Esa segunda mitad es la que resuelve el arranque — el día que esto se
// despliega ningún piso tiene usuarios, y con "sólo los asignados" nadie podría
// recibir hasta terminar de configurarlo.
//
// VER NO SE LIMITA, MOVER SÍ. El stock de todos los pisos se sigue viendo
// entero: mirar dónde está la mercadería no hace daño, y esconderlo obliga a
// preguntar por teléfono. Lo que se limita es tocar.
function puedeMoverPiso(db, req, pisoId) {
  const u = req.user;
  if (!u || !u.id) return false;
  if (u.rol === 'admin') return true;
  const n = db.prepare('SELECT COUNT(*) c FROM sg_piso_usuarios WHERE piso_id=?').get(pisoId).c;
  if (!n) return true;
  return !!db.prepare('SELECT 1 FROM sg_piso_usuarios WHERE piso_id=? AND usuario_id=?')
    .get(pisoId, u.id);
}

// EL PISO SALE DEL USUARIO. Antes se elegía a mano de una lista con TODOS, y
// el que recibe en Empaque tenía que acordarse de no elegir San Pedro.
//
// Si está asignado a UNO solo, ese va directo y no se le pregunta nada. Si
// trabaja en varios, elige él --ahí sí corresponde el selector--. Y si no está
// asignado a ninguno, sigue como hasta hoy: elige, y la regla de arriba decide
// si ese piso lo puede tocar.
function pisosAsignados(db, req) {
  const u = req.user;
  if (!u || !u.id) return [];
  return db.prepare(`SELECT pu.piso_id FROM sg_piso_usuarios pu
    JOIN sg_pisos p ON p.id = pu.piso_id AND p.activo = 1
    WHERE pu.usuario_id = ? ORDER BY p.orden, p.id`).all(u.id).map((x) => x.piso_id);
}

// LO QUE LA RECEPCIÓN NECESITA SABER ANTES DE PREGUNTAR NADA. Con un solo piso
// asignado no hay nada que elegir; con varios, la lista es la de los suyos.
router.get('/mis-pisos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const asignados = pisosAsignados(db, req);
    const puedo = pisosDeUsuario(db, req);
    const pisos = db.prepare('SELECT id, nombre, codigo FROM sg_pisos WHERE activo=1 ORDER BY orden, id')
      .all().filter((p) => puedo.includes(p.id));
    res.json({ ok: true, data: {
      pisos,
      // El que va solo, sin preguntar. Null cuando hay que elegir.
      automatico: (asignados.length === 1) ? asignados[0] : null,
      asignados: asignados.length,
      // Sin asignaciones la lista son TODOS los pisos: no es un permiso amplio,
      // es que todavía no se configuró. La pantalla lo dice distinto.
      sin_configurar: asignados.length ? 0 : 1,
    } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Qué piso usar para lo que entra. Devuelve {piso} o {error}.
function pisoParaRecibir(db, req, pedido) {
  if (pedido) {
    const no = exigirPiso(db, req, Number(pedido), 'recibir');
    return no ? { error: no } : { piso: Number(pedido) };
  }
  const mios = pisosAsignados(db, req);
  return { piso: (mios.length === 1) ? mios[0] : null };
}

// El freno, con el nombre del piso adentro: "no tenés permiso" sin decir sobre
// qué manda a adivinar.
function exigirPiso(db, req, pisoId, verbo) {
  if (puedeMoverPiso(db, req, pisoId)) return null;
  const p = db.prepare('SELECT nombre FROM sg_pisos WHERE id=?').get(pisoId);
  return (p ? p.nombre : 'Ese piso') + ' lo maneja otra persona: no podés ' + verbo
       + ' ahí. Se cambia en Pisos.';
}

// Los pisos que este usuario SÍ puede tocar. La recepción lo usa para no
// ofrecer una lista donde la mayoría de las opciones van a rebotar.
function pisosDeUsuario(db, req) {
  return db.prepare('SELECT id FROM sg_pisos WHERE activo=1 ORDER BY orden, id')
    .all().filter((p) => puedeMoverPiso(db, req, p.id)).map((p) => p.id);
}

router.get('/pisos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const inactivos = req.query.inactivos === '1';
    const rows = db.prepare(`SELECT p.*,
        (SELECT COUNT(DISTINCT u.lote_id) FROM sg_lote_ubicaciones u WHERE u.piso_id = p.id) AS partidas,
        (SELECT COALESCE(SUM(u.bultos),0) FROM sg_lote_ubicaciones u WHERE u.piso_id = p.id) AS bultos,
        (SELECT COALESCE(SUM(u.kg),0)     FROM sg_lote_ubicaciones u WHERE u.piso_id = p.id) AS kg
      FROM sg_pisos p ${inactivos ? '' : 'WHERE p.activo = 1'}
      ORDER BY p.orden, p.id`).all();
    const quienes = db.prepare(`SELECT pu.piso_id, pu.usuario_id, u.nombre
      FROM sg_piso_usuarios pu LEFT JOIN usuarios u ON u.id = pu.usuario_id
      ORDER BY u.nombre COLLATE NOCASE`).all();
    for (const p of rows) {
      p.usuarios = quienes.filter((x) => x.piso_id === p.id)
        .map((x) => ({ id: x.usuario_id, nombre: x.nombre || ('#' + x.usuario_id) }));
      // `puedo` para que la pantalla no ofrezca lo que va a contestar 403: el
      // que aprieta un botón que rebota cree que rompió algo.
      p.puedo = puedeMoverPiso(db, req, p.id) ? 1 : 0;
    }
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/pisos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    if (!nombre) return res.status(400).json({ ok: false, error: 'Poné el nombre del piso' });
    const id = parseInt(b.id, 10);
    // El nombre no se repite: dos "Piso 2" son dos lugares que el que busca no
    // puede distinguir.
    const ya = db.prepare('SELECT id FROM sg_pisos WHERE lower(nombre)=lower(?) AND id <> ?')
      .get(nombre, id || 0);
    if (ya) return res.status(400).json({ ok: false, error: 'Ya hay un piso con ese nombre' });
    const campos = [nombre, String(b.codigo || '').trim() || null,
      Number(b.orden) || 0, String(b.notas || '').trim() || null];
    if (id) {
      db.prepare(`UPDATE sg_pisos SET nombre=?, codigo=?, orden=?, notas=?,
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
        .run(...campos, uid(req), id);
      return res.json({ ok: true, id });
    }
    const r = db.prepare('INSERT INTO sg_pisos (nombre, codigo, orden, notas, creado_por) VALUES (?,?,?,?,?)')
      .run(...campos, uid(req));
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── QUIÉN TOCA ESTE PISO ─────────────────────────────────────────────────
// Va con requireAdmin porque esto PARAMETRIZA: decidir de quién es un piso es
// la misma clase de decisión que dar de alta una cuenta bancaria y elegir quién
// la mueve. El trabajo del día —recibir, trasladar— sigue con requireAuth.
// Quiénes están asignados y entre quiénes elegir. Mismo par que el de las
// cuentas de tesorería (sgCbUsrOpen), para que la pantalla se parezca.
router.get('/pisos/:id/usuarios', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const asignados = db.prepare(`SELECT pu.usuario_id, u.nombre FROM sg_piso_usuarios pu
      LEFT JOIN usuarios u ON u.id = pu.usuario_id WHERE pu.piso_id = ?`).all(req.params.id);
    const todos = db.prepare(`SELECT id, nombre, rol FROM usuarios
      WHERE COALESCE(activo,1) = 1 ORDER BY nombre COLLATE NOCASE`).all();
    res.json({ ok: true, data: { asignados, todos } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/pisos/:id/usuarios', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const p = db.prepare('SELECT id, nombre FROM sg_pisos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'Piso no encontrado' });
    const ids = Array.isArray(req.body && req.body.usuarios)
      ? [...new Set(req.body.usuarios.map(Number).filter((x) => x > 0))] : [];
    for (const u of ids) {
      if (!db.prepare('SELECT 1 FROM usuarios WHERE id=?').get(u)) {
        return res.status(400).json({ ok: false, error: 'Hay un usuario que no existe (#' + u + ')' });
      }
    }
    db.transaction(() => {
      db.prepare('DELETE FROM sg_piso_usuarios WHERE piso_id=?').run(p.id);
      const ins = db.prepare('INSERT INTO sg_piso_usuarios (piso_id, usuario_id) VALUES (?,?)');
      for (const u of ids) ins.run(p.id, u);
    })();
    // SIN NADIE NO ES "NADIE PUEDE": es "lo puede cualquiera con permiso". Se
    // contesta explícito para que la pantalla lo diga y no parezca un candado.
    res.json({ ok: true, data: { piso_id: p.id, usuarios: ids, abierto: ids.length ? 0 : 1 } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.post('/pisos/:id/baja', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const p = db.prepare('SELECT * FROM sg_pisos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'Piso no encontrado' });
    // CON MERCADERÍA ADENTRO NO SE DA DE BAJA. El piso desaparecería de las
    // pantallas con la mercadería adentro, y esos kilos quedarían en el total
    // sin lugar donde ir a buscarlos.
    const hay = db.prepare('SELECT COALESCE(SUM(bultos),0) b, COALESCE(SUM(kg),0) k FROM sg_lote_ubicaciones WHERE piso_id=?').get(p.id);
    if ((hay.b || 0) > 0.001 || (hay.k || 0) > 0.01) {
      return res.status(400).json({ ok: false,
        error: `${p.nombre} todavía tiene mercadería (${Math.round(hay.b)} bulto(s), `
             + `${Math.round(hay.k)} kg). Trasladala a otro piso antes de darlo de baja.` });
    }
    db.prepare(`UPDATE sg_pisos SET activo=0, modificado_en=datetime('now','localtime'),
      modificado_por=? WHERE id=?`).run(uid(req), p.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── EL STOCK, ABIERTO POR PISO ───────────────────────────────────────────
// El total es el mismo de siempre; esto lo desglosa. Con ?piso_id= devuelve sólo
// ese, que es el filtro que pide la pantalla.
router.get('/stock-pisos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const pisoId = req.query.piso_id ? Number(req.query.piso_id) : null;
    const rows = db.prepare(`SELECT u.piso_id, p.nombre AS piso_nombre, p.codigo AS piso_codigo, p.orden,
        u.lote_id, l.codigo_lote, l.calidad, l.semaforo, l.fecha_vencimiento_estimada,
        l.producto_id, pr.nombre AS producto_nombre,
        u.bultos, u.kg,
        CAST(julianday(l.fecha_vencimiento_estimada) - julianday(date('now','localtime')) AS INTEGER) AS dias_restantes
      FROM sg_lote_ubicaciones u
      JOIN sg_pisos p ON p.id = u.piso_id
      JOIN sg_lotes l ON l.id = u.lote_id AND l.activo = 1
      LEFT JOIN sg_productos pr ON pr.id = l.producto_id
      WHERE (u.bultos > 0.001 OR u.kg > 0.01) ${pisoId ? 'AND u.piso_id = ?' : ''}
      ORDER BY p.orden, p.id, pr.nombre, l.fecha_vencimiento_estimada`)
      .all(...(pisoId ? [pisoId] : []));
    // Agrupado por piso, porque así se mira: primero cuánto hay en cada lugar y
    // después qué es.
    const pisos = [];
    const mapa = new Map();
    for (const r of rows) {
      if (!mapa.has(r.piso_id)) {
        const g = { piso_id: r.piso_id, piso_nombre: r.piso_nombre, piso_codigo: r.piso_codigo,
          bultos: 0, kg: 0, partidas: [] };
        mapa.set(r.piso_id, g); pisos.push(g);
      }
      const g = mapa.get(r.piso_id);
      g.bultos = r2(g.bultos + (r.bultos || 0));
      g.kg = r2(g.kg + (r.kg || 0));
      g.partidas.push(r);
    }
    // Los pisos vacíos también van: que un lugar esté vacío es información.
    const todos = db.prepare('SELECT * FROM sg_pisos WHERE activo=1 ORDER BY orden, id').all();
    for (const p of todos) {
      if (pisoId && p.id !== pisoId) continue;
      if (!mapa.has(p.id)) {
        pisos.push({ piso_id: p.id, piso_nombre: p.nombre, piso_codigo: p.codigo,
          bultos: 0, kg: 0, partidas: [] });
      }
    }
    pisos.sort((a, b) => (todos.findIndex((x) => x.id === a.piso_id))
                       - (todos.findIndex((x) => x.id === b.piso_id)));
    res.json({ ok: true, data: pisos,
      total: { bultos: r2(pisos.reduce((a, x) => a + x.bultos, 0)),
               kg: r2(pisos.reduce((a, x) => a + x.kg, 0)) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── EL PASE ENTRE PISOS ──────────────────────────────────────────────────
// Mover mercadería de lugar cambia dónde hay que ir a buscarla. Queda anotado
// con quién y cuándo: una edición silenciosa deja al depósito diciendo una cosa
// y la pantalla otra, sin que se sepa desde cuándo.
router.post('/lotes/:id/trasladar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const lote = db.prepare('SELECT * FROM sg_lotes WHERE id=? AND activo=1').get(req.params.id);
    if (!lote) return res.status(404).json({ ok: false, error: 'Partida no encontrada' });
    const origen = Number(b.piso_origen_id), destino = Number(b.piso_destino_id);
    if (!origen || !destino) return res.status(400).json({ ok: false, error: 'Elegí de qué piso a qué piso' });
    if (origen === destino) return res.status(400).json({ ok: false, error: 'El origen y el destino son el mismo piso' });
    const pd = db.prepare('SELECT * FROM sg_pisos WHERE id=? AND activo=1').get(destino);
    if (!pd) return res.status(400).json({ ok: false, error: 'El piso de destino no existe o está dado de baja' });
    // LOS DOS EXTREMOS. Si sólo se controlara el origen, se podría meter
    // mercadería en el piso de otro; si sólo el destino, sacarla del de otro.
    // Y sin el pase controlado, cerrar la recepción no sirve de nada: alcanza
    // con recibir en el piso propio y pasarlo al ajeno.
    for (const [pid, verbo] of [[origen, 'sacar de ahí'], [destino, 'meter mercadería']]) {
      const no = exigirPiso(db, req, pid, verbo);
      if (no) return res.status(403).json({ ok: false, error: no });
    }
    const u = db.prepare('SELECT * FROM sg_lote_ubicaciones WHERE lote_id=? AND piso_id=?').get(lote.id, origen);
    if (!u) return res.status(400).json({ ok: false, error: 'Esa partida no tiene mercadería en el piso de origen' });
    let bultos = (b.bultos != null && b.bultos !== '') ? Number(b.bultos) : (u.bultos || 0);
    if (!(bultos > 0)) return res.status(400).json({ ok: false, error: 'Poné cuántos bultos se pasan' });
    if (bultos - (u.bultos || 0) > 0.001) {
      return res.status(400).json({ ok: false,
        error: `Hay ${u.bultos} bulto(s) en ese piso y se quieren pasar ${bultos}.` });
    }
    // Los kilos se van con los bultos, en proporción. Si se pasa todo, se pasa
    // todo: así no queda un resto de decimales colgado en el piso de origen.
    const todo = Math.abs(bultos - (u.bultos || 0)) < 0.001;
    const kg = todo ? (u.kg || 0) : r2((u.kg || 0) * (bultos / (u.bultos || 1)));
    db.transaction(() => {
      ubicMover(db, lote.id, origen, -bultos, -kg);
      ubicMover(db, lote.id, destino, bultos, kg);
      db.prepare(`INSERT INTO sg_lote_traslados
        (lote_id, piso_origen_id, piso_destino_id, bultos, kg, motivo, usuario_id)
        VALUES (?,?,?,?,?,?,?)`).run(lote.id, origen, destino, bultos, kg,
          String(b.motivo || '').trim() || null, uid(req));
    })();
    res.json({ ok: true, data: { bultos, kg, ubicaciones: ubicacionesDeLote(db, lote.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Dónde está una partida y su historial de pases.
router.get('/lotes/:id/ubicaciones', requireAuth, (req, res) => {
  const db = getDb();
  try {
    res.json({ ok: true, data: {
      ubicaciones: ubicacionesDeLote(db, req.params.id),
      traslados: db.prepare(`SELECT t.*, po.nombre AS origen_nombre, pd.nombre AS destino_nombre,
          us.nombre AS usuario
        FROM sg_lote_traslados t
        LEFT JOIN sg_pisos po ON po.id = t.piso_origen_id
        LEFT JOIN sg_pisos pd ON pd.id = t.piso_destino_id
        LEFT JOIN usuarios us ON us.id = t.usuario_id
        WHERE t.lote_id=? ORDER BY t.id DESC`).all(req.params.id),
    } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── EL STOCK DE UN PISO, EN PAPEL ────────────────────────────────────────
// Se imprime todos los días y se camina con la hoja para contar contra ella.
router.get('/stock-pisos/imprimir', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const pisoId = req.query.piso_id ? Number(req.query.piso_id) : null;
    const rows = db.prepare(`SELECT p.nombre AS piso_nombre, l.codigo_lote, pr.nombre AS producto_nombre,
        l.calidad, u.bultos, u.kg, l.fecha_vencimiento_estimada
      FROM sg_lote_ubicaciones u
      JOIN sg_pisos p ON p.id = u.piso_id
      JOIN sg_lotes l ON l.id = u.lote_id AND l.activo = 1
      LEFT JOIN sg_productos pr ON pr.id = l.producto_id
      WHERE (u.bultos > 0.001 OR u.kg > 0.01) ${pisoId ? 'AND u.piso_id = ?' : ''}
      ORDER BY p.orden, p.id, pr.nombre, l.fecha_vencimiento_estimada`)
      .all(...(pisoId ? [pisoId] : []));
    const esc = (t) => String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const nr = (n) => Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 });
    const hoy = db.prepare("SELECT datetime('now','localtime') d").get().d;
    let u = null;
    try { u = JSON.parse(req.cookies?.lnb_user || 'null'); } catch { u = null; }
    let html = '', pisoAct = null, subB = 0, subK = 0;
    const cierre = () => (pisoAct == null ? '' :
      `<tr class="sub"><td colspan="3">Total ${esc(pisoAct)}</td>
        <td class="n">${nr(subB)}</td><td class="n">${nr(subK)}</td><td></td><td></td></tr>`);
    for (const r of rows) {
      if (r.piso_nombre !== pisoAct) {
        html += cierre();
        pisoAct = r.piso_nombre; subB = 0; subK = 0;
        html += `<tr class="pis"><td colspan="7">${esc(pisoAct)}</td></tr>`;
      }
      subB += Number(r.bultos) || 0; subK += Number(r.kg) || 0;
      html += `<tr><td class="mono">${esc(r.codigo_lote)}</td><td>${esc(r.producto_nombre || '')}</td>
        <td>${esc(r.calidad || '')}</td><td class="n">${nr(r.bultos)}</td><td class="n">${nr(r.kg)}</td>
        <td>${esc(r.fecha_vencimiento_estimada || '')}</td><td class="chk"></td></tr>`;
    }
    html += cierre();
    if (!rows.length) html = '<tr><td colspan="7" class="vacio">No hay mercadería ubicada.</td></tr>';
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Stock por piso</title><style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:22px;color:#111}
  h1{font-size:17px;margin:0 0 2px}
  .sub0{font-size:11.5px;color:#666;margin-bottom:14px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#666;
     border-bottom:1.5px solid #333;padding:0 6px 4px}
  td{padding:5px 6px;border-bottom:1px solid #ddd}
  .n{text-align:right;font-variant-numeric:tabular-nums}
  .mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px}
  tr.pis td{background:#f0f0f0;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.04em}
  tr.sub td{font-weight:700;border-top:1px solid #333;border-bottom:2px solid #333}
  /* Para contar contra la hoja: una casilla por renglón. */
  .chk{width:26px}
  td.chk::after{content:'';display:block;width:14px;height:14px;border:1px solid #999;border-radius:2px}
  .vacio{color:#666;text-align:center;padding:18px}
  .pie{margin-top:16px;font-size:10.5px;color:#666}
  button{position:fixed;top:14px;right:14px;padding:8px 14px;font-size:13px;cursor:pointer;
    border:1px solid #333;background:#fff;border-radius:6px}
  @media print{ button{display:none} body{padding:0} tr.pis td{background:#eee} }
</style></head><body>
<button onclick="window.print()">Imprimir</button>
<h1>Stock por piso</h1>
<div class="sub0">San Gerónimo · ${esc(hoy)}${u && u.nombre ? ' · ' + esc(u.nombre) : ''}</div>
<table><thead><tr>
  <th>Partida</th><th>Producto</th><th>Calidad</th>
  <th class="n">Bultos</th><th class="n">Kg</th><th>Vence</th><th class="chk"></th>
</tr></thead><tbody>${html}</tbody></table>
<div class="pie">Es una foto del momento: lo que entre o salga después de imprimir no está en esta hoja.</div>
</body></html>`);
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// ── EL ASIENTO CON EL QUE SE CONTABILIZA UNA LIQUIDACIÓN ─────────────
//
// Pablo: "arriba necesito el selector de asiento tal como existe en facturas de
// compra de mercadería".
//
// Mismo mecanismo, misma razón: todas las liquidaciones se contabilizan IGUAL,
// así que el modelo se elige UNA vez y queda parametrizado para el módulo. No
// se elige liquidación por liquidación — eso abriría la puerta a que dos
// iguales entren con asientos distintos según quién las cargó, y a los tres
// meses el mayor no cierra y nadie sabe por qué.
//
// Es OTRA clave que la de facturas: una liquidación la EMITIMOS nosotros y una
// factura de mercadería la recibimos. Compartir el modelo sería contabilizar
// dos operaciones distintas con las mismas cuentas.
const CLAVE_MODELO_LIQ = 'asiento_modelo_liquidacion';

// ── EL ASIENTO DE LA LIQUIDACIÓN, ANTES DE EMITIRLA ──────────────────
//
// Pablo: "abajo de todo, asiento resumen con lo de si empre balancea o no".
//
// Lo arma el MISMO servicio que lo va a escribir cuando se emita. La pantalla
// muestra, no calcula: si los dos calcularan, un día no van a coincidir y va a
// ganar el que nadie mira.
router.post('/liquidacion/preview-asiento', requireAuth, (req, res) => {
  const db = getDb();
  try {
    res.json(previewAsientoLiquidacion(db, req.body || {}));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/liquidacion/modelo', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const id = db.prepare('SELECT valor FROM sg_config WHERE clave=?').get(CLAVE_MODELO_LIQ);
    const modeloId = id && id.valor ? Number(id.valor) : null;
    if (!modeloId) return res.json({ ok: true, data: { modelo: null } });
    const m = db.prepare('SELECT * FROM sg_asientos_modelo WHERE id=? AND activo=1').get(modeloId);
    // El modelo elegido se dio de baja: hay que avisar, no devolver null como
    // si nunca se hubiera elegido uno.
    if (!m) return res.json({ ok: true, data: { modelo: null, id_perdido: modeloId } });

    m.lineas = db.prepare(`SELECT l.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre
      FROM sg_asientos_modelo_lineas l
      LEFT JOIN sg_cuentas c ON c.id = l.cuenta_id
      WHERE l.modelo_id=? ORDER BY l.orden, l.id`).all(modeloId);

    // Qué le falta para poder contabilizar. Se avisa acá y no cuando ya está la
    // liquidación cargada y el proveedor esperando.
    const faltan = [];
    if (!m.lineas.length) faltan.push('no tiene ninguna línea');
    if (!m.lineas.some((l) => l.tipo_linea === 'proveedores')) {
      faltan.push('no tiene la línea de Proveedores, que es lo que se le queda debiendo al productor');
    }
    if (!m.lineas.some((l) => l.lado === 'debe')) faltan.push('no tiene ninguna línea en el debe');
    if (!m.lineas.some((l) => l.lado === 'haber')) faltan.push('no tiene ninguna línea en el haber');
    const sinCuenta = m.lineas.filter((l) => !l.cuenta_codigo).length;
    if (sinCuenta) faltan.push(sinCuenta + ' línea(s) apuntan a una cuenta que ya no existe');

    res.json({ ok: true, data: { modelo: m, faltan } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Sólo admin: define cómo entra al libro la plata de TODAS las liquidaciones.
// Parametrizar no es operar (ver OPERAR NO ES SER ADMIN en CLAUDE.md).
router.put('/liquidacion/modelo', requireAdmin, (req, res) => {
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
      .run(CLAVE_MODELO_LIQ, modeloId == null ? null : String(modeloId), uid(req));
    res.json({ ok: true, data: { modelo_id: modeloId } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── CUÁNTO VENDIÓ ESTA PARTIDA ───────────────────────────────
//
// Pablo, 24/8/2026 — y es norma contable, no preferencia:
//
//   "la venta que debe traer la partida es la venta EXACTA en pesos que tuvo
//    esa partida. No hay que ni dividirla por kilos ni cuestiones raras: hay
//    que traer la venta tal como está en las partidas. Esta va a ser la norma
//    en PRECIO ABIERTO documento liquidación."
//
// La primera versión de esto prorrateaba el neto de cada factura entre las
// partidas que la componían. Estaba mal: un prorrateo es un reparto inventado
// sobre un total, y al productor se le liquida lo que SU mercadería vendió.
// Cuando el dato exacto existe —y existe, cada renglón del remito tiene su
// precio— repartir es elegir aproximar.
//
// De dónde sale ahora: sg_factura_despachos guarda, POR RENGLÓN, los pesos que
// fueron al comprobante. Se escriben al emitir, que es el único momento en que
// se sabe si el precio tipeado traía IVA adentro. Acá sólo se suman.
//
// Para los renglones anteriores a este cambio no hay pesos guardados: se caen a
// kg × precio del renglón, que sigue siendo SU precio y no el de otro — y se
// dice cuántos son, para que nadie firme una liquidación creyendo que todo el
// número salió del comprobante.
router.get('/partidas/:id/venta', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const ocId = Number(req.params.id);
    // ── EL PROVEEDOR SALE DE LA PARTIDA ───────────────────────────
    //
    // Pablo: "en la liquidación los datos del proveedor los debe traer automáticos
    // de la partida". Y no es comodidad: la liquidación la EMITIMOS nosotros a
    // nombre de ese productor, y tipear a mano el CUIT de un comprobante que uno
    // emite es la forma más barata de emitirlo mal.
    const oc = db.prepare(`SELECT o.id, o.trazabilidad, o.numero, o.fecha_oc,
        o.flete_a_cargo, o.flete_monto, o.flete_con_iva,
        p.id AS prov_id, p.razon_social, p.cuit, p.localidad, p.provincia,
        p.codigo_postal, p.categoria_fiscal, p.comision_pct
        FROM sg_oc o LEFT JOIN sg_proveedores p ON p.id = o.proveedor_id
       WHERE o.id = ?`).get(ocId);
    if (!oc) return res.status(404).json({ ok: false, error: 'Partida inexistente' });

    // ── LA UNIDAD LA MANDA LA ORDEN DE COMPRA ───────────────────────
    //
    // Pablo: "si la partida ingresó por bultos se liquidan BULTOS, no kilos... la
    // orden de compra manda". Al productor se le paga como se le compró:
    // liquidarle kilos una compra pactada por cajón es cambiarle la unidad del
    // trato en el papel donde cobra.
    //
    // Sale de sg_oc_items.modo_carga, que es donde ya vive esa decisión (la misma
    // que usa acordadoDeOC). Si los ítems no coinciden entre sí manda el bulto:
    // es la unidad más gruesa y la que el productor cuenta.
    const modos = db.prepare(`SELECT DISTINCT COALESCE(modo_carga,'kilo') AS m
      FROM sg_oc_items WHERE oc_id = ?`).all(ocId).map((x) => x.m);
    const unidad = modos.includes('bulto') ? 'bulto' : 'kilo';

    // Lo que entró y lo que salió, en bultos y en kg.
    const tot = db.prepare(`SELECT
        COALESCE(SUM(l.bultos),0) AS bultos, COALESCE(SUM(l.kg_reales),0) AS kg
        FROM sg_lotes l JOIN sg_oc_items i ON i.id = l.oc_item_id
       WHERE i.oc_id = ? AND l.activo = 1`).get(ocId);
    const sal = db.prepare(`SELECT
        COALESCE(SUM(di.bultos),0) AS bultos, COALESCE(SUM(di.kg_despachados),0) AS kg
        FROM sg_despacho_items di
        JOIN sg_despachos d ON d.id = di.despacho_id AND d.activo = 1
        JOIN sg_lotes l ON l.id = di.lote_id AND l.activo = 1
        JOIN sg_oc_items i ON i.id = l.oc_item_id
       WHERE i.oc_id = ?`).get(ocId);

    // ── LA MERMA, CON SU DETALLE ─────────────────────────────────
    //
    // Pablo: "en el caso que existan mermas se deben explicitar en la
    // liquidación". Y tiene que ser así: el productor va a cobrar por 55 de sus
    // 60 bultos, y la diferencia no es un error de cuenta — es mercadería que se
    // tiró, y él tiene derecho a saber cuánta y por qué.
    //
    // Van a precio 0: están terminadas, no vendidas.
    const mermas = db.prepare(`
      SELECT dc.id, dc.fecha, COALESCE(dc.bultos,0) AS bultos, COALESCE(dc.kg,0) AS kg,
        dc.motivo, l.codigo_lote, pr.nombre AS producto
        FROM sg_lote_decomisos dc
        JOIN sg_lotes l ON l.id = dc.lote_id AND l.activo = 1
        JOIN sg_oc_items i ON i.id = l.oc_item_id
        LEFT JOIN sg_productos pr ON pr.id = l.producto_id
       WHERE i.oc_id = ? ORDER BY dc.fecha, dc.id`).all(ocId);
    const mermaBultos = r2(mermas.reduce((a, m) => a + (Number(m.bultos) || 0), 0));
    const mermaKg = r2(mermas.reduce((a, m) => a + (Number(m.kg) || 0), 0));

    // LOS RENGLONES DE ESTA PARTIDA. Uno por línea facturada, con sus pesos.
    //
    // `renglones_factura` es cuántos renglones tiene la factura ENTERA, no sólo los
    // de esta partida. Es lo que decide si los números de la factura son de esta
    // partida o hay que repartirlos — y repartir no se hace.
    const lineas = db.prepare(`
      SELECT fd.id, fd.kg, fd.neto, fd.iva, fd.gestion,
        di.precio_por_kg, di.precio_lista_por_kg,
        f.id AS factura_id, f.fecha, f.numero, f.punto_venta, f.cbte_nro,
        COALESCE(f.neto,0) AS f_neto, COALESCE(f.iva,0) AS f_iva,
        COALESCE(f.dif_gestion,0) AS f_gestion,
        (SELECT COUNT(*) FROM sg_factura_despachos fd2 WHERE fd2.factura_id = f.id) AS renglones_factura,
        pr.nombre AS producto
        FROM sg_factura_despachos fd
        JOIN sg_ven_facturas f ON f.id = fd.factura_id
        JOIN sg_despacho_items di ON di.id = fd.despacho_item_id
        JOIN sg_lotes l ON l.id = di.lote_id AND l.activo = 1
        JOIN sg_oc_items i ON i.id = l.oc_item_id
        LEFT JOIN sg_productos pr ON pr.id = di.producto_id
       WHERE i.oc_id = ? AND ${facturaCuenta('f')}
       ORDER BY f.fecha, f.id, fd.id`).all(ocId);

    let neto = 0, iva = 0, gestion = 0, estimadas = 0, sinAtribuir = 0;
    const detalle = [];
    for (const x of lineas) {
      // ── EL RENGLÓN VIEJO ───────────────────────────────────
      //
      // Los emitidos antes de que se guardaran los pesos por renglón no los
      // tienen. Pero si la factura tiene UN SOLO renglón, sus números son de esta
      // partida y de ninguna otra: tomarlos enteros es EXACTO, no un reparto.
      //
      // Acá se perdía la parte de gestión: la factura la tenía en dif_gestion y
      // esta cuenta miraba sólo el renglón, así que salía 0 y la liquidación
      // pagaba de menos sin decirlo. El IVA, igual.
      const exacto = x.neto != null;
      const solo = Number(x.renglones_factura) === 1;
      let n, v, g, comoSale;
      if (exacto) {
        n = r2(x.neto); v = r2(x.iva); g = r2(x.gestion); comoSale = 'renglon';
      } else if (solo) {
        n = r2(x.f_neto); v = r2(x.f_iva); g = r2(x.f_gestion); comoSale = 'factura';
      } else {
        // Factura vieja Y compartida con otra partida: no hay forma exacta de
        // separarla. Se dice —no se reparte y no se calla—: el neto sale del
        // precio del renglón, y el IVA y la gestión quedan SIN ATRIBUIR.
        n = r2(Number(x.kg) * (Number(x.precio_por_kg) || 0));
        v = 0; g = 0; comoSale = 'estimado';
        sinAtribuir += r2(x.f_gestion) > 0 ? 1 : 0;
      }
      if (!exacto) estimadas++;
      neto += n; iva += v; gestion += g;
      detalle.push({ factura_id: x.factura_id, fecha: x.fecha,
        numero: (x.punto_venta != null && x.cbte_nro != null)
          ? String(x.punto_venta).padStart(4, '0') + '-' + String(x.cbte_nro).padStart(8, '0')
          : x.numero,
        producto: x.producto, kg: r2(x.kg), neto: n, iva: v, gestion: g,
        exacto: exacto ? 1 : 0, como_sale: comoSale });
    }

    // LO QUE SALIÓ Y TODAVÍA NO SE FACTURÓ. No entra en las tres filas —esas son
    // el comprobante— pero hay que decirlo: liquidar sin contarlo es liquidar de
    // menos, y el productor se entera después.
    const sinFac = db.prepare(`
      SELECT COALESCE(SUM((di.kg_despachados
          - COALESCE((SELECT SUM(fd.kg) FROM sg_factura_despachos fd
              JOIN sg_ven_facturas fv ON fv.id = fd.factura_id
             WHERE fd.despacho_item_id = di.id AND ${facturaCuenta('fv')}),0))
        * COALESCE(di.precio_por_kg,0)),0) AS monto
        FROM sg_despacho_items di
        JOIN sg_despachos d ON d.id = di.despacho_id AND d.activo = 1
        JOIN sg_lotes l ON l.id = di.lote_id AND l.activo = 1
        JOIN sg_oc_items i ON i.id = l.oc_item_id
       WHERE i.oc_id = ?`).get(ocId);

    // ── LOS ARTÍCULOS DE LA PARTIDA ─────────────────────────────
    //
    // Pablo: "los artículos y las mermas vienen en la partida".
    //
    // Es lo que se le liquida: qué producto salió, cuánto y a cuánto. Agrupado por
    // producto —no un renglón por despacho— porque la liquidación es un
    // comprobante, no un extracto: al productor se le dice "tu durazno rindió
    // tanto", no las once salidas que hubo.
    //
    // El precio de cada renglón es el promedio PONDERADO por kilos, que es el
    // único que multiplicado por la cantidad da el importe real. El simple daría
    // otro número y el comprobante no cerraría.
    const arts = db.prepare(`
      SELECT COALESCE(pr.nombre, 'Sin producto') AS articulo,
        COALESCE(SUM(di.kg_despachados),0) AS kg,
        COALESCE(SUM(di.bultos),0) AS bultos,
        COALESCE(SUM(di.kg_despachados * COALESCE(di.precio_por_kg,0)),0) AS importe
        FROM sg_despacho_items di
        JOIN sg_despachos d ON d.id = di.despacho_id AND d.activo = 1
        JOIN sg_lotes l ON l.id = di.lote_id AND l.activo = 1
        JOIN sg_oc_items i ON i.id = l.oc_item_id
        LEFT JOIN sg_productos pr ON pr.id = di.producto_id
       WHERE i.oc_id = ? GROUP BY pr.nombre ORDER BY pr.nombre`).all(ocId);
    // La CANTIDAD del renglón va en la unidad de la orden, y el precio se
    // recalcula contra esa cantidad para que precio × cantidad siga dando el
    // importe. Cambiar la unidad y dejar el precio por kilo daría un renglón que
    // no cierra consigo mismo.
    const articulos = arts.map((a) => {
      const cant = unidad === 'bulto' ? r2(a.bultos) : r2(a.kg);
      return {
        articulo: a.articulo, unidad,
        cantidad: cant, bultos: r2(a.bultos), kg: r2(a.kg),
        precio: cant > 0 ? Math.round((a.importe / cant) * 10000) / 10000 : 0,
        importe: r2(a.importe),
      };
    });

    // ── LO QUE SE LE DESCUENTA, TRAÍDO DE DONDE YA VIVE ────────────────
    //
    // Pablo: "la descarga debe venir de la recepción de mercadería que se hizo, si
    // tuvo descarga, tenemos que traerla automática de la recepción... lo mismo
    // que el flete: si el flete está a cargo del comprador, debemos traer el flete
    // que se cargó en la orden de compra con su IVA correspondiente".
    //
    // Tipearlo a mano cuando el dato ya está cargado es pedirle al operador que
    // copie un número de otra pantalla — y ahí es donde se equivoca.

    // LA DESCARGA sale de sg_gastos_directos de las recepciones de esta partida.
    // Sólo la VALORIZADA: una pendiente de valorizar no tiene monto todavía, y
    // ponerla en cero sería cobrarle cero por algo que se hizo.
    const desc = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN g.estado='valorizado' THEN g.monto ELSE 0 END),0) AS monto,
        SUM(CASE WHEN g.estado='pendiente_valorizar' THEN 1 ELSE 0 END) AS sin_valorizar,
        COUNT(*) AS n
        FROM sg_gastos_directos g
        JOIN sg_recepciones r ON r.id = g.recepcion_id AND r.activo = 1
       WHERE r.oc_id = ? AND g.tipo_gasto = 'descarga_ingreso' AND g.activo = 1`).get(ocId);

    // EL FLETE sale de la orden. Se trae sólo si está a cargo del COMPRADOR, que
    // es lo que pidió Pablo; si está a cargo del vendedor igual se informa con su
    // rótulo, para que el que liquida vea que existe y decida.
    //
    // flete_con_iva dice si el monto YA lo trae adentro: sin esa distinción se le
    // cobraría el IVA dos veces o ninguna.
    const IVA_SERVICIOS = 21;
    const fMonto = r2(oc.flete_monto);
    const fConIva = oc.flete_con_iva ? 1 : 0;
    const fNeto = fConIva ? r2(fMonto / (1 + IVA_SERVICIOS / 100)) : fMonto;
    const flete = {
      a_cargo: oc.flete_a_cargo || null,
      monto: fMonto,
      con_iva: fConIva,
      neto: fNeto,
      iva: r2(fConIva ? (fMonto - fNeto) : (fMonto * IVA_SERVICIOS / 100)),
      // Se prellena sólo cuando corresponde; el resto es información.
      se_cobra: oc.flete_a_cargo === 'comprador' && fMonto > 0 ? 1 : 0,
    };

    const bultosIn = r2(tot && tot.bultos);
    const bultosOut = r2(sal && sal.bultos);
    // TERMINADO = lo que ya no está en el depósito: vendido + merma. Es lo que
    // decide si la partida se puede liquidar, porque lo que queda adentro
    // todavía no se sabe cuánto va a rendir.
    const terminado = r2(bultosOut + mermaBultos);
    res.json({ ok: true,
      partida: oc.trazabilidad || oc.numero,
      // En qué unidad se liquida. La pantalla la usa para rotular la columna y
      // para no ofrecer kilos donde se pactaron cajones.
      unidad,
      // Lo que se le descuenta al productor, traído de donde ya vive.
      //
      // La comisión es un PORCENTAJE, no un monto: sale de la ficha del proveedor
      // si la tiene cargada, y si no del 12% que Pablo puso como norma. Es
      // editable en la pantalla — hay proveedores con comisiones distintas.
      comision_pct: (oc.comision_pct != null && oc.comision_pct !== '')
        ? Number(oc.comision_pct) : 12,
      comision_pct_de_proveedor: (oc.comision_pct != null && oc.comision_pct !== '') ? 1 : 0,
      iva_servicios_pct: IVA_SERVICIOS,
      descarga: { monto: r2(desc && desc.monto), n: (desc && desc.n) || 0,
                  sin_valorizar: (desc && desc.sin_valorizar) || 0,
                  iva: r2((desc && desc.monto) * IVA_SERVICIOS / 100) },
      flete,
      // Lo que la pantalla necesita para armar el comprobante sin tipear nada.
      proveedor: {
        id: oc.prov_id, razon_social: oc.razon_social, cuit: oc.cuit,
        localidad: oc.localidad, provincia: oc.provincia,
        cp: oc.codigo_postal, iva: oc.categoria_fiscal,
      },
      articulos,
      bultos_ingresados: bultosIn, bultos_vendidos: bultosOut,
      bultos_merma: mermaBultos, kg_merma: mermaKg, mermas,
      bultos_terminados: terminado,
      bultos_en_deposito: r2(Math.max(0, bultosIn - terminado)),
      kg_ingresados: r2(tot && tot.kg), kg_vendidos: r2(sal && sal.kg),
      avance: bultosIn > 0 ? Math.round((terminado / bultosIn) * 1000) / 10 : 0,
      neto: r2(neto), gestion: r2(gestion), iva: r2(iva),
      sin_facturar: r2(sinFac && sinFac.monto),
      lineas_estimadas: estimadas, lineas_sin_atribuir: sinAtribuir,
      lineas: detalle });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/partidas-a-liquidar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    // La tabla de liquidaciones la crea el módulo de Abasto al arrancar. Si por
    // orden de carga todavía no existe, la bandeja muestra todo antes que
    // romperse: es preferible una partida de más a una pantalla en error.
    const conLiq = partidasConLiquidacion(db);
    // liquidada_en: la marca de "esto ya está", sea porque se le cargó la
    // liquidación desde acá o porque un admin la dio por liquidada a mano.
    const rows = partidasRecibidas(db, 'liquidacion')
      .filter((r) => !r.liquidada_en && !conLiq.has(Number(r.id)));
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
// La consulta se compila UNA vez por base y se reusa: el listado de órdenes la
// llama una vez por fila, y compilar la misma sentencia doscientas veces para
// pintar una pantalla es trabajo que no hace falta.
const _stmtAcordado = new WeakMap();
function acordadoDeOC(db, ocId) {
  if (!_stmtAcordado.has(db)) _stmtAcordado.set(db, db.prepare(`SELECT i.id, i.precio_estimado_por_kg,
      -- LA UNIDAD EN QUE SE PACTÓ. Es lo que el comprador eligió al cargar la
      -- orden, y es lo que manda cuando hay diferencias: si compró bultos, la
      -- orden se rehace por bultos; si compró kilos, por kilos.
      i.modo_carga,
      COALESCE(i.kg_por_bulto, ps.factor_conversion) AS kg_por_bulto,
      (SELECT COALESCE(SUM(kg_reales),0) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS kg_recibidos,
      (SELECT COALESCE(SUM(bultos),0)    FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS bultos_recibidos,
      -- LOS KILOS DE LOS BULTOS QUE SÍ SE CONTARON, aparte. Es lo que separa un
      -- ítem que entró todo contado de uno que entró mitad y mitad.
      (SELECT COALESCE(SUM(kg_reales),0) FROM sg_lotes
        WHERE oc_item_id=i.id AND activo=1 AND bultos IS NOT NULL AND bultos > 0) AS kg_con_bultos
    FROM sg_oc_items i
    LEFT JOIN sg_presentaciones ps ON ps.id=i.presentacion_id
    WHERE i.oc_id=?`));
  const its = _stmtAcordado.get(db).all(ocId);
  let total = 0;
  const detalle = [];
  for (const it of its) {
    const pk = it.precio_estimado_por_kg != null ? Number(it.precio_estimado_por_kg) : null;
    const kpb = Number(it.kg_por_bulto) || 0;
    const bultos = Number(it.bultos_recibidos) || 0;
    const precioBulto = (pk != null && kpb > 0) ? r2(pk * kpb) : null;
    let importe = null, base = null;
    if (pk != null) {
      // ── CADA LOTE SE PAGA CON LA BASE QUE LE CORRESPONDE ────────────────
      // Antes la base se elegía UNA vez por ítem: si había aunque fuera un
      // bulto contado, se cobraba TODO por bulto y los lotes que entraron
      // pesados —sin contar cajones— no se pagaban. Un camión que descarga 60
      // cajones y después 800 kg a granel del mismo producto se liquidaba por
      // los 60 cajones y los 800 kg desaparecían de la cuenta.
      //
      // Ahora los cajones se pagan por cajón y el resto por kilo, que es
      // exactamente como se pactó cada parte.
      const kgSueltos = Math.max(0, r2(Number(it.kg_recibidos) - Number(it.kg_con_bultos)));
      // Y LA BASE SALE DE LO QUE PACTÓ EL COMPRADOR, no de si alguien contó
      // bultos. Antes: "si hay aunque sea un bulto contado, se cobra por bulto".
      // Eso decidía por él. Un ítem comprado POR KILO se paga por kilo aunque haya
      // entrado en cajones --el cajonó es cómo vino, no cómo se compró--.
      //
      // Si el ítem es viejo y no tiene modo_carga, se cae al comportamiento de
      // antes: no hay dato de qué eligió, y suponer "kilo" cambiaría la cuenta de
      // órdenes ya cerradas.
      const porBulto = (it.modo_carga === 'bulto')
        || (it.modo_carga == null && bultos > 0);
      if (porBulto && bultos > 0 && precioBulto != null) {
        importe = r2(bultos * precioBulto + kgSueltos * pk);
        base = kgSueltos > 0 ? 'mixto' : 'bulto';
      } else {
        importe = r2(it.kg_recibidos * pk);
        base = 'kilo';
      }
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
    // ── ¿EL PRECIO PACTADO INCLUÍA EL IVA? ───────────────────────────────
    // La pantalla compara el neto de la factura contra lo acordado. Si el precio
    // se pactó CON IVA, ese total es bruto y la comparación enfrenta dos cosas
    // distintas: avisaba "no da contra lo acordado, diferencia $143.000" sobre
    // una factura perfecta, que es exactamente el 10,5% de IVA.
    const alicOC = (oc.iva_alicuota_oc != null && oc.iva_alicuota_oc !== '')
      ? Number(oc.iva_alicuota_oc)
      : (db.prepare(`SELECT f.iva_alicuota a FROM sg_oc_items i
           LEFT JOIN sg_productos p ON p.id = i.producto_id
           LEFT JOIN sg_familias f ON f.id = p.familia_id
          WHERE i.oc_id = ? AND f.iva_alicuota IS NOT NULL LIMIT 1`).get(oc.id) || {}).a;
    res.json({ ok: true, data: { oc, items,
      total_acordado: oc.tipo_precio === 'pizarra' ? null : total,
      acordado_incluye_iva: oc.precio_incluye_iva == null ? null : (oc.precio_incluye_iva ? 1 : 0),
      acordado_alicuota: alicOC != null ? Number(alicOC) : null } });
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
         -- Sólo las que se documentan con FACTURA. Antes decía tipo_precio='firme',
         -- que no es lo mismo: una compra a precio cerrado que se documenta con
         -- liquidación entraba en la lista y se podía meter en una factura de
         -- la que no forma parte.
         AND COALESCE(o.documenta, CASE
               WHEN o.tipo_precio = 'pizarra' THEN 'liquidacion'
               WHEN o.tipo_fiscal = 'liquidacion' THEN 'liquidacion'
               ELSE 'factura' END) = 'factura'
         AND o.estado IN ('recibida_total','cerrada')
         -- Sin factura todavía: una partida no puede estar en dos facturas.
         -- Se mira la factura de compra, no el número anotado en el remito.
         AND NOT EXISTS (SELECT 1 FROM sg_facturas_compra f
                          WHERE f.activo=1
                            AND (f.oc_id = o.id
                                 OR EXISTS (SELECT 1 FROM sg_factura_compra_ocs fo
                                             WHERE fo.factura_id = f.id AND fo.oc_id = o.id)))
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
    // Sin proveedor la factura no entra en ninguna cuenta corriente, y eso no se
    // descubre hasta que alguien busca por qué no le cierra el saldo.
    if (!oc.proveedor_id) {
      return res.status(400).json({ ok: false,
        error: 'La partida no tiene proveedor: sin eso la factura no puede ir a la cuenta corriente.' });
    }
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
    // Y TIENEN QUE SER DEL CIRCUITO DE FACTURA. Una partida que se documenta con
    // liquidación no se factura: la pantalla ya no la ofrece, pero el que decide
    // acá es el backend. Sin esto, cambiar una partida de circuito con la ventana
    // abierta la dejaba entrar igual.
    {
      const ph = ocIds.map(() => '?').join(',');
      const ajena = db.prepare(`SELECT trazabilidad, id FROM sg_oc
        WHERE id IN (${ph}) AND COALESCE(documenta, CASE
              WHEN tipo_precio = 'pizarra' THEN 'liquidacion'
              WHEN tipo_fiscal = 'liquidacion' THEN 'liquidacion'
              ELSE 'factura' END) <> 'factura'`).get(...ocIds);
      if (ajena) {
        return res.status(400).json({ ok: false,
          error: 'La partida ' + (ajena.trazabilidad || ajena.id) + ' se documenta con liquidación, '
               + 'no con factura de compra. Si es un error, cambiale el circuito desde la ficha.' });
      }
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
    //
    // Y SE COMPARA CONTRA EL LADO QUE CORRESPONDE. Si el precio de la orden YA
    // INCLUYE IVA, lo acordado viene con IVA adentro: contra el neto nunca iba a
    // dar, y el aviso saltaba en facturas perfectas por exactamente el 21% o el
    // 10,5%. Ahí se compara contra el TOTAL, que es lo que pidió Pablo.
    let avisoAcordado = null;
    const acordadoPorOc = {};
    for (const id of ocIds) acordadoPorOc[id] = acordadoDeOC(db, id).total;
    const acordado = r2(Object.values(acordadoPorOc).reduce((a, x) => a + x, 0));
    // Con varias partidas puede haber de las dos: ahí no hay un lado único contra
    // el que comparar, se usa el neto y el aviso lo dice.
    const conIva = db.prepare(`SELECT COUNT(*) n,
        SUM(CASE WHEN COALESCE(precio_incluye_iva,0) = 1 THEN 1 ELSE 0 END) c
      FROM sg_oc WHERE id IN (${ocIds.map(() => '?').join(',')})`).get(...ocIds);
    const todasConIva = conIva.n > 0 && conIva.c === conIva.n;
    const mezcla = conIva.c > 0 && conIva.c < conIva.n;
    const ladoFac = todasConIva ? r2(total != null ? total : suma) : r2(neto);
    const comoFac = todasConIva ? 'total' : 'neto';
    if (acordado > 0 && Math.abs(r2(ladoFac - acordado)) > 0.01) {
      // LA LEYENDA NOMBRA LOS DOS LADOS Y DICE SI LLEVAN IVA. Antes decía "no da
      // contra lo acordado" sin aclarar contra qué estaba comparando, y el que la
      // leía no tenía cómo saber si el error era suyo o de la cuenta.
      const conSin = todasConIva ? 'con IVA' : 'sin IVA';
      avisoAcordado = 'El ' + comoFac + ' de la factura (' + ladoFac + ', ' + conSin + ') no da contra '
        + 'lo acordado en la orden por lo que entró (' + acordado + ', ' + conSin + ')'
        + (ocIds.length > 1 ? ', sumando las ' + ocIds.length + ' partidas' : '')
        + '. Diferencia: ' + r2(ladoFac - acordado) + '.'
        + (mezcla ? ' Ojo: hay partidas con el precio con IVA y otras sin IVA, así que se compara '
                  + 'contra el neto y la diferencia puede ser sólo el IVA de las primeras.' : '');
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

    // ── LO QUE SE ACORDÓ Y LO QUE VINO ──────────────────────────────────
    // Si el comprador cerró en 20.000 y la factura llegó por 10.000, la
    // diferencia se anota acá con su motivo. No toca el total —eso es lo que
    // dice el comprobante— pero sí lo que se le debe al proveedor.
    const difG = r2(b.dif_gestion);
    const difM = val(b.dif_motivo);
    // LA FACTURA TAMBIÉN PUEDE VENIR POR MÁS. Acá se rechazaba: "eso se arregla
    // con el proveedor". Pero el caso existe y no se podía registrar, así que el
    // que lo tenía adelante no tenía dónde ponerlo y la deuda quedaba corta.
    //
    // Decisión de Pablo (21/8/2026): se acepta, se corrige la orden hacia arriba
    // y la diferencia de gestión puede ser NEGATIVA. El total sigue sin tocarse:
    // es lo que dice el papel y es lo que va al libro fiscal.
    //
    // Lo que cambia es la DEUDA, que es total + dif_gestion. Con dif negativa
    // da menos que el comprobante, que es justamente lo acordado: se le debe
    // lo que se cerró, no lo que facturó de más. Y queda escrito con su motivo.
    if (difG !== 0 && !MOTIVOS[difM]) {
      return res.status(400).json({ ok: false,
        error: 'Poné por qué la factura no coincide con lo acordado. Elegí el motivo: '
             + Object.values(MOTIVOS).map((m) => m.label).join(', ') + '.' });
    }

    const campos = [oc.id, oc.proveedor_id || null, val(b.tipo_comprobante), val(b.punto_venta),
      val(b.numero), val(b.fecha_emision), val(b.cuit_emisor), neto, numF(b.iva_alicuota), iva,
      pIva, pIibb, pGan, otros, val(b.iibb_jurisdiccion), total != null ? total : suma, val(b.cae), val(b.cae_vencimiento),
      ruta, nombre, b.leido_por_ia ? 1 : 0, val(b.observaciones), difG, difG > 0 ? difM : null, uid(req)];

    let id;
    db.transaction(() => {
      if (prev) {
        db.prepare(`UPDATE sg_facturas_compra SET proveedor_id=?, tipo_comprobante=?, punto_venta=?,
          numero=?, fecha_emision=?, cuit_emisor=?, neto=?, iva_alicuota=?, iva_monto=?,
          percepcion_iva=?, percepcion_iibb=?, percepcion_ganancias=?, otros_conceptos=?, iibb_jurisdiccion=?, total=?,
          cae=?, cae_vencimiento=?, archivo_ruta=?, archivo_nombre=?, leido_por_ia=?, observaciones=?,
          dif_gestion=?, dif_motivo=?,
          modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
          .run(...campos.slice(1), prev.id);
        id = prev.id;
      } else {
        id = db.prepare(`INSERT INTO sg_facturas_compra
          (oc_id, proveedor_id, tipo_comprobante, punto_venta, numero, fecha_emision, cuit_emisor,
           neto, iva_alicuota, iva_monto, percepcion_iva, percepcion_iibb, percepcion_ganancias,
           otros_conceptos, iibb_jurisdiccion, total, cae, cae_vencimiento, archivo_ruta, archivo_nombre,
           leido_por_ia, observaciones, dif_gestion, dif_motivo, creado_por)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...campos).lastInsertRowid;
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
      // ── Y LA DEUDA CON EL PROVEEDOR ────────────────────────────────────
      // La cuenta corriente sale de los vencimientos de la orden, y hasta acá
      // se calculaban sobre el costo de la mercadería. Con la factura cargada,
      // la deuda es la que dice el comprobante: se rehacen. Sin esto, cargar
      // una factura de un millón y medio no movía un peso en la cuenta del
      // proveedor.
      for (const ocId of ocIds) generarVencimientos(db, Number(ocId));

      // ── REGLA DE ORO: NO HAY FACTURA SIN SU ASIENTO ───────────────────
      // Antes esto eran DOS pasos: se guardaba la factura y después alguien
      // apretaba "Contabilizar". El segundo paso podía no correr nunca, y
      // quedaba una factura viva fuera del libro: una deuda que existe para el
      // proveedor y no existe para la contabilidad.
      //
      // Eso no se descubre solo. El mayor cierra —le falta un asiento que nunca
      // estuvo— y la diferencia aparece cuando alguien concilia contra el
      // proveedor, meses después.
      //
      // Ahora va TODO EN LA MISMA TRANSACCIÓN. Si el asiento no se puede
      // escribir, no se guarda la factura tampoco: es preferible que la carga
      // se corte y diga qué falta, a que entre a medias.
      const conCuenta = asiento.lineas.filter((l) => l.monto > 0);
      if (conCuenta.some((l) => !l.cuenta_id)) {
        throw new Error('Hay líneas del asiento con importe y sin cuenta. '
          + 'Revisá el asiento modelo antes de cargar la factura: no se guarda nada.');
      }
      const partidasTraza = db.prepare(`SELECT o.trazabilidad FROM sg_factura_compra_ocs fo
        JOIN sg_oc o ON o.id=fo.oc_id WHERE fo.factura_id=?`).all(id).map((x) => x.trazabilidad);
      const nroFacAs = (val(b.punto_venta) ? val(b.punto_venta) + '-' : '') + (val(b.numero) || '');
      const facParaGestion = db.prepare('SELECT * FROM sg_facturas_compra WHERE id=?').get(id);
      // EL NOMBRE DEL PROVEEDOR EN LA DESCRIPCIÓN. El listado de Asientos
      // Contables muestra número de factura y partida, que son códigos: para
      // saber de quién era el asiento había que abrirlo uno por uno.
      const provNom = (db.prepare(`SELECT p.razon_social r FROM sg_proveedores p
        JOIN sg_oc o ON o.proveedor_id = p.id WHERE o.id = ?`).get(oc.id) || {}).r;
      const asientoId = crearAsiento(db, {
        fecha: val(b.fecha_emision), usuario_id: uid(req),
        descripcion: 'Compra de mercadería' + (provNom ? ' — ' + provNom : '')
          + ' — Factura ' + nroFacAs
          + (partidasTraza.length
              ? ' — Partida' + (partidasTraza.length > 1 ? 's ' : ' ') + partidasTraza.join(', ') : ''),
        ref_compra_id: id, ref_codigo: nroFacAs,
      }, conCuenta.map((l) => ({
        cuenta_id: l.cuenta_id,
        debe: l.lado === 'debe' ? l.monto : 0,
        haber: l.lado === 'haber' ? l.monto : 0,
        descripcion: l.descripcion || null,
      })).concat(lineasGestionFactura(asiento.lineas, facParaGestion))).id;
      db.prepare(`UPDATE sg_facturas_compra SET asiento_id=?, confirmada_en=datetime('now','localtime'),
        confirmada_por=?, modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
        .run(asientoId, uid(req), uid(req), id);
      asiento.id = asientoId;
    })();
    res.json({ ok: true, data: { id: Number(id), archivo_ruta: ruta,
      asiento, asiento_id: asiento.id, aviso_acordado: avisoAcordado } });
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
  const l = db.prepare(`SELECT l.id, l.kg_reales, l.bultos, l.kg_por_bulto, l.presentacion_id,
      l.transformado_de, l.reproceso_id, i.oc_id
    FROM sg_lotes l LEFT JOIN sg_oc_items i ON i.id = l.oc_item_id
    WHERE l.id=? AND l.activo=1`).get(loteId);
  if (!l) return { error: 'Lote no encontrado' };

  if (l.oc_id) {
    // La factura puede cubrir VARIAS partidas: si sólo se mira f.oc_id, las que
    // entraron como secundarias —las que viven en sg_factura_compra_ocs— quedan
    // editables aunque su asiento ya esté en el libro.
    const fac = db.prepare(`SELECT f.id, f.asiento_id, a.anulado FROM sg_facturas_compra f
      LEFT JOIN sg_asientos a ON a.id = f.asiento_id
      WHERE f.activo=1 AND f.asiento_id IS NOT NULL
        AND (f.oc_id = ? OR EXISTS (SELECT 1 FROM sg_factura_compra_ocs fo
                                     WHERE fo.factura_id = f.id AND fo.oc_id = ?))`).get(l.oc_id, l.oc_id);
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

  // ── EL LOTE CUYO COSTO YA VIAJÓ A OTRO ───────────────────────────────
  // transformado_de y reproceso_id los lleva el lote HIJO —se escriben con el
  // id del origen al crearlo—, así que preguntar por ellos bloqueaba al hijo y
  // dejaba libre al PADRE, que es justo el que hay que proteger: su costo se
  // repartió a otro lote con un snapshot congelado (costo_transferido,
  // costo_madre_consumido) que no se recalcula nunca. Bajarle los kilos deja la
  // plata mal contada de los dos lados a la vez.
  const dioCosto = db.prepare(`SELECT
      (SELECT COUNT(*) FROM sg_transformaciones WHERE lote_origen_id=?) +
      (SELECT COUNT(*) FROM sg_reprocesos WHERE lote_madre_id=? AND estado='activo') AS c`)
    .get(loteId, loteId).c;
  if (dioCosto > 0) {
    return { error: 'De este lote salió mercadería a una transformación o un reproceso: parte de su '
      + 'costo ya viajó a otro lote. Corregirlo dejaría la plata contada mal en los dos lados.' };
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

// ── ELIMINAR UNA PARTIDA QUE SE CARGÓ DE MÁS ─────────────────────────────
// Pasa: se carga la recepción, la pantalla no confirma, se vuelve a cargar, y la
// misma partida de tomate queda cinco veces. Hasta ahora no había forma de
// sacarla: quedaba en el stock, en el costo del período y en lo que se le debe
// al proveedor, y la alerta de la orden decía que habían entrado 236 bultos de
// los 66 que se pidieron.
//
// NO SE BORRA LA FILA: se da de baja (activo=0). Todo el stock del módulo se
// calcula sobre los lotes activos, así que darla de baja la saca del stock, del
// costo y de la deuda — que es exactamente lo que tiene que pasar—, y el
// registro de que existió queda.
//
// Los frenos son los MISMOS que para corregirla: si de ese lote ya salió
// mercadería, o su costo viajó a otro lote, o ya está contabilizado, borrarlo
// dejaría la plata mal contada en otro lado.
// ELIMINAR UNA PARTIDA ES ANULAR, y anular es un NIVEL, no un rol (CLAUDE.md).
// Con requireAdmin, el encargado de depósito que se dio cuenta de que cargó la
// recepción dos veces tenía que ir a buscar al dueño. exigirNivel reconoce el
// DELETE y pide nivel "anular" en el módulo: quien lo tenga, lo hace.
router.delete('/lotes/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const motivo = val(req.body && req.body.motivo);
    if (!motivo) return res.status(400).json({ ok: false, error: 'Escribí por qué se elimina: queda registrado' });
    const chk = frenosDeEdicionLote(db, req.params.id);
    if (chk.error) return res.status(400).json({ ok: false, error: chk.error });

    const l = db.prepare('SELECT * FROM sg_lotes WHERE id=?').get(req.params.id);
    // Una reserva contra este lote es mercadería comprometida con un cliente: si
    // el lote no existía, esa reserva tampoco puede seguir en pie.
    const reservas = db.prepare(`SELECT rs.id, pe.numero FROM sg_reservas rs
      JOIN sg_pedido_items pi ON pi.id = rs.pedido_item_id
      JOIN sg_pedidos pe ON pe.id = pi.pedido_id
      WHERE rs.lote_id = ? AND rs.estado = 'activa'`).all(l.id);

    db.transaction(() => {
      anotarEdicion(db, { tabla: 'sg_lotes', registroId: l.id, campo: 'eliminada',
        antes: r2(l.kg_reales) + ' kg' + (l.bultos ? ' / ' + l.bultos + ' bultos' : ''),
        despues: 'eliminada', motivo, ocId: chk.lote.oc_id, userId: uid(req) });
      db.prepare(`UPDATE sg_lotes SET activo=0,
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`).run(uid(req), l.id);
      if (reservas.length) {
        db.prepare(`UPDATE sg_reservas SET estado='cancelada' WHERE lote_id=? AND estado='activa'`).run(l.id);
      }
      // Y todo lo que colgaba de esos kilos: el período y lo que se le debe al
      // proveedor. El stock no hace falta tocarlo — sale de los lotes activos.
      if (l.fecha_ingreso) recalcPeriodo(db, String(l.fecha_ingreso).slice(0, 7));
      if (chk.lote.oc_id) {
        generarVencimientos(db, chk.lote.oc_id);
        actualizarEstadoOC(db, chk.lote.oc_id);
      }
    })();
    res.json({ ok: true, data: { id: Number(l.id),
      pedidos_afectados: reservas.map((r) => r.numero) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── LA CALIDAD LA CORRIGE EL QUE LA DESCUBRE ─────────────────────────────
// Se abre un cajón dos días después y no era primera. El que se da cuenta está
// en el depósito, no es el dueño — y mandarlo a pedir que se lo corrijan es lo
// que hace que nadie lo corrija.
//
// La calidad es una OBSERVACIÓN: no mueve kilos, ni costo, ni lo que se le debe
// al proveedor. Por eso no pasa por los frenos de la corrección de cantidades y
// se puede tocar aunque la partida ya esté contabilizada.
//
// PERO SÓLO MIENTRAS ESTÉ EN STOCK. Una vez vendida, su costo ya viajó a la
// venta y al margen: cambiarle la calidad ahí atrás es reescribir el pasado de
// algo cerrado. Y queda registrado quién y cuándo, igual que cualquier otra
// corrección.
router.put('/lotes/:id/calidad', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const l = db.prepare(`SELECT l.*, i.oc_id FROM sg_lotes l
      LEFT JOIN sg_oc_items i ON i.id = l.oc_item_id
      WHERE l.id=? AND l.activo=1`).get(req.params.id);
    if (!l) return res.status(404).json({ ok: false, error: 'Partida no encontrada' });
    const nueva = val(req.body?.calidad);
    if (nueva && !['primera', 'segunda', 'tercera'].includes(nueva)) {
      return res.status(400).json({ ok: false, error: 'Calidad inválida' });
    }
    const disp = (l.kg_reales || 0) - kgDespachados(db, l.id)
               - kgDecomisado(db, l.id) - kgTransformado(db, l.id);
    if (!(disp > 0.01)) {
      return res.status(400).json({ ok: false,
        error: 'Esta partida ya no está en stock: salió entera. Su costo ya viajó a la venta, '
             + 'así que cambiarle la calidad ahora sería reescribir algo cerrado.' });
    }
    if (String(l.calidad || '') === String(nueva || '')) return res.json({ ok: true, sin_cambios: true });
    db.transaction(() => {
      anotarEdicion(db, { tabla: 'sg_lotes', registroId: l.id, campo: 'calidad',
        antes: l.calidad, despues: nueva, motivo: val(req.body?.motivo) || 'Corrección de calidad',
        ocId: l.oc_id, userId: uid(req) });
      db.prepare(`UPDATE sg_lotes SET calidad=?, modificado_en=datetime('now','localtime'),
        modificado_por=? WHERE id=?`).run(nueva, uid(req), l.id);
    })();
    res.json({ ok: true, data: { id: Number(l.id), calidad: nueva } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── CORREGIR LAS CANTIDADES DE UNA PARTIDA ───────────────────────────────
// Los frenos de verdad no son el rol: no se corrige una partida ya contabilizada
// —primero se anula el asiento— ni una de la que ya se despachó mercadería, y eso
// lo controla frenosDeEdicionLote(). El rol decide QUÉ se puede tocar:
//
// LOS BULTOS RECIBIDOS NO SE CORRIGEN. Decisión de Pablo: los bultos son lo que
// se contó al bajar el camión, y es el número con el que el comprador cierra la
// compra. Si entraron 100 de más, no se "corrige" el conteo: se arregla la ORDEN
// por el precio del bulto, que es otra pantalla y otra decisión.
//
// Los KILOS sí --la balanza se tipea mal-- y la CALIDAD también, por su camino.
//
// Y EL PERMISO YA NO SE MIRA POR CAMPO. En la V788 esto preguntaba si el usuario
// era admin para dejarlo tocar el precio o el peso. Desde la V795 las cantidades
// se corrigen en Ingresos y el precio en la orden, que son dos pantallas de dos
// módulos distintos: el permiso lo decide exigirNivel mirando la dirección, como
// en todo el resto del repo. Un `if (rol === 'admin')` suelto acá adentro era el
// mismo candado escrito dos veces, y el de adentro no lo administra nadie.
router.put('/lotes/:id/corregir', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const motivo = val(b.motivo);
    if (!motivo) return res.status(400).json({ ok: false, error: 'Escribí por qué se corrige: queda registrado' });

    const chk = frenosDeEdicionLote(db, req.params.id);
    if (chk.error) return res.status(400).json({ ok: false, error: chk.error });

    const prev = db.prepare('SELECT * FROM sg_lotes WHERE id=?').get(req.params.id);
    // El factor de la partida: con él, corregir el conteo alcanza para que los
    // kilos queden bien solos.
    const kpbPrev = (prev.kg_por_bulto != null && prev.kg_por_bulto > 0)
      ? Number(prev.kg_por_bulto)
      : (prev.presentacion_id
          ? (db.prepare('SELECT factor_conversion f FROM sg_presentaciones WHERE id=?')
               .get(prev.presentacion_id) || {}).f
          : null);
    // ── LOS BULTOS NO SE TOCAN ────────────────────────────────────────────
    // Se rechaza en vez de ignorarlo en silencio: quien mandó el número cree que
    // lo cambió, y descubrirlo un mes después es peor que un error ahora.
    const bultosPedidos = (b.bultos === '' || b.bultos == null) ? null : Math.round(Number(b.bultos));
    if (bultosPedidos != null && bultosPedidos !== prev.bultos) {
      return res.status(400).json({ ok: false,
        error: 'Los bultos recibidos no se corrigen: son los que se contaron al bajar el camión. '
             + 'Si entraron ' + Math.abs(bultosPedidos - (prev.bultos || 0)) + ' de '
             + (bultosPedidos > (prev.bultos || 0) ? 'más' : 'menos') + ', lo que se arregla es la '
             + 'ORDEN DE COMPRA, por el precio del bulto. Acá se corrigen los kilos.' });
    }
    const nuevo = {
      kg_reales: numF(b.kg_reales) != null ? numF(b.kg_reales) : prev.kg_reales,
      bultos: prev.bultos,   // no se corrigen: ver arriba
      calidad: b.calidad !== undefined ? val(b.calidad) : prev.calidad,
      precio_unitario_kg: b.precio_unitario_kg !== undefined
        ? numF(b.precio_unitario_kg) : prev.precio_unitario_kg,
    };
    if (!(nuevo.kg_reales > 0)) {
      return res.status(400).json({ ok: false, error: 'Los kilos tienen que ser mayores a cero' });
    }

    // ── LOS KILOS Y LOS BULTOS TIENEN QUE SEGUIR SIENDO EL MISMO LOTE ────
    // El módulo corre sobre DOS unidades: el despacho y las reservas validan en
    // BULTOS y derivan los kilos (bultos × kg por bulto); el costo, el margen y
    // lo que se le debe al proveedor corren sobre kg_reales.
    //
    // Corregir sólo el peso —que es lo más probable: alguien tipeó mal la
    // balanza— rompía esa correspondencia en silencio, y después se podían
    // despachar 100 cajones de 20 kg, o sea 2.000 kg, de un lote que decía
    // 1.800. El stock en kilos se iba a negativo mientras el de cajones decía
    // cero, con los dos números saliendo del mismo lote.
    //
    // Si el lote se maneja por bultos, los dos números tienen que cerrar entre
    // sí. Se admite un kilo de diferencia: es una balanza de camión.
    const kpb = (prev.kg_por_bulto != null && prev.kg_por_bulto > 0)
      ? Number(prev.kg_por_bulto)
      : (prev.presentacion_id
          ? (db.prepare('SELECT factor_conversion f FROM sg_presentaciones WHERE id=?')
               .get(prev.presentacion_id) || {}).f
          : null);
    // AHORA QUE LOS BULTOS NO SE TOCAN, ESTO NO PUEDE SER UN RECHAZO. Si los
    // 100 cajones pesaron 1.900 y no 2.000, el que está mal no es ninguno de los
    // dos números: es el KG POR BULTO, que era una estimación. Los cajones pesan
    // lo que pesan.
    //
    // Se recalcula el factor del lote (kilos / bultos) y la correspondencia
    // sigue cerrando, que es lo que este freno defiende: el despacho descuenta
    // por bultos y el costo por kilos, y si no cierran entre sí el stock se va a
    // negativo en una unidad mientras la otra dice cero.
    //
    // Rechazar dejaba los kilos CLAVADOS: sin poder tocar los bultos, no había
    // forma de escribir un peso distinto al que daba la cuenta vieja.
    let kpbNuevo = null;
    if (nuevo.bultos > 0 && kpb > 0
        && Math.abs(r2(nuevo.kg_reales - r2(nuevo.bultos * kpb))) > 1) {
      kpbNuevo = +(nuevo.kg_reales / nuevo.bultos).toFixed(4);
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
        costo_base=?, kg_por_bulto=COALESCE(?, kg_por_bulto),
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
        .run(nuevo.kg_reales, nuevo.bultos, nuevo.calidad, nuevo.precio_unitario_kg,
             costoBase, kpbNuevo, uid(req), prev.id);
      // El factor nuevo se anota: es un dato que cambió, no un detalle interno.
      if (kpbNuevo != null) {
        anotarEdicion(db, { tabla: 'sg_lotes', registroId: prev.id, campo: 'kg_por_bulto',
          antes: kpb, despues: kpbNuevo, motivo: motivo, ocId: prev.oc_id, userId: uid(req) });
      }
      // Y lo que cuelga de esos kilos: el costo con sus gastos, y el período.
      recalcCostoLote(db, prev.id);
      if (prev.fecha_ingreso) recalcPeriodo(db, String(prev.fecha_ingreso).slice(0, 7));
      // Y lo que se le debe al proveedor. El cronograma de pago se arma con la
      // suma de los costos de los lotes de la orden: si se corrigen los kilos y
      // no se regenera, se le termina pagando por mercadería que no entró.
      // Se llama desde los otros siete lugares donde cambia lo que se debe;
      // faltaba acá.
      if (chk.lote.oc_id) generarVencimientos(db, chk.lote.oc_id);
    })();
    const l = db.prepare('SELECT * FROM sg_lotes WHERE id=?').get(prev.id);
    res.json({ ok: true, data: l });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── DAR UNA PARTIDA POR LIQUIDADA ────────────────────────────────────────
// La forma normal de sacar una partida de la bandeja es cargarle la liquidación
// desde ahí. Pero hay dos casos que quedarían trabados para siempre: la
// liquidación que se cargó por el botón suelto (sin decir de qué partida es) y
// la que se emitió fuera del sistema. Sin esta salida, esas partidas se
// acumulan en la bandeja sin que nadie pueda hacer nada.
//
// Sólo admin y con motivo, como todo lo que se corrige a mano.
router.post('/oc/:id/liquidada', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const motivo = val(req.body && req.body.motivo);
    if (!motivo) return res.status(400).json({ ok: false, error: 'Escribí por qué se da por liquidada' });
    const oc = db.prepare('SELECT * FROM sg_oc WHERE id=? AND activo=1').get(req.params.id);
    if (!oc) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });
    const doc = oc.documenta
      || (oc.tipo_precio === 'pizarra' || oc.tipo_fiscal === 'liquidacion' ? 'liquidacion' : 'factura');
    if (doc !== 'liquidacion') {
      return res.status(400).json({ ok: false,
        error: 'Esta partida se documenta con factura de compra, no con liquidación.' });
    }
    if (oc.liquidada_en) return res.status(400).json({ ok: false, error: 'Ya estaba dada por liquidada' });

    db.transaction(() => {
      anotarEdicion(db, { tabla: 'sg_oc', registroId: oc.id, campo: 'liquidada_en',
        antes: null, despues: 'liquidada', motivo, ocId: oc.id, userId: uid(req) });
      db.prepare(`UPDATE sg_oc SET liquidada_en=datetime('now','localtime'), liquidada_por=?,
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
        .run(uid(req), uid(req), oc.id);
    })();
    res.json({ ok: true, data: { id: Number(oc.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── CAMBIAR SI LA PARTIDA SE LIQUIDA O SE FACTURA ────────────────────────
// El comprador se equivoca al cargar la orden y la partida termina en la
// bandeja que no es. Sólo admin, con motivo, y queda registrado — igual que
// cualquier otra corrección.
// Cambiar el circuito de una partida —factura o liquidación— es OPERAR: lo
// decide el comprador cuando se aclara cómo se documenta la compra.
router.put('/oc/:id/documenta', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const destino = req.body && req.body.documenta;
    const motivo = val(req.body && req.body.motivo);
    if (!['factura', 'liquidacion'].includes(destino)) {
      return res.status(400).json({ ok: false, error: 'Elegí si se factura o se liquida' });
    }
    if (!motivo) return res.status(400).json({ ok: false, error: 'Escribí por qué se cambia: queda registrado' });

    const oc = db.prepare('SELECT * FROM sg_oc WHERE id=? AND activo=1').get(req.params.id);
    if (!oc) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });

    // Si ya se contabilizó, esto define de dónde salió el asiento: no se mueve
    // sin anularlo primero.
    const fac = db.prepare(`SELECT f.asiento_id, a.anulado FROM sg_facturas_compra f
      LEFT JOIN sg_asientos a ON a.id = f.asiento_id
      WHERE f.activo=1 AND f.asiento_id IS NOT NULL
        AND (f.oc_id = ? OR EXISTS (SELECT 1 FROM sg_factura_compra_ocs fo
                                     WHERE fo.factura_id = f.id AND fo.oc_id = ?))`).get(oc.id, oc.id);
    if (fac && !fac.anulado) {
      return res.status(400).json({ ok: false,
        error: 'Esta partida ya está contabilizada en el asiento ' + fac.asiento_id
             + '. Anulá el asiento antes de cambiarla de circuito.' });
    }

    const antes = oc.documenta
      || (oc.tipo_precio === 'pizarra' || oc.tipo_fiscal === 'liquidacion' ? 'liquidacion' : 'factura');
    // Si pasa a factura, la condición vuelve a ser precio cerrado: no hay
    // factura de compra a precio de pizarra.
    const precioNuevo = destino === 'factura' ? 'firme' : oc.tipo_precio;
    // Y EL COMPROBANTE TIENE QUE ACOMPAÑAR. Cambiar sólo el circuito y dejar el
    // comprobante como estaba deja la partida trabada del otro lado: llega a la
    // bandeja de facturas diciendo que su comprobante es una Liquidación, y esa
    // pantalla sólo carga Factura A o B. Es el mismo problema que este cambio
    // vino a arreglar, movido de lugar.
    const fiscalNuevo = destino === 'liquidacion'
      ? 'liquidacion'
      : (oc.tipo_fiscal === 'liquidacion' ? 'factura_a' : oc.tipo_fiscal);

    db.transaction(() => {
      anotarEdicion(db, { tabla: 'sg_oc', registroId: oc.id, campo: 'documenta',
        antes, despues: destino, motivo, ocId: oc.id, userId: uid(req) });
      anotarEdicion(db, { tabla: 'sg_oc', registroId: oc.id, campo: 'tipo_precio',
        antes: oc.tipo_precio, despues: precioNuevo, motivo, ocId: oc.id, userId: uid(req) });
      anotarEdicion(db, { tabla: 'sg_oc', registroId: oc.id, campo: 'tipo_fiscal',
        antes: oc.tipo_fiscal, despues: fiscalNuevo, motivo, ocId: oc.id, userId: uid(req) });
      db.prepare(`UPDATE sg_oc SET documenta=?, tipo_precio=?, tipo_fiscal=?,
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
        .run(destino, precioNuevo, fiscalNuevo, uid(req), oc.id);
      // Y SE DA DE BAJA EL COMPROBANTE DEL OTRO CIRCUITO. Si esta partida tenía
      // una factura de compra cargada —con su asiento ya anulado, que es lo
      // único que el freno de arriba deja pasar— y ahora se documenta con
      // liquidación, esa factura no puede quedar viva: la partida terminaría con
      // dos comprobantes por el mismo importe y nada avisándolo.
      if (destino === 'liquidacion') {
        const bajas = db.prepare(`UPDATE sg_facturas_compra SET activo=0,
            modificado_en=datetime('now','localtime'), modificado_por=?
          WHERE activo=1 AND (oc_id = ?
             OR id IN (SELECT fo.factura_id FROM sg_factura_compra_ocs fo WHERE fo.oc_id = ?))`)
          .run(uid(req), oc.id, oc.id).changes;
        if (bajas) {
          anotarEdicion(db, { tabla: 'sg_oc', registroId: oc.id, campo: 'factura_compra',
            antes: 'cargada', despues: 'dada de baja', motivo, ocId: oc.id, userId: uid(req) });
        }
        // Y el número que quedó anotado en la recepción, que es de donde la
        // bandeja de facturas lee que la partida ya no está pendiente.
        db.prepare(`UPDATE sg_recepciones SET factura_numero=NULL,
          modificado_en=datetime('now','localtime'), modificado_por=?
          WHERE oc_id=? AND activo=1 AND factura_numero IS NOT NULL`).run(uid(req), oc.id);
      }
    })();
    res.json({ ok: true,
      data: { id: Number(oc.id), documenta: destino, tipo_precio: precioNuevo, tipo_fiscal: fiscalNuevo } });
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

// ── LA PARTE QUE NO VINO EN LA FACTURA ───────────────────────────────────
// Dos líneas, en el MISMO asiento, marcadas como gestión: el gasto al debe y
// Proveedores al haber, por la diferencia entre lo acordado y lo facturado.
//
// Van a las MISMAS cuentas que la parte fiscal, no a una cuenta de ajuste
// aparte: es la misma mercadería y la misma deuda con el mismo proveedor. Lo
// único que cambia es de qué libro es cada mitad.
//
// Y SIN IVA. El crédito fiscal sale del comprobante y de nada más: la parte que
// no está facturada no genera IVA, ni percepciones, ni retenciones. Por eso se
// toma la línea de GASTO —la que se llevó el neto— y la de proveedores, y se
// dejan afuera todas las impositivas.
function lineasGestionFactura(lineasAsiento, fac) {
  const dif = r2(fac && fac.dif_gestion);
  if (!dif) return [];
  const TRIB = ['iva', 'percepcion_iva', 'percepcion_iibb', 'percepcion_ganancias', 'retencion'];
  const gasto = lineasAsiento.find((l) => l.lado === 'debe' && !TRIB.includes(l.tipo_linea) && l.cuenta_id);
  const prov = lineasAsiento.find((l) => l.tipo_linea === 'proveedores' && l.cuenta_id);
  if (!gasto || !prov) {
    throw new Error('El asiento modelo no tiene línea de gasto o de Proveedores: sin eso no se puede '
      + 'registrar la diferencia con lo acordado.');
  }
  const motivo = fac.dif_motivo || 'ajuste_gestion';
  // FALTÓ FACTURAR (dif > 0): la compra vale más de lo que dice el papel, así
  // que el gasto sube y la deuda con el proveedor sube.
  //
  // FACTURÓ DE MÁS (dif < 0): al revés. El gasto BAJA y la deuda baja, porque lo
  // acordado es menos que lo facturado. Las mismas dos cuentas, los lados
  // cruzados: un asiento con importes negativos no lo lee nadie, y varias
  // pantallas los suman como si fueran positivos.
  const m = Math.abs(dif);
  const sube = dif > 0;
  const texto = sube ? 'Falta facturar contra lo acordado'
                     : 'Facturado de más contra lo acordado';
  return [
    { cuenta_id: gasto.cuenta_id, debe: sube ? m : 0, haber: sube ? 0 : m,
      ambito: 'gestion', motivo, descripcion: texto },
    { cuenta_id: prov.cuenta_id, debe: sube ? 0 : m, haber: sube ? m : 0,
      ambito: 'gestion', motivo, descripcion: texto },
  ];
}

// ── ANULAR UNA FACTURA DE MERCADERÍA ─────────────────────────────────────
// No había manera. Una factura mal cargada se podía pisar cargando otra encima,
// pero no dar de baja: si el proveedor la anuló de su lado, o se cargó contra la
// partida equivocada, quedaba viva moviendo la cuenta corriente para siempre.
// Lo único que la daba de baja era cambiarle el circuito a la partida, y como
// efecto lateral.
//
// Se anula con su PROPIA dirección —así el control de niveles la reconoce— y
// con motivo obligatorio, como todo lo que deshace algo en este sistema.
//
// TRES FRENOS, y los tres son la misma idea: no dejar el libro colgado.
router.post('/facturas-compra/:id/anular', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const motivo = val(req.body && req.body.motivo);
    if (!motivo) return res.status(400).json({ ok: false, error: 'Escribí por qué se anula: queda registrado' });
    const f = db.prepare('SELECT * FROM sg_facturas_compra WHERE id=?').get(req.params.id);
    if (!f) return res.status(404).json({ ok: false, error: 'Factura no encontrada' });
    if (!f.activo) return res.status(400).json({ ok: false, error: 'Esa factura ya está dada de baja' });

    // 1. Si ya se le pagó algo, no. El pago quedaría imputado a un comprobante
    //    que no existe, y la plata ya salió: primero se anula el pago.
    if (r2(f.saldo_pagado) > 0) {
      return res.status(400).json({ ok: false,
        error: 'Esta factura tiene ' + r2(f.saldo_pagado) + ' pagados. Anulá primero esa orden de pago: '
             + 'si no, el pago queda colgado de un comprobante que ya no está.' });
    }
    // 2. Y si está contabilizada, primero se anula el asiento. Se hace acá mismo
    //    —no se manda a otra pantalla— porque son la misma decisión.
    const asi = f.asiento_id
      ? db.prepare('SELECT id, anulado FROM sg_asientos WHERE id=?').get(f.asiento_id) : null;

    db.transaction(() => {
      if (asi && !asi.anulado) {
        db.prepare(`UPDATE sg_asientos SET anulado=1, anulado_por=?, anulado_en=datetime('now','localtime'),
          descripcion = descripcion || ' — ANULADO: ' || ? WHERE id=?`).run(uid(req), motivo, asi.id);
      }
      db.prepare(`UPDATE sg_facturas_compra SET activo=0,
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`).run(uid(req), f.id);
      // 3. Y la partida vuelve a estar esperando factura. El número quedaba
      //    anotado en la recepción, que es de donde la bandeja lee que ya no
      //    está pendiente: sin limpiarlo, la partida desaparecía del circuito.
      const ocs = db.prepare('SELECT oc_id FROM sg_factura_compra_ocs WHERE factura_id=?').all(f.id)
        .map((x) => x.oc_id);
      if (f.oc_id && ocs.indexOf(f.oc_id) < 0) ocs.push(f.oc_id);
      for (const ocId of ocs) {
        db.prepare(`UPDATE sg_recepciones SET factura_numero=NULL,
          modificado_en=datetime('now','localtime'), modificado_por=?
          WHERE oc_id=? AND activo=1`).run(uid(req), ocId);
        anotarEdicion(db, { tabla: 'sg_facturas_compra', registroId: f.id, campo: 'anulada',
          antes: (f.punto_venta ? f.punto_venta + '-' : '') + (f.numero || ''), despues: 'dada de baja',
          motivo, ocId, userId: uid(req) });
      }
    })();
    res.json({ ok: true, data: { id: Number(f.id), asiento_anulado: !!(asi && !asi.anulado) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
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
    // El nombre del proveedor va en la descripción: sin él, el listado de
    // Asientos Contables es una lista de códigos y hay que abrir uno por uno.
    const provNom2 = (db.prepare('SELECT razon_social r FROM sg_proveedores WHERE id=?')
      .get(fac.proveedor_id) || {}).r;
    const desc = 'Compra de mercadería' + (provNom2 ? ' — ' + provNom2 : '')
      + ' — Factura ' + nroFac
      + (partidas.length ? ' — Partida' + (partidas.length > 1 ? 's ' : ' ') + partidas.join(', ') : '');

    let asientoId;
    db.transaction(() => {
      // El asiento va a sg_asientos_lineas, que es de donde el módulo contable
      // arma el mayor y el balance. sg_movimientos_contables existe pero no la
      // lee nadie —se creó "por paridad estructural" con Puente Cordón—, así
      // que escribir ahí sería inventar un segundo lugar para lo mismo y que
      // dentro de un año no se sepa cuál de los dos manda.
      asientoId = crearAsiento(db, {
        fecha: fac.fecha_emision, descripcion: desc, usuario_id: uid(req),
        ref_compra_id: fac.id, ref_codigo: nroFac,
      }, conCuenta.map((l) => ({
        cuenta_id: l.cuenta_id,
        debe: l.lado === 'debe' ? l.monto : 0,
        haber: l.lado === 'haber' ? l.monto : 0,
        descripcion: l.descripcion || null,
      })).concat(lineasGestionFactura(asiento.lineas, fac))).id;
      db.prepare(`UPDATE sg_facturas_compra SET asiento_id=?, confirmada_en=datetime('now','localtime'),
        confirmada_por=?, modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
        .run(asientoId, uid(req), uid(req), fac.id);
    })();
    res.json({ ok: true, data: { asiento_id: Number(asientoId), fecha: fac.fecha_emision, asiento } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ANULAR un asiento. Con la clave del administrador: no se borra, queda a la
// vista con quién lo anuló y cuándo, y la factura vuelve a poder contabilizarse.
// ANULAR UN ASIENTO es lo más delicado de la lista y por eso mismo tiene que
// poder hacerlo el contador sin depender del dueño. Los frenos siguen abajo:
// pide la clave del que lo hace y un motivo, y no borra nada — marca anulado.
router.post('/asientos/:id/anular', requireAuth, async (req, res) => {
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

    const a = db.prepare('SELECT id, anulado, ref_compra_id FROM sg_asientos WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ ok: false, error: 'Asiento no encontrado' });
    if (a.anulado) return res.status(400).json({ ok: false, error: 'Ese asiento ya está anulado' });

    // ── EL ASIENTO DE UNA FACTURA NO SE ANULA POR SU CUENTA ──────────────
    // Anularlo desde acá dejaba la factura VIVA y fuera del libro —la regla de
    // oro rota— y, peor, sin vuelta: la partida seguía marcada como facturada,
    // así que tampoco se podía cargar otra factura.
    //
    // La factura es el HECHO y el asiento es su CONSECUENCIA. Se deshace el
    // hecho y la consecuencia lo sigue: anular la factura ya da de baja el
    // comprobante, anula su asiento, limpia el número de la recepción y devuelve
    // la partida a "esperando factura". Una sola puerta, un solo camino.
    // El freno vive en servicios/asientos.js: hay DOS pantallas que anulan
    // asientos y la regla tiene que ser una sola. Ver frenoAsientoDeCompra.
    const freno = frenoAsientoDeCompra(db, a.id);
    if (freno) return res.status(400).json({ ok: false, error: freno.error,
      factura_id: freno.factura_id, factura_numero: freno.factura_numero });

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
    // SI NO HAY NADA EN EL PERÍODO, ¿HAY ALGO AFUERA? Una factura contabilizada
    // con fecha fuera del rango deja la pantalla vacía, y "no hay facturas
    // contabilizadas" se lee como que el asiento no se generó. Con esto la
    // pantalla puede decir "hay 3 fuera de este período" y dejar de asustar.
    let fuera = 0, primera = null, ultima = null;
    if (!rows.length) {
      const o = db.prepare(`SELECT COUNT(*) c, MIN(fecha_emision) p, MAX(fecha_emision) u
        FROM sg_facturas_compra f WHERE f.activo=1 AND f.asiento_id IS NOT NULL`).get();
      fuera = o.c || 0; primera = o.p; ultima = o.u;
    }
    res.json({ ok: true, data: { filas: rows, totales: t, fuera_del_periodo: fuera, primera, ultima } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Partidas de precio cerrado a las que todavía no se les cargó la factura del
// proveedor. El número de factura se carga en el paso 1 de la recepción.
// ── LAS FACTURAS CARGADAS QUE TODAVÍA NO ESTÁN EN EL LIBRO ───────────────
//
// Guardar la factura y contabilizarla son dos pasos: se puede guardar hoy y
// contabilizar mañana, y ANULAR un asiento devuelve la factura a este estado,
// que es justo para lo que sirve anularlo — corregir y rehacer.
//
// Pero no había ninguna pantalla donde vieras estas facturas. La partida ya no
// vuelve a "Facturas por mercadería" —su comprobante está cargado— y el listado
// de órdenes la mostraba en verde como si estuviera resuelta. Anulabas para
// corregir y te quedabas sin lugar desde donde rehacerla.
router.get('/facturas-sin-contabilizar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT f.id, f.oc_id, f.fecha_emision, f.tipo_comprobante, f.punto_venta, f.numero,
             f.neto, f.iva_monto, f.total, f.creado_en,
             p.razon_social AS proveedor_nombre,
             o.trazabilidad, o.numero AS oc_numero,
             -- Si tuvo un asiento y se anuló, se dice: no es lo mismo "todavía
             -- no se contabilizó" que "se anuló y hay que rehacerla".
             (SELECT an.id FROM sg_asientos an
               WHERE an.ref_compra_id = f.id AND an.anulado = 1
               ORDER BY an.id DESC LIMIT 1) AS asiento_anulado_id,
             (SELECT an.anulado_en FROM sg_asientos an
               WHERE an.ref_compra_id = f.id AND an.anulado = 1
               ORDER BY an.id DESC LIMIT 1) AS anulado_en,
             (SELECT GROUP_CONCAT(o2.trazabilidad, ' · ') FROM sg_factura_compra_ocs fo
                JOIN sg_oc o2 ON o2.id = fo.oc_id WHERE fo.factura_id = f.id) AS partidas
        FROM sg_facturas_compra f
        LEFT JOIN sg_proveedores p ON p.id = f.proveedor_id
        LEFT JOIN sg_oc o ON o.id = f.oc_id
       -- SIN ASIENTO VIGENTE, no sólo sin asiento_id. La pantalla de
       -- Contabilidad SG anulaba el asiento sin limpiar el puntero de la
       -- factura, así que quedaba apuntando a uno anulado: no entraba acá --el
       -- asiento_id no era NULL-- ni en pendientes de facturar --ya tenía
       -- factura--. La partida desaparecía del circuito y no había forma de
       -- volver a facturarla.
       WHERE f.activo = 1
         AND (f.asiento_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM sg_asientos a
                              WHERE a.id = f.asiento_id AND COALESCE(a.anulado,0) = 0))
       ORDER BY f.fecha_emision DESC, f.id DESC`).all();
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/partidas-a-facturar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = partidasRecibidas(db, 'factura').filter((r) => !r.facturas);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Cargar la factura del proveedor sobre una partida ya recibida. Se guarda en su
// recepción, que es donde vive el resto de la documentación del camión.
// ANOTAR EL NÚMERO QUE TRAJO EL CAMIÓN. Es el mismo campo del paso 1 de la
// recepción: documentación del remito, nada más.
//
// NO deja la partida "facturada": eso lo decide la factura de compra cargada
// —la que tiene neto, IVA, percepciones y asiento—. Antes sí lo decidía, y por
// eso una partida a la que alguien le anotó el número al recibir salía de la
// bandeja de pendientes y se pintaba verde sin que existiera ningún comprobante.
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
// ══════════════════════════════════════════════════════════════════════════
// LA MERCADERÍA QUE ENTRÓ SIN ORDEN DE COMPRA
// ══════════════════════════════════════════════════════════════════════════
// Llega un camión sin orden. No se lo manda de vuelta: se recibe, se pesa y se
// le arma la orden hacia atrás con el proveedor y la fecha, que es lo que
// nomencla la partida. Pero esa orden nace a medias — le falta lo que decide el
// comprador: a cuánto se cerró, en cuántos días se paga, qué documenta.
//
// Sin esta bandeja, esas órdenes se mezclaban con las demás y nadie sabía
// cuáles estaban a medio hacer. Se descubrían cuando había que facturar.

// Qué le falta a una orden para dejar de estar a medias. Devuelve la lista de
// huecos, en el orden en que molestan.
function faltaDeOrden(db, oc) {
  const falta = [];
  if (!oc.condicion_pago_id) falta.push('condición de pago');
  // Con precio de pizarra el precio se cierra después, y eso NO es un hueco:
  // es la modalidad. El hueco es el precio firme sin número.
  if (oc.tipo_precio !== 'pizarra') {
    const sinPrecio = db.prepare(`SELECT COUNT(*) c FROM sg_oc_items
      WHERE oc_id=? AND (precio_estimado_por_kg IS NULL OR precio_estimado_por_kg <= 0)`).get(oc.id).c;
    if (sinPrecio) falta.push(sinPrecio === 1 ? 'el precio' : 'el precio de ' + sinPrecio + ' artículos');
  }
  // NO se pide "quién compró": San Gerónimo no tiene todavía ninguna pantalla
  // que asigne comercial a una orden, así que pedirlo dejaría a TODAS las
  // órdenes eternamente incompletas y la bandeja no se vaciaría nunca.
  return falta;
}

router.get('/oc/sin-orden', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const verTodas = req.query.todas === '1';
    const rows = db.prepare(`
      SELECT o.id, o.numero, o.trazabilidad, o.fecha_oc, o.proveedor_id, o.tipo_precio,
             o.tipo_fiscal, o.documenta, o.condicion_pago_id, o.comercial_id, o.observaciones,
             o.total_estimado_kg, o.total_estimado_monto, o.completada_en, o.estado,
             p.razon_social AS proveedor_nombre,
             (SELECT COUNT(*) FROM sg_lotes l JOIN sg_oc_items i2 ON i2.id = l.oc_item_id
               WHERE i2.oc_id = o.id AND l.activo = 1) AS bultos,
             (SELECT GROUP_CONCAT(DISTINCT pr.nombre) FROM sg_oc_items i3
                JOIN sg_productos pr ON pr.id = i3.producto_id WHERE i3.oc_id = o.id) AS productos
        FROM sg_oc o
        LEFT JOIN sg_proveedores p ON p.id = o.proveedor_id
       WHERE o.modalidad = 'retroactiva' AND o.activo = 1 AND o.estado <> 'anulada'
         ${verTodas ? '' : 'AND o.completada_en IS NULL'}
       ORDER BY o.fecha_oc DESC, o.id DESC`).all();
    const data = rows.map((o) => ({ ...o, falta: faltaDeOrden(db, o) }));
    res.json({ ok: true, data, pendientes: data.filter((o) => !o.completada_en).length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Los artículos de esa orden, para que el comprador les ponga precio.
router.get('/oc/:id/items-sin-orden', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const items = db.prepare(`SELECT i.id, i.producto_id, i.kg_estimados, i.precio_estimado_por_kg,
        pr.nombre AS producto_nombre,
        (SELECT COUNT(*) FROM sg_lotes l WHERE l.oc_item_id = i.id AND l.activo = 1) AS bultos
      FROM sg_oc_items i LEFT JOIN sg_productos pr ON pr.id = i.producto_id
      WHERE i.oc_id = ? ORDER BY i.id`).all(req.params.id);
    res.json({ ok: true, data: items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// COMPLETAR LA ORDEN. Lo que pone el comprador cuando se sienta a cerrar la
// compra que ya entró. El precio baja hasta los lotes: el costo de la
// mercadería es el del lote, no el del renglón de la orden.
router.post('/oc/:id/completar', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const oc = db.prepare("SELECT * FROM sg_oc WHERE id=? AND activo=1").get(req.params.id);
    if (!oc) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });
    if (oc.modalidad !== 'retroactiva') {
      return res.status(400).json({ ok: false,
        error: 'Esta orden no nació de una descarga sin orden: se edita desde la orden misma.' });
    }
    if (oc.estado === 'anulada') return res.status(400).json({ ok: false, error: 'Esa orden está anulada' });

    const precios = (Array.isArray(b.items) ? b.items : [])
      .map((x) => ({ id: Number(x.oc_item_id), precio: Number(x.precio_por_kg) }))
      .filter((x) => x.id && x.precio > 0);

    // El circuito —factura o liquidación, precio firme o pizarra— se decide con
    // la misma función que el alta normal: una sola cabeza para todo el sistema.
    const dft = defaultsProveedor(db, oc.proveedor_id, {});
    const circ = circuitoDeCompra(
      { documenta: b.documenta, tipo_precio: b.tipo_precio || oc.tipo_precio }, dft.tipo_fiscal);

    let quedaSinPrecio = 0;
    db.transaction(() => {
      db.prepare(`UPDATE sg_oc SET condicion_pago_id=?, comercial_id=?, tipo_precio=?, tipo_fiscal=?,
          documenta=?, observaciones=COALESCE(?, observaciones),
          modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`).run(
        b.condicion_pago_id ? Number(b.condicion_pago_id) : oc.condicion_pago_id,
        b.comercial_id ? Number(b.comercial_id) : oc.comercial_id,
        circ.tipoPrecio, circ.tipoFiscal, circ.documenta,
        val(b.observaciones) || null, uid(req), oc.id);

      const setItem = db.prepare('UPDATE sg_oc_items SET precio_estimado_por_kg=? WHERE id=? AND oc_id=?');
      const lotesDe = db.prepare('SELECT id, kg_reales FROM sg_lotes WHERE oc_item_id=? AND activo=1');
      const setLote = db.prepare(`UPDATE sg_lotes SET precio_unitario_kg=?, costo_base=?,
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`);
      for (const p of precios) {
        setItem.run(p.precio, p.id, oc.id);
        for (const l of lotesDe.all(p.id)) {
          setLote.run(p.precio, r2((l.kg_reales || 0) * p.precio), uid(req), l.id);
          recalcCostoLote(db, Number(l.id));
        }
      }

      // El total de la orden se rehace con lo que quedó, no con lo que se mandó:
      // puede haber artículos que ya tenían precio y no se tocaron.
      const tot = db.prepare(`SELECT COALESCE(SUM(kg_estimados),0) kg,
          COALESCE(SUM(kg_estimados * COALESCE(precio_estimado_por_kg,0)),0) monto
        FROM sg_oc_items WHERE oc_id=?`).get(oc.id);
      db.prepare('UPDATE sg_oc SET total_estimado_kg=?, total_estimado_monto=? WHERE id=?')
        .run(tot.kg, r2(tot.monto), oc.id);

      const nueva = db.prepare('SELECT * FROM sg_oc WHERE id=?').get(oc.id);
      quedaSinPrecio = faltaDeOrden(db, nueva).length;
      // SÓLO SE MARCA COMPLETA SI DE VERDAD LO ESTÁ. Marcarla igual la saca de
      // la bandeja con los huecos adentro, que es peor que no tener bandeja.
      if (!quedaSinPrecio) {
        db.prepare(`UPDATE sg_oc SET completada_en=datetime('now','localtime'), completada_por=?
          WHERE id=?`).run(uid(req), oc.id);
      }
      generarVencimientos(db, oc.id);
    })();

    const fin = db.prepare('SELECT * FROM sg_oc WHERE id=?').get(oc.id);
    res.json({ ok: true, data: {
      id: Number(oc.id), completada: !quedaSinPrecio, falta: faltaDeOrden(db, fin),
    } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

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
                 AND r.numero_remito_proveedor <> '') AS remitos_proveedor,
             -- ── LO QUE EL LISTADO NECESITA PARA HABLAR EN BULTOS ──────────
             -- La compra se pacta y se controla en BULTOS. El listado sólo
             -- tenía kilos, así que el comprador tenía que abrir cada orden
             -- para saber cuántos cajones eran.
             (SELECT COALESCE(SUM(l.bultos), 0)
                FROM sg_lotes l
                JOIN sg_oc_items i ON i.id = l.oc_item_id
               WHERE i.oc_id = o.id AND l.activo = 1) AS bultos_recibidos_total,
             (SELECT COALESCE(SUM(i.cantidad_estimada_presentaciones), 0)
                FROM sg_oc_items i WHERE i.oc_id = o.id) AS bultos_estimados,
             -- ── LO QUE ENTRÓ SIN ORDEN, EN EL LISTADO DEL COMPRADOR ───────
             -- La mercadería que entra sin orden crea su orden ya recibida, con
             -- lo comercial en blanco: el que la recibió sabe QUÉ bajó y CUÁNTO,
             -- no a qué precio se pactó ni en cuántos días se paga.
             --
             -- Eso lo completa el comprador, y hasta ahora tenía que acordarse
             -- de entrar a una solapa aparte. Ahora aparece en el listado donde
             -- ya trabaja, marcada FALTA COMPLETAR — y deja de estar marcada
             -- cuando de verdad se completó, no cuando alguien la miró.
             (SELECT COUNT(*) FROM sg_oc_items i
               WHERE i.oc_id = o.id
                 AND (i.precio_estimado_por_kg IS NULL OR i.precio_estimado_por_kg <= 0)) AS items_sin_precio,
             -- ¿La compra se pactó EN BULTOS? Cuando se carga por kilo, los
             -- "bultos estimados" salen de dividir kilos por el factor y dan
             -- números que nadie pactó (1.000 kg / 18 = 55,5 cajones). Ese
             -- número no se muestra: no existe.
             (SELECT COUNT(*) FROM sg_oc_items i
               WHERE i.oc_id = o.id AND i.modo_carga = 'bulto') AS items_por_bulto,
             -- Y si ENTRÓ mitad contada y mitad pesada, el total de bultos no
             -- cuenta toda la mercadería: hay que decirlo, no mostrar 60 al
             -- lado de 2.000 kg como si fueran lo mismo.
             (SELECT COUNT(*) FROM sg_lotes l
                JOIN sg_oc_items i ON i.id = l.oc_item_id
               WHERE i.oc_id = o.id AND l.activo = 1
                 AND COALESCE(l.bultos, 0) = 0 AND l.kg_reales > 0) AS lotes_sin_contar,
             -- ── LOS BULTOS QUE ENTRARON, AUNQUE NO SE HAYAN CONTADO ───────
             -- Una compra pactada en cajones se mira en cajones. Si el camión
             -- se pesó sin contarlos, los cajones salen del peso: la orden ya
             -- dice cuántos kilos entran en cada uno. Antes la columna "Bultos"
             -- mostraba kilos en esos casos, que es cambiar de unidad en el
             -- medio de la misma columna.
             (SELECT COALESCE(SUM(
                  CASE WHEN COALESCE(l.bultos, 0) > 0 THEN l.bultos
                       WHEN COALESCE(i.kg_por_bulto, ps.factor_conversion) > 0
                         THEN l.kg_reales / COALESCE(i.kg_por_bulto, ps.factor_conversion)
                       ELSE 0 END), 0)
                FROM sg_lotes l
                JOIN sg_oc_items i ON i.id = l.oc_item_id
                LEFT JOIN sg_presentaciones ps ON ps.id = i.presentacion_id
               WHERE i.oc_id = o.id AND l.activo = 1) AS bultos_equivalentes,
             -- Y para decir QUÉ FALTA: con qué se documenta, y si ese papel ya
             -- llegó. Sin esto el listado dice "Rec. total" y no se sabe si la
             -- partida está esperando la factura desde hace tres semanas.
             COALESCE(o.documenta, CASE
                WHEN o.tipo_precio = 'pizarra' THEN 'liquidacion'
                WHEN o.tipo_fiscal = 'liquidacion' THEN 'liquidacion'
                ELSE 'factura' END) AS documenta_calc,
             -- Mismo criterio que la bandeja: la factura de compra CARGADA, no
             -- el número que se anotó al recibir el camión.
             (SELECT COUNT(*) FROM sg_facturas_compra f
               WHERE f.activo = 1
                 AND (f.oc_id = o.id
                      OR EXISTS (SELECT 1 FROM sg_factura_compra_ocs fo
                                  WHERE fo.factura_id = f.id AND fo.oc_id = o.id))) AS con_factura,
             -- Y si esa factura está en el libro o no. Anular el asiento deja la
             -- factura cargada pero fuera de la contabilidad: el listado la
             -- mostraba igual que una resuelta, en verde, y no había desde
             -- dónde rehacerla.
             (SELECT COUNT(*) FROM sg_facturas_compra f
               WHERE f.activo = 1 AND f.asiento_id IS NULL
                 AND (f.oc_id = o.id
                      OR EXISTS (SELECT 1 FROM sg_factura_compra_ocs fo
                                  WHERE fo.factura_id = f.id AND fo.oc_id = o.id))) AS facturas_sin_asiento
      FROM sg_oc o LEFT JOIN sg_proveedores p ON p.id=o.proveedor_id
      WHERE ${where.join(' AND ')} ORDER BY o.id DESC`).all(...params);

    const conLiq = partidasConLiquidacion(db);

    for (const o of rows) {
      o.liquidada = (o.liquidada_en || conLiq.has(Number(o.id))) ? 1 : 0;
      // EL IMPORTE DE LA ORDEN. Si ya entró mercadería, lo que vale es lo que
      // se acordó por lo que ENTRÓ —la misma cuenta que hace la pantalla de
      // facturas, en bultos por el precio del bulto—, no el estimado con el que
      // nació la orden. Si todavía no entró nada, el estimado es lo único que
      // hay, y el listado lo dice.
      const entro = (Number(o.kg_recibidos_total) || 0) > 0
        || (Number(o.bultos_recibidos_total) || 0) > 0;
      // SIEMPRE NETO, entre o no entre la mercadería. total_estimado_monto trae
      // el IVA sumado cuando la orden lo discrimina, y acordadoDeOC es neto: el
      // importe daba un salto al recibirse que no era ni un descuento ni un
      // error de carga, sólo dos bases distintas en la misma columna.
      const estimado = (o.total_neto != null && o.total_neto !== '')
        ? Number(o.total_neto) : (Number(o.total_estimado_monto) || 0);
      o.importe = entro ? acordadoDeOC(db, o.id).total : estimado;
      o.importe_es_estimado = entro ? 0 : 1;
      // LA DE PIZARRA, UNA VEZ QUE SE LE CERRÓ EL PRECIO. acordadoDeOC sale del
      // precio pactado en la orden, y una liquidación de venta nace sin precio:
      // devuelve 0 siempre. Pero cuando se le cierra el precio a los lotes la
      // mercadería YA está valorizada, y el listado seguía diciendo "a liquidar"
      // sobre una partida de un millón y medio. Ahí el importe son los lotes.
      if (entro && !o.importe) {
        const c = db.prepare(`SELECT COALESCE(SUM(l.costo_base), 0) t,
            COUNT(*) n, SUM(CASE WHEN l.precio_unitario_kg IS NULL THEN 1 ELSE 0 END) sinprecio
          FROM sg_lotes l JOIN sg_oc_items i ON i.id = l.oc_item_id
          WHERE i.oc_id = ? AND l.activo = 1`).get(o.id);
        if (c && c.n > 0 && !c.sinprecio) o.importe = r2(c.t);
      }
    }
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
    // POR QUÉ ENTRÓ DISTINTO. La explicación la escribe el que recibe, y hasta
    // ahora moría en la recepción: el que abre la orden veía la diferencia y no
    // el motivo, así que igual tenía que llamar por teléfono.
    // Desde que dejó de ser obligatoria puede venir vacía — y eso también se
    // dice, para saber cuáles hay que ir a completar.
    oc.variacion_motivos = db.prepare(`SELECT numero_recepcion, fecha_recepcion,
        COALESCE(variacion_motivo,'') AS motivo
      FROM sg_recepciones WHERE oc_id=? AND COALESCE(hay_variaciones,0)=1
      ORDER BY id`).all(req.params.id);
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
    const campos = ['tipo_fiscal', 'condicion_pago_id', 'fecha_oc', 'fecha_recepcion_estimada', 'comercial_id', 'observaciones', 'flete_a_cargo', 'flete_pagado_por', 'flete_monto'];
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
router.post('/oc/:id/anular', requireAuth, (req, res) => {
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
          const ids = crearLotesSinOC(db, { recepcionId: recId, productoId: Number(it.producto_id), fechaIngreso, lotes: it.lotes, userId: uid(req), req });
          nuevosLotes.push(...ids);
        } else {
          const ocItem = db.prepare('SELECT * FROM sg_oc_items WHERE id=? AND oc_id=?').get(it.oc_item_id, b.oc_id);
          if (!ocItem) throw new Error('Item de OC inválido: ' + it.oc_item_id);
          const ids = crearLotesDeItem(db, { recepcionId: recId, ocItem, tipoPrecio: oc.tipo_precio, fechaIngreso, lotes: it.lotes, userId: uid(req), req });
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
        (SELECT COUNT(*) FROM sg_lotes WHERE recepcion_id=r.id AND activo=1) AS lotes,
        -- LO QUE MIRA EL QUE RECIBE: cantidades. La pantalla de Ingresos no
        -- muestra plata, así que estos son los números con los que trabaja.
        (SELECT COALESCE(SUM(l.bultos),0) FROM sg_lotes l
          WHERE l.recepcion_id=r.id AND l.activo=1) AS bultos,
        (SELECT COALESCE(SUM(l.kg_reales),0) FROM sg_lotes l
          WHERE l.recepcion_id=r.id AND l.activo=1) AS kg,
        (SELECT GROUP_CONCAT(x.nombre, ' · ') FROM (
           SELECT DISTINCT pr.nombre AS nombre FROM sg_lotes l
             JOIN sg_productos pr ON pr.id=l.producto_id
            WHERE l.recepcion_id=r.id AND l.activo=1 ORDER BY pr.nombre) x) AS productos
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
// Sale con requireAuth, no con requireAdmin. Entró un camión sin orden a las
// cinco de la mañana: el que lo recibe tiene que poder anotarlo. Con requireAdmin
// había que despertar al dueño o dejar la mercadería sin registrar, que es lo que
// de verdad pasaba. El nivel lo decide exigirNivel mirando la dirección.
router.post('/compra-retroactiva', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: 'Sin items' });
    // ── SIN PROVEEDOR NO HAY PARTIDA ──────────────────────────────────────
    // El número de partida se arma con el proveedor y la fecha
    // (0034.12.08.2026.03). Sin proveedor salía 0000.12.08.2026.03: una partida
    // de nadie, que después no se puede facturar, ni liquidar, ni reclamar. La
    // pantalla ya lo pedía; el servidor lo aceptaba igual, y por ahí entraba
    // cualquier llamada que no fuera la pantalla.
    const provRow = b.proveedor_id
      ? db.prepare('SELECT id, razon_social FROM sg_proveedores WHERE id=? AND activo=1').get(b.proveedor_id)
      : null;
    if (!provRow) {
      return res.status(400).json({ ok: false,
        error: 'Decí de qué proveedor es la mercadería: el número de partida se arma con el proveedor '
             + 'y la fecha, y sin eso la descarga no se puede rastrear.' });
    }
    const dft = defaultsProveedor(db, b.proveedor_id, b);
    const { documenta, tipoPrecio, tipoFiscal } = circuitoDeCompra(b, dft.tipo_fiscal);
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
         comercial_id, estado, observaciones, total_estimado_kg, total_estimado_monto, creado_por, trazabilidad, documenta)
        VALUES (?, 'retroactiva', ?,?,?,?,?,?,?, 'recibida_total', ?, 0, 0, ?, ?, ?)`).run(
        numeroOC, b.proveedor_id || null, tipoFiscal, tipoPrecio, dft.condicion_pago_id,
        fechaIngreso, fechaIngreso, b.comercial_id || null, val(b.observaciones), uid(req), trazaRetro, documenta);
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
        crearLotesDeItem(db, { recepcionId: recId, ocItem, tipoPrecio, fechaIngreso, lotes, userId: uid(req), req });
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
    // TAMBIÉN LOS QUE ENTRARON POR UNA RECEPCIÓN DE ESTA ORDEN sin quedar
    // colgados de un ítem. Pasa cuando se vincula después una recepción que
    // llegó suelta: el lote existe, tiene su costo y su stock, pero su
    // oc_item_id quedó en NULL y no entraba por el filtro de ítems. La ficha de
    // la orden mostraba esa mercadería como si no hubiera entrado nunca.
    if (req.query.oc_id) {
      where.push('(l.oc_item_id IN (SELECT id FROM sg_oc_items WHERE oc_id=?) OR r.oc_id = ?)');
      params.push(req.query.oc_id, req.query.oc_id);
    }
    if (req.query.sin_precio === '1') where.push('l.precio_unitario_kg IS NULL');
    // STOCK ES LO QUE HAY. Pablo: "la lista debería mostrar sólo lo que hay en
    // stock, no agregaría «agotados»: que directamente se vaya a consultar la
    // partida". Una partida en cero ocupa un renglón y no se puede vender; para
    // rastrearla se entra por su código, que es lo que uno tiene en la mano.
    //
    // Va como parámetro y no por defecto: /lotes lo usan también la ficha de la
    // orden y el selector de gastos, donde una partida agotada SÍ tiene que
    // aparecer —ahí la pregunta es qué entró, no qué queda—.
    if (req.query.con_stock === '1') where.push(`${KG_DISPONIBLE} > 0.01`);
    // Filtrar el stock por piso: "qué tengo arriba" es una pregunta del stock,
    // no de otra pantalla. El valor 'sin' trae lo que todavía no se ubicó, que
    // es justamente lo que hay que ir a acomodar.
    if (req.query.piso_id === 'sin') {
      where.push(`NOT EXISTS (SELECT 1 FROM sg_lote_ubicaciones u WHERE u.lote_id = l.id
        AND (u.bultos > 0.001 OR u.kg > 0.01))`);
    } else if (Number(req.query.piso_id) > 0) {
      where.push(`EXISTS (SELECT 1 FROM sg_lote_ubicaciones u WHERE u.lote_id = l.id
        AND u.piso_id = ? AND (u.bultos > 0.001 OR u.kg > 0.01))`);
      params.push(Number(req.query.piso_id));
    }
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
        ${KG_DISPONIBLE} AS kg_disponibles,    -- disponibles = vigentes − despachado
        -- ── DÓNDE ESTÁ ────────────────────────────────────────────────────
        -- El piso no es otra pantalla: es un dato de la partida, como su
        -- vencimiento o su calidad. Preguntarle al stock qué hay y tener que ir
        -- a otro lado a preguntar dónde está es partir en dos la misma respuesta.
        --
        -- Una partida repartida devuelve los dos lugares: "Piso 1 (60) · Piso 2 (40)".
        (SELECT GROUP_CONCAT(p.nombre || ' (' || CAST(ROUND(u.bultos) AS INTEGER) || ')', ' · ')
           FROM sg_lote_ubicaciones u JOIN sg_pisos p ON p.id = u.piso_id
          WHERE u.lote_id = l.id AND (u.bultos > 0.001 OR u.kg > 0.01)) AS pisos,
        (SELECT COUNT(*) FROM sg_lote_ubicaciones u
          WHERE u.lote_id = l.id AND (u.bultos > 0.001 OR u.kg > 0.01)) AS n_pisos
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
// Cerrar el precio de un lote de pizarra es el trabajo de todos los días de
// quien liquida: operar.
router.post('/lotes/:id/cerrar-precio', requireAuth, (req, res) => {
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

router.delete('/gastos-directos/:id', requireAuth, (req, res) => {
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

router.delete('/gastos-globales/:id', requireAuth, (req, res) => {
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
// CORREGIR lo que se cargó mal es operar. Los frenos de verdad no son el rol:
// no se corrige una partida ya contabilizada —primero se anula el asiento— ni
// una de la que ya se despachó mercadería, y eso lo controla el servidor abajo.
router.put('/lotes/:id', requireAuth, (req, res) => {
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
// ── QUÉ LE PASÓ A ESTA PARTIDA ───────────────────────────────────
//
// Pablo: "de los que están en stock, haciendo click en el detalle, mostrá las
// variaciones de stock que tuvimos —altas y bajas de esa partida—: ingresaron 10,
// salieron 2 en la factura tal, 3 en la factura tal, 1 merma, el resto stock".
//
// Hasta ahora la ficha decía "quedan 310 kg" y no había cómo verificarlo: mostraba
// los despachos donde se usó y nada más —ni cuánto entró, ni las mermas, ni si
// los números cerraban—. Un saldo que no se puede recorrer no se puede discutir,
// que es lo mismo que ya se había arreglado en la cuenta corriente.
//
// LAS BAJAS SON CUATRO Y SÓLO CUATRO. Salen de las MISMAS tablas que la fórmula
// del stock (SUM_DESPACHADO, SUM_DECOMISO, SUM_TRANSF), así que el saldo de este
// listado y el kg disponible de la pantalla son el mismo número por construcción:
// si alguien cambia la fórmula y no toca esto, el test lo cachetea.
router.get('/lotes/:id/movimientos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const id = Number(req.params.id);
    const lote = db.prepare(`SELECT l.id, l.codigo_lote, l.kg_reales, l.fecha_ingreso,
        l.kg_por_bulto, l.bultos, pr.nombre AS producto_nombre,
        r.numero_recepcion, pv.razon_social AS proveedor_nombre, o.numero AS oc_numero
      FROM sg_lotes l
      LEFT JOIN sg_productos pr ON pr.id = l.producto_id
      LEFT JOIN sg_recepciones r ON r.id = l.recepcion_id
      LEFT JOIN sg_oc o ON o.id = r.oc_id
      LEFT JOIN sg_proveedores pv ON pv.id = o.proveedor_id
      WHERE l.id = ?`).get(id);
    if (!lote) return res.status(404).json({ ok: false, error: 'Partida inexistente' });

    const movs = [];
    // EL ALTA. Una sola: la partida entra con lo que se recibió.
    movs.push({ tipo: 'alta', fecha: lote.fecha_ingreso, kg: Number(lote.kg_reales) || 0,
      detalle: 'Ingreso' + (lote.proveedor_nombre ? ' — ' + lote.proveedor_nombre : ''),
      ref: lote.numero_recepcion || lote.oc_numero || null });

    // LAS SALIDAS AL CLIENTE. Se nombra el COMPROBANTE si ya se facturó, porque
    // es por lo que el cliente reclama; si todavía no, el remito, que es lo único
    // que hay. Decir siempre el remito obligaba a cruzarlo a mano.
    for (const d of db.prepare(`
      SELECT di.id, di.kg_despachados AS kg, di.bultos, d.numero AS remito, d.fecha_despacho AS fecha,
        c.razon_social AS cliente,
        (SELECT f.punto_venta || '-' || f.cbte_nro FROM sg_factura_despachos fd
           JOIN sg_ven_facturas f ON f.id = fd.factura_id
          WHERE fd.despacho_item_id = di.id AND ${facturaCuenta('f')}
            AND f.punto_venta IS NOT NULL AND f.cbte_nro IS NOT NULL
          ORDER BY f.id LIMIT 1) AS comprobante
        FROM sg_despacho_items di
        JOIN sg_despachos d ON d.id = di.despacho_id AND d.activo = 1
        LEFT JOIN sg_clientes c ON c.id = d.cliente_id
       WHERE di.lote_id = ? ORDER BY d.fecha_despacho, di.id`).all(id)) {
      const nro = d.comprobante
        ? d.comprobante.split('-').map((x, i) => String(x).padStart(i ? 8 : 4, '0')).join('-')
        : null;
      movs.push({ tipo: 'salida', fecha: d.fecha, kg: -(Number(d.kg) || 0), bultos: d.bultos,
        detalle: (nro ? 'Facturado' : 'Entregado sin facturar')
               + (d.cliente ? ' — ' + d.cliente : ''),
        ref: nro || d.remito });
    }

    // LA MERMA. Lo que se tiró, con su motivo: sin el motivo es un número que no
    // se le puede reclamar a nadie.
    for (const x of db.prepare(`SELECT kg, bultos, motivo, fecha FROM sg_lote_decomisos
       WHERE lote_id = ? ORDER BY fecha, id`).all(id)) {
      movs.push({ tipo: 'merma', fecha: x.fecha, kg: -(Number(x.kg) || 0), bultos: x.bultos,
        detalle: 'Merma' + (x.motivo ? ' — ' + x.motivo : ''), ref: null });
    }

    // LO QUE SE FUE A OTRA PARTIDA. Baja acá y alta allá: sin esta línea el kg
    // aparece como perdido cuando en realidad se mudó.
    for (const x of db.prepare(`SELECT t.kg_transformados AS kg, t.bultos_transformados AS bultos,
        t.fecha, ld.codigo_lote AS destino
        FROM sg_transformaciones t
        LEFT JOIN sg_lotes ld ON ld.id = t.lote_destino_id
       WHERE t.lote_origen_id = ? ORDER BY t.fecha, t.id`).all(id)) {
      movs.push({ tipo: 'transformacion', fecha: x.fecha, kg: -(Number(x.kg) || 0), bultos: x.bultos,
        detalle: 'Pasó a otra partida', ref: x.destino });
    }
    for (const x of db.prepare(`SELECT kg_procesados AS kg, bultos_procesados AS bultos, kg_merma, fecha
        FROM sg_reprocesos WHERE lote_madre_id = ? AND estado = 'activo' ORDER BY fecha, id`).all(id)) {
      movs.push({ tipo: 'reproceso', fecha: x.fecha, kg: -(Number(x.kg) || 0), bultos: x.bultos,
        detalle: 'Reprocesado' + (Number(x.kg_merma) ? ' (merma en el proceso: '
                 + (Math.round(Number(x.kg_merma) * 100) / 100) + ' kg)' : ''), ref: null });
    }

    // Por fecha, y el alta siempre primero: nada puede salir antes de entrar.
    movs.sort((a, b) => (a.tipo === 'alta' ? -1 : b.tipo === 'alta' ? 1
      : String(a.fecha || '').localeCompare(String(b.fecha || ''))));
    let saldo = 0;
    for (const m of movs) { saldo = Math.round((saldo + m.kg) * 100) / 100; m.saldo = saldo; }

    // EL CONTROL. Este saldo tiene que dar lo MISMO que el kg disponible de la
    // pantalla de stock —sale de las mismas tablas—. Si alguna vez no da, es que
    // hay una baja que este listado no conoce, y eso se dice en vez de callarse:
    // un listado que no cierra y no avisa es peor que no tenerlo.
    const disp = db.prepare(`SELECT ${KG_DISPONIBLE} AS kg FROM sg_lotes l WHERE l.id=?`).get(id);
    const kgDisp = Math.round((Number(disp && disp.kg) || 0) * 100) / 100;
    res.json({ ok: true, lote, movimientos: movs, saldo,
      kg_disponibles: kgDisp, cierra: Math.abs(saldo - kgDisp) < 0.01 });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
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
router.post('/lotes/:id/baja', requireAuth, (req, res) => {
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
      // Lo decomisado deja de estar en el piso. Si no se descontara, el que va a
      // buscarlo encontraría vacío un lugar que la pantalla dice lleno.
      // Los bultos se derivan de los kilos con el factor del lote: el decomiso
      // se carga en kilos y la ubicación lleva las dos unidades.
      descontarDeUbicacion(db, lote.id, bultosDecomisados(db, lote.id, kg), kg, null);
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

router.post('/pedidos/:id/anular', requireAuth, (req, res) => {
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
// Lo que los REMITOS ya comprometieron de una partida que viene en viaje. Va
// como fragmento SQL para que lo usen /oferta y /disponibilidad con la misma
// cuenta: si cada uno la escribiera aparte, tarde o temprano dicen distinto.
//
// Sólo cuenta el remito VIVO (d.activo=1) y la línea que todavía no aterrizó
// (lote_recibido_id IS NULL): una vez que la mercadería entró, lo que descuenta
// es el lote real y no la promesa.
const KG_COMPROMETIDO_CAMINO = `COALESCE((SELECT SUM(di.kg_despachados)
  FROM sg_despacho_items di JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
  WHERE di.oc_item_id=i.id AND di.origen='oc_item' AND di.lote_recibido_id IS NULL),0)`;
const BULTOS_COMPROMETIDO_CAMINO = `COALESCE((SELECT SUM(di.bultos)
  FROM sg_despacho_items di JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
  WHERE di.oc_item_id=i.id AND di.origen='oc_item' AND di.lote_recibido_id IS NULL),0)`;

router.get('/oferta', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const pid = req.query.producto_id;
    if (!pid) return res.status(400).json({ ok: false, error: 'Falta producto_id' });
    const stock = db.prepare(`
      SELECT * FROM (
        SELECT l.id AS lote_id, l.codigo_lote, l.producto_id, pr.nombre AS producto_nombre, l.calidad, l.semaforo,
          fam.iva_alicuota,
          -- DE QUIÉN ES ESTA MERCADERÍA, Y QUÉ SE LE ACORDÓ. El descuento comercial
          -- es del PROVEEDOR, así que una factura con mercadería de tres lleva los
          -- tres descuentos, cada línea con el suyo. Viaja con el lote para que la
          -- pantalla no tenga que ir a buscarlo de a uno.
          o.proveedor_id, prov.razon_social AS proveedor_nombre,
          prov.descuento_pct AS proveedor_descuento_pct,
          l.costo_final, l.fecha_vencimiento_estimada, l.presentacion_id, COALESCE(l.kg_por_bulto, ps.factor_conversion) AS kg_por_bulto,
          ${KG_VIGENTE_STOCK} AS kg_vigente,
          CAST(julianday(l.fecha_vencimiento_estimada) - julianday(date('now','localtime')) AS INTEGER) AS dias_restantes,
          ${KG_DISPONIBLE} AS kg_disponibles,
          COALESCE((SELECT SUM(kg) FROM sg_reservas WHERE lote_id=l.id AND estado IN ('activa','concretada')),0) AS kg_reservado,
          COALESCE((SELECT SUM(bultos) FROM sg_reservas WHERE lote_id=l.id AND estado IN ('activa','concretada')),0) AS bultos_reservado
        FROM sg_lotes l LEFT JOIN sg_productos pr ON pr.id=l.producto_id
        LEFT JOIN sg_familias fam ON fam.id=pr.familia_id
        LEFT JOIN sg_recepciones rec ON rec.id = l.recepcion_id
        LEFT JOIN sg_oc o ON o.id = rec.oc_id
        LEFT JOIN sg_proveedores prov ON prov.id = o.proveedor_id
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
          ${BULTOS_COMPROMETIDO_CAMINO} AS bultos_comprometido_camino,
          ${KG_COMPROMETIDO_CAMINO} AS kg_comprometido_camino,
          ( i.kg_estimados
            - COALESCE((SELECT SUM(kg_reales) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1),0)
            - COALESCE((SELECT SUM(kg) FROM sg_reservas WHERE oc_item_id=i.id AND tipo='oc_item' AND estado='activa'),0)
            - ${KG_COMPROMETIDO_CAMINO}
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
        ? (Number(r.bultos_estimados || 0) - Number(r.bultos_recibidos || 0)
           - Number(r.bultos_reservado_camino || 0) - Number(r.bultos_comprometido_camino || 0))
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
            - ${KG_COMPROMETIDO_CAMINO}
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

// EL REMITO — le asigna mercadería a un cliente.
//
// Sale con requireAuth, no con requireAdmin. Hacer un remito es EL TRABAJO DEL
// DÍA: lo hace el que carga el camión. Con requireAdmin lo tenía que cargar el
// dueño, y el que hace el trabajo terminaba dictándoselo por teléfono. El nivel
// lo decide exigirNivel mirando la dirección, como en todo el resto.
const postRemito = (req, res) => {
  const db = getDb();
  try {
    const b = req.body;
    const items = Array.isArray(b.items) ? b.items : [];
    if (!b.cliente_id) return res.status(400).json({ ok: false, error: 'Falta cliente' });
    if (!items.length) return res.status(400).json({ ok: false, error: 'El remito necesita al menos un item' });

    // F3-B — el despacho mueve BULTOS ENTEROS (cajón indivisible). La cantidad operativa por línea
    // es bultos; kg_despachados se DERIVA = bultos × kg_por_bulto nominal (factor_conversion de la
    // presentación del lote). Se rechaza fracción de cajón y se valida contra bultosDisponibles
    // (helper F3-A). NO se acepta kg libre: si el front manda kg, se deriva el bulto y debe ser entero.
    const pedidoLote = {};   // Σ bultos por lote
    const pedidoCamino = {}; // Σ bultos por partida EN VIAJE
    const lineas = [];       // {it, origen, loteId, ocItemId, bultos, kgPorBulto, kg}

    // ── LO QUE VIENE EN VIAJE ────────────────────────────────────────────
    // El comprador cerró la carga, el camión está en la ruta, y el cliente
    // quiere la mercadería anotada a su nombre. Hasta ahora eso no se podía
    // escribir en ningún lado: la línea del remito exigía un lote, y el lote no
    // existe hasta que se recibe. El único registro era la memoria del que lo
    // prometió.
    for (const it of items) {
      if (String(it.origen || '') !== 'oc_item') continue;
      const ocItemId = Number(it.oc_item_id);
      if (!ocItemId) return res.status(400).json({ ok: false, error: 'Falta la partida en viaje de una línea' });
      const oi = db.prepare(`SELECT i.*, o.numero AS oc_numero, o.estado AS oc_estado, o.activo AS oc_activo,
          COALESCE(i.kg_por_bulto, ps.factor_conversion) AS kpb
        FROM sg_oc_items i JOIN sg_oc o ON o.id=i.oc_id
        LEFT JOIN sg_presentaciones ps ON ps.id=i.presentacion_id WHERE i.id=?`).get(ocItemId);
      if (!oi) return res.status(400).json({ ok: false, error: 'Partida en viaje inexistente: ' + ocItemId });
      if (!oi.oc_activo || !['abierta', 'recibida_parcial'].includes(String(oi.oc_estado))) {
        return res.status(400).json({ ok: false,
          error: `La orden ${oi.oc_numero} está ${oi.oc_estado}: ya no hay nada en viaje que asignar.` });
      }
      const kpb = (Number(oi.kpb) > 0) ? Number(oi.kpb) : null;
      if (kpb == null) {
        return res.status(400).json({ ok: false,
          error: `La partida de ${oi.oc_numero} no tiene kg por bulto cargados: no se puede asignar por cajón.` });
      }
      let bultos;
      if (it.bultos != null && it.bultos !== '') bultos = Number(it.bultos);
      else if (it.kg_despachados != null && it.kg_despachados !== '') bultos = Number(it.kg_despachados) / kpb;
      else return res.status(400).json({ ok: false, error: `${oi.oc_numero}: falta la cantidad de bultos` });
      if (!(bultos > 0)) return res.status(400).json({ ok: false, error: `${oi.oc_numero}: la cantidad debe ser > 0` });
      if (Math.abs(bultos - Math.round(bultos)) > 1e-6) {
        return res.status(400).json({ ok: false,
          error: `${oi.oc_numero}: se asigna por cajón entero, no se admiten fracciones (${+bultos.toFixed(3)})` });
      }
      bultos = Math.round(bultos);
      pedidoCamino[ocItemId] = (pedidoCamino[ocItemId] || 0) + bultos;
      lineas.push({ it, origen: 'oc_item', ocItemId, bultos, kgPorBulto: kpb,
        kg: +(bultos * kpb).toFixed(4), presentacionId: oi.presentacion_id, envaseId: oi.envase_id,
        productoId: oi.producto_id, costoKg: (Number(oi.precio_estimado_por_kg) > 0
          ? Number(oi.precio_estimado_por_kg) : null) });
    }

    // NO SE PROMETE DOS VECES LA MISMA CARGA. Sin esta cuenta, el segundo remito
    // ve el camión entero libre porque el primero no descontó nada, y el día que
    // baja la mercadería falta para uno de los dos.
    for (const ocItemId of Object.keys(pedidoCamino)) {
      const d = db.prepare(`SELECT i.id, o.numero AS oc_numero,
          COALESCE(i.cantidad_estimada_presentaciones,0) AS bultos_est,
          COALESCE((SELECT SUM(bultos) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1),0) AS recibidos,
          COALESCE((SELECT SUM(bultos) FROM sg_reservas WHERE oc_item_id=i.id AND tipo='oc_item' AND estado='activa'),0) AS reservados,
          COALESCE((SELECT SUM(di.bultos) FROM sg_despacho_items di
             JOIN sg_despachos d2 ON d2.id=di.despacho_id AND d2.activo=1
            WHERE di.oc_item_id=i.id AND di.origen='oc_item' AND di.lote_recibido_id IS NULL),0) AS comprometidos
        FROM sg_oc_items i JOIN sg_oc o ON o.id=i.oc_id WHERE i.id=?`).get(ocItemId);
      const libre = Number(d.bultos_est) - Number(d.recibidos) - Number(d.reservados) - Number(d.comprometidos);
      if (pedidoCamino[ocItemId] > libre) {
        return res.status(400).json({ ok: false,
          error: `${d.oc_numero}: pedís ${pedidoCamino[ocItemId]} cajón(es) en viaje y quedan ${libre}. `
               + `Lo que ya está prometido en otro remito no se puede prometer de nuevo.` });
      }
    }

    for (const it of items) {
      if (String(it.origen || '') === 'oc_item') continue;
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
      lineas.push({ it, origen: 'lote', loteId, bultos, kgPorBulto, kg,
        presentacionId: lp.presentacion_id, envaseId: lp.envase_id });
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
      // sin_remito: la salida existe igual —descuenta stock, guarda la
      // trazabilidad— pero no se emite el remito como documento, porque el papel
      // que viaja con la mercadería es la factura. Ver A2b en db_sg.js.
      const info = db.prepare(`INSERT INTO sg_despachos
        (numero, pedido_id, cliente_id, comercial_id, fecha_despacho, transporte, transportista, chofer, dominio, fletero_id, estado, observaciones, sin_remito, creado_por)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        numero, b.pedido_id || null, b.cliente_id, b.comercial_id || null, val(b.fecha_despacho),
        val(b.transporte), val(b.transportista), val(b.chofer), val(b.dominio), fleteroId,
        val(b.estado) || 'despachado', val(b.observaciones), b.sin_remito ? 1 : 0, uid(req));
      const despachoId = info.lastInsertRowid;
      // PARTE B — si se asignó fletero, queda un gasto de flete de salida PENDIENTE de valorizar.
      syncGastoFleteDespacho(db, despachoId, fleteroId, val(b.fecha_despacho), uid(req));
      // precio_lista_por_kg: el precio ANTES del descuento acordado con el
      // proveedor de esa partida. Sin él, lo resignado sólo existe como un total
      // de la factura y no se puede decir cuánto resignó CADA partida — que es
      // justo lo que hay que liquidarle a cada productor.
      const ins = db.prepare(`INSERT INTO sg_despacho_items
        (despacho_id, origen, lote_id, oc_item_id, producto_id, presentacion_id, envase_id, kg_por_bulto,
         cantidad_presentaciones, bultos, kg_despachados, precio_por_kg, precio_lista_por_kg,
         nota_precio, subtotal, margen_estimado, piso_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const lotesAfectados = new Set();
      let totalBultos = 0;   // FASE 2 — bultos del despacho (para la carga de la cooperativa)
      for (const ln of lineas) {
        const it = ln.it;
        const kg = ln.kg;                       // DERIVADO = bultos × kg_por_bulto
        const bultos = ln.bultos;
        const precio = Number(it.precio_por_kg || 0);
        const subtotal = kg * precio;
        let productoId = ln.productoId || null;
        let costoPorKg = null;
        if (ln.origen === 'lote') {
          const lote = db.prepare('SELECT producto_id, costo_final, kg_reales FROM sg_lotes WHERE id=?').get(ln.loteId);
          productoId = lote.producto_id;
          // costo_final del lote es el costo TOTAL → costo/kg sobre kg VIGENTES (kg_reales − decomiso
          // − transformado), así la merma revalúa lo despachado. (mismo cálculo que el front del modal.)
          const kgVig = (lote.kg_reales || 0) - kgDecomisado(db, ln.loteId) - kgTransformado(db, ln.loteId);
          costoPorKg = kgVig > 0 ? (lote.costo_final || 0) / kgVig : 0;
        } else {
          // EN VIAJE NO SIEMPRE HAY COSTO. Si la compra es a pizarra, el precio
          // se cierra después: todavía no se sabe cuánto costó. El margen queda
          // en NULL y no en cero — con costo cero el margen daría el total de la
          // venta, que es la mentira más cara de las dos.
          costoPorKg = ln.costoKg;              // null si la orden no tiene precio estimado
        }
        const margen = (costoPorKg == null) ? null : (subtotal - kg * costoPorKg);
        // bultos va tanto a la columna F3-A (sg_despacho_items.bultos, que lee bultosDisponibles)
        // como a cantidad_presentaciones (compat). presentacion_id se toma de la línea o del lote.
        const presId = it.presentacion_id != null ? it.presentacion_id : (ln.presentacionId || null);
        // F3 — snapshot inmutable del factor+envase usados en este despacho (no se re-lee del lote).
        // DE QUE PISO SALE. Si el que arma el remito lo dijo, sale de ahi y solo
        // de ahi. Si no, sale por orden de piso hasta completar — determinístico,
        // asi que dos personas obtienen el mismo resultado.
        //
        // Sin esto la apertura por piso se despegaria de la realidad apenas se
        // despacha algo: el total seguiria bien y el desglose mentiria.
        const pisoLinea = (it.piso_id != null && it.piso_id !== '') ? Number(it.piso_id) : null;
        // El de lista sólo se guarda si de verdad hay descuento: escribir el
        // mismo número dos veces cuando no lo hay hace creer que hubo acuerdo.
        const pLista = (it.precio_lista_por_kg != null && it.precio_lista_por_kg !== ''
                        && Number(it.precio_lista_por_kg) > Number(precio))
          ? Number(it.precio_lista_por_kg) : null;
        ins.run(despachoId, ln.origen, ln.loteId || null, ln.ocItemId || null, productoId, presId,
          (ln.envaseId != null ? ln.envaseId : null), (ln.kgPorBulto != null ? ln.kgPorBulto : null),
          bultos, bultos, kg, precio, pLista,
          (String(it.nota_precio || '').trim() || null), subtotal, margen,
          ln.origen === 'lote' ? pisoLinea : null);
        if (ln.origen === 'lote') {
          // SACAR DEL PISO DE OTRO TAMPOCO. Si sólo se controlara recibir, se
          // podría vaciar el piso ajeno armando un remito. Cuando la línea no
          // dice de qué piso sale, descontarDeUbicacion reparte por orden de
          // piso y no hay un dueño a quien preguntarle: eso queda como está.
          if (pisoLinea) {
            const no = exigirPiso(db, req, pisoLinea, 'sacar mercadería');
            if (no) throw new Error(no);
          }
          const rUb = descontarDeUbicacion(db, ln.loteId, bultos, kg, pisoLinea);
          if (!rUb.ok) throw new Error(rUb.error);
        }
        totalBultos += bultos;
        if (ln.origen === 'lote') lotesAfectados.add(ln.loteId);
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
};
router.post('/despachos', requireAuth, postRemito);

// Llamar al remito desde adentro, sin dar una vuelta por HTTP. El handler es
// SÍNCRONO —arma todo y cierra con res.json— así que alcanza con darle un `res`
// de mentira que anote lo que contestó.
//
// Se reusa el handler entero a propósito: la facturación directa tiene que
// validar el stock, derivar los kg de los cajones, mover el lote y dejar el
// gasto de flete EXACTAMENTE igual que un remito hecho a mano. Una segunda copia
// de esas reglas es una segunda copia que se olvida de actualizar.
function crearRemitoInterno(req, body) {
  let salida = null;
  const fakeRes = {
    _st: 200,
    status(c) { this._st = c; return this; },
    json(o) { salida = { status: this._st, body: o }; return this; },
  };
  const fakeReq = Object.create(req);   // conserva cookies, _user y todo lo demás
  fakeReq.body = body;
  postRemito(fakeReq, fakeRes);
  return salida || { status: 500, body: { ok: false, error: 'El remito no contestó' } };
}

router.get('/despachos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['d.activo=1'], params = [];
    if (req.query.cliente_id) { where.push('d.cliente_id=?'); params.push(req.query.cliente_id); }
    if (req.query.estado) { where.push('d.estado=?'); params.push(req.query.estado); }
    // LA PANTALLA DE REMITOS MUESTRA REMITOS. Una venta directa deja una salida
    // —descuenta stock, guarda de qué partida salió— pero su documento es la
    // factura: listarla acá es un renglón más por cada venta, con un número que
    // nadie va a citar nunca. Pablo: "si no vamos a llenar el sistema de info
    // que no vale la pena".
    //
    // El dato no se pierde: la salida sigue existiendo, y si AFIP rechazó la
    // factura aparece en «Remitos pendientes de comprobante», que es de dónde
    // hay que sacarla.
    if (req.query.solo_remitos) where.push('COALESCE(d.sin_remito,0)=0');
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

router.post('/despachos/:id/anular', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const d = db.prepare('SELECT id FROM sg_despachos WHERE id=? AND activo=1').get(req.params.id);
    if (!d) return res.status(404).json({ ok: false, error: 'No encontrado o ya anulado' });
    const tx = db.transaction(() => {
      // IS NOT NULL: los renglones de mercaderia EN VIAJE no tienen lote todavia,
      // y recalcEstadoLote(null) reventaria. Lo que esos renglones reservaban del
      // camion se libera solo, porque la cuenta mira d.activo=1.
      // ANULAR DEVUELVE LA MERCADERIA A SU PISO. El stock vuelve —eso ya lo hacia
      // el activo=0— pero si no vuelve tambien al piso, la partida figura
      // disponible sin estar en ningun lado, y la suma de los pisos deja de dar
      // lo disponible. Vuelve al piso del que salio; si no se habia anotado
      // cual, al primero que tenga esa partida.
      for (const li of db.prepare(`SELECT lote_id, bultos, kg_despachados, piso_id
          FROM sg_despacho_items WHERE despacho_id=? AND lote_id IS NOT NULL`).all(req.params.id)) {
        let piso = li.piso_id;
        if (!piso) {
          const u = ubicacionesDeLote(db, li.lote_id)[0];
          piso = u ? u.piso_id : null;
        }
        if (piso) ubicMover(db, li.lote_id, piso, Number(li.bultos) || 0, Number(li.kg_despachados) || 0);
      }
      const lotes = db.prepare(`SELECT DISTINCT lote_id FROM sg_despacho_items
        WHERE despacho_id=? AND lote_id IS NOT NULL`).all(req.params.id).map(r => r.lote_id);
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
router.delete('/cooperativas/:id', requireAuth, (req, res) => {
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


// ══════════════════════════════════════════════════════════════════════════
// FLETES DE ENTRADA
// ══════════════════════════════════════════════════════════════════════════
// El comprador anota en la orden lo que va a costar traer la mercadería —tantos
// bultos a tanto, o un total— y con eso cierra la compra. Después llega la
// factura del fletero a administración, y casi nunca dice exactamente eso.
//
// Hasta hoy ese número quedaba en la orden y NO llegaba a ningún lado: no era un
// gasto directo, no entraba al costo del lote, y la factura del fletero no
// tenía contra qué compararse. Acá se PISA lo que estimó el comprador con lo que
// dice la factura, y recién ese número es el que va al costo.

// EL FLETE SE PAGA POR VIAJE, Y LOS BULTOS DEL VIAJE LOS SABE LA RECEPCIÓN.
//
// En la orden el comprador pacta el PRECIO POR BULTO; la cantidad que escribía
// ahí era una estimación —los bultos que pensaba pedir— y con esa estimación se
// valorizaba el flete. Si bajaron cien bultos de más, al fletero se le paga por
// cien más y el costo de la partida quedaba con el flete de lo que se suponía.
// Y como el flete de entrada se reparte por kilo entre los lotes, ese error no
// se queda quieto: se propaga al margen de todo lo que se venda de esa partida.
//
// Ahora la cantidad sale de los bultos REALES de esa recepción.
//
// Las otras dos modalidades no tienen un dato real que las reemplace —nadie
// cuenta pallets al recibir, y un monto total es de la orden entera—, así que se
// PRORRATEAN por bultos entre los viajes. Con un solo viaje da lo mismo de
// antes; con dos, cada uno se lleva la parte que trajo.
function fleteDeViaje(oc, viaje, pesoOrden) {
  const NADA = { monto: 0, base: '', prorrateado: 0 };
  if (!oc) return NADA;
  const bv = Number(viaje.bultos || 0);
  const pu = Number(oc.flete_precio_unit || 0);

  // Lo que pidió Pablo: por bulto, con los bultos que bajaron de ESTE camión.
  //
  // SALVO que esta recepción no tenga los bultos cargados. Eso pasa con las
  // viejas, de antes de que se pidiera el dato. Ahí no hay con qué hacer la
  // cuenta, y poner cero —o contar los lotes, que era lo de antes— sería
  // inventar un número más creíble que un vacío. Se cae a lo pactado en la
  // orden y la pantalla lo dice.
  if (oc.flete_modalidad === 'bulto' && pu > 0 && bv > 0) {
    return { monto: r2(bv * pu), prorrateado: 0,
      base: 'los bultos de este viaje por el precio pactado en la orden' };
  }
  const sinBultos = (oc.flete_modalidad === 'bulto' && pu > 0 && bv === 0);
  // El reparto entre viajes se hace por bultos; si no hay, por kilos, que
  // siempre están. Sin eso, dos viajes se llevarían el monto entero cada uno.
  const parte = (pesoOrden > 0) ? (pesoDeViaje(viaje) / pesoOrden) : 1;
  const repartido = parte < 1 ? 1 : 0;
  if (sinBultos) {
    const cant = Number(oc.flete_cantidad || 0);
    const monto = (cant > 0) ? cant * pu : Number(oc.flete_monto || 0);
    if (!(monto > 0)) return NADA;
    return { monto: r2(monto * parte), prorrateado: repartido,
      base: 'esta recepción no tiene los bultos cargados: se usa lo estimado en la orden' };
  }
  if (oc.flete_monto != null && oc.flete_monto > 0) {
    return { monto: r2(Number(oc.flete_monto) * parte), prorrateado: repartido,
      base: repartido ? 'la parte de este viaje del monto pactado en la orden'
                      : 'el monto pactado en la orden' };
  }
  const cant = Number(oc.flete_cantidad || 0);
  if (cant > 0 && pu > 0) {
    return { monto: r2(cant * pu * parte), prorrateado: repartido,
      base: repartido ? 'la parte de este viaje de lo pactado en la orden'
                      : 'lo pactado en la orden' };
  }
  return NADA;
}
// Con qué se reparte entre viajes lo que se pactó por la orden entera. Bultos si
// están; si no, kilos; si no hay ninguno de los dos, cada viaje cuenta uno.
function pesoDeViaje(v) {
  return Number(v.bultos || 0) || Number(v.kg || 0) || 1;
}

router.get('/fletes-entrada', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const estado = req.query.estado === 'valorizado' ? 'valorizado' : 'pendiente_valorizar';
    // Una recepción por fila: el flete se paga por viaje, no por orden.
    const rows = db.prepare(`
      SELECT r.id AS recepcion_id, r.numero_recepcion, r.fecha_recepcion, r.oc_id,
             o.trazabilidad AS partida, o.numero AS oc_numero, o.flete_a_cargo, o.flete_pagado_por,
             o.flete_monto, o.flete_modalidad, o.flete_cantidad, o.flete_precio_unit,
             p.razon_social AS proveedor_nombre,
             (SELECT COALESCE(SUM(l.kg_reales),0) FROM sg_lotes l
               WHERE l.recepcion_id = r.id AND l.activo = 1) AS kg,
             -- BULTOS, NO LOTES. Esto era COUNT(*) y contaba lotes: una recepción
             -- que entró en 3 lotes de 40 bultos decía 3 donde eran 120. No se
             -- notaba porque el número era decorativo; ahora valoriza el flete.
             -- Sólo se suman los que tienen el dato: un lote viejo sin cargar no
             -- es "un bulto", es que no se sabe. Se cuentan aparte para poder
             -- decirlo en vez de hacer una cuenta con un número inventado.
             (SELECT COALESCE(SUM(l.bultos),0) FROM sg_lotes l
               WHERE l.recepcion_id = r.id AND l.activo = 1) AS bultos,
             (SELECT COUNT(*) FROM sg_lotes l
               WHERE l.recepcion_id = r.id AND l.activo = 1 AND l.bultos IS NULL) AS lotes_sin_bultos,
             g.id AS gasto_id, g.estado AS gasto_estado, g.monto AS gasto_monto,
             g.proveedor_servicio_id, g.cuenta_ref, g.fecha_valorizacion,
             pv.razon_social AS fletero_nombre
        FROM sg_recepciones r
        JOIN sg_oc o ON o.id = r.oc_id
        LEFT JOIN sg_proveedores p ON p.id = o.proveedor_id
        LEFT JOIN sg_gastos_directos g ON g.recepcion_id = r.id
             AND g.tipo_gasto = 'flete_entrada' AND g.activo = 1 AND g.estado <> 'anulado'
        LEFT JOIN sg_proveedores pv ON pv.id = g.proveedor_servicio_id
       -- La recepción anulada no se filtraba: seguía en la bandeja pidiendo la
       -- factura de un viaje que no existe. No molestaba mientras el estimado
       -- salía de la orden; ahora, además, se llevaría su parte del reparto.
       WHERE o.activo = 1 AND o.estado <> 'anulada' AND r.activo = 1
       ORDER BY r.fecha_recepcion DESC, r.id DESC`).all();

    // EL FLETE DEL VENDEDOR: depende de QUIÉN LO PAGÓ.
    //
    //   · lo pagó el productor      → no se muestra. Mandar a administración a
    //     buscar una factura que no existe es hacerle perder el día.
    //   · lo adelantó San Gerónimo  → SÍ se muestra: hay que pagarle al fletero
    //     y registrar su factura. Lo que cambia es que ese gasto NO es de San
    //     Gerónimo —se le descuenta al productor de su liquidación— y por eso
    //     tampoco entra al costo de la partida (ver recalcCostoLote).
    const adelantado = (x) => x.flete_a_cargo === 'vendedor' && x.flete_pagado_por === 'san_geronimo';
    // Los bultos de TODA la orden, para repartir entre viajes lo que se pactó
    // por la orden entera. Se cuenta sobre rows, que ya trae todas sus
    // recepciones: el filtro por estado es de acá para abajo.
    const pesoPorOC = {};
    for (const x of rows) pesoPorOC[x.oc_id] = (pesoPorOC[x.oc_id] || 0) + pesoDeViaje(x);
    const data = rows
      .filter((x) => x.flete_a_cargo !== 'vendedor' || adelantado(x))
      .map((x) => {
        const f = fleteDeViaje(x, x, pesoPorOC[x.oc_id] || 0);
        return { ...x, estimado: f.monto, estimado_base: f.base, prorrateado: f.prorrateado,
          viajes_de_la_orden: rows.filter((y) => y.oc_id === x.oc_id).length,
          a_recuperar: adelantado(x) };
      })
      .filter((x) => x.estimado > 0 || x.gasto_id)
      .filter((x) => (estado === 'valorizado')
        ? x.gasto_estado === 'valorizado'
        : x.gasto_estado !== 'valorizado');
    res.json({ ok: true, data, pendientes: data.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PISAR el estimado del comprador con lo que dice la factura del fletero.
// El monto que se guarda acá es el que entra al costo del lote — el de la orden
// nunca entró, y ése es justamente el agujero que esto tapa.
router.post('/fletes-entrada/:recepcionId/valorizar', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const rec = db.prepare(`SELECT r.*, o.id AS oc, o.trazabilidad, o.flete_a_cargo, o.flete_pagado_por
      FROM sg_recepciones r JOIN sg_oc o ON o.id = r.oc_id WHERE r.id=?`).get(req.params.recepcionId);
    if (!rec) return res.status(404).json({ ok: false, error: 'Recepción no encontrada' });
    // El del vendedor sólo se valoriza si lo ADELANTÓ San Gerónimo. Si lo pagó
    // el productor, no hay factura de fletero que cargar.
    if (rec.flete_a_cargo === 'vendedor' && rec.flete_pagado_por !== 'san_geronimo') {
      return res.status(400).json({ ok: false,
        error: 'Ese flete lo paga el productor: ya viene adentro del precio y no se paga aparte.' });
    }
    const monto = r2(b.monto);
    if (!(monto > 0)) return res.status(400).json({ ok: false, error: 'Poné lo que dice la factura del fletero' });
    const fletero = Number(b.proveedor_servicio_id);
    if (!fletero) return res.status(400).json({ ok: false, error: 'Elegí a qué fletero se le paga' });
    if (!db.prepare('SELECT 1 FROM sg_proveedores WHERE id=? AND activo=1').get(fletero)) {
      return res.status(400).json({ ok: false, error: 'Ese fletero no existe' });
    }

    let gastoId = null;
    db.transaction(() => {
      const ya = db.prepare(`SELECT * FROM sg_gastos_directos WHERE recepcion_id=?
        AND tipo_gasto='flete_entrada' AND activo=1 AND estado<>'anulado'`).get(rec.id);
      const fecha = val(b.fecha) || db.prepare("SELECT date('now','localtime') d").get().d;
      if (ya) {
        db.prepare(`UPDATE sg_gastos_directos SET estado='valorizado', monto=?,
          proveedor_servicio_id=?, fecha_valorizacion=?, valorizado_por=?, cuenta_ref=?,
          observaciones=COALESCE(?, observaciones) WHERE id=?`)
          .run(monto, fletero, fecha, uid(req), val(b.cuenta_ref), val(b.observaciones), ya.id);
        gastoId = ya.id;
      } else {
        gastoId = db.prepare(`INSERT INTO sg_gastos_directos
          (tipo_gasto, recepcion_id, proveedor_servicio_id, estado, monto, fecha_servicio,
           fecha_valorizacion, cuenta_ref, observaciones, creado_por, valorizado_por)
          VALUES ('flete_entrada', ?,?, 'valorizado', ?,?,?,?,?,?,?)`).run(
          rec.id, fletero, monto, rec.fecha_recepcion, fecha,
          val(b.cuenta_ref), val(b.observaciones), uid(req), uid(req)).lastInsertRowid;
      }
      // Y AHORA SÍ ENTRA AL COSTO. Se reparte por kilo entre los lotes de esa
      // recepción, igual que la descarga.
      for (const l of db.prepare('SELECT id FROM sg_lotes WHERE recepcion_id=? AND activo=1').all(rec.id)) {
        recalcCostoLote(db, Number(l.id));
      }
    })();
    res.json({ ok: true, data: { id: Number(gastoId), recepcion_id: Number(rec.id), monto } });
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
        r.numero_recepcion, oc.trazabilidad AS partida, oc.numero AS oc_numero,
        prov.razon_social AS proveedor_nombre,
        -- ── LA OPERACIÓN SE LLAMA POR LA PARTIDA ──────────────────────────
        -- Acá decía SG-REC-20260817-0001, que es el número interno de la
        -- recepción: no está en ningún papel, no lo conoce el proveedor y no
        -- sirve para cruzar nada. Lo que identifica una descarga es la PARTIDA
        -- (0034.17.08.2026.01), que es el mismo número que va en la orden, en el
        -- lote y en la factura.
        COALESCE(d.numero, oc.trazabilidad, oc.numero, r.numero_recepcion) AS operacion_ref,
        -- Una descarga no tiene cliente: tiene proveedor. La columna mostraba
        -- un guión en todas las filas de ingreso.
        COALESCE(c.razon_social, prov.razon_social) AS contraparte,
        COALESCE(d.fecha_despacho, r.fecha_recepcion, g.fecha_servicio) AS operacion_fecha,
        (SELECT COALESCE(SUM(kg_despachados),0) FROM sg_despacho_items WHERE despacho_id=d.id) AS kg,
        uv.nombre AS valorizado_por_nombre
      FROM sg_gastos_directos g
      LEFT JOIN sg_proveedores pv ON pv.id=g.proveedor_servicio_id
      LEFT JOIN sg_despachos d ON d.id=g.despacho_id
      LEFT JOIN sg_clientes c ON c.id=d.cliente_id
      LEFT JOIN sg_recepciones r ON r.id=g.recepcion_id
      LEFT JOIN sg_oc oc ON oc.id=r.oc_id
      LEFT JOIN sg_proveedores prov ON prov.id=oc.proveedor_id
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

// ── CUENTA CORRIENTE CLIENTES ──────────────────────────────────────────────────
// Decía "cobrado = 0" con un cero escrito a mano, y no era que faltara la
// consulta: era que la cobranza no existía para la contabilidad —no generaba
// asiento ni movía ninguna cuenta— así que no había nada real que restar. Con la
// cobranza cerrada, acá se lee lo que de verdad entró.
router.get('/cc-clientes', requireAuth, (req, res) => {
  const db = getDb();
  try {
    // ── LO QUE CADA CLIENTE DEBE ─────────────────────────────────────────
    //
    // Esta lista y la ficha del cliente contestaban PREGUNTAS DISTINTAS, y las
    // dos con cara de ser la respuesta:
    //
    //   · la lista sumaba REMITOS —lo despachado, al precio sugerido del
    //     remito—, así que una liquidación o una factura no la movían, y lo que
    //     se facturó de más o de menos que el remito no aparecía por ningún lado;
    //   · la ficha sumaba COMPROBANTES —liquidaciones y facturas, con su
    //     dif_gestion—, así que la mercadería entregada y todavía sin facturar
    //     no figuraba.
    //
    // Para el mismo cliente daban números distintos. Ahora las dos miran lo
    // mismo, con la MISMA forma que la cuenta corriente de proveedores, que es
    // la que ya está validada:
    //
    //     saldo de apertura
    //   + lo documentado y no cobrado        ← liquidaciones + facturas
    //   + lo entregado sin comprobante       ← remitos con kg sin facturar
    //   − lo cobrado a cuenta                ← plata que entró sin imputar
    //
    // LO DOCUMENTADO va por `total + dif_gestion`: lo que el cliente debe es lo
    // ACORDADO, no lo que dice el comprobante. Es el espejo exacto de lo que se
    // le debe a un proveedor cuando su factura vino corta.
    const rows = db.prepare(`
      SELECT c.id, c.razon_social, c.limite_credito, COALESCE(c.saldo_inicial,0) AS saldo_inicial,
        -- Documentado y sin cobrar (liquidaciones)
        COALESCE((SELECT SUM(l.neto_acreditar + COALESCE(l.dif_gestion,0)
                    - COALESCE((SELECT SUM(cd.monto) FROM sg_ven_cobranza_docs cd
                        JOIN sg_ven_cobranzas co2 ON co2.id=cd.cobranza_id
                       WHERE cd.tipo='liquidacion' AND cd.doc_id=l.id AND co2.anulada=0),0))
                    FROM sg_ven_liquidaciones l
                   WHERE l.cliente_id=c.id AND l.estado <> 'anulada'),0)
        + COALESCE((SELECT SUM(f.total + COALESCE(f.dif_gestion,0)
                    - COALESCE((SELECT SUM(cd.monto) FROM sg_ven_cobranza_docs cd
                        JOIN sg_ven_cobranzas co2 ON co2.id=cd.cobranza_id
                       WHERE cd.tipo='factura' AND cd.doc_id=f.id AND co2.anulada=0),0))
                    FROM sg_ven_facturas f
                   -- LOS DE PRUEBA SÍ SUMAN AL SALDO. Se habían dejado afuera para
                   -- que no ensuciaran la cuenta corriente, y eso rompía el motivo
                   -- de tenerlos: Pablo los va a usar para probar el circuito
                   -- ENTERO — cuenta corriente, cobranzas, imputaciones— y con el
                   -- saldo en cero no hay nada que probar.
                   --
                   -- La marca es_prueba se queda igual: sirve para reconocerlos y
                   -- borrarlos cuando las pruebas terminen. Lo que no hace es
                   -- esconderlos mientras tanto.
                   WHERE f.cliente_id=c.id AND f.estado <> 'anulada'),0) AS documentado,
        -- ── LO ENTREGADO QUE TODAVÍA NO TIENE COMPROBANTE ────────────────
        -- Los kg del remito que no se facturaron, al precio del remito. Es
        -- deuda real —la mercadería está en la casa del cliente— pero no está
        -- en el libro fiscal, así que se muestra en su propia columna.
        COALESCE((SELECT SUM((di.kg_despachados
                     - COALESCE((SELECT SUM(fd.kg) FROM sg_factura_despachos fd
                         JOIN sg_ven_facturas fv ON fv.id=fd.factura_id
                        WHERE fd.despacho_item_id=di.id
                          AND ${facturaCuenta('fv')}),0))
                   * COALESCE(di.precio_por_kg,0))
                    FROM sg_despacho_items di
                    JOIN sg_despachos d ON d.id=di.despacho_id AND d.activo=1
                   WHERE d.cliente_id=c.id AND d.estado <> 'rechazado_total'
                     AND (di.kg_despachados
                          - COALESCE((SELECT SUM(fd.kg) FROM sg_factura_despachos fd
                              JOIN sg_ven_facturas fv ON fv.id=fd.factura_id
                             WHERE fd.despacho_item_id=di.id
                               AND ${facturaCuenta('fv')}),0)) > 0.01),0)
          AS pendiente_comprobante,
        -- ── LA MITAD DE GESTIÓN, EN SU PROPIA COLUMNA ────────────────────
        -- Ya estaba SUMADA adentro de «documentado» —por eso el saldo cerraba—
        -- pero no se podía ver: la pantalla mostraba $659.999 y no había forma
        -- de saber que $150.000 de eso son descuentos acordados y no una
        -- factura. Un saldo que no se puede explicar no se puede discutir.
        COALESCE((SELECT SUM(COALESCE(l.dif_gestion,0)) FROM sg_ven_liquidaciones l
                   WHERE l.cliente_id=c.id AND l.estado <> 'anulada'),0)
        + COALESCE((SELECT SUM(COALESCE(f.dif_gestion,0)) FROM sg_ven_facturas f
                   WHERE f.cliente_id=c.id AND f.estado <> 'anulada'),0) AS gestion,
        COALESCE((SELECT SUM(co.monto) FROM sg_ven_cobranzas co
                   WHERE co.cliente_id = c.id AND co.anulada = 0), 0) AS total_cobrado,
        -- Lo cobrado que NO se imputó a ningún documento: plata que ya entró y
        -- baja el saldo aunque no haya comprobante contra el cual aplicarla.
        COALESCE((SELECT SUM(co.monto) FROM sg_ven_cobranzas co
                   WHERE co.cliente_id = c.id AND co.anulada = 0), 0)
        - COALESCE((SELECT SUM(cd.monto) FROM sg_ven_cobranza_docs cd
                     JOIN sg_ven_cobranzas co ON co.id=cd.cobranza_id
                    WHERE co.cliente_id = c.id AND co.anulada = 0
                      -- Lo imputado a un documento ANULADO vuelve a estar a
                      -- cuenta: el documento se cae, la plata no. Sin esta
                      -- condicion la cobranza desaparecia de la cuenta y el
                      -- cliente quedaba debiendo lo que ya pago.
                      AND ((cd.tipo='factura' AND EXISTS (
                              SELECT 1 FROM sg_ven_facturas f2
                               WHERE f2.id = cd.doc_id AND f2.estado <> 'anulada'))
                        OR (cd.tipo='liquidacion' AND EXISTS (
                              SELECT 1 FROM sg_ven_liquidaciones l2
                               WHERE l2.id = cd.doc_id AND l2.estado <> 'anulada')))), 0) AS a_cuenta
      FROM sg_clientes c
      WHERE c.activo=1`).all();
    const red = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const data = rows.map((r) => ({
      ...r,
      documentado: red(r.documentado),
      pendiente_comprobante: red(r.pendiente_comprobante),
      total_cobrado: red(r.total_cobrado),
      a_cuenta: red(r.a_cuenta),
      // total_facturado se sigue devolviendo con el nombre de siempre para no
      // romper a nadie que lo esté leyendo, pero ahora dice lo DOCUMENTADO.
      total_facturado: red(r.documentado),
      saldo: red((r.saldo_inicial || 0) + Number(r.documentado || 0)
                 + Number(r.pendiente_comprobante || 0) - Number(r.a_cuenta || 0)),
    })).filter((r) => r.saldo_inicial !== 0 || r.documentado !== 0
                   || r.pendiente_comprobante !== 0 || r.total_cobrado !== 0)
      .sort((a, b) => b.saldo - a.saldo);
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// BRIEF 10 — CC de proveedores: deuda derivada de vencimientos de OC no pagados + saldo de apertura.
// saldo = saldo_inicial (al corte) + Σ vencimientos pendientes post-corte. NO toca contabilidad.
router.get('/cc-proveedores', requireAuth, (req, res) => {
  const db = getDb();
  try {
    // ── LO QUE SE LE DEBE A CADA PROVEEDOR ───────────────────────────────
    //
    //   saldo de apertura
    // + lo FACTURADO y no pagado          ← el comprobante que emitió
    // + lo que está por vencer de órdenes SIN factura   ← todavía no llegó
    //
    // Antes era sólo la segunda línea, calculada sobre el COSTO de la
    // mercadería: cargar una factura de un millón y medio no movía un peso en
    // la cuenta del proveedor, y lo que sí figuraba estaba corto justo por el
    // IVA y las percepciones, que son parte de lo que hay que pagarle.
    //
    // El NOT EXISTS de la segunda línea es todo el asunto: sin él, una partida
    // ya facturada suma dos veces —su estimado y su factura—.
    const rows = db.prepare(`
      SELECT p.id, p.razon_social, COALESCE(p.saldo_inicial,0) AS saldo_inicial,
        COALESCE((SELECT SUM(COALESCE(f.total,0) + COALESCE(f.dif_gestion,0) - COALESCE(f.saldo_pagado,0))
                    FROM sg_facturas_compra f
                    JOIN sg_asientos a ON a.id = f.asiento_id AND COALESCE(a.anulado,0) = 0
                   WHERE f.proveedor_id = p.id AND f.activo = 1),0) AS facturado,
        -- ── QUÉ PARTE DE LO QUE SE LE DEBE NO TIENE COMPROBANTE ──────────
        -- Sale de lo que CADA PAGO dijo estar cancelando, no de un prorrateo:
        -- saldo_pagado_gestion es cuánto de lo pagado fue contra la parte sin
        -- comprobante. Antes esto se prorrateaba por la proporción original de
        -- la factura, así que pagar SÓLO lo facturado dejaba el saldo repartido
        -- mitad y mitad — el número total estaba bien y la apertura, mal.
        COALESCE((SELECT SUM(ROUND(
                    COALESCE(f.dif_gestion,0) - COALESCE(f.saldo_pagado_gestion,0), 2))
                    FROM sg_facturas_compra f
                    JOIN sg_asientos a ON a.id = f.asiento_id AND COALESCE(a.anulado,0) = 0
                   WHERE f.proveedor_id = p.id AND f.activo = 1
                     AND COALESCE(f.dif_gestion,0) <> 0),0) AS pendiente_gestion,
        -- LO QUE TODAVÍA NO ESTÁ EN EL LIBRO. Se informa aparte y NO suma al
        -- saldo: la cuenta corriente refleja la contabilidad, y hasta que no
        -- hay asiento no hay deuda registrada. Se muestra igual para que el que
        -- mira sepa que hay comprobantes esperando entrar.
        -- LO ENTREGADO A CUENTA que todavía no canceló ninguna factura. Es
        -- plata que ya salió: baja el saldo aunque no haya comprobante contra
        -- qué imputarla.
        COALESCE((SELECT SUM(ROUND(pg.monto - COALESCE((SELECT SUM(pc.monto) FROM sg_pagos_compras pc
                                                         WHERE pc.pago_id = pg.id), 0), 2))
                    FROM sg_pagos_proveedores pg
                   WHERE pg.proveedor_id = p.id AND COALESCE(pg.anulado,0) = 0
                     AND ROUND(pg.monto - COALESCE((SELECT SUM(pc.monto) FROM sg_pagos_compras pc
                                                     WHERE pc.pago_id = pg.id), 0), 2) > 0),0) AS a_cuenta,
        (SELECT COUNT(*) FROM sg_facturas_compra f3
          WHERE f3.proveedor_id = p.id AND f3.activo = 1
            AND (f3.asiento_id IS NULL
                 OR EXISTS (SELECT 1 FROM sg_asientos a3
                             WHERE a3.id = f3.asiento_id AND a3.anulado = 1))) AS sin_contabilizar,
        COALESCE((SELECT SUM(COALESCE(f4.total,0)) FROM sg_facturas_compra f4
          WHERE f4.proveedor_id = p.id AND f4.activo = 1
            AND (f4.asiento_id IS NULL
                 OR EXISTS (SELECT 1 FROM sg_asientos a4
                             WHERE a4.id = f4.asiento_id AND a4.anulado = 1))),0) AS monto_sin_contabilizar
      FROM sg_proveedores p WHERE p.activo=1`).all();
    const data = rows.map((r) => ({
        ...r,
        total_pendiente: r2(r.facturado || 0),
        // El anticipo RESTA: se le entregó plata que todavía no canceló nada.
        saldo: r2((r.saldo_inicial || 0) + (r.facturado || 0) - (r.a_cuenta || 0)),
      }))
      .filter((r) => r.saldo !== 0 || r.saldo_inicial !== 0 || r.sin_contabilizar > 0 || r.a_cuenta > 0)
      .sort((a, b) => b.saldo - a.saldo);
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// PAGOS A PROVEEDORES
// ══════════════════════════════════════════════════════════════════════════
// La cuenta corriente sólo subía. Se cargaba la factura, se contabilizaba, el
// saldo crecía — y no había forma de bajarlo: le pagabas a AGROT y su cuenta
// seguía diciendo lo mismo para siempre.
//
// Un pago hace DOS cosas, y las dos importan:
//   1. Se imputa a facturas concretas. No es "le pagué un millón": es "le pagué
//      la factura 1-23", que es lo que después permite discutir un saldo.
//   2. Entra al libro. La cuenta corriente refleja la contabilidad —eso ya vale
//      para las facturas— así que un pago que no está en el libro tampoco puede
//      moverla. El asiento sale solo: Proveedores al DEBE contra la cuenta
//      contable del banco o la caja de donde salió la plata.
//
// De qué cuenta contable es "Proveedores": la misma que usa el asiento modelo de
// las facturas. No se parametriza aparte — sería dos lugares para decir lo mismo
// y el día que no coincidan, el mayor de proveedores no cierra.
function cuentaProveedoresDeModelo(db) {
  const lineas = lineasModeloFactura(db) || [];
  const l = lineas.find((x) => x.tipo_linea === 'proveedores' && x.cuenta_id);
  return l ? l.cuenta_id : null;
}

// La cuenta donde están parados los cheques de terceros que todavía no se
// depositaron. Endosar uno la descarga: sale de la cartera y cancela deuda.
// Ésta SÍ se parametriza —no hay un asiento modelo del que sacarla— y se
// configura en Contabilidad SG.
function cuentaChequesCartera(db) {
  const r = db.prepare("SELECT cuenta_id FROM sg_config_impositiva WHERE clave='cheques_cartera'").get();
  return (r && r.cuenta_id) || null;
}

// Lo que le queda por pagar a cada factura contabilizada de un proveedor. Es lo
// único a lo que se puede imputar un pago: una factura sin asiento todavía no es
// deuda registrada.
router.get('/pagos/pendientes/:proveedorId', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT f.id, f.fecha_emision, f.tipo_comprobante, f.punto_venta, f.numero,
             f.total, COALESCE(f.saldo_pagado,0) AS pagado,
             COALESCE(f.dif_gestion,0) AS dif_gestion, f.dif_motivo,
             -- Las dos mitades, cada una con lo suyo pagado. El que arma el pago
             -- tiene que ver cuánto puede imputar a cada lado: si sólo viera el
             -- total, elegiría "sólo lo facturado" por más de lo que hay.
             ROUND(COALESCE(f.total,0) - (COALESCE(f.saldo_pagado,0) - COALESCE(f.saldo_pagado_gestion,0)), 2) AS pendiente_fiscal,
             ROUND(COALESCE(f.dif_gestion,0) - COALESCE(f.saldo_pagado_gestion,0), 2) AS pendiente_gestion,
             ROUND(COALESCE(f.total,0) + COALESCE(f.dif_gestion,0) - COALESCE(f.saldo_pagado,0), 2) AS pendiente,
             COALESCE(o.trazabilidad, o.numero) AS partida
        FROM sg_facturas_compra f
        JOIN sg_asientos a ON a.id = f.asiento_id AND COALESCE(a.anulado,0) = 0
        LEFT JOIN sg_oc o ON o.id = f.oc_id
       WHERE f.proveedor_id = ? AND f.activo = 1
         AND ROUND(COALESCE(f.total,0) + COALESCE(f.dif_gestion,0) - COALESCE(f.saldo_pagado,0), 2) > 0
       ORDER BY f.fecha_emision, f.id`).all(req.params.proveedorId);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Las cuentas de donde puede salir la plata, con su cuenta contable: sin ella el
// asiento no se puede armar y el pago no entra al libro.
router.get('/pagos/cuentas', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`SELECT c.id, c.nombre, c.tipo, c.banco, c.ambito,
        COALESCE(c.tiene_chequera,0) AS tiene_chequera,
        c.cuenta_contable_id, cc.codigo AS cuenta_codigo, cc.nombre AS cuenta_nombre
      FROM sg_fin_cuentas c
      LEFT JOIN sg_cuentas cc ON cc.id = c.cuenta_contable_id
      WHERE c.activo = 1 ORDER BY c.tipo, c.nombre`).all();
    // Cuál puede usar EL QUE PREGUNTA. Se manda el dato en vez de esconder la
    // cuenta: que no aparezca se lee como "no hay caja cargada" y manda a
    // alguien a crear una segunda caja que ya existe.
    const conDueno = rows.map((c) => ({
      ...c,
      puedo: puedeMoverCuenta(req.user, c.id) ? 1 : 0,
    }));
    // La cuenta de Proveedores, para que la pantalla pueda MOSTRAR el asiento
    // antes de confirmar (ver CLAUDE.md). El asiento lo sigue armando el
    // backend; esto es para que el preview del front lo espeje y no lo invente.
    const ctaProv = cuentaProveedoresDeModelo(db);
    const prov = ctaProv
      ? db.prepare('SELECT id, codigo, nombre FROM sg_cuentas WHERE id=?').get(ctaProv)
      : null;
    // Y la de cheques en cartera, por lo mismo: endosar un cheque descarga ESA
    // cuenta, y la pantalla tiene que poder mostrar ese asiento antes de que se
    // confirme.
    const ctaCart = cuentaChequesCartera(db);
    const cart = ctaCart
      ? db.prepare('SELECT id, codigo, nombre FROM sg_cuentas WHERE id=?').get(ctaCart)
      : null;
    res.json({ ok: true, data: conDueno, proveedores: prov || null, cartera: cart || null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/pagos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const where = ['1=1'], params = [];
    if (req.query.proveedor_id) { where.push('p.proveedor_id=?'); params.push(req.query.proveedor_id); }
    if (req.query.desde) { where.push('p.fecha>=?'); params.push(req.query.desde); }
    if (req.query.hasta) { where.push('p.fecha<=?'); params.push(req.query.hasta); }
    const rows = db.prepare(`
      SELECT p.*, pr.razon_social AS proveedor_nombre, fc.nombre AS cuenta_nombre,
             a.anulado AS asiento_anulado,
             (SELECT GROUP_CONCAT((CASE WHEN f.punto_venta IS NOT NULL AND f.punto_venta <> ''
                                        THEN f.punto_venta || '-' ELSE '' END) || f.numero, ' · ')
                FROM sg_pagos_compras pc JOIN sg_facturas_compra f ON f.id = pc.compra_id
               WHERE pc.pago_id = p.id) AS facturas
        FROM sg_pagos_proveedores p
        LEFT JOIN sg_proveedores pr ON pr.id = p.proveedor_id
        LEFT JOIN sg_fin_cuentas fc ON fc.id = p.cuenta_fin_id
        LEFT JOIN sg_asientos a ON a.id = p.asiento_id
       WHERE ${where.join(' AND ')} ORDER BY p.fecha DESC, p.id DESC`).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── PAGARLE A UN PROVEEDOR ES OPERAR, NO SER ADMIN ────────────────────────
// Estaba en requireAdmin, y eso obligaba a que cada pago del día lo cargara el
// dueño: el cajero que entrega el efectivo y la persona de cuentas a pagar
// tenían que pedírselo. Firmar el cheque en el banco es otra cosa, y no pasa por
// acá — acá se REGISTRA que se pagó.
//
// Quedan tres controles, y son los que corresponden:
//  · exigirNivel pide nivel "operar" en el módulo (index.js, por la URL).
//  · si la cuenta de donde sale la plata tiene usuarios asignados, tiene que
//    estar entre ellos: la caja de planta no la paga administración.
//  · anular sigue pidiendo nivel "anular", que es un permiso aparte.
router.post('/pagos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const proveedorId = Number(b.proveedor_id);
    if (!proveedorId) return res.status(400).json({ ok: false, error: 'Elegí el proveedor' });
    const fecha = val(b.fecha) || db.prepare("SELECT date('now','localtime') d").get().d;
    // ── QUÉ ESTÁ CANCELANDO ESTE PAGO ───────────────────────────────────
    // 'todo' reparte en proporción, 'fiscal' va sólo contra lo que dice el
    // comprobante y 'gestion' sólo contra lo que quedó sin facturar. De esto
    // depende en qué libro cae el asiento: un pago de la parte sin comprobante
    // NO puede aparecer en el fiscal, porque ahí esa deuda nunca subió.
    const ambitoPago = ['fiscal', 'gestion'].includes(String(b.ambito_pago || ''))
      ? String(b.ambito_pago) : 'todo';
    // Cada línea puede cancelar con DOS platas distintas: la que sale hoy del
    // banco (monto) y la que ya se le había entregado y quedó a cuenta
    // (desde_a_cuenta). La segunda no vuelve a salir de ningún lado.
    const imputaciones = (Array.isArray(b.imputaciones) ? b.imputaciones : [])
      .map((x) => ({
        factura_id: Number(x.factura_id),
        monto: r2(x.monto),
        desdeACuenta: r2(x.desde_a_cuenta),
      }))
      .filter((x) => x.factura_id && (x.monto > 0 || x.desdeACuenta > 0));
    // ── EL ANTICIPO ──────────────────────────────────────────────────────
    // Plata que sale ANTES de que exista la factura: la seña que pide el
    // productor para largar el camión. No se puede imputar a nada todavía, así
    // que queda a cuenta y baja el saldo igual — se le entregó plata.
    // Después, cuando llega la factura, se aplica.
    const aCuenta = r2(b.a_cuenta);
    const imputado = r2(imputaciones.reduce((a, x) => a + x.monto, 0));
    // EL TOTAL DEL PAGO ES SÓLO LA PLATA NUEVA. Lo que se cancela con un
    // anticipo ya salió el día del anticipo, ya tiene su asiento y ya bajó el
    // saldo del proveedor: contarlo otra vez acá sería cobrarle dos veces.
    const usaACuenta = r2(imputaciones.reduce((a, x) => a + x.desdeACuenta, 0));
    const total = r2(imputado + (aCuenta > 0 ? aCuenta : 0));
    if (!(total > 0) && !(usaACuenta > 0)) {
      return res.status(400).json({ ok: false,
        error: 'Poné cuánto se paga: imputado a facturas, a cuenta, o las dos cosas.' });
    }
    if (aCuenta > 0 && usaACuenta > 0) {
      return res.status(400).json({ ok: false,
        error: 'O dejás plata a cuenta, o usás la que ya estaba a cuenta. Las dos cosas en el mismo '
             + 'movimiento no tienen sentido: entregarías una seña y la aplicarías en el mismo acto.' });
    }

    // ── DE DÓNDE SALE LA PLATA: PUEDE SER DE VARIOS LADOS ─────────────────
    // Un pago de 500.000 sale como 100.000 de la caja, un cheque a 30 días por
    // 300.000 y una transferencia por el resto. Con una sola forma había que
    // cargarlo como tres pagos distintos, que después figuran como tres
    // movimientos que nadie sabe que eran el mismo.
    //
    // El formato viejo —cuenta_fin_id + forma_pago sueltos— se sigue aceptando y
    // se traduce a un medio único: hay llamadas que ya lo usan.
    const mediosCrudos = Array.isArray(b.medios) && b.medios.length
      ? b.medios
      : (b.cuenta_fin_id
          ? [{ cuenta_fin_id: b.cuenta_fin_id, forma_pago: b.forma_pago, monto: total,
               referencia: b.referencia, chequera_id: b.chequera_id, nro_cheque: b.nro_cheque,
               cheque_vto: b.cheque_vto }]
          : []);

    let ctaProv = null;
    const medios = [];
    if (total > 0) {
      if (!mediosCrudos.length) {
        return res.status(400).json({ ok: false, error: 'Elegí de qué cuenta sale la plata' });
      }
      ctaProv = cuentaProveedoresDeModelo(db);
      if (!ctaProv) {
        return res.status(400).json({ ok: false,
          error: 'El asiento modelo de las facturas no tiene línea de Proveedores: sin esa cuenta no se '
               + 'sabe contra qué cancelar el pago.' });
      }
      const numerosPedidos = new Set();
      const chequesPedidos = new Set();
      for (const m of mediosCrudos) {
        // ── ENDOSAR UN CHEQUE DE TERCEROS ─────────────────────────────
        // No sale plata de ningún lado: sale de la CARTERA. El papel que nos dio
        // un cliente se lo damos al proveedor, y con eso se cancela deuda. Por
        // eso este medio no tiene cuenta de Caja y Bancos, no genera movimiento,
        // y en el asiento va contra la cuenta de cheques en cartera.
        if (val(m.forma_pago) === 'cheque_terceros') {
          const ctaCart = cuentaChequesCartera(db);
          if (!ctaCart) {
            return res.status(400).json({ ok: false,
              error: 'Falta decir contra qué cuenta contable van los cheques en cartera. Configurala en '
                   + 'Contabilidad SG antes de endosar.' });
          }
          const ch = db.prepare(`SELECT ct.*, cl.razon_social AS cliente_nombre
            FROM sg_fin_cheques_terceros ct
            LEFT JOIN sg_clientes cl ON cl.id = ct.cliente_id WHERE ct.id=?`).get(m.cheque_terceros_id);
          if (!ch) return res.status(400).json({ ok: false, error: 'Elegí qué cheque de la cartera se endosa' });
          if (ch.estado !== 'en_cartera') {
            return res.status(400).json({ ok: false,
              error: 'El cheque N° ' + ch.nro_cheque + ' no está en cartera: está ' + ch.estado + '.' });
          }
          // UN CHEQUE SE ENDOSA ENTERO. No se puede pagar media factura con
          // medio cheque: al proveedor se le entrega el papel completo. Si el
          // cheque vale más que la deuda, la diferencia queda a cuenta.
          const monto = r2(ch.monto);
          if (r2(m.monto) > 0 && Math.abs(r2(m.monto) - monto) > 0.01) {
            return res.status(400).json({ ok: false,
              error: 'El cheque N° ' + ch.nro_cheque + ' es por ' + monto + ' y se endosa entero: '
                   + 'no se puede endosar ' + r2(m.monto) + '.' });
          }
          if (chequesPedidos.has(ch.id)) {
            return res.status(400).json({ ok: false,
              error: 'Estás endosando el cheque N° ' + ch.nro_cheque + ' dos veces en el mismo pago.' });
          }
          chequesPedidos.add(ch.id);
          medios.push({ cuenta: null, ctaContable: ctaCart, monto, forma: 'cheque_terceros',
            cheque: null, chequeTer: ch,
            referencia: val(m.referencia) || ('Cheque ' + (ch.banco ? ch.banco + ' ' : '') + ch.nro_cheque) });
          continue;
        }
        const cuenta = db.prepare(`SELECT c.*, cc.id AS cta FROM sg_fin_cuentas c
          LEFT JOIN sg_cuentas cc ON cc.id = c.cuenta_contable_id
          WHERE c.id=? AND c.activo=1`).get(m.cuenta_fin_id);
        if (!cuenta) return res.status(400).json({ ok: false, error: 'Elegí de qué cuenta sale la plata' });
        if (!puedeMoverCuenta(req.user, cuenta.id)) {
          return res.status(403).json({ ok: false,
            error: 'La cuenta "' + cuenta.nombre + '" tiene usuarios asignados y no estás entre ellos.' });
        }
        if (!cuenta.cta) {
          return res.status(400).json({ ok: false,
            error: 'La cuenta "' + cuenta.nombre + '" no tiene cuenta contable asociada, así que el pago no '
                 + 'puede entrar al libro. Asignásela en Caja y Bancos.' });
        }
        // Con UN solo medio el importe puede venir vacío: es todo el pago.
        const monto = (mediosCrudos.length === 1 && !(r2(m.monto) > 0)) ? total : r2(m.monto);
        if (!(monto > 0)) {
          return res.status(400).json({ ok: false,
            error: 'Poné cuánto sale de "' + cuenta.nombre + '".' });
        }
        const forma = val(m.forma_pago) || 'transferencia';

        // ── SI SE PAGA CON CHEQUE, SE ANOTA EL CHEQUE ───────────────────
        // Antes el número se escribía en "referencia": texto libre que no
        // controlaba nadie. Dos cheques con el mismo número en la misma cuenta
        // es la misma orden librada dos veces, y eso no se descubre acá: se
        // descubre en el banco cuando presentan el segundo.
        let cheque = null;
        if (forma === 'cheque') {
          const chequeraId = Number(m.chequera_id);
          const nroCheque = Number(m.nro_cheque);
          if (!chequeraId || !nroCheque) {
            return res.status(400).json({ ok: false,
              error: 'Pagando con cheque hay que decir de qué chequera sale y con qué número.' });
          }
          const ch = db.prepare('SELECT * FROM sg_fin_chequeras WHERE id=? AND activo=1').get(chequeraId);
          if (!ch) return res.status(400).json({ ok: false, error: 'Esa chequera no existe o está dada de baja' });
          if (Number(ch.cuenta_id) !== Number(cuenta.id)) {
            return res.status(400).json({ ok: false,
              error: 'Esa chequera no es de la cuenta "' + cuenta.nombre + '"' });
          }
          if (nroCheque < ch.desde || nroCheque > ch.hasta) {
            return res.status(400).json({ ok: false,
              error: 'El cheque ' + nroCheque + ' no pertenece a esa chequera: va del ' + ch.desde
                   + ' al ' + ch.hasta });
          }
          const usado = chequeUsado(db, ch.cuenta_id, nroCheque, null);
          if (usado) {
            return res.status(400).json({ ok: false,
              error: 'El cheque N° ' + nroCheque + ' YA SE EMITIÓ el ' + (usado.fecha_emision || 's/f')
                   + (usado.beneficiario ? ' a ' + usado.beneficiario : '') + ' (' + usado.estado + '). '
                   + 'Un número de cheque no se usa dos veces.' });
          }
          // Y TAMPOCO DOS VECES EN EL MISMO PAGO. El control de arriba mira lo
          // que ya está en la base; dos renglones del mismo pago con el mismo
          // número todavía no están, y entrarían los dos.
          const clave = ch.cuenta_id + '#' + nroCheque;
          if (numerosPedidos.has(clave)) {
            return res.status(400).json({ ok: false,
              error: 'Estás librando el cheque N° ' + nroCheque + ' dos veces en el mismo pago.' });
          }
          numerosPedidos.add(clave);
          cheque = { chequera_id: ch.id, nro: nroCheque, fecha_vto: val(m.cheque_vto) || null };
        }
        medios.push({ cuenta, ctaContable: cuenta.cta, monto, forma, cheque, chequeTer: null,
          referencia: val(m.referencia) || null });
      }

      // LOS MEDIOS TIENEN QUE SUMAR EL PAGO. Si no, o sale plata que no canceló
      // nada, o se da por cancelado algo que no se pagó.
      const sumaMedios = r2(medios.reduce((a, m) => a + m.monto, 0));
      if (Math.abs(sumaMedios - total) > 0.01) {
        return res.status(400).json({ ok: false,
          error: 'Los medios de pago suman ' + sumaMedios + ' y el pago es de ' + total + '.' });
      }
    }
    // La cabecera guarda UNA cuenta, que es de cuando un pago tenía una sola
    // forma. Se toma la primera que sea una cuenta de verdad: un pago endosando
    // un cheque no sale de ninguna, y ahí queda en nulo.
    const cuenta = medios.map((m) => m.cuenta).find(Boolean) || null;
    const formaPago = medios.length
      ? (medios.length === 1 ? medios[0].forma : 'varios')
      : (val(b.forma_pago) || 'transferencia');

    // Lo que hay a cuenta, anticipo por anticipo y del más viejo al más nuevo:
    // se consume en ese orden para que la seña vieja no quede eternamente
    // colgada mientras se aplican las nuevas.
    const anticipos = usaACuenta > 0 ? db.prepare(`SELECT p.id,
        ROUND(p.monto - COALESCE((SELECT SUM(pc.monto) FROM sg_pagos_compras pc
                                   WHERE pc.pago_id = p.id), 0), 2) AS disponible
      FROM sg_pagos_proveedores p
      WHERE p.proveedor_id = ? AND COALESCE(p.anulado,0) = 0
      ORDER BY p.fecha, p.id`).all(proveedorId).filter((a) => a.disponible > 0) : [];
    const dispTotal = r2(anticipos.reduce((a, x) => a + x.disponible, 0));
    if (usaACuenta > dispTotal + 0.01) {
      return res.status(400).json({ ok: false,
        error: 'El proveedor tiene ' + dispTotal + ' a cuenta y estás aplicando ' + usaACuenta + '.' });
    }

    // Cada imputación contra una factura de verdad, contabilizada, del mismo
    // proveedor y sin pasarse de lo que le queda pendiente.
    const facturas = [];
    for (const im of imputaciones) {
      const f = db.prepare(`SELECT f.*, a.anulado AS asiento_anulado FROM sg_facturas_compra f
        LEFT JOIN sg_asientos a ON a.id = f.asiento_id
        WHERE f.id=? AND f.activo=1`).get(im.factura_id);
      if (!f) return res.status(400).json({ ok: false, error: 'Una de las facturas no existe' });
      if (Number(f.proveedor_id) !== proveedorId) {
        return res.status(400).json({ ok: false, error: 'La factura ' + f.numero + ' es de otro proveedor' });
      }
      if (!f.asiento_id || f.asiento_anulado) {
        return res.status(400).json({ ok: false,
          error: 'La factura ' + f.numero + ' todavía no está contabilizada: no es deuda registrada y '
               + 'no se le puede imputar un pago.' });
      }
      // Lo que le queda por pagar es lo ACORDADO menos lo pagado: el total del
      // comprobante más lo que quedó sin facturar. Con sólo el total, pagarle
      // los 20.000 que se le deben rebotaba con "le quedan 10.000".
      // ── LAS DOS MITADES DE LO QUE SE LE DEBE ──────────────────────────
      const pendGes = r2((f.dif_gestion || 0) - (f.saldo_pagado_gestion || 0));
      const pendFis = r2((f.total || 0) - ((f.saldo_pagado || 0) - (f.saldo_pagado_gestion || 0)));
      const pendiente = r2(pendFis + pendGes);
      const cancela = r2(im.monto + im.desdeACuenta);
      const tope = ambitoPago === 'fiscal' ? pendFis
        : (ambitoPago === 'gestion' ? pendGes : pendiente);
      if (cancela > tope + 0.01) {
        return res.status(400).json({ ok: false,
          error: 'A la factura ' + f.numero + ' le quedan ' + tope
               + (ambitoPago === 'fiscal' ? ' facturados'
                  : (ambitoPago === 'gestion' ? ' sin facturar' : ''))
               + ' y le estás imputando ' + cancela + '.' });
      }
      // CUÁNTO DE ESTO VA CONTRA LA PARTE SIN COMPROBANTE. Con "las dos" se
      // reparte en proporción: es la única regla que no depende del orden en que
      // se hayan cargado las facturas.
      const ges = ambitoPago === 'gestion' ? cancela
        : (ambitoPago === 'fiscal' ? 0
           : (pendiente > 0 ? r2(cancela * pendGes / pendiente) : 0));
      facturas.push({ f, monto: im.monto, desdeACuenta: im.desdeACuenta,
        gestion: ges, fiscal: r2(cancela - ges) });
    }

    // ── CUÁNTO DE LA PLATA QUE SALE HOY VA CONTRA LO SIN FACTURAR ───────
    // Lo que se cubre con un anticipo no entra: esa plata salió el día del
    // anticipo y ya tiene su asiento.
    let gesNuevo = 0;
    for (const x of facturas) {
      const cancelaX = r2(x.monto + x.desdeACuenta);
      if (cancelaX > 0 && x.monto > 0) gesNuevo = r2(gesNuevo + r2(x.gestion * x.monto / cancelaX));
    }
    if (aCuenta > 0 && ambitoPago === 'gestion') gesNuevo = r2(gesNuevo + aCuenta);
    if (gesNuevo > total) gesNuevo = total;
    // El motivo de las líneas de gestión sale de la factura que se está
    // cancelando: es la misma diferencia, y repetirlo deja el informe por motivo
    // sumando lo mismo de los dos lados.
    const motivoGestion = (facturas.find((x) => x.gestion > 0 && x.f.dif_motivo) || {}).f?.dif_motivo
      || 'ajuste_gestion';

    const nro = (val(b.referencia) || '').trim();
    let pagoId = null, asientoId = null;
    db.transaction(() => {
      const insImp = db.prepare(
        'INSERT INTO sg_pagos_compras (pago_id, compra_id, monto, monto_gestion) VALUES (?,?,?,?)');
      const subeSaldo = db.prepare(`UPDATE sg_facturas_compra
        SET saldo_pagado = ROUND(COALESCE(saldo_pagado,0) + ?, 2),
            saldo_pagado_gestion = ROUND(COALESCE(saldo_pagado_gestion,0) + ?, 2),
            modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`);

      if (total > 0) {
        pagoId = db.prepare(`INSERT INTO sg_pagos_proveedores
          (fecha, proveedor_id, monto, forma_pago, banco, referencia, notas, usuario_id, cuenta_fin_id, ambito_pago)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          fecha, proveedorId, total, formaPago,
          (cuenta && cuenta.banco) || null, nro || null, val(b.notas), uid(req),
          cuenta ? cuenta.id : null, ambitoPago).lastInsertRowid;
        for (const x of facturas) {
          if (x.monto > 0) {
            // Lo que sale HOY se reparte en la misma proporción que la
            // imputación entera: el resto lo cubre el saldo a cuenta.
            const cancela = r2(x.monto + x.desdeACuenta);
            const gesHoy = cancela > 0 ? r2(x.gestion * x.monto / cancela) : 0;
            insImp.run(pagoId, x.f.id, x.monto, gesHoy);
          }
        }
      }

      // ── SE CANCELA CON LO QUE YA ESTABA A CUENTA ──────────────────────
      // La imputación cuelga del ANTICIPO, no de este pago: así el anticipo
      // deja de tener saldo disponible y la factura queda cancelada, sin que
      // salga plata de ningún lado ni se genere un segundo asiento.
      for (const x of facturas) {
        let falta = x.desdeACuenta;
        for (const a of anticipos) {
          if (falta <= 0.001) break;
          if (a.disponible <= 0.001) continue;
          const usa = r2(Math.min(a.disponible, falta));
          // La parte de gestión que le toca a lo que se cubre con el anticipo.
          const cancelaX = r2(x.monto + x.desdeACuenta);
          insImp.run(a.id, x.f.id, usa, cancelaX > 0 ? r2(x.gestion * usa / cancelaX) : 0);
          a.disponible = r2(a.disponible - usa);
          falta = r2(falta - usa);
        }
        if (falta > 0.01) throw new Error('No alcanzó el saldo a cuenta para la factura ' + x.f.numero);
      }

      for (const x of facturas) {
        const cancela = r2(x.monto + x.desdeACuenta);
        if (cancela > 0) subeSaldo.run(cancela, x.gestion, uid(req), x.f.id);
      }

      // EL ASIENTO. Proveedores al debe —se cancela deuda— contra la cuenta del
      // banco o la caja de donde salió la plata. Sólo si salió plata: aplicar un
      // anticipo no mueve un peso, ya se asentó cuando se entregó.
      if (total > 0) {
        const prov = db.prepare('SELECT razon_social FROM sg_proveedores WHERE id=?').get(proveedorId);
        const conNueva = facturas.filter((x) => x.monto > 0);
        const desc = (conNueva.length ? 'Pago a ' : 'Anticipo a ')
          + ((prov && prov.razon_social) || 'proveedor')
          + (nro ? ' — ' + nro : '')
          + (conNueva.length ? ' — ' + conNueva.map((x) => x.f.numero).join(', ') : '')
          + (conNueva.length && aCuenta > 0 ? ' (+ ' + aCuenta + ' a cuenta)' : '');
        // UNA LÍNEA POR MEDIO: cada plata sale de su propia cuenta contable. Con
        // una sola línea por el total, un pago mitad caja y mitad banco quedaba
        // descargado entero contra una de las dos.
        //
        // ── Y CADA MITAD EN SU LIBRO ────────────────────────────────────
        // Un pago que cancela la parte SIN comprobante no puede aparecer en el
        // libro fiscal: ahí esa deuda nunca subió, así que la cuenta de
        // Proveedores bajaría por algo que nunca entró. Va marcado como
        // gestión, y el asiento cierra dos veces —una por mitad—.
        const partes = [
          { ambito: 'fiscal', monto: r2(total - gesNuevo), motivo: null },
          { ambito: 'gestion', monto: gesNuevo, motivo: motivoGestion },
        ].filter((p) => p.monto > 0.001);
        const lineas = [];
        for (const p of partes) {
          lineas.push({ cuenta_id: ctaProv, debe: p.monto, haber: 0, descripcion: 'Proveedores',
            ambito: p.ambito, motivo: p.motivo });
          // Cada medio aporta a esta mitad en proporción a lo que puso en el
          // pago. El último se lleva el resto, para que la mitad cierre exacta
          // aunque los centavos no se repartan justo.
          let queda = p.monto;
          medios.forEach((m, i) => {
            const parte = i === medios.length - 1 ? queda : r2(p.monto * m.monto / total);
            queda = r2(queda - parte);
            if (parte <= 0.001) return;
            lineas.push({ cuenta_id: m.ctaContable, debe: 0, haber: parte,
              ambito: p.ambito, motivo: p.motivo,
              descripcion: m.chequeTer
                ? ('Cheque N° ' + m.chequeTer.nro_cheque + ' endosado'
                   + (m.chequeTer.cliente_nombre ? ' (de ' + m.chequeTer.cliente_nombre + ')' : ''))
                : m.cuenta.nombre });
          });
        }
        asientoId = crearAsiento(db, {
          fecha, descripcion: desc, usuario_id: uid(req), ref_codigo: nro || null,
        }, lineas).id;
        db.prepare('UPDATE sg_pagos_proveedores SET asiento_id=? WHERE id=?').run(asientoId, pagoId);
      }

      // Cada medio deja su rastro: el cheque emitido con su número quemado, el
      // movimiento en la cuenta de donde salió, y el renglón del medio.
      const prov3 = db.prepare('SELECT razon_social FROM sg_proveedores WHERE id=?').get(proveedorId);
      const nombreProv = (prov3 && prov3.razon_social) || 'proveedor';
      const insMedio = db.prepare(`INSERT INTO sg_pagos_medios
        (pago_id, forma_pago, cuenta_fin_id, monto, referencia, chequera_id, nro_cheque, cheque_id, cheque_ter_id)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const m of medios) {
        // EL ENDOSO NO MUEVE NINGUNA CUENTA. El cheque sale de la cartera y se
        // anota a quién se le dio: el día que rebote hay que saber a quién
        // volvemos a deberle.
        if (m.chequeTer) {
          db.prepare(`UPDATE sg_fin_cheques_terceros
            SET estado='endosado', endosado_a=?, pago_id=?,
                notas = TRIM(COALESCE(notas,'') || ' [Endosado a ' || ? || ']')
            WHERE id=?`).run(proveedorId, pagoId, nombreProv, m.chequeTer.id);
          insMedio.run(pagoId, m.forma, null, m.monto, m.referencia, null, null, null, m.chequeTer.id);
          continue;
        }
        let chequeId = null;
        if (m.cheque) {
          chequeId = db.prepare(`INSERT INTO sg_fin_cheques_propios
            (chequera_id, nro_cheque, monto, beneficiario, fecha_emision, fecha_vto, pago_id)
            VALUES (?,?,?,?,?,?,?)`).run(m.cheque.chequera_id, m.cheque.nro, m.monto,
            nombreProv, fecha, m.cheque.fecha_vto, pagoId).lastInsertRowid;
        }
        // ── Y LA CAJA (O EL BANCO) BAJA ─────────────────────────────────
        // Sin esto, pagabas 1.500 desde el Galicia y Caja y Bancos seguía
        // mostrando el saldo de antes: el asiento existía, pero el saldo de la
        // pantalla se calcula con los movimientos, no con el libro.
        // EL MOVIMIENTO TAMBIÉN SE PARTE. Si el pago cancela las dos mitades, la
        // caja tiene que poder decir cuánto de lo que salió fue de cada libro:
        // con un solo movimiento, el arqueo fiscal se lleva todo.
        const gesMedio = total > 0 ? r2(gesNuevo * m.monto / total) : 0;
        const insMov = db.prepare(`INSERT INTO sg_fin_movimientos
          (cuenta_id, fecha, tipo, concepto, monto, referencia, pago_id, cheque_id, usuario_id, ambito, motivo)
          VALUES (?,?, 'egreso', ?,?,?,?,?,?,?,?)`);
        const conceptoMov = 'Pago a ' + nombreProv + (m.cheque ? ' — cheque N° ' + m.cheque.nro : '');
        if (r2(m.monto - gesMedio) > 0.001) {
          insMov.run(m.cuenta.id, fecha, conceptoMov, r2(m.monto - gesMedio),
            m.referencia || nro || null, pagoId, chequeId, uid(req), 'fiscal', null);
        }
        if (gesMedio > 0.001) {
          insMov.run(m.cuenta.id, fecha, conceptoMov + ' — parte sin facturar', gesMedio,
            m.referencia || nro || null, pagoId, chequeId, uid(req), 'gestion', motivoGestion);
        }
        insMedio.run(pagoId, m.forma, m.cuenta.id, m.monto, m.referencia,
          m.cheque ? m.cheque.chequera_id : null, m.cheque ? m.cheque.nro : null, chequeId, null);
      }
    })();
    res.json({ ok: true, data: {
      id: pagoId ? Number(pagoId) : null,
      asiento_id: asientoId ? Number(asientoId) : null,
      total, aplicado_a_cuenta: usaACuenta,
    } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── EL RECIBO, PARA IMPRIMIR Y HACER FIRMAR ──────────────────────────────
// El cajero entrega la plata y necesita un papel con la firma del que la recibe.
// Hasta ahora no había ninguno: la orden de pago vivía adentro del sistema y la
// constancia se hacía a mano o no se hacía.
//
// Sale como HTML listo para imprimir y no como PDF: no hace falta ninguna
// librería nueva, se abre en una pestaña, sale por la impresora de siempre y —lo
// que importa— el que lo mira ve exactamente lo que va a salir en papel.
//
// Va POR DUPLICADO en la misma hoja: uno queda en la carpeta y el otro se lo
// lleva quien cobró. Es como se hace, y partirlo en dos impresiones es como se
// pierde el segundo.
router.get('/pagos/:id/recibo', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const p = db.prepare(`SELECT pg.*, pr.razon_social, pr.cuit,
        u.nombre AS usuario_nombre
      FROM sg_pagos_proveedores pg
      LEFT JOIN sg_proveedores pr ON pr.id = pg.proveedor_id
      LEFT JOIN usuarios u ON u.id = pg.usuario_id
      WHERE pg.id = ?`).get(req.params.id);
    if (!p) return res.status(404).send('Orden de pago no encontrada');

    const medios = db.prepare(`SELECT m.*, c.nombre AS cuenta_nombre
      FROM sg_pagos_medios m LEFT JOIN sg_fin_cuentas c ON c.id = m.cuenta_fin_id
      WHERE m.pago_id = ? ORDER BY m.id`).all(p.id);
    const imp = db.prepare(`SELECT pc.monto, COALESCE(pc.monto_gestion,0) AS monto_gestion,
        f.punto_venta, f.numero, f.fecha_emision,
        (SELECT GROUP_CONCAT(o.trazabilidad, ' · ') FROM sg_factura_compra_ocs fo
           JOIN sg_oc o ON o.id = fo.oc_id WHERE fo.factura_id = f.id) AS partidas
      FROM sg_pagos_compras pc JOIN sg_facturas_compra f ON f.id = pc.compra_id
      WHERE pc.pago_id = ? ORDER BY f.fecha_emision, f.id`).all(p.id);

    const $ = (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const money = (n) => '$ ' + (Math.round((Number(n) || 0) * 100) / 100)
      .toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const FP = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque',
                 cheque_terceros: 'Cheque de terceros endosado', varios: 'Varios medios' };

    const cuerpo = (copia) => `
      <div class="recibo">
        <div class="cab">
          <div><div class="tit">Recibo de pago</div>
            <div class="sub">San Ger&oacute;nimo SA</div></div>
          <div class="der"><div class="nro">N&deg; ${p.id}</div>
            <div class="sub">${$(p.fecha)}</div>
            <div class="copia">${copia}</div></div>
        </div>
        <table class="datos">
          <tr><th>Recib&iacute; de</th><td>San Ger&oacute;nimo SA</td></tr>
          <tr><th>La suma de</th><td class="grande">${money(p.monto)}</td></tr>
          <tr><th>Que se paga a</th><td><b>${$(p.razon_social || '')}</b>${
            p.cuit ? ' &middot; CUIT ' + $(p.cuit) : ''}</td></tr>
          ${p.referencia ? `<tr><th>Referencia</th><td>${$(p.referencia)}</td></tr>` : ''}
        </table>
        ${imp.length ? `<div class="rot">Cancela</div>
        <table class="lista"><thead><tr><th>Comprobante</th><th>Partida</th>
          <th class="num">Importe</th></tr></thead><tbody>
          ${imp.map((x) => `<tr>
            <td>${$((x.punto_venta ? x.punto_venta + '-' : '') + (x.numero || ''))}</td>
            <td class="chico">${$(x.partidas || '')}</td>
            <td class="num">${money(x.monto)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="rot">A cuenta &mdash; sin imputar a comprobantes</div>'}
        ${medios.length ? `<div class="rot">Con qu&eacute; se paga</div>
        <table class="lista"><tbody>
          ${medios.map((m) => `<tr>
            <td>${$(FP[m.forma_pago] || m.forma_pago)}${
              m.cuenta_nombre ? ' &middot; ' + $(m.cuenta_nombre) : ''}${
              m.nro_cheque ? ' &middot; cheque N&deg; ' + $(m.nro_cheque) : ''}</td>
            <td class="num">${money(m.monto)}</td></tr>`).join('')}
        </tbody></table>` : ''}
        ${p.notas ? `<div class="notas">${$(p.notas)}</div>` : ''}
        <div class="firmas">
          <div class="firma"><div class="linea"></div>Firma y aclaraci&oacute;n de quien recibe</div>
          <div class="firma"><div class="linea"></div>${
            $(p.usuario_nombre || 'Entreg&oacute;')}</div>
        </div>
      </div>`;

    res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Recibo N&deg; ${p.id} &mdash; ${$(p.razon_social || '')}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Georgia,'Times New Roman',serif;color:#16211f;background:#f4f6f5;padding:16px}
  .recibo{background:#fff;border:1px solid #c3cec8;padding:22px 26px;max-width:19cm;margin:0 auto 14px}
  .cab{display:flex;justify-content:space-between;align-items:flex-start;
    border-bottom:2px solid #16211f;padding-bottom:10px;margin-bottom:14px}
  .tit{font-size:22px;font-weight:700}
  .sub{font-size:12px;color:#6b7772}
  .der{text-align:right}
  .nro{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
  .copia{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#6b7772;margin-top:4px}
  table{width:100%;border-collapse:collapse}
  .datos th{text-align:left;width:130px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
    color:#6b7772;font-weight:600;padding:5px 0;vertical-align:top}
  .datos td{padding:5px 0;font-size:14px}
  .grande{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
  .rot{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6b7772;
    font-weight:600;margin:14px 0 5px}
  .lista th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;
    color:#6b7772;border-bottom:1px solid #dce3df;padding:4px 0}
  .lista td{padding:4px 0;border-bottom:1px solid #eef1ef;font-size:13px}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .chico{font-size:11px;color:#6b7772}
  .notas{margin-top:12px;font-size:12.5px;color:#3d4a46;font-style:italic}
  .firmas{display:flex;gap:40px;margin-top:38px}
  .firma{flex:1;font-size:10.5px;color:#6b7772;text-align:center}
  .linea{border-top:1px solid #16211f;margin-bottom:5px}
  .imprimir{max-width:19cm;margin:0 auto 12px;text-align:right}
  .imprimir button{font:inherit;font-size:13px;padding:7px 16px;border:1px solid #16211f;
    background:#16211f;color:#fff;border-radius:6px;cursor:pointer}
  /* En papel no van ni el botón ni el fondo: la hoja es la hoja. */
  @media print{ body{background:#fff;padding:0} .imprimir{display:none}
    .recibo{border:0;margin:0;padding:14px 0} }
</style></head><body>
<div class="imprimir"><button onclick="window.print()">Imprimir</button></div>
${cuerpo('Original')}
${cuerpo('Duplicado')}
</body></html>`);
  } catch (e) { res.status(500).send('No se pudo armar el recibo: ' + e.message); }
});

// Con qué se pagó cada uno. Un pago con varios medios decía "varios" y nada más.
router.get('/pagos/:id/medios', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`SELECT m.*, c.nombre AS cuenta_nombre, c.tipo AS cuenta_tipo
      FROM sg_pagos_medios m LEFT JOIN sg_fin_cuentas c ON c.id = m.cuenta_fin_id
      WHERE m.pago_id = ? ORDER BY m.id`).all(req.params.id);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Lo que quedó a cuenta de cada pago: lo entregado menos lo que ya se imputó.
// Es plata del proveedor que todavía no canceló ninguna factura.
function aCuentaDePago(db, pagoId) {
  const p = db.prepare('SELECT monto FROM sg_pagos_proveedores WHERE id=?').get(pagoId);
  if (!p) return 0;
  const imp = db.prepare('SELECT COALESCE(SUM(monto),0) s FROM sg_pagos_compras WHERE pago_id=?').get(pagoId).s;
  return r2((p.monto || 0) - (imp || 0));
}

// Los anticipos con saldo, para aplicarlos cuando llega la factura.
router.get('/pagos/anticipos/:proveedorId', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`SELECT p.id, p.fecha, p.monto, p.referencia, fc.nombre AS cuenta_nombre,
        ROUND(p.monto - COALESCE((SELECT SUM(pc.monto) FROM sg_pagos_compras pc
                                   WHERE pc.pago_id = p.id), 0), 2) AS disponible
      FROM sg_pagos_proveedores p
      LEFT JOIN sg_fin_cuentas fc ON fc.id = p.cuenta_fin_id
      WHERE p.proveedor_id = ? AND COALESCE(p.anulado,0) = 0
      ORDER BY p.fecha, p.id`).all(req.params.proveedorId);
    res.json({ ok: true, data: rows.filter((r) => r.disponible > 0) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// APLICAR un anticipo a facturas. No sale plata: la plata ya salió cuando se
// entregó el anticipo. Esto sólo dice a qué factura se imputa, así que NO
// genera asiento — el asiento se hizo con el pago. Y como no mueve ninguna
// cuenta, alcanza con el nivel "operar" del módulo.
router.post('/pagos/:id/aplicar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const p = db.prepare('SELECT * FROM sg_pagos_proveedores WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'Pago no encontrado' });
    if (p.anulado) return res.status(400).json({ ok: false, error: 'Ese pago está anulado' });
    const disp = aCuentaDePago(db, p.id);
    if (!(disp > 0)) return res.status(400).json({ ok: false, error: 'Ese pago no tiene saldo a cuenta' });

    const imputaciones = (Array.isArray(req.body && req.body.imputaciones) ? req.body.imputaciones : [])
      .map((x) => ({ factura_id: Number(x.factura_id), monto: r2(x.monto) }))
      .filter((x) => x.factura_id && x.monto > 0);
    if (!imputaciones.length) return res.status(400).json({ ok: false, error: 'Elegí a qué factura se aplica' });
    const suma = r2(imputaciones.reduce((a, x) => a + x.monto, 0));
    if (suma > disp + 0.01) {
      return res.status(400).json({ ok: false,
        error: 'Ese anticipo tiene ' + disp + ' a cuenta y estás aplicando ' + suma + '.' });
    }

    const facturas = [];
    for (const im of imputaciones) {
      const f = db.prepare(`SELECT f.*, a.anulado AS asiento_anulado FROM sg_facturas_compra f
        LEFT JOIN sg_asientos a ON a.id = f.asiento_id
        WHERE f.id=? AND f.activo=1`).get(im.factura_id);
      if (!f) return res.status(400).json({ ok: false, error: 'Una de las facturas no existe' });
      if (Number(f.proveedor_id) !== Number(p.proveedor_id)) {
        return res.status(400).json({ ok: false, error: 'La factura ' + f.numero + ' es de otro proveedor' });
      }
      if (!f.asiento_id || f.asiento_anulado) {
        return res.status(400).json({ ok: false,
          error: 'La factura ' + f.numero + ' todavía no está contabilizada.' });
      }
      const pend = r2((f.total || 0) - (f.saldo_pagado || 0));
      if (im.monto > pend + 0.01) {
        return res.status(400).json({ ok: false,
          error: 'A la factura ' + f.numero + ' le quedan ' + pend + ' y le estás aplicando ' + im.monto + '.' });
      }
      facturas.push({ f, monto: im.monto });
    }

    db.transaction(() => {
      const insImp = db.prepare('INSERT INTO sg_pagos_compras (pago_id, compra_id, monto) VALUES (?,?,?)');
      const sube = db.prepare(`UPDATE sg_facturas_compra
        SET saldo_pagado = ROUND(COALESCE(saldo_pagado,0) + ?, 2),
            modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`);
      for (const x of facturas) { insImp.run(p.id, x.f.id, x.monto); sube.run(x.monto, uid(req), x.f.id); }
    })();
    res.json({ ok: true, data: { id: Number(p.id), aplicado: suma, disponible: aCuentaDePago(db, p.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Anular un pago: devuelve el saldo a las facturas y anula su asiento. El pago
// no se borra — igual que todo lo que ya tocó la contabilidad.
//
// NO va con requireAdmin y no es un descuido: exigirNivel reconoce la anulación
// por la URL y exige nivel "anular" en el módulo, que es un permiso aparte del
// de operar. Quien carga pagos todo el día no anula ninguno salvo que se lo
// hayan dado expresamente.
router.post('/pagos/:id/anular', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const motivo = val(req.body && req.body.motivo);
    if (!motivo) return res.status(400).json({ ok: false, error: 'Escribí por qué se anula: queda registrado' });
    const p = db.prepare('SELECT * FROM sg_pagos_proveedores WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'Pago no encontrado' });
    if (p.anulado) return res.status(400).json({ ok: false, error: 'Ese pago ya está anulado' });

    db.transaction(() => {
      const imps = db.prepare('SELECT * FROM sg_pagos_compras WHERE pago_id=?').all(p.id);
      const baja = db.prepare(`UPDATE sg_facturas_compra
        SET saldo_pagado = MAX(0, ROUND(COALESCE(saldo_pagado,0) - ?, 2)),
            modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`);
      for (const im of imps) baja.run(im.monto, uid(req), im.compra_id);
      db.prepare(`UPDATE sg_pagos_proveedores SET anulado=1, anulado_en=datetime('now','localtime'),
        anulado_por=?, anulado_motivo=? WHERE id=?`).run(uid(req), motivo, p.id);
      if (p.asiento_id) {
        db.prepare(`UPDATE sg_asientos SET anulado=1, anulado_por=?, anulado_en=datetime('now','localtime'),
          descripcion = descripcion || ' — ANULADO: ' || ? WHERE id=?`).run(uid(req), motivo, p.asiento_id);
      }
      // La plata vuelve a la cuenta. El movimiento se BORRA en vez de marcarse:
      // el saldo de Caja y Bancos se calcula sumando movimientos, así que uno
      // "anulado" que siguiera ahí seguiría restando. El pago queda con su
      // motivo y su asiento anulado, que es donde vive el registro de lo pasado.
      db.prepare('DELETE FROM sg_fin_movimientos WHERE pago_id=?').run(p.id);
      // Y el cheque que salió con ese pago queda anulado: su número NO vuelve al
      // talonario, un cheque librado y roto está roto.
      db.prepare(`UPDATE sg_fin_cheques_propios SET estado='anulado',
        notas = TRIM(COALESCE(notas,'') || ' [ANULADO con el pago: ' || ? || ']')
        WHERE pago_id=? AND estado <> 'cobrado'`).run(motivo, p.id);
      // El cheque de TERCEROS que se endosó con ese pago es al revés: no se
      // rompe, VUELVE a la cartera. El papel sigue existiendo y sigue siendo
      // nuestro — lo que se deshizo es habérselo dado al proveedor.
      db.prepare(`UPDATE sg_fin_cheques_terceros SET estado='en_cartera', endosado_a=NULL, pago_id=NULL,
        notas = TRIM(COALESCE(notas,'') || ' [Vuelve a la cartera: se anuló el pago — ' || ? || ']')
        WHERE pago_id=? AND estado='endosado'`).run(motivo, p.id);
    })();
    res.json({ ok: true, data: { id: Number(p.id) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── LA FICHA DE UN PROVEEDOR: TODOS SUS MOVIMIENTOS ──────────────────────
// El listado dice cuánto se le debe; acá se ve POR QUÉ. Cada comprobante con su
// fecha, su número, la partida que cubre y el saldo corriendo, que es como se
// lee una cuenta corriente: renglón por renglón hasta llegar al total.
//
// Se muestra TODO el histórico, no sólo lo pendiente: para discutir un saldo con
// el proveedor hace falta ver también lo que ya se pagó.
router.get('/cc-proveedores/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const p = db.prepare(`SELECT id, razon_social, cuit, COALESCE(saldo_inicial,0) AS saldo_inicial,
        tipo_fiscal_habitual, condicion_pago_habitual_id, activo
      FROM sg_proveedores WHERE id=?`).get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'Proveedor no encontrado' });

    const movs = [];
    // El punto de partida. Va primero y sin fecha: es lo que se le debía cuando
    // arrancó el sistema.
    if (p.saldo_inicial) {
      movs.push({ tipo: 'apertura', fecha: null, detalle: 'Saldo de apertura',
        comprobante: null, partidas: null, debe: 0, haber: r2(p.saldo_inicial), estado: null });
    }

    // ── SÓLO LO QUE ESTÁ EN EL LIBRO ─────────────────────────────────────
    // La cuenta corriente refleja la contabilidad: hasta que la factura no
    // tiene su asiento, no hay deuda registrada y acá no figura. Una factura
    // cargada y sin contabilizar —o con el asiento anulado— se informa aparte,
    // abajo, para que se sepa que está esperando, pero no mueve el saldo.
    const facturas = db.prepare(`SELECT f.id, f.fecha_emision, f.tipo_comprobante, f.punto_venta,
        f.numero, f.neto, f.iva_monto, f.total, COALESCE(f.saldo_pagado,0) AS pagado,
        COALESCE(f.saldo_pagado_gestion,0) AS pagado_gestion,
        COALESCE(f.dif_gestion,0) AS dif_gestion, f.dif_motivo,
        f.asiento_id, a.fecha AS asiento_fecha,
        (SELECT GROUP_CONCAT(o.trazabilidad, ' · ') FROM sg_factura_compra_ocs fo
           JOIN sg_oc o ON o.id = fo.oc_id WHERE fo.factura_id = f.id) AS partidas
      FROM sg_facturas_compra f
      JOIN sg_asientos a ON a.id = f.asiento_id AND COALESCE(a.anulado,0) = 0
      WHERE f.proveedor_id = ? AND f.activo = 1
      ORDER BY f.fecha_emision, f.id`).all(p.id);
    // Lo mismo que en el listado, con la misma regla: el pago cancela
    // proporcionalmente lo facturado y lo que no. Se calcula acá para que la
    // ficha y el listado no puedan dar números distintos — que es justo lo que
    // pasaba antes.
    // Cada mitad con LO SUYO pagado: el pago dice contra qué parte va, así que
    // no hay nada que prorratear. El saldo de apertura es fiscal — es el punto
    // de partida declarado.
    const saldos = { fiscal: r2(p.saldo_inicial), gestion: 0 };
    for (const f of facturas) {
      const pagGes = r2(f.pagado_gestion);
      saldos.gestion = r2(saldos.gestion + r2((f.dif_gestion || 0) - pagGes));
      saldos.fiscal = r2(saldos.fiscal + r2((f.total || 0) - r2((f.pagado || 0) - pagGes)));
    }
    const TIPO = { factura_a: 'Factura A', factura_b: 'Factura B', liquidacion: 'Liquidación' };
    for (const f of facturas) {
      movs.push({ tipo: 'factura', fecha: f.fecha_emision, factura_id: f.id,
        detalle: TIPO[f.tipo_comprobante] || f.tipo_comprobante || 'Comprobante',
        comprobante: (f.punto_venta ? f.punto_venta + '-' : '') + (f.numero || ''),
        partidas: f.partidas, neto: f.neto, iva: f.iva_monto,
        debe: 0, haber: r2(f.total),
        pagado: r2((f.pagado || 0) - (f.pagado_gestion || 0)),
        asiento_id: f.asiento_id, estado: null, ambito: 'fiscal' });
      // ── LO QUE FALTA POR FACTURAR, EN SU PROPIO RENGLÓN ────────────────
      // El listado ya sumaba la diferencia al saldo y la ficha no: el listado
      // decía 4.460.000 y la ficha 2.210.000 para el mismo proveedor. Y el que
      // discute un saldo mira la FICHA. Va como renglón aparte —no sumado al
      // del comprobante— porque son dos cosas distintas: una está facturada y
      // la otra no.
      // En las DOS direcciones. Con la factura por más de lo acordado el renglón
      // va al debe: le debemos menos de lo que dice el comprobante.
      if (f.dif_gestion) {
        const dg = r2(f.dif_gestion);
        movs.push({ tipo: 'factura', fecha: f.fecha_emision,
          detalle: (dg > 0 ? 'Falta por facturar' : 'Facturado de más')
                 + (f.dif_motivo ? ' — ' + MOTIVOS_TXT(f.dif_motivo) : ''),
          comprobante: (f.punto_venta ? f.punto_venta + '-' : '') + (f.numero || ''),
          partidas: f.partidas, neto: null, iva: null,
          debe: dg > 0 ? 0 : Math.abs(dg), haber: dg > 0 ? dg : 0,
          pagado: r2(f.pagado_gestion),
          asiento_id: f.asiento_id, estado: null, ambito: 'gestion' });
      }
    }

    // Y lo que entró pero todavía no tiene comprobante: no es deuda documentada,
    // pero se le debe igual y por eso está en el saldo. Mismo criterio que el
    // listado: sólo las órdenes SIN factura activa.
    // LOS PAGOS, con su fecha de verdad y las facturas que cancelaron. Antes se
    // derivaban del saldo pagado de cada factura y salían con la fecha de la
    // factura, que es cualquier cosa: un pago a 30 días figuraba el mismo día
    // que la compra.
    const pagos = db.prepare(`SELECT p.id, p.fecha, p.monto, p.forma_pago, p.referencia,
        fc.nombre AS cuenta_nombre,
        COALESCE((SELECT SUM(pc.monto) FROM sg_pagos_compras pc WHERE pc.pago_id = p.id), 0) AS imputado,
        (SELECT GROUP_CONCAT((CASE WHEN f.punto_venta IS NOT NULL AND f.punto_venta <> ''
                                   THEN f.punto_venta || '-' ELSE '' END) || f.numero, ' · ')
           FROM sg_pagos_compras pc JOIN sg_facturas_compra f ON f.id = pc.compra_id
          WHERE pc.pago_id = p.id) AS facturas
      FROM sg_pagos_proveedores p
      LEFT JOIN sg_fin_cuentas fc ON fc.id = p.cuenta_fin_id
      WHERE p.proveedor_id = ? AND COALESCE(p.anulado,0) = 0
      ORDER BY p.fecha, p.id`).all(p.id);
    for (const pg of pagos) {
      const aCta = r2((pg.monto || 0) - (pg.imputado || 0));
      movs.push({ tipo: aCta > 0 && !pg.facturas ? 'anticipo' : 'pago', fecha: pg.fecha,
        detalle: (aCta > 0 && !pg.facturas ? 'Anticipo' : 'Pago')
          + (pg.cuenta_nombre ? ' · ' + pg.cuenta_nombre : ''),
        comprobante: pg.referencia || null,
        partidas: pg.facturas || (aCta > 0 ? 'a cuenta' : null),
        pago_id: pg.id, a_cuenta: aCta > 0 ? aCta : 0,
        debe: r2(pg.monto), haber: 0, estado: aCta > 0 ? 'a cuenta' : null });
    }

    // ── LO QUE ESTÁ ESPERANDO ENTRAR AL LIBRO ────────────────────────────
    // No son movimientos de la cuenta —no hay asiento, no hay deuda registrada—
    // pero el que mira el saldo tiene que saber que hay comprobantes cargados
    // sin contabilizar, o quedaría creyendo que no se le debe nada.
    const esperando = db.prepare(`SELECT f.id, f.fecha_emision, f.tipo_comprobante,
        f.punto_venta, f.numero, f.total,
        (SELECT an.anulado_en FROM sg_asientos an
          WHERE an.ref_compra_id = f.id AND an.anulado = 1 ORDER BY an.id DESC LIMIT 1) AS anulado_en,
        COALESCE(o.trazabilidad, o.numero) AS partida
      FROM sg_facturas_compra f
      LEFT JOIN sg_oc o ON o.id = f.oc_id
      WHERE f.proveedor_id = ? AND f.activo = 1
        AND (f.asiento_id IS NULL
             OR EXISTS (SELECT 1 FROM sg_asientos a2 WHERE a2.id = f.asiento_id AND a2.anulado = 1))
      ORDER BY f.fecha_emision, f.id`).all(p.id);

    // El saldo corriendo. Los sin fecha (la apertura) van primero.
    movs.sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')));
    let saldo = 0;
    for (const m of movs) { saldo = r2(saldo + (m.haber || 0) - (m.debe || 0)); m.saldo = saldo; }

    res.json({ ok: true, data: { proveedor: p, movimientos: movs, saldo,
      saldo_fiscal: saldos.fiscal, saldo_gestion: saldos.gestion,
      esperando_contabilizar: esperando,
      total_esperando: r2(esperando.reduce((a, x) => a + (Number(x.total) || 0), 0)) } });
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
const EMB_CONCEPTOS = ['costo_mercaderia','anticipo_impuesto','gastos_despachante','fletes','gastos_bancarios','iva_credito_computable','percepcion_iva_computable','percepcion_iibb'];
const EMB_CREDITOS  = new Set(['iva_credito_computable','percepcion_iva_computable','percepcion_iibb']);

// Cálculo del embarque (server-side). Todos los montos se llevan a ARS con tc (real ?? estimado)
// para los rubros en USD. Usa COALESCE(monto_real, monto_estimado) como monto EFECTIVO.
// soloEstimado=true fuerza la mirada PROYECTADA: montos estimados y tc estimado, ignorando
// todo lo real. Es contra esto que se compara el cierre para saber si la cotización afinó.
// Fecha estimada de pago de un rubro. Se expresa como "N días desde un hito" para que si el
// barco se corre, la fecha —y con ella el TC— se recalculen solos. null = sin condición
// cargada (o falta el hito), y entonces el TC cae al de hoy.
function fechaPagoRubro(emb, c) {
  if (c.pago_ancla === 'fija') return c.pago_fecha || null;
  // Sin días cargados NO hay condición de pago. Sin este corte, un rubro al que nadie le
  // cargó nada caía igual en la rama de la ETA y se costeaba como si se pagara el día de la
  // llegada, que es una fecha que nadie eligió.
  if (c.pago_dias == null || c.pago_dias === '') return null;
  const base = c.pago_ancla === 'etd' ? emb.fecha_etd : emb.fecha_eta;
  if (!base) return null;
  const d = new Date(Date.parse(String(base).slice(0, 10) + 'T00:00:00Z'));
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + (Number(c.pago_dias) || 0));
  return d.toISOString().slice(0, 10);
}

function calcEmbarque(emb, costos, soloEstimado) {
  const db = getDb();
  const hoy = db.prepare("SELECT date('now','localtime') d").get().d;
  // Override manual del embarque. tc_estimado dejó de ser obligatorio: si está cargado pisa
  // la curva para todos los rubros (pago anticipado ya hecho, TC pactado con el proveedor).
  const override = soloEstimado
    ? (emb.tc_estimado != null ? Number(emb.tc_estimado) : null)
    : (emb.tc_real != null ? Number(emb.tc_real) : (emb.tc_estimado != null ? Number(emb.tc_estimado) : null));

  // TC de cada rubro: el de la curva en su fecha de pago.
  // LA REGLA DEL VENCIDO: si la fecha ya pasó y todavía no se pagó, no se puede seguir
  // usando el dólar de una fecha vieja — el TC sigue rodando al de hoy hasta que se pague.
  const tcCache = {};
  const tcDeRubro = (c) => {
    if (override != null) return { tc: override, modo: 'manual' };
    const f = fechaPagoRubro(emb, c);
    const vencido = !!(f && f < hoy);
    const fTC = (f && !vencido) ? f : hoy;
    if (tcCache[fTC] === undefined) tcCache[fTC] = tcEsperadoEnFecha(db, fTC);
    const r = tcCache[fTC];
    return { tc: r.tc, modo: r.modo, fecha_pago: f, fecha_tc: fTC, vencido, sin_condicion: !f };
  };

  let bruto = 0, creditos = 0, total_estimado = 0, total_real = 0, gap_total = 0;
  const tc_por_concepto = {};
  // Rubros en dólares para los que NO hay TC (curva vacía en esa fecha y sin override manual).
  // Sin esto, un monto en USD se sumaba tal cual al total y se mostraba como si fueran pesos:
  // un FOB de USD 19.500 aparecía como "$19.500 · costo por caja $19,50". Mil veces menos.
  const sin_tc = [];
  const detalle = costos.map(c => {
    const esUSD = (c.moneda || 'ARS') === 'USD';
    const info = esUSD ? tcDeRubro(c) : { tc: null, modo: 'no_aplica' };
    if (esUSD) {
      tc_por_concepto[c.concepto] = info.tc;
      if (info.tc == null && (c.monto_estimado != null || c.monto_real != null)) sin_tc.push(c.concepto);
    }
    const est = c.monto_estimado == null ? null
      : (esUSD && info.tc ? (Number(c.monto_estimado) || 0) * info.tc : (Number(c.monto_estimado) || 0));
    // El REAL se carga en pesos: es lo que salió de la caja, tal como figura en el extracto.
    // moneda_real existe por si algún día se paga desde una cuenta en dólares.
    const monReal = c.moneda_real || 'ARS';
    const real = c.monto_real == null ? null
      : ((monReal === 'USD' && info.tc) ? (Number(c.monto_real) || 0) * info.tc : (Number(c.monto_real) || 0));
    // COALESCE(real, estimado) — salvo en la mirada proyectada, que ignora lo real a propósito.
    const efectivo = soloEstimado ? (est != null ? est : 0)
                                  : (real != null ? real : (est != null ? est : 0));
    if (c.es_credito) creditos += efectivo; else bruto += efectivo;
    if (est != null) total_estimado += est;
    if (real != null) total_real += real;
    const gap = (real != null && est != null) ? real - est : null;
    if (gap != null) gap_total += gap;
    return { ...c, monto_estimado_ars: est, monto_real_ars: real, efectivo_ars: efectivo, gap,
      tc_rubro: info.tc, tc_modo: info.modo, fecha_pago: info.fecha_pago || null,
      tc_vencido: !!info.vencido, tc_sin_condicion: !!info.sin_condicion };
  });
  // tc_aplicado queda como el de la mercadería, que es el rubro que manda en el costo. Ya no
  // existe "el TC del embarque": cada rubro tiene el suyo según cuándo se paga.
  const tc = tc_por_concepto.costo_mercaderia != null ? tc_por_concepto.costo_mercaderia : override;
  const neto  = bruto - creditos;
  const cajas = Number(emb.cantidad_cajas) || 0;
  // Si falta algún TC, el total NO está en pesos: es una mezcla de pesos y dólares y no
  // significa nada. Los derivados quedan en null a propósito, para que la pantalla muestre
  // "—" en vez de un número mil veces menor, y para que recibir/cerrar se bloqueen solos
  // (los dos abortan cuando costo_caja_neto viene null).
  const convertible = sin_tc.length === 0;
  const costo_caja_neto        = (convertible && cajas > 0) ? neto  / cajas : null;
  const costo_caja_c_impuestos = (convertible && cajas > 0) ? bruto / cajas : null;
  // La diferencia de cotización NO se carga como rubro: sale sola. Es el desvío de los
  // rubros en DÓLARES (pagaste distinto a lo que esperabas porque el dólar se movió); el de
  // los rubros en pesos es otra cosa —facturaron distinto— y va separado.
  // No se pueden separar más fino: el real se carga en pesos, así que no sabemos si además
  // cambió el monto en dólares.
  let dif_cotizacion = 0, dif_costos = 0;
  detalle.forEach(d => {
    if (d.gap == null) return;
    if ((d.moneda || 'ARS') === 'USD') dif_cotizacion += d.gap; else dif_costos += d.gap;
  });
  return { bruto, creditos, neto, costo_caja_neto, costo_caja_c_impuestos,
    dif_cotizacion, dif_costos, total_estimado, total_real, gap_total, tc_aplicado: tc,
    tc_por_concepto, tc_manual: override != null, convertible, sin_tc, detalle };
}

// ── ESTIMADOR DE IMPORTACIÓN ────────────────────────────────────────────────────────
// Espeja la planilla del equipo. Se cargan 5 números y todo lo demás sale solo:
//   invoice USD · flete declarado USD · seguro USD · flete real USD · gastos bancarios USD
//
// BASE IMPONIBLE = (invoice + flete declarado + seguro) × TC de hoy. Es base de cálculo de
// IMPUESTOS, no un costo: el flete declarado sirve para liquidar aduana, y lo que sale del
// bolsillo es la factura del fletero (el flete real). Contar los dos inflaba el camión por
// el flete declarado entero — en el ejemplo del equipo, $3.000.000 sobre $31.606.268.
//
// Los impuestos y el despachante se pagan al CONTADO (TC de hoy). La mercadería, el flete y
// los bancarios van a plazo, así que se valorizan al TC de SU fecha de pago. La diferencia
// entre las dos miradas es la diferencia de cambio, que se muestra desglosada.
function paramsImportacion(db) {
  const p = { iva_pct: 10.5, iibb_pct: 0.69, despachante_pct: 0.7, iva_servicios_pct: 21,
              tasa_maria_usd: 110, gastos_bancarios_usd: 90 };
  const map = { imp_iva_pct: 'iva_pct', imp_iibb_pct: 'iibb_pct', imp_despachante_pct: 'despachante_pct',
                imp_iva_servicios_pct: 'iva_servicios_pct', imp_tasa_maria_usd: 'tasa_maria_usd',
                imp_gastos_bancarios_usd: 'gastos_bancarios_usd' };
  try {
    for (const r of db.prepare("SELECT clave, valor FROM sg_config WHERE clave LIKE 'imp_%'").all()) {
      if (map[r.clave] && r.valor != null && r.valor !== '' && !isNaN(Number(r.valor))) p[map[r.clave]] = Number(r.valor);
    }
  } catch (_) { /* sin config: quedan los defaults */ }
  return p;
}

// Lo que dicen los papeles, por rubro. Si un rubro está acá, su número le gana al cálculo.
// La regla vale para todos por igual, así que se resuelve una vez y no rubro por rubro.
function embReales(db, embId) {
  if (!embId) return {};
  return db.prepare('SELECT * FROM sg_embarque_reales WHERE embarque_id=? AND activo=1').all(embId)
    .reduce((m, r) => { m[r.rubro] = r; return m; }, {});
}

function calcImportacion(db, emb, costos, kgOverride) {
  const p = paramsImportacion(db);
  const hoy = db.prepare("SELECT date('now','localtime') d").get().d;
  const override = emb.tc_real != null ? Number(emb.tc_real)
                 : (emb.tc_estimado != null ? Number(emb.tc_estimado) : null);
  const tcHoy = override != null ? override : tcEsperadoEnFecha(db, hoy).tc;
  const rubro = k => costos.find(c => c.concepto === k) || {};
  // El papel manda: si el rubro ya tiene su documento, se usa el monto confirmado y no el
  // estimado. El estimado se conserva para poder ver el desvío.
  const usdDe = c => {
    if (c.monto_confirmado != null && c.monto_confirmado !== '') return Number(c.monto_confirmado);
    return (c.monto_estimado != null && c.monto_estimado !== '') ? Number(c.monto_estimado) : 0;
  };
  // TC de un rubro a plazo: el de su fecha de pago; si venció sin pagarse, sigue rodando a hoy.
  const tcDe = (c) => {
    if (override != null) return override;
    const f = fechaPagoRubro(emb, c);
    const fTC = (f && f >= hoy) ? f : hoy;
    return tcEsperadoEnFecha(db, fTC).tc;
  };

  // ── EL PAPEL LE GANA AL CÁLCULO ──────────────────────────────────────────────────
  // Un rubro con papel deja de estimarse. Tres formas de llegar a los pesos:
  //   • ARS      → el número del papel, tal cual (factura de flete, despachante, swift)
  //   • USD + tc → el papel trae su propia cotización (el despacho, a la oficialización)
  //   • USD      → sin cotización propia: la pone la curva por fecha de pago (el invoice)
  const reales = embReales(db, emb.id);
  const realDe = (k, tcCurva) => {
    const r = reales[k];
    if (!r) return null;
    const monto = Number(r.monto) || 0;
    if (r.moneda === 'ARS') return { ars: r2(Number(r.monto_ars) || 0), ...r, monto };
    const tc = r.tc != null ? Number(r.tc) : tcCurva;
    return { ars: tc == null ? null : r2(monto * tc), ...r, monto, tc };
  };
  const esReal = k => !!reales[k];

  const rMerc = rubro('costo_mercaderia'), rFlete = rubro('fletes'), rBanc = rubro('gastos_bancarios');
  // Estimado vs papel, para mostrar si la cotización afinó. Solo tiene sentido con los dos.
  const desvioDe = (c) => {
    const est = (c.monto_estimado != null && c.monto_estimado !== '') ? Number(c.monto_estimado) : null;
    const con = (c.monto_confirmado != null && c.monto_confirmado !== '') ? Number(c.monto_confirmado) : null;
    return { estimado_usd: est, confirmado_usd: con, confirmado: con != null,
             desvio_usd: (est != null && con != null) ? r2(con - est) : null };
  };
  // Los productos del camión. Se leen ACÁ, antes de todo lo que los usa: el valor de la
  // mercadería sale de ellos, y una const no se puede leer antes de su declaración.
  const lineasProd = emb.id ? db.prepare(`SELECT l.*, pr.nombre AS producto_nombre, pr.variedad AS producto_variedad
      FROM sg_embarque_lineas l LEFT JOIN sg_productos pr ON pr.id = l.producto_id
      WHERE l.embarque_id=? AND l.activo=1 ORDER BY l.id`).all(emb.id) : [];

  // El valor de la mercadería tiene hasta tres fuentes, y este es el orden:
  //   1. el PAPEL (monto_confirmado del invoice), que manda sobre todo
  //   2. el FOB de las líneas de producto (Σ cajas × precio), que es el dato más fino
  //   3. el monto cargado a mano en el rubro
  // Antes se usaba siempre el (3) mientras el prorrateo por producto usaba el (2): dos
  // fuentes distintas para lo mismo, y de ahí salían costos que no cerraban.
  const invoice_lineas = r2(lineasProd.reduce((a, l) =>
    a + (Number(l.cajas) || 0) * (Number(l.precio_unitario_usd) || 0), 0));
  const invoice_manual = usdDe(rMerc);
  const invoice_confirmado = (rMerc.monto_confirmado != null && rMerc.monto_confirmado !== '')
    ? Number(rMerc.monto_confirmado) : null;
  const invoice_usd = invoice_confirmado != null ? invoice_confirmado
                    : (invoice_lineas > 0 ? invoice_lineas : invoice_manual);
  const flete_base_usd  = Number(emb.flete_base_usd) || 0;
  const seguro_usd      = Number(emb.seguro_usd) || 0;
  // El flete puede pagarse EN PESOS: un fletero local factura en pesos, y ahí no hay nada
  // que valuar a ningún tipo de cambio. Antes se multiplicaba igual por el TC y el costo del
  // camión salía mil veces más caro sin que nada lo avisara.
  const flete_en_pesos  = rFlete.moneda === 'ARS';
  const flete_real_usd  = flete_en_pesos ? 0 : usdDe(rFlete);
  const flete_real_ars_directo = flete_en_pesos ? r2(usdDe(rFlete)) : null;
  // Los gastos bancarios no se tipean: son un monto FIJO en dólares por operación (no un
  // porcentaje del invoice), y se pagan junto con la mercadería, así que se valorizan al
  // mismo TC que ella.
  const bancarios_usd   = Number(p.gastos_bancarios_usd) || 0;

  const base_usd = invoice_usd + flete_base_usd + seguro_usd;
  const sinTc = tcHoy == null;
  const base_ars = sinTc ? null : r2(base_usd * tcHoy);

  // Impuestos y despachante: estimados al TC de hoy, salvo que ya haya papel.
  // El despacho de aduana escribe SIEMPRE los tres (IVA, IIBB, Tasa María); los que no
  // figuran liquidados van con CERO EXPLÍCITO. Por eso alcanza con mirar si hay real: si
  // el papel llegó, el cero también es dato del papel y no una estimación que falta.
  const rIva  = realDe('iva',  tcHoy), rIibb = realDe('iibb', tcHoy);
  const rTasa = realDe('tasa_maria', tcHoy), rDesp = realDe('despachante', tcHoy);
  const iva_ars  = rIva  ? rIva.ars  : (sinTc ? null : r2(base_ars * (p.iva_pct / 100)));
  const iibb_ars = rIibb ? rIibb.ars : (sinTc ? null : r2(base_ars * (p.iibb_pct / 100)));
  const tasa_maria_ars = rTasa ? rTasa.ars : (sinTc ? null : r2(p.tasa_maria_usd * tcHoy));
  const anticipos_ars = (iva_ars == null || iibb_ars == null || tasa_maria_ars == null)
    ? null : r2(iva_ars + iibb_ars + tasa_maria_ars);
  // La factura del despachante va ENTERA al costo, con su IVA adentro (decisión de Andy,
  // 20/8/2026). Cuando hay papel, la línea de IVA del despachante va a cero: no se borra,
  // se muestra en cero aclarando que está incluido — si desapareciera, el cuadro parecería
  // haber perdido un rubro y nadie sabría por qué.
  const despachante_ars = rDesp ? rDesp.ars : (sinTc ? null : r2(base_ars * (p.despachante_pct / 100)));
  const iva_desp_ars = rDesp ? 0 : (sinTc ? null : r2(despachante_ars * (p.iva_servicios_pct / 100)));

  // A plazo: cada uno al TC de su fecha de pago.
  const tcMerc = tcDe(rMerc), tcFlete = tcDe(rFlete), tcBanc = tcMerc;   // bancarios ↔ mercadería
  // Un rubro ya pagado EN PESOS no necesita ningún TC: no se puede reclamar una cotización
  // para algo que ya salió de la caja. Sin esto, un camión con el swift cargado seguiría
  // diciendo "falta TC" para siempre y no mostraría el costo.
  const pagadoEnPesos = k => !!(reales[k] && reales[k].moneda === 'ARS');
  const falta_tc = [];
  if (invoice_usd    && !pagadoEnPesos('mercaderia') && tcMerc  == null) falta_tc.push('Mercadería');
  if (flete_real_usd && !flete_en_pesos && !pagadoEnPesos('flete_real') && tcFlete == null) falta_tc.push('Flete real');
  // Los impuestos sólo necesitan el TC de hoy mientras se estimen. Con el despacho cargado
  // salen del papel y su cotización de oficialización.
  const impuestosDelPapel = esReal('iva') && esReal('iibb') && esReal('tasa_maria') && esReal('despachante');
  if (sinTc && (base_usd || p.tasa_maria_usd) && !impuestosDelPapel) falta_tc.push('Impuestos (TC de hoy)');

  // El swift paga la mercadería en PESOS: ahí desaparece la estimación de TC, porque ya no
  // queda nada que estimar. Lo mismo con la factura del flete. OJO: la BASE IMPONIBLE sigue
  // saliendo del invoice en dólares —es lo que se declaró en aduana— y no del swift.
  const rMercR = realDe('mercaderia', tcMerc), rFleteR = realDe('flete_real', tcFlete);
  const rBancR = realDe('bancarios', tcBanc);
  const merc_ars  = rMercR  ? rMercR.ars  : (tcMerc  == null ? null : r2(invoice_usd    * tcMerc));
  const flete_ars = rFleteR ? rFleteR.ars
    : (flete_en_pesos ? flete_real_ars_directo
    : (tcFlete == null ? null : r2(flete_real_usd * tcFlete)));
  // El swift trae el TOTAL de gastos e intereses bancarios, con su IVA adentro: mismo
  // criterio que el despachante.
  const banc_ars = rBancR ? rBancR.ars : (tcBanc == null ? null : r2(bancarios_usd * tcBanc));
  const iva_banc_ars = rBancR ? 0 : (banc_ars == null ? null : r2(banc_ars * (p.iva_servicios_pct / 100)));

  const convertible = falta_tc.length === 0;
  const sum = (...xs) => r2(xs.reduce((a, x) => a + (Number(x) || 0), 0));
  // Mirada CONTADO: todo al TC de hoy. Mirada A PLAZO: cada rubro al TC de su fecha.
  // CONTADO = qué habría costado pagando todo hoy. Un rubro YA PAGADO no entra en esa
  // pregunta: su número es el que es, y ponerle el TC de hoy inventaría una diferencia de
  // cambio sobre plata que ya salió.
  const contadoDe = (real, usd, arsCalc) => real ? real.ars : (usd != null ? r2(usd * tcHoy) : arsCalc);
  const total_contado = !convertible ? null
    : sum(contadoDe(rMercR, invoice_usd, merc_ars), anticipos_ars, despachante_ars, iva_desp_ars,
          contadoDe(rFleteR, flete_en_pesos ? null : flete_real_usd, flete_ars),
          rBancR ? rBancR.ars : r2(bancarios_usd * tcHoy),
          rBancR ? 0 : r2((bancarios_usd * tcHoy) * (p.iva_servicios_pct / 100)));
  const total_plazo = !convertible ? null
    : sum(merc_ars, anticipos_ars, despachante_ars, iva_desp_ars, flete_ars, banc_ars, iva_banc_ars);

  const cajas = Number(emb.cantidad_cajas) || 0;
  // El preview manda los kg directo (el embarque puede no estar guardado todavía).
  const kg = kgOverride != null ? (Number(kgOverride) || 0)
    : (emb.id ? (db.prepare(`SELECT COALESCE(SUM(cajas * COALESCE(kg_por_bulto,0)),0) kg
        FROM sg_embarque_lineas WHERE embarque_id=? AND activo=1`).get(emb.id).kg || 0) : 0);

  return {
    parametros: p, tc_hoy: tcHoy, tc_manual: override != null, convertible, falta_tc,
    invoice_origen: invoice_confirmado != null ? 'documento' : (invoice_lineas > 0 ? 'lineas' : 'manual'),
    invoice_lineas,
    // Si el papel dice una cosa y los productos suman otra, hay que mirarlo: uno de los dos
    // está mal cargado y el costo por producto se reparte sobre el que manda.
    invoice_discrepancia: (invoice_confirmado != null && invoice_lineas > 0
      && Math.abs(invoice_confirmado - invoice_lineas) > 0.01) ? r2(invoice_confirmado - invoice_lineas) : null,
    flete_en_pesos,
    usd: { invoice: invoice_usd, flete_base: flete_base_usd, seguro: seguro_usd,
           flete_real: flete_real_usd, bancarios: bancarios_usd, base: base_usd },
    base_ars,
    // Cada línea dice si su número salió de un PAPEL o de una cuenta, y qué papel fue. Sin
    // eso el cuadro muestra nueve números iguales y no hay forma de saber cuáles ya están
    // cerrados y cuáles todavía se mueven — que es lo único que se quiere mirar cuando se
    // está esperando la documentación de un camión.
    lineas: (() => {
      // Lo que HABRÍA dado la estimación, para poder mostrar el desvío contra el papel.
      const estIva  = sinTc ? null : r2(base_ars * (p.iva_pct / 100));
      const estIibb = sinTc ? null : r2(base_ars * (p.iibb_pct / 100));
      const estTasa = sinTc ? null : r2(p.tasa_maria_usd * tcHoy);
      const estDesp = sinTc ? null : r2(base_ars * (p.despachante_pct / 100));
      const papel = (r, estimadoArs) => !r ? { real: false } : {
        real: true, origen: r.origen || null, documento_id: r.documento_id || null,
        real_monto: Number(r.monto), real_moneda: r.moneda, real_tc: r.tc != null ? Number(r.tc) : null,
        estimado_ars: estimadoArs,
        desvio_ars: (estimadoArs != null && r.ars != null) ? r2(r.ars - estimadoArs) : null,
      };
      return [
      { k: 'mercaderia',  label: 'Mercadería (invoice)',  usd: invoice_usd,    tc: tcMerc,  ars: merc_ars,        plazo: true,  fecha_pago: fechaPagoRubro(emb, rMerc), ...desvioDe(rMerc), ...papel(rMercR, tcMerc == null ? null : r2(invoice_usd * tcMerc)) },
      { k: 'iva',         label: 'IVA ' + (rIva ? '(del despacho)' : p.iva_pct + '%'), usd: null, tc: tcHoy, ars: iva_ars, plazo: false, detalle: rIva ? 'liquidado en el despacho' : 'sobre la base imponible', ...papel(rIva, estIva) },
      { k: 'iibb',        label: 'IIBB ' + (rIibb ? '(del despacho)' : p.iibb_pct + '%'), usd: null, tc: tcHoy, ars: iibb_ars, plazo: false, detalle: rIibb ? 'liquidado en el despacho' : 'sobre la base imponible', ...papel(rIibb, estIibb) },
      { k: 'tasa_maria',  label: 'Tasa María',            usd: rTasa ? null : p.tasa_maria_usd, tc: tcHoy, ars: tasa_maria_ars,  plazo: false, detalle: rTasa ? 'liquidada en el despacho' : null, ...papel(rTasa, estTasa) },
      { k: 'despachante', label: 'Despachante' + (rDesp ? ' (factura)' : ' ' + p.despachante_pct + '%'), usd: null, tc: tcHoy, ars: despachante_ars, plazo: false, detalle: rDesp ? 'la factura entera, con IVA adentro' : 'sobre la base imponible', ...papel(rDesp, estDesp) },
      { k: 'iva_desp',    label: 'IVA despachante ' + (rDesp ? '' : p.iva_servicios_pct + '%'), usd: null, tc: tcHoy, ars: iva_desp_ars, plazo: false, detalle: rDesp ? 'ya incluido en la factura de arriba' : null, real: !!rDesp },
      { k: 'flete_real',  label: 'Flete real',            usd: flete_en_pesos ? null : flete_real_usd, tc: flete_en_pesos ? null : tcFlete, ars: flete_ars, plazo: !flete_en_pesos, detalle: flete_en_pesos ? 'facturado en pesos' : null, fecha_pago: flete_en_pesos ? null : fechaPagoRubro(emb, rFlete), ...desvioDe(rFlete), ...papel(rFleteR, tcFlete == null ? null : r2(flete_real_usd * tcFlete)) },
      { k: 'bancarios',   label: 'Gastos bancarios',      usd: rBancR ? null : bancarios_usd,  tc: tcBanc,  ars: banc_ars,        plazo: true,  detalle: rBancR ? 'del swift, con intereses e IVA adentro' : 'monto fijo · al TC de la mercadería', fecha_pago: fechaPagoRubro(emb, rMerc), ...papel(rBancR, tcBanc == null ? null : r2(bancarios_usd * tcBanc)) },
      { k: 'iva_banc',    label: 'IVA bancarios ' + (rBancR ? '' : p.iva_servicios_pct + '%'), usd: null, tc: tcBanc, ars: iva_banc_ars, plazo: true, detalle: rBancR ? 'ya incluido en el swift' : null, real: !!rBancR }
      ];
    })(),
    // Qué papeles ya llegaron. Es lo que deja decir "faltan dos" sin abrir el expediente.
    reales_cargados: Object.keys(reales),
    total_contado, total_plazo,
    dif_cambio: (total_plazo == null || total_contado == null) ? null : total_plazo - total_contado,
    // Lo ya pagado no genera diferencia de cambio: se saca del detalle en vez de mostrar
    // un desvío inventado sobre plata que ya salió.
    dif_cambio_detalle: !convertible ? [] : [
      { label: 'Mercadería',       ars: rMercR  ? 0 : invoice_usd    * ((tcMerc  || tcHoy) - tcHoy) },
      { label: 'Flete real',       ars: (rFleteR || flete_en_pesos) ? 0 : flete_real_usd * ((tcFlete || tcHoy) - tcHoy) },
      { label: 'Gastos bancarios', ars: rBancR  ? 0 : bancarios_usd  * ((tcBanc  || tcHoy) - tcHoy) * (1 + p.iva_servicios_pct / 100) }
    ].filter(x => Math.abs(x.ars) > 0.005),
    cajas, kg,
    // Prorrateo del costo entre los productos del camión. Dos bolsas, porque los costos no
    // se comportan igual:
    //   • POR VALOR: impuestos y despachante son % de la base imponible, así que una caja
    //     que vale más paga más. Se reparten según el FOB de cada línea.
    //   • POR CAJA: flete, Tasa María y bancarios no miran el valor de lo que viene adentro.
    //     Se reparten parejo por caja.
    // Repartir todo por caja aplanaría el costo y haría que el producto caro parezca barato
    // y el barato caro — justo al revés de lo que sirve para poner precio.
    por_producto: (() => {
      if (!convertible || !lineasProd.length || total_plazo == null) return [];
      // El FOB de las líneas se usa como PESO RELATIVO, nunca como monto absoluto. Antes se
      // sumaba en pesos y se dejaba que el último producto absorbiera la diferencia contra el
      // total: si el invoice cargado no coincidía con el FOB de las líneas —que es lo normal,
      // son dos datos distintos— esa diferencia era enorme y el último producto salía con
      // costo NEGATIVO. Repartiendo por proporción, la suma da el total por construcción.
      const fobs = lineasProd.map(l => (Number(l.cajas) || 0) * (Number(l.precio_unitario_usd) || 0));
      const fobTot = fobs.reduce((a, b) => a + b, 0);
      const cajasTot = lineasProd.reduce((a, l) => a + (Number(l.cajas) || 0), 0);
      // Sin precios por línea no hay cómo distinguir por valor: se reparte todo por caja.
      const hayValor = fobTot > 0;
      const bolsaValor = sum(merc_ars, anticipos_ars, despachante_ars, iva_desp_ars) - r2(tasa_maria_ars);
      const bolsaCaja  = sum(flete_ars, banc_ars, iva_banc_ars, tasa_maria_ars);
      const filas = lineasProd.map((l, i) => {
        const cj = Number(l.cajas) || 0;
        const pc = cajasTot > 0 ? cj / cajasTot : 0;
        const pv = hayValor ? fobs[i] / fobTot : pc;
        const porValor = r2(bolsaValor * pv), porCaja = r2(bolsaCaja * pc);
        return { linea_id: l.id, producto: l.producto_nombre || ('#' + l.producto_id),
                 variedad: l.producto_variedad || null, cajas: cj, kg: cj * (Number(l.kg_por_bulto) || 0),
                 fob_usd_caja: l.precio_unitario_usd != null ? Number(l.precio_unitario_usd) : null,
                 fob_usd: r2(fobs[i]), peso_valor: r2(pv * 100), peso_caja: r2(pc * 100),
                 por_valor_ars: porValor, por_caja_ars: porCaja,
                 costo_ars: r2(porValor + porCaja) };
      });
      // Sobra o falta algún centavo por redondeo: lo absorbe el producto más grande, donde
      // menos se nota. Si la diferencia fuera grande sería un error de cálculo, no redondeo,
      // así que se deja como está y se ve — antes esto tapaba justamente eso.
      const acum = r2(filas.reduce((a, x) => a + x.costo_ars, 0));
      const resto = r2(total_plazo - acum);
      if (Math.abs(resto) > 0.001 && Math.abs(resto) < 1) {
        let mayor = 0;
        filas.forEach((x, i) => { if (x.costo_ars > filas[mayor].costo_ars) mayor = i; });
        filas[mayor].costo_ars = r2(filas[mayor].costo_ars + resto);
      }
      return filas.map(x => ({ ...x,
        costo_caja: x.cajas > 0 ? r2(x.costo_ars / x.cajas) : null,
        costo_kg:   x.kg    > 0 ? r2(x.costo_ars / x.kg)    : null }));
    })(),
    // Lo que se negoció con el proveedor, por caja: es el número con el que se habla.
    precio_caja_usd: cajas > 0 ? r2(invoice_usd / cajas) : null,
    costo_caja: (total_plazo != null && cajas > 0) ? total_plazo / cajas : null,
    costo_kg:   (total_plazo != null && kg > 0)    ? total_plazo / kg    : null
  };
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
// Costo de cada lote al recibir. Usa el MISMO prorrateo que muestra el estimador
// (calcImportacion.por_producto): si difirieran, la ficha diría un costo y el lote otro.
function costoBaseLineasEmbarque(emb, costos, lineas) {
  const db = getDb();
  const est = calcImportacion(db, emb, costos);
  const porLinea = {};
  (est.por_producto || []).forEach(x => { porLinea[x.linea_id] = x.costo_ars; });
  const bases = lineas.map(l => Number(porLinea[l.id]) || 0);
  // Red de seguridad: si el estimador no pudo prorratear (sin TC, sin productos), se cae al
  // reparto parejo por caja sobre el neto, para no dejar los lotes en cero.
  const suma = bases.reduce((a, b) => a + b, 0);
  const neto = est.total_plazo != null ? est.total_plazo : 0;
  if (!(suma > 0) && neto > 0) {
    const cajasTot = lineas.reduce((a, l) => a + (Number(l.cajas) || 0), 0);
    return lineas.map(l => cajasTot > 0 ? r2(neto * ((Number(l.cajas) || 0) / cajasTot)) : 0);
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
     presentacion_id, bultos, kg_por_bulto, envase_id, embarque_id, embarque_linea_id, creado_por)
    VALUES (?,?,?,?,?,?,?,?,?,'importado',?,?, 'disponible', ?, NULL, ?, ?, ?, ?, ?, ?)`)
    .run(codigo, null, null, linea.producto_id, kg, precio, base,
      val(linea.calidad), val(linea.calibre), fechaIngreso, venc, base, cajas, kpb, envId, emb.id, linea.id, userId);
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
    const kgPorEmb = db.prepare(`SELECT embarque_id, COALESCE(SUM(cajas * COALESCE(kg_por_bulto,0)),0) kg
      FROM sg_embarque_lineas WHERE activo=1 GROUP BY embarque_id`).all()
      .reduce((m, r) => { m[r.embarque_id] = r.kg; return m; }, {});
    const data = embs.map(e => {
      // El panel muestra el costo por caja PUESTO ACÁ, que es el número con el que se decide
      // a cuánto vender: sale del estimador, igual que la ficha y el visor.
      const est = calcImportacion(db, e, embCostos(db, e.id), kgPorEmb[e.id] || 0);
      return { ...e, costo_caja_puesto: est.costo_caja, precio_caja_usd: est.precio_caja_usd,
        total_plazo: est.total_plazo, convertible: est.convertible, falta_tc: est.falta_tc,
        kg_totales: kgPorEmb[e.id] || 0 };
    });
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DETALLE — cabecera + rubros + cálculo completo.
// ── PARÁMETROS DE IMPORTACIÓN ───────────────────────────────────────────────────────
// Las alícuotas y porcentajes del despacho, iguales para todas las importaciones.
const IMP_PARAMS = [
  ['imp_iva_pct', 'IVA sobre la base imponible', '%'],
  ['imp_iibb_pct', 'Percepción IIBB sobre la base imponible', '%'],
  ['imp_despachante_pct', 'Honorarios del despachante sobre la base imponible', '%'],
  ['imp_iva_servicios_pct', 'IVA de despachante y gastos bancarios', '%'],
  ['imp_tasa_maria_usd', 'Tasa María', 'USD'],
  ['imp_gastos_bancarios_usd', 'Gastos bancarios por operación', 'USD']
];

router.get('/importacion/parametros', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const vals = db.prepare("SELECT clave, valor FROM sg_config WHERE clave LIKE 'imp_%'").all()
      .reduce((m, r) => { m[r.clave] = r.valor; return m; }, {});
    res.json({ ok: true, data: IMP_PARAMS.map(([k, label, unidad]) => ({ clave: k, label, unidad, valor: vals[k] })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.put('/importacion/parametros', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    for (const [k, label] of IMP_PARAMS) {
      if (b[k] == null || b[k] === '') continue;
      if (!(Number(b[k]) >= 0)) return res.status(400).json({ ok: false, error: label + ': tiene que ser un número mayor o igual a cero' });
    }
    db.transaction(() => {
      const up = db.prepare(`INSERT INTO sg_config (clave, valor, modificado_en, modificado_por)
        VALUES (?,?,datetime('now','localtime'),?)
        ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor,
          modificado_en=excluded.modificado_en, modificado_por=excluded.modificado_por`);
      for (const [k] of IMP_PARAMS) if (b[k] != null && b[k] !== '') up.run(k, String(Number(b[k])), uid(req));
    })();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── CURVA DE TIPO DE CAMBIO ESPERADO ────────────────────────────────────────────────
// Qué esperamos del dólar mes a mes. El valor de cada mes es el esperado al CIERRE de ese
// mes, que es como vienen los futuros; entre meses se interpola día a día.
// Sirve para responder "¿a qué dólar voy a pagar esto?" sin que nadie tipee un TC.

// Último día del mes 'YYYY-MM' → 'YYYY-MM-DD'. Día 0 del mes siguiente es el último del actual.
function finDeMes(mes) {
  const [y, m] = String(mes).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
const diasEntre = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;

// TC esperado para una fecha. Fuera de los extremos NO extrapola: devuelve el valor del
// punto más cercano y avisa con `modo`, para que la pantalla pueda pedir que carguen más
// meses en vez de inventar un número que nadie estimó.
function tcEsperadoEnFecha(db, fechaIso) {
  const curva = db.prepare('SELECT mes, valor FROM sg_tc_esperado ORDER BY mes').all();
  if (!curva.length) return { tc: null, modo: 'sin_curva' };
  const puntos = curva.map(p => ({ fecha: finDeMes(p.mes), mes: p.mes, valor: Number(p.valor) }));
  const f = String(fechaIso || '').slice(0, 10);
  if (!f) return { tc: null, modo: 'sin_fecha' };
  const exacto = puntos.find(p => p.fecha === f);
  if (exacto) return { tc: exacto.valor, modo: 'exacto', mes: exacto.mes };
  const primero = puntos[0], ultimo = puntos[puntos.length - 1];
  if (f < primero.fecha) return { tc: primero.valor, modo: 'antes_de_la_curva', mes: primero.mes };
  if (f > ultimo.fecha)   return { tc: ultimo.valor,  modo: 'despues_de_la_curva', mes: ultimo.mes };
  for (let i = 1; i < puntos.length; i++) {
    const a = puntos[i - 1], b = puntos[i];
    if (f <= b.fecha) {
      const total = diasEntre(a.fecha, b.fecha);
      const tc = total > 0 ? a.valor + (b.valor - a.valor) * (diasEntre(a.fecha, f) / total) : b.valor;
      return { tc, modo: 'interpolado', entre: [a.mes, b.mes] };
    }
  }
  return { tc: ultimo.valor, modo: 'despues_de_la_curva', mes: ultimo.mes };
}

// GET /tc-esperado/curva — la curva completa.
router.get('/tc-esperado/curva', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const curva = db.prepare(`SELECT c.mes, c.valor, c.nota, c.modificado_en, u.nombre AS modificado_por_nombre
      FROM sg_tc_esperado c LEFT JOIN usuarios u ON u.id = c.modificado_por ORDER BY c.mes`).all();
    const hoy = db.prepare("SELECT date('now','localtime') d, strftime('%Y-%m','now','localtime') m").get();
    res.json({ ok: true, data: { curva, mes_actual: hoy.m, hoy: hoy.d,
      tc_hoy: tcEsperadoEnFecha(db, hoy.d) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PUT /tc-esperado/curva — reemplaza la curva completa (replace-all, como las líneas del embarque).
router.put('/tc-esperado/curva', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const filas = Array.isArray(req.body && req.body.curva) ? req.body.curva : [];
    for (const f of filas) {
      if (!/^\d{4}-\d{2}$/.test(String(f.mes || ''))) return res.status(400).json({ ok: false, error: 'Mes inválido: ' + f.mes + ' (se espera AAAA-MM)' });
      if (!(Number(f.valor) > 0)) return res.status(400).json({ ok: false, error: 'El valor de ' + f.mes + ' tiene que ser mayor a cero' });
    }
    const vistos = new Set();
    for (const f of filas) {
      if (vistos.has(f.mes)) return res.status(400).json({ ok: false, error: 'El mes ' + f.mes + ' está cargado dos veces' });
      vistos.add(f.mes);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM sg_tc_esperado').run();
      const ins = db.prepare(`INSERT INTO sg_tc_esperado (mes, valor, nota, modificado_en, modificado_por)
        VALUES (?,?,?,datetime('now','localtime'),?)`);
      for (const f of filas) ins.run(f.mes, Number(f.valor), (f.nota || '').trim() || null, uid(req));
    })();
    res.json({ ok: true, data: { meses: filas.length } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// GET /tc-esperado/en?fecha=AAAA-MM-DD — a qué dólar se paga algo ese día.
router.get('/tc-esperado/en', requireAuth, (req, res) => {
  const db = getDb();
  try { res.json({ ok: true, data: tcEsperadoEnFecha(db, req.query.fecha) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── TIPO DE CAMBIO ESPERADO (Importación) ───────────────────────────────────────────
// Un solo valor para todos los embarques que todavía son una proyección: se mueve el TC y
// se re-costean solos, en vez de entrar camión por camión a corregirlo a mano.
//
// OJO CON EL ORDEN: estas dos rutas van ANTES de /embarques/:id, si no Express matchea
// :id='tc-esperado' y nunca llegan.
//
// Qué alcanza y qué NO:
//   - 'cerrado' nunca: su costo ya es definitivo.
//   - con tc_real cargado nunca. No solo porque su costo sale del TC real, sino porque
//     tc_estimado es la base contra la que el cierre mide el desvío: pisarla borraría la
//     comparación proyectado vs real, que es justo lo que sirve para aprender a cotizar.
//   - 'recibido' solo si se pide expresamente, porque ahí ya hay lotes y mover el TC les
//     reescribe el costo.
const TC_ESPERADO_KEY = 'tc_esperado';

function embarquesAlcanzadosPorTc(db) {
  return db.prepare(`SELECT * FROM sg_embarques
    WHERE activo=1 AND eliminado_en IS NULL AND estado <> 'cerrado' AND tc_real IS NULL
    ORDER BY id`).all();
}

// GET /embarques/tc-esperado[?tc=1080] — valor guardado y, si mandás un tc, qué pasaría.
router.get('/embarques/tc-esperado', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const guardado = db.prepare('SELECT valor FROM sg_config WHERE clave=?').get(TC_ESPERADO_KEY);
    const nuevo = (req.query.tc != null && req.query.tc !== '') ? Number(req.query.tc) : null;
    const embs = embarquesAlcanzadosPorTc(db);
    const items = embs.map(e => {
      const costos = embCostos(db, e.id);
      const antes = calcEmbarque(e, costos);
      const desp  = nuevo != null ? calcEmbarque({ ...e, tc_estimado: nuevo }, costos) : null;
      const lotes = db.prepare('SELECT COUNT(*) n FROM sg_lotes WHERE embarque_id=? AND eliminado_en IS NULL').get(e.id).n;
      return { id: e.id, nombre: e.nombre, estado: e.estado, tc_actual: e.tc_estimado,
        cajas: e.cantidad_cajas, lotes,
        costo_caja_antes: antes.costo_caja_neto,
        costo_caja_despues: desp ? desp.costo_caja_neto : null,
        delta: (desp && desp.neto != null && antes.neto != null) ? desp.neto - antes.neto : null };
    });
    // Los excluidos se informan para que nadie se pregunte por qué su camión no se movió.
    const excluidos = db.prepare(`SELECT id, nombre, estado, tc_real FROM sg_embarques
      WHERE activo=1 AND eliminado_en IS NULL AND (estado='cerrado' OR tc_real IS NOT NULL)
      ORDER BY id`).all().map(e => ({ ...e,
        motivo: e.estado === 'cerrado' ? 'cerrado' : 'ya tiene TC real' }));
    res.json({ ok: true, data: {
      tc_guardado: guardado ? Number(guardado.valor) : null,
      tc_consultado: nuevo, items, excluidos,
      con_lotes: items.filter(i => i.lotes > 0).length
    } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// POST /embarques/tc-esperado — aplica el TC a los embarques alcanzados.
// incluir_recibidos=true además re-costea los lotes de los que ya entraron.
router.post('/embarques/tc-esperado', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const tc = Number(req.body && req.body.tc);
    if (!(tc > 0)) return res.status(400).json({ ok: false, error: 'El tipo de cambio tiene que ser un número mayor a cero' });
    const incluirRecibidos = !!(req.body && req.body.incluir_recibidos);
    const todos = embarquesAlcanzadosPorTc(db);
    const objetivo = todos.filter(e => e.estado !== 'recibido' || incluirRecibidos);
    let recosteados = 0, sinLinea = 0;
    const tx = db.transaction(() => {
      const up = db.prepare("UPDATE sg_embarques SET tc_estimado=?, modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?");
      for (const e of objetivo) {
        up.run(tc, uid(req), e.id);
        if (e.estado === 'recibido') {
          const r = recostearLotesEmbarque(db, { ...e, tc_estimado: tc }, uid(req));
          recosteados += r.recosteados; sinLinea += r.sin_linea;
        }
      }
      db.prepare(`INSERT INTO sg_config (clave, valor, modificado_en, modificado_por)
        VALUES (?,?,datetime('now','localtime'),?)
        ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor,
          modificado_en=excluded.modificado_en, modificado_por=excluded.modificado_por`)
        .run(TC_ESPERADO_KEY, String(tc), uid(req));
    });
    tx();
    res.json({ ok: true, data: { tc, actualizados: objetivo.length,
      omitidos_recibidos: todos.length - objetivo.length, lotes_recosteados: recosteados, lotes_sin_linea: sinLinea } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── ARCHIVO PLANO DE CAMIONES (Excel) ───────────────────────────────────────────────
// UNA FILA POR PRODUCTO DE CADA CAMIÓN, con todo el cabezal repetido al lado. Es la forma
// más plana posible: se abre en Excel, se filtra por lo que sea y se arma una tabla
// dinámica sin cruzar nada a mano.
//
// El grano es el PRODUCTO y no el camión porque el costo por caja —el número por el que
// existe este módulo— es por producto. Un archivo con una fila por camión no lo puede
// mostrar; y con este grano igual se saca el total del camión sumando o filtrando.
//
// Van TODAS las columnas a propósito: sobra información y se esconde la que no sirve, que
// es más fácil que pedir un export nuevo cada vez que falta un dato. Los importes salen
// como NÚMERO, sin símbolo ni separador de miles: con formato de texto Excel no los suma,
// y un archivo que no se puede sumar no sirve para esto.

// Semana ISO de una fecha, en UTC para que no se corra un día por zona horaria.
// Misma regla que sgCalSemana() del panel: la semana es la del jueves.
function semanaIso(iso) {
  if (!iso) return '';
  const d = new Date(Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z'));
  if (isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const ene4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  ene4.setUTCDate(ene4.getUTCDate() - ((ene4.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((d - ene4) / 604800000);
}

router.get('/embarques/export', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const soloId = req.query.embarque_id ? Number(req.query.embarque_id) : null;
    const embs = db.prepare(`SELECT e.*, p.razon_social AS proveedor_nombre
      FROM sg_embarques e LEFT JOIN sg_proveedores p ON p.id=e.proveedor_id
      WHERE e.activo=1 AND e.eliminado_en IS NULL ${soloId ? 'AND e.id=?' : ''}
      ORDER BY e.id DESC`).all(...(soloId ? [soloId] : []));

    const filas = [];
    for (const e of embs) {
      const est = calcImportacion(db, e, embCostos(db, e.id));
      const lineas = db.prepare(`SELECT l.*, pr.nombre AS producto_nombre, pr.variedad AS producto_variedad,
               en.nombre AS envase_nombre
        FROM sg_embarque_lineas l
        LEFT JOIN sg_productos pr ON pr.id=l.producto_id
        LEFT JOIN sg_envases en ON en.id=l.envase_id
        WHERE l.embarque_id=? AND l.activo=1 ORDER BY l.id`).all(e.id);
      const porProd = (est.por_producto || []).reduce((m, x) => { m[x.linea_id] = x; return m; }, {});
      const rub = k => (est.lineas || []).find(x => x.k === k) || {};
      const nn = v => (v == null ? '' : v);
      // El precio esperado de venta, por producto. Sin esto el archivo tiene el costo pero
      // no con qué compararlo, que es la mitad de para qué se baja.
      const precios = db.prepare('SELECT producto_id, precio_caja FROM sg_embarque_precios WHERE embarque_id=?')
        .all(e.id).reduce((m, r) => { m[r.producto_id] = r.precio_caja; return m; }, {});
      // Qué rubros ya salen de un papel y cuáles siguen estimados. Un costo confirmado y uno
      // proyectado no se pueden promediar juntos sin saber cuál es cuál.
      const conPapel = est.reales_cargados || [];
      const esPapel = k => (rub(k).real ? 'papel' : 'estimado');

      // Lo que no depende del producto se arma una vez y se repite en cada fila: eso es lo
      // que permite filtrar por cualquier cosa y seguir teniendo el costeo al lado.
      const cab = {
        camion_id: e.id,
        camion: e.nombre || '',
        estado: e.estado || '',
        proveedor: e.proveedor_nombre || '',
        pais_origen: e.pais_origen || '',
        incoterm: e.incoterm || '',
        ncm: e.ncm || '',
        cert_origen_mercosur: e.certificado_origen_mercosur ? 'si' : 'no',
        nro_invoice: e.nro_invoice || '',
        fecha_etd: e.fecha_etd || '',
        fecha_eta: e.fecha_eta || '',
        semana_etd: semanaIso(e.fecha_etd),
        semana_eta: semanaIso(e.fecha_eta),
        transporte_empresa: e.transporte_empresa || '',
        camion_patente: e.camion_patente || '',
        camion_acoplado: e.camion_acoplado || '',
        chofer_nombre: e.chofer_nombre || '',
        chofer_documento: e.chofer_documento || '',
        chofer_telefono: e.chofer_telefono || '',
        moneda: e.moneda || 'USD',
        tc_aplicado: nn(est.tc_hoy),
        tc_manual: est.tc_manual ? 'si' : 'no',
        // Si falta algún TC, el costo en pesos es una mezcla de pesos y dólares y no
        // significa nada: se deja vacío y se dice cuál falta, en vez de exportar un número
        // que alguien va a sumar creyendo que es plata.
        costeo_completo: est.convertible ? 'si' : 'no',
        falta_tc: (est.falta_tc || []).join(' / '),
        invoice_origen: est.invoice_origen || '',
        usd_invoice: est.usd.invoice || 0,
        usd_flete_base: est.usd.flete_base || 0,
        usd_seguro: est.usd.seguro || 0,
        usd_flete_real: est.usd.flete_real || 0,
        usd_bancarios: est.usd.bancarios || 0,
        usd_base_imponible: est.usd.base || 0,
        ars_base_imponible: nn(est.base_ars),
        ars_mercaderia: nn(rub('mercaderia').ars),
        ars_iva: nn(rub('iva').ars),
        ars_iibb: nn(rub('iibb').ars),
        ars_tasa_maria: nn(rub('tasa_maria').ars),
        ars_despachante: nn(rub('despachante').ars),
        ars_iva_despachante: nn(rub('iva_desp').ars),
        ars_flete_real: nn(rub('flete_real').ars),
        ars_bancarios: nn(rub('bancarios').ars),
        ars_iva_bancarios: nn(rub('iva_banc').ars),
        papeles_cargados: conPapel.length,
        papeles_rubros: conPapel.join(' / '),
        origen_mercaderia: esPapel('mercaderia'), origen_iva: esPapel('iva'),
        origen_iibb: esPapel('iibb'), origen_tasa_maria: esPapel('tasa_maria'),
        origen_despachante: esPapel('despachante'), origen_flete: esPapel('flete_real'),
        origen_bancarios: esPapel('bancarios'),
        ars_total_contado: nn(est.total_contado),
        ars_total_plazo: nn(est.total_plazo),
        ars_dif_cambio: est.dif_cambio != null ? r2(est.dif_cambio) : '',
        camion_cajas: est.cajas || 0,
        camion_kg: r2(est.kg || 0),
        ars_costo_caja_camion: est.costo_caja != null ? r2(est.costo_caja) : '',
        ars_costo_kg_camion: est.costo_kg != null ? r2(est.costo_kg) : '',
        observaciones: e.observaciones || '',
        creado_en: e.creado_en || '',
      };

      // Un camión sin productos cargados sale igual, con la fila marcada: si lo salteo,
      // desaparece del archivo y nadie se entera de que le falta la carga.
      if (!lineas.length) { filas.push({ ...cab, producto: '(sin productos cargados)' }); continue; }

      for (const l of lineas) {
        const pp = porProd[l.id] || {};
        const cajas = Number(l.cajas) || 0;
        filas.push({ ...cab,
          producto: l.producto_nombre || '',
          variedad: l.producto_variedad || '',
          envase: l.envase_nombre || '',
          cajas,
          kg_por_bulto: l.kg_por_bulto != null ? Number(l.kg_por_bulto) : '',
          kg: r2(cajas * (Number(l.kg_por_bulto) || 0)),
          fob_usd_caja: l.precio_unitario_usd != null ? Number(l.precio_unitario_usd) : '',
          fob_usd_total: nn(pp.fob_usd),
          pct_del_valor: nn(pp.peso_valor),
          pct_de_cajas: nn(pp.peso_caja),
          ars_costo_total: nn(pp.costo_ars),
          ars_costo_por_valor: nn(pp.por_valor_ars),
          ars_costo_por_caja_prorrateo: nn(pp.por_caja_ars),
          ars_costo_caja: nn(pp.costo_caja),
          ars_costo_kg: nn(pp.costo_kg),
          // Precio esperado y margen. El margen se calcula acá y no en Excel para que sea
          // el mismo número que muestra la ficha: dos fórmulas para lo mismo terminan
          // dando distinto y nadie sabe cuál mirar.
          ars_precio_venta_esperado: nn(precios[l.producto_id]),
          ars_margen_caja: (precios[l.producto_id] != null && pp.costo_caja != null)
            ? r2(Number(precios[l.producto_id]) - pp.costo_caja) : '',
          margen_pct: (precios[l.producto_id] > 0 && pp.costo_caja != null)
            ? r2((Number(precios[l.producto_id]) - pp.costo_caja) / Number(precios[l.producto_id]) * 100) : '',
        });
      }
    }

    // El header explícito fija el ORDEN de las columnas. Sin esto json_to_sheet toma las
    // claves de la primera fila, y si esa fila es un camión sin productos se pierden todas
    // las columnas del producto — justo las que se vienen a buscar.
    const header = ['camion_id','camion','estado','proveedor','pais_origen','incoterm','ncm',
      'cert_origen_mercosur','nro_invoice','fecha_etd','fecha_eta','semana_etd','semana_eta',
      'transporte_empresa','camion_patente','camion_acoplado','chofer_nombre','chofer_documento','chofer_telefono',
      'producto','variedad','envase','cajas','kg_por_bulto','kg','fob_usd_caja','fob_usd_total',
      'pct_del_valor','pct_de_cajas',
      'ars_costo_total','ars_costo_caja','ars_costo_kg',
      'ars_precio_venta_esperado','ars_margen_caja','margen_pct',
      'ars_costo_por_valor','ars_costo_por_caja_prorrateo',
      'moneda','tc_aplicado','tc_manual','costeo_completo','falta_tc','invoice_origen',
      'usd_invoice','usd_flete_base','usd_seguro','usd_flete_real','usd_bancarios','usd_base_imponible',
      'ars_base_imponible','ars_mercaderia','ars_iva','ars_iibb','ars_tasa_maria','ars_despachante',
      'ars_iva_despachante','ars_flete_real','ars_bancarios','ars_iva_bancarios',
      'ars_total_contado','ars_total_plazo','ars_dif_cambio',
      'papeles_cargados','papeles_rubros','origen_mercaderia','origen_iva','origen_iibb',
      'origen_tasa_maria','origen_despachante','origen_flete','origen_bancarios',
      'camion_cajas','camion_kg','ars_costo_caja_camion','ars_costo_kg_camion',
      'observaciones','creado_en'];

    const ws = XLSX.utils.json_to_sheet(filas, { header });
    // Filtros en la fila de títulos y las dos primeras columnas fijas: con 60+ columnas,
    // sin esto no se sabe de qué camión es la fila que se está mirando.
    ws['!autofilter'] = { ref: XLSX.utils.encode_range(
      { s: { c: 0, r: 0 }, e: { c: header.length - 1, r: Math.max(filas.length, 1) } }) };
    ws['!freeze'] = { xSplit: 2, ySplit: 1 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Camiones');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const hoy = db.prepare("SELECT date('now','localtime') d").get().d;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="camiones-sg-${hoy}.xlsx"`,
    });
    res.send(buf);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

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
    res.json({ ok: true, data: { ...emb, costos, lineas, calculo: calcEmbarque(emb, costos), estimador: calcImportacion(db, emb, costos) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /importacion/calendario — los camiones que ya salieron o están por salir y todavía no
// llegaron. Ordenados por ETA, que es la fecha que a uno le importa: cuándo lo tengo acá.
router.get('/importacion/calendario', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const hoy = db.prepare("SELECT date('now','localtime') d").get().d;
    // La patente y el teléfono del chofer viajan con el calendario a propósito: el que mira
    // esta pantalla es el que tiene que llamar cuando un camión se atrasa, y si el dato no
    // está acá tiene que entrar a la ficha de cada uno para buscarlo.
    const rows = db.prepare(`SELECT e.id, e.nombre, e.estado, e.fecha_etd, e.fecha_eta,
             e.cantidad_cajas, e.nro_invoice, e.camion_patente, e.camion_acoplado,
             e.transporte_empresa, e.chofer_nombre, e.chofer_telefono,
             p.razon_social AS proveedor_nombre
      FROM sg_embarques e LEFT JOIN sg_proveedores p ON p.id = e.proveedor_id
      WHERE e.activo=1 AND e.eliminado_en IS NULL
        AND e.estado IN ('cotizacion','abierto','transito')
      ORDER BY COALESCE(e.fecha_eta, e.fecha_etd, '9999-12-31'), e.id`).all();
    const dias = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
    const items = rows.map(r => {
      // Atrasado = la ETA ya pasó y el camión sigue sin recibirse. Es lo que hay que perseguir.
      const diasEta = r.fecha_eta ? dias(hoy, r.fecha_eta) : null;
      return { ...r,
        dias_para_etd: r.fecha_etd ? dias(hoy, r.fecha_etd) : null,
        dias_para_eta: diasEta,
        atrasado: diasEta != null && diasEta < 0,
        sin_fechas: !r.fecha_etd && !r.fecha_eta };
    });
    res.json({ ok: true, data: { hoy, items,
      atrasados: items.filter(i => i.atrasado).length,
      sin_fechas: items.filter(i => i.sin_fechas).length } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /importacion/deuda[?tc=] — cuánto le debemos al exterior y qué pasa si sube el dólar.
// La deuda son los rubros en DÓLARES todavía sin pagar (sin monto_real cargado) de los
// embarques que no están cerrados. Cada uno vale distinto en pesos según cuándo se pague, y
// si el dólar se mueve, la deuda se mueve con él: eso es lo que este panel hace visible.
router.get('/importacion/deuda', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const hoy = db.prepare("SELECT date('now','localtime') d").get().d;
    const tcHoy = tcEsperadoEnFecha(db, hoy).tc;
    const tcSimulado = (req.query.tc != null && req.query.tc !== '') ? Number(req.query.tc) : null;

    const embs = db.prepare(`SELECT e.*, p.razon_social AS proveedor_nombre
      FROM sg_embarques e LEFT JOIN sg_proveedores p ON p.id = e.proveedor_id
      WHERE e.activo=1 AND e.eliminado_en IS NULL AND e.estado <> 'cerrado'`).all();

    const items = [];
    for (const e of embs) {
      const costos = embCostos(db, e.id);
      const est = calcImportacion(db, e, costos);
      for (const l of est.lineas) {
        if (!l.plazo || !l.usd) continue;                 // solo lo que va en dólares y a plazo
        const c = costos.find(x => x.concepto === (l.k === 'mercaderia' ? 'costo_mercaderia'
                                   : l.k === 'flete_real' ? 'fletes' : 'gastos_bancarios'));
        if (c && c.monto_real != null && c.monto_real !== '') continue;   // ya pagado: no es deuda
        if (l.k === 'iva_banc') continue;                 // el IVA acompaña al rubro, no se debe aparte
        items.push({
          embarque_id: e.id, embarque: e.nombre, proveedor: e.proveedor_nombre,
          concepto: l.label, usd: l.usd, fecha_pago: l.fecha_pago || null,
          vencido: !!l.tc_vencido, tc_pago: l.tc, ars_al_pago: l.ars,
          ars_hoy: tcHoy != null ? r2(l.usd * tcHoy) : null
        });
      }
    }
    const sum = (f) => r2(items.reduce((a, x) => a + (Number(x[f]) || 0), 0));
    const usdTotal = sum('usd');
    const arsHoy = sum('ars_hoy');
    const arsPago = items.some(x => x.ars_al_pago == null) ? null : sum('ars_al_pago');
    res.json({ ok: true, data: {
      hoy, tc_hoy: tcHoy, items,
      usd_total: usdTotal,
      ars_hoy: arsHoy,
      ars_al_pago: arsPago,
      // Lo que la curva ya anticipa que vas a pagar de más por pagar más adelante.
      mayor_costo_por_plazo: (arsPago != null && arsHoy != null) ? r2(arsPago - arsHoy) : null,
      // Simulador: si el dólar salta a X, la deuda pasa a valer esto.
      simulacion: (tcSimulado > 0 && tcHoy != null) ? {
        tc: tcSimulado,
        ars: r2(usdTotal * tcSimulado),
        variacion: r2(usdTotal * tcSimulado - arsHoy),
        variacion_pct: arsHoy > 0 ? r2((usdTotal * tcSimulado - arsHoy) / arsHoy * 100) : null
      } : null
    } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PATCH /embarques/:id/estado — cambio rápido de estado desde el panel.
// Solo entre los tres estados de la negociación: 'recibido' y 'cerrado' los ponen sus
// acciones, que además crean los lotes y re-costean.
// 'transito' exige ETD: sin fecha de embarque no hay de dónde colgar las fechas de pago, y
// el TC de cada rubro quedaría calculado sobre la nada.
const EMB_ESTADOS_MANUALES = new Set(['cotizacion', 'abierto', 'transito']);
router.patch('/embarques/:id/estado', requireAdmin, express.json(), (req, res) => {
  const db = getDb();
  try {
    const nuevo = val(req.body && req.body.estado);
    if (!EMB_ESTADOS_MANUALES.has(nuevo)) {
      return res.status(400).json({ ok: false, error: 'Estado inválido. "Recibido" y "Cerrado" se ponen con su botón, que es lo que genera los lotes.' });
    }
    const emb = db.prepare('SELECT * FROM sg_embarques WHERE id=? AND activo=1').get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    if (!EMB_ESTADOS_MANUALES.has(emb.estado)) {
      return res.status(400).json({ ok: false, error: 'Un embarque ' + emb.estado + ' no puede volver atrás de estado.' });
    }
    // La ETD se puede mandar en la misma llamada: así el panel la pide y resuelve sin
    // rebotar por el PUT del embarque, que reescribe TODO el header y con un body parcial
    // borraría nombre, proveedor y el resto.
    const etdNueva = val(req.body && req.body.fecha_etd);
    if (etdNueva && !/^\d{4}-\d{2}-\d{2}$/.test(etdNueva)) {
      return res.status(400).json({ ok: false, error: 'Fecha de embarque inválida (se espera AAAA-MM-DD)' });
    }
    const etd = etdNueva || emb.fecha_etd;
    if (nuevo === 'transito' && !etd) {
      return res.status(400).json({ ok: false, requiere_etd: true,
        error: 'Para pasar a "En tránsito" hace falta la fecha de embarque (ETD): de ahí cuelgan las fechas de pago y el tipo de cambio de cada rubro.' });
    }
    db.prepare(`UPDATE sg_embarques SET estado=?, fecha_etd=COALESCE(?, fecha_etd),
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
      .run(nuevo, etdNueva || null, uid(req), emb.id);
    res.json({ ok: true, data: { estado: nuevo, fecha_etd: etd } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// POST /embarques/estimador-preview — el estimador sobre datos sin guardar.
// Existe para que la pantalla muestre el cálculo en vivo mientras se tipea SIN reimplementar
// la fórmula en el navegador: hay una sola versión de la cuenta, y es esta.
// No choca con /embarques/:id porque aquella es GET y esta POST: Express matchea método+path.
router.post('/embarques/estimador-preview', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const b = req.body || {};
    const emb = {
      id: null,
      flete_base_usd: b.flete_base_usd, seguro_usd: b.seguro_usd,
      cantidad_cajas: b.cantidad_cajas, fecha_etd: b.fecha_etd, fecha_eta: b.fecha_eta,
    };
    res.json({ ok: true, data: calcImportacion(db, emb, embCostosDelBody(b), b.kg) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// GET /embarques/:id/ficha — todo el camión de una: datos, costos con su TC, productos,
// documentos y —si ya entró— el resultado. Una sola llamada para un visor de solo lectura,
// en vez de que la pantalla arme el rompecabezas con tres.
router.get('/embarques/:id/ficha', requireAuth, (req, res) => {
  const db = getDb();
  try {
    // Sin p.pais: sg_proveedores no tiene esa columna (el campo del formulario de proveedores
    // no se persiste). El país del viaje es pais_origen del propio embarque.
    const emb = db.prepare(`SELECT e.*, p.razon_social AS proveedor_nombre, p.origen AS proveedor_origen
      FROM sg_embarques e LEFT JOIN sg_proveedores p ON p.id=e.proveedor_id
      WHERE e.id=? AND e.activo=1`).get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    const costos = embCostos(db, emb.id);
    const calc = calcEmbarque(emb, costos);
    const proy = calcEmbarque(emb, costos, true);
    const lineas = db.prepare(`SELECT l.*, pr.nombre AS producto_nombre, pr.variedad AS producto_variedad,
             e.nombre AS envase_nombre
      FROM sg_embarque_lineas l
      LEFT JOIN sg_productos pr ON pr.id=l.producto_id
      LEFT JOIN sg_envases e ON e.id=l.envase_id
      WHERE l.embarque_id=? AND l.activo=1 ORDER BY l.id`).all(emb.id);
    const documentos = db.prepare(`SELECT id, tipo, nombre_original, mime, tamano_bytes, fecha_documento, observaciones
      FROM sg_embarque_documentos WHERE embarque_id=? AND activo=1 ORDER BY id DESC`).all(emb.id);
    const kg = lineas.reduce((a, l) => a + ((Number(l.cajas) || 0) * (Number(l.kg_por_bulto) || 0)), 0);
    // El resultado solo existe una vez que el camión entró y generó lotes.
    const resultado = (emb.estado === 'recibido' || emb.estado === 'cerrado') ? resultadoEmbarque(db, emb) : null;
    // El precio esperado de venta de cada producto, para el cuadro y para el aviso a los
    // comerciales. Va por producto y no por línea porque vive en su propia tabla: las
    // líneas se borran y se reinsertan en cada guardado del embarque.
    const precios = db.prepare('SELECT producto_id, precio_caja FROM sg_embarque_precios WHERE embarque_id=?')
      .all(emb.id).reduce((m, r) => { m[r.producto_id] = r.precio_caja; return m; }, {});
    res.json({ ok: true, data: {
      embarque: emb, costos: calc.detalle, lineas, documentos, resultado, precios,
      estimador: calcImportacion(db, emb, costos),
      totales: {
        bruto: calc.bruto, creditos: calc.creditos, neto: calc.neto,
        cajas: Number(emb.cantidad_cajas) || 0, kg,
        costo_caja_neto: calc.costo_caja_neto, costo_caja_c_impuestos: calc.costo_caja_c_impuestos,
        costo_kg_neto: kg > 0 ? calc.neto / kg : null,
        dif_cotizacion: calc.dif_cotizacion, dif_costos: calc.dif_costos,
        neto_proyectado: proy.neto, tc_manual: calc.tc_manual
      }
    } });
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
    // El real se carga en pesos (lo que salió de la caja). moneda_real queda por si algún
    // día se paga desde una cuenta en dólares.
    moneda_real: (c.moneda_real === 'USD' ? 'USD' : 'ARS'),
    // Condición de pago del rubro: solo tiene sentido en los que van en dólares, que son los
    // únicos que necesitan saber a qué TC se van a liquidar.
    pago_ancla: ['etd', 'eta', 'fija'].includes(c.pago_ancla) ? c.pago_ancla : null,
    pago_dias: (c.pago_dias != null && c.pago_dias !== '') ? Math.round(Number(c.pago_dias)) : null,
    pago_fecha: val(c.pago_fecha),
    observaciones: val(c.observaciones)
  }));
}

// tc_estimado / tc_real y cantidad_cajas NO están acá a propósito: los TC salen de la curva
// según la fecha de pago de cada rubro, y las cajas se derivan de las líneas (embSyncLineas).
// Si estuvieran, cada guardado los pisaría con lo que mandó la pantalla — o con null.
// La patente se guarda SIN espacios ni guiones y en mayúsculas. La misma chapa se escribe
// "AB 123 CD", "ab123cd" o "AB-123-CD" según quién la cargue, y así no hay forma de buscarla
// ni de darse cuenta de que es el mismo camión. Se normaliza al guardar, una sola vez.
function patente(v) {
  const s = String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s ? s.slice(0, 15) : null;
}

const EMB_HEADER_COLS = ['nombre','proveedor_id','pais_origen','incoterm','certificado_origen_mercosur','ncm','moneda','estado','nro_invoice','flete_base_usd','seguro_usd','fecha_etd','fecha_eta','observaciones','transporte_empresa','camion_patente','camion_acoplado','chofer_nombre','chofer_documento','chofer_telefono'];
function embHeaderVals(b) {
  return {
    nombre: val(b.nombre),
    proveedor_id: b.proveedor_id ? Number(b.proveedor_id) : null,
    pais_origen: val(b.pais_origen),
    incoterm: val(b.incoterm) || 'FOB',
    certificado_origen_mercosur: b.certificado_origen_mercosur ? 1 : 0,
    ncm: val(b.ncm),
    moneda: (b.moneda === 'ARS' ? 'ARS' : 'USD'),
    estado: EMB_ESTADOS.has(b.estado) ? b.estado : 'cotizacion',
    nro_invoice: val(b.nro_invoice),
    flete_base_usd: (b.flete_base_usd != null && b.flete_base_usd !== '') ? Number(b.flete_base_usd) : null,
    seguro_usd: (b.seguro_usd != null && b.seguro_usd !== '') ? Number(b.seguro_usd) : null,
    fecha_etd: val(b.fecha_etd),
    fecha_eta: val(b.fecha_eta),
    observaciones: val(b.observaciones),
    // Quién trae el camión. Todo opcional: en una cotización todavía no se sabe, y frenar
    // la carga por eso sería pedir un dato que nadie tiene.
    transporte_empresa: val(b.transporte_empresa),
    camion_patente: patente(b.camion_patente),
    camion_acoplado: patente(b.camion_acoplado),
    chofer_nombre: val(b.chofer_nombre),
    chofer_documento: val(b.chofer_documento),
    chofer_telefono: val(b.chofer_telefono),
  };
}
const EMB_ESTADOS = new Set(['cotizacion','abierto','transito','recibido','cerrado']);

// CREAR — cabecera + rubros en una transacción (patrón POST /oc).
// ── ARRANCAR UN EMBARQUE DESDE LA FACTURA ───────────────────────────────────────────
// Muchas veces lo primero que aparece de un camión es el invoice del proveedor: antes que
// el embarque exista, antes de que nadie cargue nada. Hasta ahora había que tipear a mano
// la cabecera y producto por producto, y recién después subir el papel del que salió todo.
//
// Esto lee la factura y devuelve una PROPUESTA de embarque completo, con sus líneas. No
// escribe NADA: la pantalla llena el formulario de siempre, la persona corrige lo que haga
// falta y guarda con el mismo botón de siempre. Toda la validación del alta sigue estando
// donde estaba — acá no hay un segundo camino para crear embarques.
//
// Lo que la IA lee son textos libres ("UVA BLANCA CAJA 8KG"), no ids. El enganche con el
// catálogo lo hace un fuzzy contra sg_productos / sg_envases / sg_proveedores y viaja como
// SUGERENCIA con su puntaje: lo elige una persona, no el parecido de dos strings.
router.post('/embarques/leer-factura', requireAdmin, uploadDoc, async (req, res) => {
  const db = getDb();
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ ok: false, error: 'La lectura automática no está configurada en este servidor' });
    }
    const f = req.file;
    if (!f) return res.status(400).json({ ok: false, error: 'Falta el archivo' });
    if (!DOC_MIMES.has(f.mimetype)) return res.status(400).json({ ok: false, error: 'Formato no permitido (solo PDF, JPG o PNG)' });

    const b64 = f.buffer.toString('base64');
    const contenido = f.mimetype === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: f.mimetype, data: b64 } };

    const prompt = 'Leé este COMMERCIAL INVOICE de una importación de fruta y extraé la cabecera y el '
      + 'detalle de productos. Respondé ÚNICAMENTE un JSON válido, sin markdown ni backticks:\n\n'
      + '{"numero":"","fecha":"AAAA-MM-DD","exportador":"","pais_origen":"","incoterm":"",'
      + '"moneda":"USD","total_usd":0,"flete_usd":null,"seguro_usd":null,'
      + '"lineas":[{"descripcion":"","cajas":0,"kg_por_caja":null,"precio_unitario_usd":0,"importe_usd":0}],'
      + '"confianza":"alta|media|baja","observaciones":""}\n\n'
      + 'REGLAS:\n'
      + '- "numero" es el N° de invoice. "exportador" es quién emite (el proveedor del exterior).\n'
      + '- Una línea POR PRODUCTO. "descripcion" tal cual figura en el papel, sin traducir ni "arreglar":\n'
      + '  ese texto se usa después para engancharlo con el catálogo.\n'
      + '- "cajas" es la cantidad de bultos/cartons de esa línea. "precio_unitario_usd" es el precio POR CAJA.\n'
      + '  Si el papel cotiza por kilo y no por caja, poné el precio por caja sólo si podés calcularlo con\n'
      + '  seguridad; si no, dejalo en null y decilo en observaciones.\n'
      + '- "kg_por_caja" es el peso neto de UNA caja. Suele estar en la descripción ("8 KG", "CX 8,2 KGS").\n'
      + '  Si sólo figura el peso total de la línea, dividilo por las cajas. Si no se puede, null.\n'
      + '- "incoterm" es FOB, CIF, CFR, etc., si figura.\n'
      + '- Los montos son NÚMEROS, sin separador de miles ni símbolo.\n'
      + '- Lo que no puedas leer con seguridad va en null, NUNCA inventado. Si dudás, poné confianza\n'
      + '  "baja" y explicá en observaciones qué no se lee.\n'
      + '- La suma de los importe_usd tiene que dar el total_usd. Si no da, decilo en observaciones en\n'
      + '  vez de forzar los números.';

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: MODELO_CHAT,
      max_tokens: 3000,
      messages: [{ role: 'user', content: [contenido, { type: 'text', text: prompt }] }],
    });
    const txt = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!txt) return res.status(502).json({ ok: false, error: 'La lectura no devolvió nada' });

    let leido;
    try { leido = JSON.parse(txt.replace(/```json|```/g, '').trim()); }
    catch (_) { return res.status(422).json({ ok: false, error: 'No se pudo interpretar la lectura', raw: txt.slice(0, 800) }); }

    // ── Enganche con el catálogo ────────────────────────────────────────────────────
    // Fuzzy sobre el nombre normalizado, el mismo que usa el detector de duplicados. El
    // umbral es MÁS BAJO que el de dedup a propósito: allá un falso positivo BLOQUEA un
    // alta, acá sólo propone algo que una persona va a mirar. Igual viaja el puntaje, para
    // poder mostrar cuáles son dudosas.
    const UMBRAL_SUGERENCIA = 0.55;
    // Dos señales, y la de contención va primero. En una factura el nombre del catálogo
    // viene ADENTRO de una descripción más larga —"UVA BLANCA CX 8,2KG" contra "Uva Blanca",
    // "CAJA 8 KG" contra "Caja"—, y comparando los strings enteros eso da un parecido bajísimo
    // aunque sea obviamente el mismo. Si todas las palabras del catálogo están en la
    // descripción, es él; si no, se cae al parecido de siempre, que agarra los typos.
    const mejor = (texto, filas) => {
      const cand = normalizar(texto);
      if (!cand) return null;
      const tokens = cand.split(' ');
      let top = null, score = 0;
      for (const r of filas) {
        const nom = normalizar(r._t);
        if (!nom) continue;
        // 0.99 y no 1: deja distinguir "está contenido" de "es idéntico" al mostrar el puntaje.
        const contenido = nom.split(' ').every(t => tokens.includes(t));
        const s = contenido ? Math.max(0.99, ratio(cand, nom)) : ratio(cand, nom);
        if (s > score) { score = s; top = r; }
      }
      return (top && score >= UMBRAL_SUGERENCIA) ? { id: top.id, nombre: top._t, score: r2(score * 100) } : null;
    };

    const provs = db.prepare("SELECT id, razon_social, origen FROM sg_proveedores WHERE activo=1").all()
      .map(p => ({ ...p, _t: p.razon_social || '' }));
    // Primero se busca entre los del exterior, que es lo que puede ser: si no aparece, se
    // prueba contra todos, porque un proveedor mal clasificado es un error de carga y no
    // una razón para no sugerir nada.
    const prov = mejor(leido.exportador || '', provs.filter(p => p.origen === 'extranjero'))
              || mejor(leido.exportador || '', provs);

    const prods = db.prepare('SELECT id, nombre, variedad FROM sg_productos WHERE activo=1').all()
      .map(p => ({ ...p, _t: (p.nombre || '') + (p.variedad ? ' ' + p.variedad : '') }));
    const envs = db.prepare('SELECT id, nombre FROM sg_envases WHERE activo=1').all()
      .map(e => ({ ...e, _t: e.nombre || '' }));

    const num = v => (v != null && v !== '' && !isNaN(Number(v))) ? Number(v) : null;
    const lineas = (Array.isArray(leido.lineas) ? leido.lineas : []).map(l => {
      const desc = String(l.descripcion || '').trim();
      return {
        descripcion: desc,
        producto: mejor(desc, prods),
        envase: mejor(desc, envs),
        cajas: num(l.cajas),
        kg_por_bulto: num(l.kg_por_caja),
        precio_unitario_usd: num(l.precio_unitario_usd),
        importe_usd: num(l.importe_usd),
      };
    });

    // ── Avisos: lo que hay que mirar antes de guardar ────────────────────────────────
    const avisos = [];
    if (leido.confianza === 'baja') avisos.push('La lectura no está segura: revisá todo contra el papel.');
    if (!prov) avisos.push('No se reconoció al proveedor "' + (leido.exportador || '?') + '". Elegilo a mano o dalo de alta primero.');
    else if (prov.score < 80) avisos.push('El proveedor se sugiere por parecido (' + prov.score + '%): confirmá que sea el correcto.');

    const sinProd = lineas.filter(l => !l.producto).length;
    if (sinProd) avisos.push(sinProd + ' producto(s) no se reconocieron en el catálogo: elegilos a mano.');
    const sinKg = lineas.filter(l => l.kg_por_bulto == null).length;
    if (sinKg) avisos.push(sinKg + ' línea(s) sin kg por caja. Sin ese dato el lote nace con 0 kg y no se puede despachar.');

    // El control que la pantalla no puede hacer: que el detalle cierre contra el total.
    const sumaLineas = r2(lineas.reduce((a, l) => a + ((l.cajas || 0) * (l.precio_unitario_usd || 0)), 0));
    const total = num(leido.total_usd);
    if (total != null && sumaLineas > 0 && Math.abs(total - sumaLineas) > 0.5) {
      avisos.push('Los productos suman US$ ' + sumaLineas + ' y el invoice dice US$ ' + total
        + '. Revisá cuál está mal leído antes de guardar.');
    }
    // El mismo invoice dos veces es un error de carga, y conviene saberlo ANTES de cargar todo.
    if (leido.numero) {
      const dup = db.prepare('SELECT nombre FROM sg_embarques WHERE nro_invoice=? AND activo=1 AND eliminado_en IS NULL')
        .get(String(leido.numero));
      if (dup) avisos.push('El invoice ' + leido.numero + ' ya está cargado en el embarque "' + dup.nombre + '".');
    }

    res.json({ ok: true, data: {
      // El nombre se propone; es lo primero que se cambia y no hay forma de adivinarlo bien.
      nombre: [leido.exportador, leido.numero].filter(Boolean).join(' ').slice(0, 80) || 'Embarque',
      nro_invoice: leido.numero ? String(leido.numero).trim() : null,
      fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(leido.fecha || '')) ? leido.fecha : null,
      proveedor: prov,
      exportador: leido.exportador || null,
      pais_origen: leido.pais_origen || null,
      incoterm: leido.incoterm || null,
      moneda: leido.moneda ? String(leido.moneda).toUpperCase().slice(0, 3) : 'USD',
      total_usd: total,
      suma_lineas_usd: sumaLineas,
      flete_base_usd: num(leido.flete_usd),
      seguro_usd: num(leido.seguro_usd),
      lineas,
      confianza: leido.confianza || null,
      observaciones: leido.observaciones || null,
      avisos,
    } });
  } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
});

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
      // Las columnas de pago van también acá: si solo estuvieran en el PUT, un embarque
      // recién creado perdería su condición de pago hasta el primer guardado.
      const ins = db.prepare(`INSERT INTO sg_embarque_costos
        (embarque_id, concepto, es_credito, moneda, monto_estimado, monto_real,
         moneda_real, pago_ancla, pago_dias, pago_fecha, observaciones, creado_por)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const c of costos) ins.run(embId, c.concepto, c.es_credito, c.moneda, c.monto_estimado, c.monto_real,
        c.moneda_real, c.pago_ancla, c.pago_dias, c.pago_fecha, c.observaciones, uid(req));
      embSyncLineas(db, embId, b, uid(req), h.estado);   // F5 — desglose de productos + cantidad_cajas derivada
      return embId;
    });
    res.json({ ok: true, data: { id: Number(tx()) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// POST /embarques/:id/duplicar — arrancar un embarque nuevo desde uno anterior.
// Muchos camiones se le piden al mismo proveedor con la misma estructura de costos (flete,
// despachante, condiciones de pago), así que copiarla evita volver a cargarla entera.
//
// Se copia la ESTRUCTURA, no la historia: van los montos estimados y las condiciones de
// pago; NO van los montos reales, las fechas del viaje, el TC real ni el manual, el estado,
// los documentos ni los lotes. El nuevo nace en cotización, limpio.
router.post('/embarques/:id/duplicar', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const orig = db.prepare('SELECT * FROM sg_embarques WHERE id=? AND activo=1').get(req.params.id);
    if (!orig) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    const nombre = val(req.body && req.body.nombre) || ((orig.nombre || 'Embarque') + ' (copia)');
    const conLineas = req.body && req.body.con_lineas !== false;   // por defecto sí

    const tx = db.transaction(() => {
      const info = db.prepare(`INSERT INTO sg_embarques
        (nombre, proveedor_id, pais_origen, incoterm, certificado_origen_mercosur, ncm, moneda,
         estado, creado_por)
        VALUES (?,?,?,?,?,?,?, 'cotizacion', ?)`)
        .run(nombre, orig.proveedor_id, orig.pais_origen, orig.incoterm,
             orig.certificado_origen_mercosur, orig.ncm, orig.moneda, uid(req));
      const nuevoId = info.lastInsertRowid;

      // Costos: estimado + condición de pago. El real no se copia (es de aquel viaje), y la
      // fecha fija tampoco: una fecha absoluta del embarque anterior no aplica a este.
      const cs = db.prepare('SELECT * FROM sg_embarque_costos WHERE embarque_id=? AND activo=1 ORDER BY id').all(orig.id);
      const insC = db.prepare(`INSERT INTO sg_embarque_costos
        (embarque_id, concepto, es_credito, moneda, monto_estimado, moneda_real,
         pago_ancla, pago_dias, observaciones, creado_por)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const c of cs) {
        insC.run(nuevoId, c.concepto, c.es_credito, c.moneda, c.monto_estimado, c.moneda_real,
          c.pago_ancla === 'fija' ? null : c.pago_ancla, c.pago_ancla === 'fija' ? null : c.pago_dias,
          c.observaciones, uid(req));
      }

      let lineas = 0;
      if (conLineas) {
        const ls = db.prepare('SELECT * FROM sg_embarque_lineas WHERE embarque_id=? AND activo=1 ORDER BY id').all(orig.id);
        const insL = db.prepare(`INSERT INTO sg_embarque_lineas
          (embarque_id, producto_id, envase_id, kg_por_bulto, cajas, calidad, calibre, observaciones, precio_unitario_usd, creado_por)
          VALUES (?,?,?,?,?,?,?,?,?,?)`);
        for (const l of ls) {
          insL.run(nuevoId, l.producto_id, l.envase_id, l.kg_por_bulto, l.cajas, l.calidad, l.calibre,
            l.observaciones, l.precio_unitario_usd, uid(req));
          lineas++;
        }
        if (lineas) db.prepare('UPDATE sg_embarques SET cantidad_cajas=? WHERE id=?')
          .run(ls.reduce((a, l) => a + (Number(l.cajas) || 0), 0), nuevoId);
      }
      return { id: Number(nuevoId), costos: cs.length, lineas };
    });
    res.json({ ok: true, data: tx() });
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
    // 'recibido' y 'cerrado' NO se ponen a mano: los setea la acción correspondiente, que además
    // crea los lotes / re-costea. Poner "Recibido" desde el select dejaba el embarque en un estado
    // mentiroso —sin lotes— y encima trababa la recepción real para siempre, porque POST /recibir
    // arranca rechazando los que ya figuran como recibidos.
    if (h.estado !== emb.estado && (h.estado === 'recibido' || h.estado === 'cerrado')) {
      return res.status(400).json({ ok: false, error: 'El estado "' + h.estado + '" no se carga a mano: usá el botón Recibir embarque (y después Cerrar), que es lo que genera los lotes.' });
    }
    if ((emb.estado === 'recibido' || emb.estado === 'cerrado') && h.estado !== emb.estado) {
      return res.status(400).json({ ok: false, error: 'Un embarque ' + emb.estado + ' no puede volver atrás de estado.' });
    }
    const costos = embCostosDelBody(b);
    const tx = db.transaction(() => {
      db.prepare(`UPDATE sg_embarques SET ${EMB_HEADER_COLS.map(k => k + '=?').join(', ')},
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
        .run(...EMB_HEADER_COLS.map(k => h[k]), uid(req), emb.id);
      const upd = db.prepare(`UPDATE sg_embarque_costos SET es_credito=?, moneda=?, monto_estimado=?, monto_real=?,
        moneda_real=?, pago_ancla=?, pago_dias=?, pago_fecha=?, observaciones=?,
        modificado_en=datetime('now','localtime'), modificado_por=? WHERE embarque_id=? AND concepto=? AND activo=1`);
      const ins = db.prepare(`INSERT INTO sg_embarque_costos
        (embarque_id, concepto, es_credito, moneda, monto_estimado, monto_real,
         moneda_real, pago_ancla, pago_dias, pago_fecha, observaciones, creado_por)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const c of costos) {
        const r = upd.run(c.es_credito, c.moneda, c.monto_estimado, c.monto_real,
          c.moneda_real, c.pago_ancla, c.pago_dias, c.pago_fecha, c.observaciones, uid(req), emb.id, c.concepto);
        if (r.changes === 0) ins.run(emb.id, c.concepto, c.es_credito, c.moneda, c.monto_estimado, c.monto_real,
          c.moneda_real, c.pago_ancla, c.pago_dias, c.pago_fecha, c.observaciones, uid(req));
      }
      embSyncLineas(db, emb.id, b, uid(req), emb.estado);   // F5 — replace-all de líneas (si no está recibido) + cantidad_cajas derivada
    });
    tx();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// SOFT DELETE — no borra físico (patrón eliminado_en).
router.delete('/embarques/:id', requireAuth, (req, res) => {
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
// ── RE-COSTEO DE LOS LOTES DE UN EMBARQUE (Importación F3) ──────────────────────────
// Vuelve a repartir el costo del embarque entre sus lotes con los números que haya AHORA
// (montos reales si están cargados, tc real si está) y reescribe costo_base de cada lote.
// Es re-costeo retroactivo (opción A): el lote pasa a valer lo que costó de verdad, aunque
// ya se haya vendido parte. Eso mueve márgenes de meses ya mirados — es la decisión tomada,
// porque para gestión importa que el costo del camión sea el exacto.
// El reparto es por LÍNEA, así que un lote sin embarque_linea_id no se puede re-costear sin
// adivinar: se cuenta aparte y se avisa, nunca se le asigna un costo al azar.
function recostearLotesEmbarque(db, emb, userId) {
  const lineas = db.prepare('SELECT * FROM sg_embarque_lineas WHERE embarque_id=? AND activo=1 ORDER BY id').all(emb.id);
  const lotes = db.prepare(`SELECT id, codigo_lote, kg_reales, costo_base, costo_final
                            FROM sg_lotes WHERE embarque_id=? AND eliminado_en IS NULL ORDER BY id`).all(emb.id);
  if (!lineas.length || !lotes.length) return { recosteados: 0, sin_linea: lotes.length, detalle: [] };
  const bases = costoBaseLineasEmbarque(emb, embCostos(db, emb.id), lineas);
  const porLinea = {};
  lineas.forEach((l, i) => { porLinea[l.id] = bases[i]; });
  const conLinea = db.prepare('SELECT id, embarque_linea_id FROM sg_lotes WHERE embarque_id=? AND eliminado_en IS NULL').all(emb.id)
    .reduce((m, l) => { m[l.id] = l.embarque_linea_id; return m; }, {});
  const upd = db.prepare("UPDATE sg_lotes SET costo_base=?, precio_unitario_kg=?, modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?");
  const detalle = [];
  let sinLinea = 0;
  for (const lo of lotes) {
    const lid = conLinea[lo.id];
    if (lid == null || porLinea[lid] == null) { sinLinea++; continue; }
    const base = porLinea[lid];
    const kg = Number(lo.kg_reales) || 0;
    upd.run(base, kg > 0 ? base / kg : null, userId, lo.id);
    const nuevoFinal = recalcCostoLote(db, lo.id);   // suma los gastos directos propios del lote
    detalle.push({ lote_id: lo.id, codigo: lo.codigo_lote,
      costo_anterior: lo.costo_final, costo_nuevo: nuevoFinal,
      delta: (Number(nuevoFinal) || 0) - (Number(lo.costo_final) || 0) });
  }
  return { recosteados: detalle.length, sin_linea: sinLinea, detalle };
}

// Chequeos previos a recibir, compartidos por el preview y la recepción real: un solo criterio,
// así la pantalla no puede decir que se puede recibir algo que después el POST rechaza.
// Tira Error con el motivo; devuelve lo necesario para crear los lotes.
function prepararRecepcionEmbarque(db, emb) {
  if (emb.estado === 'recibido' || emb.estado === 'cerrado') throw new Error('El embarque ya fue recibido');
  const lineas = db.prepare('SELECT * FROM sg_embarque_lineas WHERE embarque_id=? AND activo=1 ORDER BY id').all(emb.id);
  if (!lineas.length) throw new Error('El embarque no tiene líneas de producto. Cargá el desglose de productos antes de recibir.');
  if (lineas.some(l => !(Number(l.cajas) > 0))) throw new Error('Todas las líneas deben tener cajas > 0');
  if (lineas.some(l => !(Number(l.kg_por_bulto) > 0)))
    throw new Error('Todas las líneas deben tener kg por bulto > 0 (si no, el lote nace con 0 kg y no es despachable)');
  const costos = embCostos(db, emb.id);
  const calc = calcEmbarque(emb, costos);
  if (calc.costo_caja_neto == null)
    throw new Error(calc.sin_tc && calc.sin_tc.length
      ? 'Falta el tipo de cambio: ' + calc.sin_tc.join(', ') + ' está en dólares y no hay curva cargada en su fecha de pago (ni TC manual). Sin eso el costo no se puede pasar a pesos.'
      : 'No se puede costear el embarque (falta cantidad de cajas o costos cargados)');
  // F7 — costo_base por línea: FOB unitario diferencia; gastos parejos por caja; Σ = neto exacto.
  return { lineas, calc, bases: costoBaseLineasEmbarque(emb, costos, lineas) };
}

// PREVIEW de recepción — qué lotes se van a crear y con qué costo, sin tocar nada.
// Si algo bloquea, devuelve ok:false con el motivo (mismo texto que daría el POST).
router.get('/embarques/:id/recepcion-preview', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const emb = db.prepare('SELECT * FROM sg_embarques WHERE id=? AND activo=1').get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    let prep;
    try { prep = prepararRecepcionEmbarque(db, emb); }
    catch (e) { return res.json({ ok: false, puede_recibir: false, error: e.message }); }
    const nombres = db.prepare('SELECT id, nombre, variedad FROM sg_productos').all()
      .reduce((m, p) => { m[p.id] = p.nombre + (p.variedad ? ' ' + p.variedad : ''); return m; }, {});
    const lotes = prep.lineas.map((l, i) => {
      const cajas = Math.round(Number(l.cajas) || 0);
      const kg = (l.kg_por_bulto != null && l.kg_por_bulto !== '') ? cajas * Number(l.kg_por_bulto) : 0;
      const base = Number(prep.bases[i]) || 0;
      return { linea_id: l.id, producto: nombres[l.producto_id] || ('#' + l.producto_id),
               cajas, kg, costo_base: base, costo_kg: kg > 0 ? base / kg : null };
    });
    res.json({ ok: true, puede_recibir: true, data: {
      lotes, total_cajas: lotes.reduce((a, x) => a + x.cajas, 0),
      total_kg: lotes.reduce((a, x) => a + x.kg, 0),
      neto: prep.calc.neto, costo_caja_neto: prep.calc.costo_caja_neto, tc_aplicado: prep.calc.tc_aplicado,
      tc_es_estimado: emb.tc_real == null,
      // El que aprieta "Recibir" está parado frente a un camión. Que la pantalla diga qué
      // chapa y qué chofer se esperan es la única forma de darse cuenta a tiempo de que se
      // está recibiendo el camión equivocado — después ya hay lotes creados.
      camion: { patente: emb.camion_patente, acoplado: emb.camion_acoplado,
                transporte: emb.transporte_empresa, chofer: emb.chofer_nombre,
                documento: emb.chofer_documento }
    } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.post('/embarques/:id/recibir', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const emb = db.prepare('SELECT * FROM sg_embarques WHERE id=? AND activo=1').get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    let prep;
    try { prep = prepararRecepcionEmbarque(db, emb); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    const { lineas, calc, bases } = prep;
    const fechaIngreso = val(req.body && req.body.fecha_ingreso) || db.prepare("SELECT date('now','localtime') d").get().d;
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

// ── RESULTADO DEL EMBARQUE (Importación F3) ─────────────────────────────────────────
// Qué dejó el camión, con plata de verdad: lo vendido sale de sg_despacho_items (kg y
// subtotal reales), el costo de lo vendido se prorratea por kg al costo actual del lote, y
// lo que queda en stock se valúa a ese mismo costo. Se calcula EN VIVO, no se snapshotea:
// después del cierre se sigue vendiendo y una foto quedaría vieja al día siguiente.
function resultadoEmbarque(db, emb) {
  const lotes = db.prepare(`
    SELECT l.id, l.codigo_lote, l.kg_reales, l.costo_final, p.nombre AS producto,
           COALESCE(v.kg_vendidos, 0) AS kg_vendidos, COALESCE(v.ingresos, 0) AS ingresos
    FROM sg_lotes l
    LEFT JOIN sg_productos p ON p.id = l.producto_id
    LEFT JOIN (SELECT lote_id, SUM(kg_despachados) AS kg_vendidos, SUM(subtotal) AS ingresos
               FROM sg_despacho_items GROUP BY lote_id) v ON v.lote_id = l.id
    WHERE l.embarque_id = ? AND l.eliminado_en IS NULL
    ORDER BY l.id`).all(emb.id);

  let costoTotal = 0, kgTotal = 0, kgVend = 0, ingresos = 0, costoVend = 0;
  const filas = lotes.map(l => {
    const kg = Number(l.kg_reales) || 0;
    const costo = Number(l.costo_final) || 0;
    const costoKg = kg > 0 ? costo / kg : 0;
    const kgv = Math.min(Number(l.kg_vendidos) || 0, kg);   // no puede venderse más de lo que entró
    const ing = Number(l.ingresos) || 0;
    const cv = kgv * costoKg;
    costoTotal += costo; kgTotal += kg; kgVend += kgv; ingresos += ing; costoVend += cv;
    return { lote_id: l.id, codigo: l.codigo_lote, producto: l.producto,
      kg, costo, costo_kg: costoKg, kg_vendidos: kgv, ingresos: ing, costo_vendido: cv,
      margen: ing - cv, margen_pct: ing > 0 ? (ing - cv) / ing * 100 : null,
      kg_en_stock: kg - kgv, valor_en_stock: (kg - kgv) * costoKg };
  });
  const margen = ingresos - costoVend;
  return {
    lotes: filas,
    kg_totales: kgTotal, costo_total: costoTotal,
    kg_vendidos: kgVend, ingresos, costo_vendido: costoVend,
    margen, margen_pct: ingresos > 0 ? margen / ingresos * 100 : null,
    kg_en_stock: kgTotal - kgVend, valor_en_stock: costoTotal - costoVend,
    vendido_pct: kgTotal > 0 ? kgVend / kgTotal * 100 : null
  };
}

// GET /embarques/:id/resultado — el resultado del camión, en vivo.
router.get('/embarques/:id/resultado', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const emb = db.prepare('SELECT * FROM sg_embarques WHERE id=? AND activo=1').get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    // Comparación EN VIVO proyectado vs real, sirva o no de preview del cierre: antes de
    // cerrar muestra qué va a pasar, después queda como control contra el snapshot.
    const cs = embCostos(db, emb.id);
    const proy = calcEmbarque(emb, cs, true), rl = calcEmbarque(emb, cs);
    res.json({ ok: true, data: Object.assign(resultadoEmbarque(db, emb), {
      estado: emb.estado, cerrado_en: emb.cerrado_en,
      comparacion: {
        proyectado: { neto: proy.neto, costo_caja: proy.costo_caja_neto, tc: proy.tc_aplicado },
        real:       { neto: rl.neto,   costo_caja: rl.costo_caja_neto,   tc: rl.tc_aplicado },
        desvio: rl.neto - proy.neto,
        desvio_pct: proy.neto > 0 ? (rl.neto - proy.neto) / proy.neto * 100 : null,
        tc_es_estimado: emb.tc_real == null
      },
      cierre: emb.cerrado_en ? {
        tc: emb.cierre_tc,
        neto_proyectado: emb.cierre_neto_proyectado, neto_real: emb.cierre_neto_real,
        costo_caja_proyectado: emb.cierre_costo_caja_proyectado, costo_caja_real: emb.cierre_costo_caja_real,
        desvio_pct: (emb.cierre_neto_proyectado > 0)
          ? (emb.cierre_neto_real - emb.cierre_neto_proyectado) / emb.cierre_neto_proyectado * 100 : null
      } : null
    }) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// POST /embarques/:id/cerrar — cierre del embarque (Importación F3).
// Congela la comparación proyectado vs real, re-costea los lotes con los números finales y
// deja el embarque cerrado. La parte contable (asiento por la diferencia de cambio) NO entra
// acá: esto es gestión. El objetivo es que el costo y el margen del camión sean los exactos.
router.post('/embarques/:id/cerrar', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const emb = db.prepare('SELECT * FROM sg_embarques WHERE id=? AND activo=1').get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    if (emb.estado === 'cerrado') return res.status(400).json({ ok: false, error: 'El embarque ya está cerrado' });
    if (emb.estado !== 'recibido') return res.status(400).json({ ok: false, error: 'Solo se puede cerrar un embarque recibido. Este está en "' + emb.estado + '".' });

    const costos = embCostos(db, emb.id);
    const proy = calcEmbarque(emb, costos, true);    // solo estimados + tc estimado
    const real = calcEmbarque(emb, costos);          // COALESCE(real, estimado) + tc real
    if (real.costo_caja_neto == null)
      return res.status(400).json({ ok: false, error: real.sin_tc && real.sin_tc.length
        ? 'Falta el tipo de cambio: ' + real.sin_tc.join(', ') + ' está en dólares y no hay curva cargada en su fecha de pago. Cargá la curva antes de cerrar.'
        : 'No se puede costear el embarque (falta cantidad de cajas o costos cargados)' });

    let recosteo;
    const tx = db.transaction(() => {
      recosteo = recostearLotesEmbarque(db, emb, uid(req));
      db.prepare(`UPDATE sg_embarques SET estado='cerrado',
          cerrado_en=datetime('now','localtime'), cerrado_por=?,
          cierre_tc=?, cierre_neto_proyectado=?, cierre_neto_real=?,
          cierre_costo_caja_proyectado=?, cierre_costo_caja_real=?,
          modificado_en=datetime('now','localtime'), modificado_por=?
        WHERE id=?`)
        .run(uid(req), real.tc_aplicado, proy.neto, real.neto,
             proy.costo_caja_neto, real.costo_caja_neto, uid(req), emb.id);
    });
    tx();

    const embPost = db.prepare('SELECT * FROM sg_embarques WHERE id=?').get(emb.id);
    res.json({ ok: true, data: {
      proyectado: { neto: proy.neto, costo_caja: proy.costo_caja_neto, tc: proy.tc_aplicado },
      real:       { neto: real.neto, costo_caja: real.costo_caja_neto, tc: real.tc_aplicado },
      desvio: real.neto - proy.neto,
      desvio_pct: proy.neto > 0 ? (real.neto - proy.neto) / proy.neto * 100 : null,
      recosteo,
      resultado: resultadoEmbarque(db, embPost)
    } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// POST /embarques/:id/recostear — re-costear sin cerrar. Sirve cuando van llegando los
// números reales de a poco (liquidación del despachante, tc de pago) y querés que el stock
// valga lo correcto antes del cierre definitivo.
router.post('/embarques/:id/recostear', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const emb = db.prepare('SELECT * FROM sg_embarques WHERE id=? AND activo=1').get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    if (emb.estado !== 'recibido') return res.status(400).json({ ok: false, error: 'Solo se re-costea un embarque recibido y todavía no cerrado' });
    let r;
    db.transaction(() => { r = recostearLotesEmbarque(db, emb, uid(req)); })();
    res.json({ ok: true, data: r });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── EXPEDIENTE DOCUMENTAL DEL EMBARQUE (Importación F6) ──────────────────────────
// Archiva los documentos de importación en Cloudflare R2 (persistente). Upload en MEMORIA
// (memoryStorage: nunca toca el disco efímero) → subirArchivo() a R2 → fila con la storage_key.
// El serving es por PROXY con requireAuth (no URL firmada). Molde: sg_gastos_directos.
const DOC_TIPOS = new Set(['factura_comercial','packing_list','bl','poliza_seguro','despacho_aduana',
  'factura_despachante','factura_flete','swift','cert_fitosanitario','cert_origen','otro']);

// ── LOS PAPELES QUE FIJAN EL COSTO ──────────────────────────────────────────────────
// Qué rubro confirma cada documento. Fuera de esta tabla, un documento sólo se archiva.
//   despacho_aduana      -> IVA, IIBB y Tasa María, en dólares, con la cotización de
//                           oficialización que trae el propio despacho.
//   factura_despachante  -> despachante, la factura ENTERA con IVA adentro, en pesos.
//   factura_flete        -> flete real, la factura entera, en pesos.
//   swift                -> mercadería y gastos bancarios, en pesos. Acá desaparece la
//                           estimación de TC: es lo que efectivamente salió.
//   factura_comercial    -> mercadería en dólares (el TC lo sigue poniendo la curva).
const DOC_RUBROS = {
  despacho_aduana:     ['iva', 'iibb', 'tasa_maria'],
  factura_despachante: ['despachante'],
  factura_flete:       ['flete_real'],
  swift:               ['mercaderia', 'bancarios'],
};

// Escribe (o reemplaza) el real de un rubro. Reemplaza en vez de acumular: si el papel se
// vuelve a cargar —porque estaba mal leído, o porque llegó una nota de crédito— vale el
// último. Dos filas activas del mismo rubro se sumarían al costo sin que nadie lo pida.
function guardarReal(db, { embarqueId, rubro, monto, moneda, tc, docId, origen, obs, userId }) {
  const m = Number(monto) || 0;
  const ars = moneda === 'ARS' ? m : (tc != null ? r2(m * Number(tc)) : m);
  db.prepare('UPDATE sg_embarque_reales SET activo=0 WHERE embarque_id=? AND rubro=? AND activo=1')
    .run(embarqueId, rubro);
  db.prepare('INSERT INTO sg_embarque_reales'
    + ' (embarque_id, rubro, monto, moneda, tc, monto_ars, documento_id, origen, observaciones, usuario_id)'
    + ' VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(embarqueId, rubro, m, moneda, tc != null ? Number(tc) : null, ars, docId || null,
         origen || null, obs || null, userId || null);
  return { rubro, monto: m, moneda, tc: tc != null ? Number(tc) : null, monto_ars: ars };
}
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

    // ── La factura comercial confirma la mercadería ──────────────────────────────────
    // EL PAPEL MANDA. El invoice fija el precio, así que su monto entra como confirmado y el
    // costeo pasa a usarlo — sin preguntar ni frenar la carga. Lo que NO se hace es pisar el
    // estimado: se conserva al lado, y la diferencia entre los dos queda a la vista. Eso es
    // lo que deja ver si se está cotizando bien, que es el punto de todo esto.
    const esInvoice = tipo === 'factura_comercial';
    let nroInvoice = null, montoInvoice = null, rubroMerc = null;
    if (esInvoice) {
      nroInvoice = val(req.body.nro_invoice);
      if (!nroInvoice) return res.status(400).json({ ok: false, error: 'Falta el número de invoice' });
      montoInvoice = (req.body.monto_total != null && req.body.monto_total !== '') ? Number(req.body.monto_total) : null;
      if (!(montoInvoice > 0)) return res.status(400).json({ ok: false, error: 'Falta el monto total del invoice (en dólares)' });

      // Esto sí corta: el mismo invoice en dos embarques es un error de carga, no un desvío.
      const dup = db.prepare(`SELECT id, nombre FROM sg_embarques
        WHERE nro_invoice = ? AND id <> ? AND activo=1 AND eliminado_en IS NULL`).get(nroInvoice, emb.id);
      if (dup) return res.status(409).json({ ok: false, error: 'El invoice ' + nroInvoice + ' ya está cargado en el embarque "' + dup.nombre + '"' });

      rubroMerc = db.prepare("SELECT * FROM sg_embarque_costos WHERE embarque_id=? AND concepto='costo_mercaderia' AND activo=1").get(emb.id);
    }

    // ── Los otros papeles que fijan el costo ─────────────────────────────────────────
    // Se valida ANTES de subir a R2: si falta un dato, que no quede el archivo arriba y la
    // confirmación a medias. Un documento a medio confirmar es peor que uno que no entró.
    const numOp = v => (v != null && v !== '') ? Number(v) : null;
    const pedir = (v, msg) => { if (!(v > 0)) throw Object.assign(new Error(msg), { status: 400 }); return v; };
    const confirmar = [];
    if (tipo === 'despacho_aduana') {
      // El despacho liquida en dólares y trae la cotización del día de oficialización.
      const tcOf = pedir(numOp(req.body.tc_oficializacion), 'Falta la cotización del día de oficialización del despacho');
      // CERO EXPLÍCITO para lo que el despacho no liquida (decisión de Andy, 20/8/2026): los
      // tributos marcados con X, o que no figuran, no se pagan. Se escribe la fila igual —en
      // cero— para que el cuadro muestre de dónde salió ese cero y no parezca un olvido.
      for (const [rubro, campo] of [['iva', 'iva_usd'], ['iibb', 'iibb_usd'], ['tasa_maria', 'tasa_maria_usd']]) {
        confirmar.push({ rubro, monto: numOp(req.body[campo]) || 0, moneda: 'USD', tc: tcOf });
      }
    } else if (tipo === 'factura_despachante') {
      confirmar.push({ rubro: 'despachante', moneda: 'ARS', tc: null,
        monto: pedir(numOp(req.body.importe_ars), 'Falta el importe de la factura del despachante (en pesos)') });
    } else if (tipo === 'factura_flete') {
      confirmar.push({ rubro: 'flete_real', moneda: 'ARS', tc: null,
        monto: pedir(numOp(req.body.importe_ars), 'Falta el importe de la factura del flete (en pesos)') });
    } else if (tipo === 'swift') {
      confirmar.push({ rubro: 'mercaderia', moneda: 'ARS', tc: null,
        monto: pedir(numOp(req.body.mercaderia_ars), 'Falta el monto de la mercadería que pagó el swift (en pesos)') });
      // Los bancarios pueden ser cero (una transferencia sin gastos): no se exigen.
      confirmar.push({ rubro: 'bancarios', moneda: 'ARS', tc: null, monto: numOp(req.body.bancarios_ars) || 0 });
    }

    const key = `embarques/${emb.id}/${randomUUID()}-${sanitizarNombreDoc(f.originalname)}`;
    await subirArchivo(f.buffer, key, f.mimetype);
    const info = db.prepare(`INSERT INTO sg_embarque_documentos
      (embarque_id, tipo, storage_key, nombre_original, mime, tamano_bytes, fecha_documento, observaciones, creado_por)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(emb.id, tipo, key, String(f.originalname || 'documento').slice(0, 255), f.mimetype, f.size, val(req.body.fecha_documento), val(req.body.observaciones), uid(req));
    const docId = Number(info.lastInsertRowid);

    // Con el invoice arriba, la mercadería deja de ser una estimación: el número del papel
    // pasa a ser el monto del rubro y queda marcado como confirmado por ese documento.
    let confirmacion = null;
    if (esInvoice) {
      // El estimado NO se toca: el monto del papel va a monto_confirmado, al lado. El costeo
      // pasa a usar el confirmado, y la diferencia contra el estimado queda visible.
      const estimado = rubroMerc && rubroMerc.monto_estimado != null ? Number(rubroMerc.monto_estimado) : null;
      db.transaction(() => {
        db.prepare("UPDATE sg_embarques SET nro_invoice=?, modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?")
          .run(nroInvoice, uid(req), emb.id);
        if (rubroMerc) {
          db.prepare(`UPDATE sg_embarque_costos SET monto_confirmado=?,
              confirmado_en=datetime('now','localtime'), confirmado_por=?, confirmado_doc_id=?,
              modificado_en=datetime('now','localtime'), modificado_por=? WHERE id=?`)
            .run(montoInvoice, uid(req), docId, uid(req), rubroMerc.id);
        } else {
          // Sin rubro previo no hay nada que comparar: el papel es también el estimado.
          db.prepare(`INSERT INTO sg_embarque_costos
              (embarque_id, concepto, es_credito, moneda, monto_estimado, monto_confirmado,
               confirmado_en, confirmado_por, confirmado_doc_id, creado_por)
              VALUES (?, 'costo_mercaderia', 0, 'USD', ?, ?, datetime('now','localtime'), ?, ?, ?)`)
            .run(emb.id, montoInvoice, montoInvoice, uid(req), docId, uid(req));
        }
      })();
      confirmacion = { nro_invoice: nroInvoice, monto: montoInvoice, estimado,
                       diferencia: estimado != null ? r2(montoInvoice - estimado) : null };
      // También a la tabla de reales, que es de donde lee el estimador. La mercadería del
      // invoice queda en DÓLARES y sin TC propio: su cotización la sigue poniendo la curva
      // según la fecha de pago, hasta que llegue el swift y diga lo que salió de verdad.
      db.transaction(() => guardarReal(db, { embarqueId: emb.id, rubro: 'mercaderia',
        monto: montoInvoice, moneda: 'USD', tc: null, docId, origen: 'factura_comercial',
        userId: uid(req) }))();
    }

    // Los demás papeles escriben su rubro y listo: el estimador los lee de ahí y deja de
    // estimarlo. Todo en una transacción para no dejar el despacho con dos tributos de tres.
    const reales = [];
    if (confirmar.length) {
      db.transaction(() => {
        for (const c of confirmar) {
          reales.push(guardarReal(db, { embarqueId: emb.id, rubro: c.rubro, monto: c.monto,
            moneda: c.moneda, tc: c.tc, docId, origen: tipo, userId: uid(req) }));
        }
      })();
    }
    res.json({ ok: true, data: { id: docId, confirmacion, reales } });
  } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
});

// ── LEERLE LOS DATOS AL DOCUMENTO (IA) ───────────────────────────────────────────
// Devuelve una PROPUESTA para llenar el formulario de carga: número, fecha y monto.
// NO guarda nada y NO sube el archivo. El operador mira lo que se leyó, corrige lo que
// haga falta y recién ahí toca "Subir documento" — que es el endpoint de arriba, el que
// confirma el costo. La IA acá adelanta tipeo, no decide.
//
// Molde: /factura-mercaderia/leer (más arriba en este archivo), con dos diferencias: usa el
// SDK oficial (como servicios/dedup.js) y no manda el header beta de PDF, que ya no hace falta.

// Qué mirar en cada papel. Sin esto la lectura de un BL y la de una póliza salen igual de vagas.
const DOC_PISTAS = {
  factura_comercial: 'Es un COMMERCIAL INVOICE de importación. "numero" es el N° de invoice. "monto_total" es el TOTAL del invoice (el importe final a pagar, sea FOB o CIF). "cantidad_bultos" son las cajas (cartons / packages / bultos).',
  packing_list:      'Es un PACKING LIST. "numero" es su número, que suele coincidir con el del invoice. "cantidad_bultos" son los bultos o cajas. Casi nunca trae importe: si no hay, monto_total va en null.',
  bl:                'Es un BL / conocimiento de embarque (Bill of Lading marítimo o CRT terrestre). "numero" es el N° de BL o de CRT y "fecha" la de emisión o de embarque. Si figura el buque o la patente del camión, ponelo en observaciones.',
  poliza_seguro:     'Es una PÓLIZA DE SEGURO. "numero" es el N° de póliza. "monto_total" es la PRIMA, o sea lo que se paga; si solo figura la suma asegurada, poné esa y aclaralo en observaciones.',
  despacho_aduana:
    'Es un DESPACHO DE ADUANA argentino. "numero" es el N° de despacho y "fecha" la de OFICIALIZACIÓN. ' +
    'De la LIQUIDACIÓN DE TRIBUTOS sacá tres importes, EN DÓLARES, y ponelos en "tributos": IVA, ' +
    'Tasa de Estadística / Tasa María, e Ingresos Brutos (IIBB). ' +
    'REGLA DE LA FORMA DE PAGO: cada tributo tiene una columna con una letra que dice cómo se paga. ' +
    'Tomá SÓLO los marcados con "P" (se paga). Los marcados con "X" NO se pagan —exento o no ' +
    'corresponde—: esos van en 0. No los omitas ni los dejes en null: poné 0 y aclaralo en observaciones. ' +
    'Poné además "tc_oficializacion": la cotización del dólar del día de oficialización que figura en ' +
    'el despacho. Es la que pasa esos dólares a pesos; si no la encontrás dejala en null y avisá.',
  factura_despachante:
    'Es la FACTURA DEL DESPACHANTE de aduana, en pesos. "monto_total" es el TOTAL de la factura, CON ' +
    'IVA incluido: va entera al costo. No descuentes el IVA ni lo separes.',
  factura_flete:
    'Es la FACTURA DEL FLETE (el transportista), en pesos. "monto_total" es el TOTAL de la factura, ' +
    'con IVA incluido: va entera al costo.',
  swift:
    'Es un SWIFT o comprobante de transferencia al exterior, en PESOS. Interesan dos importes: ' +
    '"monto_total" es lo que se pagó por la MERCADERÍA en pesos, y "gastos_bancarios" el total de ' +
    'gastos, comisiones e intereses bancarios de la operación, también en pesos. Si el comprobante ' +
    'muestra el tipo de cambio aplicado, ponelo en observaciones.',
  cert_fitosanitario:'Es un CERTIFICADO FITOSANITARIO. Interesan solo el número y la fecha; monto_total va en null.',
  cert_origen:       'Es un CERTIFICADO DE ORIGEN. Interesan solo el número y la fecha; monto_total va en null.',
  otro:              'Es un documento de importación sin tipo definido. Sacá el número, la fecha y el importe si los tiene.',
};

router.post('/embarques/:id/documentos/leer', requireAdmin, uploadDoc, async (req, res) => {
  const db = getDb();
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ ok: false, error: 'La lectura automática no está configurada en este servidor' });
    }
    const emb = db.prepare(`SELECT e.*, p.razon_social AS proveedor_nombre
      FROM sg_embarques e LEFT JOIN sg_proveedores p ON p.id = e.proveedor_id
      WHERE e.id=? AND e.activo=1`).get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    const f = req.file;
    if (!f) return res.status(400).json({ ok: false, error: 'Falta el archivo' });
    const tipo = val(req.body.tipo) || 'otro';
    if (!DOC_TIPOS.has(tipo)) return res.status(400).json({ ok: false, error: 'Tipo de documento inválido' });
    if (!DOC_MIMES.has(f.mimetype)) return res.status(400).json({ ok: false, error: 'Formato no permitido (solo PDF, JPG o PNG)' });

    const b64 = f.buffer.toString('base64');
    const contenido = f.mimetype === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: f.mimetype, data: b64 } };

    const prompt = `Leé este documento de una importación y extraé los datos de su cabecera.
${DOC_PISTAS[tipo] || DOC_PISTAS.otro}

Respondé ÚNICAMENTE un JSON válido, sin markdown ni backticks, con estas claves:

{"numero":"","fecha":"AAAA-MM-DD","monto_total":0,"moneda":"USD","cantidad_bultos":0,
 "emisor":"","gastos_bancarios":null,"tc_oficializacion":null,
 "tributos":{"iva_usd":null,"tasa_maria_usd":null,"iibb_usd":null},
 "confianza":"alta|media|baja","observaciones":""}

REGLAS:
- Los montos son NÚMEROS, sin separador de miles ni símbolo de moneda. "moneda" es el código de
  tres letras que figure en el papel (USD, EUR, ARS...). Si el documento no la dice, poné null.
- La fecha va en AAAA-MM-DD. Ojo con el orden día/mes: los documentos de exportación suelen venir
  en formato inglés (MM/DD/AAAA). Si no podés distinguirlo con certeza, dejala en null y decilo
  en observaciones.
- Lo que no puedas leer con seguridad va en null, NUNCA inventado. Si dudás de un monto o de un
  número, poné confianza "baja" y explicá en observaciones qué es lo que no se lee.
- "emisor" es quien emitió el papel (el exportador, la aseguradora, la naviera, según el caso).
- "observaciones" es una línea corta en castellano para la persona que va a revisar esto.${emb.proveedor_nombre ? `
- Este embarque es del proveedor "${emb.proveedor_nombre}". Si el emisor del documento es otro,
  dejá igual el que leíste y avisalo en observaciones: puede ser un papel de otro embarque.` : ''}`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: MODELO_CHAT,
      max_tokens: 800,
      messages: [{ role: 'user', content: [contenido, { type: 'text', text: prompt }] }],
    });
    const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (!txt) return res.status(502).json({ ok: false, error: 'La lectura no devolvió nada' });

    let leido;
    try {
      leido = JSON.parse(txt.replace(/```json|```/g, '').trim());
    } catch (_) {
      // El texto crudo en el 422 deja ver QUÉ contestó. Un 500 pelado esconde el problema.
      return res.status(422).json({ ok: false, error: 'No se pudo interpretar la lectura', raw: txt.slice(0, 800) });
    }

    // Los controles que la pantalla no puede hacer sola. Van como AVISOS, no como bloqueos:
    // el que decide es el operador, y el bloqueo de verdad está en el endpoint de subida.
    const avisos = [];
    const num2 = v => (v != null && v !== '' && !isNaN(Number(v))) ? Number(v) : null;
    const num = num2(leido.monto_total);
    const moneda = leido.moneda ? String(leido.moneda).toUpperCase().slice(0, 3) : null;
    if (leido.confianza === 'baja') avisos.push('La lectura no está segura: revisá los tres campos contra el papel.');

    if (tipo === 'despacho_aduana') {
      if (num2(leido.tc_oficializacion) == null) {
        avisos.push('No se leyó la cotización del día de oficialización. Sin ese dato los tributos no se pueden pasar a pesos: buscala en el despacho y cargala a mano.');
      }
      // Un tributo en null es distinto de un tributo en cero: null es "no lo pude leer" y
      // cero es "el despacho dice que no se paga". Confundirlos abarata el camión en silencio.
      const t = leido.tributos || {};
      const sinLeer = [['iva_usd','IVA'], ['tasa_maria_usd','Tasa María'], ['iibb_usd','IIBB']]
        .filter(([k]) => num2(t[k]) == null).map(([, l]) => l);
      if (sinLeer.length) {
        avisos.push('No se pudo leer: ' + sinLeer.join(', ') + '. Si el despacho los marca con X van en cero; si no, cargalos a mano — si quedan vacíos el camión sale más barato de lo que es.');
      }
    }

    if (tipo === 'factura_comercial') {
      // El campo del formulario es en dólares. Si el invoice viene en otra moneda, el número
      // que se leyó NO se puede copiar tal cual: hay que convertirlo a mano.
      if (moneda && moneda !== 'USD') {
        avisos.push('El invoice está en ' + moneda + ', pero el campo de monto es en dólares. Convertilo antes de subir.');
      }
      if (leido.numero) {
        const dup = db.prepare(`SELECT nombre FROM sg_embarques
          WHERE nro_invoice = ? AND id <> ? AND activo=1 AND eliminado_en IS NULL`).get(String(leido.numero), emb.id);
        if (dup) avisos.push('El invoice ' + leido.numero + ' ya figura en el embarque "' + dup.nombre + '".');
      }
      // El desvío contra lo cotizado, ANTES de subir: si el número está mal leído, se ve acá.
      const rubro = db.prepare(`SELECT monto_estimado FROM sg_embarque_costos
        WHERE embarque_id=? AND concepto='costo_mercaderia' AND activo=1`).get(emb.id);
      const estimado = rubro && rubro.monto_estimado != null ? Number(rubro.monto_estimado) : null;
      if (num != null && estimado != null && estimado > 0) {
        const dif = r2(num - estimado);
        if (dif) avisos.push('Son ' + (dif > 0 ? '+' : '') + dif.toLocaleString('es-AR') + ' USD contra lo cotizado (US$ ' + estimado.toLocaleString('es-AR') + ').');
      }
    }

    res.json({ ok: true, data: {
      tipo,
      numero: leido.numero != null ? String(leido.numero).trim() : null,
      fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(leido.fecha || '')) ? leido.fecha : null,
      monto_total: num,
      moneda,
      cantidad_bultos: leido.cantidad_bultos != null && !isNaN(Number(leido.cantidad_bultos)) ? Number(leido.cantidad_bultos) : null,
      emisor: leido.emisor || null,
      // Lo que sólo traen algunos papeles. Se devuelve siempre (en null si no aplica) para
      // que la pantalla no tenga que saber qué campos existen para cada tipo.
      gastos_bancarios: num2(leido.gastos_bancarios),
      tc_oficializacion: num2(leido.tc_oficializacion),
      tributos: {
        iva_usd:        num2(leido.tributos && leido.tributos.iva_usd),
        tasa_maria_usd: num2(leido.tributos && leido.tributos.tasa_maria_usd),
        iibb_usd:       num2(leido.tributos && leido.tributos.iibb_usd),
      },
      confianza: leido.confianza || null,
      observaciones: leido.observaciones || null,
      avisos,
    } });
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
    // ?inline=1 → el navegador lo MUESTRA en vez de bajarlo, para el visor de la pantalla.
    // Solo para PDF e imágenes: cualquier otro mime se fuerza a descarga, así un archivo
    // raro no se renderiza dentro de la app.
    const inline = req.query.inline === '1' && /^(application\/pdf|image\/(jpeg|png|webp|gif))$/.test(doc.mime || '');
    res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment')
      + "; filename*=UTF-8''" + encodeURIComponent(doc.nombre_original || 'documento'));
    if (doc.tamano_bytes) res.setHeader('Content-Length', doc.tamano_bytes);
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    stream.pipe(res);
  } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, error: e.message }); }
});

// ELIMINAR — soft delete (conserva el expediente; NO borra de R2). requireAdmin. Anti-IDOR en el WHERE.
router.delete('/embarques/:id/documentos/:docId', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const info = db.prepare(`UPDATE sg_embarque_documentos SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=?
      WHERE id=? AND embarque_id=? AND activo=1`).run(uid(req), req.params.docId, req.params.id);
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Documento no encontrado' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── PRECIO ESPERADO DE VENTA POR PRODUCTO ───────────────────────────────────────────
// Lo carga el que mira la ficha del camión, para poder avisarle a los comerciales a cuánto
// sale y a cuánto se piensa vender. Es una expectativa, no un precio de lista: no toca
// ninguna venta ni ninguna orden.
//
// requireAuth y no requireAdmin: poner un precio de referencia es trabajo del día
// (CLAUDE.md — OPERAR NO ES SER ADMIN).
router.patch('/embarques/:id/precios-venta', requireAuth, express.json(), (req, res) => {
  const db = getDb();
  try {
    const emb = db.prepare('SELECT id FROM sg_embarques WHERE id=? AND activo=1').get(req.params.id);
    if (!emb) return res.status(404).json({ ok: false, error: 'Embarque no encontrado' });
    const items = Array.isArray(req.body && req.body.precios) ? req.body.precios : [];
    // Upsert por (embarque, producto). Un precio vacío BORRA la fila en vez de guardar 0:
    // "todavía no sé a cuánto lo vendo" y "lo regalo" no son lo mismo, y un 0 guardado
    // saldría como precio en el aviso a los comerciales.
    const up = db.prepare('INSERT INTO sg_embarque_precios (embarque_id, producto_id, precio_caja, usuario_id)'
      + ' VALUES (?,?,?,?)'
      + ' ON CONFLICT(embarque_id, producto_id) DO UPDATE SET'
      + '   precio_caja=excluded.precio_caja, usuario_id=excluded.usuario_id,'
      + "   modificado_en=datetime('now','localtime')");
    const del = db.prepare('DELETE FROM sg_embarque_precios WHERE embarque_id=? AND producto_id=?');
    let guardados = 0, borrados = 0;
    db.transaction(() => {
      for (const it of items) {
        const pid = Number(it && it.producto_id);
        if (!(pid > 0)) continue;
        const v = (it.precio_caja != null && it.precio_caja !== '') ? Number(it.precio_caja) : null;
        if (v == null || !(v > 0)) { del.run(emb.id, pid); borrados++; continue; }
        up.run(emb.id, pid, v, uid(req));
        guardados++;
      }
    })();
    res.json({ ok: true, data: { guardados, borrados } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
