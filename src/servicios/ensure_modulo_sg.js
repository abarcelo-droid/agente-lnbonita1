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
  ["sg-dashboard",  "Dashboard",        650],
  ["sg-compras",    "Compras",          651],
  // Gastos Variables: ex sub-tab "Gastos globales" de Compras, ahora modulo propio.
  // En el sidebar va al lado de Compras (HTML estatico); orden 656 = ultimo en Config Modulos.
  ["sg-gvariables", "Gastos Variables", 656],
  ["sg-stock",      "Stock",            652],
  ["sg-ventas",     "Ventas",           653],
  ["sg-catalogo",   "Catalogo",         654],
  ["sg-reportes",   "Reportes",         655],
  // Gastos Directos (servicio con valorización diferida): Fletes de salida (Fase 1),
  // cargas/descargas y repasos (próximas fases). Modulo propio en el sidebar.
  ["sg-gastos-directos", "Gastos Directos", 657],
];

// Finanzas SG: COPIA física de Contable/Ventas/Tesorería de PC (tablas sg_*),
// para que SG lleve su propia contabilidad/ventas/tesorería separada de PC.
// data-sec="sgf-<x>" + seccion #sec-sgf-<x> en panel.html; endpoints /api/sg/*.
// modulo | label | grupo | tipo | orden
const MODULOS_SG_FIN = [
  ["sgf-plan",     "Plan de Cuentas SG", "Contabilidad SG", "numero",    660],
  ["sgf-asientos", "Asientos SG",        "Contabilidad SG", "numero",    661],
  ["sgf-caja",     "Caja y Bancos SG",   "Financiero SG",   "numero",    665],
  ["sgf-clientes", "Clientes SG",        "Ventas SG",       "operativo", 670],
  ["sgf-cc",       "Ventas SG",          "Ventas SG",       "numero",    671],
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
    // Finanzas SG (copia física Contable/Ventas/Tesorería).
    for (const [modulo, label, grupo, tipo, orden] of MODULOS_SG_FIN) {
      ins.run(modulo, label, grupo, sg.id, tipo, orden);
    }
    // ── Neutralizar el ESPEJO de Ventas SG ────────────────────────────────────
    // Antes SG operaba Ventas sobre las tablas ven_* de PC vía el selector de
    // sociedad (filtro sociedad_id=SG). Ahora SG tiene su copia física (sgf-*),
    // así que se quitan los modulos espejo ven-* del menu de SG para que no haya
    // dos caminos a "Ventas SG". OJO: NO toca ab-* (IFCO / Galpones Asociados),
    // que siguen en uso productivo real.
    db.prepare(
      "DELETE FROM modulos_config WHERE sociedad_id = ? AND modulo IN ('ven-clientes','ven-facturas','ven-cobranzas','ven-cc','ven-liquidaciones')"
    ).run(sg.id);
    // Legacy: el modulo monolitico "sg" (tabs horizontales) ya no tiene entrada en el
    // sidebar; se elimina para no ensuciar Config Modulos. Solo borra la fila huerfana.
    db.prepare("DELETE FROM modulos_config WHERE modulo='sg'").run();
    console.log("[ORG] Modulos SG verificados (Abasto + Finanzas SG; espejo ven-* removido; legacy 'sg' removido)");
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
