// src/servicios/fp_prestamos.js
// ── PRÉSTAMOS FINANCIEROS ─────────────────────────────────────────────────
// Cronograma de amortización, flujo de fondos mensual y previsión de intereses
// por ejercicio de los créditos bancarios.
//
// Convive con fp_motor.js y comparte los MISMOS préstamos: una sola carga
// alimenta las dos vistas, que responden preguntas distintas.
//   · fp_motor.js  → "¿en qué SEMANA me quedo sin fondos?" (tesorería)
//   · este archivo → "¿cuánto me sale la deuda bancaria por MES, cuánto es
//                     capital y cuánto interés, y cuánto interés devengo cada
//                     ejercicio?" (financiero y contable)
// Duplicar la carga sería tener los mismos créditos en dos lugares y que se
// separen sin que nadie se entere.
//
// Funciones puras: entra la ficha, sale el número. Sin acceso a la base.

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const MESES_POR_PERIODO = {
  Mensual: 1, Bimestral: 2, Trimestral: 3, Semestral: 6, Anual: 12,
};
export const mesesDe = (periodicidad) => MESES_POR_PERIODO[periodicidad] || 1;

// 'frances' | 'aleman' | 'americano'. Se acepta 'cuota_unica' porque es como se
// llamaba antes en este módulo y hay préstamos ya cargados con ese valor: es el
// mismo sistema (interés todos los períodos, capital entero al final).
const esAmericano = (s) => s === 'americano' || s === 'cuota_unica';

/**
 * Cronograma completo de un préstamo.
 *
 * La tasa se PRORRATEA: i = TNA × (meses del período / 12). Es tasa nominal anual
 * dividida, no efectiva: un trimestral al 53% paga 13,25% por cuota. Con la
 * efectiva daría distinto y no coincidiría con el cronograma del banco, que es
 * contra lo que esto se va a comparar.
 *
 * @param {number} tna decimal, no porcentaje: 0.53 es 53%.
 */
export function cronograma({ sistema, monto, cuotas, tna, periodicidad }) {
  const n = Math.max(parseInt(cuotas, 10) || 0, 0);
  const P = Number(monto) || 0;
  if (!n || !P) return [];
  const i = (Number(tna) || 0) * mesesDe(periodicidad) / 12;
  const out = [];
  let saldo = P;

  // Cuota fija del francés. Con i = 0 los tres sistemas degeneran en P/n.
  const fija = i > 0 ? P * i / (1 - Math.pow(1 + i, -n)) : P / n;

  for (let k = 0; k < n; k++) {
    let capital, interes;
    if (i === 0) {
      capital = P / n; interes = 0;
    } else if (esAmericano(sistema)) {
      interes = saldo * i;
      capital = (k === n - 1) ? saldo : 0;
    } else if (sistema === 'aleman') {
      capital = P / n;
      interes = saldo * i;
    } else {                                   // francés
      interes = saldo * i;
      capital = fija - interes;
    }
    // La última cuota cancela el saldo exacto: si no quedan centavos vivos para
    // siempre y la suma de capitales no da el monto prestado.
    if (k === n - 1) capital = saldo;
    saldo = round2(saldo - capital);
    out.push({ nro: k + 1, capital: round2(capital), interes: round2(interes),
               cuota: round2(capital + interes) });
  }
  return out;
}

// Índice absoluto de mes, para sumar períodos sin pelear con los años.
const idxMes = (periodo) => {
  const m = /^(\d{4})-(\d{2})/.exec(String(periodo || ''));
  return m ? (+m[1]) * 12 + (+m[2] - 1) : null;
};
const mesDeIdx = (n) => String(Math.floor(n / 12)).padStart(4, '0') + '-' +
                        String(n % 12 + 1).padStart(2, '0');

/** El mes calendario de la cuota k (0-based). */
export function mesDeCuota(fecha1, k, periodicidad) {
  const base = idxMes(fecha1);
  if (base === null) return null;
  return mesDeIdx(base + k * mesesDe(periodicidad));
}

/**
 * Cuántas cuotas quedan.
 *
 * Manda el CALENDARIO, salvo que haya un valor manual cargado: el banco a veces
 * adelanta o difiere cuotas y el calendario teórico deja de coincidir.
 *
 * El mes EN CURSO cuenta como PENDIENTE: se hace floor(meses transcurridos / pm)
 * y NO se suma 1. Contarlo como pagado escondería del flujo la cuota de este mes,
 * que es justo la que hay que tener a la vista.
 */
export function pendientesDe(f, hoyISO) {
  const n = Math.max(parseInt(f.cuotas, 10) || 0, 0);
  if (!n) return { pagadas: 0, pendientes: 0, manual: false };

  const manual = f.cuotasPend;
  if (manual !== null && manual !== undefined && manual !== '' && isFinite(Number(manual))) {
    const pend = Math.min(Math.max(parseInt(manual, 10), 0), n);
    return { pagadas: n - pend, pendientes: pend, manual: true };
  }

  const desde = idxMes(f.fecha1), hoy = idxMes(hoyISO);
  if (desde === null || hoy === null) return { pagadas: 0, pendientes: n, manual: false };
  const meses = hoy - desde;
  if (meses < 0) return { pagadas: 0, pendientes: n, manual: false };   // todavía no arrancó
  const pagadas = Math.min(Math.floor(meses / mesesDe(f.periodicidad)), n);
  return { pagadas, pendientes: n - pagadas, manual: false };
}

/**
 * Flujo de fondos mensual de TODOS los préstamos.
 *
 * FF (lo que sale de caja) = cuota_fin si está cargada, si no la cuota estimada.
 * Capital e interés son SIEMPRE los estimados puros: la diferencia contra la
 * cuota fin son impuestos y percepciones, y mezclarlos ensuciaría la previsión de
 * intereses del ejercicio, que es para lo que sirve.
 */
export function flujoMensual(prestamos, hoyISO) {
  const meses = {};
  for (const f of (prestamos || [])) {
    const n = Math.max(parseInt(f.cuotas, 10) || 0, 0);
    if (!n || !f.fecha1) continue;
    const plan = cronograma(f);
    const { pagadas } = pendientesDe(f, hoyISO);
    const fin = Number(f.cuotaFin) || 0;

    for (let k = pagadas; k < n; k++) {
      const mes = mesDeCuota(f.fecha1, k, f.periodicidad);
      if (!mes || !plan[k]) continue;
      const ff = fin > 0 ? fin : plan[k].cuota;
      if (!meses[mes]) meses[mes] = { total: 0, capital: 0, interes: 0, detalle: [] };
      const m = meses[mes];
      m.total = round2(m.total + ff);
      m.capital = round2(m.capital + plan[k].capital);
      m.interes = round2(m.interes + plan[k].interes);
      m.detalle.push({
        prestamo_id: f.id, alias: f.alias || null, entidad: f.entidad || '',
        nro_cuota: k + 1, de: n,
        cuota: round2(ff), capital: plan[k].capital, interes: plan[k].interes,
        estimada: plan[k].cuota, usa_cuota_fin: fin > 0,
      });
    }
  }
  // Dentro de cada mes, primero el préstamo que más pesa.
  for (const mes of Object.keys(meses)) meses[mes].detalle.sort((a, b) => b.cuota - a.cuota);
  return meses;
}

/**
 * Los tres números grandes.
 *   · Deuda total     = capital de TODAS las cuotas pendientes. Capital puro, no
 *                       un "saldo": lo que falta devolver.
 *   · Deuda corriente = capital de los próximos 12 meses.
 *   · Flujo promedio  = FF de esos 12 meses / meses del horizonte. Se divide por
 *                       los meses que REALMENTE quedan (máximo 12) y no por 12
 *                       fijo: con 3 meses de vida restante, dividir por 12 daría
 *                       un promedio que no se parece a lo que hay que pagar.
 */
export function kpisPrestamos(meses) {
  const ordenados = Object.keys(meses).sort();
  if (!ordenados.length) {
    return { deuda_total: 0, deuda_corriente: 0, flujo_promedio: 0,
             desde: null, hasta: null, horizonte: 0 };
  }
  const desde = ordenados[0], base = idxMes(desde);
  const dentro = ordenados.filter(m => idxMes(m) < base + 12);
  const ultimo = idxMes(ordenados[ordenados.length - 1]);
  const horizonte = Math.min(12, ultimo - base + 1);

  const sum = (lista, campo) => round2(lista.reduce((a, m) => a + meses[m][campo], 0));
  const ff12 = sum(dentro, 'total');
  return {
    deuda_total: sum(ordenados, 'capital'),
    deuda_corriente: sum(dentro, 'capital'),
    flujo_promedio: horizonte ? round2(ff12 / horizonte) : 0,
    desde, hasta: ordenados[ordenados.length - 1], horizonte,
  };
}

/**
 * A qué ejercicio fiscal pertenece un mes. Por defecto julio–junio: un mes >= 7
 * abre el ejercicio "Y/Y+1" y uno <= 6 cierra el "Y-1/Y".
 * `mesInicio` lo hace configurable sin tocar nada más (1 = enero–diciembre).
 */
export function ejercicioDeMes(periodo, mesInicio = 7) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodo || ''));
  if (!m) return null;
  const anio = +m[1], mes = +m[2];
  if (mesInicio === 1) return String(anio);
  return mes >= mesInicio ? anio + '/' + (anio + 1) : (anio - 1) + '/' + anio;
}

/** Interés a devengar por ejercicio, para saber cuánto cargar en cada uno. */
export function interesesPorEjercicio(meses, mesInicio = 7) {
  const acum = {};
  for (const mes of Object.keys(meses)) {
    const ej = ejercicioDeMes(mes, mesInicio);
    if (!ej) continue;
    acum[ej] = round2((acum[ej] || 0) + meses[mes].interes);
  }
  return Object.keys(acum).sort().map(ej => ({ ejercicio: ej, interes: acum[ej] }));
}

/**
 * Color y etiqueta del banco, para agrupar las tarjetas.
 *
 * Se detecta por nombre porque el banco es texto libre: el mismo banco entra como
 * "Nación", "BNA" o "Banco de la Nación Argentina". Sin normalizar, tres tarjetas
 * del mismo banco quedarían separadas.
 */
const BANCOS = [
  { clave: 'galicia',     etq: 'Galicia',     color: '#f97316', pat: /galicia/i },
  { clave: 'bbva',        etq: 'BBVA',        color: '#1d4ed8', pat: /\bbbva\b|frances|francés/i },
  { clave: 'nacion',      etq: 'Nación',      color: '#0e7490', pat: /naci[oó]n|\bbna\b/i },
  { clave: 'santander',   etq: 'Santander',   color: '#dc2626', pat: /santander/i },
  { clave: 'supervielle', etq: 'Supervielle', color: '#7c3aed', pat: /supervielle/i },
  { clave: 'macro',       etq: 'Macro',       color: '#2563eb', pat: /\bmacro\b/i },
  { clave: 'credicoop',   etq: 'Credicoop',   color: '#059669', pat: /credicoop/i },
  { clave: 'bice',        etq: 'BICE',        color: '#0891b2', pat: /\bbice\b/i },
  { clave: 'sanjuan',     etq: 'San Juan',    color: '#ca8a04', pat: /san\s*juan/i },
  { clave: 'patagonia',   etq: 'Patagonia',   color: '#16a34a', pat: /patagonia/i },
  { clave: 'icbc',        etq: 'ICBC',        color: '#b91c1c', pat: /\bicbc\b/i },
  { clave: 'hsbc',        etq: 'HSBC',        color: '#991b1b', pat: /\bhsbc\b/i },
];
export function bancoDe(nombre) {
  const s = String(nombre || '');
  for (const b of BANCOS) if (b.pat.test(s)) return { clave: b.clave, etiqueta: b.etq, color: b.color };
  return { clave: 'otro', etiqueta: 'Otro', color: '#64748b' };
}
