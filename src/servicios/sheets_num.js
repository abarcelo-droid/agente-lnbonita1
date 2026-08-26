// src/servicios/sheets_num.js
// ── EL PARSEO DE UN NÚMERO DE LA PLANILLA ─────────────────────────────────────────────
// Vive acá y no en sheets.js por un motivo concreto: sheets.js importa db.js, que abre la
// base con better-sqlite3, y eso no compila en Windows — así que ningún test podía importarlo.
// Justo esta función, que es la que interpreta los separadores y la que estuvo en el medio del
// problema de los dólares en cero y los kilos inflados, era la única que no se podía probar.
//
// Es pura: entra un valor de celda, sale un número. Sin base y sin red.

// ── Leer rango del sheet ───────────────────────────────────────────────────
// ── LEER UN NÚMERO DE LA PLANILLA ────────────────────────────────────────────────────
// La API de Sheets devuelve el valor COMO SE VE, no el número crudo. Una celda de dólares
// formateada como "U$ 510.704" llega así, con el prefijo adentro, y parseFloat() de eso da
// NaN → 0. Los pesos entraban bien sólo porque esa columna no tiene prefijo: por eso el
// informe mostraba la facturación en pesos correcta y los dólares todos en cero.
//
// Además hay que decidir qué es el separador decimal, y eso no es obvio:
//   "510.704"    → 510704      (punto de miles, es-AR)
//   "1.234,56"   → 1234.56     (coma decimal, es-AR)
//   "1,234.56"   → 1234.56     (coma de miles, en-US)
//   "12,5"       → 12.5        (coma decimal)
// La regla: si están los dos separadores, el ÚLTIMO es el decimal. Si hay uno solo, es
// decimal salvo que venga seguido de exactamente tres dígitos al final, que es la firma del
// separador de miles. Equivocarse acá no da error: da un número mil veces más grande o más
// chico, que es peor.
// AHORA ES LA RED, NO EL CAMINO. Con UNFORMATTED_VALUE los números llegan como números y esta
// función sale por la primera línea sin interpretar nada. Se queda igual porque una celda que
// en la planilla es TEXTO —un "1.234" tipeado a mano, un "s/d", una fórmula que devuelve
// string— sigue llegando como string, y sin esto entraría como 0.
//
// De la mitad para abajo esto ADIVINA cuál separador es el decimal. Adivinar mal no da error:
// da un número mil veces más grande, que fue lo que dejó a un cliente con pesos negativos.
// Por eso dejó de ser el camino normal.
export function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v).trim();
  if (!s) return 0;
  // Contabilidad: (1.234) es negativo.
  const negParen = /^\(.*\)$/.test(s);
  // Se van el prefijo de moneda, los espacios (incluido el fino que mete Excel) y el %.
  s = s.replace(/[()]/g, '').replace(/[^\d.,\-]/g, '');
  if (!s || s === '-') return 0;
  const neg = negParen || s.startsWith('-');
  s = s.replace(/-/g, '');

  const ultPunto = s.lastIndexOf('.');
  const ultComa = s.lastIndexOf(',');
  let dec = -1;
  if (ultPunto >= 0 && ultComa >= 0) {
    dec = Math.max(ultPunto, ultComa);                 // el último manda
  } else if (ultPunto >= 0 || ultComa >= 0) {
    const p = Math.max(ultPunto, ultComa);
    const sep = s[p];
    const decimales = s.length - p - 1;
    const veces = s.split(sep).length - 1;
    // Un solo separador seguido de 3 dígitos: son miles ("510.704"). Si aparece más de una
    // vez, son miles seguro ("1.000.000").
    dec = (veces === 1 && decimales !== 3) ? p : -1;
  }
  const entera = (dec >= 0 ? s.slice(0, dec) : s).replace(/[.,]/g, '');
  const frac = dec >= 0 ? s.slice(dec + 1).replace(/[.,]/g, '') : '';
  const n = Number(entera + (frac ? '.' + frac : ''));
  if (!isFinite(n)) return 0;
  return neg ? -n : n;
}
