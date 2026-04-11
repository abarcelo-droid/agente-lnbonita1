import { jsPDF } from "jspdf";

const ROJO_LNB  = [139, 0, 0];
const VERDE_LNB = [40, 100, 40];
const GRIS      = [80, 80, 80];

export async function generarOrdenPDF(pedido) {
  const doc  = new jsPDF();
  const hoy  = new Date().toLocaleDateString("es-AR");
  let detalle = [];
  try { detalle = JSON.parse(pedido.detalle); } catch(e) {}

  const esMayorista = ["mayorista","mayorista_b"].includes(pedido.tipo_cliente);
  const esCD        = esMayorista;
  const labelTipo   = { mayorista:"Mayorista A", mayorista_b:"Mayorista B", minorista:"Minorista", food_service:"Food Service" };
  const esCCte      = ["mayorista","mayorista_b","food_service"].includes(pedido.tipo_cliente);

  // ── Encabezado con banda de color ──────────────────────────────────────
  doc.setFillColor(...ROJO_LNB);
  doc.rect(0, 0, 210, 28, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold").setFontSize(18);
  doc.text("LA NINA BONITA", 14, 12);
  doc.setFontSize(9).setFont("helvetica", "normal");
  doc.text("Distribuidora Frutihortícola · lnbonita.com.ar", 14, 20);

  // Tipo de orden en la banda
  const tipoLabel = esCD ? "ORDEN DE RETIRO — CD" : "ORDEN DE ENTREGA DIRECTA";
  doc.setFont("helvetica","bold").setFontSize(11);
  doc.text(tipoLabel, 196, 12, { align:"right" });
  doc.setFontSize(9).setFont("helvetica","normal");
  doc.text("Orden #" + pedido.id + " · " + hoy, 196, 20, { align:"right" });

  doc.setTextColor(0, 0, 0);

  // ── Banda de tipo de cliente ───────────────────────────────────────────
  const colorBanda = esMayorista ? [220, 230, 200] : [200, 220, 240];
  doc.setFillColor(...colorBanda);
  doc.rect(0, 28, 210, 10, "F");
  doc.setFont("helvetica","bold").setFontSize(10);
  doc.setTextColor(...(esMayorista ? VERDE_LNB : [20, 60, 120]));
  doc.text(labelTipo[pedido.tipo_cliente] || pedido.tipo_cliente, 14, 35);
  doc.text(esCCte ? "PAGO: Cuenta Corriente" : "PAGO: Mercado Pago", 196, 35, { align:"right" });
  doc.setTextColor(0,0,0);

  // ── Info del pedido ────────────────────────────────────────────────────
  let y = 46;
  doc.setFont("helvetica","normal").setFontSize(10);
  doc.text("Cliente: " + (pedido.telefono || ""), 14, y);
  doc.text("Fecha pedido: " + hoy, 110, y);
  y += 7;

  if (esCD) {
    // Retiro en CD
    const diaRetiro = pedido.horario_entrega || "A coordinar";
    doc.setFillColor(255, 248, 220);
    doc.roundedRect(14, y, 182, 14, 3, 3, "F");
    doc.setFont("helvetica","bold").setFontSize(10);
    doc.setTextColor(...ROJO_LNB);
    doc.text("RETIRO EN CD: " + diaRetiro, 105, y+8, { align:"center" });
    doc.setTextColor(0,0,0);
    doc.setFont("helvetica","normal").setFontSize(9);
    doc.text("Mercado Central de Buenos Aires, Nave 4 Puesto 2-6", 105, y+14, { align:"center" });
    y += 22;
  } else {
    // Entrega directa
    const direccion = pedido.direccion_entrega || pedido.horario_entrega || "A confirmar";
    doc.setFillColor(220, 235, 255);
    doc.roundedRect(14, y, 182, 14, 3, 3, "F");
    doc.setFont("helvetica","bold").setFontSize(10);
    doc.setTextColor(20, 60, 120);
    doc.text("ENTREGA DIRECTA: " + direccion, 105, y+9, { align:"center" });
    doc.setTextColor(0,0,0);
    y += 22;
  }

  // ── Tabla de productos ─────────────────────────────────────────────────
  y += 4;
  doc.setFillColor(...ROJO_LNB);
  doc.rect(14, y, 182, 8, "F");
  doc.setFont("helvetica","bold").setFontSize(9);
  doc.setTextColor(255,255,255);
  doc.text("Cod.", 18, y+5.5);
  doc.text("Producto", 38, y+5.5);
  doc.text("Cant.", 130, y+5.5);
  doc.text("Precio unit.", 150, y+5.5);
  doc.text("Subtotal", 178, y+5.5);
  doc.setTextColor(0,0,0);
  y += 12;

  let total = 0;
  detalle.forEach(function(item, i) {
    if (i % 2 === 0) {
      doc.setFillColor(248,248,248);
      doc.rect(14, y-4, 182, 9, "F");
    }
    doc.setFont("helvetica","normal").setFontSize(9);
    doc.text(String(item.codigo || "-"), 18, y+1);
    doc.text(String(item.nombre || "-").slice(0, 35), 38, y+1);
    doc.text(String(item.cantidad || 1), 133, y+1);
    doc.text("$" + Number(item.precio_unit || 0).toLocaleString("es-AR"), 153, y+1);
    const sub = (item.cantidad || 1) * (item.precio_unit || 0);
    total += sub;
    doc.text("$" + sub.toLocaleString("es-AR"), 181, y+1);
    y += 9;
  });

  // ── Total ──────────────────────────────────────────────────────────────
  doc.setFillColor(...(esMayorista ? VERDE_LNB : [20,60,120]));
  doc.rect(14, y+2, 182, 10, "F");
  doc.setFont("helvetica","bold").setFontSize(11);
  doc.setTextColor(255,255,255);
  doc.text("TOTAL", 140, y+9);
  doc.text("$" + total.toLocaleString("es-AR"), 181, y+9);
  doc.setTextColor(0,0,0);
  y += 20;

  // ── Estado y pago ──────────────────────────────────────────────────────
  doc.setFont("helvetica","normal").setFontSize(9).setTextColor(...GRIS);
  doc.text("Estado: " + (pedido.estado || "PENDIENTE").toUpperCase(), 14, y);
  doc.text("La Nina Bonita · lnbonita.com.ar · +54 264 4284 082", 196, y, { align:"right" });

  // ── Firma ──────────────────────────────────────────────────────────────
  y += 16;
  doc.line(14, y, 80, y);
  doc.text(esCD ? "Responsable CD" : "Repartidor", 14, y+5);
  doc.line(116, y, 182, y);
  doc.text("Recibí conforme", 116, y+5);

  return Buffer.from(doc.output("arraybuffer"));
}
