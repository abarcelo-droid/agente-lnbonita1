// ════════════════════════════════════════════════════════════════════════════
// MÓDULO IFCO — Router de endpoints (panel General > Abasto > IFCOs)
// ════════════════════════════════════════════════════════════════════════════
import express from "express";
import multer  from "multer";
import path    from "path";
import fs      from "fs";
import { fileURLToPath } from "url";
import db from "../servicios/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "../../data/ifco");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Migración inline: agregar columna rechazo_destino si no existe ─────────
// 'san_geronimo' → cajones rechazados volvieron al piso de SG
// 'proveedor'    → cajones rechazados se quedaron con el proveedor (solo directo)
// NULL           → sin asignar (remitos viejos: impacto cero)
try {
  db.exec("ALTER TABLE ifco_remitos_super ADD COLUMN rechazo_destino TEXT");
} catch(e) { /* columna ya existe */ }

// ── Migración inline: N° de remito interno de SG (opcional, para rastreo)
try {
  db.exec("ALTER TABLE ifco_remitos_super ADD COLUMN n_remito_sg TEXT");
} catch(e) { /* columna ya existe */ }

// ── Configuración OCR vía Claude API ───────────────────────────────────────
const OCR_ENABLED = String(process.env.IFCO_OCR_ENABLED || '').toLowerCase() === 'true';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OCR_MODEL = 'claude-haiku-4-5-20251001';
let _anthropicClient = null;
async function _getAnthropic() {
  if (!OCR_ENABLED || !ANTHROPIC_API_KEY) return null;
  if (_anthropicClient) return _anthropicClient;
  try {
    const mod = await import('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod.Anthropic;
    _anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    return _anthropicClient;
  } catch(e) {
    console.error('[IFCO][OCR] No se pudo cargar @anthropic-ai/sdk:', e.message);
    return null;
  }
}

const router = express.Router();

// ── Upload para escaneos del remito sellado ───────────────────────────────
const storage = multer.diskStorage({
  destination: function(req, file, cb) { cb(null, UPLOAD_DIR); },
  filename:    function(req, file, cb) {
    const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase();
    const tag = file.fieldname || 'remito';
    cb(null, tag + '_' + (req.params.id || 'x') + '_' + Date.now() + ext);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── Auth desde cookie (sigue patrón del resto del panel) ──────────────────
function getUser(req) {
  try {
    const cookie = req.cookies && req.cookies.lnb_user;
    if (!cookie) return null;
    return JSON.parse(cookie);
  } catch(e) { return null; }
}
function requireAuth(req, res, next) {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: 'No autenticado' });
  req.user = u;
  next();
}
router.use(requireAuth);

// ════════════════════════════════════════════════════════════════════════════
// TALONARIOS
// ════════════════════════════════════════════════════════════════════════════

router.get('/talonarios', function(req, res) {
  const rows = db.prepare(`
    SELECT t.*,
      p.nombre AS proveedor_nombre,
      (SELECT COUNT(*) FROM ifco_remitos_super r WHERE r.talonario_id = t.id AND r.eliminado_en IS NULL) AS usados_count
    FROM ifco_talonarios t
    LEFT JOIN proveedores p ON p.id = t.proveedor_id
    ORDER BY t.activo DESC, t.creado_en DESC
  `).all();
  res.json(rows);
});

router.get('/talonarios/activo', function(req, res) {
  // Filtro por dueño:
  //   ?dueno=san_geronimo  → activo de SG
  //   ?proveedor_id=X      → activo asignado a ese proveedor
  //   sin params           → primer activo (compatibilidad)
  const dueno = req.query.dueno;
  const provId = req.query.proveedor_id ? parseInt(req.query.proveedor_id) : null;
  let q = "SELECT t.*, p.nombre AS proveedor_nombre FROM ifco_talonarios t LEFT JOIN proveedores p ON p.id = t.proveedor_id WHERE t.activo = 1";
  const params = [];
  if (dueno === 'san_geronimo') {
    q += " AND t.dueno_tipo = 'san_geronimo'";
  } else if (provId) {
    q += " AND t.dueno_tipo = 'proveedor' AND t.proveedor_id = ?";
    params.push(provId);
  }
  q += " ORDER BY t.creado_en DESC LIMIT 1";
  const t = db.prepare(q).get(...params);
  if (!t) return res.json({ talonario: null, proximo: null, disponibles: 0 });

  const ultimo = db.prepare(`
    SELECT n_remito_ifco FROM ifco_remitos_super
    WHERE talonario_id = ? AND eliminado_en IS NULL ORDER BY id DESC LIMIT 1
  `).get(t.id);

  let proximoNum = t.numero_desde;
  if (ultimo) {
    const m = String(ultimo.n_remito_ifco).match(/-(\d+)$/);
    if (m) proximoNum = parseInt(m[1], 10) + 1;
  }
  const agotado = proximoNum > t.numero_hasta;
  const disponibles = agotado ? 0 : (t.numero_hasta - proximoNum + 1);
  const proximoStr = agotado ? null : (t.serie + '-' + String(proximoNum).padStart(8, '0'));

  let dias_cai = null;
  if (t.vto_cai) {
    dias_cai = Math.floor((new Date(t.vto_cai) - new Date()) / (1000*60*60*24));
  }

  res.json({
    talonario: t,
    proximo: proximoStr,
    proximo_num: agotado ? null : proximoNum,
    disponibles: disponibles,
    agotado: agotado,
    dias_cai: dias_cai,
    cai_alerta: dias_cai !== null && dias_cai < 60,
    pocos_remitos: disponibles > 0 && disponibles < 100
  });
});

router.post('/talonarios', function(req, res) {
  const d = req.body || {};
  if (!d.serie || !d.numero_desde || !d.numero_hasta) {
    return res.status(400).json({ error: 'Faltan datos obligatorios (serie, rango)' });
  }
  if (parseInt(d.numero_hasta) < parseInt(d.numero_desde)) {
    return res.status(400).json({ error: 'numero_hasta debe ser mayor o igual a numero_desde' });
  }
  // Dueño
  const dueno_tipo = (d.dueno_tipo === 'proveedor') ? 'proveedor' : 'san_geronimo';
  let proveedor_id = null;
  if (dueno_tipo === 'proveedor') {
    proveedor_id = parseInt(d.proveedor_id) || null;
    if (!proveedor_id) return res.status(400).json({ error: 'Si el talonario lo administra un proveedor, hay que indicar cuál' });
    const exProv = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(proveedor_id);
    if (!exProv) return res.status(400).json({ error: 'Proveedor inexistente' });
  }
  // Activación: solo desactivar otros del MISMO dueño
  if (d.activo) {
    if (dueno_tipo === 'san_geronimo') {
      db.prepare("UPDATE ifco_talonarios SET activo = 0 WHERE dueno_tipo = 'san_geronimo'").run();
    } else {
      db.prepare("UPDATE ifco_talonarios SET activo = 0 WHERE dueno_tipo = 'proveedor' AND proveedor_id = ?").run(proveedor_id);
    }
  }
  const r = db.prepare(`
    INSERT INTO ifco_talonarios (serie, numero_desde, numero_hasta, cai, vto_cai, activo, notas, dueno_tipo, proveedor_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(d.serie, parseInt(d.numero_desde), parseInt(d.numero_hasta),
         d.cai || null, d.vto_cai || null, d.activo ? 1 : 0, d.notas || null,
         dueno_tipo, proveedor_id);
  // Log inicial: creación con su dueño
  db.prepare(`
    INSERT INTO ifco_talonarios_log
      (talonario_id, dueno_anterior_tipo, dueno_anterior_id, dueno_nuevo_tipo, dueno_nuevo_id, usuario_id, notas)
    VALUES (?, NULL, NULL, ?, ?, ?, 'Alta del talonario')
  `).run(r.lastInsertRowid, dueno_tipo, proveedor_id, req.user.id || null);
  res.json({ id: r.lastInsertRowid });
});

router.patch('/talonarios/:id', function(req, res) {
  const d = req.body || {};
  const id = req.params.id;
  const actual = db.prepare("SELECT * FROM ifco_talonarios WHERE id = ?").get(id);
  if (!actual) return res.status(404).json({ error: 'Talonario no encontrado' });

  // Activación scoped: solo desactivar otros del mismo dueño
  if (d.activo === 1 || d.activo === true) {
    if (actual.dueno_tipo === 'san_geronimo') {
      db.prepare("UPDATE ifco_talonarios SET activo = 0 WHERE dueno_tipo = 'san_geronimo' AND id != ?").run(id);
    } else {
      db.prepare("UPDATE ifco_talonarios SET activo = 0 WHERE dueno_tipo = 'proveedor' AND proveedor_id = ? AND id != ?")
        .run(actual.proveedor_id, id);
    }
  }
  const sets = [], params = { id };
  if (d.activo !== undefined) { sets.push("activo = @activo"); params.activo = d.activo ? 1 : 0; }
  if (d.cai     !== undefined) { sets.push("cai = @cai");         params.cai     = d.cai; }
  if (d.vto_cai !== undefined) { sets.push("vto_cai = @vto_cai"); params.vto_cai = d.vto_cai; }
  if (d.notas   !== undefined) { sets.push("notas = @notas");     params.notas   = d.notas; }
  if (sets.length === 0) return res.json({ ok: true });
  db.prepare(`UPDATE ifco_talonarios SET ${sets.join(", ")} WHERE id = @id`).run(params);
  res.json({ ok: true });
});

// Transferir un talonario a otro dueño (SG ↔ Proveedor o entre proveedores)
router.post('/talonarios/:id/transferir', function(req, res) {
  const id = req.params.id;
  const d = req.body || {};
  const actual = db.prepare("SELECT * FROM ifco_talonarios WHERE id = ?").get(id);
  if (!actual) return res.status(404).json({ error: 'Talonario no encontrado' });

  const nuevo_tipo = (d.dueno_tipo === 'proveedor') ? 'proveedor' : 'san_geronimo';
  let nuevo_prov_id = null;
  if (nuevo_tipo === 'proveedor') {
    nuevo_prov_id = parseInt(d.proveedor_id) || null;
    if (!nuevo_prov_id) return res.status(400).json({ error: 'Indicá el proveedor destino' });
    const exProv = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(nuevo_prov_id);
    if (!exProv) return res.status(400).json({ error: 'Proveedor destino inexistente' });
  }
  // Si el destino es igual al origen, no hacemos nada
  if (actual.dueno_tipo === nuevo_tipo && (actual.proveedor_id || null) === (nuevo_prov_id || null)) {
    return res.status(400).json({ error: 'El destino es igual al origen' });
  }

  const tx = db.transaction(() => {
    // Al transferir, lo dejamos inactivo: el receptor decide si lo activa.
    db.prepare("UPDATE ifco_talonarios SET dueno_tipo = ?, proveedor_id = ?, activo = 0 WHERE id = ?")
      .run(nuevo_tipo, nuevo_prov_id, id);
    db.prepare(`
      INSERT INTO ifco_talonarios_log
        (talonario_id, dueno_anterior_tipo, dueno_anterior_id, dueno_nuevo_tipo, dueno_nuevo_id, usuario_id, notas)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, actual.dueno_tipo, actual.proveedor_id || null,
           nuevo_tipo, nuevo_prov_id, req.user.id || null, d.notas || null);
  });
  tx();
  res.json({ ok: true });
});

// Detalle del talonario: estado de cada n° del rango
router.get('/talonarios/:id/detalle', function(req, res) {
  const id = req.params.id;
  const t = db.prepare(`
    SELECT t.*, p.nombre AS proveedor_nombre
    FROM ifco_talonarios t
    LEFT JOIN proveedores p ON p.id = t.proveedor_id
    WHERE t.id = ?
  `).get(id);
  if (!t) return res.status(404).json({ error: 'Talonario no encontrado' });

  // Todos los remitos asociados (incluye papelera, marcados)
  const remitos = db.prepare(`
    SELECT r.id, r.n_remito_ifco, r.fecha_emision, r.estado, r.cantidad_despachada,
           r.empresa, r.sucursal, r.eliminado_en
    FROM ifco_remitos_super r
    WHERE r.talonario_id = ?
  `).all(id);
  // Index por número final
  const byNum = {};
  for (const r of remitos) {
    const m = String(r.n_remito_ifco).match(/-(\d+)$/);
    if (m) byNum[parseInt(m[1], 10)] = r;
  }

  // Construir lista del rango
  const numeros = [];
  for (let n = t.numero_desde; n <= t.numero_hasta; n++) {
    const r = byNum[n];
    const numStr = t.serie + '-' + String(n).padStart(8, '0');
    if (!r) {
      numeros.push({ numero: n, n_remito_ifco: numStr, estado: 'disponible' });
    } else if (r.eliminado_en) {
      numeros.push({
        numero: n, n_remito_ifco: numStr, estado: 'anulado',
        remito_id: r.id, fecha_emision: r.fecha_emision, empresa: r.empresa, sucursal: r.sucursal,
        cantidad_despachada: r.cantidad_despachada
      });
    } else {
      numeros.push({
        numero: n, n_remito_ifco: numStr, estado: r.estado,
        remito_id: r.id, fecha_emision: r.fecha_emision, empresa: r.empresa, sucursal: r.sucursal,
        cantidad_despachada: r.cantidad_despachada
      });
    }
  }

  // Log de transferencias
  const log = db.prepare(`
    SELECT l.*, u.nombre AS usuario_nombre,
           pa.nombre AS prov_anterior_nombre,
           pn.nombre AS prov_nuevo_nombre
    FROM ifco_talonarios_log l
    LEFT JOIN usuarios u ON u.id = l.usuario_id
    LEFT JOIN proveedores pa ON pa.id = l.dueno_anterior_id
    LEFT JOIN proveedores pn ON pn.id = l.dueno_nuevo_id
    WHERE l.talonario_id = ?
    ORDER BY l.fecha DESC
  `).all(id);

  res.json({ talonario: t, numeros: numeros, log: log });
});

router.delete('/talonarios/:id', function(req, res) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const usado = db.prepare("SELECT COUNT(*) as n FROM ifco_remitos_super WHERE talonario_id = ?")
                  .get(req.params.id);
  if (usado.n > 0) return res.status(400).json({ error: 'Talonario con remitos asociados — desactivar en su lugar' });
  db.prepare("DELETE FROM ifco_talonarios WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// REMITOS A SUPERMERCADO
// ════════════════════════════════════════════════════════════════════════════

router.get('/remitos', function(req, res) {
  const f = req.query;
  const papelera = f.papelera === '1' || f.incluir_eliminados === '1';
  let q = `SELECT r.*,
                  pori.nombre AS proveedor_origen_nombre,
                  u.nombre AS eliminado_por_username
           FROM ifco_remitos_super r
           LEFT JOIN proveedores pori ON pori.id = r.proveedor_origen_id
           LEFT JOIN usuarios u ON u.id = r.eliminado_por_id
           WHERE 1=1`;
  const p = [];
  if (papelera) {
    q += " AND r.eliminado_en IS NOT NULL";
  } else {
    q += " AND r.eliminado_en IS NULL";
  }
  if (f.estado)     { q += " AND r.estado = ?";        p.push(f.estado); }
  if (f.cliente_id) { q += " AND r.cliente_id = ?";    p.push(f.cliente_id); }
  if (f.desde)      { q += " AND r.fecha_emision >= ?"; p.push(f.desde); }
  if (f.hasta)      { q += " AND r.fecha_emision <= ?"; p.push(f.hasta); }
  if (f.search)     { q += " AND (r.n_remito_ifco LIKE ? OR r.empresa LIKE ?)"; p.push('%'+f.search+'%','%'+f.search+'%'); }
  q += " ORDER BY r.fecha_emision DESC, r.id DESC LIMIT 500";
  res.json(db.prepare(q).all(...p));
});

router.get('/remitos/:id', function(req, res) {
  const r = db.prepare(`
    SELECT r.*, pori.nombre AS proveedor_origen_nombre
    FROM ifco_remitos_super r
    LEFT JOIN proveedores pori ON pori.id = r.proveedor_origen_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  res.json(r);
});

router.post('/remitos', upload.single('escaneo_original'), function(req, res) {
  const d = req.body || {};
  if (!d.n_remito_ifco)   return res.status(400).json({ error: 'N° de remito IFCO requerido' });
  if (!d.fecha_emision)   return res.status(400).json({ error: 'Fecha de emisión requerida' });
  if (!d.cantidad_despachada || parseInt(d.cantidad_despachada) <= 0) {
    return res.status(400).json({ error: 'Cantidad despachada inválida' });
  }
  if (!d.cliente_id && !d.empresa) {
    return res.status(400).json({ error: 'Cliente (Dedicado) o empresa requeridos' });
  }

  // Origen: san_geronimo (default) o proveedor_directo (con proveedor_id)
  const origen = (d.origen === 'proveedor_directo') ? 'proveedor_directo' : 'san_geronimo';
  let proveedor_origen_id = null;
  if (origen === 'proveedor_directo') {
    proveedor_origen_id = parseInt(d.proveedor_origen_id) || null;
    if (!proveedor_origen_id) return res.status(400).json({ error: 'Origen "directo desde proveedor" requiere proveedor_origen_id' });
    const exProv = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(proveedor_origen_id);
    if (!exProv) return res.status(400).json({ error: 'Proveedor de origen inexistente' });
  }

  // Unicidad: solo entre activos (no cuenta papelera)
  const dup = db.prepare("SELECT id FROM ifco_remitos_super WHERE n_remito_ifco = ? AND eliminado_en IS NULL").get(d.n_remito_ifco);
  if (dup) return res.status(409).json({ error: 'Ya existe un remito con ese número (activo). Si está en papelera, restauralo o usá otro número.' });

  // Foto: file > body path
  let escaneo_original_path = null;
  if (req.file) {
    escaneo_original_path = '/data/ifco/' + req.file.filename;
  } else if (d.escaneo_original_path && /^\/data\/ifco\//.test(d.escaneo_original_path)) {
    escaneo_original_path = d.escaneo_original_path;
  }

  try {
    const r = db.prepare(`
      INSERT INTO ifco_remitos_super (
        n_remito_ifco, n_remito_sg, fecha_emision, cliente_id, cliente_telefono, empresa, sucursal,
        modelo, cantidad_despachada, producto, transportista,
        encargado_prov_apellido, encargado_prov_nombre, encargado_prov_dni,
        talonario_id, notas, usuario_id, estado, escaneo_original_path,
        origen, proveedor_origen_id
      ) VALUES (
        @n_remito_ifco, @n_remito_sg, @fecha_emision, @cliente_id, @cliente_telefono, @empresa, @sucursal,
        @modelo, @cantidad_despachada, @producto, @transportista,
        @encargado_prov_apellido, @encargado_prov_nombre, @encargado_prov_dni,
        @talonario_id, @notas, @usuario_id, 'despachado', @escaneo_original_path,
        @origen, @proveedor_origen_id
      )
    `).run({
      n_remito_ifco:           d.n_remito_ifco,
      n_remito_sg:             d.n_remito_sg ? String(d.n_remito_sg).trim() : null,
      fecha_emision:           d.fecha_emision,
      cliente_id:              d.cliente_id || null,
      cliente_telefono:        d.cliente_telefono || null,
      empresa:                 d.empresa || null,
      sucursal:                d.sucursal || null,
      modelo:                  d.modelo || '6420',
      cantidad_despachada:     parseInt(d.cantidad_despachada),
      producto:                d.producto || null,
      transportista:           d.transportista || null,
      encargado_prov_apellido: d.encargado_prov_apellido || null,
      encargado_prov_nombre:   d.encargado_prov_nombre || null,
      encargado_prov_dni:      d.encargado_prov_dni || null,
      talonario_id:            d.talonario_id || null,
      notas:                   d.notas || null,
      usuario_id:              req.user.id || null,
      escaneo_original_path:   escaneo_original_path,
      origen:                  origen,
      proveedor_origen_id:     proveedor_origen_id
    });
    res.json({ id: r.lastInsertRowid, n_remito_ifco: d.n_remito_ifco, escaneo_original_path: escaneo_original_path, origen: origen });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// CREACIÓN DIRECTA EN ESTADO SELLADO
// Para casos donde nunca se cargó el remito al despacharlo y solo tenemos la foto del remito ya vuelto sellado.
router.post('/remitos/sellado-directo', upload.single('escaneo'), function(req, res) {
  const d = req.body || {};
  // Validaciones del despacho
  if (!d.n_remito_ifco)   return res.status(400).json({ error: 'N° de remito IFCO requerido' });
  if (!d.fecha_emision)   return res.status(400).json({ error: 'Fecha de emisión requerida' });
  if (!d.cantidad_despachada || parseInt(d.cantidad_despachada) <= 0) {
    return res.status(400).json({ error: 'Cantidad despachada inválida' });
  }
  if (!d.cliente_id && !d.empresa) {
    return res.status(400).json({ error: 'Cliente (Dedicado) o empresa requeridos' });
  }
  // Validaciones del sellado
  if (!d.fecha_sellado) return res.status(400).json({ error: 'Fecha de sellado requerida' });
  const cantDesp = parseInt(d.cantidad_despachada);
  const recibida  = d.cantidad_recibida  != null && d.cantidad_recibida  !== '' ? parseInt(d.cantidad_recibida)  : cantDesp;
  const rechazada = d.cantidad_rechazada != null && d.cantidad_rechazada !== '' ? parseInt(d.cantidad_rechazada) : 0;
  if (recibida < 0 || rechazada < 0) {
    return res.status(400).json({ error: 'Cantidades no pueden ser negativas' });
  }
  if (recibida + rechazada > cantDesp) {
    return res.status(400).json({ error: 'Recibida + rechazada superan la cantidad despachada' });
  }

  // Origen
  const origen = (d.origen === 'proveedor_directo') ? 'proveedor_directo' : 'san_geronimo';
  let proveedor_origen_id = null;
  if (origen === 'proveedor_directo') {
    proveedor_origen_id = parseInt(d.proveedor_origen_id) || null;
    if (!proveedor_origen_id) return res.status(400).json({ error: 'Origen "directo desde proveedor" requiere proveedor_origen_id' });
    const exProv = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(proveedor_origen_id);
    if (!exProv) return res.status(400).json({ error: 'Proveedor de origen inexistente' });
  }

  // Unicidad
  const dup = db.prepare("SELECT id FROM ifco_remitos_super WHERE n_remito_ifco = ? AND eliminado_en IS NULL").get(d.n_remito_ifco);
  if (dup) return res.status(409).json({ error: 'Ya existe un remito con ese número (activo). Si está en papelera, restauralo o usá otro número.' });

  // Foto del sellado: file > body path (no exigimos foto de despacho)
  let escaneo_path = null;
  if (req.file) {
    escaneo_path = '/data/ifco/' + req.file.filename;
  } else if (d.escaneo_path && /^\/data\/ifco\//.test(d.escaneo_path)) {
    escaneo_path = d.escaneo_path;
  }

  // Destino del rechazo: si hay rechazo > 0, debe especificarse
  let rechazo_destino = null;
  if (rechazada > 0) {
    rechazo_destino = d.rechazo_destino || 'san_geronimo';
    if (['san_geronimo','proveedor'].indexOf(rechazo_destino) < 0) {
      return res.status(400).json({ error: 'rechazo_destino debe ser "san_geronimo" o "proveedor"' });
    }
  }

  try {
    const r = db.prepare(`
      INSERT INTO ifco_remitos_super (
        n_remito_ifco, n_remito_sg, fecha_emision, cliente_id, cliente_telefono, empresa, sucursal,
        modelo, cantidad_despachada, cantidad_recibida, cantidad_rechazada,
        producto, transportista,
        encargado_prov_apellido, encargado_prov_nombre, encargado_prov_dni,
        encargado_super_apellido, encargado_super_nombre, encargado_super_dni,
        talonario_id, notas, usuario_id, estado,
        escaneo_path, fecha_sellado,
        origen, proveedor_origen_id, rechazo_destino
      ) VALUES (
        @n_remito_ifco, @n_remito_sg, @fecha_emision, @cliente_id, @cliente_telefono, @empresa, @sucursal,
        @modelo, @cantidad_despachada, @cantidad_recibida, @cantidad_rechazada,
        @producto, @transportista,
        @encargado_prov_apellido, @encargado_prov_nombre, @encargado_prov_dni,
        @encargado_super_apellido, @encargado_super_nombre, @encargado_super_dni,
        @talonario_id, @notas, @usuario_id, 'sellado',
        @escaneo_path, @fecha_sellado,
        @origen, @proveedor_origen_id, @rechazo_destino
      )
    `).run({
      n_remito_ifco:           d.n_remito_ifco,
      n_remito_sg:             d.n_remito_sg ? String(d.n_remito_sg).trim() : null,
      fecha_emision:           d.fecha_emision,
      cliente_id:              d.cliente_id || null,
      cliente_telefono:        d.cliente_telefono || null,
      empresa:                 d.empresa || null,
      sucursal:                d.sucursal || null,
      modelo:                  d.modelo || '6420',
      cantidad_despachada:     cantDesp,
      cantidad_recibida:       recibida,
      cantidad_rechazada:      rechazada,
      producto:                d.producto || null,
      transportista:           d.transportista || null,
      encargado_prov_apellido: d.encargado_prov_apellido || null,
      encargado_prov_nombre:   d.encargado_prov_nombre || null,
      encargado_prov_dni:      d.encargado_prov_dni || null,
      encargado_super_apellido: d.encargado_super_apellido || null,
      encargado_super_nombre:   d.encargado_super_nombre   || null,
      encargado_super_dni:      d.encargado_super_dni      || null,
      talonario_id:            d.talonario_id || null,
      notas:                   d.notas || null,
      usuario_id:              req.user.id || null,
      escaneo_path:            escaneo_path,
      fecha_sellado:           d.fecha_sellado,
      origen:                  origen,
      proveedor_origen_id:     proveedor_origen_id,
      rechazo_destino:         rechazo_destino
    });
    res.json({ id: r.lastInsertRowid, n_remito_ifco: d.n_remito_ifco, escaneo_path: escaneo_path, estado: 'sellado', origen: origen });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/remitos/:id/sellar', upload.single('escaneo'), function(req, res) {
  const id = req.params.id;
  const r = db.prepare("SELECT * FROM ifco_remitos_super WHERE id = ?").get(id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  if (r.estado !== 'despachado' && r.estado !== 'sellado') {
    return res.status(400).json({ error: 'No se puede sellar un remito en estado ' + r.estado });
  }
  const d = req.body || {};
  if (!d.fecha_sellado) return res.status(400).json({ error: 'Fecha de sellado requerida' });

  const recibida  = d.cantidad_recibida  != null ? parseInt(d.cantidad_recibida)  : r.cantidad_despachada;
  const rechazada = d.cantidad_rechazada != null ? parseInt(d.cantidad_rechazada) : 0;
  if (recibida < 0 || rechazada < 0) {
    return res.status(400).json({ error: 'Cantidades no pueden ser negativas' });
  }
  if (recibida + rechazada > r.cantidad_despachada) {
    return res.status(400).json({ error: 'Recibida + rechazada superan la cantidad despachada' });
  }

  let escaneo_path = r.escaneo_path;
  if (req.file) {
    escaneo_path = '/data/ifco/' + req.file.filename;
  } else if (d.escaneo_path && /^\/data\/ifco\//.test(d.escaneo_path)) {
    escaneo_path = d.escaneo_path;
  }

  // Destino del rechazo: si hay rechazo > 0, debe especificarse
  let rechazo_destino = null;
  if (rechazada > 0) {
    rechazo_destino = d.rechazo_destino || 'san_geronimo';
    if (['san_geronimo','proveedor'].indexOf(rechazo_destino) < 0) {
      return res.status(400).json({ error: 'rechazo_destino debe ser "san_geronimo" o "proveedor"' });
    }
  }

  db.prepare(`
    UPDATE ifco_remitos_super SET
      estado = 'sellado',
      fecha_sellado = @fecha_sellado,
      encargado_super_apellido = @encargado_super_apellido,
      encargado_super_nombre   = @encargado_super_nombre,
      encargado_super_dni      = @encargado_super_dni,
      cantidad_recibida        = @cantidad_recibida,
      cantidad_rechazada       = @cantidad_rechazada,
      rechazo_destino          = @rechazo_destino,
      escaneo_path             = @escaneo_path,
      actualizado_en           = datetime('now','localtime')
    WHERE id = @id
  `).run({
    id: id,
    fecha_sellado:            d.fecha_sellado,
    encargado_super_apellido: d.encargado_super_apellido || null,
    encargado_super_nombre:   d.encargado_super_nombre   || null,
    encargado_super_dni:      d.encargado_super_dni      || null,
    cantidad_recibida:        recibida,
    cantidad_rechazada:       rechazada,
    rechazo_destino:          rechazo_destino,
    escaneo_path:             escaneo_path
  });

  res.json({ ok: true, escaneo_path: escaneo_path });
});

// Marcar varios remitos sellados como presentados (al hacer mailto)
router.post('/remitos/presentar', function(req, res) {
  const ids = (req.body && req.body.ids) || [];
  const email = (req.body && req.body.email) || null;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'IDs requeridos' });
  }
  const ph = ids.map(function(){ return '?'; }).join(',');
  const remitos = db.prepare(`
    SELECT * FROM ifco_remitos_super WHERE id IN (${ph}) AND estado = 'sellado'
  `).all(...ids);
  if (remitos.length === 0) {
    return res.status(400).json({ error: 'Ninguno de los IDs corresponde a un remito sellado' });
  }
  const r = db.prepare(`
    UPDATE ifco_remitos_super
    SET estado = 'presentado',
        fecha_presentado = date('now','localtime'),
        email_enviado_a = ?,
        actualizado_en = datetime('now','localtime')
    WHERE id IN (${ph}) AND estado = 'sellado'
  `).run(email, ...ids);
  res.json({ ok: true, presentados: r.changes, remitos: remitos });
});

// PATCH /remitos/:id — editar (solo si estado='despachado')
router.patch('/remitos/:id', function(req, res) {
  const r = db.prepare("SELECT * FROM ifco_remitos_super WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  if (r.eliminado_en) return res.status(400).json({ error: 'Está eliminado. Restauralo primero.' });
  if (r.estado !== 'despachado') {
    return res.status(400).json({ error: 'Solo se puede editar mientras está en estado "despachado". Estado actual: ' + r.estado });
  }
  const d = req.body || {};

  // Si cambian el n_remito, validar unicidad entre activos
  if (d.n_remito_ifco && d.n_remito_ifco !== r.n_remito_ifco) {
    const dup = db.prepare("SELECT id FROM ifco_remitos_super WHERE n_remito_ifco = ? AND eliminado_en IS NULL AND id != ?").get(d.n_remito_ifco, req.params.id);
    if (dup) return res.status(409).json({ error: 'Ya existe otro remito activo con ese número' });
  }

  // Origen: si cambia a directo, validar proveedor
  let origen = d.origen || r.origen;
  let proveedor_origen_id = r.proveedor_origen_id;
  if (origen === 'proveedor_directo') {
    if (d.proveedor_origen_id !== undefined) proveedor_origen_id = parseInt(d.proveedor_origen_id) || null;
    if (!proveedor_origen_id) return res.status(400).json({ error: 'Origen directo requiere proveedor_origen_id' });
  } else {
    origen = 'san_geronimo';
    proveedor_origen_id = null;
  }

  db.prepare(`
    UPDATE ifco_remitos_super SET
      n_remito_ifco           = COALESCE(?, n_remito_ifco),
      n_remito_sg             = ?,
      fecha_emision           = COALESCE(?, fecha_emision),
      cliente_id              = ?,
      empresa                 = COALESCE(?, empresa),
      sucursal                = COALESCE(?, sucursal),
      cantidad_despachada     = COALESCE(?, cantidad_despachada),
      producto                = ?,
      transportista           = COALESCE(?, transportista),
      encargado_prov_apellido = COALESCE(?, encargado_prov_apellido),
      encargado_prov_nombre   = COALESCE(?, encargado_prov_nombre),
      encargado_prov_dni      = COALESCE(?, encargado_prov_dni),
      notas                   = COALESCE(?, notas),
      origen                  = ?,
      proveedor_origen_id     = ?,
      actualizado_en          = datetime('now','localtime')
    WHERE id = ?
  `).run(
    d.n_remito_ifco || null,
    d.n_remito_sg !== undefined ? (d.n_remito_sg ? String(d.n_remito_sg).trim() : null) : null,
    d.fecha_emision || null,
    d.cliente_id || null,
    d.empresa || null,
    d.sucursal || null,
    d.cantidad_despachada ? parseInt(d.cantidad_despachada) : null,
    d.producto || null,
    d.transportista || null,
    d.encargado_prov_apellido || null,
    d.encargado_prov_nombre || null,
    d.encargado_prov_dni || null,
    d.notas || null,
    origen,
    proveedor_origen_id,
    req.params.id
  );
  res.json({ ok: true });
});

// DELETE /remitos/:id — soft delete (todos)
router.delete('/remitos/:id', function(req, res) {
  const r = db.prepare("SELECT id FROM ifco_remitos_super WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado o ya eliminado' });
  db.prepare(`UPDATE ifco_remitos_super
              SET eliminado_en = datetime('now','localtime'),
                  eliminado_por_id = ?
              WHERE id = ?`).run(req.user.id || null, req.params.id);
  res.json({ ok: true });
});

// POST /remitos/:id/restaurar — recuperar de papelera
router.post('/remitos/:id/restaurar', function(req, res) {
  const r = db.prepare("SELECT * FROM ifco_remitos_super WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  if (!r.eliminado_en) return res.status(400).json({ error: 'No está en papelera' });
  // Validar unicidad antes de restaurar
  const dup = db.prepare("SELECT id FROM ifco_remitos_super WHERE n_remito_ifco = ? AND eliminado_en IS NULL AND id != ?").get(r.n_remito_ifco, req.params.id);
  if (dup) return res.status(409).json({ error: 'Hay otro remito activo con ese mismo número (' + r.n_remito_ifco + '). Eliminá ese o renombrá este antes de restaurar.' });
  db.prepare("UPDATE ifco_remitos_super SET eliminado_en = NULL, eliminado_por_id = NULL WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// ENVÍOS A PROVEEDOR
// ════════════════════════════════════════════════════════════════════════════

router.get('/envios', function(req, res) {
  const f = req.query;
  const papelera = f.papelera === '1' || f.incluir_eliminados === '1';
  let q = `
    SELECT e.*, p.nombre AS proveedor_nombre, p.razon_social AS proveedor_razon,
           u.nombre AS eliminado_por_username
    FROM ifco_envios_proveedor e
    LEFT JOIN proveedores p ON p.id = e.proveedor_id
    LEFT JOIN usuarios u ON u.id = e.eliminado_por_id
    WHERE 1=1
  `;
  const p = [];
  if (papelera) q += " AND e.eliminado_en IS NOT NULL";
  else          q += " AND e.eliminado_en IS NULL";
  if (f.estado)       { q += " AND e.estado = ?";       p.push(f.estado); }
  if (f.proveedor_id) { q += " AND e.proveedor_id = ?"; p.push(f.proveedor_id); }
  q += " ORDER BY e.fecha_envio DESC, e.id DESC LIMIT 500";
  res.json(db.prepare(q).all(...p));
});

router.get('/envios/:id', function(req, res) {
  const e = db.prepare(`
    SELECT e.*, p.nombre AS proveedor_nombre, p.razon_social AS proveedor_razon, p.cuit AS proveedor_cuit
    FROM ifco_envios_proveedor e
    LEFT JOIN proveedores p ON p.id = e.proveedor_id
    WHERE e.id = ?
  `).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No encontrado' });
  res.json(e);
});

router.post('/envios', function(req, res) {
  const d = req.body || {};
  if (!d.fecha_envio || !d.proveedor_id || !d.cantidad_enviada) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }
  const cant = parseInt(d.cantidad_enviada);
  if (cant <= 0) return res.status(400).json({ error: 'Cantidad inválida' });

  // Genera n° interno SG-P-AAAA-NNNN, correlativo por año
  const year = new Date(d.fecha_envio).getFullYear();
  const ultimo = db.prepare(`
    SELECT n_remito_interno FROM ifco_envios_proveedor
    WHERE n_remito_interno LIKE ? ORDER BY id DESC LIMIT 1
  `).get('SG-P-' + year + '-%');

  let nro = 1;
  if (ultimo) {
    const m = String(ultimo.n_remito_interno).match(/-(\d+)$/);
    if (m) nro = parseInt(m[1], 10) + 1;
  }
  const n_remito_interno = 'SG-P-' + year + '-' + String(nro).padStart(4, '0');

  try {
    const r = db.prepare(`
      INSERT INTO ifco_envios_proveedor
        (n_remito_interno, fecha_envio, proveedor_id, cantidad_enviada, modelo, notas, usuario_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(n_remito_interno, d.fecha_envio, d.proveedor_id, cant,
           d.modelo || '6420', d.notas || null, req.user.id || null);

    res.json({ id: r.lastInsertRowid, n_remito_interno: n_remito_interno });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/envios/:id/recepcionar', upload.single('escaneo_recepcion'), function(req, res) {
  const d = req.body || {};
  const e = db.prepare("SELECT * FROM ifco_envios_proveedor WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No encontrado' });
  if (!d.fecha_recepcion || d.cantidad_recibida == null) {
    return res.status(400).json({ error: 'Fecha y cantidad recibida requeridas' });
  }
  const recib = parseInt(d.cantidad_recibida);
  if (recib < 0 || recib > e.cantidad_enviada) {
    return res.status(400).json({ error: 'Cantidad recibida inválida (rango 0..' + e.cantidad_enviada + ')' });
  }
  const estado = recib === e.cantidad_enviada ? 'recibido' : 'parcial';

  let escaneo_recepcion_path = e.escaneo_recepcion_path;
  if (req.file) escaneo_recepcion_path = '/data/ifco/' + req.file.filename;

  db.prepare(`
    UPDATE ifco_envios_proveedor SET
      estado = ?, fecha_recepcion = ?, cantidad_recibida = ?,
      notas = COALESCE(?, notas),
      escaneo_recepcion_path = ?,
      actualizado_en = datetime('now','localtime')
    WHERE id = ?
  `).run(estado, d.fecha_recepcion, recib, d.notas || null, escaneo_recepcion_path, req.params.id);

  res.json({ ok: true, estado: estado, cantidad_recibida: recib, escaneo_recepcion_path: escaneo_recepcion_path });
});

// PATCH /envios/:id — editar (solo si estado='enviado', no parcial/recibido)
router.patch('/envios/:id', function(req, res) {
  const e = db.prepare("SELECT * FROM ifco_envios_proveedor WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No encontrado' });
  if (e.eliminado_en) return res.status(400).json({ error: 'Está eliminado. Restauralo primero.' });
  if (e.estado !== 'enviado') {
    return res.status(400).json({ error: 'Solo se puede editar mientras está en estado "enviado". Estado actual: ' + e.estado });
  }
  const d = req.body || {};
  db.prepare(`
    UPDATE ifco_envios_proveedor SET
      fecha_envio      = COALESCE(?, fecha_envio),
      proveedor_id     = COALESCE(?, proveedor_id),
      cantidad_enviada = COALESCE(?, cantidad_enviada),
      notas            = ?,
      actualizado_en   = datetime('now','localtime')
    WHERE id = ?
  `).run(
    d.fecha_envio || null,
    d.proveedor_id ? parseInt(d.proveedor_id) : null,
    d.cantidad_enviada ? parseInt(d.cantidad_enviada) : null,
    d.notas || null,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/envios/:id', function(req, res) {
  const e = db.prepare("SELECT id FROM ifco_envios_proveedor WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No encontrado o ya eliminado' });
  db.prepare(`UPDATE ifco_envios_proveedor
              SET eliminado_en = datetime('now','localtime'),
                  eliminado_por_id = ?
              WHERE id = ?`).run(req.user.id || null, req.params.id);
  res.json({ ok: true });
});

router.post('/envios/:id/restaurar', function(req, res) {
  const e = db.prepare("SELECT * FROM ifco_envios_proveedor WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No encontrado' });
  if (!e.eliminado_en) return res.status(400).json({ error: 'No está en papelera' });
  db.prepare("UPDATE ifco_envios_proveedor SET eliminado_en = NULL, eliminado_por_id = NULL WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// MOVIMIENTOS PUNTUALES (retiros, pérdidas)
// ════════════════════════════════════════════════════════════════════════════

router.get('/movimientos', function(req, res) {
  const f = req.query;
  const papelera = f.papelera === '1' || f.incluir_eliminados === '1';
  let q = `SELECT m.*, u.nombre AS eliminado_por_username
           FROM ifco_movimientos m
           LEFT JOIN usuarios u ON u.id = m.eliminado_por_id
           WHERE 1=1`;
  const p = [];
  if (papelera) q += " AND m.eliminado_en IS NOT NULL";
  else          q += " AND m.eliminado_en IS NULL";
  if (f.tipo)  { q += " AND m.tipo = ?";   p.push(f.tipo); }
  if (f.desde) { q += " AND m.fecha >= ?"; p.push(f.desde); }
  if (f.hasta) { q += " AND m.fecha <= ?"; p.push(f.hasta); }
  q += " ORDER BY m.fecha DESC, m.id DESC LIMIT 500";
  res.json(db.prepare(q).all(...p));
});

router.get('/movimientos/:id', function(req, res) {
  const m = db.prepare("SELECT * FROM ifco_movimientos WHERE id = ?").get(req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrado' });
  res.json(m);
});

router.post('/movimientos', function(req, res) {
  const d = req.body || {};
  if (!d.fecha || !d.tipo || !d.cantidad) return res.status(400).json({ error: 'Faltan datos' });
  if (['retiro','perdida'].indexOf(d.tipo) < 0) return res.status(400).json({ error: 'Tipo inválido' });
  const cant = parseInt(d.cantidad);
  if (cant <= 0) return res.status(400).json({ error: 'Cantidad inválida' });

  // Validar sucursal IFCO si viene (solo aplicable a retiros)
  if (d.sucursal_ifco && ['Buenos Aires','Mendoza'].indexOf(d.sucursal_ifco) < 0) {
    return res.status(400).json({ error: 'sucursal_ifco inválida (esperado: Buenos Aires | Mendoza)' });
  }

  const r = db.prepare(`
    INSERT INTO ifco_movimientos (
      fecha, tipo, cantidad, modelo, n_remito,
      costo_total, moneda, notas, usuario_id,
      sucursal_ifco, encargado_apellido, encargado_nombre, encargado_dni
    )
    VALUES (?, ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?, ?)
  `).run(
    d.fecha, d.tipo, cant, d.modelo || '6420', d.n_remito || null,
    parseFloat(d.costo_total) || 0, d.moneda || 'ARS', d.notas || null, req.user.id || null,
    d.sucursal_ifco || null, d.encargado_apellido || null, d.encargado_nombre || null, d.encargado_dni || null
  );

  res.json({ id: r.lastInsertRowid });
});

// PATCH /movimientos/:id — editar (siempre permitido)
router.patch('/movimientos/:id', function(req, res) {
  const m = db.prepare("SELECT * FROM ifco_movimientos WHERE id = ?").get(req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrado' });
  if (m.eliminado_en) return res.status(400).json({ error: 'Está eliminado. Restauralo primero.' });
  const d = req.body || {};
  if (d.sucursal_ifco && ['Buenos Aires','Mendoza'].indexOf(d.sucursal_ifco) < 0) {
    return res.status(400).json({ error: 'sucursal_ifco inválida' });
  }
  db.prepare(`
    UPDATE ifco_movimientos SET
      fecha              = COALESCE(?, fecha),
      cantidad           = COALESCE(?, cantidad),
      n_remito           = ?,
      costo_total        = COALESCE(?, costo_total),
      notas              = ?,
      sucursal_ifco      = ?,
      encargado_apellido = ?,
      encargado_nombre   = ?,
      encargado_dni      = ?
    WHERE id = ?
  `).run(
    d.fecha || null,
    d.cantidad ? parseInt(d.cantidad) : null,
    d.n_remito || null,
    d.costo_total != null ? parseFloat(d.costo_total) : null,
    d.notas || null,
    d.sucursal_ifco || null,
    d.encargado_apellido || null,
    d.encargado_nombre || null,
    d.encargado_dni || null,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/movimientos/:id', function(req, res) {
  const m = db.prepare("SELECT id FROM ifco_movimientos WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrado o ya eliminado' });
  db.prepare(`UPDATE ifco_movimientos
              SET eliminado_en = datetime('now','localtime'),
                  eliminado_por_id = ?
              WHERE id = ?`).run(req.user.id || null, req.params.id);
  res.json({ ok: true });
});

router.post('/movimientos/:id/restaurar', function(req, res) {
  const m = db.prepare("SELECT * FROM ifco_movimientos WHERE id = ?").get(req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrado' });
  if (!m.eliminado_en) return res.status(400).json({ error: 'No está en papelera' });
  db.prepare("UPDATE ifco_movimientos SET eliminado_en = NULL, eliminado_por_id = NULL WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// RESUMEN — stocks calculados + alertas + saldos por contraparte
// ════════════════════════════════════════════════════════════════════════════

router.get('/resumen', function(req, res) {
  const get = function(sql, ...p) { return (db.prepare(sql).get(...p) || {}).total || 0; };

  // Movimientos puntuales
  const retirado = get("SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_movimientos WHERE tipo='retiro' AND eliminado_en IS NULL");
  const perdido  = get("SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_movimientos WHERE tipo='perdida' AND eliminado_en IS NULL");

  // Envíos a proveedor — totales y pendientes (excluyendo eliminados)
  const envios_totales = get(`
    SELECT COALESCE(SUM(cantidad_enviada),0) AS total
    FROM ifco_envios_proveedor
    WHERE estado IN ('enviado','parcial','recibido') AND eliminado_en IS NULL
  `);
  const recepciones_envios = get(`
    SELECT COALESCE(SUM(cantidad_recibida),0) AS total
    FROM ifco_envios_proveedor
    WHERE estado IN ('recibido','parcial') AND eliminado_en IS NULL
  `);
  // Recepciones de mercadería (cajones que vuelven con producto, entidad nueva)
  const recepciones_merc = get(`
    SELECT COALESCE(SUM(cantidad),0) AS total
    FROM ifco_recepciones_proveedor
    WHERE eliminado_en IS NULL
  `);
  const en_proveedores = get(`
    SELECT COALESCE(SUM(cantidad_enviada - COALESCE(cantidad_recibida,0)),0) AS total
    FROM ifco_envios_proveedor
    WHERE estado IN ('enviado','parcial') AND eliminado_en IS NULL
  `) - recepciones_merc;  // los que volvieron físicamente bajan el saldo

  // Despachos a súper — totales y rechazos vueltos. Solo despachos origen=SG cuentan
  // contra el stock SG. Los "directo desde proveedor" no salieron del piso de SG.
  const despachos_sg = get(`
    SELECT COALESCE(SUM(cantidad_despachada),0) AS total
    FROM ifco_remitos_super
    WHERE estado IN ('despachado','sellado','presentado')
      AND origen = 'san_geronimo'
      AND eliminado_en IS NULL
  `);
  const rechazos_vueltos_sg = get(`
    SELECT COALESCE(SUM(cantidad_rechazada),0) AS total
    FROM ifco_remitos_super
    WHERE estado IN ('sellado','presentado')
      AND rechazo_destino = 'san_geronimo'
      AND eliminado_en IS NULL
  `);
  const en_transito_sg = get(`
    SELECT COALESCE(SUM(cantidad_despachada),0) AS total
    FROM ifco_remitos_super
    WHERE estado = 'despachado'
      AND origen = 'san_geronimo'
      AND eliminado_en IS NULL
  `);

  // PISO actual = retiros - envíos a prov + recepciones (ambas: de envíos + mercadería) - despachos SG + rechazos vueltos
  const piso = retirado - envios_totales + recepciones_envios + recepciones_merc - despachos_sg + rechazos_vueltos_sg;
  const bajo_responsabilidad = piso + en_proveedores + en_transito_sg;

  // Alertas — sellados >= 25 días sin presentar
  const urgentes_presentar = db.prepare(`
    SELECT id, n_remito_ifco, fecha_sellado, empresa, sucursal,
      cantidad_recibida, cantidad_rechazada,
      CAST(julianday('now','localtime') - julianday(fecha_sellado) AS INTEGER) AS dias
    FROM ifco_remitos_super
    WHERE estado = 'sellado'
      AND eliminado_en IS NULL
      AND julianday('now','localtime') - julianday(fecha_sellado) >= 25
    ORDER BY fecha_sellado ASC
  `).all();

  const sin_sellar = db.prepare(`
    SELECT id, n_remito_ifco, fecha_emision, empresa, sucursal, cantidad_despachada,
      CAST(julianday('now','localtime') - julianday(fecha_emision) AS INTEGER) AS dias
    FROM ifco_remitos_super
    WHERE estado = 'despachado'
      AND eliminado_en IS NULL
      AND julianday('now','localtime') - julianday(fecha_emision) >= 30
    ORDER BY fecha_emision ASC
  `).all();

  const envios_vencidos = db.prepare(`
    SELECT e.id, e.n_remito_interno, e.fecha_envio, e.cantidad_enviada,
      p.nombre AS proveedor_nombre,
      CAST(julianday('now','localtime') - julianday(e.fecha_envio) AS INTEGER) AS dias
    FROM ifco_envios_proveedor e
    LEFT JOIN proveedores p ON p.id = e.proveedor_id
    WHERE e.estado = 'enviado'
      AND e.eliminado_en IS NULL
      AND julianday('now','localtime') - julianday(e.fecha_envio) >= 15
    ORDER BY e.fecha_envio ASC
  `).all();

  // Estado del talonario activo
  const tal = db.prepare("SELECT * FROM ifco_talonarios WHERE activo = 1 LIMIT 1").get();
  let talonario_alerta = null, talonario_info = null;
  if (tal) {
    const u = db.prepare(`
      SELECT n_remito_ifco FROM ifco_remitos_super
      WHERE talonario_id = ? AND eliminado_en IS NULL ORDER BY id DESC LIMIT 1
    `).get(tal.id);
    let proxNum = tal.numero_desde;
    if (u) {
      const m = String(u.n_remito_ifco).match(/-(\d+)$/);
      if (m) proxNum = parseInt(m[1], 10) + 1;
    }
    const disp = Math.max(0, tal.numero_hasta - proxNum + 1);
    let dias_cai = null;
    if (tal.vto_cai) {
      dias_cai = Math.floor((new Date(tal.vto_cai) - new Date()) / (1000*60*60*24));
    }
    talonario_info = { serie: tal.serie, disponibles: disp, dias_cai: dias_cai };
    if (disp < 100 || (dias_cai !== null && dias_cai < 60)) {
      talonario_alerta = {
        serie: tal.serie,
        disponibles: disp,
        dias_cai: dias_cai,
        razon: disp < 100 ? 'pocos_remitos' : 'cai_vence'
      };
    }
  }

  // Saldos por cliente
  const por_cliente = db.prepare(`
    SELECT
      cliente_id, empresa,
      SUM(CASE WHEN estado='despachado' THEN cantidad_despachada ELSE 0 END) AS en_transito,
      SUM(CASE WHEN estado='sellado' THEN 1 ELSE 0 END) AS sellados_pendientes_count
    FROM ifco_remitos_super
    WHERE estado IN ('despachado','sellado') AND eliminado_en IS NULL
    GROUP BY cliente_id, empresa
    HAVING en_transito > 0 OR sellados_pendientes_count > 0
    ORDER BY en_transito DESC, sellados_pendientes_count DESC
  `).all();

  // Saldos por proveedor — usa el cálculo unificado
  const por_proveedor = db.prepare(`
    SELECT id, nombre AS proveedor_nombre FROM proveedores
  `).all().map(function(p){
    const pendiente = _calcSaldoProveedor(p.id);
    return { proveedor_id: p.id, proveedor_nombre: p.proveedor_nombre, pendiente: pendiente };
  }).filter(function(x){ return x.pendiente > 0; })
    .sort(function(a,b){ return b.pendiente - a.pendiente; });

  res.json({
    stock: {
      piso: piso,
      en_proveedores: en_proveedores,
      en_transito: en_transito_sg,
      bajo_responsabilidad: bajo_responsabilidad,
      perdidas_acumuladas: perdido,
      retirado_total: retirado
    },
    alertas: {
      urgentes_presentar: urgentes_presentar,
      sin_sellar: sin_sellar,
      envios_vencidos: envios_vencidos,
      talonario: talonario_alerta
    },
    saldos: {
      por_cliente: por_cliente,
      por_proveedor: por_proveedor
    },
    talonario: talonario_info
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CATÁLOGOS auxiliares (para los selects de la UI)
// ════════════════════════════════════════════════════════════════════════════

router.get('/proveedores', function(req, res) {
  const rows = db.prepare(`
    SELECT id, nombre, razon_social, cuit FROM proveedores
    WHERE activo = 1 ORDER BY nombre
  `).all();
  res.json(rows);
});

router.get('/clientes-dedicados', function(req, res) {
  // dedicados_clientes existe pero no está creada en db.js — la query es defensiva
  try {
    const rows = db.prepare(`
      SELECT id, nombre, empresa, supermercado, telefono FROM dedicados_clientes
      WHERE activo = 1 ORDER BY empresa, nombre
    `).all();
    res.json(rows);
  } catch(e) {
    res.json([]);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SALDO POR PROVEEDOR (para vista imprimible del envío)
// ════════════════════════════════════════════════════════════════════════════

// Saldo del proveedor:
//   + cajones que SG envió al proveedor (pendientes de devolución, vía envíos parcial/enviado)
//   - cajones que SG recibió del proveedor en su depósito (recepciones de mercadería)
//   - cajones despachados a súper como "directo desde este proveedor" Y SELLADOS
//
// Todos los cálculos excluyen registros eliminados (papelera).
function _calcSaldoProveedor(provId) {
  const enviado = db.prepare(`
    SELECT COALESCE(SUM(cantidad_enviada - COALESCE(cantidad_recibida,0)), 0) AS total
    FROM ifco_envios_proveedor
    WHERE proveedor_id = ? AND eliminado_en IS NULL
      AND estado IN ('enviado','parcial')
  `).get(provId).total || 0;

  const recibidoEnSG = db.prepare(`
    SELECT COALESCE(SUM(cantidad), 0) AS total
    FROM ifco_recepciones_proveedor
    WHERE proveedor_id = ? AND eliminado_en IS NULL
  `).get(provId).total || 0;

  const directosSellados = db.prepare(`
    SELECT COALESCE(SUM(
      COALESCE(cantidad_recibida, cantidad_despachada) +
      CASE WHEN rechazo_destino = 'san_geronimo' THEN COALESCE(cantidad_rechazada, 0) ELSE 0 END
    ), 0) AS total
    FROM ifco_remitos_super
    WHERE proveedor_origen_id = ?
      AND origen = 'proveedor_directo'
      AND estado IN ('sellado','presentado')
      AND eliminado_en IS NULL
  `).get(provId).total || 0;

  return enviado - recibidoEnSG - directosSellados;
}

router.get('/saldo-proveedor/:id', function(req, res) {
  const provId = parseInt(req.params.id);
  if (!provId) return res.status(400).json({ error: 'ID proveedor inválido' });
  const pendiente = _calcSaldoProveedor(provId);
  res.json({ proveedor_id: provId, pendiente: pendiente });
});

// LISTA: todos los proveedores con su saldo actual de cajones IFCO (incluye 0 y negativos)
router.get('/proveedores-saldos', function(req, res) {
  const provs = db.prepare("SELECT id, nombre, razon_social FROM proveedores ORDER BY nombre").all();
  const result = provs.map(function(p) {
    return {
      id: p.id,
      nombre: p.nombre,
      razon_social: p.razon_social,
      saldo: _calcSaldoProveedor(p.id)
    };
  });
  res.json(result);
});

// Helper: arma la lista cronológica de movimientos de un proveedor
function _movimientosProveedor(provId) {
  const envios = db.prepare(`
    SELECT 'envio' AS tipo, id, fecha_envio AS fecha, n_remito_interno AS detalle,
           cantidad_enviada AS cantidad, cantidad_recibida, estado, notas
    FROM ifco_envios_proveedor
    WHERE proveedor_id = ? AND eliminado_en IS NULL
  `).all(provId);

  const recepciones = db.prepare(`
    SELECT 'recepcion' AS tipo, id, fecha_recepcion AS fecha,
           COALESCE(producto, n_remito_proveedor, 'Recepción de mercadería') AS detalle,
           cantidad, n_remito_proveedor, notas
    FROM ifco_recepciones_proveedor
    WHERE proveedor_id = ? AND eliminado_en IS NULL
  `).all(provId);

  const directos = db.prepare(`
    SELECT 'despacho_directo' AS tipo, id, fecha_emision AS fecha,
           (n_remito_ifco || ' → ' || COALESCE(empresa,'?')) AS detalle,
           cantidad_despachada AS cantidad, cantidad_recibida, cantidad_rechazada,
           estado, fecha_sellado, sucursal, rechazo_destino
    FROM ifco_remitos_super
    WHERE proveedor_origen_id = ? AND origen = 'proveedor_directo' AND eliminado_en IS NULL
  `).all(provId);

  const all = envios.concat(recepciones, directos);
  // Orden cronológico ascendente (después por id como desempate)
  all.sort(function(a,b) {
    if (a.fecha === b.fecha) return (a.id||0) - (b.id||0);
    return (a.fecha||'') < (b.fecha||'') ? -1 : 1;
  });

  // Calcular delta de cada movimiento (mismo criterio que _calcSaldoProveedor)
  return all.map(function(m) {
    let delta = 0;
    if (m.tipo === 'envio') {
      // Saldo: sale cantidad enviada, vuelve cantidad recibida (esa parte se descuenta abajo)
      // Acá registramos el envío entero como +cantidad
      // Ojo: si el envío está finalizado, su cantidad_recibida ya está computada en las recepciones (otra tabla),
      //      por eso solo suma "cantidad_enviada" entera y las recepciones lo bajan.
      delta = +m.cantidad;
    } else if (m.tipo === 'recepcion') {
      delta = -m.cantidad;
    } else if (m.tipo === 'despacho_directo') {
      if (m.estado === 'sellado' || m.estado === 'presentado') {
        const recib = m.cantidad_recibida != null ? m.cantidad_recibida : m.cantidad;
        const rech  = m.cantidad_rechazada || 0;
        // Si el rechazo volvió a SG, también sale del proveedor (= todo lo despachado)
        // Si el rechazo se quedó con el proveedor (o NULL), solo sale lo recibido por el súper
        if (m.rechazo_destino === 'san_geronimo') {
          delta = -(recib + rech);
        } else {
          delta = -recib;
        }
      } else {
        delta = 0; // 'despachado' (en tránsito) no afecta saldo todavía
      }
    }
    return Object.assign({}, m, { delta: delta });
  });
}

// MOVIMIENTOS de un proveedor (envíos + recepciones + despachos directos)
router.get('/proveedores/:id/movimientos', function(req, res) {
  const provId = parseInt(req.params.id);
  if (!provId) return res.status(400).json({ error: 'ID inválido' });
  const p = db.prepare("SELECT id, nombre, razon_social FROM proveedores WHERE id = ?").get(provId);
  if (!p) return res.status(404).json({ error: 'Proveedor no encontrado' });

  const movimientos = _movimientosProveedor(provId);
  const saldo = _calcSaldoProveedor(provId);
  res.json({ proveedor: p, movimientos: movimientos, saldo: saldo });
});

// EXPORTAR movimientos a Excel (.xlsx) — PENDIENTE: requiere instalar dependency `xlsx` (SheetJS)
// Endpoint comentado hasta que se haga `npm install xlsx`. Después descomentar y reactivar el botón
// en el modal de movimientos del proveedor (ifcoDescargarMovimientosXlsx en panel.html).

// ════════════════════════════════════════════════════════════════════════════
// RECEPCIONES DE MERCADERÍA DEL PROVEEDOR
// (cajones IFCO que vuelven a SG con producto cargado, opcionalmente atado a un envío)
// ════════════════════════════════════════════════════════════════════════════

router.get('/recepciones-proveedor', function(req, res) {
  const f = req.query;
  const papelera = f.papelera === '1' || f.incluir_eliminados === '1';
  let q = `SELECT r.*,
                  p.nombre  AS proveedor_nombre,
                  p.razon_social AS proveedor_razon,
                  u.nombre AS eliminado_por_username
           FROM ifco_recepciones_proveedor r
           LEFT JOIN proveedores p ON p.id = r.proveedor_id
           LEFT JOIN usuarios u ON u.id = r.eliminado_por_id
           WHERE 1=1`;
  const p = [];
  if (papelera) q += " AND r.eliminado_en IS NOT NULL";
  else          q += " AND r.eliminado_en IS NULL";
  if (f.proveedor_id) { q += " AND r.proveedor_id = ?"; p.push(f.proveedor_id); }
  if (f.desde)        { q += " AND r.fecha_recepcion >= ?"; p.push(f.desde); }
  if (f.hasta)        { q += " AND r.fecha_recepcion <= ?"; p.push(f.hasta); }
  q += " ORDER BY r.fecha_recepcion DESC, r.id DESC LIMIT 500";
  res.json(db.prepare(q).all(...p));
});

router.get('/recepciones-proveedor/:id', function(req, res) {
  const r = db.prepare(`
    SELECT r.*, p.nombre AS proveedor_nombre, p.razon_social AS proveedor_razon
    FROM ifco_recepciones_proveedor r
    LEFT JOIN proveedores p ON p.id = r.proveedor_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  res.json(r);
});

router.post('/recepciones-proveedor', upload.single('escaneo'), function(req, res) {
  const d = req.body || {};
  if (!d.fecha_recepcion) return res.status(400).json({ error: 'Fecha requerida' });
  if (!d.proveedor_id)    return res.status(400).json({ error: 'Proveedor requerido' });
  const cant = parseInt(d.cantidad);
  if (!cant || cant <= 0) return res.status(400).json({ error: 'Cantidad inválida' });

  const exProv = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(d.proveedor_id);
  if (!exProv) return res.status(400).json({ error: 'Proveedor inexistente' });

  let escaneo_path = null;
  if (req.file) {
    escaneo_path = '/data/ifco/' + req.file.filename;
  } else if (d.escaneo_path && /^\/data\/ifco\//.test(d.escaneo_path)) {
    escaneo_path = d.escaneo_path;
  }

  const r = db.prepare(`
    INSERT INTO ifco_recepciones_proveedor
      (fecha_recepcion, proveedor_id, cantidad, producto, n_remito_proveedor, escaneo_path, notas, usuario_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.fecha_recepcion, parseInt(d.proveedor_id), cant,
    d.producto || null, d.n_remito_proveedor || null,
    escaneo_path, d.notas || null, req.user.id || null
  );

  // Saldo actualizado (informativo para feedback al usuario)
  const saldo = _calcSaldoProveedor(parseInt(d.proveedor_id));
  res.json({ id: r.lastInsertRowid, escaneo_path: escaneo_path, saldo_proveedor_actual: saldo });
});

router.patch('/recepciones-proveedor/:id', upload.single('escaneo'), function(req, res) {
  const r = db.prepare("SELECT * FROM ifco_recepciones_proveedor WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  if (r.eliminado_en) return res.status(400).json({ error: 'Está eliminado. Restauralo primero.' });
  const d = req.body || {};

  let escaneo_path = r.escaneo_path;
  if (req.file) {
    escaneo_path = '/data/ifco/' + req.file.filename;
  } else if (d.escaneo_path && /^\/data\/ifco\//.test(d.escaneo_path)) {
    escaneo_path = d.escaneo_path;
  }

  db.prepare(`
    UPDATE ifco_recepciones_proveedor SET
      fecha_recepcion    = COALESCE(?, fecha_recepcion),
      proveedor_id       = COALESCE(?, proveedor_id),
      cantidad           = COALESCE(?, cantidad),
      producto           = ?,
      n_remito_proveedor = ?,
      escaneo_path       = ?,
      notas              = ?
    WHERE id = ?
  `).run(
    d.fecha_recepcion || null,
    d.proveedor_id ? parseInt(d.proveedor_id) : null,
    d.cantidad ? parseInt(d.cantidad) : null,
    d.producto || null,
    d.n_remito_proveedor || null,
    escaneo_path,
    d.notas || null,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/recepciones-proveedor/:id', function(req, res) {
  const r = db.prepare("SELECT id FROM ifco_recepciones_proveedor WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado o ya eliminado' });
  db.prepare(`UPDATE ifco_recepciones_proveedor
              SET eliminado_en = datetime('now','localtime'),
                  eliminado_por_id = ?
              WHERE id = ?`).run(req.user.id || null, req.params.id);
  res.json({ ok: true });
});

router.post('/recepciones-proveedor/:id/restaurar', function(req, res) {
  const r = db.prepare("SELECT * FROM ifco_recepciones_proveedor WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  if (!r.eliminado_en) return res.status(400).json({ error: 'No está en papelera' });
  db.prepare("UPDATE ifco_recepciones_proveedor SET eliminado_en = NULL, eliminado_por_id = NULL WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// OCR — Lectura automática de remitos IFCO con Claude vision
// ════════════════════════════════════════════════════════════════════════════

router.get('/ocr/status', function(req, res) {
  res.json({ enabled: OCR_ENABLED && !!ANTHROPIC_API_KEY, model: OCR_MODEL });
});

// Helper: extraer JSON limpio del texto que devuelve Claude
function _extraerJson(texto) {
  if (!texto) return null;
  // Pueden venir bloques ```json ... ``` o solo el JSON
  const matchFenced = texto.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidato = matchFenced ? matchFenced[1] : texto;
  const m = candidato.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch(e) { return null; }
}

// POST /ocr/remito-super  multipart: foto + tipo (despacho|sellado)
router.post('/ocr/remito-super', upload.single('foto'), async function(req, res) {
  if (!OCR_ENABLED || !ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'OCR deshabilitado en este entorno' });
  }
  if (!req.file) return res.status(400).json({ error: 'Falta archivo "foto"' });
  const tipo = (req.body && req.body.tipo) || 'despacho';
  if (['despacho','sellado','completo'].indexOf(tipo) < 0) {
    return res.status(400).json({ error: 'tipo debe ser "despacho", "sellado" o "completo"' });
  }
  const client = await _getAnthropic();
  if (!client) return res.status(503).json({ error: 'OCR no disponible (SDK no cargado)' });

  // Leer la foto y mandarla en base64
  const filePath = path.join(UPLOAD_DIR, req.file.filename);
  let mediaType = 'image/jpeg';
  const ext = path.extname(req.file.filename).toLowerCase();
  if (ext === '.png')  mediaType = 'image/png';
  if (ext === '.webp') mediaType = 'image/webp';
  if (ext === '.gif')  mediaType = 'image/gif';
  if (ext === '.pdf')  mediaType = 'application/pdf';
  if (mediaType === 'application/pdf') {
    return res.status(400).json({ error: 'PDF no soportado por OCR — subí JPG/PNG' });
  }
  let dataB64;
  try {
    const buf = fs.readFileSync(filePath);
    dataB64 = buf.toString('base64');
  } catch(e) {
    return res.status(500).json({ error: 'No se pudo leer el archivo subido: ' + e.message });
  }

  // Prompt según tipo
  const promptDespacho = [
    'Sos un asistente que lee remitos IFCO emitidos por SAN GERONIMO SA en Argentina.',
    'Esta foto es de un remito al momento de DESPACHARLO al supermercado (todavía no fue sellado por la cadena).',
    'Extraé los siguientes campos en formato JSON. Si un campo no se ve o no estás seguro, dejalo en null.',
    'Campos esperados:',
    '  "n_remito_ifco": string con formato "00015-XXXXXXXX" (preimpreso, esquina superior derecha)',
    '  "fecha_emision": string ISO "YYYY-MM-DD" (la fecha del despacho)',
    '  "empresa": string — la cadena de supermercado destinataria. Devolvé el valor EXACTO tal como aparece en el remito SOLO si coincide con uno de:',
    '    "CENCOSUD", "CARREFOUR (INC SA)", "COTO", "LA COOPERATIVA OBRERA", "LA ANONIMA", "CHANGO MAS (DORINKA)".',
    '    Si lo que ves se parece a uno de esos pero está abreviado o mal escrito, devolvé el de la lista que mejor matchea. Si no matchea ninguno, devolvé el texto literal del remito.',
    '  "cantidad_despachada": número entero — total de cajones (campo "TOTAL CAJAS" o equivalente)',
    '  "producto": string — descripción del producto cargado (ej. "mandarina malvina")',
    'NO leas ni extraigas: sucursal, transportista, encargado del proveedor, ni ningún otro dato adicional.',
    'Respondé SOLO el objeto JSON, sin texto adicional ni markdown.'
  ].join('\n');

  const promptSellado = [
    'Sos un asistente que lee remitos IFCO emitidos por SAN GERONIMO SA en Argentina.',
    'Esta foto es del MISMO remito ya VUELTO sellado por el supermercado destinatario.',
    'Extraé los datos del SELLADO en formato JSON. Si un campo no se ve, dejalo en null.',
    'Campos esperados:',
    '  "n_remito_ifco": string con formato "00015-XXXXXXXX"',
    '  "fecha_sellado": string ISO "YYYY-MM-DD" — la fecha de RECEPCIÓN del supermercado (puede estar manuscrita junto al sello)',
    '  "cantidad_recibida": número entero — cuántos cajones aceptó el súper',
    '  "cantidad_rechazada": número entero (0 si no hay rechazo)',
    '  "encargado_super_apellido": string — apellido de quien recibió en el súper',
    '  "encargado_super_nombre": string — nombre',
    '  "encargado_super_dni": string',
    'Respondé SOLO el objeto JSON, sin texto adicional ni markdown.'
  ].join('\n');

  // Prompt "completo": foto del remito YA sellado donde el remito original es legible
  // (cargas tardías donde nunca se subió la foto del despacho). Extrae todos los campos en una pasada.
  const promptCompleto = [
    'Sos un asistente que lee remitos IFCO emitidos por SAN GERONIMO SA en Argentina.',
    'Esta foto es de un remito QUE YA VOLVIÓ SELLADO del supermercado, pero nunca se cargó al sistema cuando salió.',
    'Tenés que extraer en una sola pasada los datos esenciales del despacho + las cantidades del sellado.',
    'Devolvé un JSON con estos campos. Si un campo no se ve o no estás seguro, dejalo en null.',
    '— Datos del DESPACHO (preimpreso o tipeado):',
    '  "n_remito_ifco": string con formato "00015-XXXXXXXX" (preimpreso, esquina superior derecha)',
    '  "fecha_emision": string ISO "YYYY-MM-DD" — fecha del despacho',
    '  "empresa": string — la cadena de supermercado destinataria. Devolvé el valor EXACTO tal como aparece SOLO si coincide con uno de:',
    '    "CENCOSUD", "CARREFOUR (INC SA)", "COTO", "LA COOPERATIVA OBRERA", "LA ANONIMA", "CHANGO MAS (DORINKA)".',
    '    Si lo que ves se parece a uno de esos pero está abreviado o mal escrito, devolvé el de la lista que mejor matchea. Si no matchea ninguno, devolvé el texto literal.',
    '  "cantidad_despachada": número entero — total de cajones (campo "TOTAL CAJAS" o equivalente)',
    '  "producto": string — descripción del producto cargado',
    '— Cantidades del SELLADO (manuscritos o sello del súper):',
    '  "cantidad_recibida": número entero — cuántos cajones aceptó el súper (si no se aclara y no hay rechazo, asumí cantidad_despachada)',
    '  "cantidad_rechazada": número entero (0 si no hay rechazo)',
    'NO leas ni extraigas: sucursal, transportista, encargado del proveedor, encargado del súper, fecha de sellado, ni otros datos adicionales.',
    'Respondé SOLO el objeto JSON, sin texto adicional ni markdown.'
  ].join('\n');

  let prompt;
  if (tipo === 'sellado') prompt = promptSellado;
  else if (tipo === 'completo') prompt = promptCompleto;
  else prompt = promptDespacho;
  const escaneo_path = '/data/ifco/' + req.file.filename;

  try {
    const message = await client.messages.create({
      model: OCR_MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: dataB64 } },
          { type: 'text',  text: prompt }
        ]
      }]
    });
    const textoRespuesta = (message.content || [])
      .filter(function(b){ return b.type === 'text'; })
      .map(function(b){ return b.text; })
      .join('\n');
    const datos = _extraerJson(textoRespuesta);
    if (!datos) {
      return res.status(502).json({
        error: 'OCR no devolvió JSON válido',
        respuesta_cruda: textoRespuesta,
        escaneo_path: escaneo_path
      });
    }
    res.json({
      ok: true,
      tipo: tipo,
      datos: datos,
      escaneo_path: escaneo_path,
      tokens: message.usage || null
    });
  } catch(e) {
    console.error('[IFCO][OCR] Error llamando a Claude:', e);
    res.status(502).json({ error: 'Error en OCR: ' + (e.message || 'desconocido'), escaneo_path: escaneo_path });
  }
});

// MATCH-SELLADO: OCR de foto de remito sellado + busca en DB por N° remito
// Devuelve uno de:
//   { ok:true, accion:'sellar',     remito:{...}, escaneo_path, n_remito_ifco }     ← match con remito en estado 'despachado'
//   { ok:true, accion:'crear_nuevo', datos_ocr:{...}, escaneo_path, n_remito_ifco }  ← no hay match, hacer flujo de creación completa
//   { ok:false, accion:'bloqueado', estado:'sellado'|'presentado', remito:{...}, n_remito_ifco }  ← N° ya existe pero no se puede sellar
//   { ok:false, error:'...' }
router.post('/ocr/match-sellado', upload.single('foto'), async function(req, res) {
  if (!OCR_ENABLED) return res.status(503).json({ error: 'OCR no habilitado en el servidor' });
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo "foto"' });
  const client = await _getAnthropic();
  if (!client) return res.status(503).json({ error: 'OCR no disponible (sin SDK o sin API key)' });

  const escaneo_path = '/data/ifco/' + req.file.filename;
  const filePath = path.join(UPLOAD_DIR, req.file.filename);
  let dataB64, mediaType;
  try {
    const buf = fs.readFileSync(filePath);
    dataB64 = buf.toString('base64');
    mediaType = req.file.mimetype || 'image/jpeg';
  } catch(e) {
    return res.status(500).json({ error: 'No se pudo leer el archivo: ' + e.message });
  }

  // Prompt mínimo: solo el N° de remito
  const promptLookup = [
    'Sos un asistente que lee remitos IFCO emitidos por SAN GERONIMO SA en Argentina.',
    'Necesito UN SOLO dato de esta foto: el número de remito IFCO preimpreso.',
    'Devolvé un JSON con un único campo:',
    '  "n_remito_ifco": string con formato "00015-XXXXXXXX" (preimpreso, esquina superior derecha del remito)',
    'Si no podés leer el número con confianza, devolvé null en ese campo.',
    'Respondé SOLO el objeto JSON, sin texto adicional ni markdown.'
  ].join('\n');

  let nRemito = null;
  try {
    const message = await client.messages.create({
      model: OCR_MODEL,
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: dataB64 } },
          { type: 'text',  text: promptLookup }
        ]
      }]
    });
    const texto = (message.content || []).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    const datos = _extraerJson(texto);
    nRemito = (datos && datos.n_remito_ifco) ? String(datos.n_remito_ifco).trim() : null;
  } catch(e) {
    console.error('[IFCO][match-sellado] Error en OCR:', e);
    return res.status(502).json({ error: 'Error en OCR: ' + (e.message || 'desconocido'), escaneo_path: escaneo_path });
  }

  if (!nRemito) {
    return res.json({
      ok: false,
      accion: 'sin_numero',
      error: 'No se pudo leer el N° de remito de la foto',
      escaneo_path: escaneo_path
    });
  }

  // Buscar remito activo por número
  const remito = db.prepare(`
    SELECT r.*, p.nombre AS proveedor_origen_nombre
    FROM ifco_remitos_super r
    LEFT JOIN proveedores p ON r.proveedor_origen_id = p.id
    WHERE r.n_remito_ifco = ? AND r.eliminado_en IS NULL
    LIMIT 1
  `).get(nRemito);

  if (!remito) {
    // No hay match → flujo de creación: pedir OCR completo en una segunda pasada
    // Devolvemos solo el N° leído; el frontend va a llamar al OCR completo a continuación
    return res.json({
      ok: true,
      accion: 'crear_nuevo',
      n_remito_ifco: nRemito,
      escaneo_path: escaneo_path
    });
  }

  // Hay match — depende del estado
  if (remito.estado === 'sellado' || remito.estado === 'presentado') {
    return res.json({
      ok: false,
      accion: 'bloqueado',
      estado: remito.estado,
      n_remito_ifco: nRemito,
      remito: remito,
      escaneo_path: escaneo_path,
      error: 'El remito ' + nRemito + ' ya está en estado "' + remito.estado + '". No se puede volver a sellar desde este flujo.'
    });
  }

  // Estado 'despachado' → listo para sellar
  return res.json({
    ok: true,
    accion: 'sellar',
    n_remito_ifco: nRemito,
    remito: remito,
    escaneo_path: escaneo_path
  });
});

export default router;
