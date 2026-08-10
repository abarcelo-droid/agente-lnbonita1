// src/servicios/db_bt_migra.js
// ── LIBERAR LOS NOMBRES bt_* QUE OCUPA EL ESPEJO VIEJO ─────────────────────
//
// QUÉ PASÓ
// El #601 creó el espejo de Transoft con nombres bt_viajes, bt_cargas,
// bt_clientes... y se desplegó. El #603 renombró el espejo a bt_tr_* y le dio
// esos mismos nombres a las tablas OPERATIVAS, que son otra cosa: otras columnas,
// otra clave. En una base nueva no se nota. En producción, que ya tenía las
// viejas, `CREATE TABLE IF NOT EXISTS bt_clientes` no hace nada —ya existe— y el
// `CREATE INDEX ... ON bt_clientes(nombre_corto)` de la línea siguiente busca una
// columna que en el espejo no existe. Excepción al importar el módulo, el proceso
// no arranca, y se cae el ERP entero.
//
// QUÉ HACE ESTO
// Corre ANTES de cualquier CREATE de BT y deja libres los nombres. El DDL del
// espejo del #601 y el de bt_tr_* del #603 son idénticos salvo el prefijo —está
// verificado campo por campo—, así que un RENAME es una migración exacta: no se
// convierte ni se copia nada, la tabla pasa a llamarse como corresponde con todo
// lo que tenga adentro.
//
// POR QUÉ NO SIMPLEMENTE UN DROP
// Casi con seguridad están vacías: el agente de sincronización (scripts/bt_sync.py)
// nunca corrió contra producción. Pero "casi con seguridad" no alcanza para borrar
// tablas en la base de la empresa. Se borra solo lo que está vacío; si hay una
// sola fila, se conserva. El peor caso posible acá es una tabla de más.
//
// IDEMPOTENTE: en una base ya migrada, o nueva, no encuentra nada y no hace nada.
import db from './db.js';

// Las 14 tablas de datos del espejo del #601. Siete de estos nombres los usa hoy
// el modelo operativo (clientes, localidades, choferes, unidades, cargas, viajes,
// documentos); las otras siete no chocan pero son del espejo igual y van al mismo
// lugar, porque dejarlas sueltas con prefijo bt_ es la próxima colisión.
const ESPEJO_DATOS = [
  'viajes', 'cargas', 'carga_viaje', 'valor_carga', 'valor_viaje',
  'documentos', 'ordenes', 'fojas', 'clientes', 'choferes',
  'unidades', 'localidades', 'provincias', 'catalogos',
];

// Los índices que el #601 creó sobre esas tablas. SQLite los deja pegados a la
// tabla renombrada con el nombre viejo, y después db_bt.js crea los mismos con
// nombre nuevo: quedarían duplicados, encareciendo cada escritura por nada.
const INDICES_601 = [
  'idx_bt_via_fecha', 'idx_bt_via_estado', 'idx_bt_car_fecha', 'idx_bt_car_cli',
  'idx_bt_car_estado', 'idx_bt_cv_viaje', 'idx_bt_cv_carga', 'idx_bt_vc_carga',
  'idx_bt_vc_fac', 'idx_bt_vv_viaje', 'idx_bt_doc_carga', 'idx_bt_ord_viaje',
  'idx_bt_cli_resum', 'idx_bt_lote_fecha',
];

function existe(tabla) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tabla);
}

function filas(tabla) {
  try {
    return db.prepare(`SELECT COUNT(*) n FROM "${tabla}"`).get().n;
  } catch {
    return 0;
  }
}

// La firma del espejo: `sincronizado_en` (de dónde y cuándo vinieron los datos) y
// SIN `id` (la clave es filial+número, como en Transoft). Una tabla operativa
// tiene exactamente lo contrario. Con esto una base ya sana no se toca: si
// bt_clientes es la operativa, tiene id y no tiene sincronizado_en, y se saltea.
function esEspejoViejo(tabla) {
  const cols = db.prepare(`PRAGMA table_info("${tabla}")`).all().map(c => c.name);
  return cols.includes('sincronizado_en') && !cols.includes('id');
}

function migrar(viejo, nuevo, esEspejo) {
  if (!existe(viejo)) return null;
  if (esEspejo && !esEspejoViejo(viejo)) return null;   // ya es la operativa: no tocar

  const nViejo = filas(viejo);

  // Vacía: es el espejo abandonado del #601, que nunca llegó a sincronizar nada.
  if (nViejo === 0) {
    db.exec(`DROP TABLE "${viejo}"`);
    return `${viejo} vacía → eliminada`;
  }

  // Tiene datos y el destino está libre: el rename los deja donde corresponde.
  if (!existe(nuevo)) {
    db.exec(`ALTER TABLE "${viejo}" RENAME TO "${nuevo}"`);
    return `${viejo} (${nViejo} filas) → ${nuevo}`;
  }

  // El destino existe porque un arranque anterior alcanzó a crearlo antes de
  // reventar. Si está vacío, el que vale es el viejo.
  if (filas(nuevo) === 0) {
    db.exec(`DROP TABLE "${nuevo}"`);
    db.exec(`ALTER TABLE "${viejo}" RENAME TO "${nuevo}"`);
    return `${viejo} (${nViejo} filas) → ${nuevo} (el destino estaba vacío)`;
  }

  // Los dos con datos. No hay forma de decidir cuál gana sin mirarlos, así que no
  // se decide: se aparta el viejo, queda el nombre libre y nadie pierde nada.
  const apartado = viejo.replace(/^bt_/, 'bt_601_');
  if (!existe(apartado)) db.exec(`ALTER TABLE "${viejo}" RENAME TO "${apartado}"`);
  return `⚠ ${viejo} y ${nuevo} tienen datos los dos → el viejo quedó como ${apartado}, revisar a mano`;
}

// ── MAESTROS DEL ESPEJO QUE PEDÍAN COLUMNAS INEXISTENTES ──────────────────
// bt_tr_clientes, bt_tr_choferes y bt_tr_unidades se escribieron con `anulado`, y
// en clientes.dbf / choferes.dbf / unpadron.dbf ese campo NO existe: la baja es
// BAJA y es una fecha. Peor: bt_tr_choferes tenía clave codsuc+cuenta, dos campos
// que tampoco existen — la clave real es CHRESUM. Con esa forma no habría entrado
// ni un chofer, y el lector de .dbf ignora en silencio lo que no encuentra.
//
// Como el agente de sincronización todavía no corrió, están vacías y se pueden
// rehacer sin perder nada. La regla es la misma que arriba: vacía se rehace, con
// una sola fila se conserva y se avisa.
const MAESTROS_VIEJOS = [
  ['bt_tr_clientes', 'anulado'],   // la columna que delata la forma vieja
  ['bt_tr_unidades', 'anulado'],
  ['bt_tr_choferes', 'codsuc'],
];

function rehacerMaestro(tabla, columnaVieja) {
  if (!existe(tabla)) return null;
  const cols = db.prepare(`PRAGMA table_info("${tabla}")`).all().map(c => c.name);
  if (!cols.includes(columnaVieja)) return null;   // ya tiene la forma nueva

  const n = filas(tabla);
  if (n === 0) {
    db.exec(`DROP TABLE "${tabla}"`);
    return `${tabla} vacía y con la forma vieja → se rehace`;
  }
  return `⚠ ${tabla} tiene ${n} filas con la forma vieja (columna ${columnaVieja}), revisar a mano`;
}

try {
  const hechos = [];

  for (const [tabla, col] of MAESTROS_VIEJOS) {
    const r = rehacerMaestro(tabla, col);
    if (r) hechos.push(r);
  }

  for (const n of ESPEJO_DATOS) {
    const r = migrar(`bt_${n}`, `bt_tr_${n}`, true);
    if (r) hechos.push(r);
  }

  // La tabla de control de lotes no lleva `sincronizado_en` ni choca con ninguna
  // operativa, pero es del espejo igual: cualquier bt_sync_lotes es la del #601.
  const r = migrar('bt_sync_lotes', 'bt_tr_sync_lotes', false);
  if (r) hechos.push(r);

  if (hechos.length) {
    for (const i of INDICES_601) {
      try { db.exec(`DROP INDEX IF EXISTS ${i}`); } catch { /* si no está, mejor */ }
    }
    console.log(`[BT-MIGRA] Tablas del espejo ajustadas (${hechos.length}):`);
    for (const h of hechos) console.log(`[BT-MIGRA]   ${h}`);
  }
} catch (e) {
  // Que ni esto pueda voltear el arranque. Si falla, el DDL de más abajo va a
  // fallar también, pero ahora falla contenido (ver bt_ddl.js) en vez de matar
  // el proceso entero.
  console.error('[BT-MIGRA] Error reubicando el espejo del #601:', e.message);
}

export default db;
