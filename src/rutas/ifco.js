// ════════════════════════════════════════════════════════════════════════════
// MÓDULO IFCO — Router de endpoints (panel General > Abasto > IFCOs)
// ════════════════════════════════════════════════════════════════════════════
import express from "express";
import multer  from "multer";
import path    from "path";
import fs      from "fs";
import { fileURLToPath } from "url";
import db from "../servicios/db.js";
import { enviarMail } from "../servicios/mail.js";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "../../data/ifco");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Migración inline: agregar columna rechazo_destino si no existe ─────────
// 'san_geronimo' → cajones rechazados volvieron al piso de SG
// 'proveedor'    → cajones rechazados se quedaron con el proveedor (solo directo)
// NULL           → sin asignar (remitos viejos: impacto cero)
try {
  db.exec("ALTER TABLE ifco_remitos_super ADD COLUMN rechazo_destino TEXT");
} catch(e) { /* columna ya existe */ }

// ── Migración inline: N° de remito interno de SG (opcional, para rastreo)
try {
  db.exec("ALTER TABLE ifco_remitos_super ADD COLUMN n_remito_sg TEXT");
} catch(e) { /* columna ya existe */ }

// ── Migración inline: nuevo estado 'enviado' (intermedio entre sellado y presentado)
// Antes: sellado → presentado (cuando se mandaba el mail a IFCO)
// Ahora: sellado → enviado (mail) → presentado (confirmado por archivo IFCO)
// Si la columna fecha_enviado se crea por primera vez, también pasamos los
// remitos en estado 'presentado' viejos a 'enviado' (porque ese estado solo
// reflejaba "se mandó el mail", no "IFCO lo confirmó realmente").
let _ifcoMigrarEnviado = false;
try {
  db.exec("ALTER TABLE ifco_remitos_super ADD COLUMN fecha_enviado TEXT");
  _ifcoMigrarEnviado = true; // primera vez que se crea la columna
} catch(e) { /* columna ya existe */ }

// Columna para guardar a quién se mandó el mail (al usar "Enviar a IFCO")
try { db.exec("ALTER TABLE ifco_remitos_super ADD COLUMN email_enviado_a TEXT"); } catch(_){}

// Migración del CHECK constraint en `estado`. La tabla original tiene CHECK que NO incluye 'enviado',
// y por eso el UPDATE a 'enviado' (Enviar a IFCO) falla con: CHECK constraint failed.
// Reconstruimos la tabla preservando el SQL original exacto y solo reemplazando la lista de estados.
// Esto es más robusto que reconstruir columna por columna con PRAGMA, porque no pierde defaults
// con expresiones como `DEFAULT (datetime('now','localtime'))` ni FKs.
try {
  const tblRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ifco_remitos_super'").get();
  const sqlOriginal = tblRow && tblRow.sql ? String(tblRow.sql) : '';
  if (sqlOriginal && !/'enviado'/.test(sqlOriginal)) {
    const sqlNew = sqlOriginal.replace(
      /CHECK\s*\(\s*estado\s+IN\s*\([^)]+\)\s*\)/i,
      "CHECK (estado IN ('despachado','sellado','enviado','presentado','anulado'))"
    );
    if (sqlNew === sqlOriginal) {
      console.warn('[IFCO] No se encontró CHECK estado en la tabla. SQL:', sqlOriginal.slice(0, 300));
    } else {
      console.log('[IFCO] Migrando CHECK constraint de estado para incluir "enviado"');
      const idxs = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='ifco_remitos_super' AND sql IS NOT NULL").all();
      const cols = db.prepare("PRAGMA table_info(ifco_remitos_super)").all();
      const colNames = cols.map(function(c){ return '"' + c.name + '"'; }).join(', ');
      const tx = db.transaction(function() {
        db.exec("ALTER TABLE ifco_remitos_super RENAME TO _old_remitos_super_v1");
        db.exec(sqlNew);
        db.exec("INSERT INTO ifco_remitos_super (" + colNames + ") SELECT " + colNames + " FROM _old_remitos_super_v1");
        db.exec("DROP TABLE _old_remitos_super_v1");
        for (const idx of idxs) {
          try { db.exec(idx.sql); } catch(e) { console.warn('[IFCO] No se pudo recrear índice', idx.name, ':', e.message); }
        }
      });
      tx();
      console.log('[IFCO] Migración OK: CHECK estado ahora incluye "enviado"');
    }
  }
} catch(e) {
  console.error('[IFCO] Error migrando CHECK estado:', e.message, e.stack);
}

// Estado de la recepción: 'en_viaje' (proveedor ya despachó pero SG no recibió),
// 'recibido' (confirmada por SG, suma stock + descuenta saldo proveedor),
// 'rechazado' (SG no aceptó la mercadería, no afecta nada).
// Las recepciones viejas (sin estado) son tratadas implícitamente como 'recibido'.
try { db.exec("ALTER TABLE ifco_recepciones_proveedor ADD COLUMN estado TEXT DEFAULT 'recibido'"); } catch(_){}
try { db.exec("ALTER TABLE ifco_recepciones_proveedor ADD COLUMN confirmado_en TEXT"); } catch(_){}
try { db.exec("ALTER TABLE ifco_recepciones_proveedor ADD COLUMN confirmado_por_id INTEGER"); } catch(_){}
// Backfill: cualquier recepción vieja sin estado, marcar como recibido y confirmada
try { db.exec("UPDATE ifco_recepciones_proveedor SET estado = 'recibido' WHERE estado IS NULL"); } catch(_){}

// Columna consolidado_en: marca cuándo el registro fue verificado contra el archivo de IFCO.
// Una vez consolidado, el registro queda bloqueado para edición/eliminación (rastreo limpio).
// Aplica a: ifco_movimientos (retiros) y ifco_recepciones_proveedor (R22 e incluso recepciones normales si IFCO las marca).
try { db.exec("ALTER TABLE ifco_movimientos ADD COLUMN consolidado_en TEXT"); } catch(_){}
try { db.exec("ALTER TABLE ifco_recepciones_proveedor ADD COLUMN consolidado_en TEXT"); } catch(_){}

// Aceptación digital de envíos a proveedor: cada envío tiene un token único por el cual
// el proveedor recibe un link público y puede confirmar la recepción (firma digital simple).
try { db.exec("ALTER TABLE ifco_envios_proveedor ADD COLUMN aceptacion_token TEXT"); } catch(_){}
try { db.exec("ALTER TABLE ifco_envios_proveedor ADD COLUMN visto_en TEXT"); } catch(_){}
try { db.exec("ALTER TABLE ifco_envios_proveedor ADD COLUMN aceptado_en TEXT"); } catch(_){}
try { db.exec("ALTER TABLE ifco_envios_proveedor ADD COLUMN aceptado_por_nombre TEXT"); } catch(_){}
try { db.exec("ALTER TABLE ifco_envios_proveedor ADD COLUMN aceptado_por_dni TEXT"); } catch(_){}
try { db.exec("ALTER TABLE ifco_envios_proveedor ADD COLUMN aceptado_ip TEXT"); } catch(_){}
try { db.exec("ALTER TABLE ifco_envios_proveedor ADD COLUMN aceptado_user_agent TEXT"); } catch(_){}
// origen_proveedor_id: NULL = envío desde SG (caso clásico). Si tiene valor, es un
// traspaso entre galpones (de origen_proveedor_id → proveedor_id). El destino sigue
// firmando con DNI. La fórmula del piso SG ignora estos envíos.
try { db.exec("ALTER TABLE ifco_envios_proveedor ADD COLUMN origen_proveedor_id INTEGER"); } catch(_){}

// Backfill: tokens para envíos viejos que no tengan
try {
  const sinToken = db.prepare("SELECT id FROM ifco_envios_proveedor WHERE aceptacion_token IS NULL OR aceptacion_token = ''").all();
  if (sinToken.length > 0) {
    const upd = db.prepare("UPDATE ifco_envios_proveedor SET aceptacion_token = ? WHERE id = ?");
    sinToken.forEach(function(r){
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let s = '';
      for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
      upd.run(s, r.id);
    });
    console.log('[IFCO] Backfilled aceptacion_token para', sinToken.length, 'envíos');
  }
} catch(e) { console.error('[IFCO] Backfill tokens error:', e.message); }

// Tabla de números anulados de talonarios (para casos como remito mal impreso, manchado, etc.)
// Solo aplica a números SIN USAR — no se puede anular un remito ya cargado por esta vía
// (para esos hay que eliminarlos del módulo Despachos, que los manda a papelera).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ifco_numeros_anulados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      talonario_id INTEGER NOT NULL,
      numero INTEGER NOT NULL,
      motivo TEXT,
      anulado_por_id INTEGER,
      anulado_en TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(talonario_id, numero),
      FOREIGN KEY (talonario_id) REFERENCES ifco_talonarios(id) ON DELETE CASCADE
    )
  `);
} catch(e) { console.error('[IFCO] Crear ifco_numeros_anulados:', e.message); }


// Tabla de conteos físicos de stock (real, contado a mano) por depósito.
// Solo informativo: muestra diferencia vs stock teórico, no genera ajustes.
// Se debe actualizar todos los jueves 10am.
db.exec(`
  CREATE TABLE IF NOT EXISTS ifco_stocks_reales (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    deposito_tipo   TEXT NOT NULL CHECK (deposito_tipo IN ('san_geronimo','proveedor')),
    proveedor_id    INTEGER,
    cantidad        INTEGER NOT NULL,
    fecha           TEXT NOT NULL,
    notas           TEXT,
    usuario_id      INTEGER,
    creado_en       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_stocks_reales_dep ON ifco_stocks_reales(deposito_tipo, proveedor_id, fecha DESC)"); } catch(_){}

// Tabla de consolidaciones con IFCO — histórico mes a mes.
// Cada registro guarda el saldo que IFCO informó vs la suma de pisos reales
// declarados, con la diferencia (= multa estimada).
db.exec(`
  CREATE TABLE IF NOT EXISTS ifco_consolidaciones (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha                    TEXT NOT NULL,
    saldo_ifco               INTEGER NOT NULL,
    piso_sg_real             INTEGER NOT NULL DEFAULT 0,
    pisos_proveedores_real   INTEGER NOT NULL DEFAULT 0,
    en_no_presentados        INTEGER NOT NULL DEFAULT 0,
    suma_real                INTEGER NOT NULL,
    diferencia               INTEGER NOT NULL,
    notas                    TEXT,
    usuario_id               INTEGER,
    creado_en                TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_consolidaciones_fecha ON ifco_consolidaciones(fecha DESC)"); } catch(_){}

// Tabla de registros del archivo de IFCO marcados como "revisar después"
// (no encontrados en el sistema, no se crean ni se consolidan ahora)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ifco_consolidacion_revisar (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      n_remito        TEXT,
      cantidad        INTEGER,
      detalle         TEXT,
      tipo_origen     TEXT NOT NULL CHECK (tipo_origen IN ('despacho','ingreso','r22')),
      fecha_archivo   TEXT,
      marcado_en      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      marcado_por_id  INTEGER,
      resuelto_en     TEXT,
      resuelto_por_id INTEGER,
      resolucion      TEXT,
      notas           TEXT
    )
  `);
} catch(e) { console.error('[IFCO] Crear ifco_consolidacion_revisar:', e.message); }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_consol_revisar_resuelto ON ifco_consolidacion_revisar(resuelto_en, marcado_en DESC)"); } catch(_){}

// ════════════════════════════════════════════════════════════════════════════
// MAILS — infraestructura SMTP centralizada para ifco@lnbonita.com.ar
// ────────────────────────────────────────────────────────────────────────────
// Variables de entorno requeridas (configurar en Railway):
//   SMTP_HOST    — ej. smtp.gmail.com
//   SMTP_PORT    — ej. 587 (TLS) o 465 (SSL)
//   SMTP_USER    — ej. ifco@lnbonita.com.ar
//   SMTP_PASS    — App Password de 16 caracteres (Gmail) o password normal
//   SMTP_FROM    — opcional, default: SMTP_USER
//   SMTP_SECURE  — opcional, 'true' fuerza SSL en 465
// ════════════════════════════════════════════════════════════════════════════

// Tabla de log de mails enviados (trazabilidad completa)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ifco_mails_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo            TEXT NOT NULL CHECK (tipo IN ('presentacion','autorizacion_retiro','aviso_proveedor','otro')),
      enviado_en      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      enviado_por_id  INTEGER,
      destinatarios_to TEXT NOT NULL,
      destinatarios_cc TEXT,
      asunto          TEXT NOT NULL,
      cuerpo          TEXT,
      adjuntos_count  INTEGER DEFAULT 0,
      status          TEXT NOT NULL CHECK (status IN ('success','error')),
      error_msg       TEXT,
      message_id      TEXT,
      related_ids     TEXT
    )
  `);
} catch(e) { console.error('[IFCO] Crear ifco_mails_log:', e.message); }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_mails_log_tipo ON ifco_mails_log(tipo, enviado_en DESC)"); } catch(_){}

// Tabla de autorizaciones de retiro (mails que mandamos a IFCO autorizando un transportista)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ifco_autorizaciones_retiro (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha_autorizada        TEXT NOT NULL,
      transportista_nombre    TEXT NOT NULL,
      transportista_dni       TEXT NOT NULL,
      transportista_patente   TEXT NOT NULL,
      cantidad_estimada       INTEGER NOT NULL,
      estado                  TEXT NOT NULL DEFAULT 'pendiente_envio' CHECK (estado IN ('pendiente_envio','enviada','completada','cancelada')),
      mail_enviado_a          TEXT,
      mail_enviado_en         TEXT,
      mail_message_id         TEXT,
      movimiento_pendiente_id INTEGER,
      cantidad_real           INTEGER,
      completada_en           TEXT,
      completada_por_id       INTEGER,
      notas                   TEXT,
      usuario_id              INTEGER,
      creado_en               TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      eliminado_en            TEXT,
      FOREIGN KEY (movimiento_pendiente_id) REFERENCES ifco_movimientos(id)
    )
  `);
} catch(e) { console.error('[IFCO] Crear ifco_autorizaciones_retiro:', e.message); }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_autoriz_retiro_estado ON ifco_autorizaciones_retiro(estado, creado_en DESC)"); } catch(_){}
// Migración: las autorizaciones canceladas que quedaron visibles (sin eliminado_en) se mandan a papelera.
// (Antes "cancelar" no mandaba a papelera; ahora sí, y limpiamos las que quedaron viejas.)
try {
  const r = db.prepare("UPDATE ifco_autorizaciones_retiro SET eliminado_en = COALESCE(eliminado_en, datetime('now','localtime')) WHERE estado = 'cancelada' AND eliminado_en IS NULL").run();
  if (r.changes > 0) console.log('[IFCO] ' + r.changes + ' autorizaciones canceladas migradas a papelera.');
} catch(_){}

// Columna nueva: marca movimientos pendientes (no impactan en stock hasta confirmar)
try { db.exec("ALTER TABLE ifco_movimientos ADD COLUMN pendiente INTEGER NOT NULL DEFAULT 0"); } catch(_){}

// ════════════════════════════════════════════════════════════════════════════
// MAIL HELPER — usa la API HTTP de Brevo (puerto 443) en vez de SMTP
// ────────────────────────────────────────────────────────────────────────────
// Por qué API HTTP en vez de SMTP: Railway bloquea los puertos SMTP salientes
// (25/465/587) como política antispam. La API HTTP de Brevo va por puerto 443
// (HTTPS estándar), que siempre está abierto.
//
// Variables de entorno requeridas:
//   BREVO_API_KEY  — API key de Brevo (empieza con xkeysib-)
//   SMTP_FROM      — opcional, default: ifco@lnbonita.com.ar
// ════════════════════════════════════════════════════════════════════════════

// Helper: enviar mail vía servicio centralizado de Brevo y registrar en ifco_mails_log.
// Mantiene la firma original para no romper a los callers.
// El sender específico de IFCO ("Gestión IFCO - SAN GERONIMO SA") se pasa explícitamente,
// para que el log diga "viene de IFCO" aunque el helper genérico viva en servicios/mail.js.
// opts: { tipo, to, cc?, asunto, cuerpo_html, cuerpo_texto, adjuntos: [{filename, path}], related_ids?, usuario_id? }
async function _enviarMailIFCO(opts) {
  const log = {
    tipo: opts.tipo || 'otro',
    enviado_por_id: opts.usuario_id || null,
    destinatarios_to: Array.isArray(opts.to) ? opts.to.join(', ') : (opts.to || ''),
    destinatarios_cc: Array.isArray(opts.cc) ? opts.cc.join(', ') : (opts.cc || null),
    asunto: opts.asunto || '(sin asunto)',
    cuerpo: opts.cuerpo_texto || opts.cuerpo_html || null,
    adjuntos_count: (opts.adjuntos || []).length,
    related_ids: opts.related_ids ? JSON.stringify(opts.related_ids) : null
  };
  // Delegar al servicio centralizado pasando el sender de IFCO
  const senderEmail = process.env.SMTP_FROM || 'ifco@lnbonita.com.ar';
  const r = await enviarMail({
    to: opts.to,
    cc: opts.cc,
    asunto: opts.asunto,
    cuerpo_html: opts.cuerpo_html,
    cuerpo_texto: opts.cuerpo_texto,
    adjuntos: opts.adjuntos,
    sender_email: senderEmail,
    sender_name: 'Gestión IFCO - SAN GERONIMO SA'
  });

  if (r.success) {
    db.prepare(`
      INSERT INTO ifco_mails_log (tipo, enviado_por_id, destinatarios_to, destinatarios_cc, asunto, cuerpo, adjuntos_count, status, message_id, related_ids)
      VALUES (@tipo, @enviado_por_id, @destinatarios_to, @destinatarios_cc, @asunto, @cuerpo, @adjuntos_count, 'success', @message_id, @related_ids)
    `).run(Object.assign(log, { message_id: r.messageId }));
    return { success: true, messageId: r.messageId };
  } else {
    db.prepare(`
      INSERT INTO ifco_mails_log (tipo, enviado_por_id, destinatarios_to, destinatarios_cc, asunto, cuerpo, adjuntos_count, status, error_msg, related_ids)
      VALUES (@tipo, @enviado_por_id, @destinatarios_to, @destinatarios_cc, @asunto, @cuerpo, @adjuntos_count, 'error', @error_msg, @related_ids)
    `).run(Object.assign(log, { error_msg: String(r.error || '').slice(0, 500) }));
    return { success: false, error: r.error };
  }
}



// Tabla de "faltantes de stock" declarados manualmente para SAN GERONIMO.
// Cada fila es un ajuste discreto: delta>0 aumenta el faltante, delta<0 lo reduce.
// El faltante actual = SUM(delta) de los no eliminados. Se descuenta del piso teórico
// para que el sistema refleje la realidad mientras se investiga la causa.
db.exec(`
  CREATE TABLE IF NOT EXISTS ifco_faltantes_sg (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha             TEXT NOT NULL,
    delta             INTEGER NOT NULL,
    motivo            TEXT,
    usuario_id        INTEGER,
    creado_en         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    eliminado_en      TEXT,
    eliminado_por_id  INTEGER
  )
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_faltantes_sg_fecha ON ifco_faltantes_sg(fecha DESC)"); } catch(_){}

if (_ifcoMigrarEnviado) {
  try {
    const r = db.prepare(`
      UPDATE ifco_remitos_super
      SET fecha_enviado    = fecha_presentado,
          fecha_presentado = NULL,
          estado           = 'enviado'
      WHERE estado = 'presentado' AND fecha_presentado IS NOT NULL
    `).run();
    console.log('[IFCO] Migración estado "presentado" → "enviado":', r.changes, 'remitos');
  } catch(e) {
    console.error('[IFCO] Error migrando presentados → enviados:', e.message);
  }
}

// ── Migración inline: recepciones tipo R22 (IFCOs nuevos comprados a IFCO por el proveedor)
// Las recepciones R22 SUMAN al stock de SG pero NO descuentan saldo del proveedor.
// es_r22:        flag (0 normal, 1 R22)
// sucursal_ifco: 'Buenos Aires' | 'Mendoza' (origen del remito R22, hardcoded)
try { db.exec("ALTER TABLE ifco_recepciones_proveedor ADD COLUMN es_r22 INTEGER DEFAULT 0"); } catch(e) { /* ya existe */ }
try { db.exec("ALTER TABLE ifco_recepciones_proveedor ADD COLUMN sucursal_ifco TEXT"); } catch(e) { /* ya existe */ }

// ── Migración inline: hacer ifco_recepciones_proveedor.proveedor_id NULLABLE
// (para que las R22 sin proveedor asignado funcionen). Idempotente: solo corre si la columna es NOT NULL.
// Approach robusto: preservar SQL original literal y solo modificar la columna proveedor_id.
try {
  const cols = db.prepare("PRAGMA table_info(ifco_recepciones_proveedor)").all();
  const provCol = cols.find(function(c){ return c.name === 'proveedor_id'; });
  if (provCol && provCol.notnull === 1) {
    const tblRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ifco_recepciones_proveedor'").get();
    const sqlOriginal = tblRow && tblRow.sql ? String(tblRow.sql) : '';
    if (!sqlOriginal) {
      console.warn('[IFCO] No se encontró SQL de ifco_recepciones_proveedor');
    } else {
      // Reemplazar la definición de proveedor_id quitando el NOT NULL.
      const sqlNew = sqlOriginal.replace(
        /proveedor_id\s+([A-Za-z]+)(\s+NOT\s+NULL)/i,
        'proveedor_id $1'
      );
      if (sqlNew === sqlOriginal) {
        console.warn('[IFCO] No se encontró NOT NULL en proveedor_id. SQL:', sqlOriginal.slice(0, 300));
      } else {
        console.log('[IFCO] Migrando: hacer proveedor_id NULLABLE en ifco_recepciones_proveedor');
        const idxs = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='ifco_recepciones_proveedor' AND sql IS NOT NULL").all();
        const colNames = cols.map(function(c){ return '"' + c.name + '"'; }).join(', ');
        const tx = db.transaction(function() {
          db.exec("ALTER TABLE ifco_recepciones_proveedor RENAME TO _old_recep_prov_v1");
          db.exec(sqlNew);
          db.exec("INSERT INTO ifco_recepciones_proveedor (" + colNames + ") SELECT " + colNames + " FROM _old_recep_prov_v1");
          db.exec("DROP TABLE _old_recep_prov_v1");
          for (const idx of idxs) {
            try { db.exec(idx.sql); } catch(e) { console.warn('[IFCO] No se pudo recrear índice', idx.name, ':', e.message); }
          }
        });
        tx();
        console.log('[IFCO] Migración OK: proveedor_id ahora es NULLABLE');
      }
    }
  }
} catch(e) {
  console.error('[IFCO] Error migrando proveedor_id NULLABLE:', e.message);
}

// ── Configuración OCR vía Claude API ───────────────────────────────────────
const OCR_ENABLED = String(process.env.IFCO_OCR_ENABLED || '').toLowerCase() === 'true';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OCR_MODEL = 'claude-haiku-4-5-20251001';
let _anthropicClient = null;
async function _getAnthropic() {
  if (!OCR_ENABLED || !ANTHROPIC_API_KEY) return null;
  if (_anthropicClient) return _anthropicClient;
  try {
    const mod = await import('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod.Anthropic;
    _anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    return _anthropicClient;
  } catch(e) {
    console.error('[IFCO][OCR] No se pudo cargar @anthropic-ai/sdk:', e.message);
    return null;
  }
}

// ── Lazy load de exceljs para parsear Excel de IFCO ──────────────────────
let _exceljsLib = null;
async function _getExcelJS() {
  if (_exceljsLib) return _exceljsLib;
  try {
    const mod = await import('exceljs');
    _exceljsLib = mod.default || mod;
    return _exceljsLib;
  } catch(e) {
    console.warn('[IFCO] Librería exceljs no disponible:', e.message);
    return null;
  }
}

// ── Helpers para consolidación con archivo IFCO ───────────────────────────
// Normaliza un N° de remito tomando los últimos 8 dígitos (key de match)
// Ejemplos: "00015-01508545" → "01508545"; "0015R01508545" → "01508545"
function _normalizarNumeroRemito(s) {
  if (s == null) return null;
  const digits = String(s).replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  return digits.slice(-8);
}

// Convierte el formato del archivo IFCO al formato canónico del sistema
// "0015R01508545" → "00015-01508545"
function _archivoANumeroSistema(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d+)R(\d+)$/);
  if (m) return m[1].padStart(5, '0') + '-' + m[2];
  return null;
}

// Matchea el "Detalle" del archivo IFCO contra las cadenas hardcoded del sistema
// Devuelve la cadena canónica o null si no matchea
function _matchCadenaIFCO(detalle) {
  if (!detalle) return null;
  const s = String(detalle).toLowerCase();
  if (s.includes('vea') || s.includes('cencosud')) return 'CENCOSUD';
  if (s.includes('carrefour'))                     return 'CARREFOUR (INC SA)';
  if (s.includes('coto'))                          return 'COTO';
  if (s.includes('dorinka') || s.includes('chango')) return 'CHANGO MAS (DORINKA)';
  if (s.includes('cooperativa obrera'))            return 'LA COOPERATIVA OBRERA';
  if (s.includes('anonima') || s.includes('anónima')) return 'LA ANONIMA';
  return null;
}

// Lee el valor "plano" de una celda de exceljs (puede venir como objeto, número, string o Date)
function _cellValue(cell) {
  if (!cell) return null;
  let v = cell.value;
  if (v == null) return null;
  // Fórmulas con resultado calculado
  if (typeof v === 'object' && v.result !== undefined) v = v.result;
  // Hyperlinks / rich text
  if (typeof v === 'object' && v.text !== undefined) v = v.text;
  if (typeof v === 'object' && Array.isArray(v.richText)) {
    v = v.richText.map(function(p){ return p.text||''; }).join('');
  }
  return v;
}

// Parsea el Excel de IFCO. Soporta dos formatos:
//   FORMATO VIEJO: hoja "Cronologico" con sección "Entregas a Cadenas" y columnas Fecha|N°|Cliente|Detalle|Entradas|Salidas
//   FORMATO NUEVO: hoja "Det. Cronologico" con header "Fecha doc|Nº Remito|cuenta|Detalle|INGRESOS|EGRESOS|STOCK"
async function _parsearExcelIFCO(buffer) {
  const ExcelJS = await _getExcelJS();
  if (!ExcelJS) throw new Error('Librería exceljs no disponible en el servidor');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  if (wb.worksheets.length === 0) throw new Error('El archivo no tiene hojas');

  // Probar las hojas en orden de probabilidad. Para cada una intentar primero formato viejo, después nuevo.
  // La detección la hace cada parser internamente; si no aplica, devuelve null.
  // Damos prioridad a la hoja cuyo nombre empiece con "cronologico" / "det. cronologico".
  const hojasOrdenadas = [];
  wb.eachSheet(function(sheet) {
    const n = sheet.name.toLowerCase();
    if (n.includes('cronologico')) hojasOrdenadas.unshift(sheet);
    else hojasOrdenadas.push(sheet);
  });

  const errores = [];
  for (const ws of hojasOrdenadas) {
    try {
      const r = _parsearFormatoNuevo(ws);
      if (r && (r.despachos.length + r.ingresos.length + r.r22.length) > 0) return r;
    } catch(e) { errores.push('[nuevo/'+ws.name+'] '+e.message); }
    try {
      const r = _parsearFormatoViejo(ws);
      if (r && r.despachos.length > 0) return r;
    } catch(e) { errores.push('[viejo/'+ws.name+'] '+e.message); }
  }
  throw new Error('No se pudo identificar el formato del Excel. Probá con otro archivo. Detalles: ' + errores.join(' | '));
}

// FORMATO NUEVO — header en alguna fila con columnas "Nº Remito" + "EGRESOS"
// Devuelve { despachos: [...], ingresos: [...], r22: [...] }
function _parsearFormatoNuevo(ws) {
  // Buscar la fila de header escaneando las primeras 30 filas
  let headerRow = -1;
  let cN = -1, cFecha = -1, cDet = -1, cEgresos = -1, cIngresos = -1;
  const maxScan = Math.min(30, ws.rowCount);
  for (let i = 1; i <= maxScan; i++) {
    const row = ws.getRow(i);
    let foundN = -1, foundEg = -1, foundIn = -1, foundFecha = -1, foundDet = -1;
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = _cellValue(row.getCell(c));
      if (v == null) continue;
      const s = String(v).trim().toLowerCase();
      if (foundN < 0     && (s === 'nº remito' || s === 'n° remito' || s === 'no remito' || s === 'remito')) foundN = c;
      if (foundEg < 0    && s.startsWith('egreso'))                                                          foundEg = c;
      if (foundIn < 0    && s.startsWith('ingreso'))                                                         foundIn = c;
      if (foundFecha < 0 && (s === 'fecha doc' || s === 'fecha' || s.startsWith('fecha')))                   foundFecha = c;
      if (foundDet < 0   && s === 'detalle')                                                                 foundDet = c;
    }
    if (foundN > 0 && (foundEg > 0 || foundIn > 0)) {
      headerRow = i; cN = foundN; cEgresos = foundEg; cIngresos = foundIn;
      cFecha = foundFecha; cDet = foundDet;
      break;
    }
  }
  if (headerRow < 0) return null;

  const despachos = [], ingresos = [], r22 = [];
  for (let i = headerRow + 1; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const nRem = _cellValue(row.getCell(cN));
    if (!nRem) continue;
    const egr = cEgresos > 0 ? _cellValue(row.getCell(cEgresos)) : null;
    const ing = cIngresos > 0 ? _cellValue(row.getCell(cIngresos)) : null;
    const cantEgr = parseInt(egr) || 0;
    const cantIng = parseInt(ing) || 0;
    if (cantEgr <= 0 && cantIng <= 0) continue;

    const detalleVal = cDet > 0 ? _cellValue(row.getCell(cDet)) : null;
    const detalleStr = detalleVal ? String(detalleVal).trim() : '';
    if (/ajuste/i.test(detalleStr)) continue;
    const nRemStr = String(nRem).trim();
    if (/^IC[-\s]/i.test(nRemStr)) continue;
    if (!/\d{4,}/.test(nRemStr)) continue;
    const normalizado = _normalizarNumeroRemito(nRemStr);
    if (!normalizado) continue;

    let fechaIso = null;
    if (cFecha > 0) {
      const fv = _cellValue(row.getCell(cFecha));
      if (fv instanceof Date) fechaIso = fv.toISOString().slice(0,10);
      else if (fv != null) {
        const m = String(fv).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
        if (m) {
          const yyyy = m[3].length === 2 ? '20' + m[3] : m[3];
          fechaIso = yyyy + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0');
        }
      }
    }
    const cant = cantEgr > 0 ? cantEgr : cantIng;
    const item = {
      n_remito_archivo:     nRemStr,
      n_remito_sistema:     _archivoANumeroSistema(nRemStr),
      n_remito_normalizado: normalizado,
      fecha:                fechaIso,
      cliente:              detalleStr || null,
      detalle:              detalleStr || null,
      cantidad:             cant
    };

    // Clasificar la fila por contenido del detalle
    if (cantIng > 0) {
      // Cualquier INGRESO: si dice "Retiros de Cajas IFCO" es nuestro retiro propio,
      // sino lo tratamos como R22 (proveedor que compró cajones directo a IFCO).
      // Esto cubre casos como "De Expoverde S.A", "R22 ...", etc.
      if (/retiros?\s+de\s+cajas?\s+ifco/i.test(detalleStr)) {
        ingresos.push(item);
      } else {
        r22.push(item);
      }
    } else if (cantEgr > 0) {
      // Egreso explícito de R22 (raro): respetar
      if (/r22/i.test(detalleStr)) r22.push(item);
      else                         despachos.push(item);
    }
    // Filas que no encajan en ninguna categoría se ignoran silenciosamente
  }
  return { despachos: despachos, ingresos: ingresos, r22: r22, remitos: despachos /* compat */ };
}

// FORMATO VIEJO — busca la sección "Entregas a Cadenas" como subtítulo
function _parsearFormatoViejo(ws) {
  let inicio = -1;
  ws.eachRow({ includeEmpty: true }, function(row, rowNumber) {
    if (inicio !== -1) return;
    const c0 = _cellValue(row.getCell(1));
    if (c0 && String(c0).trim().toLowerCase() === 'entregas a cadenas') {
      inicio = rowNumber + 1;
    }
  });
  if (inicio < 0) return null;

  const remitos = [];
  let vaciasSeguidas = 0;
  const ultimaFila = ws.rowCount;
  for (let i = inicio; i <= ultimaFila; i++) {
    const row = ws.getRow(i);
    const c0 = _cellValue(row.getCell(1));
    const c1 = _cellValue(row.getCell(2));
    const c2 = _cellValue(row.getCell(3));
    const c3 = _cellValue(row.getCell(4));
    const c4 = _cellValue(row.getCell(5));
    const c5 = _cellValue(row.getCell(6));

    const todasVacias = [c0,c1,c2,c3,c4,c5].every(function(v){ return v == null || String(v).trim() === ''; });
    if (todasVacias) {
      vaciasSeguidas++;
      if (vaciasSeguidas >= 3) break;
      continue;
    }
    vaciasSeguidas = 0;

    if (c0 && !c1 && typeof c0 === 'string' && !/^\d/.test(c0.toString().trim()) && !c0.toString().match(/\d{4}/)) {
      break;
    }
    if (!c1) continue;

    const nRemitoArchivo = String(c1).trim();
    const normalizado = _normalizarNumeroRemito(nRemitoArchivo);
    if (!normalizado) continue;

    let fechaIso = null;
    if (c0 instanceof Date) {
      fechaIso = c0.toISOString().slice(0, 10);
    } else if (c0 != null) {
      const txt = String(c0);
      const m = txt.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      if (m) {
        const yyyy = m[3].length === 2 ? '20' + m[3] : m[3];
        fechaIso = yyyy + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
      }
    }

    const salidas = parseInt(c5 || 0);
    const entradas = parseInt(c4 || 0);
    const cantidad = salidas < 0 ? -salidas : (entradas || Math.abs(salidas));

    remitos.push({
      n_remito_archivo:    nRemitoArchivo,
      n_remito_sistema:    _archivoANumeroSistema(nRemitoArchivo),
      n_remito_normalizado: normalizado,
      fecha:               fechaIso,
      cliente:             c2 ? String(c2).trim() : null,
      detalle:             c3 ? String(c3).trim() : null,
      cantidad:            cantidad
    });
  }
  // Formato viejo: solo despachos. Devuelve mismo shape para compat con wizard.
  return { despachos: remitos, ingresos: [], r22: [], remitos: remitos };
}

const router = express.Router();

// ── Upload para escaneos del remito sellado ───────────────────────────────
const storage = multer.diskStorage({
  destination: function(req, file, cb) { cb(null, UPLOAD_DIR); },
  filename:    function(req, file, cb) {
    const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase();
    const tag = file.fieldname || 'remito';
    cb(null, tag + '_' + (req.params.id || 'x') + '_' + Date.now() + ext);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── Auth desde cookie (sigue patrón del resto del panel) ──────────────────
function getUser(req) {
  try {
    const cookie = req.cookies && req.cookies.lnb_user;
    if (!cookie) return null;
    return JSON.parse(cookie);
  } catch(e) { return null; }
}
function requireAuth(req, res, next) {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: 'No autenticado' });
  req.user = u;
  next();
}

// ────── RUTAS PÚBLICAS (sin auth) ──────
// Generador de token random para aceptación digital de remitos
function _genTokenAceptacion() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Helper de escape HTML
function _esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Helper de fecha en español
function _fechaEs(s) {
  if (!s) return '';
  try {
    const d = new Date(s);
    return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch(_) { return s; }
}
function _fechaCortaEs(s) {
  if (!s) return '';
  try {
    const d = new Date(s);
    return d.toLocaleDateString('es-AR') + ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  } catch(_) { return s; }
}

// Renderiza la vista pública del remito (HTML standalone que el proveedor abre desde WhatsApp)
function _renderRemitoPublico(envio) {
  const yaAceptado = !!envio.aceptado_en;
  const cantidad   = parseInt(envio.cantidad_enviada) || 0;
  const saldoTotal = envio.saldo_total != null ? envio.saldo_total : cantidad;

  const banner = yaAceptado
    ? `<div class="banner banner-ok">
         <div class="banner-tit">✓ Recepción confirmada</div>
         <div class="banner-bod">
           <b>${_esc(envio.aceptado_por_nombre)}</b> · DNI ${_esc(envio.aceptado_por_dni)}<br>
           ${_esc(_fechaCortaEs(envio.aceptado_en))} hs
         </div>
       </div>`
    : `<div class="banner banner-pend">
         <div class="banner-tit">⏳ Pendiente de confirmación</div>
         <div class="banner-bod">Completá tus datos abajo para confirmar la recepción de los cajones.</div>
       </div>`;

  const formAceptacion = yaAceptado ? '' : `
    <div class="firma-box">
      <div class="firma-tit">✏️ Confirmar recepción</div>
      <div class="campo">
        <label>Tu nombre y apellido</label>
        <input id="f-nombre" type="text" placeholder="Ej: Juan Pérez" autocomplete="name">
      </div>
      <div class="campo">
        <label>DNI</label>
        <input id="f-dni" type="text" inputmode="numeric" placeholder="Ej: 28456789" autocomplete="off">
      </div>
      <button id="btn-aceptar" onclick="aceptar()">✓ Confirmar recepción de ${cantidad} cajón${cantidad === 1 ? '' : 'es'}</button>
      <div id="msg-error" class="msg-error"></div>
    </div>
    <div class="aviso-resp">
      <b>Importante:</b> Al confirmar, asumís responsabilidad sobre los cajones IFCO recibidos hasta su devolución a SAN GERÓNIMO SA. Cada cajón perdido tiene un costo económico para la empresa.
    </div>`;

  const esTraspaso = !!envio.origen_proveedor_id;
  const proveedorBlock =
    `<div class="campo-box span2">
       <div class="campo-lbl">${esTraspaso ? 'Galpón Destino (vos)' : 'Proveedor'}</div>
       <div class="campo-val"><b>${_esc(envio.proveedor_nombre || '?')}</b></div>
       ${envio.proveedor_razon ? '<div class="campo-sub">' + _esc(envio.proveedor_razon) + '</div>' : ''}
       ${envio.proveedor_cuit  ? '<div class="campo-sub">CUIT: ' + _esc(envio.proveedor_cuit) + '</div>' : ''}
     </div>` +
    (esTraspaso ?
      `<div class="campo-box span2" style="background:#eff6ff;border-color:#93c5fd">
         <div class="campo-lbl" style="color:#1e40af">🔄 Remitente (otro galpón)</div>
         <div class="campo-val"><b>${_esc(envio.origen_proveedor_nombre || '?')}</b></div>
         ${envio.origen_proveedor_razon ? '<div class="campo-sub">' + _esc(envio.origen_proveedor_razon) + '</div>' : ''}
         <div class="campo-sub" style="margin-top:4px">Traspaso entre galpones autorizado por SG. Confirmando esta recepción, los cajones quedan a tu cargo.</div>
       </div>` : '');

  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Remito ${_esc(envio.n_remito_interno)} — SAN GERÓNIMO SA</title>
<style>
  *{box-sizing:border-box}
  body{font-family:'Segoe UI',-apple-system,'Helvetica Neue',Arial,sans-serif;margin:0;background:#f3f4f6;color:#111;font-size:14px;line-height:1.5}
  .wrap{max-width:600px;margin:0 auto;background:#fff;min-height:100vh;padding:20px;box-shadow:0 0 12px rgba(0,0,0,.05)}
  @media (min-width:640px){ .wrap{margin:20px auto;border-radius:10px;min-height:auto} }
  .head{display:flex;align-items:flex-start;justify-content:space-between;border-bottom:2px solid #1e3a5f;padding-bottom:14px;margin-bottom:16px;gap:12px;flex-wrap:wrap}
  .head-left{display:flex;align-items:center;gap:10px}
  .head-logo{height:42px;width:auto}
  .head-tit{font-size:15px;font-weight:600;color:#1e3a5f;margin:0;line-height:1.2}
  .head-sub{font-size:11px;color:#666;margin-top:2px}
  .head-num{font-family:monospace;font-size:18px;font-weight:600;color:#1e3a5f}
  .head-fecha{font-size:11px;color:#666;text-align:right;margin-top:2px}
  .banner{padding:14px 16px;border-radius:8px;margin-bottom:16px}
  .banner-ok{background:#dcfce7;border:1px solid #16a34a}
  .banner-ok .banner-tit{color:#14532d;font-weight:600;font-size:14px}
  .banner-ok .banner-bod{color:#166534;font-size:13px;margin-top:4px;line-height:1.5}
  .banner-pend{background:#fef3c7;border:1px solid #f59e0b}
  .banner-pend .banner-tit{color:#78350f;font-weight:600;font-size:14px}
  .banner-pend .banner-bod{color:#92400e;font-size:13px;margin-top:4px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
  .span2{grid-column:span 2}
  .campo-box{border:1px solid #d1d5db;border-radius:6px;padding:10px 12px}
  .campo-lbl{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
  .campo-val{font-size:14px}
  .campo-sub{font-size:11px;color:#6b7280;margin-top:2px}
  .campo-big{background:#f9fafb}
  .campo-big .campo-val{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}
  .saldo-box{background:#fef3c7;border:2px solid #f59e0b;border-radius:6px;padding:12px 14px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;gap:8px}
  .saldo-lbl{font-size:11px;color:#92400e;text-transform:uppercase;letter-spacing:.05em}
  .saldo-sub{font-size:10px;color:#92400e;margin-top:2px}
  .saldo-val{font-size:28px;font-weight:700;color:#92400e;font-variant-numeric:tabular-nums}
  .firma-box{background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px;margin-bottom:14px}
  .firma-tit{font-size:13px;font-weight:600;color:#166534;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px}
  .campo{margin-bottom:10px}
  .campo label{display:block;font-size:11px;color:#6b7280;text-transform:uppercase;margin-bottom:4px}
  .campo input{width:100%;padding:10px 12px;font-size:15px;border:1px solid #d1d5db;border-radius:6px;background:#fff;font-family:inherit}
  .campo input:focus{outline:none;border-color:#16a34a;box-shadow:0 0 0 2px rgba(22,163,74,.15)}
  #btn-aceptar{width:100%;background:#16a34a;color:#fff;border:none;padding:13px;border-radius:6px;font-weight:600;font-size:15px;cursor:pointer;font-family:inherit;margin-top:4px}
  #btn-aceptar:hover{background:#15803d}
  #btn-aceptar:disabled{background:#9ca3af;cursor:wait}
  .msg-error{color:#991b1b;font-size:12px;margin-top:8px;text-align:center;min-height:14px}
  .aviso-resp{font-size:12px;line-height:1.5;color:#78350f;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:10px 12px;margin-bottom:14px}
  .pie{font-size:11px;color:#9ca3af;text-align:center;margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb}
</style>
</head><body>
<div class="wrap">

  <div class="head">
    <div class="head-left">
      <img src="/static/logo.jpg" alt="SAN GERÓNIMO SA" class="head-logo" onerror="this.style.display='none'">
      <div>
        <div class="head-tit">SAN GERÓNIMO SA</div>
        <div class="head-sub">Remito de envío de cajones IFCO</div>
      </div>
    </div>
    <div>
      <div class="head-num">${_esc(envio.n_remito_interno)}</div>
      <div class="head-fecha">${_esc(_fechaEs(envio.fecha_envio))}</div>
    </div>
  </div>

  ${banner}

  <div class="grid">
    ${proveedorBlock}
    <div class="campo-box campo-big span2">
      <div class="campo-lbl">Cantidad de cajones de este envío</div>
      <div class="campo-val">${cantidad}</div>
    </div>
    ${envio.notas ? '<div class="campo-box span2"><div class="campo-lbl">Notas</div><div class="campo-val">' + _esc(envio.notas) + '</div></div>' : ''}
  </div>

  <div class="saldo-box">
    <div>
      <div class="saldo-lbl">Saldo total bajo tu responsabilidad</div>
      <div class="saldo-sub">cajones IFCO sin devolver, incluyendo este envío</div>
    </div>
    <div class="saldo-val">${saldoTotal}</div>
  </div>

  ${formAceptacion}

  <div class="pie">
    Este link es la constancia oficial. Podés volver a abrirlo cuando quieras.<br>
    SAN GERÓNIMO SA
  </div>
</div>
${yaAceptado ? '' : `
<script>
async function aceptar() {
  const nombre = document.getElementById('f-nombre').value.trim();
  const dni    = document.getElementById('f-dni').value.trim().replace(/\\D/g, '');
  const err    = document.getElementById('msg-error');
  err.textContent = '';
  if (!nombre || nombre.length < 3) { err.textContent = 'Ingresá tu nombre completo'; return; }
  if (!dni || dni.length < 7)        { err.textContent = 'DNI inválido'; return; }
  const btn = document.getElementById('btn-aceptar');
  btn.disabled = true; btn.textContent = 'Confirmando…';
  try {
    const r = await fetch(window.location.pathname + '/aceptar' + window.location.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, dni })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    location.reload();
  } catch(e) {
    err.textContent = 'Error: ' + e.message;
    btn.disabled = false;
    btn.textContent = '✓ Confirmar recepción';
  }
}
</script>`}
</body></html>`;
}

// GET público: ver remito (con o sin token, validamos)
router.get('/r/:numero', function(req, res) {
  const numero = req.params.numero;
  const token  = req.query.t;
  if (!token) return res.status(404).type('text/html').send('<h1>Remito no encontrado</h1>');

  const envio = db.prepare(`
    SELECT e.*, p.nombre AS proveedor_nombre, p.razon_social AS proveedor_razon, p.cuit AS proveedor_cuit,
           porig.nombre AS origen_proveedor_nombre, porig.razon_social AS origen_proveedor_razon
    FROM ifco_envios_proveedor e
    LEFT JOIN proveedores p ON p.id = e.proveedor_id
    LEFT JOIN proveedores porig ON porig.id = e.origen_proveedor_id
    WHERE e.n_remito_interno = ? AND e.aceptacion_token = ? AND e.eliminado_en IS NULL
  `).get(numero, token);

  if (!envio) return res.status(404).type('text/html').send('<h1>Remito no encontrado</h1><p>El link es inválido o el remito fue eliminado.</p>');

  // Calcular saldo total del proveedor (sumar todos los envíos pendientes/parciales)
  try {
    const saldoRow = db.prepare(`
      SELECT COALESCE(SUM(cantidad_enviada), 0) AS enviado,
             COALESCE(SUM(CASE WHEN estado='recibido' THEN cantidad_recibida WHEN estado='parcial' THEN cantidad_recibida ELSE 0 END), 0) AS recibido
      FROM ifco_envios_proveedor
      WHERE proveedor_id = ? AND eliminado_en IS NULL
    `).get(envio.proveedor_id);
    envio.saldo_total = (saldoRow.enviado || 0) - (saldoRow.recibido || 0);
  } catch(_) { envio.saldo_total = envio.cantidad_enviada; }

  // Marcar como visto (si nunca fue visto)
  if (!envio.visto_en) {
    try {
      db.prepare("UPDATE ifco_envios_proveedor SET visto_en = ? WHERE id = ?")
        .run(new Date().toISOString(), envio.id);
    } catch(_){}
  }
  res.type('text/html').send(_renderRemitoPublico(envio));
});

// POST público: confirmar recepción
router.post('/r/:numero/aceptar', express.json(), function(req, res) {
  const numero = req.params.numero;
  const token  = req.query.t;
  const d      = req.body || {};
  if (!token)        return res.status(404).json({ error: 'Link inválido' });
  if (!d.nombre || String(d.nombre).trim().length < 3) return res.status(400).json({ error: 'Nombre inválido' });
  if (!d.dni    || String(d.dni).replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'DNI inválido' });

  const envio = db.prepare(`
    SELECT id, aceptado_en FROM ifco_envios_proveedor
    WHERE n_remito_interno = ? AND aceptacion_token = ? AND eliminado_en IS NULL
  `).get(numero, token);
  if (!envio) return res.status(404).json({ error: 'Link inválido' });
  if (envio.aceptado_en) return res.status(400).json({ error: 'Este remito ya fue aceptado anteriormente' });

  const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
  const ua = req.headers['user-agent'] || '';
  try {
    db.prepare(`
      UPDATE ifco_envios_proveedor
      SET aceptado_en = ?, aceptado_por_nombre = ?, aceptado_por_dni = ?,
          aceptado_ip = ?, aceptado_user_agent = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      String(d.nombre).trim(),
      String(d.dni).replace(/\D/g, ''),
      ip || null, ua || null,
      envio.id
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('[IFCO][aceptar]:', e);
    res.status(500).json({ error: e.message });
  }
});

router.use(requireAuth);

// Verifica si el usuario puede acceder a los movimientos de un depósito específico.
// - Admin (rol='admin') o sin depósito asignado: acceso total.
// - Usuario con depósito asignado: solo puede ver el suyo.
// Devuelve null si tiene acceso, o un mensaje de error si no.
function _verificarAccesoDeposito(u, deposito_tipo, proveedor_id) {
  if (!u) return 'No autenticado';
  if (u.rol === 'admin') return null;
  if (!u.deposito_tipo) return null; // usuarios sin depósito asignado se tratan como internos/admin
  if (deposito_tipo === 'proveedor') {
    if (u.deposito_tipo !== 'proveedor' || u.deposito_proveedor_id !== proveedor_id) {
      return 'No tenés acceso a los movimientos de este proveedor';
    }
  } else if (deposito_tipo === 'san_geronimo') {
    if (u.deposito_tipo !== 'san_geronimo') {
      return 'No tenés acceso a los movimientos de San Gerónimo';
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// TALONARIOS
// ════════════════════════════════════════════════════════════════════════════

router.get('/talonarios', function(req, res) {
  const rows = db.prepare(`
    SELECT t.*,
      p.nombre AS proveedor_nombre,
      (SELECT COUNT(*) FROM ifco_remitos_super r WHERE r.talonario_id = t.id AND r.eliminado_en IS NULL) AS usados_count,
      (SELECT COUNT(*) FROM ifco_numeros_anulados a WHERE a.talonario_id = t.id) AS anulados_count
    FROM ifco_talonarios t
    LEFT JOIN proveedores p ON p.id = t.proveedor_id
    ORDER BY t.activo DESC, t.creado_en DESC
  `).all();
  res.json(rows);
});

router.get('/talonarios/activo', function(req, res) {
  // Filtro por dueño:
  //   ?dueno=san_geronimo  → activo de SG
  //   ?proveedor_id=X      → activo asignado a ese proveedor
  //   sin params           → primer activo (compatibilidad)
  const dueno = req.query.dueno;
  const provId = req.query.proveedor_id ? parseInt(req.query.proveedor_id) : null;
  let q = "SELECT t.*, p.nombre AS proveedor_nombre FROM ifco_talonarios t LEFT JOIN proveedores p ON p.id = t.proveedor_id WHERE t.activo = 1";
  const params = [];
  if (dueno === 'san_geronimo') {
    q += " AND t.dueno_tipo = 'san_geronimo'";
  } else if (provId) {
    q += " AND t.dueno_tipo = 'proveedor' AND t.proveedor_id = ?";
    params.push(provId);
  }
  q += " ORDER BY t.creado_en DESC LIMIT 1";
  const t = db.prepare(q).get(...params);
  if (!t) return res.json({ talonario: null, proximo: null, disponibles: 0 });
  res.json(_calcInfoTalonario(t));
});

// /talonarios/activos — TODOS los activos del dueño (no solo el primero), cada uno con su info de próximo número
router.get('/talonarios/activos', function(req, res) {
  const dueno = req.query.dueno;
  const provId = req.query.proveedor_id ? parseInt(req.query.proveedor_id) : null;
  let q = "SELECT t.*, p.nombre AS proveedor_nombre FROM ifco_talonarios t LEFT JOIN proveedores p ON p.id = t.proveedor_id WHERE t.activo = 1";
  const params = [];
  if (dueno === 'san_geronimo') {
    q += " AND t.dueno_tipo = 'san_geronimo'";
  } else if (provId) {
    q += " AND t.dueno_tipo = 'proveedor' AND t.proveedor_id = ?";
    params.push(provId);
  }
  q += " ORDER BY t.serie ASC, t.id ASC";
  const ts = db.prepare(q).all(...params);
  res.json(ts.map(_calcInfoTalonario));
});

// Helper: calcula próximo número, disponibles, etc para un talonario dado
function _calcInfoTalonario(t) {
  const ultimo = db.prepare(`
    SELECT n_remito_ifco FROM ifco_remitos_super
    WHERE talonario_id = ? AND eliminado_en IS NULL ORDER BY id DESC LIMIT 1
  `).get(t.id);
  let proximoNum = t.numero_desde;
  if (ultimo) {
    const m = String(ultimo.n_remito_ifco).match(/-(\d+)$/);
    if (m) proximoNum = parseInt(m[1], 10) + 1;
  }
  const agotado = proximoNum > t.numero_hasta;
  const disponibles = agotado ? 0 : (t.numero_hasta - proximoNum + 1);
  const proximoStr = agotado ? null : (t.serie + '-' + String(proximoNum).padStart(8, '0'));
  let dias_cai = null;
  if (t.vto_cai) {
    dias_cai = Math.floor((new Date(t.vto_cai) - new Date()) / (1000*60*60*24));
  }
  return {
    talonario: t,
    proximo: proximoStr,
    proximo_num: agotado ? null : proximoNum,
    disponibles: disponibles,
    agotado: agotado,
    dias_cai: dias_cai,
    cai_alerta: dias_cai !== null && dias_cai < 60,
    pocos_remitos: disponibles > 0 && disponibles < 100
  };
}

// Endpoint viejo compat (lo dejamos como wrapper aunque el cuerpo ahora vive en _calcInfoTalonario):
// (sin endpoint legacy adicional — la API queda con /talonarios/activo y /talonarios/activos)

router.post('/talonarios', function(req, res) {
  const d = req.body || {};
  if (!d.serie || !d.numero_desde || !d.numero_hasta) {
    return res.status(400).json({ error: 'Faltan datos obligatorios (serie, rango)' });
  }
  if (parseInt(d.numero_hasta) < parseInt(d.numero_desde)) {
    return res.status(400).json({ error: 'numero_hasta debe ser mayor o igual a numero_desde' });
  }
  // Dueño
  const dueno_tipo = (d.dueno_tipo === 'proveedor') ? 'proveedor' : 'san_geronimo';
  let proveedor_id = null;
  if (dueno_tipo === 'proveedor') {
    proveedor_id = parseInt(d.proveedor_id) || null;
    if (!proveedor_id) return res.status(400).json({ error: 'Si el talonario lo administra un proveedor, hay que indicar cuál' });
    const exProv = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(proveedor_id);
    if (!exProv) return res.status(400).json({ error: 'Proveedor inexistente' });
  }
  // Múltiples talonarios activos por dueño están permitidos. El usuario elige cuál usar al despachar.
  const r = db.prepare(`
    INSERT INTO ifco_talonarios (serie, numero_desde, numero_hasta, cai, vto_cai, activo, notas, dueno_tipo, proveedor_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(d.serie, parseInt(d.numero_desde), parseInt(d.numero_hasta),
         d.cai || null, d.vto_cai || null, d.activo ? 1 : 0, d.notas || null,
         dueno_tipo, proveedor_id);
  // Log inicial: creación con su dueño
  db.prepare(`
    INSERT INTO ifco_talonarios_log
      (talonario_id, dueno_anterior_tipo, dueno_anterior_id, dueno_nuevo_tipo, dueno_nuevo_id, usuario_id, notas)
    VALUES (?, NULL, NULL, ?, ?, ?, 'Alta del talonario')
  `).run(r.lastInsertRowid, dueno_tipo, proveedor_id, req.user.id || null);
  res.json({ id: r.lastInsertRowid });
});

// IMPORTAR talonarios masivamente (carga histórica) + backfill de despachos viejos.
// Recibe { items: [{serie, numero_desde, numero_hasta, cai?, vto_cai?, activo?, notas?, dueno_tipo?, proveedor_id?}, ...] }
// Por cada talonario que se inserta, vincula automáticamente los despachos existentes
// que matchean por serie + número en rango (y mismo dueño).
router.post('/talonarios/import', express.json({ limit: '2mb' }), function(req, res) {
  if (!req.user || req.user.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo admin puede importar talonarios masivamente' });
  }
  const items = (req.body && Array.isArray(req.body.items)) ? req.body.items : [];
  if (items.length === 0) return res.status(400).json({ error: 'No hay items para importar' });
  if (items.length > 500) return res.status(400).json({ error: 'Demasiados items en una sola importación (máx 500)' });

  const result = {
    total: items.length,
    creados: 0,
    duplicados: 0,
    errores: [],
    vinculados_despachos: 0,
    detalle: []
  };

  const insTal = db.prepare(`
    INSERT INTO ifco_talonarios (serie, numero_desde, numero_hasta, cai, vto_cai, activo, notas, dueno_tipo, proveedor_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insLog = db.prepare(`
    INSERT INTO ifco_talonarios_log
      (talonario_id, dueno_anterior_tipo, dueno_anterior_id, dueno_nuevo_tipo, dueno_nuevo_id, usuario_id, notas)
    VALUES (?, NULL, NULL, ?, ?, ?, 'Importación histórica masiva')
  `);
  const checkDup = db.prepare(`
    SELECT id FROM ifco_talonarios
    WHERE serie = ? AND numero_desde = ? AND numero_hasta = ? AND dueno_tipo = ?
      AND ((proveedor_id IS NULL AND ? IS NULL) OR proveedor_id = ?)
  `);

  // Backfill: actualiza ifco_remitos_super donde talonario_id IS NULL y matchea
  const backfillSG = db.prepare(`
    UPDATE ifco_remitos_super
    SET talonario_id = ?
    WHERE talonario_id IS NULL
      AND eliminado_en IS NULL
      AND origen = 'san_geronimo'
      AND substr(n_remito_ifco, 1, instr(n_remito_ifco, '-') - 1) = ?
      AND CAST(substr(n_remito_ifco, instr(n_remito_ifco, '-') + 1) AS INTEGER) BETWEEN ? AND ?
  `);
  const backfillProv = db.prepare(`
    UPDATE ifco_remitos_super
    SET talonario_id = ?
    WHERE talonario_id IS NULL
      AND eliminado_en IS NULL
      AND origen = 'proveedor_directo'
      AND proveedor_origen_id = ?
      AND substr(n_remito_ifco, 1, instr(n_remito_ifco, '-') - 1) = ?
      AND CAST(substr(n_remito_ifco, instr(n_remito_ifco, '-') + 1) AS INTEGER) BETWEEN ? AND ?
  `);

  const tx = db.transaction(function(items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i] || {};
      const idx = i + 1;

      // Validaciones
      const serie = item.serie ? String(item.serie).trim() : '';
      if (!serie) { result.errores.push({ fila: idx, error: 'Falta serie' }); continue; }
      const desde = parseInt(item.numero_desde);
      const hasta = parseInt(item.numero_hasta);
      if (isNaN(desde) || isNaN(hasta)) { result.errores.push({ fila: idx, error: 'numero_desde / numero_hasta inválidos' }); continue; }
      if (hasta < desde)               { result.errores.push({ fila: idx, error: 'numero_hasta < numero_desde' }); continue; }

      const dueno_tipo = (item.dueno_tipo === 'proveedor') ? 'proveedor' : 'san_geronimo';
      let proveedor_id = null;
      if (dueno_tipo === 'proveedor') {
        proveedor_id = parseInt(item.proveedor_id) || null;
        if (!proveedor_id) { result.errores.push({ fila: idx, error: 'Falta proveedor_id (dueno=proveedor)' }); continue; }
        const exProv = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(proveedor_id);
        if (!exProv) { result.errores.push({ fila: idx, error: 'Proveedor inexistente: ' + proveedor_id }); continue; }
      }

      // Duplicado exacto?
      const dup = checkDup.get(serie, desde, hasta, dueno_tipo, proveedor_id, proveedor_id);
      if (dup) { result.duplicados++; continue; }

      // Insertar
      const rIns = insTal.run(
        serie, desde, hasta,
        item.cai || null,
        item.vto_cai || null,
        item.activo ? 1 : 0,
        item.notas || null,
        dueno_tipo,
        proveedor_id
      );
      const newId = rIns.lastInsertRowid;
      result.creados++;
      try { insLog.run(newId, dueno_tipo, proveedor_id, (req.user && req.user.id) || null); } catch(_){}

      // Backfill de despachos viejos (ya cargados sin talonario_id)
      let vinculados = 0;
      try {
        if (dueno_tipo === 'san_geronimo') {
          vinculados = backfillSG.run(newId, serie, desde, hasta).changes || 0;
        } else {
          vinculados = backfillProv.run(newId, proveedor_id, serie, desde, hasta).changes || 0;
        }
      } catch(e) {
        console.error('[IFCO][import backfill]:', e.message);
      }
      result.vinculados_despachos += vinculados;
      result.detalle.push({ id: newId, serie, desde, hasta, dueno_tipo, proveedor_id, vinculados });
    }
  });

  try {
    tx(items);
    res.json(result);
  } catch(e) {
    console.error('[IFCO][talonarios/import]:', e);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/talonarios/:id', function(req, res) {
  const d = req.body || {};
  const id = req.params.id;
  const actual = db.prepare("SELECT * FROM ifco_talonarios WHERE id = ?").get(id);
  if (!actual) return res.status(404).json({ error: 'Talonario no encontrado' });

  // Si quieren editar serie/rango, validar que no tenga remitos asociados
  const quiereEditarRango = (d.serie !== undefined || d.numero_desde !== undefined || d.numero_hasta !== undefined);
  if (quiereEditarRango) {
    const usado = db.prepare("SELECT COUNT(*) as n FROM ifco_remitos_super WHERE talonario_id = ?").get(id);
    if (usado.n > 0) return res.status(400).json({ error: 'No se puede editar serie/rango: el talonario tiene ' + usado.n + ' remito(s) asociados.' });
    // Si vienen ambos, validar
    const nd = d.numero_desde !== undefined ? parseInt(d.numero_desde) : actual.numero_desde;
    const nh = d.numero_hasta !== undefined ? parseInt(d.numero_hasta) : actual.numero_hasta;
    if (nh < nd) return res.status(400).json({ error: 'numero_hasta debe ser ≥ numero_desde' });
  }

  // Múltiples talonarios activos por dueño permitidos: NO se desactivan otros automáticamente.
  const sets = [], params = { id };
  if (d.serie         !== undefined) { sets.push("serie = @serie");                 params.serie         = d.serie; }
  if (d.numero_desde  !== undefined) { sets.push("numero_desde = @numero_desde");   params.numero_desde  = parseInt(d.numero_desde); }
  if (d.numero_hasta  !== undefined) { sets.push("numero_hasta = @numero_hasta");   params.numero_hasta  = parseInt(d.numero_hasta); }
  if (d.activo        !== undefined) { sets.push("activo = @activo");               params.activo        = d.activo ? 1 : 0; }
  if (d.cai           !== undefined) { sets.push("cai = @cai");                     params.cai           = d.cai; }
  if (d.vto_cai       !== undefined) { sets.push("vto_cai = @vto_cai");             params.vto_cai       = d.vto_cai; }
  if (d.notas         !== undefined) { sets.push("notas = @notas");                 params.notas         = d.notas; }
  if (sets.length === 0) return res.json({ ok: true });
  db.prepare(`UPDATE ifco_talonarios SET ${sets.join(", ")} WHERE id = @id`).run(params);
  res.json({ ok: true });
});

// Transferir un talonario a otro dueño (SG ↔ Proveedor o entre proveedores)
router.post('/talonarios/:id/transferir', function(req, res) {
  const id = req.params.id;
  const d = req.body || {};
  const actual = db.prepare("SELECT * FROM ifco_talonarios WHERE id = ?").get(id);
  if (!actual) return res.status(404).json({ error: 'Talonario no encontrado' });

  const nuevo_tipo = (d.dueno_tipo === 'proveedor') ? 'proveedor' : 'san_geronimo';
  let nuevo_prov_id = null;
  if (nuevo_tipo === 'proveedor') {
    nuevo_prov_id = parseInt(d.proveedor_id) || null;
    if (!nuevo_prov_id) return res.status(400).json({ error: 'Indicá el proveedor destino' });
    const exProv = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(nuevo_prov_id);
    if (!exProv) return res.status(400).json({ error: 'Proveedor destino inexistente' });
  }
  // Si el destino es igual al origen, no hacemos nada
  if (actual.dueno_tipo === nuevo_tipo && (actual.proveedor_id || null) === (nuevo_prov_id || null)) {
    return res.status(400).json({ error: 'El destino es igual al origen' });
  }

  const tx = db.transaction(() => {
    // Al transferir, lo dejamos inactivo: el receptor decide si lo activa.
    db.prepare("UPDATE ifco_talonarios SET dueno_tipo = ?, proveedor_id = ?, activo = 0 WHERE id = ?")
      .run(nuevo_tipo, nuevo_prov_id, id);
    db.prepare(`
      INSERT INTO ifco_talonarios_log
        (talonario_id, dueno_anterior_tipo, dueno_anterior_id, dueno_nuevo_tipo, dueno_nuevo_id, usuario_id, notas)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, actual.dueno_tipo, actual.proveedor_id || null,
           nuevo_tipo, nuevo_prov_id, req.user.id || null, d.notas || null);
  });
  tx();
  res.json({ ok: true });
});

// Detalle del talonario: estado de cada n° del rango
router.get('/talonarios/:id', function(req, res) {
  const t = db.prepare(`
    SELECT t.*, p.nombre AS proveedor_nombre,
           (SELECT COUNT(*) FROM ifco_remitos_super r WHERE r.talonario_id = t.id AND r.eliminado_en IS NULL) AS usados_count
    FROM ifco_talonarios t LEFT JOIN proveedores p ON p.id = t.proveedor_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'No encontrado' });
  res.json(t);
});

router.get('/talonarios/:id/detalle', function(req, res) {
  const id = req.params.id;
  const t = db.prepare(`
    SELECT t.*, p.nombre AS proveedor_nombre
    FROM ifco_talonarios t
    LEFT JOIN proveedores p ON p.id = t.proveedor_id
    WHERE t.id = ?
  `).get(id);
  if (!t) return res.status(404).json({ error: 'Talonario no encontrado' });

  // Todos los remitos asociados (incluye papelera, marcados)
  const remitos = db.prepare(`
    SELECT r.id, r.n_remito_ifco, r.fecha_emision, r.estado, r.cantidad_despachada,
           r.empresa, r.sucursal, r.eliminado_en
    FROM ifco_remitos_super r
    WHERE r.talonario_id = ?
  `).all(id);
  // Index por número final
  const byNum = {};
  for (const r of remitos) {
    const m = String(r.n_remito_ifco).match(/-(\d+)$/);
    if (m) byNum[parseInt(m[1], 10)] = r;
  }

  // Lista de números anulados manualmente (mal impresos, etc.)
  const anulados = db.prepare(`
    SELECT a.numero, a.motivo, a.anulado_en, u.nombre AS anulado_por_username
    FROM ifco_numeros_anulados a
    LEFT JOIN usuarios u ON u.id = a.anulado_por_id
    WHERE a.talonario_id = ?
  `).all(id);
  const anuladosMap = {};
  for (const a of anulados) anuladosMap[a.numero] = a;

  // Construir lista del rango
  const numeros = [];
  for (let n = t.numero_desde; n <= t.numero_hasta; n++) {
    const r = byNum[n];
    const numStr = t.serie + '-' + String(n).padStart(8, '0');
    const anulMan = anuladosMap[n];
    if (anulMan) {
      // Anulación manual prevalece sobre cualquier estado (no debería haber remito activo
      // en un número anulado pero igual lo mostramos como anulado).
      numeros.push({
        numero: n, n_remito_ifco: numStr, estado: 'anulado_manual',
        motivo: anulMan.motivo, anulado_en: anulMan.anulado_en,
        anulado_por_username: anulMan.anulado_por_username
      });
    } else if (!r) {
      numeros.push({ numero: n, n_remito_ifco: numStr, estado: 'disponible' });
    } else if (r.eliminado_en) {
      numeros.push({
        numero: n, n_remito_ifco: numStr, estado: 'anulado',
        remito_id: r.id, fecha_emision: r.fecha_emision, empresa: r.empresa, sucursal: r.sucursal,
        cantidad_despachada: r.cantidad_despachada
      });
    } else {
      numeros.push({
        numero: n, n_remito_ifco: numStr, estado: r.estado,
        remito_id: r.id, fecha_emision: r.fecha_emision, empresa: r.empresa, sucursal: r.sucursal,
        cantidad_despachada: r.cantidad_despachada
      });
    }
  }

  // Log de transferencias
  const log = db.prepare(`
    SELECT l.*, u.nombre AS usuario_nombre,
           pa.nombre AS prov_anterior_nombre,
           pn.nombre AS prov_nuevo_nombre
    FROM ifco_talonarios_log l
    LEFT JOIN usuarios u ON u.id = l.usuario_id
    LEFT JOIN proveedores pa ON pa.id = l.dueno_anterior_id
    LEFT JOIN proveedores pn ON pn.id = l.dueno_nuevo_id
    WHERE l.talonario_id = ?
    ORDER BY l.fecha DESC
  `).all(id);

  res.json({ talonario: t, numeros: numeros, log: log });
});

// Anular un número específico de un talonario (caso: mal impreso, manchado, etc.)
// Solo se pueden anular números SIN USAR (sin remito asociado, ni eliminado).
// El número queda registrado con motivo y usuario que lo anuló.
router.post('/talonarios/:id/anular-numero', express.json(), function(req, res) {
  const talonario_id = parseInt(req.params.id);
  const numero = parseInt(req.body && req.body.numero);
  const motivo = (req.body && req.body.motivo) ? String(req.body.motivo).trim() : null;
  if (!numero) return res.status(400).json({ error: 'Falta numero' });

  // Validar talonario existente
  const t = db.prepare("SELECT * FROM ifco_talonarios WHERE id = ?").get(talonario_id);
  if (!t) return res.status(404).json({ error: 'Talonario no encontrado' });

  // Validar rango
  if (numero < t.numero_desde || numero > t.numero_hasta) {
    return res.status(400).json({ error: 'El número está fuera del rango del talonario (' + t.numero_desde + '–' + t.numero_hasta + ')' });
  }

  // Validar que no esté usado (que no haya un remito activo con ese número del mismo talonario)
  const numStr = t.serie + '-' + String(numero).padStart(8, '0');
  const yaUsado = db.prepare(`
    SELECT id, estado, eliminado_en FROM ifco_remitos_super
    WHERE talonario_id = ? AND n_remito_ifco = ? AND eliminado_en IS NULL
  `).get(talonario_id, numStr);
  if (yaUsado) {
    return res.status(400).json({ error: 'Ese número ya tiene un despacho activo (estado: ' + yaUsado.estado + '). No se puede anular por esta vía — eliminá el despacho desde la pestaña Despachos.' });
  }

  // Validar que no esté ya anulado
  const yaAnulado = db.prepare("SELECT id FROM ifco_numeros_anulados WHERE talonario_id = ? AND numero = ?").get(talonario_id, numero);
  if (yaAnulado) return res.status(400).json({ error: 'Ese número ya está anulado' });

  try {
    const r = db.prepare(`
      INSERT INTO ifco_numeros_anulados (talonario_id, numero, motivo, anulado_por_id)
      VALUES (?, ?, ?, ?)
    `).run(talonario_id, numero, motivo, (req.user && req.user.id) || null);
    res.json({ id: r.lastInsertRowid, n_remito_ifco: numStr });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Des-anular un número (revertir, en caso de haber anulado por error)
router.delete('/talonarios/:id/anular-numero/:numero', function(req, res) {
  if (!req.user || req.user.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo admin puede des-anular números' });
  }
  const talonario_id = parseInt(req.params.id);
  const numero = parseInt(req.params.numero);
  try {
    const r = db.prepare("DELETE FROM ifco_numeros_anulados WHERE talonario_id = ? AND numero = ?").run(talonario_id, numero);
    if (r.changes === 0) return res.status(404).json({ error: 'No estaba anulado' });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/talonarios/:id', function(req, res) {
  try {
    if (!req.user || req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo admin puede eliminar talonarios' });
    const t = db.prepare("SELECT id FROM ifco_talonarios WHERE id = ?").get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Talonario no encontrado' });
    const usado = db.prepare("SELECT COUNT(*) as n FROM ifco_remitos_super WHERE talonario_id = ?")
                    .get(req.params.id);
    if (usado.n > 0) return res.status(400).json({ error: 'Talonario con ' + usado.n + ' remito(s) asociados — desactivar en su lugar' });
    // Borrar en transacción: primero los logs (FK), después el talonario
    const tx = db.transaction(function(id) {
      db.prepare("DELETE FROM ifco_talonarios_log WHERE talonario_id = ?").run(id);
      db.prepare("DELETE FROM ifco_talonarios WHERE id = ?").run(id);
    });
    tx(req.params.id);
    res.json({ ok: true });
  } catch(e) {
    console.error('[IFCO][talonarios DELETE] EXCEPCION:', e);
    res.status(500).json({ error: 'Error eliminando: ' + e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// REMITOS A SUPERMERCADO
// ════════════════════════════════════════════════════════════════════════════

router.get('/remitos', function(req, res) {
  const f = req.query;
  const papelera = f.papelera === '1' || f.incluir_eliminados === '1';
  let q = `SELECT r.*,
                  pori.nombre AS proveedor_origen_nombre,
                  u.nombre AS eliminado_por_username,
                  uc.nombre AS usuario_creador_nombre
           FROM ifco_remitos_super r
           LEFT JOIN proveedores pori ON pori.id = r.proveedor_origen_id
           LEFT JOIN usuarios u ON u.id = r.eliminado_por_id
           LEFT JOIN usuarios uc ON uc.id = r.usuario_id
           WHERE 1=1`;
  const p = [];
  if (papelera) {
    q += " AND r.eliminado_en IS NOT NULL";
  } else {
    q += " AND r.eliminado_en IS NULL";
  }
  if (f.estado)     { q += " AND r.estado = ?";        p.push(f.estado); }
  if (f.cliente_id) { q += " AND r.cliente_id = ?";    p.push(f.cliente_id); }
  if (f.desde)      { q += " AND r.fecha_emision >= ?"; p.push(f.desde); }
  if (f.hasta)      { q += " AND r.fecha_emision <= ?"; p.push(f.hasta); }
  if (f.search)     {
    // Búsqueda flexible: matchea (1) el N° literal, (2) la empresa, (3) el N° sin ceros leading.
    // Esto evita que el usuario tenga que tipear los ceros del prefijo de serie:
    // "1579690" encuentra "00015-01579690", "15-1579" encuentra "00015-01579690", etc.
    q += ` AND (
      r.n_remito_ifco LIKE ?
      OR r.empresa LIKE ?
      OR REPLACE(r.n_remito_ifco, '-', '') LIKE ?
      OR CAST(CAST(SUBSTR(r.n_remito_ifco, INSTR(r.n_remito_ifco,'-')+1) AS INTEGER) AS TEXT) LIKE ?
    )`;
    const wild = '%' + f.search + '%';
    p.push(wild, wild, wild, wild);
  }
  q += " ORDER BY r.fecha_emision DESC, r.id DESC LIMIT 500";
  res.json(db.prepare(q).all(...p));
});

router.get('/remitos/:id', function(req, res) {
  const r = db.prepare(`
    SELECT r.*, pori.nombre AS proveedor_origen_nombre
    FROM ifco_remitos_super r
    LEFT JOIN proveedores pori ON pori.id = r.proveedor_origen_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  res.json(r);
});

// Infiere el talonario_id automáticamente desde el N° de remito IFCO.
// El N° tiene formato "SERIE-NNNNNNNN" (ej: "00015-01639431").
// Matchea por: serie + dueño (san_geronimo o proveedor) + número en rango + activo.
// Devuelve el id del talonario, o null si no hay match.
function _inferirTalonarioId(n_remito_ifco, origen, proveedor_origen_id) {
  if (!n_remito_ifco) return null;
  const partes = String(n_remito_ifco).split('-');
  if (partes.length < 2) return null;
  const serie = partes[0].trim();
  const numero = parseInt(String(partes.slice(1).join('-')).replace(/\D/g, ''));
  if (!serie || isNaN(numero)) return null;

  let q = `
    SELECT id FROM ifco_talonarios
    WHERE serie = ?
      AND ? BETWEEN numero_desde AND numero_hasta
  `;
  const params = [serie, numero];
  if (origen === 'proveedor_directo' && proveedor_origen_id) {
    q += ' AND dueno_tipo = \'proveedor\' AND proveedor_id = ?';
    params.push(proveedor_origen_id);
  } else {
    q += ' AND dueno_tipo = \'san_geronimo\'';
  }
  q += ' ORDER BY id ASC LIMIT 1';
  try {
    const row = db.prepare(q).get(...params);
    return row ? row.id : null;
  } catch(e) {
    console.error('[IFCO][_inferirTalonarioId]:', e.message);
    return null;
  }
}

router.post('/remitos', upload.single('escaneo_original'), function(req, res) {
  const d = req.body || {};
  if (!d.n_remito_ifco)   return res.status(400).json({ error: 'N° de remito IFCO requerido' });
  if (!d.fecha_emision)   return res.status(400).json({ error: 'Fecha de emisión requerida' });
  if (!d.cantidad_despachada || parseInt(d.cantidad_despachada) <= 0) {
    return res.status(400).json({ error: 'Cantidad despachada inválida' });
  }
  if (!d.cliente_id && !d.empresa) {
    return res.status(400).json({ error: 'Cliente (Dedicado) o empresa requeridos' });
  }

  // Origen: san_geronimo (default) o proveedor_directo (con proveedor_id)
  const origen = (d.origen === 'proveedor_directo') ? 'proveedor_directo' : 'san_geronimo';
  let proveedor_origen_id = null;
  if (origen === 'proveedor_directo') {
    proveedor_origen_id = parseInt(d.proveedor_origen_id) || null;
    if (!proveedor_origen_id) return res.status(400).json({ error: 'Origen "directo desde proveedor" requiere proveedor_origen_id' });
    const exProv = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(proveedor_origen_id);
    if (!exProv) return res.status(400).json({ error: 'Proveedor de origen inexistente' });
  }

  // Unicidad: solo entre activos (no cuenta papelera)
  const dup = db.prepare("SELECT id FROM ifco_remitos_super WHERE n_remito_ifco = ? AND eliminado_en IS NULL").get(d.n_remito_ifco);
  if (dup) return res.status(409).json({ error: 'Ya existe un remito con ese número (activo). Si está en papelera, restauralo o usá otro número.' });

  // Foto: file > body path
  let escaneo_original_path = null;
  if (req.file) {
    escaneo_original_path = '/data/ifco/' + req.file.filename;
  } else if (d.escaneo_original_path && /^\/data\/ifco\//.test(d.escaneo_original_path)) {
    escaneo_original_path = d.escaneo_original_path;
  }

  try {
    const r = db.prepare(`
      INSERT INTO ifco_remitos_super (
        n_remito_ifco, n_remito_sg, fecha_emision, cliente_id, cliente_telefono, empresa, sucursal,
        modelo, cantidad_despachada, producto, transportista,
        encargado_prov_apellido, encargado_prov_nombre, encargado_prov_dni,
        talonario_id, notas, usuario_id, estado, escaneo_original_path,
        origen, proveedor_origen_id
      ) VALUES (
        @n_remito_ifco, @n_remito_sg, @fecha_emision, @cliente_id, @cliente_telefono, @empresa, @sucursal,
        @modelo, @cantidad_despachada, @producto, @transportista,
        @encargado_prov_apellido, @encargado_prov_nombre, @encargado_prov_dni,
        @talonario_id, @notas, @usuario_id, 'despachado', @escaneo_original_path,
        @origen, @proveedor_origen_id
      )
    `).run({
      n_remito_ifco:           d.n_remito_ifco,
      n_remito_sg:             d.n_remito_sg ? String(d.n_remito_sg).trim() : null,
      fecha_emision:           d.fecha_emision,
      cliente_id:              d.cliente_id || null,
      cliente_telefono:        d.cliente_telefono || null,
      empresa:                 d.empresa || null,
      sucursal:                d.sucursal || null,
      modelo:                  d.modelo || '6420',
      cantidad_despachada:     parseInt(d.cantidad_despachada),
      producto:                d.producto || null,
      transportista:           d.transportista || null,
      encargado_prov_apellido: d.encargado_prov_apellido || null,
      encargado_prov_nombre:   d.encargado_prov_nombre || null,
      encargado_prov_dni:      d.encargado_prov_dni || null,
      talonario_id:            d.talonario_id || _inferirTalonarioId(d.n_remito_ifco, origen, proveedor_origen_id),
      notas:                   d.notas || null,
      usuario_id:              req.user.id || null,
      escaneo_original_path:   escaneo_original_path,
      origen:                  origen,
      proveedor_origen_id:     proveedor_origen_id
    });
    res.json({ id: r.lastInsertRowid, n_remito_ifco: d.n_remito_ifco, escaneo_original_path: escaneo_original_path, origen: origen });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// CREACIÓN DIRECTA EN ESTADO SELLADO
// Para casos donde nunca se cargó el remito al despacharlo y solo tenemos la foto del remito ya vuelto sellado.
router.post('/remitos/sellado-directo', upload.single('escaneo'), function(req, res) {
  const d = req.body || {};
  // Validaciones del despacho
  if (!d.n_remito_ifco)   return res.status(400).json({ error: 'N° de remito IFCO requerido' });
  if (!d.fecha_emision)   return res.status(400).json({ error: 'Fecha de emisión requerida' });
  if (!d.cantidad_despachada || parseInt(d.cantidad_despachada) <= 0) {
    return res.status(400).json({ error: 'Cantidad despachada inválida' });
  }
  if (!d.cliente_id && !d.empresa) {
    return res.status(400).json({ error: 'Cliente (Dedicado) o empresa requeridos' });
  }
  // Validaciones del sellado
  if (!d.fecha_sellado) return res.status(400).json({ error: 'Fecha de sellado requerida' });
  const cantDesp = parseInt(d.cantidad_despachada);
  const recibida  = d.cantidad_recibida  != null && d.cantidad_recibida  !== '' ? parseInt(d.cantidad_recibida)  : cantDesp;
  const rechazada = d.cantidad_rechazada != null && d.cantidad_rechazada !== '' ? parseInt(d.cantidad_rechazada) : 0;
  if (recibida < 0 || rechazada < 0) {
    return res.status(400).json({ error: 'Cantidades no pueden ser negativas' });
  }
  if (recibida + rechazada > cantDesp) {
    return res.status(400).json({ error: 'Recibida + rechazada superan la cantidad despachada' });
  }

  // Origen
  const origen = (d.origen === 'proveedor_directo') ? 'proveedor_directo' : 'san_geronimo';
  let proveedor_origen_id = null;
  if (origen === 'proveedor_directo') {
    proveedor_origen_id = parseInt(d.proveedor_origen_id) || null;
    if (!proveedor_origen_id) return res.status(400).json({ error: 'Origen "directo desde proveedor" requiere proveedor_origen_id' });
    const exProv = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(proveedor_origen_id);
    if (!exProv) return res.status(400).json({ error: 'Proveedor de origen inexistente' });
  }

  // Unicidad
  const dup = db.prepare("SELECT id FROM ifco_remitos_super WHERE n_remito_ifco = ? AND eliminado_en IS NULL").get(d.n_remito_ifco);
  if (dup) return res.status(409).json({ error: 'Ya existe un remito con ese número (activo). Si está en papelera, restauralo o usá otro número.' });

  // Foto del sellado: file > body path (no exigimos foto de despacho)
  let escaneo_path = null;
  if (req.file) {
    escaneo_path = '/data/ifco/' + req.file.filename;
  } else if (d.escaneo_path && /^\/data\/ifco\//.test(d.escaneo_path)) {
    escaneo_path = d.escaneo_path;
  }

  // Destino del rechazo: si hay rechazo > 0, debe especificarse
  let rechazo_destino = null;
  if (rechazada > 0) {
    rechazo_destino = d.rechazo_destino || 'san_geronimo';
    if (['san_geronimo','proveedor'].indexOf(rechazo_destino) < 0) {
      return res.status(400).json({ error: 'rechazo_destino debe ser "san_geronimo" o "proveedor"' });
    }
  }

  // Si TODO lo despachado fue rechazado, va directo a estado 'presentado' (no hay nada que presentar a IFCO)
  const todoRechazadoSD = (rechazada > 0 && rechazada >= cantDesp);
  const estadoSD = todoRechazadoSD ? 'presentado' : 'sellado';
  const fechaPresentadoSD = todoRechazadoSD ? new Date().toISOString().slice(0,10) : null;

  try {
    const r = db.prepare(`
      INSERT INTO ifco_remitos_super (
        n_remito_ifco, n_remito_sg, fecha_emision, cliente_id, cliente_telefono, empresa, sucursal,
        modelo, cantidad_despachada, cantidad_recibida, cantidad_rechazada,
        producto, transportista,
        encargado_prov_apellido, encargado_prov_nombre, encargado_prov_dni,
        encargado_super_apellido, encargado_super_nombre, encargado_super_dni,
        talonario_id, notas, usuario_id, estado,
        escaneo_path, fecha_sellado, fecha_presentado,
        origen, proveedor_origen_id, rechazo_destino
      ) VALUES (
        @n_remito_ifco, @n_remito_sg, @fecha_emision, @cliente_id, @cliente_telefono, @empresa, @sucursal,
        @modelo, @cantidad_despachada, @cantidad_recibida, @cantidad_rechazada,
        @producto, @transportista,
        @encargado_prov_apellido, @encargado_prov_nombre, @encargado_prov_dni,
        @encargado_super_apellido, @encargado_super_nombre, @encargado_super_dni,
        @talonario_id, @notas, @usuario_id, @estado,
        @escaneo_path, @fecha_sellado, @fecha_presentado,
        @origen, @proveedor_origen_id, @rechazo_destino
      )
    `).run({
      n_remito_ifco:           d.n_remito_ifco,
      n_remito_sg:             d.n_remito_sg ? String(d.n_remito_sg).trim() : null,
      fecha_emision:           d.fecha_emision,
      cliente_id:              d.cliente_id || null,
      cliente_telefono:        d.cliente_telefono || null,
      empresa:                 d.empresa || null,
      sucursal:                d.sucursal || null,
      modelo:                  d.modelo || '6420',
      cantidad_despachada:     cantDesp,
      cantidad_recibida:       recibida,
      cantidad_rechazada:      rechazada,
      producto:                d.producto || null,
      transportista:           d.transportista || null,
      encargado_prov_apellido: d.encargado_prov_apellido || null,
      encargado_prov_nombre:   d.encargado_prov_nombre || null,
      encargado_prov_dni:      d.encargado_prov_dni || null,
      encargado_super_apellido: d.encargado_super_apellido || null,
      encargado_super_nombre:   d.encargado_super_nombre   || null,
      encargado_super_dni:      d.encargado_super_dni      || null,
      talonario_id:            d.talonario_id || _inferirTalonarioId(d.n_remito_ifco, origen, proveedor_origen_id),
      notas:                   d.notas || null,
      usuario_id:              req.user.id || null,
      estado:                  estadoSD,
      escaneo_path:            escaneo_path,
      fecha_sellado:           d.fecha_sellado,
      fecha_presentado:        fechaPresentadoSD,
      origen:                  origen,
      proveedor_origen_id:     proveedor_origen_id,
      rechazo_destino:         rechazo_destino
    });
    res.json({ id: r.lastInsertRowid, n_remito_ifco: d.n_remito_ifco, escaneo_path: escaneo_path, estado: estadoSD, origen: origen, todo_rechazado: todoRechazadoSD });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/remitos/:id/sellar', upload.single('escaneo'), function(req, res) {
  const id = req.params.id;
  const r = db.prepare("SELECT * FROM ifco_remitos_super WHERE id = ?").get(id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  if (r.estado !== 'despachado' && r.estado !== 'sellado') {
    return res.status(400).json({ error: 'No se puede sellar un remito en estado ' + r.estado });
  }
  const d = req.body || {};
  if (!d.fecha_sellado) return res.status(400).json({ error: 'Fecha de sellado requerida' });

  const recibida  = d.cantidad_recibida  != null ? parseInt(d.cantidad_recibida)  : r.cantidad_despachada;
  const rechazada = d.cantidad_rechazada != null ? parseInt(d.cantidad_rechazada) : 0;
  if (recibida < 0 || rechazada < 0) {
    return res.status(400).json({ error: 'Cantidades no pueden ser negativas' });
  }
  if (recibida + rechazada > r.cantidad_despachada) {
    return res.status(400).json({ error: 'Recibida + rechazada superan la cantidad despachada' });
  }

  let escaneo_path = r.escaneo_path;
  if (req.file) {
    escaneo_path = '/data/ifco/' + req.file.filename;
  } else if (d.escaneo_path && /^\/data\/ifco\//.test(d.escaneo_path)) {
    escaneo_path = d.escaneo_path;
  }

  // Destino del rechazo: si hay rechazo > 0, debe especificarse
  let rechazo_destino = null;
  if (rechazada > 0) {
    rechazo_destino = d.rechazo_destino || 'san_geronimo';
    if (['san_geronimo','proveedor'].indexOf(rechazo_destino) < 0) {
      return res.status(400).json({ error: 'rechazo_destino debe ser "san_geronimo" o "proveedor"' });
    }
  }

  // Si TODO lo despachado fue rechazado, no hay nada que presentar a IFCO:
  // pasa directamente a estado 'presentado' con fecha_presentado = hoy.
  // (Los cajones físicamente vuelven a SG/proveedor según rechazo_destino, pero
  // contablemente el remito queda cerrado.)
  const todoRechazado = (rechazada > 0 && rechazada >= r.cantidad_despachada);
  const estadoFinal      = todoRechazado ? 'presentado' : 'sellado';
  const fechaPresentadoF = todoRechazado ? new Date().toISOString().slice(0,10) : null;

  db.prepare(`
    UPDATE ifco_remitos_super SET
      estado = @estado,
      fecha_sellado = @fecha_sellado,
      fecha_presentado = COALESCE(@fecha_presentado, fecha_presentado),
      encargado_super_apellido = @encargado_super_apellido,
      encargado_super_nombre   = @encargado_super_nombre,
      encargado_super_dni      = @encargado_super_dni,
      cantidad_recibida        = @cantidad_recibida,
      cantidad_rechazada       = @cantidad_rechazada,
      rechazo_destino          = @rechazo_destino,
      escaneo_path             = @escaneo_path,
      actualizado_en           = datetime('now','localtime')
    WHERE id = @id
  `).run({
    id: id,
    estado:                   estadoFinal,
    fecha_sellado:            d.fecha_sellado,
    fecha_presentado:         fechaPresentadoF,
    encargado_super_apellido: d.encargado_super_apellido || null,
    encargado_super_nombre:   d.encargado_super_nombre   || null,
    encargado_super_dni:      d.encargado_super_dni      || null,
    cantidad_recibida:        recibida,
    cantidad_rechazada:       rechazada,
    rechazo_destino:          rechazo_destino,
    escaneo_path:             escaneo_path
  });

  res.json({ ok: true, escaneo_path: escaneo_path, estado: estadoFinal, todo_rechazado: todoRechazado });
});

// Marcar varios remitos sellados como presentados (al hacer mailto)
// Preview del mail de presentación (cuerpo sugerido + lista de adjuntos)
router.post('/remitos/presentar/preview', express.json(), function(req, res) {
  try {
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'IDs requeridos' });
    const ph = ids.map(function(){ return '?'; }).join(',');
    const remitos = db.prepare(`
      SELECT id, n_remito_ifco, fecha_sellado, empresa, sucursal, cantidad_recibida, cantidad_rechazada, escaneo_path, estado
      FROM ifco_remitos_super WHERE id IN (${ph}) AND estado = 'sellado' AND eliminado_en IS NULL
    `).all(...ids);
    if (remitos.length === 0) return res.status(400).json({ error: 'Ninguno de los IDs corresponde a un remito sellado' });

    // Asunto sugerido
    const hoy = new Date().toISOString().slice(0,10);
    const asunto = 'Presentación de remitos IFCO - SAN GERONIMO SA - ' + hoy;

    // Cuerpo sugerido (HTML para mail)
    const total_recibidos = remitos.reduce(function(a,r){ return a + (r.cantidad_recibida||0); }, 0);
    let html = '<p>Buenos días,</p>';
    html += '<p>Envío para presentación los siguientes remitos sellados:</p>';
    html += '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px"><thead>';
    html += '<tr style="background:#1e3a5f;color:#fff"><th style="padding:8px 12px;text-align:left">N° Remito</th><th style="padding:8px 12px">Sellado</th><th style="padding:8px 12px;text-align:left">Cadena</th><th style="padding:8px 12px;text-align:right">Recibidos</th><th style="padding:8px 12px;text-align:right">Rechazados</th></tr>';
    html += '</thead><tbody>';
    remitos.forEach(function(r, i){
      const bg = i % 2 === 0 ? '#f9fafb' : '#fff';
      html += '<tr style="background:' + bg + '"><td style="padding:6px 12px;font-family:monospace">' + r.n_remito_ifco + '</td>';
      html += '<td style="padding:6px 12px;text-align:center">' + (r.fecha_sellado || '—') + '</td>';
      html += '<td style="padding:6px 12px">' + (r.empresa || '') + (r.sucursal ? ' - ' + r.sucursal : '') + '</td>';
      html += '<td style="padding:6px 12px;text-align:right">' + (r.cantidad_recibida || 0) + '</td>';
      html += '<td style="padding:6px 12px;text-align:right">' + (r.cantidad_rechazada || 0) + '</td></tr>';
    });
    html += '<tr style="background:#d1fae5;font-weight:bold"><td colspan="3" style="padding:8px 12px;text-align:right">TOTAL CAJONES PRESENTADOS:</td><td style="padding:8px 12px;text-align:right">' + total_recibidos + '</td><td></td></tr>';
    html += '</tbody></table>';
    html += '<p>Adjunto fotos de las copias selladas.</p>';
    html += '<p>Saludos cordiales,<br><b>SAN GERONIMO SA</b></p>';

    // Cuerpo texto plano (fallback)
    let texto = 'Buenos días,\n\nEnvío para presentación los siguientes remitos sellados:\n\n';
    remitos.forEach(function(r){
      texto += '• ' + r.n_remito_ifco + ' — ' + (r.empresa||'') + (r.sucursal?' '+r.sucursal:'') +
               ' — sellado ' + (r.fecha_sellado||'') +
               ' — ' + (r.cantidad_recibida||0) + ' recibidos, ' + (r.cantidad_rechazada||0) + ' rechazados\n';
    });
    texto += '\nTOTAL: ' + total_recibidos + ' cajones presentados.\n\nAdjunto fotos de las copias selladas.\n\nSaludos cordiales,\nSAN GERONIMO SA';

    // Adjuntos disponibles
    const adjuntos = remitos.filter(function(r){ return r.escaneo_path; }).map(function(r){
      return { remito_id: r.id, n_remito: r.n_remito_ifco, path: r.escaneo_path };
    });
    const sin_foto = remitos.filter(function(r){ return !r.escaneo_path; }).map(function(r){ return r.n_remito_ifco; });

    res.json({
      asunto: asunto,
      cuerpo_html: html,
      cuerpo_texto: texto,
      adjuntos: adjuntos,
      sin_foto: sin_foto,
      total_remitos: remitos.length,
      total_cajones: total_recibidos
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Enviar el mail (server-side con SMTP) y marcar remitos como 'enviado'
router.post('/remitos/presentar/enviar', express.json(), async function(req, res) {
  try {
    const ids = (req.body && req.body.ids) || [];
    const to = (req.body && req.body.to) || null;
    const cc = (req.body && req.body.cc) || null;
    const asunto = (req.body && req.body.asunto) || 'Presentación de remitos IFCO';
    const cuerpo_html = (req.body && req.body.cuerpo_html) || '';
    const cuerpo_texto = (req.body && req.body.cuerpo_texto) || '';
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'IDs requeridos' });
    if (!to) return res.status(400).json({ error: 'Destinatario requerido' });

    const ph = ids.map(function(){ return '?'; }).join(',');
    const remitos = db.prepare(`
      SELECT id, n_remito_ifco, escaneo_path
      FROM ifco_remitos_super WHERE id IN (${ph}) AND estado = 'sellado' AND eliminado_en IS NULL
    `).all(...ids);
    if (remitos.length === 0) return res.status(400).json({ error: 'Ninguno de los IDs corresponde a un remito sellado' });

    // Armar adjuntos físicos. Bug que arreglar: el escaneo_path se guarda
    // como '/data/ifco/xxx.jpg' (no /uploads/ifco/...). Usar path.basename
    // para extraer solo el filename y joinarlo con UPLOAD_DIR (que ya apunta
    // a la carpeta correcta), sin importar el prefijo guardado.
    const adjuntos = [];
    remitos.forEach(function(r){
      if (!r.escaneo_path) return;
      const filename = path.basename(r.escaneo_path);
      const absPath = path.join(UPLOAD_DIR, filename);
      if (fs.existsSync(absPath)) {
        const ext = path.extname(absPath) || '.jpg';
        adjuntos.push({ filename: r.n_remito_ifco.replace(/[^a-zA-Z0-9-]/g, '_') + ext, path: absPath });
      } else {
        console.warn('[IFCO][presentar/enviar] Archivo no encontrado para remito ' + r.n_remito_ifco + ': ' + absPath);
      }
    });

    // Mandar mail
    const mailRes = await _enviarMailIFCO({
      tipo: 'presentacion',
      to: to,
      cc: cc,
      asunto: asunto,
      cuerpo_html: cuerpo_html,
      cuerpo_texto: cuerpo_texto,
      adjuntos: adjuntos,
      related_ids: ids,
      usuario_id: req.user && req.user.id
    });

    if (!mailRes.success) {
      return res.status(500).json({ error: 'Error enviando mail: ' + mailRes.error });
    }

    // Marcar remitos como 'enviado'
    db.prepare(`
      UPDATE ifco_remitos_super
      SET estado = 'enviado',
          fecha_enviado = date('now','localtime'),
          email_enviado_a = ?,
          actualizado_en = datetime('now','localtime')
      WHERE id IN (${ph}) AND estado = 'sellado'
    `).run(to, ...ids);

    res.json({
      ok: true,
      enviados: remitos.length,
      adjuntos_count: adjuntos.length,
      message_id: mailRes.messageId
    });
  } catch(e) {
    console.error('[IFCO][remitos/presentar/enviar]', e);
    res.status(500).json({ error: e.message });
  }
});

// LEGACY: mantengo el endpoint viejo (mailto) para no romper código que pueda quedar
router.post('/remitos/presentar', function(req, res) {
  try {
    const ids = (req.body && req.body.ids) || [];
    const email = (req.body && req.body.email) || null;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'IDs requeridos' });
    }
    const ph = ids.map(function(){ return '?'; }).join(',');
    const remitos = db.prepare(`
      SELECT * FROM ifco_remitos_super WHERE id IN (${ph}) AND estado = 'sellado'
    `).all(...ids);
    if (remitos.length === 0) {
      return res.status(400).json({ error: 'Ninguno de los IDs corresponde a un remito sellado' });
    }
    const r = db.prepare(`
      UPDATE ifco_remitos_super
      SET estado = 'enviado',
          fecha_enviado = date('now','localtime'),
          email_enviado_a = ?,
          actualizado_en = datetime('now','localtime')
      WHERE id IN (${ph}) AND estado = 'sellado'
    `).run(email, ...ids);
    res.json({ ok: true, enviados: r.changes, remitos: remitos });
  } catch(e) {
    console.error('[IFCO][remitos/presentar] EXCEPCION:', e);
    res.status(500).json({ error: 'Error enviando remitos: ' + e.message });
  }
});

// PATCH /remitos/:id — editar (solo si estado='despachado')
router.patch('/remitos/:id', function(req, res) {
  const r = db.prepare("SELECT * FROM ifco_remitos_super WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  if (r.eliminado_en) return res.status(400).json({ error: 'Está eliminado. Restauralo primero.' });
  if (r.estado !== 'despachado') {
    return res.status(400).json({ error: 'Solo se puede editar mientras está en estado "despachado". Estado actual: ' + r.estado });
  }
  const d = req.body || {};

  // Si cambian el n_remito, validar unicidad entre activos
  if (d.n_remito_ifco && d.n_remito_ifco !== r.n_remito_ifco) {
    const dup = db.prepare("SELECT id FROM ifco_remitos_super WHERE n_remito_ifco = ? AND eliminado_en IS NULL AND id != ?").get(d.n_remito_ifco, req.params.id);
    if (dup) return res.status(409).json({ error: 'Ya existe otro remito activo con ese número' });
  }

  // Origen: si cambia a directo, validar proveedor
  let origen = d.origen || r.origen;
  let proveedor_origen_id = r.proveedor_origen_id;
  if (origen === 'proveedor_directo') {
    if (d.proveedor_origen_id !== undefined) proveedor_origen_id = parseInt(d.proveedor_origen_id) || null;
    if (!proveedor_origen_id) return res.status(400).json({ error: 'Origen directo requiere proveedor_origen_id' });
  } else {
    origen = 'san_geronimo';
    proveedor_origen_id = null;
  }

  db.prepare(`
    UPDATE ifco_remitos_super SET
      n_remito_ifco           = COALESCE(?, n_remito_ifco),
      n_remito_sg             = ?,
      fecha_emision           = COALESCE(?, fecha_emision),
      cliente_id              = ?,
      empresa                 = COALESCE(?, empresa),
      sucursal                = COALESCE(?, sucursal),
      cantidad_despachada     = COALESCE(?, cantidad_despachada),
      producto                = ?,
      transportista           = COALESCE(?, transportista),
      encargado_prov_apellido = COALESCE(?, encargado_prov_apellido),
      encargado_prov_nombre   = COALESCE(?, encargado_prov_nombre),
      encargado_prov_dni      = COALESCE(?, encargado_prov_dni),
      notas                   = COALESCE(?, notas),
      origen                  = ?,
      proveedor_origen_id     = ?,
      actualizado_en          = datetime('now','localtime')
    WHERE id = ?
  `).run(
    d.n_remito_ifco || null,
    d.n_remito_sg !== undefined ? (d.n_remito_sg ? String(d.n_remito_sg).trim() : null) : null,
    d.fecha_emision || null,
    d.cliente_id || null,
    d.empresa || null,
    d.sucursal || null,
    d.cantidad_despachada ? parseInt(d.cantidad_despachada) : null,
    d.producto || null,
    d.transportista || null,
    d.encargado_prov_apellido || null,
    d.encargado_prov_nombre || null,
    d.encargado_prov_dni || null,
    d.notas || null,
    origen,
    proveedor_origen_id,
    req.params.id
  );
  res.json({ ok: true });
});

// DELETE /remitos/:id — soft delete (todos)
router.delete('/remitos/:id', function(req, res) {
  const r = db.prepare("SELECT id FROM ifco_remitos_super WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado o ya eliminado' });
  db.prepare(`UPDATE ifco_remitos_super
              SET eliminado_en = datetime('now','localtime'),
                  eliminado_por_id = ?
              WHERE id = ?`).run(req.user.id || null, req.params.id);
  res.json({ ok: true });
});

// POST /remitos/:id/restaurar — recuperar de papelera
router.post('/remitos/:id/restaurar', function(req, res) {
  const r = db.prepare("SELECT * FROM ifco_remitos_super WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  if (!r.eliminado_en) return res.status(400).json({ error: 'No está en papelera' });
  // Validar unicidad antes de restaurar
  const dup = db.prepare("SELECT id FROM ifco_remitos_super WHERE n_remito_ifco = ? AND eliminado_en IS NULL AND id != ?").get(r.n_remito_ifco, req.params.id);
  if (dup) return res.status(409).json({ error: 'Hay otro remito activo con ese mismo número (' + r.n_remito_ifco + '). Eliminá ese o renombrá este antes de restaurar.' });
  db.prepare("UPDATE ifco_remitos_super SET eliminado_en = NULL, eliminado_por_id = NULL WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// ENVÍOS A PROVEEDOR
// ════════════════════════════════════════════════════════════════════════════

router.get('/envios', function(req, res) {
  const f = req.query;
  const papelera = f.papelera === '1' || f.incluir_eliminados === '1';
  let q = `
    SELECT e.*, p.nombre AS proveedor_nombre, p.razon_social AS proveedor_razon,
           u.nombre AS eliminado_por_username,
           porig.nombre AS origen_proveedor_nombre,
           uc.nombre AS usuario_creador_nombre
    FROM ifco_envios_proveedor e
    LEFT JOIN proveedores p ON p.id = e.proveedor_id
    LEFT JOIN proveedores porig ON porig.id = e.origen_proveedor_id
    LEFT JOIN usuarios u ON u.id = e.eliminado_por_id
    LEFT JOIN usuarios uc ON uc.id = e.usuario_id
    WHERE 1=1
  `;
  const p = [];
  if (papelera) q += " AND e.eliminado_en IS NOT NULL";
  else          q += " AND e.eliminado_en IS NULL";
  if (f.estado)       { q += " AND e.estado = ?";       p.push(f.estado); }
  if (f.proveedor_id) { q += " AND e.proveedor_id = ?"; p.push(f.proveedor_id); }
  q += " ORDER BY e.fecha_envio DESC, e.id DESC LIMIT 500";
  res.json(db.prepare(q).all(...p));
});

router.get('/envios/:id', function(req, res) {
  const e = db.prepare(`
    SELECT e.*, p.nombre AS proveedor_nombre, p.razon_social AS proveedor_razon, p.cuit AS proveedor_cuit,
           porig.nombre AS origen_proveedor_nombre, porig.razon_social AS origen_proveedor_razon
    FROM ifco_envios_proveedor e
    LEFT JOIN proveedores p ON p.id = e.proveedor_id
    LEFT JOIN proveedores porig ON porig.id = e.origen_proveedor_id
    WHERE e.id = ?
  `).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No encontrado' });
  res.json(e);
});

router.post('/envios', function(req, res) {
  const d = req.body || {};
  if (!d.fecha_envio || !d.proveedor_id || !d.cantidad_enviada) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }
  const cant = parseInt(d.cantidad_enviada);
  if (cant <= 0) return res.status(400).json({ error: 'Cantidad inválida' });

  // Origen del envío: NULL = SG, valor = traspaso desde otro galpón
  let origen_proveedor_id = null;
  if (d.origen_proveedor_id) {
    origen_proveedor_id = parseInt(d.origen_proveedor_id);
    if (isNaN(origen_proveedor_id)) return res.status(400).json({ error: 'origen_proveedor_id inválido' });
    if (origen_proveedor_id === parseInt(d.proveedor_id)) {
      return res.status(400).json({ error: 'El galpón origen y destino no pueden ser el mismo' });
    }
  }

  // Genera n° interno: SG-P-AAAA-NNNN (envío desde SG) o TR-AAAA-NNNN (traspaso entre galpones)
  const year = new Date(d.fecha_envio).getFullYear();
  const prefix = origen_proveedor_id ? 'TR-' : 'SG-P-';
  const ultimo = db.prepare(`
    SELECT n_remito_interno FROM ifco_envios_proveedor
    WHERE n_remito_interno LIKE ? ORDER BY id DESC LIMIT 1
  `).get(prefix + year + '-%');

  let nro = 1;
  if (ultimo) {
    const m = String(ultimo.n_remito_interno).match(/-(\d+)$/);
    if (m) nro = parseInt(m[1], 10) + 1;
  }
  const n_remito_interno = prefix + year + '-' + String(nro).padStart(4, '0');
  const token = _genTokenAceptacion();

  try {
    const r = db.prepare(`
      INSERT INTO ifco_envios_proveedor
        (n_remito_interno, fecha_envio, proveedor_id, cantidad_enviada, modelo, notas, usuario_id, aceptacion_token, origen_proveedor_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(n_remito_interno, d.fecha_envio, d.proveedor_id, cant,
           d.modelo || '6420', d.notas || null, req.user.id || null, token, origen_proveedor_id);

    res.json({ id: r.lastInsertRowid, n_remito_interno: n_remito_interno, aceptacion_token: token, origen_proveedor_id: origen_proveedor_id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/envios/:id/recepcionar', upload.single('escaneo_recepcion'), function(req, res) {
  const d = req.body || {};
  const e = db.prepare("SELECT * FROM ifco_envios_proveedor WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No encontrado' });
  if (!d.fecha_recepcion || d.cantidad_recibida == null) {
    return res.status(400).json({ error: 'Fecha y cantidad recibida requeridas' });
  }
  const recib = parseInt(d.cantidad_recibida);
  if (recib < 0 || recib > e.cantidad_enviada) {
    return res.status(400).json({ error: 'Cantidad recibida inválida (rango 0..' + e.cantidad_enviada + ')' });
  }
  const estado = recib === e.cantidad_enviada ? 'recibido' : 'parcial';

  let escaneo_recepcion_path = e.escaneo_recepcion_path;
  if (req.file) escaneo_recepcion_path = '/data/ifco/' + req.file.filename;

  db.prepare(`
    UPDATE ifco_envios_proveedor SET
      estado = ?, fecha_recepcion = ?, cantidad_recibida = ?,
      notas = COALESCE(?, notas),
      escaneo_recepcion_path = ?,
      actualizado_en = datetime('now','localtime')
    WHERE id = ?
  `).run(estado, d.fecha_recepcion, recib, d.notas || null, escaneo_recepcion_path, req.params.id);

  res.json({ ok: true, estado: estado, cantidad_recibida: recib, escaneo_recepcion_path: escaneo_recepcion_path });
});

// PATCH /envios/:id — editar (solo si estado='enviado', no parcial/recibido)
router.patch('/envios/:id', function(req, res) {
  const e = db.prepare("SELECT * FROM ifco_envios_proveedor WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No encontrado' });
  if (e.eliminado_en) return res.status(400).json({ error: 'Está eliminado. Restauralo primero.' });
  if (e.estado !== 'enviado') {
    return res.status(400).json({ error: 'Solo se puede editar mientras está en estado "enviado". Estado actual: ' + e.estado });
  }
  const d = req.body || {};
  db.prepare(`
    UPDATE ifco_envios_proveedor SET
      fecha_envio      = COALESCE(?, fecha_envio),
      proveedor_id     = COALESCE(?, proveedor_id),
      cantidad_enviada = COALESCE(?, cantidad_enviada),
      notas            = ?,
      actualizado_en   = datetime('now','localtime')
    WHERE id = ?
  `).run(
    d.fecha_envio || null,
    d.proveedor_id ? parseInt(d.proveedor_id) : null,
    d.cantidad_enviada ? parseInt(d.cantidad_enviada) : null,
    d.notas || null,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/envios/:id', function(req, res) {
  const e = db.prepare("SELECT id FROM ifco_envios_proveedor WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No encontrado o ya eliminado' });
  db.prepare(`UPDATE ifco_envios_proveedor
              SET eliminado_en = datetime('now','localtime'),
                  eliminado_por_id = ?
              WHERE id = ?`).run(req.user.id || null, req.params.id);
  res.json({ ok: true });
});

router.post('/envios/:id/restaurar', function(req, res) {
  const e = db.prepare("SELECT * FROM ifco_envios_proveedor WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: 'No encontrado' });
  if (!e.eliminado_en) return res.status(400).json({ error: 'No está en papelera' });
  db.prepare("UPDATE ifco_envios_proveedor SET eliminado_en = NULL, eliminado_por_id = NULL WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// MOVIMIENTOS PUNTUALES (retiros, pérdidas)
// ════════════════════════════════════════════════════════════════════════════

router.get('/movimientos', function(req, res) {
  const f = req.query;
  const papelera = f.papelera === '1' || f.incluir_eliminados === '1';
  let q = `SELECT m.*, u.nombre AS eliminado_por_username,
                  uc.nombre AS usuario_creador_nombre
           FROM ifco_movimientos m
           LEFT JOIN usuarios u ON u.id = m.eliminado_por_id
           LEFT JOIN usuarios uc ON uc.id = m.usuario_id
           WHERE 1=1`;
  const p = [];
  if (papelera) q += " AND m.eliminado_en IS NOT NULL";
  else          q += " AND m.eliminado_en IS NULL";
  if (f.tipo)  { q += " AND m.tipo = ?";   p.push(f.tipo); }
  if (f.desde) { q += " AND m.fecha >= ?"; p.push(f.desde); }
  if (f.hasta) { q += " AND m.fecha <= ?"; p.push(f.hasta); }
  q += " ORDER BY m.fecha DESC, m.id DESC LIMIT 500";
  res.json(db.prepare(q).all(...p));
});

router.get('/movimientos/:id', function(req, res) {
  const m = db.prepare("SELECT * FROM ifco_movimientos WHERE id = ?").get(req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrado' });
  res.json(m);
});

router.post('/movimientos', function(req, res) {
  const d = req.body || {};
  if (!d.fecha || !d.tipo || !d.cantidad) return res.status(400).json({ error: 'Faltan datos' });
  if (['retiro','perdida'].indexOf(d.tipo) < 0) return res.status(400).json({ error: 'Tipo inválido' });
  const cant = parseInt(d.cantidad);
  if (cant <= 0) return res.status(400).json({ error: 'Cantidad inválida' });

  // Validar sucursal IFCO si viene (solo aplicable a retiros)
  if (d.sucursal_ifco && ['Buenos Aires','Mendoza'].indexOf(d.sucursal_ifco) < 0) {
    return res.status(400).json({ error: 'sucursal_ifco inválida (esperado: Buenos Aires | Mendoza)' });
  }

  const r = db.prepare(`
    INSERT INTO ifco_movimientos (
      fecha, tipo, cantidad, modelo, n_remito,
      costo_total, moneda, notas, usuario_id,
      sucursal_ifco, encargado_apellido, encargado_nombre, encargado_dni
    )
    VALUES (?, ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?, ?)
  `).run(
    d.fecha, d.tipo, cant, d.modelo || '6420', d.n_remito || null,
    parseFloat(d.costo_total) || 0, d.moneda || 'ARS', d.notas || null, req.user.id || null,
    d.sucursal_ifco || null, d.encargado_apellido || null, d.encargado_nombre || null, d.encargado_dni || null
  );

  res.json({ id: r.lastInsertRowid });
});

// PATCH /movimientos/:id — editar (siempre permitido)
router.patch('/movimientos/:id', function(req, res) {
  const m = db.prepare("SELECT * FROM ifco_movimientos WHERE id = ?").get(req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrado' });
  if (m.eliminado_en) return res.status(400).json({ error: 'Está eliminado. Restauralo primero.' });
  const d = req.body || {};
  if (d.sucursal_ifco && ['Buenos Aires','Mendoza'].indexOf(d.sucursal_ifco) < 0) {
    return res.status(400).json({ error: 'sucursal_ifco inválida' });
  }
  db.prepare(`
    UPDATE ifco_movimientos SET
      fecha              = COALESCE(?, fecha),
      cantidad           = COALESCE(?, cantidad),
      n_remito           = ?,
      costo_total        = COALESCE(?, costo_total),
      notas              = ?,
      sucursal_ifco      = ?,
      encargado_apellido = ?,
      encargado_nombre   = ?,
      encargado_dni      = ?
    WHERE id = ?
  `).run(
    d.fecha || null,
    d.cantidad ? parseInt(d.cantidad) : null,
    d.n_remito || null,
    d.costo_total != null ? parseFloat(d.costo_total) : null,
    d.notas || null,
    d.sucursal_ifco || null,
    d.encargado_apellido || null,
    d.encargado_nombre || null,
    d.encargado_dni || null,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/movimientos/:id', function(req, res) {
  const m = db.prepare("SELECT id, consolidado_en FROM ifco_movimientos WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrado o ya eliminado' });
  if (m.consolidado_en) return res.status(403).json({ error: 'Este registro ya fue consolidado con el archivo IFCO y no se puede eliminar.' });
  db.prepare(`UPDATE ifco_movimientos
              SET eliminado_en = datetime('now','localtime'),
                  eliminado_por_id = ?
              WHERE id = ?`).run(req.user.id || null, req.params.id);
  res.json({ ok: true });
});

router.post('/movimientos/:id/restaurar', function(req, res) {
  const m = db.prepare("SELECT * FROM ifco_movimientos WHERE id = ?").get(req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrado' });
  if (!m.eliminado_en) return res.status(400).json({ error: 'No está en papelera' });
  db.prepare("UPDATE ifco_movimientos SET eliminado_en = NULL, eliminado_por_id = NULL WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTORIZACIONES DE RETIRO — mail a IFCO autorizando un transportista
// ────────────────────────────────────────────────────────────────────────────
// Flujo:
//   1. Operador crea autorización con datos del transportista
//      → se genera un movimiento 'retiro' con pendiente=1 (no impacta stock)
//   2. Genera preview del mail
//   3. Confirma envío → mail real con SMTP, autorización pasa a 'enviada'
//   4. Cuando IFCO entrega → operador completa con cantidad real
//      → movimiento pasa a pendiente=0 con cantidad ajustada
//   5. Si se cancela → se elimina el movimiento pendiente
// ════════════════════════════════════════════════════════════════════════════

// GET /autorizaciones-retiro — listar (ordenadas por más reciente)
router.get('/autorizaciones-retiro', function(req, res) {
  try {
    const estado = req.query.estado;
    let q = `
      SELECT a.*, u.nombre AS usuario_username, uc.nombre AS completada_por_username
      FROM ifco_autorizaciones_retiro a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
      LEFT JOIN usuarios uc ON uc.id = a.completada_por_id
      WHERE a.eliminado_en IS NULL
    `;
    const p = [];
    if (estado) { q += " AND a.estado = ?"; p.push(estado); }
    q += " ORDER BY a.creado_en DESC LIMIT 100";
    res.json(db.prepare(q).all(...p));
  } catch(e) {
    console.error('[IFCO][autorizaciones-retiro GET]', e);
    res.status(500).json({ error: e.message, stack: e.stack ? e.stack.split('\n').slice(0,3).join(' | ') : null });
  }
});

// POST /autorizaciones-retiro — crear nueva
router.post('/autorizaciones-retiro', express.json(), function(req, res) {
  try {
    const d = req.body || {};
    if (!d.transportista_nombre || !d.transportista_dni || !d.transportista_patente) {
      return res.status(400).json({ error: 'Faltan datos del transportista (nombre, DNI, patente)' });
    }
    const cantidad = parseInt(d.cantidad_estimada);
    if (isNaN(cantidad) || cantidad <= 0) return res.status(400).json({ error: 'Cantidad estimada debe ser un número positivo' });
    if (!d.fecha_autorizada) return res.status(400).json({ error: 'Fecha autorizada requerida' });

    // Crear movimiento pendiente (tipo='retiro', pendiente=1)
    const movR = db.prepare(`
      INSERT INTO ifco_movimientos (fecha, tipo, cantidad, modelo, notas, usuario_id, pendiente)
      VALUES (?, 'retiro', ?, ?, ?, ?, 1)
    `).run(
      d.fecha_autorizada,
      cantidad,
      d.modelo || '6420',
      'Pendiente: autorización a ' + d.transportista_nombre + ' (DNI ' + d.transportista_dni + ', patente ' + d.transportista_patente + ')',
      (req.user && req.user.id) || null
    );

    const autR = db.prepare(`
      INSERT INTO ifco_autorizaciones_retiro
        (fecha_autorizada, transportista_nombre, transportista_dni, transportista_patente,
         cantidad_estimada, estado, movimiento_pendiente_id, notas, usuario_id)
      VALUES (?, ?, ?, ?, ?, 'pendiente_envio', ?, ?, ?)
    `).run(
      d.fecha_autorizada,
      String(d.transportista_nombre).trim(),
      String(d.transportista_dni).trim(),
      String(d.transportista_patente).trim(),
      cantidad,
      movR.lastInsertRowid,
      d.notas ? String(d.notas).trim() : null,
      (req.user && req.user.id) || null
    );

    res.json({ id: autR.lastInsertRowid, movimiento_pendiente_id: movR.lastInsertRowid });
  } catch(e) {
    console.error('[IFCO][autorizaciones-retiro POST]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /autorizaciones-retiro/:id/preview — preview del mail
router.get('/autorizaciones-retiro/:id/preview', function(req, res) {
  try {
    const a = db.prepare("SELECT * FROM ifco_autorizaciones_retiro WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Autorización no encontrada' });

    // Asunto
    const asunto = 'Autorización de retiro de cajones IFCO - SAN GERONIMO SA';

    // HTML
    let html = '<p>Buenos días,</p>';
    html += '<p>Por la presente <b>autorizamos al siguiente transportista</b> a retirar cajones IFCO modelo 6420 desde el centro de IFCO en nombre de <b>SAN GERONIMO SA</b>:</p>';
    html += '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;margin:14px 0">';
    html += '<tr><td style="padding:6px 14px;font-weight:600;background:#f3f4f6;border:1px solid #e5e7eb">Transportista</td><td style="padding:6px 14px;border:1px solid #e5e7eb">' + a.transportista_nombre + '</td></tr>';
    html += '<tr><td style="padding:6px 14px;font-weight:600;background:#f3f4f6;border:1px solid #e5e7eb">DNI</td><td style="padding:6px 14px;border:1px solid #e5e7eb">' + a.transportista_dni + '</td></tr>';
    html += '<tr><td style="padding:6px 14px;font-weight:600;background:#f3f4f6;border:1px solid #e5e7eb">Patente del vehículo</td><td style="padding:6px 14px;border:1px solid #e5e7eb">' + a.transportista_patente + '</td></tr>';
    html += '<tr><td style="padding:6px 14px;font-weight:600;background:#f3f4f6;border:1px solid #e5e7eb">Fecha estimada de retiro</td><td style="padding:6px 14px;border:1px solid #e5e7eb">' + a.fecha_autorizada + '</td></tr>';
    html += '<tr><td style="padding:6px 14px;font-weight:600;background:#f3f4f6;border:1px solid #e5e7eb">Cantidad estimada</td><td style="padding:6px 14px;border:1px solid #e5e7eb"><b>' + a.cantidad_estimada + ' cajones</b></td></tr>';
    html += '</table>';
    if (a.notas) html += '<p><i>Observaciones: ' + a.notas + '</i></p>';
    html += '<p>Cualquier consulta, responder a este mail.</p>';
    html += '<p>Saludos cordiales,<br><b>SAN GERONIMO SA</b></p>';

    // Texto plano
    let texto = 'Buenos días,\n\nPor la presente AUTORIZAMOS al siguiente transportista a retirar cajones IFCO modelo 6420 desde el centro de IFCO en nombre de SAN GERONIMO SA:\n\n';
    texto += '  Transportista: ' + a.transportista_nombre + '\n';
    texto += '  DNI: ' + a.transportista_dni + '\n';
    texto += '  Patente: ' + a.transportista_patente + '\n';
    texto += '  Fecha estimada: ' + a.fecha_autorizada + '\n';
    texto += '  Cantidad estimada: ' + a.cantidad_estimada + ' cajones\n';
    if (a.notas) texto += '\nObservaciones: ' + a.notas + '\n';
    texto += '\nCualquier consulta, responder a este mail.\n\nSaludos cordiales,\nSAN GERONIMO SA';

    res.json({ asunto: asunto, cuerpo_html: html, cuerpo_texto: texto });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /autorizaciones-retiro/:id/enviar — manda el mail con SMTP
router.post('/autorizaciones-retiro/:id/enviar', express.json(), async function(req, res) {
  try {
    const a = db.prepare("SELECT * FROM ifco_autorizaciones_retiro WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Autorización no encontrada' });
    if (a.estado === 'enviada' || a.estado === 'completada') {
      return res.status(400).json({ error: 'Esta autorización ya fue enviada (estado: ' + a.estado + ')' });
    }
    if (a.estado === 'cancelada') return res.status(400).json({ error: 'Esta autorización fue cancelada' });

    const to = (req.body && req.body.to) || null;
    const cc = (req.body && req.body.cc) || null;
    const asunto = (req.body && req.body.asunto) || 'Autorización de retiro de cajones IFCO';
    const cuerpo_html = (req.body && req.body.cuerpo_html) || '';
    const cuerpo_texto = (req.body && req.body.cuerpo_texto) || '';
    if (!to) return res.status(400).json({ error: 'Destinatario requerido' });

    const mailRes = await _enviarMailIFCO({
      tipo: 'autorizacion_retiro',
      to: to, cc: cc, asunto: asunto,
      cuerpo_html: cuerpo_html, cuerpo_texto: cuerpo_texto,
      related_ids: [a.id],
      usuario_id: req.user && req.user.id
    });
    if (!mailRes.success) return res.status(500).json({ error: 'Error enviando mail: ' + mailRes.error });

    db.prepare(`
      UPDATE ifco_autorizaciones_retiro
      SET estado = 'enviada', mail_enviado_a = ?, mail_enviado_en = datetime('now','localtime'), mail_message_id = ?
      WHERE id = ?
    `).run(to, mailRes.messageId || null, a.id);

    res.json({ ok: true, message_id: mailRes.messageId });
  } catch(e) {
    console.error('[IFCO][autorizaciones-retiro/enviar]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /autorizaciones-retiro/:id/completar — registra la entrega real con cantidad ajustada + n_remito
router.post('/autorizaciones-retiro/:id/completar', express.json(), function(req, res) {
  try {
    const a = db.prepare("SELECT * FROM ifco_autorizaciones_retiro WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Autorización no encontrada' });
    if (a.estado !== 'enviada' && a.estado !== 'pendiente_envio') {
      return res.status(400).json({ error: 'Solo se pueden completar autorizaciones en estado "enviada" o "pendiente_envio". Estado actual: ' + a.estado });
    }
    const cantidadReal = parseInt(req.body && req.body.cantidad_real);
    if (isNaN(cantidadReal) || cantidadReal < 0) {
      return res.status(400).json({ error: 'Cantidad real debe ser un número >= 0' });
    }
    const n_remito = req.body && req.body.n_remito ? String(req.body.n_remito).trim() : null;
    if (!n_remito) return res.status(400).json({ error: 'N° de remito IFCO es requerido al completar' });

    // Pasar el movimiento de pendiente=1 a pendiente=0 con cantidad ajustada + n_remito
    if (a.movimiento_pendiente_id) {
      db.prepare(`
        UPDATE ifco_movimientos
        SET cantidad = ?, n_remito = ?, pendiente = 0,
            notas = COALESCE(notas, '') || ' [Confirmado: ' || ? || ' cajones reales | Remito: ' || ? || ']'
        WHERE id = ?
      `).run(cantidadReal, n_remito, cantidadReal, n_remito, a.movimiento_pendiente_id);
    } else {
      // Si por alguna razón no había movimiento pendiente, crearlo ahora
      const movR = db.prepare(`
        INSERT INTO ifco_movimientos (fecha, tipo, cantidad, modelo, n_remito, notas, usuario_id, pendiente)
        VALUES (date('now','localtime'), 'retiro', ?, '6420', ?, ?, ?, 0)
      `).run(cantidadReal, n_remito, 'Retiro confirmado por autorización #' + a.id, (req.user && req.user.id) || null);
      db.prepare("UPDATE ifco_autorizaciones_retiro SET movimiento_pendiente_id = ? WHERE id = ?").run(movR.lastInsertRowid, a.id);
    }

    db.prepare(`
      UPDATE ifco_autorizaciones_retiro
      SET estado = 'completada', cantidad_real = ?, completada_en = datetime('now','localtime'), completada_por_id = ?
      WHERE id = ?
    `).run(cantidadReal, (req.user && req.user.id) || null, a.id);

    res.json({ ok: true, cantidad_real: cantidadReal, diferencia: cantidadReal - a.cantidad_estimada, n_remito: n_remito });
  } catch(e) {
    console.error('[IFCO][autorizaciones-retiro/completar]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /autorizaciones-retiro/:id/cancelar — cancela la autorización y la manda a papelera
// (también elimina el movimiento pendiente para que no quede como retiro fantasma)
router.post('/autorizaciones-retiro/:id/cancelar', express.json(), function(req, res) {
  try {
    const a = db.prepare("SELECT * FROM ifco_autorizaciones_retiro WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Autorización no encontrada' });
    if (a.estado === 'completada') return res.status(400).json({ error: 'No se puede cancelar una autorización ya completada' });

    if (a.movimiento_pendiente_id) {
      db.prepare("UPDATE ifco_movimientos SET eliminado_en = datetime('now','localtime') WHERE id = ?").run(a.movimiento_pendiente_id);
    }
    db.prepare(`
      UPDATE ifco_autorizaciones_retiro
      SET estado = 'cancelada',
          eliminado_en = datetime('now','localtime'),
          notas = COALESCE(notas, '') || ' [Cancelada: ' || COALESCE(?, 'sin motivo') || ']'
      WHERE id = ?
    `).run(req.body && req.body.motivo ? String(req.body.motivo).trim() : null, a.id);

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /autorizaciones-retiro/:id — eliminar (admin only, manda a papelera)
router.delete('/autorizaciones-retiro/:id', function(req, res) {
  if (!req.user || req.user.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo admin puede eliminar autorizaciones' });
  }
  try {
    const a = db.prepare("SELECT * FROM ifco_autorizaciones_retiro WHERE id = ?").get(req.params.id);
    if (!a) return res.status(404).json({ error: 'No encontrada' });
    if (a.movimiento_pendiente_id) {
      db.prepare("UPDATE ifco_movimientos SET eliminado_en = datetime('now','localtime') WHERE id = ?").run(a.movimiento_pendiente_id);
    }
    db.prepare("UPDATE ifco_autorizaciones_retiro SET eliminado_en = datetime('now','localtime') WHERE id = ?").run(a.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /autorizaciones-retiro/limpiar-pruebas — borra todas las no completadas (admin only)
// Útil para limpiar las autorizaciones de prueba que quedaron en la base.
router.post('/autorizaciones-retiro/limpiar-pruebas', function(req, res) {
  if (!req.user || req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  try {
    // Buscar todas las no completadas (incluyendo canceladas que no fueron borradas)
    const noCompletadas = db.prepare(`
      SELECT id, movimiento_pendiente_id FROM ifco_autorizaciones_retiro
      WHERE estado != 'completada'
    `).all();
    const ids = noCompletadas.map(function(r){ return r.id; });
    const movIds = noCompletadas.map(function(r){ return r.movimiento_pendiente_id; }).filter(Boolean);

    const tx = db.transaction(function(){
      // Eliminar movimientos pendientes asociados
      if (movIds.length > 0) {
        const placeholders = movIds.map(function(){return '?';}).join(',');
        db.prepare("UPDATE ifco_movimientos SET eliminado_en = datetime('now','localtime') WHERE id IN (" + placeholders + ")").run(...movIds);
      }
      // Mandar a papelera las autorizaciones
      db.prepare("UPDATE ifco_autorizaciones_retiro SET eliminado_en = datetime('now','localtime') WHERE estado != 'completada' AND eliminado_en IS NULL").run();
    });
    tx();
    res.json({ ok: true, eliminadas: ids.length, movimientos_eliminados: movIds.length });
  } catch(e) {
    console.error('[IFCO][limpiar-pruebas]', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /admin/fecha-remito — corrección puntual de fecha de un remito (admin only)
// Útil cuando un operador cargó la fecha mal y el remito está bloqueado por estar presentado.
// Body: { n_remito_ifco: "00015-01579690", fecha_emision: "2026-11-15" }
router.patch('/admin/fecha-remito', express.json(), function(req, res) {
  if (!req.user || req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  try {
    const d = req.body || {};
    if (!d.n_remito_ifco) return res.status(400).json({ error: 'n_remito_ifco requerido' });
    if (!d.fecha_emision || !/^\d{4}-\d{2}-\d{2}$/.test(d.fecha_emision)) {
      return res.status(400).json({ error: 'fecha_emision en formato YYYY-MM-DD requerida' });
    }
    const r = db.prepare("UPDATE ifco_remitos_super SET fecha_emision = ? WHERE n_remito_ifco = ? AND eliminado_en IS NULL").run(d.fecha_emision, d.n_remito_ifco);
    if (r.changes === 0) return res.status(404).json({ error: 'Remito no encontrado' });
    res.json({ ok: true, n_remito_ifco: d.n_remito_ifco, fecha_emision_nueva: d.fecha_emision });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /mails-log — historial de mails enviados (últimos 100)
router.get('/mails-log', function(req, res) {
  try {
    const tipo = req.query.tipo;
    let q = `
      SELECT l.*, u.nombre AS enviado_por_username
      FROM ifco_mails_log l
      LEFT JOIN usuarios u ON u.id = l.enviado_por_id
      WHERE 1=1
    `;
    const p = [];
    if (tipo) { q += " AND l.tipo = ?"; p.push(tipo); }
    q += " ORDER BY l.enviado_en DESC LIMIT 100";
    res.json(db.prepare(q).all(...p));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /manual — descarga el manual del módulo en PDF (accesible para todos los usuarios)
router.get('/manual', function(req, res) {
  // Se busca el archivo en estos paths, en orden:
  // src/static/ tiene prioridad porque se reescribe en cada deploy (a diferencia
  // de data/, que en Railway suele estar montado como volume persistente).
  const candidates = [
    path.join(__dirname, '../static/Manual_Modulo_IFCO.pdf'),
    path.join(__dirname, '../../data/Manual_Modulo_IFCO.pdf'),
    path.join(__dirname, '../../data/manuales/Manual_Modulo_IFCO.pdf'),
    path.join(UPLOAD_DIR, 'Manual_Modulo_IFCO.pdf')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return res.download(p, 'Manual_Modulo_IFCO.pdf');
    }
  }
  res.status(404).json({ error: 'Manual no disponible. El admin debe subirlo al servidor en src/static/Manual_Modulo_IFCO.pdf' });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT TEMPORAL — corregir fecha de un remito mal cargado
// Solo admin. Body: { n_remito_ifco, fecha_nueva (YYYY-MM-DD) }
// Una vez corregidos los casos puntuales, este endpoint se puede borrar.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/admin/fix-fecha-despacho', function(req, res) {
  if (!req.user || req.user.rol !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Solo admin' });
  }
  const { n_remito_ifco, fecha_nueva } = req.body || {};
  if (!n_remito_ifco || !fecha_nueva) {
    return res.status(400).json({ ok: false, error: 'Faltan n_remito_ifco o fecha_nueva' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_nueva)) {
    return res.status(400).json({ ok: false, error: 'fecha_nueva debe ser YYYY-MM-DD' });
  }
  try {
    const row = db.prepare("SELECT id, n_remito_ifco, fecha_emision, estado FROM ifco_remitos_super WHERE n_remito_ifco = ?").get(n_remito_ifco);
    if (!row) return res.status(404).json({ ok: false, error: 'Remito no encontrado' });
    const fechaVieja = row.fecha_emision;
    db.prepare("UPDATE ifco_remitos_super SET fecha_emision = ? WHERE id = ?").run(fecha_nueva, row.id);
    console.log(`[IFCO][admin][fix-fecha] Remito ${n_remito_ifco} (id ${row.id}): ${fechaVieja} → ${fecha_nueva} por usuario ${req.user.username || req.user.email}`);
    return res.json({ ok: true, id: row.id, n_remito_ifco: row.n_remito_ifco, fecha_anterior: fechaVieja, fecha_nueva: fecha_nueva, estado: row.estado });
  } catch(e) {
    console.error('[IFCO][admin][fix-fecha]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// RESUMEN — stocks calculados + alertas + saldos por contraparte
// ════════════════════════════════════════════════════════════════════════════

router.get('/resumen', function(req, res) {
  const get = function(sql, ...p) { return (db.prepare(sql).get(...p) || {}).total || 0; };

  // Movimientos puntuales
  const retirado = get("SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_movimientos WHERE tipo='retiro' AND eliminado_en IS NULL AND pendiente=0");
  const perdido  = get("SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_movimientos WHERE tipo='perdida' AND eliminado_en IS NULL AND pendiente=0");

  // Envíos a proveedor — totales y pendientes (excluyendo eliminados)
  const envios_totales = get(`
    SELECT COALESCE(SUM(cantidad_enviada),0) AS total
    FROM ifco_envios_proveedor
    WHERE estado IN ('enviado','parcial','recibido') AND eliminado_en IS NULL
  `);
  const recepciones_envios = get(`
    SELECT COALESCE(SUM(cantidad_recibida),0) AS total
    FROM ifco_envios_proveedor
    WHERE estado IN ('recibido','parcial') AND eliminado_en IS NULL
  `);
  // Recepciones de mercadería (cajones que vuelven con producto, entidad nueva)
  // Solo cuentan las CONFIRMADAS por SG. Las en_viaje no impactan stock todavía.
  const recepciones_merc = get(`
    SELECT COALESCE(SUM(cantidad),0) AS total
    FROM ifco_recepciones_proveedor
    WHERE eliminado_en IS NULL
      AND (estado IS NULL OR estado = 'recibido')
  `);
  const en_proveedores = get(`
    SELECT COALESCE(SUM(cantidad_enviada - COALESCE(cantidad_recibida,0)),0) AS total
    FROM ifco_envios_proveedor
    WHERE estado IN ('enviado','parcial') AND eliminado_en IS NULL
  `) - recepciones_merc;  // los que volvieron físicamente bajan el saldo

  // Despachos a súper — totales y rechazos vueltos. Solo despachos origen=SG cuentan
  // contra el stock SG. Los "directo desde proveedor" no salieron del piso de SG.
  const despachos_sg = get(`
    SELECT COALESCE(SUM(cantidad_despachada),0) AS total
    FROM ifco_remitos_super
    WHERE estado IN ('despachado','sellado','enviado','presentado')
      AND origen = 'san_geronimo'
      AND eliminado_en IS NULL
  `);
  const rechazos_vueltos_sg = get(`
    SELECT COALESCE(SUM(cantidad_rechazada),0) AS total
    FROM ifco_remitos_super
    WHERE estado IN ('sellado','enviado','presentado')
      AND rechazo_destino = 'san_geronimo'
      AND eliminado_en IS NULL
  `);
  const en_transito_sg = get(`
    SELECT COALESCE(SUM(cantidad_despachada),0) AS total
    FROM ifco_remitos_super
    WHERE estado = 'despachado'
      AND origen = 'san_geronimo'
      AND eliminado_en IS NULL
  `);

  // PISO actual: usa la función unificada _calcStockSG()
  // (los faltantes manuales históricos ya NO se restan; la fuente oficial de
  // diferencias es la consolidación semanal contra IFCO)
  const piso = _calcStockSG();
  const bajo_responsabilidad = piso + en_proveedores + en_transito_sg;

  // Alertas — sellados >= 25 días sin presentar
  const urgentes_presentar = db.prepare(`
    SELECT id, n_remito_ifco, fecha_sellado, empresa, sucursal,
      cantidad_recibida, cantidad_rechazada,
      CAST(julianday('now','localtime') - julianday(fecha_sellado) AS INTEGER) AS dias
    FROM ifco_remitos_super
    WHERE estado = 'sellado'
      AND eliminado_en IS NULL
      AND julianday('now','localtime') - julianday(fecha_sellado) >= 25
    ORDER BY fecha_sellado ASC
  `).all();

  const sin_sellar = db.prepare(`
    SELECT id, n_remito_ifco, fecha_emision, empresa, sucursal, cantidad_despachada,
      CAST(julianday('now','localtime') - julianday(fecha_emision) AS INTEGER) AS dias
    FROM ifco_remitos_super
    WHERE estado = 'despachado'
      AND eliminado_en IS NULL
      AND julianday('now','localtime') - julianday(fecha_emision) >= 30
    ORDER BY fecha_emision ASC
  `).all();

  const envios_vencidos = db.prepare(`
    SELECT e.id, e.n_remito_interno, e.fecha_envio, e.cantidad_enviada,
      p.nombre AS proveedor_nombre,
      CAST(julianday('now','localtime') - julianday(e.fecha_envio) AS INTEGER) AS dias
    FROM ifco_envios_proveedor e
    LEFT JOIN proveedores p ON p.id = e.proveedor_id
    WHERE e.estado = 'enviado'
      AND e.eliminado_en IS NULL
      AND julianday('now','localtime') - julianday(e.fecha_envio) >= 15
    ORDER BY e.fecha_envio ASC
  `).all();

  // Estado del talonario activo
  const tal = db.prepare("SELECT * FROM ifco_talonarios WHERE activo = 1 LIMIT 1").get();
  let talonario_alerta = null, talonario_info = null;
  if (tal) {
    const u = db.prepare(`
      SELECT n_remito_ifco FROM ifco_remitos_super
      WHERE talonario_id = ? AND eliminado_en IS NULL ORDER BY id DESC LIMIT 1
    `).get(tal.id);
    let proxNum = tal.numero_desde;
    if (u) {
      const m = String(u.n_remito_ifco).match(/-(\d+)$/);
      if (m) proxNum = parseInt(m[1], 10) + 1;
    }
    const disp = Math.max(0, tal.numero_hasta - proxNum + 1);
    let dias_cai = null;
    if (tal.vto_cai) {
      dias_cai = Math.floor((new Date(tal.vto_cai) - new Date()) / (1000*60*60*24));
    }
    talonario_info = { serie: tal.serie, disponibles: disp, dias_cai: dias_cai };
    if (disp < 100 || (dias_cai !== null && dias_cai < 60)) {
      talonario_alerta = {
        serie: tal.serie,
        disponibles: disp,
        dias_cai: dias_cai,
        razon: disp < 100 ? 'pocos_remitos' : 'cai_vence'
      };
    }
  }

  // Saldos por cliente
  const por_cliente = db.prepare(`
    SELECT
      cliente_id, empresa,
      SUM(CASE WHEN estado='despachado' THEN cantidad_despachada ELSE 0 END) AS en_transito,
      SUM(CASE WHEN estado='sellado' THEN 1 ELSE 0 END) AS sellados_pendientes_count
    FROM ifco_remitos_super
    WHERE estado IN ('despachado','sellado') AND eliminado_en IS NULL
    GROUP BY cliente_id, empresa
    HAVING en_transito > 0 OR sellados_pendientes_count > 0
    ORDER BY en_transito DESC, sellados_pendientes_count DESC
  `).all();

  // Saldos por proveedor — usa el cálculo unificado
  const por_proveedor = db.prepare(`
    SELECT id, nombre AS proveedor_nombre FROM proveedores
  `).all().map(function(p){
    const pendiente = _calcSaldoProveedor(p.id);
    return { proveedor_id: p.id, proveedor_nombre: p.proveedor_nombre, pendiente: pendiente };
  }).filter(function(x){ return x.pendiente > 0; })
    .sort(function(a,b){ return b.pendiente - a.pendiente; });

  res.json({
    stock: {
      piso: piso,
      en_proveedores: en_proveedores,
      en_transito: en_transito_sg,
      bajo_responsabilidad: bajo_responsabilidad,
      perdidas_acumuladas: perdido,
      retirado_total: retirado
    },
    alertas: {
      urgentes_presentar: urgentes_presentar,
      sin_sellar: sin_sellar,
      envios_vencidos: envios_vencidos,
      talonario: talonario_alerta
    },
    saldos: {
      por_cliente: por_cliente,
      por_proveedor: por_proveedor
    },
    talonario: talonario_info
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CATÁLOGOS auxiliares (para los selects de la UI)
// ════════════════════════════════════════════════════════════════════════════

router.get('/proveedores', function(req, res) {
  const rows = db.prepare(`
    SELECT id, nombre, razon_social, cuit FROM proveedores
    WHERE activo = 1 ORDER BY nombre
  `).all();
  res.json(rows);
});

router.get('/clientes-dedicados', function(req, res) {
  // dedicados_clientes existe pero no está creada en db.js — la query es defensiva
  try {
    const rows = db.prepare(`
      SELECT id, nombre, empresa, supermercado, telefono FROM dedicados_clientes
      WHERE activo = 1 ORDER BY empresa, nombre
    `).all();
    res.json(rows);
  } catch(e) {
    res.json([]);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SALDO POR PROVEEDOR (para vista imprimible del envío)
// ════════════════════════════════════════════════════════════════════════════

// Saldo del proveedor:
//   + cajones que SG envió al proveedor (pendientes de devolución, vía envíos parcial/enviado)
//   - cajones que SG recibió del proveedor en su depósito (recepciones de mercadería)
//   - cajones despachados a súper como "directo desde este proveedor" Y SELLADOS
//
// Todos los cálculos excluyen registros eliminados (papelera).
function _calcSaldoProveedor(provId) {
  // Cajones que tiene en su galpón (saldo positivo):
  // = lo que SG le envió + lo que recibió de traspasos (es destino)
  const enviado = db.prepare(`
    SELECT COALESCE(SUM(cantidad_enviada - COALESCE(cantidad_recibida,0)), 0) AS total
    FROM ifco_envios_proveedor
    WHERE proveedor_id = ? AND eliminado_en IS NULL
      AND estado IN ('enviado','parcial')
  `).get(provId).total || 0;

  // Cajones que devolvió con mercadería a SG (resta)
  const recibidoEnSG = db.prepare(`
    SELECT COALESCE(SUM(cantidad), 0) AS total
    FROM ifco_recepciones_proveedor
    WHERE proveedor_id = ? AND eliminado_en IS NULL
      AND (es_r22 IS NULL OR es_r22 = 0)
      AND (estado IS NULL OR estado = 'recibido')
  `).get(provId).total || 0;

  // Cajones despachados directos desde su galpón a una cadena (resta)
  const directosSellados = db.prepare(`
    SELECT COALESCE(SUM(
      COALESCE(cantidad_recibida, cantidad_despachada) +
      CASE WHEN rechazo_destino = 'san_geronimo' THEN COALESCE(cantidad_rechazada, 0) ELSE 0 END
    ), 0) AS total
    FROM ifco_remitos_super
    WHERE proveedor_origen_id = ?
      AND origen = 'proveedor_directo'
      AND estado IN ('sellado','enviado','presentado')
      AND eliminado_en IS NULL
  `).get(provId).total || 0;

  // Cajones que envió a OTRO galpón (traspasos donde este proveedor es origen). Resta.
  // Solo cuenta cuando ya se aceptaron o están en tránsito (no canceladas).
  const traspasosEnviados = db.prepare(`
    SELECT COALESCE(SUM(cantidad_enviada), 0) AS total
    FROM ifco_envios_proveedor
    WHERE origen_proveedor_id = ? AND eliminado_en IS NULL
      AND estado IN ('enviado','parcial','recibido')
  `).get(provId).total || 0;

  return enviado - recibidoEnSG - directosSellados - traspasosEnviados;
}

// Stock FÍSICO actual del proveedor: lo que debería estar en su depósito ahora.
// Se descuenta del saldo oficial los despachos "sin sellar" (estado='despachado'),
// porque esas cajas ya salieron del depósito del proveedor aunque el remito
// todavía no esté sellado por el súper.
function _stockFisicoProveedor(provId) {
  const saldo = _calcSaldoProveedor(provId);
  let sinSellar = 0;
  try {
    sinSellar = (db.prepare(`
      SELECT COALESCE(SUM(cantidad_despachada), 0) AS total
      FROM ifco_remitos_super
      WHERE proveedor_origen_id = ?
        AND origen = 'proveedor_directo'
        AND estado = 'despachado'
        AND eliminado_en IS NULL
    `).get(provId) || {}).total || 0;
  } catch(_) {}
  return saldo - sinSellar;
}

router.get('/saldo-proveedor/:id', function(req, res) {
  const provId = parseInt(req.params.id);
  if (!provId) return res.status(400).json({ error: 'ID proveedor inválido' });
  const pendiente = _calcSaldoProveedor(provId);
  res.json({ proveedor_id: provId, pendiente: pendiente });
});

// LISTA: todos los proveedores con su saldo actual de cajones IFCO (incluye 0 y negativos)
router.get('/proveedores-saldos', function(req, res) {
  const provs = db.prepare("SELECT id, nombre, razon_social FROM proveedores ORDER BY nombre").all();
  const result = provs.map(function(p) {
    return {
      id: p.id,
      nombre: p.nombre,
      razon_social: p.razon_social,
      saldo: _calcSaldoProveedor(p.id)
    };
  });
  res.json(result);
});

// Despachos a súper agrupados por mes (últimos 12 meses)
router.get('/despachos-por-mes', function(req, res) {
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m', fecha_emision) AS mes,
      COUNT(*) AS remitos,
      COALESCE(SUM(cantidad_despachada), 0) AS cajones
    FROM ifco_remitos_super
    WHERE eliminado_en IS NULL
      AND fecha_emision IS NOT NULL
      AND fecha_emision >= date('now','localtime','-12 months')
    GROUP BY mes
    ORDER BY mes DESC
  `).all();
  res.json(rows);
});

// Helper: arma la lista cronológica de movimientos de un proveedor
function _movimientosProveedor(provId, desde, hasta) {
  // Filtros de fecha opcionales (formato 'YYYY-MM-DD')
  const filtroDesde = desde ? ' AND fecha_envio >= ?' : '';
  const filtroHasta = hasta ? ' AND fecha_envio <= ?' : '';
  const paramsEnvios = [provId];
  if (desde) paramsEnvios.push(desde);
  if (hasta) paramsEnvios.push(hasta);
  const envios = db.prepare(`
    SELECT 'envio' AS tipo, id, fecha_envio AS fecha, n_remito_interno AS detalle,
           cantidad_enviada AS cantidad, cantidad_recibida, estado, notas
    FROM ifco_envios_proveedor
    WHERE proveedor_id = ? AND eliminado_en IS NULL${filtroDesde}${filtroHasta}
  `).all(...paramsEnvios);

  const filtroRDesde = desde ? ' AND fecha_recepcion >= ?' : '';
  const filtroRHasta = hasta ? ' AND fecha_recepcion <= ?' : '';
  const paramsRec = [provId];
  if (desde) paramsRec.push(desde);
  if (hasta) paramsRec.push(hasta);
  const recepciones = db.prepare(`
    SELECT 'recepcion' AS tipo, id, fecha_recepcion AS fecha,
           COALESCE(producto, n_remito_proveedor, 'Recepción de mercadería') AS detalle,
           cantidad, n_remito_proveedor, notas
    FROM ifco_recepciones_proveedor
    WHERE proveedor_id = ? AND eliminado_en IS NULL
      AND (es_r22 IS NULL OR es_r22 = 0)
      AND (estado IS NULL OR estado = 'recibido')${filtroRDesde}${filtroRHasta}
  `).all(...paramsRec);

  const filtroDDesde = desde ? ' AND fecha_emision >= ?' : '';
  const filtroDHasta = hasta ? ' AND fecha_emision <= ?' : '';
  const paramsDir = [provId];
  if (desde) paramsDir.push(desde);
  if (hasta) paramsDir.push(hasta);
  const directos = db.prepare(`
    SELECT 'despacho_directo' AS tipo, id, fecha_emision AS fecha,
           (n_remito_ifco || ' → ' || COALESCE(empresa,'?')) AS detalle,
           cantidad_despachada AS cantidad, cantidad_recibida, cantidad_rechazada,
           estado, fecha_sellado, sucursal, rechazo_destino
    FROM ifco_remitos_super
    WHERE proveedor_origen_id = ? AND origen = 'proveedor_directo' AND eliminado_en IS NULL${filtroDDesde}${filtroDHasta}
  `).all(...paramsDir);

  const all = envios.concat(recepciones, directos);
  // Orden cronológico ascendente (después por id como desempate)
  all.sort(function(a,b) {
    if (a.fecha === b.fecha) return (a.id||0) - (b.id||0);
    return (a.fecha||'') < (b.fecha||'') ? -1 : 1;
  });

  // Calcular delta de cada movimiento (mismo criterio que _calcSaldoProveedor)
  return all.map(function(m) {
    let delta = 0;
    if (m.tipo === 'envio') {
      // Saldo: sale cantidad enviada, vuelve cantidad recibida (esa parte se descuenta abajo)
      // Acá registramos el envío entero como +cantidad
      // Ojo: si el envío está finalizado, su cantidad_recibida ya está computada en las recepciones (otra tabla),
      //      por eso solo suma "cantidad_enviada" entera y las recepciones lo bajan.
      delta = +m.cantidad;
    } else if (m.tipo === 'recepcion') {
      delta = -m.cantidad;
    } else if (m.tipo === 'despacho_directo') {
      if (m.estado === 'sellado' || m.estado === 'enviado' || m.estado === 'presentado') {
        const recib = m.cantidad_recibida != null ? m.cantidad_recibida : m.cantidad;
        const rech  = m.cantidad_rechazada || 0;
        // Si el rechazo volvió a SG, también sale del proveedor (= todo lo despachado)
        // Si el rechazo se quedó con el proveedor (o NULL), solo sale lo recibido por el súper
        if (m.rechazo_destino === 'san_geronimo') {
          delta = -(recib + rech);
        } else {
          delta = -recib;
        }
      } else if (m.estado === 'despachado') {
        // Despachado pero sin sellar todavía: las cajas físicamente ya salieron del proveedor.
        // Restamos el total despachado. Cuando se selle se recalcula con recibida/rechazada.
        delta = -(m.cantidad || 0);
      } else {
        delta = 0;
      }
    }
    // Etiqueta legible para el campo estado: "sin sellar" si despachado, agrega "rechazado" si hubo
    let estado_label = (m.estado === 'despachado') ? 'sin sellar' : (m.estado || '-');
    if ((m.cantidad_rechazada || 0) > 0) estado_label = estado_label + ' · rechazado';
    return Object.assign({}, m, { delta: delta, estado_label: estado_label });
  });
}

// MOVIMIENTOS de un proveedor (envíos + recepciones + despachos directos)
router.get('/proveedores/:id/movimientos', function(req, res) {
  const provId = parseInt(req.params.id);
  if (!provId) return res.status(400).json({ error: 'ID inválido' });
  // Control de acceso: proveedores solo pueden ver el suyo
  const errAcc = _verificarAccesoDeposito(req.user, 'proveedor', provId);
  if (errAcc) return res.status(403).json({ error: errAcc });
  const p = db.prepare("SELECT id, nombre, razon_social FROM proveedores WHERE id = ?").get(provId);
  if (!p) return res.status(404).json({ error: 'Proveedor no encontrado' });

  const movimientos = _movimientosProveedor(provId);
  const saldo = _calcSaldoProveedor(provId);
  res.json({ proveedor: p, movimientos: movimientos, saldo: saldo });
});

// PDF con los movimientos del proveedor (mismo contenido que el modal)
let _ifcoJsPDF = null;
async function _getIfcoJsPDF() {
  if (_ifcoJsPDF) return _ifcoJsPDF;
  try {
    const mod = await import('jspdf');
    _ifcoJsPDF = mod.jsPDF || mod.default || mod;
    return _ifcoJsPDF;
  } catch(e) { console.error('[IFCO] jspdf no disponible:', e.message); return null; }
}

// Sanitiza un string para que jsPDF (Helvetica WinAnsi) lo renderice bien.
// Reemplaza caracteres unicode no soportados por equivalentes ASCII,
// que de otra forma aparecen como '!' o causan kerning/espaciado raro.
function _pdfSafe(s) {
  if (s == null) return '';
  return String(s)
    .replace(/→/g, '->')
    .replace(/←/g, '<-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/–/g, '-')
    .replace(/—/g, '-')
    .replace(/…/g, '...')
    .replace(/•/g, '*')
    .replace(/✓/g, 'OK')
    .replace(/✗/g, 'X');
}

router.get('/proveedores/:id/movimientos.pdf', async function(req, res) {
  try {
    const provId = parseInt(req.params.id);
    if (!provId) return res.status(400).json({ error: 'ID inválido' });
    // Control de acceso: proveedores solo pueden ver el suyo
    const errAcc = _verificarAccesoDeposito(req.user, 'proveedor', provId);
    if (errAcc) return res.status(403).json({ error: errAcc });
    const p = db.prepare("SELECT id, nombre, razon_social FROM proveedores WHERE id = ?").get(provId);
    if (!p) return res.status(404).json({ error: 'Proveedor no encontrado' });

    // Filtros de fecha opcionales (YYYY-MM-DD)
    const desde = (req.query.desde || '').slice(0,10) || null;
    const hasta = (req.query.hasta || '').slice(0,10) || null;

    const jsPDF = await _getIfcoJsPDF();
    if (!jsPDF) return res.status(503).json({ error: 'jspdf no disponible' });

    const movimientos = _movimientosProveedor(provId, desde, hasta);
    const saldo = _calcSaldoProveedor(provId);
    const stockFisico = _stockFisicoProveedor(provId);

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, H = 297, M = 14;
    const L = M, R = W - M, innerW = R - L;
    const setF = (sz, bold) => { doc.setFontSize(sz); doc.setFont('helvetica', bold ? 'bold' : 'normal'); };
    const fechaFmt = (s) => { if (!s) return ''; const p = String(s).split(' ')[0].split('-'); return p.length===3 ? p[2]+'/'+p[1]+'/'+p[0] : s; };
    const fmt = (n) => Number(n||0).toLocaleString('es-AR');

    // Header
    setF(16, true);
    doc.text('Movimientos de cajones IFCO', L, M + 5);
    setF(10, false);
    doc.setTextColor(110);
    doc.text(_pdfSafe('LA NIÑA BONITA - San Gerónimo S.A.'), L, M + 10);
    // Sub-header con rango si viene
    if (desde || hasta) {
      setF(9, false);
      const rango = 'Período: ' + (desde ? fechaFmt(desde) : 'inicio') + ' a ' + (hasta ? fechaFmt(hasta) : 'hoy');
      doc.text(rango, L, M + 14);
    }
    doc.setTextColor(0);

    // Datos del proveedor + saldo + stock fisico (caja destacada)
    let y = (desde || hasta) ? M + 22 : M + 18;
    const boxH = 30;
    doc.setLineWidth(0.4);
    doc.setFillColor(248, 248, 248);
    doc.roundedRect(L, y, innerW, boxH, 2, 2, 'FD');
    // Lado izquierdo: nombre y razón social (centrados verticalmente en la caja)
    setF(13, true);
    doc.text(_pdfSafe(p.nombre || '-'), L + 4, y + 12);
    setF(9, false);
    doc.setTextColor(110);
    doc.text(_pdfSafe(p.razon_social || ''), L + 4, y + 18);
    doc.setTextColor(0);

    // Lado derecho: dos valores stackeados
    const colorRGB = (n) => n < 0 ? [200,30,30] : (n > 0 ? [30,130,60] : [110,110,110]);

    // (1) EN PODER DEL PROVEEDOR (saldo oficial)
    setF(7, false);
    doc.setTextColor(110);
    const saldoLabel = saldo > 0 ? 'EN PODER DEL PROVEEDOR' : (saldo < 0 ? 'EXCESO ENTREGADO AL PROVEEDOR' : 'SALDO');
    doc.text(saldoLabel, R - 4, y + 5, { align: 'right' });
    const cs = colorRGB(saldo);
    doc.setTextColor(cs[0], cs[1], cs[2]);
    setF(13, true);
    doc.text(fmt(saldo) + ' caj.', R - 4, y + 12, { align: 'right' });
    doc.setTextColor(0);

    // (2) STOCK QUE TIENE QUE TENER (físico real, descuenta despachos sin sellar)
    setF(7, false);
    doc.setTextColor(110);
    doc.text('STOCK QUE TIENE QUE TENER', R - 4, y + 19, { align: 'right' });
    const cf = colorRGB(stockFisico);
    doc.setTextColor(cf[0], cf[1], cf[2]);
    setF(13, true);
    doc.text(fmt(stockFisico) + ' caj.', R - 4, y + 26, { align: 'right' });
    doc.setTextColor(0);

    y += boxH + 6;
    setF(9, false);
    doc.setTextColor(110);
    doc.text(movimientos.length + ' movimientos', L, y);
    doc.setTextColor(0);
    y += 5;

    // Encabezados de tabla
    const cFecha  = L;
    const cTipo   = L + 28;
    const cDet    = L + 60;
    const cCant   = L + innerW - 50;
    const cEst    = L + innerW - 22;
    setF(8.5, true);
    doc.setLineWidth(0.3);
    doc.line(L, y, R, y);
    y += 4;
    doc.text('FECHA',    cFecha, y);
    doc.text('TIPO',     cTipo,  y);
    doc.text('DETALLE',  cDet,   y);
    doc.text('CANT.',    cCant + 24, y, { align: 'right' });
    doc.text('ESTADO',   cEst,   y);
    y += 2;
    doc.line(L, y, R, y);
    y += 4;

    // Filas
    setF(8.5, false);
    const labelTipo = (t) => t === 'envio' ? 'Envio' : t === 'recepcion' ? 'Recepcion' : 'Directo super';
    const truncar = (s, max) => { s = _pdfSafe(s); return s.length > max ? s.slice(0, max - 1) + '...' : s; };

    for (const m of movimientos) {
      // Salto de página si no entra
      if (y > H - 25) {
        doc.addPage();
        y = M + 8;
        setF(8.5, true);
        doc.line(L, y, R, y);
        y += 4;
        doc.text('FECHA', cFecha, y);
        doc.text('TIPO',  cTipo,  y);
        doc.text('DETALLE', cDet, y);
        doc.text('CANT.', cCant + 24, y, { align: 'right' });
        doc.text('ESTADO', cEst, y);
        y += 2;
        doc.line(L, y, R, y);
        y += 4;
        setF(8.5, false);
      }
      doc.text(fechaFmt(m.fecha),         cFecha, y);
      doc.text(labelTipo(m.tipo),         cTipo,  y);
      doc.text(truncar(m.detalle, 55),    cDet,   y);
      const deltaTxt = (m.delta > 0 ? '+' : '') + fmt(m.delta);
      if (m.delta < 0) doc.setTextColor(180, 30, 30);
      else if (m.delta > 0) doc.setTextColor(30, 130, 60);
      doc.text(deltaTxt, cCant + 24, y, { align: 'right' });
      doc.setTextColor(0);
      doc.text(_pdfSafe(m.estado_label || m.estado || '-'),   cEst, y);
      y += 5;
      // Línea separadora suave
      doc.setDrawColor(230);
      doc.line(L, y - 1.5, R, y - 1.5);
      doc.setDrawColor(0);
    }

    // Pie
    setF(7, false);
    doc.setTextColor(140);
    doc.text('Generado el ' + new Date().toLocaleString('es-AR'), L, H - 8);
    doc.text('Pagina 1 de ' + doc.internal.getNumberOfPages(), R, H - 8, { align: 'right' });

    const buf = Buffer.from(doc.output('arraybuffer'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="movimientos-' + (p.nombre || provId).replace(/[^a-z0-9]+/gi,'_') + '.pdf"');
    res.send(buf);
  } catch(e) {
    console.error('[IFCO][movimientos.pdf] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// EXPORTAR movimientos a Excel (.xlsx) — PENDIENTE: requiere instalar dependency `xlsx` (SheetJS)
// Endpoint comentado hasta que se haga `npm install xlsx`. Después descomentar y reactivar el botón
// en el modal de movimientos del proveedor (ifcoDescargarMovimientosXlsx en panel.html).

// ════════════════════════════════════════════════════════════════════════════
// MOVIMIENTOS DE PLANTA SAN GERÓNIMO (todos los flujos que afectan stock SG)
// ════════════════════════════════════════════════════════════════════════════

function _movimientosSanGeronimo(desde, hasta) {
  // Helper para construir filtros de fecha sobre una columna
  const filtro = (col) => {
    let where = '';
    const params = [];
    if (desde) { where += ' AND ' + col + ' >= ?'; params.push(desde); }
    if (hasta) { where += ' AND ' + col + ' <= ?'; params.push(hasta); }
    return { where, params };
  };

  // Retiros (ingreso manual a SG)
  const fRet = filtro('fecha');
  const retiros = db.prepare(`
    SELECT 'retiro' AS tipo, id, fecha,
           ('Modelo ' || COALESCE(modelo,'?') || COALESCE(' / ' || n_remito, '') || COALESCE(' / ' || sucursal_ifco, '')) AS detalle,
           cantidad, NULL AS estado
    FROM ifco_movimientos
    WHERE tipo = 'retiro' AND eliminado_en IS NULL${fRet.where}
  `).all(...fRet.params);

  // Pérdidas (egreso de SG)
  const fPer = filtro('fecha');
  const perdidas = db.prepare(`
    SELECT 'perdida' AS tipo, id, fecha,
           COALESCE(notas, 'Pérdida') AS detalle,
           cantidad, NULL AS estado
    FROM ifco_movimientos
    WHERE tipo = 'perdida' AND eliminado_en IS NULL${fPer.where}
  `).all(...fPer.params);

  // Envíos a proveedor (egreso de SG)
  const fEnv = filtro('ep.fecha_envio');
  const envios = db.prepare(`
    SELECT 'envio' AS tipo, ep.id, ep.fecha_envio AS fecha,
           (ep.n_remito_interno || ' → ' || COALESCE(p.nombre,'?')) AS detalle,
           ep.cantidad_enviada AS cantidad, ep.estado
    FROM ifco_envios_proveedor ep
    LEFT JOIN proveedores p ON p.id = ep.proveedor_id
    WHERE ep.eliminado_en IS NULL${fEnv.where}
  `).all(...fEnv.params);

  // Recepciones desde proveedor (ingreso a SG)
  const fRec = filtro('rp.fecha_recepcion');
  const recepciones = db.prepare(`
    SELECT 'recepcion' AS tipo, rp.id, rp.fecha_recepcion AS fecha,
           (COALESCE(p.nombre,'?') || COALESCE(' / ' || rp.n_remito_proveedor, '')) AS detalle,
           rp.cantidad, NULL AS estado
    FROM ifco_recepciones_proveedor rp
    LEFT JOIN proveedores p ON p.id = rp.proveedor_id
    WHERE rp.eliminado_en IS NULL
      AND (rp.es_r22 IS NULL OR rp.es_r22 = 0)
      AND (rp.estado IS NULL OR rp.estado = 'recibido')${fRec.where}
  `).all(...fRec.params);

  // Despachos al súper desde SG (egreso de SG)
  const fDes = filtro('fecha_emision');
  const despachos = db.prepare(`
    SELECT 'despacho_sg' AS tipo, id, fecha_emision AS fecha,
           (n_remito_ifco || ' → ' || COALESCE(empresa,'?')) AS detalle,
           cantidad_despachada AS cantidad, cantidad_recibida, cantidad_rechazada,
           estado, rechazo_destino
    FROM ifco_remitos_super
    WHERE origen = 'san_geronimo' AND eliminado_en IS NULL${fDes.where}
  `).all(...fDes.params);

  // Faltantes declarados (ajustes manuales que afectan el teórico SG)
  // delta>0 = se declara faltante (sale del piso); delta<0 = se reduce el faltante (vuelve)
  let faltantes = [];
  try {
    const fFal = filtro('fecha');
    faltantes = db.prepare(`
      SELECT 'faltante_sg' AS tipo, id, fecha,
             COALESCE(motivo, 'Faltante declarado') AS detalle,
             delta AS cantidad, NULL AS estado
      FROM ifco_faltantes_sg
      WHERE eliminado_en IS NULL${fFal.where}
    `).all(...fFal.params);
  } catch(_) { /* tabla no existe en bases viejas, ignorar */ }

  const all = retiros.concat(perdidas, envios, recepciones, despachos, faltantes);
  // Orden cronológico ascendente, id como desempate
  all.sort(function(a,b) {
    if (a.fecha === b.fecha) return (a.id||0) - (b.id||0);
    return (a.fecha||'') < (b.fecha||'') ? -1 : 1;
  });

  // Calcular delta de cada movimiento (mismo criterio que _stockTeoricoDeposito para SG)
  return all.map(function(m) {
    let delta = 0;
    if (m.tipo === 'retiro')          delta = +m.cantidad;
    else if (m.tipo === 'perdida')    delta = -m.cantidad;
    else if (m.tipo === 'envio')      delta = -m.cantidad;
    else if (m.tipo === 'recepcion')  delta = +m.cantidad;
    else if (m.tipo === 'faltante_sg') {
      // delta de la fila ifco_faltantes_sg ya viene firmado:
      // delta>0 = se declara faltante (sale del piso) -> impacto -delta
      // delta<0 = se reduce el faltante (vuelve)      -> impacto +|delta|
      delta = -(m.cantidad || 0);
    }
    else if (m.tipo === 'despacho_sg') {
      // SG: sale toda la cantidad despachada. Si hay rechazo y vuelve a SG (o destino NULL),
      // se suma de vuelta el rechazo. Mismo criterio que el cálculo de stock teórico.
      const desp = m.cantidad || 0;
      const rech = m.cantidad_rechazada || 0;
      if (m.rechazo_destino == null || m.rechazo_destino === 'san_geronimo') {
        delta = -(desp - rech);
      } else {
        delta = -desp;
      }
    }
    // Etiqueta legible: "sin sellar" si despachado, agrega "rechazado" si hubo
    let estado_label = (m.estado === 'despachado') ? 'sin sellar' : (m.estado || '-');
    if ((m.cantidad_rechazada || 0) > 0) estado_label = estado_label + ' · rechazado';
    return Object.assign({}, m, { delta: delta, estado_label: estado_label });
  });
}

router.get('/san-geronimo/movimientos.pdf', async function(req, res) {
  try {
    // Control de acceso: solo admin / sin depósito / users SG
    const errAcc = _verificarAccesoDeposito(req.user, 'san_geronimo', null);
    if (errAcc) return res.status(403).json({ error: errAcc });
    // Filtros de fecha opcionales (YYYY-MM-DD)
    const desde = (req.query.desde || '').slice(0,10) || null;
    const hasta = (req.query.hasta || '').slice(0,10) || null;

    const jsPDF = await _getIfcoJsPDF();
    if (!jsPDF) return res.status(503).json({ error: 'jspdf no disponible' });

    const movimientos = _movimientosSanGeronimo(desde, hasta);
    // Stock SG actual (siempre el total, no filtrado por fecha)
    let stockSG = 0;
    try { stockSG = _stockTeoricoDeposito('san_geronimo'); } catch(_) {}

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, H = 297, M = 14;
    const L = M, R = W - M, innerW = R - L;
    const setF = (sz, bold) => { doc.setFontSize(sz); doc.setFont('helvetica', bold ? 'bold' : 'normal'); };
    const fechaFmt = (s) => { if (!s) return ''; const p = String(s).split(' ')[0].split('-'); return p.length===3 ? p[2]+'/'+p[1]+'/'+p[0] : s; };
    const fmt = (n) => Number(n||0).toLocaleString('es-AR');

    // Header
    setF(16, true);
    doc.text('Movimientos planta San Gerónimo', L, M + 5);
    setF(10, false);
    doc.setTextColor(110);
    doc.text(_pdfSafe('LA NIÑA BONITA - San Gerónimo S.A.'), L, M + 10);
    if (desde || hasta) {
      setF(9, false);
      const rango = 'Período: ' + (desde ? fechaFmt(desde) : 'inicio') + ' a ' + (hasta ? fechaFmt(hasta) : 'hoy');
      doc.text(rango, L, M + 14);
    }
    doc.setTextColor(0);

    // Caja destacada con stock SG actual
    let y = (desde || hasta) ? M + 22 : M + 18;
    doc.setLineWidth(0.4);
    doc.setFillColor(248, 248, 248);
    doc.roundedRect(L, y, innerW, 18, 2, 2, 'FD');
    setF(13, true);
    doc.text('San Gerónimo (planta)', L + 4, y + 7);
    setF(9, false);
    doc.setTextColor(110);
    doc.text('cajones en piso', L + 4, y + 12);
    doc.setTextColor(0);
    setF(8, false);
    doc.setTextColor(110);
    doc.text('STOCK PISO ACTUAL', R - 4, y + 6, { align: 'right' });
    doc.setTextColor(stockSG > 0 ? 30 : 110, stockSG > 0 ? 130 : 110, stockSG > 0 ? 60 : 110);
    setF(16, true);
    doc.text(fmt(stockSG) + ' caj.', R - 4, y + 14, { align: 'right' });
    doc.setTextColor(0);

    y += 24;
    setF(9, false);
    doc.setTextColor(110);
    doc.text(movimientos.length + ' movimientos', L, y);
    doc.setTextColor(0);
    y += 5;

    // Encabezados de tabla
    const cFecha  = L;
    const cTipo   = L + 28;
    const cDet    = L + 60;
    const cCant   = L + innerW - 50;
    const cEst    = L + innerW - 22;
    setF(8.5, true);
    doc.setLineWidth(0.3);
    doc.line(L, y, R, y);
    y += 4;
    doc.text('FECHA',    cFecha, y);
    doc.text('TIPO',     cTipo,  y);
    doc.text('DETALLE',  cDet,   y);
    doc.text('CANT.',    cCant + 24, y, { align: 'right' });
    doc.text('ESTADO',   cEst,   y);
    y += 2;
    doc.line(L, y, R, y);
    y += 4;

    // Filas
    setF(8.5, false);
    const labelTipo = (t) => {
      if (t === 'retiro')        return 'Retiro IFCO';
      if (t === 'perdida')       return 'Perdida';
      if (t === 'envio')         return 'Envio prov.';
      if (t === 'recepcion')     return 'Recepcion';
      if (t === 'despacho_sg')   return 'Despacho super';
      if (t === 'faltante_sg')   return 'Faltante decl.';
      return t;
    };
    const truncar = (s, max) => { s = _pdfSafe(s); return s.length > max ? s.slice(0, max - 1) + '...' : s; };

    for (const m of movimientos) {
      if (y > H - 25) {
        doc.addPage();
        y = M + 8;
        setF(8.5, true);
        doc.line(L, y, R, y);
        y += 4;
        doc.text('FECHA', cFecha, y);
        doc.text('TIPO',  cTipo,  y);
        doc.text('DETALLE', cDet, y);
        doc.text('CANT.', cCant + 24, y, { align: 'right' });
        doc.text('ESTADO', cEst, y);
        y += 2;
        doc.line(L, y, R, y);
        y += 4;
        setF(8.5, false);
      }
      doc.text(fechaFmt(m.fecha),         cFecha, y);
      doc.text(labelTipo(m.tipo),         cTipo,  y);
      doc.text(truncar(m.detalle, 55),    cDet,   y);
      const deltaTxt = (m.delta > 0 ? '+' : '') + fmt(m.delta);
      if (m.delta < 0) doc.setTextColor(180, 30, 30);
      else if (m.delta > 0) doc.setTextColor(30, 130, 60);
      doc.text(deltaTxt, cCant + 24, y, { align: 'right' });
      doc.setTextColor(0);
      doc.text(_pdfSafe(m.estado_label || m.estado || '-'),   cEst, y);
      y += 5;
      doc.setDrawColor(230);
      doc.line(L, y - 1.5, R, y - 1.5);
      doc.setDrawColor(0);
    }

    setF(7, false);
    doc.setTextColor(140);
    doc.text('Generado el ' + new Date().toLocaleString('es-AR'), L, H - 8);
    doc.text('Pagina 1 de ' + doc.internal.getNumberOfPages(), R, H - 8, { align: 'right' });

    const buf = Buffer.from(doc.output('arraybuffer'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="movimientos-san_geronimo.pdf"');
    res.send(buf);
  } catch(e) {
    console.error('[IFCO][san-geronimo/movimientos.pdf] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// RECEPCIONES DE MERCADERÍA DEL PROVEEDOR
// (cajones IFCO que vuelven a SG con producto cargado, opcionalmente atado a un envío)
// ════════════════════════════════════════════════════════════════════════════

router.get('/recepciones-proveedor', function(req, res) {
  const f = req.query;
  const papelera = f.papelera === '1' || f.incluir_eliminados === '1';
  let q = `SELECT r.*,
                  p.nombre  AS proveedor_nombre,
                  p.razon_social AS proveedor_razon,
                  u.nombre AS eliminado_por_username,
                  uc.nombre AS usuario_creador_nombre
           FROM ifco_recepciones_proveedor r
           LEFT JOIN proveedores p ON p.id = r.proveedor_id
           LEFT JOIN usuarios u ON u.id = r.eliminado_por_id
           LEFT JOIN usuarios uc ON uc.id = r.usuario_id
           WHERE 1=1`;
  const p = [];
  if (papelera) q += " AND r.eliminado_en IS NOT NULL";
  else          q += " AND r.eliminado_en IS NULL";
  if (f.proveedor_id) { q += " AND r.proveedor_id = ?"; p.push(f.proveedor_id); }
  if (f.desde)        { q += " AND r.fecha_recepcion >= ?"; p.push(f.desde); }
  if (f.hasta)        { q += " AND r.fecha_recepcion <= ?"; p.push(f.hasta); }
  q += " ORDER BY r.fecha_recepcion DESC, r.id DESC LIMIT 500";
  res.json(db.prepare(q).all(...p));
});

router.get('/recepciones-proveedor/:id', function(req, res) {
  const r = db.prepare(`
    SELECT r.*, p.nombre AS proveedor_nombre, p.razon_social AS proveedor_razon
    FROM ifco_recepciones_proveedor r
    LEFT JOIN proveedores p ON p.id = r.proveedor_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  res.json(r);
});

router.post('/recepciones-proveedor', upload.single('escaneo'), function(req, res) {
  try {
    const d = req.body || {};
    if (!d.fecha_recepcion) return res.status(400).json({ error: 'Fecha requerida' });
    const cant = parseInt(d.cantidad);
    if (!cant || cant <= 0) return res.status(400).json({ error: 'Cantidad inválida' });

    // R22: IFCOs nuevos comprados al IFCO por el proveedor.
    const esR22 = !!(d.es_r22 && (d.es_r22 === '1' || d.es_r22 === 'true' || d.es_r22 === true));
    // Envío a SG: el proveedor (vía mobile) está despachando cajones a SG. No afecta hasta que SG confirme.
    const esEnvioSG = !!(d.es_envio_a_sg && (d.es_envio_a_sg === '1' || d.es_envio_a_sg === 'true' || d.es_envio_a_sg === true));
    const estado = esEnvioSG ? 'en_viaje' : 'recibido';

    let provId = null;
    if (esR22) {
      if (d.proveedor_id) {
        provId = parseInt(d.proveedor_id);
        const ex = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(provId);
        if (!ex) provId = null;
      }
    } else {
      if (!d.proveedor_id) return res.status(400).json({ error: 'Proveedor requerido' });
      const exProv = db.prepare("SELECT id FROM proveedores WHERE id = ?").get(d.proveedor_id);
      if (!exProv) return res.status(400).json({ error: 'Proveedor inexistente' });
      provId = parseInt(d.proveedor_id);
    }

    let escaneo_path = null;
    if (req.file) {
      escaneo_path = '/data/ifco/' + req.file.filename;
    } else if (d.escaneo_path && /^\/data\/ifco\//.test(d.escaneo_path)) {
      escaneo_path = d.escaneo_path;
    }

    const r = db.prepare(`
      INSERT INTO ifco_recepciones_proveedor
        (fecha_recepcion, proveedor_id, cantidad, producto, n_remito_proveedor, escaneo_path, notas, usuario_id, es_r22, estado, confirmado_en, confirmado_por_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      d.fecha_recepcion, provId, cant,
      d.producto || null, d.n_remito_proveedor || null,
      escaneo_path, d.notas || null, req.user.id || null,
      esR22 ? 1 : 0,
      estado,
      estado === 'recibido' ? new Date().toISOString().slice(0,19).replace('T',' ') : null,
      estado === 'recibido' ? (req.user.id || null) : null
    );

    let saldo = null;
    if (provId && estado === 'recibido') saldo = _calcSaldoProveedor(provId);
    res.json({ id: r.lastInsertRowid, escaneo_path: escaneo_path, saldo_proveedor_actual: saldo, estado: estado });
  } catch(e) {
    console.error('[IFCO][recepciones-proveedor POST] EXCEPCION:', e);
    res.status(500).json({ error: 'Error guardando recepción: ' + e.message });
  }
});

// POST /recepciones-proveedor/:id/confirmar — SG confirma la recepción de cajones que estaban "en viaje"
router.post('/recepciones-proveedor/:id/confirmar', function(req, res) {
  try {
    const r = db.prepare("SELECT * FROM ifco_recepciones_proveedor WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
    if (!r) return res.status(404).json({ error: 'No encontrado' });
    if (r.estado !== 'en_viaje') return res.status(400).json({ error: 'Solo se pueden confirmar recepciones en estado "en_viaje". Estado actual: ' + r.estado });
    db.prepare(`
      UPDATE ifco_recepciones_proveedor
      SET estado = 'recibido',
          confirmado_en = datetime('now','localtime'),
          confirmado_por_id = ?
      WHERE id = ?
    `).run(req.user.id || null, req.params.id);
    res.json({ ok: true });
  } catch(e) {
    console.error('[IFCO][confirmar] EXCEPCION:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /recepciones-proveedor/:id/rechazar — SG rechaza la recepción
router.post('/recepciones-proveedor/:id/rechazar', function(req, res) {
  try {
    const r = db.prepare("SELECT * FROM ifco_recepciones_proveedor WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
    if (!r) return res.status(404).json({ error: 'No encontrado' });
    if (r.estado !== 'en_viaje') return res.status(400).json({ error: 'Solo se pueden rechazar recepciones en estado "en_viaje". Estado actual: ' + r.estado });
    const motivo = (req.body && req.body.motivo) || null;
    db.prepare(`
      UPDATE ifco_recepciones_proveedor
      SET estado = 'rechazado',
          confirmado_en = datetime('now','localtime'),
          confirmado_por_id = ?,
          notas = COALESCE(notas, '') || CASE WHEN ? IS NOT NULL THEN ' [RECHAZO: ' || ? || ']' ELSE '' END
      WHERE id = ?
    `).run(req.user.id || null, motivo, motivo, req.params.id);
    res.json({ ok: true });
  } catch(e) {
    console.error('[IFCO][rechazar] EXCEPCION:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /recepciones-en-viaje — lista las pendientes de confirmar (para Resumen)
router.get('/recepciones-en-viaje', function(req, res) {
  const rows = db.prepare(`
    SELECT r.*, p.nombre AS proveedor_nombre
    FROM ifco_recepciones_proveedor r
    LEFT JOIN proveedores p ON p.id = r.proveedor_id
    WHERE r.estado = 'en_viaje' AND r.eliminado_en IS NULL
    ORDER BY r.fecha_recepcion DESC, r.id DESC
  `).all();
  res.json(rows);
});

router.patch('/recepciones-proveedor/:id', upload.single('escaneo'), function(req, res) {
  const r = db.prepare("SELECT * FROM ifco_recepciones_proveedor WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  if (r.eliminado_en) return res.status(400).json({ error: 'Está eliminado. Restauralo primero.' });
  const d = req.body || {};

  let escaneo_path = r.escaneo_path;
  if (req.file) {
    escaneo_path = '/data/ifco/' + req.file.filename;
  } else if (d.escaneo_path && /^\/data\/ifco\//.test(d.escaneo_path)) {
    escaneo_path = d.escaneo_path;
  }

  db.prepare(`
    UPDATE ifco_recepciones_proveedor SET
      fecha_recepcion    = COALESCE(?, fecha_recepcion),
      proveedor_id       = COALESCE(?, proveedor_id),
      cantidad           = COALESCE(?, cantidad),
      producto           = ?,
      n_remito_proveedor = ?,
      escaneo_path       = ?,
      notas              = ?
    WHERE id = ?
  `).run(
    d.fecha_recepcion || null,
    d.proveedor_id ? parseInt(d.proveedor_id) : null,
    d.cantidad ? parseInt(d.cantidad) : null,
    d.producto || null,
    d.n_remito_proveedor || null,
    escaneo_path,
    d.notas || null,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/recepciones-proveedor/:id', function(req, res) {
  const r = db.prepare("SELECT id, consolidado_en FROM ifco_recepciones_proveedor WHERE id = ? AND eliminado_en IS NULL").get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado o ya eliminado' });
  if (r.consolidado_en) return res.status(403).json({ error: 'Este registro ya fue consolidado con el archivo IFCO y no se puede eliminar.' });
  db.prepare(`UPDATE ifco_recepciones_proveedor
              SET eliminado_en = datetime('now','localtime'),
                  eliminado_por_id = ?
              WHERE id = ?`).run(req.user.id || null, req.params.id);
  res.json({ ok: true });
});

router.post('/recepciones-proveedor/:id/restaurar', function(req, res) {
  const r = db.prepare("SELECT * FROM ifco_recepciones_proveedor WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  if (!r.eliminado_en) return res.status(400).json({ error: 'No está en papelera' });
  db.prepare("UPDATE ifco_recepciones_proveedor SET eliminado_en = NULL, eliminado_por_id = NULL WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// OCR — Lectura automática de remitos IFCO con Claude vision
// ════════════════════════════════════════════════════════════════════════════

router.get('/ocr/status', function(req, res) {
  res.json({ enabled: OCR_ENABLED && !!ANTHROPIC_API_KEY, model: OCR_MODEL });
});

// Helper: extraer JSON limpio del texto que devuelve Claude
function _extraerJson(texto) {
  if (!texto) return null;
  // Pueden venir bloques ```json ... ``` o solo el JSON
  const matchFenced = texto.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidato = matchFenced ? matchFenced[1] : texto;
  const m = candidato.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch(e) { return null; }
}

// POST /ocr/remito-super  multipart: foto + tipo (despacho|sellado)
router.post('/ocr/remito-super', upload.single('foto'), async function(req, res) {
  if (!OCR_ENABLED || !ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'OCR deshabilitado en este entorno' });
  }
  if (!req.file) return res.status(400).json({ error: 'Falta archivo "foto"' });
  const tipo = (req.body && req.body.tipo) || 'despacho';
  if (['despacho','sellado','completo'].indexOf(tipo) < 0) {
    return res.status(400).json({ error: 'tipo debe ser "despacho", "sellado" o "completo"' });
  }
  const client = await _getAnthropic();
  if (!client) return res.status(503).json({ error: 'OCR no disponible (SDK no cargado)' });

  // Leer la foto y mandarla en base64
  const filePath = path.join(UPLOAD_DIR, req.file.filename);
  let mediaType = 'image/jpeg';
  const ext = path.extname(req.file.filename).toLowerCase();
  if (ext === '.png')  mediaType = 'image/png';
  if (ext === '.webp') mediaType = 'image/webp';
  if (ext === '.gif')  mediaType = 'image/gif';
  if (ext === '.pdf')  mediaType = 'application/pdf';
  if (mediaType === 'application/pdf') {
    return res.status(400).json({ error: 'PDF no soportado por OCR — subí JPG/PNG' });
  }
  let dataB64;
  try {
    const buf = fs.readFileSync(filePath);
    dataB64 = buf.toString('base64');
  } catch(e) {
    return res.status(500).json({ error: 'No se pudo leer el archivo subido: ' + e.message });
  }

  // Prompt según tipo
  const promptDespacho = [
    'Sos un asistente que lee remitos IFCO emitidos por SAN GERONIMO SA en Argentina.',
    'Esta foto es de un remito al momento de DESPACHARLO al supermercado (todavía no fue sellado por la cadena).',
    'Extraé los siguientes campos en formato JSON. Si un campo no se ve o no estás seguro, dejalo en null.',
    'Campos esperados:',
    '  "n_remito_ifco": string con formato "00015-XXXXXXXX" (preimpreso, esquina superior derecha)',
    '  "fecha_emision": string ISO "YYYY-MM-DD" (la fecha del despacho)',
    '  "empresa": string — la cadena de supermercado destinataria. Devolvé el valor EXACTO tal como aparece en el remito SOLO si coincide con uno de:',
    '    "CENCOSUD", "CARREFOUR (INC SA)", "COTO", "LA COOPERATIVA OBRERA", "LA ANONIMA", "CHANGO MAS (DORINKA)".',
    '    Si lo que ves se parece a uno de esos pero está abreviado o mal escrito, devolvé el de la lista que mejor matchea. Si no matchea ninguno, devolvé el texto literal del remito.',
    '  "cantidad_despachada": número entero — total de cajones (campo "TOTAL CAJAS" o equivalente)',
    '  "producto": string — descripción del producto cargado (ej. "mandarina malvina")',
    'NO leas ni extraigas: sucursal, transportista, encargado del proveedor, ni ningún otro dato adicional.',
    'Respondé SOLO el objeto JSON, sin texto adicional ni markdown.'
  ].join('\n');

  const promptSellado = [
    'Sos un asistente que lee remitos IFCO emitidos por SAN GERONIMO SA en Argentina.',
    'Esta foto es del MISMO remito ya VUELTO sellado por el supermercado destinatario.',
    'Extraé los datos del SELLADO en formato JSON. Si un campo no se ve, dejalo en null.',
    'Campos esperados:',
    '  "n_remito_ifco": string con formato "00015-XXXXXXXX"',
    '  "fecha_sellado": string ISO "YYYY-MM-DD" — la fecha de RECEPCIÓN del supermercado (puede estar manuscrita junto al sello)',
    '  "cantidad_recibida": número entero — cuántos cajones aceptó el súper',
    '  "cantidad_rechazada": número entero (0 si no hay rechazo)',
    '  "encargado_super_apellido": string — apellido de quien recibió en el súper',
    '  "encargado_super_nombre": string — nombre',
    '  "encargado_super_dni": string',
    'Respondé SOLO el objeto JSON, sin texto adicional ni markdown.'
  ].join('\n');

  // Prompt "completo": foto del remito YA sellado donde el remito original es legible
  // (cargas tardías donde nunca se subió la foto del despacho). Extrae todos los campos en una pasada.
  const promptCompleto = [
    'Sos un asistente que lee remitos IFCO emitidos por SAN GERONIMO SA en Argentina.',
    'Esta foto es de un remito QUE YA VOLVIÓ SELLADO del supermercado, pero nunca se cargó al sistema cuando salió.',
    'Tenés que extraer en una sola pasada los datos esenciales del despacho + las cantidades del sellado.',
    'Devolvé un JSON con estos campos. Si un campo no se ve o no estás seguro, dejalo en null.',
    '— Datos del DESPACHO (preimpreso o tipeado):',
    '  "n_remito_ifco": string con formato "00015-XXXXXXXX" (preimpreso, esquina superior derecha)',
    '  "fecha_emision": string ISO "YYYY-MM-DD" — fecha del despacho',
    '  "empresa": string — la cadena de supermercado destinataria. Devolvé el valor EXACTO tal como aparece SOLO si coincide con uno de:',
    '    "CENCOSUD", "CARREFOUR (INC SA)", "COTO", "LA COOPERATIVA OBRERA", "LA ANONIMA", "CHANGO MAS (DORINKA)".',
    '    Si lo que ves se parece a uno de esos pero está abreviado o mal escrito, devolvé el de la lista que mejor matchea. Si no matchea ninguno, devolvé el texto literal.',
    '  "cantidad_despachada": número entero — total de cajones (campo "TOTAL CAJAS" o equivalente)',
    '  "producto": string — descripción del producto cargado',
    '— Cantidades del SELLADO (manuscritos o sello del súper):',
    '  "cantidad_recibida": número entero — cuántos cajones aceptó el súper (si no se aclara y no hay rechazo, asumí cantidad_despachada)',
    '  "cantidad_rechazada": número entero (0 si no hay rechazo)',
    'NO leas ni extraigas: sucursal, transportista, encargado del proveedor, encargado del súper, fecha de sellado, ni otros datos adicionales.',
    'Respondé SOLO el objeto JSON, sin texto adicional ni markdown.'
  ].join('\n');

  let prompt;
  if (tipo === 'sellado') prompt = promptSellado;
  else if (tipo === 'completo') prompt = promptCompleto;
  else prompt = promptDespacho;
  const escaneo_path = '/data/ifco/' + req.file.filename;

  try {
    const message = await client.messages.create({
      model: OCR_MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: dataB64 } },
          { type: 'text',  text: prompt }
        ]
      }]
    });
    const textoRespuesta = (message.content || [])
      .filter(function(b){ return b.type === 'text'; })
      .map(function(b){ return b.text; })
      .join('\n');
    const datos = _extraerJson(textoRespuesta);
    if (!datos) {
      return res.status(502).json({
        error: 'OCR no devolvió JSON válido',
        respuesta_cruda: textoRespuesta,
        escaneo_path: escaneo_path
      });
    }
    res.json({
      ok: true,
      tipo: tipo,
      datos: datos,
      escaneo_path: escaneo_path,
      tokens: message.usage || null
    });
  } catch(e) {
    console.error('[IFCO][OCR] Error llamando a Claude:', e);
    res.status(502).json({ error: 'Error en OCR: ' + (e.message || 'desconocido'), escaneo_path: escaneo_path });
  }
});

// MATCH-SELLADO: OCR de foto de remito sellado + busca en DB por N° remito
// Devuelve uno de:
//   { ok:true, accion:'sellar',     remito:{...}, escaneo_path, n_remito_ifco }     ← match con remito en estado 'despachado'
//   { ok:true, accion:'crear_nuevo', datos_ocr:{...}, escaneo_path, n_remito_ifco }  ← no hay match, hacer flujo de creación completa
//   { ok:false, accion:'bloqueado', estado:'sellado'|'presentado', remito:{...}, n_remito_ifco }  ← N° ya existe pero no se puede sellar
//   { ok:false, error:'...' }
router.post('/ocr/match-sellado', upload.single('foto'), async function(req, res) {
  if (!OCR_ENABLED) return res.status(503).json({ error: 'OCR no habilitado en el servidor' });
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo "foto"' });
  const client = await _getAnthropic();
  if (!client) return res.status(503).json({ error: 'OCR no disponible (sin SDK o sin API key)' });

  const escaneo_path = '/data/ifco/' + req.file.filename;
  const filePath = path.join(UPLOAD_DIR, req.file.filename);
  let dataB64, mediaType;
  try {
    const buf = fs.readFileSync(filePath);
    dataB64 = buf.toString('base64');
    mediaType = req.file.mimetype || 'image/jpeg';
  } catch(e) {
    return res.status(500).json({ error: 'No se pudo leer el archivo: ' + e.message });
  }

  // Prompt mínimo: solo el N° de remito
  const promptLookup = [
    'Sos un asistente que lee remitos IFCO emitidos por SAN GERONIMO SA en Argentina.',
    'Necesito UN SOLO dato de esta foto: el número de remito IFCO preimpreso.',
    'Devolvé un JSON con un único campo:',
    '  "n_remito_ifco": string con formato "00015-XXXXXXXX" (preimpreso, esquina superior derecha del remito)',
    'Si no podés leer el número con confianza, devolvé null en ese campo.',
    'Respondé SOLO el objeto JSON, sin texto adicional ni markdown.'
  ].join('\n');

  let nRemito = null;
  try {
    const message = await client.messages.create({
      model: OCR_MODEL,
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: dataB64 } },
          { type: 'text',  text: promptLookup }
        ]
      }]
    });
    const texto = (message.content || []).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    const datos = _extraerJson(texto);
    nRemito = (datos && datos.n_remito_ifco) ? String(datos.n_remito_ifco).trim() : null;
  } catch(e) {
    console.error('[IFCO][match-sellado] Error en OCR:', e);
    return res.status(502).json({ error: 'Error en OCR: ' + (e.message || 'desconocido'), escaneo_path: escaneo_path });
  }

  if (!nRemito) {
    return res.json({
      ok: false,
      accion: 'sin_numero',
      error: 'No se pudo leer el N° de remito de la foto',
      escaneo_path: escaneo_path
    });
  }

  // Buscar remito activo por número
  const remito = db.prepare(`
    SELECT r.*, p.nombre AS proveedor_origen_nombre
    FROM ifco_remitos_super r
    LEFT JOIN proveedores p ON r.proveedor_origen_id = p.id
    WHERE r.n_remito_ifco = ? AND r.eliminado_en IS NULL
    LIMIT 1
  `).get(nRemito);

  if (!remito) {
    // No hay match → flujo de creación: pedir OCR completo en una segunda pasada
    // Devolvemos solo el N° leído; el frontend va a llamar al OCR completo a continuación
    return res.json({
      ok: true,
      accion: 'crear_nuevo',
      n_remito_ifco: nRemito,
      escaneo_path: escaneo_path
    });
  }

  // Hay match — depende del estado
  if (remito.estado === 'sellado' || remito.estado === 'enviado' || remito.estado === 'presentado') {
    return res.json({
      ok: false,
      accion: 'bloqueado',
      estado: remito.estado,
      n_remito_ifco: nRemito,
      remito: remito,
      escaneo_path: escaneo_path,
      error: 'El remito ' + nRemito + ' ya está en estado "' + remito.estado + '". No se puede volver a sellar desde este flujo.'
    });
  }

  // Estado 'despachado' → listo para sellar
  return res.json({
    ok: true,
    accion: 'sellar',
    n_remito_ifco: nRemito,
    remito: remito,
    escaneo_path: escaneo_path
  });
});

// ═════════════════════════════════════════════════════════════════════════
// CONSOLIDAR CON ARCHIVO IFCO
// ═════════════════════════════════════════════════════════════════════════

// POST /consolidar/preview — recibe el .xlsx, parsea y matchea contra la DB en 3 categorías
// Devuelve: { despachos, ingresos, r22 }, cada una con { a_marcar, ya_consolidados, no_encontrados }
router.post('/consolidar/preview', upload.single('archivo'), async function(req, res) {
  console.log('[IFCO][consolidar/preview] inicio. file=', req.file && req.file.originalname);
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo "archivo"' });

    const ExcelJS = await _getExcelJS();
    if (!ExcelJS) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)); } catch(_){}
      return res.status(503).json({ error: 'Librería exceljs no disponible en el servidor' });
    }

    const filePath = path.join(UPLOAD_DIR, req.file.filename);
    let parsed;
    try {
      const buf = fs.readFileSync(filePath);
      parsed = await _parsearExcelIFCO(buf);
      console.log('[IFCO][consolidar/preview] parsed: despachos=', parsed.despachos.length, 'ingresos=', parsed.ingresos.length, 'r22=', parsed.r22.length);
    } catch(e) {
      try { fs.unlinkSync(filePath); } catch(_){}
      return res.status(400).json({ error: 'Error parseando el archivo: ' + e.message });
    }
    try { fs.unlinkSync(filePath); } catch(_){}

    // ── DESPACHOS: matchea contra ifco_remitos_super
    const sysDesp = db.prepare(`
      SELECT id, n_remito_ifco, n_remito_sg, fecha_emision, fecha_sellado, fecha_enviado, fecha_presentado,
             empresa, sucursal, cantidad_despachada, cantidad_recibida, cantidad_rechazada,
             estado, origen, proveedor_origen_id
      FROM ifco_remitos_super WHERE eliminado_en IS NULL
    `).all();
    const idxDesp = {};
    sysDesp.forEach(function(r){ const k = _normalizarNumeroRemito(r.n_remito_ifco); if (k) idxDesp[k] = r; });
    const desp = { a_marcar: [], ya_consolidados: [], no_encontrados: [] };
    parsed.despachos.forEach(function(arch) {
      const sis = idxDesp[arch.n_remito_normalizado];
      if (!sis) {
        desp.no_encontrados.push({
          n_remito_archivo: arch.n_remito_archivo, n_remito_sistema: arch.n_remito_sistema,
          fecha: arch.fecha, detalle: arch.detalle, cantidad: arch.cantidad,
          cadena_sugerida: _matchCadenaIFCO(arch.detalle)
        });
      } else if (sis.estado === 'presentado') {
        desp.ya_consolidados.push({ archivo: arch, sistema: sis });
      } else {
        desp.a_marcar.push({ archivo: arch, sistema: sis });
      }
    });

    // ── INGRESOS: matchea contra ifco_movimientos (tipo='retiro') por n_remito_normalizado
    const sysIng = db.prepare(`
      SELECT id, n_remito, fecha, cantidad, sucursal_ifco, modelo, consolidado_en
      FROM ifco_movimientos
      WHERE eliminado_en IS NULL AND tipo = 'retiro'
    `).all();
    const idxIng = {};
    sysIng.forEach(function(r){ const k = _normalizarNumeroRemito(r.n_remito); if (k) idxIng[k] = r; });
    const ing = { a_marcar: [], ya_consolidados: [], no_encontrados: [] };
    parsed.ingresos.forEach(function(arch) {
      const sis = idxIng[arch.n_remito_normalizado];
      if (!sis) {
        ing.no_encontrados.push({
          n_remito_archivo: arch.n_remito_archivo, n_remito_sistema: arch.n_remito_sistema,
          fecha: arch.fecha, detalle: arch.detalle, cantidad: arch.cantidad
        });
      } else if (sis.consolidado_en) {
        ing.ya_consolidados.push({ archivo: arch, sistema: sis });
      } else {
        ing.a_marcar.push({ archivo: arch, sistema: sis });
      }
    });

    // ── R22: matchea contra ifco_recepciones_proveedor (es_r22=1) por n_remito_proveedor
    const sysR22 = db.prepare(`
      SELECT id, n_remito_proveedor, fecha_recepcion, cantidad, proveedor_id, consolidado_en
      FROM ifco_recepciones_proveedor
      WHERE eliminado_en IS NULL AND es_r22 = 1
    `).all();
    const idxR22 = {};
    sysR22.forEach(function(r){ const k = _normalizarNumeroRemito(r.n_remito_proveedor); if (k) idxR22[k] = r; });
    const r22out = { a_marcar: [], ya_consolidados: [], no_encontrados: [] };
    parsed.r22.forEach(function(arch) {
      const sis = idxR22[arch.n_remito_normalizado];
      if (!sis) {
        r22out.no_encontrados.push({
          n_remito_archivo: arch.n_remito_archivo, n_remito_sistema: arch.n_remito_sistema,
          fecha: arch.fecha, detalle: arch.detalle, cantidad: arch.cantidad
        });
      } else if (sis.consolidado_en) {
        r22out.ya_consolidados.push({ archivo: arch, sistema: sis });
      } else {
        r22out.a_marcar.push({ archivo: arch, sistema: sis });
      }
    });

    console.log('[IFCO][consolidar/preview] resultado:',
      'despachos[a/ya/no]=', desp.a_marcar.length, desp.ya_consolidados.length, desp.no_encontrados.length,
      'ingresos[a/ya/no]=', ing.a_marcar.length, ing.ya_consolidados.length, ing.no_encontrados.length,
      'r22[a/ya/no]=', r22out.a_marcar.length, r22out.ya_consolidados.length, r22out.no_encontrados.length);

    res.json({
      ok: true,
      totales: {
        despachos: parsed.despachos.length,
        ingresos:  parsed.ingresos.length,
        r22:       parsed.r22.length
      },
      despachos: desp,
      ingresos:  ing,
      r22:       r22out
    });
  } catch(e) {
    console.error('[IFCO][consolidar/preview] EXCEPCION:', e);
    if (req.file) try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)); } catch(_){}
    res.status(500).json({ error: 'Error interno: ' + e.message });
  }
});

// POST /consolidar/aplicar — aplica los cambios del wizard (3 categorías)
// ════════════════════════════════════════════════════════════════════════════
// CONSOLIDACIÓN — SALDO Y DIFERENCIA (multa estimada de IFCO)
// ────────────────────────────────────────────────────────────────────────────
// Modelo:
//   SALDO_IFCO   = lo que IFCO te informa (input manual del reporte de IFCO)
//   SUMA_REAL    = piso_SG_real + pisos_proveedores_real + en_no_presentados
//   DIFERENCIA   = SALDO_IFCO − SUMA_REAL  (si > 0 → multa)
//
// "en_no_presentados" = cajones que ya despachaste a una cadena pero todavía
// no presentaste a IFCO. Estados 'despachado' (en tránsito) y 'sellado'
// (en la cadena pero no presentado). Para los sellados se usa cantidad_recibida
// (no cantidad_despachada) para no contar dos veces los rechazos que volvieron
// a algún piso real.
// ════════════════════════════════════════════════════════════════════════════

// GET /consolidacion/saldos-reales — calcula la suma de pisos reales + componentes
router.get('/consolidacion/saldos-reales', function(req, res) {
  try {
    // Último conteo físico de SG
    const sgRow = db.prepare(`
      SELECT cantidad, fecha, notas
      FROM ifco_stocks_reales
      WHERE deposito_tipo = 'san_geronimo'
      ORDER BY fecha DESC, id DESC LIMIT 1
    `).get();
    const piso_sg_real = sgRow ? sgRow.cantidad : 0;
    const piso_sg_fecha = sgRow ? sgRow.fecha : null;

    // Último conteo físico por proveedor (todos los proveedores activos)
    const provs = db.prepare(`
      SELECT p.id, p.nombre,
        (SELECT cantidad FROM ifco_stocks_reales s WHERE s.proveedor_id = p.id ORDER BY s.fecha DESC, s.id DESC LIMIT 1) AS ultimo_conteo,
        (SELECT fecha FROM ifco_stocks_reales s WHERE s.proveedor_id = p.id ORDER BY s.fecha DESC, s.id DESC LIMIT 1) AS fecha_conteo
      FROM proveedores p
      WHERE p.id IN (SELECT proveedor_id FROM ifco_envios_proveedor WHERE eliminado_en IS NULL)
         OR p.id IN (SELECT proveedor_origen_id FROM ifco_remitos_super WHERE eliminado_en IS NULL AND origen='proveedor_directo')
      ORDER BY p.nombre
    `).all();
    const pisos_proveedores_real = provs.reduce(function(a, p){ return a + (p.ultimo_conteo || 0); }, 0);

    // Cajones en estado 'despachado' (en tránsito) o 'sellado' (no presentado todavía)
    // Para 'despachado' contamos cantidad_despachada (todavía no se sabe si la cadena rechazó)
    // Para 'sellado' contamos cantidad_recibida (los rechazos ya volvieron a algún piso real)
    const noPres = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN estado='despachado' THEN cantidad_despachada ELSE 0 END), 0) AS en_transito,
        COALESCE(SUM(CASE WHEN estado='sellado' THEN cantidad_recibida ELSE 0 END), 0) AS sellado_sin_presentar
      FROM ifco_remitos_super
      WHERE eliminado_en IS NULL AND estado IN ('despachado', 'sellado')
    `).get();
    const en_no_presentados = (noPres.en_transito || 0) + (noPres.sellado_sin_presentar || 0);

    const suma_real = piso_sg_real + pisos_proveedores_real + en_no_presentados;

    // Componentes informativos (para que el user pueda chequear el saldo IFCO ingresado)
    const get = function(q) { try { return db.prepare(q).get().total || 0; } catch(_) { return 0; } };
    const retiros_total   = get("SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_movimientos WHERE tipo='retiro' AND eliminado_en IS NULL AND pendiente=0");
    const perdidas_total  = get("SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_movimientos WHERE tipo='perdida' AND eliminado_en IS NULL AND pendiente=0");
    const despachos_total = get("SELECT COALESCE(SUM(cantidad_despachada),0) AS total FROM ifco_remitos_super WHERE eliminado_en IS NULL");
    const despachos_presentados_total = get("SELECT COALESCE(SUM(cantidad_despachada),0) AS total FROM ifco_remitos_super WHERE eliminado_en IS NULL AND estado='presentado'");

    res.json({
      piso_sg_real: piso_sg_real,
      piso_sg_fecha: piso_sg_fecha,
      pisos_proveedores: provs.map(function(p){
        return { id: p.id, nombre: p.nombre, ultimo_conteo: p.ultimo_conteo, fecha_conteo: p.fecha_conteo };
      }),
      pisos_proveedores_total: pisos_proveedores_real,
      en_no_presentados: en_no_presentados,
      en_no_presentados_detalle: {
        en_transito: noPres.en_transito || 0,
        sellado_sin_presentar: noPres.sellado_sin_presentar || 0
      },
      suma_real: suma_real,
      componentes: {
        retiros_total: retiros_total,
        despachos_total: despachos_total,
        despachos_presentados_total: despachos_presentados_total,
        perdidas_total: perdidas_total,
        // saldo teórico nuestro: lo que IFCO debería decirnos según retiros - despachos presentados - perdidas
        saldo_teorico_nuestro: retiros_total - despachos_presentados_total - perdidas_total
      }
    });
  } catch(e) {
    console.error('[IFCO][consolidacion/saldos-reales]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /consolidacion — guarda una consolidación con el saldo IFCO ingresado
router.post('/consolidacion', express.json(), function(req, res) {
  const saldo_ifco = parseInt(req.body && req.body.saldo_ifco);
  if (isNaN(saldo_ifco)) return res.status(400).json({ error: 'saldo_ifco requerido (entero)' });
  const notas = req.body && req.body.notas ? String(req.body.notas).trim() : null;
  const fecha = (req.body && req.body.fecha) || new Date().toISOString().slice(0,10);

  try {
    // Recalcular los componentes en el momento de guardar (snapshot)
    const sgRow = db.prepare("SELECT cantidad FROM ifco_stocks_reales WHERE deposito_tipo='san_geronimo' ORDER BY fecha DESC, id DESC LIMIT 1").get();
    const piso_sg_real = sgRow ? sgRow.cantidad : 0;

    const pisos_proveedores_real = db.prepare(`
      SELECT COALESCE(SUM(s.cantidad), 0) AS total FROM (
        SELECT proveedor_id, MAX(fecha || '-' || id) AS k
        FROM ifco_stocks_reales WHERE deposito_tipo='proveedor' GROUP BY proveedor_id
      ) ult
      JOIN ifco_stocks_reales s ON (s.fecha || '-' || s.id) = ult.k
    `).get().total || 0;

    const noPres = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN estado='despachado' THEN cantidad_despachada ELSE 0 END), 0)
        + COALESCE(SUM(CASE WHEN estado='sellado' THEN cantidad_recibida ELSE 0 END), 0) AS total
      FROM ifco_remitos_super
      WHERE eliminado_en IS NULL AND estado IN ('despachado', 'sellado')
    `).get();
    const en_no_presentados = noPres.total || 0;

    const suma_real = piso_sg_real + pisos_proveedores_real + en_no_presentados;
    const diferencia = saldo_ifco - suma_real;

    const r = db.prepare(`
      INSERT INTO ifco_consolidaciones
        (fecha, saldo_ifco, piso_sg_real, pisos_proveedores_real, en_no_presentados, suma_real, diferencia, notas, usuario_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fecha, saldo_ifco, piso_sg_real, pisos_proveedores_real, en_no_presentados, suma_real, diferencia, notas, (req.user && req.user.id) || null);

    res.json({ id: r.lastInsertRowid, fecha: fecha, saldo_ifco: saldo_ifco, suma_real: suma_real, diferencia: diferencia });
  } catch(e) {
    console.error('[IFCO][consolidacion POST]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /consolidacion/historico — lista las consolidaciones pasadas (más recientes primero)
router.get('/consolidacion/historico', function(req, res) {
  try {
    const rows = db.prepare(`
      SELECT c.*, u.nombre AS usuario_username
      FROM ifco_consolidaciones c
      LEFT JOIN usuarios u ON u.id = c.usuario_id
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 50
    `).all();
    res.json(rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /consolidacion/:id — borrar una consolidación (admin only, en caso de error)
router.delete('/consolidacion/:id', function(req, res) {
  if (!req.user || req.user.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo admin puede borrar consolidaciones' });
  }
  try {
    const r = db.prepare("DELETE FROM ifco_consolidaciones WHERE id = ?").run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CONSOLIDACIÓN — items para revisar después
// (registros del archivo IFCO que no están en el sistema y no se procesan ahora)
// ════════════════════════════════════════════════════════════════════════════

// POST /consolidacion-revisar — marcar varios registros para revisar después
// Body: { items: [{ n_remito, cantidad, detalle, tipo_origen, fecha_archivo }] }
router.post('/consolidacion-revisar', express.json(), function(req, res) {
  try {
    const items = (req.body && req.body.items) || [];
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items requeridos' });
    const userId = (req.user && req.user.id) || null;
    const stmt = db.prepare(`
      INSERT INTO ifco_consolidacion_revisar (n_remito, cantidad, detalle, tipo_origen, fecha_archivo, marcado_por_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let creados = 0;
    const tx = db.transaction(function(){
      items.forEach(function(it){
        try {
          stmt.run(
            it.n_remito || null,
            parseInt(it.cantidad) || 0,
            it.detalle || null,
            it.tipo_origen || 'despacho',
            it.fecha_archivo || null,
            userId
          );
          creados++;
        } catch(e) { console.error('[IFCO][consolidacion-revisar]', e.message); }
      });
    });
    tx();
    res.json({ ok: true, creados: creados });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /consolidacion-revisar — listar pendientes
router.get('/consolidacion-revisar', function(req, res) {
  try {
    const incluir_resueltos = req.query.incluir_resueltos === 'true';
    let q = `
      SELECT r.*, u.nombre AS marcado_por_username, ur.nombre AS resuelto_por_username
      FROM ifco_consolidacion_revisar r
      LEFT JOIN usuarios u ON u.id = r.marcado_por_id
      LEFT JOIN usuarios ur ON ur.id = r.resuelto_por_id
    `;
    if (!incluir_resueltos) q += " WHERE r.resuelto_en IS NULL";
    q += " ORDER BY r.marcado_en DESC LIMIT 200";
    res.json(db.prepare(q).all());
  } catch(e) {
    console.error('[IFCO][consolidacion-revisar GET]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /consolidacion-revisar/:id/resolver — marcarlo como resuelto
router.post('/consolidacion-revisar/:id/resolver', express.json(), function(req, res) {
  try {
    const r = db.prepare("SELECT * FROM ifco_consolidacion_revisar WHERE id = ?").get(req.params.id);
    if (!r) return res.status(404).json({ error: 'No encontrado' });
    db.prepare(`
      UPDATE ifco_consolidacion_revisar
      SET resuelto_en = datetime('now','localtime'),
          resuelto_por_id = ?,
          resolucion = ?
      WHERE id = ?
    `).run((req.user && req.user.id) || null, (req.body && req.body.resolucion) || null, r.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /consolidacion-revisar/:id — eliminar (admin only)
router.delete('/consolidacion-revisar/:id', function(req, res) {
  if (!req.user || req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  try {
    const r = db.prepare("DELETE FROM ifco_consolidacion_revisar WHERE id = ?").run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /consolidacion-revisar/bulk-resolver — marcar varios como resueltos
// Body: { ids: [int], resolucion?: string }
router.post('/consolidacion-revisar/bulk-resolver', express.json(), function(req, res) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(function(x){ return Number.isInteger(x); }) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'ids requerido (array de enteros)' });
  const resolucion = (req.body?.resolucion || '').toString().slice(0, 500) || null;
  const userId = (req.user && req.user.id) || null;
  try {
    const stmt = db.prepare("UPDATE ifco_consolidacion_revisar SET resuelto_en = datetime('now','localtime'), resuelto_por = ?, resolucion = ? WHERE id = ? AND resuelto_en IS NULL");
    const tx = db.transaction(function(ids) {
      let n = 0;
      for (const id of ids) { const r = stmt.run(userId, resolucion, id); n += r.changes; }
      return n;
    });
    const actualizados = tx(ids);
    console.log('[IFCO][bulk-resolver]', actualizados, 'de', ids.length, 'por usuario_id', userId);
    res.json({ ok: true, actualizados: actualizados, total_pedidos: ids.length });
  } catch(e) { console.error('[IFCO][bulk-resolver]', e); res.status(500).json({ error: e.message }); }
});

// POST /consolidacion-revisar/bulk-borrar — eliminar varios (admin only)
// Body: { ids: [int] }
router.post('/consolidacion-revisar/bulk-borrar', express.json(), function(req, res) {
  if (!req.user || req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(function(x){ return Number.isInteger(x); }) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'ids requerido (array de enteros)' });
  try {
    const stmt = db.prepare("DELETE FROM ifco_consolidacion_revisar WHERE id = ?");
    const tx = db.transaction(function(ids) {
      let n = 0;
      for (const id of ids) { const r = stmt.run(id); n += r.changes; }
      return n;
    });
    const borrados = tx(ids);
    console.log('[IFCO][bulk-borrar]', borrados, 'de', ids.length, 'por usuario_id', req.user.id);
    res.json({ ok: true, borrados: borrados, total_pedidos: ids.length });
  } catch(e) { console.error('[IFCO][bulk-borrar]', e); res.status(500).json({ error: e.message }); }
});

// Body JSON: {
//   despachos: { ids_marcar: [int], fechas_por_id: {id:'YYYY-MM-DD'}, crear: [{n_remito_sistema, fecha, empresa, cantidad}] },
//   ingresos:  { ids_marcar: [int], crear: [{n_remito_sistema, fecha, cantidad, sucursal_ifco, modelo}] },
//   r22:       { ids_marcar: [int], crear: [{n_remito_sistema, fecha, cantidad, proveedor_id?}] }
// }
router.post('/consolidar/aplicar', express.json(), function(req, res) {
  console.log('[IFCO][consolidar/aplicar] inicio');
  const b = req.body || {};
  const desp = b.despachos || {};
  const ing  = b.ingresos  || {};
  const r22  = b.r22       || {};
  const fechasPorId = desp.fechas_por_id || {};

  const result = {
    despachos: { actualizados: 0, creados: 0, errores: [] },
    ingresos:  { actualizados: 0, creados: 0, errores: [] },
    r22:       { actualizados: 0, creados: 0, errores: [] }
  };
  const userId = (req.user && req.user.id) || null;
  const ahora = "datetime('now','localtime')";

  try {
    const tx = db.transaction(function() {
      // ───── DESPACHOS ─────
      for (const id of (desp.ids_marcar || [])) {
        try {
          const r = db.prepare("SELECT * FROM ifco_remitos_super WHERE id = ? AND eliminado_en IS NULL").get(id);
          if (!r) { result.despachos.errores.push({ id, error: 'No encontrado' }); continue; }
          if (r.estado === 'presentado') continue;
          const fechaArchivo = fechasPorId[id] || r.fecha_emision;
          if (r.estado === 'despachado') {
            db.prepare(`UPDATE ifco_remitos_super
              SET estado='presentado',
                  cantidad_recibida=COALESCE(cantidad_recibida,cantidad_despachada),
                  cantidad_rechazada=COALESCE(cantidad_rechazada,0),
                  fecha_sellado=COALESCE(fecha_sellado,?),
                  fecha_presentado=?,
                  actualizado_en=datetime('now','localtime')
              WHERE id=?`).run(fechaArchivo, fechaArchivo, id);
          } else {
            db.prepare(`UPDATE ifco_remitos_super
              SET estado='presentado',fecha_presentado=?,actualizado_en=datetime('now','localtime')
              WHERE id=?`).run(fechaArchivo, id);
          }
          result.despachos.actualizados++;
        } catch(e) { result.despachos.errores.push({ id, error: e.message }); }
      }
      for (let i = 0; i < (desp.crear || []).length; i++) {
        const n = desp.crear[i];
        try {
          if (!n.n_remito_sistema || !n.cantidad) { result.despachos.errores.push({ idx: i, error: 'Faltan datos' }); continue; }
          const ex = db.prepare("SELECT id FROM ifco_remitos_super WHERE n_remito_ifco=? AND eliminado_en IS NULL").get(n.n_remito_sistema);
          if (ex) { result.despachos.errores.push({ n_remito: n.n_remito_sistema, error: 'Ya existe' }); continue; }
          db.prepare(`INSERT INTO ifco_remitos_super (
            n_remito_ifco, fecha_emision, empresa,
            cantidad_despachada, cantidad_recibida, cantidad_rechazada,
            estado, fecha_sellado, fecha_presentado,
            origen, usuario_id, notas
          ) VALUES (?,?,?,?,?,0,'presentado',?,?, 'san_geronimo', ?, 'Importado del archivo IFCO')`)
            .run(n.n_remito_sistema, n.fecha||null, n.empresa||null,
                 parseInt(n.cantidad)||0, parseInt(n.cantidad)||0,
                 n.fecha||null, n.fecha||null, userId);
          result.despachos.creados++;
        } catch(e) { result.despachos.errores.push({ n_remito: n.n_remito_sistema, error: e.message }); }
      }

      // ───── INGRESOS (retiros) ─────
      for (const id of (ing.ids_marcar || [])) {
        try {
          const r = db.prepare("SELECT * FROM ifco_movimientos WHERE id=? AND eliminado_en IS NULL AND tipo='retiro'").get(id);
          if (!r) { result.ingresos.errores.push({ id, error: 'No encontrado' }); continue; }
          if (r.consolidado_en) continue;
          db.prepare("UPDATE ifco_movimientos SET consolidado_en=datetime('now','localtime') WHERE id=?").run(id);
          result.ingresos.actualizados++;
        } catch(e) { result.ingresos.errores.push({ id, error: e.message }); }
      }
      for (let i = 0; i < (ing.crear || []).length; i++) {
        const n = ing.crear[i];
        try {
          if (!n.n_remito_sistema || !n.cantidad || !n.sucursal_ifco) {
            result.ingresos.errores.push({ idx: i, error: 'Faltan datos (n_remito/cantidad/sucursal)' }); continue;
          }
          const ex = db.prepare("SELECT id FROM ifco_movimientos WHERE n_remito=? AND tipo='retiro' AND eliminado_en IS NULL").get(n.n_remito_sistema);
          if (ex) { result.ingresos.errores.push({ n_remito: n.n_remito_sistema, error: 'Ya existe' }); continue; }
          db.prepare(`INSERT INTO ifco_movimientos
            (tipo, fecha, cantidad, sucursal_ifco, n_remito, modelo, notas, usuario_id, consolidado_en)
            VALUES ('retiro', ?, ?, ?, ?, ?, 'Importado del archivo IFCO', ?, datetime('now','localtime'))`)
            .run(n.fecha||null, parseInt(n.cantidad)||0, n.sucursal_ifco,
                 n.n_remito_sistema, n.modelo || null, userId);
          result.ingresos.creados++;
        } catch(e) { result.ingresos.errores.push({ n_remito: n.n_remito_sistema, error: e.message }); }
      }

      // ───── R22 ─────
      for (const id of (r22.ids_marcar || [])) {
        try {
          const r = db.prepare("SELECT * FROM ifco_recepciones_proveedor WHERE id=? AND eliminado_en IS NULL AND es_r22=1").get(id);
          if (!r) { result.r22.errores.push({ id, error: 'No encontrado' }); continue; }
          if (r.consolidado_en) continue;
          db.prepare("UPDATE ifco_recepciones_proveedor SET consolidado_en=datetime('now','localtime') WHERE id=?").run(id);
          result.r22.actualizados++;
        } catch(e) { result.r22.errores.push({ id, error: e.message }); }
      }
      for (let i = 0; i < (r22.crear || []).length; i++) {
        const n = r22.crear[i];
        try {
          if (!n.n_remito_sistema || !n.cantidad) {
            result.r22.errores.push({ idx: i, error: 'Faltan datos (n_remito/cantidad)' }); continue;
          }
          const ex = db.prepare("SELECT id FROM ifco_recepciones_proveedor WHERE n_remito_proveedor=? AND es_r22=1 AND eliminado_en IS NULL").get(n.n_remito_sistema);
          if (ex) { result.r22.errores.push({ n_remito: n.n_remito_sistema, error: 'Ya existe' }); continue; }
          db.prepare(`INSERT INTO ifco_recepciones_proveedor
            (fecha_recepcion, proveedor_id, cantidad, n_remito_proveedor, notas, usuario_id, es_r22, estado, confirmado_en, confirmado_por_id, consolidado_en)
            VALUES (?, ?, ?, ?, 'Importado del archivo IFCO', ?, 1, 'recibido', datetime('now','localtime'), ?, datetime('now','localtime'))`)
            .run(n.fecha || null, n.proveedor_id || null, parseInt(n.cantidad) || 0,
                 n.n_remito_sistema, userId, userId);
          result.r22.creados++;
        } catch(e) { result.r22.errores.push({ n_remito: n.n_remito_sistema, error: e.message }); }
      }
    });
    tx();
    console.log('[IFCO][consolidar/aplicar] OK', JSON.stringify(result));
    res.json({ ok: true, resultado: result });
  } catch(e) {
    console.error('[IFCO][consolidar/aplicar] EXCEPCION:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// ADMIN — Importar retiros históricos (one-shot)
// ═════════════════════════════════════════════════════════════════════════
// Recibe un .xlsx con columnas: Fecha Doc | Nº Remito | NOTAS | SUCURSAL | INGRESOS
// Idempotente: si ya existe un retiro con el mismo n_remito, lo saltea.
// Solo admin.
router.post('/admin/importar-retiros-historicos', upload.single('archivo'), async function(req, res) {
  console.log('[IFCO][import-retiros] inicio');
  try {
    if (!req.user || req.user.rol !== 'admin') {
      return res.status(403).json({ error: 'Solo administradores' });
    }
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });

    const ExcelJS = await _getExcelJS();
    if (!ExcelJS) return res.status(503).json({ error: 'exceljs no disponible' });

    const filePath = path.join(UPLOAD_DIR, req.file.filename);
    const buf = fs.readFileSync(filePath);
    try { fs.unlinkSync(filePath); } catch(_){}

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: 'El archivo no tiene hojas' });

    // Helper para extraer valor crudo de celda
    function cellVal(cell) {
      if (!cell) return null;
      let v = cell.value;
      if (v == null) return null;
      if (typeof v === 'object' && v.result !== undefined) v = v.result;
      if (typeof v === 'object' && v.text !== undefined) v = v.text;
      return v;
    }
    // Mapear sucursal mayúsculas → forma canónica
    function mapSucursal(s) {
      if (!s) return null;
      const u = String(s).trim().toUpperCase();
      if (u === 'BUENOS AIRES') return 'Buenos Aires';
      if (u === 'MENDOZA')      return 'Mendoza';
      return null;
    }
    // Extraer modelo del campo NOTAS ("Retiro Mod 6420" → "6420")
    function parseModelo(s) {
      if (!s) return '6420';
      const m = String(s).match(/mod\s*(\d+)/i);
      return m ? m[1] : '6420';
    }
    // Fecha → ISO
    function parseFecha(v) {
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (v == null) return null;
      const s = String(v);
      const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      if (m) {
        const yyyy = m[3].length === 2 ? '20' + m[3] : m[3];
        return yyyy + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
      }
      // Si ya es ISO YYYY-MM-DD
      const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return iso[0];
      return null;
    }

    // Detectar fila de header y arrancar después
    let firstRow = 1;
    const headerCell = cellVal(ws.getRow(1).getCell(1));
    if (headerCell && String(headerCell).toLowerCase().includes('fecha')) firstRow = 2;

    const insertados = [];
    const saltados = [];
    const errores = [];

    const stmt = db.prepare(`
      INSERT INTO ifco_movimientos (
        fecha, tipo, cantidad, modelo, n_remito,
        costo_total, moneda, notas, usuario_id, sucursal_ifco
      ) VALUES (?, 'retiro', ?, ?, ?, 0, 'ARS', ?, ?, ?)
    `);
    const checkStmt = db.prepare("SELECT id FROM ifco_movimientos WHERE tipo='retiro' AND n_remito = ? AND eliminado_en IS NULL LIMIT 1");

    const tx = db.transaction(function() {
      for (let i = firstRow; i <= ws.rowCount; i++) {
        const row = ws.getRow(i);
        const fechaRaw = cellVal(row.getCell(1));
        const nRemito  = cellVal(row.getCell(2));
        const notasRaw = cellVal(row.getCell(3));
        const sucRaw   = cellVal(row.getCell(4));
        const cantRaw  = cellVal(row.getCell(5));

        // Saltear filas vacías
        if (!fechaRaw && !nRemito && !cantRaw) continue;

        const fecha    = parseFecha(fechaRaw);
        const cantidad = parseInt(cantRaw) || 0;
        const sucursal = mapSucursal(sucRaw);
        const modelo   = parseModelo(notasRaw);
        const nRem     = nRemito ? String(nRemito).trim() : null;

        if (!fecha)             { errores.push({ fila: i, error: 'Fecha inválida: '+fechaRaw }); continue; }
        if (cantidad <= 0)      { errores.push({ fila: i, error: 'Cantidad inválida: '+cantRaw }); continue; }
        if (!sucursal)          { errores.push({ fila: i, error: 'Sucursal inválida: '+sucRaw }); continue; }

        // Idempotencia: si ya hay un retiro con ese N° remito, saltar
        if (nRem) {
          const yaExiste = checkStmt.get(nRem);
          if (yaExiste) { saltados.push({ fila: i, n_remito: nRem, motivo: 'Ya existe (id '+yaExiste.id+')' }); continue; }
        }

        try {
          const r = stmt.run(
            fecha, cantidad, modelo, nRem,
            notasRaw ? String(notasRaw) : null,
            req.user.id || null,
            sucursal
          );
          insertados.push({ fila: i, id: r.lastInsertRowid, n_remito: nRem, fecha: fecha, cantidad: cantidad, sucursal: sucursal });
        } catch(e) {
          errores.push({ fila: i, n_remito: nRem, error: e.message });
        }
      }
    });
    tx();

    console.log('[IFCO][import-retiros] OK insertados=', insertados.length, 'saltados=', saltados.length, 'errores=', errores.length);
    res.json({
      ok: true,
      total_filas: ws.rowCount - firstRow + 1,
      insertados:  insertados.length,
      saltados:    saltados.length,
      errores:     errores.length,
      detalle:     { insertados, saltados, errores }
    });
  } catch(e) {
    console.error('[IFCO][import-retiros] EXCEPCION:', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// STOCKS REALES (conteo físico) — informativo
// ════════════════════════════════════════════════════════════════════════════

// Helper: último jueves 10am (inclusive si hoy es jueves >=10am).
// Devuelve un Date.
function _ultimoJueves10am() {
  const ahora = new Date();
  const d = new Date(ahora);
  // Día de la semana: 0=domingo,1=lun,...,4=jueves
  let diff = (d.getDay() - 4 + 7) % 7; // días desde el último jueves
  // Si hoy es jueves PERO antes de las 10:00, retroceder 7 días al jueves anterior
  if (diff === 0 && ahora.getHours() < 10) diff = 7;
  d.setDate(d.getDate() - diff);
  d.setHours(10, 0, 0, 0);
  return d;
}

// Faltante de stock declarado manualmente para SG (suma de todos los ajustes vigentes).
function _faltantesSGTotal() {
  try {
    const r = db.prepare("SELECT COALESCE(SUM(delta),0) AS total FROM ifco_faltantes_sg WHERE eliminado_en IS NULL").get();
    return r ? (r.total || 0) : 0;
  } catch(e) {
    console.error('[IFCO][_faltantesSGTotal]:', e.message);
    return 0;
  }
}

// Calcula stock teórico para un depósito.
// Cada query está envuelta para que si falla (columna inexistente, tabla rara, etc.)
// loguee qué query rompió y devuelva 0 en lugar de tirar el endpoint entero.
function _stockTeoricoDeposito(deposito_tipo, proveedor_id) {
  if (deposito_tipo === 'san_geronimo') {
    return _calcStockSG();
  }
  if (deposito_tipo === 'proveedor' && proveedor_id) {
    try {
      return _calcSaldoProveedor(proveedor_id);
    } catch(e) {
      console.error('[IFCO][_stockTeoricoDeposito] Falló _calcSaldoProveedor para', proveedor_id, ':', e.message);
      return 0;
    }
  }
  return 0;
}

// ════════════════════════════════════════════════════════════════════════════
// CÁLCULO UNIFICADO DEL STOCK SG (piso)
// ────────────────────────────────────────────────────────────────────────────
// Fuente única de verdad. Se usa tanto en el KPI "PISO ACTUAL" del /resumen
// como en el "TEÓRICO" del card de Conteo físico, garantizando consistencia.
//
// Componentes (todos los registros excluyen los eliminados):
//   + retiros desde IFCO  (ifco_movimientos tipo='retiro')
//   - pérdidas declaradas (ifco_movimientos tipo='perdida')
//   - despachos a súper, SOLO origen='san_geronimo' (los directos de proveedor
//     no salieron del piso de SG)
//   - envíos a proveedor (cantidad_enviada, estados activos)
//   + cantidad recibida en envíos a proveedor (cajones que volvieron al galpón)
//   + recepciones de mercadería confirmadas (cajones con producto que llegan)
//   + rechazos vueltos al SG (cajones rechazados por la cadena que volvieron)
//   - faltantes SG declarados manualmente
// ════════════════════════════════════════════════════════════════════════════
function _calcStockSG() {
  const get = function(label, q) {
    try {
      const r = db.prepare(q).get();
      return r ? (r.total || 0) : 0;
    } catch(e) {
      console.error('[IFCO][_calcStockSG] Falló query "' + label + '":', e.message);
      return 0;
    }
  };
  const retirado            = get('retiros',            "SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_movimientos WHERE tipo='retiro' AND eliminado_en IS NULL AND pendiente=0");
  const perdidas            = get('perdidas',           "SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_movimientos WHERE tipo='perdida' AND eliminado_en IS NULL AND pendiente=0");
  const despachos_sg        = get('despachos_sg',       "SELECT COALESCE(SUM(cantidad_despachada),0) AS total FROM ifco_remitos_super WHERE estado IN ('despachado','sellado','enviado','presentado') AND origen='san_geronimo' AND eliminado_en IS NULL");
  const envios_totales      = get('envios_totales',     "SELECT COALESCE(SUM(cantidad_enviada),0) AS total FROM ifco_envios_proveedor WHERE estado IN ('enviado','parcial','recibido') AND eliminado_en IS NULL AND origen_proveedor_id IS NULL");
  const recepciones_envios  = get('recepciones_envios', "SELECT COALESCE(SUM(cantidad_recibida),0) AS total FROM ifco_envios_proveedor WHERE estado IN ('recibido','parcial') AND eliminado_en IS NULL AND origen_proveedor_id IS NULL");
  const recepciones_merc    = get('recepciones_merc',   "SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_recepciones_proveedor WHERE eliminado_en IS NULL AND (estado IS NULL OR estado='recibido')");
  const rechazos_vueltos_sg = get('rechazos_sg',        "SELECT COALESCE(SUM(cantidad_rechazada),0) AS total FROM ifco_remitos_super WHERE estado IN ('sellado','enviado','presentado') AND rechazo_destino='san_geronimo' AND eliminado_en IS NULL");

  // NOTA: los faltantes manuales (+ Faltante) ya NO se restan del piso.
  // Antes eran necesarios para "ajustar" el teórico, pero ahora con la consolidación
  // semanal contra IFCO, las diferencias reales surgen de ahí (que es la fuente oficial).
  // Los faltantes manuales históricos siguen en la base pero no afectan el cálculo.

  return retirado
       - perdidas
       - despachos_sg
       - envios_totales
       + recepciones_envios
       + recepciones_merc
       + rechazos_vueltos_sg;
}

// GET /diagnostico-stock-sg — desglose detallado del cálculo del piso SG
// para diagnosticar diferencias o stocks negativos
router.get('/diagnostico-stock-sg', function(req, res) {
  try {
    const get = function(q) {
      try { const r = db.prepare(q).get(); return r ? (r.total || 0) : 0; } catch(e) { return 0; }
    };
    const componentes = [
      { signo: '+', label: 'Retiros confirmados',       valor: get("SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_movimientos WHERE tipo='retiro' AND eliminado_en IS NULL AND pendiente=0"),
        ayuda: 'Cajones que IFCO entregó (autorizaciones completadas). Solo cuenta los pendiente=0.' },
      { signo: '-', label: 'Pérdidas',                  valor: get("SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_movimientos WHERE tipo='perdida' AND eliminado_en IS NULL AND pendiente=0"),
        ayuda: 'Cajones rotos, perdidos, devueltos a IFCO.' },
      { signo: '-', label: 'Despachos a cadenas desde SG', valor: get("SELECT COALESCE(SUM(cantidad_despachada),0) AS total FROM ifco_remitos_super WHERE estado IN ('despachado','sellado','enviado','presentado') AND origen='san_geronimo' AND eliminado_en IS NULL"),
        ayuda: 'Cajones que salieron de SG con destino cadena (despachados o sellados o presentados).' },
      { signo: '-', label: 'Envíos a galpones de proveedores', valor: get("SELECT COALESCE(SUM(cantidad_enviada),0) AS total FROM ifco_envios_proveedor WHERE estado IN ('enviado','parcial','recibido') AND eliminado_en IS NULL AND origen_proveedor_id IS NULL"),
        ayuda: 'Cajones que SG envió a un galpón de proveedor (no incluye traspasos entre galpones).' },
      { signo: '+', label: 'Recepciones de envíos (vueltos)', valor: get("SELECT COALESCE(SUM(cantidad_recibida),0) AS total FROM ifco_envios_proveedor WHERE estado IN ('recibido','parcial') AND eliminado_en IS NULL AND origen_proveedor_id IS NULL"),
        ayuda: 'Envíos a proveedor que volvieron (ej. cajones llenos con producto que retornan).' },
      { signo: '+', label: 'Recepciones de mercadería',  valor: get("SELECT COALESCE(SUM(cantidad),0) AS total FROM ifco_recepciones_proveedor WHERE eliminado_en IS NULL AND (estado IS NULL OR estado='recibido')"),
        ayuda: 'Cajones con mercadería que el proveedor envió a SG.' },
      { signo: '+', label: 'Rechazos vueltos a SG',     valor: get("SELECT COALESCE(SUM(cantidad_rechazada),0) AS total FROM ifco_remitos_super WHERE estado IN ('sellado','enviado','presentado') AND rechazo_destino='san_geronimo' AND eliminado_en IS NULL"),
        ayuda: 'Cajones que la cadena rechazó y volvieron a SG (no a proveedor).' }
    ];
    let total = 0;
    componentes.forEach(function(c){ total += (c.signo === '+' ? c.valor : -c.valor); });
    res.json({ total: total, componentes: componentes });
  } catch(e) {
    console.error('[IFCO][diagnostico-stock-sg]', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// FALTANTES DE STOCK SG (declaraciones manuales para corregir el teórico)
// Cada fila es un ajuste con delta. delta>0 declara que falta stock; delta<0
// reduce el faltante (cajones encontrados o resolución parcial).
// ════════════════════════════════════════════════════════════════════════════

// GET /faltantes-sg — historial completo + total vigente
router.get('/faltantes-sg', function(req, res) {
  try {
    const items = db.prepare(`
      SELECT f.id, f.fecha, f.delta, f.motivo, f.usuario_id, f.creado_en,
             u.nombre AS usuario_nombre
      FROM ifco_faltantes_sg f
      LEFT JOIN usuarios u ON u.id = f.usuario_id
      WHERE f.eliminado_en IS NULL
      ORDER BY f.fecha DESC, f.id DESC
    `).all();
    const total = items.reduce(function(a, r){ return a + (r.delta || 0); }, 0);
    res.json({ total: total, items: items });
  } catch(e) {
    console.error('[IFCO][faltantes-sg GET]:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /faltantes-sg — agrega un ajuste (delta puede ser positivo o negativo)
router.post('/faltantes-sg', express.json(), function(req, res) {
  try {
    const d = req.body || {};
    const delta = parseInt(d.delta);
    if (isNaN(delta) || delta === 0) return res.status(400).json({ error: 'delta debe ser un número distinto de cero' });
    const fecha = d.fecha || new Date().toISOString().slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'fecha inválida (YYYY-MM-DD)' });
    const motivo = d.motivo ? String(d.motivo).trim().slice(0, 500) : null;
    const r = db.prepare(`
      INSERT INTO ifco_faltantes_sg (fecha, delta, motivo, usuario_id)
      VALUES (?, ?, ?, ?)
    `).run(fecha, delta, motivo, (req.user && req.user.id) || null);
    res.json({ id: r.lastInsertRowid });
  } catch(e) {
    console.error('[IFCO][faltantes-sg POST]:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /faltantes-sg/:id — soft delete
router.delete('/faltantes-sg/:id', function(req, res) {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const r = db.prepare(`
      UPDATE ifco_faltantes_sg
         SET eliminado_en = datetime('now','localtime'),
             eliminado_por_id = ?
       WHERE id = ? AND eliminado_en IS NULL
    `).run((req.user && req.user.id) || null, id);
    res.json({ ok: true, changes: r.changes });
  } catch(e) {
    console.error('[IFCO][faltantes-sg DELETE]:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /stocks-reales — lista resumen de cada depósito con su último conteo + diferencia + alerta
router.get('/stocks-reales', function(req, res) {
  const corte = _ultimoJueves10am().toISOString().replace('T',' ').slice(0,19);
  // SG
  const sgUlt = db.prepare(`
    SELECT * FROM ifco_stocks_reales
    WHERE deposito_tipo='san_geronimo'
    ORDER BY fecha DESC, id DESC LIMIT 1
  `).get();
  const sgTeo = _stockTeoricoDeposito('san_geronimo');
  const sgFalta = !sgUlt || (sgUlt.creado_en < corte);
  const items = [{
    deposito_tipo: 'san_geronimo',
    proveedor_id: null,
    nombre: 'San Gerónimo',
    teorico: sgTeo,
    real: sgUlt ? sgUlt.cantidad : null,
    diferencia: sgUlt ? sgUlt.cantidad - sgTeo : null,
    ultimo_conteo: sgUlt || null,
    falta_cargar: sgFalta
  }];
  // Proveedores
  const provs = db.prepare("SELECT id, nombre FROM proveedores ORDER BY nombre").all();
  for (const p of provs) {
    const ult = db.prepare(`
      SELECT * FROM ifco_stocks_reales
      WHERE deposito_tipo='proveedor' AND proveedor_id=?
      ORDER BY fecha DESC, id DESC LIMIT 1
    `).get(p.id);
    const teo = _stockTeoricoDeposito('proveedor', p.id);
    items.push({
      deposito_tipo: 'proveedor',
      proveedor_id: p.id,
      nombre: p.nombre,
      teorico: teo,
      real: ult ? ult.cantidad : null,
      diferencia: ult ? ult.cantidad - teo : null,
      ultimo_conteo: ult || null,
      falta_cargar: !ult || (ult.creado_en < corte)
    });
  }
  res.json({
    corte_jueves: corte,
    es_post_jueves_10am: new Date() >= _ultimoJueves10am(),
    faltante_sg_total: _faltantesSGTotal(),
    items: items
  });
});

// GET /stocks-reales/historico — historial completo de conteos de un depósito
router.get('/stocks-reales/historico', function(req, res) {
  const tipo = req.query.deposito_tipo;
  const provId = req.query.proveedor_id ? parseInt(req.query.proveedor_id) : null;
  let q = "SELECT s.*, u.nombre AS usuario_nombre FROM ifco_stocks_reales s LEFT JOIN usuarios u ON u.id = s.usuario_id WHERE deposito_tipo = ?";
  const p = [tipo];
  if (tipo === 'proveedor') { q += " AND proveedor_id = ?"; p.push(provId); }
  q += " ORDER BY fecha DESC, id DESC LIMIT 100";
  res.json(db.prepare(q).all(...p));
});

// POST /stocks-reales — cargar nuevo conteo
router.post('/stocks-reales', express.json(), function(req, res) {
  try {
    const d = req.body || {};
    if (!d.deposito_tipo || ['san_geronimo','proveedor'].indexOf(d.deposito_tipo) < 0) return res.status(400).json({ error: 'deposito_tipo inválido' });
    if (d.deposito_tipo === 'proveedor' && !d.proveedor_id) return res.status(400).json({ error: 'Falta proveedor_id' });
    const cant = parseInt(d.cantidad);
    if (isNaN(cant) || cant < 0) return res.status(400).json({ error: 'Cantidad inválida' });
    const fecha = d.fecha || new Date().toISOString().slice(0,10);
    const r = db.prepare(`
      INSERT INTO ifco_stocks_reales (deposito_tipo, proveedor_id, cantidad, fecha, notas, usuario_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(d.deposito_tipo,
           d.deposito_tipo === 'proveedor' ? parseInt(d.proveedor_id) : null,
           cant, fecha, d.notas || null,
           (req.user && req.user.id) || null);
    res.json({ id: r.lastInsertRowid });
  } catch(e) {
    console.error('[IFCO][stocks-reales POST] EXCEPCION:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /stocks-reales/alerta-mobile — para el banner del mobile (devuelve si AL USUARIO le falta cargar)
router.get('/stocks-reales/alerta-mobile', function(req, res) {
  const u = req.user;
  if (!u || u.deposito_tipo !== 'proveedor' || !u.deposito_proveedor_id) {
    return res.json({ falta_cargar: false });
  }
  const corte = _ultimoJueves10am().toISOString().replace('T',' ').slice(0,19);
  const ult = db.prepare(`
    SELECT id, creado_en FROM ifco_stocks_reales
    WHERE deposito_tipo='proveedor' AND proveedor_id=?
    ORDER BY fecha DESC, id DESC LIMIT 1
  `).get(u.deposito_proveedor_id);
  const falta = (!ult || ult.creado_en < corte) && (new Date() >= _ultimoJueves10am());
  res.json({
    falta_cargar: falta,
    ultimo_conteo: ult || null,
    corte_jueves: corte
  });
});

export default router;
