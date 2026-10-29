// src/servicios/galpon.js
// ── LA LÓGICA DEL GALPÓN ─────────────────────────────────────────────────────────────
// Dos preguntas que el volcado hace por cada IFCO, y que tienen que contestarse igual en
// la pantalla, en el servidor y en un informe de la semana que viene:
//
//   ¿De qué cuadrilla es esta tarjeta?   → cuadrillaDeTarjeta()
//   ¿Qué lote se estaba cosechando?      → loteVigente()
//
// La db entra por parámetro: así los tests corren con node:sqlite, sin better-sqlite3.
//
// ── NADA DE ESTO RECHAZA ─────────────────────────────────────────────────────────────
// Cuando el IFCO llega a la balanza la fruta YA ESTÁ COSECHADA, y cuando se vuelca ya está
// en la tolva. Una tarjeta fuera de rango o un lote sin cargar no pueden frenar la carga:
// lo que hacen es devolver el problema descrito, para que el volcado se guarde marcado
// `a_revisar` y alguien lo resuelva después.
//
// Por eso estas funciones devuelven SIEMPRE un objeto con lo que pudieron resolver más el
// motivo de lo que no, y nunca tiran.

// ── COLORES DE CUADRILLA ─────────────────────────────────────────────────────────────
// Una paleta corta y separada entre sí: el cuadrillero agarra la tarjeta por el color a
// tres metros, y dos azules parecidos son el mismo azul. Siete, porque más de siete
// cuadrillas simultáneas en un galpón de este tamaño no pasa — y si pasa, se repite un
// color y el rango de IDs sigue desambiguando.
export const COLORES = [
  { hex: '#d62828', nombre: 'Rojo' },
  { hex: '#f77f00', nombre: 'Naranja' },
  { hex: '#fcbf49', nombre: 'Amarillo' },
  { hex: '#2a9d8f', nombre: 'Verde' },
  { hex: '#1a3a5c', nombre: 'Azul' },
  { hex: '#7209b7', nombre: 'Violeta' },
  { hex: '#6c757d', nombre: 'Gris' },
];

export const MOTIVOS_DEFECTO = [
  'golpeado', 'sobremaduro', 'muy verde', 'podrido', 'tierra/sucio', 'IFCO incompleto',
];

// ── LA CONFIGURACIÓN ─────────────────────────────────────────────────────────────────
export function config(db) {
  const filas = db.prepare('SELECT clave, valor FROM gal_config').all();
  const c = {};
  for (const f of filas) c[f.clave] = f.valor;
  return {
    // Numéricos ya convertidos: si cada pantalla hiciera su propio parseFloat, una se
    // olvidaría y la tara entraría como texto a una resta.
    tara_ifco: Number(c.tara_ifco) || 0,
    objetivo_kg_hora: Number(c.objetivo_kg_hora) || 0,
    motivos_calidad: (c.motivos_calidad || '').split(',').map((s) => s.trim()).filter(Boolean),
    balanza_puerto: c.balanza_puerto || '',
    balanza_baudios: Number(c.balanza_baudios) || 9600,
  };
}

export function guardarConfig(db, clave, valor) {
  db.prepare(`INSERT INTO gal_config (clave, valor, actualizado)
              VALUES (?,?,datetime('now','localtime'))
              ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor,
                                               actualizado = excluded.actualizado`)
    .run(String(clave), valor == null ? '' : String(valor));
}

// ── QUÉ COLOR LE TOCA A UNA CUADRILLA ────────────────────────────────────────────────
// Nadie lo elige salvo que quiera. Si la cuadrilla ya tiene uno, se le repite: el color
// identifica al equipo, y dos tandas del mismo equipo con colores distintos es justo lo
// que el color venía a evitar.
//
// Si no tiene, se le da el primero de la paleta que no esté usando otra. Elegirlo a mano
// termina en dos cuadrillas del mismo color, que es el único error que el color no puede
// corregir — y el cuadrillero agarra la tarjeta mirando el color, no leyendo.
//
// Si se acabaron los colores se repite el que toque por orden. Dos cuadrillas del mismo
// color son peores que una, pero mejor que no poder darle de alta la tanda a la octava.
export function colorSugerido(db, cuadrillaId) {
  const mio = db.prepare(
    'SELECT color FROM gal_cuadrilla_tarjetas WHERE cuadrilla_id = ? AND activo = 1 '
    + 'ORDER BY id LIMIT 1').get(cuadrillaId);
  if (mio && mio.color) return mio.color;
  const usados = new Set(db.prepare(
    'SELECT DISTINCT color FROM gal_cuadrilla_tarjetas WHERE activo = 1')
    .all().map((r) => String(r.color || '').toLowerCase()));
  const libre = COLORES.find((c) => !usados.has(c.hex.toLowerCase()));
  if (libre) return libre.hex;
  return COLORES[Math.abs(parseInt(cuadrillaId, 10) || 0) % COLORES.length].hex;
}

// ── LAS CUADRILLAS Y SUS TARJETAS ────────────────────────────────────────────────────
// Lee pa_cuadrillas (de Personal) y le pega los rangos de este módulo. LEFT JOIN: una
// cuadrilla sin rango asignado tiene que aparecer igual en la pantalla de configuración —
// es justamente la que hay que configurar.
export function cuadrillas(db, opts) {
  const o = opts || {};
  const cond = o.incluir_inactivas ? '1=1' : 'c.activo = 1';
  const filas = db.prepare(
    ' SELECT c.id, c.nombre, c.tipo, c.activo'
    + '   FROM pa_cuadrillas c'
    + '  WHERE ' + cond
    + '  ORDER BY c.nombre COLLATE NOCASE').all();
  const rangos = db.prepare(
    'SELECT * FROM gal_cuadrilla_tarjetas WHERE activo = 1 ORDER BY desde_id').all();
  return filas.map((c) => {
    const mios = rangos.filter((r) => r.cuadrilla_id === c.id);
    return Object.assign({}, c, {
      rangos: mios,
      color: mios.length ? mios[0].color : null,
      // Cuántas tarjetas tiene en total. Es el número que dice si alcanzan: si una
      // cuadrilla llena 300 IFCOs por día y tiene 80 tarjetas, van a faltar.
      tarjetas: mios.reduce((a, r) => a + (r.hasta_id - r.desde_id + 1), 0),
    });
  });
}

// ── ¿DE QUIÉN ES ESTA TARJETA? ───────────────────────────────────────────────────────
// El ID de la tarjeta cae dentro del rango de una cuadrilla. Devuelve siempre un objeto:
// si no cae en ninguno, `cuadrilla_id` viene null y `motivo` dice por qué — el volcado se
// guarda igual, marcado para revisar.
export function cuadrillaDeTarjeta(db, tarjetaId) {
  const id = parseInt(tarjetaId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return { tarjeta_id: null, cuadrilla_id: null, ok: false,
             motivo: 'El número de tarjeta no se entiende: "' + tarjetaId + '"' };
  }
  const r = db.prepare(
    ' SELECT t.*, c.nombre AS cuadrilla_nombre'
    + '   FROM gal_cuadrilla_tarjetas t'
    + '   LEFT JOIN pa_cuadrillas c ON c.id = t.cuadrilla_id'
    + '  WHERE t.activo = 1 AND ? BETWEEN t.desde_id AND t.hasta_id'
    + '  ORDER BY t.id LIMIT 1').get(id);
  if (!r) {
    return { tarjeta_id: id, cuadrilla_id: null, ok: false,
             motivo: 'La tarjeta ' + id + ' no está en el rango de ninguna cuadrilla' };
  }
  return {
    tarjeta_id: id,
    cuadrilla_id: r.cuadrilla_id,
    cuadrilla_nombre: r.cuadrilla_nombre || null,
    color: r.color,
    ok: true,
    motivo: null,
  };
}

// Dos cuadrillas con rangos que se pisan. Se chequea al GUARDAR el rango, no al leerlo:
// si dos rangos se superponen, la tarjeta del medio se le atribuye a una de las dos para
// siempre y los kilos de la otra desaparecen sin que nadie lo note.
export function rangoSuperpuesto(db, desde, hasta, excluirId) {
  const d = parseInt(desde, 10), h = parseInt(hasta, 10);
  if (!Number.isFinite(d) || !Number.isFinite(h)) return null;
  const par = [h, d];
  let extra = '';
  if (excluirId) { extra = ' AND t.id <> ?'; par.push(excluirId); }
  return db.prepare(
    ' SELECT t.*, c.nombre AS cuadrilla_nombre'
    + '   FROM gal_cuadrilla_tarjetas t'
    + '   LEFT JOIN pa_cuadrillas c ON c.id = t.cuadrilla_id'
    + '  WHERE t.activo = 1 AND t.desde_id <= ? AND t.hasta_id >= ?' + extra
    + '  LIMIT 1').get(...par) || null;
}

// ── ¿QUÉ LOTE SE ESTABA COSECHANDO? ──────────────────────────────────────────────────
// El lote vigente a una hora: la última fila de ese día cuya hora de inicio ya pasó.
// Mismo idioma que una tarifa con vigencia (pa_tarifas_persona.vigente_desde).
//
// Si el día tiene una sola fila, es "el lote del día" y la hora no importa. Si hubo un
// cambio a media mañana, el IFCO que se vuelca a las 14:30 toma el de las 14:30.
export function loteVigente(db, fecha, hora) {
  const f = String(fecha || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) {
    return { lote_id: null, ok: false, motivo: 'Fecha inválida: "' + fecha + '"' };
  }
  const h = /^\d{2}:\d{2}/.test(String(hora || '')) ? String(hora).slice(0, 5) : '23:59';
  const r = db.prepare(
    ' SELECT * FROM gal_lote_vigente'
    + '  WHERE fecha = ? AND desde_hora <= ?'
    + '  ORDER BY desde_hora DESC, id DESC LIMIT 1').get(f, h);
  if (!r) {
    // Puede ser que no se cargó, o que se cargó para más tarde (el primer IFCO entró
    // antes de la hora de inicio). Son dos problemas distintos y se dicen distinto.
    const hayDespues = db.prepare(
      'SELECT desde_hora FROM gal_lote_vigente WHERE fecha = ? ORDER BY desde_hora LIMIT 1').get(f);
    return {
      lote_id: null, ok: false,
      motivo: hayDespues
        ? 'El lote del día arranca a las ' + hayDespues.desde_hora + ' y esto entró ' + h
        : 'No se cargó el lote del día ' + f,
    };
  }
  return {
    lote_id: r.lote_id,
    lote_nombre: r.lote_nombre || null,
    producto: r.producto || null,
    desde_hora: r.desde_hora,
    ok: true,
    motivo: null,
  };
}

// Todos los tramos del día, para mostrarlos en la pantalla de configuración del día.
export function lotesDelDia(db, fecha) {
  return db.prepare(
    'SELECT * FROM gal_lote_vigente WHERE fecha = ? ORDER BY desde_hora, id')
    .all(String(fecha || '').slice(0, 10));
}

// ── EL NETO ──────────────────────────────────────────────────────────────────────────
// Bruto menos la tara del IFCO. Está acá y no en la pantalla porque el servidor tiene que
// poder recalcularlo: si lo hiciera sólo el navegador, un neto mal calculado entraría a la
// base sin que nada lo revise.
//
// Devuelve el problema en vez de tirar — el IFCO ya se volcó.
export function neto(bruto, tara) {
  const b = Number(bruto);
  const t = Number(tara) || 0;
  if (!Number.isFinite(b) || b <= 0) {
    return { neto: null, ok: false, motivo: 'El peso bruto no es un número válido' };
  }
  const n = Math.round((b - t) * 100) / 100;
  if (n <= 0) {
    // Pasa de verdad: se pesa el IFCO vacío por error, o la tara quedó mal configurada.
    return { neto: n, ok: false,
             motivo: 'El neto da ' + n + ' kg (bruto ' + b + ' − tara ' + t + '): revisar' };
  }
  return { neto: n, ok: true, motivo: null };
}

// ── EL LOTE DEL DÍA, DEL LADO DE LA ESCRITURA ────────────────────────────────────────
// Arriba está la lectura (`loteVigente`, `lotesDelDia`), que es lo que el volcado
// pregunta. Lo que sigue es lo que hace falta para CARGARLO y para no cargarlo mal.

// ── LA HORA SE GUARDA EN HH:MM CON EL CERO ADELANTE, Y NO ES UN DETALLE ──────────────
// `loteVigente` compara `desde_hora <= ?`, y en SQLite eso es una comparación de TEXTO.
// Con '9:00' guardado sin el cero, '9:00' > '14:30' —porque '9' > '1'— y el lote de la
// mañana se vuelve el vigente de toda la tarde. No se ve en pantalla: el tramo aparece
// listado igualito, y los kilos se van al lote equivocado en silencio.
//
// Por eso la normalización vive acá y no en la pantalla: el que escribe es el servidor.
export function hhmm(v) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

export function esFecha(v) {
  const f = String(v == null ? '' : v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : null;
}

// Dos tramos a la MISMA hora del MISMO día. `loteVigente` ordena por hora y después por
// id, así que el segundo le gana al primero sin decir nada: el lote de la mañana queda
// cargado, visible en la lista, y sin atribuir un solo kilo.
//
// Es el mismo caso que dos rangos de tarjetas que se pisan, y se corta igual: antes de
// escribir, que es el único momento en que todavía se puede.
export function tramoChoca(db, fecha, desdeHora, excluirId) {
  const f = esFecha(fecha), h = hhmm(desdeHora);
  if (!f || !h) return null;
  const par = [f, h];
  let extra = '';
  if (excluirId) { extra = ' AND id <> ?'; par.push(excluirId); }
  return db.prepare('SELECT * FROM gal_lote_vigente WHERE fecha = ? AND desde_hora = ?'
                    + extra + ' LIMIT 1').get(...par) || null;
}

// ── EL HUECO DE LA MAÑANA ────────────────────────────────────────────────────────────
// Si el primer tramo del día arranca a las 08:00, el IFCO que se vuelca a las 06:40 NO
// TIENE LOTE: `loteVigente` lo dice, y el volcado se guarda `a_revisar`.
//
// Pasa de verdad y por una razón boba: el que carga la pantalla a la mañana pone la hora
// a la que la está cargando, no la hora desde la que vale. Por eso la pantalla avisa en
// vez de esperar a que aparezcan los volcados sin lote.
export function huecoDelDia(db, fecha) {
  const f = esFecha(fecha);
  if (!f) return null;
  const primero = db.prepare(
    'SELECT desde_hora FROM gal_lote_vigente WHERE fecha = ? ORDER BY desde_hora LIMIT 1').get(f);
  if (!primero || primero.desde_hora === '00:00') return null;
  return { desde_hora: primero.desde_hora };
}

// Los tramos del día con su hora de FIN, que es la de inicio del siguiente. No está en la
// base a propósito —guardarla sería guardar dos veces el mismo dato y poder contradecirse—
// pero es lo que hay que mostrar: «de 08:00 a 13:30» se lee; «desde 08:00» hay que
// cruzarlo con el renglón de abajo.
export function tramosDelDia(db, fecha) {
  const filas = lotesDelDia(db, fecha);
  return filas.map((r, i) => Object.assign({}, r, {
    hasta_hora: i + 1 < filas.length ? filas[i + 1].desde_hora : null,
  }));
}

// ── LOS LOTES ENTRE LOS QUE SE ELIGE ─────────────────────────────────────────────────
// Salen de Personal/Producción (`pa_lotes`), igual que las cuadrillas: acá no se dan de
// alta. Se les pega el cultivo para proponerlo como producto.
//
// El cultivo se elige con un ORDER BY y no con la campaña activa: hay DOS campañas
// activas a la vez (una anual y una estacional, ver pa_campañas.tipo), así que
// `WHERE activa = 1 LIMIT 1` devuelve una de las dos según el humor del planificador. Un
// frutal es perenne y su cultivo no cambia de campaña en campaña — por eso se prefiere el
// perenne, y entre los demás el de la campaña más nueva.
//
// Y es una PROPUESTA: el producto queda editable en la ventana. El cultivo del lote dice
// qué árbol hay plantado; lo que entra al galpón un martes lo sabe el que está ahí.
export function lotesParaElDia(db) {
  return db.prepare(
    ' SELECT l.id, l.nombre, l.finca, s.nombre AS sector, s.tipo AS sector_tipo,'
    + '       cl.cultivo'
    + '  FROM pa_lotes l'
    + '  LEFT JOIN pa_sectores s ON s.id = l.sector_id'
    + '  LEFT JOIN pa_cultivos_lote cl ON cl.id = ('
    + '        SELECT c2.id FROM pa_cultivos_lote c2 WHERE c2.lote_id = l.id'
    + '         ORDER BY c2.es_perenne DESC, c2.campaña DESC LIMIT 1)'
    + ' WHERE (l.activo IS NULL OR l.activo = 1)'
    + ' ORDER BY l.finca IS NULL, l.finca COLLATE NOCASE, l.nombre COLLATE NOCASE').all();
}

// ── ¿YA SE VOLCÓ ALGO CONTRA ESTE TRAMO? ─────────────────────────────────────────────
// Un tramo sin volcados es una declaración que todavía no atribuyó nada: se corrige o se
// borra sin consecuencia, y ése es el caso normal (el error se descubre a los diez
// minutos de cargarlo).
//
// Con volcados encima es otra cosa. Cada volcado CONGELÓ su lote_id, así que tocar el
// tramo no los arregla — lo único que hace es dejar esos kilos atribuidos a un lote que
// ya nadie declaró. Por eso el router corta ahí.
//
// Devuelve null —no 0— mientras la tabla no exista: el volcado llega en el PR que viene y
// hasta entonces no hay nada que proteger. La diferencia importa, porque 0 significa
// «miré y no hay» y null significa «todavía no hay dónde mirar».
export function volcadosEnTramo(db, fecha, desdeHora, hastaHora) {
  const hay = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='gal_volcados'").get();
  if (!hay) return null;
  const f = esFecha(fecha);
  if (!f) return 0;
  const d = hhmm(desdeHora) || '00:00';
  const h = hhmm(hastaHora);
  const r = db.prepare(
    " SELECT COUNT(*) AS n FROM gal_volcados"
    + " WHERE date(volcado_en) = ? AND time(volcado_en) >= ?"
    + (h ? ' AND time(volcado_en) < ?' : '')).get(...(h ? [f, d, h] : [f, d]));
  return r ? r.n : 0;
}
