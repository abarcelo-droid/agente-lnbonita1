// src/rutas/mejoras.js
// ══ MEJORAS — UNA SOLA PUERTA PARA PEDIR QUE ALGO SE ARREGLE ════════════════
//
// Pablo, 2/9/2026: «cada usuario puede proponer ahí algo para mejorar en cada uno
// de los menús con los que le toca interactuar. Es para UNIFICAR CANALES DE
// COMUNICACIÓN. Obviamente sólo podrá proponer cosas sobre los menús en los que
// tiene acceso. Los administradores vamos a poder asignarles prioridad del 1 al 5
// para que vean en qué estado están sus pedidos, y cuando estén resueltos
// marcarlos como resueltos».
//
// ── SOBRE QUÉ MENÚS PUEDE PROPONER ────────────────────────────────────────
// La lista sale de modulosVisibles(), que es LA MISMA función que arma el menú
// lateral y la misma regla que aplica exigirNivel para dejar pasar un pedido.
// Escribir acá una consulta propia sería la tercera copia de la regla, y ya pasó
// dos veces en este repo: la pantalla de permisos guardaba bien y el menú seguía
// mostrando lo de antes.
//
// Y SE VALIDA EN EL POST, no sólo al llenar el selector: un <select> del navegador
// se edita en diez segundos. Lo que decide es el servidor.
//
// ── QUIÉN VE QUÉ ──────────────────────────────────────────────────────────
// Cada uno ve LO SUYO —«para que vean en qué estado están sus pedidos»— y el
// administrador ve todo. Un buzón donde cualquiera lee lo que pidió el resto
// deja de recibir las quejas que importan.
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../servicios/db_mejoras.js';   // este import crea la tabla
import { modulosVisibles, nivelEnModulo } from '../servicios/permisos.js';

const router = express.Router();

// ── La foto ───────────────────────────────────────────────────────────────
// Mismo patrón que las fotos de la recepción: el archivo va a data/sg/ —que
// index.js ya sirve estática— y en la base queda la ruta más el nombre original.
// Con otra carpeta el archivo se guarda igual y la foto no se ve nunca.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '../../data/sg');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// ── Y SÓLO IMÁGENES ───────────────────────────────────────────────────────
//
// La carpeta data/sg la sirve express.static ANTES del portón de sesión, así que
// todo lo que entre por acá queda en una URL del MISMO ORIGEN que el panel y
// alcanzable sin cookie. Sin lista blanca, un archivo llamado «foto.html» con un
// <script> adentro se guarda igual, y el administrador —que es el que revisa el
// buzón— lo abre con un clic y ese script corre con su sesión.
//
// El accept="image/*" del formulario NO alcanza: es una sugerencia del selector
// de archivos del navegador y no existe para un pedido armado a mano.
//
// Y esta puerta es la MÁS abierta del sistema: proponer una mejora lo puede hacer
// cualquiera, hasta un usuario de sólo lectura.
const EXT_IMAGEN = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'];
const extDe = (f) => (path.extname((f && f.originalname) || '') || '').toLowerCase();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // La extensión sale de la lista blanca, no del nombre que mandaron: así el
    // archivo escrito nunca puede terminar en .html ni en .svg.
    const ext = EXT_IMAGEN.includes(extDe(file)) ? extDe(file) : '.jpg';
    cb(null, 'mejora_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + ext);
  },
});
const subir = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = EXT_IMAGEN.includes(extDe(file))
      && /^image\//.test(String(file.mimetype || ''));
    if (ok) return cb(null, true);
    const err = new Error('Se puede adjuntar una foto (jpg, png, webp, gif o heic), nada más.');
    err.code = 'TIPO_NO_PERMITIDO';
    cb(err);
  },
});

// Sin envolver a multer, pasarse de 10 MB devuelve un HTML 500 y el panel se
// come un error de JSON en vez de decir qué pasó.
function conFoto(req, res, next) {
  subir.single('foto')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'TIPO_NO_PERMITIDO') {
      return res.status(400).json({ ok: false, error: err.message });
    }
    const grande = err.code === 'LIMIT_FILE_SIZE';
    return res.status(400).json({
      ok: false,
      error: grande ? 'La foto no puede pesar más de 10 MB.' : ('No se pudo subir la foto: ' + err.message),
    });
  });
}

// ── Auth (copia local: auth.js no exporta requireAuth) ────────────────────
router.use((req, res, next) => {
  try {
    const c = req.cookies?.lnb_user;
    if (c) req.user = JSON.parse(c);
  } catch (_) { /* cookie corrupta: se trata como no autenticado */ }
  next();
});
function requireAuth(req, res, next) {
  if (!req.user || !req.user.id) return res.status(401).json({ ok: false, error: 'No autenticado' });
  next();
}
function soloAdmin(req, res, next) {
  if (req.user?.rol !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Priorizar y marcar resuelto es de administradores' });
  }
  next();
}
router.use(requireAuth);

const esAdmin = (req) => req.user?.rol === 'admin';

// multer escribe el archivo ANTES de que corra el handler: si después la
// propuesta se rechaza, el archivo queda en el volumen sin ninguna fila que lo
// nombre y sin nadie que lo borre nunca.
function rechazar(req, res, codigo, error) {
  if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) { /* ya no está */ } }
  return res.status(codigo).json({ ok: false, error });
}

// index.js no tiene manejador de errores global: un throw suelto contesta HTML y
// el panel revienta al hacer r.json().
const wrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
};

// ══ GET /api/mejoras/modulos — sobre qué puedo proponer ════════════════════
router.get('/modulos', wrap((req, res) => {
  const mods = modulosVisibles(req.user).map((m) => ({
    modulo: m.modulo, label: m.label, grupo: m.grupo || 'General',
  }));
  res.json({ ok: true, data: mods });
}));

// ══ GET /api/mejoras — lo mío, o todo si soy administrador ════════════════
router.get('/', wrap((req, res) => {
  const cond = [];
  const params = [];
  if (!esAdmin(req)) { cond.push('m.usuario_id = ?'); params.push(req.user.id); }
  if (req.query.estado === 'propuesta' || req.query.estado === 'resuelta') {
    cond.push('m.estado = ?'); params.push(req.query.estado);
  }
  const where = cond.length ? ('WHERE ' + cond.join(' AND ')) : '';
  const rows = db.prepare(`
    SELECT m.*, c.label AS modulo_actual
    FROM mejoras m
    LEFT JOIN modulos_config c ON c.modulo = m.modulo
    ${where}
    -- LO QUE FALTA HACER ARRIBA, Y ADENTRO DE ESO LO MÁS URGENTE. Las que
    -- todavía no tienen prioridad van al fondo de las pendientes y no al final
    -- de todo: son las que nadie miró, y son justamente las que hay que mirar.
    ORDER BY (m.estado = 'resuelta') ASC,
             (m.prioridad IS NULL) ASC,
             m.prioridad ASC,
             m.id DESC
  `).all(...params);
  res.json({ ok: true, data: rows, soy_admin: esAdmin(req) ? 1 : 0 });
}));

// ══ POST /api/mejoras — proponer ══════════════════════════════════════════
router.post('/', conFoto, wrap((req, res) => {
  const modulo = String(req.body?.modulo || '').trim();
  const texto = String(req.body?.texto || '').trim();
  if (!modulo) return rechazar(req, res, 400, 'Elegí sobre qué pantalla es');
  if (!texto) return rechazar(req, res, 400, 'Contá qué habría que mejorar');
  if (texto.length > 2000) {
    return rechazar(req, res, 400, 'El texto no puede pasar de 2.000 caracteres');
  }

  // SOBRE LO QUE NO USA, NO PROPONE. Un <select> se edita; esto no.
  // El administrador ve todo, así que modulosVisibles ya se lo permite entero.
  const mod = db.prepare('SELECT modulo, label FROM modulos_config WHERE modulo = ? AND oculto = 0').get(modulo);
  if (!mod) return rechazar(req, res, 400, 'Esa pantalla no existe');
  if (!esAdmin(req) && !nivelEnModulo(req.user, modulo)) {
    return rechazar(req, res, 403, 'Sólo se pueden proponer mejoras sobre las pantallas que usás.');
  }

  const info = db.prepare(`INSERT INTO mejoras
      (modulo, modulo_label, texto, foto_ruta, foto_nombre, usuario_id, usuario_nombre)
    VALUES (?,?,?,?,?,?,?)`).run(
    modulo, mod.label || null, texto,
    req.file ? ('/data/sg/' + req.file.filename) : null,
    req.file ? (req.file.originalname || null) : null,
    req.user.id, req.user.nombre || null);
  res.json({ ok: true, data: { id: info.lastInsertRowid } });
}));

// ══ PATCH /api/mejoras/:id/prioridad — del 1 al 5 (administrador) ═════════
router.patch('/:id/prioridad', soloAdmin, wrap((req, res) => {
  const fila = db.prepare('SELECT id FROM mejoras WHERE id = ?').get(req.params.id);
  if (!fila) return res.status(404).json({ ok: false, error: 'No existe esa mejora' });

  const crudo = req.body?.prioridad;
  // Vacío es un valor válido: vuelve a "sin prioridad", que es el estado de lo
  // que nadie miró todavía.
  if (crudo === null || crudo === undefined || crudo === '') {
    db.prepare('UPDATE mejoras SET prioridad = NULL WHERE id = ?').run(req.params.id);
    return res.json({ ok: true, data: { id: Number(req.params.id), prioridad: null } });
  }
  const p = Number(crudo);
  if (!Number.isInteger(p) || p < 1 || p > 5) {
    return res.status(400).json({ ok: false, error: 'La prioridad va del 1 al 5' });
  }
  db.prepare('UPDATE mejoras SET prioridad = ? WHERE id = ?').run(p, req.params.id);
  res.json({ ok: true, data: { id: Number(req.params.id), prioridad: p } });
}));

// ══ POST /api/mejoras/:id/resolver — y su vuelta atrás (administrador) ════
//
// La nota no es adorno: "resuelto" sin decir cómo deja al que lo pidió mirando
// una pantalla igual a la de ayer, sin saber si se hizo otra cosa o si se
// entendió mal el pedido.
router.post('/:id/resolver', soloAdmin, wrap((req, res) => {
  const fila = db.prepare('SELECT id, estado FROM mejoras WHERE id = ?').get(req.params.id);
  if (!fila) return res.status(404).json({ ok: false, error: 'No existe esa mejora' });
  // EL ESTADO SE COMPRUEBA EN EL MISMO UPDATE. Mirar antes y escribir después son
  // dos momentos: con dos administradores en la pantalla al mismo tiempo, el
  // segundo pisaba la nota del primero y quedaba figurando él como quien la
  // resolvió.
  const r = db.prepare(`UPDATE mejoras
      SET estado = 'resuelta', resuelta_en = datetime('now','localtime'),
          resuelta_por = ?, resuelta_nota = ?
    WHERE id = ? AND estado <> 'resuelta'`)
    .run(req.user.id, String(req.body?.nota || '').trim() || null, req.params.id);
  if (!r.changes) {
    return res.status(400).json({ ok: false, error: 'Esa mejora ya estaba marcada como resuelta' });
  }
  res.json({ ok: true, data: { id: Number(req.params.id), estado: 'resuelta' } });
}));

router.post('/:id/reabrir', soloAdmin, wrap((req, res) => {
  const fila = db.prepare('SELECT id FROM mejoras WHERE id = ?').get(req.params.id);
  if (!fila) return res.status(404).json({ ok: false, error: 'No existe esa mejora' });
  // Se borra el rastro de la resolución anterior: dejarlo haría que la pantalla
  // mostrara "resuelta el 2/9" en algo que está abierto. Y el estado se comprueba
  // en el mismo UPDATE, como al resolver.
  const r = db.prepare(`UPDATE mejoras
      SET estado = 'propuesta', resuelta_en = NULL, resuelta_por = NULL, resuelta_nota = NULL
    WHERE id = ? AND estado = 'resuelta'`).run(req.params.id);
  if (!r.changes) return res.status(400).json({ ok: false, error: 'Esa mejora no estaba resuelta' });
  res.json({ ok: true, data: { id: Number(req.params.id), estado: 'propuesta' } });
}));

// ══ DELETE /api/mejoras/:id — borrar la propia, mientras nadie la tocó ════
//
// Se manda una con la pantalla equivocada y hoy queda ahí para siempre,
// ensuciando la lista del administrador. Sólo el que la escribió, y sólo
// mientras siga pendiente: una vez que alguien le puso prioridad o la resolvió,
// ya es parte de una conversación y borrarla sería borrarle el trabajo a otro.
router.delete('/:id', wrap((req, res) => {
  const fila = db.prepare('SELECT * FROM mejoras WHERE id = ?').get(req.params.id);
  if (!fila) return res.status(404).json({ ok: false, error: 'No existe esa mejora' });
  if (Number(fila.usuario_id) !== Number(req.user.id)) {
    return res.status(403).json({ ok: false, error: 'Sólo podés borrar las que propusiste vos' });
  }
  if (fila.estado === 'resuelta' || fila.prioridad != null) {
    return res.status(400).json({
      ok: false,
      error: 'Ya la miró un administrador: no se puede borrar. Escribí otra aclarando.',
    });
  }
  db.prepare('DELETE FROM mejoras WHERE id = ?').run(fila.id);
  // Y la foto se va con ella: si no, queda en el volumen para siempre.
  if (fila.foto_ruta) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(fila.foto_ruta))); } catch (_) { /* ya no está */ }
  }
  res.json({ ok: true, data: { id: fila.id } });
}));

export default router;
