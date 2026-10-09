// src/rutas/sg_contactos.js
// ── CONTACTOS COMERCIALES DE SAN GERÓNIMO ────────────────────────────────────────────
// La agenda del área. Montado en /api/sg/contactos, ANTES del sgRouter genérico (que
// matchea /api/sg/*) — igual que contable, ventas y tesorería.
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
import db from '../servicios/db_sg_contactos.js';
import { exigirEmpresa, SAN_GERONIMO } from '../servicios/sociedad_modulo.js';
import {
  buscar, ficha, pendientes, opciones, mascaraValida,
  observadoProveedor, observadoCliente, ofreceYNoLeCompramos,
  TIPOS, CANALES, MESES,
} from '../servicios/contactos.js';

const router = express.Router();

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

// ── LA FICHA ──────────────────────────────────────────────────────────────────────────
// Trae lo DECLARADO (lo que el comercial cargó) y lo OBSERVADO (lo que dicen las ventas)
// por separado. Separado a propósito: la diferencia entre las dos cosas —ofrece brócoli y
// nunca le compramos brócoli— es justamente la oportunidad, y mezclándolas no se ve.
router.get('/:id', (req, res) => {
  try {
    const f = ficha(db, req.params.id);
    if (!f) return res.status(404).json({ ok: false, error: 'no existe ese contacto' });

    if (f.proveedor_nombre) {
      f.compras = observadoProveedor(db, f.proveedor_nombre);
      f.ofrece_sin_comprar = ofreceYNoLeCompramos(f.productos, f.compras);
    }
    if (f.cliente_nombre) f.ventas = observadoCliente(db, f.cliente_nombre);
    res.json({ ok: true, contacto: f });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── ALTA Y EDICIÓN ────────────────────────────────────────────────────────────────────
const CAMPOS = ['nombre', 'empresa', 'cargo', 'tipo', 'zona', 'localidad',
                'cliente_nombre', 'proveedor_nombre', 'vendedor', 'etiquetas', 'notas'];

router.post('/', (req, res) => {
  try {
    const b = req.body || {};
    const nombre = txt(b.nombre);
    if (!nombre) return res.status(400).json({ ok: false, error: 'falta el nombre' });
    const tipo = TIPOS.includes(b.tipo) ? b.tipo : 'otro';

    const r = db.prepare(`INSERT INTO sg_contactos
      (nombre, empresa, cargo, tipo, zona, localidad, cliente_nombre, proveedor_nombre,
       vendedor, etiquetas, notas, creado_por_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      nombre, txt(b.empresa), txt(b.cargo), tipo, txt(b.zona), txt(b.localidad),
      txt(b.cliente_nombre), txt(b.proveedor_nombre), txt(b.vendedor),
      txt(b.etiquetas), txt(b.notas), req._user.id || null);
    const id = Number(r.lastInsertRowid);

    // Los medios y los productos pueden venir en el mismo alta: cargar un contacto y
    // después su teléfono en dos pantallas distintas es la forma de que el teléfono no se
    // cargue nunca.
    guardarMedios(id, b.medios);
    guardarProductos(id, b.productos);
    res.json({ ok: true, id, contacto: ficha(db, id) });
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
      if (c === 'tipo') {
        if (!TIPOS.includes(b.tipo)) return res.status(400).json({ ok: false, error: 'tipo inválido' });
        sets.push('tipo = ?'); par.push(b.tipo); continue;
      }
      sets.push(`${c} = ?`); par.push(txt(b[c]));
    }
    if ('activo' in b) { sets.push('activo = ?'); par.push(b.activo ? 1 : 0); }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nada que cambiar' });

    sets.push("actualizado_en = datetime('now','localtime')");
    par.push(req.params.id);
    const r = db.prepare(`UPDATE sg_contactos SET ${sets.join(', ')}
                           WHERE id = ? AND eliminado_en IS NULL`).run(...par);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe ese contacto' });
    res.json({ ok: true, contacto: ficha(db, req.params.id) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Baja blanda, y por dirección propia: lo que se pierde al borrar un contacto no es la
// ficha, son las charlas: el historial de lo que se habló con esa persona durante años.
router.post('/:id/eliminar', (req, res) => {
  try {
    const r = db.prepare(`UPDATE sg_contactos SET eliminado_en = datetime('now','localtime')
                           WHERE id = ? AND eliminado_en IS NULL`).run(req.params.id);
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

// ── QUÉ PRODUCE, Y CUÁNDO ─────────────────────────────────────────────────────────────
function guardarProductos(id, productos) {
  if (!Array.isArray(productos)) return;
  const ins = db.prepare(`INSERT INTO sg_contacto_productos
                          (contacto_id,producto,variedad,meses,volumen,notas) VALUES (?,?,?,?,?,?)`);
  for (const p of productos) {
    const prod = txt(p && p.producto);
    if (!prod) continue;
    const meses = mascaraValida(p.meses) ? p.meses : '000000000000';
    ins.run(id, prod.toUpperCase(), txt(p.variedad), meses, txt(p.volumen), txt(p.notas));
  }
}

router.post('/:id/productos', (req, res) => {
  try {
    const b = req.body || {};
    const prod = txt(b.producto);
    if (!prod) return res.status(400).json({ ok: false, error: 'falta el producto' });
    // Una máscara rota se rechaza en vez de guardarse como está: guardada, la ficha
    // dibujaría una ventana cualquiera y nadie sabría que es basura.
    if (b.meses != null && !mascaraValida(b.meses)) {
      return res.status(400).json({ ok: false, error: 'los meses tienen que ser 12 ceros y unos, el primero es JULIO' });
    }
    const r = db.prepare(`INSERT INTO sg_contacto_productos
                          (contacto_id,producto,variedad,meses,volumen,notas) VALUES (?,?,?,?,?,?)`)
      .run(req.params.id, prod.toUpperCase(), txt(b.variedad),
           b.meses || '000000000000', txt(b.volumen), txt(b.notas));
    res.json({ ok: true, id: Number(r.lastInsertRowid), productos: ficha(db, req.params.id).productos });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.patch('/:id/productos/:pid', (req, res) => {
  try {
    const b = req.body || {};
    if (b.meses != null && !mascaraValida(b.meses)) {
      return res.status(400).json({ ok: false, error: 'los meses tienen que ser 12 ceros y unos, el primero es JULIO' });
    }
    const sets = [], par = [];
    for (const c of ['producto', 'variedad', 'meses', 'volumen', 'notas']) {
      if (!(c in b)) continue;
      sets.push(`${c} = ?`);
      par.push(c === 'producto' ? (txt(b.producto) || '').toUpperCase() : (c === 'meses' ? b.meses : txt(b[c])));
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nada que cambiar' });
    par.push(req.params.pid, req.params.id);
    const r = db.prepare(`UPDATE sg_contacto_productos SET ${sets.join(', ')}
                           WHERE id = ? AND contacto_id = ?`).run(...par);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe ese producto' });
    res.json({ ok: true, productos: ficha(db, req.params.id).productos });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.delete('/:id/productos/:pid', (req, res) => {
  try {
    const r = db.prepare('DELETE FROM sg_contacto_productos WHERE id = ? AND contacto_id = ?')
      .run(req.params.pid, req.params.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe ese producto' });
    res.json({ ok: true, productos: ficha(db, req.params.id).productos });
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

export default router;
