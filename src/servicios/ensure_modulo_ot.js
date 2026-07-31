// Registro idempotente del módulo "Órdenes de Trabajo" (pa-ordenes-trabajo) en
// modulos_config. El seed de db_org.js solo corre con la tabla vacía; esto corre
// SIEMPRE (db_org.js lo importa al final, post-seed).
//
// El sidebar VISIBLE lo renderiza sidebar-v2.js desde modulos_config, así que sin
// esta fila el módulo no aparece aunque exista la sección en panel.html.
//
// Se ubica al lado de Órdenes de Aplicación: copia grupo/sociedad/orden de la fila
// de `pa-ordenes` (leída en runtime, no hardcodeada) para que queden juntos aunque
// el grupo se haya renombrado en producción. Con el mismo `orden`, el desempate del
// endpoint (ORDER BY orden ASC, label ASC) los deja contiguos.
import db from "./db.js";

try {
  const oa = db.prepare("SELECT grupo, sociedad_id, orden FROM modulos_config WHERE modulo = 'pa-ordenes'").get();

  const pc = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE ?").get("Puente Cord%");
  const grupo      = oa?.grupo ?? 'Producción';
  const sociedadId = oa?.sociedad_id ?? (pc ? pc.id : null);
  const orden      = oa?.orden ?? 511;

  db.prepare(
    "INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)"
  ).run('pa-ordenes-trabajo', 'Órdenes de Trabajo', grupo, sociedadId, 'operativo', orden);

  // UPDATE que corre SIEMPRE: si la fila ya existía (INSERT OR IGNORE no pisa),
  // garantiza que siga junto a Órdenes de Aplicación y visible.
  db.prepare(
    "UPDATE modulos_config SET label='Órdenes de Trabajo', grupo=?, sociedad_id=?, orden=?, oculto=0 WHERE modulo='pa-ordenes-trabajo'"
  ).run(grupo, sociedadId, orden);

  console.log(`[ORG] Módulo 'Órdenes de Trabajo' (pa-ordenes-trabajo) verificado en grupo '${grupo}'.`);
} catch (e) {
  console.error("[ORG] Error ensureModuloOT:", e.message);
}
