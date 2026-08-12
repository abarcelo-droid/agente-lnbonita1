// LOS RUBROS DESACTIVADOS QUE NO SIRVEN A NADIE
//
// Hasta ahora, "eliminar" una sección o un título no las eliminaba: las ponía en
// activo = 0. Quedaban en la base, invisibles en la pantalla, y con SU CÓDIGO
// TOMADO PARA SIEMPRE. Después alguien quería usar ese código y el sistema lo
// rechazaba por algo que no podía ver ni recuperar.
//
// Lo dijo el dueño y tiene razón: "los rubros contables deben existir o no
// existir; no tiene sentido que estén desactivados ocupando un rubro". Una
// sección es estructura, no historia: no hay ningún asiento que dependa de ella.
//
// Los DELETE ya borran de verdad. Esto limpia lo que quedó de antes.
//
// ── QUÉ SE BORRA, Y QUÉ NO ─────────────────────────────────────────────────
// Sólo secciones y títulos que están DESACTIVADOS y COMPLETAMENTE VACÍOS: sin un
// título ni una cuenta colgando, activa o desactivada. Si algo apunta ahí, no se
// toca: borrar el padre dejaría al hijo huérfano.
//
// LAS CUENTAS NO SE TOCAN, y es a propósito. Una cuenta desactivada casi siempre
// lo está porque se usó en un asiento y no se puede borrar sin romper el libro.
// Ahí ocupar el código es correcto: esa cuenta existe en la historia. Distinguir
// cuál se usó y cuál no es tarea del botón de borrar, con el usuario mirando.
import db from "./db.js";

const PLANES = [
  ['sg_cuentas_secciones', 'sg_cuentas_titulos', 'sg_cuentas', 'San Gerónimo'],
  ['pa_cuentas_secciones', 'pa_cuentas_titulos', 'pa_cuentas', 'Puente Cordón'],
];

try {
  const existe = (t) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

  for (const [SEC, TIT, CTA, empresa] of PLANES) {
    if (!existe(SEC) || !existe(TIT) || !existe(CTA)) continue;

    // Títulos primero: si se borra un título vacío, su sección puede quedar
    // vacía y entrar en la vuelta de abajo. Al revés no funciona.
    const titsMuertos = db.prepare(`
      SELECT t.id, t.codigo, t.nombre FROM ${TIT} t
       WHERE t.activo = 0
         AND NOT EXISTS (SELECT 1 FROM ${CTA} c WHERE c.titulo_id = t.id)`).all();

    const secsMuertas = db.prepare(`
      SELECT s.id, s.codigo, s.nombre FROM ${SEC} s
       WHERE s.activo = 0
         AND NOT EXISTS (SELECT 1 FROM ${TIT} t WHERE t.seccion_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM ${CTA} c WHERE c.seccion_id = s.id)`).all();

    if (!titsMuertos.length && !secsMuertas.length) continue;

    const delTit = db.prepare(`DELETE FROM ${TIT} WHERE id = ?`);
    const delSec = db.prepare(`DELETE FROM ${SEC} WHERE id = ?`);
    db.transaction(() => {
      for (const t of titsMuertos) delTit.run(t.id);
      // Se relee: puede haber secciones que recién ahora quedaron vacías.
      for (const s of db.prepare(`
        SELECT s.id FROM ${SEC} s
         WHERE s.activo = 0
           AND NOT EXISTS (SELECT 1 FROM ${TIT} t WHERE t.seccion_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM ${CTA} c WHERE c.seccion_id = s.id)`).all()) {
        delSec.run(s.id);
      }
    })();

    const codigos = [...secsMuertas, ...titsMuertos].map(x => x.codigo).sort();
    console.log(`[PLAN] ${empresa}: se liberaron ${codigos.length} código(s) que estaban ` +
                `tomados por rubros desactivados y vacíos: ${codigos.slice(0, 12).join(', ')}` +
                (codigos.length > 12 ? '…' : ''));
  }

  // Los que NO se pudieron liberar: se avisan por nombre para poder resolverlos
  // a mano. Quedarse callado sería repetir el problema que esto arregla.
  for (const [SEC, TIT, CTA, empresa] of PLANES) {
    if (!existe(SEC)) continue;
    const trabados = db.prepare(`
      SELECT s.codigo, s.nombre,
             (SELECT COUNT(*) FROM ${TIT} t WHERE t.seccion_id = s.id) tits,
             (SELECT COUNT(*) FROM ${CTA} c WHERE c.seccion_id = s.id) ctas
        FROM ${SEC} s WHERE s.activo = 0`).all();
    if (trabados.length) {
      console.warn(`[PLAN] ${empresa}: ${trabados.length} sección(es) siguen desactivadas ` +
                   `porque tienen algo colgando: ` +
                   trabados.map(t => `${t.codigo} (${t.tits} tít., ${t.ctas} ctas.)`).join(', '));
    }
  }
} catch (e) {
  console.error('[PLAN] Error limpiando rubros desactivados:', e.message);
}

export default db;
