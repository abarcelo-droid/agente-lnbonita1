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
import { gastosSinFactura } from './sg_gastos_facturados.js';
import { kgPapelSql } from './sg_kilos_del_papel.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Las tablas las crea db_sg.js al arrancar; una base de prueba puede no tenerlas.
const _tablas = new WeakMap();
function _hayTabla(db, nombre) {
  if (!_tablas.has(db)) _tablas.set(db, new Map());
  const m = _tablas.get(db);
  if (!m.has(nombre)) {
    m.set(nombre, !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(nombre));
  }
  return m.get(nombre);
}
const _hayDevCamara = (db) => _hayTabla(db, 'sg_devolucion_stock_items');

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
  const remitidos = uno(`SELECT COALESCE(SUM(di.bultos),0) AS n
      FROM sg_despacho_items di
      JOIN sg_despachos d ON d.id = di.despacho_id AND d.activo = 1
      JOIN sg_lotes l ON l.id = di.lote_id AND l.activo = 1
      JOIN sg_oc_items i ON i.id = l.oc_item_id
     WHERE i.oc_id = ?`);
  // LO VENDIDO ES LO REMITIDO MENOS LO QUE EL CLIENTE DEVOLVIÓ AL PISO: eso volvió a
  // estar adentro. Sin restarlo, un cajón devuelto al stock y después devuelto al
  // proveedor se contaba dos veces, y la partida daba terminada con mercadería adentro
  // — o sea, se podía liquidar con stock en la cámara.
  const volvieron = _hayTabla(db, 'sg_devolucion_items') ? uno(`SELECT COALESCE(SUM(dvi.bultos),0) AS n
      FROM sg_devolucion_items dvi
      JOIN sg_devoluciones dv ON dv.id = dvi.devolucion_id AND dv.estado = 'registrada'
      JOIN sg_lotes l ON l.id = dvi.lote_id AND l.activo = 1
      JOIN sg_oc_items i ON i.id = l.oc_item_id
     WHERE i.oc_id = ? AND dvi.destino = 'stock'`) : 0;
  const vendidos = r2(remitidos - volvieron);
  const merma = uno(`SELECT COALESCE(SUM(dc.bultos),0) AS n
      FROM sg_lote_decomisos dc
      JOIN sg_lotes l ON l.id = dc.lote_id AND l.activo = 1
      JOIN sg_oc_items i ON i.id = l.oc_item_id
     WHERE i.oc_id = ?`);
  // LO DEVUELTO AL PROVEEDOR DESDE LA CÁMARA (V1044). Salió del depósito igual que lo
  // vendido y lo tirado: sin esto, la partida a la que se le devolvieron cajones no
  // terminaría nunca y no se podría liquidar. Se suma a lo terminado y NO se resta de
  // lo recibido: hacer las dos cosas lo contaría dos veces.
  const devueltos = _hayDevCamara(db) ? uno(`SELECT COALESCE(SUM(it.bultos),0) AS n
      FROM sg_devolucion_stock_items it
      JOIN sg_devoluciones_stock ds ON ds.id = it.devolucion_id AND ds.estado = 'registrada'
      JOIN sg_lotes l ON l.id = it.lote_id AND l.activo = 1
      JOIN sg_oc_items i ON i.id = l.oc_item_id
     WHERE i.oc_id = ?`) : 0;

  const terminado = r2(vendidos + merma + devueltos);
  return {
    recibidos, vendidos, merma, devueltos, terminado,
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
// SON DOS FRENOS, EN ESE ORDEN: PRIMERO EL IMPORTE, DESPUÉS EL PAPEL.
//
// Hasta el 8/9/2026 se exigía sólo la VALORIZACIÓN —«hace falta saber CUÁNTO, no tener el
// papel; la factura puede llegar después»—. Pablo lo cambió ese día, y por una razón que
// no es de stock sino impositiva: *«en principio hay que FRENARLA. Sin la factura no
// podemos liquidar. Es el filtro para contabilizar la factura»*.
//
// Descontarle al productor el flete que se le pagó al fletero es trasladarle un
// comprobante de un tercero: la liquidación tiene que identificarlo —CUIT, razón social,
// número y total— o la declaración jurada queda mal. Sin el comprobante cargado no hay
// con qué.
//
// El orden importa y sigue siendo el mismo: la VALORIZACIÓN va primero, porque es lo que
// entra al costo del lote el día que pasa el camión. La FACTURA va después, y es lo que
// habilita a liquidar. Que trabe el circuito del día es el objetivo — es lo que hace que
// el papel se cargue en vez de quedar en un cajón.
//
// Vive acá, al lado del freno de la partida terminada, porque son la misma pregunta
// —«¿esta partida está lista para liquidarse?»— y porque la pantalla tiene que poder
// preguntar lo MISMO que decide el servidor.

// Lo despachado que todavía no tiene comprobante, en pesos. La misma cuenta que ya hace
// GET /partidas/:id/venta: kilos despachados menos kilos facturados, por su precio.
//
// EN KILOS DEL PAPEL (V1040). Lo facturado se mide en el papel; si lo despachado se
// midiera en el galpón, un remito al súper que declaró 15 kg de 14 y se facturó
// entero daría −1 kg, y esa resta se come lo que otro renglón tiene sin facturar: el
// freno dejaría liquidar una partida con mercadería vendida y sin comprobante.
export function sinFacturarDePartida(db, ocId, facturaCuenta) {
  // SIN LO QUE EL CLIENTE DEVOLVIÓ (V1044), igual que al facturar: eso no se le va a
  // facturar nunca. Sin restarlo, la mercadería devuelta y revendida dejaba al remito
  // original con «sin facturar» para siempre, y el freno no dejaba liquidar la partida.
  // Lo devuelto viene en kilos del galpón y se lleva a kilos del papel.
  const devuelto = _hayTabla(db, 'sg_devolucion_items')
    ? `- COALESCE((SELECT SUM(dvi.kg) FROM sg_devolucion_items dvi
          JOIN sg_devoluciones dv ON dv.id = dvi.devolucion_id AND dv.estado = 'registrada'
         WHERE dvi.despacho_item_id = di.id),0)
        * (${kgPapelSql('di')} / NULLIF(di.kg_despachados, 0))`
    : '';
  const f = db.prepare(`
    SELECT COALESCE(SUM((${kgPapelSql('di')}
        - COALESCE((SELECT SUM(fd.kg) FROM sg_factura_despachos fd
            JOIN sg_ven_facturas fv ON fv.id = fd.factura_id
           WHERE fd.despacho_item_id = di.id AND ${facturaCuenta('fv')}),0)
        ${devuelto})
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
      + '«Gastos Directos → Control Cooperativa», con el botón «Valorizar» de la fila, y '
      + 'después cargá su factura.';
  }
  if (g.flete > 0) {
    return 'El flete de esta partida está cargado pero sin valorizar: no se sabe cuánto '
      + 'cobró el fletero. Valorizalo en «Gastos Directos → Fletes de entrada» y después '
      + 'cargá su factura.';
  }

  // ── SIN LA FACTURA DEL TERCERO NO SE LIQUIDA ────────────────────────────
  //
  // Pablo, 8/9/2026: «en principio hay que FRENARLA. Sin la factura no podemos
  // liquidar. Es el filtro para contabilizar la factura».
  //
  // Descontarle al productor el flete que le pagamos al fletero es, ante AFIP,
  // trasladarle un comprobante de un tercero: la liquidación tiene que
  // identificarlo —CUIT, razón social, número, total— y sin el comprobante
  // cargado no hay con qué. Que trabe el circuito del día es el objetivo: es lo
  // que hace que la factura se cargue en vez de quedar en un cajón.
  //
  // Va DESPUÉS del freno por valorizar, y en ese orden: primero se pone el
  // importe —que es lo que entra al costo— y después llega el papel.
  const sf = gastosSinFactura(db, ocId);
  if (sf.descarga > 0) {
    return 'La descarga de esta partida todavía no tiene la factura de la cooperativa cargada. '
      + 'Ese gasto se le descuenta al productor, así que la liquidación tiene que citar el '
      + 'comprobante —CUIT, razón social, número y total— o la declaración jurada queda mal. '
      + 'Cargala en «Gastos Directos → Control Cooperativa → 🧾 Ingresar factura» y volvé.';
  }
  if (sf.flete > 0) {
    return 'El flete de esta partida todavía no tiene la factura del fletero cargada. Ese gasto '
      + 'se le descuenta al productor, así que la liquidación tiene que citar el comprobante '
      + '—CUIT, razón social, número y total— o la declaración jurada queda mal. Cargala en '
      + '«Gastos Directos → Fletes de entrada → 🧾 Ingresar factura» y volvé.';
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
    + (a.merma > 0 ? ', ' + b(a.merma) + ' de merma' : '')
    + (a.devueltos > 0 ? ', ' + b(a.devueltos) + ' devueltos al proveedor' : '')
    + ') y quedan ' + b(a.faltan) + ' en el depósito. '
    + 'Se liquida cuando salió todo: lo que queda adentro todavía no se sabe cuánto va a rendir.';
}
