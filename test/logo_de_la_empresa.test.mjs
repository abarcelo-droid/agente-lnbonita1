// ══ EL LOGO DE LA EMPRESA EN LOS PAPELES QUE SE MANDAN AFUERA ══════════════
//
// Pablo, 24/9/2026: «a la orden de compra también podés agregarle el logo de la empresa».
//
// Tres cosas que este archivo clava, y las tres se vuelven un problema recién cuando el papel ya
// salió:
//
//  1. QUE EL LOGO SEA EL DE LA EMPRESA QUE FIRMA. Se busca por nombre y no por el id que devuelve
//     empresaFija, que cae a 1 cuando no encuentra la sociedad. Con el logo de otra empresa arriba,
//     el proveedor recibe un pedido que parece de otro.
//  2. QUE SÓLO ENTRE UNA IMAGEN. El texto que se guarda termina metido en el src de un <img> del
//     documento que se imprime.
//  3. QUE EL RECUADRO PARA SUBIRLO NO SE IMPRIMA. Es una ayuda para el que emite; en la hoja que
//     recibe el proveedor sería un botón muerto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const ORG = leer('src/rutas/org.js');
const DDL_ORG = leer('src/servicios/db_org.js');
const RUTA = leer('src/rutas/planificacion.js');
const PANEL = leer('src/panel.html');

function fuente(txt, firma) {
  const i = txt.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  let prof = 0, k = txt.indexOf('{', i);
  for (; k < txt.length; k++) {
    if (txt[k] === '{') prof++;
    else if (txt[k] === '}') { prof--; if (prof === 0) break; }
  }
  return txt.slice(i, k + 1);
}

// Una línea `const X = ...;` tal como está escrita, para que la prueba use el valor REAL y no una
// copia que mañana quede desfasada.
function lineaConst(txt, nombre) {
  const re = new RegExp('^\\s*const ' + nombre + ' = .*$', 'm');
  const m = re.exec(txt);
  assert.ok(m, 'no está el const ' + nombre);
  return m[0].trim();
}

// La base con las dos tablas REALES: el CREATE de sociedades y el de sociedad_logos, leídos de
// db_org.js. Si mañana cambia una columna, esta prueba la toma sin que haya que tocarla.
function base() {
  const db = new DatabaseSync(':memory:');
  for (const t of ['sociedades', 'sociedad_logos']) {
    const i = DDL_ORG.indexOf('CREATE TABLE IF NOT EXISTS ' + t + ' (');
    assert.ok(i >= 0, 'no está la tabla ' + t);
    db.exec(DDL_ORG.slice(i, DDL_ORG.indexOf('\n  );', i) + 4)
      .replace(/REFERENCES [a-z_]+\([a-z_]+\)/g, ''));
  }
  // El orden de siembra importa para el caso que se quiere evitar: San Gerónimo se lleva el id 1,
  // que es al que cae empresaFija cuando no encuentra la sociedad que le pidieron.
  db.exec(`INSERT INTO sociedades (id, nombre, tipo) VALUES
    (1, 'San Gerónimo SA', 'interna'), (2, 'Puente Cordón SA', 'interna')`);
  return db;
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const OTRO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

// ── 1 · EL LOGO ES EL DE LA EMPRESA QUE FIRMA ──────────────────────────────

const logoDe = (db, emp) => new Function('db', 'empresaDelModulo', 'PUENTE_CORDON', [
  fuente(RUTA, 'function logoDeLaEmpresa()'),
  'return logoDeLaEmpresa();',
].join('\n'))(db, () => emp, 'Puente Cordón SA');

test('el logo sale de la empresa cuyo nombre se imprime, no del id 1', () => {
  const db = base();
  db.exec(`INSERT INTO sociedad_logos (sociedad_id, logo) VALUES (1, '${OTRO}'), (2, '${PNG}')`);
  const r = logoDe(db, { id: 2, nombre: 'Puente Cordón SA' });
  assert.equal(r.sociedad_id, 2);
  assert.equal(r.logo, PNG, 'el papel de Puente Cordón salió con el logo de otra empresa');
});

test('si la empresa no está cargada, el papel sale sin logo en vez de con el de cualquiera', () => {
  const db = base();
  db.exec(`INSERT INTO sociedad_logos (sociedad_id, logo) VALUES (1, '${OTRO}')`);
  // Es el caso real: empresaDelModulo devuelve null y empresaFija, que es la que usa el resto del
  // router, cae a 1. Leer por ese 1 imprimiría el logo de San Gerónimo.
  assert.deepEqual(logoDe(db, null), { sociedad_id: null, logo: null });
});

test('una empresa sin logo cargado no hereda el de la de al lado', () => {
  const db = base();
  db.exec(`INSERT INTO sociedad_logos (sociedad_id, logo) VALUES (1, '${OTRO}')`);
  assert.deepEqual(logoDe(db, { id: 2 }), { sociedad_id: 2, logo: null });
});

test('la orden manda el logo y el id de la empresa, y los saca de esa función', () => {
  const h = fuente(RUTA, "router.get('/planes/:id/compras/:compraId/orden'");
  assert.match(h, /const \{ sociedad_id, logo \} = logoDeLaEmpresa\(\);/);
  // Y VIAJAN AL PANEL: sin el id, la pantalla tendría que adivinar a qué empresa le sube el logo.
  assert.match(h, /^\s+sociedad_id,$/m);
  assert.match(h, /^\s+logo,$/m);
});

// ── 2 · SÓLO ENTRA UNA IMAGEN ──────────────────────────────────────────────

const validar = () => new Function([
  lineaConst(ORG, 'LOGO_FORMATO'),
  lineaConst(ORG, 'LOGO_MAX'),
  fuente(ORG, 'function validarLogo(txt)'),
  'return { validarLogo, LOGO_MAX };',
].join('\n'))();

test('entran PNG, JPG y WEBP en base64, y nada más', () => {
  const { validarLogo } = validar();
  assert.equal(validarLogo(PNG), PNG);
  assert.equal(validarLogo(OTRO), OTRO);
  assert.equal(validarLogo('data:image/webp;base64,UklGRg=='), 'data:image/webp;base64,UklGRg==');
  // UN SVG NO. Va a parar al src de un <img> del documento que se imprime, y un SVG puede traer
  // marcado propio adentro: se acepta mapa de bits o no se acepta nada.
  assert.throws(() => validarLogo('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), /PNG, JPG o WEBP/);
  // Y NADA QUE PUEDA CERRAR EL ATRIBUTO. Con una comilla adentro, lo que siga es marcado.
  assert.throws(() => validarLogo('data:image/png;base64,AAA" onerror="x'), /PNG, JPG o WEBP/);
  assert.throws(() => validarLogo('data:image/png;base64,AAA><script>'), /PNG, JPG o WEBP/);
  assert.throws(() => validarLogo('https://otro-sitio/logo.png'), /PNG, JPG o WEBP/);
  assert.throws(() => validarLogo('javascript:alert(1)'), /PNG, JPG o WEBP/);
});

test('vacío quiere decir QUITARLO, no guardar un logo vacío', () => {
  const { validarLogo } = validar();
  assert.equal(validarLogo(''), null);
  assert.equal(validarLogo('   '), null);
  assert.equal(validarLogo(null), null);
  assert.equal(validarLogo(undefined), null);
});

test('hay techo de tamaño, y el aviso dice cuánto', () => {
  const { validarLogo, LOGO_MAX } = validar();
  const gorda = 'data:image/png;base64,' + 'A'.repeat(LOGO_MAX);
  assert.throws(() => validarLogo(gorda), /muy grande/);
  // Sin techo, la foto de 4 MB de un celular queda en la base y viaja en cada impresión. Y el
  // mensaje tiene que decir el límite: «es muy grande» sin número no le sirve a nadie.
  assert.throws(() => validarLogo(gorda), /185 KB/);
});

test('el PUT del logo es sólo de admin, y no guarda contra una empresa que no existe', () => {
  const h = fuente(ORG, "router.put('/sociedades/:id/logo'");
  // Cargar el logo es PARAMETRIZAR: se hace una vez y sale en todo lo que se manda afuera.
  assert.match(ORG, /router\.put\('\/sociedades\/:id\/logo', requireAdmin,/);
  assert.match(h, /SELECT id FROM sociedades WHERE id = \?/);
  assert.match(h, /404/);
  // Guardado contra un id que no está, el logo no lo lee nadie y el que lo subió cree que quedó.
  const i = h.indexOf('INSERT INTO sociedad_logos');
  assert.ok(i > h.indexOf('404'), 'se guarda antes de verificar que la empresa existe');
});

test('subirlo dos veces deja UN logo, no dos', () => {
  const db = base();
  const guardar = (id, logo) => db.prepare(`
      INSERT INTO sociedad_logos (sociedad_id, logo, subido_por_id) VALUES (?,?,?)
      ON CONFLICT(sociedad_id) DO UPDATE SET logo = excluded.logo,
        subido_en = datetime('now','localtime'), subido_por_id = excluded.subido_por_id
    `).run(id, logo, 7);
  guardar(2, PNG);
  guardar(2, OTRO);
  const filas = db.prepare('SELECT logo FROM sociedad_logos WHERE sociedad_id=2').all();
  assert.equal(filas.length, 1, 'quedaron dos logos de la misma empresa');
  assert.equal(filas[0].logo, OTRO, 'el logo nuevo no reemplazó al viejo');
  // Y el UPSERT que corre la ruta es ESTE: si mañana se escribe un INSERT pelado, el segundo
  // guardado explota por la clave y el que cambia el logo no puede.
  assert.match(fuente(ORG, "router.put('/sociedades/:id/logo'"),
    /ON CONFLICT\(sociedad_id\) DO UPDATE SET logo = excluded\.logo/);
});

test('quitarlo borra la fila, y no deja un logo en blanco que no se dibuja', () => {
  const h = fuente(ORG, "router.put('/sociedades/:id/logo'");
  assert.match(h, /if \(!logo\) \{[\s\S]*DELETE FROM sociedad_logos WHERE sociedad_id = \?/);
  const db = base();
  db.exec(`INSERT INTO sociedad_logos (sociedad_id, logo) VALUES (2, '${PNG}')`);
  db.prepare('DELETE FROM sociedad_logos WHERE sociedad_id = ?').run(2);
  assert.deepEqual(logoDe(db, { id: 2 }), { sociedad_id: 2, logo: null });
});

test('el logo se guarda en la base, no como archivo en el disco', () => {
  // Railway rearma el contenedor en cada deploy: un archivo subido al directorio de la aplicación
  // desaparece en el merge siguiente y el logo habría que volver a subirlo cada vez.
  const h = fuente(ORG, "router.put('/sociedades/:id/logo'");
  assert.ok(!/writeFile|createWriteStream|path\.join/.test(h), 'el logo se está escribiendo a disco');
  assert.match(DDL_ORG, /CREATE TABLE IF NOT EXISTS sociedad_logos/);
});

test('la imagen NO es una columna de sociedades: los listados leen con SELECT *', () => {
  // Una columna acá viajaría en cada carga de la pantalla de Organización y del selector de
  // empresas, de cada empresa, para nada.
  const cols = DDL_ORG.slice(DDL_ORG.indexOf('CREATE TABLE IF NOT EXISTS sociedades ('));
  assert.ok(!/^\s+logo\s/m.test(cols.slice(0, cols.indexOf('\n  );'))), 'el logo quedó en sociedades');
  assert.match(ORG, /SELECT s\.\*,/, 'cambió el listado: revisar que no se mande la imagen');
});

// ── 3 · EL RECUADRO PARA SUBIRLO NO SE IMPRIME ─────────────────────────────

const logoHtml = (d, rol) => new Function('d', 'window', 'pliEsc', [
  'var PLI_LOGO_FORMATO = ' + /var PLI_LOGO_FORMATO = (.*);/.exec(PANEL)[1] + ';',
  fuente(PANEL, 'function pliOrdenLogoHtml(d)'),
  'return pliOrdenLogoHtml(d);',
].join('\n'))(d, { LNB_USER: { rol } }, (s) => String(s == null ? '' : s));

test('el recuadro para subir el logo se ve en pantalla y no sale en la hoja', () => {
  const vacio = logoHtml({ sociedad: 'Puente Cordón SA', logo: null }, 'admin');
  assert.match(vacio, /pli-oc-logo-vacio/);
  assert.match(vacio, /pliLogoElegir\(\)/);
  // Y LA REGLA QUE LO SACA DEL PAPEL. Sin esto, el proveedor recibe una hoja con un recuadro
  // punteado que dice «Subir el logo de la empresa».
  const css = PANEL.slice(PANEL.indexOf('body.pli-imprimiendo>*'));
  assert.match(css.slice(0, css.indexOf('</style>')),
    /\.pli-oc-logo-vacio, \.pli-oc-solo-pantalla\{display:none !important\}/);
  // Cada cosa que el recuadro dibuja tiene que estar en una de esas dos clases, o se imprime.
  for (const div of vacio.match(/<div class="([^"]+)"/g) || []) {
    assert.match(div, /pli-oc-logo-vacio|pli-oc-solo-pantalla/, 'esto se va a imprimir: ' + div);
  }
});

test('con el logo cargado queda sólo el logo; cambiarlo y quitarlo son de pantalla', () => {
  const h = logoHtml({ sociedad: 'Puente Cordón SA', logo: PNG }, 'admin');
  assert.match(h, /<img class="pli-oc-logo" src="data:image\/png;base64,/);
  assert.ok(!/pli-oc-logo-vacio/.test(h), 'quedó el recuadro de «falta el logo» con el logo puesto');
  assert.match(h, /class="pli-oc-solo-pantalla"[^>]*><a onclick="pliLogoElegir\(\)">/);
  assert.match(h, /pliLogoQuitar\(\)/);
});

test('al que no puede cambiarlo no se le ofrece', () => {
  // Apretaría y el servidor le contestaría 403: el que lo aprieta cree que rompió algo.
  assert.equal(logoHtml({ sociedad: 'Puente Cordón SA', logo: null }, 'operador'), '');
  const conLogo = logoHtml({ sociedad: 'Puente Cordón SA', logo: PNG }, 'operador');
  assert.match(conLogo, /<img class="pli-oc-logo"/, 'el logo sí lo tiene que ver cualquiera');
  assert.ok(!/pliLogoElegir|pliLogoQuitar/.test(conLogo));
});

test('la pantalla tampoco dibuja algo que no sea una imagen', () => {
  // Defensa en dos lugares: el servidor no lo deja entrar, y si alguna vez entrara por otra puerta
  // acá no se dibuja en vez de romper el documento.
  for (const malo of ['data:image/svg+xml;base64,PHN2Zz4=', 'AAA" onerror="x', 'https://otro/logo.png']) {
    const h = logoHtml({ sociedad: 'Puente Cordón SA', logo: malo }, 'admin');
    assert.ok(!/<img/.test(h), 'dibujó un logo que no pasa el filtro: ' + malo);
    assert.match(h, /pli-oc-logo-vacio/, 'con un logo ilegible tiene que ofrecer subir uno bueno');
  }
});

test('la imagen se reduce en la pantalla antes de subirla, y el techo es el mismo de los dos lados', () => {
  const red = fuente(PANEL, 'function pliLogoReducir(img)');
  assert.match(red, /toDataURL\('image\/png'\)/);
  // PNG primero, que es el que respeta el fondo transparente; si pesa demasiado, JPG sobre blanco.
  assert.match(red, /fillStyle = '#fff'/);
  assert.match(red, /toDataURL\('image\/jpeg', 0\.85\)/);
  // Y EL MISMO NÚMERO QUE VALIDA EL SERVIDOR: si la pantalla corta más arriba que el servidor, el
  // que sube un logo grande recibe un error en vez de una imagen reducida.
  const max = /const LOGO_MAX = (\d+);/.exec(ORG)[1];
  assert.match(red, new RegExp('png\\.length <= ' + max));
});

test('elegir dos veces el mismo archivo vuelve a disparar la subida', () => {
  // Es lo que hace cualquiera que se equivocó de imagen y vuelve a la misma carpeta. Sin limpiar
  // el campo, el navegador no avisa el cambio y la pantalla parece colgada.
  assert.match(fuente(PANEL, 'function pliLogoElegir()'), /inp\.value = '';[\s\S]*inp\.click\(\)/);
});

test('la subida va a la empresa del documento que se está mirando', () => {
  const g = fuente(PANEL, 'function pliLogoGuardar(dataUrl)');
  assert.match(g, /PLI\.orden && PLI\.orden\.sociedad_id/);
  assert.match(g, /'\/api\/org\/sociedades\/' \+ soc \+ '\/logo'/);
  assert.match(g, /method: 'PUT'/);
  // Sin empresa no se manda nada: el logo terminaría cargado en otra sociedad o en ninguna.
  assert.match(g, /if \(!soc\) return toast/);
});
