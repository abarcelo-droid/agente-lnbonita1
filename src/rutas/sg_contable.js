// src/rutas/sg_contable.js
// ── PLAN DE CUENTAS SG — copia de rutas/cuentas.js repuntada a tablas sg_* ────
// Copia física del Contable de PC para que SG diverja. Mismas reglas (formato de
// códigos, partida doble, imputabilidad, soft-delete, log) pero sobre sg_cuentas/
// sg_asientos/etc. SIN dimensión sociedad_id: estas tablas son SG-only.
// Montado en /api/sg/contable. NO toca ninguna tabla pa_*.

import express from 'express';
import db from '../servicios/db_sg_finanzas.js';
import { crearAsiento, filtroAmbito, totalesDeAsiento } from '../servicios/asientos.js';
import { exigirEmpresa, SAN_GERONIMO } from '../servicios/sociedad_modulo.js';

const router = express.Router();

// ── EL CERROJO DE EMPRESA, CONECTADO ──────────────────────────────────────
// Corre ANTES que cualquier endpoint de este router. Si el pedido viene con OTRA
// empresa, corta con 403 y explica cuál esperaba.
//
// Puente Cordón ya lo tenía en sus nueve routers; el lado de San Gerónimo había
// quedado sin poner. La regla del dueño vale para los dos lados: parado en una
// sociedad no se tocan las tablas de otra, ni siquiera teniendo permiso para
// entrar a esa otra — hay que cambiar el selector y operar desde ahí.
router.use((req, res, next) => {
  if (exigirEmpresa(req, res, SAN_GERONIMO) === null) return;   // ya contestó 403
  next();
});

// ── helpers ────────────────────────────────────────────────────────────────
function getUser(req) {
  try {
    const c = req.cookies?.lnb_user;
    return c ? JSON.parse(c) : null;
  } catch (e) {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const u = getUser(req);
  if (!u || u.rol !== 'admin') {
    return res.status(403).json({ error: 'solo admin' });
  }
  req._user = u;
  next();
}

function requireAuth(req, res, next) {
  const u = getUser(req);
  if (!u) {
    return res.status(401).json({ error: 'no autenticado' });
  }
  req._user = u;
  next();
}

function logAccion({ cuenta_id = null, seccion_id = null, accion, detalle = null, usuario_id = null }) {
  db.prepare(`
    INSERT INTO sg_cuentas_log (cuenta_id, seccion_id, accion, detalle, usuario_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    cuenta_id,
    seccion_id,
    accion,
    detalle ? JSON.stringify(detalle) : null,
    usuario_id
  );
}

// Helper backend: ¿la cuenta es imputable? (no es padre de ninguna otra)
function cuentaEsImputable(db, cuentaId) {
  const c = db.prepare('SELECT codigo FROM sg_cuentas WHERE id = ?').get(cuentaId);
  if (!c) return false;
  const cod = String(c.codigo);
  const hijo = db.prepare("SELECT 1 FROM sg_cuentas WHERE codigo LIKE ? AND codigo != ? LIMIT 1").get(cod + '.%', cod);
  return !hijo;
}

// ── EL PRÓXIMO CÓDIGO LIBRE BAJO UN PREFIJO ───────────────────────────────
// Lo usan las DOS formas de mover una cuenta: el arrastre del árbol y el
// selector de la pantalla de edición. Tiene que vivir en un solo lugar — si
// cada una numerara a su manera, mover por un camino o por el otro daría
// códigos distintos para la misma cuenta.
function proximoCodigoLibre(prefijo, exceptoId) {
  const excepto = exceptoId ? { tabla: 'cuentas', id: exceptoId } : undefined;
  let n = 0;
  for (const h of db.prepare('SELECT codigo FROM sg_cuentas WHERE codigo LIKE ?').all(prefijo + '.%')) {
    const p = String(h.codigo).split('.');
    if (p.length !== 4) continue;
    const u = parseInt(p[3], 10);
    if (Number.isInteger(u) && u > n) n = u;
  }
  while (n < 9999) {
    n++;
    const cand = `${prefijo}.${String(n).padStart(4, '0')}`;
    if (!codigoEnUso(db, cand, excepto)) return cand;
  }
  return primerHueco(prefijo, exceptoId);
}

// El tramo de tres niveles del que cuelga una cuenta: el código del título si lo
// tiene, y si no el de la sección con el tramo .00, que es el de "sin título".
// Devuelve { prefijo } o { error } con un mensaje que dice qué hacer.
function prefijoDestino(sec, tit) {
  if (tit) {
    if (!RE_TITULO.test(String(tit.codigo))) {
      return { error: `Abajo del título ${tit.codigo} no puede colgar ninguna cuenta: su código no `
                    + `respeta el formato X.XX.XX. Editalo y ponele uno válido —por ejemplo `
                    + `${sugerirTitulo(tit.codigo)}— y recién ahí movés la cuenta.` };
    }
    return { prefijo: String(tit.codigo) };
  }
  if (!/^\d\.\d{2}$/.test(String(sec.codigo))) {
    return { error: `En la sección ${sec.codigo} no se pueden poner cuentas SIN TÍTULO: para eso su `
                  + `código tiene que ser X.XX. Elegí un título de esa sección, o corregile el código `
                  + `a la sección (por ejemplo ${sugerirSeccion(sec.codigo)}).` };
  }
  return { prefijo: `${sec.codigo}.00` };
}

// ── NO SE CRUZA DE GRUPO ──────────────────────────────────────────────────
// Una cuenta de Activo no se manda a Ingresos. El grupo es LO QUE LA CUENTA ES:
// moverla no la reordena, le cambia la naturaleza, y los asientos que ya la
// usaron quedan diciendo otra cosa de la que dijeron el día que se hicieron.
const NOMBRE_GRUPO = { activo: 'Activo', pasivo: 'Pasivo', patrimonio_neto: 'Patrimonio',
                       ingresos: 'Ingresos', gastos: 'Egresos' };
function chocaDeGrupo(seccionOrigenId, seccionDestinoId) {
  const g = (secId) =>
    db.prepare('SELECT grupo FROM sg_cuentas_secciones WHERE id = ?').get(secId)?.grupo || null;
  const a = g(seccionOrigenId), b = g(seccionDestinoId);
  if (!a || !b || a === b) return null;
  return `No se puede mover una cuenta de ${NOMBRE_GRUPO[a] || a} a ${NOMBRE_GRUPO[b] || b}: el grupo `
       + `dice qué ES la cuenta, y los asientos que ya la usaron quedarían diciendo otra cosa. Si de `
       + `verdad va en el otro grupo, creá la cuenta nueva allá y desactivá ésta.`;
}

// ── QUIÉN PUEDE USAR UNA CUENTA ────────────────────────────────────────────
// Una cuenta SIN nadie tildado la usa cualquiera que entre al módulo — o sea,
// como funcionaba hasta ahora. Apenas se tilda a UNA persona pasa a ser
// restringida y sólo esa gente la puede imputar. El admin siempre puede: si no,
// una cuenta restringida a alguien que se fue quedaría sin nadie que la use ni
// la pueda destrabar.
function usuariosDeCuenta(cuentaId) {
  return db.prepare('SELECT usuario_id FROM sg_cuentas_usuarios WHERE cuenta_id = ?')
           .all(cuentaId).map(r => r.usuario_id);
}

function puedeUsarCuenta(usuario, cuentaId) {
  if (!usuario) return false;
  if (usuario.rol === 'admin') return true;
  const permitidos = usuariosDeCuenta(cuentaId);
  return permitidos.length === 0 || permitidos.includes(usuario.id);
}

// El mensaje dice QUIÉNES pueden, que es lo único que le sirve al que se topa
// con el bloqueo: así sabe a quién pedirle que la cargue.
function mensajeRestringida(cuenta) {
  const nombres = db.prepare(`
    SELECT u.nombre FROM sg_cuentas_usuarios cu
      JOIN usuarios u ON u.id = cu.usuario_id
     WHERE cu.cuenta_id = ? ORDER BY u.nombre`).all(cuenta.id).map(r => r.nombre);
  return `La cuenta ${cuenta.codigo} — ${cuenta.nombre} está restringida`
       + (nombres.length ? `: la pueden usar ${nombres.join(', ')}.` : '.')
       + ' Pedile a alguno de ellos que cargue el asiento, o a un administrador que te habilite.';
}

// Reemplazo total de la lista, como la pantalla de permisos: lo que no viene en
// la lista se saca. Es lo que hace que destildar signifique algo.
function guardarUsuariosDeCuenta(cuentaId, ids) {
  const limpios = [...new Set((Array.isArray(ids) ? ids : [])
    .map(x => parseInt(x, 10)).filter(Number.isInteger))];
  // Sólo usuarios que existan y estén activos: guardar el id de alguien dado de
  // baja deja una cuenta restringida a un fantasma.
  const vale = db.prepare('SELECT 1 FROM usuarios WHERE id = ? AND activo = 1');
  const validos = limpios.filter(id => vale.get(id));
  const borrar = db.prepare('DELETE FROM sg_cuentas_usuarios WHERE cuenta_id = ?');
  const poner  = db.prepare('INSERT OR IGNORE INTO sg_cuentas_usuarios (cuenta_id, usuario_id) VALUES (?, ?)');
  db.transaction(() => {
    borrar.run(cuentaId);
    for (const id of validos) poner.run(cuentaId, id);
  })();
  return validos;
}

// Helper: ¿el código ya está en uso en CUALQUIER nivel (sección, título o cuenta)?
// `excepto` permite ignorar el propio registro al editar.
function codigoEnUso(db, codigo, excepto) {
  const cod = String(codigo).trim();
  excepto = excepto || {};
  // Se devuelve el NOMBRE y si está desactivada, no sólo "existe". El chequeo
  // mira TODO el plan —las tres tablas, activas y desactivadas— pero la pantalla
  // muestra sólo las activas del grupo de la pestaña abierta. Así que el choque
  // más común es contra algo que el usuario NO PUEDE VER, y el mensaje anterior
  // lo dejaba buscando un código que no aparecía en ningún lado.
  const buscar = (tabla, etiqueta, extra) => {
    const r = db.prepare(`SELECT id, nombre, activo${extra || ''} FROM ${tabla} WHERE codigo = ?`).get(cod);
    if (!r) return null;
    if (excepto.tabla === tabla.replace('sg_cuentas_', '').replace('sg_cuentas', 'cuentas') && excepto.id === r.id) return null;
    return { nivel: etiqueta, id: r.id, nombre: r.nombre, activo: !!r.activo, grupo: r.grupo };
  };
  return buscar('sg_cuentas_secciones', 'sección', ', grupo')
      || buscar('sg_cuentas_titulos', 'título')
      || buscar('sg_cuentas', 'cuenta');
}

// ── DE QUÉ HABLA CADA RENGLÓN DEL LOG ──────────────────────────────────────
// El log resolvía el código y el nombre con un JOIN contra la fila. Eso
// funcionaba mientras "borrar" era en realidad "desactivar" y la fila seguía
// ahí. Desde que el borrado es real, la fila NO ESTÁ: el JOIN no encuentra
// nada y el renglón queda "borrar — — —", que en un plan de cuentas no sirve
// para nada, justo en el único caso en que el log importa.
//
// Por eso los borrados guardan código y nombre dentro de `detalle`, y esto los
// lee de ahí cuando la fila ya no existe. El orden es: primero la fila viva
// (puede haberse renombrado desde entonces, y ahí lo que vale es el nombre de
// hoy), y recién si no está, lo que quedó anotado.
//
// El caso del TÍTULO es aparte: su renglón guarda el seccion_id del PADRE, que
// sigue existiendo, así que el JOIN devuelve la sección y no el título. Para
// las acciones de título manda siempre el detalle.
const REF_LOG = `
           CASE WHEN l.cuenta_id IS NOT NULL
                THEN COALESCE(c.codigo, json_extract(l.detalle, '$.codigo')) END AS cuenta_codigo,
           CASE WHEN l.cuenta_id IS NOT NULL
                THEN COALESCE(c.nombre, json_extract(l.detalle, '$.nombre')) END AS cuenta_nombre,
           CASE WHEN l.seccion_id IS NULL THEN NULL ELSE COALESCE(
                CASE WHEN s.id IS NULL OR l.accion LIKE '%titulo%'
                     THEN NULLIF(TRIM(COALESCE(json_extract(l.detalle, '$.codigo'), '') || ' ' ||
                                      COALESCE(json_extract(l.detalle, '$.nombre'), '')), '') END,
                s.codigo || ' — ' || s.nombre) END AS seccion_nombre`;

// ── LOS TRES FORMATOS, Y POR QUÉ SON ASÍ ───────────────────────────────────
// El formato de la CUENTA no es negociable: X.XX.XX.XXXX, con UN SOLO dígito de
// grupo. De ahí para arriba todo lo demás se deduce, porque el código de una
// cuenta es el de su título más cuatro dígitos, y el del título es el de su
// sección más dos.
//
// Antes las tres reglas no encajaban entre sí: la sección aceptaba `\d+` con
// decimales libres ("10.01", "4.1", "4.001") y el título `\d+` de grupo
// ("10.01.01"). Los dos se pueden crear, y los dos son CALLEJONES SIN SALIDA:
// abajo de un título 10.01.01 no entra ninguna cuenta, porque 10.01.01.0001 no
// pasa la regex de cuenta. Se creaban en silencio y el problema aparecía
// después, al intentar colgarles algo.
//
// Ahora no se pueden crear. Lo que YA exista con otra forma no se toca: la
// validación corre sólo cuando el código CAMBIA, así que renombrar una sección
// vieja sigue funcionando.
const RE_SECCION = /^\d(\.\d{2})?$/;        // 4   ó  4.01
const RE_TITULO  = /^\d\.\d{2}\.\d{2}$/;    // 4.01.01
// EL TRAMO .00 ES DEL GRUPO "SIN TÍTULO ASIGNADO" y no se le puede dar a un
// título de verdad. Las cuentas que todavía no se clasificaron viven en
// X.XX.00.NNNN; si además existe un título X.XX.00, sus cuentas usan los MISMOS
// códigos, y mirando el número deja de poder saberse cuál está sin clasificar y
// cuál no. Medido: se podía crear el título, y las dos familias se mezclaban.
const RE_TITULO_CERO = /^\d\.\d{2}\.00$/;
const NO_CERO = (c) => `El tramo .00 está reservado: ${c} es donde el sistema deja las cuentas que `
  + `todavía no tienen título. Elegí otro número, por ejemplo ${String(c).slice(0, -2)}01.`;
const RE_CUENTA  = /^\d\.\d{2}\.\d{2}\.\d{4}$/;  // 4.01.01.0001

const AYUDA_SECCION = 'El código de una sección es X.XX (por ejemplo 4.01), o el dígito del grupo solo '
                    + '(4). Un grupo es un solo dígito: 1 Activo, 2 Pasivo, 3 Patrimonio, 4 Ingresos, '
                    + '5 Egresos.';
const AYUDA_TITULO  = 'El código de un título es X.XX.XX (por ejemplo 4.01.01), y tiene que empezar con '
                    + 'el código de su sección. El primer dígito es el grupo.';

// El primer código libre bajo un prefijo, barriendo desde 0001. Es el plan B de
// la numeración correlativa: se usa sólo cuando el correlativo llegó al 9999,
// que en la práctica pasa porque alguien cargó UNA cuenta terminada en 9999 y no
// porque haya diez mil. Sin esto, esa única cuenta dejaba el alta por lote sin
// poder crear nada y el arrastre sin poder mover nada.
function primerHueco(prefijo, exceptoId) {
  const excepto = exceptoId ? { tabla: 'cuentas', id: exceptoId } : undefined;
  for (let i = 1; i <= 9999; i++) {
    const cand = `${prefijo}.${String(i).padStart(4, '0')}`;
    if (!codigoEnUso(db, cand, excepto)) return cand;
  }
  return null;
}

// Para el mensaje: qué código VÁLIDO se parece al que está mal. Sirve para no
// dejar al contador adivinando qué le pasa a "10.01.01" — se le muestra el
// "1.00.01" que sí entraría, y de ahí se entiende que el grupo es un dígito.
function sugerir(codigo, tramos) {
  const partes = String(codigo).split('.');
  // El grupo es UN dígito: de "10" se propone el "1". Los tramos de abajo se
  // llevan a dos dígitos, que es lo único que acepta el formato.
  const salida = [(partes[0] || '4').replace(/\D/g, '').charAt(0) || '4'];
  for (let i = 1; i < tramos; i++) {
    const t = (partes[i] || '').replace(/\D/g, '');
    salida.push((t.slice(0, 2) || '01').padStart(2, '0'));
  }
  return salida.join('.');
}
const sugerirSeccion = (codigo) => sugerir(codigo, 2);
const sugerirTitulo  = (codigo) => sugerir(codigo, 3);

// ── EL CÓDIGO TIENE QUE COLGAR DE SU PADRE ─────────────────────────────────
// El plan de cuentas se lee por el código: 4.01.01.0002 se entiende porque
// arranca con el 4.01.01 de su título, que arranca con el 4.01 de su sección.
// Eso no se estaba validando en ningún lado: se podía crear el título 5.01.01
// adentro de la sección 4.01, o colgar la cuenta 4.07.99.0001 del título
// 4.01.01. El árbol de la pantalla los mostraba en su lugar —agrupa por id, no
// por código— pero quedaban ordenados en cualquier parte y el código dejaba de
// querer decir algo.
//
// Devuelve el mensaje de error, o null si está bien.
function noCuelgaDe(codigoHijo, codigoPadre, quePadre) {
  if (String(codigoHijo).startsWith(String(codigoPadre) + '.')) return null;
  const de = quePadre === 'el título' ? 'del título' : `de ${quePadre}`;
  return `El código ${codigoHijo} no cuelga ${de} ${codigoPadre}: tiene que empezar `
       + `con "${codigoPadre}.". Así se lee el plan de cuentas — el código dice dónde está la `
       + `cuenta sin tener que buscarla.`;
}

// El mensaje que ve el usuario. Dice DÓNDE está el código, que es lo único que
// le sirve para poder resolverlo.
// ── LO QUE ENTRA POR EL FORMULARIO NO ES UN NOMBRE HASTA QUE SE LO MIRA ────
// El plan de cuentas se carga PEGANDO una lista, casi siempre de un Excel o de
// un PDF del contador. Eso trae de todo: renglones vacíos que parecen vacíos
// pero no lo están, separadores, guiones, y espacios de ancho cero (U+200B) que
// el ojo no ve y el trim() no saca. Cada uno de esos renglones se convertía en
// una CUENTA, y una cuenta del plan contable no se borra: se usa en asientos.
//
// Medido antes de esto: una lista con "-", ".", "..." y "@@@" creaba cuatro
// cuentas; un pegado con espacios de ancho cero creaba dos cuentas con el
// nombre en blanco; y mandar un objeto creaba una cuenta llamada
// literalmente "[object Object]".
const INVISIBLES = /[\u200B-\u200D\uFEFF\u00AD\u2060\u180E]/g;
const SALTOS = /\r\n|[\n\r\u2028\u2029]/;
const NOMBRE_MAX = 120;

function limpiarNombre(x) {
  if (x === null || x === undefined) return '';
  // Un objeto o un array NO son un nombre. String({}) da "[object Object]".
  if (typeof x === 'object') return '';
  return String(x).replace(INVISIBLES, '').replace(/\s+/g, ' ').trim();
}

// Un nombre de cuenta tiene por lo menos una LETRA. "0", "---" y "..." no son
// nombres: son basura del pegado.
function nombreUsable(n) {
  return n.length > 0 && /[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]/.test(n);
}

// parseInt("5basura") devuelve 5. Con eso, un seccion_id mal armado entraba
// como si fuera la sección 5, y las cuentas caían en otra sección. Acá o es un
// número entero de punta a punta, o no es nada.
function enteroEstricto(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  const t = String(v ?? '').trim();
  return /^\d+$/.test(t) ? parseInt(t, 10) : null;
}

// Qué tipo le corresponde a una cuenta según el grupo de su sección. No es una
// preferencia: una cuenta del Activo es patrimonial y una de Gastos va al
// resultado. El modal manda 'resultado' por default, así que sin este control
// medio plan de cuentas nace marcado al revés.
const TIPO_DE_GRUPO = {
  activo: 'patrimonial', pasivo: 'patrimonial', patrimonio_neto: 'patrimonial',
  ingresos: 'resultado', gastos: 'resultado',
};

function mensajeChoque(codigo, choque) {
  const art = choque.nivel === 'sección' || choque.nivel === 'cuenta' ? 'la' : 'el';
  let m = `El código ${codigo} ya lo usa ${art} ${choque.nivel} "${choque.nombre}"`;
  if (choque.grupo) m += ` (grupo ${choque.grupo})`;
  if (!choque.activo) m += ', que está DESACTIVADA y por eso no aparece en la lista';
  return m + '. Los códigos no se pueden repetir entre secciones, títulos y cuentas.';
}

// ═══════════════════════════════════════════════════════════════════════════
// TÍTULOS — nivel intermedio X.XX.XX (no imputables)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/titulos', (req, res) => {
  const incluirInactivos = req.query.incluir_inactivos === '1';
  const seccionId = req.query.seccion_id ? parseInt(req.query.seccion_id, 10) : null;
  const params = [];
  let sql = 'SELECT t.*, s.codigo AS seccion_codigo, s.nombre AS seccion_nombre FROM sg_cuentas_titulos t JOIN sg_cuentas_secciones s ON s.id = t.seccion_id WHERE 1 = 1';
  if (!incluirInactivos) sql += ' AND t.activo = 1';
  if (seccionId) { sql += ' AND t.seccion_id = ?'; params.push(seccionId); }
  sql += ' ORDER BY t.codigo';
  res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

router.post('/titulos', requireAdmin, (req, res) => {
  const { codigo, nombre, seccion_id } = req.body || {};
  if (!codigo || !nombre || !seccion_id) {
    return res.status(400).json({ error: 'codigo, nombre y seccion_id son requeridos' });
  }
  const codigoStr = String(codigo).trim();
  if (RE_TITULO_CERO.test(codigoStr)) return res.status(400).json({ error: NO_CERO(codigoStr) });
  if (!RE_TITULO.test(codigoStr)) {
    return res.status(400).json({ error: `"${codigoStr}" no sirve como código de título. ${AYUDA_TITULO}` });
  }
  const sec = db.prepare('SELECT id, codigo FROM sg_cuentas_secciones WHERE id = ?').get(parseInt(seccion_id, 10));
  if (!sec) return res.status(400).json({ error: 'seccion_id inválido' });
  const cuelga = noCuelgaDe(codigoStr, sec.codigo, 'la sección');
  if (cuelga) return res.status(400).json({ error: cuelga });
  const choque = codigoEnUso(db, codigoStr);
  if (choque) return res.status(400).json({ error: mensajeChoque(codigoStr, choque) });
  try {
    const r = db.prepare(`
      INSERT INTO sg_cuentas_titulos (seccion_id, codigo, nombre, orden, activo)
      VALUES (?, ?, ?, ?, 1)
    `).run(sec.id, codigoStr, String(nombre).trim(), codigoStr);
    logAccion({ seccion_id: sec.id, accion: 'crear_titulo', detalle: { codigo: codigoStr, nombre }, usuario_id: req._user?.id });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/titulos/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tit = db.prepare('SELECT * FROM sg_cuentas_titulos WHERE id = ?').get(id);
  if (!tit) return res.status(404).json({ error: 'título no encontrado' });
  const { nombre, codigo } = req.body || {};
  if (codigo !== undefined && String(codigo).trim() !== String(tit.codigo)) {
    const codigoStr = String(codigo).trim();
    if (RE_TITULO_CERO.test(codigoStr)) return res.status(400).json({ error: NO_CERO(codigoStr) });
    if (!RE_TITULO.test(codigoStr)) {
      return res.status(400).json({ error: `"${codigoStr}" no sirve como código de título. ${AYUDA_TITULO}` });
    }
    const choque = codigoEnUso(db, codigoStr, { tabla: 'titulos', id });
    if (choque) return res.status(400).json({ error: mensajeChoque(codigoStr, choque) });
    db.prepare("UPDATE sg_cuentas_titulos SET codigo = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(codigoStr, id);
  }
  if (nombre && String(nombre).trim() !== tit.nombre) {
    db.prepare("UPDATE sg_cuentas_titulos SET nombre = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(String(nombre).trim(), id);
  }
  logAccion({ seccion_id: tit.seccion_id, accion: 'editar_titulo', detalle: { antes: tit, despues: req.body }, usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.delete('/titulos/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Se lee ANTES de borrar: después de un borrado real la fila ya no existe y no
  // hay forma de saber qué era. Va al log en `detalle`, que es lo único que
  // sobrevive. Ver el comentario largo en el borrado de la cuenta.
  const tit = db.prepare('SELECT * FROM sg_cuentas_titulos WHERE id = ?').get(id);
  if (!tit) return res.status(404).json({ error: 'título no encontrado' });
  // Mismo criterio que la sección: es estructura, se borra de verdad y libera el
  // código. Se cuentan las cuentas activas Y las desactivadas: las dos apuntan acá.
  const ctas = db.prepare('SELECT COUNT(*) c FROM sg_cuentas WHERE titulo_id = ?').get(id).c;
  if (ctas) {
    return res.status(400).json({
      error: `No se puede borrar: el título todavía tiene ${ctas} cuenta(s). `
           + `Movelas o borralas primero.`,
    });
  }
  db.prepare('DELETE FROM sg_cuentas_titulos WHERE id = ?').run(id);
  logAccion({ seccion_id: tit.seccion_id, accion: 'borrar_titulo',
              detalle: { codigo: tit.codigo, nombre: tit.nombre }, usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.post('/titulos/:id/reactivar', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE sg_cuentas_titulos SET activo = 1, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECCIONES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/secciones', (req, res) => {
  const incluirInactivas = req.query.incluir_inactivas === '1';
  let sql = 'SELECT * FROM sg_cuentas_secciones WHERE 1 = 1';
  if (!incluirInactivas) sql += ' AND activo = 1';
  sql += ' ORDER BY codigo';
  res.json({ ok: true, data: db.prepare(sql).all() });
});

router.post('/secciones', requireAdmin, (req, res) => {
  const { codigo, nombre, grupo } = req.body || {};
  if (!codigo || !nombre) return res.status(400).json({ error: 'codigo y nombre son requeridos' });
  const codigoStr = String(codigo).trim();
  if (!RE_SECCION.test(codigoStr)) {
    return res.status(400).json({ error: `"${codigoStr}" no sirve como código de sección. ${AYUDA_SECCION}` });
  }
  const choque = codigoEnUso(db, codigoStr);
  if (choque) return res.status(400).json({ error: mensajeChoque(codigoStr, choque) });
  try {
    const r = db.prepare(`
      INSERT INTO sg_cuentas_secciones (codigo, nombre, orden, activo, grupo)
      VALUES (?, ?, ?, 1, ?)
    `).run(codigoStr, String(nombre).trim(), codigoStr, grupo || 'gastos');
    logAccion({ seccion_id: r.lastInsertRowid, accion: 'crear', detalle: { codigo: codigoStr, nombre }, usuario_id: req._user?.id });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/secciones/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sec = db.prepare('SELECT * FROM sg_cuentas_secciones WHERE id = ?').get(id);
  if (!sec) return res.status(404).json({ error: 'sección no encontrada' });

  const { nombre, codigo, grupo } = req.body || {};
  if (codigo !== undefined && String(codigo).trim() !== String(sec.codigo)) {
    const codigoStr = String(codigo).trim();
    // El alta validaba el formato y la edición NO: por acá se le podía poner a
    // una sección cualquier código, incluso uno donde después no entra ninguna
    // cuenta. Sólo corre cuando el código CAMBIA, así que cambiarle el nombre a
    // una sección vieja de formato raro sigue andando.
    if (!RE_SECCION.test(codigoStr)) {
      return res.status(400).json({ error: `"${codigoStr}" no sirve como código de sección. ${AYUDA_SECCION}` });
    }
    const choque = codigoEnUso(db, codigoStr, { tabla: 'secciones', id });
    if (choque) return res.status(400).json({ error: mensajeChoque(codigoStr, choque) });
    db.prepare("UPDATE sg_cuentas_secciones SET codigo = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(codigoStr, id);
  }
  if (nombre && String(nombre).trim() !== sec.nombre) {
    db.prepare("UPDATE sg_cuentas_secciones SET nombre = ?, actualizado_en = datetime('now','localtime') WHERE id = ?").run(String(nombre).trim(), id);
  }
  if (grupo) {
    db.prepare("UPDATE sg_cuentas_secciones SET grupo = ? WHERE id = ?").run(grupo, id);
  }
  logAccion({ seccion_id: id, accion: 'editar', detalle: { antes: sec, despues: req.body }, usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.delete('/secciones/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sec = db.prepare('SELECT * FROM sg_cuentas_secciones WHERE id = ?').get(id);
  if (!sec) return res.status(404).json({ error: 'sección no encontrada' });
  // BORRA DE VERDAD. Antes esto sólo ponía activo = 0: la sección quedaba en la
  // base, invisible en la pantalla, y con su CÓDIGO TOMADO PARA SIEMPRE. Después
  // alguien quería usar ese código y el sistema lo rechazaba por algo que no
  // podía ver ni recuperar.
  //
  // Una sección es estructura, no historia: no hay ningún asiento que dependa de
  // ella. Si no tiene nada colgando, se va y libera el código.
  const tits = db.prepare('SELECT COUNT(*) c FROM sg_cuentas_titulos WHERE seccion_id = ?').get(id).c;
  const ctas = db.prepare('SELECT COUNT(*) c FROM sg_cuentas WHERE seccion_id = ?').get(id).c;
  if (tits || ctas) {
    // Se cuentan TODAS, activas o no: una cuenta desactivada sigue apuntando acá,
    // y borrar el padre la dejaría huérfana.
    const partes = [];
    if (tits) partes.push(`${tits} título(s)`);
    if (ctas) partes.push(`${ctas} cuenta(s)`);
    return res.status(400).json({
      error: `No se puede borrar: la sección todavía tiene ${partes.join(' y ')}. `
           + `Movelos o borralos primero.`,
    });
  }
  db.prepare('DELETE FROM sg_cuentas_secciones WHERE id = ?').run(id);
  logAccion({ seccion_id: id, accion: 'borrar',
              detalle: { codigo: sec.codigo, nombre: sec.nombre, grupo: sec.grupo },
              usuario_id: req._user?.id });
  res.json({ ok: true });
});

router.post('/secciones/:id/reactivar', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE sg_cuentas_secciones SET activo = 1, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  logAccion({ seccion_id: id, accion: 'reactivar', usuario_id: req._user?.id });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// LOG GENERAL — antes de /:id
// ═══════════════════════════════════════════════════════════════════════════

router.get('/log/general', (req, res) => {
  const { desde, hasta, accion, usuario_id } = req.query;
  const params = [];
  let sql = `
    SELECT l.*,
           u.nombre AS usuario_nombre,
           ${REF_LOG}
      FROM sg_cuentas_log l
      LEFT JOIN usuarios u             ON u.id = l.usuario_id
      LEFT JOIN sg_cuentas c           ON c.id = l.cuenta_id
      LEFT JOIN sg_cuentas_secciones s ON s.id = l.seccion_id
     WHERE 1 = 1
  `;
  if (desde)      { sql += ' AND l.creado_en >= ?'; params.push(desde); }
  if (hasta)      { sql += ' AND l.creado_en <= ?'; params.push(hasta); }
  if (accion)     { sql += ' AND l.accion = ?';     params.push(accion); }
  if (usuario_id) { sql += ' AND l.usuario_id = ?'; params.push(parseInt(usuario_id, 10)); }
  sql += ' ORDER BY l.creado_en DESC LIMIT 500';
  res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

// La gente a la que se le puede restringir una cuenta. Se listan los usuarios
// activos y nada más: el modal sólo necesita nombre e id, y devolver mails o
// roles sería contar de más en una pantalla contable.
router.get('/usuarios-posibles', requireAdmin, (req, res) => {
  res.json({ ok: true, data: db.prepare(
    "SELECT id, nombre FROM usuarios WHERE activo = 1 ORDER BY nombre").all() });
});

// ═══════════════════════════════════════════════════════════════════════════
// CUENTAS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/', (req, res) => {
  const { seccion_id, q } = req.query;
  const incluirInactivas = req.query.incluir_inactivas === '1';
  const params = [];
  let sql = `
    SELECT c.*,
           s.nombre AS seccion_nombre,
           s.codigo AS seccion_codigo,
           t.nombre AS titulo_nombre,
           t.codigo AS titulo_codigo
      FROM sg_cuentas c
      JOIN sg_cuentas_secciones s ON s.id = c.seccion_id
      LEFT JOIN sg_cuentas_titulos t ON t.id = c.titulo_id
     WHERE 1 = 1
  `;
  if (!incluirInactivas) sql += ' AND c.activo = 1';
  if (seccion_id) { sql += ' AND c.seccion_id = ?'; params.push(parseInt(seccion_id, 10)); }
  if (q) {
    sql += ' AND (c.codigo LIKE ? OR c.nombre LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY c.codigo';
  const data = db.prepare(sql).all(...params);
  const codigos = data.map(c => String(c.codigo));
  // Los permisos por cuenta se traen de UNA consulta y no de una por fila: con
  // doscientas cuentas, preguntar de a una son doscientas consultas por cada vez
  // que se abre la pantalla.
  const permisos = {};
  for (const r of db.prepare('SELECT cuenta_id, usuario_id FROM sg_cuentas_usuarios').all()) {
    (permisos[r.cuenta_id] ||= []).push(r.usuario_id);
  }
  const yo = getUser(req);
  data.forEach(c => {
    const cod = String(c.codigo);
    const esPadre = codigos.some(otro => otro !== cod && otro.startsWith(cod + '.'));
    c.imputable = esPadre ? 0 : 1;
    const permitidos = permisos[c.id] || [];
    c.usuarios_ids = permitidos;
    c.restringida = permitidos.length > 0;
    // Lo que la pantalla necesita para deshabilitarla en el selector sin tener
    // que saber la regla.
    c.puede_usar = !!yo && (yo.rol === 'admin' || !permitidos.length || permitidos.includes(yo.id));
  });
  res.json({ ok: true, data });
});

router.get('/:id(\\d+)', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare(`
    SELECT c.*, s.nombre AS seccion_nombre, s.codigo AS seccion_codigo,
           t.nombre AS titulo_nombre, t.codigo AS titulo_codigo
      FROM sg_cuentas c
      JOIN sg_cuentas_secciones s ON s.id = c.seccion_id
      LEFT JOIN sg_cuentas_titulos t ON t.id = c.titulo_id
     WHERE c.id = ?
  `).get(id);
  if (!c) return res.status(404).json({ error: 'cuenta no encontrada' });
  res.json({ ok: true, data: c });
});

router.post('/', requireAdmin, (req, res) => {
  const {
    codigo,
    nombre,
    seccion_id,
    titulo_id,
    tipo = 'resultado',
    permite_lote = 0,
    permite_campania = 0,
  } = req.body || {};

  if (!codigo || !nombre || !seccion_id) {
    return res.status(400).json({ error: 'codigo, nombre y seccion_id son requeridos' });
  }
  // Se trabaja siempre sobre el código YA limpio. Antes se validaba el trim pero
  // se guardaba el original: un espacio de más al pegar el código entraba a la
  // base y después no coincidía con nada.
  const codigoStr = String(codigo).trim();
  if (!RE_CUENTA.test(codigoStr)) {
    return res.status(400).json({ error: 'Código inválido. Las cuentas deben respetar el formato X.XX.XX.XXXX (ej: 1.01.01.0001).' });
  }
  if (!['resultado', 'patrimonial'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo inválido' });
  }
  const sec = db.prepare('SELECT id, codigo FROM sg_cuentas_secciones WHERE id = ?').get(seccion_id);
  if (!sec) return res.status(400).json({ error: 'seccion_id inválido' });

  const choque = codigoEnUso(db, codigoStr);
  if (choque) return res.status(400).json({ error: mensajeChoque(codigoStr, choque) });

  // EL MISMO CONTROL DE NOMBRE QUE EL ALTA DE A MUCHAS. Los dos caminos crean la
  // misma cuenta y aplicaban reglas distintas: el lote rechazaba el nombre
  // repetido y el de a una lo dejaba entrar, así que alcanzaba con cargarla por
  // el modal para tener dos "Honorarios" en el mismo título.
  const nombreLimpio = limpiarNombre(nombre);
  if (!nombreUsable(nombreLimpio)) {
    return res.status(400).json({ error: 'El nombre de la cuenta tiene que tener por lo menos una letra.' });
  }
  if (nombreLimpio.length > NOMBRE_MAX) {
    return res.status(400).json({ error: `El nombre no puede pasar de ${NOMBRE_MAX} caracteres.` });
  }

  try {
    const ordenMax = db.prepare('SELECT COALESCE(MAX(orden), 0) AS m FROM sg_cuentas WHERE seccion_id = ?').get(seccion_id).m;

    let titIdFinal = null;
    if (titulo_id) {
      const tit = db.prepare('SELECT id, codigo FROM sg_cuentas_titulos WHERE id = ? AND seccion_id = ?').get(parseInt(titulo_id, 10), sec.id);
      if (!tit) return res.status(400).json({ error: 'titulo_id no pertenece a la sección indicada' });
      const cuelga = noCuelgaDe(codigoStr, tit.codigo, 'el título');
      if (cuelga) return res.status(400).json({ error: cuelga });
      titIdFinal = tit.id;
    } else {
      // ── ACÁ FALTABA EL CONTROL, Y ENTRABA CUALQUIER COSA ───────────────
      // Sólo se validaba la jerarquía cuando la cuenta colgaba de un título. Sin
      // título no se miraba nada, así que en la sección 1.01 se guardó una cuenta
      // 1.02.00.0003 y quedó ahí, en el lugar equivocado, con un número que dice
      // que es de otro lado. El plan de cuentas se lee por el código: si el
      // código miente, no sirve de nada.
      const cuelga = noCuelgaDe(codigoStr, sec.codigo, 'la sección');
      if (cuelga) return res.status(400).json({ error: cuelga });
    }

    // Repetido en el MISMO lugar —misma sección y mismo título—, que es donde
    // molesta. "Honorarios" de Ventas y "Honorarios" de Administración son dos
    // cuentas distintas y las dos tienen que poder existir.
    const gemela = titIdFinal
      ? db.prepare(`SELECT codigo, activo FROM sg_cuentas
           WHERE seccion_id = ? AND titulo_id = ?
             AND LOWER(TRIM(nombre)) = LOWER(?)`).get(seccion_id, titIdFinal, nombreLimpio)
      : db.prepare(`SELECT codigo, activo FROM sg_cuentas
           WHERE seccion_id = ? AND titulo_id IS NULL
             AND LOWER(TRIM(nombre)) = LOWER(?)`).get(seccion_id, nombreLimpio);
    if (gemela) {
      return res.status(400).json({
        error: `Ya hay una cuenta que se llama "${nombreLimpio}" en ese mismo lugar: ${gemela.codigo}`
             + (gemela.activo === 0 ? ', y está DESACTIVADA (por eso no la ves en la lista).' : '.') });
    }

    const r = db.prepare(`
      INSERT INTO sg_cuentas
        (codigo, nombre, seccion_id, titulo_id, tipo, permite_lote, permite_campania, es_sistema, orden, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1)
    `).run(
      codigoStr,
      nombreLimpio,
      seccion_id,
      titIdFinal,
      tipo,
      permite_lote ? 1 : 0,
      permite_campania ? 1 : 0,
      ordenMax + 10
    );
    const usuarios = guardarUsuariosDeCuenta(r.lastInsertRowid, req.body?.usuarios_ids);
    logAccion({ cuenta_id: r.lastInsertRowid, accion: 'crear', detalle: req.body, usuario_id: req._user?.id });
    res.json({ ok: true, id: r.lastInsertRowid, usuarios_ids: usuarios });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ALTA DE VARIAS CUENTAS DE UNA VEZ ──────────────────────────────────────
// El plan de San Gerónimo arrancó con el esqueleto de secciones y títulos
// copiado de Puente Cordón, pero SIN NINGUNA CUENTA: ésas las carga el
// contador, y son unas doscientas. De a una, por el modal, es media tarde de
// tipear códigos correlativos a mano.
//
// Esto recibe una LISTA DE NOMBRES y arma los códigos solo, correlativos, bajo
// el título elegido. Sin título, van al tramo .00 de la sección, que es el
// grupo "Sin título asignado" que la pantalla muestra abajo de todo para
// arrastrarlas después a su lugar definitivo.
//
// NO PISA NADA. Si en esa sección ya hay una cuenta con ese nombre, la saltea y
// lo informa. Apretar Guardar dos veces no deja duplicados, y volver a pegar
// una lista más larga carga sólo lo que falta.
//
// Es de a lotes y no un import de archivo a propósito: pegar texto es lo que el
// contador ya tiene a mano —una columna de Excel, un mail— y no hay formato que
// aprender ni archivo que se pueda subir equivocado.
router.post('/lote', requireAdmin, (req, res) => {
  const seccionId = enteroEstricto(req.body?.seccion_id);
  const titRaw    = req.body?.titulo_id;
  const sinTitulo = (titRaw === null || titRaw === undefined || titRaw === '');
  const tituloId  = sinTitulo ? null : enteroEstricto(titRaw);
  const tipo      = req.body?.tipo || 'resultado';

  if (seccionId === null) return res.status(400).json({ error: 'Falta la sección.' });
  if (!['resultado', 'patrimonial'].includes(tipo)) return res.status(400).json({ error: 'tipo inválido' });
  // titulo_id que llega mal formado NO puede caer a "sin título" en silencio: el
  // usuario eligió un título y las cuentas terminaban sueltas en la sección, con
  // el tramo .00, sin que nadie se enterara.
  if (!sinTitulo && tituloId === null) {
    return res.status(400).json({ error: 'El título elegido no es válido. Volvé a elegirlo en el desplegable.' });
  }

  const sec = db.prepare('SELECT * FROM sg_cuentas_secciones WHERE id = ?').get(seccionId);
  if (!sec) return res.status(400).json({ error: 'La sección no existe.' });
  // Una sección desactivada no se ve en la pantalla: cargarle cuentas es
  // meterlas en un lugar al que nadie va a llegar.
  if (!sec.activo) {
    return res.status(400).json({
      error: `La sección ${sec.codigo} — ${sec.nombre} está DESACTIVADA: no se le pueden cargar `
           + `cuentas. Volvé a activarla primero, o elegí otra.` });
  }

  // EL TIPO SALE DEL GRUPO DE LA SECCIÓN. El modal manda 'resultado' por
  // default, así que sin esto una sección del Activo se llenaba de cuentas
  // marcadas como resultado y el balance quedaba mal desde el día uno.
  const tipoEsperado = TIPO_DE_GRUPO[sec.grupo];
  if (tipoEsperado && tipo !== tipoEsperado) {
    return res.status(400).json({
      error: `La sección ${sec.codigo} — ${sec.nombre} es del grupo ${sec.grupo}, así que sus `
           + `cuentas son de tipo "${tipoEsperado}", no "${tipo}".`,
      tipo_esperado: tipoEsperado });
  }

  let tit = null;
  if (tituloId) {
    tit = db.prepare('SELECT * FROM sg_cuentas_titulos WHERE id = ?').get(tituloId);
    if (!tit) return res.status(400).json({ error: 'El título no existe.' });
    if (tit.seccion_id !== sec.id) {
      return res.status(400).json({ error: 'Ese título no pertenece a la sección elegida.' });
    }
    if (!tit.activo) {
      return res.status(400).json({
        error: `El título ${tit.codigo} — ${tit.nombre} está DESACTIVADO: no se le pueden colgar `
             + `cuentas. Volvé a activarlo primero, o elegí otro.` });
    }
  }

  // Los tres primeros niveles del código de la cuenta. Con título es el código
  // del título; sin título, el de la sección + el tramo 00, que se lee como
  // "todavía no tiene título" y que reasignar-titulo reemplaza en cuanto se
  // arrastra la cuenta a su lugar.
  let prefijo;
  if (tit) {
    if (!/^\d\.\d{2}\.\d{2}$/.test(String(tit.codigo))) {
      return res.status(400).json({
        error: `Abajo del título ${tit.codigo} no puede colgar ninguna cuenta: su código no `
             + `respeta el formato X.XX.XX (un solo dígito de grupo). Es un título viejo, de `
             + `cuando el sistema dejaba crearlos así. Editalo y ponele un código válido `
             + `—por ejemplo ${sugerirTitulo(tit.codigo)}— y después movés las cuentas.`,
      });
    }
    prefijo = String(tit.codigo);
  } else {
    if (!/^\d\.\d{2}$/.test(String(sec.codigo))) {
      return res.status(400).json({
        error: `En la sección ${sec.codigo} no se pueden poner cuentas SIN TÍTULO: para eso su `
             + `código tiene que ser X.XX (un solo dígito de grupo) y el suyo no lo es. `
             + `Tenés dos salidas: elegí un título de esa sección en el desplegable de arriba, `
             + `o editá la sección y ponele un código válido, por ejemplo ${sugerirSeccion(sec.codigo)}.`,
      });
    }
    prefijo = `${sec.codigo}.00`;
  }

  // Una cuenta por línea. Se acepta también un array, para poder llamarlo desde
  // afuera del panel.
  const crudo = req.body?.nombres;
  // Un objeto o un número NO son una lista de nombres. String({a:1}) da
  // "[object Object]", y así entró más de una cuenta con ese nombre.
  if (crudo === null || crudo === undefined
      || (!Array.isArray(crudo) && typeof crudo !== 'string')) {
    return res.status(400).json({ error: 'La lista de nombres tiene que ser texto, uno por renglón.' });
  }
  // NO TODO SALTO DE LÍNEA ES \n. Copiar de un PDF trae U+2028 (line separator)
  // y U+2029; un archivo viejo de Mac trae \r solo. Con /\r?\n/ nada de eso
  // partía, y las 40 cuentas del contador entraban como UN nombre gigante — que
  // ahora además el tope de largo rechaza, así que no entraba nada.
  const renglones = (Array.isArray(crudo) ? crudo : crudo.split(SALTOS)).map(limpiarNombre);
  const lista = renglones.filter(nombreUsable);
  // Lo que se descartó se DICE. Descartar en silencio es peor que crear basura:
  // el usuario pega 40 renglones, ve 37 cuentas y no sabe cuáles faltan.
  // Los que TRAÍAN algo y no sirvieron. Un renglón en blanco no se cuenta: no
  // es un descarte, es el enter de más al final del pegado.
  const originales = Array.isArray(crudo) ? crudo : crudo.split(SALTOS);
  const descartados = renglones.filter((n, i) =>
    !nombreUsable(n) && String(originales[i] ?? '').trim() !== '');
  const largos = lista.filter(n => n.length > NOMBRE_MAX);
  if (largos.length) {
    return res.status(400).json({
      error: `Hay ${largos.length} nombre(s) de más de ${NOMBRE_MAX} caracteres. `
           + `Eso no es el nombre de una cuenta: fijate que no se haya pegado un párrafo entero.` });
  }
  if (!lista.length) {
    return res.status(400).json({
      error: descartados.length
        ? `Ninguno de los ${descartados.length} renglones sirve como nombre de cuenta: un nombre `
          + `tiene que tener por lo menos una letra.`
        : 'No hay ningún nombre en la lista.' });
  }
  if (lista.length > 300) {
    return res.status(400).json({ error: `Son ${lista.length} nombres: van de a 300 como máximo.` });
  }

  // Lo que ya está en la sección, por nombre. Se compara sin mayúsculas ni
  // espacios de más, que es como se duplican las cuentas en la vida real.
  // EL REPETIDO SE MIRA DONDE VA A VIVIR LA CUENTA, no en toda la sección.
  // "Honorarios" bajo el título Ventas y "Honorarios" bajo el título
  // Administración son DOS cuentas distintas y las dos tienen que poder existir:
  // el control por sección entera bloqueaba la segunda.
  const clave = (s) => limpiarNombre(s).toLowerCase();
  const yaEstan = new Map();
  const mismoLugar = tit
    ? db.prepare('SELECT codigo, nombre, activo FROM sg_cuentas WHERE seccion_id = ? AND titulo_id = ?').all(sec.id, tit.id)
    : db.prepare('SELECT codigo, nombre, activo FROM sg_cuentas WHERE seccion_id = ? AND titulo_id IS NULL').all(sec.id);
  for (const c of mismoLugar) yaEstan.set(clave(c.nombre), c);

  // Desde qué número sigue la numeración bajo este prefijo.
  let ultimo = 0;
  for (const h of db.prepare('SELECT codigo FROM sg_cuentas WHERE codigo LIKE ?').all(prefijo + '.%')) {
    const p = String(h.codigo).split('.');
    if (p.length !== 4) continue;
    const n = parseInt(p[3], 10);
    if (Number.isInteger(n) && n > ultimo) ultimo = n;
  }

  const ordenBase = db.prepare('SELECT COALESCE(MAX(orden), 0) AS m FROM sg_cuentas WHERE seccion_id = ?')
                      .get(sec.id).m;

  const insertar = db.prepare(`
    INSERT INTO sg_cuentas
      (codigo, nombre, seccion_id, titulo_id, tipo, permite_lote, permite_campania, es_sistema, orden, activo)
    VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, 1)
  `);

  const creadas = [], omitidas = [];
  try {
    db.transaction(() => {
      let n = ultimo, orden = ordenBase;
      for (const nombre of lista) {
        const k = clave(nombre);
        const previa = yaEstan.get(k);
        if (previa) {
          // Si la que choca está DESACTIVADA hay que decirlo: no se ve en la
          // pantalla, y el usuario se queda buscando un código que no aparece.
          omitidas.push({ nombre, motivo: `ya existe acá como ${previa.codigo}`
            + (previa.activo === 0 ? ', y está DESACTIVADA (por eso no la ves en la lista)' : '') });
          continue;
        }

        // Próximo código libre. El choque puede ser contra una cuenta, un título
        // o una sección: los códigos no se repiten entre los tres niveles.
        let codigo = null;
        while (n < 9999) {
          n++;
          const cand = `${prefijo}.${String(n).padStart(4, '0')}`;
          if (!codigoEnUso(db, cand)) { codigo = cand; break; }
        }
        // Se llegó al 9999: puede ser que esté todo ocupado, o —mucho más
        // probable— que exista UNA cuenta terminada en 9999 y todo lo de abajo
        // esté libre. Se busca el primer hueco desde el principio antes de
        // rendirse. `n` no se toca: la próxima de la lista sigue por acá.
        if (!codigo) codigo = primerHueco(prefijo);
        if (!codigo) {
          omitidas.push({ nombre, motivo: `no quedan códigos libres bajo ${prefijo}` });
          continue;
        }

        orden += 10;
        const r = insertar.run(codigo, nombre, sec.id, tit ? tit.id : null, tipo, orden);
        logAccion({
          cuenta_id: r.lastInsertRowid, accion: 'crear',
          detalle: { codigo, nombre, lote: true }, usuario_id: req._user?.id,
        });
        // Se anota acá también: dos renglones iguales dentro de la MISMA lista
        // pegada tienen que salteársele al segundo igual que a los ya existentes.
        yaEstan.set(k, { codigo, nombre });
        creadas.push({ id: r.lastInsertRowid, codigo, nombre });
      }
    })();
  } catch (e) {
    // La transacción revierte entera: NO quedó ninguna creada. Se dice así, con
    // las listas vacías, para que la pantalla muestre el resultado igual que
    // siempre y el usuario no se quede sin saber si algo entró.
    return res.status(500).json({ error: e.message, creadas: [], omitidas: [], descartados: 0 });
  }

  res.json({
    ok: true,
    creadas,
    omitidas,
    // Los renglones del pegado que no eran un nombre —guiones, puntos, espacios
    // de ancho cero—. Van aparte de las omitidas: éstas ni siquiera llegaron a
    // ser candidatas.
    descartados: descartados.length,
    donde: tit ? `${tit.codigo} — ${tit.nombre}` : `${sec.codigo} — ${sec.nombre} (sin título asignado)`,
  });
});

router.put('/:id(\\d+)', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cuenta = db.prepare('SELECT * FROM sg_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });

  const { codigo, nombre, seccion_id, titulo_id, tipo, permite_lote, permite_campania } = req.body || {};

  if (tipo && !['resultado', 'patrimonial'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo inválido' });
  }

  // ── MOVER LA CUENTA DESDE ACÁ ─────────────────────────────────────────
  // Cambiar la sección o el título en la pantalla de edición ES mover la cuenta,
  // y mover una cuenta le cambia el número. Antes había que acordarse de
  // corregir el código a mano: si no, quedaba en la sección nueva con el número
  // de la vieja — que es como una cuenta 1.02.00.0003 terminó viviendo en la
  // sección 1.01.
  //
  // Ahora se renumera SOLA al tramo del destino. El código que venga en el
  // pedido se ignora cuando hubo mudanza: manda el destino, y así no hay forma
  // de que los dos se contradigan.
  const destinoSecId = seccion_id ? parseInt(seccion_id, 10) : cuenta.seccion_id;
  const destinoTitId = titulo_id === undefined ? cuenta.titulo_id
                     : (titulo_id ? parseInt(titulo_id, 10) : null);
  const seMudo = destinoSecId !== cuenta.seccion_id || destinoTitId !== cuenta.titulo_id;

  const secDestino = db.prepare('SELECT id, codigo FROM sg_cuentas_secciones WHERE id = ?').get(destinoSecId);
  if (!secDestino) return res.status(400).json({ error: 'seccion_id inválido' });
  let titDestino = null;
  if (destinoTitId) {
    titDestino = db.prepare('SELECT id, codigo, seccion_id FROM sg_cuentas_titulos WHERE id = ?').get(destinoTitId);
    if (!titDestino) return res.status(400).json({ error: 'titulo_id inválido' });
    if (titDestino.seccion_id !== secDestino.id) {
      return res.status(400).json({ error: 'Ese título no pertenece a la sección elegida.' });
    }
  }

  let codigoFinal = null;
  if (seMudo) {
    const choque = chocaDeGrupo(cuenta.seccion_id, secDestino.id);
    if (choque) return res.status(400).json({ error: choque });
    const dest = prefijoDestino(secDestino, titDestino);
    if (dest.error) return res.status(400).json({ error: dest.error });
    codigoFinal = proximoCodigoLibre(dest.prefijo, id);
    if (!codigoFinal) {
      return res.status(400).json({ error: `No quedan códigos libres bajo ${dest.prefijo}.` });
    }
  } else if (codigo && codigo !== cuenta.codigo) {
    // Sin mudanza, el código lo escribe el usuario: se valida el formato, que no
    // esté repetido, y que cuelgue de donde la cuenta está parada.
    const codigoStr = String(codigo).trim();
    if (!RE_CUENTA.test(codigoStr)) {
      return res.status(400).json({ error: 'Código inválido. Las cuentas deben respetar el formato X.XX.XX.XXXX (ej: 1.01.01.0001).' });
    }
    const choque = codigoEnUso(db, codigoStr, { tabla: 'cuentas', id });
    if (choque) return res.status(400).json({ error: mensajeChoque(codigoStr, choque) });
    const cuelga = titDestino
      ? noCuelgaDe(codigoStr, titDestino.codigo, 'el título')
      : noCuelgaDe(codigoStr, secDestino.codigo, 'la sección');
    if (cuelga) return res.status(400).json({ error: cuelga });
    codigoFinal = codigoStr;
  }

  try {
    db.prepare(`
      UPDATE sg_cuentas
         SET codigo            = COALESCE(?, codigo),
             nombre            = COALESCE(?, nombre),
             seccion_id        = COALESCE(?, seccion_id),
             titulo_id         = CASE WHEN ? IS NOT NULL THEN ? ELSE titulo_id END,
             tipo              = COALESCE(?, tipo),
             permite_lote      = COALESCE(?, permite_lote),
             permite_campania  = COALESCE(?, permite_campania),
             actualizado_en    = datetime('now','localtime')
       WHERE id = ?
    `).run(
      codigoFinal,
      nombre ? String(nombre).trim() : null,
      destinoSecId,
      1,
      destinoTitId,
      tipo ?? null,
      permite_lote === undefined ? null : (permite_lote ? 1 : 0),
      permite_campania === undefined ? null : (permite_campania ? 1 : 0),
      id
    );
    // Sólo se toca la lista si el pedido la trae: un PUT que no habla de
    // usuarios no le tiene que borrar la restricción a la cuenta.
    let usuarios;
    if (req.body && req.body.usuarios_ids !== undefined) {
      usuarios = guardarUsuariosDeCuenta(id, req.body.usuarios_ids);
    }
    logAccion({
      cuenta_id: id,
      accion: 'editar',
      detalle: { antes: cuenta, despues: req.body },
      usuario_id: req._user?.id,
    });
    res.json({ ok: true, usuarios_ids: usuarios, codigo: codigoFinal || cuenta.codigo, movida: seMudo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id(\\d+)', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cuenta = db.prepare('SELECT * FROM sg_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });
  if (cuenta.es_sistema) {
    return res.status(400).json({ error: 'Es una cuenta del sistema: no se puede borrar.' });
  }

  // ── ACÁ SÍ HAY UNA DIFERENCIA REAL, Y ES CONTABLE ───────────────────────
  // Una cuenta que YA SE USÓ en un asiento no se puede borrar: el asiento
  // quedaría apuntando a una cuenta que no existe y el libro dejaría de cuadrar.
  // Esa se desactiva, y su código sigue tomado — correctamente, porque esa cuenta
  // existe en la historia.
  //
  // Una cuenta que NUNCA se usó no es historia, es un error de carga: se borra
  // de verdad y libera el código.
  // ambito: todos — se pregunta si la cuenta está USADA para no dejar borrarla.
  // Una cuenta usada sólo por líneas de gestión está igual de usada.
  const usos = db.prepare('SELECT COUNT(*) c FROM sg_asientos_lineas WHERE cuenta_id = ?').get(id).c;
  if (usos) {
    db.prepare("UPDATE sg_cuentas SET activo = 0, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
    logAccion({ cuenta_id: id, accion: 'desactivar',
                detalle: { codigo: cuenta.codigo, nombre: cuenta.nombre, usos },
                usuario_id: req._user?.id });
    return res.json({
      ok: true, desactivada: true,
      aviso: `La cuenta se usó en ${usos} línea(s) de asiento, así que no se puede borrar `
           + `sin romper esos asientos: quedó DESACTIVADA. No aparece más para elegir, pero `
           + `sigue en los libros y su código sigue ocupado.`,
    });
  }
  db.prepare('DELETE FROM sg_cuentas WHERE id = ?').run(id);
  // El código y el nombre van en `detalle` porque la fila que los tenía se acaba
  // de ir: el JOIN del log ya no la encuentra. Sin esto el renglón queda
  // "borrar — — —", que en un plan de cuentas no sirve para nada.
  logAccion({ cuenta_id: id, accion: 'borrar',
              detalle: { codigo: cuenta.codigo, nombre: cuenta.nombre },
              usuario_id: req._user?.id });
  res.json({ ok: true, borrada: true });
});

router.post('/:id(\\d+)/reactivar', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE sg_cuentas SET activo = 1, actualizado_en = datetime('now','localtime') WHERE id = ?").run(id);
  logAccion({ cuenta_id: id, accion: 'reactivar', usuario_id: req._user?.id });
  res.json({ ok: true });
});

// POST /:id/mover  body: { direccion: 'arriba' | 'abajo' }
router.post('/:id(\\d+)/mover', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const direccion = req.body?.direccion;
  if (!['arriba', 'abajo'].includes(direccion)) {
    return res.status(400).json({ error: 'direccion debe ser arriba|abajo' });
  }
  const cuenta = db.prepare('SELECT * FROM sg_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });

  const op = direccion === 'arriba' ? '<' : '>';
  const order = direccion === 'arriba' ? 'DESC' : 'ASC';
  const vecina = db.prepare(`
    SELECT * FROM sg_cuentas
     WHERE seccion_id = ?
       AND codigo ${op} ?
       AND activo = 1
     ORDER BY codigo ${order}
     LIMIT 1
  `).get(cuenta.seccion_id, cuenta.codigo);

  if (!vecina) return res.json({ ok: true, sin_cambio: true });

  const tmp = `__TMP_${Date.now()}_${id}`;
  const tx = db.transaction(() => {
    db.prepare('UPDATE sg_cuentas SET codigo = ? WHERE id = ?').run(tmp, cuenta.id);
    db.prepare('UPDATE sg_cuentas SET codigo = ? WHERE id = ?').run(cuenta.codigo, vecina.id);
    db.prepare('UPDATE sg_cuentas SET codigo = ? WHERE id = ?').run(vecina.codigo, cuenta.id);
  });
  tx();

  logAccion({
    cuenta_id: id,
    accion: 'reordenar',
    detalle: { direccion, vecina_id: vecina.id, swap: [cuenta.codigo, vecina.codigo] },
    usuario_id: req._user?.id,
  });

  res.json({ ok: true });
});

// POST /:id/reasignar-titulo  body: { titulo_id: number|null, seccion_id?: number }
router.post('/:id(\\d+)/reasignar-titulo', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cuenta = db.prepare('SELECT * FROM sg_cuentas WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'cuenta no encontrada' });
  if (cuenta.es_sistema) {
    return res.status(400).json({ error: 'cuenta del sistema, no se puede reorganizar' });
  }

  const tituloIdRaw = req.body?.titulo_id;
  const tituloId = (tituloIdRaw === null || tituloIdRaw === undefined || tituloIdRaw === '')
    ? null : parseInt(tituloIdRaw, 10);
  // Soltarla en OTRA SECCIÓN, sin título. Antes este parámetro se declaraba en el
  // comentario de la ruta y no se leía: la cuenta se quedaba siempre en su propia
  // sección, así que sacarla de un título para llevarla a otro lado no se podía.
  const seccionPedidaRaw = req.body?.seccion_id;
  const seccionPedida = (seccionPedidaRaw === null || seccionPedidaRaw === undefined || seccionPedidaRaw === '')
    ? null : parseInt(seccionPedidaRaw, 10);

  let seccionId = cuenta.seccion_id;
  let nuevoCodigo = null;

  // ── SACAR UNA CUENTA DE SU TÍTULO LE ROMPÍA EL CÓDIGO ──────────────────
  // Al soltarla en "Sin título asignado", el código que se le armaba era
  // seccion.codigo + '.' + dos dígitos → para la sección 4.01 salía "4.01.06":
  // TRES tramos, con forma de TÍTULO. Una cuenta así no cumple el formato
  // X.XX.XX.XXXX, el PUT la rechaza (no se la puede volver a editar), pasa a ser
  // "padre" de cualquier 4.01.06.XXXX y por lo tanto NO IMPUTABLE, y encima el
  // chequeo de choque miraba sólo sg_cuentas, así que podía quedar con el mismo
  // código que un título de verdad.
  //
  // Ahora el tramo "sin título" es el .00 de la sección: 4.01.00.NNNN. Es el
  // mismo que usa el alta por lote, cumple el formato, y no se pisa con nada
  // porque el choque se chequea contra las TRES tablas.
  const prefijoSinTitulo = (sec) => `${sec.codigo}.00`;
  const proximoLibre = (prefijo) => proximoCodigoLibre(prefijo, id);

  // ── NO SE CRUZA DE GRUPO ──────────────────────────────────────────────
  // Una cuenta de Activo no se arrastra a Ingresos. No es una preferencia de
  // pantalla: el grupo es LO QUE LA CUENTA ES. Mover un Activo a Ingresos no
  // reordena nada, cambia la naturaleza de la cuenta — y los asientos que ya la
  // usaron se quedan diciendo otra cosa de la que dijeron el día que se hicieron.
  //
  // Se chequea en el servidor y no sólo en la pantalla: el árbol muestra un grupo
  // por vez, así que arrastrando no se llega a otro, pero el pedido a mano sí.
  const grupoDe = (secId) =>
    db.prepare('SELECT grupo FROM sg_cuentas_secciones WHERE id = ?').get(secId)?.grupo || null;
  const destinoSec = tituloId
    ? db.prepare('SELECT seccion_id FROM sg_cuentas_titulos WHERE id = ?').get(tituloId)?.seccion_id
    : (seccionPedida || cuenta.seccion_id);
  const grupoOrigen  = grupoDe(cuenta.seccion_id);
  const grupoDestino = destinoSec ? grupoDe(destinoSec) : null;
  if (grupoOrigen && grupoDestino && grupoOrigen !== grupoDestino) {
    const nombre = { activo: 'Activo', pasivo: 'Pasivo', patrimonio_neto: 'Patrimonio',
                     ingresos: 'Ingresos', gastos: 'Egresos' };
    return res.status(400).json({
      error: `No se puede mover una cuenta de ${nombre[grupoOrigen] || grupoOrigen} a `
           + `${nombre[grupoDestino] || grupoDestino}: el grupo dice qué ES la cuenta, y los `
           + `asientos que ya la usaron quedarían diciendo otra cosa. Si de verdad va en el otro `
           + `grupo, creá la cuenta nueva allá y desactivá ésta.`,
    });
  }

  try {
    if (tituloId) {
      const tit = db.prepare('SELECT * FROM sg_cuentas_titulos WHERE id = ?').get(tituloId);
      if (!tit) return res.status(400).json({ error: 'titulo_id inválido' });
      if (!/^\d\.\d{2}\.\d{2}$/.test(String(tit.codigo))) {
        return res.status(400).json({
          error: `Abajo del título ${tit.codigo} no puede colgar ninguna cuenta: su código no `
               + `respeta el formato X.XX.XX (un solo dígito de grupo). Editalo y ponele uno `
               + `válido —por ejemplo ${sugerirTitulo(tit.codigo)}— y recién ahí movés la cuenta.`,
        });
      }
      seccionId = tit.seccion_id;
      nuevoCodigo = proximoLibre(String(tit.codigo));
      if (!nuevoCodigo) {
        return res.status(400).json({ error: `No quedan códigos libres bajo el título ${tit.codigo}.` });
      }
    } else {
      if (seccionPedida) seccionId = seccionPedida;
      const sec = db.prepare('SELECT * FROM sg_cuentas_secciones WHERE id = ?').get(seccionId);
      if (!sec) return res.status(400).json({ error: 'la sección de destino no existe' });
      if (!/^\d\.\d{2}$/.test(String(sec.codigo))) {
        return res.status(400).json({
          error: `Esta cuenta no puede quedar SIN TÍTULO en la sección ${sec.codigo}: para eso `
               + `su código tendría que ser X.XX (un solo dígito de grupo) y no lo es. `
               + `Soltala dentro de un título, o editá la sección y ponele un código válido, `
               + `por ejemplo ${sugerirSeccion(sec.codigo)}.`,
        });
      }
      nuevoCodigo = proximoLibre(prefijoSinTitulo(sec));
      if (!nuevoCodigo) {
        return res.status(400).json({ error: `No quedan códigos libres bajo ${prefijoSinTitulo(sec)}.` });
      }
    }

    db.prepare(`
      UPDATE sg_cuentas
         SET titulo_id = ?, seccion_id = ?, codigo = ?, actualizado_en = datetime('now','localtime')
       WHERE id = ?
    `).run(tituloId, seccionId, nuevoCodigo, id);

    logAccion({
      cuenta_id: id,
      accion: 'reasignar_titulo',
      detalle: { antes: { codigo: cuenta.codigo, titulo_id: cuenta.titulo_id }, despues: { codigo: nuevoCodigo, titulo_id: tituloId } },
      usuario_id: req._user?.id,
    });

    res.json({ ok: true, codigo: nuevoCodigo, titulo_id: tituloId, seccion_id: seccionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id(\\d+)/log', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const log = db.prepare(`
    SELECT l.*, u.nombre AS usuario_nombre
      FROM sg_cuentas_log l
      LEFT JOIN usuarios u ON u.id = l.usuario_id
     WHERE l.cuenta_id = ?
     ORDER BY l.creado_en DESC
     LIMIT 200
  `).all(id);
  res.json({ ok: true, data: log });
});

// ═══════════════════════════════════════════════════════════════════════════
// ASIENTOS CONTABLES — partida doble manual
// ═══════════════════════════════════════════════════════════════════════════

router.get('/asientos', (req, res) => {
  const { desde, hasta, ambito } = req.query;
  const incluirAnulados = req.query.anulados === '1';
  const params = [];
  let sql = `
    SELECT a.*, u.nombre AS usuario_nombre
      FROM sg_asientos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE 1 = 1
  `;
  if (!incluirAnulados) { sql += ' AND a.anulado = 0'; }
  if (desde) { sql += ' AND a.fecha >= ?'; params.push(desde); }
  if (hasta) { sql += ' AND a.fecha <= ?'; params.push(hasta); }
  sql += ' ORDER BY a.fecha DESC, a.id DESC LIMIT 200';
  const asientos = db.prepare(sql).all(...params);

  // LAS LÍNEAS VIAJAN CON LA CABECERA. Sin esto la pantalla muestra Debe y Haber
  // en $0,00 en todas las filas —los suma sobre a.lineas— y el Excel sale sin un
  // solo importe y corrido una columna, porque la rama "asiento sin líneas" arma
  // 11 valores contra 12 encabezados.
  //
  // Se traen todas de una sola consulta y se reparten en JS: hacerlo con un
  // SELECT por asiento serían 200 consultas para pintar una tabla.
  if (asientos.length) {
    const ids = asientos.map(a => a.id);
    // EL FILTRO DE ÁMBITO VA EN LAS LÍNEAS, no en la cabecera: un mismo asiento
    // puede tener las dos mitades. Pidiendo 'fiscal' se ve exactamente lo que va
    // a una presentación; sin ámbito se ve todo y la diferencia se puede medir.
    const fa = filtroAmbito(ambito, 'l');
    const lineas = db.prepare(`
      SELECT l.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre
        FROM sg_asientos_lineas l
        -- LEFT y no JOIN interno: si una línea quedó apuntando a una cuenta que
        -- ya no está, un JOIN interno la descarta y el asiento se muestra
        -- descuadrado sin que nada avise. Mejor que salga sin nombre de cuenta y
        -- se vea el problema.
        LEFT JOIN sg_cuentas c ON c.id = l.cuenta_id
       WHERE l.asiento_id IN (${ids.map(() => '?').join(',')})${fa.sql}
       ORDER BY l.id`).all(...ids, ...fa.params);
    const porAsiento = {};
    for (const l of lineas) (porAsiento[l.asiento_id] = porAsiento[l.asiento_id] || []).push(l);
    for (const a of asientos) a.lineas = porAsiento[a.id] || [];
  }
  // Filtrando por ámbito, un asiento sin líneas de ese ámbito no es un asiento
  // vacío: es uno que no pertenece a ese libro y no tiene que figurar.
  const data = ambito ? asientos.filter((a) => (a.lineas || []).length) : asientos;
  res.json({ ok: true, data });
});

router.get('/asientos/:id(\\d+)', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const asiento = db.prepare(`
    SELECT a.*, u.nombre AS usuario_nombre
      FROM sg_asientos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.id = ?
  `).get(id);
  if (!asiento) return res.status(404).json({ error: 'asiento no encontrado' });
  // ambito: todos — el detalle muestra las dos mitades, cada una con su marca y
  // su propio "balancea". Filtrar acá escondería justo lo que se viene a ver.
  const lineas = db.prepare(`
    SELECT l.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre
      FROM sg_asientos_lineas l
      JOIN sg_cuentas c ON c.id = l.cuenta_id
     WHERE l.asiento_id = ?
     ORDER BY l.id
  `).all(id);
  res.json({ ok: true, data: { ...asiento, lineas, totales: totalesDeAsiento(db, id) } });
});

// ═══════════════════════════════════════════════════════════════════════════
// ASIENTOS MODELO — CRUD
// ═══════════════════════════════════════════════════════════════════════════

router.get('/modelos', (req, res) => {
  const modelos = db.prepare(`
    -- tiene_linea_proveedores lo consume la tabla de la pantalla para marcar los
    -- modelos incompletos. Sin esta columna llega undefined, la condición del
    -- front da siempre verdadero y TODOS los modelos salen con el cartel
    -- "sin Proveedores", incluso los que la tienen.
    SELECT m.*, COUNT(l.id) as cant_lineas,
           MAX(CASE WHEN l.tipo_linea = 'proveedores' THEN 1 ELSE 0 END) AS tiene_linea_proveedores
    FROM sg_asientos_modelo m
    LEFT JOIN sg_asientos_modelo_lineas l ON l.modelo_id = m.id
    WHERE m.activo = 1
    GROUP BY m.id ORDER BY m.nombre
  `).all();
  res.json({ ok: true, data: modelos });
});

router.get('/modelos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const modelo = db.prepare('SELECT * FROM sg_asientos_modelo WHERE id = ?').get(id);
  if (!modelo) return res.status(404).json({ error: 'modelo no encontrado' });
  const lineas = db.prepare(`
    SELECT l.*, c.nombre as cuenta_nombre, c.codigo as cuenta_codigo
    FROM sg_asientos_modelo_lineas l
    JOIN sg_cuentas c ON c.id = l.cuenta_id
    WHERE l.modelo_id = ? ORDER BY l.orden, l.id
  `).all(id);
  res.json({ ok: true, data: { ...modelo, lineas } });
});

router.post('/modelos', requireAdmin, (req, res) => {
  const { nombre, descripcion, lineas } = req.body || {};
  if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });
  if (!Array.isArray(lineas) || lineas.length < 2)
    return res.status(400).json({ error: 'El modelo debe tener al menos 2 líneas' });
  const tieneDebe = lineas.some(l => l.lado === 'debe');
  const tieneHaber = lineas.some(l => l.lado === 'haber');
  if (!tieneDebe || !tieneHaber)
    return res.status(400).json({ error: 'El modelo debe tener al menos 1 línea en el debe y 1 en el haber' });
  // ── LA LÍNEA DE PROVEEDORES ────────────────────────────────────────────
  // Misma regla que Puente Cordón (cuentas.js). Sin esta validación el modelo se
  // guarda igual y el problema aparece meses después: un asiento balanceado pero
  // contablemente falso, porque nadie sabe cuál de las líneas del haber era la
  // del proveedor. Un 400 con el usuario parado en el editor es preferible.
  const _prov = lineas.filter(l => l.tipo_linea === 'proveedores');
  if (_prov.length > 1)
    return res.status(400).json({ error: 'El modelo no puede tener más de una línea de tipo "Proveedores".' });
  if (_prov.length === 1 && _prov[0].lado !== 'haber')
    return res.status(400).json({ error: 'La línea de tipo "Proveedores" tiene que ir en el HABER.' });
  if (_prov.length === 0 && req.body.permitir_sin_proveedores !== true)
    return res.status(400).json({
      codigo: 'SIN_LINEA_PROVEEDORES',
      error: 'El modelo no tiene ninguna línea marcada como "Proveedores (Haber)". Sin ella no se pueden registrar facturas de compra ni emitir órdenes de pago con este modelo.'
    });
  for (const l of lineas) {
    if (l.cuenta_id && !cuentaEsImputable(db, parseInt(l.cuenta_id))) {
      const c = db.prepare('SELECT codigo, nombre FROM sg_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(400).json({ error: `La cuenta ${c ? c.codigo + ' — ' + c.nombre : '#' + l.cuenta_id} no es imputable (es un rubro agrupador). Elegí una cuenta final.` });
    }
    if (l.cuenta_id && !puedeUsarCuenta(req._user, parseInt(l.cuenta_id))) {
      const c = db.prepare('SELECT id, codigo, nombre FROM sg_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(403).json({ error: mensajeRestringida(c) });
    }
  }
  try {
    const tx = db.transaction(() => {
      const r = db.prepare(`INSERT INTO sg_asientos_modelo (nombre, descripcion) VALUES (?, ?)`)
        .run(String(nombre).trim(), descripcion || null);
      const modeloId = r.lastInsertRowid;
      const ins = db.prepare(`INSERT INTO sg_asientos_modelo_lineas (modelo_id, cuenta_id, lado, descripcion, orden, tipo_linea) VALUES (?, ?, ?, ?, ?, ?)`);
      lineas.forEach((l, i) => ins.run(modeloId, l.cuenta_id, l.lado, l.descripcion || null, i, l.tipo_linea || 'libre'));
      return modeloId;
    });
    res.json({ ok: true, id: tx() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/modelos/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { nombre, descripcion, lineas } = req.body || {};
  const existe = db.prepare('SELECT id FROM sg_asientos_modelo WHERE id = ?').get(id);
  if (!existe) return res.status(404).json({ error: 'modelo no encontrado' });
  if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });
  if (!Array.isArray(lineas) || lineas.length < 2)
    return res.status(400).json({ error: 'El modelo debe tener al menos 2 líneas' });
  const tieneDebe = lineas.some(l => l.lado === 'debe');
  const tieneHaber = lineas.some(l => l.lado === 'haber');
  if (!tieneDebe || !tieneHaber)
    return res.status(400).json({ error: 'El modelo debe tener al menos 1 línea en el debe y 1 en el haber' });
  // ── LA LÍNEA DE PROVEEDORES ────────────────────────────────────────────
  // Misma regla que Puente Cordón (cuentas.js). Sin esta validación el modelo se
  // guarda igual y el problema aparece meses después: un asiento balanceado pero
  // contablemente falso, porque nadie sabe cuál de las líneas del haber era la
  // del proveedor. Un 400 con el usuario parado en el editor es preferible.
  const _prov = lineas.filter(l => l.tipo_linea === 'proveedores');
  if (_prov.length > 1)
    return res.status(400).json({ error: 'El modelo no puede tener más de una línea de tipo "Proveedores".' });
  if (_prov.length === 1 && _prov[0].lado !== 'haber')
    return res.status(400).json({ error: 'La línea de tipo "Proveedores" tiene que ir en el HABER.' });
  if (_prov.length === 0 && req.body.permitir_sin_proveedores !== true)
    return res.status(400).json({
      codigo: 'SIN_LINEA_PROVEEDORES',
      error: 'El modelo no tiene ninguna línea marcada como "Proveedores (Haber)". Sin ella no se pueden registrar facturas de compra ni emitir órdenes de pago con este modelo.'
    });
  for (const l of lineas) {
    if (l.cuenta_id && !cuentaEsImputable(db, parseInt(l.cuenta_id))) {
      const c = db.prepare('SELECT codigo, nombre FROM sg_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(400).json({ error: `La cuenta ${c ? c.codigo + ' — ' + c.nombre : '#' + l.cuenta_id} no es imputable (es un rubro agrupador). Elegí una cuenta final.` });
    }
    if (l.cuenta_id && !puedeUsarCuenta(req._user, parseInt(l.cuenta_id))) {
      const c = db.prepare('SELECT id, codigo, nombre FROM sg_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(403).json({ error: mensajeRestringida(c) });
    }
  }
  try {
    db.transaction(() => {
      db.prepare('UPDATE sg_asientos_modelo SET nombre=?, descripcion=? WHERE id=?')
        .run(String(nombre).trim(), descripcion || null, id);
      db.prepare('DELETE FROM sg_asientos_modelo_lineas WHERE modelo_id = ?').run(id);
      const ins = db.prepare(`INSERT INTO sg_asientos_modelo_lineas (modelo_id, cuenta_id, lado, descripcion, orden, tipo_linea) VALUES (?, ?, ?, ?, ?, ?)`);
      lineas.forEach((l, i) => ins.run(id, l.cuenta_id, l.lado, l.descripcion || null, i, l.tipo_linea || 'libre'));
    })();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/modelos/:id', requireAdmin, (req, res) => {
  db.prepare("UPDATE sg_asientos_modelo SET activo = 0 WHERE id = ?").run(parseInt(req.params.id));
  res.json({ ok: true });
});

// POST /asientos — crear asiento (partida doble)
// ── QUIÉN CARGA UN ASIENTO ────────────────────────────────────────────────
// Pasa de "sólo admin" a "quien tenga el módulo Asientos SG", y no es un
// aflojamiento: cuando esto se escribió, el nivel por módulo no se aplicaba a
// nada, así que pedir admin era la única defensa que había. Hoy sí se aplica —
// /api/sg/contable/asientos está declarado en ensure_api_prefijos.js— y el
// guardián corta con 403 al que no tenga el módulo, y también al que lo tenga
// sólo en "Ver". Dos controles para lo mismo, y el de acá era el que impedía
// que la restricción por cuenta sirviera para algo: el operador nunca llegaba
// hasta ella.
//
// Anular sigue siendo aparte: la dirección lleva /anular, así que exigirNivel
// pide nivel "anular", que es más que "operar".
router.post('/asientos', requireAuth, (req, res) => {
  const { fecha, descripcion, lineas } = req.body || {};

  if (!descripcion) return res.status(400).json({ error: 'descripcion es requerida' });
  if (!Array.isArray(lineas) || lineas.length < 2) {
    return res.status(400).json({ error: 'el asiento debe tener al menos 2 líneas' });
  }

  const totalDebe  = lineas.reduce((s, l) => s + (parseFloat(l.debe)  || 0), 0);
  const totalHaber = lineas.reduce((s, l) => s + (parseFloat(l.haber) || 0), 0);
  if (Math.abs(totalDebe - totalHaber) > 0.01) {
    return res.status(400).json({
      error: `partida doble no cuadra: debe=${totalDebe.toFixed(2)} haber=${totalHaber.toFixed(2)}`
    });
  }

  for (const l of lineas) {
    if (!l.cuenta_id) return res.status(400).json({ error: 'cada línea debe tener cuenta_id' });
    const c = db.prepare('SELECT id FROM sg_cuentas WHERE id = ? AND activo = 1').get(l.cuenta_id);
    if (!c) return res.status(400).json({ error: `cuenta_id ${l.cuenta_id} no existe o está inactiva` });
    if (!cuentaEsImputable(db, parseInt(l.cuenta_id))) {
      const cc = db.prepare('SELECT codigo, nombre FROM sg_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(400).json({ error: `La cuenta ${cc ? cc.codigo + ' — ' + cc.nombre : '#' + l.cuenta_id} no es imputable (es un rubro agrupador). Elegí una cuenta final.` });
    }
    // La restricción por usuario. Va acá, en el ALTA DEL ASIENTO, porque es el
    // momento en que la cuenta se usa de verdad: bloquearla sólo en el selector
    // del front la dejaría abierta para cualquiera que mande el pedido a mano.
    if (!puedeUsarCuenta(req._user, parseInt(l.cuenta_id))) {
      const cc = db.prepare('SELECT id, codigo, nombre FROM sg_cuentas WHERE id = ?').get(parseInt(l.cuenta_id));
      return res.status(403).json({ error: mensajeRestringida(cc) });
    }
  }

  try {
    const tx = db.transaction(() => crearAsiento(db, {
      fecha: fecha || new Date().toISOString().slice(0, 10),
      descripcion: String(descripcion).trim(),
      usuario_id: req._user?.id ?? null,
    }, lineas.map((l) => ({
      cuenta_id: l.cuenta_id,
      debe: parseFloat(l.debe) || 0,
      haber: parseFloat(l.haber) || 0,
      descripcion: l.descripcion ?? null,
      ambito: l.ambito, motivo: l.motivo,
    }))).id);
    res.json({ ok: true, id: tx() });
  } catch (e) {
    // Los errores de crearAsiento son de lo que se cargó —no balancea, falta el
    // motivo, la cuenta no existe—, así que van como 400 y con su texto: un 500
    // "error interno" le esconde al usuario lo único que puede corregir.
    res.status(400).json({ error: e.message });
  }
});

router.post('/asientos/:id(\\d+)/anular', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const asiento = db.prepare('SELECT * FROM sg_asientos WHERE id = ?').get(id);
  if (!asiento) return res.status(404).json({ error: 'asiento no encontrado' });
  if (asiento.anulado) return res.status(400).json({ error: 'el asiento ya está anulado' });
  db.prepare(`
    UPDATE sg_asientos
       SET anulado = 1, anulado_por = ?, anulado_en = datetime('now','localtime')
     WHERE id = ?
  `).run(req._user?.id ?? null, id);
  res.json({ ok: true });
});

// ── config-impositiva ────────────────────────────────────────────────────────
router.get('/config-impositiva', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT ci.clave, ci.cuenta_id, ci.descripcion,
        c.nombre as cuenta_nombre, c.codigo as cuenta_codigo
      FROM sg_config_impositiva ci
      LEFT JOIN sg_cuentas c ON c.id = ci.cuenta_id
      ORDER BY ci.clave
    `).all();
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// requireAdmin y no requireAuth: era el ÚNICO de los 21 endpoints de escritura
// de este router que pedía nada más estar logueado, y justo es el que decide a
// qué cuenta contable van el IVA Crédito Fiscal, el Débito Fiscal, las
// percepciones y las retenciones de San Gerónimo. Se midió: un usuario sin una
// sola fila de permisos cargados lo reescribía. Es configuración contable, no
// operación diaria.
router.put('/config-impositiva', requireAdmin, (req, res) => {
  const { clave, cuenta_id } = req.body || {};
  if (!clave) return res.status(400).json({ ok: false, error: 'clave requerida' });
  // Whitelist: el UPSERT de abajo crearía una fila nueva con cualquier clave que
  // llegue, y esa fila después aparece en la pantalla de configuración.
  const CLAVES = ['iva_credito_fiscal', 'iva_debito_fiscal', 'percepcion_iva',
                  'percepcion_iibb', 'percepcion_ganancias', 'retencion', 'ventas',
                  'cheques_cartera', 'cheques_rechazados'];
  if (!CLAVES.includes(clave)) return res.status(400).json({ ok: false, error: 'clave desconocida: ' + clave });
  try {
    const cid = cuenta_id ? parseInt(cuenta_id) : null;
    if (cid && !db.prepare('SELECT 1 FROM sg_cuentas WHERE id = ?').get(cid)) {
      return res.status(400).json({ ok: false, error: 'La cuenta no existe en el plan de San Gerónimo' });
    }
    // Y TIENE QUE SER IMPUTABLE. Un rubro agrupador —una sección, un título— no
    // acepta movimientos: elegirlo acá dejaba la configuración guardada y el
    // asiento reventaba recién el día que alguien cobraba con cheque. Se
    // controla acá, que es cuando se puede cambiar de opinión sin costo.
    if (cid && !cuentaEsImputable(db, cid)) {
      const c = db.prepare('SELECT codigo, nombre FROM sg_cuentas WHERE id=?').get(cid);
      return res.status(400).json({ ok: false,
        error: `La cuenta ${c.codigo} — ${c.nombre} no es imputable: es un rubro agrupador. `
             + `Elegí una cuenta final.` });
    }
    // UPSERT y no UPDATE: si la clave no estaba sembrada, el UPDATE afectaba 0
    // filas y el panel igual mostraba "✓ Configuración guardada". Puente Cordón
    // ya tuvo exactamente este bug y por eso su endpoint es un UPSERT.
    const r = db.prepare(`
      INSERT INTO sg_config_impositiva (clave, cuenta_id) VALUES (?, ?)
      ON CONFLICT(clave) DO UPDATE SET cuenta_id = excluded.cuenta_id
    `).run(clave, cid);
    if (!r.changes) return res.status(500).json({ ok: false, error: 'No se pudo guardar la configuración' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
