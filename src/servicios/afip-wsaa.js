// src/servicios/afip-wsaa.js
// ── Cliente WSAA (autenticación AFIP/ARCA) — Paso 1 de facturación ────────────────
// SOLO autentica (obtiene el Ticket de Acceso). NO emite comprobantes ni toca WSFE.
//
// SEGURIDAD:
// - Las credenciales (certificado + clave privada) se leen SIEMPRE de process.env
//   (AFIP_CERT_HOMO / AFIP_KEY_HOMO, en base64). Se decodifican a PEM EN MEMORIA al firmar.
// - El cert/key NUNCA se escriben a disco, ni a logs, ni al repo.
// - La firma CMS/PKCS#7 se hace localmente con node-forge: el certificado nunca sale del server
//   (no se usa el SDK @afipsdk que rutea por terceros).
//
// El TA (token + sign) se cachea en sg_afip_ta por servicio+ambiente hasta su expiración: AFIP
// rechaza pedir un TA nuevo si todavía hay uno vigente. Refresco lazy (se pide solo si no hay
// uno válido en caché).

import forge from 'node-forge';
import db from './db.js';

// URL de LoginCms. Homologación verificada en la doc oficial de ARCA (jun-2026):
//   https://www.afip.gob.ar/ws/documentacion/wsaa.asp  → wsaahomo.afip.gov.ar
const WSAA_URLS = {
  homologacion: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
  produccion:   'https://wsaa.afip.gov.ar/ws/services/LoginCms'
};
const WSAA_NS = 'http://wsaa.view.sua.dvadac.desein.afip.gov';
// Digest de la firma CMS. AFIP/ARCA con certificados actuales acepta SHA-256. Si en algún momento
// el WSAA rechaza la firma, cambiar a 'sha1' (override por env AFIP_CMS_DIGEST=sha1).
const CMS_DIGEST = (process.env.AFIP_CMS_DIGEST || 'sha256').toLowerCase() === 'sha1' ? 'sha1' : 'sha256';

export function ambienteActual() {
  return (process.env.AFIP_AMBIENTE || 'homologacion').toLowerCase() === 'produccion' ? 'produccion' : 'homologacion';
}

// PEM desde una env var en base64. Acepta también PEM directo (por si la env ya viene en texto).
// Lanza si falta la variable. NO loguea el contenido.
function pemDesdeEnv(nombre) {
  const raw = process.env[nombre];
  if (!raw || !String(raw).trim()) throw new Error('Falta la credencial en el entorno (' + nombre + ')');
  const v = String(raw).trim();
  if (v.includes('-----BEGIN')) return v;                       // ya es PEM
  const pem = Buffer.from(v, 'base64').toString('utf8');        // base64 → PEM (en memoria)
  if (!pem.includes('-----BEGIN')) throw new Error('La credencial ' + nombre + ' no es un PEM válido (base64)');
  return pem;
}

// Fecha en ISO 8601 con offset de Argentina (-03:00), sin milisegundos (formato que espera WSAA).
function fechaAfip(d) {
  const ar = new Date(d.getTime() - 3 * 3600 * 1000);          // a hora local AR (UTC-3)
  return ar.toISOString().replace(/\.\d{3}Z$/, '-03:00');
}

// TRA = Login Ticket Request. generationTime = ahora−10min (margen de reloj), expirationTime = +12h.
function construirTRA(servicio) {
  const ahora = new Date();
  const gen = fechaAfip(new Date(ahora.getTime() - 10 * 60 * 1000));
  const exp = fechaAfip(new Date(ahora.getTime() + 12 * 3600 * 1000));
  const uniqueId = Math.floor(ahora.getTime() / 1000);          // único y dentro de uint32 (hasta 2038)
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<loginTicketRequest version="1.0">'
    + '<header>'
    + '<uniqueId>' + uniqueId + '</uniqueId>'
    + '<generationTime>' + gen + '</generationTime>'
    + '<expirationTime>' + exp + '</expirationTime>'
    + '</header>'
    + '<service>' + servicio + '</service>'
    + '</loginTicketRequest>';
}

// Firma el TRA como CMS/PKCS#7 (SignedData, contenido embebido) y devuelve base64. Con node-forge:
// el cert/key se cargan a estructuras en memoria; nada se escribe afuera.
function firmarCMS(traXml, certPem, keyPem) {
  const cert = forge.pki.certificateFromPem(certPem);
  const key = forge.pki.privateKeyFromPem(keyPem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids[CMS_DIGEST],
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() }
    ]
  });
  p7.sign();                                                    // contenido embebido (no detached)
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}

// POST SOAP 1.1 del CMS a LoginCms. Devuelve { status, text }.
async function loginCms(cmsBase64) {
  const url = WSAA_URLS[ambienteActual()];
  const envelope = '<?xml version="1.0" encoding="utf-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="' + WSAA_NS + '">'
    + '<soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>' + cmsBase64 + '</wsaa:in0></wsaa:loginCms></soapenv:Body>'
    + '</soapenv:Envelope>';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '' },
    body: envelope
  });
  return { status: resp.status, text: await resp.text() };
}

function desescapar(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Extrae token/sign/expirationTime del SOAP de respuesta (el loginTicketResponse viene escapado
// dentro de <loginCmsReturn>). Lanza con el faultstring de AFIP si hubo error.
function parseLoginResponse(soapText) {
  const fault = soapText.match(/<faultstring>([\s\S]*?)<\/faultstring>/i);
  if (fault) throw new Error('WSAA: ' + desescapar(fault[1]).trim());
  const ret = soapText.match(/<loginCmsReturn>([\s\S]*?)<\/loginCmsReturn>/i);
  if (!ret) throw new Error('Respuesta WSAA inesperada (sin loginCmsReturn)');
  const xml = desescapar(ret[1]);
  const pick = (tag) => { const m = xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'i')); return m ? m[1].trim() : null; };
  const token = pick('token'), sign = pick('sign');
  if (!token || !sign) throw new Error('TA recibido sin token/sign');
  return { token, sign, expira: pick('expirationTime'), generado: pick('generationTime') };
}

// TA válido en caché (con 60s de margen). Devuelve la fila o null.
function taEnCache(servicio, ambiente) {
  const row = db.prepare('SELECT token, sign, generado, expira FROM sg_afip_ta WHERE servicio=? AND ambiente=?').get(servicio, ambiente);
  if (!row || !row.expira) return null;
  const expMs = Date.parse(row.expira);
  if (isNaN(expMs)) return null;
  return (expMs > Date.now() + 60 * 1000) ? row : null;
}

// Autentica contra WSAA y devuelve { token, sign, expira, generado, cacheado, ambiente }.
// Reusa el TA cacheado si sigue vigente; si no, firma un TRA nuevo y pide uno.
export async function autenticar(servicio = 'wsfe') {
  const ambiente = ambienteActual();
  const cacheado = taEnCache(servicio, ambiente);
  if (cacheado) return { ...cacheado, cacheado: true, ambiente };

  const certPem = pemDesdeEnv('AFIP_CERT_HOMO');
  const keyPem = pemDesdeEnv('AFIP_KEY_HOMO');
  const tra = construirTRA(servicio);
  const cms = firmarCMS(tra, certPem, keyPem);
  const { text } = await loginCms(cms);
  const ta = parseLoginResponse(text);                          // lanza con el fault de AFIP si falló

  db.prepare(`INSERT INTO sg_afip_ta (servicio, ambiente, token, sign, generado, expira)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(servicio, ambiente) DO UPDATE SET token=excluded.token, sign=excluded.sign, generado=excluded.generado, expira=excluded.expira`)
    .run(servicio, ambiente, ta.token, ta.sign, ta.generado, ta.expira);

  return { ...ta, cacheado: false, ambiente };
}
