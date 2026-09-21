// src/rutas/pl_abasto.js
// ══ P&L ABASTO ═══════════════════════════════════════════════════════════════════
//
// Pablo, 12/9/2026: «dentro de Informes vamos a agregar un submódulo que se llama P&L
// Abasto. ¿Qué es? Básicamente un cuadro de resultados... voy a subir un Excel con el
// libro diario que nos trae el otro sistema para poder ir llevando los resultados de la
// empresa por aquí».
//
// LA FUENTE ES EL LIBRO DIARIO DEL OTRO SISTEMA, no la contabilidad de este panel. La
// pantalla lee el Excel y manda los renglones; acá se guardan, y cada carga REEMPLAZA el
// período que trae el archivo, de su primera a su última fecha. Así sirve igual un diario
// acumulado del año que uno de un solo día: lo que no está en el archivo no se toca.
//
// EL IMPORTE DE UNA CUENTA EN UN MES ES HABER − DEBE. Los ingresos quedan positivos y los
// gastos negativos, y todos los subtotales del cuadro son sumas.
//
// El nivel lo decide exigirNivel por la dirección (/api/pl-abasto, declarada en
// ensure_api_prefijos.js y con la lectura controlada en permisos.js): 'ver' mira; subir
// el diario, guardar los rubros y cargar o corregir un ajuste manual pide 'operar'; volver
// los rubros a los de por defecto y eliminar un ajuste, 'anular'.
import express from 'express';
import db from '../servicios/db.js';
import { RUBROS, SIN_ASIGNAR, esRubro, esCuentaDeResultado, rubroPorDefecto, validarCarga,
  avisosDeReemplazo, asientosSinPareja, validarAjuste, TIPOS_DOLAR, esTipoDolar, promedioMensual,
  validarCotizaciones } from '../servicios/pl_abasto.js';

const router = express.Router();

// Mismo requireAuth que el resto de los routers, letra por letra.
function requireAuth(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    req.user = JSON.parse(cookie);
    next();
  } catch (e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS pl_abasto_cargas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    archivo      TEXT,
    desde        TEXT NOT NULL,
    hasta        TEXT NOT NULL,
    renglones    INTEGER NOT NULL DEFAULT 0,
    reemplazados INTEGER NOT NULL DEFAULT 0,
    debe         REAL NOT NULL DEFAULT 0,
    haber        REAL NOT NULL DEFAULT 0,
    usuario_id   INTEGER,
    creado_en    TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS pl_abasto_movimientos (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    carga_id  INTEGER,
    fecha     TEXT NOT NULL,
    mes       TEXT NOT NULL,
    asiento   TEXT,
    cuenta    TEXT NOT NULL,
    debe      REAL NOT NULL DEFAULT 0,
    haber     REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_pla_mov_mes_cuenta ON pl_abasto_movimientos(mes, cuenta);
  CREATE INDEX IF NOT EXISTS idx_pla_mov_fecha      ON pl_abasto_movimientos(fecha);
  CREATE INDEX IF NOT EXISTS idx_pla_mov_asiento    ON pl_abasto_movimientos(asiento);
  CREATE TABLE IF NOT EXISTS pl_abasto_cuentas (
    cuenta TEXT PRIMARY KEY,
    nombre TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pl_abasto_rubros (
    cuenta         TEXT PRIMARY KEY,
    rubro          TEXT NOT NULL,
    modificado_por INTEGER,
    modificado_en  TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS pl_abasto_ajustes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    rubro          TEXT NOT NULL,
    nombre         TEXT NOT NULL,
    creado_por     INTEGER,
    creado_en      TEXT DEFAULT (datetime('now','localtime')),
    modificado_por INTEGER,
    modificado_en  TEXT,
    eliminado_por  INTEGER,
    eliminado_en   TEXT
  );
  CREATE TABLE IF NOT EXISTS pl_abasto_ajuste_meses (
    ajuste_id INTEGER NOT NULL,
    mes       TEXT NOT NULL,
    importe   REAL NOT NULL,
    PRIMARY KEY (ajuste_id, mes)
  );
  CREATE TABLE IF NOT EXISTS pl_abasto_cotizaciones (
    mes            TEXT PRIMARY KEY,
    cotizacion     REAL NOT NULL,
    origen         TEXT NOT NULL,
    tipo           TEXT,
    modificado_por INTEGER,
    modificado_en  TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS pl_abasto_ventas_extra (
    cuenta         TEXT PRIMARY KEY,
    modificado_por INTEGER,
    modificado_en  TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// LOS TÍTULOS CAMBIARON (V1056). Una clasificación guardada con un título que ya no existe
// —«otros»— se borra, y la cuenta vuelve a su título por defecto, que para un gasto es ninguno:
// no suma y se ve en la lista sin etiqueta. Un ajuste manual, en cambio, no puede quedar sin
// título, porque dejaría de sumar sin que nadie lo vea: pasa a costos variables, donde iba el
// gasto genérico, y el resultado neto no se mueve.
function migrarTitulos(db) {
  const validos = RUBROS.map((r) => r.k);
  const q = validos.map(() => '?').join(',');
  const rubros = db.prepare(`DELETE FROM pl_abasto_rubros WHERE rubro NOT IN (${q}, ?)`).run(...validos, SIN_ASIGNAR).changes;
  const ajustes = db.prepare(`UPDATE pl_abasto_ajustes SET rubro = 'costos_variables' WHERE rubro NOT IN (${q})`)
    .run(...validos).changes;
  return { rubros, ajustes };
}
migrarTitulos(db);

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
// Los asientos de un importe, a lo sumo. Los de VENTAS de un mes son más de mil: se
// muestran los más recientes, y el total es siempre de todos.
const DETALLE_MAX = 1000;
// Los asientos sin pareja de lo que no balancea, a lo sumo. En un año entero son cientos.
const NB_MAX = 2000;
// La historia del dólar, día por día: argentinadatos.com, pública, gratis y sin clave.
const COTIZ_URL = 'https://api.argentinadatos.com/v1/cotizaciones/dolares/';
const COTIZ_TIMEOUT_MS = 20000;

function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function usuarioId(req) {
  return (req.user && Number(req.user.id)) || null;
}

// El rubro de cada cuenta: el que eligió Pablo o, si nadie la clasificó, el de por defecto.
function rubrosDeCuentas(db) {
  const elegidos = new Map(db.prepare('SELECT cuenta, rubro FROM pl_abasto_rubros').all()
    .map((x) => [x.cuenta, x.rubro]));
  const nombres = new Map(db.prepare('SELECT cuenta, nombre FROM pl_abasto_cuentas').all()
    .map((x) => [x.cuenta, x.nombre]));
  const rubroDe = (cuenta) => elegidos.get(cuenta) || rubroPorDefecto(cuenta, nombres.get(cuenta));
  // SÓLO VENTAS SE REPITE (V1058). Pablo, 14/9/2026: «sólo para el título VENTAS, permitime
  // repetir rubros: que un rubro esté categorizado en ventas y un subrubro más». Y que sume en
  // los dos. Una cuenta sin título, o que ya tiene VENTAS como título, no se repite.
  const extra = new Set(db.prepare('SELECT cuenta FROM pl_abasto_ventas_extra').all().map((x) => x.cuenta));
  const tambienVentas = (cuenta) => {
    const r = rubroDe(cuenta);
    return extra.has(cuenta) && r !== 'ventas' && r !== SIN_ASIGNAR ? 1 : 0;
  };
  return { elegidos, nombres, rubroDe, tambienVentas };
}

// LAS OTRAS CUENTAS DE CADA ASIENTO. El libro diario del otro sistema no trae glosa ni
// tercero: el cliente de una venta o el proveedor de un gasto están en otro renglón del
// mismo asiento, y eso es lo que se muestra.
function contrapartidas(db, filas) {
  const asientos = [...new Set(filas.map((f) => f.asiento).filter(Boolean))];
  const porAsiento = new Map();
  for (let i = 0; i < asientos.length; i += 500) {
    const lote = asientos.slice(i, i + 500);
    const q = lote.map(() => '?').join(',');
    const otras = db.prepare(`SELECT m.asiento, m.fecha, m.cuenta, COALESCE(c.nombre, m.cuenta) AS nombre
        FROM pl_abasto_movimientos m LEFT JOIN pl_abasto_cuentas c ON c.cuenta = m.cuenta
       WHERE m.asiento IN (${q})`).all(...lote);
    for (const x of otras) {
      const k = x.asiento + '|' + x.fecha;
      if (!porAsiento.has(k)) porAsiento.set(k, []);
      porAsiento.get(k).push(x);
    }
  }
  for (const f of filas) {
    const nombres = [...new Set((porAsiento.get(f.asiento + '|' + f.fecha) || [])
      .filter((x) => x.cuenta !== f.cuenta).map((x) => x.nombre))];
    f.contrapartida = nombres.slice(0, 3).join(' · ') + (nombres.length > 3 ? ' · +' + (nombres.length - 3) : '');
  }
  return filas;
}

// ── QUÉ RENGLONES ESTÁN EN UN ASIENTO QUE NO BALANCEA (V1063) ────────────────
// Pablo, 17/9/2026: «dentro del detalle de asientos, un tilde para ver los "no balancea", así
// podemos investigarlos más fácilmente».
//
// Son EXACTAMENTE los que lista la solapa No balancea, con la misma regla y la misma función:
// el día no cierra, y adentro de ese día el asiento no tiene otro que lo compense al centavo.
// Marcar sólo «debe ≠ haber» señalaría de más: un tercio de los asientos del otro sistema no
// cierran solos porque la operación viene partida en dos números, y eso no es un error.
function marcarSinPareja(db, filas) {
  for (const f of filas) f.sin_pareja = 0;
  const fechas = [...new Set(filas.map((f) => f.fecha).filter(Boolean))];
  const dias = [];
  for (let i = 0; i < fechas.length; i += 400) {
    const lote = fechas.slice(i, i + 400);
    const q = lote.map(() => '?').join(',');
    dias.push(...db.prepare(`SELECT fecha FROM pl_abasto_movimientos WHERE fecha IN (${q})
      GROUP BY fecha HAVING ABS(SUM(debe) - SUM(haber)) >= 0.005`).all(...lote).map((x) => x.fecha));
  }
  const solos = new Set();
  for (let i = 0; i < dias.length; i += 400) {
    const lote = dias.slice(i, i + 400);
    const q = lote.map(() => '?').join(',');
    const asientos = db.prepare(`SELECT asiento, fecha, ROUND(SUM(debe), 2) AS debe, ROUND(SUM(haber), 2) AS haber
      FROM pl_abasto_movimientos WHERE fecha IN (${q})
      GROUP BY asiento, fecha HAVING ABS(SUM(debe) - SUM(haber)) >= 0.005`).all(...lote);
    for (const a of asientosSinPareja(asientos).solos) solos.add(a.asiento + '|' + a.fecha);
  }
  for (const f of filas) f.sin_pareja = solos.has(f.asiento + '|' + f.fecha) ? 1 : 0;
  return filas;
}

// ── LO QUE SE VA A REEMPLAZAR ────────────────────────────────────────────────
// Cuántos renglones ya cargados borra la carga, y qué cuentas conocidas cambian de nombre:
// es lo que delata un archivo equivocado.
function reemplazo(db, desde, hasta, entran, cuentas) {
  const existentes = Number(db.prepare('SELECT COUNT(*) AS n FROM pl_abasto_movimientos WHERE fecha BETWEEN ? AND ?')
    .get(desde, hasta).n) || 0;
  const guardados = new Map(db.prepare('SELECT cuenta, nombre FROM pl_abasto_cuentas').all()
    .map((x) => [x.cuenta, x.nombre]));
  const cambian = Object.entries(cuentas || {})
    .filter(([c, n]) => guardados.has(c) && String(guardados.get(c)) !== String(n))
    .map(([c, n]) => ({ cuenta: c, antes: guardados.get(c), ahora: n }));
  return { existentes, entran: Number(entran) || 0, distintos: cambian.length, ejemplos: cambian.slice(0, 5) };
}

// ── AJUSTES MANUALES ─────────────────────────────────────────────────────────
function ajusteVivo(db, id) {
  return db.prepare('SELECT id FROM pl_abasto_ajustes WHERE id = ? AND eliminado_en IS NULL').get(Number(id)) || null;
}

// Los importes que vienen se escriben y los vacíos se borran. LOS MESES QUE NO VIENEN QUEDAN
// COMO ESTABAN: la ventana muestra los del período que se está mirando, no todos.
function escribirMesesDeAjuste(db, id, meses) {
  const up = db.prepare(`INSERT INTO pl_abasto_ajuste_meses (ajuste_id, mes, importe) VALUES (?,?,?)
    ON CONFLICT(ajuste_id, mes) DO UPDATE SET importe = excluded.importe`);
  const del = db.prepare('DELETE FROM pl_abasto_ajuste_meses WHERE ajuste_id = ? AND mes = ?');
  for (const [m, v] of Object.entries(meses)) {
    if (v == null) del.run(id, m); else up.run(id, m, v);
  }
}

// ── LA COTIZACIÓN DE CADA MES ────────────────────────────────────────────────
function cotizacionesDelPeriodo(db, desde, hasta) {
  const out = {};
  for (const x of db.prepare(`SELECT mes, cotizacion, origen, tipo FROM pl_abasto_cotizaciones
      WHERE mes BETWEEN ? AND ?`).all(desde, hasta)) {
    out[x.mes] = { cotizacion: x.cotizacion, origen: x.origen, tipo: x.tipo };
  }
  return out;
}

// Trae la historia del dólar elegido y le pone a cada mes con movimientos el promedio de sus
// días. LA CARGADA A MANO NO SE PISA: si alguien la fijó, es porque quiere ESE valor.
// `pedir` es fetch; los tests le pasan uno propio.
async function traerCotizaciones(db, tipo, usuario, pedir) {
  if (!esTipoDolar(tipo)) return { status: 400, body: { ok: false, error: 'Elegí qué dólar traer.' } };
  const meses = db.prepare('SELECT DISTINCT mes FROM pl_abasto_movimientos ORDER BY mes').all().map((x) => x.mes);
  if (!meses.length) return { status: 400, body: { ok: false, error: 'Todavía no hay libro diario cargado.' } };
  let dias;
  try {
    const r = await pedir(COTIZ_URL + tipo, { headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(COTIZ_TIMEOUT_MS) });
    if (!r.ok) throw new Error('respondió ' + r.status);
    dias = await r.json();
  } catch (e) {
    return { status: 502, body: { ok: false, error: 'No se pudo consultar la cotización (' + e.message
      + '). Probá de nuevo más tarde, o cargala a mano.' } };
  }
  const prom = promedioMensual(dias, meses);
  const manuales = new Set(db.prepare("SELECT mes FROM pl_abasto_cotizaciones WHERE origen = 'manual'").all()
    .map((x) => x.mes));
  const up = db.prepare(`INSERT INTO pl_abasto_cotizaciones (mes, cotizacion, origen, tipo, modificado_por, modificado_en)
      VALUES (?,?,'mercado',?,?,datetime('now','localtime'))
    ON CONFLICT(mes) DO UPDATE SET cotizacion = excluded.cotizacion, origen = excluded.origen, tipo = excluded.tipo,
      modificado_por = excluded.modificado_por, modificado_en = excluded.modificado_en`);
  let traidos = 0;
  db.transaction(() => {
    for (const [mes, v] of Object.entries(prom)) {
      if (manuales.has(mes)) continue;
      up.run(mes, v, tipo, usuario);
      traidos++;
    }
  })();
  return { status: 200, body: { ok: true, data: { tipo, traidos,
    manuales: meses.filter((m) => manuales.has(m)).length, sin_dato: meses.filter((m) => !(m in prom)) } } };
}

// Los ajustes vivos con importe en el período, cada uno con sus meses y quién lo cargó.
function ajustesDelPeriodo(db, desde, hasta) {
  const porId = new Map();
  // UN AJUSTE PENDIENTE NO TIENE MESES (V1070). El estado se DERIVA de no tener ninguna fila en
  // pl_abasto_ajuste_meses: sin columna nueva y sin migrar nada. El LEFT JOIN con el filtro de
  // mes EN EL ON es lo que deja pasar esas filas; el NOT EXISTS evita que se cuele un ajuste que
  // SÍ tiene importes pero fuera del período que se está mirando —ése sigue sin volver, como
  // hasta ahora—. Un pendiente, en cambio, se ve en TODOS los períodos: no tiene mes al que
  // pertenecer, y la gracia es justamente no perderlo de vista.
  const filas = db.prepare(`SELECT a.id, a.rubro, a.nombre, a.creado_en, a.modificado_en,
      uc.nombre AS creado_por, um.nombre AS modificado_por, m.mes, m.importe
    FROM pl_abasto_ajustes a
    LEFT JOIN pl_abasto_ajuste_meses m ON m.ajuste_id = a.id AND m.mes BETWEEN ? AND ?
    LEFT JOIN usuarios uc ON uc.id = a.creado_por
    LEFT JOIN usuarios um ON um.id = a.modificado_por
    WHERE a.eliminado_en IS NULL
      AND (m.mes IS NOT NULL OR NOT EXISTS (SELECT 1 FROM pl_abasto_ajuste_meses t WHERE t.ajuste_id = a.id))
    ORDER BY a.id, m.mes`).all(desde, hasta);
  for (const x of filas) {
    if (!porId.has(x.id)) {
      porId.set(x.id, { id: x.id, rubro: x.rubro, nombre: x.nombre, creado_por: x.creado_por, creado_en: x.creado_en,
        modificado_por: x.modificado_por, modificado_en: x.modificado_en, meses: {}, pendiente: 0 });
    }
    if (x.mes != null) porId.get(x.id).meses[x.mes] = x.importe;
  }
  for (const a of porId.values()) if (!Object.keys(a.meses).length) a.pendiente = 1;
  return [...porId.values()];
}

// ── ANTES DE GUARDAR: QUÉ SE VA A REEMPLAZAR ─────────────────────────────────
// Liviana: viajan el período, cuántos renglones entran y los nombres de las cuentas, no los
// renglones. La pantalla la pide apenas lee el archivo.
router.post('/previa', requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    if (!FECHA.test(String(b.desde || '')) || !FECHA.test(String(b.hasta || ''))) {
      return res.status(400).json({ ok: false, error: 'Falta el período del archivo.' });
    }
    const r = reemplazo(db, b.desde, b.hasta, b.entran, (b.cuentas && typeof b.cuentas === 'object') ? b.cuentas : {});
    res.json({ ok: true, data: Object.assign(r, { avisos: avisosDeReemplazo(r) }) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── SUBIR EL LIBRO DIARIO ────────────────────────────────────────────────────
router.post('/cargar', requireAuth, (req, res) => {
  try {
    const v = validarCarga(req.body);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    const archivo = String((req.body && req.body.archivo) || '').trim().slice(0, 200) || null;
    // UN ARCHIVO EQUIVOCADO BORRA UN PERÍODO ENTERO. Si lo delatan los avisos, no se
    // reemplaza sin que alguien lo haya confirmado (la pantalla los muestra antes).
    const avisos = avisosDeReemplazo(reemplazo(db, v.desde, v.hasta, v.renglones.length, v.cuentas));
    if (avisos.length && !(req.body && req.body.confirmar === true)) {
      return res.status(409).json({ ok: false, requiere_confirmar: 1, avisos,
        error: 'Revisá antes de reemplazar: ' + avisos.join('; ') + '.' });
    }
    let cargaId = null, reemplazados = 0;
    db.transaction(() => {
      // EL PERÍODO DEL ARCHIVO SE REEMPLAZA ENTERO: de su primera a su última fecha.
      reemplazados = db.prepare('DELETE FROM pl_abasto_movimientos WHERE fecha BETWEEN ? AND ?')
        .run(v.desde, v.hasta).changes;
      cargaId = Number(db.prepare(`INSERT INTO pl_abasto_cargas
          (archivo, desde, hasta, renglones, reemplazados, debe, haber, usuario_id)
        VALUES (?,?,?,?,?,?,?,?)`).run(archivo, v.desde, v.hasta, v.renglones.length, reemplazados,
          v.debe, v.haber, usuarioId(req)).lastInsertRowid);
      const ins = db.prepare(`INSERT INTO pl_abasto_movimientos
          (carga_id, fecha, mes, asiento, cuenta, debe, haber) VALUES (?,?,?,?,?,?,?)`);
      for (const r of v.renglones) ins.run(cargaId, r.fecha, r.mes, r.asiento, r.cuenta, r.debe, r.haber);
      // El nombre de la cuenta, el último que trajo el otro sistema.
      const cta = db.prepare(`INSERT INTO pl_abasto_cuentas (cuenta, nombre) VALUES (?,?)
        ON CONFLICT(cuenta) DO UPDATE SET nombre = excluded.nombre`);
      for (const [c, n] of Object.entries(v.cuentas)) cta.run(c, n);
    })();
    res.json({ ok: true, data: { carga_id: cargaId, archivo, desde: v.desde, hasta: v.hasta,
      renglones: v.renglones.length, reemplazados, debe: v.debe, haber: v.haber, diferencia: r2(v.debe - v.haber) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── EL CUADRO: CADA CUENTA DE RESULTADO, MES POR MES ─────────────────────────
router.get('/resultado', requireAuth, (req, res) => {
  try {
    const disponibles = db.prepare('SELECT DISTINCT mes FROM pl_abasto_movimientos ORDER BY mes').all()
      .map((x) => x.mes);
    const ultima = db.prepare(`SELECT c.id, c.archivo, c.desde, c.hasta, c.renglones, c.reemplazados,
        c.debe, c.haber, c.creado_en, u.nombre AS usuario
      FROM pl_abasto_cargas c LEFT JOIN usuarios u ON u.id = c.usuario_id
      ORDER BY c.id DESC LIMIT 1`).get() || null;
    let desde = String(req.query.desde || ''), hasta = String(req.query.hasta || '');
    if (!MES.test(desde) || !MES.test(hasta)) {
      // Sin período: los últimos doce meses que haya.
      hasta = disponibles[disponibles.length - 1] || '';
      desde = disponibles[Math.max(0, disponibles.length - 12)] || '';
    }
    if (desde > hasta) [desde, hasta] = [hasta, desde];
    const meses = disponibles.filter((m) => m >= desde && m <= hasta);
    const base = { rubros: RUBROS, meses_disponibles: disponibles, ultima_carga: ultima, desde, hasta, meses };
    if (!meses.length) return res.json({ ok: true, data: Object.assign(base, { cuentas: [], ajustes: [], cotizaciones: {} }) });

    const filas = db.prepare(`SELECT cuenta, mes, ROUND(SUM(haber) - SUM(debe), 2) AS importe
        FROM pl_abasto_movimientos WHERE mes BETWEEN ? AND ? GROUP BY cuenta, mes`).all(desde, hasta);
    const { elegidos, nombres, rubroDe, tambienVentas } = rubrosDeCuentas(db);
    const porCuenta = new Map();
    for (const f of filas) {
      // Las de resultado siempre; una del patrimonio, sólo si alguien le puso un título.
      if (!esCuentaDeResultado(f.cuenta) && rubroDe(f.cuenta) === SIN_ASIGNAR) continue;
      let c = porCuenta.get(f.cuenta);
      if (!c) {
        const nombre = nombres.get(f.cuenta) || f.cuenta;
        c = { cuenta: f.cuenta, nombre, rubro: rubroDe(f.cuenta), rubro_defecto: rubroPorDefecto(f.cuenta, nombre),
              elegido: elegidos.has(f.cuenta) ? 1 : 0, tambien_ventas: tambienVentas(f.cuenta), meses: {} };
        porCuenta.set(f.cuenta, c);
      }
      c.meses[f.mes] = f.importe;
    }
    res.json({ ok: true, data: Object.assign(base, { cuentas: [...porCuenta.values()],
      ajustes: ajustesDelPeriodo(db, desde, hasta), cotizaciones: cotizacionesDelPeriodo(db, desde, hasta) }) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── LAS CUENTAS PARA CLASIFICAR ──────────────────────────────────────────────
// Todas las de resultado que trajo alguna vez el libro diario, no sólo las del período
// que se está mirando: la clasificación es una sola.
router.get('/cuentas', requireAuth, (req, res) => {
  try {
    const totales = new Map(db.prepare(`SELECT cuenta, ROUND(SUM(haber) - SUM(debe), 2) AS importe,
        COUNT(*) AS renglones FROM pl_abasto_movimientos GROUP BY cuenta`).all().map((x) => [x.cuenta, x]));
    const { elegidos, nombres, rubroDe, tambienVentas } = rubrosDeCuentas(db);
    // TODAS LAS QUE TIENEN MOVIMIENTOS, con título o sin él, y también las del patrimonio: que
    // ninguna se pierda de vista. Pablo, 14/9/2026: «¿por qué me escondés algunos rubros, por
    // ejemplo COTO, IVA? Quiero ver todo y a lo sumo no asignar».
    const cuentas = [...nombres.keys()].filter((c) => totales.has(c)).sort().map((c) => ({
      cuenta: c, nombre: nombres.get(c), resultado: esCuentaDeResultado(c) ? 1 : 0, rubro: rubroDe(c), tambien_ventas: tambienVentas(c), rubro_defecto: rubroPorDefecto(c, nombres.get(c)),
      elegido: elegidos.has(c) ? 1 : 0,
      importe: (totales.get(c) || {}).importe || 0, renglones: (totales.get(c) || {}).renglones || 0,
    }));
    res.json({ ok: true, data: { rubros: RUBROS, cuentas } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GUARDAR LA CLASIFICACIÓN ─────────────────────────────────────────────────
router.put('/rubros', requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    const cambios = (b.rubros && typeof b.rubros === 'object') ? b.rubros : {};
    const ventas = (b.ventas && typeof b.ventas === 'object') ? b.ventas : {};
    if (!Object.keys(cambios).length && !Object.keys(ventas).length) {
      return res.status(400).json({ ok: false, error: 'No hay cambios para guardar.' });
    }
    // CUALQUIER CUENTA DEL LIBRO DIARIO, también una del patrimonio: arranca sin título y el
    // título lo decide quien clasifica.
    const conocida = db.prepare('SELECT 1 AS si FROM pl_abasto_cuentas WHERE cuenta = ?');
    for (const c of Object.keys(cambios).concat(Object.keys(ventas))) {
      if (!conocida.get(c)) {
        return res.status(400).json({ ok: false, error: 'La cuenta ' + c + ' no está en el libro diario.' });
      }
    }
    for (const r of Object.values(cambios)) {
      if (!esRubro(r)) return res.status(400).json({ ok: false, error: 'Ese rubro no existe: ' + r });
    }
    // También en VENTAS, sólo una cuenta que —con los cambios de este mismo guardado— tiene otro título.
    const { rubroDe } = rubrosDeCuentas(db);
    for (const [c, si] of Object.entries(ventas)) {
      const t = cambios[c] || rubroDe(c);
      if (si && (t === 'ventas' || t === SIN_ASIGNAR)) {
        return res.status(400).json({ ok: false,
          error: 'La cuenta ' + c + ' tiene que tener otro título para estar también en VENTAS.' });
      }
    }
    const up = db.prepare(`INSERT INTO pl_abasto_rubros (cuenta, rubro, modificado_por, modificado_en)
        VALUES (?,?,?,datetime('now','localtime'))
      ON CONFLICT(cuenta) DO UPDATE SET rubro = excluded.rubro, modificado_por = excluded.modificado_por,
        modificado_en = excluded.modificado_en`);
    const conVentas = db.prepare(`INSERT INTO pl_abasto_ventas_extra (cuenta, modificado_por, modificado_en)
        VALUES (?,?,datetime('now','localtime'))
      ON CONFLICT(cuenta) DO UPDATE SET modificado_por = excluded.modificado_por, modificado_en = excluded.modificado_en`);
    const sinVentas = db.prepare('DELETE FROM pl_abasto_ventas_extra WHERE cuenta = ?');
    db.transaction(() => {
      for (const [c, r] of Object.entries(cambios)) {
        up.run(c, r, usuarioId(req));
        // Pasarla a VENTAS como título, o sacarle el título, le saca la repetición.
        if (r === 'ventas' || r === SIN_ASIGNAR) sinVentas.run(c);
      }
      for (const [c, si] of Object.entries(ventas)) { if (si) conVentas.run(c, usuarioId(req)); else sinVentas.run(c); }
    })();
    res.json({ ok: true, data: { guardadas: Object.keys(cambios).length, ventas: Object.keys(ventas).length } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Todas las cuentas vuelven a su rubro por defecto. Es BORRAR trabajo hecho: va por DELETE,
// y exigirNivel le pide el nivel de anular, no el de operar.
router.delete('/rubros', requireAuth, (req, res) => {
  try {
    const n = db.prepare('DELETE FROM pl_abasto_rubros').run().changes;
    db.prepare('DELETE FROM pl_abasto_ventas_extra').run();
    res.json({ ok: true, data: { borradas: n } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── LAS COTIZACIONES ─────────────────────────────────────────────────────────
// Una por cada mes con movimientos, cargada o no: la ventana es la lista para completar.
router.get('/cotizaciones', requireAuth, (req, res) => {
  try {
    const guardadas = new Map(db.prepare(`SELECT c.mes, c.cotizacion, c.origen, c.tipo, c.modificado_en,
        u.nombre AS modificado_por
      FROM pl_abasto_cotizaciones c LEFT JOIN usuarios u ON u.id = c.modificado_por`).all().map((x) => [x.mes, x]));
    const meses = db.prepare('SELECT DISTINCT mes FROM pl_abasto_movimientos ORDER BY mes DESC').all().map((x) => {
      const g = guardadas.get(x.mes);
      return g ? { mes: x.mes, cotizacion: g.cotizacion, origen: g.origen, tipo: g.tipo,
        modificado_por: g.modificado_por, modificado_en: g.modificado_en } : { mes: x.mes, cotizacion: null };
    });
    res.json({ ok: true, data: { tipos: TIPOS_DOLAR, meses } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// A mano: gana sobre la traída. Vacío saca la de ese mes.
router.put('/cotizaciones', requireAuth, (req, res) => {
  try {
    const v = validarCotizaciones(req.body);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    const up = db.prepare(`INSERT INTO pl_abasto_cotizaciones (mes, cotizacion, origen, tipo, modificado_por, modificado_en)
        VALUES (?,?,'manual',NULL,?,datetime('now','localtime'))
      ON CONFLICT(mes) DO UPDATE SET cotizacion = excluded.cotizacion, origen = 'manual', tipo = NULL,
        modificado_por = excluded.modificado_por, modificado_en = excluded.modificado_en`);
    const del = db.prepare('DELETE FROM pl_abasto_cotizaciones WHERE mes = ?');
    db.transaction(() => {
      for (const [m, x] of Object.entries(v.meses)) { if (x == null) del.run(m); else up.run(m, x, usuarioId(req)); }
    })();
    res.json({ ok: true, data: { guardadas: Object.keys(v.meses).length } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/cotizaciones/traer', requireAuth, (req, res) => {
  traerCotizaciones(db, String((req.body && req.body.tipo) || ''), usuarioId(req), fetch)
    .then((r) => res.status(r.status).json(r.body))
    .catch((e) => res.status(500).json({ ok: false, error: e.message }));
});

// ── CARGAR, CORREGIR Y ELIMINAR UN AJUSTE MANUAL ─────────────────────────────
router.post('/ajustes', requireAuth, (req, res) => {
  try {
    const v = validarAjuste(req.body);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    // NACER PENDIENTE ES A PROPÓSITO, NO UN DESCUIDO (V1070): hay que pedirlo. Sin la bandera,
    // un alta sin importes sigue siendo el error de siempre —alguien que se olvidó de escribir—.
    // Y si vienen importes, gana lo cargado: la bandera se ignora.
    const pendiente = !!(req.body && req.body.pendiente);
    if (!Object.values(v.meses).some((x) => x != null) && !pendiente) {
      return res.status(400).json({ ok: false, error: 'Cargá el importe de al menos un mes.' });
    }
    let id = null;
    db.transaction(() => {
      id = Number(db.prepare('INSERT INTO pl_abasto_ajustes (rubro, nombre, creado_por) VALUES (?,?,?)')
        .run(v.rubro, v.nombre, usuarioId(req)).lastInsertRowid);
      escribirMesesDeAjuste(db, id, v.meses);
    })();
    res.json({ ok: true, data: { id } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.put('/ajustes/:id', requireAuth, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!ajusteVivo(db, id)) return res.status(404).json({ ok: false, error: 'Ese ajuste no existe o ya fue eliminado.' });
    const v = validarAjuste(req.body);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    // VACIAR UN AJUSTE QUE YA TENÍA IMPORTES SIGUE SIN SER LA MANERA DE SACARLO: eso sería
    // eliminarlo sin el nivel que elimina. Pero a uno que YA ESTABA PENDIENTE (V1070) se le
    // puede corregir el nombre o el rubro sin obligarlo a tener un importe que todavía no se
    // sabe: por eso el 400 mira si TENÍA algo, no si va a quedar vacío.
    const antes = new Map(db.prepare('SELECT mes, importe FROM pl_abasto_ajuste_meses WHERE ajuste_id = ?').all(id)
      .map((x) => [x.mes, x.importe]));
    const tenia = antes.size > 0;
    const quedan = new Map(antes);
    for (const [m, x] of Object.entries(v.meses)) { if (x == null) quedan.delete(m); else quedan.set(m, x); }
    if (!quedan.size && tenia) {
      return res.status(400).json({ ok: false, error: 'El ajuste quedaría sin importes: para sacarlo, eliminalo.' });
    }
    db.transaction(() => {
      db.prepare(`UPDATE pl_abasto_ajustes SET rubro = ?, nombre = ?, modificado_por = ?,
          modificado_en = datetime('now','localtime') WHERE id = ?`).run(v.rubro, v.nombre, usuarioId(req), id);
      escribirMesesDeAjuste(db, id, v.meses);
    })();
    res.json({ ok: true, data: { id, meses: quedan.size } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Eliminarlo saca del resultado algo que alguien cargó: va por DELETE, y exigirNivel le pide
// el nivel de anular. Baja lógica: queda quién y cuándo.
router.delete('/ajustes/:id', requireAuth, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!ajusteVivo(db, id)) return res.status(404).json({ ok: false, error: 'Ese ajuste no existe o ya fue eliminado.' });
    db.prepare(`UPDATE pl_abasto_ajustes SET eliminado_por = ?, eliminado_en = datetime('now','localtime')
      WHERE id = ?`).run(usuarioId(req), id);
    res.json({ ok: true, data: { id } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── LO QUE NO BALANCEA ───────────────────────────────────────────────────────
// Los días en que el debe y el haber no dan igual y, en cada uno, los asientos sin pareja
// que explican la diferencia, con sus renglones (ver asientosSinPareja).
router.get('/no-balancea', requireAuth, (req, res) => {
  try {
    const disponibles = db.prepare('SELECT DISTINCT mes FROM pl_abasto_movimientos ORDER BY mes').all()
      .map((x) => x.mes);
    let desde = String(req.query.desde || ''), hasta = String(req.query.hasta || '');
    // Sin período, todo lo cargado: es una lista y no columnas, no hay tope de meses.
    if (!MES.test(desde) || !MES.test(hasta)) {
      desde = disponibles[0] || '';
      hasta = disponibles[disponibles.length - 1] || '';
    }
    if (desde > hasta) [desde, hasta] = [hasta, desde];
    const t = db.prepare(`SELECT COUNT(*) AS renglones, ROUND(COALESCE(SUM(debe),0), 2) AS debe,
        ROUND(COALESCE(SUM(haber),0), 2) AS haber, ROUND(COALESCE(SUM(debe) - SUM(haber),0), 2) AS diferencia
      FROM pl_abasto_movimientos WHERE mes BETWEEN ? AND ?`).get(desde, hasta);
    const dias = db.prepare(`SELECT fecha, COUNT(*) AS renglones, ROUND(SUM(debe), 2) AS debe,
        ROUND(SUM(haber), 2) AS haber, ROUND(SUM(debe) - SUM(haber), 2) AS diferencia
      FROM pl_abasto_movimientos WHERE mes BETWEEN ? AND ?
      GROUP BY fecha HAVING ABS(SUM(debe) - SUM(haber)) >= 0.005 ORDER BY fecha DESC`).all(desde, hasta)
      .map((d) => Object.assign({}, d, { asientos: [] }));
    const porDia = new Map(dias.map((d) => [d.fecha, d]));
    let noCierran = 0, emparejados = 0, sinPareja = 0, recortado = 0;
    if (dias.length) {
      // Sólo los días que no balancean: en uno que da cero, lo que no cierra se compensa.
      const asientos = db.prepare(`SELECT asiento, fecha, COUNT(*) AS renglones, ROUND(SUM(debe), 2) AS debe,
          ROUND(SUM(haber), 2) AS haber
        FROM pl_abasto_movimientos WHERE mes BETWEEN ? AND ?
        GROUP BY asiento, fecha HAVING ABS(SUM(debe) - SUM(haber)) >= 0.005`).all(desde, hasta)
        .filter((a) => porDia.has(a.fecha));
      noCierran = asientos.length;
      const p = asientosSinPareja(asientos);
      emparejados = p.emparejados;
      sinPareja = p.solos.length;
      const solos = p.solos.slice(0, NB_MAX);
      recortado = sinPareja > solos.length ? 1 : 0;
      const renglones = new Map();
      for (let i = 0; i < solos.length; i += 400) {
        const lote = solos.slice(i, i + 400);
        const donde = lote.map(() => '(m.asiento = ? AND m.fecha = ?)').join(' OR ');
        const filas = db.prepare(`SELECT m.asiento, m.fecha, m.cuenta, COALESCE(c.nombre, m.cuenta) AS nombre,
            m.debe, m.haber
          FROM pl_abasto_movimientos m LEFT JOIN pl_abasto_cuentas c ON c.cuenta = m.cuenta
          WHERE ${donde} ORDER BY m.id`).all(...lote.flatMap((a) => [a.asiento, a.fecha]));
        for (const r of filas) {
          const k = r.asiento + '|' + r.fecha;
          if (!renglones.has(k)) renglones.set(k, []);
          renglones.get(k).push({ cuenta: r.cuenta, nombre: r.nombre, debe: r.debe, haber: r.haber });
        }
      }
      for (const a of solos) {
        porDia.get(a.fecha).asientos.push(Object.assign({}, a, { diferencia: r2(a.debe - a.haber),
          renglones: renglones.get(a.asiento + '|' + a.fecha) || [] }));
      }
    }
    res.json({ ok: true, data: { meses_disponibles: disponibles, desde, hasta, total: t, dias,
      no_cierran: noCierran, emparejados, sin_pareja: sinPareja, recortado } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── UN ASIENTO ENTERO ────────────────────────────────────────────────────────
// V1061. Pablo, 15/9/2026, mirando los asientos de un importe: «aquí sería bueno que me muestre el
// asiento completo». Todos sus renglones —los del patrimonio también— con sus totales. Un asiento
// es su número y su fecha, como en la contrapartida.
router.get('/asiento', requireAuth, (req, res) => {
  try {
    const asiento = String(req.query.asiento || '').trim(), fecha = String(req.query.fecha || '');
    if (!asiento || !FECHA.test(fecha)) return res.status(400).json({ ok: false, error: 'Falta el asiento o su fecha.' });
    const renglones = db.prepare(`SELECT m.cuenta, COALESCE(c.nombre, m.cuenta) AS nombre, m.debe, m.haber
      FROM pl_abasto_movimientos m LEFT JOIN pl_abasto_cuentas c ON c.cuenta = m.cuenta
      WHERE m.asiento = ? AND m.fecha = ? ORDER BY m.id`).all(asiento, fecha)
      .map((x) => ({ cuenta: x.cuenta, nombre: x.nombre, debe: x.debe, haber: x.haber }));
    if (!renglones.length) return res.status(404).json({ ok: false, error: 'Ese asiento no está en el libro diario cargado.' });
    const debe = r2(renglones.reduce((s, x) => s + (Number(x.debe) || 0), 0));
    const haber = r2(renglones.reduce((s, x) => s + (Number(x.haber) || 0), 0));
    res.json({ ok: true, data: { asiento, fecha, renglones, debe, haber, diferencia: r2(debe - haber) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── LOS ASIENTOS DE UN IMPORTE ───────────────────────────────────────────────
router.get('/detalle', requireAuth, (req, res) => {
  try {
    const desde = String(req.query.desde || ''), hasta = String(req.query.hasta || '');
    if (!MES.test(desde) || !MES.test(hasta)) return res.status(400).json({ ok: false, error: 'Falta el período.' });
    let cuentas = [];
    const { rubroDe, tambienVentas } = rubrosDeCuentas(db);
    if (req.query.cuenta) {
      const c = String(req.query.cuenta);
      // Las que están en el cuadro: las de resultado, y una del patrimonio con título.
      if (!esCuentaDeResultado(c) && rubroDe(c) === SIN_ASIGNAR) {
        return res.status(400).json({ ok: false, error: 'Esa cuenta no está en el cuadro.' });
      }
      cuentas = [c];
    } else if (esRubro(req.query.rubro) && req.query.rubro !== SIN_ASIGNAR) {
      cuentas = db.prepare('SELECT DISTINCT cuenta FROM pl_abasto_movimientos WHERE mes BETWEEN ? AND ?')
        .all(desde, hasta).map((x) => x.cuenta)
        .filter((c) => rubroDe(c) === req.query.rubro || (req.query.rubro === 'ventas' && tambienVentas(c)));
    } else {
      return res.status(400).json({ ok: false, error: 'Falta la cuenta o el rubro.' });
    }
    const vacio = { renglones: 0, debe: 0, haber: 0 };
    if (!cuentas.length) return res.json({ ok: true, data: { filas: [], total: vacio, recortado: 0 } });
    const q = cuentas.map(() => '?').join(',');
    const donde = `m.mes BETWEEN ? AND ? AND m.cuenta IN (${q})`;
    const total = db.prepare(`SELECT COUNT(*) AS renglones, ROUND(COALESCE(SUM(m.debe),0), 2) AS debe,
        ROUND(COALESCE(SUM(m.haber),0), 2) AS haber
      FROM pl_abasto_movimientos m WHERE ${donde}`).get(desde, hasta, ...cuentas);
    const filas = db.prepare(`SELECT m.fecha, m.asiento, m.cuenta, COALESCE(c.nombre, m.cuenta) AS nombre,
        m.debe, m.haber
      FROM pl_abasto_movimientos m LEFT JOIN pl_abasto_cuentas c ON c.cuenta = m.cuenta
      WHERE ${donde} ORDER BY m.fecha DESC, m.id DESC LIMIT ${DETALLE_MAX}`).all(desde, hasta, ...cuentas);
    contrapartidas(db, filas);
    marcarSinPareja(db, filas);
    res.json({ ok: true, data: { filas, total, recortado: total.renglones > filas.length ? 1 : 0 } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
