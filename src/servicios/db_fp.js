// src/servicios/db_fp.js
// ── MÓDULO PLANIFICACIÓN FINANCIERA (esqueleto) ───────────────────────────
// Proyección semanal de flujo de fondos de San Gerónimo: "con los cheques que
// tengo emitidos, las cuotas de los 15 préstamos y lo que estimo cobrar, ¿en qué
// semana me quedo sin fondos?".
//
// BASE DE DATOS: data/clientes.db — la ÚNICA base física del sistema. Verificado:
// las 6 llamadas a new Database() del repo abren el mismo archivo y db_pa.js
// re-exporta el handle de db.js. No se abre un handle nuevo: quedaría fuera del
// graceful shutdown de index.js y del backup del volume de Railway.
//
// INDEPENDENCIA: universo propio con prefijo fp_ y CERO foreign keys hacia otros
// módulos. Con foreign_keys=ON (db.js:22) y todo en el mismo archivo, una FK de
// fp_* hacia sg_oc o fin_cheques_propios haría FALLAR los DELETE de esos módulos.
// Los punteros al sistema (fp_cheques.ref_id) van como INTEGER sin REFERENCES.
//
// Identificadores estrictamente ASCII (el repo ya se mordió con pa_campañas y con
// la Н cirílica de PA._compraНето).
//
// ══════════════════════════════════════════════════════════════════════════
// DE DÓNDE SALE ESTE MODELO: la planilla "SG SA - Plan Financiero.xlsx"
// ══════════════════════════════════════════════════════════════════════════
// El schema corrige cuatro cosas que en la planilla están mal y que dan números
// falsos hoy. Cada una está anotada en la tabla donde se resuelve.
//
//   1. SALDO ≠ FLUJO. La planilla suma los saldos de banco dentro de "TOTAL
//      INGRESOS" y después acumula esa fila semana a semana, así que el mismo
//      saldo se cuenta de nuevo cada semana. Prueba: Supervielle tiene 457,70
//      repetido cuatro semanas — es un saldo quieto, no un ingreso — y termina
//      aportando 3.425,65. Acá el saldo vive en fp_saldos y entra UNA vez, como
//      punto de partida (ver fp_motor.js).
//   2. EL COLOR ERA UN DATO. Los totales usan SumarSinColor(), una macro que suma
//      solo las celdas sin pintar. O sea que el estado de una cuota estaba en el
//      formato: invisible, no auditable y perdido al copiar. Acá es una columna:
//      fp_prestamo_cuotas.estado. (Interpretación a confirmar con Eliana.)
//   3. TOTALES CON FILAS ESCRITAS A MANO. La fila 42 suma =+N2+N5+N8+... y se
//      olvidó de los tres préstamos cargados después: 750 millones de origen y
//      678 de saldo afuera. Acá no hay totales guardados; se calculan siempre.
//   4. UNA OPERACIÓN = TRES FILAS. En la planilla cada préstamo ocupa tres filas
//      (cuota total / capital / intereses) por 40 columnas de meses, y la fila de
//      cuota total tiene que ser igual a la suma de las otras dos — cosa que nadie
//      controla. Acá capital e interés son dos columnas de la misma cuota, así que
//      la identidad se cumple por construcción.
import db from './db.js';
import './db_org.js';   // garantiza que `sociedades` exista antes de las FK

// ── PRÉSTAMOS ─────────────────────────────────────────────────────────────

db.exec(`
  -- Una fila por OPERACIÓN. Los datos que en la planilla se repetían idénticos en
  -- las tres filas (banco, sistema, condición, fechas) viven acá una sola vez.
  CREATE TABLE IF NOT EXISTS fp_prestamos (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    sociedad_id        INTEGER NOT NULL REFERENCES sociedades(id),
    banco              TEXT    NOT NULL,
    numero             TEXT    NOT NULL,
    -- Texto libre a propósito, NO un CHECK: pa_insumos nació con
    -- CHECK(unidad IN (...)) y sacarlo obligó a recrear la tabla. La lista de
    -- valores válidos vive en el front y en el validador del router, que son
    -- baratos de cambiar. Valores de la hoja "Tabla Referencias":
    --   sistema:    frances | aleman | cuota_unica
    --   tipo_tasa:  fija | variable
    sistema            TEXT,
    tipo_tasa          TEXT,
    -- La planilla guarda la tasa de dos formas incompatibles en la misma columna:
    -- un número (0.41) para las fijas y un texto ("TAMAR + 6p") para las variables.
    -- Se guardan las dos: el texto es lo que se lee, el número lo que se calcula.
    tna_texto          TEXT,
    tna                REAL,
    fecha_inicio       TEXT,
    fecha_fin          TEXT,
    cuotas_totales     INTEGER,
    -- LA BISAGRA DEL MÓDULO. El calendario de préstamos es MENSUAL y el flujo es
    -- SEMANAL; esta columna (1 a 4, "1ª a 4ª semana del mes" en la planilla) es lo
    -- que decide en qué semana cae la cuota. Hoy Pablo hace ese pase a mano.
    semana_debito      INTEGER CHECK (semana_debito BETWEEN 1 AND 4),
    condicion          TEXT,
    monto_origen       REAL    NOT NULL DEFAULT 0,
    -- 'vigente' | 'cancelado'. Un préstamo cancelado no proyecta, pero se conserva.
    estado             TEXT    NOT NULL DEFAULT 'vigente',
    notas              TEXT,
    activo             INTEGER NOT NULL DEFAULT 1,
    creado_en          TEXT DEFAULT (datetime('now','localtime')),
    creado_por_id      INTEGER,
    actualizado_en     TEXT DEFAULT (datetime('now','localtime')),
    actualizado_por_id INTEGER,
    eliminado_en       TEXT,
    eliminado_por_id   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_fp_prest_soc ON fp_prestamos(sociedad_id);
  -- Parcial: un préstamo borrado libera su número para volver a cargarlo.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fp_prest_nro
    ON fp_prestamos(sociedad_id, banco COLLATE NOCASE, numero COLLATE NOCASE)
    WHERE eliminado_en IS NULL;

  -- El calendario. Una fila por cuota, no una columna por mes: agregar el mes 41
  -- a la planilla es agregar una columna a mano en 39 filas y arreglar cada SUM.
  CREATE TABLE IF NOT EXISTS fp_prestamo_cuotas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    prestamo_id   INTEGER NOT NULL REFERENCES fp_prestamos(id) ON DELETE CASCADE,
    nro_cuota     INTEGER NOT NULL,
    periodo       TEXT    NOT NULL,                  -- 'AAAA-MM'
    capital       REAL    NOT NULL DEFAULT 0,
    interes       REAL    NOT NULL DEFAULT 0,
    -- NO se guarda el total: es capital + interes y guardarlo permite que
    -- discrepen, que es exactamente lo que pasa en la planilla.
    --
    -- ESTO REEMPLAZA AL COLOR. 'pendiente' proyecta; 'pagada' no. Es el dato que
    -- en la planilla estaba en el relleno de la celda.
    estado        TEXT    NOT NULL DEFAULT 'pendiente',
    pagada_en     TEXT,
    creado_en     TEXT DEFAULT (datetime('now','localtime')),
    actualizado_en TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_fp_cuo_prest ON fp_prestamo_cuotas(prestamo_id, periodo);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fp_cuo_nro ON fp_prestamo_cuotas(prestamo_id, nro_cuota);
`);

// ── CHEQUES ───────────────────────────────────────────────────────────────

db.exec(`
  -- Se bajan del sistema en un Excel y se suben acá; después se van marcando
  -- pagados. O sea que el mismo cheque puede venir en varias importaciones.
  --
  -- DOS REGLAS QUE HACEN QUE REIMPORTAR NO DUELA:
  --   a) el índice único de abajo hace que un cheque ya cargado se reconozca en
  --      vez de duplicarse;
  --   b) el import NUNCA pisa el estado ni pagado_en (ver fp.js): si ya lo
  --      marcaste pagado acá, que vuelva a aparecer en el Excel no lo revive.
  CREATE TABLE IF NOT EXISTS fp_cheques (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sociedad_id   INTEGER NOT NULL REFERENCES sociedades(id),
    tipo          TEXT    NOT NULL DEFAULT 'emitido',   -- emitido (paga) | recibido (cobra)
    banco         TEXT,
    numero        TEXT    NOT NULL,
    fecha_emision TEXT,
    fecha_pago    TEXT,                                 -- la que importa: define la semana
    monto         REAL    NOT NULL DEFAULT 0,
    beneficiario  TEXT,
    estado        TEXT    NOT NULL DEFAULT 'pendiente', -- pendiente | pagado | anulado
    pagado_en     TEXT,
    notas         TEXT,
    -- Puntero blando al cheque del sistema, para el día que se enganchen.
    -- SIN REFERENCES a propósito (ver encabezado).
    ref_id        INTEGER,
    importado_en  TEXT,
    creado_en          TEXT DEFAULT (datetime('now','localtime')),
    creado_por_id      INTEGER,
    actualizado_en     TEXT DEFAULT (datetime('now','localtime')),
    actualizado_por_id INTEGER,
    eliminado_en       TEXT,
    eliminado_por_id   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_fp_chq_soc  ON fp_cheques(sociedad_id, fecha_pago);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fp_chq_nro
    ON fp_cheques(sociedad_id, tipo, banco COLLATE NOCASE, numero COLLATE NOCASE)
    WHERE eliminado_en IS NULL;
`);

// ── SALDOS DE BANCO ───────────────────────────────────────────────────────

db.exec(`
  -- EL ARREGLO DEL ERROR MÁS CARO DE LA PLANILLA. Un saldo es una foto a una
  -- fecha, no algo que entre todas las semanas. Tabla aparte, y el motor toma el
  -- saldo más reciente anterior al inicio del horizonte, UNA sola vez.
  --
  -- Los saldos negativos son válidos y esperados: en la planilla varias cuentas
  -- están en descubierto (Frances llegó a -96 millones).
  CREATE TABLE IF NOT EXISTS fp_saldos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sociedad_id   INTEGER NOT NULL REFERENCES sociedades(id),
    banco         TEXT    NOT NULL,
    fecha         TEXT    NOT NULL,
    saldo         REAL    NOT NULL DEFAULT 0,
    notas         TEXT,
    creado_en          TEXT DEFAULT (datetime('now','localtime')),
    creado_por_id      INTEGER,
    actualizado_en     TEXT DEFAULT (datetime('now','localtime')),
    actualizado_por_id INTEGER,
    eliminado_en       TEXT,
    eliminado_por_id   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_fp_saldo_soc ON fp_saldos(sociedad_id, banco, fecha);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fp_saldo_uno
    ON fp_saldos(sociedad_id, banco COLLATE NOCASE, fecha)
    WHERE eliminado_en IS NULL;
`);

// ── CONCEPTOS Y CARGA MANUAL ──────────────────────────────────────────────

db.exec(`
  -- Las FILAS del flujo. En la planilla están escritas a mano en la columna A y
  -- por eso agregar una obliga a corregir cada SUM de abajo. Acá son datos.
  --
  -- La columna origen es lo que decide de dónde sale el número de cada semana:
  --   manual     -> de fp_valores, lo carga Pablo
  --   prestamos  -> se calcula de fp_prestamo_cuotas (filtrando por banco)
  --   cheques    -> se calcula de fp_cheques (filtrando por banco)
  -- Una fila calculada no se puede editar a mano: es el fin del pase manual entre
  -- la hoja Prestamos y la hoja Flujo.
  CREATE TABLE IF NOT EXISTS fp_conceptos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sociedad_id   INTEGER NOT NULL REFERENCES sociedades(id),
    nombre        TEXT    NOT NULL,
    naturaleza    TEXT    NOT NULL DEFAULT 'egreso',   -- ingreso | egreso
    origen        TEXT    NOT NULL DEFAULT 'manual',   -- manual | prestamos | cheques
    banco         TEXT,                                -- filtro para origen calculado
    orden         INTEGER NOT NULL DEFAULT 0,
    activo        INTEGER NOT NULL DEFAULT 1,
    creado_en          TEXT DEFAULT (datetime('now','localtime')),
    creado_por_id      INTEGER,
    actualizado_en     TEXT DEFAULT (datetime('now','localtime')),
    actualizado_por_id INTEGER,
    eliminado_en       TEXT,
    eliminado_por_id   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_fp_conc_soc ON fp_conceptos(sociedad_id, orden);

  -- Lo que se carga a mano, celda por celda. La columna semana es el LUNES, en
  -- formato AAAA-MM-DD: una fecha real ordena y compara sola, mientras que
  -- "semana 20" (como en la planilla) no dice de qué año es ni permite ordenar
  -- entre diciembre y enero.
  CREATE TABLE IF NOT EXISTS fp_valores (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    concepto_id   INTEGER NOT NULL REFERENCES fp_conceptos(id) ON DELETE CASCADE,
    semana        TEXT    NOT NULL,
    monto         REAL    NOT NULL DEFAULT 0,
    nota          TEXT,
    creado_en          TEXT DEFAULT (datetime('now','localtime')),
    actualizado_en     TEXT DEFAULT (datetime('now','localtime')),
    actualizado_por_id INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fp_val_celda ON fp_valores(concepto_id, semana);
`);

// ── LOG ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS fp_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    entidad    TEXT,
    entidad_id INTEGER,
    accion     TEXT,
    detalle    TEXT,
    usuario_id INTEGER,
    creado_en  TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_fp_log_ent ON fp_log(entidad, entidad_id);
  CREATE INDEX IF NOT EXISTS idx_fp_log_fec ON fp_log(creado_en);
`);

// ── Migraciones idempotentes ──────────────────────────────────────────────
// No hay tabla de versiones de migración en todo el repo: la idempotencia es
// IF NOT EXISTS + PRAGMA table_info. NUNCA un throw en top-level — tumbaría el
// arranque del server entero.

function addCol(tabla, col, def) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tabla})`).all();
    if (!cols.length) return;                       // la tabla todavía no existe
    if (cols.some(c => c.name === col)) return;
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${def}`);
    console.log(`[FP] Columna agregada: ${tabla}.${col}`);
  } catch (e) {
    console.error(`[FP] No se pudo agregar ${tabla}.${col}:`, e.message);
  }
}

try {
  addCol('fp_prestamos', 'notas', 'TEXT');
  // ── Préstamos financieros: la ficha completa del crédito ────────────────
  // Nombre para mostrar. El banco + número identifica, pero "Préstamo camión
  // Nación" es lo que la persona reconoce en una lista de 15 créditos.
  addCol('fp_prestamos', 'alias', 'TEXT');
  // Cada cuánto vence una cuota. Antes se asumía mensual; con esto la misma
  // ficha sirve para un crédito trimestral o semestral, que son los que más se
  // confunden al proyectar.
  addCol('fp_prestamos', 'periodicidad', "TEXT NOT NULL DEFAULT 'Mensual'");
  // Cuotas pendientes puestas A MANO. Si está en NULL manda el calendario; si
  // tiene un número, ese gana. Existe porque el banco a veces adelanta o difiere
  // cuotas y el calendario teórico deja de coincidir con la realidad.
  addCol('fp_prestamos', 'cuotas_pend_manual', 'INTEGER');
  // La cuota REAL que debita el banco, con impuestos, sellos y percepciones. Si
  // está cargada reemplaza a la cuota estimada en el flujo de fondos, pero NO
  // toca capital ni interés: esos siguen siendo los puros del sistema de
  // amortización, y la diferencia es justamente lo impositivo.
  addCol('fp_prestamos', 'cuota_fin', 'REAL');
} catch (e) {
  console.error('[FP] Error en migraciones:', e.message);
}

console.log('[FP] Schema inicializado');

export default db;
