// src/rutas/liquidaciones.js
// Módulo LIQUIDACIONES — abasto.
// Permite pegar el texto OCR/scan de una liquidación tipo "LA NIÑA BONITA", parsearlo
// con Claude para extraer los datos estructurados, editarlos manualmente, guardarlos
// en DB y generar el PDF formateado.

import express from 'express';
import path    from 'path';
import { fileURLToPath } from 'url';
import db from '../servicios/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Migración inline
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS liquidaciones (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    n_liquidacion   TEXT    NOT NULL,                -- "0002-00008366"
    fecha           TEXT    NOT NULL,                -- ISO YYYY-MM-DD
    fecha_ingreso   TEXT,                            -- ISO
    prov_codigo     TEXT,                            -- "PROV-00004245"
    remitente_nombre     TEXT,
    remitente_cuit       TEXT,
    remitente_localidad  TEXT,
    remitente_provincia  TEXT,
    remitente_cp         TEXT,
    remitente_iva        TEXT,
    iva_letra      TEXT DEFAULT 'A',
    articulos      TEXT,                              -- JSON [{articulo,nro_camion,cantidad,precio,importe}]
    mermas         TEXT,                              -- JSON [{descripcion,cantidad,fecha,tipo}]
    conceptos      TEXT,                              -- JSON [{concepto,porcentaje,importe}]
    neto           REAL DEFAULT 0,
    total          REAL DEFAULT 0,
    cai_numero       TEXT,
    cai_vencimiento  TEXT,
    codigo_barras    TEXT,
    texto_original   TEXT,
    eliminado_en     TEXT,
    creado_en        TEXT DEFAULT (datetime('now','localtime')),
    creado_por_id    INTEGER
  );
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_liq_fecha ON liquidaciones(fecha)"); } catch(_){}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_liq_n     ON liquidaciones(n_liquidacion)"); } catch(_){}

// ─────────────────────────────────────────────────────────────────────────────
// Auth (cookie LNB)
// ─────────────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  try {
    const cookie = req.cookies && req.cookies.lnb_user;
    if (!cookie) return res.status(401).json({ error: 'No autenticado' });
    req.user = JSON.parse(cookie);
    next();
  } catch(e) { res.status(401).json({ error: 'Sesión inválida' }); }
}
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Defaults LNB (datos del header del comprobante)
// ─────────────────────────────────────────────────────────────────────────────
const LNB = {
  razon:       'LA NIÑA BONITA — SAN GERÓNIMO S.A.',
  domicilio_l1: 'M.C.B.A NAVE 4 PUESTOS N° 2, 4 Y 6',
  domicilio_l2: '(1771) VILLA CELINA - PCIA. DE BS. AS.',
  cod_op:      'Cód. Operador 332537/1 - Tel. 4622-6663',
  email:       'e-mail: info@laniñabonita.ar',
  iva_cond:    'I.V.A. RESPONSABLE INSCRIPTO',
  cuit:        '30-67325443-4',
  cm:          '918-650940-1',
  inicio_act:  '01/06/1993',
  cod_cliente: '63'
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de número
// ─────────────────────────────────────────────────────────────────────────────
// "0002-00008366" → { punto:'0002', n:8366 }
function _splitNumLiq(n) {
  const m = String(n||'').match(/^(\d{4})-(\d+)$/);
  if (!m) return null;
  return { punto: m[1], n: parseInt(m[2]) };
}
function _formatNumLiq(punto, num) {
  return String(punto).padStart(4,'0') + '-' + String(num).padStart(8,'0');
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic SDK (lazy)
// ─────────────────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
let _anthropic = null;
async function _getAnthropic() {
  if (!ANTHROPIC_API_KEY) return null;
  if (_anthropic) return _anthropic;
  try {
    const mod = await import('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod.Anthropic;
    _anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    return _anthropic;
  } catch(e) {
    console.error('[LIQ] No se pudo cargar @anthropic-ai/sdk:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// jsPDF (lazy)
// ─────────────────────────────────────────────────────────────────────────────
let _jsPDF = null;
async function _getJsPDF() {
  if (_jsPDF) return _jsPDF;
  try {
    const mod = await import('jspdf');
    _jsPDF = mod.jsPDF || mod.default || mod;
    return _jsPDF;
  } catch(e) { console.error('[LIQ] jspdf no disponible:', e.message); return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /proximo-numero — sugiere el N° siguiente
// ─────────────────────────────────────────────────────────────────────────────
router.get('/proximo-numero', function(req, res) {
  const ult = db.prepare(`
    SELECT n_liquidacion FROM liquidaciones
    WHERE eliminado_en IS NULL
    ORDER BY id DESC LIMIT 1
  `).get();
  let punto = '0002', sig = 1;
  if (ult) {
    const sp = _splitNumLiq(ult.n_liquidacion);
    if (sp) { punto = sp.punto; sig = sp.n + 1; }
  }
  res.json({ proximo: _formatNumLiq(punto, sig) });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /parse — recibe texto OCR, devuelve JSON estructurado (no guarda)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/parse', async function(req, res) {
  try {
    const texto = (req.body && req.body.texto || '').trim();
    if (!texto) return res.status(400).json({ error: 'Falta el texto' });

    const client = await _getAnthropic();
    if (!client) return res.status(503).json({ error: 'OCR/Claude no disponible en el servidor' });

    const prompt = [
      'Sos un asistente que extrae datos estructurados de comprobantes de liquidación de hortalizas.',
      'Te paso el texto crudo (escaneado/OCR) de una liquidación. Devolvé SOLO un JSON con esta estructura:',
      '{',
      '  "fecha": "YYYY-MM-DD",                    // fecha del comprobante',
      '  "fecha_ingreso": "YYYY-MM-DD",            // fecha de ingreso de la mercadería',
      '  "prov_codigo": "PROV-XXXXXXXX",           // código del proveedor (si aparece)',
      '  "remitente_nombre": "NOMBRE APELLIDO",',
      '  "remitente_cuit": "XX-XXXXXXXX-X",',
      '  "remitente_localidad": "string",',
      '  "remitente_provincia": "string",',
      '  "remitente_cp": "string",',
      '  "remitente_iva": "R.I." | "MONOTRIBUTO" | etc,',
      '  "iva_letra": "A" | "B" | "C",            // letra del comprobante',
      '  "articulos": [',
      '    { "articulo": "ZAPALLO ANCO ... BOLSON BOLSA", "nro_camion": "9902", "cantidad": 750, "precio": 4973.76, "importe": 3730316.78 }',
      '  ],',
      '  "mermas": [',
      '    { "descripcion": "ZAPALLO ANCO ... BOLSON", "cantidad": 18, "fecha": "YYYY-MM-DD", "tipo": "REPASO" }',
      '  ],',
      '  "conceptos": [',
      '    { "concepto": "IVA NETO",                     "porcentaje": 10.5, "importe":  391683.26 },',
      '    { "concepto": "Comision",                     "porcentaje": 12,   "importe": -447638.01 },',
      '    { "concepto": "IVA Comision",                 "porcentaje": 10.5, "importe":  -47001.99 },',
      '    { "concepto": "Descarga Ganadas Liquidaciones","porcentaje": null,"importe": -208562.01 },',
      '    { "concepto": "IVA",                          "porcentaje": 21,   "importe":  -43798.02 }',
      '  ],',
      '  "neto":  3730316.78,',
      '  "total": 3375000.00',
      '}',
      '',
      'Reglas:',
      '- Los números van como floats, sin separador de miles. Negativos cuando son descuentos.',
      '- Las fechas SIEMPRE en formato ISO YYYY-MM-DD.',
      '- Si un campo no se ve o no estás seguro, dejalo como null o array vacío.',
      '- NO inventes datos. NO incluyas texto fuera del JSON.',
      '',
      '--- TEXTO A PARSEAR ---',
      texto,
      '--- FIN ---',
      'Devolvé SOLO el JSON, sin markdown ni explicaciones.'
    ].join('\n');

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });
    const txt = (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    // Extraer el JSON del texto
    const ini = txt.indexOf('{');
    const fin = txt.lastIndexOf('}');
    if (ini < 0 || fin < 0) throw new Error('La IA no devolvió JSON: ' + txt.slice(0, 200));
    const json = JSON.parse(txt.slice(ini, fin + 1));
    res.json({ ok: true, datos: json });
  } catch(e) {
    console.error('[LIQ][parse] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — lista
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', function(req, res) {
  const rows = db.prepare(`
    SELECT id, n_liquidacion, fecha, remitente_nombre, neto, total, creado_en
    FROM liquidaciones
    WHERE eliminado_en IS NULL
    ORDER BY fecha DESC, id DESC
    LIMIT 500
  `).all();
  res.json(rows);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — detalle
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', function(req, res) {
  const r = db.prepare("SELECT * FROM liquidaciones WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  // Parsear JSON storage
  try { r.articulos = JSON.parse(r.articulos || '[]'); } catch(_){ r.articulos = []; }
  try { r.mermas    = JSON.parse(r.mermas    || '[]'); } catch(_){ r.mermas = []; }
  try { r.conceptos = JSON.parse(r.conceptos || '[]'); } catch(_){ r.conceptos = []; }
  res.json(r);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST / — crea
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', function(req, res) {
  const d = req.body || {};
  if (!d.n_liquidacion) return res.status(400).json({ error: 'Falta N° de liquidación' });
  if (!d.fecha)         return res.status(400).json({ error: 'Falta la fecha' });

  // Verificar duplicado
  const dup = db.prepare("SELECT id FROM liquidaciones WHERE n_liquidacion = ? AND eliminado_en IS NULL").get(d.n_liquidacion);
  if (dup) return res.status(400).json({ error: 'Ya existe una liquidación con N° ' + d.n_liquidacion });

  try {
    const r = db.prepare(`
      INSERT INTO liquidaciones (
        n_liquidacion, fecha, fecha_ingreso, prov_codigo,
        remitente_nombre, remitente_cuit, remitente_localidad, remitente_provincia, remitente_cp, remitente_iva,
        iva_letra, articulos, mermas, conceptos, neto, total,
        cai_numero, cai_vencimiento, codigo_barras, texto_original, creado_por_id
      ) VALUES (?, ?, ?, ?,  ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?)
    `).run(
      d.n_liquidacion, d.fecha, d.fecha_ingreso || null, d.prov_codigo || null,
      d.remitente_nombre || null, d.remitente_cuit || null, d.remitente_localidad || null,
      d.remitente_provincia || null, d.remitente_cp || null, d.remitente_iva || null,
      d.iva_letra || 'A',
      JSON.stringify(d.articulos || []),
      JSON.stringify(d.mermas    || []),
      JSON.stringify(d.conceptos || []),
      parseFloat(d.neto)  || 0,
      parseFloat(d.total) || 0,
      d.cai_numero || null, d.cai_vencimiento || null, d.codigo_barras || null,
      d.texto_original || null,
      (req.user && req.user.id) || null
    );
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id — soft delete
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', function(req, res) {
  db.prepare("UPDATE liquidaciones SET eliminado_en = datetime('now','localtime') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/pdf — genera el PDF lo más fiel al original posible
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/pdf', async function(req, res) {
  try {
    const r = db.prepare("SELECT * FROM liquidaciones WHERE id = ?").get(req.params.id);
    if (!r) return res.status(404).json({ error: 'No encontrado' });
    try { r.articulos = JSON.parse(r.articulos || '[]'); } catch(_){ r.articulos = []; }
    try { r.mermas    = JSON.parse(r.mermas    || '[]'); } catch(_){ r.mermas = []; }
    try { r.conceptos = JSON.parse(r.conceptos || '[]'); } catch(_){ r.conceptos = []; }

    const jsPDF = await _getJsPDF();
    if (!jsPDF) return res.status(503).json({ error: 'jspdf no disponible' });

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, H = 297, M = 12;
    const right = W - M;

    // Helpers
    const setTxt = (sz, bold) => { doc.setFontSize(sz); doc.setFont('helvetica', bold?'bold':'normal'); };
    const fechaFmt = (s) => { if (!s) return ''; const p = String(s).split('-'); return p.length===3 ? p[2]+'/'+p[1]+'/'+p[0] : s; };
    const moneyFmt = (n) => {
      if (n == null || isNaN(n)) return '';
      const neg = n < 0;
      const abs = Math.abs(n);
      const s = abs.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return (neg ? '-' : '') + s;
    };

    // ── HEADER (marco superior con dos columnas) ──
    // Marco general
    doc.setLineWidth(0.5);
    doc.rect(M, M, W - 2*M, H - 2*M);

    // Línea horizontal entre header y cuerpo
    const headerH = 38;
    doc.line(M, M + headerH, right, M + headerH);
    // Línea vertical que divide header en dos
    const midX = M + (W - 2*M) * 0.45;
    doc.line(midX, M, midX, M + headerH);

    // LADO IZQUIERDO HEADER: razón social + datos
    setTxt(16, true);
    doc.text('LA NIÑA BONITA', M + 4, M + 9);
    setTxt(8, false);
    doc.text('SAN GERÓNIMO S.A.', M + 4, M + 13);
    setTxt(7, false);
    doc.text(LNB.domicilio_l1, M + 4, M + 19);
    doc.text(LNB.domicilio_l2, M + 4, M + 23);
    doc.text(LNB.cod_op, M + 4, M + 27);
    doc.text(LNB.email, M + 4, M + 31);
    setTxt(8, true);
    doc.text(LNB.iva_cond, M + 4, M + 36);

    // CENTRO HEADER: cuadradito con la "A"
    const ax = midX + 4, ay = M + 6;
    doc.setLineWidth(0.4);
    doc.rect(ax, ay, 14, 14);
    setTxt(20, true);
    doc.text(r.iva_letra || 'A', ax + 5, ay + 11);
    setTxt(7, false);
    doc.text('COD. N° ' + LNB.cod_cliente, ax, ay - 1);

    // Datos fiscales LNB
    const fx = midX + 22;
    setTxt(7, false);
    doc.text('C.U.I.T. N°: ' + LNB.cuit, fx, M + 12);
    doc.text('Convenio Multilateral: ' + LNB.cm, fx, M + 16);
    doc.text('Fecha Inicio de Actividades: ' + LNB.inicio_act, fx, M + 20);

    // LADO DERECHO HEADER: título LIQUIDACIÓN + N° + fecha
    setTxt(20, true);
    doc.text('LIQUIDACIÓN', right - 4, M + 9, { align: 'right' });
    setTxt(13, true);
    doc.text('N° ' + (r.n_liquidacion || ''), right - 4, M + 17, { align: 'right' });
    setTxt(8, false);
    doc.text('Fecha', right - 30, M + 27, { align: 'right' });
    doc.rect(right - 28, M + 28, 24, 6);
    setTxt(10, false);
    doc.text(fechaFmt(r.fecha), right - 16, M + 33, { align: 'center' });

    // ── REMITENTE ──
    let y = M + headerH + 6;
    setTxt(8, true);
    doc.text('REMITENTE:', M + 4, y);
    y += 5;
    setTxt(10, false);
    doc.text((r.remitente_nombre || '').toUpperCase(), M + 16, y);
    y += 5;
    doc.text((r.remitente_localidad || '').toUpperCase(), M + 4, y);
    doc.text('CP: ' + (r.remitente_cp || '0'), M + 50, y);
    doc.text((r.remitente_provincia || '').toUpperCase(), M + 80, y);
    setTxt(9, false);
    doc.text(r.remitente_iva || 'R.I.', midX + 6, y - 5);
    doc.text(r.remitente_cuit || '', midX + 6, y);

    y += 8;
    setTxt(9, false);
    doc.text('Fecha de Ingreso :', M + 4, y);
    doc.text(fechaFmt(r.fecha_ingreso), M + 40, y);
    doc.text(r.prov_codigo || '', M + 80, y);

    // ── TABLA ARTÍCULOS ──
    y += 8;
    const tblTop = y;
    doc.setLineWidth(0.4);
    // Encabezado
    setTxt(8, true);
    const cols = { art: M + 4, cam: M + 100, cant: M + 130, pre: M + 152, imp: right - 4 };
    doc.text('Artículo',     cols.art,  y);
    doc.text('Nro Camion',   cols.cam,  y);
    doc.text('Cantidad',     cols.cant, y);
    doc.text('P.',           cols.pre,  y);
    doc.text('Importe',      cols.imp,  y, { align: 'right' });
    y += 2;
    doc.line(M, y, right, y); // línea bajo encabezado
    y += 4;

    setTxt(9, false);
    for (const a of r.articulos) {
      doc.text(String(a.articulo || ''),      cols.art,  y);
      doc.text(String(a.nro_camion || ''),    cols.cam,  y);
      doc.text(String(a.cantidad || ''),      cols.cant, y);
      doc.text(moneyFmt(a.precio),            cols.pre,  y);
      doc.text('$ ' + moneyFmt(a.importe),    cols.imp,  y, { align: 'right' });
      y += 5;
    }

    // ── NETO (fila destacada) ──
    y += 3;
    setTxt(9, true);
    doc.text('Neto:', cols.pre - 4, y, { align: 'right' });
    doc.text('$ ' + moneyFmt(r.neto || 0), cols.imp, y, { align: 'right' });

    // ── MERMAS ──
    y += 8;
    setTxt(9, true);
    doc.text('Mermas', M + 4, y);
    y += 5;
    setTxt(8, false);
    for (const m of r.mermas) {
      doc.text(String(m.descripcion || ''),                M + 8, y);
      doc.text(String(m.cantidad || ''),                   M + 90, y);
      doc.text(fechaFmt(m.fecha),                          M + 105, y);
      doc.text(String(m.tipo || ''),                       M + 130, y);
      y += 4;
    }

    // ── CONCEPTOS ──
    y += 6;
    setTxt(9, false);
    for (const c of r.conceptos) {
      doc.text(String(c.concepto || ''), M + 60, y);
      if (c.porcentaje != null) doc.text(String(c.porcentaje), M + 130, y);
      doc.text(moneyFmt(c.importe), cols.imp, y, { align: 'right' });
      y += 5;
    }

    // ── TOTAL (al pie del cuerpo) ──
    const totalY = H - M - 50;
    setTxt(11, true);
    doc.text('TOTAL:', M + 130, totalY);
    doc.text('$ ' + moneyFmt(r.total || 0), right - 4, totalY, { align: 'right' });

    // ── PIE: CAI + barras (si hay) ──
    setTxt(7, false);
    doc.text('Original: Blanco', M + 4, H - M - 16);
    doc.text('Duplicado: Color',  M + 4, H - M - 12);
    doc.text('Impreso en AG Diseño e Impresiones de Analía García', M + 30, H - M - 16);
    doc.text('B° Parque Sur casa 5 Mza E | Cel.: 2644002300 - C.P 5425', M + 30, H - M - 12);
    doc.text('CUIT: 27-25939792-3  del 0002-00008201 al 00009200 - Imp. DIC. 2025', M + 30, H - M - 8);

    if (r.cai_numero) {
      setTxt(9, true);
      doc.text('C.A.I N° ' + r.cai_numero, right - 4, H - M - 14, { align: 'right' });
      doc.text('Fecha Vto: ' + fechaFmt(r.cai_vencimiento), right - 4, H - M - 8, { align: 'right' });
    }

    // Devolver PDF
    const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="liquidacion-' + (r.n_liquidacion || r.id) + '.pdf"');
    res.send(pdfBuffer);
  } catch(e) {
    console.error('[LIQ][pdf] error:', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
