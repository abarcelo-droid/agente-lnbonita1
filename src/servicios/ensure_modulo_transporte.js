// Registro idempotente del acceso al dashboard de Barceló Transporte.
//
// Es un módulo tipo 'externo': el panel NO dibuja esos números, solo lleva al
// sistema donde viven. El dashboard es una app propia de Transporte con login de
// Google, y esto no la toca en absoluto — es un link. Esa fue la decisión: no
// arriesgar nada del lado del dashboard, que hoy funciona bien.
//
// La URL vive en modulos_config.url (base), no acá: cambiarla no puede requerir un
// deploy. Arranca vacía y la carga un admin desde el panel; mientras esté vacía la
// sección lo dice en vez de mandar a una dirección rota.
//
// El seed de db_org.js solo corre con la tabla vacía; esto corre SIEMPRE
// (db_org.js lo importa al final, post-seed). Sin este archivo el módulo no
// aparecería nunca en las instalaciones que ya tienen datos, que son todas.
import db from "./db.js";

try {
  const bt = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE ?").get("Barcel%Transporte%");
  const btId = bt ? bt.id : null;

  db.prepare(
    "INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)"
  ).run('tr-dashboard', 'Dashboard Transporte', 'Barceló Transporte', btId, 'externo', 700);

  // Corre siempre: garantiza sociedad, grupo y visibilidad aunque ya estuviera
  // registrado con otros valores. NO toca la url — es dato cargado por el usuario.
  db.prepare(
    "UPDATE modulos_config SET label='Dashboard Transporte', grupo='Barceló Transporte', " +
    "sociedad_id=?, tipo='externo', oculto=0 WHERE modulo='tr-dashboard'"
  ).run(btId);

  console.log("[ORG] Módulo 'Dashboard Transporte' (tr-dashboard) verificado: BARCELÓ TRANSPORTE, externo.");
} catch (e) {
  console.error("[ORG] Error ensureModuloTransporte:", e.message);
}
