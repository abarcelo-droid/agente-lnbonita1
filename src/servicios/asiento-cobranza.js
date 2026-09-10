// ══ CON QUÉ CUENTAS SE CONTABILIZA UNA COBRANZA ═══════════════════════════
//
// Pablo, 8/9/2026: «lo mejor es definir un asiento modelo para la cobranza y
// seleccionar qué rubros registra cuando seleccionamos efectivo, banco o cheques.
// [...] La contabilización de la cobranza NO depende del cliente: toda la deuda va
// al rubro contable correspondiente».
//
// LO QUE HABÍA. La cobranza exigía que CADA CLIENTE tuviera una cuenta contable
// asignada en su ficha (sg_clientes.cuenta_contable_id) y, si no la tenía,
// contestaba 400 y no tomaba el cobro. Nadie asigna una cuenta por cliente —ni
// tiene por qué: la deuda de todos los clientes vive en el MISMO rubro, Deudores
// por Ventas, que es el que ya usa el asiento modelo de venta cuando se emite el
// comprobante—. Así que el cobro se cargaba, se apretaba guardar, y no entraba.
//
// LA FORMA. Un modelo, cuatro líneas marcadas:
//
//   cobro_clientes  (HABER) → la cuenta corriente que se cancela. Es la contracara
//                             exacta de la línea de Clientes del modelo de venta.
//   cobro_efectivo  (DEBE)  → dónde entra la plata en mano
//   cobro_banco     (DEBE)  → dónde entra una transferencia
//   cobro_cheques   (DEBE)  → dónde queda un cheque de tercero hasta depositarlo
//
// LOS TRES DEL DEBE SON EL PISO, NO LA ÚLTIMA PALABRA. Una caja o una cuenta
// bancaria de Caja y Bancos puede tener su propia cuenta contable —y la tiene,
// porque cada banco es una cuenta distinta del plan—: esa manda. El modelo es lo
// que contesta cuando la cuenta elegida no trae la suya, que hoy es el caso que
// deja la cobranza sin poder asentarse.
//
// Y el cliente que SÍ tenga cuenta propia la sigue usando: hay clientes que se
// llevan su propia cuenta corriente en el plan, y quitárselo sería romper lo que
// alguien configuró a propósito.
const CLAVE_MODELO_COBRANZA = 'asiento_modelo_cobranza';

// Los cuatro tipos que este modelo entiende, con de qué lado va cada uno. Está
// acá y no repartido por el código porque es lo que valida el editor de modelos,
// lo que lee el asiento y lo que dibuja la pantalla: tres lugares que tienen que
// decir lo mismo.
export const TIPOS_COBRANZA = [
  { tipo: 'cobro_clientes', lado: 'haber', label: 'Clientes / Deudores',
    ayuda: 'La cuenta corriente que se cancela. Es la misma que carga la venta.' },
  { tipo: 'cobro_efectivo', lado: 'debe', label: 'Efectivo',
    ayuda: 'Dónde entra la plata en mano, si la caja no trae su propia cuenta.' },
  { tipo: 'cobro_banco', lado: 'debe', label: 'Banco',
    ayuda: 'Dónde entra una transferencia, si la cuenta bancaria no trae la suya.' },
  { tipo: 'cobro_cheques', lado: 'debe', label: 'Cheques en cartera',
    ayuda: 'Dónde queda un cheque de tercero hasta que se deposita.' },
];

export function esModeloDeCobranza(lineas) {
  const tipos = TIPOS_COBRANZA.map((t) => t.tipo);
  return (lineas || []).some((l) => tipos.includes(l.tipo_linea));
}

export function modeloCobranzaLineas(db) {
  const cfg = db.prepare('SELECT valor FROM sg_config WHERE clave=?').get(CLAVE_MODELO_COBRANZA);
  const id = cfg && cfg.valor ? Number(cfg.valor) : null;
  if (!id) return { id: null, lineas: [] };
  const m = db.prepare('SELECT id FROM sg_asientos_modelo WHERE id=? AND activo=1').get(id);
  if (!m) return { id: null, perdido: id, lineas: [] };
  const lineas = db.prepare(`SELECT l.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre
    FROM sg_asientos_modelo_lineas l
    LEFT JOIN sg_cuentas c ON c.id = l.cuenta_id
    WHERE l.modelo_id=? ORDER BY l.orden, l.id`).all(id);

  // LA DE CHEQUES YA ESTABA EN OTRO LADO. La configuración impositiva tiene
  // 'cheques_cartera' desde antes de que este modelo existiera, y el depósito de
  // cheques la usa. Si el modelo no la trae, se completa con ésa: dos lugares
  // para la misma cuenta serían dos verdades, y la que ya está en uso es aquélla.
  if (!lineas.some((l) => l.tipo_linea === 'cobro_cheques')) {
    const c = db.prepare(`SELECT ci.cuenta_id, cu.codigo, cu.nombre
      FROM sg_config_impositiva ci LEFT JOIN sg_cuentas cu ON cu.id = ci.cuenta_id
      WHERE ci.clave = 'cheques_cartera' AND ci.cuenta_id IS NOT NULL`).get();
    if (c) {
      lineas.push({ id: -1, modelo_id: id, cuenta_id: c.cuenta_id, lado: 'debe',
        descripcion: c.nombre, orden: 900, tipo_linea: 'cobro_cheques',
        cuenta_codigo: c.codigo, cuenta_nombre: c.nombre, de_config_global: 1 });
    }
  }
  return { id, lineas };
}

// ══ LA CARTERA DE CHEQUES LA DECIDE UN SOLO LUGAR ═════════════════════════
//
// HABÍA CINCO LECTORES de la misma cuenta y no todos leían lo mismo:
//
//   · el cobro con cheque        (rutas/sg_ventas.js)
//   · el depósito del cheque     (rutas/sg_tesoreria.js)
//   · el alta manual en cartera  (rutas/sg_tesoreria.js)
//   · el endoso a un proveedor   (rutas/sg.js)
//   · y el cuadro que se aprueba antes de cobrar
//
// Mientras los cinco leían sg_config_impositiva no podían discrepar. Al dejar que
// el modelo de cobranza gane —para que la cuenta que se elige en la pantalla sea la
// que se usa— hacía falta que ganara PARA LOS CINCO. Si no, el cheque ENTRA por una
// cuenta y SALE por otra: cada asiento balancea por su lado, así que no salta
// ningún cartel, una cuenta se llena de cheques que ya se cobraron y la otra se va
// a negativo. Se descubre conciliando el mayor, meses después.
//
// EL ORDEN: la línea del modelo, y si no está, la de Configuración impositiva —que
// es de donde salía antes y sigue sirviendo para el que no armó modelo.
//
// Y NO DEPENDE DE QUE HAYA MODELO ELEGIDO. modeloCobranzaLineas() corta antes de
// completar nada cuando no hay ninguno, así que resolver por ahí dejaba sin cuenta
// a quien la tenía cargada en Configuración impositiva de toda la vida: el cobro
// con cheque pasaba a rebotar de un día para el otro.
export function cuentaCarteraCheques(db) {
  const m = modeloCobranzaLineas(db);
  const l = m.lineas.find((x) => x.tipo_linea === 'cobro_cheques');
  if (l && l.cuenta_id) return Number(l.cuenta_id);
  const c = db.prepare(`SELECT cuenta_id FROM sg_config_impositiva
    WHERE clave = 'cheques_cartera' AND cuenta_id IS NOT NULL`).get();
  return c && c.cuenta_id ? Number(c.cuenta_id) : null;
}

// Las cuatro cuentas, resueltas. Devuelve null en la que falte: quien llama
// decide si eso lo frena —depende de con qué se esté cobrando— en vez de exigir
// las cuatro para cobrar en efectivo.
export function cuentasDeCobranza(db) {
  const m = modeloCobranzaLineas(db);
  const de = (t) => {
    const l = m.lineas.find((x) => x.tipo_linea === t);
    return l && l.cuenta_id ? Number(l.cuenta_id) : null;
  };
  return {
    modelo_id: m.id, perdido: m.perdido || null,
    clientes: de('cobro_clientes'),
    efectivo: de('cobro_efectivo'),
    banco: de('cobro_banco'),
    // La de cheques sale del resolutor: es la MISMA que van a usar el depósito, el
    // endoso y el alta manual. Con de('cobro_cheques') a secas, sin modelo elegido
    // daba null aunque estuviera cargada en Configuración impositiva.
    cheques: cuentaCarteraCheques(db),
  };
}

// Qué le falta al modelo, dicho ANTES de que haya un cobro cargado y alguien
// esperando. Sólo la de Clientes es obligatoria: sin ella no hay contra qué
// cancelar y no se puede cobrar con NINGÚN medio. Las otras tres se avisan como
// lo que son —un piso que puede no hacer falta si todas las cajas y cuentas
// traen la suya— y por eso no frenan.
export function modeloCobranzaFaltan(db) {
  const c = cuentasDeCobranza(db);
  const faltan = [];
  if (!c.modelo_id) {
    return { faltan: ['no hay ningún asiento modelo de cobranza elegido'], corta: true, cuentas: c };
  }
  if (!c.clientes) {
    faltan.push('la línea de Clientes / Deudores, que es contra qué se cancela el cobro');
  }
  return { faltan, corta: !c.clientes, cuentas: c };
}

// LA CUENTA DEL CLIENTE, CON SU ORDEN DE PRECEDENCIA. Un solo lugar, porque lo
// usan el POST de la cobranza y el preview de la pantalla, y si contestaran
// distinto el cuadro que se aprueba no sería el que se graba.
export function cuentaCorrienteDe(db, cliente) {
  if (cliente && cliente.cuenta_contable_id) {
    return { cuenta_id: Number(cliente.cuenta_contable_id), de: 'cliente' };
  }
  const c = cuentasDeCobranza(db);
  return c.clientes ? { cuenta_id: c.clientes, de: 'modelo' } : { cuenta_id: null, de: null };
}

export { CLAVE_MODELO_COBRANZA };
