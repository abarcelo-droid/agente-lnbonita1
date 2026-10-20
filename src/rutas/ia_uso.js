// src/rutas/ia_uso.js
// ── CONSUMO DE IA ────────────────────────────────────────────────────────────────────
// Lo que alimenta la pantalla. Tres preguntas, tres consultas:
//
//   ¿Cuánto llevamos?          → el total del período, y cuánto por día
//   ¿Quién se lo está comiendo? → por función, ordenado por plata
//   ¿Qué pasó el martes?        → el detalle de las últimas llamadas
//
// ── POR QUÉ SÓLO LO VE UN ADMIN ─────────────────────────────────────────────────────
// Esto es gasto de la empresa, no el trabajo del día. Es la misma línea que separa
// parametrizar de operar: el que carga un remito no necesita ver cuánto cuesta leerlo, y
// mostrárselo lo único que hace es invitarlo a no usar el lector.
import express from 'express';
import db from '../servicios/db_ia_uso.js';
import { FUNCIONES, PRECIOS } from '../servicios/ia.js';

const router = express.Router();

function getUser(req) {
  try { return req.cookies?.lnb_user ? JSON.parse(req.cookies.lnb_user) : null; }
  catch (e) { return null; }
}
router.use((req, res, next) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'no autenticado' });
  if (u.rol !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
  req._user = u;
  next();
});

// El rango. Por defecto los últimos 30 días, que es el período de una factura.
function rango(req) {
  const hoy = new Date();
  const hace = new Date(hoy.getTime() - 29 * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.desde || '')) ? req.query.desde : iso(hace);
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.hasta || '')) ? req.query.hasta : iso(hoy);
  // El 'hasta' incluye el día entero: sin esto, pedir "hasta hoy" deja afuera todo lo de hoy.
  return { desde, hasta, hastaFin: hasta + ' 23:59:59' };
}

// Las milésimas de dólar se devuelven también como número con decimales, para que la
// pantalla no tenga que saber la unidad. El entero queda por si hace falta sumar.
const conUsd = (f) => Object.assign({}, f, { usd: (f.costo_mil || 0) / 1000 });

router.get('/', (req, res) => {
  try {
    const { desde, hasta, hastaFin } = rango(req);
    const par = [desde, hastaFin];

    const total = db.prepare(`
      SELECT COUNT(*) AS llamadas,
             SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS fallidas,
             IFNULL(SUM(costo_mil),0)      AS costo_mil,
             IFNULL(SUM(tok_entrada),0)    AS tok_entrada,
             IFNULL(SUM(tok_salida),0)     AS tok_salida,
             IFNULL(SUM(tok_cache_lee),0)  AS tok_cache_lee,
             IFNULL(SUM(tok_cache_crea),0) AS tok_cache_crea
        FROM ia_uso WHERE creado_en >= ? AND creado_en <= ?`).get(...par);

    // POR FUNCIÓN, ordenado por plata: la primera fila es la respuesta a «quién se está
    // comiendo el crédito», que es para lo que se abre esta pantalla.
    const porFuncion = db.prepare(`
      SELECT funcion, modelo,
             COUNT(*) AS llamadas,
             SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS fallidas,
             IFNULL(SUM(costo_mil),0)   AS costo_mil,
             IFNULL(SUM(tok_entrada),0) AS tok_entrada,
             IFNULL(SUM(tok_salida),0)  AS tok_salida,
             IFNULL(ROUND(AVG(ms)),0)   AS ms_prom
        FROM ia_uso WHERE creado_en >= ? AND creado_en <= ?
       GROUP BY funcion, modelo
       ORDER BY costo_mil DESC`).all(...par);

    // POR DÍA. Es la curva que distingue «se consumió parejo» de «pasó algo el martes»,
    // que es justo lo que no se podía saber cuando la cuenta se quedó sin crédito.
    const porDia = db.prepare(`
      SELECT substr(creado_en,1,10) AS dia,
             COUNT(*) AS llamadas,
             IFNULL(SUM(costo_mil),0) AS costo_mil
        FROM ia_uso WHERE creado_en >= ? AND creado_en <= ?
       GROUP BY dia ORDER BY dia`).all(...par);

    const porModelo = db.prepare(`
      SELECT modelo, COUNT(*) AS llamadas, IFNULL(SUM(costo_mil),0) AS costo_mil
        FROM ia_uso WHERE creado_en >= ? AND creado_en <= ?
       GROUP BY modelo ORDER BY costo_mil DESC`).all(...par);

    res.json({
      ok: true, desde, hasta,
      total: conUsd(total || { costo_mil: 0 }),
      por_funcion: porFuncion.map((f) => Object.assign(conUsd(f), { etiqueta: FUNCIONES[f.funcion] || f.funcion })),
      por_dia: porDia.map(conUsd),
      por_modelo: porModelo.map(conUsd),
      // Las funciones que NO aparecen. Una que dejó de usarse es tan informativa como una
      // que se disparó: puede ser que alguien dejó de cargar remitos, o que algo se rompió.
      sin_uso: Object.keys(FUNCIONES)
        .filter((k) => !porFuncion.some((f) => f.funcion === k))
        .map((k) => ({ funcion: k, etiqueta: FUNCIONES[k] })),
      precios: PRECIOS,
    });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// El detalle: las últimas llamadas, para mirar un día puntual.
router.get('/detalle', (req, res) => {
  try {
    const { desde, hastaFin } = rango(req);
    const cond = ['creado_en >= ?', 'creado_en <= ?'];
    const par = [desde, hastaFin];
    if (req.query.funcion && FUNCIONES[req.query.funcion]) {
      cond.push('funcion = ?'); par.push(req.query.funcion);
    }
    if (req.query.solo_fallidas === '1') cond.push('ok = 0');
    const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 200, 1), 1000);

    const filas = db.prepare(`
      SELECT * FROM ia_uso WHERE ${cond.join(' AND ')}
       ORDER BY id DESC LIMIT ?`).all(...par, limite);
    res.json({
      ok: true,
      llamadas: filas.map((f) => Object.assign(conUsd(f), { etiqueta: FUNCIONES[f.funcion] || f.funcion })),
    });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

export default router;
