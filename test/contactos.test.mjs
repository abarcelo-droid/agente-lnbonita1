// CONTACTOS: la empresa, la persona, el buscador y la ficha.
//
// ── DOS NIVELES ──────────────────────────────────────────────────────────────
// La EMPRESA es la cuenta comercial: lo que produce y en qué meses, el vínculo
// con la planilla, la zona. La PERSONA es a quién se llama: cargo, teléfonos,
// charlas. Varias personas cuelgan de la misma empresa.
//
// Pablo, 9/10/2026: «tenés que dejar relacionar a dos personas con la misma
// empresa, donde la empresa es la que tiene la venta de producción de cada
// producto». Antes los productos colgaban de la persona, y cargando al dueño y
// al encargado de Giglio el calendario de melón quedaba cargado DOS VECES: a la
// semana uno tenía la ventana corregida y el otro no, y ninguna pantalla podía
// decir cuál era la buena.
//
// ── QUÉ PUEDE ESTAR MAL SIN QUE SE NOTE ──────────────────────────────────────
// Que el buscador NO ENCUENTRE. Una lista vacía se lee como "no existe" y no
// como "no lo busqué bien", así que el comercial carga el contacto de nuevo — y
// a los tres meses hay tres fichas del mismo productor, cada una con la mitad de
// las charlas. Por eso el test insiste tanto en buscar por donde nadie espera:
// por un pedazo de teléfono, por lo que se dijo en una charla, por un producto
// que ahora vive un nivel más arriba.
//
// El servicio recibe la db por parámetro, así que corre con node:sqlite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { buscar, buscarEmpresas, empresaPorNombre, ficha, fichaEmpresa,
         charlasDeEmpresa, pendientes, opciones, extracto,
         mesesDeMascara, ventanaEnPalabras, mascaraValida, MESES,
         observadoProveedor, observadoCliente, ofreceYNoLeCompramos } from '../src/servicios/contactos.js';

// La base sale del archivo del repo, no de una copia: si mañana se agrega una columna y el
// test tiene su propio CREATE TABLE, el test pasa y la pantalla se rompe.
const SRC = readFileSync(new URL('../src/servicios/db_sg_contactos.js', import.meta.url), 'utf8');

// La base se arma corriendo EL MÓDULO ENTERO, no el trozo del db.exec(): hay índices que
// se crean después, en su propio try, porque no pueden existir antes de que la migración
// funda los duplicados. Un test que arma la base a mano termina describiendo una base que
// no existe.
function base() {
  const db = new DatabaseSync(':memory:');
  globalThis.__dbCt = db;
  new Function(SRC.replace('import db from "./db.js";', 'const db = globalThis.__dbCt;')
                  .replace(/export default db;\s*$/, ''))();
  return db;
}
const cols = (t) => base().prepare('SELECT name FROM pragma_table_info(?)').all(t).map((r) => r.name);
const nuevaEmpresa = (db, e) => Number(db.prepare(`INSERT INTO sg_contacto_empresas
  (nombre, tipo, zona, localidad, cliente_nombre, proveedor_nombre, vendedor, etiquetas, notas, activo)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
  e.nombre, e.tipo || 'otro', e.zona || null, e.localidad || null,
  e.cliente_nombre || null, e.proveedor_nombre || null, e.vendedor || null,
  e.etiquetas || null, e.notas || null, e.activo == null ? 1 : e.activo).lastInsertRowid);

const nuevaPersona = (db, c) => Number(db.prepare(`INSERT INTO sg_contactos
  (nombre, empresa_id, empresa, cargo, notas, activo) VALUES (?,?,?,?,?,?)`).run(
  c.nombre, c.empresa_id,
  c.empresa_id ? db.prepare('SELECT nombre FROM sg_contacto_empresas WHERE id = ?').get(c.empresa_id).nombre : null,
  c.cargo || null, c.notas || null, c.activo == null ? 1 : c.activo).lastInsertRowid);

const medio = (db, id, tipo, valor, pref) => db.prepare(
  'INSERT INTO sg_contacto_medios (contacto_id,tipo,valor,preferido) VALUES (?,?,?,?)')
  .run(id, tipo, valor, pref ? 1 : 0);
const producto = (db, empId, prod, meses, variedad) => db.prepare(
  'INSERT INTO sg_contacto_productos (empresa_id,producto,variedad,meses) VALUES (?,?,?,?)')
  .run(empId, prod, variedad || null, meses);
const charla = (db, id, fecha, resumen, paso, cuando) => db.prepare(
  'INSERT INTO sg_contacto_charlas (contacto_id,fecha,canal,resumen,proximo_paso,proximo_el) VALUES (?,?,?,?,?,?)')
  .run(id, fecha, 'telefono', resumen, paso || null, cuando || null);

// Una agenda chica pero con todos los casos que importan: una finca con DOS personas, una
// cadena con una, y alguien que trabaja solo.
function agenda() {
  const db = base();
  const eGiglio = nuevaEmpresa(db, { nombre: 'GIGLIO HNOS SRL', tipo: 'proveedor',
    zona: 'San Juan', localidad: 'Pocito', proveedor_nombre: 'GIGLIO', vendedor: 'ANA',
    etiquetas: 'confiable, paga a 30' });
  producto(db, eGiglio, 'MELON', '000011111000', 'Amarillo');   // NOV a MAR
  producto(db, eGiglio, 'CEBOLLA', '110000000011');             // JUL-AGO y MAY-JUN

  const juan = nuevaPersona(db, { nombre: 'Juan Giglio', empresa_id: eGiglio, cargo: 'Dueño' });
  medio(db, juan, 'telefono', '264 155-8899', 1);
  medio(db, juan, 'telefono', '264 422-1100', 0);
  medio(db, juan, 'mail', 'juan@giglio.com.ar', 0);
  // EL ENCARGADO: la segunda persona de la misma finca. Es el caso que motivó el cambio.
  const pepe = nuevaPersona(db, { nombre: 'Pepe Giglio', empresa_id: eGiglio,
    cargo: 'Encargado', notas: 'Atiende el galpón' });
  medio(db, pepe, 'telefono', '264 600-1234', 1);
  charla(db, pepe, '2026-08-20', 'Me contó que este año planta más brócoli y quiere ofrecerlo.',
    'Pedirle precio del brócoli', '2026-09-05');

  const eCoto = nuevaEmpresa(db, { nombre: 'COTO CICSA', tipo: 'cliente', zona: 'CABA',
    cliente_nombre: 'COTO', vendedor: 'BETO' });
  const marcela = nuevaPersona(db, { nombre: 'Marcela Ruiz', empresa_id: eCoto, cargo: 'Compradora' });
  medio(db, marcela, 'mail', 'mruiz@coto.com.ar', 1);
  charla(db, marcela, '2026-08-25', 'Se queja del calibre de la papa. Pidió muestras.',
    'Mandar muestras', '2026-08-28');

  const eSosa = nuevaEmpresa(db, { nombre: 'SOSA SA', tipo: 'ambos', zona: 'Mendoza',
    cliente_nombre: 'SOSA', proveedor_nombre: 'SOSA' });
  const pedro = nuevaPersona(db, { nombre: 'Pedro Sosa', empresa_id: eSosa });
  medio(db, pedro, 'telefono', '261 500-0000', 1);

  const eViejo = nuevaEmpresa(db, { nombre: 'YA NO SRL', tipo: 'otro' });
  const viejo = nuevaPersona(db, { nombre: 'Contacto Viejo', empresa_id: eViejo, activo: 0 });
  return { db, eGiglio, eCoto, eSosa, eViejo, juan, pepe, marcela, pedro, viejo };
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

// ── LOS DOS NIVELES ───────────────────────────────────────────────────────────────────
test('EL PRODUCTO CUELGA DE LA EMPRESA, no de la persona', () => {
  // Es el cambio que pidió Pablo. Si esto se diera vuelta, cargar al dueño y al encargado
  // dejaría el calendario de melón cargado dos veces.
  assert.ok(cols('sg_contacto_productos').includes('empresa_id'));
  assert.ok(!cols('sg_contacto_productos').includes('contacto_id'),
    'el producto volvió a colgar de la persona');
  // Y lo que es de la cuenta no está también en la persona: dos lugares de donde leerlo son
  // dos respuestas distintas el día que una se toque y la otra no.
  for (const c of ['tipo', 'zona', 'localidad', 'cliente_nombre', 'proveedor_nombre',
                   'vendedor', 'etiquetas']) {
    assert.ok(!cols('sg_contactos').includes(c), 'la persona tiene su propio ' + c);
    assert.ok(cols('sg_contacto_empresas').includes(c), 'a la empresa le falta ' + c);
  }
});

test('DOS PERSONAS COMPARTEN LA MISMA EMPRESA y ven el mismo melón', () => {
  const { db, juan, pepe, eGiglio } = agenda();
  assert.equal(ficha(db, juan).empresa_id, eGiglio);
  assert.equal(ficha(db, pepe).empresa_id, eGiglio);
  // El melón está cargado UNA vez.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sg_contacto_productos WHERE producto='MELON'").get().n, 1);
  // Y las dos fichas lo traen igual.
  const a = ficha(db, juan).productos.find((p) => p.producto === 'MELON');
  const b = ficha(db, pepe).productos.find((p) => p.producto === 'MELON');
  assert.equal(a.id, b.id, 'no es el mismo producto: hay uno por persona');
  assert.equal(a.ventana, 'NOV a MAR');
  assert.equal(b.ventana, 'NOV a MAR');
});

test('CORREGIR LA VENTANA UNA VEZ ALCANZA PARA LOS DOS', () => {
  // Es el beneficio concreto del cambio. Antes había que corregirla en cada persona, y el
  // que se olvidaba de una dejaba dos calendarios que se contradicen.
  const { db, juan, pepe, eGiglio } = agenda();
  db.prepare("UPDATE sg_contacto_productos SET meses = '000011111100' WHERE empresa_id = ? AND producto = 'MELON'")
    .run(eGiglio);
  assert.equal(ficha(db, juan).productos.find((p) => p.producto === 'MELON').ventana, 'NOV a ABR');
  assert.equal(ficha(db, pepe).productos.find((p) => p.producto === 'MELON').ventana, 'NOV a ABR');
});

test('la ficha trae la empresa APARTE, no aplanada', () => {
  // Si se mezclaran, la pantalla no podría decir que el melón es de la finca, y el que
  // corrige la ventana desde la ficha de Juan creería que la corrigió para Juan solo.
  const { db, juan } = agenda();
  const f = ficha(db, juan);
  assert.equal(f.nombre, 'Juan Giglio');
  assert.equal(f.cargo, 'Dueño');
  assert.ok(f.empresa, 'no vino la empresa');
  assert.equal(f.empresa.nombre, 'GIGLIO HNOS SRL');
  assert.equal(f.empresa.tipo, 'proveedor');
  assert.equal(f.empresa.zona, 'San Juan');
  // Y lo de la empresa NO está duplicado arriba, al nivel de la persona.
  assert.equal(f.tipo, undefined);
  assert.equal(f.zona, undefined);
});

test('la ficha dice quién más trabaja en la misma empresa', () => {
  // Es la otra mitad del pedido: poder saltar del dueño al encargado sin volver a buscarlo.
  const { db, juan, pepe } = agenda();
  const nombres = ficha(db, juan).empresa.personas.map((p) => p.nombre).sort();
  assert.deepEqual(nombres, ['Juan Giglio', 'Pepe Giglio']);
  // Con el teléfono de cada uno: la pregunta al abrir una ficha es «a quién llamo», y
  // tener que entrar a cada persona para ver su número la hace inútil.
  const otro = ficha(db, juan).empresa.personas.find((p) => p.id === pepe);
  assert.equal(otro.medio_principal, '264 600-1234');
  assert.equal(otro.cargo, 'Encargado');
});

// ── EL BUSCADOR DE PERSONAS ───────────────────────────────────────────────────────────
test('encuentra por el nombre de la persona y por el de la empresa', () => {
  const { db } = agenda();
  assert.deepEqual(buscar(db, { q: 'Pepe' }).map((x) => x.nombre), ['Pepe Giglio']);
  // El nombre de la empresa trae a TODA su gente: el que escribe "giglio" quiere a quién
  // llamar, y puede ser cualquiera de los dos.
  assert.deepEqual(buscar(db, { q: 'GIGLIO HNOS' }).map((x) => x.nombre).sort(),
    ['Juan Giglio', 'Pepe Giglio']);
});

test('ENCUENTRA POR UN PRODUCTO QUE AHORA VIVE EN LA EMPRESA', () => {
  // Es lo que se rompería sin que nadie lo note si el buscador siguiera mirando
  // contacto_id: "melon" devolvería vacío y se leería como «no tenemos quién nos traiga».
  const { db } = agenda();
  const r = buscar(db, { q: 'melon' });
  assert.deepEqual(r.map((x) => x.nombre).sort(), ['Juan Giglio', 'Pepe Giglio']);
  assert.ok(r[0].porque.includes('lo que produce'), JSON.stringify(r[0].porque));
});

test('encuentra por un pedazo del teléfono', () => {
  // Nadie se acuerda del número entero, y el que lo busca lo tiene en un papel a la mitad.
  const { db } = agenda();
  const r = buscar(db, { q: '422-1100' });
  assert.deepEqual(r.map((x) => x.nombre), ['Juan Giglio']);
  assert.ok(r[0].porque.includes('teléfono o mail'), JSON.stringify(r[0].porque));
});

test('encuentra por mail', () => {
  const { db } = agenda();
  assert.deepEqual(buscar(db, { q: 'mruiz@' }).map((x) => x.nombre), ['Marcela Ruiz']);
});

test('ENCUENTRA POR LO QUE SE DIJO EN UNA CHARLA', () => {
  // Es el caso que justifica el módulo: "¿quién me habló de brócoli?". Eso no está en
  // ningún campo, está escrito en el resumen de una conversación.
  const { db } = agenda();
  const r = buscar(db, { q: 'brócoli' });
  assert.deepEqual(r.map((x) => x.nombre), ['Pepe Giglio']);
  assert.ok(r[0].porque.includes('una charla'));
  // Y trae el pedacito, para no tener que abrir la ficha y leerla entera.
  assert.ok(r[0].charla_match, 'no devolvió el extracto');
  assert.match(r[0].charla_match.extracto, /brócoli/i);
  assert.equal(r[0].charla_match.fecha, '2026-08-20');
});

test('la charla la encuentra EN LA PERSONA QUE LA DIJO, no en su compañero', () => {
  // Lo que dijo el encargado no se le puede atribuir al dueño. Aparece aparte en la ficha
  // (charlas_empresa), pero el buscador trae a quien habló.
  const { db, pepe } = agenda();
  assert.deepEqual(buscar(db, { q: 'brócoli' }).map((x) => x.id), [pepe]);
});

test('encuentra por etiqueta, por zona y por cargo', () => {
  const { db } = agenda();
  // La etiqueta y la zona son de la EMPRESA, así que traen a toda su gente.
  assert.deepEqual(buscar(db, { q: 'paga a 30' }).map((x) => x.nombre).sort(),
    ['Juan Giglio', 'Pepe Giglio']);
  assert.deepEqual(buscar(db, { q: 'Pocito' }).map((x) => x.nombre).sort(),
    ['Juan Giglio', 'Pepe Giglio']);
  // El cargo es de la persona.
  assert.deepEqual(buscar(db, { q: 'Compradora' }).map((x) => x.nombre), ['Marcela Ruiz']);
  assert.deepEqual(buscar(db, { q: 'galpón' }).map((x) => x.nombre), ['Pepe Giglio']);
});

test('dice POR DÓNDE encontró a cada uno', () => {
  // Sin esto hay que abrir la ficha para entender por qué apareció en la lista.
  const { db } = agenda();
  const r = buscar(db, { q: 'Pepe' })[0];
  assert.ok(r.porque.length > 0, JSON.stringify(r.porque));
  assert.ok(r.porque.includes('nombre'));
});

test('cada fila dice cuántos MÁS hay en la misma empresa', () => {
  // Sin esto, dos filas con el mismo melón parecen dos proveedores distintos — y son el
  // dueño y el encargado de la misma finca.
  const { db } = agenda();
  const r = buscar(db, { q: 'giglio' });
  assert.ok(r.every((x) => x.otros_en_empresa === 1), r.map((x) => [x.nombre, x.otros_en_empresa]));
  assert.equal(buscar(db, { q: 'Marcela' })[0].otros_en_empresa, 0);
});

test('lo que no está, no aparece', () => {
  const { db } = agenda();
  assert.deepEqual(buscar(db, { q: 'zanahoria' }), []);
});

test('los inactivos quedan afuera salvo que se los pida', () => {
  const { db } = agenda();
  assert.deepEqual(buscar(db, { q: 'viejo' }), []);
  assert.deepEqual(buscar(db, { q: 'viejo', incluir_inactivos: true }).map((x) => x.nombre),
    ['Contacto Viejo']);
});

test('UNA EMPRESA DADA DE BAJA SE LLEVA A SU GENTE de la lista', () => {
  // Si la finca dejó de trabajar con nosotros, el encargado no tiene por qué seguir
  // apareciendo en la lista del día.
  const { db, eGiglio } = agenda();
  assert.equal(buscar(db, { q: 'giglio' }).length, 2);
  db.prepare("UPDATE sg_contacto_empresas SET eliminado_en = datetime('now') WHERE id = ?").run(eGiglio);
  assert.equal(buscar(db, { q: 'giglio' }).length, 0);
  // Pero no se borró nada: las personas y sus charlas siguen.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contactos').get().n, 5);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM sg_contacto_charlas').get().n > 0);
});

test('una persona sin empresa que resuelva NO desaparece de la lista', () => {
  // Con un JOIN en vez de LEFT JOIN se iría sin ningún error, que es la peor forma de
  // perder un contacto: nadie se enteraría hasta necesitarlo.
  const { db } = agenda();
  const id = nuevaPersona(db, { nombre: 'Huérfano Pérez', empresa_id: null });
  assert.deepEqual(buscar(db, { q: 'Huérfano', incluir_inactivos: true }).map((x) => x.id), [id]);
});

// ── LOS FILTROS ───────────────────────────────────────────────────────────────────────
test('pedir "proveedor" trae también a los que son AMBOS', () => {
  // Si no, el que compra y vende desaparece de las dos listas, que es donde menos se lo
  // busca y más se lo necesita. El tipo es de la EMPRESA.
  const { db } = agenda();
  assert.deepEqual(buscar(db, { tipo: 'proveedor' }).map((x) => x.nombre).sort(),
    ['Juan Giglio', 'Pedro Sosa', 'Pepe Giglio']);
  assert.deepEqual(buscar(db, { tipo: 'cliente' }).map((x) => x.nombre).sort(),
    ['Marcela Ruiz', 'Pedro Sosa']);
});

test('filtra por zona, por vendedor, por producto y por empresa', () => {
  const { db, eGiglio } = agenda();
  assert.deepEqual(buscar(db, { zona: 'Mendoza' }).map((x) => x.nombre), ['Pedro Sosa']);
  assert.deepEqual(buscar(db, { vendedor: 'BETO' }).map((x) => x.nombre), ['Marcela Ruiz']);
  assert.deepEqual(buscar(db, { producto: 'MELON' }).map((x) => x.nombre).sort(),
    ['Juan Giglio', 'Pepe Giglio']);
  assert.deepEqual(buscar(db, { empresa_id: eGiglio }).map((x) => x.nombre).sort(),
    ['Juan Giglio', 'Pepe Giglio']);
});

test('filtra por MES: quién tiene algo en noviembre', () => {
  const { db } = agenda();
  // Noviembre es la quinta posición (JUL=1). Giglio tiene melón de NOV a MAR.
  assert.deepEqual(buscar(db, { mes: 5 }).map((x) => x.nombre).sort(), ['Juan Giglio', 'Pepe Giglio']);
  // En octubre (4) no tiene nada: el melón arranca en noviembre y la cebolla ya terminó.
  assert.deepEqual(buscar(db, { mes: 4 }), []);
  // Y en julio (1) sí, por la cebolla.
  assert.deepEqual(buscar(db, { mes: 1 }).map((x) => x.nombre).sort(), ['Juan Giglio', 'Pepe Giglio']);
});

test('un mes fuera de rango se ignora en vez de romper', () => {
  const { db } = agenda();
  assert.ok(buscar(db, { mes: 99 }).length > 0);
  assert.ok(buscar(db, { mes: 'DROP' }).length > 0);
});

test('los filtros se combinan', () => {
  const { db } = agenda();
  assert.equal(buscar(db, { q: 'giglio', zona: 'San Juan' }).length, 2);
  assert.deepEqual(buscar(db, { q: 'giglio', zona: 'CABA' }), []);
});

test('el que tiene algo pendiente va primero, y después se agrupa por empresa', () => {
  // Un listado alfabético puro esconde lo único que hay que hacer hoy; y sin el segundo
  // criterio, las personas de la misma finca quedan repartidas por el alfabeto.
  const { db } = agenda();
  const r = buscar(db, {}).map((x) => x.nombre);
  assert.ok(r.indexOf('Pepe Giglio') < r.indexOf('Pedro Sosa'), r.join(' > '));
  const emp = buscar(db, {}).map((x) => x.empresa);
  const sinPend = emp.slice(2);                       // los dos primeros tienen pendientes
  assert.deepEqual(sinPend, [...sinPend].sort((a, b) => String(a).localeCompare(String(b))),
    'las empresas no quedaron agrupadas: ' + emp.join(' | '));
});

test('cada fila trae el medio preferido, la empresa y cuántas charlas tiene', () => {
  const { db } = agenda();
  const g = buscar(db, { q: 'Juan Giglio' })[0];
  assert.equal(g.medio_principal, '264 155-8899');   // el marcado preferido, no el primero
  assert.equal(g.empresa, 'GIGLIO HNOS SRL');
  assert.match(g.productos, /MELON/);
  const p = buscar(db, { q: 'Pepe' })[0];
  assert.equal(p.charlas, 1);
  assert.equal(p.ultima_charla, '2026-08-20');
});

// ── EL BUSCADOR DE EMPRESAS ───────────────────────────────────────────────────────────
test('UNA FILA POR FINCA, no una por persona', () => {
  // «Quién tiene melón en noviembre» es una pregunta sobre fincas, y contestarla con dos
  // filas de Giglio es contestarla mal.
  const { db } = agenda();
  const r = buscarEmpresas(db, { mes: 5 });
  assert.deepEqual(r.map((e) => e.nombre), ['GIGLIO HNOS SRL']);
  assert.equal(r[0].personas, 2);
  assert.match(r[0].quienes, /Juan Giglio/);
  assert.match(r[0].quienes, /Pepe Giglio/);
  assert.match(r[0].productos, /MELON/);
});

test('buscar una empresa por el nombre de alguien que trabaja ahí', () => {
  // El que se acuerda del encargado y no de la razón social tiene que llegar igual.
  const { db } = agenda();
  assert.deepEqual(buscarEmpresas(db, { q: 'Pepe' }).map((e) => e.nombre), ['GIGLIO HNOS SRL']);
});

test('y por algo que se dijo en una charla, aunque la haya dicho el encargado', () => {
  // Lo que se habló con el encargado es información de la CUENTA, no sólo de él.
  const { db } = agenda();
  assert.deepEqual(buscarEmpresas(db, { q: 'brocoli' }).map((e) => e.nombre), ['GIGLIO HNOS SRL']);
});

test('la lista de empresas trae lo pendiente de cualquiera de su gente', () => {
  const { db } = agenda();
  const g = buscarEmpresas(db, { q: 'GIGLIO' })[0];
  assert.equal(g.pendientes, 1);
  assert.equal(g.ultima_charla, '2026-08-20');
});

test('filtra empresas por tipo, zona, producto y mes', () => {
  const { db } = agenda();
  assert.deepEqual(buscarEmpresas(db, { tipo: 'cliente' }).map((e) => e.nombre).sort(),
    ['COTO CICSA', 'SOSA SA']);
  assert.deepEqual(buscarEmpresas(db, { zona: 'CABA' }).map((e) => e.nombre), ['COTO CICSA']);
  assert.deepEqual(buscarEmpresas(db, { producto: 'CEBOLLA' }).map((e) => e.nombre), ['GIGLIO HNOS SRL']);
  assert.deepEqual(buscarEmpresas(db, { mes: 4 }), []);
});

test('una empresa dada de baja sale de la lista', () => {
  const { db, eCoto } = agenda();
  db.prepare("UPDATE sg_contacto_empresas SET eliminado_en = datetime('now') WHERE id = ?").run(eCoto);
  assert.ok(!buscarEmpresas(db, {}).some((e) => e.id === eCoto));
});

test('buscar la empresa POR NOMBRE, sin tildes ni mayúsculas', () => {
  // Es lo que hace que cargar a la segunda persona de Giglio caiga en la finca que ya
  // existe, sin que el comercial tenga que saber que existe. Si fallara, cada alta armaría
  // una ficha nueva y a los tres meses habría tres Giglios con un tercio de las charlas.
  const { db, eGiglio } = agenda();
  assert.equal(empresaPorNombre(db, 'GIGLIO HNOS SRL').id, eGiglio);
  assert.equal(empresaPorNombre(db, 'giglio hnos srl').id, eGiglio);
  assert.equal(empresaPorNombre(db, '  Giglio Hnos Srl  ').id, eGiglio);
  assert.equal(empresaPorNombre(db, 'OTRA COSA'), null);
  assert.equal(empresaPorNombre(db, ''), null);
  assert.equal(empresaPorNombre(db, null), null);
});

test('y con tildes de un lado o del otro', () => {
  const { db } = agenda();
  const id = nuevaEmpresa(db, { nombre: 'LA PEÑA SA', tipo: 'proveedor' });
  assert.equal(empresaPorNombre(db, 'la pena sa').id, id);
  const id2 = nuevaEmpresa(db, { nombre: 'FINCA LIMON', tipo: 'proveedor' });
  assert.equal(empresaPorNombre(db, 'Finca Limón').id, id2);
});

test('una empresa dada de baja NO bloquea el nombre', () => {
  // El nombre se libera: la finca ya no está en juego.
  const { db, eCoto } = agenda();
  db.prepare("UPDATE sg_contacto_empresas SET eliminado_en = datetime('now') WHERE id = ?").run(eCoto);
  assert.equal(empresaPorNombre(db, 'COTO CICSA'), null);
});

// ── UNA COMILLA NO ABRE LA CONSULTA ───────────────────────────────────────────────────
test("buscar por una comilla no rompe ni devuelve todo", () => {
  const { db } = agenda();
  assert.deepEqual(buscar(db, { q: "' OR '1'='1" }), []);
  assert.deepEqual(buscarEmpresas(db, { q: "' OR '1'='1" }), []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contactos').get().n, 5);
});

test('un nombre con apóstrofo se guarda y se encuentra', () => {
  const { db } = agenda();
  const e = nuevaEmpresa(db, { nombre: "D'AGUA SRL", tipo: 'proveedor' });
  const id = nuevaPersona(db, { nombre: "O'Connor", empresa_id: e });
  assert.deepEqual(buscar(db, { q: "O'Conn" }).map((x) => x.id), [id]);
  assert.deepEqual(buscar(db, { q: "D'AGUA" }).map((x) => x.id), [id]);
  assert.equal(empresaPorNombre(db, "d'agua srl").id, e);
});

// ── LA FICHA DE LA EMPRESA ────────────────────────────────────────────────────────────
test('la ficha de la empresa trae productos, personas y traduce los meses', () => {
  const { db, eGiglio } = agenda();
  const e = fichaEmpresa(db, eGiglio);
  assert.equal(e.nombre, 'GIGLIO HNOS SRL');
  assert.equal(e.productos.length, 2);
  assert.equal(e.personas.length, 2);
  const melon = e.productos.find((p) => p.producto === 'MELON');
  assert.deepEqual(melon.meses_nombres, ['NOV', 'DIC', 'ENE', 'FEB', 'MAR']);
  assert.equal(melon.ventana, 'NOV a MAR');
});

test('una empresa que no existe devuelve null, no explota', () => {
  assert.equal(fichaEmpresa(base(), 9999), null);
  assert.equal(ficha(base(), 9999), null);
});

test('EL HISTORIAL DE LA CUENTA ES UNO SOLO, aunque las personas sean dos', () => {
  const { db, eGiglio, juan, pepe } = agenda();
  charla(db, juan, '2026-08-25', 'Hablamos del precio del melón.');
  const ch = charlasDeEmpresa(db, eGiglio);
  assert.equal(ch.length, 2);
  // Cada una con quién fue: antes de llamar a Juan hay que saber que el martes el encargado
  // ya dijo que no hay fruta, pero no se le puede atribuir a Juan lo que dijo otro.
  assert.deepEqual(ch.map((c) => c.con_quien), ['Juan Giglio', 'Pepe Giglio']);
  assert.deepEqual(ch.map((c) => c.con_cargo), ['Dueño', 'Encargado']);
  assert.deepEqual(ch.map((c) => c.fecha), ['2026-08-25', '2026-08-20']);
});

// ── LA FICHA DE LA PERSONA ────────────────────────────────────────────────────────────
test('la ficha trae los medios con el preferido primero', () => {
  const { db, juan } = agenda();
  const f = ficha(db, juan);
  assert.equal(f.medios.length, 3);
  assert.equal(f.medios[0].valor, '264 155-8899');
});

test('las charlas de la persona van SEPARADAS de las de sus compañeros', () => {
  // No es lo mismo: lo que dijo el encargado no se le puede atribuir al dueño.
  const { db, juan, pepe } = agenda();
  charla(db, juan, '2026-08-25', 'Hablamos del precio del melón.');
  const f = ficha(db, juan);
  assert.equal(f.charlas.length, 1);
  assert.match(f.charlas[0].resumen, /precio del melón/);
  assert.equal(f.charlas_empresa.length, 1);
  assert.match(f.charlas_empresa[0].resumen, /brócoli/);
  assert.equal(f.charlas_empresa[0].con_quien, 'Pepe Giglio', 'no dice con quién fue');
  // Y al revés.
  assert.equal(ficha(db, pepe).charlas_empresa[0].con_quien, 'Juan Giglio');
});

test('la ficha separa lo pendiente de lo ya hecho', () => {
  const { db, pepe } = agenda();
  assert.equal(ficha(db, pepe).pendientes.length, 1);
  db.prepare("UPDATE sg_contacto_charlas SET hecho_en = '2026-09-05' WHERE contacto_id = ?").run(pepe);
  assert.equal(ficha(db, pepe).pendientes.length, 0);
  // Pero la charla no desaparece: lo hecho también es historia.
  assert.equal(ficha(db, pepe).charlas.length, 1);
});

test('las charlas vienen de la más nueva a la más vieja', () => {
  const { db, pepe } = agenda();
  charla(db, pepe, '2026-08-27', 'Segunda charla');
  charla(db, pepe, '2026-07-01', 'Charla vieja');
  const f = ficha(db, pepe);
  assert.deepEqual(f.charlas.map((c) => c.fecha), ['2026-08-27', '2026-08-20', '2026-07-01']);
  assert.equal(f.ultima_charla.resumen, 'Segunda charla');
});

test('una persona sin empresa abre la ficha igual, sin explotar', () => {
  const { db } = agenda();
  const id = nuevaPersona(db, { nombre: 'Huérfano Pérez', empresa_id: null });
  const f = ficha(db, id);
  assert.equal(f.empresa, null);
  assert.deepEqual(f.productos, []);
  assert.deepEqual(f.charlas_empresa, []);
});

// ── LA BANDEJA DE PENDIENTES ──────────────────────────────────────────────────────────
test('lo que vence hasta hoy, de todos los contactos', () => {
  const { db } = agenda();
  const r = pendientes(db, '2026-08-28');
  // La muestra de COTO vence el 28; el brócoli de Giglio recién el 5 de septiembre.
  assert.deepEqual(r.map((x) => x.nombre), ['Marcela Ruiz']);
  assert.equal(r[0].proximo_paso, 'Mandar muestras');
  assert.equal(r[0].medio_principal, 'mruiz@coto.com.ar');
});

test('LA BANDEJA DICE LA EMPRESA, que es lo que uno reconoce', () => {
  // «Marcela Ruiz» a secas no le dice nada a nadie; «Marcela Ruiz, COTO» sí.
  const { db, eCoto } = agenda();
  const r = pendientes(db, '2026-08-28')[0];
  assert.equal(r.empresa, 'COTO CICSA');
  assert.equal(r.empresa_id, eCoto);
  assert.equal(r.cargo, 'Compradora');
});

test('lo marcado hecho sale de la bandeja', () => {
  const { db } = agenda();
  db.prepare("UPDATE sg_contacto_charlas SET hecho_en = '2026-08-26' WHERE proximo_paso = 'Mandar muestras'").run();
  assert.deepEqual(pendientes(db, '2026-08-28'), []);
});

test('una charla sin próximo paso no es un pendiente', () => {
  const { db, pedro } = agenda();
  charla(db, pedro, '2026-08-01', 'Charlamos de la cosecha, nada concreto');
  assert.ok(!pendientes(db, '2026-12-31').some((x) => x.contacto_id === pedro));
});

test('un próximo paso sin fecha tampoco entra a la bandeja, pero sí a la ficha', () => {
  // Sin fecha no se puede ordenar una bandeja; pero perderlo del todo sería peor.
  const { db, pedro } = agenda();
  charla(db, pedro, '2026-08-01', 'Quedamos en vernos', 'Visitarlo', null);
  assert.ok(!pendientes(db, '2026-12-31').some((x) => x.contacto_id === pedro));
  assert.equal(ficha(db, pedro).pendientes.length, 1);
});

// ── LOS DESPLEGABLES ──────────────────────────────────────────────────────────────────
test('las opciones salen de lo cargado, y la zona sale de las EMPRESAS', () => {
  const { db } = agenda();
  const o = opciones(db);
  assert.deepEqual(o.zonas, ['CABA', 'Mendoza', 'San Juan']);
  assert.deepEqual(o.vendedores, ['ANA', 'BETO']);
  assert.deepEqual(o.productos, ['CEBOLLA', 'MELON']);
  assert.ok(o.empresas.includes('GIGLIO HNOS SRL'));
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

// ── LAS TILDES ────────────────────────────────────────────────────────────────────────
// Nadie tipea las tildes en un buscador. Y el LIKE de SQLite sólo ignora las mayúsculas
// del ASCII, así que sin doblar los dos lados 'brocoli' NO encuentra 'brócoli': la lista
// vuelve vacía y se lee como "no está cargado".
test('SIN TILDE encuentra lo escrito CON tilde', () => {
  const { db } = agenda();
  const r = buscar(db, { q: 'brocoli' });
  assert.deepEqual(r.map((x) => x.nombre), ['Pepe Giglio'], 'no lo encontró sin la tilde');
  assert.ok(r[0].charla_match, 'lo encontró pero no pudo decir en qué charla');
  assert.match(r[0].charla_match.extracto, /brócoli/);
});

test('CON TILDE encuentra lo escrito SIN tilde', () => {
  // El otro sentido: lo cargado a las apuradas, sin tildes, buscado bien escrito.
  const { db } = agenda();
  const e = nuevaEmpresa(db, { nombre: 'LOGISTICA PEÑON', tipo: 'otro' });
  const id = nuevaPersona(db, { nombre: 'Martin Nuñez', empresa_id: e });
  assert.deepEqual(buscar(db, { q: 'Martín Núñez' }).map((x) => x.id), [id]);
  assert.deepEqual(buscar(db, { q: 'Logística Peñón' }).map((x) => x.id), [id]);
});

test('la tilde tampoco esconde un producto ni una zona', () => {
  const { db } = agenda();
  const e = nuevaEmpresa(db, { nombre: 'FINCA X', tipo: 'proveedor', zona: 'Córdoba' });
  const id = nuevaPersona(db, { nombre: 'Productor X', empresa_id: e });
  producto(db, e, 'LIMÓN', '000011111000');
  assert.deepEqual(buscar(db, { q: 'limon' }).map((x) => x.id), [id]);
  assert.deepEqual(buscar(db, { q: 'cordoba' }).map((x) => x.id), [id]);
  assert.deepEqual(buscarEmpresas(db, { q: 'limon' }).map((x) => x.id), [e]);
});

test('el extracto recorta en el lugar aunque la tilde esté de un solo lado', () => {
  // plano() cambia un carácter por otro, nunca la longitud, así que el índice que sale de
  // la copia doblada vale sobre el texto original. Si eso dejara de ser cierto, el recorte
  // saldría corrido y nadie lo notaría salvo leyendo frases cortadas al medio.
  const texto = 'x'.repeat(200) + ' MELÓN amarillo ' + 'y'.repeat(200);
  assert.match(extracto(texto, 'melon'), /MELÓN amarillo/);
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
  const a = agenda();
  a.db.exec(DDL_VENTAS);
  const v = a.db.prepare(`INSERT INTO sheet_ventas
    (cliente,producto,proveedor,periodo,mes_ok,kilos_tot,tot_dol) VALUES (?,?,?,?,?,?,?)`);
  // GIGLIO nos trajo melón de NOV a ENE (no hasta marzo, como declara) y cebolla en julio.
  v.run('COTO', 'MELON',   'GIGLIO', '2025-2026', '05-NOVIEMBRE', 5000, 10000);
  v.run('COTO', 'MELON',   'GIGLIO', '2025-2026', '06-DICIEMBRE', 4000,  8000);
  v.run('COTO', 'MELON',   'GIGLIO', '2025-2026', '07-ENERO',     2000,  4000);
  v.run('COTO', 'CEBOLLA', 'GIGLIO', '2025-2026', '01-JULIO',     1000,  2000);
  v.run('COTO', 'PAPA',    'OTRO',   '2025-2026', '02-AGOSTO',    3000,  9000);
  return a;
}

test('de un productor, en qué meses nos trajo cada cosa', () => {
  const { db } = conVentas();
  const o = observadoProveedor(db, 'GIGLIO');
  assert.equal(o.vinculado, true);
  assert.equal(o.sin_datos, false);
  const melon = o.productos.find((p) => p.producto === 'MELON');
  assert.equal(melon.kilos, 11000);
  assert.equal(melon.ventana, 'NOV a ENE');
  assert.equal(melon.meses, '000011100000');
});

test('la máscara observada usa la MISMA convención que la declarada', () => {
  // Si una arrancara en enero y la otra en julio, las dos franjas de la ficha se dibujarían
  // corridas seis meses y nadie lo notaría: las dos se verían plausibles.
  const { db, eGiglio } = conVentas();
  const declarado = fichaEmpresa(db, eGiglio).productos.find((p) => p.producto === 'CEBOLLA');
  const observado = observadoProveedor(db, 'GIGLIO').productos.find((p) => p.producto === 'CEBOLLA');
  assert.equal(declarado.meses.length, observado.meses.length);
  assert.equal(observado.meses[0], '1');          // julio, primera posición
  assert.equal(observado.ventana, 'JUL');
});

test('LO QUE OFRECE Y NUNCA LE COMPRAMOS: es la pregunta del módulo', () => {
  const { db, eGiglio } = conVentas();
  // Declara melón y cebolla, y le compramos las dos: todavía no hay hueco.
  assert.deepEqual(ofreceYNoLeCompramos(fichaEmpresa(db, eGiglio).productos,
    observadoProveedor(db, 'GIGLIO')), []);
  // Ahora declara brócoli, que nunca le compramos.
  producto(db, eGiglio, 'BROCOLI', '000111000000');
  const hueco = ofreceYNoLeCompramos(fichaEmpresa(db, eGiglio).productos,
    observadoProveedor(db, 'GIGLIO'));
  assert.deepEqual(hueco.map((x) => x.producto), ['BROCOLI']);
  assert.equal(hueco[0].ventana, 'OCT a DIC');
});

test('EL HUECO SE VE DESDE LA FICHA DE CUALQUIERA DE LAS DOS PERSONAS', () => {
  // El vínculo con la planilla es de la empresa, así que la oportunidad también: no es del
  // dueño ni del encargado, es de la finca.
  const { db, eGiglio, juan, pepe } = conVentas();
  producto(db, eGiglio, 'BROCOLI', '000111000000');
  for (const quien of [juan, pepe]) {
    const f = ficha(db, quien);
    const hueco = ofreceYNoLeCompramos(f.productos,
      observadoProveedor(db, f.empresa.proveedor_nombre));
    assert.deepEqual(hueco.map((x) => x.producto), ['BROCOLI'], 'desde la ficha de ' + f.nombre);
  }
});

test('de un cliente, qué nos compra', () => {
  const { db } = conVentas();
  const o = observadoCliente(db, 'COTO');
  assert.equal(o.vinculado, true);
  assert.deepEqual(o.productos.map((p) => p.producto).sort(), ['CEBOLLA', 'MELON', 'PAPA']);
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
  const { db, juan, eGiglio } = agenda();
  assert.equal(observadoProveedor(db, 'GIGLIO'), null);
  assert.equal(observadoCliente(db, 'COTO'), null);
  assert.ok(ficha(db, juan), 'la ficha de la persona tiene que abrir igual');
  assert.ok(fichaEmpresa(db, eGiglio), 'y la de la empresa también');
});
