// ══ 📷 GALPÓN · LEER LA PLANILLA DE PAPEL ════════════════════════════════
//
// Andy, 2/11/2026: «¿podremos desarrollar una carga rápida por foto? O sea
// cargamos la foto de esto y que genere sola los ingresos».
//
// Lo que puede salir mal NO es la llamada a la IA: es lo que se hace con lo
// que contesta. Y falla callado, que es lo peor que puede pasarle a esto:
//
//   1. Un peso que no se leyó, entrando como 0 o como null. Un renglón de 0 kg
//      existe, suma cero y baja el promedio sin que nadie lo mire.
//   2. El ÍDEM sin resolver. En el papel el viaje y la finca se escriben una
//      vez y abajo van comillas: veinte filas sin viaje son veinte cargas que
//      no se pueden atribuir a ningún camión.
//   3. El estado sanitario leído de lo PREIMPRESO. «B / R / M» está escrito en
//      las veintiún filas y lo que vale es cuál está circulado. Devolver "B"
//      siempre es una planilla donde todo figura bueno — y la firman tres
//      personas.
//   4. Una fila PERDIDA. No la delata el total ni el peso: la delata que el
//      correlativo salte.
//
// Los dos fixtures de abajo son la transcripción de las DOS FOTOS que mandó
// Andy el 2/11, con sus rarezas puestas a propósito.
//
// Es lógica pura: no importa nada, no hay red, no hay clave y no gasta un peso.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  promptPlanilla, jsonDeRespuesta, filasDePlanilla, totalDePlanilla,
  saltoDeNumeracion, enteroPlanilla, fotoDeDataUrl, cargaDeFila,
  cuadrillasDeFila, normPapel, loteDePapel, resolverLotes,
  TIPOS_FOTO, FOTO_MAX_BYTES, MAX_FILAS,
} from '../src/servicios/galponPlanillaOCR.js';

// ── LAS DOS PLANILLAS DE VERDAD ──────────────────────────────────────────
// Foto 1: arranca con el último bolsón del viaje 13 y sigue con el 14 entero.
// La finca se escribe UNA vez ("La Estación", en la fila del viaje 14) y el
// sanitario está circulado sólo en las dos primeras.
const FOTO_1 = {
  fecha: null,
  cultivo: null,
  filas: [
    { viaje: 13, finca: null, lote: null, numero: 48, kilos: 15.9, sanitario: 'B' },
    { viaje: 14, finca: 'La Estación', lote: null, numero: 1, kilos: 9.7, sanitario: 'B' },
    { viaje: null, finca: null, lote: null, numero: 2, kilos: 15.4, sanitario: null },
    { viaje: null, finca: null, lote: null, numero: 3, kilos: 8.6, sanitario: null },
    { viaje: null, finca: null, lote: null, numero: 4, kilos: 16.7, sanitario: null },
    { viaje: null, finca: null, lote: null, numero: 5, kilos: 15.4, sanitario: null },
    { viaje: null, finca: null, lote: null, numero: 6, kilos: 10.5, sanitario: null },
    { viaje: null, finca: null, lote: null, numero: 7, kilos: 12.3, sanitario: null },
    { viaje: null, finca: null, lote: null, numero: 8, kilos: 11.7, sanitario: null },
    { viaje: null, finca: null, lote: null, numero: 9, kilos: 13.5, sanitario: null },
    { viaje: null, finca: null, lote: null, numero: 10, kilos: 16.9, sanitario: null },
  ],
};

// Foto 2: está ACOSTADA 90° en el papel, trae lote ("10", "11") y el sanitario
// circulado en todas. Termina con la primera fila del viaje 6.
const FOTO_2 = {
  fecha: null,
  cultivo: null,
  filas: [
    { viaje: 5, finca: 'La Estación', lote: '10', numero: 2, kilos: 6.9, sanitario: 'B' },
    { viaje: null, finca: '"', lote: '11', numero: 3, kilos: 14.3, sanitario: 'B' },
    { viaje: null, finca: '"', lote: '"', numero: 4, kilos: 15.4, sanitario: 'B' },
    { viaje: null, finca: '"', lote: '"', numero: 5, kilos: null, sanitario: 'B',
      duda: 'el peso está pisado, puede ser 8,66 o 8,80' },
    { viaje: null, finca: '"', lote: '"', numero: 6, kilos: 14.1, sanitario: 'B' },
    { viaje: null, finca: '"', lote: '"', numero: 7, kilos: 9.8, sanitario: 'B' },
    { viaje: 6, finca: 'La Estación', lote: 'Llyun 10', numero: 1, kilos: 13.2, sanitario: 'B' },
  ],
};

// ══════════════════════════════════════════════════════════════════════════
// 1 · EL ÍDEM DEL PAPEL
// ══════════════════════════════════════════════════════════════════════════
test('EL VIAJE SE PROPAGA HACIA ABAJO hasta que aparece otro', () => {
  // En el papel se escribe una vez y abajo van comillas. Sin propagar, diez
  // cargas quedan sin camión y la planilla de control no se puede reconstruir.
  const r = filasDePlanilla(FOTO_1);
  assert.equal(r.ok, true);
  assert.equal(r.filas.length, 11);
  assert.equal(r.filas[0].viaje, 13);
  for (let i = 1; i < 11; i++) {
    assert.equal(r.filas[i].viaje, 14, 'la fila ' + i + ' perdió el viaje');
  }
});

test('LA FINCA Y EL LOTE TAMBIÉN, y las comillas valen lo mismo que el vacío', () => {
  // El modelo puede devolver la comilla literal en vez de resolverla. Tomarla
  // como valor dejaría una finca llamada «"».
  const r = filasDePlanilla(FOTO_2);
  assert.deepEqual(r.filas.map((f) => f.finca),
    ['La Estación', 'La Estación', 'La Estación', 'La Estación', 'La Estación',
     'La Estación', 'La Estación']);
  assert.deepEqual(r.filas.map((f) => f.lote),
    ['10', '11', '11', '11', '11', '11', 'Llyun 10']);
});

test('un valor NUEVO corta la propagación de ahí para abajo', () => {
  const r = filasDePlanilla(FOTO_2);
  assert.equal(r.filas[6].viaje, 6);
  assert.equal(r.filas[6].lote, 'Llyun 10');
  assert.equal(r.filas[5].viaje, 5);
});

test('la finca no se propaga desde la nada', () => {
  const r = filasDePlanilla({ filas: [{ numero: 1, kilos: 10 }, { numero: 2, kilos: 11 }] });
  assert.equal(r.filas[0].finca, null);
  assert.equal(r.filas[0].viaje, null);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL PESO QUE NO SE LEYÓ
// ══════════════════════════════════════════════════════════════════════════
test('UN PESO QUE NO SE LEYÓ VUELVE EN null Y MARCADO, no en cero', () => {
  /* Es la regla que ordena todo esto. Un 0 entra como un renglón creíble que
     baja el promedio; un null lo completa una persona en dos segundos. */
  const r = filasDePlanilla(FOTO_2);
  const mal = r.filas[3];
  assert.equal(mal.kilos, null);
  assert.equal(mal.ok, false);
  assert.match(mal.duda, /8,66 o 8,80/, 'se perdió la duda que explicó la IA');
  assert.match(mal.duda, /no se pudo leer el peso/);
  // Y el resto sigue estando: una celda ilegible no se lleva la fila entera.
  assert.equal(mal.numero, 5);
  assert.equal(mal.sanitario, 'B');
  assert.equal(r.filas.filter((f) => f.ok).length, 6);
});

test('un peso en CERO o NEGATIVO se trata como ilegible, no como peso', () => {
  // Un bolsón de 0 kg no existe: si eso llegó, es que se leyó mal.
  const r = filasDePlanilla({ filas: [
    { numero: 1, kilos: 0 }, { numero: 2, kilos: -5 }, { numero: 3, kilos: 12.4 },
  ] });
  assert.deepEqual(r.filas.map((f) => f.ok), [false, false, true]);
  assert.match(r.filas[0].duda, /no se pudo leer|no puede ser/);
  assert.match(r.filas[1].duda, /no puede ser/);
});

test('el peso se lee igual que en todo el módulo: 15,90 son quince kilos y pico', () => {
  // Se usa kilos() de servicios/galpon.js, la misma que valida una carga a mano.
  const r = filasDePlanilla({ filas: [
    { numero: 1, kilos: 15.9 }, { numero: 2, kilos: '15,90' },
    { numero: 3, kilos: '1.250' }, { numero: 4, kilos: '12,345' },
  ] });
  assert.deepEqual(r.filas.map((f) => f.kilos), [15.9, 15.9, 1250, 12.35]);
});

test('EL AVISO DICE CUÁNTOS RENGLONES FALTAN COMPLETAR', () => {
  const r = filasDePlanilla(FOTO_2);
  assert.ok(r.avisos.some((a) => /1 renglón sin peso/.test(a)), r.avisos.join(' | '));
  const dos = filasDePlanilla({ filas: [
    { numero: 1, kilos: null }, { numero: 2, kilos: null }, { numero: 3, kilos: 9 },
  ] });
  assert.ok(dos.avisos.some((a) => /2 renglones sin peso/.test(a)));
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL ESTADO SANITARIO
// ══════════════════════════════════════════════════════════════════════════
test('SIN CIRCULAR ES null, Y null NO ES «B»', () => {
  /* «B / R / M» está PREIMPRESO en las veintiún filas. Una planilla donde todo
     figura bueno porque nadie completó la columna es peor que una con huecos:
     la firman tres personas. */
  const r = filasDePlanilla(FOTO_1);
  assert.equal(r.filas[0].sanitario, 'B');
  assert.equal(r.filas[1].sanitario, 'B');
  for (let i = 2; i < 11; i++) {
    assert.equal(r.filas[i].sanitario, null, 'la fila ' + i + ' inventó un estado sanitario');
  }
});

test('lo que no es B, R o M no entra', () => {
  const r = filasDePlanilla({ filas: [
    { numero: 1, kilos: 9, sanitario: 'b' }, { numero: 2, kilos: 9, sanitario: 'X' },
    { numero: 3, kilos: 9, sanitario: 'Bueno' }, { numero: 4, kilos: 9, sanitario: '' },
  ] });
  assert.deepEqual(r.filas.map((f) => f.sanitario), ['B', null, 'B', null]);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LA FILA PERDIDA
// ══════════════════════════════════════════════════════════════════════════
test('UN SALTO EN EL CORRELATIVO SE AVISA: es lo único que delata una fila perdida', () => {
  /* Ni el total ni el peso lo muestran. En el papel el N° de bolsón arranca en
     1 con cada viaje y sube de a uno. */
  const r = filasDePlanilla({ filas: [
    { viaje: 3, numero: 1, kilos: 10 },
    { viaje: 3, numero: 2, kilos: 11 },
    { viaje: 3, numero: 4, kilos: 12 },
  ] });
  assert.ok(r.avisos.some((a) => /saltan del 2 al 4/.test(a)), r.avisos.join(' | '));
});

test('pero el reinicio en cada viaje NO es un salto', () => {
  // Del 21 del camión anterior al 1 del siguiente: eso es lo normal.
  const r = filasDePlanilla({ filas: [
    { viaje: 5, numero: 20, kilos: 10 },
    { viaje: 5, numero: 21, kilos: 11 },
    { viaje: 6, numero: 1, kilos: 12 },
  ] });
  assert.equal(saltoDeNumeracion(r.filas), null);
  assert.deepEqual(r.avisos, []);
});

test('y las dos fotos de verdad no tienen saltos', () => {
  assert.equal(saltoDeNumeracion(filasDePlanilla(FOTO_1).filas), null);
  assert.equal(saltoDeNumeracion(filasDePlanilla(FOTO_2).filas), null);
});

test('un número que no se leyó no inventa un salto', () => {
  const r = filasDePlanilla({ filas: [
    { viaje: 1, numero: 1, kilos: 10 },
    { viaje: 1, numero: null, kilos: 11 },
    { viaje: 1, numero: 2, kilos: 12 },
  ] });
  assert.equal(saltoDeNumeracion(r.filas), null);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · EL TOTAL QUE SE COMPARA CONTRA EL PAPEL
// ══════════════════════════════════════════════════════════════════════════
test('EL TOTAL CUENTA SÓLO LO QUE SE PUEDE CARGAR', () => {
  /* Un renglón sin peso sumando cero diría que está todo bien justo cuando
     falta algo. Se cuenta aparte. */
  const t = totalDePlanilla(filasDePlanilla(FOTO_2).filas);
  assert.equal(t.cargas, 6);
  assert.equal(t.sin_peso, 1);
  assert.equal(t.kilos, 73.7);
  assert.equal(t.promedio, 12.28);
});

test('el de la primera foto da lo que suma el papel', () => {
  const t = totalDePlanilla(filasDePlanilla(FOTO_1).filas);
  assert.equal(t.cargas, 11);
  assert.equal(t.kilos, 146.6);
  assert.equal(t.sin_peso, 0);
});

test('sin filas no divide por cero', () => {
  assert.deepEqual(totalDePlanilla([]), { cargas: 0, sin_peso: 0, kilos: 0, promedio: 0 });
  assert.deepEqual(totalDePlanilla(null), { cargas: 0, sin_peso: 0, kilos: 0, promedio: 0 });
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · UNA RESPUESTA ROTA NO PUEDE ROMPER LA PANTALLA
// ══════════════════════════════════════════════════════════════════════════
test('NUNCA TIRA: lo que no se entiende termina en «cargalo a mano»', () => {
  for (const basura of [null, undefined, 'texto', 42, [], {}, { filas: null },
    { filas: [] }, { filas: 'no es una lista' }]) {
    const r = filasDePlanilla(basura);
    assert.equal(r.ok, false, JSON.stringify(basura) + ' pasó como lectura buena');
    assert.ok(r.motivo, 'no dijo qué pasó');
    assert.deepEqual(r.filas, []);
  }
});

test('una fila que no es un objeto no voltea la lectura entera', () => {
  const r = filasDePlanilla({ filas: [{ numero: 1, kilos: 10 }, null, 'x', { numero: 2, kilos: 11 }] });
  assert.equal(r.ok, true);
  assert.equal(r.filas.length, 4);
  assert.equal(r.filas.filter((f) => f.ok).length, 2);
});

test('HAY UN TECHO DE FILAS, y se avisa cuando se corta', () => {
  // Una planilla tiene 21 renglones impresos. Trescientas es una respuesta
  // delirante, y sin techo llena la pantalla de basura.
  const muchas = [];
  for (let i = 1; i <= MAX_FILAS + 20; i++) muchas.push({ numero: i, kilos: 10 });
  const r = filasDePlanilla({ filas: muchas });
  assert.equal(r.filas.length, MAX_FILAS);
  assert.ok(r.avisos.some((a) => /se tomaron las primeras/.test(a)));
});

test('la fecha del encabezado entra sólo si es una fecha', () => {
  assert.equal(filasDePlanilla({ fecha: '2026-11-20', filas: [{ kilos: 9 }] }).fecha, '2026-11-20');
  assert.equal(filasDePlanilla({ fecha: '20/11/26', filas: [{ kilos: 9 }] }).fecha, null);
  assert.equal(filasDePlanilla({ fecha: null, filas: [{ kilos: 9 }] }).fecha, null);
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · EL JSON QUE CONTESTA EL MODELO
// ══════════════════════════════════════════════════════════════════════════
test('saca el JSON aunque venga envuelto en markdown', () => {
  const con = '```json\n{"filas":[{"numero":1,"kilos":9}]}\n```';
  assert.deepEqual(jsonDeRespuesta(con), { filas: [{ numero: 1, kilos: 9 }] });
  assert.deepEqual(jsonDeRespuesta('{"filas":[]}'), { filas: [] });
  assert.deepEqual(jsonDeRespuesta('Acá va:\n{"filas":[]}\nEso es todo.'), { filas: [] });
});

test('y si no hay JSON devuelve null, no explota', () => {
  for (const x of ['', '   ', null, undefined, 'no pude leer la foto', '{roto']) {
    assert.equal(jsonDeRespuesta(x), null, JSON.stringify(x));
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 8 · LA FOTO QUE LLEGA
// ══════════════════════════════════════════════════════════════════════════
const dataUrl = (tipo, bytes) => 'data:' + tipo + ';base64,'
  + Buffer.from(bytes).toString('base64');
const JPG = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A];

test('acepta JPG, PNG y WEBP — que es lo que sale de un teléfono', () => {
  const j = fotoDeDataUrl(dataUrl('image/jpeg', JPG));
  assert.equal(j.ok, true);
  assert.equal(j.media_type, 'image/jpeg');
  assert.equal(j.bytes, 6);
  assert.equal(fotoDeDataUrl(dataUrl('image/png', PNG)).ok, true);
  assert.deepEqual(Object.keys(TIPOS_FOTO).sort(),
    ['image/jpeg', 'image/png', 'image/webp']);
});

test('NO ACEPTA SVG, y la razón no es el formato', () => {
  /* Un SVG es un documento: puede traer texto escondido adentro. Acá además se
     le manda a un modelo — o sea, es una manera de decirle a la IA algo que el
     que sacó la foto no escribió. */
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64');
  const r = fotoDeDataUrl(svg);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /JPG, PNG o WEBP/);
});

test('LOS MAGIC BYTES MANDAN, no el encabezado del data URL', () => {
  // "data:image/png" lo escribe quien manda el pedido y no prueba nada.
  const mentira = dataUrl('image/png', [0x3C, 0x73, 0x76, 0x67]);
  const r = fotoDeDataUrl(mentira);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /dice ser image\/png y no lo es/);
});

test('lo que no es una foto se rechaza y dice qué pasó', () => {
  for (const x of ['', null, undefined, 'hola', 'data:text/plain;base64,aG9sYQ==']) {
    const r = fotoDeDataUrl(x);
    assert.equal(r.ok, false, JSON.stringify(x));
    assert.ok(r.motivo);
  }
});

test('hay un tope de 5 MB, que es el de la API', () => {
  const grande = new Uint8Array(FOTO_MAX_BYTES + 1024);
  grande.set(JPG);
  const r = fotoDeDataUrl(dataUrl('image/jpeg', grande));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /máximo son 5 MB/);
});

// ══════════════════════════════════════════════════════════════════════════
// 9 · LA CARGA QUE SE ARMA CON CADA FILA
// ══════════════════════════════════════════════════════════════════════════
test('CADA FILA ES UN BOLSÓN: ifcos va en 1, como en la carga rápida', () => {
  // Es lo que hace que el promedio por cajón signifique algo, y es el número
  // con el que se ve una pesada mal tipeada entre veinte parecidas.
  const c = cargaDeFila({ kilos: 15.9, viaje: 13, sanitario: 'B' },
    { fecha: '2026-11-20', lote_id: '10', producto: 'Damasco', cuadrilla_ids: ['1', '2'] });
  assert.equal(c.ifcos, 1);
  assert.equal(c.kilos, 15.9);
  assert.equal(c.fecha, '2026-11-20');
  assert.equal(c.lote_id, '10');
  assert.deepEqual(c.cuadrilla_ids, ['1', '2']);
  assert.equal(c.origen, 'manual');
});

test('EL VIAJE SALE DE LA FILA, no del encabezado', () => {
  /* Una foto puede tener el final de un camión y el principio del siguiente:
     es exactamente lo que pasa en las dos planillas del 2/11. Con un viaje
     único para toda la foto, once cargas quedarían atribuidas al camión
     equivocado. */
  const r = filasDePlanilla(FOTO_1);
  const comun = { fecha: '2026-11-20', lote_id: '10' };
  assert.equal(cargaDeFila(r.filas[0], comun).viaje, 13);
  assert.equal(cargaDeFila(r.filas[1], comun).viaje, 14);
});

test('sin cuadrilla manda la lista vacía, no un undefined', () => {
  const c = cargaDeFila({ kilos: 9 }, { fecha: '2026-11-20', lote_id: '10' });
  assert.deepEqual(c.cuadrilla_ids, []);
  assert.equal(c.producto, null);
  assert.equal(c.sanitario, null);
});

// ══════════════════════════════════════════════════════════════════════════
// 10 · EL PEDIDO QUE SE LE HACE AL MODELO
// ══════════════════════════════════════════════════════════════════════════
test('EL PROMPT DICE LAS CUATRO COSAS QUE SE APRENDIERON DE LAS FOTOS', () => {
  /* Cada una está porque una de las dos fotos la necesitaba. Un prompt que
     pierde una de estas líneas sigue devolviendo un JSON válido y lleno de
     números creíbles — que es la forma en que esto se rompe sin avisar. */
  const p = promptPlanilla();
  assert.match(p, /ROTADA 90/, 'la segunda foto está acostada y pasa siempre');
  assert.match(p, /comillas/, 'sin esto, veinte filas vuelven sin viaje ni finca');
  assert.match(p, /PREIMPRESO/, 'sin esto, el sanitario vuelve "B" en todas');
  assert.match(p, /COMA DECIMAL/, 'el peso del papel va con coma');
  assert.match(p, /No adivines/, 'un peso inventado no lo encuentra nadie');
  // Y que pida JSON y nada más, que es lo que después se parsea.
  assert.match(p, /SOLO un objeto JSON/);
});

test('enteroPlanilla no deja pasar el cero: no hay bolsón número cero', () => {
  assert.equal(enteroPlanilla(21), 21);
  assert.equal(enteroPlanilla('21'), 21);
  assert.equal(enteroPlanilla('N° 21'), 21);
  assert.equal(enteroPlanilla(0), null);
  assert.equal(enteroPlanilla(-3), null);
  assert.equal(enteroPlanilla(''), null);
  assert.equal(enteroPlanilla(null), null);
  assert.equal(enteroPlanilla('hola'), null);
});

// ══════════════════════════════════════════════════════════════════════════
// UNA HOJA MEZCLADA: DOS CUADRILLAS Y DOS FINCAS (V1137)
// ══════════════════════════════════════════════════════════════════════════
//
// Andy, 2/11/2026: «a veces en la misma hoja tenemos algunos cajones que son
// de una cuadrilla y otros de otra. Y fincas también puede pasar lo mismo».
//
// El encabezado dejó de ser LA respuesta y pasó a ser el valor POR OMISIÓN.
// Y el papel YA trae las columnas Finca y «Lote y/o Llave», así que
// preguntárselas renglón por renglón sería pedirle a una persona que
// transcriba lo que acaba de transcribir una máquina.
//
// LO QUE NO SE HACE ES ADIVINAR. Un lote mal atribuido no se nota nunca —los
// kilos están, el total cierra— y deja el rinde de dos cuadros cruzado para
// toda la temporada. Con dos candidatos, o con ninguno, devuelve null y el
// motivo escrito.

// Cuatro lotes a propósito: con uno solo, resolver «la finca» acertaría
// siempre y el test no distinguiría encontrarlo de elegir el único que hay.
const PADRON = [
  { id: 10, nombre: 'Cuadro 3', finca: 'La Estación' },
  { id: 11, nombre: 'Cuadro 4', finca: 'La Estación' },
  { id: 12, nombre: 'Peñas Sur', finca: 'Las Peñas' },
  { id: 13, nombre: 'San José', finca: 'San José' },
];

test('EL ACENTO SE CAE Y LA Ñ QUEDA', () => {
  /* El acento pide una tecla muerta y nadie lo escribe al transcribir, así que
     «La Estacion» tiene que encontrar «La Estación». La Ñ NO: es una letra del
     idioma y tiene tecla propia, y «Las Penas» y «Las Peñas» pueden ser dos
     fincas distintas — confundirlas manda los kilos al campo de al lado.
     Es la misma regla que sgNorm en el panel (CLAUDE.md). */
  assert.equal(normPapel('La Estación'), 'la estacion');
  assert.equal(normPapel('LA ESTACION'), 'la estacion');
  assert.equal(normPapel('Las Peñas'), 'las peñas');
  assert.notEqual(normPapel('Las Peñas'), normPapel('Las Penas'));
  // Y los separadores no cuentan: en el papel se escribe como sale.
  assert.equal(normPapel('  cuadro-3 '), 'cuadro 3');
  assert.equal(normPapel('Cuadro  3'), 'cuadro 3');
  assert.equal(normPapel(null), '');
});

test('LA FINCA Y EL LOTE DEL PAPEL ENCUENTRAN EL LOTE', () => {
  assert.equal(loteDePapel(PADRON, 'La Estacion', 'Cuadro 3').lote_id, 10);
  assert.equal(loteDePapel(PADRON, 'LA ESTACIÓN', 'cuadro 4').lote_id, 11);
  // Sin finca, con el nombre del lote solo, también.
  assert.equal(loteDePapel(PADRON, null, 'Peñas Sur').lote_id, 12);
});

test('la finca sola alcanza si tiene UN lote, y si no, no', () => {
  // Las Peñas tiene uno: es el caso de la finca chica, el más frecuente.
  assert.equal(loteDePapel(PADRON, 'Las Peñas', null).lote_id, 12);
  // La Estación tiene dos. Elegir uno sería tirar una moneda.
  const r = loteDePapel(PADRON, 'La Estación', null);
  assert.equal(r.lote_id, null);
  assert.match(r.motivo, /tiene 2 lotes/);
});

test('NO ADIVINA, Y DICE POR QUÉ', () => {
  const a = loteDePapel(PADRON, 'La Quinta', 'Cuadro 1');
  assert.equal(a.lote_id, null);
  assert.match(a.motivo, /no hay ninguna finca «La Quinta»/);

  const b = loteDePapel(PADRON, 'La Estación', 'Cuadro 9');
  assert.equal(b.lote_id, null);
  assert.match(b.motivo, /no hay ningún lote «Cuadro 9»/);
  assert.match(b.motivo, /en la finca «La Estación»/);

  // Dos lotes con el mismo nombre en fincas distintas, sin finca en el papel.
  const dup = PADRON.concat([{ id: 14, nombre: 'Cuadro 3', finca: 'San José' }]);
  const c = loteDePapel(dup, null, 'Cuadro 3');
  assert.equal(c.lote_id, null);
  assert.match(c.motivo, /hay 2 lotes «Cuadro 3»/);
});

test('y si el papel no dijo nada, no es un problema', () => {
  /* Es el caso normal de la hoja de un solo lote: queda el del encabezado y no
     se avisa nada. Un aviso acá saldría en todas las planillas y en dos días
     nadie lee ninguno. */
  const r = loteDePapel(PADRON, null, null);
  assert.equal(r.lote_id, null);
  assert.equal(r.motivo, null);
});

test('RESOLVER TODAS: los avisos se agrupan, no se repiten veintiuna veces', () => {
  const filas = [
    { finca: 'Las Peñas', lote: null, kilos: 10 },
    { finca: 'La Quinta', lote: null, kilos: 11 },
    { finca: 'La Quinta', lote: null, kilos: 12 },
    { finca: 'La Quinta', lote: null, kilos: 13 },
    { finca: 'La Estación', lote: 'Cuadro 4', kilos: 14 },
  ];
  const r = resolverLotes(PADRON, filas);
  assert.deepEqual(r.filas.map((f) => f.lote_id), [12, null, null, null, 11]);
  assert.equal(r.resueltos, 2);
  // UN aviso para los tres renglones de La Quinta, con la cuenta.
  assert.equal(r.avisos.length, 1);
  assert.match(r.avisos[0], /La Quinta/);
  assert.match(r.avisos[0], /3 renglones/);
});

test('resolver no pisa lo que la fila ya traía', () => {
  // Devuelve copias: el kilo, el viaje y la observación siguen ahí.
  const r = resolverLotes(PADRON, [{ finca: 'Las Peñas', viaje: 13, kilos: 9.7, ok: true }]);
  assert.equal(r.filas[0].kilos, 9.7);
  assert.equal(r.filas[0].viaje, 13);
  assert.equal(r.filas[0].ok, true);
  assert.equal(r.filas[0].lote_id, 12);
  assert.equal(r.filas[0].lote_motivo, null);
});

test('LO DE LA FILA LE GANA AL ENCABEZADO', () => {
  const comun = { fecha: '2026-11-20', lote_id: '10', cuadrilla_ids: ['1'] };
  // Sin nada propio, hereda.
  const a = cargaDeFila({ kilos: 9 }, comun);
  assert.equal(a.lote_id, '10');
  assert.deepEqual(a.cuadrilla_ids, ['1']);
  // Con lo suyo, manda lo suyo.
  const b = cargaDeFila({ kilos: 9, lote_id: 12, cuadrilla_id: '2' }, comun);
  assert.equal(b.lote_id, 12);
  assert.deepEqual(b.cuadrilla_ids, ['2']);
});

test('«el de arriba» es el vacío, no el cero', () => {
  /* El <select> manda '' cuando está en «↑ el de arriba». Si se tratara como un
     valor, el renglón se cargaría sin lote y el servidor lo rebotaría — con el
     encabezado elegido y a la vista. */
  const comun = { lote_id: '10', cuadrilla_ids: ['1'] };
  const c = cargaDeFila({ kilos: 9, lote_id: '', cuadrilla_id: '' }, comun);
  assert.equal(c.lote_id, '10');
  assert.deepEqual(c.cuadrilla_ids, ['1']);
});

test('la cuadrilla de la fila es UNA y reemplaza a las dos de arriba', () => {
  /* Arriba pueden ser dos —el cajón que llenaron entre las dos, V1133— y el
     reparto es en partes iguales. El renglón que dice «Sur» dice que ESE cajón
     es de la Sur entero: reemplaza, no se suma. */
  const comun = { cuadrilla_ids: ['1', '2'] };
  assert.deepEqual(cuadrillasDeFila({}, comun), ['1', '2']);
  assert.deepEqual(cuadrillasDeFila({ cuadrilla_id: '2' }, comun), ['2']);
  // Y sin nada en ningún lado, una lista vacía y no un undefined.
  assert.deepEqual(cuadrillasDeFila({}, {}), []);
  assert.deepEqual(cuadrillasDeFila(null, null), []);
});

test('el prompt sigue pidiendo la finca y el lote de cada fila', () => {
  /* Resolver contra el padrón no sirve de nada si el lector deja de traerlas, y
     eso no se vería: todos los renglones quedarían en «el de arriba», que es
     exactamente como se veía antes de la V1137. */
  assert.match(promptPlanilla(), /"finca": string o null/);
  assert.match(promptPlanilla(), /"lote": string o null/);
  assert.match(promptPlanilla(), /EL VIAJE, LA FINCA Y EL LOTE SE ESCRIBEN UNA SOLA VEZ/);
});
