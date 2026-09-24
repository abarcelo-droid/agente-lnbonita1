// ══ EL LOGO DE LA CASA QUEDA CARGADO, SIN QUE HAYA QUE SUBIRLO ═════════════
//
// Pablo, 24/9/2026: «el logo de la empresa lo tenés… poné el de La Niña Bonita». Es la marca del
// grupo y estaba en el repo desde siempre; Puente Cordón es la sociedad que compra, así que el papel
// lo firma Puente Cordón y arriba va el logo con el que el proveedor la reconoce.
//
// Lo que este archivo clava, y las tres son cosas que se notan recién en el deploy siguiente:
//
//  1. QUE CORRA UNA SOLA VEZ EN LA VIDA DE LA BASE. Sin eso, sacar el logo desde la pantalla no
//     serviría de nada: el arranque siguiente lo volvería a poner, y no habría manera de quitarlo.
//  2. QUE NO PISE UN LOGO YA CARGADO. Si alguien subió el suyo, esa decisión gana.
//  3. QUE NO SE MARQUE LA BANDERA CUANDO TODAVÍA NO HAY SOCIEDADES. En una base recién creada se
//     siembran DESPUÉS de esto; marcarla ahí dejaría la base nueva sin logo para siempre.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const DDL = leer('src/servicios/db_org.js');
const { logoDeArchivo, LOGO_MAX, LOGO_FORMATO } =
  await import(pathToFileURL(path.join(RAIZ, 'src/servicios/logo_empresa.js')));

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

function base(conSociedades = true) {
  const db = new DatabaseSync(':memory:');
  for (const t of ['sociedades', 'sociedad_logos']) {
    const i = DDL.indexOf('CREATE TABLE IF NOT EXISTS ' + t + ' (');
    assert.ok(i >= 0, 'no está la tabla ' + t);
    db.exec(DDL.slice(i, DDL.indexOf('\n  );', i) + 4).replace(/REFERENCES [a-z_]+\([a-z_]+\)/g, ''));
  }
  if (conSociedades) {
    // San Gerónimo se lleva el id 1 a propósito: es el id al que caen las funciones que adivinan.
    db.exec(`INSERT INTO sociedades (id, nombre, tipo) VALUES
      (1, 'San Gerónimo SA', 'interna'), (2, 'Puente Cordón SA', 'interna')`);
  }
  return db;
}

// LA SIEMBRA REAL, leída de db_org.js y corrida contra esta base y el archivo de verdad. No se
// prueba una copia: si mañana cambia la función, esto mide la nueva.
const ARCHIVO = 'logo-documentos.jpg';

function sembrar(db) {
  const cuerpo = fuente(DDL, '(function sembrarLogoDeLaCasa()');
  const fn = new Function('db', 'fs', 'logoDeArchivo', 'console', 'RAIZ', [
    cuerpo.replace(`new URL('../${ARCHIVO}', import.meta.url)`, `RAIZ + '/src/${ARCHIVO}'`),
    ')();',
  ].join('\n'));
  const dicho = [];
  fn(db, fs, logoDeArchivo, { log: (m) => dicho.push(m), warn: (m) => dicho.push(m) }, RAIZ);
  return dicho;
}

const logoDe = (db, soc) =>
  (db.prepare('SELECT logo FROM sociedad_logos WHERE sociedad_id=?').get(soc) || {}).logo || null;
const flag = (db) => {
  try { return db.prepare("SELECT valor FROM sistema_flags WHERE key='logo_casa_puente_cordon_v1'").get(); }
  catch (_) { return null; }
};

test('el archivo del repo se convierte en un logo que el sistema acepta', () => {
  // Es el mismo filtro que valida el logo que se sube por la pantalla: el que siembra no tiene por
  // qué tener menos control que el que sube.
  const uri = logoDeArchivo(fs.readFileSync(path.join(RAIZ, 'src/' + ARCHIVO)), ARCHIVO);
  assert.ok(uri, 'el logo del repo no pasa el filtro');
  assert.match(uri, LOGO_FORMATO);
  assert.ok(uri.length < LOGO_MAX, 'el logo no entra en el techo: ' + uri.length + ' de ' + LOGO_MAX);
  assert.match(uri, /^data:image\/jpeg;base64,/);
  // Y no se acepta cualquier archivo por estar adentro del repo: la extensión decide el tipo, y un
  // tipo que no es de los tres no entra.
  // Un SVG de verdad, con cuerpo: es el formato que hay que dejar afuera sí o sí —puede traer su
  // propio marcado— y con un archivo corto no se llega a probar nada.
  assert.equal(logoDeArchivo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>'), 'logo.svg'), null);
  assert.equal(logoDeArchivo(Buffer.from('x'), 'logo'), null);
  assert.equal(logoDeArchivo(Buffer.alloc(0), 'logo.jpg'), null, 'un archivo vacío se sembró igual');
  assert.equal(logoDeArchivo(null, 'logo.jpg'), null, 'sin bytes tiene que devolver null, no romper');

  // Y MIRA LOS BYTES, NO EL NOMBRE. Con la extensión sola, un archivo mal copiado —un puntero de
  // git-lfs, un HTML de error, un texto— entraba como «image/jpeg» perfectamente válido, pasaba el
  // filtro del formato y quedaba en la base para siempre, porque la siembra corre una sola vez.
  // Arriba de la orden se vería el ícono de imagen rota, en un papel que se manda afuera.
  assert.equal(logoDeArchivo(Buffer.from('version https://git-lfs.github.com/spec/v1'), 'logo.jpg'), null,
    'un archivo que no es una imagen se sembró como si lo fuera');
  assert.equal(logoDeArchivo(Buffer.from('<html>404 Not Found</html>'), 'logo.png'), null);
  // Y el tipo tiene que coincidir con la extensión: los bytes de un JPEG llamados .png tampoco.
  assert.equal(logoDeArchivo(fs.readFileSync(path.join(RAIZ, 'src/' + ARCHIVO)), 'logo.png'), null,
    'un JPEG se sirvió como PNG');
  // La firma se mira ENTERA. Un archivo cortado o pisado que arranca con FF pero no sigue como un
  // JPEG no es un JPEG, y mirar un byte solo lo dejaría pasar.
  assert.equal(logoDeArchivo(Buffer.concat([Buffer.from([0xFF, 0x00, 0x11]), Buffer.alloc(16)]), 'logo.jpg'), null,
    'alcanzó con el primer byte para hacerlo pasar por JPEG');

  // Y EL TIPO QUE SE ESCRIBE ES EL DEL ARCHIVO. Un PNG anunciado como «image/jpeg» es un logo que
  // el navegador puede no dibujar, arriba de una orden que ya se mandó.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10]), Buffer.alloc(16)]);
  assert.match(logoDeArchivo(png, 'logo.png'), /^data:image\/png;base64,/);

  // Y PASA POR EL MISMO FILTRO QUE LO QUE SE SUBE: si mañana alguien deja en el repo un logo de
  // 2 MB, no se siembra —queda el recuadro para subir uno— en vez de meter en la base algo que la
  // ruta habría rechazado. Se arma un PNG con su firma de verdad para que lo frene el techo y no
  // el chequeo de bytes.
  const pngEnorme = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10]), Buffer.alloc(LOGO_MAX)]);
  assert.equal(logoDeArchivo(pngEnorme, 'logo.png'), null,
    'sembró una imagen más grande que el techo que valida la ruta');
});

test('EL PRIMER ARRANQUE DE UNA BASE NUEVA YA DEJA EL LOGO PUESTO', () => {
  // La siembra vive en el MISMO archivo que crea las sociedades. Estando arriba de ellas, una
  // instalación nueva no encontraba a Puente Cordón y se quedaba con el recuadro «subir el logo»
  // hasta el segundo arranque, sin que nadie entendiera por qué.
  //
  // Se corren los DOS bloques reales EN EL ORDEN EN QUE ESTÁN EN EL ARCHIVO, contra una base vacía.
  // No se compara el número de línea: se mide el resultado.
  assert.ok(DDL.indexOf('(function sembrarLogoDeLaCasa()') > DDL.indexOf('(function seedOrg()'),
    'la siembra del logo volvió a quedar arriba de la que crea las sociedades');

  const db = base(false);
  // `areas` la necesita seedOrg, y `db.transaction` no existe en node:sqlite.
  db.exec(`CREATE TABLE areas (id INTEGER PRIMARY KEY AUTOINCREMENT, sociedad_id INTEGER, nombre TEXT)`);
  db.transaction = (fn) => (...a) => { db.exec('BEGIN'); try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  const cuerpo = (f) => fuente(DDL, f);
  const enOrden = [cuerpo('(function seedOrg()'), cuerpo('(function sembrarLogoDeLaCasa()')]
    .map((c) => c.replace(`new URL('../${ARCHIVO}', import.meta.url)`, `RAIZ + '/src/${ARCHIVO}'`) + ')();')
    .join('\n');
  new Function('db', 'fs', 'logoDeArchivo', 'console', 'RAIZ', enOrden)(
    db, fs, logoDeArchivo, { log: () => {}, warn: () => {}, error: () => {} }, RAIZ);

  const soc = db.prepare("SELECT id FROM sociedades WHERE nombre='Puente Cordón SA'").get();
  assert.ok(soc, 'el seed de sociedades no corrió');
  assert.ok(logoDe(db, soc.id), 'una instalación nueva arranca sin logo: hacen falta dos arranques');
});

test('la primera vez deja el logo cargado en Puente Cordón, y en ninguna otra empresa', () => {
  const db = base();
  sembrar(db);
  const puesto = logoDe(db, 2);
  assert.ok(puesto, 'no quedó cargado el logo');
  assert.match(puesto, LOGO_FORMATO);
  assert.equal(logoDe(db, 1), null, 'le puso el logo a San Gerónimo, que es otra empresa');
  assert.equal(flag(db).valor, 'sembrado');
});

test('SACARLO QUEDA SACADO: el arranque siguiente no lo vuelve a poner', () => {
  // Sin esto, el botón «quitarlo» de la pantalla no serviría para nada y no habría manera de
  // sacar un logo — que es lo que va impreso en todo lo que se manda afuera.
  const db = base();
  sembrar(db);
  db.prepare('DELETE FROM sociedad_logos WHERE sociedad_id=2').run();
  sembrar(db);
  assert.equal(logoDe(db, 2), null, 'el logo volvió solo después de que lo sacaron');
});

test('no pisa el logo que alguien haya subido', () => {
  const db = base();
  const propio = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  db.prepare('INSERT INTO sociedad_logos (sociedad_id, logo) VALUES (2,?)').run(propio);
  sembrar(db);
  assert.equal(logoDe(db, 2), propio, 'la siembra pisó el logo que había subido el usuario');
  // Y queda anotado que no hacía falta, para que no se reintente en cada arranque.
  assert.equal(flag(db).valor, 'ya-tenia');
});

test('correrla dos veces no deja dos logos ni cambia el que hay', () => {
  const db = base();
  sembrar(db);
  const primero = logoDe(db, 2);
  sembrar(db);
  const filas = db.prepare('SELECT logo FROM sociedad_logos WHERE sociedad_id=2').all();
  assert.equal(filas.length, 1);
  assert.equal(filas[0].logo, primero);
});

test('en una base sin sociedades no marca la bandera: se reintenta en el arranque siguiente', () => {
  // En una base recién creada las sociedades se siembran DESPUÉS de esto. Marcar la bandera acá
  // dejaría esa base sin logo para siempre, y nadie sabría por qué.
  const db = base(false);
  sembrar(db);
  assert.equal(flag(db), undefined, 'marcó la bandera sin haber sembrado nada');
  // Cuando aparecen, la siembra siguiente sí lo pone.
  db.exec(`INSERT INTO sociedades (id, nombre, tipo) VALUES (2, 'Puente Cordón SA', 'interna')`);
  sembrar(db);
  assert.ok(logoDe(db, 2), 'ya con la sociedad cargada, tampoco lo puso');
});

test('la busca por NOMBRE, no por el id 1', () => {
  // Un logo guardado contra el id equivocado sale impreso en los papeles de otra empresa. Es la
  // misma razón por la que el documento de la orden lo busca por nombre.
  const f = fuente(DDL, '(function sembrarLogoDeLaCasa()');
  assert.match(f, /WHERE nombre = 'Puente Cordón SA'/);
  assert.match(f, /nombre LIKE 'Puente Cord%'/);
  assert.ok(!/sociedad_id = 1|sociedades LIMIT 1/.test(f));
  // Y si el archivo no está o no pasa el filtro, no siembra NI marca: mejor el recuadro para
  // subirlo que un logo roto arriba de una orden que se manda al proveedor.
  assert.match(f, /if \(!logo\) \{ console\.warn/);
  // Y avisa: si se queda callado, se reintenta en cada arranque sin que nadie se entere.
  assert.match(f, /no es una imagen válida/);
  // El arranque no se cae por un logo: se avisa y se reintenta en el deploy siguiente.
  assert.match(f, /catch \(e\) \{/);
  assert.match(f, /console\.warn/);
});

test('un archivo roto no rompe el arranque ni deja la bandera puesta', () => {
  const db = base();
  const cuerpo = fuente(DDL, '(function sembrarLogoDeLaCasa()');
  const fn = new Function('db', 'fs', 'logoDeArchivo', 'console', [
    cuerpo.replace(`new URL('../${ARCHIVO}', import.meta.url)`, "'no-existe.jpg'"),
    ')();',
  ].join('\n'));
  const dicho = [];
  // No tira: el arranque del sistema no se cae por un logo.
  fn(db, { readFileSync: () => { throw new Error('ENOENT'); } }, logoDeArchivo,
     { log: (m) => dicho.push(m), warn: (m) => dicho.push(m) });
  assert.equal(logoDe(db, 2), null);
  assert.equal(flag(db), undefined, 'marcó la bandera sin haber podido sembrar');
  assert.match(dicho.join(' '), /No se pudo cargar el logo/);
});

test('la pantalla no promete más de lo que el logo cambia', () => {
  // El ÚNICO papel que lee el logo de la empresa es esta orden de compra: los demás —facturas,
  // liquidaciones, remitos, el otro circuito de órdenes— usan el archivo del sistema y no miran la
  // base. Mientras no había ningún logo cargado nadie veía estos textos; con el logo ya puesto se
  // ven siempre, y prometer de más es peor que no decir nada: se aprieta «quitarlo», se ve cambiar
  // esta orden, y se sigue viendo el logo viejo en todo lo demás sin entender por qué.
  //
  // Se busca el TEXTO QUE SE MUESTRA —el literal con su comilla— y no la frase suelta: arriba de
  // cada cambio quedó el comentario que cita lo que decía antes, y eso no es lo que ve nadie.
  const PANEL = leer('src/panel.html');
  assert.ok(!/'✓ Logo guardado: sale en todos los documentos/.test(PANEL),
    'el cartel sigue prometiendo todos los documentos de la empresa');
  assert.ok(!/confirm\('El logo se saca de TODOS los documentos/.test(PANEL));
  assert.match(PANEL, /sale en la orden de compra de este módulo/);
  assert.match(PANEL, /Los demás documentos del sistema usan su propio logo y no cambian/);
  // Y que no vuelve solo, que es la consecuencia de que la siembra corra una sola vez y la única
  // que nadie puede adivinar mirando la pantalla.
  assert.match(PANEL, /no vuelve solo: para tenerlo de nuevo hay que subirlo/);
  assert.match(PANEL, /Sale en el encabezado de estas órdenes de compra/);
});

test('el filtro del logo está en UN solo lugar, y la pantalla usa el mismo', () => {
  // Dos copias de un filtro de seguridad es como no tener ninguno: alcanza con que mañana alguien
  // afloje una. El router ya no tiene el suyo.
  const ORG = leer('src/rutas/org.js');
  assert.ok(!/const LOGO_FORMATO =/.test(ORG), 'el router volvió a tener su propia copia del filtro');
  assert.match(ORG, /import \{ validarLogo \} from '\.\.\/servicios\/logo_empresa\.js';/);
  assert.match(DDL, /import \{ logoDeArchivo \} from '\.\/logo_empresa\.js';/);
  // Y la copia del navegador —que no puede importar nada— tiene que decir exactamente lo mismo.
  const SERV = leer('src/servicios/logo_empresa.js');
  const PANEL = leer('src/panel.html');
  const enServicio = /export const LOGO_FORMATO = (.*);/.exec(SERV)[1];
  const enPantalla = /var PLI_LOGO_FORMATO = (.*);/.exec(PANEL)[1];
  assert.equal(enPantalla, enServicio, 'el filtro de la pantalla se desfasó del servidor');
});
