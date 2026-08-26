// src/servicios/sg_perfeccionada.js
//
// ══ UNA PARTIDA PERFECCIONADA TIENE EL PRECIO FIRME ════════════════════════
//
// Pablo, 26/8/2026, al pie de la letra:
//
//   «una vez que se perfecciona la orden de compra con una FACTURA o una
//    LIQUIDACIÓN, ya no se puede modificar la orden de compra y ese precio queda
//    FIRME. La única manera de modificarlo es anular la factura recibida o la
//    liquidación emitida y cambiar el precio.»
//
// La razón es la que se ve en cuanto se intenta: el precio de la orden baja al costo
// de cada lote, y de ahí al inventario, al margen de todo lo que se vendió y a lo que
// se le debe al productor. Una vez que ese número se documentó con un comprobante
// —el que se recibió o el que se emitió—, cambiarlo por atrás deja el papel diciendo
// una cosa y el sistema otra, sin que nada avise.
//
// ── FACTURA CARGADA = FACTURA CONTABILIZADA ────────────────────────────────
//
// Pablo: *«factura cargada y contabilizada debería ser lo mismo. Si está cargada, se
// debe haber disparado el asiento»*. Así que acá alcanza con que la factura esté
// CARGADA Y VIVA (activo=1). No se pide el asiento.
//
// No es un detalle: el repo tenía los dos criterios escritos en lugares distintos
// —frenosDeEdicionLote y /documenta exigían asiento vivo, y la bandeja de partidas
// miraba sólo la factura—, así que una factura cargada y todavía sin contabilizar
// dejaba el precio editable justo en la ventana en que ya hay un papel del proveedor.
//
// ── Y VALE PARA TODAS LAS PARTIDAS ─────────────────────────────────────────
//
// Pablo: *«vale para todas»*. También las de PRECIO ABIERTO (pizarra), donde el
// precio no vive en la orden sino en cada lote: si esa partida ya se liquidó, su
// precio tampoco se toca.
//
// ── UNA SOLA RESPUESTA ─────────────────────────────────────────────────────
//
// La consulta de «esta partida ya está documentada» estaba copiada a mano en tres
// lugares de rutas/sg.js, con criterios que no coincidían entre sí y ninguno miraba
// la liquidación. Por eso una partida ya liquidada se podía repreciar hoy por tres
// puertas distintas sin que nadie chistara.

// La factura de compra puede cubrir VARIAS partidas: si sólo se mira f.oc_id, las que
// entraron como secundarias —las que viven en sg_factura_compra_ocs— quedan libres
// aunque su comprobante ya esté cargado.
const SQL_FACTURA = `SELECT f.id, f.numero, f.asiento_id
  FROM sg_facturas_compra f
 WHERE f.activo = 1
   AND (f.oc_id = ? OR EXISTS (SELECT 1 FROM sg_factura_compra_ocs fo
                                WHERE fo.factura_id = f.id AND fo.oc_id = ?))
 LIMIT 1`;

// Del lado de la liquidación, «emitida» es que exista y no esté dada de baja. Su
// tabla es del módulo de abasto: si todavía no existe, no hay liquidación posible.
const SQL_LIQUIDACION = `SELECT id, n_liquidacion, asiento_id
  FROM liquidaciones
 WHERE oc_id = ? AND eliminado_en IS NULL
 LIMIT 1`;

// Y la marca a mano: una liquidación emitida fuera del sistema, o cargada sin decir
// de qué partida es. La pone un admin con motivo (POST /oc/:id/liquidada).
const SQL_MARCA = `SELECT liquidada_en FROM sg_oc WHERE id = ? AND liquidada_en IS NOT NULL`;

// Devuelve null si la partida está libre, o { como, numero, id } si ya está
// perfeccionada. `como` es 'factura' | 'liquidacion' | 'marca'.
export function perfeccionamientoDeOC(db, ocId) {
  const oc = Number(ocId);
  if (!(oc > 0)) return null;
  try {
    const f = db.prepare(SQL_FACTURA).get(oc, oc);
    if (f) return { como: 'factura', id: f.id, numero: f.numero, asiento_id: f.asiento_id };
  } catch (_) { /* la tabla de compras siempre está; si no, no hay factura */ }
  try {
    const l = db.prepare(SQL_LIQUIDACION).get(oc);
    if (l) return { como: 'liquidacion', id: l.id, numero: l.n_liquidacion, asiento_id: l.asiento_id };
  } catch (_) { /* liquidaciones es del módulo de abasto y puede no existir todavía */ }
  try {
    const m = db.prepare(SQL_MARCA).get(oc);
    if (m) return { como: 'marca', id: null, numero: null, fecha: m.liquidada_en };
  } catch (_) { /* columna vieja */ }
  return null;
}

// El mensaje, con la salida escrita. Un cerrojo que no dice a dónde ir deja al
// operador con el trabajo hecho y sin poder guardarlo.
export function motivoPrecioFirme(p, queSeIntenta = 'cambiar el precio') {
  if (!p) return null;
  if (p.como === 'factura') {
    return 'Esta partida ya está documentada con la factura de compra ' + (p.numero || p.id)
      + ', así que su precio quedó FIRME. Para ' + queSeIntenta
      + ', anulá primero esa factura (Facturas de compra → Anular) y volvé.';
  }
  if (p.como === 'liquidacion') {
    return 'Esta partida ya está documentada con la liquidación ' + (p.numero || p.id)
      + ', así que su precio quedó FIRME. Para ' + queSeIntenta
      + ', anulá primero esa liquidación y volvé.';
  }
  return 'Esta partida está marcada como liquidada' + (p.fecha ? ' el ' + String(p.fecha).slice(0, 10) : '')
    + ', así que su precio quedó FIRME. Si esa marca está mal, sacala primero.';
}

// Azúcar para los tres endpoints que lo usan: devuelve el texto o null.
export function frenoPrecioFirme(db, ocId, queSeIntenta) {
  return motivoPrecioFirme(perfeccionamientoDeOC(db, ocId), queSeIntenta);
}
