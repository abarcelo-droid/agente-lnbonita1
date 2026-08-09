// Registro idempotente del módulo "Viajes y Cargas" de Barceló Transporte.
//
// POR QUÉ EXISTE: el seed de db_org.js hace `if (n > 0) return`, o sea que solo
// corre con la tabla vacía. Agregar una fila a ese array no hace nada en una base
// que ya tiene datos — es decir, en producción. Esto corre SIEMPRE.
//
// Va en el grupo "Barceló Transporte", el mismo del Dashboard, y colgado de la
// sociedad BT: es lo que hace que el ítem viva del lado de Barceló y no mezclado
// con los módulos de las otras dos empresas.
//
// OJO CON LA VISIBILIDAD: el sidebar NO filtra por permisos (GET /api/org/sidebar
// mira solo oculto=0). Lo que impide que alguien de otra empresa vea DATOS de
// Barceló no es este registro sino el guard del router (rutas/bt.js), que exige
// que la empresa activa sea BT.
import db from './db.js';

try {
  const soc = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE 'Barcel%Transporte%'").get();
  const socId = soc ? soc.id : null;

  db.prepare(
    'INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)'
  ).run('bt-viajes', '🚚 Viajes y Cargas', 'Barceló Transporte', socId, 'operativo', 710);

  // INSERT OR IGNORE no actualiza filas existentes: este UPDATE es el que
  // garantiza label, grupo y visibilidad en cada arranque.
  db.prepare(
    "UPDATE modulos_config SET label='🚚 Viajes y Cargas', grupo='Barceló Transporte', " +
    "sociedad_id=?, oculto=0 WHERE modulo='bt-viajes'"
  ).run(socId);

  console.log("[ORG] Módulo 'Viajes y Cargas' (bt-viajes) verificado: BARCELÓ TRANSPORTE.");
} catch (e) {
  console.error('[ORG] Error ensureModuloBt:', e.message);
}
