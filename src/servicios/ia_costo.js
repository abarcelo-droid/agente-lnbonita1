// src/servicios/ia_costo.js
// ── LO QUE SE PUEDE SABER SIN ABRIR LA BASE ──────────────────────────────────────────
// Las etiquetas de función, los precios, el cálculo del costo y la traducción de un error
// de la API. Nada de esto necesita la base de datos, y separarlo compra dos cosas:
//
//   1. SE PUEDE PROBAR. `servicios/ia.js` importa la base, que necesita better-sqlite3 —
//      que acá no está. Con todo junto, los tests del cálculo del costo se salteaban en
//      silencio: 8 de 20 pasaban como "skipped" y yo los contaba como verdes.
//   2. El cálculo de una tarifa no tiene por qué depender de una base de datos.
//
// Quien llama a la IA sigue usando `servicios/ia.js`, que re-exporta todo esto. Este
// archivo no se importa desde los routers.
import { MODELO_CHAT, MODELO_OCR, MODELO_RAPIDO } from "../config/ia.js";

// ── QUIÉN LLAMA ──────────────────────────────────────────────────────────────────────
// Nombres cerrados, no texto libre. Texto libre son cuarenta maneras de escribir lo mismo
// y ningún informe posible — la misma razón por la que los motivos de gestión son una
// lista cerrada en asientos.js.
//
// La etiqueta es lo que va a leer alguien buscando qué se comió el crédito, así que dice
// la función del negocio y no el archivo: «Compras · leer un remito de insumos», no
// «produccion».
export const FUNCIONES = {
  'ifco-ocr-remito':      'IFCO · leer un remito',
  'ifco-ocr-sellado':     'IFCO · buscar el remito de un sellado',
  'combustible-leer-ticket': 'Combustible · leer un ticket de carga',
  'compra-leer-remito':   'Compras · leer un remito de insumos',
  'import-leer-factura':  'Importación · leer la factura',
  'import-leer-doc':      'Importación · leer un documento',
  'sg-leer-factura-mercaderia': 'SG · leer una factura de mercadería',
  'sg-leer-factura-gastos':     'SG · leer una factura de gastos',
  'liquidacion-parseo':   'Liquidaciones · interpretar el texto',
  'catalogo-duplicados':  'Catálogos · detectar duplicados',
  'buscador':             'Panel · buscador con IA',
  'whatsapp-agente':      'WhatsApp · responder a un cliente',
  'whatsapp-resumen':     'WhatsApp · resumir una conversación',
};

// ── LOS PRECIOS ──────────────────────────────────────────────────────────────────────
// Dólares por millón de tokens, al 6/10/2026. Se usan para congelar el costo de cada
// llamada EN EL MOMENTO, no para recalcular después: si mañana baja un precio, los
// informes de marzo tienen que seguir diciendo lo que se pagó en marzo.
//
// Y es una ESTIMACIÓN para saber quién gasta, no la factura. La factura es la de
// Anthropic, y la pantalla lo dice.
export const PRECIOS = {
  'claude-sonnet-4-6':         { entrada: 3, salida: 15 },
  'claude-haiku-4-5-20251001': { entrada: 1, salida: 5 },
  'claude-haiku-4-5':          { entrada: 1, salida: 5 },
};
// Un modelo que no esté en la tabla se cobra como el más caro que conocemos. A propósito:
// subestimar el gasto de algo que no sabemos medir es la forma de que un modelo nuevo y
// caro pase desapercibido justamente hasta que llega la factura.
const PRECIO_DESCONOCIDO = { entrada: 3, salida: 15 };

// Leer de caché sale ~0,1 de lo que sale entrar normal; escribirla, ~1,25.
const FACTOR_CACHE_LEE  = 0.1;
const FACTOR_CACHE_CREA = 1.25;

// En MILÉSIMAS de dólar, enteras: sumar miles de filas en coma flotante junta error, y una
// llamada de OCR cuesta menos de un centavo, así que el centavo no alcanza como unidad.
export function costoMilesimas(modelo, uso) {
  const p = PRECIOS[modelo] || PRECIO_DESCONOCIDO;
  const u = uso || {};
  const usd = ((u.input_tokens || 0) * p.entrada
             + (u.output_tokens || 0) * p.salida
             + (u.cache_read_input_tokens || 0) * p.entrada * FACTOR_CACHE_LEE
             + (u.cache_creation_input_tokens || 0) * p.entrada * FACTOR_CACHE_CREA) / 1e6;
  return Math.round(usd * 1000);
}

// ── CUANDO LA API FALLA ──────────────────────────────────────────────────────────────
// El motivo técnico es para el log y para la pantalla de consumo, que la mira un admin.
// El mensaje es para el que está trabajando.
//
// Está acá y no en cada router porque el 14/10 el de IFCO le mostró a Santiago, en el
// teléfono y en inglés, el JSON de facturación de Anthropic.
export function motivoFalla(e) {
  const crudo = String((e && e.message) || e || '');
  const st = (e && (e.status || e.statusCode)) || 0;
  if (/credit balance|insufficient|billing/i.test(crudo)) {
    return { operador: 'La IA quedó sin servicio. Cargalo a mano y avisá a la oficina.',
             admin: 'La cuenta de la API se quedó sin crédito.', crudo };
  }
  if (st === 429 || /rate.?limit|overloaded/i.test(crudo)) {
    return { operador: 'La IA está saturada. Probá de nuevo en un minuto, o cargalo a mano.',
             admin: 'La API contestó 429 / sobrecargada.', crudo };
  }
  if (st === 401 || st === 403 || /authentication|api.?key|permission/i.test(crudo)) {
    return { operador: 'La IA no está disponible. Cargalo a mano y avisá a la oficina.',
             admin: 'La API rechazó la credencial (401/403): revisar ANTHROPIC_API_KEY.', crudo };
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network/i.test(crudo)) {
    return { operador: 'No se pudo llegar a la IA. Cargalo a mano.',
             admin: 'No hubo respuesta de la API (red o timeout).', crudo };
  }
  return { operador: 'La IA no pudo resolverlo. Cargalo a mano.',
           admin: 'Falla no clasificada.', crudo };
}

export { MODELO_CHAT, MODELO_OCR, MODELO_RAPIDO };
