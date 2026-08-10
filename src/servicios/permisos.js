// src/servicios/permisos.js
// ── LA EMPRESA LA DECIDE EL SERVIDOR ──────────────────────────────────────
//
// Un solo lugar donde se resuelve "¿de qué empresa es este pedido?", y donde se
// contesta que NO cuando corresponde.
//
// Antes cada router traía su propia copia de getSociedadId(), y todas hacían lo
// mismo: tomaban el sociedad_id que mandaba el navegador y verificaban que esa
// sociedad existiera. Existir no es tener derecho: con eso, cambiar un número en
// el navegador alcanzaba para pedir los datos de otra empresa, y el servidor los
// entregaba.
//
// Acá se agrega la pregunta que faltaba: ¿esta persona pertenece a esa empresa?
//
// POR QUÉ NO ALCANZA CON EL PREFIJO DE TABLAS
// El aislamiento por tablas propias (sg_, pa_, bt_) es fuerte para los datos de
// cada módulo: los de una empresa no están ni en las mismas tablas que los de
// otra. Pero no cubre dos cosas — las tablas transversales que sí llevan una
// columna sociedad_id (órdenes de pago, bancos, planificación), y el hecho de que
// alguien entre a un MÓDULO que no es de su empresa. Eso lo cubre esto.
import db from './db.js';
import './db_permisos.js';

// ── QUÉ EMPRESAS VE UNA PERSONA ───────────────────────────────────────────
// Un admin las ve todas, y a propósito no se le pide que estén cargadas: el rol
// existe justamente para que el sistema no quede trabado, y un admin sin empresas
// asignadas no podría ni entrar a arreglarlo.
export function sociedadesDe(usuario) {
  if (!usuario || !usuario.id) return [];
  if (usuario.rol === 'admin') {
    return db.prepare('SELECT id FROM sociedades WHERE activa = 1 ORDER BY id').all().map(r => r.id);
  }
  return db.prepare(
    `SELECT s.id FROM usuario_sociedades us
       JOIN sociedades s ON s.id = us.sociedad_id AND s.activa = 1
      WHERE us.usuario_id = ? ORDER BY s.id`
  ).all(usuario.id).map(r => r.id);
}

// Con nombre, para el selector del panel.
export function sociedadesConNombreDe(usuario) {
  const ids = sociedadesDe(usuario);
  if (!ids.length) return [];
  return db.prepare(
    `SELECT id, nombre FROM sociedades WHERE activa = 1 AND id IN (${ids.map(() => '?').join(',')})
      ORDER BY id`
  ).all(...ids);
}

export function puedeVerSociedad(usuario, sociedadId) {
  const id = parseInt(sociedadId, 10);
  if (!Number.isInteger(id)) return false;
  return sociedadesDe(usuario).includes(id);
}

// ── RESOLVER LA EMPRESA DE UN PEDIDO ──────────────────────────────────────
// Devuelve { id } o { error, status }. No lanza: cada router decide cómo contestar.
//
// Tres casos, y el del medio es el que antes no existía:
//   · Pide una empresa y le corresponde        → esa.
//   · Pide una empresa que NO le corresponde   → 403. No se cae en silencio a otra:
//     devolver los datos de una empresa distinta a la pedida es peor que un error,
//     porque el que mira cree que está viendo lo que pidió.
//   · No pide ninguna                          → la primera suya (y si no tiene
//     ninguna, 403: alguien sin empresas no puede operar en ninguna).
export function resolverSociedad(req) {
  const mias = sociedadesDe(req.user);
  const raw = req.body?.sociedad_id ?? req.query?.sociedad_id;
  const pedida = (raw !== undefined && raw !== null && raw !== '') ? parseInt(raw, 10) : null;

  if (Number.isInteger(pedida)) {
    if (!mias.includes(pedida)) {
      return {
        error: 'No tenés acceso a esa empresa. Cambiá el selector de empresa.',
        status: 403,
      };
    }
    return { id: pedida };
  }

  if (!mias.length) {
    return {
      error: 'Tu usuario no tiene ninguna empresa asignada. Pedile a un administrador que te asigne una.',
      status: 403,
    };
  }
  return { id: mias[0] };
}

// Middleware para los routers que ya trabajan con sociedad. Deja el id en
// req.sociedadId y corta con 403 si no corresponde.
export function conSociedad(req, res, next) {
  const r = resolverSociedad(req);
  if (r.error) return res.status(r.status).json({ ok: false, error: r.error });
  req.sociedadId = r.id;
  next();
}

// ── UN MÓDULO ES DE UNA EMPRESA ───────────────────────────────────────────
// Guard para los routers de un módulo que pertenece a UNA empresa concreta, como
// el de Barceló. Se busca la sociedad por nombre y no por id porque los ids
// dependen del orden en que se cargaron y no son estables entre instalaciones.
export function soloSociedad(nombreLike) {
  let cache = null;
  return function (req, res, next) {
    if (cache === null) {
      const s = db.prepare('SELECT id, nombre FROM sociedades WHERE nombre LIKE ?').get(nombreLike);
      cache = s || false;
    }
    if (!cache) return next();   // la empresa no existe todavía: no se traba nada

    if (!puedeVerSociedad(req.user, cache.id)) {
      return res.status(403).json({
        ok: false, error: `Este módulo es de ${cache.nombre} y tu usuario no tiene acceso a esa empresa.`,
      });
    }
    // Y si además vino un selector apuntando a otra empresa, se avisa en vez de
    // mostrar datos de una empresa en la que el usuario cree no estar parado.
    const raw = req.query?.sociedad_id ?? req.body?.sociedad_id;
    if (raw !== undefined && raw !== null && raw !== '' && parseInt(raw, 10) !== cache.id) {
      return res.status(403).json({
        ok: false, error: `Este módulo es de ${cache.nombre}. Cambiá la empresa en el selector.`,
      });
    }
    req.sociedadId = cache.id;
    next();
  };
}

// ── QUÉ MÓDULOS VE UNA PERSONA ────────────────────────────────────────────
// Cruce de dos cosas que ya existían por separado y nunca se habían juntado:
//   · modulos_config.sociedad_id — de qué empresa es cada módulo (los transversales
//     lo tienen en NULL y los ve cualquiera).
//   · usuarios.secciones — la lista de módulos habilitados, que hoy está anulada
//     con ['*'] en auth.js y que este cruce vuelve a poner en uso.
export function modulosVisibles(usuario) {
  const socs = sociedadesDe(usuario);
  const todos = db.prepare('SELECT * FROM modulos_config WHERE oculto = 0 ORDER BY orden, label').all();
  const secciones = seccionesDe(usuario);
  const todasLasSecciones = secciones.includes('*');

  // Si tiene permisos cargados en la tabla nueva, mandan esos. Si no, rigen las
  // secciones de siempre — así esto se puede soltar sin haber configurado a nadie.
  const tienePermisos = !!db.prepare(
    'SELECT 1 FROM usuario_modulos WHERE usuario_id = ? LIMIT 1'
  ).get(usuario.id);

  return todos.filter(m => {
    // De otra empresa: no se ve, aunque tenga el módulo habilitado. La empresa
    // manda sobre el módulo, no al revés.
    if (m.sociedad_id !== null && !socs.includes(m.sociedad_id)) return false;
    if (usuario.rol === 'admin') return true;
    if (tienePermisos) return !!nivelEnModulo(usuario, m.modulo);
    return todasLasSecciones || secciones.includes(m.modulo);
  }).map(m => ({ ...m, nivel: nivelEnModulo(usuario, m.modulo) || 'operar' }));
}

// ── HASTA DÓNDE LLEGA DENTRO DE UN MENÚ ───────────────────────────────────
// Devuelve 'ver' | 'operar' | 'borrar', o null si no tiene acceso al módulo.
//
// Mientras un usuario no tenga NINGÚN permiso cargado en la tabla nueva, se
// comporta como antes: entra a lo que le habiliten las secciones y opera normal.
// Es lo que permite soltar esto sin configurar a nadie primero.
export function nivelEnModulo(usuario, modulo) {
  if (!usuario || !usuario.id || !modulo) return null;
  if (usuario.rol === 'admin') return 'borrar';

  const fila = db.prepare(
    'SELECT nivel FROM usuario_modulos WHERE usuario_id = ? AND modulo = ?'
  ).get(usuario.id, modulo);
  if (fila) return fila.nivel;

  // Sin permisos cargados para esta persona: rige lo de antes.
  const tieneAlguno = db.prepare(
    'SELECT 1 FROM usuario_modulos WHERE usuario_id = ? LIMIT 1'
  ).get(usuario.id);
  if (!tieneAlguno) {
    const secc = seccionesDe(usuario);
    return (secc.includes('*') || secc.includes(modulo)) ? 'operar' : null;
  }
  return null;   // ya tiene permisos configurados y este módulo no está: no entra
}

export function permisosDe(usuario) {
  if (!usuario || !usuario.id) return {};
  const filas = db.prepare(
    'SELECT modulo, nivel FROM usuario_modulos WHERE usuario_id = ?'
  ).all(usuario.id);
  return Object.fromEntries(filas.map(f => [f.modulo, f.nivel]));
}

// Guarda de una sola vez los módulos de un usuario. Reemplazo total: lo que no
// viene en la lista, se le saca. Es lo que hace que destildar signifique algo.
export function guardarPermisos(usuarioId, items, porId = null) {
  const validos = new Set(db.prepare('SELECT modulo FROM modulos_config').all().map(r => r.modulo));
  const NIVELES = new Set(['ver', 'operar', 'borrar']);
  const limpios = (Array.isArray(items) ? items : [])
    .filter(i => i && validos.has(i.modulo))
    .map(i => ({ modulo: i.modulo, nivel: NIVELES.has(i.nivel) ? i.nivel : 'operar' }));

  db.transaction(() => {
    db.prepare('DELETE FROM usuario_modulos WHERE usuario_id = ?').run(usuarioId);
    const ins = db.prepare(
      'INSERT OR REPLACE INTO usuario_modulos (usuario_id, modulo, nivel, creado_por_id) VALUES (?,?,?,?)'
    );
    for (const i of limpios) ins.run(usuarioId, i.modulo, i.nivel, porId);
  })();
  return limpios.length;
}

export function seccionesDe(usuario) {
  if (!usuario || !usuario.id) return [];
  if (usuario.rol === 'admin') return ['*'];
  try {
    const u = db.prepare('SELECT secciones FROM usuarios WHERE id = ?').get(usuario.id);
    if (!u || !u.secciones) return ['*'];       // sin configurar: se comporta como antes
    const v = JSON.parse(u.secciones);
    return Array.isArray(v) ? v : ['*'];
  } catch {
    return ['*'];
  }
}

export default { sociedadesDe, sociedadesConNombreDe, puedeVerSociedad, resolverSociedad,
                 conSociedad, soloSociedad, modulosVisibles, seccionesDe };

// ══════════════════════════════════════════════════════════════════════════
// QUE EL NIVEL SE APLIQUE, NO SÓLO SE GUARDE
// ══════════════════════════════════════════════════════════════════════════
// Un permiso que se configura y no se verifica es peor que no tenerlo: el que lo
// configuró se queda tranquilo creyendo que alguien no puede borrar, y puede.
//
// El módulo de cada pedido sale de `modulos_config.api_prefijos`, una lista de
// prefijos de API por módulo ('sg,sg-abasto' → /api/sg/...). Los módulos que
// todavía no lo declaran NO se controlan por nivel: siguen rigiéndose por el menú.
// Es a propósito — inventar la correspondencia entre 31 routers y 88 módulos
// terminaría bloqueando cosas que no corresponde, y un permiso que bloquea de más
// se desactiva entero a los dos días.

let _mapaApi = null;
function mapaApi() {
  if (_mapaApi) return _mapaApi;
  _mapaApi = [];
  try {
    for (const m of db.prepare(
      "SELECT modulo, api_prefijos FROM modulos_config WHERE api_prefijos IS NOT NULL AND api_prefijos <> ''"
    ).all()) {
      for (const p of String(m.api_prefijos).split(',').map(x => x.trim()).filter(Boolean)) {
        _mapaApi.push({ prefijo: '/api/' + p.replace(/^\/*(api\/)?/, ''), modulo: m.modulo });
      }
    }
    // El más largo primero: /api/sg/ventas tiene que ganarle a /api/sg.
    _mapaApi.sort((a, b) => b.prefijo.length - a.prefijo.length);
  } catch { _mapaApi = []; }
  return _mapaApi;
}
export function limpiarCacheApi() { _mapaApi = null; }

export function moduloDeRuta(url) {
  const limpia = String(url || '').split('?')[0];
  for (const e of mapaApi()) {
    if (limpia === e.prefijo || limpia.startsWith(e.prefijo + '/')) return e.modulo;
  }
  return null;
}

// Middleware. Se monta DESPUÉS de bloquearSiSoloLectura y hace lo que ese no
// puede: distinguir por módulo y separar borrar de editar.
export function exigirNivel(req, res, next) {
  const metodo = req.method;
  if (metodo === 'GET' || metodo === 'HEAD' || metodo === 'OPTIONS') return next();

  let user;
  try { user = JSON.parse(req.cookies?.lnb_user || 'null'); } catch { user = null; }
  if (!user || !user.id) return next();          // que el endpoint conteste el 401
  if (user.rol === 'admin') return next();

  const modulo = moduloDeRuta(req.originalUrl || req.url);
  if (!modulo) return next();                    // módulo sin prefijo declarado

  const nivel = nivelEnModulo(user, modulo);
  if (!nivel) {
    return res.status(403).json({ ok: false, error: 'No tenés acceso a este módulo.' });
  }
  if (nivel === 'ver') {
    return res.status(403).json({
      ok: false, error: 'Tu acceso a este módulo es de solo lectura.', solo_lectura: true,
    });
  }
  // Borrar y anular es lo único que se separa de editar: es la acción que deja
  // afuera trabajo ya hecho. DELETE es explícito; el resto de las bajas del
  // sistema son lógicas y viajan como POST/PATCH a rutas que lo dicen.
  const borra = metodo === 'DELETE'
    || /\/(anular|eliminar|borrar)(\/|$|\?)/i.test(String(req.originalUrl || req.url).split('?')[0]);
  if (borra && nivel !== 'borrar') {
    return res.status(403).json({
      ok: false,
      error: 'Tu usuario puede operar en este módulo, pero no borrar ni anular.',
    });
  }
  next();
}
