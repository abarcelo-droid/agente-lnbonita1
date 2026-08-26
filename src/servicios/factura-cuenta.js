// src/servicios/factura-cuenta.js
//
// QUÉ FACTURA CUENTA COMO COMPROBANTE DE LO ENTREGADO — UNA SOLA DEFINICIÓN.
//
// Había tres copias de la misma lista escritas a mano:
//
//     f.afip_estado IN ('reservado','autorizado')
//
// El día que apareció un cuarto estado —'MANUAL — sin AFIP', el comprobante de
// un punto de venta que no llama a AFIP— las tres quedaron viejas, y ninguna
// avisó. Lo que pasó con eso:
//
//   · LA MERCADERÍA SE CONTÓ DOS VECES. La factura existía, pero para la cuenta
//     corriente esos kg seguían "entregados sin comprobante". El cliente
//     figuraba debiendo el doble: $50.000 documentados + $50.000 sin
//     comprobante = $100.000 por una venta de $50.000.
//
//   · Y SE PODÍA FACTURAR DOS VECES LO MISMO. El control que dice "de este
//     remito quedan N kg pendientes" usaba la misma lista: como el comprobante
//     manual no contaba, los kg volvían a aparecer disponibles y nada frenaba
//     una segunda factura por la misma mercadería.
//
// La regla de verdad no es una lista de estados buenos: es que **una factura
// cuenta salvo que se haya caído**. Se cae de dos maneras y sólo de dos —AFIP la
// rechazó, o alguien la anuló—. Escrita así, un estado nuevo entra contando, que
// es lo correcto: un comprobante que existe es un comprobante.
//
// El test `test/factura_cuenta_una_vez.test.mjs` --corre con `npm test`-- falla
// si vuelve a aparecer una lista de estados escrita a mano.

// Fragmento SQL. `a` es el alias de sg_ven_facturas en la consulta que lo use.
export const facturaCuenta = (a = 'f') =>
  `(COALESCE(${a}.afip_estado,'') <> 'rechazado' AND COALESCE(${a}.estado,'') <> 'anulada')`;

// ══ UNA NOTA DE CRÉDITO RESTA ═══════════════════════════════════════════════
//
// Un comprobante con CAE no se anula: se le hace una NOTA DE CRÉDITO. La nota va a
// la misma tabla que la factura y con los importes en POSITIVO, porque eso es lo
// que dice el papel y es lo que se le informó a ARCA.
//
// Pero para la deuda del cliente vale al revés: la factura le suma y la nota le
// resta. Escrito en un solo lugar por la misma razón que facturaCuenta: la regla
// repetida a mano en diez consultas queda vieja en nueve.
//
// 3 = Nota de Crédito A, 8 = Nota de Crédito B (ARCA).
export function esNotaDeCredito(cbteTipo) {
  return Number(cbteTipo) === 3 || Number(cbteTipo) === 8;
}

// ══ Y LA NOTA DE DÉBITO VA PARA EL OTRO LADO ═══════════════════════════════
// 2 = ND A, 7 = ND B. Le COBRA más al cliente: suma a su deuda, suma débito fiscal y
// su asiento es el de una factura. Por eso NO entra en esNotaDeCredito ni cambia el
// signo — lo único que hay que cuidar es que no se la confunda con una nota de
// crédito en las cuentas que miran el PUNTERO a la factura corregida.
export function esNotaDeDebito(cbteTipo) {
  return Number(cbteTipo) === 2 || Number(cbteTipo) === 7;
}
// Qué comprobantes son «notas» de cualquier tipo: cuelgan de otro y no se emiten solas.
export const ES_NOTA = (a = 'f') => `COALESCE(${a}.cbte_tipo,0) IN (2,3,7,8)`;
// Sólo las de CRÉDITO, que son las que descuentan. Se usa donde el filtro es por el
// puntero `nc_de_factura_id`, que las dos clases comparten.
export const ES_NOTA_CREDITO = (a = 'f') => `COALESCE(${a}.cbte_tipo,0) IN (3,8)`;

// El signo con que un comprobante entra a la cuenta corriente. `a` es el alias.
export const signoFactura = (a = 'f') =>
  `(CASE WHEN COALESCE(${a}.cbte_tipo,0) IN (3,8) THEN -1 ELSE 1 END)`;

// Lo que ese comprobante mueve en la deuda: total + lo de gestión, con su signo.
// (`saldo_pagado` no lleva signo: es plata que efectivamente se imputó.)
export const deudaFactura = (a = 'f') =>
  `(${signoFactura(a)} * (COALESCE(${a}.total,0) + COALESCE(${a}.dif_gestion,0)))`;
export const deudaGestionFactura = (a = 'f') =>
  `(${signoFactura(a)} * COALESCE(${a}.dif_gestion,0))`;

// Lo que las notas de crédito de ESA factura ya le sacaron. Sirve para lo pendiente
// de cada comprobante: si no se restara acá, una factura acreditada entera seguiría
// ofreciéndose para cobrar y el cobrador le reclamaría al cliente algo que ya se le
// devolvió. (En el saldo total no hace falta: ahí la nota resta por su propia fila.)
// OJO: filtran por el PUNTERO, que la nota de crédito y la de DÉBITO comparten. Sin
// el filtro por tipo, una nota de débito de $50.000 colgada de esta factura contaría
// como «ya acreditado»: cobrarle MÁS al cliente le bajaría la deuda, apagaría el botón
// de acreditar y frenaría la nota de crédito de verdad con «ya está acreditado entero».
export const ncAplicadas = (a = 'f') =>
  `COALESCE((SELECT SUM(COALESCE(n.total,0) + COALESCE(n.dif_gestion,0))
      FROM sg_ven_facturas n
     WHERE n.nc_de_factura_id = ${a}.id AND ${facturaCuenta('n')}
       AND ${ES_NOTA_CREDITO('n')}),0)`;
export const ncAplicadasFiscal = (a = 'f') =>
  `COALESCE((SELECT SUM(COALESCE(n.total,0))
      FROM sg_ven_facturas n
     WHERE n.nc_de_factura_id = ${a}.id AND ${facturaCuenta('n')}
       AND ${ES_NOTA_CREDITO('n')}),0)`;
export const ncAplicadasGestion = (a = 'f') =>
  `COALESCE((SELECT SUM(COALESCE(n.dif_gestion,0))
      FROM sg_ven_facturas n
     WHERE n.nc_de_factura_id = ${a}.id AND ${facturaCuenta('n')}
       AND ${ES_NOTA_CREDITO('n')}),0)`;
// Y una nota de crédito NO es algo para cobrar: no se ofrece en la lista de
// comprobantes a imputar. Lo que hace es bajar lo pendiente de la factura que corrige.
// La de DÉBITO sí: es plata que el cliente debe y hay que ir a cobrarle.
export const noEsNotaDeCredito = (a = 'f') => `COALESCE(${a}.cbte_tipo,0) NOT IN (3,8)`;
