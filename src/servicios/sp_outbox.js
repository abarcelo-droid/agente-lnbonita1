// src/servicios/sp_outbox.js
// ── COLA DE SALIDA DE MAILS ───────────────────────────────────────────────
// POR QUÉ UNA COLA Y NO await enviarMail() EN EL LUGAR:
//
// 1. Es IMPOSIBLE dentro de la transacción. enviarMail es async y better-sqlite3
//    no acepta que la función de db.transaction() devuelva una promesa (tira
//    TypeError). El estado se cambia en una transacción; el mail no puede ir ahí.
// 2. Aunque se pudiera, no habría que hacerlo: si Brevo tarda 8 segundos, la
//    transacción queda abierta 8 segundos.
// 3. enviarMail NUNCA tira: devuelve {success:false, error}. Un await sin chequear
//    .success falla en silencio. Y no hay ningún registro de mails en el repo.
//    Para un circuito de autorizaciones eso es inaceptable: si el aviso no sale,
//    la solicitud queda esperando a alguien que nunca se enteró, y nadie puede
//    saber si se avisó o no.
//
// Entonces: se ENCOLA dentro de la transacción que cambia el estado (así el aviso
// existe si y solo si el cambio se guardó) y se MANDA después, afuera.

import db from './db_sp.js';
import { enviarMail } from './mail.js';

const MAX_INTENTOS = 5;
const LOTE = 10;

// Render de plantilla: reemplazo de {{clave}} y nada más. No se evalúa nada, así
// que una plantilla mal escrita no puede romper el envío ni ejecutar código.
export function render(texto, vars) {
  return String(texto || '').replace(/\{\{(\w+)\}\}/g, function (_, k) {
    const v = vars[k];
    return (v === null || v === undefined || v === '') ? '—' : String(v);
  });
}

/**
 * Encola un mail. Se llama DENTRO de la transacción del cambio de estado.
 * dedupKey hace el encolado idempotente: si el mismo aviso se intenta encolar dos
 * veces (doble submit, reintento), la segunda no inserta nada.
 */
export function encolar({ solicitudId, eventoId, dedupKey, destinatarios, asunto, cuerpo }) {
  const dest = (Array.isArray(destinatarios) ? destinatarios : [destinatarios])
    .map(x => String(x || '').trim()).filter(Boolean);
  if (!dest.length) {
    // Sin destinatario no se encola un mail que nunca va a salir: se deja el
    // registro como descartado, que es lo que después explica el silencio.
    try {
      db.prepare(`
        INSERT OR IGNORE INTO sp_outbox (solicitud_id, evento_id, dedup_key, destinatarios,
                                         asunto, cuerpo_texto, estado, ultimo_error)
        VALUES (?,?,?,?,?,?, 'descartado', 'sin destinatarios con mail cargado')
      `).run(solicitudId || null, eventoId || null, dedupKey, '', asunto || '(sin asunto)', cuerpo || '');
    } catch (_) { /* el UNIQUE de dedup_key ya lo cubrió */ }
    return null;
  }
  try {
    const r = db.prepare(`
      INSERT OR IGNORE INTO sp_outbox (solicitud_id, evento_id, dedup_key, destinatarios, asunto, cuerpo_texto)
      VALUES (?,?,?,?,?,?)
    `).run(solicitudId || null, eventoId || null, dedupKey, dest.join(','), asunto, cuerpo);
    return r.changes ? r.lastInsertRowid : null;
  } catch (e) {
    console.error('[SP][outbox] Error encolando:', e.message);
    return null;
  }
}

/**
 * Procesa los pendientes. Se llama después de responder al usuario (no se espera)
 * y desde el scheduler. El claim es atómico: se marca la fila como en curso
 * subiendo intentos ANTES de enviar, así dos procesamientos simultáneos no manden
 * el mismo mail dos veces.
 */
export async function procesarCola() {
  let filas;
  try {
    filas = db.prepare(`
      SELECT * FROM sp_outbox
      WHERE estado IN ('pendiente','error') AND intentos < ?
      ORDER BY id LIMIT ?
    `).all(MAX_INTENTOS, LOTE);
  } catch (e) {
    console.error('[SP][outbox] Error leyendo la cola:', e.message);
    return { enviados: 0, fallidos: 0 };
  }
  if (!filas.length) return { enviados: 0, fallidos: 0 };

  let enviados = 0, fallidos = 0;
  for (const f of filas) {
    // Claim atómico por intentos: si otro proceso ya lo tomó, changes = 0.
    const claim = db.prepare('UPDATE sp_outbox SET intentos = intentos + 1 WHERE id = ? AND intentos = ?')
      .run(f.id, f.intentos);
    if (claim.changes === 0) continue;

    const r = await enviarMail({
      to: f.destinatarios.split(','),
      asunto: f.asunto,
      cuerpo_texto: f.cuerpo_texto,
      // Se manda también como HTML mínimo (solo saltos de línea) porque muchos
      // clientes de mail muestran el texto plano apretado.
      cuerpo_html: '<pre style="font-family:inherit;white-space:pre-wrap;margin:0">'
        + String(f.cuerpo_texto).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>'
    });

    if (r && r.success) {
      db.prepare(`UPDATE sp_outbox SET estado='enviado', enviado_en=datetime('now','localtime'),
                  message_id=?, ultimo_error=NULL WHERE id=?`).run(r.messageId || null, f.id);
      enviados++;
    } else {
      const msg = (r && r.error) ? String(r.error).slice(0, 400) : 'error desconocido';
      const agotado = (f.intentos + 1) >= MAX_INTENTOS;
      db.prepare('UPDATE sp_outbox SET estado=?, ultimo_error=? WHERE id=?')
        .run(agotado ? 'error' : 'pendiente', msg, f.id);
      fallidos++;
      console.error(`[SP][outbox] Falló el mail ${f.id} (intento ${f.intentos + 1}):`, msg);
    }
  }
  if (enviados || fallidos) console.log(`[SP][outbox] ${enviados} enviados, ${fallidos} con error`);
  return { enviados, fallidos };
}

// Dispara el procesamiento sin bloquear la respuesta al usuario. Los errores se
// registran en la fila, así que acá solo hay que evitar un unhandled rejection.
export function procesarEnBackground() {
  setImmediate(() => {
    procesarCola().catch(e => console.error('[SP][outbox] Error procesando:', e.message));
  });
}

// Reintento periódico de lo que quedó pendiente (por ejemplo, si Brevo estaba
// caído). Molde de los schedulers que ya tiene index.js.
export function programarProcesoCola(minutos = 10) {
  const ms = Math.max(1, minutos) * 60 * 1000;
  setInterval(() => {
    procesarCola().catch(e => console.error('[SP][outbox] Error en el ciclo:', e.message));
  }, ms);
  console.log(`[SP] Reintento de mails pendientes cada ${minutos} min`);
}

export default procesarCola;
