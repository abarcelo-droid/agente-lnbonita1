// src/servicios/dedup.js
// ── Detector de duplicados para catálogos SG (genérico/reutilizable) ──────────
// Dos motores en cascada al crear un ítem:
//   1) FUZZY (gratis, en el server): normaliza el nombre (minúsculas, sin acentos,
//      trim, espacios colapsados, orden de palabras) y lo compara contra los
//      existentes con similitud Levenshtein. Capta mayúsculas, acentos, espacios,
//      plurales, palabras desordenadas y typos.
//   2) SEMÁNTICO (IA, Haiku): SOLO si el fuzzy no superó el umbral. Capta sinónimos
//      ("cajón plástico" ≈ "envase de plástico"). Una llamada barata por alta que
//      el fuzzy dejó pasar — no se paga IA cuando el fuzzy ya bloqueó.
//
// Pensado para reusar en cualquier catálogo sg_* (envases, especies, variedades…):
//   await detectarDuplicado(db, { tabla: 'sg_envases', columna: 'nombre', nombre })
//
// NO toca zona contable de Pablo.

import Anthropic from '@anthropic-ai/sdk';

// ── CONFIG (calibrable sin tocar la lógica) ───────────────────────────────────
// Umbral de similitud [0..1] que dispara el BLOQUEO en el fuzzy. Subilo para ser
// más permisivo (menos bloqueos), bajalo para ser más estricto. 0.80 ≈ tolera
// acentos/espacios/orden de palabras y typos de 1 carácter en nombres cortos;
// lo que el fuzzy deja pasar (sinónimos, plurales largos) lo agarra la capa IA.
export const UMBRAL_BLOQUEO = 0.80;
// Capa semántica (IA) encendida. Si no hay ANTHROPIC_API_KEY se saltea sola.
export const SEMANTICO_ACTIVADO = true;
// Modelo para el chequeo semántico (decisión Andy: Haiku por costo/latencia).
export const MODELO_SEMANTICO = 'claude-haiku-4-5';

// Normaliza para comparar: sin acentos, minúsculas, espacios colapsados, tokens ordenados.
export function normalizar(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca acentos (diacríticos combinados)
    .toLowerCase().trim()
    .replace(/\s+/g, ' ')                              // colapsa espacios
    .split(' ').filter(Boolean).sort().join(' ');      // token-sort (palabras desordenadas)
}

// Distancia de Levenshtein (edición) entre dos strings.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

// Ratio de similitud [0..1] (1 = idénticos) sobre los nombres ya normalizados.
export function ratio(a, b) {
  if (!a.length && !b.length) return 1;
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

// Segundo filtro: pregunta a la IA si el candidato es lo mismo que algún existente.
// Devuelve {id, nombre} del match, o null. Falla "seguro" (null) si no hay API o error.
async function detectarSemantico(nombre, filas) {
  if (!process.env.ANTHROPIC_API_KEY || !filas.length) return null;
  try {
    const lista = filas.map((r, i) => `${i + 1}. ${r.nombre}`).join('\n');
    const prompt =
      'Sos un detector de duplicados para un catálogo de ítems (ej. tipos de envase de venta).\n' +
      'Te doy un nombre CANDIDATO y una lista de EXISTENTES. Decidí si el candidato significa ' +
      'LO MISMO que alguno de los existentes: sinónimo, misma cosa con otro nombre, singular/plural, ' +
      'abreviatura o variante de escritura. NO marques como duplicado cosas apenas relacionadas pero ' +
      'distintas (ej. "cajón" vs "bolsa" son distintos).\n\n' +
      `CANDIDATO: "${nombre}"\n` +
      `EXISTENTES:\n${lista}\n\n` +
      'Respondé SOLO un JSON, sin texto extra: {"match_index": <número de la lista o null>}. ' +
      'null si el candidato es genuinamente nuevo.';
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: MODELO_SEMANTICO,
      max_tokens: 64,
      messages: [{ role: 'user', content: prompt }],
    });
    const txt = (resp.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const idx = JSON.parse(m[0]).match_index;
    if (idx == null || !Number.isInteger(idx)) return null;
    const fila = filas[idx - 1];
    return fila ? { id: fila.id, nombre: fila.nombre } : null;
  } catch (e) {
    console.warn('[dedup] semántico falló (se sigue solo con fuzzy):', e.message);
    return null;
  }
}

// Detecta si `nombre` ya existe (parecido) en tabla.columna.
// Devuelve { bloqueado:false } o { bloqueado:true, motivo:'fuzzy'|'semantico', candidato:{id,nombre}, score }.
export async function detectarDuplicado(db, { tabla, columna = 'nombre', nombre, soloActivos = true }) {
  const cand = normalizar(nombre);
  if (!cand) return { bloqueado: false };
  const where = soloActivos ? 'WHERE activo=1' : '';
  const filas = db.prepare(`SELECT id, ${columna} AS nombre FROM ${tabla} ${where}`).all();

  // 1) Fuzzy
  let mejor = null, mejorScore = 0;
  for (const f of filas) {
    const s = ratio(cand, normalizar(f.nombre));
    if (s > mejorScore) { mejorScore = s; mejor = f; }
  }
  if (mejor && mejorScore >= UMBRAL_BLOQUEO) {
    return { bloqueado: true, motivo: 'fuzzy', candidato: { id: mejor.id, nombre: mejor.nombre }, score: Number(mejorScore.toFixed(3)) };
  }

  // 2) Semántico (solo si el fuzzy no bloqueó)
  if (SEMANTICO_ACTIVADO) {
    const hit = await detectarSemantico(nombre, filas);
    if (hit) return { bloqueado: true, motivo: 'semantico', candidato: hit, score: null };
  }

  return { bloqueado: false };
}
