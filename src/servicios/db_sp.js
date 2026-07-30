// src/servicios/db_sp.js
// ── MÓDULO SP · SEGUIMIENTO DE ÓRDENES DE PAGO ────────────────────────────
// Circuito de SOLICITUD Y AUTORIZACIÓN previo a la emisión del pago.
//
// ALCANCE: es seguimiento. NO toca fin_ordenes_pago, no mueve saldos, no genera
// asientos. Cero efecto contable. El proveedor y la cuenta corriente se escriben
// como texto; los punteros a las tablas reales (proveedor_ref_id, op_id) quedan
// creados pero sin usar, para que el día que se una con el módulo financiero no
// haya que matchear por nombre a mano.
//
// SIN FOREIGN KEYS HACIA AFUERA: con foreign_keys=ON (db.js:22), una FK de sp_*
// hacia pa_compras o adm_proveedores haría FALLAR los DELETE de esos módulos en
// cuanto exista una fila nuestra apuntando ahí. Las FK duras son solo dentro de
// sp_*. Los punteros hacia afuera son INTEGER sin REFERENCES, igual que
// pli_insumos.insumo_ref_id.
//
// LAS TRES CAPAS (la decisión central del módulo):
//   GRAFO      — pasos, transiciones, autorizados, plantillas: los edita el
//                usuario desde el panel, sin deploy.
//   SEMÁNTICA  — estado_global, tipo, hito, modo_captura: enums CERRADOS en
//                código. Son las etiquetas estables con las que filtra el resto
//                del sistema, así renombrar un paso no rompe reportes.
//   EFECTOS    — validaciones, segregación de funciones, congelamiento,
//                numeración: código. Ninguna edición de la configuración los
//                puede desactivar.

import db from './db.js';
import './db_org.js';   // 'sociedades' tiene que existir antes de las FK

// ── DEFINICIÓN DEL CIRCUITO (configurable, versionada, inmutable al activarse) ──

db.exec(`
  CREATE TABLE IF NOT EXISTS sp_flujos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    clave           TEXT NOT NULL UNIQUE,        -- lo único que el código referencia por nombre
    nombre          TEXT NOT NULL,
    descripcion     TEXT,
    email_fallback  TEXT,                        -- a dónde avisar si un paso queda sin destinatarios
    activo          INTEGER NOT NULL DEFAULT 1,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );

  -- La unidad de inmutabilidad. Una solicitud se pinnea a una versión y termina
  -- con ella: es un contrato de proceso, se rige por las reglas vigentes cuando
  -- se inició.
  CREATE TABLE IF NOT EXISTS sp_flujo_versiones (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    flujo_id        INTEGER NOT NULL REFERENCES sp_flujos(id),
    version         INTEGER NOT NULL,
    estado          TEXT NOT NULL DEFAULT 'borrador'
                         CHECK(estado IN ('borrador','activa','archivada')),
    validacion_json TEXT,
    validada_en     TEXT,
    activada_en     TEXT,
    activada_por_id INTEGER,
    notas           TEXT,
    creado_en       TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(flujo_id, version)
  );
  -- Garantiza a nivel base que no haya dos versiones vigentes del mismo circuito.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sp_fv_una_activa
    ON sp_flujo_versiones(flujo_id) WHERE estado='activa';

  CREATE TABLE IF NOT EXISTS sp_pasos (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id           INTEGER NOT NULL REFERENCES sp_flujo_versiones(id),
    clave                TEXT NOT NULL,
    nombre               TEXT NOT NULL,           -- renombrable sin romper nada
    orden                INTEGER NOT NULL DEFAULT 0,   -- SOLO para dibujar; nunca decide el próximo paso
    tipo                 TEXT NOT NULL DEFAULT 'intermedio'
                              CHECK(tipo IN ('inicio','intermedio','final_ok','final_rechazo')),
    -- Etiqueta ESTABLE del paso. Es por acá que filtran los reportes, la
    -- segregación de funciones y la futura unión con el módulo financiero.
    hito                 TEXT CHECK(hito IN ('solicitud','autorizacion','fechas','confeccion','firma','comprobantes','cerrado')),
    -- Qué formulario dibuja el front y qué exige el backend al resolver el paso.
    modo_captura         TEXT NOT NULL DEFAULT 'aprueba'
                              CHECK(modo_captura IN ('aprueba','informa_fecha','confecciona','firma','envia_comprobantes')),
    sla_horas            INTEGER,
    requiere_comentario  INTEGER NOT NULL DEFAULT 0,
    requiere_adjunto_tipo TEXT,
    instrucciones        TEXT,
    permite_autoaprobacion INTEGER NOT NULL DEFAULT 0,   -- excepción explícita a solicitante != decisor
    UNIQUE(version_id, clave)
  );

  -- El grafo. Separar pasos de transiciones es lo que hace configurable el
  -- rechazo y la devolución: con una columna "orden" no se pueden expresar.
  CREATE TABLE IF NOT EXISTS sp_transiciones (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id           INTEGER NOT NULL REFERENCES sp_flujo_versiones(id),
    paso_desde_id        INTEGER NOT NULL REFERENCES sp_pasos(id),
    paso_hasta_id        INTEGER NOT NULL REFERENCES sp_pasos(id),
    accion               TEXT NOT NULL,           -- 'aprobar','devolver','rechazar','confirmar_fecha'...
    etiqueta             TEXT NOT NULL,           -- lo que dice el botón
    clase                TEXT NOT NULL DEFAULT 'avanza'
                              CHECK(clase IN ('avanza','devuelve','rechaza','espera')),
    requiere_comentario  INTEGER NOT NULL DEFAULT 0,
    -- Volver atrás invalida lo aprobado después: si el monto cambia, la
    -- autorización anterior ya no aplica.
    invalida_aprobaciones INTEGER NOT NULL DEFAULT 0,
    orden                INTEGER NOT NULL DEFAULT 0,
    UNIQUE(version_id, paso_desde_id, accion)
  );

  -- Quién puede resolver cada paso. Se guarda por REFERENCIA y se resuelve a
  -- usuarios en vivo en cada avance: si se congelaran las personas, el día que el
  -- supervisor se va de la empresa todas las solicitudes en vuelo quedan trabadas.
  CREATE TABLE IF NOT EXISTS sp_paso_autorizados (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    paso_id     INTEGER NOT NULL REFERENCES sp_pasos(id),
    tipo        TEXT NOT NULL CHECK(tipo IN ('usuario','rol','area','solicitante')),
    usuario_id  INTEGER,                          -- puntero blando a usuarios
    rol         TEXT,
    area_id     INTEGER,                          -- puntero blando a areas
    -- watcher = recibe el aviso pero NO puede resolver el paso
    watcher     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sp_pa_paso ON sp_paso_autorizados(paso_id);

  -- Plantillas de mail. Texto con placeholders {{...}}, no HTML libre: así nadie
  -- rompe el mail desde el configurador.
  CREATE TABLE IF NOT EXISTS sp_plantillas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id  INTEGER NOT NULL REFERENCES sp_flujo_versiones(id),
    clave       TEXT NOT NULL,                    -- 'paso:ok_supervisor' | 'evento:rechazo'
    asunto      TEXT NOT NULL,
    cuerpo      TEXT NOT NULL,
    UNIQUE(version_id, clave)
  );

  -- Pares de hitos que NO puede resolver la misma persona en la misma solicitud.
  -- fijo=1 no se puede borrar desde el configurador.
  CREATE TABLE IF NOT EXISTS sp_incompatibilidades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id  INTEGER NOT NULL REFERENCES sp_flujo_versiones(id),
    hito_a      TEXT NOT NULL,
    hito_b      TEXT NOT NULL,
    fijo        INTEGER NOT NULL DEFAULT 0,
    UNIQUE(version_id, hito_a, hito_b)
  );
`);

// ── INSTANCIA ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS sp_solicitudes (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    sociedad_id        INTEGER NOT NULL REFERENCES sociedades(id),
    numero             TEXT NOT NULL,                  -- SP-2026-0001
    flujo_version_id   INTEGER NOT NULL REFERENCES sp_flujo_versiones(id),
    -- El grafo aplanado al momento de nacer. El motor resuelve SIEMPRE contra
    -- esto: ni un bug de migración ni un borrado pueden dejar una solicitud sin
    -- circuito, y editar la configuración no cambia las que están en vuelo.
    def_snapshot_json  TEXT NOT NULL,
    solicitante_id     INTEGER NOT NULL,               -- puntero blando a usuarios
    solicitante_nombre TEXT,                           -- congelado: la historia no se reescribe
    -- Datos del pago. Texto libre a propósito: hoy no está conectado al sistema.
    proveedor_texto    TEXT NOT NULL,
    cuenta_texto       TEXT,
    concepto           TEXT NOT NULL,
    monto              REAL NOT NULL CHECK(monto > 0),
    moneda             TEXT NOT NULL DEFAULT 'ARS' CHECK(moneda IN ('ARS','USD')),
    comprobante_tipo   TEXT,
    comprobante_numero TEXT,
    fecha_necesidad    TEXT,                           -- cuándo se necesita pagado
    prioridad          TEXT NOT NULL DEFAULT 'normal'
                            CHECK(prioridad IN ('normal','urgente')),
    justificacion_duplicado TEXT,                      -- por qué se repite un comprobante
    -- Estado
    paso_actual_clave  TEXT NOT NULL,
    paso_actual_hito   TEXT,
    paso_actual_desde  TEXT,
    vence_en           TEXT,                           -- por el SLA del paso
    estado_global      TEXT NOT NULL DEFAULT 'en_curso'
                            CHECK(estado_global IN ('en_curso','aprobada_final','rechazada','cancelada')),
    fecha_pago_confirmada TEXT,                        -- la que informa Tesorería
    ciclo              INTEGER NOT NULL DEFAULT 1,     -- sube en cada devolución
    rev                INTEGER NOT NULL DEFAULT 0,     -- lock optimista
    -- Punteros blandos para la unión futura. SIN REFERENCES.
    proveedor_ref_id   INTEGER,
    op_id              INTEGER,
    notas              TEXT,
    creado_en          TEXT DEFAULT (datetime('now','localtime')),
    cerrado_en         TEXT,
    eliminado_en       TEXT,
    eliminado_por_id   INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sp_sol_numero ON sp_solicitudes(numero);
  CREATE INDEX IF NOT EXISTS idx_sp_sol_estado ON sp_solicitudes(sociedad_id, estado_global, paso_actual_clave);
  CREATE INDEX IF NOT EXISTS idx_sp_sol_solic ON sp_solicitudes(solicitante_id);

  -- Historial. El estado actual dice DÓNDE está; esto dice CÓMO llegó, y es lo
  -- que permite reconstruir quién autorizó qué. Nunca se borra ni se edita.
  CREATE TABLE IF NOT EXISTS sp_eventos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    solicitud_id  INTEGER NOT NULL REFERENCES sp_solicitudes(id),
    seq           INTEGER NOT NULL,
    paso_desde    TEXT,
    paso_hasta    TEXT,
    accion        TEXT NOT NULL,
    hito          TEXT,                                -- hito del paso que se resolvió
    clase         TEXT,
    actor_id      INTEGER,
    actor_nombre  TEXT,                                -- congelado
    actor_rol     TEXT,                                -- congelado
    comentario    TEXT,
    datos_json    TEXT,
    via           TEXT NOT NULL DEFAULT 'panel',       -- panel | admin | sistema
    creado_en     TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(solicitud_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_sp_ev_sol ON sp_eventos(solicitud_id, seq);

  CREATE TABLE IF NOT EXISTS sp_adjuntos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    solicitud_id  INTEGER NOT NULL REFERENCES sp_solicitudes(id),
    storage_key   TEXT NOT NULL,
    nombre        TEXT NOT NULL,
    mime          TEXT,
    tamano        INTEGER,
    tipo          TEXT NOT NULL DEFAULT 'otro'
                       CHECK(tipo IN ('factura','comprobante_pago','orden','otro')),
    creado_en     TEXT DEFAULT (datetime('now','localtime')),
    creado_por_id INTEGER,
    eliminado_en  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sp_adj_sol ON sp_adjuntos(solicitud_id);

  -- Cola de salida de mails. El envío NO puede ir dentro de la transacción que
  -- cambia el estado: enviarMail es async y better-sqlite3 no acepta una función
  -- async dentro de db.transaction() (tira TypeError). Y sin cola no hay forma de
  -- saber si el aviso salió: la solicitud quedaría esperando a alguien que nunca
  -- se enteró.
  CREATE TABLE IF NOT EXISTS sp_outbox (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    solicitud_id  INTEGER REFERENCES sp_solicitudes(id),
    evento_id     INTEGER,
    dedup_key     TEXT NOT NULL,                       -- evita mandar dos veces el mismo aviso
    destinatarios TEXT NOT NULL,                       -- congelados: la historia no se reescribe
    asunto        TEXT NOT NULL,
    cuerpo_texto  TEXT NOT NULL,
    estado        TEXT NOT NULL DEFAULT 'pendiente'
                       CHECK(estado IN ('pendiente','enviado','error','descartado')),
    intentos      INTEGER NOT NULL DEFAULT 0,
    ultimo_error  TEXT,
    message_id    TEXT,
    creado_en     TEXT DEFAULT (datetime('now','localtime')),
    enviado_en    TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sp_outbox_dedup ON sp_outbox(dedup_key);
  CREATE INDEX IF NOT EXISTS idx_sp_outbox_pend ON sp_outbox(estado, intentos);
`);

// ── MIGRACIONES IDEMPOTENTES ──────────────────────────────────────────────
// Molde de db_pa.js: PRAGMA table_info + ALTER guardado. Nunca throw en el
// top-level, que tumbaría el arranque de todo el server.
function addCol(tabla, col, def) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name);
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${def}`);
      console.log(`[SP] Columna ${col} agregada en ${tabla}`);
    }
  } catch (e) {
    console.error(`[SP] Error agregando ${col} en ${tabla}:`, e.message);
  }
}

try {
  // Cuerpo HTML del aviso. Va aparte del texto porque los botones de acción los
  // arma el sistema y no la plantilla editable: si el HTML fuera configurable, un
  // error de tipeo rompería el mail de todo el circuito.
  addCol('sp_outbox', 'cuerpo_html', 'TEXT');
  // A quién le pide el OK el solicitante. Puntero blando a usuarios, SIN
  // REFERENCES. Dirige el AVISO, no el permiso: cualquier habilitado del paso
  // sigue pudiendo resolver, así el pedido no se traba si el elegido no está.
  addCol('sp_solicitudes', 'autorizador_id', 'INTEGER');
} catch (e) {
  console.error('[SP] Error en migraciones:', e.message);
}

// ── SEED: el circuito de 6 pasos ──────────────────────────────────────────
// Corre solo si sp_flujos está vacía. Los autorizados arrancan como rol='admin'
// en todos los pasos para que funcione el día 1; después se ajustan desde el
// configurador. El paso inicio lleva además tipo='solicitante', que es lo que le
// permite al comprador mandar SU solicitud.

function seed() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM sp_flujos').get().n;
  if (n > 0) return;

  const PASOS = [
    // clave, nombre, orden, tipo, hito, modo_captura, sla, req_com, req_adj, instrucciones
    ['solicitud',    'Solicitud del comprador', 1, 'inicio',        'solicitud',    'aprueba',            null, 0, null,
      'Cargá los datos del pago y enviá la solicitud. Vas a poder seguir el estado desde "Mis solicitudes".'],
    ['ok_supervisor','OK del supervisor',       2, 'intermedio',    'autorizacion', 'aprueba',            24,   0, null,
      'Revisá proveedor, cuenta, monto y concepto. Si algo no cierra, devolvé al comprador con el motivo.'],
    ['fechas',       'Fechas de pago',          3, 'intermedio',    'fechas',       'informa_fecha',      48,   0, null,
      'Informá la fecha en que se va a pagar. Si todavía no hay fondos, dejalo en espera con el motivo.'],
    ['confeccion',   'Confección de la orden',  4, 'intermedio',    'confeccion',   'confecciona',        24,   0, null,
      'Confeccioná la orden de pago y adjuntala si corresponde.'],
    ['firma',        'Firma',                   5, 'intermedio',    'firma',        'firma',              24,   0, null,
      'Firmá la orden. No podés firmar una orden que confeccionaste vos.'],
    ['comprobantes', 'Envío de comprobantes',   6, 'intermedio',    'comprobantes', 'envia_comprobantes', 48,   0, null,
      'Mandale el comprobante al proveedor. Podés adjuntarlo o declarar que lo enviaste por otro medio.'],
    ['cerrada',      'Cerrada',                 7, 'final_ok',      'cerrado',      'aprueba',            null, 0, null, null],
    ['rechazada',    'Rechazada',               8, 'final_rechazo', null,           'aprueba',            null, 0, null, null]
  ];

  // desde, accion, hasta, etiqueta, clase, req_comentario, invalida
  const TRANS = [
    ['solicitud',     'enviar',            'ok_supervisor', 'Enviar a autorizar',    'avanza',   0, 0],
    ['ok_supervisor', 'aprobar',           'fechas',        'Autorizar',             'avanza',   0, 0],
    ['ok_supervisor', 'devolver',          'solicitud',     'Devolver al comprador', 'devuelve', 1, 1],
    ['ok_supervisor', 'rechazar',          'rechazada',     'Rechazar',              'rechaza',  1, 0],
    ['fechas',        'confirmar_fecha',   'confeccion',    'Confirmar fecha',       'avanza',   0, 0],
    ['fechas',        'sin_fecha',         'fechas',        'Todavía sin fecha',     'espera',   1, 0],
    ['fechas',        'devolver',          'ok_supervisor', 'Devolver',              'devuelve', 1, 0],
    ['fechas',        'rechazar',          'rechazada',     'Rechazar',              'rechaza',  1, 0],
    ['confeccion',    'confeccionar',      'firma',         'Confeccionada',         'avanza',   0, 0],
    ['confeccion',    'devolver',          'fechas',        'Devolver a fechas',     'devuelve', 1, 0],
    ['confeccion',    'rechazar',          'rechazada',     'Rechazar',              'rechaza',  1, 0],
    ['firma',         'firmar',            'comprobantes',  'Firmar',                'avanza',   0, 0],
    ['firma',         'devolver',          'confeccion',    'Devolver a confección', 'devuelve', 1, 0],
    ['firma',         'rechazar',          'rechazada',     'Rechazar',              'rechaza',  1, 0],
    ['comprobantes',  'enviar_comprobantes','cerrada',      'Comprobantes enviados', 'avanza',   0, 0],
    // Salida por si el pago no se concretó: sin esto, comprobantes es un callejón
    // sin salida y las solicitudes se acumulan ahí para siempre.
    ['comprobantes',  'pago_no_realizado', 'confeccion',    'El pago no se hizo',    'devuelve', 1, 1]
  ];

  // Pares de hitos que no puede resolver la misma persona. Los fijos no se
  // pueden borrar desde el configurador.
  const INCOMP = [
    ['solicitud', 'autorizacion', 1],
    ['confeccion', 'firma', 1],
    ['autorizacion', 'firma', 0]
  ];

  const PLANTILLAS = [
    ['paso:ok_supervisor', 'Autorización pendiente · {{numero}} · {{proveedor}}',
      'Hola {{destinatario}},\n\n{{solicitante}} pidió autorización para un pago:\n\n' +
      '  Proveedor: {{proveedor}}\n  Cuenta: {{cuenta}}\n  Monto: {{monto}}\n  Concepto: {{concepto}}\n\n' +
      'Entrá al panel para autorizarlo o devolverlo:\n{{link}}\n'],
    ['paso:fechas', 'Fecha de pago pendiente · {{numero}} · {{proveedor}}',
      'Hola {{destinatario}},\n\nEl pago a {{proveedor}} por {{monto}} está autorizado y espera fecha.\n\n{{link}}\n'],
    ['paso:confeccion', 'Orden para confeccionar · {{numero}} · {{proveedor}}',
      'Hola {{destinatario}},\n\nHay que confeccionar la orden de pago a {{proveedor}} por {{monto}}.\n' +
      'Fecha de pago confirmada: {{fecha_pago}}\n\n{{link}}\n'],
    ['paso:firma', 'Orden para firmar · {{numero}} · {{proveedor}}',
      'Hola {{destinatario}},\n\nLa orden de pago a {{proveedor}} por {{monto}} está confeccionada y espera firma.\n\n{{link}}\n'],
    ['paso:comprobantes', 'Comprobantes pendientes · {{numero}} · {{proveedor}}',
      'Hola {{destinatario}},\n\nLa orden a {{proveedor}} por {{monto}} está firmada. Falta mandarle los comprobantes.\n\n{{link}}\n'],
    // Avisos al solicitante. El destinatario es fijo en el código, no configurable.
    ['evento:devuelto', 'Te devolvieron la solicitud {{numero}}',
      'Hola {{destinatario}},\n\n{{actor}} devolvió tu solicitud de pago a {{proveedor}}.\n\n' +
      'Motivo: {{comentario}}\n\nCorregila y volvé a enviarla:\n{{link}}\n'],
    ['evento:rechazado', 'Rechazaron la solicitud {{numero}}',
      'Hola {{destinatario}},\n\n{{actor}} rechazó tu solicitud de pago a {{proveedor}} por {{monto}}.\n\n' +
      'Motivo: {{comentario}}\n\n{{link}}\n'],
    ['evento:fecha_confirmada', 'Ya hay fecha de pago · {{numero}} · {{proveedor}}',
      'Hola {{destinatario}},\n\nEl pago a {{proveedor}} por {{monto}} tiene fecha: {{fecha_pago}}.\n\n' +
      'Ya se lo podés confirmar al proveedor.\n\n{{link}}\n'],
    ['evento:cerrado', 'Pago completado · {{numero}} · {{proveedor}}',
      'Hola {{destinatario}},\n\nSe completó el circuito del pago a {{proveedor}} por {{monto}}.\n\n{{link}}\n']
  ];

  try {
    const soc = db.prepare("SELECT id FROM sociedades WHERE nombre = 'San Gerónimo SA'").get()
             || db.prepare('SELECT id FROM sociedades ORDER BY id LIMIT 1').get();

    db.transaction(() => {
      const f = db.prepare(`
        INSERT INTO sp_flujos (clave, nombre, descripcion) VALUES (?,?,?)
      `).run('pago_proveedor', 'Solicitud de pago a proveedor',
             'Circuito de 6 pasos: solicitud, autorización, fechas, confección, firma y comprobantes.');
      const flujoId = f.lastInsertRowid;

      const v = db.prepare(`
        INSERT INTO sp_flujo_versiones (flujo_id, version, estado, activada_en, notas)
        VALUES (?, 1, 'activa', datetime('now','localtime'), ?)
      `).run(flujoId, 'Versión inicial sembrada al instalar el módulo.');
      const vid = v.lastInsertRowid;

      const insPaso = db.prepare(`
        INSERT INTO sp_pasos (version_id, clave, nombre, orden, tipo, hito, modo_captura,
                              sla_horas, requiere_comentario, requiere_adjunto_tipo, instrucciones)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `);
      const ids = {};
      for (const p of PASOS) {
        const r = insPaso.run(vid, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9]);
        ids[p[0]] = r.lastInsertRowid;
      }

      const insTr = db.prepare(`
        INSERT INTO sp_transiciones (version_id, paso_desde_id, paso_hasta_id, accion, etiqueta,
                                     clase, requiere_comentario, invalida_aprobaciones, orden)
        VALUES (?,?,?,?,?,?,?,?,?)
      `);
      TRANS.forEach((t, i) => insTr.run(vid, ids[t[0]], ids[t[2]], t[1], t[3], t[4], t[5], t[6], i));

      // Autorizados iniciales: admin en todos los pasos no terminales, más
      // 'solicitante' en el paso inicial para que el comprador pueda enviar.
      const insAut = db.prepare(`
        INSERT INTO sp_paso_autorizados (paso_id, tipo, usuario_id, rol, area_id, watcher)
        VALUES (?,?,?,?,?,?)
      `);
      for (const p of PASOS) {
        if (p[3] === 'final_ok' || p[3] === 'final_rechazo') continue;
        insAut.run(ids[p[0]], 'rol', null, 'admin', null, 0);
        if (p[3] === 'inicio') insAut.run(ids[p[0]], 'solicitante', null, null, null, 0);
      }

      const insInc = db.prepare('INSERT INTO sp_incompatibilidades (version_id, hito_a, hito_b, fijo) VALUES (?,?,?,?)');
      for (const i of INCOMP) insInc.run(vid, i[0], i[1], i[2]);

      const insPl = db.prepare('INSERT INTO sp_plantillas (version_id, clave, asunto, cuerpo) VALUES (?,?,?,?)');
      for (const p of PLANTILLAS) insPl.run(vid, p[0], p[1], p[2]);

      if (soc) {
        db.prepare('UPDATE sp_flujos SET email_fallback = NULL WHERE id = ?').run(flujoId);
      }
    })();

    console.log('[SP] Seed: circuito "pago_proveedor" creado con 6 pasos y activado');
  } catch (e) {
    console.error('[SP] Error en el seed del circuito:', e.message);
  }
}

try { seed(); } catch (e) { console.error('[SP] Seed falló:', e.message); }

console.log('[SP] Schema inicializado');

export default db;
