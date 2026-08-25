// src/servicios/share_ddl.js
// ── EL ESQUEMA DEL MÓDULO SHARE, EN UN SOLO LUGAR ─────────────────────────────────────
// El DDL vive acá y NO en db_share.js por un motivo concreto: db_share.js abre la base real
// con better-sqlite3, que no compila en Windows, así que ningún test puede importarlo. Con
// el SQL suelto en su propio módulo, el test crea el esquema DE VERDAD sobre una base
// node:sqlite en memoria en vez de contra una copia escrita a mano que se desactualiza sola.
//
// Ver db_share.js para el porqué de cada tabla.

export const DDL = `
  CREATE TABLE IF NOT EXISTS share_cargas (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    archivo_nombre    TEXT NOT NULL,
    hash_sha256       TEXT NOT NULL UNIQUE,
    fecha_entrega     TEXT NOT NULL,
    fecha_desde       TEXT,
    fecha_hasta       TEXT,
    filas             INTEGER,
    bultos_total      REAL,
    filas_sin_mapear  INTEGER DEFAULT 0,
    warnings          TEXT,
    cargado_at        TEXT DEFAULT (datetime('now','localtime')),
    cargado_por       TEXT,
    cargado_por_id    INTEGER,
    estado            TEXT NOT NULL DEFAULT 'activa',
    reemplazada_por   INTEGER,
    reemplazada_en    TEXT
  );

  CREATE TABLE IF NOT EXISTS share_proveedores (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre_canonico    TEXT NOT NULL UNIQUE,
    es_nosotros        INTEGER NOT NULL DEFAULT 0,
    tipo               TEXT NOT NULL DEFAULT 'competidor',
    notas              TEXT,
    pendiente_revision INTEGER NOT NULL DEFAULT 0,
    creado_en          TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS share_articulos (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    desc_canonica      TEXT NOT NULL UNIQUE,
    articulo_base      TEXT,
    calidad            TEXT,
    familia            TEXT,
    rubro              TEXT,
    unidad             TEXT,
    gramos             INTEGER,
    factor_kg          REAL,
    la_vendemos        INTEGER NOT NULL DEFAULT 0,
    pendiente_revision INTEGER NOT NULL DEFAULT 0,
    activo             INTEGER NOT NULL DEFAULT 1,
    creado_en          TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS share_lineas (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    carga_id          INTEGER NOT NULL REFERENCES share_cargas(id) ON DELETE CASCADE,
    fecha_entrega     TEXT NOT NULL,
    proveedor_raw     TEXT NOT NULL,
    proveedor_id      INTEGER REFERENCES share_proveedores(id),
    articulo_raw      TEXT NOT NULL,
    articulo_id       INTEGER REFERENCES share_articulos(id),
    bultos            REAL NOT NULL,
    unidad            TEXT,
    kg_equiv          REAL
  );

  CREATE TABLE IF NOT EXISTS share_alias (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo              TEXT NOT NULL,
    alias_raw         TEXT NOT NULL,
    destino_id        INTEGER NOT NULL,
    creado_en         TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(tipo, alias_raw)
  );

  -- ── LO QUE NOSOTROS OFRECEMOS ──────────────────────────────────────────────────────
  -- El planning dice qué COMPRÓ Carrefour. Esto dice qué le OFRECIMOS ese día, que es la
  -- otra mitad: sin la oferta, un artículo que no nos compró y uno que ni le mostramos se
  -- ven exactamente igual — cero bultos nuestros — y son dos problemas distintos.
  CREATE TABLE IF NOT EXISTS share_ofertas (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha             TEXT NOT NULL,
    origen            TEXT,                   -- 'excel' | 'texto'
    archivo_nombre    TEXT,
    filas             INTEGER,
    bultos_total      REAL,
    notas             TEXT,
    cargado_por       TEXT,
    cargado_por_id    INTEGER,
    creado_en         TEXT DEFAULT (datetime('now','localtime')),
    -- Una sola oferta activa por día: si se vuelve a cargar, la anterior queda de historia.
    estado            TEXT NOT NULL DEFAULT 'activa',
    reemplazada_por   INTEGER,
    reemplazada_en    TEXT
  );

  CREATE TABLE IF NOT EXISTS share_oferta_lineas (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    oferta_id         INTEGER NOT NULL REFERENCES share_ofertas(id) ON DELETE CASCADE,
    fecha             TEXT NOT NULL,
    articulo_raw      TEXT NOT NULL,
    articulo_id       INTEGER REFERENCES share_articulos(id),
    cantidad          REAL NOT NULL,
    notas             TEXT
  );

  CREATE INDEX IF NOT EXISTS ix_share_of_fecha ON share_oferta_lineas(fecha);
  CREATE INDEX IF NOT EXISTS ix_share_of_art   ON share_oferta_lineas(articulo_id, fecha);
  CREATE INDEX IF NOT EXISTS ix_share_of_carga ON share_oferta_lineas(oferta_id);
  CREATE INDEX IF NOT EXISTS ix_share_ofertas_est ON share_ofertas(estado, fecha);

  CREATE INDEX IF NOT EXISTS ix_share_lineas_fecha ON share_lineas(fecha_entrega);
  CREATE INDEX IF NOT EXISTS ix_share_lineas_art   ON share_lineas(articulo_id, fecha_entrega);
  CREATE INDEX IF NOT EXISTS ix_share_lineas_prov  ON share_lineas(proveedor_id, fecha_entrega);
  CREATE INDEX IF NOT EXISTS ix_share_lineas_carga ON share_lineas(carga_id);
  CREATE INDEX IF NOT EXISTS ix_share_lineas_agg   ON share_lineas(fecha_entrega, articulo_id, proveedor_id);
  CREATE INDEX IF NOT EXISTS ix_share_cargas_est   ON share_cargas(estado, fecha_entrega);
`;

// La vista que excluye las cargas reemplazadas. Se recrea siempre (DROP + CREATE) porque con
// IF NOT EXISTS un cambio de definición no llegaría nunca a una base que ya la tiene — o
// sea, no llegaría a producción.
export const VISTA = `
  DROP VIEW IF EXISTS share_v;
  CREATE VIEW share_v AS
    SELECT l.id, l.carga_id, l.fecha_entrega, l.proveedor_raw, l.proveedor_id,
           l.articulo_raw, l.articulo_id, l.bultos, l.unidad, l.kg_equiv
      FROM share_lineas l
      JOIN share_cargas c ON c.id = l.carga_id
     WHERE c.estado = 'activa';
`;

export const VISTA_OFERTA = `
  DROP VIEW IF EXISTS share_oferta_v;
  CREATE VIEW share_oferta_v AS
    SELECT l.id, l.oferta_id, l.fecha, l.articulo_raw, l.articulo_id, l.cantidad
      FROM share_oferta_lineas l
      JOIN share_ofertas o ON o.id = l.oferta_id
     WHERE o.estado = 'activa';
`;

export function crearEsquema(db) {
  db.exec(DDL);
  db.exec(VISTA);
  db.exec(VISTA_OFERTA);
}
