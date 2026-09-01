// src/servicios/mail_persona.js
// ── EL MAIL DE UNA PERSONA ES UNO SOLO ────────────────────────────────────
//
// Pablo, 1/9/2026: «actualicé un mail en usuarios pero no se me actualiza acá para
// enviarle las notificaciones; los mails que tenés son distintos».
//
// El dato vivía en DOS tablas:
//
//   personas.mail    — la ficha del organigrama, que es donde se edita
//   usuarios.email   — a dónde salen los avisos (órdenes de pago, y todo lo demás)
//
// Y se copiaba UNA sola vez, al crear el usuario desde la persona. Después nunca
// más. El que corregía el mail en la ficha lo daba por hecho, y los avisos seguían
// yendo al viejo —o al `campo_nombre@interno.lnb` que el sistema le había inventado
// cuando la persona todavía no tenía mail cargado—. Nadie se entera de que un mail
// no llegó: simplemente no llega.
//
// No se juntan las dos tablas: `usuarios` es la credencial y `personas` la ficha, y
// hay usuarios sin persona. Lo que se hace es que NO PUEDAN DECIR COSAS DISTINTAS:
// se edite donde se edite, el otro lado queda igual.
//
// SE PUEDE CAMBIAR SIN MIEDO A DEJAR A ALGUIEN AFUERA: el login entra por username,
// por mail o por nombre (rutas/auth.js), así que cambiar el mail no le cierra la
// puerta a nadie — sigue entrando por su usuario.

// Vacío no es un mail. Y el interno que se autogenera tampoco: es un relleno para
// cumplir con el NOT NULL de la columna, no una dirección a la que llegue algo.
export function esMailReal(m) {
  const v = String(m || '').trim().toLowerCase();
  return !!v && v.includes('@') && !v.endsWith('@interno.lnb');
}

export function normalizarMail(m) {
  return String(m || '').trim().toLowerCase();
}

/**
 * Copia el mail de la persona al usuario vinculado. Devuelve qué pasó, para que
 * quien llama lo pueda contar.
 *
 * NO TIRA NUNCA. Es un efecto de costado de guardar la ficha: si el mail choca
 * con el de otro usuario —la columna es UNIQUE—, la ficha se guarda igual y el
 * problema se informa. Voltear el guardado por el sincronismo sería peor que la
 * desincronización.
 */
export function sincronizarMailAUsuario(db, personaId, mail) {
  if (!esMailReal(mail)) return { estado: 'sin_mail' };
  const nuevo = normalizarMail(mail);
  const u = db.prepare('SELECT id, email FROM usuarios WHERE persona_id = ? AND activo = 1').get(personaId);
  if (!u) return { estado: 'sin_usuario' };
  if (normalizarMail(u.email) === nuevo) return { estado: 'ya_estaba' };
  const otro = db.prepare('SELECT id FROM usuarios WHERE LOWER(email) = ? AND id <> ?').get(nuevo, u.id);
  if (otro) return { estado: 'ocupado', email: nuevo };
  db.prepare('UPDATE usuarios SET email = ? WHERE id = ?').run(nuevo, u.id);
  return { estado: 'actualizado', email: nuevo, usuario_id: u.id };
}

/**
 * Y al revés: el mail que se corrige en la pantalla de Usuarios vuelve a la ficha.
 * Sin esto se arregla de un lado y al rato alguien lo "arregla" del otro, y vuelven
 * a decir cosas distintas.
 */
export function sincronizarMailAPersona(db, usuarioId, mail) {
  if (!esMailReal(mail)) return { estado: 'sin_mail' };
  const u = db.prepare('SELECT persona_id FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u || !u.persona_id) return { estado: 'sin_persona' };
  const p = db.prepare('SELECT mail FROM personas WHERE id = ?').get(u.persona_id);
  if (!p) return { estado: 'sin_persona' };
  const nuevo = normalizarMail(mail);
  if (normalizarMail(p.mail) === nuevo) return { estado: 'ya_estaba' };
  db.prepare('UPDATE personas SET mail = ? WHERE id = ?').run(nuevo, u.persona_id);
  return { estado: 'actualizado', email: nuevo, persona_id: u.persona_id };
}

// ── LO QUE YA QUEDÓ DESFASADO ─────────────────────────────────────────────
//
// Sincronizar de acá en adelante no arregla lo de atrás: los avisos siguen
// saliendo al mail viejo hasta que alguien vuelva a abrir cada ficha y la guarde
// de nuevo. Y nadie va a hacer eso por dieciocho personas.
//
// Se arrastra al arrancar, y SÓLO el caso que no admite discusión: el usuario cuyo
// mail es el `campo_nombre@interno.lnb` que el sistema se inventó porque la persona
// todavía no tenía mail cargado. Eso no es una dirección — no le llega nada — así
// que pisarlo con el mail real de la ficha no puede romper nada.
//
// LO QUE NO SE TOCA: si el usuario tiene un mail REAL distinto al de la ficha, hay
// dos direcciones válidas y elegir una es adivinar. Esas quedan anotadas en
// `mailesQueNoCoinciden` para poder mirarlas, igual que las fallas de migración: un
// arreglo automático que a veces adivina mal es peor que una lista de pendientes.
export const mailesQueNoCoinciden = [];

export function arrastrarMailesDePersonas(db) {
  const out = { arrastrados: 0, encontrados: 0 };
  try {
    const filas = db.prepare(`
      SELECT u.id AS usuario_id, u.email, u.nombre, p.id AS persona_id, p.mail
      FROM usuarios u JOIN personas p ON p.id = u.persona_id
      WHERE u.activo = 1 AND p.mail IS NOT NULL AND TRIM(p.mail) <> ''
    `).all();
    for (const f of filas) {
      if (!esMailReal(f.mail)) continue;
      if (normalizarMail(f.email) === normalizarMail(f.mail)) continue;
      out.encontrados++;
      // El interno autogenerado no es una dirección: se pisa sin preguntar.
      if (!esMailReal(f.email)) {
        const r = sincronizarMailAUsuario(db, f.persona_id, f.mail);
        if (r.estado === 'actualizado') { out.arrastrados++; continue; }
        mailesQueNoCoinciden.push({ usuario: f.nombre, usuario_id: f.usuario_id,
          en_usuarios: f.email, en_la_ficha: f.mail, motivo: r.estado });
        continue;
      }
      // Dos mails reales distintos: elegir uno es adivinar. Queda anotado.
      mailesQueNoCoinciden.push({ usuario: f.nombre, usuario_id: f.usuario_id,
        en_usuarios: f.email, en_la_ficha: f.mail, motivo: 'los_dos_son_reales' });
    }
    if (out.arrastrados) {
      console.log('[ORG] Mailes arrastrados de la ficha al usuario: ' + out.arrastrados);
    }
    if (mailesQueNoCoinciden.length) {
      console.warn('[ORG] Personas con dos mailes distintos, sin tocar: ' + mailesQueNoCoinciden.length);
    }
  } catch (e) {
    console.error('[ORG] arrastrarMailesDePersonas:', e.message);
  }
  return out;
}
