// src/servicios/galponInformePDF.js
// ══════════════════════════════════════════════════════════════════════════════════════
// 📄 EL INFORME DEL ACUMULADO
// ══════════════════════════════════════════════════════════════════════════════════════
// Andy, 2/11/2026: «quiero que me sumes en la parte de acumulado un buen informe en PDF
// con gráficos. Gráficos de torta. Stock. Usá los emoticones para expresarte».
//
// ── LOS EMOJIS NO ENTRAN EN UN PDF, Y HAY QUE DECIRLO ──────────────────────────────
// Se probó antes de escribir esto: jsPDF con Helvetica dibuja «🍑» como `Ø<ßQ` — los
// dos code units del surrogate pasados por una codificación de 8 bits. En la hoja eso
// son dos caracteres de basura, y los emojis quedarían peor que no estar.
//
// Lo que SÍ entra es un PNG, y Andy ya puede subir uno por presentación desde el
// catálogo (V1125). Así que el informe usa:
//   · el DIBUJO SUBIDO, tal cual, cuando la presentación tiene uno;
//   · un disco del color de su destino cuando sólo tiene un emoji de texto;
//   · e iconos VECTORIALES —dibujados con líneas— para los títulos de sección.
//
// ── POR QUÉ TORTAS, Y DE CUÁNTAS PARTES ────────────────────────────────────────────
// La torta las pidió Andy y es la figura con la que piensa el reparto. Se usan donde
// funcionan: TRES partes (comercial, verde, descarte) con el valor y el porcentaje
// ESCRITOS en cada porción, así nadie tiene que comparar ángulos a ojo. Para el stock
// por presentación, que son siete o más, van barras ordenadas: una torta de siete
// porciones es un rompecabezas.
//
// Los colores son los del galpón y están validados: ΔE 17,4 en el peor par para la
// forma más común de daltonismo. El ámbar tiene poco contraste contra el papel, y por
// eso TODA porción lleva su número escrito — que era la condición para usarlo.
// ══════════════════════════════════════════════════════════════════════════════════════

import { AZUL, GRIS, GRIS_CL, EMISOR, nr, getLogo } from './pdfComun.js';

// Los tres destinos, en el orden del negocio: de mejor a peor.
export const COLORES = {
  comercial: [21, 128, 61],
  verde: [245, 158, 11],
  descarte: [185, 28, 28],
};
const NOMBRES = { comercial: 'Comercial', verde: 'Verde', descarte: 'Descarte' };

const n0 = (v) => nr(Math.round(Number(v) || 0));
const pct = (parte, total) => (total > 0 ? Math.round((parte / total) * 1000) / 10 : 0);

// ── UN DÍA EN 10/12 ─────────────────────────────────────────────────────────────────
// Se parte a mano y no con new Date('2026-12-10'): una fecha sola, sin hora, la toma
// como UTC de medianoche y parada en Argentina eso se muestra como el día anterior.
export function dia(f) {
  const p = String(f || '').split('-');
  return p.length === 3 ? p[2] + '/' + p[1] : (f || '');
}

/* ── LA TORTA ───────────────────────────────────────────────────────────────────────
   Se dibuja con triángulos finos y no con un arco, porque jsPDF no tiene un arco
   relleno: `lines` con curvas Bézier aproxima mal los ángulos grandes y deja la
   porción con el borde recto. Un grado por paso es invisible a simple vista.

   UNA SOLA PORCIÓN es un círculo completo, y eso hay que tratarlo aparte: 360 grados
   de triángulos dejan una costura en el cero. */
export function torta(doc, cx, cy, r, partes) {
  const total = partes.reduce((t, p) => t + Math.max(0, p.valor), 0);
  if (!(total > 0)) return;

  const vivas = partes.filter((p) => p.valor > 0);
  if (vivas.length === 1) {
    doc.setFillColor(...vivas[0].color);
    doc.circle(cx, cy, r, 'F');
    return;
  }

  let desde = -90;                       // arranca arriba, como un reloj
  for (const p of vivas) {
    const barre = (p.valor / total) * 360;
    doc.setFillColor(...p.color);
    for (let a = 0; a < barre; a += 1) {
      /* CADA TRIÁNGULO PISA AL SIGUIENTE un poco. Pegados exactamente, el antialiasing
         del visor deja una raya blanca de medio píxel en cada junta y la porción sale
         rayada como un abanico — se ve en pantalla y se ve impreso. Dos décimas de
         grado de solape lo tapan y no desbordan la porción, porque el último se
         recorta contra el barrido. */
      const a1 = ((desde + a) * Math.PI) / 180;
      const a2 = ((desde + Math.min(a + 1.2, barre)) * Math.PI) / 180;
      doc.triangle(cx, cy,
        cx + r * Math.cos(a1), cy + r * Math.sin(a1),
        cx + r * Math.cos(a2), cy + r * Math.sin(a2), 'F');
    }
    desde += barre;
  }

  /* El hueco del medio. Una dona en vez de una torta llena: el centro sirve para el
     total, que es el número que se busca primero, y además corta las puntas donde las
     porciones chicas se confunden. */
  doc.setFillColor(255, 255, 255);
  doc.circle(cx, cy, r * 0.52, 'F');
}

/* Las etiquetas van AFUERA y con una guía hasta su porción: adentro, una porción de
   tres grados no tiene lugar para «1.234 kg · 2%» y el número termina pisando al de al
   lado. Afuera siempre entra, y el reparto se lee igual. */
function etiquetas(doc, cx, cy, r, partes) {
  const total = partes.reduce((t, p) => t + Math.max(0, p.valor), 0);
  if (!(total > 0)) return;

  const vivas = partes.filter((x) => x.valor > 0);
  const ALTO = 9;                       // lo que mide una etiqueta de dos renglones
  const x = cx + r + 10;

  // Dónde querría estar cada una: a la altura del medio de su porción.
  let desde = -90;
  const filas = vivas.map((p) => {
    const barre = (p.valor / total) * 360;
    const medio = ((desde + barre / 2) * Math.PI) / 180;
    desde += barre;
    return { p, medio, ideal: cy + r * Math.sin(medio) };
  }).sort((a, b) => a.ideal - b.ideal);

  /* Y dónde entra: de arriba hacia abajo, empujando la que se pisaría con la anterior.
     Sin esto, dos porciones chicas y vecinas escriben una encima de la otra y no se
     lee ninguna de las dos. */
  let piso = cy - r - 4;
  for (const f of filas) {
    f.y = Math.max(f.ideal, piso);
    piso = f.y + ALTO;
  }
  // Si el apilado se fue para abajo, se sube el conjunto para dejarlo centrado.
  const sobra = (filas[filas.length - 1].y + ALTO) - (cy + r + 6);
  if (sobra > 0) for (const f of filas) f.y -= Math.min(sobra, 8);

  for (const f of filas) {
    const x1 = cx + (r + 1) * Math.cos(f.medio);
    const y1 = cy + (r + 1) * Math.sin(f.medio);
    if (Math.cos(f.medio) >= -0.1) {
      doc.setDrawColor(175, 175, 175);
      doc.setLineWidth(0.3);
      // Del borde de la porción, un tramo radial corto, y el codo hasta su renglón.
      const qx = cx + (r + 4) * Math.cos(f.medio);
      const qy = cy + (r + 4) * Math.sin(f.medio);
      doc.line(x1, y1, qx, qy);
      doc.line(qx, qy, x - 2, f.y - 1);
    }

    // El cuadradito de color: ata el renglón a su porción sin depender de la guía.
    doc.setFillColor(...f.p.color);
    doc.rect(x, f.y - 3.2, 2.2, 2.2, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(40, 40, 40);
    doc.text(n0(f.p.valor) + ' kg', x + 3.4, f.y - 1.2);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...GRIS);
    doc.text(f.p.nombre + ' · ' + pct(f.p.valor, total) + '%', x + 3.4, f.y + 2.4);
  }
}

// El total, en el agujero de la dona: es el número que se busca primero.
function centroTorta(doc, cx, cy, total, rotulo) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(30, 30, 30);
  doc.text(n0(total), cx, cy + 0.5, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...GRIS);
  doc.text(rotulo, cx, cy + 4.5, { align: 'center' });
}

/* ── BARRAS ORDENADAS, PARA EL STOCK ────────────────────────────────────────────────
   Siete presentaciones en una torta es un rompecabezas: las porciones chicas no se
   distinguen y el orden no se ve. Barras desde una misma base se comparan de un
   vistazo y además entran los nombres largos. */
function barras(doc, x, y, ancho, filas, color) {
  const max = Math.max(...filas.map((f) => f.valor), 1);
  const alto = 7;
  let yy = y;
  for (const f of filas) {
    doc.setFontSize(8);
    doc.setTextColor(40, 40, 40);
    // El nombre se trunca y no se parte: un renglón de alto fijo mantiene la grilla.
    doc.text(recortar(doc, f.nombre, 44), x, yy + 3.4);

    const bx = x + 46;
    const bw = Math.max(0.8, (f.valor / max) * (ancho - 70));
    doc.setFillColor(...(f.color || color));
    doc.roundedRect(bx, yy, bw, alto - 2.4, 0.9, 0.9, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(40, 40, 40);
    const vt = n0(f.valor) + (f.unidad ? (' ' + f.unidad) : '');
    doc.text(vt, bx + bw + 2, yy + 3.4);
    if (f.extra) {
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...GRIS);
      doc.text('· ' + f.extra, bx + bw + 4 + doc.getTextWidth(vt), yy + 3.4);
    }
    doc.setFont('helvetica', 'normal');
    yy += alto;
  }
  return yy;
}

function recortar(doc, txt, mm) {
  let t = String(txt == null ? '' : txt);
  if (doc.getTextWidth(t) <= mm) return t;
  while (t.length > 1 && doc.getTextWidth(t + '…') > mm) t = t.slice(0, -1);
  return t + '…';
}

/* ── EL DIBUJITO DE UNA PRESENTACIÓN ────────────────────────────────────────────────
   El PNG subido si lo hay; si no, un disco del color de su destino. El emoji de texto
   NO se puede dibujar —Helvetica lo convierte en basura— y por eso en su lugar va el
   disco: dice menos, pero dice algo cierto. */
function dibujito(doc, x, y, lado, f, iconos) {
  const png = iconos && f.presentacion_id ? iconos[f.presentacion_id] : null;
  if (png) {
    try {
      doc.addImage(png, 'PNG', x, y, lado, lado);
      return;
    } catch (e) { /* un PNG roto no se lleva puesto el informe */ }
  }
  doc.setFillColor(...(COLORES[f.destino] || [150, 150, 150]));
  doc.circle(x + lado / 2, y + lado / 2, lado / 2.6, 'F');
}

// ── ICONOS DE SECCIÓN, DIBUJADOS ────────────────────────────────────────────────────
// En vez del emoji que no se puede imprimir. Son cuatro trazos y se entienden.
function iconoSeccion(doc, x, y, cual) {
  doc.setDrawColor(...AZUL);
  doc.setFillColor(...AZUL);
  doc.setLineWidth(0.5);
  if (cual === 'torta') {
    doc.circle(x + 2.2, y - 1.2, 2.2, 'S');
    doc.line(x + 2.2, y - 1.2, x + 2.2, y - 3.4);
    doc.line(x + 2.2, y - 1.2, x + 4.4, y - 1.2);
  } else if (cual === 'caja') {
    doc.rect(x, y - 3.6, 4.6, 3.6, 'S');
    doc.line(x, y - 2.2, x + 4.6, y - 2.2);
  } else if (cual === 'barras') {
    doc.rect(x, y - 1.6, 1.2, 1.6, 'F');
    doc.rect(x + 1.7, y - 3.2, 1.2, 3.2, 'F');
    doc.rect(x + 3.4, y - 4.4, 1.2, 4.4, 'F');
  } else if (cual === 'calendario') {
    doc.rect(x, y - 3.6, 4.6, 3.6, 'S');
    doc.line(x, y - 2.6, x + 4.6, y - 2.6);
    doc.line(x + 1.4, y - 4.2, x + 1.4, y - 3.2);
    doc.line(x + 3.2, y - 4.2, x + 3.2, y - 3.2);
  }
  doc.setLineWidth(0.2);
}

function titulo(doc, x, y, texto, icono, hasta) {
  iconoSeccion(doc, x, y, icono);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(...AZUL);
  doc.text(texto, x + 7, y);
  doc.setFont('helvetica', 'normal');
  doc.setDrawColor(...AZUL);
  doc.setLineWidth(0.4);
  doc.line(x, y + 1.8, hasta == null ? 196 : hasta, y + 1.8);
  doc.setLineWidth(0.2);
  return y + 8;
}

function encabezado(doc, d, logo) {
  if (logo) { try { doc.addImage(logo, 'PNG', 14, 10, 26, 13); } catch (e) { /* sigue */ } }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...AZUL);
  doc.text('Informe del galpón', 44, 17);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...GRIS);
  doc.text(EMISOR.marca + ' · ' + EMISOR.razon, 44, 22);

  const per = (d.desde || d.hasta)
    ? ('Del ' + dia(d.desde) + ' al ' + dia(d.hasta))
    : 'Toda la temporada';
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(40, 40, 40);
  doc.text(per, 196, 17, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...GRIS);
  doc.text('Emitido el ' + dia(d.hoy) + (d.usuario ? (' · ' + d.usuario) : ''),
    196, 21.5, { align: 'right' });

  doc.setDrawColor(...AZUL);
  doc.setLineWidth(0.6);
  doc.line(14, 26, 196, 26);
  doc.setLineWidth(0.2);
  return 34;
}

// Los números que se miran primero, en tarjetas.
function tarjetas(doc, y, items) {
  const ancho = (182 - (items.length - 1) * 4) / items.length;
  let x = 14;
  for (const it of items) {
    doc.setFillColor(...GRIS_CL);
    doc.roundedRect(x, y, ancho, 18, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(...(it.color || [30, 30, 30]));
    doc.text(n0(it.valor), x + ancho / 2, y + 9, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...GRIS);
    doc.text(it.rotulo, x + ancho / 2, y + 14, { align: 'center' });
    x += ancho + 4;
  }
  return y + 24;
}

function pie(doc) {
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.text(EMISOR.marca + ' · informe del galpón', 14, 290);
    doc.text('Página ' + i + ' de ' + n, 196, 290, { align: 'right' });
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════
   EL INFORME
   ══════════════════════════════════════════════════════════════════════════════════ */
export async function galponInformePDF(datos, opts) {
  const d = datos || {};
  const o = opts || {};
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });

  let y = encabezado(doc, d, getLogo());

  // ── LOS NÚMEROS DE ARRIBA ──────────────────────────────────────────────────────
  const tot = d.totales || {};
  y = tarjetas(doc, y, [
    { valor: tot.kilos, rotulo: 'KG INGRESADOS' },
    { valor: tot.procesado, rotulo: 'KG PROCESADOS' },
    { valor: tot.comercial, rotulo: 'KG COMERCIALES', color: COLORES.comercial },
    { valor: tot.stock, rotulo: 'KG EN CÁMARA' },
    { valor: tot.dias, rotulo: 'DÍAS' },
  ]);

  // ── 🥧 LAS DOS TORTAS, LADO A LADO ─────────────────────────────────────────────
  const rinde = [
    { nombre: 'Comercial', valor: Number(tot.comercial) || 0, color: COLORES.comercial },
    { nombre: 'Verde', valor: Number(tot.verde) || 0, color: COLORES.verde },
    { nombre: 'Descarte', valor: Number(tot.descarte) || 0, color: COLORES.descarte },
  ];
  const totRinde = rinde.reduce((t, x) => t + x.valor, 0);

  const st = d.stock || {};
  const porDest = (st.destinos || []).map((x) => ({
    nombre: NOMBRES[x.clave] || x.clave,
    valor: Number(x.kilos) || 0,
    bultos: Number(x.bultos) || 0,
    color: COLORES[x.clave] || [150, 150, 150],
  }));
  const totStock = porDest.reduce((t, x) => t + x.valor, 0);

  const yTortas = y;
  // Izquierda: cómo rindió.
  y = titulo(doc, 14, y, 'Cómo rindió la fruta', 'torta', 102);
  if (totRinde > 0) {
    torta(doc, 36, y + 23, 17, rinde);
    etiquetas(doc, 36, y + 23, 17, rinde);
    centroTorta(doc, 36, y + 23, totRinde, 'kg procesados');
    /* El número que se busca: qué parte se vende. Una torta contesta «cómo se reparte»
       y no «cuánto es lo bueno», que es la pregunta de la temporada. */
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(19);
    doc.setTextColor(...COLORES.comercial);
    doc.text(pct(rinde[0].valor, totRinde) + '%', 36, y + 52, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...GRIS);
    doc.text('salió comercial', 36, y + 57, { align: 'center' });
  } else {
    doc.setFontSize(8.5);
    doc.setTextColor(...GRIS);
    doc.text('Todavía no se procesó nada.', 14, y + 4);
  }

  // Derecha: lo que hay en cámara.
  let yD = titulo(doc, 108, yTortas, 'Lo que hay en cámara', 'caja', 196);
  if (totStock > 0) {
    torta(doc, 130, yD + 23, 17, porDest);
    etiquetas(doc, 130, yD + 23, 17, porDest);
    centroTorta(doc, 130, yD + 23, totStock, 'kg guardados');
    /* En CAJAS abajo, que es la unidad del camión. Andy, 31/10/2026: «los stock van en
       cajas porque necesitamos saber qué cargar». El total va en kilos porque sumar
       cajas de 8 kg con bines de 400 no significa nada físico. */
    let yy = yD + 50;
    for (const x of porDest) {
      doc.setFillColor(...x.color);
      doc.circle(112, yy - 1.1, 1.3, 'F');
      doc.setFontSize(7.5);
      doc.setTextColor(40, 40, 40);
      doc.text(x.nombre, 116, yy);
      doc.setFont('helvetica', 'bold');
      doc.text(n0(x.bultos) + ' cj', 196, yy, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      yy += 5;
    }
  } else {
    doc.setFontSize(8.5);
    doc.setTextColor(...GRIS);
    doc.text('No hay nada en cámara.', 108, yD + 4);
  }
  y = yTortas + 70;

  // ── 📊 EL STOCK POR PRESENTACIÓN ───────────────────────────────────────────────
  const pres = (d.presentaciones || []).filter((x) => (x.bultos > 0 || x.kilos > 0));
  if (pres.length) {
    if (y + 16 + Math.min(pres.length, 14) * 7 > 280) { doc.addPage(); y = 20; }
    y = titulo(doc, 14, y, 'Por presentación', 'barras');
    /* Barras y no torta: con siete presentaciones las porciones chicas no se
       distinguen y el orden —que es lo que importa— no se ve. */
    const ALTO_FILA = 7;
    pres.slice(0, 14).forEach((f, i) => {
      dibujito(doc, 14, y - 5 + i * ALTO_FILA, 4.4, f, o.iconos);
    });
    y = barras(doc, 20, y - 4.6, 176, pres.slice(0, 14).map((f) => ({
      nombre: (f.nombre || 'A granel') + (f.calibre ? (' ' + f.calibre) : ''),
      valor: Number(f.kilos) || 0,
      unidad: 'kg',
      /* Las cajas al lado del kilaje: la barra compara y el texto cuenta. Un granel no
         tiene cajas y por eso no dice "0 cj", que se leería como que no hay nada. */
      extra: f.granel ? 'a granel' : (n0(f.bultos) + ' cj'),
      color: COLORES[f.destino] || [150, 150, 150],
    })), AZUL) + 6;
    if (pres.length > 14) {
      doc.setFontSize(7.5);
      doc.setTextColor(...GRIS);
      doc.text('y ' + (pres.length - 14) + ' presentaciones más', 20, y);
      y += 6;
    }
  }

  // ── 📅 LO PROCESADO DÍA POR DÍA ────────────────────────────────────────────────
  const dias = (d.por_dia || []).filter((x) => x.procesado > 0 || x.kilos > 0);
  if (dias.length) {
    if (y + 62 > 280) { doc.addPage(); y = 20; }
    y = titulo(doc, 14, y, 'Día por día', 'calendario');
    y = columnas(doc, 14, y, 182, 42, dias.slice(-28));
    y += 8;
  }

  // ── 📋 EL RINDE POR LOTE ───────────────────────────────────────────────────────
  const lotes = (d.rinde || []).filter((x) => x.kilos > 0);
  if (lotes.length) {
    // El encabezado más tres renglones: menos que eso, la tabla arranca huérfana.
    if (y + 34 > 280) { doc.addPage(); y = 20; }
    y = titulo(doc, 14, y, 'Rinde por lote', 'barras');
    y = tablaLotes(doc, y, lotes.slice(0, 18));
  }

  pie(doc);
  return Buffer.from(doc.output('arraybuffer'));
}

/* ── LAS COLUMNAS DEL DÍA A DÍA ─────────────────────────────────────────────────────
   Apiladas por destino: cada día es una columna y adentro se ve el reparto. Un día que
   rindió mal se nota por la proporción de rojo, que es lo que se busca al recorrer la
   semana.

   Se recorta a los últimos 28 días: más que eso no entra a lo ancho de una A4 sin que
   las columnas queden de un milímetro. */
function columnas(doc, x, y, ancho, alto, dias) {
  const max = Math.max(...dias.map((d) => Number(d.procesado) || Number(d.kilos) || 0), 1);
  const paso = ancho / dias.length;
  const w = Math.max(1.5, Math.min(9, paso - 1.6));
  const base = y + alto;

  doc.setDrawColor(225, 225, 225);
  doc.setLineWidth(0.2);
  doc.line(x, base, x + ancho, base);

  dias.forEach((d, i) => {
    const cx = x + i * paso + (paso - w) / 2;
    const total = Number(d.procesado) || Number(d.kilos) || 0;
    const partes = [
      { v: Number(d.comercial) || 0, c: COLORES.comercial },
      { v: Number(d.verde) || 0, c: COLORES.verde },
      { v: Number(d.descarte) || 0, c: COLORES.descarte },
    ].filter((p) => p.v > 0);
    const suma = partes.reduce((t, p) => t + p.v, 0) || total;

    let yy = base;
    for (const p of partes) {
      /* El alto sale de la parte sobre el MÁXIMO del período, no sobre el total del
         día: si fuera sobre el día, todas las columnas medirían lo mismo y el gráfico
         no diría cuánto se procesó. */
      const h = (p.v / max) * alto;
      doc.setFillColor(...p.c);
      doc.rect(cx, yy - h, w, h, 'F');
      /* Dos décimas de papel entre bloque y bloque: pegados, dos colores oscuros se
         leen como uno solo. */
      yy -= h + 0.2;
    }
    if (!partes.length && total > 0) {
      const h = (total / max) * alto;
      doc.setFillColor(...GRIS);
      doc.rect(cx, base - h, w, h, 'F');
    }
    // La fecha, una de cada dos si son muchas: pegadas se pisan.
    if (dias.length <= 16 || i % 2 === 0) {
      doc.setFontSize(5.6);
      doc.setTextColor(...GRIS);
      doc.text(dia(d.fecha), cx + w / 2, base + 3.2, { align: 'center' });
    }
    if (suma !== total && total > 0) { /* el día tiene algo sin desglosar: no se marca */ }
  });

  // La referencia: tres cuadraditos, una sola vez.
  let lx = x;
  const ly = base + 8;
  for (const k of ['comercial', 'verde', 'descarte']) {
    doc.setFillColor(...COLORES[k]);
    doc.rect(lx, ly - 2, 2.4, 2.4, 'F');
    doc.setFontSize(7);
    doc.setTextColor(...GRIS);
    doc.text(NOMBRES[k], lx + 3.4, ly);
    lx += doc.getTextWidth(NOMBRES[k]) + 11;
  }
  // Y la escala, que sin eje es lo único que dice cuánto mide una columna.
  doc.setFontSize(6.5);
  doc.setTextColor(...GRIS);
  doc.text('la más alta: ' + n0(max) + ' kg', x + ancho, ly, { align: 'right' });
  return ly + 2;
}

function tablaLotes(doc, y, lotes) {
  const cols = [
    { t: 'Lote', x: 14, a: 'left', w: 46 },
    { t: 'Finca', x: 62, a: 'left', w: 34 },
    { t: 'Ingresado', x: 118, a: 'right' },
    { t: 'Comercial', x: 146, a: 'right' },
    { t: 'Rinde', x: 196, a: 'right' },
  ];
  doc.setFillColor(...GRIS_CL);
  doc.rect(14, y - 4, 182, 6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...GRIS);
  for (const c of cols) doc.text(c.t, c.x, y, { align: c.a });
  doc.setFont('helvetica', 'normal');
  y += 6;

  for (const l of lotes) {
    if (y > 278) { doc.addPage(); y = 20; }
    doc.setFontSize(8);
    doc.setTextColor(40, 40, 40);
    doc.text(recortar(doc, l.nombre || ('Lote ' + l.lote_id), 44), 14, y);
    doc.setTextColor(...GRIS);
    doc.text(recortar(doc, l.finca || '—', 32), 62, y);
    doc.setTextColor(40, 40, 40);
    doc.text(n0(l.kilos), 118, y, { align: 'right' });
    doc.text(n0(l.comercial), 146, y, { align: 'right' });

    /* El rinde con su barrita al lado: la columna de números compara mal entre
       renglones lejanos, y la barra se barre de un vistazo. */
    const r = l.rinde == null ? null : Number(l.rinde);
    if (r != null) {
      const bw = Math.max(0.6, (Math.min(r, 100) / 100) * 28);
      doc.setFillColor(...COLORES.comercial);
      doc.roundedRect(154, y - 2.6, bw, 3, 0.6, 0.6, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(40, 40, 40);
      doc.text(r + '%', 196, y, { align: 'right' });
      doc.setFont('helvetica', 'normal');
    } else {
      doc.setTextColor(...GRIS);
      doc.text('—', 196, y, { align: 'right' });
    }
    doc.setDrawColor(238, 238, 238);
    doc.line(14, y + 1.6, 196, y + 1.6);
    y += 6.4;
  }
  return y;
}
