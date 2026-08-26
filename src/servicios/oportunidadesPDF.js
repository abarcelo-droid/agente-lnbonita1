// src/servicios/oportunidadesPDF.js
// ── EL RADAR, EN PAPEL, PARA SALIR A TRABAJAR ────────────────────────────────────────
// El informe del comercial. No es la pantalla impresa: la pantalla ordena por plata y sirve
// para decidir a qué apuntar; el papel se lleva a una visita.
//
// Tiene tres cuerpos, porque son tres formas distintas de mirar el mismo mes y cada una
// contesta una pregunta que las otras no:
//
//   1. POR CLIENTE — las oportunidades más importantes, agrupadas. Una visita es un cliente,
//      y tenerlas desparramadas en una lista ordenada por importe obliga a rearmarlas a mano
//      antes de salir.
//   2. POR PRODUCTO — el foco puesto en la mercadería: de este producto, a quién le dejamos
//      de vender, a quién le vendemos menos, y de qué proveedor dejó de venir. Es la mirada
//      del que compra, no la del que vende.
//   3. CLIENTES PERDIDOS EN DETALLE — el que no compró nada, abierto en qué llevaba y de qué
//      proveedor era. Es lo que hace falta para saber si reponerlo es posible ANTES de ir.
//
// Y LA LEYENDA VA AL FINAL. Es de consulta: se lee una vez y después se vuelve a ella cuando
// algo no se entiende. Adelante empujaba hacia abajo lo único que se mira todos los días.
//
// El que lo recibe no estuvo en la conversación donde se definieron las reglas, así que cada
// sección abre diciendo cómo se lee. Un listado de nombres y números sin eso se lee como un
// reproche, no como una herramienta.
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

  const presentes = [...new Set(items.map(x => x.tipo))];

  // Helpers de sección, para que las tres se vean iguales y expliquen igual.
  const titulo = (txt, bajada) => {
    espacio(bajada ? 20 : 13);
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...AZUL);
    doc.text(txt, M, y); y += 5;
    if (bajada) {
      doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...GRIS);
      const l = doc.splitTextToSize(bajada, W - 2 * M);
      doc.text(l, M, y); y += l.length * 3.9 + 2;
    }
    doc.setTextColor(...NEGRO);
    doc.setDrawColor(...AZUL); doc.setLineWidth(0.4);
    doc.line(M, y, W - M, y); y += 5;
    doc.setLineWidth(0.2);
  };
  // Una lista chica con rótulo. Cuando está vacía se DICE que está vacía: un espacio en
  // blanco se lee como "no lo calculamos", y "no perdimos ninguno" es una buena noticia.
  const listita = (rotulo, color, filas, vacia) => {
    const alto = 5 + Math.max(1, filas.length) * 4.2;
    espacio(alto + 2);
    doc.setFont("helvetica", "bold").setFontSize(8).setTextColor(...color);
    doc.text(rotulo, M + 4, y); y += 4.4;
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...NEGRO);
    if (!filas.length) {
      doc.setTextColor(...GRIS);
      doc.text(vacia || "Ninguno.", M + 8, y); y += 4.6;
      doc.setTextColor(...NEGRO);
      return;
    }
    for (const f of filas) {
      espacio(6);
      const der = f.der || "";
      const izq = doc.splitTextToSize(String(f.izq), W - 2 * M - 20 - doc.getTextWidth(der));
      doc.text(izq[0], M + 8, y);
      if (der) {
        doc.setFont("helvetica", "bold");
        doc.text(der, W - M - 3, y, { align: "right" });
        doc.setFont("helvetica", "normal");
      }
      y += 4.2;
    }
    y += 1;
  };

  // ── 1. Cliente por cliente ─────────────────────────────────────────────────────
  const grupos = armado.grupos;

  titulo("1 · Cliente por cliente — las " + items.length + " más importantes",
    "Cada cliente con lo que hay en juego con él, para poder trabajarlo de una sola vez. "
    + "El color de la barra dice de qué tipo es cada punto; qué significa cada tipo y qué "
    + "hacer con él está en la última página.");

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

  // ── 2. POR PRODUCTO ────────────────────────────────────────────────────────────
  // La mirada de la mercadería: acá el sujeto es el producto y los clientes son el detalle.
  // Es la vuelta exacta de la sección 1, y por eso vale la pena tenerlas las dos: la misma
  // caída se ve como "perdimos a COTO" o como "la cebolla se cayó", y no se actúa igual.
  const prods = data.por_producto || [];
  if (prods.length) {
    titulo("2 · Por producto — de dónde viene y a dónde va",
      "Los " + prods.length + " productos que más se movieron contra el año pasado, para "
      + "arriba o para abajo. De cada uno: a qué cliente le dejamos de vender, a cuál le "
      + "vendemos bastante menos, y de qué proveedor dejó de venir la mercadería.");

    for (const p of prods) {
      espacio(30);
      const sube = (p.var_usd || 0) >= 0;
      doc.setFillColor(...AZUL_CL);
      doc.rect(M, y - 4.5, W - 2 * M, 8, "F");
      doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(...AZUL);
      doc.text(String(p.producto).slice(0, 40), M + 3, y + 1);
      doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(...(sube ? VERDE : ROJO));
      doc.text((sube ? "+" : "") + usd(p.var_usd) + (p.var_usd_pct != null ? "  (" + (sube ? "+" : "") + p.var_usd_pct + "%)" : ""),
        W - M - 3, y + 1, { align: "right" });
      doc.setTextColor(...NEGRO);
      y += 8.5;

      // La línea de contexto: los dos años, en plata, kilos y cuántos clientes. Sin los
      // clientes no se distingue "vendemos menos a los mismos" de "nos quedamos sin clientes".
      doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...GRIS);
      doc.text(v.anterior + ": " + usd(p.usd_ant) + " · " + kg(p.kg_ant) + " · " + p.clientes_ant + " cliente(s)"
        + "     |     " + v.actual + ": " + usd(p.usd_act) + " · " + kg(p.kg_act) + " · " + p.clientes_act + " cliente(s)",
        M + 4, y);
      doc.setTextColor(...NEGRO);
      y += 5.5;

      listita("Clientes que dejaron de llevarlo", ROJO,
        p.clientes_perdidos.map(c => ({ izq: c.cliente + "  ·  llevaba " + kg(c.kg_ant), der: usd(c.usd_ant) })),
        "Ninguno: los que lo compraban, lo siguen comprando.");
      listita("Clientes que llevan bastante menos", AMBAR,
        p.clientes_menos.map(c => ({
          izq: c.cliente + "  ·  " + kg(c.kg_ant) + " → " + kg(c.kg_act) + "  (" + c.caida_pct + "%)",
          der: usd(c.usd_ant) + " → " + usd(c.usd_act) })),
        "Ninguno cayó más del umbral.");
      listita("Proveedores que dejaron de traerlo", AZULC,
        p.proveedores_perdidos.map(x => ({ izq: x.proveedor + "  ·  traía " + kg(x.kg_ant), der: usd(x.usd_ant) })),
        "Ninguno: la mercadería sigue viniendo de los mismos.");
      if (p.proveedores_hoy.length) {
        listita("De quién viene hoy", VERDE,
          p.proveedores_hoy.map(x => ({ izq: x.proveedor + (x.es_nuevo ? "  ·  NUEVO este año" : ""), der: usd(x.usd_act) + " · " + kg(x.kg_act) })));
      }
      y += 3;
    }
  }

  // ── 3. CLIENTES PERDIDOS, EN DETALLE ───────────────────────────────────────────
  const perdidos = data.clientes_perdidos || [];
  if (perdidos.length) {
    titulo("3 · Clientes perdidos — qué llevaban y de quién era",
      "Los que compraban en este mes del año pasado y este año no compraron nada. Abierto en "
      + "qué se llevaban y de qué proveedor venía esa mercadería: es lo que hace falta para "
      + "saber si reponerlo es posible ANTES de ir a buscarlo.");

    for (const c of perdidos) {
      espacio(24);
      doc.setFillColor(254, 226, 226);
      doc.rect(M, y - 4.5, W - 2 * M, 8, "F");
      doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(...ROJO);
      doc.text(String(c.cliente).slice(0, 44), M + 3, y + 1);
      doc.setFont("helvetica", "bold").setFontSize(9);
      doc.text(usd(c.usd) + "  ·  " + kg(c.kg), W - M - 3, y + 1, { align: "right" });
      doc.setTextColor(...NEGRO);
      y += 8.5;
      if (c.vendedor) {
        doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...GRIS);
        doc.text("Lo atendía " + c.vendedor + " · " + mes(v.mes) + " de " + v.anterior, M + 4, y);
        doc.setTextColor(...NEGRO);
        y += 5;
      }
      // Encabezado de las tres columnas: sin rótulo, "GIGLIO" al lado de "CEBOLLA" no dice
      // si es otro producto o de dónde vino.
      doc.setFont("helvetica", "bold").setFontSize(7.5).setTextColor(...GRIS);
      doc.text("PRODUCTO", M + 8, y);
      doc.text("VENÍA DE", M + 68, y);
      doc.text("KILOS", W - M - 42, y, { align: "right" });
      doc.text("USD", W - M - 3, y, { align: "right" });
      doc.setTextColor(...NEGRO);
      y += 4;
      doc.setFont("helvetica", "normal").setFontSize(8);
      for (const l of c.lineas) {
        espacio(6);
        doc.text(String(l.producto).slice(0, 30), M + 8, y);
        doc.setTextColor(...GRIS);
        doc.text(String(l.proveedor).slice(0, 26), M + 68, y);
        doc.setTextColor(...NEGRO);
        doc.text(kg(l.kg), W - M - 42, y, { align: "right" });
        doc.setFont("helvetica", "bold");
        doc.text(usd(l.usd), W - M - 3, y, { align: "right" });
        doc.setFont("helvetica", "normal");
        y += 4.3;
      }
      y += 4;
    }
  }

  // ── ÚLTIMA PÁGINA: la leyenda ──────────────────────────────────────────────────
  // Va sola y al final, con salto de página forzado. Es material de consulta: se lee una vez
  // y se vuelve a ella cuando algo no se entiende. Adelante empujaba hacia abajo lo único
  // que se mira todos los días, y la primera hoja de un informe es la que se mira.
  pie();
  doc.addPage(); pagina++;
  membrete("Cómo se lee este informe");

  doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...AZUL);
  doc.text("Qué significa cada cosa, y qué hacer", M, y); y += 6;
  doc.setTextColor(...NEGRO);
  // Los cinco tipos, aparezcan o no en este informe: es una hoja de referencia, y el mes que
  // viene el que la guardó se va a encontrar con los que hoy no salieron.
  for (const t of Object.keys(GUIA)) {
    const g = GUIA[t];
    const lq = doc.splitTextToSize(g.que, W - 2 * M - 6);
    const lh = doc.splitTextToSize("Qué hacer: " + g.hacer, W - 2 * M - 6);
    const alto = 6 + lq.length * 4 + lh.length * 4 + 4;
    espacio(alto);
    doc.setDrawColor(...g.color); doc.setLineWidth(1.4);
    doc.line(M, y - 1, M, y + alto - 6);
    doc.setLineWidth(0.2);
    doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(...g.color);
    doc.text(g.label + (presentes.includes(t) ? "" : "   (no aparece en este informe)"), M + 4, y + 2.5);
    doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...NEGRO);
    doc.text(lq, M + 4, y + 7);
    doc.setTextColor(...GRIS);
    doc.text(lh, M + 4, y + 7 + lq.length * 4);
    doc.setTextColor(...NEGRO);
    y += alto;
  }
  y += 3;

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
  notas.push("El PROVEEDOR sale de la base de VENTAS: es de dónde vino la mercadería que vendimos. No es un libro de compras — «dejó de traerlo» quiere decir que ese mes no apareció mercadería suya en lo que vendimos.");
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
