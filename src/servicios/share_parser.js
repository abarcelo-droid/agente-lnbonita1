// src/servicios/share_parser.js
// ── EL PARSEO DEL PLANNING DE CARREFOUR ───────────────────────────────────────────────
// Todo lo que hay que interpretar de una fila del Excel vive acá, en funciones puras y sin
// base de datos, por dos motivos: se puede testear con `node --test` (no hay forma de correr
// better-sqlite3 en la máquina de Andy) y el importador web y el masivo por línea de comando
// usan EXACTAMENTE el mismo código. Si el parseo viviera adentro del router, la carga masiva
// tendría su propia versión y las dos bases terminarían distintas.
//
// LA UNIDAD VIENE ADENTRO DEL TEXTO. Carrefour no manda una columna de unidad: manda
// "ZAPALLO JAPONES CABUTIAN X KG" y hay que leerle el sufijo. Y "X 250 GRS." no es lo mismo
// que "X KG": son bultos distintos y no se pueden sumar entre sí sin convertir.
//
// LO QUE NO SE ENTIENDE NO SE TIRA. Un sufijo desconocido no descarta la fila: la marca
// SIN_DEFINIR y la manda a la cola de mapeo. Descartar en silencio es la única forma de que
// un informe mienta sin que nadie se entere.

// ── Normalización de texto ────────────────────────────────────────────────────────────
// Mayúsculas, sin acentos, sin espacios de más. Se aplica ANTES de comparar cualquier cosa:
// "Zapallo  Japonés" y "ZAPALLO JAPONES" son el mismo producto y no pueden crear dos filas.
// Los puntos NO se tocan acá porque distinguen "S.A." de "SA" en los nombres de proveedor;
// las diferencias de puntuación se resuelven en la forma canónica, más abajo.
export function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Unidades ──────────────────────────────────────────────────────────────────────────
// El orden IMPORTA: PACK_GR va primero porque "X 250 GRS." también empieza con "X" y
// cualquiera de los otros patrones más laxos se lo comería.
//
// factor_kg es cuántos kilos hay en UN bulto. Sólo se conoce para KG (1) y para los packs
// por gramos (gr/1000). Para UNIDAD, ATADO y PAQUETE es NULL a propósito: no sabemos cuánto
// pesa un atado de acelga, y ponerle un número inventado haría que un total en kilos se vea
// perfectamente creíble estando mal.
const UNIDADES = [
  { u: 'PACK_GR', re: /\bX\s*(\d+(?:[.,]\d+)?)\s*(?:GRS?|GRAMOS?|G)\.?$/ },
  { u: 'KG',      re: /\b(?:X|IC)\s*KGS?\.?$/ },
  { u: 'UNIDAD',  re: /\bX\s*(?:UNIDADES?|UNIDAD|UNID|UNI|UN)\.?$/ },
  { u: 'ATADO',   re: /\bX\s*ATADOS?\.?$/ },
  { u: 'PAQUETE', re: /\bX\s*(?:PAQUETES?|PAQUETE|PAQ)\.?$/ },
];

// Cómo se vuelve a escribir cada unidad en la forma canónica. Esto es lo que hace que
// "MANZANA X KG" y "MANZANA X KG." sean UN artículo y no dos.
function sufijoUnidad(unidad, gramos) {
  if (unidad === 'KG')      return ' X KG';
  if (unidad === 'UNIDAD')  return ' X UNIDAD';
  if (unidad === 'ATADO')   return ' X ATADO';
  if (unidad === 'PAQUETE') return ' X PAQUETE';
  if (unidad === 'PACK_GR') return ' X ' + gramos + ' GRS';
  return '';
}

// ── Calidad ───────────────────────────────────────────────────────────────────────────
// "MANZANA X KG" y "MANZANA X KG. COMERCIAL" son artículos DISTINTOS (otro precio, otro
// proveedor, otra góndola) pero comparten el artículo base MANZANA, que es lo que permite
// preguntar "cuánta manzana compra Carrefour" sin sumar peras.
//
// La palabra puede venir antes o después de la unidad, así que se saca de donde esté en vez
// de asumir que es un sufijo.
const CALIDADES = [
  { c: 'COMERCIAL', re: /\bCOMERCIALE?S?\b/ },
  { c: 'IMPORTADA', re: /\bIMPORTAD[AO]S?\b/ },
];

// ── Familia ───────────────────────────────────────────────────────────────────────────
// Clasificación automática para que el dashboard tenga algo el primer día. Es una PRIMERA
// PASADA, no la verdad: la pantalla de Mapeos deja corregirla a mano, y el importador sólo
// clasifica los artículos que está CREANDO — nunca pisa una corrección.
//
// ── LAS DOS HORTALIZAS SE SEPARAN POR CÓMO SE MUEVEN, NO POR BOTÁNICA ────────────────
// PESADA es lo que va en BOLSA de 20-25 kg: papa, cebolla, batata, zapallo. LIVIANA es lo
// que va en CAJÓN: tomate, berenjena, zapallito. Ese es el criterio que dio Andy con sus
// ejemplos y es el que decide los casos que él no nombró — por eso el ajo, que es un bulbo
// como la cebolla, cae en LIVIANA: nadie mueve ajo en bolsa de 25 kg.
//
// El tomate y la berenjena son frutos y están en hortalizas igual, porque acá "FRUTA" es la
// góndola de fruta, no la definición del manual.
//
// El orden de la lista es el orden en que se evalúa, y por eso HOJA va primero: "CEBOLLA DE
// VERDEO" tiene que caer en HOJA aunque diga CEBOLLA.
const FAMILIAS = [
  ['HOJA', ['VERDEO', 'PUERRO', 'APIO', 'LECHUGA', 'RUCULA', 'ESPINACA', 'ACELGA', 'RADICHETA',
            'BERRO', 'ESCAROLA', 'ENDIVIA', 'KALE', 'ACHICORIA', 'MIZUNA', 'PEREJIL',
            'ALBAHACA', 'CILANTRO', 'CIBOULETTE', 'CIBOULET', 'MENTA', 'ROMERO', 'TOMILLO',
            'SALVIA', 'ENELDO', 'MIX DE HOJAS', 'BROTE', 'REPOLLO', 'PENCA', 'CARDO']],
  ['FRUTA', ['MANZANA', 'PERA', 'BANANA', 'NARANJA', 'MANDARINA', 'LIMON', 'LIMA', 'POMELO',
             'UVA', 'DURAZNO', 'PELON', 'NECTARIN', 'CIRUELA', 'DAMASCO', 'CEREZA', 'FRUTILLA',
             'ARANDANO', 'FRAMBUESA', 'MORA', 'KIWI', 'ANANA', 'MANGO', 'PAPAYA', 'MELON',
             'SANDIA', 'HIGO', 'MEMBRILLO', 'GRANADA', 'CAQUI', 'NISPERO', 'MARACUYA',
             'CARAMBOLA', 'GUAYABA', 'LICHI', 'PITAYA', 'COCO', 'DATIL', 'PALTA']],
  // Bolsa: raíces, tubérculos, bulbos grandes y zapallos.
  ['HORTALIZA PESADA', ['PAPA', 'CEBOLLA', 'BATATA', 'BONIATO', 'ZAPALLO', 'CALABAZA', 'ANCO',
                        'CABUTIA', 'CABUTIAN', 'MANDIOCA', 'ZANAHORIA', 'REMOLACHA']],
  // Cajón: frutos, flores y todo lo que se golpea.
  ['HORTALIZA LIVIANA', ['TOMATE', 'BERENJENA', 'ZAPALLITO', 'ZUCCHINI', 'ZUCHINI', 'MORRON',
                         'PIMIENTO', 'AJI', 'PEPINO', 'CHAUCHA', 'CHOCLO', 'BROCOLI',
                         'COLIFLOR', 'ARVEJA', 'ALCAUCIL', 'ESPARRAGO', 'HINOJO', 'RABANITO',
                         'RABANO', 'AJO', 'NABO', 'JENGIBRE', 'PALMITO', 'HABA', 'RUIBARBO']],
];

// Las cinco familias válidas. OTRO no es un descuido: es dónde caen los hongos y todo lo que
// no encaja, y tener ese cajón es lo que evita meter algo en la familia equivocada — un
// artículo mal clasificado ensucia el share por familia del dashboard y nadie lo nota.
export const FAMILIAS_VALIDAS = ['FRUTA', 'HOJA', 'HORTALIZA PESADA', 'HORTALIZA LIVIANA', 'OTRO'];

// ── SE BUSCA POR PALABRA ENTERA, NO POR PEDAZO DE TEXTO ───────────────────────────────
// Buscar "PAPA" adentro del texto hace que PAPAYA sea una hortaliza pesada. Con la lista
// vieja no se notaba porque FRUTA se evaluaba antes y la atajaba de casualidad; al cambiar el
// orden de las familias, esa casualidad se termina. Lo mismo con ZAPALLO y ZAPALLITO, que
// ahora van a familias distintas.
//
// Se acepta el plural (PAPAS, ZAPALLOS) porque la planilla los escribe de las dos formas.
// Se precompila: la migración recorre cientos de artículos contra un centenar de palabras.
const RE_FAMILIAS = FAMILIAS.map(([fam, claves]) => [
  fam,
  claves.map(k => new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:ES|S)?\\b')),
]);

export function clasificarFamilia(base) {
  const t = norm(base);
  for (const [fam, res] of RE_FAMILIAS) {
    for (const re of res) if (re.test(t)) return fam;
  }
  return 'OTRO';
}

// ── El parseo de una descripción ──────────────────────────────────────────────────────
// Devuelve todo lo que se puede saber de un `DESC` sin mirar la base:
//   raw            el texto tal cual vino (se guarda SIEMPRE, para poder auditar)
//   desc_canonica  la forma normalizada: es la clave con la que se busca/crea el artículo
//   articulo_base  sin unidad y sin calidad — la que permite agrupar MANZANA con MANZANA
//   calidad        NULL | 'COMERCIAL' | 'IMPORTADA'
//   unidad         KG | UNIDAD | ATADO | PAQUETE | PACK_GR | SIN_DEFINIR
//   gramos         sólo para PACK_GR
//   factor_kg      kilos por bulto, o NULL si no se puede saber
//   familia        la primera pasada automática
export function parseDesc(raw) {
  const limpio = norm(raw);
  let resto = limpio;

  // 1) Calidad, de donde esté.
  let calidad = null;
  for (const { c, re } of CALIDADES) {
    if (re.test(resto)) { calidad = c; resto = norm(resto.replace(re, ' ')); break; }
  }

  // 2) Unidad, del final de lo que quedó.
  let unidad = 'SIN_DEFINIR', gramos = null, factor_kg = null;
  for (const { u, re } of UNIDADES) {
    const m = resto.match(re);
    if (!m) continue;
    unidad = u;
    if (u === 'PACK_GR') {
      gramos = Math.round(parseFloat(String(m[1]).replace(',', '.')));
      // Un pack de 0 gramos no existe: si el número no tiene sentido, mejor no convertir
      // nada que dar un total en kilos que parece bueno y no lo es.
      if (!gramos || gramos <= 0) { unidad = 'SIN_DEFINIR'; gramos = null; break; }
      factor_kg = gramos / 1000;
    } else if (u === 'KG') {
      factor_kg = 1;
    }
    resto = norm(resto.slice(0, m.index));
    break;
  }

  // 3) Lo que sobró es el artículo base. Si no sobró nada —una descripción que era sólo
  //    calidad y unidad— se cae al texto original: un artículo sin nombre no sirve para nada.
  const base = resto || limpio;

  const canonica = (base + (calidad ? ' ' + calidad : '') + sufijoUnidad(unidad, gramos)).trim();

  return {
    raw: String(raw == null ? '' : raw),
    desc_canonica: canonica,
    articulo_base: base,
    calidad,
    unidad,
    gramos,
    factor_kg,
    familia: clasificarFamilia(base),
  };
}

// ── Proveedores ───────────────────────────────────────────────────────────────────────
// SAN GERONIMO S.A. somos nosotros y hay que reconocerlo aunque venga escrito distinto:
// nunca se compara contra el literal en el SQL, se usa la marca es_nosotros de la tabla.
//
// PROV.IMPORT.PROPIA no es un competidor: es Carrefour importando por su cuenta. Confundirlo
// con un proveedor más hace que "le ganamos participación a fulano" tape que el volumen se lo
// está quedando el propio cliente, que es una amenaza de otra naturaleza.
const RE_NOSOTROS = /^SAN\s*GERONIMO\b/;
const RE_IMPORT_PROPIA = /^PROV\.?\s*IMPORT/;

export function parseProveedor(raw) {
  const canonico = norm(raw);
  let tipo = 'competidor';
  if (RE_NOSOTROS.test(canonico)) tipo = 'nosotros';
  else if (RE_IMPORT_PROPIA.test(canonico)) tipo = 'importacion_propia';
  return {
    raw: String(raw == null ? '' : raw),
    nombre_canonico: canonico,
    tipo,
    es_nosotros: tipo === 'nosotros' ? 1 : 0,
  };
}

// ── Fechas ────────────────────────────────────────────────────────────────────────────
// LA FECHA VIENE EN LA FILA, no en el nombre del archivo. El nombre se usa sólo para avisar
// si se contradicen; la que manda es la de la columna.
//
// Excel puede entregarla de tres formas y las tres llegan acá: como Date (cuando se lee con
// cellDates), como número de serie (días desde el 30/12/1899) o como texto. El texto es el
// caso peligroso: "03/04/2026" es 3 de abril en Argentina y 4 de marzo en Estados Unidos.
// Se asume DD/MM porque el archivo es argentino, pero si el primer número pasa de 12 no hay
// ambigüedad y se resuelve solo.
export function parseFecha(v) {
  if (v == null || v === '') return null;

  if (v instanceof Date && !isNaN(v)) {
    // Se lee en UTC: la hora local corre el día un lugar según la zona horaria.
    const y = v.getUTCFullYear(), m = v.getUTCMonth() + 1, d = v.getUTCDate();
    // Cuando xlsx arma el Date lo hace en hora local; si la hora es 00:00 local y la zona
    // está detrás de UTC, el día en UTC es el siguiente. Se toma el día local, que es el
    // que la celda muestra.
    const yl = v.getFullYear(), ml = v.getMonth() + 1, dl = v.getDate();
    const usar = (v.getHours() === 0 && v.getMinutes() === 0) ? [yl, ml, dl] : [y, m, d];
    return iso(usar[0], usar[1], usar[2]);
  }

  if (typeof v === 'number' && isFinite(v)) {
    if (v < 1 || v > 200000) return null;           // fuera del rango de fechas de Excel
    const ms = Date.UTC(1899, 11, 30) + Math.round(v) * 86400000;
    const d = new Date(ms);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);           // ISO
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);   // DD/MM/AAAA
  if (m) {
    let [, a, b, y] = m;
    let dd = +a, mm = +b;
    if (dd <= 12 && mm > 12) { dd = +b; mm = +a; }           // venía MM/DD: no hay duda
    y = +y; if (y < 100) y += y < 70 ? 2000 : 1900;
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return iso(y, mm, dd);
  }
  return null;
}

function iso(y, m, d) {
  if (!y || !m || !d) return null;
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// La fecha que sugiere el NOMBRE del archivo (PLANNING_FF_VV_24_08.xlsx → 24/08). Se usa
// sólo para avisar cuando no coincide con las filas; nunca para cargar.
export function fechaDelNombre(nombre, anioRef) {
  const m = String(nombre || '').match(/(\d{1,2})[_\-.](\d{1,2})(?:[_\-.](\d{2,4}))?(?=\D*$)/);
  if (!m) return null;
  let y = m[3] ? +m[3] : (anioRef || new Date().getFullYear());
  if (y < 100) y += y < 70 ? 2000 : 1900;
  const dd = +m[1], mm = +m[2];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return iso(y, mm, dd);
}

// ── Números ───────────────────────────────────────────────────────────────────────────
// BULTOS tiene que ser un número. Si viene como texto con separadores, se interpreta; si no
// se puede, devuelve null y la fila se rechaza con motivo (no entra con cero, que sumaría
// bien y restaría mal).
export function parseBultos(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(/\s/g, '');
  if (!s) return null;
  // "1.234" son mil doscientos treinta y cuatro bultos, no 1,234 bultos: en esta planilla el
  // punto es separador de miles. Y los bultos son enteros, así que no hay decimales que
  // proteger.
  const limpio = s.replace(/[^\d,.\-]/g, '').replace(/\./g, '').replace(/,/g, '.');
  const n = parseFloat(limpio);
  return isFinite(n) ? n : null;
}
