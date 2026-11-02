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
    cuadId, cuadNom, kg, entero(dd.ifcos), origenDe(dd.origen),
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

  const porCuadrilla = conPct(corte('cuadrilla_id', "cuadrilla, '— sin cuadrilla —'"));
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

  /* AL PALLET ABIERTO. Si no hay ninguno se abre uno solo: pedirle al operador que
     abra el pallet antes de la primera caja es un paso que se va a saltear, y la caja
     quedaría suelta sin que nada avise. */
  const palletId = dd.sin_pallet ? null : abrirPallet(db, { fecha_empaque: fecha,
    usuario_id: dd.usuario_id, usuario: dd.usuario }).id;

  const ins = db.prepare(
    ' INSERT OR IGNORE INTO gal_procesos (uuid,fecha,lote_id,lote_nombre,producto,destino,'
    + ' presentacion_id,presentacion,envase,bultos,por_bulto,kg_unidad,kilos,tipo,'
    + ' categoria,calibre,variedad,renspa,cuartel,'
    + ' pallet_id,'
    + ' reparto,repartido,observacion,estado,revision_motivo,usuario_id,usuario)'
    + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'ingreso',?,?,?,?,?,?,?,?,?,?,?,?,?)");

  /* EL DOBLE CLIC. Si el primer uuid ya está, la carga entró entera y no se hace
     nada: el INSERT OR IGNORE de abajo protege la carrera, pero mirar primero es lo
     que deja contestar «ya estaba» en vez de «no se pudo guardar». */
  const u0 = txt(dd.uuid) ? (esMezcla ? dd.uuid + '#' + lotes[0] : dd.uuid) : null;
  if (u0) {
    const ya = db.prepare('SELECT * FROM gal_procesos WHERE uuid = ?').get(u0);
    if (ya) return { ok: true, id: ya.id, ids: [ya.id], fila: ya, repetido: true };
  }

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

  return {
    ok: true, id: ids[0], ids,
    fila: db.prepare('SELECT * FROM gal_procesos WHERE id = ?').get(ids[0]),
    reparto: esMezcla ? { grupo, lotes, nombres, kilos: kilosPorLote,
                          pct: pesos.map((x) => Math.round(x * 1000) / 10) } : null,
    aviso: motivo,
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

  let kg = fila.kilos;
  /* Si cambió la presentación, manda la nueva; si no, la que tenía la fila. Y eso
     decide también QUÉ se pide: bultos o kilos. */
  const granel = pres ? !!pres.granel : fila.bultos == null;
  const porB = pres ? pres.por_bulto : fila.por_bulto;
  const kgU = pres ? pres.kg_unidad : fila.kg_unidad;

  if (!granel) {
    const b = 'bultos' in dd ? numPos(dd.bultos) : fila.bultos;
    if (b == null) return { ok: false, motivo: 'Poné cuántos bultos entraron' };
    kg = kilosDeProceso(b, porB, kgU);
    if (kg == null) return { ok: false, motivo: 'La presentación tiene mal la cuenta' };
    poner('bultos', b);
    poner('kilos', kg);
  } else if (pres || 'kilos' in dd) {
    const k = 'kilos' in dd ? numPos(dd.kilos) : fila.kilos;
    if (k == null) return { ok: false, motivo: 'Poné los kilos' };
    kg = k;
    poner('bultos', null);
    poner('kilos', kg);
  }

  if (!sets.length) return { ok: true, id: i, fila };

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

  db.prepare('UPDATE gal_procesos SET ' + sets.join(', ') + ' WHERE id = ?').run(...val, i);
  return { ok: true, id: i, aviso: motivo,
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

// ── LO PROCESADO UN DÍA ─────────────────────────────────────────────────────────────
export function procesosDelDia(db, fecha, loteId) {
  const f = esFecha(fecha);
  if (!f) return [];
  const ls = idsDeLotes(loteId);
  return db.prepare(
    ' SELECT * FROM gal_procesos'
    + '  WHERE fecha = ? AND eliminado_en IS NULL'
    + (ls.length ? ' AND lote_id IN (' + ls.map(() => '?').join(',') + ')' : '')
    + '  ORDER BY id DESC').all(f, ...ls);
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
   en la numeración de los pallets es lo que después nadie puede explicar. */
export function proximoNumero(db, fecha) {
  const f = esFecha(fecha) || '';
  const anio = f ? f.slice(2, 4) : String(new Date().getFullYear()).slice(2);
  const pref = (valorConfig(db, 'pallet_prefijo') || 'PC') + '-' + anio + '-';
  const ult = db.prepare(
    ' SELECT numero FROM gal_pallets WHERE numero LIKE ?'
    + ' ORDER BY numero DESC LIMIT 1').get(pref + '%');
  const n = ult ? (parseInt(String(ult.numero).slice(pref.length), 10) || 0) : 0;
  return pref + String(n + 1).padStart(5, '0');
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
    + '       COUNT(*) AS filas'
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

  const lote = parseInt(dd.lote_id, 10);
  if (!Number.isFinite(lote)) return { ok: false, motivo: 'Falta el lote' };
  const destino = txt(dd.destino);
  if (!DESTINOS.some((y) => y.clave === destino)) return { ok: false, motivo: 'Destino inválido' };
  const pres = parseInt(dd.presentacion_id, 10) || 0;
  const cal = txt(dd.calibre) || '';
  const desde = dd.pallet_id == null || dd.pallet_id === '' ? null
    : (parseInt(dd.pallet_id, 10) || null);
  if (desde === pid) return { ok: false, motivo: 'Eso ya está en este pallet' };

  // Las filas candidatas: la misma mercadería, en la misma ubicación de origen.
  const filas = db.prepare(
    ' SELECT * FROM gal_procesos'
    + "  WHERE eliminado_en IS NULL AND tipo = 'ingreso' AND lote_id = ? AND destino = ?"
    + "    AND COALESCE(presentacion_id,0) = ? AND COALESCE(calibre,'') = ?"
    + (desde ? '    AND pallet_id = ?' : '    AND pallet_id IS NULL')
    + '  ORDER BY fecha, id').all(...[lote, destino, pres, cal]
      .concat(desde ? [desde] : []));
  if (!filas.length) return { ok: false, motivo: 'De eso no hay nada en esa ubicación' };

  const granel = !filas.some((f) => f.bultos != null);
  /* El tope sale del SALDO de esa ubicación y no de la suma de las filas de ingreso:
     después de despachar, las cajas están en un camión y las filas de ingreso siguen
     ahí. Sumarlas ofrecería mover mercadería que ya se fue. */
  const saldo = stockParaArmar(db).find((x) => x.lote_id === lote
    && x.destino === destino
    && (x.presentacion_id || 0) === pres
    && (x.calibre || '') === cal
    && (x.pallet_id || null) === desde);
  const hayB = saldo ? saldo.bultos : 0;
  const hayK = saldo ? saldo.kilos : 0;
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
    if (granel) faltaK = round2(faltaK - tomaK); else faltaB = round2(faltaB - tomaB);
  }

  return { ok: true, id: pid, movidas,
           bultos: pideB, kilos: granel ? pideK : null,
           /* De dónde salieron, para poder decirlo en pantalla: sacarle cajas a un
              pallet cerrado lo deja distinto de su tarjetón, y el que lo hizo tiene que
              enterarse en el momento, no cuando llega el camión. */
           desde: desde ? palletResumen(db, desde) : null,
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
export function lineasDelPallet(db, palletId) {
  const i = parseInt(palletId, 10);
  if (!Number.isFinite(i)) return [];
  return db.prepare(
    ' SELECT id, fecha, lote_id, lote_nombre, producto, destino, presentacion,'
    + '       categoria, calibre, variedad, bultos, kilos, partido_de'
    + "  FROM gal_procesos WHERE pallet_id = ? AND eliminado_en IS NULL AND tipo = 'ingreso'"
    + '  ORDER BY id').all(i).map((f) => Object.assign(f, {
    bultos: round2(f.bultos), kilos: round2(f.kilos),
  }));
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
function saldosDeStock(db, opts) {
  const o = opts || {};
  const filas = db.prepare(
    ' SELECT lote_id, lote_nombre, producto, destino, presentacion_id, presentacion,'
    + '       categoria, calibre, variedad, envase,'
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN bultos ELSE -bultos END),0) AS bultos,"
    + "       COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN kilos ELSE -kilos END),0) AS kilos,"
    /* Granel = en esta línea NUNCA hubo bultos. Deducirlo de «bultos llegó a 0» haría
       que una línea de cajas agotada se trate como granel y pida kilos. */
    + '       COUNT(bultos) AS con_bultos'
    + '  FROM gal_procesos WHERE eliminado_en IS NULL'
    + (o.destino ? ' AND destino = ?' : '')
    + '  GROUP BY lote_id, destino, presentacion_id, categoria, calibre'
    + '  ORDER BY destino, lote_nombre, presentacion').all(...(o.destino ? [txt(o.destino)] : []));

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

// ── QUÉ SE PUEDE DESPACHAR ──────────────────────────────────────────────────────────
// Lo que HAY, por línea: no «200 kg de damasco» sino «la caja 50/55 comercial del lote
// 10». Es la unidad con la que se carga un camión, y es lo que alimenta el selector de
// la ventana: por eso las líneas agotadas no salen.
export function disponibleParaDespacho(db, opts) {
  return saldosDeStock(db, opts).filter((f) => f.bultos > 0 || f.kilos > 0);
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
  /* Contra el SALDO, no contra el disponible: así una línea agotada puede contestar
     «hay 0 cajas de eso» en vez de «no existe». */
  const disp = saldosDeStock(db).find((f) => f.lote_id === lote
    && f.destino === destino
    && (f.presentacion_id || 0) === pres
    && (f.calibre || '') === cal);
  if (!disp) return { ok: false, motivo: 'De eso nunca entró nada al galpón' };

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
    && (x.bultos > 0 || x.kilos > 0));
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
