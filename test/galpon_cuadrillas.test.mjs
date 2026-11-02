// ══ 👷 GALPÓN · DOS CUADRILLAS EN EL MISMO CAJÓN ══════════════════════════
//
// Andy, 2/11/2026: «que pueda elegir dos cuadrillas cosechando el mismo cajón.
// A veces pasa».
//
// Lo que se mide acá es PLATA: el corte por cuadrilla es con lo que se paga el
// jornal. Las tres maneras en que esto puede salir mal son todas calladas:
//
//   1. Los kilos enteros contados a las DOS. El total del día sigue cerrando
//      —lo suma de gal_volcados— pero el corte suma más kilos que los que
//      entraron al galpón, y nadie sabe cuál de los dos números vale.
//   2. Los kilos enteros a la PRIMERA y cero a la segunda. El total también
//      cierra, el corte también, y la segunda cuadrilla cobra menos.
//   3. El reparto que no se rehace al corregir los kilos. 700 corregido a 900
//      deja a cada una con 350: la pantalla muestra 900 arriba y 700 abajo.
//
// Lógica pura con node:sqlite, sin servidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  cuadrillasPedidas, nombreDeCuadrillas, cuadrillasDeVolcado,
  registrarVolcado, editarVolcado, borrarVolcado,
  volcadosDelDia, resumenDelDia, acumulado, ultimaCarga,
} from '../src/servicios/galpon.js';

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
                           activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca,activo) VALUES
      (10,'Cuadro 3','La Esperanza',1), (11,'Cuadro 4','La Esperanza',1);

    CREATE TABLE pa_cuadrillas (id INTEGER PRIMARY KEY, nombre TEXT, activo INTEGER DEFAULT 1);
    INSERT INTO pa_cuadrillas (id,nombre,activo) VALUES
      (1,'Norte',1), (2,'Sur',1), (3,'Este',1);

    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
    INSERT INTO gal_config (clave,valor) VALUES ('kg_max_carga','20000');

    CREATE TABLE gal_volcados (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE,
      fecha TEXT NOT NULL, hora TEXT,
      lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT,
      cuadrilla_id INTEGER, cuadrilla TEXT,
      kilos REAL NOT NULL, ifcos INTEGER, bruto REAL, tara REAL, tarjeta_id INTEGER,
      viaje INTEGER, sanitario TEXT, origen TEXT NOT NULL DEFAULT 'manual',
      observacion TEXT, estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT,
      usuario_id INTEGER, usuario TEXT, creado_en TEXT, eliminado_en TEXT);

    CREATE TABLE gal_volcado_cuadrillas (
      volcado_id INTEGER NOT NULL, cuadrilla_id INTEGER NOT NULL,
      cuadrilla TEXT, kilos REAL NOT NULL,
      PRIMARY KEY (volcado_id, cuadrilla_id));

    -- acumulado() le pega el rinde de cada lote, que sale de acá. La tabla tiene que
    -- existir aunque este archivo no cargue ni un proceso.
    CREATE TABLE gal_procesos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, fecha TEXT NOT NULL,
      lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT, destino TEXT NOT NULL,
      presentacion_id INTEGER, presentacion TEXT, envase TEXT, bultos REAL,
      por_bulto REAL, kg_unidad REAL, kilos REAL NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'ingreso', reparto TEXT, observacion TEXT,
      estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT,
      usuario_id INTEGER, usuario TEXT, creado_en TEXT, eliminado_en TEXT);
  `);
  return db;
}

const F = '2026-11-20';
const cargar = (db, d) => registrarVolcado(db, Object.assign({ fecha: F, lote_id: 10 }, d));

// ══════════════════════════════════════════════════════════════════════════
// 1 · QUÉ SE PUEDE PEDIR
// ══════════════════════════════════════════════════════════════════════════
test('una, dos, o ninguna — las tres formas entran por la misma puerta', () => {
  const db = base();
  assert.deepEqual(cuadrillasPedidas(db, { cuadrilla_ids: [1, 2] }).lista,
    [{ id: 1, nombre: 'Norte' }, { id: 2, nombre: 'Sur' }]);
  assert.deepEqual(cuadrillasPedidas(db, { cuadrilla_id: 2 }).lista, [{ id: 2, nombre: 'Sur' }]);
  assert.deepEqual(cuadrillasPedidas(db, {}).lista, []);
  assert.deepEqual(cuadrillasPedidas(db, { cuadrilla_id: '' }).lista, []);
  assert.deepEqual(cuadrillasPedidas(db, { cuadrilla_ids: [] }).lista, []);
});

test('UN cuadrilla_id SUELTO SIGUE ANDANDO: la cola de ayer tiene que entrar hoy', () => {
  // La cola sin señal guarda el CUERPO del pedido tal cual se armó. Una tanda
  // tipeada antes de esta versión y mandada después tiene cuadrilla_id y no
  // cuadrilla_ids: si dejara de entrar, esos kilos se pierden al sincronizar.
  const db = base();
  const r = cargar(db, { cuadrilla_id: 1, kilos: 400 });
  assert.equal(r.ok, true);
  assert.equal(r.fila.cuadrilla, 'Norte');
  /* Mapeado a valores: node:sqlite devuelve filas SIN prototipo y deepEqual las ve
     distintas de un objeto literal aunque tengan lo mismo adentro. */
  assert.deepEqual(cuadrillasDeVolcado(db, r.id).map((x) => [x.cuadrilla_id, x.cuadrilla, x.kilos]),
    [[1, 'Norte', 400]]);
});

test('la misma cuadrilla dos veces es UN clic de más, no un error', () => {
  // Dejarla pasar partiría los kilos en dos mitades para la MISMA cuadrilla y
  // la pantalla diría «Norte + Norte». Rechazarlo sería frenar una carga por
  // algo que se arregla solo.
  const db = base();
  const r = cargar(db, { cuadrilla_ids: [1, 1, '1'], kilos: 400 });
  assert.equal(r.ok, true);
  assert.equal(r.fila.cuadrilla, 'Norte');
  assert.equal(cuadrillasDeVolcado(db, r.id).length, 1);
  assert.equal(cuadrillasDeVolcado(db, r.id)[0].kilos, 400);
});

test('una cuadrilla que no existe se rechaza y dice cuál', () => {
  const db = base();
  const r = cargar(db, { cuadrilla_ids: [1, 99], kilos: 400 });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /99 no existe/);
  // Y no quedó la carga a medias.
  assert.equal(volcadosDelDia(db, F).length, 0);
});

test('EL NOMBRE SALE DE LA BASE, no del pedido', () => {
  // Dos pantallas con distinta versión del padrón escribirían dos nombres para
  // la misma cuadrilla, y el corte mostraría dos renglones.
  const db = base();
  const r = cargar(db, { cuadrilla_ids: [1, 2], cuadrilla: 'El Gerente', kilos: 400 });
  assert.equal(r.fila.cuadrilla, 'Norte + Sur');
  assert.equal(nombreDeCuadrillas([]), null);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL REPARTO
// ══════════════════════════════════════════════════════════════════════════
test('EL CAJÓN SE REPARTE EN PARTES IGUALES, y la suma cierra exacta', () => {
  const db = base();
  const r = cargar(db, { cuadrilla_ids: [1, 2], kilos: 701 });
  const q = cuadrillasDeVolcado(db, r.id);
  assert.equal(q.length, 2);
  assert.equal(q[0].kilos + q[1].kilos, 701,
    'el reparto no suma los kilos del cajón: aparecen kilos que nadie cosechó');
  // Y la fila madre NO se toca: el cajón pesa lo que pesa.
  assert.equal(r.fila.kilos, 701);
});

test('entre TRES también cierra, y el último se queda con el resto', () => {
  // Repartir 700 en tres y redondear cada parte da 699,99: la diferencia
  // aparecería como kilos sin atribuir en el corte.
  const db = base();
  const r = cargar(db, { cuadrilla_ids: [1, 2, 3], kilos: 700 });
  const q = cuadrillasDeVolcado(db, r.id);
  assert.equal(q.length, 3);
  assert.equal(q.reduce((t, x) => t + x.kilos, 0), 700);
});

test('la fila madre guarda la PRIMERA, no null', () => {
  // Dejarla en null haría que la carga aparezca «sin cuadrilla» en cualquier
  // pantalla o informe que lea gal_volcados sin saber de la tabla satélite.
  const db = base();
  const r = cargar(db, { cuadrilla_ids: [2, 1], kilos: 400 });
  assert.equal(r.fila.cuadrilla_id, 2);
  assert.equal(r.fila.cuadrilla, 'Sur + Norte');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL CORTE DEL DÍA
// ══════════════════════════════════════════════════════════════════════════
test('EL CORTE POR CUADRILLA NO CUENTA EL CAJÓN DOS VECES', () => {
  const db = base();
  cargar(db, { cuadrilla_ids: [1, 2], kilos: 700, ifcos: 2 });
  const r = resumenDelDia(db, F);
  assert.equal(r.kilos, 700);
  const suma = r.por_cuadrilla.reduce((t, x) => t + x.kilos, 0);
  assert.equal(suma, 700, 'el corte suma ' + suma + ' y al galpón entraron 700');
  assert.deepEqual(r.por_cuadrilla.map((x) => [x.nombre, x.kilos]).sort(),
    [['Norte', 350], ['Sur', 350]]);
  // Y los cajones tampoco: medio para cada una, no dos para cada una.
  assert.equal(r.por_cuadrilla.reduce((t, x) => t + x.ifcos, 0), 2);
});

test('lo compartido y lo propio se suman bien en el mismo día', () => {
  const db = base();
  cargar(db, { cuadrilla_ids: [1], kilos: 500 });
  cargar(db, { cuadrilla_ids: [1, 2], kilos: 300 });
  cargar(db, { cuadrilla_ids: [2], kilos: 100 });
  const r = resumenDelDia(db, F);
  assert.equal(r.kilos, 900);
  const por = {};
  r.por_cuadrilla.forEach((x) => { por[x.nombre] = x.kilos; });
  assert.deepEqual(por, { Norte: 650, Sur: 250 });
  assert.equal(r.por_cuadrilla[0].nombre, 'Norte', 'el corte no ordena por el total');
});

test('lo cargado SIN cuadrilla sigue apareciendo con sus kilos', () => {
  // Con un JOIN en vez de LEFT JOIN desaparecería del corte, y el corte
  // sumaría menos que el total — el error de siempre con la fruta sin atribuir.
  const db = base();
  cargar(db, { cuadrilla_ids: [1, 2], kilos: 200 });
  cargar(db, { kilos: 90, ifcos: 1 });
  const r = resumenDelDia(db, F);
  const sin = r.por_cuadrilla.filter((x) => x.cuadrilla_id == null)[0];
  assert.ok(sin, 'las cargas sin cuadrilla no aparecen en el corte');
  assert.match(sin.nombre, /sin cuadrilla/);
  assert.equal(sin.kilos, 90);
  assert.equal(sin.ifcos, 1);
  assert.equal(r.por_cuadrilla.reduce((t, x) => t + x.kilos, 0), 290);
});

test('UNA CARGA SIN FILA EN LA SATÉLITE SE CAE A SU PROPIA CUADRILLA', () => {
  /* Es el respaldo del COALESCE, y existe por la historia: toda la temporada
     que ya estaba cargada no tiene filas en la tabla nueva hasta que corre el
     relleno de db_galpon.js. Sin el respaldo aparecería entera como «sin
     cuadrilla» conservando sus kilos — y el total del día seguiría cerrando,
     así que no se notaría nunca. */
  const db = base();
  db.prepare('INSERT INTO gal_volcados (fecha,lote_id,lote_nombre,cuadrilla_id,cuadrilla,kilos,ifcos)'
    + " VALUES (?,10,'Cuadro 3',1,'Norte',450,3)").run(F);
  const r = resumenDelDia(db, F);
  assert.deepEqual(r.por_cuadrilla.map((x) => [x.nombre, x.kilos, x.ifcos]),
    [['Norte', 450, 3]]);
  const a = acumulado(db, null, null);
  assert.deepEqual(a.por_cuadrilla.map((x) => [x.nombre, x.kilos]), [['Norte', 450]]);
});

test('EL ACUMULADO PARTE EL CAJÓN IGUAL QUE EL DÍA', () => {
  // Dos cuentas del mismo número son dos lugares donde puede dar distinto, y
  // acá el que se mira a fin de temporada es éste.
  const db = base();
  cargar(db, { cuadrilla_ids: [1, 2], kilos: 700 });
  registrarVolcado(db, { fecha: '2026-11-21', lote_id: 11, cuadrilla_ids: [1], kilos: 300 });
  const a = acumulado(db, null, null);
  assert.equal(a.total.kilos, 1000);
  const por = {};
  a.por_cuadrilla.forEach((x) => { por[x.nombre] = x.kilos; });
  assert.deepEqual(por, { Norte: 650, Sur: 350 });
  assert.equal(Math.round(a.por_cuadrilla.reduce((t, x) => t + x.pct, 0)), 100);
  // Y los días de cada una se cuentan por su propio trabajo.
  assert.equal(a.por_cuadrilla.filter((x) => x.nombre === 'Norte')[0].dias, 2);
  assert.equal(a.por_cuadrilla.filter((x) => x.nombre === 'Sur')[0].dias, 1);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · CORREGIR
// ══════════════════════════════════════════════════════════════════════════
test('CORREGIR LOS KILOS REHACE EL REPARTO', () => {
  // Sin esto, 700 corregido a 900 deja a cada una con 350: la pantalla muestra
  // 900 arriba y el corte suma 700 abajo, los dos en la misma pantalla.
  const db = base();
  const r = cargar(db, { cuadrilla_ids: [1, 2], kilos: 700 });
  editarVolcado(db, r.id, { kilos: 900 });
  const q = cuadrillasDeVolcado(db, r.id);
  assert.deepEqual(q.map((x) => x.kilos), [450, 450]);
  assert.equal(resumenDelDia(db, F).por_cuadrilla.reduce((t, x) => t + x.kilos, 0), 900);
});

test('corregir los kilos NO borra las cuadrillas', () => {
  const db = base();
  const r = cargar(db, { cuadrilla_ids: [1, 2], kilos: 700 });
  const e = editarVolcado(db, r.id, { kilos: 800 });
  assert.equal(e.fila.cuadrilla, 'Norte + Sur');
  assert.equal(e.fila.cuadrillas.length, 2);
});

test('cambiar la lista saca a la que ya no está', () => {
  const db = base();
  const r = cargar(db, { cuadrilla_ids: [1, 2], kilos: 700 });
  editarVolcado(db, r.id, { cuadrilla_ids: [3] });
  assert.deepEqual(cuadrillasDeVolcado(db, r.id).map((x) => [x.cuadrilla_id, x.cuadrilla, x.kilos]),
    [[3, 'Este', 700]]);
  assert.equal(resumenDelDia(db, F).por_cuadrilla.length, 1);
});

test('mandar la lista vacía la deja sin cuadrilla, y no quedan restos', () => {
  const db = base();
  const r = cargar(db, { cuadrilla_ids: [1, 2], kilos: 700 });
  editarVolcado(db, r.id, { cuadrilla_ids: [] });
  assert.deepEqual(cuadrillasDeVolcado(db, r.id), []);
  const res = resumenDelDia(db, F);
  assert.equal(res.por_cuadrilla.length, 1);
  assert.match(res.por_cuadrilla[0].nombre, /sin cuadrilla/);
  assert.equal(res.por_cuadrilla[0].kilos, 700);
});

test('BORRAR LA CARGA NO BORRA EL REPARTO, pero la saca del corte', () => {
  // El reparto cuelga de la fila madre y el corte la une con un JOIN que ya
  // filtra eliminado_en. Borrarlo sería perder a quién se le habían anotado
  // esos kilos, que es lo que un borrado blando conserva.
  const db = base();
  const r = cargar(db, { cuadrilla_ids: [1, 2], kilos: 700 });
  assert.equal(borrarVolcado(db, r.id, { hoy: F }).ok, true);
  assert.equal(resumenDelDia(db, F).por_cuadrilla.length, 0);
  assert.equal(cuadrillasDeVolcado(db, r.id).length, 2);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LO QUE LEE LA PANTALLA
// ══════════════════════════════════════════════════════════════════════════
test('cada renglón del día viene con sus cuadrillas', () => {
  const db = base();
  cargar(db, { cuadrilla_ids: [1, 2], kilos: 700 });
  cargar(db, { kilos: 100 });
  const l = volcadosDelDia(db, F);
  assert.equal(l.length, 2);
  const conDos = l.filter((x) => x.cuadrillas.length === 2)[0];
  assert.ok(conDos, 'el renglón compartido no trae sus dos cuadrillas');
  assert.deepEqual(conDos.cuadrillas.map((x) => x.cuadrilla), ['Norte', 'Sur']);
  assert.deepEqual(l.filter((x) => x.kilos === 100)[0].cuadrillas, []);
});

test('LO ÚLTIMO QUE SE CARGÓ PROPONE LAS DOS, no una', () => {
  // Proponer sólo la primera arranca la tanda siguiente con la mitad del
  // equipo, y el que aprieta Empezar no tiene cómo notarlo: la cuadrilla que
  // aparece es una de las que estaban.
  const db = base();
  cargar(db, { cuadrilla_ids: [1, 2], kilos: 700, usuario_id: 5 });
  const u = ultimaCarga(db, F, 5);
  assert.deepEqual(u.cuadrilla_ids, [1, 2]);
  assert.equal(u.cuadrilla, 'Norte + Sur');
});

test('el mismo uuid dos veces devuelve la fila con su reparto, no una segunda', () => {
  const db = base();
  const a = cargar(db, { uuid: 'u-1', cuadrilla_ids: [1, 2], kilos: 700 });
  const b = cargar(db, { uuid: 'u-1', cuadrilla_ids: [1, 2], kilos: 700 });
  assert.equal(b.repetido, true);
  assert.equal(b.id, a.id);
  assert.equal(b.fila.cuadrillas.length, 2);
  assert.equal(resumenDelDia(db, F).kilos, 700);
  assert.equal(resumenDelDia(db, F).por_cuadrilla.reduce((t, x) => t + x.kilos, 0), 700);
});
