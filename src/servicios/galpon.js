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
    // 0 = apagado. Ver el comentario del seed en db_galpon.js.
    kg_max_carga: Number(c.kg_max_carga) || 0,
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
  // ── ANTES DEL PRIMER TRAMO NO HAY UN AGUJERO: HAY EL PRIMER LOTE ──────────────────
  // Si el primer tramo del día quedó cargado a las 07:00 y entra algo 06:40, el lote
  // correcto es ése: es el único que alguien declaró ese día. La versión anterior
  // devolvía `ok:false` y mandaba esos kilos a revisar — y además obligaba a la pantalla
  // a avisar de un agujero que no existe, que es de lo que se quejó el operador.
  //
  // Un día sin NINGÚN tramo sigue siendo `ok:false`: ahí sí no hay nada que elegir.
  const fila = r || db.prepare(
    'SELECT * FROM gal_lote_vigente WHERE fecha = ? ORDER BY desde_hora, id LIMIT 1').get(f);
  if (!fila) {
    return { lote_id: null, ok: false, motivo: 'No se cargó el lote del día ' + f };
  }
  return {
    lote_id: fila.lote_id,
    lote_nombre: fila.lote_nombre || null,
    producto: fila.producto || null,
    desde_hora: fila.desde_hora,
    // Para que la pantalla pueda decir «es el primero del día» sin volver a preguntar.
    antes_del_primero: !r,
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
// ── ACÁ VIVÍA `huecoDelDia`, Y NO VUELVE ────────────────────────────────────────────
// Devolvía la hora del primer tramo cuando no era 00:00, y la pantalla la usaba para un
// cartel que avisaba de que lo volcado antes de esa hora quedaba sin lote. Andy,
// 30/10/2026: *«porque tanto tema con la hora?»* — y tenía razón dos veces:
//
// 1. Se lo comía el que hacía lo correcto. Poner 07:00, que es cuando abre el galpón, es
//    el dato más fiel que se puede cargar, y el sistema contestaba con una advertencia y
//    un botón para deshacerlo.
// 2. El agujero no puede existir. `loteVigente` ahora cae en el primer tramo del día
//    cuando lo que entra es anterior, que es la respuesta correcta: ese lote es el único
//    que alguien declaró ese día.

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
// Devuelve null —no 0— mientras la tabla no exista. La diferencia importa, porque 0
// significa «miré y no hay» y null significa «todavía no hay dónde mirar».
//
// ── SÓLO CUENTA LOS QUE SACARON SU LOTE DEL RELOJ ───────────────────────────────────
// Una carga MANUAL nombra su lote: el operador lo eligió de la lista. Esa fila no depende
// de ningún tramo, así que corregir el tramo no la toca y no hay nada que trabar.
//
// Los que sí dependen son los que entraron por escaneo, que tienen `hora` y de ahí
// sacaron el lote. Por eso se filtra por hora y no por la fecha sola: con la carga
// manual, trabar el tramo por existir kilos ese día sería trabarlo siempre y por nada —
// y el que quiere arreglar un lote mal declarado se queda sin poder.
//
// EL `hora IS NOT NULL` ES REDUNDANTE Y VA IGUAL. `NULL >= '00:00'` ya da NULL en SQL,
// así que las cargas manuales quedan afuera con o sin él: sacarlo no cambia una coma, y
// se comprobó rompiéndolo (ningún test se puso en rojo, que es lo correcto).
//
// Está escrito porque la intención no se lee en una comparación que depende de cómo SQL
// trata el NULL. El día que alguien escriba `COALESCE(hora, '00:00') >= ?` —que parece
// una prolijidad— todas las cargas manuales empezarían a trabar el tramo, en silencio.
// Con la condición a la vista, ese cambio se ve.
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
    + "  WHERE fecha = ? AND eliminado_en IS NULL AND hora IS NOT NULL AND hora >= ?"
    + (h ? ' AND hora < ?' : '')).get(...(h ? [f, d, h] : [f, d]));
  return r ? r.n : 0;
}

// ═══════════════════════════════════════════════════════════════════════════════════
// LOS KILOS, CARGADOS A MANO
// ═══════════════════════════════════════════════════════════════════════════════════
// Todavía no hay impresora, así que no hay tarjetas, así que no hay escaneo. El galpón
// igual tiene que medir: la cosecha no espera al hardware.
//
// El operador dice las cinco cosas que hacen falta —fecha, lote, producto, cuadrilla y
// kilos— y eso entra al MISMO libro (`gal_volcados`) en el que va a escribir el escaneo
// cuando llegue. Lo que cambia es quién llena los campos.

// ── LOS KILOS, COMO SE ESCRIBEN ACÁ ─────────────────────────────────────────────────
// Un operador argentino escribe «1.234,5», no «1234.5». Si el parseo no lo contempla,
// `Number('1.234,5')` da NaN y la carga se rechaza; peor todavía, `Number('1.234')` da
// 1,234 — mil doscientos treinta y cuatro kilos entrarían como poco más de un kilo, sin
// error y sin que nadie lo note hasta que no cierre la temporada.
//
// Son DOS reglas, y la segunda es la que de verdad importa:
//
// 1. Si hay coma, la coma es el decimal y los puntos son miles. «1.234,5» → 1234.5.
// 2. Sin coma, un punto seguido de EXACTAMENTE TRES dígitos (y nada más detrás) es
//    separador de miles: «1.250» → 1250, «12.500» → 12500. Cualquier otro punto es
//    decimal: «450.5» → 450.5, «1.25» → 1.25.
//
// La segunda parece un detalle y es la que evita el error grande. Acá se escribe «1.250»
// para decir mil doscientos cincuenta kilos, y leerlo como 1,25 kg no da error ni se ve:
// entra un número plausible, mil veces más chico, y aparece recién cuando no cierra el
// rendimiento de la temporada. Nadie escribe tres decimales para pesar fruta.
export function kilos(v) {
  // El «kg» se saca SÓLO del final y después de recortar: un `$` aplicado antes del
  // trim no matchea nada si quedó un espacio detrás, y «450 kg » se iba al tacho.
  const s = String(v == null ? '' : v).trim()
    .replace(/\s*kgs?\.?$/i, '').replace(/\s/g, '');
  if (!s) return null;
  let limpio;
  if (s.includes(',')) limpio = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) limpio = s.replace(/\./g, '');
  else limpio = s;
  if (!/^-?\d+(\.\d+)?$/.test(limpio)) return null;
  const n = Number(limpio);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

// Enteros opcionales (los IFCOs). Vacío es null —no 0—: «no lo contaron» y «contaron
// cero» son cosas distintas, y promediar kg por IFCO con los ceros de adentro miente.
export function entero(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Dos decimales, en un solo lugar. Los kilos se suman y se promedian, y una suma de
// flotantes arrastra el 0,000000001 hasta que un total cierra con tres decimales raros.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const txt = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s ? s : null;
};

// ── CARGAR KILOS ────────────────────────────────────────────────────────────────────
// Devuelve `{ok:false, motivo}` en vez de tirar, como todo el módulo.
//
// ── ACÁ SÍ SE RECHAZA, Y NO CONTRADICE LA REGLA ─────────────────────────────────────
// «Nada se puede rechazar después del hecho» es sobre el VOLCADO: el operario tiene el
// IFCO en la mano, la fruta ya está en la tolva y un rechazo es fruta que se perdió del
// conteo. Acá es otra situación: hay una persona sentada frente al formulario que puede
// corregir el renglón en el momento. Rechazar una fecha ilegible es lo correcto;
// guardarla «para revisar después» es inventar trabajo para alguien.
//
// Lo que NO se rechaza es el número grande (abajo): ése puede ser cierto.
export function registrarVolcado(db, d) {
  const dd = d || {};

  const fecha = esFecha(dd.fecha);
  if (!fecha) return { ok: false, motivo: 'La fecha tiene que ser YYYY-MM-DD' };

  const loteId = parseInt(dd.lote_id, 10);
  if (!Number.isFinite(loteId) || loteId <= 0) {
    return { ok: false, motivo: 'Falta elegir el lote' };
  }
  // El nombre del lote se lee de la base, NO se cree el que mandó el navegador. Si lo
  // guardáramos como viene, dos pantallas con distinta versión del padrón escribirían
  // dos nombres para el mismo lote y los informes mostrarían dos renglones.
  const lote = db.prepare('SELECT id, nombre FROM pa_lotes WHERE id = ?').get(loteId);
  if (!lote) return { ok: false, motivo: 'El lote ' + loteId + ' no existe' };

  let cuadId = null, cuadNom = null;
  if (dd.cuadrilla_id != null && String(dd.cuadrilla_id).trim() !== '') {
    const ci = parseInt(dd.cuadrilla_id, 10);
    const c = Number.isFinite(ci)
      ? db.prepare('SELECT id, nombre FROM pa_cuadrillas WHERE id = ?').get(ci) : null;
    if (!c) return { ok: false, motivo: 'La cuadrilla ' + dd.cuadrilla_id + ' no existe' };
    cuadId = c.id; cuadNom = c.nombre;
  }

  const kg = kilos(dd.kilos);
  if (kg === null) {
    return { ok: false, motivo: 'Los kilos no se entienden: "' + (dd.kilos ?? '') + '"' };
  }
  if (kg <= 0) return { ok: false, motivo: 'Los kilos tienen que ser mayores que cero' };

  // EL CERO DE MÁS. Se MARCA, no se frena: 4.500 kg en una carga puede ser cierto el día
  // que entra un camión entero, y frenarlo enseñaría a partir el renglón en dos para
  // esquivarlo — que es la manera de que el dato quede mal Y además irrastreable.
  const techo = config(db).kg_max_carga;
  let estado = 'ok', revision = null;
  if (techo > 0 && kg > techo) {
    estado = 'a_revisar';
    revision = kg.toLocaleString('es-AR') + ' kg en una sola carga supera el tope de '
             + techo.toLocaleString('es-AR') + ' kg. Suele ser un cero de más: confirmalo.';
  }

  const r = db.prepare(
    `INSERT OR IGNORE INTO gal_volcados
       (uuid, fecha, hora, lote_id, lote_nombre, producto, cuadrilla_id, cuadrilla,
        kilos, ifcos, origen, observacion, estado, revision_motivo, usuario_id, usuario)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    txt(dd.uuid), fecha, hhmm(dd.hora), lote.id, lote.nombre, txt(dd.producto),
    cuadId, cuadNom, kg, entero(dd.ifcos), txt(dd.origen) || 'manual',
    txt(dd.observacion), estado, revision,
    dd.usuario_id ?? null, txt(dd.usuario),
  );

  // El uuid repetido no es un error: es la cola reintentando. Se devuelve la fila que ya
  // estaba, para que el que reintentó vea lo mismo que vería si hubiera entrado recién.
  if (!r.changes) {
    const ya = db.prepare('SELECT * FROM gal_volcados WHERE uuid = ?').get(txt(dd.uuid));
    return { ok: true, repetido: true, id: ya ? ya.id : null, fila: ya || null, aviso: null };
  }

  const id = Number(r.lastInsertRowid);
  return {
    ok: true,
    repetido: false,
    id,
    fila: db.prepare('SELECT * FROM gal_volcados WHERE id = ?').get(id),
    aviso: revision,
  };
}

// ── CORREGIR UNA CARGA ──────────────────────────────────────────────────────────────
// Sólo lo que vino en el pedido. Un PATCH que pisara con null los campos ausentes
// borraría la cuadrilla cada vez que alguien corrige los kilos.
//
// Y se revalida el tope: corregir 450 a 4500 tiene que volver a marcarla, igual que si
// se hubiera cargado así de entrada.
export function editarVolcado(db, id, d) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const fila = db.prepare(
    'SELECT * FROM gal_volcados WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!fila) return { ok: false, motivo: 'Esa carga no existe o ya se borró' };

  const dd = d || {};
  const sets = [], par = [];
  const set = (col, val) => { sets.push(col + ' = ?'); par.push(val); };

  if ('fecha' in dd) {
    const f = esFecha(dd.fecha);
    if (!f) return { ok: false, motivo: 'La fecha tiene que ser YYYY-MM-DD' };
    set('fecha', f);
  }
  if ('lote_id' in dd) {
    const l = db.prepare('SELECT id, nombre FROM pa_lotes WHERE id = ?')
                .get(parseInt(dd.lote_id, 10));
    if (!l) return { ok: false, motivo: 'El lote ' + dd.lote_id + ' no existe' };
    set('lote_id', l.id); set('lote_nombre', l.nombre);
  }
  if ('cuadrilla_id' in dd) {
    if (dd.cuadrilla_id == null || String(dd.cuadrilla_id).trim() === '') {
      set('cuadrilla_id', null); set('cuadrilla', null);
    } else {
      const c = db.prepare('SELECT id, nombre FROM pa_cuadrillas WHERE id = ?')
                  .get(parseInt(dd.cuadrilla_id, 10));
      if (!c) return { ok: false, motivo: 'La cuadrilla ' + dd.cuadrilla_id + ' no existe' };
      set('cuadrilla_id', c.id); set('cuadrilla', c.nombre);
    }
  }
  if ('producto' in dd)    set('producto', txt(dd.producto));
  if ('observacion' in dd) set('observacion', txt(dd.observacion));
  if ('ifcos' in dd)       set('ifcos', entero(dd.ifcos));

  let kg = fila.kilos;
  if ('kilos' in dd) {
    const k = kilos(dd.kilos);
    if (k === null) return { ok: false, motivo: 'Los kilos no se entienden: "' + (dd.kilos ?? '') + '"' };
    if (k <= 0) return { ok: false, motivo: 'Los kilos tienen que ser mayores que cero' };
    set('kilos', k); kg = k;
  }

  if (!sets.length) return { ok: false, motivo: 'No vino nada para cambiar' };

  const techo = config(db).kg_max_carga;
  const revision = (techo > 0 && kg > techo)
    ? kg.toLocaleString('es-AR') + ' kg en una sola carga supera el tope de '
      + techo.toLocaleString('es-AR') + ' kg. Suele ser un cero de más: confirmalo.'
    : null;
  set('estado', revision ? 'a_revisar' : 'ok');
  set('revision_motivo', revision);

  par.push(i);
  db.prepare('UPDATE gal_volcados SET ' + sets.join(', ') + ' WHERE id = ?').run(...par);
  return {
    ok: true,
    fila: db.prepare('SELECT * FROM gal_volcados WHERE id = ?').get(i),
    aviso: revision,
  };
}

// Soft delete, como en el resto del repo: un renglón de kilos borrado de verdad es un
// jornal que no se puede auditar después.
export function borrarVolcado(db, id) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const r = db.prepare(
    "UPDATE gal_volcados SET eliminado_en = datetime('now','localtime')"
    + ' WHERE id = ? AND eliminado_en IS NULL').run(i);
  if (!r.changes) return { ok: false, motivo: 'Esa carga no existe o ya se borró' };
  return { ok: true };
}

// ── LO QUE SE CARGÓ UN DÍA ──────────────────────────────────────────────────────────
export function volcadosDelDia(db, fecha) {
  const f = esFecha(fecha);
  if (!f) return [];
  return db.prepare(
    ' SELECT * FROM gal_volcados'
    + '  WHERE fecha = ? AND eliminado_en IS NULL'
    + '  ORDER BY id DESC').all(f);
}

// ── LO ÚLTIMO QUE CARGÓ ─────────────────────────────────────────────────────────────
// Andy, 31/10/2026: «que ya quede guardado el último lote, comentarios y cuadrilla que
// puso y vaya cargando solo los cajones nuevos».
//
// El encabezado de la carga rápida sale de ACÁ y no de nada guardado aparte: es la
// última fila que esa persona escribió. No hay preferencia que mantener sincronizada ni
// que limpiar cuando alguien borra su última carga.
//
// La cadena de respaldos va de lo más específico a lo más viejo, y cada escalón dice de
// dónde vino. Eso último no es decorativo: un encabezado que viene de AYER es un
// encabezado que nadie eligió hoy, y cargar medio día con la cuadrilla de ayer es pagarle
// el jornal a la gente equivocada. La pantalla lo usa para pedir que lo confirmen.
export function ultimaCarga(db, fecha, usuarioId) {
  const f = esFecha(fecha);
  if (!f) return null;
  const col = ' SELECT id, fecha, lote_id, lote_nombre, producto, cuadrilla_id, cuadrilla,'
            + '        observacion, usuario_id'
            + '   FROM gal_volcados WHERE eliminado_en IS NULL';
  const u = Number(usuarioId);
  const mio = Number.isFinite(u) && u > 0 ? u : null;

  let fila = null;
  if (mio) fila = db.prepare(col + ' AND fecha = ? AND usuario_id = ? ORDER BY id DESC LIMIT 1')
                    .get(f, mio);
  if (!fila) fila = db.prepare(col + ' AND fecha = ? ORDER BY id DESC LIMIT 1').get(f);
  if (!fila && mio) fila = db.prepare(col + ' AND usuario_id = ? ORDER BY id DESC LIMIT 1').get(mio);
  if (!fila) fila = db.prepare(col + ' ORDER BY id DESC LIMIT 1').get();
  if (!fila) return null;

  return {
    lote_id: fila.lote_id,
    lote_nombre: fila.lote_nombre,
    producto: fila.producto,
    cuadrilla_id: fila.cuadrilla_id,
    cuadrilla: fila.cuadrilla,
    observacion: fila.observacion,
    fecha: fila.fecha,
    // Las dos banderas con las que la pantalla decide si pregunta o no.
    de_otro_dia: fila.fecha !== f,
    mio: mio != null && fila.usuario_id === mio,
  };
}

// ── EL RESUMEN DEL DÍA ──────────────────────────────────────────────────────────────
// El total, y los dos cortes que se miran de verdad: por cuadrilla (es como se paga el
// jornal) y por lote (es como se mide el rendimiento).
//
// Los SUM() van repetidos en el ORDER BY en vez de usar el alias. En SQLite, `ORDER BY
// kilos` dentro de un GROUP BY se ata a la COLUMNA `kilos` y no al `SUM(kilos)` que la
// tapa — y entonces ordena por el valor de una fila cualquiera del grupo. Ya pasó en
// este repo con otro alias y no se ve: la lista sale ordenada, sólo que mal.
export function resumenDelDia(db, fecha) {
  const f = esFecha(fecha);
  const vacio = { kilos: 0, ifcos: 0, cargas: 0, a_revisar: 0, por_cuadrilla: [], por_lote: [] };
  if (!f) return vacio;

  const base = ' FROM gal_volcados WHERE fecha = ? AND eliminado_en IS NULL';
  const t = db.prepare(
    ' SELECT COUNT(*) AS cargas,'
    + '       COALESCE(SUM(kilos),0) AS kilos,'
    + '       COALESCE(SUM(ifcos),0) AS ifcos,'
    + "       COALESCE(SUM(CASE WHEN estado = 'a_revisar' THEN 1 ELSE 0 END),0) AS a_revisar"
    + base).get(f);

  const porCuadrilla = db.prepare(
    ' SELECT cuadrilla_id,'
    + "       COALESCE(cuadrilla, '— sin cuadrilla —') AS nombre,"
    + '       COUNT(*) AS cargas,'
    + '       COALESCE(SUM(kilos),0) AS kilos,'
    + '       COALESCE(SUM(ifcos),0) AS ifcos'
    + base
    + ' GROUP BY cuadrilla_id'
    + ' ORDER BY SUM(kilos) DESC').all(f);

  const porLote = db.prepare(
    ' SELECT lote_id,'
    + "       COALESCE(lote_nombre, 'Lote ' || lote_id) AS nombre,"
    + '       GROUP_CONCAT(DISTINCT producto) AS producto,'
    + '       COUNT(*) AS cargas,'
    + '       COALESCE(SUM(kilos),0) AS kilos,'
    + '       COALESCE(SUM(ifcos),0) AS ifcos'
    + base
    + ' GROUP BY lote_id'
    + ' ORDER BY SUM(kilos) DESC').all(f);

  return {
    kilos: Math.round((t.kilos || 0) * 100) / 100,
    ifcos: t.ifcos || 0,
    cargas: t.cargas || 0,
    a_revisar: t.a_revisar || 0,
    por_cuadrilla: porCuadrilla,
    por_lote: porLote,
  };
}

// ── DESDE CUÁNDO HAY KILOS CARGADOS ─────────────────────────────────────────────────
// Para que la pantalla de acumulado abra mostrando TODO sin que nadie elija un desde.
// Un rango que arranca el 1 de enero por convención esconde la mitad de la temporada
// si la cosecha empezó antes, y nadie se entera: la pantalla muestra un número y el
// número está mal por abajo, que es la manera en que no se nota.
export function rangoCargado(db) {
  const r = db.prepare(
    ' SELECT MIN(fecha) AS primera, MAX(fecha) AS ultima,'
    + '       COUNT(DISTINCT fecha) AS dias'
    + '  FROM gal_volcados WHERE eliminado_en IS NULL').get();
  return { primera: (r && r.primera) || null, ultima: (r && r.ultima) || null,
           dias: (r && r.dias) || 0 };
}

// ── EL ACUMULADO ────────────────────────────────────────────────────────────────────
// Andy, 31/10/2026: «mostrame algún lugar donde vamos acumulando el total, no sólo por
// día». La pantalla de carga contesta "cuánto entró hoy"; ésta contesta "cuánto llevamos",
// que es la pregunta de la temporada: con cuántos kilos cerró cada lote, cuánto trajo
// cada cuadrilla, y si el ritmo sube o baja.
//
// Mismos cortes que el día —por cuadrilla paga el jornal, por lote mide el rendimiento—
// más uno que recién tiene sentido en el rango: POR PRODUCTO. Un día es casi siempre de
// un solo producto; una temporada son varios y es el corte con el que se habla afuera.
//
// Los SUM() van repetidos en el ORDER BY y no por alias: en SQLite `ORDER BY kilos`
// adentro de un GROUP BY se ata a la COLUMNA y no al SUM() que la tapa, y la lista sale
// ordenada pero mal. Ya pasó en este repo y no se ve.
// ¿Es un día que existe de verdad? esFecha() valida la FORMA y nada más, y eso está
// bien donde está: al cargar no se rechaza nada. Pero como extremo de un rango, un
// '2026-13-45' se cuela, queda después de cualquier fecha, da vuelta el período y lo
// recorta a un solo día — y la pantalla muestra un total más chico sin decir por qué.
function fechaDeAlmanaque(v) {
  const f = esFecha(v);
  if (!f) return null;
  const [a, m, d] = f.split('-').map(Number);
  const x = new Date(Date.UTC(a, m - 1, d));
  return (x.getUTCFullYear() === a && x.getUTCMonth() === m - 1 && x.getUTCDate() === d)
    ? f : null;
}

export function acumulado(db, desde, hasta) {
  let d = fechaDeAlmanaque(desde);
  let h = fechaDeAlmanaque(hasta);
  const r = rangoCargado(db);
  // Sin desde o sin hasta se toma todo lo que hay. Abrir la pantalla en blanco porque
  // faltó un parámetro es la peor respuesta posible a "cuánto llevamos".
  if (!d) d = r.primera || h || '0000-01-01';
  if (!h) h = r.ultima || d;

  // Al revés se da dado vuelta: entre el 30 y el 1 no hay nada, y la pantalla diría
  // 0 kg con total aplomo. Es el único sentido posible de esas dos fechas, así que se
  // enderezan — y se avisa, porque los casilleros van a aparecer cambiados de lugar.
  let invertido = false;
  if (d > h) { const t = d; d = h; h = t; invertido = true; }

  const base = ' FROM gal_volcados'
             + '  WHERE fecha >= ? AND fecha <= ? AND eliminado_en IS NULL';

  const t = db.prepare(
    ' SELECT COUNT(*) AS cargas,'
    + '       COUNT(DISTINCT fecha) AS dias,'
    + '       COALESCE(SUM(kilos),0) AS kilos,'
    + '       COALESCE(SUM(ifcos),0) AS ifcos,'
    + "       COALESCE(SUM(CASE WHEN estado = 'a_revisar' THEN 1 ELSE 0 END),0) AS a_revisar"
    + base).get(d, h);

  const kilos = round2(t.kilos || 0);
  const dias = t.dias || 0;

  const corte = (col, etiqueta, extra) => db.prepare(
    ' SELECT ' + col + ' AS gid,'
    + '       COALESCE(' + etiqueta + ") AS nombre,"
    + (extra ? '       ' + extra + ',' : '')
    + '       COUNT(*) AS cargas,'
    + '       COUNT(DISTINCT fecha) AS dias,'
    + '       COALESCE(SUM(kilos),0) AS kilos,'
    + '       COALESCE(SUM(ifcos),0) AS ifcos'
    + base
    + ' GROUP BY ' + col
    + ' ORDER BY SUM(kilos) DESC').all(d, h);

  // El porcentaje se calcula acá y no en la pantalla: es el mismo número en la tabla y
  // en la barrita, y dos lugares que lo dividen son dos lugares que lo redondean distinto.
  const conPct = (filas) => filas.map((f) => Object.assign({}, f, {
    kilos: round2(f.kilos || 0),
    pct: kilos > 0 ? Math.round(((f.kilos || 0) / kilos) * 1000) / 10 : 0,
  }));

  const porCuadrilla = conPct(corte('cuadrilla_id', "cuadrilla, '— sin cuadrilla —'"));
  const porLote = conPct(corte('lote_id', "lote_nombre, 'Lote ' || lote_id",
    // GROUP_CONCAT y no `producto` pelado: una columna suelta adentro de un GROUP BY la
    // elige SQLite de una fila cualquiera del grupo. Un lote del que salieron damasco y
    // ciruela mostraría uno solo de los dos, al azar y sin avisar.
    'GROUP_CONCAT(DISTINCT producto) AS producto'));
  const porProducto = conPct(corte('producto', "producto, '— sin producto —'"));

  // El día a día, con el total CORRIENDO. Se suma en orden ascendente —que es el único
  // en que un acumulado significa algo— y recién después se da vuelta para mostrar lo
  // último arriba. Hecho al revés, el primer renglón diría los kilos del último día.
  const dd = db.prepare(
    ' SELECT fecha,'
    + '       COUNT(*) AS cargas,'
    + '       COALESCE(SUM(kilos),0) AS kilos,'
    + '       COALESCE(SUM(ifcos),0) AS ifcos'
    + base
    + ' GROUP BY fecha'
    + ' ORDER BY fecha ASC').all(d, h);

  let corrido = 0;
  for (const f of dd) {
    f.kilos = round2(f.kilos || 0);
    corrido = round2(corrido + f.kilos);
    f.acumulado = corrido;
  }
  const porDia = dd.slice().reverse();

  // El mejor día se saca de la misma lista y no con otro SELECT: una segunda consulta
  // con otro criterio de desempate puede contestar un día distinto al que la tabla
  // muestra arriba de todo, y entonces la pantalla se contradice sola.
  let mejor = null;
  for (const f of dd) if (!mejor || f.kilos > mejor.kilos) mejor = { fecha: f.fecha, kilos: f.kilos };

  return {
    desde: d, hasta: h, invertido,
    total: { kilos, ifcos: t.ifcos || 0, cargas: t.cargas || 0,
             a_revisar: t.a_revisar || 0, dias },
    // Promedio por día TRABAJADO, no por día del almanaque. Dividir por los días del
    // rango mete los domingos y los días de lluvia en el divisor y baja el promedio sin
    // que haya pasado nada: el número deja de servir para comparar dos semanas.
    promedio_dia: dias > 0 ? round2(kilos / dias) : 0,
    mejor_dia: mejor,
    por_dia: porDia,
    por_lote: porLote,
    por_cuadrilla: porCuadrilla,
    por_producto: porProducto,
  };
}
