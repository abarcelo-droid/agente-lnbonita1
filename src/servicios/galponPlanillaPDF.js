// src/servicios/galponPlanillaPDF.js
// ══════════════════════════════════════════════════════════════════════════════════════
// 📋 REGISTRO DE CONTROL EN GALPÓN DE EMPAQUE
// ══════════════════════════════════════════════════════════════════════════════════════
// Andy, 2/11/2026, con la foto del papel: «necesito que en el panel de ingreso de kilos
// pueda descargarse un exportable en PDF exactamente con esta información».
//
// ── ES EL MISMO FORMULARIO, NO UNA VERSIÓN NUESTRA ─────────────────────────────────
// Lo firman tres personas y tiene número de versión y vigencia: es un documento
// controlado. Así que se replica como está —las mismas siete columnas, en el mismo
// orden, con el mismo encabezado y el mismo pie— y no se «mejora». Un informe que
// reordena las columnas obliga a quien lo revisa a buscar dónde quedó cada cosa, y el
// que lo aprueba firma algo que no reconoce.
//
// ── Y SE PUEDE SEGUIR LLENANDO A MANO ──────────────────────────────────────────────
// Las filas vacías del final están a propósito: el camión que entra después de
// imprimir se anota con la lapicera, como hoy. Un formulario que sólo sirve si todo
// está cargado es un formulario que el día que falla la señal no se usa.
//
// El estado sanitario sale con la letra CIRCULADA cuando se cargó, y con las tres
// letras sueltas para circular a mano cuando no.
// ══════════════════════════════════════════════════════════════════════════════════════

import { EMISOR, getLogo } from './pdfComun.js';

const NEGRO = [0, 0, 0];
const n2 = (v) => (v == null ? '' : Number(v).toLocaleString('es-AR',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// El día en 02/11/2026, partido a mano: una fecha sola la toma el navegador como UTC
// de medianoche y parada en Argentina eso se muestra como el día anterior.
export function fechaLarga(f) {
  const p = String(f || '').split('-');
  return p.length === 3 ? (p[2] + '/' + p[1] + '/' + p[0]) : (f || '');
}

/* ── LAS COLUMNAS DEL PAPEL ─────────────────────────────────────────────────────────
   En el mismo orden y con los mismos títulos. Los anchos suman 182 mm, que es el ancho
   útil de una A4 con márgenes de 14. */
const COLS = [
  { t: 'N° de viaje', k: 'viaje', w: 20, al: 'center' },
  { t: 'Finca', k: 'finca', w: 34, al: 'left' },
  { t: 'Lote y/o\nllave', k: 'lote', w: 28, al: 'left' },
  { t: 'N° de\nbolsas/bolsón\n/cajón/bins', k: 'n', w: 24, al: 'center' },
  { t: 'Peso', k: 'kilos', w: 20, al: 'right' },
  { t: 'Estado\nsanitario', k: 'sanitario', w: 22, al: 'center' },
  { t: 'Observaciones', k: 'observacion', w: 34, al: 'left' },
];
const X0 = 14;
const ANCHO = COLS.reduce((t, c) => t + c.w, 0);

function xDe(i) {
  let x = X0;
  for (let k = 0; k < i; k++) x += COLS[k].w;
  return x;
}

function recortar(doc, txt, mm) {
  let t = String(txt == null ? '' : txt);
  if (doc.getTextWidth(t) <= mm) return t;
  while (t.length > 1 && doc.getTextWidth(t + '…') > mm) t = t.slice(0, -1);
  return t + '…';
}

/* ── EL ENCABEZADO ──────────────────────────────────────────────────────────────────
   Tres celdas, como en el papel: el logo, el título del registro, y la versión con su
   vigencia. Debajo, los dos renglones de puntos para completar. */
function encabezado(doc, d, logo) {
  const y = 12;
  const alto = 17;
  const c1 = 46;
  const c3 = 38;
  const c2 = ANCHO - c1 - c3;

  doc.setDrawColor(...NEGRO);
  doc.setLineWidth(0.3);
  doc.rect(X0, y, c1, alto);
  doc.rect(X0 + c1, y, c2, alto);
  doc.rect(X0 + c1 + c2, y, c3, alto);
  // La celda de la derecha se parte en dos: versión arriba, vigencia abajo.
  doc.line(X0 + c1 + c2, y + alto / 2, X0 + ANCHO, y + alto / 2);

  if (logo) {
    try { doc.addImage(logo, 'PNG', X0 + 4, y + 3.5, 38, 10); } catch (e) { /* sigue */ }
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...NEGRO);
  const cx = X0 + c1 + c2 / 2;
  doc.text('REGISTRO DE CONTROL EN GALPÓN', cx, y + 5.5, { align: 'center' });
  doc.text('DE EMPAQUE', cx, y + 9.5, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text('Control de ingreso de materia prima', cx, y + 14.5, { align: 'center' });

  doc.setFontSize(8);
  doc.text('Versión ' + (d.version || ''), X0 + c1 + c2 + 3, y + 5.5);
  doc.text('Vigencia: ' + (d.vigencia || ''), X0 + c1 + c2 + 3, y + 13);

  /* La fecha y el cultivo van RELLENOS cuando el sistema los sabe, y con los puntos
     suspensivos del papel cuando no: así la hoja impresa se sigue pudiendo completar
     a mano, que es como se usa el día que no hay señal. */
  let yy = y + alto + 6;
  doc.setFontSize(9);
  doc.text('Fecha: ' + (d.fecha ? fechaLarga(d.fecha) : '').padEnd(0), X0, yy);
  if (!d.fecha) doc.text('.'.repeat(60), X0 + 14, yy);
  yy += 5;
  doc.text('Cultivo/Variedad: ' + [d.cultivo, d.variedad].filter(Boolean).join(' / '), X0, yy);
  if (!d.cultivo && !d.variedad) doc.text('.'.repeat(52), X0 + 32, yy);
  return yy + 5;
}

function cabeceraTabla(doc, y) {
  const alto = 11;
  doc.setDrawColor(...NEGRO);
  doc.setLineWidth(0.3);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...NEGRO);
  COLS.forEach((c, i) => {
    const x = xDe(i);
    doc.rect(x, y, c.w, alto);
    // Los títulos de dos y tres renglones, centrados verticalmente como en el papel.
    const ren = c.t.split('\n');
    const y0 = y + alto / 2 - ((ren.length - 1) * 2.6) / 2 + 0.9;
    ren.forEach((r, j) => doc.text(r, x + c.w / 2, y0 + j * 2.6, { align: 'center' }));
  });
  return y + alto;
}

/* ── EL ESTADO SANITARIO ────────────────────────────────────────────────────────────
   Las tres letras con barras, como en el papel, y la que se cargó va CIRCULADA. Sin
   dato van las tres sueltas para circular con la lapicera — que es exactamente lo que
   hace la planilla de hoy. */
function sanitario(doc, x, y, w, alto, valor) {
  const letras = ['B', 'R', 'M'];
  const txt = letras.join(' / ');
  doc.setFontSize(7.5);
  const ancho = doc.getTextWidth(txt);
  const x0 = x + (w - ancho) / 2;
  const yy = y + alto / 2 + 1;
  doc.text(txt, x0, yy);
  const i = letras.indexOf(valor);
  if (i < 0) return;
  // El círculo, sobre la letra que corresponde.
  const antes = doc.getTextWidth(letras.slice(0, i).map((l) => l + ' / ').join(''));
  const cx = x0 + antes + doc.getTextWidth(letras[i]) / 2;
  doc.setLineWidth(0.4);
  doc.circle(cx, yy - 0.9, 1.9);
  doc.setLineWidth(0.3);
}

function fila(doc, y, alto, datos, viaje) {
  doc.setDrawColor(...NEGRO);
  doc.setLineWidth(0.3);
  doc.setFontSize(8);
  doc.setTextColor(...NEGRO);
  COLS.forEach((c, i) => {
    const x = xDe(i);
    doc.rect(x, y, c.w, alto);
    if (!datos) return;                    // fila en blanco, para completar a mano
    let v = c.k === 'viaje' ? viaje : datos[c.k];
    /* Las tres letras van SIEMPRE, con dato o sin él: sin dato es justamente la celda
       que se completa a mano, y una celda vacía no se puede circular. */
    if (c.k === 'sanitario') { sanitario(doc, x, y, c.w, alto, v); return; }
    if (v == null || v === '') return;
    if (c.k === 'kilos') v = n2(v);
    const yy = y + alto / 2 + 1.2;
    const dentro = recortar(doc, String(v), c.w - 4);
    if (c.al === 'center') doc.text(dentro, x + c.w / 2, yy, { align: 'center' });
    else if (c.al === 'right') doc.text(dentro, x + c.w - 2, yy, { align: 'right' });
    else doc.text(dentro, x + 2, yy);
  });
  return y + alto;
}

/* ── EL PIE: LAS TRES FIRMAS ────────────────────────────────────────────────────────
   Modificó / Revisó / Aprobó, cada uno con su casillero de firma. Es por lo que existe
   el formulario: sin las tres firmas, la planilla no vale. */
function pieFirmas(doc, d) {
  const alto = 11;
  const y = 297 - 14 - alto;
  const w = ANCHO / 3;
  const gente = [
    ['Modificó: ' + (d.modifico || ''), 'Firma:'],
    ['Revisó: ' + (d.reviso || ''), 'Firma:'],
    ['Aprobó: ' + (d.aprobo || ''), 'Firma:'],
  ];
  doc.setDrawColor(...NEGRO);
  doc.setLineWidth(0.3);
  doc.setFontSize(8);
  doc.setTextColor(...NEGRO);
  gente.forEach((g, i) => {
    const x = X0 + i * w;
    doc.rect(x, y, w, alto / 2);
    doc.rect(x, y + alto / 2, w, alto / 2);
    doc.text(recortar(doc, g[0], w - 4), x + 2, y + 3.8);
    doc.text(g[1], x + 2, y + alto / 2 + 3.8);
  });
}

/* ══════════════════════════════════════════════════════════════════════════════════
   LA PLANILLA
   ══════════════════════════════════════════════════════════════════════════════════ */
export async function galponPlanillaPDF(datos, opts) {
  const d = datos || {};
  const o = opts || {};
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });

  const ALTO_FILA = 8;
  const FONDO = 297 - 14 - 11 - 4;        // hasta dónde se puede dibujar antes del pie

  let y = encabezado(doc, d, getLogo());
  y = cabeceraTabla(doc, y);

  /* UNA FILA POR CAJÓN, agrupadas por viaje. El número de viaje se escribe sólo en la
     PRIMERA fila de su grupo, como en el papel: repetirlo en las veintiuna lo convierte
     en ruido y hace más difícil ver dónde empieza el camión siguiente. */
  let filas = 0;
  for (const v of (d.viajes || [])) {
    for (let i = 0; i < v.filas.length; i++) {
      if (y + ALTO_FILA > FONDO) {
        pieFirmas(doc, d);
        doc.addPage();
        y = encabezado(doc, d, getLogo());
        y = cabeceraTabla(doc, y);
      }
      y = fila(doc, y, ALTO_FILA, v.filas[i],
        i === 0 ? (v.viaje == null ? '—' : v.viaje) : '');
      filas++;
    }
  }

  /* LAS FILAS VACÍAS DEL FINAL, para seguir anotando a mano. Un formulario que sólo
     sirve si todo está cargado es un formulario que el día que falla la señal no se
     usa — y este es justamente el papel que se llena cuando entra el camión. */
  const enBlanco = o.en_blanco == null ? 6 : Number(o.en_blanco);
  for (let i = 0; i < enBlanco; i++) {
    if (y + ALTO_FILA > FONDO) break;
    y = fila(doc, y, ALTO_FILA, null, '');
  }

  /* El total, fuera de la grilla: no es una columna del formulario y meterlo adentro lo
     cambiaría. Va debajo, como la suma que se hace al pie de una hoja. */
  if (filas) {
    y += 4;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...NEGRO);
    doc.text('Total del día: ' + (d.total.bultos || 0) + ' bultos · '
      + n2(d.total.kilos) + ' kg'
      + (d.total.viajes > 1 ? ('  ·  ' + d.total.viajes + ' viajes') : ''),
    X0 + ANCHO, y, { align: 'right' });
    doc.setFont('helvetica', 'normal');
  }

  pieFirmas(doc, d);

  // El numerado, al final, cuando ya se sabe cuántas páginas son.
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(120, 120, 120);
    doc.text(EMISOR.marca, X0, 293);
    doc.text('Página ' + i + ' de ' + n, X0 + ANCHO, 293, { align: 'right' });
  }
  return Buffer.from(doc.output('arraybuffer'));
}
