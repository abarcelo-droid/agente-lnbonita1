// src/servicios/galponPalletPDF.js
// ── EL TARJETÓN DEL PALLET ───────────────────────────────────────────────────────────
// Andy, 1/11/2026: «de ahí quiero que salga un tarjetón para imprimir», con dos modelos
// de referencia: uno homogéneo con el producto en letras enormes y uno mixto con una
// línea por artículo.
//
// ── EL MODELO LO ELIGE EL CONTENIDO, NO EL QUE IMPRIME ──────────────────────────────
// Un pallet con un solo artículo sale con el nombre grande; con dos o más, con la tabla.
// Dejarlo a criterio de quien imprime es una etiqueta que dice DAMASCO en letras de diez
// centímetros sobre un pallet que abajo tiene ciruela.
//
// ── POR QUÉ ESTÁ PENSADO PARA LEERSE DE LEJOS ───────────────────────────────────────
// Esta hoja se mira desde un autoelevador y con un pallet de por medio. Lo que tiene que
// leerse a tres metros es el NÚMERO y, si es homogéneo, el producto. Lo demás —RENSPA,
// cuartel, lote— se lee de cerca, cuando alguien va a buscar algo puntual, y por eso va
// en cajas chicas abajo.
//
// ── Y EL QR LLEVA EL NÚMERO PELADO ──────────────────────────────────────────────────
// Igual que las tarjetas de cuadrilla: la lectora USB se comporta como un teclado, y una
// URL adentro del QR escribiría la URL entera en el casillero donde se espera el número.
import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import { getLogo } from './pdfComun.js';

// A4 apaisado. Es la hoja que hay en cualquier impresora del galpón, y entra entera en
// una funda portaetiquetas de pallet.
const A = { ancho: 297, alto: 210 };
const M = 10;                      // el margen del marco

const ROJO = [155, 34, 50];        // el bordó de la marca
const NEGRO = [26, 26, 26];
const GRIS = [110, 110, 110];
const GRIS_CL = [235, 237, 240];

const n0 = (v) => Number(v || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 });
const n2 = (v) => Number(v || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 });
const S = (v) => String(v == null ? '' : v);

// La fecha, como se escribe acá y no como la guarda la base.
function fechaAr(f) {
  const p = S(f).split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : S(f);
}

/* Achica el texto hasta que entre. Un nombre largo —«Damasco Castle Brite»— con el
   tamaño fijo del modelo se sale del marco y jsPDF lo dibuja igual, pisando el QR. */
function medida(doc, texto, maxAncho, desde, minimo) {
  let t = desde;
  doc.setFontSize(t);
  while (t > minimo && doc.getTextWidth(texto) > maxAncho) {
    t -= 1;
    doc.setFontSize(t);
  }
  return t;
}

function chapa(doc, x, y, texto, fondo, tinta, alto, tam) {
  doc.setFontSize(tam);
  doc.setFont('helvetica', 'bold');
  const w = doc.getTextWidth(texto) + 8;
  doc.setFillColor(...fondo);
  doc.roundedRect(x, y, w, alto, 1.6, 1.6, 'F');
  doc.setTextColor(...tinta);
  doc.text(texto, x + 4, y + alto / 2 + tam * 0.125);
  return w;
}

// Una caja con rótulo chiquito arriba y el dato grande adentro.
function caja(doc, x, y, w, h, rotulo, dato, tamDato) {
  doc.setDrawColor(...GRIS_CL);
  doc.setLineWidth(0.4);
  doc.roundedRect(x, y, w, h, 1.6, 1.6, 'S');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...GRIS);
  doc.text(S(rotulo).toUpperCase(), x + 3, y + 5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...NEGRO);
  const t = medida(doc, S(dato) || '—', w - 6, tamDato || 17, 8);
  doc.text(S(dato) || '—', x + 3, y + 5 + 3 + t * 0.36);
}

function encabezado(doc, pallet, logo, marca) {
  // El marco. Es lo que hace que la hoja se vea como una etiqueta y no como un informe.
  doc.setDrawColor(...ROJO);
  doc.setLineWidth(1.4);
  doc.rect(M / 2, M / 2, A.ancho - M, A.alto - M, 'S');

  if (logo) {
    try { doc.addImage(logo, 'JPEG', M + 2, M + 1, 48, 16); } catch (e) { /* sin logo */ }
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(17);
    doc.setTextColor(...ROJO);
    doc.text(S(marca), M + 2, M + 12);
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...GRIS);
  doc.text('PALLET N°', A.ancho - M - 2, M + 5, { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...ROJO);
  const num = S(pallet.numero) || 'SIN CERRAR';
  const t = medida(doc, num, 110, 30, 14);
  doc.text(num, A.ancho - M - 2, M + 17, { align: 'right' });
  void t;

  // Las chapas de estado, abajo del número. Sólo las que corresponden: una chapa que
  // dice «COMPLETO» en todos los pallets no la mira nadie, y entonces tampoco se mira
  // la que dice PARCIAL.
  let x = A.ancho - M - 2;
  for (const [cond, texto] of [[pallet.parcial, 'PARCIAL'], [pallet.mixto, 'MIXTO']]) {
    if (!cond) continue;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    const w = doc.getTextWidth(texto) + 9;
    x -= w;
    doc.setFillColor(...NEGRO);
    doc.roundedRect(x, M + 20, w, 7.5, 1.6, 1.6, 'F');
    doc.setTextColor(255, 255, 255);
    doc.text(texto, x + 4.5, M + 25.3);
    x -= 3;
  }

  doc.setDrawColor(...ROJO);
  doc.setLineWidth(0.8);
  doc.line(M + 2, M + 31, A.ancho - M - 2, M + 31);
}

function pie(doc, cfg) {
  const y = A.alto - M - 3;
  doc.setDrawColor(...GRIS_CL);
  doc.setLineWidth(0.4);
  doc.line(M + 2, y - 6, A.ancho - M - 2, y - 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...GRIS);
  doc.text('Comercializa: ' + S(cfg.comercializa), M + 2, y - 1);
  doc.text('Origen: ' + S(cfg.origen), A.ancho - M - 2, y - 1, { align: 'right' });
}

function elQR(doc, qr, numero, x, y, lado) {
  if (qr) {
    try { doc.addImage(qr, 'PNG', x, y, lado, lado); } catch (e) { /* sin QR */ }
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...NEGRO);
  doc.text(S(numero), x + lado / 2, y + lado + 7, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...GRIS);
  doc.text('Escanear al cargar el camión', x + lado / 2, y + lado + 12, { align: 'center' });
}

// ── EL MODELO HOMOGÉNEO ─────────────────────────────────────────────────────────────
// Un solo artículo: el producto en letras grandes, porque es lo que se lee de lejos.
function homogeneo(doc, pallet, linea, qr) {
  const QL = 52;
  const QX = A.ancho - M - 2 - QL;
  const anchoTexto = QX - (M + 2) - 8;

  let y = M + 44;
  const prod = S(linea.producto).toUpperCase();
  const tam = medida(doc, prod, anchoTexto * 0.72, 44, 18);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...NEGRO);
  doc.text(prod, M + 3, y);
  const wProd = doc.getTextWidth(prod);

  if (linea.variedad) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(Math.max(12, tam * 0.6));
    doc.setTextColor(...GRIS);
    doc.text(S(linea.variedad).toUpperCase(), M + 5 + wProd, y);
  }

  y += 8;
  let x = M + 3;
  if (linea.categoria) x += chapa(doc, x, y, 'CAT. ' + S(linea.categoria),
    ROJO, [255, 255, 255], 10, 13) + 3;
  if (linea.calibre) x += chapa(doc, x, y, 'CALIBRE ' + S(linea.calibre),
    [245, 224, 150], NEGRO, 10, 13) + 3;
  if (linea.envase) chapa(doc, x, y, S(linea.envase).toUpperCase(),
    [245, 224, 150], NEGRO, 10, 13);

  // Las seis cajas: lo que se va a buscar de cerca.
  y += 16;
  const w = (anchoTexto - 8) / 3;
  const h = 24;
  caja(doc, M + 3, y, w, h, 'Bultos', n0(linea.bultos), 22);
  caja(doc, M + 3 + w + 4, y, w, h, 'Kg netos', n2(linea.kilos), 22);
  caja(doc, M + 3 + (w + 4) * 2, y, w, h, 'Lote', linea.lote_nombre, 20);
  y += h + 4;
  caja(doc, M + 3, y, w, h, 'Fecha empaque', fechaAr(pallet.fecha_empaque), 17);
  caja(doc, M + 3 + w + 4, y, w, h, 'Cuartel', linea.cuartel, 17);
  caja(doc, M + 3 + (w + 4) * 2, y, w, h, 'RENSPA', linea.renspa, 13);

  elQR(doc, qr, pallet.numero, QX, M + 40, QL);
}

// ── EL MODELO MIXTO ─────────────────────────────────────────────────────────────────
// Varios artículos: una línea por cada uno, con sus bultos y sus kilos, y el total
// abajo. Cada línea lleva SU lote y SU renspa: un pallet mixto puede tener fruta de dos
// cuadros, y el que lo recibe necesita saber de cuál es cada caja.
function mixto(doc, pallet, lineas, qr) {
  const QL = 46;
  const QX = A.ancho - M - 2 - QL;
  const anchoTabla = QX - (M + 3) - 8;

  // Las columnas, en milímetros, proporcionales al ancho que quede.
  const pesos = [26, 7, 11, 15, 13, 18, 10, 10];
  const total = pesos.reduce((a, b) => a + b, 0);
  const cols = pesos.map((x) => (x / total) * anchoTabla);
  const titulos = ['PRODUCTO', 'CAT.', 'CALIBRE', 'ENVASE', 'LOTE', 'RENSPA', 'BULTOS', 'KG'];
  const derecha = [false, false, false, false, false, false, true, true];

  let y = M + 40;
  const xs = [];
  let acc = M + 3;
  for (const c of cols) { xs.push(acc); acc += c; }

  doc.setFillColor(...ROJO);
  doc.rect(M + 3, y, anchoTabla, 8, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  titulos.forEach((t, i) => {
    doc.text(t, derecha[i] ? xs[i] + cols[i] - 2 : xs[i] + 2, y + 5.4,
      derecha[i] ? { align: 'right' } : undefined);
  });
  y += 8;

  /* Entran unas nueve líneas con holgura. Más que eso no se achica la letra —una
     etiqueta que no se lee no sirve—: se dice cuántas quedaron afuera y el detalle
     completo está en el sistema con el número del pallet. */
  const MAX = 9;
  const muestra = lineas.slice(0, MAX);
  for (const l of muestra) {
    const datos = [
      S(l.producto) + (l.variedad ? ' ' + S(l.variedad) : ''),
      S(l.categoria), S(l.calibre), S(l.envase), S(l.lote_nombre), S(l.renspa),
      n0(l.bultos), n2(l.kilos),
    ];
    doc.setDrawColor(...GRIS_CL);
    doc.setLineWidth(0.3);
    doc.line(M + 3, y + 8.5, M + 3 + anchoTabla, y + 8.5);
    datos.forEach((d, i) => {
      doc.setFont('helvetica', i === 0 || i >= 6 ? 'bold' : 'normal');
      doc.setTextColor(...(i === 5 ? GRIS : NEGRO));
      const tam = medida(doc, d, cols[i] - 4, i === 5 ? 7.5 : 9, 5.5);
      void tam;
      doc.text(d, derecha[i] ? xs[i] + cols[i] - 2 : xs[i] + 2, y + 6,
        derecha[i] ? { align: 'right' } : undefined);
    });
    y += 8.5;
  }
  if (lineas.length > MAX) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(...GRIS);
    doc.text('y ' + (lineas.length - MAX) + ' artículos más — el detalle completo está en '
      + 'el sistema, con este número', M + 3, y + 5);
    y += 7;
  }

  // El total, en la misma línea que la fecha de empaque: son los dos números que se
  // controlan contra el remito al cargar.
  y += 2;
  doc.setDrawColor(...NEGRO);
  doc.setLineWidth(0.8);
  doc.line(M + 3, y, M + 3 + anchoTabla, y);
  y += 9;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...NEGRO);
  doc.text('TOTAL · Empaque ' + fechaAr(pallet.fecha_empaque), M + 3, y);
  doc.setFontSize(19);
  doc.text(n0(pallet.bultos), xs[6] + cols[6] - 2, y, { align: 'right' });
  doc.text(n2(pallet.kilos), xs[7] + cols[7] - 2, y, { align: 'right' });

  elQR(doc, qr, pallet.numero, QX, M + 38, QL);
}

// ── LA HOJA ─────────────────────────────────────────────────────────────────────────
export async function galponPalletPDF(pallet, contenido, cfg) {
  const c = cfg || {};
  const lineas = Array.isArray(contenido) ? contenido : [];
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4',
                          compress: true });

  let qr = null;
  if (pallet.numero) {
    // El número PELADO. Ver el encabezado del archivo.
    try {
      qr = await QRCode.toDataURL(String(pallet.numero),
        { errorCorrectionLevel: 'M', margin: 0, width: 420 });
    } catch (e) { qr = null; }
  }

  encabezado(doc, pallet, getLogo(), c.marca || 'LA NIÑA BONITA');
  if (lineas.length === 1) homogeneo(doc, pallet, lineas[0], qr);
  else mixto(doc, pallet, lineas, qr);
  pie(doc, c);

  if (pallet.observacion) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(...GRIS);
    doc.text(String(pallet.observacion).slice(0, 120), M + 3, A.alto - M - 12);
  }

  return Buffer.from(doc.output('arraybuffer'));
}
