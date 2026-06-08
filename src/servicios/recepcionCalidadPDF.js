// src/servicios/recepcionCalidadPDF.js
// BLOQUE B — Informe de calidad de una recepción SG en PDF. Reusa jsPDF (mismo motor
// que ordenPDF.js / liquidaciones.js). Embebe los datos de recepción/proveedor/OC, el
// informe de calidad (estado, defectos, % afectado, observaciones) y las fotos adjuntas.
// `fotos` = [{ dataUri, fmt }] ya leídas a base64 por el router (desde data/sg/).
import { jsPDF } from "jspdf";
// Identidad visual compartida (paleta azul/gris, emisor, logo) con el PDF de la OC.
import { AZUL, AZUL_CL, GRIS, GRIS_CL, EMISOR, getLogo } from "./pdfComun.js";

const NEGRO = [0, 0, 0];

const fmtFecha = (d) => {
  if (!d) return "—";
  try { return new Date(d + "T00:00:00").toLocaleDateString("es-AR"); }
  catch (_) { return String(d); }
};

export async function generarRecepcionCalidadPDF(rec, fotos = []) {
  const doc = new jsPDF();           // A4 vertical, mm: 210 x 297
  const M = 14;                      // margen
  const W = 210;
  let y = 0;

  // ── Membrete (familia visual con el PDF de la OC: logo + emisor azul/gris) ──
  const logo = getLogo();
  if (logo) {
    try { doc.addImage(logo, "JPEG", M, 9, 46, 15); } catch (e) {}   // logo.jpg ≈ 3:1 (trae la marca)
  } else {
    doc.setFont("helvetica", "bold").setFontSize(15).setTextColor(...AZUL);
    doc.text(EMISOR.marca, M, 18);
  }
  // Datos fiscales del emisor (derecha)
  doc.setTextColor(...AZUL).setFont("helvetica", "bold").setFontSize(11);
  doc.text(EMISOR.razon, W - M, 13, { align: "right" });
  doc.setTextColor(...GRIS).setFont("helvetica", "normal").setFontSize(8.5);
  doc.text("CUIT " + EMISOR.cuit, W - M, 19, { align: "right" });
  doc.text(EMISOR.domicilio, W - M, 24, { align: "right" });
  doc.setDrawColor(...AZUL).setLineWidth(0.6);
  doc.line(M, 31, W - M, 31);
  // Banda de título
  doc.setFillColor(...AZUL);
  doc.rect(M, 35, W - 2 * M, 11, "F");
  doc.setTextColor(255, 255, 255).setFont("helvetica", "bold").setFontSize(13);
  doc.text("INFORME DE CALIDAD DE RECEPCIÓN", M + 4, 42.5);
  doc.setFontSize(10);
  doc.text("Recepción " + (rec.numero_recepcion || ("#" + rec.id)) + "  ·  " + fmtFecha(rec.fecha_recepcion), W - M - 2, 42.5, { align: "right" });
  doc.setTextColor(...NEGRO);
  y = 53;

  // ── Helper de fila clave/valor ─────────────────────────────────────────
  const row = (label, value) => {
    doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(...GRIS);
    doc.text(label, M, y);
    doc.setFont("helvetica", "normal").setTextColor(...NEGRO);
    const lines = doc.splitTextToSize(String(value == null || value === "" ? "—" : value), W - M - 52);
    doc.text(lines, M + 50, y);
    y += Math.max(6, lines.length * 5);
  };
  const seccion = (titulo) => {
    y += 2;
    doc.setFillColor(...AZUL_CL);
    doc.rect(M, y - 4, W - 2 * M, 7, "F");
    doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(...AZUL);
    doc.text(titulo, M + 2, y + 1);
    doc.setTextColor(...NEGRO);
    y += 9;
  };

  // ── Datos de la recepción ──────────────────────────────────────────────
  seccion("Datos de la recepción");
  row("Orden de compra", rec.oc_numero || "—");
  row("Proveedor", (rec.proveedor_nombre || "—") + (rec.proveedor_cuit ? ("  ·  CUIT " + rec.proveedor_cuit) : ""));
  row("Remito proveedor", rec.numero_remito_proveedor);
  row("Factura", rec.factura_numero);
  row("DTV (SENASA)", rec.dtv_codigo);
  const pal = [];
  if (rec.pallets_recibidos != null) pal.push(rec.pallets_recibidos + " pallet(s)");
  if (rec.bultos_recibidos != null) pal.push(rec.bultos_recibidos + " bulto(s)");
  row("Paletizado recibido", pal.length ? pal.join("  ·  ") : "—");

  // ── Items recibidos (lotes) ────────────────────────────────────────────
  if (Array.isArray(rec.lotes) && rec.lotes.length) {
    seccion("Mercadería recibida");
    doc.setFont("helvetica", "bold").setFontSize(8).setTextColor(...GRIS);
    doc.text("Lote", M, y); doc.text("Producto", M + 42, y);
    doc.text("Calidad", M + 130, y); doc.text("kg", W - M, y, { align: "right" });
    doc.setTextColor(...NEGRO).setFont("helvetica", "normal");
    y += 5;
    for (const l of rec.lotes) {
      if (y > 270) { doc.addPage(); y = 20; }
      const prod = (l.producto_nombre || "") + (l.producto_variedad ? (" " + l.producto_variedad) : "");
      doc.setFontSize(8);
      doc.text(String(l.codigo_lote || "—"), M, y);
      doc.text(doc.splitTextToSize(prod, 84), M + 42, y);
      doc.text(String(l.calidad || "—"), M + 130, y);
      doc.text(Number(l.kg_reales || 0).toLocaleString("es-AR"), W - M, y, { align: "right" });
      y += 5.5;
    }
  }

  // ── Informe de calidad ─────────────────────────────────────────────────
  seccion("Informe de calidad" + (rec.observada ? "  —  MERCADERÍA OBSERVADA" : ""));
  row("Estado general", rec.calidad_estado_general);
  row("Defectos detectados", rec.calidad_defectos);
  row("% afectado", rec.calidad_pct_afectado != null ? (rec.calidad_pct_afectado + " %") : "—");
  row("Observaciones", rec.calidad_observaciones || rec.observaciones);

  // ── Fotos adjuntas ─────────────────────────────────────────────────────
  if (fotos.length) {
    seccion("Fotos (" + fotos.length + ")");
    const colW = (W - 2 * M - 8) / 2;   // 2 columnas
    const maxH = 60;
    let col = 0;
    let rowTop = y;
    for (const f of fotos) {
      let w = colW, h = maxH;
      try {
        const props = doc.getImageProperties(f.dataUri);
        const ratio = props.width / props.height;
        if (colW / maxH > ratio) { h = maxH; w = maxH * ratio; }
        else { w = colW; h = colW / ratio; }
      } catch (_) {}
      if (rowTop + h > 285) { doc.addPage(); y = 20; rowTop = y; col = 0; }
      const x = M + col * (colW + 8);
      try { doc.addImage(f.dataUri, f.fmt || "JPEG", x, rowTop, w, h); }
      catch (_) {
        doc.setFontSize(8).setTextColor(...GRIS);
        doc.text("(foto no disponible)", x, rowTop + 6);
        doc.setTextColor(...NEGRO);
      }
      if (col === 1) { rowTop += maxH + 6; col = 0; }
      else { col = 1; }
    }
    y = rowTop + (col === 1 ? maxH + 6 : 0);
  }

  // ── Pie ────────────────────────────────────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal").setFontSize(7).setTextColor(...GRIS);
    doc.text("Documento interno de control de calidad — San Gerónimo (Puente Cordón S.A.)", M, 292);
    doc.text("Página " + i + " de " + pages, W - M, 292, { align: "right" });
  }

  return Buffer.from(doc.output("arraybuffer"));
}
