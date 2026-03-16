import { llamarClaude } from "./base.js";
import { obtenerCatalogo, catalogoComoTexto } from "../servicios/sheets.js";
import { crearPedido, actualizarCliente } from "../servicios/db.js";
import { promptFoodService } from "./prompts.js";

export async function manejarFoodService(telefono, mensaje, cliente) {
  const productos = await obtenerCatalogo("food_service");
  const catalogo  = catalogoComoTexto(productos);
  const nombre    = cliente?.nombre || "amigo";
  const horario   = cliente?.horario_entrega || null;

  const systemPrompt = promptFoodService(nombre, catalogo, horario);
  const respuesta    = await llamarClaude(telefono, mensaje, systemPrompt);
  return procesarRespuesta(respuesta, telefono);
}

async function procesarRespuesta(respuesta, telefono) {
  const linea = respuesta.split("\n").find(l => l.startsWith("PEDIDO_FOODSERVICE|"));
  if (!linea) return respuesta;

  try {
    const partes   = linea.split("|");
    const horario  = partes[3];
    const idPedido = crearPedido({
      telefono,
      tipo_cliente:    "food_service",
      detalle:         partes[2],
      total:           parseFloat(partes[4]) || 0,
      horario_entrega: horario,
    });

    // Guardar último horario propuesto en el perfil
    actualizarCliente(telefono, { horario_entrega: horario });
    console.log(`[FOOD_SERVICE] Pedido #${idPedido} — Horario: ${horario}`);
  } catch (e) {
    console.error("[FOOD_SERVICE] Error pedido:", e.message);
  }

  return respuesta.replace(linea, "").trim();
}
