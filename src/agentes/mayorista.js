import { llamarClaude } from "./base.js";
import { obtenerCatalogo, catalogoComoTexto } from "../servicios/sheets.js";
import { crearPedido } from "../servicios/db.js";
import { promptMayoristaA } from "./prompts.js";

export async function manejarMayorista(telefono, mensaje, cliente) {
  const productos = await obtenerCatalogo("mayorista");
  const catalogo  = catalogoComoTexto(productos);
  const nombre    = cliente?.nombre || "amigo";

  const systemPrompt = promptMayoristaA(nombre, catalogo);
  const respuesta    = await llamarClaude(telefono, mensaje, systemPrompt);
  return procesarPedido(respuesta, telefono, "mayorista", "PEDIDO_MAYORISTA");
}

function procesarPedido(respuesta, telefono, tipo, tag) {
  const linea = respuesta.split("\n").find(l => l.startsWith(tag + "|"));
  if (!linea) return respuesta;

  try {
    const partes = linea.split("|");
    const idPedido = crearPedido({
      telefono,
      tipo_cliente:    tipo,
      detalle:         partes[2],
      total:           parseFloat(partes[3]) || 0,
      horario_entrega: null,
    });
    console.log(`[${tipo.toUpperCase()}] Pedido #${idPedido} — $${partes[3]}`);
  } catch (e) {
    console.error(`[${tipo}] Error procesando pedido:`, e.message);
  }

  return respuesta.replace(linea, "").trim();
}
