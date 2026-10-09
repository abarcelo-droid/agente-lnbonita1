// ══ EL «¿CÓMO SE USA?» DE CONTACTOS COMERCIALES ═══════════════════════════
//
// CLAUDE.md: «si modificás algo en el módulo lo agregás al "cómo se usa" con el
// número de versión»; y «si la pantalla NO tiene manual, actualizarlo es
// ESCRIBIRLO».
//
// ESTE TEST NO CONTROLA QUE EL TEXTO EXISTA. Controla que lo que el manual
// AFIRMA siga siendo cierto en el CÓDIGO. Un test que sólo verifica que el
// párrafo está escrito no sirve para nada: lo que hay que clavar es que la
// pantalla siga haciendo lo que el manual promete, porque un manual que va una
// versión atrás es peor que no tenerlo — el operador hace lo que dice y le sale
// mal.
//
// Cada afirmación del manual tiene al lado su assert contra el servicio, el
// router o la pantalla. Se verificó mutando el CÓDIGO: con cada cambio en el
// backend cae el test del manual que lo promete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buscar, ficha, pendientes, ventanaEnPalabras,
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

// Una agenda de prueba para los asserts que necesitan correr el código de verdad.
const DDL = BASE.slice(BASE.indexOf('db.exec(`') + 9, BASE.indexOf('`);'));
function agenda() {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const id = Number(db.prepare(`INSERT INTO sg_contactos
    (nombre,empresa,cargo,tipo,zona,localidad,proveedor_nombre,vendedor,etiquetas)
    VALUES ('Juan Giglio','GIGLIO HNOS SRL','Dueño','proveedor','San Juan','Pocito','GIGLIO','ANA','confiable, paga a 30')`)
    .run().lastInsertRowid);
  db.prepare("INSERT INTO sg_contacto_medios (contacto_id,tipo,valor,preferido) VALUES (?,'telefono','264 422-1100',1)").run(id);
  db.prepare("INSERT INTO sg_contacto_productos (contacto_id,producto,meses) VALUES (?,'MELON','000011111000')").run(id);
  db.prepare(`INSERT INTO sg_contacto_charlas (contacto_id,fecha,canal,resumen,proximo_paso,proximo_el)
    VALUES (?,'2026-08-20','whatsapp','Me contó que este año planta más brócoli.','Pedirle precio','2026-09-05')`).run(id);
  return { db, id };
}

// ── 1 · EXISTE Y SE PUEDE ABRIR ────────────────────────────────────────────

test('la pantalla tiene su botón, y la clave es la que el botón busca', () => {
  // Si la clave no coincide, sgManualAbrir contesta «todavía no hay manual de
  // esta pantalla» y el manual queda escrito pero inalcanzable.
  const cab = trozo(PANEL, '<div class="ph">\r\n    <div><div class="ph-t">📇 Contactos comerciales', '</div>\r\n  </div>');
  assert.match(cab, /onclick="sgManualAbrir\('contactos'\)"/);
  assert.match(PANEL, /SG_MANUAL\.contactos = \{ titulo: 'Contactos comerciales'/);
});

test('lleva el V### del PR que lo escribió', () => {
  // Sin la versión, dos meses después no se sabe si el párrafo describe la
  // pantalla de hoy o la de antes del cambio.
  assert.ok((MANUAL.match(/class="ver">V1090</g) || []).length >= 5,
    'faltan las marcas de versión: ' + (MANUAL.match(/class="ver">V\d+</g) || []).join(' '));
});

// ── 2 · «ACÁ VAN PERSONAS, NO EMPRESAS» ────────────────────────────────────

test('afirma que guarda personas y se vincula al padrón por nombre: así está', () => {
  assert.match(MANUAL, /Acá van PERSONAS, no empresas/);
  assert.match(MANUAL, /se da de baja a la persona y la empresa sigue/);
  // La tabla no tiene cliente_id ni proveedor_id: tiene los NOMBRES. Si mañana
  // alguien la repunta a ids, este assert cae y el párrafo hay que reescribirlo.
  assert.match(BASE, /cliente_nombre\s+TEXT/);
  assert.match(BASE, /proveedor_nombre\s+TEXT/);
  assert.ok(!/cliente_id/.test(BASE), 'apareció un cliente_id: el manual dice que es por nombre');
  assert.ok(!/proveedor_id/.test(BASE), 'apareció un proveedor_id: el manual dice que es por nombre');
});

// ── 3 · EL BUSCADOR ────────────────────────────────────────────────────────

test('promete buscar en nueve lugares, incluido el texto de las charlas', () => {
  assert.match(MANUAL, /el texto de las charlas/);
  const { db } = agenda();
  // Cada cosa que el manual enumera, probada con una búsqueda de verdad.
  const uno = (q) => buscar(db, { q }).length;
  assert.equal(uno('Giglio'),   1, 'por nombre');
  assert.equal(uno('GIGLIO H'), 1, 'por empresa');
  assert.equal(uno('422-1100'), 1, 'por un pedazo del teléfono');
  assert.equal(uno('MELON'),    1, 'por lo que produce');
  assert.equal(uno('San Juan'), 1, 'por zona');
  assert.equal(uno('Pocito'),   1, 'por localidad');
  assert.equal(uno('Dueño'),    1, 'por cargo');
  assert.equal(uno('paga a 30'), 1, 'por etiqueta');
  assert.equal(uno('brócoli'),  1, 'por el texto de una charla');
});

test('EL CASO DEL MANUAL, literal: "brocoli" encuentra al que lo dijo en una charla', () => {
  // Es el ejemplo que el manual usa para explicar de qué sirve el módulo. Si
  // dejara de funcionar, el manual estaría prometiendo lo que más se va a probar.
  assert.match(MANUAL, /buscar <i>brocoli<\/i> encuentra al productor/);
  const { db } = agenda();
  const r = buscar(db, { q: 'brocoli' });       // SIN tilde, como lo tipea cualquiera
  assert.equal(r.length, 1);
  assert.ok(r[0].porque.includes('una charla'));
  assert.ok(r[0].charla_match, 'el manual dice que muestra el pedacito');
  assert.match(r[0].charla_match.extracto, /brócoli/);
  assert.equal(r[0].charla_match.fecha, '2026-08-20', 'el manual dice que muestra la fecha');
});

test('afirma que no hacen falta las tildes: los tres ejemplos del texto', () => {
  assert.match(MANUAL, /No hace falta poner tildes/);
  const { db } = agenda();
  const id = Number(db.prepare(
    "INSERT INTO sg_contactos (nombre,tipo,zona) VALUES ('Productor X','proveedor','Córdoba')")
    .run().lastInsertRowid);
  db.prepare("INSERT INTO sg_contacto_productos (contacto_id,producto,meses) VALUES (?,'LIMÓN','000011111000')").run(id);
  assert.equal(buscar(db, { q: 'brocoli' }).length, 1, 'brocoli → brócoli');
  assert.equal(buscar(db, { q: 'limon'   }).length, 1, 'limon → Limón');
  assert.equal(buscar(db, { q: 'cordoba' }).length, 1, 'cordoba → Córdoba');
});

test('afirma que una lista vacía LO DICE y enumera dónde buscó', () => {
  assert.match(MANUAL, /lo dice y enumera dónde buscó/);
  // El cartel está en la pantalla, no en el manual: es lo que el operador lee.
  const js = trozo(PANEL, 'function ctPintarLista(', '\r\n}');
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

// ── 4 · LOS MESES ──────────────────────────────────────────────────────────

test('AFIRMA QUE EL PRIMER CASILLERO ES JULIO', () => {
  // Es la afirmación más peligrosa del manual: leída como enero, un productor
  // de melón pasa a ser de invierno y nada avisa.
  assert.match(MANUAL, /doce casilleros y el primero es julio/i);
  assert.equal(ventanaEnPalabras('100000000000'), 'JUL');
  // Y la grilla de la pantalla arranca igual.
  assert.match(PANEL, /const CT_MESES = \['JUL',/);
  assert.match(PANEL, /const CT_MESES_LARGO = \['Julio',/);
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

test('afirma que el filtro de mes contesta "quién tiene melón en noviembre"', () => {
  assert.match(MANUAL, /quién tiene melón en noviembre/);
  const { db } = agenda();
  assert.equal(buscar(db, { mes: 5 }).length, 1, 'noviembre es la posición 5');
  assert.equal(buscar(db, { mes: 4 }).length, 0, 'en octubre no tiene nada');
});

// ── 5 · DECLARADO vs OBSERVADO ─────────────────────────────────────────────

test('afirma que lo observado SALE DE LAS VENTAS y nadie lo tipea', () => {
  assert.match(MANUAL, /Sale de las ventas: nadie lo tipea/);
  assert.match(SERV, /FROM sheet_ventas/);
  // Y lo trae el GET de la ficha, sin pedirle nada al operador.
  assert.match(ROUTER, /f\.compras = observadoProveedor\(db, f\.proveedor_nombre\)/);
});

test('afirma que las dos ventanas se comparan: usan la MISMA convención', () => {
  // Si una arrancara en enero y la otra en julio, las dos franjas se dibujarían
  // corridas seis meses y las dos se verían plausibles.
  const { db, id } = agenda();
  db.exec(`CREATE TABLE sheet_ventas (cliente TEXT, producto TEXT, proveedor TEXT,
           periodo TEXT, mes_ok TEXT, kilos_tot REAL, tot_dol REAL)`);
  db.prepare(`INSERT INTO sheet_ventas VALUES
    ('COTO','MELON','GIGLIO','2025-2026','05-NOVIEMBRE',5000,10000)`).run();
  const declarado = ficha(db, id).productos[0];
  const observado = observadoProveedor(db, 'GIGLIO').productos[0];
  assert.equal(declarado.meses.length, 12);
  assert.equal(observado.meses.length, 12);
  assert.equal(observado.meses[4], '1', 'noviembre es la quinta posición en las dos');
  assert.equal(observado.ventana, 'NOV');
});

test('AFIRMA EL CUADRO AMARILLO: ofrece y nunca le compramos', () => {
  assert.match(MANUAL, /⭐ Ofrece y nunca le compramos/);
  assert.match(PANEL, /Ofrece y nunca le compramos/);
  const { db, id } = agenda();
  db.exec(`CREATE TABLE sheet_ventas (cliente TEXT, producto TEXT, proveedor TEXT,
           periodo TEXT, mes_ok TEXT, kilos_tot REAL, tot_dol REAL)`);
  db.prepare(`INSERT INTO sheet_ventas VALUES
    ('COTO','MELON','GIGLIO','2025-2026','05-NOVIEMBRE',5000,10000)`).run();
  // Le compramos el melón que declara: todavía no hay hueco.
  assert.deepEqual(ofreceYNoLeCompramos(ficha(db, id).productos,
    observadoProveedor(db, 'GIGLIO')), []);
  // Declara brócoli y nunca se lo compramos: aparece, con su ventana.
  db.prepare("INSERT INTO sg_contacto_productos (contacto_id,producto,meses) VALUES (?,'BROCOLI','000111000000')").run(id);
  const hueco = ofreceYNoLeCompramos(ficha(db, id).productos, observadoProveedor(db, 'GIGLIO'));
  assert.deepEqual(hueco.map(x => x.producto), ['BROCOLI']);
  assert.equal(hueco[0].ventana, 'OCT a DIC', 'el manual dice que lo dice "con nombre y ventana"');
});

test('AFIRMA QUE NO MUESTRA CERO cuando el nombre no coincide', () => {
  // Es la diferencia entre «no trajo nada» y «el nombre no es el de la
  // planilla». Un cero se lee como lo primero y manda a alguien a reclamarle a
  // un productor que sí trajo.
  assert.match(MANUAL, /No muestra cero/);
  assert.match(MANUAL, /el nombre no es el que usa la planilla/);
  const { db } = agenda();
  db.exec(`CREATE TABLE sheet_ventas (cliente TEXT, producto TEXT, proveedor TEXT,
           periodo TEXT, mes_ok TEXT, kilos_tot REAL, tot_dol REAL)`);
  const o = observadoProveedor(db, 'NOMBRE QUE NO EXISTE');
  assert.equal(o.sin_datos, true, 'tiene que decir sin_datos, no devolver una lista vacía a secas');
  // Y la pantalla usa ese flag para escribir la frase, no un 0.
  const js = trozo(PANEL, 'function ctPintarFicha(', '\r\n}');
  assert.match(js, /compras\.sin_datos/);
  assert.match(js, /el nombre no es el que usa la planilla/);
});

// ── 6 · LAS CHARLAS ────────────────────────────────────────────────────────

test('afirma los cuatro canales, y que queda quién la cargó', () => {
  for (const c of ['teléfono', 'WhatsApp', 'mail', 'visita']) {
    assert.ok(MANUAL.toLowerCase().includes(c.toLowerCase()), 'falta el canal ' + c);
  }
  assert.match(SERV, /CANALES = \['telefono', ?'whatsapp', ?'mail', ?'visita', ?'otro'\]/);
  assert.match(MANUAL, /Queda guardado <b>quién la cargó<\/b>/);
  assert.match(ROUTER, /req\._user\.nombre \|\| null/);
});

test('afirma que el buscador mira el texto de la charla — y lo avisa al escribirla', () => {
  assert.match(MANUAL, /El buscador mira este texto/);
  // No alcanza con que el manual lo diga: tiene que estar escrito donde se
  // tipea, que es donde cambia cómo se redacta la nota.
  const js = trozo(PANEL, 'function ctChNuevo(', '\r\n}');
  assert.match(js, /El buscador mira este texto/);
  assert.match(js, /quién me habló de brócoli/);
});

// ── 7 · ME TOCA ────────────────────────────────────────────────────────────

test('afirma que sólo entra a la bandeja lo que tiene PASO y FECHA', () => {
  assert.match(MANUAL, /sin fecha<\/b> no entra a la bandeja/);
  const { db, id } = agenda();
  assert.equal(pendientes(db, '2026-12-31').length, 1);
  // Una charla sin próximo paso no es un pendiente.
  db.prepare("INSERT INTO sg_contacto_charlas (contacto_id,fecha,canal,resumen) VALUES (?,'2026-08-01','telefono','Nada concreto')").run(id);
  assert.equal(pendientes(db, '2026-12-31').length, 1, 'una charla sin paso entró a la bandeja');
  // Un paso sin fecha tampoco — pero sí se ve en la ficha, como dice el manual.
  db.prepare("INSERT INTO sg_contacto_charlas (contacto_id,fecha,canal,resumen,proximo_paso) VALUES (?,'2026-08-02','telefono','Quedamos en vernos','Visitarlo')").run(id);
  assert.equal(pendientes(db, '2026-12-31').length, 1, 'un paso sin fecha entró a la bandeja');
  assert.equal(ficha(db, id).pendientes.length, 2, 'el manual dice que sin fecha igual se ve en la ficha');
});

test('afirma que ✓ Hecho lo saca de la bandeja y NO borra la charla', () => {
  assert.match(MANUAL, /La charla no se borra/);
  const { db, id } = agenda();
  db.prepare("UPDATE sg_contacto_charlas SET hecho_en = '2026-09-01' WHERE contacto_id = ?").run(id);
  assert.equal(pendientes(db, '2026-12-31').length, 0);
  assert.equal(ficha(db, id).charlas.length, 1, 'la charla desapareció de la ficha');
  assert.equal(ficha(db, id).pendientes.length, 0);
});

test('afirma que lo pendiente se ve TAMBIÉN en la lista del buscador', () => {
  assert.match(MANUAL, /se ve también en la lista del buscador/);
  const { db, id } = agenda();
  assert.equal(buscar(db, { q: 'Giglio' })[0].pendientes, 1,
    'la fila del buscador no trae la cuenta de pendientes');
  assert.match(PANEL, /ct-chip ct-pend/);

  // Y cuenta LO MISMO que la bandeja, que es otro camino de código: el contador de la
  // lista es una subconsulta dentro de buscar(), y la bandeja es pendientes(). Encontrado
  // mutando: romper la condición de la subconsulta dejaba el test en verde, así que el
  // párrafo del manual estaba prometiendo algo que nadie clavaba.
  db.prepare("INSERT INTO sg_contacto_charlas (contacto_id,fecha,canal,resumen)"
           + " VALUES (?,'2026-08-01','telefono','Nada concreto')").run(id);
  assert.equal(buscar(db, { q: 'Giglio' })[0].pendientes, 1,
    'una charla SIN próximo paso se contó como pendiente en la lista');
  db.prepare("UPDATE sg_contacto_charlas SET hecho_en = '2026-09-01' WHERE proximo_paso IS NOT NULL").run();
  assert.equal(buscar(db, { q: 'Giglio' })[0].pendientes, 0,
    'lo marcado hecho siguió contando en la lista');
  assert.equal(pendientes(db, '2026-12-31').length, 0, 'y tampoco en la bandeja');
});

// ── 8 · LOS MEDIOS ─────────────────────────────────────────────────────────

test('afirma que hay UN SOLO preferido y que marcar otro le saca la estrella', () => {
  assert.match(MANUAL, /Hay uno solo<\/b>: marcar otro le saca la estrella al/);
  // El router pone en cero los demás antes de marcar: si eso se cayera, la lista
  // mostraría cualquiera de los tres teléfonos.
  const pref = handler('post', '/:id/medios/:mid/preferido');
  assert.match(pref, /UPDATE sg_contacto_medios SET preferido = 0 WHERE contacto_id = \?/);
  const alta = handler('post', '/:id/medios');
  assert.match(alta, /if \(b\.preferido\) db\.prepare\('UPDATE sg_contacto_medios SET preferido = 0/);
});

test('afirma que el preferido es el que muestran la lista y la bandeja', () => {
  assert.match(MANUAL, /es el que muestra la lista y el que trae la bandeja/);
  const { db } = agenda();
  db.prepare("INSERT INTO sg_contacto_medios (contacto_id,tipo,valor,preferido) VALUES (?,'telefono','000 000-0000',0)").run(1);
  assert.equal(buscar(db, { q: 'Giglio' })[0].medio_principal, '264 422-1100');
  assert.equal(pendientes(db, '2026-12-31')[0].medio_principal, '264 422-1100');
});

test('afirma que lo que tiene arroba se guarda como mail', () => {
  assert.match(MANUAL, /lo que tiene <b>arroba<\/b> se guarda como mail/);
  const js = trozo(PANEL, 'async function ctMedioNuevo(', '\r\n}');
  assert.match(js, /valor\.includes\('@'\) \? 'mail' : 'telefono'/);
});

// ── 9 · LOS TIPOS ──────────────────────────────────────────────────────────

test('AFIRMA QUE "PROVEEDOR" TRAE TAMBIÉN A LOS QUE SON AMBOS', () => {
  assert.match(MANUAL, /trae también a los que son <b>las dos cosas<\/b>/);
  const { db } = agenda();
  db.prepare("INSERT INTO sg_contactos (nombre,tipo) VALUES ('Pedro Sosa','ambos')").run();
  assert.deepEqual(buscar(db, { tipo: 'proveedor' }).map(x => x.nombre).sort(),
    ['Juan Giglio', 'Pedro Sosa']);
  assert.deepEqual(buscar(db, { tipo: 'cliente' }).map(x => x.nombre), ['Pedro Sosa']);
});

test('afirma que "otro" existe para el transportista o el técnico', () => {
  assert.match(MANUAL, /para el transportista o el técnico/);
  assert.match(SERV, /TIPOS = \['cliente', ?'proveedor', ?'ambos', ?'otro'\]/);
  assert.match(BASE, /tipo\s+TEXT NOT NULL DEFAULT 'otro'/);
});

// ── 10 · LA BAJA ───────────────────────────────────────────────────────────

test('AFIRMA QUE LA BAJA ESCONDE Y LAS CHARLAS QUEDAN', () => {
  assert.match(MANUAL, /las charlas quedan guardadas/);
  assert.match(MANUAL, /la baja esconde y no borra/);
  const { db, id } = agenda();
  // Es soft delete: eliminado_en, no DELETE.
  const baja = handler('post', '/:id/eliminar');
  assert.match(baja, /UPDATE sg_contactos SET eliminado_en = datetime/);
  assert.ok(!/DELETE FROM sg_contactos/.test(ROUTER), 'apareció un DELETE del contacto');
  db.prepare("UPDATE sg_contactos SET eliminado_en = datetime('now') WHERE id = ?").run(id);
  assert.equal(buscar(db, { q: 'Giglio' }).length, 0, 'tiene que salir del buscador');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_contacto_charlas WHERE contacto_id = ?').get(id).n, 1,
    'las charlas se perdieron');
});

test('afirma que "ver inactivos" los vuelve a traer', () => {
  assert.match(MANUAL, /ver inactivos/);
  const { db } = agenda();
  db.prepare("UPDATE sg_contactos SET activo = 0").run();
  assert.equal(buscar(db, { q: 'Giglio' }).length, 0);
  assert.equal(buscar(db, { q: 'Giglio', incluir_inactivos: true }).length, 1);
  assert.match(PANEL, /id="ct-f-inact"/);
});

test('afirma que el aviso dice CUÁNTAS charlas son antes de confirmar', () => {
  assert.match(MANUAL, /el aviso dice cuántas son/);
  const js = trozo(PANEL, 'async function ctBaja(', '\r\n}');
  assert.match(js, /CT_FICHA\.charlas\.length \+ ' charla\(s\) quedan guardadas/);
});
