// src/servicios/sp_motor.js
// ── MOTOR DEL CIRCUITO DE PAGOS ───────────────────────────────────────────
// Máquina de estados configurable, con los controles hardcodeados acá para que
// ninguna edición de la configuración los pueda desactivar.

import db from './db_sp.js';
// La validación ESTRUCTURAL vive aparte y sin acceso a base, para que el control
// más importante (que no se pueda configurar un circuito que saltee la
// autorización) se pueda testear sin levantar nada. Ver sp_grafo.js.
import { validarEstructura, pasoDe, salidasDe, HITOS_OBLIGATORIOS } from './sp_grafo.js';

export { HITOS_OBLIGATORIOS };

const err = (status, msg, extra) => Object.assign(new Error(msg), { status, extra });

// ── Snapshot de la definición ─────────────────────────────────────────────
// Se aplana el grafo a JSON y la solicitud se lo queda. El motor resuelve SIEMPRE
// contra el snapshot: editar la configuración no puede cambiar el circuito de una
// solicitud que ya está en vuelo.

export function armarSnapshot(versionId) {
  const pasos = db.prepare('SELECT * FROM sp_pasos WHERE version_id=? ORDER BY orden, id').all(versionId);
  const trans = db.prepare('SELECT * FROM sp_transiciones WHERE version_id=? ORDER BY orden, id').all(versionId);
  const incomp = db.prepare('SELECT hito_a, hito_b FROM sp_incompatibilidades WHERE version_id=?').all(versionId);
  const plant = db.prepare('SELECT clave, asunto, cuerpo FROM sp_plantillas WHERE version_id=?').all(versionId);
  const porId = new Map(pasos.map(p => [p.id, p]));

  const autPorPaso = {};
  for (const p of pasos) {
    autPorPaso[p.clave] = db.prepare('SELECT tipo, usuario_id, rol, area_id, watcher FROM sp_paso_autorizados WHERE paso_id=?').all(p.id);
  }

  return {
    version_id: versionId,
    pasos: pasos.map(p => ({
      clave: p.clave, nombre: p.nombre, orden: p.orden, tipo: p.tipo, hito: p.hito,
      modo_captura: p.modo_captura, sla_horas: p.sla_horas,
      requiere_comentario: p.requiere_comentario, requiere_adjunto_tipo: p.requiere_adjunto_tipo,
      instrucciones: p.instrucciones, permite_autoaprobacion: p.permite_autoaprobacion
    })),
    transiciones: trans.map(t => ({
      desde: porId.get(t.paso_desde_id)?.clave, hasta: porId.get(t.paso_hasta_id)?.clave,
      accion: t.accion, etiqueta: t.etiqueta, clase: t.clase,
      requiere_comentario: t.requiere_comentario, invalida_aprobaciones: t.invalida_aprobaciones
    })).filter(t => t.desde && t.hasta),
    autorizados: autPorPaso,
    incompatibilidades: incomp,
    plantillas: plant
  };
}

// ── Validación de la definición ───────────────────────────────────────────
// Corre al validar Y de nuevo al activar. La parte estructural (grafo, caminos,
// invariantes) está en sp_grafo.js y es pura; acá se suma lo que depende de
// PERSONAS, que necesita consultar la base.

export function validarDefinicion(def) {
  const estructura = validarEstructura(def);
  const errores = estructura.errores.slice();
  const warnings = estructura.warnings.slice();
  const pasos = def.pasos || [];

  // Un paso sin nadie habilitado deja la solicitud clavada sin ninguna acción
  // posible, y el grafo puede estar impecable: no lo detecta la estructura.
  for (const p of pasos) {
    if (p.tipo === 'final_ok' || p.tipo === 'final_rechazo') continue;
    const auts = (def.autorizados || {})[p.clave] || [];
    const resolutores = auts.filter(a => !a.watcher);
    if (!resolutores.length) {
      errores.push(`El paso "${p.nombre}" no tiene nadie habilitado para resolverlo`);
      continue;
    }
    if (p.tipo === 'inicio') continue;   // 'solicitante' no resuelve a nadie hasta que exista uno
    const reales = resolverAutorizados({ pasos, autorizados: def.autorizados }, p.clave, null).resolutores;
    if (!reales.length) {
      errores.push(`En "${p.nombre}" no hay ningún usuario activo con mail entre los habilitados`);
    } else if (reales.length === 1) {
      warnings.push(`En "${p.nombre}" hay una sola persona habilitada (${reales[0].nombre}): si falta, el circuito se traba`);
    }
  }

  // Deadlock por segregación de funciones: si el único habilitado para firmar es
  // también el único que confecciona, la solicitud llega a firma y no hay nadie.
  for (const inc of (def.incompatibilidades || [])) {
    const pa = pasos.filter(p => p.hito === inc.hito_a);
    const pb = pasos.filter(p => p.hito === inc.hito_b);
    if (!pa.length || !pb.length) continue;
    const setA = new Set(pa.flatMap(p => resolverAutorizados(def, p.clave, null).resolutores.map(u => u.id)));
    const setB = new Set(pb.flatMap(p => resolverAutorizados(def, p.clave, null).resolutores.map(u => u.id)));
    if (setA.size && setB.size) {
      const union = new Set([...setA, ...setB]);
      if (setB.size === 1 && [...setB].every(x => setA.has(x))) {
        errores.push(`La única persona habilitada para "${inc.hito_b}" también lo está para "${inc.hito_a}", `
          + 'y no pueden ser la misma: toda solicitud se trabaría ahí. Designá a alguien más.');
      } else if (union.size < 3) {
        warnings.push(`Muy poca gente habilitada entre "${inc.hito_a}" y "${inc.hito_b}": el circuito puede trabarse.`);
      }
    }
  }

  return { ok: errores.length === 0, errores, warnings };
}

// ── Resolución de autorizados ─────────────────────────────────────────────
// En vivo, en cada avance. Solo usuarios activos; para avisar por mail hace falta
// que además tengan mail cargado.

export function resolverAutorizados(def, pasoClave, solicitud) {
  const auts = (def.autorizados || {})[pasoClave] || [];
  const resolutores = new Map();
  const watchers = new Map();

  for (const a of auts) {
    let filas = [];
    try {
      if (a.tipo === 'usuario' && a.usuario_id) {
        filas = db.prepare('SELECT id, nombre, email, rol FROM usuarios WHERE id=? AND activo=1').all(a.usuario_id);
      } else if (a.tipo === 'rol' && a.rol) {
        filas = db.prepare('SELECT id, nombre, email, rol FROM usuarios WHERE rol=? AND activo=1').all(a.rol);
      } else if (a.tipo === 'area' && a.area_id) {
        filas = db.prepare(`
          SELECT u.id, u.nombre, u.email, u.rol FROM usuarios u
          JOIN personas p ON p.id = u.persona_id
          JOIN personas_areas pa ON pa.persona_id = p.id
          WHERE pa.area_id = ? AND u.activo = 1
        `).all(a.area_id);
      } else if (a.tipo === 'solicitante' && solicitud) {
        filas = db.prepare('SELECT id, nombre, email, rol FROM usuarios WHERE id=? AND activo=1').all(solicitud.solicitante_id);
      }
    } catch (e) {
      console.error('[SP] Error resolviendo autorizados:', e.message);
    }
    for (const f of filas) (a.watcher ? watchers : resolutores).set(f.id, f);
  }

  // El borrador es de quien lo escribió. Sea cual sea la configuración —y la
  // sembrada habilita rol=admin en TODOS los pasos— el paso inicial lo resuelve
  // solo su autor: ver el borrador ajeno en la bandeja propia, y peor, poder
  // enviarlo a autorizar, no es una opción de configuración, es un error.
  //
  // Va en código y no en la config a propósito: la definición se congela por
  // solicitud, así que arreglarlo solo en la config dejaría a las solicitudes ya
  // creadas con el comportamiento viejo para siempre.
  const paso = (def.pasos || []).find(p => p.clave === pasoClave);
  if (paso && paso.tipo === 'inicio' && solicitud) {
    const autor = resolutores.get(solicitud.solicitante_id)
      || db.prepare('SELECT id, nombre, email, rol FROM usuarios WHERE id=? AND activo=1')
           .get(solicitud.solicitante_id);
    // Los watchers se conservan: alguien puede querer enterarse de que se creó
    // una solicitud sin por eso poder empujarla.
    return { resolutores: autor ? [autor] : [], watchers: [...watchers.values()] };
  }

  return { resolutores: [...resolutores.values()], watchers: [...watchers.values()] };
}

// ── Segregación de funciones ──────────────────────────────────────────────
// Quien ya resolvió un hito incompatible en ESTA solicitud no puede resolver el otro.

// Evalúa la separación de funciones SIN mirar el rol. Se usa para dos cosas: para
// bloquear al que corresponde, y para poder decir qué habría bloqueado cuando un
// administrador pasa por encima.
function evaluarSoD(def, solicitud, pasoClave, usuarioId) {
  const paso = pasoDe(def, pasoClave);
  if (!paso || !paso.hito) return null;
  if (paso.permite_autoaprobacion) return null;

  const incs = (def.incompatibilidades || []).filter(i => i.hito_a === paso.hito || i.hito_b === paso.hito);
  if (!incs.length) return null;
  const otros = incs.map(i => (i.hito_a === paso.hito ? i.hito_b : i.hito_a));

  // El solicitante "resolvió" el hito solicitud por haber creado la solicitud.
  if (otros.includes('solicitud') && solicitud.solicitante_id === usuarioId) {
    return 'No podés resolver este paso sobre tu propia solicitud.';
  }
  const filas = db.prepare(`
    SELECT DISTINCT hito FROM sp_eventos
    WHERE solicitud_id=? AND actor_id=? AND hito IS NOT NULL
  `).all(solicitud.id, usuarioId).map(f => f.hito);
  const choque = otros.find(h => filas.includes(h));
  if (choque) {
    return `Ya interviniste en esta solicitud resolviendo "${choque}", y no puede ser la misma persona.`;
  }
  return null;
}

// El rol se lee de la BASE, no del que llama: la cookie la puede editar el usuario.
function esAdminId(usuarioId) {
  try {
    const u = db.prepare('SELECT rol FROM usuarios WHERE id=? AND activo=1').get(usuarioId);
    return !!u && u.rol === 'admin';
  } catch (e) { return false; }
}

/**
 * Bloqueo efectivo. Los ADMINISTRADORES pasan por encima de la separación de
 * funciones: decisión explícita del dueño del sistema, porque en una estructura
 * chica el admin suele ser el único que puede destrabar.
 *
 * No queda invisible: sodOmitida() devuelve qué habría bloqueado, y el motor lo
 * registra en el evento. Así una autorización sobre la propia solicitud se puede
 * distinguir de una normal cuando alguien audite, en vez de quedar indistinguible.
 */
export function bloqueadoPorSoD(def, solicitud, pasoClave, usuarioId) {
  if (esAdminId(usuarioId)) return null;
  return evaluarSoD(def, solicitud, pasoClave, usuarioId);
}

// Qué separación se está salteando. Devuelve null si no hay ninguna.
export function sodOmitida(def, solicitud, pasoClave, usuarioId) {
  if (!esAdminId(usuarioId)) return null;
  return evaluarSoD(def, solicitud, pasoClave, usuarioId);
}

// ── Acciones disponibles para un usuario ──────────────────────────────────

export function accionesDisponibles(def, solicitud, usuario, ctx = {}) {
  if (solicitud.estado_global !== 'en_curso') return [];
  const paso = pasoDe(def, solicitud.paso_actual_clave);
  if (!paso) return [];
  const { resolutores } = resolverAutorizados(def, paso.clave, solicitud);
  const esAdmin = usuario.rol === 'admin';
  // EL PASO INICIAL ES LA EXCEPCIÓN A "LOS ADMINISTRADORES PUEDEN SIEMPRE".
  // Un borrador todavía no entró al circuito: es el trabajo sin terminar de quien
  // lo escribió, no un pago esperando una decisión. La regla de admin existe para
  // que un pago no quede trabado esperando a alguien que no está; un borrador no
  // está trabado, está sin terminar, y empujarlo sería mandar a autorizar algo que
  // su autor todavía no dio por listo.
  const habilitado = (esAdmin && paso.tipo !== 'inicio') || resolutores.some(u => u.id === usuario.id);
  if (!habilitado) return [];
  const sod = bloqueadoPorSoD(def, solicitud, paso.clave, usuario.id);
  if (sod) return [];
  const out = [];
  for (const t of salidasDe(def, paso.clave)) {
    // Devolver siempre exige motivo: es lo único que le dice al que la recibe qué
    // corregir, y sin eso la devolución es un rebote sin explicación.
    const pideMotivo = t.clase === 'devuelve'
      || !!t.requiere_comentario || !!paso.requiere_comentario;

    if (t.clase !== 'devuelve') {
      out.push({
        accion: t.accion, etiqueta: t.etiqueta, clase: t.clase,
        destino: destinoDevolucion(def, t), requiere_comentario: pideMotivo,
      });
      continue;
    }

    // Una devolución se abre en tantos botones como destinos válidos haya. La
    // etiqueta dice a dónde va DE VERDAD y a quién le llega: en el grafo sembrado
    // decía "Devolver a fechas" o "Devolver a confección", y con ese texto el
    // botón prometía una cosa y el sistema hacía otra.
    const destinos = destinosDevolucion(def, solicitud, ctx);
    if (!destinos.length) {
      out.push({
        accion: t.accion, etiqueta: 'Devolver al solicitante', clase: t.clase,
        destino: destinoDevolucion(def, t), requiere_comentario: pideMotivo,
      });
      continue;
    }
    for (const d of destinos) {
      out.push({
        accion: t.accion,
        etiqueta: d.quien ? `${d.etiqueta} (${d.quien})` : d.etiqueta,
        clase: t.clase,
        destino: d.clave,
        destino_motivo: d.motivo,
        requiere_comentario: pideMotivo,
      });
    }
  }
  return out;
}

/** EL PASO DE INICIO del circuito: donde vive el que pidió el pago. */
export function pasoInicio(def) {
  return (def.pasos || []).find(p => p.tipo === 'inicio') || null;
}

/**
 * A dónde va REALMENTE una devolución: SIEMPRE al paso de inicio, o sea al que
 * solicitó el pago.
 *
 * Va acá y no en la configuración del circuito a propósito. La arquitectura del
 * módulo separa tres capas y esta es de la tercera:
 *   GRAFO     — pasos y transiciones: los edita el usuario.
 *   SEMÁNTICA — enums cerrados.
 *   EFECTOS   — reglas del negocio, en código, que ninguna edición desactiva.
 * "Devolver es devolver al que pidió" es una regla del negocio, no un dibujo del grafo.
 *
 * Y hay una razón práctica: cada solicitud lleva CONGELADO su propio snapshot del
 * circuito. Si esto se hubiera hecho editando las transiciones, las solicitudes ya
 * en curso habrían seguido con el comportamiento viejo hasta terminarse.
 * Resolviéndolo acá, aplica desde el minuto cero a todas.
 *
 * POR QUÉ SIEMPRE AL SOLICITANTE: alguien puede aprobar y recién dos pasos después
 * descubrirse el error. Devolver al paso anterior deja el problema en manos de
 * quien no lo puede arreglar —el error casi siempre es del pedido: proveedor,
 * cuenta, monto o comprobante— y obliga a una cadena de devoluciones. Volviendo al
 * origen, el que puede corregirlo lo corrige y el circuito se rehace entero.
 */
export function destinoDevolucion(def, transicion) {
  if (!transicion || transicion.clase !== 'devuelve') return transicion ? transicion.hasta : null;
  const ini = pasoInicio(def);
  return ini ? ini.clave : transicion.hasta;   // sin paso de inicio, se respeta el grafo
}

export function pasoPorHito(def, hito) {
  return (def.pasos || []).find(p => p.hito === hito) || null;
}

// ── A DÓNDE PUEDE VOLVER UNA DEVOLUCIÓN ───────────────────────────────────
// Un error tiene autor, y no siempre es el mismo. Si el pedido está mal —proveedor
// equivocado, monto que no cierra— lo tiene que corregir quien lo pidió. Pero si la
// orden se confeccionó mal, mandarla al solicitante es hacerle rebotar algo que él
// no escribió: el que tiene que rehacerla es el que la armó.
//
// Por eso la devolución no tiene UN destino: tiene los que correspondan, y el que
// devuelve elige según de quién sea el error.
//
// Sólo se ofrecen pasos por los que la solicitud YA PASÓ. Devolver a un paso que
// todavía no ocurrió sería empujarla hacia adelante con un botón que dice devolver,
// y además no habría a quién avisarle.
export function destinosDevolucion(def, solicitud, ctx = {}) {
  const actual = solicitud.paso_actual_clave;
  const destinos = [];

  const ini = pasoInicio(def);
  if (ini && ini.clave !== actual) {
    destinos.push({
      clave: ini.clave,
      etiqueta: 'Devolver al solicitante',
      quien: solicitud.solicitante_nombre || null,
      motivo: 'solicitante',
    });
  }

  // ── DEVOLVER LA FECHA A QUIEN LA PUSO ───────────────────────────────────
  // El que confecciona la orden es el que descubre que la fecha no cierra —cayó
  // domingo, el proveedor pidió otra, el cheque no llega a esa fecha—. Hasta acá
  // tenía dos salidas y las dos malas: devolverla al SOLICITANTE, que no puso esa
  // fecha y no la puede cambiar, y que además rehace el circuito entero desde el
  // principio; o RECHAZAR la orden, que la mata. Se rechazaba.
  //
  // Volviendo al paso de fechas, la autorización sigue en pie —nadie discutió el
  // pago, sólo el día— y el que puso la fecha la corrige y sigue.
  const fec = pasoPorHito(def, 'fechas');
  if (fec && fec.clave !== actual && ctx.fechaPuestaPor) {
    destinos.push({
      clave: fec.clave,
      etiqueta: 'Devolver para corregir la fecha',
      quien: ctx.fechaPuestaPor.nombre || null,
      motivo: 'fechas',
    });
  }

  // El paso de confección, sólo si alguien ya confeccionó. Antes de eso no hay a
  // quién devolverle: el paso existe en el circuito pero todavía no lo tocó nadie.
  const conf = pasoPorHito(def, 'confeccion');
  if (conf && conf.clave !== actual && ctx.confeccionadoPor) {
    destinos.push({
      clave: conf.clave,
      etiqueta: 'Devolver a quien confeccionó',
      quien: ctx.confeccionadoPor.nombre || null,
      motivo: 'confeccion',
    });
  }

  return destinos;
}

// ── ÚNICO escritor del paso actual ────────────────────────────────────────
// Todas las acciones (avance normal, cancelación, reapertura administrativa) pasan
// por acá. Si cada una escribiera el paso por su cuenta, paso_actual_hito quedaría
// desincronizado de paso_actual_clave — y el hito es la etiqueta con la que filtra
// el resto del sistema.
export function aplicarCambioDePaso(def, solicitud, destinoClave, opts) {
  const o = opts || {};
  const destino = pasoDe(def, destinoClave);
  if (!destino) throw err(500, `El circuito de esta solicitud no tiene el paso "${destinoClave}"`);

  let estado = o.estadoNuevo;
  if (!estado) {
    estado = destino.tipo === 'final_ok' ? 'aprobada_final'
      : (destino.tipo === 'final_rechazo' ? 'rechazada' : 'en_curso');
  }
  const vence = destino.sla_horas
    ? `datetime('now','localtime','+${parseInt(destino.sla_horas, 10)} hours')`
    : 'NULL';
  const cerrado = (estado === 'en_curso') ? 'NULL' : "datetime('now','localtime')";

  // UPDATE condicional por rev: es la barrera contra el doble click y contra dos
  // personas resolviendo el mismo paso a la vez.
  const r = db.prepare(`
    UPDATE sp_solicitudes SET
      paso_actual_clave = ?, paso_actual_hito = ?,
      paso_actual_desde = datetime('now','localtime'),
      vence_en = ${vence}, estado_global = ?, cerrado_en = ${cerrado},
      ciclo = ciclo + ?, rev = rev + 1
    WHERE id = ? AND rev = ?
  `).run(destino.clave, destino.hito || null, estado, o.sumaCiclo ? 1 : 0, solicitud.id, solicitud.rev);

  if (r.changes === 0) {
    throw err(409, 'Alguien más movió esta solicitud mientras la mirabas. Recargá y volvé a intentar.');
  }
  return { destino, estado };
}

export function registrarEvento(solicitudId, datos) {
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM sp_eventos WHERE solicitud_id=?').get(solicitudId).m) + 1;
  const r = db.prepare(`
    INSERT INTO sp_eventos (solicitud_id, seq, paso_desde, paso_hasta, accion, hito, clase,
                            actor_id, actor_nombre, actor_rol, comentario, datos_json, via)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(solicitudId, seq, datos.paso_desde || null, datos.paso_hasta || null, datos.accion,
         datos.hito || null, datos.clase || null, datos.actor_id || null,
         datos.actor_nombre || null, datos.actor_rol || null, datos.comentario || null,
         datos.datos_json ? JSON.stringify(datos.datos_json) : null, datos.via || 'panel');
  return r.lastInsertRowid;
}

export const _internos = { pasoDe, salidasDe };
