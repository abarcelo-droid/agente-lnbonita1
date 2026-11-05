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

// Para la versión del dibujo de una presentación: un hash del contenido.
import crypto from 'node:crypto';
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
    // El techo del PROCESO. Ver el seed en db_galpon.js: acá el cero de más tiene
    // forma de gramos escritos donde van kilos, y la cuenta se va por mil.
    kg_max_proceso: Number(c.kg_max_proceso) || 0,
    // DE DÓNDE ARRANCA EL CORRELATIVO DEL PALLET. Van acá y no en valorConfig() porque
    // la pantalla las muestra juntas con el próximo número, que es la única forma de
    // ver antes de cerrar un pallet si se está a punto de abrir un hueco.
    pallet_prefijo: c.pallet_prefijo || 'PC',
    pallet_desde: Number(c.pallet_desde) || 0,
    pallet_desde_anio: (c.pallet_desde_anio || '').trim(),
  };
}

// Una sola clave, sin convertir. config() devuelve las conocidas ya parseadas; esto es
// para las de texto que no vale la pena agregar allá — el prefijo del pallet, los
// renglones del pie de la etiqueta.
export function valorConfig(db, clave, porDefecto) {
  const f = db.prepare('SELECT valor FROM gal_config WHERE clave = ?').get(String(clave || ''));
  const v = f && f.valor != null ? String(f.valor) : null;
  return v && v !== '' ? v : (porDefecto == null ? null : porDefecto);
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
export function kilos(v, dec) {
  const esc = Math.pow(10, dec == null ? 2 : dec);
  /* UN NÚMERO YA ES UN NÚMERO. La regla de los miles es para interpretar lo que
     TIPEA una persona; aplicársela a un número hace que 12,345 entre como 12.345.
     Pasaba con la balanza y con el peso por unidad del catálogo. */
  if (typeof v === 'number') {
    return Number.isFinite(v) ? Math.round(v * esc) / esc : null;
  }
  // El «kg» se saca SÓLO del final y después de recortar: un `$` aplicado antes del
  // trim no matchea nada si quedó un espacio detrás, y «450 kg » se iba al tacho.
  const s = String(v == null ? '' : v).trim()
    .replace(/\s*kgs?\.?$/i, '').replace(/\s/g, '');
  if (!s) return null;
  let limpio;
  if (s.includes(',')) limpio = s.replace(/\./g, '').replace(',', '.');
  /* Y «0.615» es seis coma quince, no seiscientos quince: nadie escribe un separador
     de miles después de un cero. Sin esta excepción, un peso por unidad tipeado en
     kilos se multiplicaba por mil. */
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s) && !/^-?0\./.test(s)) {
    limpio = s.replace(/\./g, '');
  }
  else limpio = s;
  if (!/^-?\d+(\.\d+)?$/.test(limpio)) return null;
  const n = Number(limpio);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * esc) / esc;
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
// El día de hoy en hora LOCAL, no UTC: a las 21:30 de Mendoza toISOString() ya dice
// mañana, y un despacho quedaría fechado un día después del camión.
const hoy = () => new Date().toLocaleDateString('en-CA');

// ── EL PRIMER EMOJI Y NADA MÁS ──────────────────────────────────────────────────────
// Intl.Segmenter agrupa por GRAFEMA, que es lo que una persona llama «un carácter»: una
// bandera son dos code points y un emoji con tono de piel son cuatro, así que cortar
// con .slice(0,1) devolvería medio dibujo o un cuadradito. Viene con Node y con todo
// navegador de escritorio desde 2020.
const primerEmoji = (v) => {
  const t = txt(v);
  if (!t) return null;
  try {
    const seg = new Intl.Segmenter('es', { granularity: 'grapheme' });
    const g = [...seg.segment(t)][0];
    return g ? g.segment : null;
  } catch (e) {
    /* Sin Segmenter se devuelve el primer code point entero (no la primera unidad
       UTF-16, que parte un emoji al medio y deja un '\uFFFD'). */
    return [...t][0] || null;
  }
};

// ── DE DÓNDE SALIÓ EL PESO ──────────────────────────────────────────────────────────
// Tres, y no texto libre. Es lo que después contesta «cuánto se pesó a mano», que es
// la señal de que la balanza dejó de andar: si un día el 80% de la temporada entró
// tipeado, hay un equipo roto y nadie avisó. Con texto libre serían 'manual',
// 'a mano', 'MANUAL' y ' manual' y ningún informe posible.
/* ── EL ESTADO SANITARIO DE LA PLANILLA: B / R / M ────────────────────────────────
   Bueno, Regular, Malo. Tres letras y no texto libre: en el papel se CIRCULA una de
   las tres, y texto libre serían cuarenta maneras de escribir lo mismo y ningún
   informe posible — la misma razón por la que los motivos de gestión son cuatro.

   NULO ES «NO SE MIRÓ», y no es lo mismo que B. Una planilla donde todo figura bueno
   porque nadie completó la columna es peor que una con huecos: la firman tres
   personas. */
// ════════════════════════════════════════════════════════════════════════════════════
// 👷 DOS CUADRILLAS EN EL MISMO CAJÓN
// ════════════════════════════════════════════════════════════════════════════════════
// Andy, 2/11/2026: «que pueda elegir dos cuadrillas cosechando el mismo cajón. A veces
// pasa».
//
// UNA SOLA PUERTA PARA LAS DOS MANERAS DE PEDIRLO. La pantalla manda `cuadrilla_ids`
// (una lista); la carga rápida vieja, la cola que quedó de ayer sin mandar y cualquier
// pedido escrito antes de hoy mandan `cuadrilla_id` (uno). Las dos entran por acá, así
// que el resto del módulo no tiene que saber cuál vino — y una cola guardada el jueves
// sigue entrando el viernes.
//
// Devuelve `{ok:false, motivo}` como todo el módulo, nunca tira.
export function cuadrillasPedidas(db, d) {
  const dd = d || {};
  const crudos = Array.isArray(dd.cuadrilla_ids) ? dd.cuadrilla_ids
                 : (dd.cuadrilla_id != null ? [dd.cuadrilla_id] : []);
  const ids = [];
  for (const c of crudos) {
    if (c == null || String(c).trim() === '') continue;   // el '— sin cuadrilla —'
    const i = parseInt(c, 10);
    if (!Number.isFinite(i)) return { ok: false, motivo: 'La cuadrilla "' + c + '" no se entiende' };
    // REPETIDA NO ES ERROR, ES UN CLIC DE MÁS. Dejarla pasar dos veces partiría los
    // kilos en dos mitades para la MISMA cuadrilla, que suman lo mismo pero hacen que
    // la pantalla diga «Norte + Norte». Y rechazarlo sería frenar una carga por un
    // problema que se arregla solo.
    if (ids.indexOf(i) < 0) ids.push(i);
  }
  const lista = [];
  for (const i of ids) {
    const c = db.prepare('SELECT id, nombre FROM pa_cuadrillas WHERE id = ?').get(i);
    if (!c) return { ok: false, motivo: 'La cuadrilla ' + i + ' no existe' };
    lista.push({ id: c.id, nombre: c.nombre });
  }
  return { ok: true, lista };
}

// Cómo se ve en una sola línea: «Norte + Sur». Es lo que va en gal_volcados.cuadrilla,
// que es la columna que lee cualquier pantalla sin saber de esto.
export function nombreDeCuadrillas(lista) {
  const l = lista || [];
  if (!l.length) return null;
  return l.map((c) => c.nombre).join(' + ');
}

// LA ATRIBUCIÓN, EN PARTES IGUALES. `repartir` le da el resto a la última, así que la
// suma cierra exacta contra los kilos del cajón: repartir 701 en dos y redondear cada
// mitad daría 700,99, y ese centavo aparecería como kilos que nadie cosechó.
//
// Se BORRA y se vuelve a escribir, no se actualiza: corregir los kilos o cambiar una
// cuadrilla por otra son el caso normal, y un UPDATE selectivo dejaría la fila de la
// cuadrilla que se sacó con su parte adentro.
export function guardarCuadrillas(db, volcadoId, lista, kg) {
  db.prepare('DELETE FROM gal_volcado_cuadrillas WHERE volcado_id = ?').run(volcadoId);
  const l = lista || [];
  if (!l.length) return [];
  const partes = repartir(kg, l.map(() => 1 / l.length));
  const ins = db.prepare(
    'INSERT INTO gal_volcado_cuadrillas (volcado_id, cuadrilla_id, cuadrilla, kilos)'
    + ' VALUES (?,?,?,?)');
  l.forEach((c, i) => ins.run(volcadoId, c.id, c.nombre, partes[i]));
  return l.map((c, i) => ({ cuadrilla_id: c.id, cuadrilla: c.nombre, kilos: partes[i] }));
}

// Las cuadrillas de una carga, para que la pantalla pueda mostrar las dos y volver a
// ofrecerlas al corregir. La fila madre sólo guarda la PRIMERA y el nombre pegado.
export function cuadrillasDeVolcado(db, volcadoId) {
  return db.prepare(
    ' SELECT cuadrilla_id, cuadrilla, kilos FROM gal_volcado_cuadrillas'
    + '  WHERE volcado_id = ? ORDER BY cuadrilla_id').all(volcadoId);
}

export const SANITARIOS = ['B', 'R', 'M'];
export function sanitarioDe(v) {
  const t = String(v == null ? '' : v).trim().toUpperCase().slice(0, 1);
  return SANITARIOS.indexOf(t) >= 0 ? t : null;
}

export const ORIGENES = ['manual', 'balanza', 'escaneo'];
// Lo que no está en la lista entra como manual y no se rechaza: acá nada se rechaza
// después del hecho, y unos kilos perdidos por un origen mal escrito serían
// exactamente eso.
const origenDe = (v) => (ORIGENES.indexOf(String(v || '')) >= 0 ? String(v) : 'manual');

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

  // UNA O VARIAS. En la fila madre queda la PRIMERA y el nombre de todas pegado
  // («Norte + Sur»): es la columna que leen las pantallas y los informes que no saben
  // de esto, y dejarla en null cuando hay dos haría aparecer la carga como si no
  // tuviera cuadrilla. El reparto de los kilos va en la tabla satélite, abajo.
  const qq = cuadrillasPedidas(db, dd);
  if (!qq.ok) return { ok: false, motivo: qq.motivo };
  const cuads = qq.lista;
  const cuadId = cuads.length ? cuads[0].id : null;
  const cuadNom = nombreDeCuadrillas(cuads);

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
        kilos, ifcos, viaje, sanitario, origen, observacion, estado, revision_motivo,
        usuario_id, usuario)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    txt(dd.uuid), fecha, hhmm(dd.hora), lote.id, lote.nombre, txt(dd.producto),
    cuadId, cuadNom, kg, entero(dd.ifcos), entero(dd.viaje), sanitarioDe(dd.sanitario),
    origenDe(dd.origen), txt(dd.observacion), estado, revision,
    dd.usuario_id ?? null, txt(dd.usuario),
  );

  // El uuid repetido no es un error: es la cola reintentando. Se devuelve la fila que ya
  // estaba, para que el que reintentó vea lo mismo que vería si hubiera entrado recién.
  if (!r.changes) {
    const ya = db.prepare('SELECT * FROM gal_volcados WHERE uuid = ?').get(txt(dd.uuid));
    if (ya) ya.cuadrillas = cuadrillasDeVolcado(db, ya.id);
    return { ok: true, repetido: true, id: ya ? ya.id : null, fila: ya || null, aviso: null };
  }

  const id = Number(r.lastInsertRowid);
  // El reparto se escribe DESPUÉS del INSERT porque necesita el id, y sale siempre:
  // también con una sola cuadrilla. Que la tabla satélite sea el único lugar donde se
  // lee la atribución es lo que hace que el corte por cuadrilla no tenga dos caminos.
  const reparto = guardarCuadrillas(db, id, cuads, kg);
  return {
    ok: true,
    repetido: false,
    id,
    fila: Object.assign(db.prepare('SELECT * FROM gal_volcados WHERE id = ?').get(id),
                        { cuadrillas: reparto }),
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
  /* Sólo si VINO en el pedido, igual que el resto: un PATCH de los kilos no puede
     dejar la carga sin cuadrilla. Y si vino, se reescribe el reparto entero (abajo). */
  let cuads = null;
  if ('cuadrilla_ids' in dd || 'cuadrilla_id' in dd) {
    const qq = cuadrillasPedidas(db, dd);
    if (!qq.ok) return { ok: false, motivo: qq.motivo };
    cuads = qq.lista;
    set('cuadrilla_id', cuads.length ? cuads[0].id : null);
    set('cuadrilla', nombreDeCuadrillas(cuads));
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

  /* EL REPARTO SE REHACE TAMBIÉN CUANDO SÓLO CAMBIARON LOS KILOS. Corregir 700 a 900
     sin tocar esto dejaría a cada cuadrilla con 350 y a la carga con 900: el corte por
     cuadrilla sumaría 700 y el total del día 900, y los dos números saldrían de la
     misma pantalla sin que nada avise cuál vale. */
  if (cuads !== null || 'kilos' in dd) {
    guardarCuadrillas(db, i, cuads !== null ? cuads : cuadrillasDeVolcado(db, i)
      .map((x) => ({ id: x.cuadrilla_id, nombre: x.cuadrilla })), kg);
  }
  return {
    ok: true,
    fila: Object.assign(db.prepare('SELECT * FROM gal_volcados WHERE id = ?').get(i),
                        { cuadrillas: cuadrillasDeVolcado(db, i) }),
    aviso: revision,
  };
}

// Soft delete, como en el resto del repo: un renglón de kilos borrado de verdad es un
// jornal que no se puede auditar después.
//
// ── LO DE HOY LO BORRA CUALQUIERA; LO DE AYER, NO ─────────────────────────────────
// Andy, 2/11/2026: «necesito que todos los usuarios puedan borrar algo del día vigente
// (fecha día hoy)».
//
// Un renglón tipeado hace diez segundos con un cero de más es un ERROR DE TIPEO, no una
// anulación. Pedirle nivel «anular» para eso significa que el operario va a buscar al
// dueño y, mientras tanto, el renglón mal queda cargado — que es peor que si lo hubiera
// sacado él. Y es el que está parado ahí: sabe que ese cajón no existió.
//
// Lo de días ANTERIORES sigue necesitando nivel: un día cerrado ya se usó para pagar un
// jornal y para medir un rinde, y sacarle un renglón mueve los dos para atrás.
//
// LA FECHA DE HOY ENTRA POR PARÁMETRO y no se calcula acá: la decide el SERVIDOR (ver
// hoy() en rutas/galpon.js). Tomada del navegador, adelantar el reloj del equipo del
// galpón alcanzaría para que «hoy» fuera cualquier día.
export function borrarVolcado(db, id, opts) {
  const o = opts || {};
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const fila = db.prepare(
    'SELECT id, fecha, kilos FROM gal_volcados WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!fila) return { ok: false, motivo: 'Esa carga no existe o ya se borró' };

  if (!o.puede_anular && o.hoy && fila.fecha !== o.hoy) {
    return { ok: false, status: 403,
      motivo: 'Esa carga es del ' + fila.fecha + ' y hoy es ' + o.hoy + '. Lo del día se'
           + ' borra solo; un día ya cerrado lo tiene que anular alguien con ese permiso'
           + ' — esos kilos ya se usaron para pagar el jornal y para medir el rinde.' };
  }

  const r = db.prepare(
    "UPDATE gal_volcados SET eliminado_en = datetime('now','localtime')"
    + ' WHERE id = ? AND eliminado_en IS NULL').run(i);
  if (!r.changes) return { ok: false, motivo: 'Esa carga no existe o ya se borró' };
  /* El reparto por cuadrilla NO se borra. Cuelga de la fila madre, y los cortes la
     unen con un JOIN que ya filtra eliminado_en: borrarlo sería perder a quién se le
     habían anotado esos kilos, que es justamente lo que un borrado blando conserva. */
  return { ok: true, fecha: fila.fecha };
}

// ── BORRAR VARIAS DE UNA VEZ ────────────────────────────────────────────────────────
// Andy, 2/11/2026: «quiero poder seleccionar varios para eliminar, como si tuvieran un
// casillero».
//
// Se corrige una tanda entera, no un renglón: la cuadrilla equivocada en los ochenta
// cajones de la mañana son ochenta clics y ochenta confirmaciones, y a la vigésima
// alguien deja la mitad hecha.
//
// ── O TODAS O NINGUNA ──────────────────────────────────────────────────────────────
// Primero se mira la LISTA COMPLETA y recién después se borra. Si una sola no se puede
// —es de un día cerrado, ya la borró un compañero— no se borra ninguna y se dice cuál.
//
// Un borrado a medias de una tanda es peor que ninguno: el que apretó no sabe cuáles
// quedaron y tiene que mirar renglón por renglón, que es exactamente el trabajo que
// esta pantalla venía a sacar.
//
// NO HACE FALTA UNA TRANSACCIÓN, y no es una omisión: después de validar, lo único que
// queda es un UPDATE por fila que no puede fallar. Y si entre la validación y el UPDATE
// un compañero borra una, el "AND eliminado_en IS NULL" la saltea — queda borrada una
// sola vez, que es lo que se quería. Un db.transaction() además partiría los tests en
// dos, porque node:sqlite no lo tiene.
export function borrarVolcados(db, ids, opts) {
  const o = opts || {};
  const crudos = Array.isArray(ids) ? ids : [];
  const limpios = [];
  for (const x of crudos) {
    const i = parseInt(x, 10);
    if (!Number.isFinite(i)) return { ok: false, motivo: 'Hay un id que no se entiende: "' + x + '"' };
    // Repetido es un clic de más, no un error: la segunda vez el UPDATE no haría nada.
    if (limpios.indexOf(i) < 0) limpios.push(i);
  }
  if (!limpios.length) return { ok: false, motivo: 'No vino ninguna carga para borrar' };
  /* UN TECHO, porque la lista la manda el navegador. Mil ids en un pedido son mil
     consultas antes de contestar; y nadie selecciona mil a mano. Si alguna vez hace
     falta borrar un día entero, eso es otra pantalla y otra conversación. */
  if (limpios.length > 500) {
    return { ok: false, motivo: 'Son demasiadas de una vez (' + limpios.length
             + '). Hacelo en tandas de hasta 500.' };
  }

  const buscar = db.prepare(
    'SELECT id, fecha, kilos FROM gal_volcados WHERE id = ? AND eliminado_en IS NULL');
  const filas = [];
  for (const i of limpios) {
    const f = buscar.get(i);
    if (!f) {
      return { ok: false, status: 404,
        motivo: 'La carga ' + i + ' no existe o alguien ya la borró. No se borró ninguna'
             + ' de las ' + limpios.length + ': volvé a mirar la lista.' };
    }
    if (!o.puede_anular && o.hoy && f.fecha !== o.hoy) {
      return { ok: false, status: 403,
        motivo: 'La carga ' + i + ' es del ' + f.fecha + ' y hoy es ' + o.hoy + '. No se'
             + ' borró ninguna: lo de un día ya cerrado lo tiene que anular alguien con'
             + ' ese permiso.' };
    }
    filas.push(f);
  }

  const marcar = db.prepare(
    "UPDATE gal_volcados SET eliminado_en = datetime('now','localtime')"
    + ' WHERE id = ? AND eliminado_en IS NULL');
  let borradas = 0;
  let kilos = 0;
  for (const f of filas) {
    if (marcar.run(f.id).changes) { borradas++; kilos = round2(kilos + (f.kilos || 0)); }
  }
  return { ok: true, borradas, kilos, ids: filas.map((f) => f.id) };
}

// ── LO QUE SE CARGÓ UN DÍA ──────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════════════
// 📋 LA PLANILLA DE CONTROL DE INGRESO
// ════════════════════════════════════════════════════════════════════════════════════
// Andy, 2/11/2026, con la foto del papel: «necesito que en el panel de ingreso de kilos
// pueda descargarse un exportable en PDF exactamente con esta información».
//
// Es el REGISTRO DE CONTROL EN GALPÓN DE EMPAQUE, el formulario de calidad que hoy se
// llena a mano y firman tres personas. Una fila por CAJÓN, agrupadas por viaje.
//
// EL NÚMERO DE BOLSÓN ES CORRELATIVO DENTRO DEL VIAJE, no un dato que se carga: en el
// papel arranca en 1 con cada camión y sube de a uno. Se calcula al armar la planilla
// —no se guarda— porque guardarlo obligaría a renumerar todas las filas de abajo cada
// vez que alguien borra una del medio, y esa renumeración es la que después no coincide
// con el papel que ya se firmó.
export function planillaIngreso(db, fecha) {
  const f = esFecha(fecha) || hoy();
  const filas = db.prepare(
    ' SELECT v.*, l.finca'
    + '  FROM gal_volcados v'
    + '  LEFT JOIN pa_lotes l ON l.id = v.lote_id'
    + '  WHERE v.fecha = ? AND v.eliminado_en IS NULL'
    /* Por VIAJE y después por el orden en que entraron. El que no tiene viaje va al
       final y no al principio: en SQLite NULL ordena primero, y eso pondría lo que
       todavía no se asignó arriba de los camiones que sí se registraron. */
    + '  ORDER BY CASE WHEN v.viaje IS NULL THEN 1 ELSE 0 END, v.viaje, v.id').all(f);

  const viajes = [];
  let actual = null;
  for (const v of filas) {
    const n = v.viaje == null ? null : Number(v.viaje);
    if (!actual || actual.viaje !== n) {
      actual = { viaje: n, filas: [], kilos: 0, bultos: 0 };
      viajes.push(actual);
    }
    actual.filas.push({
      n: actual.filas.length + 1,          // el correlativo del papel
      finca: v.finca || null,
      lote: v.lote_nombre || ('Lote ' + v.lote_id),
      kilos: round2(v.kilos),
      sanitario: v.sanitario || null,
      observacion: v.observacion || null,
      producto: v.producto || null,
      hora: v.hora || null,
      id: v.id,
    });
    actual.kilos = round2(actual.kilos + (v.kilos || 0));
    actual.bultos += 1;
  }

  /* El cultivo y la variedad del encabezado salen de lo que se cargó, no de un campo
     aparte: en el papel se escriben una vez arriba porque un viaje trae una sola cosa.
     Si ese día entraron dos, se listan las dos — mentir con la primera sería peor. */
  const prods = [...new Set(filas.map((v) => v.producto).filter(Boolean))];
  const vars = [...new Set([...datosDeLotes(db).values()]
    .map((x) => x && x.variedad).filter(Boolean))];

  return {
    fecha: f,
    viajes,
    cultivo: prods.join(' · '),
    variedad: vars.length === 1 ? vars[0] : '',
    total: {
      kilos: round2(filas.reduce((t, v) => t + (v.kilos || 0), 0)),
      bultos: filas.length,
      viajes: viajes.length,
    },
    // El encabezado y el pie del formulario, que son parte del documento controlado.
    version: valorConfig(db, 'plan_version', '02'),
    vigencia: valorConfig(db, 'plan_vigencia', ''),
    modifico: valorConfig(db, 'plan_modifico', ''),
    reviso: valorConfig(db, 'plan_reviso', ''),
    aprobo: valorConfig(db, 'plan_aprobo', ''),
  };
}

export function volcadosDelDia(db, fecha) {
  const f = esFecha(fecha);
  if (!f) return [];
  const filas = db.prepare(
    ' SELECT * FROM gal_volcados'
    + '  WHERE fecha = ? AND eliminado_en IS NULL'
    + '  ORDER BY id DESC').all(f);
  /* Las cuadrillas de cada carga, en UNA consulta y no una por renglón: un día de
     cosecha son trescientas cargas, y trescientas consultas se notan en la pantalla
     que el operador abre cada vez que guarda. */
  const porCarga = new Map();
  if (filas.length) {
    const ids = filas.map((x) => x.id);
    const sat = db.prepare(
      ' SELECT volcado_id, cuadrilla_id, cuadrilla, kilos'
      + '  FROM gal_volcado_cuadrillas'
      + '  WHERE volcado_id IN (' + ids.map(() => '?').join(',') + ')'
      + '  ORDER BY cuadrilla_id').all(...ids);
    for (const x of sat) {
      if (!porCarga.has(x.volcado_id)) porCarga.set(x.volcado_id, []);
      porCarga.get(x.volcado_id).push(
        { cuadrilla_id: x.cuadrilla_id, cuadrilla: x.cuadrilla, kilos: x.kilos });
    }
  }
  return filas.map((x) => Object.assign(x, { cuadrillas: porCarga.get(x.id) || [] }));
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
    /* LAS DOS, si eran dos. Proponer sólo la primera sería arrancar la tanda siguiente
       con la mitad del equipo, y el que aprieta Empezar no tiene cómo notarlo: la
       cuadrilla que aparece es una de las que estaban. */
    cuadrilla_ids: cuadrillasDeVolcado(db, fila.id).map((x) => x.cuadrilla_id),
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

  /* ── EL CORTE SALE DE LA TABLA SATÉLITE (V1133) ──────────────────────────────────
     Un cajón puede ser de dos cuadrillas, y entonces la atribución no está en la fila
     madre: está repartida. Leer cuadrilla_id de gal_volcados le daría los kilos enteros
     a la primera y cero a la segunda — y el total del día seguiría cerrando, así que
     no se notaría nunca.

     LEFT JOIN y no JOIN: una carga sin cuadrilla tiene que seguir apareciendo como
     «— sin cuadrilla —» con sus kilos. Con JOIN desaparecería del corte y el corte
     sumaría menos que el total, que es el error de siempre con la fruta sin atribuir.

     Y EL COALESCE CONTRA LA FILA MADRE NO ES UN SEGUNDO CAMINO: es el respaldo de una
     carga que no tiene ninguna fila en la satélite. Devuelve lo MISMO que el relleno
     de db_galpon.js le habría escrito —su cuadrilla, sus kilos enteros— así que los
     dos no pueden contestar distinto. Sin él, una carga que entrara por un camino que
     se olvidó de la satélite aparecería como «sin cuadrilla» conservando sus kilos, y
     eso es peor que faltar: el total del día sigue cerrando. */
  const porCuadrilla = db.prepare(
    ' SELECT COALESCE(vc.cuadrilla_id, v.cuadrilla_id) AS cuadrilla_id,'
    + "       COALESCE(vc.cuadrilla, v.cuadrilla, '— sin cuadrilla —') AS nombre,"
    + '       COUNT(*) AS cargas,'
    + '       COALESCE(SUM(COALESCE(vc.kilos, v.kilos)),0) AS kilos,'
    /* El cajón compartido cuenta MEDIO para cada una. Entero en las dos haría que la
       columna sume más cajones que los que entraron al galpón. */
    + '       COALESCE(SUM(CASE WHEN vc.cuadrilla_id IS NULL THEN v.ifcos'
    + '                         ELSE v.ifcos * 1.0 / (SELECT COUNT(*)'
    + '                           FROM gal_volcado_cuadrillas x'
    + '                          WHERE x.volcado_id = v.id) END),0) AS ifcos'
    + '  FROM gal_volcados v'
    + '  LEFT JOIN gal_volcado_cuadrillas vc ON vc.volcado_id = v.id'
    + '  WHERE v.fecha = ? AND v.eliminado_en IS NULL'
    + ' GROUP BY COALESCE(vc.cuadrilla_id, v.cuadrilla_id)'
    + ' ORDER BY SUM(COALESCE(vc.kilos, v.kilos)) DESC').all(f);

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

  const fincas = fincasDeLotes(db);
  return {
    kilos: Math.round((t.kilos || 0) * 100) / 100,
    ifcos: t.ifcos || 0,
    cargas: t.cargas || 0,
    a_revisar: t.a_revisar || 0,
    por_cuadrilla: porCuadrilla,
    por_lote: porLote.map((l) => Object.assign(l, {
      finca: fincas.get(l.lote_id) || null })),
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

  /* El corte por cuadrilla no usa corte(): sale de la tabla satélite, por lo mismo que
     en resumenDelDia. Un cajón de dos cuadrillas tiene su atribución repartida ahí, y
     leerlo de la fila madre le daría los kilos enteros a una sola. */
  const porCuadrilla = conPct(db.prepare(
    ' SELECT COALESCE(vc.cuadrilla_id, v.cuadrilla_id) AS gid,'
    + "       COALESCE(vc.cuadrilla, v.cuadrilla, '— sin cuadrilla —') AS nombre,"
    + '       COUNT(*) AS cargas,'
    + '       COUNT(DISTINCT v.fecha) AS dias,'
    + '       COALESCE(SUM(COALESCE(vc.kilos, v.kilos)),0) AS kilos,'
    + '       COALESCE(SUM(CASE WHEN vc.cuadrilla_id IS NULL THEN v.ifcos'
    + '                         ELSE v.ifcos * 1.0 / (SELECT COUNT(*)'
    + '                           FROM gal_volcado_cuadrillas x'
    + '                          WHERE x.volcado_id = v.id) END),0) AS ifcos'
    + '  FROM gal_volcados v'
    + '  LEFT JOIN gal_volcado_cuadrillas vc ON vc.volcado_id = v.id'
    + '  WHERE v.fecha >= ? AND v.fecha <= ? AND v.eliminado_en IS NULL'
    + ' GROUP BY COALESCE(vc.cuadrilla_id, v.cuadrilla_id)'
    + ' ORDER BY SUM(COALESCE(vc.kilos, v.kilos)) DESC').all(d, h));
  const fincas = fincasDeLotes(db);
  const porLote = conPct(corte('lote_id', "lote_nombre, 'Lote ' || lote_id",
    // GROUP_CONCAT y no `producto` pelado: una columna suelta adentro de un GROUP BY la
    // elige SQLite de una fila cualquiera del grupo. Un lote del que salieron damasco y
    // ciruela mostraría uno solo de los dos, al azar y sin avisar.
    'GROUP_CONCAT(DISTINCT producto) AS producto'))
    .map((l) => Object.assign(l, { finca: fincas.get(l.gid) || null }));
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
    // EL RINDE. Andy, 31/10/2026: «en lo que ya armaste de acumulado quiero ir viendo
    // rindes y todo». Es la pregunta de la temporada: de lo que entró de cada lote,
    // cuánto salió vendible. Vive acá y no en una pantalla aparte porque es el mismo
    // período y los mismos lotes que ya se están mirando.
    rinde: rindePorLote(db, d, h),
    // Lo que alimenta los dos gráficos de arriba: kilos por día y ritmo del galpón.
    // Lo que encabeza el acumulado: cómo rindió la fruta, toda junta.
    proceso_total: procesoTotal(db, d, h),
    por_dia_proceso: procesoPorDia(db, d, h),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════
// 📦 EL PROCESO: QUÉ SALIÓ DE LO QUE ENTRÓ
// ════════════════════════════════════════════════════════════════════════════════════
// Andy, 31/10/2026: «quiero un lugar para cargar el proceso... por ejemplo 100 cajas
// cartón x 10 cubetas de 700 gramos cada una».
//
// gal_volcados tiene lo que ENTRÓ al galpón. gal_procesos tiene lo que SALIÓ. Las dos
// juntas son el rinde, que es la pregunta que se le hace a una finca.

// TRES DESTINOS, Y NO SON ETIQUETAS. Cada uno tiene un futuro distinto: lo comercial se
// vende, lo verde vuelve a la tolva más adelante, el descarte se remata o se tira. Texto
// libre serían cuarenta maneras de escribir "segunda" y ningún informe posible — la misma
// razón por la que servicios/asientos.js tiene MOTIVOS y no un campo abierto.
export const DESTINOS = [
  { clave: 'comercial', label: 'Comercial', color: '#16a34a',
    nota: 'Lo que se vende. En cubetas o a granel.' },
  { clave: 'verde', label: 'Verde', color: '#d97706',
    nota: 'Se guarda para volver a procesarlo más adelante.' },
  { clave: 'descarte', label: 'Descarte', color: '#dc2626',
    nota: 'Se guarda también; después se remata o se tira.' },
];
const esDestino = (v) => DESTINOS.some((d) => d.clave === v);

// ── LO QUE EL TARJETÓN NECESITA DE CADA LOTE ────────────────────────────────────────
// Andy, 1/11/2026: «RENSPA los voy a cargar en los lotes» y «variedad del damasco es
// siempre Castle Brite».
//
// Vive en una tabla satélite y no en pa_lotes: esa tabla la mantiene Producción, y una
// columna del galpón ahí la hace nuestra para siempre (misma regla que las tarjetas de
// las cuadrillas).
export function datosDeLotes(db) {
  const m = new Map();
  for (const d of db.prepare('SELECT * FROM gal_lote_datos').all()) m.set(d.lote_id, d);
  return m;
}

// La lista para la pantalla de Configuración: TODOS los lotes activos con lo que
// tengan cargado. Mostrar sólo los que ya tienen datos sería esconder justamente los
// que faltan — que son los que hay que completar.
export function lotesConDatos(db) {
  const d = datosDeLotes(db);
  return lotesParaElDia(db).map((l) => {
    const x = d.get(l.id) || {};
    return Object.assign({}, l, {
      renspa: x.renspa || null,
      variedad: x.variedad || null,
      cuartel: x.cuartel || null,
      notas: x.notas || null,
    });
  });
}

export function guardarDatosDeLote(db, d) {
  const dd = d || {};
  const id = parseInt(dd.lote_id, 10);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, motivo: 'Elegí el lote' };
  if (!db.prepare('SELECT 1 FROM pa_lotes WHERE id = ?').get(id)) {
    return { ok: false, motivo: 'Ese lote no existe' };
  }
  db.prepare(
    ' INSERT INTO gal_lote_datos (lote_id, renspa, variedad, cuartel, notas)'
    + ' VALUES (?,?,?,?,?)'
    + ' ON CONFLICT(lote_id) DO UPDATE SET renspa = excluded.renspa,'
    + '   variedad = excluded.variedad, cuartel = excluded.cuartel,'
    + "   notas = excluded.notas, actualizado = datetime('now','localtime')")
    .run(id, txt(dd.renspa), txt(dd.variedad), txt(dd.cuartel), txt(dd.notas));
  return { ok: true, lote_id: id };
}

/* Copiar la variedad a todos los lotes del mismo cultivo. Andy, 1/11/2026: «la variedad
   del damasco es siempre Castle Brite» — cargarla lote por lote en veinte cuadros es
   veinte oportunidades de escribirla distinto, y «Castle Brite» y «Castle brite» son dos
   variedades para cualquier informe. */
export function variedadATodos(db, cultivo, variedad) {
  const c = txt(cultivo), v = txt(variedad);
  if (!c || !v) return { ok: false, motivo: 'Falta el cultivo o la variedad' };
  const lotes = lotesParaElDia(db).filter((l) => l.cultivo === c);
  if (!lotes.length) return { ok: false, motivo: 'No hay lotes con el cultivo ' + c };
  for (const l of lotes) {
    const ya = db.prepare('SELECT * FROM gal_lote_datos WHERE lote_id = ?').get(l.id) || {};
    guardarDatosDeLote(db, {
      lote_id: l.id, variedad: v,
      // Lo demás se conserva: esto copia LA VARIEDAD, no pisa el RENSPA de cada lote,
      // que es distinto en cada uno y es el dato más caro de volver a cargar.
      renspa: ya.renspa, cuartel: ya.cuartel, notas: ya.notas,
    });
  }
  // Se llama lotes_tocados y no lotes porque el router devuelve la LISTA de lotes con
  // ese segundo nombre, y una de las dos pisaba a la otra sin que nada avisara.
  return { ok: true, lotes_tocados: lotes.length };
}

// ── EL CATÁLOGO ─────────────────────────────────────────────────────────────────────
export function presentaciones(db, opts) {
  const o = opts || {};
  let sql = ' SELECT * FROM gal_presentaciones WHERE eliminado_en IS NULL';
  if (!o.todas) sql += ' AND activo = 1';
  // sinRutaDeIcono: la ruta del archivo no sale en ningún JSON, ver arriba.
  return sinRutaDeIcono(db.prepare(sql + ' ORDER BY destino, orden, id').all());
}


// ════════════════════════════════════════════════════════════════════════════════════
// 🖼️ EL DIBUJO PROPIO DE UNA PRESENTACIÓN
// ════════════════════════════════════════════════════════════════════════════════════
// Andy, 1/11/2026: «quiero yo poder subirle algún dibujito desde la computadora, ya
// estuve armando unos emoticones».
//
// LA PANTALLA LO ACHICA ANTES DE MANDARLO, a 96 × 96 PNG con un <canvas>. Por eso acá
// no hay multer ni una librería de imágenes: lo que llega es un data URL de unos pocos
// kilobytes y entra por el express.json que ya existe. Un archivo de la cámara de un
// teléfono son 4 MB que viajan para mostrarse a 24 píxeles.
//
// PERO LO QUE LLEGA SE VALIDA IGUAL. Que la pantalla achique no es garantía de nada: el
// endpoint se puede llamar con curl, y la pantalla de mañana puede tener un bug. Se
// verifica que sea PNG DE VERDAD —los magic bytes, no lo que diga el encabezado del
// data URL—, el tamaño en bytes y las dimensiones, que se leen del propio header del
// PNG sin descomprimir nada.

// Los ocho bytes con los que arranca todo PNG. El 0x89 inicial y el \r\n del medio
// están justamente para que un archivo corrupto o convertido a texto se note.
const PNG_FIRMA = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const ICONO_MAX_BYTES = 400 * 1024;
export const ICONO_MAX_LADO = 256;

// Las dimensiones salen del chunk IHDR, que por norma es el primero y está siempre en
// la misma posición: 16..19 el ancho y 20..23 el alto, big-endian.
export function medidaPNG(buf) {
  if (!buf || buf.length < 24) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_FIRMA[i]) return null;
  if (String(buf.slice(12, 16)) !== 'IHDR') return null;
  return { ancho: buf.readUInt32BE(16), alto: buf.readUInt32BE(20) };
}

// Devuelve el Buffer, o el motivo por el que no se puede guardar. NO tira: es el patrón
// del módulo, aunque acá sí se rechaza (ver abajo).
export function iconoDesdeDataUrl(v) {
  const t = txt(v);
  if (!t) return { ok: false, motivo: 'No llegó ninguna imagen' };
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(t);
  /* Sólo PNG, y en particular NO SVG. Un SVG es un documento: puede traer un <script>
     adentro, y servido desde el mismo origen que el panel ese script corre con la
     sesión de quien lo abra. El que quiera subir un SVG lo exporta a PNG. */
  if (!m) return { ok: false, motivo: 'La imagen tiene que ser un PNG' };

  let buf;
  try { buf = Buffer.from(m[1], 'base64'); } catch (e) {
    return { ok: false, motivo: 'No se pudo leer la imagen' };
  }
  if (buf.length > ICONO_MAX_BYTES) {
    return { ok: false, motivo: 'La imagen pesa ' + Math.round(buf.length / 1024)
      + ' KB y el máximo son ' + Math.round(ICONO_MAX_BYTES / 1024) + ' KB' };
  }
  /* Los magic bytes y no el encabezado del data URL: "data:image/png" lo escribe quien
     manda el pedido y no prueba nada sobre el contenido. */
  const med = medidaPNG(buf);
  if (!med) return { ok: false, motivo: 'Eso no es un PNG' };
  if (med.ancho > ICONO_MAX_LADO || med.alto > ICONO_MAX_LADO) {
    return { ok: false, motivo: 'La imagen es de ' + med.ancho + '×' + med.alto
      + ' y el máximo son ' + ICONO_MAX_LADO + '×' + ICONO_MAX_LADO };
  }
  if (!med.ancho || !med.alto) return { ok: false, motivo: 'Esa imagen está vacía' };
  return { ok: true, buf, medida: med };
}

/* ACÁ SÍ SE RECHAZA, y no es una excepción a «nada se rechaza después del hecho»: no
   pasó nada todavía. La fruta no está en la tolva — esto es configuración, igual que
   dos rangos de tarjetas que se pisan. Guardar un archivo que no es una imagen deja la
   pantalla con un cuadradito roto que nadie sabe cómo sacar.

   fs y path entran por parámetro para que el servicio siga probándose sin tocar el
   disco, que es como está hecho el resto del módulo. */
export function guardarIcono(db, id, dataUrl, io) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const p = db.prepare(
    'SELECT * FROM gal_presentaciones WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!p) return { ok: false, motivo: 'Esa presentación no existe' };

  const r = iconoDesdeDataUrl(dataUrl);
  if (!r.ok) return r;

  /* El nombre lo pone el servidor y sale del ID, no de lo que mande el cliente: un
     nombre de archivo que viene de afuera es por donde entra un "../.." y se escribe
     en cualquier lado. */
  const nombre = 'pres-' + i + '.png';
  const w = io.escribir(nombre, r.buf);
  if (!w || !w.ok) return { ok: false, motivo: (w && w.motivo) || 'No se pudo guardar' };

  const v = crypto.createHash('sha1').update(r.buf).digest('hex').slice(0, 12);
  db.prepare('UPDATE gal_presentaciones SET icono = ?, icono_v = ? WHERE id = ?')
    .run(w.ruta, v, i);
  return { ok: true, id: i, icono_v: v, medida: r.medida, bytes: r.buf.length };
}

export function borrarIcono(db, id, io) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const p = db.prepare(
    'SELECT icono FROM gal_presentaciones WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!p) return { ok: false, motivo: 'Esa presentación no existe' };
  /* El archivo se borra DESPUÉS de soltar la referencia en la base: al revés, si el
     borrado del archivo falla la fila queda apuntando a algo que ya no está. */
  db.prepare('UPDATE gal_presentaciones SET icono = NULL, icono_v = NULL WHERE id = ?')
    .run(i);
  if (p.icono && io && io.borrar) { try { io.borrar(p.icono); } catch (e) { /* ya está */ } }
  return { ok: true, id: i };
}

// La ruta del archivo, para servirlo. Es lo ÚNICO que la devuelve, y no es una ruta de
// la API: la usa el handler que ya pasó por requireAuth.
export function rutaDelIcono(db, id) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return null;
  const p = db.prepare(
    'SELECT icono FROM gal_presentaciones WHERE id = ? AND eliminado_en IS NULL').get(i);
  return (p && p.icono) || null;
}

/* LA RUTA NO SALE EN NINGÚN JSON. Las presentaciones se leen con SELECT *, así que la
   columna viaja sola si nadie la saca: se saca acá, en un solo lugar, y todo lo que
   devuelva presentaciones pasa por esta función. Lo que queda es icono_v, que dice si
   hay dibujo y además sirve de cache-buster. Misma regla que tarjeta_path en los
   contactos — ahí hay que hacerlo en DOS lugares porque hay dos SELECT *, y esa es
   justamente la razón de que acá haya uno solo. */
export function sinRutaDeIcono(filas) {
  const limpiar = (f) => {
    if (!f || typeof f !== 'object') return f;
    const o = Object.assign({}, f);
    o.tiene_icono = o.icono ? 1 : 0;
    delete o.icono;
    return o;
  };
  return Array.isArray(filas) ? filas.map(limpiar) : limpiar(filas);
}

export function guardarPresentacion(db, d) {
  const dd = d || {};
  const nombre = txt(dd.nombre);
  if (!nombre) return { ok: false, motivo: 'Poné un nombre para la presentación' };
  if (!esDestino(dd.destino)) {
    return { ok: false, motivo: 'El destino tiene que ser comercial, verde o descarte' };
  }
  const granel = dd.granel ? 1 : 0;
  // A granel la cuenta no existe: se tipean los kilos. Dejar un por_bulto distinto de 1
  // en una presentación a granel sería un multiplicador fantasma que no se ve en ninguna
  // pantalla y aparece en el total.
  const porBulto = granel ? 1 : numPos(dd.por_bulto);
  // TRES decimales: una cubeta de 615 g son 0,615 kg, y dos decimales la dejan en
  // 0,62 — cinco gramos por cubeta, que multiplicados por todas las cargas que usen
  // esta presentación son decenas de kilos inventados.
  const kgUnidad = granel ? 1 : numPos(dd.kg_unidad, 3);
  if (!granel && (porBulto == null || kgUnidad == null)) {
    return { ok: false, motivo: 'Las unidades por bulto y el peso de cada una tienen que '
      + 'ser números mayores que cero' };
  }

  /* CAT I de fábrica: «siempre CAT 1 a menos que modifiquemos». Y el calibre puede
     faltar —el verde y el descarte no se calibran— pero en lo comercial es parte del
     artículo y va impreso en el tarjetón. */
  const categoria = txt(dd.categoria) || 'I';
  const calibre = txt(dd.calibre);
  /* UN SOLO carácter visible. Pegar «📦📦📦» o una palabra entera rompe el alto de la
     baldosa y la fila deja de alinearse con las de al lado; y un emoji compuesto
     —una bandera, una familia— son varios code points, así que no se cuenta con
     .length sino con el segmentador del idioma. */
  const emoji = primerEmoji(dd.emoji);
  const campos = [nombre, dd.destino, txt(dd.envase), porBulto, kgUnidad, granel,
                  categoria, calibre, emoji,
                  txt(dd.color), Number.isFinite(Number(dd.orden)) ? Number(dd.orden) : 100,
                  dd.activo === 0 || dd.activo === false ? 0 : 1];
  const id = parseInt(dd.id, 10);
  if (Number.isFinite(id) && id > 0) {
    const r = db.prepare(
      ' UPDATE gal_presentaciones SET nombre=?, destino=?, envase=?, por_bulto=?,'
      + ' kg_unidad=?, granel=?, categoria=?, calibre=?, emoji=?, color=?, orden=?,'
      + ' activo=?'
      + ' WHERE id = ? AND eliminado_en IS NULL').run(...campos, id);
    if (!r.changes) return { ok: false, motivo: 'Esa presentación no existe' };
    return { ok: true, id };
  }
  const r = db.prepare(
    ' INSERT INTO gal_presentaciones (nombre,destino,envase,por_bulto,kg_unidad,granel,'
    + ' categoria,calibre,emoji,color,orden,activo)'
    + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(...campos);
  return { ok: true, id: Number(r.lastInsertRowid) };
}

// Borrado blando, y a propósito: los procesos ya cargados guardan el NOMBRE de la
// presentación, no sólo su id. Borrarla de verdad no rompería nada de lo viejo, pero
// tampoco dejaría volver atrás de un borrado con la mano.
export function borrarPresentacion(db, id) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const r = db.prepare(
    "UPDATE gal_presentaciones SET eliminado_en = datetime('now','localtime')"
    + ' WHERE id = ? AND eliminado_en IS NULL').run(i);
  if (!r.changes) return { ok: false, motivo: 'Esa presentación no existe o ya se borró' };
  return { ok: true };
}

// ── LA CUENTA ───────────────────────────────────────────────────────────────────────
// bultos × unidades por bulto × peso de cada unidad. La hace el SERVIDOR, siempre: el
// rinde de la temporada es exactamente este número, y un total que llega calculado por
// el navegador es un total que nadie volvió a mirar.
export function kilosDeProceso(bultos, porBulto, kgUnidad) {
  const b = Number(bultos), p = Number(porBulto), k = Number(kgUnidad);
  if (!Number.isFinite(b) || !Number.isFinite(p) || !Number.isFinite(k)) return null;
  if (b <= 0 || p <= 0 || k <= 0) return null;
  return round2(b * p * k);
}

const numPos = (v, dec) => {
  const n = kilos(v, dec);
  return n != null && n > 0 ? n : null;
};

// ── REPARTIR UNA CARGA ENTRE VARIOS LOTES ───────────────────────────────────────────
// Andy, 31/10/2026: «me tiene que dejar mezclar entre los lotes porque no siempre
// tenemos bien en claro de qué lote es cada uno. Es decir es todo Damasco».
//
// A PRORRATA DE LO QUE LE QUEDA EN LA TOLVA A CADA UNO. Es la mejor aproximación que
// hay: si del Cuadro 3 quedan 3.000 kg sin procesar y del Cuadro 4 quedan 1.000, lo que
// sale ahora es 75% y 25%. No es una medición y el sistema no finge que lo sea — las
// filas quedan marcadas `repartido`.
//
// Partes iguales SÓLO cuando no hay de dónde prorratear (ninguno tiene pendiente, o ya
// se procesó de más en todos). Prorratear sobre números negativos daría pesos negativos
// y un lote llevándose kilos de otro.
export function pesosDelReparto(pendientes) {
  const n = pendientes.length;
  if (!n) return [];
  const positivos = pendientes.map((x) => (Number(x) > 0 ? Number(x) : 0));
  const total = positivos.reduce((t, x) => t + x, 0);
  if (total <= 0) return pendientes.map(() => 1 / n);
  return positivos.map((x) => x / total);
}

// EL ÚLTIMO SE QUEDA CON EL RESTO. Repartir 700 en tres y redondear cada parte da
// 699,99 o 700,01: el total deja de coincidir con lo que se cargó, y la diferencia
// aparece como kilos que nadie procesó. Se reparten n-1 redondeados y el último es la
// resta, así la suma cierra exacta siempre.
export function repartir(total, pesos) {
  const t = round2(total);
  const partes = [];
  let usado = 0;
  for (let i = 0; i < pesos.length - 1; i++) {
    const x = round2(t * pesos[i]);
    partes.push(x);
    usado = round2(usado + x);
  }
  partes.push(round2(t - usado));
  return partes;
}
// ── CARGAR UN PROCESO ───────────────────────────────────────────────────────────────
export function registrarProceso(db, d) {
  const dd = d || {};
  const fecha = esFecha(dd.fecha);
  if (!fecha) return { ok: false, motivo: 'La fecha tiene que ser YYYY-MM-DD' };
  /* UNO O VARIOS. `lote_ids` es la mezcla; `lote_id` sigue andando igual y es lo que
     manda la pantalla cuando hay uno solo elegido. */
  const crudos = Array.isArray(dd.lote_ids) && dd.lote_ids.length ? dd.lote_ids
    : [dd.lote_id];
  const lotes = [];
  for (const x of crudos) {
    const n = parseInt(x, 10);
    if (Number.isFinite(n) && n > 0 && lotes.indexOf(n) < 0) lotes.push(n);
  }
  if (!lotes.length) return { ok: false, motivo: 'Elegí el lote del que salió esto' };
  const loteId = lotes[0];

  // La presentación manda: de ahí salen el destino y los dos multiplicadores. Tomarlos
  // del cuerpo del pedido dejaría que una caja de 700 g entre con el peso de un bin.
  let pres = null;
  const presId = parseInt(dd.presentacion_id, 10);
  if (Number.isFinite(presId) && presId > 0) {
    pres = db.prepare('SELECT * FROM gal_presentaciones WHERE id = ? AND eliminado_en IS NULL')
             .get(presId);
    if (!pres) return { ok: false, motivo: 'Esa presentación no existe' };
  }
  const destino = pres ? pres.destino : dd.destino;
  if (!esDestino(destino)) {
    return { ok: false, motivo: 'Elegí si es comercial, verde o descarte' };
  }

  let bultos = null, porBulto = null, kgUnidad = null, kg = null;
  if (pres && !pres.granel) {
    bultos = numPos(dd.bultos);
    if (bultos == null) return { ok: false, motivo: 'Poné cuántos bultos entraron' };
    porBulto = pres.por_bulto;
    kgUnidad = pres.kg_unidad;
    kg = kilosDeProceso(bultos, porBulto, kgUnidad);
    if (kg == null) return { ok: false, motivo: 'La presentación tiene mal la cuenta: '
      + 'revisá las unidades por bulto y el peso de cada una en Configuración' };
  } else {
    // A granel: los kilos se tipean, y no hay bultos que multipliquen.
    kg = numPos(dd.kilos);
    if (kg == null) return { ok: false, motivo: 'Poné los kilos' };
  }

  // EL TECHO. No rechaza — lo que ya se embaló, se embaló, y un techo que frena la carga
  // es un techo que alguien esquiva partiendo el renglón en dos. Marca y entra.
  let estado = 'ok', motivo = null;
  const techo = config(db).kg_max_proceso;
  if (Number.isFinite(techo) && techo > 0 && kg > techo) {
    estado = 'a_revisar';
    motivo = 'Son ' + kg + ' kg en una sola carga, más que el tope de ' + techo + '. '
      + 'Si la presentación está en gramos donde van kilos, la cuenta se va por mil.';
  }

  // Los nombres se congelan desde la BASE, no desde lo que mandó la pantalla: dos
  // pantallas con distinta versión del padrón escribirían dos nombres para el mismo
  // lote y el informe por lote los contaría separados.
  const nombres = [], productos = [];
  for (const id of lotes) {
    const l = db.prepare(
      ' SELECT l.nombre, cl.cultivo'
      + '  FROM pa_lotes l'
      + '  LEFT JOIN pa_cultivos_lote cl ON cl.id = ('
      + '        SELECT c2.id FROM pa_cultivos_lote c2 WHERE c2.lote_id = l.id'
      + '         ORDER BY c2.es_perenne DESC, c2.campaña DESC LIMIT 1)'
      + ' WHERE l.id = ?').get(id);
    if (!l) return { ok: false, motivo: 'El lote ' + id + ' no existe' };
    nombres.push(l.nombre);
    /* El cultivo del lote, con el mismo criterio que usa la ventana de carga: se
       prefiere el PERENNE, porque un frutal no cambia de fruta de campaña en
       campaña y hay dos campañas abiertas a la vez. Lo que manda la pantalla queda
       como respaldo para un lote sin cultivo cargado. */
    productos.push(txt(l.cultivo) || txt(dd.producto));
  }

  /* LOS DATOS SANITARIOS, congelados al cargar. El RENSPA y la variedad van IMPRESOS
     en el tarjetón: lo que se imprimió es lo que viajó, y corregirlos el mes que viene
     no cambia la etiqueta que se fue en el camión. */
  const datosLote = datosDeLotes(db);

  /* EL REPARTO, a prorrata de lo que le queda en la tolva a cada uno. Con un lote solo
     esto es [1] y no cambia nada de lo que había. */
  const esMezcla = lotes.length > 1;
  const pend = lotes.map((id) => {
    const v = db.prepare(
      ' SELECT COALESCE(SUM(kilos),0) AS k FROM gal_volcados'
      + '  WHERE lote_id = ? AND eliminado_en IS NULL').get(id).k || 0;
    const pr = db.prepare(
      " SELECT COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos ELSE -kilos END),0) AS k"
      + '  FROM gal_procesos WHERE lote_id = ? AND eliminado_en IS NULL').get(id).k || 0;
    return v - pr;
  });
  const pesos = pesosDelReparto(pend);
  const kilosPorLote = repartir(kg, pesos);
  const bultosPorLote = bultos == null ? lotes.map(() => null) : repartir(bultos, pesos);
  const grupo = esMezcla ? (txt(dd.uuid) || String(Date.now()) + Math.random()) : null;

  const ins = db.prepare(
    ' INSERT OR IGNORE INTO gal_procesos (uuid,fecha,lote_id,lote_nombre,producto,destino,'
    + ' presentacion_id,presentacion,envase,bultos,por_bulto,kg_unidad,kilos,tipo,'
    + ' categoria,calibre,variedad,renspa,cuartel,'
    + ' pallet_id,'
    + ' reparto,repartido,observacion,estado,revision_motivo,usuario_id,usuario)'
    + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'ingreso',?,?,?,?,?,?,?,?,?,?,?,?,?)");

  /* EL DOBLE CLIC, Y SE MIRA ANTES DE ABRIR EL PALLET. Si el primer uuid ya está, la
     carga entró entera y no se hace nada: el INSERT OR IGNORE de abajo protege la
     carrera, pero mirar primero es lo que deja contestar «ya estaba» en vez de «no se
     pudo guardar».

     EL ORDEN NO ERA INDIFERENTE Y AHORA MENOS. Hasta la V1140 esto venía DESPUÉS de
     abrirPallet(), y daba igual: con el pallet abierto, abrirPallet() devuelve el que
     hay. Desde que la misma llamada puede CERRARLO, el segundo clic de un doble clic
     llega con el pallet ya cerrado y abriría uno nuevo —vacío y sin número— para una
     carga que no va a insertar. Un pallet fantasma abierto en el playón se lleva la
     primera caja de la mañana siguiente y nadie sabe de dónde salió. */
  const u0 = txt(dd.uuid) ? (esMezcla ? dd.uuid + '#' + lotes[0] : dd.uuid) : null;
  if (u0) {
    const ya = db.prepare('SELECT * FROM gal_procesos WHERE uuid = ?').get(u0);
    if (ya) {
      /* Y si pidió cerrar, el primer clic ya cerró: se contesta con el pallet de la
         fila que YA está para que la pantalla vuelva a ofrecer el tarjetón. Contestar
         sólo «repetido» dejaría al operador que apretó «cargar y cerrar» sin número y
         sin saber si cerró. */
      const pal = dd.cerrar_pallet && ya.pallet_id ? palletResumen(db, ya.pallet_id) : null;
      return { ok: true, id: ya.id, ids: [ya.id], fila: ya, repetido: true,
               pallet_cerrado: pal && pal.estado === 'cerrado' ? pal : null };
    }
  }

  /* AL PALLET ABIERTO. Si no hay ninguno se abre uno solo: pedirle al operador que
     abra el pallet antes de la primera caja es un paso que se va a saltear, y la caja
     quedaría suelta sin que nada avise. */
  const palletId = dd.sin_pallet ? null : abrirPallet(db, { fecha_empaque: fecha,
    usuario_id: dd.usuario_id, usuario: dd.usuario }).id;

  const ids = [];
  for (let i = 0; i < lotes.length; i++) {
    /* El uuid es UNICO, así que las filas de un reparto no pueden compartirlo: lleva
       sufijo. La idempotencia sigue valiendo igual —el mismo doble clic manda los
       mismos n uuids— y el grupo se reconoce por `reparto`. */
    const u = txt(dd.uuid) ? (esMezcla ? dd.uuid + '#' + lotes[i] : dd.uuid) : null;
    const r = ins.run(
      u, fecha, lotes[i], nombres[i], productos[i], destino,
      pres ? pres.id : null, pres ? pres.nombre : null,
      pres ? pres.envase : txt(dd.envase),
      bultosPorLote[i], porBulto, kgUnidad, kilosPorLote[i],
      pres ? pres.categoria : null, pres ? pres.calibre : null,
      (datosLote.get(lotes[i]) || {}).variedad || null,
      (datosLote.get(lotes[i]) || {}).renspa || null,
      (datosLote.get(lotes[i]) || {}).cuartel || null,
      palletId,
      grupo, esMezcla ? 1 : 0,
      txt(dd.observacion), estado, motivo, dd.usuario_id || null, txt(dd.usuario));
    if (r.changes) ids.push(Number(r.lastInsertRowid));
    else if (u) {
      const ya = db.prepare('SELECT id FROM gal_procesos WHERE uuid = ?').get(u);
      if (ya) ids.push(ya.id);
    }
  }
  if (!ids.length) return { ok: false, motivo: 'No se pudo guardar' };

  /* ── CARGAR Y CERRAR, EN UN SOLO VIAJE ─────────────────────────────────────────
     Andy, 4/11/2026: «tiene que existir la forma en el proceso de directamente cerrar
     pallet, es decir no procesar y después cerrar el pallet. Hacerlo juntos».

     Un pallet que se completa con una sola carga —sesenta cajas del mismo calibre— son
     DOS gestos para UN hecho físico: tipear las cajas abajo y después subir a la
     tarjeta del pallet a cerrarlo. El segundo es el que se saltea, y un pallet sin
     cerrar se lleva adentro la primera caja del siguiente.

     Y VA EN LA MISMA LLAMADA, no en dos seguidas desde la pantalla. Con dos, si la
     segunda no llega —el wifi del galpón, que es lo que pasa— el operador se va
     convencido de que cerró: el pallet queda abierto, la caja siguiente le cae adentro
     y la etiqueta que se imprima después dice otra cosa que lo que hay arriba de la
     madera. Una sola decisión y un solo «no se pudo».

     SI EL CIERRE FALLA, LA CARGA QUEDA. Ya pasó —la fruta ya está en la tolva
     (CLAUDE.md)— y se contesta ok con el motivo: el pallet sigue abierto, donde se ve. */
  let cerrado = null, cierreMotivo = null;
  if (dd.cerrar_pallet) {
    if (!palletId) {
      cierreMotivo = 'La carga no fue a ningún pallet, así que no hay nada que cerrar.';
    } else {
      const c = cerrarPallet(db, palletId, { parcial: dd.parcial });
      if (!c.ok) cierreMotivo = c.motivo;
      else {
        cerrado = Object.assign(palletResumen(db, palletId) || {}, {
          articulos: (c.contenido || []).length,
          parcial: dd.parcial ? 1 : 0,
        });
      }
    }
  }

  return {
    ok: true, id: ids[0], ids,
    fila: db.prepare('SELECT * FROM gal_procesos WHERE id = ?').get(ids[0]),
    reparto: esMezcla ? { grupo, lotes, nombres, kilos: kilosPorLote,
                          pct: pesos.map((x) => Math.round(x * 1000) / 10) } : null,
    aviso: motivo,
    pallet_cerrado: cerrado,
    cierre_motivo: cierreMotivo,
  };
}

// Sólo lo que VINO. Un PATCH que pise con null lo que no mandaron convierte corregir los
// bultos en borrar la observación y el lote.
export function editarProceso(db, id, d) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const fila = db.prepare('SELECT * FROM gal_procesos WHERE id = ? AND eliminado_en IS NULL')
                 .get(i);
  if (!fila) return { ok: false, motivo: 'Ese proceso no existe o ya se borró' };
  const dd = d || {};

  /* ── UNA CARGA SE CORRIGE ENTERA ──────────────────────────────────────────────
     Andy, 4/11/2026: «no lo abras por LOTE... sólo me interesa cómo viene el
     proceso».

     Desde que la pantalla muestra una fila por CARGA, corregir un pedazo sería
     peor que antes: el operador ve 90 kg, aprieta el lápiz y le cambia los kilos
     a los 3,33 de uno de los tres lotes. Lo que ve y lo que toca tienen que ser
     la misma cosa.

     Con un lote solo el grupo es de uno y nada de esto cambia. */
  const grupo = fila.reparto
    ? db.prepare('SELECT * FROM gal_procesos WHERE reparto = ? AND eliminado_en IS NULL'
        + ' ORDER BY id').all(fila.reparto)
    : [fila];
  const esGrupo = grupo.length > 1;

  const sets = [], val = [];
  const poner = (col, v) => { sets.push(col + ' = ?'); val.push(v); };

  if ('observacion' in dd) poner('observacion', txt(dd.observacion));
  if ('fecha' in dd) {
    const f = esFecha(dd.fecha);
    if (!f) return { ok: false, motivo: 'La fecha no se entiende' };
    poner('fecha', f);
  }

  /* EL LOTE. Es la corrección que más se va a usar: la tolva mezcla y recién al rato
     se sabe de dónde era. El nombre se vuelve a congelar desde la base, igual que al
     cargar — creerle el que manda la pantalla escribiría dos nombres para el mismo
     lote y el rinde los contaría separados. */
  if ('lote_id' in dd) {
    /* EN UNA MEZCLA, NO. Cambiar «el lote» de una carga repartida entre tres no
       quiere decir nada: o se la manda entera a uno —y entonces el reparto que la
       prorrateó deja de tener sentido— o hay que elegir cuál de los tres se mueve,
       que es volver a abrir la carga por lote. Se borra y se carga de nuevo, que es
       lo que la ventana ya recomendaba. */
    if (esGrupo) {
      return { ok: false, motivo: 'Esta carga se repartió entre ' + grupo.length
        + ' lotes, así que no se le puede cambiar el lote desde acá. Borrala —se van'
        + ' las ' + grupo.length + ' juntas— y cargala de nuevo con los lotes que van.' };
    }
    const l = parseInt(dd.lote_id, 10);
    if (!Number.isFinite(l) || l <= 0) return { ok: false, motivo: 'Elegí el lote' };
    const lote = db.prepare(
      ' SELECT l.nombre, cl.cultivo'
      + '  FROM pa_lotes l'
      + '  LEFT JOIN pa_cultivos_lote cl ON cl.id = ('
      + '        SELECT c2.id FROM pa_cultivos_lote c2 WHERE c2.lote_id = l.id'
      + '         ORDER BY c2.es_perenne DESC, c2.campaña DESC LIMIT 1)'
      + ' WHERE l.id = ?').get(l);
    if (!lote) return { ok: false, motivo: 'Ese lote no existe' };
    poner('lote_id', l);
    poner('lote_nombre', lote.nombre);
    /* El producto VA CON EL LOTE. Mover una carga de un cuadro de damasco a uno de
       uva y dejarla diciendo «damasco» es exactamente la mezcla que esto viene a
       evitar. Si el lote nuevo no tiene cultivo cargado, se deja el que tenía. */
    if (txt(lote.cultivo)) poner('producto', txt(lote.cultivo));
    /* Y los datos sanitarios también: son del lote, y una carga movida a otro cuadro
       con el RENSPA del anterior es una etiqueta que miente sobre su procedencia. */
    const dl = datosDeLotes(db).get(l) || {};
    poner('variedad', dl.variedad || null);
    poner('renspa', dl.renspa || null);
    poner('cuartel', dl.cuartel || null);
  }

  /* LA PRESENTACIÓN, que arrastra el destino y la cuenta. Cargar comercial lo que era
     descarte es un error de un clic y hoy obligaba a borrar y cargar de nuevo.
     Al cambiarla se recalculan los kilos con SU cuenta: dejar los viejos sería una
     fila que miente sobre sí misma — cien cajas de 7 kg sumando 300. */
  let pres = null;
  if ('presentacion_id' in dd) {
    const pid = parseInt(dd.presentacion_id, 10);
    if (!Number.isFinite(pid) || pid <= 0) return { ok: false, motivo: 'Elegí la presentación' };
    pres = db.prepare('SELECT * FROM gal_presentaciones WHERE id = ? AND eliminado_en IS NULL')
             .get(pid);
    if (!pres) return { ok: false, motivo: 'Esa presentación no existe' };
    poner('presentacion_id', pres.id);
    poner('presentacion', pres.nombre);
    poner('envase', pres.envase);
    poner('destino', pres.destino);
    poner('categoria', pres.categoria);
    poner('calibre', pres.calibre);
    poner('por_bulto', pres.granel ? null : pres.por_bulto);
    poner('kg_unidad', pres.granel ? null : pres.kg_unidad);
  }

  /* LOS TOTALES SON LOS DE LA CARGA, no los de la fila: es lo que la pantalla
     muestra y lo que el operador acaba de tipear. */
  const totalKg = round2(grupo.reduce((t, x) => t + (Number(x.kilos) || 0), 0));
  const totalBultos = grupo[0].bultos == null
    ? null : round2(grupo.reduce((t, x) => t + (Number(x.bultos) || 0), 0));

  let kg = totalKg;
  /* Si cambió la presentación, manda la nueva; si no, la que tenía la fila. Y eso
     decide también QUÉ se pide: bultos o kilos. */
  const granel = pres ? !!pres.granel : fila.bultos == null;
  const porB = pres ? pres.por_bulto : fila.por_bulto;
  const kgU = pres ? pres.kg_unidad : fila.kg_unidad;
  let bultosTot = null, tocaNumeros = false;

  if (!granel) {
    const b = 'bultos' in dd ? numPos(dd.bultos) : totalBultos;
    if (b == null) return { ok: false, motivo: 'Poné cuántos bultos entraron' };
    kg = kilosDeProceso(b, porB, kgU);
    if (kg == null) return { ok: false, motivo: 'La presentación tiene mal la cuenta' };
    bultosTot = b;
    tocaNumeros = true;
  } else if (pres || 'kilos' in dd) {
    const k = 'kilos' in dd ? numPos(dd.kilos) : totalKg;
    if (k == null) return { ok: false, motivo: 'Poné los kilos' };
    kg = k;
    bultosTot = null;
    tocaNumeros = true;
  }

  if (!sets.length && !tocaNumeros) return { ok: true, id: i, fila };

  /* ── EL REPARTO SE REHACE CON LAS MISMAS PROPORCIONES ─────────────────────────
     Y no volviendo a prorratear contra la tolva: lo que queda sin procesar cambió
     desde que se cargó, así que recalcularlo movería kilos entre cuadros por el
     solo hecho de corregir una observación un rato después.

     repartir() le deja el resto al último, así que la suma de los pedazos vuelve a
     dar exactamente el total — que es la única razón por la que el número grande de
     la pantalla se puede creer. */
  const pesos = pesosDelReparto(grupo.map((x) => Number(x.kilos) || 0));
  /* SE REPARTE SIEMPRE, también cuando nadie tocó los números: con los pesos sacados
     de estos mismos kilos, repartir() devuelve los que ya estaban. Un camino aparte
     para «no cambió nada» sería un segundo camino que da lo mismo y que nadie prueba. */
  const kgPorFila = repartir(kg, pesos);
  const bultosPorFila = bultosTot == null
    ? grupo.map(() => null) : repartir(bultosTot, pesos);

  // El techo se vuelve a mirar en las DOS direcciones: corregir para abajo tiene que
  // poder sacar la marca, o la fila queda en rojo para siempre después de arreglada.
  const techo = config(db).kg_max_proceso;
  let estado = 'ok', motivo = null;
  if (Number.isFinite(techo) && techo > 0 && kg > techo) {
    estado = 'a_revisar';
    motivo = 'Son ' + kg + ' kg en una sola carga, más que el tope de ' + techo + '.';
  }
  poner('estado', estado);
  poner('revision_motivo', motivo);

  /* UNA PASADA POR FILA: lo común va igual en todas y los números van repartidos.
     Sin transacción a propósito: node:sqlite no tiene db.transaction y el
     envoltorio existe sólo en los tests. El riesgo real es acotado —son n filas de
     la misma carga en el mismo proceso— y partirlo en dos caminos, uno con
     transacción y otro sin, deja el de producción sin probar. */
  const upd = db.prepare('UPDATE gal_procesos SET '
    + sets.concat(['bultos = ?', 'kilos = ?']).join(', ') + ' WHERE id = ?');
  for (let n = 0; n < grupo.length; n++) {
    upd.run(...val, bultosPorFila[n], kgPorFila[n], grupo[n].id);
  }
  return { ok: true, id: i, ids: grupo.map((x) => x.id), aviso: motivo,
           lotes: grupo.length,
           fila: db.prepare('SELECT * FROM gal_procesos WHERE id = ?').get(i) };
}

/* Borrar una carga REPARTIDA se las lleva a todas. Media carga deshecha deja la otra
   mitad atribuida a un lote y los kilos que faltan en ningún lado — y nadie lo ve,
   porque el renglón que queda se ve igual de bien que cualquier otro. */
export function borrarProceso(db, id) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const fila = db.prepare(
    'SELECT reparto FROM gal_procesos WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!fila) return { ok: false, motivo: 'Ese proceso no existe o ya se borró' };
  const r = fila.reparto
    ? db.prepare("UPDATE gal_procesos SET eliminado_en = datetime('now','localtime')"
        + ' WHERE reparto = ? AND eliminado_en IS NULL').run(fila.reparto)
    : db.prepare("UPDATE gal_procesos SET eliminado_en = datetime('now','localtime')"
        + ' WHERE id = ? AND eliminado_en IS NULL').run(i);
  return { ok: true, borradas: r.changes };
}

// ── UNA FILA POR CARGA, NO POR LOTE ─────────────────────────────────────────────────
// Andy, 4/11/2026: «esto es confuso. No lo abras por LOTE. En la parte de proceso sólo
// me interesa cómo viene el proceso, no de qué lotes son. Eso es para un análisis
// posterior».
//
// Con la tolva mezclada, UNA carga se guarda como n filas —una por lote, a prorrata— y
// la lista las mostraba todas. Cuatro cargas de damasco se veían como once renglones.
//
// Y EL DAÑO NO ERA SÓLO VISUAL: LA COLUMNA DE BULTOS MENTÍA. Los bultos se reparten
// con la misma prorrata que los kilos, así que nueve cajones entre tres lotes son
// 0,33 / 3,53 / 5,14 y la pantalla los redondea a «0», «4» y «5». Un renglón de
// «0 bultos · 0,74 kg» no es nada que exista en el galpón: no se puede contar, no se
// puede subir a un camión y no se puede comparar contra la pila. El número de bultos
// sólo es cierto ENTERO, que es como se tipeó.
//
// El reparto no se toca: se sigue guardando por lote, que es de donde sale el rinde
// por cuadro. Lo que cambia es que esta pantalla no es el lugar donde se lee.
export function agruparProcesos(filas) {
  const l = Array.isArray(filas) ? filas : [];
  const porGrupo = new Map();
  const out = [];
  for (const f of l) {
    /* Sin reparto, cada fila es su propia carga. Con reparto, la clave es el grupo:
       es el id que registrarProceso le puso a las n filas de una misma carga. */
    const clave = f.reparto ? 'g:' + f.reparto : 'f:' + f.id;
    const ya = porGrupo.get(clave);
    if (!ya) {
      /* La PRIMERA fila es la representante y de ella salen el destino, el producto y
         la presentación, que son iguales en todo el grupo: la carga es una sola y el
         reparto sólo partió los números. */
      const nueva = Object.assign({}, f, {
        ids: [f.id],
        lotes: 1,
        bultos: f.bultos == null ? null : Number(f.bultos),
        kilos: Number(f.kilos) || 0,
      });
      porGrupo.set(clave, nueva);
      out.push(nueva);
      continue;
    }
    ya.ids.push(f.id);
    ya.lotes++;
    if (f.bultos != null) ya.bultos = (ya.bultos || 0) + Number(f.bultos);
    ya.kilos += Number(f.kilos) || 0;
    /* EL ⚠ DE CUALQUIER PEDAZO ES EL DE LA CARGA. Si se apagara al agrupar, una carga
       marcada para revisar desaparecería de la vista justo por agruparla. */
    if (f.estado === 'a_revisar') {
      ya.estado = 'a_revisar';
      ya.revision_motivo = ya.revision_motivo || f.revision_motivo;
    }
  }
  /* Y recién acá se redondea, sobre el total. Redondear cada pedazo y sumar después
     es como se llegaba a «0 bultos». */
  for (const x of out) {
    x.kilos = round2(x.kilos);
    if (x.bultos != null) x.bultos = round2(x.bultos);
  }
  return out;
}

// ── LO PROCESADO UN DÍA ─────────────────────────────────────────────────────────────
// Devuelve UNA FILA POR CARGA (agruparProcesos, arriba).
//
// EL FILTRO POR LOTE SE APLICA AL GRUPO Y NO A LA FILA, y los números son los de la
// carga ENTERA. Filtrar primero y sumar después daría otra vez el pedazo: «0 bultos ·
// 0,74 kg» con otro nombre. Una carga que tocó alguno de los lotes elegidos se muestra
// completa, porque la pregunta de esta pantalla es qué se embaló y no cuánto puso cada
// cuadro — eso se lee en el stock por lote y en los informes.
export function procesosDelDia(db, fecha, loteId) {
  const f = esFecha(fecha);
  if (!f) return [];
  const ls = idsDeLotes(loteId);
  /* SE TRAE EL DÍA ENTERO y se filtra después. Poner el lote en el WHERE partiría los
     grupos antes de armarlos y la carga mezclada volvería a mostrarse a pedazos. */
  const todas = db.prepare(
    ' SELECT * FROM gal_procesos'
    + '  WHERE fecha = ? AND eliminado_en IS NULL'
    + '  ORDER BY id DESC').all(f);
  const grupos = agruparProcesos(todas);
  if (!ls.length) return grupos;
  const deLote = new Set();
  for (const x of todas) if (ls.indexOf(x.lote_id) >= 0) deLote.add(x.id);
  return grupos.filter((g) => g.ids.some((id) => deLote.has(id)));
}

/* ── 📋 TODAS LAS CARGAS, A TRAVÉS DE LOS DÍAS ──────────────────────────────────────
   Andy, 4/11/2026: «quiero un lugar que sea transversal a los días, es decir que pueda
   ver todos los procesos de cada día».

   La pantalla de Proceso es para CARGAR, y por eso está parada en un día: lo que se
   tipea entra en ese día. «Lo cargado este día» es el acuse de lo que se acaba de
   hacer, no el lugar donde se consulta — para ver el martes hay que cambiar el
   almanaque, y no hay manera de mirar dos días juntos.

   SE AGRUPA CON agruparProcesos(), el mismo de la pantalla de Proceso (V1139), y eso
   no es por ahorrar código: sin agrupar, una carga que salió de tres lotes vuelve a
   verse en tres renglones con los bultos prorrateados —0,33 · 3,53 · 5,14 redondeados
   a 0, 4 y 5— y el número de bultos sólo es cierto entero. Un renglón de «0 bultos» no
   es nada que exista en el galpón.

   EL TOPE SE CUENTA ANTES DE RECORTAR. Una temporada entera son miles de cargas y no
   tiene sentido mandarlas todas; lo que no se puede hacer es que los totales de arriba
   cuenten sólo las que entraron. Un total que depende de cuántas filas se mostraron es
   un total que miente sin que nada lo diga. */
export const TOPE_CARGAS_RANGO = 400;

export function procesosDelRango(db, desde, hasta, opts) {
  const o = opts || {};
  /* SIN FECHAS SE TOMA TODO LO QUE HAY, y se saca de gal_procesos y no del rango de
     los VOLCADOS: lo que entró el último día se procesa al siguiente, y ese día queda
     afuera del rango de lo volcado. La pantalla pediría todo y le faltaría el final. */
  let d = esFecha(desde), h = esFecha(hasta);
  if (!d || !h) {
    const r = db.prepare(' SELECT MIN(fecha) AS a, MAX(fecha) AS b FROM gal_procesos'
      + '  WHERE eliminado_en IS NULL').get() || {};
    if (!d) d = esFecha(r.a) || h;
    if (!h) h = esFecha(r.b) || d;
  }
  const vacio = { desde: d || null, hasta: h || null, dias: [],
                  total: { cargas: 0, bultos: 0, kilos: 0, dias: 0, a_revisar: 0,
                           destinos: { comercial: 0, verde: 0, descarte: 0 } },
                  hay_mas: 0, tope: TOPE_CARGAS_RANGO };
  if (!d || !h) return vacio;

  const w = ['p.fecha >= ?', 'p.fecha <= ?', 'p.eliminado_en IS NULL'];
  const a = [d, h];
  /* El filtro por destino va en el WHERE y no después, y se puede: el destino lo
     lleva cada fila igual dentro de un reparto —es la misma carga— así que no parte
     ningún grupo, al revés que el lote. */
  if (esDestino(o.destino)) { w.push('p.destino = ?'); a.push(o.destino); }

  const filas = db.prepare(
    ' SELECT p.*, pa.numero AS pallet_numero, pa.estado AS pallet_estado'
    + '  FROM gal_procesos p'
    + '  LEFT JOIN gal_pallets pa ON pa.id = p.pallet_id AND pa.eliminado_en IS NULL'
    + '  WHERE ' + w.join(' AND ')
    + '  ORDER BY p.fecha DESC, p.id DESC').all(...a);

  const cargas = agruparProcesos(filas);

  /* Los totales, sobre TODAS las cargas del período. Las salidas restan: lo verde que
     vuelve a la tolva salió del stock y no se puede contar dos veces. */
  const signo = (c) => (c.tipo === 'ingreso' ? 1 : -1);
  const total = { cargas: cargas.length, bultos: 0, kilos: 0, dias: 0, a_revisar: 0,
                  destinos: { comercial: 0, verde: 0, descarte: 0 } };
  const porDia = new Map();
  for (const c of cargas) {
    const sg = signo(c);
    total.bultos += sg * (Number(c.bultos) || 0);
    total.kilos += sg * (Number(c.kilos) || 0);
    if (c.estado === 'a_revisar') total.a_revisar++;
    if (total.destinos[c.destino] !== undefined) {
      total.destinos[c.destino] += sg * (Number(c.kilos) || 0);
    }
    if (!porDia.has(c.fecha)) {
      porDia.set(c.fecha, { fecha: c.fecha, cargas: [], bultos: 0, kilos: 0,
                            a_revisar: 0, mostradas: 0 });
    }
    const x = porDia.get(c.fecha);
    x.bultos += sg * (Number(c.bultos) || 0);
    x.kilos += sg * (Number(c.kilos) || 0);
    if (c.estado === 'a_revisar') x.a_revisar++;
  }
  total.dias = porDia.size;
  total.bultos = round2(total.bultos);
  total.kilos = round2(total.kilos);
  for (const k of ['comercial', 'verde', 'descarte']) {
    total.destinos[k] = round2(total.destinos[k]);
  }

  /* Y recién ahora se recorta. Vienen ordenadas de la más nueva a la más vieja, así
     que lo que se corta es lo más viejo — que es lo que uno deja de mirar primero
     cuando el rango es demasiado grande. */
  const muestra = cargas.slice(0, TOPE_CARGAS_RANGO);
  for (const c of muestra) {
    const x = porDia.get(c.fecha);
    x.cargas.push(c);
    x.mostradas++;
  }

  const dias = [...porDia.values()]
    .filter((x) => x.cargas.length)
    .map((x) => Object.assign(x, { bultos: round2(x.bultos), kilos: round2(x.kilos) }));

  return { desde: d, hasta: h, dias, total,
           hay_mas: Math.max(0, cargas.length - muestra.length),
           tope: TOPE_CARGAS_RANGO };
}

// ── EL TABLERO DEL LOTE: CUÁNTO ENTRÓ, CUÁNTO SALIÓ Y ADÓNDE ────────────────────────
// Es lo que hace que la pantalla de proceso no sea un formulario a ciegas: mientras se
// carga se ve cuánto queda de la tolva y cómo viene el reparto.
// Uno, varios, o ninguno. Devuelve siempre la misma forma: una pantalla que tiene que
// preguntar si el tablero vino vacío o vino con otra forma es una pantalla con dos
// caminos y uno de los dos sin probar.
export function idsDeLotes(v) {
  const crudos = Array.isArray(v) ? v : [v];
  const out = [];
  for (const x of crudos) {
    const n = parseInt(x, 10);
    if (Number.isFinite(n) && n > 0 && out.indexOf(n) < 0) out.push(n);
  }
  return out;
}

export function tableroProceso(db, fecha, loteId) {
  const f = esFecha(fecha);
  const ls = idsDeLotes(loteId);
  const vacio = { volcado: 0, procesado: 0, sin_procesar: 0, cargas: 0, destinos: {},
                  rinde: null, de_mas: false, lotes: [] };
  if (!f || !ls.length) return vacio;
  const marcas = ls.map(() => '?').join(',');

  // El volcado del lote NO se corta por día: la fruta que entró el martes se puede
  // procesar el jueves, y un tablero que sólo mira hoy diría que se procesó de más.
  const v = db.prepare(
    ' SELECT COALESCE(SUM(kilos),0) AS kilos FROM gal_volcados'
    + '  WHERE lote_id IN (' + marcas + ') AND eliminado_en IS NULL').get(...ls);

  const filas = db.prepare(
    ' SELECT destino,'
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos ELSE -kilos END),0) AS kilos,"
    + '       COUNT(*) AS cargas'
    + '  FROM gal_procesos WHERE lote_id IN (' + marcas + ') AND eliminado_en IS NULL'
    + '  GROUP BY destino').all(...ls);

  const destinos = {};
  let procesado = 0, cargas = 0;
  for (const d of DESTINOS) destinos[d.clave] = 0;
  for (const r of filas) {
    destinos[r.destino] = round2(r.kilos);
    procesado = round2(procesado + r.kilos);
    cargas += r.cargas;
  }
  const volcado = round2(v.kilos || 0);
  return {
    volcado, procesado, cargas, destinos,
    // Puede dar NEGATIVO, y se muestra: significa que se procesó más de lo que se
    // declaró volcado, o sea que la atribución a este lote se corrió. Taparlo con un
    // Math.max(0, …) es esconder justamente el dato que avisa.
    sin_procesar: round2(volcado - procesado),
    rinde: volcado > 0 ? Math.round((destinos.comercial / volcado) * 1000) / 10 : null,
    de_mas: procesado > volcado,
    lotes: ls,
  };
}

// ── EL STOCK: LO QUE HAY GUARDADO ───────────────────────────────────────────────────
// Derivado, no una tabla aparte. Un stock que se guarda en su propia fila es un número
// que se desincroniza en silencio la primera vez que alguien corrige una carga vieja —
// y acá "corregir una carga vieja" es el caso normal, no la excepción.
export function stockGalpon(db, opts) {
  const o = opts || {};
  const filas = db.prepare(
    ' SELECT destino, presentacion_id,'
    + "       COALESCE(producto, '— sin producto —') AS producto,"
    + "       COALESCE(presentacion, CASE WHEN bultos IS NULL THEN 'A granel' ELSE 'Sin presentación' END) AS nombre,"
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos ELSE -kilos END),0) AS kilos,"
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN bultos ELSE -bultos END),0) AS bultos,"
    + '       MIN(fecha) AS desde, MAX(fecha) AS hasta,'
    + '       COUNT(*) AS cargas'
    + '  FROM gal_procesos WHERE eliminado_en IS NULL'
    + (o.lote_id ? ' AND lote_id = ?' : '')
    + '  GROUP BY destino, presentacion_id, producto'
    + '  ORDER BY destino, SUM(kilos) DESC').all(...(o.lote_id ? [parseInt(o.lote_id, 10)] : []));

  const por = DESTINOS.map((d) => {
    const items = filas.filter((f) => f.destino === d.clave)
      .map((f) => Object.assign({}, f, { kilos: round2(f.kilos), bultos: round2(f.bultos) }));
    const desdes = items.map((x) => x.desde).filter(Boolean).sort();
    return Object.assign({}, d, {
      kilos: round2(items.reduce((t, x) => t + x.kilos, 0)),
      bultos: round2(items.reduce((t, x) => t + (x.bultos || 0), 0)),
      cargas: items.reduce((t, x) => t + (x.cargas || 0), 0),
      // La carga más vieja que sigue guardada. En cámara, eso es la pregunta.
      desde: desdes.length ? desdes[0] : null,
      items,
    });
  });
  return { destinos: por, kilos: round2(por.reduce((t, x) => t + x.kilos, 0)) };
}

// ── LA FINCA DE CADA LOTE ───────────────────────────────────────────────────────────
// Andy, 31/10/2026: «poneme mejor el nombre de la FINCA, porque la gente la ubica por
// el nombre de la finca». Un lote se llama «11-12 y 16-17» y eso no ubica a nadie.
//
// Se LEE de pa_lotes, no se denormaliza en gal_volcados. Es al revés que el nombre del
// lote, que sí se congela: ése forma parte de la atribución y tiene que quedar como
// estaba. La finca es una referencia para ubicarse, y lo que sirve es la de hoy.
//
// JOIN de lectura hacia pa_*, sin FK, que es la regla de CLAUDE.md.
export function fincasDeLotes(db) {
  const m = new Map();
  for (const l of db.prepare('SELECT id, finca FROM pa_lotes').all()) m.set(l.id, l.finca);
  return m;
}

// ── LOS LOTES QUE SE VOLCARON ───────────────────────────────────────────────────────
// Andy, 31/10/2026: «eligiendo del lote volcado ahí se pueden ir cargando procesos
// parciales».
//
// La pantalla de proceso no elige de la lista de TODOS los lotes de la finca: elige de
// los que entraron al galpón, que son los únicos que pueden salir. Y cada uno viene con
// cuánto le queda sin procesar, que es lo que dice cuál es el que está en la tolva.
export function lotesVolcados(db) {
  const vol = db.prepare(
    ' SELECT lote_id,'
    + "       COALESCE(lote_nombre, 'Lote ' || lote_id) AS nombre,"
    + '       GROUP_CONCAT(DISTINCT producto) AS producto,'
    + '       MAX(fecha) AS ultima,'
    + '       COALESCE(SUM(kilos),0) AS volcado'
    + '  FROM gal_volcados WHERE eliminado_en IS NULL'
    + '  GROUP BY lote_id'
    + '  ORDER BY MAX(fecha) DESC, SUM(kilos) DESC').all();

  const proc = db.prepare(
    ' SELECT lote_id,'
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos ELSE -kilos END),0) AS kilos"
    + '  FROM gal_procesos WHERE eliminado_en IS NULL GROUP BY lote_id').all();
  const porLote = new Map(proc.map((p) => [p.lote_id, p.kilos]));

  const fincas = fincasDeLotes(db);
  return vol.map((v) => {
    const procesado = round2(porLote.get(v.lote_id) || 0);
    return Object.assign({}, v, {
      finca: fincas.get(v.lote_id) || null,
      volcado: round2(v.volcado),
      procesado,
      sin_procesar: round2(v.volcado - procesado),
    });
  });
}

// ── EL RESUMEN QUE SE BAJA EN PLANILLA ──────────────────────────────────────────────
// Andy, 1/11/2026: «quiero que en acumulado se pueda descargar un archivo como el que
// te saco foto». La foto es la planilla que ya llevan a mano: una fila por día, con la
// producción abierta POR PRESENTACIÓN.
//
// Es el mismo dato que ya muestran los gráficos, abierto un nivel más. No se calcula
// nada distinto acá: si la planilla y la pantalla dieran números diferentes, el que la
// baja le va a creer a la planilla — y ya no habría forma de saber cuál está mal.
export function resumenParaPlanilla(db, desde, hasta) {
  const d = esFecha(desde), h = esFecha(hasta);
  if (!d || !h) return [];

  // El ingreso del día: cuántos IFCOs y cuántos kilos entraron del campo.
  const vol = db.prepare(
    ' SELECT fecha, COALESCE(SUM(kilos),0) AS kilos, COALESCE(SUM(ifcos),0) AS ifcos'
    + '  FROM gal_volcados WHERE fecha >= ? AND fecha <= ? AND eliminado_en IS NULL'
    + '  GROUP BY fecha').all(d, h);

  // Y la producción, abierta por presentación Y por destino: la planilla abre por
  // presentación sólo lo comercial, y manda el descarte y el verde a sus dos columnas
  // pintadas de la derecha.
  const proc = db.prepare(
    ' SELECT p.fecha, p.destino,'
    + "       COALESCE(p.presentacion, 'Sin presentación') AS nombre,"
    + '       COALESCE(pr.orden, 999) AS orden,'
    + "       COALESCE(SUM(CASE WHEN p.tipo = 'ingreso' THEN p.kilos ELSE -p.kilos END),0) AS kilos,"
    + "       COALESCE(SUM(CASE WHEN p.tipo = 'ingreso' THEN p.bultos ELSE -p.bultos END),0) AS bultos"
    + '  FROM gal_procesos p'
    + '  LEFT JOIN gal_presentaciones pr ON pr.id = p.presentacion_id'
    + '  WHERE p.fecha >= ? AND p.fecha <= ? AND p.eliminado_en IS NULL'
    + '  GROUP BY p.fecha, p.destino, nombre').all(d, h);

  const dias = new Map();
  const nuevo = (f) => ({ fecha: f, volcado: 0, ifcos: 0, comercial: 0, verde: 0,
                          descarte: 0, procesado: 0, bultos: 0,
                          verde_bultos: 0, descarte_bultos: 0, presentaciones: [] });
  for (const v of vol) {
    const x = nuevo(v.fecha);
    x.volcado = round2(v.kilos);
    x.ifcos = v.ifcos || 0;
    dias.set(v.fecha, x);
  }
  for (const r of proc) {
    if (!dias.has(r.fecha)) dias.set(r.fecha, nuevo(r.fecha));
    const x = dias.get(r.fecha);
    x[r.destino] = round2(x[r.destino] + r.kilos);
    x.procesado = round2(x.procesado + r.kilos);
    x.bultos = round2(x.bultos + (r.bultos || 0));
    if (r.destino === 'verde') x.verde_bultos = round2(x.verde_bultos + (r.bultos || 0));
    if (r.destino === 'descarte') {
      x.descarte_bultos = round2(x.descarte_bultos + (r.bultos || 0));
    }
    /* Las columnas del medio son las COMERCIALES. El verde y el descarte tienen sus
       dos columnas propias a la derecha, y meterlos también en el medio los contaría
       dos veces en el total de la fila. */
    if (r.destino === 'comercial') {
      x.presentaciones.push({ nombre: r.nombre, orden: r.orden,
                              kilos: round2(r.kilos), bultos: round2(r.bultos) });
    }
  }
  return [...dias.values()].sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
}
// ── CÓMO VIENE RINDIENDO LA FRUTA, TODA JUNTA ───────────────────────────────────────
// Andy, 31/10/2026: «me da la impresión que hace mucho hincapié en cada lote. En
// realidad una vez que procesamos lo interesante es cómo viene rindiendo en general la
// fruta... mostrame gráficos de todo junto, si me quiero meter a analizar algo del lote
// entro y me fijo».
//
// El mismo número que ya salía lote por lote, pero sumado: cuánto comercial, cuánto
// verde y cuánto descarte dio el período entero. Se calcula ACÁ y no sumando en la
// pantalla porque lo miran dos lugares —el titular del acumulado y los gráficos— y dos
// sumas son dos redondeos distintos el día que alguien toque uno.
export function procesoTotal(db, desde, hasta) {
  const d = esFecha(desde), h = esFecha(hasta);
  const vacio = { comercial: 0, verde: 0, descarte: 0, procesado: 0, volcado: 0,
                  bultos: 0, cargas: 0, rinde: null, sin_procesar: 0, pct: {} };
  if (!d || !h) return vacio;

  const filas = db.prepare(
    ' SELECT destino,'
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos ELSE -kilos END),0) AS kilos,"
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN bultos ELSE -bultos END),0) AS bultos,"
    + '       COUNT(*) AS cargas'
    + '  FROM gal_procesos WHERE fecha >= ? AND fecha <= ? AND eliminado_en IS NULL'
    + '  GROUP BY destino').all(d, h);

  const v = db.prepare(
    ' SELECT COALESCE(SUM(kilos),0) AS kilos FROM gal_volcados'
    + '  WHERE fecha >= ? AND fecha <= ? AND eliminado_en IS NULL').get(d, h);

  const out = Object.assign({}, vacio, { volcado: round2(v.kilos || 0), pct: {} });
  for (const f of filas) {
    out[f.destino] = round2(f.kilos);
    out.procesado = round2(out.procesado + f.kilos);
    out.bultos = round2(out.bultos + (f.bultos || 0));
    out.cargas += f.cargas;
  }
  /* El porcentaje de cada destino es sobre lo PROCESADO, no sobre lo volcado: la
     pregunta es cómo se repartió lo que salió de la máquina. Sobre el volcado, los tres
     sumarían menos de 100 y el resto sería «lo que todavía está en la tolva» — que es
     otra cosa y tiene su propio número. */
  for (const k of ['comercial', 'verde', 'descarte']) {
    out.pct[k] = out.procesado > 0
      ? Math.round((out[k] / out.procesado) * 1000) / 10 : 0;
  }
  out.sin_procesar = round2(out.volcado - out.procesado);
  // El rinde grande sí es contra lo VOLCADO: es cuánto de lo que entró del campo
  // terminó siendo vendible, que es la pregunta de la finca.
  out.rinde = out.volcado > 0
    ? Math.round((out.comercial / out.volcado) * 1000) / 10 : null;
  return out;
}
// ── QUÉ SE PROCESÓ CADA DÍA, Y CÓMO RINDIÓ ──────────────────────────────────────────
// Andy, 31/10/2026: «quiero más gráficos. Más visual respecto a cuánto procesamos cada
// día y cómo rindió».
//
// Dos medidas distintas en la misma consulta, y a propósito NO en el mismo gráfico:
// kilos y porcentaje no comparten escala. La pantalla dibuja dos cuadros alineados por
// el mismo eje de días — un solo cuadro con dos escalas deja elegir cuál sube y cuál
// baja según dónde se corten los ejes.
//
// EL RINDE DE UN DÍA NO ES EL DE UN LOTE. Lo que se vuelca el martes se procesa el
// jueves: día contra día, el porcentaje salta y no significa nada. Por eso se devuelven
// las dos columnas crudas —volcado y comercial del día— y el rinde diario queda como lo
// que es: el ritmo del galpón, no el rendimiento de un cuadro.
export function procesoPorDia(db, desde, hasta) {
  const d = esFecha(desde), h = esFecha(hasta);
  if (!d || !h) return [];

  const proc = db.prepare(
    ' SELECT fecha, destino,'
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos ELSE -kilos END),0) AS kilos,"
    + '       COUNT(*) AS cargas'
    + '  FROM gal_procesos WHERE fecha >= ? AND fecha <= ? AND eliminado_en IS NULL'
    + '  GROUP BY fecha, destino').all(d, h);

  const vol = db.prepare(
    ' SELECT fecha, COALESCE(SUM(kilos),0) AS kilos'
    + '  FROM gal_volcados WHERE fecha >= ? AND fecha <= ? AND eliminado_en IS NULL'
    + '  GROUP BY fecha').all(d, h);

  const dias = new Map();
  const nuevo = (f) => ({ fecha: f, volcado: 0, comercial: 0, verde: 0, descarte: 0,
                          procesado: 0, cargas: 0 });
  for (const v of vol) {
    const x = nuevo(v.fecha);
    x.volcado = round2(v.kilos);
    dias.set(v.fecha, x);
  }
  for (const r of proc) {
    // Un día con proceso y sin volcado existe igual: es procesar lo que entró ayer.
    if (!dias.has(r.fecha)) dias.set(r.fecha, nuevo(r.fecha));
    const x = dias.get(r.fecha);
    x[r.destino] = round2(r.kilos);
    x.procesado = round2(x.procesado + r.kilos);
    x.cargas += r.cargas;
  }

  return [...dias.values()]
    .sort((a, b) => (a.fecha < b.fecha ? -1 : 1))
    .map((x) => Object.assign(x, {
      // Sobre lo PROCESADO ese día, no sobre lo volcado: es qué proporción de lo que
      // salió de la máquina fue vendible. Contra el volcado del mismo día daría más de
      // 100% cualquier jueves que se procese el martes.
      rinde: x.procesado > 0
        ? Math.round((x.comercial / x.procesado) * 1000) / 10 : null,
    }));
}

// ── LO QUE HAY, POR PRESENTACIÓN ────────────────────────────────────────────────────
// Andy, 1/11/2026: «no me interesa por lote. Me interesa PRESENTACIÓN Y CAJAS».
//
// Es la pregunta que se le hace a una cámara llena antes de cargar un camión: «¿cuántas
// cajas de cartón amarillo tengo?». Por lote eran diecinueve renglones para contestarla
// —la misma caja repetida en cada lote— y había que sumar de memoria.
//
// El LOTE no desaparece: viaja adentro de cada presentación, plegado, porque el
// despacho sí lo necesita (el RENSPA que va impreso sale del lote) y porque «de dónde
// salió lo que hay» sigue siendo una pregunta real. Lo que cambia es cuál se contesta
// primero.
export function stockPorPresentacion(db, opts) {
  const o = opts || {};
  const lineas = saldosDeStock(db, o);
  const cat = new Map();
  for (const f of db.prepare(
  /* Las columnas nombradas son por EFICIENCIA —no traer catorce para usar cinco— y
     NO la garantía de que la ruta del archivo no salga: eso lo da la copia campo por
     campo de acá abajo, que es la que arma lo que se devuelve. Confundir las dos deja
     creyendo que hay dos defensas donde hay una. */
    'SELECT id, emoji, icono_v, nombre, orden FROM gal_presentaciones'
    + ' WHERE eliminado_en IS NULL')
    .all()) cat.set(f.id, f);

  const por = new Map();
  for (const l of lineas) {
    if (!(l.bultos > 0 || l.kilos > 0)) continue;
    /* La clave es la PRESENTACIÓN, no el artículo: el mismo envase en dos calibres es
       un solo montón a la hora de mirar la cámara, y los calibres se ven adentro. Una
       presentación borrada del catálogo sigue teniendo stock, y agruparla por id la
       deja con su nombre congelado en vez de perderse en un «sin presentación». */
    const k = String(l.presentacion_id || 0) + '|' + l.destino;
    if (!por.has(k)) {
      const c = cat.get(l.presentacion_id) || {};
      por.set(k, {
        presentacion_id: l.presentacion_id || null,
        nombre: l.presentacion || (l.presentacion_id ? 'Presentación borrada' : 'A granel'),
        emoji: c.emoji || null,
        icono_v: c.icono_v || null,
        orden: c.orden == null ? 100 : c.orden,
        destino: l.destino,
        granel: l.granel,
        bultos: 0, kilos: 0, lotes: [], calibres: new Set(),
      });
    }
    const g = por.get(k);
    g.bultos = round2(g.bultos + (l.bultos || 0));
    g.kilos = round2(g.kilos + l.kilos);
    if (l.calibre) g.calibres.add(l.calibre);
    g.lotes.push({
      lote_id: l.lote_id, nombre: l.lote_nombre || ('Lote ' + l.lote_id),
      calibre: l.calibre || null, categoria: l.categoria || null,
      bultos: l.bultos, kilos: l.kilos, kg_unidad: l.kg_unidad,
    });
  }

  return [...por.values()]
    .map((g) => Object.assign(g, {
      calibres: [...g.calibres].sort(),
      // El de más lotes arriba dentro de cada grupo: es el que más va a mirar.
      lotes: g.lotes.sort((a, b) => (b.bultos || b.kilos) - (a.bultos || a.kilos)),
    }))
    /* Por DESTINO primero, en el ORDEN DE DESTINOS y no alfabético: comercial, verde,
       descarte, que es de mejor a peor. Alfabético pone el descarte antes que el verde,
       y la pantalla terminaría mostrando lo que se tira arriba de lo que se reprocesa.

       El SQL de saldosDeStock ya viene ordenado por destino, pero alfabéticamente y por
       casualidad: que el agrupamiento de esta función dependa del ORDER BY de otra es
       una trampa para el día que esa otra cambie de orden. Acá se ordena igual.

       Después, el orden del catálogo —el que eligió quien lo armó— y a igual orden el
       montón más grande arriba. */
    .sort((a, b) => {
      const da = DESTINOS.findIndex((d) => d.clave === a.destino);
      const dbb = DESTINOS.findIndex((d) => d.clave === b.destino);
      if (da !== dbb) return da - dbb;
      if (a.orden !== b.orden) return a.orden - b.orden;
      return (b.bultos || b.kilos) - (a.bultos || a.kilos);
    });
}
// ── LO GUARDADO, POR PRODUCTO ───────────────────────────────────────────────────────
// Andy, 1/11/2026: «después viene uva y melón». Hoy es todo damasco y este corte
// devuelve una sola fila — y eso está bien: la pantalla lo esconde cuando hay uno solo,
// y aparece el día que entre la segunda fruta sin que nadie tenga que acordarse.
export function stockPorProducto(db) {
  const filas = db.prepare(
    ' SELECT COALESCE(producto, \'— sin producto —\') AS producto,'
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos ELSE -kilos END),0) AS kilos,"
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN bultos ELSE -bultos END),0) AS bultos,"
    + "       COALESCE(SUM(CASE WHEN destino = 'comercial' AND tipo = 'ingreso' THEN kilos"
    + "                        WHEN destino = 'comercial' THEN -kilos ELSE 0 END),0) AS comercial,"
    + "       COALESCE(SUM(CASE WHEN destino = 'verde' AND tipo = 'ingreso' THEN kilos"
    + "                        WHEN destino = 'verde' THEN -kilos ELSE 0 END),0) AS verde,"
    + "       COALESCE(SUM(CASE WHEN destino = 'descarte' AND tipo = 'ingreso' THEN kilos"
    + "                        WHEN destino = 'descarte' THEN -kilos ELSE 0 END),0) AS descarte"
    + '  FROM gal_procesos WHERE eliminado_en IS NULL'
    + '  GROUP BY producto'
    + '  ORDER BY SUM(kilos) DESC').all();
  return filas.map((f) => Object.assign(f, {
    kilos: round2(f.kilos), bultos: round2(f.bultos),
    comercial: round2(f.comercial), verde: round2(f.verde), descarte: round2(f.descarte),
  }));
}
// ── LO GUARDADO, POR LOTE ───────────────────────────────────────────────────────────
// El otro corte del stock: el de arriba contesta «cuánto hay de cada cosa», éste
// contesta «de dónde salió lo que hay». Son las dos preguntas que se le hacen a una
// cámara llena, y ninguna de las dos se deduce de la otra.
export function stockPorLote(db) {
  const filas = db.prepare(
    ' SELECT lote_id, COALESCE(lote_nombre, \'Lote \' || lote_id) AS nombre,'
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos ELSE -kilos END),0) AS kilos,"
    + "       COALESCE(SUM(CASE WHEN destino = 'comercial' AND tipo = 'ingreso' THEN kilos"
    + "                        WHEN destino = 'comercial' THEN -kilos ELSE 0 END),0) AS comercial,"
    + "       COALESCE(SUM(CASE WHEN destino = 'verde' AND tipo = 'ingreso' THEN kilos"
    + "                        WHEN destino = 'verde' THEN -kilos ELSE 0 END),0) AS verde,"
    + "       COALESCE(SUM(CASE WHEN destino = 'descarte' AND tipo = 'ingreso' THEN kilos"
    + "                        WHEN destino = 'descarte' THEN -kilos ELSE 0 END),0) AS descarte,"
    + '       MIN(fecha) AS desde'
    + '  FROM gal_procesos WHERE eliminado_en IS NULL'
    + '  GROUP BY lote_id'
    + '  ORDER BY SUM(kilos) DESC').all();
  const fincas = fincasDeLotes(db);
  return filas.map((f) => Object.assign(f, {
    finca: fincas.get(f.lote_id) || null,
    kilos: round2(f.kilos),
    comercial: round2(f.comercial),
    verde: round2(f.verde),
    descarte: round2(f.descarte),
  }));
}
// ── EL RINDE POR LOTE, PARA EL ACUMULADO ────────────────────────────────────────────
// La pregunta de la temporada: de todo lo que entró de este lote, cuánto salió vendible.
//
// El rango se aplica al VOLCADO y al PROCESO por igual. En los bordes eso corre un poco
// el número —lo volcado el último día del período se procesa al siguiente, que ya queda
// afuera—, y por eso la columna "sin procesar" está a la vista: ahí es donde aparece ese
// desfasaje, en vez de escondido adentro de un porcentaje.
export function rindePorLote(db, desde, hasta) {
  const d = esFecha(desde), h = esFecha(hasta);
  if (!d || !h) return [];
  const vol = db.prepare(
    ' SELECT lote_id,'
    + "       COALESCE(lote_nombre, 'Lote ' || lote_id) AS nombre,"
    + '       COALESCE(SUM(kilos),0) AS volcado'
    + '  FROM gal_volcados WHERE fecha >= ? AND fecha <= ? AND eliminado_en IS NULL'
    + '  GROUP BY lote_id').all(d, h);

  const proc = db.prepare(
    ' SELECT lote_id, destino,'
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos ELSE -kilos END),0) AS kilos"
    + '  FROM gal_procesos WHERE fecha >= ? AND fecha <= ? AND eliminado_en IS NULL'
    + '  GROUP BY lote_id, destino').all(d, h);

  const mapa = new Map();
  for (const v of vol) {
    mapa.set(v.lote_id, { lote_id: v.lote_id, nombre: v.nombre, volcado: round2(v.volcado),
                          comercial: 0, verde: 0, descarte: 0, procesado: 0 });
  }
  for (const p of proc) {
    // Un lote con proceso y SIN volcado en el período entra igual, con volcado 0. Dejarlo
    // afuera escondería kilos que existen: es lo que pasa cuando se procesa a principios
    // de mes lo que entró a fin del anterior.
    if (!mapa.has(p.lote_id)) {
      mapa.set(p.lote_id, { lote_id: p.lote_id, nombre: 'Lote ' + p.lote_id, volcado: 0,
                            comercial: 0, verde: 0, descarte: 0, procesado: 0 });
    }
    const m = mapa.get(p.lote_id);
    m[p.destino] = round2(p.kilos);
    m.procesado = round2(m.procesado + p.kilos);
  }

  const fincas = fincasDeLotes(db);
  return [...mapa.values()].map((m) => Object.assign(m, {
    finca: fincas.get(m.lote_id) || null,
    sin_procesar: round2(m.volcado - m.procesado),
    rinde: m.volcado > 0 ? Math.round((m.comercial / m.volcado) * 1000) / 10 : null,
  })).sort((a, b) => b.volcado - a.volcado || b.procesado - a.procesado);
}

// ════════════════════════════════════════════════════════════════════════════════════
// 🧱 EL PALLET
// ════════════════════════════════════════════════════════════════════════════════════
// Andy, 1/11/2026: «la parte donde cargamos el proceso tiene que ser algo más parecido a
// "Cierre de Pallet", de ahí quiero que salga un tarjetón para imprimir».
//
// El pallet no reemplaza la carga: la ENVUELVE. Se sigue cargando caja por caja contra
// el pallet abierto, y cerrarlo es lo que le pone número y emite la etiqueta.

// Un solo pallet abierto por vez. Dos abiertos a la vez son dos montones en el playón y
// ninguna forma de saber a cuál fue la caja que se acaba de cargar — y lo que decide eso
// no es el sistema, es dónde la apoyó el que la llevó.
// EL PALLET DEL DÍA: el que se llena solo con la carga de proceso. Se filtra por
// origen porque un pallet ARMADO que quede abierto se llevaría las cargas de la mañana
// siguiente — palletAbierto() devuelve el último abierto y la primera caja entra ahí.
export function palletAbierto(db) {
  return db.prepare(
    " SELECT * FROM gal_pallets WHERE estado = 'abierto' AND eliminado_en IS NULL"
    + "   AND COALESCE(origen,'proceso') = 'proceso'"
    + '  ORDER BY id DESC LIMIT 1').get() || null;
}

export function abrirPallet(db, d) {
  const dd = d || {};
  const ya = palletAbierto(db);
  if (ya) return { ok: true, id: ya.id, pallet: ya, ya_estaba: true };
  const f = esFecha(dd.fecha_empaque) || esFecha(dd.fecha);
  const r = db.prepare(
    ' INSERT INTO gal_pallets (fecha_empaque, usuario_id, usuario) VALUES (?,?,?)')
    .run(f, dd.usuario_id || null, txt(dd.usuario));
  const id = Number(r.lastInsertRowid);
  return { ok: true, id, pallet: db.prepare('SELECT * FROM gal_pallets WHERE id = ?').get(id) };
}

// ── LO QUE TIENE ADENTRO ────────────────────────────────────────────────────────────
// Agrupado por ARTÍCULO —producto, variedad, categoría, calibre, envase y lote—, que es
// exactamente un renglón del tarjetón. Dos cargas del mismo artículo y el mismo lote son
// un solo renglón: la etiqueta dice cuántas cajas hay, no cuántas veces se apretó Enter.
export function contenidoDelPallet(db, palletId) {
  const id = parseInt(palletId, 10);
  if (!Number.isFinite(id)) return [];
  return db.prepare(
    ' SELECT producto, variedad, categoria, calibre, envase, presentacion,'
    + '       lote_nombre, renspa, cuartel, destino,'
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN bultos"
    + '                        ELSE -bultos END),0) AS bultos,'
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos"
    + '                        ELSE -kilos END),0) AS kilos,'
    + '       COUNT(*) AS cargas'
    + '  FROM gal_procesos'
    + '  WHERE pallet_id = ? AND eliminado_en IS NULL'
    + '  GROUP BY producto, variedad, categoria, calibre, envase, presentacion,'
    + '           lote_nombre, renspa, cuartel, destino'
    + "  HAVING COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos"
    + '                           ELSE -kilos END),0) <> 0'
    + '  ORDER BY SUM(kilos) DESC').all(id).map((r) => Object.assign(r, {
    bultos: round2(r.bultos), kilos: round2(r.kilos),
  }));
}

/* EL NÚMERO. PC-26-01234: prefijo, los dos dígitos del año y un correlativo de cinco.
   Se arma con el MÁXIMO del año y no con un contador aparte: un contador que se
   incrementa antes de escribir se saltea un número cada vez que algo falla, y el hueco
   en la numeración de los pallets es lo que después nadie puede explicar.

   ── Y DÓNDE ARRANCA LO DICE LA CONFIGURACIÓN ──────────────────────────────────────
   Andy, 5/11/2026: «dejame el primer pallet a armar el 269 así hacemos match con el
   sistema viejo». El galpón venía numerando con otro sistema y ese papel está pegado en
   pallets que están en cámara: si acá se arranca de nuevo en 1, el mismo número queda
   escrito en dos pallets distintos y la cámara deja de poder contarse.

   Es un MÍNIMO, no un contador: `pallet_desde` se aplica mientras el máximo del año
   sea menor, y a partir de ahí el que manda vuelve a ser el máximo. Así no se puede
   retroceder —bajarlo no reutiliza un número ya impreso— y poner uno más alto
   a mitad de temporada abre un hueco a propósito en vez de pisar algo.

   ── EL ARRANQUE VA ATADO A UN AÑO, Y POR ESO SON DOS CLAVES ──────────────────────
   El número lleva el año adentro, así que el correlativo arranca de nuevo cada
   temporada. Un arranque sin año se volvería a aplicar en 2027 y el primer pallet de
   la temporada que viene saldría 00269 otra vez, dejando 268 números que no existen y
   que nadie podría explicar. `pallet_desde_anio` es el año —dos dígitos— al que le
   corresponde; en cualquier otro, el correlativo arranca en 1 como siempre. */
export function proximoNumero(db, fecha) {
  const f = esFecha(fecha) || '';
  const anio = f ? f.slice(2, 4) : String(new Date().getFullYear()).slice(2);
  const pref = (valorConfig(db, 'pallet_prefijo') || 'PC') + '-' + anio + '-';
  const ult = db.prepare(
    ' SELECT numero FROM gal_pallets WHERE numero LIKE ?'
    + ' ORDER BY numero DESC LIMIT 1').get(pref + '%');
  const n = ult ? (parseInt(String(ult.numero).slice(pref.length), 10) || 0) : 0;
  const arranque = String(valorConfig(db, 'pallet_desde_anio') || '').trim() === anio
    ? Math.floor(Number(valorConfig(db, 'pallet_desde') || 0)) || 0
    : 0;
  return pref + String(Math.max(n + 1, arranque)).padStart(5, '0');
}


// ════════════════════════════════════════════════════════════════════════════════════
// 🧱 ARMAR UN PALLET CON LO QUE YA ESTÁ EN CÁMARA
// ════════════════════════════════════════════════════════════════════════════════════
// Andy, 1/11/2026: «necesito un lugar donde pueda hacer cierre de pallet de mercadería
// que está suelta en el stock, donde puedo agarrar pallets mixtos y todo».
//
// UN PALLET ES UNA UBICACIÓN, NO UN MOVIMIENTO. Armarlo no saca ni agrega una sola
// caja: las mismas que había siguen estando, apiladas de otra manera. Lo que saca del
// stock es el despacho. Por eso acá no se escribe ninguna fila de salida — se MUEVEN
// las que ya existen.
//
// Y MOVER OBLIGA A PARTIR. Poner 60 cajas en un pallet cuando la carga de ese día fue
// de 267 deja una fila de 207 y una de 60, las dos apuntando a la original con
// partido_de. El stock no cambia; lo que cambia es dónde está cada parte.

// Lo que se puede poner en un pallet: el stock, con el pallet en el que está hoy. Un
// renglón por lote + destino + presentación + calibre + pallet, porque mover 60 cajas
// es sacarlas de algún lado y hay que poder decir de cuál.
export function stockParaArmar(db, opts) {
  const o = opts || {};
  const filas = db.prepare(
    ' SELECT g.lote_id, g.lote_nombre, g.producto, g.destino, g.presentacion_id,'
    + '       g.presentacion, g.envase, g.categoria, g.calibre, g.variedad,'
    + '       g.pallet_id, p.numero AS pallet_numero, p.estado AS pallet_estado,'
    + "       COALESCE(p.origen,'proceso') AS pallet_origen,"
    + "       COALESCE(SUM(CASE WHEN g.tipo = 'ingreso' THEN g.bultos"
    + "                        ELSE -g.bultos END),0) AS bultos,"
    + "       COALESCE(SUM(CASE WHEN g.tipo = 'ingreso' THEN g.kilos"
    + "                        ELSE -g.kilos END),0) AS kilos,"
    + '       COUNT(*) AS filas,'
    + "       MIN(CASE WHEN g.tipo = 'ingreso' THEN g.fecha END) AS desde,"
    + "       MAX(CASE WHEN g.tipo = 'ingreso' THEN g.fecha END) AS hasta"
    + '  FROM gal_procesos g'
    + '  LEFT JOIN gal_pallets p ON p.id = g.pallet_id AND p.eliminado_en IS NULL'
    + '  WHERE g.eliminado_en IS NULL'
    + (o.destino ? ' AND g.destino = ?' : '')
    + '  GROUP BY g.lote_id, g.destino, g.presentacion_id, g.categoria, g.calibre,'
    + '           g.pallet_id'
    + '  HAVING COALESCE(SUM(g.bultos),0) > 0 OR COALESCE(SUM(g.kilos),0) > 0'
    + '  ORDER BY g.destino, g.lote_nombre, g.presentacion')
    .all(...(o.destino ? [txt(o.destino)] : []));

  return filas.map((f) => Object.assign(f, {
    bultos: round2(f.bultos), kilos: round2(f.kilos),
    /* Lo despachado ya está descontado arriba porque esas filas son tipo='salida' y no
       entran al WHERE. Lo que queda es lo que está físicamente en la cámara. */
    kg_unidad: f.bultos > 0 ? round2(f.kilos / f.bultos) : null,
    granel: !f.bultos,
    /* De dónde viene: sin pallet es suelto; con uno del proceso es la tanda de ese día;
       con uno armado es un pallet que alguien ya rearmó. Los tres se pueden tomar — el
       galpón desarma pallets todo el tiempo— pero el que lo hace tiene que VERLO. */
    ubicacion: !f.pallet_id ? 'suelto'
      : (f.pallet_numero || ('pallet #' + f.pallet_id)),
    clave: [f.lote_id, f.destino, f.presentacion_id || 0, f.calibre || '',
            f.pallet_id || 0].join('|'),
  }));
}


// ── LO QUE SE PUEDE PONER EN UN PALLET, POR ARTÍCULO ────────────────────────────────
// Andy, 1/11/2026: «dame la opción de elegir independientemente del lote, es decir que
// lo haga solo el sistema. Es más: es más importante el día de proceso que el lote».
//
// La lista por ubicación tenía DIECINUEVE renglones —la misma caja repetida por cada
// lote y cada pallet— y para armar un pallet de 100 cajas había que elegir tres veces y
// hacer la cuenta a mano. Acá hay uno por artículo, y de qué lote sale lo decide el
// sistema tomando lo MÁS VIEJO primero: en una cámara lo que entró antes sale antes, y
// ése es el criterio que importa.
//
// El corte por ubicación sigue existiendo —hace falta para sacar de un pallet
// concreto— pero deja de ser el camino normal.
export function stockPorArticulo(db, opts) {
  const o = opts || {};
  const por = new Map();
  for (const f of stockParaArmar(db, o)) {
    if (!(f.bultos > 0 || f.kilos > 0)) continue;
    const k = [f.destino, f.presentacion_id || 0, f.calibre || ''].join('|');
    if (!por.has(k)) {
      por.set(k, {
        destino: f.destino, presentacion_id: f.presentacion_id, presentacion: f.presentacion,
        envase: f.envase, categoria: f.categoria, calibre: f.calibre, producto: f.producto,
        granel: f.granel, bultos: 0, kilos: 0,
        desde: null, hasta: null, lotes: [], ubicaciones: [],
      });
    }
    const g = por.get(k);
    g.bultos = round2(g.bultos + f.bultos);
    g.kilos = round2(g.kilos + f.kilos);
    if (f.desde && (!g.desde || f.desde < g.desde)) g.desde = f.desde;
    if (f.hasta && (!g.hasta || f.hasta > g.hasta)) g.hasta = f.hasta;
    if (!g.lotes.some((x) => x.lote_id === f.lote_id)) {
      g.lotes.push({ lote_id: f.lote_id, nombre: f.lote_nombre });
    }
    g.ubicaciones.push({
      pallet_id: f.pallet_id || null, ubicacion: f.ubicacion,
      pallet_estado: f.pallet_estado || null,
      lote_id: f.lote_id, lote_nombre: f.lote_nombre,
      bultos: f.bultos, kilos: f.kilos, desde: f.desde,
    });
  }
  return [...por.values()].map((g) => Object.assign(g, {
    kg_unidad: g.bultos > 0 ? round2(g.kilos / g.bultos) : null,
    /* Las ubicaciones en el orden en que se van a tomar: lo más viejo primero. Sirve
       para que la pantalla pueda decir de dónde VA a salir antes de apretar. */
    ubicaciones: g.ubicaciones.sort((a, b) => String(a.desde || '').localeCompare(
      String(b.desde || '')) || (a.pallet_id || 0) - (b.pallet_id || 0)),
    clave: [g.destino, g.presentacion_id || 0, g.calibre || ''].join('|'),
  })).sort((a, b) => {
    const da = DESTINOS.findIndex((d) => d.clave === a.destino);
    const dbb = DESTINOS.findIndex((d) => d.clave === b.destino);
    if (da !== dbb) return da - dbb;
    // Dentro del destino, lo más viejo arriba: es lo que hay que sacar primero.
    return String(a.desde || '').localeCompare(String(b.desde || ''));
  });
}

export function palletsArmados(db, opts) {
  const o = opts || {};
  const w = ["eliminado_en IS NULL", "COALESCE(origen,'proceso') = 'armado'"];
  const a = [];
  if (o.estado === 'abierto' || o.estado === 'cerrado') { w.push('estado = ?'); a.push(o.estado); }
  return db.prepare('SELECT * FROM gal_pallets WHERE ' + w.join(' AND ')
    + ' ORDER BY id DESC LIMIT ' + (parseInt(o.limite, 10) || 100)).all(...a)
    .map((x) => Object.assign(x, { contenido: contenidoDelPallet(db, x.id) }));
}

// A diferencia del pallet del día, de los ARMADOS puede haber varios abiertos a la vez:
// se arman tres para un camión y se van llenando en paralelo, que es como se trabaja en
// el playón. El del proceso es uno solo porque ahí la caja se carga y tiene que haber
// un único lugar donde cae.
export function abrirPalletArmado(db, d) {
  const dd = d || {};
  const r = db.prepare(
    " INSERT INTO gal_pallets (origen, fecha_empaque, observacion, usuario_id, usuario)"
    + " VALUES ('armado',?,?,?,?)").run(
    esFecha(dd.fecha_empaque) || esFecha(dd.fecha) || hoy(),
    txt(dd.observacion), numPos(dd.usuario_id, 0) || null, txt(dd.usuario));
  const id = Number(r.lastInsertRowid);
  return { ok: true, id,
           pallet: db.prepare('SELECT * FROM gal_pallets WHERE id = ?').get(id) };
}

/* MOVER CAJAS A UN PALLET. Toma de las filas que tengan esa mercadería en esa
   ubicación, de la más vieja a la más nueva, partiendo la última si hace falta.

   De la MÁS VIEJA primero y no de la más grande: en una cámara lo que entró antes sale
   antes, y si hay que partir algo conviene que sea lo más nuevo. */
export function moverAlPallet(db, palletId, d) {
  const pid = parseInt(palletId, 10);
  const dd = d || {};
  if (!Number.isFinite(pid)) return { ok: false, motivo: 'Id inválido' };
  const pal = db.prepare(
    'SELECT * FROM gal_pallets WHERE id = ? AND eliminado_en IS NULL').get(pid);
  if (!pal) return { ok: false, motivo: 'Ese pallet no existe o se borró' };
  if (pal.estado !== 'abierto') {
    return { ok: false, motivo: 'Ese pallet ya está cerrado: reabrilo para cambiarlo' };
  }

  /* EL LOTE ES OPCIONAL. Andy, 1/11/2026: «dame la opción de elegir
     independientemente del lote, es decir que lo haga solo el sistema». Sin lote se
     toma de todos, lo más viejo primero; con lote, sólo de ése. Lo mismo la ubicación:
     sin decirla se toma de donde haya. */
  const lote = dd.lote_id == null || dd.lote_id === ''
    ? null : parseInt(dd.lote_id, 10);
  if (lote !== null && !Number.isFinite(lote)) return { ok: false, motivo: 'Lote inválido' };
  const libre = dd.pallet_id === undefined;
  const destino = txt(dd.destino);
  if (!DESTINOS.some((y) => y.clave === destino)) return { ok: false, motivo: 'Destino inválido' };
  const pres = parseInt(dd.presentacion_id, 10) || 0;
  const cal = txt(dd.calibre) || '';
  const desde = dd.pallet_id == null || dd.pallet_id === '' ? null
    : (parseInt(dd.pallet_id, 10) || null);
  if (desde === pid) return { ok: false, motivo: 'Eso ya está en este pallet' };

  /* LAS FILAS CANDIDATAS, ORDENADAS POR DÍA DE PROCESO. Andy: «es más importante el día
     de proceso que el lote». En una cámara lo que entró antes sale antes, así que el
     orden es la fecha y el lote es lo que salga.

     Sin lote se toma de todos; sin ubicación —cuando ni siquiera se nombró el campo— de
     donde haya, saltando sólo este mismo pallet. Decir pallet_id: null es otra cosa: es
     pedir explícitamente lo SUELTO. */
  const w = ["eliminado_en IS NULL", "tipo = 'ingreso'", 'destino = ?',
             'COALESCE(presentacion_id,0) = ?', "COALESCE(calibre,'') = ?"];
  const a = [destino, pres, cal];
  if (lote !== null) { w.push('lote_id = ?'); a.push(lote); }
  if (libre) { w.push('COALESCE(pallet_id,0) <> ?'); a.push(pid); }
  else if (desde) { w.push('pallet_id = ?'); a.push(desde); }
  else { w.push('pallet_id IS NULL'); }
  const filas = db.prepare('SELECT * FROM gal_procesos WHERE ' + w.join(' AND ')
    + '  ORDER BY fecha, id').all(...a);
  if (!filas.length) {
    const propio = db.prepare(
      " SELECT COALESCE(SUM(bultos),0) AS b FROM gal_procesos"
      + "  WHERE eliminado_en IS NULL AND tipo = 'ingreso' AND pallet_id = ?"
      + "    AND destino = ? AND COALESCE(presentacion_id,0) = ?"
      + "    AND COALESCE(calibre,'') = ?").get(pid, destino, pres, cal);
    return { ok: false, disponible: 0,
      motivo: (propio && propio.b > 0) ? 'De eso ya está todo en este pallet'
        : (libre ? 'De eso no hay nada en cámara' : 'De eso no hay nada en esa ubicación') };
  }

  const granel = !filas.some((f) => f.bultos != null);
  /* El tope sale del SALDO de esa ubicación y no de la suma de las filas de ingreso:
     después de despachar, las cajas están en un camión y las filas de ingreso siguen
     ahí. Sumarlas ofrecería mover mercadería que ya se fue. */
  const saldos = stockParaArmar(db).filter((x) => x.destino === destino
    && (x.presentacion_id || 0) === pres
    && (x.calibre || '') === cal
    && (lote === null || x.lote_id === lote)
    && (libre ? (x.pallet_id || 0) !== pid : (x.pallet_id || null) === desde));
  const hayB = round2(saldos.reduce((t, x) => t + x.bultos, 0));
  const hayK = round2(saldos.reduce((t, x) => t + x.kilos, 0));
  const pideB = granel ? null : numPos(dd.bultos, 0);
  const pideK = granel ? numPos(dd.kilos, 0) : null;

  if (!granel && !(pideB > 0)) return { ok: false, motivo: 'Poné cuántas cajas' };
  if (granel && !(pideK > 0)) return { ok: false, motivo: 'Poné cuántos kilos' };
  /* No se mueve más de lo que hay, por lo mismo que no se despacha de más: las cajas
     están ahí para contarlas. Un pallet con cajas que no existen se descubre recién
     cuando lo van a cargar. */
  if (!granel && pideB > hayB) {
    return { ok: false, motivo: 'Ahí hay ' + hayB + ' cajas y estás moviendo ' + pideB,
             disponible: hayB, pedido: pideB };
  }
  if (granel && pideK > hayK) {
    return { ok: false, motivo: 'Ahí hay ' + hayK + ' kg y estás moviendo ' + pideK,
             disponible: hayK, pedido: pideK };
  }

  let faltaB = pideB;
  let faltaK = pideK;
  let movidas = 0;
  const tocadas = new Map();
  for (const f of filas) {
    if (granel ? !(faltaK > 0) : !(faltaB > 0)) break;
    const tieneB = f.bultos || 0;
    const tieneK = f.kilos || 0;
    const tomaB = granel ? null : Math.min(tieneB, faltaB);
    const tomaK = granel ? Math.min(tieneK, faltaK)
      : (tomaB === tieneB ? tieneK : round2(tomaB * (tieneK / tieneB)));

    if ((granel ? tomaK >= tieneK : tomaB >= tieneB)) {
      // Se lleva la fila entera: no hay nada que partir.
      db.prepare('UPDATE gal_procesos SET pallet_id = ? WHERE id = ?').run(pid, f.id);
    } else {
      /* SE PARTE. La fila que queda se achica y la que se va es NUEVA, con el mismo
         contenido congelado y apuntando a la original. Al revés —mover la original y
         crear el resto— el id que ya figura en un informe o en un tarjetón cambiaría
         de pallet sin aviso. */
      db.prepare('UPDATE gal_procesos SET bultos = ?, kilos = ? WHERE id = ?')
        .run(granel ? null : round2(tieneB - tomaB), round2(tieneK - tomaK), f.id);
      db.prepare(
        ' INSERT INTO gal_procesos (fecha, lote_id, lote_nombre, producto, destino,'
        + '   presentacion_id, presentacion, envase, categoria, calibre, variedad,'
        + '   renspa, cuartel, bultos, por_bulto, kg_unidad, kilos, tipo, pallet_id,'
        + '   partido_de, observacion, estado, usuario_id, usuario)'
        + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ingreso',?,?,?,?,?,?)").run(
        f.fecha, f.lote_id, f.lote_nombre, f.producto, f.destino,
        f.presentacion_id, f.presentacion, f.envase, f.categoria, f.calibre, f.variedad,
        f.renspa, f.cuartel, granel ? null : tomaB, f.por_bulto, f.kg_unidad,
        round2(tomaK), pid, f.partido_de || f.id, f.observacion, f.estado,
        numPos(dd.usuario_id, 0) || null, txt(dd.usuario));
    }
    movidas++;
    const k = f.fecha + '|' + f.lote_id + '|' + (f.pallet_id || 0);
    if (!tocadas.has(k)) {
      tocadas.set(k, { fecha: f.fecha, lote_id: f.lote_id, lote_nombre: f.lote_nombre,
                       pallet_id: f.pallet_id || null, bultos: 0, kilos: 0 });
    }
    const t = tocadas.get(k);
    t.bultos = round2(t.bultos + (tomaB || 0));
    t.kilos = round2(t.kilos + tomaK);
    if (granel) faltaK = round2(faltaK - tomaK); else faltaB = round2(faltaB - tomaB);
  }

  /* DE DÓNDE SALIÓ, con el reparto ya hecho. Cuando el sistema elige solo, el que
     apretó el botón no sabe de qué lotes ni de qué días salieron las cajas — y eso es
     justamente lo que va a tener que mirar si algo no cuadra. */
  const detalle = [...tocadas.values()].sort((x, y) =>
    String(x.fecha).localeCompare(String(y.fecha)));

  return { ok: true, id: pid, movidas, detalle,
           bultos: pideB, kilos: granel ? pideK : null,
           /* De dónde salieron, para poder decirlo en pantalla: sacarle cajas a un
              pallet cerrado lo deja distinto de su tarjetón, y el que lo hizo tiene que
              enterarse en el momento, no cuando llega el camión. */
           /* Los pallets que quedaron distintos. Con el reparto automático pueden
              ser varios, y cada uno que estuviera CERRADO quedó distinto de su
              tarjetón: hay que decirlo todo, no sólo el primero. */
           desde: desde ? palletResumen(db, desde) : null,
           tocados: [...new Set([...tocadas.values()].map((t) => t.pallet_id))]
             .filter(Boolean).map((x) => palletResumen(db, x)),
           contenido: contenidoDelPallet(db, pid) };
}

// Lo que quedó de un pallet después de sacarle algo. Si quedó vacío se dice: un pallet
// cerrado sin nada adentro es una etiqueta pegada a un armazón de madera.
export function palletResumen(db, id) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return null;
  const p = db.prepare('SELECT * FROM gal_pallets WHERE id = ?').get(i);
  if (!p) return null;
  const c = contenidoDelPallet(db, i);
  return {
    id: i, numero: p.numero, estado: p.estado,
    origen: p.origen || 'proceso',
    bultos: round2(c.reduce((t, x) => t + (x.bultos || 0), 0)),
    kilos: round2(c.reduce((t, x) => t + x.kilos, 0)),
    vacio: !c.length,
  };
}

/* Devolver al suelto lo que se movió. No se refunde con la fila de la que salió: dos
   filas de 207 y 60 que vuelven a ser una de 267 borran que alguna vez estuvieron
   separadas, y el stock da igual de las dos maneras. */
export function sacarDelPalletArmado(db, procesoId) {
  const i = parseInt(procesoId, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const f = db.prepare(
    'SELECT * FROM gal_procesos WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!f) return { ok: false, motivo: 'Esa carga no existe' };
  if (!f.pallet_id) return { ok: false, motivo: 'Eso ya está suelto' };
  const p = db.prepare('SELECT * FROM gal_pallets WHERE id = ?').get(f.pallet_id);
  if (p && p.estado !== 'abierto') {
    return { ok: false, motivo: 'Ese pallet está cerrado: reabrilo primero' };
  }
  db.prepare('UPDATE gal_procesos SET pallet_id = NULL WHERE id = ?').run(i);
  return { ok: true, id: i,
           pallet: f.pallet_id ? palletResumen(db, f.pallet_id) : null };
}

// Las líneas de un pallet, UNA POR FILA y no agrupadas: es lo que se saca de a una
// cuando el pallet se está armando. contenidoDelPallet() agrupa, que es lo que va en el
// tarjetón, pero para corregir hay que poder señalar el renglón exacto.
// Las líneas de un pallet, AGRUPADAS POR ARTÍCULO Y DÍA DE PROCESO. Andy, 2/11/2026:
// «me interesa fecha de proceso pero no lote». Antes era una fila por carga, así que un
// pallet con 49 cajas del mismo cartón mostraba tres renglones idénticos salvo por el
// lote — la única columna que los distinguía era la que no interesa.
//
// El día SÍ queda separado: dos cargas del mismo artículo de días distintos son dos
// renglones, porque la antigüedad es lo que se mira para decidir qué sale primero.
//
// Los ids de las filas que lo componen viajan juntos para poder sacarlas: el renglón se
// ve como uno y al quitarlo se van las tres.
export function lineasDelPallet(db, palletId) {
  const i = parseInt(palletId, 10);
  if (!Number.isFinite(i)) return [];
  const filas = db.prepare(
    ' SELECT id, fecha, lote_id, lote_nombre, producto, destino, presentacion,'
    + '       presentacion_id, categoria, calibre, variedad, bultos, kilos, partido_de'
    + "  FROM gal_procesos WHERE pallet_id = ? AND eliminado_en IS NULL AND tipo = 'ingreso'"
    + '  ORDER BY fecha, id').all(i);

  const por = new Map();
  for (const f of filas) {
    const k = [f.fecha, f.presentacion_id || 0, f.calibre || '', f.destino].join('|');
    if (!por.has(k)) {
      por.set(k, { fecha: f.fecha, presentacion_id: f.presentacion_id,
                   presentacion: f.presentacion, destino: f.destino,
                   categoria: f.categoria, calibre: f.calibre, producto: f.producto,
                   variedad: f.variedad, bultos: 0, kilos: 0, ids: [], lotes: [] });
    }
    const g = por.get(k);
    g.bultos = round2(g.bultos + (f.bultos || 0));
    g.kilos = round2(g.kilos + f.kilos);
    g.ids.push(f.id);
    /* Los lotes viajan igual aunque la pantalla no los muestre: el RENSPA que va en un
       remito sale de ahí, y el día que haya que contestar «de qué lote era» la
       respuesta tiene que estar. Lo que cambia es qué se mira primero, no qué se
       guarda. */
    if (!g.lotes.some((x) => x.lote_id === f.lote_id)) {
      g.lotes.push({ lote_id: f.lote_id, nombre: f.lote_nombre });
    }
  }
  return [...por.values()];
}

export function cerrarPallet(db, id, d) {
  const i = parseInt(id, 10);
  const dd = d || {};
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const p = db.prepare('SELECT * FROM gal_pallets WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!p) return { ok: false, motivo: 'Ese pallet no existe o ya se borró' };
  if (p.estado === 'cerrado') {
    // No es un error: el segundo clic de un doble clic, o dos personas cerrando el mismo.
    return { ok: true, id: i, pallet: p, ya_estaba: true };
  }

  const cont = contenidoDelPallet(db, i);
  if (!cont.length) {
    /* Un pallet vacío sí se rechaza, y es la única excepción a «nada se rechaza después
       del hecho»: acá no pasó nada todavía. Cerrarlo gastaría un número del correlativo
       en una etiqueta de cero cajas. */
    return { ok: false, motivo: 'Este pallet no tiene nada cargado. Cargá algo o borralo.' };
  }

  const bultos = round2(cont.reduce((t, x) => t + (x.bultos || 0), 0));
  const kilos = round2(cont.reduce((t, x) => t + x.kilos, 0));
  // MIXTO lo decide el contenido, no el que cierra.
  const mixto = cont.length > 1 ? 1 : 0;
  /* Si ya tenía número —se reabrió y se vuelve a cerrar— se conserva: es el mismo
     pallet físico y la etiqueta que puede estar pegada lo sigue identificando. Pedir
     uno nuevo en cada cierre dejaría dos números para un solo pallet y un hueco en el
     correlativo por cada corrección. */
  const numero = p.numero || proximoNumero(db, p.fecha_empaque);

  db.prepare(
    " UPDATE gal_pallets SET numero = ?, estado = 'cerrado', parcial = ?, mixto = ?,"
    + '   bultos = ?, kilos = ?, observacion = COALESCE(?, observacion),'
    + "   cerrado_en = datetime('now','localtime')"
    + ' WHERE id = ?').run(numero, dd.parcial ? 1 : 0, mixto, bultos, kilos,
                           txt(dd.observacion), i);

  return { ok: true, id: i, numero,
           pallet: db.prepare('SELECT * FROM gal_pallets WHERE id = ?').get(i),
           contenido: cont };
}

/* Reabrir uno cerrado. EL NÚMERO SE CONSERVA: es el mismo pallet físico, y la etiqueta
   que ya puede estar pegada en el playón lo sigue identificando. Soltarlo tendría dos
   caminos y los dos malos: reutilizarlo deja DOS pallets con el mismo número —lo peor que
   le puede pasar a un remito— y dejarlo libre abre un hueco en el correlativo que después
   nadie puede explicar.

   Lo que sí hay que hacer es REIMPRIMIR: el número es el mismo pero los totales cambian. */
export function reabrirPallet(db, id) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const p = db.prepare('SELECT * FROM gal_pallets WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!p) return { ok: false, motivo: 'Ese pallet no existe' };
  if (p.estado !== 'cerrado') return { ok: false, motivo: 'Ese pallet ya está abierto' };
  /* Y NO SI ESTÁ EN UN DESPACHO. Reabrirlo lo devuelve al piso, y entonces el remito
     pasaría a llevar cajas sueltas que creía que eran un pallet — con el tarjetón ya
     impreso. Primero se lo saca del despacho, que es una decisión y se ve. */
  const enDesp = db.prepare(
    ' SELECT d.id, d.numero, d.estado FROM gal_procesos g'
    + '  JOIN gal_despachos d ON d.id = g.despacho_id AND d.eliminado_en IS NULL'
    + "  WHERE g.pallet_id = ? AND g.tipo = 'salida' AND g.eliminado_en IS NULL"
    + '  LIMIT 1').get(i);
  if (enDesp) {
    return { ok: false, motivo: 'Ese pallet está en el despacho '
      + (enDesp.numero || '#' + enDesp.id) + ': sacalo de ahí primero' };
  }
  if ((p.origen || 'proceso') === 'proceso' && palletAbierto(db)) {
    return { ok: false, motivo: 'Ya hay un pallet del día abierto. Cerralo primero.' };
  }
  db.prepare(
    " UPDATE gal_pallets SET estado = 'abierto', cerrado_en = NULL,"
    + ' bultos = NULL, kilos = NULL WHERE id = ?').run(i);
  return { ok: true, id: i, numero: p.numero };
}

export function borrarPallet(db, id) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const cont = contenidoDelPallet(db, i);
  if (cont.length) {
    /* Con cargas adentro no se borra: esas cajas existen y borrar el pallet las dejaría
       sin dónde, contadas en el stock y en ningún pallet. Se sacan primero. */
    return { ok: false, motivo: 'Tiene cargas adentro. Sacalas o borralas primero.' };
  }
  const r = db.prepare(
    "UPDATE gal_pallets SET eliminado_en = datetime('now','localtime')"
    + ' WHERE id = ? AND eliminado_en IS NULL').run(i);
  if (!r.changes) return { ok: false, motivo: 'Ese pallet no existe o ya se borró' };
  return { ok: true };
}

// Sacar una carga del pallet sin borrarla: la caja existe, estaba en el montón
// equivocado. Vuelve a quedar sin pallet y se puede sumar a otro.
export function sacarDelPallet(db, procesoId) {
  const i = parseInt(procesoId, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const f = db.prepare('SELECT pallet_id FROM gal_procesos WHERE id = ? AND eliminado_en IS NULL')
              .get(i);
  if (!f) return { ok: false, motivo: 'Esa carga no existe' };
  if (!f.pallet_id) return { ok: false, motivo: 'Esa carga no está en ningún pallet' };
  const p = db.prepare('SELECT estado FROM gal_pallets WHERE id = ?').get(f.pallet_id);
  if (p && p.estado === 'cerrado') {
    return { ok: false, motivo: 'Ese pallet está cerrado. Reabrilo primero.' };
  }
  db.prepare('UPDATE gal_procesos SET pallet_id = NULL WHERE id = ?').run(i);
  return { ok: true };
}

// ── LA LISTA ────────────────────────────────────────────────────────────────────────
export function pallets(db, opts) {
  const o = opts || {};
  const cond = [], val = [];
  if (o.estado) { cond.push('estado = ?'); val.push(o.estado); }
  if (esFecha(o.desde)) { cond.push('fecha_empaque >= ?'); val.push(esFecha(o.desde)); }
  if (esFecha(o.hasta)) { cond.push('fecha_empaque <= ?'); val.push(esFecha(o.hasta)); }
  const filas = db.prepare(
    ' SELECT * FROM gal_pallets WHERE eliminado_en IS NULL'
    + (cond.length ? ' AND ' + cond.join(' AND ') : '')
    + ' ORDER BY (estado = \'abierto\') DESC, id DESC'
    + ' LIMIT ' + (Number(o.limite) > 0 ? Math.min(500, Number(o.limite)) : 200)).all(...val);

  /* A los ABIERTOS se les calculan los totales al vuelo: todavía no hay nada congelado y
     mostrar su casillero vacío sería esconder lo único que importa de un pallet abierto,
     que es cuánto lleva. */
  return filas.map((p) => {
    if (p.estado === 'cerrado') return p;
    const c = contenidoDelPallet(db, p.id);
    return Object.assign({}, p, {
      bultos: round2(c.reduce((t, x) => t + (x.bultos || 0), 0)),
      kilos: round2(c.reduce((t, x) => t + x.kilos, 0)),
      mixto: c.length > 1 ? 1 : 0,
      lineas: c.length,
    });
  });
}

export function palletPorNumero(db, numero) {
  const n = txt(numero);
  if (!n) return null;
  const p = db.prepare(
    'SELECT * FROM gal_pallets WHERE numero = ? AND eliminado_en IS NULL').get(n);
  if (!p) return null;
  return Object.assign({}, p, { contenido: contenidoDelPallet(db, p.id) });
}

// ════════════════════════════════════════════════════════════════════════════════════
// 🚚 EL DESPACHO
// ════════════════════════════════════════════════════════════════════════════════════
// Andy, 1/11/2026: «la vuelta sería primero procesar y una vez que está en stock lo
// despachamos».
//
// Un despacho es una SALIDA del stock: cada ítem escribe una fila en gal_procesos con
// tipo = 'salida', que es la columna que los seis agregados de stock ya descuentan. No
// hay tabla de movimientos aparte, y eso es deliberado: dos lugares que suman el mismo
// stock es un stock que miente el día que una consulta se olvida de la otra.
//
// Y SE DESPACHA EN CAJAS, no en kilos. Andy, 31/10/2026: «los stock van en cajas porque
// necesitamos saber qué cargar. No me interesa ahí verlo en kilos». El operador pide 120
// cajas y los kilos los deduce el servidor con el kg_unidad del stock que descuenta —
// igual que la carga de proceso, donde kilos lo calcula el servidor y nunca el cliente.

export const DESPACHO_ESTADOS = ['borrador', 'emitido', 'anulado'];

// ── QUÉ SE PUEDE DESPACHAR ──────────────────────────────────────────────────────────
// El stock disponible por línea, que es la unidad real del despacho: no «200 kg de
// damasco» sino «la caja 50/55 comercial del lote 10». Es lo que se carga en un camión.
/* EL SALDO POR LÍNEA, sin esconder los ceros: es lo que mira la validación del tope.
   disponibleParaDespacho() le saca las líneas en cero porque es lo que alimenta el
   selector —ofrecer algo que no hay es ofrecer un error—, pero la validación necesita
   ver el cero para poder DECIRLO: «hay 0 cajas de eso» explica, «de eso no hay nada en
   stock» hace pensar que el artículo no existe.

   Y el HAVING repite la expresión en vez de usar el alias a propósito: en SQLite un
   alias en HAVING se liga a la COLUMNA de la tabla, no a la suma, así que
   un "HAVING bultos > 0" filtraría fila por fila y dejaría pasar las líneas agotadas. Ya
   pasó en este repo con un GROUP BY. */
/* ── QUÉ ES «EL PISO» ───────────────────────────────────────────────────────────────
   Andy, 5/11/2026: «en los despachos tenés que tener la opción de cargar del "piso" o
   pallets. Pero una vez que está armado el pallet NO puede cargarse sólo una parte del
   pallet».

   EL PISO ES TODO LO QUE NO ESTÁ EN UN PALLET CERRADO: lo suelto, y también lo que
   está en un pallet ABIERTO. Un pallet abierto es el del día mientras se llena —no
   tiene número, no tiene tarjetón y nadie lo enzunchó—, así que todavía es mercadería
   suelta apilada. Cerrarlo es lo que lo convierte en una unidad, y desde ahí sale
   entero o no sale.

   Un pallet_id que apunta a un pallet BORRADO también es piso: esas cajas están en
   algún lado y no es un pallet. Sin ese caso quedarían fuera de las dos listas y
   serían kilos que el stock cuenta y que nadie puede despachar nunca. */
const EN_EL_PISO = " AND (g.pallet_id IS NULL OR p.id IS NULL OR p.estado = 'abierto')";

function saldosDeStock(db, opts) {
  const o = opts || {};
  const filas = db.prepare(
    ' SELECT g.lote_id, g.lote_nombre, g.producto, g.destino, g.presentacion_id,'
    + '       g.presentacion, g.categoria, g.calibre, g.variedad, g.envase,'
    + "       COALESCE(SUM(CASE WHEN g.tipo = 'ingreso' THEN g.bultos ELSE -g.bultos END),0) AS bultos,"
    + "       COALESCE(SUM(CASE WHEN g.tipo = 'ingreso' THEN g.kilos ELSE -g.kilos END),0) AS kilos,"
    /* Granel = en esta línea NUNCA hubo bultos. Deducirlo de «bultos llegó a 0» haría
       que una línea de cajas agotada se trate como granel y pida kilos. */
    + '       COUNT(g.bultos) AS con_bultos'
    + '  FROM gal_procesos g'
    + '  LEFT JOIN gal_pallets p ON p.id = g.pallet_id AND p.eliminado_en IS NULL'
    + '  WHERE g.eliminado_en IS NULL'
    + (o.piso ? EN_EL_PISO : '')
    + (o.destino ? ' AND g.destino = ?' : '')
    + '  GROUP BY g.lote_id, g.destino, g.presentacion_id, g.categoria, g.calibre'
    + '  ORDER BY g.destino, g.lote_nombre, g.presentacion').all(...(o.destino ? [txt(o.destino)] : []));

  return filas.map((f) => Object.assign(f, {
    bultos: round2(f.bultos), kilos: round2(f.kilos),
    granel: !f.con_bultos,
    /* El peso de una caja SALE DEL STOCK que hay, no del catálogo: si entraron cajas de
       8,2 kg y el catálogo dice 8,0, despachar 100 tiene que sacar los 820 que hay. Si
       no, quedan 20 kg fantasma que nadie puede despachar nunca. */
    kg_unidad: f.bultos > 0 ? round2(f.kilos / f.bultos) : null,
    clave: [f.lote_id, f.destino, f.presentacion_id || 0, f.calibre || ''].join('|'),
  }));
}

// ── LO QUE SE PUEDE DESPACHAR DEL PISO ──────────────────────────────────────────────
// Por línea: no «200 kg de damasco» sino «la caja 50/55 comercial del lote 10». Las
// líneas agotadas no salen, para que el selector no ofrezca lo que no hay.
//
// SE LLAMABA disponibleParaDespacho Y DEVOLVÍA TODO, pallets cerrados incluidos. Ése
// era el agujero: pedir 97 cajas que estaban en un pallet de 100 lo partía sin decir
// nada. Ahora lo de los pallets sale por palletsParaDespacho() y entero.
export function pisoParaDespacho(db, opts) {
  return saldosDeStock(db, Object.assign({}, opts, { piso: true }))
    .filter((f) => f.bultos > 0 || f.kilos > 0);
}

// ── Y LOS PALLETS QUE SE PUEDEN SUBIR AL CAMIÓN ─────────────────────────────────────
// Cerrados y con algo adentro. Un pallet ABIERTO no entra en esta lista a propósito:
// no tiene número ni tarjetón, y el camión se carga leyendo el tarjetón. Cerrarlo es
// un clic y hace falta igual para imprimirlo.
//
// Los que ya se fueron en otro despacho se caen solos: contenidoDelPallet() descuenta
// las salidas, así que un pallet despachado queda sin contenido.
export function palletsParaDespacho(db, opts) {
  const o = opts || {};
  const lim = parseInt(o.limite, 10) || 300;
  const filas = db.prepare(
    " SELECT * FROM gal_pallets WHERE eliminado_en IS NULL AND estado = 'cerrado'"
    + ' ORDER BY numero DESC LIMIT ' + lim).all();
  const salida = [];
  for (const x of filas) {
    const lineas = lineasDePalletParaSalida(db, x.id);
    if (!lineas.length) continue;
    if (o.destino && !lineas.some((l) => l.destino === txt(o.destino))) continue;
    salida.push({
      id: x.id, numero: x.numero, fecha_empaque: x.fecha_empaque,
      parcial: x.parcial, mixto: x.mixto, articulos: lineas.length,
      bultos: round2(lineas.reduce((t, l) => t + (l.bultos || 0), 0)),
      kilos: round2(lineas.reduce((t, l) => t + (l.kilos || 0), 0)),
      contenido: contenidoDelPallet(db, x.id),
    });
  }
  return salida;
}

/* LAS LÍNEAS DE UN PALLET, CON LO QUE UNA SALIDA NECESITA. contenidoDelPallet() es
   para el tarjetón: agrupa por nombre y no trae lote_id ni presentacion_id, que son
   justo las columnas con las que se escribe la salida. Agrupa por las MISMAS claves
   que el saldo del stock, así lo que sale de acá y lo que el stock descuenta son la
   misma cuenta. */
function lineasDePalletParaSalida(db, palletId) {
  const i = parseInt(palletId, 10);
  if (!Number.isFinite(i)) return [];
  return db.prepare(
    ' SELECT lote_id, lote_nombre, producto, destino, presentacion_id, presentacion,'
    + '       envase, categoria, calibre, variedad,'
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN bultos ELSE -bultos END),0) AS bultos,"
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos ELSE -kilos END),0) AS kilos,"
    + '       COUNT(bultos) AS con_bultos'
    + '  FROM gal_procesos'
    + '  WHERE pallet_id = ? AND eliminado_en IS NULL'
    + '  GROUP BY lote_id, destino, presentacion_id, categoria, calibre'
    + "  HAVING COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos"
    + '                           ELSE -kilos END),0) > 0'
    + '  ORDER BY lote_nombre, presentacion').all(i).map((f) => Object.assign(f, {
      bultos: f.con_bultos ? round2(f.bultos) : null,
      kilos: round2(f.kilos),
      granel: !f.con_bultos,
      /* El peso de la caja sale del stock y no del catálogo, igual que en el resto
         del módulo: lo que se despacha son los kilos que hay. */
      kg_unidad: f.con_bultos && f.bultos > 0 ? round2(f.kilos / f.bultos) : null,
    }));
}

export function despachos(db, opts) {
  const o = opts || {};
  const w = ['eliminado_en IS NULL'];
  const a = [];
  if (o.estado && DESPACHO_ESTADOS.indexOf(o.estado) >= 0) { w.push('estado = ?'); a.push(o.estado); }
  if (fechaDeAlmanaque(o.desde)) { w.push('fecha >= ?'); a.push(esFecha(o.desde)); }
  if (fechaDeAlmanaque(o.hasta)) { w.push('fecha <= ?'); a.push(esFecha(o.hasta)); }
  return db.prepare('SELECT * FROM gal_despachos WHERE ' + w.join(' AND ')
    + ' ORDER BY fecha DESC, id DESC LIMIT ' + (parseInt(o.limite, 10) || 200)).all(...a);
}

export function itemsDelDespacho(db, despachoId) {
  const i = parseInt(despachoId, 10);
  if (!Number.isFinite(i)) return [];
  return db.prepare(
    ' SELECT * FROM gal_procesos'
    + "  WHERE despacho_id = ? AND tipo = 'salida' AND eliminado_en IS NULL"
    + '  ORDER BY id').all(i).map((f) => Object.assign(f, {
      bultos: round2(f.bultos), kilos: round2(f.kilos),
    }));
}

export function abrirDespacho(db, d) {
  const dd = d || {};
  const r = db.prepare(
    " INSERT INTO gal_despachos (estado, fecha, destinatario, transporte, patente,"
    + '   remito, observacion, usuario_id, usuario)'
    + " VALUES ('borrador',?,?,?,?,?,?,?,?)").run(
    esFecha(dd.fecha) || hoy(), txt(dd.destinatario), txt(dd.transporte), txt(dd.patente),
    txt(dd.remito), txt(dd.observacion), numPos(dd.usuario_id, 0) || null, txt(dd.usuario));
  return { ok: true, id: r.lastInsertRowid,
           despacho: db.prepare('SELECT * FROM gal_despachos WHERE id = ?').get(r.lastInsertRowid) };
}

export function editarDespacho(db, id, d) {
  const i = parseInt(id, 10);
  const dd = d || {};
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const x = db.prepare('SELECT * FROM gal_despachos WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!x) return { ok: false, motivo: 'Ese despacho no existe o se borró' };
  /* Un despacho EMITIDO no se edita: el remito ya salió. Lo que cambia después —que al
     final lo llevó otro camión— va en la observación, que sí se puede agregar. */
  if (x.estado === 'anulado') return { ok: false, motivo: 'Ese despacho está anulado' };
  if (x.estado === 'emitido') {
    if (dd.observacion == null) {
      return { ok: false, motivo: 'Ya está emitido: sólo se le puede agregar observación' };
    }
    db.prepare('UPDATE gal_despachos SET observacion = ? WHERE id = ?')
      .run(txt(dd.observacion), i);
    return { ok: true, id: i, solo_observacion: true,
             despacho: db.prepare('SELECT * FROM gal_despachos WHERE id = ?').get(i) };
  }
  db.prepare(
    ' UPDATE gal_despachos SET fecha = COALESCE(?, fecha),'
    + '   destinatario = COALESCE(?, destinatario), transporte = COALESCE(?, transporte),'
    + '   patente = COALESCE(?, patente), remito = COALESCE(?, remito),'
    + '   observacion = COALESCE(?, observacion)'
    + ' WHERE id = ?').run(esFecha(dd.fecha), txt(dd.destinatario), txt(dd.transporte),
                           txt(dd.patente), txt(dd.remito), txt(dd.observacion), i);
  return { ok: true, id: i,
           despacho: db.prepare('SELECT * FROM gal_despachos WHERE id = ?').get(i) };
}

// ── CARGAR UNA LÍNEA AL DESPACHO ────────────────────────────────────────────────────
// ACÁ ESTÁ LA ÚNICA VALIDACIÓN DEL GALPÓN QUE FRENA. No se despacha más de lo que hay:
// la fruta todavía está en la cámara y un camión al que le faltan 50 cajas no es un dato
// a corregir mañana. Todo lo demás del módulo marca a_revisar porque la fruta ya está en
// la tolva y negarse a guardar la pierde; acá es al revés.
export function agregarAlDespacho(db, despachoId, d) {
  const i = parseInt(despachoId, 10);
  const dd = d || {};
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const x = db.prepare('SELECT * FROM gal_despachos WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!x) return { ok: false, motivo: 'Ese despacho no existe o se borró' };
  if (x.estado !== 'borrador') {
    return { ok: false, motivo: 'Ese despacho ya está ' + x.estado + ': no se le puede agregar' };
  }

  const lote = parseInt(dd.lote_id, 10);
  if (!Number.isFinite(lote)) return { ok: false, motivo: 'Falta el lote' };
  const destino = txt(dd.destino);
  if (!DESTINOS.some((y) => y.clave === destino)) return { ok: false, motivo: 'Destino inválido' };

  const pres = parseInt(dd.presentacion_id, 10) || 0;
  const cal = txt(dd.calibre) || '';
  const mismo = (f) => f.lote_id === lote && f.destino === destino
    && (f.presentacion_id || 0) === pres && (f.calibre || '') === cal;

  /* CONTRA EL SALDO DEL PISO, y contra el saldo y no contra el disponible: así una
     línea agotada contesta «hay 0 cajas de eso» en vez de «no existe».

     Y si de eso no queda nada suelto pero sí hay en un pallet cerrado, se dice CUÁL
     es el camino en vez de «no hay». Antes esta misma llamada agarraba las cajas del
     pallet y lo partía sin avisar: en el papel cerraba y en el playón alguien tenía
     que cortarle el film a un pallet terminado. */
  const disp = saldosDeStock(db, { piso: true }).find(mismo);
  if (!disp) {
    const enPallet = saldosDeStock(db).find(mismo);
    return { ok: false, en_pallet: enPallet ? 1 : 0, motivo: enPallet
      ? 'De eso no queda nada suelto: lo que hay está en pallets cerrados, y un pallet '
        + 'se despacha entero. Agregalo desde «Un pallet entero».'
      : 'De eso nunca entró nada al galpón' };
  }

  /* Granel: se despachan kilos. Con presentación: se despachan CAJAS y los kilos los
     calcula el servidor, como en la carga de proceso. */
  const granel = disp.granel;
  const bultos = granel ? null : numPos(dd.bultos, 0);
  const kilos = granel ? numPos(dd.kilos, 0) : round2(bultos * disp.kg_unidad);
  if (!granel && !(bultos > 0)) return { ok: false, motivo: 'Poné cuántas cajas' };
  if (granel && !(kilos > 0)) return { ok: false, motivo: 'Poné cuántos kilos' };

  /* El disponible ya descuenta las salidas GRABADAS, incluidas las de este mismo
     borrador: pedir 250 y después 250 más tiene que frenarse en la segunda, no sumar
     500 y recién avisar cuando el camión está cargado. */
  if (!granel && bultos > disp.bultos) {
    return { ok: false, motivo: 'Hay ' + disp.bultos + ' cajas de eso y estás despachando '
                                + bultos, disponible: disp.bultos, pedido: bultos };
  }
  if (granel && kilos > disp.kilos) {
    return { ok: false, motivo: 'Hay ' + disp.kilos + ' kg de eso y estás despachando ' + kilos,
             disponible: disp.kilos, pedido: kilos };
  }

  /* DE QUÉ UBICACIÓN SALEN. Un despacho de 97 cajas puede llevarse 60 de un pallet,
     17 de otro y 20 de lo suelto: se escribe una salida por cada uno, todas con el
     mismo despacho_id. Sin esto el saldo por ubicación nunca baja y el armado sigue
     ofreciendo cajas que están en un camión.

     De la más vieja primero, el mismo criterio con el que se arma un pallet: en una
     cámara lo que entró antes sale antes. */
  const ubis = stockParaArmar(db).filter((x) => x.lote_id === lote
    && x.destino === destino
    && (x.presentacion_id || 0) === pres
    && (x.calibre || '') === cal
    && (x.bultos > 0 || x.kilos > 0)
    /* DEL PISO Y DE NINGÚN PALLET CERRADO. El tope de arriba ya se miró contra el
       piso, así que acá no debería aparecer uno — pero si apareciera, esta línea es
       la que impide que el reparto se lleve cajas de adentro de un pallet armado. */
    && (!x.pallet_id || !x.pallet_estado || x.pallet_estado === 'abierto'));
  let restaB = granel ? null : bultos;
  let restaK = granel ? kilos : null;
  const partes = [];
  for (const u of ubis) {
    if (granel ? !(restaK > 0) : !(restaB > 0)) break;
    const tomaB = granel ? null : Math.min(u.bultos, restaB);
    const tomaK = granel ? Math.min(u.kilos, restaK)
      : (tomaB === u.bultos ? u.kilos : round2(tomaB * (u.kilos / u.bultos)));
    partes.push({ pallet_id: u.pallet_id || null, bultos: tomaB, kilos: round2(tomaK) });
    if (granel) restaK = round2(restaK - tomaK); else restaB = round2(restaB - tomaB);
  }
  /* Si las ubicaciones no alcanzan —no debería, el tope se miró arriba— lo que falta
     sale sin ubicación antes que perderse: la caja se despachó igual. */
  if (granel ? restaK > 0 : restaB > 0) {
    partes.push({ pallet_id: null, bultos: granel ? null : restaB,
                  kilos: granel ? restaK : round2(restaB * (disp.kg_unidad || 0)) });
  }

  /* Se CONGELA lo que se despachó, igual que en la carga y en el pallet: lo que dice el
     remito que salió no lo cambia un catálogo corregido el mes que viene. */
  let primera = null;
  for (const parte of partes) {
  const r = db.prepare(
    ' INSERT INTO gal_procesos (uuid, fecha, lote_id, lote_nombre, producto, destino,'
    + '   presentacion_id, presentacion, envase, categoria, calibre, variedad,'
    + '   bultos, kg_unidad, kilos, tipo, pallet_id, despacho_id, observacion,'
    + '   usuario_id, usuario)'
    + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'salida',?,?,?,?,?)").run(
    /* El uuid va SÓLO en la primera parte: es UNIQUE y sirve para que un doble clic no
       duplique el pedido entero, no cada renglón. */
    primera === null ? txt(dd.uuid) : null,
    x.fecha, lote, txt(disp.lote_nombre), txt(disp.producto), destino,
    disp.presentacion_id || null, txt(disp.presentacion), txt(disp.envase),
    txt(disp.categoria), txt(disp.calibre), txt(disp.variedad),
    parte.bultos, granel ? null : disp.kg_unidad, parte.kilos,
    parte.pallet_id, i, txt(dd.observacion),
    numPos(dd.usuario_id, 0) || null, txt(dd.usuario));
  if (primera === null) primera = r.lastInsertRowid;
  }

  return { ok: true, id: primera, bultos, kilos, partes: partes.length,
           despacho: recalcularDespacho(db, i) };
}

// ── UN PALLET ENTERO AL CAMIÓN ──────────────────────────────────────────────────────
// Andy, 5/11/2026: «una vez que está armado el pallet no puede cargarse sólo una parte
// del pallet».
//
// Un pallet cerrado está enzunchado y tiene un tarjetón pegado que dice cuántas cajas
// lleva. Sacarle 60 de 100 obliga a romperlo en el playón y manda al camión una etiqueta
// que miente. Así que acá no hay cantidad que elegir: entra lo que tiene adentro.
//
// Y SI DE VERDAD HAY QUE PARTIRLO, SE LO PARTE DE VERDAD: se reabre, se sacan las cajas
// —que vuelven al piso— y se cierra. Queda el pallet con lo que quedó, el piso con lo
// que salió, y el tarjetón reimpreso dice la verdad. La regla no es una pared, es que
// partir un pallet sea un acto y no un efecto secundario de cargar un camión.
export function agregarPalletAlDespacho(db, despachoId, palletId, d) {
  const i = parseInt(despachoId, 10);
  const pid = parseInt(palletId, 10);
  const dd = d || {};
  if (!Number.isFinite(i) || !Number.isFinite(pid)) return { ok: false, motivo: 'Id inválido' };
  const x = db.prepare('SELECT * FROM gal_despachos WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!x) return { ok: false, motivo: 'Ese despacho no existe o se borró' };
  if (x.estado !== 'borrador') {
    return { ok: false, motivo: 'Ese despacho ya está ' + x.estado + ': no se le puede agregar' };
  }
  const pal = db.prepare('SELECT * FROM gal_pallets WHERE id = ? AND eliminado_en IS NULL').get(pid);
  if (!pal) return { ok: false, motivo: 'Ese pallet no existe o se borró' };
  if (pal.estado !== 'cerrado') {
    return { ok: false, motivo: 'Ese pallet está abierto: cerralo primero. Al cerrarlo le '
      + 'sale el número y el tarjetón, que es con lo que se controla el camión.' };
  }

  /* EL MISMO PALLET NO VA DOS VECES, y se dice en cuál está. Sin esto, el segundo
     intento fallaría más adelante por otra razón —no queda contenido— y el motivo
     hablaría de otra cosa.

     Un despacho ANULADO no traba el pallet, y eso NO hace falta escribirlo acá:
     anular le pone eliminado_en a sus líneas de salida, así que el filtro de
     eliminadas ya lo deja afuera. Estuvo escrito un rato como `d.estado <> 'anulado'`
     y la prueba de mutación mostró que sacarlo no cambiaba nada — una condición que
     nunca puede ser falsa hace creer que el caso está cubierto por ella, y el día que
     el filtro de arriba cambie nadie va a mirar acá. */
  const ya = db.prepare(
    ' SELECT d.id, d.numero, d.estado FROM gal_procesos g'
    + '  JOIN gal_despachos d ON d.id = g.despacho_id AND d.eliminado_en IS NULL'
    + "  WHERE g.pallet_id = ? AND g.tipo = 'salida' AND g.eliminado_en IS NULL"
    + '  LIMIT 1').get(pid);
  if (ya) {
    return { ok: false, ya_en: ya.id, motivo: ya.id === i
      ? 'Ese pallet ya está en este despacho'
      : 'Ese pallet ya está en el despacho ' + (ya.numero || '#' + ya.id)
        + ', que está ' + ya.estado };
  }

  const lineas = lineasDePalletParaSalida(db, pid);
  if (!lineas.length) {
    return { ok: false, motivo: 'Ese pallet no tiene nada adentro' };
  }

  /* Se CONGELA lo que se despachó, igual que en la carga y en el pallet: una línea de
     salida por artículo, todas con el pallet para que después se sepa de dónde salió
     cada caja —y para que el que carga el camión pueda escanear el tarjetón. */
  let primera = null;
  for (const l of lineas) {
    const r = db.prepare(
      ' INSERT INTO gal_procesos (uuid, fecha, lote_id, lote_nombre, producto, destino,'
      + '   presentacion_id, presentacion, envase, categoria, calibre, variedad,'
      + '   bultos, kg_unidad, kilos, tipo, pallet_id, despacho_id, observacion,'
      + '   usuario_id, usuario)'
      + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'salida',?,?,?,?,?)").run(
      /* El uuid va SÓLO en la primera línea: es UNIQUE y sirve para que un doble clic
         no duplique el pallet entero, no cada renglón. */
      primera === null ? txt(dd.uuid) : null,
      x.fecha, l.lote_id, txt(l.lote_nombre), txt(l.producto), l.destino,
      l.presentacion_id || null, txt(l.presentacion), txt(l.envase),
      txt(l.categoria), txt(l.calibre), txt(l.variedad),
      l.bultos, l.kg_unidad, l.kilos,
      pid, i, txt(dd.observacion),
      numPos(dd.usuario_id, 0) || null, txt(dd.usuario));
    if (primera === null) primera = r.lastInsertRowid;
  }

  return { ok: true, id: primera, pallet_id: pid, numero: pal.numero,
           articulos: lineas.length,
           bultos: round2(lineas.reduce((t, l) => t + (l.bultos || 0), 0)),
           kilos: round2(lineas.reduce((t, l) => t + (l.kilos || 0), 0)),
           despacho: recalcularDespacho(db, i) };
}

// Y SE SACA ENTERO TAMBIÉN. Sacar un renglón de un pallet mixto dejaría adentro del
// camión medio pallet, que es justo lo que esta regla evita.
export function sacarPalletDelDespacho(db, despachoId, palletId) {
  const i = parseInt(despachoId, 10);
  const pid = parseInt(palletId, 10);
  if (!Number.isFinite(i) || !Number.isFinite(pid)) return { ok: false, motivo: 'Id inválido' };
  const x = db.prepare('SELECT * FROM gal_despachos WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!x) return { ok: false, motivo: 'Ese despacho no existe o se borró' };
  if (x.estado !== 'borrador') {
    return { ok: false, motivo: 'Ese despacho ya está ' + x.estado + ': anulalo entero' };
  }
  const r = db.prepare(
    " UPDATE gal_procesos SET eliminado_en = datetime('now','localtime')"
    + "  WHERE despacho_id = ? AND pallet_id = ? AND tipo = 'salida'"
    + '    AND eliminado_en IS NULL').run(i, pid);
  if (!r.changes) return { ok: false, motivo: 'Ese pallet no está en este despacho' };
  return { ok: true, lineas: Number(r.changes), despacho: recalcularDespacho(db, i) };
}

/* ── LO QUE LLEVA EL CAMIÓN, COMO SE CARGA ─────────────────────────────────────────
   Un despacho de tres pallets y cuarenta cajas sueltas son tres bultos grandes y una
   pila, no nueve renglones de artículos. itemsDelDespacho() sigue devolviendo las
   líneas —el remito y los totales salen de ahí— y esto las agrupa en las UNIDADES con
   las que alguien sube cosas a un camión.

   Lo que salió de un pallet ABIERTO cuenta como piso: ahí no había ninguna unidad. */
export function unidadesDelDespacho(db, despachoId) {
  const items = itemsDelDespacho(db, despachoId);
  const pal = new Map();
  const salida = [];
  for (const f of items) {
    let p = null;
    if (f.pallet_id) {
      if (!pal.has(f.pallet_id)) {
        pal.set(f.pallet_id, db.prepare(
          'SELECT numero, estado FROM gal_pallets WHERE id = ?').get(f.pallet_id) || null);
      }
      p = pal.get(f.pallet_id);
    }
    if (!p || p.estado !== 'cerrado') {
      salida.push({ tipo: 'piso', id: f.id, lote_id: f.lote_id,
        lote_nombre: f.lote_nombre, destino: f.destino, presentacion: f.presentacion,
        calibre: f.calibre, bultos: f.bultos, kilos: f.kilos });
      continue;
    }
    let u = salida.find((y) => y.tipo === 'pallet' && y.pallet_id === f.pallet_id);
    if (!u) {
      u = { tipo: 'pallet', pallet_id: f.pallet_id, numero: p.numero,
            articulos: 0, bultos: 0, kilos: 0, lineas: [] };
      salida.push(u);
    }
    u.articulos++;
    u.bultos = round2(u.bultos + (f.bultos || 0));
    u.kilos = round2(u.kilos + (f.kilos || 0));
    u.lineas.push({ id: f.id, lote_nombre: f.lote_nombre, destino: f.destino,
                    presentacion: f.presentacion, calibre: f.calibre,
                    bultos: f.bultos, kilos: f.kilos });
  }
  return salida;
}

export function sacarDelDespacho(db, procesoId) {
  const i = parseInt(procesoId, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const f = db.prepare(
    " SELECT * FROM gal_procesos WHERE id = ? AND tipo = 'salida' AND eliminado_en IS NULL")
    .get(i);
  if (!f) return { ok: false, motivo: 'Esa línea no existe' };
  const x = db.prepare('SELECT estado FROM gal_despachos WHERE id = ?').get(f.despacho_id);
  if (x && x.estado !== 'borrador') {
    return { ok: false, motivo: 'Ese despacho ya está ' + x.estado + ': anulalo entero' };
  }
  /* NI UN RENGLÓN DE UN PALLET CERRADO. Un pallet mixto son varios renglones: sacar
     uno dejaría en el camión medio pallet, que es exactamente lo que esta regla
     evita. Se saca el pallet entero, y la pantalla ya ofrece ese botón y no éste. */
  if (f.pallet_id) {
    const pal = db.prepare(
      'SELECT numero, estado FROM gal_pallets WHERE id = ? AND eliminado_en IS NULL')
      .get(f.pallet_id);
    if (pal && pal.estado === 'cerrado') {
      return { ok: false, pallet_id: f.pallet_id,
        motivo: 'Ese renglón es parte del pallet ' + (pal.numero || '#' + f.pallet_id)
          + ': el pallet se saca entero.' };
    }
  }
  db.prepare("UPDATE gal_procesos SET eliminado_en = datetime('now','localtime') WHERE id = ?")
    .run(i);
  return { ok: true, despacho: f.despacho_id ? recalcularDespacho(db, f.despacho_id) : null };
}

// Los totales del borrador se RECALCULAN de las líneas; al emitir se congelan.
export function recalcularDespacho(db, id) {
  const i = parseInt(id, 10);
  const t = db.prepare(
    " SELECT COALESCE(SUM(bultos),0) AS bultos, COALESCE(SUM(kilos),0) AS kilos"
    + "  FROM gal_procesos WHERE despacho_id = ? AND tipo = 'salida'"
    + '    AND eliminado_en IS NULL').get(i);
  db.prepare('UPDATE gal_despachos SET bultos = ?, kilos = ? WHERE id = ?')
    .run(round2(t.bultos), round2(t.kilos), i);
  return db.prepare('SELECT * FROM gal_despachos WHERE id = ?').get(i);
}

export function proximoNumeroDespacho(db, fecha) {
  const f = esFecha(fecha) || '';
  const anio = f ? f.slice(2, 4) : String(new Date().getFullYear()).slice(2);
  const pref = (valorConfig(db, 'despacho_prefijo') || 'DG') + '-' + anio + '-';
  const ult = db.prepare(
    ' SELECT numero FROM gal_despachos WHERE numero LIKE ?'
    + ' ORDER BY numero DESC LIMIT 1').get(pref + '%');
  const n = ult ? (parseInt(String(ult.numero).slice(pref.length), 10) || 0) : 0;
  return pref + String(n + 1).padStart(5, '0');
}

export function emitirDespacho(db, id) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const x = db.prepare('SELECT * FROM gal_despachos WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!x) return { ok: false, motivo: 'Ese despacho no existe o se borró' };
  if (x.estado === 'emitido') return { ok: true, id: i, despacho: x, ya_estaba: true };
  if (x.estado === 'anulado') return { ok: false, motivo: 'Ese despacho está anulado' };

  const items = itemsDelDespacho(db, i);
  /* Un despacho vacío se rechaza por lo mismo que un pallet vacío: gastaría un número
     del correlativo en un remito de cero cajas. */
  if (!items.length) return { ok: false, motivo: 'Este despacho no tiene nada cargado' };

  /* El número se conserva si ya tenía —igual que el pallet reabierto—, así que un
     despacho anulado y rehecho no abre un hueco en el correlativo. */
  const numero = x.numero || proximoNumeroDespacho(db, x.fecha);
  db.prepare(
    " UPDATE gal_despachos SET numero = ?, estado = 'emitido', bultos = ?, kilos = ?,"
    + "   emitido_en = datetime('now','localtime') WHERE id = ?").run(
    numero, round2(items.reduce((t, y) => t + (y.bultos || 0), 0)),
    round2(items.reduce((t, y) => t + y.kilos, 0)), i);
  return { ok: true, id: i, numero,
           despacho: db.prepare('SELECT * FROM gal_despachos WHERE id = ?').get(i), items };
}

// ── ANULAR ──────────────────────────────────────────────────────────────────────────
// Un despacho emitido no se borra: se ANULA. Borrarlo haría desaparecer un remito que
// alguien tiene en la mano. Anular devuelve los kilos al stock —las salidas se eliminan
// en blando y los agregados dejan de verlas— y el número queda gastado, que es lo que
// hace que un correlativo pueda demostrar que no se saltea nada.
export function anularDespacho(db, id, motivo) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const x = db.prepare('SELECT * FROM gal_despachos WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!x) return { ok: false, motivo: 'Ese despacho no existe o se borró' };
  if (x.estado === 'anulado') return { ok: true, id: i, despacho: x, ya_estaba: true };
  db.prepare(
    " UPDATE gal_procesos SET eliminado_en = datetime('now','localtime')"
    + "  WHERE despacho_id = ? AND tipo = 'salida' AND eliminado_en IS NULL").run(i);
  db.prepare(
    " UPDATE gal_despachos SET estado = 'anulado', anulado_en = datetime('now','localtime'),"
    + '   anulado_motivo = ? WHERE id = ?').run(txt(motivo), i);
  return { ok: true, id: i,
           despacho: db.prepare('SELECT * FROM gal_despachos WHERE id = ?').get(i) };
}

// Un BORRADOR sí se borra: todavía no salió nada y no hay número gastado.
export function borrarDespacho(db, id) {
  const i = parseInt(id, 10);
  if (!Number.isFinite(i)) return { ok: false, motivo: 'Id inválido' };
  const x = db.prepare('SELECT * FROM gal_despachos WHERE id = ? AND eliminado_en IS NULL').get(i);
  if (!x) return { ok: false, motivo: 'Ese despacho no existe o ya se borró' };
  if (x.estado !== 'borrador') {
    return { ok: false, motivo: 'Ese despacho está ' + x.estado + ': se anula, no se borra' };
  }
  db.prepare(
    " UPDATE gal_procesos SET eliminado_en = datetime('now','localtime')"
    + '  WHERE despacho_id = ? AND eliminado_en IS NULL').run(i);
  db.prepare("UPDATE gal_despachos SET eliminado_en = datetime('now','localtime') WHERE id = ?")
    .run(i);
  return { ok: true, id: i };
}

export function despachoPorNumero(db, numero) {
  const n = txt(numero);
  if (!n) return null;
  const x = db.prepare(
    ' SELECT * FROM gal_despachos WHERE numero = ? AND eliminado_en IS NULL').get(n);
  return x ? Object.assign(x, { items: itemsDelDespacho(db, x.id) }) : null;
}
