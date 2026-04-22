// src/rutas/scout.js
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../servicios/db.js';
import '../servicios/db_pa.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = getDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS pa_scout_reportes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id         INTEGER NOT NULL REFERENCES pa_lotes(id),
    usuario_id      INTEGER NOT NULL REFERENCES usuarios(id),
    tipo            TEXT NOT NULL,
    severidad       INTEGER NOT NULL CHECK(severidad BETWEEN 1 AND 4),
    descripcion     TEXT,
    lat             REAL,
    lng             REAL,
    foto_path       TEXT,
    estado          TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente','en_proceso','resuelto')),
    prioridad_alta  INTEGER DEFAULT 0,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS pa_scout_asignaciones (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    reporte_id   INTEGER NOT NULL REFERENCES pa_scout_reportes(id),
    usuario_id   INTEGER NOT NULL REFERENCES usuarios(id),
    asignado_por INTEGER REFERENCES usuarios(id),
    frecuencia   TEXT DEFAULT 'semanal',
    activo       INTEGER DEFAULT 1,
    creado_en    TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS pa_scout_seguimientos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reporte_id  INTEGER NOT NULL REFERENCES pa_scout_reportes(id),
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
    nota        TEXT,
    foto_path   TEXT,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );
`);

function requireAuth(req, res, next) {
  const cookie = req.cookies?.lnb_user;
  if (!cookie) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try { req.user = JSON.parse(cookie); next(); }
  catch(e) { res.status(401).json({ ok: false, error: 'Sesión inválida' }); }
}

function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function parseCoordenadas(str) {
  if (!str || typeof str !== 'string') return null;
  str = str.trim();
  const atSign = str.match(/@([-\d.]+),([-\d.]+)/);
  if (atSign) return { lat: parseFloat(atSign[1]), lng: parseFloat(atSign[2]) };
  const qParam = str.match(/[?&]q=([-\d.]+),([-\d.]+)/);
  if (qParam) return { lat: parseFloat(qParam[1]), lng: parseFloat(qParam[2]) };
  const direct = str.match(/^([-\d.]+)\s*[,;\s]\s*([-\d.]+)$/);
  if (direct) { const lat=parseFloat(direct[1]),lng=parseFloat(direct[2]); if(!isNaN(lat)&&!isNaN(lng))return{lat,lng}; }
  const any = str.match(/([-\d.]+)[,\s]+([-\d.]+)/);
  if (any) { const lat=parseFloat(any[1]),lng=parseFloat(any[2]); if(!isNaN(lat)&&!isNaN(lng))return{lat,lng}; }
  return null;
}

function enriquecer(reportes) {
  return reportes.map(rep => {
    const asig = db.prepare(`SELECT a.*,u.nombre as usuario_nombre FROM pa_scout_asignaciones a JOIN usuarios u ON u.id=a.usuario_id WHERE a.reporte_id=? AND a.activo=1 ORDER BY a.creado_en DESC LIMIT 1`).get(rep.id);
    rep.asignado_nombre = asig?.usuario_nombre||null;
    rep.frecuencia = asig?.frecuencia||null;
    rep.seguimientos = db.prepare(`SELECT s.*,u.nombre as usr FROM pa_scout_seguimientos s JOIN usuarios u ON u.id=s.usuario_id WHERE s.reporte_id=? ORDER BY s.creado_en DESC`).all(rep.id);
    return rep;
  });
}

router.get('/detectar', requireAuth, (req, res) => {
  const { lat, lng } = req.query;
  if (!lat||!lng) return res.status(400).json({ ok:false, error:'lat y lng requeridos' });
  const latN=parseFloat(lat), lngN=parseFloat(lng);
  try {
    const lotes = db.prepare(`
      SELECT l.id,l.nombre,l.finca,l.hectareas,l.poligono_maps,
             cl.cultivo as cultivo_actual
      FROM pa_lotes l
      LEFT JOIN pa_cultivos_lote cl ON cl.lote_id=l.id
        AND cl.campaña=(SELECT nombre FROM pa_campañas WHERE activa=1 LIMIT 1)
      WHERE l.activo=1
    `).all();

    let mejorLote=null, mejorDist=Infinity;
    const UMBRAL=1500;
    for (const lote of lotes) {
      const coords=parseCoordenadas(lote.poligono_maps);
      if(!coords)continue;
      const dist=distanciaMetros(latN,lngN,coords.lat,coords.lng);
      if(dist<mejorDist){mejorDist=dist;mejorLote=lote;}
    }
    if(mejorLote&&mejorDist<=UMBRAL){
      res.json({ok:true,lote:mejorLote,distancia_metros:Math.round(mejorDist)});
    } else {
      res.json({ok:false,error:'Sin lote cercano',distancia_metros:mejorDist<Infinity?Math.round(mejorDist):null,lotes});
    }
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

router.get('/lotes', requireAuth, (req, res) => {
  try {
    const data = db.prepare(`
      SELECT l.id,l.nombre,l.finca,l.hectareas,cl.cultivo as cultivo_actual
      FROM pa_lotes l
      LEFT JOIN pa_cultivos_lote cl ON cl.lote_id=l.id
        AND cl.campaña=(SELECT nombre FROM pa_campañas WHERE activa=1 LIMIT 1)
      WHERE l.activo=1 ORDER BY l.finca,l.nombre
    `).all();
    res.json({ok:true,data});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

router.get('/resumen', requireAuth, (req, res) => {
  try {
    res.json({ ok:true, data: {
      pendientes:    db.prepare("SELECT COUNT(*) as n FROM pa_scout_reportes WHERE estado='pendiente'").get().n,
      en_proceso:    db.prepare("SELECT COUNT(*) as n FROM pa_scout_reportes WHERE estado='en_proceso'").get().n,
      alta_prioridad:db.prepare("SELECT COUNT(*) as n FROM pa_scout_reportes WHERE prioridad_alta=1 AND estado!='resuelto'").get().n,
      criticos:      db.prepare("SELECT COUNT(*) as n FROM pa_scout_reportes WHERE severidad=4 AND estado!='resuelto'").get().n,
      ultimos: db.prepare(`
        SELECT r.*,l.nombre as lote_nombre,l.finca as lote_finca,u.nombre as creado_por_nombre
        FROM pa_scout_reportes r
        JOIN pa_lotes l ON l.id=r.lote_id JOIN usuarios u ON u.id=r.usuario_id
        WHERE r.estado!='resuelto'
        ORDER BY r.prioridad_alta DESC,r.severidad DESC,r.creado_en DESC LIMIT 5
      `).all()
    }});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

router.get('/reportes', requireAuth, (req, res) => {
  const { estado } = req.query;
  let query=`SELECT r.*,l.nombre as lote_nombre,l.finca as lote_finca,u.nombre as creado_por_nombre,u.rol as creado_por_rol FROM pa_scout_reportes r JOIN pa_lotes l ON l.id=r.lote_id JOIN usuarios u ON u.id=r.usuario_id WHERE 1=1`;
  const params=[];
  if(estado){ const estados=estado.split(',').map(s=>s.trim()); query+=` AND r.estado IN (${estados.map(()=>'?').join(',')})`; params.push(...estados); }
  query+=" ORDER BY r.prioridad_alta DESC,r.severidad DESC,r.creado_en DESC";
  try{ res.json({ok:true,data:enriquecer(db.prepare(query).all(...params))}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

router.post('/reportes', requireAuth, (req, res) => {
  const {lote_id,tipo,severidad,descripcion,lat,lng,foto_b64}=req.body;
  if(!lote_id||!tipo||!severidad) return res.status(400).json({ok:false,error:'Faltan datos obligatorios'});
  try {
    const esAlta=req.user.rol==='admin'||severidad>=3?1:0;
    let fotoPath=null;
    if(foto_b64){
      const dir=path.join(__dirname,'../../data/scout');
      fs.mkdirSync(dir,{recursive:true});
      const fname=`scout_${Date.now()}_${req.user.id}.jpg`;
      fs.writeFileSync(path.join(dir,fname),Buffer.from(foto_b64,'base64'));
      fotoPath='/data/scout/'+fname;
    }
    const r=db.prepare(`INSERT INTO pa_scout_reportes (lote_id,usuario_id,tipo,severidad,descripcion,lat,lng,foto_path,prioridad_alta) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(lote_id,req.user.id,tipo,severidad,descripcion||null,lat||null,lng||null,fotoPath,esAlta);
    res.json({ok:true,id:r.lastInsertRowid});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

router.patch('/reportes/:id/estado', requireAuth, (req, res) => {
  const {estado}=req.body;
  if(!['pendiente','en_proceso','resuelto'].includes(estado)) return res.status(400).json({ok:false,error:'Estado inválido'});
  try{ db.prepare("UPDATE pa_scout_reportes SET estado=? WHERE id=?").run(estado,req.params.id); res.json({ok:true}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// ── MIS ÓRDENES (para tractoristas en Scout) ──────────────────────────────
router.get('/mis-ordenes', requireAuth, (req, res) => {
  try {
    const ordenes = db.prepare(`
      SELECT o.*,
             u.nombre as creada_por_nombre,
             ua.nombre as asignado_nombre
      FROM pa_ordenes o
      LEFT JOIN usuarios u ON u.id = o.creada_por
      LEFT JOIN usuarios ua ON ua.id = o.asignado_a
      WHERE o.asignado_a = ?
        AND o.estado IN ('emitida','en_ejecucion','parcial')
      ORDER BY o.fecha_propuesta ASC, o.creado_en DESC
    `).all(req.user.id);

    // Enriquecer con lotes e items
    const getLotes = db.prepare(`
      SELECT ol.lote_id, l.nombre as lote_nombre, l.finca, l.hectareas,
             cl.cultivo as cultivo_actual,
             (SELECT COUNT(*) FROM pa_aplicaciones a WHERE a.orden_id=ol.orden_id AND a.lote_id=ol.lote_id) as ejecutado,
             (SELECT a.fecha_real FROM pa_aplicaciones a WHERE a.orden_id=ol.orden_id AND a.lote_id=ol.lote_id ORDER BY a.creado_en DESC LIMIT 1) as fecha_real
      FROM pa_ordenes_lotes ol
      JOIN pa_lotes l ON l.id = ol.lote_id
      LEFT JOIN pa_cultivos_lote cl ON cl.lote_id = l.id
        AND cl.campaña = (SELECT nombre FROM pa_campañas WHERE activa=1 LIMIT 1)
      WHERE ol.orden_id = ?
    `);
    const getItems = db.prepare(`
      SELECT oi.*, i.nombre as insumo_nombre, i.unidad, i.stock_actual
      FROM pa_ordenes_items oi
      JOIN pa_insumos i ON i.id = oi.insumo_id
      WHERE oi.orden_id = ?
    `);

    const data = ordenes.map(o => ({
      ...o,
      lotes: getLotes.all(o.id),
      items: getItems.all(o.id)
    }));

    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── EJECUTAR ORDEN DESDE SCOUT ─────────────────────────────────────────────
router.post('/ejecutar-orden', requireAuth, (req, res) => {
  const { orden_id, lote_id, aplicaciones, foto_b64, notas, fecha_real } = req.body;
  if (!orden_id || !lote_id || !aplicaciones?.length)
    return res.status(400).json({ ok: false, error: 'Faltan datos obligatorios' });

  // Usar la fecha enviada o la de hoy
  const fechaEjecucion = fecha_real || new Date().toISOString().slice(0,10);
  try {
    if (foto_b64) {
      const dir = path.join(__dirname, '../../data/scout');
      fs.mkdirSync(dir, { recursive: true });
      const fname = `aplic_${Date.now()}_${req.user.id}.jpg`;
      fs.writeFileSync(path.join(dir, fname), Buffer.from(foto_b64, 'base64'));
      fotoPath = '/data/scout/' + fname;
    }

    const ejecutar = db.transaction(() => {
      for (const ap of aplicaciones) {
        const ultimaCompra = db.prepare(`
          SELECT ci.precio_unit FROM pa_compras_items ci
          JOIN pa_compras c ON c.id = ci.compra_id
          WHERE ci.insumo_id = ? ORDER BY c.fecha DESC LIMIT 1
        `).get(ap.insumo_id);
        const costoUnit = ultimaCompra?.precio_unit || 0;
        const costoTotal = costoUnit * ap.cantidad_real;

        db.prepare(`
          INSERT INTO pa_aplicaciones
            (orden_id, lote_id, insumo_id, fecha_real, cantidad_real,
             ejecutado_por, costo_unitario, costo_total, notas)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).run(orden_id, lote_id, ap.insumo_id, fechaEjecucion, ap.cantidad_real,
               req.user.id, costoUnit, costoTotal, notas || null);

        // Descontar stock
        db.prepare("UPDATE pa_insumos SET stock_actual = stock_actual - ? WHERE id = ?")
          .run(ap.cantidad_real, ap.insumo_id);

        // Movimiento stock con fecha real
        db.prepare(`INSERT INTO pa_movimientos_stock (fecha,insumo_id,tipo,cantidad,motivo,referencia_id) VALUES (?,?,?,?,'aplicacion',?)`)
          .run(fechaEjecucion, ap.insumo_id, 'salida', ap.cantidad_real, orden_id);

        // Costo por lote con fecha real
        const orden = db.prepare("SELECT campaña_id FROM pa_ordenes WHERE id=?").get(orden_id);
        if (orden?.campaña_id && costoTotal > 0) {
          const ins = db.prepare("SELECT tipo, nombre FROM pa_insumos WHERE id=?").get(ap.insumo_id);
          const cat = ins?.tipo === 'fertilizante' ? 'fertilizante' : 'agroquimico';
          db.prepare(`INSERT INTO pa_costos_lote (lote_id,campaña_id,categoria,referencia_id,fecha,monto,descripcion) VALUES (?,?,?,?,?,?,?)`)
            .run(lote_id, orden.campaña_id, cat, orden_id, fechaEjecucion, costoTotal, `Aplicación ${ins?.nombre}`);
        }
      }

      // Actualizar estado de la orden
      const totalLotes = db.prepare("SELECT COUNT(*) as n FROM pa_ordenes_lotes WHERE orden_id=?").get(orden_id).n;
      const lotesEjec  = db.prepare("SELECT COUNT(DISTINCT lote_id) as n FROM pa_aplicaciones WHERE orden_id=?").get(orden_id).n;
      const nuevoEstado = lotesEjec >= totalLotes ? 'ejecutada' : 'en_ejecucion';
      db.prepare("UPDATE pa_ordenes SET estado=? WHERE id=?").run(nuevoEstado, orden_id);
    });

    ejecutar();

    // Guardar foto como seguimiento del reporte scout si existe
    res.json({ ok: true, foto_path: fotoPath });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/mis-tareas', requireAuth, (req, res) => {
  try {
    const data=enriquecer(db.prepare(`
      SELECT r.*,l.nombre as lote_nombre,l.finca as lote_finca,u.nombre as creado_por_nombre,u.rol as creado_por_rol
      FROM pa_scout_reportes r JOIN pa_lotes l ON l.id=r.lote_id JOIN usuarios u ON u.id=r.usuario_id
      JOIN pa_scout_asignaciones a ON a.reporte_id=r.id
      WHERE a.usuario_id=? AND a.activo=1 AND r.estado!='resuelto'
      ORDER BY r.prioridad_alta DESC,r.severidad DESC,r.creado_en DESC
    `).all(req.user.id));
    res.json({ok:true,data});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

router.post('/asignar', requireAuth, (req, res) => {
  const {reporte_id,usuario_id,frecuencia}=req.body;
  if(!reporte_id||!usuario_id) return res.status(400).json({ok:false,error:'Faltan datos'});
  try{
    db.prepare("UPDATE pa_scout_asignaciones SET activo=0 WHERE reporte_id=?").run(reporte_id);
    db.prepare("INSERT INTO pa_scout_asignaciones (reporte_id,usuario_id,asignado_por,frecuencia) VALUES (?,?,?,?)").run(reporte_id,usuario_id,req.user.id,frecuencia||'semanal');
    db.prepare("UPDATE pa_scout_reportes SET estado='en_proceso' WHERE id=?").run(reporte_id);
    res.json({ok:true});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

router.post('/seguimiento', requireAuth, (req, res) => {
  const {reporte_id,nota,foto_b64}=req.body;
  if(!reporte_id||!nota) return res.status(400).json({ok:false,error:'Faltan datos'});
  try{
    let fotoPath=null;
    if(foto_b64){
      const dir=path.join(__dirname,'../../data/scout');
      fs.mkdirSync(dir,{recursive:true});
      const fname=`seg_${Date.now()}.jpg`;
      fs.writeFileSync(path.join(dir,fname),Buffer.from(foto_b64,'base64'));
      fotoPath='/data/scout/'+fname;
    }
    db.prepare("INSERT INTO pa_scout_seguimientos (reporte_id,usuario_id,nota,foto_path) VALUES (?,?,?,?)").run(reporte_id,req.user.id,nota,fotoPath);
    res.json({ok:true});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

export default router;
