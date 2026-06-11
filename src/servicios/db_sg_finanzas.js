// src/servicios/db_sg_finanzas.js
// ─────────────────────────────────────────────────────────────────────────────
// COPIA SG de los módulos Contable + Ventas + Tesorería de Puente Cordón (PC).
//
// Decisión (Pablo, dueño de la zona contable): COPIAR — no generalizar. Estas
// tablas sg_* son una copia ESTRUCTURAL de las pa_*/ven_*/fin_* de PC, pero
// físicamente separadas para que SG pueda DIVERGIR sin afectar a PC.
//
//  • Arrancan VACÍAS: NO se copia el plan de cuentas, asientos ni movimientos
//    de PC. SG carga su propia contabilidad desde cero.
//  • SIN columna sociedad_id: son tablas single-society (todo acá es SG). El
//    aislamiento PC/SG es físico (tablas distintas), no por discriminador.
//  • Idempotente: CREATE TABLE IF NOT EXISTS. Se puede correr en cada arranque.
//
// NO TOCA NADA de PC (pa_*/ven_*/fin_*) ni de SG Abasto/IFCO (sg_lotes, sg_oc,
// etc.). Sólo crea tablas nuevas con prefijo sg_ del dominio contable/financiero.
// ─────────────────────────────────────────────────────────────────────────────
import db from "./db.js";

db.exec(`
  -- ═══════════════════════════════════════════════════════════════════════════
  -- CONTABLE SG — plan de cuentas (3 niveles), asientos, modelos, config fiscal
  -- ═══════════════════════════════════════════════════════════════════════════

  CREATE TABLE IF NOT EXISTS sg_cuentas_secciones (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo          TEXT NOT NULL UNIQUE,
    nombre          TEXT NOT NULL,
    orden           INTEGER NOT NULL DEFAULT 0,
    activo          INTEGER NOT NULL DEFAULT 1,
    grupo           TEXT DEFAULT 'gastos',  -- activo|pasivo|patrimonio_neto|ingresos|gastos
    creado_en       TEXT DEFAULT (datetime('now','localtime')),
    actualizado_en  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sg_cuentas_titulos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    seccion_id      INTEGER NOT NULL REFERENCES sg_cuentas_secciones(id),
    codigo          TEXT NOT NULL UNIQUE,
    nombre          TEXT NOT NULL,
    orden           INTEGER NOT NULL DEFAULT 0,
    activo          INTEGER NOT NULL DEFAULT 1,
    creado_en       TEXT DEFAULT (datetime('now','localtime')),
    actualizado_en  TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_sg_titulos_seccion ON sg_cuentas_titulos(seccion_id);
  CREATE INDEX IF NOT EXISTS idx_sg_titulos_codigo  ON sg_cuentas_titulos(codigo);

  CREATE TABLE IF NOT EXISTS sg_cuentas (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo            TEXT NOT NULL UNIQUE,
    nombre            TEXT NOT NULL,
    seccion_id        INTEGER NOT NULL REFERENCES sg_cuentas_secciones(id),
    titulo_id         INTEGER REFERENCES sg_cuentas_titulos(id),
    tipo              TEXT NOT NULL DEFAULT 'resultado',  -- resultado|patrimonial
    permite_lote      INTEGER NOT NULL DEFAULT 0,
    permite_campania  INTEGER NOT NULL DEFAULT 0,
    es_sistema        INTEGER NOT NULL DEFAULT 0,
    orden             INTEGER NOT NULL DEFAULT 0,
    activo            INTEGER NOT NULL DEFAULT 1,
    mo_clase          TEXT,
    mo_cultivo        TEXT,
    mo_vigente        INTEGER DEFAULT 0,
    creado_en         TEXT DEFAULT (datetime('now','localtime')),
    actualizado_en    TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_sg_cuentas_seccion ON sg_cuentas(seccion_id);
  CREATE INDEX IF NOT EXISTS idx_sg_cuentas_codigo  ON sg_cuentas(codigo);

  CREATE TABLE IF NOT EXISTS sg_cuentas_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cuenta_id   INTEGER,
    seccion_id  INTEGER,
    accion      TEXT NOT NULL,
    detalle     TEXT,
    usuario_id  INTEGER,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_sg_cuentas_log_cuenta  ON sg_cuentas_log(cuenta_id);
  CREATE INDEX IF NOT EXISTS idx_sg_cuentas_log_seccion ON sg_cuentas_log(seccion_id);
  CREATE INDEX IF NOT EXISTS idx_sg_cuentas_log_fecha   ON sg_cuentas_log(creado_en);

  CREATE TABLE IF NOT EXISTS sg_asientos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha         TEXT NOT NULL DEFAULT (date('now','localtime')),
    descripcion   TEXT NOT NULL,
    usuario_id    INTEGER,
    anulado       INTEGER DEFAULT 0,
    anulado_por   INTEGER,
    anulado_en    TEXT,
    ref_compra_id INTEGER,
    ref_codigo    TEXT,
    creado_en     TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_sg_asientos_fecha ON sg_asientos(fecha);

  CREATE TABLE IF NOT EXISTS sg_asientos_lineas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asiento_id  INTEGER NOT NULL REFERENCES sg_asientos(id),
    cuenta_id   INTEGER NOT NULL REFERENCES sg_cuentas(id),
    debe        REAL NOT NULL DEFAULT 0,
    haber       REAL NOT NULL DEFAULT 0,
    descripcion TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sg_asientos_lineas ON sg_asientos_lineas(asiento_id);

  -- Mayor (legacy en PC: pa_movimientos_contables). Se crea por paridad estructural.
  CREATE TABLE IF NOT EXISTS sg_movimientos_contables (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha         TEXT NOT NULL,
    cuenta_id     INTEGER NOT NULL REFERENCES sg_cuentas(id),
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
  CREATE INDEX IF NOT EXISTS idx_sg_mov_fecha   ON sg_movimientos_contables(fecha);
  CREATE INDEX IF NOT EXISTS idx_sg_mov_cuenta  ON sg_movimientos_contables(cuenta_id);
  CREATE INDEX IF NOT EXISTS idx_sg_mov_origen  ON sg_movimientos_contables(origen_tipo, origen_id);

  CREATE TABLE IF NOT EXISTS sg_asientos_modelo (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre      TEXT NOT NULL,
    descripcion TEXT,
    activo      INTEGER DEFAULT 1,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sg_asientos_modelo_lineas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    modelo_id   INTEGER NOT NULL REFERENCES sg_asientos_modelo(id) ON DELETE CASCADE,
    cuenta_id   INTEGER NOT NULL REFERENCES sg_cuentas(id),
    lado        TEXT NOT NULL CHECK(lado IN ('debe','haber')),
    descripcion TEXT,
    orden       INTEGER DEFAULT 0,
    tipo_linea  TEXT NOT NULL DEFAULT 'libre'
  );

  CREATE TABLE IF NOT EXISTS sg_config_impositiva (
    clave       TEXT PRIMARY KEY,
    cuenta_id   INTEGER REFERENCES sg_cuentas(id),
    descripcion TEXT
  );

  -- ═══════════════════════════════════════════════════════════════════════════
  -- VENTAS SG — clientes, liquidaciones de producto, facturas, cobranzas (CC)
  -- ═══════════════════════════════════════════════════════════════════════════

  CREATE TABLE IF NOT EXISTS sg_ven_clientes (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    razon_social       TEXT NOT NULL,
    nombre_comercial   TEXT,
    cuit               TEXT,
    condicion_iva      TEXT DEFAULT 'responsable_inscripto',
    direccion          TEXT,
    telefono           TEXT,
    email              TEXT,
    contacto           TEXT,
    rubro              TEXT,
    notas              TEXT,
    cuenta_contable_id INTEGER REFERENCES sg_cuentas(id),
    activo             INTEGER NOT NULL DEFAULT 1,
    creado_en          TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sg_ven_liquidaciones (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    numero              TEXT NOT NULL UNIQUE,
    fecha               TEXT NOT NULL DEFAULT (date('now','localtime')),
    cliente_id          INTEGER NOT NULL REFERENCES sg_ven_clientes(id),
    nro_remito          TEXT,
    observaciones       TEXT,
    precio_bruto        REAL NOT NULL DEFAULT 0,
    desc_comision       REAL NOT NULL DEFAULT 0,
    desc_flete          REAL NOT NULL DEFAULT 0,
    desc_carga_descarga REAL NOT NULL DEFAULT 0,
    desc_otros          REAL NOT NULL DEFAULT 0,
    ret_iva             REAL NOT NULL DEFAULT 0,
    ret_ganancias       REAL NOT NULL DEFAULT 0,
    ret_iibb            REAL NOT NULL DEFAULT 0,
    ret_otras           REAL NOT NULL DEFAULT 0,
    neto_acreditar      REAL NOT NULL DEFAULT 0,
    estado              TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','cobrada','anulada')),
    asiento_id          INTEGER REFERENCES sg_asientos(id),
    usuario_id          INTEGER,
    creado_en           TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sg_ven_liquidacion_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    liquidacion_id  INTEGER NOT NULL REFERENCES sg_ven_liquidaciones(id),
    descripcion     TEXT NOT NULL,
    kilos           REAL,
    precio_unitario REAL,
    subtotal        REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sg_ven_facturas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    numero          TEXT NOT NULL UNIQUE,
    fecha           TEXT NOT NULL DEFAULT (date('now','localtime')),
    cliente_id      INTEGER NOT NULL REFERENCES sg_ven_clientes(id),
    tipo            TEXT NOT NULL DEFAULT 'A' CHECK(tipo IN ('A','B','C')),
    concepto        TEXT,
    neto            REAL NOT NULL DEFAULT 0,
    iva             REAL NOT NULL DEFAULT 0,
    total           REAL NOT NULL DEFAULT 0,
    estado          TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','cobrada','anulada')),
    asiento_id      INTEGER REFERENCES sg_asientos(id),
    notas           TEXT,
    usuario_id      INTEGER,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sg_ven_factura_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    factura_id      INTEGER NOT NULL REFERENCES sg_ven_facturas(id),
    descripcion     TEXT NOT NULL,
    cantidad        REAL DEFAULT 1,
    precio_unitario REAL DEFAULT 0,
    subtotal        REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sg_ven_cobranzas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha           TEXT NOT NULL DEFAULT (date('now','localtime')),
    cliente_id      INTEGER NOT NULL REFERENCES sg_ven_clientes(id),
    monto           REAL NOT NULL,
    forma_pago      TEXT DEFAULT 'transferencia',
    referencia      TEXT,
    notas           TEXT,
    anulada         INTEGER NOT NULL DEFAULT 0,
    usuario_id      INTEGER,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sg_ven_cobranza_docs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    cobranza_id     INTEGER NOT NULL REFERENCES sg_ven_cobranzas(id),
    tipo            TEXT NOT NULL CHECK(tipo IN ('liquidacion','factura')),
    doc_id          INTEGER NOT NULL,
    monto           REAL NOT NULL
  );

  -- ═══════════════════════════════════════════════════════════════════════════
  -- TESORERÍA SG — caja/bancos, chequeras, cheques, movimientos, conciliación
  -- (órdenes de pago / pagos a proveedores: tablas creadas por paridad; su UI se
  --  difiere porque dependen del circuito proveedores/compras SG — ver router)
  -- ═══════════════════════════════════════════════════════════════════════════

  CREATE TABLE IF NOT EXISTS sg_fin_cuentas (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre             TEXT NOT NULL,
    tipo               TEXT NOT NULL DEFAULT 'cuenta_corriente',
    banco              TEXT,
    nro_cuenta         TEXT,
    cbu                TEXT,
    alias              TEXT,
    moneda             TEXT NOT NULL DEFAULT 'ARS',
    saldo_inicial      REAL NOT NULL DEFAULT 0,
    cuenta_contable_id INTEGER REFERENCES sg_cuentas(id),
    ambito             TEXT NOT NULL DEFAULT 'fiscal',
    activo             INTEGER NOT NULL DEFAULT 1,
    creado_en          TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sg_fin_chequeras (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    cuenta_id     INTEGER NOT NULL REFERENCES sg_fin_cuentas(id),
    nro_chequera  TEXT,
    desde         INTEGER NOT NULL,
    hasta         INTEGER NOT NULL,
    activo        INTEGER NOT NULL DEFAULT 1,
    creado_en     TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sg_fin_cheques_propios (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chequera_id     INTEGER NOT NULL REFERENCES sg_fin_chequeras(id),
    nro_cheque      INTEGER NOT NULL,
    monto           REAL NOT NULL,
    beneficiario    TEXT,
    fecha_emision   TEXT NOT NULL DEFAULT (date('now','localtime')),
    fecha_vto       TEXT,
    estado          TEXT NOT NULL DEFAULT 'emitido',
    notas           TEXT,
    pago_id         INTEGER,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sg_fin_cheques_terceros (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    banco              TEXT,
    nro_cheque         TEXT,
    librador           TEXT,
    monto              REAL NOT NULL,
    fecha_recepcion    TEXT NOT NULL DEFAULT (date('now','localtime')),
    fecha_vto          TEXT,
    estado             TEXT NOT NULL DEFAULT 'en_cartera',
    cuenta_destino     INTEGER REFERENCES sg_fin_cuentas(id),
    cuenta_contable_id INTEGER REFERENCES sg_cuentas(id),
    notas              TEXT,
    creado_en          TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sg_fin_movimientos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    cuenta_id     INTEGER NOT NULL REFERENCES sg_fin_cuentas(id),
    fecha         TEXT NOT NULL DEFAULT (date('now','localtime')),
    tipo          TEXT NOT NULL DEFAULT 'egreso',
    concepto      TEXT NOT NULL,
    monto         REAL NOT NULL,
    referencia    TEXT,
    pago_id       INTEGER,
    cheque_id     INTEGER,
    conciliado    INTEGER NOT NULL DEFAULT 0,
    usuario_id    INTEGER,
    creado_en     TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_sg_fin_mov_cuenta ON sg_fin_movimientos(cuenta_id);

  CREATE TABLE IF NOT EXISTS sg_fin_extracto_lineas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    cuenta_id       INTEGER NOT NULL REFERENCES sg_fin_cuentas(id),
    fecha           TEXT NOT NULL,
    concepto        TEXT,
    monto           REAL NOT NULL,
    tipo            TEXT NOT NULL DEFAULT 'egreso' CHECK(tipo IN ('ingreso','egreso')),
    referencia      TEXT,
    conciliado      INTEGER NOT NULL DEFAULT 0,
    movimiento_id   INTEGER REFERENCES sg_fin_movimientos(id),
    periodo         TEXT,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sg_fin_conciliaciones (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    cuenta_id       INTEGER NOT NULL REFERENCES sg_fin_cuentas(id),
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

  -- Órdenes de pago / pagos a proveedores (estructura por paridad; UI diferida).
  -- proveedor_id / compra_id quedan como INTEGER sin FK: el circuito de
  -- proveedores/compras de SG vive en SG Abasto y su vínculo es una decisión de
  -- divergencia futura. NO referencian adm_proveedores/pa_compras (serían de PC).
  CREATE TABLE IF NOT EXISTS sg_pagos_proveedores (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha         TEXT NOT NULL DEFAULT (date('now','localtime')),
    proveedor_id  INTEGER NOT NULL,
    monto         REAL NOT NULL,
    forma_pago    TEXT NOT NULL DEFAULT 'transferencia',
    banco         TEXT,
    referencia    TEXT,
    notas         TEXT,
    usuario_id    INTEGER,
    anulado       INTEGER DEFAULT 0,
    creado_en     TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sg_pagos_compras (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pago_id     INTEGER NOT NULL REFERENCES sg_pagos_proveedores(id),
    compra_id   INTEGER NOT NULL,
    monto       REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sg_fin_ordenes_pago (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    numero          TEXT NOT NULL UNIQUE,
    fecha           TEXT NOT NULL DEFAULT (date('now','localtime')),
    proveedor_id    INTEGER NOT NULL,
    monto_total     REAL NOT NULL,
    forma_pago      TEXT NOT NULL DEFAULT 'transferencia',
    cuenta_fin_id   INTEGER REFERENCES sg_fin_cuentas(id),
    cheque_prop_id  INTEGER REFERENCES sg_fin_cheques_propios(id),
    cheque_ter_id   INTEGER REFERENCES sg_fin_cheques_terceros(id),
    referencia      TEXT,
    notas           TEXT,
    estado          TEXT NOT NULL DEFAULT 'emitida' CHECK(estado IN ('emitida','anulada')),
    movimiento_id   INTEGER REFERENCES sg_fin_movimientos(id),
    asiento_id      INTEGER REFERENCES sg_asientos(id),
    usuario_id      INTEGER,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sg_fin_op_compras (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    op_id       INTEGER NOT NULL REFERENCES sg_fin_ordenes_pago(id),
    compra_id   INTEGER NOT NULL,
    monto       REAL NOT NULL
  );
`);

// Scaffolding estructural de la config impositiva (claves, sin mapeo a cuenta).
// NO son datos de PC: son las 4 claves fiscales que la pantalla espera existir.
// SG arranca con cuenta_id = NULL (sin mapear) y las asigna a sus propias cuentas.
{
  const ins = db.prepare(
    "INSERT OR IGNORE INTO sg_config_impositiva (clave, cuenta_id, descripcion) VALUES (?, NULL, ?)"
  );
  const claves = [
    ['percepcion_iva',       'Percepción IVA'],
    ['percepcion_iibb',      'Percepción IIBB'],
    ['percepcion_ganancias', 'Percepción Ganancias'],
    ['retencion',            'Retención'],
    ['ventas',               'Cuenta de Ventas (haber)'],
  ];
  for (const [clave, desc] of claves) ins.run(clave, desc);
}

console.log("[SG] Esquema Contable/Ventas/Tesorería SG verificado (tablas sg_* vacías)");

export default db;
