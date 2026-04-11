import { obtenerCliente, validarPuedeComprar } from "../servicios/db.js";
import { estaActiva } from "../servicios/conversaciones.js";
import { manejarMayorista }   from "./mayorista.js";
import { manejarMayoristaB }  from "./mayoristaB.js";
import { manejarMinorista }   from "./minorista.js";
import { manejarFoodService } from "./foodService.js";

export async function routearMensaje(telefono, mensaje) {
  if (!estaActiva(telefono)) {
    console.log("[ROUTER] Conversacion pausada para " + telefono);
    return null;
  }

  const cliente = obtenerCliente(telefono);

  // Cliente nuevo -> flujo minorista
  if (!cliente) return manejarMinorista(telefono, mensaje, null);

  if (!cliente.activo) {
    return "Tu cuenta esta deshabilitada. Comunicate con nosotros para mas informacion.";
  }

  // Verificar metodo de pago - bloquear cuentas canceladas
  const validacion = validarPuedeComprar(telefono);
  if (!validacion.puede) {
    console.log("[ROUTER] Cuenta cancelada: " + telefono);
    // Respuesta educada pero firme - el agente no puede ayudar con pedidos
    return "Hola! En este momento tu cuenta tiene un saldo pendiente de regularizacion. Para poder seguir operando necesitamos que te pongas en contacto con nosotros. Podes escribirnos a a.barcelo@lnbonita.com.ar o llamarnos al +54 11 5859-3234. Gracias!";
  }

  switch (cliente.tipo) {
    case "mayorista":    return manejarMayorista(telefono, mensaje, cliente);
    case "mayorista_b":  return manejarMayoristaB(telefono, mensaje, cliente);
    case "minorista":    return manejarMinorista(telefono, mensaje, cliente);
    case "food_service": return manejarFoodService(telefono, mensaje, cliente);
    default:
      return "No pude identificar tu tipo de cuenta. Escribinos al soporte.";
  }
}
