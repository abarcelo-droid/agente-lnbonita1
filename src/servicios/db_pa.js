// src/servicios/db_pa.js
// ── MÓDULO PRODUCCIÓN AGRÍCOLA — PUENTE CORDON SA ─────────────────────────
// Todas las tablas usan prefijo pa_ para no colisionar con La Niña Bonita

import db, { dbPath } from './db.js';
import fs from 'fs';
import path from 'path';
// Multisociedad Fase 1: el cimiento contable necesita que la tabla `sociedades`
// ya esté creada y sembrada (Puente Cordón / San Gerónimo) ANTES de correr la
// migración del final de este archivo. En index.js produccion.js (que importa
// este módulo) se carga antes que org.js, así que forzamos el orden acá.
// db_org.js NO importa db_pa.js → no hay ciclo.
import './db_org.js';

// ── TABLAS MAESTRAS ────────────────────────────────────────────────────────

db.exec(`
  -- Sectores productivos
  CREATE TABLE IF NOT EXISTS pa_sectores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre      TEXT NOT NULL UNIQUE,
    tipo        TEXT NOT NULL CHECK(tipo IN ('frutales','chacra_mercado','chacra_industria')),
    activo      INTEGER DEFAULT 1
  );

  -- Lotes / Cuadros
  CREATE TABLE IF NOT EXISTS pa_lotes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre      TEXT NOT NULL,
    sector_id   INTEGER NOT NULL REFERENCES pa_sectores(id),
    hectareas   REAL NOT NULL DEFAULT 0.5,
    activo      INTEGER DEFAULT 1,
    notas       TEXT,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Cultivos por lote (frutales = fijo, chacras = rotan por campaña)
  CREATE TABLE IF NOT EXISTS pa_cultivos_lote (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id     INTEGER NOT NULL REFERENCES pa_lotes(id),
    cultivo     TEXT NOT NULL,
    campaña     TEXT NOT NULL,
    es_perenne  INTEGER DEFAULT 0,
    UNIQUE(lote_id, campaña)
  );

  -- Campañas (01/Jul → 30/Jun)
  CREATE TABLE IF NOT EXISTS pa_campañas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre      TEXT NOT NULL UNIQUE,
    fecha_inicio TEXT NOT NULL,
    fecha_fin    TEXT NOT NULL,
    activa       INTEGER DEFAULT 0
  );
`);

// ── INSUMOS Y STOCK ────────────────────────────────────────────────────────

db.exec(`
  -- Productos insumos (fertilizantes, agroquímicos, semillas, etc.)
  CREATE TABLE IF NOT EXISTS pa_insumos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre        TEXT NOT NULL,
    tipo          TEXT NOT NULL CHECK(tipo IN ('fertilizante','agroquimico','semilla','otro')),
    unidad        TEXT NOT NULL CHECK(unidad IN ('kg','lt','unidad')),
    stock_actual  REAL DEFAULT 0,
    stock_minimo  REAL DEFAULT 0,
    activo        INTEGER DEFAULT 1,
    notas         TEXT,
    creado_en     TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Proveedores de insumos
  CREATE TABLE IF NOT EXISTS pa_proveedores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    razon_social TEXT NOT NULL,
    cuit        TEXT,
    telefono    TEXT,
    email       TEXT,
    activo      INTEGER DEFAULT 1,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Compras de insumos
  CREATE TABLE IF NOT EXISTS pa_compras (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha         TEXT NOT NULL DEFAULT (date('now','localtime')),
    proveedor_id  INTEGER REFERENCES pa_proveedores(id),
    proveedor_txt TEXT,
    nro_factura   TEXT,
    campaña_id    INTEGER REFERENCES pa_campañas(id),
    subtotal      REAL DEFAULT 0,
    iva_monto     REAL DEFAULT 0,
    total         REAL DEFAULT 0,
    notas         TEXT,
    creado_en     TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Items de cada compra
  CREATE TABLE IF NOT EXISTS pa_compras_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    compra_id   INTEGER NOT NULL REFERENCES pa_compras(id),
    insumo_id   INTEGER NOT NULL REFERENCES pa_insumos(id),
    cantidad    REAL NOT NULL,
    precio_unit REAL NOT NULL,
    subtotal    REAL NOT NULL
  );

  -- Movimientos de stock (entradas y salidas)
  CREATE TABLE IF NOT EXISTS pa_movimientos_stock (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha       TEXT NOT NULL DEFAULT (date('now','localtime')),
    insumo_id   INTEGER NOT NULL REFERENCES pa_insumos(id),
    tipo        TEXT NOT NULL CHECK(tipo IN ('entrada','salida')),
    cantidad    REAL NOT NULL,
    motivo      TEXT CHECK(motivo IN ('compra','aplicacion','ajuste','devolucion')),
    referencia_id INTEGER,
    notas       TEXT,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── ÓRDENES DE APLICACIÓN ─────────────────────────────────────────────────

db.exec(`
  -- Orden de aplicación (creada por la ingeniera)
  CREATE TABLE IF NOT EXISTS pa_ordenes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nro_orden     TEXT UNIQUE,
    campaña_id    INTEGER REFERENCES pa_campañas(id),
    fecha_orden   TEXT NOT NULL DEFAULT (date('now','localtime')),
    fecha_propuesta TEXT,
    creada_por    INTEGER REFERENCES usuarios(id),
    estado        TEXT DEFAULT 'borrador' CHECK(estado IN ('borrador','emitida','en_ejecucion','ejecutada','parcial','anulada')),
    tipo_aplicacion TEXT,
    objetivo      TEXT,
    notas         TEXT,
    eliminada_en      TEXT,
    eliminada_por_id  INTEGER REFERENCES usuarios(id),
    creado_en     TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Lotes incluidos en la orden
  -- hectareas_aplicadas: NULL = lote completo, número = aplicación parcial
  CREATE TABLE IF NOT EXISTS pa_ordenes_lotes (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    orden_id            INTEGER NOT NULL REFERENCES pa_ordenes(id),
    lote_id             INTEGER NOT NULL REFERENCES pa_lotes(id),
    hectareas_aplicadas REAL
  );

  -- Productos/dosis definidos en la orden
  CREATE TABLE IF NOT EXISTS pa_ordenes_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    orden_id    INTEGER NOT NULL REFERENCES pa_ordenes(id),
    insumo_id   INTEGER NOT NULL REFERENCES pa_insumos(id),
    dosis       REAL NOT NULL,
    unidad_dosis TEXT NOT NULL CHECK(unidad_dosis IN ('kg/ha','lt/ha','kg/lote','lt/lote','kg_total','lt_total')),
    notas       TEXT
  );

  -- Ejecuciones reales de la orden
  CREATE TABLE IF NOT EXISTS pa_aplicaciones (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    orden_id        INTEGER NOT NULL REFERENCES pa_ordenes(id),
    lote_id         INTEGER NOT NULL REFERENCES pa_lotes(id),
    insumo_id       INTEGER NOT NULL REFERENCES pa_insumos(id),
    fecha_real      TEXT NOT NULL DEFAULT (date('now','localtime')),
    cantidad_real   REAL NOT NULL,
    ejecutado_por   INTEGER REFERENCES usuarios(id),
    ejecutado_txt   TEXT,
    costo_unitario  REAL DEFAULT 0,
    costo_total     REAL DEFAULT 0,
    notas           TEXT,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── COSTOS POR LOTE ────────────────────────────────────────────────────────

db.exec(`
  -- Resumen de costos acumulados por lote y campaña
  CREATE TABLE IF NOT EXISTS pa_costos_lote (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id     INTEGER NOT NULL REFERENCES pa_lotes(id),
    campaña_id  INTEGER NOT NULL REFERENCES pa_campañas(id),
    categoria   TEXT NOT NULL CHECK(categoria IN ('fertilizante','agroquimico','semilla','labor_propia','labor_contratada','cosecha','otros')),
    referencia_id INTEGER,
    fecha       TEXT NOT NULL DEFAULT (date('now','localtime')),
    monto       REAL NOT NULL DEFAULT 0,
    descripcion TEXT,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Costos de MO imputados a la CAMPAÑA (no a un lote). Tareas de galpón
  -- (pa_tareas_tipos.requiere_lote=0: empaque, selección, repaso): la MO no es de un
  -- lote/cultivo puntual → se imputa a la campaña. Espeja pa_costos_lote SIN lote_id.
  -- Tabla aditiva (no toca pa_costos_lote). Los totales por campaña suman ambas.
  CREATE TABLE IF NOT EXISTS pa_costos_campaña (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    campaña_id            INTEGER NOT NULL REFERENCES pa_campañas(id),
    campaña_anual_id      INTEGER REFERENCES pa_campañas(id),
    campaña_estacional_id INTEGER REFERENCES pa_campañas(id),
    categoria             TEXT NOT NULL,
    referencia_id         INTEGER,
    origen                TEXT,
    fecha                 TEXT NOT NULL DEFAULT (date('now','localtime')),
    monto                 REAL NOT NULL DEFAULT 0,
    descripcion           TEXT,
    creado_en             TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_costos_camp_anual  ON pa_costos_campaña(campaña_anual_id);
  CREATE INDEX IF NOT EXISTS idx_costos_camp_estac  ON pa_costos_campaña(campaña_estacional_id);
  CREATE INDEX IF NOT EXISTS idx_costos_camp_origen ON pa_costos_campaña(origen, referencia_id);
`);

// ── MIGRACIÓN: Campaña inicial ─────────────────────────────────────────────
(function() {
  try {
    const n = db.prepare("SELECT COUNT(*) as n FROM pa_campañas").get();
    if (n.n === 0) {
      // Calcular campaña activa según fecha actual
      const hoy = new Date();
      const año = hoy.getMonth() >= 6 ? hoy.getFullYear() : hoy.getFullYear() - 1;
      const nombre = `${año}/${String(año + 1).slice(2)}`;
      db.prepare(`
        INSERT INTO pa_campañas (nombre, fecha_inicio, fecha_fin, activa)
        VALUES (?, ?, ?, 1)
      `).run(nombre, `${año}-07-01`, `${año + 1}-06-30`);
      console.log(`[PA] Campaña ${nombre} creada`);
    }
  } catch(e) { console.error('[PA] Error creando campaña inicial:', e.message); }
})();

// ── MIGRACIÓN: Sectores iniciales ─────────────────────────────────────────
(function() {
  try {
    const n = db.prepare("SELECT COUNT(*) as n FROM pa_sectores").get();
    if (n.n === 0) {
      const sectores = [
        ['Frutales', 'frutales'],
        ['Chacra de Mercado', 'chacra_mercado'],
        ['Chacra de Industria', 'chacra_industria'],
      ];
      for (const [nombre, tipo] of sectores) {
        db.prepare("INSERT INTO pa_sectores (nombre, tipo) VALUES (?, ?)").run(nombre, tipo);
      }
      console.log('[PA] Sectores iniciales creados');
    }
  } catch(e) { console.error('[PA] Error creando sectores:', e.message); }
})();

// ── Función helper: obtener campaña activa ─────────────────────────────────
export function getCampañaActiva() {
  return db.prepare("SELECT * FROM pa_campañas WHERE activa = 1").get();
}

// ── MIGRACIÓN: columnas nuevas en pa_lotes ────────────────────────────────
(function migrarLotes() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_lotes)").all().map(c => c.name);
    if (!cols.includes('finca')) {
      db.exec("ALTER TABLE pa_lotes ADD COLUMN finca TEXT");
      console.log("[PA] Columna finca agregada en pa_lotes");
    }
    if (!cols.includes('poligono_maps')) {
      db.exec("ALTER TABLE pa_lotes ADD COLUMN poligono_maps TEXT");
      console.log("[PA] Columna poligono_maps agregada en pa_lotes");
    }
    // Campos nuevos para el editor de polígonos integrado (Leaflet + Esri)
    if (!cols.includes('poligono_geojson')) {
      db.exec("ALTER TABLE pa_lotes ADD COLUMN poligono_geojson TEXT");
      console.log("[PA] Columna poligono_geojson agregada en pa_lotes");
    }
    if (!cols.includes('centroide_lat')) {
      db.exec("ALTER TABLE pa_lotes ADD COLUMN centroide_lat REAL");
      console.log("[PA] Columna centroide_lat agregada en pa_lotes");
    }
    if (!cols.includes('centroide_lng')) {
      db.exec("ALTER TABLE pa_lotes ADD COLUMN centroide_lng REAL");
      console.log("[PA] Columna centroide_lng agregada en pa_lotes");
    }
    if (!cols.includes('red_agua')) {
      db.exec("ALTER TABLE pa_lotes ADD COLUMN red_agua TEXT CHECK(red_agua IN ('Norte','Sur','Ambas') OR red_agua IS NULL)");
      console.log("[PA] Columna red_agua agregada en pa_lotes");
    }
  } catch(e) { console.error('[PA] Error migrando pa_lotes:', e.message); }
})();

// ── MIGRACIÓN: red_agua sin CHECK constraint restrictivo ─────────────────
(function() {
  try {
    // Verificar si el CHECK viejo existe intentando insertar un valor nuevo
    const db2 = getDb();
    const test = db2.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pa_lotes'").get();
    if (test && test.sql && test.sql.includes("Norte")) {
      // Recrear tabla sin el CHECK
      db2.exec(`
        BEGIN;
        CREATE TABLE pa_lotes_v2 (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          nombre      TEXT NOT NULL,
          sector_id   INTEGER NOT NULL REFERENCES pa_sectores(id),
          finca       TEXT,
          hectareas   REAL NOT NULL DEFAULT 0.5,
          poligono_maps TEXT,
          red_agua    TEXT,
          activo      INTEGER DEFAULT 1,
          notas       TEXT,
          creado_en   TEXT DEFAULT (datetime('now','localtime'))
        );
        INSERT INTO pa_lotes_v2 SELECT id,nombre,sector_id,finca,hectareas,poligono_maps,red_agua,activo,notas,creado_en FROM pa_lotes;
        DROP TABLE pa_lotes;
        ALTER TABLE pa_lotes_v2 RENAME TO pa_lotes;
        COMMIT;
      `);
      console.log("[PA] pa_lotes recreada — red_agua sin CHECK restrictivo");
    }
  } catch(e) { console.error('[PA] Error migrando red_agua:', e.message); }
})();

// ── MIGRACIÓN: activo en pa_compras (soft delete) ──────────────────────────
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_compras)").all().map(c => c.name);
    if (!cols.includes('activo')) {
      db.exec("ALTER TABLE pa_compras ADD COLUMN activo INTEGER DEFAULT 1");
      console.log("[PA] activo agregado en pa_compras (default 1)");
    }
  } catch(e) { console.error('[PA] Error migrando pa_compras activo:', e.message); }
})();

// ── MIGRACIÓN: activo en pa_lotes (soft delete) ────────────────────────────
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_lotes)").all().map(c => c.name);
    if (!cols.includes('activo')) {
      db.exec("ALTER TABLE pa_lotes ADD COLUMN activo INTEGER DEFAULT 1");
      console.log("[PA] activo agregado en pa_lotes (default 1)");
    }
  } catch(e) { console.error('[PA] Error migrando pa_lotes activo:', e.message); }
})();

// ── MIGRACIÓN: año_plantacion en pa_lotes ──────────────────────────────────
// Solo aplica a lotes con cultivo frutal. NULL = sin info.
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_lotes)").all().map(c => c.name);
    if (!cols.includes('año_plantacion')) {
      db.exec("ALTER TABLE pa_lotes ADD COLUMN año_plantacion INTEGER");
      console.log("[PA] año_plantacion agregado en pa_lotes");
    }
  } catch(e) { console.error('[PA] Error migrando año_plantacion:', e.message); }
})();

// ── MIGRACIÓN: remito_foto_path en pa_compras ─────────────────────────────
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_compras)").all().map(c => c.name);
    if (!cols.includes('remito_foto_path')) {
      db.exec("ALTER TABLE pa_compras ADD COLUMN remito_foto_path TEXT");
      console.log("[PA] remito_foto_path agregado en pa_compras");
    }
    if (!cols.includes('tipo_comprobante')) {
      db.exec("ALTER TABLE pa_compras ADD COLUMN tipo_comprobante TEXT DEFAULT 'factura'");
      console.log("[PA] tipo_comprobante agregado en pa_compras");
    }
    if (!cols.includes('iva_total')) {
      db.exec("ALTER TABLE pa_compras ADD COLUMN iva_total REAL");
      console.log("[PA] iva_total agregado en pa_compras");
    }
    if (!cols.includes('neto_total')) {
      db.exec("ALTER TABLE pa_compras ADD COLUMN neto_total REAL");
      console.log("[PA] neto_total agregado en pa_compras");
    }
  } catch(e) { console.error('[PA] Error migrando pa_compras:', e.message); }
})();

// ── MIGRACIÓN: iva_porcentaje / iva_monto en pa_compras_items ─────────────
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_compras_items)").all().map(c => c.name);
    if (!cols.includes('iva_porcentaje')) {
      db.exec("ALTER TABLE pa_compras_items ADD COLUMN iva_porcentaje REAL");
      console.log("[PA] iva_porcentaje agregado en pa_compras_items");
    }
    if (!cols.includes('iva_monto')) {
      db.exec("ALTER TABLE pa_compras_items ADD COLUMN iva_monto REAL");
      console.log("[PA] iva_monto agregado en pa_compras_items");
    }
    if (!cols.includes('subtotal_neto')) {
      db.exec("ALTER TABLE pa_compras_items ADD COLUMN subtotal_neto REAL");
      console.log("[PA] subtotal_neto agregado en pa_compras_items");
    }
    // Presentación por compra (sobrescribe el default del producto si hace falta)
    if (!cols.includes('presentacion_tipo')) {
      db.exec("ALTER TABLE pa_compras_items ADD COLUMN presentacion_tipo TEXT");
      console.log("[PA] presentacion_tipo agregado en pa_compras_items");
    }
    if (!cols.includes('presentacion_base')) {
      db.exec("ALTER TABLE pa_compras_items ADD COLUMN presentacion_base REAL");
      console.log("[PA] presentacion_base agregado en pa_compras_items");
    }
    if (!cols.includes('cant_bultos')) {
      db.exec("ALTER TABLE pa_compras_items ADD COLUMN cant_bultos REAL");
      console.log("[PA] cant_bultos agregado en pa_compras_items");
    }
    if (!cols.includes('precio_modo')) {
      db.exec("ALTER TABLE pa_compras_items ADD COLUMN precio_modo TEXT DEFAULT 'base'");
      console.log("[PA] precio_modo agregado en pa_compras_items");
    }
  } catch(e) { console.error('[PA] Error migrando pa_compras_items:', e.message); }
})();

// ── MIGRACIÓN: presentación default en pa_insumos ─────────────────────────
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_insumos)").all().map(c => c.name);
    if (!cols.includes('presentacion_tipo')) {
      db.exec("ALTER TABLE pa_insumos ADD COLUMN presentacion_tipo TEXT");
      console.log("[PA] presentacion_tipo agregado en pa_insumos (default presentación)");
    }
    if (!cols.includes('presentacion_base')) {
      db.exec("ALTER TABLE pa_insumos ADD COLUMN presentacion_base REAL");
      console.log("[PA] presentacion_base agregado en pa_insumos (lt/kg por bulto)");
    }
  } catch(e) { console.error('[PA] Error migrando pa_insumos presentacion:', e.message); }
})();

// ── MIGRACIÓN: asignado_a en pa_ordenes ──────────────────────────────────
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_ordenes)").all().map(c => c.name);
    if (!cols.includes('asignado_a')) {
      db.exec("ALTER TABLE pa_ordenes ADD COLUMN asignado_a INTEGER REFERENCES usuarios(id)");
      console.log("[PA] Columna asignado_a agregada en pa_ordenes");
    }
  } catch(e) { console.error('[PA] Error migrando pa_ordenes:', e.message); }
})();

// ── MIGRACIÓN: hectareas_aplicadas en pa_ordenes_lotes (aplicación parcial) ─
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_ordenes_lotes)").all().map(c => c.name);
    if (!cols.includes('hectareas_aplicadas')) {
      db.exec("ALTER TABLE pa_ordenes_lotes ADD COLUMN hectareas_aplicadas REAL");
      console.log("[PA] Columna hectareas_aplicadas agregada en pa_ordenes_lotes");
    }
  } catch(e) { console.error('[PA] Error migrando pa_ordenes_lotes:', e.message); }
})();

// ── MIGRACIÓN: soft delete en pa_ordenes (eliminada_en, eliminada_por_id) ──
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_ordenes)").all().map(c => c.name);
    if (!cols.includes('eliminada_en')) {
      db.exec("ALTER TABLE pa_ordenes ADD COLUMN eliminada_en TEXT");
      console.log("[PA] Columna eliminada_en agregada en pa_ordenes");
    }
    if (!cols.includes('eliminada_por_id')) {
      db.exec("ALTER TABLE pa_ordenes ADD COLUMN eliminada_por_id INTEGER REFERENCES usuarios(id)");
      console.log("[PA] Columna eliminada_por_id agregada en pa_ordenes");
    }
  } catch(e) { console.error('[PA] Error migrando soft delete pa_ordenes:', e.message); }
})();

// ── MIGRACIÓN: re-asociar órdenes huérfanas a la campaña activa
//    + crear costos por lote para las aplicaciones existentes que se hayan
//    saltado el insert (porque la orden no tenía campaña_id).
//    Idempotente: la próxima vez no encuentra nada para hacer.
(function() {
  try {
    const campAct = db.prepare("SELECT id FROM pa_campañas WHERE activa=1 LIMIT 1").get();
    if (!campAct) {
      console.log("[PA] No hay campaña activa, no se puede re-asociar costos huérfanos");
      return;
    }

    // 1) Asociar órdenes sin campaña a la activa actual
    const huerfanas = db.prepare("SELECT id FROM pa_ordenes WHERE campaña_id IS NULL").all();
    if (huerfanas.length > 0) {
      const upd = db.prepare("UPDATE pa_ordenes SET campaña_id = ? WHERE id = ?");
      const tx = db.transaction(() => {
        for (const o of huerfanas) upd.run(campAct.id, o.id);
      });
      tx();
      console.log(`[PA] ${huerfanas.length} órdenes huérfanas asociadas a la campaña activa.`);
    }

    // 2) Detectar aplicaciones con costo > 0 que NO tienen registro en pa_costos_lote
    //    y crearlos. El cruce es por referencia_id (id de la aplicación) y categorías
    //    'fertilizante' o 'agroquimico' (las únicas que se crean al ejecutar).
    const aplicsHuerfanas = db.prepare(`
      SELECT a.id, a.orden_id, a.lote_id, a.insumo_id, a.fecha_real,
             a.cantidad_real, a.costo_total,
             i.nombre AS insumo_nombre, i.tipo AS insumo_tipo,
             o.campaña_id AS orden_campaña_id
      FROM pa_aplicaciones a
      JOIN pa_insumos i ON i.id = a.insumo_id
      JOIN pa_ordenes o ON o.id = a.orden_id
      WHERE a.costo_total > 0
        AND NOT EXISTS (
          SELECT 1 FROM pa_costos_lote cl
          WHERE cl.referencia_id = a.id
            AND cl.categoria IN ('fertilizante','agroquimico')
        )
    `).all();

    if (aplicsHuerfanas.length > 0) {
      const insCosto = db.prepare(`
        INSERT INTO pa_costos_lote (lote_id, campaña_id, categoria, referencia_id, fecha, monto, descripcion)
        VALUES (?,?,?,?,?,?,?)
      `);
      const tx = db.transaction(() => {
        for (const a of aplicsHuerfanas) {
          const cat = a.insumo_tipo === 'fertilizante' ? 'fertilizante' : 'agroquimico';
          // Si la orden ahora tiene campaña (después del paso 1), usá esa; sino la activa.
          const camp = a.orden_campaña_id || campAct.id;
          insCosto.run(a.lote_id, camp, cat, a.id, a.fecha_real,
                       a.costo_total, `Aplicación OA: ${a.insumo_nombre} (recuperado)`);
        }
      });
      tx();
      console.log(`[PA] ${aplicsHuerfanas.length} costos por lote recuperados retroactivamente.`);
    }
  } catch(e) { console.error('[PA] Error en migración de costos huérfanos:', e.message); }
})();

// ── MIGRACIÓN: columnas nuevas en pa_insumos ──────────────────────────────
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_insumos)").all().map(c => c.name);
    if (!cols.includes('componente_madre')) {
      db.exec("ALTER TABLE pa_insumos ADD COLUMN componente_madre TEXT");
      console.log("[PA] componente_madre agregado en pa_insumos");
    }
    if (!cols.includes('precio_ref_usd')) {
      db.exec("ALTER TABLE pa_insumos ADD COLUMN precio_ref_usd REAL DEFAULT 0");
      console.log("[PA] precio_ref_usd agregado en pa_insumos");
    }
    if (!cols.includes('ficha_tecnica_path')) {
      db.exec("ALTER TABLE pa_insumos ADD COLUMN ficha_tecnica_path TEXT");
      console.log("[PA] ficha_tecnica_path agregado en pa_insumos");
    }
    // Ampliar CHECK de tipo para incluir fungicida e insecticida
    // SQLite no permite ALTER CHECK, se maneja a nivel aplicación
  } catch(e) { console.error('[PA] Error migrando pa_insumos:', e.message); }
})();

// ── MIGRACIÓN: mes siembra/cosecha en pa_cultivos_lote ────────────────────
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_cultivos_lote)").all().map(c => c.name);
    if (!cols.includes('mes_siembra')) {
      db.exec("ALTER TABLE pa_cultivos_lote ADD COLUMN mes_siembra INTEGER"); // 1-12
      console.log("[PA] Columna mes_siembra agregada en pa_cultivos_lote");
    }
    if (!cols.includes('mes_cosecha')) {
      db.exec("ALTER TABLE pa_cultivos_lote ADD COLUMN mes_cosecha INTEGER"); // 1-12
      console.log("[PA] Columna mes_cosecha agregada en pa_cultivos_lote");
    }
  } catch(e) { console.error('[PA] Error migrando cultivos_lote:', e.message); }
})();

// ── MIGRACIÓN: columna tipo en pa_campañas (anual / estacional) ───────────
// Modelo de dos niveles temporales superpuestos:
//   - 'anual'      → campaña anual Jul→Jun (ej: 2026/27). Antes 'verano'.
//   - 'estacional' → ciclos cortos dentro de la anual (ej: Inv 2026). Antes 'invierno'.
// El histórico usaba CHECK(tipo IN ('verano','invierno')). Como el CHECK impide
// hacer UPDATE a los valores nuevos, recreamos la tabla (mismo patrón que el
// resto del módulo) preservando los id (las FK por campaña_id se mantienen).
(function migrarTipoCampañaAnualEstacional() {
  try {
    const t = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pa_campañas'").get();
    const cols = db.prepare("PRAGMA table_info(pa_campañas)").all().map(c => c.name);
    if (!cols.includes('tipo')) {
      db.exec("ALTER TABLE pa_campañas ADD COLUMN tipo TEXT DEFAULT 'anual'");
      console.log("[PA] Columna tipo (anual/estacional) agregada en pa_campañas");
    } else if (t && t.sql && /CHECK\(tipo IN \('verano','invierno'\)\)/.test(t.sql)) {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        BEGIN;
        CREATE TABLE pa_campañas_v2 (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          nombre       TEXT NOT NULL UNIQUE,
          fecha_inicio TEXT NOT NULL,
          fecha_fin    TEXT NOT NULL,
          activa       INTEGER DEFAULT 0,
          tipo         TEXT DEFAULT 'anual'
        );
        INSERT INTO pa_campañas_v2 (id, nombre, fecha_inicio, fecha_fin, activa, tipo)
          SELECT id, nombre, fecha_inicio, fecha_fin, activa,
                 CASE WHEN tipo = 'invierno' THEN 'estacional' ELSE 'anual' END
          FROM pa_campañas;
        DROP TABLE pa_campañas;
        ALTER TABLE pa_campañas_v2 RENAME TO pa_campañas;
        COMMIT;
      `);
      const fk = db.prepare("PRAGMA foreign_key_check").all();
      if (fk.length > 0) console.error('[PA] ⚠️  FK check tras migrar pa_campañas:', fk);
      db.pragma('foreign_keys = ON');
      console.log('[PA] pa_campañas: tipo migrado verano→anual / invierno→estacional');
    }
    // Normalizar residuales y aplicar heurística por nombre para estacionales.
    db.exec("UPDATE pa_campañas SET tipo='anual' WHERE tipo IS NULL OR tipo NOT IN ('anual','estacional')");
    db.exec(`UPDATE pa_campañas SET tipo='estacional'
             WHERE tipo='anual' AND (
               nombre LIKE '%Invierno%' OR nombre LIKE '%invierno%' OR
               nombre LIKE 'Inv %'      OR nombre LIKE '%Verano%'   OR
               nombre LIKE '%Otoño%'    OR nombre LIKE '%Primavera%')`);
  } catch(e) { console.error('[PA] Error migrando tipo campaña:', e.message); }
})();

// ── MIGRACIÓN: doble campaña (anual + estacional) en órdenes/compras/costos ─
// Cada movimiento ahora se imputa a DOS campañas activas simultáneas (una de
// cada tipo). Se conserva la columna vieja campaña_id (= anual) por retrocompat.
(function migrarDobleCampaña() {
  const addCol = (tabla, col, def) => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name);
      if (!cols.includes(col)) {
        db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${def}`);
        console.log(`[PA] Columna ${col} agregada en ${tabla}`);
        return true;
      }
    } catch(e) { console.error(`[PA] Error agregando ${col} en ${tabla}:`, e.message); }
    return false;
  };
  // pa_ordenes (el brief la llama ordenes_aplicacion; en este repo es pa_ordenes)
  const oa = addCol('pa_ordenes',     'campaña_anual_id',      'INTEGER REFERENCES pa_campañas(id)');
                    addCol('pa_ordenes',     'campaña_estacional_id', 'INTEGER REFERENCES pa_campañas(id)');
  // pa_compras
  const ca = addCol('pa_compras',     'campaña_anual_id',      'INTEGER REFERENCES pa_campañas(id)');
                    addCol('pa_compras',     'campaña_estacional_id', 'INTEGER REFERENCES pa_campañas(id)');
  // pa_costos_lote (necesario para filtrar costos por campaña estacional)
  const cl = addCol('pa_costos_lote', 'campaña_anual_id',      'INTEGER REFERENCES pa_campañas(id)');
                    addCol('pa_costos_lote', 'campaña_estacional_id', 'INTEGER REFERENCES pa_campañas(id)');
  // Migración de datos: la columna vieja campaña_id pasa a ser la anual.
  try {
    if (oa) db.exec("UPDATE pa_ordenes     SET campaña_anual_id = campaña_id WHERE campaña_anual_id IS NULL AND campaña_id IS NOT NULL");
    if (ca) db.exec("UPDATE pa_compras     SET campaña_anual_id = campaña_id WHERE campaña_anual_id IS NULL AND campaña_id IS NOT NULL");
    if (cl) db.exec("UPDATE pa_costos_lote SET campaña_anual_id = campaña_id WHERE campaña_anual_id IS NULL AND campaña_id IS NOT NULL");
  } catch(e) { console.error('[PA] Error migrando campaña_id → campaña_anual_id:', e.message); }
})();

// ── MIGRACIÓN/BACKFILL: re-sincronizar campañas de pa_costos_lote con su orden ──
// CASO B: el costo de una aplicación (categoria fertilizante/agroquimico) se graba
// copiando las campañas que la orden tenía AL EJECUTARSE. Una reasignación bulk
// posterior cambiaba pa_ordenes pero NO pa_costos_lote, dejando el costo apuntando a
// campañas viejas (típicamente estacional NULL) que no matcheaban el reporte de Costos
// (ej. brócoli OA-00060/00061 daba $0). Acá re-alineamos los costos con la campaña
// actual de su orden (vía pa_aplicaciones). El arreglo de raíz vive en
// /ordenes/reasignar-bulk (propaga en la misma transacción).
// Idempotente: si no hay filas desincronizadas, no toca nada (solo un COUNT barato).
(function backfillCostosCampañas() {
  try {
    const tablas = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pa_costos_lote','pa_aplicaciones','pa_ordenes')"
    ).all().map(t => t.name);
    if (tablas.length < 3) return; // base vieja sin alguna tabla: nada que hacer
    const clCols = db.prepare("PRAGMA table_info(pa_costos_lote)").all().map(c => c.name);
    if (!clCols.includes('campaña_anual_id') || !clCols.includes('campaña_estacional_id')) return;

    // Costo fert/agro cuya campaña difiere de la de su orden (solo órdenes existentes).
    const condDesinc = `
      cl.categoria IN ('fertilizante','agroquimico')
      AND ( IFNULL(cl.campaña_anual_id,-1)      != IFNULL(o.campaña_anual_id,-1)
         OR IFNULL(cl.campaña_estacional_id,-1) != IFNULL(o.campaña_estacional_id,-1) )`;
    const desinc = db.prepare(`
      SELECT COUNT(*) AS n
      FROM pa_costos_lote cl
      JOIN pa_aplicaciones a ON a.id = cl.referencia_id
      JOIN pa_ordenes o ON o.id = a.orden_id
      WHERE ${condDesinc}
    `).get().n;

    if (!desinc) return; // ya está todo sincronizado (idempotente)

    console.log(`[PA] Backfill costos→campañas: ${desinc} fila(s) de pa_costos_lote desincronizadas con su orden. Re-sincronizando…`);
    // Desglose por orden (top 20) → deja el "dry-run" visible en los logs de Railway.
    try {
      db.prepare(`
        SELECT o.nro_orden AS nro, COUNT(*) AS filas,
               cl.campaña_anual_id AS cl_a, cl.campaña_estacional_id AS cl_e,
               o.campaña_anual_id  AS o_a,  o.campaña_estacional_id  AS o_e
        FROM pa_costos_lote cl
        JOIN pa_aplicaciones a ON a.id = cl.referencia_id
        JOIN pa_ordenes o ON o.id = a.orden_id
        WHERE ${condDesinc}
        GROUP BY o.id
        ORDER BY filas DESC
        LIMIT 20
      `).all().forEach(r => {
        console.log(`[PA]   OA ${r.nro}: ${r.filas} fila(s) | costo(anual=${r.cl_a}, est=${r.cl_e}) → orden(anual=${r.o_a}, est=${r.o_e})`);
      });
    } catch(_) {}

    // UPDATE en transacción, scopeado a las filas realmente desincronizadas.
    // referencia_id es único entre filas fert/agro (un costo por aplicación), así que
    // el IN por referencia_id selecciona exactamente esas filas. campaña_id es NOT NULL,
    // por eso se usa COALESCE(anual, estacional, actual) y no se setea NULL nunca.
    const tx = db.transaction(() => {
      const info = db.prepare(`
        UPDATE pa_costos_lote
        SET campaña_anual_id      = (SELECT o.campaña_anual_id      FROM pa_aplicaciones a JOIN pa_ordenes o ON o.id=a.orden_id WHERE a.id = pa_costos_lote.referencia_id),
            campaña_estacional_id = (SELECT o.campaña_estacional_id FROM pa_aplicaciones a JOIN pa_ordenes o ON o.id=a.orden_id WHERE a.id = pa_costos_lote.referencia_id),
            campaña_id            = COALESCE(
                                      (SELECT o.campaña_anual_id      FROM pa_aplicaciones a JOIN pa_ordenes o ON o.id=a.orden_id WHERE a.id = pa_costos_lote.referencia_id),
                                      (SELECT o.campaña_estacional_id FROM pa_aplicaciones a JOIN pa_ordenes o ON o.id=a.orden_id WHERE a.id = pa_costos_lote.referencia_id),
                                      pa_costos_lote.campaña_id)
        WHERE categoria IN ('fertilizante','agroquimico')
          AND referencia_id IN (
            SELECT cl.referencia_id
            FROM pa_costos_lote cl
            JOIN pa_aplicaciones a ON a.id = cl.referencia_id
            JOIN pa_ordenes o ON o.id = a.orden_id
            WHERE ${condDesinc}
          )
      `).run();
      return info.changes;
    });
    const changes = tx();
    console.log(`[PA] Backfill costos→campañas: ${changes} fila(s) actualizadas.`);
  } catch(e) {
    console.error('[PA] Backfill costos→campañas error:', e.message);
  }
})();

// ── MIGRACIÓN: cultivo elegido por el operario en la orden ────────────────
// El cultivo se elige explícitamente al emitir la orden (no se infiere del
// "cultivo actual" del lote, que es ambiguo con rotación). NULLABLE por
// compatibilidad con órdenes viejas; las nuevas lo exigen desde el backend.
(function migrarCultivoEnOrden() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_ordenes)").all().map(c => c.name);
    if (!cols.includes('cultivo')) {
      db.exec("ALTER TABLE pa_ordenes ADD COLUMN cultivo TEXT");
      console.log("[PA] Columna cultivo agregada en pa_ordenes");
    }
  } catch(e) { console.error('[PA] Error agregando cultivo en pa_ordenes:', e.message); }
})();

// ── MIGRACIÓN: admin de campañas — soft delete + log de auditoría ──────────
// pa_campañas.activa es el flag de "campaña vigente" (una por tipo), NO un
// soft-delete. Para poder borrar campañas creadas por error sin romper esa
// semántica, agregamos eliminada_en / eliminada_por_id (patrón de pa_ordenes).
// pa_campañas_log audita las reasignaciones bulk de órdenes/compras.
(function migrarAdminCampañas() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_campañas)").all().map(c => c.name);
    if (!cols.includes('eliminada_en'))     db.exec("ALTER TABLE pa_campañas ADD COLUMN eliminada_en TEXT");
    if (!cols.includes('eliminada_por_id'))  db.exec("ALTER TABLE pa_campañas ADD COLUMN eliminada_por_id INTEGER REFERENCES usuarios(id)");
  } catch(e) { console.error('[PA] Error agregando soft-delete en pa_campañas:', e.message); }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pa_campañas_log (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        accion                TEXT NOT NULL,
        entidad               TEXT NOT NULL CHECK(entidad IN ('orden','compra')),
        cantidad              INTEGER NOT NULL DEFAULT 0,
        campaña_anual_id      INTEGER REFERENCES pa_campañas(id),
        campaña_estacional_id INTEGER REFERENCES pa_campañas(id),
        limpiar_estacional    INTEGER DEFAULT 0,
        ids_afectados         TEXT,
        usuario_id            INTEGER REFERENCES usuarios(id),
        usuario_nombre        TEXT,
        creado_en             TEXT DEFAULT (datetime('now','localtime'))
      );
    `);
  } catch(e) { console.error('[PA] Error creando pa_campañas_log:', e.message); }
})();

// ── MIGRACIÓN: campañas históricas ────────────────────────────────────────
(function migrarCampañasHistoricas() {
  try {
    // Campañas anuales (Jul→Jun)
    const anuales = [
      ['2021/22', '2021-07-01', '2022-06-30'],
      ['2022/23', '2022-07-01', '2023-06-30'],
      ['2023/24', '2023-07-01', '2024-06-30'],
      ['2024/25', '2024-07-01', '2025-06-30'],
      ['2026/27', '2026-07-01', '2027-06-30'],
    ];
    for (const [nombre, inicio, fin] of anuales) {
      db.prepare("INSERT OR IGNORE INTO pa_campañas (nombre, fecha_inicio, fecha_fin, activa, tipo) VALUES (?,?,?,0,'anual')")
        .run(nombre, inicio, fin);
    }
    // Campañas estacionales (ciclos cortos — ej. invierno May→Oct)
    const estacionales = [
      ['Inv 2022', '2022-05-01', '2022-10-31'],
      ['Inv 2023', '2023-05-01', '2023-10-31'],
      ['Inv 2024', '2024-05-01', '2024-10-31'],
      ['Inv 2025', '2025-05-01', '2025-10-31'],
      ['Inv 2026', '2026-05-01', '2026-10-31'],
    ];
    for (const [nombre, inicio, fin] of estacionales) {
      db.prepare("INSERT OR IGNORE INTO pa_campañas (nombre, fecha_inicio, fecha_fin, activa, tipo) VALUES (?,?,?,0,'estacional')")
        .run(nombre, inicio, fin);
    }
  } catch(e) { console.error('[PA] Error migrando campañas históricas:', e.message); }
})();

// ── MIGRACIÓN: pa_insumos.unidad sin CHECK restrictivo ────────────────────
// El enum original ('kg','lt','unidad') es muy acotado. Se recrea la tabla
// para aceptar cualquier unidad (c.c, gramos, bolsa, rollos, ha, etc.).
// IMPORTANTE: se desactivan temporalmente las FK porque pa_compras_items,
// pa_ordenes_items, pa_aplicaciones, pa_costos_lote, pa_movimientos_stock
// referencian pa_insumos.id. SQLite maneja bien este patrón: al hacer ALTER
// TABLE RENAME mantiene las referencias automáticamente.
(function migrarUnidadInsumos() {
  try {
    const t = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pa_insumos'").get();
    if (t && t.sql && /CHECK\(unidad IN/.test(t.sql)) {
      // Desactivar FK temporalmente (NO puede estar dentro de una transacción)
      db.pragma('foreign_keys = OFF');

      const cols = db.prepare("PRAGMA table_info(pa_insumos)").all().map(c => c.name);
      const colsStr = cols.join(',');
      db.exec(`
        BEGIN;
        CREATE TABLE pa_insumos_v2 (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          nombre        TEXT NOT NULL,
          tipo          TEXT NOT NULL,
          unidad        TEXT NOT NULL,
          stock_actual  REAL DEFAULT 0,
          stock_minimo  REAL DEFAULT 0,
          activo        INTEGER DEFAULT 1,
          notas         TEXT,
          creado_en     TEXT DEFAULT (datetime('now','localtime')),
          componente_madre    TEXT,
          precio_ref_usd      REAL DEFAULT 0,
          ficha_tecnica_path  TEXT
        );
        INSERT INTO pa_insumos_v2 (${colsStr}) SELECT ${colsStr} FROM pa_insumos;
        DROP TABLE pa_insumos;
        ALTER TABLE pa_insumos_v2 RENAME TO pa_insumos;
        COMMIT;
      `);

      // Verificar integridad de FK antes de reactivar (debe estar vacío)
      const fkCheck = db.prepare("PRAGMA foreign_key_check").all();
      if (fkCheck.length > 0) {
        console.error('[PA] ⚠️  FK check falló después de migrar pa_insumos:', fkCheck);
      }

      db.pragma('foreign_keys = ON');
      console.log('[PA] pa_insumos recreada — unidad y tipo sin CHECK restrictivo');
    }
  } catch(e) {
    console.error('[PA] Error migrando pa_insumos.unidad:', e.message);
    // Reactivar FK aunque haya fallado, para no dejar la DB en estado inconsistente
    try { db.pragma('foreign_keys = ON'); } catch(e2) {}
  }
})();

// ── SEED: Maestro de insumos desde Excel (127 productos en USD) ────────────
(function seedInsumosMaestro() {
  try {
    // Solo correr si la tabla está vacía (carga inicial). Si ya se agregaron
    // manualmente, no se pisa nada y se completa con los que falten por nombre.
    const INSUMOS_INICIALES = [
      // [nombre, unidad, precio_ref_usd]
      ['Guano de Gallina', 'ha', 947.6],
      ['Hidrocomplex x 25kg', 'bolsa', 50.37],
      ['Semillas Cebolla Las tapias', 'kg', 35.71],
      ['Semillas Cebolla Navideña', 'kg', 30.5],
      ['Acido Fosforico', 'bidon', 0.0017],
      ['Solmix', 'lt', 1.35],
      ['Raundup', 'lt', 6.3],
      ['MCPA', 'lt', 5.2],
      ['Viñata', 'rollos', 3.43],
      ['Fosfato Monoamonico x 50kg', 'bolsa', 62.54],
      ['Potasio Nutriterra', 'lt', 0.59875],
      ['Koltar', 'lt', 30.77],
      ['STARANE XTRA X1lt . CORTEVA', 'lt', 60.77],
      ['Prodigio', 'lt', 33.392],
      ['Sol Ks', 'lt', 3.53],
      ['Prostart Plus', 'lt', 8.103],
      ['stoller boro', 'lt', 9.4545],
      ['Cipermetrina', 'c.c', 0.01376],
      ['Natural Oleo', 'lt', 3.625],
      ['Naylon Negro 1,2 mtrs', 'rollos', 107.35],
      ['Cinta de Riego', 'rollos', 225.0],
      ['Carbendazin', 'lt', 7.0],
      ['Gramoxone', 'lt', 5.764],
      ['Aminoquelant', 'lt', 18.061],
      ['At35', 'c.c', 0.042],
      ['Infinito', 'c.c', 0.055],
      ['Stimulate', 'c.c', 0.0616],
      ['Confidor', 'c.c', 45.65],
      ['Macrosorb foliar', 'lt', 27.92],
      ['Fosfito de Zinc', 'lt', 0],
      ['Karathane', 'c.c', 0.06868],
      ['A35t', 'c.c', 0.042],
      ['Mist', 'lt', 22.026],
      ['CaB Stoller', 'lt', 8.856],
      ['Plantines Brocoli', 'unidad', 0.0325],
      ['Inicium Radicular', 'c.c', 0.01912],
      ['Promes', 'c.c', 0.0403],
      ['Veneno hormigas', 'kg', 1.3425],
      ['SENCOREX 48 BAYER B x 10 ltrs', 'lt', 25.0],
      ['Rogor Plus', 'lt', 16.406],
      ['Bioforte', 'c.c', 0.07293],
      ['stoller zinc', 'lt', 9.93],
      ['Janfry', 'lt', 37.75],
      ['Decis', 'c.c', 0.045],
      ['stoller hierro', 'lt', 7.0],
      ['Entrevero', 'c.c', 0.01757],
      ['Fertilon', 'gramos', 0.0341],
      ['Fetrilon combi Compo', 'gramos', 0.034144],
      ['Ampligo', 'c.c', 0.2107],
      ['Stoler Boro', 'lt', 189.09],
      ['Mastermin', 'lt', 8.509],
      ['Miclostar', 'c.c', 0],
      ['Stoler zinc', 'lt', 1.35],
      ['systhane', 'gramos', 0.1392],
      ['intrepid', 'c.c', 0.0582],
      ['imidaclopird', 'c.c', 0.020044],
      ['stoller magnesio', 'lt', 8.856],
      ['Pithog Potasio', 'lt', 0],
      ['sunfire', 'c.c', 0.0588],
      ['belt', 'c.c', 0.156],
      ['Pithog zinc', 'lt', 0],
      ['ROUNDUP FULL II 66,2 % x 20LTS', 'lt', 6.3],
      ['movento', 'c.c', 0.118],
      ['Plantines de Melon', 'unidades', 0.0325],
      ['alquiler san geronimo', 'meses', 1000.0],
      ['armetil', 'kg', 25.65],
      ['basfoliar kelp', 'lt', 13.32],
      ['Semillas MELON HIB. SUNDEW', 'unidad', 0.105],
      ['Fertileader gold', 'lt', 27.783],
      ['super one cide', 'lt', 57.542],
      ['vertimec', 'c.c', 0.178],
      ['Nitro Plus', 'lt', 3.6],
      ['coragen', 'c.c', 0.31915],
      ['giberalina', 'c.c', 18.02],
      ['Phytogard zinc Stoller', 'lt', 9.93],
      ['Aminoquelant K', 'lt', 17.33],
      ['karate', 'c.c', 0.09],
      ['sugar mover', 'lt', 15.0],
      ['ZET', 'lt', 0],
      ['Abamectina', 'lt', 11.76],
      ['Aminoquelant Ca', 'lt', 11.218],
      ['Etrel', 'c.c', 33.01],
      ['MAP', 'lt', 1.8743],
      ['Plantines Tomate Fitotec', 'plantines', 0.0726],
      ['Servicios hechar guano MARTIN', 'ha', 80.0],
      ['Servicios armar camas MARTIN', 'ha', 395.0],
      ['Bioamino', 'lt', 8.52],
      ['Guenta n26', 'lt', 1.1375],
      ['Sempra', 'gramos', 0.7934],
      ['Omite', 'lt', 37.69],
      ['Biosmart', 'lt', 8.52],
      ['amistar', 'lt', 16.98],
      ['bioforge', 'lt', 0.07293],
      ['bioamino L Zinc ARCOR', 'lt', 8.52],
      ['Sol Mix', 'lt', 1.35],
      ['Amin Ziman', 'lt', 0],
      ['Amin Cuaje', 'kg', 0],
      ['Paraquat', 'lt', 5.764],
      ['Bio aminol', 'lt', 0],
      ['Galant', 'lt', 15.07],
      ['Titus', 'c.c', 0.06],
      ['Plantines Tomate Proplanta', 'unidades', 0.240475],
      ['Bioamino Zinc', 'lt', 8.52],
      ['Bioil.s', 'lt', 0],
      ['Oponente', 'lt', 0],
      ['amino cuaje', 'kg', 0],
      ['Bio Forge', 'lt', 0.07293],
      ['Oxicloruro', 'kg', 0],
      ['Minectro pro', 'lt', 0],
      ['Mospilan', 'lt', 1.88],
      ['Aplaud', 'kg', 0],
      ['Biol.s', 'lt', 0],
      ['Semilla Zapallo Victorio', 'unidades', 54.2],
      ['Sulfato de cobre', 'kg', 8.92],
      ['Amistar Top', 'lt', 16.98],
      ['ROUNDUP', 'lt', 6.3],
      ['M granulars', 'kg', 0],
      ['Semilla Cebolla Presto', 'sobres', 447.93],
      ['Herbadox', 'lt', 18.02],
      ['Epigle', 'lt', 88.42],
      ['Cebada', 'kg', 1.41],
      ['Tifon', 'lt', 33.01],
      ['Semilla Cebolla Serengeti', 'sobres', 447.93],
      ['Hidroxido', 'kg', 0],
      ['Friponil', 'c.c', 0],
      ['Aminoquelant cacio', 'lt', 11.218],
      ['Nitrate Balncer', 'lt', 0],
    ];

    const checkStmt = db.prepare("SELECT id FROM pa_insumos WHERE nombre = ? COLLATE NOCASE");
    const insStmt = db.prepare(`INSERT INTO pa_insumos
        (nombre, tipo, unidad, stock_actual, stock_minimo, precio_ref_usd, notas)
        VALUES (?, 'otro', ?, 0, 0, ?, 'Importado del maestro inicial')`);

    let nuevos = 0, existentes = 0;
    const tx = db.transaction(() => {
      for (const [nombre, unidad, precio] of INSUMOS_INICIALES) {
        const ya = checkStmt.get(nombre);
        if (ya) { existentes++; continue; }
        insStmt.run(nombre, unidad, precio);
        nuevos++;
      }
    });
    tx();
    if (nuevos > 0) console.log(`[PA] Maestro de insumos: ${nuevos} nuevos, ${existentes} ya existentes`);
  } catch(e) { console.error('[PA] Error seed maestro insumos:', e.message); }
})();

// ── MIGRACIÓN: agregar categoría principal a pa_insumos ───────────────────
// Clasificación de nivel superior: AGROINSUMOS / HERRAMIENTAS / OTROS.
// Los 127 agroinsumos que ya vienen del Excel quedan bajo 'agroinsumos' por
// defecto — la reclasificación fina del `tipo` (fertilizante, herbicida, etc.)
// se hace desde el panel después.
(function agregarCategoriaPrincipal() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_insumos)").all().map(c => c.name);
    if (!cols.includes('categoria_principal')) {
      db.exec("ALTER TABLE pa_insumos ADD COLUMN categoria_principal TEXT NOT NULL DEFAULT 'agroinsumos'");
      console.log('[PA] pa_insumos.categoria_principal agregada (default: agroinsumos)');
    }
  } catch(e) { console.error('[PA] Error agregando categoria_principal:', e.message); }
})();

// ── MÓDULO COMBUSTIBLE ─────────────────────────────────────────────────────
// Tanques (gasoil + nafta), vehículos (tractores/camionetas/motos) y
// movimientos unificados (entradas y salidas en una sola tabla).

db.exec(`
  -- Tanques de combustible (uno por tipo)
  CREATE TABLE IF NOT EXISTS pa_combustible_tanques (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre        TEXT NOT NULL UNIQUE,
    tipo          TEXT NOT NULL CHECK(tipo IN ('gasoil','nafta')),
    capacidad_lt  REAL DEFAULT 0,
    stock_actual  REAL DEFAULT 0,
    ubicacion     TEXT,
    activo        INTEGER DEFAULT 1,
    notas         TEXT,
    creado_en     TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Vehículos que consumen combustible
  CREATE TABLE IF NOT EXISTS pa_vehiculos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo            TEXT NOT NULL CHECK(tipo IN ('tractor','camioneta','moto','otro')),
    identificacion  TEXT NOT NULL UNIQUE,
    marca_modelo    TEXT,
    combustible     TEXT NOT NULL CHECK(combustible IN ('gasoil','nafta')),
    tiene_horometro INTEGER DEFAULT 0,
    horas_actuales  REAL DEFAULT 0,
    km_actuales     REAL DEFAULT 0,
    activo          INTEGER DEFAULT 1,
    notas           TEXT,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Movimientos de combustible — entradas Y salidas en una sola tabla
  CREATE TABLE IF NOT EXISTS pa_combustible_movimientos (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha             TEXT NOT NULL DEFAULT (date('now','localtime')),
    tipo_movimiento   TEXT NOT NULL CHECK(tipo_movimiento IN ('carga_tanque','consumo_tanque','consumo_estacion','ajuste_varilla')),
    tanque_id         INTEGER REFERENCES pa_combustible_tanques(id),
    vehiculo_id       INTEGER REFERENCES pa_vehiculos(id),
    combustible       TEXT NOT NULL CHECK(combustible IN ('gasoil','nafta')),
    litros            REAL NOT NULL,
    precio_unitario   REAL DEFAULT 0,
    moneda            TEXT DEFAULT 'ARS' CHECK(moneda IN ('ARS','USD')),
    precio_total      REAL DEFAULT 0,
    proveedor_id      INTEGER REFERENCES pa_proveedores(id),
    proveedor_txt     TEXT,
    tipo_comprobante  TEXT,
    nro_comprobante   TEXT,
    foto_path         TEXT,
    lote_id           INTEGER REFERENCES pa_lotes(id),
    orden_id          INTEGER REFERENCES pa_ordenes(id),
    horas_horometro   REAL,
    km_vehiculo       REAL,
    cargado_por       INTEGER REFERENCES usuarios(id),
    estado_revision   TEXT DEFAULT 'pendiente' CHECK(estado_revision IN ('pendiente','revisado','corregido')),
    revisado_por      INTEGER REFERENCES usuarios(id),
    revisado_en       TEXT,
    notas_revision    TEXT,
    notas             TEXT,
    creado_en         TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Índices para queries frecuentes
  CREATE INDEX IF NOT EXISTS idx_pa_comb_mov_fecha ON pa_combustible_movimientos(fecha);
  CREATE INDEX IF NOT EXISTS idx_pa_comb_mov_vehiculo ON pa_combustible_movimientos(vehiculo_id);
  CREATE INDEX IF NOT EXISTS idx_pa_comb_mov_estado ON pa_combustible_movimientos(estado_revision);
  CREATE INDEX IF NOT EXISTS idx_pa_comb_mov_lote ON pa_combustible_movimientos(lote_id);

  -- Vinculación N:M entre facturas de combustible (pa_compras, proveedor
  -- COMBUSTIBLE BARCELO) y recargas del tanque central. En este repo una
  -- "recarga" es un movimiento con tipo_movimiento='carga_tanque', por eso
  -- recarga_id referencia pa_combustible_movimientos (no existe recargas_tanque).
  CREATE TABLE IF NOT EXISTS pa_vinculacion_factura_recarga (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    compra_id     INTEGER NOT NULL REFERENCES pa_compras(id) ON DELETE CASCADE,
    recarga_id    INTEGER NOT NULL REFERENCES pa_combustible_movimientos(id) ON DELETE CASCADE,
    vinculado_en  TEXT DEFAULT CURRENT_TIMESTAMP,
    vinculado_por INTEGER REFERENCES usuarios(id),
    UNIQUE(compra_id, recarga_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pa_vinc_compra  ON pa_vinculacion_factura_recarga(compra_id);
  CREATE INDEX IF NOT EXISTS idx_pa_vinc_recarga ON pa_vinculacion_factura_recarga(recarga_id);
`);

// ── SEED: Tanque Gasoil + Tanque Nafta ─────────────────────────────────────
(function seedTanquesCombustible() {
  try {
    const n = db.prepare("SELECT COUNT(*) as n FROM pa_combustible_tanques").get();
    if (n.n === 0) {
      db.prepare("INSERT INTO pa_combustible_tanques (nombre, tipo, capacidad_lt, stock_actual) VALUES (?,?,?,?)")
        .run('Tanque Gasoil', 'gasoil', 0, 0);
      db.prepare("INSERT INTO pa_combustible_tanques (nombre, tipo, capacidad_lt, stock_actual) VALUES (?,?,?,?)")
        .run('Tanque Nafta', 'nafta', 0, 0);
      console.log('[PA] Tanques de combustible (gasoil y nafta) creados');
    }
  } catch(e) { console.error('[PA] Error seed tanques combustible:', e.message); }
})();

// ── MÓDULO PERSONAL / MANO DE OBRA ─────────────────────────────────────────
// Cuadrillas, trabajadores, tareas, partes de trabajo y valorización por RRHH.
// El rubro contable se sugiere automáticamente cruzando tipo_labor × cultivo.

db.exec(`
  -- Rubros contables (alineados con contabilidad)
  CREATE TABLE IF NOT EXISTS pa_rubros_contables (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre      TEXT NOT NULL UNIQUE,
    tipo_labor  TEXT NOT NULL CHECK(tipo_labor IN ('produccion','cosecha_empaque','general','otro')),
    cultivo     TEXT,   -- uva, durazno, damasco, brocoli, cebolla, melon, melon_tardio, tomate_industria, null
    activo      INTEGER DEFAULT 1,
    notas       TEXT,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Cuadrillas
  CREATE TABLE IF NOT EXISTS pa_cuadrillas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre      TEXT NOT NULL UNIQUE,
    capataz_id  INTEGER REFERENCES usuarios(id),
    tipo        TEXT DEFAULT 'fija' CHECK(tipo IN ('fija','pool')),
    activo      INTEGER DEFAULT 1,
    notas       TEXT,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Grupos / Colectivos (admin de trabajadores — distinto de cuadrilla)
  -- Cuadrilla = jornada de trabajo anónima con N personas
  -- Grupo     = clasificación administrativa del trabajador individual
  CREATE TABLE IF NOT EXISTS pa_grupos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre      TEXT NOT NULL UNIQUE,
    descripcion TEXT,
    activo      INTEGER DEFAULT 1,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );

  -- (pa_trabajadores ELIMINADA — unificado en pa_personal. Ver migración abajo.)

  -- Tipos de tarea (catálogo)
  CREATE TABLE IF NOT EXISTS pa_tareas_tipos (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre               TEXT NOT NULL UNIQUE,
    tipo_labor           TEXT NOT NULL CHECK(tipo_labor IN ('produccion','cosecha_empaque','general','otro')),
    rubro_contable_id    INTEGER REFERENCES pa_rubros_contables(id),
    es_destajo           INTEGER DEFAULT 0,
    unidad_destajo       TEXT,   -- cajon, kg, planta, ha, tacho, null
    activo               INTEGER DEFAULT 1,
    creado_en            TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_pa_rubros_tipo_cult ON pa_rubros_contables(tipo_labor, cultivo);
`);

// ── BORRADO legacy: partes de trabajo + fichajes GPS (flujo Scout discontinuado) ──
// Se eliminaron la UI (Scout + panel) y los endpoints. Estas 4 tablas (confirmadas
// vacías) se dropean. DROP IF EXISTS es idempotente (no-op si ya no están). Orden
// hijas → padres, FK off por seguridad. NO toca pa_cuadrillas / pa_tareas_tipos /
// pa_trabajadores / pa_rubros_contables / pa_grupos (compartidas o vivas por otro lado).
try {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DROP TABLE IF EXISTS pa_partes_valorizacion;
    DROP TABLE IF EXISTS pa_partes_trabajo_items;
    DROP TABLE IF EXISTS pa_partes_trabajo;
    DROP TABLE IF EXISTS pa_fichajes_cuadrilla;
  `);
  db.pragma('foreign_keys = ON');
} catch (e) {
  try { db.pragma('foreign_keys = ON'); } catch (_) {}
  console.error('[PA] Error dropeando legacy partes/fichajes:', e.message);
}

// ── SEED: grupo "Sin asignar" (opción de fallback en el catálogo de grupos) ──
(function seedGrupoDefault() {
  try {
    const n = db.prepare("SELECT COUNT(*) as n FROM pa_grupos").get();
    if (n.n === 0) {
      db.prepare("INSERT INTO pa_grupos (nombre, descripcion) VALUES (?, ?)")
        .run('Sin asignar', 'Grupo por defecto — asignar uno real cuando se pueda');
      console.log('[PA] Grupo "Sin asignar" creado');
    }
  } catch(e) { console.error('[PA] Error seed grupo default:', e.message); }
})();

// ═══════════════════════════════════════════════════════════════════════════
// PERSONAL V1 — Padrón unificado + permisos (Fase 1)
// pa_personal reemplaza conceptualmente a pa_trabajadores (que queda LEGACY).
// Los permisos del módulo viven en pa_permisos_personal (decoupled de auth.js).
// ═══════════════════════════════════════════════════════════════════════════
db.exec(`
  -- Padrón unificado de personal (fijos + contratistas)
  CREATE TABLE IF NOT EXISTS pa_personal (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo                  TEXT NOT NULL CHECK(tipo IN ('fijo','contratista')),
    nombre                TEXT NOT NULL,
    dni                   TEXT,
    cuit                  TEXT,
    persona_id            INTEGER REFERENCES personas(id),         -- FK opcional al módulo Equipo (solo fijos)
    contratista_madre_id  INTEGER REFERENCES pa_personal(id),      -- si un fijo pertenece a un contratista
    cuadrilla_default_id  INTEGER REFERENCES pa_cuadrillas(id),
    grupo_id              INTEGER REFERENCES pa_grupos(id),         -- clasificación administrativa (ex pa_trabajadores.grupo_id)
    tarifa_default        REAL DEFAULT 0,
    unidad_tarifa         TEXT DEFAULT 'jornal' CHECK(unidad_tarifa IN ('jornal','hora','tanto','tacho','planta','kg')),
    activo                INTEGER NOT NULL DEFAULT 1,
    notas                 TEXT,
    creado_en             TEXT DEFAULT (datetime('now','localtime')),
    creado_por            INTEGER REFERENCES usuarios(id),
    modificado_en         TEXT,
    modificado_por        INTEGER,
    eliminado_en          TEXT,
    eliminado_por_id      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pa_personal_tipo    ON pa_personal(tipo);
  CREATE INDEX IF NOT EXISTS idx_pa_personal_activo  ON pa_personal(activo);
  CREATE INDEX IF NOT EXISTS idx_pa_personal_madre   ON pa_personal(contratista_madre_id);
  CREATE INDEX IF NOT EXISTS idx_pa_personal_persona ON pa_personal(persona_id);

  -- Permisos del módulo Personal (V1, sin tocar auth.js ni la UI admin central).
  -- Una fila por usuario. Admin (rol='admin') obtiene ambos permisos por código.
  CREATE TABLE IF NOT EXISTS pa_permisos_personal (
    usuario_id            INTEGER PRIMARY KEY REFERENCES usuarios(id),
    personal_asistencia   INTEGER NOT NULL DEFAULT 0,
    personal_valorizacion INTEGER NOT NULL DEFAULT 0,
    modificado_en         TEXT DEFAULT (datetime('now','localtime')),
    modificado_por        INTEGER
  );
`);

// ── Migración: pa_personal.unidad_tarifa admite 'fijo' (monto fijo semanal) ──
// El CHECK original no incluye 'fijo', así que en prod (tabla ya creada) un INSERT
// con unidad_tarifa='fijo' fallaría. SQLite no permite ALTER de un CHECK: hay que
// rebuild. Idempotente y robusta:
//  · Lee el SQL REAL de la tabla desde sqlite_master y ENSANCHA solo el CHECK de
//    unidad_tarifa (derivar del schema real preserva las columnas que tenga prod
//    — evita asumir columnas, como el crash de personal_actual_id).
//  · Si el CHECK ya incluye 'fijo' (o no hay CHECK introspectable) no hace nada.
//  · Replica los índices existentes (los que tengan sql) tras el swap.
(function() {
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pa_personal'").get();
    if (!row || !row.sql) return;
    const reCheck = /(unidad_tarifa[\s\S]*?CHECK\s*\(\s*unidad_tarifa\s+IN\s*\()([^)]*)(\))/i;
    const m = row.sql.match(reCheck);
    if (!m) return;                   // sin CHECK de unidad_tarifa: nada que ampliar
    if (/'fijo'/.test(m[2])) return;  // ya migrada (idempotente)
    const idxRows = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='pa_personal' AND sql IS NOT NULL").all();
    const nuevoSql = row.sql.replace(reCheck, (_x, pre, lista, post) => pre + lista.replace(/\s+$/, '') + ",'fijo'" + post);
    const tmpSql   = nuevoSql.replace(/CREATE TABLE\s+(IF NOT EXISTS\s+)?["'`]?pa_personal["'`]?/i, 'CREATE TABLE pa_personal__mig');
    db.pragma('foreign_keys = OFF');  // fuera de la transacción (better-sqlite3 lo ignora dentro)
    db.transaction(() => {
      db.exec(tmpSql);
      db.exec('INSERT INTO pa_personal__mig SELECT * FROM pa_personal');
      db.exec('DROP TABLE pa_personal');
      db.exec('ALTER TABLE pa_personal__mig RENAME TO pa_personal');
      idxRows.forEach(ix => { if (ix.sql) db.exec(ix.sql); });
    })();
    db.pragma('foreign_keys = ON');
    console.log("[PA] pa_personal.unidad_tarifa: CHECK ampliado con 'fijo'");
  } catch(e) {
    console.error('[PA] Error migrando unidad_tarifa fijo:', e.message);
    try { db.pragma('foreign_keys = ON'); } catch(_) {}
  }
})();

// ── Migración: responsable_id en pa_cuadrillas ──────────────────────────────
// La persona (pa_personal) que cobra por toda la cuadrilla y tiene su CC. En modo
// Cuadrilla de asistencia, el titular de pago se deriva de este responsable.
// Simple ADD COLUMN (sin rebuild), idempotente con guard PRAGMA table_info.
try {
  const colsCu = db.prepare("PRAGMA table_info(pa_cuadrillas)").all().map(c => c.name);
  if (!colsCu.includes('responsable_id')) {
    db.exec('ALTER TABLE pa_cuadrillas ADD COLUMN responsable_id INTEGER REFERENCES pa_personal(id)');
    console.log('[PA] responsable_id agregado en pa_cuadrillas');
  }
} catch(e) { console.error('[PA] Error migrando responsable_id en pa_cuadrillas:', e.message); }

// ── Migración: rol en pa_personal (texto libre, ej. Regador/Peón) ────────────
// Simple ADD COLUMN (sin rebuild), idempotente con guard PRAGMA table_info.
try {
  const colsP = db.prepare("PRAGMA table_info(pa_personal)").all().map(c => c.name);
  if (!colsP.includes('rol')) {
    db.exec('ALTER TABLE pa_personal ADD COLUMN rol TEXT');
    console.log('[PA] rol agregado en pa_personal');
  }
} catch(e) { console.error('[PA] Error migrando rol en pa_personal:', e.message); }

// ── Migración: flag post_cosecha en pa_tareas_tipos ("Post-Cosecha") ─────────
// Habilita, en el modal de asistencia, imputar el trabajo a la campaña INMEDIATAMENTE
// ANTERIOR (anual + estacional). Simple ADD COLUMN, idempotente con guard PRAGMA.
try {
  const colsT = db.prepare("PRAGMA table_info(pa_tareas_tipos)").all().map(c => c.name);
  if (!colsT.includes('post_cosecha')) {
    db.exec('ALTER TABLE pa_tareas_tipos ADD COLUMN post_cosecha INTEGER DEFAULT 0');
    console.log('[PA] post_cosecha agregado en pa_tareas_tipos');
  }
} catch(e) { console.error('[PA] Error migrando post_cosecha en pa_tareas_tipos:', e.message); }

// ── Migración: flag requiere_lote en pa_tareas_tipos ─────────────────────────
// La mayoría de las tareas son de campo (van a una finca/lote → default 1). Las de
// galpón (empaque, selección, repaso, etc.) NO están en un lote: su MO se imputa a la
// CAMPAÑA, no a un lote. Al CREAR la columna sembramos requiere_lote=0 por nombre para
// esas tareas (solo esa vez; después respeta lo que marque el admin). Idempotente.
try {
  const colsRL = db.prepare("PRAGMA table_info(pa_tareas_tipos)").all().map(c => c.name);
  if (!colsRL.includes('requiere_lote')) {
    db.exec("ALTER TABLE pa_tareas_tipos ADD COLUMN requiere_lote INTEGER NOT NULL DEFAULT 1");
    const r = db.prepare(`UPDATE pa_tareas_tipos SET requiere_lote=0
      WHERE lower(nombre) LIKE '%empaque%'  OR lower(nombre) LIKE '%embalaje%'
         OR lower(nombre) LIKE '%selecc%'   OR lower(nombre) LIKE '%repaso%'
         OR lower(nombre) LIKE '%clasif%'   OR lower(nombre) LIKE '%galp%'`).run();
    console.log(`[PA] requiere_lote agregado en pa_tareas_tipos (${r.changes} tarea(s) de galpón → 0)`);
  }
} catch(e) { console.error('[PA] Error migrando requiere_lote en pa_tareas_tipos:', e.message); }

// ── Padrón de tarifas por ROL (costeo MO automático) ────────────────────────
// La tarifa de la mano de obra individual/grupal se resuelve por el rol de la persona
// (pa_personal.rol), no se tipea por línea. $/jornal. Idempotente.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pa_tarifas_rol (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      rol            TEXT NOT NULL UNIQUE,
      tarifa         REAL NOT NULL DEFAULT 0,
      modificado_en  TEXT DEFAULT (datetime('now','localtime')),
      modificado_por INTEGER
    )
  `);
} catch(e) { console.error('[PA] Error creando pa_tarifas_rol:', e.message); }

// ── Tarifa por PERSONA con vigencia (override del default por rol) ───────────
// RRHH redefinió que la valorización individual es POR PERSONA. La tarifa de rol
// (pa_tarifas_rol) pasa a ser el DEFAULT; si la persona tiene tarifa propia, gana.
// SIN UNIQUE(personal_id): varias filas por persona = histórico de vigencias. La
// tarifa aplicable a una fecha = fila de esa persona con vigente_desde <= fecha,
// la más reciente (ORDER BY vigente_desde DESC LIMIT 1). Idempotente.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pa_tarifas_persona (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      personal_id   INTEGER NOT NULL REFERENCES pa_personal(id),
      tarifa        REAL NOT NULL,
      vigente_desde TEXT NOT NULL,
      creado_en     TEXT DEFAULT (datetime('now','localtime')),
      creado_por    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pa_tarifas_persona ON pa_tarifas_persona(personal_id, vigente_desde);
  `);
} catch(e) { console.error('[PA] Error creando pa_tarifas_persona:', e.message); }

// ── Acceso sensible: sesión re-password (15 min) para vistas de compensación ──
// Barrera genérica (no PC-only): "Por valorizar" y la edición de tarifas por persona
// exigen reingresar la clave. Validada → ventana de 15 min sin reingresar. Una fila
// por usuario (PK), se pisa en cada revalidación. expira_en en localtime. Idempotente.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pa_acceso_sensible (
      usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id),
      expira_en  TEXT NOT NULL,
      creado_en  TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
} catch(e) { console.error('[PA] Error creando pa_acceso_sensible:', e.message); }

// ── Migración: tarifa_jornal en pa_cuadrillas ($/jornal de la cuadrilla) ─────
// El modo Cuadrilla (bloque) cobra por la tarifa de SU cuadrilla, no por el rol de la
// responsable. Simple ADD COLUMN, idempotente con guard PRAGMA table_info.
try {
  const colsCu = db.prepare("PRAGMA table_info(pa_cuadrillas)").all().map(c => c.name);
  if (!colsCu.includes('tarifa_jornal')) {
    db.exec('ALTER TABLE pa_cuadrillas ADD COLUMN tarifa_jornal REAL');
    console.log('[PA] tarifa_jornal agregado en pa_cuadrillas');
  }
} catch(e) { console.error('[PA] Error migrando tarifa_jornal en pa_cuadrillas:', e.message); }

// (Migraciones pa_trabajadores→pa_personal ELIMINADAS: ya cumplidas; la unificación
//  final — grupo_id, columnas de Pañol y DROP de pa_trabajadores — está más abajo,
//  después de crear las tablas de Pañol.)

// ═══════════════════════════════════════════════════════════════════════════
// PERSONAL V1 — Asistencia diaria (Fase 2)
// Una fila por persona-finca-tarea-tramo. Dato físico (sin $).
// rubro_cuenta_id → pa_cuentas (plan de Pablo, read-only, siempre cuenta 'MO %').
// cuadrilla_id = de dónde viene la gente (Silva/Gordillo/...), distinto del rubro.
// ═══════════════════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS pa_asistencias (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha                 TEXT NOT NULL,
    cuadrilla_id          INTEGER REFERENCES pa_cuadrillas(id),
    personal_id           INTEGER REFERENCES pa_personal(id),   -- NULL si bloque sin nombre
    contratista_id        INTEGER REFERENCES pa_personal(id),   -- contratista madre (req. si bloque)
    cantidad              INTEGER NOT NULL DEFAULT 1,
    horas                 REAL NOT NULL,
    jornales_calc         REAL,                                  -- cantidad * horas / 8 (al insertar/editar)
    -- Imputación contable y de costos
    rubro_cuenta_id       INTEGER NOT NULL,                      -- FK lógica a pa_cuentas(id), read-only
    campaña_anual_id      INTEGER NOT NULL REFERENCES pa_campañas(id),
    campaña_estacional_id INTEGER NOT NULL REFERENCES pa_campañas(id),
    lote_id               INTEGER REFERENCES pa_lotes(id),        -- nullable: NULL en MO general (gasto de estructura, sin lote)
    finca                 TEXT,                                  -- denormalizado del lote
    tarea_tipo_id         INTEGER REFERENCES pa_tareas_tipos(id),
    cultivo               TEXT,                                  -- opcional, denormalizado
    estado                TEXT NOT NULL DEFAULT 'pendiente_valorizar'
                            CHECK(estado IN ('pendiente_valorizar','valorizado','anulado')),
    notas                 TEXT,
    cargado_por           INTEGER NOT NULL REFERENCES usuarios(id),
    creado_en             TEXT DEFAULT (datetime('now','localtime')),
    modificado_en         TEXT,
    modificado_por        INTEGER,
    anulado_en            TEXT,
    anulado_por           INTEGER,
    anulado_motivo        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pa_asist_fecha   ON pa_asistencias(fecha);
  CREATE INDEX IF NOT EXISTS idx_pa_asist_estado  ON pa_asistencias(estado);
  CREATE INDEX IF NOT EXISTS idx_pa_asist_personal ON pa_asistencias(personal_id);
  CREATE INDEX IF NOT EXISTS idx_pa_asist_contra  ON pa_asistencias(contratista_id);
  CREATE INDEX IF NOT EXISTS idx_pa_asist_lote    ON pa_asistencias(lote_id);
`);

// ═══════════════════════════════════════════════════════════════════════════
// PERSONAL V1 — Valorización + Cuenta Corriente (Fase 3)
// ═══════════════════════════════════════════════════════════════════════════
db.exec(`
  -- Valorización de una asistencia (la hace rol Valorización)
  CREATE TABLE IF NOT EXISTS pa_asistencia_valorizacion (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    asistencia_id      INTEGER NOT NULL UNIQUE REFERENCES pa_asistencias(id),
    tarifa_unitaria    REAL NOT NULL,
    unidad_tarifa      TEXT NOT NULL,          -- copiada del padrón al valorizar
    monto_total        REAL NOT NULL,
    detalle_json       TEXT,                   -- breakdown del cálculo
    valorizado_por     INTEGER NOT NULL REFERENCES usuarios(id),
    fecha_valorizacion TEXT DEFAULT (datetime('now','localtime')),
    costo_lote_id      INTEGER REFERENCES pa_costos_lote(id),
    cc_movimiento_id   INTEGER REFERENCES pa_cc_movimientos(id)
  );

  -- Cuenta corriente unificada (fijos + contratistas)
  CREATE TABLE IF NOT EXISTS pa_cc_movimientos (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo_titular     TEXT NOT NULL CHECK(tipo_titular IN ('fijo','contratista')),
    titular_id       INTEGER NOT NULL REFERENCES pa_personal(id),
    fecha            TEXT NOT NULL DEFAULT (date('now','localtime')),
    tipo_mov         TEXT NOT NULL CHECK(tipo_mov IN ('devengado','pago','adelanto','ajuste','anulacion')),
    monto            REAL NOT NULL,            -- >0 le debemos (devengado) ; <0 le pagamos/adelanto
    descripcion      TEXT,
    referencia_tipo  TEXT,                     -- 'asistencia','pago_manual','adelanto_manual','ajuste_manual'
    referencia_id    INTEGER,
    saldo_acumulado  REAL,                     -- denormalizado, recalculado cronológicamente
    cargado_por      INTEGER NOT NULL REFERENCES usuarios(id),
    creado_en        TEXT DEFAULT (datetime('now','localtime')),
    anulado          INTEGER DEFAULT 0,
    anulado_en       TEXT,
    anulado_por      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pa_cc_titular ON pa_cc_movimientos(tipo_titular, titular_id);
  CREATE INDEX IF NOT EXISTS idx_pa_cc_fecha   ON pa_cc_movimientos(fecha);
`);

// ── MIGRACIÓN: columna 'origen' en pa_costos_lote (decisión Personal V1) ────
// Aditiva y segura. Aísla los costos de asistencia ('asistencia') de los de
// partes ('parte') y aplicaciones ('aplicacion'). El BACKFILL de filas viejas
// NO corre acá — se hace por endpoint admin con dry-run + OK (ver produccion.js).
(function migrarCostosLoteOrigen() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_costos_lote)").all().map(c => c.name);
    if (!cols.includes('origen')) {
      db.exec("ALTER TABLE pa_costos_lote ADD COLUMN origen TEXT");
      console.log('[PA] pa_costos_lote.origen agregado (nullable; backfill por endpoint admin)');
    }
  } catch(e) { console.error('[PA] Error migrando pa_costos_lote.origen:', e.message); }
})();

// ── SEED: 20 rubros contables (tal cual contabilidad) ──────────────────────
(function seedRubrosContables() {
  try {
    const n = db.prepare("SELECT COUNT(*) as n FROM pa_rubros_contables").get();
    if (n.n === 0) {
      const rubros = [
        // [nombre, tipo_labor, cultivo]
        ['G -MO GENERALES',                  'general',         null],
        ['G -MO PROD . INDUSTRIA',           'produccion',      'industria'],
        ['G - MO PRODUCCION DAMASCO',        'produccion',      'damasco'],
        ['G - MO PRODUCCION UVA',            'produccion',      'uva'],
        ['G - MO PRODUCCION DURAZNO',        'produccion',      'durazno'],
        ['G - MO PRODUCCION BROCOLI',        'produccion',      'brocoli'],
        ['G - MO PRODUCCION CEBOLLA',        'produccion',      'cebolla'],
        ['G - MO PRODUCCION MELON',          'produccion',      'melon'],
        ['G - MO COSH Y EMP DAMASCO',        'cosecha_empaque', 'damasco'],
        ['G - MO COSH Y EMP DURAZNO',        'cosecha_empaque', 'durazno'],
        ['G - MO COSH Y EMP UVA',            'cosecha_empaque', 'uva'],
        ['G - MO COSH Y EMP BROCOLI',        'cosecha_empaque', 'brocoli'],
        ['G - MO COSH Y EMP CEBOLLA',        'cosecha_empaque', 'cebolla'],
        ['G - MO COSH Y EMP MELON',          'cosecha_empaque', 'melon'],
        ['G - MO COSH Y EMPAQUE GENERAL',    'cosecha_empaque', null],
        ['SAN GERONIMO',                     'otro',            null],
        ['INVERSION',                        'otro',            null],
        ['G - MO PRODUCCION MELON TARDIO',   'produccion',      'melon_tardio'],
        ['G - MO COSH TOMATE INDUSTRIA',     'cosecha_empaque', 'tomate_industria'],
        ['G - MO COSH Y EMP MELON TARDIO',   'cosecha_empaque', 'melon_tardio'],
      ];
      const ins = db.prepare("INSERT INTO pa_rubros_contables (nombre, tipo_labor, cultivo) VALUES (?,?,?)");
      for (const [nombre, tipo, cult] of rubros) ins.run(nombre, tipo, cult);
      console.log(`[PA] ${rubros.length} rubros contables creados`);
    }
  } catch(e) { console.error('[PA] Error seed rubros:', e.message); }
})();

// ── SEED: catálogo inicial de tareas ───────────────────────────────────────
(function seedTareasTipos() {
  try {
    const n = db.prepare("SELECT COUNT(*) as n FROM pa_tareas_tipos").get();
    if (n.n === 0) {
      // Rubro GENERAL para tareas sin cultivo específico
      const gralRow = db.prepare("SELECT id FROM pa_rubros_contables WHERE nombre = 'G -MO GENERALES'").get();
      const gralId = gralRow ? gralRow.id : null;

      const tareas = [
        // [nombre, tipo_labor, rubro_id_fijo, es_destajo, unidad_destajo]
        // Producción — rubro se calcula por cultivo del lote
        ['Poda verde',                'produccion',       null,   0, null],
        ['Poda de invierno',          'produccion',       null,   0, null],
        ['Raleo',                     'produccion',       null,   0, null],
        ['Atado / tutorado',          'produccion',       null,   0, null],
        ['Carpida / desmalezado',     'produccion',       null,   0, null],
        ['Control de riego',          'produccion',       null,   0, null],
        ['Control sanitario',         'produccion',       null,   0, null],
        // Cosecha y empaque — rubro se calcula por cultivo
        ['Cosecha',                   'cosecha_empaque',  null,   1, 'cajon'],
        ['Empaque',                   'cosecha_empaque',  null,   0, null],
        // Generales — rubro fijo
        ['Mantenimiento general',     'general',          gralId, 0, null],
        ['Limpieza de galpones',      'general',          gralId, 0, null],
      ];
      const ins = db.prepare("INSERT INTO pa_tareas_tipos (nombre, tipo_labor, rubro_contable_id, es_destajo, unidad_destajo) VALUES (?,?,?,?,?)");
      for (const [n, t, r, d, u] of tareas) ins.run(n, t, r, d, u);
      console.log(`[PA] ${tareas.length} tipos de tarea creados`);
    }
  } catch(e) { console.error('[PA] Error seed tareas:', e.message); }
})();

// ── SEED: Tractores iniciales (todos gasoleros, con horómetro) ─────────────
(function seedTractoresIniciales() {
  try {
    const TRACTORES = [
      'NEW HOLLAND N°6',
      'MASSEY N°7',
      'NEW HOLLAND N°2 (A)',
      'NEW HOLLAND N°2 (B)',
      'NEW HOLLAND N°1',
      'DEUTZ N°3',
      'AGCO ALLIS N°5',
      'NEW HOLLAND N°4 (A)',
      'DEUTZ N°8',
      'NEW HOLLAND N°4 (B)',
    ];

    // Parser de marca: extrae la marca del inicio del nombre
    function marcaDelNombre(n) {
      const up = n.toUpperCase();
      if (up.startsWith('NEW HOLLAND')) return 'New Holland';
      if (up.startsWith('MASSEY')) return 'Massey Ferguson';
      if (up.startsWith('DEUTZ')) return 'Deutz';
      if (up.startsWith('AGCO ALLIS')) return 'AGCO Allis';
      return null;
    }

    const check = db.prepare("SELECT id FROM pa_vehiculos WHERE identificacion = ?");
    const ins = db.prepare(`INSERT INTO pa_vehiculos
      (tipo, identificacion, marca_modelo, combustible, tiene_horometro, horas_actuales, notas)
      VALUES ('tractor', ?, ?, 'gasoil', 1, 0, ?)`);

    let nuevos = 0;
    for (const nombre of TRACTORES) {
      if (check.get(nombre)) continue;  // ya existe, no duplicar
      ins.run(nombre, marcaDelNombre(nombre), 'Importado desde planilla inicial');
      nuevos++;
    }
    if (nuevos > 0) console.log(`[PA] ${nuevos} tractores creados`);
  } catch(e) { console.error('[PA] Error seed tractores:', e.message); }
})();

// ═════════════════════════════════════════════════════════════════════════
// RESET ÚNICO: vaciar insumos / compras / costos / movimientos / combustible
//              / personal (transaccional). Usa flag en sistema_flags para
//              ejecutarse UNA SOLA VEZ, sin importar cuántos deploys vengan.
// ═════════════════════════════════════════════════════════════════════════
(function resetInsumosComprasV1() {
  const FLAG_KEY = 'reset_insumos_compras_v1';
  try {
    // Crear tabla de flags si no existe
    db.exec(`
      CREATE TABLE IF NOT EXISTS sistema_flags (
        key         TEXT PRIMARY KEY,
        valor       TEXT,
        ejecutado_en TEXT DEFAULT (datetime('now','localtime'))
      );
    `);

    // Si la flag ya existe, salir en silencio — ya se ejecutó antes
    const existe = db.prepare("SELECT key FROM sistema_flags WHERE key = ?").get(FLAG_KEY);
    if (existe) return;

    console.log('[RESET] Ejecutando reset de insumos/compras/costos (flag: ' + FLAG_KEY + ')');

    // Backup de seguridad antes del borrado — en el mismo volume de Railway
    try {
      const dbPathVal = '/app/data/clientes.db';
      const backupDir = '/app/data/backups';
      if (fs.existsSync(dbPathVal)) {
        fs.mkdirSync(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupPath = path.join(backupDir, 'pre-reset-' + stamp + '.db');
        fs.copyFileSync(dbPathVal, backupPath);
        console.log('[RESET] Backup creado en ' + backupPath);
      }
    } catch(e) {
      console.warn('[RESET] No se pudo crear backup (continuando igual):', e.message);
    }

    // Tablas a vaciar — en orden seguro (hijas primero para evitar FK issues)
    const TABLAS_A_VACIAR = [
      // (Personal legacy partes/fichajes: tablas eliminadas — ya no se vacían)
      // Combustible
      'pa_combustible_movimientos',
      // Stock y órdenes — hijas → padres
      'pa_aplicaciones',
      'pa_ordenes_items',
      'pa_ordenes_lotes',
      'pa_ordenes',
      'pa_movimientos_stock',
      'pa_costos_lote',
      // Compras
      'pa_compras_items',
      'pa_compras',
      // Maestro de insumos (al final porque muchas tablas lo referenciaban)
      'pa_insumos',
    ];

    // Desactivar FK temporalmente por seguridad
    db.pragma('foreign_keys = OFF');

    const tx = db.transaction(() => {
      let totalFilas = 0;
      let tablasOk = 0;
      const contados = {};

      for (const t of TABLAS_A_VACIAR) {
        try {
          // Chequear que la tabla exista (por si se deploya en DB sin alguna tabla)
          const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
          if (!exists) continue;
          const n = db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get().n;
          db.prepare(`DELETE FROM ${t}`).run();
          // Reset autoincrement para que los IDs vuelvan a empezar desde 1
          try { db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(t); } catch(e) {}
          contados[t] = n;
          totalFilas += n;
          tablasOk++;
        } catch(e) {
          console.error(`[RESET] Error vaciando ${t}:`, e.message);
          throw e; // aborta la transacción entera
        }
      }

      // Resetear stock de tanques de combustible a 0 (sin borrar los tanques)
      try {
        const nTanq = db.prepare("SELECT COUNT(*) as n FROM pa_combustible_tanques WHERE stock_actual != 0").get().n;
        if (nTanq > 0) {
          db.prepare("UPDATE pa_combustible_tanques SET stock_actual = 0").run();
          console.log(`[RESET] ${nTanq} tanque(s) con stock reseteado a 0`);
        }
      } catch(e) { /* tabla puede no existir */ }

      // Resetear stock de insumos (por si algún INSERT futuro trae stock) — ya está vacía igual
      // Marcar la flag como ejecutada
      db.prepare("INSERT INTO sistema_flags (key, valor) VALUES (?, ?)")
        .run(FLAG_KEY, JSON.stringify({ total_filas: totalFilas, tablas: contados }));

      console.log(`[RESET] Vaciadas ${tablasOk} tablas. Total filas eliminadas: ${totalFilas}`);
      for (const [t, n] of Object.entries(contados)) {
        if (n > 0) console.log(`[RESET]   · ${t}: ${n} filas`);
      }
    });

    tx();
    db.pragma('foreign_keys = ON');
    console.log('[RESET] Completado — flag grabada, no se vuelve a ejecutar');

  } catch(e) {
    console.error('[RESET] ERROR, datos NO fueron borrados (transacción revertida):', e.message);
    try { db.pragma('foreign_keys = ON'); } catch(e2) {}
  }
})();

// ── PLAN DE CUENTAS — schema + seed + log auditoría ────────────────────────
// Maestro contable jerárquico (secciones → cuentas) + tabla central de
// movimientos contables + log de cambios. Usado por el módulo de costos.
// Idempotente: el seed solo se ejecuta si no hay secciones cargadas.
(function migrarPlanDeCuentas() {
  // 1) Secciones del plan de cuentas
  db.exec(`
    CREATE TABLE IF NOT EXISTS pa_cuentas_secciones (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo          INTEGER NOT NULL UNIQUE,
      nombre          TEXT NOT NULL,
      orden           INTEGER NOT NULL DEFAULT 0,
      activo          INTEGER NOT NULL DEFAULT 1,
      creado_en       TEXT DEFAULT (datetime('now','localtime')),
      actualizado_en  TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  // 2) Plan de cuentas
  db.exec(`
    CREATE TABLE IF NOT EXISTS pa_cuentas (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo            TEXT NOT NULL UNIQUE,
      nombre            TEXT NOT NULL,
      seccion_id        INTEGER NOT NULL REFERENCES pa_cuentas_secciones(id),
      tipo              TEXT NOT NULL DEFAULT 'resultado',
      permite_lote      INTEGER NOT NULL DEFAULT 0,
      permite_campania  INTEGER NOT NULL DEFAULT 0,
      es_sistema        INTEGER NOT NULL DEFAULT 0,
      orden             INTEGER NOT NULL DEFAULT 0,
      activo            INTEGER NOT NULL DEFAULT 1,
      creado_en         TEXT DEFAULT (datetime('now','localtime')),
      actualizado_en    TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_pa_cuentas_seccion ON pa_cuentas(seccion_id);
    CREATE INDEX IF NOT EXISTS idx_pa_cuentas_codigo  ON pa_cuentas(codigo);
  `);

  // 3) Movimientos contables (fuente única de verdad para reportes)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pa_movimientos_contables (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha         TEXT NOT NULL,
      cuenta_id     INTEGER NOT NULL REFERENCES pa_cuentas(id),
      lote_id       INTEGER,
      campania_id   INTEGER,
      cultivo_id    INTEGER,
      monto         REAL NOT NULL,
      descripcion   TEXT,
      origen_tipo   TEXT NOT NULL,
      origen_id     INTEGER,
      usuario_id    INTEGER,
      anulado       INTEGER NOT NULL DEFAULT 0,
      creado_en     TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_mov_fecha     ON pa_movimientos_contables(fecha);
    CREATE INDEX IF NOT EXISTS idx_mov_cuenta    ON pa_movimientos_contables(cuenta_id);
    CREATE INDEX IF NOT EXISTS idx_mov_lote      ON pa_movimientos_contables(lote_id);
    CREATE INDEX IF NOT EXISTS idx_mov_campania  ON pa_movimientos_contables(campania_id);
    CREATE INDEX IF NOT EXISTS idx_mov_origen    ON pa_movimientos_contables(origen_tipo, origen_id);
    CREATE INDEX IF NOT EXISTS idx_mov_anulado   ON pa_movimientos_contables(anulado);
  `);

  // 4) Log de auditoría del plan de cuentas
  db.exec(`
    CREATE TABLE IF NOT EXISTS pa_cuentas_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cuenta_id   INTEGER,
      seccion_id  INTEGER,
      accion      TEXT NOT NULL,
      detalle     TEXT,
      usuario_id  INTEGER,
      creado_en   TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_cuentas_log_cuenta  ON pa_cuentas_log(cuenta_id);
    CREATE INDEX IF NOT EXISTS idx_cuentas_log_seccion ON pa_cuentas_log(seccion_id);
    CREATE INDEX IF NOT EXISTS idx_cuentas_log_fecha   ON pa_cuentas_log(creado_en);
  `);

  // 5) ALTERs en pa_insumos: cuenta_id + flags de mapeo automático
  const colsInsumos = db.prepare("PRAGMA table_info(pa_insumos)").all().map(c => c.name);
  if (!colsInsumos.includes('cuenta_id')) {
    db.exec("ALTER TABLE pa_insumos ADD COLUMN cuenta_id INTEGER REFERENCES pa_cuentas(id)");
    console.log('[PA] pa_insumos.cuenta_id agregada');
  }
  if (!colsInsumos.includes('es_fertilizante')) {
    db.exec("ALTER TABLE pa_insumos ADD COLUMN es_fertilizante INTEGER DEFAULT 0");
    console.log('[PA] pa_insumos.es_fertilizante agregada');
  }
  if (!colsInsumos.includes('es_semilla')) {
    db.exec("ALTER TABLE pa_insumos ADD COLUMN es_semilla INTEGER DEFAULT 0");
    console.log('[PA] pa_insumos.es_semilla agregada');
  }
  if (!colsInsumos.includes('es_cinta_manguera')) {
    db.exec("ALTER TABLE pa_insumos ADD COLUMN es_cinta_manguera INTEGER DEFAULT 0");
    console.log('[PA] pa_insumos.es_cinta_manguera agregada');
  }

  // 6) Seed inicial — solo si está vacío
  const cantSec = db.prepare('SELECT COUNT(*) as c FROM pa_cuentas_secciones').get().c;
  if (cantSec > 0) return;

  const secciones = [
    [1, 'COSTO DE PRODUCCION'],
    [2, 'COSTO ASOCIADO A VENTAS - MERCADO'],
    [3, 'COSTO ASOCIADO A VENTAS - INDUSTRIA'],
    [4, 'COSTOS FIJOS'],
    [5, 'COSTOS FINANCIEROS'],
    [6, 'COSTOS IMPOSITIVOS'],
    [7, 'INVERSIONES'],
  ];

  const insSec = db.prepare(`
    INSERT INTO pa_cuentas_secciones (codigo, nombre, orden, activo)
    VALUES (?, ?, ?, 1)
  `);
  const seccionIds = {};
  for (const [codigo, nombre] of secciones) {
    const r = insSec.run(codigo, nombre, codigo);
    seccionIds[codigo] = r.lastInsertRowid;
  }

  // [seccion, codigo, nombre, permite_lote, permite_camp, tipo, es_sistema]
  const cuentas = [
    // SECCION 1 — COSTO DE PRODUCCION
    [1, '1.01', 'MO PRODUCCION GENERAL',          1, 1, 'resultado', 1],
    [1, '1.05', 'MO PRODUCCION UVA',              1, 1, 'resultado', 0],
    [1, '1.10', 'MO PRODUCCION MELON',            1, 1, 'resultado', 0],
    [1, '1.15', 'MO PRODUCCION MELON TARDIO',     1, 1, 'resultado', 0],
    [1, '1.20', 'MO PRODUCCION DAMASCO',          1, 1, 'resultado', 0],
    [1, '1.25', 'MO PRODUCCION DURAZNO',          1, 1, 'resultado', 0],
    [1, '1.30', 'MO PRODUCCION CEBOLLA',          1, 1, 'resultado', 0],
    [1, '1.35', 'MO PRODUCCION BROCOLI',          1, 1, 'resultado', 0],
    [1, '1.40', 'MO PRODUCCION INDUSTRIA',        1, 1, 'resultado', 0],
    [1, '1.50', 'ABONOS Y FERTILIZANTES',         1, 1, 'resultado', 1],
    [1, '1.55', 'COMPRA DE SEMILLAS',             1, 1, 'resultado', 1],
    [1, '1.60', 'PLANTINES - CONFECCION',         1, 1, 'resultado', 0],
    [1, '1.65', 'INSUMOS',                        1, 1, 'resultado', 1],
    [1, '1.70', 'CINTAS Y MANGUERAS',             1, 1, 'resultado', 1],
    [1, '1.75', 'ALQUILER DE MAQUINARIA',         1, 1, 'resultado', 0],
    [1, '1.80', 'Electricidad',                   1, 1, 'resultado', 0],
    [1, '1.85', 'Combustibles y Lubricantes',     1, 1, 'resultado', 1],

    // SECCION 2 — COSTO ASOCIADO A VENTAS - MERCADO
    [2, '2.01', 'MO COSH Y EMP GENERAL',          1, 1, 'resultado', 1],
    [2, '2.05', 'MO COSH Y EMP UVA',              1, 1, 'resultado', 0],
    [2, '2.10', 'MO COSH Y EMP MELON',            1, 1, 'resultado', 0],
    [2, '2.15', 'MO COSH Y EMP MELON TARDIO',     1, 1, 'resultado', 0],
    [2, '2.20', 'MO COSH Y EMP DAMASCO',          1, 1, 'resultado', 0],
    [2, '2.25', 'MO COSH Y EMP CEBOLLA',          1, 1, 'resultado', 0],
    [2, '2.40', 'ENVASES',                        1, 1, 'resultado', 0],
    [2, '2.45', 'INSUMOS EMPAQUE',                1, 1, 'resultado', 0],
    [2, '2.50', 'CUADRILLAS EMPAQUE',             1, 1, 'resultado', 0],
    [2, '2.55', 'ALQUILER MAQUINARIA EMPAQUE',    1, 1, 'resultado', 0],
    [2, '2.60', 'REPARACION Y MANT. EMPAQUE',     1, 1, 'resultado', 0],
    [2, '2.70', 'Fletes',                         1, 1, 'resultado', 0],
    [2, '2.75', 'Fletes de Importacion',          1, 1, 'resultado', 0],

    // SECCION 3 — COSTO ASOCIADO A VENTAS - INDUSTRIA
    [3, '3.01', 'MO COSH TOMATE INDUSTRIA',       1, 1, 'resultado', 0],
    [3, '3.05', 'COSECHA MEC Y GASTOS INDUSTRIA', 1, 1, 'resultado', 0],

    // SECCION 4 — COSTOS FIJOS
    [4, '4.01', 'MO GENERALES',                       0, 0, 'resultado', 0],
    [4, '4.05', 'CUADRILLAS',                         0, 0, 'resultado', 0],
    [4, '4.10', 'HONORARIOS',                         0, 0, 'resultado', 0],
    [4, '4.15', 'CONTRIBUCIONES SOCIALES',            0, 0, 'resultado', 0],
    [4, '4.20', 'ART',                                0, 0, 'resultado', 0],
    [4, '4.25', 'Contribucion Renatre',               0, 0, 'resultado', 0],
    [4, '4.30', 'Seguro colectivo de vida',           0, 0, 'resultado', 0],
    [4, '4.35', 'Indemnizaciones y Despidos',         0, 0, 'resultado', 0],
    [4, '4.40', 'SEGUROS',                            0, 0, 'resultado', 0],
    [4, '4.45', 'ALQUILER FINCAS',                    0, 0, 'resultado', 0],
    [4, '4.50', 'GASTOS REPARACION Y MANTENIMIENTO',  0, 0, 'resultado', 0],
    [4, '4.55', 'Gastos mantenimiento vehiculos',     0, 0, 'resultado', 0],
    [4, '4.60', 'Gasto Hidraulica',                   0, 0, 'resultado', 0],
    [4, '4.65', 'GASTOS GENERALES',                   0, 0, 'resultado', 0],
    [4, '4.70', 'GASTOS OFICINA',                     0, 0, 'resultado', 0],
    [4, '4.75', 'Gastos Articulos de limpieza',       0, 0, 'resultado', 0],
    [4, '4.80', 'Gastos Movilidad y Viaticos',        0, 0, 'resultado', 0],
    [4, '4.85', 'Conceptos No Gravados',              0, 0, 'resultado', 0],
    [4, '4.90', 'Gastos Varios',                      0, 0, 'resultado', 0],

    // SECCION 5 — COSTOS FINANCIEROS
    [5, '5.01', 'Interes Prestam p/ capital de Trab', 0, 0, 'resultado', 0],
    [5, '5.05', 'Interes Prestamos p/ Inversiones',   0, 0, 'resultado', 0],
    [5, '5.10', 'Intereses por Descubierto',          0, 0, 'resultado', 0],
    [5, '5.15', 'Intereses dsto Valores',             0, 0, 'resultado', 0],
    [5, '5.20', 'Intereses Resarcitorios',            0, 0, 'resultado', 0],
    [5, '5.25', 'Intereses Planes de Pagos Afip',     0, 0, 'resultado', 0],
    [5, '5.30', 'Gastos de Financiacion',             0, 0, 'resultado', 0],
    [5, '5.35', 'Gastos Bancarios',                   0, 0, 'resultado', 0],
    [5, '5.40', 'Gastos Bancarios Cierre de Cam',     0, 0, 'resultado', 0],
    [5, '5.45', 'Comision x Nominadas pago Impor',    0, 0, 'resultado', 0],
    [5, '5.50', 'Fondo Comun Inver - Santander',      0, 0, 'resultado', 0],

    // SECCION 6 — COSTOS IMPOSITIVOS
    [6, '6.01', 'Imp. Sellos',                                     0, 0, 'resultado', 0],
    [6, '6.05', 'Impuesto sobre los Ingresos Br',                  0, 0, 'resultado', 0],
    [6, '6.10', 'Impuesto pais',                                   0, 0, 'resultado', 0],
    [6, '6.15', 'Adicional LH',                                    0, 0, 'resultado', 0],
    [6, '6.20', 'Gasto Aduanero - Arancel ss extraor',             0, 0, 'resultado', 0],
    [6, '6.25', 'IMPUESTO INMOBILIARIO',                           0, 0, 'resultado', 0],
    [6, '6.30', 'Patentes',                                        0, 0, 'resultado', 0],
    [6, '6.35', 'Tasa Maria',                                      0, 0, 'resultado', 0],
    [6, '6.40', 'Multas Afip',                                     0, 0, 'resultado', 0],
    [6, '6.45', 'Detraccion art 23 ley 27541 / Dto 438-23',        0, 0, 'resultado', 0],
    [6, '6.50', 'Desc obtenidos IIBB',                             0, 0, 'resultado', 0],
    [6, '6.55', 'Decreto 814',                                     0, 0, 'resultado', 0],
    [6, '6.60', 'VENTAS',                                          0, 0, 'resultado', 0],
    [6, '6.65', 'DDJJ IGA 2024',                                   0, 0, 'resultado', 0],
    [6, '6.70', 'BIENES ACCIONES Y PARTICIPACIONES 2024',          0, 0, 'resultado', 0],

    // SECCION 7 — INVERSIONES (patrimonial)
    [7, '7.01', 'INVERSIONES',                                     0, 0, 'patrimonial', 0],
  ];

  const insCuenta = db.prepare(`
    INSERT INTO pa_cuentas
      (codigo, nombre, seccion_id, tipo, permite_lote, permite_campania, es_sistema, orden, activo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  let orden = 0;
  const tx = db.transaction(() => {
    for (const [seccion, codigo, nombre, lote, camp, tipo, sistema] of cuentas) {
      orden += 10;
      insCuenta.run(codigo, nombre, seccionIds[seccion], tipo, lote, camp, sistema, orden);
    }
  });
  tx();

  console.log(`[PA] Plan de cuentas: ${secciones.length} secciones + ${cuentas.length} cuentas cargadas`);
})();

// ── MIGRACIÓN: rename "Mejoramiento de Suelo" → "Mejor. Suelo" ─────────────
// Idempotente: solo actualiza si encuentra registros con el nombre viejo.
(function migrarRenameMejorSuelo() {
  try {
    const existe = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pa_cultivos_lote'").get();
    if (!existe) return;
    const r = db.prepare("UPDATE pa_cultivos_lote SET cultivo = 'Mejor. Suelo' WHERE cultivo = 'Mejoramiento de Suelo'").run();
    if (r.changes > 0) {
      console.log(`[PA] Renombrados ${r.changes} cultivos: 'Mejoramiento de Suelo' → 'Mejor. Suelo'`);
    }
  } catch(e) {
    console.warn('[PA] Error migrando rename Mejor. Suelo:', e.message);
  }
})();

// ── MIGRACIÓN: rename "Uva Vitoria" → "Uva Victoria" ──────────────────────
// Idempotente: solo actualiza si encuentra registros con el nombre viejo.
(function migrarRenameUvaVictoria() {
  try {
    const existe = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pa_cultivos_lote'").get();
    if (!existe) return;
    const r = db.prepare("UPDATE pa_cultivos_lote SET cultivo = 'Uva Victoria' WHERE cultivo = 'Uva Vitoria'").run();
    if (r.changes > 0) {
      console.log(`[PA] Renombrados ${r.changes} cultivos: 'Uva Vitoria' → 'Uva Victoria'`);
    }
  } catch(e) {
    console.warn('[PA] Error migrando rename Uva Victoria:', e.message);
  }
})();

// ── MIGRACIÓN: hectareas_sembradas en pa_cultivos_lote ────────────────────
// Permite override de las hectáreas del lote para una campaña específica
// (ej: lote de 10ha pero solo se siembran 6ha de melón en 26/27).
// NULL = usar lote.hectareas (comportamiento default histórico).
(function migrarHectareasSembradas() {
  try {
    const existe = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pa_cultivos_lote'").get();
    if (!existe) return;
    const cols = db.prepare("PRAGMA table_info(pa_cultivos_lote)").all().map(c => c.name);
    if (!cols.includes('hectareas_sembradas')) {
      db.exec("ALTER TABLE pa_cultivos_lote ADD COLUMN hectareas_sembradas REAL");
      console.log("[PA] Columna hectareas_sembradas agregada en pa_cultivos_lote");
    }
  } catch(e) {
    console.warn('[PA] Error migrando hectareas_sembradas:', e.message);
  }
})();

// ── MIGRACIÓN: en_desarrollo + productividad_pct en pa_cultivos_lote ──────
// Solo aplica a frutales. en_desarrollo=1 indica que el lote no está al 100%
// productivo en esa campaña. productividad_pct (0-100) es la expectativa
// productiva relativa a un lote maduro. NULL/0 = maduro al 100%.
(function migrarEnDesarrollo() {
  try {
    const existe = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pa_cultivos_lote'").get();
    if (!existe) return;
    const cols = db.prepare("PRAGMA table_info(pa_cultivos_lote)").all().map(c => c.name);
    if (!cols.includes('en_desarrollo')) {
      db.exec("ALTER TABLE pa_cultivos_lote ADD COLUMN en_desarrollo INTEGER DEFAULT 0");
      console.log("[PA] Columna en_desarrollo agregada en pa_cultivos_lote");
    }
    if (!cols.includes('productividad_pct')) {
      db.exec("ALTER TABLE pa_cultivos_lote ADD COLUMN productividad_pct INTEGER");
      console.log("[PA] Columna productividad_pct agregada en pa_cultivos_lote");
    }
  } catch(e) {
    console.warn('[PA] Error migrando en_desarrollo/productividad_pct:', e.message);
  }
})();

// ─────────────────────────────────────────────────────────────────────────
// PAÑOL — herramientas durables identificadas por unidad
// (no son consumibles; se prestan/devuelven en lugar de gastarse)
// ─────────────────────────────────────────────────────────────────────────
db.exec(`
  -- Categorías para agrupar herramientas (Eléctricas, Manuales, Medición, etc.)
  CREATE TABLE IF NOT EXISTS pa_panol_categorias (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,
    icono  TEXT,                       -- emoji opcional para UI
    activo INTEGER DEFAULT 1,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Cada herramienta es UNA unidad física identificable
  CREATE TABLE IF NOT EXISTS pa_panol_unidades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo_interno  TEXT NOT NULL UNIQUE,             -- ej: PAÑ-0042 o AMOL-001
    nombre          TEXT NOT NULL,                    -- ej: Amoladora 4½'' Bosch
    categoria_id    INTEGER REFERENCES pa_panol_categorias(id),
    marca           TEXT,
    modelo          TEXT,
    numero_serie    TEXT,                             -- serial del fabricante (no único, puede faltar)
    compra_id       INTEGER REFERENCES pa_compras(id),-- vínculo opcional con factura origen
    precio_compra   REAL,                             -- pesos al momento de compra
    fecha_alta      TEXT DEFAULT (date('now','localtime')),
    fecha_baja      TEXT,
    estado          TEXT NOT NULL DEFAULT 'disponible'
                      CHECK(estado IN ('disponible','prestada','en_reparacion','dada_de_baja','extraviada')),
    ubicacion_actual TEXT,                            -- texto libre: "Estante A2", "Con Juan", etc.
    personal_actual_id INTEGER REFERENCES pa_personal(id),       -- quién tiene la herramienta (FK denormalizada)
    notas           TEXT,
    activo          INTEGER DEFAULT 1,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_panol_unidades_estado ON pa_panol_unidades(estado);
  -- NOTA: el índice de personal_actual_id NO va acá. En DBs existentes la tabla ya
  -- existe (CREATE IF NOT EXISTS = no-op) y la columna recién la agrega el ALTER de
  -- unificarPadronPersonal() más abajo → crear el índice acá rompía el boot (#299).

  -- Movimientos: préstamo, devolución, reparación, baja, alta
  CREATE TABLE IF NOT EXISTS pa_panol_movimientos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    unidad_id       INTEGER NOT NULL REFERENCES pa_panol_unidades(id),
    tipo            TEXT NOT NULL
                      CHECK(tipo IN ('alta','prestamo','devolucion','reparacion_inicio','reparacion_fin','baja','extravio')),
    fecha           TEXT DEFAULT (datetime('now','localtime')),
    personal_id     INTEGER REFERENCES pa_personal(id),      -- a quién (en préstamo/devolución)
    quien_registra  INTEGER REFERENCES usuarios(id),         -- usuario que carga el movimiento (tabla real: usuarios)
    condicion       TEXT,                                    -- 'nueva','buena','regular','rota' (al prestar o devolver)
    motivo          TEXT,                                    -- para baja/extravio: motivo libre
    notas           TEXT,
    lat REAL, lng REAL                                       -- captura GPS si vino del Scout
  );
  CREATE INDEX IF NOT EXISTS idx_panol_mov_unidad ON pa_panol_movimientos(unidad_id);
  CREATE INDEX IF NOT EXISTS idx_panol_mov_fecha ON pa_panol_movimientos(fecha);
`);

// ── UNIFICACIÓN de padrón: pa_personal absorbe a pa_trabajadores (deprecado) ──
// pa_trabajadores quedó VACÍO en prod (0 filas, confirmado) y sin referencias vivas
// salvo Pañol. Corre acá (después de crear Pañol) y es idempotente:
//  (1) grupo_id en pa_personal;
//  (2) columnas personal_* en Pañol (las viejas trabajador_* quedan muertas → siempre
//      NULL, su FK colgante a pa_trabajadores nunca se evalúa);
//  (3) DROP de pa_trabajadores.
(function unificarPadronPersonal() {
  try {
    const colsP = db.prepare("PRAGMA table_info(pa_personal)").all().map(c => c.name);
    if (!colsP.includes('grupo_id')) {
      db.exec("ALTER TABLE pa_personal ADD COLUMN grupo_id INTEGER REFERENCES pa_grupos(id)");
      console.log('[PA] pa_personal.grupo_id agregado');
    }
    const colsU = db.prepare("PRAGMA table_info(pa_panol_unidades)").all().map(c => c.name);
    if (!colsU.includes('personal_actual_id')) {
      db.exec("ALTER TABLE pa_panol_unidades ADD COLUMN personal_actual_id INTEGER REFERENCES pa_personal(id)");
      console.log('[PA] pa_panol_unidades.personal_actual_id agregado');
    }
    // Índice acá (no en el schema template), ya con la columna garantizada en cualquier
    // DB. IF NOT EXISTS → idempotente y sirve tanto a DBs frescas como existentes.
    db.exec("CREATE INDEX IF NOT EXISTS idx_panol_unidades_personal ON pa_panol_unidades(personal_actual_id)");
    const colsM = db.prepare("PRAGMA table_info(pa_panol_movimientos)").all().map(c => c.name);
    if (!colsM.includes('personal_id')) {
      db.exec("ALTER TABLE pa_panol_movimientos ADD COLUMN personal_id INTEGER REFERENCES pa_personal(id)");
      console.log('[PA] pa_panol_movimientos.personal_id agregado');
    }
    // ── FIX FK colgantes en Pañol ─────────────────────────────────────────────
    // Una FK cuya tabla destino NO existe rompe CUALQUIER INSERT en esa tabla con
    // "no such table: …" AUNQUE el valor sea NULL (SQLite resuelve la tabla padre al
    // ejecutar el DML, no según el valor). Dos causas en Pañol:
    //   (a) trabajador_actual_id / trabajador_id → pa_trabajadores (dropeada en #299).
    //   (b) quien_registra → users (typo: la tabla real es 'usuarios'); afectaba hasta
    //       a DBs frescas. Se repunta a usuarios(id) en el DDL nuevo (no se elimina:
    //       registra quién cargó el movimiento). El #372 anterior arregló (a) pero
    //       arrastró (b) en el DDL del rebuild → este fix lo corrige.
    // Rebuild robusto: FK off → tabla nueva con el DDL correcto (sin trabajador_*,
    // quien_registra→usuarios) → copia de columnas comunes (preserva filas y datos de
    // personal_*) → drop → rename → recrea índices vivos (NO idx_panol_unidades_trab).
    // Guardado por un detector genérico de FK colgantes (ver abajo): idempotente,
    // se auto-cura, y en DBs ya sanas es no-op.
    const rebuildPanol = (tabla, crearSql, indices) => {
      db.exec(crearSql); // crea `${tabla}__new`
      const viejas = new Set(db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name));
      const comunes = db.prepare(`PRAGMA table_info(${tabla}__new)`).all()
        .map(c => c.name).filter(c => viejas.has(c)).join(', ');
      db.exec(`INSERT INTO ${tabla}__new (${comunes}) SELECT ${comunes} FROM ${tabla}`);
      db.exec(`DROP TABLE ${tabla}`);
      db.exec(`ALTER TABLE ${tabla}__new RENAME TO ${tabla}`);
      for (const ix of indices) db.exec(ix);
    };

    // Detector GENÉRICO de FK colgantes: una FK cuya tabla destino no existe rompe
    // TODO INSERT en la tabla (aunque el valor sea NULL). Cubre de una las dos causas
    // en Pañol — trabajador_* → pa_trabajadores (dropeada en #299) y quien_registra →
    // users (nunca existió; la tabla real es 'usuarios') — y se auto-cura si una corrida
    // previa dejó alguna colgante. Idempotente: tras el rebuild ya no hay colgante → no-op.
    const existeTabla = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    const tieneFKColgante = (tabla) =>
      db.prepare(`PRAGMA foreign_key_list(${tabla})`).all().some(fk => !existeTabla(fk.table));

    db.pragma('foreign_keys = OFF');
    if (tieneFKColgante('pa_panol_unidades')) {
      db.transaction(() => rebuildPanol('pa_panol_unidades', `
        CREATE TABLE pa_panol_unidades__new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          codigo_interno  TEXT NOT NULL UNIQUE,
          nombre          TEXT NOT NULL,
          categoria_id    INTEGER REFERENCES pa_panol_categorias(id),
          marca           TEXT,
          modelo          TEXT,
          numero_serie    TEXT,
          compra_id       INTEGER REFERENCES pa_compras(id),
          precio_compra   REAL,
          fecha_alta      TEXT DEFAULT (date('now','localtime')),
          fecha_baja      TEXT,
          estado          TEXT NOT NULL DEFAULT 'disponible'
                            CHECK(estado IN ('disponible','prestada','en_reparacion','dada_de_baja','extraviada')),
          ubicacion_actual TEXT,
          personal_actual_id INTEGER REFERENCES pa_personal(id),
          notas           TEXT,
          activo          INTEGER DEFAULT 1,
          creado_en       TEXT DEFAULT (datetime('now','localtime'))
        )`, [
        "CREATE INDEX IF NOT EXISTS idx_panol_unidades_estado   ON pa_panol_unidades(estado)",
        "CREATE INDEX IF NOT EXISTS idx_panol_unidades_personal ON pa_panol_unidades(personal_actual_id)",
      ]))();
      console.log('[PA] pa_panol_unidades rebuildeada (FK colgantes eliminadas)');
    }
    if (tieneFKColgante('pa_panol_movimientos')) {
      db.transaction(() => rebuildPanol('pa_panol_movimientos', `
        CREATE TABLE pa_panol_movimientos__new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          unidad_id       INTEGER NOT NULL REFERENCES pa_panol_unidades(id),
          tipo            TEXT NOT NULL
                            CHECK(tipo IN ('alta','prestamo','devolucion','reparacion_inicio','reparacion_fin','baja','extravio')),
          fecha           TEXT DEFAULT (datetime('now','localtime')),
          personal_id     INTEGER REFERENCES pa_personal(id),
          quien_registra  INTEGER REFERENCES usuarios(id),
          condicion       TEXT,
          motivo          TEXT,
          notas           TEXT,
          lat REAL, lng REAL
        )`, [
        "CREATE INDEX IF NOT EXISTS idx_panol_mov_unidad ON pa_panol_movimientos(unidad_id)",
        "CREATE INDEX IF NOT EXISTS idx_panol_mov_fecha  ON pa_panol_movimientos(fecha)",
      ]))();
      console.log('[PA] pa_panol_movimientos rebuildeada (FK colgantes eliminadas → usuarios/pa_personal)');
    }
    db.exec("DROP TABLE IF EXISTS pa_trabajadores");
    db.pragma('foreign_keys = ON');
  } catch (e) {
    try { db.pragma('foreign_keys = ON'); } catch (_) {}
    console.error('[PA] Error en unificación de padrón:', e.message);
  }
})();

// Seed de categorías base si tabla está vacía
(function seedPanolCategorias() {
  try {
    const n = db.prepare("SELECT COUNT(*) as n FROM pa_panol_categorias").get().n;
    if (n === 0) {
      const ins = db.prepare("INSERT INTO pa_panol_categorias (nombre, icono) VALUES (?, ?)");
      const seeds = [
        ['Eléctricas', '⚡'],
        ['Manuales',   '🔧'],
        ['Medición',   '📏'],
        ['Corte',      '✂️'],
        ['Seguridad',  '🦺'],
        ['Jardinería', '🌿'],
        ['Otros',      '🔩']
      ];
      const tx = db.transaction(() => seeds.forEach(s => ins.run(...s)));
      tx();
      console.log('[PA] Seed de categorías de pañol cargado:', seeds.length);
    }
  } catch(e) { console.warn('[PA] Error seeding pa_panol_categorias:', e.message); }
})();
// ── MÓDULO ASIENTOS CONTABLES (partida doble manual) ──────────────────────
db.exec(`
  -- Cabecera del asiento
  CREATE TABLE IF NOT EXISTS pa_asientos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha       TEXT NOT NULL DEFAULT (date('now','localtime')),
    descripcion TEXT NOT NULL,
    usuario_id  INTEGER REFERENCES usuarios(id),
    anulado     INTEGER DEFAULT 0,
    anulado_por INTEGER REFERENCES usuarios(id),
    anulado_en  TEXT,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Líneas del asiento (partida doble)
  CREATE TABLE IF NOT EXISTS pa_asientos_lineas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asiento_id  INTEGER NOT NULL REFERENCES pa_asientos(id),
    cuenta_id   INTEGER NOT NULL REFERENCES pa_cuentas(id),
    debe        REAL NOT NULL DEFAULT 0,
    haber       REAL NOT NULL DEFAULT 0,
    descripcion TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pa_asientos_fecha ON pa_asientos(fecha);
  CREATE INDEX IF NOT EXISTS idx_pa_asientos_lineas ON pa_asientos_lineas(asiento_id);
`);
// ── MIGRACIÓN: asignar grupo a secciones existentes ──────────────────────────
(function migrarGrupoSecciones() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_cuentas_secciones)").all().map(c => c.name);
    if (!cols.includes('grupo')) {
      db.exec("ALTER TABLE pa_cuentas_secciones ADD COLUMN grupo TEXT DEFAULT 'gastos'");
      console.log('[PA] grupo agregado en pa_cuentas_secciones');
    }
    // Las secciones existentes (1-7: costos) son todas Egresos
    // Si tienen grupo NULL o vacío, asignarlas a 'gastos'
    db.prepare("UPDATE pa_cuentas_secciones SET grupo='gastos' WHERE grupo IS NULL OR grupo=''").run();
    console.log('[PA] Grupos de secciones actualizados');
  } catch(e) { console.error('[PA] Error migrando grupos secciones:', e.message); }
})();
// Agrupa las secciones en los 5 grandes grupos del plan de cuentas clásico.
// Los valores válidos: 'activo' | 'pasivo' | 'patrimonio_neto' | 'ingresos' | 'gastos'
(function migrarGrupoSecciones() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_cuentas_secciones)").all().map(c => c.name);
    if (!cols.includes('grupo')) {
      db.exec("ALTER TABLE pa_cuentas_secciones ADD COLUMN grupo TEXT DEFAULT 'gastos'");
      console.log('[PA] pa_cuentas_secciones.grupo agregada (default: gastos)');
    }
    // Asignar grupos a las secciones existentes de Andy
    const asignaciones = [
      // [codigo_seccion, grupo]
      [1, 'gastos'],   // COSTO DE PRODUCCION
      [2, 'gastos'],   // COSTO ASOCIADO A VENTAS - MERCADO
      [3, 'gastos'],   // COSTO ASOCIADO A VENTAS - INDUSTRIA
      [4, 'gastos'],   // COSTOS FIJOS
      [5, 'gastos'],   // COSTOS FINANCIEROS
      [6, 'gastos'],   // COSTOS IMPOSITIVOS
      [7, 'patrimonio_neto'], // INVERSIONES
    ];
    const upd = db.prepare("UPDATE pa_cuentas_secciones SET grupo = ? WHERE codigo = ? AND grupo = 'gastos'");
    for (const [codigo, grupo] of asignaciones) {
      upd.run(grupo, codigo);
    }

    // Crear secciones de los grupos nuevos si no existen
    const nuevasSecciones = [
      [10, 'ACTIVO',         'activo'],
      [11, 'PASIVO',         'pasivo'],
      [12, 'INGRESOS',       'ingresos'],
    ];
    const insSeccion = db.prepare(`
      INSERT OR IGNORE INTO pa_cuentas_secciones (codigo, nombre, orden, activo, grupo)
      VALUES (?, ?, ?, 1, ?)
    `);
    for (const [codigo, nombre, grupo] of nuevasSecciones) {
      insSeccion.run(codigo, nombre, codigo, grupo);
    }
    console.log('[PA] Grupos contables asignados a secciones');
  } catch(e) { console.error('[PA] Error migrando grupos secciones:', e.message); }
})();

// ── MIGRACIÓN: padrón de proveedores contables ───────────────────────────
(function migrarAdmProveedores() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS adm_proveedores (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        razon_social     TEXT NOT NULL,
        nombre_comercial TEXT,
        cuit             TEXT,
        condicion_iva    TEXT DEFAULT 'responsable_inscripto',
        direccion        TEXT,
        telefono         TEXT,
        email            TEXT,
        rubro            TEXT,
        cbu              TEXT,
        alias_cbu        TEXT,
        condicion_pago   TEXT,
        contacto         TEXT,
        notas            TEXT,
        activo           INTEGER DEFAULT 1,
        creado_en        TEXT DEFAULT (datetime('now','localtime')),
        actualizado_en   TEXT DEFAULT (datetime('now','localtime'))
      )
    `);
    console.log('[ADM] Tabla adm_proveedores lista');
  } catch(e) { console.error('[ADM] Error creando adm_proveedores:', e.message); }
})();

// ── MIGRACIÓN: categoria en adm_proveedores ────────────────────────────────
// Clasifica proveedores por rubro/categoría. Se usa para identificar los
// proveedores de combustible (categoria='Combustible') en la vinculación de
// facturas con recargas del tanque. El campo arranca NULL; el admin lo marca.
(function migrarAdmProveedoresCategoria() {
  try {
    const cols = db.prepare("PRAGMA table_info(adm_proveedores)").all().map(c => c.name);
    if (!cols.includes('categoria')) {
      db.exec("ALTER TABLE adm_proveedores ADD COLUMN categoria TEXT");
      console.log("[ADM] categoria agregada en adm_proveedores");
    }
  } catch(e) { console.error('[ADM] Error migrando adm_proveedores categoria:', e.message); }
})();


// ── MIGRACIÓN: Asientos Modelo ────────────────────────────────────────────
(function migrarAsientosModelo() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS adm_asientos_modelo (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre      TEXT NOT NULL,
        descripcion TEXT,
        activo      INTEGER DEFAULT 1,
        creado_en   TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE IF NOT EXISTS adm_asientos_modelo_lineas (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        modelo_id   INTEGER NOT NULL REFERENCES adm_asientos_modelo(id) ON DELETE CASCADE,
        cuenta_id   INTEGER NOT NULL REFERENCES pa_cuentas(id),
        lado        TEXT NOT NULL CHECK(lado IN ('debe','haber')),
        descripcion TEXT,
        orden       INTEGER DEFAULT 0
      );
    `);
    // Agregar columna asiento_modelo_id a adm_proveedores si no existe
    const cols = db.prepare("PRAGMA table_info(adm_proveedores)").all();
    if (!cols.find(c => c.name === 'asiento_modelo_id')) {
      db.exec('ALTER TABLE adm_proveedores ADD COLUMN asiento_modelo_id INTEGER REFERENCES adm_asientos_modelo(id)');
    }
    // Agregar columna tipo_linea a adm_asientos_modelo_lineas si no existe
    const colsML = db.prepare("PRAGMA table_info(adm_asientos_modelo_lineas)").all();
    if (!colsML.find(c => c.name === 'tipo_linea')) {
      db.exec("ALTER TABLE adm_asientos_modelo_lineas ADD COLUMN tipo_linea TEXT NOT NULL DEFAULT 'libre'");
      console.log('[PA] tipo_linea agregado en adm_asientos_modelo_lineas');
    }
    // Agregar columna ref_compra_id a pa_asientos si no existe
    const colsA = db.prepare("PRAGMA table_info(pa_asientos)").all();
    if (!colsA.find(c => c.name === 'ref_compra_id')) {
      db.exec('ALTER TABLE pa_asientos ADD COLUMN ref_compra_id INTEGER');
    }
    if (!colsA.find(c => c.name === 'ref_codigo')) {
      db.exec("ALTER TABLE pa_asientos ADD COLUMN ref_codigo TEXT");
    }
    console.log('[ADM] Tablas asientos_modelo listas');
  } catch(e) { console.error('[ADM] Error migrando asientos_modelo:', e.message); }
})();

// ── MIGRACIÓN: tablas cuenta corriente y pagos a proveedores ─────────────────
(function() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pa_pagos_proveedores (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha         TEXT NOT NULL DEFAULT (date('now','localtime')),
        proveedor_id  INTEGER NOT NULL REFERENCES adm_proveedores(id),
        monto         REAL NOT NULL,
        forma_pago    TEXT NOT NULL DEFAULT 'transferencia',
        banco         TEXT,
        referencia    TEXT,
        notas         TEXT,
        usuario_id    INTEGER,
        anulado       INTEGER DEFAULT 0,
        creado_en     TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE IF NOT EXISTS pa_pagos_compras (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        pago_id     INTEGER NOT NULL REFERENCES pa_pagos_proveedores(id),
        compra_id   INTEGER NOT NULL REFERENCES pa_compras(id),
        monto       REAL NOT NULL
      );
    `);
    // Agregar columna saldo_pagado en pa_compras si no existe
    const colsC = db.prepare("PRAGMA table_info(pa_compras)").all().map(c => c.name);
    if (!colsC.includes('saldo_pagado')) {
      db.exec('ALTER TABLE pa_compras ADD COLUMN saldo_pagado REAL DEFAULT 0');
      console.log('[PA] saldo_pagado agregado en pa_compras');
    }
    console.log('[PA] Tablas pagos proveedores listas');
  } catch(e) { console.error('[PA] Error migrando pagos_proveedores:', e.message); }
})();

// ── MÓDULO CAJA Y BANCOS ──────────────────────────────────────────────────────
(function() {
  try {
    db.exec(`
      -- Cuentas bancarias y caja
      CREATE TABLE IF NOT EXISTS fin_cuentas (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre        TEXT NOT NULL,
        tipo          TEXT NOT NULL DEFAULT 'cuenta_corriente',
        banco         TEXT,
        nro_cuenta    TEXT,
        cbu           TEXT,
        alias         TEXT,
        moneda        TEXT NOT NULL DEFAULT 'ARS',
        saldo_inicial REAL NOT NULL DEFAULT 0,
        activo        INTEGER NOT NULL DEFAULT 1,
        creado_en     TEXT DEFAULT (datetime('now','localtime'))
      );

      -- Chequeras propias
      CREATE TABLE IF NOT EXISTS fin_chequeras (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        cuenta_id     INTEGER NOT NULL REFERENCES fin_cuentas(id),
        nro_chequera  TEXT,
        desde         INTEGER NOT NULL,
        hasta         INTEGER NOT NULL,
        activo        INTEGER NOT NULL DEFAULT 1,
        creado_en     TEXT DEFAULT (datetime('now','localtime'))
      );

      -- Cheques propios emitidos
      CREATE TABLE IF NOT EXISTS fin_cheques_propios (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        chequera_id     INTEGER NOT NULL REFERENCES fin_chequeras(id),
        nro_cheque      INTEGER NOT NULL,
        monto           REAL NOT NULL,
        beneficiario    TEXT,
        fecha_emision   TEXT NOT NULL DEFAULT (date('now','localtime')),
        fecha_vto       TEXT,
        estado          TEXT NOT NULL DEFAULT 'emitido',
        notas           TEXT,
        pago_id         INTEGER REFERENCES pa_pagos_proveedores(id),
        creado_en       TEXT DEFAULT (datetime('now','localtime'))
      );

      -- Cheques de terceros recibidos
      CREATE TABLE IF NOT EXISTS fin_cheques_terceros (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        banco           TEXT,
        nro_cheque      TEXT,
        librador        TEXT,
        monto           REAL NOT NULL,
        fecha_recepcion TEXT NOT NULL DEFAULT (date('now','localtime')),
        fecha_vto       TEXT,
        estado          TEXT NOT NULL DEFAULT 'en_cartera',
        cuenta_destino  INTEGER REFERENCES fin_cuentas(id),
        notas           TEXT,
        creado_en       TEXT DEFAULT (datetime('now','localtime'))
      );

      -- Movimientos de caja/bancos
      CREATE TABLE IF NOT EXISTS fin_movimientos (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        cuenta_id     INTEGER NOT NULL REFERENCES fin_cuentas(id),
        fecha         TEXT NOT NULL DEFAULT (date('now','localtime')),
        tipo          TEXT NOT NULL DEFAULT 'egreso',
        concepto      TEXT NOT NULL,
        monto         REAL NOT NULL,
        referencia    TEXT,
        pago_id       INTEGER REFERENCES pa_pagos_proveedores(id),
        cheque_id     INTEGER,
        usuario_id    INTEGER,
        creado_en     TEXT DEFAULT (datetime('now','localtime'))
      );
    `);
    console.log('[FIN] Tablas caja y bancos listas');
    // Agregar cuenta_contable_id si no existe
    const colsFin = db.prepare("PRAGMA table_info(fin_cuentas)").all().map(c => c.name);
    if (!colsFin.includes('cuenta_contable_id')) {
      db.exec('ALTER TABLE fin_cuentas ADD COLUMN cuenta_contable_id INTEGER REFERENCES pa_cuentas(id)');
      console.log('[FIN] cuenta_contable_id agregado en fin_cuentas');
    }
    // Ámbito de la caja: 'fiscal' (declarado, va a ARCA) o 'interno' (efectivo no declarado).
    // Solo aplica a cajas de efectivo; las cuentas bancarias son siempre fiscales.
    if (!colsFin.includes('ambito')) {
      db.exec("ALTER TABLE fin_cuentas ADD COLUMN ambito TEXT NOT NULL DEFAULT 'fiscal'");
      console.log('[FIN] ambito agregado en fin_cuentas');
    }
    const colsMov = db.prepare("PRAGMA table_info(fin_movimientos)").all().map(c => c.name);
    if (!colsMov.includes('conciliado')) {
      db.exec('ALTER TABLE fin_movimientos ADD COLUMN conciliado INTEGER NOT NULL DEFAULT 0');
      console.log('[FIN] conciliado agregado en fin_movimientos');
    }
    const colsCT = db.prepare("PRAGMA table_info(fin_cheques_terceros)").all().map(c => c.name);
    if (!colsCT.includes('cuenta_contable_id')) {
      db.exec('ALTER TABLE fin_cheques_terceros ADD COLUMN cuenta_contable_id INTEGER REFERENCES pa_cuentas(id)');
      console.log('[FIN] cuenta_contable_id agregado en fin_cheques_terceros');
    }
  } catch(e) { console.error('[FIN] Error migrando caja/bancos:', e.message); }
})();

// ── MÓDULO ÓRDENES DE PAGO ────────────────────────────────────────────────────
(function migrarOrdenesPago() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fin_ordenes_pago (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        numero          TEXT NOT NULL UNIQUE,
        fecha           TEXT NOT NULL DEFAULT (date('now','localtime')),
        proveedor_id    INTEGER NOT NULL REFERENCES adm_proveedores(id),
        monto_total     REAL NOT NULL,
        forma_pago      TEXT NOT NULL DEFAULT 'transferencia',
        cuenta_fin_id   INTEGER REFERENCES fin_cuentas(id),
        cheque_prop_id  INTEGER REFERENCES fin_cheques_propios(id),
        cheque_ter_id   INTEGER REFERENCES fin_cheques_terceros(id),
        referencia      TEXT,
        notas           TEXT,
        estado          TEXT NOT NULL DEFAULT 'emitida' CHECK(estado IN ('emitida','anulada')),
        movimiento_id   INTEGER REFERENCES fin_movimientos(id),
        usuario_id      INTEGER,
        creado_en       TEXT DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS fin_op_compras (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        op_id       INTEGER NOT NULL REFERENCES fin_ordenes_pago(id),
        compra_id   INTEGER NOT NULL REFERENCES pa_compras(id),
        monto       REAL NOT NULL
      );
    `);
    // Agregar asiento_id si no existe
    const colsOP = db.prepare("PRAGMA table_info(fin_ordenes_pago)").all().map(c => c.name);
    if (!colsOP.includes('asiento_id')) {
      db.exec('ALTER TABLE fin_ordenes_pago ADD COLUMN asiento_id INTEGER REFERENCES pa_asientos(id)');
      console.log('[FIN] asiento_id agregado en fin_ordenes_pago');
    }
    console.log('[FIN] Tablas órdenes de pago listas');
  } catch(e) { console.error('[FIN] Error migrando órdenes de pago:', e.message); }
})();

// ── MÓDULO CONCILIACIÓN BANCARIA ──────────────────────────────────────────────
(function migrarConciliacion() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fin_extracto_lineas (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        cuenta_id       INTEGER NOT NULL REFERENCES fin_cuentas(id),
        fecha           TEXT NOT NULL,
        concepto        TEXT,
        monto           REAL NOT NULL,
        tipo            TEXT NOT NULL DEFAULT 'egreso' CHECK(tipo IN ('ingreso','egreso')),
        referencia      TEXT,
        conciliado      INTEGER NOT NULL DEFAULT 0,
        movimiento_id   INTEGER REFERENCES fin_movimientos(id),
        periodo         TEXT,
        creado_en       TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE IF NOT EXISTS fin_conciliaciones (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        cuenta_id       INTEGER NOT NULL REFERENCES fin_cuentas(id),
        periodo         TEXT NOT NULL,
        fecha_cierre    TEXT,
        saldo_extracto  REAL,
        saldo_libros    REAL,
        diferencia      REAL,
        estado          TEXT NOT NULL DEFAULT 'abierta' CHECK(estado IN ('abierta','cerrada')),
        notas           TEXT,
        usuario_id      INTEGER,
        creado_en       TEXT DEFAULT (datetime('now','localtime'))
      );
    `);
    console.log('[FIN] Tablas conciliación listas');
  } catch(e) { console.error('[FIN] Error migrando conciliación:', e.message); }
})();

// ── CONFIGURACIÓN IMPOSITIVA GLOBAL ──────────────────────────────────────────
(function migrarConfigImpositiva() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS adm_config_impositiva (
        clave       TEXT PRIMARY KEY,
        cuenta_id   INTEGER REFERENCES pa_cuentas(id),
        descripcion TEXT
      );
    `);
    // Insertar claves si no existen
    const claves = [
      ['percepcion_iva',       'Percepción IVA'],
      ['percepcion_iibb',      'Percepción IIBB'],
      ['percepcion_ganancias', 'Percepción Ganancias'],
      ['retencion',            'Retención']
    ];
    const ins = db.prepare("INSERT OR IGNORE INTO adm_config_impositiva (clave, descripcion) VALUES (?,?)");
    for (const [clave, desc] of claves) ins.run(clave, desc);
    console.log('[ADM] Configuración impositiva lista');
  } catch(e) { console.error('[ADM] Error migrando config impositiva:', e.message); }
})();

// ── MIGRACIÓN: Unificar pa_proveedores → adm_proveedores ─────────────────────
(function migrarProveedoresUnificado() {
  try {
    // Copiar proveedores viejos a adm_proveedores si no existen ya
    const viejos = db.prepare('SELECT * FROM pa_proveedores WHERE activo=1').all();
    const insAdm = db.prepare(`
      INSERT OR IGNORE INTO adm_proveedores (id, razon_social, cuit, telefono, email, activo, creado_en)
      VALUES (?, ?, ?, ?, ?, 1, datetime('now','localtime'))
    `);
    let migrados = 0;
    const txMig = db.transaction(() => {
      for (const p of viejos) {
        const existe = db.prepare('SELECT id FROM adm_proveedores WHERE id=?').get(p.id);
        if (!existe) {
          insAdm.run(p.id, p.razon_social, p.cuit||null, p.telefono||null, p.email||null);
          migrados++;
        }
      }
    });
    txMig();
    if (migrados > 0) console.log(`[PA] ${migrados} proveedores migrados de pa_proveedores a adm_proveedores`);
  } catch(e) { console.error('[PA] Error migrando proveedores:', e.message); }
})();
(function migrarVentas() {
  try {
    db.exec(`
      -- Padrón de Clientes
      CREATE TABLE IF NOT EXISTS ven_clientes (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        razon_social    TEXT NOT NULL,
        nombre_comercial TEXT,
        cuit            TEXT,
        condicion_iva   TEXT DEFAULT 'responsable_inscripto',
        direccion       TEXT,
        telefono        TEXT,
        email           TEXT,
        contacto        TEXT,
        rubro           TEXT,
        notas           TEXT,
        cuenta_contable_id INTEGER REFERENCES pa_cuentas(id),
        activo          INTEGER NOT NULL DEFAULT 1,
        creado_en       TEXT DEFAULT (datetime('now','localtime'))
      );

      -- Liquidaciones de Producto (recibidas del acopiador)
      CREATE TABLE IF NOT EXISTS ven_liquidaciones (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        numero          TEXT NOT NULL UNIQUE,
        fecha           TEXT NOT NULL DEFAULT (date('now','localtime')),
        cliente_id      INTEGER NOT NULL REFERENCES ven_clientes(id),
        nro_remito      TEXT,
        observaciones   TEXT,
        precio_bruto    REAL NOT NULL DEFAULT 0,
        desc_comision   REAL NOT NULL DEFAULT 0,
        desc_flete      REAL NOT NULL DEFAULT 0,
        desc_carga_descarga REAL NOT NULL DEFAULT 0,
        desc_otros      REAL NOT NULL DEFAULT 0,
        ret_iva         REAL NOT NULL DEFAULT 0,
        ret_ganancias   REAL NOT NULL DEFAULT 0,
        ret_iibb        REAL NOT NULL DEFAULT 0,
        ret_otras       REAL NOT NULL DEFAULT 0,
        neto_acreditar  REAL NOT NULL DEFAULT 0,
        estado          TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','cobrada','anulada')),
        asiento_id      INTEGER REFERENCES pa_asientos(id),
        usuario_id      INTEGER,
        creado_en       TEXT DEFAULT (datetime('now','localtime'))
      );

      -- Ítems de la liquidación (uno por cultivo/producto)
      CREATE TABLE IF NOT EXISTS ven_liquidacion_items (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        liquidacion_id  INTEGER NOT NULL REFERENCES ven_liquidaciones(id),
        descripcion     TEXT NOT NULL,
        kilos           REAL,
        precio_unitario REAL,
        subtotal        REAL NOT NULL DEFAULT 0
      );

      -- Facturas de Venta (emitidas por nosotros)
      CREATE TABLE IF NOT EXISTS ven_facturas (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        numero          TEXT NOT NULL UNIQUE,
        fecha           TEXT NOT NULL DEFAULT (date('now','localtime')),
        cliente_id      INTEGER NOT NULL REFERENCES ven_clientes(id),
        tipo            TEXT NOT NULL DEFAULT 'A' CHECK(tipo IN ('A','B','C')),
        concepto        TEXT,
        neto            REAL NOT NULL DEFAULT 0,
        iva             REAL NOT NULL DEFAULT 0,
        total           REAL NOT NULL DEFAULT 0,
        estado          TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','cobrada','anulada')),
        asiento_id      INTEGER REFERENCES pa_asientos(id),
        notas           TEXT,
        usuario_id      INTEGER,
        creado_en       TEXT DEFAULT (datetime('now','localtime'))
      );

      -- Ítems de factura de venta
      CREATE TABLE IF NOT EXISTS ven_factura_items (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        factura_id      INTEGER NOT NULL REFERENCES ven_facturas(id),
        descripcion     TEXT NOT NULL,
        cantidad        REAL DEFAULT 1,
        precio_unitario REAL DEFAULT 0,
        subtotal        REAL NOT NULL DEFAULT 0
      );

      -- Cobranzas (pagos recibidos de clientes)
      CREATE TABLE IF NOT EXISTS ven_cobranzas (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha           TEXT NOT NULL DEFAULT (date('now','localtime')),
        cliente_id      INTEGER NOT NULL REFERENCES ven_clientes(id),
        monto           REAL NOT NULL,
        forma_pago      TEXT DEFAULT 'transferencia',
        referencia      TEXT,
        notas           TEXT,
        anulada         INTEGER NOT NULL DEFAULT 0,
        usuario_id      INTEGER,
        creado_en       TEXT DEFAULT (datetime('now','localtime'))
      );

      -- Vínculos cobranza ↔ liquidaciones/facturas
      CREATE TABLE IF NOT EXISTS ven_cobranza_docs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        cobranza_id     INTEGER NOT NULL REFERENCES ven_cobranzas(id),
        tipo            TEXT NOT NULL CHECK(tipo IN ('liquidacion','factura')),
        doc_id          INTEGER NOT NULL,
        monto           REAL NOT NULL
      );
    `);

    console.log('[VEN] Tablas ventas listas');
  } catch(e) { console.error('[VEN] Error migrando ventas:', e.message); }
})();

// ── MIGRACIÓN: Recodificación Plan de Cuentas 1-5 ────────────────────────────
(function recodificarPlanCuentas() {
  try {
    const yaRecodificado = db.prepare("SELECT COUNT(*) as c FROM pa_cuentas_secciones WHERE codigo LIKE '5.0%'").get();
    if (yaRecodificado?.c > 0) return;

    console.log('[PA] Iniciando recodificación del Plan de Cuentas...');

    const mapaSeccion = {
      1: { nuevo: '5.01', grupo: 'gastos' },
      2: { nuevo: '5.02', grupo: 'gastos' },
      3: { nuevo: '5.03', grupo: 'gastos' },
      4: { nuevo: '5.04', grupo: 'gastos' },
      5: { nuevo: '5.05', grupo: 'gastos' },
      6: { nuevo: '5.06', grupo: 'gastos' },
      7: { nuevo: '5.07', grupo: 'gastos' },
    };

    const tx = db.transaction(() => {
      for (const [codigoViejo, datos] of Object.entries(mapaSeccion)) {
        const sec = db.prepare('SELECT id FROM pa_cuentas_secciones WHERE codigo=?').get(parseInt(codigoViejo));
        if (!sec) continue;
        db.prepare("UPDATE pa_cuentas_secciones SET codigo=?, grupo=? WHERE id=?")
          .run(datos.nuevo, datos.grupo, sec.id);
        const cuentas = db.prepare('SELECT id, codigo FROM pa_cuentas WHERE seccion_id=?').all(sec.id);
        for (const cuenta of cuentas) {
          const partes = String(cuenta.codigo).split('.');
          const subCodigo = partes.slice(1).join('.');
          const nuevoCodigo = datos.nuevo + '.' + subCodigo;
          try {
            db.prepare('UPDATE pa_cuentas SET codigo=? WHERE id=?').run(nuevoCodigo, cuenta.id);
          } catch(e) {
            db.prepare('UPDATE pa_cuentas SET codigo=? WHERE id=?').run(nuevoCodigo + '_v', cuenta.id);
          }
        }
        console.log(`[PA] Sección ${codigoViejo} → ${datos.nuevo} (${cuentas.length} cuentas)`);
      }
    });
    tx();
    console.log('[PA] Recodificación completada');
  } catch(e) { console.error('[PA] Error en recodificación:', e.message); }
})();

// ── MIGRACIÓN: Secciones y cuentas de Activo, Pasivo, Patrimonio e Ingresos ──
(function seedActivoPasivoPNIngresos() {
  try {
    // Solo correr si no existen estas secciones
    const yaExiste = db.prepare("SELECT COUNT(*) as c FROM pa_cuentas_secciones WHERE codigo IN ('1.01','2.01','3.01','4.01')").get();
    if (yaExiste?.c > 0) return;

    console.log('[PA] Creando secciones Activo, Pasivo, Patrimonio e Ingresos...');

    const insSec = db.prepare(`
      INSERT INTO pa_cuentas_secciones (codigo, nombre, orden, activo, grupo)
      VALUES (?, ?, ?, 1, ?)
    `);
    const insCta = db.prepare(`
      INSERT OR IGNORE INTO pa_cuentas (codigo, nombre, seccion_id, tipo, permite_lote, permite_campania, es_sistema, orden, activo)
      VALUES (?, ?, ?, ?, 0, 0, 0, ?, 1)
    `);

    const grupos = [
      // [codigo_sec, nombre_sec, grupo, orden_sec, cuentas]
      ['1.01', 'CAJA Y BANCOS',            'activo', 10, [
        ['1.01.01', 'Caja Pesos',                    'patrimonial', 1],
        ['1.01.02', 'Banco Cuenta Corriente',        'patrimonial', 2],
        ['1.01.03', 'Banco Caja de Ahorro',          'patrimonial', 3],
        ['1.01.04', 'Cheques en Cartera',            'patrimonial', 4],
      ]],
      ['1.02', 'CRÉDITOS POR VENTAS',       'activo', 20, [
        ['1.02.01', 'Clientes — Cuenta Corriente',   'patrimonial', 1],
        ['1.02.02', 'Liquidaciones a Cobrar',        'patrimonial', 2],
      ]],
      ['1.03', 'OTROS CRÉDITOS',            'activo', 30, [
        ['1.03.01', 'IVA Crédito Fiscal',            'patrimonial', 1],
        ['1.03.02', 'Anticipos a Proveedores',       'patrimonial', 2],
        ['1.03.03', 'Retenciones a Recuperar',       'patrimonial', 3],
      ]],
      ['1.04', 'BIENES DE CAMBIO',          'activo', 40, [
        ['1.04.01', 'Insumos en Stock',              'patrimonial', 1],
        ['1.04.02', 'Producción en Proceso',         'patrimonial', 2],
        ['1.04.03', 'Producción Terminada',          'patrimonial', 3],
      ]],
      ['1.05', 'BIENES DE USO',             'activo', 50, [
        ['1.05.01', 'Maquinaria Agrícola',           'patrimonial', 1],
        ['1.05.02', 'Rodados',                       'patrimonial', 2],
        ['1.05.03', 'Instalaciones y Mejoras',       'patrimonial', 3],
        ['1.05.04', 'Equipos y Herramientas',        'patrimonial', 4],
        ['1.05.05', 'Amortizaciones Acumuladas',     'patrimonial', 5],
      ]],
      ['1.06', 'ACTIVOS BIOLÓGICOS',        'activo', 60, [
        ['1.06.01', 'Cultivos en Pie',               'patrimonial', 1],
        ['1.06.02', 'Plantaciones Perennes',         'patrimonial', 2],
      ]],
      ['2.01', 'PROVEEDORES',               'pasivo', 10, [
        ['2.01.01', 'Proveedores — Cuenta Corriente','patrimonial', 1],
        ['2.01.02', 'Proveedores — Facturas a Pagar','patrimonial', 2],
      ]],
      ['2.02', 'DEUDAS BANCARIAS Y FINANCIERAS', 'pasivo', 20, [
        ['2.02.01', 'Préstamos Bancarios CP',        'patrimonial', 1],
        ['2.02.02', 'Préstamos Bancarios LP',        'patrimonial', 2],
        ['2.02.03', 'Intereses a Pagar',             'patrimonial', 3],
      ]],
      ['2.03', 'DEUDAS FISCALES',           'pasivo', 30, [
        ['2.03.01', 'IVA Débito Fiscal',             'patrimonial', 1],
        ['2.03.02', 'Ganancias a Pagar',             'patrimonial', 2],
        ['2.03.03', 'IIBB a Pagar',                  'patrimonial', 3],
      ]],
      ['2.04', 'DEUDAS LABORALES Y SOCIALES', 'pasivo', 40, [
        ['2.04.01', 'Sueldos y Jornales a Pagar',   'patrimonial', 1],
        ['2.04.02', 'Cargas Sociales a Pagar',      'patrimonial', 2],
        ['2.04.03', 'Vacaciones y SAC a Pagar',     'patrimonial', 3],
      ]],
      ['3.01', 'CAPITAL',                   'patrimonio_neto', 10, [
        ['3.01.01', 'Capital Social',               'patrimonial', 1],
        ['3.01.02', 'Aportes Irrevocables',         'patrimonial', 2],
      ]],
      ['3.02', 'RESULTADOS',                'patrimonio_neto', 20, [
        ['3.02.01', 'Resultados No Asignados',      'patrimonial', 1],
        ['3.02.02', 'Resultado del Ejercicio',      'patrimonial', 2],
      ]],
      ['3.03', 'RESERVAS',                  'patrimonio_neto', 30, [
        ['3.03.01', 'Reserva Legal',                'patrimonial', 1],
        ['3.03.02', 'Reserva Facultativa',          'patrimonial', 2],
      ]],
      ['4.01', 'VENTAS AGROPECUARIAS',      'ingresos', 10, [
        ['4.01.01', 'Ventas de Producción Propia',  'resultado', 1],
        ['4.01.02', 'Liquidaciones de Producto',    'resultado', 2],
        ['4.01.03', 'Ventas de Hacienda',           'resultado', 3],
      ]],
      ['4.02', 'INGRESOS POR SERVICIOS',    'ingresos', 20, [
        ['4.02.01', 'Servicios Agrícolas',          'resultado', 1],
        ['4.02.02', 'Alquiler de Maquinaria',       'resultado', 2],
        ['4.02.03', 'Arrendamientos Cobrados',      'resultado', 3],
      ]],
      ['4.03', 'OTROS INGRESOS',            'ingresos', 30, [
        ['4.03.01', 'Intereses Ganados',            'resultado', 1],
        ['4.03.02', 'Diferencia de Cambio',         'resultado', 2],
        ['4.03.03', 'Ingresos Extraordinarios',     'resultado', 3],
      ]],
    ];

    const txSeed = db.transaction(() => {
      for (const [codSec, nomSec, grupo, ordenSec, cuentas] of grupos) {
        const rSec = insSec.run(codSec, nomSec, ordenSec, grupo);
        const secId = rSec.lastInsertRowid;
        let orden = 0;
        for (const [codCta, nomCta, tipo, ord] of cuentas) {
          insCta.run(codCta, nomCta, secId, tipo, ord);
        }
      }
    });
    txSeed();
    console.log('[PA] Secciones Activo/Pasivo/Patrimonio/Ingresos creadas');
  } catch(e) { console.error('[PA] Error creando secciones base:', e.message); }
})();

// ═══════════════════════════════════════════════════════════════════════════
// MULTISOCIEDAD — FASE 1: cimiento contable (OK Andy + Pablo)
// ───────────────────────────────────────────────────────────────────────────
// Agrega sociedad_id a las 4 tablas del cimiento contable:
//   pa_cuentas, pa_cuentas_secciones, pa_movimientos_contables, pa_asientos.
// Decisiones aplicadas:
//   • Plan de cuentas UNO POR SOCIEDAD (Opción A). El plan existente = Puente Cordón (PC).
//   • UNIQUE(codigo) → UNIQUE(sociedad_id, codigo) en pa_cuentas y pa_cuentas_secciones.
//   • San Gerónimo (SG): se espeja SOLO la ESTRUCTURA de secciones (0 cuentas) — TODO Pablo.
//   • sociedad_id NOT NULL DEFAULT=PC en pa_movimientos_contables y pa_asientos, así los
//     escritores de pa_asientos de OTRAS fases (produccion.js/ventas.js/ordenes.js) siguen
//     funcionando sin tocarlos (su contexto hoy es PC). Se endurecen en su fase.
// BETA sin datos reales → se preserva el id de cada cuenta/sección (rebuild copia ids),
// por lo que las FK existentes (pa_asientos_lineas, ven_*, fin_*, etc.) quedan válidas.
// Idempotente: cada paso se guarda por presencia de columna / existencia de filas.
// ═══════════════════════════════════════════════════════════════════════════
(function migrarMultisociedadFase1() {
  try {
    const soc = (nombre) => db.prepare("SELECT id FROM sociedades WHERE nombre = ?").get(nombre);
    const pc = soc('Puente Cordón SA')
            || db.prepare("SELECT id FROM sociedades WHERE funcion = 'productiva' ORDER BY id LIMIT 1").get();
    if (!pc) {
      console.warn('[PA][MS-F1] Sociedad Puente Cordón no encontrada — Fase 1 multisociedad NO aplicada');
      return;
    }
    const PC = pc.id;
    const sg = soc('San Gerónimo SA')
            || db.prepare("SELECT id FROM sociedades WHERE funcion = 'comercial' ORDER BY id LIMIT 1").get();
    const SG = sg ? sg.id : null;

    const tieneCol = (tabla, col) =>
      db.prepare(`PRAGMA table_info(${tabla})`).all().some(c => c.name === col);

    // Los rebuilds (DROP/RENAME) requieren FK enforcement apagado para no romper por
    // las referencias entrantes (pa_asientos_lineas, pa_movimientos_contables, etc.).
    // Los ids se preservan en el copiado, así que al restaurar FK la integridad se mantiene.
    const fkPrev = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {

    // ── 1) pa_cuentas_secciones: rebuild con sociedad_id + UNIQUE(sociedad_id,codigo) ──
    if (!tieneCol('pa_cuentas_secciones', 'sociedad_id')) {
      db.exec(`
        BEGIN;
        CREATE TABLE pa_cuentas_secciones_v2 (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          sociedad_id     INTEGER NOT NULL REFERENCES sociedades(id),
          codigo          TEXT NOT NULL,
          nombre          TEXT NOT NULL,
          orden           INTEGER NOT NULL DEFAULT 0,
          activo          INTEGER NOT NULL DEFAULT 1,
          grupo           TEXT DEFAULT 'gastos',
          creado_en       TEXT DEFAULT (datetime('now','localtime')),
          actualizado_en  TEXT DEFAULT (datetime('now','localtime')),
          UNIQUE(sociedad_id, codigo)
        );
        INSERT INTO pa_cuentas_secciones_v2
          (id, sociedad_id, codigo, nombre, orden, activo, grupo, creado_en, actualizado_en)
          SELECT id, ${PC}, codigo, nombre, orden, activo, COALESCE(grupo,'gastos'), creado_en, actualizado_en
            FROM pa_cuentas_secciones;
        DROP TABLE pa_cuentas_secciones;
        ALTER TABLE pa_cuentas_secciones_v2 RENAME TO pa_cuentas_secciones;
        CREATE INDEX IF NOT EXISTS idx_pa_secciones_sociedad ON pa_cuentas_secciones(sociedad_id);
        COMMIT;
      `);
      console.log('[PA][MS-F1] pa_cuentas_secciones: sociedad_id agregado (existentes → PC), UNIQUE(sociedad_id,codigo)');
    }

    // ── 2) pa_cuentas: rebuild con sociedad_id + UNIQUE(sociedad_id,codigo) ──
    if (!tieneCol('pa_cuentas', 'sociedad_id')) {
      db.exec(`
        BEGIN;
        CREATE TABLE pa_cuentas_v2 (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          sociedad_id       INTEGER NOT NULL REFERENCES sociedades(id),
          codigo            TEXT NOT NULL,
          nombre            TEXT NOT NULL,
          seccion_id        INTEGER NOT NULL REFERENCES pa_cuentas_secciones(id),
          tipo              TEXT NOT NULL DEFAULT 'resultado',
          permite_lote      INTEGER NOT NULL DEFAULT 0,
          permite_campania  INTEGER NOT NULL DEFAULT 0,
          es_sistema        INTEGER NOT NULL DEFAULT 0,
          orden             INTEGER NOT NULL DEFAULT 0,
          activo            INTEGER NOT NULL DEFAULT 1,
          creado_en         TEXT DEFAULT (datetime('now','localtime')),
          actualizado_en    TEXT DEFAULT (datetime('now','localtime')),
          UNIQUE(sociedad_id, codigo)
        );
        INSERT INTO pa_cuentas_v2
          (id, sociedad_id, codigo, nombre, seccion_id, tipo, permite_lote, permite_campania, es_sistema, orden, activo, creado_en, actualizado_en)
          SELECT id, ${PC}, codigo, nombre, seccion_id, tipo, permite_lote, permite_campania, es_sistema, orden, activo, creado_en, actualizado_en
            FROM pa_cuentas;
        DROP TABLE pa_cuentas;
        ALTER TABLE pa_cuentas_v2 RENAME TO pa_cuentas;
        CREATE INDEX IF NOT EXISTS idx_pa_cuentas_seccion  ON pa_cuentas(seccion_id);
        CREATE INDEX IF NOT EXISTS idx_pa_cuentas_codigo   ON pa_cuentas(codigo);
        CREATE INDEX IF NOT EXISTS idx_pa_cuentas_sociedad ON pa_cuentas(sociedad_id);
        COMMIT;
      `);
      console.log('[PA][MS-F1] pa_cuentas: sociedad_id agregado (existentes → PC), UNIQUE(sociedad_id,codigo)');
    }

    // ── 3) pa_movimientos_contables: sociedad_id NOT NULL DEFAULT=PC (tabla sin uso hoy) ──
    if (!tieneCol('pa_movimientos_contables', 'sociedad_id')) {
      db.exec(`ALTER TABLE pa_movimientos_contables ADD COLUMN sociedad_id INTEGER NOT NULL DEFAULT ${PC}`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_mov_sociedad ON pa_movimientos_contables(sociedad_id)`);
      console.log('[PA][MS-F1] pa_movimientos_contables.sociedad_id agregado (NOT NULL DEFAULT PC)');
    }

    // ── 4) pa_asientos (cabecera): sociedad_id NOT NULL DEFAULT=PC ──
    // DEFAULT=PC permite que los INSERT de produccion.js/ventas.js/ordenes.js (otras fases)
    // sigan andando sin tocarlos; cuentas.js lo setea explícito.
    if (!tieneCol('pa_asientos', 'sociedad_id')) {
      db.exec(`ALTER TABLE pa_asientos ADD COLUMN sociedad_id INTEGER NOT NULL DEFAULT ${PC}`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pa_asientos_sociedad ON pa_asientos(sociedad_id)`);
      console.log('[PA][MS-F1] pa_asientos.sociedad_id agregado (NOT NULL DEFAULT PC)');
    }

    // ── 5) Espejo de SG: SOLO estructura de secciones (0 cuentas). TODO Pablo. ──
    if (SG) {
      const sgTieneSecciones = db.prepare(
        "SELECT COUNT(*) AS c FROM pa_cuentas_secciones WHERE sociedad_id = ?"
      ).get(SG).c;
      if (sgTieneSecciones === 0) {
        const pcSecs = db.prepare(
          "SELECT codigo, nombre, orden, activo, grupo FROM pa_cuentas_secciones WHERE sociedad_id = ? ORDER BY codigo"
        ).all(PC);
        const insSG = db.prepare(
          "INSERT INTO pa_cuentas_secciones (sociedad_id, codigo, nombre, orden, activo, grupo) VALUES (?,?,?,?,?,?)"
        );
        const tx = db.transaction(() => {
          for (const s of pcSecs) insSG.run(SG, s.codigo, s.nombre, s.orden, s.activo, s.grupo || 'gastos');
        });
        tx();
        console.log(`[PA][MS-F1] San Gerónimo: ${pcSecs.length} secciones espejadas (0 cuentas).`);
        console.log('[PA][MS-F1] TODO Pablo: definir las CUENTAS reales de SG (comercializador). '
          + 'Las secciones se espejaron de PC como punto de partida; revisar cuáles aplican.');
      }
    } else {
      console.warn('[PA][MS-F1] Sociedad San Gerónimo no encontrada — espejo de secciones omitido.');
    }

    } finally {
      db.pragma(`foreign_keys = ${fkPrev ? 'ON' : 'OFF'}`);
    }

    console.log('[PA][MS-F1] Cimiento contable multisociedad inicializado.');
  } catch (e) {
    console.error('[PA][MS-F1] Error en migración multisociedad Fase 1:', e.message);
  }
})();

// ═══════════════════════════════════════════════════════════════════════════
// MULTISOCIEDAD — FASE 3: Proveedores + Ventas (OK Andy + Pablo)
// ───────────────────────────────────────────────────────────────────────────
// Agrega sociedad_id a las tablas de proveedores/pagos y de ventas:
//   adm_proveedores, pa_pagos_proveedores,
//   ven_clientes, ven_liquidaciones, ven_facturas, ven_cobranzas.
// Decisiones aplicadas:
//   • Proveedores/pagos: cada sociedad el suyo. Existentes → PC; SG arranca con padrón vacío.
//   • Ventas (ven_*) = de PC (productor vía acopiador). Existentes → PC; SG espeja circuito (vacío).
//   • sociedad_id NOT NULL DEFAULT=PC: protege a los escritores actuales sin tocarlos
//     (migrarProveedoresUnificado, pagos.js, ventas.js); los routers de esta fase lo setean
//     explícito para habilitar el alta en SG.
// Tablas-hijo (pa_pagos_compras, ven_*_items, ven_cobranza_docs) NO llevan columna:
//   la sociedad se deriva del padre por join.
// Sin UNIQUE(codigo) que migrar → no hay rebuilds, solo ADD COLUMN. Idempotente.
// ═══════════════════════════════════════════════════════════════════════════
(function migrarMultisociedadFase3() {
  try {
    const soc = (nombre) => db.prepare("SELECT id FROM sociedades WHERE nombre = ?").get(nombre);
    const pc = soc('Puente Cordón SA')
            || db.prepare("SELECT id FROM sociedades WHERE funcion = 'productiva' ORDER BY id LIMIT 1").get();
    if (!pc) {
      console.warn('[PA][MS-F3] Sociedad Puente Cordón no encontrada — Fase 3 multisociedad NO aplicada');
      return;
    }
    const PC = pc.id;

    const tieneCol = (tabla, col) =>
      db.prepare(`PRAGMA table_info(${tabla})`).all().some(c => c.name === col);

    // Tablas que reciben sociedad_id NOT NULL DEFAULT=PC + índice de filtrado.
    const tablas = [
      'adm_proveedores',
      'pa_pagos_proveedores',
      'ven_clientes',
      'ven_liquidaciones',
      'ven_facturas',
      'ven_cobranzas',
    ];
    for (const t of tablas) {
      if (!tieneCol(t, 'sociedad_id')) {
        db.exec(`ALTER TABLE ${t} ADD COLUMN sociedad_id INTEGER NOT NULL DEFAULT ${PC}`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_sociedad ON ${t}(sociedad_id)`);
        console.log(`[PA][MS-F3] ${t}.sociedad_id agregado (NOT NULL DEFAULT PC)`);
      }
    }

    console.log('[PA][MS-F3] Proveedores + Ventas multisociedad inicializado.');
  } catch (e) {
    console.error('[PA][MS-F3] Error en migración multisociedad Fase 3:', e.message);
  }
})();

// ═══════════════════════════════════════════════════════════════════════════
// MULTISOCIEDAD — FASE 2: Financiero (cajas / bancos / cheques / OP) (OK Andy + Pablo)
// ───────────────────────────────────────────────────────────────────────────
// Cada caja/cuenta bancaria pertenece a UNA sociedad (titular del CBU). Sin pool
// "Familia". La sociedad nace en fin_cuentas (raíz) y los routers la derivan hacia
// abajo (cheques, movimientos, OP, conciliación).
// Tablas que reciben sociedad_id NOT NULL DEFAULT=PC:
//   fin_cuentas, fin_chequeras, fin_cheques_propios, fin_cheques_terceros,
//   fin_movimientos, fin_extracto_lineas, fin_conciliaciones  → ADD COLUMN (sin rebuild).
//   fin_ordenes_pago → REBUILD: numero pasa de UNIQUE global a UNIQUE(sociedad_id,numero)
//     para que cada sociedad tenga su propia numeración de OP. Ids preservados.
// Tabla-hijo fin_op_compras NO lleva columna: deriva de la OP por join.
// Existentes → PC. SG arranca sin cuentas (las cargan con su CBU). Idempotente.
// ═══════════════════════════════════════════════════════════════════════════
(function migrarMultisociedadFase2() {
  try {
    const soc = (nombre) => db.prepare("SELECT id FROM sociedades WHERE nombre = ?").get(nombre);
    const pc = soc('Puente Cordón SA')
            || db.prepare("SELECT id FROM sociedades WHERE funcion = 'productiva' ORDER BY id LIMIT 1").get();
    if (!pc) {
      console.warn('[PA][MS-F2] Sociedad Puente Cordón no encontrada — Fase 2 multisociedad NO aplicada');
      return;
    }
    const PC = pc.id;
    const tieneCol = (tabla, col) =>
      db.prepare(`PRAGMA table_info(${tabla})`).all().some(c => c.name === col);

    // ── 1) Tablas simples: ADD COLUMN sociedad_id NOT NULL DEFAULT=PC + índice ──
    const tablasSimples = [
      'fin_cuentas',
      'fin_chequeras',
      'fin_cheques_propios',
      'fin_cheques_terceros',
      'fin_movimientos',
      'fin_extracto_lineas',
      'fin_conciliaciones',
    ];
    for (const t of tablasSimples) {
      if (!tieneCol(t, 'sociedad_id')) {
        db.exec(`ALTER TABLE ${t} ADD COLUMN sociedad_id INTEGER NOT NULL DEFAULT ${PC}`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_sociedad ON ${t}(sociedad_id)`);
        console.log(`[PA][MS-F2] ${t}.sociedad_id agregado (NOT NULL DEFAULT PC)`);
      }
    }

    // ── 2) fin_ordenes_pago: rebuild para UNIQUE(sociedad_id, numero) ──
    if (!tieneCol('fin_ordenes_pago', 'sociedad_id')) {
      const fkPrev = db.pragma('foreign_keys', { simple: true });
      db.pragma('foreign_keys = OFF');
      try {
        db.exec(`
          BEGIN;
          CREATE TABLE fin_ordenes_pago_v2 (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            sociedad_id     INTEGER NOT NULL REFERENCES sociedades(id),
            numero          TEXT NOT NULL,
            fecha           TEXT NOT NULL DEFAULT (date('now','localtime')),
            proveedor_id    INTEGER NOT NULL REFERENCES adm_proveedores(id),
            monto_total     REAL NOT NULL,
            forma_pago      TEXT NOT NULL DEFAULT 'transferencia',
            cuenta_fin_id   INTEGER REFERENCES fin_cuentas(id),
            cheque_prop_id  INTEGER REFERENCES fin_cheques_propios(id),
            cheque_ter_id   INTEGER REFERENCES fin_cheques_terceros(id),
            referencia      TEXT,
            notas           TEXT,
            estado          TEXT NOT NULL DEFAULT 'emitida' CHECK(estado IN ('emitida','anulada')),
            movimiento_id   INTEGER REFERENCES fin_movimientos(id),
            usuario_id      INTEGER,
            creado_en       TEXT DEFAULT (datetime('now','localtime')),
            asiento_id      INTEGER REFERENCES pa_asientos(id),
            UNIQUE(sociedad_id, numero)
          );
          INSERT INTO fin_ordenes_pago_v2
            (id, sociedad_id, numero, fecha, proveedor_id, monto_total, forma_pago, cuenta_fin_id,
             cheque_prop_id, cheque_ter_id, referencia, notas, estado, movimiento_id, usuario_id, creado_en, asiento_id)
            SELECT id, ${PC}, numero, fecha, proveedor_id, monto_total, forma_pago, cuenta_fin_id,
                   cheque_prop_id, cheque_ter_id, referencia, notas, estado, movimiento_id, usuario_id, creado_en, asiento_id
              FROM fin_ordenes_pago;
          DROP TABLE fin_ordenes_pago;
          ALTER TABLE fin_ordenes_pago_v2 RENAME TO fin_ordenes_pago;
          CREATE INDEX IF NOT EXISTS idx_fin_ordenes_pago_sociedad ON fin_ordenes_pago(sociedad_id);
          COMMIT;
        `);
        console.log('[PA][MS-F2] fin_ordenes_pago: sociedad_id agregado (existentes → PC), UNIQUE(sociedad_id,numero)');
      } finally {
        db.pragma(`foreign_keys = ${fkPrev ? 'ON' : 'OFF'}`);
      }
    }

    console.log('[PA][MS-F2] Financiero (cajas/bancos) multisociedad inicializado.');
  } catch (e) {
    console.error('[PA][MS-F2] Error en migración multisociedad Fase 2:', e.message);
  }
})();

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO PERSONAL PC — cambios de modales/lógica (rubro→producto, semanas, pago caja)
// Todas idempotentes y guardadas: corren siempre, no rompen si las columnas/tablas
// ya existen. NO referencian columnas nuevas dentro de un schema-template bare
// (lección del crash #299 con personal_actual_id).
// ═══════════════════════════════════════════════════════════════════════════
(function migracionPersonalPCModales() {
  // (B) Mini-modelo rubro→producto en cuentas MO (lo setea la ingeniera).
  //     mo_clase: 'productivo'/'general'/NULL · mo_cultivo: producto (texto, = pa_cultivos_lote.cultivo)
  //     mo_vigente: 1 = el operario puede cargar sobre este rubro.
  try {
    const c = db.prepare("PRAGMA table_info(pa_cuentas)").all().map(x => x.name);
    if (!c.includes('mo_clase'))   { db.exec("ALTER TABLE pa_cuentas ADD COLUMN mo_clase TEXT");                 console.log('[PA] pa_cuentas.mo_clase agregado'); }
    if (!c.includes('mo_cultivo')) { db.exec("ALTER TABLE pa_cuentas ADD COLUMN mo_cultivo TEXT");               console.log('[PA] pa_cuentas.mo_cultivo agregado'); }
    if (!c.includes('mo_vigente')) { db.exec("ALTER TABLE pa_cuentas ADD COLUMN mo_vigente INTEGER DEFAULT 0");  console.log('[PA] pa_cuentas.mo_vigente agregado'); }
    // Backfill de clase para cuentas MO sin clasificar (idempotente: solo donde mo_clase IS NULL).
    //   Señal = permite_lote del plan de cuentas: 0 = estructura (no va a un lote) → 'general';
    //   1 = imputable a lote → 'productivo'. Así MO GENERALES (permite_lote=0) queda general
    //   de entrada y el resto productivo, sin name-parsing. Overridable desde la UI de ingeniería.
    const colsC = db.prepare("PRAGMA table_info(pa_cuentas)").all().map(x => x.name);
    if (colsC.includes('permite_lote')) {
      const r = db.prepare(`
        UPDATE pa_cuentas
        SET mo_clase = CASE WHEN COALESCE(permite_lote,1)=0 THEN 'general' ELSE 'productivo' END
        WHERE nombre LIKE 'MO %' AND mo_clase IS NULL
      `).run();
      if (r.changes) console.log('[PA] backfill mo_clase en', r.changes, 'cuentas MO (general/productivo según permite_lote)');
    }
  } catch (e) { console.error('[PA] Error migrando pa_cuentas (rubro MO):', e.message); }

  // (D) Link del pago de personal al egreso de caja (fin_movimientos).
  try {
    const c = db.prepare("PRAGMA table_info(pa_cc_movimientos)").all().map(x => x.name);
    if (!c.includes('fin_movimiento_id')) {
      db.exec("ALTER TABLE pa_cc_movimientos ADD COLUMN fin_movimiento_id INTEGER REFERENCES fin_movimientos(id)");
      console.log('[PA] pa_cc_movimientos.fin_movimiento_id agregado');
    }
  } catch (e) { console.error('[PA] Error migrando pa_cc_movimientos (fin_movimiento_id):', e.message); }

  // (C) Semanas de pago (rango libre apertura→cierre, validación de huecos/solapes en la API).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pa_semanas_pago (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha_apertura TEXT NOT NULL,
        fecha_cierre   TEXT NOT NULL,
        estado         TEXT NOT NULL DEFAULT 'abierta' CHECK(estado IN ('abierta','cerrada')),
        notas          TEXT,
        creado_por     INTEGER REFERENCES usuarios(id),
        creado_en      TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_pa_semanas_pago_fechas ON pa_semanas_pago(fecha_apertura, fecha_cierre);
    `);
  } catch (e) { console.error('[PA] Error creando pa_semanas_pago:', e.message); }

  // (D) Liquidaciones de pago de jornales (reemplazo del pago masivo). Fase 1 = armado/selección
  //     (borrador). Las columnas de la Fase 2 (caja/ámbito/asiento/egreso) ya existen nullable
  //     para no migrar de nuevo: en borrador quedan NULL; se completan al EMITIR. Idempotente.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pa_liquidaciones_pago (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        semana_id         INTEGER REFERENCES pa_semanas_pago(id),
        fecha             TEXT NOT NULL DEFAULT (date('now','localtime')),
        rango_desde       TEXT,
        rango_hasta       TEXT,
        estado            TEXT NOT NULL DEFAULT 'borrador' CHECK(estado IN ('borrador','emitida','anulada')),
        total             REAL NOT NULL DEFAULT 0,
        -- Fase 2 (emisión): caja de donde sale, ámbito, egreso y asiento generados.
        caja_id           INTEGER REFERENCES fin_cuentas(id),
        ambito            TEXT,
        fin_movimiento_id INTEGER REFERENCES fin_movimientos(id),
        asiento_id        INTEGER REFERENCES pa_asientos(id),
        notas             TEXT,
        creado_por        INTEGER REFERENCES usuarios(id),
        creado_en         TEXT DEFAULT (datetime('now','localtime')),
        emitida_por       INTEGER,
        emitida_en        TEXT,
        anulada_por       INTEGER,
        anulada_en        TEXT,
        anulada_motivo    TEXT
      );
      -- Una línea por persona seleccionada (su monto = pendiente al armar la liquidación).
      CREATE TABLE IF NOT EXISTS pa_liquidaciones_items (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        liquidacion_id   INTEGER NOT NULL REFERENCES pa_liquidaciones_pago(id),
        tipo_titular     TEXT NOT NULL,
        titular_id       INTEGER NOT NULL REFERENCES pa_personal(id),
        monto            REAL NOT NULL DEFAULT 0,
        cc_movimiento_id INTEGER,
        UNIQUE(liquidacion_id, tipo_titular, titular_id)
      );
      CREATE INDEX IF NOT EXISTS idx_liq_semana    ON pa_liquidaciones_pago(semana_id);
      CREATE INDEX IF NOT EXISTS idx_liq_estado    ON pa_liquidaciones_pago(estado);
      CREATE INDEX IF NOT EXISTS idx_liq_items_liq ON pa_liquidaciones_items(liquidacion_id);
    `);
  } catch (e) { console.error('[PA] Error creando pa_liquidaciones_pago:', e.message); }

  // (B) lote_id nullable en pa_asistencias → MO general sin lote (gasto de estructura,
  //     NO se imputa a pa_costos_lote). Cambiar NOT NULL requiere rebuild (SQLite).
  //     Guard: solo rebuildea si lote_id TODAVÍA es NOT NULL → idempotente.
  try {
    const info = db.prepare("PRAGMA table_info(pa_asistencias)").all();
    const loteCol = info.find(c => c.name === 'lote_id');
    if (loteCol && loteCol.notnull === 1) {
      db.pragma('foreign_keys = OFF');
      const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE pa_asistencias_new (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha                 TEXT NOT NULL,
            cuadrilla_id          INTEGER REFERENCES pa_cuadrillas(id),
            personal_id           INTEGER REFERENCES pa_personal(id),
            contratista_id        INTEGER REFERENCES pa_personal(id),
            cantidad              INTEGER NOT NULL DEFAULT 1,
            horas                 REAL NOT NULL,
            jornales_calc         REAL,
            rubro_cuenta_id       INTEGER NOT NULL,
            campaña_anual_id      INTEGER NOT NULL REFERENCES pa_campañas(id),
            campaña_estacional_id INTEGER NOT NULL REFERENCES pa_campañas(id),
            lote_id               INTEGER REFERENCES pa_lotes(id),
            finca                 TEXT,
            tarea_tipo_id         INTEGER REFERENCES pa_tareas_tipos(id),
            cultivo               TEXT,
            estado                TEXT NOT NULL DEFAULT 'pendiente_valorizar'
                                    CHECK(estado IN ('pendiente_valorizar','valorizado','anulado')),
            notas                 TEXT,
            cargado_por           INTEGER NOT NULL REFERENCES usuarios(id),
            creado_en             TEXT DEFAULT (datetime('now','localtime')),
            modificado_en         TEXT,
            modificado_por        INTEGER,
            anulado_en            TEXT,
            anulado_por           INTEGER,
            anulado_motivo        TEXT
          );
          INSERT INTO pa_asistencias_new SELECT * FROM pa_asistencias;
          DROP TABLE pa_asistencias;
          ALTER TABLE pa_asistencias_new RENAME TO pa_asistencias;
          CREATE INDEX IF NOT EXISTS idx_pa_asist_fecha    ON pa_asistencias(fecha);
          CREATE INDEX IF NOT EXISTS idx_pa_asist_estado   ON pa_asistencias(estado);
          CREATE INDEX IF NOT EXISTS idx_pa_asist_personal ON pa_asistencias(personal_id);
          CREATE INDEX IF NOT EXISTS idx_pa_asist_contra   ON pa_asistencias(contratista_id);
          CREATE INDEX IF NOT EXISTS idx_pa_asist_lote     ON pa_asistencias(lote_id);
        `);
      });
      rebuild();
      db.pragma('foreign_keys = ON');
      console.log('[PA] pa_asistencias.lote_id ahora nullable (MO general sin lote)');
    }
  } catch (e) {
    try { db.pragma('foreign_keys = ON'); } catch (_) {}
    console.error('[PA] Error en rebuild pa_asistencias (lote_id nullable):', e.message);
  }
})();

// ═══════════════════════════════════════════════════════════════════════════
// VACIADO TOTAL — Órdenes de Aplicación (PC) (OK Andy + ingeniera)
// ───────────────────────────────────────────────────────────────────────────
// One-shot guardado por flag en sistema_flags ('wipe_ordenes_pc_v1'): vacía TODAS las
// órdenes de aplicación y REVIERTE todo lo que arrastran — "como si nunca hubieran
// existido". BETA sin datos productivos (arrancan jul-2026).
//   1) Backup VACUUM INTO ANTES (aborta sin tocar nada si no puede crearlo; reintenta).
//   2) En una transacción: RESTAURA el stock descontado (pa_insumos += Σ cantidad_real —
//      el stock SUBE, no va a cero), borra costos (fert/agro de aplicaciones), borra
//      mov_stock 'aplicacion', desvincula combustible, y borra aplicaciones/items/lotes/órdenes.
//   3) Marca el flag → idempotente: no re-corre NI re-vacía órdenes creadas después.
// Las órdenes NO generan asientos/movimientos contables → ese efecto es 0 (verificado).
// Borra hijos antes que el padre (FK-safe). Validado con node:sqlite.
// ═══════════════════════════════════════════════════════════════════════════
(function vaciarOrdenesAplicacionPC() {
  const FLAG = 'wipe_ordenes_pc_v1';
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sistema_flags (key TEXT PRIMARY KEY, valor TEXT, ejecutado_en TEXT DEFAULT (datetime('now','localtime')))`);
    if (db.prepare("SELECT 1 FROM sistema_flags WHERE key = ?").get(FLAG)) return; // ya ejecutado

    const totalOrdenes = db.prepare("SELECT COUNT(*) AS n FROM pa_ordenes").get().n;
    if (totalOrdenes === 0) {
      db.prepare("INSERT OR REPLACE INTO sistema_flags (key, valor) VALUES (?, ?)").run(FLAG, 'sin-ordenes');
      return;
    }

    // 1) Backup de red ANTES del borrado. Si falla → abortar sin tocar nada (reintenta en el próximo deploy).
    const backupPath = path.join(path.dirname(dbPath), 'clientes-pre-wipe-ordenes.db');
    if (!fs.existsSync(backupPath)) {
      try { db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`); console.log('[WIPE-OA] Backup creado:', backupPath); }
      catch (e) { console.error('[WIPE-OA] No se pudo crear el backup — ABORTANDO (no se borró nada):', e.message); return; }
    }

    // 2) Reversa transaccional
    const stats = {};
    db.transaction(() => {
      // Restaurar (sumar) el stock descontado por cada aplicación — ANTES de borrar aplicaciones
      db.exec(`UPDATE pa_insumos SET stock_actual = stock_actual + COALESCE(
                 (SELECT SUM(a.cantidad_real) FROM pa_aplicaciones a WHERE a.insumo_id = pa_insumos.id), 0)`);
      // Costos por lote generados por aplicaciones (fert/agro con referencia a una aplicación)
      stats.costos  = db.prepare(`DELETE FROM pa_costos_lote WHERE categoria IN ('fertilizante','agroquimico') AND referencia_id IN (SELECT id FROM pa_aplicaciones)`).run().changes;
      // Movimientos de stock de aplicaciones
      stats.movStock = db.prepare(`DELETE FROM pa_movimientos_stock WHERE motivo='aplicacion'`).run().changes;
      // Desvincular combustible (NO se borra el movimiento)
      stats.comb     = db.prepare(`UPDATE pa_combustible_movimientos SET orden_id=NULL WHERE orden_id IS NOT NULL`).run().changes;
      // Borrar aplicaciones, ítems, lotes y órdenes (hijos → padre)
      stats.aplic    = db.prepare(`DELETE FROM pa_aplicaciones`).run().changes;
      stats.items    = db.prepare(`DELETE FROM pa_ordenes_items`).run().changes;
      stats.lotes    = db.prepare(`DELETE FROM pa_ordenes_lotes`).run().changes;
      stats.ordenes  = db.prepare(`DELETE FROM pa_ordenes`).run().changes;
    })();

    db.prepare("INSERT OR REPLACE INTO sistema_flags (key, valor) VALUES (?, ?)").run(FLAG, JSON.stringify(stats));
    console.log('[WIPE-OA] Órdenes de aplicación vaciadas:', JSON.stringify(stats));
  } catch (e) {
    console.error('[WIPE-OA] Error vaciando órdenes de aplicación:', e.message);
  }
})();

// ── MIGRACIÓN: Títulos del plan de cuentas (X.XX.XX) ────────────────────────
// Introduce un tercer nivel jerárquico entre Sección (X.XX) y Cuenta (X.XX.XX.XXXX).
// Los títulos agrupan cuentas dentro de una sección y NO son imputables.
// Idempotente: CREATE TABLE IF NOT EXISTS + columna con guard PRAGMA.
(function migrarTitulos() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pa_cuentas_titulos (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        sociedad_id     INTEGER NOT NULL REFERENCES sociedades(id),
        seccion_id      INTEGER NOT NULL REFERENCES pa_cuentas_secciones(id),
        codigo          TEXT NOT NULL,
        nombre          TEXT NOT NULL,
        orden           INTEGER NOT NULL DEFAULT 0,
        activo          INTEGER NOT NULL DEFAULT 1,
        creado_en       TEXT DEFAULT (datetime('now','localtime')),
        actualizado_en  TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(sociedad_id, codigo)
      );
      CREATE INDEX IF NOT EXISTS idx_pa_titulos_seccion  ON pa_cuentas_titulos(seccion_id);
      CREATE INDEX IF NOT EXISTS idx_pa_titulos_sociedad ON pa_cuentas_titulos(sociedad_id);
      CREATE INDEX IF NOT EXISTS idx_pa_titulos_codigo   ON pa_cuentas_titulos(codigo);
    `);
    console.log('[PA] pa_cuentas_titulos: tabla lista');
  } catch(e) { console.error('[PA] Error creando pa_cuentas_titulos:', e.message); }

  // Agregar titulo_id a pa_cuentas (nullable → compatible con cuentas existentes)
  try {
    const cols = db.prepare("PRAGMA table_info(pa_cuentas)").all().map(c => c.name);
    if (!cols.includes('titulo_id')) {
      db.exec("ALTER TABLE pa_cuentas ADD COLUMN titulo_id INTEGER REFERENCES pa_cuentas_titulos(id)");
      console.log('[PA] pa_cuentas.titulo_id agregado');
    }
  } catch(e) { console.error('[PA] Error agregando titulo_id a pa_cuentas:', e.message); }
})();

// ── MIGRACIÓN: Asiento modelo por insumo (facturas de bienes) ───────────────
// Cada insumo puede tener un asiento modelo asignado (como los proveedores).
// Para facturas de BIENES el asiento sale del modelo del insumo, no del proveedor.
// El insumo operativo vive en db.js, pero el modelo vive acá (dbPa), así que la
// vinculación se guarda en esta tabla de mapeo por insumo_id.
(function migrarInsumoModelo() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pa_insumo_modelo (
        insumo_id          INTEGER PRIMARY KEY,
        asiento_modelo_id  INTEGER REFERENCES adm_asientos_modelo(id),
        actualizado_en     TEXT DEFAULT (datetime('now','localtime'))
      );
    `);
    console.log('[PA] pa_insumo_modelo: tabla lista');
  } catch(e) { console.error('[PA] Error creando pa_insumo_modelo:', e.message); }
})();

// ── MIGRACIÓN: Normalizar códigos de cuentas al formato X.XX.XX.XXXX ─────────
// Renumera automáticamente las cuentas imputables cuyo código no respeta el
// formato de 4 niveles, o que pisa el código de un título/sección. La cuenta se
// renumera al próximo código libre DENTRO de su título (el título/sección manda).
// El ID de la cuenta NO cambia, así que los asientos vinculados se mantienen.
// Idempotente: las cuentas ya válidas se omiten. Deja log de cada cambio.
(function migrarCodigosCuentas() {
  try {
    const validRe = /^\d\.\d{2}\.\d{2}\.\d{4}$/;
    const cuentas = db.prepare('SELECT id, codigo, nombre, sociedad_id, seccion_id, titulo_id FROM pa_cuentas').all();
    let arregladas = 0, omitidas = 0;
    for (const c of cuentas) {
      const cod = String(c.codigo);
      const colT = db.prepare('SELECT 1 FROM pa_cuentas_titulos WHERE codigo = ? AND sociedad_id = ?').get(cod, c.sociedad_id);
      const colS = db.prepare('SELECT 1 FROM pa_cuentas_secciones WHERE codigo = ? AND sociedad_id = ?').get(cod, c.sociedad_id);
      const malFormato = !validRe.test(cod);
      if (!malFormato && !colT && !colS) continue; // ya está bien

      // Resolver el prefijo del título (X.XX.XX) bajo el cual va la cuenta
      let prefijo = null, tituloId = c.titulo_id || null;
      if (tituloId) {
        const t = db.prepare('SELECT codigo FROM pa_cuentas_titulos WHERE id = ?').get(tituloId);
        if (t) prefijo = String(t.codigo);
      }
      if (!prefijo) {
        const partes = cod.split('.');
        if (partes.length >= 3) {
          const pref3 = partes.slice(0, 3).join('.');
          const t = db.prepare('SELECT id, codigo FROM pa_cuentas_titulos WHERE codigo = ? AND sociedad_id = ?').get(pref3, c.sociedad_id);
          if (t) { prefijo = String(t.codigo); tituloId = t.id; }
        }
      }
      if (!prefijo) {
        console.warn(`[PA-MIGRACION] Cuenta #${c.id} "${c.nombre}" (${cod}) sin título resoluble — se OMITE, revisar a mano`);
        omitidas++;
        continue;
      }

      // Próximo correlativo libre de 4 dígitos bajo el prefijo
      const hermanas = db.prepare("SELECT codigo FROM pa_cuentas WHERE codigo LIKE ? AND id != ?").all(prefijo + '.%', c.id);
      let max = 0;
      hermanas.forEach(h => {
        const p = String(h.codigo).split('.');
        if (p.length === 4) { const u = parseInt(p[3], 10); if (Number.isInteger(u) && u > max) max = u; }
      });
      let n = max + 1, nuevo = null;
      do {
        nuevo = prefijo + '.' + String(n).padStart(4, '0');
        const choca = db.prepare('SELECT 1 FROM pa_cuentas WHERE codigo = ? AND sociedad_id = ? AND id != ?').get(nuevo, c.sociedad_id, c.id);
        if (!choca) break;
        n++;
      } while (n < 10000);

      db.prepare("UPDATE pa_cuentas SET codigo = ?, titulo_id = COALESCE(?, titulo_id), actualizado_en = datetime('now','localtime') WHERE id = ?")
        .run(nuevo, tituloId, c.id);
      console.log(`[PA-MIGRACION] Cuenta #${c.id} "${c.nombre}": ${cod} → ${nuevo}`);
      arregladas++;
    }
    if (arregladas || omitidas) {
      console.log(`[PA-MIGRACION] Normalización de códigos: ${arregladas} cuenta(s) renumeradas, ${omitidas} omitida(s).`);
    }
  } catch(e) { console.error('[PA-MIGRACION] Error normalizando códigos de cuentas:', e.message); }
})();

export { db };
export default db;
