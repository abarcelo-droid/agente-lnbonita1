// src/servicios/db_pa.js
// ── MÓDULO PRODUCCIÓN AGRÍCOLA — PUENTE CORDON SA ─────────────────────────
// Todas las tablas usan prefijo pa_ para no colisionar con La Niña Bonita

import db from './db.js';

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
    if (!cols.includes('red_agua')) {
      db.exec("ALTER TABLE pa_lotes ADD COLUMN red_agua TEXT CHECK(red_agua IN ('Norte','Sur','Ambas') OR red_agua IS NULL)");
      console.log("[PA] Columna red_agua agregada en pa_lotes");
    }
  } catch(e) { console.error('[PA] Error migrando pa_lotes:', e.message); }
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

export { db };
export default db;
