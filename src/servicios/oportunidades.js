// src/servicios/oportunidades.js
// ── OPORTUNIDADES DESAPROVECHADAS ────────────────────────────────────────────────────
// Cinco preguntas concretas sobre la MISMA ventana: este mes comercial, campaña actual
// contra la anterior. Cada una es una regla que se puede decir en una frase, y esa frase
// viaja en la respuesta (`regla`) para que la pantalla la muestre. Un radar que ordena
// según algo que nadie puede explicar no se usa dos veces.
//
// SE CALCULA EN VIVO, sobre sheet_ventas. NO hay tabla de rollup, y es a propósito: un
// agregado precalculado congela adentro los números del día que se armó, y si el parseo de
// la planilla estaba mal, el radar ordena mal para siempre y sin que se note. Mientras la
// base sea la que es, esto contesta lo que la base dice hoy.
//
// La `db` entra por parámetro y no se importa: así los tests corren con node:sqlite sin
// arrastrar better-sqlite3, que en Windows no compila.
//
// ── DOS REGLAS PARA ESCRIBIR ACÁ ──────────────────────────────────────────────────────
//
// 1. EL `where` VA SIEMPRE EN UN `WITH base AS (...)` AL PRINCIPIO. SQLite ata los
//    parámetros por POSICIÓN en el texto de la consulta, y el `where` viene con los suyos.
//    Si hay un `?` en el SELECT —un CASE WHEN periodo = ?, por ejemplo— queda ANTES del
//    where en el texto y le roba su valor. No da error: devuelve cero filas, y un radar que
//    devuelve cero se lee como "no hay nada que hacer".
//
// 2. NINGÚN ALIAS PUEDE LLAMARSE COMO UNA COLUMNA DE sheet_ventas. `SUM(rent_dol) AS rent`
//    parece inofensivo y no lo es: `rent` EXISTE en la tabla, y un HAVING que diga
//    `rent < 0` mira la columna —que viene vacía— y no la suma. Tampoco da error. Los
//    alias de acá llevan sufijo (rent_sum, usd_act) por eso.

// ── EL PUNTAJE ────────────────────────────────────────────────────────────────────────
// Todo se mide en DÓLARES DE MARGEN EN JUEGO. Es la única unidad que permite poner en la
// misma lista un cliente que se perdió, un producto que no le vendemos a nadie de su rubro
// y una venta que da pérdida: en los tres casos la pregunta es cuánta plata hay sobre la
// mesa.
//
// EL PUNTAJE USA MARGEN SIEMPRE, para todos los niveles (decisión de Andy, 24/8/2026): el
// que no tiene permiso recibe la MISMA lista en el MISMO orden, sin las columnas de margen.
// Si el comercial trabajara una lista y el dueño otra, al discutirla no estarían hablando
// de lo mismo.
//
// Cuando de una fila no se conoce su propia tasa de margen se usa la GLOBAL de la ventana,
// y la fila lo dice (`tasa_propia: false`). Inventarle una tasa a cada una sería peor: el
// orden dependería de un número que nadie puso.

export const TIPOS = {
  CLIENTE_PERDIDO:  { label: 'Cliente perdido',      color: 'rojo' },
  PRODUCTO_PERDIDO: { label: 'Producto perdido',     color: 'rojo' },
  CAIDA_FUERTE:     { label: 'Caída fuerte',         color: 'ambar' },
  CROSS_SELL:       { label: 'No le vendemos',       color: 'azul' },
  MARGEN_NEGATIVO:  { label: 'Vende y pierde plata', color: 'ambar' },
};

// Cuánto tiene que caer para que sea noticia, y cuán chico es "ruido". Van acá y no
// desparramados en cada consulta para poder cambiarlos en un solo lugar.
export const UMBRALES = {
  caida_pct: 30,        // cae más de esto contra el año pasado
  piso_usd: 200,        // por debajo de esto no entra: es ruido, no una oportunidad
  cross_min_clientes: 3, // cuántos clientes del rubro tienen que comprarlo para que cuente
  cross_tope_escala: 3,  // tope al ajuste por tamaño del cliente
  cross_piso_escala: 0.2,
};

const r0 = (n) => Math.round(Number(n) || 0);
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

// La tasa de margen de una fila, o null si no se puede saber.
//
// El chequeo de null NO es defensivo de más: rent_dol viene NULL cuando la planilla no lo
// trajo, y en JavaScript `null / 5000` da CERO, no NaN. Sin esto, una fila sin margen se
// convierte en "margen 0%", se toma como si fuera su tasa propia, y cae al fondo de la lista
// como si no valiera nada — que es justo lo contrario de lo que el paracaídas de la tasa
// global está para evitar.
function tasaDe(rent, usd) {
  if (rent == null || !usd) return null;
  const t = rent / usd;
  return isFinite(t) ? t : null;
}

// La tasa de margen de toda la ventana. Es el paracaídas para las filas que no tienen la
// suya — un cliente que se perdió y el año pasado no dejó rent_dol cargado, por ejemplo.
export function tasaMargenGlobal(db, where, params) {
  const r = db.prepare(`
    SELECT SUM(rent_dol) AS rent_sum, SUM(tot_dol) AS usd_sum FROM sheet_ventas ${where}
  `).get(...params) || {};
  if (!r.usd_sum) return 0;
  return r4(r.rent_sum / r.usd_sum);
}

// Arma el ítem con el puntaje ya puesto. `tasa` null = no se conoce la propia.
function item(base, usd_en_juego, tasa, tasaGlobal) {
  const propia = tasa != null && isFinite(tasa);
  const t = propia ? tasa : tasaGlobal;
  return Object.assign({
    usd_en_juego: r0(usd_en_juego),
    tasa_margen: r4(t),
    tasa_propia: propia,
    margen_en_juego: r0(usd_en_juego * t),
    // El puntaje ES el margen en juego. Se guarda aparte porque hay un tipo
    // (MARGEN_NEGATIVO) donde lo que está en juego es dejar de PERDER, y ahí el margen del
    // renglón es negativo pero la oportunidad es positiva.
    score: r0(usd_en_juego * t),
  }, base);
}

// ── 1. CLIENTE PERDIDO ────────────────────────────────────────────────────────────────
// Nos compraba en este mes el año pasado y este año no compró nada. Se mira el mes y no la
// campaña entera: un cliente estacional que compra en enero no está "perdido" en agosto.
function clientesPerdidos(db, where, params, v, tasaG) {
  const filas = db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where})
    SELECT cliente AS clave,
           SUM(CASE WHEN periodo = ? THEN tot_dol   ELSE 0 END) AS usd_act,
           SUM(CASE WHEN periodo = ? THEN tot_dol   ELSE 0 END) AS usd_ant,
           SUM(CASE WHEN periodo = ? THEN kilos_tot ELSE 0 END) AS kilos_ant,
           SUM(CASE WHEN periodo = ? THEN rent_dol  ELSE 0 END) AS rent_ant
    FROM base WHERE cliente IS NOT NULL AND cliente <> ''
    GROUP BY cliente
    HAVING usd_ant > ? AND usd_act <= 0
    ORDER BY usd_ant DESC LIMIT 200
  `).all(...params, v.actual, v.anterior, v.anterior, v.anterior, UMBRALES.piso_usd);
  return filas.map(f => item({
    tipo: 'CLIENTE_PERDIDO',
    titulo: f.clave,
    detalle: '',
    regla: 'Compraba en ' + v.mesTexto + ' de ' + v.anterior + ' y este año no compró nada.',
    ref_usd: r0(f.usd_ant), ref_kilos: r0(f.kilos_ant), act_usd: 0, act_kilos: 0,
    filtro: { cliente: f.clave },
  }, f.usd_ant, tasaDe(f.rent_ant, f.usd_ant), tasaG));
}

// ── 2. PRODUCTO PERDIDO EN UN CLIENTE ─────────────────────────────────────────────────
// El cliente SIGUE comprando, pero dejó de llevar un producto que el año pasado sí llevaba.
// Es el "perder espacio" en su forma concreta: la góndola sigue, la nuestra se achicó.
//
// Se excluyen los clientes que se fueron enteros: ya están en CLIENTE_PERDIDO y contarlos
// dos veces infla el total de la lista, que es el número que se mira primero.
function productosPerdidos(db, where, params, v, tasaG) {
  const filas = db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where}),
    par AS (
      SELECT cliente, producto,
             SUM(CASE WHEN periodo = ? THEN tot_dol   ELSE 0 END) AS usd_act,
             SUM(CASE WHEN periodo = ? THEN tot_dol   ELSE 0 END) AS usd_ant,
             SUM(CASE WHEN periodo = ? THEN kilos_tot ELSE 0 END) AS kilos_ant,
             SUM(CASE WHEN periodo = ? THEN rent_dol  ELSE 0 END) AS rent_ant
      FROM base
      WHERE cliente IS NOT NULL AND cliente <> ''
        AND producto IS NOT NULL AND producto <> ''
      GROUP BY cliente, producto
    ),
    vivo AS (
      SELECT cliente FROM par GROUP BY cliente HAVING SUM(usd_act) > 0
    )
    SELECT p.* FROM par p JOIN vivo ON vivo.cliente = p.cliente
    WHERE p.usd_ant > ? AND p.usd_act <= 0
    ORDER BY p.usd_ant DESC LIMIT 200
  `).all(...params, v.actual, v.anterior, v.anterior, v.anterior, UMBRALES.piso_usd);
  return filas.map(f => item({
    tipo: 'PRODUCTO_PERDIDO',
    titulo: f.cliente,
    detalle: f.producto,
    regla: 'Le vendíamos ' + f.producto + ' en ' + v.mesTexto + ' de ' + v.anterior
      + ' y este año no. El cliente sigue comprando otras cosas.',
    ref_usd: r0(f.usd_ant), ref_kilos: r0(f.kilos_ant), act_usd: 0, act_kilos: 0,
    filtro: { cliente: f.cliente, producto: f.producto },
  }, f.usd_ant, tasaDe(f.rent_ant, f.usd_ant), tasaG));
}

// ── 3. CAÍDA FUERTE ───────────────────────────────────────────────────────────────────
// Sigue comprando el producto pero mucho menos. Lo que está en juego no es la venta entera
// sino la DIFERENCIA: lo que se dejó de vender.
function caidasFuertes(db, where, params, v, tasaG) {
  const filas = db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where})
    SELECT cliente, producto,
           SUM(CASE WHEN periodo = ? THEN tot_dol   ELSE 0 END) AS usd_act,
           SUM(CASE WHEN periodo = ? THEN tot_dol   ELSE 0 END) AS usd_ant,
           SUM(CASE WHEN periodo = ? THEN kilos_tot ELSE 0 END) AS kilos_act,
           SUM(CASE WHEN periodo = ? THEN kilos_tot ELSE 0 END) AS kilos_ant,
           SUM(CASE WHEN periodo = ? THEN rent_dol  ELSE 0 END) AS rent_ant
    FROM base
    WHERE cliente IS NOT NULL AND cliente <> ''
      AND producto IS NOT NULL AND producto <> ''
    GROUP BY cliente, producto
    HAVING usd_ant > 0 AND usd_act > 0
       AND (usd_ant - usd_act) > ?
       AND (usd_ant - usd_act) * 100.0 / usd_ant >= ?
    ORDER BY (usd_ant - usd_act) DESC LIMIT 200
  `).all(...params, v.actual, v.anterior, v.actual, v.anterior, v.anterior,
         UMBRALES.piso_usd, UMBRALES.caida_pct);
  return filas.map(f => {
    const caida = f.usd_ant - f.usd_act;
    const pct = Math.round(caida * 1000 / f.usd_ant) / 10;
    return item({
      tipo: 'CAIDA_FUERTE',
      titulo: f.cliente,
      detalle: f.producto,
      regla: 'Cayó ' + pct + '% contra ' + v.mesTexto + ' de ' + v.anterior
        + ' (US$ ' + r0(f.usd_ant) + ' → US$ ' + r0(f.usd_act) + ').',
      ref_usd: r0(f.usd_ant), ref_kilos: r0(f.kilos_ant),
      act_usd: r0(f.usd_act), act_kilos: r0(f.kilos_act),
      caida_pct: pct,
      filtro: { cliente: f.cliente, producto: f.producto },
    }, caida, tasaDe(f.rent_ant, f.usd_ant), tasaG);
  });
}

// ── 4. NO LE VENDEMOS ─────────────────────────────────────────────────────────────────
// El producto que compran los clientes de su MISMO RUBRO (cate_clie) en este mes, y a él no
// se lo vendemos — ni ahora ni el año pasado. Es la única de las cinco que mira lo que NO
// pasó, y por eso es la que más fácil se llena de ruido: se le piden tres condiciones.
//
//   · que al menos N clientes del rubro lo compren (uno solo es una casualidad),
//   · que el cliente no lo haya comprado en ninguna de las dos campañas,
//   · y que lo que está en juego supere el piso.
//
// El valor esperado NO es el promedio del rubro a secas: un cliente chico no va a comprar
// como el promedio de un rubro que tiene adentro a un mayorista. Se escala por su tamaño
// relativo dentro del rubro, con tope y piso para que un caso extremo no domine la lista.
function crossSell(db, where, params, v, tasaG) {
  const filas = db.prepare(`
    WITH act AS (
      SELECT * FROM sheet_ventas ${where}
    ),
    cli AS (
      SELECT cliente, MAX(cate_clie) AS cate_clie, SUM(tot_dol) AS usd_sum
      FROM act WHERE periodo = ? AND cliente <> '' AND cate_clie IS NOT NULL AND cate_clie <> ''
      GROUP BY cliente HAVING usd_sum > 0
    ),
    tam AS (
      SELECT cate_clie, AVG(usd_sum) AS usd_prom FROM cli GROUP BY cate_clie
    ),
    pc AS (
      SELECT cate_clie, producto,
             COUNT(DISTINCT cliente) AS n_clientes,
             SUM(tot_dol) AS usd_sum, SUM(rent_dol) AS rent_sum
      FROM act
      WHERE periodo = ? AND producto IS NOT NULL AND producto <> ''
        AND cate_clie IS NOT NULL AND cate_clie <> '' AND cliente <> ''
      GROUP BY cate_clie, producto
    ),
    ya AS (
      SELECT DISTINCT cliente, producto FROM act WHERE producto IS NOT NULL AND producto <> ''
    )
    SELECT c.cliente, c.cate_clie, p.producto, p.n_clientes,
           p.usd_sum / p.n_clientes AS usd_por_cliente,
           CASE WHEN p.usd_sum <> 0 THEN p.rent_sum * 1.0 / p.usd_sum ELSE NULL END AS tasa,
           c.usd_sum AS usd_cliente, t.usd_prom
    FROM cli c
    JOIN tam t ON t.cate_clie = c.cate_clie
    JOIN pc  p ON p.cate_clie = c.cate_clie
    LEFT JOIN ya ON ya.cliente = c.cliente AND ya.producto = p.producto
    WHERE ya.cliente IS NULL AND p.n_clientes >= ?
    LIMIT 2000
  `).all(...params, v.actual, v.actual, UMBRALES.cross_min_clientes);

  const salida = [];
  for (const f of filas) {
    let escala = f.usd_prom ? (f.usd_cliente / f.usd_prom) : 1;
    escala = Math.min(UMBRALES.cross_tope_escala, Math.max(UMBRALES.cross_piso_escala, escala));
    const estimado = f.usd_por_cliente * escala;
    if (estimado <= UMBRALES.piso_usd) continue;
    salida.push(item({
      tipo: 'CROSS_SELL',
      titulo: f.cliente,
      detalle: f.producto,
      regla: f.n_clientes + ' clientes de ' + f.cate_clie + ' compran ' + f.producto
        + ' en ' + v.mesTexto + ' y a este no se lo vendemos'
        + (escala !== 1 ? ' (estimado ajustado ×' + (Math.round(escala * 100) / 100) + ' por su tamaño)' : '')
        + '.',
      ref_usd: 0, ref_kilos: 0, act_usd: 0, act_kilos: 0,
      n_comparables: f.n_clientes,
      filtro: { cliente: f.cliente, producto: f.producto },
    }, estimado, f.tasa, tasaG));
  }
  salida.sort((a, b) => b.score - a.score);
  return salida.slice(0, 200);
}

// ── 5. VENDE Y PIERDE PLATA ───────────────────────────────────────────────────────────
// Este mes, en la campaña actual. Lo que está en juego es dejar de perder, así que el valor
// es el margen negativo dado vuelta — y por eso este tipo no pasa por la tasa: el número ya
// ES margen. Su `usd_en_juego` es la venta, para poder dimensionarlo.
function margenNegativo(db, where, params, v, tasaG) {
  const filas = db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where})
    SELECT cliente, producto,
           SUM(tot_dol) AS usd_sum, SUM(kilos_tot) AS kilos_sum, SUM(rent_dol) AS rent_sum
    FROM base
    WHERE periodo = ?
      AND cliente IS NOT NULL AND cliente <> ''
      AND producto IS NOT NULL AND producto <> ''
    GROUP BY cliente, producto
    HAVING usd_sum > ? AND rent_sum < 0
    ORDER BY rent_sum ASC LIMIT 200
  `).all(...params, v.actual, UMBRALES.piso_usd);
  return filas.map(f => {
    const perdida = Math.abs(f.rent_sum);
    return {
      tipo: 'MARGEN_NEGATIVO',
      titulo: f.cliente,
      detalle: f.producto,
      regla: 'Vendimos US$ ' + r0(f.usd_sum) + ' en ' + v.mesTexto + ' y perdimos US$ '
        + r0(perdida) + ' (' + (Math.round(f.rent_sum * 1000 / f.usd_sum) / 10) + '%).',
      ref_usd: 0, ref_kilos: 0, act_usd: r0(f.usd_sum), act_kilos: r0(f.kilos_sum),
      filtro: { cliente: f.cliente, producto: f.producto },
      usd_en_juego: r0(f.usd_sum),
      tasa_margen: r4(f.rent_sum / f.usd_sum),
      tasa_propia: true,
      // Dejar de perder ES la oportunidad: el margen en juego es la pérdida dada vuelta.
      margen_en_juego: r0(perdida),
      score: r0(perdida),
    };
  });
}

const DETECTORES = {
  CLIENTE_PERDIDO: clientesPerdidos,
  PRODUCTO_PERDIDO: productosPerdidos,
  CAIDA_FUERTE: caidasFuertes,
  CROSS_SELL: crossSell,
  MARGEN_NEGATIVO: margenNegativo,
};

// `where`/`params` tienen que venir acotados a la VENTANA (las dos campañas y el mes) y con
// los filtros de la pantalla ya aplicados: se reusa el armarWhere del router y no se
// reimplementa el criterio de julio-junio en ningún lado.
export function detectar(db, where, params, ventana, opciones) {
  const o = opciones || {};
  const tipos = (o.tipos && o.tipos.length) ? o.tipos.filter(t => DETECTORES[t]) : Object.keys(DETECTORES);
  const tasaG = tasaMargenGlobal(db, where, params);
  let items = [];
  const porTipo = {};
  for (const t of tipos) {
    const res = DETECTORES[t](db, where, params, ventana, tasaG);
    porTipo[t] = { n: res.length, margen_en_juego: r0(res.reduce((a, x) => a + x.margen_en_juego, 0)) };
    items = items.concat(res);
  }
  // Un solo orden para todos: el margen en juego. A igualdad, el más grande en dólares.
  items.sort((a, b) => (b.score - a.score) || (b.usd_en_juego - a.usd_en_juego));
  const total = items.length;
  const limite = Math.min(Math.max(parseInt(o.limite, 10) || 100, 1), 500);
  items = items.slice(0, limite);
  return {
    items, total, truncado: total > limite,
    tasa_margen_global: tasaG,
    por_tipo: porTipo,
    margen_en_juego_total: r0(Object.values(porTipo).reduce((a, x) => a + x.margen_en_juego, 0)),
  };
}

// Saca las columnas de margen sin tocar el ORDEN. La lista es la misma para todos; lo que
// cambia por nivel es qué se ve, no qué está primero.
export function sinMargen(data) {
  return Object.assign({}, data, {
    tasa_margen_global: undefined,
    items: data.items.map(x => {
      const y = Object.assign({}, x);
      delete y.tasa_margen; delete y.tasa_propia;
      delete y.margen_en_juego; delete y.score;
      return y;
    }),
    por_tipo: Object.fromEntries(Object.entries(data.por_tipo).map(([k, x]) => [k, { n: x.n }])),
    margen_en_juego_total: undefined,
  });
}
