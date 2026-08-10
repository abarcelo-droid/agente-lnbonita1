// src/servicios/bt_ddl.js
// ── EJECUTAR DDL SIN PODER VOLTEAR EL SERVIDOR ─────────────────────────────
//
// POR QUÉ EXISTE ESTE ARCHIVO (caída de producción del #603)
// Los módulos de esquema corren `db.exec(...)` en el nivel superior. Un error ahí
// no es "el módulo BT no anda": es una excepción al importar, y como index.js
// importa rutas/bt.js de arriba, el proceso entero no arranca. Todo el ERP —
// contabilidad, abasto, personal — se cayó por un CREATE INDEX de Barceló.
//
// Concretamente: el #601 dejó en producción tablas espejo llamadas bt_clientes,
// bt_viajes, bt_cargas. El #603 renombró el espejo a bt_tr_* y reusó esos nombres
// para las tablas operativas. En una base que ya tenía las viejas, el
// CREATE TABLE IF NOT EXISTS no hace nada —la tabla existe, con las columnas del
// espejo— y el CREATE INDEX siguiente busca una columna que no está.
//
// El origen se arregla en db_bt_migra.js. Esto es la otra mitad: que la próxima
// vez que un DDL de BT falle, falle SOLO BT.
//
// DOS COSAS HACE:
//   1. Si el bloque falla, lo reintenta sentencia por sentencia. Un db.exec con
//      diez CREATE se corta en el primer error y las nueve restantes no corren
//      aunque estuvieran perfectas; así se salva todo lo que sí se puede crear.
//   2. Anota la falla en `fallasEsquema`. Un esquema roto en silencio es peor que
//      uno que revienta: la pantalla tira 500 sin decir por qué. GET /api/bt/estado
//      lo publica para que se vea.
import db from './db.js';

// Lo que no se pudo crear, para que /api/bt/estado lo pueda contar.
export const fallasEsquema = [];

// Nombre de la tabla o índice de una sentencia, para que el log diga qué falló.
function queCrea(sql) {
  const m = /CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i.exec(sql);
  return m ? m[2] : sql.trim().slice(0, 40).replace(/\s+/g, ' ');
}

// Los comentarios se sacan ANTES de partir por ';': un ';' adentro de un
// comentario partiría la sentencia al medio y rompería DDL que estaba bien.
function sentencias(sql) {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

export function ddl(sql, modulo = 'BT') {
  try {
    db.exec(sql);
    return true;
  } catch (e) {
    console.error(`[${modulo}] DDL falló, reintentando sentencia por sentencia: ${e.message}`);
  }

  let fallaron = 0;
  for (const s of sentencias(sql)) {
    try {
      db.exec(s);
    } catch (e) {
      fallaron++;
      const obj = queCrea(s);
      fallasEsquema.push({ modulo, objeto: obj, error: e.message });
      console.error(`[${modulo}] ESQUEMA INCOMPLETO en ${obj}: ${e.message}`);
    }
  }
  return fallaron === 0;
}

export default ddl;
