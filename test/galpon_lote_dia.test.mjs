// ══ 🗓️ GALPÓN · EL LOTE DEL DÍA ══════════════════════════════════════════
//
// Qué se está cosechando y desde qué hora. Es la pregunta que el volcado hace
// por cada IFCO, así que lo que se clava acá no es que la pantalla se vea: es
// que la respuesta sea la misma mirada desde la pantalla, desde el servidor y
// desde un informe de marzo.
//
// Cuatro cosas que fallan CALLADAS y que por eso tienen su test:
//
//   1. La hora sin el cero adelante. '9:00' > '14:30' comparando texto, que es
//      lo que hace SQLite, y el lote de la mañana se vuelve el de la tarde. En
//      pantalla se ve idéntico.
//   2. Dos tramos a la misma hora. El segundo le gana al primero y el primero
//      queda listado, visible, sin atribuir un kilo.
//   3. El hueco de la mañana. El que carga a las ocho pone las ocho, y el IFCO
//      de las 6:40 se queda sin lote.
//   4. Corregir un tramo que ya tiene volcados. No los arregla —cada uno
//      congeló su lote— y los deja apuntando a algo que nadie declaró.
//
// Acá va la lógica, con node:sqlite y sin servidor: corre siempre, sin depender
// de un solo paquete. El router levantado de verdad está al lado, en
// test/galpon_lote_dia_router.test.mjs, que sí necesita express.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  hhmm, esFecha, tramoChoca, huecoDelDia, tramosDelDia, lotesParaElDia,
  volcadosEnTramo, loteVigente,
} from '../src/servicios/galpon.js';

// ── UNA BASE CON LO QUE EL GALPÓN LEE DE OTROS MÓDULOS ────────────────────
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sociedades (id INTEGER PRIMARY KEY, nombre TEXT);
    INSERT INTO sociedades (id,nombre) VALUES (7,'Puente Cordón SA'), (9,'San Gerónimo SA');

    CREATE TABLE pa_sectores (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT);
    INSERT INTO pa_sectores (id,nombre,tipo) VALUES
      (1,'Frutales','frutales'), (2,'Chacra','chacra_mercado');

    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, sector_id INTEGER,
                           finca TEXT, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,sector_id,finca,activo) VALUES
      (10,'Cuadro 3',1,'La Esperanza',1),
      (11,'Cuadro 4',1,'La Esperanza',1),
      (12,'Cuadro 1',1,'Alto Verde',1),
      (13,'Arrancado', 1,'Alto Verde',0);

    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY, lote_id INTEGER, cultivo TEXT,
                                   campaña TEXT, es_perenne INTEGER DEFAULT 0);
    INSERT INTO pa_cultivos_lote (lote_id,cultivo,campaña,es_perenne) VALUES
      (10,'Damasco','2026/27',1),
      (11,'Zapallo','2025/26',0),
      (11,'Tomate','2026/27',0);

    CREATE TABLE pa_cuadrillas (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT,
                                activo INTEGER DEFAULT 1);
    INSERT INTO pa_cuadrillas (id,nombre,tipo,activo) VALUES (1,'Norte','fija',1);

    CREATE TABLE gal_lote_vigente (
      id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL,
      desde_hora TEXT NOT NULL DEFAULT '00:00', lote_id INTEGER NOT NULL,
      lote_nombre TEXT, producto TEXT, usuario_id INTEGER, usuario TEXT,
      creado_en TEXT DEFAULT (datetime('now','localtime')));
  `);
  return db;
}
const tramo = (db, fecha, hora, loteId, nombre) => db.prepare(
  'INSERT INTO gal_lote_vigente (fecha,desde_hora,lote_id,lote_nombre) VALUES (?,?,?,?)')
  .run(fecha, hora, loteId, nombre || ('Lote ' + loteId));

// ══════════════════════════════════════════════════════════════════════════
// 1 · LA HORA, QUE ES UNA COMPARACIÓN DE TEXTO
// ══════════════════════════════════════════════════════════════════════════
test('la hora se guarda con el cero adelante', () => {
  assert.equal(hhmm('9:00'), '09:00');
  assert.equal(hhmm('09:00'), '09:00');
  assert.equal(hhmm(' 7:05 '), '07:05');
  assert.equal(hhmm('14:30:59'), '14:30');
});

test('y una hora que no existe no se guarda a medias', () => {
  for (const v of ['', null, undefined, 'mañana', '25:00', '12:70', '8', '8:0', '::']) {
    assert.equal(hhmm(v), null, 'aceptó ' + JSON.stringify(v));
  }
});

test('SIN EL CERO, EL LOTE DE LA MAÑANA SE VUELVE EL DE LA TARDE', () => {
  // Éste es el bug que la normalización evita, demostrado: SQLite compara
  // `desde_hora <= ?` como TEXTO, y '9:00' > '14:30' porque '9' > '1'.
  //
  // Se escribe a mano lo que el router nunca escribiría, para que se vea que el
  // daño es real y no una precaución de más.
  const roto = base();
  tramo(roto, '2026-11-20', '9:00', 10, 'Mañana');     // sin el cero, a propósito
  tramo(roto, '2026-11-20', '14:30', 11, 'Tarde');

  // El tramo de las 9 está cargado y se ve en la lista. Y NO VALE NUNCA: a las
  // diez de la mañana no hay lote, porque '9:00' <= '10:00' es falso comparando
  // texto. Toda la fruta de la mañana entra sin lote al que atribuirla.
  const alas10 = loteVigente(roto, '2026-11-20', '10:00');
  assert.equal(alas10.ok, false,
    'si esto cambió, el bug dejó de existir y este test ya no prueba nada');
  assert.equal(roto.prepare('SELECT COUNT(*) AS n FROM gal_lote_vigente').get().n, 2,
    'el tramo está guardado y visible: por eso nadie se entera');

  // Con el cero puesto —que es lo que hace hhmm()— contesta lo que corresponde.
  const ok = base();
  tramo(ok, '2026-11-20', hhmm('9:00'), 10, 'Mañana');
  tramo(ok, '2026-11-20', hhmm('14:30'), 11, 'Tarde');
  assert.equal(loteVigente(ok, '2026-11-20', '10:00').lote_nombre, 'Mañana');
  assert.equal(loteVigente(ok, '2026-11-20', '16:00').lote_nombre, 'Tarde');
});

test('la fecha tiene que ser una fecha', () => {
  assert.equal(esFecha('2026-11-20'), '2026-11-20');
  assert.equal(esFecha('2026-11-20T08:00:00'), '2026-11-20');
  for (const v of ['', null, '20/11/2026', '2026-13', 'hoy']) assert.equal(esFecha(v), null);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · DOS TRAMOS A LA MISMA HORA
// ══════════════════════════════════════════════════════════════════════════
test('DOS LOTES A LA MISMA HORA SE DETECTAN ANTES DE ESCRIBIR', () => {
  const db = base();
  tramo(db, '2026-11-20', '08:00', 10, 'Cuadro 3');
  const choca = tramoChoca(db, '2026-11-20', '08:00');
  assert.ok(choca, 'no detectó el choque');
  assert.equal(choca.lote_nombre, 'Cuadro 3', 'no dice con cuál se pisa');
});

test('otra hora, u otro día, no chocan', () => {
  const db = base();
  tramo(db, '2026-11-20', '08:00', 10);
  assert.equal(tramoChoca(db, '2026-11-20', '08:01'), null);
  assert.equal(tramoChoca(db, '2026-11-21', '08:00'), null);
});

test('y corregir un tramo no choca CONSIGO MISMO', () => {
  const db = base();
  const id = Number(tramo(db, '2026-11-20', '08:00', 10).lastInsertRowid);
  assert.equal(tramoChoca(db, '2026-11-20', '08:00', id), null);
  // pero sí con el de al lado
  tramo(db, '2026-11-20', '13:00', 11);
  assert.ok(tramoChoca(db, '2026-11-20', '13:00', id));
});

test('el choque se busca con la hora YA normalizada', () => {
  // Si tramoChoca comparara el texto crudo, '9:00' no encontraría al '09:00' que
  // está guardado y entrarían los dos.
  const db = base();
  tramo(db, '2026-11-20', '09:00', 10);
  assert.ok(tramoChoca(db, '2026-11-20', '9:00'), 'no normalizó la hora antes de buscar');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL HUECO DE LA MAÑANA
// ══════════════════════════════════════════════════════════════════════════
test('un día que arranca a las 00:00 no tiene hueco', () => {
  const db = base();
  tramo(db, '2026-11-20', '00:00', 10);
  tramo(db, '2026-11-20', '13:30', 11);
  assert.equal(huecoDelDia(db, '2026-11-20'), null);
});

test('UN DÍA QUE ARRANCA A LAS 08:00 DEJA LA MAÑANA SIN LOTE, y se avisa', () => {
  const db = base();
  tramo(db, '2026-11-20', '08:00', 10);
  assert.deepEqual(huecoDelDia(db, '2026-11-20'), { desde_hora: '08:00' });
  // Y es un problema de verdad, no una formalidad: el IFCO de las 6:40 no tiene lote.
  assert.equal(loteVigente(db, '2026-11-20', '06:40').ok, false);
});

test('un día sin nada cargado no reporta hueco: reporta que no hay nada', () => {
  // Son dos cosas distintas y la pantalla las muestra distinto. Un "hueco de las
  // 00:00 a las 00:00" sería ruido arriba de un día vacío.
  const db = base();
  assert.equal(huecoDelDia(db, '2026-11-20'), null);
  assert.equal(loteVigente(db, '2026-11-20', '10:00').ok, false);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LOS TRAMOS CON SU HORA DE FIN
// ══════════════════════════════════════════════════════════════════════════
test('cada tramo termina donde arranca el siguiente, y el último no termina', () => {
  const db = base();
  tramo(db, '2026-11-20', '00:00', 10, 'A');
  tramo(db, '2026-11-20', '10:15', 11, 'B');
  tramo(db, '2026-11-20', '14:30', 12, 'C');
  const t = tramosDelDia(db, '2026-11-20');
  assert.deepEqual(t.map((x) => [x.lote_nombre, x.desde_hora, x.hasta_hora]), [
    ['A', '00:00', '10:15'],
    ['B', '10:15', '14:30'],
    ['C', '14:30', null],
  ]);
});

test('la hora de fin NO se guarda: se deriva', () => {
  // Guardarla sería guardar dos veces el mismo dato y poder contradecirse — un
  // tramo que dice terminar a las 14:00 con el siguiente arrancando a las 13:00.
  const db = base();
  tramo(db, '2026-11-20', '08:00', 10);
  const cols = db.prepare('PRAGMA table_info(gal_lote_vigente)').all().map((c) => c.name);
  assert.ok(!cols.includes('hasta_hora'), 'la hora de fin se guardó en la base');
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LOS LOTES ENTRE LOS QUE SE ELIGE
// ══════════════════════════════════════════════════════════════════════════
test('los lotes salen de Producción, y el arrancado no aparece', () => {
  const l = lotesParaElDia(base());
  assert.deepEqual(l.map((x) => x.nombre).sort(), ['Cuadro 1', 'Cuadro 3', 'Cuadro 4']);
});

test('vienen agrupables por finca y en orden', () => {
  const l = lotesParaElDia(base());
  assert.deepEqual(l.map((x) => x.finca + '/' + x.nombre),
    ['Alto Verde/Cuadro 1', 'La Esperanza/Cuadro 3', 'La Esperanza/Cuadro 4']);
});

test('EL CULTIVO QUE SE PROPONE ES EL PERENNE, no el de la campaña que esté activa', () => {
  // Hay DOS campañas activas a la vez (una anual y una estacional), así que
  // `WHERE activa = 1 LIMIT 1` devuelve una de las dos según el humor del
  // planificador. Un frutal es perenne y su cultivo no cambia de campaña.
  const l = lotesParaElDia(base());
  const c3 = l.find((x) => x.nombre === 'Cuadro 3');
  assert.equal(c3.cultivo, 'Damasco');
});

test('y entre los no perennes, el de la campaña más nueva', () => {
  const l = lotesParaElDia(base());
  assert.equal(l.find((x) => x.nombre === 'Cuadro 4').cultivo, 'Tomate');
});

test('un lote sin cultivo cargado no rompe la lista', () => {
  const l = lotesParaElDia(base());
  assert.equal(l.find((x) => x.nombre === 'Cuadro 1').cultivo, null);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · ¿YA SE VOLCÓ ALGO CONTRA ESTE TRAMO?
// ══════════════════════════════════════════════════════════════════════════
function conVolcados(db, filas) {
  db.exec('CREATE TABLE gal_volcados (id INTEGER PRIMARY KEY, volcado_en TEXT)');
  for (const f of filas) db.prepare('INSERT INTO gal_volcados (volcado_en) VALUES (?)').run(f);
  return db;
}

test('MIENTRAS NO EXISTA EL VOLCADO devuelve null, que no es lo mismo que cero', () => {
  // null = «todavía no hay dónde mirar»; 0 = «miré y no hay». La pantalla usa la
  // diferencia para no poner un candado donde no hay nada que proteger.
  assert.equal(volcadosEnTramo(base(), '2026-11-20', '00:00', null), null);
});

test('cuenta sólo lo que cayó DENTRO de la ventana del tramo', () => {
  const db = conVolcados(base(), [
    '2026-11-20 07:30:00',   // antes
    '2026-11-20 08:00:00',   // justo al empezar: adentro
    '2026-11-20 11:00:00',   // adentro
    '2026-11-20 13:30:00',   // justo al empezar el siguiente: AFUERA
    '2026-11-20 15:00:00',   // después
    '2026-11-21 11:00:00',   // otro día
  ]);
  assert.equal(volcadosEnTramo(db, '2026-11-20', '08:00', '13:30'), 2);
});

test('el último tramo del día llega hasta el final', () => {
  const db = conVolcados(base(), ['2026-11-20 14:00:00', '2026-11-20 23:50:00']);
  assert.equal(volcadosEnTramo(db, '2026-11-20', '13:30', null), 2);
});
