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
// TODO EN DÓLARES. El peso salía al lado de cada número y no se usaba para nada: se compara
// entre campañas, y con la inflación de por medio dos importes en pesos de años distintos no
// se pueden ni restar. El peso está en la planilla para quien lo necesite; acá estorba.
// (Pablo, 26/8/2026: "pesos tampoco, mejor hagamos todo directamente en dólares".)
//
// LAS OPERACIONES TAMPOCO. Contaban filas de la planilla, no pedidos: dos renglones del
// mismo remito son dos. Un número que parece un KPI y no lo es se termina citando en una
// reunión. Se saca. La cantidad de CLIENTES sí queda: esa se entiende sola.
//
// LA RENTABILIDAD NO LA VE CUALQUIERA. Los comerciales entran a este informe, y la tabla
// trae margen y costeo. Se gobierna con el nivel del módulo, que es el mecanismo que ya usa
// el resto del sistema: 'ver' alcanza para volumen y facturación; para el margen hace falta
// 'operar' o más. Admin ve todo (nivelEnModulo le devuelve 'anular').
import express from 'express';
import db from '../servicios/db.js';
import { estadoSync, diagnostico, syncSheets, verificarPlanilla } from '../servicios/sheets.js';
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
  // EL AÑO COMERCIAL VA DE JULIO A JUNIO, no de enero a diciembre. Por eso se agrupa por
  // 'periodo' (2025-2026) y por 'mes_ok' (01-JULIO … 12-JUN), que son las columnas que la
  // planilla ya trae calculadas. Agrupar por el año calendario parte cada campaña al medio
  // y hace que los totales no se parezcan a nada de lo que el equipo mira.
  periodo:      { col: 'periodo',      label: 'Período (jul–jun)' },
  mes_ok:       { col: 'mes_ok',       label: 'Mes comercial' },
  anio:         { col: 'anio',         label: 'Año calendario' },
  mes:          { col: 'mes',          label: 'Mes calendario' },
};

// mes_ok viene como '01-JULIO', '02-AGOSTO' … '12-JUN': ordenar por el texto ya da el orden
// comercial correcto, porque el número va adelante. Por eso estas dos dimensiones se ordenan
// por su clave y no por facturación, que es lo que se quiere en una serie de tiempo.
const DIM_CRONOLOGICAS = new Set(['periodo', 'mes_ok', 'anio', 'mes']);

// El filtro NO usa la columna fecha: viene de la planilla como texto y sin formato
// garantizado, y un filtro de fechas mal parseado no falla — devuelve menos filas y parece
// un mes flojo. Se usa 'periodo', que la planilla ya trae calculado con el criterio del
// negocio (julio a junio), y es además la unidad con la que el equipo compara campañas.
function armarWhere(q) {
  // Sólo se exige que la fila tenga período: es la unidad con la que se mira el negocio.
  // Antes se exigía anio y mes calendario y se descartaba mes='0', que dejaba afuera filas
  // perfectamente buenas del período en curso.
  const cond = ["periodo IS NOT NULL AND periodo <> ''"];
  const params = [];
  // Uno o varios períodos: varios es lo que permite comparar campañas, que es como se mira.
  const pers = String(q.periodos || '').split(',').map(x => x.trim()).filter(Boolean);
  if (pers.length) {
    cond.push('periodo IN (' + pers.map(() => '?').join(',') + ')');
    params.push(...pers);
  }
  // Un mes comercial puntual, si se quiere mirar sólo julio de cada campaña.
  const mok = String(q.mes_ok || '').trim();
  if (mok) { cond.push('mes_ok = ?'); params.push(mok); }
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
             COUNT(DISTINCT cliente) AS clientes,
             ROUND(SUM(kilos_tot), 0) AS kilos,
             ROUND(SUM(tot_dol), 0) AS facturacion_usd,
             ROUND(SUM(tot_dol) / NULLIF(SUM(kilos_tot), 0), 2) AS usd_por_kg
             ${colsMargen}
      FROM sheet_ventas
      ${where}
      GROUP BY clave
      ORDER BY ${DIM_CRONOLOGICAS.has(dimKey) ? 'clave ASC' : 'facturacion_usd DESC'}
      LIMIT 500
    `).all(...params);

    // El total NO se suma en el navegador desde las filas: el LIMIT 500 dejaría afuera la
    // cola larga y el total daría menos que la realidad, sin que se note.
    const tot = db.prepare(`
      SELECT COUNT(DISTINCT cliente) AS clientes,
             ROUND(SUM(kilos_tot), 0) AS kilos,
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

// Las opciones de la comparativa se publican acá y no se escriben en el panel: una lista
// duplicada se desactualiza sola.
router.get('/ventas/opciones', requireAuth, (req, res) => {
  try {
    const lista = (col) => db.prepare(
      `SELECT DISTINCT ${col} v FROM sheet_ventas
       WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY ${col} LIMIT 400`
    ).all().map(r => r.v);
    // Los períodos comerciales que hay cargados, del más nuevo al más viejo: es lo primero
    // que se elige al entrar, y el más nuevo es el que se está mirando.
    const periodos = db.prepare(
      "SELECT DISTINCT periodo v FROM sheet_ventas WHERE periodo IS NOT NULL AND periodo <> '' ORDER BY periodo DESC"
    ).all().map(r => r.v);
    const meses = db.prepare(
      "SELECT DISTINCT mes_ok v FROM sheet_ventas WHERE mes_ok IS NOT NULL AND mes_ok <> '' ORDER BY mes_ok"
    ).all().map(r => r.v);
    res.json({ ok: true, data: {
      dimensiones: Object.entries(DIMENSIONES).map(([k, d]) => ({ k, label: d.label })),
      columnas: Object.entries(COLUMNAS).map(([k, d]) => ({ k, label: d.label })),
      cliente: lista('cliente'), vendedor: lista('vendedor'),
      producto: lista('producto'), categoria: lista('categoria'),
      proveedor: lista('proveedor'), cate_clie: lista('cate_clie'),
      periodos, meses, ve_margen: puedeVerMargen(req.user),
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
    // La serie va por MES COMERCIAL dentro de cada período: el gráfico tiene que arrancar en
    // julio, como la campaña. Ordenar por período y después por mes_ok da justo eso, porque
    // mes_ok trae el número adelante ('01-JULIO').
    const filas = db.prepare(`
      SELECT periodo, mes_ok,
             ROUND(SUM(kilos_tot), 0) AS kilos,
             ROUND(SUM(tot_dol), 0) AS facturacion_usd
             ${margen ? ', ROUND(SUM(rent_dol) * 100.0 / NULLIF(SUM(tot_dol),0), 1) AS rent_pct' : ''}
      FROM sheet_ventas ${where}

      GROUP BY periodo, mes_ok ORDER BY periodo, mes_ok
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

// GET /api/informes/verificar-kilos — TEMPORAL, se saca al cerrar el proyecto de informes.
//
// Contesta si lo que quedó guardado despues del resync coincide con lo que dice la planilla
// HOY. El "antes" no existe: el sync es un reemplazo atomico y no guarda historico, asi que
// comparar antes/despues no se puede — y ademas no es lo que decide si se puede construir
// agregados encima. Compara kilos_tot, tot_dol y rent_dol celda por celda, muestra la columna
// sem (que bloquea el grafico semanal) y las columnas de B COMPRAS que el sync lee sin mapear.
//
// Solo admin: pega contra Google, recorre la planilla entera y gasta cuota.
router.get('/verificar-kilos', requireAuth, async (req, res) => {
  if (!req.user || req.user.rol !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Solo administradores' });
  }
  try {
    const n = Math.min(Math.max(parseInt(req.query.n, 10) || 10, 1), 50);
    res.json({ ok: true, data: await verificarPlanilla(n) });
  } catch (e) {
    console.error('[Informes][verificar-kilos]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Qué puede ir en las COLUMNAS de la comparativa. Lista blanca por lo mismo que DIMENSIONES:
// el nombre entra directo al SQL.
//
// Las dos ordenan bien como TEXTO y por eso no hace falta un ORDER BY especial: los períodos
// son '2025-2026' y los meses comerciales '01-JULIO' … '12-JUN', con el número adelante
// justamente para que el orden alfabético dé el orden del negocio.
const COLUMNAS = {
  periodo: { col: 'periodo', label: 'Período (jul–jun)' },
  mes_ok:  { col: 'mes_ok',  label: 'Mes comercial' },
};

// GET /api/informes/ventas/comparar — la MISMA agrupación, pivoteada: una columna por
// período o por mes comercial, y la métrica adentro.
//
// Es la tabla que el equipo ya arma en la planilla (MES OK en las filas, las campañas en las
// columnas), generalizada en los dos ejes: en las filas va cualquier dimensión —clientes,
// productos, vendedores— y en las columnas el período o el mes. De ahí salen las dos
// preguntas que se hacen todo el tiempo: cómo viene un cliente MES A MES, y cómo se compara
// un PRODUCTO CONTRA OTRO en la misma ventana de tiempo.
//
// El pivot se arma en JS y no con SQL dinámico: los valores de la columna son DATOS, y
// meterlos en el texto de la consulta para generar una columna por cada uno es exactamente
// cómo se abre un agujero de inyección en una pantalla que sólo tiene que leer.
router.get('/ventas/comparar', requireAuth, (req, res) => {
  try {
    const dimKey = DIMENSIONES[req.query.agrupar] ? req.query.agrupar : 'mes_ok';
    const dim = DIMENSIONES[dimKey];
    const colKey = COLUMNAS[req.query.columnas] ? req.query.columnas : 'periodo';
    const colDim = COLUMNAS[colKey];
    const { where, params } = armarWhere(req.query);
    const margen = puedeVerMargen(req.user);
    const cm = margen ? ', ROUND(SUM(rent_dol),0) AS rent_dol,'
      + ' ROUND(SUM(rent_dol)*100.0/NULLIF(SUM(tot_dol),0),1) AS rent_pct' : '';

    // Filas y columnas por la MISMA dimensión daría una diagonal y nada más. Se avisa en vez
    // de devolver una tabla que parece rota.
    if (dim.col === colDim.col) {
      return res.status(400).json({ ok: false,
        error: 'Las filas y las columnas no pueden ser lo mismo (' + dim.label + ').' });
    }

    const filas = db.prepare(`
      SELECT COALESCE(NULLIF(${dim.col}, ''), '(sin dato)') AS clave,
             COALESCE(NULLIF(${colDim.col}, ''), '(sin dato)') AS col,
             ROUND(SUM(kilos_tot), 0) AS kilos,
             ROUND(SUM(tot_dol), 0) AS facturacion_usd,
             ROUND(SUM(tot_dol) / NULLIF(SUM(kilos_tot), 0), 2) AS usd_por_kg
             ${cm}
      FROM sheet_ventas ${where}
      GROUP BY clave, col
    `).all(...params);

    const cols = [...new Set(filas.map(f => f.col))].sort();
    const mapa = new Map();
    for (const f of filas) {
      if (!mapa.has(f.clave)) mapa.set(f.clave, { clave: f.clave, por_col: {} });
      mapa.get(f.clave).por_col[f.col] = f;
    }
    let salida = [...mapa.values()];

    // Las dimensiones de tiempo van en orden cronológico. El resto se ordena por facturación,
    // pero POR CUÁL depende del eje:
    //
    //   · columnas = PERÍODO → por el período más nuevo. Es contra el que se compara, y
    //     ordenar por el viejo dejaría arriba a los que ya no compran.
    //   · columnas = MES     → por el TOTAL de la fila. Acá "la última columna" es apenas el
    //     último mes cargado, y ordenar por él pone primero al que casualmente compró en
    //     septiembre aunque sea el más chico de todos. La fila entera es el volumen real.
    const ultima = cols[cols.length - 1];
    const peso = colKey === 'mes_ok'
      ? (f) => cols.reduce((t, c) => t + ((f.por_col[c] || {}).facturacion_usd || 0), 0)
      : (f) => (f.por_col[ultima] || {}).facturacion_usd || 0;
    salida.sort(DIM_CRONOLOGICAS.has(dimKey)
      ? (a, b) => String(a.clave).localeCompare(String(b.clave))
      : (a, b) => peso(b) - peso(a));
    const truncado = salida.length > 300;
    salida = salida.slice(0, 300);

    // Totales por columna, de su propia consulta: sumando la tabla recortada darían de menos.
    const totales = db.prepare(`
      SELECT COALESCE(NULLIF(${colDim.col}, ''), '(sin dato)') AS col,
             ROUND(SUM(kilos_tot),0) AS kilos, ROUND(SUM(tot_dol),0) AS facturacion_usd,
             ROUND(SUM(tot_dol) / NULLIF(SUM(kilos_tot), 0), 2) AS usd_por_kg ${cm}
      FROM sheet_ventas ${where} GROUP BY col ORDER BY col
    `).all(...params).reduce((m, r) => { m[r.col] = r; return m; }, {});

    // Con las columnas por MES y varios períodos marcados, cada celda suma el mismo mes de
    // todas las campañas. No está mal —a veces es lo que se quiere— pero no se puede leer
    // sin saberlo, así que se dice. Silenciarlo haría que julio de dos años pareciera uno.
    const nPeriodos = new Set(filas.length
      ? db.prepare(`SELECT DISTINCT periodo FROM sheet_ventas ${where}`).all(...params).map(r => r.periodo)
      : []).size;
    const mezcla_periodos = colKey === 'mes_ok' && nPeriodos > 1;

    const est = estadoSync();
    res.json({ ok: true, data: {
      agrupar: dimKey, label: dim.label,
      columnas: colKey, columnas_label: colDim.label,
      cols, filas: salida, totales, truncado,
      mezcla_periodos, periodos_en_juego: nPeriodos,
      ve_margen: margen,
      sync: { ultimo_ok: est.ultimo_ok, desactualizado: est.datos_desactualizados },
    } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
