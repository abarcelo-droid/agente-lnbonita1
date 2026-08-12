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
  // Gastos Fijos del Período (ex "Gastos Variables" / "Gastos globales" de Compras): modulo propio.
  // CG1 (#505) los sacó del costo del lote → van a resultado, no se prorratean. Orden 656.
  ["sg-gvariables", "💸 Gastos Fijos", 656],
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
  // Importación (F1): cotizador standalone de embarque (costo neto por caja, margen proyectado).
  ["sg-importacion", "📥 Importación", 660],
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
  // (El label de Liquidaciones se fija más abajo, con emoji, junto al del resto
  // del menú de San Gerónimo. Acá se lo dejaba sin ícono y la línea de abajo se
  // lo volvía a poner: dos lugares para lo mismo.)
  console.log("[ORG] Labels Gestion Insumos verificados (grupo + Galpones Asociados + Liquidaciones)");

  // ── Mover Liquidaciones de "Gestion Insumos" a "Abasto SG" — solo ubicacion en el nav ──
  // El bloque de arriba (wildcard Abasto IFCO → Gestion Insumos) tocaba a ab-liquidaciones;
  // este UPDATE corre DESPUES para reubicarlo en el grupo SG. Idempotente (no-op una vez aplicado).
  // orden=659 lo deja al final del grupo Abasto SG (los sg-* van 650-658), no arriba de Dashboard.
  // NO toca rutas ni endpoints de Liquidaciones (liquidaciones.js): solo modulos_config.
  // (Antes acá se lo mandaba al grupo "Abasto SG". Esa línea quedó sin sentido
  // cuando el menú se reordenó más abajo: hacía el trabajo dos veces y dejaba en
  // el log un mensaje que decía un grupo que ya no existe.)

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
  db.prepare("UPDATE modulos_config SET label='💸 Gastos Fijos' WHERE modulo='sg-gvariables'").run();
  db.prepare("UPDATE modulos_config SET label='🧾 Gastos Directos'  WHERE modulo='sg-gastos-directos'").run();
  db.prepare("UPDATE modulos_config SET label='📄 Liquidaciones'      WHERE modulo='ab-liquidaciones'").run();
  // ── EL MENÚ DE SAN GERÓNIMO, ORDENADO POR CÓMO SE TRABAJA ────────────────
  // Antes había un solo grupo, "Abasto SG", con once pantallas apiladas en el
  // orden en que se fueron construyendo: Dash, Ingresos, Stock, Salidas,
  // Maestros, Informes, Gastos… Ese orden no lo entiende nadie que no haya
  // estado cuando se hicieron.
  //
  // Ahora se agrupan por circuito, que es como se usan de verdad:
  //   · Administración de VENTAS   — lo que sale: Stock, Salidas, Importación.
  //   · Administración de COMPRAS  — lo que entra y lo que se paga, de punta a
  //     punta: Maestros, Ingresos, los dos tipos de gasto, Reprocesos,
  //     Liquidaciones y el Seguimiento de Órdenes de Pago.
  //   · Informes                   — lo que se mira, no lo que se carga.
  //
  // El SEGUIMIENTO DE ÓRDENES DE PAGO se muda de "Gestión Insumos", donde estaba
  // por accidente. Ya era de San Gerónimo (misma sociedad_id), así que mudarlo es
  // sólo cambiarlo de grupo: no se le tocan permisos ni direcciones de API.
  //
  // El ORDEN de los grupos sale del `orden` de su primera pantalla —así los
  // arma /api/org/sidebar— por eso van en bloques de diez: 650, 660, 670.
  // Dejar huecos entre bloques es lo que permite insertar una pantalla nueva en
  // el medio sin renumerar todo.
  //
  // Idempotente: son UPDATE por módulo, no-op una vez aplicados. Y no borra el
  // grupo viejo: "Abasto SG" desaparece solo cuando se queda sin pantallas.
  const MENU_SG = [
    // grupo                          orden  módulo
    ['Administración de Ventas',      650,  'sg-stock'],
    ['Administración de Ventas',      651,  'sg-ventas'],
    ['Administración de Ventas',      652,  'sg-importacion'],

    ['Administración de Compras',     660,  'sg-catalogo'],
    ['Administración de Compras',     661,  'sg-compras'],
    ['Administración de Compras',     662,  'sg-gvariables'],
    ['Administración de Compras',     663,  'sg-gastos-directos'],
    ['Administración de Compras',     664,  'sg-reprocesos'],
    ['Administración de Compras',     665,  'ab-liquidaciones'],
    ['Administración de Compras',     666,  'sp-pagos'],

    ['Informes',                      670,  'sg-dashboard'],
    ['Informes',                      671,  'sg-reportes'],
  ];
  const mover = db.prepare('UPDATE modulos_config SET grupo = ?, orden = ? WHERE modulo = ?');
  let movidos = 0;
  db.transaction(() => {
    for (const [grupo, orden, modulo] of MENU_SG) movidos += mover.run(grupo, orden, modulo).changes;
  })();
  if (movidos) console.log(`[ORG] Menú de San Gerónimo reordenado: ${movidos} pantalla(s) en Ventas / Compras / Informes.`);

  // El emoji del label es el ícono en el sidebar (no hay mapa de íconos para
  // sg-*). Órdenes de Pago venía de otro grupo y no tenía: se le pone el mismo
  // que usa su propia pantalla, para que no quede como la única sin ícono.
  db.prepare("UPDATE modulos_config SET label='💸 Órdenes de Pago — Seguimiento' WHERE modulo='sp-pagos' AND label NOT LIKE '💸%'").run();

  console.log("[ORG] Labels Abasto SG (con emoji) verificados en modulos_config");
} catch (e) { console.error("[ORG] Error ensureModuloSG:", e.message); }
