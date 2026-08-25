// Tests del parseo del planning de Carrefour.
//
// Se testea ESTO y no el router porque acá está lo que puede fallar en silencio: si un
// sufijo de unidad se lee mal, la fila entra igual, el total sigue dando y el share sale
// razonable — el error recién aparece cuando alguien compara contra el archivo original.
//
// Corre con `npm test` (node --test). Sin better-sqlite3: no compila en Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  norm, parseDesc, parseProveedor, parseFecha, parseBultos, fechaDelNombre,
  clasificarFamilia, FAMILIAS_VALIDAS, parseOfertaTexto, detectarColumnasOferta,
} from '../src/servicios/share_parser.js';

test('normalizar: mayúsculas, sin acentos, sin espacios de más', () => {
  assert.equal(norm('  Zapallo   Japonés  '), 'ZAPALLO JAPONES');
  assert.equal(norm('Rúcula'), 'RUCULA');
  assert.equal(norm(null), '');
  // El punto se conserva: distingue S.A. de SA en los nombres de proveedor.
  assert.equal(norm('San Gerónimo S.A.'), 'SAN GERONIMO S.A.');
});

test('sufijos de unidad: cada forma que manda Carrefour cae donde tiene que caer', () => {
  const kg = ['ZAPALLO JAPONES CABUTIAN X KG', 'MANZANA X KG.', 'pera x kg.', 'CEBOLLA IC KG'];
  for (const d of kg) {
    const a = parseDesc(d);
    assert.equal(a.unidad, 'KG', d);
    assert.equal(a.factor_kg, 1, d);
  }

  assert.equal(parseDesc('LECHUGA X UNIDAD').unidad, 'UNIDAD');
  assert.equal(parseDesc('LECHUGA X UNI').unidad, 'UNIDAD');
  assert.equal(parseDesc('ACELGA X ATADO').unidad, 'ATADO');
  assert.equal(parseDesc('PEREJIL X PAQUETE').unidad, 'PAQUETE');

  // Las unidades que no se pueden pesar quedan sin factor A PROPÓSITO: nadie sabe cuánto
  // pesa un atado, y un número inventado haría creíble un total en kilos que está mal.
  for (const d of ['LECHUGA X UNIDAD', 'ACELGA X ATADO', 'PEREJIL X PAQUETE']) {
    assert.equal(parseDesc(d).factor_kg, null, d);
  }
});

test('packs por gramos: se captura el gramaje y el factor sale de ahí', () => {
  const a = parseDesc('ARANDANO X 125 G.');
  assert.equal(a.unidad, 'PACK_GR');
  assert.equal(a.gramos, 125);
  assert.equal(a.factor_kg, 0.125);

  assert.equal(parseDesc('FRUTILLA X 250 GRS.').gramos, 250);
  assert.equal(parseDesc('MIX X 200 GRS').gramos, 200);

  // "EN CUBETA X 250 GRS." es el mismo caso con el envase adelante.
  const c = parseDesc('FRUTILLA EN CUBETA X 250 GRS.');
  assert.equal(c.unidad, 'PACK_GR');
  assert.equal(c.gramos, 250);
  assert.equal(c.articulo_base, 'FRUTILLA EN CUBETA');
});

test('lo que no se reconoce entra igual como SIN_DEFINIR — nunca se descarta', () => {
  const a = parseDesc('PRODUCTO RARO SIN SUFIJO');
  assert.equal(a.unidad, 'SIN_DEFINIR');
  assert.equal(a.factor_kg, null);
  // Sigue teniendo nombre y forma canónica: se puede mapear a mano después.
  assert.equal(a.desc_canonica, 'PRODUCTO RARO SIN SUFIJO');
  assert.ok(a.articulo_base);
});

test('variantes de calidad: artículos distintos, mismo artículo base', () => {
  const simple = parseDesc('MANZANA X KG');
  const comer  = parseDesc('MANZANA X KG. COMERCIAL');
  const impo   = parseDesc('MANZANA IMPORTADA X KG');

  // Son TRES artículos distintos: otro precio, otro proveedor, otra góndola.
  assert.notEqual(simple.desc_canonica, comer.desc_canonica);
  assert.notEqual(simple.desc_canonica, impo.desc_canonica);

  // Pero comparten base, que es lo que permite preguntar "cuánta manzana compra Carrefour".
  assert.equal(simple.articulo_base, 'MANZANA');
  assert.equal(comer.articulo_base, 'MANZANA');
  assert.equal(impo.articulo_base, 'MANZANA');

  assert.equal(simple.calidad, null);
  assert.equal(comer.calidad, 'COMERCIAL');
  assert.equal(impo.calidad, 'IMPORTADA');

  // La calidad se reconoce esté antes o después de la unidad.
  assert.equal(parseDesc('MANZANA COMERCIAL X KG.').desc_canonica, comer.desc_canonica);
});

test('la forma canónica junta las escrituras que son el mismo artículo', () => {
  // Este es el motivo de que exista desc_canonica: sin ella, el punto final de "X KG."
  // crearía un artículo paralelo y partiría la serie histórica en dos.
  const variantes = ['MANZANA X KG', 'MANZANA X KG.', 'manzana  x kg', 'Manzana X Kg.'];
  const canon = variantes.map(v => parseDesc(v).desc_canonica);
  assert.equal(new Set(canon).size, 1, 'deberían colapsar en una sola: ' + canon.join(' | '));
});

test('proveedores: nos reconocemos a nosotros y separamos la importación propia', () => {
  const yo = parseProveedor('SAN GERONIMO S.A.');
  assert.equal(yo.es_nosotros, 1);
  assert.equal(yo.tipo, 'nosotros');
  // Escrito distinto seguimos siendo nosotros.
  assert.equal(parseProveedor('San Geronimo SA').es_nosotros, 1);

  // Carrefour importando por su cuenta NO es un competidor: es el cliente compitiendo.
  const ip = parseProveedor('PROV.IMPORT.PROPIA PFT FRUT Y VERD');
  assert.equal(ip.tipo, 'importacion_propia');
  assert.equal(ip.es_nosotros, 0);

  const otro = parseProveedor('FRUTIHORTICOLA DEL SUR SRL');
  assert.equal(otro.tipo, 'competidor');
  assert.equal(otro.es_nosotros, 0);
});

test('fechas: los tres formatos con los que Excel puede entregarlas', () => {
  assert.equal(parseFecha('2026-08-24'), '2026-08-24');
  assert.equal(parseFecha('24/08/2026'), '2026-08-24');
  // Número de serie de Excel.
  assert.equal(parseFecha(46258), '2026-08-24');
  // Date, que es lo que devuelve xlsx con cellDates.
  assert.equal(parseFecha(new Date(2026, 7, 24)), '2026-08-24');
  assert.equal(parseFecha(''), null);
  assert.equal(parseFecha('cualquier cosa'), null);
});

test('fechas ambiguas: se asume DD/MM salvo que el número no deje dudas', () => {
  // Argentino: 3 de abril.
  assert.equal(parseFecha('03/04/2026'), '2026-04-03');
  // 25 no es un mes: no hay ambigüedad posible, sea cual sea el orden.
  assert.equal(parseFecha('25/12/2026'), '2026-12-25');
  assert.equal(parseFecha('12/25/2026'), '2026-12-25');
});

test('la fecha del nombre del archivo es sólo un aviso', () => {
  assert.equal(fechaDelNombre('PLANNING_FF_VV_24_08.xlsx', 2026), '2026-08-24');
  assert.equal(fechaDelNombre('PLANNING_FF_VV_01_07.xlsx', 2025), '2025-07-01');
  assert.equal(fechaDelNombre('planning.xlsx', 2026), null);
});

test('bultos: el punto es separador de miles, no decimal', () => {
  assert.equal(parseBultos(4000), 4000);
  assert.equal(parseBultos('4.000'), 4000);
  assert.equal(parseBultos('428.444'), 428444);
  // Ilegible es null, NO cero: un cero suma bien y resta mal.
  assert.equal(parseBultos('s/d'), null);
  assert.equal(parseBultos(''), null);
  assert.equal(parseBultos(null), null);
});

test('familia: las hortalizas se parten por cómo se mueven, no por botánica', () => {
  // BOLSA de 20-25 kg. Son los cuatro que nombró Andy.
  for (const x of ['CEBOLLA', 'PAPA BLANCA LAVADA', 'BATATA', 'ZAPALLO JAPONES CABUTIAN'])
    assert.equal(clasificarFamilia(x), 'HORTALIZA PESADA', x);
  // Boniato es batata, calabaza y anco son zapallo: el mismo bulto con otro nombre.
  for (const x of ['BONIATO HUELLA NATURAL', 'CALABAZA ANCO', 'ZANAHORIA'])
    assert.equal(clasificarFamilia(x), 'HORTALIZA PESADA', x);

  // CAJÓN. También los tres que nombró Andy.
  for (const x of ['TOMATE REDONDO', 'BERENJENA NEGRA', 'ZAPALLITO REDONDO', 'ZAPALLITO LARGO'])
    assert.equal(clasificarFamilia(x), 'HORTALIZA LIVIANA', x);
  // El ajo es un bulbo como la cebolla y va en LIVIANA igual: nadie lo mueve en bolsa de 25 kg.
  assert.equal(clasificarFamilia('AJO'), 'HORTALIZA LIVIANA');
  assert.equal(clasificarFamilia('PIMIENTO VERDE'), 'HORTALIZA LIVIANA');

  assert.equal(clasificarFamilia('MANZANA'), 'FRUTA');
  assert.equal(clasificarFamilia('LECHUGA MANTECOSA'), 'HOJA');
  assert.equal(clasificarFamilia('ALGO QUE NO ESTA EN LA LISTA'), 'OTRO');
  // Los hongos NO tienen familia propia en esta taxonomía: caen en OTRO.
  assert.equal(clasificarFamilia('CHAMPIGNON'), 'OTRO');
});

test('familia: se busca por palabra entera, no por pedazo de texto', () => {
  // ESTE ES EL QUE IMPORTA. Buscando "PAPA" adentro del texto, PAPAYA es una hortaliza
  // pesada. Con la lista vieja no se notaba porque FRUTA se evaluaba antes y la atajaba de
  // casualidad; al cambiar el orden de las familias esa casualidad se termina.
  assert.equal(clasificarFamilia('PAPAYA'), 'FRUTA');
  // Y ZAPALLO contra ZAPALLITO, que ahora van a familias DISTINTAS.
  assert.equal(clasificarFamilia('ZAPALLO'), 'HORTALIZA PESADA');
  assert.equal(clasificarFamilia('ZAPALLITO'), 'HORTALIZA LIVIANA');
  // El plural sí tiene que entrar: la planilla los escribe de las dos formas.
  assert.equal(clasificarFamilia('PAPAS NEGRAS'), 'HORTALIZA PESADA');
  assert.equal(clasificarFamilia('ZAPALLOS'), 'HORTALIZA PESADA');
});

test('familia: cebolla de verdeo es HOJA aunque diga cebolla', () => {
  // El orden de la lista es lo que lo resuelve: HOJA se evalúa antes que las hortalizas.
  assert.equal(clasificarFamilia('CEBOLLA'), 'HORTALIZA PESADA');
  assert.equal(clasificarFamilia('CEBOLLA DE VERDEO'), 'HOJA');
  assert.equal(clasificarFamilia('PUERRO'), 'HOJA');
});

test('las familias válidas son cinco y OTRO es una de ellas', () => {
  assert.deepEqual(FAMILIAS_VALIDAS, ['FRUTA', 'HOJA', 'HORTALIZA PESADA', 'HORTALIZA LIVIANA', 'OTRO']);
  // Todo lo que el clasificador devuelve tiene que estar en la lista: si devolviera algo que
  // no está, el router lo rechazaría como familia inválida al intentar corregirlo a mano.
  for (const x of ['MANZANA', 'PAPA', 'TOMATE', 'LECHUGA', 'CHAMPIGNON', 'COSA RARA'])
    assert.ok(FAMILIAS_VALIDAS.includes(clasificarFamilia(x)), x);
});

test('oferta pegada: la cantidad es el ÚLTIMO número de la línea', () => {
  // Los nombres traen números adentro. Buscar "el número" agarraría el del nombre.
  const r = parseOfertaTexto([
    'MANZANA X KG\t500',
    'TOMATE REDONDO X KG, 300',
    'ZAPALLITO LARGO 200',
    'PALTA X UNIDAD;120',
    'FRUTILLA EN CUBETA X 250 GRS  80',
    'MANZANA CAL 100   45',
  ].join('\n'));
  assert.equal(r.filas.length, 6);
  assert.deepEqual(r.filas.map(f => f.cantidad), [500, 300, 200, 120, 80, 45]);
  // El gramaje y el calibre quedan en el nombre, que es donde van.
  assert.equal(r.filas[4].articulo_raw, 'FRUTILLA EN CUBETA X 250 GRS');
  assert.equal(r.filas[5].articulo_raw, 'MANZANA CAL 100');
});

test('oferta pegada: lo que no se entiende se informa, no se descarta en silencio', () => {
  const r = parseOfertaTexto('MANZANA X KG 10\n\nrenglon sin cantidad\n   \nPERA X KG abc');
  assert.equal(r.filas.length, 1);
  // Las líneas vacías no son un problema; las otras dos sí y viajan con el motivo.
  assert.equal(r.rechazadas.length, 2);
  assert.ok(r.rechazadas.every(x => x.linea && x.texto && x.motivo));
});

test('oferta pegada: el punto es separador de miles, igual que en el planning', () => {
  const r = parseOfertaTexto('PAPA X KG\t4.000');
  assert.equal(r.filas[0].cantidad, 4000);
});

test('oferta en Excel: se reconocen los títulos habituales', () => {
  assert.deepEqual(detectarColumnasOferta(['Articulo', 'Cantidad']), { articulo: 0, cantidad: 1, hayTitulos: true });
  assert.deepEqual(detectarColumnasOferta(['Producto', 'Bultos']), { articulo: 0, cantidad: 1, hayTitulos: true });
  assert.deepEqual(detectarColumnasOferta(['Descripción', 'Disponibles']), { articulo: 0, cantidad: 1, hayTitulos: true });
  // Sin títulos reconocibles avisa que no los hay, y el router cae a "primera de texto,
  // primera de números" en vez de exigir un formato que nadie tiene.
  assert.equal(detectarColumnasOferta(['MANZANA X KG', 500]).hayTitulos, false);
});
