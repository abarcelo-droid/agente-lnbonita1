// ══ EL «¿CÓMO SE USA?» DE CONTACTOS COMERCIALES ═══════════════════════════
//
// CLAUDE.md: «si modificás algo en el módulo lo agregás al "cómo se usa" con el
// número de versión».
//
// ESTE TEST NO CONTROLA QUE EL TEXTO EXISTA. Controla que lo que el manual
// AFIRMA siga siendo cierto en el CÓDIGO. Un test que sólo verifica que el
// párrafo está escrito no sirve para nada: lo que hay que clavar es que la
// pantalla siga haciendo lo que el manual promete, porque un manual que va una
// versión atrás es peor que no tenerlo — el operador hace lo que dice y le sale
// mal.
//
// Cada afirmación del manual tiene al lado su assert contra el servicio, el
// router, la base o la pantalla. Se verificó MUTANDO EL CÓDIGO: veintidós roturas
// del backend, veintidós rojos. Dos de ellas encontraron huecos de verdad —el rechazo
// del producto repetido y el de la empresa repetida sólo estaban clavados por su texto,
// no por su camino— y uno de esos se arregló en la BASE, con un índice único, porque un
// chequeo que vive sólo en el router no cubre lo que entra por abajo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buscar, buscarEmpresas, empresaPorNombre, ficha, fichaEmpresa,
         charlasDeEmpresa, pendientes, ventanaEnPalabras,
         observadoProveedor, ofreceYNoLeCompramos } from '../src/servicios/contactos.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL  = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const ROUTER = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_contactos.js'), 'utf8');
const SERV   = fs.readFileSync(path.join(RAIZ, 'src/servicios/contactos.js'), 'utf8');
const BASE   = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg_contactos.js'), 'utf8');

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

// El manual vive en el fuente como una docena de strings concatenados. Se los junta
// para comparar contra EL TEXTO QUE EL OPERADOR LEE: dónde cae cada corte de línea es
// incidental, y un test atado a eso se rompe la primera vez que alguien reacomoda un
// renglón sin haber cambiado una palabra.
const MANUAL = trozo(PANEL, "SG_MANUAL.contactos = { titulo: 'Contactos comerciales'", '\r\n};')
  .replace(/'\s*\r?\n\s*\+ '/g, '');

// Un handler del router, de su router.post/patch/delete hasta el siguiente. No se puede
// cortar en el primer '});' porque un res.status(400).json({...}) ya lo trae puesto.
const handler = (verbo, ruta) => {
  const i = ROUTER.indexOf("router." + verbo + "('" + ruta + "'");
  assert.ok(i > 0, 'no existe el endpoint ' + verbo.toUpperCase() + ' ' + ruta);
  const j = ROUTER.indexOf('\nrouter.', i + 1);
  return ROUTER.slice(i, j > i ? j : ROUTER.length);
};
// Una función del JS de la pantalla. Se juntan sus strings concatenados por la misma
// razón que los del manual: dónde cae cada corte de línea es incidental.
const fn = (nombre) => trozo(PANEL, 'function ' + nombre + '(', '\r\n}')
  .replace(/'\s*\r?\n\s*\+ '/g, '');

// ── Una agenda de prueba: una finca con DOS personas, que es el caso del manual ──
// La base se arma corriendo EL MÓDULO ENTERO, no el trozo del db.exec(): hay índices que se
// crean después, en su propio try, porque no pueden existir antes de que la migración funda
// los duplicados. Un test que arma la base a mano termina describiendo una base que no
// existe — y este test lo descubrió solo, con una mutación que pasaba en verde.
function vacia() {
  const db = new DatabaseSync(':memory:');
  globalThis.__dbMan = db;
  new Function(BASE.replace('import db from "./db.js";', 'const db = globalThis.__dbMan;')
                   .replace(/export default db;\s*$/, ''))();
  return db;
}
const cols = (t) => vacia().prepare('SELECT name FROM pragma_table_info(?)').all(t).map((r) => r.name);

function agenda() {
  const db = vacia();
  const emp = Number(db.prepare(`INSERT INTO sg_contacto_empresas
    (nombre,tipo,zona,localidad,proveedor_nombre,vendedor,etiquetas)
    VALUES ('GIGLIO HNOS SRL','proveedor','San Juan','Pocito','GIGLIO','ANA','confiable, paga a 30')`)
    .run().lastInsertRowid);
  db.prepare("INSERT INTO sg_contacto_productos (empresa_id,producto,meses) VALUES (?,'MELON','000011111000')").run(emp);
  const ins = db.prepare(
    "INSERT INTO sg_contactos (nombre,empresa_id,empresa,cargo,notas) VALUES (?,?,'GIGLIO HNOS SRL',?,?)");
  const juan = Number(ins.run('Juan Giglio', emp, 'Dueño', null).lastInsertRowid);
  const pepe = Number(ins.run('Pepe Giglio', emp, 'Encargado', 'Atiende el galpón').lastInsertRowid);
  db.prepare("INSERT INTO sg_contacto_medios (contacto_id,tipo,valor,preferido) VALUES (?,'telefono','264 422-1100',1)").run(juan);
  db.prepare(`INSERT INTO sg_contacto_charlas (contacto_id,fecha,canal,resumen,proximo_paso,proximo_el)
    VALUES (?,'2026-08-20','whatsapp','Me contó que este año planta más brócoli.','Pedirle precio','2026-09-05')`).run(pepe);
  return { db, emp, juan, pepe };
}

// ── 1 · EXISTE Y SE PUEDE ABRIR ────────────────────────────────────────────

test('la pantalla tiene su botón, y la clave es la que el botón busca', () => {
  // Si la clave no coincide, sgManualAbrir contesta «todavía no hay manual de
  // esta pantalla» y el manual queda escrito pero inalcanzable.
  const cab = trozo(PANEL, '<div class="ph">\r\n    <div><div class="ph-t">📇 Contactos comerciales', '</div>\r\n  </div>');
  assert.match(cab, /onclick="sgManualAbrir\('contactos'\)"/);
  assert.match(PANEL, /SG_MANUAL\.contactos = \{ titulo: 'Contactos comerciales'/);
});

test('lo que cambió lleva el V### del PR que lo cambió', () => {
  // Sin la versión, dos meses después no se sabe si el párrafo describe la
  // pantalla de hoy o la de antes del cambio.
  assert.ok((MANUAL.match(/class="ver">V1091</g) || []).length >= 5,
    'faltan las marcas de la versión nueva: ' + (MANUAL.match(/class="ver">V\d+</g) || []).join(' '));
  // Y lo que NO cambió conserva la suya: repintar todo con el V de hoy borra la
  // historia de cuándo se tocó cada cosa.
  assert.ok(MANUAL.includes('V1090'), 'se perdieron las versiones anteriores');
});

// ── 2 · LOS DOS NIVELES ────────────────────────────────────────────────────

test('AFIRMA QUE SON DOS NIVELES: así está la base', () => {
  assert.match(MANUAL, /Dos niveles: la EMPRESA y la PERSONA/);
  assert.match(MANUAL, /Es con la empresa que se hacen los negocios/);
  assert.match(BASE, /CREATE TABLE IF NOT EXISTS sg_contacto_empresas/);
  assert.match(BASE, /empresa_id\s+INTEGER/);
});

test('AFIRMA QUE VARIAS PERSONAS COMPARTEN LA MISMA EMPRESA', () => {
  assert.match(MANUAL, /Varias personas comparten la misma empresa/);
  const { db, emp, juan, pepe } = agenda();
  assert.equal(ficha(db, juan).empresa_id, emp);
  assert.equal(ficha(db, pepe).empresa_id, emp);
  assert.equal(fichaEmpresa(db, emp).personas.length, 2);
});

test('AFIRMA QUE LO QUE PRODUCE SE CARGA UNA SOLA VEZ — y los dos lo ven', () => {
  // Es el cambio entero. Si el producto volviera a colgar de la persona, el
  // párrafo quedaría prometiendo justo lo que se rompió.
  assert.match(MANUAL, /lo que la finca produce se carga una sola vez/);
  assert.ok(cols('sg_contacto_productos').includes('empresa_id'));
  assert.ok(!cols('sg_contacto_productos').includes('contacto_id'),
    'el producto volvió a colgar de la persona');
  const { db, emp, juan, pepe } = agenda();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contacto_productos').get().n, 1);
  assert.equal(ficha(db, juan).productos[0].id, ficha(db, pepe).productos[0].id);
  // Y corregir la ventana una vez alcanza para los dos.
  db.prepare("UPDATE sg_contacto_productos SET meses='000011111100' WHERE empresa_id=?").run(emp);
  assert.equal(ficha(db, juan).productos[0].ventana, 'NOV a ABR');
  assert.equal(ficha(db, pepe).productos[0].ventana, 'NOV a ABR');
});

test('afirma que escribir el nombre CAE EN LA EMPRESA QUE YA EXISTE', () => {
  // Es lo que hace que cargar al segundo contacto de una finca no arme una ficha
  // nueva. Si fallara, a los tres meses habría tres Giglios con un tercio de las
  // charlas cada uno — exactamente lo que el módulo viene a evitar.
  assert.match(MANUAL, /Si ya está cargada, cae en esa misma/);
  assert.match(MANUAL, /sin importar las mayúsculas ni las tildes/);
  const { db, emp } = agenda();
  assert.equal(empresaPorNombre(db, 'GIGLIO HNOS SRL').id, emp);
  assert.equal(empresaPorNombre(db, 'giglio hnos srl').id, emp);
  assert.equal(empresaPorNombre(db, '  Giglio Hnos Srl  ').id, emp);
  // Y el alta lo usa, no sólo existe la función.
  assert.match(handler('post', '/'), /empresaDeNombre\(txt\(b\.empresa\) \|\| nombre/);
});

test('CREAR DOS FICHAS DE LA MISMA FINCA SE RECHAZA, y ofrece abrir la que hay', () => {
  // Dos fichas de la misma finca son dos historiales con la mitad de las charlas cada uno,
  // que es justamente lo que este módulo viene a evitar.
  //
  // Lo frenan los dos: la BASE con un índice único —así no entra tampoco por un script de
  // importación— y el ROUTER con un 409 que dice cuál es la que ya está, para que la
  // pantalla pueda ofrecer abrirla. Se clava el camino del `if` y no sólo que el texto
  // exista: anularlo dejaba los strings intactos pero inalcanzables.
  const h = handler('post', '/empresas');
  assert.match(h, /const ya = empresaPorNombre\(db, nombre\);\s*\r?\n\s*if \(ya\) \{/);
  assert.match(h, /status\(409\)/);
  assert.match(h, /empresa_id: ya\.id/, 'el 409 no dice cuál es la que ya está');
  // Y la pantalla usa ese id para ofrecer abrirla, en vez de dejar un alert sin salida.
  assert.match(fn('ctEEmpGuardar'), /e\.datos\.empresa_id/);
  assert.match(fn('ctEEmpGuardar'), /Abrir la que ya está cargada/);
  // La base, por abajo.
  const db = vacia();
  db.prepare("INSERT INTO sg_contacto_empresas (nombre,tipo) VALUES ('GIGLIO HNOS SRL','proveedor')").run();
  assert.throws(() =>
    db.prepare("INSERT INTO sg_contacto_empresas (nombre,tipo) VALUES ('GIGLIO HNOS SRL','cliente')").run(),
    'la base dejó entrar dos fichas con el mismo nombre');
});

test('AFIRMA QUE SIN EMPRESA LA EMPRESA ES LA PERSONA', () => {
  assert.match(MANUAL, /la empresa es la persona/);
  assert.match(MANUAL, /un fletero que trabaja solo/);
  // El alta cae al nombre de la persona cuando no viene empresa.
  assert.match(handler('post', '/'), /empresaDeNombre\(txt\(b\.empresa\) \|\| nombre, b, req\._user\.id\)/);
});

test('AFIRMA QUE CADA FORMULARIO PIDE LO SUYO Y NO LO DEL OTRO', () => {
  // Es la prueba de que los dos niveles no son un adorno: el manual dice que el
  // de la persona no pide la zona y el de la empresa no pide el cargo, y eso se
  // puede verificar en el HTML que arma cada uno.
  assert.match(MANUAL, /el formulario de una persona <b>no pide la zona<\/b>/);
  assert.match(MANUAL, /el de la empresa <b>no pide el cargo<\/b>/);
  const persona = fn('ctEdAbrir').replace(/^[\s\S]*?ct-ed-body/, '');
  assert.match(persona, /ct-ed-nombre/);
  assert.match(persona, /ct-ed-cargo/);
  assert.ok(!/ct-ed-zona/.test(persona), 'el editor de persona pide la zona');
  assert.ok(!/ct-ed-tipo/.test(persona), 'el editor de persona pide el tipo');
  const empresa = fn('ctEEmpAbrir').replace(/^[\s\S]*?ct-eemp-body/, '');
  assert.match(empresa, /ct-ee-zona/);
  assert.match(empresa, /ct-ee-tipo/);
  assert.ok(!/ct-ee-cargo/.test(empresa), 'el editor de empresa pide el cargo');
  // Y en el backend igual: los campos de cada uno son listas separadas.
  assert.match(ROUTER, /const CAMPOS = \['nombre', 'cargo', 'notas'\]/);
  assert.match(ROUTER, /const CAMPOS_EMP = \['nombre', 'tipo', 'zona', 'localidad',/);
});

test('afirma que la ficha de la persona muestra lo de la empresa APARTE, con su aviso', () => {
  assert.match(MANUAL, /muestra lo de su empresa en un bloque aparte/);
  assert.match(MANUAL, /con el aviso de que eso es de la cuenta y no de ella/);
  const f = fn('ctPintarFicha');
  assert.match(f, /<h4>Su empresa/);
  assert.match(f, /lo de acá es de la cuenta/);
  assert.match(f, /Ver la empresa/);
  // Y la respuesta trae los dos niveles separados, no aplanados.
  const { db, juan } = agenda();
  const d = ficha(db, juan);
  assert.ok(d.empresa, 'la ficha no trae la empresa');
  assert.equal(d.tipo, undefined, 'el tipo quedó también al nivel de la persona');
  assert.equal(d.zona, undefined, 'la zona quedó también al nivel de la persona');
});

test('afirma que lista QUIÉN MÁS TRABAJA AHÍ, con su teléfono y un clic', () => {
  assert.match(MANUAL, /lista <b>quién más trabaja ahí<\/b>, con su teléfono y un clic/);
  const f = fn('ctPintarFicha');
  assert.match(f, /Quién más trabaja ahí/);
  assert.match(f, /ctAbrir\(/);
  const { db, juan, pepe } = agenda();
  const otro = ficha(db, juan).empresa.personas.find((p) => p.id === pepe);
  assert.equal(otro.nombre, 'Pepe Giglio');
  assert.equal(otro.cargo, 'Encargado');
  assert.ok('medio_principal' in otro, 'las personas de la empresa no traen el teléfono');
});

// ── 3 · EL BUSCADOR ────────────────────────────────────────────────────────

test('promete buscar en los DOS niveles, incluido el texto de las charlas', () => {
  assert.match(MANUAL, /los dos niveles a la vez/);
  assert.match(MANUAL, /el texto de las charlas/);
  const { db } = agenda();
  const uno = (q) => buscar(db, { q }).length;
  assert.equal(uno('Pepe'),      1, 'por el nombre de la persona');
  assert.equal(uno('GIGLIO H'),  2, 'por el de la empresa: trae a toda su gente');
  assert.equal(uno('422-1100'),  1, 'por un pedazo del teléfono');
  assert.equal(uno('MELON'),     2, 'por lo que produce la empresa');
  assert.equal(uno('San Juan'),  2, 'por zona');
  assert.equal(uno('Pocito'),    2, 'por localidad');
  assert.equal(uno('Encargado'), 1, 'por cargo');
  assert.equal(uno('paga a 30'), 2, 'por etiqueta');
  assert.equal(uno('galpón'),    1, 'por las notas de la persona');
  assert.equal(uno('brócoli'),   1, 'por el texto de una charla');
});

test('EL CASO DEL MANUAL, literal: "brocoli" encuentra al que lo dijo en una charla', () => {
  // Es el ejemplo que el manual usa para explicar de qué sirve el módulo.
  assert.match(MANUAL, /buscar <i>brocoli<\/i> encuentra al productor/);
  const { db, pepe } = agenda();
  const r = buscar(db, { q: 'brocoli' });       // SIN tilde, como lo tipea cualquiera
  assert.deepEqual(r.map((x) => x.id), [pepe]);
  assert.ok(r[0].porque.includes('una charla'));
  assert.ok(r[0].charla_match, 'el manual dice que muestra el pedacito');
  assert.match(r[0].charla_match.extracto, /brócoli/);
  assert.equal(r[0].charla_match.fecha, '2026-08-20', 'el manual dice que muestra la fecha');
});

test('afirma que al que escribe "giglio" o "melon" no le importa de qué nivel es', () => {
  assert.match(MANUAL, /no sabe ni le importa si eso es de la persona o de la finca/);
  const { db } = agenda();
  // Las dos búsquedas tienen que traer a quién llamar, no un error ni una lista vacía.
  assert.equal(buscar(db, { q: 'giglio' }).length, 2);
  assert.equal(buscar(db, { q: 'melon' }).length, 2);
});

test('afirma que no hacen falta las tildes: los tres ejemplos del texto', () => {
  assert.match(MANUAL, /No hace falta poner tildes/);
  const { db } = agenda();
  const e = Number(db.prepare(
    "INSERT INTO sg_contacto_empresas (nombre,tipo,zona) VALUES ('FINCA X','proveedor','Córdoba')")
    .run().lastInsertRowid);
  db.prepare("INSERT INTO sg_contacto_productos (empresa_id,producto,meses) VALUES (?,'LIMÓN','000011111000')").run(e);
  db.prepare("INSERT INTO sg_contactos (nombre,empresa_id) VALUES ('Productor X',?)").run(e);
  assert.equal(buscar(db, { q: 'brocoli' }).length, 1, 'brocoli → brócoli');
  assert.equal(buscar(db, { q: 'limon'   }).length, 1, 'limon → Limón');
  assert.equal(buscar(db, { q: 'cordoba' }).length, 1, 'cordoba → Córdoba');
});

test('afirma que una lista vacía LO DICE y enumera dónde buscó', () => {
  assert.match(MANUAL, /lo dice y enumera dónde buscó/);
  // El cartel está en la pantalla, no en el manual: es lo que el operador lee.
  const js = fn('ctPintarLista');
  assert.match(js, /Nadie con eso/);
  assert.match(js, /el texto de las charlas/);
  assert.ok(!/innerHTML = ''/.test(js), 'la lista vacía no puede quedar en blanco');
});

test('afirma que cada fila dice POR DÓNDE: son esos cinco motivos', () => {
  for (const m of ['nombre', 'teléfono o mail', 'lo que produce', 'una charla',
                   'zona, etiqueta o nota']) {
    assert.ok(MANUAL.includes(m), 'el manual no nombra el motivo «' + m + '»');
    assert.ok(SERV.includes("'" + m + "'"), 'el servicio no devuelve el motivo «' + m + '»');
  }
});

// ── 4 · LA SOLAPA DE EMPRESAS ──────────────────────────────────────────────

test('AFIRMA QUE "QUIÉN TIENE MELÓN EN NOVIEMBRE" DA UNA FILA POR FINCA', () => {
  // Contestarla con dos filas de Giglio —una por persona— es contestarla mal, y es
  // justamente lo que pasaba antes del cambio.
  assert.match(MANUAL, /contesta con <b>una fila por finca<\/b>/);
  const { db } = agenda();
  const r = buscarEmpresas(db, { mes: 5 });
  assert.equal(r.length, 1, 'devolvió ' + r.length + ' filas para una sola finca');
  assert.equal(r[0].nombre, 'GIGLIO HNOS SRL');
  assert.equal(r[0].personas, 2, 'la fila no dice cuántas personas tiene');
  // Y la vista por persona sigue devolviendo las dos: son dos teléfonos distintos.
  assert.equal(buscar(db, { mes: 5 }).length, 2);
});

test('afirma que se puede buscar una empresa por el nombre de alguien que trabaja ahí', () => {
  assert.match(MANUAL, /el nombre de cualquiera que trabaje ahí/);
  const { db } = agenda();
  assert.deepEqual(buscarEmpresas(db, { q: 'Pepe' }).map((e) => e.nombre), ['GIGLIO HNOS SRL']);
});

test('afirma que el mismo producto NO entra dos veces en la misma empresa', () => {
  assert.match(MANUAL, /El mismo producto no se puede cargar dos veces en la misma empresa/);
  assert.match(MANUAL, /ofrece corregir esa ventana/);
  // Lo frena el router, con 409 y diciendo cuál corregir…
  const h = handler('post', '/empresas/:id/productos');
  // Se clava EL CAMINO, no sólo que el texto exista en el archivo: anular ese `if` dejaba
  // los dos strings intactos pero INALCANZABLES, y el test pasaba en verde. Los datos ahora
  // los protege el índice único de la base, así que lo que se rompería es justo lo que el
  // manual promete — el aviso que dice qué hacer, en vez de un error de SQLite en la cara.
  assert.match(h, /if \(ya\) \{\s*\r?\n\s*return res\.status\(409\)/);
  assert.match(h, /corregí esa ventana en vez de agregar otra/);
  // …Y LO FRENA LA BASE. El router solo no alcanza: anular ese `if` dejaba este test en
  // verde, porque mirar el texto del router no es mirar lo que pasa. Y un chequeo que vive
  // sólo ahí no cubre lo que entra por abajo: un script de importación o una corrección a
  // mano.
  const { db, emp } = agenda();
  assert.throws(() => db.prepare(
    "INSERT INTO sg_contacto_productos (empresa_id,producto,meses) VALUES (?,'MELON','000001111100')")
    .run(emp), 'la base dejó entrar el segundo melón de la misma finca');
  // Pero el mismo producto en OTRA finca sí entra: dos fincas pueden tener melón.
  const otra = Number(db.prepare(
    "INSERT INTO sg_contacto_empresas (nombre,tipo) VALUES ('OTRA FINCA SA','proveedor')")
    .run().lastInsertRowid);
  assert.doesNotThrow(() => db.prepare(
    "INSERT INTO sg_contacto_productos (empresa_id,producto,meses) VALUES (?,'MELON','000001111100')")
    .run(otra));
  // Y la pantalla, al recibirlo, abre el que ya está en vez de dejar un alert suelto.
  assert.match(fn('ctPrGuardar'), /e\.datos\.producto_id/);
});

// ── 5 · LOS MESES ──────────────────────────────────────────────────────────

test('AFIRMA QUE EL PRIMER CASILLERO ES JULIO', () => {
  // Es la afirmación más peligrosa del manual: leída como enero, un productor
  // de melón pasa a ser de invierno y nada avisa.
  assert.match(MANUAL, /el año arranca en JULIO/);
  assert.equal(ventanaEnPalabras('100000000000'), 'JUL');
  assert.match(PANEL, /const CT_MESES = \['JUL',/);
  assert.match(PANEL, /const CT_MESES_LARGO = \['Julio',/);
  assert.match(SERV, /export const MESES = \['JUL',/);
});

test('afirma que NOV a MAR se escribe así, y que dos tramos se dicen como dos', () => {
  assert.match(MANUAL, /<i>NOV a MAR<\/i>/);
  assert.equal(ventanaEnPalabras('000011111000'), 'NOV a MAR');
  assert.match(MANUAL, /<i>JUL a AGO y MAY a JUN<\/i>/);
  assert.equal(ventanaEnPalabras('110000000011'), 'JUL a AGO y MAY a JUN');
});

test('afirma que se tocan de a uno y NO hay desde/hasta', () => {
  assert.match(MANUAL, /no se elige un «desde» y un «hasta»/);
  // Si alguien cambiara la máscara por dos fechas, la promesa de las dos
  // ventanas se rompe. La columna tiene que seguir siendo la máscara de doce.
  assert.match(BASE, /meses\s+TEXT NOT NULL DEFAULT '000000000000'/);
  assert.ok(!/meses_desde|meses_hasta/.test(BASE), 'apareció un desde/hasta');
  assert.match(PANEL, /onclick="ctPrTocar\(/);
});

test('afirma que los productos se cargan EN LA FICHA DE LA EMPRESA', () => {
  assert.match(MANUAL, /Se carga <b>en la ficha de la EMPRESA<\/b>, una vez para toda la finca/);
  // La dirección cuelga de la empresa, y la pantalla lo dice donde se carga.
  assert.ok(ROUTER.includes("router.post('/empresas/:id/productos'"));
  assert.ok(!/router\.post\('\/:id\/productos'/.test(ROUTER),
    'volvió la dirección que cuelga el producto de la persona');
  assert.match(fn('ctPrAbrir'), /no de una persona/);
  assert.match(fn('ctPintarEmpresa'), /Se carga una vez para toda la empresa/);
});

// ── 6 · DECLARADO vs OBSERVADO ─────────────────────────────────────────────

test('afirma que lo observado SALE DE LAS VENTAS y nadie lo tipea', () => {
  assert.match(MANUAL, /Sale de las ventas: nadie lo tipea/);
  assert.match(SERV, /FROM sheet_ventas/);
  // Lo trae el GET de la ficha, sin pedirle nada al operador — y por el vínculo de
  // LA EMPRESA, que es la que factura.
  assert.match(handler('get', '/:id'), /observadoProveedor\(db, e\.proveedor_nombre\)/);
  assert.match(handler('get', '/empresas/:id'), /observadoProveedor\(db, e\.proveedor_nombre\)/);
});

test('afirma que el vínculo con la planilla ES DE LA EMPRESA', () => {
  assert.match(MANUAL, /Se carga <b>en la ficha de la empresa<\/b> —es la finca la que factura/);
  assert.ok(cols('sg_contacto_empresas').includes('proveedor_nombre'));
  assert.ok(cols('sg_contacto_empresas').includes('cliente_nombre'));
  assert.ok(!cols('sg_contactos').includes('proveedor_nombre'),
    'la persona volvió a tener su propio vínculo con la planilla');
  // Por NOMBRE y no por id: es como se vincula todo lo comercial en este sistema.
  assert.ok(!/cliente_id|proveedor_id/.test(BASE), 'apareció un id donde el manual dice nombre');
});

test('afirma que las dos ventanas se comparan: usan la MISMA convención', () => {
  // Si una arrancara en enero y la otra en julio, las dos franjas se dibujarían
  // corridas seis meses y las dos se verían plausibles.
  const { db, emp } = agenda();
  db.exec(`CREATE TABLE sheet_ventas (cliente TEXT, producto TEXT, proveedor TEXT,
           periodo TEXT, mes_ok TEXT, kilos_tot REAL, tot_dol REAL)`);
  db.prepare("INSERT INTO sheet_ventas VALUES ('COTO','MELON','GIGLIO','2025-2026','05-NOVIEMBRE',5000,10000)").run();
  const declarado = fichaEmpresa(db, emp).productos[0];
  const observado = observadoProveedor(db, 'GIGLIO').productos[0];
  assert.equal(declarado.meses.length, 12);
  assert.equal(observado.meses.length, 12);
  assert.equal(observado.meses[4], '1', 'noviembre es la quinta posición en las dos');
  assert.equal(observado.ventana, 'NOV');
});

test('AFIRMA EL CUADRO AMARILLO: ofrece y nunca le compramos', () => {
  assert.match(MANUAL, /⭐ Ofrece y nunca le compramos/);
  assert.match(fn('ctBloquesObservado'), /Ofrece y nunca le compramos/);
  const { db, emp, juan, pepe } = agenda();
  db.exec(`CREATE TABLE sheet_ventas (cliente TEXT, producto TEXT, proveedor TEXT,
           periodo TEXT, mes_ok TEXT, kilos_tot REAL, tot_dol REAL)`);
  db.prepare("INSERT INTO sheet_ventas VALUES ('COTO','MELON','GIGLIO','2025-2026','05-NOVIEMBRE',5000,10000)").run();
  assert.deepEqual(ofreceYNoLeCompramos(fichaEmpresa(db, emp).productos,
    observadoProveedor(db, 'GIGLIO')), []);
  db.prepare("INSERT INTO sg_contacto_productos (empresa_id,producto,meses) VALUES (?,'BROCOLI','000111000000')").run(emp);
  const hueco = ofreceYNoLeCompramos(fichaEmpresa(db, emp).productos, observadoProveedor(db, 'GIGLIO'));
  assert.deepEqual(hueco.map((x) => x.producto), ['BROCOLI']);
  assert.equal(hueco[0].ventana, 'OCT a DIC', 'el manual dice "con nombre y ventana"');
  // Y se ve desde la ficha de CUALQUIERA de las dos personas: la oportunidad es de
  // la finca, no del dueño ni del encargado.
  for (const quien of [juan, pepe]) {
    const f = ficha(db, quien);
    assert.deepEqual(ofreceYNoLeCompramos(f.productos,
      observadoProveedor(db, f.empresa.proveedor_nombre)).map((x) => x.producto), ['BROCOLI']);
  }
});

test('AFIRMA QUE NO MUESTRA CERO cuando el nombre no coincide', () => {
  // Es la diferencia entre «no trajo nada» y «el nombre no es el de la planilla».
  // Un cero se lee como lo primero y manda a alguien a reclamarle a un productor
  // que sí trajo.
  assert.match(MANUAL, /No muestra cero/);
  assert.match(MANUAL, /el nombre no es el que usa la planilla/);
  const { db } = agenda();
  db.exec(`CREATE TABLE sheet_ventas (cliente TEXT, producto TEXT, proveedor TEXT,
           periodo TEXT, mes_ok TEXT, kilos_tot REAL, tot_dol REAL)`);
  assert.equal(observadoProveedor(db, 'NOMBRE QUE NO EXISTE').sin_datos, true,
    'tiene que decir sin_datos, no devolver una lista vacía a secas');
  const js = fn('ctBloquesObservado');
  assert.match(js, /compras\.sin_datos/);
  assert.match(js, /el nombre no es el que usa la planilla/);
});

// ── 7 · LAS CHARLAS ────────────────────────────────────────────────────────

test('afirma los cuatro canales, y que queda quién la cargó', () => {
  for (const c of ['teléfono', 'WhatsApp', 'mail', 'visita']) {
    assert.ok(MANUAL.toLowerCase().includes(c.toLowerCase()), 'falta el canal ' + c);
  }
  assert.match(SERV, /CANALES = \['telefono', ?'whatsapp', ?'mail', ?'visita', ?'otro'\]/);
  assert.match(MANUAL, /Queda guardado <b>quién la cargó<\/b>/);
  assert.match(ROUTER, /req\._user\.nombre \|\| null/);
});

test('AFIRMA QUE LA CHARLA ES DE LA PERSONA Y EL HISTORIAL DE LA CUENTA', () => {
  assert.match(MANUAL, /La charla es de la persona<\/b>.{0,80}historial es de la cuenta/s);
  assert.match(MANUAL, /no se le puede atribuir a uno lo que dijo el otro/);
  const { db, emp, juan, pepe } = agenda();
  db.prepare("INSERT INTO sg_contacto_charlas (contacto_id,fecha,canal,resumen) VALUES (?,'2026-08-25','telefono','Precio del melón')").run(juan);
  // Las de la persona, y aparte las de sus compañeros, cada una con quién fue.
  const f = ficha(db, juan);
  assert.equal(f.charlas.length, 1);
  assert.equal(f.charlas_empresa.length, 1);
  assert.equal(f.charlas_empresa[0].con_quien, 'Pepe Giglio', 'no dice con quién fue');
  // Y la de la empresa las junta todas.
  const todas = charlasDeEmpresa(db, emp);
  assert.equal(todas.length, 2);
  assert.ok(todas.every((c) => c.con_quien), 'alguna charla de la cuenta no dice con quién fue');
  // La pantalla lo dibuja así en los tres lugares.
  assert.match(fn('ctPintarFicha'), /lo que se habló con los otros de/);
  assert.match(fn('ctPintarEmpresa'), /Todo lo que se habló con/);
});

test('afirma que el buscador mira el texto de la charla — y lo avisa al escribirla', () => {
  assert.match(MANUAL, /El buscador mira este texto/);
  // No alcanza con que el manual lo diga: tiene que estar escrito donde se
  // tipea, que es donde cambia cómo se redacta la nota.
  const js = fn('ctChNuevo');
  assert.match(js, /El buscador mira este texto/);
  assert.match(js, /quién me habló de brócoli/);
});

// ── 8 · ME TOCA ────────────────────────────────────────────────────────────

test('afirma que sólo entra a la bandeja lo que tiene PASO y FECHA', () => {
  assert.match(MANUAL, /sin fecha<\/b> no entra a la bandeja/);
  const { db, pepe } = agenda();
  assert.equal(pendientes(db, '2026-12-31').length, 1);
  db.prepare("INSERT INTO sg_contacto_charlas (contacto_id,fecha,canal,resumen) VALUES (?,'2026-08-01','telefono','Nada concreto')").run(pepe);
  assert.equal(pendientes(db, '2026-12-31').length, 1, 'una charla sin paso entró a la bandeja');
  db.prepare("INSERT INTO sg_contacto_charlas (contacto_id,fecha,canal,resumen,proximo_paso) VALUES (?,'2026-08-02','telefono','Vernos','Visitarlo')").run(pepe);
  assert.equal(pendientes(db, '2026-12-31').length, 1, 'un paso sin fecha entró a la bandeja');
  assert.equal(ficha(db, pepe).pendientes.length, 2,
    'el manual dice que sin fecha igual se ve en la ficha');
});

test('LA BANDEJA DICE LA EMPRESA, que es lo que uno reconoce', () => {
  // «Pepe Giglio» a secas no le dice nada a nadie; «Pepe Giglio, GIGLIO HNOS» sí.
  assert.match(MANUAL, /Me toca<\/b>/);
  const { db, emp } = agenda();
  const p = pendientes(db, '2026-12-31')[0];
  assert.equal(p.empresa, 'GIGLIO HNOS SRL');
  assert.equal(p.empresa_id, emp);
  assert.equal(p.cargo, 'Encargado');
  assert.match(fn('ctPendientes'), /ctEmpAbrir\(/);
});

test('afirma que ✓ Hecho lo saca de la bandeja y NO borra la charla', () => {
  assert.match(MANUAL, /La charla no se borra/);
  const { db, pepe } = agenda();
  db.prepare("UPDATE sg_contacto_charlas SET hecho_en = '2026-09-01' WHERE contacto_id = ?").run(pepe);
  assert.equal(pendientes(db, '2026-12-31').length, 0);
  assert.equal(ficha(db, pepe).charlas.length, 1, 'la charla desapareció de la ficha');
  assert.equal(ficha(db, pepe).pendientes.length, 0);
});

test('afirma que lo pendiente se ve TAMBIÉN en la lista del buscador', () => {
  assert.match(MANUAL, /se ve también en la lista del buscador/);
  const { db, pepe } = agenda();
  assert.equal(buscar(db, { q: 'Pepe' })[0].pendientes, 1,
    'la fila del buscador no trae la cuenta de pendientes');
  assert.match(PANEL, /ct-chip ct-pend/);
  // Y cuenta LO MISMO que la bandeja, que es otro camino de código: el contador de la
  // lista es una subconsulta dentro de buscar(), y la bandeja es pendientes(). Encontrado
  // mutando: romper la condición de la subconsulta dejaba el test en verde.
  db.prepare("INSERT INTO sg_contacto_charlas (contacto_id,fecha,canal,resumen) VALUES (?,'2026-08-01','telefono','Nada concreto')").run(pepe);
  assert.equal(buscar(db, { q: 'Pepe' })[0].pendientes, 1,
    'una charla SIN próximo paso se contó como pendiente en la lista');
  db.prepare("UPDATE sg_contacto_charlas SET hecho_en = '2026-09-01' WHERE proximo_paso IS NOT NULL").run();
  assert.equal(buscar(db, { q: 'Pepe' })[0].pendientes, 0, 'lo marcado hecho siguió contando');
  assert.equal(pendientes(db, '2026-12-31').length, 0, 'y tampoco en la bandeja');
});

// ── 9 · LOS MEDIOS ─────────────────────────────────────────────────────────

test('afirma que hay UN SOLO preferido y que marcar otro le saca la estrella', () => {
  assert.match(MANUAL, /Hay uno solo<\/b>: marcar otro le saca la estrella al/);
  const pref = handler('post', '/:id/medios/:mid/preferido');
  assert.match(pref, /UPDATE sg_contacto_medios SET preferido = 0 WHERE contacto_id = \?/);
  const alta = handler('post', '/:id/medios');
  assert.match(alta, /if \(b\.preferido\) db\.prepare\('UPDATE sg_contacto_medios SET preferido = 0/);
});

test('afirma que el preferido es el que muestran la lista y la bandeja', () => {
  assert.match(MANUAL, /es el que muestra la lista y el que trae la bandeja/);
  const { db, juan } = agenda();
  db.prepare("INSERT INTO sg_contacto_medios (contacto_id,tipo,valor,preferido) VALUES (?,'telefono','000 000-0000',0)").run(juan);
  assert.equal(buscar(db, { q: 'Juan Giglio' })[0].medio_principal, '264 422-1100');
  // Y en la ficha de la empresa, que es donde se pregunta «a quién llamo».
  assert.equal(fichaEmpresa(db, ficha(db, juan).empresa_id).personas
    .find((p) => p.id === juan).medio_principal, '264 422-1100');
});

test('afirma que lo que tiene arroba se guarda como mail', () => {
  assert.match(MANUAL, /lo que tiene <b>arroba<\/b> se guarda como mail/);
  assert.match(fn('ctMedioNuevo'), /valor\.includes\('@'\) \? 'mail' : 'telefono'/);
});

// ── 10 · LOS TIPOS ─────────────────────────────────────────────────────────

test('AFIRMA QUE "PROVEEDOR" TRAE TAMBIÉN A LOS QUE SON AMBOS', () => {
  assert.match(MANUAL, /trae también a los que son <b>las dos cosas<\/b>/);
  const { db } = agenda();
  const e = Number(db.prepare(
    "INSERT INTO sg_contacto_empresas (nombre,tipo) VALUES ('SOSA SA','ambos')").run().lastInsertRowid);
  db.prepare("INSERT INTO sg_contactos (nombre,empresa_id) VALUES ('Pedro Sosa',?)").run(e);
  assert.deepEqual(buscar(db, { tipo: 'proveedor' }).map((x) => x.nombre).sort(),
    ['Juan Giglio', 'Pedro Sosa', 'Pepe Giglio']);
  assert.deepEqual(buscar(db, { tipo: 'cliente' }).map((x) => x.nombre), ['Pedro Sosa']);
  // Y en la vista por empresa igual.
  assert.deepEqual(buscarEmpresas(db, { tipo: 'cliente' }).map((x) => x.nombre), ['SOSA SA']);
});

test('afirma que "otro" existe para el transportista o el laboratorio', () => {
  assert.match(MANUAL, /para el transportista o el técnico|transportista o un laboratorio/);
  assert.match(SERV, /TIPOS = \['cliente', ?'proveedor', ?'ambos', ?'otro'\]/);
  assert.match(BASE, /tipo\s+TEXT NOT NULL DEFAULT 'otro'/);
});

// ── 11 · LA BAJA ───────────────────────────────────────────────────────────

test('AFIRMA QUE DAR DE BAJA UNA EMPRESA SE LLEVA A SU GENTE', () => {
  assert.match(MANUAL, /Dar de baja una EMPRESA se lleva a su gente<\/b> de las listas del día/);
  assert.match(MANUAL, /No borra nada/);
  const { db, emp } = agenda();
  assert.equal(buscar(db, { q: 'giglio' }).length, 2);
  db.prepare("UPDATE sg_contacto_empresas SET eliminado_en = datetime('now') WHERE id = ?").run(emp);
  assert.equal(buscar(db, { q: 'giglio' }).length, 0, 'la gente de la finca siguió apareciendo');
  // Y nada se borró.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contactos').get().n, 2);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM sg_contacto_charlas').get().n > 0);
  // Es soft delete, no DELETE.
  assert.match(handler('post', '/empresas/:id/eliminar'),
    /UPDATE sg_contacto_empresas SET eliminado_en = datetime/);
  assert.ok(!/DELETE FROM sg_contacto_empresas/.test(ROUTER), 'apareció un DELETE de la empresa');
});

test('renombrar la finca REESCRIBE la copia que guarda cada persona', () => {
  // El nombre de la empresa está denormalizado en sg_contactos.empresa (para que el
  // buscador mire una sola tabla y la bandeja no necesite un join más). Si se renombra la
  // finca y no se reescribe ahí, la copia queda vieja: hoy casi no se nota porque las
  // listas leen el JOIN, y por eso mismo es una trampa — el día que alguien use la copia,
  // va a leer el nombre de hace seis meses.
  assert.match(BASE, /El nombre de la empresa, DENORMALIZADO/);
  assert.match(handler('patch', '/empresas/:id'),
    /UPDATE sg_contactos SET empresa = \? WHERE empresa_id = \?/);
});

test('afirma que el nombre de una empresa dada de baja QUEDA LIBRE', () => {
  assert.match(MANUAL, /el nombre de la empresa queda libre/);
  const { db, emp } = agenda();
  db.prepare("UPDATE sg_contacto_empresas SET eliminado_en = datetime('now') WHERE id = ?").run(emp);
  assert.equal(empresaPorNombre(db, 'GIGLIO HNOS SRL'), null);
});

test('AFIRMA QUE LA BAJA DE UNA PERSONA ESCONDE Y LAS CHARLAS QUEDAN', () => {
  assert.match(MANUAL, /las charlas quedan guardadas/);
  assert.match(MANUAL, /la baja esconde y no borra/);
  const { db, juan } = agenda();
  const baja = handler('post', '/:id/eliminar');
  assert.match(baja, /UPDATE sg_contactos SET eliminado_en = datetime/);
  assert.ok(!/DELETE FROM sg_contactos/.test(ROUTER), 'apareció un DELETE del contacto');
  db.prepare("UPDATE sg_contactos SET eliminado_en = datetime('now') WHERE id = ?").run(juan);
  assert.equal(buscar(db, { q: 'Juan Giglio' }).length, 0, 'tiene que salir del buscador');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contacto_charlas').get().n, 1,
    'las charlas se perdieron');
});

test('afirma que "ver inactivos" los vuelve a traer', () => {
  assert.match(MANUAL, /ver inactivos/);
  const { db } = agenda();
  db.prepare('UPDATE sg_contactos SET activo = 0').run();
  assert.equal(buscar(db, { q: 'giglio' }).length, 0);
  assert.equal(buscar(db, { q: 'giglio', incluir_inactivos: true }).length, 2);
  assert.match(PANEL, /id="ct-f-inact"/);
});

test('afirma que el aviso dice CUÁNTAS charlas son antes de confirmar', () => {
  assert.match(MANUAL, /el aviso dice cuántas son/);
  assert.match(fn('ctBaja'), /CT_FICHA\.charlas\.length \+ ' charla\(s\) quedan guardadas/);
});
