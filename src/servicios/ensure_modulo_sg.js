// Registro idempotente de los modulos San Geronimo (Abasto SG) en el sidebar.
// El seed de db_org.js solo corre con tabla vacia; este bloque corre siempre.
//
// San Geronimo se separo de "tabs horizontales" a 6 MODULOS independientes
// (Dashboard / Compras / Stock / Ventas / Catalogo / Reportes), cada uno con su
// propia entrada de sidebar (data-sec="sg-<x>") y su seccion #sec-sg-<x> en panel.html.
// Quedan granulares para poder asignarles permisos finos por modulo en Fase 3.
import db from "./db.js";

// modulo (= data-sec en panel.html) | label | orden. Dashboard primero.
// El emoji VA en el label: sidebar-v2 no mapea iconos para sg-* (usa el emoji inicial del label).
const MODULOS_SG = [
  ["sg-dashboard",  "📊 Dash",            650],
  ["sg-compras",    "📥 Ingresos",        651],
  // Gastos Variables: ex sub-tab "Gastos globales" de Compras, ahora modulo propio.
  // En el sidebar va al lado de Compras (HTML estatico); orden 656 = ultimo en Config Modulos.
  ["sg-gvariables", "💸 Gastos Variables", 656],
  ["sg-stock",      "📦 Stock",            652],
  // Reprocesos (#reproceso): decomiso parcial, transformacion de unidad y reproceso con
  // clasificacion. Modulo propio en el sidebar, debajo de Stock.
  ["sg-reprocesos", "🔄 Reprocesos",       658],
  ["sg-ventas",     "📤 Salidas",          653],
  ["sg-catalogo",   "🗂️ Maestros",         654],
  ["sg-reportes",   "📈 Informes",         655],
  // Gastos Directos (servicio con valorización diferida): Fletes de salida (Fase 1),
  // cargas/descargas y repasos (próximas fases). Modulo propio en el sidebar.
  ["sg-gastos-directos", "🧾 Gastos Directos", 657],
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

  // ── Labels Abasto SG (con emoji) — FIX: el sidebar real lo renderiza sidebar-v2.js desde
  // modulos_config (no el nav estatico de panel.html). El seed usa INSERT OR IGNORE → no
  // actualiza filas existentes en prod. Estos UPDATE corren SIEMPRE (idempotentes, no-op una vez
  // aplicados). El emoji va en el label (sidebar-v2 no mapea iconos para sg-*). Grupo no cambia.
  db.prepare("UPDATE modulos_config SET label='📊 Dash'     WHERE modulo='sg-dashboard'").run();
  db.prepare("UPDATE modulos_config SET label='📥 Ingresos' WHERE modulo='sg-compras'").run();
  db.prepare("UPDATE modulos_config SET label='📤 Salidas'  WHERE modulo='sg-ventas'").run();
  db.prepare("UPDATE modulos_config SET label='🗂️ Maestros' WHERE modulo='sg-catalogo'").run();
  db.prepare("UPDATE modulos_config SET label='📈 Informes' WHERE modulo='sg-reportes'").run();
  db.prepare("UPDATE modulos_config SET label='📦 Stock'            WHERE modulo='sg-stock'").run();
  db.prepare("UPDATE modulos_config SET label='🔄 Reprocesos'       WHERE modulo='sg-reprocesos'").run();
  db.prepare("UPDATE modulos_config SET label='💸 Gastos Variables' WHERE modulo='sg-gvariables'").run();
  db.prepare("UPDATE modulos_config SET label='🧾 Gastos Directos'  WHERE modulo='sg-gastos-directos'").run();
  console.log("[ORG] Labels Abasto SG (con emoji) verificados en modulos_config");
} catch (e) { console.error("[ORG] Error ensureModuloSG:", e.message); }
