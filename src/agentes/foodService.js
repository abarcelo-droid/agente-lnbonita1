import { llamarClaude } from "./base.js";
import { catalogoComoTexto } from "../servicios/catalogo.js";
import { crearPedido, actualizarCliente } from "../servicios/db.js";
import { promptFoodService , instruccionesPago, INSTRUCCIONES_ENTREGA_DIRECTA } from "./prompts.js";

export async function manejarFoodService(telefono, mensaje, cliente) {
  const catalogo  = catalogoComoTexto("food_service");
  const nombre    = cliente?.nombre || "amigo";
  const horario   = cliente?.horario_entrega || null;

  const metodoPago = cliente?.metodo_pago || 'cuenta_corriente';
  const systemPrompt = promptFoodService(nombre, catalogo, horario) + '\n\n' + instruccionesPago(metodoPago, 'food_service') + '\n\n' + INSTRUCCIONES_ENTREGA_DIRECTA;
  const respuesta    = await llamarClaude(telefono, mensaje, systemPrompt, cliente);
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
