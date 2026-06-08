// Registro idempotente del módulo "Actividad Usuarios" (panel admin de adopción) en
// modulos_config. El seed de db_org.js solo corre con la tabla vacía; esto corre SIEMPRE
// (db_org.js lo importa al final, post-seed). Así la sección queda registrada → aparece en
// Config Módulos (agrupada por sociedad, bajo FAMILIA) y accesible con 🔗 Abrir.
//
// data-sec = 'admin-actividad' (el ítem del nav y la sección #sec-admin-actividad ya existen
// en panel.html, PR andy/feat-admin-actividad). Acá solo se registra/normaliza la config.
import db from "./db.js";

try {
  const fam = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE ?").get("Familia%");
  const famId = fam ? fam.id : null;

  // Alta idempotente (no pisa si ya existe). sociedad = FAMILIA, tipo 'sistema' (solo Directivo/
  // admin), visible (oculto=0 por default de la columna).
  db.prepare(
    "INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)"
  ).run('admin-actividad', 'Actividad Usuarios', 'Administración', famId, 'sistema', 920);

  // UPDATE que corre SIEMPRE: garantiza label/sociedad/visible aunque ya estuviera registrado
  // con oculto=1 u otra sociedad/label (lo pedido por Andy).
  db.prepare(
    "UPDATE modulos_config SET label='Actividad Usuarios', grupo='Administración', sociedad_id=?, oculto=0 WHERE modulo='admin-actividad'"
  ).run(famId);

  console.log("[ORG] Módulo 'Actividad Usuarios' (admin-actividad) verificado: FAMILIA, visible.");
} catch (e) {
  console.error("[ORG] Error ensureModuloActividad:", e.message);
}
