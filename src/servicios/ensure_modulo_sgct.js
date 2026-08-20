// Registro idempotente de las pantallas de CONTABILIDAD de San Gerónimo.
// El seed de db_org.js solo corre con la tabla vacía; este bloque corre siempre.
//
// San Gerónimo tenía sus 28 tablas contables (sg_*) y sus 31 endpoints en
// /api/sg/contable desde hace tiempo, pero NINGUNA pantalla y NINGUNA entrada de
// menú: motor sin tablero. Para el que usa el sistema, la contabilidad de San
// Gerónimo no existía.
//
// EL NOMBRE DEL MÓDULO ES TAMBIÉN EL data-sec Y EL id DE LA SECCIÓN. No hay
// ningún mapa: es una convención de nombre, atada en panel.html donde se hace
// getElementById('sec-' + sec). Los tres tienen que coincidir string a string:
//
//   modulos_config.modulo   →  'sgct-plan-cuentas'
//   <div class="ni" data-sec="sgct-plan-cuentas">   (el puente, dentro de <nav>)
//   <div class="sec" id="sec-sgct-plan-cuentas">    (la pantalla)
//
// Si falta el puente, la pantalla abre EN BLANCO y sin error. Si falta la
// sección, el panel entero queda en blanco (esa línea no tiene null-check).
import db from "./db.js";

// modulo | label | orden. Van juntos y después de las de Abasto SG.
// LAS ETIQUETAS LLEVAN "SG" A PROPOSITO. Puente Cordon tiene un "Plan de
// Cuentas" y un "Asientos" con ESE nombre exacto, y el sidebar le saca el emoji
// al label antes de mostrarlo: sin el sufijo, en el menu se leen idénticas.
//
// Asignarles la empresa no alcanza. Con el selector en "Todas" —que es el
// estado por defecto y nadie lo cambia— el menu muestra los modulos de todas,
// asi que las dos pantallas aparecen juntas. Y son libros distintos: una
// escribe en sg_cuentas y la otra en pa_cuentas. Un clic en la equivocada es
// media contabilidad en el lugar que no va.
const MODULOS_SGCT = [
  ["sgct-plan-cuentas", "📗 Plan de Cuentas SG", 670],
  ["sgct-asientos",     "📘 Asientos SG",        671],
  ["sgct-modelos",      "📐 Asientos Modelo SG", 672],
  // El libro de IVA compras: todas las facturas de compra contabilizadas,
  // vengan de donde vengan. Es de donde salen los datos del período y lo que
  // después hay que informar.
  ["sgct-iva-compras",  "🧾 Diario IVA Compras SG", 673],
  // Los puntos de venta estaban ESCRITOS A MANO en el HTML del panel: dar de
  // alta uno nuevo era tocar el código. Y con ellos van los datos de la
  // facturación electrónica —el certificado y su vencimiento—, que es lo que
  // hoy no está en ningún lado y se descubre el día que AFIP rechaza.
  ["sgct-puntos-venta", "🏪 Puntos de Venta SG", 674],
];

try {
  const sg = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE ?").get("San Ger%");
  if (sg) {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)"
    );
    let n = 0;
    for (const [modulo, label, orden] of MODULOS_SGCT) {
      n += ins.run(modulo, label, "Contabilidad SG", sg.id, "numero", orden).changes;
    }
    if (n) console.log(`[SGCT] ${n} pantalla(s) de Contabilidad SG registradas en el menú`);

    // El INSERT es OR IGNORE: no corrige el label de una fila que ya existe. Sin
    // esto, las instalaciones donde esta rama ya arrancó una vez se quedarían
    // con los nombres viejos —los que colisionan con los de Puente Cordón— para
    // siempre.
    const updLbl = db.prepare('UPDATE modulos_config SET label = ? WHERE modulo = ? AND label <> ?');
    let r = 0;
    for (const [modulo, label] of MODULOS_SGCT) r += updLbl.run(label, modulo, label).changes;
    if (r) console.log(`[SGCT] ${r} etiqueta(s) actualizadas para que no se confundan con las de Puente Cordón`);

    // ── LAS PANTALLAS adm-*/fin-* SON DE PUENTE CORDÓN ────────────────────
    // Una migración anterior (db_org.js, migrarContabilidadATodasLasEmpresas)
    // las dejó con sociedad_id = NULL, que significa "se ven en TODAS las
    // empresas". Tenía sentido cuando eran las únicas: cada empresa entraba a
    // la misma pantalla y veía sus propios datos.
    //
    // Ahora San Gerónimo tiene las suyas, y dejarlas en NULL le pone DOS
    // "Plan de Cuentas" y DOS "Asientos" en el mismo menú, con la etiqueta
    // idéntica —el sidebar le saca el emoji— y escribiendo en tablas
    // DISTINTAS: las de arriba en sg_cuentas/sg_asientos y las de abajo en
    // pa_cuentas/pa_asientos. El contador cargaría medio plan en cada una sin
    // ninguna señal de que son libros diferentes, y ningún balance cerraría.
    //
    // Se les pone la empresa que de verdad tienen: leen y escriben tablas pa_*,
    // así que son de Puente Cordón. Sólo se tocan las que están en NULL — si un
    // admin ya le asignó una empresa a mano, esa decisión es más nueva y manda.
    const PC = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE ?").get("Puente Cord%");
    if (PC) {
      const CONTABLES_PC = ['adm-asientos', 'adm-cc-proveedores', 'adm-modelos',
                            'adm-plan-cuentas', 'adm-proveedores',
                            'fin-caja-bancos', 'fin-ordenes-pago'];
      const upd = db.prepare(
        'UPDATE modulos_config SET sociedad_id = ? WHERE modulo = ? AND sociedad_id IS NULL');
      let m = 0;
      for (const mod of CONTABLES_PC) m += upd.run(PC.id, mod).changes;
      if (m) {
        console.log(`[SGCT] ${m} pantalla(s) contable(s) pasaron a Puente Cordón: operan sobre ` +
                    `tablas pa_*, y San Gerónimo ya tiene las suyas sobre sg_*.`);
      }
    }
  } else {
    console.warn("[SGCT] Sociedad San Gerónimo no encontrada — módulos contables NO registrados");
  }
} catch (e) {
  console.error("[SGCT] Error registrando los módulos de Contabilidad SG:", e.message);
}

export default db;
