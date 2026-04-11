import { llamarClaude } from "./base.js";
import { catalogoComoTexto } from "../servicios/catalogo.js";
import { crearCliente, crearPedido } from "../servicios/db.js";
import { ultimaCompraMinorista } from "../servicios/db2.js";
import { promptMinorista , instruccionesPago, INSTRUCCIONES_ENTREGA_DIRECTA } from "./prompts.js";

export async function manejarMinorista(telefono, mensaje, cliente) {
  const catalogo     = catalogoComoTexto("minorista");
  const esNuevo      = !cliente;
  const nombre       = cliente?.nombre || "";

  // Verificar si tiene compra la semana pasada para ofrecer repetición
  let promptRepeticion = "";
  if (cliente) {
    const ultimaCompra = ultimaCompraMinorista(telefono);
    if (ultimaCompra) {
      let detallePrevio = [];
      try { detallePrevio = JSON.parse(ultimaCompra.detalle); } catch {}
      if (detallePrevio.length) {
        const resumen = detallePrevio.map(p => `${p.nombre} x${p.cantidad}`).join(", ");
        promptRepeticion = `
REPETICIÓN DE COMPRA:
Este cliente compró la semana pasada: ${resumen} (total: $${ultimaCompra.total?.toLocaleString("es-AR")}).
Si el cliente pregunta por sus compras anteriores o dice algo como "lo mismo que la semana pasada",
ofrecele repetir ese pedido con los precios actualizados del catálogo de hoy.
Confirmá cada item con el precio nuevo antes de cerrar.`;
      }
    }
  }

  const metodoPago = cliente?.metodo_pago || 'transferencia';
  const systemPrompt = promptMinorista(nombre, catalogo, esNuevo) + promptRepeticion + '\n\n' + instruccionesPago(metodoPago, 'minorista') + '\n\n' + INSTRUCCIONES_ENTREGA_DIRECTA;
  const respuesta    = await llamarClaude(telefono, mensaje, systemPrompt, cliente);
  if (!respuesta) return null;
  return procesarRespuesta(respuesta, telefono);
}

async function procesarRespuesta(respuesta, telefono) {
  let texto = respuesta;

  const lineaAlta = texto.split("\n").find(l => l.startsWith("ALTA_CLIENTE|"));
  if (lineaAlta) {
    try {
      const [, tel, nombre, empresa, email, direccion] = lineaAlta.split("|");
      crearCliente({ telefono: tel, tipo: "minorista", nombre, empresa, email, direccion, zona: null, notas: null });
      console.log(`[MINORISTA] Cliente nuevo: ${nombre} (${tel})`);
    } catch (e) { console.error("[MINORISTA] Error alta:", e.message); }
    texto = texto.replace(lineaAlta, "").trim();
  }

  const lineaPedido = texto.split("\n").find(l => l.startsWith("PEDIDO_MINORISTA|"));
  if (lineaPedido) {
    try {
      const partes   = lineaPedido.split("|");
      const idPedido = crearPedido({ telefono, tipo_cliente:"minorista", detalle:partes[2], total:parseFloat(partes[4])||0, horario_entrega:null });
      console.log(`[MINORISTA] Pedido #${idPedido}`);
    } catch (e) { console.error("[MINORISTA] Error pedido:", e.message); }
    texto = texto.replace(lineaPedido, "").trim();
  }

  return texto;
}
