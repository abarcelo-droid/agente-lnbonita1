import { obtenerCliente } from "../servicios/db.js";
import { manejarMayorista }   from "./mayorista.js";
import { manejarMayoristaB }  from "./mayoristaB.js";
import { manejarMinorista }   from "./minorista.js";
import { manejarFoodService } from "./foodService.js";

export async function routearMensaje(telefono, mensaje) {
  const cliente = obtenerCliente(telefono);

  if (!cliente) {
    // Número desconocido → flujo de registro minorista por defecto
    return manejarMinorista(telefono, mensaje, null);
  }

  if (!cliente.activo) {
    return "Tu cuenta está deshabilitada. Comunicate con nosotros para más información.";
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
