// ══ 🏭 LAS TARJETAS QUE VAN AL CAMPO ══════════════════════════════════════
//
// Esto se imprime, se corta y se reparte ANTES de que empiece la cosecha. Es
// lo único del módulo con plazo físico: si sale mal, no hay parche de software
// que lo arregle a las siete de la mañana del primer día.
//
// ── LO QUE PUEDE ESTAR MAL SIN QUE SE NOTE MIRANDO EL PDF ─────────────────
// Que una tarjeta salga con la cuadrilla equivocada. La hoja se ve perfecta,
// se imprime, se reparte — y los kilos de esa cuadrilla se le atribuyen a otra
// toda la temporada. Nadie lo descubre hasta fin de temporada, cuando una
// cuadrilla rindió raro y ya no hay con qué reconstruirlo.
//
// Por eso acá no alcanza con que el PDF se genere: se le LEE EL TEXTO ADENTRO
// y se verifica qué número y qué nombre quedaron en cada tarjeta.
//
// ── CÓMO SE LE LEE EL TEXTO A UN PDF COMPRIMIDO ───────────────────────────
// `oportunidades_pdf` grepea el binario directo, porque jsPDF por defecto no
// comprime. Éste SÍ va comprimido, y no es un detalle de gusto: sin comprimir,
// 16 tarjetas pesan 3.037 KB y las 500 de una temporada pesarían casi 100 MB,
// porque jsPDF embebe cada QR como PNG crudo. Comprimido son 22 KB y 603 KB.
//
// Así que en vez de resignar la verificación, se inflan los streams con zlib
// —que es exactamente lo que hace un lector de PDF— y se leen los operadores
// `(texto) Tj`. Sale más fiel que grepear: se lee lo que se DIBUJÓ.
//
// -- SIN node_modules ESTE ARCHIVO SE SALTEA, NO SE CAE --------------------
// Mismo trato que oportunidades_pdf y share_import: se saltea SOLO si el
// paquete de verdad falta. Donde hay node_modules corre entero.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

let generarTarjetasPDF = null, tarjetasAImprimir = null, datosDeTarjeta = null, contenidoQR = null;
let falta = false;
try {
  const m = await import('../src/servicios/galponTarjetasPDF.js');
  ({ generarTarjetasPDF, tarjetasAImprimir, datosDeTarjeta, contenidoQR } = m);
} catch { falta = 'falta el paquete jspdf (o qrcode): corre npm install para que estos tests corran'; }

const t = (nombre, fn) => test(nombre, { skip: falta }, fn);

// Una hoja A4 son 8 tarjetas. Las páginas se cuentan por /MediaBox, que jsPDF
// deja sin comprimir aunque el contenido vaya comprimido.
const hojas = (buf) => (buf.toString('latin1').match(/\/MediaBox/g) || []).length;
const kb = (buf) => buf.length / 1024;

// El contenido de cada página, inflado. Un stream que no infle se deja marcado
// en vez de tragárselo: si mañana jsPDF cambia de filtro, estos tests tienen
// que ponerse rojos, no pasar leyendo un texto vacío.
function contenido(buf) {
  const s = buf.toString('latin1');
  const re = /\/Filter \/FlateDecode\s*>>\s*stream\n/g;
  let out = '', m, hubo = 0;
  while ((m = re.exec(s))) {
    hubo++;
    const ini = m.index + m[0].length;
    const fin = s.indexOf('\nendstream', ini);
    try { out += zlib.inflateSync(Buffer.from(s.slice(ini, fin), 'latin1')).toString('latin1') + '\n'; }
    catch { out += '[STREAM QUE NO INFLA]\n'; }
  }
  assert.ok(hubo > 0, 'el PDF no tiene ningún stream comprimido: ¿se perdió compress:true?');
  return out;
}

// Lo que quedó ESCRITO, en orden de dibujo.
const textos = (buf) => [...contenido(buf).matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]);

// ── QUÉ TARJETAS SALEN ────────────────────────────────────────────────────
t('un rango sale entero, con los dos bordes adentro', () => {
  assert.deepEqual(tarjetasAImprimir({ desde: 10, hasta: 14 }), [10, 11, 12, 13, 14]);
  assert.deepEqual(tarjetasAImprimir({ desde: 7, hasta: 7 }), [7]);
});

t('LA LISTA SUELTA GANA SOBRE EL RANGO', () => {
  // Reponer tres tarjetas perdidas es la operación más frecuente después del
  // primer día. Si el rango ganara, pedir una reposición reimprimiría la tanda
  // entera y el operador se encontraría con 63 hojas.
  assert.deepEqual(tarjetasAImprimir({ ids: [3, 9], desde: 1, hasta: 500 }), [3, 9]);
});

t('los ids que no son números se filtran, no rompen el PDF', () => {
  // Llegan de un campo de texto donde alguien escribe "7, 9, 11" a las seis de
  // la mañana. Una coma de más no puede dejar sin tarjetas al que las necesita.
  assert.deepEqual(tarjetasAImprimir({ ids: [7, '9', ' 11 ', '', null, 'x', -2, 0] }), [7, 9, 11]);
});

t('UN RANGO INVERTIDO NO GENERA UN MILLÓN DE TARJETAS NI TIRA', () => {
  assert.deepEqual(tarjetasAImprimir({ desde: 100, hasta: 10 }), []);
  assert.deepEqual(tarjetasAImprimir({}), []);
  assert.deepEqual(tarjetasAImprimir(), []);
  assert.deepEqual(tarjetasAImprimir({ desde: 'a', hasta: 'b' }), []);
});

t('y un rango absurdo se corta en 500', () => {
  // "1 a 999999" es un error de tipeo, y sin tope el servidor se queda
  // generando un millón de QR mientras el operador mira una rueda girar.
  const r = tarjetasAImprimir({ desde: 1, hasta: 999999 });
  assert.equal(r.length, 500);
  assert.equal(r[0], 1);
  assert.equal(r[499], 500);
});

// ── QUÉ DICE CADA TARJETA ─────────────────────────────────────────────────
t('EL OVERRIDE POR ID GANA SOBRE EL VALOR DE LA TANDA', () => {
  // Una reposición mezclada se imprime junta, pero cada tarjeta vuelve a SU
  // cuadrilla. Si ganara el valor de la tanda, las repuestas saldrían todas con
  // la misma cuadrilla y los kilos se mezclarían sin que nadie lo vea.
  const d = { cuadrilla: 'Norte', color: '#111111',
              porId: { 7: 'Sur' }, colorPorId: { 7: '#222222' } };
  assert.deepEqual(datosDeTarjeta(7, d), { id: 7, cuadrilla: 'Sur', color: '#222222' });
  assert.deepEqual(datosDeTarjeta(8, d), { id: 8, cuadrilla: 'Norte', color: '#111111' });
});

t('sin datos, la tarjeta sale igual: el número es lo que importa', () => {
  // Es el respaldo de papel de todo el módulo. Una tarjeta sin cuadrilla sirve;
  // una tanda que no se imprime porque faltaba un nombre, no.
  assert.deepEqual(datosDeTarjeta(42, null), { id: 42, cuadrilla: null, color: null });
  assert.deepEqual(datosDeTarjeta(42, {}), { id: 42, cuadrilla: null, color: null });
});

t('EL QR LLEVA EL NÚMERO PELADO, SIN URL', () => {
  // La lectora USB se comporta como un TECLADO: escanear TIPEA el contenido en
  // el campo que tenga el foco. Con una URL adentro, la pistola escribiría la
  // URL entera en el casillero del número de tarjeta.
  assert.equal(contenidoQR(1042), '1042');
  assert.equal(contenidoQR('7'), '7');
  for (const basura of ['http', '://', 'galpon', '?', '/']) {
    assert.ok(!contenidoQR(1042).includes(basura), 'el QR lleva "' + basura + '" adentro');
  }
});

// ── LO QUE QUEDÓ IMPRESO ──────────────────────────────────────────────────
t('CADA TARJETA LLEVA SU NÚMERO Y SU CUADRILLA, en orden', async () => {
  // Esto es lo que no se puede arreglar después: una tarjeta con la cuadrilla
  // de al lado se reparte igual y nadie lo nota.
  const b = await generarTarjetasPDF({ cuadrilla: 'Cuadrilla Norte' }, { desde: 7, hasta: 9 });
  const esc = textos(b);
  assert.deepEqual(esc.filter((x) => /^\d+$/.test(x)), ['7', '8', '9']);
  assert.equal(esc.filter((x) => x === 'Cuadrilla Norte').length, 3);
});

t('y en una reposición mezclada, CADA UNA VUELVE A LA SUYA', async () => {
  const b = await generarTarjetasPDF(
    { cuadrilla: 'Norte', porId: { 9: 'Sur' } }, { ids: [7, 9, 11] });
  const esc = textos(b);
  // El orden de dibujo es número, cuadrilla, pie — así que la cuadrilla de la
  // tarjeta 9 es la que viene justo después del "9".
  const i = esc.indexOf('9');
  assert.equal(esc[i + 1], 'Sur', 'la 9 salió con la cuadrilla de la tanda');
  assert.equal(esc[esc.indexOf('7') + 1], 'Norte');
  assert.equal(esc[esc.indexOf('11') + 1], 'Norte');
});

t('una tarjeta sin cuadrilla sale con una raya, no con "null"', async () => {
  const b = await generarTarjetasPDF({}, { ids: [5] });
  assert.ok(textos(b).includes('5'));
  assert.ok(!textos(b).some((x) => /null|undefined/.test(x)), textos(b).join(' | '));
});

t('UN NOMBRE LARGUÍSIMO SE RECORTA antes de montarse sobre el QR', async () => {
  const largo = 'Cuadrilla de cosecha de damasco del cuadro sur, turno manana';
  const b = await generarTarjetasPDF({ cuadrilla: largo }, { ids: [1] });
  const nombre = textos(b)[1];
  assert.ok(nombre.length <= 24, 'quedó de ' + nombre.length + ': "' + nombre + '"');
  assert.ok(largo.startsWith(nombre.slice(0, 20)), 'lo recortó mal: "' + nombre + '"');
});

t('EL COLOR DE LA FRANJA ES EL DE LA CUADRILLA', async () => {
  // La franja es lo que hace que el cuadrillero agarre la tarjeta correcta sin
  // leer nada. #d62828 son 214/40/40, o sea 0.84 0.16 0.16 en PDF.
  const b = await generarTarjetasPDF({ cuadrilla: 'N', color: '#d62828' }, { ids: [1] });
  assert.match(contenido(b), /0\.84 0\.16 0\.16 rg/);
});

t('y un color que no es un hex cae al azul de la casa, no a negro ni a un error', async () => {
  // #1a3a5c son 26/58/92 → 0.1 0.23 0.36 (jsPDF redondea a dos decimales).
  for (const c of [null, '', 'rojo', '#zzz', '#12345']) {
    const b = await generarTarjetasPDF({ cuadrilla: 'N', color: c }, { ids: [1] });
    assert.match(contenido(b), /0\.1 0\.23 0\.36 rg/, 'con color ' + JSON.stringify(c));
  }
});

// ── LA HOJA ───────────────────────────────────────────────────────────────
t('se imprimen 8 tarjetas por hoja', async () => {
  const uno = await generarTarjetasPDF({ cuadrilla: 'Norte' }, { desde: 1, hasta: 8 });
  assert.equal(hojas(uno), 1);
  const dos = await generarTarjetasPDF({ cuadrilla: 'Norte' }, { desde: 1, hasta: 9 });
  assert.equal(hojas(dos), 2, 'la novena tiene que abrir hoja nueva');
  const cuatro = await generarTarjetasPDF({ cuadrilla: 'Norte' }, { desde: 1, hasta: 32 });
  assert.equal(hojas(cuatro), 4);
});

t('es un PDF de verdad, no un buffer vacío', async () => {
  const b = await generarTarjetasPDF({ cuadrilla: 'Norte', color: '#d62828' }, { desde: 1, hasta: 16 });
  assert.equal(b.slice(0, 5).toString(), '%PDF-');
  assert.match(b.toString('latin1').slice(-1024), /%%EOF/);
});

t('EL PDF VA COMPRIMIDO: una tanda entera tiene que poder descargarse', async () => {
  // Medido sin comprimir: 16 tarjetas pesan 3.037 KB, o sea que las 500 de una
  // temporada serían casi 100 MB. Nadie descarga eso para imprimirlo, y menos
  // desde el galpón. Si este test se pone rojo, lo primero que hay que mirar es
  // si alguien le sacó `compress: true` al constructor de jsPDF.
  const b = await generarTarjetasPDF({ cuadrilla: 'Norte', color: '#d62828' }, { desde: 1, hasta: 16 });
  assert.ok(kb(b) < 200, '16 tarjetas pesan ' + Math.round(kb(b)) + ' KB: ¿se perdió la compresión?');
  const todas = await generarTarjetasPDF({ cuadrilla: 'Norte' }, { desde: 1, hasta: 500 });
  assert.ok(kb(todas) < 3000, '500 tarjetas pesan ' + Math.round(kb(todas)) + ' KB');
});

t('UN RANGO VACÍO DA UNA HOJA QUE EXPLICA, no un PDF en blanco', async () => {
  // Un PDF en blanco se lee como que el sistema se rompió, y manda a alguien a
  // revisar el servidor en vez de el rango que tipeó.
  const b = await generarTarjetasPDF({}, { desde: 100, hasta: 10 });
  assert.equal(b.slice(0, 5).toString(), '%PDF-');
  assert.equal(hojas(b), 1);
  const esc = textos(b).join(' ');
  assert.match(esc, /No hay tarjetas para imprimir/);
  assert.match(esc, /desde/, 'no dice qué revisar');
});
