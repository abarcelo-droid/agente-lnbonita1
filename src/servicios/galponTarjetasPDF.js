// src/servicios/galponTarjetasPDF.js
// ── LAS TARJETAS QUE VAN AL CAMPO ────────────────────────────────────────────────────
// En el campo no hay tecnología. Cada cuadrilla tiene tarjetas QR REUTILIZABLES de su
// color: el cuadrillero engancha una en cada IFCO que llena, y las tarjetas vuelven al
// campo después del volcado.
//
// Esto se imprime, se corta y se reparte ANTES de que empiece la cosecha. Es lo único de
// este módulo que tiene un plazo físico, por eso es lo primero que se construye.
//
// ── EL QR LLEVA EL NÚMERO PELADO, NADA MÁS ──────────────────────────────────────────
// La lectora USB se comporta como un TECLADO: escanear "escribe" el contenido del código
// en el campo que tenga el foco y manda un Enter. Si el QR llevara una URL, la pistola
// tipearía la URL entera adentro del casillero del número.
//
// Así que el contenido es "1042" y punto. También lo hace legible para cualquier lector
// de QR de celular, que es el respaldo.
//
// ── Y EL NÚMERO VA GRANDE, EN TINTA ─────────────────────────────────────────────────
// Si el sistema no está disponible —se cayó internet, la pistola no anda, el día de la
// cosecha llegó antes que el software— el cuadrillero sigue enganchando la tarjeta y
// alguien anota el número en un papel. Una tarjeta que sólo se puede leer con una máquina
// deja de servir justo el día que la máquina falla.
import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import { GRIS } from './pdfComun.js';

// NO se usa el EMISOR de pdfComun: eso es San Gerónimo SA, y estas tarjetas son de Puente
// Cordón y no salen de la finca. Sí la paleta, para que se vean de la misma familia.

// ── LA GRILLA ────────────────────────────────────────────────────────────────────────
// A4 (210×297) en 2 columnas × 4 filas = 8 tarjetas de 105×74 mm. Ocho y no diez a
// propósito: la tarjeta tiene que aguantar un día de campo colgada de un cajón, y a diez
// por hoja el número deja de leerse de lejos.
const A4 = { ancho: 210, alto: 297 };
const COLS = 2;
const FILAS = 4;
const POR_HOJA = COLS * FILAS;
const T_ANCHO = A4.ancho / COLS;      // 105
const T_ALTO  = A4.alto / FILAS;      // 74.25

const hexARgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return [26, 58, 92];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// ── QUÉ TARJETAS SALEN ───────────────────────────────────────────────────────────────
// Dos modos, y los dos hacen falta:
//   · un rango entero, para imprimir la tanda de una cuadrilla al principio de la temporada
//   · una lista suelta de IDs, para reponer las que se perdieron o se arruinaron
//
// `ids` manda sobre `desde`/`hasta`: pedir las dos cosas es un error del que llama, y
// reponer tres tarjetas sueltas es la operación más frecuente después del primer día.
export function tarjetasAImprimir(opts) {
  const o = opts || {};
  if (Array.isArray(o.ids) && o.ids.length) {
    return o.ids
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  const d = parseInt(o.desde, 10);
  const h = parseInt(o.hasta, 10);
  if (!Number.isFinite(d) || !Number.isFinite(h) || h < d) return [];
  // Un tope, porque un rango tipeado mal (1 a 999999) no puede intentar generar un millón
  // de QR y colgar el servidor. 500 son 63 hojas: muchísimo más de lo que nadie imprime.
  const total = Math.min(h - d + 1, 500);
  return Array.from({ length: total }, (_, i) => d + i);
}

// ── QUÉ LLEVA ADENTRO EL QR ──────────────────────────────────────────────────────────
// El número pelado: "1042". Está acá, en una función con nombre, porque es una decisión
// que se ve razonable de cambiar —una URL al volcado parece más útil— y sería un error:
// la lectora USB se comporta como un TECLADO, así que escanear TIPEA el contenido en el
// campo que tenga el foco. Con una URL adentro, la pistola escribiría la URL entera en el
// casillero del número de tarjeta.
export const contenidoQR = (id) => String(id);

// ── QUÉ DICE CADA TARJETA ────────────────────────────────────────────────────────────
// Una tanda puede ser de una sola cuadrilla (se imprime su rango entero) o mezclada (se
// reponen tarjetas sueltas de varias). Por eso hay dos niveles: lo que vale para toda la
// tanda, y el override por id.
//
// Está afuera del dibujo porque es LÓGICA: si una tarjeta sale con la cuadrilla
// equivocada, los kilos de esa cuadrilla se le atribuyen a otra toda la temporada, y eso
// no se ve mirando el PDF.
export function datosDeTarjeta(id, datos) {
  const d = datos || {};
  const porId = d.porId || {};
  const colorPorId = d.colorPorId || {};
  return {
    id,
    // El override por id gana sobre el valor de la tanda: en una reposición mezclada, cada
    // tarjeta vuelve a su cuadrilla aunque se impriman todas juntas.
    cuadrilla: porId[id] || d.cuadrilla || null,
    color: colorPorId[id] || d.color || null,
  };
}

// ── UNA TARJETA ──────────────────────────────────────────────────────────────────────
function dibujarTarjeta(doc, x, y, datos, qrDataUrl) {
  const rgb = hexARgb(datos.color);

  // La franja de color, a lo alto del borde izquierdo. Es lo que hace que el cuadrillero
  // agarre la tarjeta correcta sin leer nada: a tres metros se ve el color, no el texto.
  doc.setFillColor(rgb[0], rgb[1], rgb[2]);
  doc.rect(x + 4, y + 4, 9, T_ALTO - 8, 'F');

  // El marco de corte, finito y gris: guía la tijera sin ensuciar la tarjeta.
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.2);
  doc.rect(x + 4, y + 4, T_ANCHO - 8, T_ALTO - 8);

  // EL NÚMERO, lo más grande que entra. Es el respaldo de papel de todo el módulo.
  doc.setTextColor(20, 20, 20);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(42);
  doc.text(String(datos.id), x + 18, y + 32);

  // La cuadrilla, debajo. Recortada si no entra: un nombre largo que se monte sobre el QR
  // deja la tarjeta ilegible, y el que importa es el número.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(GRIS[0], GRIS[1], GRIS[2]);
  const nombre = String(datos.cuadrilla || '—');
  doc.text(nombre.length > 24 ? nombre.slice(0, 23) + '…' : nombre, x + 18, y + 42);

  // Y de qué galpón es, para cuando una tarjeta aparezca en otro lado.
  doc.setFontSize(8);
  doc.text('Galpon - Puente Cordon', x + 18, y + 50);

  if (qrDataUrl) {
    doc.addImage(qrDataUrl, 'PNG', x + T_ANCHO - 46, y + 14, 38, 38);
  } else {
    // Sin QR la tarjeta sigue sirviendo: se tipea el número. Se dibuja el hueco para que
    // se note que faltó, en vez de dejar un blanco que parezca diseño.
    doc.setDrawColor(220, 220, 220);
    doc.rect(x + T_ANCHO - 46, y + 14, 38, 38);
    doc.setFontSize(7);
    doc.text('sin QR', x + T_ANCHO - 33, y + 34);
  }
}

// ── EL PDF ───────────────────────────────────────────────────────────────────────────
// `async` por el QR: QRCode.toDataURL devuelve una promesa.
export async function generarTarjetasPDF(datos, opts) {
  const o = opts || {};
  const ids = tarjetasAImprimir(o);
  // compress: true — ver el encabezado. Sin esto son 3 MB cada 16 tarjetas.
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });

  if (!ids.length) {
    // Una hoja que explica por qué está vacía. Un PDF en blanco se lee como que el sistema
    // se rompió, y manda a alguien a revisar el servidor en vez de el rango que tipeó.
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('No hay tarjetas para imprimir', 20, 30);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text('Revisá el rango: el "desde" tiene que ser menor o igual al "hasta".', 20, 40);
    return Buffer.from(doc.output('arraybuffer'));
  }

  for (let i = 0; i < ids.length; i++) {
    if (i > 0 && i % POR_HOJA === 0) doc.addPage();
    const enHoja = i % POR_HOJA;
    const x = (enHoja % COLS) * T_ANCHO;
    const y = Math.floor(enHoja / COLS) * T_ALTO;

    const id = ids[i];
    // El QR falla sin tirar: igual que en facturaPDF.js, la tarjeta sale sin QR antes que
    // no salir ninguna tarjeta.
    let qr = null;
    try {
      qr = await QRCode.toDataURL(contenidoQR(id), {
        margin: 0, width: 120,
        // 'M' corrige hasta un 15%: una tarjeta que pasó el día colgada de un cajón se
        // ensucia y se dobla, y con el nivel más bajo dejaría de leerse.
        errorCorrectionLevel: 'M',
      });
    } catch (e) {
      console.error('[GALPON] QR de la tarjeta ' + id + ':', e.message);
    }

    dibujarTarjeta(doc, x, y, datosDeTarjeta(id, datos), qr);
  }

  return Buffer.from(doc.output('arraybuffer'));
}
