// src/servicios/afip-wsfe.js
// ── Cliente WSFEv1 (Factura Electrónica) en modo LECTURA — Paso 2 de facturación ──
// SOLO consulta AFIP/ARCA homologación (FEDummy, último autorizado, parámetros). NO emite
// comprobantes (NO usa FECAESolicitar). Reusa el TA del WSAA (paso 1, autenticar() + caché).
//
// Auth: cada operación (salvo FEDummy) lleva <Auth>{Token, Sign, Cuit}</Auth>; Token/Sign salen
// del TA cacheado por autenticar('wsfe') y el Cuit de AFIP_CUIT (env). El cert/key nunca se tocan acá.

import { autenticar, ambienteActual } from './afip-wsaa.js';

// URLs verificadas en la doc oficial de ARCA (jun-2026):
//   https://www.sistemasagiles.com.ar/trac/wiki/ProyectoWSFEv1 → wswhomo / servicios1
const WSFE_URLS = {
  homologacion: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  produccion:   'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
};
const WSFE_NS = 'http://ar.gov.afip.dif.FEV1/';

function desescapar(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
// Primer valor de una etiqueta (ignora prefijo de namespace). Devuelve string desescapado o null.
function pick(xml, tag) {
  const m = xml.match(new RegExp('<(?:\\w+:)?' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?' + tag + '>', 'i'));
  return m ? desescapar(m[1]).trim() : null;
}
// Todos los bloques de una etiqueta repetida (contenido interno crudo, sin desescapar).
function pickAll(xml, tag) {
  const re = new RegExp('<(?:\\w+:)?' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?' + tag + '>', 'ig');
  const out = []; let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
// Errores de negocio que WSFE devuelve dentro de <Errors><Err><Code/><Msg/></Err></Errors>.
function extraerErrores(xml) {
  const errs = pickAll(xml, 'Err');
  if (!errs.length) return null;
  const msgs = errs.map(e => {
    const c = pick(e, 'Code'); const m = pick(e, 'Msg');
    return (c ? c + ': ' : '') + (m || '').trim();
  });
  return 'WSFE: ' + msgs.join(' · ');
}

// POST SOAP 1.1 de una operación. cuerpoInterno = XML de los parámetros (ya con prefijo ar:).
// Lanza con el faultstring si hubo SOAP Fault.
async function soapCall(operacion, cuerpoInterno) {
  const url = WSFE_URLS[ambienteActual()];
  const envelope = '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="' + WSFE_NS + '">'
    + '<soap:Body><ar:' + operacion + '>' + (cuerpoInterno || '') + '</ar:' + operacion + '></soap:Body>'
    + '</soap:Envelope>';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': WSFE_NS + operacion },
    body: envelope
  });
  const text = await resp.text();
  const fault = text.match(/<faultstring>([\s\S]*?)<\/faultstring>/i);
  if (fault) throw new Error('WSFE: ' + desescapar(fault[1]).trim());
  return text;
}

// Bloque <Auth> con el TA del WSAA + el CUIT del entorno. Token/Sign son base64 (sin chars XML).
async function authXml() {
  const ta = await autenticar('wsfe');
  const cuit = String(process.env.AFIP_CUIT || '').replace(/\D/g, '');
  if (!cuit) throw new Error('Falta AFIP_CUIT en el entorno');
  return '<ar:Auth><ar:Token>' + ta.token + '</ar:Token><ar:Sign>' + ta.sign + '</ar:Sign><ar:Cuit>' + cuit + '</ar:Cuit></ar:Auth>';
}

// Parsea una lista de parámetros (TiposCbte/TiposIva/PtosVenta) a objetos normalizados.
function parseLista(xml, itemTag) {
  return pickAll(xml, itemTag).map(it => {
    const o = {};
    const id = pick(it, 'Id'); if (id != null) o.id = Number(id);
    const nro = pick(it, 'Nro'); if (nro != null) o.nro = Number(nro);
    const desc = pick(it, 'Desc'); if (desc != null) o.desc = desc;
    const emi = pick(it, 'EmisionTipo'); if (emi != null) o.emision_tipo = emi;
    const blo = pick(it, 'Bloqueado'); if (blo != null) o.bloqueado = blo;
    const baja = pick(it, 'FchBaja'); if (baja != null) o.fch_baja = baja;
    return o;
  });
}

// ── OPERACIONES DE LECTURA ────────────────────────────────────────────────────

// FEDummy: ping de salud (sin Auth). Devuelve { appserver, dbserver, authserver }.
export async function feDummy() {
  const text = await soapCall('FEDummy', '');
  return { appserver: pick(text, 'AppServer'), dbserver: pick(text, 'DbServer'), authserver: pick(text, 'AuthServer') };
}

// FECompUltimoAutorizado(PtoVta, CbteTipo): último N° autorizado por PV+tipo (para numerar).
export async function ultimoComprobante(ptoVta, cbteTipo) {
  const pv = Number(ptoVta), tipo = Number(cbteTipo);
  if (!(pv > 0) || !(tipo > 0)) throw new Error('PtoVta y CbteTipo deben ser > 0');
  const inner = (await authXml()) + '<ar:PtoVta>' + pv + '</ar:PtoVta><ar:CbteTipo>' + tipo + '</ar:CbteTipo>';
  const text = await soapCall('FECompUltimoAutorizado', inner);
  const err = extraerErrores(text);
  if (err) throw new Error(err);
  return { pto_vta: Number(pick(text, 'PtoVta')), cbte_tipo: Number(pick(text, 'CbteTipo')), ultimo_nro: Number(pick(text, 'CbteNro')) };
}

// FEParamGetTiposCbte: tipos de comprobante con su código AFIP (1=Fact A, 6=Fact B, 3=NC A, 8=NC B…).
export async function tiposCbte() {
  const text = await soapCall('FEParamGetTiposCbte', await authXml());
  const err = extraerErrores(text); if (err) throw new Error(err);
  return parseLista(text, 'CbteTipo');
}

// FEParamGetTiposIva: alícuotas de IVA con su Id (5=21%, 4=10.5%, 3=0%…).
export async function tiposIva() {
  const text = await soapCall('FEParamGetTiposIva', await authXml());
  const err = extraerErrores(text); if (err) throw new Error(err);
  return parseLista(text, 'IvaTipo');
}

// FEParamGetPtosVenta: puntos de venta habilitados (esperamos 7/9/11/13).
export async function ptosVenta() {
  const text = await soapCall('FEParamGetPtosVenta', await authXml());
  const err = extraerErrores(text); if (err) throw new Error(err);
  return parseLista(text, 'PtoVenta');
}

export { ambienteActual };
