// ══ EL PRECIO DE UN PROVEEDOR SE ANOTA SOLO EN LA SERIE ════════════════════
//
// Pablo, 21/9/2026: «sería bueno que cada vez que en el planificador de insumos cargo un precio
// nuevo o lo actualizo, abajo me lo lleve al historial para que la evolución se genere sola».
//
// YA SE HACÍA, y este archivo existe para que nadie lo saque sin darse cuenta: el alta y la
// edición de un proveedor llaman a registrarPrecioProveedor, y de ahí sale la serie que dibuja
// «📈 Evolución del precio». Lo que engañaba era el cartel de esa sección, que decía «cargá acá
// los precios que ya tenías registrados» y hacía pensar que todo era a mano.
//
// Se corre la función REAL contra una base en memoria con el esquema REAL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const RUTA = leer('src/rutas/planificacion.js');
const DDL = leer('src/servicios/db_pli.js');
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
// Una tabla del esquema real, tal cual está escrita.
function tabla(nombre) {
  const i = DDL.indexOf('CREATE TABLE IF NOT EXISTS ' + nombre + ' (');
  assert.ok(i >= 0, 'no está la tabla ' + nombre);
  const j = DDL.indexOf('\n  );', i);
  assert.ok(j > i, 'no cierra la tabla ' + nombre);
  return DDL.slice(i, j + 4);
}

const TABLAS = ['pli_insumos', 'pli_insumo_proveedores', 'pli_insumo_precios', 'pli_cotizaciones'];

function base() {
  const db = new DatabaseSync(':memory:');
  // Sin las llaves foráneas: acá se prueba lo que se escribe, no el árbol entero del módulo.
  for (const t of TABLAS) {
    db.exec(tabla(t).replace(/REFERENCES [a-z_]+\([a-z_]+\)/g, ''));
  }
  // Las columnas que la tabla ganó DESPUÉS, por migración: se leen de db_pli.js igual que el
  // CREATE, así que si mañana se agrega una, este banco de pruebas la tiene sin tocarlo.
  for (const m of DDL.match(/addCol\('[a-z_]+',\s*'[a-z_]+',\s*'[A-Z]+'\)/g) || []) {
    const [, t, col, tipo] = /addCol\('([a-z_]+)',\s*'([a-z_]+)',\s*'([A-Z]+)'\)/.exec(m);
    if (!TABLAS.includes(t)) continue;
    const ya = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (!ya.includes(col)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${tipo}`);
  }
  db.exec(`INSERT INTO pli_insumos (id, sociedad_id, nombre, unidad_compra, unidad_uso)
           VALUES (1, 1, 'CAJA GRANDE 600*400*180', 'UN', 'UN')`);
  return db;
}

const registrar = (db) => new Function('db', [
  fuente(RUTA, 'function hoyISO()'),
  fuente(RUTA, 'function tcParaFecha(fecha)'),
  fuente(RUTA, 'function registrarPrecioProveedor(insumoId, provId, d, origen, userId)'),
  'return registrarPrecioProveedor;',
].join('\n'))(db);

const serie = (db) => db.prepare(`SELECT fecha, precio, moneda, origen, proveedor_id, proveedor_texto,
    unidad_compra, tc_usado FROM pli_insumo_precios ORDER BY id`).all().map((x) => ({ ...x }));

test('cargar un proveedor con precio deja su punto en la serie, sin que nadie lo cargue a mano', () => {
  const db = base();
  const reg = registrar(db);
  reg(1, 7, { precio_ref: 1811.30, moneda: 'ARS', precio_fecha: '2026-09-21', nombre: 'CARTOCOR' }, 'alta', 5);
  const s = serie(db);
  assert.equal(s.length, 1, 'el precio del proveedor no llegó a la serie: la evolución queda vacía');
  assert.deepEqual([s[0].fecha, s[0].precio, s[0].moneda, s[0].origen], ['2026-09-21', 1811.3, 'ARS', 'alta']);
  // CON SU PROVEEDOR: la serie es POR proveedor, y sin esto las dos cartoneras se mezclan en una
  // sola línea que no es la evolución de ninguna.
  assert.equal(s[0].proveedor_id, 7);
  assert.equal(s[0].proveedor_texto, 'CARTOCOR');
  // Y con la unidad de compra del momento: el precio es POR esa unidad, y si mañana el insumo
  // pasa de UN a PALLET, el punto viejo tiene que seguir diciendo de qué unidad hablaba.
  assert.equal(s[0].unidad_compra, 'UN');
});

test('actualizar el precio agrega otro punto; el de otro proveedor no se mezcla', () => {
  const db = base();
  const reg = registrar(db);
  reg(1, 7, { precio_ref: 1811.30, moneda: 'ARS', precio_fecha: '2026-09-21', nombre: 'CARTOCOR' }, 'alta', 5);
  reg(1, 7, { precio_ref: 1950, moneda: 'ARS', precio_fecha: '2026-10-05', nombre: 'CARTOCOR' }, 'edicion', 5);
  reg(1, 8, { precio_ref: 2010.85, moneda: 'ARS', precio_fecha: '2026-09-21', nombre: 'Smurfit' }, 'alta', 5);
  const s = serie(db);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => [x.proveedor_id, x.precio, x.origen]),
    [[7, 1811.3, 'alta'], [7, 1950, 'edicion'], [8, 2010.85, 'alta']]);
  // La evolución de CARTOCOR son sus dos puntos, no los tres.
  assert.equal(s.filter((x) => x.proveedor_id === 7).length, 2);
});

test('sin precio no se anota nada, y un error al anotar no voltea la carga del proveedor', () => {
  const db = base();
  const reg = registrar(db);
  // UN PROVEEDOR SE PUEDE CARGAR SIN PRECIO —para tenerlo a mano y pedirle presupuesto—, y eso no
  // es un punto de la serie: un cero dibujaría una caída que nunca pasó.
  reg(1, 7, { precio_ref: 0, moneda: 'ARS', precio_fecha: '2026-09-21', nombre: 'CARTOCOR' }, 'alta', 5);
  reg(1, 7, { precio_ref: null, moneda: 'ARS', nombre: 'CARTOCOR' }, 'alta', 5);
  assert.equal(serie(db).length, 0);
  // Y ANOTAR ES UN EFECTO, NO EL TRABAJO: si la serie falla, el proveedor ya se guardó igual. Por
  // eso va con su try: acá se rompe la tabla a propósito y la llamada no puede tirar.
  db.exec('DROP TABLE pli_insumo_precios');
  assert.doesNotThrow(() => reg(1, 7, { precio_ref: 100, moneda: 'ARS', nombre: 'CARTOCOR' }, 'alta', 5));
});

test('sin fecha, el punto es de hoy: un precio sin fecha no se puede ubicar en una evolución', () => {
  const db = base();
  const reg = registrar(db);
  reg(1, 7, { precio_ref: 500, moneda: 'USD', nombre: 'CARTOCOR' }, 'alta', 5);
  const hoy = new Date();
  const p = (n) => String(n).padStart(2, '0');
  assert.equal(serie(db)[0].fecha, `${hoy.getFullYear()}-${p(hoy.getMonth() + 1)}-${p(hoy.getDate())}`);
});

test('el alta y la edición de un proveedor son las que lo anotan, y la edición sólo si el precio cambió', () => {
  const alta = fuente(RUTA, "router.post('/insumos/:id/proveedores'");
  assert.match(alta, /if \(d\.precio_ref > 0\) \{\r?\n\s+registrarPrecioProveedor\(id, r\.lastInsertRowid, d, 'alta', req\.user\.id\);/,
    'cargar un proveedor con precio dejó de anotar el punto en la serie');
  const edicion = fuente(RUTA, "router.patch('/proveedores/:provId'");
  // SÓLO SI EL PRECIO CAMBIÓ DE VERDAD: corregirle el teléfono a un proveedor no puede dibujar un
  // punto nuevo en la evolución de su precio.
  assert.match(edicion, /if \(Number\(d\.precio_ref\) !== Number\(actual\.precio_ref\) \|\| d\.moneda !== actual\.moneda\) \{\r?\n\s+registrarPrecioProveedor\(actual\.insumo_id, actual\.id, d, 'edicion', req\.user\.id\);/);
});

test('la pantalla dice que la serie se llena sola: si no, parece que hay que cargarla a mano', () => {
  const i = PANEL.indexOf('📈 Evolución del precio');
  assert.ok(i > 0, 'no está la sección de la evolución');
  const trozo = PANEL.slice(i, i + 1200);
  // El cartel decía «Cargá acá los precios que ya tenías registrados» y nada más, así que el que
  // lo leía daba por hecho que la evolución había que armarla a mano — que es justo lo que
  // preguntó Pablo el 21/9/2026.
  assert.match(trozo, /se anotan acá solos/);
  assert.match(trozo, /precios <b>viejos<\/b>/,
    'no dice que el formulario es para los precios de antes');
  assert.match(trozo, /cada vez que agregás un proveedor con precio o le/);
});
