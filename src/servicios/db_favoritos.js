// src/servicios/db_favoritos.js
// ─── Tabla de favoritos por usuario ───────────────────────────────────
// Cada usuario puede pinear módulos del sidebar como "favoritos" para acceso rápido.
// El orden es relativo al usuario (no global).

import { getDb } from './db.js';

const db = getDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios_favoritos (
    usuario_id  INTEGER NOT NULL,
    modulo      TEXT    NOT NULL,
    orden       INTEGER DEFAULT 0,
    creado_en   TEXT    DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (usuario_id, modulo)
  );
  CREATE INDEX IF NOT EXISTS idx_favoritos_usuario ON usuarios_favoritos(usuario_id);
`);

console.log("[FAVORITOS] Schema inicializado");
