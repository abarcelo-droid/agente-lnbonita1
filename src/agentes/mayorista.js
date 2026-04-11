import { llamarClaude } from "./base.js";
import { catalogoComoTexto } from "../servicios/catalogo.js";
import { crearPedido } from "../servicios/db.js";
import { promptMayoristaA , instruccionesPago, INSTRUCCIONES_RETIRO_MAYORISTA } from "./prompts.js";

export async function manejarMayorista(telefono, mensaje, cliente) {
  const catalogo  = catalogoComoTexto("mayorista");
  const nombre    = cliente?.nombre || "amigo";

  const metodoPago = cliente?.metodo_pago || 'cuenta_corriente';
  const systemPrompt = promptMayoristaA(nombre, catalogo) + '\n\n' + instruccionesPago(metodoPago, 'mayorista') + '\n\n' + INSTRUCCIONES_RETIRO_MAYORISTA;
  const respuesta    = await llamarClaude(telefono, mensaje, systemPrompt, cliente);
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
