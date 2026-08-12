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

  -- ⚠️ DEPRECADA (#401, Camino A): el padrón maestro de clientes SG es sg_clientes.
  -- Ventas SG (sg_ventas.js) opera sobre sg_clientes; las FK cliente_id de liquidaciones/
  -- facturas/cobranzas apuntan a sg_clientes. Esta tabla queda vacía y SIN uso — NO borrar
  -- todavía (se conserva por historial de esquema). No reintroducir en el CRUD.
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
    cliente_id          INTEGER NOT NULL REFERENCES sg_clientes(id),  -- re-apuntado #401 (Camino A)
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
    cliente_id      INTEGER NOT NULL REFERENCES sg_clientes(id),  -- re-apuntado #401
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
    cliente_id      INTEGER NOT NULL REFERENCES sg_clientes(id),  -- re-apuntado #401
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
    // Estas dos FALTABAN y son las que más se usan: sin iva_credito_fiscal no se
    // puede registrar ninguna factura con IVA. Puente Cordón ya pasó por este
    // mismo agujero (db_pa.js), y ahí además el PUT era un UPDATE sobre una fila
    // inexistente: afectaba 0 filas y la pantalla igual decía "guardado".
    ['iva_credito_fiscal',   'IVA Crédito Fiscal'],
    ['iva_debito_fiscal',    'IVA Débito Fiscal'],
    ['percepcion_iva',       'Percepción IVA'],
    ['percepcion_iibb',      'Percepción IIBB'],
    ['percepcion_ganancias', 'Percepción Ganancias'],
    ['retencion',            'Retención'],
    ['ventas',               'Cuenta de Ventas (haber)'],
  ];
  for (const [clave, desc] of claves) ins.run(clave, desc);
}

// ── CUENTAS QUE SÓLO PUEDE USAR CIERTA GENTE ──────────────────────────────
// Lo pidió el dueño: hay cuentas que no las tiene que poder tocar cualquiera.
//
// CÓMO FUNCIONA, en una línea: una cuenta SIN nadie tildado la usa cualquiera
// que entre al módulo — que es como funcionaba hasta ahora, así que esto no le
// saca acceso a nadie de un día para el otro. Apenas se tilda a UNA persona, la
// cuenta pasa a ser restringida y sólo esa gente la puede imputar.
//
// Es una lista blanca y no un flag "restringida": si fuera un flag más una
// lista, se podrían contradecir —restringida sin nadie adentro deja la cuenta
// inutilizable, o no restringida con gente adentro no quiere decir nada— y
// alguien tendría que acordarse de mantener los dos coherentes. Con la lista
// sola no hay estado imposible.
//
// El ADMIN siempre puede: si no, una cuenta restringida a alguien que se va de
// la empresa quedaría sin nadie que la pueda usar ni destrabar.
db.exec(`
  CREATE TABLE IF NOT EXISTS sg_cuentas_usuarios (
    cuenta_id  INTEGER NOT NULL REFERENCES sg_cuentas(id) ON DELETE CASCADE,
    usuario_id INTEGER NOT NULL,
    creado_en  TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (cuenta_id, usuario_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sg_ctas_usr_usuario ON sg_cuentas_usuarios(usuario_id);
`);

// ── #401 (Camino A): Ventas SG re-apuntada a sg_clientes ───────────────────────
// 1) sg_clientes += nombre_comercial (aditivo; alias/CF). sg_clientes ya existe (db_sg.js
//    corre antes que este archivo). Self-healing.
try {
  const cols = db.prepare("PRAGMA table_info(sg_clientes)").all().map(c => c.name);
  if (!cols.includes('nombre_comercial')) {
    db.exec("ALTER TABLE sg_clientes ADD COLUMN nombre_comercial TEXT");
    console.log('[DB] SG sg_clientes migrado (+nombre_comercial)');
  }
} catch (e) { console.error('[DB] SG migración sg_clientes (nombre_comercial):', e.message); }

// 2) Re-apuntar FK cliente_id de liquidaciones/facturas/cobranzas → sg_clientes en DBs ya
//    deployadas (las nuevas ya se crean con la FK correcta arriba). Idempotente: solo
//    rebuildea si el DDL aún referencia sg_ven_clientes. DATA-SAFE: ABORTA si hay filas.
function _repointClienteFK(table, newCreateSql) {
  try {
    const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!cur || !/REFERENCES sg_ven_clientes/.test(cur.sql)) return; // ya re-apuntada
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    if (n > 0) { console.error(`[DB] SG re-apuntar ${table}: ABORTA — tiene ${n} filas, no se rebuildea`); return; }
    const fkPrev = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(newCreateSql);                                   // crea <table>_new con FK a sg_clientes
      db.exec(`INSERT INTO ${table}_new SELECT * FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    })();
    db.pragma(`foreign_keys = ${fkPrev ? 'ON' : 'OFF'}`);
    console.log(`[DB] SG ${table} re-apuntada a sg_clientes`);
  } catch (e) { console.error(`[DB] SG re-apuntar ${table}:`, e.message); }
}
_repointClienteFK('sg_ven_liquidaciones', `
  CREATE TABLE sg_ven_liquidaciones_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT NOT NULL UNIQUE,
    fecha TEXT NOT NULL DEFAULT (date('now','localtime')),
    cliente_id INTEGER NOT NULL REFERENCES sg_clientes(id),
    nro_remito TEXT, observaciones TEXT,
    precio_bruto REAL NOT NULL DEFAULT 0, desc_comision REAL NOT NULL DEFAULT 0,
    desc_flete REAL NOT NULL DEFAULT 0, desc_carga_descarga REAL NOT NULL DEFAULT 0,
    desc_otros REAL NOT NULL DEFAULT 0, ret_iva REAL NOT NULL DEFAULT 0,
    ret_ganancias REAL NOT NULL DEFAULT 0, ret_iibb REAL NOT NULL DEFAULT 0,
    ret_otras REAL NOT NULL DEFAULT 0, neto_acreditar REAL NOT NULL DEFAULT 0,
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','cobrada','anulada')),
    asiento_id INTEGER REFERENCES sg_asientos(id), usuario_id INTEGER,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  )`);
_repointClienteFK('sg_ven_facturas', `
  CREATE TABLE sg_ven_facturas_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT NOT NULL UNIQUE,
    fecha TEXT NOT NULL DEFAULT (date('now','localtime')),
    cliente_id INTEGER NOT NULL REFERENCES sg_clientes(id),
    tipo TEXT NOT NULL DEFAULT 'A' CHECK(tipo IN ('A','B','C')),
    concepto TEXT, neto REAL NOT NULL DEFAULT 0, iva REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','cobrada','anulada')),
    asiento_id INTEGER REFERENCES sg_asientos(id), notas TEXT, usuario_id INTEGER,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  )`);
_repointClienteFK('sg_ven_cobranzas', `
  CREATE TABLE sg_ven_cobranzas_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL DEFAULT (date('now','localtime')),
    cliente_id INTEGER NOT NULL REFERENCES sg_clientes(id),
    monto REAL NOT NULL, forma_pago TEXT DEFAULT 'transferencia',
    referencia TEXT, notas TEXT, anulada INTEGER NOT NULL DEFAULT 0,
    usuario_id INTEGER, creado_en TEXT DEFAULT (datetime('now','localtime'))
  )`);

console.log("[SG] Esquema Contable/Ventas/Tesorería SG verificado (tablas sg_* vacías)");

// ═══════════════════════════════════════════════════════════════════════════
// EL PLAN DE CUENTAS DE SAN GERÓNIMO VA EN LAS TABLAS DE SAN GERÓNIMO
// ═══════════════════════════════════════════════════════════════════════════
// Arregla un error propio. El PR #630 le sembró a San Gerónimo el esqueleto del
// plan de cuentas DENTRO de las tablas de Puente Cordón (pa_cuentas_secciones y
// pa_cuentas_titulos, marcadas con sociedad_id), en vez de en las suyas. Quedó
// con dos medios planes: unas secciones y títulos adentro del plan de PC, y sus
// 28 tablas propias vacías. Es exactamente lo contrario de que cada empresa
// tenga lo suyo.
//
// Hace dos cosas, en este orden:
//   1. SIEMBRA el esqueleto en sg_cuentas_secciones y sg_cuentas_titulos.
//   2. SACA de las tablas de Puente Cordón lo que había quedado de SG.
//
// EL PASO 2 NO BORRA A CIEGAS. pa_cuentas referencia tanto secciones como
// títulos, así que antes de borrar cada fila se comprueba que NADA la esté
// usando. Si algo la usa, no se toca y se avisa por consola con el detalle. Una
// fila de más molesta; una cuenta contable que apunta a una sección que ya no
// existe rompe el plan de cuentas entero.
//
// Todo dentro de db.transaction(): si algo falla, no queda a medias.
(function moverPlanDeCuentasSGaSusTablas() {
  try {
    const hayTabla = (t) =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    // Las tablas pa_* las crea db_pa.js. Según el orden de imports puede no haber
    // corrido todavía: en ese caso no hay nada que mover y se sale sin ruido.
    if (!hayTabla('pa_cuentas_secciones') || !hayTabla('pa_cuentas_titulos')) return;

    const tieneCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);
    if (!tieneCol('pa_cuentas_secciones', 'sociedad_id')) return;   // sin multisociedad, nada que separar

    const soc = (n) => db.prepare('SELECT id FROM sociedades WHERE nombre = ?').get(n)?.id ?? null;
    const SG = soc('San Gerónimo SA');
    const PC = soc('Puente Cordón SA')
            ?? db.prepare("SELECT id FROM sociedades WHERE funcion='productiva' ORDER BY id LIMIT 1").get()?.id;
    if (!SG || !PC) return;

    // ── 1) Sembrar el esqueleto en las tablas de San Gerónimo ─────────────
    // Sólo si están vacías: si el contador ya empezó a cargar el plan de SG,
    // esto no tiene nada que hacer ahí.
    const nSecSG = db.prepare('SELECT COUNT(*) c FROM sg_cuentas_secciones').get().c;
    const nTitSG = db.prepare('SELECT COUNT(*) c FROM sg_cuentas_titulos').get().c;

    // ── ESTO SEMBRABA CADA VEZ QUE EL PLAN QUEDABA VACÍO, Y ESO ESTÁ MAL ──
    // La condición era "si no hay secciones o no hay títulos, copiá el esqueleto
    // de Puente Cordón". Funcionó mientras "borrar" un rubro era en realidad
    // "desactivarlo": la tabla nunca quedaba vacía, así que sembraba una sola vez
    // y no se notaba.
    //
    // Desde que el borrado es REAL, vaciar el plan es algo que el contable hace a
    // propósito mientras lo arma — y al siguiente despliegue le volvían las 26
    // secciones de Puente Cordón, Activo incluido. Borraba, se iba, volvía al día
    // siguiente y estaban de nuevo.
    //
    // Ahora la semilla se planta UNA VEZ y queda anotada. Vaciar el plan es una
    // decisión del que lo está armando, y el sistema no la discute.
    db.exec(`
      CREATE TABLE IF NOT EXISTS sistema_flags (
        key          TEXT PRIMARY KEY,
        valor        TEXT,
        ejecutado_en TEXT DEFAULT (datetime('now','localtime'))
      );
    `);
    const MARCA_SEMILLA = 'sg_plan_semilla_v1';
    const yaSembro = !!db.prepare('SELECT key FROM sistema_flags WHERE key = ?').get(MARCA_SEMILLA);

    // Si el plan YA tiene algo, la semilla está puesta aunque nadie la haya
    // anotado: es una base de antes de esta marca. Se anota y no se siembra.
    if (!yaSembro && (nSecSG > 0 || nTitSG > 0)) {
      db.prepare('INSERT OR IGNORE INTO sistema_flags (key, valor) VALUES (?, ?)')
        .run(MARCA_SEMILLA, JSON.stringify({ ya_estaba: true, secciones: nSecSG, titulos: nTitSG }));
    }

    if (!yaSembro && nSecSG === 0 && nTitSG === 0) {
      const secsPC = db.prepare(`SELECT codigo, nombre, orden, activo, grupo
                                   FROM pa_cuentas_secciones WHERE sociedad_id = ? ORDER BY codigo`).all(PC);
      const titsPC = db.prepare(`SELECT t.codigo, t.nombre, t.orden, t.activo, s.codigo AS sec
                                   FROM pa_cuentas_titulos t
                                   JOIN pa_cuentas_secciones s ON s.id = t.seccion_id
                                  WHERE t.sociedad_id = ? ORDER BY t.codigo`).all(PC);
      if (secsPC.length) {
        const haySec = db.prepare('SELECT id FROM sg_cuentas_secciones WHERE codigo = ?');
        const insSec = db.prepare(
          'INSERT INTO sg_cuentas_secciones (codigo, nombre, orden, activo, grupo) VALUES (?,?,?,?,?)');
        const hayTit = db.prepare('SELECT 1 FROM sg_cuentas_titulos WHERE codigo = ?');
        const insTit = db.prepare(
          'INSERT INTO sg_cuentas_titulos (seccion_id, codigo, nombre, orden, activo) VALUES (?,?,?,?,?)');
        let s = 0, t = 0;
        db.transaction(() => {
          if (nSecSG === 0) for (const x of secsPC) {
            if (haySec.get(x.codigo)) continue;
            insSec.run(x.codigo, x.nombre, x.orden, x.activo, x.grupo || 'gastos');
            s++;
          }
          if (nTitSG === 0) for (const x of titsPC) {
            if (hayTit.get(x.codigo)) continue;
            const dest = haySec.get(x.sec);
            if (!dest) continue;              // sin su sección, el título no tiene dónde ir
            insTit.run(dest.id, x.codigo, x.nombre, x.orden, x.activo);
            t++;
          }
        })();
        db.prepare('INSERT OR IGNORE INTO sistema_flags (key, valor) VALUES (?, ?)')
          .run(MARCA_SEMILLA, JSON.stringify({ secciones: s, titulos: t }));
        if (s || t) {
          console.log(`[SG] Plan de cuentas propio: ${s} sección(es) y ${t} título(s) sembrados ` +
                      `en sg_cuentas_secciones/sg_cuentas_titulos (0 cuentas — las carga el contador). ` +
                      `Se siembra UNA sola vez: si después se vacía el plan, no vuelve.`);
        }
      }
    }

    // ── 2) Sacar de las tablas de Puente Cordón lo que era de SG ──────────
    // Primero los títulos, después las secciones: al revés, borrar una sección
    // dejaría títulos apuntando a algo que ya no existe.
    const paTieneTitulo = tieneCol('pa_cuentas', 'titulo_id');
    const usaTitulo = paTieneTitulo
      ? db.prepare('SELECT COUNT(*) c FROM pa_cuentas WHERE titulo_id = ?')
      : null;
    const usaSeccion  = db.prepare('SELECT COUNT(*) c FROM pa_cuentas WHERE seccion_id = ?');
    const titEnSeccion = db.prepare('SELECT COUNT(*) c FROM pa_cuentas_titulos WHERE seccion_id = ?');

    const titsSG = db.prepare(
      'SELECT id, codigo FROM pa_cuentas_titulos WHERE sociedad_id = ?').all(SG);
    const secsSG = db.prepare(
      'SELECT id, codigo FROM pa_cuentas_secciones WHERE sociedad_id = ?').all(SG);
    if (!titsSG.length && !secsSG.length) return;

    const delTit = db.prepare('DELETE FROM pa_cuentas_titulos WHERE id = ?');
    const delSec = db.prepare('DELETE FROM pa_cuentas_secciones WHERE id = ?');
    let borradosT = 0, borradasS = 0;
    const enUso = [];

    db.transaction(() => {
      for (const t of titsSG) {
        const n = usaTitulo ? usaTitulo.get(t.id).c : 0;
        if (n > 0) { enUso.push(`título ${t.codigo} (usado por ${n} cuenta(s))`); continue; }
        delTit.run(t.id); borradosT++;
      }
      for (const s of secsSG) {
        const nc = usaSeccion.get(s.id).c;
        const nt = titEnSeccion.get(s.id).c;
        if (nc > 0 || nt > 0) {
          enUso.push(`sección ${s.codigo} (usada por ${nc} cuenta(s) y ${nt} título(s))`);
          continue;
        }
        delSec.run(s.id); borradasS++;
      }
    })();

    if (borradosT || borradasS) {
      console.log(`[SG] Sacadas de las tablas de Puente Cordón: ${borradasS} sección(es) y ` +
                  `${borradosT} título(s) que eran de San Gerónimo. Su plan vive en sg_*.`);
    }
    if (enUso.length) {
      console.warn(`[SG] NO se sacaron ${enUso.length} fila(s) de las tablas de Puente Cordón ` +
                   `porque algo las está usando — se dejan para revisar a mano:`);
      for (const x of enUso.slice(0, 12)) console.warn(`     · ${x}`);
    }
  } catch (e) {
    console.error('[SG] Error moviendo el plan de cuentas de San Gerónimo a sus tablas:', e.message);
  }
})();

export default db;
