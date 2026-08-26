// src/servicios/interanualDetalle.js
// ── EL MISMO MES, MIRADO DESDE EL PRODUCTO Y DESDE EL CLIENTE QUE SE FUE ──────────────
// Dos preguntas que el radar de oportunidades no contesta porque no son "qué hacer" sino
// "qué pasó", y se leen distinto:
//
//   · POR PRODUCTO: de este producto, ¿a qué cliente le dejamos de vender, a cuál le
//     vendemos menos, y de qué proveedor dejó de venir la mercadería?
//   · CLIENTE PERDIDO EN DETALLE: el que no compró nada este año, ¿qué nos llevaba, y de
//     qué proveedor era eso que le vendíamos?
//
// ── QUÉ ES `proveedor` ACÁ, Y QUÉ NO ES ───────────────────────────────────────────────
// `sheet_ventas.proveedor` es el ORIGEN DE LA MERCADERÍA de esa línea de venta. NO es una
// operación de compra: esta base no tiene precio ni costo de compra, así que "le dejamos de
// comprar" acá quiere decir "dejó de aparecer mercadería suya en lo que vendimos ese mes".
// En la práctica es casi siempre lo mismo, pero no es lo mismo, y el informe lo dice: si
// alguien saliera a reclamarle a un proveedor con este número en la mano, tiene que saber de
// dónde salió.
//
// Las dos reglas de escritura de SQL de este módulo son las mismas que las de
// servicios/oportunidades.js, y por las mismas razones:
//   1. el `where` va SIEMPRE en un `WITH base AS (...)` al principio (SQLite ata los
//      parámetros por posición en el texto, y un `?` del SELECT le roba el valor);
//   2. ningún alias se llama como una columna real de sheet_ventas (`rent`, `total`, `mes`…).
//
// La db entra por parámetro para que los tests corran con node:sqlite.
import { UMBRALES } from './oportunidades.js';

const r0 = (n) => Math.round(Number(n) || 0);
const pct = (a, b) => (b ? Math.round((a - b) * 1000 / Math.abs(b)) / 10 : null);

// ── POR PRODUCTO ──────────────────────────────────────────────────────────────────────
// Los productos que más se movieron —para arriba o para abajo— y, adentro de cada uno, quién
// se fue. Se ordena por el TAMAÑO del movimiento y no por facturación: un producto grande que
// quedó igual no tiene nada para contar.
export function detallePorProducto(db, where, params, v, opciones) {
  const o = opciones || {};
  const tope = Math.min(Math.max(parseInt(o.tope, 10) || 8, 1), 40);
  const umbral = Math.min(Math.max(parseInt(o.umbral, 10) || UMBRALES.caida_pct, 1), 90);
  const piso = o.piso != null ? o.piso : UMBRALES.piso_usd;

  const productos = db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where})
    SELECT producto,
           SUM(CASE WHEN periodo = ? THEN tot_dol   ELSE 0 END) AS usd_act,
           SUM(CASE WHEN periodo = ? THEN tot_dol   ELSE 0 END) AS usd_ant,
           SUM(CASE WHEN periodo = ? THEN kilos_tot ELSE 0 END) AS kg_act,
           SUM(CASE WHEN periodo = ? THEN kilos_tot ELSE 0 END) AS kg_ant,
           COUNT(DISTINCT CASE WHEN periodo = ? THEN cliente END) AS clientes_act,
           COUNT(DISTINCT CASE WHEN periodo = ? THEN cliente END) AS clientes_ant
    FROM base
    WHERE producto IS NOT NULL AND producto <> ''
    GROUP BY producto
    HAVING (usd_act + usd_ant) > ?
    ORDER BY ABS(usd_act - usd_ant) DESC
    LIMIT ?
  `).all(...params, v.actual, v.anterior, v.actual, v.anterior, v.actual, v.anterior, piso, tope);

  if (!productos.length) return [];
  const cuales = new Set(productos.map(p => p.producto));

  // Clientes de cada producto: los que se fueron y los que compran bastante menos. Una sola
  // consulta para todos los productos, y el reparto se hace en JS — así el número de
  // consultas no crece con la cantidad de productos.
  const clientes = db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where})
    SELECT producto, cliente,
           SUM(CASE WHEN periodo = ? THEN tot_dol   ELSE 0 END) AS usd_act,
           SUM(CASE WHEN periodo = ? THEN tot_dol   ELSE 0 END) AS usd_ant,
           SUM(CASE WHEN periodo = ? THEN kilos_tot ELSE 0 END) AS kg_act,
           SUM(CASE WHEN periodo = ? THEN kilos_tot ELSE 0 END) AS kg_ant
    FROM base
    WHERE producto IS NOT NULL AND producto <> ''
      AND cliente IS NOT NULL AND cliente <> ''
    GROUP BY producto, cliente
    HAVING usd_ant > 0
       AND (usd_act <= 0 OR (usd_ant - usd_act) * 100.0 / usd_ant >= ?)
    ORDER BY (usd_ant - usd_act) DESC
  `).all(...params, v.actual, v.anterior, v.actual, v.anterior, umbral);

  // Proveedores: de quién venía la mercadería de ese producto, antes y ahora.
  const provs = db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where})
    SELECT producto, proveedor,
           SUM(CASE WHEN periodo = ? THEN tot_dol   ELSE 0 END) AS usd_act,
           SUM(CASE WHEN periodo = ? THEN tot_dol   ELSE 0 END) AS usd_ant,
           SUM(CASE WHEN periodo = ? THEN kilos_tot ELSE 0 END) AS kg_act,
           SUM(CASE WHEN periodo = ? THEN kilos_tot ELSE 0 END) AS kg_ant
    FROM base
    WHERE producto IS NOT NULL AND producto <> ''
      AND proveedor IS NOT NULL AND proveedor <> ''
    GROUP BY producto, proveedor
  `).all(...params, v.actual, v.anterior, v.actual, v.anterior);

  const porProd = (arr) => {
    const m = new Map();
    for (const x of arr) {
      if (!cuales.has(x.producto)) continue;
      if (!m.has(x.producto)) m.set(x.producto, []);
      m.get(x.producto).push(x);
    }
    return m;
  };
  const mc = porProd(clientes), mp = porProd(provs);
  const TOPE_LISTA = Math.min(Math.max(parseInt(o.tope_lista, 10) || 6, 1), 20);

  return productos.map(p => {
    const cs = mc.get(p.producto) || [];
    const ps = mp.get(p.producto) || [];
    return {
      producto: p.producto,
      usd_act: r0(p.usd_act), usd_ant: r0(p.usd_ant),
      kg_act: r0(p.kg_act), kg_ant: r0(p.kg_ant),
      clientes_act: p.clientes_act, clientes_ant: p.clientes_ant,
      var_usd: r0(p.usd_act - p.usd_ant), var_usd_pct: pct(p.usd_act, p.usd_ant),
      var_kg: r0(p.kg_act - p.kg_ant), var_kg_pct: pct(p.kg_act, p.kg_ant),
      // Se fue del todo.
      clientes_perdidos: cs.filter(x => x.usd_act <= 0)
        .map(x => ({ cliente: x.cliente, usd_ant: r0(x.usd_ant), kg_ant: r0(x.kg_ant) }))
        .slice(0, TOPE_LISTA),
      // Sigue comprando, pero bastante menos.
      clientes_menos: cs.filter(x => x.usd_act > 0)
        .map(x => ({ cliente: x.cliente, usd_act: r0(x.usd_act), usd_ant: r0(x.usd_ant),
                     kg_act: r0(x.kg_act), kg_ant: r0(x.kg_ant), caida_pct: pct(x.usd_act, x.usd_ant) }))
        .slice(0, TOPE_LISTA),
      // Dejó de venir mercadería suya de este producto en este mes.
      proveedores_perdidos: ps.filter(x => x.usd_ant > 0 && x.usd_act <= 0)
        .sort((a, b) => b.usd_ant - a.usd_ant)
        .map(x => ({ proveedor: x.proveedor, usd_ant: r0(x.usd_ant), kg_ant: r0(x.kg_ant) }))
        .slice(0, TOPE_LISTA),
      // Con quién se está trabajando ahora. Va al lado de la lista de arriba a propósito: sin
      // esto, "dejamos de comprarle a X" se lee como un faltante cuando muchas veces es un
      // reemplazo, y son dos conversaciones distintas.
      proveedores_hoy: ps.filter(x => x.usd_act > 0)
        .sort((a, b) => b.usd_act - a.usd_act)
        .map(x => ({ proveedor: x.proveedor, usd_act: r0(x.usd_act), kg_act: r0(x.kg_act),
                     es_nuevo: !(x.usd_ant > 0) }))
        .slice(0, TOPE_LISTA),
    };
  });
}

// ── CLIENTES PERDIDOS, EN DETALLE ─────────────────────────────────────────────────────
// El que compraba en este mes del año pasado y este año no compró nada. Se abre en QUÉ nos
// llevaba y DE QUÉ PROVEEDOR era esa mercadería — que es lo que hace falta para saber si
// reponerlo es posible antes de ir a buscarlo.
export function detalleClientesPerdidos(db, where, params, v, opciones) {
  const o = opciones || {};
  const tope = Math.min(Math.max(parseInt(o.tope, 10) || 10, 1), 60);
  const piso = o.piso != null ? o.piso : UMBRALES.piso_usd;

  const filas = db.prepare(`
    WITH base AS (SELECT * FROM sheet_ventas ${where}),
    cli AS (
      SELECT cliente,
             SUM(CASE WHEN periodo = ? THEN tot_dol ELSE 0 END) AS usd_act,
             SUM(CASE WHEN periodo = ? THEN tot_dol ELSE 0 END) AS usd_ant
      FROM base
      WHERE cliente IS NOT NULL AND cliente <> ''
      GROUP BY cliente
      HAVING usd_ant > ? AND usd_act <= 0
    )
    SELECT b.cliente, b.vendedor,
           COALESCE(NULLIF(b.producto, ''), '(sin producto)')   AS producto,
           COALESCE(NULLIF(b.proveedor, ''), '(sin proveedor)') AS proveedor,
           SUM(b.kilos_tot) AS kg_sum,
           SUM(b.tot_dol)   AS usd_sum
    FROM base b
    JOIN cli ON cli.cliente = b.cliente
    WHERE b.periodo = ?
    GROUP BY b.cliente, b.producto, b.proveedor
    ORDER BY usd_sum DESC
  `).all(...params, v.actual, v.anterior, piso, v.anterior);

  const m = new Map();
  for (const f of filas) {
    if (!m.has(f.cliente)) {
      m.set(f.cliente, { cliente: f.cliente, vendedor: f.vendedor || '', usd: 0, kg: 0, lineas: [] });
    }
    const c = m.get(f.cliente);
    c.usd += f.usd_sum || 0;
    c.kg += f.kg_sum || 0;
    c.lineas.push({ producto: f.producto, proveedor: f.proveedor, usd: r0(f.usd_sum), kg: r0(f.kg_sum) });
  }
  return [...m.values()]
    .map(c => ({ ...c, usd: r0(c.usd), kg: r0(c.kg) }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, tope);
}
