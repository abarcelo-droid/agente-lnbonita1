// Registro idempotente del módulo "Contactos" en modulos_config.
//
// POR QUÉ EXISTE ESTE ARCHIVO: el seed de db_org.js hace `if (n > 0) return`, o sea que sólo
// corre con la tabla VACÍA. Agregar una fila al array de ese seed no hace nada en una base
// que ya tiene datos — es decir, en producción. Esto corre SIEMPRE (db_org.js lo importa al
// final, post-seed). Mismo patrón que ensure_modulo_share.js / _informes.js.
//
// EL NOMBRE DEL MÓDULO ES TAMBIÉN EL data-sec Y EL id DE LA SECCIÓN. No hay ningún mapa: es
// una convención de nombre atada en panel.html, donde se hace getElementById('sec-' + sec).
// Los tres tienen que coincidir string a string:
//
//   modulos_config.modulo   →  'contactos'
//   <div class="ni" data-sec="contactos">    (el puente, dentro de <nav>)
//   <div class="sec" id="sec-contactos">     (la pantalla)
//
// Si falta el puente, la pantalla abre EN BLANCO y sin error.
//
// EL NIVEL DECIDE QUÉ SE PUEDE HACER. 'ver' alcanza para buscar y leer la agenda; cargar un
// contacto o una charla pide 'operar'. Se resuelve con el nivel del módulo —el prefijo
// 'sg/contactos' está declarado en ensure_api_prefijos.js— y no con un permiso aparte.
import db from './db.js';

try {
  // La agenda es del área comercial de SAN GERÓNIMO. Si la sociedad no está, se cae a la
  // primera: el módulo tiene que quedar registrado igual, no desaparecer por una sociedad.
  const soc = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE '%Ger%nimo%'").get()
           || db.prepare('SELECT id FROM sociedades ORDER BY id LIMIT 1').get();
  const socId = soc ? soc.id : null;

  db.prepare(
    'INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)'
  ).run('contactos', '📇 Contactos', 'Comercial', socId, 'operativo', 605);

  // UPDATE que corre SIEMPRE: garantiza label/grupo/sociedad/visible aunque el módulo ya
  // estuviera registrado con oculto=1 u otros valores de una corrida anterior.
  db.prepare(
    "UPDATE modulos_config SET label='📇 Contactos', grupo='Comercial', sociedad_id=?, oculto=0 WHERE modulo='contactos'"
  ).run(socId);

  console.log("[ORG] Módulo 'Contactos' (contactos) verificado: visible.");
} catch (e) {
  console.error('[ORG] ensure_modulo_contactos:', e.message);
}
