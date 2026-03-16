import { llamarClaude } from "./base.js";
import { obtenerCatalogo, catalogoComoTexto } from "../servicios/sheets.js";
import { crearCliente, crearPedido } from "../servicios/db.js";
import { promptMinorista } from "./prompts.js";

export async function manejarMinorista(telefono, mensaje, cliente) {
  const productos = await obtenerCatalogo("minorista");
  const catalogo  = catalogoComoTexto(productos);
  const esNuevo   = !cliente;
  const nombre    = cliente?.nombre || "";

  const systemPrompt = promptMinorista(nombre, catalogo, esNuevo);
  const respuesta    = await llamarClaude(telefono, mensaje, systemPrompt);
  return procesarRespuesta(respuesta, telefono);
}

async function procesarRespuesta(respuesta, telefono) {
  let texto = respuesta;

  // Alta de cliente nuevo
  const lineaAlta = texto.split("\n").find(l => l.startsWith("ALTA_CLIENTE|"));
  if (lineaAlta) {
    try {
      const [, tel, nombre, empresa, email, direccion] = lineaAlta.split("|");
      crearCliente({ telefono: tel, tipo: "minorista", nombre, empresa, email, direccion, zona: null, notas: null });
      console.log(`[MINORISTA] Cliente nuevo: ${nombre} (${tel})`);
    } catch (e) {
      console.error("[MINORISTA] Error alta cliente:", e.message);
    }
    texto = texto.replace(lineaAlta, "").trim();
  }

  // Pedido confirmado
  const lineaPedido = texto.split("\n").find(l => l.startsWith("PEDIDO_MINORISTA|"));
  if (lineaPedido) {
    try {
      const partes   = lineaPedido.split("|");
      const idPedido = crearPedido({
        telefono,
        tipo_cliente:    "minorista",
        detalle:         partes[2],
        total:           parseFloat(partes[4]) || 0,
        horario_entrega: null,
      });
      console.log(`[MINORISTA] Pedido #${idPedido} — $${partes[4]}`);
      // TODO Etapa 4: generar link Mercado Pago
    } catch (e) {
      console.error("[MINORISTA] Error pedido:", e.message);
    }
    texto = texto.replace(lineaPedido, "").trim();
  }

  return texto;
}
