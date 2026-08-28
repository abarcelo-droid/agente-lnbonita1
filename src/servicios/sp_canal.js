// ══ EL CANAL DEL CHEQUE: PAPEL O HOMEBANKING ═══════════════════════════════
//
// Pablo, 28/8/2026: «dentro de cheques, cuando decidimos, poner dos box para
// tildar si son cheques físicos o e-cheqs, tanto para propios como para de
// terceros, para que todos sepan si el canal de pago es electrónico o no».
//
// Son dos trabajos distintos: uno se imprime, se firma a mano y alguien lo
// lleva; el otro se emite en el homebanking y se firma ahí. El que confecciona y
// el que firma se enteraban recién cuando les llegaba —o no les llegaba— el
// papel.
//
// ESTO VIVE EN SU PROPIO ARCHIVO PARA PODER PROBARLO DE VERDAD. El test estaba
// escrito contra el TEXTO del router: leía sp.js, recortaba el tramo de las
// constantes y reimplementaba la regla adentro del propio test. Eso no prueba
// nada — si mañana alguien invierte la condición en el router, el test sigue en
// verde porque está corriendo su propia copia. El repo ya resolvió esto así en
// servicios/sg_perfeccionada.js.

export const CANALES = ['fisico', 'echeq'];

export const ETIQUETA_CANAL = { fisico: 'físico', echeq: 'e-cheq' };

// Una transferencia YA es electrónica por definición: preguntarlo sería ruido, y
// guardarle un canal sería inventar un dato.
export const pideCanal = (tipo) => tipo !== 'transferencia';

// Devuelve el canal normalizado, o null si no corresponde. Tira si falta cuando
// hace falta: un cheque sin canal deja al que lo confecciona sin saber si tiene
// que imprimir algo.
export function canalDeLinea(tipo, valor) {
  if (!pideCanal(tipo)) return null;
  const canal = String(valor == null ? '' : valor).trim();
  if (!CANALES.includes(canal)) return null;
  return canal;
}

// El resumen que va arriba del total en el mail. El que confecciona necesita
// saber CUÁNTOS va a cargar en el homebanking antes de leer renglón por renglón.
//
// Las líneas viejas —las que se cargaron antes de que esto existiera— se cuentan
// aparte como «sin informar» en vez de desaparecer de la suma: un resumen que no
// cierra contra la cantidad de cheques se deja de leer.
export function resumenCanales(pagos) {
  const cheques = (pagos || []).filter((p) => pideCanal(p.tipo));
  if (!cheques.length) return '';
  const ech = cheques.filter((p) => p.canal === 'echeq').length;
  const fis = cheques.filter((p) => p.canal === 'fisico').length;
  const sin = cheques.length - ech - fis;
  const partes = [];
  if (ech) partes.push(ech + (ech === 1 ? ' e-cheq' : ' e-cheqs'));
  if (fis) partes.push(fis + (fis === 1 ? ' físico' : ' físicos'));
  if (sin) partes.push(sin + ' sin informar');
  // «a, b y c», no «a y b y c».
  const lista = partes.length <= 1 ? (partes[0] || '')
    : partes.slice(0, -1).join(', ') + ' y ' + partes[partes.length - 1];
  return cheques.length === 1
    ? `Del cheque: ${lista}.`
    : `De los ${cheques.length} cheques: ${lista}.`;
}
