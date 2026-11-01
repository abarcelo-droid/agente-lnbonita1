// ══ 📦 GALPÓN · EL PROCESO ═══════════════════════════════════════════════
//
// Andy, 31/10/2026: «quiero un lugar para cargar el proceso... por ejemplo 100
// cajas cartón x 10 cubetas de 700 gramos cada una».
//
// gal_volcados es lo que ENTRÓ; gal_procesos es lo que SALIÓ. Las dos juntas
// son el rinde, que es con lo que se decide si un cuadro se sigue cosechando.
// O sea: un número mal acá se convierte en una decisión de plantación.
//
// Lo que falla CALLADO, y por eso tiene test:
//
//   1. LA CUENTA LA HACE EL CLIENTE. 100 × 10 × 0,7 calculado en el navegador
//      y creído por el servidor hace que el rinde dependa de qué pestaña
//      estaba abierta. Acá la hace el backend con la presentación de la base.
//   2. GRAMOS DONDE VAN KILOS. Una presentación con 700 en vez de 0,7 pasa
//      cien cajas de 700 kg a 700.000. Es el cero de más de esta pantalla.
//   3. A GRANEL CON BULTOS. Un bin que trae bultos en el pedido y además
//      multiplica da un número plausible y mil veces más grande.
//   4. EL DOBLE CLIC. Dos filas iguales son cajas contadas dos veces.
//   5. UN PATCH QUE PISA CON NULL. Corregir los bultos borraría el lote.
//   6. EL STOCK GUARDADO EN SU PROPIA FILA. Se desincroniza en silencio la
//      primera vez que alguien corrige una carga vieja — que acá es el caso
//      normal. Por eso es derivado, y hay test de que lo sigue siendo.
//
// Lógica pura con node:sqlite y sin servidor: corre siempre.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  DESTINOS, presentaciones, guardarPresentacion, borrarPresentacion,
  kilosDeProceso, registrarProceso, editarProceso, borrarProceso,
  procesosDelDia, tableroProceso, stockGalpon, rindePorLote, lotesVolcados,
  fincasDeLotes,
  pesosDelReparto, repartir, idsDeLotes,
} from '../src/servicios/galpon.js';

const F = '2026-11-20';

function base(techo = '50000') {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
                           activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca) VALUES
      (10,'Cuadro 3','La Esperanza'), (11,'Cuadro 4','La Esperanza');

    -- El proceso congela el PRODUCTO desde el cultivo del lote, igual que el nombre.

    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER,

                                   cultivo TEXT, campaña TEXT, es_perenne INTEGER DEFAULT 0);

    INSERT INTO pa_cultivos_lote (lote_id,cultivo,campaña,es_perenne) VALUES

      (10,'Damasco','2026/27',1), (11,'Damasco','2026/27',1);

    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);

    CREATE TABLE gal_volcados (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, fecha TEXT NOT NULL,
      hora TEXT, lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT,
      cuadrilla_id INTEGER, cuadrilla TEXT, kilos REAL NOT NULL, ifcos INTEGER,
      estado TEXT NOT NULL DEFAULT 'ok', eliminado_en TEXT);

    CREATE TABLE gal_presentaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, destino TEXT NOT NULL,
      envase TEXT, por_bulto REAL NOT NULL DEFAULT 1, kg_unidad REAL NOT NULL DEFAULT 1,
      granel INTEGER NOT NULL DEFAULT 0, color TEXT, orden INTEGER NOT NULL DEFAULT 100,
      activo INTEGER NOT NULL DEFAULT 1, creado_en TEXT, eliminado_en TEXT);

    CREATE TABLE gal_procesos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, fecha TEXT NOT NULL,
      lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT, destino TEXT NOT NULL,
      presentacion_id INTEGER, presentacion TEXT, envase TEXT,
      bultos REAL, por_bulto REAL, kg_unidad REAL, kilos REAL NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'ingreso', reparto TEXT, repartido INTEGER NOT NULL DEFAULT 0, observacion TEXT,
      estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT,
      usuario_id INTEGER, usuario TEXT, creado_en TEXT, eliminado_en TEXT);
  `);
  db.prepare('INSERT INTO gal_config (clave,valor) VALUES (?,?)').run('kg_max_proceso', techo);
  return db;
}

const volcar = (db, kg, lote = 10, fecha = F) => db.prepare(
  'INSERT INTO gal_volcados (fecha,lote_id,lote_nombre,producto,kilos) VALUES (?,?,?,?,?)')
  .run(fecha, lote, lote === 10 ? 'Cuadro 3' : 'Cuadro 4', 'Damasco', kg);

// El ejemplo exacto que dio Andy, más un bin de cada cosa.
function conCatalogo(db) {
  const caja = guardarPresentacion(db, { nombre: 'Caja cartón · 10 × 700 g',
    destino: 'comercial', envase: 'Caja cartón', por_bulto: 10, kg_unidad: 0.7 });
  const verde = guardarPresentacion(db, { nombre: 'Bin de verde', destino: 'verde',
    envase: 'Bin', granel: 1 });
  const desc = guardarPresentacion(db, { nombre: 'Bin de descarte', destino: 'descarte',
    envase: 'Bin', granel: 1 });
  return { caja: caja.id, verde: verde.id, desc: desc.id };
}

// ══════════════════════════════════════════════════════════════════════════
// 1 · LOS TRES DESTINOS
// ══════════════════════════════════════════════════════════════════════════
test('son TRES y son fijos, no texto libre', () => {
  // Cada uno tiene un futuro distinto: lo comercial se vende, lo verde vuelve
  // a la tolva, el descarte se remata o se tira. Texto libre serían cuarenta
  // maneras de escribir «segunda» y ningún informe posible.
  assert.deepEqual(DESTINOS.map((d) => d.clave), ['comercial', 'verde', 'descarte']);
  for (const d of DESTINOS) {
    assert.ok(d.label && d.color && d.nota, 'al destino ' + d.clave + ' le falta algo');
  }
});

test('una presentación con un destino inventado no entra', () => {
  const db = base();
  for (const mal of ['segunda', '', null, 'COMERCIAL ', 'exportacion']) {
    const r = guardarPresentacion(db, { nombre: 'X', destino: mal });
    assert.equal(r.ok, false, 'aceptó el destino ' + JSON.stringify(mal));
  }
  assert.equal(guardarPresentacion(db, { nombre: 'X', destino: 'verde', granel: 1 }).ok, true);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LA CUENTA
// ══════════════════════════════════════════════════════════════════════════
test('100 CAJAS × 10 CUBETAS × 700 g SON 700 KILOS', () => {
  // El ejemplo textual de Andy. Si esta cuenta se mueve, se mueve el rinde de
  // toda la temporada y no hay ningún cartel que lo diga.
  assert.equal(kilosDeProceso(100, 10, 0.7), 700);
  assert.equal(kilosDeProceso(1, 10, 0.7), 7);
  assert.equal(kilosDeProceso(12, 12, 0.5), 72);
});

test('LA CUENTA LA HACE EL SERVIDOR, no se cree la que llega', () => {
  // Un total calculado por el navegador hace que el rinde dependa de qué
  // pestaña estaba abierta, y de qué versión del catálogo tenía cargada.
  const db = base();
  const p = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja,
    bultos: 100, kilos: 999999, por_bulto: 7777, kg_unidad: 55, uuid: 'a' });
  assert.equal(r.ok, true);
  assert.equal(r.fila.kilos, 700);
  assert.equal(r.fila.por_bulto, 10);
  assert.equal(r.fila.kg_unidad, 0.7);
});

test('el destino y el envase también salen de la presentación', () => {
  // Mandarlos en el cuerpo dejaría entrar una caja de 700 g como descarte.
  const db = base();
  const p = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja,
    bultos: 10, destino: 'descarte', envase: 'Bin', uuid: 'a' });
  assert.equal(r.fila.destino, 'comercial');
  assert.equal(r.fila.envase, 'Caja cartón');
  assert.equal(r.fila.presentacion, 'Caja cartón · 10 × 700 g');
});

test('A GRANEL NO MULTIPLICA: los bultos que lleguen se ignoran', () => {
  // Un bin se pesa entero. Si además multiplicara por los bultos del pedido,
  // el número saldría plausible y mil veces más grande.
  const db = base();
  const p = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.verde,
    kilos: 300, bultos: 99, por_bulto: 50, uuid: 'a' });
  assert.equal(r.fila.kilos, 300);
  assert.equal(r.fila.bultos, null);
  assert.equal(r.fila.por_bulto, null);
});

test('una presentación a granel se guarda SIN multiplicadores fantasma', () => {
  // Un por_bulto distinto de 1 en algo a granel no se ve en ninguna pantalla
  // y aparecería en el total el día que deje de ser a granel.
  const db = base();
  const r = guardarPresentacion(db, { nombre: 'Bin', destino: 'verde', granel: 1,
    por_bulto: 40, kg_unidad: 25 });
  const g = presentaciones(db).filter((x) => x.id === r.id)[0];
  assert.equal(g.por_bulto, 1);
  assert.equal(g.kg_unidad, 1);
});

test('los números se leen como en el resto del galpón', () => {
  const db = base();
  const p = guardarPresentacion(db, { nombre: 'C', destino: 'comercial',
    por_bulto: 10, kg_unidad: '0,7' });
  assert.equal(presentaciones(db).filter((x) => x.id === p.id)[0].kg_unidad, 0.7);
  conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10,
    presentacion_id: presentaciones(db).filter((x) => x.granel && x.destino === 'verde')[0].id,
    kilos: '1.250', uuid: 'a' });
  assert.equal(r.fila.kilos, 1250, '«1.250» se leyó como uno y cuarto');
});

test('una cuenta que no cierra no entra a medias', () => {
  const db = base();
  const p = conCatalogo(db);
  for (const mal of ['', null, 0, -5, 'muchas']) {
    const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja,
      bultos: mal, uuid: 'x' + mal });
    assert.equal(r.ok, false, 'aceptó bultos = ' + JSON.stringify(mal));
  }
  assert.equal(procesosDelDia(db, F).length, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL CERO DE MÁS, QUE ACÁ TIENE FORMA DE GRAMOS
// ══════════════════════════════════════════════════════════════════════════
test('700 DONDE VAN 0,7 SE MARCA, Y LA CARGA ENTRA IGUAL', () => {
  // Cien cajas de diez cubetas pasan de 700 kg a 700.000. La carga entra —lo
  // que ya se embaló, se embaló— y queda marcada: un techo que frena es un
  // techo que alguien esquiva partiendo el renglón en dos.
  const db = base('50000');
  const mala = guardarPresentacion(db, { nombre: 'Caja mal cargada', destino: 'comercial',
    por_bulto: 10, kg_unidad: 700 });
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: mala.id,
    bultos: 100, uuid: 'a' });
  assert.equal(r.ok, true, 'rechazó la carga en vez de marcarla');
  assert.equal(r.fila.kilos, 700000);
  assert.equal(r.fila.estado, 'a_revisar');
  assert.match(r.fila.revision_motivo, /gramos/);
  assert.equal(procesosDelDia(db, F).length, 1);
});

test('con el techo en 0 no se marca nada', () => {
  const db = base('0');
  const p = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.verde,
    kilos: 9999999, uuid: 'a' });
  assert.equal(r.fila.estado, 'ok');
});

test('CORREGIR PARA ABAJO SACA LA MARCA', () => {
  // Si sólo se mirara hacia arriba, la fila quedaría en rojo para siempre
  // después de arreglada — y el contador de «para revisar» dejaría de servir.
  const db = base('5000');
  const p = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.verde,
    kilos: 9000, uuid: 'a' });
  assert.equal(r.fila.estado, 'a_revisar');
  const e = editarProceso(db, r.id, { kilos: 900 });
  assert.equal(e.fila.estado, 'ok');
  assert.equal(e.fila.revision_motivo, null);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · EL DOBLE CLIC
// ══════════════════════════════════════════════════════════════════════════
test('DOS VECES EL MISMO uuid ES UNA SOLA CARGA', () => {
  const db = base();
  const p = conCatalogo(db);
  const a = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja,
    bultos: 100, uuid: 'mismo' });
  const b = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja,
    bultos: 100, uuid: 'mismo' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, 'el doble clic devolvió un error en vez de no hacer nada');
  assert.equal(b.repetido, true);
  assert.equal(b.id, a.id);
  assert.equal(procesosDelDia(db, F).length, 1);
  assert.equal(tableroProceso(db, F, 10).procesado, 700);
});

test('sin uuid cada carga es una carga (dos cajas iguales existen)', () => {
  const db = base();
  const p = conCatalogo(db);
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja, bultos: 100 });
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja, bultos: 100 });
  assert.equal(procesosDelDia(db, F).length, 2);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · CORREGIR Y BORRAR
// ══════════════════════════════════════════════════════════════════════════
test('CORREGIR LOS BULTOS NO BORRA LO QUE NO VINO', () => {
  // Un PATCH que pise con null lo que no mandaron convierte «corregí 100 por
  // 90» en «y de paso perdé el lote y la observación».
  const db = base();
  const p = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja,
    bultos: 100, observacion: 'turno tarde', uuid: 'a', usuario: 'Andy' });
  const e = editarProceso(db, r.id, { bultos: 90 });
  assert.equal(e.fila.kilos, 630, 'no recalculó los kilos con la cuenta de la presentación');
  assert.equal(e.fila.bultos, 90);
  assert.equal(e.fila.observacion, 'turno tarde');
  assert.equal(e.fila.lote_id, 10);
  assert.equal(e.fila.presentacion, 'Caja cartón · 10 × 700 g');
  assert.equal(e.fila.usuario, 'Andy');
});

test('a una carga por bultos no se le tipean los kilos por la ventana', () => {
  // Si se pudieran mandar sueltos, los kilos dejarían de ser bultos × cuenta y
  // la fila mentiría sobre sí misma: 100 cajas de 7 kg sumando 50.
  const db = base();
  const p = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja,
    bultos: 100, uuid: 'a' });
  const e = editarProceso(db, r.id, { kilos: 50 });
  assert.equal(e.fila.kilos, 700, 'dejó pisar los kilos de una carga por bultos');
});

test('borrar es blando y deja de contar en todos lados', () => {
  const db = base();
  volcar(db, 5000);
  const p = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja,
    bultos: 100, uuid: 'a' });
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.verde,
    kilos: 300, uuid: 'b' });
  assert.equal(borrarProceso(db, r.id).ok, true);
  assert.equal(borrarProceso(db, r.id).ok, false, 'se borró dos veces');

  assert.equal(procesosDelDia(db, F).length, 1);
  assert.equal(tableroProceso(db, F, 10).procesado, 300);
  assert.equal(stockGalpon(db).kilos, 300);
  assert.equal(rindePorLote(db, '2026-11-01', '2026-11-30')[0].comercial, 0);
  // Pero la fila sigue en la base: un renglón de kilos borrado de verdad es un
  // rinde que después no se puede auditar.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gal_procesos').get().n, 2);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · EL TABLERO DEL LOTE
// ══════════════════════════════════════════════════════════════════════════
test('el tablero mira TODO el volcado del lote, no sólo el de hoy', () => {
  // La fruta que entró el martes se procesa el jueves. Un tablero que cortara
  // por día diría que se procesó de más, todos los días.
  const db = base();
  volcar(db, 3000, 10, '2026-11-18');
  volcar(db, 2000, 10, '2026-11-19');
  const p = conCatalogo(db);
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja, bultos: 100, uuid: 'a' });
  const t = tableroProceso(db, F, 10);
  assert.equal(t.volcado, 5000);
  assert.equal(t.procesado, 700);
  assert.equal(t.sin_procesar, 4300);
  assert.equal(t.rinde, 14);
  assert.equal(t.de_mas, false);
});

test('PROCESAR MÁS DE LO VOLCADO SE MUESTRA, no se tapa en cero', () => {
  // Es la señal de que la atribución al lote se corrió —la tolva mezcla— y
  // taparla con un Math.max(0, …) esconde el único aviso que hay.
  const db = base();
  volcar(db, 500);
  const p = conCatalogo(db);
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.verde,
    kilos: 900, uuid: 'a' });
  const t = tableroProceso(db, F, 10);
  assert.equal(t.sin_procesar, -400);
  assert.equal(t.de_mas, true);
});

test('un lote sin nada todavía no rompe el tablero', () => {
  const db = base();
  const t = tableroProceso(db, F, 10);
  assert.equal(t.volcado, 0);
  assert.equal(t.procesado, 0);
  assert.equal(t.rinde, null, 'dividió por cero');
  for (const d of DESTINOS) assert.equal(t.destinos[d.clave], 0);
  assert.deepEqual(tableroProceso(db, F, null).destinos, {});
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · EL STOCK, QUE ES DERIVADO
// ══════════════════════════════════════════════════════════════════════════
test('EL STOCK SE SUMA DE LAS CARGAS, no hay tabla de saldos', () => {
  // Por eso corregir una carga de la semana pasada lo arregla solo. Un saldo
  // en su propia fila se desincroniza en silencio, y acá corregir cargas
  // viejas es el caso normal.
  const db = base();
  const p = conCatalogo(db);
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja, bultos: 100, uuid: 'a' });
  registrarProceso(db, { fecha: F, lote_id: 11, presentacion_id: p.caja, bultos: 50, uuid: 'b' });
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.verde, kilos: 300, uuid: 'c' });

  const st = stockGalpon(db);
  assert.equal(st.kilos, 1350);
  const com = st.destinos.filter((d) => d.clave === 'comercial')[0];
  assert.equal(com.kilos, 1050);
  assert.equal(com.items[0].bultos, 150, 'no sumó los bultos de los dos lotes');

  // Y una corrección se ve enseguida, sin recalcular nada.
  const id = procesosDelDia(db, F, 11)[0].id;
  editarProceso(db, id, { bultos: 10 });
  // 1.350 − 350 (las 50 cajas) + 70 (las 10 que quedaron) = 1.070
  assert.equal(stockGalpon(db).kilos, 1070);
});

test('el stock se puede mirar de un lote solo', () => {
  const db = base();
  const p = conCatalogo(db);
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja, bultos: 100, uuid: 'a' });
  registrarProceso(db, { fecha: F, lote_id: 11, presentacion_id: p.caja, bultos: 50, uuid: 'b' });
  assert.equal(stockGalpon(db, { lote_id: 10 }).kilos, 700);
  assert.equal(stockGalpon(db, { lote_id: 11 }).kilos, 350);
});

test('LAS SALIDAS RESTAN, el día que existan', () => {
  // La columna `tipo` está desde el día uno porque lo verde se reprocesa y el
  // descarte se remata: las salidas son parte del negocio, no una idea. Hoy
  // nada las escribe, pero el stock ya sabe restarlas — si no, el día que se
  // agreguen habría que revisar cinco consultas acordándose de todas.
  const db = base();
  const p = conCatalogo(db);
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.verde, kilos: 900, uuid: 'a' });
  db.prepare("UPDATE gal_procesos SET tipo = 'salida' WHERE id = "
    + "(SELECT MAX(id) FROM gal_procesos)").run();
  assert.equal(stockGalpon(db).kilos, -900);
  assert.equal(tableroProceso(db, F, 10).procesado, -900);
});

test('el stock vacío no se cae', () => {
  const st = stockGalpon(base());
  assert.equal(st.kilos, 0);
  assert.equal(st.destinos.length, 3);
  for (const d of st.destinos) assert.deepEqual(d.items, []);
});

// ══════════════════════════════════════════════════════════════════════════
// 8 · EL RINDE
// ══════════════════════════════════════════════════════════════════════════
test('EL RINDE ES LO COMERCIAL SOBRE LO VOLCADO', () => {
  const db = base();
  volcar(db, 5000, 10);
  volcar(db, 1000, 11);
  const p = conCatalogo(db);
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja, bultos: 500, uuid: 'a' });
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.verde, kilos: 400, uuid: 'b' });
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.desc, kilos: 100, uuid: 'c' });

  const r = rindePorLote(db, '2026-11-01', '2026-11-30');
  const c3 = r.filter((x) => x.lote_id === 10)[0];
  assert.equal(c3.volcado, 5000);
  assert.equal(c3.comercial, 3500);
  assert.equal(c3.verde, 400);
  assert.equal(c3.descarte, 100);
  assert.equal(c3.procesado, 4000);
  assert.equal(c3.sin_procesar, 1000);
  assert.equal(c3.rinde, 70);

  // Un lote volcado y sin procesar aparece igual, con rinde 0 y todo pendiente.
  const c4 = r.filter((x) => x.lote_id === 11)[0];
  assert.equal(c4.volcado, 1000);
  assert.equal(c4.sin_procesar, 1000);
  assert.equal(c4.rinde, 0);
});

test('UN LOTE CON PROCESO Y SIN VOLCADO EN EL PERÍODO APARECE IGUAL', () => {
  // Es lo que pasa a principios de mes con lo que entró a fin del anterior.
  // Dejarlo afuera escondería kilos que existen.
  const db = base();
  volcar(db, 5000, 10, '2026-10-30');
  const p = conCatalogo(db);
  registrarProceso(db, { fecha: '2026-11-02', lote_id: 10, presentacion_id: p.caja,
    bultos: 100, uuid: 'a' });
  const r = rindePorLote(db, '2026-11-01', '2026-11-30');
  assert.equal(r.length, 1);
  assert.equal(r[0].volcado, 0);
  assert.equal(r[0].comercial, 700);
  assert.equal(r[0].sin_procesar, -700, 'el desfasaje del borde no se ve');
  assert.equal(r[0].rinde, null, 'inventó un rinde dividiendo por cero');
});

test('el rinde respeta el período en las dos puntas', () => {
  const db = base();
  volcar(db, 1000, 10, '2026-11-20');
  const p = conCatalogo(db);
  registrarProceso(db, { fecha: '2026-11-20', lote_id: 10, presentacion_id: p.caja,
    bultos: 100, uuid: 'a' });
  assert.equal(rindePorLote(db, '2026-11-20', '2026-11-20')[0].comercial, 700);
  assert.deepEqual(rindePorLote(db, '2026-11-21', '2026-11-30'), []);
  assert.deepEqual(rindePorLote(db, 'cualquiera', '2026-11-30'), []);
});

// ══════════════════════════════════════════════════════════════════════════
// 9 · LOS LOTES ENTRE LOS QUE SE ELIGE
// ══════════════════════════════════════════════════════════════════════════
test('SE ELIGE ENTRE LOS VOLCADOS, no entre todos los de la finca', () => {
  // Sólo puede salir lo que entró. Y cada uno trae cuánto le queda sin
  // procesar, que es lo que contesta cuál está en la tolva ahora.
  const db = base();
  volcar(db, 5000, 10, '2026-11-18');
  volcar(db, 2000, 11, '2026-11-20');
  const p = conCatalogo(db);
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja, bultos: 100, uuid: 'a' });

  const ls = lotesVolcados(db);
  assert.equal(ls.length, 2, 'apareció un lote que nunca se volcó');
  // Ordenados por el volcado más reciente: el de arriba es el que está entrando.
  assert.equal(ls[0].lote_id, 11);
  const c3 = ls.filter((l) => l.lote_id === 10)[0];
  assert.equal(c3.volcado, 5000);
  assert.equal(c3.procesado, 700);
  assert.equal(c3.sin_procesar, 4300);
  assert.equal(c3.nombre, 'Cuadro 3');
});

test('un volcado borrado saca el lote de la lista', () => {
  const db = base();
  volcar(db, 5000, 10);
  db.prepare("UPDATE gal_volcados SET eliminado_en = '2026-11-21'").run();
  assert.deepEqual(lotesVolcados(db), []);
});

// ══════════════════════════════════════════════════════════════════════════
// 10 · EL CATÁLOGO
// ══════════════════════════════════════════════════════════════════════════
test('BORRAR UNA PRESENTACIÓN NO REESCRIBE LO YA CARGADO', () => {
  // Cada proceso guarda el NOMBRE además del id, justamente para esto.
  const db = base();
  const p = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja,
    bultos: 100, uuid: 'a' });
  assert.equal(borrarPresentacion(db, p.caja).ok, true);

  const fila = procesosDelDia(db, F)[0];
  assert.equal(fila.presentacion, 'Caja cartón · 10 × 700 g');
  assert.equal(fila.kilos, 700);
  assert.equal(stockGalpon(db).kilos, 700);
  // Pero ya no se puede cargar con ella.
  assert.equal(registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja,
    bultos: 1, uuid: 'b' }).ok, false);
  assert.equal(presentaciones(db).length, 2);
});

test('una presentación desactivada no se ofrece pero no se pierde', () => {
  const db = base();
  const p = conCatalogo(db);
  guardarPresentacion(db, { id: p.caja, nombre: 'Caja cartón · 10 × 700 g',
    destino: 'comercial', por_bulto: 10, kg_unidad: 0.7, activo: 0 });
  assert.equal(presentaciones(db).length, 2);
  assert.equal(presentaciones(db, { todas: true }).length, 3);
});

test('el lote se congela desde la BASE, no desde lo que mandó la pantalla', () => {
  // Dos pantallas con distinta versión del padrón escribirían dos nombres para
  // el mismo lote, y el rinde por lote los contaría separados.
  const db = base();
  const p = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, lote_nombre: 'El que yo diga',
    presentacion_id: p.caja, bultos: 1, uuid: 'a' });
  assert.equal(r.fila.lote_nombre, 'Cuadro 3');
  assert.equal(registrarProceso(db, { fecha: F, lote_id: 999,
    presentacion_id: p.caja, bultos: 1, uuid: 'b' }).ok, false);
});

// ══════════════════════════════════════════════════════════════════════════
// 11 · LA FINCA (V1113)
// ══════════════════════════════════════════════════════════════════════════
test('EL LOTE VIENE CON SU FINCA, que es como lo ubica la gente', () => {
  // Andy, 31/10/2026: «poneme mejor el nombre de la FINCA, porque la gente la ubica
  // por el nombre de la finca». Un lote se llama «11-12 y 16-17».
  const db = base();
  volcar(db, 1000, 10);
  volcar(db, 500, 11);
  const ls = lotesVolcados(db);
  assert.equal(ls.filter((l) => l.lote_id === 10)[0].finca, 'La Esperanza');
  assert.equal(ls.filter((l) => l.lote_id === 11)[0].finca, 'La Esperanza');
  assert.equal(rindePorLote(db, '2026-11-01', '2026-11-30')[0].finca, 'La Esperanza');
});

test('LA FINCA SE LEE, NO SE CONGELA — al revés que el nombre del lote', () => {
  // El nombre del LOTE se congela en cada carga porque forma parte de la atribución.
  // La finca es una referencia para ubicarse: lo que sirve es la de hoy, así que si
  // alguien renombra la finca tiene que cambiar en todos lados.
  const db = base();
  volcar(db, 1000, 10);
  const p = conCatalogo(db);
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: p.caja, bultos: 10, uuid: 'a' });

  db.prepare("UPDATE pa_lotes SET finca = 'La Esperanza Norte', nombre = 'OTRO' WHERE id = 10").run();
  assert.equal(lotesVolcados(db)[0].finca, 'La Esperanza Norte');
  assert.equal(rindePorLote(db, '2026-11-01', '2026-11-30')[0].finca, 'La Esperanza Norte');
  // Y el nombre del lote de la carga NO cambió: el proceso lo guardó.
  assert.equal(procesosDelDia(db, F)[0].lote_nombre, 'Cuadro 3');
  assert.equal(rindePorLote(db, '2026-11-01', '2026-11-30')[0].nombre, 'Cuadro 3');
});

test('un lote sin finca no inventa una ni rompe', () => {
  const db = base();
  db.prepare("INSERT INTO pa_lotes (id,nombre,finca) VALUES (12,'Suelto',NULL)").run();
  volcar(db, 100, 12);
  assert.equal(lotesVolcados(db)[0].finca, null);
  assert.equal(rindePorLote(db, '2026-11-01', '2026-11-30')[0].finca, null);
});

test('la finca se busca UNA vez, no una consulta por lote', () => {
  // Con veinte lotes volcados serían veinte SELECT adentro de un map. El helper
  // devuelve el mapa entero y lo usan los cuatro lugares que lo necesitan.
  const db = base();
  const m = fincasDeLotes(db);
  assert.ok(m instanceof Map);
  assert.equal(m.get(10), 'La Esperanza');
  assert.equal(m.get(999), undefined);
});

// ══════════════════════════════════════════════════════════════════════════
// 12 · LA MEZCLA ENTRE LOTES (V1115)
// ══════════════════════════════════════════════════════════════════════════
// Andy, 31/10/2026: «me tiene que dejar mezclar entre los lotes porque no
// siempre tenemos bien en claro de qué lote es cada uno. Es decir es todo
// Damasco».
//
// La tolva mezcla. Pedirle al operador que elija UN lote cuando hay tres
// adentro es pedirle que invente, y una invención entra al rinde con la misma
// cara que un dato medido.
test('EL REPARTO ES A PRORRATA DE LO QUE LE QUEDA A CADA UNO', () => {
  assert.deepEqual(pesosDelReparto([3000, 1000]), [0.75, 0.25]);
  assert.deepEqual(pesosDelReparto([1000]), [1]);
});

test('sin pendiente en ninguno, va en PARTES IGUALES', () => {
  // No hay de dónde prorratear. Es el caso de dos lotes ya terminados a los que
  // se les carga algo que apareció después.
  assert.deepEqual(pesosDelReparto([0, 0]), [0.5, 0.5]);
  assert.deepEqual(pesosDelReparto([0, 0, 0, 0]), [0.25, 0.25, 0.25, 0.25]);
});

test('UN PENDIENTE NEGATIVO NO SE LLEVA KILOS DE OTRO', () => {
  // Un lote con más procesado que volcado tiene pendiente negativo. Prorratear
  // sobre eso daría un peso negativo: ese lote recibiría kilos EN CONTRA y el
  // otro más de los que se cargaron — y los dos números son creíbles.
  assert.deepEqual(pesosDelReparto([-500, 1000]), [0, 1]);
  const ps = pesosDelReparto([-500, 300, 700]);
  assert.equal(ps[0], 0);
  assert.equal(Math.round((ps[1] + ps[2]) * 100), 100);
});

test('LA SUMA DEL REPARTO ES EXACTA, no 699,99', () => {
  // Redondear cada parte por su cuenta hace que el total deje de coincidir con
  // lo que se cargó, y la diferencia aparece como kilos que nadie procesó. El
  // último se queda con el resto.
  for (const [total, pesos] of [
    [700, [1 / 3, 1 / 3, 1 / 3]],
    [100, [0.75, 0.25]],
    [0.05, [0.5, 0.5]],
    [12345.67, [0.17, 0.33, 0.5]],
  ]) {
    const partes = repartir(total, pesos);
    assert.equal(partes.length, pesos.length);
    assert.equal(partes.reduce((a, b) => Math.round((a + b) * 100) / 100, 0), total,
      'el reparto de ' + total + ' no cierra: ' + partes.join(' + '));
  }
});

test('UNA CARGA MEZCLADA SE GUARDA COMO UNA FILA POR LOTE', () => {
  // Y no como una fila «mezcla»: así el rinde por lote y el stock siguen siendo
  // un GROUP BY y no hay una sola consulta que reescribir.
  const db = base();
  volcar(db, 3000, 10);
  volcar(db, 1000, 11);
  const pr = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_ids: [10, 11],
    presentacion_id: pr.caja, bultos: 100, uuid: 'm1' });

  assert.equal(r.ok, true);
  assert.equal(r.ids.length, 2);
  assert.deepEqual(r.reparto.pct, [75, 25]);

  const filas = procesosDelDia(db, F);
  assert.equal(filas.length, 2);
  const porLote = {};
  for (const f of filas) porLote[f.lote_id] = f;
  assert.equal(porLote[10].kilos, 525);
  assert.equal(porLote[11].kilos, 175);
  assert.equal(porLote[10].kilos + porLote[11].kilos, 700,
    'el reparto no suma lo que se cargó');
  // Los bultos también se reparten, o el stock contaría 100 cajas de un lote.
  assert.equal(porLote[10].bultos + porLote[11].bultos, 100);
  // Y quedan marcadas: es una estimación, no una medición.
  for (const f of filas) {
    assert.equal(f.repartido, 1);
    assert.ok(f.reparto, 'la fila no quedó atada al grupo del reparto');
  }
  assert.equal(filas[0].reparto, filas[1].reparto);
});

test('con UN lote no cambia nada: ni reparto ni marca', () => {
  const db = base();
  volcar(db, 1000, 10);
  const pr = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_ids: [10], presentacion_id: pr.caja,
    bultos: 100, uuid: 'a' });
  assert.equal(r.fila.kilos, 700);
  assert.equal(r.fila.repartido, 0);
  assert.equal(r.fila.reparto, null);
  assert.equal(r.reparto, null);
  // Y `lote_id` a secas sigue andando igual que antes.
  const b = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: pr.caja,
    bultos: 10, uuid: 'b' });
  assert.equal(b.fila.kilos, 70);
});

test('el doble clic de una mezcla no la duplica', () => {
  const db = base();
  volcar(db, 3000, 10); volcar(db, 1000, 11);
  const pr = conCatalogo(db);
  const a = registrarProceso(db, { fecha: F, lote_ids: [10, 11],
    presentacion_id: pr.caja, bultos: 100, uuid: 'm1' });
  const b = registrarProceso(db, { fecha: F, lote_ids: [10, 11],
    presentacion_id: pr.caja, bultos: 100, uuid: 'm1' });
  assert.equal(b.ok, true);
  assert.equal(b.repetido, true);
  assert.equal(procesosDelDia(db, F).length, 2);
  assert.equal(tableroProceso(db, F, [10, 11]).procesado, 700);
  assert.ok(a.ids.indexOf(b.id) >= 0);
});

test('BORRAR UNA DEL REPARTO LAS BORRA A TODAS', () => {
  // Media carga deshecha deja la otra mitad atribuida a un lote y los kilos que
  // faltan en ningún lado — y el renglón que queda se ve igual de bien que
  // cualquier otro.
  const db = base();
  volcar(db, 3000, 10); volcar(db, 1000, 11);
  const pr = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_ids: [10, 11],
    presentacion_id: pr.caja, bultos: 100, uuid: 'm1' });
  const b = borrarProceso(db, r.ids[0]);
  assert.equal(b.ok, true);
  assert.equal(b.borradas, 2);
  assert.equal(procesosDelDia(db, F).length, 0);
  assert.equal(stockGalpon(db).kilos, 0);
});

test('borrar una carga SUELTA no se lleva a ninguna otra', () => {
  const db = base();
  volcar(db, 1000, 10);
  const pr = conCatalogo(db);
  const a = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: pr.caja,
    bultos: 10, uuid: 'a' });
  registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: pr.caja,
    bultos: 20, uuid: 'b' });
  assert.equal(borrarProceso(db, a.id).borradas, 1);
  assert.equal(procesosDelDia(db, F).length, 1);
});

test('el tablero SUMA los lotes elegidos', () => {
  // Mostrar el pendiente de uno solo mientras se carga contra tres es un número
  // que invita a procesar de más.
  const db = base();
  volcar(db, 3000, 10); volcar(db, 1000, 11);
  const pr = conCatalogo(db);
  registrarProceso(db, { fecha: F, lote_ids: [10, 11], presentacion_id: pr.verde,
    kilos: 400, uuid: 'm' });
  const uno = tableroProceso(db, F, 10);
  const dos = tableroProceso(db, F, [10, 11]);
  assert.equal(uno.volcado, 3000);
  assert.equal(dos.volcado, 4000);
  assert.equal(dos.procesado, 400);
  assert.deepEqual(dos.lotes, [10, 11]);
  assert.equal(tableroProceso(db, F, []).volcado, 0);
});

test('idsDeLotes limpia lo que llega: repetidos, basura y ceros', () => {
  assert.deepEqual(idsDeLotes([10, '11', 10, 0, null, 'x', -3]), [10, 11]);
  assert.deepEqual(idsDeLotes('10'), [10]);
  assert.deepEqual(idsDeLotes(null), []);
  assert.deepEqual(idsDeLotes(['']), []);
});

test('un lote que no existe no deja entrar la mezcla a medias', () => {
  const db = base();
  volcar(db, 1000, 10);
  const pr = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_ids: [10, 999],
    presentacion_id: pr.caja, bultos: 10, uuid: 'a' });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /999/);
  assert.equal(procesosDelDia(db, F).length, 0, 'entró la mitad de la mezcla');
});

// ══════════════════════════════════════════════════════════════════════════
// 13 · CORREGIR UNA CARGA (V1115)
// ══════════════════════════════════════════════════════════════════════════
test('SE PUEDE CAMBIAR EL LOTE, que es la corrección que más se usa', () => {
  // Y el tablero ya decía que un rinde de más de 100% «se arregla corrigiendo el
  // lote de las cargas» — algo que hasta la V1115 no se podía hacer.
  const db = base();
  volcar(db, 1000, 10);
  const pr = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: pr.caja,
    bultos: 10, uuid: 'a' });
  const e = editarProceso(db, r.id, { lote_id: 11 });
  assert.equal(e.ok, true);
  assert.equal(e.fila.lote_id, 11);
  assert.equal(e.fila.lote_nombre, 'Cuadro 4', 'no volvió a congelar el nombre');
  assert.equal(e.fila.kilos, 70);
  assert.equal(tableroProceso(db, F, 10).procesado, 0);
  assert.equal(tableroProceso(db, F, 11).procesado, 70);
});

test('el lote nuevo tiene que existir', () => {
  const db = base();
  volcar(db, 1000, 10);
  const pr = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: pr.caja,
    bultos: 10, uuid: 'a' });
  assert.equal(editarProceso(db, r.id, { lote_id: 999 }).ok, false);
  assert.equal(procesosDelDia(db, F)[0].lote_id, 10);
});

test('CAMBIAR LA PRESENTACIÓN CAMBIA EL DESTINO Y RECALCULA', () => {
  // Cargar comercial lo que era descarte es un error de un clic. Y dejar los
  // kilos viejos sería una fila que miente sobre sí misma: cien cajas de 7 kg
  // sumando 300.
  const db = base();
  volcar(db, 1000, 10);
  const pr = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: pr.caja,
    bultos: 100, uuid: 'a' });
  assert.equal(r.fila.destino, 'comercial');

  const e = editarProceso(db, r.id, { presentacion_id: pr.desc, kilos: 55 });
  assert.equal(e.fila.destino, 'descarte');
  assert.equal(e.fila.presentacion, 'Bin de descarte');
  assert.equal(e.fila.kilos, 55);
  assert.equal(e.fila.bultos, null, 'quedó con los bultos de la presentación anterior');
  assert.equal(e.fila.por_bulto, null);
  const st = stockGalpon(db);
  assert.equal(st.destinos.filter((d) => d.clave === 'comercial')[0].kilos, 0);
  assert.equal(st.destinos.filter((d) => d.clave === 'descarte')[0].kilos, 55);
});

test('de granel a bultos también recalcula', () => {
  const db = base();
  volcar(db, 1000, 10);
  const pr = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: pr.verde,
    kilos: 300, uuid: 'a' });
  const e = editarProceso(db, r.id, { presentacion_id: pr.caja, bultos: 10 });
  assert.equal(e.fila.destino, 'comercial');
  assert.equal(e.fila.bultos, 10);
  assert.equal(e.fila.kilos, 70);
});

test('corregir el lote no pisa lo que no vino', () => {
  const db = base();
  volcar(db, 1000, 10);
  const pr = conCatalogo(db);
  const r = registrarProceso(db, { fecha: F, lote_id: 10, presentacion_id: pr.caja,
    bultos: 100, observacion: 'turno tarde', uuid: 'a', usuario: 'Andy' });
  const e = editarProceso(db, r.id, { lote_id: 11 });
  assert.equal(e.fila.observacion, 'turno tarde');
  assert.equal(e.fila.bultos, 100);
  assert.equal(e.fila.kilos, 700);
  assert.equal(e.fila.presentacion, 'Caja cartón · 10 × 700 g');
  assert.equal(e.fila.usuario, 'Andy');
});
