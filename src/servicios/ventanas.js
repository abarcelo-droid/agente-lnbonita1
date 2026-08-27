// src/servicios/ventanas.js
// ── VENTANAS: DE QUIÉN VENDIMOS CADA PRODUCTO, Y CUÁNDO ───────────────────────────────
// Se elige un producto y se ve, mes a mes de la campaña, de qué proveedor vino la mercadería
// que vendimos. Cada proveedor tiene su VENTANA —arranca, pega el pico, se apaga— y el año
// que viene esa ventana se corre. Saber cuánto se corrió es lo que permite planificar la
// compra en vez de reaccionar cuando ya falta.
//
// ── POR QUÉ EL EJE ES EL MES Y NO LA SEMANA ───────────────────────────────────────────
// La columna `sem` existe en sheet_ventas (viene de la planilla, columna P) pero NO está
// verificado si es semana ISO del calendario o semana de campaña. Un eje de tiempo mal
// interpretado no falla: corre todas las ventanas unas semanas y el informe queda diciendo
// que un proveedor arranca cuando no arranca, que es exactamente la conclusión que este
// informe existe para dar. `mes_ok` en cambio viene CALCULADO de la planilla con el criterio
// del negocio (julio a junio), es el eje del resto del módulo, y no hay nada que adivinar.
// Cuando `sem` esté verificada, el eje semanal entra sin tocar el resto: es una columna más.
//
// ── QUÉ ES `proveedor` ACÁ ────────────────────────────────────────────────────────────
// El ORIGEN DE LA MERCADERÍA de la línea de venta, no una operación de compra. Es la misma
// aclaración que hace el informe de oportunidades, y por el mismo motivo: no hay libro de
// compras en esta base.
//
// Reglas de escritura de SQL, iguales a las de servicios/oportunidades.js:
//   1. el `where` va SIEMPRE en un `WITH base AS (...)` al principio;
//   2. ningún alias se llama como una columna real de sheet_ventas.
//
// La db entra por parámetro: así los tests corren con node:sqlite.

// El año comercial va de julio a junio, y los meses de la planilla vienen numerados para que
// el orden alfabético dé el orden del negocio ('01-JULIO' … '12-JUN'). El eje del gráfico son
// los DOCE, existan o no en los datos: una ventana se entiende por dónde NO hay nada tanto
// como por dónde hay, y un eje que arranca en el primer mes con ventas hace que todos los
// productos parezcan empezar en el mismo lugar.
export function ejeMeses(db, where, params) {
  const filas = db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where})
    SELECT DISTINCT mes_ok FROM base WHERE mes_ok IS NOT NULL AND mes_ok <> '' ORDER BY mes_ok
  `).all(...params).map(r => r.mes_ok);
  return filas;
}

const r0 = (n) => Math.round(Number(n) || 0);
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
// '02-AGOSTO' → 2. Sirve para medir cuánto se corrió una ventana de un año al otro.
const nroMes = (m) => { const x = /^(\d\d)-/.exec(String(m || '')); return x ? parseInt(x[1], 10) : null; };

// Los productos que más se venden, para ofrecerlos cuando todavía no se eligió ninguno.
// Sin esto la pantalla arranca con un campo vacío y hay que saber de memoria qué escribir.
export function productosMasVendidos(db, where, params, limite) {
  const n = Math.min(Math.max(parseInt(limite, 10) || 12, 1), 60);
  return db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where})
    SELECT producto,
           ROUND(SUM(kilos_tot), 0) AS kilos,
           ROUND(SUM(tot_dol), 0)   AS usd,
           COUNT(DISTINCT proveedor) AS proveedores
    FROM base
    WHERE producto IS NOT NULL AND producto <> ''
    GROUP BY producto
    ORDER BY SUM(kilos_tot) DESC
    LIMIT ?
  `).all(...params, n);
}

// La ventana de cada proveedor para un producto.
//
// `periodoActual` es la campaña que se dibuja llena. `periodoAnterior` (opcional) se dibuja
// como contorno atrás: es la única forma de ver que una ventana se corrió, que es la pregunta
// que sigue a "quién me lo trae".
export function ventanasDeProducto(db, where, params, opciones) {
  const o = opciones || {};
  const act = o.periodo_actual;
  const ant = o.periodo_anterior || null;
  const meses = ejeMeses(db, where, params);

  const filas = db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where})
    SELECT COALESCE(NULLIF(proveedor, ''), '(sin proveedor)') AS proveedor,
           periodo, mes_ok,
           ROUND(SUM(kilos_tot), 0) AS kilos,
           ROUND(SUM(tot_dol), 0)   AS usd,
           COUNT(DISTINCT cliente)  AS clientes
    FROM base
    WHERE mes_ok IS NOT NULL AND mes_ok <> ''
    GROUP BY proveedor, periodo, mes_ok
  `).all(...params);

  const prov = new Map();
  const totMes = {};      // el total del producto por mes, para la fila de abajo
  for (const f of filas) {
    if (!prov.has(f.proveedor)) {
      prov.set(f.proveedor, { proveedor: f.proveedor, por_mes: {}, prev_por_mes: {},
                              kilos: 0, usd: 0, kilos_prev: 0 });
    }
    const p = prov.get(f.proveedor);
    if (f.periodo === act) {
      p.por_mes[f.mes_ok] = { kilos: r0(f.kilos), usd: r0(f.usd), clientes: f.clientes };
      p.kilos += f.kilos || 0;
      p.usd += f.usd || 0;
      totMes[f.mes_ok] = (totMes[f.mes_ok] || 0) + (f.kilos || 0);
    } else if (ant && f.periodo === ant) {
      p.prev_por_mes[f.mes_ok] = { kilos: r0(f.kilos), usd: r0(f.usd) };
      p.kilos_prev += f.kilos || 0;
    }
  }

  const totalKilos = Object.values(totMes).reduce((a, x) => a + x, 0);

  // El primer y el último mes con ventas: eso ES la ventana.
  const bordes = (m) => {
    const con = meses.filter(x => (m[x] || {}).kilos > 0);
    return con.length ? { desde: con[0], hasta: con[con.length - 1] } : { desde: null, hasta: null };
  };

  let salida = [...prov.values()].map(p => {
    const b = bordes(p.por_mes);
    const bp = bordes(p.prev_por_mes);
    // El pico: el mes en que ese proveedor más pesó. Es dónde hay que estar, no el promedio.
    let pico = null, picoKilos = 0;
    for (const m of meses) {
      const k = (p.por_mes[m] || {}).kilos || 0;
      if (k > picoKilos) { picoKilos = k; pico = m; }
    }
    // Cuánto se corrió el arranque contra la campaña anterior, en meses. Negativo = arrancó
    // antes. Sólo se calcula si las dos campañas tienen ventana: comparar contra la nada
    // daría un número que parece un corrimiento y es una alta o una baja.
    const na = nroMes(b.desde), nb = nroMes(bp.desde);
    const corrimiento = (na != null && nb != null) ? (na - nb) : null;
    return {
      proveedor: p.proveedor,
      por_mes: p.por_mes, prev_por_mes: p.prev_por_mes,
      kilos: r0(p.kilos), usd: r0(p.usd), kilos_prev: r0(p.kilos_prev),
      var_kilos_pct: p.kilos_prev ? r1((p.kilos - p.kilos_prev) * 100 / Math.abs(p.kilos_prev)) : null,
      share_pct: totalKilos ? r1(p.kilos * 100 / totalKilos) : null,
      desde: b.desde, hasta: b.hasta,
      desde_prev: bp.desde, hasta_prev: bp.hasta,
      corrimiento,
      // Cuántos meses dura la ventana. Una de dos meses y una de siete no se compran igual.
      meses_activo: meses.filter(m => (p.por_mes[m] || {}).kilos > 0).length,
      pico, pico_kilos: picoKilos,
      // Sólo tiene historia: este año no trajo nada. No es lo mismo que un proveedor chico.
      solo_anterior: p.kilos <= 0 && p.kilos_prev > 0,
      es_nuevo: p.kilos > 0 && p.kilos_prev <= 0,
    };
  });

  // Los que trajeron algo primero, de mayor a menor. Los que sólo tienen historia van al
  // final: siguen siendo información —"a este lo perdimos"— pero no son la foto de hoy.
  salida.sort((a, b) => (Number(a.solo_anterior) - Number(b.solo_anterior)) || (b.kilos - a.kilos));

  const totales = {};
  for (const m of meses) totales[m] = r0(totMes[m] || 0);
  let picoMes = null, picoTot = 0;
  for (const m of meses) if ((totales[m] || 0) > picoTot) { picoTot = totales[m]; picoMes = m; }

  return {
    meses, filas: salida, totales,
    total_kilos: r0(totalKilos),
    total_usd: r0(salida.reduce((a, x) => a + x.usd, 0)),
    proveedores: salida.filter(x => !x.solo_anterior).length,
    proveedores_perdidos: salida.filter(x => x.solo_anterior).length,
    pico_mes: picoMes, pico_kilos: r0(picoTot),
    // El techo del gráfico. Sale del máximo de UNA celda y no del total del mes: las barras
    // son por proveedor, y escalarlas contra el total del mes dejaría a todas aplastadas
    // cuando hay muchos proveedores en el mismo mes.
    max_celda: r0(salida.reduce((mx, p) => Math.max(mx,
      ...meses.map(m => Math.max((p.por_mes[m] || {}).kilos || 0, (p.prev_por_mes[m] || {}).kilos || 0))), 0)),
    periodo_actual: act, periodo_anterior: ant,
  };
}
