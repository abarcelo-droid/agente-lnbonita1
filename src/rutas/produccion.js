// src/rutas/produccion.js
// ── API PRODUCCIÓN AGRÍCOLA — PUENTE CORDON SA ────────────────────────────

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../servicios/db.js';
import dbPa from '../servicios/db_pa.js'; // DB contable — asientos, proveedores

const router = express.Router();
const __dirnamePA = path.dirname(fileURLToPath(import.meta.url));

// ── Middleware auth básico ─────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    req.user = JSON.parse(cookie);
    next();
  } catch(e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

// Escritura sensible (admin de campañas, reasignación bulk). Admin = rol 'admin'.
function requireAdmin(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    req.user = JSON.parse(cookie);
    if (req.user.rol !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    next();
  } catch(e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

// ── Helper: campañas activas (una por tipo) ────────────────────────────────
// Devuelve los ids de la campaña anual y estacional activas (o null cada una).
function campañasActivas(db) {
  const anual = db.prepare("SELECT id FROM pa_campañas WHERE activa=1 AND tipo='anual' LIMIT 1").get();
  const estacional = db.prepare("SELECT id FROM pa_campañas WHERE activa=1 AND tipo='estacional' LIMIT 1").get();
  return { anualId: anual?.id || null, estacionalId: estacional?.id || null };
}

// ─────────────────────────────────────────────────────────────────────────
// CUENTA CORRIENTE — listado de proveedores con saldos
// (montado en /api/pa → ruta final /api/pa/cc/proveedores)
// ─────────────────────────────────────────────────────────────────────────
// Listado de todos los proveedores activos ordenados por saldo pendiente DESC.
// Se calcula igual que el detalle (rutas/pagos.js): compras del proveedor por
// proveedor_id, total = SUM(c.total), pagado = SUM(c.saldo_pagado), de modo que
// el saldo del listado coincide exactamente con la card "Saldo Pendiente".
router.get('/cc/proveedores', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT
        p.id, p.razon_social, p.cuit,
        COALESCE(SUM(CASE WHEN c.activo = 1 THEN c.total ELSE 0 END), 0)                       AS total_comprado,
        COALESCE(SUM(CASE WHEN c.activo = 1 THEN COALESCE(c.saldo_pagado, 0) ELSE 0 END), 0)    AS total_pagado,
        (SELECT MAX(pg.fecha) FROM pa_pagos_proveedores pg
          WHERE pg.proveedor_id = p.id AND pg.anulado = 0)                                      AS ultimo_pago
      FROM adm_proveedores p
      LEFT JOIN pa_compras c ON c.proveedor_id = p.id
      WHERE p.activo = 1
      GROUP BY p.id
      ORDER BY (total_comprado - total_pagado) DESC, p.razon_social ASC
    `).all();
    const proveedores = rows.map(r => ({
      ...r,
      saldo: (r.total_comprado || 0) - (r.total_pagado || 0)
    }));
    res.json({ ok: true, proveedores });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// CAMPAÑAS
// ─────────────────────────────────────────────────────────────────────────

router.get('/campanas', requireAuth, (req, res) => {
  const db = getDb();
  try {
    // Filtros opcionales: tipo ('anual'|'estacional') y activo (1). Sin
    // params devuelve TODAS (incluye inactivas) — la gestión de campañas lo necesita.
    const { tipo } = req.query;
    const soloActivas = req.query.activo === '1' || req.query.activa === '1';
    const conds = [], prm = [];
    if (tipo === 'anual' || tipo === 'estacional') { conds.push('tipo = ?'); prm.push(tipo); }
    if (soloActivas) { conds.push('activa = 1'); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const data = db.prepare(`SELECT * FROM pa_campañas ${where} ORDER BY tipo, fecha_inicio DESC`).all(...prm);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/campanas', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, fecha_inicio, fecha_fin } = req.body;
  let { tipo } = req.body;
  if (!nombre || !fecha_inicio || !fecha_fin)
    return res.status(400).json({ ok: false, error: 'Nombre, fecha_inicio y fecha_fin requeridos' });
  tipo = tipo || 'anual';
  if (!['anual', 'estacional'].includes(tipo))
    return res.status(400).json({ ok: false, error: "tipo debe ser 'anual' o 'estacional'" });
  try {
    const r = db.prepare("INSERT INTO pa_campañas (nombre, fecha_inicio, fecha_fin, tipo) VALUES (?,?,?,?)")
      .run(nombre, fecha_inicio, fecha_fin, tipo);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe esa campaña' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/campanas/:id/activar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const camp = db.prepare("SELECT id, tipo FROM pa_campañas WHERE id = ?").get(req.params.id);
    if (!camp) return res.status(404).json({ ok: false, error: 'Campaña no encontrada' });
    // Permitimos hasta 2 campañas activas: una por cada tipo. Al activar una,
    // desactivamos SOLO las del mismo tipo (no la del otro tipo).
    const tipo = camp.tipo || 'anual';
    const activar = db.transaction(() => {
      db.prepare("UPDATE pa_campañas SET activa = 0 WHERE tipo = ?").run(tipo);
      db.prepare("UPDATE pa_campañas SET activa = 1 WHERE id = ?").run(camp.id);
    });
    activar();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── ADMIN DE CAMPAÑAS ──────────────────────────────────────────────────────
// Listado con metadata: conteo de órdenes y compras asociadas (no eliminadas).
router.get('/campanas/admin', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM pa_ordenes o
          WHERE (o.campaña_anual_id = c.id OR o.campaña_estacional_id = c.id)
            AND o.eliminada_en IS NULL) AS ordenes_count,
        (SELECT COUNT(*) FROM pa_compras p
          WHERE (p.campaña_anual_id = c.id OR p.campaña_estacional_id = c.id)
            AND (p.activo IS NULL OR p.activo = 1)) AS compras_count
      FROM pa_campañas c
      WHERE c.eliminada_en IS NULL
      ORDER BY c.tipo, c.fecha_inicio DESC
    `).all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Editar campaña (nombre, tipo, fechas, activa). Si activa pasa a 1, se
// desactivan las demás del mismo tipo (una vigente por tipo).
router.patch('/campanas/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { nombre, tipo, fecha_inicio, fecha_fin } = req.body;
  const activaRaw = (req.body.activa !== undefined) ? req.body.activa : req.body.activo;
  try {
    const camp = db.prepare("SELECT * FROM pa_campañas WHERE id = ? AND eliminada_en IS NULL").get(req.params.id);
    if (!camp) return res.status(404).json({ ok: false, error: 'Campaña no encontrada' });
    if (tipo !== undefined && !['anual', 'estacional'].includes(tipo))
      return res.status(400).json({ ok: false, error: "tipo debe ser 'anual' o 'estacional'" });
    if (nombre !== undefined && !String(nombre).trim())
      return res.status(400).json({ ok: false, error: 'El nombre no puede estar vacío' });

    const sets = [], params = { id: camp.id };
    if (nombre       !== undefined) { sets.push("nombre = @nombre");             params.nombre = String(nombre).trim(); }
    if (tipo         !== undefined) { sets.push("tipo = @tipo");                 params.tipo = tipo; }
    if (fecha_inicio !== undefined) { sets.push("fecha_inicio = @fecha_inicio"); params.fecha_inicio = fecha_inicio; }
    if (fecha_fin    !== undefined) { sets.push("fecha_fin = @fecha_fin");       params.fecha_fin = fecha_fin; }

    const nuevoTipo = (tipo !== undefined) ? tipo : camp.tipo;
    const quiereActiva = (activaRaw !== undefined) ? (activaRaw === 1 || activaRaw === true || activaRaw === '1') : null;
    if (quiereActiva !== null) { sets.push("activa = @activa"); params.activa = quiereActiva ? 1 : 0; }

    const tx = db.transaction(() => {
      // Si se activa, desactivar las demás vigentes del mismo tipo.
      if (quiereActiva === true) {
        db.prepare("UPDATE pa_campañas SET activa = 0 WHERE tipo = ? AND id != ?").run(nuevoTipo, camp.id);
      }
      if (sets.length) db.prepare(`UPDATE pa_campañas SET ${sets.join(", ")} WHERE id = @id`).run(params);
    });
    tx();
    res.json({ ok: true });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe una campaña con ese nombre' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Soft delete: no se permite si tiene órdenes o compras asociadas activas.
router.delete('/campanas/:id', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const camp = db.prepare("SELECT * FROM pa_campañas WHERE id = ? AND eliminada_en IS NULL").get(req.params.id);
    if (!camp) return res.status(404).json({ ok: false, error: 'Campaña no encontrada' });
    const ordenes = db.prepare(
      "SELECT COUNT(*) AS n FROM pa_ordenes WHERE (campaña_anual_id = ? OR campaña_estacional_id = ?) AND eliminada_en IS NULL"
    ).get(camp.id, camp.id).n;
    const compras = db.prepare(
      "SELECT COUNT(*) AS n FROM pa_compras WHERE (campaña_anual_id = ? OR campaña_estacional_id = ?) AND (activo IS NULL OR activo = 1)"
    ).get(camp.id, camp.id).n;
    if (ordenes > 0 || compras > 0) {
      return res.status(400).json({
        ok: false,
        error: `No se puede eliminar: tiene ${ordenes} orden(es) y ${compras} compra(s) asociadas. Reasigná esas operaciones a otra campaña primero.`
      });
    }
    db.prepare("UPDATE pa_campañas SET eliminada_en = datetime('now','localtime'), eliminada_por_id = ?, activa = 0 WHERE id = ?")
      .run(req.user.id || null, camp.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// SECTORES
// ─────────────────────────────────────────────────────────────────────────

router.get('/sectores', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare("SELECT * FROM pa_sectores WHERE activo = 1 ORDER BY nombre").all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// LOTES
// ─────────────────────────────────────────────────────────────────────────

router.get('/lotes', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { sector_id, incluir_inactivos } = req.query;
    let query = `
      SELECT l.*, s.nombre as sector_nombre, s.tipo as sector_tipo,
             cl.cultivo as cultivo_actual
      FROM pa_lotes l
      JOIN pa_sectores s ON s.id = l.sector_id
      LEFT JOIN pa_cultivos_lote cl ON cl.lote_id = l.id
        AND cl.campaña = (SELECT nombre FROM pa_campañas WHERE activa = 1 LIMIT 1)
      WHERE 1=1
    `;
    const params = [];
    if (!incluir_inactivos) { query += " AND (l.activo IS NULL OR l.activo = 1)"; }
    if (sector_id) { query += " AND l.sector_id = ?"; params.push(sector_id); }
    query += " ORDER BY l.finca NULLS LAST, l.nombre";
    const data = db.prepare(query).all(...params);
    // Enriquecer con todos los cultivos por campaña
    const getCultivos = db.prepare(
      "SELECT campaña, cultivo, mes_siembra, mes_cosecha, hectareas_sembradas, en_desarrollo, productividad_pct FROM pa_cultivos_lote WHERE lote_id = ?"
    );
    data.forEach(l => {
      l.cultivos = {};
      getCultivos.all(l.id).forEach(r => {
        l.cultivos[r.campaña] = {
          cultivo: r.cultivo,
          mes_siembra: r.mes_siembra,
          mes_cosecha: r.mes_cosecha,
          hectareas_sembradas: r.hectareas_sembradas,
          en_desarrollo: r.en_desarrollo,
          productividad_pct: r.productividad_pct
        };
      });
    });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Cultivos disponibles para una selección de lotes + sugerencia ─────────
// Se usa al emitir una Orden: el operario elige el cultivo, con sugerencia
// según las campañas activas (estacional > anual) y la fecha de la orden.
// IMPORTANTE: declarar ANTES de '/lotes/:id' para que no lo capture el :id.
function _mesEnRango(m, ini, fin) {
  if (!ini || !fin) return false;
  return (ini <= fin) ? (m >= ini && m <= fin) : (m >= ini || m <= fin); // soporta wrap (ej: Nov→Feb)
}
router.get('/lotes/cultivos-disponibles', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { lote_ids, fecha } = req.query;
    const ids = String(lote_ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0);
    if (!ids.length) return res.json({ ok: true, cultivos: [], sugerido: null, razon: null });
    const ph = ids.map(() => '?').join(',');

    // 1) Cultivos únicos cargados en esos lotes
    const cultivos = db.prepare(`
      SELECT DISTINCT cultivo FROM pa_cultivos_lote
      WHERE lote_id IN (${ph}) AND cultivo IS NOT NULL AND TRIM(cultivo) <> ''
      ORDER BY cultivo
    `).all(...ids).map(r => r.cultivo);
    if (!cultivos.length) return res.json({ ok: true, cultivos: [], sugerido: null, razon: null });

    // Detalle (cultivo + campaña + meses) para calcular la sugerencia
    const detalle = db.prepare(`
      SELECT cl.cultivo, cl.campaña, cl.mes_siembra, cl.mes_cosecha
      FROM pa_cultivos_lote cl
      WHERE cl.lote_id IN (${ph}) AND cl.cultivo IS NOT NULL AND TRIM(cl.cultivo) <> ''
    `).all(...ids);

    const fechaOrden = fecha || new Date().toISOString().slice(0, 10);
    const mes = parseInt(fechaOrden.slice(5, 7), 10);
    let sugerido = null, razon = null;

    const pickDe = (campNombre) => {
      const cands = detalle.filter(d => d.campaña === campNombre);
      if (!cands.length) return null;
      // Preferir un cultivo cuyo rango de meses contenga la fecha; si no, el primero
      return cands.find(d => _mesEnRango(mes, d.mes_siembra, d.mes_cosecha)) || cands[0];
    };

    // 2a) Campaña estacional activa, si la fecha cae en su rango
    const estac = db.prepare("SELECT * FROM pa_campañas WHERE tipo='estacional' AND activa=1 LIMIT 1").get();
    if (estac && fechaOrden >= estac.fecha_inicio && fechaOrden <= estac.fecha_fin) {
      const pick = pickDe(estac.nombre);
      if (pick) { sugerido = pick.cultivo; razon = 'Campaña estacional activa: ' + estac.nombre; }
    }
    // 2b) Campaña anual activa
    if (!sugerido) {
      const anual = db.prepare("SELECT * FROM pa_campañas WHERE tipo='anual' AND activa=1 LIMIT 1").get();
      if (anual) {
        const pick = pickDe(anual.nombre);
        if (pick) { sugerido = pick.cultivo; razon = 'Campaña anual activa: ' + anual.nombre; }
      }
    }
    // 2c) Sin cultivo claro
    if (!sugerido) { sugerido = cultivos[0]; razon = 'No hay cultivo claro para esta fecha'; }

    res.json({ ok: true, cultivos, sugerido, razon });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET lote individual con todos sus cultivos por campaña
router.get('/lotes/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const lote = db.prepare(`
      SELECT l.*, s.nombre as sector_nombre, s.tipo as sector_tipo
      FROM pa_lotes l
      JOIN pa_sectores s ON s.id = l.sector_id
      WHERE l.id = ?
    `).get(req.params.id);
    if (!lote) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    // Traer todos los cultivos por campaña
    const cultRows = db.prepare("SELECT campaña, cultivo, mes_siembra, mes_cosecha, hectareas_sembradas, en_desarrollo, productividad_pct FROM pa_cultivos_lote WHERE lote_id = ?").all(req.params.id);
    lote.cultivos = {};
    cultRows.forEach(r => {
      lote.cultivos[r.campaña] = {
        cultivo: r.cultivo,
        mes_siembra: r.mes_siembra,
        mes_cosecha: r.mes_cosecha,
        hectareas_sembradas: r.hectareas_sembradas,
        en_desarrollo: r.en_desarrollo,
        productividad_pct: r.productividad_pct
      };
    });
    res.json({ ok: true, data: lote });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/lotes', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, sector_id, finca, hectareas, poligono_maps, red_agua, notas, año_plantacion, cultivos } = req.body;
  if (!nombre || !sector_id) return res.status(400).json({ ok: false, error: 'Nombre y sector requeridos' });
  try {
    const crearLote = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pa_lotes (nombre, sector_id, finca, hectareas, poligono_maps, red_agua, notas, año_plantacion)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(nombre, sector_id, finca||null, hectareas||0.5, poligono_maps||null, red_agua||null, notas||null, año_plantacion||null);
      const loteId = r.lastInsertRowid;
      // Guardar cultivos por campaña si vienen
      if (cultivos && typeof cultivos === 'object') {
        for (const [campaña, cultivo] of Object.entries(cultivos)) {
          if (!cultivo) continue;
          const campData = db.prepare("SELECT nombre FROM pa_campañas WHERE nombre=?").get(campaña);
          if (!campData) continue;
          const esPerenne = ['Vid','Damasco','Durazno','Ciruela','Manzana'].includes(cultivo) ? 1 : 0;
          db.prepare(`
            INSERT INTO pa_cultivos_lote (lote_id, cultivo, campaña, es_perenne)
            VALUES (?,?,?,?)
            ON CONFLICT(lote_id, campaña) DO UPDATE SET cultivo=excluded.cultivo
          `).run(loteId, cultivo, campaña, esPerenne);
        }
      }
      return loteId;
    });
    const id = crearLote();
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Importar múltiples lotes de una vez (para cuando llegue la planilla)
router.post('/lotes/importar', requireAuth, (req, res) => {
  const db = getDb();
  const { lotes } = req.body; // [{nombre, sector_id, hectareas, cultivo}]
  if (!Array.isArray(lotes) || !lotes.length)
    return res.status(400).json({ ok: false, error: 'Array de lotes requerido' });
  try {
    const campaña = db.prepare("SELECT nombre FROM pa_campañas WHERE activa = 1").get();
    const insertLote = db.prepare("INSERT OR IGNORE INTO pa_lotes (nombre, sector_id, hectareas) VALUES (?,?,?)");
    const insertCultivo = db.prepare(`
      INSERT INTO pa_cultivos_lote (lote_id, cultivo, campaña, es_perenne)
      VALUES (?,?,?,?)
      ON CONFLICT(lote_id, campaña) DO UPDATE SET cultivo = excluded.cultivo
    `);
    let importados = 0;
    const importarTodo = db.transaction(() => {
      for (const l of lotes) {
        if (!l.nombre || !l.sector_id) continue;
        const r = insertLote.run(l.nombre, l.sector_id, l.hectareas || 0.5);
        const loteId = r.lastInsertRowid || db.prepare("SELECT id FROM pa_lotes WHERE nombre=? AND sector_id=?").get(l.nombre, l.sector_id)?.id;
        if (loteId && l.cultivo && campaña) {
          const esPerenne = l.es_perenne ? 1 : 0;
          insertCultivo.run(loteId, l.cultivo, campaña.nombre, esPerenne);
        }
        importados++;
      }
    });
    importarTodo();
    res.json({ ok: true, importados });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Asignar cultivo a un lote por campaña
router.post('/lotes/cultivo', requireAuth, (req, res) => {
  const db = getDb();
  const { lote_id, campaña, cultivo, es_perenne, mes_siembra, mes_cosecha, hectareas_sembradas, en_desarrollo, productividad_pct } = req.body;
  if (!lote_id || !campaña) return res.status(400).json({ ok: false, error: 'lote_id y campaña requeridos' });
  try {
    if (!cultivo) {
      db.prepare("DELETE FROM pa_cultivos_lote WHERE lote_id=? AND campaña=?").run(lote_id, campaña);
    } else {
      // hectareas_sembradas: NULL si no viene o es <=0; valor numérico si viene válido
      let haSemb = null;
      if (hectareas_sembradas !== undefined && hectareas_sembradas !== null && hectareas_sembradas !== '') {
        const n = parseFloat(hectareas_sembradas);
        if (!isNaN(n) && n > 0) haSemb = n;
      }
      // en_desarrollo: 0/1; productividad_pct: 0-100 entero, NULL si en_desarrollo=0
      const enDes = en_desarrollo ? 1 : 0;
      let prodPct = null;
      if (enDes && productividad_pct !== undefined && productividad_pct !== null && productividad_pct !== '') {
        const p = parseInt(productividad_pct, 10);
        if (!isNaN(p)) prodPct = Math.max(0, Math.min(100, p));
      }
      db.prepare(`
        INSERT INTO pa_cultivos_lote (lote_id, cultivo, campaña, es_perenne, mes_siembra, mes_cosecha, hectareas_sembradas, en_desarrollo, productividad_pct)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(lote_id, campaña) DO UPDATE SET
          cultivo=excluded.cultivo, es_perenne=excluded.es_perenne,
          mes_siembra=excluded.mes_siembra, mes_cosecha=excluded.mes_cosecha,
          hectareas_sembradas=excluded.hectareas_sembradas,
          en_desarrollo=excluded.en_desarrollo,
          productividad_pct=excluded.productividad_pct
      `).run(lote_id, cultivo, campaña, es_perenne ? 1 : 0,
             mes_siembra || null, mes_cosecha || null, haSemb, enDes, prodPct);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/lotes/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, hectareas, activo, notas, finca, poligono_maps, red_agua, año_plantacion } = req.body;
  try {
    const cur = db.prepare("SELECT * FROM pa_lotes WHERE id=?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    // año_plantacion: null explícito permitido (limpia el campo); undefined deja como estaba
    let anioPlant = cur.año_plantacion;
    if (año_plantacion !== undefined) {
      if (año_plantacion === null || año_plantacion === '') anioPlant = null;
      else {
        const n = parseInt(año_plantacion, 10);
        anioPlant = (!isNaN(n) && n > 1900 && n < 2200) ? n : null;
      }
    }
    db.prepare(`UPDATE pa_lotes SET nombre=?, hectareas=?, activo=?, notas=?, finca=?, poligono_maps=?, red_agua=?, año_plantacion=? WHERE id=?`)
      .run(
        nombre||cur.nombre, hectareas||cur.hectareas,
        activo!==undefined?activo:cur.activo,
        notas!==undefined?notas:cur.notas,
        finca!==undefined?finca:cur.finca,
        poligono_maps!==undefined?poligono_maps:cur.poligono_maps,
        red_agua!==undefined?red_agua:cur.red_agua,
        anioPlant,
        req.params.id
      );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Guardar polígono dibujado en Leaflet ──
// body: { geojson, centroide_lat, centroide_lng, hectareas_calculadas (opcional) }
router.post('/lotes/:id/poligono', requireAuth, (req, res) => {
  const db = getDb();
  const { geojson, centroide_lat, centroide_lng, hectareas_calculadas } = req.body;
  if (!geojson) return res.status(400).json({ ok: false, error: 'geojson requerido' });
  try {
    const cur = db.prepare("SELECT id, hectareas FROM pa_lotes WHERE id=?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Lote no encontrado' });
    // Validar geojson mínimamente
    let parsed;
    try { parsed = typeof geojson === 'string' ? JSON.parse(geojson) : geojson; }
    catch(e) { return res.status(400).json({ ok: false, error: 'geojson inválido' }); }
    const geoStr = JSON.stringify(parsed);
    // Si vino hectáreas calculadas, la actualiza también (opcional)
    const haFinal = (hectareas_calculadas != null && hectareas_calculadas > 0) ? Number(hectareas_calculadas) : cur.hectareas;
    db.prepare(`UPDATE pa_lotes SET poligono_geojson=?, centroide_lat=?, centroide_lng=?, hectareas=? WHERE id=?`)
      .run(geoStr,
           centroide_lat != null ? Number(centroide_lat) : null,
           centroide_lng != null ? Number(centroide_lng) : null,
           haFinal,
           req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Eliminar polígono ──
router.delete('/lotes/:id/poligono', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_lotes SET poligono_geojson=NULL, centroide_lat=NULL, centroide_lng=NULL WHERE id=?")
      .run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// INSUMOS (FERTILIZANTES, AGROQUÍMICOS, ETC.)
// ─────────────────────────────────────────────────────────────────────────

router.get('/insumos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { tipo, categoria_principal, incluir_inactivos } = req.query;
    let query = "SELECT * FROM pa_insumos WHERE 1=1";
    const params = [];
    if (!incluir_inactivos) { query += " AND activo = 1"; }
    if (categoria_principal) { query += " AND categoria_principal = ?"; params.push(categoria_principal); }
    if (tipo) { query += " AND tipo = ?"; params.push(tipo); }
    query += " ORDER BY categoria_principal, tipo, nombre";
    res.json({ ok: true, data: db.prepare(query).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// FASE A — Taxonomía: maestro de subcategorías + cuentas mapeadas
// ─────────────────────────────────────────────────────────────────────────
router.get('/subcategorias', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const incluirInactivas = req.query.incluir_inactivos === '1';
    const where = incluirInactivas ? '' : 'WHERE s.activo = 1';
    const rows = db.prepare(`
      SELECT s.*,
        cd.nombre AS cuenta_default_nombre,
        ca.nombre AS cuenta_alt_nombre
      FROM pa_subcategorias s
      LEFT JOIN pa_cuentas cd ON cd.codigo = s.cuenta_codigo_default
      LEFT JOIN pa_cuentas ca ON ca.codigo = s.cuenta_codigo_alt
      ${where}
      ORDER BY s.categoria, s.orden, s.subcategoria
    `).all();

    // Agrupar por categoría para que el frontend lo arme directo en cascada
    const cats = {};
    for (const r of rows) {
      if (!cats[r.categoria]) cats[r.categoria] = { categoria: r.categoria, subcategorias: [] };
      cats[r.categoria].subcategorias.push(r);
    }
    res.json({ ok: true, data: rows, agrupado: Object.values(cats) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/insumos', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo, unidad, stock_minimo, componente_madre, precio_ref_usd, notas, categoria_principal,
          presentacion_tipo, presentacion_base,
          categoria_v2, subcategoria, cuenta_codigo } = req.body;
  if (!nombre || !tipo || !unidad)
    return res.status(400).json({ ok: false, error: 'Nombre, tipo y unidad requeridos' });
  try {
    // Si vino categoria_v2/subcategoria pero NO cuenta_codigo, autocompletar
    // con la cuenta default del maestro de subcategorías (excepto Pañol/Herramientas)
    let cuentaFinal = cuenta_codigo || null;
    if (!cuentaFinal && categoria_v2 && subcategoria) {
      const sub = db.prepare("SELECT cuenta_codigo_default, cuenta_codigo_alt FROM pa_subcategorias WHERE categoria=? AND subcategoria=?")
                    .get(categoria_v2, subcategoria);
      if (sub && !sub.cuenta_codigo_alt) cuentaFinal = sub.cuenta_codigo_default;
      // si tiene alt, queda en NULL (el frontend tiene que pedirla al user)
    }
    const r = db.prepare(`
      INSERT INTO pa_insumos (nombre, tipo, unidad, stock_minimo, componente_madre, precio_ref_usd, notas, categoria_principal,
                              presentacion_tipo, presentacion_base,
                              categoria_v2, subcategoria, cuenta_codigo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(nombre, tipo, unidad, stock_minimo||0, componente_madre||null, precio_ref_usd||null, notas||null,
           categoria_principal || 'agroinsumos',
           presentacion_tipo || null,
           presentacion_base != null ? Number(presentacion_base) : null,
           categoria_v2 || null,
           subcategoria || null,
           cuentaFinal);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/insumos/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo, unidad, stock_minimo, activo, componente_madre, precio_ref_usd, notas, categoria_principal,
          presentacion_tipo, presentacion_base,
          categoria_v2, subcategoria, cuenta_codigo } = req.body;
  try {
    const cur = db.prepare("SELECT * FROM pa_insumos WHERE id=?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    db.prepare(`UPDATE pa_insumos SET nombre=?, tipo=?, unidad=?, stock_minimo=?, activo=?,
                componente_madre=?, precio_ref_usd=?, notas=?, categoria_principal=?,
                presentacion_tipo=?, presentacion_base=?,
                categoria_v2=?, subcategoria=?, cuenta_codigo=? WHERE id=?`)
      .run(nombre||cur.nombre, tipo||cur.tipo, unidad||cur.unidad, stock_minimo??cur.stock_minimo,
           activo!==undefined?activo:cur.activo,
           componente_madre!==undefined?componente_madre:cur.componente_madre,
           precio_ref_usd!==undefined?precio_ref_usd:cur.precio_ref_usd,
           notas!==undefined?notas:cur.notas,
           categoria_principal || cur.categoria_principal,
           presentacion_tipo!==undefined?presentacion_tipo:cur.presentacion_tipo,
           presentacion_base!==undefined?(presentacion_base!=null?Number(presentacion_base):null):cur.presentacion_base,
           categoria_v2!==undefined?categoria_v2:cur.categoria_v2,
           subcategoria!==undefined?subcategoria:cur.subcategoria,
           cuenta_codigo!==undefined?cuenta_codigo:cur.cuenta_codigo,
           req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Upload ficha técnica PDF
router.post('/insumos/:id/ficha', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { filename, data } = req.body; // data = base64
    if (!data) return res.status(400).json({ ok: false, error: 'Sin datos' });
    const dir = path.join(__dirnamePA, '../../data/fichas');
    fs.mkdirSync(dir, { recursive: true });
    const fname = `insumo_${req.params.id}_${Date.now()}.pdf`;
    const fpath = path.join(dir, fname);
    fs.writeFileSync(fpath, Buffer.from(data, 'base64'));
    db.prepare("UPDATE pa_insumos SET ficha_tecnica_path=? WHERE id=?").run('/data/fichas/'+fname, req.params.id);
    res.json({ ok: true, path: '/data/fichas/'+fname });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});


// ─────────────────────────────────────────────────────────────────────────
// PROVEEDORES DE INSUMOS
// ─────────────────────────────────────────────────────────────────────────

router.get('/proveedores', requireAuth, (req, res) => {
  const db = getDb();
  try {
    res.json({ ok: true, data: db.prepare("SELECT * FROM pa_proveedores WHERE activo=1 ORDER BY razon_social").all() });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/proveedores', requireAuth, (req, res) => {
  const db = getDb();
  const { razon_social, cuit, telefono, email } = req.body;
  if (!razon_social) return res.status(400).json({ ok: false, error: 'Razón social requerida' });
  try {
    const r = db.prepare("INSERT INTO pa_proveedores (razon_social, cuit, telefono, email) VALUES (?,?,?,?)")
      .run(razon_social, cuit||null, telefono||null, email||null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// COMPRAS DE INSUMOS
// ─────────────────────────────────────────────────────────────────────────

// Historial de compras por insumo_id o por componente_madre
router.get('/insumos/historial', requireAuth, (req, res) => {
  const db = getDb();
  const { insumo_id, componente } = req.query;
  try {
    let rows;
    if (insumo_id) {
      rows = db.prepare(`
        SELECT ci.cantidad, ci.precio_unit, ci.subtotal,
               c.fecha, c.nro_factura, c.tipo_comprobante,
               COALESCE(p.razon_social, c.proveedor_txt, '—') as proveedor,
               i.nombre as insumo_nombre, i.unidad, i.componente_madre
        FROM pa_compras_items ci
        JOIN pa_compras c ON c.id = ci.compra_id
        JOIN pa_insumos i ON i.id = ci.insumo_id
        LEFT JOIN adm_proveedores p ON p.id = c.proveedor_id
        WHERE ci.insumo_id = ? AND c.activo = 1 AND i.activo = 1
        ORDER BY c.fecha DESC LIMIT 20
      `).all(insumo_id);
    } else if (componente) {
      rows = db.prepare(`
        SELECT ci.cantidad, ci.precio_unit, ci.subtotal,
               c.fecha, c.nro_factura, c.tipo_comprobante,
               COALESCE(p.razon_social, c.proveedor_txt, '—') as proveedor,
               i.nombre as insumo_nombre, i.unidad, i.componente_madre
        FROM pa_compras_items ci
        JOIN pa_compras c ON c.id = ci.compra_id
        JOIN pa_insumos i ON i.id = ci.insumo_id
        LEFT JOIN adm_proveedores p ON p.id = c.proveedor_id
        WHERE i.componente_madre = ? AND c.activo = 1 AND i.activo = 1
        ORDER BY c.fecha DESC LIMIT 20
      `).all(componente);
    } else {
      return res.status(400).json({ ok: false, error: 'insumo_id o componente requerido' });
    }
    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── LECTOR IA DE REMITOS (llama a Anthropic desde el servidor) ────────────
router.post('/leer-remito', requireAuth, async (req, res) => {
  const { imagen_b64, media_type } = req.body;
  if (!imagen_b64) return res.status(400).json({ ok: false, error: 'imagen_b64 requerida' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'API key no configurada' });

  try {
    const db = getDb();
    const insumos = db.prepare('SELECT nombre, componente_madre FROM pa_insumos WHERE activo=1 ORDER BY nombre').all();
    const insNombres = insumos.map(i => i.nombre).join(', ');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: media_type || 'image/jpeg', data: imagen_b64 }
            },
            {
              type: 'text',
              text: `Analizá este remito o factura de insumos agrícolas.
Devolvé SOLO un JSON válido sin markdown ni comentarios:
{
  "tipo_comprobante": "factura|remito|ticket|otro",
  "nro_comprobante": "número del documento o null",
  "fecha": "YYYY-MM-DD o null",
  "proveedor": "nombre del proveedor o null",
  "iva_total": número o null,
  "neto_total": número o null,
  "total_final": número o null,
  "items": [
    {
      "descripcion": "nombre del producto tal como aparece",
      "cantidad": número (cantidad principal, ver abajo),
      "unidad": "kg|lt|unidad|gramos|c.c|bolsa|bidon|rollos|sobres",
      "presentacion_base": número (lt/kg por bulto, ej: 20 si son latas de 20lt) o null,
      "cant_bultos": número (si se ve claro cuántos bultos) o null,
      "precio_unitario": número o null (si hay bultos, es el precio POR BULTO),
      "iva_porcentaje": número (ej: 21, 10.5, 0) o null si no está claro,
      "subtotal_neto": número o null,
      "iva_monto": número o null
    }
  ]
}

Notas importantes para el IVA:
- En Argentina, los agroinsumos suelen estar a 21% o 10.5%.
- Si la factura tiene una sola alícuota general, asignala a todos los items.
- Si un item está al 0% (exento), ponelo como 0.
- Si no podés determinar la alícuota con certeza, poné null.
- iva_total e iva_monto son el monto en pesos, no el porcentaje.

Insumos conocidos en el sistema (para ayudar a identificar): ${insNombres}
Solo devolvé el JSON, sin texto adicional.`
            }
          ]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ ok: false, error: data.error?.message || 'Error de API' });
    }

    const txt = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch(e) { return res.status(422).json({ ok: false, error: 'No se pudo parsear la respuesta', raw: txt }); }

    res.json({ ok: true, data: parsed });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/compras', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { campaña_id, desde, hasta, incluir_inactivos, tipo_factura } = req.query;
    let query = `
      SELECT c.*, p.razon_social as proveedor_nombre,
             ca.nombre as campaña_nombre
      FROM pa_compras c
      LEFT JOIN adm_proveedores p ON p.id = c.proveedor_id
      LEFT JOIN pa_campañas ca ON ca.id = c.campaña_id
      WHERE 1=1
    `;
    const params = [];
    if (!incluir_inactivos) { query += " AND (c.activo IS NULL OR c.activo = 1)"; }
    if (campaña_id) { query += " AND c.campaña_id = ?"; params.push(campaña_id); }
    if (desde) { query += " AND c.fecha >= ?"; params.push(desde); }
    if (hasta) { query += " AND c.fecha <= ?"; params.push(hasta); }
    if (tipo_factura) { query += " AND c.tipo_factura = ?"; params.push(tipo_factura); }
    query += " ORDER BY c.fecha DESC";
    const compras = db.prepare(query).all(...params);
    // Agregar items a cada compra. LEFT JOIN con pa_insumos porque los items de
    // servicio tienen insumo_id NULL. JOIN extra con lotes y cuentas para enriquecer.
    const getItems = db.prepare(`
      SELECT ci.*,
        i.nombre as insumo_nombre, i.unidad,
        l.nombre AS lote_nombre,
        cu.nombre AS cuenta_nombre
      FROM pa_compras_items ci
      LEFT JOIN pa_insumos i ON i.id = ci.insumo_id
      LEFT JOIN pa_lotes l ON l.id = ci.lote_id
      LEFT JOIN pa_cuentas cu ON cu.codigo = ci.cuenta_codigo
      WHERE ci.compra_id = ?
    `);
    const data = compras.map(c => ({ ...c, items: getItems.all(c.id) }));
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/compras', requireAuth, (req, res) => {
  const db = getDb();
  const { fecha, proveedor_id, proveedor_txt, nro_factura, tipo_comprobante, campaña_id,
          campaña_anual_id, campaña_estacional_id, items, notas, remito_foto_b64,
          tipo_factura } = req.body;
  if (!items?.length) return res.status(400).json({ ok: false, error: 'Debe incluir al menos un item' });
  // Validar que el proveedor esté en el padrón ADM
  if (!proveedor_id) return res.status(400).json({ ok: false, error: 'Debe seleccionar un proveedor del padrón' });
  const proveedorPadron = db.prepare('SELECT id FROM adm_proveedores WHERE id = ? AND activo = 1').get(parseInt(proveedor_id));
  if (!proveedorPadron) return res.status(400).json({ ok: false, error: 'El proveedor no está en el padrón o está inactivo' });
  const esServicio = (tipo_factura === 'servicio');
  try {
    // ── Validaciones específicas por tipo
    if (esServicio) {
      // En facturas de servicio, cada item debe traer concepto + cuenta_codigo + monto
      for (const it of items) {
        if (!it.concepto || !String(it.concepto).trim()) {
          return res.status(400).json({ ok: false, error: 'Cada concepto de servicio requiere descripción' });
        }
        if (!it.cuenta_codigo) {
          return res.status(400).json({ ok: false, error: 'Cada concepto de servicio requiere una cuenta contable' });
        }
        const monto = Number(it.monto_neto || it.precio_unit || 0);
        if (!monto || monto <= 0) {
          return res.status(400).json({ ok: false, error: 'Cada concepto de servicio requiere un monto > 0' });
        }
      }
    }

    // ── Normalizar items
    //
    // Modo "presentacion": se compra por bultos. Ej: 4 latas × 20 lt a $120.000/lata
    //   - cant_bultos = 4
    //   - presentacion_base = 20
    //   - precio_unit = 120000 (por bulto, tal cual aparece en la factura)
    //   - MONTO de la compra = 4 × 120.000 = $480.000  (cant_bultos × precio_unit)
    //   - STOCK que se suma    = 4 × 20 = 80 lt        (cant_bultos × presentacion_base)
    //
    // Modo "base": se compra directo en unidad base. Ej: 80 lt a $6.000/lt
    //   - cantidad = 80, precio_unit = 6000
    //   - MONTO = 80 × 6.000 = $480.000  (cantidad × precio_unit)
    //   - STOCK = 80 lt (= cantidad)
    //
    // Modo "servicio": no hay stock ni presentación, solo monto neto del concepto.
    //   - it.monto_neto = monto sin IVA (también podemos recibir precio_unit como sinónimo)
    //   - cantidad = 1, precio_unit = monto
    for (const it of items) {
      if (esServicio) {
        const monto = Number(it.monto_neto || it.precio_unit || 0);
        it._stockASumar = 0;
        it._montoNeto   = monto;
        // Para INSERT en pa_compras_items: cantidad=1, precio_unit=monto
        it.cantidad = 1;
        it.precio_unit = monto;
        continue;
      }
      const modoPres = (it.cant_bultos != null && it.presentacion_base != null);
      if (modoPres) {
        const cantBultos = Number(it.cant_bultos);
        const presBase   = Number(it.presentacion_base);
        it._stockASumar   = cantBultos * presBase;    // unidad base (lt/kg)
        it._montoNeto     = cantBultos * Number(it.precio_unit); // cant_bultos × precio directo
      } else {
        // Modo simple: cantidad directo en unidad base
        it._stockASumar = Number(it.cantidad);
        it._montoNeto   = Number(it.cantidad) * Number(it.precio_unit);
      }
    }

    // Calcular totales netos + IVA por item
    let neto_total = 0;
    let iva_total = 0;
    for (const it of items) {
      const subNeto = it._montoNeto;
      const pct = it.iva_porcentaje != null ? Number(it.iva_porcentaje) : 0;
      const ivaItem = subNeto * (pct / 100);
      it._subNeto = subNeto;
      it._ivaMonto = ivaItem;
      neto_total += subNeto;
      iva_total += ivaItem;
    }
    if (req.body.iva_monto != null && !items.some(it => it.iva_porcentaje != null)) {
      iva_total = Number(req.body.iva_monto);
    }
    const percep_iva       = parseFloat(req.body.percep_iva       || 0);
    const percep_ganancias = parseFloat(req.body.percep_ganancias || 0);
    const percep_iibb      = parseFloat(req.body.percep_iibb      || 0);
    const total = neto_total + iva_total + percep_iva + percep_ganancias + percep_iibb;

    // Guardar foto remito si viene
    let remito_foto_path = null;
    if (remito_foto_b64) {
      const dir = path.join(__dirnamePA, '../../data/remitos_pa');
      fs.mkdirSync(dir, { recursive: true });
      const fname = `remito_${Date.now()}.jpg`;
      fs.writeFileSync(path.join(dir, fname), Buffer.from(remito_foto_b64, 'base64'));
      remito_foto_path = '/data/remitos_pa/' + fname;
    }

    // Obtener nombre del proveedor desde adm_proveedores para proveedor_txt
    let proveedorNombre = proveedor_txt || null;
    if (!proveedorNombre && proveedor_id) {
      try {
        const prov = dbPa.prepare('SELECT razon_social FROM adm_proveedores WHERE id=?').get(parseInt(proveedor_id));
        if (prov) proveedorNombre = prov.razon_social;
      } catch(e) {}
    }

    const nuevaCompra = db.transaction(() => {
      // Campañas: ids explícitos del body, o las dos activas (anual + estacional).
      const _act = campañasActivas(db);
      const _toId = v => (v && !isNaN(parseInt(v))) ? parseInt(v) : null;
      const anualFinal      = _toId(campaña_anual_id) || _toId(campaña_id) || _act.anualId || null;
      const estacionalFinal = _toId(campaña_estacional_id) || _act.estacionalId || null;
      const r = db.prepare(`
        INSERT INTO pa_compras (fecha, proveedor_id, proveedor_txt, nro_factura, tipo_comprobante, campaña_id,
                                campaña_anual_id, campaña_estacional_id,
                                subtotal, iva_monto, total, notas, remito_foto_path,
                                iva_total, neto_total, tipo_factura)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(fecha||new Date().toISOString().slice(0,10),
             null,  // proveedor_id siempre NULL — evita FK con pa_proveedores
             proveedorNombre,
             nro_factura||null, tipo_comprobante||'factura',
             anualFinal,  // campaña_id viejo = anual (retrocompat)
             anualFinal, estacionalFinal,
             neto_total, iva_total, total, notas||null, remito_foto_path,
             iva_total, neto_total,
             esServicio ? 'servicio' : 'compra');
      const compraId = r.lastInsertRowid;

      // Helper: detectar si un insumo es de la categoría pañol
      const getCatInsumo = db.prepare("SELECT categoria_principal, nombre FROM pa_insumos WHERE id = ?");

      // Para autogenerar códigos de pañol secuenciales si el cliente no los pasó
      const getMaxCodigo = db.prepare(`
        SELECT codigo_interno FROM pa_panol_unidades
        WHERE codigo_interno LIKE 'PAÑ-%'
        ORDER BY id DESC LIMIT 1
      `);
      function siguienteCodigoPanol() {
        const last = getMaxCodigo.get();
        let n = 0;
        if (last && last.codigo_interno) {
          const m = /PAÑ-(\d+)/.exec(last.codigo_interno);
          if (m) n = parseInt(m[1], 10);
        }
        // Buscar siguientes consecutivos disponibles (en transacción se vería el estado actual)
        return 'PAÑ-' + String(n + 1).padStart(4, '0');
      }

      for (const it of items) {
        // En servicio: cantidadBase=0 (no toca stock), pero el monto neto es _montoNeto.
        // En compra: cantidadBase = stock que se va a sumar, precioBase es por unidad.
        const cantidadBase = it._stockASumar;
        const precioBase = cantidadBase > 0 ? (it._montoNeto / cantidadBase) : Number(it.precio_unit);

        db.prepare(`
          INSERT INTO pa_compras_items
            (compra_id, insumo_id, cantidad, precio_unit, subtotal, iva_porcentaje, iva_monto, subtotal_neto,
             presentacion_base, cant_bultos, precio_modo,
             concepto, lote_id, cuenta_codigo)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(compraId,
               esServicio ? null : it.insumo_id,
               esServicio ? 1 : cantidadBase,
               esServicio ? it._montoNeto : precioBase,
               it._subNeto + it._ivaMonto,
               it.iva_porcentaje != null ? Number(it.iva_porcentaje) : null,
               it._ivaMonto,
               it._subNeto,
               it.presentacion_base != null ? Number(it.presentacion_base) : null,
               it.cant_bultos != null ? Number(it.cant_bultos) : null,
               esServicio ? 'servicio' : (it.precio_modo || 'bulto'),
               esServicio ? String(it.concepto).trim() : null,
               (esServicio || it.lote_id) ? (it.lote_id || null) : null,
               (esServicio || it.cuenta_codigo) ? (it.cuenta_codigo || null) : null);

        // En servicios no toca stock ni crea pañol — saltar el resto del loop
        if (esServicio) continue;

        // Determinar si el insumo es de pañol (en cuyo caso NO se suma stock,
        // se crean N unidades en pa_panol_unidades en su lugar)
        const insumoInfo = getCatInsumo.get(it.insumo_id);
        const esPanol = insumoInfo && insumoInfo.categoria_principal === 'herramientas_panol';

        // Si el cliente pasó cuenta_codigo (caso Pañol > Herramientas con 2 alternativas),
        // persistirla en el insumo para que la próxima vez ya esté pre-seleccionada.
        if (it.cuenta_codigo) {
          db.prepare("UPDATE pa_insumos SET cuenta_codigo = ? WHERE id = ?")
            .run(it.cuenta_codigo, it.insumo_id);
        }

        if (esPanol) {
          // Cantidad de unidades a crear (en pañol cantidadBase = N enteras)
          const nUnidades = Math.max(1, Math.round(cantidadBase));
          // Precio por unidad = monto neto del item / N
          const precioPorUnidad = nUnidades > 0 ? (it._montoNeto / nUnidades) : Number(it.precio_unit);
          // Códigos: si el cliente envía it.panol_codigos = ['PAÑ-0042', ...], se respetan
          // (uno por unidad). Si no, se autogeneran secuencialmente.
          const codigosCliente = Array.isArray(it.panol_codigos) ? it.panol_codigos : [];
          const codigosUsados = new Set();
          for (let i = 0; i < nUnidades; i++) {
            let codigo = (codigosCliente[i] || '').trim();
            if (!codigo) codigo = siguienteCodigoPanol();
            // Evitar duplicados dentro del mismo lote (si el cliente pasó algo ambiguo)
            while (codigosUsados.has(codigo)) {
              const m = /^(.*?-)(\d+)$/.exec(codigo);
              if (m) codigo = m[1] + String(parseInt(m[2], 10) + 1).padStart(m[2].length, '0');
              else codigo = codigo + '-' + (i + 1);
            }
            codigosUsados.add(codigo);
            // Insertar unidad
            const ru = db.prepare(`
              INSERT INTO pa_panol_unidades
                (codigo_interno, nombre, categoria_id, marca, modelo,
                 compra_id, precio_compra, ubicacion_actual, estado, notas)
              VALUES (?,?,?,?,?,?,?,?,'disponible',?)
            `).run(
              codigo,
              insumoInfo.nombre,
              it.panol_categoria_id || null,
              it.panol_marca || null,
              it.panol_modelo || null,
              compraId,
              precioPorUnidad,
              'Pañol',
              `Alta automática desde factura ${nro_factura||'(sin nro)'}`
            );
            // Movimiento de alta
            db.prepare(`
              INSERT INTO pa_panol_movimientos
                (unidad_id, tipo, quien_registra, notas)
              VALUES (?, 'alta', ?, ?)
            `).run(ru.lastInsertRowid, req.user.id, `Alta desde compra #${compraId}`);
          }
        } else {
          // Comportamiento histórico: sumar stock al insumo + movimiento de stock
          db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual + ? WHERE id = ?")
            .run(cantidadBase, it.insumo_id);

          // Aprender la presentación default si el insumo no la tenía
          if (it.presentacion_base != null) {
            const ins = db.prepare("SELECT presentacion_base FROM pa_insumos WHERE id = ?").get(it.insumo_id);
            if (ins && !ins.presentacion_base) {
              db.prepare("UPDATE pa_insumos SET presentacion_base = ? WHERE id = ?")
                .run(Number(it.presentacion_base), it.insumo_id);
            }
          }

          db.prepare("INSERT INTO pa_movimientos_stock (fecha, insumo_id, tipo, cantidad, motivo, referencia_id) VALUES (?,?,?,?,?,?)")
            .run(fecha||new Date().toISOString().slice(0,10), it.insumo_id, 'entrada', cantidadBase, 'compra', compraId);
        }
      }
      return compraId;
    });
    const id = nuevaCompra();

    // ── Generar asiento contable ──────────────────────────────────────────────
    // Si el frontend envió líneas → usarlas directamente
    // Si no → auto-generar desde el modelo del proveedor
    let asientoRef = null;
    try {
      const { asiento_lineas } = req.body;
      let lineas = asiento_lineas || null;

      if (!lineas || !lineas.length) {
        // Auto-generar desde modelo del proveedor
        const prov = dbPa.prepare('SELECT asiento_modelo_id, razon_social FROM adm_proveedores WHERE id=?').get(parseInt(proveedor_id));
        if (prov?.asiento_modelo_id) {
          const modeloLineas = dbPa.prepare('SELECT * FROM adm_asientos_modelo_lineas WHERE modelo_id=? ORDER BY id').all(prov.asiento_modelo_id);
          if (modeloLineas.length >= 2) {
            // Percepciones enviadas desde el frontend
            const percepIva  = parseFloat(req.body.percep_iva      || 0);
            const percepGan  = parseFloat(req.body.percep_ganancias || 0);
            const percepIibb = parseFloat(req.body.percep_iibb      || 0);
            const totalConPercep = total + percepIva + percepGan + percepIibb;

            // Leer configuración impositiva global para las cuentas de percepción
            const configImp = {};
            dbPa.prepare('SELECT clave, cuenta_id FROM adm_config_impositiva WHERE cuenta_id IS NOT NULL').all()
              .forEach(r => { configImp[r.clave] = r.cuenta_id; });

            // Mapear tipo_linea a montos de la compra
            const montosPorTipo = {
              proveedores:          totalConPercep,  // Haber: deuda total con proveedor
              iva:                  iva_total,        // Debe: IVA crédito fiscal
              percepcion_iva:       percepIva,        // Debe: percepción IVA
              percepcion_iibb:      percepIibb,       // Debe: percepción IIBB
              percepcion_ganancias: percepGan,        // Debe: percepción Ganancias
              retencion:            0,
              libre:                neto_total        // Debe: gasto/compra
            };

            // Líneas del modelo + líneas de config impositiva si tienen monto
            lineas = modeloLineas.map(function(ml) {
              const monto = montosPorTipo[ml.tipo_linea] ?? 0;
              return {
                cuenta_id: ml.cuenta_id,
                debe: ml.tipo === 'debe' ? monto : 0,
                haber: ml.tipo === 'haber' ? monto : 0,
                descripcion: ml.descripcion || ml.tipo_linea
              };
            }).filter(l => l.debe > 0 || l.haber > 0);

            // Agregar líneas de config impositiva global si tienen monto y no están en el modelo
            const clavesEnModelo = new Set(modeloLineas.map(ml => ml.tipo_linea));
            const percepExtra = [
              { clave: 'percepcion_iva',       monto: percepIva  },
              { clave: 'percepcion_iibb',       monto: percepIibb },
              { clave: 'percepcion_ganancias',  monto: percepGan  },
            ];
            for (const pe of percepExtra) {
              if (pe.monto > 0 && !clavesEnModelo.has(pe.clave) && configImp[pe.clave]) {
                lineas.push({
                  cuenta_id: configImp[pe.clave],
                  debe: pe.monto,
                  haber: 0,
                  descripcion: pe.clave.replace('_', ' ')
                });
              }
            }
            // Verificar partida doble
            const sumDebe  = lineas.reduce((s,l) => s + l.debe,  0);
            const sumHaber = lineas.reduce((s,l) => s + l.haber, 0);
            if (Math.abs(sumDebe - sumHaber) > 0.01) {
              console.log(`[PA] Asiento no cuadra: Debe ${sumDebe} / Haber ${sumHaber} — se omite`);
              lineas = null;
            }
          }
        }
      }

      if (lineas && lineas.length >= 2) {
        const año = new Date().getFullYear();
        const ultimo = dbPa.prepare(`SELECT ref_codigo FROM pa_asientos WHERE ref_codigo LIKE 'FAC-${año}-%' ORDER BY id DESC LIMIT 1`).get();
        let seq = 1;
        if (ultimo?.ref_codigo) { const p = ultimo.ref_codigo.split('-'); seq = (parseInt(p[2])||0)+1; }
        const refCodigo = `FAC-${año}-${String(seq).padStart(4,'0')}`;
        const prov = dbPa.prepare('SELECT razon_social FROM adm_proveedores WHERE id=?').get(parseInt(proveedor_id));
        const desc = `${refCodigo} | ${prov?.razon_social||'Proveedor'} | ${nro_factura||'S/N'}`;
        const fechaCompra = req.body.fecha || new Date().toISOString().slice(0,10);

        const txAsiento = dbPa.transaction(() => {
          const ra = dbPa.prepare('INSERT INTO pa_asientos (fecha, descripcion, usuario_id, ref_compra_id, ref_codigo) VALUES (?,?,?,?,?)')
            .run(fechaCompra, desc, req.user?.id||null, id, refCodigo);
          const ins = dbPa.prepare('INSERT INTO pa_asientos_lineas (asiento_id, cuenta_id, debe, haber, descripcion) VALUES (?,?,?,?,?)');
          for (const l of lineas) {
            const cuentaExiste = dbPa.prepare('SELECT id FROM pa_cuentas WHERE id=?').get(parseInt(l.cuenta_id));
            if (!cuentaExiste) {
              throw new Error(`Cuenta ID ${l.cuenta_id} no existe. Actualizá el Asiento Modelo del proveedor con las cuentas del nuevo plan de cuentas.`);
            }
            ins.run(ra.lastInsertRowid, l.cuenta_id, parseFloat(l.debe)||0, parseFloat(l.haber)||0, l.descripcion||null);
          }
          return refCodigo;
        });
        asientoRef = txAsiento();
        console.log(`[PA] Asiento ${asientoRef} generado para compra #${id} (usuario: ${req.user?.id})`);
      }
    } catch(eA) {
      console.error('[PA] Error generando asiento para compra #'+id+':', eA.message);
      // Compra guardada OK — asiento falló, avisar al usuario
      return res.json({ ok: true, id, neto_total, iva_total, total, asiento_ref: null, asiento_error: eA.message });
    }

    res.json({ ok: true, id, neto_total, iva_total, total, asiento_ref: asientoRef });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// ÓRDENES DE APLICACIÓN
// ─────────────────────────────────────────────────────────────────────────

router.get('/ordenes', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { estado, campaña_id, campaña_anual_id, campaña_estacional_id } = req.query;
    let query = `
      SELECT o.*, u.nombre as creada_por_nombre, ca.nombre as campaña_nombre,
             can.nombre as campaña_anual_nombre, ces.nombre as campaña_estacional_nombre,
             ua.nombre as asignado_nombre
      FROM pa_ordenes o
      LEFT JOIN usuarios u ON u.id = o.creada_por
      LEFT JOIN pa_campañas ca ON ca.id = o.campaña_id
      LEFT JOIN pa_campañas can ON can.id = o.campaña_anual_id
      LEFT JOIN pa_campañas ces ON ces.id = o.campaña_estacional_id
      LEFT JOIN usuarios ua ON ua.id = o.asignado_a
      WHERE o.eliminada_en IS NULL
    `;
    const params = [];
    if (estado) { query += " AND o.estado = ?"; params.push(estado); }
    // Filtros de campaña por tipo (independientes). campaña_id viejo = anual.
    if (campaña_anual_id) { query += " AND o.campaña_anual_id = ?"; params.push(campaña_anual_id); }
    if (campaña_estacional_id) { query += " AND o.campaña_estacional_id = ?"; params.push(campaña_estacional_id); }
    if (campaña_id && !campaña_anual_id) { query += " AND o.campaña_anual_id = ?"; params.push(campaña_id); }
    query += " ORDER BY o.fecha_orden DESC";
    const ordenes = db.prepare(query).all(...params);

    // Enriquecer cada orden con lotes e items
    const getLotes = db.prepare(`
      SELECT ol.lote_id, ol.hectareas_aplicadas, l.nombre as lote_nombre, l.hectareas,
             l.finca, s.nombre as sector_nombre,
             cl.cultivo as cultivo
      FROM pa_ordenes_lotes ol
      JOIN pa_lotes l ON l.id = ol.lote_id
      JOIN pa_sectores s ON s.id = l.sector_id
      LEFT JOIN pa_cultivos_lote cl ON cl.lote_id = l.id
        AND cl.campaña = (SELECT nombre FROM pa_campañas WHERE activa = 1 LIMIT 1)
      WHERE ol.orden_id = ?
    `);
    const getItems = db.prepare(`
      SELECT oi.*, i.nombre as insumo_nombre, i.unidad
      FROM pa_ordenes_items oi
      JOIN pa_insumos i ON i.id = oi.insumo_id
      WHERE oi.orden_id = ?
    `);
    // Costo real ejecutado de la orden: suma de los costos registrados al aplicar
    // (pa_aplicaciones.costo_total se costea con el precio de la última compra).
    // Las órdenes no ejecutadas todavía no tienen aplicaciones => costo 0.
    const getCosto = db.prepare(
      "SELECT COALESCE(SUM(costo_total), 0) AS costo FROM pa_aplicaciones WHERE orden_id = ?"
    );

    const data = ordenes.map(o => {
      const lotes = getLotes.all(o.id);
      const items = getItems.all(o.id);
      const cultivos = [...new Set(lotes.map(l => l.cultivo).filter(Boolean))];
      const finca_nombres = [...new Set(lotes.map(l => l.finca).filter(Boolean))];
      const costo_total = getCosto.get(o.id).costo;
      return { ...o, lotes, items, cultivos, finca_nombres, costo_total };
    });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── REASIGNACIÓN BULK DE CAMPAÑA — helper de auditoría ─────────────────────
function _logCampañaBulk(db, req, { entidad, cantidad, campaña_anual_id, campaña_estacional_id, limpiar_estacional, ids }) {
  try {
    db.prepare(`
      INSERT INTO pa_campañas_log
        (accion, entidad, cantidad, campaña_anual_id, campaña_estacional_id, limpiar_estacional, ids_afectados, usuario_id, usuario_nombre)
      VALUES ('reasignar_bulk', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entidad, cantidad, campaña_anual_id || null, campaña_estacional_id || null,
           limpiar_estacional ? 1 : 0, JSON.stringify(ids || []),
           req.user?.id || null, req.user?.nombre || null);
  } catch(e) { console.error('[PA] Error logueando reasignación bulk:', e.message); }
}

// IMPORTANTE: esta ruta va ANTES de GET /ordenes/:id para que el param no la capture.
// Preview de órdenes candidatas a reasignación, según filtros.
router.get('/ordenes/buscar-para-reasignacion', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const { cultivo, desde, hasta, campaña_anual_id, campaña_estacional_id, estado } = req.query;
    const conds = ["o.eliminada_en IS NULL"]; const params = [];
    if (cultivo) { conds.push("o.cultivo = ?"); params.push(cultivo); }
    if (desde)   { conds.push("o.fecha_orden >= ?"); params.push(desde); }
    if (hasta)   { conds.push("o.fecha_orden <= ?"); params.push(hasta); }
    if (campaña_anual_id) { conds.push("o.campaña_anual_id = ?"); params.push(campaña_anual_id); }
    if (campaña_estacional_id === 'null') { conds.push("o.campaña_estacional_id IS NULL"); }
    else if (campaña_estacional_id) { conds.push("o.campaña_estacional_id = ?"); params.push(campaña_estacional_id); }
    if (estado) { conds.push("o.estado = ?"); params.push(estado); }

    const ordenes = db.prepare(`
      SELECT o.id, o.nro_orden, o.fecha_orden, o.cultivo, o.estado,
             o.campaña_anual_id, o.campaña_estacional_id,
             can.nombre AS campaña_anual_nombre, ces.nombre AS campaña_estacional_nombre,
             (SELECT COALESCE(SUM(costo_total),0) FROM pa_aplicaciones WHERE orden_id = o.id) AS costo_total,
             (SELECT COUNT(*) FROM pa_ordenes_lotes WHERE orden_id = o.id) AS lotes_count
      FROM pa_ordenes o
      LEFT JOIN pa_campañas can ON can.id = o.campaña_anual_id
      LEFT JOIN pa_campañas ces ON ces.id = o.campaña_estacional_id
      WHERE ${conds.join(' AND ')}
      ORDER BY o.fecha_orden DESC
    `).all(...params);
    res.json({ ok: true, data: ordenes });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Reasignación bulk de campaña sobre órdenes seleccionadas (transaccional).
router.post('/ordenes/reasignar-bulk', requireAdmin, (req, res) => {
  const db = getDb();
  const { orden_ids, campaña_anual_id, campaña_estacional_id, limpiar_estacional } = req.body;
  const ids = Array.isArray(orden_ids) ? orden_ids.map(Number).filter(n => n > 0) : [];
  if (!ids.length) return res.status(400).json({ ok: false, error: 'Seleccioná al menos una orden' });
  if (!campaña_anual_id && !campaña_estacional_id && !limpiar_estacional)
    return res.status(400).json({ ok: false, error: 'No hay ningún cambio para aplicar' });
  if (campaña_estacional_id && limpiar_estacional)
    return res.status(400).json({ ok: false, error: 'No podés asignar y limpiar la campaña estacional a la vez' });
  try {
    const sets = [], baseParams = [];
    if (campaña_anual_id) { sets.push("campaña_anual_id = ?"); baseParams.push(campaña_anual_id); }
    if (limpiar_estacional) { sets.push("campaña_estacional_id = NULL"); }
    else if (campaña_estacional_id) { sets.push("campaña_estacional_id = ?"); baseParams.push(campaña_estacional_id); }

    const ph = ids.map(() => '?').join(',');
    const stmt = db.prepare(`UPDATE pa_ordenes SET ${sets.join(', ')} WHERE id IN (${ph}) AND eliminada_en IS NULL`);
    // Arreglo de raíz: tras reasignar la orden, propagar sus campañas FINALES a los
    // costos fert/agro de esa orden (vía pa_aplicaciones), en la misma transacción.
    // Se deriva de la orden ya actualizada, así cubre cambio de anual, de estacional,
    // limpieza de estacional (NULL) y campos sin cambiar, sin replicar la lógica condicional.
    // campaña_id es NOT NULL → COALESCE(anual, estacional, actual).
    const propagarCostos = db.prepare(`
      UPDATE pa_costos_lote
      SET campaña_anual_id      = (SELECT o.campaña_anual_id      FROM pa_aplicaciones a JOIN pa_ordenes o ON o.id=a.orden_id WHERE a.id = pa_costos_lote.referencia_id),
          campaña_estacional_id = (SELECT o.campaña_estacional_id FROM pa_aplicaciones a JOIN pa_ordenes o ON o.id=a.orden_id WHERE a.id = pa_costos_lote.referencia_id),
          campaña_id            = COALESCE(
                                    (SELECT o.campaña_anual_id      FROM pa_aplicaciones a JOIN pa_ordenes o ON o.id=a.orden_id WHERE a.id = pa_costos_lote.referencia_id),
                                    (SELECT o.campaña_estacional_id FROM pa_aplicaciones a JOIN pa_ordenes o ON o.id=a.orden_id WHERE a.id = pa_costos_lote.referencia_id),
                                    pa_costos_lote.campaña_id)
      WHERE categoria IN ('fertilizante','agroquimico')
        AND referencia_id IN (SELECT id FROM pa_aplicaciones WHERE orden_id IN (${ph}))
    `);
    const tx = db.transaction(() => {
      const info = stmt.run(...baseParams, ...ids);
      propagarCostos.run(...ids);
      _logCampañaBulk(db, req, { entidad: 'orden', cantidad: info.changes, campaña_anual_id, campaña_estacional_id, limpiar_estacional, ids });
      return info.changes;
    });
    res.json({ ok: true, data: { actualizadas: tx() } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Preview de COMPRAS candidatas a reasignación (compras no tienen cultivo;
// se filtran por fecha, proveedor y campañas).
router.get('/compras/buscar-para-reasignacion', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const { proveedor, desde, hasta, campaña_anual_id, campaña_estacional_id } = req.query;
    const conds = ["(c.activo IS NULL OR c.activo = 1)"]; const params = [];
    if (proveedor) { conds.push("UPPER(TRIM(COALESCE(c.proveedor_txt,''))) LIKE ?"); params.push('%' + String(proveedor).trim().toUpperCase() + '%'); }
    if (desde) { conds.push("c.fecha >= ?"); params.push(desde); }
    if (hasta) { conds.push("c.fecha <= ?"); params.push(hasta); }
    if (campaña_anual_id) { conds.push("c.campaña_anual_id = ?"); params.push(campaña_anual_id); }
    if (campaña_estacional_id === 'null') { conds.push("c.campaña_estacional_id IS NULL"); }
    else if (campaña_estacional_id) { conds.push("c.campaña_estacional_id = ?"); params.push(campaña_estacional_id); }

    const compras = db.prepare(`
      SELECT c.id, c.fecha, c.nro_factura, c.proveedor_txt, c.total,
             c.campaña_anual_id, c.campaña_estacional_id,
             can.nombre AS campaña_anual_nombre, ces.nombre AS campaña_estacional_nombre
      FROM pa_compras c
      LEFT JOIN pa_campañas can ON can.id = c.campaña_anual_id
      LEFT JOIN pa_campañas ces ON ces.id = c.campaña_estacional_id
      WHERE ${conds.join(' AND ')}
      ORDER BY c.fecha DESC
    `).all(...params);
    res.json({ ok: true, data: compras });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Reasignación bulk de campaña sobre compras seleccionadas (transaccional).
// NOTA: las compras NO generan filas en pa_costos_lote (las únicas fuentes de costos
// son aplicaciones fert/agro, combustible y partes de MO; ver INSERTs en este archivo).
// El reporte de Costos por Lote (/costos) lee solo de pa_costos_lote, así que reasignar
// la campaña de una compra no afecta ese reporte → no hay nada que propagar acá.
router.post('/compras/reasignar-bulk', requireAdmin, (req, res) => {
  const db = getDb();
  const { compra_ids, campaña_anual_id, campaña_estacional_id, limpiar_estacional } = req.body;
  const ids = Array.isArray(compra_ids) ? compra_ids.map(Number).filter(n => n > 0) : [];
  if (!ids.length) return res.status(400).json({ ok: false, error: 'Seleccioná al menos una compra' });
  if (!campaña_anual_id && !campaña_estacional_id && !limpiar_estacional)
    return res.status(400).json({ ok: false, error: 'No hay ningún cambio para aplicar' });
  if (campaña_estacional_id && limpiar_estacional)
    return res.status(400).json({ ok: false, error: 'No podés asignar y limpiar la campaña estacional a la vez' });
  try {
    const sets = [], baseParams = [];
    if (campaña_anual_id) { sets.push("campaña_anual_id = ?"); baseParams.push(campaña_anual_id); }
    if (limpiar_estacional) { sets.push("campaña_estacional_id = NULL"); }
    else if (campaña_estacional_id) { sets.push("campaña_estacional_id = ?"); baseParams.push(campaña_estacional_id); }

    const ph = ids.map(() => '?').join(',');
    const stmt = db.prepare(`UPDATE pa_compras SET ${sets.join(', ')} WHERE id IN (${ph}) AND (activo IS NULL OR activo = 1)`);
    const tx = db.transaction(() => {
      const info = stmt.run(...baseParams, ...ids);
      _logCampañaBulk(db, req, { entidad: 'compra', cantidad: info.changes, campaña_anual_id, campaña_estacional_id, limpiar_estacional, ids });
      return info.changes;
    });
    res.json({ ok: true, data: { actualizadas: tx() } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/ordenes/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const orden = db.prepare(`
      SELECT o.*, u.nombre as creada_por_nombre, ca.nombre as campaña_nombre
      FROM pa_ordenes o
      LEFT JOIN usuarios u ON u.id = o.creada_por
      LEFT JOIN pa_campañas ca ON ca.id = o.campaña_id
      WHERE o.id = ? AND o.eliminada_en IS NULL
    `).get(req.params.id);
    if (!orden) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });

    orden.lotes = db.prepare(`
      SELECT ol.lote_id, ol.hectareas_aplicadas, l.nombre as lote_nombre, l.hectareas,
             s.nombre as sector_nombre,
             cl.cultivo as cultivo
      FROM pa_ordenes_lotes ol
      JOIN pa_lotes l ON l.id = ol.lote_id
      JOIN pa_sectores s ON s.id = l.sector_id
      LEFT JOIN pa_cultivos_lote cl ON cl.lote_id = l.id
        AND cl.campaña = (SELECT nombre FROM pa_campañas WHERE activa=1 LIMIT 1)
      WHERE ol.orden_id = ?
    `).all(req.params.id);

    orden.items = db.prepare(`
      SELECT oi.*, i.nombre as insumo_nombre, i.unidad, i.stock_actual
      FROM pa_ordenes_items oi
      JOIN pa_insumos i ON i.id = oi.insumo_id
      WHERE oi.orden_id = ?
    `).all(req.params.id);

    orden.aplicaciones = db.prepare(`
      SELECT a.*, l.nombre as lote_nombre, i.nombre as insumo_nombre, i.unidad,
             u.nombre as ejecutado_por_nombre
      FROM pa_aplicaciones a
      JOIN pa_lotes l ON l.id = a.lote_id
      JOIN pa_insumos i ON i.id = a.insumo_id
      LEFT JOIN usuarios u ON u.id = a.ejecutado_por
      WHERE a.orden_id = ?
      ORDER BY a.fecha_real DESC
    `).all(req.params.id);

    res.json({ ok: true, data: orden });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/ordenes', requireAuth, (req, res) => {
  const db = getDb();
  const { campaña_id, campaña_anual_id, campaña_estacional_id, cultivo,
          fecha_orden, fecha_propuesta, tipo_aplicacion, objetivo, notas, lotes, items, asignado_a } = req.body;
  if (!lotes?.length || !items?.length)
    return res.status(400).json({ ok: false, error: 'Debe incluir lotes e items' });
  // Cultivo obligatorio: el operario lo elige explícitamente al emitir la orden.
  const cultivoTrim = (typeof cultivo === 'string') ? cultivo.trim() : '';
  if (!cultivoTrim) return res.status(400).json({ ok: false, error: 'Cultivo requerido' });

  // Normalizar lotes: acepta array de números (formato viejo, todo completo)
  // o array de objetos {lote_id, hectareas_aplicadas} (formato nuevo).
  const lotesNorm = lotes.map(l => {
    if (typeof l === 'number' || typeof l === 'string') {
      return { lote_id: Number(l), hectareas_aplicadas: null };
    }
    const ha = l.hectareas_aplicadas;
    return {
      lote_id: Number(l.lote_id),
      hectareas_aplicadas: (ha === null || ha === undefined || ha === '') ? null : Number(ha)
    };
  });

  // Validar parciales: 0 < ha_aplicadas <= ha_total del lote
  for (const ln of lotesNorm) {
    if (!ln.lote_id) return res.status(400).json({ ok: false, error: 'lote_id inválido' });
    if (ln.hectareas_aplicadas !== null) {
      if (!(ln.hectareas_aplicadas > 0))
        return res.status(400).json({ ok: false, error: 'Hectáreas aplicadas debe ser mayor a 0' });
      const lote = db.prepare("SELECT hectareas, nombre FROM pa_lotes WHERE id=?").get(ln.lote_id);
      if (!lote) return res.status(400).json({ ok: false, error: `Lote ${ln.lote_id} no existe` });
      if (ln.hectareas_aplicadas > lote.hectareas + 1e-6)
        return res.status(400).json({ ok: false, error: `Lote ${lote.nombre}: ${ln.hectareas_aplicadas} ha excede las ${lote.hectareas} ha del lote` });
    }
  }

  // El cultivo debe estar cargado en pa_cultivos_lote de al menos uno de los lotes.
  const loteIds = lotesNorm.map(l => l.lote_id);
  const phLotes = loteIds.map(() => '?').join(',');
  const cultivoMatch = db.prepare(
    `SELECT 1 FROM pa_cultivos_lote WHERE lote_id IN (${phLotes}) AND cultivo = ? LIMIT 1`
  ).get(...loteIds, cultivoTrim);
  if (!cultivoMatch)
    return res.status(400).json({ ok: false, error: 'El cultivo no corresponde a los lotes seleccionados' });

  try {
    const crearOrden = db.transaction(() => {
      // Campañas: si el body trae ids explícitos los usamos; si no, autoasignamos
      // las dos activas (una anual + una estacional). campaña_id viejo = anual.
      const act = campañasActivas(db);
      const anualFinal      = campaña_anual_id || campaña_id || act.anualId || null;
      const estacionalFinal = campaña_estacional_id || act.estacionalId || null;
      const campañaIdFinal  = anualFinal; // retrocompat columna vieja
      const n = db.prepare("SELECT COUNT(*) as n FROM pa_ordenes").get().n + 1;
      const nro = `OA-${String(n).padStart(5, '0')}`;
      const r = db.prepare(`
        INSERT INTO pa_ordenes (nro_orden, campaña_id, campaña_anual_id, campaña_estacional_id, cultivo, fecha_orden, fecha_propuesta, creada_por, tipo_aplicacion, objetivo, notas, estado, asignado_a)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'emitida',?)
      `).run(nro, campañaIdFinal, anualFinal, estacionalFinal, cultivoTrim,
             fecha_orden||new Date().toISOString().slice(0,10),
             fecha_propuesta||null, req.user.id, tipo_aplicacion||null, objetivo||null, notas||null, asignado_a||null);
      const ordenId = r.lastInsertRowid;
      const insLote = db.prepare("INSERT INTO pa_ordenes_lotes (orden_id, lote_id, hectareas_aplicadas) VALUES (?,?,?)");
      for (const ln of lotesNorm) {
        insLote.run(ordenId, ln.lote_id, ln.hectareas_aplicadas);
      }
      for (const it of items) {
        db.prepare("INSERT INTO pa_ordenes_items (orden_id, insumo_id, dosis, unidad_dosis, notas) VALUES (?,?,?,?,?)")
          .run(ordenId, it.insumo_id, it.dosis, it.unidad_dosis, it.notas||null);
      }
      return { id: ordenId, nro_orden: nro };
    });
    const result = crearOrden();
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/ordenes/:id/estado', requireAuth, (req, res) => {
  const db = getDb();
  const { estado } = req.body;
  const estadosValidos = ['borrador','emitida','en_ejecucion','ejecutada','parcial','anulada'];
  if (!estadosValidos.includes(estado))
    return res.status(400).json({ ok: false, error: 'Estado inválido' });
  try {
    db.prepare("UPDATE pa_ordenes SET estado = ? WHERE id = ?").run(estado, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE — eliminar orden de aplicación (HARD DELETE, solo admin).
// Limpia: pa_aplicaciones, pa_ordenes_items, pa_ordenes_lotes, pa_ordenes.
// Revierte: stock descontado en pa_insumos, pa_movimientos_stock (motivo=aplicacion),
//           pa_costos_lote (referencia_id de las aplicaciones borradas).
// Desvincula (NO borra): pa_combustible_movimientos.orden_id -> NULL.
// PATCH /ordenes/:id — editar orden (solo si estado = emitida y no eliminada)
// Permite modificar: fecha_orden, fecha_propuesta, tipo_aplicacion, objetivo, notas,
// asignado_a, lotes (con sus parciales), items (productos y dosis).
router.patch('/ordenes/:id', requireAuth, (req, res) => {
  const db = getDb();
  const ordenId = req.params.id;
  const { fecha_orden, fecha_propuesta, tipo_aplicacion, objetivo, notas,
          asignado_a, lotes, items, cultivo,
          campaña_id, campaña_anual_id, campaña_estacional_id } = req.body;

  try {
    const orden = db.prepare("SELECT * FROM pa_ordenes WHERE id = ? AND eliminada_en IS NULL").get(ordenId);
    if (!orden) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });
    if (orden.estado !== 'emitida') {
      return res.status(400).json({ ok: false, error: 'Solo se pueden editar órdenes en estado "emitida"' });
    }
    // Cultivo (opcional en edición). Si viene, no puede quedar vacío y debe
    // corresponder a alguno de los lotes (los nuevos si se mandan, o los actuales).
    const cultivoTrim = (cultivo !== undefined) ? String(cultivo || '').trim() : undefined;
    if (cultivoTrim !== undefined && !cultivoTrim)
      return res.status(400).json({ ok: false, error: 'Cultivo requerido' });

    // Normalizar lotes (mismo formato que POST)
    let lotesNorm = null;
    if (Array.isArray(lotes)) {
      lotesNorm = lotes.map(l => {
        if (typeof l === 'number' || typeof l === 'string') {
          return { lote_id: Number(l), hectareas_aplicadas: null };
        }
        const ha = l.hectareas_aplicadas;
        return {
          lote_id: Number(l.lote_id),
          hectareas_aplicadas: (ha === null || ha === undefined || ha === '') ? null : Number(ha)
        };
      });
      if (lotesNorm.length === 0) {
        return res.status(400).json({ ok: false, error: 'Debe haber al menos un lote' });
      }
      // Validar parciales
      for (const ln of lotesNorm) {
        if (!ln.lote_id) return res.status(400).json({ ok: false, error: 'lote_id inválido' });
        if (ln.hectareas_aplicadas !== null) {
          if (!(ln.hectareas_aplicadas > 0))
            return res.status(400).json({ ok: false, error: 'Hectáreas aplicadas debe ser mayor a 0' });
          const lote = db.prepare("SELECT hectareas, nombre FROM pa_lotes WHERE id=?").get(ln.lote_id);
          if (!lote) return res.status(400).json({ ok: false, error: `Lote ${ln.lote_id} no existe` });
          if (ln.hectareas_aplicadas > lote.hectareas + 1e-6)
            return res.status(400).json({ ok: false, error: `Lote ${lote.nombre}: ${ln.hectareas_aplicadas} ha excede las ${lote.hectareas} ha del lote` });
        }
      }
    }

    if (Array.isArray(items) && items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Debe haber al menos un producto' });
    }

    // Validar cultivo contra los lotes (nuevos si se mandan, si no los actuales)
    if (cultivoTrim !== undefined) {
      const loteIds = lotesNorm
        ? lotesNorm.map(l => l.lote_id)
        : db.prepare("SELECT lote_id FROM pa_ordenes_lotes WHERE orden_id = ?").all(ordenId).map(r => r.lote_id);
      if (loteIds.length) {
        const phLotes = loteIds.map(() => '?').join(',');
        const match = db.prepare(
          `SELECT 1 FROM pa_cultivos_lote WHERE lote_id IN (${phLotes}) AND cultivo = ? LIMIT 1`
        ).get(...loteIds, cultivoTrim);
        if (!match)
          return res.status(400).json({ ok: false, error: 'El cultivo no corresponde a los lotes seleccionados' });
      }
    }

    const tx = db.transaction(() => {
      // Campos simples
      const sets = [], params = { id: ordenId };
      if (fecha_orden     !== undefined) { sets.push("fecha_orden = @fecha_orden");         params.fecha_orden     = fecha_orden; }
      if (fecha_propuesta !== undefined) { sets.push("fecha_propuesta = @fecha_propuesta"); params.fecha_propuesta = fecha_propuesta || null; }
      if (tipo_aplicacion !== undefined) { sets.push("tipo_aplicacion = @tipo_aplicacion"); params.tipo_aplicacion = tipo_aplicacion || null; }
      if (objetivo        !== undefined) { sets.push("objetivo = @objetivo");               params.objetivo        = objetivo        || null; }
      if (notas           !== undefined) { sets.push("notas = @notas");                     params.notas           = notas           || null; }
      if (asignado_a      !== undefined) { sets.push("asignado_a = @asignado_a");           params.asignado_a      = asignado_a      || null; }
      if (cultivoTrim     !== undefined) { sets.push("cultivo = @cultivo");                 params.cultivo         = cultivoTrim; }
      // Campañas: campaña_id (legacy) si llega va a la anual. La canónica es
      // campaña_anual_id; la estacional es opcional (puede limpiarse a NULL).
      const campAnualEdit = (campaña_anual_id !== undefined) ? campaña_anual_id
                          : (campaña_id !== undefined) ? campaña_id : undefined;
      if (campAnualEdit !== undefined) { sets.push("campaña_anual_id = @camp_anual"); params.camp_anual = campAnualEdit || null; }
      if (campaña_estacional_id !== undefined) { sets.push("campaña_estacional_id = @camp_estac"); params.camp_estac = campaña_estacional_id || null; }
      if (sets.length > 0) {
        db.prepare(`UPDATE pa_ordenes SET ${sets.join(", ")} WHERE id = @id`).run(params);
      }

      // Reemplazar lotes si vinieron en el body
      if (lotesNorm) {
        db.prepare("DELETE FROM pa_ordenes_lotes WHERE orden_id = ?").run(ordenId);
        const insLote = db.prepare("INSERT INTO pa_ordenes_lotes (orden_id, lote_id, hectareas_aplicadas) VALUES (?,?,?)");
        for (const ln of lotesNorm) {
          insLote.run(ordenId, ln.lote_id, ln.hectareas_aplicadas);
        }
      }

      // Reemplazar items si vinieron en el body
      if (Array.isArray(items)) {
        db.prepare("DELETE FROM pa_ordenes_items WHERE orden_id = ?").run(ordenId);
        const insItem = db.prepare("INSERT INTO pa_ordenes_items (orden_id, insumo_id, dosis, unidad_dosis, notas) VALUES (?,?,?,?,?)");
        for (const it of items) {
          insItem.run(ordenId, it.insumo_id, it.dosis, it.unidad_dosis, it.notas || null);
        }
      }
    });
    tx();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /ordenes/:id — soft delete. Solo si estado = emitida (no tiene ejecuciones).
// Para borrado físico con revert de stock, ver /ordenes/:id/hard (admin).
router.delete('/ordenes/:id', requireAuth, (req, res) => {
  const db = getDb();
  const ordenId = req.params.id;
  try {
    const orden = db.prepare("SELECT * FROM pa_ordenes WHERE id = ?").get(ordenId);
    if (!orden) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });
    if (orden.eliminada_en) return res.json({ ok: true, msg: 'Ya estaba eliminada' });
    if (orden.estado !== 'emitida') {
      return res.status(400).json({
        ok: false,
        error: 'Solo se pueden eliminar órdenes en estado "emitida". Esta orden está "' + orden.estado + '" y tiene ejecuciones registradas.'
      });
    }
    db.prepare("UPDATE pa_ordenes SET eliminada_en = datetime('now','localtime'), eliminada_por_id = ? WHERE id = ?")
      .run(req.user.id, ordenId);
    res.json({ ok: true, nro_orden: orden.nro_orden });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /ordenes/:id/hard — borrado físico con revert de stock. Solo admin.
// Esta es la lógica antigua: revertir todas las aplicaciones (devolver stock,
// borrar movimientos y costos), desvincular combustible, y borrar la orden.
router.delete('/ordenes/:id/hard', requireAuth, (req, res) => {
  if (req.user.rol !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Solo admin puede hacer borrado físico' });
  }
  const db = getDb();
  const ordenId = req.params.id;
  try {
    const orden = db.prepare("SELECT * FROM pa_ordenes WHERE id=?").get(ordenId);
    if (!orden) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });

    const tx = db.transaction(() => {
      const aplicaciones = db.prepare(
        "SELECT id, insumo_id, cantidad_real FROM pa_aplicaciones WHERE orden_id=?"
      ).all(ordenId);

      let stockRevertido = 0;
      let movStockBorrados = 0;
      let costosLoteBorrados = 0;

      for (const a of aplicaciones) {
        if (a.insumo_id && a.cantidad_real) {
          db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual + ? WHERE id = ?")
            .run(a.cantidad_real, a.insumo_id);
          stockRevertido++;
        }
        movStockBorrados += db.prepare(
          "DELETE FROM pa_movimientos_stock WHERE motivo='aplicacion' AND referencia_id=?"
        ).run(a.id).changes;
        costosLoteBorrados += db.prepare(
          "DELETE FROM pa_costos_lote WHERE categoria IN ('fertilizante','agroquimico') AND referencia_id=?"
        ).run(a.id).changes;
      }

      const combDesvinc = db.prepare(
        "UPDATE pa_combustible_movimientos SET orden_id=NULL WHERE orden_id=?"
      ).run(ordenId).changes;

      const aplicsBorradas = db.prepare("DELETE FROM pa_aplicaciones WHERE orden_id=?").run(ordenId).changes;
      const itemsBorrados  = db.prepare("DELETE FROM pa_ordenes_items WHERE orden_id=?").run(ordenId).changes;
      const lotesBorrados  = db.prepare("DELETE FROM pa_ordenes_lotes WHERE orden_id=?").run(ordenId).changes;

      db.prepare("DELETE FROM pa_ordenes WHERE id=?").run(ordenId);

      return {
        nro_orden: orden.nro_orden,
        aplicaciones: aplicsBorradas,
        items: itemsBorrados,
        lotes: lotesBorrados,
        stock_revertido: stockRevertido,
        movimientos_stock_borrados: movStockBorrados,
        costos_lote_borrados: costosLoteBorrados,
        combustible_desvinculado: combDesvinc
      };
    });

    const detalle = tx();
    res.json({ ok: true, eliminada: detalle });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// APLICACIONES (ejecución real de una orden)
// ─────────────────────────────────────────────────────────────────────────

router.post('/aplicaciones', requireAuth, (req, res) => {
  const db = getDb();
  const { orden_id, lote_id, insumo_id, fecha_real, cantidad_real, ejecutado_txt, notas } = req.body;
  if (!orden_id || !lote_id || !insumo_id || !cantidad_real)
    return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios' });
  try {
    const registrar = db.transaction(() => {
      // Obtener precio unitario promedio del stock para costear
      const insumo = db.prepare("SELECT * FROM pa_insumos WHERE id=?").get(insumo_id);
      if (!insumo) throw new Error('Insumo no encontrado');

      // Calcular costo unitario (última compra)
      const ultimaCompra = db.prepare(`
        SELECT ci.precio_unit FROM pa_compras_items ci
        JOIN pa_compras c ON c.id = ci.compra_id
        WHERE ci.insumo_id = ?
        ORDER BY c.fecha DESC LIMIT 1
      `).get(insumo_id);
      const costoUnit = ultimaCompra?.precio_unit || 0;
      const costoTotal = costoUnit * cantidad_real;

      const r = db.prepare(`
        INSERT INTO pa_aplicaciones
          (orden_id, lote_id, insumo_id, fecha_real, cantidad_real, ejecutado_por, ejecutado_txt, costo_unitario, costo_total, notas)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(orden_id, lote_id, insumo_id,
             fecha_real || new Date().toISOString().slice(0,10),
             cantidad_real, req.user.id, ejecutado_txt||null, costoUnit, costoTotal, notas||null);

      // Descontar stock
      db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual - ? WHERE id = ?")
        .run(cantidad_real, insumo_id);

      // Movimiento de stock
      db.prepare(`
        INSERT INTO pa_movimientos_stock (fecha, insumo_id, tipo, cantidad, motivo, referencia_id)
        VALUES (?,?,?,?,?,?)
      `).run(fecha_real || new Date().toISOString().slice(0,10), insumo_id, 'salida', cantidad_real, 'aplicacion', r.lastInsertRowid);

      // Registrar costo por lote, imputado a las DOS campañas de la orden
      // (anual + estacional). Si la orden no tiene campaña, fallback a las activas.
      let campAnual = null, campEstacional = null;
      const ordenCamp = db.prepare("SELECT campaña_id, campaña_anual_id, campaña_estacional_id FROM pa_ordenes WHERE id=?").get(orden_id);
      campAnual      = ordenCamp?.campaña_anual_id || ordenCamp?.campaña_id || null;
      campEstacional = ordenCamp?.campaña_estacional_id || null;
      if (!campAnual && !campEstacional) {
        const act = campañasActivas(db);
        campAnual = act.anualId; campEstacional = act.estacionalId;
        // Asociar las campañas a la orden huérfana
        if (campAnual) db.prepare("UPDATE pa_ordenes SET campaña_id = COALESCE(campaña_id, ?), campaña_anual_id = COALESCE(campaña_anual_id, ?) WHERE id = ?").run(campAnual, campAnual, orden_id);
        if (campEstacional) db.prepare("UPDATE pa_ordenes SET campaña_estacional_id = COALESCE(campaña_estacional_id, ?) WHERE id = ?").run(campEstacional, orden_id);
      }
      const campañaParaCosto = campAnual || campEstacional; // campaña_id viejo (NOT NULL deseable)
      if (campañaParaCosto && costoTotal > 0) {
        const insumoData = db.prepare("SELECT tipo FROM pa_insumos WHERE id=?").get(insumo_id);
        const categoria = insumoData?.tipo === 'fertilizante' ? 'fertilizante' : 'agroquimico';
        db.prepare(`
          INSERT INTO pa_costos_lote (lote_id, campaña_id, campaña_anual_id, campaña_estacional_id, categoria, referencia_id, fecha, monto, descripcion)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).run(lote_id, campañaParaCosto, campAnual, campEstacional, categoria, r.lastInsertRowid,
               fecha_real || new Date().toISOString().slice(0,10), costoTotal,
               `Aplicación OA: ${insumo?.nombre}`);
      }

      // Actualizar estado de orden
      const totalLotes = db.prepare("SELECT COUNT(*) as n FROM pa_ordenes_lotes WHERE orden_id=?").get(orden_id).n;
      const lotesAplicados = db.prepare("SELECT COUNT(DISTINCT lote_id) as n FROM pa_aplicaciones WHERE orden_id=?").get(orden_id).n;
      const nuevoEstado = lotesAplicados >= totalLotes ? 'ejecutada' : 'en_ejecucion';
      db.prepare("UPDATE pa_ordenes SET estado=? WHERE id=?").run(nuevoEstado, orden_id);

      return r.lastInsertRowid;
    });

    const id = registrar();
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /aplicaciones/batch — registrar múltiples ejecuciones en una sola transacción
// Body: { orden_id, fecha_real, ejecutado_txt, ejecuciones: [{lote_id, insumo_id, cantidad_real, notas?}] }
// Sólo se registran las ejecuciones con cantidad_real > 0; el resto se ignora.
router.post('/aplicaciones/batch', requireAuth, (req, res) => {
  const db = getDb();
  const { orden_id, fecha_real, ejecutado_txt, notas, ejecuciones } = req.body;
  if (!orden_id) return res.status(400).json({ ok: false, error: 'orden_id requerido' });
  if (!Array.isArray(ejecuciones) || ejecuciones.length === 0)
    return res.status(400).json({ ok: false, error: 'No hay ejecuciones para registrar' });

  // Filtrar las que tienen cantidad > 0
  const validas = ejecuciones.filter(e =>
    e && e.lote_id && e.insumo_id &&
    Number(e.cantidad_real) > 0
  );
  if (validas.length === 0)
    return res.status(400).json({ ok: false, error: 'Ingresá al menos una cantidad mayor a 0' });

  try {
    const fechaFinal = fecha_real || new Date().toISOString().slice(0,10);
    const orden = db.prepare("SELECT campaña_id, campaña_anual_id, campaña_estacional_id FROM pa_ordenes WHERE id=?").get(orden_id);
    if (!orden) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });

    // Resolver las DOS campañas de la orden (anual + estacional), o las activas
    // como fallback. Si la orden estaba huérfana, aprovechamos para asociarlas.
    let campAnual = orden.campaña_anual_id || orden.campaña_id || null;
    let campEstacional = orden.campaña_estacional_id || null;
    if (!campAnual && !campEstacional) {
      const act = campañasActivas(db);
      campAnual = act.anualId; campEstacional = act.estacionalId;
      if (campAnual) db.prepare("UPDATE pa_ordenes SET campaña_id = COALESCE(campaña_id, ?), campaña_anual_id = COALESCE(campaña_anual_id, ?) WHERE id = ?").run(campAnual, campAnual, orden_id);
      if (campEstacional) db.prepare("UPDATE pa_ordenes SET campaña_estacional_id = COALESCE(campaña_estacional_id, ?) WHERE id = ?").run(campEstacional, orden_id);
    }
    const campañaParaCosto = campAnual || campEstacional;

    const registrar = db.transaction(() => {
      const ids = [];
      for (const ej of validas) {
        const insumo = db.prepare("SELECT * FROM pa_insumos WHERE id=?").get(ej.insumo_id);
        if (!insumo) throw new Error('Insumo no encontrado: ' + ej.insumo_id);

        // Costo unitario de última compra
        const ultimaCompra = db.prepare(`
          SELECT ci.precio_unit FROM pa_compras_items ci
          JOIN pa_compras c ON c.id = ci.compra_id
          WHERE ci.insumo_id = ?
          ORDER BY c.fecha DESC LIMIT 1
        `).get(ej.insumo_id);
        const costoUnit = ultimaCompra?.precio_unit || 0;
        const cantidad  = Number(ej.cantidad_real);
        const costoTotal = costoUnit * cantidad;

        const r = db.prepare(`
          INSERT INTO pa_aplicaciones
            (orden_id, lote_id, insumo_id, fecha_real, cantidad_real, ejecutado_por, ejecutado_txt, costo_unitario, costo_total, notas)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run(orden_id, ej.lote_id, ej.insumo_id,
               fechaFinal, cantidad, req.user.id,
               ejecutado_txt || null, costoUnit, costoTotal,
               (ej.notas || notas || null));

        // Stock
        db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual - ? WHERE id = ?")
          .run(cantidad, ej.insumo_id);

        // Movimiento
        db.prepare(`
          INSERT INTO pa_movimientos_stock (fecha, insumo_id, tipo, cantidad, motivo, referencia_id)
          VALUES (?,?,?,?,?,?)
        `).run(fechaFinal, ej.insumo_id, 'salida', cantidad, 'aplicacion', r.lastInsertRowid);

        // Costo por lote — imputado a las dos campañas (anual + estacional)
        if (campañaParaCosto && costoTotal > 0) {
          const categoria = insumo.tipo === 'fertilizante' ? 'fertilizante' : 'agroquimico';
          db.prepare(`
            INSERT INTO pa_costos_lote (lote_id, campaña_id, campaña_anual_id, campaña_estacional_id, categoria, referencia_id, fecha, monto, descripcion)
            VALUES (?,?,?,?,?,?,?,?,?)
          `).run(ej.lote_id, campañaParaCosto, campAnual, campEstacional, categoria, r.lastInsertRowid,
                 fechaFinal, costoTotal,
                 `Aplicación OA: ${insumo.nombre}`);
        }

        ids.push(r.lastInsertRowid);
      }

      // Estado de la orden — único cálculo al final, no por cada ejecución
      const totalLotes = db.prepare("SELECT COUNT(*) as n FROM pa_ordenes_lotes WHERE orden_id=?").get(orden_id).n;
      const lotesAplicados = db.prepare("SELECT COUNT(DISTINCT lote_id) as n FROM pa_aplicaciones WHERE orden_id=?").get(orden_id).n;
      const nuevoEstado = lotesAplicados >= totalLotes ? 'ejecutada' : 'en_ejecucion';
      db.prepare("UPDATE pa_ordenes SET estado=? WHERE id=?").run(nuevoEstado, orden_id);

      return ids;
    });

    const ids = registrar();
    res.json({ ok: true, ids, count: ids.length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// COSTOS POR LOTE (reportes)
// ─────────────────────────────────────────────────────────────────────────

router.get('/costos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    // Filtros de campaña independientes por tipo. campaña_id (viejo) = anual.
    const { campaña_id, campaña_anual_id, campaña_estacional_id, lote_id } = req.query;
    const anualFiltro = campaña_anual_id || campaña_id || null;
    const estacionalFiltro = campaña_estacional_id || null;
    const sectorFiltro = (req.query.sector || '').trim() || null;

    // WHERE dinámico sobre pa_costos_lote (cl). Si no viene ningún filtro,
    // por defecto usamos la campaña anual activa.
    const costoConds = [];
    const costoPrm = [];
    if (anualFiltro)      { costoConds.push("cl.campaña_anual_id = ?");      costoPrm.push(anualFiltro); }
    if (estacionalFiltro) { costoConds.push("cl.campaña_estacional_id = ?"); costoPrm.push(estacionalFiltro); }
    if (!costoConds.length) {
      const def = db.prepare("SELECT id FROM pa_campañas WHERE activa=1 AND tipo='anual'").get();
      if (def) { costoConds.push("cl.campaña_anual_id = ?"); costoPrm.push(def.id); }
      else { costoConds.push("1=1"); }
    }
    const costoWhere = costoConds.join(' AND ');

    // Filtro adicional por sector (texto del nombre de sector). Aplica solo a
    // las consultas agregadas, que joinean pa_sectores con alias `s`.
    const sectorCond = sectorFiltro ? ' AND s.nombre = ?' : '';
    const aggWhere   = costoWhere + sectorCond;
    const aggPrm     = sectorFiltro ? [...costoPrm, sectorFiltro] : costoPrm.slice();

    // Si se pide un lote específico, detalle completo
    if (lote_id) {
      const detalle = db.prepare(`
        SELECT cl.*, l.nombre as lote_nombre, l.hectareas,
               ca.nombre as campaña_nombre
        FROM pa_costos_lote cl
        JOIN pa_lotes l ON l.id = cl.lote_id
        LEFT JOIN pa_campañas ca ON ca.id = cl.campaña_id
        WHERE cl.lote_id = ? AND ${costoWhere}
        ORDER BY cl.fecha DESC
      `).all(lote_id, ...costoPrm);
      return res.json({ ok: true, data: detalle });
    }

    // Nombre de campaña para el JOIN con pa_cultivos_lote (guarda campaña como
    // TEXT). Si se filtra por estacional, priorizamos su nombre para agrupar el
    // cultivo de ese ciclo; si no, el de la anual.
    const nombreCampId = estacionalFiltro || anualFiltro
      || db.prepare("SELECT id FROM pa_campañas WHERE activa=1 AND tipo='anual'").get()?.id;
    const campañaNombre = nombreCampId
      ? db.prepare("SELECT nombre FROM pa_campañas WHERE id=?").get(nombreCampId)?.nombre
      : null;
    const resumen = db.prepare(`
      SELECT
        l.id as lote_id,
        l.nombre as lote_nombre,
        l.hectareas,
        s.nombre as sector_nombre,
        s.tipo as sector_tipo,
        ca.nombre as campaña_nombre,
        cu.cultivo as cultivo_actual,
        SUM(cl.monto) as costo_total,
        SUM(cl.monto) / NULLIF(l.hectareas, 0) as costo_por_ha,
        GROUP_CONCAT(DISTINCT cl.categoria) as categorias,
        MIN(cl.fecha) as fecha_primera,
        MAX(cl.fecha) as fecha_ultima,
        COUNT(DISTINCT CASE WHEN cl.categoria IN ('fertilizante','agroquimico') THEN cl.referencia_id END) as ordenes_count,
        SUM(CASE WHEN cl.categoria IN ('fertilizante','agroquimico') THEN 1 ELSE 0 END) as aplicaciones_count
      FROM pa_costos_lote cl
      JOIN pa_lotes l ON l.id = cl.lote_id
      JOIN pa_sectores s ON s.id = l.sector_id
      LEFT JOIN pa_campañas ca ON ca.id = cl.campaña_id
      LEFT JOIN pa_cultivos_lote cu ON cu.lote_id = l.id AND cu.campaña = ?
      WHERE ${aggWhere}
      GROUP BY l.id
      ORDER BY s.nombre, l.nombre
    `).all(campañaNombre || '', ...aggPrm);

    // Total por sector
    const porSector = db.prepare(`
      SELECT
        s.nombre as sector_nombre,
        s.tipo as sector_tipo,
        SUM(cl.monto) as costo_total,
        SUM(l.hectareas) as hectareas_total,
        SUM(cl.monto) / NULLIF(SUM(l.hectareas), 0) as costo_por_ha
      FROM pa_costos_lote cl
      JOIN pa_lotes l ON l.id = cl.lote_id
      JOIN pa_sectores s ON s.id = l.sector_id
      WHERE ${aggWhere}
      GROUP BY s.id
      ORDER BY s.nombre
    `).all(...aggPrm);

    // Total por cultivo: agrupamos los lotes por su cultivo de la campaña.
    // Lotes sin cultivo asignado se agrupan en "Sin cultivo asignado".
    // Para evitar duplicar hectáreas si un lote tiene varios costos, calculamos
    // las ha sumando solo una vez por lote (con DISTINCT en subquery).
    const porCultivo = db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(cu.cultivo),''), '— Sin cultivo asignado —') AS cultivo,
        SUM(t.monto)        AS costo_total,
        SUM(t.hectareas)    AS hectareas_total,
        SUM(t.monto) / NULLIF(SUM(t.hectareas), 0) AS costo_por_ha,
        COUNT(*)            AS lotes_count
      FROM (
        SELECT
          l.id        AS lote_id,
          l.hectareas AS hectareas,
          SUM(cl.monto) AS monto
        FROM pa_costos_lote cl
        JOIN pa_lotes l ON l.id = cl.lote_id
        JOIN pa_sectores s ON s.id = l.sector_id
        WHERE ${aggWhere}
        GROUP BY l.id
      ) t
      LEFT JOIN pa_cultivos_lote cu ON cu.lote_id = t.lote_id AND cu.campaña = ?
      GROUP BY cultivo
      ORDER BY costo_total DESC
    `).all(...aggPrm, campañaNombre || '');

    // Total por tipo de gasto: mapeamos las categorías técnicas de pa_costos_lote
    // a los grandes rubros de la vista ejecutiva. Combustible se imputa con
    // categoria='otros' y descripción que arranca con "Combustible".
    // Nota: agrupamos por la expresión CASE completa (no por el alias `tipo`),
    // porque pa_sectores tiene una columna `tipo` y SQLite resolvería el GROUP
    // BY contra esa columna real en vez del alias de salida.
    const tipoGastoCase = `
      CASE
        WHEN cl.categoria IN ('fertilizante','agroquimico','semilla') THEN 'Insumos'
        WHEN cl.categoria IN ('labor_propia','labor_contratada','cosecha') THEN 'Mano de obra'
        WHEN cl.categoria = 'otros' AND cl.descripcion LIKE 'Combustible%' THEN 'Combustible'
        ELSE 'Otros'
      END`;
    const porTipoRaw = db.prepare(`
      SELECT ${tipoGastoCase} AS tipo, SUM(cl.monto) AS costo
      FROM pa_costos_lote cl
      JOIN pa_lotes l ON l.id = cl.lote_id
      JOIN pa_sectores s ON s.id = l.sector_id
      WHERE ${aggWhere}
      GROUP BY ${tipoGastoCase}
      ORDER BY costo DESC
    `).all(...aggPrm);
    const totalGasto = porTipoRaw.reduce((a, r) => a + (r.costo || 0), 0);
    const porTipoGasto = porTipoRaw.map(r => ({
      tipo: r.tipo,
      costo: r.costo || 0,
      porcentaje: totalGasto > 0 ? Math.round((r.costo / totalGasto) * 1000) / 10 : 0
    }));

    // Totales globales (respetan los filtros activos). Se derivan del resumen
    // por lote para no recontar hectáreas ni lotes.
    const costoTotalGlobal = resumen.reduce((a, l) => a + (l.costo_total || 0), 0);
    const hectareasTotales = resumen.reduce((a, l) => a + (l.hectareas || 0), 0);
    const cultivosSet = new Set(
      resumen.map(l => (l.cultivo_actual || '').trim()).filter(Boolean)
    );
    const totales = {
      costo_total: costoTotalGlobal,
      hectareas_totales: hectareasTotales,
      costo_por_ha: hectareasTotales > 0 ? costoTotalGlobal / hectareasTotales : 0,
      lotes_count: resumen.length,
      cultivos_count: cultivosSet.size
    };

    // Lista de sectores para poblar el filtro (independiente de los filtros).
    const sectores = db.prepare(
      "SELECT nombre FROM pa_sectores WHERE activo=1 ORDER BY nombre"
    ).all().map(r => r.nombre);

    // Header: qué campaña se está mostrando (para el título dinámico del front).
    const campAnualRow = anualFiltro
      ? db.prepare("SELECT id, nombre FROM pa_campañas WHERE id=?").get(anualFiltro) : null;
    const campEstacRow = estacionalFiltro
      ? db.prepare("SELECT id, nombre FROM pa_campañas WHERE id=?").get(estacionalFiltro) : null;

    res.json({
      ok: true,
      campaña_anual: campAnualRow || null,
      campaña_estacional: campEstacRow || null,
      data: resumen,
      por_sector: porSector,
      por_cultivo: porCultivo,
      por_tipo_gasto: porTipoGasto,
      totales,
      sectores
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// STOCK — consulta general
// ─────────────────────────────────────────────────────────────────────────

router.get('/stock', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT i.*,
        (SELECT SUM(cantidad) FROM pa_movimientos_stock WHERE insumo_id=i.id AND tipo='entrada') as total_entradas,
        (SELECT SUM(cantidad) FROM pa_movimientos_stock WHERE insumo_id=i.id AND tipo='salida') as total_salidas
      FROM pa_insumos i
      WHERE i.activo = 1
      ORDER BY i.tipo, i.nombre
    `).all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Dashboard resumen del día
router.get('/dashboard', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const hoy = new Date().toISOString().slice(0,10);
    // Dos campañas activas simultáneas: una anual + una estacional.
    const anual      = db.prepare("SELECT * FROM pa_campañas WHERE activa=1 AND tipo='anual' LIMIT 1").get() || null;
    const estacional = db.prepare("SELECT * FROM pa_campañas WHERE activa=1 AND tipo='estacional' LIMIT 1").get() || null;
    const costoAnual = anual
      ? (db.prepare("SELECT COALESCE(SUM(monto),0) as total FROM pa_costos_lote WHERE campaña_anual_id=?").get(anual.id)?.total || 0)
      : 0;
    const costoEstacional = estacional
      ? (db.prepare("SELECT COALESCE(SUM(monto),0) as total FROM pa_costos_lote WHERE campaña_estacional_id=?").get(estacional.id)?.total || 0)
      : 0;
    const data = {
      // Compat: el front viejo leía `campaña` y `costo_campaña` (= anual)
      campaña: anual,
      costo_campaña: costoAnual,
      // Nuevo modelo: una card por tipo
      campaña_anual_activa:      anual      ? { id: anual.id,      nombre: anual.nombre,      costo_total: costoAnual }      : null,
      campaña_estacional_activa: estacional ? { id: estacional.id, nombre: estacional.nombre, costo_total: costoEstacional } : null,
      insumos_bajo_stock: db.prepare("SELECT COUNT(*) as n FROM pa_insumos WHERE activo=1 AND stock_actual <= stock_minimo AND stock_minimo > 0").get().n,
      ordenes_pendientes: db.prepare("SELECT COUNT(*) as n FROM pa_ordenes WHERE estado IN ('emitida','en_ejecucion')").get().n,
      ordenes_hoy:        db.prepare("SELECT COUNT(*) as n FROM pa_ordenes WHERE fecha_orden = ?").get(hoy).n,
      aplicaciones_hoy:   db.prepare("SELECT COUNT(*) as n FROM pa_aplicaciones WHERE fecha_real = ?").get(hoy).n,
      total_lotes:        db.prepare("SELECT COUNT(*) as n FROM pa_lotes WHERE activo=1").get().n,
    };
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════
// COMBUSTIBLE
// ═════════════════════════════════════════════════════════════════════════

// ── Tanques ────────────────────────────────────────────────────────────────
router.get('/combustible/tanques', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare("SELECT * FROM pa_combustible_tanques WHERE activo=1 ORDER BY tipo").all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/combustible/tanques/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { capacidad_lt, ubicacion, notas } = req.body;
  try {
    const curr = db.prepare("SELECT * FROM pa_combustible_tanques WHERE id=?").get(req.params.id);
    if (!curr) return res.status(404).json({ ok: false, error: 'Tanque no encontrado' });
    db.prepare("UPDATE pa_combustible_tanques SET capacidad_lt=?, ubicacion=?, notas=? WHERE id=?")
      .run(
        capacidad_lt !== undefined ? capacidad_lt : curr.capacidad_lt,
        ubicacion !== undefined ? ubicacion : curr.ubicacion,
        notas !== undefined ? notas : curr.notas,
        req.params.id
      );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Vehículos ──────────────────────────────────────────────────────────────
router.get('/combustible/vehiculos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { combustible, incluir_inactivos } = req.query;
    let q = "SELECT * FROM pa_vehiculos WHERE 1=1";
    const params = [];
    if (!incluir_inactivos) q += " AND activo=1";
    if (combustible) { q += " AND combustible=?"; params.push(combustible); }
    q += " ORDER BY tipo, identificacion";
    res.json({ ok: true, data: db.prepare(q).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/combustible/vehiculos', requireAuth, (req, res) => {
  const db = getDb();
  const { tipo, identificacion, marca_modelo, combustible, tiene_horometro,
          horas_actuales, km_actuales, notas } = req.body;
  if (!tipo || !identificacion || !combustible)
    return res.status(400).json({ ok: false, error: 'tipo, identificacion y combustible requeridos' });
  if (!['tractor','camioneta','moto','otro'].includes(tipo))
    return res.status(400).json({ ok: false, error: 'tipo inválido' });
  if (!['gasoil','nafta'].includes(combustible))
    return res.status(400).json({ ok: false, error: 'combustible inválido' });
  try {
    const r = db.prepare(`INSERT INTO pa_vehiculos
        (tipo, identificacion, marca_modelo, combustible, tiene_horometro, horas_actuales, km_actuales, notas)
        VALUES (?,?,?,?,?,?,?,?)`)
      .run(tipo, identificacion.trim(), marca_modelo || null, combustible,
           tiene_horometro ? 1 : 0, horas_actuales || 0, km_actuales || 0, notas || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un vehículo con esa identificación' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/combustible/vehiculos/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { tipo, identificacion, marca_modelo, combustible, tiene_horometro,
          horas_actuales, km_actuales, activo, notas } = req.body;
  try {
    const curr = db.prepare("SELECT * FROM pa_vehiculos WHERE id=?").get(req.params.id);
    if (!curr) return res.status(404).json({ ok: false, error: 'Vehículo no encontrado' });
    db.prepare(`UPDATE pa_vehiculos SET
        tipo=?, identificacion=?, marca_modelo=?, combustible=?, tiene_horometro=?,
        horas_actuales=?, km_actuales=?, activo=?, notas=?
        WHERE id=?`)
      .run(
        tipo || curr.tipo,
        identificacion || curr.identificacion,
        marca_modelo !== undefined ? marca_modelo : curr.marca_modelo,
        combustible || curr.combustible,
        tiene_horometro !== undefined ? (tiene_horometro ? 1 : 0) : curr.tiene_horometro,
        horas_actuales !== undefined ? horas_actuales : curr.horas_actuales,
        km_actuales !== undefined ? km_actuales : curr.km_actuales,
        activo !== undefined ? (activo ? 1 : 0) : curr.activo,
        notas !== undefined ? notas : curr.notas,
        req.params.id
      );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/combustible/vehiculos/:id/historial', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT m.*, l.nombre as lote_nombre, l.finca as lote_finca,
             u.nombre as cargado_por_nombre
      FROM pa_combustible_movimientos m
      LEFT JOIN pa_lotes l ON l.id=m.lote_id
      LEFT JOIN usuarios u ON u.id=m.cargado_por
      WHERE m.vehiculo_id=?
      ORDER BY m.fecha DESC, m.id DESC
      LIMIT 200
    `).all(req.params.id);

    // Calcular lt/hora entre cargas con horómetro (ordenadas cronológicamente)
    const conHoras = data.filter(d => d.horas_horometro != null).slice().sort((a,b) => a.id - b.id);
    for (let i = 1; i < conHoras.length; i++) {
      const deltaH = conHoras[i].horas_horometro - conHoras[i-1].horas_horometro;
      if (deltaH > 0) {
        const ltph = +(conHoras[i].litros / deltaH).toFixed(2);
        const target = data.find(d => d.id === conHoras[i].id);
        if (target) target.lt_por_hora = ltph;
      }
    }
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Movimientos ────────────────────────────────────────────────────────────
router.get('/combustible/movimientos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { tipo, vehiculo_id, tanque_id, estado, desde, hasta, lote_id, limit } = req.query;
    let q = `
      SELECT m.*,
        v.identificacion as vehiculo_txt, v.tipo as vehiculo_tipo,
        t.nombre as tanque_nombre,
        l.nombre as lote_nombre, l.finca as lote_finca,
        u.nombre as cargado_por_nombre,
        ur.nombre as revisado_por_nombre
      FROM pa_combustible_movimientos m
      LEFT JOIN pa_vehiculos v ON v.id=m.vehiculo_id
      LEFT JOIN pa_combustible_tanques t ON t.id=m.tanque_id
      LEFT JOIN pa_lotes l ON l.id=m.lote_id
      LEFT JOIN usuarios u ON u.id=m.cargado_por
      LEFT JOIN usuarios ur ON ur.id=m.revisado_por
      WHERE 1=1
    `;
    const params = [];
    if (tipo) { q += " AND m.tipo_movimiento=?"; params.push(tipo); }
    if (vehiculo_id) { q += " AND m.vehiculo_id=?"; params.push(vehiculo_id); }
    if (tanque_id) { q += " AND m.tanque_id=?"; params.push(tanque_id); }
    if (estado) { q += " AND m.estado_revision=?"; params.push(estado); }
    if (lote_id) { q += " AND m.lote_id=?"; params.push(lote_id); }
    if (desde) { q += " AND m.fecha>=?"; params.push(desde); }
    if (hasta) { q += " AND m.fecha<=?"; params.push(hasta); }
    q += " ORDER BY m.fecha DESC, m.id DESC LIMIT ?";
    params.push(parseInt(limit) || 200);
    res.json({ ok: true, data: db.prepare(q).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/combustible/movimientos', requireAuth, (req, res) => {
  const db = getDb();
  const {
    fecha, tipo_movimiento, tanque_id, vehiculo_id, combustible,
    litros, precio_unitario, moneda, precio_total,
    proveedor_id, proveedor_txt, tipo_comprobante, nro_comprobante, foto_b64,
    lote_id, orden_id, horas_horometro, km_vehiculo, notas
  } = req.body;

  if (!tipo_movimiento || !combustible || litros == null)
    return res.status(400).json({ ok: false, error: 'tipo_movimiento, combustible y litros requeridos' });
  if (!['gasoil','nafta'].includes(combustible))
    return res.status(400).json({ ok: false, error: 'combustible inválido' });
  if (!['carga_tanque','consumo_tanque','consumo_estacion','ajuste_varilla'].includes(tipo_movimiento))
    return res.status(400).json({ ok: false, error: 'tipo_movimiento inválido' });
  if (tipo_movimiento !== 'ajuste_varilla' && !(litros > 0))
    return res.status(400).json({ ok: false, error: 'litros debe ser > 0' });

  // Permiso específico para "consumo_estacion": solo admin/operador o usuarios con la sección
  if (tipo_movimiento === 'consumo_estacion') {
    const u = req.user || {};
    const rolOk = u.rol === 'admin' || u.rol === 'operador';
    const seccOk = Array.isArray(u.secciones) && (u.secciones.includes('*') || u.secciones.includes('combustible_estacion'));
    if (!rolOk && !seccOk) {
      return res.status(403).json({ ok: false, error: 'No tenés permiso para registrar cargas en estación' });
    }
  }

  try {
    // Guardar foto si viene (dentro de data/scout para aprovechar el estático existente)
    let fotoPath = null;
    if (foto_b64) {
      const dir = path.join(__dirnamePA, '../../data/scout/combustible');
      fs.mkdirSync(dir, { recursive: true });
      const fname = `comb_${Date.now()}_${Math.floor(Math.random()*9999)}.jpg`;
      fs.writeFileSync(path.join(dir, fname),
        Buffer.from(String(foto_b64).replace(/^data:.*?;base64,/,''), 'base64'));
      fotoPath = `/data/scout/combustible/${fname}`;
    }

    // Operarios (rol 'campo') cargan como pendiente; admin/operador quedan revisados
    const esCampo = req.user.rol === 'campo';
    const estado = esCampo ? 'pendiente' : 'revisado';
    const revisadoPor = esCampo ? null : req.user.id;
    const revisadoEn = esCampo ? null : new Date().toISOString();

    const tx = db.transaction(() => {
      const ins = db.prepare(`
        INSERT INTO pa_combustible_movimientos
          (fecha, tipo_movimiento, tanque_id, vehiculo_id, combustible, litros,
           precio_unitario, moneda, precio_total, proveedor_id, proveedor_txt,
           tipo_comprobante, nro_comprobante, foto_path, lote_id, orden_id,
           horas_horometro, km_vehiculo, cargado_por, estado_revision,
           revisado_por, revisado_en, notas)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        fecha || new Date().toISOString().slice(0,10),
        tipo_movimiento,
        tanque_id || null,
        vehiculo_id || null,
        combustible,
        Number(litros),
        Number(precio_unitario) || 0,
        moneda || 'ARS',
        Number(precio_total) || 0,
        proveedor_id || null,
        proveedor_txt || null,
        tipo_comprobante || null,
        nro_comprobante || null,
        fotoPath,
        lote_id || null,
        orden_id || null,
        horas_horometro != null ? Number(horas_horometro) : null,
        km_vehiculo != null ? Number(km_vehiculo) : null,
        req.user.id,
        estado,
        revisadoPor,
        revisadoEn,
        notas || null
      );
      const movId = ins.lastInsertRowid;

      // Stock del tanque
      if (tipo_movimiento === 'carga_tanque' && tanque_id) {
        db.prepare("UPDATE pa_combustible_tanques SET stock_actual = stock_actual + ? WHERE id=?").run(Number(litros), tanque_id);
      } else if (tipo_movimiento === 'consumo_tanque' && tanque_id) {
        db.prepare("UPDATE pa_combustible_tanques SET stock_actual = stock_actual - ? WHERE id=?").run(Number(litros), tanque_id);
      } else if (tipo_movimiento === 'ajuste_varilla' && tanque_id) {
        // En ajuste, 'litros' es la DIFERENCIA (+ sube stock, - baja)
        db.prepare("UPDATE pa_combustible_tanques SET stock_actual = stock_actual + ? WHERE id=?").run(Number(litros), tanque_id);
      }

      // Horómetro / km del vehículo
      if (vehiculo_id) {
        if (horas_horometro != null)
          db.prepare("UPDATE pa_vehiculos SET horas_actuales=? WHERE id=?").run(Number(horas_horometro), vehiculo_id);
        if (km_vehiculo != null)
          db.prepare("UPDATE pa_vehiculos SET km_actuales=? WHERE id=?").run(Number(km_vehiculo), vehiculo_id);
      }

      // Imputar costo a lote si corresponde (consumo con lote asignado)
      if (lote_id && Number(precio_total) > 0 &&
          ['consumo_tanque','consumo_estacion'].includes(tipo_movimiento)) {
        const act = campañasActivas(db);
        const campId = act.anualId || act.estacionalId;
        if (campId) {
          db.prepare(`INSERT INTO pa_costos_lote
              (lote_id, campaña_id, campaña_anual_id, campaña_estacional_id, categoria, referencia_id, fecha, monto, descripcion)
              VALUES (?,?,?,?,'otros',?,?,?,?)`)
            .run(lote_id, campId, act.anualId, act.estacionalId, movId,
                 fecha || new Date().toISOString().slice(0,10),
                 Number(precio_total),
                 `Combustible ${combustible} · ${litros} lt`);
        }
      }

      return movId;
    });

    res.json({ ok: true, id: tx() });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/combustible/movimientos/:id/revisar', requireAuth, (req, res) => {
  const db = getDb();
  const { notas_revision } = req.body;
  try {
    db.prepare(`UPDATE pa_combustible_movimientos
      SET estado_revision='revisado', revisado_por=?, revisado_en=?,
          notas_revision=COALESCE(?, notas_revision)
      WHERE id=?`)
      .run(req.user.id, new Date().toISOString(), notas_revision || null, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/combustible/movimientos/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const m = db.prepare("SELECT * FROM pa_combustible_movimientos WHERE id=?").get(req.params.id);
    if (!m) return res.status(404).json({ ok: false, error: 'Movimiento no encontrado' });
    const tx = db.transaction(() => {
      // Revertir stock
      if (m.tipo_movimiento === 'carga_tanque' && m.tanque_id) {
        db.prepare("UPDATE pa_combustible_tanques SET stock_actual = stock_actual - ? WHERE id=?").run(m.litros, m.tanque_id);
      } else if (m.tipo_movimiento === 'consumo_tanque' && m.tanque_id) {
        db.prepare("UPDATE pa_combustible_tanques SET stock_actual = stock_actual + ? WHERE id=?").run(m.litros, m.tanque_id);
      } else if (m.tipo_movimiento === 'ajuste_varilla' && m.tanque_id) {
        db.prepare("UPDATE pa_combustible_tanques SET stock_actual = stock_actual - ? WHERE id=?").run(m.litros, m.tanque_id);
      }
      // Borrar costo imputado
      db.prepare("DELETE FROM pa_costos_lote WHERE categoria='otros' AND referencia_id=?").run(m.id);
      // Borrar movimiento
      db.prepare("DELETE FROM pa_combustible_movimientos WHERE id=?").run(m.id);
    });
    tx();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Dashboard ──────────────────────────────────────────────────────────────
router.get('/combustible/dashboard', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const tanques = db.prepare("SELECT * FROM pa_combustible_tanques WHERE activo=1 ORDER BY tipo").all();
    const pendientes = db.prepare("SELECT COUNT(*) as n FROM pa_combustible_movimientos WHERE estado_revision='pendiente'").get().n;

    const hoy = new Date();
    const mesIni = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0,10);

    const gastoMes = db.prepare(`
      SELECT combustible, moneda,
             COALESCE(SUM(precio_total),0) as total,
             COALESCE(SUM(litros),0) as litros
      FROM pa_combustible_movimientos
      WHERE tipo_movimiento IN ('carga_tanque','consumo_estacion')
        AND fecha >= ?
      GROUP BY combustible, moneda
    `).all(mesIni);

    const topVehiculos = db.prepare(`
      SELECT v.id, v.identificacion, v.tipo, v.combustible,
             COALESCE(SUM(m.litros),0) as litros,
             COALESCE(SUM(m.precio_total),0) as gasto
      FROM pa_combustible_movimientos m
      JOIN pa_vehiculos v ON v.id=m.vehiculo_id
      WHERE m.tipo_movimiento IN ('consumo_tanque','consumo_estacion')
        AND m.fecha >= ?
      GROUP BY v.id
      ORDER BY litros DESC
      LIMIT 5
    `).all(mesIni);

    const ultimosPendientes = db.prepare(`
      SELECT m.id, m.fecha, m.tipo_movimiento, m.combustible, m.litros,
             v.identificacion as vehiculo_txt, u.nombre as cargado_por_nombre
      FROM pa_combustible_movimientos m
      LEFT JOIN pa_vehiculos v ON v.id=m.vehiculo_id
      LEFT JOIN usuarios u ON u.id=m.cargado_por
      WHERE m.estado_revision='pendiente'
      ORDER BY m.creado_en DESC
      LIMIT 10
    `).all();

    res.json({ ok: true, data: {
      tanques, pendientes,
      gasto_mes: gastoMes,
      top_vehiculos: topVehiculos,
      ultimos_pendientes: ultimosPendientes
    }});
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// VINCULACIÓN FACTURAS DE COMBUSTIBLE ↔ RECARGAS DEL TANQUE
// Una "recarga del tanque" es un pa_combustible_movimientos con
// tipo_movimiento='carga_tanque'. Las facturas son pa_compras de CUALQUIER
// proveedor de combustible.
//
// Identificación del proveedor: pa_compras.proveedor_id se persiste NULL
// (ver creación de compra), por eso la compra se asocia a un proveedor por
// nombre: pa_compras.proveedor_txt = adm_proveedores.razon_social. Un
// proveedor es "de combustible" si su categoria (o, como fallback, su rubro)
// es 'Combustible'. El fallback a rubro permite usar el campo que ya es
// editable en el padrón sin tocar el módulo contable.
// ═══════════════════════════════════════════════════════════════════════════
// Condición SQL reutilizable: el proveedor `p` es de combustible.
const _condProvCombustible =
  "(LOWER(TRIM(COALESCE(p.categoria,''))) = 'combustible' OR LOWER(TRIM(COALESCE(p.rubro,''))) = 'combustible')";

// Devuelve {id, razon_social} si el proveedor existe y es de combustible.
function _proveedorCombustible(db, proveedorId) {
  return db.prepare(`
    SELECT p.id, p.razon_social FROM adm_proveedores p
    WHERE p.id = ? AND p.activo = 1 AND ${_condProvCombustible}
  `).get(proveedorId);
}

// La compra pertenece a un proveedor de combustible si su proveedor_txt
// coincide (por nombre) con la razón social de algún proveedor de combustible.
function _esCompraCombustible(db, compraId) {
  const row = db.prepare(`
    SELECT c.id FROM pa_compras c
    WHERE c.id = ? AND EXISTS (
      SELECT 1 FROM adm_proveedores p
      WHERE p.activo = 1 AND ${_condProvCombustible}
        AND UPPER(TRIM(p.razon_social)) = UPPER(TRIM(COALESCE(c.proveedor_txt,'')))
    )
  `).get(compraId);
  return !!row;
}

// 1a) Listar proveedores de categoría Combustible (para los selectores)
router.get('/combustible/proveedores', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const proveedores = db.prepare(`
      SELECT p.id, p.razon_social, p.cuit
      FROM adm_proveedores p
      WHERE p.activo = 1 AND ${_condProvCombustible}
      ORDER BY p.razon_social
    `).all();
    res.json({ ok: true, proveedores });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 1b) Listar facturas de un proveedor de combustible con conteo de recargas
router.get('/combustible/facturas', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { proveedor_id, desde, hasta, solo_sin_vincular } = req.query;
    if (!proveedor_id)
      return res.status(400).json({ ok: false, error: 'proveedor_id requerido' });
    const prov = _proveedorCombustible(db, Number(proveedor_id));
    if (!prov)
      return res.status(400).json({ ok: false, error: 'El proveedor no es de categoría Combustible' });
    let q = `
      SELECT c.id, c.fecha, c.nro_factura, c.total,
        COALESCE((SELECT COUNT(*) FROM pa_vinculacion_factura_recarga v WHERE v.compra_id = c.id), 0) AS recargas_vinculadas_count
      FROM pa_compras c
      WHERE UPPER(TRIM(COALESCE(c.proveedor_txt,''))) = UPPER(TRIM(@razon))
        AND (c.activo IS NULL OR c.activo = 1)
    `;
    const params = { razon: prov.razon_social };
    if (desde) { q += " AND c.fecha >= @desde"; params.desde = desde; }
    if (hasta) { q += " AND c.fecha <= @hasta"; params.hasta = hasta; }
    q += " ORDER BY c.fecha DESC";
    let data = db.prepare(q).all(params);
    data = data.map(c => ({ ...c, tiene_vinculaciones: c.recargas_vinculadas_count > 0 }));
    if (solo_sin_vincular === '1' || solo_sin_vincular === 'true')
      data = data.filter(c => !c.tiene_vinculaciones);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 2) Recargas del tanque (carga_tanque) que NO tienen ninguna vinculación
router.get('/combustible/recargas-sin-vincular', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { desde, hasta } = req.query;
    let q = `
      SELECT m.*, t.nombre AS tanque_nombre
      FROM pa_combustible_movimientos m
      LEFT JOIN pa_combustible_tanques t ON t.id = m.tanque_id
      WHERE m.tipo_movimiento = 'carga_tanque'
        AND NOT EXISTS (SELECT 1 FROM pa_vinculacion_factura_recarga v WHERE v.recarga_id = m.id)
    `;
    const params = {};
    if (desde) { q += " AND m.fecha >= @desde"; params.desde = desde; }
    if (hasta) { q += " AND m.fecha <= @hasta"; params.hasta = hasta; }
    q += " ORDER BY m.fecha DESC";
    res.json({ ok: true, data: db.prepare(q).all(params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 3) Recargas vinculadas a una factura
router.get('/combustible/facturas/:compra_id/recargas', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT m.*, t.nombre AS tanque_nombre
      FROM pa_combustible_movimientos m
      JOIN pa_vinculacion_factura_recarga v ON v.recarga_id = m.id
      LEFT JOIN pa_combustible_tanques t ON t.id = m.tanque_id
      WHERE v.compra_id = ?
      ORDER BY m.fecha
    `).all(req.params.compra_id);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 4) Facturas vinculadas a una recarga (en general 1)
router.get('/combustible/recargas/:recarga_id/facturas', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT c.id, c.fecha, c.nro_factura, c.total, c.proveedor_txt
      FROM pa_compras c
      JOIN pa_vinculacion_factura_recarga v ON v.compra_id = c.id
      WHERE v.recarga_id = ?
      ORDER BY c.fecha DESC
    `).all(req.params.recarga_id);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 5) Vincular una factura con una o varias recargas
router.post('/combustible/vincular', requireAuth, (req, res) => {
  const db = getDb();
  const { compra_id, recarga_ids } = req.body;
  const ids = Array.isArray(recarga_ids) ? recarga_ids.map(Number).filter(n => n > 0) : [];
  if (!compra_id || !ids.length)
    return res.status(400).json({ ok: false, error: 'compra_id y recarga_ids requeridos' });
  if (!_esCompraCombustible(db, compra_id))
    return res.status(400).json({ ok: false, error: 'La compra no es de un proveedor de combustible' });
  try {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO pa_vinculacion_factura_recarga (compra_id, recarga_id, vinculado_por) VALUES (?,?,?)"
    );
    const tx = db.transaction(() => {
      let vinculadas = 0;
      for (const rid of ids) vinculadas += ins.run(compra_id, rid, req.user.id).changes;
      return vinculadas;
    });
    res.json({ ok: true, vinculadas: tx() });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 6) Desvincular una factura de una recarga
router.delete('/combustible/vincular', requireAuth, (req, res) => {
  const db = getDb();
  const { compra_id, recarga_id } = req.body;
  if (!compra_id || !recarga_id)
    return res.status(400).json({ ok: false, error: 'compra_id y recarga_id requeridos' });
  try {
    db.prepare("DELETE FROM pa_vinculacion_factura_recarga WHERE compra_id = ? AND recarga_id = ?")
      .run(compra_id, recarga_id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Lector IA: ticket/remito de combustible ────────────────────────────────
router.post('/combustible/leer-ticket', requireAuth, async (req, res) => {
  const { imagen_b64, media_type } = req.body;
  if (!imagen_b64) return res.status(400).json({ ok: false, error: 'imagen_b64 requerida' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'API key no configurada' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: imagen_b64 } },
            { type: 'text', text: `Analizá este ticket, factura o remito de combustible.
Devolvé SOLO un JSON válido sin markdown ni comentarios:
{
  "tipo_comprobante": "factura|remito|ticket|otro",
  "nro_comprobante": "número o null",
  "fecha": "YYYY-MM-DD o null",
  "proveedor": "YPF, Shell, Axion, u otro proveedor (string o null)",
  "combustible": "gasoil|nafta",
  "litros": número,
  "precio_unitario": número o null,
  "precio_total": número o null,
  "moneda": "ARS|USD"
}
Solo devolvé el JSON, sin texto adicional.` }
          ]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok)
      return res.status(500).json({ ok: false, error: data.error?.message || 'Error de API' });
    const txt = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch(e) { return res.status(422).json({ ok: false, error: 'No se pudo parsear la respuesta', raw: txt }); }
    res.json({ ok: true, data: parsed });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════
// PERSONAL / MANO DE OBRA
// ═════════════════════════════════════════════════════════════════════════

// ── Rubros contables ───────────────────────────────────────────────────────
router.get('/personal/rubros', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare("SELECT * FROM pa_rubros_contables WHERE activo=1 ORDER BY nombre").all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/rubros', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo_labor, cultivo, notas } = req.body;
  if (!nombre || !tipo_labor) return res.status(400).json({ ok: false, error: 'nombre y tipo_labor requeridos' });
  try {
    const r = db.prepare("INSERT INTO pa_rubros_contables (nombre, tipo_labor, cultivo, notas) VALUES (?,?,?,?)")
      .run(nombre, tipo_labor, cultivo || null, notas || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un rubro con ese nombre' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/personal/rubros/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo_labor, cultivo, activo, notas } = req.body;
  try {
    const c = db.prepare("SELECT * FROM pa_rubros_contables WHERE id=?").get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Rubro no encontrado' });
    db.prepare("UPDATE pa_rubros_contables SET nombre=?, tipo_labor=?, cultivo=?, activo=?, notas=? WHERE id=?")
      .run(nombre || c.nombre, tipo_labor || c.tipo_labor,
           cultivo !== undefined ? cultivo : c.cultivo,
           activo !== undefined ? (activo ? 1 : 0) : c.activo,
           notas !== undefined ? notas : c.notas,
           req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Cuadrillas ─────────────────────────────────────────────────────────────
router.get('/personal/cuadrillas', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT c.*, u.nombre as capataz_nombre,
             (SELECT COUNT(*) FROM pa_trabajadores WHERE cuadrilla_habitual_id = c.id AND activo=1) as cantidad
      FROM pa_cuadrillas c
      LEFT JOIN usuarios u ON u.id = c.capataz_id
      WHERE c.activo=1 ORDER BY c.tipo, c.nombre
    `).all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/cuadrillas', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, capataz_id, tipo, notas } = req.body;
  if (!nombre) return res.status(400).json({ ok: false, error: 'nombre requerido' });
  try {
    const r = db.prepare("INSERT INTO pa_cuadrillas (nombre, capataz_id, tipo, notas) VALUES (?,?,?,?)")
      .run(nombre, capataz_id || null, tipo || 'fija', notas || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe una cuadrilla con ese nombre' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/personal/cuadrillas/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, capataz_id, tipo, activo, notas } = req.body;
  try {
    const c = db.prepare("SELECT * FROM pa_cuadrillas WHERE id=?").get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cuadrilla no encontrada' });
    db.prepare("UPDATE pa_cuadrillas SET nombre=?, capataz_id=?, tipo=?, activo=?, notas=? WHERE id=?")
      .run(nombre || c.nombre,
           capataz_id !== undefined ? capataz_id : c.capataz_id,
           tipo || c.tipo,
           activo !== undefined ? (activo ? 1 : 0) : c.activo,
           notas !== undefined ? notas : c.notas,
           req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Grupos / Colectivos (administrativo de trabajadores) ───────────────────
router.get('/personal/grupos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT g.*, (SELECT COUNT(*) FROM pa_trabajadores WHERE grupo_id = g.id AND activo=1) as cantidad
      FROM pa_grupos g WHERE g.activo=1 ORDER BY g.nombre
    `).all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/grupos', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, descripcion } = req.body;
  if (!nombre) return res.status(400).json({ ok: false, error: 'nombre requerido' });
  try {
    const r = db.prepare("INSERT INTO pa_grupos (nombre, descripcion) VALUES (?,?)")
      .run(nombre.trim(), descripcion || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un grupo con ese nombre' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/personal/grupos/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, descripcion, activo } = req.body;
  try {
    const g = db.prepare("SELECT * FROM pa_grupos WHERE id=?").get(req.params.id);
    if (!g) return res.status(404).json({ ok: false, error: 'Grupo no encontrado' });
    db.prepare("UPDATE pa_grupos SET nombre=?, descripcion=?, activo=? WHERE id=?")
      .run(nombre || g.nombre,
           descripcion !== undefined ? descripcion : g.descripcion,
           activo !== undefined ? (activo ? 1 : 0) : g.activo,
           req.params.id);
    res.json({ ok: true });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe un grupo con ese nombre' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Trabajadores ───────────────────────────────────────────────────────────
router.get('/personal/trabajadores', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { cuadrilla_id, grupo_id, tipo_relacion, incluir_inactivos } = req.query;
    let q = `SELECT t.*, c.nombre as cuadrilla_nombre, g.nombre as grupo_nombre
             FROM pa_trabajadores t
             LEFT JOIN pa_cuadrillas c ON c.id = t.cuadrilla_habitual_id
             LEFT JOIN pa_grupos g ON g.id = t.grupo_id
             WHERE 1=1`;
    const params = [];
    if (!incluir_inactivos) q += " AND t.activo=1";
    if (cuadrilla_id) { q += " AND t.cuadrilla_habitual_id=?"; params.push(cuadrilla_id); }
    if (grupo_id) { q += " AND t.grupo_id=?"; params.push(grupo_id); }
    if (tipo_relacion) { q += " AND t.tipo_relacion=?"; params.push(tipo_relacion); }
    q += " ORDER BY g.nombre, t.nombre";
    res.json({ ok: true, data: db.prepare(q).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/trabajadores', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, dni, grupo_id, cuadrilla_habitual_id, tipo_relacion, jornal_base, unidad_jornal, notas } = req.body;
  if (!nombre) return res.status(400).json({ ok: false, error: 'nombre requerido' });
  try {
    // Si no viene grupo_id, asignar al grupo "Sin asignar" por default
    let gId = grupo_id ? Number(grupo_id) : null;
    if (!gId) {
      const sa = db.prepare("SELECT id FROM pa_grupos WHERE nombre='Sin asignar'").get();
      if (sa) gId = sa.id;
    }
    const r = db.prepare(`INSERT INTO pa_trabajadores
        (nombre, dni, grupo_id, cuadrilla_habitual_id, tipo_relacion, jornal_base, unidad_jornal, notas)
        VALUES (?,?,?,?,?,?,?,?)`)
      .run(nombre, dni || null, gId, cuadrilla_habitual_id || null,
           tipo_relacion || 'fijo',
           Number(jornal_base) || 0,
           unidad_jornal || 'dia',
           notas || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/personal/trabajadores/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, dni, grupo_id, cuadrilla_habitual_id, tipo_relacion, jornal_base, unidad_jornal, activo, notas } = req.body;
  try {
    const c = db.prepare("SELECT * FROM pa_trabajadores WHERE id=?").get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Trabajador no encontrado' });
    db.prepare(`UPDATE pa_trabajadores SET
        nombre=?, dni=?, grupo_id=?, cuadrilla_habitual_id=?, tipo_relacion=?,
        jornal_base=?, unidad_jornal=?, activo=?, notas=?
        WHERE id=?`)
      .run(nombre || c.nombre,
           dni !== undefined ? dni : c.dni,
           grupo_id !== undefined ? grupo_id : c.grupo_id,
           cuadrilla_habitual_id !== undefined ? cuadrilla_habitual_id : c.cuadrilla_habitual_id,
           tipo_relacion || c.tipo_relacion,
           jornal_base !== undefined ? Number(jornal_base) : c.jornal_base,
           unidad_jornal || c.unidad_jornal,
           activo !== undefined ? (activo ? 1 : 0) : c.activo,
           notas !== undefined ? notas : c.notas,
           req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PERSONAL V1 — Padrón unificado (pa_personal) + permisos del módulo
// Permisos viven en pa_permisos_personal (decoupled de auth.js).
// Admin (rol='admin') tiene ambos permisos por código.
// ═══════════════════════════════════════════════════════════════════════════

// Resuelve los permisos del usuario actual para el módulo Personal
function permisosPersonal(db, user) {
  if (user && user.rol === 'admin') return { asistencia: true, valorizacion: true, admin: true };
  const row = user && user.id
    ? db.prepare("SELECT personal_asistencia, personal_valorizacion FROM pa_permisos_personal WHERE usuario_id=?").get(user.id)
    : null;
  return {
    asistencia:   !!(row && row.personal_asistencia),
    valorizacion: !!(row && row.personal_valorizacion),
    admin: false
  };
}

// ── Permisos: qué puede ver/hacer el usuario actual ────────────────────────
router.get('/personal/mis-permisos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    res.json({ ok: true, data: permisosPersonal(db, req.user) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Permisos: listado de usuarios con sus flags (solo admin) ───────────────
router.get('/personal/permisos', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT u.id as usuario_id, u.nombre, u.email, u.rol,
             COALESCE(pp.personal_asistencia, 0)   as personal_asistencia,
             COALESCE(pp.personal_valorizacion, 0) as personal_valorizacion
      FROM usuarios u
      LEFT JOIN pa_permisos_personal pp ON pp.usuario_id = u.id
      WHERE u.activo=1
      ORDER BY u.nombre
    `).all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Permisos: asignar flags a un usuario (solo admin) ──────────────────────
router.post('/personal/permisos', requireAdmin, (req, res) => {
  const db = getDb();
  const { usuario_id, personal_asistencia, personal_valorizacion } = req.body;
  if (!usuario_id) return res.status(400).json({ ok: false, error: 'usuario_id requerido' });
  try {
    const u = db.prepare("SELECT id, rol FROM usuarios WHERE id=?").get(usuario_id);
    if (!u) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    db.prepare(`
      INSERT INTO pa_permisos_personal (usuario_id, personal_asistencia, personal_valorizacion, modificado_en, modificado_por)
      VALUES (?,?,?, datetime('now','localtime'), ?)
      ON CONFLICT(usuario_id) DO UPDATE SET
        personal_asistencia=excluded.personal_asistencia,
        personal_valorizacion=excluded.personal_valorizacion,
        modificado_en=excluded.modificado_en,
        modificado_por=excluded.modificado_por
    `).run(usuario_id, personal_asistencia ? 1 : 0, personal_valorizacion ? 1 : 0, req.user.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Personas del módulo Equipo (proxy read-only para linkear fijos) ────────
router.get('/personal/personas-equipo', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const { q } = req.query;
    let sql = `SELECT id, nombre, apellido, dni, cargo FROM personas WHERE activo=1`;
    const params = [];
    if (q) { sql += " AND (nombre LIKE ? OR apellido LIKE ? OR dni LIKE ?)"; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    sql += " ORDER BY apellido, nombre LIMIT 500";
    res.json({ ok: true, data: db.prepare(sql).all(...params) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Padrón: listado ────────────────────────────────────────────────────────
router.get('/personal/padron', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const perms = permisosPersonal(db, req.user);
    const { tipo, q, incluir_inactivos } = req.query;
    let sql = `
      SELECT p.id, p.tipo, p.nombre, p.dni, p.cuit, p.persona_id, p.contratista_madre_id,
             p.cuadrilla_default_id, p.tarifa_default, p.unidad_tarifa, p.activo, p.notas,
             c.nombre as cuadrilla_nombre,
             m.nombre as contratista_madre_nombre,
             per.nombre as persona_nombre, per.apellido as persona_apellido
      FROM pa_personal p
      LEFT JOIN pa_cuadrillas c ON c.id = p.cuadrilla_default_id
      LEFT JOIN pa_personal m   ON m.id = p.contratista_madre_id
      LEFT JOIN personas per     ON per.id = p.persona_id
      WHERE p.eliminado_en IS NULL`;
    const params = [];
    if (!incluir_inactivos) sql += " AND p.activo=1";
    if (tipo === 'fijo' || tipo === 'contratista') { sql += " AND p.tipo=?"; params.push(tipo); }
    if (q) { sql += " AND (p.nombre LIKE ? OR p.dni LIKE ? OR p.cuit LIKE ?)"; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    sql += " ORDER BY p.tipo, p.nombre";
    let data = db.prepare(sql).all(...params);
    // Separación de funciones: quien no valoriza, no ve tarifas ($)
    if (!perms.valorizacion && !perms.admin) {
      data = data.map(r => { const { tarifa_default, unidad_tarifa, ...rest } = r; return rest; });
    }
    res.json({ ok: true, data, perms });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Padrón: detalle (con fijos asociados si es contratista) ────────────────
router.get('/personal/padron/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const perms = permisosPersonal(db, req.user);
    const p = db.prepare(`
      SELECT p.*, c.nombre as cuadrilla_nombre, m.nombre as contratista_madre_nombre,
             per.nombre as persona_nombre, per.apellido as persona_apellido
      FROM pa_personal p
      LEFT JOIN pa_cuadrillas c ON c.id = p.cuadrilla_default_id
      LEFT JOIN pa_personal m   ON m.id = p.contratista_madre_id
      LEFT JOIN personas per     ON per.id = p.persona_id
      WHERE p.id=? AND p.eliminado_en IS NULL`).get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'Personal no encontrado' });
    let fijos = [];
    if (p.tipo === 'contratista') {
      fijos = db.prepare("SELECT id, nombre, dni, activo FROM pa_personal WHERE contratista_madre_id=? AND eliminado_en IS NULL ORDER BY nombre").all(p.id);
    }
    if (!perms.valorizacion && !perms.admin) { delete p.tarifa_default; delete p.unidad_tarifa; }
    res.json({ ok: true, data: { ...p, fijos } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Padrón: alta ───────────────────────────────────────────────────────────
router.post('/personal/padron', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.asistencia && !perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso para el módulo Personal' });
  const { tipo, nombre, dni, cuit, persona_id, contratista_madre_id, cuadrilla_default_id, tarifa_default, unidad_tarifa, notas } = req.body;
  if (!nombre) return res.status(400).json({ ok: false, error: 'nombre requerido' });
  if (tipo !== 'fijo' && tipo !== 'contratista') return res.status(400).json({ ok: false, error: "tipo debe ser 'fijo' o 'contratista'" });
  if (tipo === 'contratista' && (persona_id || contratista_madre_id))
    return res.status(400).json({ ok: false, error: 'Un contratista no puede tener persona_id ni contratista_madre_id' });
  try {
    // Solo valorización/admin fijan tarifa; asistencia la deja en 0
    const puedeTarifa = perms.valorizacion || perms.admin;
    const r = db.prepare(`INSERT INTO pa_personal
        (tipo, nombre, dni, cuit, persona_id, contratista_madre_id, cuadrilla_default_id, tarifa_default, unidad_tarifa, notas, creado_por)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(tipo, nombre.trim(), dni || null, cuit || null,
           tipo === 'fijo' ? (persona_id || null) : null,
           tipo === 'fijo' ? (contratista_madre_id || null) : null,
           cuadrilla_default_id || null,
           puedeTarifa ? (Number(tarifa_default) || 0) : 0,
           unidad_tarifa || 'jornal',
           notas || null, req.user.id);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Padrón: edición ────────────────────────────────────────────────────────
router.patch('/personal/padron/:id', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.asistencia && !perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso para el módulo Personal' });
  const { nombre, dni, cuit, persona_id, contratista_madre_id, cuadrilla_default_id, tarifa_default, unidad_tarifa, activo, notas } = req.body;
  try {
    const p = db.prepare("SELECT * FROM pa_personal WHERE id=? AND eliminado_en IS NULL").get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'Personal no encontrado' });
    const puedeTarifa = perms.valorizacion || perms.admin;
    db.prepare(`UPDATE pa_personal SET
        nombre=?, dni=?, cuit=?, persona_id=?, contratista_madre_id=?, cuadrilla_default_id=?,
        tarifa_default=?, unidad_tarifa=?, activo=?, notas=?,
        modificado_en=datetime('now','localtime'), modificado_por=?
        WHERE id=?`)
      .run(nombre || p.nombre,
           dni !== undefined ? dni : p.dni,
           cuit !== undefined ? cuit : p.cuit,
           p.tipo === 'fijo' ? (persona_id !== undefined ? persona_id : p.persona_id) : null,
           p.tipo === 'fijo' ? (contratista_madre_id !== undefined ? contratista_madre_id : p.contratista_madre_id) : null,
           cuadrilla_default_id !== undefined ? cuadrilla_default_id : p.cuadrilla_default_id,
           puedeTarifa && tarifa_default !== undefined ? Number(tarifa_default) : p.tarifa_default,
           unidad_tarifa || p.unidad_tarifa,
           activo !== undefined ? (activo ? 1 : 0) : p.activo,
           notas !== undefined ? notas : p.notas,
           req.user.id, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Padrón: baja (soft delete) ─────────────────────────────────────────────
router.delete('/personal/padron/:id', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.asistencia && !perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso para el módulo Personal' });
  try {
    const p = db.prepare("SELECT id FROM pa_personal WHERE id=? AND eliminado_en IS NULL").get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'Personal no encontrado' });
    db.prepare("UPDATE pa_personal SET activo=0, eliminado_en=datetime('now','localtime'), eliminado_por_id=? WHERE id=?")
      .run(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Padrón: reactivar ──────────────────────────────────────────────────────
router.post('/personal/padron/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.asistencia && !perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso para el módulo Personal' });
  try {
    db.prepare("UPDATE pa_personal SET activo=1, eliminado_en=NULL, eliminado_por_id=NULL WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PERSONAL V1 — Asistencia diaria (pa_asistencias) — Fase 2
// Dato físico. rubro_cuenta_id siempre una cuenta 'MO %' del plan (read-only).
// ═══════════════════════════════════════════════════════════════════════════

// Filtro de "cuentas MO" del plan de cuentas de Pablo (solo SELECT, read-only).
// Criterio confirmado: nombre LIKE 'MO %' (incluye MO GENERALES aunque permite_lote=0).
const PERSONAL_MO_LIKE = 'MO %';
router.get('/personal/cuentas-mo', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT id, codigo, nombre, seccion_id
      FROM pa_cuentas
      WHERE activo=1 AND nombre LIKE ?
      ORDER BY codigo
    `).all(PERSONAL_MO_LIKE);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Defaults para el modal de asistencia (campañas vigentes + catálogos)
router.get('/personal/asistencias/defaults', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const anuales    = db.prepare("SELECT id, nombre, activa FROM pa_campañas WHERE tipo='anual' AND eliminada_en IS NULL ORDER BY activa DESC, nombre").all();
    const estac      = db.prepare("SELECT id, nombre, activa FROM pa_campañas WHERE tipo='estacional' AND eliminada_en IS NULL ORDER BY activa DESC, nombre").all();
    const act        = campañasActivas(db);
    const cuentasMo  = db.prepare("SELECT id, codigo, nombre FROM pa_cuentas WHERE activo=1 AND nombre LIKE ? ORDER BY codigo").all(PERSONAL_MO_LIKE);
    const lotes      = db.prepare(`
      SELECT l.id, l.nombre, l.finca,
             (SELECT cultivo FROM pa_cultivos_lote WHERE lote_id=l.id ORDER BY id DESC LIMIT 1) as cultivo
      FROM pa_lotes l WHERE l.activo=1 ORDER BY l.finca, l.nombre`).all();
    const tareas     = db.prepare("SELECT id, nombre FROM pa_tareas_tipos WHERE activo=1 ORDER BY nombre").all();
    const cuadrillas = db.prepare("SELECT id, nombre FROM pa_cuadrillas WHERE activo=1 ORDER BY nombre").all();
    const personal   = db.prepare("SELECT id, nombre, tipo, contratista_madre_id FROM pa_personal WHERE activo=1 AND eliminado_en IS NULL ORDER BY tipo, nombre").all();
    res.json({ ok: true, data: {
      campanas: { anual: anuales, estacional: estac, vigenteAnualId: act.anualId, vigenteEstacionalId: act.estacionalId },
      cuentas_mo: cuentasMo, lotes, tareas, cuadrillas, personal
    }});
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Grilla del día (o rango): asistencias con nombres resueltos
router.get('/personal/asistencias', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const perms = permisosPersonal(db, req.user);
    const { fecha, desde, hasta, estado } = req.query;
    let sql = `
      SELECT a.id, a.fecha, a.cuadrilla_id, a.personal_id, a.contratista_id, a.cantidad, a.horas, a.jornales_calc,
             a.rubro_cuenta_id, a.campaña_anual_id, a.campaña_estacional_id, a.lote_id, a.finca, a.tarea_tipo_id,
             a.cultivo, a.estado, a.notas,
             cu.nombre as cuadrilla_nombre,
             p.nombre  as personal_nombre, p.tipo as personal_tipo,
             ct.nombre as contratista_nombre,
             cta.nombre as rubro_nombre, cta.codigo as rubro_codigo,
             l.nombre  as lote_nombre,
             t.nombre  as tarea_nombre,
             ca.nombre as campana_anual_nombre, ce.nombre as campana_estacional_nombre
      FROM pa_asistencias a
      LEFT JOIN pa_cuadrillas cu ON cu.id = a.cuadrilla_id
      LEFT JOIN pa_personal p    ON p.id  = a.personal_id
      LEFT JOIN pa_personal ct   ON ct.id = a.contratista_id
      LEFT JOIN pa_cuentas cta    ON cta.id = a.rubro_cuenta_id
      LEFT JOIN pa_lotes l       ON l.id  = a.lote_id
      LEFT JOIN pa_tareas_tipos t ON t.id = a.tarea_tipo_id
      LEFT JOIN pa_campañas ca    ON ca.id = a.campaña_anual_id
      LEFT JOIN pa_campañas ce    ON ce.id = a.campaña_estacional_id
      WHERE 1=1`;
    const params = [];
    if (fecha) { sql += " AND a.fecha=?"; params.push(fecha); }
    if (desde) { sql += " AND a.fecha>=?"; params.push(desde); }
    if (hasta) { sql += " AND a.fecha<=?"; params.push(hasta); }
    if (estado) { sql += " AND a.estado=?"; params.push(estado); }
    else sql += " AND a.estado != 'anulado'";
    sql += " ORDER BY a.fecha DESC, a.id DESC";
    let data = db.prepare(sql).all(...params);
    res.json({ ok: true, data, perms });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Valida y normaliza el payload de una asistencia. Devuelve {error} o {val}
function _validarAsistencia(db, body) {
  const { fecha, personal_id, contratista_id, cantidad, horas, rubro_cuenta_id,
          campaña_anual_id, campaña_estacional_id, lote_id } = body;
  if (!fecha) return { error: 'fecha requerida' };
  if (!rubro_cuenta_id) return { error: 'rubro_cuenta_id requerido' };
  if (!lote_id) return { error: 'lote_id requerido' };
  if (!campaña_anual_id || !campaña_estacional_id) return { error: 'Campañas anual y estacional requeridas' };
  const cant = Number(cantidad) || 1;
  const hs = Number(horas);
  if (cant < 1) return { error: 'cantidad debe ser ≥ 1' };
  if (!(hs > 0)) return { error: 'horas debe ser > 0' };
  // Individual vs bloque
  let contraId = contratista_id || null;
  if (!personal_id) {
    if (!contraId) return { error: 'Un registro de bloque (sin persona) requiere un contratista' };
  } else {
    // si es individual y no se pasó contratista, derivar de la persona
    if (!contraId) {
      const per = db.prepare("SELECT contratista_madre_id FROM pa_personal WHERE id=?").get(personal_id);
      contraId = per ? (per.contratista_madre_id || null) : null;
    }
  }
  // Campañas: validar tipos
  const ca = db.prepare("SELECT tipo FROM pa_campañas WHERE id=?").get(campaña_anual_id);
  if (!ca || ca.tipo !== 'anual') return { error: 'campaña_anual_id no es una campaña anual válida' };
  const ce = db.prepare("SELECT tipo FROM pa_campañas WHERE id=?").get(campaña_estacional_id);
  if (!ce || ce.tipo !== 'estacional') return { error: 'campaña_estacional_id no es una campaña estacional válida' };
  // Rubro: debe existir y ser cuenta MO
  const cta = db.prepare("SELECT nombre FROM pa_cuentas WHERE id=? AND activo=1").get(rubro_cuenta_id);
  if (!cta) return { error: 'rubro (cuenta) inexistente o inactivo' };
  if (!/^MO /.test(cta.nombre)) return { error: 'El rubro debe ser una cuenta de Mano de Obra (MO)' };
  // Lote: finca denormalizada
  const lote = db.prepare("SELECT finca FROM pa_lotes WHERE id=?").get(lote_id);
  if (!lote) return { error: 'lote inexistente' };
  return { val: {
    cant, hs, contraId,
    jornales: Math.round((cant * hs / 8.0) * 100) / 100,
    finca: lote.finca || null
  }};
}

// Alta
router.post('/personal/asistencias', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.asistencia && !perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso para cargar asistencias' });
  const b = req.body;
  const chk = _validarAsistencia(db, b);
  if (chk.error) return res.status(400).json({ ok: false, error: chk.error });
  const v = chk.val;
  try {
    const r = db.prepare(`INSERT INTO pa_asistencias
        (fecha, cuadrilla_id, personal_id, contratista_id, cantidad, horas, jornales_calc,
         rubro_cuenta_id, campaña_anual_id, campaña_estacional_id, lote_id, finca, tarea_tipo_id, cultivo, notas, cargado_por)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(b.fecha, b.cuadrilla_id || null, b.personal_id || null, v.contraId,
           v.cant, v.hs, v.jornales,
           b.rubro_cuenta_id, b.campaña_anual_id, b.campaña_estacional_id, b.lote_id, v.finca,
           b.tarea_tipo_id || null, b.cultivo || null, b.notas || null, req.user.id);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Edición (solo pendiente_valorizar)
router.patch('/personal/asistencias/:id', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.asistencia && !perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso para editar asistencias' });
  try {
    const a = db.prepare("SELECT * FROM pa_asistencias WHERE id=?").get(req.params.id);
    if (!a) return res.status(404).json({ ok: false, error: 'Asistencia no encontrada' });
    if (a.estado !== 'pendiente_valorizar')
      return res.status(400).json({ ok: false, error: 'Solo se editan asistencias pendientes de valorizar (anulá primero si está valorizada)' });
    // Merge con valores actuales para validar
    const merged = {
      fecha: req.body.fecha || a.fecha,
      cuadrilla_id: req.body.cuadrilla_id !== undefined ? req.body.cuadrilla_id : a.cuadrilla_id,
      personal_id: req.body.personal_id !== undefined ? req.body.personal_id : a.personal_id,
      contratista_id: req.body.contratista_id !== undefined ? req.body.contratista_id : a.contratista_id,
      cantidad: req.body.cantidad !== undefined ? req.body.cantidad : a.cantidad,
      horas: req.body.horas !== undefined ? req.body.horas : a.horas,
      rubro_cuenta_id: req.body.rubro_cuenta_id || a.rubro_cuenta_id,
      campaña_anual_id: req.body.campaña_anual_id || a.campaña_anual_id,
      campaña_estacional_id: req.body.campaña_estacional_id || a.campaña_estacional_id,
      lote_id: req.body.lote_id || a.lote_id,
      tarea_tipo_id: req.body.tarea_tipo_id !== undefined ? req.body.tarea_tipo_id : a.tarea_tipo_id,
      cultivo: req.body.cultivo !== undefined ? req.body.cultivo : a.cultivo,
      notas: req.body.notas !== undefined ? req.body.notas : a.notas
    };
    const chk = _validarAsistencia(db, merged);
    if (chk.error) return res.status(400).json({ ok: false, error: chk.error });
    const v = chk.val;
    db.prepare(`UPDATE pa_asistencias SET
        fecha=?, cuadrilla_id=?, personal_id=?, contratista_id=?, cantidad=?, horas=?, jornales_calc=?,
        rubro_cuenta_id=?, campaña_anual_id=?, campaña_estacional_id=?, lote_id=?, finca=?, tarea_tipo_id=?, cultivo=?, notas=?,
        modificado_en=datetime('now','localtime'), modificado_por=?
        WHERE id=?`)
      .run(merged.fecha, merged.cuadrilla_id || null, merged.personal_id || null, v.contraId,
           v.cant, v.hs, v.jornales,
           merged.rubro_cuenta_id, merged.campaña_anual_id, merged.campaña_estacional_id, merged.lote_id, v.finca,
           merged.tarea_tipo_id || null, merged.cultivo || null, merged.notas || null,
           req.user.id, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Baja (solo pendiente_valorizar; las valorizadas se anulan en F3)
router.delete('/personal/asistencias/:id', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.asistencia && !perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso para eliminar asistencias' });
  try {
    const a = db.prepare("SELECT estado FROM pa_asistencias WHERE id=?").get(req.params.id);
    if (!a) return res.status(404).json({ ok: false, error: 'Asistencia no encontrada' });
    if (a.estado !== 'pendiente_valorizar')
      return res.status(400).json({ ok: false, error: 'No se puede borrar una asistencia valorizada' });
    db.prepare("DELETE FROM pa_asistencias WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PERSONAL V1 — Valorización + Cuenta Corriente + imputación (Fase 3)
// ═══════════════════════════════════════════════════════════════════════════

// Mapeo rubro(cuenta MO) → categoría de pa_costos_lote. ÚNICO punto de cambio.
// Regla: cuenta 'MO COSH%' → 'cosecha'; si no, por titular (contratista/fijo).
function _categoriaCostoAsistencia(db, rubroCuentaId, tipoTitular) {
  const cta = db.prepare("SELECT nombre FROM pa_cuentas WHERE id=?").get(rubroCuentaId);
  const nombre = (cta && cta.nombre) ? cta.nombre : '';
  if (/^MO\s+COSH/i.test(nombre)) return 'cosecha';
  return tipoTitular === 'contratista' ? 'labor_contratada' : 'labor_propia';
}

// Base de unidades para calcular monto según unidad de tarifa del titular
function _baseUnidadesAsistencia(unidad, a) {
  if (unidad === 'hora')   return (a.cantidad || 1) * (a.horas || 0);
  if (unidad === 'jornal') return (a.jornales_calc != null ? a.jornales_calc : (a.cantidad||1)*(a.horas||0)/8);
  return (a.cantidad || 1); // tanto / tacho / planta / kg
}

// Recalcula saldo_acumulado cronológico de un titular (excluye anulados)
function _recalcSaldoCC(db, tipoTitular, titularId) {
  const movs = db.prepare(
    "SELECT id, monto FROM pa_cc_movimientos WHERE tipo_titular=? AND titular_id=? AND anulado=0 ORDER BY fecha, id"
  ).all(tipoTitular, titularId);
  const upd = db.prepare("UPDATE pa_cc_movimientos SET saldo_acumulado=? WHERE id=?");
  let saldo = 0;
  for (const m of movs) { saldo = Math.round((saldo + m.monto) * 100) / 100; upd.run(saldo, m.id); }
  return saldo;
}

// Resuelve el titular de CC de una asistencia (individual→persona; bloque→contratista)
function _titularAsistencia(db, a) {
  const id = a.personal_id || a.contratista_id;
  if (!id) return null;
  const p = db.prepare("SELECT id, nombre, tipo FROM pa_personal WHERE id=?").get(id);
  return p || null;
}

// ── Por valorizar: pendientes en un rango, con titular + tarifa default ─────
router.get('/personal/valorizar', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso de valorización' });
  try {
    const { desde, hasta } = req.query;
    let sql = `
      SELECT a.id, a.fecha, a.cantidad, a.horas, a.jornales_calc, a.personal_id, a.contratista_id,
             a.rubro_cuenta_id, a.lote_id, a.finca,
             p.nombre as personal_nombre, ct.nombre as contratista_nombre,
             cta.codigo as rubro_codigo, cta.nombre as rubro_nombre,
             l.nombre as lote_nombre, t.nombre as tarea_nombre
      FROM pa_asistencias a
      LEFT JOIN pa_personal p   ON p.id  = a.personal_id
      LEFT JOIN pa_personal ct  ON ct.id = a.contratista_id
      LEFT JOIN pa_cuentas cta   ON cta.id = a.rubro_cuenta_id
      LEFT JOIN pa_lotes l      ON l.id  = a.lote_id
      LEFT JOIN pa_tareas_tipos t ON t.id = a.tarea_tipo_id
      WHERE a.estado='pendiente_valorizar'`;
    const params = [];
    if (desde) { sql += " AND a.fecha>=?"; params.push(desde); }
    if (hasta) { sql += " AND a.fecha<=?"; params.push(hasta); }
    sql += " ORDER BY a.fecha, a.id";
    const rows = db.prepare(sql).all(...params);
    // Enriquecer con titular + tarifa default + preview de monto
    const data = rows.map(a => {
      const tit = _titularAsistencia(db, a);
      const padron = tit ? db.prepare("SELECT tarifa_default, unidad_tarifa FROM pa_personal WHERE id=?").get(tit.id) : null;
      const unidad = (padron && padron.unidad_tarifa) || 'jornal';
      const tarifa = (padron && padron.tarifa_default) || 0;
      const base = _baseUnidadesAsistencia(unidad, a);
      return {
        ...a,
        titular_id: tit ? tit.id : null,
        titular_tipo: tit ? tit.tipo : null,
        titular_nombre: tit ? tit.nombre : '—',
        tarifa_default: tarifa,
        unidad_tarifa: unidad,
        base_unidades: Math.round(base * 100) / 100,
        monto_preview: Math.round(tarifa * base * 100) / 100
      };
    });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Valorizar (bulk, transaccional): impacta costo lote + CC ────────────────
router.post('/personal/valorizar', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso de valorización' });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ ok: false, error: 'Sin ítems para valorizar' });
  try {
    const resumen = { valorizadas: 0, monto_total: 0, errores: [] };
    const titularesTocados = new Set();
    const tx = db.transaction(() => {
      for (const it of items) {
        const a = db.prepare("SELECT * FROM pa_asistencias WHERE id=?").get(it.asistencia_id);
        if (!a) { resumen.errores.push(`Asistencia ${it.asistencia_id} inexistente`); continue; }
        if (a.estado !== 'pendiente_valorizar') { resumen.errores.push(`Asistencia ${a.id} no está pendiente`); continue; }
        const tit = _titularAsistencia(db, a);
        if (!tit) { resumen.errores.push(`Asistencia ${a.id} sin titular`); continue; }
        const padron = db.prepare("SELECT tarifa_default, unidad_tarifa FROM pa_personal WHERE id=?").get(tit.id);
        const unidad = (padron && padron.unidad_tarifa) || 'jornal';
        const tarifa = (it.tarifa_unitaria != null) ? Number(it.tarifa_unitaria) : ((padron && padron.tarifa_default) || 0);
        if (!(tarifa > 0)) { resumen.errores.push(`Asistencia ${a.id} sin tarifa (> 0)`); continue; }
        const base = _baseUnidadesAsistencia(unidad, a);
        const monto = Math.round(tarifa * base * 100) / 100;
        const categoria = _categoriaCostoAsistencia(db, a.rubro_cuenta_id, tit.tipo);
        const tarea = db.prepare("SELECT nombre FROM pa_tareas_tipos WHERE id=?").get(a.tarea_tipo_id);
        const rubro = db.prepare("SELECT nombre FROM pa_cuentas WHERE id=?").get(a.rubro_cuenta_id);
        const desc = `MO · ${tarea ? tarea.nombre : 'Asist.'} · ${rubro ? rubro.nombre : ''} · ${tit.nombre}`;

        // 1) Costo al lote (origen='asistencia', referencia_id positivo)
        const rc = db.prepare(`INSERT INTO pa_costos_lote
            (lote_id, campaña_id, campaña_anual_id, campaña_estacional_id, categoria, referencia_id, fecha, monto, descripcion, origen)
            VALUES (?,?,?,?,?,?,?,?,?, 'asistencia')`)
          .run(a.lote_id, a.campaña_anual_id, a.campaña_anual_id, a.campaña_estacional_id,
               categoria, a.id, a.fecha, monto, desc);

        // 2) CC: devengado (+)
        const rcc = db.prepare(`INSERT INTO pa_cc_movimientos
            (tipo_titular, titular_id, fecha, tipo_mov, monto, descripcion, referencia_tipo, referencia_id, cargado_por)
            VALUES (?,?,?, 'devengado', ?, ?, 'asistencia', ?, ?)`)
          .run(tit.tipo, tit.id, a.fecha, monto, desc, a.id, req.user.id);

        // 3) Valorización con IDs cruzados
        db.prepare(`INSERT INTO pa_asistencia_valorizacion
            (asistencia_id, tarifa_unitaria, unidad_tarifa, monto_total, detalle_json, valorizado_por, costo_lote_id, cc_movimiento_id)
            VALUES (?,?,?,?,?,?,?,?)`)
          .run(a.id, tarifa, unidad, monto,
               JSON.stringify({ tarifa, unidad, base_unidades: base, cantidad: a.cantidad, horas: a.horas, jornales: a.jornales_calc }),
               req.user.id, rc.lastInsertRowid, rcc.lastInsertRowid);

        // 4) Estado
        db.prepare("UPDATE pa_asistencias SET estado='valorizado' WHERE id=?").run(a.id);

        titularesTocados.add(tit.tipo + ':' + tit.id);
        resumen.valorizadas++;
        resumen.monto_total = Math.round((resumen.monto_total + monto) * 100) / 100;
      }
      // Recalcular saldos de los titulares afectados
      for (const key of titularesTocados) {
        const [tipo, id] = key.split(':');
        _recalcSaldoCC(db, tipo, Number(id));
      }
    });
    tx();
    res.json({ ok: true, data: resumen });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Anular asistencia valorizada (revierte CC + costo lote, transaccional) ──
router.post('/personal/asistencias/:id/anular', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso de valorización' });
  const motivo = (req.body.motivo || '').trim();
  if (!motivo) return res.status(400).json({ ok: false, error: 'Motivo de anulación requerido' });
  try {
    const a = db.prepare("SELECT * FROM pa_asistencias WHERE id=?").get(req.params.id);
    if (!a) return res.status(404).json({ ok: false, error: 'Asistencia no encontrada' });
    if (a.estado !== 'valorizado')
      return res.status(400).json({ ok: false, error: 'Solo se anula una asistencia valorizada (las pendientes se borran)' });
    const val = db.prepare("SELECT * FROM pa_asistencia_valorizacion WHERE asistencia_id=?").get(a.id);
    const tit = _titularAsistencia(db, a);
    const tx = db.transaction(() => {
      // 1) Revertir costo del lote (solo el de esta asistencia)
      db.prepare("DELETE FROM pa_costos_lote WHERE origen='asistencia' AND referencia_id=?").run(a.id);
      // 2) CC: movimiento de anulación (monto opuesto al devengado)
      if (val && tit) {
        db.prepare(`INSERT INTO pa_cc_movimientos
            (tipo_titular, titular_id, fecha, tipo_mov, monto, descripcion, referencia_tipo, referencia_id, cargado_por)
            VALUES (?,?, date('now','localtime'), 'anulacion', ?, ?, 'asistencia', ?, ?)`)
          .run(tit.tipo, tit.id, -val.monto_total, 'Anulación: ' + motivo, a.id, req.user.id);
        _recalcSaldoCC(db, tit.tipo, tit.id);
      }
      // 3) Estado
      db.prepare(`UPDATE pa_asistencias SET estado='anulado', anulado_en=datetime('now','localtime'),
          anulado_por=?, anulado_motivo=? WHERE id=?`).run(req.user.id, motivo, a.id);
    });
    tx();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Cuenta Corriente: listado de titulares con saldo ────────────────────────
router.get('/personal/cc/titulares', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso de valorización' });
  try {
    const { tipo, q, con_saldo } = req.query;
    let sql = `
      SELECT p.id, p.nombre, p.tipo,
        (SELECT saldo_acumulado FROM pa_cc_movimientos WHERE titular_id=p.id AND tipo_titular=p.tipo AND anulado=0 ORDER BY fecha DESC, id DESC LIMIT 1) as saldo,
        (SELECT MAX(fecha) FROM pa_cc_movimientos WHERE titular_id=p.id AND tipo_titular=p.tipo AND anulado=0) as ultimo_mov,
        (SELECT COUNT(*) FROM pa_cc_movimientos WHERE titular_id=p.id AND tipo_titular=p.tipo AND anulado=0) as n_movs
      FROM pa_personal p
      WHERE p.eliminado_en IS NULL`;
    const params = [];
    if (tipo === 'fijo' || tipo === 'contratista') { sql += " AND p.tipo=?"; params.push(tipo); }
    if (q) { sql += " AND p.nombre LIKE ?"; params.push(`%${q}%`); }
    sql += " ORDER BY p.tipo, p.nombre";
    let data = db.prepare(sql).all(...params);
    if (con_saldo) data = data.filter(r => r.n_movs > 0);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Cuenta Corriente: detalle de un titular ─────────────────────────────────
router.get('/personal/cc/:tipo/:id', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso de valorización' });
  try {
    const { tipo, id } = req.params;
    const titular = db.prepare("SELECT id, nombre, tipo, tarifa_default, unidad_tarifa FROM pa_personal WHERE id=?").get(id);
    if (!titular) return res.status(404).json({ ok: false, error: 'Titular no encontrado' });
    const movs = db.prepare(`
      SELECT m.*, u.nombre as cargado_por_nombre
      FROM pa_cc_movimientos m
      LEFT JOIN usuarios u ON u.id = m.cargado_por
      WHERE m.tipo_titular=? AND m.titular_id=?
      ORDER BY m.fecha, m.id`).all(tipo, id);
    const saldo = movs.filter(m => !m.anulado).reduce((s,m)=> Math.round((s+m.monto)*100)/100, 0);
    res.json({ ok: true, data: { titular, saldo, movimientos: movs } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── CC: registrar pago / adelanto / ajuste ──────────────────────────────────
router.post('/personal/cc/movimiento', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso de valorización' });
  const { tipo_titular, titular_id, tipo_mov, monto, fecha, descripcion } = req.body;
  if (!titular_id) return res.status(400).json({ ok: false, error: 'titular_id requerido' });
  if (!['pago','adelanto','ajuste'].includes(tipo_mov)) return res.status(400).json({ ok: false, error: 'tipo_mov inválido (pago/adelanto/ajuste)' });
  const m = Number(monto);
  if (!m || isNaN(m)) return res.status(400).json({ ok: false, error: 'monto inválido' });
  try {
    const tit = db.prepare("SELECT id, tipo FROM pa_personal WHERE id=?").get(titular_id);
    if (!tit) return res.status(404).json({ ok: false, error: 'Titular no encontrado' });
    const tt = tipo_titular || tit.tipo;
    // Pago/adelanto bajan saldo (negativo); ajuste respeta el signo enviado
    let signed = m;
    if (tipo_mov === 'pago' || tipo_mov === 'adelanto') signed = -Math.abs(m);
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO pa_cc_movimientos
          (tipo_titular, titular_id, fecha, tipo_mov, monto, descripcion, referencia_tipo, cargado_por)
          VALUES (?,?,?,?,?,?,?,?)`)
        .run(tt, titular_id, fecha || new Date().toISOString().slice(0,10), tipo_mov, signed,
             descripcion || null, tipo_mov + '_manual', req.user.id);
      _recalcSaldoCC(db, tt, titular_id);
    });
    tx();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── CC: anular un movimiento manual (pago/adelanto/ajuste) ──────────────────
router.post('/personal/cc/movimiento/:id/anular', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso de valorización' });
  try {
    const mov = db.prepare("SELECT * FROM pa_cc_movimientos WHERE id=?").get(req.params.id);
    if (!mov) return res.status(404).json({ ok: false, error: 'Movimiento no encontrado' });
    if (mov.tipo_mov === 'devengado' || mov.tipo_mov === 'anulacion')
      return res.status(400).json({ ok: false, error: 'Los devengados se revierten anulando la asistencia, no acá' });
    const tx = db.transaction(() => {
      db.prepare("UPDATE pa_cc_movimientos SET anulado=1, anulado_en=datetime('now','localtime'), anulado_por=? WHERE id=?")
        .run(req.user.id, mov.id);
      _recalcSaldoCC(db, mov.tipo_titular, mov.titular_id);
    });
    tx();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══ Backfill admin de pa_costos_lote.origen — dry-run + ejecución única ════
// Identifica filas viejas: parte (referencia_id<0), aplicacion (ref>0 + fert/agro), otros.
// NO modifica referencia_id (para no romper el anular de partes legacy).
function _planBackfillOrigen(db) {
  const parte = db.prepare("SELECT COUNT(*) n FROM pa_costos_lote WHERE origen IS NULL AND referencia_id < 0").get().n;
  const aplic = db.prepare("SELECT COUNT(*) n FROM pa_costos_lote WHERE origen IS NULL AND referencia_id > 0 AND categoria IN ('fertilizante','agroquimico')").get().n;
  const otros = db.prepare("SELECT COUNT(*) n FROM pa_costos_lote WHERE origen IS NULL AND NOT (referencia_id < 0) AND NOT (referencia_id > 0 AND categoria IN ('fertilizante','agroquimico'))").get().n;
  const ya    = db.prepare("SELECT COUNT(*) n FROM pa_costos_lote WHERE origen IS NOT NULL").get().n;
  return { parte, aplicacion: aplic, otros, ya_marcadas: ya, total_pendientes: parte + aplic + otros };
}

router.get('/personal/admin/costos-origen', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    const flag = db.prepare("SELECT key, ejecutado_en FROM sistema_flags WHERE key='backfill_costos_origen_v1'").get();
    res.json({ ok: true, data: { dry_run: true, ya_ejecutado: !!flag, plan: _planBackfillOrigen(db) } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/admin/costos-origen', requireAdmin, (req, res) => {
  const db = getDb();
  try {
    if (db.prepare("SELECT key FROM sistema_flags WHERE key='backfill_costos_origen_v1'").get())
      return res.status(400).json({ ok: false, error: 'El backfill ya se ejecutó (flag presente)' });
    const plan = _planBackfillOrigen(db);
    const tx = db.transaction(() => {
      db.prepare("UPDATE pa_costos_lote SET origen='parte'      WHERE origen IS NULL AND referencia_id < 0").run();
      db.prepare("UPDATE pa_costos_lote SET origen='aplicacion' WHERE origen IS NULL AND referencia_id > 0 AND categoria IN ('fertilizante','agroquimico')").run();
      db.prepare("UPDATE pa_costos_lote SET origen='otros'      WHERE origen IS NULL").run();
      db.prepare("INSERT INTO sistema_flags (key, valor) VALUES ('backfill_costos_origen_v1', ?)").run(JSON.stringify(plan));
    });
    tx();
    res.json({ ok: true, data: { ejecutado: plan } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PERSONAL V1 — Reportes + Export Excel + Rubros con uso (Fase 4)
// Todos sobre asistencias VALORIZADAS (monto = pa_asistencia_valorizacion).
// ═══════════════════════════════════════════════════════════════════════════

// Lazy load de SheetJS para generar Excel server-side (mismo patrón que IFCO).
let _xlsxPersonalLib = null;
async function _getXLSXPersonal() {
  if (_xlsxPersonalLib) return _xlsxPersonalLib;
  try {
    const mod = await import('xlsx');
    _xlsxPersonalLib = mod.default || mod;
    return _xlsxPersonalLib;
  } catch (e) {
    console.error('[Personal] xlsx (SheetJS) no disponible:', e.message);
    return null;
  }
}

// Snap de una fecha al jueves de su semana (jueves <= fecha). %w: 0=dom..6=sab, jueves=4.
function _juevesDeLaSemana(db, fecha) {
  return db.prepare("SELECT date(?, '-' || ((strftime('%w', ?)+7-4)%7) || ' days') d").get(fecha, fecha).d;
}

// Config de los reportes tabulares. Cada run(db,{desde,hasta}) devuelve filas planas.
// columns: {key,label,money?,num?} — money/num se exportan como número real al xlsx.
const REPORTES_PERSONAL = {
  'por-trabajador': {
    titulo: 'Personal — Reporte por trabajador (fijos, asistencia individual)',
    columns: [
      { key: 'titular', label: 'Trabajador' },
      { key: 'asistencias', label: 'Asistencias', num: true },
      { key: 'jornales', label: 'Jornales', num: true },
      { key: 'monto', label: 'Monto', money: true }
    ],
    run: (db, q) => {
      const where = ["a.estado='valorizado'", 'a.personal_id IS NOT NULL'], p = [];
      if (q.desde) { where.push('a.fecha>=?'); p.push(q.desde); }
      if (q.hasta) { where.push('a.fecha<=?'); p.push(q.hasta); }
      return db.prepare(`
        SELECT pe.id AS titular_id, pe.nombre AS titular,
          COUNT(*) AS asistencias,
          COALESCE(SUM(a.jornales_calc),0) AS jornales,
          COALESCE(SUM(v.monto_total),0) AS monto
        FROM pa_asistencias a
        JOIN pa_asistencia_valorizacion v ON v.asistencia_id=a.id
        JOIN pa_personal pe ON pe.id=a.personal_id
        WHERE ${where.join(' AND ')}
        GROUP BY pe.id, pe.nombre ORDER BY monto DESC`).all(...p);
    }
  },
  'por-contratista': {
    titulo: 'Personal — Reporte por contratista (bloques)',
    columns: [
      { key: 'titular', label: 'Contratista' },
      { key: 'asistencias', label: 'Asistencias', num: true },
      { key: 'personas', label: 'Personas (suma)', num: true },
      { key: 'jornales', label: 'Jornales', num: true },
      { key: 'monto', label: 'Monto', money: true }
    ],
    run: (db, q) => {
      const where = ["a.estado='valorizado'", 'a.contratista_id IS NOT NULL'], p = [];
      if (q.desde) { where.push('a.fecha>=?'); p.push(q.desde); }
      if (q.hasta) { where.push('a.fecha<=?'); p.push(q.hasta); }
      return db.prepare(`
        SELECT pe.id AS titular_id, pe.nombre AS titular,
          COUNT(*) AS asistencias,
          COALESCE(SUM(a.cantidad),0) AS personas,
          COALESCE(SUM(a.jornales_calc),0) AS jornales,
          COALESCE(SUM(v.monto_total),0) AS monto
        FROM pa_asistencias a
        JOIN pa_asistencia_valorizacion v ON v.asistencia_id=a.id
        JOIN pa_personal pe ON pe.id=a.contratista_id
        WHERE ${where.join(' AND ')}
        GROUP BY pe.id, pe.nombre ORDER BY monto DESC`).all(...p);
    }
  },
  'por-finca': {
    titulo: 'Personal — Reporte por finca',
    columns: [
      { key: 'finca', label: 'Finca' },
      { key: 'asistencias', label: 'Asistencias', num: true },
      { key: 'jornales', label: 'Jornales', num: true },
      { key: 'monto', label: 'Monto', money: true }
    ],
    run: (db, q) => {
      const where = ["a.estado='valorizado'"], p = [];
      if (q.desde) { where.push('a.fecha>=?'); p.push(q.desde); }
      if (q.hasta) { where.push('a.fecha<=?'); p.push(q.hasta); }
      // GROUP BY expresión repetida (no alias) para evitar colisión con a.finca real.
      return db.prepare(`
        SELECT COALESCE(NULLIF(a.finca,''),'(sin finca)') AS finca,
          COUNT(*) AS asistencias,
          COALESCE(SUM(a.jornales_calc),0) AS jornales,
          COALESCE(SUM(v.monto_total),0) AS monto
        FROM pa_asistencias a
        JOIN pa_asistencia_valorizacion v ON v.asistencia_id=a.id
        WHERE ${where.join(' AND ')}
        GROUP BY COALESCE(NULLIF(a.finca,''),'(sin finca)') ORDER BY monto DESC`).all(...p);
    }
  },
  'por-rubro': {
    titulo: 'Personal — Reporte por rubro (cuenta MO)',
    columns: [
      { key: 'rubro_codigo', label: 'Código' },
      { key: 'rubro_nombre', label: 'Rubro MO' },
      { key: 'asistencias', label: 'Asistencias', num: true },
      { key: 'jornales', label: 'Jornales', num: true },
      { key: 'monto', label: 'Monto', money: true }
    ],
    run: (db, q) => {
      const where = ["a.estado='valorizado'"], p = [];
      if (q.desde) { where.push('a.fecha>=?'); p.push(q.desde); }
      if (q.hasta) { where.push('a.fecha<=?'); p.push(q.hasta); }
      return db.prepare(`
        SELECT c.id AS rubro_id, c.codigo AS rubro_codigo, c.nombre AS rubro_nombre,
          COUNT(*) AS asistencias,
          COALESCE(SUM(a.jornales_calc),0) AS jornales,
          COALESCE(SUM(v.monto_total),0) AS monto
        FROM pa_asistencias a
        JOIN pa_asistencia_valorizacion v ON v.asistencia_id=a.id
        JOIN pa_cuentas c ON c.id=a.rubro_cuenta_id
        WHERE ${where.join(' AND ')}
        GROUP BY c.id, c.codigo, c.nombre ORDER BY monto DESC`).all(...p);
    }
  }
};

// Suma de las columnas num/money para la fila de totales.
function _totalesReporte(cfg, rows) {
  const tot = {};
  for (const c of cfg.columns) if (c.num || c.money) tot[c.key] = rows.reduce((a, r) => a + (Number(r[c.key]) || 0), 0);
  return tot;
}

// JSON de un reporte tabular.
function _reporteJson(key) {
  return (req, res) => {
    const db = getDb();
    const perms = permisosPersonal(db, req.user);
    if (!perms.valorizacion && !perms.admin)
      return res.status(403).json({ ok: false, error: 'Sin permiso de valorización' });
    try {
      const cfg = REPORTES_PERSONAL[key];
      const rows = cfg.run(db, req.query);
      res.json({ ok: true, data: rows, totales: _totalesReporte(cfg, rows), columns: cfg.columns });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  };
}

// Construye el buffer .xlsx de un reporte (encabezado + subtítulos + tabla + totales).
function _buildReporteXlsx(XLSX, titulo, subtitulos, columns, rows, totales) {
  const aoa = [];
  aoa.push([titulo]);
  (subtitulos || []).forEach(s => aoa.push([s]));
  aoa.push([]);
  aoa.push(columns.map(c => c.label));
  const firstDataRow = aoa.length;
  rows.forEach(r => aoa.push(columns.map(c => (c.num || c.money) ? Number(r[c.key] || 0) : (r[c.key] != null ? String(r[c.key]) : ''))));
  // Fila de totales
  if (rows.length) {
    aoa.push(columns.map((c, i) => i === 0 ? 'TOTAL' : ((c.num || c.money) ? Number(totales[c.key] || 0) : '')));
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = columns.map(c => ({ wch: c.money ? 16 : (c.num ? 12 : 34) }));
  // Formato numérico/$ en columnas num/money
  for (let r = firstDataRow; r < aoa.length; r++) {
    columns.forEach((c, ci) => {
      if (!(c.num || c.money)) return;
      const ref = XLSX.utils.encode_cell({ r, c: ci });
      const cell = ws[ref];
      if (cell && typeof cell.v === 'number') { cell.t = 'n'; cell.z = c.money ? '$#,##0' : '#,##0'; }
    });
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Reporte');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

// .xlsx de un reporte tabular.
function _reporteXlsx(key) {
  return async (req, res) => {
    const db = getDb();
    const perms = permisosPersonal(db, req.user);
    if (!perms.valorizacion && !perms.admin)
      return res.status(403).json({ ok: false, error: 'Sin permiso de valorización' });
    try {
      const XLSX = await _getXLSXPersonal();
      if (!XLSX) return res.status(503).json({ ok: false, error: 'xlsx (SheetJS) no disponible' });
      const cfg = REPORTES_PERSONAL[key];
      const rows = cfg.run(db, req.query);
      const subt = [];
      if (req.query.desde || req.query.hasta) subt.push('Período: ' + (req.query.desde || 'inicio') + ' a ' + (req.query.hasta || 'hoy'));
      const buf = _buildReporteXlsx(XLSX, cfg.titulo, subt, cfg.columns, rows, _totalesReporte(cfg, rows));
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="personal-' + key + '.xlsx"');
      res.send(buf);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  };
}

// Registro de los 4 reportes tabulares (JSON + .xlsx)
for (const key of Object.keys(REPORTES_PERSONAL)) {
  router.get('/personal/reportes/' + key, requireAuth, _reporteJson(key));
  router.get('/personal/reportes/' + key + '.xlsx', requireAuth, _reporteXlsx(key));
}

// ── Cierre semanal (jueves a jueves): consolidado por titular ──────────────
const CIERRE_COLS = [
  { key: 'titular', label: 'Titular' },
  { key: 'tipo', label: 'Tipo' },
  { key: 'asistencias', label: 'Asistencias', num: true },
  { key: 'jornales', label: 'Jornales', num: true },
  { key: 'monto', label: 'Monto', money: true }
];
function _cierreSemanal(db, fechaJueves) {
  const fecha = (fechaJueves || '').slice(0, 10) || db.prepare("SELECT date('now','localtime') d").get().d;
  const jueves = _juevesDeLaSemana(db, fecha);
  const hasta = db.prepare("SELECT date(?, '+6 days') d").get(jueves).d;
  const rows = db.prepare(`
    WITH base AS (
      SELECT COALESCE(a.personal_id, a.contratista_id) AS tit_id, a.jornales_calc, v.monto_total
      FROM pa_asistencias a
      JOIN pa_asistencia_valorizacion v ON v.asistencia_id=a.id
      WHERE a.estado='valorizado' AND a.fecha>=? AND a.fecha<=?
    )
    SELECT pe.id AS titular_id, pe.nombre AS titular, pe.tipo AS tipo,
      COUNT(*) AS asistencias,
      COALESCE(SUM(b.jornales_calc),0) AS jornales,
      COALESCE(SUM(b.monto_total),0) AS monto
    FROM base b JOIN pa_personal pe ON pe.id=b.tit_id
    GROUP BY pe.id, pe.nombre, pe.tipo ORDER BY monto DESC`).all(jueves, hasta);
  return { jueves, hasta, rows };
}

router.get('/personal/reportes/cierre-semanal', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso de valorización' });
  try {
    const { jueves, hasta, rows } = _cierreSemanal(db, req.query.fecha_inicio_jueves);
    const cfg = { columns: CIERRE_COLS };
    res.json({ ok: true, data: rows, totales: _totalesReporte(cfg, rows), columns: CIERRE_COLS, semana: { desde: jueves, hasta } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/personal/reportes/cierre-semanal.xlsx', requireAuth, async (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso de valorización' });
  try {
    const XLSX = await _getXLSXPersonal();
    if (!XLSX) return res.status(503).json({ ok: false, error: 'xlsx (SheetJS) no disponible' });
    const { jueves, hasta, rows } = _cierreSemanal(db, req.query.fecha_inicio_jueves);
    const cfg = { columns: CIERRE_COLS };
    const buf = _buildReporteXlsx(XLSX, 'Personal — Cierre semanal', ['Semana: ' + jueves + ' a ' + hasta + ' (jueves a jueves)'],
      CIERRE_COLS, rows, _totalesReporte(cfg, rows));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="personal-cierre-semanal-' + jueves + '.xlsx"');
    res.send(buf);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Rubros MO read-only con conteo de uso en asistencias ───────────────────
router.get('/personal/reportes/rubros-uso', requireAuth, (req, res) => {
  const db = getDb();
  const perms = permisosPersonal(db, req.user);
  if (!perms.asistencia && !perms.valorizacion && !perms.admin)
    return res.status(403).json({ ok: false, error: 'Sin permiso del módulo Personal' });
  try {
    const data = db.prepare(`
      SELECT c.id, c.codigo, c.nombre,
        (SELECT COUNT(*) FROM pa_asistencias a WHERE a.rubro_cuenta_id=c.id) AS usos,
        (SELECT COUNT(*) FROM pa_asistencias a WHERE a.rubro_cuenta_id=c.id AND a.estado='valorizado') AS usos_valorizados
      FROM pa_cuentas c
      WHERE c.nombre LIKE 'MO %'
      ORDER BY usos DESC, c.codigo`).all();
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Tipos de tarea ─────────────────────────────────────────────────────────
router.get('/personal/tareas-tipos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const data = db.prepare(`
      SELECT t.*, r.nombre as rubro_fijo_nombre
      FROM pa_tareas_tipos t
      LEFT JOIN pa_rubros_contables r ON r.id = t.rubro_contable_id
      WHERE t.activo=1 ORDER BY t.tipo_labor, t.nombre
    `).all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/personal/tareas-tipos', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo_labor, rubro_contable_id, es_destajo, unidad_destajo } = req.body;
  if (!nombre || !tipo_labor) return res.status(400).json({ ok: false, error: 'nombre y tipo_labor requeridos' });
  try {
    const r = db.prepare(`INSERT INTO pa_tareas_tipos
        (nombre, tipo_labor, rubro_contable_id, es_destajo, unidad_destajo)
        VALUES (?,?,?,?,?)`)
      .run(nombre, tipo_labor,
           rubro_contable_id || null,
           es_destajo ? 1 : 0,
           unidad_destajo || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ ok: false, error: 'Ya existe una tarea con ese nombre' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/personal/tareas-tipos/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, tipo_labor, rubro_contable_id, es_destajo, unidad_destajo, activo } = req.body;
  try {
    const c = db.prepare("SELECT * FROM pa_tareas_tipos WHERE id=?").get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Tarea no encontrada' });
    db.prepare(`UPDATE pa_tareas_tipos SET nombre=?, tipo_labor=?, rubro_contable_id=?, es_destajo=?, unidad_destajo=?, activo=? WHERE id=?`)
      .run(nombre || c.nombre, tipo_labor || c.tipo_labor,
           rubro_contable_id !== undefined ? rubro_contable_id : c.rubro_contable_id,
           es_destajo !== undefined ? (es_destajo ? 1 : 0) : c.es_destajo,
           unidad_destajo !== undefined ? unidad_destajo : c.unidad_destajo,
           activo !== undefined ? (activo ? 1 : 0) : c.activo,
           req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Sugerir rubro — cruza tipo_labor de la tarea con cultivo del lote ─────
function sugerirRubroContable(db, loteId, tareaTipoId) {
  const tarea = db.prepare("SELECT * FROM pa_tareas_tipos WHERE id=?").get(tareaTipoId);
  if (!tarea) return null;

  // Si la tarea tiene rubro fijo, usarlo directo
  if (tarea.rubro_contable_id) {
    return db.prepare("SELECT * FROM pa_rubros_contables WHERE id=?").get(tarea.rubro_contable_id);
  }

  // Si el tipo_labor es "general" o "otro" sin rubro fijo, fallback a GENERALES
  if (tarea.tipo_labor === 'general' || tarea.tipo_labor === 'otro') {
    return db.prepare("SELECT * FROM pa_rubros_contables WHERE nombre='G -MO GENERALES' OR tipo_labor='general' LIMIT 1").get();
  }

  // Tipos produccion / cosecha_empaque → buscar por cultivo del lote en campaña activa
  const camp = db.prepare("SELECT nombre FROM pa_campañas WHERE activa=1 LIMIT 1").get();
  if (!camp) return null;

  const cult = db.prepare(`
    SELECT cultivo FROM pa_cultivos_lote
    WHERE lote_id=? AND campaña=?
    LIMIT 1
  `).get(loteId, camp.nombre);

  if (!cult || !cult.cultivo) {
    // Sin cultivo asignado → fallback a rubro general del tipo_labor
    return db.prepare("SELECT * FROM pa_rubros_contables WHERE tipo_labor=? AND cultivo IS NULL LIMIT 1").get(tarea.tipo_labor);
  }

  // Normalizar nombre del cultivo a las keys del catálogo de rubros
  const cultNorm = String(cult.cultivo).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // quitar acentos
    .replace(/ó|o/g, 'o');
  // Matcheo flexible: contiene el key del rubro
  const rubros = db.prepare("SELECT * FROM pa_rubros_contables WHERE tipo_labor=? AND cultivo IS NOT NULL").all(tarea.tipo_labor);
  let match = rubros.find(r => cultNorm.includes(r.cultivo));
  if (!match) {
    // Fallback: rubro sin cultivo (ej GENERAL de ese tipo_labor)
    match = db.prepare("SELECT * FROM pa_rubros_contables WHERE tipo_labor=? AND cultivo IS NULL LIMIT 1").get(tarea.tipo_labor);
  }
  return match || db.prepare("SELECT * FROM pa_rubros_contables WHERE nombre LIKE '%GENERALES%' LIMIT 1").get();
}

router.get('/personal/sugerir-rubro', requireAuth, (req, res) => {
  const db = getDb();
  const { lote_id, tarea_tipo_id } = req.query;
  if (!lote_id || !tarea_tipo_id) return res.status(400).json({ ok: false, error: 'lote_id y tarea_tipo_id requeridos' });
  try {
    const rubro = sugerirRubroContable(db, parseInt(lote_id), parseInt(tarea_tipo_id));
    res.json({ ok: true, data: rubro });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SOFT DELETE — DESACTIVAR registros sin borrarlos de DB
// ═══════════════════════════════════════════════════════════════════════════

// Desactivar / reactivar COMPRA (revierte stock y movimientos si desactiva)
router.delete('/compras/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const cur = db.prepare("SELECT id, activo FROM pa_compras WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Compra no encontrada' });
    if (!cur.activo) return res.json({ ok: true, msg: 'Ya estaba desactivada' });

    // Revertir stock y borrar movimientos generados por esta compra
    const revertir = db.transaction(() => {
      const items = db.prepare("SELECT insumo_id, cantidad FROM pa_compras_items WHERE compra_id = ?").all(req.params.id);
      for (const it of items) {
        db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual - ? WHERE id = ?")
          .run(it.cantidad, it.insumo_id);
      }
      db.prepare("DELETE FROM pa_movimientos_stock WHERE motivo = 'compra' AND referencia_id = ?")
        .run(req.params.id);
      db.prepare("UPDATE pa_compras SET activo = 0 WHERE id = ?").run(req.params.id);
      // Anular el asiento contable asociado a esta compra (si existe)
      const asiento = db.prepare("SELECT id FROM pa_asientos WHERE ref_compra_id = ? AND anulado = 0").get(req.params.id);
      if (asiento) {
        const usuario = req.cookies?.lnb_user ? JSON.parse(req.cookies.lnb_user).id : null;
        db.prepare("UPDATE pa_asientos SET anulado = 1, anulado_por = ?, anulado_en = datetime('now','localtime') WHERE id = ?")
          .run(usuario, asiento.id);
      }
    });
    revertir();
    res.json({ ok: true, msg: 'Compra desactivada y stock revertido' });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Reactivar compra
router.post('/compras/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const cur = db.prepare("SELECT id, activo, fecha FROM pa_compras WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Compra no encontrada' });
    if (cur.activo) return res.json({ ok: true, msg: 'Ya estaba activa' });

    const reactivar = db.transaction(() => {
      const items = db.prepare("SELECT insumo_id, cantidad FROM pa_compras_items WHERE compra_id = ?").all(req.params.id);
      for (const it of items) {
        db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual + ? WHERE id = ?")
          .run(it.cantidad, it.insumo_id);
        db.prepare("INSERT INTO pa_movimientos_stock (fecha, insumo_id, tipo, cantidad, motivo, referencia_id) VALUES (?,?,?,?,?,?)")
          .run(cur.fecha, it.insumo_id, 'entrada', it.cantidad, 'compra', req.params.id);
      }
      db.prepare("UPDATE pa_compras SET activo = 1 WHERE id = ?").run(req.params.id);
    });
    reactivar();
    res.json({ ok: true, msg: 'Compra reactivada y stock sumado' });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// HARD DELETE de compra (borrado definitivo, solo admin) — IRREVERSIBLE.
// NO revierte stock: la compra se trata como si nunca hubiera existido.
// Borra en una transacción: ítems, movimientos de stock, asientos contables
// (+ sus líneas) y la compra.
// ─────────────────────────────────────────────────────────────────────────
router.post('/compras/:id/hard-delete', requireAuth, (req, res) => {
  if (!req.user || req.user.rol !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Solo admin puede borrar definitivamente' });
  }
  const db = getDb();
  const compraId = req.params.id;
  try {
    const compra = db.prepare("SELECT id, nro_factura, total FROM pa_compras WHERE id = ?").get(compraId);
    if (!compra) return res.status(404).json({ ok: false, error: 'Compra no encontrada' });

    const tx = db.transaction(() => {
      // Asientos contables generados por esta compra (+ sus líneas)
      const asientos = db.prepare("SELECT id FROM pa_asientos WHERE ref_compra_id = ?").all(compraId);
      let asientoLineasBorradas = 0;
      for (const a of asientos) {
        asientoLineasBorradas += db.prepare("DELETE FROM pa_asientos_lineas WHERE asiento_id = ?").run(a.id).changes;
      }
      const asientosBorrados = db.prepare("DELETE FROM pa_asientos WHERE ref_compra_id = ?").run(compraId).changes;

      // Movimientos de stock de la compra (NO se revierte el stock a propósito)
      const movsBorrados = db.prepare("DELETE FROM pa_movimientos_stock WHERE motivo = 'compra' AND referencia_id = ?").run(compraId).changes;

      // Ítems de la compra
      const itemsBorrados = db.prepare("DELETE FROM pa_compras_items WHERE compra_id = ?").run(compraId).changes;

      // La compra
      db.prepare("DELETE FROM pa_compras WHERE id = ?").run(compraId);

      return { itemsBorrados, movsBorrados, asientosBorrados, asientoLineasBorradas };
    });

    const detalle = tx();
    console.log(
      `[PA][HARD-DELETE] usuario=${req.user.id} (${req.user.nombre || req.user.email || '?'}, rol=${req.user.rol}) ` +
      `borró DEFINITIVO compra #${compraId} (nro_factura=${compra.nro_factura || '—'}, total=${compra.total}) | ` +
      `items=${detalle.itemsBorrados} movs_stock=${detalle.movsBorrados} ` +
      `asientos=${detalle.asientosBorrados} asiento_lineas=${detalle.asientoLineasBorradas}`
    );
    res.json({ ok: true, eliminada: detalle });
  } catch(e) {
    console.error(`[PA][HARD-DELETE] error borrando compra #${compraId} por usuario=${req.user?.id}:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Desactivar insumo (soft delete)
router.delete('/insumos/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const cur = db.prepare("SELECT id, activo FROM pa_insumos WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    db.prepare("UPDATE pa_insumos SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Reactivar insumo
router.post('/insumos/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_insumos SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Desactivar vehículo (soft delete)
router.delete('/combustible/vehiculos/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const cur = db.prepare("SELECT id FROM pa_vehiculos WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Vehículo no encontrado' });
    db.prepare("UPDATE pa_vehiculos SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Reactivar vehículo
router.post('/combustible/vehiculos/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_vehiculos SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Trabajadores / Grupos / Cuadrillas / Rubros / Proveedores / Lotes ──

router.delete('/personal/trabajadores/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_trabajadores SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/personal/trabajadores/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_trabajadores SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/personal/grupos/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    // No se puede desactivar el grupo "Sin asignar" (id=1)
    if (Number(req.params.id) === 1) return res.status(400).json({ ok: false, error: 'No se puede desactivar el grupo "Sin asignar"' });
    db.prepare("UPDATE pa_grupos SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/personal/grupos/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_grupos SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/personal/cuadrillas/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_cuadrillas SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/personal/cuadrillas/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_cuadrillas SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/personal/rubros/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_rubros_contables SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/personal/rubros/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_rubros_contables SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/proveedores/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_proveedores SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/proveedores/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_proveedores SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/lotes/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_lotes SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/lotes/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_lotes SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// PAÑOL — herramientas durables identificadas por unidad
// ─────────────────────────────────────────────────────────────────────────

// CATEGORÍAS
router.get('/panol/categorias', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const incluirInactivas = req.query.incluir_inactivos === '1';
    const where = incluirInactivas ? '' : 'WHERE activo = 1';
    const data = db.prepare(`SELECT * FROM pa_panol_categorias ${where} ORDER BY nombre`).all();
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/panol/categorias', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, icono } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
  try {
    const r = db.prepare("INSERT INTO pa_panol_categorias (nombre, icono) VALUES (?, ?)")
      .run(nombre.trim(), icono || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/panol/categorias/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { nombre, icono } = req.body;
  try {
    const cur = db.prepare("SELECT * FROM pa_panol_categorias WHERE id=?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'No encontrada' });
    db.prepare("UPDATE pa_panol_categorias SET nombre=?, icono=? WHERE id=?")
      .run(nombre || cur.nombre, icono !== undefined ? icono : cur.icono, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/panol/categorias/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_panol_categorias SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/panol/categorias/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_panol_categorias SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// UNIDADES — listar (enriquece con categoría y trabajador actual)
router.get('/panol/unidades', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const incluirInactivas = req.query.incluir_inactivos === '1';
    const filtroEstado = req.query.estado || null;
    const filtroCategoria = req.query.categoria_id ? parseInt(req.query.categoria_id, 10) : null;
    const filtroTrabajador = req.query.trabajador_id ? parseInt(req.query.trabajador_id, 10) : null;

    const conds = [];
    const args = [];
    if (!incluirInactivas) conds.push('u.activo = 1');
    if (filtroEstado) { conds.push('u.estado = ?'); args.push(filtroEstado); }
    if (filtroCategoria) { conds.push('u.categoria_id = ?'); args.push(filtroCategoria); }
    if (filtroTrabajador) { conds.push('u.trabajador_actual_id = ?'); args.push(filtroTrabajador); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const data = db.prepare(`
      SELECT u.*,
        c.nombre AS categoria_nombre,
        c.icono  AS categoria_icono,
        t.nombre AS trabajador_actual_nombre
      FROM pa_panol_unidades u
      LEFT JOIN pa_panol_categorias c ON c.id = u.categoria_id
      LEFT JOIN pa_trabajadores t ON t.id = u.trabajador_actual_id
      ${where}
      ORDER BY u.codigo_interno
    `).all(...args);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// UNIDADES — detalle con historial de movimientos
router.get('/panol/unidades/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const u = db.prepare(`
      SELECT u.*,
        c.nombre AS categoria_nombre,
        c.icono  AS categoria_icono,
        t.nombre AS trabajador_actual_nombre
      FROM pa_panol_unidades u
      LEFT JOIN pa_panol_categorias c ON c.id = u.categoria_id
      LEFT JOIN pa_trabajadores t ON t.id = u.trabajador_actual_id
      WHERE u.id = ?
    `).get(req.params.id);
    if (!u) return res.status(404).json({ ok: false, error: 'No encontrada' });
    const movimientos = db.prepare(`
      SELECT m.*,
        t.nombre AS trabajador_nombre,
        usr.nombre AS quien_registra_nombre
      FROM pa_panol_movimientos m
      LEFT JOIN pa_trabajadores t ON t.id = m.trabajador_id
      LEFT JOIN users usr ON usr.id = m.quien_registra
      WHERE m.unidad_id = ?
      ORDER BY m.fecha DESC, m.id DESC
    `).all(req.params.id);
    res.json({ ok: true, data: u, movimientos });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// UNIDADES — crear (alta manual; también deja un movimiento 'alta')
router.post('/panol/unidades', requireAuth, (req, res) => {
  const db = getDb();
  const {
    codigo_interno, nombre, categoria_id, marca, modelo, numero_serie,
    compra_id, precio_compra, ubicacion_actual, notas
  } = req.body;
  if (!codigo_interno || !codigo_interno.trim())
    return res.status(400).json({ ok: false, error: 'Código interno requerido' });
  if (!nombre || !nombre.trim())
    return res.status(400).json({ ok: false, error: 'Nombre requerido' });
  try {
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pa_panol_unidades
          (codigo_interno, nombre, categoria_id, marca, modelo, numero_serie,
           compra_id, precio_compra, ubicacion_actual, notas, estado)
        VALUES (?,?,?,?,?,?,?,?,?,?,'disponible')
      `).run(
        codigo_interno.trim(), nombre.trim(),
        categoria_id || null, marca || null, modelo || null, numero_serie || null,
        compra_id || null, precio_compra || null, ubicacion_actual || null, notas || null
      );
      const unidadId = r.lastInsertRowid;
      // Registrar movimiento de alta
      db.prepare(`
        INSERT INTO pa_panol_movimientos (unidad_id, tipo, quien_registra, notas)
        VALUES (?, 'alta', ?, ?)
      `).run(unidadId, req.user.id, 'Alta inicial de la herramienta');
      return unidadId;
    });
    const id = tx();
    res.json({ ok: true, id });
  } catch(e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ ok: false, error: 'Ya existe una unidad con ese código interno' });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// UNIDADES — actualizar (datos descriptivos, NO estado/ubicación que van por movimientos)
router.patch('/panol/unidades/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { codigo_interno, nombre, categoria_id, marca, modelo, numero_serie,
          compra_id, precio_compra, ubicacion_actual, notas } = req.body;
  try {
    const cur = db.prepare("SELECT * FROM pa_panol_unidades WHERE id=?").get(req.params.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'No encontrada' });
    db.prepare(`
      UPDATE pa_panol_unidades SET
        codigo_interno=?, nombre=?, categoria_id=?, marca=?, modelo=?, numero_serie=?,
        compra_id=?, precio_compra=?, ubicacion_actual=?, notas=?
      WHERE id=?
    `).run(
      codigo_interno||cur.codigo_interno, nombre||cur.nombre,
      categoria_id!==undefined?categoria_id:cur.categoria_id,
      marca!==undefined?marca:cur.marca, modelo!==undefined?modelo:cur.modelo,
      numero_serie!==undefined?numero_serie:cur.numero_serie,
      compra_id!==undefined?compra_id:cur.compra_id,
      precio_compra!==undefined?precio_compra:cur.precio_compra,
      ubicacion_actual!==undefined?ubicacion_actual:cur.ubicacion_actual,
      notas!==undefined?notas:cur.notas,
      req.params.id
    );
    res.json({ ok: true });
  } catch(e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ ok: false, error: 'Código interno ya en uso' });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/panol/unidades/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_panol_unidades SET activo = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/panol/unidades/:id/reactivar', requireAuth, (req, res) => {
  const db = getDb();
  try {
    db.prepare("UPDATE pa_panol_unidades SET activo = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// MOVIMIENTOS — registrar préstamo, devolución, reparación, baja, etc.
// Endpoint único que adapta la lógica según `tipo`.
router.post('/panol/unidades/:id/movimiento', requireAuth, (req, res) => {
  const db = getDb();
  const unidadId = parseInt(req.params.id, 10);
  const { tipo, trabajador_id, condicion, motivo, notas, fecha, lat, lng } = req.body;
  const tiposValidos = ['prestamo','devolucion','reparacion_inicio','reparacion_fin','baja','extravio'];
  if (!tiposValidos.includes(tipo))
    return res.status(400).json({ ok: false, error: 'Tipo de movimiento inválido' });
  try {
    const u = db.prepare("SELECT * FROM pa_panol_unidades WHERE id=?").get(unidadId);
    if (!u) return res.status(404).json({ ok: false, error: 'Unidad no encontrada' });

    // Validaciones según tipo
    if (tipo === 'prestamo') {
      if (u.estado !== 'disponible')
        return res.status(400).json({ ok: false, error: `No se puede prestar: estado actual '${u.estado}'` });
      if (!trabajador_id)
        return res.status(400).json({ ok: false, error: 'Trabajador requerido para préstamo' });
    }
    if (tipo === 'devolucion') {
      if (u.estado !== 'prestada')
        return res.status(400).json({ ok: false, error: `No se puede devolver: estado actual '${u.estado}'` });
    }
    if (tipo === 'reparacion_inicio') {
      if (u.estado === 'dada_de_baja' || u.estado === 'extraviada')
        return res.status(400).json({ ok: false, error: `No se puede mandar a reparación: estado '${u.estado}'` });
    }
    if (tipo === 'reparacion_fin') {
      if (u.estado !== 'en_reparacion')
        return res.status(400).json({ ok: false, error: `No está en reparación` });
    }

    const tx = db.transaction(() => {
      // Insertar movimiento
      db.prepare(`
        INSERT INTO pa_panol_movimientos
          (unidad_id, tipo, fecha, trabajador_id, quien_registra, condicion, motivo, notas, lat, lng)
        VALUES (?, ?, COALESCE(?, datetime('now','localtime')), ?, ?, ?, ?, ?, ?, ?)
      `).run(
        unidadId, tipo, fecha || null,
        trabajador_id || null, req.user.id,
        condicion || null, motivo || null, notas || null,
        lat || null, lng || null
      );

      // Actualizar estado/ubicación de la unidad según tipo
      let nuevoEstado = u.estado;
      let nuevoTrab = u.trabajador_actual_id;
      let nuevaUbic = u.ubicacion_actual;
      let fechaBaja = u.fecha_baja;
      switch (tipo) {
        case 'prestamo':
          nuevoEstado = 'prestada';
          nuevoTrab = trabajador_id;
          // Resolver nombre del trabajador para ubicacion textual
          const t = db.prepare("SELECT nombre FROM pa_trabajadores WHERE id=?").get(trabajador_id);
          nuevaUbic = t ? `Con ${t.nombre}` : 'Prestada';
          break;
        case 'devolucion':
          nuevoEstado = 'disponible';
          nuevoTrab = null;
          nuevaUbic = 'Pañol';
          break;
        case 'reparacion_inicio':
          nuevoEstado = 'en_reparacion';
          nuevoTrab = null;
          nuevaUbic = 'En reparación';
          break;
        case 'reparacion_fin':
          nuevoEstado = 'disponible';
          nuevaUbic = 'Pañol';
          break;
        case 'baja':
          nuevoEstado = 'dada_de_baja';
          nuevoTrab = null;
          fechaBaja = fechaBaja || new Date().toISOString().slice(0,10);
          break;
        case 'extravio':
          nuevoEstado = 'extraviada';
          nuevoTrab = null;
          break;
      }
      db.prepare(`
        UPDATE pa_panol_unidades
        SET estado=?, trabajador_actual_id=?, ubicacion_actual=?, fecha_baja=?
        WHERE id=?
      `).run(nuevoEstado, nuevoTrab, nuevaUbic, fechaBaja, unidadId);
    });
    tx();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// MOVIMIENTOS — listar últimos N (para timeline general)
router.get('/panol/movimientos', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const data = db.prepare(`
      SELECT m.*,
        u.codigo_interno, u.nombre AS unidad_nombre,
        t.nombre AS trabajador_nombre,
        usr.nombre AS quien_registra_nombre
      FROM pa_panol_movimientos m
      JOIN pa_panol_unidades u ON u.id = m.unidad_id
      LEFT JOIN pa_trabajadores t ON t.id = m.trabajador_id
      LEFT JOIN users usr ON usr.id = m.quien_registra
      ORDER BY m.fecha DESC, m.id DESC
      LIMIT ?
    `).all(limit);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
