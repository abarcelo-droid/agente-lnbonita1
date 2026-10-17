// src/servicios/ia.js
// ── UN SOLO LUGAR LLAMA A LA IA ──────────────────────────────────────────────────────
// Mismo criterio que `servicios/asientos.js` con los asientos: había nueve INSERT en
// cuatro archivos y se unificaron en uno. Acá era peor, porque además había DOS formas de
// llamar —el SDK y `fetch` crudo, en siete archivos— y ninguna dejaba rastro.
//
// Todo pasa por `llamarIA()`. Eso compra tres cosas:
//
//   1. QUEDA REGISTRADO. Qué función, qué modelo, cuántos tokens, cuánto costó. Es lo que
//      hacía falta el 14/10/2026, cuando la cuenta se quedó sin crédito, el lector de
//      remitos dejó de leer y no hubo forma de saber qué lo había consumido: las doce
//      funciones usan la MISMA clave, así que la consola de Anthropic las muestra como un
//      solo número por modelo.
//   2. Un error de la API se traduce UNA VEZ. Antes cada sitio inventaba su mensaje, y el
//      de IFCO le mostró a Santiago el JSON de facturación de Anthropic, en inglés.
//   3. El día que haya que cambiar de modelo, subir un timeout o poner un tope de gasto,
//      se toca acá y no en diez lugares.
//
// Lo garantiza `test/ia_un_solo_llamador.test.mjs`, que falla si aparece otra llamada
// suelta — igual que el test de un solo escritor de asientos.
//
// ── POR QUÉ EL CÁLCULO VIVE EN OTRO ARCHIVO ─────────────────────────────────────────
// Este importa la base, que necesita better-sqlite3 — que en esta máquina no está. Con
// todo junto, los tests del costo se salteaban EN SILENCIO: 8 de 20 pasaban como
// "skipped" y yo los estaba contando como verdes. Lo puro vive en `ia_costo.js`, que no
// importa nada, y se re-exporta desde acá para que los routers importen un solo módulo.
import db from "./db_ia_uso.js";
import { FUNCIONES, PRECIOS, costoMilesimas, motivoFalla,
         MODELO_CHAT, MODELO_OCR, MODELO_RAPIDO } from "./ia_costo.js";

export { FUNCIONES, PRECIOS, costoMilesimas, motivoFalla,
         MODELO_CHAT, MODELO_OCR, MODELO_RAPIDO };

// ── EL CLIENTE ───────────────────────────────────────────────────────────────────────
// EL SDK SE CARGA A DEMANDA, no con un `import` arriba. Dos razones, las dos reales: acá
// no hay node_modules, y en producción un paquete que no carga tiene que degradar la
// función, no voltear el arranque del server. Es el patrón que ya usaba rutas/ifco.js.
let _cliente = null;
async function cliente() {
  const clave = process.env.ANTHROPIC_API_KEY || '';
  if (!clave) return null;
  if (_cliente) return _cliente;
  try {
    const mod = await import('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod.Anthropic;
    _cliente = new Anthropic({ apiKey: clave });
    return _cliente;
  } catch (e) {
    console.error('[IA] No se pudo cargar @anthropic-ai/sdk:', e.message);
    return null;
  }
}
// Para que un router pueda contestar «la IA no está disponible» sin intentar la llamada.
export function hayIA() { return !!(process.env.ANTHROPIC_API_KEY || ''); }

// ── EL REGISTRO ──────────────────────────────────────────────────────────────────────
// NUNCA TIRA. Que se caiga una carga de remito porque no se pudo anotar cuánto costó
// sería cambiar un problema contable por uno operativo.
function anotar(fila) {
  try {
    db.prepare(`INSERT INTO ia_uso
      (funcion, modelo, tok_entrada, tok_salida, tok_cache_lee, tok_cache_crea,
       costo_mil, ms, ok, error, usuario_id, usuario)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      fila.funcion, fila.modelo, fila.tok_entrada, fila.tok_salida,
      fila.tok_cache_lee, fila.tok_cache_crea, fila.costo_mil, fila.ms,
      fila.ok ? 1 : 0, fila.error || null, fila.usuario_id || null, fila.usuario || null);
  } catch (e) {
    console.error('[IA] no se pudo anotar el consumo:', e.message);
  }
}

// ── LA LLAMADA ───────────────────────────────────────────────────────────────────────
// Devuelve EXACTAMENTE lo que devuelve el SDK, que es lo mismo que traía el `fetch` crudo
// que varios sitios usaban. Así convertir un sitio fue cambiar la línea de la llamada y
// nada más: lo que leía de `data.content` sigue leyendo de `data.content`.
//
// `funcion` es obligatoria y tiene que estar en FUNCIONES. Si se dejara pasar un nombre
// cualquiera, en seis meses la pantalla tendría quince etiquetas que son la misma cosa.
export async function llamarIA(funcion, params, opts) {
  if (!FUNCIONES[funcion]) {
    throw new Error('[IA] función desconocida: "' + funcion
      + '". Agregala a FUNCIONES en servicios/ia_costo.js.');
  }
  const c = await cliente();
  if (!c) {
    const e = new Error('ANTHROPIC_API_KEY no configurada, o el SDK no cargó');
    e.status = 401;
    throw e;
  }
  const o = opts || {};
  const t0 = Date.now();
  const modelo = params.model;
  try {
    // `opts.headers` pasa de largo al SDK: buscar.js y sg.js mandan un header beta cuando
    // el adjunto es un PDF, y el envoltorio no puede ser la razón por la que deje de andar.
    const msg = await c.messages.create(params, o.headers ? { headers: o.headers } : undefined);
    anotar({
      funcion, modelo,
      tok_entrada:    (msg.usage && msg.usage.input_tokens) || 0,
      tok_salida:     (msg.usage && msg.usage.output_tokens) || 0,
      tok_cache_lee:  (msg.usage && msg.usage.cache_read_input_tokens) || 0,
      tok_cache_crea: (msg.usage && msg.usage.cache_creation_input_tokens) || 0,
      costo_mil: costoMilesimas(modelo, msg.usage),
      ms: Date.now() - t0, ok: true,
      usuario_id: o.usuario_id, usuario: o.usuario,
    });
    return msg;
  } catch (e) {
    // LA FALLIDA SE ANOTA IGUAL, con costo cero y el motivo. Es la fila que explica un día
    // raro: cien intentos fallidos no cuestan nada y sí dicen que algo se rompió.
    const m = motivoFalla(e);
    anotar({
      funcion, modelo,
      tok_entrada: 0, tok_salida: 0, tok_cache_lee: 0, tok_cache_crea: 0,
      costo_mil: 0, ms: Date.now() - t0, ok: false, error: m.admin,
      usuario_id: o.usuario_id, usuario: o.usuario,
    });
    console.error('[IA][' + funcion + '] ' + m.admin + ' — ' + m.crudo);
    throw e;
  }
}
