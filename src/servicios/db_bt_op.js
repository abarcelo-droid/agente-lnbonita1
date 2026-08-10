// src/servicios/db_bt_op.js
// ── BARCELÓ TRANSPORTE · MODELO OPERATIVO ─────────────────────────────────
// Acá se CARGA y se OPERA. Es el sistema de verdad, el que va a quedar.
//
// NO CONFUNDIR CON EL ESPEJO. Son dos cosas distintas y por eso tienen nombres
// distintos:
//   bt_tr_*  → espejo de Transoft. Solo lectura, se pisa entero en cada
//              sincronización, y muere el día que Transoft deje de usarse.
//   bt_*     → el sistema propio. Acá nace la información y nadie la sobreescribe.
// Si fueran las mismas tablas, la primera sincronización borraría todo lo cargado
// a mano. Por eso están separadas aunque se parezcan.
//
// AISLAMIENTO: prefijo propio y cero foreign keys hacia otras empresas, igual que
// el espejo. Nada de Barceló se mezcla con Puente Cordón ni con San Gerónimo.
//
// CONVIVENCIA CON TRANSOFT: durante un tiempo los dos sistemas van a tener los
// mismos viajes, porque Transoft sigue siendo el oficial y este se usa para probar
// usabilidad y comparar. Por eso cada carga y cada viaje tienen `ref_transoft`:
// el número que le corresponde allá. Sin ese campo, comparar los dos sistemas es
// buscar a ojo, y comparar es justamente para lo que sirve esta etapa.
//
// ══════════════════════════════════════════════════════════════════════════
// QUÉ CAMBIA RESPECTO DE TRANSOFT, Y POR QUÉ
// ══════════════════════════════════════════════════════════════════════════
//   · CLAVE PROPIA. En Transoft todo se identifica por sucursal + número. Acá cada
//     fila tiene su id y el número visible es un dato más. El espejo conserva la
//     clave vieja porque tiene que ser comparable; el sistema propio no: una clave
//     compuesta se arrastra a cada tabla que la referencie y complica todo después.
//   · LOS TRES ACTORES SON RELACIÓN, NO TEXTO. Cliente, remitente y destinatario
//     apuntan al mismo padrón. En Transoft ya es así y está bien.
//   · LOS ESTADOS SON REGLAS, NO TEXTO LIBRE. Las transiciones válidas viven en
//     código (ver bt_op_motor.js). En Transoft el estado es un código suelto y
//     nada impide poner cualquiera.
//   · NADA SE BORRA. Igual que allá, pero con motivo obligatorio y quién lo hizo.
import db from './db.js';
import './db_org.js';
import './db_bt_migra.js';   // los nombres bt_clientes, bt_viajes y bt_cargas los
                             // ocupaba el espejo del #601: hay que liberarlos antes
import { ddl as ddlBt } from './bt_ddl.js';

const ddl = (sql) => ddlBt(sql, 'BT-OP');

// Cola de auditoría de toda tabla operativa. Sin esto, dentro de seis meses
// "¿quién cargó este viaje?" no tiene respuesta.
const AUDITORIA = `
    creado_en        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    creado_por_id    INTEGER,
    actualizado_en   TEXT,
    actualizado_por_id INTEGER,
    anulado_en       TEXT,
    anulado_por_id   INTEGER,
    anulado_motivo   TEXT`;

// ── MAESTROS ──────────────────────────────────────────────────────────────

ddl(`
  -- Padrón único. La misma ficha puede ser cliente, remitente y destinatario de
  -- distintas cargas: en Transoft es una sola tabla usada en los tres roles y está
  -- bien resuelto. Separarlas obligaría a cargar la misma empresa tres veces.
  CREATE TABLE IF NOT EXISTS bt_clientes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo         TEXT,                    -- código interno visible
    ref_transoft   TEXT,                    -- "CC-1234": para cruzar con el espejo
    razon_social   TEXT NOT NULL,
    nombre_corto   TEXT,                    -- lo que se muestra en las listas
    cuit           TEXT,
    condicion_iva  TEXT,
    direccion      TEXT,
    localidad_id   INTEGER,
    telefono       TEXT,
    email          TEXT,
    -- Facturable: hay remitentes y destinatarios a los que nunca se les factura.
    -- Marcarlo evita que el selector de "a quién se le cobra" liste a todos.
    es_facturable  INTEGER NOT NULL DEFAULT 1,
    condicion_pago TEXT,
    notas          TEXT,
    activo         INTEGER NOT NULL DEFAULT 1,
    ${AUDITORIA}
  );
  CREATE INDEX IF NOT EXISTS idx_btc_nombre ON bt_clientes(nombre_corto COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_btc_razon  ON bt_clientes(razon_social COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_btc_ref    ON bt_clientes(ref_transoft);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_btc_cuit
    ON bt_clientes(cuit) WHERE cuit IS NOT NULL AND cuit <> '' AND anulado_en IS NULL;

  CREATE TABLE IF NOT EXISTS bt_localidades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo       TEXT,
    ref_transoft TEXT,
    nombre       TEXT NOT NULL,
    provincia    TEXT,
    zona         TEXT,
    activo       INTEGER NOT NULL DEFAULT 1,
    ${AUDITORIA}
  );
  CREATE INDEX IF NOT EXISTS idx_btl_nombre ON bt_localidades(nombre COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS bt_choferes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo       TEXT,
    ref_transoft TEXT,
    nombre       TEXT NOT NULL,
    documento    TEXT,
    telefono     TEXT,
    -- Propio o de un fletero. Cambia quién cobra el viaje.
    es_propio    INTEGER NOT NULL DEFAULT 1,
    fletero_id   INTEGER,                   -- puntero blando a bt_clientes
    activo       INTEGER NOT NULL DEFAULT 1,
    ${AUDITORIA}
  );

  CREATE TABLE IF NOT EXISTS bt_unidades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo         TEXT NOT NULL DEFAULT 'camion',   -- camion | semi
    codigo       TEXT,
    ref_transoft TEXT,
    patente      TEXT,
    descripcion  TEXT,
    es_propia    INTEGER NOT NULL DEFAULT 1,
    activo       INTEGER NOT NULL DEFAULT 1,
    ${AUDITORIA}
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_btu_patente
    ON bt_unidades(patente COLLATE NOCASE) WHERE patente IS NOT NULL AND patente <> '' AND anulado_en IS NULL;
`);

// ── SUCURSALES Y NUMERACIÓN ───────────────────────────────────────────────
// El número de carga y el de viaje se muestran y se dicen por teléfono, así que
// tienen que ser cortos y por sucursal, como en Transoft. Pero NO son la clave:
// la clave es el id. Así el número puede repetirse entre sucursales sin que nada
// se rompa, que es exactamente lo que pasa allá.

ddl(`
  CREATE TABLE IF NOT EXISTS bt_sucursales (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo   TEXT NOT NULL UNIQUE,          -- CC | BA
    nombre   TEXT NOT NULL,
    activo   INTEGER NOT NULL DEFAULT 1
  );

  -- Un contador por sucursal y tipo. El próximo número se saca en la misma
  -- transacción que el alta: si se sacara antes, dos altas simultáneas se llevarían
  -- el mismo número y nadie se enteraría hasta que alguien busque uno y encuentre dos.
  CREATE TABLE IF NOT EXISTS bt_contadores (
    sucursal_id INTEGER NOT NULL,
    tipo        TEXT    NOT NULL,           -- carga | viaje
    ultimo      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (sucursal_id, tipo)
  );
`);

// ── EL NÚCLEO: CARGA, VIAJE Y EL CRUCE ────────────────────────────────────

ddl(`
  -- El pedido de transporte.
  CREATE TABLE IF NOT EXISTS bt_cargas (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sucursal_id    INTEGER NOT NULL,
    numero         INTEGER NOT NULL,
    ref_transoft   TEXT,                    -- el nº que tiene esta carga en Transoft
    fecha          TEXT NOT NULL DEFAULT (date('now','localtime')),

    -- Los tres actores. Pueden ser la misma ficha o tres distintas.
    cliente_id     INTEGER NOT NULL,        -- quién pide el transporte
    factura_a_id   INTEGER,                 -- a quién se le cobra (por default, el cliente)
    remitente_id   INTEGER,
    destinatario_id INTEGER,

    tipo_carga     TEXT,                    -- MI ME VI PV PQ
    servicio       TEXT,
    m3             REAL,
    kg             REAL,
    bultos         REAL,
    tipo_bulto     TEXT,                    -- CA PA VI

    origen_id      INTEGER,
    destino_id     INTEGER,
    trayecto       TEXT,

    flete          REAL NOT NULL DEFAULT 0,
    valor_declarado REAL,

    estado         TEXT NOT NULL DEFAULT 'pendiente',
    conformidad    TEXT NOT NULL DEFAULT 'P',
    observaciones  TEXT,
    ${AUDITORIA}
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_btca_nro ON bt_cargas(sucursal_id, numero);
  CREATE INDEX IF NOT EXISTS idx_btca_fecha  ON bt_cargas(fecha);
  CREATE INDEX IF NOT EXISTS idx_btca_cli    ON bt_cargas(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_btca_estado ON bt_cargas(estado);

  -- El camión en la ruta.
  CREATE TABLE IF NOT EXISTS bt_viajes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sucursal_id    INTEGER NOT NULL,
    numero         INTEGER NOT NULL,
    ref_transoft   TEXT,
    fecha          TEXT NOT NULL DEFAULT (date('now','localtime')),
    tipo_viaje     TEXT,

    camion_id      INTEGER,
    semi_id        INTEGER,
    semi2_id       INTEGER,
    chofer_id      INTEGER,

    origen_id      INTEGER,
    destino_id     INTEGER,
    trayecto       TEXT,

    km_estimado    REAL,
    km_inicial     REAL,
    km_final       REAL,
    km_real        REAL,
    gasoil_litros  REAL,

    estado         TEXT NOT NULL DEFAULT 'planificado',
    salida_en      TEXT,
    llegada_en     TEXT,
    observaciones  TEXT,
    ${AUDITORIA}
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_btvi_nro ON bt_viajes(sucursal_id, numero);
  CREATE INDEX IF NOT EXISTS idx_btvi_fecha  ON bt_viajes(fecha);
  CREATE INDEX IF NOT EXISTS idx_btvi_estado ON bt_viajes(estado);

  -- EL CRUCE. Una carga puede repartirse en varios viajes y un viaje lleva muchas
  -- cargas. Lo embarcado se guarda; el saldo NO se guarda, se calcula contra la
  -- carga: si se guardaran los dos, el día que no coincidan hay que decidir a cuál
  -- creerle, y esa decisión siempre llega tarde.
  CREATE TABLE IF NOT EXISTS bt_viaje_cargas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    viaje_id     INTEGER NOT NULL,
    carga_id     INTEGER NOT NULL,
    orden        INTEGER NOT NULL DEFAULT 0,
    m3_embarcado     REAL,
    kg_embarcado     REAL,
    bultos_embarcado REAL,
    -- Parcial: esta carga viaja partida y falta una parte en otro viaje. Es un dato
    -- derivable, pero tenerlo explícito permite que el operario lo DECLARE en vez
    -- de que el sistema lo adivine con una resta que puede no cerrar por redondeo.
    es_parcial   INTEGER NOT NULL DEFAULT 0,
    entregado_en TEXT,
    conformidad  TEXT,
    observaciones TEXT,
    ${AUDITORIA}
  );
  CREATE INDEX IF NOT EXISTS idx_btvc_viaje ON bt_viaje_cargas(viaje_id);
  CREATE INDEX IF NOT EXISTS idx_btvc_carga ON bt_viaje_cargas(carga_id);
  -- La misma carga no puede estar dos veces en el MISMO viaje: si viaja partida,
  -- va en viajes distintos. Sin esto, un doble click duplica el embarque.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_btvc_unica
    ON bt_viaje_cargas(viaje_id, carga_id) WHERE anulado_en IS NULL;
`);

// ── LA PLATA: DOS LADOS QUE NO SE MEZCLAN ─────────────────────────────────
// Se cobra por la CARGA, se paga por el VIAJE. Dos tablas separadas, igual que en
// Transoft. Restarlas da la rentabilidad. Meterlas en una sola con un signo
// obligaría a acordarse del signo en cada consulta, y el día que alguien se olvide
// la rentabilidad da cualquier cosa.

ddl(`
  CREATE TABLE IF NOT EXISTS bt_carga_valores (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    carga_id     INTEGER NOT NULL,
    concepto     TEXT NOT NULL,             -- FLETE COMPLETO PALLETS SEGURO FOJA
    descripcion  TEXT,
    factura_a_id INTEGER,
    cantidad     REAL,
    precio       REAL,
    importe      REAL NOT NULL DEFAULT 0,
    iva_pct      REAL,
    -- RESERVADO: el día que se facture desde acá. Hoy la factura la sigue emitiendo
    -- Transoft, así que esto queda vacío y no se usa.
    factura_ref  TEXT,
    ${AUDITORIA}
  );
  CREATE INDEX IF NOT EXISTS idx_btcv_carga ON bt_carga_valores(carga_id);

  CREATE TABLE IF NOT EXISTS bt_viaje_valores (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    viaje_id     INTEGER NOT NULL,
    concepto     TEXT NOT NULL,             -- FLETE GASOIL PEAJES CONVENIO ESTADIA
    descripcion  TEXT,
    proveedor_id INTEGER,                   -- fletero o estación, puntero blando
    cantidad     REAL,
    precio       REAL,
    importe      REAL NOT NULL DEFAULT 0,
    a_liquidar   INTEGER NOT NULL DEFAULT 0,
    ${AUDITORIA}
  );
  CREATE INDEX IF NOT EXISTS idx_btvv_viaje ON bt_viaje_valores(viaje_id);

  -- Los remitos del cliente que acompañan la carga.
  CREATE TABLE IF NOT EXISTS bt_documentos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    carga_id     INTEGER NOT NULL,
    tipo         TEXT NOT NULL DEFAULT 'RE',
    letra        TEXT,
    punto_venta  TEXT,
    numero       TEXT,
    fecha        TEXT,
    descripcion  TEXT,
    ${AUDITORIA}
  );
  CREATE INDEX IF NOT EXISTS idx_btdoc_carga ON bt_documentos(carga_id);
`);

// ── QUIÉN PUEDE QUÉ ───────────────────────────────────────────────────────
// El panel hoy le da acceso total a cualquiera que entre: hay una línea marcada
// como temporal en auth.js que fuerza todas las secciones, y el menú no filtra por
// rol ni por empresa. Arreglar eso es un trabajo aparte y grande.
//
// Mientras tanto, este módulo lleva SU PROPIO permiso. No reemplaza al del panel:
// es una segunda puerta, la única que hoy está cerrada de verdad. Un usuario que no
// esté acá no opera Barceló aunque el menú le muestre el ítem.
//
//   operador   → carga y edita cargas y viajes
//   supervisor → además valoriza (toca la plata) y anula
//   admin      → además administra maestros y permisos

ddl(`
  CREATE TABLE IF NOT EXISTS bt_usuarios (
    usuario_id  INTEGER PRIMARY KEY,        -- puntero blando a usuarios
    rol         TEXT NOT NULL DEFAULT 'operador',
    sucursal_id INTEGER,                    -- si está, solo opera esa sucursal
    activo      INTEGER NOT NULL DEFAULT 1,
    creado_en   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    creado_por_id INTEGER
  );

  -- Historial de cambios. En un sistema donde nada se borra, el log es lo que
  -- contesta "esto antes decía otra cosa, ¿quién lo cambió?".
  CREATE TABLE IF NOT EXISTS bt_op_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entidad     TEXT NOT NULL,              -- carga | viaje | viaje_carga | valor
    entidad_id  INTEGER,
    accion      TEXT NOT NULL,              -- alta | edicion | estado | anulacion
    detalle     TEXT,                       -- JSON con lo que cambió
    usuario_id  INTEGER,
    usuario_nombre TEXT,
    creado_en   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_btlog_ent ON bt_op_log(entidad, entidad_id);
  CREATE INDEX IF NOT EXISTS idx_btlog_fec ON bt_op_log(creado_en);
`);

// ── SIEMBRA MÍNIMA ────────────────────────────────────────────────────────
// Las dos sucursales de Transoft. Sin esto no se puede dar de alta nada, porque
// toda carga y todo viaje necesitan una.

try {
  const n = db.prepare('SELECT COUNT(*) n FROM bt_sucursales').get().n;
  if (!n) {
    const ins = db.prepare('INSERT INTO bt_sucursales (codigo, nombre) VALUES (?,?)');
    db.transaction(() => {
      ins.run('CC', 'Casa Central — San Juan');
      ins.run('BA', 'Buenos Aires');
    })();
    console.log('[BT-OP] Sucursales sembradas: CC y BA');
  }
} catch (e) {
  console.error('[BT-OP] Error sembrando sucursales:', e.message);
}

function addCol(tabla, col, def) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tabla})`).all();
    if (!cols.length || cols.some(c => c.name === col)) return;
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${def}`);
    console.log(`[BT-OP] Columna agregada: ${tabla}.${col}`);
  } catch (e) {
    console.error(`[BT-OP] No se pudo agregar ${tabla}.${col}:`, e.message);
  }
}

try {
  addCol('bt_cargas', 'observaciones', 'TEXT');
} catch (e) {
  console.error('[BT-OP] Error en migraciones:', e.message);
}

console.log('[BT-OP] Modelo operativo inicializado');

export default db;
