// src/servicios/asientos.js
// ── EL ÚNICO LUGAR QUE ESCRIBE UN ASIENTO ────────────────────────────────────
//
// Antes había NUEVE `INSERT INTO sg_asientos` repartidos en cuatro archivos, y
// cada uno armaba sus líneas a mano. Mientras la única regla era "debe = haber"
// eso se podía sostener. Ahora hay dos reglas más —cada ámbito balancea por su
// cuenta, y una línea de gestión sin motivo no entra— y nueve copias de una
// regla son nueve lugares donde puede estar mal una.
//
// Así que el asiento se arma acá y sólo acá. Hay un test (`t-un-solo-escritor`)
// que falla si aparece un INSERT nuevo en cualquier otro archivo: no depende de
// que el próximo que toque esto se acuerde.
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

// ── EL ASIENTO DE UNA FACTURA DE COMPRA NO SE ANULA POR SU CUENTA ──────
//
// REGLA DE ORO: no hay factura de compra sin su asiento. Anular el asiento y
// dejar la factura viva la deja fuera del libro --una deuda que existe para el
// proveedor y no existe para la contabilidad-- y, peor, sin vuelta: la partida
// sigue marcada como facturada, así que tampoco se le puede cargar otra.
//
// La factura es el HECHO y el asiento su CONSECUENCIA. Se deshace el hecho.
//
// ESTO VIVE ACÁ, Y NO EN LA RUTA, PORQUE HAY DOS PANTALLAS QUE ANULAN ASIENTOS:
// la de San Gerónimo (rutas/sg.js) y la de Contabilidad SG (rutas/sg_contable.js).
// En la V793 el freno se puso en la primera y la segunda quedó abierta; por ahí
// se coló un asiento de compra el 21/8/2026. Una sola regla, un solo lugar.
export function frenoAsientoDeCompra(db, asientoId) {
  const a = db.prepare('SELECT ref_compra_id FROM sg_asientos WHERE id=?').get(asientoId);
  if (!a || !a.ref_compra_id) return null;
  const fc = db.prepare(`SELECT id, punto_venta, numero, activo
    FROM sg_facturas_compra WHERE id=?`).get(a.ref_compra_id);
  // Si la factura ya está dada de baja, su asiento no traba nada.
  if (!fc || !fc.activo) return null;
  const nro = (fc.punto_venta ? fc.punto_venta + '-' : '') + (fc.numero || '');
  return { factura_id: fc.id, factura_numero: nro,
    error: 'Este asiento es de la factura de compra ' + nro + '. Se anula DESDE LA FACTURA, '
         + 'en Facturas por mercadería: ahí se da de baja el comprobante y su asiento juntos, '
         + 'y la partida vuelve a esperar factura. Anular sólo el asiento dejaría la factura '
         + 'fuera del libro y la partida sin poder recibir otra.' };
}

export default { crearAsiento, filtroAmbito, totalesDeAsiento, frenoAsientoDeCompra, AMBITOS, MOTIVOS };
