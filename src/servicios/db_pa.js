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
  } catch(e) { console.error('[PA] Error migrando pa_compras:', e.message); }
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
`);

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

export { db };
export default db;
