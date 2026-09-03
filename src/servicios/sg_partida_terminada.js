// ══ UNA PARTIDA SE LIQUIDA CUANDO ESTÁ TERMINADA ═══════════════════════════════════════
//
// Pablo, 27/8/2026: «solamente se puede liquidar una partida si está 100% terminada, o
// sea todos los bultos vendidos o mermados».
//
// TERMINADA = lo que ya no está en el depósito. Vendido MÁS merma, y las dos cosas
// cuentan igual: Pablo, 24/8/2026 — «en una de 60 bultos ingresados puede pasar que
// tengamos vendidos 55 y 5 sean merma. Obviamente esos 5 van a precio de venta 0 — están
// "vendidos" pero suman cero». Sin contar la merma, una partida que salió entera —parte
// vendida, parte tirada— nunca daría por terminada y no se podría liquidar nunca.
//
// EN BULTOS, que es como se cuenta el camión y como lo cuenta el proveedor. En kilos la
// cuenta no cierra: el bulto que se vende pesa lo que pesa y el que se tira también, pero
// los kilos vigentes de un lote se mueven con los reprocesos.
//
// POR QUÉ IMPORTA: liquidar con la mitad en el depósito es fijarle precio a mercadería que
// todavía no se sabe cuánto va a rendir. La liquidación es el papel donde el productor
// cobra; una vez emitida, corregirla es anularla.
//
// Vive acá y no adentro del router para que el test lo corra de verdad contra el esquema,
// y para que la pantalla pueda preguntar lo MISMO que decide el servidor: un botón que se
// ofrece y contesta 403 hace creer al que lo aprieta que rompió algo.

// El redondeo del repo: los bultos se cuentan enteros pero llegan como REAL de SQLite y
// arrastran coma flotante. Sin esto, 44.99999 contra 45 da "falta 1 bulto".
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function avanceDePartida(db, ocId) {
  const id = Number(ocId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const uno = (sql) => {
    const f = db.prepare(sql).get(id);
    return r2(f && f.n);
  };

  const recibidos = uno(`SELECT COALESCE(SUM(l.bultos),0) AS n
      FROM sg_lotes l JOIN sg_oc_items i ON i.id = l.oc_item_id
     WHERE i.oc_id = ? AND l.activo = 1`);
  const vendidos = uno(`SELECT COALESCE(SUM(di.bultos),0) AS n
      FROM sg_despacho_items di
      JOIN sg_despachos d ON d.id = di.despacho_id AND d.activo = 1
      JOIN sg_lotes l ON l.id = di.lote_id AND l.activo = 1
      JOIN sg_oc_items i ON i.id = l.oc_item_id
     WHERE i.oc_id = ?`);
  const merma = uno(`SELECT COALESCE(SUM(dc.bultos),0) AS n
      FROM sg_lote_decomisos dc
      JOIN sg_lotes l ON l.id = dc.lote_id AND l.activo = 1
      JOIN sg_oc_items i ON i.id = l.oc_item_id
     WHERE i.oc_id = ?`);

  const terminado = r2(vendidos + merma);
  return {
    recibidos, vendidos, merma, terminado,
    faltan: r2(Math.max(0, recibidos - terminado)),
    // Con un bulto de tolerancia no: se cuenta por unidad. El centavo de tolerancia
    // es contra la coma flotante, no contra la mercadería.
    terminada: recibidos > 0 && terminado >= recibidos - 0.01,
    // Una partida sin nada recibido no está "terminada": está sin empezar, y son dos
    // cosas distintas. Liquidar aire es el peor caso de todos.
    sin_recibir: recibidos <= 0,
  };
}

// ══ Y TAMPOCO SE LIQUIDA CON PLATA SIN CERRAR ═════════════════════════════════════════
//
// Pablo, 29/8/2026: «no se debe poder liquidar si la mercadería no está facturada. Hay
// que esperar a cerrar la facturación para liquidar, siempre. Debemos tener la descarga
// por lo menos valorizada. Lo mismo con el flete: debe estar valorizado. Después se puede
// ingresar la factura, pero deben estar valorizados sí o sí».
//
// Las tres son la misma idea: la liquidación es el papel donde el productor cobra, y se
// arma con números que todavía no están. Sin la venta facturada, lo que se le paga sale
// de menos. Sin la descarga o el flete valorizados, esos gastos NO se le descuentan —o
// alguien los tipea a ojo— y el que pierde es siempre el mismo lado.
//
// LO QUE SE EXIGE ES LA VALORIZACIÓN, NO LA FACTURA DEL FLETERO. Es la distinción que
// hizo Pablo: hace falta saber CUÁNTO, no tener el papel. La factura del fletero puede
// llegar después.
//
// Vive acá, al lado del freno de la partida terminada, porque son la misma pregunta
// —«¿esta partida está lista para liquidarse?»— y porque la pantalla tiene que poder
// preguntar lo MISMO que decide el servidor.

// Lo despachado que todavía no tiene comprobante, en pesos. La misma cuenta que ya hace
// GET /partidas/:id/venta: kilos despachados menos kilos facturados, por su precio.
export function sinFacturarDePartida(db, ocId, facturaCuenta) {
  const f = db.prepare(`
    SELECT COALESCE(SUM((di.kg_despachados
        - COALESCE((SELECT SUM(fd.kg) FROM sg_factura_despachos fd
            JOIN sg_ven_facturas fv ON fv.id = fd.factura_id
           WHERE fd.despacho_item_id = di.id AND ${facturaCuenta('fv')}),0))
      * COALESCE(di.precio_por_kg,0)),0) AS monto
      FROM sg_despacho_items di
      JOIN sg_despachos d ON d.id = di.despacho_id AND d.activo = 1
      JOIN sg_lotes l ON l.id = di.lote_id AND l.activo = 1
      JOIN sg_oc_items i ON i.id = l.oc_item_id
     WHERE i.oc_id = ?`).get(Number(ocId));
  return r2(f && f.monto);
}

// Los gastos de la partida que se cargaron y nadie valorizó. Se mira por TIPO para poder
// nombrarlo: «hay una descarga sin valorizar» y «hay un flete sin valorizar» se resuelven
// en pantallas distintas.
export function gastosSinValorizar(db, ocId) {
  const f = db.prepare(`
    SELECT
      SUM(CASE WHEN g.tipo_gasto='descarga_ingreso' AND g.estado='pendiente_valorizar' THEN 1 ELSE 0 END) AS descarga,
      SUM(CASE WHEN g.tipo_gasto='flete_entrada'    AND g.estado='pendiente_valorizar' THEN 1 ELSE 0 END) AS flete
      FROM sg_gastos_directos g
      JOIN sg_recepciones r ON r.id = g.recepcion_id AND r.activo = 1
     WHERE r.oc_id = ? AND g.activo = 1 AND g.estado != 'anulado'`).get(Number(ocId));
  return { descarga: Number(f && f.descarga) || 0, flete: Number(f && f.flete) || 0 };
}

// El freno completo. Devuelve null si la partida se puede liquidar, o el texto que el que
// liquida necesita leer — con el camino, no un «no se puede» a secas.
export function frenoParaLiquidar(db, ocId, facturaCuenta) {
  const terminada = frenoPartidaSinTerminar(db, ocId);
  if (terminada) return terminada;

  const sinFac = sinFacturarDePartida(db, ocId, facturaCuenta);
  if (sinFac > 0.01) {
    const m = '$' + Number(sinFac).toLocaleString('es-AR', { minimumFractionDigits: 2 });
    return 'De esta partida salieron ' + m + ' que todavía no se facturaron. La liquidación '
      + 'se arma con lo que dicen los comprobantes: emitida ahora, al productor se le pagaría '
      + 'de menos. Cerrá la facturación en «Remitos pendientes de comprobante» y volvé.';
  }

  const g = gastosSinValorizar(db, ocId);
  if (g.descarga > 0) {
    return 'La descarga de esta partida está cargada pero sin valorizar: no se sabe cuánto '
      + 'cobró la cuadrilla, así que no se le puede descontar al productor. Valorizala en '
      + '«Gastos Directos → Control Cooperativa», con el botón «Valorizar» de la fila —alcanza con el importe, la factura puede '
      + 'llegar después— y volvé.';
  }
  if (g.flete > 0) {
    return 'El flete de esta partida está cargado pero sin valorizar: no se sabe cuánto '
      + 'cobró el fletero. Valorizalo en «Gastos Directos → Fletes de entrada» —alcanza con '
      + 'el importe, la factura puede llegar después— y volvé.';
  }
  return null;
}

// El freno, con las palabras que el que liquida necesita leer. Devuelve null si puede.
export function frenoPartidaSinTerminar(db, ocId) {
  const a = avanceDePartida(db, ocId);
  if (!a) return null;                       // sin partida no hay nada que mirar acá
  if (a.sin_recibir) {
    return 'Esa partida todavía no tiene mercadería recibida: no hay nada que liquidar.';
  }
  if (a.terminada) return null;
  const b = (n) => Number(n).toLocaleString('es-AR');
  return 'Esa partida todavía no está terminada: de ' + b(a.recibidos) + ' bulto(s) '
    + 'salieron ' + b(a.terminado) + ' (' + b(a.vendidos) + ' vendidos'
    + (a.merma > 0 ? ' y ' + b(a.merma) + ' de merma' : '')
    + ') y quedan ' + b(a.faltan) + ' en el depósito. '
    + 'Se liquida cuando salió todo: lo que queda adentro todavía no se sabe cuánto va a rendir.';
}
