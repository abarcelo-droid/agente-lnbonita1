// Registro idempotente de los modulos San Geronimo (Abasto SG) en el sidebar.
// El seed de db_org.js solo corre con tabla vacia; este bloque corre siempre.
//
// San Geronimo se separo de "tabs horizontales" a 6 MODULOS independientes
// (Dashboard / Compras / Stock / Ventas / Catalogo / Reportes), cada uno con su
// propia entrada de sidebar (data-sec="sg-<x>") y su seccion #sec-sg-<x> en panel.html.
// Quedan granulares para poder asignarles permisos finos por modulo en Fase 3.
import db from "./db.js";

// modulo (= data-sec en panel.html) | label | orden. Dashboard primero.
const MODULOS_SG = [
  ["sg-dashboard", "Dashboard", 650],
  ["sg-compras",   "Compras",   651],
  ["sg-stock",     "Stock",     652],
  ["sg-ventas",    "Ventas",    653],
  ["sg-catalogo",  "Catalogo",  654],
  ["sg-reportes",  "Reportes",  655],
];

try {
  const sg = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE ?").get("San Ger%");
  if (sg) {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)"
    );
    for (const [modulo, label, orden] of MODULOS_SG) {
      ins.run(modulo, label, "Abasto SG", sg.id, "operativo", orden);
    }
    // Legacy: el modulo monolitico "sg" (tabs horizontales) ya no tiene entrada en el
    // sidebar; se elimina para no ensuciar Config Modulos. Solo borra la fila huerfana.
    db.prepare("DELETE FROM modulos_config WHERE modulo='sg'").run();
    console.log("[ORG] Modulos Abasto SG verificados (6 modulos; legacy 'sg' removido)");
  } else { console.warn("[ORG] ensureModuloSG: sociedad no encontrada"); }

  // ── Renombres "Gestion Insumos" (ex "Abasto IFCO") — solo labels, idempotente ──
  // El seed de db_org.js no se actualiza en DBs ya seedeadas; estos UPDATE corren
  // siempre (post-seed, porque db_org.js importa este archivo al final). NO toca rutas,
  // endpoints ni ifco.js: solo los textos visibles en modulos_config.
  db.prepare("UPDATE modulos_config SET grupo='Gestión Insumos' WHERE grupo='Abasto IFCO'").run();
  db.prepare("UPDATE modulos_config SET label='Galpones Asociados' WHERE modulo='ab-proveedores'").run();
  db.prepare("UPDATE modulos_config SET label='Liquidaciones' WHERE modulo='ab-liquidaciones'").run();
  console.log("[ORG] Labels Gestion Insumos verificados (grupo + Galpones Asociados + Liquidaciones)");
} catch (e) { console.error("[ORG] Error ensureModuloSG:", e.message); }
