// src/servicios/afip-wsfe-emision.js
// ── Motor de EMISIÓN de comprobantes electrónicos (WSFEv1 / FECAESolicitar) — Paso 3 ──
// Reusa WSAA (paso 1) + WSFE lectura (paso 2). Emite SOLO contra homologación por ahora.
// NO toca la facturación interna existente (solo AGREGA columnas fiscales a sg_ven_*).

import db from './db.js';
import './db_sg_finanzas.js'; // asegura que sg_ven_facturas / sg_ven_factura_items existan
import { ambienteActual, soapCall, authXml, pick, pickAll, extraerErrores } from './afip-wsfe.js';
import { ultimoComprobante } from './afip-wsfe.js';
// LA VENTA TIENE QUE QUEDAR EN EL LIBRO. Este camino —el de facturación
// directa— no generaba ningún asiento: la mercadería salía, el cliente quedaba
// debiendo, y en la contabilidad no pasaba nada. Misma regla que en compras.
import { fiscalDeCliente } from './sg_fiscal.js';
import { lineasAsientoVenta } from './asiento-venta.js';
import { crearAsiento } from './asientos.js';
import { esNotaDeCredito } from './factura-cuenta.js';

// ── Migraciones aditivas (no se tocan los archivos de Pablo) ──────────────────────
function _alter(tabla, col, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name);
    if (!cols.includes(col)) { db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${ddl}`); }
  } catch (e) { console.error(`[AFIP] ALTER ${tabla}.${col}:`, e.message); }
}
// ── LO QUE VENDIÓ CADA LÍNEA, EN PESOS Y EN SU PROPIO RENGLÓN ─────────
//
// Pablo, 24/8/2026: "a la hora de hacer la liquidación, la venta que debe traer
// la partida es la venta EXACTA en pesos que tuvo esa partida. No hay que
// dividirla por kilos ni cuestiones raras: hay que traer la venta tal como está
// en las partidas. Esta va a ser la norma en PRECIO ABIERTO documento
// liquidación."
//
// Y tiene razón: al productor se le liquida lo que SU mercadería vendió. Un
// prorrateo —por kilos o por valor— es un reparto inventado sobre el total de
// una factura, y no hay norma contable que lo respalde cuando el dato exacto
// existe. Existe: cada renglón del remito tiene su precio.
//
// Se guardan al EMITIR, que es el único momento en que se sabe si el precio
// tipeado traía IVA adentro o no. Recalcularlos después sería adivinar.
_alter('sg_factura_despachos', 'neto', 'neto REAL');
_alter('sg_factura_despachos', 'iva', 'iva REAL');
_alter('sg_factura_despachos', 'gestion', 'gestion REAL');

// sg_ven_facturas += columnas fiscales (AFIP)
_alter('sg_ven_facturas', 'punto_venta', 'punto_venta INTEGER');
_alter('sg_ven_facturas', 'cbte_tipo', 'cbte_tipo INTEGER');
_alter('sg_ven_facturas', 'cbte_nro', 'cbte_nro INTEGER');
_alter('sg_ven_facturas', 'cae', 'cae TEXT');
_alter('sg_ven_facturas', 'cae_vto', 'cae_vto TEXT');
_alter('sg_ven_facturas', 'afip_resultado', 'afip_resultado TEXT');     // A / R / O
_alter('sg_ven_facturas', 'afip_obs', 'afip_obs TEXT');
_alter('sg_ven_facturas', 'ambiente', 'ambiente TEXT');
_alter('sg_ven_facturas', 'afip_estado', 'afip_estado TEXT');           // borrador/reservado/autorizado/rechazado
// sg_ven_factura_items += producto + alícuota (para desglosar IVA)
// De qué factura es esta nota de crédito. Sin este puntero la nota es un papel
// suelto: no se sabe qué anuló, y la factura no sabe que ya no se cobra.
_alter('sg_ven_facturas', 'nc_de_factura_id', 'nc_de_factura_id INTEGER');
_alter('sg_ven_facturas', 'nc_motivo', 'nc_motivo TEXT');
// DE QUÉ RENGLÓN DE REMITO SALIÓ ESTE RENGLÓN DEL COMPROBANTE.
// La correspondencia existía pero era POSICIONAL: postEmitir empuja el ítem y su
// vínculo en la misma vuelta del for, y nada los ataba. Con la nota de crédito
// PARCIAL hace falta poder decir "de este renglón vuelven 300 de los 1.000 kg" y
// saber a qué remito devolvérselos. Por posición andaba de casualidad.
_alter('sg_ven_factura_items', 'despacho_item_id', 'despacho_item_id INTEGER');
// Y qué renglón de la factura corrige este renglón de la nota. Es lo que permite
// llevar la cuenta de cuánto se le acreditó ya a cada uno, y por lo tanto emitir
// varias notas parciales sin pasarse.
_alter('sg_ven_factura_items', 'nc_de_item_id', 'nc_de_item_id INTEGER');
// DEVOLVER NO ES AJUSTAR EL PRECIO, y la diferencia hay que poder leerla después.
// Un ajuste de precio se emite con la cantidad ENTERA del renglón —es lo que ARCA
// espera y lo que deja el papel legible— pero esos kilos NO volvieron. Sin esta
// marca, la cuenta de "cuánto se devolvió de este renglón" los daba por devueltos y
// la devolución de verdad quedaba bloqueada para siempre.
_alter('sg_ven_factura_items', 'nc_modo', 'nc_modo TEXT');
_alter('sg_ven_factura_items', 'producto_id', 'producto_id INTEGER');
_alter('sg_ven_factura_items', 'alicuota_id', 'alicuota_id INTEGER');
// F5 — metadata de PRESENTACIÓN por bulto (cajón). NO afecta importes: cantidad/precio_unitario/
// subtotal siguen en kg×precio_kg (lo que va a AFIP). Estos campos solo alimentan el PDF.
_alter('sg_ven_factura_items', 'bultos', 'bultos REAL');
_alter('sg_ven_factura_items', 'kg_por_bulto', 'kg_por_bulto REAL');
_alter('sg_ven_factura_items', 'precio_por_bulto', 'precio_por_bulto REAL');
_alter('sg_ven_factura_items', 'unidad', 'unidad TEXT');
// Vínculo N:N factura ↔ despacho (qué despacho/ítems ya se facturaron)
db.exec(`
  CREATE TABLE IF NOT EXISTS sg_factura_despachos (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    factura_id        INTEGER NOT NULL REFERENCES sg_ven_facturas(id),
    despacho_id       INTEGER NOT NULL REFERENCES sg_despachos(id),
    despacho_item_id  INTEGER REFERENCES sg_despacho_items(id),
    kg                REAL,
    creado_en         TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_sg_fact_desp_fact ON sg_factura_despachos(factura_id);
  CREATE INDEX IF NOT EXISTS idx_sg_fact_desp_desp ON sg_factura_despachos(despacho_id);
`);

// ── Mapeos fiscales ───────────────────────────────────────────────────────────────
// Alícuota de IVA (% del PRODUCTO) → Id de AFIP. 0%=3, 10.5%=4, 21%=5, 27%=6, 5%=8, 2.5%=9.
const IVA_PCT_A_ID = { 0: 3, 10.5: 4, 21: 5, 27: 6, 5: 8, 2.5: 9 };
// La vuelta: del id de alícuota al porcentaje. La hace falta para rehacer un
// comprobante a partir de lo guardado —una nota de crédito copia los renglones de su
// factura, y ahí lo que quedó escrito es el id, no el %—.
export function pctDeAlicuotaId(id) {
  const e = Object.entries(IVA_PCT_A_ID).find(([, v]) => Number(v) === Number(id));
  return e ? Number(e[0]) : null;
}
function alicuotaId(pct) {
  // null ya no llega hasta acá: construirComprobante frena antes y dice qué producto
  // es. Un dato que falta no es una exención, y salir exento en silencio era el bug.
  if (pct == null || pct === '') return null;
  const p = Number(pct);
  return Object.prototype.hasOwnProperty.call(IVA_PCT_A_ID, p) ? IVA_PCT_A_ID[p] : undefined; // undefined = no soportada
}
// ══ LA LETRA Y LA CONDICIÓN DEL RECEPTOR SALEN DE LA FICHA ═════════════
//
// Acá había tres funciones que decidían todo mirando UNA sola cosa: si el cliente
// tenía un CUIT cargado. Con CUIT → Factura A y "Responsable Inscripto" a AFIP; sin
// CUIT → Factura B y "Consumidor Final". La CATEGORÍA FISCAL del cliente, que está
// en su ficha desde siempre, no se miraba.
//
// Un monotributista con CUIT recibía una Factura A y se lo informaba como
// Responsable Inscripto. Las dos cosas mal, en cada venta.
//
// La regla completa vive en servicios/sg_fiscal.js, que es PURO: se puede leer
// entera de un saque y probar sin levantar nada. Acá sólo se la aplica.
function fiscalDe(cliente, esNC, ctx) {
  const f = fiscalDeCliente(cliente, { esNC: !!esNC, ...(ctx || {}) });
  if (!f.ok) throw new Error(f.error);
  return f;
}
// El umbral desde el que hay que identificar al consumidor final (RG 5700/2025).
// Sale de la configuración y no del código: se mueve con la inflación.
function umbralIdentificacion(database) {
  try {
    const r = database.prepare("SELECT valor FROM sg_config WHERE clave='umbral_identificar_cf'").get();
    const n = Number(r && r.valor);
    return n > 0 ? n : null;
  } catch (_) { return null; }
}
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function fechaHoyAR() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }

// ══ EL IVA SALE DEL PRODUCTO, Y LOS IMPORTES LOS TRAE EL LLAMADOR ═══════
//
// Dos arreglos que van juntos porque los dos nacían en el mismo SELECT.
//
// 1) LA ALÍCUOTA ES LA DEL PRODUCTO. Acá decía `f.iva_alicuota` --sólo la de la
//    familia-- y la dejaba llamándose igual, así que todo el archivo creía estar
//    leyendo la del producto. Desde el #870 la alícuota VIVE EN EL PRODUCTO y la
//    familia es apenas el valor propuesto al darlo de alta. Con este SELECT, un
//    producto al 21% en una familia al 10,5 le informaba a AFIP la mitad del
//    débito fiscal mientras la pantalla mostraba 21 — y un producto en una familia
//    SIN alícuota salía EXENTO en silencio, que es exactamente lo que el #870 vino
//    a arreglar. El resto del módulo ya usaba COALESCE(producto, familia); faltaba
//    el único lugar por el que sale un comprobante.
//
// 2) SIN ALÍCUOTA NO SE EMITE (decisión de Pablo, 25/8/2026). Antes, alícuota nula
//    mandaba el neto a ImpOpEx: la operación salía EXENTA sin que nadie lo
//    decidiera. Un dato que falta no es una exención. Ahora frena y dice qué
//    producto es. Ojo: 0 SIGUE SIENDO VÁLIDO --hay mercadería al 0%-- y va gravado
//    al 0% (Id 3), que es distinto de exento. Por eso se compara contra null y no
//    con un truthy.
//
// 3) LOS IMPORTES DE LA LÍNEA VIENEN HECHOS. Si el llamador ya sabe el neto y el
//    IVA de cada renglón --porque él es el que sabe si el precio tipeado traía IVA
//    adentro-- los manda y acá no se recalculan. Reconstruir el total desde un
//    precio unitario redondeado es lo que dejaba el comprobante en $2.789.999,98
//    cuando el papel decía $2.790.000. Sin esos campos, se calcula como siempre.
export function construirComprobante(database, { clienteId, items, esNC, identificacion, asociado }) {
  const cliente = database.prepare('SELECT id, razon_social, cuit, categoria_fiscal FROM sg_clientes WHERE id=?').get(clienteId);
  if (!cliente) throw new Error('Cliente inexistente: ' + clienteId);
  // La LETRA se necesita antes de recorrer los renglones (define la serie), pero si
  // hay que IDENTIFICAR al comprador depende del total, que recién se sabe al final.
  // Se resuelve dos veces con la misma función: la primera para la letra, la segunda
  // —ya con el total— para el documento.
  const fisc0 = fiscalDe(cliente, esNC);
  const cbteTipo = fisc0.cbte_tipo;
  const ivaMap = {};
  let impNeto = 0, impIva = 0, impOpEx = 0;
  const detalle = [];
  for (const it of (items || [])) {
    const prod = database.prepare(`SELECT p.id, p.nombre, p.familia_id,
        COALESCE(p.iva_alicuota, f.iva_alicuota) AS iva_alicuota
      FROM sg_productos p LEFT JOIN sg_familias f ON f.id=p.familia_id WHERE p.id=?`).get(it.producto_id);
    if (!prod) throw new Error('Producto inexistente: ' + it.producto_id);
    const cant = Number(it.cantidad) || 0, precio = Number(it.precio) || 0;
    if (!(cant > 0)) throw new Error('Cantidad inválida en ' + (prod.nombre || it.producto_id));
    // La alícuota que decidió el llamador gana sobre el catálogo: la línea de un
    // remito lleva la que se resolvió cuando se armó, no la que tenga el producto hoy.
    const alic = (it.alicuota != null && it.alicuota !== '') ? Number(it.alicuota)
               : (prod.iva_alicuota != null ? Number(prod.iva_alicuota) : null);
    if (alic == null || isNaN(alic)) {
      throw new Error(`"${prod.nombre}" no tiene alícuota de IVA cargada. Cargala en el maestro `
        + `de productos antes de facturarlo: sin ella el comprobante saldría exento y la pantalla `
        + `estaría mostrando otro número.`);
    }
    const neto = (it.importe_neto != null) ? r2(it.importe_neto) : r2(cant * precio);
    // F5 — metadata de presentación por bulto (cajón). NO interviene en el cálculo de importes:
    // el subtotal sigue siendo neto = cant(kg) × precio(kg). Solo viaja al detalle local para el PDF.
    const bultoMeta = {
      bultos:           it.bultos != null ? it.bultos : null,
      kg_por_bulto:     it.kg_por_bulto != null ? it.kg_por_bulto : null,
      precio_por_bulto: it.precio_por_bulto != null ? it.precio_por_bulto : null,
      unidad:           it.unidad || null,
      // Los dos punteros de la nota de crédito parcial: de qué renglón de remito
      // salió, y a qué renglón de la factura corrige.
      despacho_item_id: it.despacho_item_id != null ? Number(it.despacho_item_id) : null,
      nc_de_item_id:    it.nc_de_item_id != null ? Number(it.nc_de_item_id) : null,
      nc_modo:          it.nc_modo || null,
    };
    const id = alicuotaId(alic);
    if (id === undefined) throw new Error('Alícuota de IVA no soportada para ' + prod.nombre + ': ' + alic + '%');
    // El IVA de la línea, si el llamador lo trae, sale POR DIFERENCIA contra el
    // bruto que se tipeó y no de multiplicar el neto: así neto + iva da exacto
    // el importe que se vio en pantalla, sin residuo.
    const iva = (it.importe_iva != null) ? r2(it.importe_iva) : r2(neto * alic / 100);
    impNeto = r2(impNeto + neto); impIva = r2(impIva + iva);
    if (!ivaMap[id]) ivaMap[id] = { base: 0, importe: 0 };
    ivaMap[id].base = r2(ivaMap[id].base + neto);
    ivaMap[id].importe = r2(ivaMap[id].importe + iva);
    detalle.push({ producto_id: prod.id, descripcion: it.descripcion || prod.nombre,
      cantidad: cant, precio_unitario: precio, subtotal: neto, alicuota_id: id, ...bultoMeta });
  }
  if (!detalle.length) throw new Error('El comprobante necesita al menos un ítem');
  const impTotal = r2(impNeto + impIva + impOpEx);
  // AHORA SÍ, con el total en la mano: ¿hay que identificar al comprador? Si el
  // comprobante supera el umbral y va a consumidor final, ARCA exige DNI o CUIT.
  const fisc = fiscalDe(cliente, esNC, { total: impTotal,
    umbral: umbralIdentificacion(database), identificacion });
  const doc_tipo = fisc.doc_tipo, doc_nro = fisc.doc_nro;
  const iva = Object.keys(ivaMap).map(id => ({ Id: Number(id), BaseImp: ivaMap[id].base, Importe: ivaMap[id].importe }));
  return { cliente, cbte_tipo: cbteTipo, doc_tipo, doc_nro, cond_iva_receptor: fisc.cond_iva, letra_fiscal: fisc.letra,
    pide_identificacion: !!fisc.pide_identificacion,
    // EL COMPROBANTE ASOCIADO. Una nota de crédito sin la factura que corrige es un
    // papel suelto: ARCA la rechaza y el cliente no sabe qué se le está acreditando.
    asociado: asociado || null,
    imp_neto: impNeto, imp_iva: impIva, imp_opex: impOpEx, imp_total: impTotal, iva, detalle, concepto: 1 };
}

// XML interno de FECAESolicitar (un comprobante). 'auth' = bloque <ar:Auth>.
// El comprobante que una nota de crédito corrige. Va DESPUÉS de
// CondicionIVAReceptorId y ANTES de Iva (orden del XSD de FEv1).
export function asocXml(a) {
  if (!a || !a.cbte_tipo || !a.punto_venta || !a.cbte_nro) return '';
  return '<ar:CbtesAsoc><ar:CbteAsoc>'
    + '<ar:Tipo>' + Number(a.cbte_tipo) + '</ar:Tipo>'
    + '<ar:PtoVta>' + Number(a.punto_venta) + '</ar:PtoVta>'
    + '<ar:Nro>' + Number(a.cbte_nro) + '</ar:Nro>'
    + (a.cuit ? '<ar:Cuit>' + String(a.cuit).replace(/\D/g, '') + '</ar:Cuit>' : '')
    + (a.fecha ? '<ar:CbteFch>' + String(a.fecha).replace(/-/g, '') + '</ar:CbteFch>' : '')
    + '</ar:CbteAsoc></ar:CbtesAsoc>';
}

export function xmlFECAESolicitar(auth, { ptoVta, cbteTipo, cbteNro, comprobante, fecha }) {
  const c = comprobante;
  const fch = String(fecha).replace(/-/g, '');         // YYYYMMDD
  const ivaXml = c.iva.length
    ? '<ar:Iva>' + c.iva.map(a => `<ar:AlicIva><ar:Id>${a.Id}</ar:Id><ar:BaseImp>${r2(a.BaseImp).toFixed(2)}</ar:BaseImp><ar:Importe>${r2(a.Importe).toFixed(2)}</ar:Importe></ar:AlicIva>`).join('') + '</ar:Iva>'
    : '';
  return auth
    + '<ar:FeCAEReq>'
    + '<ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>' + ptoVta + '</ar:PtoVta><ar:CbteTipo>' + cbteTipo + '</ar:CbteTipo></ar:FeCabReq>'
    + '<ar:FeDetReq><ar:FECAEDetRequest>'
    + '<ar:Concepto>1</ar:Concepto>'
    + '<ar:DocTipo>' + c.doc_tipo + '</ar:DocTipo><ar:DocNro>' + c.doc_nro + '</ar:DocNro>'
    + '<ar:CbteDesde>' + cbteNro + '</ar:CbteDesde><ar:CbteHasta>' + cbteNro + '</ar:CbteHasta>'
    + '<ar:CbteFch>' + fch + '</ar:CbteFch>'
    + '<ar:ImpTotal>' + c.imp_total.toFixed(2) + '</ar:ImpTotal>'
    + '<ar:ImpTotConc>0.00</ar:ImpTotConc>'
    + '<ar:ImpNeto>' + c.imp_neto.toFixed(2) + '</ar:ImpNeto>'
    + '<ar:ImpOpEx>' + c.imp_opex.toFixed(2) + '</ar:ImpOpEx>'
    + '<ar:ImpIVA>' + c.imp_iva.toFixed(2) + '</ar:ImpIVA>'
    + '<ar:ImpTrib>0.00</ar:ImpTrib>'
    + '<ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz>'
    // RG 5616 — Condición frente al IVA del receptor. Va DESPUÉS de MonCotiz y ANTES de Iva (orden XSD).
    + '<ar:CondicionIVAReceptorId>' + (c.cond_iva_receptor || 5) + '</ar:CondicionIVAReceptorId>'
    + asocXml(c.asociado)
    + ivaXml
    + '</ar:FECAEDetRequest></ar:FeDetReq>'
    + '</ar:FeCAEReq>';
}

// Parsea la respuesta de FECAESolicitar → { resultado A/R, cae, cae_vto, obs }.
export function parseFECAEResponse(xml) {
  const topErr = extraerErrores(xml);
  const resultado = pick(xml, 'Resultado');            // FeCabResp.Resultado (A/R/P)
  const caeRaw = pick(xml, 'CAE');
  const caeVto = pick(xml, 'CAEFchVto');
  const obsList = pickAll(xml, 'Obs').map(o => { const c = pick(o, 'Code'); const m = pick(o, 'Msg'); return (c ? c + ': ' : '') + (m || '').trim(); });
  if (topErr && !resultado) throw new Error(topErr);   // error estructural/auth duro
  const obs = [topErr, obsList.length ? obsList.join(' · ') : null].filter(Boolean).join(' | ') || null;
  const cae = (caeRaw && /^\d{10,}$/.test(caeRaw)) ? caeRaw : null;
  return { resultado: resultado || (topErr ? 'R' : null), cae, cae_vto: caeVto || null, obs };
}

// FECompConsultar(PV, tipo, nro): reconsulta un número ya enviado (recuperación de timeout).
export async function consultarComprobante(ptoVta, cbteTipo, cbteNro) {
  const inner = (await authXml())
    + '<ar:FeCompConsReq><ar:CbteTipo>' + cbteTipo + '</ar:CbteTipo><ar:CbteNro>' + cbteNro + '</ar:CbteNro><ar:PtoVta>' + ptoVta + '</ar:PtoVta></ar:FeCompConsReq>';
  const text = await soapCall('FECompConsultar', inner);
  const cae = pick(text, 'CodAutorizacion') || pick(text, 'CAE');
  const vto = pick(text, 'FchVto') || pick(text, 'CAEFchVto');
  if (cae && /^\d{10,}$/.test(cae)) return { cae, cae_vto: vto || null, resultado: pick(text, 'Resultado') };
  return null;
}

// Serializa las emisiones por PV+tipo (mutex en proceso) para no pedir dos veces el mismo número.
const _colas = new Map();
function serializar(key, fn) {
  const prev = _colas.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  _colas.set(key, run.then(() => {}, () => {}));
  return run;
}

// ── EL PUNTO DE VENTA DECIDE SI SE LLAMA A AFIP ───────────────────
//
// Hasta acá la emisión NO miraba la tabla de puntos de venta: recibía el número,
// armaba el comprobante y llamaba a AFIP siempre. Los campos `emision` y
// `ambiente` existían y no los leía nadie.
//
// Un punto de venta MANUAL numera solo y no le informa nada a AFIP. Sirve para
// recorrer el circuito entero —remito, asiento, cuenta corriente, PDF— antes de
// tener los certificados y los puntos de venta reales dados de alta.
//
// El PDF sale sin CAE ni QR, que es lo correcto: un comprobante sin CAE no es
// fiscal, y hacerlo parecer uno sería peor que no tenerlo.
export function puntoDeVenta(database, ptoVta) {
  try {
    return database.prepare(`SELECT numero, nombre, emision, ambiente, es_prueba
      FROM sg_puntos_venta WHERE numero = ?`).get(Number(ptoVta)) || null;
  } catch (_) { return null; }
}
export function esManual(pv) {
  return !!pv && (pv.emision === 'manual' || pv.emision === 'preimpreso');
}

// El siguiente número de un punto de venta manual. Sale de lo que ya se emitió
// acá —no hay a quién preguntarle— y por eso arranca en 1.
export function proximoNumeroManual(database, ptoVta, cbteTipo) {
  const r = database.prepare(`SELECT MAX(cbte_nro) n FROM sg_ven_facturas
    WHERE punto_venta = ? AND cbte_tipo = ?`).get(Number(ptoVta), Number(cbteTipo));
  return (r && r.n ? Number(r.n) : 0) + 1;
}

function persistirReservada(database, { comprobante, ptoVta, cbteTipo, cbteNro, ambiente, fecha,
                                        userId, manual, esPrueba, descuentoGestion,
                                        ncDeFacturaId, ncMotivo }) {
  const tipoLetra = (cbteTipo === 1 || cbteTipo === 3) ? 'A' : 'B';
  // Identificador interno único (NO es el número fiscal: ese es PV + cbte_nro + CAE). Prefijo
  // ambiente-aware: AFIPH- en homologación (test), AFIP- en producción.
  // MANUAL- para que se distinga de un vistazo en cualquier listado: no salió de
  // AFIP y no tiene CAE.
  const prefijo = manual ? 'MANUAL-' : (ambiente === 'homologacion' ? 'AFIPH-' : 'AFIP-');
  const numero = prefijo + ptoVta + '-' + cbteTipo + '-' + cbteNro + '-' + Date.now().toString(36);
  let facturaId;
  database.transaction(() => {
    const info = database.prepare(`INSERT INTO sg_ven_facturas
      (numero, fecha, cliente_id, tipo, concepto, neto, iva, total, estado,
       punto_venta, cbte_tipo, cbte_nro, ambiente, afip_estado, notas, usuario_id, es_prueba,
       dif_gestion, dif_motivo)
      VALUES (?,?,?,?,?,?,?,?, 'pendiente', ?,?,?,?, 'reservado', ?, ?, ?, ?, ?)`).run(
      numero, fecha, comprobante.cliente.id, tipoLetra, 'Productos',
      comprobante.imp_neto, comprobante.imp_iva, comprobante.imp_total,
      ptoVta, cbteTipo, cbteNro, ambiente,
      manual ? 'Comprobante manual — no se informó a AFIP' : 'PRUEBA emisión homologación',
      userId || null, esPrueba ? 1 : 0,
      // LO RESIGNADO POR LOS ACUERDOS, guardado desde el primer momento y en LA
      // MISMA COLUMNA QUE TODO LO DEMÁS. Se escribe acá —y no después— porque
      // asentarVenta() lo lee de la factura: si llegara más tarde, el asiento ya
      // salió sin la parte de gestión.
      //
      // Va a dif_gestion, no a una columna propia: la cuenta corriente, lo
      // pendiente de cada comprobante y los controles miran dif_gestion. Una
      // segunda columna para lo mismo es una parte de gestión que existe en el
      // asiento y que la pantalla del saldo no ve.
      Math.round((Number(descuentoGestion) || 0) * 100) / 100,
      (Number(descuentoGestion) || 0) > 0 ? 'ajuste_gestion' : null);
    facturaId = info.lastInsertRowid;
    if (ncDeFacturaId) {
      database.prepare('UPDATE sg_ven_facturas SET nc_de_factura_id=?, nc_motivo=? WHERE id=?')
        .run(Number(ncDeFacturaId), ncMotivo || null, facturaId);
    }
    const insItem = database.prepare(`INSERT INTO sg_ven_factura_items
      (factura_id, descripcion, cantidad, precio_unitario, subtotal, producto_id, alicuota_id, bultos, kg_por_bulto, precio_por_bulto, unidad,
       despacho_item_id, nc_de_item_id, nc_modo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const d of comprobante.detalle) insItem.run(facturaId, d.descripcion, d.cantidad, d.precio_unitario, d.subtotal, d.producto_id, d.alicuota_id,
      d.bultos != null ? d.bultos : null, d.kg_por_bulto != null ? d.kg_por_bulto : null, d.precio_por_bulto != null ? d.precio_por_bulto : null, d.unidad || null,
      d.despacho_item_id != null ? d.despacho_item_id : null,
      d.nc_de_item_id != null ? d.nc_de_item_id : null,
      d.nc_modo || null);
  })();
  return facturaId;
}
// ¿Ese asiento sigue en pie? Un asiento anulado está en la base y NO está en el
// libro: para todo lo que viene después, es como si no existiera.
function asientoAnulado(database, asientoId) {
  if (!asientoId) return false;
  const a = database.prepare('SELECT anulado FROM sg_asientos WHERE id=?').get(asientoId);
  return !a || !!a.anulado;
}

// ══ LA VUELTA: UNA VENTA QUE PERDIÓ SU ASIENTO VUELVE AL LIBRO ═════════════
//
// Del lado de COMPRAS esto existía desde siempre («Facturas cargadas sin
// contabilizar», con su botón Contabilizar). Del lado de VENTAS no: una factura a
// la que le anularon el asiento quedaba en un callejón sin salida --el comprobante
// emitido con su CAE, los kilos del remito consumidos, y ninguna pantalla que
// rehiciera el asiento--. Pablo, 24/8/2026: "ahora no puedo volver a facturar esa
// partida ni reflotar el asiento".
//
// El asiento anulado NO se resucita: queda donde está, con su marca y su motivo,
// que es la prueba de qué decía. Se escribe uno NUEVO, con la fecha y los importes
// del mismo comprobante.
export function recontabilizarVenta(database, facturaId, userId) {
  // cbte_tipo va en el SELECT porque es lo ÚNICO que dice si esto era una nota de
  // crédito. Sin él, rehacer el asiento de una nota lo rehacía como el de una
  // factura: la deuda que la nota había bajado volvía a subir.
  const f = database.prepare(`SELECT id, cliente_id, neto, iva, total, fecha, numero,
      punto_venta, cbte_nro, cbte_tipo, estado, asiento_id,
      COALESCE(dif_gestion,0) AS dif_gestion, dif_motivo
    FROM sg_ven_facturas WHERE id=?`).get(facturaId);
  if (!f) throw new Error('El comprobante no existe');
  if (String(f.estado || '') === 'anulada') {
    throw new Error('El comprobante está anulado: un comprobante anulado no vuelve al libro');
  }
  if (f.asiento_id && !asientoAnulado(database, f.asiento_id)) {
    return { asiento_id: f.asiento_id, ya_estaba: true };
  }
  const nro = (f.punto_venta != null && f.cbte_nro != null)
    ? String(f.punto_venta).padStart(4, '0') + '-' + String(f.cbte_nro).padStart(8, '0')
    : String(f.numero || f.id);
  const arm = lineasAsientoVenta(database, {
    clienteId: f.cliente_id, neto: f.neto, iva: f.iva, total: f.total,
    descuento: f.dif_gestion, numero: nro, motivo: f.dif_motivo,
    // La nota de crédito se reconoce por el tipo de comprobante, que es lo único
    // que quedó guardado: 3 = NC A, 8 = NC B.
    esNC: esNotaDeCredito(f.cbte_tipo),
  });
  if (arm.falta.length) {
    throw new Error('No se puede contabilizar la venta: falta ' + arm.falta.join(' y ')
      + '. Se arregla en el asiento modelo de venta, en Contabilidad SG.');
  }
  const cli = database.prepare('SELECT razon_social r FROM sg_clientes WHERE id=?').get(f.cliente_id) || {};
  const id = database.transaction(() => {
    const asientoId = crearAsiento(database, {
      fecha: f.fecha || null, usuario_id: userId || null, ref_codigo: nro,
      descripcion: (esNotaDeCredito(f.cbte_tipo) ? 'Nota de crédito — ' : 'Venta — ')
                 + (cli.r || '') + ' — Comprobante ' + nro
                 + (f.asiento_id ? ' (rehecho: el anterior se anuló)' : ''),
    }, arm.lineas).id;
    database.prepare('UPDATE sg_ven_facturas SET asiento_id=? WHERE id=?').run(asientoId, f.id);
    return asientoId;
  })();
  return { asiento_id: id, ya_estaba: false };
}

function actualizarFactura(database, facturaId, campos) {
  const sets = [], vals = [];
  for (const k of Object.keys(campos)) { sets.push(`${k}=?`); vals.push(campos[k]); }
  if (!sets.length) return;
  vals.push(facturaId);
  database.prepare(`UPDATE sg_ven_facturas SET ${sets.join(',')} WHERE id=?`).run(...vals);
}

// Confirma una factura AUTORIZADA: marca el estado/CAE y escribe el puente factura↔despacho
// (sg_factura_despachos) en LA MISMA transacción. Atómico: una factura autorizada SIEMPRE queda
// con su puente; nunca queda autorizada sin él (lo que haría reaparecer los kg como pendientes →
// doble facturación). En rechazo NO se llama → no se escriben vínculos.
// ── LA VENTA ENTRA AL LIBRO ───────────────────────────────
//
// Se llama con la factura ya escrita y ANTES de darla por cerrada, para que el
// asiento entre en el mismo acto. Es la regla de oro de compras, del lado de
// ventas: una venta fuera del libro es plata que el cliente debe y que la
// contabilidad no sabe que existe.
//
// Si al modelo le falta algo, se corta y lo dice: no se guarda una venta a
// medias. Y si ya tiene asiento —un reintento— no se escribe dos veces.
function asentarVenta(database, facturaId, comprobante, ptoVta, cbteNro, userId) {
  const ya = database.prepare(`SELECT asiento_id, numero, fecha, dif_gestion, dif_motivo
    FROM sg_ven_facturas WHERE id=?`).get(facturaId);
  // TENER UN PUNTERO NO ES ESTAR EN EL LIBRO. Acá alcanzaba con que asiento_id
  // tuviera algo: si ese asiento estaba ANULADO, esta función devolvía su id y no
  // escribía nada. La venta quedaba fuera del libro para siempre y sin forma de
  // rehacerla, porque el único camino de vuelta pasa por acá.
  if (ya && ya.asiento_id && !asientoAnulado(database, ya.asiento_id)) return ya.asiento_id;
  const nro = String(ptoVta).padStart(4, '0') + '-' + String(cbteNro).padStart(8, '0');
  const arm = lineasAsientoVenta(database, {
    clienteId: comprobante.cliente.id,
    neto: comprobante.imp_neto, iva: comprobante.imp_iva, total: comprobante.imp_total,
    descuento: (ya && ya.dif_gestion) || 0, numero: nro, motivo: ya && ya.dif_motivo,
    esNC: esNotaDeCredito(comprobante.cbte_tipo),
  });
  if (arm.falta.length) {
    throw new Error('No se puede contabilizar la venta: falta ' + arm.falta.join(' y ')
      + '. Se arregla en el asiento modelo de venta, en Contabilidad SG.');
  }
  const cli = database.prepare('SELECT razon_social r FROM sg_clientes WHERE id=?')
    .get(comprobante.cliente.id) || {};
  const asientoId = crearAsiento(database, {
    // QUIÉN LO CARGÓ. Acá iba `null` escrito a mano, y en Asientos Contables las
    // ventas salían con un guión en "Cargado por" mientras todo lo demás decía el
    // nombre. Un asiento sin dueño es un asiento que nadie tiene que explicar.
    fecha: (ya && ya.fecha) || null, usuario_id: userId || null, ref_codigo: nro,
    descripcion: (esNotaDeCredito(comprobante.cbte_tipo) ? 'Nota de crédito — ' : 'Venta — ')
      + (cli.r || '') + ' — Comprobante ' + nro,
  }, arm.lineas).id;
  database.prepare('UPDATE sg_ven_facturas SET asiento_id=? WHERE id=?').run(asientoId, facturaId);
  return asientoId;
}

// ── UNA NOTA DE CRÉDITO DEVUELVE LOS KILOS ─────────────────────────────────
// El puente factura↔despacho es lo que dice qué kg de un remito ya tienen
// comprobante. Una nota de crédito escribe ahí igual, pero con los kg en
// NEGATIVO: lo que hace es sacarle el comprobante a esa mercadería, que vuelve a
// figurar "entregada sin documentar" y se puede volver a facturar.
//
// Si entrara en positivo como una factura, la nota TAPARÍA el remito: los kilos
// contarían dos veces como documentados y la partida quedaría trabada para
// siempre — devuelta y sin poder volver a salir.
function confirmarAutorizada(database, facturaId, campos, vinculos, esNC) {
  database.transaction(() => {
    actualizarFactura(database, facturaId, campos);
    const sg = esNC ? -1 : 1;
    if (Array.isArray(vinculos) && vinculos.length) {
      const ins = database.prepare(`INSERT INTO sg_factura_despachos
        (factura_id, despacho_id, despacho_item_id, kg, neto, iva, gestion)
        VALUES (?,?,?,?,?,?,?)`);
      for (const v of vinculos) {
        if (!v || v.despacho_id == null) continue;
        ins.run(facturaId, Number(v.despacho_id),
          v.despacho_item_id != null ? Number(v.despacho_item_id) : null,
          v.kg != null ? sg * Math.abs(Number(v.kg)) : null,
          // Los pesos de ESE renglón, tal como fueron al comprobante.
          v.neto != null ? sg * Math.abs(Number(v.neto)) : null,
          v.iva != null ? sg * Math.abs(Number(v.iva)) : null,
          v.gestion != null ? sg * Math.abs(Number(v.gestion)) : null);
      }
    }
  })();
}

// Emite un comprobante: reserva número (lock PV+tipo) → persiste 'reservado' → FECAESolicitar →
// A: guarda cae/cae_vto/autorizado + puente factura↔despacho (atómico) · R: guarda obs/rechazado
// (sin puente) · timeout: FECompConsultar. vinculos (opcional): [{despacho_id, despacho_item_id, kg}].
export async function emitir(database, { ptoVta, clienteId, items, esNC, userId, vinculos,
                                         descuentoGestion, identificacion, asociado,
                                         ncDeFacturaId, ncMotivo }) {
  const comprobante = construirComprobante(database, { clienteId, items, esNC, identificacion, asociado });
  const cbteTipo = comprobante.cbte_tipo;

  // ── EL CORTE: UN PUNTO DE VENTA MANUAL NO LLAMA A AFIP ─────────────────
  //
  // Va ANTES de todo lo demás. Si estuviera después de pedir el último número
  // autorizado, ya habría una llamada hecha — y el punto de todo esto es que no
  // haya ninguna.
  //
  // El comprobante sale sin CAE, que es lo correcto: uno sin CAE no es fiscal, y
  // hacerlo parecer uno sería peor que no tenerlo.
  const pv = puntoDeVenta(database, ptoVta);
  if (esManual(pv)) {
    return serializar(ptoVta + ':' + cbteTipo, async () => {
      const fecha = fechaHoyAR();
      const cbteNro = proximoNumeroManual(database, ptoVta, cbteTipo);
      const facturaId = persistirReservada(database, { comprobante, ptoVta, cbteTipo,
        cbteNro, ambiente: 'manual', fecha, userId, manual: true,
        descuentoGestion, esPrueba: !!(pv && pv.es_prueba), ncDeFacturaId, ncMotivo });
      // La MISMA función que el camino de AFIP: cierra la factura y ata los
      // despachos en una sola transacción. Escribir eso de nuevo acá sería dos
      // maneras de hacer lo mismo, y una de las dos se olvidaría de algo.
      asentarVenta(database, facturaId, comprobante, ptoVta, cbteNro, userId);
      confirmarAutorizada(database, facturaId, {
        // NO se toca `estado`: queda en 'pendiente', que es lo que significa —
        // el comprobante está emitido y todavía no se cobró. Es lo mismo que
        // hace el camino de AFIP, que sólo escribe afip_estado. Poner 'emitida'
        // rompía el CHECK de la tabla, que sólo admite pendiente/cobrada/anulada.
        afip_estado: 'MANUAL — sin AFIP',
      }, vinculos, !!esNC);
      return { ok: true, factura_id: facturaId, pto_vta: Number(ptoVta),
        cbte_tipo: cbteTipo, cbte_nro: cbteNro, cae: null, cae_vto: null,
        manual: true, es_prueba: !!(pv && pv.es_prueba),
        aviso: 'Comprobante MANUAL: no se le informó nada a AFIP y no tiene CAE.' };
    });
  }

  return serializar(ptoVta + ':' + cbteTipo, async () => {
    const ambiente = ambienteActual();
    const fecha = fechaHoyAR();
    const ult = await ultimoComprobante(ptoVta, cbteTipo);     // FECompUltimoAutorizado
    const cbteNro = (Number(ult.ultimo_nro) || 0) + 1;
    const facturaId = persistirReservada(database, { comprobante, ptoVta, cbteTipo, cbteNro,
      ambiente, fecha, userId, descuentoGestion, ncDeFacturaId, ncMotivo });

    let resp;
    try {
      const auth = await authXml();
      const text = await soapCall('FECAESolicitar', xmlFECAESolicitar(auth, { ptoVta, cbteTipo, cbteNro, comprobante, fecha }));
      resp = parseFECAEResponse(text);
    } catch (e) {
      // timeout/red: reconsultar el número (no pedir uno nuevo). Si AFIP ya lo tiene → autorizado.
      let cons = null;
      try { cons = await consultarComprobante(ptoVta, cbteTipo, cbteNro); } catch (_) { /* ignora */ }
      if (cons && cons.cae) {
        resp = { resultado: 'A', cae: cons.cae, cae_vto: cons.cae_vto, obs: 'recuperado por FECompConsultar tras timeout' };
      } else {
        actualizarFactura(database, facturaId, { afip_estado: 'reservado', afip_obs: 'timeout/red: ' + e.message });
        throw new Error('Emisión sin confirmar (número ' + cbteNro + ' reservado, reconsultar). ' + e.message);
      }
    }

    if (resp.resultado === 'A' && resp.cae) {
      // Atómico: estado autorizado + CAE + puente factura↔despacho en una sola transacción.
      // La venta autorizada entra al libro en el mismo acto.
      asentarVenta(database, facturaId, comprobante, ptoVta, cbteNro, userId);
      confirmarAutorizada(database, facturaId,
        { cae: resp.cae, cae_vto: resp.cae_vto, afip_resultado: 'A', afip_estado: 'autorizado', afip_obs: resp.obs },
        vinculos, !!esNC);
      return { ok: true, factura_id: facturaId, ambiente, pto_vta: ptoVta, cbte_tipo: cbteTipo, cbte_nro: cbteNro, cae: resp.cae, cae_vto: resp.cae_vto, imp_total: comprobante.imp_total, vinculos: Array.isArray(vinculos) ? vinculos.length : 0 };
    }
    actualizarFactura(database, facturaId, { afip_resultado: resp.resultado || 'R', afip_estado: 'rechazado', afip_obs: resp.obs });
    return { ok: false, factura_id: facturaId, ambiente, pto_vta: ptoVta, cbte_tipo: cbteTipo, cbte_nro: cbteNro, resultado: resp.resultado || 'R', obs: resp.obs };
  });
}
