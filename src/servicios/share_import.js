// src/servicios/share_import.js
// ── EL IMPORTADOR DEL PLANNING ────────────────────────────────────────────────────────
// Un solo importador para los dos caminos: el botón de la pantalla y el script de carga
// masiva. Si cada uno tuviera el suyo, el histórico y lo que se carga todos los días
// quedarían normalizados distinto y ningún informe que cruce las dos épocas serviría.
//
// La base se pasa por parámetro (no se importa) para poder correr el importador contra una
// base en memoria en los tests: better-sqlite3 no compila en la máquina de Andy, así que la
// única forma de probar esto antes de subirlo es con node:sqlite.
import crypto from 'crypto';
import * as XLSX from 'xlsx';
import { norm, parseDesc, parseProveedor, parseFecha, parseBultos, fechaDelNombre, clasificarFamilia, FAMILIAS_VALIDAS, parseDescOferta } from './share_parser.js';

const HOJA = 'Detallado';

// Los cuatro títulos que tiene que traer la hoja. Se comparan normalizados —mayúsculas y un
// solo espacio entre palabras— porque un guión bajo de más no debería voltear una carga.
const COLS = {
  proveedor: 'PROVEEDOR ORIGEN DESC',
  fecha:     'FECHA ENTREGA',
  desc:      'DESC',
  bultos:    'BULTOS',
};
const normTit = (s) => String(s == null ? '' : s)
  .normalize('NFD').replace(/\p{M}/gu, '')
  .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

export function hashArchivo(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ── Leer el .xlsx ─────────────────────────────────────────────────────────────────────
// FALLA CON UN MENSAJE CLARO, NO ADIVINA. Si la hoja no se llama Detallado o falta una
// columna, se corta acá diciendo qué encontró. Un importador que adivina columnas contra un
// archivo viejo con otro formato carga números plausibles y equivocados, y eso no se
// descubre nunca.
export function leerPlanilla(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    throw new Error('No se pudo abrir el archivo como Excel: ' + e.message);
  }
  const nombreHoja = wb.SheetNames.find(n => normTit(n) === normTit(HOJA));
  if (!nombreHoja) {
    throw new Error(`El archivo no tiene la hoja "${HOJA}". Tiene: ${wb.SheetNames.join(', ') || '(ninguna)'}`);
  }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[nombreHoja], { header: 1, raw: true, defval: null, blankrows: false });
  if (!filas.length) throw new Error(`La hoja "${nombreHoja}" está vacía.`);

  const titulos = (filas[0] || []).map(normTit);
  const idx = {};
  for (const [k, esperado] of Object.entries(COLS)) {
    const i = titulos.indexOf(esperado);
    if (i < 0) {
      throw new Error(
        `Falta la columna "${esperado}" en la hoja "${nombreHoja}". ` +
        `Los títulos que trae son: ${titulos.filter(Boolean).join(' | ') || '(ninguno)'}`
      );
    }
    idx[k] = i;
  }

  const datos = [], rechazadas = [];
  for (let i = 1; i < filas.length; i++) {
    const r = filas[i] || [];
    const provRaw = r[idx.proveedor], descRaw = r[idx.desc];
    const fecha = parseFecha(r[idx.fecha]);
    const bultos = parseBultos(r[idx.bultos]);
    // Fila totalmente vacía: es el relleno del final de la hoja, no un problema.
    if (provRaw == null && descRaw == null && r[idx.fecha] == null && r[idx.bultos] == null) continue;

    const motivos = [];
    if (!provRaw || !String(provRaw).trim()) motivos.push('sin proveedor');
    if (!descRaw || !String(descRaw).trim()) motivos.push('sin descripción');
    if (!fecha) motivos.push('fecha ilegible (' + JSON.stringify(r[idx.fecha]) + ')');
    if (bultos == null) motivos.push('bultos ilegibles (' + JSON.stringify(r[idx.bultos]) + ')');
    if (motivos.length) { rechazadas.push({ fila: i + 1, motivo: motivos.join(', ') }); continue; }

    datos.push({ fila: i + 1, proveedor_raw: String(provRaw).trim(), articulo_raw: String(descRaw).trim(), fecha_entrega: fecha, bultos });
  }

  return { hoja: nombreHoja, filas: datos, rechazadas };
}

// ── Analizar: todo lo que se puede saber SIN escribir ─────────────────────────────────
// Es lo que alimenta el preview de la pantalla y lo que decide si la carga se puede hacer.
// El importador de verdad lo llama primero, así que la pantalla ve exactamente lo que va a
// pasar y no una aproximación.
export function analizar(db, { buffer, nombre }) {
  const hash = hashArchivo(buffer);
  const yaEsta = db.prepare('SELECT id, archivo_nombre, cargado_at, estado FROM share_cargas WHERE hash_sha256 = ?').get(hash);

  const { hoja, filas, rechazadas } = leerPlanilla(buffer);
  const warnings = [];
  if (rechazadas.length) {
    warnings.push(`${rechazadas.length} fila(s) no se pueden cargar y se van a saltear: ` +
      rechazadas.slice(0, 5).map(r => `fila ${r.fila} (${r.motivo})`).join('; ') +
      (rechazadas.length > 5 ? `; y ${rechazadas.length - 5} más` : ''));
  }
  if (!filas.length) throw new Error('No quedó ninguna fila cargable en el archivo.');

  // Las fechas que cubre el archivo. La "dominante" es la que más bultos tiene: en un
  // planning de un solo día es la única, y en uno de varios es la que lo identifica.
  const porFecha = new Map();
  for (const f of filas) porFecha.set(f.fecha_entrega, (porFecha.get(f.fecha_entrega) || 0) + f.bultos);
  const fechas = [...porFecha.keys()].sort();
  const dominante = [...porFecha.entries()].sort((a, b) => b[1] - a[1])[0][0];
  if (fechas.length > 1) {
    warnings.push(`El archivo cubre ${fechas.length} fechas (${fechas[0]} a ${fechas[fechas.length - 1]}). Se carga completo; la fecha del encabezado es ${dominante}.`);
  }

  // LA FECHA MANDA DESDE LA FILA. El nombre del archivo sólo sirve para avisar: si dicen
  // cosas distintas, casi siempre es que alguien renombró un archivo a mano.
  const delNombre = fechaDelNombre(nombre, parseInt(dominante.slice(0, 4), 10));
  if (delNombre && !fechas.includes(delNombre)) {
    warnings.push(`El nombre del archivo sugiere ${delNombre} pero las filas dicen ${fechas.join(', ')}. Manda la fila.`);
  }

  // ── Qué cargas activas pisa este archivo ──────────────────────────────────────────
  const setNuevas = new Set(fechas);
  // El GROUP_CONCAT tiene que traer TODAS las fechas de la carga vieja, no sólo las que caen
  // en el rango del archivo nuevo: si se filtrara por el rango en el JOIN, una carga que
  // cubre 23 y 24 se vería como si cubriera sólo el 24 y la daríamos por sustituida — y el
  // 23 desaparecería de la base sin que nadie lo pida.
  const previas = db.prepare(`
    SELECT c.id, c.archivo_nombre, c.fecha_entrega, c.cargado_at,
           GROUP_CONCAT(DISTINCT l.fecha_entrega) AS fechas
      FROM share_cargas c JOIN share_lineas l ON l.carga_id = c.id
     WHERE c.estado = 'activa'
       AND c.id IN (SELECT DISTINCT carga_id FROM share_lineas WHERE fecha_entrega BETWEEN ? AND ?)
     GROUP BY c.id`).all(fechas[0], fechas[fechas.length - 1]);

  const reemplaza = [], conflictos = [];
  for (const p of previas) {
    const suyas = String(p.fechas || '').split(',').filter(Boolean).sort();
    const comunes = suyas.filter(f => setNuevas.has(f));
    // Sin ningún día en común no hay nada que decidir: el rango se pidió de punta a punta y
    // puede haber traído una carga de un día que este archivo ni menciona.
    if (!comunes.length) continue;
    // Si todo lo que cubría la carga vieja está en la nueva, la nueva la sustituye entera:
    // es el caso normal de "me remandaron el planning corregido".
    if (comunes.length === suyas.length) reemplaza.push({ ...p, fechas: suyas });
    // Si se pisan a medias, NO se adivina. Reemplazarla perdería los días que la nueva no
    // trae; dejarla contaría dos veces los días compartidos. Las dos opciones dan un total
    // equivocado sin avisar, así que se frena y lo resuelve una persona.
    else conflictos.push({ ...p, fechas: suyas, comunes });
  }

  // ── Qué artículos y proveedores son nuevos ────────────────────────────────────────
  const provs = new Map(), arts = new Map();
  for (const f of filas) {
    const p = parseProveedor(f.proveedor_raw);
    if (!provs.has(p.nombre_canonico)) provs.set(p.nombre_canonico, p);
    const a = parseDesc(f.articulo_raw);
    if (!arts.has(a.desc_canonica)) arts.set(a.desc_canonica, a);
  }
  const provNuevos = [...provs.values()].filter(p => !resolverProveedor(db, p, false));
  const artNuevos  = [...arts.values()].filter(a => !resolverArticulo(db, a, false));
  const sinMapear  = filas.filter(f => parseDesc(f.articulo_raw).unidad === 'SIN_DEFINIR').length;
  if (sinMapear) warnings.push(`${sinMapear} fila(s) con una unidad que no se reconoce: entran igual y quedan en la cola de mapeo.`);

  return {
    hash, hoja, nombre,
    duplicado: yaEsta || null,
    fechas, fecha_entrega: dominante,
    fecha_desde: fechas[0], fecha_hasta: fechas[fechas.length - 1],
    filas: filas.length,
    bultos_total: Math.round(filas.reduce((s, f) => s + f.bultos, 0) * 1000) / 1000,
    proveedores: provs.size, articulos: arts.size,
    proveedores_nuevos: provNuevos.map(p => p.nombre_canonico),
    articulos_nuevos: artNuevos.map(a => a.desc_canonica),
    filas_sin_mapear: sinMapear,
    rechazadas, warnings, reemplaza, conflictos,
    // Se puede cargar si no está duplicado y no hay solapamiento parcial sin resolver.
    puede_cargar: !yaEsta && conflictos.length === 0,
    _filas: filas,
  };
}

// ── Resolver (y opcionalmente crear) el proveedor ─────────────────────────────────────
// El orden es alias → canónico → crear. El alias va primero porque es la corrección manual:
// si alguien fusionó dos escrituras del mismo proveedor, esa decisión tiene que ganarle al
// texto que venga en el archivo.
function resolverProveedor(db, p, crear) {
  const al = db.prepare("SELECT destino_id FROM share_alias WHERE tipo='proveedor' AND alias_raw=?").get(p.nombre_canonico);
  if (al) return al.destino_id;
  const ex = db.prepare('SELECT id FROM share_proveedores WHERE nombre_canonico=?').get(p.nombre_canonico);
  if (ex) return ex.id;
  if (!crear) return null;
  const r = db.prepare(
    'INSERT INTO share_proveedores (nombre_canonico, es_nosotros, tipo, pendiente_revision) VALUES (?,?,?,1)'
  ).run(p.nombre_canonico, p.es_nosotros, p.tipo);
  return Number(r.lastInsertRowid);
}

function resolverArticulo(db, a, crear) {
  const al = db.prepare("SELECT destino_id FROM share_alias WHERE tipo='articulo' AND alias_raw=?").get(norm(a.raw));
  if (al) return al.destino_id;
  const ex = db.prepare('SELECT id FROM share_articulos WHERE desc_canonica=?').get(a.desc_canonica);
  if (ex) return ex.id;
  if (!crear) return null;
  const r = db.prepare(`INSERT INTO share_articulos
      (desc_canonica, articulo_base, calidad, familia, unidad, gramos, factor_kg, pendiente_revision)
      VALUES (?,?,?,?,?,?,?,1)`).run(
    a.desc_canonica, a.articulo_base, a.calidad, a.familia, a.unidad, a.gramos, a.factor_kg);
  return Number(r.lastInsertRowid);
}

// ── Importar ──────────────────────────────────────────────────────────────────────────
// TODO ADENTRO DE UNA TRANSACCIÓN. Son ~430 filas por archivo y hasta 500 archivos: si una
// carga se corta por la mitad queda un día con la mitad de los bultos, y ese día se ve como
// una caída de mercado en todos los informes.
export function importar(db, { buffer, nombre, usuario, usuarioId, forzar }) {
  const a = analizar(db, { buffer, nombre });

  if (a.duplicado) return { ok: true, salteado: 'duplicado', carga_id: a.duplicado.id, analisis: a };
  if (a.conflictos.length && !forzar) {
    const c = a.conflictos[0];
    return {
      ok: false, salteado: 'conflicto', analisis: a,
      error: `El archivo se pisa a medias con la carga #${c.id} (${c.archivo_nombre}), que cubre ${c.fechas.join(', ')} ` +
             `y comparte ${c.comunes.join(', ')}. Reemplazarla perdería los días que este archivo no trae y dejarla ` +
             `contaría dos veces los compartidos. Borrá esa carga primero si ya no vale.`,
    };
  }

  const correr = db.transaction(() => {
    const r = db.prepare(`INSERT INTO share_cargas
        (archivo_nombre, hash_sha256, fecha_entrega, fecha_desde, fecha_hasta, filas, bultos_total,
         filas_sin_mapear, warnings, cargado_por, cargado_por_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      nombre, a.hash, a.fecha_entrega, a.fecha_desde, a.fecha_hasta, a.filas, a.bultos_total,
      a.filas_sin_mapear, JSON.stringify({ warnings: a.warnings, rechazadas: a.rechazadas }),
      usuario || null, usuarioId || null);
    const cargaId = Number(r.lastInsertRowid);

    // Las cargas que este archivo sustituye por completo. No se borran: quedan marcadas y
    // fuera de la vista share_v, que es lo que miran todas las consultas.
    for (const p of a.reemplaza) {
      db.prepare("UPDATE share_cargas SET estado='reemplazada', reemplazada_por=?, reemplazada_en=datetime('now','localtime') WHERE id=?")
        .run(cargaId, p.id);
    }

    // Cachés por corrida: sin esto son dos SELECT por fila (860 consultas por archivo) y la
    // carga de 500 archivos pasa de minutos a horas.
    const cacheP = new Map(), cacheA = new Map();
    const ins = db.prepare(`INSERT INTO share_lineas
      (carga_id, fecha_entrega, proveedor_raw, proveedor_id, articulo_raw, articulo_id, bultos, unidad, kg_equiv)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const getArt = db.prepare('SELECT unidad, factor_kg FROM share_articulos WHERE id=?');

    for (const f of a._filas) {
      const p = parseProveedor(f.proveedor_raw);
      let pid = cacheP.get(p.nombre_canonico);
      if (pid === undefined) { pid = resolverProveedor(db, p, true); cacheP.set(p.nombre_canonico, pid); }

      const art = parseDesc(f.articulo_raw);
      let aid = cacheA.get(art.desc_canonica);
      if (aid === undefined) { aid = resolverArticulo(db, art, true); cacheA.set(art.desc_canonica, aid); }

      // La unidad y el factor salen del ARTÍCULO, no del parseo de esta fila: si alguien
      // corrigió a mano que el atado son 0,4 kg, esa corrección tiene que aplicarse también
      // a lo que se cargue mañana. Si no, el mapeo manual duraría hasta el próximo archivo.
      const meta = getArt.get(aid) || {};
      const factor = meta.factor_kg == null ? null : Number(meta.factor_kg);
      ins.run(cargaId, f.fecha_entrega, f.proveedor_raw, pid, f.articulo_raw, aid, f.bultos,
        meta.unidad || art.unidad, factor == null ? null : f.bultos * factor);
    }
    return cargaId;
  });

  const cargaId = correr();
  return { ok: true, carga_id: cargaId, analisis: a };
}

// ── Migrar los artículos que quedaron con una familia que ya no existe ────────────────
// Las familias cambiaron: donde había VERDURA y HONGO ahora hay HORTALIZA PESADA (lo que va
// en bolsa) y HORTALIZA LIVIANA (lo que va en cajón). Los artículos ya cargados se quedaron
// con la etiqueta vieja, y una familia que no está en la lista es peor que ninguna: el filtro
// no la ofrece, el share por familia la muestra como un renglón fantasma y no hay forma de
// corregirla desde la pantalla porque el desplegable no la tiene.
//
// SÓLO toca lo que quedó fuera del vocabulario nuevo. Un artículo que ya dice FRUTA, HOJA u
// OTRO no se mira: si alguien lo corrigió a mano, esa decisión manda sobre el clasificador.
// Y por eso mismo es idempotente — después de la primera corrida no queda nada que migrar.
export function reclasificarFamilias(db) {
  const validas = new Set(FAMILIAS_VALIDAS);
  const filas = db.prepare('SELECT id, desc_canonica, articulo_base, familia FROM share_articulos').all();
  const pendientes = filas.filter(a => !validas.has(a.familia));
  if (!pendientes.length) return { migrados: 0, detalle: {} };

  const upd = db.prepare('UPDATE share_articulos SET familia=? WHERE id=?');
  const detalle = {};
  const correr = db.transaction(() => {
    for (const a of pendientes) {
      // Se reclasifica desde el NOMBRE, no desde la familia vieja: traducir VERDURA→algo
      // sería adivinar, y el nombre es el dato que sí distingue una papa de un tomate.
      const f = clasificarFamilia(a.articulo_base || a.desc_canonica);
      upd.run(f, a.id);
      detalle[f] = (detalle[f] || 0) + 1;
    }
  });
  correr();
  return { migrados: pendientes.length, detalle };
}

// ── Recalcular kg_equiv de un artículo ────────────────────────────────────────────────
// Cuando en Mapeos se corrige la unidad o el factor, las líneas YA cargadas tienen el
// kg_equiv viejo. Sin esto, la corrección arreglaría el futuro y dejaría el histórico mal, y
// el gráfico mostraría un escalón el día que alguien tocó el mapeo.
export function recalcularKg(db, articuloId) {
  const a = db.prepare('SELECT unidad, factor_kg FROM share_articulos WHERE id=?').get(articuloId);
  if (!a) return 0;
  // Sin factor no hay kilos: se pone NULL en vez de cero. Un cero suma en los totales y hace
  // que un agregado en kilos parezca completo estando incompleto; el NULL lo deja afuera y
  // la pantalla puede decir cuántos artículos quedaron sin convertir.
  const r = a.factor_kg == null
    ? db.prepare('UPDATE share_lineas SET unidad=?, kg_equiv=NULL WHERE articulo_id=?').run(a.unidad, articuloId)
    : db.prepare('UPDATE share_lineas SET unidad=?, kg_equiv=bultos*? WHERE articulo_id=?').run(a.unidad, Number(a.factor_kg), articuloId);
  return r.changes;
}

// ── LA OFERTA DEL DÍA ─────────────────────────────────────────────────────────────────
// Se resuelve el artículo con EL MISMO camino que el planning —alias, forma canónica, y si no
// existe se crea— porque de eso depende que la comparación cruce. Si la oferta creara sus
// propios artículos, "MANZANA X KG" ofrecida y "MANZANA X KG" comprada serían dos cosas y no
// habría con qué compararlas.
//
// OFRECER UN ARTÍCULO ES LA PRUEBA DE QUE LO VENDEMOS, así que cargar la oferta marca
// `la_vendemos` en todo lo que trae. Ese es el filtro de Oportunidades, y es la lista que
// nadie tiene ganas de mantener a mano: acá se mantiene sola.
// EL EAN MANDA. Es el mismo número siempre, así que cruza aunque alguien escriba el artículo
// distinto de un día para el otro — y eso pasa: "CEBOLLA X KG calibre 4" un martes y "CEBOLLA
// X KG cal 4" el jueves. Recién si no hay EAN conocido se cae al nombre, con el mismo camino
// del planning (alias → forma canónica → crear).
//
// Y al revés: cuando un artículo se resuelve por nombre y la línea trae EAN, se le graba el
// EAN al artículo. Así la primera carga enseña y las siguientes ya cruzan solas.
function resolverArticuloOferta(db, linea, crear) {
  const p = parseDescOferta(linea.articulo_raw);
  const ean = linea.ean ? String(linea.ean).replace(/[^\d]/g, '') : null;

  if (ean) {
    const porEan = db.prepare('SELECT id FROM share_articulos WHERE ean = ?').get(ean);
    if (porEan) return { id: porEan.id, parse: p, ean, via: 'ean' };
  }
  const id = resolverArticulo(db, p, false);
  if (id) {
    if (ean) db.prepare('UPDATE share_articulos SET ean = ? WHERE id = ? AND (ean IS NULL OR ean = \'\')').run(ean, id);
    return { id, parse: p, ean, via: 'nombre' };
  }
  if (!crear) return { id: null, parse: p, ean, via: null };
  const nuevo = resolverArticulo(db, p, true);
  if (ean) db.prepare('UPDATE share_articulos SET ean = ? WHERE id = ?').run(ean, nuevo);
  return { id: nuevo, parse: p, ean, via: 'nuevo' };
}

export function analizarOferta(db, { filas, fecha }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) {
    throw new Error('Falta la fecha de la oferta (AAAA-MM-DD).');
  }
  if (!filas || !filas.length) throw new Error('No hay ninguna línea con artículo y cantidad.');

  // Un mismo artículo puede venir en dos renglones (dos calidades escritas distinto que
  // canonizan igual): se suman en vez de quedarse con el último.
  const porArt = new Map();
  for (const f of filas) {
    const r = resolverArticuloOferta(db, f, false);
    // Se agrupa por el artículo YA RESUELTO (por EAN o por nombre) y no por el texto: dos
    // renglones escritos distinto que son el mismo artículo tienen que sumarse, no competir.
    const clave = r.id ? 'id:' + r.id : 'txt:' + r.parse.desc_canonica;
    const prev = porArt.get(clave);
    if (prev) {
      prev.cantidad += f.cantidad; prev.repetido = true;
      if (!prev.precio && f.precio) prev.precio = f.precio;
    } else {
      porArt.set(clave, { resuelto: r, parse: r.parse, articulo_raw: f.articulo_raw, cantidad: f.cantidad,
        ean: r.ean, precio: f.precio || null, variedad: f.variedad || null, zona: f.zona || null,
        observacion: f.observacion || null });
    }
  }

  const items = [...porArt.values()].map(x => {
    const id = x.resuelto.id;
    const ya = id ? db.prepare('SELECT desc_canonica, la_vendemos FROM share_articulos WHERE id=?').get(id) : null;
    return {
      articulo_raw: x.articulo_raw,
      desc_canonica: x.parse.desc_canonica,
      // Con qué nombre quedó cruzado. Cuando el de la oferta y el del planning no son iguales
      // —que es lo normal— la pantalla tiene que mostrar los dos, o no hay forma de saber si
      // cruzó donde correspondía.
      cruza_con: ya ? ya.desc_canonica : null,
      via: x.resuelto.via,
      ean: x.ean || null,
      precio: x.precio, variedad: x.variedad, zona: x.zona, observacion: x.observacion,
      cantidad: x.cantidad,
      repetido: !!x.repetido,
      articulo_id: id || null,
      // Nuevo = Carrefour nunca lo compró (o lo escribe distinto). No es un error: es
      // exactamente lo que hay que mirar, porque significa que estamos ofreciendo algo que
      // el CD no registra comprando.
      nuevo: !id,
      ya_marcado: !!(ya && ya.la_vendemos),
    };
  }).sort((a, b) => b.cantidad - a.cantidad);

  const previa = db.prepare("SELECT id, archivo_nombre, creado_en, filas FROM share_ofertas WHERE fecha=? AND estado='activa'").get(fecha);
  return {
    fecha,
    filas: items.length,
    bultos_total: Math.round(items.reduce((s, x) => s + x.cantidad, 0) * 1000) / 1000,
    nuevos: items.filter(x => x.nuevo).length,
    repetidos: items.filter(x => x.repetido).length,
    reemplaza: previa || null,
    items,
  };
}

export function importarOferta(db, { filas, fecha, origen, nombre, notas, usuario, usuarioId }) {
  const a = analizarOferta(db, { filas, fecha });

  const correr = db.transaction(() => {
    // Una sola oferta activa por día. La anterior no se borra: queda para poder mirar qué se
    // había ofrecido antes de corregirla.
    if (a.reemplaza) {
      db.prepare("UPDATE share_ofertas SET estado='reemplazada', reemplazada_en=datetime('now','localtime') WHERE id=?").run(a.reemplaza.id);
    }
    const r = db.prepare(`INSERT INTO share_ofertas
      (fecha, origen, archivo_nombre, filas, bultos_total, notas, cargado_por, cargado_por_id)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      fecha, origen || 'texto', nombre || null, a.filas, a.bultos_total,
      notas || null, usuario || null, usuarioId || null);
    const ofertaId = Number(r.lastInsertRowid);
    if (a.reemplaza) db.prepare('UPDATE share_ofertas SET reemplazada_por=? WHERE id=?').run(ofertaId, a.reemplaza.id);

    const ins = db.prepare(`INSERT INTO share_oferta_lineas
      (oferta_id, fecha, articulo_raw, articulo_id, cantidad, ean, precio, variedad, zona, observacion)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const marcar = db.prepare('UPDATE share_articulos SET la_vendemos=1 WHERE id=? AND la_vendemos=0');
    for (const it of a.items) {
      const aid = it.articulo_id || resolverArticuloOferta(db, it, true).id;
      ins.run(ofertaId, fecha, it.articulo_raw, aid, it.cantidad,
        it.ean || null, it.precio == null ? null : Number(it.precio),
        it.variedad || null, it.zona || null, it.observacion || null);
      marcar.run(aid);
    }
    return ofertaId;
  });

  return { ok: true, oferta_id: correr(), analisis: a };
}
