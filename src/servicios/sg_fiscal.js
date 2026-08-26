// src/servicios/sg_fiscal.js
//
// ══ QUÉ COMPROBANTE LE CORRESPONDE A ESTE CLIENTE ══════════════════════
//
// Pablo, 25/8/2026, mirando la ficha de un cliente: "me imagino que de aquí decidís
// si le hacemos factura A o B". No: hasta hoy la letra salía SÓLO de si el cliente
// tenía un CUIT cargado. Con CUIT → Factura A. Sin CUIT → Factura B. La categoría
// fiscal, que está en la ficha desde siempre, no se miraba al emitir.
//
// Consecuencia: a un MONOTRIBUTISTA con CUIT se le emitía una Factura A y se lo
// informaba a AFIP como Responsable Inscripto. Las dos cosas mal, en cada venta.
//
// LA LETRA NO ES UNA PREFERENCIA COMERCIAL. Un emisor Responsable Inscripto le debe
// una A a otro Responsable Inscripto y una B a todos los demás. No hay margen de
// decisión, así que el campo "tipo fiscal habitual" del cliente NO gana nunca: si
// dice factura_a y la categoría dice monotributista, la ficha está mal cargada — no
// hay un empate que resolver.
//
// ESTE MÓDULO ES PURO A PROPÓSITO: no importa la base ni consulta nada, recibe el
// cliente ya leído. Así se puede probar sin levantar el servidor (no hay
// node_modules) y así una regla fiscal se puede leer entera en un archivo.

// El CUIT, con dígito verificador. Es la CUARTA copia de esta cuenta en el repo
// (sg_ventas.js, ventas.js, bcra.js y panel.html): ésta es la que puede importarse.
export function cuitValido(cuit) {
  const limpio = String(cuit == null ? '' : cuit).replace(/[-\s.]/g, '');
  if (!/^\d{11}$/.test(limpio) || /^0+$/.test(limpio)) return false;
  const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = mult.reduce((s, m, i) => s + parseInt(limpio[i], 10) * m, 0);
  const resto = suma % 11;
  const dv = resto === 0 ? 0 : (resto === 1 ? 9 : 11 - resto);
  return dv === parseInt(limpio[10], 10);
}
export const cuitLimpio = (c) => String(c == null ? '' : c).replace(/[-\s.]/g, '');

// ── LA TABLA ────────────────────────────────────────────────────────────
// `cond` son los códigos de AFIP de "condición del receptor frente al IVA"
// (RG 5616, obligatorio desde 2025), los mismos que ya estaban mapeados en
// afip-wsfe-emision.js y que se pueden verificar en vivo contra
// FEParamGetCondicionIvaReceptor.
export const REGLA_FISCAL = {
  resp_inscripto: { letra: 'A', cond: 1, label: 'IVA Responsable Inscripto', exigeCuit: true },
  monotributista: { letra: 'B', cond: 6, label: 'Responsable Monotributo', exigeCuit: true },
  // El exento TAMBIÉN exige CUIT. Informarle a AFIP "Sujeto Exento" y a la vez
  // "consumidor final sin identificar" es una contradicción que el comprobante puede
  // rebotar — y rebota DESPUÉS de haber pedido el número, así que quema una
  // numeración. Un exento es una entidad y siempre tiene CUIT: sin él, el dato está
  // mal cargado.
  exento:         { letra: 'B', cond: 4, label: 'IVA Sujeto Exento', exigeCuit: true },
  no_inscripto:   { letra: 'B', cond: 5, label: 'Consumidor Final', exigeCuit: false },
};
// Tipos de comprobante de AFIP. NC = nota de crédito.
const CBTE = { A: { factura: 1, nc: 3 }, B: { factura: 6, nc: 8 } };
// Tipos de documento de AFIP: 80 = CUIT, 99 = consumidor final sin identificar.
const DOC_CUIT = 80, DOC_SIN_IDENTIFICAR = 99;

// ── LA DECISIÓN ─────────────────────────────────────────────────────────
// Devuelve { ok, error } o el comprobante que corresponde. Nunca adivina: cuando el
// dato falta y la respuesta depende de él, FRENA — un comprobante fiscal mal emitido
// no se arregla después sin una nota de crédito.
export function fiscalDeCliente(cliente, { esNC = false } = {}) {
  const nombre = (cliente && cliente.razon_social) || 'El cliente';
  const cat = String((cliente && cliente.categoria_fiscal) || '').trim();
  const cuit = cuitLimpio(cliente && cliente.cuit);
  const tieneAlgoDeCuit = cuit.length > 0 && !/^0+$/.test(cuit);
  const cuitOk = cuitValido(cuit);

  // UN CUIT ROTO NO ES "SIN CUIT". Caer a Consumidor Final taparía el error de
  // carga y el comprobante saldría a nombre de nadie.
  if (tieneAlgoDeCuit && !cuitOk) {
    return { ok: false, error: `El CUIT de "${nombre}" no es válido (${cuit}). `
      + `Corregilo en Maestros → Clientes: con un CUIT roto el comprobante sale a nombre de nadie.` };
  }

  // SIN CATEGORÍA Y SIN CUIT NO HAY NADA QUE DECIDIR: sin CUIT no puede ser
  // Responsable Inscripto, así que es consumidor final. No se frena una venta de
  // mostrador por un dato que no cambia el resultado.
  if (!cat) {
    if (!cuitOk) {
      const r = REGLA_FISCAL.no_inscripto;
      return armar(r, esNC, null);
    }
    // CON CUIT Y SIN CATEGORÍA SÍ SE FRENA: puede ser Responsable Inscripto o
    // monotributista, y de eso depende la letra. Es el caso del bug — hoy sale A.
    return { ok: false, error: `"${nombre}" tiene CUIT pero no tiene categoría fiscal cargada, `
      + `y de eso depende si le corresponde Factura A o B. Cargala en Maestros → Clientes.` };
  }

  const r = REGLA_FISCAL[cat];
  if (!r) {
    return { ok: false, error: `Categoría fiscal desconocida en "${nombre}": "${cat}". `
      + `Las que el sistema sabe emitir son: ${Object.keys(REGLA_FISCAL).join(', ')}.` };
  }
  if (r.exigeCuit && !cuitOk) {
    return { ok: false, error: `"${nombre}" figura como ${r.label} y no tiene un CUIT válido cargado. `
      + `Un ${r.label} sin CUIT no existe: cargalo en Maestros → Clientes.` };
  }
  return armar(r, esNC, cuitOk ? cuit : null);
}

function armar(r, esNC, cuit) {
  return {
    ok: true,
    letra: r.letra,
    cbte_tipo: esNC ? CBTE[r.letra].nc : CBTE[r.letra].factura,
    cond_iva: r.cond,
    cond_iva_label: r.label,
    // El documento: CUIT si lo hay; si no, consumidor final sin identificar.
    // (El umbral de RG 5700/2025 —identificar al consumidor final desde $10.000.000—
    // es otra decisión y va con la venta de ventanilla, no acá.)
    doc_tipo: cuit ? DOC_CUIT : DOC_SIN_IDENTIFICAR,
    doc_nro: cuit || '0',
  };
}

// ¿Este comprobante discrimina el IVA en el papel? Sólo la A. Una Factura B lleva el
// impuesto ADENTRO del precio y no lo muestra: es la RG 1415. Lo usa el PDF.
export function discriminaIva(cbteTipo) {
  return Number(cbteTipo) === CBTE.A.factura || Number(cbteTipo) === CBTE.A.nc;
}
