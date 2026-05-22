// ════════════════════════════════════════════════════════════════════════════
// SERVICIO DE MAIL — envío vía API HTTP de Brevo
// ════════════════════════════════════════════════════════════════════════════
//
// Por qué API HTTP en vez de SMTP: Railway bloquea los puertos SMTP salientes
// (25/465/587) como política antispam. La API HTTP de Brevo va por puerto 443
// (HTTPS estándar), que siempre está abierto.
//
// Variables de entorno requeridas:
//   BREVO_API_KEY  — API key de Brevo (empieza con xkeysib-)
//
// Sender por defecto: erp@lnbonita.com.ar con nombre "ERP LNB"
// Cada caller puede overridear sender/senderName si necesita (ej. IFCO usa
// el suyo propio con nombre "Gestión IFCO - SAN GERONIMO SA").
//
// USO:
//   import { enviarMail } from '../servicios/mail.js';
//   const r = await enviarMail({
//     to: 'usuario@ejemplo.com',
//     asunto: 'Hola',
//     cuerpo_html: '<p>Test</p>'
//   });
//   if (!r.success) console.error(r.error);
// ════════════════════════════════════════════════════════════════════════════

import fs from 'fs';

const DEFAULT_SENDER_EMAIL = 'erp@lnbonita.com.ar';
const DEFAULT_SENDER_NAME  = 'ERP LNB';

/**
 * Envía un mail vía API HTTP de Brevo. No hace logging propio — eso lo decide
 * cada caller. Devuelve { success, messageId } o { success: false, error }.
 *
 * opts: {
 *   to: string | string[],         // destinatario(s) — al menos uno
 *   cc?: string | string[],        // opcional
 *   asunto: string,
 *   cuerpo_html?: string,          // al menos uno de html o texto
 *   cuerpo_texto?: string,
 *   adjuntos?: [{ filename, path }] | [{ filename, content }],  // path local o base64
 *   sender_email?: string,         // default: erp@lnbonita.com.ar
 *   sender_name?: string           // default: 'ERP LNB'
 * }
 */
export async function enviarMail(opts) {
  try {
    if (!process.env.BREVO_API_KEY) {
      throw new Error('BREVO_API_KEY no configurada en variables de entorno de Railway');
    }
    const senderEmail = opts.sender_email || DEFAULT_SENDER_EMAIL;
    const senderName  = opts.sender_name  || DEFAULT_SENDER_NAME;

    // Convertir destinatarios al formato que espera Brevo: [{ email: '...', name?: '...' }]
    const toRaw = Array.isArray(opts.to) ? opts.to : String(opts.to || '').split(',');
    const toList = toRaw.map(function(x){ return String(x).trim(); }).filter(Boolean).map(function(e){ return { email: e }; });
    if (toList.length === 0) throw new Error('Destinatario requerido');

    const ccRaw = opts.cc ? (Array.isArray(opts.cc) ? opts.cc : String(opts.cc).split(',')) : [];
    const ccList = ccRaw.map(function(x){ return String(x).trim(); }).filter(Boolean).map(function(e){ return { email: e }; });

    // Convertir adjuntos. Soporta dos formas:
    //   { filename, path }     — lee del disco
    //   { filename, content }  — base64 ya provisto
    const attachments = [];
    (opts.adjuntos || []).forEach(function(a){
      if (a.content) {
        attachments.push({ name: a.filename, content: a.content });
      } else if (a.path) {
        try {
          const content = fs.readFileSync(a.path).toString('base64');
          attachments.push({ name: a.filename, content: content });
        } catch(e) {
          console.warn('[mail] No se pudo leer adjunto:', a.path, e.message);
        }
      }
    });

    const payload = {
      sender: { name: senderName, email: senderEmail },
      to: toList,
      subject: opts.asunto || '(sin asunto)'
    };
    if (opts.cuerpo_html)  payload.htmlContent = opts.cuerpo_html;
    if (opts.cuerpo_texto) payload.textContent = opts.cuerpo_texto;
    if (ccList.length > 0) payload.cc = ccList;
    if (attachments.length > 0) payload.attachment = attachments;

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text().catch(function(){ return ''; });
      throw new Error('Brevo API HTTP ' + res.status + ': ' + errText.slice(0, 300));
    }
    const data = await res.json().catch(function(){ return {}; });
    return { success: true, messageId: data.messageId || null };
  } catch(err) {
    console.error('[mail][enviarMail]', err);
    return { success: false, error: err.message };
  }
}

export default enviarMail;
