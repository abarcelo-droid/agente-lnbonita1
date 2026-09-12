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
// ensure_api_prefijos.js y con la lectura controlada en permisos.js): 'ver' mira, subir
// el diario y guardar los rubros pide 'operar'.
import express from 'express';
import db from '../servicios/db.js';
import { RUBROS, SIN_ASIGNAR, esRubro, esCuentaDeResultado, rubroPorDefecto, validarCarga,
  avisosDeReemplazo } from '../servicios/pl_abasto.js';

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
`);

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
// Los asientos de un importe, a lo sumo. Los de VENTAS de un mes son más de mil: se
// muestran los más recientes, y el total es siempre de todos.
const DETALLE_MAX = 1000;

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
  return { elegidos, nombres, rubroDe };
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
    if (!meses.length) return res.json({ ok: true, data: Object.assign(base, { cuentas: [] }) });

    const filas = db.prepare(`SELECT cuenta, mes, ROUND(SUM(haber) - SUM(debe), 2) AS importe
        FROM pl_abasto_movimientos WHERE mes BETWEEN ? AND ? GROUP BY cuenta, mes`).all(desde, hasta);
    const { elegidos, nombres, rubroDe } = rubrosDeCuentas(db);
    const porCuenta = new Map();
    for (const f of filas) {
      if (!esCuentaDeResultado(f.cuenta)) continue;
      let c = porCuenta.get(f.cuenta);
      if (!c) {
        const nombre = nombres.get(f.cuenta) || f.cuenta;
        c = { cuenta: f.cuenta, nombre, rubro: rubroDe(f.cuenta), rubro_defecto: rubroPorDefecto(f.cuenta, nombre),
              elegido: elegidos.has(f.cuenta) ? 1 : 0, meses: {} };
        porCuenta.set(f.cuenta, c);
      }
      c.meses[f.mes] = f.importe;
    }
    res.json({ ok: true, data: Object.assign(base, { cuentas: [...porCuenta.values()] }) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── LAS CUENTAS PARA CLASIFICAR ──────────────────────────────────────────────
// Todas las de resultado que trajo alguna vez el libro diario, no sólo las del período
// que se está mirando: la clasificación es una sola.
router.get('/cuentas', requireAuth, (req, res) => {
  try {
    const totales = new Map(db.prepare(`SELECT cuenta, ROUND(SUM(haber) - SUM(debe), 2) AS importe,
        COUNT(*) AS renglones FROM pl_abasto_movimientos GROUP BY cuenta`).all().map((x) => [x.cuenta, x]));
    const { elegidos, nombres, rubroDe } = rubrosDeCuentas(db);
    const cuentas = [...nombres.keys()].filter(esCuentaDeResultado).sort().map((c) => ({
      cuenta: c, nombre: nombres.get(c), rubro: rubroDe(c), rubro_defecto: rubroPorDefecto(c, nombres.get(c)),
      elegido: elegidos.has(c) ? 1 : 0,
      importe: (totales.get(c) || {}).importe || 0, renglones: (totales.get(c) || {}).renglones || 0,
    }));
    res.json({ ok: true, data: { rubros: RUBROS, cuentas } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GUARDAR LA CLASIFICACIÓN ─────────────────────────────────────────────────
router.put('/rubros', requireAuth, (req, res) => {
  try {
    const cambios = (req.body && req.body.rubros && typeof req.body.rubros === 'object') ? req.body.rubros : null;
    if (!cambios || !Object.keys(cambios).length) {
      return res.status(400).json({ ok: false, error: 'No hay cambios para guardar.' });
    }
    for (const [c, r] of Object.entries(cambios)) {
      if (!esCuentaDeResultado(c)) {
        return res.status(400).json({ ok: false, error: 'La cuenta ' + c + ' no es de resultado.' });
      }
      if (!esRubro(r)) return res.status(400).json({ ok: false, error: 'Ese rubro no existe: ' + r });
    }
    const up = db.prepare(`INSERT INTO pl_abasto_rubros (cuenta, rubro, modificado_por, modificado_en)
        VALUES (?,?,?,datetime('now','localtime'))
      ON CONFLICT(cuenta) DO UPDATE SET rubro = excluded.rubro, modificado_por = excluded.modificado_por,
        modificado_en = excluded.modificado_en`);
    db.transaction(() => { for (const [c, r] of Object.entries(cambios)) up.run(c, r, usuarioId(req)); })();
    res.json({ ok: true, data: { guardadas: Object.keys(cambios).length } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Todas las cuentas vuelven a su rubro por defecto. Es BORRAR trabajo hecho: va por DELETE,
// y exigirNivel le pide el nivel de anular, no el de operar.
router.delete('/rubros', requireAuth, (req, res) => {
  try {
    const n = db.prepare('DELETE FROM pl_abasto_rubros').run().changes;
    res.json({ ok: true, data: { borradas: n } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── LOS ASIENTOS DE UN IMPORTE ───────────────────────────────────────────────
router.get('/detalle', requireAuth, (req, res) => {
  try {
    const desde = String(req.query.desde || ''), hasta = String(req.query.hasta || '');
    if (!MES.test(desde) || !MES.test(hasta)) return res.status(400).json({ ok: false, error: 'Falta el período.' });
    let cuentas = [];
    if (req.query.cuenta) {
      const c = String(req.query.cuenta);
      if (!esCuentaDeResultado(c)) return res.status(400).json({ ok: false, error: 'Esa cuenta no es de resultado.' });
      cuentas = [c];
    } else if (esRubro(req.query.rubro) && req.query.rubro !== SIN_ASIGNAR) {
      const { rubroDe } = rubrosDeCuentas(db);
      cuentas = db.prepare('SELECT DISTINCT cuenta FROM pl_abasto_movimientos WHERE mes BETWEEN ? AND ?')
        .all(desde, hasta).map((x) => x.cuenta)
        .filter((c) => esCuentaDeResultado(c) && rubroDe(c) === req.query.rubro);
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
    res.json({ ok: true, data: { filas, total, recortado: total.renglones > filas.length ? 1 : 0 } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
