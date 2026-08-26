// src/servicios/sg_gestion_vieja.js
//
// ══ QUÉ QUEDÓ GUARDADO CON LA VENTA DE GESTIÓN VIEJA ═══════════════════
//
// Hasta el PR #879, lo resignado en una venta se calculaba restando dos precios ya
// pasados a NETO. Un descuento acordado de $810.000 quedaba guardado como
// $733.031: la empresa registraba haber puesto sobre la mesa un 10,5% menos de lo
// que puso. Sólo pasaba con "el precio incluye IVA" tildado.
//
// El cálculo ya está arreglado. Esto mira lo que quedó ESCRITO ANTES, y NO ESCRIBE
// NADA: es la foto que hay que poder mirar antes de decidir qué se corrige.
//
// ── POR QUÉ NO ALCANZA CON MULTIPLICAR POR 1,105 ─────────────────────────────
// Porque la cuenta vieja, además de sacar el IVA, cortaba el precio unitario a
// cuatro decimales. El caso real guardó 733.031,64 y no 733.031,67; multiplicarlo
// por 1,105 da 809.999,96 — cuatro centavos de menos. El número bueno se REHACE
// desde los precios del renglón del remito, no se estira el viejo.
//
// ── CÓMO SE SABE SI SE FACTURÓ CON IVA ADENTRO ───────────────────────────────
// No lo guarda nadie. Se rehace el neto viejo de las DOS maneras posibles y se
// mira cuál dio. La cuenta vieja era, literal:
//
//     precioNeto = +(precio / (1 + alicuota/100)).toFixed(4)   ← sólo si con IVA
//     neto       = round(kg * precioNeto, 2)
//
// Reproducirla exacta es más fuerte que mirar el cociente kg×precio/neto: si
// NINGUNA de las dos da, es que el precio facturado no es el del remito —la
// pantalla de "Facturar remitos" deja pisarlo— y ese renglón NO se puede
// reconstruir solo. Esos salen marcados y con el valor nuevo en null, a propósito:
// así nadie puede tomar esta salida y hacer un UPDATE que le ponga cero a un
// renglón que en realidad no se sabe cuánto vale.
//
// ── LO QUE NO SE MIRA, PORQUE ESTÁ BIEN ──────────────────────────────────────
// sg_factura_despachos.neto y .iva. Suman exacto el neto y el IVA del comprobante
// que tiene AFIP. Tienen centavos feos por el corte de decimales, pero tocarlos
// rompería lo único que ata esas filas al papel emitido.

// El redondeo del repo, para que la cuenta de acá sea la misma que la de allá.
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// La cuenta NUEVA, la misma que gestionDeLinea() en rutas/sg.js: los pesos que se
// resignaron, sin sacarles ningún IVA, y cero si no hubo acuerdo.
export function gestionCorrecta({ kg, precio_por_kg, precio_lista_por_kg }) {
  const bruto = r2(Number(kg || 0) * Number(precio_por_kg || 0));
  if (precio_lista_por_kg == null) return 0;
  const listaR2 = r2(precio_lista_por_kg), brutoR2 = r2(precio_por_kg);
  if (!(listaR2 > brutoR2)) return 0;
  const lista = r2(Number(kg || 0) * Number(precio_lista_por_kg));
  const g = r2(lista - bruto);
  return g > 0 ? g : 0;
}

// Cómo se facturó ese renglón, reproduciendo la cuenta vieja. Devuelve
// 'con_iva' | 'sin_iva' | 'no_reconstruible'.
export function modoDeLinea({ kg, neto, precio_por_kg, alicuota }) {
  const k = Number(kg || 0), p = Number(precio_por_kg || 0), n = Number(neto || 0);
  const a = (alicuota == null) ? null : Number(alicuota);
  if (!(k > 0) || !(p > 0)) return 'no_reconstruible';
  if (a != null) {
    const netoConIva = r2(k * +(p / (1 + a / 100)).toFixed(4));
    if (Math.abs(n - netoConIva) <= 0.02) return 'con_iva';
  }
  if (Math.abs(n - r2(k * p)) <= 0.02) return 'sin_iva';
  return 'no_reconstruible';
}

// ══ ¿ESTE COMPROBANTE VALE PLATA DE VERDAD? ════════════════════════════
//
// La primera corrida de esto le mostró a Pablo "$308.438,86 registrados de menos"
// en letras grandes, y eran TODOS comprobantes de prueba: punto de venta manual
// (no le informa nada a AFIP, no tiene CAE) y homologación (el AFIP de prueba).
// Ninguno era una factura fiscal. La plata no era de ningún cliente.
//
// Un diagnóstico que mezcla las dos cosas es peor que no tenerlo: la primera vez
// asusta de más, y la vez que de verdad haya una diferencia real escondida entre
// veinte pruebas, no se va a ver.
//
// Fiscal de verdad es: emitido contra el AFIP de producción y autorizado con CAE.
// Todo lo demás —manual, homologación, marcado como prueba— es del circuito.
export function esFiscalReal(f) {
  if (Number(f.es_prueba) === 1) return false;
  const est = String(f.afip_estado || '');
  if (est.startsWith('MANUAL')) return false;
  if (String(f.ambiente || '') === 'homologacion') return false;
  if (String(f.numero || '').startsWith('AFIPH-') || String(f.numero || '').startsWith('MANUAL-')) return false;
  return est === 'autorizado' && !!f.cae;
}

// ── EL DIAGNÓSTICO ──────────────────────────────────────────────────────────
// Recibe la base por parámetro: así se puede correr contra una de prueba sin
// levantar el servidor (test/gestion_vieja.test.mjs).
export function diagnosticoGestion(db) {
  const renglones = db.prepare(`
    SELECT fd.id AS fd_id, fd.factura_id, fd.despacho_item_id, fd.kg, fd.neto, fd.iva,
           COALESCE(fd.gestion,0) AS gestion_guardada,
           di.precio_por_kg, di.precio_lista_por_kg,
           COALESCE(pr.iva_alicuota, fam.iva_alicuota) AS alicuota,
           pr.nombre AS producto, l.codigo_lote,
           f.numero, f.fecha, f.estado, f.afip_estado, f.total, f.ambiente,
           COALESCE(f.es_prueba,0) AS es_prueba, f.cae,
           COALESCE(f.dif_gestion,0) AS dif_gestion, f.dif_motivo, f.asiento_id,
           c.id AS cliente_id, c.razon_social AS cliente
      FROM sg_factura_despachos fd
      JOIN sg_ven_facturas f ON f.id = fd.factura_id
      LEFT JOIN sg_clientes c ON c.id = f.cliente_id
      LEFT JOIN sg_despacho_items di ON di.id = fd.despacho_item_id
      LEFT JOIN sg_lotes l ON l.id = di.lote_id
      LEFT JOIN sg_productos pr ON pr.id = di.producto_id
      LEFT JOIN sg_familias fam ON fam.id = pr.familia_id
     ORDER BY f.fecha, f.id, fd.id`).all();

  const porFactura = new Map();
  const filas = [];
  for (const r of renglones) {
    const modo = r.despacho_item_id == null ? 'no_reconstruible' : modoDeLinea(r);
    const nueva = modo === 'no_reconstruible' ? null : gestionCorrecta(r);
    const dif = nueva == null ? null : r2(nueva - r.gestion_guardada);
    const fila = { ...r, modo, gestion_nueva: nueva, diferencia: dif,
      // Sólo se propone corregir lo que se pudo reconstruir Y cambia de verdad.
      accion: modo === 'no_reconstruible' ? 'revisar_a_mano'
            : (dif && Math.abs(dif) > 0.01 ? 'corregible' : 'ya_esta_bien') };
    filas.push(fila);
    if (!porFactura.has(r.factura_id)) {
      porFactura.set(r.factura_id, { factura_id: r.factura_id, numero: r.numero, fecha: r.fecha,
        cliente: r.cliente, cliente_id: r.cliente_id, estado: r.estado, afip_estado: r.afip_estado,
        total: r.total, dif_gestion: r.dif_gestion, dif_motivo: r.dif_motivo,
        asiento_id: r.asiento_id, renglones: [], suma_nueva: 0, hay_dudoso: false });
    }
    const f = porFactura.get(r.factura_id);
    if (f.fiscal === undefined) f.fiscal = esFiscalReal(r);
    f.renglones.push(fila);
    if (nueva == null) f.hay_dudoso = true; else f.suma_nueva = r2(f.suma_nueva + nueva);
  }

  // Por comprobante. Si UNO solo de sus renglones no se pudo reconstruir, el total
  // de la factura tampoco: se marca para mirar a mano en vez de proponer un número
  // que sale de sumar lo que se sabe con lo que no.
  const comprobantes = [...porFactura.values()].map((f) => {
    const nueva = f.hay_dudoso ? null : f.suma_nueva;
    const dif = nueva == null ? null : r2(nueva - f.dif_gestion);
    return { ...f, dif_gestion_nueva: nueva, diferencia: dif,
      accion: f.hay_dudoso ? 'revisar_a_mano'
            : (dif && Math.abs(dif) > 0.01 ? 'corregible' : 'ya_esta_bien') };
  });

  // LAS QUE NO TIENEN NINGÚN RENGLÓN. dif_gestion se escribe ANTES de llamar a
  // AFIP y el puente factura↔despacho sólo después de que autoriza: una rechazada
  // queda con el número cargado y sin con qué reconstruirlo.
  const huerfanas = db.prepare(`
    SELECT f.id AS factura_id, f.numero, f.fecha, f.estado, f.afip_estado,
           COALESCE(f.dif_gestion,0) AS dif_gestion, c.razon_social AS cliente
      FROM sg_ven_facturas f LEFT JOIN sg_clientes c ON c.id = f.cliente_id
     WHERE ROUND(COALESCE(f.dif_gestion,0),2) <> 0
       AND NOT EXISTS (SELECT 1 FROM sg_factura_despachos fd WHERE fd.factura_id = f.id)
     ORDER BY f.fecha, f.id`).all();

  // ── LO QUE NO SE ARREGLA CON UN UPDATE ────────────────────────────────────
  // Si la partida YA se liquidó al productor, el número corto quedó impreso en un
  // comprobante que se le emitió a un tercero, con su asiento y quizás ya pagado.
  // Eso no se corrige por dentro: se lista y se avisa.
  const corregibles = comprobantes.filter((c) => c.accion === 'corregible');
  const fdCorregibles = corregibles.flatMap((c) => c.renglones)
    .filter((r) => r.accion === 'corregible').map((r) => r.fd_id);
  let liquidaciones = [];
  if (fdCorregibles.length) {
    const marcas = fdCorregibles.map(() => '?').join(',');
    try {
      liquidaciones = db.prepare(`
        SELECT DISTINCT lq.id, lq.n_liquidacion, COALESCE(lq.dif_gestion,0) AS dif_gestion,
               lq.asiento_id, lq.total
          FROM liquidaciones lq
          JOIN sg_oc_items i ON i.oc_id = lq.oc_id
          JOIN sg_lotes l ON l.oc_item_id = i.id AND l.activo = 1
          JOIN sg_despacho_items di ON di.lote_id = l.id
          JOIN sg_factura_despachos fd ON fd.despacho_item_id = di.id
         WHERE lq.eliminado_en IS NULL AND fd.id IN (${marcas})`).all(...fdCorregibles);
    } catch (e) {
      // La tabla de liquidaciones es de otro módulo: si cambia de forma, el
      // diagnóstico no se cae — dice que esa parte no se pudo mirar.
      liquidaciones = [{ error: e.message }];
    }
  }

  // Y qué facturas quedarían con saldo reabierto: subir dif_gestion sube la deuda,
  // y una marcada 'cobrada' con pendiente > 0 no aparece en ninguna pantalla de
  // cobro. La deuda existiría y nadie la vería.
  const reabren = corregibles.filter((c) => (c.diferencia || 0) > 0.01 && c.estado === 'cobrada')
    .map((c) => ({ factura_id: c.factura_id, numero: c.numero, cliente: c.cliente,
      reabre: c.diferencia, fiscal: c.fiscal }));

  const suma = (xs, k) => r2(xs.reduce((a, x) => a + (Number(x[k]) || 0), 0));
  // LA PLATA SE CUENTA SEPARADA. La de los comprobantes fiscales es la que le
  // corresponde a alguien; la del circuito de prueba no es de nadie.
  const corrFiscal = corregibles.filter((c) => c.fiscal);
  const corrPrueba = corregibles.filter((c) => !c.fiscal);
  const aMano = comprobantes.filter((c) => c.accion === 'revisar_a_mano');
  return {
    renglones: filas,
    comprobantes,
    huerfanas,
    liquidaciones,
    reabren,
    resumen: {
      renglones_mirados: filas.length,
      comprobantes_mirados: comprobantes.length,
      corregibles: corrFiscal.length,
      corregibles_prueba: corrPrueba.length,
      // "A mano" con CERO guardado no es un problema: no hay nada que corregir
      // salvo que debiera haber tenido un descuento, y eso no lo sabe nadie.
      // Contarlos juntos con los que sí tienen plata infla la alarma.
      a_mano: aMano.filter((c) => Math.abs(Number(c.dif_gestion) || 0) > 0.01).length,
      a_mano_en_cero: aMano.filter((c) => Math.abs(Number(c.dif_gestion) || 0) <= 0.01).length,
      ya_estaban_bien: comprobantes.filter((c) => c.accion === 'ya_esta_bien').length,
      huerfanas: huerfanas.length,
      // Cuánta plata está en juego: lo que se registró de menos como resignado, y
      // que es lo que el cliente debía de más y lo que al productor se le liquidó
      // de menos.
      diferencia_total: suma(corrFiscal, 'diferencia'),
      diferencia_prueba: suma(corrPrueba, 'diferencia'),
      liquidaciones_afectadas: Array.isArray(liquidaciones) ? liquidaciones.filter((l) => !l.error).length : 0,
      saldos_que_reabren: reabren.filter((r) => r.fiscal).length,
    },
  };
}
