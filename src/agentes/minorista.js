import { llamarClaude }    from "./base.js";
import { catalogoComoTexto } from "../servicios/catalogo.js";
import { crearCliente, crearPedido } from "../servicios/db.js";
import { ultimaCompraMinorista } from "../servicios/db2.js";
import { promptMinorista, promptSofiNuevo, instruccionesPago, INSTRUCCIONES_ENTREGA_DIRECTA } from "./prompts.js";
import { marcarRequiereAtencion } from "../servicios/conversaciones.js";

export async function manejarMinorista(telefono, mensaje, cliente) {
  const esNuevo = !cliente;

  // Cliente nuevo — flujo de bienvenida y derivacion
  if (esNuevo) {
    const catalogo    = catalogoComoTexto("minorista");
    const systemPrompt = promptSofiNuevo(catalogo);
    const respuesta   = await llamarClaude(telefono, mensaje, systemPrompt, null);
    if (!respuesta) return null;
    return procesarDerivacion(respuesta, telefono);
  }

  // Cliente existente — flujo normal de venta
  const nombre   = cliente.nombre || "";
  const catalogo = catalogoComoTexto("minorista");

  let promptRepeticion = "";
  const ultimaCompra = ultimaCompraMinorista(telefono);
  if (ultimaCompra) {
    let detallePrevio = [];
    try { detallePrevio = JSON.parse(ultimaCompra.detalle); } catch(e) {}
    if (detallePrevio.length) {
      const resumen = detallePrevio.map(function(p){ return p.nombre + " x" + p.cantidad; }).join(", ");
      promptRepeticion = `\nREPETICION DE COMPRA:\nEste cliente compro la semana pasada: ${resumen} (total: $${ultimaCompra.total?.toLocaleString("es-AR")}).\nSi el cliente dice "lo mismo que la semana pasada" o similar, ofreceле repetir ese pedido con precios actualizados.`;
    }
  }

  const metodoPago   = cliente.metodo_pago || "transferencia";
  const systemPrompt = promptMinorista(nombre, catalogo, false) + promptRepeticion + "\n\n" + instruccionesPago(metodoPago, "minorista") + "\n\n" + INSTRUCCIONES_ENTREGA_DIRECTA;
  const respuesta    = await llamarClaude(telefono, mensaje, systemPrompt, cliente);
  if (!respuesta) return null;
  return procesarPedido(respuesta, telefono);
}

async function procesarDerivacion(respuesta, telefono) {
  let texto = respuesta;

  const lineaDerivar = texto.split("\n").find(l => l.startsWith("DERIVAR|"));
  if (lineaDerivar) {
    const partes = lineaDerivar.split("|");
    const tipo   = partes[1];
    const nombre = partes[2] || "";
    const tel    = partes[3] || telefono;

    // Marcar en conversaciones segun tipo
    if (tipo === "mayorista_nuevo") {
      // Requiere atencion del comercial de guardia
      await marcarRequiereAtencion(telefono, `Nuevo mayorista potencial: ${nombre} - ${partes[4] || ""}`);
    } else if (tipo === "interior") {
      await marcarRequiereAtencion(telefono, `Distribuidor interior: ${nombre} - ${partes[4] || ""}`);
    } else if (tipo === "food_service") {
      await marcarRequiereAtencion(telefono, `Food Service: ${nombre} - ${partes[4] || ""}`);
    } else if (tipo === "atencion_cliente") {
      await marcarRequiereAtencion(telefono, `Atencion al cliente: ${nombre} - ${partes[4] || ""}`);
    } else if (tipo === "institucional") {
      await marcarRequiereAtencion(telefono, `Consulta institucional: ${nombre} - ${partes[4] || ""}`);
    }

    texto = texto.replace(lineaDerivar, "").trim();
  }

  // Alta de cliente minorista directo
  const lineaAlta = texto.split("\n").find(l => l.startsWith("ALTA_CLIENTE|"));
  if (lineaAlta) {
    try {
      const [, tel, nombre, empresa, email, direccion] = lineaAlta.split("|");
      crearCliente({ telefono: tel || telefono, tipo: "minorista", nombre, empresa, email, direccion, zona: null, notas: "Alta via WhatsApp", codigo_abasto: null, metodo_pago: "transferencia" });
    } catch(e) { console.error("[MINORISTA] Error alta:", e.message); }
    texto = texto.replace(lineaAlta, "").trim();
  }

  return texto;
}

async function procesarPedido(respuesta, telefono) {
  let texto = respuesta;

  const lineaPedido = texto.split("\n").find(l => l.startsWith("PEDIDO_MINORISTA|"));
  if (lineaPedido) {
    try {
      const partes = lineaPedido.split("|");
      crearPedido({ telefono, tipo_cliente: "minorista", detalle: partes[2], total: parseFloat(partes[4]) || 0, horario_entrega: null });
    } catch(e) { console.error("[MINORISTA] Error pedido:", e.message); }
    texto = texto.replace(lineaPedido, "").trim();
  }

  return texto;
}
