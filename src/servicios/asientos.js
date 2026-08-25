// src/servicios/asientos.js
// ── EL ÚNICO LUGAR QUE ESCRIBE UN ASIENTO ────────────────────────────────────
//
// Antes había NUEVE `INSERT INTO sg_asientos` repartidos en cuatro archivos, y
// cada uno armaba sus líneas a mano. Mientras la única regla era "debe = haber"
// eso se podía sostener. Ahora hay dos reglas más —cada ámbito balancea por su
// cuenta, y una línea de gestión sin motivo no entra— y nueve copias de una
// regla son nueve lugares donde puede estar mal una.
//
// Así que el asiento se arma acá y sólo acá. El test
// `test/un_solo_escritor.test.mjs` --corre con `npm test`-- falla si aparece un
// INSERT nuevo en cualquier otro archivo, o si alguien lee las líneas del libro
// sin decir qué ámbito quiere. No depende de que el próximo se acuerde.
//
// ── POR QUÉ EXISTEN DOS ÁMBITOS ─────────────────────────────────────────────
//
// El comprador arregla el tomate en 20.000 y la factura viene por 10.000. Al
// proveedor se le deben 20.000; a AFIP se le informa la factura de 10.000. Los
// dos números son ciertos y son de la MISMA operación, así que van en el MISMO
// asiento —un solo número, el que se cita cuando hay que discutir algo— con las
// líneas marcadas:
//
//     Mercadería     10.000                      fiscal
//     Proveedores               10.000           fiscal
//     Mercadería     10.000                      gestión
//     Proveedores               10.000           gestión
//
// El libro fiscal filtra las primeras. El de gestión toma todo. Y cada mitad
// cierra sola: un asiento donde lo fiscal balancea pero lo de gestión no, no se
// guarda.

const AMBITO_FISCAL = 'fiscal';
const AMBITO_GESTION = 'gestion';
export const AMBITOS = [AMBITO_FISCAL, AMBITO_GESTION];

// ── LOS MOTIVOS SON UNA LISTA CORTA, NO TEXTO LIBRE ──────────────────────────
// Texto libre son cuarenta maneras de escribir lo mismo y ningún informe posible.
// Con la lista se puede contestar "¿cuánto de la diferencia de este mes es error
// del proveedor y cuánto no va a tener comprobante nunca?", que es la pregunta
// que hace falta para decidir si esto está bajo control.
//
// `reclamable` es lo que separa un pendiente de un hecho consumado: los que lo
// son envejecen en la pantalla de "qué falta documentar" y se van a buscar.
export const MOTIVOS = {
  error_proveedor: {
    label: 'Error del proveedor', reclamable: true,
    ayuda: 'Facturó por menos de lo acordado. Falta que emita la nota de débito.',
  },
  comprobante_pendiente: {
    label: 'Comprobante pendiente', reclamable: true,
    ayuda: 'La operación está cerrada y el comprobante todavía no llegó.',
  },
  diferencia_peso_calidad: {
    label: 'Diferencia de peso o calidad', reclamable: false,
    ayuda: 'La factura refleja lo que realmente entró; lo acordado era un estimado. '
         + 'Ojo: si es esto, capaz la deuda es la de la factura y no hace falta ajuste.',
  },
  ajuste_gestion: {
    label: 'Ajuste de gestión', reclamable: false,
    ayuda: 'Diferencia que no va a tener comprobante.',
  },
};

const r2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

function normalizarAmbito(v) {
  const a = String(v || AMBITO_FISCAL).trim().toLowerCase();
  return AMBITOS.includes(a) ? a : null;
}

// ── ARMAR UN ASIENTO ─────────────────────────────────────────────────────────
// cab:    { fecha, descripcion, usuario_id, ref_codigo?, ref_compra_id? }
// lineas: [{ cuenta_id, debe, haber, descripcion, ambito?, motivo?, usuario_id? }]
//
// Devuelve { id, totales } donde totales tiene el debe y el haber de cada ámbito
// — es lo que la pantalla necesita para mostrar el cuadro con el "balancea" de
// los dos lados (convención del proyecto: ver CLAUDE.md).
//
// Tira Error con un mensaje en castellano si algo no cierra. El llamador lo
// convierte en un 400: son todos errores de lo que se cargó, no del servidor.
export function crearAsiento(db, cab, lineas) {
  if (!Array.isArray(lineas) || !lineas.length) {
    throw new Error('El asiento no tiene líneas');
  }

  const filas = lineas.map((l, i) => {
    const ambito = normalizarAmbito(l.ambito);
    if (!ambito) throw new Error(`Ámbito desconocido en la línea ${i + 1}: "${l.ambito}"`);
    const cuentaId = parseInt(l.cuenta_id, 10);
    if (!cuentaId) throw new Error(`La línea ${i + 1} no tiene cuenta contable`);
    const debe = r2(l.debe), haber = r2(l.haber);
    if (debe < 0 || haber < 0) throw new Error(`La línea ${i + 1} tiene un importe negativo`);
    if (debe > 0 && haber > 0) {
      throw new Error(`La línea ${i + 1} tiene debe Y haber: una línea va de un solo lado`);
    }
    // UNA LÍNEA DE GESTIÓN SIN MOTIVO NO ENTRA. Sin motivo la diferencia queda
    // como un número suelto que nadie va a reclamar ni va a poder explicar en
    // seis meses.
    let motivo = null;
    if (ambito === AMBITO_GESTION) {
      motivo = String(l.motivo || '').trim();
      if (!motivo) {
        throw new Error(`La línea ${i + 1} es de gestión y no dice por qué. `
          + `Elegí el motivo: ${Object.values(MOTIVOS).map((m) => m.label).join(', ')}.`);
      }
      if (!MOTIVOS[motivo]) throw new Error(`Motivo desconocido: "${motivo}"`);
    }
    return { cuenta_id: cuentaId, debe, haber, ambito, motivo,
      descripcion: l.descripcion == null ? null : String(l.descripcion),
      usuario_id: l.usuario_id || cab.usuario_id || null };
  });

  // ── CADA ÁMBITO BALANCEA POR SU CUENTA ─────────────────────────────────
  // Que el asiento entero cierre no alcanza: lo fiscal podría estar descuadrado
  // en 10.000 y lo de gestión compensarlo al revés, y el total daría cero. El
  // libro fiscal saldría mal y nadie se enteraría, porque el asiento "balancea".
  const totales = {};
  for (const f of filas) {
    const t = (totales[f.ambito] = totales[f.ambito] || { debe: 0, haber: 0 });
    t.debe = r2(t.debe + f.debe);
    t.haber = r2(t.haber + f.haber);
  }
  for (const [ambito, t] of Object.entries(totales)) {
    if (Math.abs(t.debe - t.haber) > 0.009) {
      throw new Error(`La parte ${ambito === AMBITO_GESTION ? 'de gestión' : 'fiscal'} del asiento no `
        + `balancea: debe ${t.debe} contra haber ${t.haber} (diferencia ${r2(t.debe - t.haber)}).`);
    }
    if (t.debe === 0 && t.haber === 0) {
      throw new Error(`La parte ${ambito === AMBITO_GESTION ? 'de gestión' : 'fiscal'} del asiento está en cero`);
    }
  }

  const fecha = cab.fecha || db.prepare("SELECT date('now','localtime') d").get().d;
  const id = Number(db.prepare(`INSERT INTO sg_asientos
    (fecha, descripcion, usuario_id, ref_codigo, ref_compra_id) VALUES (?,?,?,?,?)`)
    .run(fecha, cab.descripcion || '', cab.usuario_id || null,
         cab.ref_codigo || null, cab.ref_compra_id || null).lastInsertRowid);

  const ins = db.prepare(`INSERT INTO sg_asientos_lineas
    (asiento_id, cuenta_id, debe, haber, descripcion, ambito, motivo, usuario_id)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const f of filas) {
    ins.run(id, f.cuenta_id, f.debe, f.haber, f.descripcion, f.ambito, f.motivo, f.usuario_id);
  }
  return { id, totales };
}

// ── LEER ─────────────────────────────────────────────────────────────────────
// `ambito` puede ser 'fiscal', 'gestion' o nada (los dos). Devuelve el pedazo de
// SQL y sus parámetros, para pegarlo en un WHERE que ya existe. El alias es el
// de la tabla de líneas en esa consulta.
export function filtroAmbito(ambito, alias = 'l') {
  const a = ambito ? normalizarAmbito(ambito) : null;
  if (!a) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.ambito = ?`, params: [a] };
}

// El debe y el haber de un asiento, abierto por ámbito. Es lo que la pantalla
// muestra abajo del cuadro: un "balancea" por cada mitad.
export function totalesDeAsiento(db, asientoId) {
  const filas = db.prepare(`SELECT ambito, ROUND(SUM(debe),2) debe, ROUND(SUM(haber),2) haber
    FROM sg_asientos_lineas WHERE asiento_id = ? GROUP BY ambito`).all(asientoId);
  const out = {};
  for (const f of filas) out[f.ambito] = { debe: f.debe || 0, haber: f.haber || 0 };
  return out;
}

// ══ EL ASIENTO QUE NACIÓ EN UN MÓDULO SE DESHACE DESDE EL MÓDULO ═══════════
//
// REGLA (Pablo, 24/8/2026): "los asientos que se generan por algún módulo deben
// anularse desde el módulo, no desde asientos... si no podemos eliminar cosas que
// están mal".
//
// La operación es el HECHO y el asiento su CONSECUENCIA. Anular el asiento y dejar
// la operación viva la deja fuera del libro --una deuda o un cobro que existe para
// el cliente y no existe para la contabilidad-- y, peor, sin vuelta atrás: los
// kilos siguen consumidos, el comprobante sigue emitido, y no hay ninguna pantalla
// que rehaga el asiento. Es exactamente lo que pasó con una factura de venta.
//
// HABÍA UN FRENO Y CONOCÍA UN SOLO ORIGEN. Miraba únicamente sg_asientos.ref_compra_id
// --la factura de COMPRA-- y de los trece lugares que crean asientos sólo dos lo
// escriben. Todo lo demás pasaba de largo: la factura de venta, la liquidación, la
// cobranza, el pago a proveedor, los cheques de terceros y la liquidación de abasto.
//
// Ahora el origen se declara en una LISTA y la función es una sola. Cuando aparezca
// un módulo nuevo hay que agregarle su renglón acá, que es justo el modo en que
// falló el freno anterior --por eso el renglón es DECLARATIVO y se lee de un
// vistazo, en vez de estar escondido dentro de un if en una ruta.
//
// Hay tres formas distintas de vincular un asiento con su operación y las tres
// existen en la base, así que las tres se cubren:
//   ref_compra_id → el asiento apunta al comprobante  (compras)
//   asiento_id    → el comprobante apunta al asiento  (ventas, pagos, liquidaciones)
//   ref_codigo    → sólo hay un código convenido      (cheques de terceros)

// Qué columnas tiene cada tabla, preguntado una sola vez por base. Varias de estas
// columnas se agregaron con ALTER TABLE y pueden faltar en una base vieja: una
// consulta contra una columna inexistente tiraría al anular, y el freno tiene que
// ser lo más robusto del archivo, no lo más frágil.
const _cacheCols = new WeakMap();
function _cols(db, tabla) {
  let porBase = _cacheCols.get(db);
  if (!porBase) { porBase = new Map(); _cacheCols.set(db, porBase); }
  if (!porBase.has(tabla)) {
    let set = null;
    try {
      const filas = db.prepare(`PRAGMA table_info(${tabla})`).all();
      if (filas && filas.length) set = new Set(filas.map((f) => f.name));
    } catch (_) { set = null; }   // la tabla no existe en esta base
    porBase.set(tabla, set);
  }
  return porBase.get(tabla);
}

// El "sigue viva" de cada tabla, sin romperse si la columna no está.
function _vivo(db, o) {
  const cols = _cols(db, o.tabla);
  if (!cols) return null;
  const partes = (o.vivo || []).filter((c) => cols.has(c.col)).map((c) => c.sql);
  return partes.length ? partes.join(' AND ') : '1=1';
}

// Cómo se nombra el comprobante en el cartel. El fiscal va con su formato de
// siempre --0004-00000006--: si el cartel dice "9999-6" el que lo lee no lo
// encuentra en ninguna pantalla.
const _nro = (r) => {
  if (r.punto_venta != null && r.cbte_nro != null) {
    return String(r.punto_venta).padStart(4, '0') + '-' + String(r.cbte_nro).padStart(8, '0');
  }
  return (r.punto_venta ? String(r.punto_venta) + '-' : '')
       + (r.numero || r.n_liquidacion || r.id);
};

// LOS ORÍGENES. Un renglón por módulo. `que` es cómo se nombra el comprobante en el
// cartel; `pantalla` es adónde hay que ir; `como` explica qué pasa cuando se
// deshace ahí, que es lo que convence de no buscarle la vuelta.
export const ORIGENES_SG = [
  { modulo: 'compras', tabla: 'sg_facturas_compra', via: 'ref_compra_id',
    vivo: [{ col: 'activo', sql: 'COALESCE(activo,1) = 1' }],
    que: (r) => 'la factura de compra ' + _nro(r),
    pantalla: 'Facturas por mercadería',
    como: 'ahí se da de baja el comprobante y su asiento juntos, y la partida vuelve a esperar factura' },

  { modulo: 'ventas', tabla: 'sg_ven_facturas', via: 'asiento_id',
    vivo: [{ col: 'estado', sql: "COALESCE(estado,'') <> 'anulada'" }],
    que: (r) => 'la factura de venta ' + _nro(r),
    pantalla: 'Comprobantes emitidos',
    como: 'ahí se anula el comprobante, y con él su asiento; los kilos del remito vuelven a quedar pendientes de facturar' },

  { modulo: 'ventas', tabla: 'sg_ven_liquidaciones', via: 'asiento_id',
    vivo: [{ col: 'estado', sql: "COALESCE(estado,'') <> 'anulada'" }],
    que: (r) => 'la liquidación de venta ' + _nro(r),
    pantalla: 'Ventas → Liquidaciones',
    como: 'ahí se anula la liquidación, y con ella su asiento y las cobranzas imputadas' },

  { modulo: 'cobranzas', tabla: 'sg_ven_cobranzas', via: 'asiento_id',
    vivo: [{ col: 'anulada', sql: 'COALESCE(anulada,0) = 0' }],
    que: (r) => 'la cobranza #' + r.id,
    pantalla: 'Ventas → Cobranzas',
    como: 'ahí se anula la cobranza y se libera lo que tenía imputado' },

  { modulo: 'pagos', tabla: 'sg_pagos_proveedores', via: 'asiento_id',
    vivo: [{ col: 'anulado', sql: 'COALESCE(anulado,0) = 0' }],
    que: (r) => 'el pago a proveedor #' + r.id,
    pantalla: 'Tesorería → Pagos',
    como: 'ahí se anula el pago y se libera lo que tenía imputado' },

  { modulo: 'abasto', tabla: 'liquidaciones', via: 'asiento_id',
    vivo: [{ col: 'eliminado_en', sql: 'eliminado_en IS NULL' }],
    que: (r) => 'la liquidación ' + (r.n_liquidacion || ('#' + r.id)),
    pantalla: 'Liquidaciones emitidas',
    como: 'ahí se da de baja la liquidación junto con su asiento' },

  // El código va ANCLADO. 'CHT-' es prefijo de 'CHT-A-', 'CHT-R-' y 'CHT-D-', así
  // que un LIKE se llevaría puestos los cuatro asientos del mismo cheque.
  { modulo: 'tesorería', tabla: 'sg_fin_cheques_terceros', via: 'ref_codigo',
    codigo: /^CHT-(?:A-|R-|D-)?(\d+)$/,
    vivo: [{ col: 'estado', sql: "COALESCE(estado,'') <> 'anulado'" }],
    que: (r) => 'el cheque de terceros ' + (r.nro_cheque || ('#' + r.id)),
    pantalla: 'Tesorería → Cheques de terceros',
    como: 'ahí se deshace el movimiento del cheque con su contra-asiento' },
];

// De qué operación nació este asiento. null = nació a mano, y ese SÍ se anula desde
// la pantalla de asientos, que es para lo que está el botón.
export function origenDeAsiento(db, asientoId, origenes = ORIGENES_SG, tablaCab = 'sg_asientos') {
  const cols = _cols(db, tablaCab);
  if (!cols) return null;
  const campos = ['id'];
  if (cols.has('ref_compra_id')) campos.push('ref_compra_id');
  if (cols.has('ref_codigo')) campos.push('ref_codigo');
  const a = db.prepare(`SELECT ${campos.join(', ')} FROM ${tablaCab} WHERE id=?`).get(asientoId);
  if (!a) return null;

  for (const o of origenes) {
    const vivo = _vivo(db, o);
    if (vivo == null) continue;                       // la tabla no existe acá
    const cs = _cols(db, o.tabla);
    let fila = null;
    try {
      if (o.via === 'ref_compra_id') {
        if (!a.ref_compra_id) continue;
        fila = db.prepare(`SELECT * FROM ${o.tabla} WHERE id=? AND (${vivo})`).get(a.ref_compra_id);
      } else if (o.via === 'asiento_id') {
        if (!cs.has('asiento_id')) continue;
        fila = db.prepare(`SELECT * FROM ${o.tabla} WHERE asiento_id=? AND (${vivo})`).get(a.id);
      } else if (o.via === 'ref_codigo') {
        const m = o.codigo.exec(String(a.ref_codigo || '').trim());
        if (!m) continue;
        fila = db.prepare(`SELECT * FROM ${o.tabla} WHERE id=? AND (${vivo})`).get(Number(m[1]));
      }
    } catch (_) { continue; }
    if (!fila) continue;
    const que = o.que(fila);
    return {
      modulo: o.modulo, tabla: o.tabla, registro_id: fila.id,
      comprobante: que, numero: _nro(fila), pantalla: o.pantalla, como_se_deshace: o.como,
      // Compatibilidad con lo que ya devolvían las rutas para la factura de compra.
      // factura_numero es el NÚMERO pelado --lo que se busca en una pantalla--,
      // no la frase entera: la frase va en `comprobante` y en el cartel.
      factura_id: fila.id, factura_numero: _nro(fila),
      error: 'Este asiento es de ' + que + '. No se anula desde acá: se deshace en '
           + o.pantalla + ', y ' + o.como + '. Anular sólo el asiento deja la '
           + 'operación viva y fuera del libro, y después no hay forma de rehacerlo.',
    };
  }
  return null;
}

// El mismo criterio para Puente Cordón, que vive en pa_asientos y tenía CERO frenos.
export const ORIGENES_PA = [
  { modulo: 'compras PC', tabla: 'pa_compras', via: 'ref_compra_id',
    vivo: [{ col: 'eliminado_en', sql: 'eliminado_en IS NULL' }],
    que: (r) => 'la compra ' + (r.numero_factura || r.numero || ('#' + r.id)),
    pantalla: 'Compras', como: 'ahí se da de baja la compra con su asiento' },
  { modulo: 'ventas PC', tabla: 'ven_liquidaciones', via: 'asiento_id',
    vivo: [{ col: 'estado', sql: "COALESCE(estado,'') <> 'anulada'" }],
    que: (r) => 'la liquidación de venta ' + (r.numero || ('#' + r.id)),
    pantalla: 'Liquidaciones de Producto', como: 'ahí se anula la liquidación con su asiento' },
  { modulo: 'ventas PC', tabla: 'ven_facturas', via: 'asiento_id',
    vivo: [{ col: 'estado', sql: "COALESCE(estado,'') <> 'anulada'" }],
    que: (r) => 'la factura de venta ' + (r.numero || ('#' + r.id)),
    pantalla: 'Facturas de venta', como: 'ahí se anula el comprobante con su asiento' },
  { modulo: 'tesorería PC', tabla: 'fin_ordenes_pago', via: 'asiento_id',
    vivo: [{ col: 'anulada', sql: 'COALESCE(anulada,0) = 0' }],
    que: (r) => 'la orden de pago ' + (r.numero || ('#' + r.id)),
    pantalla: 'Órdenes de pago', como: 'ahí se anula la orden con su asiento' },
  { modulo: 'personal PC', tabla: 'pa_liquidaciones_pago', via: 'asiento_id',
    vivo: [{ col: 'anulada', sql: 'COALESCE(anulada,0) = 0' }],
    que: (r) => 'la liquidación de pago de personal #' + r.id,
    pantalla: 'Personal → Liquidaciones', como: 'ahí se revierte la liquidación con su contra-asiento' },
];

export function origenDeAsientoPa(db, asientoId) {
  return origenDeAsiento(db, asientoId, ORIGENES_PA, 'pa_asientos');
}

export default { crearAsiento, filtroAmbito, totalesDeAsiento,
  origenDeAsiento, origenDeAsientoPa, ORIGENES_SG, ORIGENES_PA, AMBITOS, MOTIVOS };
