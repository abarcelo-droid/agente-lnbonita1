// src/servicios/sg_acordado.js
//
// ══ LO QUE SE LE PACTÓ AL PRODUCTOR, EN UN SOLO LUGAR ══════════════════════
//
// Esta cuenta vivía adentro de rutas/sg.js y la usaban tres pantallas de ese mismo
// router. Ahora la necesita también el que GUARDA la liquidación —que es otro
// router, el de abasto— para poder frenar una liquidación a precio cerrado que no
// da el precio cerrado. Copiarla allá serían dos cuentas de lo mismo, y el día que
// una cambie el aviso de "no da contra lo acordado" empieza a mentir sin que nadie
// se entere.
//
// LA CUENTA SE HACE EN BULTOS. La compra se pacta en bultos y a tanto el bulto
// —"100 cajones a $15.000"— y así la controla el comprador contra la factura, no
// multiplicando kilos por $/kg. El sistema costea en kilos, pero eso es asunto
// suyo: acá manda la unidad en la que se cerró el trato.
//
// Si la mercadería entró pesada y sin contar bultos, no hay con qué: ahí se cae a
// kilos. Cada ítem dice cuál de las dos cuentas se le hizo.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ══ LO QUE SE TIRÓ, POR ÍTEM ══════════════════════════════════════════════
//
// La merma NO baja los kilos ni los bultos del lote —el decomiso deja kg_reales
// intacto a propósito—, así que lo recibido de la orden los sigue incluyendo. Para
// poder pagar SIN las mermas hay que descontarlas acá.
//
// POR ÍTEM Y NO PRORRATEADO. Un camión con durazno a $8.000 y ciruela a $2.000 en
// el que se tiran cinco cajones de ciruela no descuenta «cinco cajones al precio
// promedio»: descuenta cinco cajones de ciruela. El prorrateo da un número creíble
// y equivocado, y la diferencia se la come el productor.
//
// Los kilos se separan según el lote haya entrado contado en cajones o pesado a
// granel, porque la cuenta de abajo paga cada parte con su base.
export function mermaPorItemDeOC(db, ocId) {
  const rows = db.prepare(`SELECT l.oc_item_id AS item,
      COALESCE(SUM(dc.bultos),0) AS bultos,
      COALESCE(SUM(dc.kg),0) AS kg,
      COALESCE(SUM(CASE WHEN COALESCE(l.bultos,0) > 0 THEN dc.kg ELSE 0 END),0) AS kg_con_bultos
    FROM sg_lote_decomisos dc
    JOIN sg_lotes l ON l.id = dc.lote_id AND l.activo = 1
    JOIN sg_oc_items i ON i.id = l.oc_item_id
   WHERE i.oc_id = ? GROUP BY l.oc_item_id`).all(ocId);
  const porItem = new Map();
  let bultos = 0, kg = 0;
  for (const x of rows) {
    porItem.set(x.item, { bultos: Number(x.bultos) || 0, kg: r2(x.kg),
      kg_con_bultos: r2(x.kg_con_bultos) });
    bultos += Number(x.bultos) || 0;
    kg = r2(kg + Number(x.kg));
  }
  return { bultos, kg, hay: bultos > 0 || kg > 0, porItem };
}

// La consulta se compila UNA vez por base y se reusa: el listado de órdenes la
// llama una vez por fila, y compilar la misma sentencia doscientas veces para
// pintar una pantalla es trabajo que no hace falta.
const _stmtAcordado = new WeakMap();
// Con { sinMermas: true } devuelve lo que se le debe al productor DESCONTANDO lo
// que se tiró. Es la segunda de las dos opciones que la liquidación tiene que
// ofrecer cuando la partida tuvo merma (Pablo, 29/8/2026).
export function acordadoDeOC(db, ocId, opts) {
  if (!_stmtAcordado.has(db)) _stmtAcordado.set(db, db.prepare(`SELECT i.id, i.precio_estimado_por_kg,
      -- LA UNIDAD EN QUE SE PACTÓ. Es lo que el comprador eligió al cargar la
      -- orden, y es lo que manda cuando hay diferencias: si compró bultos, la
      -- orden se rehace por bultos; si compró kilos, por kilos.
      i.modo_carga,
      COALESCE(i.kg_por_bulto, ps.factor_conversion) AS kg_por_bulto,
      (SELECT COALESCE(SUM(kg_reales),0) FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS kg_recibidos,
      (SELECT COALESCE(SUM(bultos),0)    FROM sg_lotes WHERE oc_item_id=i.id AND activo=1) AS bultos_recibidos,
      -- LOS KILOS DE LOS BULTOS QUE SÍ SE CONTARON, aparte. Es lo que separa un
      -- ítem que entró todo contado de uno que entró mitad y mitad.
      (SELECT COALESCE(SUM(kg_reales),0) FROM sg_lotes
        WHERE oc_item_id=i.id AND activo=1 AND bultos IS NOT NULL AND bultos > 0) AS kg_con_bultos
    FROM sg_oc_items i
    LEFT JOIN sg_presentaciones ps ON ps.id=i.presentacion_id
    WHERE i.oc_id=?`));
  const its = _stmtAcordado.get(db).all(ocId);
  const mer = (opts && opts.sinMermas) ? mermaPorItemDeOC(db, ocId) : null;
  let total = 0;
  const detalle = [];
  for (const it of its) {
    const pk = it.precio_estimado_por_kg != null ? Number(it.precio_estimado_por_kg) : null;
    const kpb = Number(it.kg_por_bulto) || 0;
    const m = (mer && mer.porItem.get(it.id)) || { bultos: 0, kg: 0, kg_con_bultos: 0 };
    // LO BRUTO DECIDE LA BASE, LO NETO DECIDE EL IMPORTE. Si una partida entró en
    // cajones y se mermó entera, descontar primero la haría caer a la cuenta por
    // kilo y cambiaría de qué se está hablando: se pactó por cajón igual.
    const bultosBrutos = Number(it.bultos_recibidos) || 0;
    const bultos = Math.max(0, bultosBrutos - m.bultos);
    const kgRecibidos = Math.max(0, r2(Number(it.kg_recibidos) - m.kg));
    const kgConBultos = Math.max(0, r2(Number(it.kg_con_bultos) - m.kg_con_bultos));
    const precioBulto = (pk != null && kpb > 0) ? r2(pk * kpb) : null;
    let importe = null, base = null;
    if (pk != null) {
      // ── CADA LOTE SE PAGA CON LA BASE QUE LE CORRESPONDE ────────────────
      // Antes la base se elegía UNA vez por ítem: si había aunque fuera un
      // bulto contado, se cobraba TODO por bulto y los lotes que entraron
      // pesados —sin contar cajones— no se pagaban. Un camión que descarga 60
      // cajones y después 800 kg a granel del mismo producto se liquidaba por
      // los 60 cajones y los 800 kg desaparecían de la cuenta.
      //
      // Ahora los cajones se pagan por cajón y el resto por kilo, que es
      // exactamente como se pactó cada parte.
      const kgSueltos = Math.max(0, r2(kgRecibidos - kgConBultos));
      // Y LA BASE SALE DE LO QUE PACTÓ EL COMPRADOR, no de si alguien contó
      // bultos. Antes: "si hay aunque sea un bulto contado, se cobra por bulto".
      // Eso decidía por él. Un ítem comprado POR KILO se paga por kilo aunque haya
      // entrado en cajones --el cajón es cómo vino, no cómo se compró--.
      //
      // Si el ítem es viejo y no tiene modo_carga, se cae al comportamiento de
      // antes: no hay dato de qué eligió, y suponer "kilo" cambiaría la cuenta de
      // órdenes ya cerradas.
      const porBulto = (it.modo_carga === 'bulto')
        || (it.modo_carga == null && bultosBrutos > 0);
      if (porBulto && bultos > 0 && precioBulto != null) {
        importe = r2(bultos * precioBulto + kgSueltos * pk);
        base = kgSueltos > 0 ? 'mixto' : 'bulto';
      } else if (porBulto && bultosBrutos > 0) {
        // Se pactó por cajón y no queda ninguno sin mermar: se debe cero, pero la
        // base sigue siendo el cajón. Caer al `else` diría 'kilo' y el mensaje del
        // cerrojo hablaría de una cuenta que nadie hizo.
        importe = r2(kgSueltos * pk);
        base = 'bulto';
      } else {
        importe = r2(kgRecibidos * pk);
        base = 'kilo';
      }
      total = r2(total + importe);
    }
    detalle.push({ oc_item_id: it.id, precio_por_bulto: precioBulto, importe, base });
  }
  return { total, detalle };
}

// El precio por unidad, si TODOS los ítems comparten uno, y lo que la orden pactó
// EN TOTAL. Con ítems a precios distintos no hay UN precio por bulto, y poner el de
// uno sería inventar los otros: ahí sólo queda el total.
export function precioUnicoDeOC(db, ocId) {
  const a = acordadoDeOC(db, ocId);
  const precios = (a.detalle || []).map((d) => d.precio_por_bulto).filter((x) => x != null);
  const unico = (precios.length && precios.every((x) => x === precios[0])) ? precios[0] : null;
  const bases = new Set((a.detalle || []).map((d) => d.base).filter(Boolean));
  return { total: r2(a.total), precio: unico, items: (a.detalle || []).length,
    // 'bulto' sólo si TODOS los ítems se pagan por bulto. Con uno solo en kilos, la
    // cuenta de la orden ya no es «precio por bulto × cajones».
    base: bases.size === 1 ? [...bases][0] : (bases.size ? 'mixto' : null) };
}

// Las unidades que efectivamente entraron, en la misma unidad en que se pactó. Es
// contra esto que se sabe si la liquidación es por TODO o por una parte.
export function recibidoDeOC(db, ocId) {
  const r = db.prepare(`SELECT COALESCE(SUM(l.bultos),0) AS bultos,
        COALESCE(SUM(l.kg_reales),0) AS kg
      FROM sg_lotes l JOIN sg_oc_items i ON i.id = l.oc_item_id
     WHERE i.oc_id = ? AND l.activo = 1`).get(ocId) || { bultos: 0, kg: 0 };
  return { bultos: Number(r.bultos) || 0, kg: r2(r.kg) };
}

// Las alícuotas que ARCA admite. Cuando la orden no dice a cuál se pactó, no se
// puede elegir una por él: se admiten todas, que es lo único honesto.
const ALICUOTAS = [0, 2.5, 5, 10.5, 21, 27];

// ══ PRECIO CERRADO ES PRECIO CERRADO ═══════════════════════════════════════
//
// Pablo, 26/8/2026: *"liquidación a precio cerrado ES precio cerrado; si hay
// cambio de condición va por MODIFICACIÓN DE LA ORDEN DE COMPRA"*.
//
// Lo que el productor cobra por una partida comprada a precio cerrado no es una
// opinión de la pantalla que arma la liquidación: es el precio de la orden por la
// cantidad que se liquida. Hasta ahora eso se cuidaba SÓLO en el navegador —los
// campos quedaban de sólo lectura— y el servidor aceptaba cualquier número. Un campo
// gris no es un control: la dirección se escribe igual, y el que arma la liquidación
// desde otra pantalla no lo ve.
//
// ── ESTRICTO CON EL NÚMERO, TOLERANTE CON LA LECTURA ─────────────────────────
//
// Lo que se exige es que el número SALGA DE LA ORDEN. Lo que NO se puede exigir es
// una lectura única de esa orden cuando la propia orden no la fija: hay órdenes
// viejas que no guardaron si el precio pactado traía IVA ni con qué alícuota, y
// rechazarlas dejaría partidas imposibles de liquidar — sin salida, porque el camino
// al que este mismo cerrojo manda (modificar la orden de una partida ya recibida)
// todavía no existe.
//
// Así que se arma la LISTA de importes que la orden admite —por bulto o por el total
// pactado, con IVA o sin él, con cada alícuota posible cuando la orden no la dice— y
// se rechaza sólo lo que no es ninguno. Eso frena lo que hay que frenar (alguien
// tipeando un precio distinto del pactado) sin frenar trabajo legítimo.
//
// ══ Y LA MERMA, QUE ES UNA PREGUNTA, NO UNA CUENTA ════════════════════════════
//
// Pablo, 29/8/2026: «en el caso de precio cerrado, efectivamente la liquidación debe
// preguntar si "liquida las mermas" —o sea las incluye en la liquidación, pérdida
// para San Gerónimo— o si no paga esas mermas. Mostralo en las partidas que tengan
// merma y da las dos opciones para el cálculo».
//
// A precio cerrado se pactó un precio por los cajones que se recibieron. Si cinco se
// tiraron, ese precio se le paga igual (lo pierde San Gerónimo) o no se le paga (lo
// pierde el productor). Las dos son legítimas y NINGUNA es la respuesta por defecto:
// son la misma partida cobrada con dos números distintos, y elegir uno acá sería
// decidir de qué bolsillo sale la pérdida sin preguntarle a nadie.
//
// Por eso `mermaLiquidada` no tiene default: con merma y sin respuesta, se frena.
// Devuelve { ok, objetivo, admitidos, ... } o { ok:false, motivo }.
export function objetivoCerrado(db, { ocId, cantidad, incluyeIvaElegido = null,
    mermaLiquidada = null }) {
  const oc = db.prepare(`SELECT id, tipo_precio, precio_incluye_iva, iva_alicuota_oc
    FROM sg_oc WHERE id = ?`).get(ocId);
  if (!oc) return { ok: false, motivo: 'La partida no existe.' };
  if (oc.tipo_precio === 'pizarra') {
    return { ok: false, motivo:
      'Esa partida se compró a PRECIO ABIERTO (pizarra): no hay un precio cerrado que exigirle. '
      + 'Liquidala a precio abierto, o cambiá la condición en la orden de compra.' };
  }
  const { precio, total, items, base } = precioUnicoDeOC(db, ocId);
  if (!(total > 0)) {
    return { ok: false, motivo:
      'La orden no tiene cargado el precio acordado, así que no hay precio cerrado que exigirle. '
      + 'Cargalo en la orden de compra: es de ahí de donde sale lo que cobra el productor.' };
  }
  const recib = recibidoDeOC(db, ocId);
  const cant = Number(cantidad) || 0;
  // ── NO SE LIQUIDA MÁS DE LO QUE ENTRÓ ────────────────────────────────────
  // Un cero de más en «bultos a liquidar» pasaba el cerrojo: precio × 1.000 es un
  // número que sale de la orden, y el cerrojo sólo miraba eso. Le pagaba al productor
  // diez veces la partida y decía que estaba bien.
  // La cantidad viene del campo «bultos a liquidar», así que se mide contra los
  // bultos que entraron. Sólo cuando la mercadería entró PESADA y sin contar cajones
  // —ahí no hay bultos— ese campo lleva kilos y el tope son los kilos.
  const tope = recib.bultos > 0 ? recib.bultos : recib.kg;
  if (cant > 0 && tope > 0 && cant > tope + 1e-6) {
    return { ok: false, motivo:
      'Se están liquidando ' + cant + ' unidades y de esa partida entraron ' + recib.bultos
      + ' bultos (' + recib.kg + ' kg). No se le puede pagar al productor por mercadería '
      + 'que no recibimos.' };
  }
  // ── LA MERMA: DOS CUENTAS, Y HAY QUE ELEGIR UNA ──────────────────────────
  const merma = mermaPorItemDeOC(db, ocId);
  // En la misma unidad que el campo «a liquidar»: bultos cuando se contaron cajones,
  // kilos cuando la mercadería entró pesada.
  const mermaCant = recib.bultos > 0 ? merma.bultos : merma.kg;
  if (merma.hay && mermaLiquidada == null) {
    return { ok: false, motivo:
      'Esta partida tiene ' + mermaCant + (recib.bultos > 0 ? ' bultos' : ' kg')
      + ' de merma y se compró a precio cerrado. Hay que decir si esa merma se le paga '
      + 'al productor —la pérdida la absorbe San Gerónimo— o no se le paga —la absorbe '
      + 'él—: son dos liquidaciones por importes distintos y el sistema no puede elegir '
      + 'por vos.' };
  }
  const sinMermas = merma.hay && mermaLiquidada === false;
  // Lo acordado descontando lo tirado, ítem por ítem y a su propio precio.
  const totalObj = sinMermas ? r2(acordadoDeOC(db, ocId, { sinMermas: true }).total) : total;
  // Lo que se paga y contra qué se prorratea: las dos cosas sin la merma, o las dos
  // con ella. Mezclarlas —pagar sin merma sobre un total con merma— da un tercer
  // número que no es ninguna de las dos opciones.
  const cantPag = sinMermas ? r2(Math.max(0, cant - mermaCant)) : cant;
  const recibPag = sinMermas
    ? { bultos: Math.max(0, recib.bultos - merma.bultos), kg: Math.max(0, r2(recib.kg - merma.kg)) }
    : recib;

  // ── LOS NETOS QUE LA ORDEN ADMITE ────────────────────────────────────────
  const netos = new Set();
  // 1. La partida ENTERA: es el total que calculó acordadoDeOC, con la base que le
  //    corresponde a cada ítem (por bulto los que se pactaron por bulto, por kilo el
  //    resto). Vale siempre que se liquide todo lo que entró — y también cuando no
  //    se dijo cuánto, que es el caso de la mercadería que entró pesada y sin cajones.
  const entera = !(cant > 0) || Math.abs(cant - recib.bultos) < 1e-6
    || Math.abs(cant - recib.kg) < 1e-6;
  if (entera) netos.add(totalObj);
  // 2. Una PARTE, por el precio por unidad de la orden.
  //
  //    Y ACÁ SE ADMITEN LAS DOS LECTURAS DE LA UNIDAD. La orden guarda el precio POR
  //    KILO y la pantalla de la liquidación trabaja POR CAJÓN, multiplicando ese
  //    precio por los kilos NOMINALES del cajón. Cuando la orden se pactó por kilo,
  //    acordadoDeOC usa los kilos REALES —que nunca son los nominales— y los dos
  //    números no coinciden nunca: el operador veía el tilde verde y el servidor le
  //    contestaba 400, sin salida.
  //
  //    Los dos salen de la orden, así que los dos se admiten. Lo que se frena sigue
  //    siendo lo que se frena: un precio que no es el pactado.
  if (cant > 0 && precio != null) netos.add(r2(precio * cantPag));
  if (cant > 0 && base !== 'bulto' && recibPag.bultos > 0) {
    // La cuenta por kilo con la proporción liquidada, que es lo que corresponde
    // cuando se pactó por kilo y se liquida una parte contada en cajones.
    netos.add(r2(totalObj * (cantPag / recibPag.bultos)));
  }
  if (cant > 0 && base !== 'bulto' && recibPag.kg > 0 && Math.abs(cant - recib.kg) > 1e-6) {
    netos.add(r2(totalObj * (cantPag / recibPag.kg)));
  }
  if (!netos.size) {
    return { ok: false, motivo:
      'La orden no tiene un precio por unidad contra el cual controlar esta liquidación '
      + 'parcial. Liquidá la partida entera, o dejá un solo precio en la orden de compra.' };
  }
  // ── ¿EL PRECIO PACTADO TRAE IVA, Y CON QUÉ ALÍCUOTA? ─────────────────────
  // La orden lo dice desde que se agregaron las columnas. Las viejas no, y ahí se
  // admiten las dos lecturas y todas las alícuotas: es más honesto que rechazar una
  // liquidación correcta de una orden vieja.
  const alicOC = (oc.iva_alicuota_oc != null && oc.iva_alicuota_oc !== '')
    ? Number(oc.iva_alicuota_oc) : null;
  const alics = alicOC != null ? [alicOC] : ALICUOTAS;
  const incl = (oc.precio_incluye_iva != null) ? Number(oc.precio_incluye_iva)
    : (incluyeIvaElegido == null ? null : (incluyeIvaElegido ? 1 : 0));
  const admitidos = [];
  for (const n of netos) {
    if (incl !== 0) admitidos.push(r2(n));                       // el precio ya trae el IVA
    if (incl !== 1) for (const a of alics) admitidos.push(r2(n * (1 + a / 100)));
  }
  const dice = incl === 1 ? 'con IVA' : (incl === 0 ? 'sin IVA (se le suma)' : null);
  // El que se muestra en el mensaje es el primero: la lectura que la orden fija, o
  // —si no fija ninguna— la más habitual, que es que el precio ya trae el IVA.
  return { ok: true, objetivo: admitidos[0], admitidos: [...new Set(admitidos)],
    precio, cantidad: cantPag, entera, base, total_orden: totalObj,
    // Para que el mensaje del cerrojo pueda decir por qué el número es ése: sin
    // esto, «cobra $X por la partida entera» sobre una partida con merma descontada
    // manda a revisar la orden de compra, que está bien.
    merma: { hay: merma.hay, cantidad: mermaCant, liquidada: sinMermas ? 0 : (merma.hay ? 1 : null),
      unidad: recib.bultos > 0 ? 'bultos' : 'kg' },
    alicuota: alicOC, dice_iva: dice, recibido: recib };
}

// ══ VARIAS PARTIDAS, UN SOLO PRECIO CERRADO ═══════════════════════════════════
//
// Pablo, 29/8/2026: «si un productor o proveedor tiene 2 o más partidas para liquidar
// debemos poder agruparlas y liquidarlas en una sola liquidación, MANTENIENDO LOS
// PRECIOS Y CANTIDADES DE CADA PARTIDA».
//
// Por eso el objetivo del grupo es la SUMA de los objetivos y no una cuenta nueva:
// cada partida se controla contra SU orden, con su precio, su alícuota y su propia
// respuesta sobre la merma. Un precio promedio del grupo sería un número que no se
// pactó con nadie, y el día que una partida no cierre no se sabría cuál.
//
// Y LOS ADMITIDOS DEL GRUPO SON TODAS LAS SUMAS DE UN ADMITIDO DE CADA PARTIDA. Suena
// raro y es lo correcto: una orden vieja que no dice si el precio traía IVA admite
// varias lecturas, y el grupo tiene que admitir cualquier combinación de lecturas que
// cada orden admite por su cuenta. Si el producto se dispara se corta y queda la
// lectura principal de cada una —la que muestra la pantalla—, que es lo único que se
// puede seguir explicando.
export function objetivoCerradoGrupo(db, partes) {
  const uno = partes.map((p) => objetivoCerrado(db, p));
  const malo = uno.find((o) => !o.ok);
  if (malo) return malo;
  const objetivo = r2(uno.reduce((a, o) => a + o.objetivo, 0));
  let admitidos = [0];
  let corto = false;
  for (const o of uno) {
    if (admitidos.length * o.admitidos.length > 4000) { corto = true; break; }
    const sig = [];
    for (const a of admitidos) for (const b of o.admitidos) sig.push(r2(a + b));
    admitidos = [...new Set(sig)];
  }
  if (corto) admitidos = [objetivo];
  return { ok: true, objetivo, admitidos, partes: uno, grupo: uno.length,
    entera: uno.every((o) => o.entera),
    // Cuál de las partidas no da, para poder nombrarla. Lo llena el que compara.
    total_orden: r2(uno.reduce((a, o) => a + (Number(o.total_orden) || 0), 0)) };
}

// ¿El neto a pagar da lo acordado? `pagar` es fiscal + gestión: es lo que el
// productor efectivamente cobra, y es contra eso que se pactó el precio.
// Un centavo de tolerancia, el mismo que usa la pantalla.
export function cierraContraLoAcordado(pagar, obj) {
  if (!obj || !obj.ok) return false;
  return (obj.admitidos || []).some((x) => Math.abs(r2(pagar) - r2(x)) < 0.01);
}
