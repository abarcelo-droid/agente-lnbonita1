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
  -- ── Taxonomía de productos: Familia → Especie → Variedad ──────────────────────
  -- Código jerárquico FF.EE.VV. Cada nivel tiene un 'codigo' INTEGER de 2 dígitos:
  -- familia = estable (seed fijo); especie = correlativo dentro de la familia;
  -- variedad = correlativo dentro de la especie. Se autogeneran (patrón plan de
  -- cuentas: max(codigo)+1 dentro del padre). Editables/agregables desde Catálogo.
  CREATE TABLE IF NOT EXISTS sg_familias (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo            INTEGER NOT NULL UNIQUE,            -- 2 díg estable (01..NN)
    nombre            TEXT NOT NULL,
    activo            INTEGER NOT NULL DEFAULT 1,
    creado_en         TEXT DEFAULT (datetime('now','localtime')),
    creado_por        INTEGER,
    modificado_en     TEXT,
    modificado_por    INTEGER,
    eliminado_en      TEXT,
    eliminado_por_id  INTEGER
  );

  CREATE TABLE IF NOT EXISTS sg_especies (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    familia_id        INTEGER NOT NULL REFERENCES sg_familias(id),
    codigo            INTEGER NOT NULL,                   -- 2 díg, correlativo dentro de la familia
    nombre            TEXT NOT NULL,
    activo            INTEGER NOT NULL DEFAULT 1,
    creado_en         TEXT DEFAULT (datetime('now','localtime')),
    creado_por        INTEGER,
    modificado_en     TEXT,
    modificado_por    INTEGER,
    eliminado_en      TEXT,
    eliminado_por_id  INTEGER,
    UNIQUE(familia_id, codigo)
  );

  CREATE TABLE IF NOT EXISTS sg_variedades (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    especie_id        INTEGER NOT NULL REFERENCES sg_especies(id),
    codigo            INTEGER NOT NULL,                   -- 2 díg, correlativo dentro de la especie
    nombre            TEXT NOT NULL,
    activo            INTEGER NOT NULL DEFAULT 1,
    creado_en         TEXT DEFAULT (datetime('now','localtime')),
    creado_por        INTEGER,
    modificado_en     TEXT,
    modificado_por    INTEGER,
    eliminado_en      TEXT,
    eliminado_por_id  INTEGER,
    UNIQUE(especie_id, codigo)
  );

  CREATE INDEX IF NOT EXISTS idx_sg_especies_familia   ON sg_especies(familia_id);
  CREATE INDEX IF NOT EXISTS idx_sg_variedades_especie ON sg_variedades(especie_id);

  -- Seed de familias (números fijos y estables; idempotente vía OR IGNORE). Migra
  -- la constante SG_FAMILIA del front a tabla. Nuevas familias se agregan desde el UI.
  INSERT OR IGNORE INTO sg_familias (codigo, nombre) VALUES
    (1, 'Frutas'), (2, 'Hortalizas Pesadas'), (3, 'Hortalizas Livianas'), (4, 'Hoja'), (5, 'Otros');

  -- Productos (catálogo frutihortícola). codigo = FF.EE.VV autogenerado desde la
  -- taxonomía. familia_id/especie_id/variedad_id son la fuente ESTRUCTURADA;
  -- familia/nombre/variedad quedan DENORMALIZADOS (display) — los consumen Compras,
  -- Lotes, Pedidos, Despachos y Reportes vía join por producto_id. No romper ese contrato.
  CREATE TABLE IF NOT EXISTS sg_productos (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo                  TEXT NOT NULL UNIQUE,                -- "FF.EE.VV" (ej. 02.05.00)
    familia_id              INTEGER REFERENCES sg_familias(id),
    especie_id              INTEGER REFERENCES sg_especies(id),
    variedad_id             INTEGER REFERENCES sg_variedades(id),
    nombre                  TEXT NOT NULL,                       -- denormalizado = especie.nombre ("Especie" en UI)
    variedad                TEXT,                                -- denormalizado = variedad.nombre (nullable)
    familia                 TEXT,                                -- denormalizado = familia.nombre (sin CHECK)
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

  -- Catálogo editable de envases (cajón, bolsa, bin, IFCO…). Lista propia de SG,
  -- agregable/editable desde el Catálogo. Seed inicial idempotente (OR IGNORE).
  CREATE TABLE IF NOT EXISTS sg_envases (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre            TEXT NOT NULL UNIQUE,
    activo            INTEGER NOT NULL DEFAULT 1,
    creado_en         TEXT DEFAULT (datetime('now','localtime')),
    creado_por        INTEGER,
    modificado_en     TEXT,
    modificado_por    INTEGER,
    eliminado_en      TEXT,
    eliminado_por_id  INTEGER
  );
  INSERT OR IGNORE INTO sg_envases (nombre) VALUES
    ('Cajón'), ('Bolsa'), ('Bin'), ('IFCO'), ('Atado'), ('Bandeja'), ('Caja'), ('Bolsón');

  -- Presentaciones por producto (cajón, bolsa, atado…). factor_conversion = cuántas
  -- unidades_base equivale 1 presentación (ej. cajón 20kg → 20). envase_id/paletizado
  -- son aditivos: NO intervienen en el cálculo de kg (solo factor_conversion lo hace);
  -- paletizado (unidades por pallet) es informativo para costeo logístico futuro.
  CREATE TABLE IF NOT EXISTS sg_presentaciones (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id         INTEGER NOT NULL REFERENCES sg_productos(id),
    nombre              TEXT NOT NULL,
    factor_conversion   REAL NOT NULL DEFAULT 1,
    envase_id           INTEGER REFERENCES sg_envases(id),
    paletizado          INTEGER,                              -- unidades por pallet (informativo)
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
    nombre_comercial            TEXT,   -- nombre de fantasía (opcional)
    origen                      TEXT NOT NULL DEFAULT 'nacional' CHECK(origen IN ('nacional','extranjero')),
    cuit                        TEXT,   -- nacional: CUIT XX-XXXXXXXX-X · extranjero: tax ID libre
    tipo                        TEXT CHECK(tipo IN ('productor','importador','mayorista_regional','otros')),
    categoria_fiscal            TEXT CHECK(categoria_fiscal IN ('resp_inscripto','monotributista','exento','no_inscripto')),
    tipo_fiscal_habitual        TEXT DEFAULT 'factura_a' CHECK(tipo_fiscal_habitual IN ('factura_a','factura_b','liquidacion','invoice')),
    condicion_pago_habitual_id  INTEGER REFERENCES sg_condiciones_pago(id),
    cbu                         TEXT,   -- datos bancarios para pagos (opcional)
    alias_cbu                   TEXT,
    comercial_responsable_id    INTEGER,
    localidad                   TEXT,
    provincia                   TEXT,   -- nacional: provincia AR · extranjero: país
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
    flete_a_cargo               TEXT CHECK(flete_a_cargo IN ('comprador','vendedor')),  -- informativo
    flete_monto                 REAL,                                                    -- informativo, NO suma al total
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
  if (!cols.includes('variedad') && !cols.includes('especie_id')) {
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

// ── MIGRACIÓN idempotente: sg_productos → taxonomía (familia_id/especie_id/variedad_id) ──
// Agrega los FK a la taxonomía y quita el CHECK viejo de 'familia' (catálogo vacío:
// no hay datos de productos que migrar). Rebuild estándar (FK off → nueva → copia →
// drop → rename) preservando ids (las FKs de presentaciones/oc_items/lotes/pedidos/
// despachos siguen válidas). Corre una sola vez (cuando aún no existe 'especie_id').
try {
  const cols = db.prepare("PRAGMA table_info(sg_productos)").all().map(c => c.name);
  if (!cols.includes('especie_id')) {
    db.pragma('foreign_keys = OFF');
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE sg_productos_new (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          codigo                  TEXT NOT NULL UNIQUE,
          familia_id              INTEGER REFERENCES sg_familias(id),
          especie_id              INTEGER REFERENCES sg_especies(id),
          variedad_id             INTEGER REFERENCES sg_variedades(id),
          nombre                  TEXT NOT NULL,
          variedad                TEXT,
          familia                 TEXT,
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
          (id, codigo, familia_id, especie_id, variedad_id, nombre, variedad, familia,
           unidad_base, vida_util_dias_default, activo, creado_en, creado_por,
           modificado_en, modificado_por, eliminado_en, eliminado_por_id)
        SELECT
           id, codigo, NULL, NULL, NULL, nombre, variedad, NULL,
           unidad_base, vida_util_dias_default, activo, creado_en, creado_por,
           modificado_en, modificado_por, eliminado_en, eliminado_por_id
        FROM sg_productos;
        DROP TABLE sg_productos;
        ALTER TABLE sg_productos_new RENAME TO sg_productos;
      `);
    });
    rebuild();
    db.pragma('foreign_keys = ON');
    console.log('[DB] SG sg_productos migrado (+familia_id/especie_id/variedad_id, código FF.EE.VV)');
  }
} catch (e) {
  try { db.pragma('foreign_keys = ON'); } catch (_) {}
  console.error('[DB] SG migración sg_productos taxonomía:', e.message);
}

// ── MIGRACIÓN idempotente: sg_productos → +codigo_abasto, +ean (trazabilidad ABASTO) ──
// Campos aditivos opcionales para la migración del padrón legacy ABASTO (#400/#401):
// codigo_abasto = CodArt original (trazabilidad contra ABASTO durante la transición);
// ean = código de barras (EAN). Ambos TEXT nullable sin CHECK → ALTER ADD COLUMN simple,
// sin rebuild. Self-healing (corre solo si la columna falta). NO toca datos existentes.
try {
  const cols = db.prepare("PRAGMA table_info(sg_productos)").all().map(c => c.name);
  const faltan = ['codigo_abasto', 'ean'].filter(c => !cols.includes(c));
  for (const c of faltan) db.exec(`ALTER TABLE sg_productos ADD COLUMN ${c} TEXT`);
  if (faltan.length) console.log('[DB] SG sg_productos migrado (+' + faltan.join(', +') + ')');
} catch (e) {
  console.error('[DB] SG migración sg_productos (abasto):', e.message);
}

// ── MIGRACIÓN idempotente: sg_proveedores → +'origen' (nacional/extranjero) y ──
// CHECK de tipo_fiscal_habitual ampliado con 'invoice' (proveedor del exterior).
// El CHECK no se puede ampliar con ALTER, así que reconstruimos la tabla (patrón
// estándar SQLite: FK off → tabla nueva → copia → drop → rename). Preserva los ids
// (las FKs de sg_oc y sg_gastos_directos_lote siguen válidas). Los proveedores
// existentes quedan como 'nacional'. Corre solo una vez (cuando aún no existe 'origen').
try {
  const cols = db.prepare("PRAGMA table_info(sg_proveedores)").all().map(c => c.name);
  if (!cols.includes('origen')) {
    db.pragma('foreign_keys = OFF');
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE sg_proveedores_new (
          id                          INTEGER PRIMARY KEY AUTOINCREMENT,
          razon_social                TEXT NOT NULL,
          origen                      TEXT NOT NULL DEFAULT 'nacional' CHECK(origen IN ('nacional','extranjero')),
          cuit                        TEXT,
          tipo                        TEXT CHECK(tipo IN ('productor','importador','mayorista_regional','otros')),
          categoria_fiscal            TEXT CHECK(categoria_fiscal IN ('resp_inscripto','monotributista','exento','no_inscripto')),
          tipo_fiscal_habitual        TEXT DEFAULT 'factura_a' CHECK(tipo_fiscal_habitual IN ('factura_a','factura_b','liquidacion','invoice')),
          condicion_pago_habitual_id  INTEGER REFERENCES sg_condiciones_pago(id),
          comercial_responsable_id    INTEGER,
          localidad                   TEXT,
          provincia                   TEXT,
          telefono                    TEXT,
          email                       TEXT,
          observaciones               TEXT,
          adm_proveedor_id            INTEGER,
          activo                      INTEGER NOT NULL DEFAULT 1,
          creado_en                   TEXT DEFAULT (datetime('now','localtime')),
          creado_por                  INTEGER,
          modificado_en               TEXT,
          modificado_por              INTEGER,
          eliminado_en                TEXT,
          eliminado_por_id            INTEGER
        );
        INSERT INTO sg_proveedores_new
          (id, razon_social, origen, cuit, tipo, categoria_fiscal, tipo_fiscal_habitual,
           condicion_pago_habitual_id, comercial_responsable_id, localidad, provincia,
           telefono, email, observaciones, adm_proveedor_id, activo,
           creado_en, creado_por, modificado_en, modificado_por, eliminado_en, eliminado_por_id)
        SELECT
           id, razon_social, 'nacional', cuit, tipo, categoria_fiscal, tipo_fiscal_habitual,
           condicion_pago_habitual_id, comercial_responsable_id, localidad, provincia,
           telefono, email, observaciones, adm_proveedor_id, activo,
           creado_en, creado_por, modificado_en, modificado_por, eliminado_en, eliminado_por_id
        FROM sg_proveedores;
        DROP TABLE sg_proveedores;
        ALTER TABLE sg_proveedores_new RENAME TO sg_proveedores;
      `);
    });
    rebuild();
    db.pragma('foreign_keys = ON');
    console.log('[DB] SG sg_proveedores migrado (+origen nacional/extranjero, tipo_fiscal +invoice)');
  }
} catch (e) {
  try { db.pragma('foreign_keys = ON'); } catch (_) {}
  console.error('[DB] SG migración sg_proveedores:', e.message);
}

// ── MIGRACIÓN idempotente: sg_proveedores → +nombre_comercial, +cbu, +alias_cbu ──
// Campos aditivos opcionales (nombre de fantasía + datos bancarios para pagos).
// Son TEXT nullable sin CHECK → ALTER ADD COLUMN simple, sin rebuild. Self-healing.
try {
  const cols = db.prepare("PRAGMA table_info(sg_proveedores)").all().map(c => c.name);
  const faltan = ['nombre_comercial', 'cbu', 'alias_cbu'].filter(c => !cols.includes(c));
  for (const c of faltan) db.exec(`ALTER TABLE sg_proveedores ADD COLUMN ${c} TEXT`);
  if (faltan.length) console.log('[DB] SG sg_proveedores migrado (+' + faltan.join(', +') + ')');
} catch (e) {
  console.error('[DB] SG migración sg_proveedores (datos pago):', e.message);
}

// ── GASTOS DIRECTOS (modelo NUEVO con valorización diferida) — Fase 1: Flete de Salida ──
// Pieza paralela a sg_gastos_directos_lote (que NO se toca): el gasto cuelga de la OPERACIÓN
// (despacho), no del lote, y tiene estado pendiente_valorizar → valorizado.
// A1) Tipificar fleteros: el fletero es un sg_proveedores con es_servicio=1 (flag aditivo
//     nullable, NO tabla nueva). ALTER ADD COLUMN simple. Proveedores viejos quedan NULL.
try {
  const cols = db.prepare("PRAGMA table_info(sg_proveedores)").all().map(c => c.name);
  if (!cols.includes('es_servicio')) {
    db.exec('ALTER TABLE sg_proveedores ADD COLUMN es_servicio INTEGER');
    console.log('[DB] SG sg_proveedores.es_servicio agregado');
  }
} catch (e) { console.error('[DB] SG migración sg_proveedores (es_servicio):', e.message); }

// ── MIGRACIÓN idempotente: sg_proveedores → +trabaja_consignacion, +comision_pct ──
// Defaults de consignación traídos del padrón ABASTO (mapean de `liquido` + `PorcLiquido`)
// para precargar las liquidaciones por consignación (#400/#401). trabaja_consignacion =
// INTEGER (0/1 booleano), comision_pct = REAL (% de comisión). Nullables → ALTER ADD COLUMN
// simple, sin rebuild. Self-healing. Las retenciones Gan/IIBB NO van al master (decisión #400).
try {
  const cols = db.prepare("PRAGMA table_info(sg_proveedores)").all().map(c => c.name);
  const add = [];
  if (!cols.includes('trabaja_consignacion')) { db.exec('ALTER TABLE sg_proveedores ADD COLUMN trabaja_consignacion INTEGER'); add.push('trabaja_consignacion'); }
  if (!cols.includes('comision_pct'))         { db.exec('ALTER TABLE sg_proveedores ADD COLUMN comision_pct REAL');         add.push('comision_pct'); }
  if (add.length) console.log('[DB] SG sg_proveedores migrado (+' + add.join(', +') + ')');
} catch (e) {
  console.error('[DB] SG migración sg_proveedores (consignacion):', e.message);
}

// ── MIGRACIÓN idempotente: sg_proveedores → +direccion, +codigo_postal (#401) ──
// El padrón ABASTO trae Direccion + CodPostal pero sg_proveedores no tenía dónde guardarlos.
// Campos aditivos TEXT nullable → ALTER ADD COLUMN simple, sin rebuild. Self-healing.
try {
  const cols = db.prepare("PRAGMA table_info(sg_proveedores)").all().map(c => c.name);
  const faltan = ['direccion', 'codigo_postal'].filter(c => !cols.includes(c));
  for (const c of faltan) db.exec(`ALTER TABLE sg_proveedores ADD COLUMN ${c} TEXT`);
  if (faltan.length) console.log('[DB] SG sg_proveedores migrado (+' + faltan.join(', +') + ')');
} catch (e) {
  console.error('[DB] SG migración sg_proveedores (direccion/cp):', e.message);
}

// ── Catálogo de rubros de gasto del proveedor + FK categoria_id (#401) ──
// El padrón ABASTO trae una CATEGORIA (rubro de gasto). Se guarda con FK, no texto libre.
// Tabla catálogo idempotente (seed OR IGNORE) + columna categoria_id en sg_proveedores.
db.exec(`
  CREATE TABLE IF NOT EXISTS sg_proveedor_categorias (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre    TEXT NOT NULL UNIQUE,
    activo    INTEGER NOT NULL DEFAULT 1,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  );
  INSERT OR IGNORE INTO sg_proveedor_categorias (nombre) VALUES
    ('Mercaderia Nacional'), ('Mercaderia Importada'), ('Insumos'), ('Comercio Exterior'),
    ('Servicios Logisticos'), ('Servicios Profesionales'), ('Servicios Financieros'),
    ('Viaticos'), ('Otros');
`);
// columna FK categoria_id (nullable; el referenciado ya existe arriba). Self-healing.
try {
  const cols = db.prepare("PRAGMA table_info(sg_proveedores)").all().map(c => c.name);
  if (!cols.includes('categoria_id')) {
    db.exec('ALTER TABLE sg_proveedores ADD COLUMN categoria_id INTEGER REFERENCES sg_proveedor_categorias(id)');
    console.log('[DB] SG sg_proveedores migrado (+categoria_id)');
  }
} catch (e) {
  console.error('[DB] SG migración sg_proveedores (categoria_id):', e.message);
}
// Fusión #401: el seed inicial de #424 traía 'Servicios Varios'/'Servicios Otros'.
// Se fusionan en 'Otros' → el catálogo queda en 9 rubros. Idempotente: borra esas 2
// filas SOLO si ningún proveedor las referencia (la migración de datos las mapea a Otros).
try {
  db.exec(`
    DELETE FROM sg_proveedor_categorias
     WHERE nombre IN ('Servicios Varios', 'Servicios Otros')
       AND id NOT IN (SELECT categoria_id FROM sg_proveedores WHERE categoria_id IS NOT NULL)
  `);
} catch (e) {
  console.error('[DB] SG fusión categorias (Servicios Varios/Otros → Otros):', e.message);
}

// ── MIGRACIÓN idempotente: sg_clientes → +cuenta_contable_id (FK → sg_cuentas) (#401) ──
// Camino A (cerrado con Pablo): cada cliente SG enlaza a su cuenta contable. INTEGER nullable
// → ALTER ADD COLUMN simple, self-healing. SQLite permite REFERENCES a sg_cuentas aunque
// db_sg_finanzas.js la cree después (la FK se valida en write, no en el ALTER).
try {
  const cols = db.prepare("PRAGMA table_info(sg_clientes)").all().map(c => c.name);
  if (!cols.includes('cuenta_contable_id')) {
    db.exec('ALTER TABLE sg_clientes ADD COLUMN cuenta_contable_id INTEGER REFERENCES sg_cuentas(id)');
    console.log('[DB] SG sg_clientes migrado (+cuenta_contable_id)');
  }
} catch (e) {
  console.error('[DB] SG migración sg_clientes (cuenta_contable_id):', e.message);
}

// ── Catálogo de categorías comerciales del cliente + FK categoria_id (#401 Paso 4) ──
// El padrón ABASTO trae una categoria_abasto (segmento comercial). Se guarda con FK.
db.exec(`
  CREATE TABLE IF NOT EXISTS sg_cliente_categorias (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre    TEXT NOT NULL UNIQUE,
    activo    INTEGER NOT NULL DEFAULT 1,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  );
  INSERT OR IGNORE INTO sg_cliente_categorias (nombre) VALUES
    ('Dedicados'), ('Food Service'), ('Mayorista A'), ('Mayorista MCBA'),
    ('Minorista MCBA'), ('Minorista Entrega'), ('Consumidor Final'), ('Retail');
`);
// Columnas aditivas en sg_clientes (#401 Paso 4): categoria_id (FK), comercial (vendedor),
// y codigo_postal + codigo_abasto que el CSV mapea (la tabla no los tenía). Self-healing.
try {
  const cols = db.prepare("PRAGMA table_info(sg_clientes)").all().map(c => c.name);
  if (!cols.includes('categoria_id'))   { db.exec('ALTER TABLE sg_clientes ADD COLUMN categoria_id INTEGER REFERENCES sg_cliente_categorias(id)'); }
  if (!cols.includes('comercial'))      { db.exec('ALTER TABLE sg_clientes ADD COLUMN comercial TEXT'); }
  if (!cols.includes('codigo_postal'))  { db.exec('ALTER TABLE sg_clientes ADD COLUMN codigo_postal TEXT'); }
  if (!cols.includes('codigo_abasto'))  { db.exec('ALTER TABLE sg_clientes ADD COLUMN codigo_abasto TEXT'); }
  console.log('[DB] SG sg_clientes migrado (+categoria_id/comercial/codigo_postal/codigo_abasto si faltaban)');
} catch (e) {
  console.error('[DB] SG migración sg_clientes (categoria_id/comercial/cp/abasto):', e.message);
}

// A2) En el despacho se elige el fletero (FK lógica a sg_proveedores; sin REFERENCES inline
//     por el límite de ALTER, se valida app-side). El transportista TEXT viejo queda intacto.
try {
  const cols = db.prepare("PRAGMA table_info(sg_despachos)").all().map(c => c.name);
  if (!cols.includes('fletero_id')) {
    db.exec('ALTER TABLE sg_despachos ADD COLUMN fletero_id INTEGER');
    console.log('[DB] SG sg_despachos.fletero_id agregado');
  }
} catch (e) { console.error('[DB] SG migración sg_despachos (fletero_id):', e.message); }

// A3) Tabla nueva sg_gastos_directos (genérica, FK polimórfica). Esta fase usa despacho_id;
//     recepcion_id / lote_id quedan previstas (nullable) para fases futuras (ingreso/repaso).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_gastos_directos (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo_gasto            TEXT NOT NULL DEFAULT 'flete_salida',   -- extensible: cargas_descargas, repaso, flete_ingreso
      despacho_id           INTEGER REFERENCES sg_despachos(id),    -- Fase 1
      recepcion_id          INTEGER REFERENCES sg_recepciones(id),  -- futuro
      lote_id               INTEGER REFERENCES sg_lotes(id),        -- futuro
      proveedor_servicio_id INTEGER REFERENCES sg_proveedores(id),  -- el fletero/cooperativa
      estado                TEXT NOT NULL DEFAULT 'pendiente_valorizar' CHECK(estado IN ('pendiente_valorizar','valorizado','anulado')),
      monto                 REAL,                                   -- NULL mientras pendiente
      fecha_servicio        TEXT,                                   -- fecha de la operación (despacho)
      fecha_valorizacion    TEXT,
      cuenta_ref            TEXT,                                   -- agrupador de la valorización (una cuenta del fletero)
      observaciones         TEXT,
      activo                INTEGER NOT NULL DEFAULT 1,
      creado_en             TEXT DEFAULT (datetime('now','localtime')),
      creado_por            INTEGER,
      valorizado_por        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sg_gd_prov_estado ON sg_gastos_directos(proveedor_servicio_id, estado);
    CREATE INDEX IF NOT EXISTS idx_sg_gd_despacho    ON sg_gastos_directos(despacho_id);
  `);
} catch (e) { console.error('[DB] SG sg_gastos_directos:', e.message); }

// ── FASE 2 (cargas y descargas, cooperativa): unidad de cobro + cantidad ────────
// La cooperativa cobra por 'bulto' o 'pallet' (variable). Se guarda la unidad + la cantidad
// (de sg_recepciones.bultos/pallets_recibidos para descarga_ingreso, o bultos del despacho
// para carga_salida) → la valorización prorratea por esta cantidad (no por kg). ALTER nullable.
try {
  const cols = db.prepare("PRAGMA table_info(sg_gastos_directos)").all().map(c => c.name);
  const faltan = [];
  if (!cols.includes('unidad'))   { db.exec("ALTER TABLE sg_gastos_directos ADD COLUMN unidad TEXT"); faltan.push('unidad'); }     // 'bulto' | 'pallet'
  if (!cols.includes('cantidad')) { db.exec("ALTER TABLE sg_gastos_directos ADD COLUMN cantidad REAL"); faltan.push('cantidad'); }
  if (cols.length) db.exec("CREATE INDEX IF NOT EXISTS idx_sg_gd_recepcion ON sg_gastos_directos(recepcion_id)");
  if (faltan.length) console.log('[DB] SG sg_gastos_directos migrado (+' + faltan.join(', +') + ')');
} catch (e) { console.error('[DB] SG migración sg_gastos_directos (unidad/cantidad):', e.message); }

// ── CAMBIO 2 (bulto/kilo): sg_oc_items → +modo_carga ────────────────────────────
// Cómo cargó el operador el item: 'bulto' (cantidad=bultos, precio=$/bulto) o 'kilo'
// (cantidad=kg, precio=$/kg). NULL/legacy = 'kilo'. ALTER ADD COLUMN simple, nullable,
// sin rebuild: NO cambia el almacenamiento canónico (kg_estimados + precio_estimado_por_kg
// + total siguen en kg). Solo registra el modo de ingreso. OCs viejas quedan NULL → 'kilo'.
try {
  const cols = db.prepare("PRAGMA table_info(sg_oc_items)").all().map(c => c.name);
  if (!cols.includes('modo_carga')) {
    db.exec("ALTER TABLE sg_oc_items ADD COLUMN modo_carga TEXT");
    console.log('[DB] SG sg_oc_items.modo_carga agregado');
  }
} catch (e) { console.error('[DB] SG migración sg_oc_items.modo_carga:', e.message); }

// ── MIGRACIÓN idempotente: sg_presentaciones → +envase_id, +paletizado ──────────
// Campos aditivos nullable (catálogo de envases + unidades por pallet). ALTER ADD
// COLUMN simple, sin rebuild, no rompe presentaciones ya cargadas ni el cálculo de
// kg (factor_conversion intacto). envase_id se agrega sin REFERENCES inline (límite
// de ALTER en SQLite); se valida app-side y la tabla nueva sí lleva la FK.
try {
  const cols = db.prepare("PRAGMA table_info(sg_presentaciones)").all().map(c => c.name);
  const faltan = [];
  if (!cols.includes('envase_id'))  { db.exec('ALTER TABLE sg_presentaciones ADD COLUMN envase_id INTEGER'); faltan.push('envase_id'); }
  if (!cols.includes('paletizado')) { db.exec('ALTER TABLE sg_presentaciones ADD COLUMN paletizado INTEGER'); faltan.push('paletizado'); }
  if (faltan.length) console.log('[DB] SG sg_presentaciones migrado (+' + faltan.join(', +') + ')');
} catch (e) {
  console.error('[DB] SG migración sg_presentaciones (envase/paletizado):', e.message);
}

// ── MIGRACIÓN idempotente: sg_oc → +flete_a_cargo, +flete_monto ─────────────────
// Campos INFORMATIVOS del flete (quién paga + monto que carga el comercial). NO
// suman al total_estimado_monto ni a los vencimientos. ALTER ADD COLUMN nullable,
// sin rebuild. flete_a_cargo se agrega sin CHECK inline (límite de ALTER); el valor
// se valida app-side y la tabla nueva sí lleva el CHECK ('comprador'/'vendedor').
try {
  const cols = db.prepare("PRAGMA table_info(sg_oc)").all().map(c => c.name);
  const faltan = [];
  if (!cols.includes('flete_a_cargo')) { db.exec('ALTER TABLE sg_oc ADD COLUMN flete_a_cargo TEXT'); faltan.push('flete_a_cargo'); }
  if (!cols.includes('flete_monto'))   { db.exec('ALTER TABLE sg_oc ADD COLUMN flete_monto REAL');   faltan.push('flete_monto'); }
  if (faltan.length) console.log('[DB] SG sg_oc migrado (+' + faltan.join(', +') + ')');
} catch (e) {
  console.error('[DB] SG migración sg_oc (flete):', e.message);
}

// ── IVA en la OC (Fase 2) ───────────────────────────────────────────────────────
// 1) Alícuota POR FAMILIA. El producto la hereda vía familia_id (NO se duplica en el
//    producto). ALTER ADD COLUMN nullable + seed: familias 01-04 (produce) → 10,5%;
//    el resto (ej. 05 Otros) queda NULL y se configura en el ABM. El seed solo toca
//    filas con alícuota NULL → no pisa configuraciones manuales (self-healing).
try {
  const cols = db.prepare("PRAGMA table_info(sg_familias)").all().map(c => c.name);
  if (!cols.includes('iva_alicuota')) {
    db.exec('ALTER TABLE sg_familias ADD COLUMN iva_alicuota REAL');
    console.log('[DB] SG sg_familias.iva_alicuota agregado');
  }
  db.exec("UPDATE sg_familias SET iva_alicuota=10.5 WHERE codigo IN (1,2,3,4) AND iva_alicuota IS NULL");
} catch (e) { console.error('[DB] SG migración sg_familias (iva_alicuota):', e.message); }

// 2) Discriminación en la cabecera de la OC: flag precio_incluye_iva + override opcional
//    de alícuota por OC + total NETO e IVA por separado (el total con IVA = neto+iva, se
//    deriva y se guarda en total_estimado_monto). Nullable: las OCs viejas quedan sin
//    discriminar (precio_incluye_iva/total_neto/total_iva NULL) y siguen igual.
try {
  const cols = db.prepare("PRAGMA table_info(sg_oc)").all().map(c => c.name);
  const faltan = [];
  if (!cols.includes('precio_incluye_iva')) { db.exec('ALTER TABLE sg_oc ADD COLUMN precio_incluye_iva INTEGER'); faltan.push('precio_incluye_iva'); }
  if (!cols.includes('iva_alicuota_oc'))    { db.exec('ALTER TABLE sg_oc ADD COLUMN iva_alicuota_oc REAL');      faltan.push('iva_alicuota_oc'); }
  if (!cols.includes('total_neto'))         { db.exec('ALTER TABLE sg_oc ADD COLUMN total_neto REAL');           faltan.push('total_neto'); }
  if (!cols.includes('total_iva'))          { db.exec('ALTER TABLE sg_oc ADD COLUMN total_iva REAL');            faltan.push('total_iva'); }
  if (faltan.length) console.log('[DB] SG sg_oc migrado (+' + faltan.join(', +') + ')');
} catch (e) { console.error('[DB] SG migración sg_oc (iva):', e.message); }

// 3) Snapshot de IVA por item de OC (la alícuota aplicada + neto/iva de la línea, fijados
//    al momento de la OC para que el PDF/totales no dependan de cambios futuros de la
//    alícuota de la familia). Nullable: items viejos quedan NULL.
try {
  const cols = db.prepare("PRAGMA table_info(sg_oc_items)").all().map(c => c.name);
  const faltan = [];
  if (!cols.includes('iva_alicuota'))  { db.exec('ALTER TABLE sg_oc_items ADD COLUMN iva_alicuota REAL');  faltan.push('iva_alicuota'); }
  if (!cols.includes('neto_estimado')) { db.exec('ALTER TABLE sg_oc_items ADD COLUMN neto_estimado REAL'); faltan.push('neto_estimado'); }
  if (!cols.includes('iva_estimado'))  { db.exec('ALTER TABLE sg_oc_items ADD COLUMN iva_estimado REAL');  faltan.push('iva_estimado'); }
  if (faltan.length) console.log('[DB] SG sg_oc_items migrado (+' + faltan.join(', +') + ')');
} catch (e) { console.error('[DB] SG migración sg_oc_items (iva):', e.message); }

// 4) F1 — OC por especie+envase+kilaje al vuelo. El operario elige envase (sg_envases) y
//    tipea el kilaje (kg por bulto) sin depender de una presentación pre-armada. Ambas
//    columnas nullable: los items legacy (cargados con presentacion_id) quedan NULL y siguen
//    andando. Sin REFERENCES inline (límite de ALTER ADD COLUMN en SQLite); envase_id es FK
//    lógica a sg_envases.
try {
  const cols = db.prepare("PRAGMA table_info(sg_oc_items)").all().map(c => c.name);
  const faltan = [];
  if (!cols.includes('kg_por_bulto')) { db.exec('ALTER TABLE sg_oc_items ADD COLUMN kg_por_bulto REAL');    faltan.push('kg_por_bulto'); }
  if (!cols.includes('envase_id'))    { db.exec('ALTER TABLE sg_oc_items ADD COLUMN envase_id INTEGER');    faltan.push('envase_id'); }
  if (faltan.length) console.log('[DB] SG sg_oc_items migrado (+' + faltan.join(', +') + ')');
} catch (e) { console.error('[DB] SG migración sg_oc_items (envase/kilaje):', e.message); }

// ── BLOQUE A — Recepción SG: +documentación (factura/DTV) + paletizado recibido ──
// Campos aditivos nullable sobre sg_recepciones (el remito ya existe en
// numero_remito_proveedor). ALTER ADD COLUMN simple, sin rebuild: las recepciones
// viejas quedan con estas columnas en NULL y siguen funcionando igual.
// ── BLOQUE B — Informe de calidad (mercadería observada): observada + campos del informe.
// (mismo ALTER idempotente; el informe es 1:1 con la recepción).
try {
  const cols = db.prepare("PRAGMA table_info(sg_recepciones)").all().map(c => c.name);
  const add = [
    ['factura_numero',         'TEXT'],     // BLOQUE A · doc
    ['dtv_codigo',             'TEXT'],     // BLOQUE A · doc (DTV SENASA - código de cierre)
    ['pallets_recibidos',      'INTEGER'],  // BLOQUE A · paletizado recibido
    ['bultos_recibidos',       'INTEGER'],  // BLOQUE A · paletizado recibido
    ['observada',              'INTEGER'],  // BLOQUE B · 1 = entró con informe de calidad
    ['calidad_estado_general', 'TEXT'],     // BLOQUE B
    ['calidad_defectos',       'TEXT'],     // BLOQUE B
    ['calidad_pct_afectado',   'REAL'],     // BLOQUE B
    ['calidad_observaciones',  'TEXT']      // BLOQUE B
  ];
  const faltan = [];
  for (const [c, t] of add) if (!cols.includes(c)) { db.exec(`ALTER TABLE sg_recepciones ADD COLUMN ${c} ${t}`); faltan.push(c); }
  if (faltan.length) console.log('[DB] SG sg_recepciones migrado (+' + faltan.join(', +') + ')');
} catch (e) {
  console.error('[DB] SG migración sg_recepciones (doc/paletizado/calidad):', e.message);
}

// ── BLOQUE B — fotos del informe de calidad. Patrón IFCO: el archivo físico vive en
// data/sg/ (servido estático) y en DB guardamos SOLO la ruta. Varias fotos por recepción
// → tabla hija. CREATE TABLE IF NOT EXISTS (idempotente).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_recepcion_fotos (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      recepcion_id    INTEGER NOT NULL REFERENCES sg_recepciones(id),
      ruta            TEXT NOT NULL,
      nombre_original TEXT,
      creado_en       TEXT DEFAULT (datetime('now','localtime')),
      creado_por      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sg_recepcion_fotos_rec ON sg_recepcion_fotos(recepcion_id);`);
} catch (e) {
  console.error('[DB] SG sg_recepcion_fotos:', e.message);
}

// ── RECEPCIÓN SIN OC (queda "OC pendiente", se vincula después) ──────────────────
// 1) Flag oc_pendiente: 1 = recepción cargada sin OC (lotes con costo pendiente). ALTER simple.
try {
  const cols = db.prepare("PRAGMA table_info(sg_recepciones)").all().map(c => c.name);
  if (!cols.includes('oc_pendiente')) {
    db.exec('ALTER TABLE sg_recepciones ADD COLUMN oc_pendiente INTEGER');
    console.log('[DB] SG sg_recepciones.oc_pendiente agregado');
  }
} catch (e) { console.error('[DB] SG migración sg_recepciones (oc_pendiente):', e.message); }

// 2) oc_id pasa de NOT NULL a NULLABLE (para recibir sin OC). SQLite no permite ALTER del
// NOT NULL → rebuild (FK off → tabla nueva con oc_id nullable → copia → drop → rename),
// preservando ids (las FKs de sg_lotes/sg_recepcion_fotos siguen válidas). Copia dinámica
// (intersección de columnas) para ser robusto ante drift. Corre solo si oc_id sigue NOT NULL.
try {
  const info = db.prepare("PRAGMA table_info(sg_recepciones)").all();
  const ocCol = info.find(c => c.name === 'oc_id');
  if (ocCol && ocCol.notnull === 1) {
    db.pragma('foreign_keys = OFF');
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE sg_recepciones_new (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          oc_id                   INTEGER REFERENCES sg_oc(id),          -- ahora NULLABLE
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
          eliminado_por_id        INTEGER,
          factura_numero          TEXT,
          dtv_codigo              TEXT,
          pallets_recibidos       INTEGER,
          bultos_recibidos        INTEGER,
          observada               INTEGER,
          calidad_estado_general  TEXT,
          calidad_defectos        TEXT,
          calidad_pct_afectado    REAL,
          calidad_observaciones   TEXT,
          oc_pendiente            INTEGER
        );`);
      const nuevas = db.prepare("PRAGMA table_info(sg_recepciones_new)").all().map(c => c.name);
      const viejas = new Set(db.prepare("PRAGMA table_info(sg_recepciones)").all().map(c => c.name));
      const comunes = nuevas.filter(c => viejas.has(c)).join(', ');
      db.exec(`INSERT INTO sg_recepciones_new (${comunes}) SELECT ${comunes} FROM sg_recepciones;`);
      db.exec('DROP TABLE sg_recepciones; ALTER TABLE sg_recepciones_new RENAME TO sg_recepciones;');
    });
    rebuild();
    db.pragma('foreign_keys = ON');
    console.log('[DB] SG sg_recepciones.oc_id ahora nullable (recepción sin OC)');
  }
} catch (e) {
  try { db.pragma('foreign_keys = ON'); } catch (_) {}
  console.error('[DB] SG migración sg_recepciones (oc_id nullable):', e.message);
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

// ── #reproceso/semáforo Paso 1: SEMÁFORO de lote (base, aditivo) ───────────────
// sg_lotes += semaforo ('verde'/'amarillo'/'rojo', default 'verde' — todo lote nace verde).
// SQLite permite ADD COLUMN con CHECK + DEFAULT; los lotes existentes quedan 'verde'.
try {
  const cols = db.prepare("PRAGMA table_info(sg_lotes)").all().map(c => c.name);
  if (!cols.includes('semaforo')) {
    db.exec("ALTER TABLE sg_lotes ADD COLUMN semaforo TEXT NOT NULL DEFAULT 'verde' CHECK(semaforo IN ('verde','amarillo','rojo'))");
    console.log('[DB] SG sg_lotes migrado (+semaforo)');
  }
} catch (e) { console.error('[DB] SG migración sg_lotes (semaforo):', e.message); }

// ── Identidad de BULTO en lote (aditivo, NULLABLE, sin backfill) ────────────────
// sg_lotes += presentacion_id (qué presentación/bulto) + bultos (cuántos bultos). Ambas
// NULLABLE: los lotes existentes quedan en null (NO backfill). NO reemplazan kg_reales ni
// tocan el cálculo de stock/despacho/factura — conviven como metadato. Se persisten en la
// recepción de OC cuando la OC/recepción conoce presentación y bultos; si no, quedan null.
// SQLite valida la FK en el write, no en el ALTER (ADD COLUMN con REFERENCES es OK).
try {
  const cols = db.prepare("PRAGMA table_info(sg_lotes)").all().map(c => c.name);
  const add = [];
  if (!cols.includes('presentacion_id')) { db.exec("ALTER TABLE sg_lotes ADD COLUMN presentacion_id INTEGER REFERENCES sg_presentaciones(id)"); add.push('presentacion_id'); }
  if (!cols.includes('bultos'))          { db.exec("ALTER TABLE sg_lotes ADD COLUMN bultos INTEGER"); add.push('bultos'); }
  if (add.length) console.log('[DB] SG sg_lotes migrado (+' + add.join(', +') + ')');
} catch (e) { console.error('[DB] SG migración sg_lotes (bulto):', e.message); }

// F2 — el lote hereda del oc_item el factor tipeado (kg por bulto) y el envase (F1). Nullable:
// los lotes legacy (con presentacion_id) quedan NULL y las lecturas caen a la presentación vía
// COALESCE(l.kg_por_bulto, ps.factor_conversion). Sin REFERENCES inline; envase_id es FK lógica
// a sg_envases.
try {
  const cols = db.prepare("PRAGMA table_info(sg_lotes)").all().map(c => c.name);
  const add = [];
  if (!cols.includes('kg_por_bulto')) { db.exec("ALTER TABLE sg_lotes ADD COLUMN kg_por_bulto REAL"); add.push('kg_por_bulto'); }
  if (!cols.includes('envase_id'))    { db.exec("ALTER TABLE sg_lotes ADD COLUMN envase_id INTEGER"); add.push('envase_id'); }
  if (add.length) console.log('[DB] SG sg_lotes migrado (+' + add.join(', +') + ')');
} catch (e) { console.error('[DB] SG migración sg_lotes (envase/kilaje):', e.message); }

// ── F3-A: bultos ADITIVO en tablas de movimiento (NULLABLE, idempotente) + backfill ─────────────
// El cajón es la unidad operativa indivisible. Estas columnas CONVIVEN con las de kg (que siguen
// siendo la verdad operativa en F3-A). Backfill = ROUND(kg_de_la_fila / kg_por_bulto) usando la
// presentación del lote asociado; null donde el lote no tiene presentacion_id (no derivable).
// NO flip de validación/estado/reservas (eso es F3-B+). cantidad_presentaciones (REAL) NO se toca:
// se agrega un `bultos` INTEGER nuevo para no romper la carga cooperativa.
try {
  const addCol = (tabla, col, tipo) => {
    const cols = db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name);
    if (!cols.includes(col)) { db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${tipo}`); return true; }
    return false;
  };
  const added = [];
  if (addCol('sg_lote_decomisos',   'bultos',               'INTEGER')) added.push('sg_lote_decomisos.bultos');
  if (addCol('sg_transformaciones', 'bultos_transformados', 'INTEGER')) added.push('sg_transformaciones.bultos_transformados');
  if (addCol('sg_reprocesos',       'bultos_procesados',    'INTEGER')) added.push('sg_reprocesos.bultos_procesados');
  if (addCol('sg_reprocesos',       'bultos_merma',         'INTEGER')) added.push('sg_reprocesos.bultos_merma');
  if (addCol('sg_reservas',         'bultos',               'INTEGER')) added.push('sg_reservas.bultos');
  if (addCol('sg_despacho_items',   'bultos',               'INTEGER')) added.push('sg_despacho_items.bultos');
  // F3 — el despacho snapshotea el factor tipeado (kg por bulto) y el envase del lote al momento
  // del despacho, para no acoplar la factura a un lote editado después. Nullable; los ítems legacy
  // quedan NULL y la lectura cae a la presentación vía COALESCE. envase_id es FK lógica a sg_envases.
  if (addCol('sg_despacho_items',   'kg_por_bulto',         'REAL'))    added.push('sg_despacho_items.kg_por_bulto');
  if (addCol('sg_despacho_items',   'envase_id',            'INTEGER')) added.push('sg_despacho_items.envase_id');
  if (added.length) console.log('[DB] SG F3-A bultos movimiento (+' + added.join(', +') + ')');

  // Backfill idempotente (solo bultos NULL) y derivable (lote con presentacion_id + factor>0). El
  // EXISTS evita tocar filas no derivables; las reservas oc_item (lote_id NULL) no matchean → null.
  const backfill = (tabla, colBultos, colKg, fkLote) => db.prepare(`
    UPDATE ${tabla} SET ${colBultos} = (
      SELECT CAST(ROUND(${tabla}.${colKg} / ps.factor_conversion) AS INTEGER)
      FROM sg_lotes l JOIN sg_presentaciones ps ON ps.id=l.presentacion_id
      WHERE l.id=${tabla}.${fkLote} AND ps.factor_conversion>0)
    WHERE ${colBultos} IS NULL AND EXISTS (
      SELECT 1 FROM sg_lotes l JOIN sg_presentaciones ps ON ps.id=l.presentacion_id
      WHERE l.id=${tabla}.${fkLote} AND ps.factor_conversion>0)`).run();
  backfill('sg_lote_decomisos',   'bultos',               'kg',               'lote_id');
  backfill('sg_transformaciones', 'bultos_transformados', 'kg_transformados', 'lote_origen_id');
  backfill('sg_reprocesos',       'bultos_procesados',    'kg_procesados',    'lote_madre_id');
  backfill('sg_reprocesos',       'bultos_merma',         'kg_merma',         'lote_madre_id');
  backfill('sg_reservas',         'bultos',               'kg',               'lote_id');
  backfill('sg_despacho_items',   'bultos',               'kg_despachados',   'lote_id');
} catch (e) { console.error('[DB] SG F3-A bultos movimiento:', e.message); }

// ── F3-B (complemento): backfill de sg_lotes.bultos = ROUND(kg_reales / kg_por_bulto) ───────────
// F1 (#477) dejó sg_lotes.bultos NULL (sin backfill). F3-B valida el despacho contra
// bultosDisponibles = lote.bultos − Σ bultos de movimientos, así que el lote NECESITA su capacidad
// en bultos cargada o todo despacho se rechazaría. Backfill idempotente (solo bultos NULL) y
// derivable (presentacion_id + factor>0). Lotes sin presentación quedan null (no despachables x bulto).
try {
  const r = db.prepare(`
    UPDATE sg_lotes SET bultos = (
      SELECT CAST(ROUND(sg_lotes.kg_reales / ps.factor_conversion) AS INTEGER)
      FROM sg_presentaciones ps WHERE ps.id=sg_lotes.presentacion_id AND ps.factor_conversion>0)
    WHERE bultos IS NULL AND presentacion_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM sg_presentaciones ps WHERE ps.id=sg_lotes.presentacion_id AND ps.factor_conversion>0)`).run();
  if (r.changes) console.log('[DB] SG F3-B backfill sg_lotes.bultos (' + r.changes + ' lotes)');
} catch (e) { console.error('[DB] SG F3-B backfill lotes.bultos:', e.message); }

// Historial de cambios de semáforo: cada cambio registra anterior→nuevo, motivo, origen, usuario.
db.exec(`
  CREATE TABLE IF NOT EXISTS sg_lote_semaforo_historial (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id        INTEGER NOT NULL REFERENCES sg_lotes(id),
    color_anterior TEXT,
    color_nuevo    TEXT NOT NULL CHECK(color_nuevo IN ('verde','amarillo','rojo')),
    motivo         TEXT,
    origen         TEXT NOT NULL CHECK(origen IN ('reproceso','observado','manual','devolucion','decomiso')),
    usuario_id     INTEGER,
    fecha          TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_sg_lote_sem_hist ON sg_lote_semaforo_historial(lote_id);
`);

// ── #reproceso caso 3: DECOMISO PARCIAL ────────────────────────────────────────
// (a) origen del historial += 'decomiso'. El CHECK no se puede ALTER → rebuild idempotente
//     para DBs ya deployadas (las nuevas ya se crean con el CHECK ampliado arriba).
try {
  const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sg_lote_semaforo_historial'").get();
  if (cur && !/'decomiso'/.test(cur.sql)) {
    const fkPrev = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`CREATE TABLE sg_lote_semaforo_historial_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lote_id INTEGER NOT NULL REFERENCES sg_lotes(id),
        color_anterior TEXT,
        color_nuevo TEXT NOT NULL CHECK(color_nuevo IN ('verde','amarillo','rojo')),
        motivo TEXT,
        origen TEXT NOT NULL CHECK(origen IN ('reproceso','observado','manual','devolucion','decomiso')),
        usuario_id INTEGER, fecha TEXT DEFAULT (datetime('now','localtime')))`);
      db.exec("INSERT INTO sg_lote_semaforo_historial_new SELECT * FROM sg_lote_semaforo_historial");
      db.exec("DROP TABLE sg_lote_semaforo_historial");
      db.exec("ALTER TABLE sg_lote_semaforo_historial_new RENAME TO sg_lote_semaforo_historial");
      db.exec("CREATE INDEX IF NOT EXISTS idx_sg_lote_sem_hist ON sg_lote_semaforo_historial(lote_id)");
    })();
    db.pragma(`foreign_keys = ${fkPrev ? 'ON' : 'OFF'}`);
    console.log('[DB] SG sg_lote_semaforo_historial CHECK origen +decomiso');
  }
} catch (e) { console.error('[DB] SG migración historial (decomiso):', e.message); }

// (b) Eventos de decomiso parcial: una fila por evento. Σ kg = merma del lote (NO toca kg_reales).
db.exec(`
  CREATE TABLE IF NOT EXISTS sg_lote_decomisos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id    INTEGER NOT NULL REFERENCES sg_lotes(id),
    kg         REAL NOT NULL,
    motivo     TEXT,
    usuario_id INTEGER,
    fecha      TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_sg_lote_decom ON sg_lote_decomisos(lote_id);
`);

// ── #reproceso caso 2: TRANSFORMACIÓN de unidad (caja → cubetas) ───────────────
// Operación INTERNA (no es compra): mueve stock+costo de un lote a otro con producto
// distinto (mismo especie/variedad, otro envase). El kg_reales del origen es SAGRADO
// (lo usan OC/CC proveedor/prorrateo/descarga) — la baja de disponible va por la Σ de
// sg_transformaciones, igual patrón que el decomiso.
//
// (a) sg_lotes += transformado_de: id del lote-origen del que nació este lote por
//     transformación (NULL = lote de compra normal). Los lotes con transformado_de IS NOT
//     NULL se EXCLUYEN del pool de prorrateo y de los reportes de compra/deuda a proveedor
//     (no son una compra); su costo viene CARGADO (snapshot del costo/kg del origen).
try {
  const cols = db.prepare("PRAGMA table_info(sg_lotes)").all().map(c => c.name);
  if (!cols.includes('transformado_de')) {
    db.exec("ALTER TABLE sg_lotes ADD COLUMN transformado_de INTEGER REFERENCES sg_lotes(id)");
    console.log('[DB] SG sg_lotes migrado (+transformado_de)');
  }
} catch (e) { console.error('[DB] SG migración sg_lotes (transformado_de):', e.message); }

// (b) Vínculo origen→destino de cada transformación (incl. reversiones, que son una
//     transformación cubeta→caja). kg_transformados = kg que SALIERON del origen;
//     costo_transferido = snapshot kg × costo/kg del origen al momento. La reversión NO
//     devuelve al lote-origen: crea un lote NUEVO (decisión 2), así que el descuento de
//     stock/costo por lote_origen_id es PERMANENTE. 'estado' es solo auditoría: la fila
//     caja→cubeta pasa a 'revertida' cuando su destino se re-consolidó por completo.
db.exec(`
  CREATE TABLE IF NOT EXISTS sg_transformaciones (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_origen_id    INTEGER NOT NULL REFERENCES sg_lotes(id),
    lote_destino_id   INTEGER NOT NULL REFERENCES sg_lotes(id),
    kg_transformados  REAL NOT NULL,
    factor            REAL,
    costo_transferido REAL NOT NULL DEFAULT 0,
    estado            TEXT NOT NULL DEFAULT 'activa' CHECK(estado IN ('activa','revertida')),
    usuario_id        INTEGER,
    fecha             TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_sg_transf_origen  ON sg_transformaciones(lote_origen_id);
  CREATE INDEX IF NOT EXISTS idx_sg_transf_destino ON sg_transformaciones(lote_destino_id);
`);

// ── #reproceso caso 1: REPROCESO con clasificación (1 madre → N hijos + merma) ──
// Entra 1 lote madre + un gasto de proceso; salen N lotes hijos de distinta calidad + una merma.
// Reúsa transformado_de (caso 2): los hijos son lotes con costo CARGADO, fuera de prorrateo/compra.
// La cabecera captura el OUTFLOW COMPLETO de la madre (kg_procesados incl. merma + costo_madre_
// consumido), que se suma al de sg_transformaciones para bajar disponible/costo de la madre.
//
// (a) Cabecera del reproceso. kg_procesados = lo consumido de la madre (aprovechable + merma);
//     kg_merma = kg_procesados − Σ kg hijos (no genera lote: sus kg desaparecen del inventario y
//     su costo lo absorben los hijos). costo_madre_consumido = snapshot kg_procesados × costo/kg
//     madre (lo que SALE de la madre). gasto_proceso = input (mano de obra, etc.), va SOLO acá
//     (no se espeja como gasto_directo → sin doble conteo). estado: 'revertido' reservado para V2.
db.exec(`
  CREATE TABLE IF NOT EXISTS sg_reprocesos (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_madre_id          INTEGER NOT NULL REFERENCES sg_lotes(id),
    kg_procesados          REAL NOT NULL,
    kg_merma               REAL NOT NULL DEFAULT 0,
    costo_madre_consumido  REAL NOT NULL DEFAULT 0,
    gasto_proceso          REAL NOT NULL DEFAULT 0,
    gasto_descripcion      TEXT,
    estado                 TEXT NOT NULL DEFAULT 'activo' CHECK(estado IN ('activo','revertido')),
    usuario_id             INTEGER,
    fecha                  TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_sg_reproc_madre ON sg_reprocesos(lote_madre_id);
`);

// (b) sg_lotes += reproceso_id: agrupa los hijos de un reproceso y los distingue de las cubetas
//     del caso 2 (ambos tienen transformado_de, pero solo los hijos llevan reproceso_id).
try {
  const cols = db.prepare("PRAGMA table_info(sg_lotes)").all().map(c => c.name);
  if (!cols.includes('reproceso_id')) {
    db.exec("ALTER TABLE sg_lotes ADD COLUMN reproceso_id INTEGER REFERENCES sg_reprocesos(id)");
    console.log('[DB] SG sg_lotes migrado (+reproceso_id)');
  }
} catch (e) { console.error('[DB] SG migración sg_lotes (reproceso_id):', e.message); }

// ── BRIEF 8: Pedidos-contra-OC (RESERVAS) — 100% aditivo, sin ALTER ───────────────
// Reserva BLANDA (D1): es INFORMATIVA, no descuenta el disponible ni bloquea el despacho.
//   tipo='oc_item' → reserva sobre mercadería EN CAMINO (oc_item de una OC abierta).
//   tipo='lote'    → reserva sobre STOCK (un lote concreto), o el resultado de concretar una
//                    reserva de oc_item cuando llega la recepción (FIFO×FEFO, D4).
// estados: activa (vigente) · concretada (oc_item → lote al recibir) · despachada (futuro) ·
//   cancelada (remanente no cubierto D2, u OC anulada D3). origen_oc_item_id = trazabilidad
//   de qué oc_item generó una reserva de lote. NO se hace ALTER a sg_pedido_items.
db.exec(`
  CREATE TABLE IF NOT EXISTS sg_reservas (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_item_id    INTEGER NOT NULL REFERENCES sg_pedido_items(id),
    tipo              TEXT NOT NULL CHECK(tipo IN ('lote','oc_item')),
    lote_id           INTEGER REFERENCES sg_lotes(id),
    oc_item_id        INTEGER REFERENCES sg_oc_items(id),
    kg                REAL NOT NULL,
    estado            TEXT NOT NULL DEFAULT 'activa' CHECK(estado IN ('activa','concretada','despachada','cancelada')),
    origen_oc_item_id INTEGER REFERENCES sg_oc_items(id),
    usuario_id        INTEGER,
    creado_en         TEXT DEFAULT (datetime('now','localtime')),
    concretada_en     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sg_reservas_lote    ON sg_reservas(lote_id);
  CREATE INDEX IF NOT EXISTS idx_sg_reservas_ocitem  ON sg_reservas(oc_item_id);
  CREATE INDEX IF NOT EXISTS idx_sg_reservas_peditem ON sg_reservas(pedido_item_id);
`);

// ── BRIEF 10: Corte operativo SG (stock inicial + saldo inicial de CC) — aditivo ───
// (a) Parámetros de SG (clave/valor). fecha_corte = día del corte operativo (apertura).
//     El asiento contable lo hace Pablo aparte; acá solo se guarda el parámetro operativo.
db.exec(`
  CREATE TABLE IF NOT EXISTS sg_config (
    clave         TEXT PRIMARY KEY,
    valor         TEXT,
    modificado_en TEXT,
    modificado_por INTEGER
  );
  INSERT OR IGNORE INTO sg_config (clave, valor) VALUES ('fecha_corte', '2026-06-30');
`);

// (b) saldo_inicial al corte por cliente y por proveedor. Se SUMA al cálculo derivado de CC
//     (no lo reemplaza): saldo_total = saldo_inicial + movimientos post-corte. Default 0.
for (const tabla of ['sg_clientes', 'sg_proveedores']) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name);
    if (!cols.includes('saldo_inicial')) {
      db.exec(`ALTER TABLE ${tabla} ADD COLUMN saldo_inicial REAL NOT NULL DEFAULT 0`);
      console.log(`[DB] SG ${tabla} migrado (+saldo_inicial)`);
    }
  } catch (e) { console.error(`[DB] SG migración ${tabla} (saldo_inicial):`, e.message); }
}

// ── FACTURACIÓN AFIP/ARCA — Paso 1: config + caché del TA (autenticación WSAA) ─────
// Las CREDENCIALES (cert/key) viven SOLO en env vars (process.env), nunca en la DB ni en el repo.
// Acá guardamos lo NO secreto: CUIT, ambiente, razón social (config) y el TA cacheado (token/sign
// son tokens de sesión de corta vida que devuelve WSAA; se guardan server-side para reusarlos
// hasta su expiración — AFIP rechaza pedir un TA nuevo si hay uno vigente).
db.exec(`
  CREATE TABLE IF NOT EXISTS sg_afip_config (
    id            INTEGER PRIMARY KEY CHECK(id=1),
    cuit          TEXT,
    ambiente      TEXT,
    razon_social  TEXT,
    modificado_en TEXT
  );
  CREATE TABLE IF NOT EXISTS sg_afip_ta (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    servicio  TEXT NOT NULL,
    ambiente  TEXT NOT NULL,
    token     TEXT,
    sign      TEXT,
    generado  TEXT,
    expira    TEXT,
    UNIQUE(servicio, ambiente)
  );
`);
// Seed/sync de la config con las env vars (CUIT y ambiente NO son secretos). El cert/key NO se tocan.
try {
  const _cuit = process.env.AFIP_CUIT || null;
  const _amb = (process.env.AFIP_AMBIENTE || 'homologacion');
  const _rs = process.env.AFIP_RAZON_SOCIAL || null;
  db.prepare('INSERT OR IGNORE INTO sg_afip_config (id, cuit, ambiente, razon_social) VALUES (1, ?, ?, ?)').run(_cuit, _amb, _rs);
  db.prepare("UPDATE sg_afip_config SET cuit=COALESCE(?,cuit), ambiente=COALESCE(?,ambiente), modificado_en=datetime('now','localtime') WHERE id=1").run(_cuit, _amb);
} catch (e) { console.error('[DB] SG seed sg_afip_config:', e.message); }

console.log('[DB] Módulo San Gerónimo (sg_*) inicializado');

export default db;
