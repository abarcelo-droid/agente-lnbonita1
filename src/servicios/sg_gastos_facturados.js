// ══ LOS GASTOS DE TERCEROS QUE SE LE DESCUENTAN AL PRODUCTOR ══════════════
//
// Pablo, 8/9/2026: «Solamente en los casos en que la partida se liquide, y el
// flete o la descarga figuren en los conceptos que restan a la liquidación... Para
// que las declaraciones juradas estén OK, necesitamos que en el documento que
// imprimamos figuren los datos fiscales de la factura que estamos descontando. Si
// al proveedor A le vamos a liquidar una partida y por esa partida pagamos
// descargas y fletes de los proveedores B y C, es MANDATORIO que figuren los datos
// de las facturas de B y C».
//
// Y las dos decisiones que cerraron el diseño, del mismo día:
//
//   · «En principio hay que FRENARLA. Sin la factura no podemos liquidar. Es el
//      filtro para contabilizar la factura.» — o sea: que trabe el circuito del
//      día es el OBJETIVO, no un efecto colateral. Es lo que fuerza a que la
//      factura del fletero y la de la cuadrilla se carguen.
//
//   · «Hay que mostrar CUIT, Razón Social, número de factura y el TOTAL de esa
//      factura, no importa que solamente estemos descontando una parte.» — no se
//      prorratea: lo que la DDJJ necesita es IDENTIFICAR el comprobante, y el
//      comprobante vale lo que dice.
//
// Por qué: descontarle a A el costo que se le pagó a B es, impositivamente,
// trasladarle un comprobante de un tercero. Sin identificarlo en el papel, la
// liquidación no respalda la deducción.

// Los dos tipos de gasto que se le descuentan al productor en la liquidación.
// La comisión y los gastos administrativos son NUESTROS: no tienen comprobante de
// tercero detrás y por eso no entran acá.
export const TIPOS_DESCONTABLES = ['flete_entrada', 'descarga_ingreso'];

const ROTULO = { flete_entrada: 'Flete', descarga_ingreso: 'Descarga' };

// El criterio de «ya tiene factura» es EL MISMO que usa /gastos-facturables para
// decidir qué ofrecer: si fueran dos, la pantalla de facturas diría que una
// operación está pendiente y la liquidación la daría por cubierta.
const SIN_FACTURA = `NOT EXISTS (SELECT 1 FROM sg_factura_gasto_items fi
    JOIN sg_facturas_gasto f ON f.id = fi.factura_id AND f.activo = 1
   WHERE fi.gasto_id = g.id)`;

// Cada gasto de la partida con su comprobante, o sin él. Una fila por gasto: una
// misma factura puede cubrir varios viajes de la misma partida, y el papel se cita
// una vez por cada concepto que respalda.
export function gastosDescontables(db, ocId) {
  return db.prepare(`
    SELECT g.id, g.tipo_gasto, g.monto, g.estado, g.fecha_servicio,
           pv.razon_social AS prestador,
           f.id            AS factura_id,
           f.tipo_comprobante, f.punto_venta, f.numero, f.fecha_emision,
           f.cuit_emisor, f.neto AS factura_neto, f.iva_monto AS factura_iva,
           f.total AS factura_total,
           -- La razón social del EMISOR sale del padrón; el CUIT, del comprobante,
           -- porque es el que se leyó del papel y es el que va a la declaración.
           fp.razon_social AS emisor, fp.cuit AS emisor_cuit
      FROM sg_gastos_directos g
      JOIN sg_recepciones r ON r.id = g.recepcion_id AND r.activo = 1
      LEFT JOIN sg_proveedores pv ON pv.id = g.proveedor_servicio_id
      LEFT JOIN sg_factura_gasto_items fi ON fi.gasto_id = g.id
      LEFT JOIN sg_facturas_gasto f ON f.id = fi.factura_id AND f.activo = 1
      LEFT JOIN sg_proveedores fp ON fp.id = f.proveedor_servicio_id
     WHERE r.oc_id = ?
       AND g.tipo_gasto IN (${TIPOS_DESCONTABLES.map(() => '?').join(',')})
       AND g.activo = 1 AND g.estado <> 'anulado'
     ORDER BY g.tipo_gasto, g.id`).all(Number(ocId), ...TIPOS_DESCONTABLES);
}

// Cuántos gastos de la partida están valorizados y todavía no tienen comprobante.
// Se cuenta por TIPO para poder nombrarlo: «el flete» y «la descarga» se resuelven
// en pantallas distintas, y decir «hay un gasto sin factura» manda a buscar a
// ciegas.
export function gastosSinFactura(db, ocId) {
  const f = db.prepare(`
    SELECT
      SUM(CASE WHEN g.tipo_gasto='descarga_ingreso' THEN 1 ELSE 0 END) AS descarga,
      SUM(CASE WHEN g.tipo_gasto='flete_entrada'    THEN 1 ELSE 0 END) AS flete
      FROM sg_gastos_directos g
      JOIN sg_recepciones r ON r.id = g.recepcion_id AND r.activo = 1
     WHERE r.oc_id = ? AND g.activo = 1 AND g.estado = 'valorizado'
       AND ${SIN_FACTURA}`).get(Number(ocId));
  return { descarga: Number(f && f.descarga) || 0, flete: Number(f && f.flete) || 0 };
}

// LO QUE VA IMPRESO. Una línea por comprobante citado, con lo que la declaración
// jurada necesita para identificarlo. Se agrupa por factura: si una cubre tres
// viajes de la misma partida, el papel la cita UNA vez y dice a qué conceptos
// corresponde — citarla tres veces haría creer que son tres comprobantes.
export function comprobantesDeLaPartida(db, ocId) {
  const porFactura = new Map();
  for (const g of gastosDescontables(db, ocId)) {
    if (!g.factura_id) continue;
    const k = String(g.factura_id);
    if (!porFactura.has(k)) {
      porFactura.set(k, {
        factura_id: g.factura_id,
        emisor: g.emisor || g.prestador || '',
        cuit: g.cuit_emisor || g.emisor_cuit || '',
        comprobante: numeroDe(g),
        fecha: g.fecha_emision || '',
        // EL TOTAL DE LA FACTURA, entero. Pablo: «no importa que solamente
        // estemos descontando una parte».
        total: Number(g.factura_total) || 0,
        neto: Number(g.factura_neto) || 0,
        conceptos: [],
        imputado: 0,
      });
    }
    const x = porFactura.get(k);
    if (!x.conceptos.includes(ROTULO[g.tipo_gasto])) x.conceptos.push(ROTULO[g.tipo_gasto]);
    x.imputado = Math.round((x.imputado + (Number(g.monto) || 0)) * 100) / 100;
  }
  return [...porFactura.values()];
}

// «A 0001-00001234», con el tipo cuando se sabe. El punto de venta y el número van
// con ceros: es como está impreso en el papel y es como se lo busca.
export function numeroDe(f) {
  const pad = (n, l) => String(n == null ? '' : n).padStart(l, '0');
  const letra = { factura_a: 'A', factura_b: 'B', factura_c: 'C' }[String(f.tipo_comprobante || '')] || '';
  const nro = (f.punto_venta != null && f.numero != null)
    ? pad(f.punto_venta, 4) + '-' + pad(f.numero, 8)
    : String(f.numero || '');
  return (letra ? letra + ' ' : '') + nro;
}
