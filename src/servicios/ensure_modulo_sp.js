// Registro idempotente del módulo "Órdenes de Pago — Seguimiento" en modulos_config.
//
// POR QUÉ EXISTE: el seed de db_org.js hace `if (n > 0) return`, o sea que solo
// corre con la tabla vacía. Agregar una fila a ese array no hace nada en una base
// que ya tiene datos — es decir, en producción. Esto corre SIEMPRE (db_org.js lo
// importa al final), así que el módulo queda registrado y aparece en el sidebar.
// Mismo patrón que ensure_modulo_actividad.js / _personal.js / _sg.js / _pli.js.
//
// DÓNDE VA EN EL MENÚ: en "Administración de Compras" de San Gerónimo, con el
// resto del circuito de compra. Antes estaba en "Gestión Insumos", que es de otro
// mundo (IFCOs), y ahí no lo encontraba nadie.
//
// OJO CON EL UPDATE DE ABAJO: forzaba `grupo` en CADA arranque. Cuando se
// reordenó el menú de San Gerónimo desde ensure_modulo_sg.js, este archivo se lo
// devolvía al grupo viejo en el arranque siguiente — dos archivos peleándose por
// la misma fila, y el que corría último ganaba. Ahora el UPDATE NO toca `grupo`:
// la ubicación en el menú la decide ensure_modulo_sg.js, en un solo lugar. Acá
// sólo se garantiza que la fila exista, tenga su empresa y no esté oculta.
import db from './db.js';

try {
  const soc = db.prepare("SELECT id FROM sociedades WHERE nombre = 'San Gerónimo SA'").get()
           || db.prepare('SELECT id FROM sociedades ORDER BY id LIMIT 1').get();
  const socId = soc ? soc.id : null;

  db.prepare(
    'INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)'
  ).run('sp-pagos', '💸 Órdenes de Pago — Seguimiento', 'Administración de Compras', socId, 'operativo', 666);

  // Sin `grupo` ni `orden`: los pone ensure_modulo_sg.js, que es donde vive el
  // orden del menú de San Gerónimo completo.
  db.prepare(
    "UPDATE modulos_config SET sociedad_id = ?, oculto = 0 WHERE modulo = 'sp-pagos'"
  ).run(socId);

  console.log("[ORG] Módulo 'Órdenes de Pago — Seguimiento' (sp-pagos) verificado: visible.");
} catch (e) {
  console.error('[ORG] Error ensureModuloSp:', e.message);
}
