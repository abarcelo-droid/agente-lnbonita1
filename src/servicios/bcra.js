// src/servicios/bcra.js
// ── LA CENTRAL DE DEUDORES DEL BCRA ──────────────────────────────────────────
// Cuando entra un cheque, lo único que se sabe del que lo firmó es lo que dice
// el papel. El BCRA publica dos cosas que cambian esa foto: en qué situación
// está ese CUIT en el sistema financiero (1 normal … 6 irrecuperable) y qué
// cheques suyos rebotaron y siguen impagos.
//
// TRES REGLAS, y las tres son la misma idea: esto INFORMA, no decide.
//
//   1. NUNCA BLOQUEA. Si el BCRA no contesta —está en mantenimiento seguido, y
//      es un servicio de afuera— el cheque se carga igual. Una consulta que no
//      salió no puede impedir que se registre plata que entró de verdad.
//   2. TIMEOUT CORTO. Sin AbortController, un BCRA colgado cuelga la pantalla
//      de Caja y Bancos: el pedido queda esperando y el usuario mira una rueda.
//   3. CACHÉ. Los datos son MENSUALES: preguntar dos veces el mismo día por el
//      mismo CUIT es gastar una llamada para recibir lo mismo. Y si el BCRA se
//      cae, la respuesta de ayer sirve —avisando que es de ayer— mucho más que
//      un error.
//
// Es una API pública: no lleva clave ni token.
import db from './db_sg_finanzas.js';

const BASE = 'https://api.bcra.gob.ar/CentralDeDeudores/v1.0';
const TIMEOUT_MS = 7000;
// Un día. La Central se arma con la información mensual que envían las
// entidades: dentro del mismo día la respuesta no cambia.
const TTL_HORAS = 24;

// La escala del BCRA, en castellano. El número solo no dice nada.
export const SITUACIONES = {
  1: 'Normal',
  2: 'Riesgo bajo — con seguimiento especial',
  3: 'Riesgo medio — con problemas',
  4: 'Riesgo alto — de insolvencia',
  5: 'Irrecuperable',
  6: 'Irrecuperable por disposición técnica',
};

// 11 dígitos, sin guiones ni espacios. Se limpia acá y no en cada llamador:
// el CUIT se escribe con guiones en todos lados.
export function limpiarCuit(cuit) {
  const s = String(cuit || '').replace(/[^0-9]/g, '');
  return /^\d{11}$/.test(s) ? s : null;
}

// El dígito verificador, que es lo que separa un CUIT de once números
// cualesquiera. Sin esto se consultaría el BCRA por un CUIT mal tipeado y la
// respuesta "no hay registros" se leería como "el librador está limpio".
export function cuitValido(cuit) {
  const s = limpiarCuit(cuit);
  if (!s) return false;
  const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = mult.reduce((a, m, i) => a + parseInt(s[i], 10) * m, 0);
  const resto = suma % 11;
  const dv = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
  return dv === parseInt(s[10], 10);
}

function tablaCache() {
  db.exec(`CREATE TABLE IF NOT EXISTS sg_bcra_consultas (
    cuit          TEXT PRIMARY KEY,
    payload       TEXT NOT NULL,
    consultado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);
}
tablaCache();

function leerCache(cuit) {
  try {
    const r = db.prepare('SELECT payload, consultado_en FROM sg_bcra_consultas WHERE cuit=?').get(cuit);
    if (!r) return null;
    return { datos: JSON.parse(r.payload), consultado_en: r.consultado_en };
  } catch (_) { return null; }
}

function guardarCache(cuit, datos) {
  try {
    db.prepare(`INSERT INTO sg_bcra_consultas (cuit, payload, consultado_en)
      VALUES (?,?, datetime('now','localtime'))
      ON CONFLICT(cuit) DO UPDATE SET payload=excluded.payload, consultado_en=excluded.consultado_en`)
      .run(cuit, JSON.stringify(datos));
  } catch (_) { /* la caché es una ayuda, no puede romper la consulta */ }
}

function vencida(consultadoEn) {
  const r = db.prepare(`SELECT CAST((julianday('now','localtime') - julianday(?)) * 24 AS REAL) h`)
    .get(consultadoEn);
  return !r || !(r.h >= 0) || r.h > TTL_HORAS;
}

async function traer(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    // 404 es una respuesta VÁLIDA y buena: el BCRA no tiene registros de ese
    // CUIT. Tratarlo como error mostraría "no se pudo consultar" cuando lo que
    // pasa es que el librador no debe nada.
    if (r.status === 404) return { ok: true, vacio: true };
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = (j && Array.isArray(j.errorMessages) && j.errorMessages[0]) || ('HTTP ' + r.status);
      return { ok: false, error: msg };
    }
    return { ok: true, datos: (j && j.results) || null };
  } catch (e) {
    return { ok: false,
      error: e.name === 'AbortError' ? 'El BCRA no contestó a tiempo' : (e.message || 'Error de red') };
  } finally { clearTimeout(t); }
}

// Del período más reciente que publique el BCRA: la PEOR situación informada y
// cuánto suma la deuda. Se toma la peor y no un promedio: un CUIT que está en 1
// con cuatro bancos y en 5 con el quinto está en 5.
function resumirDeudas(datos) {
  const per = (datos && Array.isArray(datos.periodos) ? datos.periodos : [])
    .slice().sort((a, b) => String(b.periodo || '').localeCompare(String(a.periodo || '')))[0];
  const ents = (per && Array.isArray(per.entidades)) ? per.entidades : [];
  let peor = 0, total = 0;
  const banderas = new Set();
  for (const e of ents) {
    const s = parseInt(e.situacion, 10) || 0;
    if (s > peor) peor = s;
    total += parseFloat(e.monto) || 0;
    if (e.procesoJud) banderas.add('en proceso judicial');
    if (e.situacionJuridica) banderas.add('con situación jurídica');
    if (e.refinanciaciones) banderas.add('con refinanciaciones');
    if (e.enRevision) banderas.add('en revisión');
  }
  return {
    periodo: (per && per.periodo) || null,
    situacion: peor || null,
    situacion_texto: peor ? (SITUACIONES[peor] || ('Situación ' + peor)) : null,
    // Los montos de la Central vienen en MILES de pesos.
    deuda_miles: Math.round(total * 100) / 100,
    entidades: ents.map((e) => ({
      entidad: e.entidad, situacion: parseInt(e.situacion, 10) || null,
      monto_miles: parseFloat(e.monto) || 0, dias_atraso: e.diasAtrasoPago || 0,
    })),
    banderas: Array.from(banderas),
  };
}

// Los rechazados: cuántos, cuántos siguen SIN PAGAR y por cuánto. El que importa
// es el impago — un cheque que rebotó y después se pagó es una anécdota; uno que
// rebotó y sigue así es el que anticipa el próximo.
function resumirCheques(datos) {
  let cant = 0, impagos = 0, monto = 0, montoImpago = 0;
  const causales = new Set();
  for (const c of (datos && Array.isArray(datos.causales) ? datos.causales : [])) {
    for (const e of (Array.isArray(c.entidades) ? c.entidades : [])) {
      for (const d of (Array.isArray(e.detalle) ? e.detalle : [])) {
        cant++;
        const m = parseFloat(d.monto) || 0;
        monto += m;
        if (!d.fechaPago) { impagos++; montoImpago += m; causales.add(String(c.causal || '').trim()); }
      }
    }
  }
  return {
    cantidad: cant, impagos,
    monto: Math.round(monto * 100) / 100,
    monto_impago: Math.round(montoImpago * 100) / 100,
    causales: Array.from(causales).filter(Boolean),
  };
}

// El semáforo, que es lo que se mira de verdad. Un cheque rechazado impago pesa
// más que la situación: es exactamente lo que estamos por aceptar.
function semaforo(deudas, cheques) {
  if (cheques.impagos > 0) return 'malo';
  if ((deudas.situacion || 0) >= 3) return 'malo';
  if ((deudas.situacion || 0) === 2 || cheques.cantidad > 0) return 'ojo';
  return 'bien';
}

// ── LA CONSULTA ─────────────────────────────────────────────────────────────
// Devuelve SIEMPRE un objeto que la pantalla puede mostrar. Si el BCRA no
// contestó, `ok:false` con el motivo y —si hay— lo último que se supo, con su
// fecha: un dato de ayer sirve, un error no.
export async function consultarBcra(cuit, opts) {
  const forzar = !!(opts && opts.forzar);
  const limpio = limpiarCuit(cuit);
  if (!limpio) return { ok: false, error: 'El CUIT tiene que ser de 11 dígitos' };
  if (!cuitValido(limpio)) return { ok: false, error: 'Ese CUIT no es válido: falla el dígito verificador' };

  const cache = leerCache(limpio);
  if (cache && !forzar && !vencida(cache.consultado_en)) {
    return { ...cache.datos, ok: true, fuente: 'cache', consultado_en: cache.consultado_en };
  }

  const [d, c] = await Promise.all([
    traer(`${BASE}/Deudas/${limpio}`),
    traer(`${BASE}/Deudas/ChequesRechazados/${limpio}`),
  ]);

  // Las DOS tienen que haber contestado algo. Con una sola, el resumen mentiría
  // por omisión: "sin cheques rechazados" cuando en realidad no se pudo mirar.
  if (!d.ok || !c.ok) {
    const motivo = d.error || c.error;
    return cache
      ? { ...cache.datos, ok: true, fuente: 'cache_vieja', consultado_en: cache.consultado_en, aviso: motivo }
      : { ok: false, error: 'No se pudo consultar el BCRA: ' + motivo };
  }

  const deudas = resumirDeudas(d.datos);
  const cheques = resumirCheques(c.datos);
  const datos = {
    cuit: limpio,
    denominacion: (d.datos && d.datos.denominacion) || (c.datos && c.datos.denominacion) || null,
    sin_registros: !!(d.vacio && c.vacio),
    deudas, cheques,
    semaforo: semaforo(deudas, cheques),
  };
  guardarCache(limpio, datos);
  return { ...datos, ok: true, fuente: 'bcra',
    consultado_en: db.prepare("SELECT datetime('now','localtime') d").get().d };
}

export default { consultarBcra, limpiarCuit, cuitValido, SITUACIONES };
