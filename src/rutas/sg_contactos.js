// src/rutas/sg_contactos.js
// ── CONTACTOS COMERCIALES DE SAN GERÓNIMO ────────────────────────────────────────────
// La agenda del área. Montado en /api/sg/contactos, ANTES del sgRouter genérico (que
// matchea /api/sg/*) — igual que contable, ventas y tesorería.
//
// ── DOS NIVELES ─────────────────────────────────────────────────────────────────────
// Las direcciones vienen en dos familias, y la diferencia no es de forma:
//
//   /api/sg/contactos           → PERSONAS. A quién se llama: cargo, teléfonos, charlas.
//   /api/sg/contactos/empresas  → CUENTAS. Qué produce, en qué meses, el vínculo con la
//                                 planilla, la zona, quién la atiende.
//
// Los productos cuelgan de la EMPRESA (POST /empresas/:id/productos), no de la persona.
// Pablo, 9/10/2026: la empresa es la que tiene la venta de producción de cada producto. La
// razón larga está en db_sg_contactos.js: cargando al dueño y al encargado de la misma
// finca, el calendario de melón quedaba cargado dos veces y a la semana estaban distintos.
//
// Y LAS RUTAS DE /empresas VAN ANTES DE /:id. Express resuelve por orden: con /:id primero,
// un GET a /empresas entra ahí con id="empresas" y contesta «no existe ese contacto». El
// archivo compila igual y el error aparece recién cuando alguien abre la pantalla.
//
// La lógica de verdad vive en servicios/contactos.js, que recibe la db por parámetro y
// por eso tiene tests que corren sin better-sqlite3. Acá queda lo que es de HTTP: quién
// puede, qué empresa, y traducir el cuerpo del pedido a esas funciones.
//
// ── LOS MESES VAN DE JULIO A JUNIO ───────────────────────────────────────────────────
// La máscara `meses` tiene doce posiciones y la PRIMERA ES JULIO, como todo el año
// comercial de la casa. Está dicho acá además de en db_sg_contactos.js a propósito: el
// que escriba un cliente de esta API no va a leer el archivo de la base.
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../servicios/db_sg_contactos.js';
import { exigirEmpresa, SAN_GERONIMO } from '../servicios/sociedad_modulo.js';
import {
  buscar, ficha, pendientes, opciones, mascaraValida,
  buscarEmpresas, fichaEmpresa, charlasDeEmpresa, empresaPorNombre,
  observadoProveedor, observadoCliente, ofreceYNoLeCompramos,
  TIPOS, CANALES, MESES,
} from '../servicios/contactos.js';

const router = express.Router();

// ══ LA FOTO DE LA TARJETA ════════════════════════════════════════════════════════════
// Una foto y nada más: ni lector, ni OCR, ni IA. La tarjeta que te dieron en la mano,
// guardada donde se la puede volver a mirar. Lo que se tipea igual son el teléfono y el
// mail — una foto no se busca, y el buscador es la mitad de este módulo.
//
// ── POR QUÉ ESTA CARPETA Y NO data/sg ───────────────────────────────────────────────
// Las otras fotos del sistema van a data/sg, data/ifco, data/uploads — y esas carpetas
// las sirve express.static ANTES del portón de sesión (index.js:110-115). Lo que entra
// ahí queda en una URL del mismo origen que el panel y alcanzable SIN COOKIE.
//
// Para una foto de un cajón eso da igual. Acá no: la foto de una tarjeta ES el teléfono
// directo y el mail de un comprador de cadena o de un productor, que es exactamente lo
// que este router ya decidió no dejar al alcance de cualquiera (ver requireAuth abajo).
// Dejarla en una carpeta pública sería sacar por la ventana lo que la puerta cuida.
//
// Por eso data/contactos/ NO está en ningún express.static, y la foto sale sólo por
// GET /:id/tarjeta, que pasa por el requireAuth de este router.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARJETAS_DIR = path.join(__dirname, '../../data/contactos');
fs.mkdirSync(TARJETAS_DIR, { recursive: true });

// Lista blanca de extensiones, no del nombre que mandaron. El accept="image/*" del
// formulario es una sugerencia del selector de archivos y no existe para un pedido armado
// a mano; sin esto, un «tarjeta.html» con un <script> adentro se guarda igual.
//
// Acá además el archivo nunca se sirve como HTML —el GET manda su Content-Type desde la
// extensión y un Content-Disposition— pero la lista va igual: es más barato no escribir
// el archivo peligroso que acordarse de servirlo bien en todos lados.
const EXT_IMAGEN = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
const TIPO_DE_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
};
const extDe = (f) => (path.extname((f && f.originalname) || '') || '').toLowerCase();

const subirTarjeta = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TARJETAS_DIR),
    filename: (req, file, cb) => {
      const ext = EXT_IMAGEN.includes(extDe(file)) ? extDe(file) : '.jpg';
      cb(null, 'tarjeta_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + ext);
    },
  }),
  // 12 MB: una foto de celular moderno sin comprimir pasa los 8 con facilidad, y el que
  // saca la foto en una reunión no la va a achicar antes de subirla.
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (EXT_IMAGEN.includes(extDe(file)) && /^image\//.test(String(file.mimetype || ''))) {
      return cb(null, true);
    }
    const err = new Error('La tarjeta se guarda como foto: jpg, png, webp o heic.');
    err.code = 'TIPO_NO_PERMITIDO';
    cb(err);
  },
});

// Sin envolver a multer, pasarse del tamaño devuelve un HTML 500 y la pantalla se come un
// error de JSON en vez de decir qué pasó.
function conTarjeta(req, res, next) {
  subirTarjeta.single('tarjeta')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'TIPO_NO_PERMITIDO') {
      return res.status(400).json({ ok: false, error: err.message });
    }
    return res.status(400).json({
      ok: false,
      error: err.code === 'LIMIT_FILE_SIZE'
        ? 'La foto pesa más de 12 MB. Sacala de nuevo con menos calidad, o recortala.'
        : 'No se pudo subir la foto: ' + err.message,
    });
  });
}

// Borrar el archivo viejo al reemplazarlo. Si falla no pasa nada grave —queda un archivo
// huérfano— así que no corta la operación: lo que importa es que la foto nueva entre.
function borrarArchivo(nombre) {
  if (!nombre) return;
  try { fs.unlinkSync(path.join(TARJETAS_DIR, path.basename(nombre))); }
  catch (e) { if (e.code !== 'ENOENT') console.error('[CONTACTOS] no pude borrar la tarjeta:', e.message); }
}

// Parado en otra sociedad no se toca la agenda de San Gerónimo, ni siquiera teniendo
// permiso para entrar a San Gerónimo: hay que cambiar el selector y operar desde ahí.
router.use((req, res, next) => {
  if (exigirEmpresa(req, res, SAN_GERONIMO) === null) return;   // ya contestó 403
  next();
});

function getUser(req) {
  try { return req.cookies?.lnb_user ? JSON.parse(req.cookies.lnb_user) : null; }
  catch (e) { return null; }
}

// TODO este router pide sesión, incluidas las lecturas. Una agenda con los teléfonos
// directos de los compradores de las cadenas y de los productores es exactamente la lista
// que no se deja al alcance de cualquiera que tenga un usuario. El nivel Ver/Operar/Anular
// lo decide exigirNivel mirando la URL contra ensure_api_prefijos.js, donde este prefijo
// está declarado.
function requireAuth(req, res, next) {
  const u = getUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'no autenticado' });
  req._user = u;
  next();
}
router.use(requireAuth);

const txt = (v) => { const s = (v == null ? '' : String(v)).trim(); return s === '' ? null : s; };
const hoy = () => new Date().toISOString().slice(0, 10);

// ── EL BUSCADOR ───────────────────────────────────────────────────────────────────────
// GET /api/sg/contactos?q=brocoli&tipo=proveedor&zona=&vendedor=&producto=&mes=5
router.get('/', (req, res) => {
  try {
    const r = buscar(db, {
      q: req.query.q,
      tipo: req.query.tipo,
      zona: req.query.zona,
      vendedor: req.query.vendedor,
      producto: req.query.producto,
      mes: req.query.mes,
      empresa_id: req.query.empresa_id,
      etiqueta: req.query.etiqueta,
      incluir_inactivos: req.query.inactivos === '1',
      limite: req.query.limite,
    });
    res.json({ ok: true, contactos: r, total: r.length });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Los desplegables salen de lo cargado, no de una lista inventada: una zona que nadie usó
// nunca no tiene por qué estar ocupando lugar en el filtro.
router.get('/opciones', (req, res) => {
  try {
    res.json({ ok: true, ...opciones(db), tipos: TIPOS, canales: CANALES, meses_orden: MESES });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── LA BANDEJA DE "ME TOCA" ───────────────────────────────────────────────────────────
// Lo que convierte la agenda en una herramienta y no en un cuaderno: qué quedó pendiente
// y vence. Va antes de /:id para que 'pendientes' no se lea como un id.
router.get('/pendientes', (req, res) => {
  try {
    res.json({ ok: true, pendientes: pendientes(db, req.query.hasta || hoy()) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── LA EMPRESA: LA CUENTA COMERCIAL ───────────────────────────────────────────────────
// De acá cuelgan los productos y el vínculo con la planilla. Ver db_sg_contactos.js: la
// finca produce melón una sola vez, y el que lo cuenta por teléfono puede ser cualquiera.
const CAMPOS_EMP = ['nombre', 'tipo', 'zona', 'localidad',
                    'cliente_nombre', 'proveedor_nombre', 'vendedor', 'etiquetas', 'notas'];

// Encuentra la empresa por nombre o la crea. Es lo que hace que cargar a la segunda persona
// de Giglio caiga en la finca que ya existe sin que el comercial tenga que saber que existe.
function empresaDeNombre(nombre, datos, usuarioId) {
  const n = txt(nombre);
  if (!n) return null;
  const ya = empresaPorNombre(db, n);
  if (ya) return ya;
  const d = datos || {};
  const r = db.prepare('INSERT INTO sg_contacto_empresas'
    + ' (nombre, tipo, zona, localidad, cliente_nombre, proveedor_nombre, vendedor,'
    + '  etiquetas, notas, creado_por_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    n, TIPOS.includes(d.tipo) ? d.tipo : 'otro', txt(d.zona), txt(d.localidad),
    txt(d.cliente_nombre), txt(d.proveedor_nombre), txt(d.vendedor),
    txt(d.etiquetas), txt(d.notas), usuarioId || null);
  return db.prepare('SELECT * FROM sg_contacto_empresas WHERE id = ?').get(Number(r.lastInsertRowid));
}

router.get('/empresas', (req, res) => {
  try {
    const r = buscarEmpresas(db, {
      q: req.query.q, tipo: req.query.tipo, zona: req.query.zona,
      vendedor: req.query.vendedor, producto: req.query.producto, mes: req.query.mes,
      incluir_inactivos: req.query.inactivos === '1', limite: req.query.limite,
    });
    res.json({ ok: true, empresas: r, total: r.length });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// La ficha de la cuenta: qué produce, quiénes son sus personas, y TODO lo que se habló con
// cualquiera de ellas. El historial de una cuenta es uno solo aunque las personas sean tres.
router.get('/empresas/:id', (req, res) => {
  try {
    const e = fichaEmpresa(db, req.params.id);
    if (!e) return res.status(404).json({ ok: false, error: 'no existe esa empresa' });
    e.charlas = charlasDeEmpresa(db, e.id);
    e.pendientes = e.charlas.filter((c) => c.proximo_paso && !c.hecho_en);
    if (e.proveedor_nombre) {
      e.compras = observadoProveedor(db, e.proveedor_nombre);
      e.ofrece_sin_comprar = ofreceYNoLeCompramos(e.productos, e.compras);
    }
    if (e.cliente_nombre) e.ventas = observadoCliente(db, e.cliente_nombre);
    res.json({ ok: true, empresa: e });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post('/empresas', (req, res) => {
  try {
    const b = req.body || {};
    const nombre = txt(b.nombre);
    if (!nombre) return res.status(400).json({ ok: false, error: 'falta el nombre de la empresa' });
    // Dos fichas de la misma finca son dos historiales con la mitad de las charlas cada
    // uno, que es justo lo que este módulo viene a evitar. Se devuelve la que ya hay.
    const ya = empresaPorNombre(db, nombre);
    if (ya) {
      return res.status(409).json({ ok: false, error: 'ya existe «' + ya.nombre + '»',
                                    empresa_id: ya.id });
    }
    const e = empresaDeNombre(nombre, b, req._user.id);
    guardarProductos(e.id, b.productos);
    res.json({ ok: true, id: e.id, empresa: fichaEmpresa(db, e.id) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.patch('/empresas/:id', (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], par = [];
    for (const c of CAMPOS_EMP) {
      if (!(c in b)) continue;
      if (c === 'nombre') {
        const n = txt(b.nombre);
        if (!n) return res.status(400).json({ ok: false, error: 'el nombre no puede quedar vacío' });
        const otra = empresaPorNombre(db, n);
        if (otra && String(otra.id) !== String(req.params.id)) {
          return res.status(409).json({ ok: false, error: 'ya hay otra empresa llamada «' + otra.nombre + '»' });
        }
        sets.push('nombre = ?'); par.push(n); continue;
      }
      if (c === 'tipo') {
        if (!TIPOS.includes(b.tipo)) return res.status(400).json({ ok: false, error: 'tipo inválido' });
        sets.push('tipo = ?'); par.push(b.tipo); continue;
      }
      sets.push(c + ' = ?'); par.push(txt(b[c]));
    }
    if ('activo' in b) { sets.push('activo = ?'); par.push(b.activo ? 1 : 0); }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nada que cambiar' });

    sets.push("actualizado_en = datetime('now','localtime')");
    par.push(req.params.id);
    const r = db.prepare('UPDATE sg_contacto_empresas SET ' + sets.join(', ')
      + ' WHERE id = ? AND eliminado_en IS NULL').run(...par);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe esa empresa' });

    // El nombre de la empresa está DENORMALIZADO en cada persona (para que el buscador
    // mire una sola tabla). Si se renombra la finca y no se reescribe ahí, la lista sigue
    // mostrando el nombre viejo y nadie entiende por qué.
    if ('nombre' in b) {
      db.prepare('UPDATE sg_contactos SET empresa = ? WHERE empresa_id = ?')
        .run(txt(b.nombre), req.params.id);
    }
    res.json({ ok: true, empresa: fichaEmpresa(db, req.params.id) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Baja blanda de la cuenta. Se lleva a su gente de la lista del día —si la finca dejó de
// trabajar con nosotros, el encargado no tiene por qué seguir apareciendo— pero NO borra
// nada: las personas, sus teléfonos y los años de charlas quedan.
router.post('/empresas/:id/eliminar', (req, res) => {
  try {
    const r = db.prepare("UPDATE sg_contacto_empresas SET eliminado_en = datetime('now','localtime')"
      + ' WHERE id = ? AND eliminado_en IS NULL').run(req.params.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe esa empresa' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── QUÉ PRODUCE, Y CUÁNDO — DE LA EMPRESA ─────────────────────────────────────────────
function guardarProductos(empresaId, productos) {
  if (!Array.isArray(productos) || !empresaId) return;
  const ins = db.prepare('INSERT INTO sg_contacto_productos'
    + ' (empresa_id,producto,variedad,meses,volumen,notas) VALUES (?,?,?,?,?,?)');
  for (const p of productos) {
    const prod = txt(p && p.producto);
    if (!prod) continue;
    const meses = mascaraValida(p.meses) ? p.meses : '000000000000';
    ins.run(empresaId, prod.toUpperCase(), txt(p.variedad), meses, txt(p.volumen), txt(p.notas));
  }
}

router.post('/empresas/:id/productos', (req, res) => {
  try {
    const b = req.body || {};
    const prod = txt(b.producto);
    if (!prod) return res.status(400).json({ ok: false, error: 'falta el producto' });
    // Una máscara rota se rechaza en vez de guardarse como está: guardada, la ficha
    // dibujaría una ventana cualquiera y nadie sabría que es basura.
    if (b.meses != null && !mascaraValida(b.meses)) {
      return res.status(400).json({ ok: false, error: 'los meses tienen que ser 12 ceros y unos, el primero es JULIO' });
    }
    const e = db.prepare('SELECT id FROM sg_contacto_empresas WHERE id = ? AND eliminado_en IS NULL').get(req.params.id);
    if (!e) return res.status(404).json({ ok: false, error: 'no existe esa empresa' });
    // El mismo producto dos veces en la misma finca son dos ventanas que se contradicen y
    // ninguna pantalla puede decir cuál vale. Se avisa en vez de duplicar.
    const ya = db.prepare('SELECT id FROM sg_contacto_productos WHERE empresa_id = ? AND upper(producto) = ?')
      .get(req.params.id, prod.toUpperCase());
    if (ya) {
      return res.status(409).json({ ok: false, producto_id: ya.id,
        error: 'esta empresa ya tiene ' + prod.toUpperCase() + ' cargado: corregí esa ventana en vez de agregar otra' });
    }
    const r = db.prepare('INSERT INTO sg_contacto_productos'
      + ' (empresa_id,producto,variedad,meses,volumen,notas) VALUES (?,?,?,?,?,?)')
      .run(req.params.id, prod.toUpperCase(), txt(b.variedad),
           b.meses || '000000000000', txt(b.volumen), txt(b.notas));
    res.json({ ok: true, id: Number(r.lastInsertRowid), productos: fichaEmpresa(db, req.params.id).productos });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.patch('/empresas/:id/productos/:pid', (req, res) => {
  try {
    const b = req.body || {};
    if (b.meses != null && !mascaraValida(b.meses)) {
      return res.status(400).json({ ok: false, error: 'los meses tienen que ser 12 ceros y unos, el primero es JULIO' });
    }
    const sets = [], par = [];
    for (const c of ['producto', 'variedad', 'meses', 'volumen', 'notas']) {
      if (!(c in b)) continue;
      sets.push(c + ' = ?');
      par.push(c === 'producto' ? (txt(b.producto) || '').toUpperCase() : (c === 'meses' ? b.meses : txt(b[c])));
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nada que cambiar' });
    par.push(req.params.pid, req.params.id);
    const r = db.prepare('UPDATE sg_contacto_productos SET ' + sets.join(', ')
      + ' WHERE id = ? AND empresa_id = ?').run(...par);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe ese producto' });
    res.json({ ok: true, productos: fichaEmpresa(db, req.params.id).productos });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.delete('/empresas/:id/productos/:pid', (req, res) => {
  try {
    const r = db.prepare('DELETE FROM sg_contacto_productos WHERE id = ? AND empresa_id = ?')
      .run(req.params.pid, req.params.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe ese producto' });
    res.json({ ok: true, productos: fichaEmpresa(db, req.params.id).productos });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── LA FICHA DE UNA PERSONA ───────────────────────────────────────────────────────────
// Trae lo de la persona (cargo, teléfonos, sus charlas), lo de su EMPRESA (lo que produce,
// el vínculo con la planilla, quiénes más trabajan ahí) y, al lado de lo declarado, lo
// OBSERVADO: lo que dicen las ventas.
//
// Separado a propósito, en los dos ejes. Declarado vs observado, porque la diferencia
// —ofrece brócoli y nunca le compramos brócoli— es justamente la oportunidad. Y persona vs
// empresa, porque el melón es de la finca: si se aplanaran, el que corrige la ventana desde
// la ficha de Juan creería que la corrigió para Juan solo.
router.get('/:id', (req, res) => {
  try {
    const f = ficha(db, req.params.id);
    if (!f) return res.status(404).json({ ok: false, error: 'no existe ese contacto' });

    // Los vínculos con la planilla son DE LA EMPRESA: es la finca la que factura.
    const e = f.empresa;
    if (e && e.proveedor_nombre) {
      f.compras = observadoProveedor(db, e.proveedor_nombre);
      f.ofrece_sin_comprar = ofreceYNoLeCompramos(f.productos, f.compras);
    }
    if (e && e.cliente_nombre) f.ventas = observadoCliente(db, e.cliente_nombre);
    res.json({ ok: true, contacto: f });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── ALTA Y EDICIÓN DE UNA PERSONA ─────────────────────────────────────────────────────
// De la persona son su nombre, su cargo y sus notas. El resto —tipo, zona, vínculos con la
// planilla, quién la atiende— es de la EMPRESA, y se toca en la ficha de la empresa.
const CAMPOS = ['nombre', 'cargo', 'notas'];

router.post('/', (req, res) => {
  try {
    const b = req.body || {};
    const nombre = txt(b.nombre);
    if (!nombre) return res.status(400).json({ ok: false, error: 'falta el nombre' });

    // TODA PERSONA TIENE UNA EMPRESA, Y SI TRABAJA SOLA LA EMPRESA ES ELLA.
    // Se puede mandar el id de una que ya existe, o el nombre —y entonces cae en la que ya
    // hay o se crea—. Sin nada, la empresa es la persona: un fletero que trabaja solo es
    // una cuenta comercial de una persona, y eso es lo que de verdad es. La alternativa era
    // un empresa_id nulo y los mismos campos duplicados en las dos tablas.
    let emp = null;
    if (b.empresa_id) {
      emp = db.prepare('SELECT * FROM sg_contacto_empresas WHERE id = ? AND eliminado_en IS NULL')
        .get(b.empresa_id);
      if (!emp) return res.status(400).json({ ok: false, error: 'esa empresa no existe' });
    } else {
      emp = empresaDeNombre(txt(b.empresa) || nombre, b, req._user.id);
    }

    const r = db.prepare('INSERT INTO sg_contactos'
      + ' (nombre, empresa_id, empresa, cargo, notas, creado_por_id) VALUES (?,?,?,?,?,?)').run(
      nombre, emp.id, emp.nombre, txt(b.cargo), txt(b.notas), req._user.id || null);
    const id = Number(r.lastInsertRowid);

    // Los medios pueden venir en el mismo alta: cargar un contacto y después su teléfono en
    // dos pantallas distintas es la forma de que el teléfono no se cargue nunca.
    guardarMedios(id, b.medios);
    // Y los productos van a la EMPRESA, no a la persona.
    guardarProductos(emp.id, b.productos);
    res.json({ ok: true, id, empresa_id: emp.id, contacto: ficha(db, id) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.patch('/:id', (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], par = [];
    for (const c of CAMPOS) {
      if (!(c in b)) continue;
      if (c === 'nombre') {
        const n = txt(b.nombre);
        if (!n) return res.status(400).json({ ok: false, error: 'el nombre no puede quedar vacío' });
        sets.push('nombre = ?'); par.push(n); continue;
      }
      sets.push(c + ' = ?'); par.push(txt(b[c]));
    }
    // PASAR UNA PERSONA DE UNA EMPRESA A OTRA. Es lo que pasa cuando el comprador de una
    // cadena se va a la competencia: la persona es la misma y su historial de charlas se va
    // con ella, pero la cuenta es otra.
    //
    // Se puede mandar el `empresa_id`, o el NOMBRE en `empresa` — y entonces cae en la que
    // ya hay, o se crea. Es la misma regla que el alta, y a propósito: con sólo el id, la
    // ficha tendría que resolver el nombre a un id por su cuenta antes de guardar, y eso
    // son dos maneras distintas de hacer lo mismo según desde dónde se lo haga.
    if ('empresa_id' in b || 'empresa' in b) {
      let emp = null;
      if (b.empresa_id) {
        emp = db.prepare('SELECT * FROM sg_contacto_empresas WHERE id = ? AND eliminado_en IS NULL')
          .get(b.empresa_id);
        if (!emp) return res.status(400).json({ ok: false, error: 'esa empresa no existe' });
      } else {
        const n = txt(b.empresa);
        if (!n) return res.status(400).json({ ok: false, error: 'la empresa no puede quedar vacía' });
        emp = empresaDeNombre(n, {}, req._user.id);
      }
      sets.push('empresa_id = ?'); par.push(emp.id);
      sets.push('empresa = ?');    par.push(emp.nombre);
    }
    if ('activo' in b) { sets.push('activo = ?'); par.push(b.activo ? 1 : 0); }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nada que cambiar' });

    sets.push("actualizado_en = datetime('now','localtime')");
    par.push(req.params.id);
    const r = db.prepare('UPDATE sg_contactos SET ' + sets.join(', ')
      + ' WHERE id = ? AND eliminado_en IS NULL').run(...par);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe ese contacto' });
    res.json({ ok: true, contacto: ficha(db, req.params.id) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Baja blanda, y por dirección propia: lo que se pierde al borrar un contacto no es la
// ficha, son las charlas: el historial de lo que se habló con esa persona durante años.
router.post('/:id/eliminar', (req, res) => {
  try {
    const r = db.prepare("UPDATE sg_contactos SET eliminado_en = datetime('now','localtime')"
      + ' WHERE id = ? AND eliminado_en IS NULL').run(req.params.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe ese contacto' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── CÓMO SE LO UBICA ──────────────────────────────────────────────────────────────────
function guardarMedios(id, medios) {
  if (!Array.isArray(medios)) return;
  const ins = db.prepare(`INSERT INTO sg_contacto_medios (contacto_id,tipo,valor,nota,preferido)
                          VALUES (?,?,?,?,?)`);
  for (const m of medios) {
    const valor = txt(m && m.valor);
    if (!valor) continue;
    ins.run(id, txt(m.tipo) || 'telefono', valor, txt(m.nota), m.preferido ? 1 : 0);
  }
}

router.post('/:id/medios', (req, res) => {
  try {
    const b = req.body || {};
    const valor = txt(b.valor);
    if (!valor) return res.status(400).json({ ok: false, error: 'falta el teléfono o el mail' });
    // Uno solo preferido: si no, la lista muestra cualquiera de los tres y el comercial
    // llama al del galpón cuando el que atiende es el celular.
    if (b.preferido) db.prepare('UPDATE sg_contacto_medios SET preferido = 0 WHERE contacto_id = ?').run(req.params.id);
    const r = db.prepare(`INSERT INTO sg_contacto_medios (contacto_id,tipo,valor,nota,preferido)
                          VALUES (?,?,?,?,?)`).run(
      req.params.id, txt(b.tipo) || 'telefono', valor, txt(b.nota), b.preferido ? 1 : 0);
    res.json({ ok: true, id: Number(r.lastInsertRowid), medios: ficha(db, req.params.id).medios });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post('/:id/medios/:mid/preferido', (req, res) => {
  try {
    db.prepare('UPDATE sg_contacto_medios SET preferido = 0 WHERE contacto_id = ?').run(req.params.id);
    const r = db.prepare('UPDATE sg_contacto_medios SET preferido = 1 WHERE id = ? AND contacto_id = ?')
      .run(req.params.mid, req.params.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe ese medio' });
    res.json({ ok: true, medios: ficha(db, req.params.id).medios });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.delete('/:id/medios/:mid', (req, res) => {
  try {
    const r = db.prepare('DELETE FROM sg_contacto_medios WHERE id = ? AND contacto_id = ?')
      .run(req.params.mid, req.params.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe ese medio' });
    res.json({ ok: true, medios: ficha(db, req.params.id).medios });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── QUÉ SE HABLÓ ──────────────────────────────────────────────────────────────────────
router.post('/:id/charlas', (req, res) => {
  try {
    const b = req.body || {};
    const resumen = txt(b.resumen);
    if (!resumen) return res.status(400).json({ ok: false, error: 'falta el resumen de la charla' });
    const existe = db.prepare('SELECT 1 FROM sg_contactos WHERE id = ? AND eliminado_en IS NULL').get(req.params.id);
    if (!existe) return res.status(404).json({ ok: false, error: 'no existe ese contacto' });

    // Queda quién la cargó. Una charla sin autor, seis meses después, no se puede ir a
    // preguntar: "¿a quién le dijo eso?" es la primera pregunta que genera una nota vieja.
    const r = db.prepare(`INSERT INTO sg_contacto_charlas
      (contacto_id,fecha,canal,resumen,proximo_paso,proximo_el,usuario_id,usuario)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      req.params.id, txt(b.fecha) || hoy(),
      CANALES.includes(b.canal) ? b.canal : 'telefono',
      resumen, txt(b.proximo_paso), txt(b.proximo_el),
      req._user.id || null, req._user.nombre || null);
    res.json({ ok: true, id: Number(r.lastInsertRowid), charlas: ficha(db, req.params.id).charlas });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.patch('/:id/charlas/:cid', (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], par = [];
    for (const c of ['fecha', 'canal', 'resumen', 'proximo_paso', 'proximo_el']) {
      if (!(c in b)) continue;
      sets.push(`${c} = ?`); par.push(txt(b[c]));
    }
    // Marcar hecho es lo que saca el pendiente de la bandeja. Se manda hecho:true/false,
    // no la fecha: la fecha la pone el servidor, que es el que sabe qué día es hoy.
    if ('hecho' in b) { sets.push('hecho_en = ?'); par.push(b.hecho ? hoy() : null); }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nada que cambiar' });
    par.push(req.params.cid, req.params.id);
    const r = db.prepare(`UPDATE sg_contacto_charlas SET ${sets.join(', ')}
                           WHERE id = ? AND contacto_id = ? AND eliminado_en IS NULL`).run(...par);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe esa charla' });
    res.json({ ok: true, charlas: ficha(db, req.params.id).charlas });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post('/:id/charlas/:cid/eliminar', (req, res) => {
  try {
    const r = db.prepare(`UPDATE sg_contacto_charlas SET eliminado_en = datetime('now','localtime')
                           WHERE id = ? AND contacto_id = ? AND eliminado_en IS NULL`)
      .run(req.params.cid, req.params.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe esa charla' });
    res.json({ ok: true, charlas: ficha(db, req.params.id).charlas });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ══ LA TARJETA DE UNA PERSONA ════════════════════════════════════════════════════════

// Subirla o reemplazarla. Una sola por persona: la tarjeta es una, y una galería obliga a
// elegir cuál mirar cada vez que se abre la ficha.
router.post('/:id/tarjeta', conTarjeta, (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'no llegó ninguna foto' });
    const c = db.prepare('SELECT tarjeta_path FROM sg_contactos WHERE id = ? AND eliminado_en IS NULL')
      .get(req.params.id);
    if (!c) {
      // La persona no existe, pero multer YA escribió el archivo: sin esto queda tirado
      // para siempre en el disco del servidor.
      borrarArchivo(req.file.filename);
      return res.status(404).json({ ok: false, error: 'no existe ese contacto' });
    }
    const anterior = c.tarjeta_path;
    db.prepare("UPDATE sg_contactos SET tarjeta_path = ?, tarjeta_nombre = ?,"
      + " tarjeta_en = datetime('now','localtime'),"
      + " actualizado_en = datetime('now','localtime') WHERE id = ?")
      .run(req.file.filename, req.file.originalname || null, req.params.id);
    // Recién DESPUÉS de que la nueva quedó guardada. Al revés, un error en el UPDATE deja
    // a la persona sin ninguna de las dos.
    if (anterior && anterior !== req.file.filename) borrarArchivo(anterior);
    res.json({ ok: true, contacto: ficha(db, req.params.id) });
  } catch (e) {
    if (req.file) borrarArchivo(req.file.filename);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Mirarla. Pasa por el requireAuth del router, que es el motivo de que el archivo no viva
// en una carpeta servida estática (ver el comentario de arriba).
router.get('/:id/tarjeta', (req, res) => {
  try {
    const c = db.prepare('SELECT tarjeta_path, tarjeta_nombre FROM sg_contactos'
      + ' WHERE id = ? AND eliminado_en IS NULL').get(req.params.id);
    if (!c || !c.tarjeta_path) return res.status(404).json({ ok: false, error: 'no tiene tarjeta cargada' });
    // basename(): la ruta sale de nuestra propia base, pero si alguna vez entrara un
    // '../../' por ahí, esto lo deja en la carpeta y no en el resto del disco.
    const f = path.join(TARJETAS_DIR, path.basename(c.tarjeta_path));
    if (!fs.existsSync(f)) {
      return res.status(404).json({ ok: false, error: 'la foto no está en el servidor' });
    }
    const ext = path.extname(f).toLowerCase();
    res.set({
      'Content-Type': TIPO_DE_EXT[ext] || 'application/octet-stream',
      // inline para poder verla en la ficha; el filename es para cuando se la baja.
      'Content-Disposition': 'inline; filename="'
        + String(c.tarjeta_nombre || 'tarjeta' + ext).replace(/[^\w.\- ]/g, '_') + '"',
      // Privada: es la agenda. Sin esto un proxy compartido podría guardarla y
      // devolvérsela a otro.
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.sendFile(f);
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Sacarla. Acá SÍ se borra el archivo de verdad: no es un dato del que haya historia que
// conservar —el teléfono y el mail están tipeados aparte— y una foto de una tarjeta que
// alguien pidió sacar no tiene por qué quedar en el disco.
router.delete('/:id/tarjeta', (req, res) => {
  try {
    const c = db.prepare('SELECT tarjeta_path FROM sg_contactos WHERE id = ? AND eliminado_en IS NULL')
      .get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'no existe ese contacto' });
    borrarArchivo(c.tarjeta_path);
    db.prepare("UPDATE sg_contactos SET tarjeta_path = NULL, tarjeta_nombre = NULL,"
      + " tarjeta_en = NULL, actualizado_en = datetime('now','localtime') WHERE id = ?")
      .run(req.params.id);
    res.json({ ok: true, contacto: ficha(db, req.params.id) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

export default router;
