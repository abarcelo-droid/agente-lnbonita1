// src/servicios/ventanas.js
// ── VENTANAS: A QUÉ PRODUCTOR HAY QUE SALIR A CONTACTAR ───────────────────────────────
// Se elige un producto y se ve, mes a mes, qué productores nos lo trajeron A LO LARGO DE
// TODOS LOS AÑOS cargados. Cada uno tiene su ventana —arranca, pega el pico, se apaga— y la
// pregunta que contesta la pantalla no es "cómo venimos" sino "a quién tengo que llamar".
//
// POR ESO SE MIRAN TODOS LOS AÑOS Y NO DOS. Un productor que nos trajo en 2022, 2023 y 2024 y
// este año no aparece es exactamente el que hay que ir a buscar — y comparando sólo contra la
// campaña anterior es invisible si el año pasado tampoco vino. La historia larga es el dato:
// dice en qué mes suele arrancar cada uno, cuántos años seguidos trabajó, y desde cuándo no
// está.
//
// ── LA CAMPAÑA DE REFERENCIA NO ES LA QUE ESTÁ CORRIENDO ──────────────────────────────
// Preguntarle a una campaña recién arrancada quién falta da una lista de falsos: en agosto,
// el que trae de noviembre a mayo TODAVÍA NO LE TOCA. En la pantalla real eran 16 "a
// contactar" sobre un producto donde faltaban tres.
//
// Por eso la referencia es la última campaña COMPLETA, y si alguien igual elige mirar la que
// está corriendo, sólo se marca al que YA debería haber traído: los que su ventana típica
// cierra antes del último mes cargado. Al resto no se lo llama, se lo espera — y la pantalla
// dice cuántos son.
//
// ── QUÉ ES `proveedor` ACÁ ────────────────────────────────────────────────────────────
// El ORIGEN DE LA MERCADERÍA de la línea de venta, no una operación de compra propia: esta
// base no tiene libro de compras. Es la misma aclaración que hace el informe de
// oportunidades, y por el mismo motivo.
//
// ── LOS #N/A DE LA PLANILLA ───────────────────────────────────────────────────────────
// La columna llega con errores de fórmula adentro ("#N/A (Did not find value '12640234...").
// No son proveedores: son búsquedas que fallaron en la planilla. Cada uno trae una clave
// distinta, así que sin juntarlos aparecen como OCHO proveedores diferentes y tapan a los de
// verdad. Se agrupan en una sola fila y se dice cuánto volumen quedó sin atribuir — tirarlos
// en silencio escondería una parte de la mercadería, y dejarlos sueltos hace la pantalla
// ilegible.
//
// Reglas de escritura de SQL, iguales a las de servicios/oportunidades.js:
//   1. el `where` va SIEMPRE en un `WITH base AS (...)` al principio;
//   2. ningún alias se llama como una columna real de sheet_ventas.
//
// La db entra por parámetro: así los tests corren con node:sqlite.

export const SIN_IDENTIFICAR = '(sin identificar en la planilla)';

// Un error de fórmula de Excel, no un nombre. Se detecta por el prefijo de error y por el
// texto que Sheets mete cuando un BUSCARV no encuentra la clave.
const RE_ERROR_PLANILLA = /^\s*#(N\/A|REF!|VALUE!|NAME\?|DIV\/0!|NULL!|NUM!)/i;
export function esProveedorNoIdentificado(p) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return true;
  return RE_ERROR_PLANILLA.test(s) || /Did not find value/i.test(s);
}
const nombreProveedor = (p) => (esProveedorNoIdentificado(p) ? SIN_IDENTIFICAR : String(p).trim());

const r0 = (n) => Math.round(Number(n) || 0);
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
// '02-AGOSTO' → 2. El número está para ordenar y para medir corrimientos.
const nroMes = (m) => { const x = /^(\d\d)-/.exec(String(m || '')); return x ? parseInt(x[1], 10) : null; };

// Los meses con ventas, en orden comercial (julio primero). El número adelante que trae la
// planilla hace que ordenar por texto dé el orden del negocio.
export function ejeMeses(db, where, params) {
  return db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where})
    SELECT DISTINCT mes_ok FROM base WHERE mes_ok IS NOT NULL AND mes_ok <> '' ORDER BY mes_ok
  `).all(...params).map(r => r.mes_ok);
}

// Los productos que más se venden, para ofrecerlos cuando todavía no se eligió ninguno.
export function productosMasVendidos(db, where, params, limite) {
  const n = Math.min(Math.max(parseInt(limite, 10) || 12, 1), 60);
  return db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where})
    SELECT producto,
           ROUND(SUM(kilos_tot), 0) AS kilos,
           ROUND(SUM(tot_dol), 0)   AS usd,
           COUNT(DISTINCT proveedor) AS proveedores,
           COUNT(DISTINCT periodo)   AS campanias
    FROM base
    WHERE producto IS NOT NULL AND producto <> ''
    GROUP BY producto
    ORDER BY SUM(kilos_tot) DESC
    LIMIT ?
  `).all(...params, n);
}

// La historia completa de un producto: quién lo trajo, en qué mes y en qué campaña.
//
// `periodo_actual` es la campaña que se considera "este año" para decidir a quién falta. El
// resto es historia, y toda la historia cuenta por igual para dibujar la ventana típica.
export function ventanasDeProducto(db, where, params, opciones) {
  const o = opciones || {};
  // Hasta qué mes llegó la campaña de referencia. Lo calcula el router mirando TODA la base
  // —no este producto— porque la pregunta es dónde está parado el año, y un producto que no
  // se vende en marzo no quiere decir que marzo no haya pasado. Vacío = la campaña terminó.
  const hastaMes = o.hasta_mes || null;
  // Y las campañas DEL NEGOCIO, también de toda la base. "Hace 3 campañas que no trae" se
  // cuenta en años, como los cuenta una persona. Contra las campañas de este producto, si un
  // año no vendimos palta el hueco desaparece del conteo y el número queda más chico de lo
  // que el que lo lee entiende. Si no viene, se cae a las del producto.
  const todas = (o.periodos_todos && o.periodos_todos.length) ? o.periodos_todos.slice().sort() : null;
  // Y los meses del AÑO COMERCIAL entero, también de toda la base. Una ventana se entiende
  // por dónde NO hay nada tanto como por dónde hay: con el eje recortado a los meses en que
  // este producto se vende, el melón muestra JUL, AGO, NOV y MAY pegados y parece que se
  // vende todo el año. Los huecos son la mitad del dato. Si no viene, se cae a los del
  // producto.
  const mesesTodos = (o.meses_todos && o.meses_todos.length) ? o.meses_todos.slice().sort() : null;

  const filas = db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where})
    SELECT proveedor, periodo, mes_ok,
           ROUND(SUM(kilos_tot), 0) AS kilos,
           ROUND(SUM(tot_dol), 0)   AS usd,
           COUNT(DISTINCT cliente)  AS clientes
    FROM base
    WHERE mes_ok IS NOT NULL AND mes_ok <> ''
      AND periodo IS NOT NULL AND periodo <> ''
    GROUP BY proveedor, periodo, mes_ok
  `).all(...params);

  const meses = mesesTodos || [...new Set(filas.map(f => f.mes_ok))].sort();
  const periodos = [...new Set(filas.map(f => f.periodo))].sort();
  // Si no se dijo cuál es "este año", se toma la campaña más nueva que haya.
  const act = (o.periodo_actual && periodos.includes(o.periodo_actual))
    ? o.periodo_actual : periodos[periodos.length - 1];

  const prov = new Map();
  const totMes = {};        // el perfil del producto entero, mes a mes (toda la historia)
  const totMesAct = {};     // y el de la campaña en curso
  for (const f of filas) {
    const nombre = nombreProveedor(f.proveedor);
    if (!prov.has(nombre)) {
      prov.set(nombre, {
        proveedor: nombre, por_mes: {}, por_periodo: {}, mes_periodo: new Set(),
        kilos_hist: 0, usd_hist: 0, kilos_act: 0,
      });
    }
    const p = prov.get(nombre);
    // El acumulado histórico de ese mes, y en cuántas campañas distintas trajo ESE mes: la
    // diferencia entre "vino todos los años en noviembre" y "vino una vez y fue casualidad".
    const m = p.por_mes[f.mes_ok] || (p.por_mes[f.mes_ok] = { kilos: 0, usd: 0, anios: 0, kilos_act: 0 });
    m.kilos += f.kilos || 0;
    m.usd += f.usd || 0;
    const clave = f.mes_ok + '|' + f.periodo;
    if (!p.mes_periodo.has(clave)) { p.mes_periodo.add(clave); m.anios++; }
    if (f.periodo === act) m.kilos_act += f.kilos || 0;

    p.por_periodo[f.periodo] = (p.por_periodo[f.periodo] || 0) + (f.kilos || 0);
    p.kilos_hist += f.kilos || 0;
    p.usd_hist += f.usd || 0;
    if (f.periodo === act) p.kilos_act += f.kilos || 0;

    totMes[f.mes_ok] = (totMes[f.mes_ok] || 0) + (f.kilos || 0);
    if (f.periodo === act) totMesAct[f.mes_ok] = (totMesAct[f.mes_ok] || 0) + (f.kilos || 0);
  }

  const bordes = (m, campo) => {
    const con = meses.filter(x => ((m[x] || {})[campo] || 0) > 0);
    return con.length ? { desde: con[0], hasta: con[con.length - 1], cuantos: con.length }
                      : { desde: null, hasta: null, cuantos: 0 };
  };

  let salida = [...prov.values()].map(p => {
    const anios = Object.keys(p.por_periodo).filter(x => p.por_periodo[x] > 0).sort();
    const hist = bordes(p.por_mes, 'kilos');
    const ahora = bordes(p.por_mes, 'kilos_act');
    // El mes en que ese productor más pesa históricamente: es cuándo conviene tenerlo.
    let pico = null, picoKilos = 0;
    for (const m of meses) {
      const k = (p.por_mes[m] || {}).kilos || 0;
      if (k > picoKilos) { picoKilos = k; pico = m; }
    }
    // Sólo la historia HASTA la campaña que se está mirando. Si se mira una campaña vieja,
    // todo lo posterior es futuro: un productor que recién aparece dos años después no es
    // alguien a quien había que llamar entonces, y marcarlo sería leer el diario de mañana.
    const previos = anios.filter(x => x <= act);
    // ¿Ya le tocaba traer? Si la campaña de referencia está a medio correr, sólo cuenta el
    // que debería haber cerrado su ventana y no apareció. El que arranca en noviembre, en
    // agosto no está ausente: está esperando.
    const leTocaba = !hastaMes || !hist.hasta || hist.hasta <= hastaMes;
    const ultimo = previos[previos.length - 1] || null;
    const ausente = (p.kilos_act || 0) <= 0;
    // Cuántas campañas atrás quedó. 0 = está trabajando este año.
    const escala = todas || periodos;
    const hace = (ultimo && escala.indexOf(act) >= 0 && escala.indexOf(ultimo) >= 0)
      ? (escala.indexOf(act) - escala.indexOf(ultimo)) : null;
    const promAnio = anios.length ? p.kilos_hist / anios.length : 0;
    const noIdent = p.proveedor === SIN_IDENTIFICAR;

    return {
      proveedor: p.proveedor,
      no_identificado: noIdent,
      por_mes: p.por_mes,
      por_periodo: Object.fromEntries(Object.entries(p.por_periodo).map(([k, v]) => [k, r0(v)])),
      anios,                       // en qué campañas trajo
      anios_activo: anios.length,
      primer_periodo: anios[0] || null,
      ultimo_periodo: ultimo,
      campanias_sin_traer: hace,
      kilos_hist: r0(p.kilos_hist), usd_hist: r0(p.usd_hist),
      kilos_act: r0(p.kilos_act),
      kilos_prom_anio: r0(promAnio),
      // La ventana típica sale de TODA la historia; la de este año, aparte.
      desde: hist.desde, hasta: hist.hasta, meses_activo: hist.cuantos,
      desde_act: ahora.desde, hasta_act: ahora.hasta,
      pico, pico_kilos: r0(picoKilos),
      ausente_este_anio: ausente,
      es_nuevo: !ausente && anios.length === 1 && anios[0] === act,
      // ── A QUIÉN LLAMAR ────────────────────────────────────────────────────────────
      // Nos trajo ANTES y este año no aparece. No se marca al que nunca trajo (no hay a quién
      // llamar), ni al que ya está trabajando, ni al que aparece recién en una campaña
      // posterior a la que se mira. Los #N/A tampoco: no hay un nombre al que llamar, y
      // ofrecerlo como gestión sería mandar a alguien a buscar un fantasma.
      contactar: ausente && previos.length > 0 && !noIdent && leTocaba,
      // Cuándo llamarlo: el mes en que suele arrancar. Llamarlo cuando ya empezó es tarde.
      contactar_mes: ausente && hist.desde ? hist.desde : null,
      // Trajo siempre, todavía no apareció, y su temporada no llegó. No es una pérdida: es
      // una espera. Se muestra aparte para no mandar a nadie a llamar de más — y para que
      // el que quiera adelantarse igual los tenga.
      esperando: ausente && previos.length > 0 && !noIdent && !leTocaba,
    };
  });

  // Los que están trabajando primero, después los que hay que ir a buscar, después los que
  // todavía no les toca, y al final los no identificados. Dentro de cada grupo, por volumen
  // histórico: a quién más conviene llamar.
  const grupo = (x) => x.no_identificado ? 3 : (x.contactar ? 1 : (x.esperando ? 2 : 0));
  salida.sort((a, b) => (grupo(a) - grupo(b)) || (b.kilos_hist - a.kilos_hist));

  const totales = {}, totales_act = {};
  for (const m of meses) { totales[m] = r0(totMes[m] || 0); totales_act[m] = r0(totMesAct[m] || 0); }
  let picoMes = null, picoTot = 0;
  for (const m of meses) if ((totales[m] || 0) > picoTot) { picoTot = totales[m]; picoMes = m; }

  const activos = salida.filter(x => !x.ausente_este_anio && !x.no_identificado);
  const aContactar = salida.filter(x => x.contactar);
  const esperando = salida.filter(x => x.esperando);
  const sinIdent = salida.find(x => x.no_identificado) || null;

  return {
    meses, periodos, periodo_actual: act,
    filas: salida, totales, totales_act,
    kilos_hist: r0(salida.reduce((a, x) => a + x.kilos_hist, 0)),
    kilos_act: r0(salida.reduce((a, x) => a + x.kilos_act, 0)),
    usd_hist: r0(salida.reduce((a, x) => a + x.usd_hist, 0)),
    proveedores_activos: activos.length,
    a_contactar: aContactar.length,
    kilos_a_contactar: r0(aContactar.reduce((a, x) => a + x.kilos_prom_anio, 0)),
    esperando: esperando.length,
    kilos_esperando: r0(esperando.reduce((a, x) => a + x.kilos_prom_anio, 0)),
    hasta_mes: hastaMes,
    pico_mes: picoMes, pico_kilos: r0(picoTot),
    // Cuánta mercadería quedó sin nombre por los errores de la planilla. Va como número
    // propio: si es grande, la pantalla entera vale menos y hay que decirlo.
    sin_identificar: sinIdent
      ? { kilos_hist: sinIdent.kilos_hist, kilos_act: sinIdent.kilos_act,
          pct_hist: r1(sinIdent.kilos_hist * 100 / (salida.reduce((a, x) => a + x.kilos_hist, 0) || 1)) }
      : null,
    // El techo del gráfico: la celda más grande, no el total del mes. Con muchos proveedores
    // en el mismo mes, escalar contra el total deja todas las barras aplastadas.
    max_celda: r0(salida.reduce((mx, p) => Math.max(mx,
      ...meses.map(m => (p.por_mes[m] || {}).kilos || 0)), 0)),
  };
}
