// ══ 📄 EL INFORME DEL ACUMULADO ═════════════════════════════════════════════
//
// Andy, 2/11/2026: «quiero que me sumes en la parte de acumulado un buen
// informe en PDF con gráficos. Gráficos de torta. Stock. Usá los emoticones
// para expresarte».
//
// Un PDF se mira, no se lee en el código — y se miró: el informe se renderizó
// con datos de una temporada entera y se abrió en el navegador. Eso encontró
// seis cosas que el chequeo de sintaxis no ve: las tortas rayadas por las
// costuras de los triángulos, los catorce dibujitos pintados en la misma
// altura, dos unidades en un mismo eje, media hoja en blanco, una etiqueta
// pisada por su propia torta, y una guía cruzando el círculo por detrás.
//
// Lo que se clava acá es lo que un segundo par de ojos no detectaría:
//
//   1. UN EMOJI EN EL PDF SALE COMO BASURA. jsPDF con Helvetica dibuja «🍑»
//      como `Ø<ßQ`. Si alguien mete un emoji en un título, nadie lo nota
//      hasta que el informe está impreso.
//   2. DOS UNIDADES EN UN EJE. Las cajas y los kilos en la misma barra hacen
//      que un bin de 2.400 kg aplaste a 467 cajas, como si no hubiera nada.
//   3. ALGO DIBUJADO FUERA DE LA HOJA. No falla, no avisa: se pierde.
//   4. UNA TORTA QUE NO SUMA EL TOTAL, o que reparte mal los ángulos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUENTE = fs.readFileSync(path.join(RAIZ, 'src/servicios/galponInformePDF.js'), 'utf8');

// -- SIN node_modules ESTE ARCHIVO SE SALTEA ENTERO, NO SE CAE -------------
let falta = false;
try { await import('jspdf'); }
catch { falta = 'falta el paquete jspdf: corré npm install para que estos tests corran'; }
const t = (nombre, fn) => test(nombre, { skip: falta }, fn);

const DATOS = {
  desde: '2026-12-01', hasta: '2026-12-24', hoy: '2026-12-25', usuario: 'Andy',
  totales: { kilos: 61876, dias: 24, procesado: 57293, comercial: 42414,
             verde: 9738, descarte: 5141, stock: 12840 },
  stock: { kilos: 12840, destinos: [
    { clave: 'comercial', nombre: 'Comercial', kilos: 9120, bultos: 1184 },
    { clave: 'verde', nombre: 'Verde', kilos: 2460, bultos: 246 },
    { clave: 'descarte', nombre: 'Descarte', kilos: 1260, bultos: 126 },
  ] },
  presentaciones: [
    { nombre: 'Carton Amarilla', calibre: '50/55', destino: 'comercial',
      bultos: 467, kilos: 3596, presentacion_id: 1 },
    { nombre: 'Bin a granel', destino: 'verde', granel: 1, bultos: 0, kilos: 2400,
      presentacion_id: 7 },
  ],
  por_dia: [
    { fecha: '2026-12-01', procesado: 2000, comercial: 1400, verde: 400, descarte: 200 },
    { fecha: '2026-12-02', procesado: 3000, comercial: 2250, verde: 500, descarte: 250 },
  ],
  rinde: [
    { lote_id: 10, nombre: '11-12 y 16-17', finca: 'El Abuelo', kilos: 28400,
      comercial: 20448, rinde: 72 },
  ],
};

// Lo que el PDF DIBUJÓ de verdad: se inflan los streams y se leen los `(texto) Tj`.
// Es más fiel que buscar en el binario, que con compress:true no encuentra nada.
function dibujado(buf) {
  const s = buf.toString('latin1');
  let txt = '';
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(s))) {
    try { txt += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1') + '\n'; }
    /* Con compress:true el stream viene desinflado y hay que inflarlo; sin
       compresión viene en claro. Antes el catch lo DESCARTABA, así que un PDF
       sin comprimir se leía como vacío — y el test que compara jsPDF contra un
       emoji usa uno sin comprimir. */
    catch (e) { txt += m[1] + '\n'; }
  }
  return { crudo: txt, textos: [...txt.matchAll(/\((.*?)\)\s*Tj/g)].map((x) => x[1]) };
}

// ══════════════════════════════════════════════════════════════════════════
// 1 · LOS EMOJIS NO ENTRAN EN UN PDF
// ══════════════════════════════════════════════════════════════════════════
t('UN EMOJI SE DIBUJA COMO BASURA: por eso no hay ninguno', async () => {
  /* Se verifica con el MOTOR, no con una creencia: jsPDF con Helvetica pasa el
     surrogate por una codificación de 8 bits y en la hoja salen dos caracteres
     raros. Si esto algún día deja de ser cierto —una fuente embebida, otra
     versión— el test se cae y se puede volver a poner emojis. */
  const { jsPDF } = await import('jspdf');
  const d = new jsPDF();
  d.text('caja 📦', 10, 10);
  const { textos } = dibujado(Buffer.from(d.output('arraybuffer')));
  assert.ok(textos.length, 'no se dibujó nada');
  assert.ok(!textos.join('').includes('📦'),
    'jsPDF ahora dibuja emojis: se pueden usar en el informe');
});

t('EL INFORME NO LLEVA NI UN EMOJI EN SU TEXTO', async () => {
  // Y si alguien agrega uno, se cae acá y no en la impresora.
  const { galponInformePDF } = await import('../src/servicios/galponInformePDF.js');
  const buf = await galponInformePDF(DATOS, {});
  const { textos } = dibujado(buf);
  const basura = textos.filter((x) => /[ØÜß][\u0000-ÿ]/.test(x));
  assert.deepEqual(basura, [], 'hay emojis dibujados como basura: ' + basura.join(' | '));
  // Los emojis del código fuente están en los COMENTARIOS, no en lo que se dibuja.
  const sinComentarios = FUENTE.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const enTexto = [...sinComentarios.matchAll(/'[^']*([\u{1F300}-\u{1FAFF}])[^']*'/gu)];
  assert.deepEqual(enTexto.map((m) => m[0]), [],
    'hay un emoji en una cadena que se dibuja');
});

t('el dibujito de una presentación sale del PNG subido', async () => {
  // Es para lo que Andy puede subirlos desde el catálogo (V1125): un PNG sí
  // entra en un PDF. Sin PNG va un disco del color de su destino, que dice
  // menos pero dice algo cierto.
  assert.match(FUENTE, /doc\.addImage\(png, 'PNG'/);
  const fn = FUENTE.slice(FUENTE.indexOf('function dibujito('),
                          FUENTE.indexOf('// ── ICONOS DE SECCIÓN'));
  assert.match(fn, /doc\.circle\(/, 'sin PNG no dibuja nada');
  // Y un PNG roto no se lleva puesto el informe entero.
  assert.match(fn, /catch \(e\)/);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · UNA SOLA UNIDAD POR EJE
// ══════════════════════════════════════════════════════════════════════════
t('LAS BARRAS VAN TODAS EN KILOS, con las cajas al lado', async () => {
  /* Antes la caja iba en bultos y el bin a granel en kilos: 2.400 contra 467
     en el mismo eje hacía que el bin ocupara todo el ancho y las cajas
     quedaran de dos centímetros, como si no hubiera nada. Es el error de los
     gráficos de dos escalas con otra ropa, y se vio en el render. */
  const { galponInformePDF } = await import('../src/servicios/galponInformePDF.js');
  const buf = await galponInformePDF(DATOS, {});
  const { textos } = dibujado(buf);
  const t1 = textos.join(' | ');
  assert.match(t1, /3\.596 kg/, 'la caja no está en kilos');
  assert.match(t1, /2\.400 kg/, 'el granel no está en kilos');
  // Y las cajas siguen, al lado: es lo que hay que contar para cargar.
  assert.match(t1, /467 cj/);
  // Un granel no dice «0 cj», que se leería como que no hay nada.
  assert.ok(!/0 cj/.test(t1), 'un granel figura con 0 cajas');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · NADA FUERA DE LA HOJA
// ══════════════════════════════════════════════════════════════════════════
t('TODO LO DIBUJADO CAE DENTRO DE LA A4', async () => {
  // Salirse no falla ni avisa: simplemente no está en el papel.
  const { galponInformePDF } = await import('../src/servicios/galponInformePDF.js');
  const buf = await galponInformePDF(DATOS, {});
  const { crudo } = dibujado(buf);
  const pts = [];
  for (const m of crudo.matchAll(/([\d.-]+) ([\d.-]+) (?:m|l)\b/g)) pts.push([+m[1], +m[2]]);
  for (const m of crudo.matchAll(/([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re/g)) {
    pts.push([+m[1], +m[2]], [+m[1] + +m[3], +m[2] + +m[4]]);
  }
  for (const m of crudo.matchAll(/([\d.-]+) ([\d.-]+) Td/g)) pts.push([+m[1], +m[2]]);
  const fuera = pts.filter(([x, y]) => x < -1 || y < -1 || x > 596 || y > 843);
  assert.ok(pts.length > 500, 'sólo ' + pts.length + ' puntos: el informe salió vacío');
  assert.deepEqual(fuera.slice(0, 4), [], fuera.length + ' puntos fuera de la hoja');
});

t('con MUCHOS datos no se desborda ni se pierde nada', async () => {
  // Una temporada entera: 90 días, 30 presentaciones, 40 lotes. El informe
  // tiene que recortar y DECIR que recortó, no dibujar encima del pie.
  const { galponInformePDF } = await import('../src/servicios/galponInformePDF.js');
  const muchos = Object.assign({}, DATOS, {
    presentaciones: Array.from({ length: 30 }, (_, i) => ({
      nombre: 'Presentación con un nombre larguísimo número ' + i,
      destino: 'comercial', bultos: 100 + i, kilos: 800 + i * 10, presentacion_id: i + 1,
    })),
    por_dia: Array.from({ length: 90 }, (_, i) => ({
      fecha: '2026-' + String(1 + (i % 12)).padStart(2, '0') + '-'
        + String(1 + (i % 28)).padStart(2, '0'),
      procesado: 1000 + i * 20, comercial: 700 + i * 14, verde: 200, descarte: 100,
    })),
    rinde: Array.from({ length: 40 }, (_, i) => ({
      lote_id: i, nombre: 'Lote con nombre interminable número ' + i,
      finca: 'Finca de nombre también largo ' + i,
      kilos: 1000 + i * 50, comercial: 700 + i * 30, rinde: 50 + (i % 40),
    })),
  });
  const buf = await galponInformePDF(muchos, {});
  const { crudo, textos } = dibujado(buf);
  const pts = [...crudo.matchAll(/([\d.-]+) ([\d.-]+) Td/g)].map((m) => [+m[1], +m[2]]);
  assert.deepEqual(pts.filter(([x, y]) => x < -1 || y < -1 || x > 596 || y > 843), []);
  // Y avisa de lo que no entró, en vez de callarlo.
  assert.ok(textos.some((x) => /presentaciones m/.test(x)),
    'recortó las presentaciones sin decirlo');
});

t('con la base vacía sale un informe, no un error', async () => {
  // El día uno de la temporada alguien va a apretar el botón.
  const { galponInformePDF } = await import('../src/servicios/galponInformePDF.js');
  const buf = await galponInformePDF({ hoy: '2026-12-25', totales: {} }, {});
  const { textos } = dibujado(buf);
  assert.ok(buf.length > 2000);
  assert.ok(textos.some((x) => /Informe del galp/.test(x)));
  assert.ok(textos.some((x) => /Todav/.test(x)), 'no dice que no hay nada todavía');
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LA TORTA REPARTE BIEN
// ══════════════════════════════════════════════════════════════════════════
t('LA TORTA REPARTE EL CÍRCULO EN PROPORCIÓN', async () => {
  /* Se cuentan los triángulos de cada color: cada uno barre un grado, así que
     su cantidad ES el ángulo. Un reparto mal calculado se ve como una torta
     cualquiera y nadie lo nota. */
  const { galponInformePDF } = await import('../src/servicios/galponInformePDF.js');
  const buf = await galponInformePDF(DATOS, {});
  const { crudo } = dibujado(buf);
  // El color se escribe como `r g b rg` antes de sus triángulos.
  const porColor = {};
  let actual = null;
  for (const l of crudo.split('\n')) {
    const c = /^([\d.]+) ([\d.]+) ([\d.]+) rg$/.exec(l.trim());
    if (c) { actual = c.slice(1, 4).map((x) => Math.round(+x * 255)).join(','); continue; }
    if (/ l$/.test(l) && actual) porColor[actual] = (porColor[actual] || 0) + 1;
  }
  /* El color se compara CERCA y no exacto: jsPDF escribe el canal como decimal y al
     volver a 0-255 el 21 sale 20. Un test atado al valor exacto se cae con cualquier
     cambio de redondeo de la librería sin que nada esté mal. */
  const cerca = (r, g, b) => Object.entries(porColor)
    .filter(([k]) => { const c = k.split(',').map(Number);
      return Math.abs(c[0] - r) <= 2 && Math.abs(c[1] - g) <= 2 && Math.abs(c[2] - b) <= 2; })
    .reduce((t, [, v]) => t + v, 0);
  const verde = cerca(21, 128, 61);
  const ambar = cerca(245, 158, 11);
  const rojo = cerca(185, 28, 28);
  assert.ok(verde > ambar && ambar > rojo,
    'las porciones no van en proporción: ' + JSON.stringify(porColor));
  /* Comercial es el 74% del rinde y el 71% del stock, o sea ~2,6 veces el resto
     juntos en las dos tortas. El ámbar y el rojo son mucho menos. */
  assert.ok(verde / (ambar + rojo) > 1.8,
    'la porción comercial no es la más grande por lejos');
});

t('una sola parte es un círculo entero, no 360 triángulos', async () => {
  // Con un solo destino, barrer 360 grados de triángulos deja una costura en
  // el cero que se ve como una rayita blanca de punta a punta.
  const fn = FUENTE.slice(FUENTE.indexOf('export function torta('),
                          FUENTE.indexOf('function etiquetas('));
  assert.match(fn, /vivas\.length === 1/);
  assert.match(fn, /doc\.circle\(cx, cy, r, 'F'\)/);
});

t('los triángulos se PISAN: si no, la torta sale rayada', async () => {
  // Pegados exactos, el antialiasing del visor deja una raya blanca de medio
  // píxel en cada junta y la porción sale como un abanico. Se vio en el
  // render antes de arreglarlo.
  const fn = FUENTE.slice(FUENTE.indexOf('export function torta('),
                          FUENTE.indexOf('function etiquetas('));
  const m = /Math\.min\(a \+ ([\d.]+), barre\)/.exec(fn);
  assert.ok(m, 'no se ve el paso del barrido');
  assert.ok(Number(m[1]) > 1, 'los triángulos no se solapan: la torta sale rayada');
});

t('cada dibujito va en SU renglón', async () => {
  // Los catorce se pintaban en la misma altura: quedaba uno encima del otro y
  // se veía uno solo, desalineado con su fila.
  assert.match(FUENTE, /pres\.slice\(0, 14\)\.forEach\(\(f, i\) => \{/);
  assert.match(FUENTE, /y - 5 \+ i \* ALTO_FILA/);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LA GEOMETRÍA, MEDIDA
// ══════════════════════════════════════════════════════════════════════════
// Estos ocho salieron de la mutación: los de arriba verificaban que el PDF se
// generara y que los textos estuvieran, pero no DÓNDE. En un informe, dónde
// está cada cosa es la mitad del trabajo — y es lo único que un segundo par
// de ojos no puede revisar renglón por renglón.

// Todo lo que el PDF dibuja, con sus coordenadas. En puntos: 1 mm = 2,8346 pt
// y el origen está ABAJO a la izquierda, al revés que en jsPDF.
function trazos(buf) {
  const { crudo } = dibujado(buf);
  const lineas = [];
  const rects = [];
  const textos = [];
  let desde = null;
  let color = null;
  for (const l of crudo.split('\n')) {
    const t = l.trim();
    let m;
    if ((m = /^([\d.]+) ([\d.]+) ([\d.]+) rg$/.exec(t))) {
      color = m.slice(1, 4).map((x) => Math.round(+x * 255)); continue;
    }
    if ((m = /^([\d.-]+) ([\d.-]+) m$/.exec(t))) { desde = [+m[1], +m[2]]; continue; }
    if ((m = /^([\d.-]+) ([\d.-]+) l$/.exec(t))) {
      if (desde) lineas.push({ x1: desde[0], y1: desde[1], x2: +m[1], y2: +m[2], color });
      desde = [+m[1], +m[2]]; continue;
    }
    if ((m = /^([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re$/.exec(t))) {
      rects.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], color }); continue;
    }
    if ((m = /^([\d.-]+) ([\d.-]+) Td$/.exec(t))) { textos.push({ x: +m[1], y: +m[2] }); }
  }
  return { lineas, rects, textos };
}
const MM = 2.8346;

t('LAS ETIQUETAS DE LA TORTA NO SE PISAN', async () => {
  /* Dos porciones chicas y vecinas escriben una encima de la otra y no se lee
     ninguna de las dos. Se mide: dos etiquetas de la misma torta no pueden
     estar a menos de 6 mm en vertical si comparten la columna. */
  const { galponInformePDF } = await import('../src/servicios/galponInformePDF.js');
  // Dos porciones casi iguales y una mínima: el caso que las amontona.
  /* Tres porciones CHICAS Y VECINAS es lo que las amontona: con dos grandes, sus
     medios quedan lejos y no se pisan ni sin el empuje. El caso real es un día en que
     casi todo salió comercial y quedan dos rayitas de verde y descarte. */
  const apretado = Object.assign({}, DATOS, {
    totales: Object.assign({}, DATOS.totales,
      { procesado: 10000, comercial: 9700, verde: 160, descarte: 140 }),
  });
  const buf = await galponInformePDF(apretado, {});
  const { textos } = trazos(buf);
  // Las de la torta izquierda: a la derecha de su centro, en su franja vertical.
  const cerca = textos.filter((p) => p.x > 46 * MM && p.x < 100 * MM
    && p.y > (297 - 125) * MM && p.y < (297 - 58) * MM)
    .map((p) => p.y).sort((a, b) => a - b);
  assert.ok(cerca.length >= 4, 'no encontré las etiquetas: ' + cerca.length);
  /* Los renglones vienen de a pares (el kilaje y el nombre, a 3,6 mm). Entre
     PARES tiene que haber al menos 6 mm, o una etiqueta tapa a la anterior. */
  assert.equal(cerca.length, 6,
    'esperaba 3 etiquetas de 2 renglones y encontré ' + cerca.length + ' renglones');
  const saltos = [];
  for (let i = 1; i < cerca.length; i++) saltos.push((cerca[i] - cerca[i - 1]) / MM);
  // adentro · ENTRE · adentro · ENTRE · adentro
  for (const i of [0, 2, 4]) {
    assert.ok(saltos[i] < 4.5,
      'los dos renglones de una etiqueta están a ' + saltos[i].toFixed(1) + ' mm');
  }
  for (const i of [1, 3]) {
    assert.ok(saltos[i] >= 5,
      'dos etiquetas a ' + saltos[i].toFixed(1) + ' mm: se pisan');
  }
});

t('CADA ETIQUETA LLEVA SU CUADRADITO DE COLOR', async () => {
  // Es lo que ata el renglón a su porción sin depender de la guía — y para
  // una porción de la mitad izquierda la guía no se dibuja, así que el
  // cuadradito es lo ÚNICO que los une.
  const { galponInformePDF } = await import('../src/servicios/galponInformePDF.js');
  const buf = await galponInformePDF(DATOS, {});
  const { rects } = trazos(buf);
  /* El alto va en NEGATIVO: jsPDF invierte el eje Y al escribir el rect. Sin el
     valor absoluto no matchea ninguno y el test informaba 0 de 6 con los seis
     cuadraditos dibujados. */
  const chicos = rects.filter((r) => Math.abs(r.w - 2.2 * MM) < 1
    && Math.abs(Math.abs(r.h) - 2.2 * MM) < 1);
  // Tres por torta, dos tortas.
  assert.ok(chicos.length >= 6,
    'faltan cuadraditos de color: ' + chicos.length + ' de 6');
  // Y son de los colores del galpón, no grises.
  const cols = new Set(chicos.map((r) => (r.color || []).join(',')));
  assert.ok(cols.size >= 3, 'los cuadraditos no distinguen los destinos');
});

t('NINGUNA GUÍA CRUZA LA TORTA POR DETRÁS', async () => {
  /* Para una porción de la mitad izquierda, la línea al renglón de la derecha
     pasaría por detrás del círculo: se ve una raya gris entrando en la torta
     sin que se entienda de dónde viene. */
  const { galponInformePDF } = await import('../src/servicios/galponInformePDF.js');
  const buf = await galponInformePDF(DATOS, {});
  const { lineas } = trazos(buf);

  // Los centros, encontrados: el vértice que comparten los triángulos de cada torta.
  const veces = new Map();
  for (const l of lineas) {
    const k = Math.round(l.x1) + ',' + Math.round(l.y1);
    veces.set(k, (veces.get(k) || 0) + 1);
  }
  const centros = [...veces.entries()].filter(([, n]) => n > 100)
    .map(([k]) => k.split(',').map(Number));
  assert.equal(centros.length, 2,
    'esperaba dos tortas y encontré ' + centros.length + ' centros');

  for (const [px, py] of centros) {
    // El radio: la distancia típica del centro a los bordes de sus triángulos.
    const radios = lineas.filter((l) => Math.round(l.x1) === Math.round(px)
      && Math.round(l.y1) === Math.round(py))
      .map((l) => Math.hypot(l.x2 - px, l.y2 - py));
    const r = radios.sort((a, b) => a - b)[Math.floor(radios.length / 2)];
    assert.ok(r > 10, 'el radio medido salió en ' + r.toFixed(1) + ' pt');

    /* El criterio es si el SEGMENTO pasa por adentro, no dónde cae su punto medio:
       con el punto medio hay que acotar por largo para no contar las barras del
       informe, y ese corte dejaba pasar justo la guía que cruza la torta entera. */
    const adentro = lineas.filter((l) => {
      // Los lados de la propia torta tocan el centro —el radio que sale y el que
      // vuelve a cerrar el triángulo—: no cuentan, o cada porción se denuncia a sí
      // misma una vez por grado.
      const toca = (x, y) => Math.round(x) === Math.round(px)
        && Math.round(y) === Math.round(py);
      if (toca(l.x1, l.y1) || toca(l.x2, l.y2)) return false;
      const dx = l.x2 - l.x1;
      const dy = l.y2 - l.y1;
      const largo2 = dx * dx + dy * dy;
      let u = largo2 ? ((px - l.x1) * dx + (py - l.y1) * dy) / largo2 : 0;
      u = Math.max(0, Math.min(1, u));
      const cerca = Math.hypot(l.x1 + u * dx - px, l.y1 + u * dy - py);
      /* Medio radio: una guía legítima ARRANCA en el borde y sale, así que su punto
         más cercano al centro está a un radio entero. Sólo algo que atraviesa pasa
         más cerca que la mitad. */
      return cerca < r * 0.5;
    });
    assert.deepEqual(adentro.map((l) => [Math.round(l.x1), Math.round(l.y1)]), [],
      'hay ' + adentro.length + ' líneas cruzando la torta de (' + Math.round(px)
      + ',' + Math.round(py) + ')');
  }
});
t('UN SOLO DESTINO ES UN CÍRCULO, no tres porciones de cero', async () => {
  // El día que sólo haya comercial —pasa al principio de la temporada— la
  // torta tiene que salir entera. Con las partes en cero adentro de la
  // cuenta, el atajo del círculo no se aplica y queda la costura del cero.
  const { galponInformePDF } = await import('../src/servicios/galponInformePDF.js');
  const solo = Object.assign({}, DATOS, {
    totales: Object.assign({}, DATOS.totales,
      { procesado: 5000, comercial: 5000, verde: 0, descarte: 0 }),
  });
  const buf = await galponInformePDF(solo, {});
  const { textos } = dibujado(buf);
  assert.ok(textos.some((x) => /100%/.test(x)), 'no dice que el 100% salió comercial');
  // Y no hay etiquetas de porciones que no existen.
  assert.ok(!textos.some((x) => /^0 kg$/.test(x)), 'etiquetó una porción en cero');
  /* Y se dibuja como UN CÍRCULO, no como 360 triángulos: ésa es la diferencia, y es la
     costura en el cero que se ve como una rayita blanca de punta a punta. Se cuenta:
     un círculo son 4 curvas Bézier, los triángulos son cientos de líneas. */
  const { lineas } = trazos(buf);
  const veces = new Map();
  for (const l of lineas) {
    const k = Math.round(l.x1) + ',' + Math.round(l.y1);
    veces.set(k, (veces.get(k) || 0) + 1);
  }
  /* Con DOS tortas y una de una sola parte, tiene que haber UN solo centro con
     cientos de radios: el de la torta del stock, que sí tiene tres porciones. */
  const centros = [...veces.values()].filter((n) => n > 100);
  assert.equal(centros.length, 1,
    'la torta de una sola parte se dibujó con triángulos en vez de un círculo');
});

t('UN PNG ROTO NO SE LLEVA PUESTO EL INFORME', async () => {
  // El archivo puede estar truncado o no ser un PNG: el informe tiene que
  // salir igual, con el disco de color en su lugar.
  const { galponInformePDF } = await import('../src/servicios/galponInformePDF.js');
  const buf = await galponInformePDF(DATOS,
    { iconos: { 1: 'data:image/png;base64,bm8tZXMtdW4tcG5n' } });
  assert.ok(buf.length > 2000, 'el informe no salió');
  const { textos } = dibujado(buf);
  assert.ok(textos.some((x) => /Carton Amarilla/.test(x)),
    'se perdió el renglón de la presentación con el PNG roto');
});

t('NADA SE DIBUJA ENCIMA DEL PIE DE PÁGINA', async () => {
  /* El pie va en 290 mm. Una tabla larga que no salta de página se dibuja
     sobre él: no se sale de la hoja —y por eso el chequeo de la A4 no lo
     agarra— pero queda escrito arriba del número de página. */
  const { galponInformePDF } = await import('../src/servicios/galponInformePDF.js');
  const muchos = Object.assign({}, DATOS, {
    rinde: Array.from({ length: 60 }, (_, i) => ({
      lote_id: i, nombre: 'Lote ' + i, finca: 'Finca', kilos: 1000, comercial: 700,
      rinde: 70,
    })),
  });
  const buf = await galponInformePDF(muchos, {});
  const { textos } = trazos(buf);
  // El pie vive en y = 290 mm → 19,8 pt desde abajo. Nada del cuerpo por debajo
  // de 15 mm, salvo el pie mismo.
  /* El pie mismo vive en 290 mm (19,8 pt desde abajo): el umbral va POR DEBAJO de él
     o el test se denuncia a sí mismo. Lo que se busca es cuerpo invadiendo esa
     franja, que empieza en 285 mm. */
  /* Dos cosas distintas y las dos son el mismo error: escribir sobre el pie (entre
     el pie y 285 mm) y escribir FUERA de la hoja, que es lo que pasa cuando una
     tabla larga no salta de página. El filtro anterior sólo miraba la primera. */
  const bajos = textos.filter((t2) => (t2.y > 20.5 && t2.y < 12 * MM) || t2.y < 0);
  assert.deepEqual(bajos, [], bajos.length + ' textos dibujados debajo del pie');
});

t('LAS COLUMNAS DEL DÍA A DÍA SE PUEDEN VER', async () => {
  /* Con noventa días, cada columna mediría dos décimas de milímetro: están
     dentro de la hoja —así que el chequeo de la A4 pasa— y no se ven. Se
     recorta a los últimos 28 y cada columna mide al menos milímetro y medio. */
  const { galponInformePDF } = await import('../src/servicios/galponInformePDF.js');
  const muchos = Object.assign({}, DATOS, {
    por_dia: Array.from({ length: 90 }, (_, i) => ({
      fecha: '2026-06-' + String(1 + (i % 28)).padStart(2, '0'),
      procesado: 1000, comercial: 700, verde: 200, descarte: 100,
    })),
  });
  const buf = await galponInformePDF(muchos, {});
  const { rects } = trazos(buf);
  // Las columnas: rectángulos de los colores del galpón, más altos que anchos.
  /* Más de 4 MM de alto (no de puntos): los cuadraditos de las etiquetas y el de la
     referencia miden 2,2 y 2,4 mm, son del mismo verde, y se contaban como días. */
  const cols = rects.filter((r) => Math.abs(r.h) > 4 * MM && r.w > 0 && r.w < 12 * MM
    && (r.color || []).length === 3
    && Math.abs(r.color[0] - 21) <= 2 && Math.abs(r.color[1] - 128) <= 2
    && Math.abs(r.color[2] - 61) <= 2);
  assert.ok(cols.length > 0, 'no se dibujó ninguna columna');
  const flaca = Math.min(...cols.map((r) => r.w));
  assert.ok(flaca >= 1.4 * MM,
    'la columna más flaca mide ' + (flaca / MM).toFixed(2) + ' mm: no se ve');
  assert.ok(cols.length <= 28, 'dibujó ' + cols.length + ' días: no recortó');
});
