// CONTACTOS: el buscador y la ficha.
//
// Lo que puede estar mal sin que se note: que el buscador NO ENCUENTRE. Una lista vacía se
// lee como "no existe" y no como "no lo busqué bien", así que el comercial carga el contacto
// de nuevo — y a los tres meses hay tres fichas del mismo productor, cada una con la mitad
// de las charlas. Por eso el test insiste tanto en buscar por donde nadie espera: por un
// pedazo de teléfono, por lo que se dijo en una charla, por un producto que no está en el
// nombre.
//
// El servicio recibe la db por parámetro, así que corre con node:sqlite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { buscar, ficha, pendientes, opciones, extracto,
         mesesDeMascara, ventanaEnPalabras, mascaraValida, MESES,
         observadoProveedor, observadoCliente, ofreceYNoLeCompramos } from '../src/servicios/contactos.js';

// El DDL sale del archivo del repo, no de una copia: si mañana se agrega una columna y el
// test tiene su propio CREATE TABLE, el test pasa y la pantalla se rompe.
const SRC = readFileSync(new URL('../src/servicios/db_sg_contactos.js', import.meta.url), 'utf8');
const DDL = SRC.slice(SRC.indexOf('db.exec(`') + 9, SRC.indexOf('`);'));

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  return db;
}
const nuevoContacto = (db, c) => {
  const r = db.prepare(`INSERT INTO sg_contactos
    (nombre, empresa, cargo, tipo, zona, localidad, cliente_nombre, proveedor_nombre, vendedor, etiquetas, notas, activo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    c.nombre, c.empresa || null, c.cargo || null, c.tipo || 'otro', c.zona || null,
    c.localidad || null, c.cliente_nombre || null, c.proveedor_nombre || null,
    c.vendedor || null, c.etiquetas || null, c.notas || null, c.activo == null ? 1 : c.activo);
  return Number(r.lastInsertRowid);
};
const medio = (db, id, tipo, valor, pref) => db.prepare(
  'INSERT INTO sg_contacto_medios (contacto_id,tipo,valor,preferido) VALUES (?,?,?,?)')
  .run(id, tipo, valor, pref ? 1 : 0);
const producto = (db, id, prod, meses, variedad) => db.prepare(
  'INSERT INTO sg_contacto_productos (contacto_id,producto,variedad,meses) VALUES (?,?,?,?)')
  .run(id, prod, variedad || null, meses);
const charla = (db, id, fecha, resumen, paso, cuando) => db.prepare(
  'INSERT INTO sg_contacto_charlas (contacto_id,fecha,canal,resumen,proximo_paso,proximo_el) VALUES (?,?,?,?,?,?)')
  .run(id, fecha, 'telefono', resumen, paso || null, cuando || null);

// Una agenda chica pero con todos los casos que importan.
function agenda() {
  const db = base();
  const giglio = nuevoContacto(db, { nombre: 'Juan Giglio', empresa: 'GIGLIO HNOS SRL',
    cargo: 'Dueño', tipo: 'proveedor', zona: 'San Juan', localidad: 'Pocito',
    proveedor_nombre: 'GIGLIO', vendedor: 'ANA', etiquetas: 'confiable, paga a 30' });
  medio(db, giglio, 'telefono', '264 155-8899', 1);
  medio(db, giglio, 'telefono', '264 422-1100', 0);
  medio(db, giglio, 'mail', 'juan@giglio.com.ar', 0);
  producto(db, giglio, 'MELON', '000011111000', 'Amarillo');   // NOV a MAR
  producto(db, giglio, 'CEBOLLA', '110000000011');             // JUL-AGO y MAY-JUN
  charla(db, giglio, '2026-08-20', 'Me contó que este año planta más brócoli y quiere ofrecerlo.',
    'Pedirle precio del brócoli', '2026-09-05');

  const coto = nuevoContacto(db, { nombre: 'Marcela Ruiz', empresa: 'COTO CICSA',
    cargo: 'Compradora', tipo: 'cliente', zona: 'CABA', cliente_nombre: 'COTO', vendedor: 'BETO' });
  medio(db, coto, 'mail', 'mruiz@coto.com.ar', 1);
  charla(db, coto, '2026-08-25', 'Se queja del calibre de la papa. Pidió muestras.',
    'Mandar muestras', '2026-08-28');

  const ambos = nuevoContacto(db, { nombre: 'Pedro Sosa', empresa: 'SOSA SA', tipo: 'ambos',
    zona: 'Mendoza', cliente_nombre: 'SOSA', proveedor_nombre: 'SOSA' });
  medio(db, ambos, 'telefono', '261 500-0000', 1);

  const viejo = nuevoContacto(db, { nombre: 'Contacto Viejo', empresa: 'YA NO', tipo: 'otro', activo: 0 });
  return { db, giglio, coto, ambos, viejo };
}

// ── LA MÁSCARA DE MESES ───────────────────────────────────────────────────────────────
test('la primera posición es JULIO, no enero', () => {
  // Si alguien la lee como enero, un productor de melón pasa a ser de invierno.
  assert.equal(MESES[0], 'JUL');
  assert.deepEqual(mesesDeMascara('100000000000'), ['JUL']);
  assert.deepEqual(mesesDeMascara('000000100000'), ['ENE']);
});

test('la ventana se dice en palabras', () => {
  assert.equal(ventanaEnPalabras('000011111000'), 'NOV a MAR');
  assert.equal(ventanaEnPalabras('100000000000'), 'JUL');
  assert.equal(ventanaEnPalabras('000000000000'), '');
});

test('dos tramos se dicen como dos, no como uno largo', () => {
  // Un productor con cosecha temprana y tardía no tiene UNA ventana: aplastarlas en
  // "JUL a JUN" diría que trae en febrero cuando no trae.
  assert.equal(ventanaEnPalabras('110000000011'), 'JUL a AGO y MAY a JUN');
});

test('una máscara inválida se reconoce', () => {
  assert.equal(mascaraValida('000011111000'), true);
  assert.equal(mascaraValida('0000'), false);            // corta
  assert.equal(mascaraValida('00001111100x'), false);    // con basura
  assert.equal(mascaraValida(null), false);
});

// ── EL BUSCADOR ───────────────────────────────────────────────────────────────────────
test('encuentra por nombre y por empresa', () => {
  const { db } = agenda();
  assert.deepEqual(buscar(db, { q: 'giglio' }).map(x => x.nombre), ['Juan Giglio']);
  assert.deepEqual(buscar(db, { q: 'COTO' }).map(x => x.nombre), ['Marcela Ruiz']);
});

test('encuentra por un pedazo del teléfono', () => {
  // Nadie se acuerda del número entero, y el que lo busca lo tiene en un papel a la mitad.
  const { db } = agenda();
  const r = buscar(db, { q: '422-1100' });
  assert.deepEqual(r.map(x => x.nombre), ['Juan Giglio']);
  assert.ok(r[0].porque.includes('teléfono o mail'), JSON.stringify(r[0].porque));
});

test('encuentra por mail', () => {
  const { db } = agenda();
  assert.deepEqual(buscar(db, { q: 'mruiz@' }).map(x => x.nombre), ['Marcela Ruiz']);
});

test('encuentra por un producto que no está en el nombre', () => {
  const { db } = agenda();
  const r = buscar(db, { q: 'melon' });
  assert.deepEqual(r.map(x => x.nombre), ['Juan Giglio']);
  assert.ok(r[0].porque.includes('lo que produce'));
});

test('ENCUENTRA POR LO QUE SE DIJO EN UNA CHARLA', () => {
  // Es el caso que justifica el módulo: "¿quién me habló de brócoli?". Eso no está en
  // ningún campo, está escrito en el resumen de una charla.
  const { db } = agenda();
  const r = buscar(db, { q: 'brócoli' });
  assert.deepEqual(r.map(x => x.nombre), ['Juan Giglio']);
  assert.ok(r[0].porque.includes('una charla'));
  // Y trae el pedacito, para no tener que abrir la ficha y leerla entera.
  assert.ok(r[0].charla_match, 'no devolvió el extracto');
  assert.match(r[0].charla_match.extracto, /brócoli/i);
  assert.equal(r[0].charla_match.fecha, '2026-08-20');
});

test('encuentra por etiqueta, por zona y por cargo', () => {
  const { db } = agenda();
  assert.deepEqual(buscar(db, { q: 'paga a 30' }).map(x => x.nombre), ['Juan Giglio']);
  assert.deepEqual(buscar(db, { q: 'Pocito' }).map(x => x.nombre), ['Juan Giglio']);
  assert.deepEqual(buscar(db, { q: 'Compradora' }).map(x => x.nombre), ['Marcela Ruiz']);
});

test('dice POR DÓNDE encontró a cada uno', () => {
  // Sin esto hay que abrir la ficha para entender por qué apareció en la lista.
  const { db } = agenda();
  const r = buscar(db, { q: 'giglio' })[0];
  assert.ok(r.porque.length > 0, JSON.stringify(r.porque));
  assert.ok(r.porque.includes('nombre'));
});

test('lo que no está, no aparece', () => {
  const { db } = agenda();
  assert.deepEqual(buscar(db, { q: 'zanahoria' }), []);
});

test('los inactivos quedan afuera salvo que se los pida', () => {
  const { db } = agenda();
  assert.deepEqual(buscar(db, { q: 'viejo' }), []);
  assert.deepEqual(buscar(db, { q: 'viejo', incluir_inactivos: true }).map(x => x.nombre), ['Contacto Viejo']);
});

// ── LOS FILTROS ───────────────────────────────────────────────────────────────────────
test('pedir "proveedor" trae también a los que son AMBOS', () => {
  // Si no, el que compra y vende desaparece de las dos listas, que es donde menos se lo
  // busca y más se lo necesita.
  const { db } = agenda();
  const r = buscar(db, { tipo: 'proveedor' }).map(x => x.nombre).sort();
  assert.deepEqual(r, ['Juan Giglio', 'Pedro Sosa']);
  const c = buscar(db, { tipo: 'cliente' }).map(x => x.nombre).sort();
  assert.deepEqual(c, ['Marcela Ruiz', 'Pedro Sosa']);
});

test('filtra por zona, por vendedor y por producto', () => {
  const { db } = agenda();
  assert.deepEqual(buscar(db, { zona: 'Mendoza' }).map(x => x.nombre), ['Pedro Sosa']);
  assert.deepEqual(buscar(db, { vendedor: 'BETO' }).map(x => x.nombre), ['Marcela Ruiz']);
  assert.deepEqual(buscar(db, { producto: 'MELON' }).map(x => x.nombre), ['Juan Giglio']);
});

test('filtra por MES: quién tiene algo en noviembre', () => {
  const { db } = agenda();
  // Noviembre es la quinta posición (JUL=1). Giglio tiene melón de NOV a MAR.
  assert.deepEqual(buscar(db, { mes: 5 }).map(x => x.nombre), ['Juan Giglio']);
  // En octubre (4) no tiene nada: el melón arranca en noviembre y la cebolla ya terminó.
  assert.deepEqual(buscar(db, { mes: 4 }), []);
  // Y en julio (1) sí, por la cebolla.
  assert.deepEqual(buscar(db, { mes: 1 }).map(x => x.nombre), ['Juan Giglio']);
});

test('un mes fuera de rango se ignora en vez de romper', () => {
  const { db } = agenda();
  assert.ok(buscar(db, { mes: 99 }).length > 0);
  assert.ok(buscar(db, { mes: 'DROP' }).length > 0);
});

test('los filtros se combinan', () => {
  const { db } = agenda();
  assert.deepEqual(buscar(db, { q: 'giglio', zona: 'San Juan' }).map(x => x.nombre), ['Juan Giglio']);
  assert.deepEqual(buscar(db, { q: 'giglio', zona: 'CABA' }), []);
});

test('el que tiene algo pendiente va primero', () => {
  // Un listado alfabético puro esconde lo único que hay que hacer hoy.
  const { db } = agenda();
  const r = buscar(db, {}).map(x => x.nombre);
  assert.ok(r.indexOf('Juan Giglio') < r.indexOf('Pedro Sosa'), r.join(' > '));
});

test('cada fila trae el medio preferido y cuántas charlas tiene', () => {
  const { db } = agenda();
  const g = buscar(db, { q: 'giglio' })[0];
  assert.equal(g.medio_principal, '264 155-8899');   // el marcado preferido, no el primero
  assert.equal(g.charlas, 1);
  assert.equal(g.ultima_charla, '2026-08-20');
  assert.match(g.productos, /MELON/);
});

// ── UNA COMILLA NO ABRE LA CONSULTA ───────────────────────────────────────────────────
test("buscar por una comilla no rompe ni devuelve todo", () => {
  const { db } = agenda();
  const r = buscar(db, { q: "' OR '1'='1" });
  assert.deepEqual(r, []);
  // Y la agenda sigue entera.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contactos').get().n, 4);
});

test('un nombre con apóstrofo se guarda y se encuentra', () => {
  const { db } = agenda();
  const id = nuevoContacto(db, { nombre: "O'Connor", empresa: "D'AGUA SRL", tipo: 'proveedor' });
  assert.deepEqual(buscar(db, { q: "O'Conn" }).map(x => x.id), [id]);
  assert.deepEqual(buscar(db, { q: "D'AGUA" }).map(x => x.id), [id]);
});

// ── LA FICHA ──────────────────────────────────────────────────────────────────────────
test('la ficha trae todo junto, y el preferido primero', () => {
  const { db, giglio } = agenda();
  const f = ficha(db, giglio);
  assert.equal(f.nombre, 'Juan Giglio');
  assert.equal(f.medios.length, 3);
  assert.equal(f.medios[0].valor, '264 155-8899');
  assert.equal(f.productos.length, 2);
  assert.equal(f.charlas.length, 1);
});

test('la ficha traduce los meses, así la pantalla no tiene que saber la convención', () => {
  const { db, giglio } = agenda();
  const melon = ficha(db, giglio).productos.find(p => p.producto === 'MELON');
  assert.deepEqual(melon.meses_nombres, ['NOV', 'DIC', 'ENE', 'FEB', 'MAR']);
  assert.equal(melon.ventana, 'NOV a MAR');
});

test('la ficha separa lo pendiente de lo ya hecho', () => {
  const { db, giglio } = agenda();
  assert.equal(ficha(db, giglio).pendientes.length, 1);
  db.prepare("UPDATE sg_contacto_charlas SET hecho_en = '2026-09-05' WHERE contacto_id = ?").run(giglio);
  assert.equal(ficha(db, giglio).pendientes.length, 0);
  // Pero la charla no desaparece: lo hecho también es historia.
  assert.equal(ficha(db, giglio).charlas.length, 1);
});

test('las charlas vienen de la más nueva a la más vieja', () => {
  const { db, giglio } = agenda();
  charla(db, giglio, '2026-08-27', 'Segunda charla');
  charla(db, giglio, '2026-07-01', 'Charla vieja');
  const f = ficha(db, giglio);
  assert.deepEqual(f.charlas.map(c => c.fecha), ['2026-08-27', '2026-08-20', '2026-07-01']);
  assert.equal(f.ultima_charla.resumen, 'Segunda charla');
});

test('una ficha que no existe devuelve null, no explota', () => {
  assert.equal(ficha(base(), 9999), null);
});

// ── LA BANDEJA DE PENDIENTES ──────────────────────────────────────────────────────────
test('lo que vence hasta hoy, de todos los contactos', () => {
  const { db } = agenda();
  const r = pendientes(db, '2026-08-28');
  // La muestra de COTO vence el 28; el brócoli de Giglio recién el 5 de septiembre.
  assert.deepEqual(r.map(x => x.nombre), ['Marcela Ruiz']);
  assert.equal(r[0].proximo_paso, 'Mandar muestras');
  assert.equal(r[0].medio_principal, 'mruiz@coto.com.ar');
});

test('lo marcado hecho sale de la bandeja', () => {
  const { db } = agenda();
  db.prepare("UPDATE sg_contacto_charlas SET hecho_en = '2026-08-26' WHERE proximo_paso = 'Mandar muestras'").run();
  assert.deepEqual(pendientes(db, '2026-08-28'), []);
});

test('una charla sin próximo paso no es un pendiente', () => {
  const { db, ambos } = agenda();
  charla(db, ambos, '2026-08-01', 'Charlamos de la cosecha, nada concreto');
  assert.ok(!pendientes(db, '2026-12-31').some(x => x.contacto_id === ambos));
});

test('un próximo paso sin fecha tampoco entra a la bandeja, pero sí a la ficha', () => {
  // Sin fecha no se puede ordenar una bandeja; pero perderlo del todo sería peor.
  const { db, ambos } = agenda();
  charla(db, ambos, '2026-08-01', 'Quedamos en vernos', 'Visitarlo', null);
  assert.ok(!pendientes(db, '2026-12-31').some(x => x.contacto_id === ambos));
  assert.equal(ficha(db, ambos).pendientes.length, 1);
});

// ── LOS DESPLEGABLES ──────────────────────────────────────────────────────────────────
test('las opciones salen de lo cargado, no de una lista inventada', () => {
  const { db } = agenda();
  const o = opciones(db);
  assert.deepEqual(o.zonas, ['CABA', 'Mendoza', 'San Juan']);
  assert.deepEqual(o.vendedores, ['ANA', 'BETO']);
  assert.deepEqual(o.productos, ['CEBOLLA', 'MELON']);
  assert.equal(o.meses.length, 12);
});

// ── EL EXTRACTO ───────────────────────────────────────────────────────────────────────
test('el extracto recorta alrededor de lo buscado', () => {
  const largo = 'a'.repeat(200) + ' BROCOLI ' + 'b'.repeat(200);
  const e = extracto(largo, 'BROCOLI');
  assert.match(e, /BROCOLI/);
  assert.ok(e.length < 150, e.length);
  assert.ok(e.startsWith('…') && e.endsWith('…'), e.slice(0, 5) + ' … ' + e.slice(-5));
});

test('si no encuentra el término, devuelve el principio', () => {
  assert.equal(extracto('corto', 'xyz'), 'corto');
});

// ── LO QUE LA BASE YA SABE ────────────────────────────────────────────────────────────
// La ficha pone lo DECLARADO al lado de lo OBSERVADO. Lo que puede estar mal sin que se
// note: que mezcle las dos cosas, o que un vínculo roto por nombre devuelva cero y se lea
// como "no trajo nada" en vez de "no lo encontré".
const DDL_VENTAS = `CREATE TABLE sheet_ventas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente TEXT, producto TEXT, proveedor TEXT, periodo TEXT, mes_ok TEXT,
  kilos_tot REAL, tot_dol REAL, rent_dol REAL)`;

function conVentas() {
  const { db, giglio, coto } = agenda();
  db.exec(DDL_VENTAS);
  const v = db.prepare(`INSERT INTO sheet_ventas
    (cliente,producto,proveedor,periodo,mes_ok,kilos_tot,tot_dol) VALUES (?,?,?,?,?,?,?)`);
  // GIGLIO nos trajo melón de NOV a ENE (no hasta marzo, como declara) y cebolla en julio.
  v.run('COTO', 'MELON',   'GIGLIO', '2025-2026', '05-NOVIEMBRE', 5000, 10000);
  v.run('COTO', 'MELON',   'GIGLIO', '2025-2026', '06-DICIEMBRE', 4000,  8000);
  v.run('COTO', 'MELON',   'GIGLIO', '2025-2026', '07-ENERO',     2000,  4000);
  v.run('COTO', 'CEBOLLA', 'GIGLIO', '2025-2026', '01-JULIO',     1000,  2000);
  // Y COTO nos compra papa y melón.
  v.run('COTO', 'PAPA',    'OTRO',   '2025-2026', '02-AGOSTO',    3000,  9000);
  return { db, giglio, coto };
}

test('de un productor, en qué meses nos trajo cada cosa', () => {
  const { db } = conVentas();
  const o = observadoProveedor(db, 'GIGLIO');
  assert.equal(o.vinculado, true);
  assert.equal(o.sin_datos, false);
  const melon = o.productos.find(p => p.producto === 'MELON');
  assert.equal(melon.kilos, 11000);
  assert.equal(melon.ventana, 'NOV a ENE');
  assert.equal(melon.meses, '000011100000');
});

test('la máscara observada usa la MISMA convención que la declarada', () => {
  // Si una arrancara en enero y la otra en julio, las dos franjas de la ficha se dibujarían
  // corridas seis meses y nadie lo notaría: las dos se verían plausibles.
  const { db, giglio } = conVentas();
  const declarado = ficha(db, giglio).productos.find(p => p.producto === 'CEBOLLA');
  const observado = observadoProveedor(db, 'GIGLIO').productos.find(p => p.producto === 'CEBOLLA');
  assert.equal(declarado.meses.length, observado.meses.length);
  assert.equal(observado.meses[0], '1');          // julio, primera posición
  assert.equal(observado.ventana, 'JUL');
});

test('LO QUE OFRECE Y NUNCA LE COMPRAMOS: es la pregunta del módulo', () => {
  const { db, giglio } = conVentas();
  const f = ficha(db, giglio);
  // Declara melón y cebolla, y le compramos las dos: todavía no hay hueco.
  assert.deepEqual(ofreceYNoLeCompramos(f.productos, observadoProveedor(db, 'GIGLIO')), []);
  // Ahora declara brócoli, que nunca le compramos.
  producto(db, giglio, 'BROCOLI', '000111000000');
  const hueco = ofreceYNoLeCompramos(ficha(db, giglio).productos, observadoProveedor(db, 'GIGLIO'));
  assert.deepEqual(hueco.map(x => x.producto), ['BROCOLI']);
  assert.equal(hueco[0].ventana, 'OCT a DIC');
});

test('de un cliente, qué nos compra', () => {
  const { db } = conVentas();
  const o = observadoCliente(db, 'COTO');
  assert.equal(o.vinculado, true);
  assert.deepEqual(o.productos.map(p => p.producto).sort(), ['CEBOLLA', 'MELON', 'PAPA']);
  assert.equal(o.usd, 33000);
});

test('un vínculo que no matchea dice "sin datos", no cero', () => {
  // Es la diferencia entre "no trajo nada" y "el nombre no coincide con el de la planilla".
  // Un cero se lee como lo primero y manda a alguien a reclamarle a un productor que trajo.
  const { db } = conVentas();
  const o = observadoProveedor(db, 'NOMBRE QUE NO EXISTE');
  assert.equal(o.vinculado, true);
  assert.equal(o.sin_datos, true);
  assert.deepEqual(o.productos, []);
});

test('sin vínculo cargado, no se inventa nada', () => {
  const { db } = conVentas();
  assert.equal(observadoProveedor(db, null), null);
  assert.equal(observadoProveedor(db, ''), null);
});

test('sin la tabla de ventas tampoco explota', () => {
  // Base nueva, o el sync nunca corrió. La ficha tiene que abrir igual.
  const { db, giglio } = agenda();
  assert.equal(observadoProveedor(db, 'GIGLIO'), null);
  assert.equal(observadoCliente(db, 'COTO'), null);
  assert.ok(ficha(db, giglio), 'la ficha tiene que abrir igual');
});

// ── LAS TILDES ────────────────────────────────────────────────────────────────────────
// Nadie tipea las tildes en un buscador. Y el LIKE de SQLite sólo ignora las mayúsculas
// del ASCII, así que sin doblar los dos lados 'brocoli' NO encuentra 'brócoli': la lista
// vuelve vacía y se lee como "no está cargado".
test('SIN TILDE encuentra lo escrito CON tilde', () => {
  const { db } = agenda();
  const r = buscar(db, { q: 'brocoli' });
  assert.deepEqual(r.map(x => x.nombre), ['Juan Giglio'], 'no lo encontró sin la tilde');
  assert.ok(r[0].charla_match, 'lo encontró pero no pudo decir en qué charla');
  assert.match(r[0].charla_match.extracto, /brócoli/);
});

test('CON TILDE encuentra lo escrito SIN tilde', () => {
  // El otro sentido: lo cargado a las apuradas, sin tildes, buscado bien escrito.
  const { db } = agenda();
  const id = nuevoContacto(db, { nombre: 'Martin Nuñez', empresa: 'LOGISTICA PEÑON', tipo: 'otro' });
  assert.deepEqual(buscar(db, { q: 'Martín Núñez' }).map(x => x.id), [id]);
  assert.deepEqual(buscar(db, { q: 'Logística Peñón' }).map(x => x.id), [id]);
});

test('la tilde tampoco esconde un producto ni una zona', () => {
  const { db } = agenda();
  const id = nuevoContacto(db, { nombre: 'Productor X', tipo: 'proveedor', zona: 'Córdoba' });
  producto(db, id, 'LIMÓN', '000011111000');
  assert.deepEqual(buscar(db, { q: 'limon' }).map(x => x.id), [id]);
  assert.deepEqual(buscar(db, { q: 'cordoba' }).map(x => x.id), [id]);
});

test('el extracto recorta en el lugar aunque la tilde esté de un solo lado', () => {
  // plano() cambia un carácter por otro, nunca la longitud, así que el índice que sale de
  // la copia doblada vale sobre el texto original. Si eso dejara de ser cierto, el recorte
  // saldría corrido y nadie lo notaría salvo leyendo frases cortadas al medio.
  const texto = 'x'.repeat(200) + ' MELÓN amarillo ' + 'y'.repeat(200);
  const e = extracto(texto, 'melon');
  assert.match(e, /MELÓN amarillo/);
});
