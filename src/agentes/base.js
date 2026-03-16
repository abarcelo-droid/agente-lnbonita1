import Anthropic from "@anthropic-ai/sdk";
import { obtenerSesion, guardarSesion } from "../servicios/db.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAX_HISTORIAL = 24; // mensajes máximos por sesión

export async function llamarClaude(telefono, mensajeUsuario, systemPrompt) {
  const sesion = obtenerSesion(telefono);

  sesion.mensajes.push({ role: "user", content: mensajeUsuario });

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: systemPrompt,
    messages: sesion.mensajes,
  });

  const respuesta = response.content[0].text;
  sesion.mensajes.push({ role: "assistant", content: respuesta });

  // Recortar historial para no exceder tokens
  if (sesion.mensajes.length > MAX_HISTORIAL) {
    sesion.mensajes = sesion.mensajes.slice(-MAX_HISTORIAL);
  }

  guardarSesion(telefono, sesion.mensajes);
  return respuesta;
}
