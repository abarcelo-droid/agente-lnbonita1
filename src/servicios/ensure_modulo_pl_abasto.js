// Registro idempotente del módulo "P&L Abasto" en modulos_config.
//
// POR QUÉ EXISTE ESTE ARCHIVO: el seed de db_org.js hace `if (n > 0) return`, o sea que sólo
// corre con la tabla VACÍA. Esto corre SIEMPRE (db_org.js lo importa al final, post-seed).
// Mismo patrón que ensure_modulo_informes.js / _share.js.
//
// data-sec = 'pl-abasto': el puente del nav y la sección #sec-pl-abasto viven en panel.html.
//
// Pablo, 12/9/2026: «dentro de Informes vamos a agregar un submódulo que se llama P&L
// Abasto». El único grupo «Informes» del menú es el de San Gerónimo, donde viven las
// pantallas de Abasto: cuelga de esa sociedad. Si no está, de la primera, para que el
// módulo quede registrado igual.
//
// EL NIVEL DECIDE QUÉ SE PUEDE HACER: 'ver' mira el cuadro; subir el libro diario y guardar
// los rubros pide 'operar' (exigirNivel, por /api/pl-abasto).
import db from './db.js';

try {
  const soc = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE '%Ger%nimo%'").get()
           || db.prepare('SELECT id FROM sociedades ORDER BY id LIMIT 1').get();
  const socId = soc ? soc.id : null;

  db.prepare(
    'INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)'
  ).run('pl-abasto', '📊 P&L Abasto', 'Informes', socId, 'numero', 682);

  // UPDATE que corre SIEMPRE: garantiza label/grupo/sociedad/visible aunque el módulo ya
  // estuviera registrado con otros valores de una corrida anterior.
  db.prepare(
    "UPDATE modulos_config SET label='📊 P&L Abasto', grupo='Informes', sociedad_id=?, oculto=0 WHERE modulo='pl-abasto'"
  ).run(socId);

  console.log("[ORG] Módulo 'P&L Abasto' (pl-abasto) verificado: visible.");
} catch (e) {
  console.error('[ORG] ensure_modulo_pl_abasto:', e.message);
}
