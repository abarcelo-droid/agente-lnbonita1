// Registro idempotente de los modulos PERSONAL (Puente Cordon) en el sidebar.
// El seed de db_org.js solo corre con tabla vacia; este bloque corre siempre.
//
// Personal se separo de "tabs horizontales" (una sola seccion #sec-pa-personal con
// 14 sub-tabs) a 6 MODULOS independientes, cada uno con su entrada de sidebar
// (data-sec="personal-<x>") y su seccion #sec-personal-<x> en panel.html. Mismo
// patron que Abasto SG. Quedan granulares para asignarles permisos finos en Fase 3;
// por ahora todos admin-only (data-admin-only en el sidebar).
import db from "./db.js";

// modulo (= data-sec en panel.html) | label | orden.
const MODULOS_PERSONAL = [
  ["personal-padron",     "Personal",          660],
  ["personal-asistencia", "Asistencia Diaria", 661],
  ["personal-valorizar",  "Por valorizar",     662],
  ["personal-cc",         "Cuenta Corriente",  663],
  ["personal-catalogo",   "Catalogo",          664],
  ["personal-reportes",   "Reportes",          665],
  // "personal-tarifas" se mudó a un sub-tab dentro de "Por valorizar" (ya no es
  // modulo de sidebar). Se elimina abajo de modulos_config para no ensuciar Config Modulos.
];

try {
  const pc = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE ?").get("Puente%");
  if (pc) {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)"
    );
    for (const [modulo, label, orden] of MODULOS_PERSONAL) {
      ins.run(modulo, label, "Personal", pc.id, "operativo", orden);
    }
    // Legacy: el modulo monolitico "pa-personal" (tabs horizontales) ya no tiene entrada
    // en el sidebar; se elimina para no ensuciar Config Modulos.
    db.prepare("DELETE FROM modulos_config WHERE modulo='pa-personal'").run();
    // 'personal-tarifas' se mudó a sub-tab de "Por valorizar": ya no va en el sidebar.
    db.prepare("DELETE FROM modulos_config WHERE modulo='personal-tarifas'").run();
    console.log("[ORG] Modulos Personal verificados (6 modulos; legacy 'pa-personal' y 'personal-tarifas' removidos)");
  } else { console.warn("[ORG] ensureModuloPersonal: sociedad Puente Cordon no encontrada"); }
} catch (e) { console.error("[ORG] Error ensureModuloPersonal:", e.message); }
