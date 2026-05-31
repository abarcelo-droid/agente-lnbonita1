// src/servicios/db_sg.js
// ── MÓDULO SAN GERÓNIMO — PUENTE CORDON SA ────────────────────────────────────
// Operatoria mayorista frutihortícola (compra a productores/importadores,
// venta a HORECA/súper/mayoristas/minoristas). Stand MCBA Nave 4, Puestos 2-4-6.
//
// Todas las tablas usan prefijo sg_ — universo INDEPENDIENTE del resto de la app.
// NO se vincula con pa_*/adm_*/fin_* (contable de Puente Cordón, fuera de alcance).
// Convención de auditoría del repo: creado_en / creado_por / modificado_en /
// modificado_por / activo / eliminado_en / eliminado_por_id (soft delete).
//
// El DDL completo (catálogo + compras + ventas) se crea acá en Fase 1 (tablas
// vacías) para que las FKs resuelvan desde el día 1. Las fases siguientes solo
// agregan endpoints + UI, no esquema.

import db from './db.js';

// ── CATÁLOGO ──────────────────────────────────────────────────────────────────

db.exec(`
  -- Productos (catálogo frutihortícola)
  CREATE TABLE IF NOT EXISTS sg_productos (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo                  TEXT NOT NULL UNIQUE,
    nombre                  TEXT NOT NULL,                       -- "Especie" en la UI
    variedad                TEXT,                                -- texto libre (nullable)
    familia                 TEXT CHECK(familia IN ('frutas','hortalizas_pesadas','hortalizas_livianas','hoja','otros')),
    unidad_base             TEXT NOT NULL DEFAULT 'kg' CHECK(unidad_base IN ('kg','unidad','atado')),
    vida_util_dias_default  INTEGER DEFAULT 7,
    activo                  INTEGER NOT NULL DEFAULT 1,
    creado_en               TEXT DEFAULT (datetime('now','localtime')),
    creado_por              INTEGER,
    modificado_en           TEXT,
    modificado_por          INTEGER,
    eliminado_en            TEXT,
    eliminado_por_id        INTEGER
  );

  -- Presentaciones por producto (cajón, bolsa, atado…). factor_conversion = cuántas
  -- unidades_base equivale 1 presentación (ej. cajón 20kg → 20).
  CREATE TABLE IF NOT EXISTS sg_presentaciones (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id         INTEGER NOT NULL REFERENCES sg_productos(id),
    nombre              TEXT NOT NULL,
    factor_conversion   REAL NOT NULL DEFAULT 1,
    activo              INTEGER NOT NULL DEFAULT 1,
    creado_en           TEXT DEFAULT (datetime('now','localtime')),
    creado_por          INTEGER,
    modificado_en       TEXT,
    modificado_por      INTEGER,
    eliminado_en        TEXT,
    eliminado_por_id    INTEGER
  );

  -- Condiciones de pago (cabecera). Las cuotas explotan vencimientos al cerrar OC.
  CREATE TABLE IF NOT EXISTS sg_condiciones_pago (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre              TEXT NOT NULL,
    activo              INTEGER NOT NULL DEFAULT 1,
    creado_en           TEXT DEFAULT (datetime('now','localtime')),
    creado_por          INTEGER,
    modificado_en       TEXT,
    modificado_por      INTEGER,
    eliminado_en        TEXT,
    eliminado_por_id    INTEGER
  );

  -- Cuotas de una condición de pago (suman 100% por condición).
  CREATE TABLE IF NOT EXISTS sg_condiciones_pago_cuotas (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    condicion_pago_id   INTEGER NOT NULL REFERENCES sg_condiciones_pago(id),
    orden               INTEGER NOT NULL DEFAULT 1,
    porcentaje          REAL NOT NULL,
    base_calculo        TEXT NOT NULL DEFAULT 'fecha_factura' CHECK(base_calculo IN ('fecha_oc','fecha_recepcion','fecha_factura','al_pedido')),
    dias_offset         INTEGER NOT NULL DEFAULT 0
  );

  -- Proveedores SG (padrón propio). adm_proveedor_id: gancho NULLABLE para una
  -- eventual reconciliación de padrones entre sociedades. SIN uso ni FK en V1.
  CREATE TABLE IF NOT EXISTS sg_proveedores (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    razon_social                TEXT NOT NULL,
    cuit                        TEXT,
    tipo                        TEXT CHECK(tipo IN ('productor','importador','mayorista_regional','otros')),
    categoria_fiscal            TEXT CHECK(categoria_fiscal IN ('resp_inscripto','monotributista','exento','no_inscripto')),
    tipo_fiscal_habitual        TEXT DEFAULT 'factura_a' CHECK(tipo_fiscal_habitual IN ('factura_a','factura_b','liquidacion')),
    condicion_pago_habitual_id  INTEGER REFERENCES sg_condiciones_pago(id),
    comercial_responsable_id    INTEGER,
    localidad                   TEXT,
    provincia                   TEXT,
    telefono                    TEXT,
    email                       TEXT,
    observaciones               TEXT,
    adm_proveedor_id            INTEGER,   -- TODO V1.5: reconciliación con padrón adm (sin uso en V1)
    activo                      INTEGER NOT NULL DEFAULT 1,
    creado_en                   TEXT DEFAULT (datetime('now','localtime')),
    creado_por                  INTEGER,
    modificado_en               TEXT,
    modificado_por              INTEGER,
    eliminado_en                TEXT,
    eliminado_por_id            INTEGER
  );

  -- Clientes SG (HORECA, súper, mayoristas regionales, minoristas, consumidor final).
  CREATE TABLE IF NOT EXISTS sg_clientes (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    razon_social                TEXT NOT NULL,
    cuit                        TEXT,
    tipo                        TEXT CHECK(tipo IN ('horeca','supermercado','mayorista_regional','minorista','consumidor_final','otros')),
    categoria_fiscal            TEXT CHECK(categoria_fiscal IN ('resp_inscripto','monotributista','exento','no_inscripto')),
    tipo_fiscal_habitual        TEXT DEFAULT 'factura_a' CHECK(tipo_fiscal_habitual IN ('factura_a','factura_b','liquidacion')),
    condicion_pago_habitual_id  INTEGER REFERENCES sg_condiciones_pago(id),
    comercial_responsable_id    INTEGER,
    modalidad_pedido            TEXT DEFAULT 'mixto' CHECK(modalidad_pedido IN ('con_pedido','sobre_stock','mixto')),
    limite_credito              REAL NOT NULL DEFAULT 0,
    localidad                   TEXT,
    provincia                   TEXT,
    direccion_entrega           TEXT,
    telefono                    TEXT,
    email                       TEXT,
    observaciones               TEXT,
    activo                      INTEGER NOT NULL DEFAULT 1,
    creado_en                   TEXT DEFAULT (datetime('now','localtime')),
    creado_por                  INTEGER,
    modificado_en               TEXT,
    modificado_por              INTEGER,
    eliminado_en                TEXT,
    eliminado_por_id            INTEGER
  );
`);

// ── OPERATORIA DE COMPRA ────────────────────────────────────────────────────────

db.exec(`
  -- Órdenes de compra. numero auto: SG-OC-YYYYMMDD-NNNN
  CREATE TABLE IF NOT EXISTS sg_oc (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    numero                      TEXT UNIQUE,
    modalidad                   TEXT NOT NULL DEFAULT 'normal' CHECK(modalidad IN ('normal','rapida','retroactiva','finca_propia')),
    proveedor_id                INTEGER REFERENCES sg_proveedores(id),
    tipo_fiscal                 TEXT DEFAULT 'factura_a' CHECK(tipo_fiscal IN ('factura_a','factura_b','liquidacion')),
    tipo_precio                 TEXT NOT NULL DEFAULT 'firme' CHECK(tipo_precio IN ('firme','pizarra')),
    condicion_pago_id           INTEGER REFERENCES sg_condiciones_pago(id),
    fecha_oc                    TEXT,
    fecha_recepcion_estimada    TEXT,
    comercial_id                INTEGER,
    estado                      TEXT NOT NULL DEFAULT 'borrador' CHECK(estado IN ('borrador','abierta','recibida_parcial','recibida_total','cerrada','anulada')),
    observaciones               TEXT,
    total_estimado_kg           REAL DEFAULT 0,
    total_estimado_monto        REAL DEFAULT 0,
    activo                      INTEGER NOT NULL DEFAULT 1,
    creado_en                   TEXT DEFAULT (datetime('now','localtime')),
    creado_por                  INTEGER,
    modificado_en               TEXT,
    modificado_por              INTEGER,
    eliminado_en                TEXT,
    eliminado_por_id            INTEGER
  );

  CREATE TABLE IF NOT EXISTS sg_oc_items (
    id                              INTEGER PRIMARY KEY AUTOINCREMENT,
    oc_id                           INTEGER NOT NULL REFERENCES sg_oc(id),
    producto_id                     INTEGER NOT NULL REFERENCES sg_productos(id),
    presentacion_id                 INTEGER REFERENCES sg_presentaciones(id),
    cantidad_estimada_presentaciones REAL DEFAULT 0,
    kg_estimados                    REAL DEFAULT 0,
    precio_estimado_por_kg          REAL,    -- NULL si tipo_precio=pizarra
    observaciones_item              TEXT
  );

  -- Recepciones. numero_recepcion auto: SG-REC-YYYYMMDD-NNNN
  CREATE TABLE IF NOT EXISTS sg_recepciones (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    oc_id                   INTEGER NOT NULL REFERENCES sg_oc(id),
    numero_recepcion        TEXT UNIQUE,
    fecha_recepcion         TEXT,
    recibido_por            INTEGER,
    numero_remito_proveedor TEXT,
    observaciones           TEXT,
    activo                  INTEGER NOT NULL DEFAULT 1,
    creado_en               TEXT DEFAULT (datetime('now','localtime')),
    creado_por              INTEGER,
    modificado_en           TEXT,
    modificado_por          INTEGER,
    eliminado_en            TEXT,
    eliminado_por_id        INTEGER
  );

  -- Lotes (unidad de costeo y trazabilidad). codigo_lote auto: SG-LT-YYYYMMDD-NNNN
  -- recepcion_id/oc_item_id NULL solo para finca_propia (stub V1, viene de PA).
  CREATE TABLE IF NOT EXISTS sg_lotes (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo_lote                 TEXT NOT NULL UNIQUE,
    recepcion_id                INTEGER REFERENCES sg_recepciones(id),
    oc_item_id                  INTEGER REFERENCES sg_oc_items(id),
    producto_id                 INTEGER NOT NULL REFERENCES sg_productos(id),
    kg_reales                   REAL NOT NULL DEFAULT 0,
    precio_unitario_kg          REAL,    -- NULL en pizarra hasta cerrar precio
    costo_base                  REAL DEFAULT 0,
    calidad                     TEXT CHECK(calidad IN ('primera','segunda','tercera')),
    calibre                     TEXT,
    origen                      TEXT,
    fecha_ingreso               TEXT,
    fecha_vencimiento_estimada  TEXT,
    estado                      TEXT NOT NULL DEFAULT 'disponible' CHECK(estado IN ('disponible','reservado','despachado_parcial','despachado_total','bajado')),
    destino_baja                TEXT CHECK(destino_baja IN ('venta','liquidacion','donacion','disposal')),
    receptor_donacion           TEXT,
    costo_final                 REAL DEFAULT 0,
    activo                      INTEGER NOT NULL DEFAULT 1,
    creado_en                   TEXT DEFAULT (datetime('now','localtime')),
    creado_por                  INTEGER,
    modificado_en               TEXT,
    modificado_por              INTEGER,
    eliminado_en                TEXT,
    eliminado_por_id            INTEGER
  );

  -- Gastos directos imputados a un lote específico (flete, comisión, descarga…).
  CREATE TABLE IF NOT EXISTS sg_gastos_directos_lote (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id             INTEGER NOT NULL REFERENCES sg_lotes(id),
    tipo_gasto          TEXT CHECK(tipo_gasto IN ('flete','comision_productor','descarga_especifica','acondicionamiento','otros')),
    proveedor_id_gasto  INTEGER REFERENCES sg_proveedores(id),
    monto               REAL NOT NULL DEFAULT 0,
    fecha               TEXT,
    observaciones       TEXT,
    activo              INTEGER NOT NULL DEFAULT 1,
    creado_en           TEXT DEFAULT (datetime('now','localtime')),
    creado_por          INTEGER,
    modificado_en       TEXT,
    modificado_por      INTEGER,
    eliminado_en        TEXT,
    eliminado_por_id    INTEGER
  );

  -- Gastos globales del período (prorrateo por kg sobre el total del período).
  CREATE TABLE IF NOT EXISTS sg_gastos_globales_periodo (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    periodo             TEXT NOT NULL,    -- YYYY-MM
    tipo_gasto          TEXT CHECK(tipo_gasto IN ('luz_camara','sueldo_descarga','iibb','alquiler_puesto','otros')),
    monto               REAL NOT NULL DEFAULT 0,
    fecha               TEXT,
    observaciones       TEXT,
    activo              INTEGER NOT NULL DEFAULT 1,
    creado_en           TEXT DEFAULT (datetime('now','localtime')),
    creado_por          INTEGER,
    modificado_en       TEXT,
    modificado_por      INTEGER,
    eliminado_en        TEXT,
    eliminado_por_id    INTEGER
  );

  -- Vencimientos de pago a proveedor (explotados de las cuotas al cerrar OC /
  -- al cerrar precio en pizarra).
  CREATE TABLE IF NOT EXISTS sg_oc_vencimientos (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    oc_id               INTEGER NOT NULL REFERENCES sg_oc(id),
    cuota_orden         INTEGER NOT NULL DEFAULT 1,
    porcentaje          REAL,
    monto               REAL,
    fecha_vencimiento   TEXT,
    pagado              INTEGER NOT NULL DEFAULT 0,
    fecha_pago          TEXT,
    monto_pagado        REAL,
    pagado_por          INTEGER,
    observaciones       TEXT
  );
`);

// ── OPERATORIA DE VENTA ─────────────────────────────────────────────────────────

db.exec(`
  -- Pedidos. numero auto: SG-PED-YYYYMMDD-NNNN
  CREATE TABLE IF NOT EXISTS sg_pedidos (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    numero                      TEXT UNIQUE,
    cliente_id                  INTEGER REFERENCES sg_clientes(id),
    comercial_id                INTEGER,
    tipo_fiscal                 TEXT DEFAULT 'factura_a' CHECK(tipo_fiscal IN ('factura_a','factura_b','liquidacion')),
    condicion_pago_id           INTEGER REFERENCES sg_condiciones_pago(id),
    fecha_pedido                TEXT,
    fecha_entrega_solicitada    TEXT,
    direccion_entrega           TEXT,
    estado                      TEXT NOT NULL DEFAULT 'borrador' CHECK(estado IN ('borrador','confirmado','despachado_parcial','despachado_total','facturado','anulado')),
    observaciones               TEXT,
    activo                      INTEGER NOT NULL DEFAULT 1,
    creado_en                   TEXT DEFAULT (datetime('now','localtime')),
    creado_por                  INTEGER,
    modificado_en               TEXT,
    modificado_por              INTEGER,
    eliminado_en                TEXT,
    eliminado_por_id            INTEGER
  );

  CREATE TABLE IF NOT EXISTS sg_pedido_items (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id               INTEGER NOT NULL REFERENCES sg_pedidos(id),
    producto_id             INTEGER NOT NULL REFERENCES sg_productos(id),
    presentacion_id         INTEGER REFERENCES sg_presentaciones(id),
    cantidad_presentaciones REAL DEFAULT 0,
    kg_solicitados          REAL DEFAULT 0,
    precio_por_kg           REAL DEFAULT 0,
    subtotal                REAL DEFAULT 0
  );

  -- Despachos. numero auto: SG-DESP-YYYYMMDD-NNNN. pedido_id NULL = venta directa.
  CREATE TABLE IF NOT EXISTS sg_despachos (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    numero              TEXT UNIQUE,
    pedido_id           INTEGER REFERENCES sg_pedidos(id),
    cliente_id          INTEGER REFERENCES sg_clientes(id),
    comercial_id        INTEGER,
    fecha_despacho      TEXT,
    transporte          TEXT CHECK(transporte IN ('propio','cliente','tercero')),
    transportista       TEXT,
    chofer              TEXT,
    dominio             TEXT,
    estado              TEXT NOT NULL DEFAULT 'preparado' CHECK(estado IN ('preparado','despachado','entregado','rechazado_parcial','rechazado_total')),
    observaciones       TEXT,
    activo              INTEGER NOT NULL DEFAULT 1,
    creado_en           TEXT DEFAULT (datetime('now','localtime')),
    creado_por          INTEGER,
    modificado_en       TEXT,
    modificado_por      INTEGER,
    eliminado_en        TEXT,
    eliminado_por_id    INTEGER
  );

  -- Items de despacho. lote_id = CLAVE de trazabilidad forward.
  CREATE TABLE IF NOT EXISTS sg_despacho_items (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    despacho_id             INTEGER NOT NULL REFERENCES sg_despachos(id),
    lote_id                 INTEGER NOT NULL REFERENCES sg_lotes(id),
    producto_id             INTEGER REFERENCES sg_productos(id),
    presentacion_id         INTEGER REFERENCES sg_presentaciones(id),
    cantidad_presentaciones REAL DEFAULT 0,
    kg_despachados          REAL DEFAULT 0,
    precio_por_kg           REAL DEFAULT 0,
    subtotal                REAL DEFAULT 0,
    margen_estimado         REAL DEFAULT 0
  );
`);

// ── ÍNDICES (trazabilidad / FEFO / joins frecuentes) ─────────────────────────────

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sg_presentaciones_producto ON sg_presentaciones(producto_id);
  CREATE INDEX IF NOT EXISTS idx_sg_oc_proveedor            ON sg_oc(proveedor_id);
  CREATE INDEX IF NOT EXISTS idx_sg_oc_items_oc             ON sg_oc_items(oc_id);
  CREATE INDEX IF NOT EXISTS idx_sg_recepciones_oc          ON sg_recepciones(oc_id);
  CREATE INDEX IF NOT EXISTS idx_sg_lotes_recepcion         ON sg_lotes(recepcion_id);
  CREATE INDEX IF NOT EXISTS idx_sg_lotes_oc_item           ON sg_lotes(oc_item_id);
  CREATE INDEX IF NOT EXISTS idx_sg_lotes_producto          ON sg_lotes(producto_id);
  CREATE INDEX IF NOT EXISTS idx_sg_lotes_venc              ON sg_lotes(estado, fecha_vencimiento_estimada);
  CREATE INDEX IF NOT EXISTS idx_sg_gastos_dir_lote         ON sg_gastos_directos_lote(lote_id);
  CREATE INDEX IF NOT EXISTS idx_sg_gastos_glob_periodo     ON sg_gastos_globales_periodo(periodo);
  CREATE INDEX IF NOT EXISTS idx_sg_oc_venc_oc              ON sg_oc_vencimientos(oc_id);
  CREATE INDEX IF NOT EXISTS idx_sg_cuotas_condicion        ON sg_condiciones_pago_cuotas(condicion_pago_id);
  CREATE INDEX IF NOT EXISTS idx_sg_pedido_items_pedido     ON sg_pedido_items(pedido_id);
  CREATE INDEX IF NOT EXISTS idx_sg_despacho_items_despacho ON sg_despacho_items(despacho_id);
  CREATE INDEX IF NOT EXISTS idx_sg_despacho_items_lote     ON sg_despacho_items(lote_id);
`);

// ── MIGRACIÓN idempotente: sg_productos → +'variedad' y nuevas opciones de familia ──
// El CHECK de familia no se puede cambiar con ALTER, así que reconstruimos la tabla
// (patrón estándar SQLite: FK off → tabla nueva → copia → drop → rename). BETA: se
// mapean los valores viejos de familia a los nuevos. Corre solo una vez (cuando aún
// no existe la columna 'variedad'). Mantiene los ids (las FKs de otras tablas siguen válidas).
try {
  const cols = db.prepare("PRAGMA table_info(sg_productos)").all().map(c => c.name);
  if (!cols.includes('variedad')) {
    db.pragma('foreign_keys = OFF');
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE sg_productos_new (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          codigo                  TEXT NOT NULL UNIQUE,
          nombre                  TEXT NOT NULL,
          variedad                TEXT,
          familia                 TEXT CHECK(familia IN ('frutas','hortalizas_pesadas','hortalizas_livianas','hoja','otros')),
          unidad_base             TEXT NOT NULL DEFAULT 'kg' CHECK(unidad_base IN ('kg','unidad','atado')),
          vida_util_dias_default  INTEGER DEFAULT 7,
          activo                  INTEGER NOT NULL DEFAULT 1,
          creado_en               TEXT DEFAULT (datetime('now','localtime')),
          creado_por              INTEGER,
          modificado_en           TEXT,
          modificado_por          INTEGER,
          eliminado_en            TEXT,
          eliminado_por_id        INTEGER
        );
        INSERT INTO sg_productos_new
          (id, codigo, nombre, variedad, familia, unidad_base, vida_util_dias_default,
           activo, creado_en, creado_por, modificado_en, modificado_por, eliminado_en, eliminado_por_id)
        SELECT id, codigo, nombre, NULL,
          CASE familia
            WHEN 'hortalizas'    THEN 'hortalizas_pesadas'
            WHEN 'verduras_hoja' THEN 'hoja'
            WHEN 'aromaticas'    THEN 'otros'
            WHEN 'frutas'        THEN 'frutas'
            WHEN 'otros'         THEN 'otros'
            ELSE NULL
          END,
          unidad_base, vida_util_dias_default,
          activo, creado_en, creado_por, modificado_en, modificado_por, eliminado_en, eliminado_por_id
        FROM sg_productos;
        DROP TABLE sg_productos;
        ALTER TABLE sg_productos_new RENAME TO sg_productos;
      `);
    });
    rebuild();
    db.pragma('foreign_keys = ON');
    console.log('[DB] SG sg_productos migrado (+variedad, familia: frutas/hortalizas_pesadas/hortalizas_livianas/hoja/otros)');
  }
} catch (e) {
  try { db.pragma('foreign_keys = ON'); } catch (_) {}
  console.error('[DB] SG migración sg_productos:', e.message);
}

// ── BACKFILL idempotente: margen_estimado por kg ────────────────────────────────
// Bug F4: el margen se grababa como subtotal − kg_despachados × costo_final, pero
// costo_final es el costo TOTAL del lote, no por kg. El front del modal ya calculaba
// bien (costo_final / kg_reales); solo el valor PERSISTIDO quedaba absurdo.
// Este UPDATE recalcula con el costo por kg y es self-healing (no-op una vez correcto).
try {
  db.exec(`
    UPDATE sg_despacho_items
    SET margen_estimado = subtotal - kg_despachados * (
          SELECT COALESCE(l.costo_final,0) / NULLIF(l.kg_reales,0)
          FROM sg_lotes l WHERE l.id = sg_despacho_items.lote_id)
    WHERE EXISTS (SELECT 1 FROM sg_lotes l WHERE l.id = sg_despacho_items.lote_id AND l.kg_reales > 0)
      AND ABS(margen_estimado - (subtotal - kg_despachados * (
          SELECT COALESCE(l.costo_final,0) / NULLIF(l.kg_reales,0)
          FROM sg_lotes l WHERE l.id = sg_despacho_items.lote_id))) > 0.01;
  `);
} catch (e) {
  console.warn('[DB] SG backfill margen_estimado:', e.message);
}

console.log('[DB] Módulo San Gerónimo (sg_*) inicializado');

export default db;
