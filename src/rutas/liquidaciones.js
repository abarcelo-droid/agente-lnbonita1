// src/rutas/liquidaciones.js
// Módulo LIQUIDACIONES — abasto.
// Permite pegar el texto OCR/scan de una liquidación tipo "LA NIÑA BONITA", parsearlo
// con Claude para extraer los datos estructurados, editarlos manualmente, guardarlos
// en DB y generar el PDF formateado.

import express from 'express';
import path    from 'path';
import fs      from 'fs';
import { fileURLToPath } from 'url';
import db from '../servicios/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Logo LNB — se carga una sola vez y se cachea en base64
// undefined = no se intentó, null = falló, string = OK
let _logoB64 = undefined;
function _getLogo() {
  if (_logoB64 !== undefined) return _logoB64;
  try {
    const p = path.join(__dirname, '..', 'logo.jpg');
    const buf = fs.readFileSync(p);
    _logoB64 = 'data:image/jpeg;base64,' + buf.toString('base64');
    console.log('[LIQ] Logo cargado desde', p, '(', buf.length, 'bytes)');
    return _logoB64;
  } catch(e) {
    console.error('[LIQ] No se pudo cargar logo.jpg:', e.message);
    _logoB64 = null;
    return null;
  }
}
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
// Code128 (subset C) — implementación mínima para dibujar el código de barras
// ─────────────────────────────────────────────────────────────────────────────
const _C128 = [
  "11011001100","11001101100","11001100110","10010011000","10010001100",
  "10001001100","10011001000","10011000100","10001100100","11001001000",
  "11001000100","11000100100","10110011100","10011011100","10011001110",
  "10111001100","10011101100","10011100110","11001110010","11001011100",
  "11001001110","11011100100","11001110100","11101101110","11101001100",
  "11100101100","11100100110","11101100100","11100110100","11100110010",
  "11011011000","11011000110","11000110110","10100011000","10001011000",
  "10001000110","10110001000","10001101000","10001100010","11010001000",
  "11000101000","11000100010","10110111000","10110001110","10001101110",
  "10111011000","10111000110","10001110110","11101110110","11010001110",
  "11000101110","11011101000","11011100010","11011101110","11101011000",
  "11101000110","11100010110","11101101000","11101100010","11100011010",
  "11101111010","11001000010","11110001010","10100110000","10100001100",
  "10010110000","10010000110","10000101100","10000100110","10110010000",
  "10110000100","10011010000","10011000010","10000110100","10000110010",
  "11000010010","11001010000","11110111010","11000010100","10001111010",
  "10100111100","10010111100","10010011110","10111100100","10011110100",
  "10011110010","11110100100","11110010100","11110010010","11011011110",
  "11011110110","11110110110","10101111000","10100011110","10001011110",
  "10111101000","10111100010","11110101000","11110100010","10111011110",
  "10111101110","11101011110","11110101110","11010000100","11010010000",
  "11010011100","1100011101011"
];
function _code128Cnums(s) {
  const digits = String(s||'').replace(/\D/g,'');
  if (!digits) return null;
  const padded = digits.length % 2 ? '0' + digits : digits;
  const vals = [105]; // START C
  for (let i=0; i<padded.length; i+=2) vals.push(parseInt(padded.substr(i,2),10));
  let chk = vals[0];
  for (let i=1; i<vals.length; i++) chk += i * vals[i];
  vals.push(chk % 103);
  vals.push(106); // STOP
  return vals;
}
function _drawBarcode(doc, code, x, y, moduleW, height) {
  if (!code) return;
  let cx = x;
  for (const v of code) {
    const pat = _C128[v];
    for (let i=0; i<pat.length; i++) {
      if (pat[i] === '1') doc.rect(cx, y, moduleW, height, 'F');
      cx += moduleW;
    }
  }
}

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
    const W = 210, H = 297;
    const M = 8;                 // margen exterior
    const L = M, R = W - M;      // bordes izq/der útiles
    const innerW = R - L;

    // Helpers
    const setF = (sz, bold) => { doc.setFontSize(sz); doc.setFont('helvetica', bold ? 'bold' : 'normal'); };
    const fechaFmt = (s) => { if (!s) return ''; const p = String(s).split('-'); return p.length===3 ? p[2]+'/'+p[1]+'/'+p[0] : s; };
    const moneyFmt = (n) => {
      if (n == null || isNaN(n)) return '';
      const neg = n < 0;
      const abs = Math.abs(parseFloat(n));
      const s = abs.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return (neg ? '-' : '') + s;
    };
    const dollarFmt = (n) => '$ ' + moneyFmt(n);

    // ═══════════════════════════════════════════════════════════════════════
    // MARCO GENERAL (bordes redondeados)
    // ═══════════════════════════════════════════════════════════════════════
    doc.setLineWidth(0.6);
    doc.setDrawColor(0);
    doc.roundedRect(L, M, innerW, H - 2*M, 3, 3);

    // ═══════════════════════════════════════════════════════════════════════
    // HEADER — 3 columnas separadas por líneas verticales
    // ═══════════════════════════════════════════════════════════════════════
    const hY = M;
    const hH = 36;
    const hBot = hY + hH;
    // Anchos de columnas (rebalanceados para que los datos fiscales no se desborden)
    const colA_w = innerW * 0.40;     // logo + datos LNB
    const colB_w = innerW * 0.32;     // cuadradito A + datos fiscales
    const colA_x = L;
    const colB_x = L + colA_w;
    const colC_x = L + colA_w + colB_w;
    // Líneas divisoras del header (verticales)
    doc.setLineWidth(0.4);
    doc.line(colB_x, hY, colB_x, hBot);
    doc.line(colC_x, hY, colC_x, hBot);
    // Línea horizontal bajo el header
    doc.line(L, hBot, R, hBot);

    // ── COL A: Logo + dirección
    const logoData = _getLogo();
    if (logoData) {
      // Logo en imagen — ancho 55mm, alto 14mm
      try { doc.addImage(logoData, 'JPEG', colA_x + 3, hY + 1, 55, 14); }
      catch(e) {
        console.error('[LIQ] addImage falló:', e.message);
        setF(18, true);
        doc.text('LA NIÑA BONITA', colA_x + 3, hY + 8);
      }
    } else {
      // Fallback al texto si no hay logo
      setF(18, true);
      doc.text('LA NIÑA BONITA', colA_x + 3, hY + 8);
    }
    setF(8.5, false);
    doc.text('SAN GERÓNIMO S.A.', colA_x + 3, hY + 17.5);
    setF(7.2, false);
    doc.text(LNB.domicilio_l1, colA_x + 3, hY + 21.5);
    doc.text(LNB.domicilio_l2, colA_x + 3, hY + 24.5);
    doc.text(LNB.cod_op,       colA_x + 3, hY + 27.5);
    doc.text(LNB.email,        colA_x + 3, hY + 30.5);
    setF(8.5, true);
    doc.text(LNB.iva_cond,     colA_x + 3, hY + 34.5);

    // ── COL B: cuadradito A grande centrado + datos fiscales debajo
    setF(7, false);
    doc.text('COD. N° ' + LNB.cod_cliente, colB_x + 3, hY + 4);
    // Cuadradito A — centrado horizontalmente en la columna
    const aSz = 14;
    const aX = colB_x + (colB_w - aSz) / 2;
    const aY = hY + 6.5;
    doc.setLineWidth(0.5);
    doc.rect(aX, aY, aSz, aSz);
    setF(22, true);
    doc.text(r.iva_letra || 'A', aX + aSz/2, aY + aSz - 2.5, { align: 'center' });
    // Datos fiscales LNB — DEBAJO del cuadradito, centrados, font compacto
    setF(7, false);
    const fY = aY + aSz + 3;
    const fXc = colB_x + colB_w / 2;
    doc.text('C.U.I.T. N°: ' + LNB.cuit,            fXc, fY,     { align: 'center' });
    doc.text('Conv. Multilateral: ' + LNB.cm,       fXc, fY + 3.5, { align: 'center' });
    doc.text('Inicio Activ.: ' + LNB.inicio_act,    fXc, fY + 7,   { align: 'center' });

    // ── COL C: N° de liquidación + Fecha (sin "LIQUIDACIÓN")
    setF(16, true);
    doc.text('N° ' + (r.n_liquidacion || ''), R - 4, hY + 11, { align: 'right' });
    setF(8.5, false);
    doc.text('Fecha', R - 18, hY + 22, { align: 'center' });
    doc.setLineWidth(0.4);
    doc.roundedRect(R - 33, hY + 23.5, 30, 7, 1.5, 1.5);
    setF(11, false);
    doc.text(fechaFmt(r.fecha), R - 18, hY + 28.5, { align: 'center' });

    // ═══════════════════════════════════════════════════════════════════════
    // REMITENTE
    // ═══════════════════════════════════════════════════════════════════════
    let y = hBot + 5;
    setF(9.5, true);
    doc.text('REMITENTE:', L + 3, y);
    y += 5.5;
    setF(11, false);
    doc.text((r.remitente_nombre || '').toUpperCase(), L + 18, y);
    setF(10, false);
    doc.text(r.remitente_iva || 'R.I.', L + innerW * 0.65, y);
    y += 5.5;
    setF(10, false);
    doc.text((r.remitente_localidad || '').toUpperCase(), L + 3, y);
    doc.text('CP: ' + (r.remitente_cp || '0'),            L + 50, y);
    doc.text((r.remitente_provincia || '').toUpperCase(), L + 78, y);
    doc.text(r.remitente_cuit || '',                       L + innerW * 0.65, y);

    y += 7;
    setF(10, false);
    doc.text('Fecha de Ingreso :', L + 3, y);
    doc.text(fechaFmt(r.fecha_ingreso), L + 42, y);
    doc.text(r.prov_codigo || '', L + 80, y);

    // ═══════════════════════════════════════════════════════════════════════
    // TABLA DE ARTÍCULOS
    // ═══════════════════════════════════════════════════════════════════════
    y += 6;
    const tblTop = y;
    const cArt  = L + 3;
    const cCam  = L + innerW * 0.46;
    const cCant = L + innerW * 0.62;
    const cPre  = L + innerW * 0.76;
    const cImp  = R - 3;

    doc.setLineWidth(0.4);
    doc.line(L, y - 1, R, y - 1);   // línea superior tabla
    setF(9, true);
    doc.text('Articulo',   cArt,  y + 4);
    doc.text('Nro Camion', cCam,  y + 4);
    doc.text('Cantidad',   cCant, y + 4);
    doc.text('P.',         cPre,  y + 4);
    doc.text('Importe',    cImp,  y + 4, { align: 'right' });
    y += 6;
    doc.line(L, y, R, y);
    y += 4;

    setF(10, false);
    for (const a of r.articulos) {
      doc.text(String(a.articulo || ''),    cArt,  y);
      doc.text(String(a.nro_camion || ''),  cCam,  y);
      doc.text(String(a.cantidad || ''),    cCant, y);
      doc.text(moneyFmt(a.precio),          cPre,  y);
      doc.text(dollarFmt(a.importe),        cImp,  y, { align: 'right' });
      y += 5;
    }

    // NETO (alineado a la derecha)
    y += 4;
    setF(10.5, true);
    doc.text('Neto:',           cPre - 5, y, { align: 'right' });
    doc.text(dollarFmt(r.neto), cImp,     y, { align: 'right' });

    // ═══════════════════════════════════════════════════════════════════════
    // MERMAS
    // ═══════════════════════════════════════════════════════════════════════
    y += 9;
    setF(10, true);
    doc.setLineWidth(0.2);
    doc.text('Mermas', L + 3, y);
    doc.line(L + 3, y + 0.5, L + 18, y + 0.5);  // subrayado
    y += 5;
    setF(9, false);
    for (const m of r.mermas) {
      doc.text(String(m.descripcion || ''),  L + 8,  y);
      doc.text(String(m.cantidad || ''),     L + 95, y, { align: 'right' });
      doc.text(fechaFmt(m.fecha),            L + 105, y);
      doc.text(String(m.tipo || ''),         L + 130, y);
      y += 4.2;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONCEPTOS (IVA, comisión, etc.)
    // ═══════════════════════════════════════════════════════════════════════
    y += 6;
    setF(10, false);
    const cConDesc = L + 65;
    const cConPct  = L + 130;
    const cConImp  = R - 3;
    for (const c of r.conceptos) {
      doc.text(String(c.concepto || ''), cConDesc, y);
      if (c.porcentaje != null && c.porcentaje !== '') {
        doc.text(String(c.porcentaje), cConPct, y);
      }
      doc.text(moneyFmt(c.importe), cConImp, y, { align: 'right' });
      y += 5;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TOTAL (al pie del cuerpo, antes del barcode)
    // ═══════════════════════════════════════════════════════════════════════
    const totalY = H - M - 60;
    setF(13, true);
    doc.text('TOTAL:',             cConPct, totalY);
    doc.text(dollarFmt(r.total),   cImp,    totalY, { align: 'right' });

    // (sección de código de barras removida)

    // ═══════════════════════════════════════════════════════════════════════
    // PIE — Cartel "documento no válido"
    // ═══════════════════════════════════════════════════════════════════════
    const carY = H - M - 20;
    doc.setLineWidth(0.5);
    doc.setFillColor(245, 245, 245);
    doc.roundedRect(L + 4, carY, innerW - 8, 14, 2, 2, 'FD');
    setF(10, true);
    doc.text('DOCUMENTO NO VÁLIDO PARA PRESENTACIÓN IMPOSITIVA, ES SOLO DE CARÁCTER INFORMATIVO.',
             L + innerW/2, carY + 5.5, { align: 'center' });
    doc.text('LAS LIQUIDACIONES SERÁN ENTREGADAS EN FÍSICO.',
             L + innerW/2, carY + 11, { align: 'center' });

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
