// Registro idempotente del módulo "Consumo de IA" en modulos_config.
//
// El seed de db_org.js hace `if (n > 0) return`: sólo corre con la tabla VACÍA, o sea que
// agregar una fila a ese array no hace nada en producción. Esto corre SIEMPRE.
//
// EL NOMBRE DEL MÓDULO ES TAMBIÉN EL data-sec Y EL id DE LA SECCIÓN:
//   modulos_config.modulo   →  'ia-uso'
//   <div class="ni" data-sec="ia-uso">     (el puente, dentro de <nav>)
//   <div class="sec" id="sec-ia-uso">      (la pantalla)
//
// VA EN CONFIGURACIÓN Y NO EN UN ÁREA OPERATIVA. Es gasto de la empresa, no el trabajo
// del día: el que carga un remito no necesita saber cuánto cuesta leerlo, y mostrárselo
// lo único que hace es invitarlo a no usar el lector. El endpoint además exige admin.
import db from './db.js';

try {
  const soc = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE '%Ger%nimo%'").get()
           || db.prepare('SELECT id FROM sociedades ORDER BY id LIMIT 1').get();
  const socId = soc ? soc.id : null;

  db.prepare(
    'INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)'
  ).run('ia-uso', '⚡ Consumo de IA', 'Configuración', socId, 'operativo', 940);

  db.prepare(
    "UPDATE modulos_config SET label='⚡ Consumo de IA', grupo='Configuración', oculto=0 WHERE modulo='ia-uso'"
  ).run();

  console.log("[ORG] Módulo 'Consumo de IA' (ia-uso) verificado: visible.");
} catch (e) {
  console.error('[ORG] ensure_modulo_ia_uso:', e.message);
}
