// src/rutas/share.js
// ── SHARE — NUESTRA PARTICIPACIÓN EN EL CD DE CARREFOUR ───────────────────────────────
// Carrefour publica todos los días qué le compra a cada uno de sus ~41 proveedores de frutas
// y verduras. Nosotros somos uno. Acá se contesta: cuánto compra, a quién, y dónde no
// estamos.
//
// TODO ES VOLUMEN EN BULTOS. El archivo no trae ni un peso: no hay facturación, ni costo, ni
// margen, y tampoco entregas reales — es lo PLANIFICADO. Cualquier número con signo pesos en
// esta pantalla estaría inventado.
//
// ── LAS DOS REGLAS QUE NO SE NEGOCIAN ─────────────────────────────────────────────────
// 1. Se lee de la vista share_v, NUNCA de share_lineas. La vista excluye las cargas
//    reemplazadas; sin ella, un día recargado se cuenta dos veces. Y el error es invisible:
//    el share sigue dando bien porque se duplican numerador y denominador.
// 2. Nosotros somos share_proveedores.es_nosotros = 1, nunca el literal 'SAN GERONIMO S.A.'.
//    El día que la planilla lo escriba distinto, con el literal el share se iría a cero sin
//    que nadie se entere.
//
// ── BULTOS Y KILOS NO SON LO MISMO ────────────────────────────────────────────────────
// El share POR ARTÍCULO se mide en bultos: todos los proveedores entregan el mismo DESC en la
// misma unidad, así que son comparables. Los kilos (kg_equiv) sirven SÓLO para sumar
// artículos distintos entre sí, y no todos se pueden convertir — un atado de acelga no tiene
// peso conocido. Por eso cada agregado en kilos viaja con cuántos bultos quedaron afuera: un
// total en kilos incompleto se ve idéntico a uno completo.
import express from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import db from '../servicios/db_share.js';
import { importar, analizar, recalcularKg, analizarOferta, importarOferta } from '../servicios/share_import.js';
import { norm, FAMILIAS_VALIDAS, parseOfertaTexto, parseOfertaExcel, parseBultos } from '../servicios/share_parser.js';
import { nivelEnModulo } from '../servicios/permisos.js';

const router = express.Router();

// El planning son ~430 filas: entra holgado en memoria y así no quedan .xlsx sueltos en el
// disco de Railway, que además no persiste entre deploys.
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Mismo requireAuth que el resto de los routers, letra por letra: si acá leyera la cookie de
// otra forma, este módulo tendría su propia idea de quién está adentro.
function requireAuth(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try { req.user = JSON.parse(cookie); next(); }
  catch (e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

const MODULO = 'share';
const ORDEN = { ver: 1, operar: 2, borrar: 3, anular: 3 };
const puedeOperar = (u) => (ORDEN[nivelEnModulo(u, MODULO)] || 0) >= 2;

// ── Semana ISO en SQL ─────────────────────────────────────────────────────────────────
// SQLite no tiene función de semana ISO (%W cuenta desde el primer domingo y no coincide).
// date(f,'-3 days','weekday 4') devuelve el JUEVES de la semana ISO de f, y el año y el
// número de semana salen de ese jueves — que es exactamente la definición del estándar.
// Verificado contra los bordes: 2025-12-29 cae en 2026-W01 y 2027-01-03 en 2026-W53.
const JUE = (c) => `date(${c},'-3 days','weekday 4')`;
const SEM = (c) => `(strftime('%Y', ${JUE(c)}) || '-W' || substr('0' || ((CAST(strftime('%j', ${JUE(c)}) AS INTEGER)-1)/7+1), -2))`;

// ── Rango de fechas ───────────────────────────────────────────────────────────────────
// Si no piden fechas, los últimos 30 días CON DATOS, no los últimos 30 del calendario: si
// hace una semana que nadie carga un planning, el default mostraría una caída a cero que no
// existe.
function rangoBase() {
  const r = db.prepare('SELECT MIN(fecha_entrega) min, MAX(fecha_entrega) max FROM share_v').get() || {};
  return { min: r.min || null, max: r.max || null };
}
function resolverRango(q) {
  const base = rangoBase();
  if (!base.max) return { desde: null, hasta: null, ...base };
  const hasta = String(q.hasta || '').match(/^\d{4}-\d{2}-\d{2}$/) ? q.hasta : base.max;
  let desde = String(q.desde || '').match(/^\d{4}-\d{2}-\d{2}$/) ? q.desde : null;
  if (!desde) {
    const d = new Date(hasta + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 29);
    desde = d.toISOString().slice(0, 10);
  }
  if (desde > hasta) desde = hasta;
  return { desde, hasta, ...base };
}
// El período inmediatamente anterior, del mismo largo. Es contra lo que se compara todo.
function periodoAnterior(desde, hasta) {
  const d0 = Date.parse(desde + 'T00:00:00Z'), d1 = Date.parse(hasta + 'T00:00:00Z');
  const largo = Math.round((d1 - d0) / 86400000) + 1;
  const pHasta = new Date(d0 - 86400000), pDesde = new Date(d0 - largo * 86400000);
  return { desde: pDesde.toISOString().slice(0, 10), hasta: pHasta.toISOString().slice(0, 10), dias: largo };
}

// ── Padrones en memoria ───────────────────────────────────────────────────────────────
// Son ~41 proveedores y unos cientos de artículos: traerlos enteros y cruzar en JS es más
// simple y más rápido que un JOIN por cada una de las siete pantallas.
function padrones() {
  const arts = new Map();
  for (const a of db.prepare('SELECT * FROM share_articulos').all()) arts.set(a.id, a);
  const provs = new Map();
  for (const p of db.prepare('SELECT * FROM share_proveedores').all()) provs.set(p.id, p);
  return { arts, provs };
}

// ── LA AGREGACIÓN QUE USAN CASI TODAS LAS PANTALLAS ───────────────────────────────────
// Una sola consulta por artículo y proveedor dentro del rango, y de ahí salen el dashboard,
// la tabla de participación, oportunidades, huecos y competencia. Escribir siete consultas
// distintas para lo mismo es la forma segura de que den siete números distintos.
function agregar(desde, hasta) {
  const { arts, provs } = padrones();
  const filas = db.prepare(`
    SELECT articulo_id AS aid, proveedor_id AS pid,
           SUM(bultos) AS bultos, SUM(kg_equiv) AS kg,
           COUNT(DISTINCT fecha_entrega) AS dias
      FROM share_v
     WHERE fecha_entrega BETWEEN ? AND ?
     GROUP BY articulo_id, proveedor_id`).all(desde, hasta);

  // Los días en que Carrefour compró CADA artículo (sin importar a quién). No se puede
  // deducir sumando los días por proveedor: dos proveedores el mismo día darían 2.
  const diasArt = new Map();
  for (const r of db.prepare(`SELECT articulo_id aid, COUNT(DISTINCT fecha_entrega) d
      FROM share_v WHERE fecha_entrega BETWEEN ? AND ? GROUP BY articulo_id`).all(desde, hasta))
    diasArt.set(r.aid, r.d);

  const porArt = new Map();
  for (const r of filas) {
    const p = provs.get(r.pid) || {};
    let x = porArt.get(r.aid);
    if (!x) {
      const a = arts.get(r.aid) || {};
      x = {
        id: r.aid, desc: a.desc_canonica || '(sin nombre)', base: a.articulo_base,
        familia: a.familia || 'OTRO', rubro: a.rubro || null, unidad: a.unidad,
        factor_kg: a.factor_kg, la_vendemos: a.la_vendemos ? 1 : 0,
        pendiente: a.pendiente_revision ? 1 : 0,
        total: 0, nuestros: 0, import_propia: 0, kg: 0, kg_falta: 0,
        dias: diasArt.get(r.aid) || 0, nuestros_dias: 0, provs: [],
      };
      porArt.set(r.aid, x);
    }
    x.total += r.bultos;
    if (p.es_nosotros) { x.nuestros += r.bultos; x.nuestros_dias = r.dias; }
    if (p.tipo === 'importacion_propia') x.import_propia += r.bultos;
    if (r.kg == null) x.kg_falta += r.bultos; else x.kg += r.kg;
    x.provs.push({ id: r.pid, nombre: p.nombre_canonico || '(sin nombre)', tipo: p.tipo, es_nosotros: p.es_nosotros ? 1 : 0, bultos: r.bultos, dias: r.dias });
  }

  // Ranking, líder y concentración por artículo.
  for (const x of porArt.values()) {
    x.provs.sort((a, b) => b.bultos - a.bultos);
    const lider = x.provs[0] || null;
    x.lider = lider ? lider.nombre : null;
    x.lider_share = lider && x.total ? lider.bultos / x.total : null;
    x.lider_es_nuestro = lider ? lider.es_nosotros : 0;
    x.proveedores = x.provs.length;
    x.share = x.total ? x.nuestros / x.total : 0;
    x.share_import_propia = x.total ? x.import_propia / x.total : 0;
    x.no_capturado = x.total - x.nuestros;
    const i = x.provs.findIndex(p => p.es_nosotros);
    x.ranking = i < 0 ? null : i + 1;
    // HHI: la suma de los cuadrados de las participaciones. Cerca de 1 = un solo proveedor se
    // lo lleva todo (difícil entrar); cerca de 0 = muy repartido (fácil).
    x.hhi = x.total ? x.provs.reduce((s, p) => s + Math.pow(p.bultos / x.total, 2), 0) : 0;
  }
  return { porArt, arts, provs };
}

// Los KPI de cabecera a partir de la agregación.
function totales(porArt) {
  let total = 0, nuestros = 0, ip = 0, kg = 0, kgFalta = 0;
  for (const x of porArt.values()) { total += x.total; nuestros += x.nuestros; ip += x.import_propia; kg += x.kg; kgFalta += x.kg_falta; }
  return {
    bultos_total: total, bultos_nuestros: nuestros, bultos_import_propia: ip,
    share: total ? nuestros / total : 0,
    share_import_propia: total ? ip / total : 0,
    articulos: porArt.size,
    kg_equiv: kg, bultos_sin_convertir: kgFalta,
  };
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ══════════════════════════════════════════════════════════════════════════════════════
// CARGA
// ══════════════════════════════════════════════════════════════════════════════════════

// Sube un .xlsx. Sin ?confirmar=1 es SÓLO PREVIEW: dice qué va a pasar y no escribe nada.
// Se pide el archivo dos veces (una para mirar, otra para confirmar) a propósito: guardarlo
// entre las dos llamadas obligaría a un temporal en disco, y el disco de Railway no persiste.
router.post('/cargas', requireAuth, subida.single('archivo'), (req, res) => {
  try {
    if (!puedeOperar(req.user)) return res.status(403).json({ ok: false, error: 'Tu acceso a SHARE es de solo lectura.' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No llegó ningún archivo.' });
    const nombre = req.file.originalname || 'planning.xlsx';
    const confirmar = String(req.query.confirmar || '') === '1';

    if (!confirmar) {
      const a = analizar(db, { buffer: req.file.buffer, nombre });
      delete a._filas;
      return res.json({ ok: true, preview: true, data: a });
    }
    const r = importar(db, {
      buffer: req.file.buffer, nombre,
      usuario: req.user?.nombre || null, usuarioId: req.user?.id || null,
      forzar: String(req.query.forzar || '') === '1',
    });
    if (r.analisis) delete r.analisis._filas;
    if (!r.ok) return res.status(409).json(r);
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.get('/cargas', requireAuth, (req, res) => {
  try {
    const filas = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM share_lineas l WHERE l.carga_id=c.id) AS lineas
        FROM share_cargas c ORDER BY c.fecha_entrega DESC, c.id DESC LIMIT 400`).all();
    for (const f of filas) { try { f.warnings = JSON.parse(f.warnings || '{}'); } catch { f.warnings = {}; } }
    res.json({ ok: true, data: filas, rango: rangoBase() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Baja lógica. NO se borran las líneas: si mañana se descubre que la carga estaba bien, se
// vuelve atrás. Y las consultas ya la excluyen por la vista.
router.delete('/cargas/:id', requireAuth, (req, res) => {
  try {
    if (!puedeOperar(req.user)) return res.status(403).json({ ok: false, error: 'Tu acceso a SHARE es de solo lectura.' });
    const r = db.prepare("UPDATE share_cargas SET estado='reemplazada', reemplazada_en=datetime('now','localtime') WHERE id=? AND estado='activa'").run(req.params.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'No existe o ya estaba dada de baja.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/cargas/:id/reactivar', requireAuth, (req, res) => {
  try {
    if (!puedeOperar(req.user)) return res.status(403).json({ ok: false, error: 'Tu acceso a SHARE es de solo lectura.' });
    const c = db.prepare('SELECT * FROM share_cargas WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'No existe.' });
    // Reactivar una carga cuyas fechas ya cubre otra activa duplicaría los bultos de esos
    // días, que es justo lo que la vista existe para evitar.
    const choca = db.prepare(`SELECT c2.id, c2.archivo_nombre FROM share_cargas c2
       WHERE c2.estado='activa' AND c2.id<>? AND EXISTS (
         SELECT 1 FROM share_lineas a JOIN share_lineas b ON a.fecha_entrega=b.fecha_entrega
          WHERE a.carga_id=c2.id AND b.carga_id=?) LIMIT 1`).get(c.id, c.id);
    if (choca) return res.status(409).json({ ok: false, error: `No se puede: la carga #${choca.id} (${choca.archivo_nombre}) ya cubre esas fechas.` });
    db.prepare("UPDATE share_cargas SET estado='activa', reemplazada_por=NULL, reemplazada_en=NULL WHERE id=?").run(c.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════════════

router.get('/resumen', requireAuth, (req, res) => {
  try {
    const { desde, hasta, min, max } = resolverRango(req.query);
    if (!desde) return res.json({ ok: true, data: { vacio: true, rango: { min, max } } });

    const { porArt, provs } = agregar(desde, hasta);
    const kpi = totales(porArt);

    // Contra el período anterior del mismo largo. Sin esto, "7,4% de share" no dice nada:
    // lo que importa es si viene subiendo o bajando.
    const ant = periodoAnterior(desde, hasta);
    const kpiAnt = totales(agregar(ant.desde, ant.hasta).porArt);

    // Por familia. El share de cada una se calcula sobre SU total, no sobre el general.
    const fam = new Map();
    for (const x of porArt.values()) {
      const f = x.familia || 'OTRO';
      const v = fam.get(f) || { familia: f, total: 0, nuestros: 0, articulos: 0 };
      v.total += x.total; v.nuestros += x.nuestros; v.articulos++;
      fam.set(f, v);
    }
    const familias = [...fam.values()].map(v => ({ ...v, total: r2(v.total), nuestros: r2(v.nuestros), share: v.total ? v.nuestros / v.total : 0 }))
      .sort((a, b) => b.total - a.total);

    // Top 10 por volumen, con nuestra parte en cada uno.
    const top = [...porArt.values()].sort((a, b) => b.total - a.total).slice(0, 10)
      // lider_es_nuestro viaja también acá: la pantalla marca distinto los artículos donde el
      // líder somos nosotros, y sin este campo el Top 10 los mostraría como si los liderara
      // un competidor.
      .map(x => ({ id: x.id, desc: x.desc, familia: x.familia, total: r2(x.total), nuestros: r2(x.nuestros), share: x.share, lider: x.lider, lider_es_nuestro: x.lider_es_nuestro }));

    // Ranking de proveedores por volumen total del período.
    const acum = new Map();
    for (const x of porArt.values()) for (const p of x.provs) {
      const v = acum.get(p.id) || { id: p.id, nombre: p.nombre, tipo: p.tipo, es_nosotros: p.es_nosotros, bultos: 0, articulos: 0 };
      v.bultos += p.bultos; v.articulos++; acum.set(p.id, v);
    }
    const ranking = [...acum.values()].sort((a, b) => b.bultos - a.bultos)
      .map((p, i) => ({ ...p, bultos: r2(p.bultos), puesto: i + 1, share: kpi.bultos_total ? p.bultos / kpi.bultos_total : 0 }));
    const nuestroPuesto = ranking.find(p => p.es_nosotros);

    res.json({
      ok: true,
      data: {
        rango: { desde, hasta, min, max, dias: ant.dias },
        anterior: { desde: ant.desde, hasta: ant.hasta },
        kpi: {
          ...kpi, bultos_total: r2(kpi.bultos_total), bultos_nuestros: r2(kpi.bultos_nuestros),
          bultos_import_propia: r2(kpi.bultos_import_propia), kg_equiv: r2(kpi.kg_equiv),
          bultos_sin_convertir: r2(kpi.bultos_sin_convertir),
          proveedores: ranking.length,
          dias_con_datos: db.prepare('SELECT COUNT(DISTINCT fecha_entrega) d FROM share_v WHERE fecha_entrega BETWEEN ? AND ?').get(desde, hasta).d,
        },
        delta: {
          bultos_total: kpi.bultos_total - kpiAnt.bultos_total,
          bultos_nuestros: kpi.bultos_nuestros - kpiAnt.bultos_nuestros,
          share: kpi.share - kpiAnt.share,
          hubo_datos: kpiAnt.bultos_total > 0,
        },
        familias, top, ranking: ranking.slice(0, 45),
        nuestro_puesto: nuestroPuesto ? nuestroPuesto.puesto : null,
        proveedores_total: ranking.length,
      },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/serie', requireAuth, (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req.query);
    if (!desde) return res.json({ ok: true, data: { filas: [] } });
    const sem = String(req.query.granularidad || 'dia') === 'semana';
    const clave = sem ? SEM('fecha_entrega') : 'fecha_entrega';
    const filas = db.prepare(`
      SELECT ${clave} AS k,
             SUM(v.bultos) AS total,
             SUM(CASE WHEN p.es_nosotros=1 THEN v.bultos ELSE 0 END) AS nuestros,
             SUM(CASE WHEN p.tipo='importacion_propia' THEN v.bultos ELSE 0 END) AS import_propia,
             COUNT(DISTINCT v.fecha_entrega) AS dias
        FROM share_v v LEFT JOIN share_proveedores p ON p.id = v.proveedor_id
       WHERE v.fecha_entrega BETWEEN ? AND ?
       GROUP BY k ORDER BY k`).all(desde, hasta);
    res.json({
      ok: true,
      data: {
        granularidad: sem ? 'semana' : 'dia',
        filas: filas.map(f => ({ ...f, total: r2(f.total), nuestros: r2(f.nuestros), import_propia: r2(f.import_propia), share: f.total ? f.nuestros / f.total : 0 })),
      },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// PARTICIPACIÓN POR ARTÍCULO
// ══════════════════════════════════════════════════════════════════════════════════════

// La tendencia de las últimas 4 semanas ISO, para el sparkline. Se pide sólo para los
// artículos que se van a mostrar: pedirla para todos es una consulta enorme que nadie mira.
function tendencia4(todos, hasta) {
  const ids = (todos || []).slice(0, 400);
  if (!ids.length) return new Map();
  const d = new Date(hasta + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 27);
  const desde = d.toISOString().slice(0, 10);
  const filas = db.prepare(`
    SELECT v.articulo_id aid, ${SEM('v.fecha_entrega')} sem,
           SUM(v.bultos) total,
           SUM(CASE WHEN p.es_nosotros=1 THEN v.bultos ELSE 0 END) nuestros
      FROM share_v v LEFT JOIN share_proveedores p ON p.id=v.proveedor_id
     WHERE v.fecha_entrega BETWEEN ? AND ?
       AND v.articulo_id IN (${ids.map(() => '?').join(',')})
     GROUP BY aid, sem ORDER BY sem`).all(desde, hasta, ...ids);
  const m = new Map();
  for (const f of filas) {
    if (!m.has(f.aid)) m.set(f.aid, []);
    m.get(f.aid).push({ sem: f.sem, total: r2(f.total), nuestros: r2(f.nuestros) });
  }
  return m;
}

router.get('/articulos', requireAuth, (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req.query);
    if (!desde) return res.json({ ok: true, data: { filas: [] } });
    const { porArt } = agregar(desde, hasta);

    const q = norm(req.query.q || '');
    const familia = String(req.query.familia || '');
    const soloVendemos = String(req.query.solo_vendemos || '') === '1';
    let filas = [...porArt.values()].filter(x =>
      (!familia || x.familia === familia) &&
      (!soloVendemos || x.la_vendemos) &&
      (!q || norm(x.desc).includes(q) || norm(x.base || '').includes(q)));

    const ORDENES = {
      total: (a, b) => b.total - a.total,
      nuestros: (a, b) => b.nuestros - a.nuestros,
      share: (a, b) => b.share - a.share,
      share_asc: (a, b) => a.share - b.share,
      no_capturado: (a, b) => b.no_capturado - a.no_capturado,
      desc: (a, b) => String(a.desc).localeCompare(String(b.desc)),
    };
    filas.sort(ORDENES[String(req.query.orden || 'total')] || ORDENES.total);
    const limite = Math.min(parseInt(req.query.limite, 10) || 300, 2000);
    const totalFilas = filas.length;
    filas = filas.slice(0, limite);

    const tend = tendencia4(filas.map(f => f.id), hasta);
    res.json({
      ok: true,
      data: {
        rango: { desde, hasta },
        total_filas: totalFilas,
        familias: [...new Set([...porArt.values()].map(x => x.familia))].sort(),
        filas: filas.map(x => ({
          id: x.id, desc: x.desc, base: x.base, familia: x.familia, unidad: x.unidad,
          la_vendemos: x.la_vendemos, pendiente: x.pendiente,
          total: r2(x.total), nuestros: r2(x.nuestros), share: x.share,
          no_capturado: r2(x.no_capturado), ranking: x.ranking, proveedores: x.proveedores,
          lider: x.lider, lider_share: x.lider_share, lider_es_nuestro: x.lider_es_nuestro,
          dias: x.dias, nuestros_dias: x.nuestros_dias, hhi: x.hhi,
          tendencia: tend.get(x.id) || [],
        })),
      },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// VA ANTES DE /articulos/:id — si no, Express toma "buscar" como un id.
router.get('/articulos/buscar', requireAuth, (req, res) => {
  try {
    const q = norm(req.query.q || '');
    if (q.length < 2) return res.json({ ok: true, data: [] });
    const filas = db.prepare(`
      SELECT a.id, a.desc_canonica, a.familia, a.unidad, a.la_vendemos,
             (SELECT COALESCE(SUM(bultos),0) FROM share_v v WHERE v.articulo_id=a.id) AS bultos
        FROM share_articulos a
       WHERE a.desc_canonica LIKE ? ESCAPE '\\'
       ORDER BY bultos DESC LIMIT 30`).all('%' + q.replace(/[%_\\]/g, '\\$&') + '%');
    res.json({ ok: true, data: filas });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// El buscador semanal: la pantalla que pidió Andy explícitamente.
router.get('/articulos/:id/semanal', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const art = db.prepare('SELECT * FROM share_articulos WHERE id=?').get(id);
    if (!art) return res.status(404).json({ ok: false, error: 'No existe ese artículo.' });
    const semanas = Math.min(Math.max(parseInt(req.query.semanas, 10) || 26, 4), 104);
    const base = rangoBase();
    if (!base.max) return res.json({ ok: true, data: { articulo: art, filas: [] } });
    const hasta = String(req.query.hasta || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.hasta : base.max;
    const d = new Date(hasta + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - (semanas * 7 - 1));
    const desde = d.toISOString().slice(0, 10);

    // Una sola consulta por semana y proveedor; el resto se arma en JS.
    const filas = db.prepare(`
      SELECT ${SEM('v.fecha_entrega')} sem, v.proveedor_id pid,
             p.nombre_canonico nombre, p.es_nosotros, p.tipo,
             SUM(v.bultos) bultos, MIN(v.fecha_entrega) f0, MAX(v.fecha_entrega) f1
        FROM share_v v LEFT JOIN share_proveedores p ON p.id=v.proveedor_id
       WHERE v.articulo_id=? AND v.fecha_entrega BETWEEN ? AND ?
       GROUP BY sem, v.proveedor_id ORDER BY sem`).all(id, desde, hasta);

    const porSem = new Map();
    for (const f of filas) {
      let s = porSem.get(f.sem);
      if (!s) { s = { sem: f.sem, desde: f.f0, hasta: f.f1, total: 0, nuestros: 0, provs: [] }; porSem.set(f.sem, s); }
      s.total += f.bultos;
      if (f.es_nosotros) s.nuestros += f.bultos;
      if (f.f0 < s.desde) s.desde = f.f0;
      if (f.f1 > s.hasta) s.hasta = f.f1;
      s.provs.push({ id: f.pid, nombre: f.nombre, tipo: f.tipo, es_nosotros: f.es_nosotros ? 1 : 0, bultos: r2(f.bultos) });
    }
    const out = [...porSem.values()].sort((a, b) => a.sem.localeCompare(b.sem));
    let prev = null;
    for (const s of out) {
      s.provs.sort((a, b) => b.bultos - a.bultos);
      s.lider = s.provs[0] ? s.provs[0].nombre : null;
      s.share = s.total ? s.nuestros / s.total : 0;
      // Δ contra la semana anterior de la SERIE, no del calendario: si una semana no tuvo
      // compras no aparece, y compararla contra cero diría "cayó 100%" cuando en realidad
      // Carrefour no compró nada ese producto esa semana.
      s.delta_total = prev ? s.total - prev.total : null;
      s.delta_share = prev ? s.share - prev.share : null;
      s.total = r2(s.total); s.nuestros = r2(s.nuestros);
      prev = { total: s.total, share: s.share };
    }
    res.json({ ok: true, data: { articulo: art, rango: { desde, hasta, semanas }, filas: out } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// OPORTUNIDADES
// ══════════════════════════════════════════════════════════════════════════════════════

const VISTAS_OPO = new Set(['no_capturado', 'share_bajo', 'proveedor_unico', 'import_propia']);

router.get('/oportunidades', requireAuth, (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req.query);
    if (!desde) return res.json({ ok: true, data: { filas: [] } });
    const vista = VISTAS_OPO.has(String(req.query.vista)) ? req.query.vista : 'no_capturado';
    // Por defecto SÓLO lo que podríamos proveer: sin este filtro la lista arranca con el
    // jengibre importado y no sirve para llamar a nadie. El toggle la abre entera.
    const soloVendemos = String(req.query.solo_vendemos || '1') === '1';
    const { porArt } = agregar(desde, hasta);
    let filas = [...porArt.values()].filter(x => !soloVendemos || x.la_vendemos);

    if (vista === 'share_bajo') {
      // Estamos adentro pero pesamos poco: es más fácil crecer donde ya nos compran.
      filas = filas.filter(x => x.nuestros > 0 && x.share < 0.20);
      filas.sort((a, b) => b.no_capturado - a.no_capturado);
    } else if (vista === 'proveedor_unico') {
      // Un solo proveedor: riesgo de abastecimiento para Carrefour y puerta para nosotros.
      // Si el único somos nosotros no es una oportunidad, es lo que ya tenemos.
      filas = filas.filter(x => x.proveedores === 1 && !x.provs[0].es_nosotros);
      filas.sort((a, b) => b.total - a.total);
    } else if (vista === 'import_propia') {
      // Acá no perdemos contra un competidor: perdemos contra el propio Carrefour.
      filas = filas.filter(x => x.import_propia > 0);
      filas.sort((a, b) => b.import_propia - a.import_propia);
    } else {
      filas = filas.filter(x => x.no_capturado > 0);
      filas.sort((a, b) => b.no_capturado - a.no_capturado);
    }

    res.json({
      ok: true,
      data: {
        rango: { desde, hasta }, vista, solo_vendemos: soloVendemos ? 1 : 0,
        filas: filas.slice(0, 300).map(x => ({
          id: x.id, desc: x.desc, familia: x.familia, unidad: x.unidad, la_vendemos: x.la_vendemos,
          total: r2(x.total), nuestros: r2(x.nuestros), no_capturado: r2(x.no_capturado),
          share: x.share, import_propia: r2(x.import_propia), share_import_propia: x.share_import_propia,
          proveedores: x.proveedores, hhi: x.hhi, dias: x.dias, ranking: x.ranking,
          // A quién se lo está comprando hoy: sin esto la oportunidad no se puede trabajar.
          top3: x.provs.slice(0, 3).map(p => ({ nombre: p.nombre, bultos: r2(p.bultos), share: x.total ? p.bultos / x.total : 0, es_nosotros: p.es_nosotros, tipo: p.tipo })),
        })),
      },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// HUECOS — lo que no estamos viendo
// ══════════════════════════════════════════════════════════════════════════════════════

const TIPOS_HUECO = new Set(['duro', 'perdido', 'nuevo', 'discontinuado', 'dias_huerfanos']);

router.get('/huecos', requireAuth, (req, res) => {
  try {
    const { desde, hasta, max } = resolverRango(req.query);
    if (!desde) return res.json({ ok: true, data: { filas: [] } });
    const tipo = TIPOS_HUECO.has(String(req.query.tipo)) ? req.query.tipo : 'duro';
    const { porArt } = agregar(desde, hasta);
    let filas = [];

    if (tipo === 'duro') {
      // Volumen real y CERO nuestro en todo el período. No es "bajamos": es que ni estamos.
      filas = [...porArt.values()].filter(x => x.nuestros === 0 && x.total > 0)
        .sort((a, b) => b.total - a.total)
        .map(x => ({
          id: x.id, desc: x.desc, familia: x.familia, la_vendemos: x.la_vendemos,
          total: r2(x.total), dias: x.dias, proveedores: x.proveedores,
          lider: x.lider, lider_share: x.lider_share, hhi: x.hhi,
          top3: x.provs.slice(0, 3).map(p => ({ nombre: p.nombre, bultos: r2(p.bultos), tipo: p.tipo })),
        }));

    } else if (tipo === 'perdido') {
      // Teníamos y se cayó más del 50% contra el promedio de las 4 semanas previas. Se mira
      // en ventana de 8 semanas terminando en `hasta`: 4 recientes contra 4 anteriores.
      const d = new Date(hasta + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 55);
      const ini = d.toISOString().slice(0, 10);
      const corte = new Date(hasta + 'T00:00:00Z'); corte.setUTCDate(corte.getUTCDate() - 27);
      const isoCorte = corte.toISOString().slice(0, 10);

      const q = db.prepare(`
        SELECT v.articulo_id aid, v.proveedor_id pid, p.nombre_canonico nombre, p.es_nosotros,
               SUM(CASE WHEN v.fecha_entrega >= ? THEN v.bultos ELSE 0 END) recientes,
               SUM(CASE WHEN v.fecha_entrega <  ? THEN v.bultos ELSE 0 END) previas,
               MAX(CASE WHEN p.es_nosotros=1 THEN v.fecha_entrega END) ultima_nuestra
          FROM share_v v LEFT JOIN share_proveedores p ON p.id=v.proveedor_id
         WHERE v.fecha_entrega BETWEEN ? AND ?
         GROUP BY v.articulo_id, v.proveedor_id`).all(isoCorte, isoCorte, ini, hasta);

      const m = new Map();
      for (const r of q) {
        let x = m.get(r.aid);
        if (!x) { x = { aid: r.aid, nuestrosRec: 0, nuestrosPrev: 0, totalRec: 0, totalPrev: 0, ultima: null, provs: [] }; m.set(r.aid, x); }
        x.totalRec += r.recientes; x.totalPrev += r.previas;
        if (r.es_nosotros) { x.nuestrosRec += r.recientes; x.nuestrosPrev += r.previas; x.ultima = r.ultima_nuestra; }
        x.provs.push({ nombre: r.nombre, es_nosotros: r.es_nosotros ? 1 : 0, crecio: r.recientes - r.previas });
      }
      const { arts } = padrones();
      filas = [...m.values()]
        .filter(x => x.nuestrosPrev > 0 && x.nuestrosRec < x.nuestrosPrev * 0.5)
        .map(x => {
          const a = arts.get(x.aid) || {};
          // QUIÉN NOS DESPLAZÓ: el proveedor que más creció en la misma ventana. Sin esto el
          // aviso dice que caímos y no contra quién, que es lo único accionable.
          const gano = x.provs.filter(p => !p.es_nosotros && p.crecio > 0).sort((a2, b2) => b2.crecio - a2.crecio)[0];
          return {
            id: x.aid, desc: a.desc_canonica, familia: a.familia, la_vendemos: a.la_vendemos ? 1 : 0,
            nuestros_previos: r2(x.nuestrosPrev), nuestros_recientes: r2(x.nuestrosRec),
            caida: x.nuestrosPrev ? (x.nuestrosRec - x.nuestrosPrev) / x.nuestrosPrev : null,
            total_previo: r2(x.totalPrev), total_reciente: r2(x.totalRec),
            // Si el mercado entero cayó igual, no nos sacaron nada: se achicó la compra.
            mercado_cayo: x.totalPrev ? (x.totalRec - x.totalPrev) / x.totalPrev : null,
            ultima_venta: x.ultima,
            desplazo: gano ? gano.nombre : null, desplazo_crecio: gano ? r2(gano.crecio) : null,
          };
        })
        .sort((a, b) => (b.nuestros_previos - b.nuestros_recientes) - (a.nuestros_previos - a.nuestros_recientes));

    } else if (tipo === 'nuevo') {
      // Apareció por primera vez en TODA la base hace poco: Carrefour sumó un producto.
      const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 365);
      const d = new Date((max || hasta) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - dias);
      const corte = d.toISOString().slice(0, 10);
      filas = db.prepare(`
        SELECT a.id, a.desc_canonica AS desc, a.familia, a.la_vendemos,
               MIN(v.fecha_entrega) primera, MAX(v.fecha_entrega) ultima,
               SUM(v.bultos) total,
               SUM(CASE WHEN p.es_nosotros=1 THEN v.bultos ELSE 0 END) nuestros,
               COUNT(DISTINCT v.proveedor_id) proveedores
          FROM share_v v JOIN share_articulos a ON a.id=v.articulo_id
          LEFT JOIN share_proveedores p ON p.id=v.proveedor_id
         GROUP BY a.id HAVING primera >= ?
         ORDER BY total DESC LIMIT 300`).all(corte);
      filas = filas.map(f => ({ ...f, total: r2(f.total), nuestros: r2(f.nuestros), share: f.total ? f.nuestros / f.total : 0 }));

    } else if (tipo === 'discontinuado') {
      // Venía con volumen y hace más de N días que no aparece.
      const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 14, 1), 365);
      const d = new Date((max || hasta) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - dias);
      const corte = d.toISOString().slice(0, 10);
      filas = db.prepare(`
        SELECT a.id, a.desc_canonica AS desc, a.familia, a.la_vendemos,
               MAX(v.fecha_entrega) ultima, COUNT(DISTINCT v.fecha_entrega) dias_con_compra,
               SUM(v.bultos) total,
               SUM(CASE WHEN p.es_nosotros=1 THEN v.bultos ELSE 0 END) nuestros
          FROM share_v v JOIN share_articulos a ON a.id=v.articulo_id
          LEFT JOIN share_proveedores p ON p.id=v.proveedor_id
         GROUP BY a.id
        HAVING ultima < ? AND dias_con_compra >= 3
         ORDER BY total DESC LIMIT 300`).all(corte);
      filas = filas.map(f => ({
        ...f, total: r2(f.total), nuestros: r2(f.nuestros),
        share: f.total ? f.nuestros / f.total : 0,
        dias_sin_aparecer: Math.round((Date.parse((max || hasta) + 'T00:00:00Z') - Date.parse(f.ultima + 'T00:00:00Z')) / 86400000),
      }));

    } else {
      // DÍAS HUÉRFANOS: días en que Carrefour compró un artículo que nosotros SÍ proveemos y
      // ese día no le vendimos nada. Mide consistencia, no volumen: podés tener 40% de share
      // del mes y haberte perdido la mitad de los días.
      const q = db.prepare(`
        SELECT v.articulo_id aid, v.fecha_entrega f,
               SUM(v.bultos) total,
               SUM(CASE WHEN p.es_nosotros=1 THEN v.bultos ELSE 0 END) nuestros
          FROM share_v v LEFT JOIN share_proveedores p ON p.id=v.proveedor_id
         WHERE v.fecha_entrega BETWEEN ? AND ?
         GROUP BY v.articulo_id, v.fecha_entrega`).all(desde, hasta);
      const m = new Map();
      for (const r of q) {
        let x = m.get(r.aid);
        if (!x) { x = { aid: r.aid, dias: 0, huerfanos: 0, perdido: 0, fechas: [] }; m.set(r.aid, x); }
        x.dias++;
        if (r.nuestros <= 0) { x.huerfanos++; x.perdido += r.total; if (x.fechas.length < 12) x.fechas.push(r.f); }
      }
      const { arts } = padrones();
      filas = [...m.values()]
        // Sólo tiene sentido para lo que proveemos: si nunca lo vendimos, el hueco es "duro",
        // no un día perdido, y se mira en la otra solapa.
        .filter(x => x.huerfanos > 0 && ((arts.get(x.aid) || {}).la_vendemos || porArt.get(x.aid)?.nuestros > 0))
        .map(x => {
          const a = arts.get(x.aid) || {};
          return {
            id: x.aid, desc: a.desc_canonica, familia: a.familia, la_vendemos: a.la_vendemos ? 1 : 0,
            dias: x.dias, huerfanos: x.huerfanos, cobertura: x.dias ? (x.dias - x.huerfanos) / x.dias : 0,
            bultos_perdidos: r2(x.perdido), fechas: x.fechas,
          };
        })
        .sort((a, b) => b.bultos_perdidos - a.bultos_perdidos);
    }

    res.json({ ok: true, data: { rango: { desde, hasta }, tipo, filas: filas.slice(0, 300) } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// COMPETENCIA
// ══════════════════════════════════════════════════════════════════════════════════════

router.get('/competencia', requireAuth, (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req.query);
    if (!desde) return res.json({ ok: true, data: { ranking: [], matriz: null } });
    const { porArt } = agregar(desde, hasta);
    const kpi = totales(porArt);

    // Artículos donde participamos: es la base del solapamiento.
    const nuestrosArt = new Set([...porArt.values()].filter(x => x.nuestros > 0).map(x => x.id));

    const acum = new Map();
    for (const x of porArt.values()) for (const p of x.provs) {
      let v = acum.get(p.id);
      if (!v) { v = { id: p.id, nombre: p.nombre, tipo: p.tipo, es_nosotros: p.es_nosotros, bultos: 0, articulos: 0, lider_en: 0, solapado: 0, compite: 0 }; acum.set(p.id, v); }
      v.bultos += p.bultos; v.articulos++;
      if (x.provs[0] && x.provs[0].id === p.id) v.lider_en++;
      // SOLAPAMIENTO: qué parte del volumen de ese proveedor está en artículos que nosotros
      // también proveemos. Es lo que separa a un competidor real de uno que juega en otra
      // cancha: dos proveedores del mismo tamaño pueden ser rivales o no cruzarse nunca.
      if (nuestrosArt.has(x.id)) { v.solapado += p.bultos; v.compite++; }
    }
    const ranking = [...acum.values()]
      .map(v => ({
        ...v, bultos: r2(v.bultos), solapado: r2(v.solapado),
        share: kpi.bultos_total ? v.bultos / kpi.bultos_total : 0,
        solapamiento: v.bultos ? v.solapado / v.bultos : 0,
      }))
      .sort((a, b) => b.bultos - a.bultos)
      .map((v, i) => ({ ...v, puesto: i + 1 }));

    // La matriz proveedor × artículo. Se acota a los más grandes de cada eje: una tabla de
    // 41 × 162 no se lee, y las colas son casi todas ceros.
    const nProv = Math.min(Math.max(parseInt(req.query.provs, 10) || 15, 3), 41);
    const nArt = Math.min(Math.max(parseInt(req.query.arts, 10) || 25, 3), 60);
    const topProv = ranking.slice(0, nProv);
    const topArt = [...porArt.values()].sort((a, b) => b.total - a.total).slice(0, nArt);
    const idxProv = new Map(topProv.map((p, i) => [p.id, i]));
    const matriz = topArt.map(x => {
      const celdas = new Array(topProv.length).fill(0);
      for (const p of x.provs) { const i = idxProv.get(p.id); if (i !== undefined) celdas[i] = r2(p.bultos); }
      return { id: x.id, desc: x.desc, familia: x.familia, total: r2(x.total), nuestros: r2(x.nuestros), share: x.share, celdas };
    });

    res.json({
      ok: true,
      data: {
        rango: { desde, hasta }, total_mercado: r2(kpi.bultos_total),
        ranking,
        matriz: { proveedores: topProv.map(p => ({ id: p.id, nombre: p.nombre, tipo: p.tipo, es_nosotros: p.es_nosotros })), filas: matriz },
      },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/competencia/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const prov = db.prepare('SELECT * FROM share_proveedores WHERE id=?').get(id);
    if (!prov) return res.status(404).json({ ok: false, error: 'No existe ese proveedor.' });
    const { desde, hasta } = resolverRango(req.query);
    if (!desde) return res.json({ ok: true, data: { proveedor: prov, articulos: [] } });
    const { porArt } = agregar(desde, hasta);

    const arts = [];
    let bultos = 0, solapado = 0;
    for (const x of porArt.values()) {
      const p = x.provs.find(v => v.id === id);
      if (!p) continue;
      bultos += p.bultos;
      if (x.nuestros > 0) solapado += p.bultos;
      arts.push({
        id: x.id, desc: x.desc, familia: x.familia,
        suyos: r2(p.bultos), total: r2(x.total), nuestros: r2(x.nuestros),
        su_share: x.total ? p.bultos / x.total : 0, nuestro_share: x.share,
        es_lider: x.provs[0] && x.provs[0].id === id ? 1 : 0,
        competimos: x.nuestros > 0 ? 1 : 0,
      });
    }
    arts.sort((a, b) => b.suyos - a.suyos);

    const evolucion = db.prepare(`
      SELECT ${SEM('fecha_entrega')} sem, SUM(bultos) bultos
        FROM share_v WHERE proveedor_id=? AND fecha_entrega BETWEEN ? AND ?
       GROUP BY sem ORDER BY sem`).all(id, desde, hasta).map(f => ({ ...f, bultos: r2(f.bultos) }));

    // Mix por familia: dice en qué cancha juega.
    const mix = new Map();
    for (const a of arts) mix.set(a.familia, (mix.get(a.familia) || 0) + a.suyos);

    res.json({
      ok: true,
      data: {
        proveedor: prov, rango: { desde, hasta },
        bultos: r2(bultos), articulos_n: arts.length,
        lider_en: arts.filter(a => a.es_lider).length,
        compite_en: arts.filter(a => a.competimos).length,
        solapamiento: bultos ? solapado / bultos : 0,
        mix: [...mix.entries()].map(([familia, b]) => ({ familia, bultos: r2(b), share: bultos ? b / bultos : 0 })).sort((a, b) => b.bultos - a.bultos),
        evolucion, articulos: arts.slice(0, 300),
      },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// OFERTA — lo que le mandamos a Carrefour, contra lo que terminó comprando
// ══════════════════════════════════════════════════════════════════════════════════════
// El planning contesta "qué compró". Sin la oferta no se puede contestar la que importa:
// de lo que le ofrecimos, ¿qué nos aceptó? Y sobre todo, ¿qué le ofrecimos, compró, y se lo
// compró a otro? Ese caso es el único que se puede ir a discutir con nombre y apellido.
//
// Sin la oferta, un artículo que no nos compró y uno que ni le mostramos se ven idénticos
// —cero bultos nuestros— y son dos problemas completamente distintos.

// Cómo le fue a cada artículo ofrecido. El nombre del resultado es el que se usa en la
// pantalla y en el Excel: una sola palabra para cada situación, para poder filtrar por ella.
const OF_RESULTADO = {
  vendido:      'Nos compró',
  perdido:      'Compró, pero a otro',
  sin_demanda:  'Ese día no lo compró nadie',
  no_ofrecido:  'No lo ofrecimos y compró',
};

function ofertaVsCompra(desde, hasta) {
  const { arts, provs } = padrones();

  // El precio con el que lo ofrecimos la ULTIMA vez. En SQLite, poner MAX(fecha) en un GROUP
  // BY hace que las columnas sueltas salgan de ESA fila, asi que precio y ean son los del dia
  // mas reciente y no un promedio, que no querria decir nada.
  const of = db.prepare(`
    SELECT articulo_id AS aid, SUM(cantidad) AS ofrecido, COUNT(DISTINCT fecha) AS dias_ofrecido,
           MAX(fecha) AS ultima_oferta, precio, ean
      FROM share_oferta_v WHERE fecha BETWEEN ? AND ? GROUP BY articulo_id`).all(desde, hasta);

  const co = db.prepare(`
    SELECT v.articulo_id AS aid,
           SUM(v.bultos) AS total,
           SUM(CASE WHEN p.es_nosotros=1 THEN v.bultos ELSE 0 END) AS nuestros,
           COUNT(DISTINCT v.fecha_entrega) AS dias_comprado
      FROM share_v v LEFT JOIN share_proveedores p ON p.id = v.proveedor_id
     WHERE v.fecha_entrega BETWEEN ? AND ?
     GROUP BY v.articulo_id`).all(desde, hasta);

  // Quién se lo llevó, para los que ofrecimos y fueron a otro. Sin esto el aviso dice que
  // perdimos y no contra quién, que es lo único con lo que se puede hacer algo.
  const lider = new Map();
  for (const r of db.prepare(`
    SELECT articulo_id AS aid, proveedor_id AS pid, SUM(bultos) AS b
      FROM share_v WHERE fecha_entrega BETWEEN ? AND ?
     GROUP BY articulo_id, proveedor_id`).all(desde, hasta)) {
    const p = provs.get(r.pid) || {};
    if (p.es_nosotros) continue;
    const prev = lider.get(r.aid);
    if (!prev || r.b > prev.bultos) lider.set(r.aid, { nombre: p.nombre_canonico || '(sin nombre)', tipo: p.tipo, bultos: r.b });
  }

  const m = new Map();
  const traer = (aid) => {
    let x = m.get(aid);
    if (!x) {
      const a = arts.get(aid) || {};
      x = { id: aid, desc: a.desc_canonica || '(sin nombre)', familia: a.familia || 'OTRO',
            unidad: a.unidad, la_vendemos: a.la_vendemos ? 1 : 0, ean: a.ean || null,
            ofrecido: 0, dias_ofrecido: 0, total: 0, nuestros: 0, dias_comprado: 0,
            precio: null, ultima_oferta: null };
      m.set(aid, x);
    }
    return x;
  };
  for (const r of of) { const x = traer(r.aid); x.ofrecido = r.ofrecido; x.dias_ofrecido = r.dias_ofrecido;
    x.precio = r.precio == null ? null : Number(r.precio); x.ultima_oferta = r.ultima_oferta;
    if (!x.ean && r.ean) x.ean = r.ean; }
  for (const r of co) { const x = traer(r.aid); x.total = r.total; x.nuestros = r.nuestros; x.dias_comprado = r.dias_comprado; }

  const filas = [...m.values()].map(x => {
    let res;
    if (!x.ofrecido) res = x.total > 0 ? 'no_ofrecido' : 'sin_demanda';
    else if (x.nuestros > 0) res = 'vendido';
    else if (x.total > 0) res = 'perdido';
    else res = 'sin_demanda';
    const l = lider.get(x.id);
    return {
      ...x,
      ofrecido: r2(x.ofrecido), total: r2(x.total), nuestros: r2(x.nuestros),
      resultado: res, resultado_label: OF_RESULTADO[res],
      // Cuánto de lo ofrecido quedó sin colocar. Se corta en cero: si nos compró MÁS de lo
      // que habíamos ofrecido (pasa, se completa después), no es un sobrante negativo.
      sin_colocar: Math.max(0, r2(x.ofrecido - x.nuestros)),
      conversion: x.ofrecido ? Math.min(1, x.nuestros / x.ofrecido) : null,
      share: x.total ? x.nuestros / x.total : null,
      se_lo_llevo: (res === 'perdido' && l) ? l.nombre : null,
      se_lo_llevo_bultos: (res === 'perdido' && l) ? r2(l.bultos) : null,
    };
  });

  const suma = (f, k) => filas.filter(f).reduce((s, x) => s + (x[k] || 0), 0);
  const esOfrecido = (x) => x.ofrecido > 0;
  const kpi = {
    ofrecido: r2(suma(esOfrecido, 'ofrecido')),
    vendido: r2(suma(x => x.resultado === 'vendido', 'nuestros')),
    perdido: r2(suma(x => x.resultado === 'perdido', 'ofrecido')),
    sin_demanda: r2(suma(x => x.resultado === 'sin_demanda' && x.ofrecido > 0, 'ofrecido')),
    no_ofrecido: r2(suma(x => x.resultado === 'no_ofrecido', 'total')),
    articulos_ofrecidos: filas.filter(esOfrecido).length,
    articulos_vendidos: filas.filter(x => x.resultado === 'vendido').length,
    articulos_perdidos: filas.filter(x => x.resultado === 'perdido').length,
    articulos_no_ofrecidos: filas.filter(x => x.resultado === 'no_ofrecido').length,
  };
  // La conversión se calcula sobre los BULTOS ofrecidos, no promediando los porcentajes de
  // cada artículo: si no, ofrecer 10 bultos de perejil y colocarlos pesa lo mismo que ofrecer
  // 4.000 de papa y no colocar ninguno.
  kpi.conversion = kpi.ofrecido ? kpi.vendido / kpi.ofrecido : null;

  const dias = db.prepare('SELECT COUNT(DISTINCT fecha) d FROM share_oferta_v WHERE fecha BETWEEN ? AND ?').get(desde, hasta).d;
  return { filas, kpi, dias_con_oferta: dias };
}

// GET /oferta — la comparación. `resultado` filtra por una de las cuatro situaciones.
router.get('/oferta', requireAuth, (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req.query);
    if (!desde) return res.json({ ok: true, data: { filas: [], kpi: {}, sin_datos: true } });
    const d = ofertaVsCompra(desde, hasta);
    const filtro = OF_RESULTADO[String(req.query.resultado)] ? String(req.query.resultado) : null;
    const q = norm(req.query.q || '');
    let filas = d.filas;
    if (filtro) filas = filas.filter(x => x.resultado === filtro);
    if (q) filas = filas.filter(x => norm(x.desc).includes(q));
    const ORD = {
      perdido: (a, b) => b.ofrecido - a.ofrecido,
      ofrecido: (a, b) => b.ofrecido - a.ofrecido,
      sin_colocar: (a, b) => b.sin_colocar - a.sin_colocar,
      total: (a, b) => b.total - a.total,
    };
    filas = filas.slice().sort(ORD[String(req.query.orden)] || ORD.sin_colocar);
    res.json({ ok: true, data: { rango: { desde, hasta }, kpi: d.kpi, dias_con_oferta: d.dias_con_oferta,
      resultados: OF_RESULTADO, filas: filas.slice(0, 400), total_filas: filas.length } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /ofertas — las que se cargaron, para poder ver y dar de baja.
router.get('/ofertas', requireAuth, (req, res) => {
  try {
    res.json({ ok: true, data: db.prepare(`
      SELECT o.*, (SELECT COUNT(*) FROM share_oferta_lineas l WHERE l.oferta_id=o.id) lineas
        FROM share_ofertas o ORDER BY o.fecha DESC, o.id DESC LIMIT 200`).all() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /ofertas — carga la oferta de un día. Acepta texto pegado o un .xlsx.
// Sin ?confirmar=1 es sólo preview: dice qué va a pasar y no escribe nada.
router.post('/ofertas', requireAuth, subida.single('archivo'), (req, res) => {
  try {
    if (!puedeOperar(req.user)) return res.status(403).json({ ok: false, error: 'Tu acceso a SHARE es de solo lectura.' });
    let fecha = String(req.body?.fecha || '').slice(0, 10);
    let filas = [], origen = 'texto', nombre = null;

    if (req.file) {
      origen = 'excel'; nombre = req.file.originalname || 'oferta.xlsx';
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) return res.status(400).json({ ok: false, error: 'El archivo no tiene ninguna hoja.' });
      // blankrows:true a proposito: asi el indice de cada fila es EL NUMERO DE FILA DEL EXCEL.
      // Con las vacias descartadas, un aviso de "linea 7" manda a mirar otra fila.
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
      if (!aoa.length) return res.status(400).json({ ok: false, error: 'La hoja está vacía.' });
      // La fecha de referencia para completar el año que el archivo no trae: la última con
      // planning cargado, que es contra la que se va a comparar.
      const ex = parseOfertaExcel(aoa, rangoBase().max);
      if (ex.error) return res.status(400).json({ ok: false, error: ex.error });
      if (!ex.filas.length) return res.status(400).json({ ok: false, error: 'No hay ninguna fila con artículo y cantidad.', rechazadas: ex.rechazadas });
      filas = ex.filas;
      req._rechazadas = ex.rechazadas;
      req._delArchivo = { fecha: ex.fecha, proveedor: ex.proveedor, fila_titulos: ex.fila_titulos };
      // LA FECHA SALE DEL ARCHIVO si el operador no eligió una. El archivo la trae en el
      // encabezado ("FECHA DE ENTREGA: MARTES 25/8") y es más confiable que acordarse de
      // ponerla a mano — pero la pantalla la muestra para confirmarla, porque el año no viene
      // y se deduce.
      if (!fecha && ex.fecha) fecha = ex.fecha;
    } else {
      const t = parseOfertaTexto(req.body?.texto || '');
      filas = t.filas;
      if (!filas.length) {
        return res.status(400).json({ ok: false,
          error: 'No pude leer ninguna línea. Se espera "artículo" y la cantidad al final: "MANZANA X KG   500".',
          rechazadas: t.rechazadas });
      }
      req._rechazadas = t.rechazadas;
    }

    if (String(req.query.confirmar || '') !== '1') {
      const a = analizarOferta(db, { filas, fecha });
      return res.json({ ok: true, preview: true,
        data: { ...a, rechazadas: req._rechazadas || [], del_archivo: req._delArchivo || null } });
    }
    const r = importarOferta(db, { filas, fecha, origen, nombre,
      notas: req.body?.notas || null, usuario: req.user?.nombre || null, usuarioId: req.user?.id || null });
    res.json({ ok: true, oferta_id: r.oferta_id, data: r.analisis });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ── LAS EQUIVALENCIAS ────────────────────────────────────────────────────────────────
// "Este producto de nuestra oferta es este otro del planning de Carrefour". Es la respuesta
// al problema de fondo: los dos catálogos nombran distinto lo mismo, y el parseo acomoda lo
// que tiene forma de regla (el calibre, el paréntesis, la unidad en el medio) pero no puede
// adivinar que nuestra UVA NEGRA es la UVA de ellos. Eso lo sabe una persona, se anota UNA
// vez y queda.
//
// Se guardan dos alias por equivalencia: uno por el TEXTO tal como lo escribimos y otro por
// el EAN. El del EAN es el que aguanta que mañana alguien escriba el nombre distinto.
router.get('/oferta/equivalencias', requireAuth, (req, res) => {
  try {
    const filas = db.prepare(`
      SELECT a.id, a.tipo, a.alias_raw, a.destino_id, a.creado_en,
             ar.desc_canonica AS destino, ar.familia,
             (SELECT COUNT(*) FROM share_oferta_lineas l
               WHERE l.articulo_id = a.destino_id
                 AND (a.tipo <> 'ean' OR l.ean = a.alias_raw)) AS usos
        FROM share_alias a
        LEFT JOIN share_articulos ar ON ar.id = a.destino_id
       WHERE a.tipo IN ('articulo','ean')
       ORDER BY ar.desc_canonica, a.tipo, a.alias_raw`).all();
    res.json({ ok: true, data: filas });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/oferta/equivalencias', requireAuth, (req, res) => {
  try {
    if (!puedeOperar(req.user)) return res.status(403).json({ ok: false, error: 'Tu acceso a SHARE es de solo lectura.' });
    const b = req.body || {};
    const destino = parseInt(b.articulo_id, 10);
    const texto = b.texto ? norm(b.texto) : null;
    const ean = b.ean ? String(b.ean).replace(/[^\d]/g, '') : null;
    if (!destino) return res.status(400).json({ ok: false, error: 'Falta el artículo de Carrefour.' });
    if (!texto && !ean) return res.status(400).json({ ok: false, error: 'Falta el producto de la oferta.' });
    const art = db.prepare('SELECT id, desc_canonica FROM share_articulos WHERE id=?').get(destino);
    if (!art) return res.status(404).json({ ok: false, error: 'Ese artículo no existe.' });

    const correr = db.transaction(() => {
      if (texto) db.prepare("INSERT OR REPLACE INTO share_alias (tipo, alias_raw, destino_id) VALUES ('articulo', ?, ?)").run(texto, destino);
      if (ean) db.prepare("INSERT OR REPLACE INTO share_alias (tipo, alias_raw, destino_id) VALUES ('ean', ?, ?)").run(ean, destino);
      // Si lo ofrecemos, lo vendemos. Es el mismo criterio que usa la carga de la oferta.
      db.prepare('UPDATE share_articulos SET la_vendemos=1 WHERE id=? AND la_vendemos=0').run(destino);
    });
    correr();
    res.json({ ok: true, data: { destino: art.desc_canonica } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/oferta/equivalencias/:id', requireAuth, (req, res) => {
  try {
    if (!puedeOperar(req.user)) return res.status(403).json({ ok: false, error: 'Tu acceso a SHARE es de solo lectura.' });
    const r = db.prepare("DELETE FROM share_alias WHERE id=? AND tipo IN ('articulo','ean')").run(req.params.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'No existe.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// El padrón entero para los desplegables de equivalencia. Sin filtro de fechas: el artículo
// contra el que hay que cruzar puede no haberse comprado en el rango que esté mirando.
router.get('/articulos/padron', requireAuth, (req, res) => {
  try {
    res.json({ ok: true, data: db.prepare(`
      SELECT a.id, a.desc_canonica, a.familia,
             (SELECT COALESCE(SUM(bultos),0) FROM share_v v WHERE v.articulo_id=a.id) AS bultos
        FROM share_articulos a WHERE a.activo=1
       ORDER BY bultos DESC, a.desc_canonica LIMIT 3000`).all() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/ofertas/:id', requireAuth, (req, res) => {
  try {
    if (!puedeOperar(req.user)) return res.status(403).json({ ok: false, error: 'Tu acceso a SHARE es de solo lectura.' });
    const r = db.prepare("UPDATE share_ofertas SET estado='reemplazada', reemplazada_en=datetime('now','localtime') WHERE id=? AND estado='activa'").run(req.params.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'No existe o ya estaba dada de baja.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// MAPEOS
// ══════════════════════════════════════════════════════════════════════════════════════

router.get('/pendientes', requireAuth, (req, res) => {
  try {
    // Con el backlog histórico cargado la cola arranca en varios cientos de artículos, así
    // que se puede buscar y filtrar por familia: revisar 400 filas de corrido no lo hace
    // nadie, y una cola que no se puede recortar termina sin revisarse nunca.
    const q = norm(req.query.q || '');
    const fam = FAMILIAS_OK.has(String(req.query.familia)) ? req.query.familia : null;
    const cond = ['a.pendiente_revision=1'], par = [];
    if (q) { cond.push("a.desc_canonica LIKE ? ESCAPE '\\'"); par.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%'); }
    if (fam) { cond.push('a.familia=?'); par.push(fam); }

    const total = db.prepare(`SELECT COUNT(*) n FROM share_articulos a WHERE ${cond.join(' AND ')}`).get(...par).n;
    const arts = db.prepare(`
      SELECT a.*, (SELECT COALESCE(SUM(bultos),0) FROM share_v v WHERE v.articulo_id=a.id) bultos,
             (SELECT MIN(fecha_entrega) FROM share_v v WHERE v.articulo_id=a.id) primera
        FROM share_articulos a WHERE ${cond.join(' AND ')}
       ORDER BY bultos DESC LIMIT 400`).all(...par);
    const provs = db.prepare(`
      SELECT p.*, (SELECT COALESCE(SUM(bultos),0) FROM share_v v WHERE v.proveedor_id=p.id) bultos
        FROM share_proveedores p WHERE p.pendiente_revision=1
       ORDER BY bultos DESC LIMIT 200`).all();
    const sinUnidad = db.prepare(`
      SELECT a.id, a.desc_canonica, a.unidad, a.factor_kg,
             (SELECT COALESCE(SUM(bultos),0) FROM share_v v WHERE v.articulo_id=a.id) bultos
        FROM share_articulos a WHERE a.unidad='SIN_DEFINIR' OR a.unidad IS NULL
       ORDER BY bultos DESC LIMIT 300`).all();
    res.json({
      ok: true,
      data: {
        articulos: arts, proveedores: provs, sin_unidad: sinUnidad,
        total_articulos: total, mostrados: arts.length,
        // El total SIN filtrar, para que el contador de la solapa no cambie según lo que se
        // esté buscando en ese momento.
        pendientes_todos: db.prepare('SELECT COUNT(*) n FROM share_articulos WHERE pendiente_revision=1').get().n,
      },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

const UNIDADES_OK = new Set(['KG', 'UNIDAD', 'ATADO', 'PAQUETE', 'PACK_GR', 'SIN_DEFINIR']);
// La lista sale del parser y no se repite aca: dos listas de familias es una sola cosa
// escrita dos veces, y la que se olvida de actualizar rechaza como invalida a la familia que
// el propio importador acaba de asignar.
const FAMILIAS_OK = new Set(FAMILIAS_VALIDAS);

// ── DAR OK A VARIOS DE UNA ────────────────────────────────────────────────────────────
// Después de cargar el histórico la cola tiene cientos de artículos y casi todos necesitan lo
// mismo: "revisado, así está bien". De a uno son cientos de clics y el resultado práctico es
// que la cola no se revisa nunca — y sin «la vendemos» marcado, Oportunidades no sirve.
//
// VA ANTES DE /articulos/:id: si no, Express no llega nunca acá, porque un PATCH a
// /articulos sin id no matchea /:id pero el orden entre rutas hermanas es lo que decide
// cuando alguna es más general.
router.patch('/articulos', requireAuth, (req, res) => {
  try {
    if (!puedeOperar(req.user)) return res.status(403).json({ ok: false, error: 'Tu acceso a SHARE es de solo lectura.' });
    const b = req.body || {};
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(x => parseInt(x, 10)).filter(x => x > 0);
    if (!ids.length) return res.status(400).json({ ok: false, error: 'No llegó ningún artículo.' });
    if (ids.length > 1000) return res.status(400).json({ ok: false, error: 'Son demasiados de una vez (máximo 1000).' });
    const c = b.cambios || {};

    if (c.familia !== undefined && c.familia !== null && !FAMILIAS_OK.has(String(c.familia)))
      return res.status(400).json({ ok: false, error: 'Familia inválida.' });
    if (c.unidad !== undefined && c.unidad !== null && !UNIDADES_OK.has(String(c.unidad)))
      return res.status(400).json({ ok: false, error: 'Unidad inválida.' });

    const set = [], par = [];
    const campo = (k, v) => { set.push(k + '=?'); par.push(v); };
    // Sólo lo que tiene sentido aplicar a un montón junto. La unidad y el factor de kilos NO
    // entran: son propios de cada artículo y ponerle 1 kg por bulto a cien productos de un
    // saque daría un total en kilos perfectamente creíble y falso.
    if (c.la_vendemos !== undefined) campo('la_vendemos', c.la_vendemos ? 1 : 0);
    if (c.familia !== undefined) campo('familia', c.familia || null);
    if (c.rubro !== undefined) campo('rubro', c.rubro ? String(c.rubro).trim() : null);
    if (c.activo !== undefined) campo('activo', c.activo ? 1 : 0);
    // Por defecto, tocar en lote es dar el OK: sacarlo de la cola de revisión.
    campo('pendiente_revision', c.pendiente_revision === undefined ? 0 : (c.pendiente_revision ? 1 : 0));

    const marcas = ids.map(() => '?').join(',');
    const correr = db.transaction(() => db.prepare(
      `UPDATE share_articulos SET ${set.join(', ')} WHERE id IN (${marcas})`).run(...par, ...ids).changes);
    const n = correr();
    res.json({ ok: true, data: { actualizados: n, pendientes: db.prepare('SELECT COUNT(*) n FROM share_articulos WHERE pendiente_revision=1').get().n } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/proveedores', requireAuth, (req, res) => {
  try {
    if (!puedeOperar(req.user)) return res.status(403).json({ ok: false, error: 'Tu acceso a SHARE es de solo lectura.' });
    const b = req.body || {};
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(x => parseInt(x, 10)).filter(x => x > 0);
    if (!ids.length) return res.status(400).json({ ok: false, error: 'No llegó ningún proveedor.' });
    const c = b.cambios || {};
    const set = ['pendiente_revision=?'], par = [c.pendiente_revision === undefined ? 0 : (c.pendiente_revision ? 1 : 0)];
    if (c.tipo !== undefined) {
      if (!TIPOS_PROV.has(String(c.tipo))) return res.status(400).json({ ok: false, error: 'Tipo inválido.' });
      // es_nosotros y tipo son la misma decisión escrita dos veces: se mueven juntos.
      set.unshift('tipo=?', 'es_nosotros=?'); par.unshift(c.tipo, c.tipo === 'nosotros' ? 1 : 0);
    }
    const marcas = ids.map(() => '?').join(',');
    const correr = db.transaction(() => db.prepare(
      `UPDATE share_proveedores SET ${set.join(', ')} WHERE id IN (${marcas})`).run(...par, ...ids).changes);
    res.json({ ok: true, data: { actualizados: correr() } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/articulos/:id', requireAuth, (req, res) => {
  try {
    if (!puedeOperar(req.user)) return res.status(403).json({ ok: false, error: 'Tu acceso a SHARE es de solo lectura.' });
    const id = parseInt(req.params.id, 10);
    const a = db.prepare('SELECT * FROM share_articulos WHERE id=?').get(id);
    if (!a) return res.status(404).json({ ok: false, error: 'No existe.' });
    const b = req.body || {};

    if (b.familia !== undefined && b.familia !== null && !FAMILIAS_OK.has(String(b.familia)))
      return res.status(400).json({ ok: false, error: 'Familia inválida.' });
    if (b.unidad !== undefined && b.unidad !== null && !UNIDADES_OK.has(String(b.unidad)))
      return res.status(400).json({ ok: false, error: 'Unidad inválida.' });

    const set = [], par = [];
    const campo = (k, v) => { set.push(k + '=?'); par.push(v); };
    if (b.la_vendemos !== undefined) campo('la_vendemos', b.la_vendemos ? 1 : 0);
    if (b.familia !== undefined) campo('familia', b.familia || null);
    if (b.rubro !== undefined) campo('rubro', b.rubro ? String(b.rubro).trim() : null);
    if (b.articulo_base !== undefined) campo('articulo_base', norm(b.articulo_base) || null);
    if (b.activo !== undefined) campo('activo', b.activo ? 1 : 0);
    if (b.pendiente_revision !== undefined) campo('pendiente_revision', b.pendiente_revision ? 1 : 0);

    // La unidad y el factor van juntos: cambiar uno sin el otro deja los kilos mintiendo.
    let tocoUnidad = false;
    if (b.unidad !== undefined) { campo('unidad', b.unidad); tocoUnidad = true; }
    if (b.gramos !== undefined) { campo('gramos', b.gramos ? parseInt(b.gramos, 10) : null); tocoUnidad = true; }
    if (b.factor_kg !== undefined) {
      const f = b.factor_kg === null || b.factor_kg === '' ? null : Number(b.factor_kg);
      if (f !== null && (!isFinite(f) || f <= 0)) return res.status(400).json({ ok: false, error: 'El factor de kilos tiene que ser un número mayor a cero (o vacío).' });
      campo('factor_kg', f); tocoUnidad = true;
    }
    if (!set.length) return res.json({ ok: true, sin_cambios: true });

    par.push(id);
    db.prepare(`UPDATE share_articulos SET ${set.join(', ')} WHERE id=?`).run(...par);
    // Sin esto la corrección arreglaría el futuro y dejaría el histórico mal, y el gráfico
    // mostraría un escalón el día que alguien tocó el mapeo.
    if (tocoUnidad) recalcularKg(db, id);
    res.json({ ok: true, data: db.prepare('SELECT * FROM share_articulos WHERE id=?').get(id) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

const TIPOS_PROV = new Set(['nosotros', 'competidor', 'importacion_propia']);

router.patch('/proveedores/:id', requireAuth, (req, res) => {
  try {
    if (!puedeOperar(req.user)) return res.status(403).json({ ok: false, error: 'Tu acceso a SHARE es de solo lectura.' });
    const id = parseInt(req.params.id, 10);
    const p = db.prepare('SELECT * FROM share_proveedores WHERE id=?').get(id);
    if (!p) return res.status(404).json({ ok: false, error: 'No existe.' });
    const b = req.body || {};
    const set = [], par = [];
    if (b.tipo !== undefined) {
      if (!TIPOS_PROV.has(String(b.tipo))) return res.status(400).json({ ok: false, error: 'Tipo inválido.' });
      set.push('tipo=?'); par.push(b.tipo);
      // es_nosotros y tipo son la misma decisión escrita dos veces: se mueven juntos o el
      // share empieza a depender de cuál de los dos mire cada consulta.
      set.push('es_nosotros=?'); par.push(b.tipo === 'nosotros' ? 1 : 0);
    }
    if (b.notas !== undefined) { set.push('notas=?'); par.push(b.notas ? String(b.notas).trim() : null); }
    if (b.pendiente_revision !== undefined) { set.push('pendiente_revision=?'); par.push(b.pendiente_revision ? 1 : 0); }
    if (!set.length) return res.json({ ok: true, sin_cambios: true });
    par.push(id);
    db.prepare(`UPDATE share_proveedores SET ${set.join(', ')} WHERE id=?`).run(...par);
    res.json({ ok: true, data: db.prepare('SELECT * FROM share_proveedores WHERE id=?').get(id) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Fusionar dos artículos duplicados. Reasigna las líneas y deja un alias para que la próxima
// carga no vuelva a crear el que se acaba de absorber — sin el alias, el duplicado reaparece
// mañana y la fusión hay que hacerla todos los días.
router.post('/articulos/:id/fusionar', requireAuth, (req, res) => {
  try {
    if (!puedeOperar(req.user)) return res.status(403).json({ ok: false, error: 'Tu acceso a SHARE es de solo lectura.' });
    const destino = parseInt(req.params.id, 10);
    const origen = parseInt((req.body || {}).alias_de_id, 10);
    if (!origen || !destino) return res.status(400).json({ ok: false, error: 'Faltan los dos artículos.' });
    if (origen === destino) return res.status(400).json({ ok: false, error: 'Son el mismo artículo.' });
    const a = db.prepare('SELECT * FROM share_articulos WHERE id=?').get(destino);
    const b = db.prepare('SELECT * FROM share_articulos WHERE id=?').get(origen);
    if (!a || !b) return res.status(404).json({ ok: false, error: 'Alguno de los dos no existe.' });

    const correr = db.transaction(() => {
      // Todas las escrituras crudas que veníamos recibiendo para el absorbido pasan a apuntar
      // al que queda: si no, el alias sólo cubriría la forma canónica y no las variantes.
      const raws = db.prepare('SELECT DISTINCT articulo_raw FROM share_lineas WHERE articulo_id=?').all(origen);
      const insAlias = db.prepare("INSERT OR REPLACE INTO share_alias (tipo, alias_raw, destino_id) VALUES ('articulo', ?, ?)");
      insAlias.run(b.desc_canonica, destino);
      for (const r of raws) insAlias.run(norm(r.articulo_raw), destino);
      db.prepare('UPDATE share_lineas SET articulo_id=? WHERE articulo_id=?').run(destino, origen);
      // El absorbido se desactiva, no se borra: los alias le apuntan y el histórico de qué
      // decía la planilla es la mitad del valor de tener esto.
      db.prepare('UPDATE share_articulos SET activo=0, pendiente_revision=0 WHERE id=?').run(origen);
    });
    correr();
    recalcularKg(db, destino);
    res.json({ ok: true, data: { destino: a.desc_canonica, absorbido: b.desc_canonica } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// EXPORTACIÓN
// ══════════════════════════════════════════════════════════════════════════════════════

// Cualquier vista a Excel. Se arma con las MISMAS funciones que la pantalla: si el export
// tuviera sus propias consultas, tarde o temprano el Excel y la pantalla dirían distinto y
// nadie sabría cuál creer.
router.get('/export.xlsx', requireAuth, (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req.query);
    if (!desde) return res.status(400).json({ ok: false, error: 'Todavía no hay ningún planning cargado.' });
    const vista = String(req.query.vista || 'articulos');
    const { porArt } = agregar(desde, hasta);
    const pct = (v) => v == null ? null : Math.round(v * 10000) / 100;
    let filas = [], hoja = 'SHARE';

    if (vista === 'competencia') {
      hoja = 'Competencia';
      const kpi = totales(porArt);
      const acum = new Map();
      for (const x of porArt.values()) for (const p of x.provs) {
        let v = acum.get(p.id);
        if (!v) { v = { nombre: p.nombre, tipo: p.tipo, bultos: 0, articulos: 0, lider_en: 0 }; acum.set(p.id, v); }
        v.bultos += p.bultos; v.articulos++;
        if (x.provs[0].id === p.id) v.lider_en++;
      }
      filas = [...acum.values()].sort((a, b) => b.bultos - a.bultos).map((v, i) => ({
        PUESTO: i + 1, PROVEEDOR: v.nombre, TIPO: v.tipo, BULTOS: r2(v.bultos),
        'SHARE %': pct(kpi.bultos_total ? v.bultos / kpi.bultos_total : 0),
        ARTICULOS: v.articulos, 'LIDER EN': v.lider_en,
      }));
    } else if (vista === 'lineas') {
      // El plano de todo: una fila por línea del planning. Para cruzarlo por afuera.
      hoja = 'Detalle';
      filas = db.prepare(`
        SELECT v.fecha_entrega AS FECHA, v.proveedor_raw AS PROVEEDOR, p.tipo AS TIPO_PROV,
               v.articulo_raw AS DESC_ORIGINAL, a.desc_canonica AS ARTICULO,
               a.articulo_base AS BASE, a.calidad AS CALIDAD, a.familia AS FAMILIA,
               v.unidad AS UNIDAD, v.bultos AS BULTOS, v.kg_equiv AS KG_EQUIV
          FROM share_v v
          LEFT JOIN share_proveedores p ON p.id=v.proveedor_id
          LEFT JOIN share_articulos  a ON a.id=v.articulo_id
         WHERE v.fecha_entrega BETWEEN ? AND ?
         ORDER BY v.fecha_entrega, PROVEEDOR, ARTICULO`).all(desde, hasta);
    } else {
      hoja = vista === 'oportunidades' ? 'Oportunidades' : 'Articulos';
      let lista = [...porArt.values()];
      if (vista === 'oportunidades') lista = lista.filter(x => x.la_vendemos && x.no_capturado > 0).sort((a, b) => b.no_capturado - a.no_capturado);
      else lista.sort((a, b) => b.total - a.total);
      filas = lista.map(x => ({
        ARTICULO: x.desc, BASE: x.base, FAMILIA: x.familia, UNIDAD: x.unidad,
        'LA VENDEMOS': x.la_vendemos ? 'SI' : 'NO',
        'BULTOS CARREFOUR': r2(x.total), 'BULTOS NUESTROS': r2(x.nuestros),
        'SHARE %': pct(x.share), 'NO CAPTURADO': r2(x.no_capturado),
        'NUESTRO PUESTO': x.ranking, PROVEEDORES: x.proveedores,
        'PROVEEDOR LIDER': x.lider, 'SHARE LIDER %': pct(x.lider_share),
        'DIAS QUE LO COMPRAN': x.dias, 'DIAS QUE VENDIMOS': x.nuestros_dias,
        'IMPORT PROPIA': r2(x.import_propia), 'CONCENTRACION HHI': Math.round(x.hhi * 1000) / 1000,
      }));
    }

    if (!filas.length) filas = [{ AVISO: 'No hay datos en el rango elegido' }];
    const ws = XLSX.utils.json_to_sheet(filas);
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: Math.max(Object.keys(filas[0]).length - 1, 0), r: filas.length } }) };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, hoja);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="share-${vista}-${desde}_a_${hasta}.xlsx"`,
    });
    res.send(buf);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// El rango disponible y cuatro números para que la pantalla sepa si hay algo que mostrar.
router.get('/estado', requireAuth, (req, res) => {
  try {
    const base = rangoBase();
    const c = db.prepare("SELECT COUNT(*) n, SUM(estado='activa') act FROM share_cargas").get();
    res.json({
      ok: true,
      data: {
        rango: base,
        cargas: c.n || 0, cargas_activas: c.act || 0,
        articulos: db.prepare('SELECT COUNT(*) n FROM share_articulos').get().n,
        proveedores: db.prepare('SELECT COUNT(*) n FROM share_proveedores').get().n,
        // La lista de familias viaja al front para que no la repita: si estuvieran las dos y
        // alguien agrega una, el desplegable de la pantalla ofrece una familia menos que la que
        // el importador asigna, y esa familia queda sin forma de filtrarse.
        familias: FAMILIAS_VALIDAS,
        pendientes: db.prepare('SELECT COUNT(*) n FROM share_articulos WHERE pendiente_revision=1').get().n
                  + db.prepare('SELECT COUNT(*) n FROM share_proveedores WHERE pendiente_revision=1').get().n,
        puede_operar: puedeOperar(req.user) ? 1 : 0,
      },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
