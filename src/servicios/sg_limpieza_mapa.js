// src/servicios/sg_limpieza_mapa.js
//
// ══ QUÉ SE BORRA EN CADA PANTALLA ══════════════════════════════════════════
//
// El mapa. La mecánica está en sg_limpieza.js; acá sólo se declara, para que esto se
// pueda leer de corrido y discutir sin entender el motor.
//
// ── EL ORDEN ENTRE MÓDULOS NO ES UNA SUGERENCIA ────────────────────────────
//
// Las claves foráneas están ENCENDIDAS (db.js:22). Si un módulo se aprieta antes que
// otro del que depende, SQLite corta con «FOREIGN KEY constraint failed» y no borra
// nada — el módulo queda intacto, no a medias, porque todo va en una transacción.
// Por eso cada uno declara `orden` y `requiere`: la pantalla los muestra en ese orden
// y avisa cuál falta antes.
//
// ── UNA TABLA, UN DUEÑO ────────────────────────────────────────────────────
//
// Ninguna tabla aparece en dos módulos. Si apareciera, el conteo sumaría sus filas dos
// veces y el cartel diría que se va más de lo que se va. Cuando una tabla del módulo A
// bloquea al módulo B, B la nombra en su `aviso`, no en sus `tablas`.
import { registrar } from './sg_limpieza.js';

// ── 1 · COBRANZAS ──────────────────────────────────────────────────────────
// Va primero de ventas: sus filas bloquean los comprobantes.
registrar({
  clave: 'sg-cc-clientes', orden: 10,
  pantalla: 'Cuenta corriente de clientes',
  requiere: [],
  aviso: 'La cuenta corriente no guarda un saldo: lo calcula en vivo con los comprobantes '
    + 'menos lo cobrado. Se va a cero sola cuando se borren las cobranzas y los comprobantes.',
  tablas: [
    { tabla: 'sg_ven_cobranza_docs', que_es: 'contra qué comprobante se imputó cada cobranza' },
    { tabla: 'sg_ven_cobranzas', que_es: 'las cobranzas' },
  ],
  no_se_tocan: ['sg_clientes (el alta, y su saldo de apertura)', 'sg_cliente_categorias'],
});

// ── 2 · COMPROBANTES EMITIDOS ──────────────────────────────────────────────
registrar({
  clave: 'sg-comprobantes-emitidos', orden: 20,
  pantalla: 'Comprobantes emitidos',
  requiere: ['sg-cc-clientes'],
  // El asiento NO se borra acá: sg_ven_facturas.asiento_id es clave foránea hacia
  // sg_asientos, así que el asiento tiene que morir DESPUÉS de la factura. Lo hace el
  // módulo de Asientos, que va último de todo.
  aviso: 'Un comprobante con CAE que ya salió por ARCA no se borra en ARCA: acá se va de la '
    + 'base y allá queda. Los asientos de estas ventas los borra la pantalla de Asientos '
    + 'Contables, que va al final.',
  tablas: [
    { tabla: 'sg_ven_envios', que_es: 'los mails con el comprobante adjunto' },
    { tabla: 'sg_factura_despachos', que_es: 'qué kilos de cada remito documentó cada comprobante' },
    { tabla: 'sg_ven_factura_items', que_es: 'los renglones del comprobante' },
    { tabla: 'sg_ven_facturas', que_es: 'facturas, notas de crédito y notas de débito' },
  ],
  no_se_tocan: ['sg_puntos_venta', 'sg_clientes'],
});

// ── 3 · LIQUIDACIONES DEL CLIENTE ──────────────────────────────────────────
// «Remitos pendientes de comprobante» no tiene tabla propia: es una consulta. Lo que
// sí tiene datos es la liquidación que EMITE EL CLIENTE, que se recibe desde ahí.
registrar({
  clave: 'sg-remitos-pendientes', orden: 30,
  pantalla: 'Remitos pendientes de comprobante',
  requiere: ['sg-cc-clientes'],
  aviso: 'Esta pantalla no guarda nada: es la lista de remitos cuyos kilos todavía no están '
    + 'en ningún comprobante. Lo que se borra acá son las LIQUIDACIONES QUE EMITE EL '
    + 'CLIENTE, que se reciben desde esta misma pantalla.',
  tablas: [
    { tabla: 'sg_liquidacion_despachos', que_es: 'qué kilos de cada remito cubrió la liquidación del cliente' },
    { tabla: 'sg_ven_liquidacion_items', que_es: 'los renglones de esa liquidación' },
    { tabla: 'sg_ven_liquidaciones', que_es: 'las liquidaciones que emitió el cliente' },
  ],
  no_se_tocan: ['sg_clientes'],
});

// ── 4 · GASTOS DIRECTOS ────────────────────────────────────────────────────
// Va ANTES de remitos y de partidas: sg_gastos_directos.despacho_id, .recepcion_id y
// .lote_id son claves foráneas reales y bloquean los tres.
registrar({
  clave: 'sg-gastos-directos', orden: 40,
  pantalla: 'Gastos Directos (fletes de entrada y salida, control cooperativa)',
  requiere: [],
  aviso: 'La solapa «Repasos» todavía no tiene datos. El ALTA de las cooperativas no se toca: '
    + 'lo que se borra son las descargas.',
  tablas: [
    { tabla: 'sg_gastos_directos', que_es: 'fletes de entrada y salida, descargas y control de cooperativa' },
    { tabla: 'sg_gastos_directos_lote', que_es: 'gastos imputados a una partida' },
    { tabla: 'sg_gastos_globales_periodo', que_es: 'los gastos del mes que van al resultado del período' },
  ],
  no_se_tocan: ['sg_cooperativas (el alta de la cuadrilla)', 'sg_proveedores'],
});

// ── 5 · SALIDAS ────────────────────────────────────────────────────────────
registrar({
  clave: 'sg-salidas', orden: 50,
  pantalla: 'Salidas (remitos y facturación directa)',
  requiere: ['sg-comprobantes-emitidos', 'sg-remitos-pendientes', 'sg-gastos-directos'],
  // Facturación directa no es otra tabla: por dentro llama al mismo circuito del remito,
  // así que deja fila acá igual que un remito a mano.
  aviso: 'BORRAR UN REMITO NO DEVUELVE LA MERCADERÍA AL STOCK: el remito descontó del piso '
    + 'cuando salió, y borrarlo no lo repone. Si se borra esto sin borrar Stock, esas '
    + 'partidas quedan descontadas para siempre. Los dos módulos van juntos.',
  tablas: [
    { tabla: 'sg_despacho_items', que_es: 'los renglones del remito' },
    { tabla: 'sg_despachos', que_es: 'los remitos y las salidas de facturación directa' },
  ],
  no_se_tocan: ['sg_clientes', 'sg_productos'],
});

// ── 6 · PEDIDOS ────────────────────────────────────────────────────────────
registrar({
  clave: 'sg-pedidos', orden: 60,
  pantalla: 'Pedidos',
  requiere: ['sg-salidas'],
  aviso: 'Borrar una reserva no toca el stock: la reserva compromete, no descuenta. Lo que '
    + 'descuenta es el remito.',
  tablas: [
    { tabla: 'sg_reservas', que_es: 'las reservas del pedido contra una partida o contra lo que viene en camino' },
    { tabla: 'sg_pedido_items', que_es: 'los renglones del pedido' },
    { tabla: 'sg_pedidos', que_es: 'los pedidos' },
  ],
  no_se_tocan: ['sg_clientes'],
});

// ── 7 · STOCK ──────────────────────────────────────────────────────────────
registrar({
  clave: 'sg-stock', orden: 70,
  pantalla: 'Stock (partidas, vencimientos y trazabilidad)',
  requiere: ['sg-salidas', 'sg-pedidos', 'sg-gastos-directos'],
  // EL CICLO. sg_lotes.reproceso_id apunta a sg_reprocesos y sg_reprocesos.lote_madre_id
  // apunta a sg_lotes: ningún orden de borrado funciona. Se rompe poniendo el vínculo
  // en NULL, y recién ahí los DELETE pasan. Lo mismo con transformado_de, que apunta a
  // la propia tabla.
  previo: [
    'UPDATE sg_lotes SET reproceso_id=NULL WHERE reproceso_id IS NOT NULL',
    'UPDATE sg_lotes SET transformado_de=NULL WHERE transformado_de IS NOT NULL',
  ],
  aviso: 'Se lleva también dónde estaba ubicada cada partida. El ALTA de los pisos no se toca.',
  tablas: [
    { tabla: 'sg_lote_traslados', que_es: 'los pases de un piso a otro' },
    { tabla: 'sg_lote_ubicaciones', que_es: 'cuánto hay de cada partida en cada piso' },
    { tabla: 'sg_lote_decomisos', que_es: 'los decomisos parciales' },
    { tabla: 'sg_lote_semaforo_historial', que_es: 'los cambios de semáforo' },
    { tabla: 'sg_transformaciones', que_es: 'las transformaciones de unidad (cajón a cubeta)' },
    { tabla: 'sg_reprocesos', que_es: 'los reprocesos con clasificación' },
    { tabla: 'sg_lotes', que_es: 'las partidas' },
  ],
  no_se_tocan: ['sg_pisos (el alta del piso)', 'sg_piso_usuarios', 'sg_productos', 'sg_presentaciones'],
});

// ── 8 · PISOS ──────────────────────────────────────────────────────────────
// Comparte tablas con Stock, así que NO las declara: si las declarara, el conteo las
// sumaría dos veces. Acá el botón sólo existe para decir dónde está el de verdad.
registrar({
  clave: 'sg-pisos', orden: 75,
  pantalla: 'Pisos',
  requiere: ['sg-stock'],
  aviso: 'Dónde está ubicada cada partida se borra junto con las partidas, en Stock. El ALTA '
    + 'de los pisos es configuración y no se toca.',
  tablas: [],
  no_se_tocan: ['sg_pisos (el alta del piso)', 'sg_piso_usuarios'],
});

// ── 9 · INGRESOS ───────────────────────────────────────────────────────────
registrar({
  clave: 'sg-ingresos', orden: 80,
  pantalla: 'Ingresos (recepciones)',
  requiere: ['sg-stock', 'sg-gastos-directos'],
  aviso: 'Las FOTOS de la recepción quedan en el disco: se borra la fila que las nombra, no '
    + 'el archivo. El número de recepción vuelve solo al 0001, porque sale de la propia tabla.',
  tablas: [
    { tabla: 'sg_recepcion_fotos', que_es: 'las fotos de la entrada' },
    { tabla: 'sg_recepcion_calidad', que_es: 'el informe de calidad por producto' },
    { tabla: 'sg_recepciones', que_es: 'las recepciones' },
  ],
  no_se_tocan: ['sg_proveedores', 'sg_productos', 'sg_pisos'],
});

// ── 10 · FACTURAS DE COMPRA ────────────────────────────────────────────────
registrar({
  clave: 'sg-facturas-compra', orden: 90,
  pantalla: 'Facturas por mercadería',
  requiere: ['sg-ingresos'],
  aviso: 'Los archivos adjuntos de la factura quedan en el disco. Los pagos a proveedores se '
    + 'borran en Cuenta corriente de proveedores, y los asientos al final.',
  tablas: [
    { tabla: 'sg_factura_percepciones', que_es: 'las percepciones de la factura' },
    { tabla: 'sg_factura_compra_ocs', que_es: 'qué partidas cubre cada factura' },
    { tabla: 'sg_facturas_compra', que_es: 'las facturas del proveedor' },
  ],
  no_se_tocan: ['sg_proveedores', 'sg_config_impositiva'],
});

// ── 11 · LIQUIDACIONES AL PRODUCTOR ────────────────────────────────────────
registrar({
  clave: 'sg-liquidaciones-productor', orden: 100,
  pantalla: 'Liquidaciones (al productor)',
  requiere: ['sg-ingresos'],
  // LA TABLA ES COMPARTIDA CON ABASTO. Las liquidaciones que se cargan sueltas —fuera
  // de la bandeja de partidas de San Gerónimo— tienen oc_id en NULL y NO son de acá.
  // Un DELETE sin filtro se llevaría las de abasto también.
  aviso: 'Sólo se borran las liquidaciones que salieron de una partida de San Gerónimo. Las '
    + 'que se cargaron sueltas son de Abasto y quedan donde están.',
  tablas: [
    { tabla: 'liquidaciones', que_es: 'las liquidaciones emitidas al productor',
      donde: 'oc_id IS NOT NULL',
      queda_porque: 'se cargaron sueltas, sin partida: son de Abasto' },
  ],
  no_se_tocan: ['sg_proveedores', 'las liquidaciones de Abasto (sin partida)'],
});

// ── 12 · ÓRDENES DE COMPRA ─────────────────────────────────────────────────
registrar({
  clave: 'sg-ordenes', orden: 110,
  pantalla: 'Órdenes de compra (emisión y recibidas)',
  requiere: ['sg-ingresos', 'sg-facturas-compra', 'sg-liquidaciones-productor', 'sg-pedidos'],
  aviso: 'Se lleva también el rastro de correcciones de precios y kilos. El número de orden '
    + 'vuelve solo al 0001: sale de la propia tabla, no de un contador guardado.',
  tablas: [
    { tabla: 'sg_oc_vencimientos', que_es: 'el cronograma de pago al proveedor' },
    { tabla: 'sg_oc_items', que_es: 'los renglones de la orden' },
    { tabla: 'sg_oc', que_es: 'las órdenes de compra' },
    { tabla: 'sg_ediciones', que_es: 'el rastro de correcciones con su motivo' },
  ],
  no_se_tocan: ['sg_proveedores', 'sg_productos', 'sg_condiciones_pago', 'sg_presentaciones'],
});

// ── 13 · IMPORTACIÓN ───────────────────────────────────────────────────────
registrar({
  clave: 'sg-importacion', orden: 115,
  pantalla: 'Importación (embarques)',
  requiere: ['sg-stock'],
  aviso: 'Los documentos del embarque quedan en el almacenamiento externo: se borra la fila '
    + 'que los nombra, no el archivo.',
  tablas: [
    { tabla: 'sg_embarque_precios', que_es: 'los precios del cotizador' },
    { tabla: 'sg_embarque_reales', que_es: 'lo que realmente llegó' },
    { tabla: 'sg_embarque_documentos', que_es: 'los documentos del embarque' },
    { tabla: 'sg_embarque_lineas', que_es: 'los renglones del embarque' },
    { tabla: 'sg_embarque_costos', que_es: 'los costos del embarque' },
    { tabla: 'sg_embarques', que_es: 'los embarques' },
  ],
  no_se_tocan: ['sg_tc_esperado (el tipo de cambio esperado, que es parametrización)'],
});

// ── 14 · PAGOS A PROVEEDORES ───────────────────────────────────────────────
// VA ANTES DE TESORERÍA: sg_fin_ordenes_pago apunta con clave foránea real a los
// movimientos y a los cheques. Con una sola fila viva acá, el borrado de Tesorería
// falla entero.
registrar({
  clave: 'sg-cc-proveedores', orden: 120,
  pantalla: 'Cuenta corriente de proveedores (pagos)',
  requiere: ['sg-facturas-compra', 'sg-liquidaciones-productor'],
  aviso: 'La cuenta corriente no guarda un saldo: lo calcula en vivo. La PLATA del pago —el '
    + 'movimiento de caja o banco y el cheque— se borra en Caja y Bancos, que va después.',
  tablas: [
    { tabla: 'sg_pagos_medios', que_es: 'con qué se pagó cada orden de pago' },
    { tabla: 'sg_pagos_compras', que_es: 'contra qué comprobante se imputó cada pago' },
    { tabla: 'sg_pagos_proveedores', que_es: 'los pagos' },
    { tabla: 'sg_fin_op_compras', que_es: 'las compras de una orden de pago' },
    { tabla: 'sg_fin_ordenes_pago', que_es: 'las órdenes de pago' },
  ],
  no_se_tocan: ['sg_proveedores', 'sg_fin_cuentas (el alta de la caja o el banco)'],
});

// ── 15 · CAJA Y BANCOS ─────────────────────────────────────────────────────
registrar({
  clave: 'sg-tesoreria', orden: 130,
  pantalla: 'Caja y Bancos',
  requiere: ['sg-cc-proveedores', 'sg-cc-clientes'],
  aviso: 'Se va toda la plata registrada: movimientos, cheques propios y de terceros, y las '
    + 'conciliaciones. El ALTA de las cajas y cuentas bancarias no se toca, ni su saldo de '
    + 'apertura ni quién puede tocarlas.',
  tablas: [
    { tabla: 'sg_fin_extracto_lineas', que_es: 'las líneas del extracto bancario' },
    { tabla: 'sg_fin_conciliaciones', que_es: 'las conciliaciones' },
    { tabla: 'sg_fin_movimientos', que_es: 'los movimientos de caja y banco' },
    { tabla: 'sg_fin_cheques_propios', que_es: 'los cheques propios' },
    { tabla: 'sg_fin_cheques_terceros', que_es: 'los cheques de terceros' },
    { tabla: 'sg_fin_chequeras', que_es: 'las chequeras usadas' },
  ],
  no_se_tocan: ['sg_fin_cuentas (el alta y su saldo de apertura)', 'sg_fin_cuenta_usuarios'],
});

// ── 16 · ASIENTOS ──────────────────────────────────────────────────────────
// ÚLTIMO DE TODO, y no es una recomendación. Tres módulos distintos apuntan a
// sg_asientos con clave foránea real —comprobantes, liquidaciones del cliente y
// órdenes de pago—: con una sola fila viva en cualquiera de los tres, el borrado de
// acá falla entero y no borra nada.
registrar({
  clave: 'sg-asientos', orden: 200,
  pantalla: 'Asientos Contables',
  requiere: ['sg-comprobantes-emitidos', 'sg-remitos-pendientes', 'sg-cc-proveedores',
    'sg-facturas-compra', 'sg-liquidaciones-productor', 'sg-tesoreria'],
  aviso: 'Va ÚLTIMO. Los comprobantes, las liquidaciones y las órdenes de pago apuntan a sus '
    + 'asientos: mientras quede uno de ellos, esto no se puede borrar. El plan de cuentas y '
    + 'los asientos modelo son configuración y no se tocan.',
  tablas: [
    { tabla: 'sg_asientos_lineas', que_es: 'los renglones del asiento' },
    { tabla: 'sg_asientos', que_es: 'los asientos' },
    { tabla: 'sg_movimientos_contables', que_es: 'los movimientos contables' },
  ],
  no_se_tocan: ['sg_cuentas y sus secciones y títulos (el plan de cuentas)',
    'sg_asientos_modelo y sus líneas', 'sg_config_impositiva'],
});

// Los dos Diarios de IVA no tienen botón: no guardan una sola fila propia. Se arman
// leyendo los comprobantes y las liquidaciones, así que se vacían solos.
