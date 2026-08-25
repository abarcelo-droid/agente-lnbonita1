// src/servicios/asiento-venta.js
//
// EL ASIENTO DE UNA VENTA, EN UN SOLO LUGAR.
//
// Vivía adentro de rutas/sg_ventas.js, en el POST /facturas. Pero hay DOS
// caminos que emiten una factura de venta: ese, y el de facturación directa,
// que pasa por afip-wsfe-emision.js. El segundo no generaba ningún asiento: la
// mercadería salía, el cliente quedaba debiendo, y en el libro no pasaba nada.
//
// Es el mismo error que ya había pasado con el asiento de compra —dos puertas,
// el freno en una sola— y se arregla igual: la regla vive acá y los dos la usan.
import db from './db.js';
import './db_sg_finanzas.js';
// La lista corta de motivos: un motivo que no esté acá no entra al asiento.
import { MOTIVOS } from './asientos.js';

export const r2v = (x) => Math.round((Number(x) || 0) * 100) / 100;
// ── EL ASIENTO MODELO DE VENTA ──────────────────────────────
//
// Mismo mecanismo que en compras: Pablo arma el modelo en Contabilidad SG, elige
// cuál se usa, y las facturas se contabilizan contra él. Antes esto sacaba las
// cuentas de la configuración impositiva y de la ficha del cliente —y esa ficha
// ni siquiera tenía dónde cargarla—.
//
// Cada línea del modelo dice QUÉ ES, no cuánto:
//
//   clientes   → el DEBE por el total: lo que el cliente queda debiendo
//   ventas     → el HABER por el neto
//   iva        → el HABER por el IVA débito fiscal
//   descuento  → opcional: contra qué cuenta se mide lo resignado por los
//                acuerdos. Si el modelo no la trae, se usa la de ventas.
//
// Los importes los pone la factura; el modelo pone las cuentas. Igual que en
// compras: un modelo no es un asiento, es la forma del asiento.
const CLAVE_MODELO_VENTA = 'asiento_modelo_venta';

export function modeloVentaLineas(db) {
  const cfg = db.prepare('SELECT valor FROM sg_config WHERE clave=?').get(CLAVE_MODELO_VENTA);
  const id = cfg && cfg.valor ? Number(cfg.valor) : null;
  if (!id) return { id: null, lineas: [] };
  const m = db.prepare('SELECT id FROM sg_asientos_modelo WHERE id=? AND activo=1').get(id);
  if (!m) return { id: null, perdido: id, lineas: [] };
  const lineas = db.prepare(`SELECT l.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre
    FROM sg_asientos_modelo_lineas l
    LEFT JOIN sg_cuentas c ON c.id = l.cuenta_id
    WHERE l.modelo_id=? ORDER BY l.orden, l.id`).all(id);

  // LAS LÍNEAS EFECTIVAS: las del modelo MÁS las que completa la configuración
  // impositiva global. Es exactamente igual a lineasModeloFactura() del lado de
  // compras, y por la misma razón: si la pantalla mostrara sólo las del modelo,
  // el asiento que se ve no sería el que se graba.
  //
  // El IVA Débito Fiscal va al HABER: en una venta es deuda con AFIP.
  const DE_CONFIG = [['iva_debito_fiscal', 'iva', 'haber']];
  let extra = -1;   // id negativo: son líneas que no existen en la tabla
  for (const [clave, tipo, lado] of DE_CONFIG) {
    if (lineas.some((l) => l.tipo_linea === tipo)) continue;   // el modelo ya la tiene
    const c = db.prepare(`SELECT ci.cuenta_id, cu.codigo, cu.nombre
      FROM sg_config_impositiva ci LEFT JOIN sg_cuentas cu ON cu.id = ci.cuenta_id
      WHERE ci.clave = ? AND ci.cuenta_id IS NOT NULL`).get(clave);
    if (!c) continue;
    lineas.push({ id: extra--, modelo_id: id, cuenta_id: c.cuenta_id, lado,
      descripcion: c.nombre, orden: 900, tipo_linea: tipo,
      cuenta_codigo: c.codigo, cuenta_nombre: c.nombre, de_config_global: 1 });
  }
  return { id, lineas };
}

// Qué le falta al modelo para poder contabilizar una venta. Se avisa ANTES de
// que haya una factura cargada y alguien esperando.
export function modeloVentaFaltan(lineas) {
  const faltan = [];
  if (!lineas.length) return ['no hay ningún asiento modelo de venta elegido'];
  const tiene = (t) => lineas.some((l) => l.tipo_linea === t);
  // Una línea sin marcar cuenta si es la única de su lado: ver lineasAsientoVenta.
  const sola = (lado) => lineas.filter((l) =>
    l.lado === lado && (!l.tipo_linea || l.tipo_linea === 'libre')).length === 1;
  if (!tiene('clientes') && !sola('debe')) {
    faltan.push('marcar cuál es la línea de Clientes / Deudores: hay varias en el debe');
  }
  if (!tiene('ventas') && !sola('haber')) {
    faltan.push('marcar cuál es la línea de Ventas: hay varias en el haber');
  }
  const sinCuenta = lineas.filter((l) => !l.cuenta_codigo).length;
  if (sinCuenta) faltan.push(sinCuenta + ' línea(s) apuntan a una cuenta que ya no existe');
  return faltan;
}

// EL MOTIVO VIENE DE AFUERA. Estaba escrito 'ajuste_gestion' a mano en las dos
// líneas de gestión: la factura guardaba bien el motivo que eligió el operador
// --"error del proveedor", "comprobante pendiente"-- y el asiento salía marcado
// como otra cosa. El informe de Medir gestión abre por motivo justamente para
// saber qué se puede reclamar y qué no, así que contaba mal esas ventas.
//
// Se cae a 'ajuste_gestion' sólo si no viene ninguno o si viene uno que no está
// en la lista: crearAsiento rechaza un motivo desconocido, y tirar el asiento
// entero de una venta ya emitida por un motivo mal escrito sería peor.
export function lineasAsientoVenta(db, { clienteId, neto, iva, total, descuento, numero, motivo }) {
  const motivoGes = MOTIVOS[String(motivo || '').trim()] ? String(motivo).trim() : 'ajuste_gestion';
  const mod = modeloVentaLineas(db);
  const faltan = modeloVentaFaltan(mod.lineas);
  if (faltan.length) return { lineas: [], falta: faltan, modelo_id: mod.id };

  // "LIBRE" TAMBIÉN SIRVE, como en compras. Allá la línea del neto se marca
  // Libre y nadie le pide más; pedir un tipo explícito acá y no allá es la misma
  // pantalla con dos reglas.
  //
  // Si no hay una línea marcada, se toma la ÚNICA que quede de ese lado: con dos
  // renglones —uno al debe y otro al haber— no hay ambigüedad posible. Con más
  // de una sí la hay, y ahí sí hace falta marcarlas.
  const de = (t) => mod.lineas.find((l) => l.tipo_linea === t);
  const sueltas = (lado) => mod.lineas.filter((l) =>
    l.lado === lado && (!l.tipo_linea || l.tipo_linea === 'libre'));
  const unica = (lado) => (sueltas(lado).length === 1 ? sueltas(lado)[0] : null);
  const lCli = de('clientes') || unica('debe');
  const lVta = de('ventas') || unica('haber');

  // EL IVA SALE DE LA CONFIGURACIÓN GENERAL, no del modelo — igual que en
  // compras, donde el modelo lleva mercadería y proveedores, y el IVA y las
  // percepciones las completa la config impositiva.
  //
  // Es una cuenta sola para toda la empresa: repetirla en cada modelo es pedir
  // el mismo dato muchas veces y que un día dos modelos apunten a cuentas
  // distintas. Si el modelo la trae igual, esa gana: alguien la puso a propósito.
  // Ya viene en las líneas: si el modelo no la trae, modeloVentaLineas() la
  // agregó desde la configuración global — igual que lineasModeloFactura() en
  // compras. Buscarla acá de nuevo era hacer dos veces el mismo trabajo, y que
  // la pantalla pudiera mostrar una cosa distinta de la que se graba.
  const ctaIva = (de('iva') || {}).cuenta_id || null;
  if (r2v(iva) > 0 && !ctaIva) {
    return { lineas: [],
      falta: ['la cuenta de IVA Débito Fiscal en Configuración impositiva, '
            + 'y esta factura lo discrimina'],
      modelo_id: mod.id };
  }

  const lineas = [
    { cuenta_id: lCli.cuenta_id, debe: r2v(total), haber: 0,
      descripcion: lCli.descripcion || ('Factura ' + numero) },
    { cuenta_id: lVta.cuenta_id, debe: 0, haber: r2v(neto),
      descripcion: lVta.descripcion || ('Venta ' + numero) },
  ];
  if (r2v(iva) > 0) {
    lineas.push({ cuenta_id: ctaIva, debe: 0, haber: r2v(iva),
      descripcion: 'IVA Débito Fiscal' });
  }
  // EL DESCUENTO COMERCIAL, EN GESTIÓN. El cliente "debería" lo de lista y la
  // venta de gestión es la de lista: la diferencia queda medida.
  //
  // Si el modelo trae una línea 'descuento', se mide contra esa cuenta —así se
  // puede sumar por período sin desarmar el mayor de Ventas—. Si no la trae, va
  // contra Ventas, que es lo mínimo que hace falta para que el ajuste exista.
  const d = r2v(descuento);
  if (d > 0) {
    const lDesc = de('descuento');
    lineas.push({ cuenta_id: lCli.cuenta_id, debe: d, haber: 0,
      ambito: 'gestion', motivo: motivoGes,
      descripcion: 'Descuento comercial acordado' });
    lineas.push({ cuenta_id: (lDesc ? lDesc.cuenta_id : lVta.cuenta_id), debe: 0, haber: d,
      ambito: 'gestion', motivo: motivoGes,
      descripcion: 'Descuento comercial acordado' });
  }
  return { lineas, falta: [], modelo_id: mod.id };
}
