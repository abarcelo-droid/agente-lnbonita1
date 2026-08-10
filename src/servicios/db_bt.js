// src/servicios/db_bt.js
// ── BARCELÓ TRANSPORTE · ESPEJO DE LECTURA DE TRANSOFT ────────────────────
//
// AISLAMIENTO TOTAL. Pedido explícito del dueño: nada de Barceló Transporte se
// mezcla con Puente Cordón ni con San Gerónimo. Por eso el aislamiento NO se hace
// con una columna sociedad_id sobre tablas compartidas —ahí basta que una consulta
// se olvide el filtro para mezclar los datos, y no se nota hasta que alguien ve un
// número que no es suyo— sino con TABLAS PROPIAS con prefijo bt_. Los datos de las
// otras dos empresas ni siquiera están en las mismas tablas.
//
// Base: data/clientes.db, la única del sistema (ver db_pli.js). Sin foreign keys
// hacia tablas de otros módulos: con foreign_keys=ON, una FK de bt_* hacia afuera
// haría fallar los DELETE de ese otro módulo.
//
// ══════════════════════════════════════════════════════════════════════════
// QUÉ ES ESTO: UN ESPEJO, NO UN SISTEMA
// ══════════════════════════════════════════════════════════════════════════
// La empresa opera hoy en TRANSOFT (K&DAT, Visual FoxPro, tablas .dbf en un
// servidor Windows).
//
// EL ESPEJO NO SE BORRA CUANDO TRANSOFT MUERA: SE CONGELA. Es la copia fiel del
// original, y la historia cerrada se migra desde acá a las tablas operativas (ver
// db_bt_op.js, "EL CONTINUO"). Si en dos años se descubre que una conversión estaba
// mal, se rehace desde este espejo: volver a leer archivos .dbf de un servidor que
// ya no existe no es una opción.
//
// El ERP nuevo LEE de ahí y NUNCA ESCRIBE: mientras Transoft
// sea el sistema de registro tiene que haber UNA sola verdad.
//
// Esa regla acá no es una promesa: es que no existe el camino. El ERP corre en
// Railway y los .dbf están en un Windows al que se entra por escritorio remoto.
// No hay ruta de uno al otro. Los datos llegan porque un agente que corre EN ese
// servidor los lee y los empuja por HTTPS (ver scripts/bt_sync.py).
//
// POR QUÉ EL ESPEJO ES FIEL Y NO "MODERNIZADO"
// Se conservan los nombres de campo y la clave compuesta de Transoft (sucursal +
// número) en vez de pasar a un id autoincremental. Mientras Transoft sea el
// original, cada número del ERP tiene que poder compararse LÍNEA POR LÍNEA contra
// la pantalla vieja; con la clave traducida, cada diferencia obliga a averiguar
// primero de qué fila se está hablando. La modernización de claves corresponde
// cuando el módulo se migre de verdad y Transoft deje de usarse para eso.
//
// CONVENCIONES DE TRANSOFT QUE SE RESPETAN
//   · Clave = filial + número. 'CC' = San Juan (casa central), 'BA' = Buenos Aires.
//   · La plata en FoxPro es tipo Y: entero de 64 bits dividido 10000. El agente ya
//     la convierte a número con decimales; acá entra como REAL.
//   · Las fechas vienen como texto AAAA-MM-DD (el agente convierte el AAAAMMDD).
//   · Nada se borra: hay un campo ANULADO. Se guarda tal cual y se filtra al leer,
//     porque una carga anulada sigue siendo parte de la historia.
//   · Renglones: una carga o un viaje se descomponen en renglones para valorizar
//     y asignar por partes.
import db from './db.js';
import './db_org.js';      // 'sociedades' tiene que existir antes de la FK
import './db_bt_migra.js'; // ANTES de cualquier CREATE: libera los nombres bt_* que
                           // dejó ocupados el espejo del #601 (ver ese archivo)
import { ddl } from './bt_ddl.js';   // db.exec que no puede voltear el servidor

// Toda tabla espejo lleva estas dos columnas. `sincronizado_en` es lo que permite
// contestar "¿de cuándo son estos datos?" — sin eso, un agente caído muestra
// números viejos como si fueran de hoy.
const ESPEJO = `
    sincronizado_en TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    origen_lote     INTEGER`;

// ── NÚCLEO: VIAJE, CARGA Y EL PUENTE ──────────────────────────────────────

ddl(`
  -- El camión saliendo a la ruta.
  CREATE TABLE IF NOT EXISTS bt_tr_viajes (
    filial      TEXT    NOT NULL,          -- CC | BA
    nrovia      INTEGER NOT NULL,
    fecviaje    TEXT,
    tipoviaje   TEXT,
    camion      TEXT,
    semi        TEXT,
    semi2       TEXT,
    chresum     TEXT,                      -- chofer
    choferprop  TEXT,                      -- propio o fletero
    origen      TEXT,
    destino     TEXT,
    trayecto    TEXT,
    kmstd       REAL,
    kmreal      REAL,
    kmini       REAL,
    kmfin       REAL,
    trgasoil    REAL,
    media       REAL,
    rinde       REAL,
    totm3       REAL,
    totkg       REAL,
    totbultos   REAL,
    estado      TEXT,                      -- IN inicio | CI cierre
    cierre      TEXT,
    anulado     INTEGER NOT NULL DEFAULT 0,
    ${ESPEJO},
    PRIMARY KEY (filial, nrovia)
  );
  CREATE INDEX IF NOT EXISTS idx_bt_tr_via_fecha  ON bt_tr_viajes(fecviaje);
  CREATE INDEX IF NOT EXISTS idx_bt_tr_via_estado ON bt_tr_viajes(estado, anulado);

  -- El pedido de transporte.
  CREATE TABLE IF NOT EXISTS bt_tr_cargas (
    filial      TEXT    NOT NULL,
    nrocar      INTEGER NOT NULL,
    fechaing    TEXT,
    clisuc      TEXT, clinro INTEGER,      -- cliente
    afcsuc      TEXT, afcnro INTEGER,      -- a quién se factura
    remsuc      TEXT, remnro INTEGER,      -- remitente
    dessuc      TEXT, desnro INTEGER,      -- destinatario
    tipocarga   TEXT,                      -- MI ME VI PV PQ
    servicio    TEXT,
    m3          REAL,
    kg          REAL,
    bultos      REAL,
    tipobulto   TEXT,                      -- CA PA VI
    origen      TEXT,
    destino     TEXT,
    trayecto    TEXT,
    impflete    REAL,
    valordec    REAL,                      -- valor declarado
    fojasuc     TEXT, fojanro INTEGER,     -- hoja de ruta, opcional
    conforme    TEXT,                      -- P C F O R V S
    cerrada     INTEGER NOT NULL DEFAULT 0,
    estado      TEXT,                      -- TT RL ED NE RD DP DT RT
    coment      TEXT,
    anulado     INTEGER NOT NULL DEFAULT 0,
    ${ESPEJO},
    PRIMARY KEY (filial, nrocar)
  );
  CREATE INDEX IF NOT EXISTS idx_bt_tr_car_fecha  ON bt_tr_cargas(fechaing);
  CREATE INDEX IF NOT EXISTS idx_bt_tr_car_cli    ON bt_tr_cargas(clisuc, clinro);
  CREATE INDEX IF NOT EXISTS idx_bt_tr_car_estado ON bt_tr_cargas(estado, anulado);

  -- EL CORAZÓN DEL MÓDULO: qué carga va en qué viaje y cuánto de cada una.
  -- Una carga puede repartirse en varios viajes y un viaje lleva muchas cargas,
  -- así que la clave necesita el renglón de los dos lados: sin él, una carga
  -- partida en dos tramos del mismo viaje se pisaría a sí misma.
  CREATE TABLE IF NOT EXISTS bt_tr_carga_viaje (
    cargasuc    TEXT    NOT NULL,
    carganro    INTEGER NOT NULL,
    renglon     INTEGER NOT NULL DEFAULT 0,
    viajesuc    TEXT    NOT NULL,
    viajenro    INTEGER NOT NULL,
    rengvia     INTEGER NOT NULL DEFAULT 0,
    tramosuc    TEXT, tramonro INTEGER,
    cantidad    REAL,
    m3embar     REAL, kgembar REAL, bulembar REAL,   -- lo embarcado
    saldom3     REAL, saldokg REAL, saldobul REAL,   -- lo que falta
    estado      TEXT,
    conforme    TEXT,
    ultimo      INTEGER,
    anulado     INTEGER NOT NULL DEFAULT 0,
    ${ESPEJO},
    PRIMARY KEY (cargasuc, carganro, renglon, viajesuc, viajenro, rengvia)
  );
  CREATE INDEX IF NOT EXISTS idx_bt_tr_cv_viaje ON bt_tr_carga_viaje(viajesuc, viajenro);
  CREATE INDEX IF NOT EXISTS idx_bt_tr_cv_carga ON bt_tr_carga_viaje(cargasuc, carganro);
`);

// ── LA PLATA: DOS LADOS QUE NO SE MEZCLAN ─────────────────────────────────
// Se cobra por la CARGA y se paga por el VIAJE. La misma palabra "flete" aparece
// de los dos lados y son cosas distintas; restarlas da la rentabilidad. Van en dos
// tablas separadas, igual que en Transoft: juntarlas en una con un signo obligaría
// a acordarse del signo en cada consulta, y el día que alguien se olvide la
// rentabilidad va a dar cualquier cosa.

ddl(`
  -- Lo que se le COBRA al cliente.
  CREATE TABLE IF NOT EXISTS bt_tr_valor_carga (
    cargasuc    TEXT    NOT NULL,
    carganro    INTEGER NOT NULL,
    renglon     INTEGER NOT NULL DEFAULT 0,
    concepto    TEXT,                      -- FLETE COMPLETO PALLETS SEGURO FOJA
    descrip     TEXT,
    clifcsuc    TEXT, clifcnro INTEGER,    -- cliente a facturar
    precio      REAL,
    importe     REAL,
    coniva      REAL,
    percib      REAL,
    facsuc      TEXT, facnro INTEGER,      -- a qué factura de venta fue
    anulado     INTEGER NOT NULL DEFAULT 0,
    ${ESPEJO},
    PRIMARY KEY (cargasuc, carganro, renglon)
  );
  CREATE INDEX IF NOT EXISTS idx_bt_tr_vc_carga ON bt_tr_valor_carga(cargasuc, carganro);
  CREATE INDEX IF NOT EXISTS idx_bt_tr_vc_fac   ON bt_tr_valor_carga(facsuc, facnro);

  -- Lo que CUESTA el viaje.
  CREATE TABLE IF NOT EXISTS bt_tr_valor_viaje (
    viajesuc    TEXT    NOT NULL,
    viajenro    INTEGER NOT NULL,
    renglon     INTEGER NOT NULL DEFAULT 0,
    concepto    TEXT,                      -- FLETE GASOIL PEAJES CONVENIO ESTADIA
    tarifario   TEXT,
    precio      REAL,
    importe     REAL,
    liquidar    INTEGER,                   -- a liquidar al fletero
    exento      INTEGER,
    ordensuc    TEXT, ordennro INTEGER,    -- orden de gasto
    anulado     INTEGER NOT NULL DEFAULT 0,
    ${ESPEJO},
    PRIMARY KEY (viajesuc, viajenro, renglon)
  );
  CREATE INDEX IF NOT EXISTS idx_bt_tr_vv_viaje ON bt_tr_valor_viaje(viajesuc, viajenro);
`);

// ── ALREDEDOR DEL NÚCLEO ──────────────────────────────────────────────────

ddl(`
  -- Los remitos del cliente por carga.
  CREATE TABLE IF NOT EXISTS bt_tr_documentos (
    cargasuc    TEXT    NOT NULL,
    carganro    INTEGER NOT NULL,
    renglon     INTEGER NOT NULL DEFAULT 0,
    tipodoc     TEXT,                      -- RE remito | FC factura
    letra       TEXT,
    centro      TEXT,
    numero      TEXT,
    fecha       TEXT,
    descrip     TEXT,
    anulado     INTEGER NOT NULL DEFAULT 0,
    ${ESPEJO},
    PRIMARY KEY (cargasuc, carganro, renglon)
  );
  CREATE INDEX IF NOT EXISTS idx_bt_tr_doc_carga ON bt_tr_documentos(cargasuc, carganro);

  -- Órdenes de abastecimiento (gasoil) por viaje.
  CREATE TABLE IF NOT EXISTS bt_tr_ordenes (
    tiporden    TEXT    NOT NULL,          -- OA abastecimiento
    nroorden    INTEGER NOT NULL,
    tipuni      TEXT, unidad TEXT,
    chresum     TEXT,
    viajesuc    TEXT, viajenro INTEGER,
    essuc       TEXT, esficha INTEGER,     -- estación de servicio
    importe     REAL,
    litros      REAL,
    km          REAL,
    remletra    TEXT, remce TEXT, remnro TEXT,
    fecha       TEXT,
    anulado     INTEGER NOT NULL DEFAULT 0,
    ${ESPEJO},
    PRIMARY KEY (tiporden, nroorden)
  );
  CREATE INDEX IF NOT EXISTS idx_bt_tr_ord_viaje ON bt_tr_ordenes(viajesuc, viajenro);

  -- Hoja de ruta de paquetería: agrupa guías.
  CREATE TABLE IF NOT EXISTS bt_tr_fojas (
    fojasuc     TEXT    NOT NULL,
    fojanro     INTEGER NOT NULL,
    fojacamion  TEXT, fojaplaca TEXT,
    fojasemi    TEXT, placasemi TEXT,
    fojachof    TEXT,
    fojadest    TEXT,
    fojaguia    REAL,
    fecha       TEXT,
    anulado     INTEGER NOT NULL DEFAULT 0,
    ${ESPEJO},
    PRIMARY KEY (fojasuc, fojanro)
  );
`);

// ── MAESTROS ──────────────────────────────────────────────────────────────
// Viven en otras carpetas de Transoft pero son parte del mismo espejo. Se copian
// acá y NO se reusan las tablas de proveedores/clientes de los otros módulos:
// son otra empresa y otro padrón.

ddl(`
  CREATE TABLE IF NOT EXISTS bt_tr_clientes (
    codsuc      TEXT    NOT NULL,
    fichanro    INTEGER NOT NULL,
    resum       TEXT,                      -- nombre corto, es lo que se muestra
    razsocc     TEXT,
    cuit        TEXT,
    iva         TEXT,
    zona        TEXT,
    ctacte      TEXT,
    condvta     TEXT,
    -- En clientes.dbf la baja NO es ANULADO (ese campo no existe): es BAJA, y es una
    -- FECHA. Con fecha = cliente dado de baja; vacío = activo.
    baja        TEXT,
    ${ESPEJO},
    PRIMARY KEY (codsuc, fichanro)
  );
  CREATE INDEX IF NOT EXISTS idx_bt_tr_cli_resum ON bt_tr_clientes(resum COLLATE NOCASE);

  -- OJO CON LA CLAVE: el chofer NO se identifica por sucursal+número como casi todo
  -- lo demás. Su clave es CHRESUM, un código corto ("ROMERO CAR"), y así lo
  -- referencian los viajes y las órdenes. Esta tabla decía codsuc+cuenta —campos que
  -- en choferes.dbf no existen—, así que no habría traído ni un chofer.
  -- Tampoco tiene ANULADO: la baja es BAJA, y es una FECHA (con fecha = dado de baja).
  CREATE TABLE IF NOT EXISTS bt_tr_choferes (
    chresum     TEXT    NOT NULL,          -- el código con que lo llaman los viajes
    nombre      TEXT,
    legajo      INTEGER,
    cuit        TEXT,
    documen     TEXT,
    registro    TEXT,                      -- licencia de conducir
    telefono    TEXT,
    choferprop  INTEGER,                   -- propio (1) o de un fletero (0)
    pvcodsuc    TEXT, pvcuenta INTEGER,    -- su cuenta de proveedor: por ahí se le paga
    baja        TEXT,                      -- FECHA de baja; vacío = activo
    ${ESPEJO},
    PRIMARY KEY (chresum)
  );

  CREATE TABLE IF NOT EXISTS bt_tr_unidades (
    tipuni      TEXT    NOT NULL,          -- C camión | S semi
    unidad      TEXT    NOT NULL,
    patente     TEXT,
    descrip     TEXT,
    marca       TEXT,
    anio        INTEGER,
    km          REAL,                      -- odómetro acumulado
    chofer      TEXT,                      -- chofer asignado (-> bt_tr_choferes)
    -- Igual que clientes y choferes: en unpadron.dbf la baja es BAJA (fecha).
    baja        TEXT,
    ${ESPEJO},
    PRIMARY KEY (tipuni, unidad)
  );

  CREATE TABLE IF NOT EXISTS bt_tr_localidades (
    localidad   TEXT PRIMARY KEY,
    descrip     TEXT,
    provin      TEXT,
    centro      TEXT,
    zona        TEXT,
    sucursal    TEXT,
    ${ESPEJO}
  );

  CREATE TABLE IF NOT EXISTS bt_tr_provincias (
    provincia   TEXT PRIMARY KEY,
    descrip     TEXT,
    pais        TEXT,
    ${ESPEJO}
  );
`);

// ── CATÁLOGOS ─────────────────────────────────────────────────────────────
// Las listas fijas del sistema viejo (tipos, estados, conceptos, zonas). Van todas
// en UNA tabla con una columna `catalogo` en vez de una tabla por lista: son ocho
// listas de tres a diez filas cada una, y ocho tablas para eso es ruido. Con esto,
// agregar una lista nueva no toca el schema.

ddl(`
  CREATE TABLE IF NOT EXISTS bt_tr_catalogos (
    catalogo    TEXT NOT NULL,             -- tipo_carga | estado_carga | ...
    codigo      TEXT NOT NULL,
    descrip     TEXT,
    orden       INTEGER NOT NULL DEFAULT 0,
    ${ESPEJO},
    PRIMARY KEY (catalogo, codigo)
  );
`);

// ── LOS CONTADORES DE TRANSOFT (cgfilial) ─────────────────────────────────
// Tabla chica —dos filas— y absolutamente crítica para EL CONTINUO.
//
// Transoft numera las cargas y los viajes con un contador por filial: ULTCARGA y
// ULTVIAJE guardan el ÚLTIMO número entregado. Casa Central va por la carga 20.857
// y el viaje 11.271.
//
// Por qué hay que traerlo y no alcanza con mirar los datos migrados: el contador NO
// es la cantidad de filas. Hay 20.847 cargas pero el contador dice 20.857 — diez
// números que se entregaron y cuya fila ya no está (anuladas, borradas). Si el ERP
// arrancara desde el número más alto que ve, volvería a entregar esos diez, y dos
// cargas distintas terminarían con el mismo número: una vieja en la historia y una
// nueva. Justo lo que el continuo tiene que impedir.
//
// Ver bt_continuo.js, que es quien usa esto para sembrar bt_contadores.

ddl(`
  CREATE TABLE IF NOT EXISTS bt_tr_filiales (
    filial      INTEGER NOT NULL,          -- 1 = Casa Central | 2 = Buenos Aires
    descrip     TEXT,
    sucursal    TEXT,                      -- la letra: CC | BA (el puente 1<->CC)
    ultcarga    INTEGER NOT NULL DEFAULT 0,
    ultviaje    INTEGER NOT NULL DEFAULT 0,
    estviaini   TEXT,                      -- estado inicial del viaje (IN)
    ${ESPEJO},
    PRIMARY KEY (filial)
  );
`);

// ── CONTROL DE SINCRONIZACIÓN ─────────────────────────────────────────────
// Sin esto no hay forma de contestar "¿estos datos son de hoy?", y un agente caído
// muestra números viejos con total naturalidad. Cada corrida deja su rastro:
// cuántas filas trajo, cuánto tardó y si falló.

ddl(`
  CREATE TABLE IF NOT EXISTS bt_tr_sync_lotes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    iniciado_en   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    terminado_en  TEXT,
    origen        TEXT,                    -- qué máquina lo mandó
    estado        TEXT NOT NULL DEFAULT 'en_curso',   -- en_curso | ok | error
    tablas        TEXT,                    -- JSON: {tabla: filas}
    filas_total   INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    usuario_id    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_bt_tr_lote_fecha ON bt_tr_sync_lotes(iniciado_en);
`);

// ── Migraciones idempotentes ──────────────────────────────────────────────
// No hay tabla de versiones en el repo: la idempotencia es IF NOT EXISTS más
// PRAGMA table_info. NUNCA un throw en top-level: tumbaría el arranque entero.

function addCol(tabla, col, def) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tabla})`).all();
    if (!cols.length) return;
    if (cols.some(c => c.name === col)) return;
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${def}`);
    console.log(`[BT] Columna agregada: ${tabla}.${col}`);
  } catch (e) {
    console.error(`[BT] No se pudo agregar ${tabla}.${col}:`, e.message);
  }
}

try {
  // (el módulo nace con este schema)
  addCol('bt_tr_viajes', 'cierre', 'TEXT');
} catch (e) {
  console.error('[BT] Error en migraciones:', e.message);
}

console.log('[BT] Espejo de Transoft inicializado');

export default db;
