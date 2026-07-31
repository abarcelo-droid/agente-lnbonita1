// src/servicios/db_ot.js
// ── ÓRDENES DE TRABAJO (servicios de terceros sobre lotes) ─────────────────
// Una OT documenta que un proveedor externo (ej: EL GRANADINO SRL) viene a
// hacer una tarea (ej: ARMAR CAMAS) sobre uno o más lotes, por un monto total
// que se prorratea entre los lotes según hectáreas.
//
// NO toca pa_ordenes (Orden de Aplicación) ni el plan de cuentas: solo lee
// pa_lotes, pa_campañas, adm_proveedores y pa_cuentas.
//
// sociedad_id es obligatorio y transversal: toda OT nace dentro de una sociedad
// y el correlativo `numero` es por sociedad.

import db from './db.js';
import './db_org.js';   // garantiza que `sociedades` exista y esté sembrada

// Catálogo de tareas. Editable por admin desde la UI (alta + baja lógica).
db.exec(`
  CREATE TABLE IF NOT EXISTS pa_tareas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre      TEXT NOT NULL,
    activo      INTEGER NOT NULL DEFAULT 1,
    sociedad_id INTEGER REFERENCES sociedades(id),
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(nombre, sociedad_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pa_tareas_soc ON pa_tareas(sociedad_id);

  -- Cabecera de la orden de trabajo.
  -- campania / temporada guardan ids de pa_campañas (anual / estacional), con los
  -- mismos selectores que Orden de Aplicación.
  CREATE TABLE IF NOT EXISTS pa_ordenes_trabajo (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    numero          INTEGER NOT NULL,
    fecha           TEXT NOT NULL,
    campania        INTEGER REFERENCES pa_campañas(id),
    temporada       INTEGER REFERENCES pa_campañas(id),
    proveedor_id    INTEGER NOT NULL REFERENCES adm_proveedores(id),
    tarea_id        INTEGER REFERENCES pa_tareas(id),
    tarea_otra      TEXT,
    cuenta_gasto_id INTEGER REFERENCES pa_cuentas(id),
    monto_total     REAL NOT NULL DEFAULT 0,
    observaciones   TEXT,
    estado          TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','ejecutada')),
    sociedad_id     INTEGER NOT NULL REFERENCES sociedades(id),
    usuario_id      INTEGER REFERENCES usuarios(id),
    activo          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(sociedad_id, numero)
  );
  CREATE INDEX IF NOT EXISTS idx_pa_ot_soc    ON pa_ordenes_trabajo(sociedad_id);
  CREATE INDEX IF NOT EXISTS idx_pa_ot_fecha  ON pa_ordenes_trabajo(fecha);
  CREATE INDEX IF NOT EXISTS idx_pa_ot_prov   ON pa_ordenes_trabajo(proveedor_id);
  CREATE INDEX IF NOT EXISTS idx_pa_ot_estado ON pa_ordenes_trabajo(estado);

  -- Detalle: lotes alcanzados por la orden, con las ha que se trabajan en cada
  -- uno y el monto que le toca por prorrateo.
  CREATE TABLE IF NOT EXISTS pa_ordenes_trabajo_lotes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    orden_id       INTEGER NOT NULL REFERENCES pa_ordenes_trabajo(id),
    lote_id        INTEGER NOT NULL REFERENCES pa_lotes(id),
    hectareas      REAL NOT NULL DEFAULT 0,
    monto_asignado REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_pa_ot_lotes_orden ON pa_ordenes_trabajo_lotes(orden_id);
  CREATE INDEX IF NOT EXISTS idx_pa_ot_lotes_lote  ON pa_ordenes_trabajo_lotes(lote_id);
`);

// ── Seed del catálogo de tareas ─────────────────────────────────────────────
// Corre SIEMPRE con INSERT OR IGNORE (no el patrón "si la tabla está vacía",
// que en una DB ya sembrada nunca agregaría una tarea nueva del listado).
const TAREAS_SEED = [
  'ARMAR CAMAS',
  'DESMALEZADO',
  'PODA',
  'RALEO',
  'ATADO',
  'LIMPIEZA DE CANALES',
  'NIVELACION',
  'LABOREO',
  'COSECHA',
];

try {
  const pc = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE ?").get('Puente Cord%')
          || db.prepare("SELECT id FROM sociedades WHERE funcion = 'productiva' ORDER BY id LIMIT 1").get();
  const socId = pc ? pc.id : null;
  const ins = db.prepare('INSERT OR IGNORE INTO pa_tareas (nombre, sociedad_id) VALUES (?, ?)');
  db.transaction(() => { for (const t of TAREAS_SEED) ins.run(t, socId); })();
  console.log(`[OT] Catálogo de tareas verificado (${TAREAS_SEED.length} tareas base)`);
} catch (e) {
  console.error('[OT] Error sembrando pa_tareas:', e.message);
}

console.log('[OT] Schema de Órdenes de Trabajo inicializado');

export default db;
