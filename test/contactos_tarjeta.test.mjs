// ══ LA FOTO DE LA TARJETA ═════════════════════════════════════════════════
//
// Andy, 18/10/2026: «quiero que me sumen también un lugar para poner la foto
// de la tarjeta de cada uno. Sin lector ni nada, sólo un lugar para sumar
// foto de la tarjeta».
//
// ── LO QUE PUEDE SALIR MAL Y NO SE VE ─────────────────────────────────────
// 1. QUE LA FOTO QUEDE PÚBLICA. Todas las demás fotos del sistema van a
//    carpetas que express.static sirve ANTES del portón de sesión: quedan en
//    una URL del mismo origen que el panel, alcanzable sin cookie. Para la
//    foto de un cajón da igual. Acá la foto ES el teléfono directo de un
//    comprador de cadena — exactamente lo que este módulo decidió no dejar al
//    alcance de cualquiera. Que esté mal no se nota usando la pantalla.
// 2. QUE SE ESCRIBA UN ARCHIVO QUE NO ES UNA FOTO. El accept="image/*" del
//    formulario es una sugerencia del selector de archivos y no existe para
//    un pedido armado a mano.
// 3. QUE LA RUTA DEL DISCO SALGA EN EL JSON. No le sirve a la pantalla y
//    cuenta cómo está armado el servidor.
//
// Se levanta el router de verdad en un Express y se le pega con fetch. El
// temporal va adentro del repo porque el router importa multer, y Node busca
// node_modules subiendo desde el archivo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let express = null;
let falta = false;
try {
  express = (await import('express')).default;
  await import('multer');
} catch { falta = 'falta el paquete express (o multer): corre npm install para que estos tests corran'; }

const t = (nombre, fn) => test(nombre, { skip: falta }, fn);

// Un PNG de un pixel, de verdad: el fileFilter mira la extensión y el mimetype,
// así que un Buffer de texto con nombre .png pasaría igual y el test no probaría
// lo mismo que pasa en producción.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sociedades (id INTEGER PRIMARY KEY, nombre TEXT);
    INSERT INTO sociedades (id,nombre) VALUES (7,'Puente Cordón SA'), (9,'San Gerónimo SA');
    CREATE TABLE sheet_compras (id INTEGER PRIMARY KEY);
    CREATE TABLE sheet_ventas  (id INTEGER PRIMARY KEY);
  `);
  return db;
}

async function servidor(db, usuario) {
  const dir = fs.mkdtempSync(path.join(RAIZ, '.tmp-ctj-'));
  fs.mkdirSync(path.join(dir, 'servicios'));
  fs.mkdirSync(path.join(dir, 'rutas'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/servicios'))) {
    if (f.endsWith('.js')) {
      fs.copyFileSync(path.join(RAIZ, 'src/servicios', f), path.join(dir, 'servicios', f));
    }
  }
  fs.copyFileSync(path.join(RAIZ, 'src/rutas/sg_contactos.js'), path.join(dir, 'rutas', 'sg_contactos.js'));
  fs.writeFileSync(path.join(dir, 'servicios', 'db.js'),
    'export default globalThis.__CTJ_DB; export const getDb = () => globalThis.__CTJ_DB;\n'
    + 'export function rehacerTabla(){}\n', 'utf8');
  globalThis.__CTJ_DB = db;

  const mod = await import('file:///' + path.join(dir, 'rutas', 'sg_contactos.js').replace(/\\/g, '/'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.cookies = usuario ? { lnb_user: JSON.stringify(usuario) } : {}; next(); });
  app.use('/api/sg/contactos', mod.default);
  const srv = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const url = 'http://127.0.0.1:' + srv.address().port;
  // La carpeta donde el router escribe de verdad: sale de su propio __dirname, que con
  // la copia en <raiz>/.tmp-ctj-xxx/rutas/ queda en <raiz>/data/contactos. No se asume —
  // si el router cambiara de carpeta, estos tests tienen que enterarse.
  const fotos = path.join(dir, '..', 'data', 'contactos');
  // Se cuentan los archivos NUEVOS, no los que hay: la carpeta es la del repo y puede
  // traer cosas de antes. Contar el total haría que el test fallara o pasara según qué
  // más haya corrido, que es la peor clase de test.
  const archivos = () => (fs.existsSync(fotos) ? fs.readdirSync(fotos) : []);
  const creados = [];
  return {
    dir, fotos, archivos,
    nuevosDesde: (antes) => {
      const n = archivos().filter((f) => !antes.includes(f));
      for (const f of n) if (!creados.includes(f)) creados.push(f);
      return n;
    },
    pegar: (ruta, opts) => fetch(url + '/api/sg/contactos' + ruta, opts),
    cerrar: () => {
      srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
      // Lo que este test escribió se limpia: son fotos de prueba en la carpeta del repo.
      for (const f of creados) { try { fs.unlinkSync(path.join(fotos, f)); } catch (_) {} }
    },
  };
}

const USER = { id: 3, nombre: 'Andy', rol: 'admin' };
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(body) });
const patch = (body) => Object.assign(json(body), { method: 'PATCH' });

// Una persona, para colgarle la tarjeta.
async function unaPersona(s, nombre) {
  const r = await (await s.pegar('/', json({ nombre: nombre || 'Juan Giglio',
                                             empresa: 'GIGLIO HNOS SRL' }))).json();
  assert.ok(r.ok, JSON.stringify(r));
  return r.id;
}
function subir(buf, nombre, tipo) {
  const fd = new FormData();
  fd.append('tarjeta', new Blob([buf], { type: tipo || 'image/png' }), nombre || 'tarjeta.png');
  return { method: 'POST', body: fd };
}

// ── SUBIRLA Y VERLA ───────────────────────────────────────────────────────
t('se sube una foto y la ficha dice que la tiene', async () => {
  const s = await servidor(base(), USER);
  try {
    const id = await unaPersona(s);
    assert.equal((await (await s.pegar('/' + id)).json()).contacto.tiene_tarjeta, false);

    const r = await s.pegar('/' + id + '/tarjeta', subir(PNG, 'tarjeta-juan.png'));
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.contacto.tiene_tarjeta, true);
    assert.equal((await (await s.pegar('/' + id)).json()).contacto.tiene_tarjeta, true);
  } finally { s.cerrar(); }
});

t('y se la puede volver a mirar, como imagen', async () => {
  const s = await servidor(base(), USER);
  try {
    const id = await unaPersona(s);
    await s.pegar('/' + id + '/tarjeta', subir(PNG));
    const r = await s.pegar('/' + id + '/tarjeta');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    // inline, para verla en la ficha sin descargarla.
    assert.match(r.headers.get('content-disposition'), /^inline/);
    const b = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(b, PNG, 'devolvió otra cosa, no la foto que se subió');
  } finally { s.cerrar(); }
});

t('LA RUTA DEL DISCO NO SALE EN NINGÚN JSON', async () => {
  // No le sirve a la pantalla —pide /:id/tarjeta— y publicarla es contar cómo
  // está armado el disco de adentro, para nada.
  const s = await servidor(base(), USER);
  try {
    const id = await unaPersona(s);
    await s.pegar('/' + id + '/tarjeta', subir(PNG, 'secreta.png'));
    for (const ruta of ['/' + id, '/?q=Juan', '/empresas']) {
      const txt = await (await s.pegar(ruta)).text();
      assert.ok(!txt.includes('tarjeta_path'), 'sale tarjeta_path en ' + ruta);
      assert.ok(!/tarjeta_\d+_\d+\.png/.test(txt), 'sale el nombre del archivo en ' + ruta);
    }
  } finally { s.cerrar(); }
});

t('la ficha de la empresa dice QUIÉN tiene tarjeta, sin pedir cada ficha', async () => {
  const s = await servidor(base(), USER);
  try {
    const a = await unaPersona(s, 'Juan Giglio');
    await unaPersona(s, 'Marta Giglio');
    await s.pegar('/' + a + '/tarjeta', subir(PNG));
    const e = (await (await s.pegar('/' + a)).json()).contacto.empresa;
    const j = (await (await s.pegar('/empresas/' + e.id)).json()).empresa;
    const map = {};
    for (const p of j.personas) map[p.nombre] = p.tiene_tarjeta;
    assert.equal(!!map['Juan Giglio'], true);
    assert.equal(!!map['Marta Giglio'], false);
  } finally { s.cerrar(); }
});

// ── LO QUE NO ENTRA ───────────────────────────────────────────────────────
t('UN ARCHIVO QUE NO ES UNA FOTO NO SE ESCRIBE', async () => {
  // El accept="image/*" del formulario es una sugerencia del selector de
  // archivos y no existe para un pedido armado a mano. Sin esta puerta, un
  // «tarjeta.html» con un <script> adentro se guarda igual.
  const s = await servidor(base(), USER);
  try {
    const id = await unaPersona(s);
    for (const [nom, tipo] of [['tarjeta.html', 'text/html'], ['x.svg', 'image/svg+xml'],
                               ['x.pdf', 'application/pdf'], ['foto.png', 'text/html']]) {
      const r = await s.pegar('/' + id + '/tarjeta', subir(Buffer.from('<script>x</script>'), nom, tipo));
      assert.equal(r.status, 400, 'entró ' + nom + ' como ' + tipo);
    }
    assert.equal((await (await s.pegar('/' + id)).json()).contacto.tiene_tarjeta, false);
  } finally { s.cerrar(); }
});

t('y el error dice qué se puede subir, no «error 400»', async () => {
  const s = await servidor(base(), USER);
  try {
    const id = await unaPersona(s);
    const r = await (await s.pegar('/' + id + '/tarjeta',
      subir(Buffer.from('x'), 'x.pdf', 'application/pdf'))).json();
    assert.match(r.error, /jpg|png|foto/i, r.error);
  } finally { s.cerrar(); }
});

t('subirle una tarjeta a alguien que no existe NO deja el archivo tirado', async () => {
  // multer ya escribió el archivo cuando el handler se entera de que la persona
  // no está: sin borrarlo queda en el disco del servidor para siempre.
  const s = await servidor(base(), USER);
  try {
    const antes = s.archivos();
    const r = await s.pegar('/999/tarjeta', subir(PNG));
    assert.equal(r.status, 404);
    assert.deepEqual(s.nuevosDesde(antes), [], 'quedó un archivo huérfano en el disco');
  } finally { s.cerrar(); }
});

// ── REEMPLAZARLA Y SACARLA ────────────────────────────────────────────────
t('REEMPLAZARLA BORRA LA VIEJA: una tarjeta por persona, no una galería', async () => {
  const s = await servidor(base(), USER);
  try {
    const id = await unaPersona(s);
    const antes = s.archivos();
    await s.pegar('/' + id + '/tarjeta', subir(PNG, 'vieja.png'));
    const vieja = s.nuevosDesde(antes);
    assert.equal(vieja.length, 1, 'escribió ' + vieja.length + ' archivos para una foto');

    await s.pegar('/' + id + '/tarjeta', subir(PNG, 'nueva.png'));
    assert.ok(!s.archivos().includes(vieja[0]), 'quedaron las dos en el disco');
    assert.equal(s.nuevosDesde(antes).length, 1);
    assert.equal((await (await s.pegar('/' + id)).json()).contacto.tarjeta_nombre, 'nueva.png');
  } finally { s.cerrar(); }
});

t('sacarla borra el archivo de verdad', async () => {
  // No es un dato con historia que conservar: el teléfono y el mail están
  // tipeados aparte, y una foto que alguien pidió sacar no tiene por qué quedar.
  const s = await servidor(base(), USER);
  try {
    const id = await unaPersona(s);
    const antes = s.archivos();
    await s.pegar('/' + id + '/tarjeta', subir(PNG));
    assert.equal(s.nuevosDesde(antes).length, 1);

    const r = await s.pegar('/' + id + '/tarjeta', { method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).contacto.tiene_tarjeta, false);
    assert.deepEqual(s.nuevosDesde(antes), [], 'el archivo sigue en el disco');
    assert.equal((await s.pegar('/' + id + '/tarjeta')).status, 404);
  } finally { s.cerrar(); }
});

t('pedir una tarjeta que no está es 404, no un 200 con basura', async () => {
  const s = await servidor(base(), USER);
  try {
    const id = await unaPersona(s);
    const r = await s.pegar('/' + id + '/tarjeta');
    assert.equal(r.status, 404);
    assert.match((await r.json()).error, /tarjeta/i);
  } finally { s.cerrar(); }
});

// ── Y SIN SESIÓN, NADA ────────────────────────────────────────────────────
t('SIN SESIÓN NO SE VE LA FOTO — que es el motivo de que no viva en una carpeta pública', async () => {
  const db = base();
  const conSesion = await servidor(db, USER);
  let id;
  try {
    id = await unaPersona(conSesion);
    await conSesion.pegar('/' + id + '/tarjeta', subir(PNG));
  } finally { conSesion.cerrar(); }

  const sinSesion = await servidor(db, null);
  try {
    for (const [ruta, opts] of [['/' + id + '/tarjeta', undefined],
                                ['/' + id + '/tarjeta', subir(PNG)],
                                ['/' + id + '/tarjeta', { method: 'DELETE' }]]) {
      assert.equal((await sinSesion.pegar(ruta, opts)).status, 401, ruta);
    }
  } finally { sinSesion.cerrar(); }
});

// ── MOVER A ALGUIEN DE EMPRESA, POR NOMBRE ────────────────────────────────
t('PASAR UNA PERSONA DE EMPRESA ESCRIBIENDO EL NOMBRE', async () => {
  // Es lo que pasa cuando el comprador de una cadena se va a la competencia. La
  // ficha edita campos sueltos con el nombre a la vista, no con un id: pedirle
  // que resuelva el nombre a un id por su cuenta serían dos maneras distintas de
  // hacer lo mismo según desde dónde se lo haga.
  const s = await servidor(base(), USER);
  try {
    const id = await unaPersona(s);
    await s.pegar('/empresas', json({ nombre: 'LA POSTA SA', tipo: 'cliente' }));
    const j = await (await s.pegar('/' + id, patch({ empresa: 'LA POSTA SA' }))).json();
    assert.equal(j.contacto.empresa.nombre, 'LA POSTA SA');
    // Y las charlas se van con ella: la persona es la misma.
    assert.ok(j.contacto.empresa_id);
  } finally { s.cerrar(); }
});

t('y una empresa que no existe se crea, igual que en el alta', async () => {
  const s = await servidor(base(), USER);
  try {
    const id = await unaPersona(s);
    const j = await (await s.pegar('/' + id, patch({ empresa: 'FINCA NUEVA SRL' }))).json();
    assert.equal(j.contacto.empresa.nombre, 'FINCA NUEVA SRL');
    const lista = (await (await s.pegar('/empresas')).json()).empresas.map(e => e.nombre);
    assert.ok(lista.includes('FINCA NUEVA SRL'), lista.join(' | '));
  } finally { s.cerrar(); }
});

t('pero vacía NO: una persona sin empresa no puede mostrar lo que produce', async () => {
  const s = await servidor(base(), USER);
  try {
    const id = await unaPersona(s);
    assert.equal((await s.pegar('/' + id, patch({ empresa: '  ' }))).status, 400);
    assert.equal((await (await s.pegar('/' + id)).json()).contacto.empresa.nombre, 'GIGLIO HNOS SRL');
  } finally { s.cerrar(); }
});

// ── UN CAMPO A LA VEZ ─────────────────────────────────────────────────────
t('LA FICHA GUARDA UN CAMPO SOLO, sin mandar los otros trece', async () => {
  // Es de lo que depende editar donde se lee: si el PATCH exigiera el objeto
  // entero, cada campo tendría que mandar lo que tiene en pantalla, y lo que un
  // compañero cambió mientras tanto se pisaría sin que nadie lo note.
  const s = await servidor(base(), USER);
  try {
    const id = await unaPersona(s);
    await s.pegar('/' + id, patch({ cargo: 'Dueño' }));
    await s.pegar('/' + id, patch({ notas: 'Atiende después de las 6.' }));
    const c = (await (await s.pegar('/' + id)).json()).contacto;
    assert.equal(c.cargo, 'Dueño');
    assert.equal(c.notas, 'Atiende después de las 6.');
    assert.equal(c.nombre, 'Juan Giglio', 'se perdió el nombre al guardar otro campo');
  } finally { s.cerrar(); }
});

t('y la empresa también, campo por campo', async () => {
  const s = await servidor(base(), USER);
  try {
    const id = await unaPersona(s);
    const e = (await (await s.pegar('/' + id)).json()).contacto.empresa;
    await s.pegar('/empresas/' + e.id, patch({ zona: 'Valle de Uco' }));
    await s.pegar('/empresas/' + e.id, patch({ vendedor: 'Pablo' }));
    const j = (await (await s.pegar('/empresas/' + e.id)).json()).empresa;
    assert.equal(j.zona, 'Valle de Uco');
    assert.equal(j.vendedor, 'Pablo');
    assert.equal(j.nombre, 'GIGLIO HNOS SRL');
  } finally { s.cerrar(); }
});
