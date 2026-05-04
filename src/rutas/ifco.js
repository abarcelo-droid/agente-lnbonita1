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
      (SELECT COUNT(*) FROM ifco_remitos_super r WHERE r.talonario_id = t.id) AS usados_count
    FROM ifco_talonarios t
    ORDER BY t.activo DESC, t.creado_en DESC
  `).all();
  res.json(rows);
});

router.get('/talonarios/activo', function(req, res) {
  const t = db.prepare("SELECT * FROM ifco_talonarios WHERE activo = 1 LIMIT 1").get();
  if (!t) return res.json({ talonario: null, proximo: null, disponibles: 0 });

  const ultimo = db.prepare(`
    SELECT n_remito_ifco FROM ifco_remitos_super
    WHERE talonario_id = ? ORDER BY id DESC LIMIT 1
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
  if (d.activo) db.prepare("UPDATE ifco_talonarios SET activo = 0").run();
  const r = db.prepare(`
    INSERT INTO ifco_talonarios (serie, numero_desde, numero_hasta, cai, vto_cai, activo, notas)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(d.serie, parseInt(d.numero_desde), parseInt(d.numero_hasta),
         d.cai || null, d.vto_cai || null, d.activo ? 1 : 0, d.notas || null);
  res.json({ id: r.lastInsertRowid });
});

router.patch('/talonarios/:id', function(req, res) {
  const d = req.body || {};
  if (d.activo === 1 || d.activo === true) {
    db.prepare("UPDATE ifco_talonarios SET activo = 0").run();
  }
  const sets = [], params = { id: req.params.id };
  if (d.activo !== undefined) { sets.push("activo = @activo"); params.activo = d.activo ? 1 : 0; }
  if (d.cai     !== undefined) { sets.push("cai = @cai");         params.cai     = d.cai; }
  if (d.vto_cai !== undefined) { sets.push("vto_cai = @vto_cai"); params.vto_cai = d.vto_cai; }
  if (d.notas   !== undefined) { sets.push("notas = @notas");     params.notas   = d.notas; }
  if (sets.length === 0) return res.json({ ok: true });
  db.prepare(`UPDATE ifco_talonarios SET ${sets.join(", ")} WHERE id = @id`).run(params);
  res.json({ ok: true });
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
  let q = "SELECT * FROM ifco_remitos_super WHERE 1=1";
  const p = [];
  if (f.estado)     { q += " AND estado = ?";        p.push(f.estado); }
  if (f.cliente_id) { q += " AND cliente_id = ?";    p.push(f.cliente_id); }
  if (f.desde)      { q += " AND fecha_emision >= ?"; p.push(f.desde); }
  if (f.hasta)      { q += " AND fecha_emision <= ?"; p.push(f.hasta); }
  if (f.search)     { q += " AND (n_remito_ifco LIKE ? OR empresa LIKE ?)"; p.push('%'+f.search+'%','%'+f.search+'%'); }
  q += " ORDER BY fecha_emision DESC, id DESC LIMIT 500";
  res.json(db.prepare(q).all(...p));
});

router.get('/remitos/:id', function(req, res) {
  const r = db.prepare("SELECT * FROM ifco_remitos_super WHERE id = ?").get(req.params.id);
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
  const dup = db.prepare("SELECT id FROM ifco_remitos_super WHERE n_remito_ifco = ?").get(d.n_remito_ifco);
  if (dup) return res.status(409).json({ error: 'Ya existe un remito con ese número' });

  // Foto: si el cliente la subió ahora con multer, esa gana. Si no, puede venir
  // en el body como escaneo_original_path (cuando ya se subió antes vía /ocr).
  let escaneo_original_path = null;
  if (req.file) {
    escaneo_original_path = '/data/ifco/' + req.file.filename;
  } else if (d.escaneo_original_path && /^\/data\/ifco\//.test(d.escaneo_original_path)) {
    escaneo_original_path = d.escaneo_original_path;
  }

  try {
    const r = db.prepare(`
      INSERT INTO ifco_remitos_super (
        n_remito_ifco, fecha_emision, cliente_id, cliente_telefono, empresa, sucursal,
        modelo, cantidad_despachada, producto, transportista,
        encargado_prov_apellido, encargado_prov_nombre, encargado_prov_dni,
        talonario_id, notas, usuario_id, estado, escaneo_original_path
      ) VALUES (
        @n_remito_ifco, @fecha_emision, @cliente_id, @cliente_telefono, @empresa, @sucursal,
        @modelo, @cantidad_despachada, @producto, @transportista,
        @encargado_prov_apellido, @encargado_prov_nombre, @encargado_prov_dni,
        @talonario_id, @notas, @usuario_id, 'despachado', @escaneo_original_path
      )
    `).run({
      n_remito_ifco:           d.n_remito_ifco,
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
      escaneo_original_path:   escaneo_original_path
    });
    res.json({ id: r.lastInsertRowid, n_remito_ifco: d.n_remito_ifco, escaneo_original_path: escaneo_original_path });
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

  db.prepare(`
    UPDATE ifco_remitos_super SET
      estado = 'sellado',
      fecha_sellado = @fecha_sellado,
      encargado_super_apellido = @encargado_super_apellido,
      encargado_super_nombre   = @encargado_super_nombre,
      encargado_super_dni      = @encargado_super_dni,
      cantidad_recibida        = @cantidad_recibida,
      cantidad_rechazada       = @cantidad_rechazada,
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

router.delete('/remitos/:id', function(req, res) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  db.prepare("UPDATE ifco_remitos_super SET estado = 'anulado' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// ENVÍOS A PROVEEDOR
// ════════════════════════════════════════════════════════════════════════════

router.get('/envios', function(req, res) {
  const f = req.query;
  let q = `
    SELECT e.*, p.nombre AS proveedor_nombre, p.razon_social AS proveedor_razon
    FROM ifco_envios_proveedor e
    LEFT JOIN proveedores p ON p.id = e.proveedor_id
    WHERE 1=1
  `;
  const p = [];
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

router.delete('/envios/:id', function(req, res) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  db.prepare("UPDATE ifco_envios_proveedor SET estado = 'anulado' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// MOVIMIENTOS PUNTUALES (retiros, pérdidas)
// ════════════════════════════════════════════════════════════════════════════

router.get('/movimientos', function(req, res) {
  const f = req.query;
  let q = "SELECT * FROM ifco_movimientos WHERE 1=1";
  const p = [];
  if (f.tipo)  { q += " AND tipo = ?";   p.push(f.tipo); }
  if (f.desde) { q += " AND fecha >= ?"; p.push(f.desde); }
  if (f.hasta) { q += " AND fecha <= ?"; p.push(f.hasta); }
  q += " ORDER BY fecha DESC, id DESC LIMIT 500";
  res.json(db.prepare(q).all(...p));
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

router.delete('/movimientos/:id', function(req, res) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  db.prepare("DELETE FROM ifco_movimientos WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// RESUMEN — stocks calculados + alertas + saldos por contraparte
// ════════════════════════════════════════════════════════════════════════════

router.get('/resumen', function(req, res) {
  const get = function(sql, ...p) { return (db.prepare(sql).get(...p) || {}).total || 0; };

  // Movimientos puntuales
  const retirado = get("SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_movimientos WHERE tipo='retiro'");
  const perdido  = get("SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_movimientos WHERE tipo='perdida'");

  // Envíos a proveedor — totales y pendientes
  const envios_totales = get(`
    SELECT COALESCE(SUM(cantidad_enviada),0) AS total
    FROM ifco_envios_proveedor WHERE estado IN ('enviado','parcial','recibido')
  `);
  const recepciones_prov = get(`
    SELECT COALESCE(SUM(cantidad_recibida),0) AS total
    FROM ifco_envios_proveedor WHERE estado IN ('recibido','parcial')
  `);
  const en_proveedores = get(`
    SELECT COALESCE(SUM(cantidad_enviada - COALESCE(cantidad_recibida,0)),0) AS total
    FROM ifco_envios_proveedor WHERE estado IN ('enviado','parcial')
  `);

  // Despachos a súper — totales y rechazos vueltos
  const despachos_totales = get(`
    SELECT COALESCE(SUM(cantidad_despachada),0) AS total
    FROM ifco_remitos_super WHERE estado IN ('despachado','sellado','presentado')
  `);
  const rechazos_vueltos = get(`
    SELECT COALESCE(SUM(cantidad_rechazada),0) AS total
    FROM ifco_remitos_super WHERE estado IN ('sellado','presentado')
  `);
  const en_transito = get(`
    SELECT COALESCE(SUM(cantidad_despachada),0) AS total
    FROM ifco_remitos_super WHERE estado = 'despachado'
  `);

  // PISO actual — balance de entradas y salidas en planta
  const piso = retirado - envios_totales + recepciones_prov - despachos_totales + rechazos_vueltos;
  const bajo_responsabilidad = piso + en_proveedores + en_transito;

  // Alertas — sellados >= 25 días sin presentar (urgente, vence a los 30)
  const urgentes_presentar = db.prepare(`
    SELECT id, n_remito_ifco, fecha_sellado, empresa, sucursal,
      cantidad_recibida, cantidad_rechazada,
      CAST(julianday('now','localtime') - julianday(fecha_sellado) AS INTEGER) AS dias
    FROM ifco_remitos_super
    WHERE estado = 'sellado'
      AND julianday('now','localtime') - julianday(fecha_sellado) >= 25
    ORDER BY fecha_sellado ASC
  `).all();

  // Despachos >= 30 días sin sellar
  const sin_sellar = db.prepare(`
    SELECT id, n_remito_ifco, fecha_emision, empresa, sucursal, cantidad_despachada,
      CAST(julianday('now','localtime') - julianday(fecha_emision) AS INTEGER) AS dias
    FROM ifco_remitos_super
    WHERE estado = 'despachado'
      AND julianday('now','localtime') - julianday(fecha_emision) >= 30
    ORDER BY fecha_emision ASC
  `).all();

  // Envíos a proveedor >= 15 días sin recibir
  const envios_vencidos = db.prepare(`
    SELECT e.id, e.n_remito_interno, e.fecha_envio, e.cantidad_enviada,
      p.nombre AS proveedor_nombre,
      CAST(julianday('now','localtime') - julianday(e.fecha_envio) AS INTEGER) AS dias
    FROM ifco_envios_proveedor e
    LEFT JOIN proveedores p ON p.id = e.proveedor_id
    WHERE e.estado = 'enviado'
      AND julianday('now','localtime') - julianday(e.fecha_envio) >= 15
    ORDER BY e.fecha_envio ASC
  `).all();

  // Estado del talonario activo
  const tal = db.prepare("SELECT * FROM ifco_talonarios WHERE activo = 1 LIMIT 1").get();
  let talonario_alerta = null, talonario_info = null;
  if (tal) {
    const u = db.prepare(`
      SELECT n_remito_ifco FROM ifco_remitos_super
      WHERE talonario_id = ? ORDER BY id DESC LIMIT 1
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

  // Saldos por cliente (qué supermercado tiene cuántos en tránsito o sin presentar)
  const por_cliente = db.prepare(`
    SELECT
      cliente_id, empresa,
      SUM(CASE WHEN estado='despachado' THEN cantidad_despachada ELSE 0 END) AS en_transito,
      SUM(CASE WHEN estado='sellado' THEN 1 ELSE 0 END) AS sellados_pendientes_count
    FROM ifco_remitos_super
    WHERE estado IN ('despachado','sellado')
    GROUP BY cliente_id, empresa
    HAVING en_transito > 0 OR sellados_pendientes_count > 0
    ORDER BY en_transito DESC, sellados_pendientes_count DESC
  `).all();

  // Saldos por proveedor (envíos pendientes)
  const por_proveedor = db.prepare(`
    SELECT
      e.proveedor_id, p.nombre AS proveedor_nombre,
      SUM(e.cantidad_enviada - COALESCE(e.cantidad_recibida,0)) AS pendiente,
      MIN(e.fecha_envio) AS desde
    FROM ifco_envios_proveedor e
    LEFT JOIN proveedores p ON p.id = e.proveedor_id
    WHERE e.estado IN ('enviado','parcial')
    GROUP BY e.proveedor_id, p.nombre
    HAVING pendiente > 0
    ORDER BY pendiente DESC
  `).all();

  res.json({
    stock: {
      piso: piso,
      en_proveedores: en_proveedores,
      en_transito: en_transito,
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

router.get('/saldo-proveedor/:id', function(req, res) {
  const provId = parseInt(req.params.id);
  if (!provId) return res.status(400).json({ error: 'ID proveedor inválido' });
  const r = db.prepare(`
    SELECT COALESCE(SUM(cantidad_enviada - COALESCE(cantidad_recibida,0)), 0) AS pendiente
    FROM ifco_envios_proveedor
    WHERE proveedor_id = ? AND estado IN ('enviado','parcial')
  `).get(provId);
  res.json({ proveedor_id: provId, pendiente: r.pendiente || 0 });
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
  if (['despacho','sellado'].indexOf(tipo) < 0) {
    return res.status(400).json({ error: 'tipo debe ser "despacho" o "sellado"' });
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
    '  "sucursal": string — sucursal o centro de distribución (ej. "Lugones", "CD Quilmes")',
    '  "cantidad_despachada": número entero — total de cajones (campo "TOTAL CAJAS" o equivalente)',
    '  "producto": string — descripción del producto cargado (ej. "mandarina malvina")',
    '  "transportista": string — nombre del transportista o empresa',
    '  "encargado_prov_apellido": string',
    '  "encargado_prov_nombre": string',
    '  "encargado_prov_dni": string',
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

  const prompt = tipo === 'sellado' ? promptSellado : promptDespacho;
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

export default router;
