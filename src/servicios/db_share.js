// src/servicios/db_share.js
// ── MÓDULO SHARE — PARTICIPACIÓN EN EL CD DE CARREFOUR ────────────────────────────────
// Carrefour Argentina tiene UN SOLO centro de distribución de frutas y verduras y todos los
// días publica un planning con lo que le compra a cada uno de sus ~41 proveedores. Nosotros
// (SAN GERONIMO S.A.) somos uno. Este módulo guarda esos plannings y contesta la única
// pregunta que importa: qué compra, cuánto, a quién, y dónde no estamos.
//
// TODO ES VOLUMEN. El archivo no trae precios, ni costos, ni entregas reales — sólo bultos
// planificados. Cualquier métrica de plata que aparezca en esta pantalla estaría inventada.
//
// ESTE ARCHIVO APLICA EL ESQUEMA; el SQL está en share_ddl.js y el registro del módulo en el
// sidebar en ensure_modulo_share.js — el mismo reparto que usa el resto del repo (db_sg.js /
// ensure_modulo_sg.js). Se importa desde el router, así que las tablas existen antes del
// primer request.
//
// Prefijo share_ — universo INDEPENDIENTE. Sin foreign keys hacia pa_*/sg_*/adm_*: con
// foreign_keys=ON una FK hacia otro módulo hace fallar los DELETE de ese módulo (ver
// CLAUDE.md). Acá no hay nada que cruzar de todos modos: el padrón de artículos de Carrefour
// no es el nuestro.
import db from './db.js';
import { crearEsquema } from './share_ddl.js';
// share_import.js NO importa este archivo, así que no hay ciclo: puede ser un import normal.
// Con `await import(...)` acá adentro, este módulo pasaría a ser asíncrono y arrastraría a
// todo lo que cuelga de él, incluido el router.
import { reclasificarFamilias } from './share_import.js';

// El SQL vive en share_ddl.js, no acá: este archivo abre la base real con better-sqlite3 y
// por eso ningún test lo puede importar. Con el DDL en un módulo aparte, la prueba crea el
// esquema DE VERDAD sobre node:sqlite en lugar de contra una copia que se desactualiza.
crearEsquema(db);

// Migraciones de columnas: mismo patrón que el resto del repo. Correr esto cien veces no
// tiene que romper nada, así que cada ALTER se prueba contra el PRAGMA primero.
function agregarCol(tabla, col, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${ddl}`);
  } catch (e) { console.error(`[SHARE] ALTER ${tabla}.${col}:`, e.message); }
}
agregarCol('share_cargas', 'fecha_desde', 'TEXT');
agregarCol('share_cargas', 'fecha_hasta', 'TEXT');
agregarCol('share_cargas', 'warnings', 'TEXT');
agregarCol('share_cargas', 'cargado_por_id', 'INTEGER');
agregarCol('share_cargas', 'reemplazada_por', 'INTEGER');
agregarCol('share_cargas', 'reemplazada_en', 'TEXT');
agregarCol('share_articulos', 'pendiente_revision', 'INTEGER NOT NULL DEFAULT 0');
agregarCol('share_proveedores', 'pendiente_revision', 'INTEGER NOT NULL DEFAULT 0');

// Las familias cambiaron (VERDURA y HONGO → HORTALIZA PESADA / LIVIANA): los artículos que
// se cargaron antes se quedaron con la etiqueta vieja y hay que traerlos al vocabulario
// nuevo. Corre en cada arranque y no hace nada cuando ya está todo migrado.
try {
  const r = reclasificarFamilias(db);
  if (r.migrados) {
    console.log(`[SHARE] Familias migradas: ${r.migrados} artículo(s) → ` +
      Object.entries(r.detalle).map(([f, n]) => `${f}: ${n}`).join(', '));
  }
} catch (e) { console.error('[SHARE] reclasificarFamilias:', e.message); }

console.log('[SHARE] Esquema verificado.');

export default db;
