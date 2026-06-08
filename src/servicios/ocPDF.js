// src/servicios/ocPDF.js
// Genera el PDF formal de una Orden de Compra de San Gerónimo (SG · Compras),
// 100% server-side con jsPDF. Patrón clonado de ordenPDF.js (layout) + el loader
// de logo de liquidaciones.js. Paleta azul/gris. Devuelve un Buffer.
//
// data: la OC con joins ya resueltos (ver la ruta GET /api/sg/oc/:id/pdf):
//   { numero, fecha_oc, tipo_fiscal, tipo_precio, fecha_recepcion_estimada,
//     flete_a_cargo, flete_monto, total_estimado_kg, total_estimado_monto,
//     prov_razon, prov_cuit, prov_catfisc, prov_localidad, prov_provincia, prov_fantasia,
//     cond_nombre, comercial_nombre, items: [{producto_codigo, producto_nombre,
//       producto_variedad, presentacion_nombre, cantidad_estimada_presentaciones,
//       kg_estimados, precio_estimado_por_kg}] }

import { jsPDF } from 'jspdf';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Paleta azul/gris
const AZUL      = [20, 60, 120];
const AZUL_CL   = [222, 232, 245];
const GRIS      = [90, 90, 90];
const GRIS_CL   = [244, 246, 249];

// Datos fiscales del emisor (San Gerónimo SA). Hardcodeado acá igual que ordenPDF.js
// hardcodea los datos de la empresa; si en el futuro se cargan en `sociedades`, leer de ahí.
const EMISOR = {
  marca: 'La Niña Bonita',
  razon: 'San Gerónimo SA',
  cuit: '30-67325443-4',
  domicilio: 'Mercado Central de Buenos Aires, Nave 4, Puestos 2-4-6',
};

const FISCAL_LBL    = { factura_a: 'Factura A', factura_b: 'Factura B', liquidacion: 'Liquidación', invoice: 'Invoice' };
const COMERCIAL_LBL = { firme: 'Precio Cerrado', pizarra: 'Liquidación de Venta' };
const CATFISC_LBL   = { resp_inscripto: 'Resp. Inscripto', monotributista: 'Monotributista', exento: 'Exento', no_inscripto: 'No inscripto' };
const FLETE_LBL     = { comprador: 'Comprador', vendedor: 'Vendedor' };

const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nr    = (n) => Number(n || 0).toLocaleString('es-AR');

// Logo cacheado en base64 (undefined=no intentado, null=falló, string=OK).
let _logoB64 = undefined;
function getLogo() {
  if (_logoB64 !== undefined) return _logoB64;
  try {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'logo.jpg'));
    _logoB64 = 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch (e) {
    console.error('[OC-PDF] No se pudo cargar logo.jpg:', e.message);
    _logoB64 = null;
  }
  return _logoB64;
}

export function generarOcPDF(oc) {
  const doc = new jsPDF();
  const items = Array.isArray(oc.items) ? oc.items : [];

  // ── Membrete ───────────────────────────────────────────────────────────────
  const logo = getLogo();
  if (logo) {
    try { doc.addImage(logo, 'JPEG', 14, 9, 46, 15); } catch (e) {} // logo.jpg ≈ 3:1
  } else {
    doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(...AZUL);
    doc.text(EMISOR.marca, 14, 18);
  }
  doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(...GRIS);
  doc.text(EMISOR.marca, 14, 27);

  // Datos fiscales del emisor (derecha)
  doc.setTextColor(...AZUL).setFont('helvetica', 'bold').setFontSize(11);
  doc.text(EMISOR.razon, 196, 13, { align: 'right' });
  doc.setTextColor(...GRIS).setFont('helvetica', 'normal').setFontSize(8.5);
  doc.text('CUIT ' + EMISOR.cuit, 196, 19, { align: 'right' });
  doc.text(EMISOR.domicilio, 196, 24, { align: 'right' });

  doc.setDrawColor(...AZUL).setLineWidth(0.6);
  doc.line(14, 31, 196, 31);

  // ── Título + número ─────────────────────────────────────────────────────────
  doc.setFillColor(...AZUL);
  doc.rect(14, 35, 182, 11, 'F');
  doc.setTextColor(255, 255, 255).setFont('helvetica', 'bold').setFontSize(13);
  doc.text('ORDEN DE COMPRA', 18, 42.5);
  doc.setFontSize(10);
  doc.text((oc.numero || '') + '  ·  ' + (oc.fecha_oc || ''), 192, 42.5, { align: 'right' });
  doc.setTextColor(0, 0, 0);

  let y = 53;

  // ── Bloque Proveedor ─────────────────────────────────────────────────────────
  doc.setFillColor(...GRIS_CL);
  doc.rect(14, y, 182, 20, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(8).setTextColor(...AZUL);
  doc.text('PROVEEDOR', 18, y + 5);
  doc.setTextColor(0, 0, 0).setFont('helvetica', 'bold').setFontSize(10);
  doc.text(String(oc.prov_razon || '—') + (oc.prov_fantasia ? ('  (' + oc.prov_fantasia + ')') : ''), 18, y + 11);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...GRIS);
  const provLinea = [
    oc.prov_cuit ? ('CUIT ' + oc.prov_cuit) : null,
    oc.prov_catfisc ? (CATFISC_LBL[oc.prov_catfisc] || oc.prov_catfisc) : null,
    [oc.prov_localidad, oc.prov_provincia].filter(Boolean).join(', ') || null,
  ].filter(Boolean).join('  ·  ');
  doc.text(provLinea || '—', 18, y + 17);
  doc.setTextColor(0, 0, 0);
  y += 26;

  // ── Bloque Condiciones (2 columnas label:valor) ──────────────────────────────
  doc.setFont('helvetica', 'bold').setFontSize(8).setTextColor(...AZUL);
  doc.text('CONDICIONES', 18, y);
  doc.setTextColor(0, 0, 0);
  y += 5;
  const cond = [
    ['Comprobante Fiscal', FISCAL_LBL[oc.tipo_fiscal] || oc.tipo_fiscal || '—'],
    ['Condiciones Comerciales', COMERCIAL_LBL[oc.tipo_precio] || oc.tipo_precio || '—'],
    ['Condición de pago', oc.cond_nombre || '—'],
    ['Recepción estimada', oc.fecha_recepcion_estimada || '—'],
    ['Flete a cargo de', oc.flete_a_cargo ? ((FLETE_LBL[oc.flete_a_cargo] || oc.flete_a_cargo) + (oc.flete_monto != null ? ('  ·  ' + money(oc.flete_monto)) : '')) : '—'],
  ];
  doc.setFontSize(9);
  cond.forEach(function (par, i) {
    const col = i % 2;            // 0 izquierda, 1 derecha
    const xL = col === 0 ? 18 : 108;
    if (col === 0 && i > 0) y += 6;
    doc.setFont('helvetica', 'normal').setTextColor(...GRIS);
    doc.text(par[0] + ':', xL, y);
    doc.setFont('helvetica', 'bold').setTextColor(0, 0, 0);
    doc.text(String(par[1]), xL + (col === 0 ? 42 : 38), y);
  });
  y += 9;

  // ── Tabla de items ───────────────────────────────────────────────────────────
  doc.setFillColor(...AZUL);
  doc.rect(14, y, 182, 8, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(8).setTextColor(255, 255, 255);
  doc.text('Código', 17, y + 5.3);
  doc.text('Producto', 38, y + 5.3);
  doc.text('Presentación', 96, y + 5.3);
  doc.text('Cant.', 132, y + 5.3, { align: 'right' });
  doc.text('Kg est.', 150, y + 5.3, { align: 'right' });
  doc.text('$/kg', 168, y + 5.3, { align: 'right' });
  doc.text('Subtotal', 193, y + 5.3, { align: 'right' });
  doc.setTextColor(0, 0, 0);
  y += 11;

  doc.setFont('helvetica', 'normal').setFontSize(8.5);
  items.forEach(function (it, i) {
    if (i % 2 === 0) { doc.setFillColor(...AZUL_CL); doc.rect(14, y - 4, 182, 7, 'F'); }
    const nombre = String(it.producto_nombre || '') + (it.producto_variedad ? (' ' + it.producto_variedad) : '');
    const precio = it.precio_estimado_por_kg;
    const sub = (precio != null) ? Number(it.kg_estimados || 0) * Number(precio) : null;
    doc.text(String(it.producto_codigo || '—'), 17, y);
    doc.text(nombre.slice(0, 34), 38, y);
    doc.text(String(it.presentacion_nombre || '—').slice(0, 20), 96, y);
    doc.text(nr(it.cantidad_estimada_presentaciones), 132, y, { align: 'right' });
    doc.text(nr(it.kg_estimados), 150, y, { align: 'right' });
    doc.text(precio != null ? money(precio) : '—', 168, y, { align: 'right' });
    doc.text(sub != null ? money(sub) : '—', 193, y, { align: 'right' });
    y += 7;
  });

  // ── Totales ───────────────────────────────────────────────────────────────────
  y += 2;
  doc.setFillColor(...AZUL);
  doc.rect(110, y, 86, 9, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(255, 255, 255);
  doc.text('TOTAL  ·  ' + nr(oc.total_estimado_kg) + ' kg', 114, y + 6);
  doc.text(oc.tipo_precio === 'pizarra' ? '(a definir)' : money(oc.total_estimado_monto), 193, y + 6, { align: 'right' });
  doc.setTextColor(0, 0, 0);
  y += 16;

  // ── Cláusula de calidad ────────────────────────────────────────────────────────
  doc.setDrawColor(...AZUL).setLineWidth(0.4);
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(14, y, 182, 12, 2, 2, 'S');
  doc.setFont('helvetica', 'italic').setFontSize(8.5).setTextColor(...AZUL);
  doc.text('La presente orden de compra está sujeta a la recepción de la mercadería en correcto estado de calidad.', 105, y + 7.5, { align: 'center' });
  doc.setTextColor(0, 0, 0);
  y += 22;

  // ── Pie: comercial responsable (sin firma de proveedor) ────────────────────────
  doc.setDrawColor(...GRIS).setLineWidth(0.3);
  doc.line(18, y, 88, y);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...GRIS);
  doc.text('Comercial responsable: ' + (oc.comercial_nombre || '—'), 18, y + 5);
  doc.text('Firma', 18, y + 10);
  doc.setFontSize(7.5);
  doc.text(EMISOR.razon + '  ·  CUIT ' + EMISOR.cuit, 193, y + 10, { align: 'right' });

  return Buffer.from(doc.output('arraybuffer'));
}
