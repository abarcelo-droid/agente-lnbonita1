// ══ EL MENÚ DE REMITOS Y FACTURACIÓN, Y LA PUERTA DE LAS CADENAS ═══════════
//
// Pablo, 31/8/2026: «vamos a mejorar un poco este menú. Sacame la frutilla que no
// tiene nada que ver, poneme algo que tenga que ver con facturación. Acá está OK
// que esté Emisión de Remitos, Facturación Puesto (reemplaza facturación directa)
// y Facturación Supermercados como tercer ítem».
//
// A UNA CADENA NO SE LE FACTURA EN EL MOSTRADOR. La mercadería sale con remito, la
// recibe la sucursal y la factura se emite después, muchas veces por varios remitos
// juntos. Eso ya se podía hacer desde «Remitos pendientes de comprobante», pero ahí
// están TODOS los clientes: para facturarle a un súper había que entrar a otra
// pantalla y encontrarlo entre los demás.
//
// Lo que se prueba acá:
//   1. La regla de quién es una cadena, CORRIDA contra una base de verdad. Son dos
//      lugares —el campo `tipo` de la ficha y la categoría 'Retail' del padrón de
//      ABASTO— y los dos son ciertos: mirar uno solo deja media cartera afuera.
//   2. Que el backend y el front usen la MISMA regla. Dos definiciones de "cadena"
//      son un selector que ofrece un cliente que después no trae ningún remito.
//   3. Que el recorte lo haga el SERVIDOR, no el navegador.
//   4. Que no haya un segundo circuito de facturación: el botón abre el mismo
//      editor, y la tabla es una sola función para las dos pantallas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');

// ── 1 · LA REGLA, CORRIDA ──────────────────────────────────────────────────

// El SQL sale del archivo: si alguien lo cambia, este test corre el nuevo.
function sqlDeCadena() {
  const i = SG.indexOf('const SQL_ES_CADENA = `');
  assert.ok(i > 0, 'no existe SQL_ES_CADENA');
  return SG.slice(SG.indexOf('`', i) + 1, SG.indexOf('`;', i));
}

function baseConClientes() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_cliente_categorias (id INTEGER PRIMARY KEY, nombre TEXT);
    INSERT INTO sg_cliente_categorias (id, nombre) VALUES
      (1,'Retail'), (2,'Mayorista MCBA'), (3,'Food Service');
    CREATE TABLE sg_clientes (id INTEGER PRIMARY KEY, razon_social TEXT,
      tipo TEXT, categoria_id INTEGER);
    INSERT INTO sg_clientes (id, razon_social, tipo, categoria_id) VALUES
      -- Cargado a mano en la ficha: tiene tipo y NO tiene categoría.
      (1, 'Cadena tildada a mano',  'supermercado',       NULL),
      -- Importado del padrón de ABASTO: tiene categoría y NO tiene tipo.
      (2, 'Cadena del padrón',       NULL,                1),
      -- Las dos cosas: no se cuenta dos veces.
      (3, 'Cadena completa',         'supermercado',      1),
      -- Ni una ni la otra: no son cadenas.
      (4, 'Verdulería de barrio',    'minorista',         2),
      (5, 'Restaurante',             'horeca',            3),
      (6, 'Sin datos',               NULL,                NULL);
  `);
  return db;
}

test('es cadena la que lo dice en la ficha Y la que lo trae del padrón', () => {
  const db = baseConClientes();
  const filas = db.prepare(
    `SELECT c.id FROM sg_clientes c WHERE ${sqlDeCadena()} ORDER BY c.id`).all();
  assert.deepEqual(filas.map((r) => r.id), [1, 2, 3],
    'quedan las tres cadenas, una sola vez cada una');
  db.close();
});

test('y no entra el que no lo es, ni la ficha vacía', () => {
  // Una verdulería adentro de la pantalla de cadenas es un remito que alguien va a
  // facturar creyendo que es de un súper. Y la ficha sin nada cargado tampoco
  // entra: con tipo en NULL la condición da NULL, no verdadero, y la fila queda
  // afuera —que es lo correcto—. Se prueba con la MISMA forma que usa la ruta (la
  // regla como WHERE), no con su negación: `NOT (NULL OR falso)` da NULL y no
  // listaría a nadie, y ese es un detalle de SQL, no del negocio.
  const db = baseConClientes();
  const dentro = db.prepare(
    `SELECT c.id FROM sg_clientes c WHERE ${sqlDeCadena()}`).all().map((r) => r.id);
  for (const id of [4, 5, 6]) {
    assert.ok(!dentro.includes(id), 'el cliente ' + id + ' no es una cadena');
  }
  db.close();
});

test('el cliente sin categoría no rompe la consulta', () => {
  // categoria_id en NULL es el caso NORMAL —la mayoría de las fichas cargadas a
  // mano no la tienen—, y un EXISTS mal escrito lo dejaría afuera o haría fallar
  // la consulta entera.
  const db = baseConClientes();
  const n = db.prepare(
    `SELECT COUNT(*) c FROM sg_clientes c WHERE ${sqlDeCadena()} AND c.categoria_id IS NULL`).get().c;
  assert.equal(n, 1, 'la cadena tildada a mano entra igual sin categoría');
  db.close();
});

// ── 2 · UNA SOLA REGLA, EN LOS DOS LADOS ───────────────────────────────────

test('el front espeja la misma regla que el backend', () => {
  // Si el selector ofreciera un cliente que la lista después no trae, el que busca
  // el remito lo daría por perdido.
  const i = PANEL.indexOf('function sgEsCadena(c){');
  assert.ok(i > 0, 'el front no tiene la regla');
  const b = PANEL.slice(i, i + 300);
  assert.match(b, /c\.tipo === 'supermercado'/);
  assert.match(b, /c\.categoria_nombre === 'Retail'/);
  // Y el backend mira exactamente esos dos.
  const sql = sqlDeCadena();
  assert.match(sql, /c\.tipo='supermercado'/);
  assert.match(sql, /cc\.nombre = 'Retail'/);
});

test('la categoría llega al navegador, o el front no puede espejarla', () => {
  // sgEsCadena mira c.categoria_nombre: ese campo no está en sg_clientes, lo agrega
  // el listado. Sin él la mitad de las cadenas —las importadas— no aparecen en el
  // selector y nadie se entera.
  const i = SG.indexOf("montarCRUD('clientes'");
  const b = SG.slice(i, i + 1200);
  assert.match(b, /SELECT nombre FROM sg_cliente_categorias WHERE id = sg_clientes\.categoria_id\) AS categoria_nombre/);
});

// ── 3 · EL RECORTE LO HACE EL SERVIDOR ─────────────────────────────────────

test('la lista se filtra en el servidor, no en el navegador', () => {
  // Mandarle la lista entera al navegador para que esconda la mayoría es mandar la
  // plata de otros clientes a una pantalla que no la pidió.
  const i = SG.indexOf("router.get('/despachos-pendientes'");
  const b = SG.slice(i, i + 1400);
  assert.match(b, /if \(req\.query\.solo_cadenas === '1'\) \{ where\.push\(SQL_ES_CADENA\); \}/);
  // Y la pantalla lo pide.
  const j = PANEL.indexOf('function sgSuperLoad(){');
  assert.ok(j > 0, 'no existe la pantalla de cadenas');
  assert.match(PANEL.slice(j, j + 900), /var qs=\['solo_cadenas=1'\];/);
});

test('y el selector de clientes también está recortado', () => {
  // Es el MISMO buscador único que el resto del panel (un solo campo donde se
  // escribe y se elige), con el padrón recortado a las cadenas por los dos lados:
  // la fuente que se busca y las opciones que se pintan.
  const i = PANEL.indexOf('function sgCadenaUnico(selectId){');
  assert.ok(i > 0, 'la solapa no usa el buscador único');
  const b = PANEL.slice(i, i + 800);
  assert.match(b, /fuente: function\(\)\{ return \(SG\.cacheCli \|\| \[\]\)\.filter\(sgEsCadena\); \}/);
  assert.match(b, /return sgCliOpts\(q, sel, blank \|\| '— Todas las cadenas —', sgEsCadena\); \}/);
  const j = PANEL.indexOf('function sgSuperInit(){');
  assert.match(PANEL.slice(j, j + 900), /sgCadenaUnico\('sgsu-cli'\);/);
  // El recorte es opcional: las otras pantallas que llaman a sgCliOpts sin filtro
  // siguen viendo el padrón entero.
  const k = PANEL.indexOf('function sgCliOpts(query, sel, blank, filtro){');
  assert.ok(k > 0);
  assert.match(PANEL.slice(k, k + 300), /if \(typeof filtro === 'function'\) base = base\.filter\(filtro\);/);
});

test('y volver a la solapa no borra la cadena que se había elegido', () => {
  // Rearmar el desplegable en blanco lo dejaba diciendo «todas» mientras el campo de
  // texto seguía mostrando la cadena elegida: la pantalla se contradecía y la lista
  // de abajo no coincidía con ninguno de los dos.
  const i = PANEL.indexOf('function sgSuperInit(){');
  assert.match(PANEL.slice(i, i + 900),
    /sel\.innerHTML=sgCliOpts\('', sel\.value, '— Todas las cadenas —', sgEsCadena\);/);
});

// ── 4 · NO HAY UN SEGUNDO CIRCUITO ─────────────────────────────────────────

test('el botón abre el MISMO editor de factura', () => {
  // El editor ya sabe tildar varios remitos del mismo cliente y emitir un solo
  // comprobante, que es como la cadena lo espera. Una segunda copia de las reglas
  // de stock y de asiento es una segunda copia que se olvida de actualizar.
  const i = PANEL.indexOf('function sgPendTablaHTML(ds){');
  assert.ok(i > 0, 'la tabla no se compartió');
  const b = PANEL.slice(i, i + 2600);
  assert.match(b, /onclick="sgFacPrecargar\('\+d\.cliente_id\+','\+d\.despacho_id\+'/);
  assert.match(b, /onclick="sgLiqRecAbrir\('\+d\.cliente_id\+','\+d\.despacho_id\+'/);
  // Y el permiso se decide UNA vez, adentro de la tabla compartida.
  assert.match(b, /var puedeDoc = lnbPuedeOperar\('sg-remitos-pend'\) \|\| lnbPuedeOperar\('sg-ventas'\);/);
});

test('y el modal que abre se ve desde las dos pantallas', () => {
  // `.sec{display:none}`: la pantalla que no está abierta está escondida, y todo lo
  // que tiene adentro también.
  //
  // Los dos modales —facturar el remito y recibir la liquidación— vivían ADENTRO de
  // «Remitos pendientes de comprobante», y andaban porque sólo se abrían desde ahí.
  // Con la solapa de cadenas se abren desde otra pantalla: el botón corría, el modal
  // se marcaba como abierto y no se veía nada. El que lo aprieta cree que se colgó.
  const secs = [...PANEL.matchAll(/<div class="sec[ "]/g)].map((m) => m.index);
  const cierra = (ini) => {
    let prof = 0;
    for (const m of PANEL.slice(ini).matchAll(/<div\b|<\/div>/g)) {
      prof += m[0] === '</div>' ? -1 : 1;
      if (prof === 0) return ini + m.index;
    }
    return PANEL.length;
  };
  const rangos = secs.map((a) => [a, cierra(a)]);
  const suelto = (id) => {
    const j = PANEL.indexOf('id="' + id + '"');
    assert.ok(j > 0, 'no existe ' + id);
    return !rangos.some(([a, b]) => a < j && j < b);
  };
  assert.ok(suelto('sg-fac-modal'), 'el modal de facturar quedó adentro de una pantalla');
  assert.ok(suelto('sg-liqrec-modal'), 'el modal de la liquidación quedó adentro de una pantalla');
  // Y es donde están todos los demás modales del proyecto.
  assert.ok(suelto('sg-pago-modal'));
  assert.ok(suelto('sg-desp-modal'));
});

test('las dos pantallas dibujan la MISMA tabla', () => {
  // Dos copias del renglón son dos lugares donde arreglar el permiso o agregar una
  // columna, y uno de los dos se olvida.
  const usos = PANEL.match(/= sgPendTablaHTML\(ds\)/g) || [];
  assert.equal(usos.length, 2, 'la usan Remitos pendientes y Facturación Supermercados');
  assert.equal((PANEL.match(/function sgPendTablaHTML\(/g) || []).length, 1,
    'y está definida una sola vez');
});

// ── 5 · EL MENÚ ────────────────────────────────────────────────────────────

test('las tres puertas, con el rótulo que pidió Pablo', () => {
  assert.match(PANEL, /onclick="sgVenSub\('despachos'\)">📄 Emisión de Remitos</);
  assert.match(PANEL, /onclick="sgVenSub\('directa'\)">💵 Facturación Puesto</);
  assert.match(PANEL, /onclick="sgVenSub\('supermercados'\)">🏪 Facturación Supermercados</);
  // Ya no queda el rótulo viejo dando vueltas.
  assert.ok(!/>💵 Facturación directa</.test(PANEL), 'quedó el nombre viejo en el menú');
});

test('y el remito que emite el puesto también dice el nombre nuevo', () => {
  // El renglón de observaciones del remito se LEE en su ficha. Si la pantalla se
  // llama «Facturación Puesto» y el papel dice «Facturación directa», el que abre
  // ese remito en seis meses no tiene cómo saber que son la misma cosa. Nadie
  // compara ese texto contra nada, así que cambiarlo no rompe nada; lo ya escrito
  // se queda como está, porque es lo que decía cuando se emitió.
  assert.match(SG, /observaciones: b\.observaciones \|\| 'Facturación Puesto',/);
});

test('las CLAVES internas no se tocaron', () => {
  // 'directa' es homónimo de la dirección /api/sg/facturas/directa y 'despachos' de
  // una vista entera de IFCO: un buscar-y-reemplazar global rompe las dos cosas. El
  // usuario nunca las lee.
  assert.match(PANEL, /data-sub="despachos"/);
  assert.match(PANEL, /data-sub="directa"/);
  assert.match(PANEL, /id="sgv-sub-despachos"/);
  assert.match(PANEL, /id="sgv-sub-directa"/);
});

test('y la solapa nueva está enganchada al despachador', () => {
  // El menú arma el id del panel concatenando la clave: sin el div, la solapa se
  // marca y no se ve nada.
  const i = PANEL.indexOf('function sgVenSub(s){');
  assert.match(PANEL.slice(i, i + 900), /else if \(s==='supermercados'\) sgSuperInit\(\);/);
  assert.match(PANEL, /id="sgv-sub-supermercados"/);
  assert.match(PANEL, /data-sub="supermercados"/);
});

test('la cabecera habla de facturar y no de verdura', () => {
  // «Sacame la frutilla que no tiene nada que ver» — el tomate era la marca de San
  // Gerónimo repetida en cada pantalla, y arriba de tres puertas que emiten
  // comprobantes no dice nada. En el menú lateral esta pantalla ya figura como
  // «Remitos y Facturación»: el título ahora dice lo mismo que el botón.
  assert.match(PANEL, /<div class="ph-t">🧾 San Gerónimo · Remitos y Facturación<\/div>/);
  assert.ok(!/🍅 San Gerónimo · Salidas/.test(PANEL), 'quedó el tomate en la cabecera');
});

test('nada se desplaza de costado', () => {
  // La clase .ab-table-wrap trae su propio overflow-x:auto, así que hace falta
  // ganarle con !important. El ancho fijo trunca todo menos qué se vendió.
  const i = PANEL.indexOf('#sgv-sub-supermercados .ab-table-wrap{overflow-x:hidden !important}');
  assert.ok(i > 0, 'la pantalla nueva puede desplazarse de costado');
  const b = PANEL.slice(i, i + 3400);
  assert.match(b, /#sgv-sub-supermercados table\{table-layout:fixed;width:100%\}/);
  // Los anchos van declarados. Con ocho columnas y ninguno, cada una se lleva 12,5%
  // y los dos botones de la última no entran.
  const anchos = (b.match(/#sgv-sub-supermercados td:nth-child\(\d\)\{width:\d+%\}/g) || []);
  assert.equal(anchos.length, 8, 'las ocho columnas dicen su ancho');
  assert.equal(anchos.reduce((a, x) => a + Number(x.match(/(\d+)%/)[1]), 0), 100,
    'y suman 100: si se pasan, la tabla se desplaza de costado');
  assert.match(b, /text-overflow:ellipsis/);
  assert.match(b, /td\.sgsu-que\{white-space:normal/);
  // Y los botones NO se recortan: se apilan. Un botón cortado a la mitad queda a
  // medio dibujar y el pedazo cortado no se puede apretar.
  assert.match(b, /#sgv-sub-supermercados td:nth-child\(8\)\{white-space:normal\}/);
  // La pastilla de estado tampoco. Su contenido no es texto sino un .bdg
  // inline-block: con overflow:hidden se corta AL RAS, sin puntos suspensivos, y
  // queda media pastilla que no dice nada.
  assert.match(b, /#sgv-sub-supermercados td:nth-child\(7\)\{white-space:nowrap\}/);
  const elipsis = b.slice(b.indexOf('td:nth-child(-n+4)'), b.indexOf('text-overflow:ellipsis;white-space:nowrap}'));
  assert.ok(!/nth-child\(7\)/.test(elipsis), 'el estado no puede ir en el grupo que recorta');
  assert.match(b, /@media\(max-width:900px\)/);
});

test('la pantalla dice qué clientes muestra', () => {
  // Una pantalla que filtra sin decir con qué criterio hace que el remito que falta
  // parezca perdido.
  assert.match(PANEL, /Entran los clientes marcados como <b>Supermercado<\/b> en su ficha o con categoría comercial <b>Retail<\/b>/);
});
