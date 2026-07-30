// Registro idempotente del módulo "Órdenes de Pago — Seguimiento" en modulos_config.
//
// POR QUÉ EXISTE: el seed de db_org.js hace `if (n > 0) return`, o sea que solo
// corre con la tabla vacía. Agregar una fila a ese array no hace nada en una base
// que ya tiene datos — es decir, en producción. Esto corre SIEMPRE (db_org.js lo
// importa al final), así que el módulo queda registrado y aparece en el sidebar.
// Mismo patrón que ensure_modulo_actividad.js / _personal.js / _sg.js / _pli.js.
//
// Va en el grupo "Gestión Insumos" (el ex "Abasto IFCO", renombrado en
// ensure_modulo_sg.js), que es donde trabajan los compradores. Moverlo después es
// un UPDATE de una fila.
import db from './db.js';

try {
  const soc = db.prepare("SELECT id FROM sociedades WHERE nombre = 'San Gerónimo SA'").get()
           || db.prepare('SELECT id FROM sociedades ORDER BY id LIMIT 1').get();
  const socId = soc ? soc.id : null;

  db.prepare(
    'INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) VALUES (?,?,?,?,?,?)'
  ).run('sp-pagos', 'Órdenes de Pago — Seguimiento', 'Gestión Insumos', socId, 'operativo', 620);

  db.prepare(
    "UPDATE modulos_config SET label='Órdenes de Pago — Seguimiento', grupo='Gestión Insumos', sociedad_id=?, oculto=0 WHERE modulo='sp-pagos'"
  ).run(socId);

  console.log("[ORG] Módulo 'Órdenes de Pago — Seguimiento' (sp-pagos) verificado: visible.");
} catch (e) {
  console.error('[ORG] Error ensureModuloSp:', e.message);
}
