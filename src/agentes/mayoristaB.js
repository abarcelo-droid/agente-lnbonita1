import { llamarClaude } from "./base.js";
import { catalogoComoTexto } from "../servicios/catalogo.js";
import { crearPedido } from "../servicios/db.js";
import { promptMayoristaB , instruccionesPago, INSTRUCCIONES_RETIRO_MAYORISTA } from "./prompts.js";

export async function manejarMayoristaB(telefono, mensaje, cliente) {
  const catalogo  = catalogoComoTexto("mayorista_b");
  const nombre    = cliente?.nombre || "amigo";

  const metodoPago = cliente?.metodo_pago || 'cuenta_corriente';
  const systemPrompt = promptMayoristaB(nombre, catalogo) + '\n\n' + instruccionesPago(metodoPago, 'mayorista_b') + '\n\n' + INSTRUCCIONES_RETIRO_MAYORISTA;
  const respuesta    = await llamarClaude(telefono, mensaje, systemPrompt, cliente);

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
