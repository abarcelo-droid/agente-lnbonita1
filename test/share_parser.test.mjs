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
  norm, parseDesc, parseProveedor, parseFecha, parseBultos, fechaDelNombre, clasificarFamilia,
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

test('familia: la primera pasada automática acierta lo evidente', () => {
  assert.equal(clasificarFamilia('MANZANA'), 'FRUTA');
  assert.equal(clasificarFamilia('ZAPALLO JAPONES CABUTIAN'), 'VERDURA');
  assert.equal(clasificarFamilia('LECHUGA MANTECOSA'), 'HOJA');
  assert.equal(clasificarFamilia('CHAMPIGNON'), 'HONGO');
  assert.equal(clasificarFamilia('ALGO QUE NO ESTA EN LA LISTA'), 'OTRO');
  // Cebolla es verdura, pero cebolla DE VERDEO es hoja: el orden de la lista lo resuelve.
  assert.equal(clasificarFamilia('CEBOLLA'), 'VERDURA');
  assert.equal(clasificarFamilia('CEBOLLA DE VERDEO'), 'HOJA');
});
