import { llamarClaude } from "./base.js";
import { obtenerCatalogo, catalogoComoTexto } from "../servicios/sheets.js";
import { crearPedido } from "../servicios/db.js";
import { promptMayoristaB } from "./prompts.js";

export async function manejarMayoristaB(telefono, mensaje, cliente) {
  const productos = await obtenerCatalogo("mayorista_b");
  const catalogo  = catalogoComoTexto(productos);
  const nombre    = cliente?.nombre || "amigo";

  const systemPrompt = promptMayoristaB(nombre, catalogo);
  const respuesta    = await llamarClaude(telefono, mensaje, systemPrompt);

  const linea = respuesta.split("\n").find(l => l.startsWith("PEDIDO_MAYORISTA_B|"));
  if (!linea) return respuesta;

  try {
    const partes   = linea.split("|");
    const idPedido = crearPedido({
      telefono,
      tipo_cliente:    "mayorista_b",
      detalle:         partes[2],
      total:           parseFloat(partes[3]) || 0,
      horario_entrega: null,
    });
    console.log(`[MAYORISTA_B] Pedido #${idPedido} — $${partes[3]}`);
  } catch (e) {
    console.error("[MAYORISTA_B] Error procesando pedido:", e.message);
  }

  return respuesta.replace(linea, "").trim();
}
