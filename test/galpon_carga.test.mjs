// ══ ⚖️ GALPÓN · LA CARGA DE KILOS A MANO ═════════════════════════════════
//
// Andy, 30/10/2026: «hará algo más manual... porque todavía no instalamos la
// impresora». Sin impresora no hay tarjetas, sin tarjetas no hay escaneo, y la
// cosecha no espera: los kilos se tipean.
//
// Es la ÚNICA tabla del sistema que guarda volumen. De estos renglones salen
// después el rendimiento de cada lote y los kilos por jornal de cada cuadrilla,
// que es como se paga. O sea: un número mal acá se convierte en plata.
//
// Las cinco cosas que fallan CALLADAS y por eso tienen su test:
//
//   1. «1.250» leído como 1,25 kg. No da error. Entra un número plausible mil
//      veces más chico y aparece cuando no cierra la temporada.
//   2. El cero de más: 4500 donde iban 450. El lote existe, la cuadrilla
//      existe, el número es creíble. No lo agarra nadie.
//   3. El nombre del lote creído al cliente. Dos pantallas con distinta versión
//      del padrón escriben dos nombres para el mismo lote.
//   4. Un PATCH que pisa con null lo que no vino: corregir los kilos borraría
//      la cuadrilla, y esos kilos saldrían del kg/jornal sin que nadie lo vea.
//   5. El doble clic. Dos filas idénticas son kilos contados dos veces.
//
// Lógica pura con node:sqlite y sin servidor: corre siempre. El router
// levantado de verdad está al lado, en test/galpon_carga_router.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  kilos, entero, registrarVolcado, editarVolcado, borrarVolcado,
  volcadosDelDia, resumenDelDia, volcadosEnTramo,
  ultimaCarga,
} from '../src/servicios/galpon.js';

// ── LA BASE: lo que el galpón lee de otros módulos, más su propio libro ───
function base(techo = '20000') {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, sector_id INTEGER,
                           finca TEXT, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca,activo) VALUES
      (10,'Cuadro 3','La Esperanza',1),
      (11,'Cuadro 4','La Esperanza',1);

    CREATE TABLE pa_cuadrillas (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT,
                                activo INTEGER DEFAULT 1);
    INSERT INTO pa_cuadrillas (id,nombre,tipo,activo) VALUES
      (1,'Norte','fija',1), (2,'Sur','pool',1);

    -- El proceso congela el PRODUCTO desde el cultivo del lote, igual que el nombre.

    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER,

                                   cultivo TEXT, campaña TEXT, es_perenne INTEGER DEFAULT 0);

    INSERT INTO pa_cultivos_lote (lote_id,cultivo,campaña,es_perenne) VALUES

      (10,'Damasco','2026/27',1), (11,'Damasco','2026/27',1);

    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);

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
  `);
  db.prepare('INSERT INTO gal_config (clave,valor) VALUES (?,?)').run('kg_max_carga', techo);
  return db;
}

const F = '2026-11-20';
const cargar = (db, d) => registrarVolcado(db, Object.assign(
  { fecha: F, lote_id: 10, kilos: 100, usuario: 'Andy' }, d));

// ══════════════════════════════════════════════════════════════════════════
// 1 · CÓMO SE ESCRIBE UN NÚMERO ACÁ
// ══════════════════════════════════════════════════════════════════════════
test('450, 450,5 y 450.5 son lo mismo', () => {
  assert.equal(kilos('450'), 450);
  assert.equal(kilos('450,5'), 450.5);
  assert.equal(kilos('450.5'), 450.5);
  assert.equal(kilos(450.5), 450.5);
  assert.equal(kilos(' 450 kg '), 450);
});

test('«1.250» SON MIL DOSCIENTOS CINCUENTA KILOS, no uno y cuarto', () => {
  // El error de esta lista es el que no se ve. Un '1.250' leído como 1,25 no
  // tira ningún error: entra un número plausible mil veces más chico, y
  // aparece recién cuando no cierra el rendimiento de la temporada.
  assert.equal(kilos('1.250'), 1250);
  assert.equal(kilos('12.500'), 12500);
  assert.equal(kilos('1.234.567'), 1234567);
  assert.equal(kilos('1.234,5'), 1234.5);

  // Y la regla no se come los decimales de verdad: tres dígitos detrás del
  // punto son miles, uno o dos son decimales.
  assert.equal(kilos('1.25'), 1.25);
  assert.equal(kilos('1.2'), 1.2);
});

test('lo que no es un número no se guarda a medias', () => {
  for (const v of ['', null, undefined, 'mucho', 'abc', '--4', '4,5,6', '1.2.3']) {
    assert.equal(kilos(v), null, 'aceptó ' + JSON.stringify(v));
  }
});

test('los IFCOs vacíos son null, NO cero', () => {
  // «no los contaron» y «contaron cero» son cosas distintas, y promediar kilos
  // por IFCO con los ceros adentro miente para abajo.
  assert.equal(entero(''), null);
  assert.equal(entero(null), null);
  assert.equal(entero('0'), 0);
  assert.equal(entero('18'), 18);
  assert.equal(entero('-3'), null);
  assert.equal(entero('ocho'), null);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · CARGAR
// ══════════════════════════════════════════════════════════════════════════
test('una carga normal entra con todo lo que se le pidió', () => {
  const db = base();
  const r = cargar(db, { kilos: '450,5', cuadrilla_id: 2, producto: 'Damasco', ifcos: 18 });
  assert.equal(r.ok, true);
  assert.equal(r.aviso, null);

  const f = r.fila;
  assert.equal(f.fecha, F);
  assert.equal(f.kilos, 450.5);
  assert.equal(f.ifcos, 18);
  assert.equal(f.producto, 'Damasco');
  assert.equal(f.estado, 'ok');
  assert.equal(f.origen, 'manual');
  // La hora queda VACÍA: el que tipea el lote no tiene por qué decir a qué hora
  // entró. Es lo que después distingue una carga manual de una escaneada.
  assert.equal(f.hora, null);
});

test('EL NOMBRE DEL LOTE Y DE LA CUADRILLA SALEN DE LA BASE, no del pedido', () => {
  // Si se creyeran los del cliente, dos pantallas con distinta versión del
  // padrón escribirían dos nombres para el mismo lote y el informe por lote
  // mostraría dos renglones de lo mismo.
  const db = base();
  const r = cargar(db, {
    lote_id: 11, cuadrilla_id: 1,
    lote_nombre: 'LO QUE SE LE CANTE', cuadrilla: 'TAMPOCO',
  });
  assert.equal(r.fila.lote_nombre, 'Cuadro 4');
  assert.equal(r.fila.cuadrilla, 'Norte');
});

test('la cuadrilla es opcional, pero una que no existe se rechaza', () => {
  const db = base();
  assert.equal(cargar(db, { cuadrilla_id: '' }).ok, true);
  assert.equal(cargar(db, { cuadrilla_id: null }).ok, true);
  assert.equal(db.prepare('SELECT cuadrilla_id FROM gal_volcados LIMIT 1').get().cuadrilla_id, null);

  const mal = cargar(db, { cuadrilla_id: 99 });
  assert.equal(mal.ok, false);
  assert.match(mal.motivo, /cuadrilla 99 no existe/);
});

test('sin fecha, sin lote o sin kilos no entra, y dice cuál falta', () => {
  // Acá SÍ se rechaza, y no contradice «nada se rechaza después del hecho»: esa
  // regla es del volcado, con el IFCO en la mano. Acá hay alguien sentado que
  // puede corregir el renglón en el momento.
  const db = base();
  assert.match(cargar(db, { fecha: 'ayer' }).motivo, /YYYY-MM-DD/);
  assert.match(cargar(db, { lote_id: null }).motivo, /Falta elegir el lote/);
  assert.match(cargar(db, { lote_id: 777 }).motivo, /lote 777 no existe/);
  assert.match(cargar(db, { kilos: 'un montón' }).motivo, /no se entienden/);
  assert.match(cargar(db, { kilos: 0 }).motivo, /mayores que cero/);
  assert.match(cargar(db, { kilos: -5 }).motivo, /mayores que cero/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gal_volcados').get().n, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL CERO DE MÁS
// ══════════════════════════════════════════════════════════════════════════
test('UN NÚMERO ABSURDO SE MARCA, Y ENTRA IGUAL', () => {
  // 4500 donde iban 450 es el error que de verdad pasa tipeando, y no lo agarra
  // nadie: el lote existe, la cuadrilla existe, el número es creíble.
  //
  // Pero FRENARLO sería peor: el que tiene una carga grande de verdad aprende a
  // partirla en dos renglones para esquivar el tope, y entonces el dato queda
  // mal Y además irrastreable.
  const db = base('20000');
  const r = cargar(db, { kilos: 45000 });
  assert.equal(r.ok, true, 'se frenó la carga: eso enseña a esquivar el tope');
  assert.equal(r.fila.estado, 'a_revisar');
  assert.match(r.fila.revision_motivo, /cero de más/);
  assert.ok(r.aviso, 'entró marcada pero sin avisarle a quien la cargó');
});

test('justo en el tope no se marca; un gramo más sí', () => {
  const db = base('20000');
  assert.equal(cargar(db, { kilos: 20000 }).fila.estado, 'ok');
  assert.equal(cargar(db, { kilos: 20000.01 }).fila.estado, 'a_revisar');
});

test('con el tope en 0 el control queda apagado', () => {
  const db = base('0');
  assert.equal(cargar(db, { kilos: 999999 }).fila.estado, 'ok');
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · EL DOBLE CLIC
// ══════════════════════════════════════════════════════════════════════════
test('EL MISMO UUID DOS VECES ES UNA SOLA FILA', () => {
  // Hoy es el doble clic en «Cargar»; mañana es la cola sin señal reintentando.
  // Las dos veces el daño sería el mismo: kilos contados dos veces.
  const db = base();
  const a = cargar(db, { uuid: 'abc-123', kilos: 450 });
  const b = cargar(db, { uuid: 'abc-123', kilos: 450 });

  assert.equal(a.ok, true);
  assert.equal(b.ok, true, 'el reintento no puede dar error: el primero entró bien');
  assert.equal(b.repetido, true);
  assert.equal(b.id, a.id, 'el reintento tiene que ver la misma fila');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gal_volcados').get().n, 1);
  assert.equal(resumenDelDia(db, F).kilos, 450, 'se contaron los kilos dos veces');
});

test('sin uuid, dos cargas iguales son dos cargas', () => {
  // Y tiene que ser así: dos IFCOs de 450 kg de la misma cuadrilla y el mismo
  // lote son dos renglones legítimos.
  const db = base();
  cargar(db, { kilos: 450 });
  cargar(db, { kilos: 450 });
  assert.equal(resumenDelDia(db, F).cargas, 2);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · CORREGIR
// ══════════════════════════════════════════════════════════════════════════
test('CORREGIR LOS KILOS NO BORRA LA CUADRILLA', () => {
  // El bug del PATCH que pisa con null lo que no vino. Sería invisible en la
  // pantalla de carga y sacaría esos kilos del kg por jornal, que es plata.
  const db = base();
  const id = cargar(db, { cuadrilla_id: 2, producto: 'Damasco', ifcos: 18 }).id;

  const r = editarVolcado(db, id, { kilos: '500' });
  assert.equal(r.ok, true);
  assert.equal(r.fila.kilos, 500);
  assert.equal(r.fila.cuadrilla_id, 2);
  assert.equal(r.fila.cuadrilla, 'Sur');
  assert.equal(r.fila.producto, 'Damasco');
  assert.equal(r.fila.ifcos, 18);
});

test('pero mandar la cuadrilla vacía SÍ la saca', () => {
  // La diferencia es «no vino» contra «vino vacía», y tiene que poder hacerse:
  // una cuadrilla puesta por error no se corrige si no hay manera de quitarla.
  const db = base();
  const id = cargar(db, { cuadrilla_id: 2 }).id;
  const r = editarVolcado(db, id, { cuadrilla_id: '' });
  assert.equal(r.fila.cuadrilla_id, null);
  assert.equal(r.fila.cuadrilla, null);
});

test('al corregir se vuelve a mirar el tope, en los dos sentidos', () => {
  const db = base('20000');
  const id = cargar(db, { kilos: 450 }).id;

  assert.equal(editarVolcado(db, id, { kilos: 45000 }).fila.estado, 'a_revisar');
  // Y corregirlo para abajo lo DESMARCA: si quedara marcado para siempre, la
  // cuenta de «para revisar» dejaría de significar algo en dos días.
  const vuelta = editarVolcado(db, id, { kilos: 450 });
  assert.equal(vuelta.fila.estado, 'ok');
  assert.equal(vuelta.fila.revision_motivo, null);
});

test('corregir el lote le cambia también el nombre guardado', () => {
  const db = base();
  const id = cargar(db, { lote_id: 10 }).id;
  const r = editarVolcado(db, id, { lote_id: 11 });
  assert.equal(r.fila.lote_id, 11);
  assert.equal(r.fila.lote_nombre, 'Cuadro 4');
});

test('un PATCH vacío no toca nada y lo dice', () => {
  const db = base();
  const id = cargar(db).id;
  assert.equal(editarVolcado(db, id, {}).ok, false);
});

test('no se puede corregir una carga borrada', () => {
  const db = base();
  const id = cargar(db).id;
  borrarVolcado(db, id);
  assert.match(editarVolcado(db, id, { kilos: 1 }).motivo, /no existe o ya se borró/);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · BORRAR, QUE ES BLANDO
// ══════════════════════════════════════════════════════════════════════════
test('borrar saca la carga de todos lados pero no de la base', () => {
  const db = base();
  const id = cargar(db, { kilos: 450 }).id;
  cargar(db, { kilos: 100 });

  assert.equal(borrarVolcado(db, id).ok, true);
  assert.equal(volcadosDelDia(db, F).length, 1);
  assert.equal(resumenDelDia(db, F).kilos, 100);
  // Pero la fila sigue ahí: un renglón de kilos borrado de verdad es un jornal
  // que después no se puede auditar.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gal_volcados').get().n, 2);
  assert.ok(db.prepare('SELECT eliminado_en FROM gal_volcados WHERE id = ?').get(id).eliminado_en);
});

test('borrar dos veces la misma no borra la de al lado', () => {
  const db = base();
  const id = cargar(db).id;
  assert.equal(borrarVolcado(db, id).ok, true);
  assert.equal(borrarVolcado(db, id).ok, false);
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · LOS DOS CORTES, QUE SON LAS DOS PREGUNTAS
// ══════════════════════════════════════════════════════════════════════════
test('el resumen suma el día y lo parte por cuadrilla y por lote', () => {
  const db = base();
  cargar(db, { lote_id: 10, cuadrilla_id: 1, kilos: 300, ifcos: 12 });
  cargar(db, { lote_id: 10, cuadrilla_id: 2, kilos: 450, ifcos: 18 });
  cargar(db, { lote_id: 11, cuadrilla_id: 1, kilos: 200 });

  const r = resumenDelDia(db, F);
  assert.equal(r.cargas, 3);
  assert.equal(r.kilos, 950);
  assert.equal(r.ifcos, 30);
  assert.equal(r.a_revisar, 0);

  // Por cuadrilla, ordenado por kilos: Norte 500, Sur 450.
  assert.deepEqual(r.por_cuadrilla.map((x) => [x.nombre, x.kilos]),
    [['Norte', 500], ['Sur', 450]]);
  // Por lote: Cuadro 3 750, Cuadro 4 200.
  assert.deepEqual(r.por_lote.map((x) => [x.nombre, x.kilos]),
    [['Cuadro 3', 750], ['Cuadro 4', 200]]);
});

test('EL ORDEN DEL CORTE ES POR EL TOTAL DEL GRUPO, no por una fila cualquiera', () => {
  // En SQLite, `ORDER BY kilos` dentro de un GROUP BY se ata a la COLUMNA y no
  // al SUM() que la tapa. Sale una lista ordenada, sólo que mal — y ordenada
  // mal se ve exactamente igual que ordenada bien.
  //
  // Sur tiene una sola carga grande; Norte tiene tres chicas que suman más.
  const db = base();
  cargar(db, { cuadrilla_id: 2, kilos: 400 });
  cargar(db, { cuadrilla_id: 1, kilos: 200 });
  cargar(db, { cuadrilla_id: 1, kilos: 200 });
  cargar(db, { cuadrilla_id: 1, kilos: 200 });

  const r = resumenDelDia(db, F);
  assert.equal(r.por_cuadrilla[0].nombre, 'Norte', 'ordenó por una fila y no por el total');
  assert.equal(r.por_cuadrilla[0].kilos, 600);
});

test('lo cargado sin cuadrilla aparece con nombre, no en blanco', () => {
  const db = base();
  cargar(db, { kilos: 100 });
  assert.match(resumenDelDia(db, F).por_cuadrilla[0].nombre, /sin cuadrilla/);
});

test('las cargas marcadas se cuentan aparte', () => {
  const db = base('1000');
  cargar(db, { kilos: 100 });
  cargar(db, { kilos: 5000 });
  const r = resumenDelDia(db, F);
  assert.equal(r.a_revisar, 1);
  assert.equal(r.kilos, 5100, 'lo marcado sigue sumando: está cargado, no descartado');
});

test('un día sin nada devuelve ceros y no explota', () => {
  const db = base();
  const r = resumenDelDia(db, '2026-01-01');
  assert.equal(r.kilos, 0);
  assert.equal(r.cargas, 0);
  assert.deepEqual(r.por_cuadrilla, []);
  assert.equal(resumenDelDia(db, 'cualquier cosa').cargas, 0);
  assert.deepEqual(volcadosDelDia(db, 'cualquier cosa'), []);
});

test('cada día se cuenta solo', () => {
  const db = base();
  cargar(db, { fecha: '2026-11-20', kilos: 100 });
  cargar(db, { fecha: '2026-11-21', kilos: 200 });
  assert.equal(resumenDelDia(db, '2026-11-20').kilos, 100);
  assert.equal(resumenDelDia(db, '2026-11-21').kilos, 200);
});

// ══════════════════════════════════════════════════════════════════════════
// 8 · LA CARGA MANUAL NO TRABA EL LOTE DEL DÍA
// ══════════════════════════════════════════════════════════════════════════
test('UNA CARGA MANUAL NO TRABA EL TRAMO: nombró su lote, no lo sacó del reloj', () => {
  // `volcadosEnTramo` existe para decidir si un tramo del lote del día todavía
  // se puede corregir. Una carga manual eligió su lote de la lista, así que no
  // depende de ningún tramo y no hay nada que trabar.
  //
  // Si contara por fecha sola, el tramo quedaría trabado todos los días y por
  // nada — y el que quiere arreglar un lote mal declarado no podría.
  const db = base();
  cargar(db, { kilos: 450 });
  assert.equal(volcadosEnTramo(db, F, '00:00', null), 0);
});

test('pero una carga CON hora sí lo traba, y sólo dentro de su ventana', () => {
  // Ésa es la que sacó su lote del reloj: corregir el tramo la dejaría
  // apuntando a un lote que ya nadie declaró.
  const db = base();
  cargar(db, { kilos: 100, hora: '08:30' });
  cargar(db, { kilos: 100, hora: '15:00' });

  assert.equal(volcadosEnTramo(db, F, '00:00', '13:30'), 1);
  assert.equal(volcadosEnTramo(db, F, '13:30', null), 1);
  assert.equal(volcadosEnTramo(db, F, '00:00', null), 2);
});

test('y una carga borrada deja de trabar', () => {
  const db = base();
  const id = cargar(db, { kilos: 100, hora: '08:30' }).id;
  assert.equal(volcadosEnTramo(db, F, '00:00', null), 1);
  borrarVolcado(db, id);
  assert.equal(volcadosEnTramo(db, F, '00:00', null), 0);
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · ⚡ DE DÓNDE SALE EL ENCABEZADO DE LA CARGA RÁPIDA (V1110)
// ══════════════════════════════════════════════════════════════════════════
// Andy, 31/10/2026: «que ya quede guardado el último lote, comentarios y
// cuadrilla que puso y vaya cargando sólo los cajones nuevos».
//
// Lo que se propone NO se guarda en ningún lado: se deduce de la última fila
// que esa persona escribió. Así no hay una preferencia que mantener
// sincronizada, ni que limpiar cuando alguien borra justo esa carga.
//
// Lo que puede salir mal es uno solo, y es caro: proponer la cuadrilla de AYER
// y que media mañana de kilos se le anote a la gente equivocada. Los kilos son
// creíbles, el lote existe, la cuadrilla existe: no lo agarra nadie.
const ANDY = 7, JUAN = 8;
function conUltima(filas) {
  const db = base();
  const ins = db.prepare(
    'INSERT INTO gal_volcados (fecha,lote_id,lote_nombre,producto,cuadrilla_id,cuadrilla,'
    + 'kilos,observacion,usuario_id,eliminado_en) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const f of filas) {
    ins.run(f.fecha, f.lote_id || 10, f.lote || 'Cuadro 3', f.producto || 'Damasco',
            f.cuad_id == null ? null : f.cuad_id, f.cuad == null ? null : f.cuad,
            f.kilos == null ? 100 : f.kilos, f.obs == null ? null : f.obs,
            f.usuario == null ? null : f.usuario, f.borrado || null);
  }
  return db;
}

test('propone LO ÚLTIMO QUE CARGÓ ESA PERSONA, con lote, cuadrilla y observación', () => {
  const db = conUltima([
    { fecha: F, cuad_id: 1, cuad: 'Norte', obs: 'pasada 1', usuario: ANDY },
    { fecha: F, cuad_id: 2, cuad: 'Sur', obs: 'pasada 2', usuario: ANDY },
  ]);
  const u = ultimaCarga(db, F, ANDY);
  assert.equal(u.cuadrilla, 'Sur');
  assert.equal(u.cuadrilla_id, 2);
  assert.equal(u.observacion, 'pasada 2');
  assert.equal(u.lote_id, 10);
  assert.equal(u.producto, 'Damasco');
  assert.equal(u.de_otro_dia, false);
  assert.equal(u.mio, true);
});

test('LO ÚLTIMO DE OTRO NO SE PROPONE COMO PROPIO mientras uno tenga lo suyo', () => {
  // Dos personas cargando en el mismo galpón. Si gana la última fila a secas,
  // el que vuelve de almorzar arranca con la cuadrilla del compañero.
  const db = conUltima([
    { fecha: F, cuad_id: 1, cuad: 'Norte', usuario: ANDY },
    { fecha: F, cuad_id: 2, cuad: 'Sur', usuario: JUAN },
  ]);
  assert.equal(ultimaCarga(db, F, ANDY).cuadrilla, 'Norte');
  assert.equal(ultimaCarga(db, F, JUAN).cuadrilla, 'Sur');
});

test('si uno no cargó nada todavía, se propone lo del día aunque sea de otro', () => {
  // Es mejor que nada: el lote del día es casi seguro el mismo. Y abajo está la
  // bandera que avisa cuando lo propuesto no es de esta persona.
  const db = conUltima([{ fecha: F, cuad_id: 2, cuad: 'Sur', usuario: JUAN }]);
  const u = ultimaCarga(db, F, ANDY);
  assert.equal(u.cuadrilla, 'Sur');
  assert.equal(u.mio, false);
  assert.equal(u.de_otro_dia, false);
});

test('LO DE HOY DE UN COMPAÑERO LE GANA A LO MÍO DE AYER', () => {
  // Juan viene cargando desde las siete el lote y la cuadrilla de hoy. Andy llega,
  // abre la carga rápida y todavía no cargó nada: lo que le sirve es lo que está
  // pasando HOY, no lo que él mismo cargó ayer — que sería otro lote, otra cuadrilla,
  // y encima entraría sin el cartel porque para él sería «lo suyo».
  const db = conUltima([
    { fecha: '2026-11-19', lote_id: 10, lote: 'Cuadro 3', cuad_id: 1, cuad: 'Norte',
      usuario: ANDY },
    { fecha: F, lote_id: 11, lote: 'Cuadro 4', cuad_id: 2, cuad: 'Sur', usuario: JUAN },
  ]);
  const u = ultimaCarga(db, F, ANDY);
  assert.equal(u.cuadrilla, 'Sur');
  assert.equal(u.lote_id, 11);
  assert.equal(u.de_otro_dia, false);
  assert.equal(u.mio, false);
});

test('LO QUE VIENE DE OTRO DÍA VIENE MARCADO', () => {
  // Es la bandera que hace que la pantalla pida confirmar antes de la primera
  // carga. Sin ella, la tanda arranca con la cuadrilla de ayer en silencio.
  const db = conUltima([
    { fecha: '2026-11-19', cuad_id: 1, cuad: 'Norte', usuario: ANDY },
  ]);
  const u = ultimaCarga(db, F, ANDY);
  assert.equal(u.cuadrilla, 'Norte');
  assert.equal(u.de_otro_dia, true);
  assert.equal(u.fecha, '2026-11-19');
});

test('lo del MISMO día le gana a lo de ayer, aunque lo de ayer sea más reciente de ID', () => {
  // El id más alto es el que se escribió último, no el del día más nuevo: el
  // sábado se puede cargar el lunes. Lo que manda para proponer es el DÍA.
  const db = conUltima([
    { fecha: F, cuad_id: 1, cuad: 'Norte', usuario: ANDY },
    { fecha: '2026-11-19', cuad_id: 2, cuad: 'Sur', usuario: ANDY },
  ]);
  const u = ultimaCarga(db, F, ANDY);
  assert.equal(u.cuadrilla, 'Norte');
  assert.equal(u.de_otro_dia, false);
});

test('una carga BORRADA no se propone', () => {
  // Alguien que borra su última carga porque estaba mal no quiere que la
  // siguiente arranque repitiéndola.
  const db = conUltima([
    { fecha: F, cuad_id: 1, cuad: 'Norte', usuario: ANDY },
    { fecha: F, cuad_id: 2, cuad: 'Sur', usuario: ANDY, borrado: '2026-11-20 10:00' },
  ]);
  assert.equal(ultimaCarga(db, F, ANDY).cuadrilla, 'Norte');
});

test('sin nada cargado nunca, no se propone nada y no se rompe', () => {
  assert.equal(ultimaCarga(base(), F, ANDY), null);
  assert.equal(ultimaCarga(base(), 'cualquier cosa', ANDY), null);
});

test('sin usuario en la cookie se propone lo último del día, sin decir que es propio', () => {
  const db = conUltima([{ fecha: F, cuad_id: 1, cuad: 'Norte', usuario: ANDY }]);
  const u = ultimaCarga(db, F, null);
  assert.equal(u.cuadrilla, 'Norte');
  assert.equal(u.mio, false);
});

test('una carga sin cuadrilla se propone SIN cuadrilla, no con la de antes', () => {
  // Si se arrastrara la anterior, el que cargó a propósito sin cuadrilla vuelve
  // y se la encuentra puesta.
  const db = conUltima([
    { fecha: F, cuad_id: 1, cuad: 'Norte', usuario: ANDY },
    { fecha: F, cuad_id: null, cuad: null, usuario: ANDY },
  ]);
  const u = ultimaCarga(db, F, ANDY);
  assert.equal(u.cuadrilla_id, null);
  assert.equal(u.cuadrilla, null);
});
