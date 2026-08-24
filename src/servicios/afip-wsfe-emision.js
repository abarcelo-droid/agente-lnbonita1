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
import { lineasAsientoVenta } from './asiento-venta.js';
import { crearAsiento } from './asientos.js';

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
// Alícuota de IVA (% de la familia) → Id de AFIP. 0%=3, 10.5%=4, 21%=5, 27%=6, 5%=8, 2.5%=9.
const IVA_PCT_A_ID = { 0: 3, 10.5: 4, 21: 5, 27: 6, 5: 8, 2.5: 9 };
function alicuotaId(pct) {
  if (pct == null || pct === '') return null;       // sin alícuota → exento (ImpOpEx)
  const p = Number(pct);
  return Object.prototype.hasOwnProperty.call(IVA_PCT_A_ID, p) ? IVA_PCT_A_ID[p] : undefined; // undefined = no soportada
}
// Tipo de comprobante: con CUIT → Factura A (1) / NC A (3); sin CUIT → Factura B (6) / NC B (8).
function tipoComprobante(cliente, esNC) {
  const cuit = cliente && cliente.cuit ? String(cliente.cuit).replace(/\D/g, '') : '';
  const tieneCuit = /^\d{11}$/.test(cuit) && !/^0+$/.test(cuit);
  if (tieneCuit) return esNC ? 3 : 1;
  return esNC ? 8 : 6;
}
// DocTipo/DocNro: A/NC A → CUIT (80). B/NC B → CUIT si lo hay (80), si no consumidor final (99, 0).
function docDe(cliente, cbteTipo) {
  const cuit = cliente && cliente.cuit ? String(cliente.cuit).replace(/\D/g, '') : '';
  const cuitOk = /^\d{11}$/.test(cuit) && !/^0+$/.test(cuit);
  if (cbteTipo === 1 || cbteTipo === 3) return { doc_tipo: 80, doc_nro: cuit };
  return cuitOk ? { doc_tipo: 80, doc_nro: cuit } : { doc_tipo: 99, doc_nro: '0' };
}
// Condición frente al IVA del receptor (RG 5616, obligatorio desde 2025). Códigos AFIP —
// verificables en vivo con FEParamGetCondicionIvaReceptor (GET /api/sg/afip/condiciones-iva):
//   1=IVA Responsable Inscripto · 4=IVA Sujeto Exento · 5=Consumidor Final · 6=Responsable Monotributo.
const CONDICION_IVA = { responsable_inscripto: 1, sujeto_exento: 4, consumidor_final: 5, monotributo: 6 };
// Por ahora (brief): sin CUIT → Consumidor Final (5); con CUIT → Responsable Inscripto (1) por
// defecto. La afinación por categoría fiscal real del cliente queda para más adelante (y debe ir
// alineada con el tipo de comprobante: A exige receptor RI/Monotributo).
function condicionIvaReceptorId(cliente) {
  const cuit = cliente && cliente.cuit ? String(cliente.cuit).replace(/\D/g, '') : '';
  const cuitOk = /^\d{11}$/.test(cuit) && !/^0+$/.test(cuit);
  return cuitOk ? CONDICION_IVA.responsable_inscripto : CONDICION_IVA.consumidor_final;
}
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function fechaHoyAR() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }

// Construye el comprobante (totales + array Iva) desde cliente + ítems. El IVA sale de
// producto → familia → sg_familias.iva_alicuota (misma alícuota que compra). Exento → ImpOpEx.
export function construirComprobante(database, { clienteId, items, esNC }) {
  const cliente = database.prepare('SELECT id, razon_social, cuit, categoria_fiscal FROM sg_clientes WHERE id=?').get(clienteId);
  if (!cliente) throw new Error('Cliente inexistente: ' + clienteId);
  const cbteTipo = tipoComprobante(cliente, esNC);
  const { doc_tipo, doc_nro } = docDe(cliente, cbteTipo);
  const ivaMap = {};
  let impNeto = 0, impIva = 0, impOpEx = 0;
  const detalle = [];
  for (const it of (items || [])) {
    const prod = database.prepare(`SELECT p.id, p.nombre, p.familia_id, f.iva_alicuota
      FROM sg_productos p LEFT JOIN sg_familias f ON f.id=p.familia_id WHERE p.id=?`).get(it.producto_id);
    if (!prod) throw new Error('Producto inexistente: ' + it.producto_id);
    const cant = Number(it.cantidad) || 0, precio = Number(it.precio) || 0;
    if (!(cant > 0)) throw new Error('Cantidad inválida en ' + (prod.nombre || it.producto_id));
    const neto = r2(cant * precio);                    // precio = unitario NETO (sin IVA)
    // F5 — metadata de presentación por bulto (cajón). NO interviene en el cálculo de importes:
    // el subtotal sigue siendo neto = cant(kg) × precio(kg). Solo viaja al detalle local para el PDF.
    const bultoMeta = {
      bultos:           it.bultos != null ? it.bultos : null,
      kg_por_bulto:     it.kg_por_bulto != null ? it.kg_por_bulto : null,
      precio_por_bulto: it.precio_por_bulto != null ? it.precio_por_bulto : null,
      unidad:           it.unidad || null
    };
    const id = alicuotaId(prod.iva_alicuota);
    if (id === undefined) throw new Error('Alícuota de IVA no soportada para ' + prod.nombre + ': ' + prod.iva_alicuota + '%');
    if (id === null) {                                  // exento → ImpOpEx
      impOpEx = r2(impOpEx + neto);
      detalle.push({ producto_id: prod.id, descripcion: prod.nombre, cantidad: cant, precio_unitario: precio, subtotal: neto, alicuota_id: null, ...bultoMeta });
    } else {
      const iva = r2(neto * Number(prod.iva_alicuota) / 100);
      impNeto = r2(impNeto + neto); impIva = r2(impIva + iva);
      if (!ivaMap[id]) ivaMap[id] = { base: 0, importe: 0 };
      ivaMap[id].base = r2(ivaMap[id].base + neto);
      ivaMap[id].importe = r2(ivaMap[id].importe + iva);
      detalle.push({ producto_id: prod.id, descripcion: prod.nombre, cantidad: cant, precio_unitario: precio, subtotal: neto, alicuota_id: id, ...bultoMeta });
    }
  }
  if (!detalle.length) throw new Error('El comprobante necesita al menos un ítem');
  const impTotal = r2(impNeto + impIva + impOpEx);
  const iva = Object.keys(ivaMap).map(id => ({ Id: Number(id), BaseImp: ivaMap[id].base, Importe: ivaMap[id].importe }));
  return { cliente, cbte_tipo: cbteTipo, doc_tipo, doc_nro, cond_iva_receptor: condicionIvaReceptorId(cliente),
    imp_neto: impNeto, imp_iva: impIva, imp_opex: impOpEx, imp_total: impTotal, iva, detalle, concepto: 1 };
}

// XML interno de FECAESolicitar (un comprobante). 'auth' = bloque <ar:Auth>.
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
                                        userId, manual, esPrueba, descuentoGestion }) {
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
    const insItem = database.prepare(`INSERT INTO sg_ven_factura_items
      (factura_id, descripcion, cantidad, precio_unitario, subtotal, producto_id, alicuota_id, bultos, kg_por_bulto, precio_por_bulto, unidad)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const d of comprobante.detalle) insItem.run(facturaId, d.descripcion, d.cantidad, d.precio_unitario, d.subtotal, d.producto_id, d.alicuota_id,
      d.bultos != null ? d.bultos : null, d.kg_por_bulto != null ? d.kg_por_bulto : null, d.precio_por_bulto != null ? d.precio_por_bulto : null, d.unidad || null);
  })();
  return facturaId;
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
  const ya = database.prepare('SELECT asiento_id, numero, fecha, dif_gestion FROM sg_ven_facturas WHERE id=?').get(facturaId);
  if (ya && ya.asiento_id) return ya.asiento_id;
  const nro = String(ptoVta).padStart(4, '0') + '-' + String(cbteNro).padStart(8, '0');
  const arm = lineasAsientoVenta(database, {
    clienteId: comprobante.cliente.id,
    neto: comprobante.imp_neto, iva: comprobante.imp_iva, total: comprobante.imp_total,
    descuento: (ya && ya.dif_gestion) || 0, numero: nro,
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
    descripcion: 'Venta — ' + (cli.r || '') + ' — Comprobante ' + nro,
  }, arm.lineas).id;
  database.prepare('UPDATE sg_ven_facturas SET asiento_id=? WHERE id=?').run(asientoId, facturaId);
  return asientoId;
}

function confirmarAutorizada(database, facturaId, campos, vinculos) {
  database.transaction(() => {
    actualizarFactura(database, facturaId, campos);
    if (Array.isArray(vinculos) && vinculos.length) {
      const ins = database.prepare(`INSERT INTO sg_factura_despachos
        (factura_id, despacho_id, despacho_item_id, kg, neto, iva, gestion)
        VALUES (?,?,?,?,?,?,?)`);
      for (const v of vinculos) {
        if (!v || v.despacho_id == null) continue;
        ins.run(facturaId, Number(v.despacho_id),
          v.despacho_item_id != null ? Number(v.despacho_item_id) : null,
          v.kg != null ? Number(v.kg) : null,
          // Los pesos de ESE renglón, tal como fueron al comprobante.
          v.neto != null ? Number(v.neto) : null,
          v.iva != null ? Number(v.iva) : null,
          v.gestion != null ? Number(v.gestion) : null);
      }
    }
  })();
}

// Emite un comprobante: reserva número (lock PV+tipo) → persiste 'reservado' → FECAESolicitar →
// A: guarda cae/cae_vto/autorizado + puente factura↔despacho (atómico) · R: guarda obs/rechazado
// (sin puente) · timeout: FECompConsultar. vinculos (opcional): [{despacho_id, despacho_item_id, kg}].
export async function emitir(database, { ptoVta, clienteId, items, esNC, userId, vinculos,
                                         descuentoGestion }) {
  const comprobante = construirComprobante(database, { clienteId, items, esNC });
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
        descuentoGestion, esPrueba: !!(pv && pv.es_prueba) });
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
      }, vinculos);
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
      ambiente, fecha, userId, descuentoGestion });

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
        vinculos);
      return { ok: true, factura_id: facturaId, ambiente, pto_vta: ptoVta, cbte_tipo: cbteTipo, cbte_nro: cbteNro, cae: resp.cae, cae_vto: resp.cae_vto, imp_total: comprobante.imp_total, vinculos: Array.isArray(vinculos) ? vinculos.length : 0 };
    }
    actualizarFactura(database, facturaId, { afip_resultado: resp.resultado || 'R', afip_estado: 'rechazado', afip_obs: resp.obs });
    return { ok: false, factura_id: facturaId, ambiente, pto_vta: ptoVta, cbte_tipo: cbteTipo, cbte_nro: cbteNro, resultado: resp.resultado || 'R', obs: resp.obs };
  });
}
