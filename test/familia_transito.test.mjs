// ══ DAR DE BAJA UNA FAMILIA QUE TIENE COSAS ADENTRO ════════════════════
//
// El maestro tenía familias repetidas —"Hortalizas Livianas" en el 03 y en el 09— y
// la de más no se podía sacar: el botón se apagaba porque tenía especies y productos
// colgando. Ahora se da de baja y lo que colgaba se estaciona en una familia de
// tránsito, desde donde se reasigna.
//
// Lo que este test cuida de verdad: que la mudanza NO se lleve puesto un producto de
// OTRA familia. Puede pasar —un producto con su especie en la familia que muere y su
// familia_id apuntando a otra— y si se lo arrastra, se queda sin alícuota propia y
// sin la de su familia. Desde el #879 eso ya no sale exento en silencio: FRENA la
// emisión. Un producto que se facturaba bien dejaría de poder facturarse por dar de
// baja una familia ajena.
//
// La lógica vive en un router que no se puede importar (arrastra express, multer,
// xlsx y el SDK), así que se extraen las piezas por texto y se corren contra una base
// real. Si alguien las renombra, el test falla en vez de pasar en falso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_familias (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo INTEGER UNIQUE,
      nombre TEXT, iva_alicuota REAL, activo INTEGER DEFAULT 1, transitoria INTEGER DEFAULT 0,
      creado_por INTEGER, eliminado_en TEXT, eliminado_por_id INTEGER);
    CREATE TABLE sg_especies (id INTEGER PRIMARY KEY AUTOINCREMENT, familia_id INTEGER,
      codigo INTEGER, nombre TEXT, activo INTEGER DEFAULT 1,
      modificado_en TEXT, modificado_por INTEGER, UNIQUE(familia_id, codigo));
    CREATE TABLE sg_variedades (id INTEGER PRIMARY KEY, especie_id INTEGER, codigo INTEGER, nombre TEXT);
    CREATE TABLE sg_productos (id INTEGER PRIMARY KEY, codigo TEXT, familia_id INTEGER,
      especie_id INTEGER, variedad_id INTEGER, nombre TEXT, variedad TEXT, familia TEXT,
      iva_alicuota REAL, activo INTEGER DEFAULT 1);
    INSERT INTO sg_familias (id,codigo,nombre,iva_alicuota) VALUES
      (1,1,'Hortalizas Livianas',10.5), (2,9,'Hortalizas Livianas (repetida)',10.5),
      (3,5,'Otros',NULL);
    INSERT INTO sg_especies (id,familia_id,codigo,nombre) VALUES (10,2,1,'Lechuga'), (11,1,1,'Lechuga');
    INSERT INTO sg_productos VALUES
      (100,'09.01.00',2,10,NULL,'Lechuga',NULL,'Hortalizas Livianas (repetida)',10.5,1),
      -- El caso peligroso: su ESPECIE está en la familia que muere, pero su familia_id
      -- apunta a otra que sigue viva.
      (101,'01.01.00',1,10,NULL,'Lechuga',NULL,'Hortalizas Livianas',10.5,1);
  `);
  return db;
}

// Corre el paso 2 de la mudanza tal como está escrito en sg.js.
function pasoMudanza(db, familiaMuere, dest) {
  const especies = db.prepare('SELECT * FROM sg_especies WHERE familia_id=? ORDER BY codigo').all(familiaMuere);
  for (const esp of especies) {
    db.prepare('UPDATE sg_especies SET familia_id=?, codigo=? WHERE id=?').run(dest.id, 99, esp.id);
    // La línea que este test cuida, extraída del fuente para que sea LA del repo.
    // Ojo: hay OTRO UPDATE casi igual en PATCH /especies (mover una especie de
    // familia), con tres parámetros en vez de cuatro. Se ancla en el AND para no
    // agarrar el equivocado — que es exactamente el error que este test busca.
    const sql = SG.match(/UPDATE sg_productos SET familia_id=\?, familia=\? WHERE especie_id=\? AND familia_id=\?/);
    assert.ok(sql, 'no encontré el UPDATE de la mudanza (con su AND familia_id) en sg.js');
    db.prepare(sql[0]).run(dest.id, dest.nombre, esp.id, familiaMuere);
  }
}

test('la mudanza NO se lleva un producto de otra familia', () => {
  const db = base();
  pasoMudanza(db, 2, { id: 4, nombre: 'Sin clasificar' });
  const p100 = db.prepare('SELECT familia_id FROM sg_productos WHERE id=100').get();
  const p101 = db.prepare('SELECT familia_id FROM sg_productos WHERE id=101').get();
  assert.equal(p100.familia_id, 4, 'el de la familia que muere se estaciona');
  assert.equal(p101.familia_id, 1,
    'el que apunta a otra familia SE QUEDA: su familia sigue viva, y arrastrarlo lo '
    + 'dejaría sin alícuota propia ni de familia, o sea sin poder facturarse');
});

test('el UPDATE de la mudanza filtra por familia, no sólo por especie', () => {
  // Si alguien saca el AND familia_id, el test de arriba deja de fallar cuando el
  // bug vuelve —porque la línea se extrae del fuente—, así que se exige explícito.
  assert.match(SG, /UPDATE sg_productos SET familia_id=\?, familia=\? WHERE especie_id=\? AND familia_id=\?/,
    'la mudanza tiene que filtrar por familia_id: sin eso se lleva productos de '
    + 'familias vivas y los deja sin alícuota, que desde el #879 significa que no se '
    + 'pueden facturar');
});

test('la familia de tránsito se reconoce por la marca, no por el nombre', () => {
  // Si se la buscara por nombre, renombrarla haría nacer una segunda sala de espera.
  assert.match(SG, /WHERE transitoria=1 AND activo=1/,
    'familiaTransitoria tiene que buscar por la columna transitoria');
  assert.match(SG, /const FAMILIA_TRANSITORIA = 'Sin clasificar'/);
});

test('la alícuota que se estaba usando se clava antes de mudar', () => {
  // Un producto que se apoyaba en el 10,5 de su familia, al mudarse a la familia de
  // tránsito —que nace sin alícuota— pasaría a no poder facturarse.
  assert.match(SG, /UPDATE sg_productos SET iva_alicuota=\? WHERE familia_id=\? AND iva_alicuota IS NULL/,
    'sin esto, mudar un producto lo deja sin alícuota y la emisión lo frena');
});

test('sin ?mover=1 no se mueve nada: el movimiento se pide', () => {
  assert.match(SG, /String\(req\.query\.mover\) !== '1'/,
    'la baja con cosas adentro tiene que seguir contestando 409 si nadie pidió mover');
});

test('la sala de espera no se muda a sí misma', () => {
  assert.match(SG, /if \(fam\.transitoria\)/,
    'dar de baja la familia de tránsito con gente adentro sería crear otra y pasarle todo');
});
