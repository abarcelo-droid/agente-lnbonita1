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

const ROTULO = { flete_entrada: 'Flete', descarga_ingreso: 'Descarga', flete_salida: 'Flete de salida' };

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

// ══ EL FLETE DE SALIDA QUE SAN GERÓNIMO LE ADELANTÓ AL PRODUCTOR (V1046) ════
//
// Pablo, 11/9/2026, sobre el flete del remito «a cargo del productor, lo adelanta
// San Gerónimo»: «OK avanzar». La pantalla del remito decía «se le descuenta de su
// liquidación» y ninguna liquidación lo descontaba: se le pagaba al fletero y la
// plata no volvía.
//
// No cuelga de una recepción sino de un REMITO, y un remito puede llevar mercadería
// de varias partidas —y de varios productores—. Por eso lo que le toca a esta
// partida sale de los RENGLONES valorizados (sg_gasto_flete_lineas, V1045) de los
// productos que son suyos: exacto, sin prorratear.
//
// Una fila por gasto (remito) que toca la partida:
//   · imputado  — lo de esta partida, sumando sus renglones.
//   · renglones — cuántos renglones valorizados tiene el gasto. Uno valorizado antes
//                 de la V1045 tiene cero: se valorizó por remito y no se sabe cuánto
//                 es de cada partida, así que cuenta como sin valorizar.
//   · la factura viva del fletero, si hay, con los datos que la DDJJ necesita.
const _tablas = new WeakMap();
function hayTabla(db, nombre) {
  if (!_tablas.has(db)) _tablas.set(db, new Map());
  const m = _tablas.get(db);
  if (!m.has(nombre)) {
    m.set(nombre, !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(nombre));
  }
  return m.get(nombre);
}

// ── LO QUE EL CLIENTE DEVOLVIÓ, COMO PARTE DEL RENGLÓN (V1048) ─────────────────
//
// Pablo, 11/9/2026: «el flete de salida cuando el cliente devuelve mercadería es
// pérdida de la partida». El flete de lo devuelto NO se le descuenta al productor:
// queda como costo en el margen del remito. Por cajón, que es como se paga el flete,
// y nunca más que el renglón entero. Una devolución anulada no cuenta.
function parteDevuelta(db, alias) {
  if (!hayTabla(db, 'sg_devolucion_items') || !hayTabla(db, 'sg_devoluciones')) return '0';
  const dev = (col) => `(SELECT SUM(dvi.${col}) FROM sg_devolucion_items dvi
      JOIN sg_devoluciones dv ON dv.id = dvi.devolucion_id AND dv.estado = 'registrada'
     WHERE dvi.despacho_item_id = ${alias}.id)`;
  // Por cajón, y si el renglón no tiene cajones cargados —los viejos, o los de kilos
  // declarados— por kilos del galpón. La mayor de las dos: que un registro a medias no
  // haga descontarle al productor el flete de lo que ya volvió.
  return `MIN(1, MAX(COALESCE(${dev('bultos')} / NULLIF(${alias}.bultos, 0), 0),
                     COALESCE(${dev('kg')} / NULLIF(${alias}.kg_despachados, 0), 0)))`;
}
function devueltosDelRemito(db, col) {
  if (!hayTabla(db, 'sg_devolucion_items') || !hayTabla(db, 'sg_devoluciones')) return '0';
  return `(SELECT COALESCE(SUM(dvi.${col}),0) FROM sg_devolucion_items dvi
      JOIN sg_devoluciones dv ON dv.id = dvi.devolucion_id AND dv.estado = 'registrada'
      JOIN sg_despacho_items di5 ON di5.id = dvi.despacho_item_id
     WHERE di5.despacho_id = d.id)`;
}

export function fletesSalidaAdelantados(db, ocId) {
  // Una base sin los renglones del flete (la de un test viejo, o una que todavía no
  // migró) no tiene fletes de salida por renglón: no hay nada que descontar.
  if (!hayTabla(db, 'sg_gasto_flete_lineas') || !hayTabla(db, 'sg_despachos')) return [];
  const id = Number(ocId);
  // SÓLO EN LAS PARTIDAS A PIZARRA. Pablo, 11/9/2026, sobre las de precio cerrado: «lo
  // absorbemos nosotros». A precio cerrado el productor cobra lo pactado entero —el
  // despeje de la liquidación lo garantiza—, así que ese flete no se le puede
  // descontar: no frena, no se cita, y queda como costo nuestro en el margen del remito.
  if (!hayTabla(db, 'sg_oc')) return [];
  const oc = db.prepare('SELECT tipo_precio FROM sg_oc WHERE id = ?').get(id);
  if (!oc || oc.tipo_precio !== 'pizarra') return [];
  return db.prepare(`
    SELECT g.id, g.estado, g.fecha_servicio, d.numero AS remito,
           pv.razon_social AS prestador,
           -- Sin lo que el cliente devolvió: eso es pérdida de la partida (V1048).
           (SELECT COALESCE(SUM(fl.monto * (1 - ${parteDevuelta(db, 'di')})),0) FROM sg_gasto_flete_lineas fl
              JOIN sg_despacho_items di ON di.id = fl.despacho_item_id
              JOIN sg_lotes l ON l.id = di.lote_id
              JOIN sg_oc_items oi ON oi.id = l.oc_item_id
             WHERE fl.gasto_id = g.id AND oi.oc_id = ?) AS imputado,
           (SELECT COUNT(*) FROM sg_gasto_flete_lineas fl WHERE fl.gasto_id = g.id) AS renglones,
           -- ¿El remito ENTERO es de esta partida? Entonces un gasto valorizado por
           -- remito, sin renglones, es todo de ella: se toma entero, sin repartir.
           (SELECT COUNT(*) FROM sg_despacho_items di2 WHERE di2.despacho_id = d.id) AS items_remito,
           (SELECT COUNT(*) FROM sg_despacho_items di3
              JOIN sg_lotes l3 ON l3.id = di3.lote_id
              JOIN sg_oc_items oi3 ON oi3.id = l3.oc_item_id
             WHERE di3.despacho_id = d.id AND oi3.oc_id = ?) AS items_partida,
           g.monto AS monto_gasto,
           (SELECT COALESCE(SUM(di4.bultos),0) FROM sg_despacho_items di4 WHERE di4.despacho_id = d.id) AS bultos_remito,
           ${devueltosDelRemito(db, 'bultos')} AS bultos_devueltos_remito,
           (SELECT COALESCE(SUM(di4.kg_despachados),0) FROM sg_despacho_items di4 WHERE di4.despacho_id = d.id) AS kg_remito,
           ${devueltosDelRemito(db, 'kg')} AS kg_devueltos_remito,
           f.id            AS factura_id,
           f.tipo_comprobante, f.punto_venta, f.numero, f.fecha_emision,
           f.cuit_emisor, f.neto AS factura_neto, f.iva_monto AS factura_iva,
           f.total AS factura_total,
           fp.razon_social AS emisor, fp.cuit AS emisor_cuit
      FROM sg_gastos_directos g
      JOIN sg_despachos d ON d.id = g.despacho_id AND d.activo = 1
      LEFT JOIN sg_proveedores pv ON pv.id = g.proveedor_servicio_id
      -- La factura VIVA, una sola: con una anulada y otra nueva, la fila no se duplica.
      LEFT JOIN sg_facturas_gasto f ON f.id = (SELECT fi.factura_id FROM sg_factura_gasto_items fi
             JOIN sg_facturas_gasto f2 ON f2.id = fi.factura_id AND f2.activo = 1
            WHERE fi.gasto_id = g.id LIMIT 1)
      LEFT JOIN sg_proveedores fp ON fp.id = f.proveedor_servicio_id
     WHERE g.tipo_gasto = 'flete_salida' AND g.activo = 1 AND g.estado <> 'anulado'
       AND d.flete_a_cargo = 'productor' AND d.flete_pagado_por = 'san_geronimo'
       AND EXISTS (SELECT 1 FROM sg_despacho_items di
                     JOIN sg_lotes l ON l.id = di.lote_id
                     JOIN sg_oc_items oi ON oi.id = l.oc_item_id
                    WHERE di.despacho_id = d.id AND oi.oc_id = ?)
     ORDER BY g.id`).all(id, id, id).map((x) => {
    // Valorizado antes de la V1045 —un número por remito— y con TODO el remito de esta
    // partida: ese número es suyo entero. Exacto, no un reparto. Si el remito lleva
    // mercadería de otra partida (o de un reproceso sin partida), no se sabe cuánto
    // es de cada una y hay que valorizarlo por producto.
    const entero = x.estado === 'valorizado' && !(Number(x.renglones) > 0)
      && Number(x.items_remito) > 0 && Number(x.items_partida) === Number(x.items_remito);
    // Entero, menos la parte de lo que el cliente devolvió (V1048).
    // Por cajón o por kilo, la mayor: la misma regla que por renglón (parteDevuelta).
    const parte = (d, t) => Number(t) > 0 ? (Number(d) || 0) / Number(t) : 0;
    const dev = Math.min(1, Math.max(parte(x.bultos_devueltos_remito, x.bultos_remito),
                                     parte(x.kg_devueltos_remito, x.kg_remito)));
    return Object.assign({}, x, entero
      ? { imputado: Math.round((Number(x.monto_gasto) || 0) * (1 - dev) * 100) / 100, por_remito_entero: 1 }
      : { por_remito_entero: 0 });
  });
}

// Lo que la liquidación de la partida necesita saber, en números: cuánto se le
// descuenta y qué la frena.
//   · sin_valorizar — remitos pendientes, o valorizados por remito sin decir cuánto es
//     de cada producto. No se sabe cuánto descontarle.
//   · sin_factura   — valorizados, con algo para esta partida, sin la factura del
//     fletero: sin el comprobante la liquidación no lo puede citar.
export function resumenSalidaAdelantada(db, ocId) {
  const filas = fletesSalidaAdelantados(db, ocId);
  const porValorizar = (x) => x.estado !== 'valorizado'
    || (!(Number(x.renglones) > 0) && !x.por_remito_entero);
  const valorizados = filas.filter((x) => !porValorizar(x));
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  return {
    neto: r2(valorizados.reduce((a, x) => a + (Number(x.imputado) || 0), 0)),
    sin_valorizar: filas.filter(porValorizar).length,
    sin_factura: valorizados.filter((x) => Number(x.imputado) > 0 && !x.factura_id).length,
    remitos: filas.map((x) => x.remito).filter(Boolean),
    remitos_sin_valorizar: filas.filter(porValorizar).map((x) => x.remito).filter(Boolean),
    remitos_sin_factura: valorizados.filter((x) => Number(x.imputado) > 0 && !x.factura_id)
      .map((x) => x.remito).filter(Boolean),
  };
}

// ══ EL FLETE DE ENTRADA QUE SAN GERÓNIMO LE ADELANTÓ AL PRODUCTOR (V1048) ═══
//
// Pablo, 11/9/2026: «el flete adelantado, en caso de corresponder, se debe descontar
// de la liquidación». Hasta la V1047 el de entrada se tipeaba a mano en la fila
// «Flete». Corresponde con el flete a cargo del VENDEDOR, adelantado por San Gerónimo,
// y en una partida A PIZARRA: a precio cerrado lo absorbemos nosotros, la misma regla
// que el de salida, y entra al costo de la partida.
export function esFleteEntradaAdelantado(oc) {
  return !!oc && oc.flete_a_cargo === 'vendedor' && oc.flete_pagado_por === 'san_geronimo'
    && oc.tipo_precio === 'pizarra';
}

// Lo que la liquidación necesita: si corresponde, cuántos viajes faltan valorizar —un
// viaje sin valorizar no deja fila de gasto, así que se mira la RECEPCIÓN— y lo que
// dicen las facturas del fletero de esos viajes, que es lo que se descuenta.
export function fleteEntradaAdelantado(db, ocId) {
  const nada = { corresponde: 0, sin_valorizar: 0, neto: 0 };
  if (!hayTabla(db, 'sg_oc') || !hayTabla(db, 'sg_recepciones')) return nada;
  const id = Number(ocId);
  const oc = db.prepare('SELECT flete_a_cargo, flete_pagado_por, tipo_precio FROM sg_oc WHERE id = ?').get(id);
  if (!esFleteEntradaAdelantado(oc)) return nada;
  // UN VIAJE QUE SE QUEDÓ SIN MERCADERÍA NO SE VALORIZA. Si todos sus lotes se borraron
  // por mal cargados, no hubo flete que pagar: exigirlo obligaba a inventar un importe,
  // y después la factura de un fletero por un viaje que no existió.
  const conLotes = hayTabla(db, 'sg_lotes')
    ? 'AND EXISTS (SELECT 1 FROM sg_lotes l WHERE l.recepcion_id = r.id AND l.activo = 1)' : '';
  const sinVal = db.prepare(`SELECT COUNT(*) AS n FROM sg_recepciones r
     WHERE r.oc_id = ? AND r.activo = 1
       AND NOT EXISTS (SELECT 1 FROM sg_gastos_directos g
                        WHERE g.recepcion_id = r.id AND g.tipo_gasto = 'flete_entrada'
                          AND g.activo = 1 AND g.estado = 'valorizado')
       ${conLotes}`).get(id).n;
  const neto = db.prepare(`SELECT COALESCE(SUM(fi.neto),0) AS s FROM sg_gastos_directos g
      JOIN sg_recepciones r ON r.id = g.recepcion_id AND r.activo = 1
      JOIN sg_factura_gasto_items fi ON fi.gasto_id = g.id
      JOIN sg_facturas_gasto f ON f.id = fi.factura_id AND f.activo = 1
     WHERE r.oc_id = ? AND g.tipo_gasto = 'flete_entrada' AND g.activo = 1 AND g.estado <> 'anulado'`).get(id).s;
  return { corresponde: 1, sin_valorizar: Number(sinVal) || 0,
    neto: Math.round((Number(neto) || 0) * 100) / 100 };
}

// LO QUE VA IMPRESO. Una línea por comprobante citado, con lo que la declaración
// jurada necesita para identificarlo. Se agrupa por factura: si una cubre tres
// viajes de la misma partida, el papel la cita UNA vez y dice a qué conceptos
// corresponde — citarla tres veces haría creer que son tres comprobantes.
export function comprobantesDeLaPartida(db, ocId, opts = {}) {
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
  // Y la factura del fletero que llevó lo que se le adelantó al productor (V1046). Lo
  // imputado es SÓLO lo de esta partida —sus renglones—, no el remito entero: la
  // misma factura puede cubrir productos de otros productores.
  // Salvo que se pida sin él: una liquidación emitida antes de la V1046 no lo descontó.
  for (const s of (opts.salida === false ? [] : fletesSalidaAdelantados(db, ocId))) {
    if (!s.factura_id || !(Number(s.imputado) > 0)) continue;
    const k = String(s.factura_id);
    if (!porFactura.has(k)) {
      porFactura.set(k, {
        factura_id: s.factura_id,
        emisor: s.emisor || s.prestador || '',
        cuit: s.cuit_emisor || s.emisor_cuit || '',
        comprobante: numeroDe(s),
        fecha: s.fecha_emision || '',
        total: Number(s.factura_total) || 0,
        neto: Number(s.factura_neto) || 0,
        conceptos: [],
        imputado: 0,
      });
    }
    const x = porFactura.get(k);
    if (!x.conceptos.includes(ROTULO.flete_salida)) x.conceptos.push(ROTULO.flete_salida);
    x.imputado = Math.round((x.imputado + (Number(s.imputado) || 0)) * 100) / 100;
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
