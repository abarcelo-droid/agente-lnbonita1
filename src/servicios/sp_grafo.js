// src/servicios/sp_grafo.js
// ── VALIDACIÓN ESTRUCTURAL DEL CIRCUITO — función pura ────────────────────
// Sin acceso a base de datos a propósito: acá vive el control más importante del
// módulo (que no se pueda configurar un circuito que saltee la autorización) y
// tiene que poder testearse sin levantar nada.
//
// Lo que depende de PERSONAS (quién está habilitado, deadlocks de segregación de
// funciones) vive en sp_motor.js, que sí consulta la base.

// Hitos por los que TODO camino al cierre tiene que pasar. Va en código, no en
// tabla: si fuera configurable, se podría desarmar el control desde el
// configurador en vez de desde la transacción, que es justo lo que hay que evitar.
export const HITOS_OBLIGATORIOS = ['autorizacion', 'firma'];

export const pasoDe = (def, clave) => (def.pasos || []).find(p => p.clave === clave) || null;
export const salidasDe = (def, clave) => (def.transiciones || []).filter(t => t.desde === clave);

// Alcanzables desde `desde` siguiendo transiciones.
export function recorrer(def, desde) {
  const vistos = new Set([desde]);
  const cola = [desde];
  let guarda = 0;
  while (cola.length && guarda++ < 2000) {
    const c = cola.shift();
    for (const t of (def.transiciones || [])) {
      if (t.desde !== c || vistos.has(t.hasta)) continue;
      vistos.add(t.hasta);
      cola.push(t.hasta);
    }
  }
  return vistos;
}

/**
 * ¿Existe un camino del inicio al cierre que NO pase por ningún paso del hito?
 *
 * Es la diferencia entre "el paso de autorización EXISTE" y "hay que ATRAVESARLO".
 * Con un grafo libre se puede dejar el paso de autorización colgado al costado y
 * una transición directa que va del inicio al final: todas las demás validaciones
 * pasan, y sin embargo el pago se completa sin que nadie autorice.
 *
 * Se borran del grafo los pasos del hito y sus aristas, y se ve si desde el inicio
 * todavía se llega a un final_ok.
 */
export function caminoSinHito(def, hito) {
  const pasos = (def.pasos || []).filter(p => p.hito !== hito);
  const claves = new Set(pasos.map(p => p.clave));
  const transiciones = (def.transiciones || []).filter(t => claves.has(t.desde) && claves.has(t.hasta));
  const inicio = pasos.find(p => p.tipo === 'inicio');
  if (!inicio) return false;                       // sin inicio no hay camino
  const alcanzables = recorrer({ pasos, transiciones }, inicio.clave);
  return pasos.some(p => p.tipo === 'final_ok' && alcanzables.has(p.clave));
}

/**
 * Validaciones que solo dependen de la ESTRUCTURA del circuito.
 * @returns {{errores: string[], warnings: string[]}}
 */
export function validarEstructura(def) {
  const errores = [];
  const warnings = [];
  const pasos = def.pasos || [];
  const claves = new Set(pasos.map(p => p.clave));

  const inicios = pasos.filter(p => p.tipo === 'inicio');
  const finales = pasos.filter(p => p.tipo === 'final_ok');
  if (inicios.length !== 1) errores.push(`Tiene que haber exactamente 1 paso inicial (hay ${inicios.length})`);
  if (!finales.length) errores.push('Falta un paso final de cierre (tipo final_ok)');

  for (const t of (def.transiciones || [])) {
    if (!claves.has(t.desde) || !claves.has(t.hasta)) {
      errores.push(`La acción "${t.accion}" apunta a un paso que no existe`);
    }
    if ((t.clase === 'devuelve' || t.clase === 'rechaza') && !t.requiere_comentario) {
      errores.push(`"${t.etiqueta}" devuelve o rechaza y no exige comentario: nadie sabría por qué`);
    }
  }

  for (const p of pasos) {
    if (p.tipo === 'final_ok' || p.tipo === 'final_rechazo') continue;
    if (!salidasDe(def, p.clave).length) {
      errores.push(`El paso "${p.nombre}" no tiene ninguna salida: la solicitud quedaría trabada ahí`);
    }
  }

  if (inicios.length === 1) {
    const desdeInicio = recorrer(def, inicios[0].clave);
    for (const p of pasos) {
      if (!desdeInicio.has(p.clave)) warnings.push(`Al paso "${p.nombre}" no se llega desde el inicio`);
    }
    // Co-alcanzabilidad: desde cualquier paso se tiene que poder terminar.
    for (const p of pasos) {
      if (p.tipo === 'final_ok' || p.tipo === 'final_rechazo') continue;
      const alc = recorrer(def, p.clave);
      const cierra = [...alc].some(c => {
        const x = pasoDe(def, c);
        return x && (x.tipo === 'final_ok' || x.tipo === 'final_rechazo');
      });
      if (!cierra) errores.push(`Desde "${p.nombre}" no se puede llegar a ningún final: la solicitud quedaría trabada`);
    }
    // EL INVARIANTE CENTRAL.
    for (const hito of HITOS_OBLIGATORIOS) {
      if (caminoSinHito(def, hito)) {
        errores.push(`Hay un camino que llega al cierre SIN pasar por "${hito}". `
          + 'El circuito no puede permitir que un pago se complete salteando ese control.');
      }
    }
  }

  // Las separaciones obligatorias no se pueden quitar desde el configurador.
  const pares = new Set((def.incompatibilidades || []).map(i => i.hito_a + '|' + i.hito_b));
  for (const f of [['solicitud', 'autorizacion'], ['confeccion', 'firma']]) {
    if (!pares.has(f[0] + '|' + f[1])) {
      errores.push(`Falta la separación obligatoria entre "${f[0]}" y "${f[1]}"`);
    }
  }

  return { errores, warnings };
}
