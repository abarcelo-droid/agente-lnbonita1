// src/servicios/db_sg_contactos.js
// ── CONTACTOS COMERCIALES DE SAN GERÓNIMO ────────────────────────────────────────────
// La agenda del área comercial: quién es cada uno, cómo se lo ubica, qué produce o qué
// compra, y qué se habló la última vez.
//
// ── POR QUÉ NO ES UN CAMPO MÁS EN proveedores/clientes ───────────────────────────────
// El padrón tiene EMPRESAS: razón social, CUIT, condición de IVA. Esto tiene PERSONAS —
// Juan, el hijo de Giglio, que atiende el teléfono del galpón— y una persona no es una
// fila de un padrón fiscal. Cuando se va el comprador de una cadena no se da de baja la
// cadena: se da de baja a la persona y la empresa sigue.
//
// Y el vínculo con el padrón se guarda POR NOMBRE (`cliente_nombre`, `proveedor_nombre`),
// que es como ya se vincula todo lo comercial en este sistema: sheet_ventas trae nombres,
// no ids. No es elegante y es lo que hay; lo importante es que esté dicho, porque un
// cambio de nombre en la planilla corta el vínculo sin avisar.
//
// ── LOS MESES VAN DE JULIO A JUNIO ───────────────────────────────────────────────────
// El año comercial de la casa arranca en julio, igual que en Informes y en Ventanas. La
// máscara `meses` tiene doce posiciones y la PRIMERA ES JULIO. Si alguien la lee como
// enero, un productor de melón pasa a ser de invierno. Está dicho acá, en el router y en
// la pantalla, a propósito.
//
// Se usa máscara y no desde/hasta porque hay productores con DOS ventanas en el año —
// una temprana y una tardía— y un rango las aplasta en una sola.
import db from "./db.js";

db.exec(`
  -- ═══════════════════════════════════════════════════════════════════════════
  -- LA FICHA
  -- ═══════════════════════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS sg_contactos (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre           TEXT NOT NULL,
    empresa          TEXT,
    cargo            TEXT,
    -- 'cliente' | 'proveedor' | 'ambos' | 'otro'. 'otro' existe porque un
    -- transportista o un técnico tampoco es ninguna de las dos y hay que poder
    -- guardarlo igual: si no entra acá, termina en el teléfono de alguien.
    tipo             TEXT NOT NULL DEFAULT 'otro',
    zona             TEXT,
    localidad        TEXT,
    -- A qué empresa del padrón corresponde. Por NOMBRE, ver el encabezado.
    cliente_nombre   TEXT,
    proveedor_nombre TEXT,
    vendedor         TEXT,
    etiquetas        TEXT,
    notas            TEXT,
    activo           INTEGER NOT NULL DEFAULT 1,
    creado_por_id    INTEGER,
    creado_en        TEXT DEFAULT (datetime('now','localtime')),
    actualizado_en   TEXT DEFAULT (datetime('now','localtime')),
    eliminado_en     TEXT
  );
  CREATE INDEX IF NOT EXISTS sg_contactos_nombre_idx   ON sg_contactos(nombre);
  CREATE INDEX IF NOT EXISTS sg_contactos_empresa_idx  ON sg_contactos(empresa);
  CREATE INDEX IF NOT EXISTS sg_contactos_tipo_idx     ON sg_contactos(tipo);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- CÓMO SE LO UBICA
  -- ═══════════════════════════════════════════════════════════════════════════
  -- Varios por contacto a propósito: un productor tiene el celular, el del galpón
  -- y el del hijo, y el que sabe cuál atiende es el comercial, no el sistema. Por
  -- eso 'preferido' y 'nota' ("sólo de mañana", "no contesta los lunes").
  CREATE TABLE IF NOT EXISTS sg_contacto_medios (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contacto_id   INTEGER NOT NULL,
    tipo          TEXT NOT NULL DEFAULT 'telefono',  -- telefono|whatsapp|mail|otro
    valor         TEXT NOT NULL,
    nota          TEXT,
    preferido     INTEGER NOT NULL DEFAULT 0,
    creado_en     TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS sg_contacto_medios_cto_idx ON sg_contacto_medios(contacto_id);
  -- Para que el buscador encuentre por teléfono sin recorrer todo.
  CREATE INDEX IF NOT EXISTS sg_contacto_medios_val_idx ON sg_contacto_medios(valor);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- QUÉ PRODUCE, Y CUÁNDO
  -- ═══════════════════════════════════════════════════════════════════════════
  -- Esto es lo DECLARADO: lo que el productor dice que tiene. Al lado, la pantalla
  -- muestra lo OBSERVADO —lo que efectivamente le compramos, que sale de las ventas—
  -- y son dos cosas distintas: puede ofrecer brócoli y no habérselo comprado nunca.
  -- Mezclarlas haría imposible ver justamente ese hueco, que es una oportunidad.
  CREATE TABLE IF NOT EXISTS sg_contacto_productos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    contacto_id  INTEGER NOT NULL,
    producto     TEXT NOT NULL,
    variedad     TEXT,
    -- Doce posiciones, LA PRIMERA ES JULIO. '000011111000' = noviembre a marzo.
    meses        TEXT NOT NULL DEFAULT '000000000000',
    volumen      TEXT,
    notas        TEXT,
    creado_en    TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS sg_contacto_prod_cto_idx  ON sg_contacto_productos(contacto_id);
  CREATE INDEX IF NOT EXISTS sg_contacto_prod_prod_idx ON sg_contacto_productos(producto);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- QUÉ SE HABLÓ
  -- ═══════════════════════════════════════════════════════════════════════════
  -- La bitácora. 'proximo_paso' y 'proximo_el' no son decoración: son lo que
  -- convierte una nota en una gestión. Una charla sin próximo paso se lee el mes
  -- que viene y no se sabe si quedó algo pendiente o no.
  CREATE TABLE IF NOT EXISTS sg_contacto_charlas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contacto_id   INTEGER NOT NULL,
    fecha         TEXT NOT NULL,
    canal         TEXT NOT NULL DEFAULT 'telefono',  -- telefono|whatsapp|mail|visita|otro
    resumen       TEXT NOT NULL,
    proximo_paso  TEXT,
    proximo_el    TEXT,
    hecho_en      TEXT,
    usuario_id    INTEGER,
    usuario       TEXT,
    creado_en     TEXT DEFAULT (datetime('now','localtime')),
    eliminado_en  TEXT
  );
  CREATE INDEX IF NOT EXISTS sg_contacto_charlas_cto_idx  ON sg_contacto_charlas(contacto_id);
  CREATE INDEX IF NOT EXISTS sg_contacto_charlas_fec_idx  ON sg_contacto_charlas(fecha);
  -- La bandeja de "me toca": lo pendiente con fecha.
  CREATE INDEX IF NOT EXISTS sg_contacto_charlas_prox_idx ON sg_contacto_charlas(proximo_el);
`);

// Migraciones de columnas nuevas, mismo patrón que el resto del repo: una por línea y con
// try/catch, porque SQLite no tiene ADD COLUMN IF NOT EXISTS.
for (const sql of [
  "ALTER TABLE sg_contactos ADD COLUMN cargo TEXT",
  "ALTER TABLE sg_contactos ADD COLUMN localidad TEXT",
  "ALTER TABLE sg_contactos ADD COLUMN vendedor TEXT",
  "ALTER TABLE sg_contactos ADD COLUMN etiquetas TEXT",
  "ALTER TABLE sg_contacto_charlas ADD COLUMN hecho_en TEXT",
]) { try { db.exec(sql); } catch (_) {} }

console.log("[SG] Tablas de Contactos comerciales verificadas");

export default db;
