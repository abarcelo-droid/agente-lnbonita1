// src/config/ia.js
// ── Model IDs de Anthropic — fuente única de verdad ──────────────────────────
// Todo el repo importa desde acá. NO hardcodear model IDs en otros archivos.
//   MODELO_CHAT   → conversación / lectura de comprobantes con visión
//   MODELO_OCR    → OCR de imágenes (IFCO)
//   MODELO_RAPIDO → tareas cortas y baratas (parseo de texto, chequeo semántico)

export const MODELO_CHAT   = 'claude-sonnet-4-6';
export const MODELO_OCR    = 'claude-haiku-4-5-20251001';
export const MODELO_RAPIDO = 'claude-haiku-4-5-20251001';
