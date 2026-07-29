// src/servicios/db_pli.js
// ── MÓDULO PLANIFICACIÓN INSUMOS (beta) ───────────────────────────────────
// Planificación de compra de materiales de empaque por temporada:
// "40.000 cajas de melón → cuánto cartón, etiqueta, viruta y pallet comprar".
//
// BASE DE DATOS: data/clientes.db — la ÚNICA base física del sistema.
// Verificado: hay 6 handles de better-sqlite3 (db.js:12, db2.js:10, catalogo.js:9,
// catalogo_v2.js:10, conversaciones.js:12, rutas/oferta.js:9) y los 6 abren el
// MISMO archivo. db_pa.js re-exporta el handle de db.js (dbPa === getDb()).
// Por eso NO se crea un .db nuevo: un séptimo handle sobre un archivo distinto
// quedaría fuera del graceful shutdown de index.js (que solo cierra el de db.js)
// y fuera del backup de db_pa.js.
//
// INDEPENDENCIA (pedido explícito del usuario): universo propio con prefijo pli_,
// catálogo propio de insumos (NO se toca ni se lee pa_insumos), router propio y
// CERO foreign keys hacia tablas de otros módulos. Con foreign_keys=ON (db.js:22)
// una FK hacia afuera haría fallar DELETEs ajenos con un error de SQLite en inglés.
// El puente futuro a pa_insumos es pli_insumos.insumo_ref_id: puntero blando,
// SIN REFERENCES y sin uso en la beta.
//
// Identificadores estrictamente ASCII (el repo ya se mordió con pa_campañas y
// con la Н cirílica de PA._compraНето).

import db from './db.js';
import './db_org.js';   // garantiza que `sociedades` exista antes de las FK

// ── MAESTROS ──────────────────────────────────────────────────────────────

db.exec(`
  -- Contenedor temporal. Sin esto, el segundo año de planes se mezcla con el
  -- primero y no hay clave para "copiar temporada anterior".
  CREATE TABLE IF NOT EXISTS pli_temporadas (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    sociedad_id        INTEGER NOT NULL REFERENCES sociedades(id),
    nombre             TEXT    NOT NULL,
    fecha_desde        TEXT,
    fecha_hasta        TEXT,
    activa             INTEGER NOT NULL DEFAULT 0,
    tc_ref             REAL    NOT NULL DEFAULT 0,     -- RESERVADO v1: TC para valorizar USD
    notas              TEXT,
    activo             INTEGER NOT NULL DEFAULT 1,
    creado_en          TEXT DEFAULT (datetime('now','localtime')),
    creado_por_id      INTEGER,
    actualizado_en     TEXT DEFAULT (datetime('now','localtime')),
    actualizado_por_id INTEGER,
    eliminado_en       TEXT,
    eliminado_por_id   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pli_temp_soc ON pli_temporadas(sociedad_id);

  -- Catálogo propio de insumos de empaque.
  -- NO reusa pa_insumos: esa tabla tiene CHECK(tipo IN ('fertilizante',
  -- 'agroquimico','semilla','otro')) y en SQLite sacar un CHECK exige recrear
  -- la tabla, lo que arrastraría produccion.js y el circuito contable de facturas.
  --
  -- Las unidades son TEXTO LIBRE a propósito (sin CHECK): pa_insumos nació con
  -- CHECK(unidad IN ('kg','lt','unidad')) y hubo que rebuildear la tabla para
  -- sacarlo. Un enum mal elegido hoy es una migración en 3 meses.
  CREATE TABLE IF NOT EXISTS pli_insumos (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    sociedad_id        INTEGER NOT NULL REFERENCES sociedades(id),
    codigo             TEXT,
    nombre             TEXT    NOT NULL,
    categoria          TEXT,
    -- Tres conceptos de unidad, un factor. Sin esto "8.000.000 gr de viruta"
    -- no es accionable; "445 bolsones" sí.
    unidad_uso         TEXT    NOT NULL,                        -- la de la receta: 'unidad','gr','m'
    unidad_compra      TEXT    NOT NULL,                        -- la que factura el proveedor: 'millar','bolson'
    factor_compra      REAL    NOT NULL DEFAULT 1 CHECK(factor_compra > 0),
    -- Lot sizing
    multiplo_compra    REAL    NOT NULL DEFAULT 1 CHECK(multiplo_compra >= 0),  -- 0 = granel fraccionable
    moq                REAL    NOT NULL DEFAULT 0 CHECK(moq >= 0),
    -- Valorización (el empaque en AR es bimonetario; un precio sin moneda es
    -- ambiguo desde el minuto cero y no hay migración que lo recupere)
    precio_ref         REAL    NOT NULL DEFAULT 0,              -- POR unidad_compra
    moneda             TEXT    NOT NULL DEFAULT 'ARS' CHECK(moneda IN ('ARS','USD')),
    precio_fecha       TEXT,
    proveedor_texto    TEXT,                                    -- texto libre; el export se agrupa por acá
    -- RESERVADO v1 (columna hoy, UI mañana: agregarlas después no migra nada)
    merma_default_pct  REAL    NOT NULL DEFAULT 0 CHECK(merma_default_pct >= 0 AND merma_default_pct < 100),
    lead_time_dias     INTEGER NOT NULL DEFAULT 0,
    modo_provision     TEXT    NOT NULL DEFAULT 'compra'
                               CHECK(modo_provision IN ('compra','alquiler_uso','comodato','provee_cliente')),
    proveedor_ref_id   INTEGER,                                 -- puntero blando a adm_proveedores. SIN REFERENCES.
    insumo_ref_id      INTEGER,                                 -- puntero blando a pa_insumos. SIN REFERENCES.
    notas              TEXT,
    activo             INTEGER NOT NULL DEFAULT 1,
    creado_en          TEXT DEFAULT (datetime('now','localtime')),
    creado_por_id      INTEGER,
    actualizado_en     TEXT DEFAULT (datetime('now','localtime')),
    actualizado_por_id INTEGER,
    eliminado_en       TEXT,
    eliminado_por_id   INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pli_ins_nombre
    ON pli_insumos(sociedad_id, nombre COLLATE NOCASE) WHERE eliminado_en IS NULL;
  CREATE INDEX IF NOT EXISTS idx_pli_ins_cat ON pli_insumos(sociedad_id, categoria);

  -- Árbol de productos: raíz (Melón) + subproductos por % (Caja chica 80%).
  CREATE TABLE IF NOT EXISTS pli_productos (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    sociedad_id        INTEGER NOT NULL REFERENCES sociedades(id),
    temporada_id       INTEGER NOT NULL REFERENCES pli_temporadas(id),
    padre_id           INTEGER REFERENCES pli_productos(id),    -- NULL = raíz
    nombre             TEXT    NOT NULL,
    unidad             TEXT    NOT NULL DEFAULT 'caja',         -- los hijos la HEREDAN del padre
    share_pct          REAL    NOT NULL DEFAULT 100 CHECK(share_pct > 0 AND share_pct <= 100),
    -- modo_reparto vive en el PADRE y define cómo se relacionan TODOS sus hijos
    -- con él. Es el campo que produce números mal SIN lanzar ningún error:
    --   particiona -> de las 40.000, el 80% es caja chica (el padre se reparte)
    --   adicional  -> además de las 40.000 salen 4.000 de descarte (el padre no se reduce)
    modo_reparto       TEXT    NOT NULL DEFAULT 'particiona'
                               CHECK(modo_reparto IN ('particiona','adicional')),
    reproceso_pct      REAL    NOT NULL DEFAULT 0 CHECK(reproceso_pct >= 0 AND reproceso_pct < 100),  -- RESERVADO v1
    receta_version     INTEGER NOT NULL DEFAULT 1,              -- versión VIGENTE de su receta
    orden              INTEGER NOT NULL DEFAULT 0,
    notas              TEXT,
    activo             INTEGER NOT NULL DEFAULT 1,
    creado_en          TEXT DEFAULT (datetime('now','localtime')),
    creado_por_id      INTEGER,
    actualizado_en     TEXT DEFAULT (datetime('now','localtime')),
    actualizado_por_id INTEGER,
    eliminado_en       TEXT,
    eliminado_por_id   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pli_prod_padre ON pli_productos(padre_id);
  CREATE INDEX IF NOT EXISTS idx_pli_prod_temp  ON pli_productos(sociedad_id, temporada_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pli_prod_nombre
    ON pli_productos(sociedad_id, temporada_id, IFNULL(padre_id,0), nombre COLLATE NOCASE)
    WHERE eliminado_en IS NULL;

  -- El BOM. Versionado sin borrar: guardar una receta bumpea receta_version
  -- e inserta filas nuevas, así el historial queda gratis y un plan confirmado
  -- se puede reproducir siempre.
  CREATE TABLE IF NOT EXISTS pli_receta_lineas (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id        INTEGER NOT NULL REFERENCES pli_productos(id),
    version            INTEGER NOT NULL DEFAULT 1,
    insumo_id          INTEGER NOT NULL REFERENCES pli_insumos(id),
    -- EL RATIO VIVE COMO PAR. Jamás se premultiplica a decimal:
    -- "1 pallet cada 60 cajas" se guarda (1, 60), no 0.0166667.
    cantidad           REAL    NOT NULL CHECK(cantidad >= 0),   -- numerador
    por_cada           REAL    NOT NULL DEFAULT 1 CHECK(por_cada > 0),  -- denominador
    modo_ratio         TEXT    NOT NULL DEFAULT 'por_unidad'
                               CHECK(modo_ratio IN ('por_unidad','cada_n')),  -- SOLO presentación
    unidad             TEXT    NOT NULL,                        -- snapshot de pli_insumos.unidad_uso
    -- Rango informativo (el caso "6/8 etiquetas"). El plan calcula SIEMPRE con
    -- la cantidad nominal; min/max solo alimentan la banda que se muestra.
    cant_min           REAL,
    cant_max           REAL,
    merma_pct          REAL    NOT NULL DEFAULT 0 CHECK(merma_pct >= 0 AND merma_pct < 100),
    base               TEXT    NOT NULL DEFAULT 'producto'
                               CHECK(base IN ('producto','pallet','fruta','dia_operativo','camion')),  -- RESERVADO v1
    hereda_a_hijos     INTEGER NOT NULL DEFAULT 0,              -- RESERVADO v1
    orden              INTEGER NOT NULL DEFAULT 0,
    motivo             TEXT,                                    -- distingue 2 líneas del mismo insumo
    notas              TEXT,
    creado_en          TEXT DEFAULT (datetime('now','localtime')),
    creado_por_id      INTEGER
  );
  -- La clave incluye base y motivo para permitir el mismo insumo dos veces
  -- en una receta ("film por caja" + "film por pallet"), que es un caso real.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pli_rl_unica
    ON pli_receta_lineas(producto_id, version, insumo_id, base, IFNULL(motivo,''));
  CREATE INDEX IF NOT EXISTS idx_pli_rl_prod   ON pli_receta_lineas(producto_id, version);
  CREATE INDEX IF NOT EXISTS idx_pli_rl_insumo ON pli_receta_lineas(insumo_id);   -- where-used
`);

// ── PLANES ────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS pli_planes (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    sociedad_id          INTEGER NOT NULL REFERENCES sociedades(id),
    temporada_id         INTEGER NOT NULL REFERENCES pli_temporadas(id),
    nombre               TEXT    NOT NULL,
    fecha_desde          TEXT,
    fecha_hasta          TEXT,
    estado               TEXT    NOT NULL DEFAULT 'borrador'
                                 CHECK(estado IN ('borrador','confirmado','anulado')),
    escenario_de_id      INTEGER REFERENCES pli_planes(id),
    es_oficial           INTEGER NOT NULL DEFAULT 0,            -- RESERVADO v1
    regla_redondeo       TEXT    NOT NULL DEFAULT 'ceil_final', -- persistida: la regla puede cambiar sin invalidar histórico
    tc_snapshot          REAL    NOT NULL DEFAULT 0,            -- RESERVADO v1
    calculado_en         TEXT,
    confirmado_en        TEXT,
    confirmado_por_id    INTEGER,
    -- Única defensa contra "el plan que mandé a comprar cambió solo porque
    -- alguien editó una receta".
    receta_snapshot_json TEXT,
    cobertura_json       TEXT,
    notas                TEXT,
    activo               INTEGER NOT NULL DEFAULT 1,
    creado_en            TEXT DEFAULT (datetime('now','localtime')),
    creado_por_id        INTEGER,
    actualizado_en       TEXT DEFAULT (datetime('now','localtime')),
    actualizado_por_id   INTEGER,
    eliminado_en         TEXT,
    eliminado_por_id     INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pli_plan_temp ON pli_planes(sociedad_id, temporada_id, estado);

  -- El input del usuario: "Melón = 40.000 cajas".
  -- bucket_ini es la clave de agregación temporal. En la beta siempre vale ''
  -- (un solo balde = todo el plan). Cuando se pida el desagregado semanal se
  -- llena con el lunes ISO y NO cambia ni el esquema ni el motor.
  CREATE TABLE IF NOT EXISTS pli_plan_objetivos (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id            INTEGER NOT NULL REFERENCES pli_planes(id),
    producto_id        INTEGER NOT NULL REFERENCES pli_productos(id),
    cantidad           REAL    NOT NULL DEFAULT 0 CHECK(cantidad >= 0),
    unidad             TEXT    NOT NULL,
    bucket_ini         TEXT    NOT NULL DEFAULT '',
    notas              TEXT,
    creado_en          TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pli_obj_unico
    ON pli_plan_objetivos(plan_id, producto_id, bucket_ini);

  -- Remanente declarado (bruta -> neta). Sin esto el total está inflado por
  -- diseño, el usuario lo corrige a mano en el Excel y el módulo deja de ser
  -- fuente de verdad en la primera revisión.
  CREATE TABLE IF NOT EXISTS pli_plan_existencias (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id            INTEGER NOT NULL REFERENCES pli_planes(id),
    insumo_id          INTEGER NOT NULL REFERENCES pli_insumos(id),
    bucket_ini         TEXT    NOT NULL DEFAULT '',
    cantidad           REAL    NOT NULL DEFAULT 0 CHECK(cantidad >= 0),  -- en UNIDAD DE USO
    origen             TEXT    NOT NULL DEFAULT 'manual'
                               CHECK(origen IN ('manual','stock_sistema')),  -- stock_sistema = RESERVADO v1
    notas              TEXT,
    actualizado_en     TEXT DEFAULT (datetime('now','localtime')),
    actualizado_por_id INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pli_exist_unico
    ON pli_plan_existencias(plan_id, insumo_id, bucket_ini);

  -- Snapshot materializado al confirmar. Guarda las magnitudes por SEPARADO
  -- aunque en la beta algunas coincidan: sin eso, en 6 meses nadie puede decir
  -- si un número histórico incluía merma o existencia.
  CREATE TABLE IF NOT EXISTS pli_plan_resultado (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id              INTEGER NOT NULL REFERENCES pli_planes(id),
    insumo_id            INTEGER NOT NULL REFERENCES pli_insumos(id),
    bucket_ini           TEXT    NOT NULL DEFAULT '',
    -- snapshots del maestro (el resultado sigue siendo legible aunque el insumo cambie)
    insumo_nombre        TEXT    NOT NULL,
    categoria            TEXT,
    proveedor_texto      TEXT,
    unidad_uso           TEXT    NOT NULL,
    unidad_compra        TEXT    NOT NULL,
    factor_compra        REAL    NOT NULL,
    multiplo_compra      REAL    NOT NULL,
    moq                  REAL    NOT NULL,
    -- magnitudes
    cant_bruta_uso       REAL    NOT NULL,        -- explosión + merma, SIN redondear
    cant_min_uso         REAL,                    -- banda inferior (neteada, igual que la nominal)
    cant_max_uso         REAL,
    existencia           REAL    NOT NULL DEFAULT 0,
    existencia_declarada REAL    NOT NULL DEFAULT 0,  -- lo que tipeó el usuario, aunque el clamp lo recorte
    cant_neta_uso        REAL    NOT NULL,        -- max(0, bruta - existencia)
    bultos_teoricos      REAL    NOT NULL,        -- neta / factor_compra, SIN redondear
    bultos_a_comprar     REAL    NOT NULL,        -- tras múltiplo + MOQ
    exceso_multiplo      REAL    NOT NULL DEFAULT 0,  -- en unidad de COMPRA
    exceso_moq           REAL    NOT NULL DEFAULT 0,  -- en unidad de COMPRA
    exceso_uso           REAL    NOT NULL DEFAULT 0,  -- exceso total en unidad de USO
    moq_forzado          INTEGER NOT NULL DEFAULT 0,
    -- costo
    precio_unit_snapshot REAL    NOT NULL DEFAULT 0,
    moneda_snapshot      TEXT    NOT NULL DEFAULT 'ARS',
    precio_fecha_snapshot TEXT,
    costo_estimado       REAL    NOT NULL DEFAULT 0,
    sin_precio           INTEGER NOT NULL DEFAULT 0,
    detalle_json         TEXT,                    -- desglose por producto
    creado_en            TEXT DEFAULT (datetime('now','localtime'))
  );
  -- Este UNIQUE ES la definición de la clave de agregación de insumos
  -- compartidos: si un bug inserta dos veces, falla ruidosamente en vez de
  -- duplicar en silencio.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pli_res_unico
    ON pli_plan_resultado(plan_id, insumo_id, bucket_ini);
  CREATE INDEX IF NOT EXISTS idx_pli_res_plan ON pli_plan_resultado(plan_id);

  -- Auditoría (molde pa_cuentas_log). El historial no se puede reconstruir
  -- retroactivamente: escribirlo es de la beta, la pantalla que lo muestra no.
  CREATE TABLE IF NOT EXISTS pli_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entidad     TEXT    NOT NULL,
    entidad_id  INTEGER,
    accion      TEXT    NOT NULL,
    detalle     TEXT,
    usuario_id  INTEGER,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_pli_log_ent   ON pli_log(entidad, entidad_id);
  CREATE INDEX IF NOT EXISTS idx_pli_log_fecha ON pli_log(creado_en);
`);

// ── MIGRACIONES IDEMPOTENTES ──────────────────────────────────────────────
// No hay tabla de versiones de migración en el repo: la idempotencia se logra
// con IF NOT EXISTS + PRAGMA table_info (molde db_pa.js).
// Nunca `throw` en el top-level: tumbaría el arranque de TODO el server.

function addCol(tabla, col, def) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name);
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${def}`);
      console.log(`[PLI] Columna ${col} agregada en ${tabla}`);
      return true;
    }
  } catch (e) {
    console.error(`[PLI] Error agregando ${col} en ${tabla}:`, e.message);
  }
  return false;
}

// Columnas sumadas después del CREATE original (para instalaciones ya migradas).
try {
  addCol('pli_insumos',        'proveedor_texto',       'TEXT');
  addCol('pli_receta_lineas',  'motivo',                'TEXT');
  addCol('pli_plan_resultado', 'proveedor_texto',       'TEXT');
  addCol('pli_plan_resultado', 'existencia_declarada',  'REAL NOT NULL DEFAULT 0');
  addCol('pli_plan_resultado', 'exceso_multiplo',       'REAL NOT NULL DEFAULT 0');
  addCol('pli_plan_resultado', 'exceso_moq',            'REAL NOT NULL DEFAULT 0');
  addCol('pli_plan_resultado', 'exceso_uso',            'REAL NOT NULL DEFAULT 0');
  addCol('pli_plan_resultado', 'moq_forzado',           'INTEGER NOT NULL DEFAULT 0');
  addCol('pli_plan_resultado', 'precio_fecha_snapshot', 'TEXT');
  addCol('pli_plan_resultado', 'sin_precio',            'INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  console.error('[PLI] Error en migraciones:', e.message);
}

// ── SEED ──────────────────────────────────────────────────────────────────
// Una temporada activa para que el módulo no arranque vacío (molde db_org.js).

try {
  const n = db.prepare('SELECT COUNT(*) AS n FROM pli_temporadas').get().n;
  if (n === 0) {
    const soc = db.prepare("SELECT id FROM sociedades WHERE nombre = 'Puente Cordón SA'").get()
             || db.prepare("SELECT id FROM sociedades WHERE funcion = 'productiva' ORDER BY id LIMIT 1").get()
             || db.prepare('SELECT id FROM sociedades ORDER BY id LIMIT 1').get();
    if (soc) {
      const anio = new Date().getFullYear();
      db.prepare(`
        INSERT INTO pli_temporadas (sociedad_id, nombre, activa, notas)
        VALUES (?, ?, 1, 'Creada automáticamente al instalar el módulo')
      `).run(soc.id, `Temporada ${anio}/${String(anio + 1).slice(2)}`);
      console.log('[PLI] Seed: temporada inicial creada');
    }
  }
} catch (e) {
  console.error('[PLI] Error en seed de temporada:', e.message);
}

console.log('[PLI] Schema inicializado');

export default db;
