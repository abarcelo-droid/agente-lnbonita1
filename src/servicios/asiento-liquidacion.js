// src/servicios/asiento-liquidacion.js
//
// EL ASIENTO DE UNA LIQUIDACIÓN DE COMPRA.
//
// La liquidación es el comprobante que le EMITIMOS al productor por lo que su
// mercadería rindió. Tiene dos mitades que van en direcciones contrarias:
//
//   · lo que él VENDIÓ es una COMPRA nuestra   → va al debe, con IVA CRÉDITO
//   · la comisión, la descarga y los gastos
//     administrativos son servicios que le
//     COBRAMOS                                  → van al haber, con IVA DÉBITO
//   · lo que queda es lo que se le DEBE          → al haber, contra Proveedores
//
// Y por eso cierra sola: el debe es lo que él vendió más su IVA, y el haber es
// lo que le cobramos más lo que le queda. Si se le cobra de más, la cuenta de
// Proveedores da negativa — y eso se ve, no se esconde.
//
// LO QUE PABLO TIENE QUE CONFIRMAR: que la comisión, la descarga y los gastos
// administrativos llevan IVA DÉBITO (son venta nuestra) y no crédito. Es lo que
// dice el sentido de la operación —le estamos facturando un servicio— pero es
// una decisión contable y quedó escrita acá para poder discutirla.
//
// De dónde sale cada cuenta:
//   · Mercadería y Proveedores → del ASIENTO MODELO de liquidación
//   · Los dos IVA              → de la CONFIGURACIÓN IMPOSITIVA global
//   · Comisión, descarga y
//     gastos administrativos   → de la configuración impositiva, con claves
//                                propias que Pablo elige (liq_comision,
//                                liq_descarga, liq_gastos_admin)
//
// Es la misma mecánica que la factura de compra: el modelo y la configuración
// ponen LA CUENTA, el comprobante pone EL MONTO. Un total no se puede imputar.
import { MOTIVOS } from './asientos.js';

export const r2l = (x) => Math.round((Number(x) || 0) * 100) / 100;

const CLAVE_MODELO_LIQ = 'asiento_modelo_liquidacion';

// LAS FILAS DE LA LIQUIDACIÓN SON ESTAS Y NO OTRAS.
//
// Antes vivían como texto libre en el campo «concepto»: cada uno escribía
// "Comision", "COMISION", "Comisión s/venta"… y después no hay informe posible.
// Es la misma razón por la que los motivos de gestión son cuatro y no texto.
//
// `lado` es de la LIQUIDACIÓN: lo que él vende va al debe (lo compramos), lo que
// le cobramos va al haber. `clave_cuenta` es de dónde sale la cuenta.
export const FILAS_LIQ = [
  { clave: 'ventas', label: 'Ventas', lado: 'debe', iva: 'credito',
    ayuda: 'Lo que la mercadería del productor rindió' },
  { clave: 'comision', label: 'Comisión', lado: 'haber', iva: 'debito',
    clave_cuenta: 'liq_comision', ayuda: 'Lo que le cobramos por vender' },
  { clave: 'descarga', label: 'Descarga', lado: 'haber', iva: 'debito',
    clave_cuenta: 'liq_descarga', ayuda: 'Lo que le cobramos por descargar' },
  // EL FLETE. Pablo lo pidió después: "flete lo estoy agregando ya que me lo
  // había olvidado". Es un servicio más que le cobramos — lo adelantamos
  // nosotros y se lo descontamos de lo que le pagamos.
  { clave: 'flete', label: 'Flete', lado: 'haber', iva: 'debito',
    clave_cuenta: 'liq_flete', ayuda: 'Lo que le cobramos por traer la mercadería' },
  { clave: 'gastos_admin', label: 'Gastos administrativos', lado: 'haber', iva: 'debito',
    clave_cuenta: 'liq_gastos_admin', ayuda: 'Lo que le cobramos por administrar la operación' },
];

// El modelo elegido, con sus líneas. Sin modelo no hay asiento: se dice y se
// corta, no se inventan cuentas.
export function modeloLiqLineas(db) {
  const cfg = db.prepare('SELECT valor FROM sg_config WHERE clave=?').get(CLAVE_MODELO_LIQ);
  const id = cfg && cfg.valor ? Number(cfg.valor) : null;
  if (!id) return { id: null, lineas: [] };
  const m = db.prepare('SELECT id FROM sg_asientos_modelo WHERE id=? AND activo=1').get(id);
  if (!m) return { id: null, perdido: id, lineas: [] };
  const lineas = db.prepare(`SELECT l.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre
    FROM sg_asientos_modelo_lineas l
    LEFT JOIN sg_cuentas c ON c.id = l.cuenta_id
    WHERE l.modelo_id=? ORDER BY l.orden, l.id`).all(id);
  return { id, lineas };
}

// Una cuenta de la configuración impositiva global, con su nombre para mostrar.
export function cuentaConfig(db, clave) {
  return db.prepare(`SELECT ci.cuenta_id, cu.codigo, cu.nombre
    FROM sg_config_impositiva ci LEFT JOIN sg_cuentas cu ON cu.id = ci.cuenta_id
    WHERE ci.clave = ? AND ci.cuenta_id IS NOT NULL`).get(clave) || null;
}

// ── LAS LÍNEAS DEL ASIENTO ───────────────────────────────────────────────
//
// datos = {
//   numero, fecha,
//   fiscal:  { ventas, iva_ventas, comision, iva_comision, descarga,
//              iva_descarga, gastos_admin, iva_gastos_admin },
//   gestion: { ventas, comision, descarga, gastos_admin },   // SIN IVA
//   motivo_gestion,
// }
//
// Devuelve { lineas, falta, modelo_id }. Si falta algo, `falta` lo dice con
// nombre y apellido y `lineas` viene vacío: no se guarda media liquidación.
export function lineasAsientoLiquidacion(db, datos) {
  const mod = modeloLiqLineas(db);
  const falta = [];
  if (!mod.lineas.length) {
    falta.push(mod.perdido
      ? 'el asiento modelo de liquidación que estaba elegido se dio de baja'
      : 'elegir el asiento modelo de liquidación, arriba en la pantalla');
    return { lineas: [], falta, modelo_id: mod.id };
  }

  const de = (t) => mod.lineas.find((l) => l.tipo_linea === t);
  // "Libre" cuenta cuando es la única de su lado, igual que en compras y en
  // ventas: pedir un tipo explícito acá y no allá es la misma pantalla con dos
  // reglas.
  const sueltas = (lado) => mod.lineas.filter((l) =>
    l.lado === lado && (!l.tipo_linea || l.tipo_linea === 'libre'));
  const unica = (lado) => (sueltas(lado).length === 1 ? sueltas(lado)[0] : null);

  const lMerc = de('mercaderia') || unica('debe');
  const lProv = de('proveedores') || unica('haber');
  if (!lMerc) falta.push('marcar en el modelo cuál es la línea de la mercadería: hay varias en el debe');
  if (!lProv) falta.push('marcar en el modelo cuál es la línea de Proveedores: es lo que se le queda debiendo');

  const f = datos.fiscal || {};
  const g = datos.gestion || {};
  const n = (x) => r2l(x);

  // Los dos IVA salen de la configuración global, como en compras y en ventas.
  const ivaVentas = n(f.iva_ventas);
  const ivaServ = n(f.iva_comision) + n(f.iva_descarga) + n(f.iva_gastos_admin);
  const ctaIvaCred = ivaVentas > 0 ? cuentaConfig(db, 'iva_credito_fiscal') : null;
  const ctaIvaDeb = ivaServ > 0 ? cuentaConfig(db, 'iva_debito_fiscal') : null;
  if (ivaVentas > 0 && !ctaIvaCred) {
    falta.push('la cuenta de IVA Crédito Fiscal en Configuración impositiva, y esta liquidación lo discrimina');
  }
  if (ivaServ > 0 && !ctaIvaDeb) {
    falta.push('la cuenta de IVA Débito Fiscal en Configuración impositiva, y se le está cobrando un servicio');
  }

  // Comisión, descarga y gastos: cada una con su cuenta configurada. Sólo se
  // exige la de las filas que tienen importe — configurar las tres para liquidar
  // una que no cobra comisión sería pedir un dato que no existe.
  const ctas = {};
  for (const fila of FILAS_LIQ) {
    if (!fila.clave_cuenta) continue;
    const montoF = n(f[fila.clave]);
    const montoG = n(g[fila.clave]);
    if (montoF === 0 && montoG === 0) continue;
    const c = cuentaConfig(db, fila.clave_cuenta);
    if (!c) {
      falta.push('a qué cuenta va ' + fila.label.toLowerCase()
        + ' (se configura en Configuración impositiva, abajo de todo)');
      continue;
    }
    ctas[fila.clave] = c;
  }

  if (falta.length) return { lineas: [], falta, modelo_id: mod.id };

  const lineas = [];
  const push = (cuenta_id, debe, haber, descripcion, ambito, motivo) => {
    if (r2l(debe) === 0 && r2l(haber) === 0) return;
    const l = { cuenta_id, debe: r2l(debe), haber: r2l(haber), descripcion };
    if (ambito === 'gestion') { l.ambito = 'gestion'; l.motivo = motivo; }
    lineas.push(l);
  };

  const ref = datos.numero ? (' ' + datos.numero) : '';

  // ── FISCAL ─────────────────────────────────────────────────────────────
  const ventasF = n(f.ventas);
  push(lMerc.cuenta_id, ventasF, 0, lMerc.descripcion || ('Liquidación' + ref));
  if (ivaVentas > 0) push(ctaIvaCred.cuenta_id, ivaVentas, 0, 'IVA Crédito Fiscal');
  let cobradoF = 0;
  for (const fila of FILAS_LIQ) {
    if (!fila.clave_cuenta) continue;
    const m = n(f[fila.clave]);
    if (m === 0) continue;
    push(ctas[fila.clave].cuenta_id, 0, m, fila.label + ref);
    cobradoF += m;
  }
  if (ivaServ > 0) push(ctaIvaDeb.cuenta_id, 0, ivaServ, 'IVA Débito Fiscal · servicios');
  // Lo que queda para el productor. Puede dar negativo si se le cobró más de lo
  // que vendió: en ese caso va al DEBE, porque él nos debe a nosotros. Taparlo
  // con un cero haría que el asiento no balancee y nadie sabría por qué.
  const aPagarF = r2l(ventasF + ivaVentas - cobradoF - ivaServ);
  push(lProv.cuenta_id, aPagarF < 0 ? -aPagarF : 0, aPagarF > 0 ? aPagarF : 0,
       lProv.descripcion || ('Liquidación' + ref));

  // ── GESTIÓN ────────────────────────────────────────────────────────────
  //
  // SIN IVA, por regla del repo: el crédito y el débito fiscal salen del
  // comprobante y de nada más. Y cada ámbito balancea por su cuenta.
  const motivo = MOTIVOS[datos.motivo_gestion] ? datos.motivo_gestion : 'ajuste_gestion';
  const ventasG = n(g.ventas);
  let cobradoG = 0;
  for (const fila of FILAS_LIQ) {
    if (!fila.clave_cuenta) continue;
    cobradoG += n(g[fila.clave]);
  }
  if (ventasG !== 0 || cobradoG !== 0) {
    push(lMerc.cuenta_id, ventasG, 0, 'Liquidación de gestión' + ref, 'gestion', motivo);
    for (const fila of FILAS_LIQ) {
      if (!fila.clave_cuenta) continue;
      const m = n(g[fila.clave]);
      if (m === 0) continue;
      push(ctas[fila.clave].cuenta_id, 0, m, fila.label + ' · gestión' + ref, 'gestion', motivo);
    }
    const aPagarG = r2l(ventasG - cobradoG);
    push(lProv.cuenta_id, aPagarG < 0 ? -aPagarG : 0, aPagarG > 0 ? aPagarG : 0,
         'Liquidación de gestión' + ref, 'gestion', motivo);
  }

  return { lineas, falta: [], modelo_id: mod.id,
           a_pagar_fiscal: aPagarF, a_pagar_gestion: r2l(ventasG - cobradoG) };
}

// El cuadro que muestra la pantalla: las líneas con el nombre de cada cuenta y
// los totales por ámbito con el «balancea». Es lo mismo que hace la factura de
// compra, y por la misma razón: el asiento se arma en el backend y el usuario lo
// veía recién después, cuando ya estaba hecho.
export function previewAsientoLiquidacion(db, datos) {
  const arm = lineasAsientoLiquidacion(db, datos);
  if (arm.falta.length) return { ok: true, falta: arm.falta, lineas: [], totales: {} };
  const nombres = new Map();
  for (const l of arm.lineas) {
    if (nombres.has(l.cuenta_id)) continue;
    nombres.set(l.cuenta_id, db.prepare('SELECT codigo, nombre FROM sg_cuentas WHERE id=?').get(l.cuenta_id) || {});
  }
  const totales = {};
  const lineas = arm.lineas.map((l) => {
    const a = l.ambito === 'gestion' ? 'gestion' : 'fiscal';
    if (!totales[a]) totales[a] = { debe: 0, haber: 0 };
    totales[a].debe = r2l(totales[a].debe + l.debe);
    totales[a].haber = r2l(totales[a].haber + l.haber);
    const c = nombres.get(l.cuenta_id) || {};
    return { ...l, cuenta_codigo: c.codigo, cuenta_nombre: c.nombre };
  });
  for (const a of Object.keys(totales)) {
    totales[a].balancea = Math.abs(totales[a].debe - totales[a].haber) < 0.01;
  }
  return { ok: true, falta: [], lineas, totales, modelo_id: arm.modelo_id,
           a_pagar_fiscal: arm.a_pagar_fiscal, a_pagar_gestion: arm.a_pagar_gestion };
}
