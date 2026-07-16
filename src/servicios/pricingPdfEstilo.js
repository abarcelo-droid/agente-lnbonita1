// ─────────────────────────────────────────────────────────────────────────────
// Estilo institucional LNB para los PDFs de Pricing (fuente única de verdad).
// Extraído del PDF "Disponible Piso" (que ya tenía el formato bueno) para que los 4
// PDFs por tipo de cliente (May A / May MCBA / Min MCBA / Min Entrega) lo compartan.
// Todo devuelve fragmentos HTML; el ensamblado final (documento()) los une con ''
// EXACTAMENTE como lo hacía el Piso inline, para que su salida quede byte-idéntica.
// ─────────────────────────────────────────────────────────────────────────────

const LOGO_URL = 'https://agente-lnbonita1-production.up.railway.app/static/logo.jpg';

// Paleta del Piso (azul institucional + tierras). Hex exactos, para no divergir.
export const PALETA = {
  primario:    '#0f2540',   // azul header/th/precios
  primarioHov: '#1a3a6e',
  texto:       '#2c1810',
  textoSuave:  '#7a6055',
  borde:       '#e8ddd0',
  catBg:       '#e8f0f8',
  footer:      '#b09080',
  mncBg:       '#7f1d1d',
  mncTh:       '#fee2e2',
};

// CSS compartido (idéntico, línea por línea, al del Piso). Se une con '' → una sola
// cadena; cada regla es autocontenida, así que el separador vacío no las mezcla.
export function estilosCss() {
  return [
    '@page{size:A4 portrait!important;margin:15mm}',
    'html,body{width:100%;max-width:210mm}',
    'body{font-family:Arial,sans-serif;font-size:11px;color:#2c1810;margin:0;padding:0}',
    '.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:14px;border-bottom:3px solid #0f2540}',
    '.logo-img{height:56px;object-fit:contain}',
    '.header-right{text-align:right}',
    '.header-sub{font-size:11px;color:#7a6055;margin-top:2px}',
    'table{width:100%;border-collapse:collapse;margin-top:8px}',
    'th{padding:8px 10px;background:#0f2540;color:#fff;text-align:left;font-size:10px;text-transform:uppercase;white-space:nowrap}',
    'th.num{text-align:right}',
    'td{padding:7px 10px;border-bottom:1px solid #e8ddd0;vertical-align:top;font-size:12px}',
    'td.num{text-align:right;font-weight:600;color:#0f2540;font-variant-numeric:tabular-nums}',
    'tr.cat td{background:#e8f0f8;font-size:10px;font-weight:700;color:#0f2540;text-transform:uppercase;padding:6px 10px;letter-spacing:.05em}',
    '.cons-badge{display:inline-block;background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:3px;font-size:9px;padding:0 4px;margin-left:4px;font-weight:700;vertical-align:middle}',
    '.prox-badge{display:inline-block;background:#dbeafe;color:#1e40af;border:1px solid #93c5fd;border-radius:3px;font-size:9px;padding:0 3px;margin-left:4px;font-weight:700;vertical-align:middle}',
    '.pedido-badge{display:inline-block;background:#ede9fe;color:#6d28d9;border:1px solid #c4b5fd;border-radius:3px;font-size:9px;padding:0 4px;margin-left:4px;font-weight:700;vertical-align:middle;text-transform:uppercase;letter-spacing:.03em}',
    '.footer{margin-top:28px;font-size:10px;color:#b09080;text-align:center;border-top:1px solid #e8ddd0;padding-top:10px}',
    '.btn-print{position:fixed;bottom:24px;right:24px;background:#0f2540;color:#fff;border:none;border-radius:8px;padding:12px 22px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.2);z-index:999}',
    '.btn-print:hover{background:#1a3a6e}',
    '@media print{.btn-print{display:none}}',
    '.leyenda{font-size:10px;color:#7a6055;margin-bottom:12px;display:flex;gap:16px}',
  ].join('');
}

// Header institucional: logo LNB + "San Geronimo SA" + título parametrizable + fecha.
export function headerHtml(titulo, fecha) {
  return [
    '<div class="header">',
    '<img src="' + LOGO_URL + '" class="logo-img" alt="La Nina Bonita">',
    '<div class="header-right"><div class="header-sub">San Geronimo SA</div><strong style="font-size:14px;color:#0f2540">' + titulo + '</strong><div class="header-sub">Fecha: ' + fecha + '</div></div>',
    '</div>',
  ].join('');
}

// Leyenda de badges (consignación / próximamente / bajo pedido 48hs).
export function leyendaHtml() {
  return '<div class="leyenda"><span><span class="cons-badge">consignación</span> Sin costo propio — precio de referencia</span><span style="margin-left:16px"><span class="prox-badge">⏳</span> Próximamente</span><span style="margin-left:16px"><span class="pedido-badge">bajo pedido 48hs</span> Se pide y llega en 48hs</span></div>';
}

// Badges por producto (mismo orden y strings que el Piso): consignación + prox + pedido.
export function badgesHtml(p) {
  const cons   = p.consignacion ? ' <span class="cons-badge">consignación</span>' : '';
  const prox   = p.disponible_general === 2 ? ' <span class="prox-badge">⏳</span>' : '';
  const pedido = p.disponible_general === 3 ? ' <span class="pedido-badge">bajo pedido 48hs</span>' : '';
  return cons + prox + pedido;
}

// Fila de encabezado de categoría (grupo).
export function catRow(cat, colspan) {
  return '<tr class="cat"><td colspan="' + colspan + '">' + (cat || 'Sin categoria') + '</td></tr>';
}

export function footerHtml() {
  return '<div class="footer">La Nina Bonita - Mercado Central de Buenos Aires, Nave 4, Puestos 2-4-6 | a.barcelo@lnbonita.com.ar</div>';
}

// Documento completo. Ensambla exactamente en el orden del Piso original para que su
// salida quede byte-idéntica. `extraHtml` va entre la tabla y el footer (ej. sección MNC).
export function documento({ titulo, fecha, theadHtml, tbodyHtml, extraHtml = '', conLeyenda = true }) {
  return [
    '<!DOCTYPE html><html><head><meta charset="UTF-8">',
    '<style>',
    estilosCss(),
    '</style></head><body>',
    headerHtml(titulo, fecha),
    conLeyenda ? leyendaHtml() : '',
    '<table>',
    theadHtml,
    '<tbody>' + tbodyHtml + '</tbody>',
    '</table>',
    extraHtml,
    footerHtml(),
    '<button class="btn-print" onclick="window.print()">🖨 Imprimir / Guardar PDF</button>',
    '</body></html>'
  ].join('');
}
