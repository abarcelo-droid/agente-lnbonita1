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

import db, { rehacerTabla } from './db.js';

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

  -- El código con el que se rastrea la partida que entra por esta compra.
  -- PPPP.DD.MM.AAAA.XX — proveedor, fecha, y el orden de la compra dentro del día.
  -- Se llena al crear la OC; ver codigoTrazabilidad() en rutas/sg.js.
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
  // EL DESCUENTO COMERCIAL DEL PROVEEDOR. Es un acuerdo de alto nivel que
  // cierra la dirección con cada proveedor: va de 0% a más del 50%.
  //
  // Al facturar una venta, el precio se multiplica por (1 - descuento). La
  // factura sale por ese precio, y la diferencia se registra como venta de
  // GESTIÓN: es lo que la empresa pone sobre la mesa en cada acuerdo, y sin
  // medirlo no hay cómo sentarse a renegociarlo.
  //
  // VA EN EL PROVEEDOR, no en el producto ni en el cliente: una factura con
  // mercadería de tres proveedores lleva los tres descuentos, cada línea con
  // el suyo.
  if (!cols.includes('descuento_pct'))        { db.exec('ALTER TABLE sg_proveedores ADD COLUMN descuento_pct REAL');        add.push('descuento_pct'); }
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

// El código de trazabilidad de la partida que entra por cada orden de compra.
// Va como ALTER y no en el CREATE: las bases que ya existen no vuelven a correr
// el CREATE TABLE, así que una columna nueva ahí adentro no llegaría nunca.
try { db.exec("ALTER TABLE sg_oc ADD COLUMN trazabilidad TEXT"); } catch (_) {}

// ── EL FLETE SE PACTA DE TRES FORMAS ──────────────────────────────────────
// Un monto total, o un precio por bulto, o un precio por pallet. Antes había un
// solo campo de monto: el que lo pactaba por bulto tenía que multiplicar a mano
// y guardar el resultado, y a los dos días nadie sabía si esos $5.000.000 eran
// el total o el precio unitario, ni cuántos bultos se habían tomado.
//
// Se guardan las TRES cosas —cómo se pactó, la cantidad y el precio unitario— y
// además el total calculado en flete_monto, que es lo que ya leen la ficha y el
// PDF. El total se recalcula al guardar: no se le pide al usuario que lo haga.
//
// El IVA va aparte porque el flete se pacta de las dos maneras y saberlo importa
// para el costo real. Sigue siendo informativo: no suma al total de la orden.
try { db.exec("ALTER TABLE sg_oc ADD COLUMN flete_modalidad TEXT"); } catch (_) {}   // total | bulto | pallet
try { db.exec("ALTER TABLE sg_oc ADD COLUMN flete_cantidad REAL"); } catch (_) {}
try { db.exec("ALTER TABLE sg_oc ADD COLUMN flete_precio_unit REAL"); } catch (_) {}
try { db.exec("ALTER TABLE sg_oc ADD COLUMN flete_con_iva INTEGER"); } catch (_) {}

// ── CUÁNDO SE DA POR TERMINADA UNA ORDEN ──────────────────────────────────
// El estado se recalculaba solo, comparando kilos recibidos contra pedidos, y
// no había forma de decir "esto ya está". Una orden de 1188 kg de la que
// entraron 38 quedaba en 'recibida_parcial' PARA SIEMPRE: seguía en la bandeja
// de pendientes y sus 1150 kg se seguían ofreciendo como mercadería en camino
// al armar pedidos.
//
// cerrada_en es EL CERROJO, no un dato de auditoría: mientras tenga fecha,
// actualizarEstadoOC() no recalcula. Sin eso, la primera recepción que llegara
// después —o el vincular una recepción huérfana— devolvía la orden a
// 'recibida_parcial' y reaparecía en la bandeja sin que nadie entienda por qué.
//
// El motivo es obligatorio cuando se cierra con saldo: la orden queda diciendo
// que faltaron 1150 kg y alguien tiene que poder leer por qué no van a venir.
// (Las columnas del cerrojo se crean más abajo, junto al resto de sg_oc.)

// ── ¿LIQUIDAMOS O RECIBIMOS FACTURA? ──────────────────────────────────────
// Es la pregunta que define todo el circuito de una compra, y hasta ahora no se
// hacía: se deducía de la condición comercial, y eso era ambiguo.
//
//   RECIBIMOS FACTURA → la condición es siempre Precio Cerrado. La partida va a
//     "pendiente de recibir factura", se carga el comprobante y se contabiliza.
//   EMITIMOS LIQUIDACIÓN → la partida va a "pendiente de liquidar". Puede ser a
//     Precio Cerrado o a Precio de Pizarra; esas dos modalidades se diseñan más
//     adelante.
//
// Antes el ruteo lo hacía tipo_precio, y por eso una orden de Precio Cerrado que
// declaraba Liquidación como comprobante caía en la bandeja de facturas y
// quedaba trabada: ninguno de los tipos que esa pantalla acepta —A o B— era el
// que decía la orden.
try { db.exec("ALTER TABLE sg_oc ADD COLUMN documenta TEXT"); } catch (_) {}

// Las órdenes que ya existen. El criterio sale de lo que ya declararon:
//   · pizarra                    → se liquida (el precio se define al vender)
//   · comprobante = liquidacion  → se liquida (lo dice el propio comprobante)
//   · el resto                   → se factura
// Idempotente: sólo toca las que todavía no tienen respuesta.
try {
  const n = db.prepare(`UPDATE sg_oc SET documenta = CASE
      WHEN tipo_precio = 'pizarra' THEN 'liquidacion'
      WHEN tipo_fiscal = 'liquidacion' THEN 'liquidacion'
      ELSE 'factura' END
    WHERE documenta IS NULL`).run().changes;
  if (n) console.log(`[DB] SG: se les calculó "liquidamos o facturamos" a ${n} orden(es) ya cargada(s).`);
} catch (e) { console.error('[DB] SG documenta:', e.message); }

// ── CUÁNDO UNA PARTIDA DEJA DE ESPERAR SU LIQUIDACIÓN ─────────────────────
// La bandeja saca una partida cuando se le carga la liquidación desde ahí, que
// es lo que deja el vínculo (liquidaciones.oc_id). Pero eso sólo puede saberlo
// de las liquidaciones cargadas DESPUÉS de que el vínculo existe: las que ya
// estaban tienen oc_id en NULL, y sin esto TODAS las partidas viejas del
// circuito de liquidación volverían a la bandeja el día del despliegue, sin
// ninguna forma de sacarlas.
//
// liquidada_en es esa marca. La pone un admin a mano (y ahí queda liquidada_por)
// o la puso el backfill de una sola corrida.
try { db.exec("ALTER TABLE sg_oc ADD COLUMN liquidada_en TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sg_oc ADD COLUMN liquidada_por INTEGER"); } catch (_) {}

// ── LA ORDEN QUE NACIÓ DE UNA DESCARGA, Y TODAVÍA NO ES UNA ORDEN ─────────
// Cuando llega un camión sin orden de compra, la mercadería se recibe igual —no
// se la va a mandar de vuelta— y el sistema arma la orden hacia atrás. Pero esa
// orden nace a medias: tiene proveedor, fecha y partida, y le falta lo que
// decide el comprador (a cuánto se cerró, en cuántos días se paga, qué
// documenta). Hasta hoy esas órdenes se mezclaban con las demás y no había
// forma de saber cuáles estaban a medio hacer.
// ── LA FACTURA VINO POR MENOS DE LO ACORDADO ──────────────────────────────
// El comprador cierra el tomate en 20.000 y la factura llega por 10.000. Al
// proveedor se le deben 20.000; a AFIP se le informa la factura de 10.000.
//
// `total` sigue siendo lo que dice el comprobante y NO se toca: es lo que va al
// libro fiscal y a una presentación. La diferencia va aparte, con su motivo, y
// se suma como línea de gestión en el MISMO asiento.
try { db.exec("ALTER TABLE sg_facturas_compra ADD COLUMN dif_gestion REAL NOT NULL DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE sg_facturas_compra ADD COLUMN dif_motivo TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sg_oc ADD COLUMN completada_en TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sg_oc ADD COLUMN completada_por INTEGER"); } catch (_) {}
try {
  const yaEstaba = db.prepare("SELECT COUNT(*) c FROM sg_oc WHERE liquidada_en IS NOT NULL").get().c;
  if (!yaEstaba) {
    // SÓLO LAS DE PIZARRA. En una liquidación de precio de pizarra, "no le falta
    // cerrar el precio de ningún lote" sí quiere decir que se resolvió: el
    // precio se cierra cuando se vende, y eso es el trabajo de liquidar.
    //
    // En una de PRECIO CERRADO no quiere decir nada: el lote nace con el precio
    // puesto desde la recepción, así que la condición se cumple sola apenas
    // entra el camión. Marcarlas era decir "Liquidada" sobre una partida que
    // recién llegaba y a la que no se le emitió ninguna liquidación.
    const n = db.prepare(`UPDATE sg_oc SET liquidada_en = datetime('now','localtime')
      WHERE activo = 1
        AND estado IN ('recibida_total','cerrada')
        AND tipo_precio = 'pizarra'
        AND liquidada_en IS NULL
        AND NOT EXISTS (SELECT 1 FROM sg_lotes l
                          JOIN sg_oc_items i ON i.id = l.oc_item_id
                         WHERE i.oc_id = sg_oc.id AND l.activo = 1
                           AND l.precio_unitario_kg IS NULL)`).run().changes;
    if (n) console.log(`[DB] SG: ${n} partida(s) de pizarra ya liquidadas quedaron marcadas.`);
  }
} catch (e) { console.error('[DB] SG liquidada_en:', e.message); }

// ── Y SE DESHACE LO QUE EL BACKFILL MARCÓ DE MÁS ──────────────────────────
// La primera versión del backfill marcaba también las de precio cerrado, que
// cumplen la condición desde el momento en que entra la mercadería. Quedaron
// diciendo "Liquidada" partidas a las que no se les emitió nada.
//
// Se distingue por liquidada_por: cuando la marca la puso una persona, queda su
// usuario; el backfill lo deja en NULL. Sólo se deshace lo automático.
try {
  const n = db.prepare(`UPDATE sg_oc SET liquidada_en = NULL
    WHERE liquidada_en IS NOT NULL AND liquidada_por IS NULL AND tipo_precio <> 'pizarra'`).run().changes;
  if (n) console.log(`[DB] SG: se corrigió la marca de liquidada en ${n} partida(s) de precio cerrado.`);
} catch (e) { console.error('[DB] SG liquidada_en (corrección):', e.message); }

// ── LA FACTURA DE COMPRA ES LA DEUDA CON EL PROVEEDOR ─────────────────────
// saldo_pagado va desnormalizado en el propio comprobante, igual que en el
// módulo contable de Puente Cordón (pa_compras.saldo_pagado): la cuenta
// corriente es "total − pagado" documento por documento. Hoy siempre es 0
// —el circuito de pagos de SG todavía no escribe— pero la columna va ahora
// para no tener que reescribir la fórmula, y todas las pantallas que la lean,
// el día que se carguen los pagos.
try { db.exec("ALTER TABLE sg_facturas_compra ADD COLUMN saldo_pagado REAL DEFAULT 0"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sg_fact_prov ON sg_facturas_compra(proveedor_id, activo)"); } catch (_) {}
// Sin proveedor, una factura no entra en ninguna cuenta corriente y nadie se
// entera. Las que ya están cargadas lo heredan de su orden.
try {
  const n = db.prepare(`UPDATE sg_facturas_compra SET proveedor_id =
      (SELECT o.proveedor_id FROM sg_oc o WHERE o.id = sg_facturas_compra.oc_id)
    WHERE proveedor_id IS NULL`).run().changes;
  if (n) console.log(`[DB] SG: ${n} factura(s) de compra recuperaron su proveedor.`);
} catch (e) { console.error('[DB] SG factura proveedor_id:', e.message); }

// ── QUIÉN CAMBIÓ QUÉ ──────────────────────────────────────────────────────
// Un administrador puede corregir lo que ya se cargó: un bulto mal contado, un
// peso mal tipeado, un precio con un cero de más. Eso está bien —el error existe
// y hay que poder arreglarlo— pero tiene que quedar registro.
//
// Se guarda el valor ANTERIOR, no sólo quién tocó. Las columnas modificado_por /
// modificado_en que ya tienen las tablas dicen que alguien cambió algo, pero no
// QUÉ decía antes: con eso no se puede reconstruir por qué el costo de una
// partida es distinto del que se calculó en su momento.
//
// Es una sola tabla para todo el módulo —tabla, id, campo— y no una por cada
// cosa editable: agregar un campo nuevo a la lista no debería pedir otra tabla.
// Mismo espíritu que sg_lote_semaforo_historial, que ya guarda color_anterior.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_ediciones (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tabla         TEXT NOT NULL,          -- sg_lotes | sg_recepciones | sg_oc_items…
      registro_id   INTEGER NOT NULL,
      campo         TEXT NOT NULL,
      valor_anterior TEXT,
      valor_nuevo   TEXT,
      motivo        TEXT,
      -- Para poder listar todo lo que se tocó de una partida sin recorrer cada
      -- tabla: la orden a la que pertenece el registro editado.
      oc_id         INTEGER,
      usuario_id    INTEGER,
      fecha         TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_sg_edic_reg ON sg_ediciones(tabla, registro_id);
    CREATE INDEX IF NOT EXISTS idx_sg_edic_oc  ON sg_ediciones(oc_id);
    CREATE INDEX IF NOT EXISTS idx_sg_edic_fecha ON sg_ediciones(fecha);
  `);
} catch (e) { console.error('[DB] SG sg_ediciones:', e.message); }

// ── LA JURISDICCIÓN DE UNA PERCEPCIÓN DE INGRESOS BRUTOS ──────────────────
// Ingresos Brutos es provincial: la percepción de Buenos Aires no es la misma
// cuenta que la de Santa Fe, y al cierre hay que poder decir cuánto se pagó en
// cada una. Por eso la jurisdicción va en la LÍNEA del asiento modelo: se carga
// una línea de percepción IIBB por provincia, cada una con su cuenta, y al
// cargar la factura se elige contra cuál se imputa.
//
// Sirve igual para cualquier otro concepto que se abra por jurisdicción; hoy
// sólo IIBB lo necesita.
try { db.exec("ALTER TABLE sg_asientos_modelo_lineas ADD COLUMN jurisdiccion TEXT"); } catch (_) {}

// ── LA FACTURA DE COMPRA DE MERCADERÍA ────────────────────────────────────
// El comprobante que manda el proveedor por una partida ya recibida. Guarda el
// PDF y los datos fiscales que se le leen: con eso se arma el asiento contable
// de la compra, que es el PRIMER asiento de esa mercadería.
//
// Los datos fiscales van desglosados y NO como un total, porque cada uno va a
// una línea distinta del asiento: el neto a mercadería, el IVA a crédito fiscal,
// cada percepción y cada retención a la suya. Un total no se puede imputar.
//
// leido_por_ia + confirmada: lo que propone la lectura del PDF no es lo mismo
// que lo que una persona miró y dio por bueno. Un asiento no puede salir de un
// dato que nadie confirmó.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_facturas_compra (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      oc_id             INTEGER NOT NULL REFERENCES sg_oc(id),
      proveedor_id      INTEGER REFERENCES sg_proveedores(id),
      tipo_comprobante  TEXT,               -- factura_a | factura_b | liquidacion
      punto_venta       TEXT,
      numero            TEXT,
      fecha_emision     TEXT,
      cuit_emisor       TEXT,
      neto              REAL,
      iva_alicuota      REAL,
      iva_monto         REAL,
      percepcion_iva    REAL,
      percepcion_iibb   REAL,
      percepcion_ganancias REAL,
      otros_conceptos   REAL,
      -- Contra qué provincia se percibió Ingresos Brutos. Sin esto, al cierre
      -- no se puede decir cuánto se pagó en cada jurisdicción.
      iibb_jurisdiccion TEXT,
      total             REAL,
      cae               TEXT,
      cae_vencimiento   TEXT,
      archivo_ruta      TEXT,               -- el PDF, en data/sg/
      archivo_nombre    TEXT,
      leido_por_ia      INTEGER NOT NULL DEFAULT 0,
      confirmada_en     TEXT,
      confirmada_por    INTEGER,
      asiento_id        INTEGER,            -- el asiento que se generó, cuando se genere
      observaciones     TEXT,
      activo            INTEGER NOT NULL DEFAULT 1,
      creado_en         TEXT DEFAULT (datetime('now','localtime')),
      creado_por        INTEGER,
      modificado_en     TEXT,
      modificado_por    INTEGER
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sg_fact_oc ON sg_facturas_compra(oc_id)');
  // Para las bases que ya crearon la tabla sin esta columna.
  try { db.exec('ALTER TABLE sg_facturas_compra ADD COLUMN iibb_jurisdiccion TEXT'); } catch (_) {}

  // ── UNA FACTURA PUEDE CUBRIR VARIAS PARTIDAS ─────────────────────────
  // El proveedor junta dos o tres camiones en un solo comprobante. La columna
  // oc_id de la factura se queda con la PRIMERA —para no romper lo que ya la
  // lee— y acá se listan todas, incluida esa.
  //
  // El importe de cada partida se guarda: una factura que cubre tres camiones
  // tiene que poder decir cuánto le tocó a cada uno, o el costo de cada partida
  // queda inventado.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_factura_compra_ocs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      factura_id INTEGER NOT NULL REFERENCES sg_facturas_compra(id) ON DELETE CASCADE,
      oc_id      INTEGER NOT NULL REFERENCES sg_oc(id),
      neto       REAL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sg_fact_ocs ON sg_factura_compra_ocs(factura_id, oc_id);
    CREATE INDEX IF NOT EXISTS idx_sg_fact_ocs_oc ON sg_factura_compra_ocs(oc_id);
  `);

  // ── LAS PERCEPCIONES, UNA FILA POR JURISDICCIÓN ──────────────────────
  // Una misma factura puede traer percepción de Ingresos Brutos de más de una
  // provincia, y cada una va a la cuenta de SU jurisdicción. Con un solo campo
  // no entran: hace falta una fila por percepción.
  //
  // Se guardan acá TODAS las percepciones y no sólo las de IIBB, para que
  // agregar un impuesto nuevo no vuelva a pedir una columna.
// ══ LA FACTURA DE UN SERVICIO — LA QUE PISA LO VALORIZADO ═══════════════════
//
// Pablo, 3/9/2026: «un botón para INGRESAR FACTURA: permite seleccionar todas las
// descargas valorizadas y las "pisa" con una factura real. Una vez que se ingresa
// la factura se hace el asiento y se genera la deuda en el proveedor. Si tenemos
// valorizados 100 pero la factura es por 80, los 20 de diferencia van a asiento
// de gestión, como siempre».
//
// POR QUÉ UNA TABLA APARTE Y NO sg_facturas_compra. Esa tiene oc_id NOT NULL: es
// la factura de la MERCADERÍA de una orden. Una factura de la cuadrilla no cuelga
// de ninguna orden — cuelga de N descargas, que pueden ser de camiones distintos
// y de proveedores de mercadería distintos.
//
// EL TOTAL ES LO QUE DICE EL PAPEL, siempre. Lo que se había valorizado queda en
// `valorizado`, y la diferencia en dif_gestion + dif_motivo. Es la misma regla que
// en la factura de mercadería: el libro fiscal dice lo facturado, la deuda dice lo
// acordado.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_facturas_gasto (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      proveedor_servicio_id INTEGER NOT NULL,   -- la cooperativa, el fletero
      tipo_comprobante      TEXT,               -- factura_a | factura_b
      punto_venta           TEXT,
      numero                TEXT,
      fecha_emision         TEXT,
      cuit_emisor           TEXT,
      neto                  REAL,
      iva_alicuota          REAL,
      iva_monto             REAL,
      total                 REAL,
      -- Lo que sumaban las operaciones al momento de facturar. Se guarda porque
      -- después se pueden corregir, y entonces la diferencia de esta factura ya
      -- no se podría reconstruir.
      valorizado            REAL,
      dif_gestion           REAL NOT NULL DEFAULT 0,
      dif_motivo            TEXT,
      asiento_id            INTEGER,
      observaciones         TEXT,
      activo                INTEGER NOT NULL DEFAULT 1,
      anulada_en            TEXT,
      anulada_por           INTEGER,
      creado_en             TEXT DEFAULT (datetime('now','localtime')),
      creado_por            INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sg_fg_prov ON sg_facturas_gasto(proveedor_servicio_id);

    -- Qué operaciones cubre, y por cuánto le tocó a cada una. Una factura que
    -- cubre tres camiones tiene que poder decir cuánto le tocó a cada uno: sin
    -- eso, el costo de una partida no se puede explicar.
    CREATE TABLE IF NOT EXISTS sg_factura_gasto_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      factura_id INTEGER NOT NULL REFERENCES sg_facturas_gasto(id) ON DELETE CASCADE,
      gasto_id   INTEGER NOT NULL,
      neto       REAL
    );
    -- Una operación no se factura dos veces. El índice lo garantiza, no el código.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sg_fg_items ON sg_factura_gasto_items(factura_id, gasto_id);
    CREATE INDEX IF NOT EXISTS idx_sg_fg_items_gasto ON sg_factura_gasto_items(gasto_id);
  `);
} catch (e) { console.error('[DB] SG sg_facturas_gasto:', e.message); }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_factura_percepciones (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      factura_id   INTEGER NOT NULL REFERENCES sg_facturas_compra(id) ON DELETE CASCADE,
      tipo         TEXT NOT NULL,        -- percepcion_iibb | percepcion_iva | percepcion_ganancias
      jurisdiccion TEXT,                 -- sólo IIBB: la provincia
      monto        REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sg_fact_perc ON sg_factura_percepciones(factura_id);
  `);
} catch (e) { console.error('[DB] SG sg_facturas_compra:', e.message); }

try { db.exec("ALTER TABLE sg_oc ADD COLUMN cerrada_en TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sg_oc ADD COLUMN cerrada_por INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE sg_oc ADD COLUMN cierre_motivo TEXT"); } catch (_) {}

// ── LA RECEPCIÓN GUARDA MÁS QUE NÚMEROS ───────────────────────────────────
// Las fotos existían pero se guardaban SÓLO si la recepción salía observada:
// eran las del informe de calidad. Ahora se guardan siempre y se sabe DE QUÉ es
// cada una — el remito, la mercadería, la balanza, o lo que justifica una
// diferencia. Un montón de fotos sin decir qué muestran no sirve para nada
// cuando hay que reclamarle a un proveedor tres semanas después.
// (La columna está TAMBIÉN en el CREATE TABLE de más abajo. Este ALTER es para
// las bases que ya existían: en una base nueva corría ANTES del CREATE, fallaba
// en silencio, la tabla nacía sin la columna y NINGUNA recepción se podía
// guardar hasta el segundo arranque.)
try { db.exec("ALTER TABLE sg_recepcion_fotos ADD COLUMN categoria TEXT"); } catch (_) {}

// La descarga se pregunta SÍ O NO. Antes el único indicio era si se había
// elegido cooperativa, así que "no hubo descarga" y "me olvidé de cargarla" se
// veían igual. Es un dato que se va a usar más adelante para valorizarla.
try { db.exec("ALTER TABLE sg_recepciones ADD COLUMN con_descarga INTEGER"); } catch (_) {}

// Lo que llegó, ¿coincide con lo que se pidió? Es la pregunta que el operador
// tiene que contestar sí o sí, y de la que cuelga todo el reclamo posterior.
try { db.exec("ALTER TABLE sg_recepciones ADD COLUMN hay_variaciones INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE sg_recepciones ADD COLUMN variacion_motivo TEXT"); } catch (_) {}
// El peso que marcó la balanza, que puede no ser el de los ítems.
try { db.exec("ALTER TABLE sg_recepciones ADD COLUMN peso_recepcionado REAL"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sg_oc_trazabilidad ON sg_oc(trazabilidad)"); } catch (_) {}

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

// A2b) NO TODA VENTA EMITE UN REMITO NUEVO (Pablo, 24/8/2026).
//
// En facturación directa la mercadería sale y la FACTURA es el papel que la
// acompaña. Emitir además un remito propio es un segundo documento del mismo
// viaje: dos números para una sola salida, y el operador no sabe cuál mostrar.
//
// La SALIDA sigue existiendo siempre —el despacho descuenta stock y es lo que
// dice qué partida se le mandó a qué cliente; sin eso el lote figura disponible
// después de vendido—. Lo que se vuelve opcional es EMITIR EL REMITO como
// documento: con sin_remito=1 la salida no se ofrece para imprimir ni se nombra
// como remito en ningún lado, porque el comprobante que viaja es la factura.
try {
  const cols = db.prepare("PRAGMA table_info(sg_despachos)").all().map(c => c.name);
  if (!cols.includes('sin_remito')) {
    db.exec('ALTER TABLE sg_despachos ADD COLUMN sin_remito INTEGER NOT NULL DEFAULT 0');
    console.log('[DB] SG sg_despachos.sin_remito agregado');
  }
} catch (e) { console.error('[DB] SG migración sg_despachos (sin_remito):', e.message); }

// A2c) EL PRECIO DE LISTA DE CADA LÍNEA, antes del descuento acordado con el
//      proveedor de esa partida.
//
//      Pablo, 24/8/2026: "la venta que debe traer la partida es la venta EXACTA
//      en pesos que tuvo esa partida. No hay que dividirla por kilos ni
//      cuestiones raras: hay que traer la venta tal como está en las partidas."
//
//      Lo resignado existía sólo como un total de la factura, así que para saber
//      cuánto resignó UNA partida había que repartir ese total —y repartir es
//      inventar cuando el dato exacto existe—. Existe: cada renglón del remito
//      tiene su precio, y ahora también el de lista contra el que se mide.
try {
  const cols = db.prepare("PRAGMA table_info(sg_despacho_items)").all().map(c => c.name);
  if (!cols.includes('precio_lista_por_kg')) {
    db.exec('ALTER TABLE sg_despacho_items ADD COLUMN precio_lista_por_kg REAL');
    console.log('[DB] SG sg_despacho_items.precio_lista_por_kg agregado');
  }
} catch (e) { console.error('[DB] SG migración sg_despacho_items (precio_lista_por_kg):', e.message); }

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

// ── MÓDULO IMPORTACIÓN (F1) — cotizador standalone de embarque ──────────────────
// ADITIVO Y AISLADO: no se relaciona con sg_lotes ni con el costeo ARS existente. El USD y
// el tc viven SOLO acá; la conversión USD→ARS se hace intra-módulo. El enganche al lote es F2.
// Un embarque agrupa costos (estimado + real) y da el costo NETO por caja para decidir comprar.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_embarques (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre                      TEXT NOT NULL,
      proveedor_id                INTEGER REFERENCES sg_proveedores(id),
      pais_origen                 TEXT,
      incoterm                    TEXT DEFAULT 'FOB',
      certificado_origen_mercosur INTEGER DEFAULT 0,
      ncm                         TEXT,
      moneda                      TEXT NOT NULL DEFAULT 'USD',
      tc_estimado                 REAL,
      tc_real                     REAL,
      estado                      TEXT NOT NULL DEFAULT 'cotizacion' CHECK(estado IN ('cotizacion','abierto','transito','recibido','cerrado')),
      cantidad_cajas              INTEGER,
      merma_esperada_pct          REAL DEFAULT 0,
      precio_referencia           REAL,
      fecha_etd                   TEXT,
      fecha_eta                   TEXT,
      observaciones               TEXT,
      activo                      INTEGER NOT NULL DEFAULT 1,
      creado_en                   TEXT DEFAULT (datetime('now','localtime')),
      creado_por                  INTEGER,
      modificado_en               TEXT,
      modificado_por              INTEGER,
      eliminado_en                TEXT,
      eliminado_por_id            INTEGER
    );
    CREATE TABLE IF NOT EXISTS sg_embarque_costos (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      embarque_id       INTEGER NOT NULL REFERENCES sg_embarques(id),
      concepto          TEXT NOT NULL CHECK(concepto IN ('costo_mercaderia','anticipo_impuesto','gastos_despachante','fletes','diferencia_cotizacion','gastos_bancarios','iva_credito_computable','percepcion_iva_computable','percepcion_iibb')),
      es_credito        INTEGER NOT NULL DEFAULT 0,
      moneda            TEXT DEFAULT 'ARS',
      monto_estimado    REAL,
      monto_real        REAL,
      observaciones     TEXT,
      activo            INTEGER NOT NULL DEFAULT 1,
      creado_en         TEXT DEFAULT (datetime('now','localtime')),
      creado_por        INTEGER,
      modificado_en     TEXT,
      modificado_por    INTEGER,
      eliminado_en      TEXT,
      eliminado_por_id  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sg_embarque_costos_emb ON sg_embarque_costos(embarque_id);
  `);
} catch (e) { console.error('[DB] SG sg_embarques:', e.message); }

// ── CURVA DE TIPO DE CAMBIO ESPERADO ────────────────────────────────────────────────
// Qué esperamos del dólar mes a mes. Un valor por mes ('YYYY-MM'), cargado como vienen los
// futuros: el valor es el esperado al CIERRE de ese mes. Entre meses se interpola día a día.
//
// Existe porque el TC de un embarque no es un dato del embarque: es consecuencia de CUÁNDO
// se paga. Un pago a 30 días de la llegada se liquida a un dólar que no es el de hoy, y
// cotizar con el de hoy subvalúa el costo de todo lo que se compra a plazo.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_tc_esperado (
      mes            TEXT PRIMARY KEY,      -- 'YYYY-MM'
      valor          REAL NOT NULL,
      nota           TEXT,
      modificado_en  TEXT DEFAULT (datetime('now','localtime')),
      modificado_por INTEGER
    );
  `);
  // Seed: el TC esperado plano que existía como parámetro suelto pasa a ser el mes actual.
  // La curva lo generaliza (es el mismo dato, con dimensión tiempo), así que no se pierde.
  // OJO: sg_config se crea MÁS ABAJO en este archivo, así que en una base nueva esta lectura
  // tira "no such table" y la agarra el catch. Está bien: en una base nueva no hay ningún
  // valor plano que migrar. La tabla de la curva ya quedó creada arriba, que es lo que importa.
  const plano = db.prepare("SELECT valor FROM sg_config WHERE clave='tc_esperado'").get();
  const hayCurva = db.prepare('SELECT COUNT(*) n FROM sg_tc_esperado').get().n;
  if (plano && Number(plano.valor) > 0 && !hayCurva) {
    const mes = db.prepare("SELECT strftime('%Y-%m','now','localtime') m").get().m;
    db.prepare("INSERT OR IGNORE INTO sg_tc_esperado (mes, valor, nota) VALUES (?,?,?)")
      .run(mes, Number(plano.valor), 'Migrado del TC esperado global');
    console.log('[DB] SG curva TC: sembrada con el TC esperado plano (' + mes + ' = ' + plano.valor + ')');
  }
} catch (e) { console.error('[DB] SG sg_tc_esperado:', e.message); }


// Base imponible: el flete y el seguro DECLARADOS en aduana. Son base de cálculo de
// impuestos, no costos — el costo del flete es la factura del fletero, que va aparte.
// Sumar los dos inflaba el camión por el flete declarado entero.
try {
  const cols = db.prepare("PRAGMA table_info(sg_embarques)").all().map(c => c.name);
  const nuevas = [['flete_base_usd', 'REAL'], ['seguro_usd', 'REAL'],
                  ['nro_invoice', 'TEXT']].filter(([n]) => !cols.includes(n));
  for (const [n, t] of nuevas) db.exec(`ALTER TABLE sg_embarques ADD COLUMN ${n} ${t}`);
  if (nuevas.length) console.log(`[DB] SG sg_embarques migrado (+${nuevas.map(x => x[0]).join(', ')})`);
} catch (e) { console.error('[DB] SG migración sg_embarques (base imponible):', e.message); }

// ── QUIÉN TRAE EL CAMIÓN ────────────────────────────────────────────────────────────
// El módulo se llama "Camión" y del camión no se sabía nada: ni la patente ni quién
// maneja. Cuando el camión se demora, hay que llamar a alguien; cuando llega al galpón,
// hay que saber que ES el camión que se espera. Las dos cosas se resolvían por WhatsApp
// del comprador, o sea que vivían en un teléfono y no en el sistema.
//
// Son dos patentes porque en internacional el tractor y el acoplado se despachan por
// separado y muchas veces ni siquiera son del mismo país.
try {
  const cols = db.prepare("PRAGMA table_info(sg_embarques)").all().map(c => c.name);
  const nuevas = [
    ['transporte_empresa', 'TEXT'],
    ['camion_patente', 'TEXT'], ['camion_acoplado', 'TEXT'],
    ['chofer_nombre', 'TEXT'], ['chofer_documento', 'TEXT'], ['chofer_telefono', 'TEXT'],
  ].filter(([n]) => !cols.includes(n));
  for (const [n, t] of nuevas) db.exec(`ALTER TABLE sg_embarques ADD COLUMN ${n} ${t}`);
  if (nuevas.length) console.log(`[DB] SG sg_embarques migrado (+${nuevas.map(x => x[0]).join(', ')})`);
} catch (e) { console.error('[DB] SG migración sg_embarques (camión y chofer):', e.message); }

// ── EXPEDIENTE DOCUMENTAL DEL EMBARQUE (Importación F6) ─────────────────────────────
// La tabla FALTABA: F6 dejó los endpoints (subir/listar/descargar/borrar en rutas/sg.js)
// pero nunca el CREATE, así que el expediente entero tiraba "no such table" y no había forma
// de adjuntar un solo papel. Se crea acá con las columnas que esos endpoints usan.
// El archivo vive en R2; la fila solo guarda la metadata + storage_key para ir a buscarlo.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_embarque_documentos (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      embarque_id      INTEGER NOT NULL REFERENCES sg_embarques(id),
      tipo             TEXT NOT NULL,
      storage_key      TEXT NOT NULL,
      nombre_original  TEXT,
      mime             TEXT,
      tamano_bytes     INTEGER,
      fecha_documento  TEXT,
      observaciones    TEXT,
      activo           INTEGER NOT NULL DEFAULT 1,
      creado_en        TEXT DEFAULT (datetime('now','localtime')),
      creado_por       INTEGER,
      eliminado_en     TEXT,
      eliminado_por_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sg_emb_docs_emb ON sg_embarque_documentos(embarque_id, activo);
  `);
} catch (e) { console.error('[DB] SG sg_embarque_documentos:', e.message); }

// ── Condición de pago por rubro del embarque ────────────────────────────────────────
// El TC de un rubro sale de la curva en su FECHA DE PAGO, así que cada rubro en dólares
// necesita saber cuándo se paga. Se expresa como "N días desde un hito" (ETD o ETA) para
// que si el barco se corre, la fecha —y el TC— se recalculen solos. 'fija' es la salida
// para el caso puntual que no cuelga de ningún hito.
// Los rubros en pesos no llevan nada: se pagan en el momento y no tienen TC.
// moneda_real: el real se carga en PESOS (lo que salió de la caja); la columna existe por si
// algún día se paga desde una cuenta en dólares.
try {
  const cols = db.prepare("PRAGMA table_info(sg_embarque_costos)").all().map(c => c.name);
  const nuevas = [
    ['pago_ancla', 'TEXT'], ['pago_dias', 'INTEGER'], ['pago_fecha', 'TEXT'],
    ['moneda_real', "TEXT DEFAULT 'ARS'"],
    // Confirmación por documento: el rubro deja de ser una estimación cuando llega su papel.
    ['confirmado_en', 'TEXT'], ['confirmado_por', 'INTEGER'], ['confirmado_doc_id', 'INTEGER'],
    // monto_confirmado: lo que dice el PAPEL, en la moneda del rubro. Va al lado del estimado
    // en vez de pisarlo: el cálculo usa el confirmado, y la diferencia entre los dos es lo que
    // permite ver si se está cotizando bien. Tres etapas: estimado → confirmado → real (pesos).
    ['monto_confirmado', 'REAL']
  ].filter(([n]) => !cols.includes(n));
  for (const [n, t] of nuevas) db.exec(`ALTER TABLE sg_embarque_costos ADD COLUMN ${n} ${t}`);
  if (nuevas.length) console.log(`[DB] SG sg_embarque_costos migrado (+${nuevas.map(x => x[0]).join(', ')})`);
} catch (e) { console.error('[DB] SG migración sg_embarque_costos (pago):', e.message); }

// ── LO QUE DICE EL PAPEL, RUBRO POR RUBRO ───────────────────────────────────────────
// El estimador calcula IVA, IIBB, Tasa María y despachante con porcentajes sobre la base
// imponible. Eso sirve para COTIZAR, cuando todavía no llegó nada. Pero después llegan los
// papeles y traen el número de verdad, y hasta ahora no había dónde ponerlo: el costo del
// camión seguía siendo una estimación para siempre.
//
// Una fila por (embarque, rubro). Si existe, EL PAPEL LE GANA AL CÁLCULO. Si no existe, se
// sigue estimando. Esa es toda la regla.
//
// Tabla aparte y no columnas nuevas en sg_embarque_costos por dos razones: esa tabla tiene
// un CHECK sobre 'concepto' que no incluye iva ni tasa_maria (y SQLite no deja ampliar un
// CHECK sin recrear la tabla), y los rubros de acá son los del ESTIMADOR —los mismos que
// muestra el cuadro—, que no son uno a uno con los conceptos de aquella.
//
// monto_ars se guarda CALCULADO y no se deriva al leer: el TC de un despacho es el del día
// de oficialización, y ese dato es del papel. Si mañana se corrige la curva de TC, el costo
// que ya se confirmó no se tiene que mover.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_embarque_reales (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      embarque_id   INTEGER NOT NULL REFERENCES sg_embarques(id),
      rubro         TEXT NOT NULL,      -- mercaderia|iva|iibb|tasa_maria|despachante|flete_real|bancarios
      monto         REAL NOT NULL,      -- como figura en el papel, en su moneda
      moneda        TEXT NOT NULL DEFAULT 'ARS',
      tc            REAL,               -- sólo si moneda='USD' (despacho: el de oficialización)
      monto_ars     REAL NOT NULL,      -- lo que entra al costo. Congelado a propósito.
      documento_id  INTEGER,            -- qué papel lo confirmó (sg_embarque_documentos)
      origen        TEXT,               -- tipo de documento, para poder explicarlo en pantalla
      observaciones TEXT,
      usuario_id    INTEGER,
      creado_en     TEXT DEFAULT (datetime('now','localtime')),
      activo        INTEGER NOT NULL DEFAULT 1
    );
    -- Un solo real vigente por rubro: si vuelve a llegar el papel, se reemplaza.
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sg_emb_reales
      ON sg_embarque_reales(embarque_id, rubro) WHERE activo=1;
  `);
} catch (e) { console.error('[DB] SG sg_embarque_reales:', e.message); }

// El invoice ya venía confirmando la mercadería en sg_embarque_costos.monto_confirmado.
// Se copia a la tabla nueva para que el estimador tenga UN SOLO lugar de dónde leer: con
// dos mecanismos conviviendo, tarde o temprano dicen cosas distintas.
try {
  const pend = db.prepare(`SELECT c.embarque_id, c.monto_confirmado, c.confirmado_doc_id
    FROM sg_embarque_costos c
    WHERE c.concepto='costo_mercaderia' AND c.activo=1 AND c.monto_confirmado IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM sg_embarque_reales r
                      WHERE r.embarque_id=c.embarque_id AND r.rubro='mercaderia' AND r.activo=1)`).all();
  const ins = db.prepare(`INSERT INTO sg_embarque_reales
    (embarque_id, rubro, monto, moneda, tc, monto_ars, documento_id, origen, observaciones)
    VALUES (?, 'mercaderia', ?, 'USD', NULL, ?, ?, 'factura_comercial', 'migrado del invoice ya cargado')`);
  // monto_ars queda igual al monto en USD: el TC de la mercadería lo sigue poniendo la curva
  // por fecha de pago, que es como funcionaba hasta ahora. Se marca con moneda='USD' para
  // que el estimador sepa que TIENE que convertirlo y no lo tome por pesos.
  for (const r of pend) ins.run(r.embarque_id, r.monto_confirmado, r.monto_confirmado, r.confirmado_doc_id);
  if (pend.length) console.log(`[DB] SG sg_embarque_reales: ${pend.length} invoice(s) migrados`);
} catch (e) { console.error('[DB] SG migración invoice → reales:', e.message); }

// ── MÓDULO IMPORTACIÓN (F3) — cierre del embarque ───────────────────────────────────
// Al cerrar se congela la foto de lo PROYECTADO (estimados + tc estimado) contra lo REAL
// (COALESCE(real, estimado) + tc real). Es la única forma de aprender si cotizás bien: sin
// esto el estimado se pisa con el real y nadie vuelve a compararlos.
// El margen NO se snapshotea: se calcula en vivo desde las ventas de los lotes, porque se
// sigue vendiendo después del cierre y una foto quedaría vieja al día siguiente.
try {
  const cols = db.prepare("PRAGMA table_info(sg_embarques)").all().map(c => c.name);
  const nuevas = [
    ['cerrado_en', 'TEXT'], ['cerrado_por', 'INTEGER'],
    ['cierre_tc', 'REAL'],
    ['cierre_neto_proyectado', 'REAL'], ['cierre_neto_real', 'REAL'],
    ['cierre_costo_caja_proyectado', 'REAL'], ['cierre_costo_caja_real', 'REAL']
  ].filter(([n]) => !cols.includes(n));
  for (const [n, t] of nuevas) db.exec(`ALTER TABLE sg_embarques ADD COLUMN ${n} ${t}`);
  if (nuevas.length) console.log(`[DB] SG sg_embarques migrado (+cierre: ${nuevas.map(x => x[0]).join(', ')})`);
} catch (e) { console.error('[DB] SG migración sg_embarques (cierre):', e.message); }

// ── MÓDULO IMPORTACIÓN (F2) — líneas de producto del embarque + enganche al lote ────
// F1 modeló solo cantidad_cajas TOTAL. F2 necesita saber QUÉ lleva cada lote: producto, envase y
// kg por bulto. sg_embarque_lineas describe la composición del embarque; al recibir (POST
// /embarques/:id/recibir) se crea un sg_lote por línea con origen='importado' y costo provisorio
// = costo_caja_neto × cajas. Aditivo: no toca sg_embarques ni sg_embarque_costos.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_embarque_lineas (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      embarque_id       INTEGER NOT NULL REFERENCES sg_embarques(id),
      producto_id       INTEGER NOT NULL REFERENCES sg_productos(id),
      envase_id         INTEGER REFERENCES sg_envases(id),
      kg_por_bulto      REAL,
      cajas             INTEGER NOT NULL DEFAULT 0,
      calidad           TEXT,
      calibre           TEXT,
      observaciones     TEXT,
      activo            INTEGER NOT NULL DEFAULT 1,
      creado_en         TEXT DEFAULT (datetime('now','localtime')),
      creado_por        INTEGER,
      modificado_en     TEXT,
      modificado_por    INTEGER,
      eliminado_en      TEXT,
      eliminado_por_id  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sg_embarque_lineas_emb ON sg_embarque_lineas(embarque_id);
  `);
} catch (e) { console.error('[DB] SG sg_embarque_lineas:', e.message); }

// sg_lotes += embarque_id (F2): el lote importado apunta a su embarque de origen. Nullable —
// solo los lotes con origen='importado' lo tienen; el resto queda NULL. FK lógica a sg_embarques.
try {
  const cols = db.prepare("PRAGMA table_info(sg_lotes)").all().map(c => c.name);
  if (!cols.includes('embarque_id')) {
    db.exec("ALTER TABLE sg_lotes ADD COLUMN embarque_id INTEGER");
    console.log('[DB] SG sg_lotes migrado (+embarque_id)');
  }
  // embarque_linea_id: de QUÉ línea del embarque salió este lote. embarque_id solo dice de qué
  // camión vino; para re-costear hay que saber la línea, porque el costo se reparte por línea
  // (FOB unitario propio + gastos parejos por caja). Sin esto no hay forma de volver a asignar
  // el costo a cada lote sin adivinar.
  if (!cols.includes('embarque_linea_id')) {
    db.exec("ALTER TABLE sg_lotes ADD COLUMN embarque_linea_id INTEGER");
    // Backfill de los lotes que ya existen: al recibir se crea un lote por línea, en el mismo
    // orden (ORDER BY id). Solo se aparea cuando la cantidad coincide exactamente; si no
    // coincide, quedan en NULL y el re-costeo los saltea avisando, en vez de asignar mal.
    const embs = db.prepare("SELECT DISTINCT embarque_id e FROM sg_lotes WHERE embarque_id IS NOT NULL").all();
    let pareados = 0;
    for (const { e } of embs) {
      const lotes  = db.prepare("SELECT id FROM sg_lotes WHERE embarque_id=? ORDER BY id").all(e);
      const lineas = db.prepare("SELECT id FROM sg_embarque_lineas WHERE embarque_id=? AND activo=1 ORDER BY id").all(e);
      if (!lotes.length || lotes.length !== lineas.length) continue;
      const up = db.prepare("UPDATE sg_lotes SET embarque_linea_id=? WHERE id=?");
      lotes.forEach((l, i) => { up.run(lineas[i].id, l.id); pareados++; });
    }
    console.log(`[DB] SG sg_lotes migrado (+embarque_linea_id, ${pareados} lote/s apareados)`);
  }
} catch (e) { console.error('[DB] SG migración sg_lotes (embarque_id):', e.message); }

// sg_embarque_lineas += precio_unitario_usd (F7): FOB unitario en USD/caja por línea (calibre/
// presentación tienen precios distintos). costo_mercaderia de la cabecera pasa a DERIVADO = Σ(cajas ×
// precio_unitario_usd). Nullable por backward-compat (líneas F5 sin precio → costeo parejo por caja).
try {
  const cols = db.prepare("PRAGMA table_info(sg_embarque_lineas)").all().map(c => c.name);
  if (!cols.includes('precio_unitario_usd')) {
    db.exec("ALTER TABLE sg_embarque_lineas ADD COLUMN precio_unitario_usd REAL");
    console.log('[DB] SG sg_embarque_lineas migrado (+precio_unitario_usd)');
  }
} catch (e) { console.error('[DB] SG migración sg_embarque_lineas (precio_unitario_usd):', e.message); }

// ── PRECIO ESPERADO DE VENTA, POR PRODUCTO DEL CAMIÓN ───────────────────────────────
// A cuánto se piensa vender cada producto de un camión que viene en camino. Es lo que le
// falta al aviso que se les manda a los comerciales: el costo por caja ya se calcula, pero
// sin un precio al lado no dice si conviene o no.
//
// TABLA APARTE y no una columna en sg_embarque_lineas a propósito: embSyncLineas() BORRA y
// vuelve a insertar todas las líneas cada vez que se guarda el embarque, así que una columna
// ahí se perdería en el próximo guardado —y encima los id de línea cambian, con lo cual no
// se puede ni referenciar. Esto es dato comercial, no la composición del camión: tiene que
// sobrevivir a que alguien corrija los kilos.
//
// La clave es (embarque_id, producto_id): si el camión trae el mismo producto en dos líneas
// —dos calibres, por ejemplo— comparten precio, que es como se lo comunica igual.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_embarque_precios (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      embarque_id    INTEGER NOT NULL REFERENCES sg_embarques(id),
      producto_id    INTEGER NOT NULL,
      precio_caja    REAL,                -- en PESOS, por caja: la misma unidad que el costo
      usuario_id     INTEGER,
      creado_en      TEXT DEFAULT (datetime('now','localtime')),
      modificado_en  TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sg_emb_precios
      ON sg_embarque_precios(embarque_id, producto_id);
  `);
} catch (e) { console.error('[DB] SG sg_embarque_precios:', e.message); }

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
  // ── QUIÉN PUSO LA PLATA DEL FLETE DEL VENDEDOR ──────────────────────────
  // "A cargo del vendedor" no dice quién lo pagó, y son dos cosas distintas:
  //
  //   · el productor se arregló el flete    → San Gerónimo no toca nada;
  //   · lo adelantó San Gerónimo por él     → hay que pagarle al fletero, pero
  //     ese gasto NO es de San Gerónimo: se le descuenta al productor de su
  //     liquidación.
  //
  // Sin este dato los dos casos se cargaban igual, y el segundo no se podía ni
  // registrar: la bandeja de fletes esconde todo lo que sea "del vendedor".
  //
  // Sólo tiene sentido con flete_a_cargo='vendedor'. Sin CHECK inline, que es
  // límite del ALTER; el valor se valida en el endpoint.
  if (!cols.includes('flete_pagado_por')) { db.exec('ALTER TABLE sg_oc ADD COLUMN flete_pagado_por TEXT'); faltan.push('flete_pagado_por'); }
  // ── LO QUE EL COMERCIAL ESPERA SACAR POR ESTA MERCADERÍA ────────────────
  // Sólo tiene sentido en Liquidación de Venta, que es el caso donde el precio
  // se cierra DESPUÉS: hasta entonces la orden no tiene ningún número, y el
  // comercial no tiene contra qué comparar ni con qué decidir.
  //
  // Es INFORMATIVO: no suma al total, no arma deuda, no toca ningún asiento.
  // Es la expectativa con la que se trajo la mercadería, escrita donde se pueda
  // leer después — hoy vive en un chat de WhatsApp.
  try {
    const colsIt = db.prepare('PRAGMA table_info(sg_oc_items)').all().map((c) => c.name);
    if (!colsIt.includes('precio_referencia_venta')) {
      db.exec('ALTER TABLE sg_oc_items ADD COLUMN precio_referencia_venta REAL');
      console.log('[DB] SG sg_oc_items.precio_referencia_venta agregado');
    }
  } catch (e) { console.error('[DB] SG precio_referencia_venta:', e.message); }
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

// ══ LA FAMILIA DE TRÁNSITO ══════════════════════════════════════════════
//
// Una familia con productos colgando no se podía dar de baja: el maestro quedaba
// con "Hortalizas Livianas" dos veces --03 y 09-- y no había forma de juntarlas,
// porque para vaciar la de más había que mover especie por especie ANTES, y el
// botón de baja mientras tanto estaba apagado.
//
// Ahora se da de baja igual y lo que colgaba se estaciona en una familia marcada
// `transitoria`: no es una categoría comercial, es la sala de espera. Los productos
// siguen vivos y operables --se compran, se venden, se facturan-- y desde el maestro
// se les va poniendo la familia definitiva.
//
// La marca es una COLUMNA y no el nombre: el nombre se puede renombrar y entonces
// el sistema perdería de vista cuál era la de tránsito, la volvería a crear, y
// habría dos salas de espera.
try {
  const cols = db.prepare('PRAGMA table_info(sg_familias)').all().map((c) => c.name);
  if (!cols.includes('transitoria')) {
    db.exec('ALTER TABLE sg_familias ADD COLUMN transitoria INTEGER NOT NULL DEFAULT 0');
    console.log('[DB] SG sg_familias.transitoria agregado');
  }
} catch (e) { console.error('[DB] SG migración sg_familias (transitoria):', e.message); }

// ══ LA ALÍCUOTA DE IVA VIVE EN EL PRODUCTO Y ES OBLIGATORIA ═════════════
//
// Pablo, 25/8/2026: "la alícuota debe cargarse en el producto como dato
// obligatorio, de esta manera aseguramos que se contabilice".
//
// Antes vivía sólo en la familia y el producto la heredaba. El problema no era la
// herencia: era que una familia podía quedarse SIN alícuota --se da de alta con el
// nombre nada más-- y nada avisaba. Y a partir de ahí, en Facturación directa la
// pantalla calculaba el 21% mientras AFIP recibía la operación como EXENTA: el
// operador veía un total y firmaba otro.
//
// Ahora el dato es del producto. La familia sigue sirviendo como VALOR PROPUESTO
// al dar de alta --se hereda una vez, al crearlo-- pero lo que manda después es lo
// que tiene el producto.
try {
  const cols = db.prepare('PRAGMA table_info(sg_productos)').all().map((c) => c.name);
  if (!cols.includes('iva_alicuota')) {
    db.exec('ALTER TABLE sg_productos ADD COLUMN iva_alicuota REAL');
    // Y se llena con la de su familia, que es lo que hasta hoy se estaba usando:
    // migrar a null cambiaría de un día para el otro lo que factura un producto.
    const n = db.prepare(`UPDATE sg_productos
      SET iva_alicuota = (SELECT f.iva_alicuota FROM sg_familias f WHERE f.id = sg_productos.familia_id)
      WHERE iva_alicuota IS NULL`).run().changes;
    const sin = db.prepare(`SELECT COUNT(*) c FROM sg_productos
      WHERE activo = 1 AND eliminado_en IS NULL AND iva_alicuota IS NULL`).get().c;
    console.log(`[SG] sg_productos.iva_alicuota: ${n} heredadas de su familia`
      + (sin ? `, ${sin} SIN ALÍCUOTA — esos productos no se van a poder facturar hasta cargarla` : ''));
  }
} catch (e) { console.error('[SG] iva_alicuota en productos:', e.message); }

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
      -- De qué es la foto: documentacion | mercaderia | peso | variacion | calidad.
      categoria       TEXT,
      -- De qué ARTÍCULO de la orden. La foto de la balanza es de UN producto, no
      -- de la recepción entera. NULL para las que son de toda la entrada (el
      -- remito) y para lo que entra sin orden, que no tiene ítems.
      oc_item_id      INTEGER REFERENCES sg_oc_items(id),
      creado_en       TEXT DEFAULT (datetime('now','localtime')),
      creado_por      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sg_recepcion_fotos_rec ON sg_recepcion_fotos(recepcion_id);`);
  // El índice de oc_item_id va abajo, con el ALTER: en una base que YA tenía
  // la tabla, el CREATE TABLE es no-op y crear el índice acá fallaba sobre una
  // columna todavía inexistente — reventaba el exec entero y el ALTER nunca corría.
  // Para las bases que ya tenían la tabla. Va DESPUÉS del CREATE a propósito:
  // el de `categoria` está antes y por eso rompía las instalaciones nuevas.
  const _cf = db.prepare('PRAGMA table_info(sg_recepcion_fotos)').all().map((c) => c.name);
  if (!_cf.includes('categoria')) db.exec('ALTER TABLE sg_recepcion_fotos ADD COLUMN categoria TEXT');
  if (!_cf.includes('oc_item_id')) {
    db.exec('ALTER TABLE sg_recepcion_fotos ADD COLUMN oc_item_id INTEGER REFERENCES sg_oc_items(id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sg_recepcion_fotos_item ON sg_recepcion_fotos(oc_item_id)');
    console.log('[DB] SG sg_recepcion_fotos.oc_item_id agregado');
  }
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
          oc_pendiente            INTEGER,
          -- Estas cuatro las agrega un ALTER más arriba, pero este rebuild copia
          -- sólo la INTERSECCIÓN de columnas: si no están acá, en una base nueva
          -- se crean, se borran en el rebuild y la recepción entera queda rota
          -- ("no such column: con_descarga"). Toda columna nueva de
          -- sg_recepciones tiene que agregarse también en esta lista.
          con_descarga            INTEGER,
          hay_variaciones         INTEGER,
          variacion_motivo        TEXT,
          peso_recepcionado       REAL
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
//
// ── Y DIVIDE POR LOS KILOS VIGENTES, COMO EL REMITO ──────────────────────────
//
// Dividía por kg_reales. El alta del remito divide por los kilos VIGENTES —lo que
// entró menos la merma y lo que se transformó—, así que en toda partida con merma
// este arreglo escribía un margen DISTINTO del que había escrito el remito, y lo
// reescribía en cada arranque del servidor: el mismo remito mostraba un margen antes
// del reinicio y otro después.
//
// Se notó al abrir la corrección del precio de una partida ya despachada (29/8/2026):
// esa corrección rehace el margen con la cuenta del remito, y el próximo arranque se
// lo volvía a pisar con la otra.
const MARGEN_COSTO_KG = `COALESCE(
  COALESCE(l.costo_final,0) / NULLIF(
    l.kg_reales
    - COALESCE((SELECT SUM(kg) FROM sg_lote_decomisos WHERE lote_id = l.id),0)
    - COALESCE((SELECT SUM(kg_transformados) FROM sg_transformaciones
                 WHERE lote_origen_id = l.id),0), 0), 0)`;
try {
  db.exec(`
    UPDATE sg_despacho_items
    SET margen_estimado = subtotal - kg_despachados * (
          SELECT ${MARGEN_COSTO_KG}
          FROM sg_lotes l WHERE l.id = sg_despacho_items.lote_id)
    WHERE EXISTS (SELECT 1 FROM sg_lotes l WHERE l.id = sg_despacho_items.lote_id AND l.kg_reales > 0)
      AND ABS(margen_estimado - (subtotal - kg_despachados * (
          SELECT ${MARGEN_COSTO_KG}
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
  // ── LA FACTURA DEL FLETERO ────────────────────────────────────────────
  // Pablo, 27/8/2026: «deberíamos poder cargar y contabilizar la factura de los
  // fleteros ahí mismo». Hasta acá `monto` era un número suelto: entraba al costo
  // del lote y no generaba ni asiento ni deuda. Un servicio que se compra es un
  // gasto con su IVA crédito fiscal y su cuenta a pagar.
  //
  // `monto` se conserva como el TOTAL de la factura —es lo que ya está cargado y
  // lo que entra al costo— y se le agregan el neto y el IVA para poder asentar.
  // ── EL CAMIÓN LLEGÓ Y SE RECHAZÓ ENTERO ───────────────────────────────
  // Pablo, 27/8/2026: desde la recepción de una orden de compra tiene que poder
  // hacerse un RECHAZO TOTAL desde la pantalla general.
  //
  // No es lo mismo que anular. Anular es «esta orden no va a pasar»; rechazar es
  // «el proveedor entregó y se lo devolvimos». Los dos cierran la orden, pero el
  // segundo es un hecho del PROVEEDOR y hay que poder contarlo: un proveedor al
  // que se le rechazan tres camiones es un problema, y si se guarda como anulada
  // no queda registro de que llegó a venir.
  //
  // El estado sigue siendo 'anulada' —el CHECK de sg_oc no admite otro y
  // rehacer esa tabla arrastra media docena de claves foráneas— y el hecho vive
  // en estas columnas.
  // Y la anulación, con su motivo. Todo lo que deja trabajo afuera en este repo
  // pide por qué; anular una orden era lo único que salía con un confirm y nada más.
  if (addCol('sg_oc', 'anulado_en',      'TEXT'))    added.push('sg_oc.anulado_en');
  if (addCol('sg_oc', 'anulado_motivo',  'TEXT'))    added.push('sg_oc.anulado_motivo');
  if (addCol('sg_oc', 'anulado_por',     'INTEGER')) added.push('sg_oc.anulado_por');
  if (addCol('sg_oc', 'rechazado_en',     'TEXT'))    added.push('sg_oc.rechazado_en');
  if (addCol('sg_oc', 'rechazado_motivo', 'TEXT'))    added.push('sg_oc.rechazado_motivo');
  if (addCol('sg_oc', 'rechazado_por',    'INTEGER')) added.push('sg_oc.rechazado_por');
  if (addCol('sg_gastos_directos', 'neto',                'REAL'))    added.push('sg_gastos_directos.neto');
  if (addCol('sg_gastos_directos', 'iva_alicuota',        'REAL'))    added.push('sg_gastos_directos.iva_alicuota');
  if (addCol('sg_gastos_directos', 'iva_monto',           'REAL'))    added.push('sg_gastos_directos.iva_monto');
  if (addCol('sg_gastos_directos', 'asiento_id',          'INTEGER')) added.push('sg_gastos_directos.asiento_id');
  // EL PAPEL DEL FLETERO. Se guarda en R2 —igual que los documentos del embarque—
  // y acá queda sólo la referencia. La storage_key NO sale nunca al navegador: el
  // archivo se baja por el backend, que verifica que sea el de ese gasto.
  if (addCol('sg_gastos_directos', 'storage_key',     'TEXT'))    added.push('sg_gastos_directos.storage_key');
  if (addCol('sg_gastos_directos', 'archivo_nombre',  'TEXT'))    added.push('sg_gastos_directos.archivo_nombre');
  if (addCol('sg_gastos_directos', 'archivo_mime',    'TEXT'))    added.push('sg_gastos_directos.archivo_mime');
  if (addCol('sg_gastos_directos', 'archivo_bytes',   'INTEGER')) added.push('sg_gastos_directos.archivo_bytes');
  // ── CÓMO SE PACTÓ EL PRECIO DEL REMITO ────────────────────────────────────
  //
  // Pablo, 31/8/2026: «si el remito se pactó en bultos, la liquidación debe pactarse
  // en bultos también».
  //
  // El precio se GUARDA por kilo —es la unidad con la que corren el subtotal, el
  // margen y la factura— pero se acuerda por cajón tanto como por kilo. Sin dejar
  // asentado en cuál, la liquidación que llega después no tiene cómo saberlo y
  // vuelve a pedir kilos sobre un trato que se habló en cajones.
  //
  // NULL = kilo, que es como se pactó todo lo que ya existe.
  // ── LO QUE PIDE UNA CADENA Y UN CLIENTE COMÚN NO ─────────────────────────
  //
  // Pablo, 1/9/2026: «separemos la confección en dos: emisión de remitos normales
  // y emisión de remitos para supermercados, para que tengan dos tratamientos
  // distintos. Agreguémosle un campo de TURNO y un campo de OC que salgan
  // impresos».
  //
  // El súper da un TURNO de descarga en su centro de distribución y un número de
  // ORDEN DE COMPRA propio. Sin los dos en el papel, el camión llega y no lo
  // reciben — y esos dos datos vivían en un WhatsApp o en la cabeza del que
  // coordinó. Van en el remito, que es el papel que viaja con la mercadería.
  //
  // Son del REMITO y no del cliente: cambian en cada entrega.
  // ── QUIÉN PAGA EL FLETE ──────────────────────────────────────────────────
  //
  // Pablo, 2/9/2026: «en remitos, tanto para cadenas como para el resto, saquemos
  // el selector de transporte, dejemos sólo fletero. Pero sí preguntemos si el
  // flete lo pagamos nosotros o el vendedor. Si lo pagamos nosotros debe ir a
  // gastos directos, fletes de salida».
  //
  // Hasta acá, elegir un fletero SIEMPRE dejaba un gasto nuestro esperando la
  // factura. Y muchas veces el camión es del otro: el gasto quedaba en nuestros
  // números esperando una cuenta que no iba a llegar nunca, y alguien tenía que
  // acordarse de anularlo a mano.
  //
  // NULL = 'nosotros'. Es lo que el sistema venía haciendo con todos los remitos
  // que ya existen: si un fletero tenía gasto, era nuestro.
  // ── LA LOGÍSTICA DEL REMITO, COMO LA DE LA ORDEN ─────────────────────────
  //
  // Pablo, 2/9/2026: «la parte de logística en el remito quedó media rara.
  // Deberíamos tomar consideraciones similares a las que tenemos en la orden de
  // compra, sobre todo para que quede bien claro si lo tenemos que descontar o no
  // en la liquidación».
  //
  // La primera versión preguntaba una sola cosa —¿lo pagamos nosotros o el
  // vendedor?— y con eso no alcanza, porque en una salida hay TRES que pueden tener
  // el flete a cargo y las consecuencias son distintas:
  //
  //   'nosotros'   gasto nuestro. Va a Fletes de salida y es costo nuestro.
  //   'cliente'    lo paga el súper. No tocamos plata en ningún lado.
  //   'productor'  el dueño de la mercadería. Y ahí hay que preguntar QUIÉN pone la
  //                plata, igual que en la orden: si la pone él, no tocamos nada; si
  //                la ADELANTA San Gerónimo, se le paga al fletero y se le descuenta
  //                de su liquidación.
  //
  // Mismos nombres que sg_oc.flete_a_cargo / flete_pagado_por a propósito: es la
  // misma pregunta del otro lado del mostrador, y dos vocabularios para lo mismo
  // obligan a traducir en cada informe.
  // ── ¿ESTA DEVOLUCIÓN LE BAJA LO QUE SE LE DEBE AL PRODUCTOR? ─────────────
  //
  // Pablo, 2/9/2026: «una vez liquidado ya todo es firme… a lo sumo es como una
  // pérdida en la partida».
  //
  // La respuesta se congela CUANDO SE REGISTRA la devolución y no se vuelve a
  // preguntar. Si se recalculara cada vez, una partida que se liquida después
  // haría que las devoluciones viejas dejaran de descontar de golpe, y la
  // liquidación ya emitida pasaría a estar «de más» sin que nadie tocara nada.
  //
  // 1 = descuenta (la partida estaba libre) · 0 = pérdida nuestra (ya estaba firme)
  // ── LO QUE EL COMPRADOR CREE QUE VA A DEJAR ──────────────────────────────
  //
  // Pablo, 2/9/2026: «en nueva OC debemos poner Rentabilidad Estimada para que
  // complete el comprador. ¿Para qué? Primero porque más adelante vamos a poner
  // algún tipo de traba para que órdenes de compra superiores a X pesos requieran
  // autorización. Y además para poder hacer un seguimiento luego de si los
  // compradores están o no forecasteando bien».
  //
  // Es un PRONÓSTICO, no un dato del acuerdo: no cambia lo que se le paga al
  // productor ni entra a ningún asiento. Se guarda para poder compararlo después
  // contra el margen que la partida dejó de verdad.
  //
  // Va en porcentaje SOBRE EL COSTO: «10%» quiere decir que espera vender a
  // costo × 1,10. Guardar el porcentaje y no el precio es a propósito — el costo
  // todavía puede cambiar (la balanza, el flete), y el pronóstico que vale es el
  // criterio del comprador, no un número que quedó viejo.
  // ── LA FOTO DE LA MERMA ──────────────────────────────────────────────────
  //
  // Pablo, 2/9/2026: «dentro de stock vamos a avanzar con el módulo MERMA. Qué son
  // las mermas: stock que se tira. Obviamente debe descontar cantidades de la
  // partida y lo facturado es 0. Motivo obligatorio, subir foto opcional».
  //
  // El motivo dice QUÉ pasó; la foto lo PRUEBA. Una merma de treinta cajones que a
  // los dos meses hay que discutir con el productor —o con el seguro— vale lo que
  // vale la evidencia: sin foto es la palabra de uno contra la del otro.
  //
  // Opcional a propósito: exigirla haría que el que está en la cámara con las manos
  // sucias no cargue la merma, y una merma sin registrar es peor que una sin foto.
  // En la base va la RUTA, como las de la recepción; el archivo va al disco.
  if (addCol('sg_lote_decomisos',   'foto_ruta',             'TEXT')) added.push('sg_lote_decomisos.foto_ruta');
  if (addCol('sg_lote_decomisos',   'foto_nombre',           'TEXT')) added.push('sg_lote_decomisos.foto_nombre');
  if (addCol('sg_oc',               'rentabilidad_estimada', 'REAL')) added.push('sg_oc.rentabilidad_estimada');
  if (addCol('sg_devolucion_items', 'descuenta_al_productor', 'INTEGER')) added.push('sg_devolucion_items.descuenta_al_productor');
  if (addCol('sg_despachos',        'flete_a_cargo',        'TEXT')) added.push('sg_despachos.flete_a_cargo');
  if (addCol('sg_despachos',        'flete_pagado_por',     'TEXT')) added.push('sg_despachos.flete_pagado_por');
  if (addCol('sg_despachos',        'flete_monto',          'REAL')) added.push('sg_despachos.flete_monto');
  if (addCol('sg_despachos',        'flete_paga',           'TEXT')) added.push('sg_despachos.flete_paga');
  // Lo cargado con la pregunta vieja se traduce al vocabulario nuevo, una sola vez.
  // Sin esto esos remitos quedan sin decir a cargo de quién estaba el flete, y el
  // que los mire mañana no tiene cómo saberlo.
  try {
    const m = db.prepare(`UPDATE sg_despachos
      SET flete_a_cargo = CASE WHEN flete_paga='vendedor' THEN 'productor' ELSE 'nosotros' END,
          flete_pagado_por = CASE WHEN flete_paga='vendedor' THEN 'productor' ELSE NULL END
      WHERE flete_a_cargo IS NULL AND fletero_id IS NOT NULL`).run();
    if (m.changes) console.log(`[DB] SG: ${m.changes} remito(s) tradujeron su flete al vocabulario de la orden.`);
  } catch (e) { console.error('[DB] SG traducción flete_paga:', e.message); }
  if (addCol('sg_despachos',        'turno',                'TEXT')) added.push('sg_despachos.turno');
  if (addCol('sg_despachos',        'oc_cliente',           'TEXT')) added.push('sg_despachos.oc_cliente');
  if (addCol('sg_despacho_items',   'modo_precio',          'TEXT')) added.push('sg_despacho_items.modo_precio');
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
  -- ══ EL UMBRAL PARA IDENTIFICAR AL CONSUMIDOR FINAL ═══════════════════
  -- RG 5700/2025 de ARCA, art. 1° inc. d): desde $10.000.000 hay que identificar al
  -- comprador que reviste el carácter de consumidor final, con CUIT, CUIL, CDI o
  -- DNI. Rige desde el 29/5/2025. Por debajo, la factura sale "A CONSUMIDOR FINAL"
  -- sin ningún dato del comprador.
  --
  -- VA EN CONFIGURACIÓN Y NO EN EL CÓDIGO porque este número se mueve: pasó de
  -- $208.644 a $10.000.000 en una sola resolución, y esa misma resolución eliminó la
  -- distinción entre pago electrónico y otros medios que había antes. Escrito
  -- adentro, el día que ARCA lo cambie el sistema sigue con el viejo y nadie se
  -- entera — que es exactamente la forma de los bugs que se arreglaron el 25/8.
  INSERT OR IGNORE INTO sg_config (clave, valor) VALUES ('umbral_identificar_cf', '10000000');
`);

// ── PARÁMETROS DE IMPORTACIÓN ───────────────────────────────────────────────────────
// Alícuotas y porcentajes del despacho. Son los mismos para todas las importaciones, así que
// viven una sola vez acá y cada embarque los hereda. Se editan desde la pantalla cuando
// cambia alguna; INSERT OR IGNORE para no pisar lo que ya ajustaron.
try {
  const def = [
    ['imp_iva_pct', '10.5'],            // IVA sobre la base imponible
    ['imp_iibb_pct', '0.69'],           // percepción IIBB sobre la base imponible
    ['imp_despachante_pct', '0.7'],     // honorarios del despachante, % de la base imponible
    ['imp_iva_servicios_pct', '21'],    // IVA de despachante y gastos bancarios
    ['imp_tasa_maria_usd', '110'],      // Tasa María, monto fijo en dólares
    ['imp_gastos_bancarios_usd', '90']  // gastos bancarios: monto fijo por operación
  ];
  // Corrección puntual: el despachante es 0,7% y había quedado sembrado en 7% (diez veces
  // más). Solo se corrige si sigue en el valor viejo exacto, para no pisar un ajuste manual.
  try { db.prepare("UPDATE sg_config SET valor='0.7' WHERE clave='imp_despachante_pct' AND valor='7'").run(); } catch(_) {}
  // El % quedó de una versión anterior: los bancarios son un monto fijo, no un porcentaje.
  try { db.prepare("DELETE FROM sg_config WHERE clave='imp_gastos_bancarios_pct'").run(); } catch(_) {}
  const ins = db.prepare('INSERT OR IGNORE INTO sg_config (clave, valor) VALUES (?,?)');
  for (const [k, v] of def) ins.run(k, v);
} catch (e) { console.error('[DB] SG parámetros de importación:', e.message); }

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

// ── EL CONTROL DE CALIDAD, PRODUCTO POR PRODUCTO ────────────────────────────
// Antes el informe era UNO para toda la recepción: un estado general, un % y un
// texto. Con dos productos en el mismo camión eso no describe a ninguno — y el
// reclamo al proveedor se hace por producto, no por camión.
//
// Se ata al ítem de la ORDEN, no al lote: el informe se llena antes de que los
// lotes existan, y un ítem puede terminar en varios lotes.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_recepcion_calidad (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      recepcion_id    INTEGER NOT NULL REFERENCES sg_recepciones(id),
      oc_item_id      INTEGER REFERENCES sg_oc_items(id),
      producto_id     INTEGER REFERENCES sg_productos(id),
      observada       INTEGER NOT NULL DEFAULT 0,
      estado_general  TEXT,
      defectos        TEXT,
      pct_afectado    REAL,
      observaciones   TEXT,
      creado_en       TEXT DEFAULT (datetime('now','localtime')),
      creado_por      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sg_rec_calidad_rec ON sg_recepcion_calidad(recepcion_id);`);
} catch (e) { console.error('[DB] SG sg_recepcion_calidad:', e.message); }

// ── EL CATÁLOGO DE COOPERATIVAS ─────────────────────────────────────────────
// Hasta ahora "la cooperativa" era cualquier proveedor con el flag es_servicio,
// elegido de una lista donde también están los fleteros. Ahora se dan de alta
// acá, y SIEMPRE atadas a un proveedor: la cooperativa es la cuadrilla que
// descarga, el proveedor es a quién se le paga. Sin esa atadura una descarga
// cargada no se puede liquidar y termina siendo un dato que no sirve.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_cooperativas (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre           TEXT NOT NULL,
      -- OBLIGATORIO. A quién se le factura el trabajo de esta cuadrilla.
      proveedor_id     INTEGER NOT NULL REFERENCES sg_proveedores(id),
      contacto         TEXT,
      notas            TEXT,
      activo           INTEGER NOT NULL DEFAULT 1,
      creado_en        TEXT DEFAULT (datetime('now','localtime')),
      creado_por       INTEGER,
      modificado_en    TEXT,
      modificado_por   INTEGER,
      eliminado_en     TEXT,
      eliminado_por_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sg_coop_proveedor ON sg_cooperativas(proveedor_id);
  `);
  // Dos cooperativas activas con el mismo nombre son la misma cooperativa
  // cargada dos veces, y después no se sabe a cuál se le pagó.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sg_coop_nombre ON sg_cooperativas(nombre COLLATE NOCASE) WHERE activo=1");
} catch (e) { console.error('[DB] SG sg_cooperativas:', e.message); }

// Qué cuadrilla hizo la descarga. El gasto sigue apuntando al PROVEEDOR
// (proveedor_servicio_id) porque es a quien se le paga y de ahí cuelga toda la
// valorización; esta columna dice quién trabajó. Las descargas ya cargadas
// quedan sin cooperativa: no se inventa una para atrás.
try {
  const _cg = db.prepare('PRAGMA table_info(sg_gastos_directos)').all().map((c) => c.name);
  if (!_cg.includes('cooperativa_id')) {
    db.exec('ALTER TABLE sg_gastos_directos ADD COLUMN cooperativa_id INTEGER REFERENCES sg_cooperativas(id)');
    console.log('[DB] SG sg_gastos_directos.cooperativa_id agregado');
  }
  // El índice existente es (proveedor_servicio_id, estado): sin éste, contar las
  // descargas de una cooperativa recorre la tabla entera por cada fila.
  db.exec('CREATE INDEX IF NOT EXISTS idx_sg_gd_coop ON sg_gastos_directos(cooperativa_id)');
} catch (e) { console.error('[DB] SG cooperativa_id en gastos:', e.message); }

// ── EL REMITO PUEDE ASIGNAR MERCADERÍA QUE TODAVÍA NO LLEGÓ ─────────────────
// Un remito saca stock y se lo asigna a un cliente. Pero en este negocio se
// compromete mercadería ANTES de que baje del camión: el comprador cerró la
// carga, viene en viaje, y el cliente la quiere anotada a su nombre.
//
// Hasta ahora la línea del remito exigía `lote_id NOT NULL`, y el lote no
// existe hasta que la mercadería se recibe. O sea: no había forma de anotarlo.
// El único registro de esa promesa era la memoria del que la hizo.
//
// La línea pasa a tener DOS ORÍGENES, igual que sg_reservas —que ya usa este
// mismo par desde el circuito de pedidos—:
//   origen='lote'    → lote_id, mercadería que está en el depósito.
//   origen='oc_item' → oc_item_id, mercadería de una orden que viene en viaje.
//
// lote_id deja de ser obligatorio. Eso NO se puede hacer con un ALTER: SQLite no
// saca un NOT NULL, hay que rehacer la tabla. Va con rehacerTabla(), que corre
// todo en una transacción y deja la tabla como estaba si algo falla.
try {
  const colsDI = db.prepare('PRAGMA table_info(sg_despacho_items)').all();
  const tieneOrigen = colsDI.some((c) => c.name === 'origen');
  if (!tieneOrigen) {
    const ok = rehacerTabla('sg_despacho_items', `
      CREATE TABLE sg_despacho_items_v2 (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        despacho_id             INTEGER NOT NULL REFERENCES sg_despachos(id),
        -- De dónde sale la mercadería de esta línea.
        origen                  TEXT NOT NULL DEFAULT 'lote'
                                  CHECK(origen IN ('lote','oc_item')),
        lote_id                 INTEGER REFERENCES sg_lotes(id),
        oc_item_id              INTEGER REFERENCES sg_oc_items(id),
        producto_id             INTEGER REFERENCES sg_productos(id),
        presentacion_id         INTEGER REFERENCES sg_presentaciones(id),
        cantidad_presentaciones REAL DEFAULT 0,
        kg_despachados          REAL DEFAULT 0,
        precio_por_kg           REAL DEFAULT 0,
        -- POR QUÉ ese precio. Hoy eso vive en un chat de WhatsApp, así que el
        -- que factura no lo tiene y llama a preguntar.
        nota_precio             TEXT,
        subtotal                REAL DEFAULT 0,
        margen_estimado         REAL DEFAULT 0,
        bultos                  INTEGER,
        kg_por_bulto            REAL,
        envase_id               INTEGER,
        -- Cuando la partida en viaje se recibe, acá queda el lote que le tocó.
        lote_recibido_id        INTEGER REFERENCES sg_lotes(id),
        -- Una línea es de un origen O del otro, nunca de los dos ni de ninguno.
        CHECK((origen='lote'    AND lote_id    IS NOT NULL AND oc_item_id IS NULL)
           OR (origen='oc_item' AND oc_item_id IS NOT NULL AND lote_id    IS NULL))
      );
      INSERT INTO sg_despacho_items_v2
        (id, despacho_id, origen, lote_id, producto_id, presentacion_id,
         cantidad_presentaciones, kg_despachados, precio_por_kg, subtotal,
         margen_estimado, bultos, kg_por_bulto, envase_id)
        SELECT id, despacho_id, 'lote', lote_id, producto_id, presentacion_id,
               cantidad_presentaciones, kg_despachados, precio_por_kg, subtotal,
               margen_estimado, bultos, kg_por_bulto, envase_id
          FROM sg_despacho_items;
      DROP TABLE sg_despacho_items;
      ALTER TABLE sg_despacho_items_v2 RENAME TO sg_despacho_items;
      CREATE INDEX IF NOT EXISTS idx_sg_despacho_items_despacho ON sg_despacho_items(despacho_id);
      CREATE INDEX IF NOT EXISTS idx_sg_despacho_items_lote     ON sg_despacho_items(lote_id);
      CREATE INDEX IF NOT EXISTS idx_sg_despacho_items_ocitem   ON sg_despacho_items(oc_item_id);
    `);
    if (ok) {
      console.log('[DB] SG remitos: la línea puede venir de una partida EN VIAJE '
                + '(origen/oc_item_id) y lote_id dejó de ser obligatorio.');
    }
  }
} catch (e) { console.error('[DB] SG remitos (origen en la línea):', e.message); }

// ── LOS PISOS: DÓNDE ESTÁ LA MERCADERÍA ───────────────────────────────────
// Hasta ahora una partida estaba "en stock" y nada más. El total salía de sumar
// lo que quedaba de cada una, y no había forma de contestar dónde está — que es
// lo primero que necesita el que la va a buscar.
//
// El piso es la APERTURA del inventario, no una cuenta contable: el total sigue
// siendo uno y el piso lo desglosa. Un traslado entre pisos no genera asiento;
// la mercadería no cambió de dueño ni de valor, cambió de lugar.
//
// UNA PARTIDA PUEDE ESTAR REPARTIDA. Entran 100 cajones y se guardan 60 en un
// piso y 40 en otro: es lo que pasa de verdad, así que el saldo se lleva por
// (partida, piso) y no por partida.
db.exec(`
  CREATE TABLE IF NOT EXISTS sg_pisos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre        TEXT NOT NULL,
    codigo        TEXT,
    orden         INTEGER NOT NULL DEFAULT 0,
    notas         TEXT,
    activo        INTEGER NOT NULL DEFAULT 1,
    creado_en     TEXT DEFAULT (datetime('now','localtime')),
    creado_por    INTEGER,
    modificado_en TEXT,
    modificado_por INTEGER
  );

  -- CUÁNTO DE CADA PARTIDA HAY EN CADA PISO. Es un SALDO, no un histórico: sube
  -- cuando entra o llega un traslado, baja cuando sale mercadería.
  --
  -- LA REGLA QUE NO SE PUEDE ROMPER: la suma de los pisos de una partida tiene
  -- que dar exactamente lo disponible de esa partida. Si se despacha sin
  -- descontar de un piso, el total sigue bien y la apertura queda mintiendo —
  -- que es peor que no tener apertura, porque nadie la va a dudar.
  CREATE TABLE IF NOT EXISTS sg_lote_ubicaciones (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id    INTEGER NOT NULL REFERENCES sg_lotes(id),
    piso_id    INTEGER NOT NULL REFERENCES sg_pisos(id),
    bultos     REAL NOT NULL DEFAULT 0,
    kg         REAL NOT NULL DEFAULT 0,
    UNIQUE(lote_id, piso_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sg_lote_ubic_lote ON sg_lote_ubicaciones(lote_id);
  CREATE INDEX IF NOT EXISTS idx_sg_lote_ubic_piso ON sg_lote_ubicaciones(piso_id);

  -- EL PASE ENTRE PISOS. Queda registrado con quién y cuándo: mover mercadería
  -- de lugar cambia dónde hay que ir a buscarla, y una edición silenciosa deja
  -- al depósito diciendo una cosa y la pantalla otra sin que se sepa cuándo
  -- empezó a pasar.
  CREATE TABLE IF NOT EXISTS sg_lote_traslados (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id         INTEGER NOT NULL REFERENCES sg_lotes(id),
    piso_origen_id  INTEGER NOT NULL REFERENCES sg_pisos(id),
    piso_destino_id INTEGER NOT NULL REFERENCES sg_pisos(id),
    bultos          REAL NOT NULL DEFAULT 0,
    kg              REAL NOT NULL DEFAULT 0,
    motivo          TEXT,
    usuario_id      INTEGER,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_sg_traslados_lote ON sg_lote_traslados(lote_id);

  -- DE QUIÉN ES CADA PISO. El que recibe en Empaque tenía que acordarse de no
  -- elegir San Pedro, y si se equivocaba la mercadería quedaba contada en un
  -- lugar donde no estaba — cosa que no se descubre hasta que alguien va a
  -- buscarla.
  --
  -- La regla es la MISMA que la de las cuentas de tesorería
  -- (sg_fin_cuenta_usuarios + puedeMoverCuenta): si tiene gente asignada lo
  -- tocan sólo ellos; si no tiene a nadie, lo toca cualquiera que tenga permiso
  -- en el módulo. Eso resuelve el arranque: el día que esto se despliega ningún
  -- piso tiene usuarios, y con "sólo los asignados" nadie podría recibir hasta
  -- terminar de configurarlo.
  CREATE TABLE IF NOT EXISTS sg_piso_usuarios (
    piso_id    INTEGER NOT NULL REFERENCES sg_pisos(id),
    usuario_id INTEGER NOT NULL,
    creado_en  TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (piso_id, usuario_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sg_piso_us_us ON sg_piso_usuarios(usuario_id);
`);

// Los tres con los que arranca. Se pueden renombrar, dar de baja y agregar más
// desde la pantalla: acá sólo se siembra para que el sistema no arranque sin
// ningún lugar donde poner la mercadería.
try {
  if (!db.prepare('SELECT COUNT(*) c FROM sg_pisos').get().c) {
    const ins = db.prepare('INSERT INTO sg_pisos (nombre, codigo, orden) VALUES (?,?,?)');
    ins.run('Piso 1', 'P1', 1);
    ins.run('Piso 2', 'P2', 2);
    ins.run('Piso 3', 'P3', 3);
    console.log('[DB] SG pisos: se sembraron los 3 iniciales');
  }
} catch (e) { console.error('[DB] SG pisos:', e.message); }

// EL PISO QUE SE PROPONE DESDE LA ORDEN. Al comprar ya se suele saber dónde va a
// ir la mercadería, pero el dato FÍSICO recién existe cuando el camión descarga:
// por eso acá es una propuesta y en la recepción se confirma. Si sólo se eligiera
// en la orden, el primer día que la carga vaya a otro lado el sistema diría una
// cosa y el depósito otra.
try {
  const colsIt = db.prepare('PRAGMA table_info(sg_oc_items)').all().map((c) => c.name);
  if (!colsIt.includes('piso_id')) {
    db.exec('ALTER TABLE sg_oc_items ADD COLUMN piso_id INTEGER');
    console.log('[DB] SG sg_oc_items.piso_id agregado (piso propuesto en la orden)');
  }
} catch (e) { console.error('[DB] SG oc_items.piso_id:', e.message); }

// De qué piso salió lo que se despachó. Null en los remitos viejos y en las
// líneas de mercadería en viaje, que todavía no está en ningún piso.
try {
  const colsDI = db.prepare('PRAGMA table_info(sg_despacho_items)').all().map((c) => c.name);
  if (!colsDI.includes('piso_id')) {
    db.exec('ALTER TABLE sg_despacho_items ADD COLUMN piso_id INTEGER');
    console.log('[DB] SG sg_despacho_items.piso_id agregado');
  }
} catch (e) { console.error('[DB] SG despacho_items.piso_id:', e.message); }

// ══ MERCADERÍA DE SEGUNDA ══════════════════════════════════════════════════
//
// Pablo, 28/8/2026: «los compradores, dentro del stock, pueden asignar bultos de
// una partida y marcarlos como mercadería de segunda. Entraron 100 bultos, se
// vendieron 70, quedan 30; de esos 30 puede que algunos ya no estén en
// condiciones de venderse igual que los primeros 70 —se puso viejo, lo que sea—.
// El comprador marca 15, asumiendo que el precio va a ser más bajo y que la
// rentabilidad cae. Pero siempre sabiendo que queda registrado en la partida».
//
// LOS 15 CAJONES SE VAN A UN LOTE HERMANO, no a una marca al costado. Una marca
// obligaría a partir el disponible por calidad en los diez lugares que hoy suman
// kilos —el despacho, el decomiso, la oferta, los pisos, la reserva— y con que
// uno se olvidara quedaría stock fantasma. El hermano es el lote que se habría
// creado al recibir, si se hubiera sabido: una recepción YA puede traer varios
// lotes del mismo ítem con calidades distintas, así que todo el módulo está
// escrito para esto.
//
// HERMANO Y NO HIJO. Los lotes de reproceso nacen con recepcion_id y oc_item_id
// en NULL, y eso los saca de la partida: la liquidación al productor no los ve,
// el avance nunca llega al 100% y la partida no se puede liquidar nunca. Acá los
// dos campos se HEREDAN y a la madre se le bajan los kilos y los bultos que se
// llevó el hermano, así que la suma por partida sigue dando lo que entró.
try {
  const colsL = db.prepare('PRAGMA table_info(sg_lotes)').all().map((c) => c.name);
  if (!colsL.includes('reclasificado_de')) {
    db.exec('ALTER TABLE sg_lotes ADD COLUMN reclasificado_de INTEGER REFERENCES sg_lotes(id)');
    console.log('[DB] SG sg_lotes.reclasificado_de agregado (de qué lote salió por calidad)');
  }
} catch (e) { console.error('[DB] SG lotes.reclasificado_de:', e.message); }

// EL REGISTRO, QUE NO ES UN CONTADOR. Ningún cálculo de stock ni de costo lee
// esta tabla: lo que se movió ya está descontado en kg_reales y bultos. Es la
// hoja de vida de la partida —cuántos, cuándo, quién y por qué—, y es lo que
// Pablo pidió cuando dijo «que quede registrado». Si además fuera contador,
// alcanzaría con que un sumador se olvidara de restarla para tener stock que no
// existe.
try {
  db.exec(`
  CREATE TABLE IF NOT EXISTS sg_lote_reclasificaciones (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_origen_id    INTEGER NOT NULL REFERENCES sg_lotes(id),
    lote_destino_id   INTEGER NOT NULL REFERENCES sg_lotes(id),
    bultos            INTEGER NOT NULL,
    kg                REAL    NOT NULL,
    costo_movido      REAL    NOT NULL DEFAULT 0,
    calidad_anterior  TEXT,
    calidad_nueva     TEXT    NOT NULL,
    motivo            TEXT    NOT NULL,
    piso_id           INTEGER,
    usuario_id        INTEGER,
    creado_en         TEXT DEFAULT (datetime('now','localtime')),
    -- Deshacer no borra: la fila queda sellada. Una reclasificación que
    -- desaparece deja la partida con un agujero que nadie puede explicar.
    anulada_en        TEXT,
    anulada_por       INTEGER,
    motivo_anulacion  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sg_reclas_origen  ON sg_lote_reclasificaciones(lote_origen_id);
  CREATE INDEX IF NOT EXISTS idx_sg_reclas_destino ON sg_lote_reclasificaciones(lote_destino_id);
  `);
} catch (e) { console.error('[DB] SG sg_lote_reclasificaciones:', e.message); }

// ── QUÉ RENGLÓN DE LA ORDEN SE ABRIÓ PARA LA MERCADERÍA DE SEGUNDA ──────────
//
// Pablo, 29/8/2026: «que separar por calidad parta también el renglón de la orden;
// los 10 de segunda pasan a ser su propio renglón y ahí sí les ponés $20.000 sin
// tocar los 45».
//
// El precio vive en el RENGLÓN de la orden —es de ahí de donde sale lo que se le
// paga al productor—, así que dos calidades con dos precios son dos renglones. Acá
// queda cuál se creó, para poder deshacerlo sin adivinar.
try { db.exec('ALTER TABLE sg_lote_reclasificaciones ADD COLUMN oc_item_creado INTEGER'); } catch (_) {}

// ══ DEVOLUCIÓN DE MERCADERÍA DE UN REMITO ═════════════════════════════════
//
// Pablo, 2/9/2026: «devolución de mercadería de los súper. De un remito particular
// permite hacer una devolución parcial o total, y la mercadería devuelta tiene dos
// opciones: o vuelve al stock eligiendo alguno de los pisos, o se devuelve al
// proveedor. En caso de que se devuelva al proveedor se genera un remito de
// devolución, que lo que hace es descontar de la mercadería ingresada de esa
// partida».
//
// NO SE TOCA EL REMITO ORIGINAL. Lo que salió, salió: el remito es el papel que
// acompañó la mercadería y bajarle los kilos sería reescribir lo que ya pasó —y
// además rompería la cuenta de lo que falta facturar de ese renglón. La devolución
// es un hecho NUEVO que se anota aparte, igual que un decomiso o una
// reclasificación.
//
// LOS DOS DESTINOS NO SON LO MISMO, y la diferencia es dónde queda la mercadería:
//
//   'stock'      vuelve a un piso nuestro y se puede volver a vender. Suma a lo
//                disponible de la partida.
//   'proveedor'  se la devolvemos al productor. NO vuelve a lo disponible —ya había
//                salido con el remito— pero SÍ baja lo ingresado de la partida, que
//                es la cuenta de lo que le debemos.
//
// Por eso son dos acumuladores distintos y no un signo: si fueran el mismo número,
// devolverle diez cajones al productor los haría reaparecer en el piso.
db.exec(`
  CREATE TABLE IF NOT EXISTS sg_devoluciones (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    numero         TEXT UNIQUE,
    despacho_id    INTEGER NOT NULL REFERENCES sg_despachos(id),
    cliente_id     INTEGER REFERENCES sg_clientes(id),
    fecha          TEXT,
    motivo         TEXT,
    -- 'registrada' | 'anulada'. Una devolución mal cargada se anula, no se borra:
    -- el papel salió y el cliente tiene su copia.
    estado         TEXT NOT NULL DEFAULT 'registrada',
    creado_en      TEXT DEFAULT (datetime('now','localtime')),
    creado_por     INTEGER,
    anulado_en     TEXT,
    anulado_por    INTEGER,
    anulado_motivo TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sg_dev_despacho ON sg_devoluciones(despacho_id);

  CREATE TABLE IF NOT EXISTS sg_devolucion_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    devolucion_id    INTEGER NOT NULL REFERENCES sg_devoluciones(id),
    despacho_item_id INTEGER NOT NULL REFERENCES sg_despacho_items(id),
    lote_id          INTEGER REFERENCES sg_lotes(id),
    bultos           REAL NOT NULL DEFAULT 0,
    kg               REAL NOT NULL DEFAULT 0,
    -- A dónde va lo que vuelve. Es la pregunta que hace Pablo y la que decide todo
    -- lo demás.
    destino          TEXT NOT NULL CHECK(destino IN ('stock','proveedor')),
    -- Sólo cuando vuelve al stock: a qué piso entra. Sin esto la partida figura
    -- disponible sin estar en ningún lado y la suma de los pisos deja de cerrar.
    piso_id          INTEGER REFERENCES sg_pisos(id)
  );
  CREATE INDEX IF NOT EXISTS idx_sg_devit_dev  ON sg_devolucion_items(devolucion_id);
  CREATE INDEX IF NOT EXISTS idx_sg_devit_lote ON sg_devolucion_items(lote_id);
  CREATE INDEX IF NOT EXISTS idx_sg_devit_di   ON sg_devolucion_items(despacho_item_id);
`);

console.log('[DB] Módulo San Gerónimo (sg_*) inicializado');

export default db;
