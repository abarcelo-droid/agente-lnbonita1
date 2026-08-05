// Registro idempotente del módulo "Planificación Financiera" en modulos_config.
//
// POR QUÉ EXISTE: el seed de db_org.js hace `if (n > 0) return`, o sea que solo
// corre con la tabla vacía. Agregar una fila a ese array no hace nada en una base
// que ya tiene datos — es decir, en producción. Esto corre SIEMPRE (db_org.js lo
// importa al final), así que el módulo queda registrado y aparece en el sidebar.
// Mismo patrón que ensure_modulo_sp.js / _pli.js / _sg.js.
//
// Va en el grupo "Financiero", que es donde ya viven Caja y Bancos y el resto de
// tesorería. Es un módulo de San Gerónimo.
//
// ACLARACIÓN SOBRE VISIBILIDAD: el sidebar NO filtra por permisos (GET
// /api/org/sidebar filtra solo por oculto=0, sin mirar rol ni secciones), así que
// dejar el módulo visible lo muestra a cualquier usuario autenticado. Lo que
// protege los datos es el guard de admin del router (rutas/fp.js), no esto: un no
// admin ve el ítem, entra y recibe 403 con un mensaje claro.
import db from './db.js';

try {
  const soc = db.prepare("SELECT id FROM sociedades WHERE nombre = 'San Gerónimo SA'").get()
           || db.prepare('SELECT id FROM sociedades ORDER BY id LIMIT 1').get();
  const socId = soc ? soc.id : null;

  db.prepare(
    'INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)'
  ).run('fp-flujo', '💹 Planificación Financiera', 'Financiero', socId, 'operativo', 760);

  // INSERT OR IGNORE no actualiza filas existentes: este UPDATE es el que
  // garantiza label, grupo y visibilidad en cada arranque.
  db.prepare(
    "UPDATE modulos_config SET label='💹 Planificación Financiera', grupo='Financiero', sociedad_id=?, oculto=0 WHERE modulo='fp-flujo'"
  ).run(socId);

  console.log("[ORG] Módulo 'Planificación Financiera' (fp-flujo) verificado: visible.");
} catch (e) {
  console.error('[ORG] Error ensureModuloFp:', e.message);
}
