// Registro idempotente del modulo San Geronimo en el sidebar.
// El seed de db_org.js solo corre con tabla vacia; este bloque corre siempre.
import db from "./db.js";

try {
  const sg = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE ?").get("San Ger%");
  if (sg) {
    db.prepare("INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)").run("sg", "San Geronimo", "Abasto SG", sg.id, "operativo", 650);
    console.log("[ORG] Modulo sg verificado/insertado (grupo Abasto SG)");
  } else { console.warn("[ORG] ensureModuloSG: sociedad no encontrada"); }
} catch (e) { console.error("[ORG] Error ensureModuloSG:", e.message); }
