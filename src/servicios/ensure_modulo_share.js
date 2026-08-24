// Registro idempotente del módulo "SHARE" en modulos_config.
//
// POR QUÉ EXISTE ESTE ARCHIVO: el seed de db_org.js hace `if (n > 0) return`, o sea que sólo
// corre con la tabla VACÍA. Agregar una fila al array de ese seed no hace nada en una base
// que ya tiene datos — es decir, en producción. Esto corre SIEMPRE (db_org.js lo importa al
// final, post-seed). Mismo patrón que ensure_modulo_informes.js / _pli.js / _sg.js.
//
// data-sec = 'share': el ítem del nav y la sección #sec-share viven en panel.html.
//
// EL NIVEL DECIDE QUÉ SE PUEDE HACER. 'ver' alcanza para mirar todas las pantallas; cargar un
// planning y corregir mapeos pide 'operar' o más (ver rutas/share.js). Se resuelve con el
// nivel del módulo y no con un permiso aparte porque es exactamente para lo que la escalera
// de niveles existe.
import db from './db.js';

try {
  // SHARE mide la participación de SAN GERONIMO en el CD de Carrefour, así que cuelga de la
  // sociedad de San Gerónimo. Si no está, se cae a la comercial y, en última instancia, a
  // nada: el módulo tiene que quedar registrado igual, no desaparecer por una sociedad.
  const soc = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE '%Ger%nimo%'").get()
           || db.prepare("SELECT id FROM sociedades WHERE nombre = 'Puente Cordón SA'").get()
           || db.prepare('SELECT id FROM sociedades ORDER BY id LIMIT 1').get();
  const socId = soc ? soc.id : null;

  db.prepare(
    'INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)'
  ).run('share', '🛒 SHARE Carrefour', 'Comercial', socId, 'operativo', 615);

  // UPDATE que corre SIEMPRE: garantiza label/grupo/sociedad/visible aunque el módulo ya
  // estuviera registrado con oculto=1 u otros valores de una corrida anterior.
  db.prepare(
    "UPDATE modulos_config SET label='🛒 SHARE Carrefour', grupo='Comercial', sociedad_id=?, oculto=0 WHERE modulo='share'"
  ).run(socId);

  console.log("[ORG] Módulo 'SHARE Carrefour' (share) verificado: visible.");
} catch (e) {
  console.error('[ORG] ensure_modulo_share:', e.message);
}
