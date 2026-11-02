// src/servicios/db_galpon.js
// ── 🏭 GALPÓN — lo que pasa entre el árbol y el pallet ───────────────────────────────
// Puente Cordón cosecha, vuelca en el galpón, selecciona, embala y despacha. Hasta hoy el
// sistema no guardaba NADA de eso: `pa_costos_lote` y `pa_costos_campaña` tienen la plata de
// la mano de obra, pero **ningún lado tiene los kilos**. Este módulo es el primero que los
// registra.
//
// ── OJO CON EL NOMBRE ────────────────────────────────────────────────────────────────
// "Galpón" ya significa otra cosa en este repo: en IFCO, un galpón es un PROVEEDOR que
// guarda cajones (una fila de `proveedores`, ver rutas/ifco.js). Esto es otra cosa: el
// galpón de empaque de Puente Cordón. Por eso el prefijo `gal_` y las claves `galpon-*`,
// que no chocan con nada de `ifco_`.
//
// ── DE QUÉ NOS COLGAMOS, Y DE QUÉ NO ────────────────────────────────────────────────
// Las cuadrillas YA EXISTEN: `pa_cuadrillas` (db_pa.js), con su responsable de cobro y su
// tarifa por jornal. Acá NO se redefinen ni se les agregan columnas — lo que el galpón
// necesita (un color y un rango de tarjetas) vive en una tabla satélite propia.
//
// Agregarle columnas a la tabla de Personal sería más corto y es la trampa: esa tabla la
// mantiene otro módulo, y una columna de galpón ahí la hace suya para siempre.
//
// Y SIN FOREIGN KEYS hacia `pa_*`. Con `foreign_keys=ON` (db.js:22) una FK desde acá haría
// fallar los DELETE de Personal. Regla de CLAUDE.md: JOINs de lectura sí, FKs cruzadas no.
import db from "./db.js";

db.exec(`
  -- ═══════════════════════════════════════════════════════════════════════════
  -- LA CONFIGURACIÓN
  -- ═══════════════════════════════════════════════════════════════════════════
  -- Clave/valor en vez de una tabla de una fila con quince columnas: cada cosa que se
  -- parametriza (la tara del IFCO, el objetivo de kg/h, el puerto de la balanza) aparece
  -- en momentos distintos, y una tabla ancha obliga a un ALTER por cada una.
  CREATE TABLE IF NOT EXISTS gal_config (
    clave       TEXT PRIMARY KEY,
    valor       TEXT,
    actualizado TEXT DEFAULT (datetime('now','localtime'))
  );

  -- ═══════════════════════════════════════════════════════════════════════════
  -- LAS TARJETAS DE CADA CUADRILLA
  -- ═══════════════════════════════════════════════════════════════════════════
  -- En el campo no hay tecnología. Cada cuadrilla tiene tarjetas QR REUTILIZABLES de su
  -- color, con un rango de IDs propio; el cuadrillero engancha una en cada IFCO que llena,
  -- y las tarjetas vuelven al campo después del volcado.
  --
  -- O sea: la tarjeta no identifica al IFCO ni a la persona. Identifica a la CUADRILLA, y
  -- el rango es lo que lo hace posible sin imprimir una tarjeta por cosechada.
  --
  -- Satélite de pa_cuadrillas (sin FK, ver el encabezado). Varias filas por cuadrilla:
  -- un rango puede ampliarse a mitad de temporada sin tocar el anterior.
  CREATE TABLE IF NOT EXISTS gal_cuadrilla_tarjetas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    cuadrilla_id INTEGER NOT NULL,          -- → pa_cuadrillas(id), FK lógica
    desde_id     INTEGER NOT NULL,
    hasta_id     INTEGER NOT NULL,
    -- El color es lo que hace que el cuadrillero agarre la tarjeta correcta sin leer nada.
    -- Hex, para que la franja del PDF y la pantalla usen exactamente el mismo.
    color        TEXT NOT NULL DEFAULT '#1a3a5c',
    activo       INTEGER NOT NULL DEFAULT 1,
    notas        TEXT,
    creado_en    TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS gal_tarjetas_cuad_idx  ON gal_cuadrilla_tarjetas(cuadrilla_id);
  CREATE INDEX IF NOT EXISTS gal_tarjetas_rango_idx ON gal_cuadrilla_tarjetas(desde_id, hasta_id);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- QUÉ LOTE SE ESTÁ COSECHANDO, Y DESDE QUÉ HORA
  -- ═══════════════════════════════════════════════════════════════════════════
  -- Esto NO existía en ningún lado. Lo más cerca que había era pa_asistencias.fecha, que
  -- es por DÍA y además registra quién trabajó, no qué se cosechó.
  --
  -- Hace falta la HORA porque el lote cambia a mitad de la mañana y el IFCO que se vuelca
  -- a las 14:30 es del lote que estaba vigente a las 14:30, no del que se cargó a la
  -- mañana. Se resuelve igual que una tarifa con vigencia (pa_tarifas_persona):
  --
  --   WHERE fecha = ? AND desde_hora <= ? ORDER BY desde_hora DESC LIMIT 1
  --
  -- Una sola fila por día = "el lote del día" y listo. Varias = los cambios, con su hora.
  CREATE TABLE IF NOT EXISTS gal_lote_vigente (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha       TEXT NOT NULL,              -- YYYY-MM-DD
    desde_hora  TEXT NOT NULL DEFAULT '00:00',
    lote_id     INTEGER NOT NULL,           -- → pa_lotes(id), FK lógica
    -- Denormalizados a propósito: el nombre del lote y el producto se muestran en cada
    -- volcado y en la etiqueta del pallet. Mismo criterio que sg_productos, que guarda
    -- familia y variedad al lado del código.
    lote_nombre TEXT,
    producto    TEXT,
    usuario_id  INTEGER,
    usuario     TEXT,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS gal_lote_vig_idx ON gal_lote_vigente(fecha, desde_hora);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- LOS KILOS QUE ENTRARON AL GALPÓN
  -- ═══════════════════════════════════════════════════════════════════════════
  -- Es el libro de la cosecha: la única tabla del sistema que guarda volumen. Todo lo
  -- demás del galpón —el rendimiento, el kg/jornal, el costo por kilo— sale de acá.
  --
  -- ── UNA SOLA TABLA PARA LAS DOS MANERAS DE CARGAR ──────────────────────────────
  -- Hoy se carga A MANO: el operador elige fecha, lote, cuadrilla, producto y escribe
  -- los kilos. Cuando lleguen la impresora y la balanza, el escaneo va a escribir en
  -- ESTA MISMA TABLA — lo que cambia es quién llena los campos, no qué se guarda.
  --
  -- La alternativa era una tabla «provisoria» y otra «de verdad» después. Eso significa
  -- migrar los kilos de media temporada, y que el tablero y los informes tengan que
  -- sumar dos lados. El libro es uno.
  --
  -- Por eso están desde el día uno las columnas que la carga manual no usa (hora,
  -- tarjeta_id, bruto, tara, origen): agregarlas ahora es gratis y agregarlas
  -- después es un ALTER sobre datos que ya se están usando para pagar jornales.
  CREATE TABLE IF NOT EXISTS gal_volcados (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Lo genera el cliente. Hoy no hace falta, pero la cola offline del PR que viene
    -- reintenta, y sin esto un reintento duplica kilos. Un INSERT OR IGNORE sobre el
    -- índice único de abajo lo convierte en una sola fila.
    uuid         TEXT UNIQUE,

    -- ── CUÁNDO ───────────────────────────────────────────────────────────────────
    -- La fecha de COSECHA, que la elige el operador: lo del sábado se carga el lunes y
    -- tiene que quedar contado el sábado. Es distinta de creado_en, que es cuándo se
    -- tipeó, y la diferencia es justamente lo que permite cargar atrasado.
    fecha        TEXT NOT NULL,              -- YYYY-MM-DD
    -- NULL en la carga manual, y es a propósito: el que tipea el lote no necesita decir
    -- a qué hora entró. La llena el escaneo, que SÍ la necesita porque de la hora saca
    -- el lote (gal_lote_vigente).
    hora         TEXT,

    -- ── QUÉ Y DE QUIÉN ───────────────────────────────────────────────────────────
    -- CONGELADOS, no resueltos al leer. Los rangos de tarjetas se reasignan entre
    -- temporadas y el lote vigente cambia durante el día: recalcular después
    -- reescribiría la historia. Mismo criterio que el total de un comprobante.
    lote_id      INTEGER NOT NULL,           -- → pa_lotes(id), FK lógica
    lote_nombre  TEXT,
    producto     TEXT,
    cuadrilla_id INTEGER,                    -- → pa_cuadrillas(id), FK lógica
    cuadrilla    TEXT,

    -- ── CUÁNTO ───────────────────────────────────────────────────────────────────
    -- kilos es el número que vale y el único obligatorio. En la carga manual se
    -- escribe directo; con balanza sale de bruto − tara × ifcos, y los tres quedan
    -- guardados para poder rehacer la cuenta.
    kilos        REAL NOT NULL,
    ifcos        INTEGER,
    bruto        REAL,
    tara         REAL,
    tarjeta_id   INTEGER,
    -- De dónde salió el peso: 'manual' lo tipeó una persona, 'balanza' lo leyó el
    -- indicador. El tablero muestra cuánto se pesó a mano, que es la señal de que el
    -- equipo no está andando — sin esta columna eso no se puede ni preguntar.
    origen       TEXT NOT NULL DEFAULT 'manual',

    observacion  TEXT,
    -- NADA SE RECHAZA DESPUÉS DEL HECHO: LA FRUTA YA ESTÁ EN LA TOLVA. Un problema no
    -- bloquea la carga, la marca. Ver el encabezado del módulo en CLAUDE.md.
    estado       TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'a_revisar'
    revision_motivo TEXT,

    usuario_id   INTEGER,
    usuario      TEXT,
    creado_en    TEXT DEFAULT (datetime('now','localtime')),
    -- Soft delete, como en las otras 39 tablas del repo. Un renglón de kilos borrado
    -- de verdad es un jornal que no se puede auditar.
    eliminado_en TEXT
  );
  -- Por fecha es como se lee SIEMPRE: la pantalla del día, el tablero, el informe.
  CREATE INDEX IF NOT EXISTS gal_volc_fecha_idx ON gal_volcados(fecha);
  CREATE INDEX IF NOT EXISTS gal_volc_lote_idx  ON gal_volcados(lote_id, fecha);
  CREATE INDEX IF NOT EXISTS gal_volc_cuad_idx  ON gal_volcados(cuadrilla_id, fecha);
  -- ═══════════════════════════════════════════════════════════════════════════
  -- LO QUE EL TARJETÓN NECESITA DE CADA LOTE
  -- ═══════════════════════════════════════════════════════════════════════════
  -- Andy, 1/11/2026: «RENSPA los voy a cargar en los lotes» y «variedad del damasco es
  -- siempre Castle Brite».
  --
  -- Tabla SATÉLITE de pa_lotes, igual que gal_cuadrilla_tarjetas lo es de
  -- pa_cuadrillas. Agregarle columnas a la tabla de Producción sería más corto y es la
  -- trampa: esa tabla la mantiene otro módulo, y una columna del galpón ahí la hace
  -- nuestra para siempre. Sin FK, por la regla de CLAUDE.md.
  --
  -- El RENSPA es un dato SANITARIO y va impreso en el tarjetón: lo que se imprimió es
  -- lo que viajó. Por eso se congela en cada carga además de vivir acá.
  CREATE TABLE IF NOT EXISTS gal_lote_datos (
    lote_id   INTEGER PRIMARY KEY,        -- → pa_lotes(id), FK lógica
    renspa    TEXT,
    variedad  TEXT,
    -- El cuartel: la subdivisión de adentro del lote que va en la etiqueta. En el
    -- tarjetón de referencia es «C-07».
    cuartel   TEXT,
    notas     TEXT,
    actualizado TEXT DEFAULT (datetime('now','localtime'))
  );

  -- ═══════════════════════════════════════════════════════════════════════════
  -- EN QUÉ SALE LA FRUTA DEL GALPÓN
  -- ═══════════════════════════════════════════════════════════════════════════
  -- Andy, 31/10/2026: «por ejemplo 100 cajas cartón x 10 cubetas de 700 gramos cada una».
  --
  -- Esa frase es una CUENTA, y es siempre la misma: bultos x unidades_por_bulto x peso de
  -- cada unidad. Guardarla como catálogo es lo que convierte la carga en apretar una
  -- baldosa y escribir 100 — en vez de tipear tres números y multiplicarlos a mano, que
  -- es donde entra el error que nadie ve.
  --
  -- El peso va SIEMPRE en kilos acá adentro. La pantalla lo pide en gramos o en kilos y
  -- convierte: «700» pensando en gramos y guardado como kilos son 700.000 kg en una
  -- jornada, y el número es tan grande que parece un error de sistema y no de carga.
  CREATE TABLE IF NOT EXISTS gal_presentaciones (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre    TEXT NOT NULL,                   -- 'Caja cartón 10 x 700 g'
    destino   TEXT NOT NULL,                   -- comercial | verde | descarte
    envase    TEXT,                            -- 'Caja cartón', 'Bin'
    por_bulto REAL NOT NULL DEFAULT 1,         -- 10 cubetas por caja
    kg_unidad REAL NOT NULL DEFAULT 1,         -- 0.7 kg cada cubeta
    -- A granel no hay cuenta: se tipean los kilos. Es lo que pasa con un bin de verde o
    -- de descarte, que se pesa entero y no tiene unidades adentro.
    granel    INTEGER NOT NULL DEFAULT 0,
    -- EL ARTÍCULO. Andy, 1/11/2026: «los calibres en damasco los definimos en el
    -- artículo que hacemos del proceso». O sea que lo que se produce no es «una caja»:
    -- es una caja DE TAL CATEGORÍA Y TAL CALIBRE, y eso es lo que va en cada renglón
    -- del tarjetón. Dos calibres del mismo envase son dos artículos distintos y se
    -- cargan por separado.
    --
    -- La categoría arranca en I porque «siempre CAT 1 a menos que modifiquemos».
    categoria TEXT NOT NULL DEFAULT 'I',
    calibre   TEXT,
    color     TEXT,
    orden     INTEGER NOT NULL DEFAULT 100,
    activo    INTEGER NOT NULL DEFAULT 1,
    creado_en TEXT DEFAULT (datetime('now','localtime')),
    eliminado_en TEXT
  );
  CREATE INDEX IF NOT EXISTS gal_pres_dest_idx ON gal_presentaciones(destino, orden);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- EL PROCESO: QUÉ SALIÓ DE LO QUE ENTRÓ
  -- ═══════════════════════════════════════════════════════════════════════════
  -- gal_volcados tiene lo que ENTRÓ al galpón. Esta tabla tiene lo que SALIÓ, y las dos
  -- juntas son el rinde — que es la pregunta que se le hace a una finca.
  --
  -- ── EL LOTE ES UNA DECLARACIÓN, NO UNA TRAZA ────────────────────────────────
  -- Los IFCOs se vuelcan a una tolva y ahí la fruta se mezcla: no existe forma física de
  -- decir que ESTA caja salió de AQUEL IFCO. El operador elige el lote, y eso es lo que
  -- se guarda: una atribución declarada. Por eso el rinde puede dar más de 100% — y
  -- cuando da, la pantalla lo muestra en vez de taparlo, porque es la señal de que la
  -- atribución se corrió.
  --
  -- ── TRES DESTINOS, NO TEXTO LIBRE ───────────────────────────────────────────
  -- comercial / verde / descarte. No son etiquetas: cada uno tiene un futuro distinto —
  -- lo comercial se vende, lo verde vuelve a la tolva más adelante, el descarte se remata
  -- o se tira. Texto libre serían cuarenta maneras de escribir «segunda» y ningún informe
  -- posible, que es la misma razón por la que servicios/asientos.js tiene MOTIVOS.
  --
  -- ── tipo DESDE EL DÍA UNO ─────────────────────────────────────────────────
  -- Hoy sólo se escriben ingresos. Pero lo verde se reprocesa y el descarte se remata:
  -- las salidas son parte del negocio, no una idea. La columna cuesta una línea ahora y
  -- una migración de media temporada después.
  CREATE TABLE IF NOT EXISTS gal_procesos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid            TEXT UNIQUE,
    fecha           TEXT NOT NULL,             -- YYYY-MM-DD, día de PROCESO
    lote_id         INTEGER NOT NULL,          -- declarado, ver arriba
    lote_nombre     TEXT,
    producto        TEXT,
    destino         TEXT NOT NULL,
    presentacion_id INTEGER,
    presentacion    TEXT,                      -- congelado: el catálogo se edita
    envase          TEXT,
    -- Lo que se IMPRIME en el tarjetón, congelado al cargar. Un RENSPA corregido el
    -- mes que viene no cambia lo que decía la etiqueta que se fue en el camión.
    categoria       TEXT,
    calibre         TEXT,
    variedad        TEXT,
    renspa          TEXT,
    cuartel         TEXT,
    bultos          REAL,
    por_bulto       REAL,
    kg_unidad       REAL,
    -- LO CALCULA EL SERVIDOR con los tres de arriba. Nunca lo que mandó el cliente: el
    -- rinde de la temporada es exactamente esta columna.
    kilos           REAL NOT NULL,
    tipo            TEXT NOT NULL DEFAULT 'ingreso',
    -- Una carga repartida entre varios lotes: ver el comentario del ALTER más abajo.
    reparto         TEXT,
    repartido       INTEGER NOT NULL DEFAULT 0,
    pallet_id       INTEGER,                   -- → gal_pallets(id)

    observacion     TEXT,
    estado          TEXT NOT NULL DEFAULT 'ok',
    revision_motivo TEXT,
    usuario_id      INTEGER,
    usuario         TEXT,
    creado_en       TEXT DEFAULT (datetime('now','localtime')),
    eliminado_en    TEXT
  );
  -- ═══════════════════════════════════════════════════════════════════════════
  -- EL PALLET
  -- ═══════════════════════════════════════════════════════════════════════════
  -- Andy, 1/11/2026: «la parte donde cargamos el proceso tiene que ser algo más
  -- parecido a "Cierre de Pallet", de ahí quiero que salga un tarjetón para imprimir».
  --
  -- El pallet no reemplaza la carga de proceso: la ENVUELVE. Se sigue cargando caja
  -- por caja contra el pallet abierto, y cerrarlo es lo que le pone número y emite la
  -- etiqueta. Hacerlo al revés —cargar el pallet entero de una— obligaría a tener
  -- todos los datos juntos justo cuando no se los tiene, que es lo que CLAUDE.md
  -- dice de los formularios largos.
  --
  -- ── EL NÚMERO SE PONE AL CERRAR, NO AL ABRIR ──────────────────────────────
  -- Un pallet abierto que ya tiene número es un número que se saltea cada vez que
  -- alguien abre uno y se arrepiente. El correlativo tiene que ser correlativo: es lo
  -- que se cita en un remito y lo que se busca cuando un cliente reclama.
  CREATE TABLE IF NOT EXISTS gal_pallets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    numero        TEXT UNIQUE,              -- PC-26-01234, recién al cerrar
    estado        TEXT NOT NULL DEFAULT 'abierto',   -- abierto | cerrado
    -- PARCIAL lo marca el operador: el pallet se cierra sin completarse porque se
    -- terminó la fruta o porque se va el camión. Va impreso, porque quien lo recibe
    -- tiene que saber que no vienen las cajas que esperaba.
    parcial       INTEGER NOT NULL DEFAULT 0,
    -- MIXTO se calcula al cerrar, no lo elige nadie: es si adentro hay más de un
    -- artículo. Dejarlo a criterio del que cierra es una etiqueta que dice homogéneo
    -- sobre un pallet que no lo es.
    mixto         INTEGER NOT NULL DEFAULT 0,
    fecha_empaque TEXT,                     -- el día de proceso, el que va impreso
    -- Congelados al cerrar. El contenido se puede consultar sumando las cargas, pero
    -- lo que se IMPRIMIÓ tiene que quedar fijo: una carga corregida después no cambia
    -- la etiqueta que se fue en el camión.
    bultos        REAL,
    kilos         REAL,
    observacion   TEXT,
    abierto_en    TEXT DEFAULT (datetime('now','localtime')),
    cerrado_en    TEXT,
    usuario_id    INTEGER,
    usuario       TEXT,
    eliminado_en  TEXT
  );
  CREATE INDEX IF NOT EXISTS gal_pallet_estado_idx ON gal_pallets(estado);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- EL DESPACHO
  -- ═══════════════════════════════════════════════════════════════════════════
  -- Andy, 1/11/2026: «quiero un módulo separado con Stock (de ahí vamos a hacer los
  -- despachos)... la vuelta sería primero procesar y una vez que está en stock lo
  -- despachamos».
  --
  -- Un despacho es una SALIDA del stock del galpón, y no es una tabla nueva de
  -- movimientos: cada ítem despachado escribe una fila en gal_procesos con
  -- tipo = 'salida'. Esa columna está desde la V1115 justamente para esto, y los seis
  -- agregados de stock ya la descuentan (stockGalpon, stockPorProducto, stockPorLote).
  -- Una tabla aparte de salidas obligaría a sumar dos lugares para saber qué hay, y el
  -- día que una de las dos consultas se olvide de la otra el stock miente.
  --
  -- ── NO SE DESPACHA MÁS DE LO QUE HAY ──────────────────────────────────────
  -- Es la ÚNICA validación del galpón que FRENA. Todo lo demás —tarjeta repetida,
  -- balanza desconectada— se marca a_revisar porque la fruta ya está en la tolva y
  -- negarse a guardar la pierde. Acá es al revés: la fruta todavía está en la cámara,
  -- y un despacho de 300 cajas cuando hay 250 no es un dato a corregir después, es un
  -- camión al que le van a faltar 50 cuando llegue.
  --
  -- Y nada se rechaza después del hecho tampoco acá: un despacho emitido se ANULA
  -- (anulado_en), que devuelve los kilos al stock y deja el número gastado. Borrar la
  -- fila haría desaparecer un remito que alguien tiene en la mano.
  CREATE TABLE IF NOT EXISTS gal_despachos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    numero        TEXT UNIQUE,              -- DG-26-00001, al emitir
    estado        TEXT NOT NULL DEFAULT 'borrador',  -- borrador | emitido | anulado
    fecha         TEXT NOT NULL,            -- YYYY-MM-DD
    -- A dónde va. Texto libre a propósito: el día uno se despacha a San Gerónimo y a
    -- la feria, y un selector de clientes de SG acá ataría este módulo a una operativa
    -- que todavía no está al 100%, que es lo que Andy pidió no mezclar.
    destinatario  TEXT,
    transporte    TEXT,
    patente       TEXT,
    remito        TEXT,                     -- el remito de verdad, si ya se hizo
    observacion   TEXT,
    bultos        REAL,                     -- congelados al emitir, como el pallet
    kilos         REAL,
    emitido_en    TEXT,
    anulado_en    TEXT,
    anulado_motivo TEXT,
    creado_en     TEXT DEFAULT (datetime('now','localtime')),
    usuario_id    INTEGER,
    usuario       TEXT,
    eliminado_en  TEXT
  );
  CREATE INDEX IF NOT EXISTS gal_desp_estado_idx ON gal_despachos(estado, fecha);


  CREATE INDEX IF NOT EXISTS gal_proc_fecha_idx ON gal_procesos(fecha);
  CREATE INDEX IF NOT EXISTS gal_proc_lote_idx  ON gal_procesos(lote_id, fecha);
  CREATE INDEX IF NOT EXISTS gal_proc_dest_idx  ON gal_procesos(destino, fecha);
`);

// Migraciones de columnas nuevas, mismo patrón que el resto del repo: una por línea y con
// try/catch, porque SQLite no tiene ADD COLUMN IF NOT EXISTS.
for (const sql of [
  "ALTER TABLE gal_cuadrilla_tarjetas ADD COLUMN notas TEXT",
  "ALTER TABLE gal_lote_vigente ADD COLUMN producto TEXT",
  // ── CUANDO NO SE SABE DE QUÉ LOTE ES ────────────────────────────────────────────
  // Andy, 31/10/2026: «me tiene que dejar mezclar entre los lotes porque no siempre
  // tenemos bien en claro de qué lote es cada uno. Es decir es todo Damasco».
  //
  // La tolva mezcla, y pedirle al operador que elija UN lote cuando hay tres adentro
  // es pedirle que invente. Una carga puede repartirse entre varios: se escribe una
  // FILA POR LOTE —así el rinde por lote y el stock siguen siendo un GROUP BY y no hay
  // una sola consulta que reescribir— y las filas de un mismo reparto comparten esto:
  //
  //   reparto   el uuid del grupo. Deshacer una tiene que deshacerlas a todas, o queda
  //             media carga atribuida y la otra mitad no.
  //   repartido 1 = estos kilos son una ESTIMACIÓN, no una medición. Importa que se
  //             vea: el rinde de un lote hecho de prorrateos no es el mismo dato que
  //             el de un lote que entró solo.
  "ALTER TABLE gal_procesos ADD COLUMN reparto TEXT",
  // ── LA SALIDA APUNTA A SU DESPACHO ─────────────────────────────────────────────
  // Sin esto, anular un despacho obligaría a adivinar qué filas eran suyas por fecha y
  // destino —y dos despachos del mismo día a la misma feria son indistinguibles—.
  "ALTER TABLE gal_procesos ADD COLUMN despacho_id INTEGER",
  // ── UN DIBUJITO POR PRESENTACIÓN ───────────────────────────────────────────────
  // Andy, 1/11/2026: «permitime en algún lugar sumar emoticones para cada
  // presentación. Quiero que sea algo más visual el stock, más fácil de usar».
  //
  // No es decoración: el stock se mira de parado y de lejos, y un 📦 se distingue de
  // un 🫙 de un vistazo mientras que «Carton Amarilla· 10 × 700 g» y «Blanca Chico
  // (kilos)» son dos renglones de texto que hay que LEER. El nombre sigue estando al
  // lado: el emoji no reemplaza nada, acelera encontrar.
  "ALTER TABLE gal_presentaciones ADD COLUMN emoji TEXT",
  // ── UN DIBUJO PROPIO ───────────────────────────────────────────────────────────
  // Andy, 1/11/2026: «quiero yo poder subirle algún dibujito desde la computadora, ya
  // estuve armando unos emoticones».
  //
  // Se guarda la RUTA, no la imagen: un blob en SQLite entra en todos los SELECT * de
  // la tabla —y en el galpón hay varios— así que cada listado del catálogo arrastraría
  // los siete dibujos por la red para mostrar una lista de texto.
  //
  // Y LA RUTA NO SALE EN NINGÚN JSON. La imagen sale sólo por
  // GET /api/galpon/presentaciones/:id/icono, que pasa por requireAuth. Es la misma
  // regla que la foto de la tarjeta de un contacto: lo que se escribe en data/sg,
  // data/ifco o data/uploads queda servido por express.static ANTES del portón de
  // sesión (index.js:110-115) y es alcanzable sin cookie. Acá el dibujo de una caja no
  // es un secreto, pero tampoco hay una sola razón para publicarlo, y el día que
  // alguien copie este código para algo que sí lo sea arrastra el agujero.
  // ── ARMAR UN PALLET CON LO QUE YA ESTÁ EN CÁMARA ───────────────────────────────
  // Andy, 1/11/2026: «necesito un lugar donde pueda hacer cierre de pallet de
  // mercadería que está suelta en el stock, donde puedo agarrar pallets mixtos y todo».
  //
  // El pallet DEL PROCESO se llena solo con la carga del día: la primera caja lo abre.
  // Pero antes de que salga el camión hay que REARMAR —juntar lo que quedó de varias
  // tandas, partir uno que no se completó, mezclar dos calibres—, y eso no se puede
  // hacer cargando de nuevo: las cajas ya están contadas y volver a cargarlas las
  // contaría dos veces.
  //
  // Por eso el pallet armado NO MUEVE EL STOCK. Un pallet es una UBICACIÓN, no un
  // movimiento: las cajas siguen en la cámara, apiladas de otra manera. Lo que saca
  // del stock es el despacho, y eso ya estaba.
  "ALTER TABLE gal_pallets ADD COLUMN origen TEXT NOT NULL DEFAULT 'proceso'",
  // ── DE QUÉ CARGA SALIÓ ESTA PARTE ──────────────────────────────────────────────
  // Poner 60 cajas en un pallet cuando la carga de ese día fue de 267 obliga a PARTIR
  // la fila: queda una de 207 y una de 60. El stock no cambia —207 + 60 son las 267 de
  // siempre— pero la historia sí tiene que poder reconstruirse, y para eso las dos
  // apuntan a la carga original.
  //
  // Es el mismo idioma que `reparto`, que marca una carga repartida entre varios lotes:
  // ahí lo repartido es una estimación y acá es una mudanza, pero en los dos casos lo
  // que importa es que el renglón que se ve en pantalla no es el que entró por la
  // balanza.
  "ALTER TABLE gal_procesos ADD COLUMN partido_de INTEGER",
  "ALTER TABLE gal_presentaciones ADD COLUMN icono TEXT",
  // Cambia cada vez que se sube uno nuevo. Va en la URL como ?v= porque si no el
  // navegador sigue mostrando el anterior: misma dirección, misma caché.
  "ALTER TABLE gal_presentaciones ADD COLUMN icono_v TEXT",
  "ALTER TABLE gal_procesos ADD COLUMN repartido INTEGER NOT NULL DEFAULT 0",
  "CREATE INDEX IF NOT EXISTS gal_proc_reparto_idx ON gal_procesos(reparto)",
  // EL ARTÍCULO Y LOS DATOS DEL TARJETÓN (V1119). Ver los comentarios de arriba.
  "ALTER TABLE gal_presentaciones ADD COLUMN categoria TEXT NOT NULL DEFAULT 'I'",
  "ALTER TABLE gal_presentaciones ADD COLUMN calibre TEXT",
  "ALTER TABLE gal_procesos ADD COLUMN categoria TEXT",
  "ALTER TABLE gal_procesos ADD COLUMN calibre TEXT",
  "ALTER TABLE gal_procesos ADD COLUMN variedad TEXT",
  "ALTER TABLE gal_procesos ADD COLUMN renspa TEXT",
  "ALTER TABLE gal_procesos ADD COLUMN cuartel TEXT",
  // EL PALLET (V1120). Una carga pertenece a un pallet, o a ninguno todavía. Si hay
  // que repartir cien cajas entre dos pallets, se cargan dos veces — que es lo que se
  // hace físicamente igual.
  "ALTER TABLE gal_procesos ADD COLUMN pallet_id INTEGER",
  "CREATE INDEX IF NOT EXISTS gal_proc_pallet_idx ON gal_procesos(pallet_id)",
  // DOS TRAMOS A LA MISMA HORA DEL MISMO DÍA NO PUEDEN EXISTIR. loteVigente ordena por
  // hora y después por id, así que el segundo le gana al primero EN SILENCIO: el tramo
  // de la mañana queda listado en la pantalla, se ve igualito, y no atribuye un kilo.
  //
  // El router lo corta antes con un 409 que dice con qué se pisa —eso es lo que lee el
  // operador—; esto es el cinturón de abajo, para lo que entre por otro lado.
  "CREATE UNIQUE INDEX IF NOT EXISTS gal_lote_vig_uq ON gal_lote_vigente(fecha, desde_hora)",
]) { try { db.exec(sql); } catch (_) {} }

// ── LOS VALORES QUE TIENEN QUE EXISTIR DESDE EL DÍA UNO ──────────────────────────────
// Se siembran con INSERT OR IGNORE: si alguien ya los cambió, no se pisan. Sin esto, la
// primera pantalla que los lea tendría que inventarse un default por su cuenta — y dos
// pantallas se inventarían dos distintos.
for (const [clave, valor] of [
  // La tara del IFCO vacío, en kg.
  //
  // OJO: HOY NO SE LE RESTA A NADA. Esta línea decía «es lo que se le resta al bruto
  // de la balanza» y desde la V1114 eso es falso: el indicador tiene su propia tecla
  // TARA, y la práctica es apoyar un IFCO vacío y tararlo ahí. Restar los dos kilos
  // de nuevo por software, encima de eso, serían dos kilos menos por cajón — una
  // tonelada por cada quinientos, desaparecida sin que nada avise.
  //
  // Queda para el circuito de escaneo, donde el peso bruto va a entrar sin tarar.
  ['tara_ifco', '2.0'],
  // El objetivo de ritmo del galpón. El tablero pinta el kg/h contra esto.
  ['objetivo_kg_hora', '733'],
  // Los motivos por los que un IFCO se marca observado. Un toque en la pantalla, no texto
  // libre: texto libre son cuarenta maneras de escribir "golpeado" y ningún informe posible.
  ['motivos_calidad', 'golpeado,sobremaduro,muy verde,podrido,tierra/sucio,IFCO incompleto'],
  // El puerto de la balanza lo elige el operador con un gesto del navegador (Web Serial no
  // deja elegirlo por código); acá queda lo que se recuerda para la próxima.
  ['balanza_puerto', ''],
  ['balanza_baudios', '9600'],
  // EL TECHO DE UNA CARGA, EN KILOS. Cargando a mano, el error que de verdad pasa es el
  // cero de más: 4500 donde iban 450. No lo agarra nadie —el número es plausible, el
  // lote existe, la cuadrilla existe— y queda adentro del rendimiento de la temporada.
  //
  // No RECHAZA: marca la fila `a_revisar` y la carga entra igual. Un techo que frena la
  // carga es un techo que alguien va a esquivar partiendo el renglón en dos.
  // En 0 queda apagado.
  ['kg_max_carga', '20000'],
  // EL MISMO TECHO, PARA EL PROCESO. Acá el error de un cero de más tiene una forma
  // propia: escribir 700 en el peso de la cubeta pensando en GRAMOS. Cien cajas de
  // diez cubetas pasan de 700 kg a 700.000. La pantalla pide la unidad para que no
  // pase, y esto es el cinturón de abajo. Marca, no rechaza: lo que ya se embaló,
  // se embaló. En 0 queda apagado.
  ['kg_max_proceso', '50000'],
  // EL PIE DEL TARJETÓN. Van en la configuración y no en el código porque son datos
  // de la empresa: el día que cambie el CUIT o la localidad, lo cambia quien lo sabe
  // y no hace falta un PR.
  ['etq_marca', 'LA NIÑA BONITA'],
  ['etq_comercializa', 'San Gerónimo S.A. · CUIT 30-67325443-4'],
  ['etq_origen', 'Carpintería, San Juan · Producto argentino'],
  // El prefijo del número de pallet. PC = Puente Cordón.
  ['pallet_prefijo', 'PC'],
  ['despacho_prefijo', 'DG'],
]) {
  try {
    db.prepare('INSERT OR IGNORE INTO gal_config (clave, valor) VALUES (?,?)').run(clave, valor);
  } catch (e) { console.error('[GALPON] sembrando ' + clave + ':', e.message); }
}

// ── LAS PRESENTACIONES DEL PRIMER DÍA ───────────────────────────────────────────────
// Sólo si la tabla está VACÍA, y acá eso es lo correcto — al revés que en los módulos,
// donde CLAUDE.md marca el `if (n > 0) return` del seed como una trampa. La diferencia
// es de quién es la lista: los módulos los decide el repo y tienen que aparecer sí o sí;
// las presentaciones las arma el galpón y se borran a propósito. Resucitar una que
// alguien sacó sería pelearse con el que la sacó, todos los arranques.
//
// Las tres a granel no inventan nada: un bin se pesa entero. La de cajas es, tal cual,
// el ejemplo que dio Andy el 31/10/2026 — y se edita en Configuración como cualquier otra.
try {
  const n = db.prepare('SELECT COUNT(*) AS n FROM gal_presentaciones').get().n;
  if (!n) {
    const ins = db.prepare(
      'INSERT INTO gal_presentaciones (nombre,destino,envase,por_bulto,kg_unidad,granel,orden)'
      + ' VALUES (?,?,?,?,?,?,?)');
    for (const f of [
      ['Caja cartón · 10 × 700 g', 'comercial', 'Caja cartón', 10, 0.7, 0, 10],
      ['A granel (kilos)',         'comercial', null,          1,  1,   1, 20],
      ['Bin de verde',             'verde',     'Bin',         1,  1,   1, 10],
      ['Bin de descarte',          'descarte',  'Bin',         1,  1,   1, 10],
    ]) ins.run(...f);
  }
} catch (e) { console.error('[GALPON] sembrando presentaciones:', e.message); }

// ── LO QUE SE CARGÓ ANTES DE QUE EL PRODUCTO VIAJARA ────────────────────────────────
// Andy, 1/11/2026: «aclaro todo lo que está cargado hasta ahora en damasco, pero sí
// necesito diferenciarlo porque después viene uva y melón».
//
// La columna existía y estaba siempre en NULL: la pantalla de proceso nunca la mandaba,
// y con un solo producto el corte se veía igual de bien contando todo junto.
//
// CORRE UNA SOLA VEZ, marcada en gal_config. Un UPDATE ... WHERE producto IS NULL en
// cada arranque le pondría «Damasco» a la primera carga de uva que entre sin cultivo
// cargado en su lote — y eso ya no sería arreglar el pasado, sería ensuciar el futuro.
try {
  const hecha = db.prepare("SELECT valor FROM gal_config WHERE clave = 'migr_producto_damasco'").get();
  if (!hecha) {
    const r = db.prepare(
      "UPDATE gal_procesos SET producto = 'Damasco' WHERE producto IS NULL OR producto = ''").run();
    const v = db.prepare(
      "UPDATE gal_volcados SET producto = 'Damasco' WHERE producto IS NULL OR producto = ''").run();
    db.prepare("INSERT INTO gal_config (clave, valor) VALUES ('migr_producto_damasco', ?)")
      .run(new Date().toISOString().slice(0, 10) + ': ' + r.changes + ' procesos, '
           + v.changes + ' volcados');
    if (r.changes || v.changes) {
      console.log('[GALPON] producto=Damasco en ' + r.changes + ' procesos y '
        + v.changes + ' volcados que estaban sin producto');
    }
  }
} catch (e) { console.error('[GALPON] migración del producto:', e.message); }

console.log("[GALPON] Tablas de Galpón verificadas");

export default db;
