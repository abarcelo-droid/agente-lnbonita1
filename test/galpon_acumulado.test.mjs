// ══ 📈 GALPÓN · EL ACUMULADO ═════════════════════════════════════════════
//
// Andy, 31/10/2026: «mostrame algún lugar donde vamos acumulando el total, no
// sólo por día».
//
// La pantalla de carga contesta cuánto entró HOY. Ésta contesta cuánto
// llevamos, y es el número con el que se cierra una temporada y con el que se
// discute un jornal. Todo lo que falla acá falla CALLADO: una suma siempre
// devuelve un número, y un número equivocado se lee igual que uno bueno.
//
// Lo que tiene test, y por qué:
//
//   1. EL TOTAL CORRIENDO. Se suma en orden ascendente y recién después se da
//      vuelta la lista. Hecho al revés, el renglón de arriba diría los kilos
//      del último día en la columna del acumulado — y se ve perfectamente
//      normal hasta que alguien los suma a mano.
//   2. EL RANGO AL REVÉS. Entre el 30 y el 1 no hay días: contestaría 0 kg con
//      total aplomo, como si no se hubiera cosechado nada.
//   3. LO BORRADO NO SUMA. El borrado es blando; si el acumulado no filtra
//      `eliminado_en`, una carga corregida queda contada dos veces.
//   4. LOS DÍAS SON DÍAS, NO RENGLONES. Si «días trabajados» contara filas, el
//      promedio por día saldría dividido por cinco en una jornada de cinco
//      pesadas.
//   5. EL ORDEN DE LOS CORTES. `ORDER BY kilos` adentro de un GROUP BY se ata
//      en SQLite a la COLUMNA y no al SUM() que la tapa: la lista sale
//      ordenada, sólo que mal.
//   6. EL PRODUCTO DE UN LOTE DEL QUE SALIÓ MÁS DE UNO. Una columna suelta
//      adentro de un GROUP BY la elige SQLite de una fila cualquiera.
//
// Lógica pura con node:sqlite y sin servidor: corre siempre.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { acumulado, rangoCargado } from '../src/servicios/galpon.js';

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE gal_volcados (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE,
      fecha TEXT NOT NULL, hora TEXT,
      lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT,
      cuadrilla_id INTEGER, cuadrilla TEXT,
      kilos REAL NOT NULL, ifcos INTEGER, bruto REAL, tara REAL, tarjeta_id INTEGER,
      origen TEXT NOT NULL DEFAULT 'manual',
      observacion TEXT, estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT,
      usuario_id INTEGER, usuario TEXT,
      creado_en TEXT DEFAULT (datetime('now','localtime')), eliminado_en TEXT);

    -- El acumulado cruza los volcados con el PROCESO para sacar el rinde, así que la
    -- tabla tiene que estar: en la base de verdad la crea db_galpon.js siempre.
    CREATE TABLE gal_procesos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, fecha TEXT NOT NULL,
      lote_id INTEGER NOT NULL, lote_nombre TEXT, producto TEXT, destino TEXT NOT NULL,
      presentacion_id INTEGER, presentacion TEXT, envase TEXT,
      bultos REAL, por_bulto REAL, kg_unidad REAL, kilos REAL NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'ingreso', observacion TEXT,
      estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT,
      usuario_id INTEGER, usuario TEXT, creado_en TEXT, eliminado_en TEXT);
  `);
  return db;
}

// fecha, lote, nombre de lote, producto, cuadrilla, nombre, kilos, ifcos, estado
function meter(db, f, loteId, lote, prod, cuadId, cuad, kg, ifcos, estado) {
  db.prepare(
    'INSERT INTO gal_volcados (fecha,lote_id,lote_nombre,producto,cuadrilla_id,cuadrilla,'
    + 'kilos,ifcos,estado) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(f, loteId, lote, prod, cuadId, cuad, kg, ifcos == null ? null : ifcos,
         estado || 'ok');
}

// Una semana chica pero con todos los casos: dos lotes, dos cuadrillas, dos
// productos, un día sin nada en el medio y una carga marcada para revisar.
function semana() {
  const db = base();
  meter(db, '2026-11-20', 10, 'Cuadro 3', 'Damasco', 1, 'Norte', 100, 5);
  meter(db, '2026-11-21', 10, 'Cuadro 3', 'Damasco', 1, 'Norte', 200, 10);
  meter(db, '2026-11-21', 11, 'Cuadro 4', 'Damasco', 2, 'Sur', 50.5, 3, 'a_revisar');
  // 22 no se trabajó: no existe ninguna fila.
  meter(db, '2026-11-23', 11, 'Cuadro 4', 'Ciruela', 2, 'Sur', 400, 20);
  return db;
}

// ══════════════════════════════════════════════════════════════════════════
// 1 · EL TOTAL QUE VA CORRIENDO
// ══════════════════════════════════════════════════════════════════════════
test('EL ACUMULADO DEL PRIMER RENGLÓN ES EL TOTAL, no los kilos de ese día', () => {
  // La lista sale con lo último arriba. Si el total corriendo se calculara en
  // ese mismo orden, el renglón de arriba diría 400 en las dos columnas y el
  // de abajo diría 750 — y nadie lo mira dos veces.
  const a = acumulado(semana(), null, null);
  assert.equal(a.por_dia[0].fecha, '2026-11-23');
  assert.equal(a.por_dia[0].kilos, 400);
  assert.equal(a.por_dia[0].acumulado, 750.5);
  assert.equal(a.por_dia[0].acumulado, a.total.kilos);
});

test('el acumulado crece día a día y termina en el total', () => {
  const a = acumulado(semana(), null, null);
  const porFecha = {};
  for (const f of a.por_dia) porFecha[f.fecha] = f;
  assert.equal(porFecha['2026-11-20'].acumulado, 100);
  assert.equal(porFecha['2026-11-21'].acumulado, 350.5);
  assert.equal(porFecha['2026-11-23'].acumulado, 750.5);

  // Y nunca baja, leído de atrás para adelante.
  const asc = a.por_dia.slice().reverse();
  for (let i = 1; i < asc.length; i++) {
    assert.ok(asc[i].acumulado >= asc[i - 1].acumulado,
      'el acumulado bajó entre ' + asc[i - 1].fecha + ' y ' + asc[i].fecha);
  }
});

test('un día sin cargas NO aparece como un cero', () => {
  // Entre cosecha y cosecha hay semanas enteras sin nada. Veinte renglones en
  // cero esconden los días que importan.
  const a = acumulado(semana(), null, null);
  assert.equal(a.por_dia.length, 3);
  assert.ok(!a.por_dia.some((f) => f.fecha === '2026-11-22'));
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL RANGO
// ══════════════════════════════════════════════════════════════════════════
test('SIN FECHAS SE DEVUELVE TODO, no un mes por convención', () => {
  // Es la respuesta correcta a «cuánto llevamos». Un rango por defecto que
  // arranca el 1 de enero esconde lo de antes y el total sale corto sin que
  // nada avise.
  const a = acumulado(semana(), null, null);
  assert.equal(a.desde, '2026-11-20');
  assert.equal(a.hasta, '2026-11-23');
  assert.equal(a.total.kilos, 750.5);
});

test('las dos puntas del rango ENTRAN en la cuenta', () => {
  const a = acumulado(semana(), '2026-11-21', '2026-11-23');
  assert.equal(a.total.kilos, 650.5);
  assert.equal(a.total.cargas, 3);

  const b = acumulado(semana(), '2026-11-21', '2026-11-21');
  assert.equal(b.total.kilos, 250.5);
  assert.equal(b.total.dias, 1);
});

test('EL RANGO AL REVÉS SE DA VUELTA Y SE AVISA', () => {
  // Entre el 23 y el 20 no hay ningún día: la pantalla habría contestado 0 kg
  // con total aplomo, y «no se cosechó nada» es una respuesta que se cree.
  const a = acumulado(semana(), '2026-11-23', '2026-11-20');
  assert.equal(a.invertido, true);
  assert.equal(a.desde, '2026-11-20');
  assert.equal(a.hasta, '2026-11-23');
  assert.equal(a.total.kilos, 750.5);

  // Y en el orden bueno no se avisa nada.
  assert.equal(acumulado(semana(), '2026-11-20', '2026-11-23').invertido, false);
});

test('una fecha escrita cualquiera no vacía la pantalla', () => {
  for (const mala of ['hoy', '20/11/2026', '2026-13-45', '']) {
    const a = acumulado(semana(), mala, null);
    assert.equal(a.total.kilos, 750.5, 'con desde=' + JSON.stringify(mala));
  }
});

test('una base vacía contesta cero, no se cae', () => {
  const db = base();
  assert.deepEqual(rangoCargado(db), { primera: null, ultima: null, dias: 0 });
  const a = acumulado(db, null, null);
  assert.equal(a.total.kilos, 0);
  assert.equal(a.total.dias, 0);
  assert.equal(a.promedio_dia, 0);
  assert.equal(a.mejor_dia, null);
  assert.deepEqual(a.por_dia, []);
  assert.deepEqual(a.por_lote, []);
});

test('un período sin nada adentro da cero sin tocar lo de afuera', () => {
  const a = acumulado(semana(), '2026-12-01', '2026-12-31');
  assert.equal(a.total.kilos, 0);
  assert.equal(a.total.cargas, 0);
  assert.deepEqual(a.por_dia, []);
  // Pero el rango cargado sigue sabiendo que hay kilos antes: es lo que deja
  // que la pantalla ofrezca «probá con Todo» en vez de «no hay nada».
  assert.equal(rangoCargado(semana()).primera, '2026-11-20');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LO BORRADO NO SUMA
// ══════════════════════════════════════════════════════════════════════════
test('UNA CARGA BORRADA NO SE CUENTA EN NINGÚN LADO', () => {
  // El borrado es blando: la fila sigue en la base. Si el acumulado no filtra
  // `eliminado_en`, una carga que alguien corrigió borrando y volviendo a
  // cargar queda contada dos veces, y el error crece con la temporada.
  const db = semana();
  db.prepare("UPDATE gal_volcados SET eliminado_en = '2026-11-24' WHERE kilos = 400").run();
  // El período se fija a mano y ENCIERRA al día de la carga borrada. Sin fechas, el
  // rango lo arma rangoCargado(), que ya filtra lo borrado: el 23 quedaría afuera del
  // período y el test pasaría aunque el acumulado contara lo eliminado.
  const a = acumulado(db, '2026-11-01', '2026-11-30');
  assert.equal(a.total.kilos, 350.5);
  assert.equal(a.total.cargas, 3);
  assert.equal(a.total.dias, 2, 'el día quedó contado aunque no le queda ninguna carga');
  assert.ok(!a.por_dia.some((f) => f.fecha === '2026-11-23'));
  assert.ok(!a.por_producto.some((p) => p.nombre === 'Ciruela'));
  assert.equal(rangoCargado(db).ultima, '2026-11-21');
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LOS DÍAS SON DÍAS
// ══════════════════════════════════════════════════════════════════════════
test('«DÍAS TRABAJADOS» CUENTA DÍAS, NO RENGLONES', () => {
  // Una jornada son cinco o diez pesadas. Contando filas, el promedio por día
  // saldría dividido por diez y diría que se cosecha diez veces menos.
  const a = acumulado(semana(), null, null);
  assert.equal(a.total.cargas, 4);
  assert.equal(a.total.dias, 3);
  assert.equal(a.promedio_dia, 250.17);   // 750,5 / 3
});

test('el promedio se divide por los días TRABAJADOS, no por los del almanaque', () => {
  // El rango de abajo son 11 días de almanaque y 3 de trabajo. Dividir por 11
  // mete los domingos y los días de lluvia en el divisor: el número baja sin
  // que haya pasado nada y deja de servir para comparar dos semanas.
  const a = acumulado(semana(), '2026-11-15', '2026-11-25');
  assert.equal(a.total.dias, 3);
  assert.equal(a.promedio_dia, 250.17);
});

test('el mejor día es el de más kilos, y es uno de los que están en la tabla', () => {
  const a = acumulado(semana(), null, null);
  assert.equal(a.mejor_dia.fecha, '2026-11-23');
  assert.equal(a.mejor_dia.kilos, 400);
  const enTabla = a.por_dia.filter((f) => f.fecha === a.mejor_dia.fecha)[0];
  assert.equal(enTabla.kilos, a.mejor_dia.kilos,
    'el mejor día dice otra cosa que el renglón del mismo día: la pantalla se contradice');
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LOS TRES CORTES
// ══════════════════════════════════════════════════════════════════════════
test('LOS CORTES VAN ORDENADOS POR LA SUMA, no por una fila cualquiera', () => {
  // `ORDER BY kilos` adentro de un GROUP BY se ata en SQLite a la COLUMNA, no
  // al SUM() que la tapa. La lista sale ordenada igual — sólo que mal — y no
  // hay forma de notarlo mirando la pantalla.
  const db = base();
  // El lote chico tiene la carga más grande de una sola fila; el grande suma
  // más repartido en varias. Ordenado por fila, el chico iría primero.
  meter(db, '2026-11-20', 10, 'Grande', 'Damasco', 1, 'Norte', 300, 0);
  meter(db, '2026-11-20', 10, 'Grande', 'Damasco', 1, 'Norte', 300, 0);
  meter(db, '2026-11-20', 11, 'Chico', 'Damasco', 2, 'Sur', 500, 0);
  const a = acumulado(db, null, null);
  assert.equal(a.por_lote[0].nombre, 'Grande');
  assert.equal(a.por_lote[0].kilos, 600);
  assert.equal(a.por_cuadrilla[0].nombre, 'Norte');
});

test('el porcentaje de cada corte es sobre el total del período', () => {
  const a = acumulado(semana(), null, null);
  const suma = (xs) => Math.round(xs.reduce((t, x) => t + x.pct, 0));
  assert.equal(suma(a.por_lote), 100);
  assert.equal(suma(a.por_cuadrilla), 100);
  assert.equal(suma(a.por_producto), 100);
  // Y con total 0 no hay NaN ni división por cero.
  const v = acumulado(base(), null, null);
  assert.deepEqual(v.por_lote, []);
});

test('UN LOTE DEL QUE SALIÓ MÁS DE UN PRODUCTO LOS LISTA A LOS DOS', () => {
  // Una columna suelta adentro de un GROUP BY la elige SQLite de una fila
  // cualquiera del grupo: el lote mostraría uno de los dos productos, al azar
  // y sin avisar que hubo otro.
  const a = acumulado(semana(), null, null);
  const c4 = a.por_lote.filter((l) => l.nombre === 'Cuadro 4')[0];
  assert.ok(c4, 'no está el Cuadro 4');
  for (const p of ['Damasco', 'Ciruela']) {
    assert.ok(String(c4.producto).includes(p), 'al Cuadro 4 le falta ' + p);
  }
});

test('el corte por producto es el que sólo tiene sentido en el acumulado', () => {
  const a = acumulado(semana(), null, null);
  const porNombre = {};
  for (const p of a.por_producto) porNombre[p.nombre] = p;
  assert.equal(porNombre.Damasco.kilos, 350.5);
  assert.equal(porNombre.Ciruela.kilos, 400);
  assert.equal(porNombre.Ciruela.dias, 1);
  assert.equal(porNombre.Damasco.dias, 2);
});

test('lo cargado sin cuadrilla se junta aparte, no desaparece', () => {
  // Esos kilos no entran en el kg/jornal de nadie, y es justamente lo que hay
  // que poder ver: desparramados en «null» no los reclama nadie.
  const db = semana();
  meter(db, '2026-11-23', 10, 'Cuadro 3', 'Damasco', null, null, 90, 4);
  const a = acumulado(db, null, null);
  const sin = a.por_cuadrilla.filter((c) => c.gid == null)[0];
  assert.ok(sin, 'las cargas sin cuadrilla no aparecen en el corte');
  assert.match(sin.nombre, /sin cuadrilla/);
  assert.equal(sin.kilos, 90);
  assert.equal(a.total.kilos, 840.5);
});

test('lo cargado sin producto también', () => {
  const db = semana();
  meter(db, '2026-11-23', 10, 'Cuadro 3', null, 1, 'Norte', 10, 1);
  const sin = acumulado(db, null, null).por_producto.filter((p) => p.gid == null)[0];
  assert.ok(sin);
  assert.match(sin.nombre, /sin producto/);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · LO MARCADO PARA REVISAR
// ══════════════════════════════════════════════════════════════════════════
test('las cargas a revisar SUMAN, y además se cuentan aparte', () => {
  // Suman porque los kilos entraron: la fruta está en la tolva. Y se cuentan
  // aparte para que el total no se dé por bueno sin mirarlas.
  const a = acumulado(semana(), null, null);
  assert.equal(a.total.a_revisar, 1);
  assert.equal(a.total.kilos, 750.5, 'lo marcado se dejó afuera del total');
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · LA PLATA SE REDONDEA UNA SOLA VEZ
// ══════════════════════════════════════════════════════════════════════════
test('las sumas no arrastran decimales de más', () => {
  const db = base();
  for (let i = 0; i < 10; i++) meter(db, '2026-11-2' + (i % 10), 10, 'L', 'P', 1, 'N', 0.1, 0);
  const a = acumulado(db, null, null);
  assert.equal(a.total.kilos, 1);
  assert.equal(a.por_dia[0].acumulado, 1);
  for (const f of a.por_dia) {
    assert.equal(f.acumulado, Math.round(f.acumulado * 100) / 100,
      'el acumulado quedó con más de dos decimales: ' + f.acumulado);
  }
});
