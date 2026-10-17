// src/servicios/db_ia_uso.js
// ── CUÁNTO CONSUME CADA COSA ─────────────────────────────────────────────────────────
// Andy, 17/10/2026: «¿Si armamos un lugar en el panel donde podamos ver cuánto consume
// cada cosa? Creo que va a ser muy práctico a futuro».
//
// El 14/10 la cuenta de la API se quedó sin crédito y el OCR de remitos dejó de leer. Al
// buscar qué lo había consumido apareció el problema de fondo: NO HABÍA FORMA DE SABERLO.
// Las llamadas devuelven `usage` —cuántos tokens entraron y salieron— y nadie lo guardaba.
// La consola de Anthropic muestra el total por modelo, pero todas las funciones de este
// sistema usan LA MISMA clave, así que ahí el OCR, la lectura de facturas y el buscador son
// un solo número.
//
// Esta tabla es una fila por llamada. Con eso, «¿quién se está comiendo el crédito?» pasa
// de ser una deducción a ser una consulta.
//
// ── POR QUÉ SE GUARDA EL COSTO Y NO SÓLO LOS TOKENS ─────────────────────────────────
// Porque los precios cambian. Si mañana baja el precio de un modelo y el costo se
// calculara al leer, los informes de marzo se reescribirían solos y no cerrarían nunca con
// lo que se pagó. Se congela el costo del día, con el precio que regía — igual que el
// `total` de un comprobante, que es lo que dice el papel y no se recalcula.
//
// ── UNA FILA POR LLAMADA, NO UN CONTADOR ────────────────────────────────────────────
// Un contador por función diría cuánto, nunca cuándo ni por qué. La pregunta que vale es
// «qué pasó el martes», y eso necesita las llamadas sueltas. Son pocas por día: el volumen
// de este sistema se mide en cientos, no en millones.
import db from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS ia_uso (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    -- QUÉ FUNCIÓN la hizo. Es la columna entera: sin esto, todo vuelve a ser un solo
    -- número por modelo, que es exactamente lo que ya muestra la consola de Anthropic y
    -- no alcanzó. Los nombres salen de FUNCIONES en servicios/ia.js, no son texto libre.
    funcion         TEXT NOT NULL,
    modelo          TEXT NOT NULL,

    -- Los cuatro tipos de token se guardan por separado porque valen distinto: lo que
    -- entra leído de caché sale una décima parte, y escribir caché cuesta más que entrar
    -- normal. Sumarlos en uno solo haría imposible ver si la caché está sirviendo.
    tok_entrada     INTEGER NOT NULL DEFAULT 0,
    tok_salida      INTEGER NOT NULL DEFAULT 0,
    tok_cache_lee   INTEGER NOT NULL DEFAULT 0,
    tok_cache_crea  INTEGER NOT NULL DEFAULT 0,

    -- En milésimas de dólar (milésimos de USD), enteros. Guardar plata en coma flotante
    -- es juntar error en cada suma, y acá se suman miles de filas. Una llamada barata
    -- cuesta menos de un centavo, así que el centavo no alcanza como unidad.
    costo_mil       INTEGER NOT NULL DEFAULT 0,

    ms              INTEGER,
    ok              INTEGER NOT NULL DEFAULT 1,
    -- Qué pasó cuando no salió bien. Una llamada fallida igual puede haberse COBRADO
    -- (el modelo generó y después se cortó la conexión), y es la que explica un pico raro.
    error           TEXT,
    usuario_id      INTEGER,
    usuario         TEXT,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );
  -- Las tres consultas de la pantalla: por día, por función, y el detalle reciente.
  CREATE INDEX IF NOT EXISTS ia_uso_fecha_idx   ON ia_uso(creado_en);
  CREATE INDEX IF NOT EXISTS ia_uso_funcion_idx ON ia_uso(funcion, creado_en);
  CREATE INDEX IF NOT EXISTS ia_uso_modelo_idx  ON ia_uso(modelo, creado_en);
`);

for (const sql of [
  "ALTER TABLE ia_uso ADD COLUMN tok_cache_lee INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE ia_uso ADD COLUMN tok_cache_crea INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE ia_uso ADD COLUMN ms INTEGER",
  "ALTER TABLE ia_uso ADD COLUMN error TEXT",
]) { try { db.exec(sql); } catch (_) {} }

console.log("[IA] Tabla de consumo verificada");

export default db;
