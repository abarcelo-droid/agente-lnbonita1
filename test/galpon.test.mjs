// ══ 🏭 GALPÓN — la lógica del volcado ═════════════════════════════════════
//
// Puente Cordón arranca la cosecha de damasco. Hasta ahora el sistema no
// guardaba los kilos cosechados en ningún lado: `pa_costos_lote` tiene la plata
// de la mano de obra, pero el volumen no estaba.
//
// ── LO QUE PUEDE ESTAR MAL SIN QUE SE NOTE ────────────────────────────────
// Que un IFCO se le atribuya a la cuadrilla equivocada, o al lote equivocado.
// Nadie lo va a ver: el kilo entra igual al total del día, y recién a fin de
// temporada alguien se pregunta por qué una cuadrilla rindió raro. Por eso los
// dos bordes que más se prueban acá son el rango de tarjetas y la hora del
// cambio de lote.
//
// Y la regla que ordena todo el módulo: **nada rechaza**. Cuando el IFCO llega
// a la balanza la fruta ya está cosechada, y cuando se vuelca ya está en la
// tolva. Un problema se DESCRIBE para marcarlo, nunca frena la carga.
//
// El servicio recibe la db por parámetro, así que corre con node:sqlite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { config, guardarConfig, cuadrillas, cuadrillaDeTarjeta, rangoSuperpuesto,
         loteVigente, lotesDelDia, neto, colorSugerido, COLORES, MOTIVOS_DEFECTO }
  from '../src/servicios/galpon.js';

// El DDL y la siembra salen del archivo del repo, no de una copia: si mañana se
// agrega una columna y el test tiene su propio CREATE TABLE, el test pasa y la
// pantalla se rompe.
const SRC = readFileSync(new URL('../src/servicios/db_galpon.js', import.meta.url), 'utf8');
const DDL = SRC.slice(SRC.indexOf('db.exec(`') + 9, SRC.indexOf('`);'));

// pa_cuadrillas es de Personal. Acá se arma con su forma real (db_pa.js:1337)
// porque Galpón la LEE: si Personal le cambia una columna que usamos, este test
// es el que tiene que avisar.
const DDL_PERSONAL = `
CREATE TABLE pa_cuadrillas (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE,
  capataz_id INTEGER, tipo TEXT DEFAULT 'fija' CHECK(tipo IN ('fija','pool')),
  activo INTEGER DEFAULT 1, notas TEXT, creado_en TEXT);
CREATE TABLE pa_lotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, sector_id INTEGER,
  finca TEXT, hectareas REAL, activo INTEGER DEFAULT 1);`;

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL_PERSONAL);
  db.exec(DDL);
  // La siembra de gal_config vive fuera del db.exec (es un bucle de INSERT), así
  // que se repite acá con los mismos valores que el módulo.
  for (const [k, v] of [['tara_ifco', '2.0'], ['objetivo_kg_hora', '733'],
       ['motivos_calidad', 'golpeado,sobremaduro,muy verde,podrido,tierra/sucio,IFCO incompleto'],
       ['balanza_puerto', ''], ['balanza_baudios', '9600']]) {
    db.prepare('INSERT OR IGNORE INTO gal_config (clave, valor) VALUES (?,?)').run(k, v);
  }
  return db;
}

const nuevaCuadrilla = (db, nombre, activo) => Number(db.prepare(
  'INSERT INTO pa_cuadrillas (nombre, activo) VALUES (?,?)')
  .run(nombre, activo == null ? 1 : activo).lastInsertRowid);
const rango = (db, cuadId, desde, hasta, color) => Number(db.prepare(
  'INSERT INTO gal_cuadrilla_tarjetas (cuadrilla_id, desde_id, hasta_id, color) VALUES (?,?,?,?)')
  .run(cuadId, desde, hasta, color || '#d62828').lastInsertRowid);
const nuevoLote = (db, nombre) => Number(db.prepare(
  'INSERT INTO pa_lotes (nombre) VALUES (?)').run(nombre).lastInsertRowid);
const ponerLote = (db, fecha, hora, loteId, nombre, producto) => db.prepare(
  `INSERT INTO gal_lote_vigente (fecha, desde_hora, lote_id, lote_nombre, producto)
   VALUES (?,?,?,?,?)`).run(fecha, hora, loteId, nombre || null, producto || 'DAMASCO');

// Un galpón de prueba: dos cuadrillas con rangos propios.
function galpon() {
  const db = base();
  const norte = nuevaCuadrilla(db, 'Cuadrilla Norte');
  const sur = nuevaCuadrilla(db, 'Cuadrilla Sur');
  rango(db, norte, 1000, 1199, '#d62828');     // roja, 200 tarjetas
  rango(db, sur, 2000, 2199, '#2a9d8f');       // verde, 200 tarjetas
  const lote = nuevoLote(db, 'Lote 4 Norte');
  return { db, norte, sur, lote };
}

// ── LA CONFIGURACIÓN ──────────────────────────────────────────────────────
test('la tara y el objetivo vienen como NÚMEROS, no como texto', () => {
  // Si cada pantalla hiciera su propio parseFloat, una se olvidaría y la tara
  // entraría como texto a una resta: "10" - "2.0" da bien en JS, pero
  // "10" + "2.0" da "102.0". El tipo se arregla en un solo lugar.
  const c = config(base());
  assert.equal(typeof c.tara_ifco, 'number');
  assert.equal(c.tara_ifco, 2);
  assert.equal(typeof c.objetivo_kg_hora, 'number');
  assert.equal(c.objetivo_kg_hora, 733);
  assert.equal(typeof c.balanza_baudios, 'number');
});

test('los motivos de calidad vienen como lista, no como una cadena con comas', () => {
  const c = config(base());
  assert.deepEqual(c.motivos_calidad, MOTIVOS_DEFECTO);
  assert.equal(c.motivos_calidad.length, 6);
});

test('guardar un valor lo pisa en vez de duplicarlo', () => {
  const db = base();
  guardarConfig(db, 'tara_ifco', '2.5');
  guardarConfig(db, 'tara_ifco', '3.0');
  assert.equal(config(db).tara_ifco, 3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM gal_config WHERE clave='tara_ifco'").get().n, 1);
});

test('un valor nuevo se puede agregar sin tocar la tabla', () => {
  // Es la razón de que sea clave/valor y no una tabla ancha de una fila.
  const db = base();
  guardarConfig(db, 'algo_que_no_existia', 'x');
  assert.equal(db.prepare("SELECT valor FROM gal_config WHERE clave='algo_que_no_existia'").get().valor, 'x');
});

// ── LAS CUADRILLAS ────────────────────────────────────────────────────────
test('LEE las cuadrillas de Personal, no las define', () => {
  // pa_cuadrillas ya existía con su responsable de cobro y su tarifa. Galpón no
  // la redefine ni le agrega columnas: sólo le pega su color y su rango.
  const { db } = galpon();
  const c = cuadrillas(db);
  assert.deepEqual(c.map((x) => x.nombre), ['Cuadrilla Norte', 'Cuadrilla Sur']);
  assert.equal(c[0].color, '#d62828');
  assert.equal(c[0].rangos.length, 1);
});

test('una cuadrilla SIN rango aparece igual: es la que hay que configurar', () => {
  // Con un JOIN común desaparecería de la pantalla de configuración, que es
  // justo donde tiene que estar para poder asignarle tarjetas.
  const { db } = galpon();
  nuevaCuadrilla(db, 'Cuadrilla Nueva');
  const c = cuadrillas(db);
  const nueva = c.find((x) => x.nombre === 'Cuadrilla Nueva');
  assert.ok(nueva, 'desapareció de la lista');
  assert.equal(nueva.color, null);
  assert.equal(nueva.tarjetas, 0);
});

test('dice CUÁNTAS tarjetas tiene cada una', () => {
  // Es el número que dice si alcanzan: una cuadrilla que llena 300 IFCOs por día
  // con 200 tarjetas se queda sin tarjetas a media tarde.
  const { db, norte } = galpon();
  assert.equal(cuadrillas(db).find((c) => c.id === norte).tarjetas, 200);
  rango(db, norte, 1200, 1249);                 // se amplía a mitad de temporada
  assert.equal(cuadrillas(db).find((c) => c.id === norte).tarjetas, 250);
});

test('las inactivas no salen, salvo que se las pida', () => {
  const { db } = galpon();
  nuevaCuadrilla(db, 'Cuadrilla Vieja', 0);
  assert.equal(cuadrillas(db).length, 2);
  assert.equal(cuadrillas(db, { incluir_inactivas: true }).length, 3);
});

// ── DE QUIÉN ES LA TARJETA ────────────────────────────────────────────────
test('la tarjeta cae en el rango de su cuadrilla', () => {
  const { db, norte, sur } = galpon();
  assert.equal(cuadrillaDeTarjeta(db, 1000).cuadrilla_id, norte);   // borde de abajo
  assert.equal(cuadrillaDeTarjeta(db, 1100).cuadrilla_id, norte);
  assert.equal(cuadrillaDeTarjeta(db, 1199).cuadrilla_id, norte);   // borde de arriba
  assert.equal(cuadrillaDeTarjeta(db, 2000).cuadrilla_id, sur);
});

test('LOS BORDES SON INCLUSIVOS, los dos', () => {
  // Un BETWEEN mal entendido deja la primera o la última tarjeta de cada
  // cuadrilla huérfana — 2 de 200, que nadie nota hasta que pasa.
  const { db, norte } = galpon();
  assert.equal(cuadrillaDeTarjeta(db, 999).cuadrilla_id, null, 'la de abajo entró de más');
  assert.equal(cuadrillaDeTarjeta(db, 1000).cuadrilla_id, norte, 'se perdió la primera');
  assert.equal(cuadrillaDeTarjeta(db, 1199).cuadrilla_id, norte, 'se perdió la última');
  assert.equal(cuadrillaDeTarjeta(db, 1200).cuadrilla_id, null, 'la de arriba entró de más');
});

test('una tarjeta FUERA DE RANGO no rompe: devuelve el motivo', () => {
  // La fruta ya está cosechada. El volcado se guarda marcado, no se rechaza.
  const { db } = galpon();
  const r = cuadrillaDeTarjeta(db, 5555);
  assert.equal(r.ok, false);
  assert.equal(r.cuadrilla_id, null);
  assert.match(r.motivo, /5555/);
  assert.match(r.motivo, /no está en el rango/);
});

test('y un número que no es un número, tampoco', () => {
  const db = base();
  for (const basura of ['', null, undefined, 'abc', '0', '-5', {}]) {
    const r = cuadrillaDeTarjeta(db, basura);
    assert.equal(r.ok, false, 'pasó: ' + JSON.stringify(basura));
    assert.ok(r.motivo, 'sin motivo para: ' + JSON.stringify(basura));
  }
});

test('trae el nombre y el color, que es lo que la pantalla muestra', () => {
  const { db } = galpon();
  const r = cuadrillaDeTarjeta(db, 2050);
  assert.equal(r.cuadrilla_nombre, 'Cuadrilla Sur');
  assert.equal(r.color, '#2a9d8f');
});

test('un rango desactivado deja de atribuir', () => {
  const { db, norte } = galpon();
  assert.equal(cuadrillaDeTarjeta(db, 1100).cuadrilla_id, norte);
  db.prepare('UPDATE gal_cuadrilla_tarjetas SET activo = 0 WHERE cuadrilla_id = ?').run(norte);
  assert.equal(cuadrillaDeTarjeta(db, 1100).ok, false);
});

// ── RANGOS QUE SE PISAN ───────────────────────────────────────────────────
test('DOS RANGOS SUPERPUESTOS SE DETECTAN AL GUARDAR', () => {
  // Es el error silencioso más caro del módulo: la tarjeta del medio se le
  // atribuye a una de las dos cuadrillas para siempre, y los kilos de la otra
  // desaparecen sin que nada avise. Por eso se chequea al guardar, no al leer.
  const { db } = galpon();
  assert.ok(rangoSuperpuesto(db, 1150, 1250), 'se pisa por arriba y no lo vio');
  assert.ok(rangoSuperpuesto(db, 900, 1050),  'se pisa por abajo y no lo vio');
  assert.ok(rangoSuperpuesto(db, 1050, 1150), 'queda adentro y no lo vio');
  assert.ok(rangoSuperpuesto(db, 900, 1300),  'lo contiene entero y no lo vio');
  assert.ok(rangoSuperpuesto(db, 1000, 1199), 'es idéntico y no lo vio');
});

test('y un rango que NO se pisa, pasa', () => {
  const { db } = galpon();
  assert.equal(rangoSuperpuesto(db, 1200, 1299), null);   // justo después
  assert.equal(rangoSuperpuesto(db, 900, 999), null);     // justo antes
  assert.equal(rangoSuperpuesto(db, 3000, 3999), null);   // lejos
});

test('editar un rango no choca consigo mismo', () => {
  // Sin esto, corregir el "hasta" de un rango existente sería imposible: se
  // detectaría a sí mismo como superposición.
  const { db, norte } = galpon();
  const id = db.prepare('SELECT id FROM gal_cuadrilla_tarjetas WHERE cuadrilla_id = ?').get(norte).id;
  assert.ok(rangoSuperpuesto(db, 1000, 1250), 'sin excluir, choca consigo mismo');
  assert.equal(rangoSuperpuesto(db, 1000, 1250, id), null, 'excluyéndose, no debería chocar');
});

test('dice CON QUIÉN se pisa, no sólo que se pisa', () => {
  // "Se superpone" obliga a buscar con cuál. El nombre está ahí.
  const { db } = galpon();
  assert.equal(rangoSuperpuesto(db, 1150, 1250).cuadrilla_nombre, 'Cuadrilla Norte');
});

// ── EL LOTE VIGENTE ───────────────────────────────────────────────────────
test('con un solo lote cargado, es el del día entero', () => {
  const { db, lote } = galpon();
  ponerLote(db, '2026-11-20', '00:00', lote, 'Lote 4 Norte');
  for (const h of ['06:00', '12:00', '23:59']) {
    assert.equal(loteVigente(db, '2026-11-20', h).lote_id, lote, 'falló a las ' + h);
  }
});

test('EL CAMBIO DE LOTE A MEDIA MAÑANA: el IFCO toma el vigente a SU hora', () => {
  // Es la razón de que esto exista. Con granularidad de día, todo lo de la tarde
  // se le atribuiría al lote de la mañana.
  const { db } = galpon();
  const a = nuevoLote(db, 'Lote 4 Norte');
  const b = nuevoLote(db, 'Lote 7 Sur');
  ponerLote(db, '2026-11-20', '00:00', a, 'Lote 4 Norte');
  ponerLote(db, '2026-11-20', '13:30', b, 'Lote 7 Sur');

  assert.equal(loteVigente(db, '2026-11-20', '08:00').lote_id, a);
  assert.equal(loteVigente(db, '2026-11-20', '13:29').lote_id, a, 'un minuto antes ya cambió');
  assert.equal(loteVigente(db, '2026-11-20', '13:30').lote_id, b, 'en el minuto exacto no cambió');
  assert.equal(loteVigente(db, '2026-11-20', '19:00').lote_id, b);
});

test('el lote de un día no se filtra al otro', () => {
  const { db, lote } = galpon();
  ponerLote(db, '2026-11-20', '00:00', lote, 'Lote 4 Norte');
  assert.equal(loteVigente(db, '2026-11-21', '10:00').ok, false);
  assert.equal(loteVigente(db, '2026-11-19', '10:00').ok, false);
});

test('SIN LOTE CARGADO lo dice, y no inventa uno', () => {
  // Inventar el del día anterior sería peor que no tener nada: los kilos
  // entrarían a un lote que no se estaba cosechando y nadie lo notaría.
  const { db } = galpon();
  const r = loteVigente(db, '2026-11-20', '10:00');
  assert.equal(r.ok, false);
  assert.equal(r.lote_id, null);
  assert.match(r.motivo, /No se cargó el lote del día/);
  assert.match(r.motivo, /2026-11-20/);
});

test('y distingue "no se cargó" de "entró antes de la hora de inicio"', () => {
  // Son dos problemas distintos: uno se arregla cargando el lote, el otro
  // corrigiendo la hora. Un mensaje único mandaría a buscar donde no es.
  const { db, lote } = galpon();
  ponerLote(db, '2026-11-20', '08:00', lote, 'Lote 4 Norte');
  const r = loteVigente(db, '2026-11-20', '06:30');
  assert.equal(r.ok, false);
  assert.match(r.motivo, /arranca a las 08:00/);
  assert.match(r.motivo, /06:30/);
});

test('una fecha inválida no rompe', () => {
  const db = base();
  for (const f of ['', null, 'ayer', '20/11/2026', {}]) {
    const r = loteVigente(db, f, '10:00');
    assert.equal(r.ok, false, 'pasó: ' + JSON.stringify(f));
    assert.match(r.motivo, /Fecha inválida/);
  }
});

test('una hora inválida toma el último del día en vez de romper', () => {
  // El volcado tiene que poder guardarse igual. Si la hora vino mal, se usa el
  // último lote del día, que es la mejor suposición disponible.
  const { db } = galpon();
  const a = nuevoLote(db, 'A'); const b = nuevoLote(db, 'B');
  ponerLote(db, '2026-11-20', '00:00', a, 'A');
  ponerLote(db, '2026-11-20', '13:30', b, 'B');
  assert.equal(loteVigente(db, '2026-11-20', 'cualquier cosa').lote_id, b);
});

test('trae el nombre y el producto, que van en la etiqueta del pallet', () => {
  const { db, lote } = galpon();
  ponerLote(db, '2026-11-20', '00:00', lote, 'Lote 4 Norte', 'DAMASCO');
  const r = loteVigente(db, '2026-11-20', '10:00');
  assert.equal(r.lote_nombre, 'Lote 4 Norte');
  assert.equal(r.producto, 'DAMASCO');
});

test('los tramos del día vienen en orden de hora', () => {
  const { db } = galpon();
  const a = nuevoLote(db, 'A'); const b = nuevoLote(db, 'B'); const c = nuevoLote(db, 'C');
  ponerLote(db, '2026-11-20', '13:30', b, 'B');
  ponerLote(db, '2026-11-20', '00:00', a, 'A');
  ponerLote(db, '2026-11-20', '17:00', c, 'C');
  assert.deepEqual(lotesDelDia(db, '2026-11-20').map((x) => x.lote_nombre), ['A', 'B', 'C']);
});

// ── EL NETO ───────────────────────────────────────────────────────────────
test('neto = bruto − tara, redondeado a dos', () => {
  assert.equal(neto(22.5, 2).neto, 20.5);
  assert.equal(neto(10, 2.37).neto, 7.63);
});

test('UN NETO CERO O NEGATIVO SE MARCA, no se guarda como si nada', () => {
  // Pasa de verdad: se pesa un IFCO vacío por error, o la tara quedó mal
  // configurada y todos los netos del día salen cortos.
  const r = neto(1.5, 2);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /revisar/);
  // Pero el número sale igual: el volcado se guarda marcado, no se pierde.
  assert.equal(r.neto, -0.5);
});

test('un bruto que no es número se dice, no se convierte en NaN', () => {
  for (const b of ['', null, undefined, 'abc', 0, -3]) {
    const r = neto(b, 2);
    assert.equal(r.ok, false, 'pasó: ' + JSON.stringify(b));
    assert.match(r.motivo, /bruto/);
  }
});

test('sin tara configurada, el neto es el bruto', () => {
  assert.equal(neto(20, null).neto, 20);
  assert.equal(neto(20, undefined).neto, 20);
});

// ── QUÉ COLOR LE TOCA A UNA CUADRILLA ─────────────────────────────────────
// Esto se prueba CORRIENDO y no leyendo: la versión de texto —que miraba en qué
// orden aparecían dos líneas— pasaba en verde con la herencia rota, porque al
// borrar la primera el indexOf daba -1 y -1 sigue siendo menor. Lo encontró una
// mutación del código, no una relectura del test.
test('la cuadrilla que YA tiene color se queda con el suyo', () => {
  // Ampliar la tanda a mitad de temporada es lo normal. Si el color cambiara, el
  // mismo equipo tendría dos colores y el campo deja de servir para agarrar.
  const { db, norte } = galpon();
  assert.equal(colorSugerido(db, norte), '#d62828');
});

test('Y A UNA NUEVA LE TOCA UNO QUE NO ESTÉ USANDO NADIE', () => {
  // Dejarlo a mano termina en dos cuadrillas del mismo color, que es el único
  // error que el color no puede corregir: el cuadrillero agarra por el color.
  const { db } = galpon();   // rojo y verde ya tomados
  const tercera = nuevaCuadrilla(db, 'Cuadrilla Este');
  const c = colorSugerido(db, tercera);
  assert.ok(/^#[0-9a-f]{6}$/i.test(c), 'no devolvió un hex: ' + c);
  assert.ok(!['#d62828', '#2a9d8f'].includes(c.toLowerCase()), 'repitió uno tomado: ' + c);
});

test('un color liberado vuelve a estar disponible', () => {
  // Dar de baja un rango apaga la fila; el color que usaba queda libre.
  const { db, norte } = galpon();
  db.prepare('UPDATE gal_cuadrilla_tarjetas SET activo = 0 WHERE cuadrilla_id = ?').run(norte);
  const otra = nuevaCuadrilla(db, 'Cuadrilla Oeste');
  assert.equal(colorSugerido(db, otra), '#d62828', 'el rojo quedó reservado para siempre');
});

test('y cuando se acaban los colores REPITE, no se queda sin dar ninguno', () => {
  // Dos cuadrillas del mismo color son peores que una, pero mucho mejor que no
  // poder darle de alta la tanda a la octava.
  const db = base();
  COLORES.forEach(function (c, i) {
    rango(db, nuevaCuadrilla(db, 'C' + i), 1 + i * 100, 50 + i * 100, c.hex);
  });
  const extra = nuevaCuadrilla(db, 'La octava');
  const c = colorSugerido(db, extra);
  assert.ok(COLORES.some((x) => x.hex === c), 'devolvió algo que no es de la paleta: ' + c);
});

// ── LOS COLORES ───────────────────────────────────────────────────────────
test('la paleta es corta y los colores se distinguen entre sí', () => {
  // El cuadrillero agarra la tarjeta por el color a tres metros: dos azules
  // parecidos son el mismo azul.
  assert.ok(COLORES.length >= 5 && COLORES.length <= 8, 'son ' + COLORES.length);
  const hex = COLORES.map((c) => c.hex);
  assert.equal(new Set(hex).size, hex.length, 'hay un color repetido');
  for (const c of COLORES) {
    assert.match(c.hex, /^#[0-9a-f]{6}$/i, c.nombre + ' no es un hex de 6');
    assert.ok(c.nombre && c.nombre.length > 2, 'color sin nombre legible');
  }
});
