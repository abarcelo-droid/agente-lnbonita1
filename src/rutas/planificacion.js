// src/rutas/planificacion.js
// ── API del módulo PLANIFICACIÓN INSUMOS (beta) ───────────────────────────
// Montado en /api/pli. Universo independiente: solo toca tablas pli_*.
//
// CALCULAR ES GET, A PROPÓSITO: index.js:84 monta `bloquearSiSoloLectura` sobre
// todo /api, que devuelve 403 a cualquier POST/PUT/PATCH/DELETE de un usuario
// con solo_lectura=1. Si "Calcular" fuera POST, un usuario visor recibiría
// "Tu usuario es solo lectura. No podés realizar cambios." al intentar simular,
// que es un mensaje engañoso sobre una operación que no escribe nada.
//   GET  /planes/:id/calculo   -> corre el motor, no persiste. Funciona para visores.
//   POST /planes/:id/confirmar -> corre el motor y materializa. Requiere escritura.

import express from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import * as XLSX from 'xlsx';
import db from '../servicios/db_pli.js';   // este import es el que crea el schema pli_*
import { calcularPlan, lunesDe } from '../servicios/pli_motor.js';
import { subirArchivo, obtenerArchivo, storageConfigurado } from '../servicios/storage.js';
import { cotizacionVigente, fijarCotizacionManual, TIPOS as TIPOS_DOLAR } from '../servicios/cotizacion_dolar.js';

const router = express.Router();

// Los adjuntos del insumo van a R2, no a disco: el disco del contenedor de Railway
// es efímero y se pierde en cada redeploy (ver el encabezado de servicios/storage.js).
// memoryStorage porque subirArchivo() recibe un buffer.
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Helpers de request ────────────────────────────────────────────────────

router.use((req, res, next) => {
  try {
    const c = req.cookies?.lnb_user;
    if (c) req.user = JSON.parse(c);
  } catch (_) { /* cookie corrupta: se trata como no autenticado */ }
  next();
});

// auth.js no exporta requireAuth ni soloAdmin, así que van propios acá.
function requireAuth(req, res, next) {
  if (!req.user || !req.user.id) return res.status(401).json({ ok: false, error: 'No autenticado' });
  next();
}
router.use(requireAuth);

// Resolución de sociedad. El interceptor de fetch del panel (panel.html:12986)
// inyecta sociedad_id solo a un whitelist de rutas que NO incluye /api/pli, así
// que la sociedad la resuelve el backend. Molde exacto de proveedores.js:17-33.
// No se agrega pli al whitelist a propósito: cuando el selector del sidebar está
// en "Todas", ese interceptor BLOQUEA toda escritura con un toast, lo que sería
// peor UX en una beta que ni siquiera tiene selector de sociedad.
let _pcId = null;
function sociedadPCId() {
  if (_pcId) return _pcId;
  const r = db.prepare("SELECT id FROM sociedades WHERE nombre = 'Puente Cordón SA'").get()
         || db.prepare("SELECT id FROM sociedades WHERE funcion = 'productiva' ORDER BY id LIMIT 1").get()
         || db.prepare('SELECT id FROM sociedades ORDER BY id LIMIT 1').get();
  _pcId = r ? r.id : 1;
  return _pcId;
}
function getSociedadId(req) {
  const raw = req.body?.sociedad_id ?? req.query?.sociedad_id;
  const id = (raw !== undefined && raw !== null && raw !== '') ? parseInt(raw, 10) : null;
  if (Number.isInteger(id)) {
    const ok = db.prepare('SELECT id FROM sociedades WHERE id = ?').get(id);
    if (ok) return id;
  }
  return sociedadPCId();
}

// Errores tipados: el wrap los convierte en la respuesta correcta.
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const notFound = (msg) => Object.assign(new Error(msg || 'No encontrado'), { status: 404 });
const conflict = (msg, extra) => Object.assign(new Error(msg), { status: 409, extra });

// No hay error middleware global en index.js: un throw sin catch devuelve HTML
// y rompe el r.json() del panel. Por eso CADA handler va envuelto.
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
// Los CHECK del DDL quedan como red de seguridad, no como primera línea.

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
function vFecha(v, campo) {
  const s = vTexto(v, campo);
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${campo} tiene que tener formato AAAA-MM-DD`);
  return s;
}

function logPli(entidad, entidadId, accion, detalle, userId) {
  try {
    db.prepare('INSERT INTO pli_log (entidad, entidad_id, accion, detalle, usuario_id) VALUES (?,?,?,?,?)')
      .run(entidad, entidadId || null, accion, detalle ? JSON.stringify(detalle) : null, userId || null);
  } catch (e) {
    console.error('[PLI] Error escribiendo log:', e.message);
  }
}

const AHORA = "datetime('now','localtime')";

// ══════════════════════════════════════════════════════════════════════════
// TEMPORADAS
// ══════════════════════════════════════════════════════════════════════════

router.get('/temporadas', wrap((req, res) => {
  const soc = getSociedadId(req);
  const data = db.prepare(`
    SELECT * FROM pli_temporadas
    WHERE sociedad_id = ? AND eliminado_en IS NULL
    ORDER BY activa DESC, id DESC
  `).all(soc);
  res.json({ ok: true, data });
}));

router.post('/temporadas', wrap((req, res) => {
  const soc = getSociedadId(req);
  const nombre = vTexto(req.body?.nombre, 'El nombre', { req: true });
  const desde = vFecha(req.body?.fecha_desde, 'Fecha desde');
  const hasta = vFecha(req.body?.fecha_hasta, 'Fecha hasta');
  if (desde && hasta && hasta < desde) throw bad('La fecha hasta no puede ser anterior a la fecha desde');
  const r = db.prepare(`
    INSERT INTO pli_temporadas (sociedad_id, nombre, fecha_desde, fecha_hasta, creado_por_id, actualizado_por_id)
    VALUES (?,?,?,?,?,?)
  `).run(soc, nombre, desde, hasta, req.user.id, req.user.id);
  logPli('temporada', r.lastInsertRowid, 'alta', { nombre }, req.user.id);
  res.json({ ok: true, id: r.lastInsertRowid });
}));

router.post('/temporadas/:id/activar', wrap((req, res) => {
  const soc = getSociedadId(req);
  const id = parseInt(req.params.id, 10);
  const t = db.prepare('SELECT id FROM pli_temporadas WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(id, soc);
  if (!t) throw notFound('Temporada no encontrada');
  db.transaction(() => {
    db.prepare('UPDATE pli_temporadas SET activa=0 WHERE sociedad_id=?').run(soc);
    db.prepare(`UPDATE pli_temporadas SET activa=1, actualizado_en=${AHORA} WHERE id=?`).run(id);
  })();
  logPli('temporada', id, 'activar', null, req.user.id);
  res.json({ ok: true });
}));

// Temporada vigente: la activa, o la más reciente. Devuelve null si no hay ninguna.
function temporadaActiva(soc) {
  return db.prepare(`
    SELECT * FROM pli_temporadas
    WHERE sociedad_id=? AND eliminado_en IS NULL
    ORDER BY activa DESC, id DESC LIMIT 1
  `).get(soc) || null;
}

// ══════════════════════════════════════════════════════════════════════════
// INSUMOS (catálogo propio del módulo)
// ══════════════════════════════════════════════════════════════════════════

const CAMPOS_UNIDAD = ['unidad_uso', 'unidad_compra', 'factor_compra'];

router.get('/insumos', wrap((req, res) => {
  const soc = getSociedadId(req);
  const { q, categoria } = req.query;
  const verInactivos = req.query.incluir_inactivos === '1';
  const params = [soc];
  let sql = 'SELECT * FROM pli_insumos WHERE sociedad_id=? AND eliminado_en IS NULL';
  if (!verInactivos) sql += ' AND activo=1';
  if (q) { sql += ' AND (nombre LIKE ? OR categoria LIKE ? OR codigo LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (categoria) { sql += ' AND categoria = ?'; params.push(categoria); }
  sql += ' ORDER BY categoria, nombre COLLATE NOCASE';
  const data = db.prepare(sql).all(...params);
  // Valores ya usados: alimentan los <datalist> del front (texto libre, sin enum rígido)
  const categorias = db.prepare(`
    SELECT DISTINCT categoria FROM pli_insumos
    WHERE sociedad_id=? AND eliminado_en IS NULL AND categoria IS NOT NULL AND categoria <> ''
    ORDER BY categoria
  `).all(soc).map(r => r.categoria);
  const unidades = db.prepare(`
    SELECT DISTINCT unidad_uso AS u FROM pli_insumos WHERE sociedad_id=? AND eliminado_en IS NULL
    UNION SELECT DISTINCT unidad_compra FROM pli_insumos WHERE sociedad_id=? AND eliminado_en IS NULL
  `).all(soc, soc).map(r => r.u).filter(Boolean).sort();
  const proveedores = db.prepare(`
    SELECT DISTINCT proveedor_texto FROM pli_insumos
    WHERE sociedad_id=? AND eliminado_en IS NULL AND proveedor_texto IS NOT NULL AND proveedor_texto <> ''
    ORDER BY proveedor_texto
  `).all(soc).map(r => r.proveedor_texto);
  res.json({ ok: true, data, categorias, unidades, proveedores });
}));

router.get('/insumos/:id', wrap((req, res) => {
  const soc = getSociedadId(req);
  const d = db.prepare('SELECT * FROM pli_insumos WHERE id=? AND sociedad_id=?').get(parseInt(req.params.id, 10), soc);
  if (!d) throw notFound('Insumo no encontrado');
  res.json({ ok: true, data: d });
}));

// Dónde se usa: alimenta el 409 al eliminar y el botón de la UI.
function usosDeInsumo(insumoId) {
  return db.prepare(`
    SELECT p.id AS producto_id, p.nombre, rl.cantidad, rl.por_cada, rl.unidad
    FROM pli_receta_lineas rl
    JOIN pli_productos p ON p.id = rl.producto_id AND rl.version = p.receta_version
    WHERE rl.insumo_id = ? AND p.eliminado_en IS NULL
    ORDER BY p.nombre
  `).all(insumoId);
}

router.get('/insumos/:id/donde-se-usa', wrap((req, res) => {
  res.json({ ok: true, data: usosDeInsumo(parseInt(req.params.id, 10)) });
}));

function leerInsumoBody(body, parcialDe = null) {
  const b = body || {};
  const g = (campo, fn) => (b[campo] === undefined && parcialDe) ? parcialDe[campo] : fn();
  return {
    nombre:          g('nombre',          () => vTexto(b.nombre, 'El nombre', { req: true })),
    codigo:          g('codigo',          () => vTexto(b.codigo, 'El código', { max: 50 })),
    categoria:       g('categoria',       () => vTexto(b.categoria, 'La categoría', { max: 80 })),
    unidad_uso:      g('unidad_uso',      () => vTexto(b.unidad_uso, 'La unidad de uso', { req: true, max: 30 })),
    unidad_compra:   g('unidad_compra',   () => vTexto(b.unidad_compra, 'La unidad de compra', { req: true, max: 30 })),
    factor_compra:   g('factor_compra',   () => vNum(b.factor_compra, 'El factor de compra', { min: 1e-9, def: 1 })),
    multiplo_compra: g('multiplo_compra', () => vNum(b.multiplo_compra, 'El múltiplo de compra', { min: 0, def: 1 })),
    moq:             g('moq',             () => vNum(b.moq, 'El mínimo de compra', { min: 0, def: 0 })),
    precio_ref:      g('precio_ref',      () => vNum(b.precio_ref, 'El precio', { min: 0, def: 0 })),
    moneda:          g('moneda',          () => {
      const m = (vTexto(b.moneda, 'La moneda') || 'ARS').toUpperCase();
      if (!['ARS', 'USD'].includes(m)) throw bad('La moneda tiene que ser ARS o USD');
      return m;
    }),
    precio_fecha:    g('precio_fecha',    () => vFecha(b.precio_fecha, 'La fecha del precio')),
    proveedor_texto: g('proveedor_texto', () => vTexto(b.proveedor_texto, 'El proveedor', { max: 120 })),
    // Días de anticipación con los que hay que pedirlo. El default 15 es el piso
    // operativo que se maneja; el IFCO importado tiene plazos mucho más largos.
    lead_time_dias:  g('lead_time_dias',  () => vNum(b.lead_time_dias, 'El plazo de entrega', { min: 0, max: 365, def: 15, entero: true })),
    // Los insumos que NO se compran (IFCO y todo lo que va por pool retornable,
    // comodato o lo pone el cliente) quedan fuera de la lista de compra y del
    // total: el motor solo explota los que tienen modo 'compra'.
    modo_provision:  g('modo_provision',  () => {
      const m = vTexto(b.modo_provision, 'El modo de provisión') || 'compra';
      if (!['compra', 'alquiler_uso', 'comodato', 'provee_cliente'].includes(m))
        throw bad('Modo de provisión inválido');
      return m;
    }),
    notas:           g('notas',           () => vTexto(b.notas, 'Las notas', { max: 500 }))
  };
}

router.post('/insumos', wrap((req, res) => {
  const soc = getSociedadId(req);
  const d = leerInsumoBody(req.body);
  const dup = db.prepare(`
    SELECT id FROM pli_insumos WHERE sociedad_id=? AND nombre=? COLLATE NOCASE AND eliminado_en IS NULL
  `).get(soc, d.nombre);
  if (dup) throw conflict(`Ya existe un insumo llamado "${d.nombre}"`);
  const r = db.prepare(`
    INSERT INTO pli_insumos
      (sociedad_id, codigo, nombre, categoria, unidad_uso, unidad_compra, factor_compra,
       multiplo_compra, moq, precio_ref, moneda, precio_fecha, proveedor_texto,
       lead_time_dias, modo_provision, notas, creado_por_id, actualizado_por_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(soc, d.codigo, d.nombre, d.categoria, d.unidad_uso, d.unidad_compra, d.factor_compra,
         d.multiplo_compra, d.moq, d.precio_ref, d.moneda, d.precio_fecha, d.proveedor_texto,
         d.lead_time_dias, d.modo_provision, d.notas, req.user.id, req.user.id);
  registrarPrecio(r.lastInsertRowid, d, 'alta', req.user.id);
  logPli('insumo', r.lastInsertRowid, 'alta', d, req.user.id);
  res.json({ ok: true, id: r.lastInsertRowid });
}));

// Carga masiva: pegar desde Excel. Sin esto, alguien con 80 insumos en una
// planilla tiene que tipear media jornada antes de ver el primer número, que es
// exactamente el momento en que se abandona una beta.
router.post('/insumos/bulk', wrap((req, res) => {
  const soc = getSociedadId(req);
  const filas = req.body?.filas;
  if (!Array.isArray(filas) || !filas.length) throw bad('No hay filas para importar');
  if (filas.length > 500) throw bad('Máximo 500 filas por importación');

  const errores = [];
  const validas = [];
  filas.forEach((f, i) => {
    try {
      const d = leerInsumoBody(f);
      const dup = db.prepare(`
        SELECT id FROM pli_insumos WHERE sociedad_id=? AND nombre=? COLLATE NOCASE AND eliminado_en IS NULL
      `).get(soc, d.nombre);
      if (dup) throw bad(`ya existe un insumo llamado "${d.nombre}"`);
      if (validas.some(v => v.nombre.toLowerCase() === d.nombre.toLowerCase()))
        throw bad(`"${d.nombre}" está repetido en la propia importación`);
      validas.push(d);
    } catch (e) {
      errores.push({ fila: i + 1, error: e.message });
    }
  });
  if (errores.length) {
    // Todo o nada: importar solo las válidas dejaría al usuario sin saber cuáles
    // faltan y volviendo a pegar la planilla entera generaría duplicados.
    throw Object.assign(
      new Error(`${errores.length} fila(s) con problemas. No se importó nada.`),
      { status: 400, extra: { errores } }
    );
  }

  const ins = db.prepare(`
    INSERT INTO pli_insumos
      (sociedad_id, codigo, nombre, categoria, unidad_uso, unidad_compra, factor_compra,
       multiplo_compra, moq, precio_ref, moneda, precio_fecha, proveedor_texto,
       lead_time_dias, modo_provision, notas, creado_por_id, actualizado_por_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  db.transaction(() => {
    for (const d of validas) {
      ins.run(soc, d.codigo, d.nombre, d.categoria, d.unidad_uso, d.unidad_compra, d.factor_compra,
              d.multiplo_compra, d.moq, d.precio_ref, d.moneda, d.precio_fecha, d.proveedor_texto,
              d.lead_time_dias, d.modo_provision, d.notas, req.user.id, req.user.id);
    }
  })();
  logPli('insumo', null, 'alta_masiva', { cantidad: validas.length }, req.user.id);
  res.json({ ok: true, importados: validas.length });
}));

// Validación previa del pegado (no escribe): devuelve el preview con los errores
// marcados por fila para que el usuario corrija antes de confirmar.
router.post('/insumos/bulk/validar', wrap((req, res) => {
  const soc = getSociedadId(req);
  const filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
  const out = filas.map((f, i) => {
    try {
      const d = leerInsumoBody(f);
      const dup = db.prepare(`
        SELECT id FROM pli_insumos WHERE sociedad_id=? AND nombre=? COLLATE NOCASE AND eliminado_en IS NULL
      `).get(soc, d.nombre);
      return { fila: i + 1, ok: !dup, datos: d, error: dup ? `Ya existe "${d.nombre}"` : null };
    } catch (e) {
      return { fila: i + 1, ok: false, datos: f, error: e.message };
    }
  });
  res.json({ ok: true, data: out, validas: out.filter(r => r.ok).length, con_error: out.filter(r => !r.ok).length });
}));

router.patch('/insumos/:id', wrap((req, res) => {
  const soc = getSociedadId(req);
  const id = parseInt(req.params.id, 10);
  const actual = db.prepare('SELECT * FROM pli_insumos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(id, soc);
  if (!actual) throw notFound('Insumo no encontrado');

  // Cambiar unidad_uso/unidad_compra/factor_compra de un insumo que ya está en
  // recetas cambia retroactivamente el significado de esas recetas: las líneas
  // viejas siguen diciendo "200 gr" y el motor las dividiría por el factor nuevo.
  // Se bloquea con 409 en vez de permitirlo y avisar después.
  const tocaUnidades = CAMPOS_UNIDAD.some(c =>
    req.body?.[c] !== undefined && String(req.body[c]) !== String(actual[c]));
  if (tocaUnidades) {
    const usos = usosDeInsumo(id);
    if (usos.length) {
      throw conflict(
        `No se pueden cambiar las unidades de "${actual.nombre}": está usado en ${usos.length} receta(s). ` +
        'Cambiá las recetas primero, o dá de alta un insumo nuevo.',
        { usos }
      );
    }
  }

  const d = leerInsumoBody(req.body, actual);
  if (d.nombre.toLowerCase() !== String(actual.nombre).toLowerCase()) {
    const dup = db.prepare(`
      SELECT id FROM pli_insumos WHERE sociedad_id=? AND nombre=? COLLATE NOCASE AND eliminado_en IS NULL AND id<>?
    `).get(soc, d.nombre, id);
    if (dup) throw conflict(`Ya existe un insumo llamado "${d.nombre}"`);
  }
  const activo = req.body?.activo === undefined ? actual.activo : (req.body.activo ? 1 : 0);

  db.prepare(`
    UPDATE pli_insumos SET
      codigo=?, nombre=?, categoria=?, unidad_uso=?, unidad_compra=?, factor_compra=?,
      multiplo_compra=?, moq=?, precio_ref=?, moneda=?, precio_fecha=?, proveedor_texto=?,
      lead_time_dias=?, modo_provision=?,
      notas=?, activo=?, actualizado_en=${AHORA}, actualizado_por_id=?
    WHERE id=?
  `).run(d.codigo, d.nombre, d.categoria, d.unidad_uso, d.unidad_compra, d.factor_compra,
         d.multiplo_compra, d.moq, d.precio_ref, d.moneda, d.precio_fecha, d.proveedor_texto,
         d.lead_time_dias, d.modo_provision,
         d.notas, activo, req.user.id, id);
  // Solo se registra si el precio o la moneda cambiaron de verdad: si no, editar
  // cualquier otro campo ensuciaría la serie con filas repetidas.
  if (Number(d.precio_ref) !== Number(actual.precio_ref) || d.moneda !== actual.moneda) {
    registrarPrecio(id, d, 'edicion', req.user.id);
  }
  logPli('insumo', id, 'edicion', { antes: actual, despues: d }, req.user.id);
  res.json({ ok: true });
}));

router.delete('/insumos/:id', wrap((req, res) => {
  const soc = getSociedadId(req);
  const id = parseInt(req.params.id, 10);
  const a = db.prepare('SELECT * FROM pli_insumos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(id, soc);
  if (!a) throw notFound('Insumo no encontrado');
  const usos = usosDeInsumo(id);
  if (usos.length) {
    throw conflict(`"${a.nombre}" está usado en ${usos.length} receta(s) y no se puede eliminar.`, { usos });
  }
  db.prepare(`UPDATE pli_insumos SET eliminado_en=${AHORA}, eliminado_por_id=?, activo=0 WHERE id=?`)
    .run(req.user.id, id);
  logPli('insumo', id, 'baja', { nombre: a.nombre }, req.user.id);
  res.json({ ok: true });
}));

router.post('/insumos/:id/restaurar', wrap((req, res) => {
  const soc = getSociedadId(req);
  const id = parseInt(req.params.id, 10);
  const a = db.prepare('SELECT * FROM pli_insumos WHERE id=? AND sociedad_id=?').get(id, soc);
  if (!a) throw notFound('Insumo no encontrado');
  const dup = db.prepare(`
    SELECT id FROM pli_insumos WHERE sociedad_id=? AND nombre=? COLLATE NOCASE AND eliminado_en IS NULL AND id<>?
  `).get(soc, a.nombre, id);
  if (dup) throw conflict(`Ya existe otro insumo llamado "${a.nombre}"`);
  db.prepare(`UPDATE pli_insumos SET eliminado_en=NULL, eliminado_por_id=NULL, activo=1, actualizado_en=${AHORA} WHERE id=?`).run(id);
  logPli('insumo', id, 'restaurar', null, req.user.id);
  res.json({ ok: true });
}));

// ── Historial de precios ──────────────────────────────────────────────────
// pli_insumos.precio_ref sigue siendo el precio VIGENTE (es el que snapshotea el
// plan al confirmar). Acá se acumula la serie para ver la evolución.

function registrarPrecio(insumoId, d, origen, userId, fecha) {
  if (!(Number(d.precio_ref) > 0)) return;   // no se registran precios en 0
  try {
    db.prepare(`
      INSERT INTO pli_insumo_precios
        (insumo_id, fecha, precio, moneda, unidad_compra, origen, proveedor_texto, creado_por_id)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(insumoId, fecha || d.precio_fecha || hoyISO(), d.precio_ref, d.moneda,
           d.unidad_compra || null, origen, d.proveedor_texto || null, userId || null);
  } catch (e) {
    console.error('[PLI] Error registrando precio:', e.message);
  }
}

function hoyISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Cotización aplicable a una fecha: la de ese día si existe, y si no la más
// cercana ANTERIOR. Nunca una posterior: convertir un precio de octubre con la
// cotización de diciembre sería inventar.
function tcParaFecha(fecha) {
  try {
    const exacta = db.prepare(`
      SELECT venta, tipo, fecha FROM pli_cotizaciones WHERE fecha=?
      ORDER BY CASE tipo WHEN 'manual' THEN 0 ELSE 1 END LIMIT 1
    `).get(fecha);
    if (exacta) return { tc: exacta.venta, origen: `${exacta.tipo} ${exacta.fecha}` };
    const previa = db.prepare(`
      SELECT venta, tipo, fecha FROM pli_cotizaciones WHERE fecha <= ?
      ORDER BY fecha DESC LIMIT 1
    `).get(fecha);
    if (previa) return { tc: previa.venta, origen: `${previa.tipo} ${previa.fecha} (la más cercana anterior)` };
  } catch (e) { /* sin cotizaciones todavía */ }
  return { tc: null, origen: null };
}

// Alta manual de un precio histórico. Sirve para cargar la serie que ya se tenía
// registrada afuera, sin tener que "editar el insumo" una vez por cada precio.
router.post('/insumos/:id/precios', wrap((req, res) => {
  const soc = getSociedadId(req);
  const id = parseInt(req.params.id, 10);
  const ins = db.prepare('SELECT * FROM pli_insumos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(id, soc);
  if (!ins) throw notFound('Insumo no encontrado');
  const b = req.body || {};

  const fecha = vFecha(b.fecha, 'La fecha');
  if (!fecha) throw bad('La fecha del precio es obligatoria');
  const precio = vNum(b.precio, 'El precio', { min: 0 });
  const moneda = (vTexto(b.moneda, 'La moneda') || 'ARS').toUpperCase();
  if (!['ARS', 'USD'].includes(moneda)) throw bad('La moneda tiene que ser ARS o USD');

  // Si se informa el tipo de cambio de esa fecha, se guarda; si no, se resuelve
  // con lo que haya y se deja constancia de de dónde salió.
  let tc = null, tcOrigen = null;
  if (b.tc !== undefined && b.tc !== null && b.tc !== '') {
    tc = vNum(b.tc, 'El tipo de cambio', { min: 1e-9 });
    tcOrigen = 'informado a mano';
  } else {
    const r = tcParaFecha(fecha);
    tc = r.tc; tcOrigen = r.origen;
  }

  const r = db.prepare(`
    INSERT INTO pli_insumo_precios
      (insumo_id, fecha, precio, moneda, unidad_compra, origen, proveedor_texto, notas,
       tc_usado, tc_origen, creado_por_id)
    VALUES (?,?,?,?,?, 'manual', ?,?,?,?,?)
  `).run(id, fecha, precio, moneda, ins.unidad_compra,
         vTexto(b.proveedor_texto, 'El proveedor', { max: 120 }) || ins.proveedor_texto || null,
         vTexto(b.notas, 'Las notas', { max: 300 }), tc, tcOrigen, req.user.id);

  // Solo si lo piden explícitamente pasa a ser el precio vigente. Cargar un precio
  // viejo NO puede pisar el actual, que es el que usa el plan.
  if (b.vigente) {
    db.prepare(`
      UPDATE pli_insumos SET precio_ref=?, moneda=?, precio_fecha=?, actualizado_en=${AHORA}, actualizado_por_id=?
      WHERE id=?
    `).run(precio, moneda, fecha, req.user.id, id);
  }
  logPli('insumo', id, 'precio_historico', { fecha, precio, moneda, tc, vigente: !!b.vigente }, req.user.id);
  res.json({ ok: true, id: r.lastInsertRowid, tc, tc_origen: tcOrigen });
}));

router.delete('/precios/:precioId', wrap((req, res) => {
  const soc = getSociedadId(req);
  const p = db.prepare(`
    SELECT pr.*, i.nombre FROM pli_insumo_precios pr
    JOIN pli_insumos i ON i.id = pr.insumo_id
    WHERE pr.id=? AND i.sociedad_id=?
  `).get(parseInt(req.params.precioId, 10), soc);
  if (!p) throw notFound('Registro de precio no encontrado');
  // Borrado real: la serie histórica se está cargando a mano y un error de tipeo
  // no tiene por qué quedar para siempre. El log guarda qué se borró.
  db.prepare('DELETE FROM pli_insumo_precios WHERE id=?').run(p.id);
  logPli('insumo', p.insumo_id, 'precio_borrado',
    { fecha: p.fecha, precio: p.precio, moneda: p.moneda }, req.user.id);
  res.json({ ok: true });
}));

router.get('/insumos/:id/precios', wrap((req, res) => {
  const soc = getSociedadId(req);
  const id = parseInt(req.params.id, 10);
  const ins = db.prepare('SELECT * FROM pli_insumos WHERE id=? AND sociedad_id=?').get(id, soc);
  if (!ins) throw notFound('Insumo no encontrado');
  const filas = db.prepare(`
    SELECT * FROM pli_insumo_precios WHERE insumo_id=? ORDER BY fecha DESC, id DESC
  `).all(id);
  // Variación contra el registro inmediatamente anterior de la MISMA moneda: comparar
  // un precio en USD contra uno en ARS daría un porcentaje sin sentido.
  const porMoneda = {};
  const cronologico = filas.slice().reverse();
  for (const f of cronologico) {
    const prev = porMoneda[f.moneda];
    f.variacion_pct = (prev && prev > 0) ? ((f.precio - prev) / prev) * 100 : null;
    porMoneda[f.moneda] = f.precio;

    // Equivalente en la otra moneda, con la cotización de ESA fecha. Los registros
    // viejos no la tienen guardada, así que se resuelve al vuelo y se aclara de
    // dónde salió: un precio convertido sin decir a qué cambio no sirve.
    if (f.tc_usado === null || f.tc_usado === undefined) {
      const r = tcParaFecha(f.fecha);
      f.tc_usado = r.tc; f.tc_origen = r.origen; f.tc_resuelto = 1;
    }
    if (f.tc_usado > 0) {
      f.precio_ars = f.moneda === 'USD' ? f.precio * f.tc_usado : f.precio;
      f.precio_usd = f.moneda === 'USD' ? f.precio : f.precio / f.tc_usado;
    } else {
      f.precio_ars = f.moneda === 'ARS' ? f.precio : null;
      f.precio_usd = f.moneda === 'USD' ? f.precio : null;
    }
  }
  res.json({ ok: true, data: filas, insumo: { id: ins.id, nombre: ins.nombre, unidad_compra: ins.unidad_compra } });
}));

// ── Adjuntos del insumo (registro técnico: foto, ficha, especificación) ────

router.get('/insumos/:id/archivos', wrap((req, res) => {
  const soc = getSociedadId(req);
  const id = parseInt(req.params.id, 10);
  const ins = db.prepare('SELECT id FROM pli_insumos WHERE id=? AND sociedad_id=?').get(id, soc);
  if (!ins) throw notFound('Insumo no encontrado');
  const data = db.prepare(`
    SELECT id, insumo_id, nombre, mime, tamano, tipo, descripcion, creado_en
    FROM pli_insumo_archivos WHERE insumo_id=? AND eliminado_en IS NULL
    ORDER BY creado_en DESC, id DESC
  `).all(id);
  res.json({ ok: true, data, storage_ok: storageConfigurado() });
}));

// Subida. No usa wrap() porque necesita await (subir a R2 es async) y el helper es
// síncrono; va con su propio try/catch.
router.post('/insumos/:id/archivos', subida.single('archivo'), async (req, res) => {
  try {
    const soc = getSociedadId(req);
    const id = parseInt(req.params.id, 10);
    const ins = db.prepare('SELECT id, nombre FROM pli_insumos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(id, soc);
    if (!ins) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    if (!storageConfigurado()) {
      return res.status(503).json({ ok: false, error: 'El almacenamiento de archivos no está configurado (faltan credenciales de R2)' });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: 'Falta el archivo' });

    const mime = req.file.mimetype || 'application/octet-stream';
    const esFoto = mime.startsWith('image/');
    const tipo = req.body?.tipo === 'foto' || req.body?.tipo === 'documento'
      ? req.body.tipo : (esFoto ? 'foto' : 'documento');

    // La key lleva un uuid para que dos archivos con el mismo nombre no se pisen.
    const limpio = String(req.file.originalname || 'archivo').replace(/[^\w.\-]+/g, '_').slice(-80);
    const key = `pli/insumos/${id}/${randomUUID()}-${limpio}`;
    await subirArchivo(req.file.buffer, key, mime);

    const r = db.prepare(`
      INSERT INTO pli_insumo_archivos
        (insumo_id, storage_key, nombre, mime, tamano, tipo, descripcion, creado_por_id)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, key, req.file.originalname || limpio, mime, req.file.size || null, tipo,
           (req.body?.descripcion || '').slice(0, 300) || null, req.user.id);
    logPli('insumo', id, 'archivo_alta', { archivo_id: r.lastInsertRowid, nombre: req.file.originalname, tipo }, req.user.id);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    console.error('[PLI] Error subiendo archivo:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Descarga: hace proxy del stream de R2. inline para que la foto se pueda mostrar
// en el panel y el PDF se abra en el visor del navegador.
router.get('/archivos/:archivoId', async (req, res) => {
  try {
    const soc = getSociedadId(req);
    const a = db.prepare(`
      SELECT ar.* FROM pli_insumo_archivos ar
      JOIN pli_insumos i ON i.id = ar.insumo_id
      WHERE ar.id=? AND i.sociedad_id=? AND ar.eliminado_en IS NULL
    `).get(parseInt(req.params.archivoId, 10), soc);
    if (!a) return res.status(404).json({ ok: false, error: 'Archivo no encontrado' });
    if (!storageConfigurado()) return res.status(503).json({ ok: false, error: 'Almacenamiento no configurado' });
    const stream = await obtenerArchivo(a.storage_key);
    res.set({
      'Content-Type': a.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${String(a.nombre).replace(/"/g, '')}"`
    });
    stream.pipe(res);
  } catch (e) {
    console.error('[PLI] Error bajando archivo:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Soft delete: el archivo se conserva en R2 a propósito (mismo criterio que el
// expediente documental de SG), así una baja por error no pierde el original.
router.delete('/archivos/:archivoId', wrap((req, res) => {
  const soc = getSociedadId(req);
  const a = db.prepare(`
    SELECT ar.id, ar.nombre FROM pli_insumo_archivos ar
    JOIN pli_insumos i ON i.id = ar.insumo_id
    WHERE ar.id=? AND i.sociedad_id=? AND ar.eliminado_en IS NULL
  `).get(parseInt(req.params.archivoId, 10), soc);
  if (!a) throw notFound('Archivo no encontrado');
  db.prepare(`UPDATE pli_insumo_archivos SET eliminado_en=${AHORA}, eliminado_por_id=? WHERE id=?`)
    .run(req.user.id, a.id);
  logPli('insumo', null, 'archivo_baja', { archivo_id: a.id, nombre: a.nombre }, req.user.id);
  res.json({ ok: true });
}));

// ── Cotización del dólar ──────────────────────────────────────────────────
// GET a propósito: es lectura, y tiene que funcionar para usuarios solo lectura.

router.get('/cotizacion', async (req, res) => {
  try {
    const tipo = TIPOS_DOLAR.includes(req.query.tipo) ? req.query.tipo : 'oficial';
    const c = await cotizacionVigente(tipo, { forzar: req.query.refrescar === '1' });
    if (!c) {
      return res.json({
        ok: true, data: null,
        error: 'No se pudo obtener la cotización y no hay ninguna guardada. Cargala a mano.'
      });
    }
    res.json({ ok: true, data: c, tipos: TIPOS_DOLAR });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/cotizacion', wrap((req, res) => {
  const c = fijarCotizacionManual(req.body?.venta, req.user.id, vFecha(req.body?.fecha, 'La fecha'));
  logPli('cotizacion', null, 'manual', { venta: c.venta, fecha: c.fecha }, req.user.id);
  res.json({ ok: true, data: c });
}));

// ══════════════════════════════════════════════════════════════════════════
// PRODUCTOS Y RECETAS
// ══════════════════════════════════════════════════════════════════════════

function productosDeTemporada(soc, temporadaId) {
  return db.prepare(`
    SELECT * FROM pli_productos
    WHERE sociedad_id=? AND temporada_id=? AND eliminado_en IS NULL
    ORDER BY orden, id
  `).all(soc, temporadaId);
}

router.get('/productos', wrap((req, res) => {
  const soc = getSociedadId(req);
  const temp = req.query.temporada_id ? parseInt(req.query.temporada_id, 10) : temporadaActiva(soc)?.id;
  if (!temp) return res.json({ ok: true, data: [], temporada_id: null });
  const filas = productosDeTemporada(soc, temp);

  const conteos = db.prepare(`
    SELECT rl.producto_id AS pid, COUNT(*) AS n
    FROM pli_receta_lineas rl
    JOIN pli_productos p ON p.id = rl.producto_id AND rl.version = p.receta_version
    WHERE p.sociedad_id=? AND p.temporada_id=? AND p.eliminado_en IS NULL
    GROUP BY rl.producto_id
  `).all(soc, temp);
  const nLineas = new Map(conteos.map(c => [c.pid, c.n]));

  const porPadre = new Map();
  for (const p of filas) {
    p.receta_lineas = nLineas.get(p.id) || 0;
    const k = p.padre_id || 0;
    if (!porPadre.has(k)) porPadre.set(k, []);
    porPadre.get(k).push(p);
  }
  for (const p of filas) {
    const hijos = (porPadre.get(p.id) || []).filter(h => h.activo === 1);
    p.hijos = porPadre.get(p.id) || [];
    p.suma_hijos_pct = hijos.reduce((a, h) => a + Number(h.share_pct || 0), 0);
    // Insumos que están en TODOS los subproductos y le corresponden al padre.
    p.sugerencias = hijos.length >= 2 ? sugerenciasDe(p, hijos) : [];
  }
  res.json({ ok: true, data: porPadre.get(0) || [], temporada_id: temp, todos: filas });
}));

// Orden de los productos. Define el orden de las columnas de la grilla de
// objetivos y del árbol, así se pueden agrupar los melones juntos o los propios
// juntos. Reemplazo total del orden de los ids que se manden.
router.put('/productos/orden', wrap((req, res) => {
  const soc = getSociedadId(req);
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length) throw bad('Faltan los productos a ordenar');
  db.transaction(() => {
    const upd = db.prepare(`UPDATE pli_productos SET orden=?, actualizado_en=${AHORA} WHERE id=? AND sociedad_id=?`);
    ids.forEach((id, i) => {
      const pid = parseInt(id, 10);
      if (!Number.isInteger(pid)) throw bad('Hay un producto inválido en el orden');
      upd.run(i + 1, pid, soc);
    });
  })();
  res.json({ ok: true });
}));

// Descendientes de un nodo (para validar ciclos y borrados)
function descendientes(id, guarda = 0) {
  if (guarda > 20) return [];
  const hijos = db.prepare('SELECT id FROM pli_productos WHERE padre_id=? AND eliminado_en IS NULL').all(id);
  let out = hijos.map(h => h.id);
  for (const h of hijos) out = out.concat(descendientes(h.id, guarda + 1));
  return out;
}
function profundidad(id, guarda = 0) {
  if (!id || guarda > 20) return guarda;
  const p = db.prepare('SELECT padre_id FROM pli_productos WHERE id=?').get(id);
  return p?.padre_id ? profundidad(p.padre_id, guarda + 1) : guarda;
}

// Suma de share de los hermanos activos, para el tope del 100% en 'particiona'.
function sumaHermanos(padreId, excluirId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(share_pct),0) AS s FROM pli_productos
    WHERE IFNULL(padre_id,0)=? AND eliminado_en IS NULL AND activo=1 AND id<>?
  `).get(padreId || 0, excluirId || 0);
  return Number(r?.s || 0);
}

router.post('/productos', wrap((req, res) => {
  const soc = getSociedadId(req);
  const b = req.body || {};
  const temp = b.temporada_id ? parseInt(b.temporada_id, 10) : temporadaActiva(soc)?.id;
  if (!temp) throw bad('No hay temporada. Creá una antes de cargar productos.');
  const t = db.prepare('SELECT id FROM pli_temporadas WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(temp, soc);
  if (!t) throw bad('La temporada no existe o es de otra sociedad');

  const nombre = vTexto(b.nombre, 'El nombre', { req: true });
  const padreId = b.padre_id ? parseInt(b.padre_id, 10) : null;

  let padre = null;
  if (padreId) {
    padre = db.prepare('SELECT * FROM pli_productos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(padreId, soc);
    if (!padre) throw bad('El producto padre no existe');
    if (padre.temporada_id !== temp) throw bad('El padre pertenece a otra temporada');
    if (profundidad(padreId) + 1 >= 10) throw bad('Demasiados niveles de subproducto (máximo 10)');
  }

  // modo_reparto es obligatorio aunque la columna tenga default: es el único
  // campo que produce números mal sin lanzar ningún error.
  const modo = vTexto(b.modo_reparto, 'El modo de reparto', { req: true });
  if (!['particiona', 'adicional'].includes(modo))
    throw bad('El modo de reparto tiene que ser "particiona" o "adicional"');

  const share = padreId ? vNum(b.share_pct, 'El porcentaje', { min: 1e-9, max: 100 }) : 100;

  // Un hijo HEREDA la unidad del padre. Si divergieran, el split
  // q_hijo = q_padre × pct/100 transferiría la cantidad sin conversión
  // (40.000 kg -> 32.000 cajas) y la pantalla se vería perfectamente correcta.
  const unidad = padre ? padre.unidad : (vTexto(b.unidad, 'La unidad') || 'caja');

  if (padre && padre.modo_reparto === 'particiona') {
    const suma = sumaHermanos(padreId, null) + share;
    if (suma > 100 + 1e-6)
      throw bad(`Los subproductos de "${padre.nombre}" suman ${suma.toFixed(2)}% y no pueden pasar de 100%`);
  }

  const orden = vNum(b.orden, 'El orden', { def: 0, min: 0 });
  const r = db.prepare(`
    INSERT INTO pli_productos
      (sociedad_id, temporada_id, padre_id, nombre, unidad, share_pct, modo_reparto, orden, notas,
       creado_por_id, actualizado_por_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(soc, temp, padreId, nombre, unidad, share, modo, orden,
         vTexto(b.notas, 'Las notas', { max: 500 }), req.user.id, req.user.id);
  logPli('producto', r.lastInsertRowid, 'alta', { nombre, padreId, share, modo }, req.user.id);
  res.json({ ok: true, id: r.lastInsertRowid });
}));

router.patch('/productos/:id', wrap((req, res) => {
  const soc = getSociedadId(req);
  const id = parseInt(req.params.id, 10);
  const a = db.prepare('SELECT * FROM pli_productos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(id, soc);
  if (!a) throw notFound('Producto no encontrado');
  const b = req.body || {};

  const nombre = b.nombre === undefined ? a.nombre : vTexto(b.nombre, 'El nombre', { req: true });
  const share = b.share_pct === undefined ? a.share_pct
    : (a.padre_id ? vNum(b.share_pct, 'El porcentaje', { min: 1e-9, max: 100 }) : 100);
  const modo = b.modo_reparto === undefined ? a.modo_reparto : String(b.modo_reparto);
  if (!['particiona', 'adicional'].includes(modo))
    throw bad('El modo de reparto tiene que ser "particiona" o "adicional"');
  const activo = b.activo === undefined ? a.activo : (b.activo ? 1 : 0);

  // Nombre repetido en el mismo nivel: sin esto choca contra idx_pli_prod_nombre
  // y sale un 500 con el mensaje de SQLite en inglés (el PATCH de insumos ya
  // devolvía 409; era una asimetría dentro del mismo archivo).
  if (String(nombre).toLowerCase() !== String(a.nombre).toLowerCase()) {
    const dup = db.prepare(`
      SELECT id FROM pli_productos
      WHERE sociedad_id=? AND temporada_id=? AND IFNULL(padre_id,0)=? AND nombre=? COLLATE NOCASE
        AND eliminado_en IS NULL AND id<>?
    `).get(soc, a.temporada_id, a.padre_id || 0, nombre, id);
    if (dup) throw conflict(`Ya existe "${nombre}" en el mismo nivel`);
  }

  // La unidad de un hijo la manda el padre; la de una raíz se puede editar.
  let unidad = a.unidad;
  if (!a.padre_id && b.unidad !== undefined) unidad = vTexto(b.unidad, 'La unidad', { req: true, max: 30 });

  // Revalidar el tope del 100% también cuando se reactiva o se cambia el share:
  // si no, un producto reactivado empuja la suma por encima de 100 sin aviso.
  if (a.padre_id && activo === 1) {
    const padre = db.prepare('SELECT * FROM pli_productos WHERE id=?').get(a.padre_id);
    if (padre && padre.modo_reparto === 'particiona') {
      const suma = sumaHermanos(a.padre_id, id) + Number(share);
      if (suma > 100 + 1e-6)
        throw conflict(`Los subproductos de "${padre.nombre}" quedarían en ${suma.toFixed(2)}% (máximo 100%)`);
    }
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE pli_productos SET nombre=?, unidad=?, share_pct=?, modo_reparto=?, activo=?,
        notas=?, actualizado_en=${AHORA}, actualizado_por_id=? WHERE id=?
    `).run(nombre, unidad, share, modo, activo,
           b.notas === undefined ? a.notas : vTexto(b.notas, 'Las notas', { max: 500 }), req.user.id, id);
    // La unidad baja a todos los descendientes para que nunca diverja.
    if (unidad !== a.unidad) {
      for (const d of descendientes(id)) {
        db.prepare('UPDATE pli_productos SET unidad=? WHERE id=?').run(unidad, d);
      }
    }
  })();
  logPli('producto', id, 'edicion', { antes: a, despues: { nombre, unidad, share, modo, activo } }, req.user.id);
  res.json({ ok: true });
}));

router.delete('/productos/:id', wrap((req, res) => {
  const soc = getSociedadId(req);
  const id = parseInt(req.params.id, 10);
  const a = db.prepare('SELECT * FROM pli_productos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(id, soc);
  if (!a) throw notFound('Producto no encontrado');
  const hijos = db.prepare('SELECT COUNT(*) AS n FROM pli_productos WHERE padre_id=? AND eliminado_en IS NULL').get(id).n;
  if (hijos) throw conflict(`"${a.nombre}" tiene ${hijos} subproducto(s). Eliminalos primero.`);
  const enConfirmados = db.prepare(`
    SELECT COUNT(*) AS n FROM pli_plan_objetivos o
    JOIN pli_planes p ON p.id = o.plan_id
    WHERE o.producto_id=? AND p.estado='confirmado' AND p.eliminado_en IS NULL
  `).get(id).n;
  if (enConfirmados) throw conflict(`"${a.nombre}" es objetivo de ${enConfirmados} plan(es) confirmado(s).`);

  // Los planes confirmados ya quedaron bloqueados arriba. En los borradores la
  // fila de pli_plan_objetivos quedaba huérfana (el soft delete no dispara FK):
  // el motor la ignoraba y el plan compraba de menos. Se purga en la misma
  // transacción y queda registrada en el log con las cantidades descartadas.
  const huerfanos = db.prepare(`
    SELECT o.plan_id, o.cantidad FROM pli_plan_objetivos o
    JOIN pli_planes p ON p.id = o.plan_id
    WHERE o.producto_id=? AND p.sociedad_id=? AND p.estado<>'confirmado' AND p.eliminado_en IS NULL
  `).all(id, soc);
  db.transaction(() => {
    db.prepare(`
      DELETE FROM pli_plan_objetivos
      WHERE producto_id=? AND plan_id IN (
        SELECT id FROM pli_planes WHERE sociedad_id=? AND estado<>'confirmado' AND eliminado_en IS NULL
      )
    `).run(id, soc);
    db.prepare(`UPDATE pli_productos SET eliminado_en=${AHORA}, eliminado_por_id=?, activo=0 WHERE id=?`).run(req.user.id, id);
  })();
  logPli('producto', id, 'baja', { nombre: a.nombre, objetivos_purgados: huerfanos }, req.user.id);
  res.json({ ok: true });
}));

// ── Recetas ───────────────────────────────────────────────────────────────

router.get('/productos/:id/receta', wrap((req, res) => {
  const soc = getSociedadId(req);
  const id = parseInt(req.params.id, 10);
  const p = db.prepare('SELECT * FROM pli_productos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(id, soc);
  if (!p) throw notFound('Producto no encontrado');
  const lineas = db.prepare(`
    SELECT rl.*, i.nombre AS insumo_nombre, i.unidad_uso AS insumo_unidad_uso,
           i.unidad_compra, i.factor_compra, i.categoria
    FROM pli_receta_lineas rl
    JOIN pli_insumos i ON i.id = rl.insumo_id
    WHERE rl.producto_id=? AND rl.version=?
    ORDER BY rl.orden, rl.id
  `).all(id, p.receta_version);
  res.json({ ok: true, data: { producto: p, receta_version: p.receta_version, lineas } });
}));

// Reemplazo total y transaccional. No borra: bumpea la versión e inserta filas
// nuevas, así el historial y la reproducibilidad quedan gratis.
// El lock optimista va por receta_version (el único lugar donde una edición
// pisada se traduce directamente en plata).
router.put('/productos/:id/receta', wrap((req, res) => {
  const soc = getSociedadId(req);
  const id = parseInt(req.params.id, 10);
  const lineas = req.body?.lineas;
  if (!Array.isArray(lineas)) throw bad('Faltan las líneas de la receta');

  const nueva = db.transaction(() => {
    const p = db.prepare('SELECT * FROM pli_productos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(id, soc);
    if (!p) throw notFound('Producto no encontrado');
    if (req.body.receta_version !== undefined && Number(req.body.receta_version) !== p.receta_version) {
      throw conflict('Otro usuario guardó esta receta mientras la editabas. Recargá y volvé a intentar.',
        { receta_version_actual: p.receta_version });
    }
    const v = p.receta_version + 1;

    const vistas = new Set();
    const ins = db.prepare(`
      INSERT INTO pli_receta_lineas
        (producto_id, version, insumo_id, cantidad, por_cada, modo_ratio, unidad,
         cant_min, cant_max, merma_pct, base, orden, motivo, notas, creado_por_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    lineas.forEach((l, idx) => {
      const insumoId = vNum(l.insumo_id, 'El insumo', { entero: true, min: 1 });
      const insumo = db.prepare(`
        SELECT * FROM pli_insumos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL
      `).get(insumoId, soc);
      if (!insumo) throw bad(`La línea ${idx + 1} apunta a un insumo que no existe o es de otra sociedad`);

      const cantidad = vNum(l.cantidad, `La cantidad de "${insumo.nombre}"`, { min: 0 });
      const porCada = vNum(l.por_cada, `El "cada" de "${insumo.nombre}"`, { min: 1e-9, def: 1 });
      const merma = vNum(l.merma_pct, `La merma de "${insumo.nombre}"`, { min: 0, max: 99.999, def: 0 });
      const modoRatio = ['por_unidad', 'cada_n'].includes(l.modo_ratio) ? l.modo_ratio : 'por_unidad';
      const base = l.base || 'producto';
      if (base !== 'producto') throw bad('Por ahora solo se puede calcular por unidad de producto');

      // La unidad de la línea es un snapshot de la del insumo. No se convierte
      // implícitamente nunca: si difieren, se rechaza y decide el usuario.
      const unidad = vTexto(l.unidad, 'La unidad') || insumo.unidad_uso;
      if (String(unidad) !== String(insumo.unidad_uso))
        throw bad(`La unidad "${unidad}" no coincide con la de "${insumo.nombre}" ("${insumo.unidad_uso}")`);

      let cantMin = (l.cant_min === undefined || l.cant_min === null || l.cant_min === '')
        ? null : vNum(l.cant_min, `El mínimo de "${insumo.nombre}"`, { min: 0 });
      let cantMax = (l.cant_max === undefined || l.cant_max === null || l.cant_max === '')
        ? null : vNum(l.cant_max, `El máximo de "${insumo.nombre}"`, { min: 0 });
      if (cantMin !== null && cantMax !== null && cantMin > cantMax)
        throw bad(`En "${insumo.nombre}" el mínimo (${cantMin}) es mayor que el máximo (${cantMax})`);
      if (cantMin !== null && cantMin > cantidad)
        throw bad(`En "${insumo.nombre}" el mínimo (${cantMin}) es mayor que la cantidad nominal (${cantidad})`);
      if (cantMax !== null && cantMax < cantidad)
        throw bad(`En "${insumo.nombre}" el máximo (${cantMax}) es menor que la cantidad nominal (${cantidad})`);

      const motivo = vTexto(l.motivo, 'El motivo', { max: 80 });
      const clave = `${insumoId}|${base}|${motivo || ''}`;
      if (vistas.has(clave))
        throw bad(`"${insumo.nombre}" está dos veces en la receta. Usá el campo "motivo" para diferenciarlas.`);
      vistas.add(clave);

      ins.run(id, v, insumoId, cantidad, porCada, modoRatio, unidad,
              cantMin, cantMax, merma, base, idx, motivo,
              vTexto(l.notas, 'Las notas', { max: 300 }), req.user.id);
    });

    db.prepare(`UPDATE pli_productos SET receta_version=?, actualizado_en=${AHORA}, actualizado_por_id=? WHERE id=?`)
      .run(v, req.user.id, id);
    logPli('receta', id, 'receta_guardar', { antes: p.receta_version, despues: v, lineas: lineas.length }, req.user.id);
    return v;
  })();

  res.json({ ok: true, receta_version: nueva });
}));

// ── Insumos comunes: propuesta de subirlos al producto ────────────────────
// Si TODOS los subproductos activos de un producto llevan el mismo insumo, es un
// insumo común y le corresponde al padre. Dejarlo repetido en cada hijo no cambia
// el número (la receta del padre se aplica a la cantidad completa, así que da lo
// mismo), pero sí hace que mantenerlo sea un problema: cambiar la cantidad exige
// editar N recetas y alcanza con olvidarse una para que el plan quede mal.

function recetaVigente(productoId) {
  const p = db.prepare('SELECT receta_version FROM pli_productos WHERE id=?').get(productoId);
  if (!p) return [];
  return db.prepare('SELECT * FROM pli_receta_lineas WHERE producto_id=? AND version=? ORDER BY orden, id')
    .all(productoId, p.receta_version);
}

function sugerenciasDe(padre, hijosActivos) {
  if (!hijosActivos || hijosActivos.length < 2) return [];
  const porHijo = hijosActivos.map(h => ({ hijo: h, lineas: recetaVigente(h.id) }));
  if (porHijo.some(x => !x.lineas.length)) return [];   // con un hijo sin receta no hay nada común

  const yaEnPadre = new Set(recetaVigente(padre.id).map(l => l.insumo_id));
  // Intersección de insumos entre todos los hijos
  let comunes = porHijo[0].lineas.map(l => l.insumo_id);
  for (const x of porHijo.slice(1)) {
    const s = new Set(x.lineas.map(l => l.insumo_id));
    comunes = comunes.filter(id => s.has(id));
  }
  comunes = comunes.filter(id => !yaEnPadre.has(id));

  const out = [];
  for (const insumoId of comunes) {
    const ins = db.prepare('SELECT nombre, unidad_uso FROM pli_insumos WHERE id=?').get(insumoId);
    if (!ins) continue;
    const lineas = porHijo.map(x => ({
      hijo: x.hijo.nombre,
      l: x.lineas.filter(l => l.insumo_id === insumoId)[0]
    }));
    // Si el mismo insumo aparece dos veces en una receta (distinto motivo), no se
    // propone: consolidarlo requeriría decidir cuál de las dos líneas sube.
    if (porHijo.some(x => x.lineas.filter(l => l.insumo_id === insumoId).length > 1)) continue;

    const ref = lineas[0].l;
    const iguales = lineas.every(x =>
      Number(x.l.cantidad) === Number(ref.cantidad) &&
      Number(x.l.por_cada) === Number(ref.por_cada) &&
      Number(x.l.merma_pct) === Number(ref.merma_pct));

    out.push({
      producto_id: padre.id, producto: padre.nombre,
      insumo_id: insumoId, insumo: ins.nombre, unidad_uso: ins.unidad_uso,
      en_hijos: lineas.map(x => ({
        hijo: x.hijo, cantidad: x.l.cantidad, por_cada: x.l.por_cada, merma_pct: x.l.merma_pct
      })),
      iguales,
      // Solo se puede consolidar de una si los valores coinciden. Si difieren hay
      // que decidir con qué cantidad sube, y ésa es una decisión del usuario.
      consolidable: iguales,
      sugerencia: iguales
        ? `"${ins.nombre}" está en los ${lineas.length} subproductos con la misma cantidad. Conviene cargarlo en "${padre.nombre}".`
        : `"${ins.nombre}" está en los ${lineas.length} subproductos pero con cantidades distintas. Si en realidad es el mismo consumo, unificalo y subilo a "${padre.nombre}".`
    });
  }
  return out;
}

// Reescribe la receta de un producto: bumpea la versión e inserta las líneas
// nuevas, igual que el PUT. No borra nada: el historial queda.
function reescribirReceta(productoId, lineas, userId) {
  const p = db.prepare('SELECT receta_version FROM pli_productos WHERE id=?').get(productoId);
  const v = p.receta_version + 1;
  const ins = db.prepare(`
    INSERT INTO pli_receta_lineas
      (producto_id, version, insumo_id, cantidad, por_cada, modo_ratio, unidad,
       cant_min, cant_max, merma_pct, base, orden, motivo, notas, creado_por_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  lineas.forEach((l, i) => {
    ins.run(productoId, v, l.insumo_id, l.cantidad, l.por_cada, l.modo_ratio || 'por_unidad',
            l.unidad, l.cant_min, l.cant_max, l.merma_pct, l.base || 'producto', i,
            l.motivo || null, l.notas || null, userId);
  });
  db.prepare(`UPDATE pli_productos SET receta_version=?, actualizado_en=${AHORA}, actualizado_por_id=? WHERE id=?`)
    .run(v, userId, productoId);
  return v;
}

// Sube un insumo común de los subproductos al producto padre, en una sola
// transacción: lo agrega arriba y lo saca de cada hijo.
router.post('/productos/:id/consolidar-insumo', wrap((req, res) => {
  const soc = getSociedadId(req);
  const id = parseInt(req.params.id, 10);
  const padre = db.prepare('SELECT * FROM pli_productos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(id, soc);
  if (!padre) throw notFound('Producto no encontrado');
  const insumoId = vNum(req.body?.insumo_id, 'El insumo', { entero: true, min: 1 });

  const hijos = db.prepare(`
    SELECT * FROM pli_productos WHERE padre_id=? AND activo=1 AND eliminado_en IS NULL ORDER BY orden, id
  `).all(id);
  if (hijos.length < 2) throw bad('El producto no tiene al menos dos subproductos activos');

  const sug = sugerenciasDe(padre, hijos).filter(s => s.insumo_id === insumoId)[0];
  if (!sug) throw bad('Ese insumo no está en todos los subproductos, o ya está en el producto');
  if (!sug.consolidable) {
    throw conflict('Las cantidades difieren entre los subproductos. Unificalas primero y volvé a intentar.',
      { en_hijos: sug.en_hijos });
  }

  const resumen = db.transaction(() => {
    // La línea que sube: se toma del primer hijo, que ya se validó que son iguales.
    const modelo = recetaVigente(hijos[0].id).filter(l => l.insumo_id === insumoId)[0];
    const nuevasPadre = recetaVigente(padre.id).concat([modelo]);
    const vPadre = reescribirReceta(padre.id, nuevasPadre, req.user.id);
    const vHijos = hijos.map(h => ({
      id: h.id, nombre: h.nombre,
      version: reescribirReceta(h.id, recetaVigente(h.id).filter(l => l.insumo_id !== insumoId), req.user.id)
    }));
    logPli('receta', padre.id, 'consolidar_insumo',
      { insumo_id: insumoId, insumo: sug.insumo, padre: padre.nombre, version_padre: vPadre, hijos: vHijos },
      req.user.id);
    return { version_padre: vPadre, hijos: vHijos };
  })();

  res.json({ ok: true, ...resumen, mensaje: `"${sug.insumo}" quedó en "${padre.nombre}" y se quitó de los subproductos.` });
}));

// ── Costo del producto según su receta ────────────────────────────────────
// Corre el motor en modo COSTEO (sin loteo) sobre 1 unidad del producto. Da el
// costo unitario exacto, separado por moneda, y convertido a las dos monedas con
// la cotización del día, que se devuelve explícita.
//
// GET a propósito: es lectura, tiene que funcionar para usuarios solo lectura.
router.get('/productos/:id/costo', async (req, res) => {
  try {
    const soc = getSociedadId(req);
    const id = parseInt(req.params.id, 10);
    const prod = db.prepare('SELECT * FROM pli_productos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(id, soc);
    if (!prod) return res.status(404).json({ ok: false, error: 'Producto no encontrado' });

    const productos = productosDeTemporada(soc, prod.temporada_id);
    const recetas = new Map();
    const filas = db.prepare(`
      SELECT rl.* FROM pli_receta_lineas rl
      JOIN pli_productos p ON p.id = rl.producto_id AND rl.version = p.receta_version
      WHERE p.sociedad_id=? AND p.temporada_id=? AND p.eliminado_en IS NULL
      ORDER BY rl.orden, rl.id
    `).all(soc, prod.temporada_id);
    for (const f of filas) {
      if (!recetas.has(f.producto_id)) recetas.set(f.producto_id, []);
      recetas.get(f.producto_id).push(f);
    }
    const insumos = new Map(
      db.prepare('SELECT * FROM pli_insumos WHERE sociedad_id=?').all(soc).map(i => [i.id, i])
    );

    const r = calcularPlan({
      plan: { id: 0 },
      objetivos: [{ producto_id: id, cantidad: 1, unidad: prod.unidad, bucket_ini: '' }],
      productos, recetas, insumos,
      existencias: new Map(), comprado: new Map(),
      modo: 'costeo'
    });

    const tipo = TIPOS_DOLAR.includes(req.query.tc_tipo) ? req.query.tc_tipo : 'oficial';
    const cotiz = await cotizacionVigente(tipo);

    const totARS = Number(r.totales_por_moneda.ARS || 0);
    const totUSD = Number(r.totales_por_moneda.USD || 0);
    const tc = cotiz && cotiz.venta > 0 ? cotiz.venta : null;

    // Sin cotización no se inventa nada: se devuelven los dos totales en null y la
    // UI muestra los parciales por moneda con el aviso.
    const total_en_ars = tc !== null ? totARS + totUSD * tc : null;
    const total_en_usd = tc !== null ? totUSD + totARS / tc : null;

    const lineas = r.lineas.map(l => ({
      insumo_id: l.insumo_id,
      insumo_nombre: l.insumo_nombre,
      categoria: l.categoria,
      unidad_uso: l.unidad_uso,
      cantidad_por_unidad: l.cant_bruta_uso,        // incluye merma
      unidad_compra: l.unidad_compra,
      factor_compra: l.factor_compra,
      precio_unit_compra: l.precio_unit_snapshot,   // por unidad de COMPRA
      moneda: l.moneda_snapshot,
      costo_unitario: l.costo_estimado,             // por 1 unidad de producto
      costo_en_ars: tc !== null ? (l.moneda_snapshot === 'USD' ? l.costo_estimado * tc : l.costo_estimado) : null,
      costo_en_usd: tc !== null ? (l.moneda_snapshot === 'USD' ? l.costo_estimado : l.costo_estimado / tc) : null,
      sin_precio: l.sin_precio,
      desglose: l.desglose
    }));
    // Del que más pesa al que menos, que es el orden en que se mira un costo.
    lineas.sort((a, b) => (b.costo_en_ars || 0) - (a.costo_en_ars || 0));

    res.json({
      ok: true,
      data: {
        producto: { id: prod.id, nombre: prod.nombre, unidad: prod.unidad, padre_id: prod.padre_id },
        lineas,
        totales_por_moneda: r.totales_por_moneda,
        total_en_ars, total_en_usd,
        cotizacion: cotiz,
        insumos_sin_precio: r.cobertura.insumos_sin_precio,
        cobertura: r.cobertura,
        advertencias: r.advertencias,
        nota: 'Costo por 1 ' + prod.unidad + ' — incluye merma, sin redondeo por bulto de compra.'
      }
    });
  } catch (e) {
    console.error('[PLI] Error calculando costo:', e.message);
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// PLANES
// ══════════════════════════════════════════════════════════════════════════

router.get('/planes', wrap((req, res) => {
  const soc = getSociedadId(req);
  const temp = req.query.temporada_id ? parseInt(req.query.temporada_id, 10) : temporadaActiva(soc)?.id;
  const params = [soc];
  let sql = `
    SELECT p.*, t.nombre AS temporada_nombre,
           (SELECT COUNT(*) FROM pli_plan_objetivos o WHERE o.plan_id = p.id) AS n_objetivos,
           (SELECT COUNT(*) FROM pli_plan_resultado r WHERE r.plan_id = p.id) AS n_resultado
    FROM pli_planes p
    LEFT JOIN pli_temporadas t ON t.id = p.temporada_id
    WHERE p.sociedad_id=? AND p.eliminado_en IS NULL`;
  if (temp) { sql += ' AND p.temporada_id=?'; params.push(temp); }
  if (req.query.estado) { sql += ' AND p.estado=?'; params.push(req.query.estado); }
  sql += ' ORDER BY p.id DESC';
  res.json({ ok: true, data: db.prepare(sql).all(...params), temporada_id: temp || null });
}));

function getPlan(soc, id) {
  const p = db.prepare('SELECT * FROM pli_planes WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(id, soc);
  if (!p) throw notFound('Plan no encontrado');
  return p;
}

router.get('/planes/:id', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  const objetivos = db.prepare(`
    SELECT o.*, p.nombre AS producto_nombre
    FROM pli_plan_objetivos o
    JOIN pli_productos p ON p.id = o.producto_id
    WHERE o.plan_id=? ORDER BY p.orden, p.id
  `).all(plan.id);
  const existencias = db.prepare('SELECT * FROM pli_plan_existencias WHERE plan_id=?').all(plan.id);
  res.json({ ok: true, data: { plan, objetivos, existencias } });
}));

router.post('/planes', wrap((req, res) => {
  const soc = getSociedadId(req);
  const b = req.body || {};
  const temp = b.temporada_id ? parseInt(b.temporada_id, 10) : temporadaActiva(soc)?.id;
  if (!temp) throw bad('No hay temporada. Creá una antes de armar un plan.');
  const t = db.prepare('SELECT id FROM pli_temporadas WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(temp, soc);
  if (!t) throw bad('La temporada no existe o es de otra sociedad');
  const nombre = vTexto(b.nombre, 'El nombre', { req: true });
  const r = db.prepare(`
    INSERT INTO pli_planes (sociedad_id, temporada_id, nombre, fecha_desde, fecha_hasta, notas, creado_por_id, actualizado_por_id)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(soc, temp, nombre, vFecha(b.fecha_desde, 'Fecha desde'), vFecha(b.fecha_hasta, 'Fecha hasta'),
         vTexto(b.notas, 'Las notas', { max: 500 }), req.user.id, req.user.id);
  logPli('plan', r.lastInsertRowid, 'alta', { nombre }, req.user.id);
  res.json({ ok: true, id: r.lastInsertRowid });
}));

router.patch('/planes/:id', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  if (plan.estado === 'confirmado') throw conflict('El plan está confirmado. Reabrilo para editarlo.');
  const b = req.body || {};
  db.prepare(`
    UPDATE pli_planes SET nombre=?, fecha_desde=?, fecha_hasta=?, notas=?,
      actualizado_en=${AHORA}, actualizado_por_id=? WHERE id=?
  `).run(b.nombre === undefined ? plan.nombre : vTexto(b.nombre, 'El nombre', { req: true }),
         b.fecha_desde === undefined ? plan.fecha_desde : vFecha(b.fecha_desde, 'Fecha desde'),
         b.fecha_hasta === undefined ? plan.fecha_hasta : vFecha(b.fecha_hasta, 'Fecha hasta'),
         b.notas === undefined ? plan.notas : vTexto(b.notas, 'Las notas', { max: 500 }),
         req.user.id, plan.id);
  res.json({ ok: true });
}));

router.delete('/planes/:id', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  db.prepare(`UPDATE pli_planes SET eliminado_en=${AHORA}, eliminado_por_id=?, activo=0 WHERE id=?`).run(req.user.id, plan.id);
  logPli('plan', plan.id, 'baja', { nombre: plan.nombre }, req.user.id);
  res.json({ ok: true });
}));

router.post('/planes/:id/duplicar', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  const nombre = vTexto(req.body?.nombre, 'El nombre', { req: true });
  const nuevoId = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO pli_planes (sociedad_id, temporada_id, nombre, fecha_desde, fecha_hasta,
        escenario_de_id, notas, creado_por_id, actualizado_por_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(soc, plan.temporada_id, nombre, plan.fecha_desde, plan.fecha_hasta, plan.id, plan.notas,
           req.user.id, req.user.id);
    const id = r.lastInsertRowid;
    db.prepare(`
      INSERT INTO pli_plan_objetivos (plan_id, producto_id, cantidad, unidad, bucket_ini, notas)
      SELECT ?, producto_id, cantidad, unidad, bucket_ini, notas FROM pli_plan_objetivos WHERE plan_id=?
    `).run(id, plan.id);
    db.prepare(`
      INSERT INTO pli_plan_existencias (plan_id, insumo_id, cantidad, bucket_ini, origen, notas, actualizado_por_id)
      SELECT ?, insumo_id, cantidad, bucket_ini, origen, notas, ? FROM pli_plan_existencias WHERE plan_id=?
    `).run(id, req.user.id, plan.id);
    return id;
  })();
  logPli('plan', nuevoId, 'duplicar', { de: plan.id, nombre }, req.user.id);
  res.json({ ok: true, id: nuevoId });
}));

// ── Objetivos ─────────────────────────────────────────────────────────────

router.put('/planes/:id/objetivos', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  if (plan.estado === 'confirmado') throw conflict('El plan está confirmado. Reabrilo para editarlo.');
  const objetivos = req.body?.objetivos;
  if (!Array.isArray(objetivos)) throw bad('Faltan los objetivos');

  db.transaction(() => {
    db.prepare('DELETE FROM pli_plan_objetivos WHERE plan_id=?').run(plan.id);
    const ins = db.prepare(`
      INSERT INTO pli_plan_objetivos (plan_id, producto_id, cantidad, unidad, bucket_ini, notas)
      VALUES (?,?,?,?,?,?)
    `);
    // Con semanas, el MISMO producto aparece en varias filas a propósito (una por
    // semana de cosecha). Así que lo que no puede repetirse es el par
    // producto+semana, y el solapamiento padre/hijo se valida DENTRO de cada
    // semana: melón en la semana 1 e IFCO en la semana 2 no se solapan.
    const vistas = new Set();
    const porSemana = new Map();   // semana -> [{id, nombre}]
    let guardados = 0;

    for (const o of objetivos) {
      const pid = vNum(o.producto_id, 'El producto', { entero: true, min: 1 });
      const prod = db.prepare(`
        SELECT * FROM pli_productos WHERE id=? AND sociedad_id=? AND temporada_id=? AND eliminado_en IS NULL
      `).get(pid, soc, plan.temporada_id);
      if (!prod) throw bad('Hay un objetivo que apunta a un producto de otra temporada o inexistente');

      // bucket_ini es la semana de cosecha, identificada por su lunes. Cualquier
      // fecha que manden se normaliza al lunes de su semana, así dos fechas de la
      // misma semana caen en el mismo balde en vez de crear dos filas.
      const semana = o.bucket_ini ? (lunesDe(o.bucket_ini) || '') : '';
      if (o.bucket_ini && !semana)
        throw bad(`La fecha de semana "${o.bucket_ini}" no es válida (AAAA-MM-DD)`);

      const clave = pid + '|' + semana;
      if (vistas.has(clave)) {
        // Chocaría contra idx_pli_obj_unico y saldría un 500 con el texto crudo
        // de SQLite, perdiendo el guardado entero.
        throw bad(`"${prod.nombre}" está repetido${semana ? ' en la semana del ' + semana : ''}`);
      }
      vistas.add(clave);

      if (!porSemana.has(semana)) porSemana.set(semana, []);
      const hermanos = porSemana.get(semana);
      // Padre e hijo a la vez se contarían dos veces, sin ningún error visible.
      for (const otro of hermanos) {
        if (descendientes(otro.id).includes(pid))
          throw bad(`"${prod.nombre}" ya está incluido dentro del objetivo de "${otro.nombre}"`);
        if (descendientes(pid).includes(otro.id))
          throw bad(`"${otro.nombre}" ya está incluido dentro del objetivo de "${prod.nombre}"`);
      }
      hermanos.push({ id: pid, nombre: prod.nombre });

      // Las semanas en 0 no se guardan: con una grilla de semanas × productos la
      // mayoría de las celdas quedan vacías y no tiene sentido persistirlas (y
      // además dispararían el bloqueante de "objetivo en cero").
      const cant = vNum(o.cantidad, 'La cantidad', { min: 0, def: 0 });
      if (cant <= 0) continue;
      ins.run(plan.id, pid, cant, prod.unidad, semana, vTexto(o.notas, 'Las notas', { max: 300 }));
      guardados++;
    }
    if (!guardados && objetivos.length) {
      // No es un error: puede querer vaciar el plan. Solo se registra.
      logPli('plan', plan.id, 'objetivos_vacios', null, req.user.id);
    }
  })();
  logPli('plan', plan.id, 'objetivos', { filas: objetivos.length }, req.user.id);
  res.json({ ok: true });
}));

// ── Existencias ───────────────────────────────────────────────────────────
// Reemplazo total: SOLO para carga masiva. La edición inline de la tabla usa
// el endpoint por insumo de abajo; si usara este, tocar una fila borraría las
// existencias de todas las demás y la respuesta sería {ok:true}.
router.put('/planes/:id/existencias', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  if (plan.estado === 'confirmado') throw conflict('El plan está confirmado. Reabrilo para editarlo.');
  const existencias = req.body?.existencias;
  if (!Array.isArray(existencias)) throw bad('Faltan las existencias');
  db.transaction(() => {
    db.prepare('DELETE FROM pli_plan_existencias WHERE plan_id=?').run(plan.id);
    const ins = db.prepare(`
      INSERT INTO pli_plan_existencias (plan_id, insumo_id, cantidad, bucket_ini, actualizado_por_id)
      VALUES (?,?,?,'',?)
    `);
    for (const e of existencias) {
      const iid = vNum(e.insumo_id, 'El insumo', { entero: true, min: 1 });
      const ok = db.prepare('SELECT id FROM pli_insumos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(iid, soc);
      if (!ok) throw bad('Hay una existencia que apunta a un insumo inexistente o de otra sociedad');
      ins.run(plan.id, iid, vNum(e.cantidad, 'La cantidad', { min: 0, def: 0 }), req.user.id);
    }
  })();
  res.json({ ok: true });
}));

// Upsert de UNA fila: es el que usa la edición inline de la tabla de resultado.
router.put('/planes/:id/existencias/:insumoId', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  if (plan.estado === 'confirmado') throw conflict('El plan está confirmado. Reabrilo para editarlo.');
  const iid = parseInt(req.params.insumoId, 10);
  const ok = db.prepare('SELECT id FROM pli_insumos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(iid, soc);
  if (!ok) throw bad('El insumo no existe o es de otra sociedad');
  const cantidad = vNum(req.body?.cantidad, 'La cantidad', { min: 0, def: 0 });
  db.prepare(`
    INSERT INTO pli_plan_existencias (plan_id, insumo_id, cantidad, bucket_ini, actualizado_por_id)
    VALUES (?,?,?,'',?)
    ON CONFLICT(plan_id, insumo_id, bucket_ini)
    DO UPDATE SET cantidad=excluded.cantidad, actualizado_en=${AHORA}, actualizado_por_id=excluded.actualizado_por_id
  `).run(plan.id, iid, cantidad, req.user.id);
  res.json({ ok: true });
}));

// ── Compras (seguimiento de lo pedido contra lo que el plan requiere) ─────
// La cantidad va en UNIDAD DE COMPRA, la misma en la que el plan dice "a comprar".

router.get('/planes/:id/compras', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  const data = db.prepare(`
    SELECT c.*, i.nombre AS insumo_nombre, i.unidad_compra
    FROM pli_compras c
    JOIN pli_insumos i ON i.id = c.insumo_id
    WHERE c.plan_id=? AND c.eliminado_en IS NULL
    ORDER BY c.fecha DESC, c.id DESC
  `).all(plan.id);
  res.json({ ok: true, data });
}));

router.post('/planes/:id/compras', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  const b = req.body || {};
  const insumoId = vNum(b.insumo_id, 'El insumo', { entero: true, min: 1 });
  const ins = db.prepare('SELECT * FROM pli_insumos WHERE id=? AND sociedad_id=? AND eliminado_en IS NULL').get(insumoId, soc);
  if (!ins) throw bad('El insumo no existe o es de otra sociedad');
  const fecha = vFecha(b.fecha, 'La fecha');
  if (!fecha) throw bad('La fecha es obligatoria');
  const cantidad = vNum(b.cantidad, 'La cantidad', { min: 1e-9 });
  const estado = ['pedido', 'recibido', 'cancelado'].includes(b.estado) ? b.estado : 'pedido';
  const r = db.prepare(`
    INSERT INTO pli_compras (plan_id, insumo_id, fecha, cantidad, proveedor_texto, nro_orden, estado, notas, creado_por_id, actualizado_por_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(plan.id, insumoId, fecha, cantidad,
         vTexto(b.proveedor_texto, 'El proveedor', { max: 120 }) || ins.proveedor_texto || null,
         vTexto(b.nro_orden, 'El número de orden', { max: 60 }), estado,
         vTexto(b.notas, 'Las notas', { max: 300 }), req.user.id, req.user.id);
  logPli('compra', r.lastInsertRowid, 'alta',
    { plan_id: plan.id, insumo: ins.nombre, cantidad, unidad: ins.unidad_compra, fecha }, req.user.id);
  res.json({ ok: true, id: r.lastInsertRowid });
}));

router.patch('/planes/:id/compras/:compraId', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  const cid = parseInt(req.params.compraId, 10);
  const a = db.prepare('SELECT * FROM pli_compras WHERE id=? AND plan_id=? AND eliminado_en IS NULL').get(cid, plan.id);
  if (!a) throw notFound('Compra no encontrada');
  const b = req.body || {};
  const estado = b.estado === undefined ? a.estado : String(b.estado);
  if (!['pedido', 'recibido', 'cancelado'].includes(estado)) throw bad('Estado inválido');
  db.prepare(`
    UPDATE pli_compras SET fecha=?, cantidad=?, proveedor_texto=?, nro_orden=?, estado=?, notas=?,
      actualizado_en=${AHORA}, actualizado_por_id=? WHERE id=?
  `).run(b.fecha === undefined ? a.fecha : vFecha(b.fecha, 'La fecha'),
         b.cantidad === undefined ? a.cantidad : vNum(b.cantidad, 'La cantidad', { min: 1e-9 }),
         b.proveedor_texto === undefined ? a.proveedor_texto : vTexto(b.proveedor_texto, 'El proveedor', { max: 120 }),
         b.nro_orden === undefined ? a.nro_orden : vTexto(b.nro_orden, 'El número de orden', { max: 60 }),
         estado,
         b.notas === undefined ? a.notas : vTexto(b.notas, 'Las notas', { max: 300 }),
         req.user.id, cid);
  logPli('compra', cid, 'edicion', { antes: a, despues: b }, req.user.id);
  res.json({ ok: true });
}));

router.delete('/planes/:id/compras/:compraId', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  const cid = parseInt(req.params.compraId, 10);
  const a = db.prepare('SELECT * FROM pli_compras WHERE id=? AND plan_id=? AND eliminado_en IS NULL').get(cid, plan.id);
  if (!a) throw notFound('Compra no encontrada');
  db.prepare(`UPDATE pli_compras SET eliminado_en=${AHORA}, eliminado_por_id=? WHERE id=?`).run(req.user.id, cid);
  logPli('compra', cid, 'baja', { insumo_id: a.insumo_id, cantidad: a.cantidad }, req.user.id);
  res.json({ ok: true });
}));

// ── El cálculo ────────────────────────────────────────────────────────────

// Arma el ctx del motor leyendo todo de una sola vez (nada de queries adentro
// del bucle de explosión).
function armarContexto(soc, plan) {
  const productos = productosDeTemporada(soc, plan.temporada_id);
  const objetivos = db.prepare('SELECT * FROM pli_plan_objetivos WHERE plan_id=?').all(plan.id);

  const recetas = new Map();
  if (productos.length) {
    const filas = db.prepare(`
      SELECT rl.* FROM pli_receta_lineas rl
      JOIN pli_productos p ON p.id = rl.producto_id AND rl.version = p.receta_version
      WHERE p.sociedad_id=? AND p.temporada_id=? AND p.eliminado_en IS NULL
      ORDER BY rl.orden, rl.id
    `).all(soc, plan.temporada_id);
    for (const f of filas) {
      if (!recetas.has(f.producto_id)) recetas.set(f.producto_id, []);
      recetas.get(f.producto_id).push(f);
    }
  }

  const insumos = new Map(
    db.prepare('SELECT * FROM pli_insumos WHERE sociedad_id=?').all(soc).map(i => [i.id, i])
  );
  const existencias = new Map(
    db.prepare('SELECT insumo_id, cantidad FROM pli_plan_existencias WHERE plan_id=?').all(plan.id)
      .map(e => [e.insumo_id, e.cantidad])
  );
  // Lo ya pedido cubre necesidad igual que la existencia. Las canceladas no
  // cuentan; las pedidas y las recibidas sí (lo pedido ya está comprometido).
  const comprado = new Map(
    db.prepare(`
      SELECT insumo_id, SUM(cantidad) AS total FROM pli_compras
      WHERE plan_id=? AND eliminado_en IS NULL AND estado <> 'cancelado'
      GROUP BY insumo_id
    `).all(plan.id).map(c => [c.insumo_id, c.total])
  );
  return { plan, productos, objetivos, recetas, insumos, existencias, comprado };
}

// Lee el resultado materializado de un plan confirmado (no corre el motor).
function resultadoMaterializado(plan) {
  const filas = db.prepare('SELECT * FROM pli_plan_resultado WHERE plan_id=? ORDER BY costo_estimado DESC').all(plan.id);
  const lineas = filas.map(f => ({
    ...f,
    desglose: f.detalle_json ? JSON.parse(f.detalle_json) : []
  }));
  const totales_por_moneda = {};
  for (const l of lineas) {
    if (l.sin_precio) continue;
    const m = l.moneda_snapshot || 'ARS';
    totales_por_moneda[m] = Math.round(((totales_por_moneda[m] || 0) + l.costo_estimado) * 100) / 100;
  }
  return {
    lineas,
    cobertura: plan.cobertura_json ? JSON.parse(plan.cobertura_json) : { ok: true },
    totales_por_moneda,
    advertencias: []
  };
}

// GET a propósito (ver la nota del encabezado): tiene que funcionar para
// usuarios solo_lectura.
//
// Un plan CONFIRMADO no vuelve a correr el motor: devuelve lo materializado.
// Si recalculara, abrir un plan ya mandado a comprar mostraría números
// distintos de los que se compraron, con el badge verde al lado.
router.get('/planes/:id/calculo', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));

  if (plan.estado === 'confirmado' && req.query.simular !== '1') {
    const r = resultadoMaterializado(plan);
    return res.json({
      ok: true,
      data: { plan, ...r, origen: 'snapshot', confirmado_en: plan.confirmado_en }
    });
  }
  const r = calcularPlan(armarContexto(soc, plan));
  res.json({
    ok: true,
    data: { plan, ...r, origen: plan.estado === 'confirmado' ? 'simulacion' : 'calculo' }
  });
}));

router.post('/planes/:id/confirmar', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  if (plan.estado === 'confirmado') throw bad('El plan ya está confirmado');

  const ctx = armarContexto(soc, plan);
  const r = calcularPlan(ctx);
  if (!r.cobertura.ok && !req.body?.forzar) {
    throw bad('El plan tiene problemas de cobertura. Revisalos o confirmá marcando la casilla.');
  }
  if (!r.lineas.length) throw bad('El plan no arroja ningún insumo a comprar');

  db.transaction(() => {
    db.prepare('DELETE FROM pli_plan_resultado WHERE plan_id=?').run(plan.id);
    const ins = db.prepare(`
      INSERT INTO pli_plan_resultado
        (plan_id, insumo_id, bucket_ini, insumo_nombre, categoria, proveedor_texto,
         unidad_uso, unidad_compra, factor_compra, multiplo_compra, moq,
         cant_bruta_uso, cant_min_uso, cant_max_uso, existencia, existencia_declarada,
         cant_neta_uso, bultos_teoricos, bultos_a_comprar,
         exceso_multiplo, exceso_moq, exceso_uso, moq_forzado,
         precio_unit_snapshot, moneda_snapshot, precio_fecha_snapshot, costo_estimado, sin_precio, detalle_json)
      VALUES (?,?,'',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const l of r.lineas) {
      ins.run(plan.id, l.insumo_id, l.insumo_nombre, l.categoria, l.proveedor_texto,
              l.unidad_uso, l.unidad_compra, l.factor_compra, l.multiplo_compra, l.moq,
              l.cant_bruta_uso, l.cant_min_uso, l.cant_max_uso, l.existencia, l.existencia_declarada,
              l.cant_neta_uso, l.bultos_teoricos, l.bultos_a_comprar,
              l.exceso_multiplo, l.exceso_moq, l.exceso_uso, l.moq_forzado,
              l.precio_unit_snapshot, l.moneda_snapshot, l.precio_fecha_snapshot,
              l.costo_estimado, l.sin_precio, JSON.stringify(l.desglose || []));
    }
    // El snapshot es la única defensa contra "el plan que mandé a comprar
    // cambió solo porque alguien editó una receta".
    const snapshot = {
      productos: ctx.productos,
      recetas: Array.from(ctx.recetas.entries()),
      insumos: Array.from(ctx.insumos.values()),
      objetivos: ctx.objetivos
    };
    db.prepare(`
      UPDATE pli_planes SET estado='confirmado', confirmado_en=${AHORA}, confirmado_por_id=?,
        calculado_en=${AHORA}, receta_snapshot_json=?, cobertura_json=?,
        actualizado_en=${AHORA}, actualizado_por_id=? WHERE id=?
    `).run(req.user.id, JSON.stringify(snapshot), JSON.stringify(r.cobertura), req.user.id, plan.id);
  })();

  logPli('plan', plan.id, 'confirmar',
    { lineas: r.lineas.length, totales: r.totales_por_moneda, forzado: !!req.body?.forzar, cobertura_ok: r.cobertura.ok },
    req.user.id);
  res.json({ ok: true, lineas: r.lineas.length, totales_por_moneda: r.totales_por_moneda });
}));

// Reabrir NO es admin-only: el flujo real es mandar el borrador a compras,
// recibir correcciones y ajustar. Si hiciera falta un admin para volver atrás,
// el usuario terminaría creando "Plan v2 FINAL" o copiando a Excel. Queda
// logueado con los totales anteriores, que es la mitigación real.
router.post('/planes/:id/reabrir', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  if (plan.estado !== 'confirmado') throw bad('El plan no está confirmado');
  const previos = db.prepare(`
    SELECT insumo_nombre, bultos_a_comprar, unidad_compra, costo_estimado, moneda_snapshot
    FROM pli_plan_resultado WHERE plan_id=?
  `).all(plan.id);
  db.transaction(() => {
    db.prepare('DELETE FROM pli_plan_resultado WHERE plan_id=?').run(plan.id);
    db.prepare(`
      UPDATE pli_planes SET estado='borrador', confirmado_en=NULL, confirmado_por_id=NULL,
        receta_snapshot_json=NULL, cobertura_json=NULL, actualizado_en=${AHORA}, actualizado_por_id=? WHERE id=?
    `).run(req.user.id, plan.id);
  })();
  logPli('plan', plan.id, 'reabrir', { resultado_anterior: previos }, req.user.id);
  res.json({ ok: true });
}));

// ── Export ────────────────────────────────────────────────────────────────
// Se permite exportar el BORRADOR: el flujo real es mandarlo a compras para que
// lo revisen antes de cerrarlo. El estado se comunica en el propio archivo, en
// mayúsculas, en vez de negar la descarga.
router.get('/planes/:id/export.xlsx', wrap((req, res) => {
  const soc = getSociedadId(req);
  const plan = getPlan(soc, parseInt(req.params.id, 10));
  const r = plan.estado === 'confirmado' ? resultadoMaterializado(plan) : calcularPlan(armarContexto(soc, plan));

  const estadoTxt = plan.estado === 'confirmado'
    ? `CONFIRMADO el ${plan.confirmado_en || ''}`
    : 'BORRADOR — NO CONFIRMADO — los números pueden cambiar';

  // Mismo orden que la tabla del panel: el archivo se usa para salir a comprar,
  // así que tiene que poder agruparse por proveedor igual que la pantalla.
  const orden = ['insumo', 'costo', 'proveedor', 'categoria'].includes(req.query.orden)
    ? req.query.orden : 'insumo';
  const cmpNombre = (a, b) => String(a.insumo_nombre).localeCompare(String(b.insumo_nombre), 'es');
  const claveGrupo = (l) => orden === 'categoria'
    ? (l.categoria || 'Sin categoria')
    : (l.proveedor_texto || 'Sin proveedor asignado');
  if (orden === 'costo') r.lineas.sort((a, b) => (b.costo_estimado - a.costo_estimado) || cmpNombre(a, b));
  else if (orden === 'insumo') r.lineas.sort(cmpNombre);
  else r.lineas.sort((a, b) => String(claveGrupo(a)).localeCompare(String(claveGrupo(b)), 'es') || cmpNombre(a, b));

  const compras = [
    { A: `PLAN: ${plan.nombre}` },
    { A: `ESTADO: ${estadoTxt}` },
    { A: `Generado por: ${req.user.nombre || req.user.id}` },
    { A: `Ordenado por: ${orden}` },
    {},
    {
      A: 'Insumo', B: 'Categoria', C: 'Proveedor', D: 'Necesidad bruta (uso)', E: 'Unidad uso',
      F: 'Existencia', G: 'Neto (uso)', H: 'Bultos teoricos', I: 'A comprar', J: 'Unidad compra',
      K: 'Exceso (uso)', L: 'Precio unit.', M: 'Moneda', N: 'Costo estimado'
    }
  ];
  for (const l of r.lineas) {
    compras.push({
      A: l.insumo_nombre, B: l.categoria || '', C: l.proveedor_texto || '',
      D: l.cant_bruta_uso, E: l.unidad_uso, F: l.existencia, G: l.cant_neta_uso,
      H: l.bultos_teoricos, I: l.bultos_a_comprar, J: l.unidad_compra,
      K: l.exceso_uso, L: l.precio_unit_snapshot, M: l.moneda_snapshot,
      N: l.sin_precio ? 'SIN PRECIO' : l.costo_estimado
    });
  }

  const desglose = [{
    A: 'Insumo', B: 'Producto (ruta)', C: 'Cantidad producto', D: 'Unidad producto',
    E: 'Cantidad', F: 'Cada', G: 'Merma %', H: 'Aporte (uso)', I: 'Formula'
  }];
  for (const l of r.lineas) {
    for (const d of (l.desglose || [])) {
      desglose.push({
        A: l.insumo_nombre, B: (d.ruta || []).join(' > '), C: d.cantidad_producto,
        D: d.unidad_producto, E: d.cantidad, F: d.por_cada, G: d.merma_pct,
        H: d.aporte_uso, I: d.formula
      });
    }
  }

  // Agenda de pedidos: una fila por (insumo × semana) que todavía haya que pedir,
  // ordenada por fecha límite. Es la hoja que se le manda a Compras.
  const agenda = [{
    A: 'Pedir hasta', B: 'Insumo', C: 'Proveedor', D: 'Cantidad', E: 'Unidad de compra',
    F: 'Semana de cosecha', G: 'Lunes de esa semana', H: 'Plazo (dias)'
  }];
  const filasAgenda = [];
  for (const l of r.lineas) {
    for (const b of (l.buckets || [])) {
      if (!(b.bultos_a_comprar > 0)) continue;
      filasAgenda.push({
        A: b.fecha_pedido_limite || 'sin fecha', B: l.insumo_nombre, C: l.proveedor_texto || '',
        D: b.bultos_a_comprar, E: l.unidad_compra,
        // AÑO-semana: la temporada va de octubre a abril, así que sin el año la
        // S03 parece anterior a la S45. Con la semana en dos dígitos el orden
        // alfabético de esta columna coincide con el cronológico.
        F: b.semana_iso ? (b.anio_iso + '-S' + String(b.semana_iso).padStart(2, '0')) : 'sin fecha',
        G: b.fecha_necesidad || '',
        H: l.lead_time_dias || 0
      });
    }
  }
  filasAgenda.sort((x, y) => String(x.A).localeCompare(String(y.A)) || String(x.B).localeCompare(String(y.B), 'es'));
  agenda.push(...filasAgenda);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(compras, { skipHeader: true }), 'Compras');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(agenda, { skipHeader: true }), 'Agenda');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(desglose, { skipHeader: true }), 'Desglose');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const slug = String(plan.nombre).replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="plan-insumos-${plan.id}-${slug}.xlsx"`
  });
  res.send(buf);
}));

export default router;
