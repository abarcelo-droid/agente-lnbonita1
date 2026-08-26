// src/servicios/oportunidadesPDF.js
// ── EL RADAR, EN PAPEL, PARA SALIR A TRABAJAR ────────────────────────────────────────
// El informe del comercial. No es la pantalla impresa: la pantalla ordena por plata y sirve
// para decidir a qué apuntar; el papel se lleva a una visita, así que va AGRUPADO POR
// CLIENTE. Una visita es un cliente, y tenerlo desparramado en doce renglones de una lista
// ordenada por importe obliga a rearmarlo a mano antes de salir.
//
// Y explica. El que lo recibe no estuvo en la conversación donde se definieron las reglas:
// cada tipo lleva qué significa y QUÉ HACER con eso. Un listado de nombres y números sin
// eso se lee como un reproche, no como una herramienta.
//
// Mismo motor y misma identidad visual que el resto de los PDF del sistema (ocPDF,
// recepcionCalidadPDF): logo, paleta azul/gris, emisor.
import { jsPDF } from "jspdf";
import { AZUL, AZUL_CL, GRIS, GRIS_CL, EMISOR, getLogo } from "./pdfComun.js";

const NEGRO  = [0, 0, 0];
const ROJO   = [153, 27, 27];
const AMBAR  = [146, 64, 14];
const VERDE  = [22, 101, 52];
const AZULC  = [30, 64, 175];

const nr  = (n) => Number(n || 0).toLocaleString("es-AR");
const usd = (n) => "USD " + nr(n);
const kg  = (n) => nr(n) + " K";
const mes = (m) => { const x = /^\d\d-(.+)$/.exec(String(m || "")); return x ? x[1] : String(m || ""); };

// Qué es cada cosa y qué hacer con ella. El "qué hacer" no está en la pantalla a propósito:
// ahí ocupa lugar y el que mira ya sabe. En el papel es lo único que convierte el dato en
// una gestión.
export const GUIA = {
  CLIENTE_PERDIDO: {
    label: "Cliente perdido", color: ROJO,
    que: "Nos compraba en este mes del año pasado y este año no compró nada.",
    hacer: "Llamarlo. Averiguar si le está comprando a otro, si hubo un problema de servicio o si dejó de operar. Es la conversación que más rápido se enfría.",
  },
  PRODUCTO_PERDIDO: {
    label: "Producto perdido", color: ROJO,
    que: "Sigue comprando, pero dejó de llevar un producto que el año pasado sí llevaba.",
    hacer: "Preguntar por qué cambió ese renglón: precio, calidad, o le entró otro proveedor. El cliente ya está, así que recuperar el renglón es más barato que conseguir uno nuevo.",
  },
  CAIDA_FUERTE: {
    label: "Caída fuerte", color: AMBAR,
    que: "Sigue comprando el producto pero mucho menos que el año pasado en este mismo mes.",
    hacer: "Mirar si es estacional o si perdimos espacio en la góndola. Comparar nuestro precio contra el mercado antes de la visita.",
  },
  CROSS_SELL: {
    label: "No le vendemos", color: AZULC,
    que: "Otros clientes de su mismo rubro compran ese producto en este mes, y a él no se lo vendemos.",
    hacer: "Ofrecerlo. La demanda ya está probada con clientes parecidos, así que no hay que convencer de la categoría: sólo de nosotros.",
  },
  MARGEN_NEGATIVO: {
    label: "Vende y pierde plata", color: AMBAR,
    que: "Le vendimos y el margen dio negativo: cada kilo agranda la pérdida.",
    hacer: "Revisar el precio o el costo ANTES de seguir despachando. No es una venta que haya que hacer crecer.",
  },
};

// LAS N MÁS IMPORTANTES, Y RECIÉN AHÍ AGRUPADAS.
//
// El orden importa y no es intercambiable. Si se agrupara primero y se recortara después, un
// cliente con quince cosas chicas entraría entero y dejaría afuera la oportunidad más grande
// de otro — el informe diría "las más importantes" y no lo serían. Así: se toman las N
// primeras de la lista (que ya viene ordenada por plata en juego) y esas N se juntan por
// cliente para poder trabajarlas de a una visita.
//
// Los clientes van ordenados por lo que suman: el que más tiene en juego, primero.
export function agruparPorCliente(items, tope, conMargen) {
  const t = Number(tope);
  const cuantas = (Number.isFinite(t) && t > 0) ? Math.min(t, 200) : 25;
  const elegidas = (items || []).slice(0, cuantas);
  const porCliente = new Map();
  for (const x of elegidas) {
    const k = x.titulo || '(sin cliente)';
    if (!porCliente.has(k)) porCliente.set(k, []);
    porCliente.get(k).push(x);
  }
  const grupos = [...porCliente.entries()].map(([cliente, lista]) => ({
    cliente, lista,
    usd: lista.reduce((a, x) => a + (x.usd_en_juego || 0), 0),
    margen: lista.reduce((a, x) => a + (x.margen_en_juego || 0), 0),
  })).sort((a, b) => (conMargen ? b.margen - a.margen : b.usd - a.usd));
  return { elegidas, grupos };
}

export function generarOportunidadesPDF(data, opciones) {
  const o = opciones || {};
  const v = data.ventana || {};
  const conMargen = !!data.ve_margen;
  const armado = agruparPorCliente(data.items, o.tope, conMargen);
  const items = armado.elegidas;

  const doc = new jsPDF();
  const M = 14, W = 210, H = 297;
  let y = 0;
  let pagina = 1;

  // ── Membrete ──────────────────────────────────────────────────────────────────
  const membrete = (subtitulo) => {
    const logo = getLogo();
    if (logo) { try { doc.addImage(logo, "JPEG", M, 9, 46, 15); } catch (e) {} }
    else {
      doc.setFont("helvetica", "bold").setFontSize(15).setTextColor(...AZUL);
      doc.text(EMISOR.marca, M, 18);
    }
    doc.setTextColor(...AZUL).setFont("helvetica", "bold").setFontSize(11);
    doc.text(EMISOR.razon, W - M, 13, { align: "right" });
    doc.setTextColor(...GRIS).setFont("helvetica", "normal").setFontSize(8.5);
    doc.text("CUIT " + EMISOR.cuit, W - M, 19, { align: "right" });
    doc.setDrawColor(...AZUL).setLineWidth(0.6);
    doc.line(M, 27, W - M, 27);
    doc.setFillColor(...AZUL);
    doc.rect(M, 31, W - 2 * M, 11, "F");
    doc.setTextColor(255, 255, 255).setFont("helvetica", "bold").setFontSize(13);
    doc.text("OPORTUNIDADES COMERCIALES", M + 4, 38.5);
    doc.setFontSize(9.5);
    doc.text(subtitulo, W - M - 2, 38.5, { align: "right" });
    doc.setTextColor(...NEGRO);
    y = 49;
  };

  const pie = () => {
    doc.setFont("helvetica", "normal").setFontSize(7.5).setTextColor(...GRIS);
    doc.text("Generado el " + (o.hoy || "") + " · datos al " + ((data.sync || {}).ultimo_ok || "—"),
      M, H - 8);
    doc.text("Página " + pagina, W - M, H - 8, { align: "right" });
    doc.setTextColor(...NEGRO);
  };

  // Salta de página cuando lo que viene no entra. Se llama ANTES de dibujar, con la altura
  // del bloque: partir una oportunidad al medio deja el "qué hacer" huérfano en la página
  // siguiente, sin el nombre del cliente arriba.
  const espacio = (alto) => {
    if (y + alto <= H - 16) return;
    pie();
    doc.addPage(); pagina++;
    membrete(mes(v.mes) + " " + (v.actual || "") + " vs " + (v.anterior || ""));
  };

  const ventanaTxt = mes(v.mes) + " " + (v.actual || "") + " vs " + (v.anterior || "");
  membrete(ventanaTxt);

  // ── De qué habla este informe ──────────────────────────────────────────────────
  doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(...AZUL);
  doc.text("De qué habla este informe", M, y); y += 5.5;
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...NEGRO);
  const intro = "Compara " + mes(v.mes) + " de " + (v.actual || "") + " contra " + mes(v.mes)
    + " de " + (v.anterior || "") + " — el mismo mes, no la campaña entera, para que la "
    + "estacionalidad no ensucie la comparación. De ahí salen las oportunidades de abajo, "
    + "ordenadas por la plata que hay en juego y agrupadas por cliente para poder trabajarlas "
    + "de a una visita.";
  let ls = doc.splitTextToSize(intro, W - 2 * M);
  doc.text(ls, M, y); y += ls.length * 4.4 + 3;

  if (v.en_curso) {
    espacio(16);
    doc.setFillColor(254, 243, 199); doc.setDrawColor(252, 211, 77);
    const av = doc.splitTextToSize(mes(v.mes) + " de " + (v.actual || "")
      + " puede estar a medio facturar y se compara contra el mes entero del año pasado. "
      + "Si algo cae parejo en todos los clientes, mirá primero si no es eso.", W - 2 * M - 8);
    doc.roundedRect(M, y, W - 2 * M, av.length * 4.2 + 7, 1.5, 1.5, "FD");
    doc.setFont("helvetica", "bold").setFontSize(8.5).setTextColor(...AMBAR);
    doc.text("Ojo con el mes en curso", M + 4, y + 5);
    doc.setFont("helvetica", "normal");
    doc.text(av, M + 4, y + 9.5);
    y += av.length * 4.2 + 11;
    doc.setTextColor(...NEGRO);
  }

  // ── El total, y de qué está hecho ──────────────────────────────────────────────
  espacio(30);
  doc.setFillColor(...GRIS_CL);
  doc.roundedRect(M, y, W - 2 * M, 22, 2, 2, "F");
  doc.setFont("helvetica", "bold").setFontSize(19).setTextColor(...AZUL);
  doc.text(String(nr(data.total || 0)), M + 6, y + 10);
  doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...GRIS);
  doc.text("oportunidades detectadas", M + 6, y + 15.5);
  if (conMargen) {
    doc.setFont("helvetica", "bold").setFontSize(19).setTextColor(...VERDE);
    doc.text(usd(data.margen_en_juego_total || 0), W - M - 6, y + 10, { align: "right" });
    doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...GRIS);
    doc.text("de margen sobre la mesa", W - M - 6, y + 15.5, { align: "right" });
  } else {
    const totalUsd = (data.items || []).reduce((a, x) => a + (x.usd_en_juego || 0), 0);
    doc.setFont("helvetica", "bold").setFontSize(19).setTextColor(...AZUL);
    doc.text(usd(totalUsd), W - M - 6, y + 10, { align: "right" });
    doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...GRIS);
    doc.text("en juego en las " + items.length + " de este informe", W - M - 6, y + 15.5, { align: "right" });
  }
  doc.setTextColor(...NEGRO);
  y += 28;

  // ── La guía: qué significa cada cosa y qué hacer ───────────────────────────────
  const presentes = [...new Set(items.map(x => x.tipo))];
  if (presentes.length) {
    espacio(14);
    doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(...AZUL);
    doc.text("Qué significa cada cosa, y qué hacer", M, y); y += 6;
    for (const t of presentes) {
      const g = GUIA[t]; if (!g) continue;
      const lq = doc.splitTextToSize(g.que, W - 2 * M - 6);
      const lh = doc.splitTextToSize("Qué hacer: " + g.hacer, W - 2 * M - 6);
      const alto = 6 + lq.length * 4 + lh.length * 4 + 4;
      espacio(alto);
      doc.setDrawColor(...g.color); doc.setLineWidth(1.4);
      doc.line(M, y - 1, M, y + alto - 6);
      doc.setLineWidth(0.2);
      doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(...g.color);
      doc.text(g.label, M + 4, y + 2.5);
      doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...NEGRO);
      doc.text(lq, M + 4, y + 7);
      doc.setTextColor(...GRIS);
      doc.text(lh, M + 4, y + 7 + lq.length * 4);
      doc.setTextColor(...NEGRO);
      y += alto;
    }
    y += 2;
  }

  // ── Cliente por cliente ────────────────────────────────────────────────────────
  const grupos = armado.grupos;

  espacio(14);
  doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(...AZUL);
  doc.text("Cliente por cliente — las " + items.length + " más importantes", M, y); y += 7;
  doc.setTextColor(...NEGRO);

  for (const g of grupos) {
    espacio(20);
    // Encabezado del cliente
    doc.setFillColor(...AZUL_CL);
    doc.rect(M, y - 4.5, W - 2 * M, 8, "F");
    doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(...AZUL);
    doc.text(String(g.cliente).slice(0, 52), M + 3, y + 1);
    doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...GRIS);
    doc.text(g.lista.length + (g.lista.length === 1 ? " punto · " : " puntos · ")
      + (conMargen ? usd(g.margen) + " de margen" : usd(g.usd) + " en juego"),
      W - M - 3, y + 1, { align: "right" });
    doc.setTextColor(...NEGRO);
    y += 8;

    for (const x of g.lista) {
      const gu = GUIA[x.tipo] || { label: x.tipo, color: GRIS };
      const lr = doc.splitTextToSize(x.regla || "", W - 2 * M - 46);
      const alto = Math.max(11, lr.length * 3.8 + 7);
      espacio(alto + 2);
      // La franja del color del tipo: en una hoja con veinte renglones, el color es lo que
      // permite barrerla con la vista y encontrar los rojos.
      doc.setFillColor(...gu.color);
      doc.rect(M + 1, y - 3, 1.6, alto - 2, "F");
      doc.setFont("helvetica", "bold").setFontSize(8).setTextColor(...gu.color);
      doc.text(gu.label, M + 5, y);
      doc.setFont("helvetica", "bold").setFontSize(8.5).setTextColor(...NEGRO);
      if (x.detalle) doc.text(String(x.detalle).slice(0, 28), M + 38, y);
      // La plata, a la derecha y alineada: es la columna que se compara de un vistazo.
      doc.setFont("helvetica", "bold").setFontSize(9);
      doc.setTextColor(...(conMargen ? VERDE : AZUL));
      doc.text(conMargen ? usd(x.margen_en_juego || 0) : usd(x.usd_en_juego || 0),
        W - M - 3, y, { align: "right" });
      if (conMargen) {
        doc.setFont("helvetica", "normal").setFontSize(7).setTextColor(...GRIS);
        doc.text("de " + usd(x.usd_en_juego || 0), W - M - 3, y + 3.6, { align: "right" });
      }
      doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...GRIS);
      doc.text(lr, M + 5, y + 4.5);
      doc.setTextColor(...NEGRO);
      y += alto;
      doc.setDrawColor(226, 232, 240); doc.setLineWidth(0.2);
      doc.line(M + 5, y - 2.5, W - M, y - 2.5);
    }
    y += 4;
  }

  // ── De dónde salen estos números ───────────────────────────────────────────────
  espacio(34);
  doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(...AZUL);
  doc.text("De dónde salen estos números", M, y); y += 5;
  const u = data.umbrales || {};
  const notas = [
    "Salen de la base de ventas que se sincroniza todas las noches, comparando el mismo mes comercial de las dos campañas.",
    "Por debajo de " + usd(u.piso_usd || 0) + " no entra nada: es ruido, no una oportunidad.",
  ];
  // Sólo los umbrales de lo que efectivamente aparece: explicar el de un tipo que no está en
  // la lista es relleno, y en un informe que se lee apurado el relleno tapa lo que importa.
  if (presentes.includes("CAIDA_FUERTE")) {
    notas.push("«Caída fuerte» arranca en " + (u.caida_pct || 0) + "% menos que el año pasado.");
  }
  if (presentes.includes("CROSS_SELL")) {
    notas.push("«No le vendemos» pide al menos " + (u.cross_min_clientes || 0) + " clientes del mismo rubro comprando ese producto, y el valor estimado se ajusta por el tamaño del cliente.");
  }
  if (conMargen) notas.push("El orden es por margen en juego, no por facturación: una venta grande de margen fino puede valer menos que una chica de margen bueno.");
  else notas.push("El orden pesa el margen de cada operación. Tu nivel no muestra esos importes, pero la lista y el orden son los mismos que ve la dirección.");
  doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...GRIS);
  for (const t of notas) {
    const l = doc.splitTextToSize("• " + t, W - 2 * M - 2);
    espacio(l.length * 3.8 + 2);
    doc.text(l, M + 1, y); y += l.length * 3.8 + 1.2;
  }
  doc.setTextColor(...NEGRO);

  pie();
  return Buffer.from(doc.output("arraybuffer"));
}
