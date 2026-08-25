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

  -- ══ QUÉ REMITO DOCUMENTA ESTA LIQUIDACIÓN ════════════════════════
  -- Espejo de sg_factura_despachos. Sin esto, nro_remito era texto libre: los
  -- kilos del remito NUNCA se descontaban, el despacho quedaba pendiente para
  -- siempre y nada frenába que después se le emitiera ADEMÁS una factura por la
  -- misma mercadería -- que es exactamente el problema que documenta
  -- servicios/factura-cuenta.js, del otro lado del mostrador.
  --
  -- despacho_id/despacho_item_id van sin FK a propósito: los despachos son del
  -- módulo de abasto y una FK hacia allá hace fallar sus DELETE (CLAUDE.md).
  CREATE TABLE IF NOT EXISTS sg_liquidacion_despachos (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    liquidacion_id   INTEGER NOT NULL REFERENCES sg_ven_liquidaciones(id),
    despacho_id      INTEGER NOT NULL,
    despacho_item_id INTEGER,
    kg               REAL,
    creado_en        TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_sg_liq_desp_liq  ON sg_liquidacion_despachos(liquidacion_id);
  CREATE INDEX IF NOT EXISTS idx_sg_liq_desp_item ON sg_liquidacion_despachos(despacho_item_id);

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

// ── LA COBRANZA TIENE QUE ENTRAR AL LIBRO Y A LA CAJA ─────────────────────
// El circuito de cobranzas existía —se registraba, se imputaba a facturas y
// liquidaciones, se marcaba el documento como cobrado— pero se quedaba ahí: no
// generaba asiento y no movía ninguna cuenta. Entraba la plata y no subía nada.
//
// Por eso la cuenta corriente de clientes mostraba "cobrado = 0": no era que
// faltara la consulta, era que la cobranza no tenía de dónde salir para la
// contabilidad. Es el mismo agujero que tenía proveedores antes de los pagos.
try { db.exec("ALTER TABLE sg_ven_cobranzas ADD COLUMN cuenta_fin_id INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE sg_ven_cobranzas ADD COLUMN asiento_id INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE sg_ven_cobranzas ADD COLUMN anulada_en TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sg_ven_cobranzas ADD COLUMN anulada_por INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE sg_ven_cobranzas ADD COLUMN anulada_motivo TEXT"); } catch (_) {}
// El cheque de terceros que entra cobrando: el vínculo con la cartera.
try { db.exec("ALTER TABLE sg_ven_cobranzas ADD COLUMN cheque_terceros_id INTEGER"); } catch (_) {}
// EL ESPEJO DE LA COMPRA, del lado de las ventas. Se acordó vender en 20.000 y
// se facturaron 10.000: el cliente debe 20.000 y a AFIP se le informan 10.000.
// Mismo criterio que en sg_facturas_compra — el total es el del comprobante y no
// se toca, la diferencia va aparte con su motivo.
try { db.exec("ALTER TABLE sg_ven_facturas ADD COLUMN dif_gestion REAL NOT NULL DEFAULT 0"); } catch (_) {}
// El descuento comercial que se le aplicó a esta factura. Es la parte que NO
// se facturó por el acuerdo con el proveedor de esa mercadería, y que va al
// asiento como venta de gestión. Se guarda en el comprobante para poder
// sumarlo por período sin volver a recorrer los asientos.
try { db.exec("ALTER TABLE sg_ven_facturas ADD COLUMN descuento_gestion REAL"); } catch (_) {}
try { db.exec("ALTER TABLE sg_ven_facturas ADD COLUMN dif_motivo TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sg_ven_liquidaciones ADD COLUMN dif_gestion REAL NOT NULL DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE sg_ven_liquidaciones ADD COLUMN dif_motivo TEXT"); } catch (_) {}

// ── UN PAGO ELIGE QUÉ CANCELA ─────────────────────────────────────────────
// Una factura puede deber dos cosas: lo que dice el comprobante y lo que quedó
// sin facturar. Un pago puede ir contra una, contra la otra o contra las dos —y
// hace falta saber cuál, porque un pago que cancela la parte sin comprobante NO
// puede aparecer en el libro fiscal: ahí esa deuda nunca subió.
//
// `saldo_pagado` sigue siendo el total pagado; `saldo_pagado_gestion` es cuánto
// de eso fue contra la parte sin facturar. Lo fiscal es la resta.
try { db.exec("ALTER TABLE sg_facturas_compra ADD COLUMN saldo_pagado_gestion REAL NOT NULL DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE sg_pagos_compras ADD COLUMN monto_gestion REAL NOT NULL DEFAULT 0"); } catch (_) {}
// CONTRA QUÉ COMPROBANTE SE IMPUTÓ. Una partida se documenta con factura O con
// liquidación, y las dos son deuda con el productor. Sin esta columna, compra_id
// significaba siempre "factura de compra" y la liquidación no se podía pagar.
// Default 'factura': todo lo que ya está cargado es eso.
try { db.exec("ALTER TABLE sg_pagos_compras ADD COLUMN tipo TEXT NOT NULL DEFAULT 'factura'"); } catch (_) {}
try { db.exec("ALTER TABLE sg_pagos_proveedores ADD COLUMN ambito_pago TEXT NOT NULL DEFAULT 'todo'"); } catch (_) {}

// ── A QUIÉN SE LE MANDÓ CADA COMPROBANTE ──────────────────────────────────
// Mandar la factura por mail sin dejar rastro deja una sola pregunta sin
// respuesta, y es la que siempre se hace: «esta factura, ¿se la mandaron?». Sin
// esto la contestan dos personas distintas y las dos la mandan de nuevo.
//
// Se anota el INTENTO, no sólo el éxito: un mail que rebotó es información —
// probablemente la dirección del cliente está mal y hay que corregirla.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS sg_ven_envios (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    factura_id    INTEGER NOT NULL,
    para          TEXT NOT NULL,
    asunto        TEXT,
    ok            INTEGER NOT NULL DEFAULT 1,
    error         TEXT,
    usuario_id    INTEGER,
    enviado_en    TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_sg_ven_envios_fac ON sg_ven_envios(factura_id)');
} catch (e) { console.error('[SG] sg_ven_envios:', e.message); }

// ── LOS PUNTOS DE VENTA ───────────────────────────────────────────────────
// Estaban ESCRITOS A MANO en el HTML —7, 9, 11 y 13—, así que dar de alta uno
// nuevo o dar de baja el que ya no se usa era tocar el panel. Y el número solo
// no alcanza: cada punto de venta tiene su condición de emisión, su CUIT, y si
// factura electrónicamente, un certificado que VENCE.
//
// Ese vencimiento es el que importa: cuando se pasa, AFIP deja de aceptar los
// comprobantes y se descubre el día que no se puede facturar. Guardarlo acá
// permite avisar antes.
//
// Las claves privadas NO van en esta tabla ni en ninguna que el panel devuelva:
// lo que se guarda es de qué certificado se trata y hasta cuándo sirve.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS sg_puntos_venta (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    numero            INTEGER NOT NULL UNIQUE,
    nombre            TEXT,
    emision           TEXT NOT NULL DEFAULT 'electronica'
                        CHECK(emision IN ('electronica','manual','preimpreso')),
    ambiente          TEXT NOT NULL DEFAULT 'produccion'
                        CHECK(ambiente IN ('produccion','homologacion')),
    cuit_emisor       TEXT,
    domicilio         TEXT,
    -- Del certificado se guarda con qué se lo identifica y hasta cuándo vale.
    -- El .crt y la clave privada NO viven acá.
    cert_alias        TEXT,
    cert_vence        TEXT,
    comprobantes      TEXT,          -- 'A,B,C' — cuáles emite este punto
    notas             TEXT,
    activo            INTEGER NOT NULL DEFAULT 1,
    creado_en         TEXT DEFAULT (datetime('now','localtime')),
    modificado_en     TEXT,
    modificado_por    INTEGER
  )`);
  // Los cuatro que estaban escritos en el panel, para que nada deje de andar el
  // día que esto se despliega. Si ya hay puntos cargados, no se toca nada.
  // UN PUNTO DE VENTA DE PRUEBA. Sirve para recorrer el circuito entero
  // —registrar, imprimir, ver el asiento y la cuenta corriente— SIN informarle
  // nada a AFIP. Los comprobantes que salgan de él no son fiscales, así que
  // tienen que poder dejarse afuera de los saldos y los informes.
  try { db.exec("ALTER TABLE sg_puntos_venta ADD COLUMN es_prueba INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
  // Y la factura se queda con la marca: el punto de venta puede cambiar
  // después, y lo que hay que saber es si ESE comprobante fue una prueba.
  try { db.exec("ALTER TABLE sg_ven_facturas ADD COLUMN es_prueba INTEGER NOT NULL DEFAULT 0"); } catch (_) {}

  const hay = db.prepare('SELECT COUNT(*) c FROM sg_puntos_venta').get().c;
  if (!hay) {
    const ins = db.prepare("INSERT INTO sg_puntos_venta (numero, nombre, comprobantes) VALUES (?,?,'A,B')");
    for (const n of [7, 9, 11, 13]) ins.run(n, 'Punto de venta ' + n);
    console.log('[SG] Puntos de venta: se cargaron los 4 que estaban escritos en el panel');
  }
} catch (e) { console.error('[SG] sg_puntos_venta:', e.message); }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sg_cob_cliente ON sg_ven_cobranzas(cliente_id)"); } catch (_) {}

// ── DOS NÚMEROS DE LA MISMA OPERACIÓN ─────────────────────────────────────
// El comprador arregla el tomate en 20.000 y la factura viene por 10.000. Al
// proveedor se le deben 20.000; a AFIP se le informa la factura de 10.000. Los
// dos números son ciertos y hasta ahora el sistema sólo podía guardar uno: el
// otro terminaba en la cabeza del comprador o en una planilla.
//
// EL ÁMBITO VIAJA EN LA LÍNEA, NO EN EL RECIPIENTE. Un mismo asiento —un solo
// número, el que se cita cuando se discute algo— lleva las líneas fiscales y
// las de gestión, y CADA ÁMBITO BALANCEA POR SU CUENTA adentro de ese asiento.
// Ponerlo en la cabecera obligaría a dos asientos con dos números para la misma
// operación; ponerlo en la caja obligaría a partir la caja en dos.
//
// El motivo es obligatorio en las de gestión y sale de una lista corta (ver
// servicios/asientos.js): una diferencia sin motivo es una diferencia que nadie
// va a reclamar nunca.
try { db.exec("ALTER TABLE sg_asientos_lineas ADD COLUMN ambito TEXT NOT NULL DEFAULT 'fiscal'"); } catch (_) {}
try { db.exec("ALTER TABLE sg_asientos_lineas ADD COLUMN motivo TEXT"); } catch (_) {}
// Quién la creó. La cabecera ya guarda quién hizo el asiento, pero una línea de
// gestión puede agregarse después y sobre todo hay que poder MEDIR quién las
// viene usando: de eso depende la decisión de restringir el permiso más adelante.
try { db.exec("ALTER TABLE sg_asientos_lineas ADD COLUMN usuario_id INTEGER"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sg_asi_lin_ambito ON sg_asientos_lineas(ambito)"); } catch (_) {}

// Y lo mismo del lado de la plata: el movimiento sabe de qué ámbito es, así una
// misma caja puede tener los dos sin partirla en dos cajas.
try { db.exec("ALTER TABLE sg_fin_movimientos ADD COLUMN ambito TEXT NOT NULL DEFAULT 'fiscal'"); } catch (_) {}
// ══ LA COBRANZA TAMBIÉN SE PARTE EN DOS ══════════════════════════
// Es el espejo del pago a proveedores, y ese ya lo tenía. La pantalla dejaba
// imputar hasta lo ACORDADO --comprobante + lo que quedó sin facturar-- pero el
// asiento le acreditaba al cliente el 100% en el libro FISCAL: ahí esa parte de la
// deuda nunca subió, así que la cuenta corriente bajaba por plata que no había
// entrado, y la columna «Sin facturar» no bajaba nunca aunque el cliente ya hubiera
// pagado.
try { db.exec("ALTER TABLE sg_ven_cobranza_docs ADD COLUMN monto_gestion REAL NOT NULL DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE sg_fin_movimientos ADD COLUMN motivo TEXT"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sg_fin_mov_ambito ON sg_fin_movimientos(ambito)"); } catch (_) {}

// ── UN PAGO SE PAGA CON VARIAS COSAS ──────────────────────────────────────
// La orden de pago tenía UNA cuenta y UNA forma: o todo en efectivo, o todo por
// transferencia, o todo con un cheque. En la vida real un pago de 500.000 sale
// como 100.000 de la caja, un cheque a 30 días por 300.000 y una transferencia
// por el resto — y con una sola forma había que cargarlo como tres pagos
// distintos, que después figuran como tres movimientos que nadie sabe que eran
// el mismo.
//
// Los medios cuelgan del pago. sg_pagos_proveedores.cuenta_fin_id se conserva
// —apunta al primer medio— para no romper lo que ya lo lee.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_pagos_medios (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pago_id       INTEGER NOT NULL REFERENCES sg_pagos_proveedores(id),
      forma_pago    TEXT NOT NULL DEFAULT 'transferencia',
      cuenta_fin_id INTEGER NOT NULL REFERENCES sg_fin_cuentas(id),
      monto         REAL NOT NULL,
      referencia    TEXT,
      chequera_id   INTEGER,
      nro_cheque    INTEGER,
      cheque_id     INTEGER,
      creado_en     TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_sg_pagos_medios ON sg_pagos_medios(pago_id);
  `);
} catch (e) { console.error('[SG] sg_pagos_medios:', e.message); }

// ── PAGAR CON UN CHEQUE QUE NOS DIERON NO SACA PLATA DE NINGÚN LADO ───────
// Endosar un cheque de terceros cancela deuda con el proveedor sin que salga un
// peso del banco ni de la caja: sale de la cartera. Pero cuenta_fin_id estaba
// declarada NOT NULL, así que ese medio no se podía ni registrar.
//
// La columna se afloja rehaciendo la tabla —SQLite no sabe sacar un NOT NULL— y
// de paso se agrega de qué cheque se trata. Se hace UNA sola vez: si ya está
// nullable, se salta.
try {
  const cols = db.prepare('PRAGMA table_info(sg_pagos_medios)').all();
  const cf = cols.find((c) => c.name === 'cuenta_fin_id');
  if (cf && cf.notnull) {
    const fkPrev = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE sg_pagos_medios_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          pago_id       INTEGER NOT NULL REFERENCES sg_pagos_proveedores(id),
          forma_pago    TEXT NOT NULL DEFAULT 'transferencia',
          cuenta_fin_id INTEGER REFERENCES sg_fin_cuentas(id),
          monto         REAL NOT NULL,
          referencia    TEXT,
          chequera_id   INTEGER,
          nro_cheque    INTEGER,
          cheque_id     INTEGER,
          cheque_ter_id INTEGER,
          creado_en     TEXT DEFAULT (datetime('now','localtime'))
        );
        INSERT INTO sg_pagos_medios_new
          (id, pago_id, forma_pago, cuenta_fin_id, monto, referencia, chequera_id,
           nro_cheque, cheque_id, creado_en)
        SELECT id, pago_id, forma_pago, cuenta_fin_id, monto, referencia, chequera_id,
               nro_cheque, cheque_id, creado_en FROM sg_pagos_medios;
        DROP TABLE sg_pagos_medios;
        ALTER TABLE sg_pagos_medios_new RENAME TO sg_pagos_medios;
        CREATE INDEX IF NOT EXISTS idx_sg_pagos_medios ON sg_pagos_medios(pago_id);
      `);
    })();
    db.pragma(`foreign_keys = ${fkPrev ? 'ON' : 'OFF'}`);
    console.log('[SG] sg_pagos_medios: se puede pagar endosando un cheque de terceros');
  } else {
    try { db.exec('ALTER TABLE sg_pagos_medios ADD COLUMN cheque_ter_id INTEGER'); } catch (_) {}
  }
} catch (e) { console.error('[SG] sg_pagos_medios (endoso):', e.message); }

// ── QUIÉN TOCA CADA CAJA ──────────────────────────────────────────────────
// Una caja de efectivo la maneja una persona, no "la empresa": la de la planta
// la toca el encargado de planta y la de administración, administración. Sin
// esto, cualquiera con acceso a la pantalla podía mover cualquier caja, y
// después no había a quién preguntarle por una diferencia de arqueo.
//
// Sin filas para una cuenta = sin restricción (la abren todos). Es lo que hace
// que agregar la tabla no le saque el acceso a nadie de un día para el otro.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sg_fin_cuenta_usuarios (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cuenta_id   INTEGER NOT NULL REFERENCES sg_fin_cuentas(id),
      usuario_id  INTEGER NOT NULL,
      creado_en   TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sg_fincta_usr ON sg_fin_cuenta_usuarios(cuenta_id, usuario_id);
  `);
} catch (e) { console.error('[SG] sg_fin_cuenta_usuarios:', e.message); }

// ── DE QUIÉN VINO EL CHEQUE ───────────────────────────────────────────────
// Un cheque de tercero llega COBRANDO: se lo dio un cliente. El librador que
// figura en el papel muchas veces no es ese cliente —le pagaron a él con ese
// cheque y él lo endosó—, así que "librador" no alcanza para saber a quién se le
// cobró. Sin este dato, la cartera dice qué hay pero no contra qué cuenta
// corriente entró.
try { db.exec("ALTER TABLE sg_fin_cheques_terceros ADD COLUMN cliente_id INTEGER"); } catch (_) {}
// El CUIT del que firma el cheque: es la clave con la que se le pregunta al BCRA
// si ese librador tiene deudas o cheques rechazados.
try { db.exec("ALTER TABLE sg_fin_cheques_terceros ADD COLUMN cuit_librador TEXT"); } catch (_) {}
// A quién se lo endosamos y con qué pago: sin esto, un cheque que rebota después
// de habérselo dado a un proveedor no sabe a quién volvemos a deberle.
try { db.exec("ALTER TABLE sg_fin_cheques_terceros ADD COLUMN endosado_a INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE sg_fin_cheques_terceros ADD COLUMN pago_id INTEGER"); } catch (_) {}
// El rechazo: cuándo, por qué, y DE DÓNDE volvió — del banco donde se depositó o
// del proveedor al que se le endosó. Son dos asientos distintos.
try { db.exec("ALTER TABLE sg_fin_cheques_terceros ADD COLUMN rechazado_en TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sg_fin_cheques_terceros ADD COLUMN rechazado_por INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE sg_fin_cheques_terceros ADD COLUMN rechazado_motivo TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sg_fin_cheques_terceros ADD COLUMN rechazado_de TEXT"); } catch (_) {}
// Y cuándo se le devolvió al cliente, que es cuando vuelve a ser deuda suya.
try { db.exec("ALTER TABLE sg_fin_cheques_terceros ADD COLUMN devuelto_en TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sg_fin_cheques_terceros ADD COLUMN devuelto_por INTEGER"); } catch (_) {}

// Si la cuenta tiene chequera. Es del banco, no del cheque: hay cuentas
// corrientes sin chequera y cajas de ahorro que nunca la tienen.
try { db.exec("ALTER TABLE sg_fin_cuentas ADD COLUMN tiene_chequera INTEGER NOT NULL DEFAULT 0"); } catch (_) {}

// EL NÚMERO DE CHEQUE NO SE REPITE NUNCA. Dos cheques con el mismo número en la
// misma chequera es un cheque que se paga dos veces, y se descubre en el banco.
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sg_cheque_nro ON sg_fin_cheques_propios(chequera_id, nro_cheque)"); } catch (e) {
  console.error('[SG] cheques propios duplicados, no se pudo crear el índice único:', e.message);
}

// ── EL PAGO AL PROVEEDOR ──────────────────────────────────────────────────
// La tabla se creó "por paridad estructural" con Puente Cordón y quedó sin usar,
// así que le faltan las columnas del circuito real: de qué cuenta salió la
// plata, con qué asiento entró al libro, y quién la anuló.
try { db.exec("ALTER TABLE sg_pagos_proveedores ADD COLUMN cuenta_fin_id INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE sg_pagos_proveedores ADD COLUMN asiento_id INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE sg_pagos_proveedores ADD COLUMN anulado_en TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE sg_pagos_proveedores ADD COLUMN anulado_por INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE sg_pagos_proveedores ADD COLUMN anulado_motivo TEXT"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sg_pagos_prov ON sg_pagos_proveedores(proveedor_id, anulado)"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sg_pagos_compras ON sg_pagos_compras(compra_id)"); } catch (_) {}


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
    // LOS GASTOS DE UNA LIQUIDACIÓN RECIBIDA. Cuando el remito lo documenta una
    // liquidación que nos emite el cliente --el mercado, la cooperativa--, él se
    // descuenta comisión, flete y carga: para nosotros eso es un GASTO, no una
    // retención. Sin esta cuenta el asiento no se puede armar sin mentir.
    ['liq_recibida_gastos',  'Gastos de liquidaciones recibidas (comisión, flete, carga)'],
    // UN CHEQUE EN CARTERA NO ES PLATA EN EL BANCO. Cuando un cliente paga con
    // cheque, el banco no recibió nada: recibís un papel que vale el día que lo
    // depositás. Esa etapa intermedia necesita su propia cuenta —"Valores a
    // depositar", "Cheques en cartera"— y sin ella el cobro con cheque no puede
    // asentarse sin mentir sobre el saldo del banco.
    ['cheques_cartera',      'Cheques de terceros en cartera (valores a depositar)'],
    // UN CHEQUE RECHAZADO TAMPOCO ES PLATA. El banco lo devolvió, o el proveedor
    // al que se lo endosamos nos lo devolvió: ya no está en cartera, todavía no
    // volvió a ser deuda del cliente, y en el medio es un papel que tenemos
    // nosotros. Esa etapa necesita su cuenta, o el rechazo no se puede asentar
    // sin inventar contra qué.
    ['cheques_rechazados',   'Cheques de terceros rechazados (a recuperar del cliente)'],
    // ── LAS TRES DE LA LIQUIDACIÓN ───────────────────────────────
    // Pablo: "tenés que permitirme configurar a qué rubro imputamos las
    // COMISIONES, DESCARGAS, GASTOS ADMINISTRATIVOS, así podemos armar bien el
    // asiento".
    // No son impuestos, pero viven acá por la misma razón que el resto: son UNA
    // cuenta para toda la empresa, se eligen una vez, y el asiento las toma de
    // acá en vez de que cada liquidación invente la suya. Nacen en NULL: hasta
    // que alguien las elija, la liquidación avisa y no se contabiliza.
    ['liq_comision',         'Liquidaciones · Comisión que le cobramos al productor'],
    ['liq_descarga',         'Liquidaciones · Descarga que le cobramos al productor'],
    ['liq_flete',            'Liquidaciones · Flete que le cobramos al productor'],
    ['liq_gastos_admin',     'Liquidaciones · Gastos administrativos que le cobramos'],
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
