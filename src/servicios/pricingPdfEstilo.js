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

// Orden fijo de los grupos (categorías) en TODOS los PDFs: Nacionales → Importadas →
// Hortalizas. Una categoría no contemplada cae al final (índice 99). Fuente única.
export const ORDEN_CAT = ['Frutas Nacionales', 'Frutas Importadas', 'Hortaliza Liviana', 'Hortaliza Pesada'];

export function ordenarPorCategoria(arr) {
  return arr.slice().sort(function (a, b) {
    const ia = ORDEN_CAT.indexOf(a.categoria); const ib = ORDEN_CAT.indexOf(b.categoria);
    const oa = ia >= 0 ? ia : 99; const ob = ib >= 0 ? ib : 99;
    if (oa !== ob) return oa - ob;
    return (a.nombre || '').localeCompare(b.nombre || '');
  });
}

// CSS compartido. Se une con '' → una sola cadena; cada regla es autocontenida, así que el
// separador vacío no las mezcla.
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
    // Título de grupo (categoría): azul institucional saturado + barra de acento, para que
    // resalte claramente sobre las filas blancas. Texto navy sigue legible sobre este fondo.
    'tr.cat td{background:#9dbfe3;font-size:10px;font-weight:700;color:#0f2540;text-transform:uppercase;padding:6px 10px;letter-spacing:.05em;border-left:4px solid #0f2540}',
    '.cons-badge{display:inline-block;background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:3px;font-size:9px;padding:0 4px;margin-left:4px;font-weight:700;vertical-align:middle}',
    '.prox-badge{display:inline-block;background:#dbeafe;color:#1e40af;border:1px solid #93c5fd;border-radius:3px;font-size:9px;padding:0 3px;margin-left:4px;font-weight:700;vertical-align:middle}',
    // Marca protagonista ANTES del nombre (bordó del logo LNB, bold, mayúsculas). No es un chip:
    // es un prefijo que destaca sin tapar el nombre (que sigue en negro).
    '.marca-lead{font-weight:800;color:#6b1212;text-transform:uppercase;letter-spacing:.02em;margin-right:5px}',
    // Bajo pedido 48hs: asterisco al lado del nombre (ya no un badge que compite); se explica en
    // la nota al pie.
    '.pedido-ast{font-weight:700;color:#6d28d9}',
    '.footer{margin-top:28px;font-size:10px;color:#b09080;text-align:center;border-top:1px solid #e8ddd0;padding-top:10px}',
    '.nota-pie{margin-top:18px;font-size:10px;color:#6d28d9;font-weight:700}',
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

// Leyenda superior de badges (consignación / próximamente). El "bajo pedido 48hs" se explica en
// la nota al pie (ver documento(notaAlPie) + NOTA_BAJO_PEDIDO), no acá.
export function leyendaHtml() {
  return '<div class="leyenda"><span><span class="cons-badge">consignación</span> Sin costo propio — precio de referencia</span><span style="margin-left:16px"><span class="prox-badge">⏳</span> Próximamente</span></div>';
}

// Texto de la nota al pie para "bajo pedido 48hs". El caller lo pasa a documento(notaAlPie)
// solo si hay al menos un producto con asterisco en ese PDF.
export const NOTA_BAJO_PEDIDO = '* Se pide y llega en 48hs';

// Marca PROTAGONISTA antes del nombre (misma celda), solo si opts.marca y el producto la tiene.
// Sin marca → '' (no deja espacio vacío). El estilo (bordó, bold, mayúsculas) va en .marca-lead.
export function marcaPrefix(p, opts = {}) {
  return (opts.marca && p.marca) ? '<span class="marca-lead">' + p.marca + '</span>' : '';
}

// Marcadores DESPUÉS del nombre: consignación + próximamente + asterisco de bajo pedido. `opts`
// (default {}) preserva el comportamiento de los internos:
//   opts.consignacion === false → NO muestra el badge "consignación" (ej. lista a clientes).
// La marca ya NO va acá (pasó a marcaPrefix, antes del nombre); el bajo pedido es un asterisco.
export function badgesHtml(p, opts = {}) {
  const cons   = (opts.consignacion === false) ? '' : (p.consignacion ? ' <span class="cons-badge">consignación</span>' : '');
  const prox   = p.disponible_general === 2 ? ' <span class="prox-badge">⏳</span>' : '';
  const pedido = p.disponible_general === 3 ? ' <span class="pedido-ast">*</span>' : '';
  return cons + prox + pedido;
}

// Presentación con unidad: un kilaje "pelado" (ej. "13") se muestra como "13 kg". Si ya trae
// texto/unidad (ej. "caja 20kg", "20kg", "bolsa x 5"), se respeta tal cual. Vacío → ''.
export function presentacionText(kilaje) {
  const k = (kilaje == null ? '' : String(kilaje)).trim();
  if (!k) return '';
  return /^\d+([.,]\d+)?$/.test(k) ? k + ' kg' : k;
}

// Fila de encabezado de categoría (grupo).
export function catRow(cat, colspan) {
  return '<tr class="cat"><td colspan="' + colspan + '">' + (cat || 'Sin categoria') + '</td></tr>';
}

export function footerHtml() {
  return '<div class="footer">La Nina Bonita - Mercado Central de Buenos Aires, Nave 4, Puestos 2-4-6 | a.barcelo@lnbonita.com.ar</div>';
}

// Documento completo. `extraHtml` va entre la tabla y el footer (ej. sección MNC). `notaAlPie`
// (opcional) renderiza una nota antes del footer (ej. NOTA_BAJO_PEDIDO), solo si viene con texto.
export function documento({ titulo, fecha, theadHtml, tbodyHtml, extraHtml = '', conLeyenda = true, notaAlPie = '' }) {
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
    notaAlPie ? '<div class="nota-pie">' + notaAlPie + '</div>' : '',
    footerHtml(),
    '<button class="btn-print" onclick="window.print()">🖨 Imprimir / Guardar PDF</button>',
    '</body></html>'
  ].join('');
}
