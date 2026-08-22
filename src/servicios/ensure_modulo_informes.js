// Registro idempotente del módulo "Informes comerciales" en modulos_config.
//
// POR QUÉ EXISTE ESTE ARCHIVO: el seed de db_org.js hace `if (n > 0) return`, o sea que
// sólo corre con la tabla VACÍA. Agregar una fila al array de ese seed no hace nada en una
// base que ya tiene datos — es decir, en producción. Esto corre SIEMPRE (db_org.js lo
// importa al final, post-seed), así que el módulo queda registrado y aparece en el sidebar
// y en Config Módulos. Mismo patrón que ensure_modulo_pli.js / _personal.js / _sg.js.
//
// data-sec = 'informes-comercial': el ítem del nav y la sección #sec-informes-comercial
// viven en panel.html.
//
// EL NIVEL DECIDE QUÉ SE VE. 'ver' alcanza para volumen y facturación; el margen pide
// 'operar' o más (ver rutas/informes.js). Se resuelve con el nivel del módulo y no con un
// permiso aparte porque es exactamente para lo que la escalera de niveles existe.
import db from './db.js';

try {
  const soc = db.prepare("SELECT id FROM sociedades WHERE nombre = 'Puente Cordón SA'").get()
           || db.prepare("SELECT id FROM sociedades WHERE funcion = 'productiva' ORDER BY id LIMIT 1").get();
  const socId = soc ? soc.id : null;

  // Alta idempotente (no pisa si ya existe).
  db.prepare(
    'INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)'
  ).run('informes-comercial', 'Informes comerciales', 'Comercial', socId, 'operativo', 610);

  // UPDATE que corre SIEMPRE: garantiza label/grupo/sociedad/visible aunque el módulo ya
  // estuviera registrado con oculto=1 u otros valores de una corrida anterior.
  db.prepare(
    "UPDATE modulos_config SET label='Informes comerciales', grupo='Comercial', sociedad_id=?, oculto=0 WHERE modulo='informes-comercial'"
  ).run(socId);

  console.log("[ORG] Módulo 'Informes comerciales' (informes-comercial) verificado: visible.");
} catch (e) {
  console.error('[ORG] ensure_modulo_informes:', e.message);
}
