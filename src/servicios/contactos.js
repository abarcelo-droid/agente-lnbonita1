// src/servicios/contactos.js
// ── EL BUSCADOR DE CONTACTOS, Y LO QUE LA BASE YA SABE ───────────────────────────────
// Dos cosas viven acá: cómo se busca, y cómo se arma la ficha.
//
// ── POR QUÉ EL BUSCADOR MIRA TAMBIÉN ADENTRO DE LAS CHARLAS ──────────────────────────
// Un buscador que sólo mira nombre y empresa sirve cuando uno YA sabe a quién busca. El
// caso de verdad es al revés: "¿quién me habló de brócoli?", "¿con quién había quedado en
// volver a llamar?". Eso está escrito en el resumen de una charla y en ningún campo.
//
// Por eso se busca en: nombre, empresa, cargo, zona, localidad, etiquetas, notas, los
// teléfonos y mails, los productos declarados, y el texto de las charlas. Y la respuesta
// DICE POR DÓNDE MATCHEÓ (`porque`), porque encontrar a alguien sin saber por qué apareció
// obliga a abrir la ficha para entenderlo.
//
// ── LO DECLARADO Y LO OBSERVADO NO SE MEZCLAN ────────────────────────────────────────
// Lo que el productor dice que tiene (sg_contacto_productos) y lo que efectivamente le
// compramos (sheet_ventas) son dos cosas distintas. Puede ofrecer brócoli y no habérselo
// comprado nunca: ese hueco es una oportunidad, y mezclarlos lo haría invisible.
//
// La db entra por parámetro: así los tests corren con node:sqlite.

// El año comercial arranca en JULIO. La máscara de meses tiene doce posiciones y la
// primera es julio — igual que mes_ok en la planilla ('01-JULIO' … '12-JUN').
export const MESES = ['JUL','AGO','SEP','OCT','NOV','DIC','ENE','FEB','MAR','ABR','MAY','JUN'];
export const TIPOS = ['cliente', 'proveedor', 'ambos', 'otro'];
export const CANALES = ['telefono', 'whatsapp', 'mail', 'visita', 'otro'];

// '000011111000' → ['NOV','DIC','ENE','FEB','MAR']
export function mesesDeMascara(mascara) {
  const m = String(mascara || '');
  return MESES.filter((_, i) => m[i] === '1');
}
// Y la ventana en palabras. Con dos tramos ('NOV a ENE' y 'ABR a MAY') se dicen los dos:
// un productor con cosecha temprana y tardía no tiene UNA ventana, tiene dos, y aplastarlas
// en "NOV a MAY" diría que trae en febrero cuando no trae.
export function ventanaEnPalabras(mascara) {
  const m = String(mascara || '');
  const tramos = [];
  let ini = -1;
  for (let i = 0; i <= 12; i++) {
    const on = m[i] === '1';
    if (on && ini < 0) ini = i;
    if (!on && ini >= 0) { tramos.push([ini, i - 1]); ini = -1; }
  }
  if (!tramos.length) return '';
  return tramos.map(([a, b]) => (a === b ? MESES[a] : MESES[a] + ' a ' + MESES[b])).join(' y ');
}
export function mascaraValida(m) {
  return typeof m === 'string' && /^[01]{12}$/.test(m);
}

// ── LAS TILDES NO PUEDEN ESCONDER A NADIE ────────────────────────────────────────────
// Nadie tipea 'brócoli' con tilde en un buscador, y el LIKE de SQLite sólo ignora las
// mayúsculas del ASCII: 'brocoli' NO encuentra 'brócoli'. La lista vuelve vacía, se lee
// como 'no está cargado', y el comercial carga el contacto de nuevo. A los tres meses hay
// tres fichas del mismo productor con un tercio de las charlas cada una.
//
// Se dobla a los dos lados: el texto guardado y lo que se tipeó. SQLite no tiene una
// función para esto, así que es una cadena de replace() armada acá — fea de leer y la
// escribe el generador, no una persona. Son siete vocales por dos cajas.
const TILDES = [['á','a'],['é','e'],['í','i'],['ó','o'],['ú','u'],['ü','u'],['ñ','n'],
                ['Á','a'],['É','e'],['Í','i'],['Ó','o'],['Ú','u'],['Ü','u'],['Ñ','n']];

// Envuelve una expresión SQL en la cadena de replace(). Lo que entra es SIEMPRE un nombre
// de columna escrito en este archivo, nunca algo que vino de afuera.
const sinT = (expr) => TILDES.reduce((e, [de, a]) => `replace(${e},'${de}','${a}')`, expr);

// Y el mismo doblez del lado de JavaScript, para el término buscado.
const plano = (s) => TILDES.reduce((t, [de, a]) => t.split(de).join(a), String(s == null ? '' : s));

const like = (s) => '%' + plano(s).trim() + '%';

// ── EL BUSCADOR ──────────────────────────────────────────────────────────────────────
// Devuelve los contactos que matchean, con por dónde matchearon y un pedacito del texto
// de la charla cuando el match fue ahí.
export function buscar(db, opciones) {
  const o = opciones || {};
  const q = String(o.q || '').trim();
  const limite = Math.min(Math.max(parseInt(o.limite, 10) || 60, 1), 300);

  const cond = ['c.eliminado_en IS NULL'];
  const par = [];
  if (!o.incluir_inactivos) cond.push('c.activo = 1');
  if (o.tipo && TIPOS.includes(o.tipo)) {
    // 'ambos' es un tipo guardado, pero pedir "clientes" tiene que traer también a los que
    // son las dos cosas: si no, el que compra y vende desaparece de las dos listas.
    if (o.tipo === 'cliente' || o.tipo === 'proveedor') {
      cond.push("(c.tipo = ? OR c.tipo = 'ambos')"); par.push(o.tipo);
    } else { cond.push('c.tipo = ?'); par.push(o.tipo); }
  }
  if (o.zona)     { cond.push('c.zona = ?');     par.push(o.zona); }
  if (o.vendedor) { cond.push('c.vendedor = ?'); par.push(o.vendedor); }
  if (o.producto) {
    cond.push(`EXISTS (SELECT 1 FROM sg_contacto_productos p
                        WHERE p.contacto_id = c.id AND p.producto = ?)`);
    par.push(o.producto);
  }
  // Un mes de la máscara: "¿quién tiene melón en noviembre?". La posición se valida acá y
  // no se interpola: substr con un número que vino de afuera es una puerta abierta.
  if (o.mes != null && o.mes !== '') {
    const i = parseInt(o.mes, 10);
    if (i >= 1 && i <= 12) {
      cond.push(`EXISTS (SELECT 1 FROM sg_contacto_productos p
                          WHERE p.contacto_id = c.id AND substr(p.meses, ?, 1) = '1')`);
      par.push(i);
    }
  }

  // El texto libre. Cada campo deja su marca para que la lista explique por qué trajo a
  // cada uno, y se filtra por esas marcas AFUERA, en una subconsulta.
  //
  // SQLite no deja usar un alias del SELECT en el WHERE de la misma consulta, así que o se
  // envuelve o se escriben las condiciones dos veces. Se envuelve: duplicarlas es garantizar
  // que algún día una se toque y la otra no, y entonces la lista trae a alguien y no sabe
  // decir por qué.
  const marcas = q ? `,
           CASE WHEN ${sinT('c.nombre')} LIKE ? OR ${sinT("IFNULL(c.empresa,'')")} LIKE ? THEN 1 ELSE 0 END AS m_nombre,
           CASE WHEN EXISTS (SELECT 1 FROM sg_contacto_medios m
                              WHERE m.contacto_id = c.id AND m.valor LIKE ?) THEN 1 ELSE 0 END AS m_medio,
           CASE WHEN EXISTS (SELECT 1 FROM sg_contacto_productos p
                              WHERE p.contacto_id = c.id
                                AND (${sinT('p.producto')} LIKE ? OR ${sinT("IFNULL(p.variedad,'')")} LIKE ?)) THEN 1 ELSE 0 END AS m_producto,
           CASE WHEN EXISTS (SELECT 1 FROM sg_contacto_charlas ch
                              WHERE ch.contacto_id = c.id AND ch.eliminado_en IS NULL
                                AND (${sinT('ch.resumen')} LIKE ? OR ${sinT("IFNULL(ch.proximo_paso,'')")} LIKE ?)) THEN 1 ELSE 0 END AS m_charla,
           CASE WHEN ${sinT("IFNULL(c.etiquetas,'')")} LIKE ? OR ${sinT("IFNULL(c.notas,'')")} LIKE ?
                  OR ${sinT("IFNULL(c.zona,'')")} LIKE ? OR ${sinT("IFNULL(c.localidad,'')")} LIKE ?
                  OR ${sinT("IFNULL(c.cargo,'')")} LIKE ? THEN 1 ELSE 0 END AS m_otro` : '';

  const interna = `
    SELECT c.*,
           (SELECT valor FROM sg_contacto_medios m
             WHERE m.contacto_id = c.id ORDER BY m.preferido DESC, m.id LIMIT 1) AS medio_principal,
           (SELECT tipo FROM sg_contacto_medios m
             WHERE m.contacto_id = c.id ORDER BY m.preferido DESC, m.id LIMIT 1) AS medio_tipo,
           (SELECT COUNT(*) FROM sg_contacto_charlas ch
             WHERE ch.contacto_id = c.id AND ch.eliminado_en IS NULL) AS charlas,
           (SELECT MAX(fecha) FROM sg_contacto_charlas ch
             WHERE ch.contacto_id = c.id AND ch.eliminado_en IS NULL) AS ultima_charla,
           (SELECT COUNT(*) FROM sg_contacto_charlas ch
             WHERE ch.contacto_id = c.id AND ch.eliminado_en IS NULL
               AND ch.proximo_paso IS NOT NULL AND ch.proximo_paso <> '' AND ch.hecho_en IS NULL) AS pendientes,
           (SELECT group_concat(p.producto, ', ') FROM sg_contacto_productos p
             WHERE p.contacto_id = c.id) AS productos${marcas}
      FROM sg_contactos c
     WHERE ${cond.join(' AND ')}`;

  // Los parámetros van en el orden en que aparecen los ? en el TEXTO: primero los de las
  // marcas (están en el SELECT), después los de los filtros, y el límite al final.
  const parQ = q ? Array(12).fill(like(q)) : [];
  const sql = q
    ? `SELECT * FROM (${interna}) t
        WHERE t.m_nombre = 1 OR t.m_medio = 1 OR t.m_producto = 1 OR t.m_charla = 1 OR t.m_otro = 1
        ORDER BY t.pendientes DESC, t.nombre COLLATE NOCASE LIMIT ?`
    // El que tiene algo pendiente va primero: un listado alfabético puro esconde lo único
    // que hay que hacer hoy.
    : `SELECT * FROM (${interna}) t ORDER BY t.pendientes DESC, t.nombre COLLATE NOCASE LIMIT ?`;

  const filas = db.prepare(sql).all(...parQ, ...par, limite);

  return filas.map((f) => {
    const porque = [];
    if (q) {
      if (f.m_nombre)   porque.push('nombre');
      if (f.m_medio)    porque.push('teléfono o mail');
      if (f.m_producto) porque.push('lo que produce');
      if (f.m_charla)   porque.push('una charla');
      if (f.m_otro)     porque.push('zona, etiqueta o nota');
    }
    const r = Object.assign({}, f, { porque });
    // Si matcheó por una charla, se devuelve el pedacito: encontrar a alguien "por una
    // charla" sin ver cuál obliga a abrir la ficha para entender por qué apareció.
    if (q && f.m_charla) {
      const ch = db.prepare(`
        SELECT fecha, resumen FROM sg_contacto_charlas
         WHERE contacto_id = ? AND eliminado_en IS NULL
           AND (${sinT('resumen')} LIKE ? OR ${sinT("IFNULL(proximo_paso,'')")} LIKE ?)
         ORDER BY fecha DESC LIMIT 1`).get(f.id, like(q), like(q));
      if (ch) r.charla_match = { fecha: ch.fecha, extracto: extracto(ch.resumen, q) };
    }
    delete r.m_nombre; delete r.m_medio; delete r.m_producto; delete r.m_charla; delete r.m_otro;
    return r;
  });
}

// Un pedazo del texto alrededor de lo buscado. Sin esto habría que mostrar la charla
// entera, que en una lista no entra.
export function extracto(texto, q, largo) {
  const t = String(texto || '');
  const n = largo || 110;
  // plano() cambia un carácter por otro, nunca la longitud, así que el índice que sale de
  // la copia doblada vale sobre el texto original.
  const i = plano(t).toLowerCase().indexOf(plano(q).toLowerCase());
  if (i < 0) return t.slice(0, n) + (t.length > n ? '…' : '');
  const desde = Math.max(0, i - Math.floor(n / 3));
  const hasta = Math.min(t.length, desde + n);
  return (desde > 0 ? '…' : '') + t.slice(desde, hasta) + (hasta < t.length ? '…' : '');
}

// ── LA FICHA ─────────────────────────────────────────────────────────────────────────
export function ficha(db, id) {
  const c = db.prepare('SELECT * FROM sg_contactos WHERE id = ? AND eliminado_en IS NULL').get(id);
  if (!c) return null;
  c.medios = db.prepare(
    'SELECT * FROM sg_contacto_medios WHERE contacto_id = ? ORDER BY preferido DESC, id').all(id);
  c.productos = db.prepare(
    'SELECT * FROM sg_contacto_productos WHERE contacto_id = ? ORDER BY producto').all(id)
    .map((p) => Object.assign(p, {
      meses_nombres: mesesDeMascara(p.meses),
      ventana: ventanaEnPalabras(p.meses),
    }));
  c.charlas = db.prepare(`
    SELECT * FROM sg_contacto_charlas
     WHERE contacto_id = ? AND eliminado_en IS NULL
     ORDER BY fecha DESC, id DESC`).all(id);
  c.ultima_charla = c.charlas[0] || null;
  // Lo que quedó pendiente y todavía no se marcó hecho. Es lo primero que hay que ver al
  // abrir una ficha: si quedé en llamarlo el martes, eso manda sobre todo lo demás.
  c.pendientes = c.charlas.filter((x) => x.proximo_paso && !x.hecho_en);
  return c;
}

// Lo que hay que hacer, de todos los contactos. `hasta` en ISO; sin él, todo lo vencido y
// lo de hoy.
export function pendientes(db, hasta) {
  const tope = hasta || new Date().toISOString().slice(0, 10);
  return db.prepare(`
    SELECT ch.id, ch.contacto_id, ch.fecha, ch.proximo_paso, ch.proximo_el, ch.usuario,
           c.nombre, c.empresa, c.tipo,
           (SELECT valor FROM sg_contacto_medios m
             WHERE m.contacto_id = c.id ORDER BY m.preferido DESC, m.id LIMIT 1) AS medio_principal
      FROM sg_contacto_charlas ch
      JOIN sg_contactos c ON c.id = ch.contacto_id
     WHERE ch.eliminado_en IS NULL AND c.eliminado_en IS NULL
       AND ch.proximo_paso IS NOT NULL AND ch.proximo_paso <> ''
       AND ch.hecho_en IS NULL
       AND ch.proximo_el IS NOT NULL AND ch.proximo_el <= ?
     ORDER BY ch.proximo_el`).all(tope);
}

// Para llenar los desplegables sin inventarlos: sale de lo que hay cargado.
export function opciones(db) {
  const col = (c, t) => db.prepare(
    `SELECT DISTINCT ${c} v FROM ${t} WHERE ${c} IS NOT NULL AND ${c} <> '' ORDER BY ${c}`
  ).all().map((r) => r.v);
  return {
    zonas: col('zona', 'sg_contactos'),
    vendedores: col('vendedor', 'sg_contactos'),
    productos: col('producto', 'sg_contacto_productos'),
    empresas: col('empresa', 'sg_contactos'),
    tipos: TIPOS, canales: CANALES, meses: MESES,
  };
}

// ── LO QUE LA BASE YA SABE ───────────────────────────────────────────────────────────
// La ficha muestra, al lado de lo que el comercial tipeó, lo que las ventas dicen. No para
// reemplazarlo: para poder ver la diferencia. Un productor que OFRECE brócoli y al que
// nunca le compramos brócoli es una oportunidad, y sólo se ve si las dos cosas están
// separadas y juntas en la misma pantalla.
//
// El vínculo es POR NOMBRE (ver db_sg_contactos.js). Si el nombre no coincide con el de la
// planilla, esto devuelve vacío — y la ficha lo dice, en vez de mostrar cero como si el
// productor no hubiera traído nada.

// Las dos usan sheet_ventas, que puede no existir (base nueva, o el sync nunca corrió).
// Devolver null y que la pantalla lo diga es mejor que un cero que se lee como "no vendió".
function hayVentas(db) {
  try {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sheet_ventas'").get();
  } catch (_) { return false; }
}

// De un PRODUCTOR: qué nos trajo y en qué meses, con la misma máscara que lo declarado,
// así la pantalla puede dibujar las dos franjas una debajo de la otra.
export function observadoProveedor(db, nombre, opts) {
  if (!nombre || !hayVentas(db)) return null;
  const o = opts || {};
  const desde = o.desde_periodo || null;
  const par = [nombre];
  let filtro = '';
  if (desde) { filtro = ' AND periodo >= ?'; par.push(desde); }
  let filas;
  try {
    filas = db.prepare(`
      SELECT producto, mes_ok,
             ROUND(SUM(kilos_tot),0) AS kilos,
             ROUND(SUM(tot_dol),0)   AS usd,
             COUNT(DISTINCT periodo) AS campanias
        FROM sheet_ventas
       WHERE proveedor = ?${filtro}
         AND producto IS NOT NULL AND producto <> ''
         AND mes_ok IS NOT NULL AND mes_ok <> ''
       GROUP BY producto, mes_ok`).all(...par);
  } catch (_) { return null; }
  if (!filas.length) return { vinculado: true, sin_datos: true, productos: [] };

  const porProd = new Map();
  for (const f of filas) {
    if (!porProd.has(f.producto)) {
      porProd.set(f.producto, { producto: f.producto, kilos: 0, usd: 0, meses: Array(12).fill(0) });
    }
    const p = porProd.get(f.producto);
    p.kilos += f.kilos || 0;
    p.usd += f.usd || 0;
    // mes_ok viene '01-JULIO' … '12-JUN': el número de adelante ES la posición.
    const i = parseInt(String(f.mes_ok).slice(0, 2), 10) - 1;
    if (i >= 0 && i < 12) p.meses[i] += f.kilos || 0;
  }
  const productos = [...porProd.values()]
    .map((p) => {
      const mascara = p.meses.map((k) => (k > 0 ? '1' : '0')).join('');
      return { producto: p.producto, kilos: Math.round(p.kilos), usd: Math.round(p.usd),
               meses: mascara, ventana: ventanaEnPalabras(mascara) };
    })
    .sort((a, b) => b.kilos - a.kilos);
  return { vinculado: true, sin_datos: false, productos };
}

// De un CLIENTE: qué nos compra, para tener de qué hablar antes de levantar el teléfono.
export function observadoCliente(db, nombre, opts) {
  if (!nombre || !hayVentas(db)) return null;
  const o = opts || {};
  const par = [nombre];
  let filtro = '';
  if (o.periodo) { filtro = ' AND periodo = ?'; par.push(o.periodo); }
  let filas;
  try {
    filas = db.prepare(`
      SELECT producto,
             ROUND(SUM(kilos_tot),0) AS kilos,
             ROUND(SUM(tot_dol),0)   AS usd,
             MAX(periodo)            AS ultimo_periodo,
             MAX(mes_ok)             AS ultimo_mes
        FROM sheet_ventas
       WHERE cliente = ?${filtro}
         AND producto IS NOT NULL AND producto <> ''
       GROUP BY producto
       ORDER BY SUM(tot_dol) DESC
       LIMIT 30`).all(...par);
  } catch (_) { return null; }
  if (!filas.length) return { vinculado: true, sin_datos: true, productos: [] };
  return {
    vinculado: true, sin_datos: false, productos: filas,
    usd: filas.reduce((a, x) => a + (x.usd || 0), 0),
    kilos: filas.reduce((a, x) => a + (x.kilos || 0), 0),
  };
}

// Lo que ofrece y nunca le compramos. Es la pregunta que el módulo existe para contestar, y
// sale de cruzar las dos listas de arriba.
export function ofreceYNoLeCompramos(declarados, observado) {
  if (!observado || observado.sin_datos) return [];
  const tiene = new Set((observado.productos || []).map((p) => String(p.producto).toUpperCase()));
  return (declarados || [])
    .filter((d) => !tiene.has(String(d.producto).toUpperCase()))
    .map((d) => ({ producto: d.producto, variedad: d.variedad, ventana: ventanaEnPalabras(d.meses) }));
}
