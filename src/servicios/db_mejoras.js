// ══ MEJORAS — EL BUZÓN DE LO QUE HAY QUE ARREGLAR ═══════════════════════════
//
// Pablo, 2/9/2026: «cada usuario puede proponer ahí algo para mejorar en cada uno
// de los menús con los que le toca interactuar. Es para UNIFICAR CANALES DE
// COMUNICACIÓN. Obviamente sólo podrá proponer cosas sobre los menús en los que
// tiene acceso. Los administradores vamos a poder asignarles prioridad del 1 al 5
// para que vean en qué estado están sus pedidos, y cuando estén resueltos
// marcarlos como resueltos».
//
// EL PUNTO ES EL CANAL, NO LA LISTA. Hoy lo que hay que arreglar llega por
// WhatsApp, por teléfono y de palabra en el pasillo: el que lo pide no sabe si
// alguien lo anotó, el que lo arregla no sabe cuál de los cuarenta es urgente, y
// nadie puede decir "esto ya está". Una sola puerta con estado a la vista cambia
// las tres cosas.
//
// SIN FOREIGN KEYS. `db.js` corre con foreign_keys=ON, así que una FK hacia
// `usuarios` o hacia `modulos_config` haría fallar los DELETE de esos módulos —la
// regla del repo—. Se guardan usuario_id y modulo sueltos, igual que
// usuarios_favoritos y usuario_modulos.
//
// Y SE GUARDA EL NOMBRE, NO SÓLO EL ID. El label del menú y el nombre de quien
// propuso quedan copiados en la fila: a los seis meses un módulo se puede
// renombrar o alguien puede irse, y la mejora tiene que seguir diciendo sobre qué
// pantalla era y quién la pidió.
import db from './db.js';

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mejoras (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      modulo         TEXT NOT NULL,
      modulo_label   TEXT,
      texto          TEXT NOT NULL,
      foto_ruta      TEXT,
      foto_nombre    TEXT,
      usuario_id     INTEGER NOT NULL,
      usuario_nombre TEXT,
      -- LA PRIORIDAD LA PONE EL ADMINISTRADOR, y arranca vacía: "sin prioridad"
      -- es un estado real —nadie la miró todavía— y no lo mismo que "prioridad 3".
      prioridad      INTEGER,
      -- 'propuesta' | 'resuelta'. Dos, no cinco: un tablero con siete estados es
      -- un tablero que nadie mantiene, y lo que se pidió fue saber si está hecho.
      estado         TEXT NOT NULL DEFAULT 'propuesta',
      resuelta_en    TEXT,
      resuelta_por   INTEGER,
      resuelta_nota  TEXT,
      creado_en      TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_mejoras_usuario ON mejoras(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_mejoras_estado  ON mejoras(estado, prioridad);
  `);
} catch (e) {
  console.error('[DB] mejoras:', e.message);
}

export default db;
