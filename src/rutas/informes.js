// src/rutas/informes.js
// ── INFORMES COMERCIALES sobre BASE VENTA ────────────────────────────────────────────
// Un solo endpoint que contesta muchas preguntas: se elige POR QUÉ agrupar (cliente,
// producto, vendedor, categoría, proveedor, mes…) y se filtra por lo que haga falta. Un
// informe fijo por pregunta obliga a desarrollar cada pregunta nueva; esto no.
//
// Los datos salen de sheet_ventas, que es el espejo local de la hoja BASE VENTA. Se
// sincroniza UNA VEZ POR DÍA, así que todo lo que sale de acá es la foto de la madrugada:
// por eso cada respuesta viaja con la fecha del último sync, para que la pantalla lo diga.
//
// LA RENTABILIDAD NO LA VE CUALQUIERA. Los comerciales entran a este informe, y la tabla
// trae margen y costeo. Se gobierna con el nivel del módulo, que es el mecanismo que ya usa
// el resto del sistema: 'ver' alcanza para volumen y facturación; para el margen hace falta
// 'operar' o más. Admin ve todo (nivelEnModulo le devuelve 'anular').
import express from 'express';
import db from '../servicios/db.js';
import { estadoSync, diagnostico, syncSheets } from '../servicios/sheets.js';
import { nivelEnModulo } from '../servicios/permisos.js';

const router = express.Router();

// Mismo requireAuth que el resto de los routers, letra por letra: si acá leyera la cookie de
// otra forma, este módulo tendría su propia idea de quién está adentro.
function requireAuth(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    req.user = JSON.parse(cookie);
    next();
  } catch (e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

const MODULO = 'informes-comercial';
const ORDEN = { ver: 1, operar: 2, borrar: 3, anular: 3 };
// El margen es el dato sensible de esta pantalla: quién compra a cuánto y cuánto deja.
const puedeVerMargen = (u) => (ORDEN[nivelEnModulo(u, MODULO)] || 0) >= 2;

// ── Las dimensiones por las que se puede agrupar y filtrar ───────────────────────────
// LISTA BLANCA, no el texto que llegue: estos nombres entran directo al SQL y sin esto
// cualquiera podría escribir la consulta que quisiera desde la barra de direcciones.
const DIMENSIONES = {
  cliente:      { col: 'cliente',      label: 'Cliente' },
  cate_clie:    { col: 'cate_clie',    label: 'Categoría de cliente' },
  vendedor:     { col: 'vendedor',     label: 'Vendedor' },
  producto:     { col: 'producto',     label: 'Producto' },
  articulo:     { col: 'articulo',     label: 'Artículo' },
  categoria:    { col: 'categoria',    label: 'Categoría' },
  subcategoria: { col: 'subcategoria', label: 'Subcategoría' },
  proveedor:    { col: 'proveedor',    label: 'Proveedor' },
  anio:         { col: 'anio',         label: 'Año' },
  mes:          { col: 'mes',          label: 'Mes' },
};

// El período se arma con anio y mes y NO con la columna fecha: fecha viene de la planilla
// como texto y no hay garantía de su formato, mientras que anio/mes son numéricos y son los
// que ya usa el calendario estacional. Un filtro de fechas mal parseado no falla: devuelve
// menos filas y parece un mes flojo.
const periodoSQL = "(CAST(anio AS INTEGER) * 100 + CAST(mes AS INTEGER))";

function armarWhere(q) {
  const cond = ["anio IS NOT NULL AND anio <> ''", "mes IS NOT NULL AND mes <> '' AND mes <> '0'"];
  const params = [];
  const desde = Number(q.desde), hasta = Number(q.hasta);   // formato AAAAMM
  if (desde > 0) { cond.push(`${periodoSQL} >= ?`); params.push(desde); }
  if (hasta > 0) { cond.push(`${periodoSQL} <= ?`); params.push(hasta); }
  // Filtros por dimensión: llegan como filtro_<dim>=valor
  for (const [k, d] of Object.entries(DIMENSIONES)) {
    const v = q['filtro_' + k];
    if (v != null && String(v).trim() !== '') { cond.push(`${d.col} = ?`); params.push(String(v)); }
  }
  // Búsqueda libre sobre las dos dimensiones de texto que más se buscan.
  const busca = (q.q || '').trim();
  if (busca) { cond.push('(cliente LIKE ? OR producto LIKE ? OR articulo LIKE ?)');
    params.push('%' + busca + '%', '%' + busca + '%', '%' + busca + '%'); }
  return { where: 'WHERE ' + cond.join(' AND '), params };
}

// GET /api/informes/ventas — la tabla agrupada.
router.get('/ventas', requireAuth, (req, res) => {
  try {
    const dimKey = DIMENSIONES[req.query.agrupar] ? req.query.agrupar : 'cliente';
    const dim = DIMENSIONES[dimKey];
    const { where, params } = armarWhere(req.query);
    const margen = puedeVerMargen(req.user);

    // rent% con la MISMA fórmula que el calendario estacional (rent_dol sobre tot_dol). Dos
    // fórmulas para el mismo número terminan dando distinto y nadie sabe cuál mirar.
    const colsMargen = margen
      ? `, ROUND(SUM(rent_dol),0) AS rent_dol,
           ROUND(SUM(rent_dol) * 100.0 / NULLIF(SUM(tot_dol), 0), 1) AS rent_pct`
      : '';

    const filas = db.prepare(`
      SELECT COALESCE(NULLIF(${dim.col}, ''), '(sin dato)') AS clave,
             COUNT(*) AS operaciones,
             COUNT(DISTINCT cliente) AS clientes,
             ROUND(SUM(kilos_tot), 0) AS kilos,
             ROUND(SUM(total), 0) AS facturacion_ars,
             ROUND(SUM(tot_dol), 0) AS facturacion_usd,
             ROUND(SUM(tot_dol) / NULLIF(SUM(kilos_tot), 0), 2) AS usd_por_kg
             ${colsMargen}
      FROM sheet_ventas
      ${where}
      GROUP BY clave
      ORDER BY facturacion_usd DESC
      LIMIT 500
    `).all(...params);

    // El total NO se suma en el navegador desde las filas: el LIMIT 500 dejaría afuera la
    // cola larga y el total daría menos que la realidad, sin que se note.
    const tot = db.prepare(`
      SELECT COUNT(*) AS operaciones, COUNT(DISTINCT cliente) AS clientes,
             ROUND(SUM(kilos_tot), 0) AS kilos,
             ROUND(SUM(total), 0) AS facturacion_ars,
             ROUND(SUM(tot_dol), 0) AS facturacion_usd,
             ROUND(SUM(tot_dol) / NULLIF(SUM(kilos_tot), 0), 2) AS usd_por_kg
             ${colsMargen}
      FROM sheet_ventas ${where}
    `).get(...params);

    const est = estadoSync();
    res.json({ ok: true, data: {
      agrupar: dimKey, label: dim.label, filas, total: tot,
      truncado: filas.length >= 500,
      ve_margen: margen,
      // De cuándo es el dato. Un informe sin esto se lee como si fuera de recién.
      sync: { ultimo_ok: est.ultimo_ok, desactualizado: est.datos_desactualizados, ultimo_error: est.ultimo_error,
              filas_ventas: est.ventas && est.ventas.n },
    } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/informes/ventas/opciones — qué poner en cada desplegable de filtro, y el rango
// de períodos que hay cargado. Se pide una vez al entrar y no en cada consulta.
// POST /api/informes/sync — correr el sync AHORA y decir cómo le fue.
//
// El que ya existía (POST /api/buscar/sync) contesta "iniciado en background" y se guarda el
// error en la consola del servidor. O sea: el que aprieta el botón nunca se entera de por qué
// falló, que es justo lo único que necesita saber. Este espera a que termine y devuelve el
// motivo si se cayó.
//
// Sólo admin: pega contra Google y reescribe las dos tablas.
router.post('/sync', requireAuth, express.json(), async (req, res) => {
  if (!req.user || req.user.rol !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Solo administradores' });
  }
  try {
    const antes = db.prepare('SELECT MAX(id) m FROM sheet_sync_log').get().m || 0;
    await syncSheets();
    // syncSheets() atrapa su propio error y lo deja en el log en vez de tirarlo: por eso el
    // resultado se lee del log y no de un try/catch. Se miran sólo las filas NUEVAS, para no
    // reportar un error viejo como si fuera de esta corrida.
    const nuevas = db.prepare('SELECT tipo, filas, duracion_ms, error, creado_en FROM sheet_sync_log WHERE id > ? ORDER BY id').all(antes);
    const err = nuevas.find(x => x.tipo === 'error');
    if (err) return res.status(502).json({ ok: false, error: err.error || 'El sync falló sin dejar motivo', log: nuevas });
    const est = estadoSync();
    res.json({ ok: true, data: {
      log: nuevas,
      compras: est.compras && est.compras.n,
      ventas: est.ventas && est.ventas.n,
      ultimo_ok: est.ultimo_ok,
    } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/ventas/opciones', requireAuth, (req, res) => {
  try {
    const lista = (col) => db.prepare(
      `SELECT DISTINCT ${col} v FROM sheet_ventas
       WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY ${col} LIMIT 400`
    ).all().map(r => r.v);
    const rango = db.prepare(`
      SELECT MIN(${periodoSQL}) AS min, MAX(${periodoSQL}) AS max FROM sheet_ventas
      WHERE anio IS NOT NULL AND anio <> '' AND mes IS NOT NULL AND mes <> '' AND mes <> '0'
    `).get();
    res.json({ ok: true, data: {
      dimensiones: Object.entries(DIMENSIONES).map(([k, d]) => ({ k, label: d.label })),
      cliente: lista('cliente'), vendedor: lista('vendedor'),
      producto: lista('producto'), categoria: lista('categoria'),
      proveedor: lista('proveedor'), cate_clie: lista('cate_clie'),
      periodo: rango, ve_margen: puedeVerMargen(req.user),
    } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/informes/ventas/evolucion — la misma consulta pero mes a mes, para el gráfico.
// Va aparte y no dentro de /ventas porque son dos preguntas distintas: una es "quién" y la
// otra "cuándo", y pedirlas juntas obligaría a traer siempre las dos.
router.get('/ventas/evolucion', requireAuth, (req, res) => {
  try {
    const { where, params } = armarWhere(req.query);
    const margen = puedeVerMargen(req.user);
    const filas = db.prepare(`
      SELECT ${periodoSQL} AS periodo,
             CAST(anio AS INTEGER) AS anio, CAST(mes AS INTEGER) AS mes,
             ROUND(SUM(kilos_tot), 0) AS kilos,
             ROUND(SUM(tot_dol), 0) AS facturacion_usd
             ${margen ? ', ROUND(SUM(rent_dol) * 100.0 / NULLIF(SUM(tot_dol),0), 1) AS rent_pct' : ''}
      FROM sheet_ventas ${where}
      GROUP BY periodo ORDER BY periodo
    `).all(...params);
    res.json({ ok: true, data: { filas, ve_margen: margen } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/informes/diagnostico — por qué el informe muestra lo que muestra.
// Lee los TÍTULOS de la planilla en vivo y los compara contra el mapeo del código, cuenta
// las filas guardadas y marca los campos que quedaron 100% vacíos. Con eso se ve si el
// problema es un corrimiento de columnas, un sync que no corrió, o un dato que no se carga.
//
// Sólo admin: pega contra Google (gasta cuota) y muestra la estructura de la planilla.
router.get('/diagnostico', requireAuth, async (req, res) => {
  if (!req.user || req.user.rol !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Solo administradores' });
  }
  try { res.json({ ok: true, data: await diagnostico() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
