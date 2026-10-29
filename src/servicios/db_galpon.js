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
`);

// Migraciones de columnas nuevas, mismo patrón que el resto del repo: una por línea y con
// try/catch, porque SQLite no tiene ADD COLUMN IF NOT EXISTS.
for (const sql of [
  "ALTER TABLE gal_cuadrilla_tarjetas ADD COLUMN notas TEXT",
  "ALTER TABLE gal_lote_vigente ADD COLUMN producto TEXT",
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
  // La tara del IFCO vacío, en kg. Es lo que se le resta al bruto de la balanza.
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
]) {
  try {
    db.prepare('INSERT OR IGNORE INTO gal_config (clave, valor) VALUES (?,?)').run(clave, valor);
  } catch (e) { console.error('[GALPON] sembrando ' + clave + ':', e.message); }
}

console.log("[GALPON] Tablas de Galpón verificadas");

export default db;
