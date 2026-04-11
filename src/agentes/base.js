import Anthropic from "@anthropic-ai/sdk";
import { obtenerSesion, guardarSesion } from "../servicios/db.js";
import {
  registrarActividad,
  marcarRequiereAtencion,
  obtenerInstruccionPendiente,
  marcarInstruccionAplicada,
  estaActiva,
} from "../servicios/conversaciones.js";

const client     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAX_HISTORIAL = 24;

// Frases que indican que el agente necesita instrucción del equipo
const TRIGGERS_ATENCION = [
  "lo hablo con andrés",
  "lo consulto con andrés",
  "te vuelvo con una respuesta",
  "lo veo con el equipo",
  "lo hablo internamente",
];

export async function llamarClaude(telefono, mensajeUsuario, systemPrompt, cliente) {
  // Si está pausada, no responder
  if (!estaActiva(telefono)) {
    return null; // El router maneja el silencio
  }

  const sesion = obtenerSesion(telefono);

  // Inyectar instrucción pendiente del equipo si existe
  const instruccion = obtenerInstruccionPendiente(telefono);
  let promptFinal   = systemPrompt;
  if (instruccion) {
    promptFinal = systemPrompt + `\n\n⚡ INSTRUCCIÓN INTERNA DEL EQUIPO (aplicar ahora, no mencionar al cliente):
${instruccion}

Aplicá esta instrucción en tu próxima respuesta de forma natural, como si fuera tu propia decisión.`;
    marcarInstruccionAplicada(telefono);
  }

  sesion.mensajes.push({ role: "user", content: mensajeUsuario });

  const response = await client.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system:     promptFinal,
    messages:   sesion.mensajes,
  });

  const respuesta = response.content[0].text;
  sesion.mensajes.push({ role: "assistant", content: respuesta });

  if (sesion.mensajes.length > MAX_HISTORIAL) {
    sesion.mensajes = sesion.mensajes.slice(-MAX_HISTORIAL);
  }

  guardarSesion(telefono, sesion.mensajes);

  // Registrar actividad y detectar si necesita atención
  const nombre = cliente?.nombre || telefono;
  const tipo   = cliente?.tipo   || "minorista";
  registrarActividad(telefono, tipo, nombre, mensajeUsuario.slice(0, 120));

  const respLower = respuesta.toLowerCase();
  if (TRIGGERS_ATENCION.some(t => respLower.includes(t))) {
    marcarRequiereAtencion(telefono, mensajeUsuario.slice(0, 200));
  }

  return respuesta;
}

// Genera un resumen de la conversación para el panel
export async function generarResumen(telefono) {
  const sesion = obtenerSesion(telefono);
  if (!sesion.mensajes.length) return "Sin mensajes aún.";

  const response = await client.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 300,
    system:     "Sos un asistente que resume conversaciones de ventas de forma muy breve. Máximo 3 líneas. Incluí: qué quiere el cliente, en qué punto está la charla, y si hay algo pendiente.",
    messages:   [{ role: "user", content: `Resumí esta conversación:\n${JSON.stringify(sesion.mensajes)}` }],
  });

  return response.content[0].text;
}
