// Tests del importador: idempotencia por hash y reemplazo de una fecha ya cargada.
//
// Corre contra una base node:sqlite EN MEMORIA con el esquema REAL (share_ddl.js), no con una
// copia escrita a mano — así el test se entera si el DDL cambia. better-sqlite3 no compila en
// Windows, de ahí el adaptador de abajo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as XLSX from 'xlsx';
import { crearEsquema } from '../src/servicios/share_ddl.js';
import { importar, analizar, recalcularKg, reclasificarFamilias } from '../src/servicios/share_import.js';

// node:sqlite no tiene db.transaction() como better-sqlite3. El adaptador le da la misma
// forma para que el importador que se prueba sea EL MISMO que corre en producción, sin
// ninguna rama "si estoy en un test".
function abrir() {
  const raw = new DatabaseSync(':memory:');
  crearEsquema(raw);
  return {
    _raw: raw,
    exec: (s) => raw.exec(s),
    prepare: (sql) => raw.prepare(sql),
    transaction: (fn) => (...args) => {
      raw.exec('BEGIN');
      try { const r = fn(...args); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
}

// Arma un .xlsx igual al que manda Carrefour: una hoja "Detallado", header en la fila 1.
function planilla(filas, { hoja = 'Detallado' } = {}) {
  const aoa = [['Proveedor_Origen_Desc', 'FECHA ENTREGA', 'DESC', 'BULTOS'],
    ...filas.map(f => [f[0], f[1], f[2], f[3]])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), hoja);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const SG = 'SAN GERONIMO S.A.';
const DIA24 = [
  [SG, '2026-08-24', 'ZAPALLO JAPONES CABUTIAN X KG', 4000],
  [SG, '2026-08-24', 'MANZANA X KG', 1000],
  ['FRUTAS DEL VALLE SRL', '2026-08-24', 'MANZANA X KG', 3000],
  ['PROV.IMPORT.PROPIA PFT FRUT Y VERD', '2026-08-24', 'BANANA X KG', 5000],
];

test('carga base: filas, proveedores, artículos y kg_equiv', () => {
  const db = abrir();
  const r = importar(db, { buffer: planilla(DIA24), nombre: 'PLANNING_FF_VV_24_08.xlsx', usuario: 'andy' });
  assert.equal(r.ok, true);

  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_lineas').get().c, 4);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_proveedores').get().c, 3);
  // MANZANA X KG es UN artículo aunque lo traigan dos proveedores.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_articulos').get().c, 3);

  // Nos reconocimos, y la importación propia quedó separada del resto.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_proveedores WHERE es_nosotros=1').get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM share_proveedores WHERE tipo='importacion_propia'").get().c, 1);

  // Todo en KG: los kilos equivalentes son los propios bultos.
  assert.equal(db.prepare('SELECT SUM(kg_equiv) s FROM share_lineas').get().s, 13000);

  // Todo lo creado automáticamente queda en la cola de revisión.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_articulos WHERE pendiente_revision=1').get().c, 3);
});

test('idempotencia por hash: el mismo archivo no entra dos veces', () => {
  const db = abrir();
  const buf = planilla(DIA24);
  const a = importar(db, { buffer: buf, nombre: 'PLANNING_FF_VV_24_08.xlsx' });
  const b = importar(db, { buffer: buf, nombre: 'PLANNING_FF_VV_24_08.xlsx' });
  const c = importar(db, { buffer: buf, nombre: 'OTRO_NOMBRE.xlsx' });   // mismo contenido

  assert.equal(a.ok, true);
  assert.equal(b.salteado, 'duplicado');
  // El nombre no importa: lo que decide es el CONTENIDO. Así el importador masivo se puede
  // correr sobre la misma carpeta las veces que haga falta.
  assert.equal(c.salteado, 'duplicado');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_lineas').get().c, 4);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_cargas').get().c, 1);
});

test('recarga de una fecha ya cargada: la vieja se marca reemplazada, no se borra', () => {
  const db = abrir();
  importar(db, { buffer: planilla(DIA24), nombre: 'PLANNING_24_08.xlsx' });

  // Mismo día, planning corregido: el zapallo pasó de 4000 a 4500.
  const corregido = DIA24.map(f => f[2].startsWith('ZAPALLO') ? [f[0], f[1], f[2], 4500] : f);
  const r = importar(db, { buffer: planilla(corregido), nombre: 'PLANNING_24_08_v2.xlsx' });
  assert.equal(r.ok, true);
  assert.equal(r.analisis.reemplaza.length, 1);

  // Las dos cargas siguen existiendo: el histórico no se pierde.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_cargas').get().c, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM share_cargas WHERE estado='reemplazada'").get().c, 1);

  // Pero la vista sólo ve la activa: nada se cuenta dos veces.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_v').get().c, 4);
  assert.equal(db.prepare('SELECT SUM(bultos) s FROM share_v').get().s, 13500);
  // Contra la tabla cruda estarían las dos, que es exactamente el error que la vista evita.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_lineas').get().c, 8);
});

test('solapamiento parcial: se frena y lo explica, no adivina', () => {
  const db = abrir();
  // Un planning de dos días.
  const dosDias = [...DIA24, [SG, '2026-08-25', 'MANZANA X KG', 900]];
  importar(db, { buffer: planilla(dosDias), nombre: 'PLANNING_24_25.xlsx' });

  // Ahora llega uno de un solo día que pisa el 25 pero no trae el 24.
  const soloEl25 = [[SG, '2026-08-25', 'MANZANA X KG', 950]];
  const r = importar(db, { buffer: planilla(soloEl25), nombre: 'PLANNING_25_08.xlsx' });

  assert.equal(r.ok, false);
  assert.equal(r.salteado, 'conflicto');
  assert.match(r.error, /se pisa a medias/);
  // No escribió nada: los totales quedan como estaban.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_cargas').get().c, 1);
  assert.equal(db.prepare('SELECT SUM(bultos) s FROM share_v').get().s, 13900);
});

test('un archivo de otro día no toca al anterior', () => {
  const db = abrir();
  importar(db, { buffer: planilla(DIA24), nombre: 'PLANNING_24_08.xlsx' });
  const dia25 = DIA24.map(f => [f[0], '2026-08-25', f[2], f[3]]);
  const r = importar(db, { buffer: planilla(dia25), nombre: 'PLANNING_25_08.xlsx' });

  assert.equal(r.ok, true);
  assert.equal(r.analisis.reemplaza.length, 0, 'no debería reemplazar nada');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM share_cargas WHERE estado='activa'").get().c, 2);
  assert.equal(db.prepare('SELECT SUM(bultos) s FROM share_v').get().s, 26000);
});

test('la hoja o las columnas equivocadas fallan con un mensaje claro', () => {
  const db = abrir();
  assert.throws(
    () => importar(db, { buffer: planilla(DIA24, { hoja: 'Hoja1' }), nombre: 'x.xlsx' }),
    /no tiene la hoja "Detallado"/);

  // Una columna renombrada: no se adivina por posición.
  const aoa = [['Proveedor', 'FECHA ENTREGA', 'DESC', 'BULTOS'], [SG, '2026-08-24', 'MANZANA X KG', 10]];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Detallado');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  assert.throws(() => importar(db, { buffer: buf, nombre: 'x.xlsx' }), /Falta la columna "PROVEEDOR ORIGEN DESC"/);
});

test('una fila ilegible no voltea la carga, pero queda registrada', () => {
  const db = abrir();
  const conBasura = [...DIA24, [SG, 'no es una fecha', 'PERA X KG', 100], ['', '2026-08-24', 'PERA X KG', 50]];
  const r = importar(db, { buffer: planilla(conBasura), nombre: 'PLANNING_24_08.xlsx' });

  assert.equal(r.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_lineas').get().c, 4);
  // Nada se descarta en silencio: el motivo queda guardado en la carga.
  assert.equal(r.analisis.rechazadas.length, 2);
  const w = JSON.parse(db.prepare('SELECT warnings w FROM share_cargas').get().w);
  assert.equal(w.rechazadas.length, 2);
  assert.match(w.warnings.join(' '), /no se pueden cargar/);
});

test('el nombre del archivo que contradice a las filas avisa, pero carga', () => {
  const db = abrir();
  const r = importar(db, { buffer: planilla(DIA24), nombre: 'PLANNING_FF_VV_30_08.xlsx' });
  assert.equal(r.ok, true);
  assert.match(r.analisis.warnings.join(' '), /Manda la fila/);
  assert.equal(db.prepare('SELECT fecha_entrega f FROM share_cargas').get().f, '2026-08-24');
});

test('corregir la unidad a mano arregla también lo ya cargado', () => {
  const db = abrir();
  importar(db, { buffer: planilla([[SG, '2026-08-24', 'ACELGA X ATADO', 200]]), nombre: 'a.xlsx' });

  // Un atado no tiene factor: sin kilos.
  assert.equal(db.prepare('SELECT kg_equiv k FROM share_lineas').get().k, null);

  // En Mapeos alguien determina que el atado pesa 0,4 kg.
  const id = db.prepare('SELECT id FROM share_articulos').get().id;
  db.prepare('UPDATE share_articulos SET factor_kg=0.4 WHERE id=?').run(id);
  recalcularKg(db, id);
  assert.equal(db.prepare('SELECT kg_equiv k FROM share_lineas').get().k, 80);

  // Y lo que se cargue después usa el factor corregido, no el del parseo.
  importar(db, { buffer: planilla([[SG, '2026-08-25', 'ACELGA X ATADO', 100]]), nombre: 'b.xlsx' });
  assert.equal(db.prepare("SELECT kg_equiv k FROM share_lineas WHERE fecha_entrega='2026-08-25'").get().k, 40);
});

test('analizar no escribe nada: es el preview', () => {
  const db = abrir();
  const a = analizar(db, { buffer: planilla(DIA24), nombre: 'PLANNING_24_08.xlsx' });
  assert.equal(a.filas, 4);
  assert.equal(a.bultos_total, 13000);
  assert.equal(a.articulos_nuevos.length, 3);
  assert.equal(a.proveedores_nuevos.length, 3);
  assert.equal(a.puede_cargar, true);
  // Ni una fila en la base.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_cargas').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM share_articulos').get().c, 0);
});

test('migrar familias: lo que quedó con la etiqueta vieja se reclasifica solo', () => {
  const db = abrir();
  importar(db, { buffer: planilla([
    [SG, '2026-08-24', 'PAPA BLANCA LAVADA X KG', 100],
    [SG, '2026-08-24', 'TOMATE REDONDO X KG', 100],
    [SG, '2026-08-24', 'CHAMPIGNON X 200 GRS', 100],
    [SG, '2026-08-24', 'MANZANA X KG', 100],
    [SG, '2026-08-24', 'LECHUGA X UNIDAD', 100],
  ]), nombre: 'a.xlsx' });

  // Se simula la base como quedó con la taxonomía vieja.
  const poner = (like, fam) => db.prepare('UPDATE share_articulos SET familia=? WHERE desc_canonica LIKE ?').run(fam, like);
  poner('PAPA%', 'VERDURA');
  poner('TOMATE%', 'VERDURA');
  poner('CHAMPIGNON%', 'HONGO');
  poner('MANZANA%', 'FRUTA');
  poner('LECHUGA%', 'HOJA');

  const r = reclasificarFamilias(db);
  const fam = (like) => db.prepare('SELECT familia f FROM share_articulos WHERE desc_canonica LIKE ?').get(like).f;

  // Las dos que eran VERDURA se parten según cómo se mueven.
  assert.equal(fam('PAPA%'), 'HORTALIZA PESADA');
  assert.equal(fam('TOMATE%'), 'HORTALIZA LIVIANA');
  // HONGO ya no existe como familia: cae en OTRO.
  assert.equal(fam('CHAMPIGNON%'), 'OTRO');
  // FRUTA y HOJA significan lo mismo en las dos taxonomías: no se tocan.
  assert.equal(fam('MANZANA%'), 'FRUTA');
  assert.equal(fam('LECHUGA%'), 'HOJA');
  assert.equal(r.migrados, 3, 'sólo las tres que estaban fuera del vocabulario nuevo');
});

test('migrar familias: correr diez veces es lo mismo que correr una', () => {
  const db = abrir();
  importar(db, { buffer: planilla([[SG, '2026-08-24', 'PAPA BLANCA X KG', 100]]), nombre: 'a.xlsx' });
  db.prepare("UPDATE share_articulos SET familia='VERDURA'").run();

  assert.equal(reclasificarFamilias(db).migrados, 1);
  for (let i = 0; i < 9; i++) assert.equal(reclasificarFamilias(db).migrados, 0, 'la corrida ' + (i + 2));
  assert.equal(db.prepare('SELECT familia f FROM share_articulos').get().f, 'HORTALIZA PESADA');
});

test('migrar familias: una corrección a mano NO se pisa', () => {
  const db = abrir();
  importar(db, { buffer: planilla([[SG, '2026-08-24', 'PAPA BLANCA X KG', 100]]), nombre: 'a.xlsx' });
  // Alguien decidió que esta papa va en OTRO. El clasificador diría HORTALIZA PESADA, pero
  // OTRO ya es una familia válida, así que la migración no la mira.
  db.prepare("UPDATE share_articulos SET familia='OTRO', pendiente_revision=0").run();
  assert.equal(reclasificarFamilias(db).migrados, 0);
  assert.equal(db.prepare('SELECT familia f FROM share_articulos').get().f, 'OTRO');
});
