// Registro idempotente del módulo "Planificación Insumos" en modulos_config.
//
// POR QUÉ EXISTE ESTE ARCHIVO: el seed de db_org.js hace `if (n > 0) return`,
// o sea que solo corre con la tabla VACÍA. Agregar una fila al array de ese
// seed no hace nada en una base que ya tiene datos — es decir, en producción.
// Esto corre SIEMPRE (db_org.js lo importa al final, post-seed), así que el
// módulo queda registrado y aparece en el sidebar y en Config Módulos.
// Mismo patrón que ensure_modulo_actividad.js / _personal.js / _sg.js.
//
// data-sec = 'pli-planificacion': el ítem del nav y la sección
// #sec-pli-planificacion viven en panel.html.
import db from './db.js';

try {
  const soc = db.prepare("SELECT id FROM sociedades WHERE nombre = 'Puente Cordón SA'").get()
           || db.prepare("SELECT id FROM sociedades WHERE funcion = 'productiva' ORDER BY id LIMIT 1").get();
  const socId = soc ? soc.id : null;

  // Alta idempotente (no pisa si ya existe).
  db.prepare(
    'INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)'
  ).run('pli-planificacion', 'Planificación Insumos', 'Producción', socId, 'operativo', 516);

  // UPDATE que corre SIEMPRE: garantiza label/grupo/sociedad/visible aunque el
  // módulo ya estuviera registrado con oculto=1 u otros valores.
  db.prepare(
    "UPDATE modulos_config SET label='Planificación Insumos', grupo='Producción', sociedad_id=?, oculto=0 WHERE modulo='pli-planificacion'"
  ).run(socId);

  console.log("[ORG] Módulo 'Planificación Insumos' (pli-planificacion) verificado: visible.");
} catch (e) {
  console.error('[ORG] Error ensureModuloPli:', e.message);
}
