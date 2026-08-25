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
