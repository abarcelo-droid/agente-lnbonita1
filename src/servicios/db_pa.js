// src/servicios/db_pa.js
// ── MÓDULO PRODUCCIÓN AGRÍCOLA — PUENTE CORDON SA ─────────────────────────
// Todas las tablas usan prefijo pa_ para no colisionar con La Niña Bonita

import db from './db.js';
import fs from 'fs';
import path from 'path';

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
    creado_en     TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Lotes incluidos en la orden
  CREATE TABLE IF NOT EXISTS pa_ordenes_lotes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    orden_id  INTEGER NOT NULL REFERENCES pa_ordenes(id),
    lote_id   INTEGER NOT NULL REFERENCES pa_lotes(id)
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

// ── MIGRACIÓN: columna tipo en pa_campañas ────────────────────────────────
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_campañas)").all().map(c => c.name);
    if (!cols.includes('tipo')) {
      db.exec("ALTER TABLE pa_campañas ADD COLUMN tipo TEXT DEFAULT 'verano' CHECK(tipo IN ('verano','invierno'))");
      console.log("[PA] Columna tipo agregada en pa_campañas");
    }
  } catch(e) { console.error('[PA] Error migrando tipo campaña:', e.message); }
})();

// ── MIGRACIÓN: campañas históricas ────────────────────────────────────────
(function migrarCampañasHistoricas() {
  try {
    // Campañas de verano (Jul→Jun)
    const verano = [
      ['2021/22', '2021-07-01', '2022-06-30'],
      ['2022/23', '2022-07-01', '2023-06-30'],
      ['2023/24', '2023-07-01', '2024-06-30'],
      ['2024/25', '2024-07-01', '2025-06-30'],
      ['2026/27', '2026-07-01', '2027-06-30'],
    ];
    for (const [nombre, inicio, fin] of verano) {
      db.prepare("INSERT OR IGNORE INTO pa_campañas (nombre, fecha_inicio, fecha_fin, activa, tipo) VALUES (?,?,?,0,'verano')")
        .run(nombre, inicio, fin);
    }
    // Campañas de invierno (May→Oct aprox)
    const invierno = [
      ['Inv 2022', '2022-05-01', '2022-10-31'],
      ['Inv 2023', '2023-05-01', '2023-10-31'],
      ['Inv 2024', '2024-05-01', '2024-10-31'],
      ['Inv 2025', '2025-05-01', '2025-10-31'],
      ['Inv 2026', '2026-05-01', '2026-10-31'],
    ];
    for (const [nombre, inicio, fin] of invierno) {
      db.prepare("INSERT OR IGNORE INTO pa_campañas (nombre, fecha_inicio, fecha_fin, activa, tipo) VALUES (?,?,?,0,'invierno')")
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

  -- Trabajadores
  CREATE TABLE IF NOT EXISTS pa_trabajadores (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre                TEXT NOT NULL,
    dni                   TEXT,
    cuadrilla_habitual_id INTEGER REFERENCES pa_cuadrillas(id),
    tipo_relacion         TEXT NOT NULL DEFAULT 'fijo' CHECK(tipo_relacion IN ('fijo','contratista')),
    jornal_base           REAL DEFAULT 0,
    unidad_jornal         TEXT DEFAULT 'dia' CHECK(unidad_jornal IN ('dia','hora','ha','unidad')),
    activo                INTEGER DEFAULT 1,
    notas                 TEXT,
    creado_en             TEXT DEFAULT (datetime('now','localtime'))
  );

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

  -- Partes de trabajo (cabecera)
  CREATE TABLE IF NOT EXISTS pa_partes_trabajo (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha             TEXT NOT NULL DEFAULT (date('now','localtime')),
    cuadrilla_id      INTEGER REFERENCES pa_cuadrillas(id),
    lote_id           INTEGER NOT NULL REFERENCES pa_lotes(id),
    tarea_tipo_id     INTEGER NOT NULL REFERENCES pa_tareas_tipos(id),
    modo_registro     TEXT NOT NULL DEFAULT 'cuadrilla' CHECK(modo_registro IN ('cuadrilla','individual')),
    cant_trabajadores INTEGER,      -- solo si modo=cuadrilla
    horas_total       REAL,          -- solo si modo=cuadrilla
    observaciones     TEXT,
    foto_path         TEXT,
    cargado_por       INTEGER REFERENCES usuarios(id),
    estado            TEXT DEFAULT 'pendiente_valorizar' CHECK(estado IN ('pendiente_valorizar','valorizado','anulado')),
    creado_en         TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Items de parte individual (solo si modo=individual, ej destajo)
  CREATE TABLE IF NOT EXISTS pa_partes_trabajo_items (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    parte_id           INTEGER NOT NULL REFERENCES pa_partes_trabajo(id) ON DELETE CASCADE,
    trabajador_id      INTEGER NOT NULL REFERENCES pa_trabajadores(id),
    horas              REAL,
    unidades_destajo   REAL,
    notas              TEXT
  );

  -- Valorización (la hace RRHH/oficina)
  CREATE TABLE IF NOT EXISTS pa_partes_valorizacion (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    parte_id             INTEGER NOT NULL UNIQUE REFERENCES pa_partes_trabajo(id),
    monto_total          REAL NOT NULL,
    detalle_json         TEXT,
    rubro_contable_id    INTEGER NOT NULL REFERENCES pa_rubros_contables(id),
    valorizado_por       INTEGER REFERENCES usuarios(id),
    fecha_valorizacion   TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_pa_partes_fecha ON pa_partes_trabajo(fecha);
  CREATE INDEX IF NOT EXISTS idx_pa_partes_lote ON pa_partes_trabajo(lote_id);
  CREATE INDEX IF NOT EXISTS idx_pa_partes_estado ON pa_partes_trabajo(estado);
  CREATE INDEX IF NOT EXISTS idx_pa_rubros_tipo_cult ON pa_rubros_contables(tipo_labor, cultivo);

  -- ═════════════════════════════════════════════════════════════════════
  -- FICHAJES DE CUADRILLA (sistema mñna/tarde con GPS)
  -- Reemplaza conceptualmente a pa_partes_trabajo. Admin asigna rubro y lote
  -- después de que el capataz fichó desde el celular.
  -- ═════════════════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS pa_fichajes_cuadrilla (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    capataz_id        INTEGER NOT NULL REFERENCES usuarios(id),
    cuadrilla_id      INTEGER NOT NULL REFERENCES pa_cuadrillas(id),
    fecha             TEXT NOT NULL DEFAULT (date('now','localtime')),
    momento           TEXT NOT NULL CHECK(momento IN ('entrada','salida')),
    hora_declarada    TEXT NOT NULL,  -- "HH:MM" lo que el capataz seleccionó
    hora_real         TEXT NOT NULL DEFAULT (datetime('now','localtime')),  -- cuándo apretó el botón
    tarea_texto       TEXT NOT NULL,  -- texto libre del capataz
    cant_personas     INTEGER,
    lat               REAL,
    lng               REAL,
    accuracy_metros   REAL,
    gps_ok            INTEGER DEFAULT 0,  -- 1 = tomó GPS, 0 = falló/timeout
    -- Campos que agrega admin desde el panel:
    lote_id           INTEGER REFERENCES pa_lotes(id),
    rubro_contable_id INTEGER REFERENCES pa_rubros_contables(id),
    estado            TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente','completado','anulado')),
    notas_admin       TEXT,
    completado_por    INTEGER REFERENCES usuarios(id),
    fecha_completado  TEXT,
    creado_en         TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_pa_fich_fecha ON pa_fichajes_cuadrilla(fecha DESC);
  CREATE INDEX IF NOT EXISTS idx_pa_fich_capataz ON pa_fichajes_cuadrilla(capataz_id, fecha DESC);
  CREATE INDEX IF NOT EXISTS idx_pa_fich_estado ON pa_fichajes_cuadrilla(estado);
`);

// ── MIGRACIÓN: agregar grupo_id a pa_trabajadores ──────────────────────────
// Grupo es distinto de cuadrilla: admin del trabajador vs. jornada operativa.
(function migrarTrabajadoresGrupo() {
  try {
    const cols = db.prepare("PRAGMA table_info(pa_trabajadores)").all().map(c => c.name);
    if (!cols.includes('grupo_id')) {
      db.exec("ALTER TABLE pa_trabajadores ADD COLUMN grupo_id INTEGER REFERENCES pa_grupos(id)");
      console.log('[PA] pa_trabajadores.grupo_id agregado');
    }
  } catch(e) { console.error('[PA] Error migrando pa_trabajadores.grupo_id:', e.message); }
})();

// ── SEED: grupo "Sin asignar" (fallback para trabajadores sin grupo) ───────
(function seedGrupoDefault() {
  try {
    const n = db.prepare("SELECT COUNT(*) as n FROM pa_grupos").get();
    if (n.n === 0) {
      db.prepare("INSERT INTO pa_grupos (nombre, descripcion) VALUES (?, ?)")
        .run('Sin asignar', 'Grupo por defecto — asignar uno real cuando se pueda');
      console.log('[PA] Grupo "Sin asignar" creado');
    }
    // Asignar trabajadores sin grupo al grupo "Sin asignar"
    const sinAsignar = db.prepare("SELECT id FROM pa_grupos WHERE nombre='Sin asignar'").get();
    if (sinAsignar) {
      const upd = db.prepare("UPDATE pa_trabajadores SET grupo_id = ? WHERE grupo_id IS NULL").run(sinAsignar.id);
      if (upd.changes > 0) console.log(`[PA] ${upd.changes} trabajadores asignados al grupo Sin asignar`);
    }
  } catch(e) { console.error('[PA] Error seed grupo default:', e.message); }
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
      // Personal — orden hijas → padres
      'pa_partes_valorizacion',
      'pa_partes_trabajo_items',
      'pa_partes_trabajo',
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

export { db };
export default db;
