// src/servicios/cotizacion_dolar.js
// ── COTIZACIÓN DEL DÓLAR ───────────────────────────────────────────────────
// Necesaria para dar el costo de un producto en pesos Y en dólares cuando hay
// insumos cotizados en las dos monedas (el empaque en Argentina es bimonetario:
// el cartón suele ir en USD y la mano de obra o el flete en ARS).
//
// DECISIONES
// - Se CACHEA por (fecha, tipo) en pli_cotizaciones. Dos motivos: no pegarle a
//   la API en cada cálculo, y —más importante— que un costo calculado ayer se
//   pueda reproducir con la cotización que se usó ayer.
// - NUNCA tira. Si la API falla devuelve la última cotización disponible marcada
//   como desactualizada, o null. Un costo sin dólar tiene que mostrarse igual,
//   diciendo que falta la cotización; no puede romper la pantalla.
// - Se devuelve SIEMPRE la fuente, la fecha y de dónde salió el número, porque el
//   costo en dólares no significa nada si no se sabe a qué tipo de cambio.
// - Se usa el valor VENTA: es el que pagás si tenés que comprar los dólares.
//
// Fuente: dolarapi.com — pública, sin API key. El repo ya hace fetch a servicios
// externos desde el server (rutas/cotizacion.js scrapea el MCBA y VTEX), así que
// la salida HTTP funciona en Railway.

import db from './db_pli.js';

export const TIPOS = ['oficial', 'mayorista', 'blue', 'tarjeta'];
const TIMEOUT_MS = 8000;

function hoyISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function leerCache(fecha, tipo) {
  try {
    return db.prepare('SELECT * FROM pli_cotizaciones WHERE fecha=? AND tipo=?').get(fecha, tipo) || null;
  } catch (e) {
    console.error('[COTIZ] Error leyendo cache:', e.message);
    return null;
  }
}

function ultimaDisponible(tipo) {
  try {
    return db.prepare('SELECT * FROM pli_cotizaciones WHERE tipo=? ORDER BY fecha DESC LIMIT 1').get(tipo) || null;
  } catch (e) {
    return null;
  }
}

function guardar(fecha, tipo, compra, venta, fuente, usuarioId) {
  try {
    db.prepare(`
      INSERT INTO pli_cotizaciones (fecha, tipo, compra, venta, fuente, creado_por_id)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(fecha, tipo) DO UPDATE SET
        compra=excluded.compra, venta=excluded.venta, fuente=excluded.fuente,
        obtenido_en=datetime('now','localtime')
    `).run(fecha, tipo, compra, venta, fuente, usuarioId || null);
  } catch (e) {
    console.error('[COTIZ] Error guardando cotización:', e.message);
  }
}

const salida = (fila, origen, extra) => ({
  tipo: fila.tipo,
  fecha: fila.fecha,
  compra: fila.compra,
  venta: fila.venta,
  fuente: fila.fuente,
  obtenido_en: fila.obtenido_en,
  origen,                      // cache | api | ultima_disponible | manual
  desactualizada: fila.fecha !== hoyISO(),
  ...(extra || {})
});

/**
 * Cotización del día. Devuelve null solo si no hay NADA (ni API ni historial).
 * @param {string} tipo  oficial | mayorista | blue | tarjeta
 * @param {object} opts  { forzar: boolean }  forzar ignora el cache del día
 */
export async function cotizacionDelDia(tipo = 'oficial', opts = {}) {
  const t = TIPOS.includes(tipo) ? tipo : 'oficial';
  const fecha = hoyISO();

  if (!opts.forzar) {
    const cache = leerCache(fecha, t);
    if (cache) return salida(cache, 'cache');
  }

  try {
    const res = await fetch(`https://dolarapi.com/v1/dolares/${t}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const venta = Number(d?.venta);
    if (!Number.isFinite(venta) || venta <= 0) throw new Error('respuesta sin valor de venta');
    const compra = Number.isFinite(Number(d?.compra)) ? Number(d.compra) : null;
    guardar(fecha, t, compra, venta, 'dolarapi.com');
    const fila = leerCache(fecha, t);
    return fila ? salida(fila, 'api') : { tipo: t, fecha, compra, venta, fuente: 'dolarapi.com', origen: 'api', desactualizada: false };
  } catch (e) {
    console.error('[COTIZ] No se pudo obtener el dólar', t + ':', e.message);
    // Degradación explícita: se devuelve lo último que se tenga, marcado.
    const ult = ultimaDisponible(t);
    if (ult) return salida(ult, 'ultima_disponible', { error: e.message });
    return null;
  }
}

/**
 * Cotización cargada a mano. Queda como tipo 'manual' del día y tiene prioridad
 * sobre la de la API: si alguien la fija, es porque quiere costear con ESE valor.
 */
export function fijarCotizacionManual(venta, usuarioId, fecha) {
  const v = Number(venta);
  if (!Number.isFinite(v) || v <= 0) {
    const e = new Error('La cotización tiene que ser un número mayor que 0');
    e.status = 400; throw e;
  }
  const f = fecha || hoyISO();
  guardar(f, 'manual', null, v, 'carga manual', usuarioId);
  const fila = leerCache(f, 'manual');
  return salida(fila, 'manual');
}

// Resuelve la cotización a usar: si hay una manual del día, gana. Si no, la del
// tipo pedido. Así una carga manual no queda tapada por el cache de la API.
export async function cotizacionVigente(tipo = 'oficial', opts = {}) {
  const manual = leerCache(hoyISO(), 'manual');
  if (manual && !opts.ignorarManual) return salida(manual, 'manual');
  return cotizacionDelDia(tipo, opts);
}

export default cotizacionVigente;
