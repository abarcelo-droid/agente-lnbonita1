// ══ CONTRA QUÉ MITAD VA CADA MEDIO DE COBRO ════════════════════════════════════════════
//
// Pablo, 27/8/2026: «la forma de pago tiene que viajar en cada renglón de plata».
//
// Es además la regla del repo: **el ámbito viaja en la LÍNEA, nunca en el recipiente**.
//
// Hasta acá se elegía UNA vez para toda la cobranza y la parte de gestión se repartía
// entre los medios EN PROPORCIÓN al importe. No había forma de decir «estos 10.000 son lo
// facturado y entraron en efectivo, y estos otros 10.000 son los de gestión y vinieron por
// transferencia»: había que cargar dos cobranzas para lo que el cliente vivió como un solo
// pago, y quedaban dos números donde hubo una sola conversación.
//
// Vive acá y no adentro del router porque es ARITMÉTICA DE PLATA: un centavo que se pierde
// en el reparto es un asiento que no balancea, y eso se prueba corriéndolo, no leyéndolo.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const AMBITOS = ['fiscal', 'gestion'];

// Normaliza lo que declaró un medio. Vacío es «lo que toque» —el reparto proporcional de
// siempre— y NO un error: la venta de ventanilla y el payload viejo no lo mandan, y tienen
// que seguir funcionando igual.
export function ambitoDeMedio(m) {
  const a = String((m && m.ambito) || '');
  return AMBITOS.includes(a) ? a : null;
}

// ── EL REPARTO ─────────────────────────────────────────────────────────────────────────
//
// Devuelve, por cada medio, cuánto de su importe cancela la parte SIN comprobante. Lo que
// declaró cada uno manda; lo que quedó libre se prorratea entre los que no dijeron nada.
//
// `ges` es cuánto de ESTA cobranza corresponde a la mitad sin comprobante, y sale de las
// imputaciones contra los documentos. `total` es lo que entró.
//
// Tira si lo declarado no entra: declarar más gestión de la que el comprobante tiene
// pendiente sin facturar dejaría el libro de gestión con un cobro por algo que nadie debía,
// y el error tiene que llegar ANTES de escribir nada.
export function repartirAmbito(medios, ges, total) {
  const lista = Array.isArray(medios) ? medios : [];
  const G = r2(ges), T = r2(total);
  const fisTotal = r2(T - G);

  const gesDecl = r2(lista.filter((m) => ambitoDeMedio(m) === 'gestion')
    .reduce((a, m) => a + r2(m.monto), 0));
  const fisDecl = r2(lista.filter((m) => ambitoDeMedio(m) === 'fiscal')
    .reduce((a, m) => a + r2(m.monto), 0));

  if (gesDecl > G + 0.01) {
    throw new Error('Estás cobrando ' + gesDecl + ' contra la parte sin facturar, y de esta '
      + 'cobranza sólo ' + G + ' corresponden a esa mitad.');
  }
  if (fisDecl > fisTotal + 0.01) {
    throw new Error('Estás cobrando ' + fisDecl + ' contra lo facturado, y de esta cobranza '
      + 'sólo ' + fisTotal + ' corresponden a esa mitad.');
  }

  const sinDecl = lista.filter((m) => !ambitoDeMedio(m));
  const montoSin = r2(sinDecl.reduce((a, m) => a + r2(m.monto), 0));
  const gesLibre = r2(G - gesDecl);

  let repartido = 0, vistos = 0;
  return lista.map((m) => {
    const a = ambitoDeMedio(m), monto = r2(m.monto);
    if (a === 'gestion') return monto;
    if (a === 'fiscal') return 0;
    vistos++;
    // EL ÚLTIMO SE LLEVA EL RESTO DE REDONDEO. Si no, la suma de las partes no da el total
    // y falta o sobra un centavo que después nadie encuentra. Es el mismo criterio que usa
    // el reparto del neto de una factura entre varias partidas.
    let g = (vistos === sinDecl.length)
      ? r2(gesLibre - repartido)
      : (montoSin > 0 ? r2(gesLibre * (monto / montoSin)) : 0);
    if (g < 0) g = 0;
    if (g > monto) g = monto;      // un medio no puede cancelar más gestión que su importe
    repartido = r2(repartido + g);
    return g;
  });
}

// Las dos mitades de un medio, listas para el asiento y para el movimiento de la cuenta.
// La de gestión no sale sin motivo: una línea de gestión sin motivo no entra al asiento.
export function partesDeMedio(monto, gesM, motivoGes) {
  return [
    { ambito: 'fiscal', monto: r2(r2(monto) - r2(gesM)), motivo: null },
    { ambito: 'gestion', monto: r2(gesM), motivo: motivoGes },
  ].filter((x) => x.monto > 0.001);
}
