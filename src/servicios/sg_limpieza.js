// src/servicios/sg_limpieza.js
//
// ══ BORRAR LOS DATOS DE PRUEBA, MÓDULO POR MÓDULO ══════════════════════════
//
// Pablo, 26/8/2026: *«agregame un botón por módulo en uso… vamos a borrar DATOS no
// CONFIGURACIONES»*, y *«ese botón debe vivir sólo para administradores; cuando
// lancemos hay que sacar el botón»*.
//
// ── UN SOLO MECANISMO, NO CATORCE BOTONES ──────────────────────────────────
//
// Cada módulo declara acá qué tablas son SUS datos y en qué orden se borran. El
// botón, el conteo, la confirmación y el endpoint son los mismos para todos. Catorce
// borrados escritos a mano son catorce oportunidades de olvidarse una tabla hija — y
// el síntoma de eso no es un error: es una fila que apunta a algo que ya no existe y
// que aparece tres pantallas más allá, sumando en un total.
//
// ── Y SE APAGA CON UN SOLO INTERRUPTOR ─────────────────────────────────────
//
// `limpieza_habilitada` en sg_config. Apagado, los endpoints contestan 404 y el panel
// no dibuja los botones. Sacarlo al lanzar es cambiar un valor, no ir a buscar catorce
// pantallas y confiar en que nadie se olvide de una.
//
// ── DATOS SÍ, CONFIGURACIÓN NO ─────────────────────────────────────────────
//
// Lo que se da de alta una vez y se reusa NO se toca: productos, familias, especies,
// variedades, presentaciones, envases, clientes, proveedores, fleteros, condiciones de
// pago, plan de cuentas, asientos modelo, configuración impositiva, puntos de venta,
// el ALTA de las cajas y cuentas bancarias, el ALTA de los pisos, el ALTA de las
// cooperativas, usuarios y permisos.
//
// Lo transaccional del día sí. Y se borra FÍSICAMENTE, no con `eliminado_en`: el
// objetivo es dejar la base como recién instalada, y una baja lógica deja los totales
// históricos y los numeradores donde estaban.

// El interruptor. Se lee de sg_config y por defecto está APAGADO: una función que
// borra datos no puede quedar encendida porque alguien se olvidó de apagarla.
export const CLAVE_HABILITADA = 'limpieza_habilitada';
export function limpiezaHabilitada(db) {
  try {
    const r = db.prepare('SELECT valor FROM sg_config WHERE clave=?').get(CLAVE_HABILITADA);
    return !!r && String(r.valor) === '1';
  } catch (_) { return false; }
}

// ── EL MAPA ────────────────────────────────────────────────────────────────
//
// `tablas` va EN ORDEN DE BORRADO: primero las hijas. Con foreign_keys=ON (db.js:22)
// un DELETE de una tabla padre falla si queda una hija apuntándole, así que el orden
// no es cosmético — es lo que hace que el borrado funcione.
//
// `contadores` son las secuencias que hay que resetear además de borrar filas: si se
// borran los comprobantes y el numerador queda donde estaba, el próximo sale con un
// número salteado y el libro empieza con un agujero.
export const MODULOS = [];

// Registra un módulo. Se usa desde sg_limpieza_mapa.js para que el mapa —que es largo
// y se lee de corrido— no se mezcle con la mecánica.
export function registrar(m) {
  MODULOS.push(m);
  return m;
}
export function moduloDeLimpieza(clave) {
  return MODULOS.find((m) => m.clave === String(clave)) || null;
}

// ── CUÁNTO SE VA ───────────────────────────────────────────────────────────
//
// El conteo corre SIEMPRE antes del borrado y es lo que se le muestra al que aprieta.
// Una tabla que todavía no existe cuenta 0 y no rompe: los módulos de abasto pueden
// no haberse creado si nadie abrió esa pantalla.
export function contar(db, modulo) {
  const m = typeof modulo === 'string' ? moduloDeLimpieza(modulo) : modulo;
  if (!m) return null;
  const filas = [];
  let total = 0;
  for (const t of m.tablas) {
    let n = 0;
    try {
      n = db.prepare('SELECT COUNT(*) c FROM ' + t.tabla + (t.donde ? ' WHERE ' + t.donde : '')).get().c;
    } catch (_) { n = 0; }   // la tabla todavía no existe
    if (n > 0) filas.push({ tabla: t.tabla, que_es: t.que_es, filas: n });
    total += n;
  }
  return { clave: m.clave, pantalla: m.pantalla, filas, total,
    no_se_tocan: m.no_se_tocan || [], aviso: m.aviso || null };
}

// ── Y SE BORRA ─────────────────────────────────────────────────────────────
//
// Todo en UNA transacción: o se va el módulo entero o no se va nada. A la mitad es el
// peor de los tres estados posibles.
//
// `confirmacion` tiene que ser el nombre del módulo, tipeado. No es ceremonia: es la
// diferencia entre apretar un botón sin leer y decidir.
export function limpiar(db, modulo, { confirmacion } = {}) {
  const m = typeof modulo === 'string' ? moduloDeLimpieza(modulo) : modulo;
  if (!m) return { ok: false, error: 'Ese módulo no existe.' };
  if (String(confirmacion || '').trim().toUpperCase() !== m.clave.toUpperCase()) {
    return { ok: false, error: 'Para borrar hay que escribir «' + m.clave + '».' };
  }
  const antes = contar(db, m);
  const borradas = [];
  // TRANSACCIÓN EXPLÍCITA, no db.transaction(): ese helper es de better-sqlite3 y no
  // existe en el sqlite que traen los tests, así que esto no se podía probar. BEGIN y
  // COMMIT los entienden las dos, y lo que importa se mantiene: o se va el módulo
  // entero o no se va nada. A la mitad es el peor de los tres estados posibles.
  db.exec('BEGIN');
  try {
    // ── PRIMERO SE ROMPEN LOS CICLOS ───────────────────────────────────────
    // Hay pares de tablas que se apuntan MUTUAMENTE: sg_lotes.reproceso_id apunta a
    // sg_reprocesos, y sg_reprocesos.lote_madre_id apunta a sg_lotes. Con las claves
    // foráneas encendidas NINGÚN orden de borrado funciona — se probó: borrando
    // cualquiera de las dos primero, SQLite corta con «FOREIGN KEY constraint
    // failed». El ciclo se rompe con datos, no con orden: se pone el vínculo en NULL
    // y recién ahí los DELETE pasan.
    for (const sql of (m.previo || [])) {
      try { db.prepare(sql).run(); }
      catch (e) { if (!/no such table|no such column/i.test(e.message)) throw e; }
    }
    for (const t of m.tablas) {
      try {
        const r = db.prepare('DELETE FROM ' + t.tabla + (t.donde ? ' WHERE ' + t.donde : '')).run();
        if (r.changes) borradas.push({ tabla: t.tabla, filas: r.changes });
      } catch (e) {
        // Una tabla que no existe se saltea; cualquier otra cosa tira la transacción
        // abajo, que es lo que corresponde.
        if (!/no such table/i.test(e.message)) throw e;
      }
    }
    // Los numeradores. sqlite_sequence sólo existe si hay alguna tabla AUTOINCREMENT.
    for (const c of (m.contadores || [])) {
      try { db.prepare("DELETE FROM sqlite_sequence WHERE name=?").run(c); } catch (_) { /* sin AUTOINCREMENT */ }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ya cerró */ }
    return { ok: false, error: e.message };
  }
  return { ok: true, clave: m.clave, pantalla: m.pantalla, total: antes.total, borradas };
}

// Todo junto, para el resumen de la pantalla de administración.
export function contarTodo(db) {
  return MODULOS.map((m) => contar(db, m)).filter(Boolean);
}
