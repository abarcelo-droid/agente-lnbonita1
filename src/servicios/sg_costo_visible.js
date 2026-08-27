// ══ EL COSTO DE COMPRA NO VIAJA A QUIEN NO TIENE QUE VERLO ═════════════════════════════
//
// Pablo, 26/8/2026: «el vendedor ve a cuánto compramos». Y era cierto por varias puertas
// a la vez: la lista de partidas devolvía costo_base, costo_final y precio_unitario_kg de
// TODO el stock con una sola llamada; la ficha de una partida abría el legajo de compra
// entero; y el remito traía margen_estimado renglón por renglón, del que el costo se
// despeja exacto —costo = (subtotal − margen) / kg—.
//
// UNA SOLA PUERTA, NO UNA POR PANTALLA. Se había arreglado /oferta sacándole el costo del
// SELECT, y el arreglo se salteaba escribiendo /lotes-disponibles: las mismas partidas,
// el mismo filtro, con el costo puesto. Tapar agujero por agujero es garantizar que el
// próximo endpoint nazca abierto. Esto se monta como filtro de salida del router entero:
// una pantalla nueva no puede olvidarse de cerrarlo.
//
// LA REGLA ES SOBRE LA PERSONA, NO SOBRE LA PANTALLA. Quien tiene algún módulo donde el
// costo ES el trabajo —comprar, recibir, stock, reprocesos, gastos, importación, la cuenta
// del productor, la contabilidad— lo ve donde sea, porque de todos modos lo tiene a un
// clic. Quien sólo vende, no. Es la misma lógica que ya usa mejorNivel() para las
// escrituras compartidas entre pantallas.
import { nivelEnModulo } from './permisos.js';

// ── DÓNDE EL COSTO ES EL TRABAJO ───────────────────────────────────────────────────────
// Los módulos que quedan AFUERA a propósito, y por qué: sg-ventas (Salidas), sg-pedidos,
// sg-vta-comprobantes, sg-remitos-pend y sg-cc-clientes son el circuito de venta —ahí el
// número que importa es a cuánto se vende—; sg-catalogo y sg-pisos no costean nada.
export const MODULOS_COSTO = [
  'sg-compras',          // Ingresos: la recepción es donde el costo se carga
  'sg-ordenes',          // Órdenes de Compra: el precio acordado con el productor
  'sg-stock',            // la ficha de la partida, con costo base y costo final
  'sg-reprocesos',       // el costo de la madre es lo que se reparte entre los hijos
  'sg-gastos-directos',  // imputar un gasto a una partida cambia su costo
  'sg-gvariables',       // los gastos fijos se prorratean sobre el costo
  'sg-control-coop',     // lo que se le liquida al productor
  'sg-facturas-merc',    // la factura por la mercadería
  'sg-cc-proveedores',   // lo que se le debe a cada productor
  'sg-importacion',      // el cotizador de embarque es costo puro
  'sg-caja-bancos',      // paga esas facturas y concilia contra ellas
  'sg-dashboard',        // rentabilidad
  'sg-reportes',         // rentabilidad
  'sgct-plan-cuentas', 'sgct-asientos', 'sgct-modelos',
  'sgct-iva-compras', 'sgct-iva-ventas', 'sgct-puntos-venta',
];

export function puedeVerCosto(usuario) {
  if (!usuario || !usuario.id) return false;
  if (usuario.rol === 'admin') return true;
  return MODULOS_COSTO.some((m) => !!nivelEnModulo(usuario, m));
}

// ── QUÉ ES «COSTO» ─────────────────────────────────────────────────────────────────────
// Lista explícita y no un patrón tipo /costo|precio/. En este sistema conviven
// `precio_unitario_kg` —lo que se le PAGÓ al productor por kilo— y `precio_por_kg` —lo que
// se le COBRA al cliente—. Un patrón se llevaría puesto el segundo y dejaría las pantallas
// de venta sin el número que sí tienen que mostrar.
//
// El MARGEN entra en la lista: con el subtotal y los kilos al lado, el costo se despeja
// exacto. Esconder el costo y publicar el margen es no esconder nada.
export const CAMPOS_COSTO = new Set([
  // lo que costó la mercadería
  'costo_base', 'costo_final', 'costo_kg', 'costo_total', 'costo_unitario',
  'costo_vendido', 'costo_ars', 'costo_caja', 'costo_caja_neto',
  'costo_caja_c_impuestos', 'costo_caja_puesto', 'costo_transferido',
  'costo_kg_origen', 'costo_kg_madre', 'costo_madre', 'costo_promedio',
  // lo que se le paga al productor por kilo (NO 'precio_por_kg', que es la venta)
  'precio_unitario_kg', 'precio_kg_compra',
  // de acá se despeja el costo
  'margen', 'margen_estimado', 'margen_neto', 'margen_pct', 'margen_total',
  'margen_unitario', 'rentabilidad', 'rentabilidad_pct',
]);

// Recorre la respuesta y saca esos campos. Devuelve una copia: no toca las filas que el
// router pueda seguir usando para otra cosa.
//
// El tope de profundidad no es paranoia de manual: las fichas de partida anidan lote →
// orden → ítems → despachos → trazabilidad, y sin tope una referencia circular cuelga el
// pedido. Doce niveles cubren lo más hondo que arma este router con margen de sobra.
function podar(v, prof) {
  if (prof > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => podar(x, prof + 1));
  const out = {};
  for (const k of Object.keys(v)) {
    if (CAMPOS_COSTO.has(k)) continue;
    out[k] = podar(v[k], prof + 1);
  }
  return out;
}

export function sinCosto(dato) { return podar(dato, 0); }

// ── EL FILTRO DE SALIDA ────────────────────────────────────────────────────────────────
// Se monta una vez sobre el router y envuelve res.json. Sólo mira las LECTURAS: en un POST
// el que escribe está cargando el costo, y devolverle lo que acaba de mandar no le muestra
// nada que no supiera.
//
// Va DESPUÉS del portón de sesión y no lo reemplaza: quien no tiene sesión no llega hasta
// acá. Y a quien sí puede ver el costo no le cambia absolutamente nada — ni siquiera se
// copia la respuesta.
export function filtrarCosto(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let user = null;
  try { user = JSON.parse(req.cookies?.lnb_user || 'null'); } catch { user = null; }
  if (puedeVerCosto(user)) return next();

  const json = res.json.bind(res);
  res.json = (cuerpo) => json(sinCosto(cuerpo));
  next();
}
