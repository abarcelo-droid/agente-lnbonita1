// ══ EL MAPA DE PRODUCTOS ══════════════════════════════════════════════════
//
// Pablo, 8/9/2026: «dejame reorganizar productos dentro de familias. Mejorame el
// mapa de productos o maestro de productos, poniéndolo como si fuese un gráfico
// que se entienda un poco más: Frutas, todas las especies y luego los que tengan
// variedades. Permitime arrastrar de una a otra para poder modificar. Algo
// similar a lo que tenemos con los rubros contables».
//
// El maestro era una GRILLA PLANA: la jerarquía familia → especie → variedad
// existía en la base y no se veía en ningún lado.
//
// Y mover una VARIEDAD de especie no se podía: el PATCH leía sólo el nombre y a
// un {especie_id} le contestaba «Nombre vacío». El único camino era borrarla y
// crearla de nuevo, que le cambia el id y deja a los productos colgando de una
// variedad dada de baja.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PREFIJOS = fs.readFileSync(path.join(RAIZ, 'src/servicios/ensure_api_prefijos.js'), 'utf8');

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

const MOVER = trozo(SG, "router.patch('/variedades/:id'", '\r\n});');
const TAXO = trozo(SG, "router.get('/taxonomia'", '\r\n});');

// ══════════════════════════════════════════════════════════════════════════
// 1 · EL ÁRBOL, CONTRA UN SQLITE DE VERDAD
// ══════════════════════════════════════════════════════════════════════════
//
// Las consultas se sacan del archivo, no se copian: si alguien las cambia, acá
// se prueba lo cambiado.
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_familias (id INTEGER PRIMARY KEY, codigo INTEGER, nombre TEXT,
      iva_alicuota REAL, transitoria INTEGER DEFAULT 0, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_especies (id INTEGER PRIMARY KEY, familia_id INTEGER, codigo INTEGER,
      nombre TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_variedades (id INTEGER PRIMARY KEY, especie_id INTEGER, codigo INTEGER,
      nombre TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_productos (id INTEGER PRIMARY KEY, codigo TEXT, familia_id INTEGER,
      especie_id INTEGER, variedad_id INTEGER, nombre TEXT, variedad TEXT, familia TEXT,
      activo INTEGER DEFAULT 1);

    INSERT INTO sg_familias (id,codigo,nombre,iva_alicuota) VALUES
      (1,1,'Frutas',10.5), (3,3,'Hortalizas Livianas',10.5), (18,18,'Sin clasificar',NULL);
    INSERT INTO sg_especies (id,familia_id,codigo,nombre) VALUES
      (10,3,1,'Lima'), (11,3,3,'Mandarina'), (12,1,1,'Pera');
    INSERT INTO sg_variedades (id,especie_id,codigo,nombre) VALUES
      (20,11,2,'Afurer'), (21,11,7,'Murcot'), (22,12,1,'Williams');
    INSERT INTO sg_productos (id,codigo,familia_id,especie_id,variedad_id,nombre,variedad,familia) VALUES
      (100,'03.03.02',3,11,20,'Mandarina','Afurer','Hortalizas Livianas'),
      (101,'03.03.07',3,11,21,'Mandarina','Murcot','Hortalizas Livianas'),
      -- El «Lima» a secas: producto sin variedad, código FF.EE.00.
      (102,'03.01.00',3,10,NULL,'Lima',NULL,'Hortalizas Livianas'),
      (103,'01.01.01',1,12,22,'Pera','Williams','Frutas'),
      -- Y uno huérfano, de una importación vieja: no cuelga de ninguna especie.
      (104,'99.99.99',NULL,NULL,NULL,'Algo',NULL,NULL);
  `);
  return db;
}

// Saca los SELECT del handler tal como están escritos.
function consulta(marca) {
  const i = MOVER.length && TAXO.indexOf(marca);
  assert.ok(i > 0, 'no está la consulta ' + marca);
  const a = TAXO.indexOf('`', i) + 1;
  const b = TAXO.indexOf('`', a);
  return TAXO.slice(a, b);
}

test('el árbol trae las familias con sus conteos', () => {
  const db = base();
  const fs_ = db.prepare(consulta('const familias =')).all();
  assert.deepEqual(fs_.map((f) => f.nombre), ['Frutas', 'Hortalizas Livianas', 'Sin clasificar']);
  const hl = fs_.find((f) => f.id === 3);
  assert.equal(hl.especies, 2, 'Hortalizas Livianas tiene Lima y Mandarina');
  assert.equal(hl.productos, 3);
  // La que no tiene alícuota se distingue de la que tiene 0: sin ella no se
  // puede facturar y la pantalla lo marca en rojo.
  assert.equal(fs_.find((f) => f.id === 18).iva_alicuota, null);
});

test('las especies traen cuántas variedades y cuántos productos cuelgan', () => {
  const db = base();
  const es = db.prepare(consulta('const especies =')).all();
  const man = es.find((e) => e.id === 11);
  assert.equal(man.variedades, 2);
  assert.equal(man.productos, 2);
  // Es el número que decide si mover algo es gratis o caro.
  assert.equal(es.find((e) => e.id === 10).productos, 1);
});

test('y las variedades también', () => {
  const db = base();
  const vs = db.prepare(consulta('const variedades =')).all();
  assert.equal(vs.find((v) => v.id === 20).productos, 1);
  assert.equal(vs.length, 3);
});

test('el producto SIN variedad se cuenta aparte, no desaparece', () => {
  // Es el «Lima» a secas, con código FF.EE.00. Si el árbol sólo dibujara
  // variedades, esos productos no aparecerían en ningún lado.
  const db = base();
  const sv = db.prepare(consulta('const sinVariedad =')).all();
  assert.equal(sv.length, 1, 'sólo Lima tiene un producto sin variedad');
  assert.equal(sv[0].especie_id, 10);
  assert.equal(sv[0].productos, 1);
  // Y la pantalla lo dibuja como un renglón más, con su código 00.
  const e = trozo(PANEL, 'function sgTaxEspecie(e, ed){', '\r\n}');
  assert.match(e, /sin variedad/);
});

test('y el que no cuelga de ninguna especie se cuenta y se avisa', () => {
  const db = base();
  assert.equal(db.prepare(consulta('const huerfanos =')).get().n, 1);
  // Y la pantalla lo dice, con qué hacer.
  const f = trozo(PANEL, 'function sgTaxRender(){', '\r\n}');
  assert.match(f, /no cuelgan de ninguna especie/);
  assert.match(f, /Se arreglan de a uno desde <b>🥦 Productos<\/b>/);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · MOVER UNA VARIEDAD DE ESPECIE
// ══════════════════════════════════════════════════════════════════════════

test('mover una variedad arrastra a sus productos: especie, familia y código', () => {
  // Un producto es familia+especie+variedad. Si la variedad se cuelga de otra
  // especie, sus productos cambian de especie y —si la especie destino es de otra
  // familia— también de familia. Sin esto quedan diciendo la especie vieja y con
  // un código FF.EE.VV que ya no corresponde a nada.
  const db = base();
  const upd = trozo(MOVER, "db.prepare(`UPDATE sg_productos SET especie_id=?", '`)');
  const sql = upd.slice(upd.indexOf('`') + 1, upd.lastIndexOf('`'));
  // Se mueve Afurer (20) de Mandarina (11, familia 3) a Pera (12, familia 1).
  db.prepare(sql).run(12, 'Pera', 1, 'Frutas', 20);
  const p = db.prepare('SELECT * FROM sg_productos WHERE id=100').get();
  assert.equal(p.especie_id, 12);
  assert.equal(p.nombre, 'Pera', 'el producto sigue diciendo la especie vieja');
  assert.equal(p.familia_id, 1);
  assert.equal(p.familia, 'Frutas');
  // Y el hermano que NO se movió no se toca.
  assert.equal(db.prepare('SELECT especie_id FROM sg_productos WHERE id=101').get().especie_id, 11);
});

test('el handler acepta especie_id, que antes ignoraba', () => {
  // Un PATCH con sólo {especie_id} contestaba «Nombre vacío»: mover una variedad
  // no tenía forma de hacerse.
  assert.match(MOVER, /const pideMover = req\.body\.especie_id !== undefined/);
  assert.match(MOVER, /Number\(req\.body\.especie_id\) !== Number\(v\.especie_id\)/);
  assert.match(MOVER, /const nombre = req\.body\.nombre !== undefined \? val\(req\.body\.nombre\) : null;/);
  // Y sigue rechazando un nombre vacío EXPLÍCITO, que es otra cosa que no mandarlo.
  assert.match(MOVER, /if \(req\.body\.nombre !== undefined && !nombre\)/);
});

test('renumera el código dentro del destino', () => {
  // El código de una variedad es correlativo adentro de SU especie: el que traía
  // puede estar ocupado allá y rompería el UNIQUE(especie_id, codigo).
  assert.match(MOVER, /sets\.push\('especie_id=\?', 'codigo=\?'\)/);
  assert.match(MOVER, /nextCodigoNivel\(db, 'sg_variedades', 'especie_id=\?', \[especieNueva\.id\]\)/);
});

test('el nombre repetido se chequea contra el DESTINO, no contra donde está', () => {
  // Mover una «Criolla» a una especie que ya tiene otra «Criolla» dejaría dos
  // variedades iguales colgando de lo mismo.
  assert.match(MOVER, /const destino = pideMover \? Number\(req\.body\.especie_id\) : v\.especie_id;/);
  assert.match(MOVER, /taxConNombre\(db, 'sg_variedades', 'especie_id', destino, nombre, v\.id\)/);
  assert.match(MOVER, /La especie destino ya tiene una variedad/);
});

test('y una especie destino que no existe se rechaza', () => {
  assert.match(MOVER, /La especie destino no existe/);
  // Se lee con su familia, porque de ahí sale la familia nueva del producto.
  assert.match(MOVER, /JOIN sg_familias f ON f\.id = e\.familia_id/);
});

test('un PATCH que no pide nada no pasa por caja', () => {
  assert.match(MOVER, /if \(nombre === null && !pideMover\)[\s\S]{0,120}Nada para actualizar/);
});

test('el código FF.EE.VV se rehace con el mismo armador de siempre', () => {
  // resolverProducto es el ÚNICO que arma el código. Escribirlo a mano acá sería
  // una segunda regla para el mismo número.
  assert.match(MOVER, /resolverProducto\(db, \{ familia_id: especieNueva\.fam_id,/);
  assert.match(MOVER, /UPDATE sg_productos SET codigo=\? WHERE id=\?/);
});

test('todo junto en una transacción', () => {
  // Mover la variedad y no llegar a renumerar los productos deja el catálogo con
  // códigos que no corresponden a nada.
  assert.match(MOVER, /db\.transaction\(\(\) => \{/);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL ARRASTRE, CORRIDO DE VERDAD
// ══════════════════════════════════════════════════════════════════════════
//
// Es lo que decide si se llama o no al endpoint que renumera decenas de
// productos. Se ejecuta, no se lee.
function soltar(estado, arrastrando, acepta, destinoId) {
  const src = trozo(PANEL, 'function sgTaxDrop(ev, acepta, destinoId){', '\r\n}');
  const llamadas = [];
  const mundo = {
    SGTAX: Object.assign({ fam: [], esp: [], var: [], arrastrando: arrastrando }, estado),
    sgTaxMover: (ruta, body) => llamadas.push({ ruta, body }),
    escH: (v) => String(v == null ? '' : v),
  };
  const f = new Function(...Object.keys(mundo), src + '\nreturn sgTaxDrop;')(...Object.values(mundo));
  f({ preventDefault() {}, stopPropagation() {}, currentTarget: { style: {} } }, acepta, destinoId);
  return llamadas;
}

// LOS IDS SE PISAN A PROPÓSITO. sg_especies y sg_variedades son dos tablas con su
// propio autoincrement: que exista una especie 12 y una variedad 12 es lo normal,
// no un caso raro. Si el drop no mirara QUÉ se está arrastrando, soltar la
// variedad 12 sobre una familia movería la ESPECIE 12 — otra cosa, en otro lugar,
// renumerando productos que nadie tocó.
const ARBOL = {
  edicion: 1,
  fam: [{ id: 1, nombre: 'Frutas' }, { id: 3, nombre: 'Hortalizas Livianas' }],
  esp: [{ id: 11, familia_id: 3, nombre: 'Mandarina', productos: 2 },
        { id: 12, familia_id: 1, nombre: 'Pera', productos: 1 }],
  var: [{ id: 20, especie_id: 11, nombre: 'Afurer', productos: 1 },
        { id: 12, especie_id: 11, nombre: 'Criolla', productos: 4 }],
};

test('arrastrar una especie a otra familia la mueve', () => {
  const ll = soltar(ARBOL, { tipo: 'especie', id: 11 }, 'especie', 1);
  assert.equal(ll.length, 1);
  assert.equal(ll[0].ruta, '/api/sg/especies/11');
  assert.deepEqual(ll[0].body, { familia_id: 1 });
});

test('arrastrar una variedad a otra especie la mueve', () => {
  const ll = soltar(ARBOL, { tipo: 'variedad', id: 20 }, 'variedad', 12);
  assert.equal(ll.length, 1);
  assert.equal(ll[0].ruta, '/api/sg/variedades/20');
  assert.deepEqual(ll[0].body, { especie_id: 12 });
});

test('soltarla donde YA estaba no es un movimiento', () => {
  // Sin esto se llama al endpoint, se renumera el código y se le cambia el código
  // a todos los productos para dejarlos donde ya estaban.
  assert.deepEqual(soltar(ARBOL, { tipo: 'especie', id: 11 }, 'especie', 3), []);
  assert.deepEqual(soltar(ARBOL, { tipo: 'variedad', id: 20 }, 'variedad', 11), []);
});

test('una variedad soltada sobre una familia no hace nada', () => {
  // Sin mirar el tipo, el drop la aceptaría y llamaría al endpoint equivocado.
  assert.deepEqual(soltar(ARBOL, { tipo: 'variedad', id: 20 }, 'especie', 1), []);
  assert.deepEqual(soltar(ARBOL, { tipo: 'especie', id: 11 }, 'variedad', 12), []);
});

test('y con ids que se pisan, tampoco mueve el de la otra tabla', () => {
  // La variedad 12 («Criolla», colgada de Mandarina) y la especie 12 («Pera») son
  // dos cosas distintas con el mismo número, que es lo normal entre dos tablas con
  // su propio autoincrement. Sin mirar el tipo, soltar la variedad 12 sobre
  // Hortalizas Livianas movería la ESPECIE Pera de familia y renumeraría sus
  // productos, sin que nadie la haya tocado.
  assert.deepEqual(soltar(ARBOL, { tipo: 'variedad', id: 12 }, 'especie', 3), [],
    'movió la especie que tenía el mismo id que la variedad arrastrada');
  // Y al revés: la especie 12 soltada sobre una especie no puede moverse como si
  // fuera la variedad 12.
  assert.deepEqual(soltar(ARBOL, { tipo: 'especie', id: 12 }, 'variedad', 12), []);
});

test('sin modo edición no se mueve nada, aunque se arrastre', () => {
  const sinEd = Object.assign({}, ARBOL, { edicion: 0 });
  assert.deepEqual(soltar(sinEd, { tipo: 'especie', id: 11 }, 'especie', 1), []);
});

test('y lo que no existe en el árbol tampoco', () => {
  assert.deepEqual(soltar(ARBOL, { tipo: 'especie', id: 999 }, 'especie', 1), []);
  assert.deepEqual(soltar(ARBOL, null, 'especie', 1), []);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LA PANTALLA
// ══════════════════════════════════════════════════════════════════════════

test('la solapa existe y engancha con el cargador', () => {
  assert.match(PANEL, /data-sub="mapa"\s+onclick="sgCatSub\('mapa'\)"/);
  assert.match(PANEL, /id="sg-sub-mapa"/);
  const f = trozo(PANEL, 'function sgLoad(entity){', '\r\n}');
  assert.match(f, /if \(entity==='mapa'\)\{ return sgTaxLoad\(\); \}/);
});

test('el arrastre está APAGADO hasta que se prende, y se avisa antes', () => {
  // Un arrastre accidental sobre el catálogo le cambia el código a decenas de
  // productos sin que nadie lo haya pedido.
  // En los DOS niveles que se arrastran: una fila con el cursor de agarre que no
  // se puede soltar en ningún lado es una promesa que la pantalla no cumple.
  for (const f of ['function sgTaxEspecie(e, ed){', 'function sgTaxVariedad(v, ed){']) {
    assert.match(trozo(PANEL, f, '\r\n}'), /var arr = ed\s*\r?\n?\s*\? ' draggable="true"/,
      f + ' deja arrastrar sin modo edición');
  }
  // Y el que empieza el arrastre también lo mira, aunque el atributo se cuele.
  assert.match(trozo(PANEL, 'function sgTaxDragStart(ev, tipo, id){', '\r\n}'),
    /if \(!SGTAX\.edicion\) return;/);
  const m = trozo(PANEL, 'function sgTaxModo(){', '\r\n}');
  assert.match(m, /if \(!SGTAX\.edicion && !confirm\(/, 'prende el modo sin avisar');
  assert.match(m, /LE CAMBIA EL CÓDIGO a todos los productos/);
  // Y se dice que no se pierde nada, que es lo primero que uno piensa.
  assert.match(m, /no se pierde nada/);
  assert.match(PANEL, /id="sg-tax-banner"/);
});

test('el árbol se dibuja entero: familia, especie y variedad', () => {
  const r = trozo(PANEL, 'function sgTaxRender(){', '\r\n}');
  assert.match(r, /sgTaxEspecie\(e, ed\)/);
  const e = trozo(PANEL, 'function sgTaxEspecie(e, ed){', '\r\n}');
  assert.match(e, /sgTaxVariedad\(v, ed\)/);
  // Y los conteos de cada nivel, que son los que hacen que se entienda.
  assert.match(r, /sgTaxCuenta\(esps\.length, 'especie', 'especies'\)/);
  assert.match(e, /sgTaxCuenta\(vars\.length, 'variedad', 'variedades'\)/);
});

test('el movimiento avisa cuántos productos se renumeraron', () => {
  // Es la consecuencia del arrastre: el que lo hizo tiene que verla, no
  // descubrirla después mirando códigos.
  const f = trozo(PANEL, 'function sgTaxMover(ruta, body, texto, productos){', '\r\n}');
  assert.match(f, /producto\(s\) renumerados/);
  // Y el catálogo en memoria de las otras pantallas quedó viejo.
  assert.match(f, /sgLoadCaches/);
  // Si falla, se recarga: el árbol dibujado ya no coincide con la base.
  assert.match(f, /toast\(\(r && r\.error\) \|\| 'No se pudo mover', 'er'\); sgTaxLoad\(\)/);
});

test('la dirección nueva está declarada, o el permiso la rebota', () => {
  assert.match(PREFIJOS, /sg\/variedades,sg\/taxonomia/);
});

test('y Maestros estrena su «¿Cómo se usa?», que tampoco tenía', () => {
  // Pablo, 8/9/2026: «cada vez que modifiques algo en alguna pantalla tenés que
  // actualizar el Cómo se usa correspondiente».
  assert.match(PANEL, /onclick="sgManualAbrir\('catalogo'\)"/);
  const m = trozo(PANEL, "SG_MANUAL.catalogo = { titulo: 'Maestros'", '\r\n};');
  // Lo que hay que entender antes de tocar nada: el código ES la ubicación.
  assert.match(m, /<code>FF\.EE\.VV<\/code>/);
  assert.match(m, /<b>Mover algo le cambia el código a todos sus productos<\/b>/);
  assert.match(m, /no se pierde nada/);
  // Y las ocho solapas, no sólo la nueva.
  for (const t of ['Productos', 'El mapa', 'Familias', 'Envases', 'Presentaciones',
                   'Proveedores', 'Clientes', 'Condiciones de pago']) {
    assert.ok(m.includes(t), 'el manual no menciona ' + t);
  }
  assert.match(m, /Reorganizar arrastrando <span class="ver">V1027<\/span>/);
  // Y no cita una versión que el panel todavía no alcanzó.
  const SIDEBAR = fs.readFileSync(path.join(RAIZ, 'src/sidebar-v2.js'), 'utf8');
  const actual = Number((SIDEBAR.match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const v of (m.match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
    assert.ok(v <= actual, 'el manual cita la V' + v + ' y el panel va en la V' + actual);
  }
});
