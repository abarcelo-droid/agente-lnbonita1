// src/servicios/sg_libros_iva.js
//
// ══ LOS DOS LIBROS DE IVA ══════════════════════════════════════════════
//
// No existía el de VENTAS. El débito fiscal se calculaba en cada emisión, se le
// informaba a AFIP, se guardaba en sg_ven_facturas y se asentaba — y no se sumaba en
// ninguna pantalla. La declaración jurada de IVA no se podía armar desde el sistema.
//
// Y el de COMPRAS estaba corto: leía sólo sg_facturas_compra. La LIQUIDACIÓN al
// productor es la otra forma de documentar una compra en este módulo —la cuenta
// corriente de proveedores la trata como deuda documentada y su asiento genera IVA
// Crédito Fiscal— y no figuraba en ningún libro.
//
// ── UNA LIQUIDACIÓN VA EN LOS DOS LIBROS, Y NO ES UN ERROR ───────────────────
// En una liquidación al productor pasan dos cosas a la vez:
//   · le COMPRAMOS la mercadería      → su IVA es CRÉDITO fiscal   → libro de compras
//   · le COBRAMOS servicios (comisión, descarga, flete, gastos administrativos)
//                                      → su IVA es DÉBITO fiscal   → libro de ventas
// Es un solo papel con las dos mitades. Meterlo en un solo libro deja la otra mitad
// sin declarar.
//
// De dónde salen los números: del `grilla_json` de la liquidación, que es EXACTAMENTE
// lo que asiento-liquidacion.js usó para armar el asiento. Reconstruirlos por otro
// camino sería tener dos versiones del mismo número.

import { esNotaDeCredito } from './factura-cuenta.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// La grilla guardada, con los nombres que usa asiento-liquidacion.js.
function grillaDe(lq) {
  try {
    const g = lq.grilla_json ? JSON.parse(lq.grilla_json) : null;
    return (g && g.fiscal) ? g.fiscal : {};
  } catch (_) { return {}; }
}

// Los servicios que le cobramos al productor: su IVA es nuestro débito fiscal.
// Las claves son las de FILAS_LIQ con iva:'debito'.
const SERVICIOS = ['comision', 'descarga', 'flete', 'gastos_admin'];

// ── LO QUE APORTA CADA LIQUIDACIÓN A CADA LIBRO ────────────────────────────
export function ivaDeLiquidacion(lq) {
  const f = grillaDe(lq);
  const neto = r2(f.ventas);
  const iva = r2(f.iva_ventas);
  let netoServ = 0, ivaServ = 0;
  for (const k of SERVICIOS) {
    netoServ = r2(netoServ + r2(f[k]));
    ivaServ = r2(ivaServ + r2(f['iva_' + k]));
  }
  return {
    // Lo que le compramos: crédito fiscal.
    compras: { neto, iva, total: r2(neto + iva) },
    // Lo que le cobramos: débito fiscal.
    ventas: { neto: netoServ, iva: ivaServ, total: r2(netoServ + ivaServ) },
  };
}

// Las liquidaciones del período, con su asiento vivo. Sin asiento no hay libro: la
// deuda todavía no subió a la contabilidad.
export function liquidacionesDelPeriodo(db, { desde, hasta }) {
  const where = ['lq.eliminado_en IS NULL', 'lq.asiento_id IS NOT NULL',
    'COALESCE(a.anulado,0) = 0'];
  const params = [];
  if (desde) { where.push('lq.fecha >= ?'); params.push(desde); }
  if (hasta) { where.push('lq.fecha <= ?'); params.push(hasta); }
  return db.prepare(`
    SELECT lq.id, lq.n_liquidacion, lq.fecha, lq.grilla_json, lq.asiento_id, lq.iva_letra,
           oc.trazabilidad AS partida, p.razon_social AS proveedor, p.cuit AS cuit
      FROM liquidaciones lq
      JOIN sg_asientos a ON a.id = lq.asiento_id
      LEFT JOIN sg_oc oc ON oc.id = lq.oc_id
      LEFT JOIN sg_proveedores p ON p.id = oc.proveedor_id
     WHERE ${where.join(' AND ')}
     ORDER BY lq.fecha DESC, lq.id DESC`).all(...params);
}

// ── EL LIBRO DE IVA VENTAS ─────────────────────────────────────────────────
// Las facturas emitidas (débito fiscal) + los servicios de las liquidaciones.
//
// `facturaCuentaSql` llega por parámetro para no duplicar la regla de qué factura
// cuenta: una rechazada por AFIP no está en el libro. Es la misma que usa la cuenta
// corriente.
export function libroIvaVentas(db, { desde, hasta, facturaCuentaSql }) {
  const where = [facturaCuentaSql, 'f.asiento_id IS NOT NULL'];
  const params = [];
  if (desde) { where.push('f.fecha >= ?'); params.push(desde); }
  if (hasta) { where.push('f.fecha <= ?'); params.push(hasta); }
  const facturas = db.prepare(`
    SELECT f.id, f.fecha, f.numero, f.punto_venta, f.cbte_tipo, f.cbte_nro, f.tipo AS letra,
           f.neto, f.iva, f.total, f.cae, f.asiento_id, f.ambiente,
           COALESCE(f.es_prueba,0) AS es_prueba,
           c.razon_social AS cliente, c.cuit AS cuit, c.categoria_fiscal
      FROM sg_ven_facturas f
      LEFT JOIN sg_clientes c ON c.id = f.cliente_id
      JOIN sg_asientos a ON a.id = f.asiento_id AND COALESCE(a.anulado,0) = 0
     WHERE ${where.join(' AND ')}
     ORDER BY f.fecha DESC, f.id DESC`).all(...params);

  const filas = facturas.map((f) => {
    // ── LA NOTA DE CRÉDITO RESTA DÉBITO ──────────────────────────────────
    // Se guarda con los importes en positivo, porque eso es lo que dice el papel y
    // lo que se le informó a ARCA. En el LIBRO va al revés: lo que la nota
    // devuelve es débito fiscal que ya no se declara. Sumarla como una factura
    // más haría pagar dos veces el IVA de una venta que se anuló.
    const sg = esNotaDeCredito(f.cbte_tipo) ? -1 : 1;
    return {
    origen: 'factura', nc: sg < 0, id: f.id, fecha: f.fecha,
    comprobante: (f.punto_venta && f.cbte_nro)
      ? String(f.punto_venta).padStart(4, '0') + '-' + String(f.cbte_nro).padStart(8, '0')
      : f.numero,
    letra: f.letra || null, contraparte: f.cliente, cuit: f.cuit,
    neto: sg * r2(f.neto), iva: sg * r2(f.iva), total: sg * r2(f.total),
    asiento_id: f.asiento_id, es_prueba: Number(f.es_prueba) === 1 || f.ambiente === 'homologacion',
    }; });

  // Y la mitad de DÉBITO de cada liquidación: lo que le cobramos al productor.
  for (const lq of liquidacionesDelPeriodo(db, { desde, hasta })) {
    const v = ivaDeLiquidacion(lq).ventas;
    if (!(v.total > 0.001)) continue;
    filas.push({ origen: 'liquidacion', id: lq.id, fecha: lq.fecha,
      comprobante: lq.n_liquidacion, letra: lq.iva_letra || null,
      contraparte: lq.proveedor, cuit: lq.cuit,
      neto: v.neto, iva: v.iva, total: v.total, asiento_id: lq.asiento_id,
      es_prueba: false, nota: 'servicios de la liquidación' });
  }
  filas.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || b.id - a.id);
  return { filas, totales: totalizar(filas) };
}

// ── LO QUE LAS LIQUIDACIONES APORTAN AL LIBRO DE COMPRAS ───────────────────
export function comprasDeLiquidaciones(db, { desde, hasta }) {
  const filas = [];
  for (const lq of liquidacionesDelPeriodo(db, { desde, hasta })) {
    const c = ivaDeLiquidacion(lq).compras;
    if (!(c.total > 0.001)) continue;
    filas.push({ origen: 'liquidacion', id: lq.id, fecha: lq.fecha,
      comprobante: lq.n_liquidacion, letra: lq.iva_letra || null,
      contraparte: lq.proveedor, cuit: lq.cuit, partida: lq.partida,
      neto: c.neto, iva: c.iva, total: c.total, asiento_id: lq.asiento_id });
  }
  return filas;
}

function totalizar(filas) {
  const t = { neto: 0, iva: 0, total: 0, n: 0 };
  for (const f of filas) {
    // Lo de prueba no se declara: no salió por el AFIP de producción.
    if (f.es_prueba) continue;
    t.neto = r2(t.neto + f.neto); t.iva = r2(t.iva + f.iva); t.total = r2(t.total + f.total); t.n++;
  }
  return t;
}
export { totalizar };
