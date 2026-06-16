// src/servicios/facturaPDF.js
// ── PDF del comprobante fiscal AFIP/ARCA (RG 1415) — Factura/NC A o B ──────────────
// Reusa la identidad visual compartida (pdfComun.js: EMISOR, paleta, money, logo). El QR ARCA
// (obligatorio) se genera con `qrcode` (jsPDF no genera QR) y se incrusta con addImage.
// En homologación se estampa una marca de agua diagonal roja "SIN VALOR FISCAL".

import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import { AZUL, GRIS, GRIS_CL, EMISOR, money, getLogo } from './pdfComun.js';

// cbte_tipo → letra / código / etiqueta.
const CBTE = {
  1: { letra: 'A', cod: '01', label: 'FACTURA' },
  6: { letra: 'B', cod: '06', label: 'FACTURA' },
  3: { letra: 'A', cod: '03', label: 'NOTA DE CRÉDITO' },
  8: { letra: 'B', cod: '08', label: 'NOTA DE CRÉDITO' },
  2: { letra: 'A', cod: '02', label: 'NOTA DE DÉBITO' },
  7: { letra: 'B', cod: '07', label: 'NOTA DE DÉBITO' }
};
// alicuota_id AFIP → % (para reconstruir el desglose de IVA desde los ítems).
const ID_A_PCT = { 3: 0, 4: 10.5, 5: 21, 6: 27, 8: 5, 9: 2.5 };

const soloDig = (s) => String(s || '').replace(/\D/g, '');
const cuitValido = (c) => /^\d{11}$/.test(c) && !/^0+$/.test(c);
const fmtFecha = (s) => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || '—'); };
const fmtFechaCae = (s) => { const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})$/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || '—'); };

// DocTipo/DocNro del receptor (consistente con la emisión: A → CUIT 80; B → CUIT si hay, si no 99/0).
export function docReceptor(cliente, cbteTipo) {
  const cuit = soloDig(cliente && cliente.cuit);
  if (cbteTipo === 1 || cbteTipo === 3) return { tipo: 80, nro: cuit, label: 'CUIT' };
  return cuitValido(cuit) ? { tipo: 80, nro: cuit, label: 'CUIT' } : { tipo: 99, nro: '0', label: 'Consumidor Final' };
}
function condIvaLabel(cliente, cbteTipo) {
  const cf = String((cliente && cliente.categoria_fiscal) || '').toLowerCase();
  if (cf.includes('monotrib')) return 'Responsable Monotributo';
  if (cf.includes('exento')) return 'IVA Sujeto Exento';
  if (cf.includes('resp')) return 'IVA Responsable Inscripto';
  return docReceptor(cliente, cbteTipo).tipo === 80 ? 'IVA Responsable Inscripto' : 'Consumidor Final';
}

// Contenido del QR ARCA: URL + base64(JSON de 13 campos). Host vigente (afip.gob.ar/fe/qr/).
export function qrUrl(factura, doc) {
  const payload = {
    ver: 1,
    fecha: String(factura.fecha || '').slice(0, 10),
    cuit: Number(soloDig(EMISOR.cuit)),
    ptoVta: Number(factura.punto_venta),
    tipoCmp: Number(factura.cbte_tipo),
    nroCmp: Number(factura.cbte_nro),
    importe: Number(factura.total),
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: Number(doc.tipo),
    nroDocRec: Number(doc.nro || 0),
    tipoCodAut: 'E',
    codAut: Number(soloDig(factura.cae))
  };
  return 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(payload)).toString('base64');
}

// Genera el PDF (Buffer). factura debe traer: punto_venta, cbte_tipo, cbte_nro, cae, cae_vto,
// ambiente, fecha, neto, iva, total, cliente:{...}, items:[{descripcion,cantidad,precio_unitario,subtotal,alicuota_id, ...}].
export async function generarFacturaPDF(factura) {
  const doc = new jsPDF();
  const cliente = factura.cliente || {};
  const items = factura.items || [];
  const tipo = CBTE[factura.cbte_tipo] || { letra: 'X', cod: String(factura.cbte_tipo || ''), label: 'COMPROBANTE' };
  const rcpt = docReceptor(cliente, factura.cbte_tipo);
  const pvNum = String(factura.punto_venta || 0).padStart(4, '0') + '-' + String(factura.cbte_nro || 0).padStart(8, '0');

  // ── Encabezado: emisor (izq) · recuadro letra (centro) · datos del cbte (der) ──
  doc.setDrawColor(...GRIS).setLineWidth(0.3);
  doc.rect(8, 8, 194, 38);                                  // marco del encabezado
  doc.line(105, 8, 105, 46);                                // divisor central
  // recuadro de la letra, montado sobre el divisor
  doc.setFillColor(255, 255, 255).setDrawColor(...GRIS).setLineWidth(0.5).rect(96, 10, 18, 18, 'FD');
  doc.setTextColor(...AZUL).setFont('helvetica', 'bold').setFontSize(26).text(tipo.letra, 105, 23, { align: 'center' });
  doc.setFontSize(7).setTextColor(...GRIS).text('Cód. ' + tipo.cod, 105, 31, { align: 'center' });

  // Emisor (izquierda)
  const logo = getLogo();
  if (logo) { try { doc.addImage(logo, 'JPEG', 12, 11, 40, 13); } catch (e) {} }
  doc.setTextColor(...AZUL).setFont('helvetica', 'bold').setFontSize(13).text(EMISOR.razon, 12, 31);
  doc.setTextColor(...GRIS).setFont('helvetica', 'normal').setFontSize(8);
  doc.text('CUIT: ' + EMISOR.cuit + '   ·   IVA Responsable Inscripto', 12, 37);
  doc.text('Domicilio: ' + EMISOR.domicilio, 12, 42, { maxWidth: 88 });

  // Datos del comprobante (derecha)
  doc.setTextColor(...AZUL).setFont('helvetica', 'bold').setFontSize(13).text(tipo.label, 196, 16, { align: 'right' });
  doc.setTextColor(...GRIS).setFont('helvetica', 'normal').setFontSize(9);
  doc.text('Punto de Venta: ' + String(factura.punto_venta || 0).padStart(4, '0') + '    Comp. Nro: ' + String(factura.cbte_nro || 0).padStart(8, '0'), 196, 24, { align: 'right' });
  doc.text('Fecha de Emisión: ' + fmtFecha(factura.fecha), 196, 30, { align: 'right' });
  doc.text('CUIT: ' + EMISOR.cuit, 196, 36, { align: 'right' });
  doc.text('N°: ' + pvNum, 196, 42, { align: 'right' });

  // ── Receptor ──
  let y = 50;
  doc.setDrawColor(...GRIS).setLineWidth(0.3).rect(8, y, 194, 18);
  doc.setTextColor(...GRIS).setFont('helvetica', 'normal').setFontSize(8.5);
  doc.text(rcpt.label + ': ' + (rcpt.tipo === 99 ? '—' : rcpt.nro), 12, y + 6);
  doc.text('Razón Social: ' + (cliente.razon_social || '—'), 70, y + 6, { maxWidth: 128 });
  doc.text('Condición frente al IVA: ' + condIvaLabel(cliente, factura.cbte_tipo), 12, y + 12);
  const domCli = [cliente.direccion_entrega, cliente.localidad, cliente.provincia].filter(Boolean).join(', ') || '—';
  doc.text('Domicilio: ' + domCli, 70, y + 12, { maxWidth: 128 });

  // ── Detalle de ítems ──
  y += 24;
  const cols = [
    { x: 10,  w: 18, t: 'Código',  a: 'left' },
    { x: 28,  w: 78, t: 'Descripción', a: 'left' },
    { x: 106, w: 16, t: 'Cant.', a: 'right' },
    { x: 122, w: 14, t: 'U.med.', a: 'left' },
    { x: 136, w: 24, t: 'P. Unit.', a: 'right' },
    { x: 160, w: 14, t: '% IVA', a: 'right' },
    { x: 174, w: 26, t: 'Importe', a: 'right' }
  ];
  doc.setFillColor(...AZUL).rect(8, y, 194, 7, 'F');
  doc.setTextColor(255, 255, 255).setFont('helvetica', 'bold').setFontSize(7.5);
  for (const c of cols) doc.text(c.t, c.a === 'right' ? c.x + c.w - 1 : c.x + 1, y + 5, { align: c.a });
  y += 7;
  doc.setTextColor(...GRIS).setFont('helvetica', 'normal').setFontSize(7.5);
  const grav = {};   // pct → { base, iva }
  let totExento = 0;
  for (const it of items) {
    const pct = it.alicuota_id == null ? null : (ID_A_PCT[it.alicuota_id] != null ? ID_A_PCT[it.alicuota_id] : 0);
    const sub = Number(it.subtotal) || 0;
    if (pct == null) { totExento += sub; }
    else { if (!grav[pct]) grav[pct] = { base: 0, iva: 0 }; grav[pct].base += sub; grav[pct].iva += sub * pct / 100; }
    // F5 — presentación por BULTO (cajón) si la línea la trae; si no, kg como siempre. El Importe
    // SIEMPRE es el subtotal almacenado (kg×precio_kg) → totales idénticos a la versión kg.
    const kpb = (it.kg_por_bulto != null && Number(it.kg_por_bulto) > 0) ? Number(it.kg_por_bulto) : null;
    const enBulto = kpb != null && it.bultos != null;
    const cantTxt = enBulto ? String(Number(it.bultos)) : String(Number(it.cantidad) || 0);
    const uMed = enBulto ? (it.unidad || 'cajón') : 'kg';
    const pUnit = enBulto ? money(it.precio_por_bulto) : money(it.precio_unitario);
    const desc = enBulto ? (String(it.descripcion || '') + ' × ' + Number(kpb) + 'kg') : String(it.descripcion || '');
    const fila = [
      String(it.producto_id || ''),
      desc,
      cantTxt,
      uMed,
      pUnit,
      pct == null ? 'Exento' : (pct + '%'),
      money(sub)
    ];
    if (y > 250) { doc.addPage(); y = 16; }
    fila.forEach((v, i) => { const c = cols[i]; doc.text(String(v), c.a === 'right' ? c.x + c.w - 1 : c.x + 1, y + 4, { align: c.a, maxWidth: c.w - 1 }); });
    y += 5.5;
    doc.setDrawColor(...GRIS_CL).setLineWidth(0.1).line(8, y, 202, y);
  }

  // ── Totales (derecha) ──
  y += 4;
  const tx = 196, lx = 130;
  const linea = (lbl, val, bold) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(bold ? 10 : 8.5).setTextColor(...(bold ? AZUL : GRIS));
    doc.text(lbl, lx, y); doc.text(money(val), tx, y, { align: 'right' }); y += bold ? 6.5 : 5.2;
  };
  const netoGrav = Object.values(grav).reduce((a, g) => a + g.base, 0);
  linea('Neto Gravado:', netoGrav);
  for (const pct of Object.keys(grav).map(Number).sort((a, b) => a - b)) linea('IVA ' + String(pct).replace('.', ',') + '%:', grav[pct].iva);
  if (totExento > 0.001) linea('Importe Exento:', totExento);
  doc.setDrawColor(...GRIS).setLineWidth(0.3).line(lx, y, tx, y); y += 5;
  linea('Importe Total:', factura.total, true);

  // ── CAE + QR ──
  const yFoot = Math.max(y + 6, 262);
  const url = qrUrl(factura, rcpt);
  try {
    const qrImg = await QRCode.toDataURL(url, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
    doc.addImage(qrImg, 'PNG', 12, yFoot, 30, 30);
  } catch (e) { /* sin QR si falla la generación; el resto del PDF igual sale */ }
  doc.setTextColor(...GRIS).setFont('helvetica', 'bold').setFontSize(10).text('CAE N°: ' + (factura.cae || '—'), 196, yFoot + 6, { align: 'right' });
  doc.setFont('helvetica', 'normal').setFontSize(9).text('Vto. CAE: ' + fmtFechaCae(factura.cae_vto), 196, yFoot + 12, { align: 'right' });
  doc.setTextColor(...AZUL).setFont('helvetica', 'bold').setFontSize(9).text('Comprobante Autorizado', 196, yFoot + 19, { align: 'right' });
  doc.setTextColor(...GRIS).setFont('helvetica', 'italic').setFontSize(7).text('Esta Administración Federal no se responsabiliza por los datos ingresados en el detalle de la operación.', 46, yFoot + 28, { maxWidth: 156 });

  // ── Marca de agua de homologación ──
  if (String(factura.ambiente || '').toLowerCase() === 'homologacion') {
    doc.saveGraphicsState();
    try { doc.setGState(new doc.GState({ opacity: 0.18 })); } catch (e) {}
    doc.setTextColor(220, 30, 30).setFont('helvetica', 'bold').setFontSize(26);
    doc.text('COMPROBANTE NO VÁLIDO — SIN VALOR FISCAL', 105, 170, { align: 'center', angle: 35 });
    try { doc.restoreGraphicsState(); } catch (e) {}
  }

  return Buffer.from(doc.output('arraybuffer'));
}
