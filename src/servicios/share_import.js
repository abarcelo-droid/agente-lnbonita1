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
import { norm, parseDesc, parseProveedor, parseFecha, parseBultos, fechaDelNombre, clasificarFamilia, FAMILIAS_VALIDAS } from './share_parser.js';

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
