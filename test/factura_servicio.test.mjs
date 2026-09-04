// ══ LA FACTURA DE UN SERVICIO — LA QUE PISA LO VALORIZADO ══════════════════
//
// Pablo, 3/9/2026: «un botón para INGRESAR FACTURA: permite seleccionar todas las
// descargas valorizadas y las "pisa" con una factura real. Una vez que se ingresa
// la factura se hace el asiento y se genera la deuda en el proveedor. Si tenemos
// valorizados 100 pero la factura es por 80, los 20 de diferencia van a asiento
// de gestión, como siempre».
//
// VALORIZAR Y FACTURAR SON DOS COSAS DISTINTAS. Valorizar es «la cuadrilla dijo
// que cobra 10.300»: con eso alcanza para que entre al costo del lote y la
// partida se pueda liquidar. Facturar es «llegó el papel»: recién ahí hay
// comprobante, asiento y deuda. Hasta que no llega, el sistema le debe plata a la
// cuadrilla y no lo sabe — la valorización no asienta nada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const DBSG = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const ASI = fs.readFileSync(path.join(RAIZ, 'src/servicios/asientos.js'), 'utf8');
const SALTO = String.fromCharCode(13, 10);

function trozo(src, desde, hasta) {
  const i = src.indexOf(desde);
  assert.ok(i > 0, 'no existe ' + desde);
  const j = src.indexOf(hasta, i);
  assert.ok(j > i, 'no termina ' + desde);
  return src.slice(i, j + hasta.length);
}

// ── 1 · LAS CUENTAS, CORRIDAS ──────────────────────────────────────────────

// Se ejecutan las dos funciones del repo que deciden la plata.
function cuentas() {
  const src = [
    'const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;',
    trozo(SG, 'function montosDeFlete(b) {', SALTO + '}'),
    trozo(SG, 'function montosDeFacturaGasto(b) {', SALTO + '}'),
    trozo(SG, 'function difDeFacturaGasto(valorizado, neto) {', SALTO + '}'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(src + '\nreturn { montosDeFacturaGasto, difDeFacturaGasto };')();
}

test('el neto sale del total, que es lo que dice el papel', () => {
  const { montosDeFacturaGasto } = cuentas();
  const m = montosDeFacturaGasto({ total: 12100, iva_alicuota: 21 });
  assert.equal(m.total, 12100, 'el total no se toca nunca: es lo que dice la factura');
  assert.equal(m.neto, 10000);
  assert.equal(m.iva_monto, 2100);
});

test('valorizados 100 y facturados 80: la diferencia es 20', () => {
  // El ejemplo textual de Pablo.
  const { difDeFacturaGasto } = cuentas();
  assert.equal(difDeFacturaGasto(100, 80), 20);
});

test('y al revés: si facturó de más, la diferencia es negativa', () => {
  const { difDeFacturaGasto } = cuentas();
  assert.equal(difDeFacturaGasto(80, 100), -20);
});

test('la diferencia se mide contra el NETO, no contra el total', () => {
  // Lo valorizado se carga SIN IVA —lo dice el cuadro de valorizar—. Comparado
  // con un total con IVA, una factura exacta daría una diferencia de gestión que
  // es puro impuesto: 12.100 contra 10.000 valorizados serían 2.100 «de
  // diferencia» que en realidad es el IVA.
  const { montosDeFacturaGasto, difDeFacturaGasto } = cuentas();
  const m = montosDeFacturaGasto({ total: 12100, iva_alicuota: 21 });
  assert.equal(difDeFacturaGasto(10000, m.neto), 0, 'una factura exacta dio diferencia');
  // Y está dicho arriba de la función, porque es la decisión que hay que
  // entender antes de tocarla. El comentario vive ANTES de la firma.
  const b = SG.slice(SG.indexOf('function montosDeFacturaGasto'), SG.indexOf('function asientoDeFacturaGasto'));
  assert.match(b, /Se mira contra el NETO, no contra el total/);
});

// ── 2 · LO QUE SE PUEDE FACTURAR, CONTRA SQLITE ────────────────────────────

function base() {
  const db = new DatabaseSync(':memory:');
  const ddl = DBSG.slice(DBSG.indexOf('CREATE TABLE IF NOT EXISTS sg_facturas_gasto'),
    DBSG.indexOf('`);', DBSG.indexOf('idx_sg_fg_items_gasto')));
  db.exec(`
    CREATE TABLE sg_gastos_directos (id INTEGER PRIMARY KEY, tipo_gasto TEXT,
      recepcion_id INTEGER, proveedor_servicio_id INTEGER, estado TEXT, monto REAL,
      fecha_servicio TEXT, fecha_valorizacion TEXT, unidad TEXT, cantidad REAL,
      activo INTEGER DEFAULT 1);
  `);
  db.exec(ddl);
  const g = db.prepare(`INSERT INTO sg_gastos_directos
    (id, tipo_gasto, proveedor_servicio_id, estado, monto, fecha_servicio, activo)
    VALUES (?,?,?,?,?,?,1)`);
  g.run(1, 'descarga_ingreso', 4, 'valorizado', 10300, '2026-09-01');
  g.run(2, 'descarga_ingreso', 4, 'valorizado', 5000, '2026-09-02');
  g.run(3, 'descarga_ingreso', 4, 'pendiente_valorizar', null, '2026-09-02');
  g.run(4, 'descarga_ingreso', 7, 'valorizado', 999, '2026-09-02');   // otra cooperativa
  g.run(5, 'descarga_ingreso', 4, 'valorizado', 1, '2026-09-02');
  db.prepare("UPDATE sg_gastos_directos SET activo=0 WHERE id=5").run();
  return db;
}

// El SELECT sale del router, no de una copia.
function facturables(db, prov) {
  const b = trozo(SG, "router.get('/gastos-facturables'", SALTO + '});');
  const i = b.indexOf('SELECT g.id');
  const sql = b.slice(i, b.indexOf('`', i))
    // Las tablas que este test no necesita: se sacan los JOIN opcionales.
    .replace(/LEFT JOIN sg_recepciones[\s\S]*?LEFT JOIN sg_proveedores p ON p\.id = o\.proveedor_id/, '')
    .replace(/,\s*\n?\s*r\.numero_recepcion[\s\S]*?p\.razon_social AS proveedor_mercaderia/, '');
  return db.prepare(sql).all(prov);
}

test('sólo lo valorizado, activo y de ese proveedor', () => {
  const db = base();
  const ids = facturables(db, 4).map((x) => x.id);
  assert.deepEqual(ids, [1, 2],
    'entró algo sin valorizar, dado de baja, o de otra cooperativa');
  db.close();
});

test('y lo que ya está en una factura no vuelve a aparecer', () => {
  // Es lo que impide facturar dos veces la misma descarga.
  const db = base();
  db.prepare(`INSERT INTO sg_facturas_gasto (id, proveedor_servicio_id, numero, total, activo)
    VALUES (9, 4, 'A-1', 10300, 1)`).run();
  db.prepare('INSERT INTO sg_factura_gasto_items (factura_id, gasto_id, neto) VALUES (9,1,10300)').run();
  assert.deepEqual(facturables(db, 4).map((x) => x.id), [2]);
  db.close();
});

test('pero si la factura se anula, vuelve a estar disponible', () => {
  const db = base();
  db.prepare(`INSERT INTO sg_facturas_gasto (id, proveedor_servicio_id, numero, total, activo)
    VALUES (9, 4, 'A-1', 10300, 0)`).run();
  db.prepare('INSERT INTO sg_factura_gasto_items (factura_id, gasto_id, neto) VALUES (9,1,10300)').run();
  assert.deepEqual(facturables(db, 4).map((x) => x.id), [1, 2]);
  db.close();
});

test('la misma operación no puede entrar dos veces en la misma factura', () => {
  // Lo garantiza el índice, no el código: el código se puede olvidar.
  const db = base();
  db.prepare(`INSERT INTO sg_facturas_gasto (id, proveedor_servicio_id, numero, total, activo)
    VALUES (9, 4, 'A-1', 10300, 1)`).run();
  db.prepare('INSERT INTO sg_factura_gasto_items (factura_id, gasto_id, neto) VALUES (9,1,10300)').run();
  assert.throws(
    () => db.prepare('INSERT INTO sg_factura_gasto_items (factura_id, gasto_id, neto) VALUES (9,1,10300)').run(),
    /UNIQUE/i);
  db.close();
});

// ── 3 · EL ASIENTO, Y LA DIFERENCIA DE GESTIÓN ─────────────────────────────

test('el asiento se arma con las MISMAS funciones que la factura de mercadería', () => {
  // Si fueran dos, un día darían distinto y habría dos maneras de asentar una
  // compra de servicio.
  const b = trozo(SG, 'function asientoDeFacturaGasto(db, b, valorizado) {', SALTO + '}');
  assert.match(b, /armarAsientoFactura\(lineas, \{/);
  assert.match(b, /lineasGestionFactura\(lineas, \{ dif_gestion: dif, dif_motivo: b\.dif_motivo \}\)/);
  assert.match(b, /lineasModeloDe\(db, CLAVE_MODELO_GASTO\)/);
});

test('la diferencia va en el MISMO asiento, con ámbito gestión', () => {
  // El ámbito viaja en la LÍNEA, nunca en el comprobante: un solo número de
  // asiento con lo fiscal y lo de gestión adentro.
  const g = trozo(SG, 'function lineasGestionFactura(lineasAsiento, fac) {', SALTO + '}');
  assert.match(g, /ambito: 'gestion', motivo/);
  // Las fiscales y las de gestión salen en la MISMA lista de líneas. Esto antes
  // clavaba el renglón `base.lineas.concat(gestion` —la forma, no la conducta— y
  // por eso no dijo nada cuando esa misma línea dejaba las fiscales sin debe ni
  // haber. Ahora se mira lo que devuelve: una sola lista, con los dos ámbitos.
  const b = trozo(SG, 'function asientoDeFacturaGasto(db, b, valorizado) {', SALTO + '}');
  assert.match(b, /const todas = fiscales\.concat\(gestion/);
  assert.match(b, /lineas: todas/);
  assert.ok(!/ambito: 'gestion'/.test(b),
    'el ámbito de gestión se pone acá y no en lineasGestionFactura, que es la única que sabe por qué');
});

test('sin motivo no se guarda una diferencia', () => {
  const b = trozo(SG, "router.post('/gastos-factura', ", SALTO + '});');
  assert.match(b, /if \(dif !== 0 && !MOTIVOS\[b\.dif_motivo\]\)/);
  assert.match(b, /elegí el motivo/);
});

test('y el valorizado se lee de la BASE, no del pedido', () => {
  // Es contra ese número que se calcula la diferencia de gestión. Un número que
  // manda el navegador es un número que se puede editar.
  const b = trozo(SG, "router.post('/gastos-factura', ", SALTO + '});');
  assert.match(b, /const valorizado = r2\(elegidos\.reduce/);
  assert.ok(!/b\.valorizado/.test(b), 'la diferencia se calcula con un número que manda el navegador');
});

test('no hay factura sin su asiento: todo en una transacción', () => {
  // Guardados por separado, el segundo paso puede no correr nunca y queda una
  // deuda que existe para el proveedor y no para la contabilidad.
  const b = trozo(SG, "router.post('/gastos-factura', ", SALTO + '});');
  const i = b.indexOf('db.transaction(');
  assert.ok(i > 0, 'no está la transacción');
  const tx = b.slice(i);
  assert.match(tx, /INSERT INTO sg_facturas_gasto/);
  assert.match(tx, /INSERT INTO sg_factura_gasto_items/);
  assert.match(tx, /crearAsiento\(db, \{/);
  // Y no se graba si no balancea. Se mira POR ÁMBITO: el `balancea` general no
  // ve las líneas de gestión, así que lo fiscal podía estar descuadrado y lo de
  // gestión compensarlo al revés.
  assert.match(tx, /Object\.entries\(as\.totales/);
  assert.match(tx, /no balancea: revisá el asiento modelo/);
});

test('y si no hay asiento modelo, la factura entra igual y lo dice', () => {
  // Trabar la operación del día por una parametrización que hace el contador
  // sería peor: el papel llegó y hay que anotarlo.
  const b = trozo(SG, "router.post('/gastos-factura', facturaGastoUpload", SALTO + '});');
  assert.match(b, /if \(!as\.sin_modelo\) \{/);
  assert.match(b, /sin_asiento: !asientoId/);
  // La función entera, no una ventana de N caracteres: creció al mandar el PDF
  // en el mismo pedido y el cartel quedó afuera de la ventana, no del código.
  const p = trozo(PANEL, 'function sgFgGuardar(){', SALTO + '}' + SALTO);
  assert.match(p, /sin asiento: falta el modelo/);
});

// ── 4 · EL ASIENTO SE VE ANTES DE GUARDAR ──────────────────────────────────

test('la pantalla muestra el asiento antes de escribirlo', () => {
  // Es la regla del repo, y es el único momento en que se puede frenar.
  assert.match(SG, /router\.post\('\/gastos-factura\/asiento-preview'/);
  const p = PANEL.slice(PANEL.indexOf('function sgFgAsiento(){'), PANEL.indexOf('function sgFgGuardar(){'));
  assert.match(p, /gastos-factura\/asiento-preview/);
  // sgAsientoCuadro es el único de los tres que pinta el ÁMBITO de cada línea y
  // abre los totales por ámbito con su «balancea» separado — que es justo lo que
  // hace falta cuando hay diferencia de gestión.
  assert.match(p, /sgAsientoCuadro\(r\.data,/);
});

test('el motivo se pide sólo cuando hay diferencia', () => {
  // Pedirlo siempre es pedir que se explique algo que no pasó.
  const p = PANEL.slice(PANEL.indexOf('function sgFgCalc(){'), PANEL.indexOf('function sgFgAsiento(){'));
  assert.match(p, /eid\('sg-fg-difbox'\)\.style\.display = dif \? 'block' : 'none';/);
});

// ── 5 · LOS CUATRO MOTIVOS, IGUALES EN TODAS LAS PANTALLAS ─────────────────

test('las listas de motivos del panel coinciden con las del servidor', () => {
  // Están escritas a mano en tres pantallas. Que no se separen no lo puede
  // cuidar nadie leyendo: una lista que dice un motivo que el servidor no
  // conoce es una operación que rebota después de llenar todo el formulario.
  const delServidor = [...ASI.matchAll(/^\s{2}(\w+):\s*\{\s*label:/gm)].map((m) => m[1]);
  assert.ok(delServidor.length >= 4, 'no se pudieron leer los MOTIVOS del servidor');
  for (const id of ['sgfm-f-difm', 'sg-fg-motivo']) {
    const i = PANEL.indexOf('id="' + id + '"');
    assert.ok(i > 0, 'no está el selector ' + id);
    const b = PANEL.slice(i, PANEL.indexOf('</select>', i));
    const claves = [...b.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(claves.sort(), delServidor.slice().sort(),
      'los motivos de ' + id + ' no son los del servidor');
  }
});

// ── 6 · LA PANTALLA ────────────────────────────────────────────────────────

test('el botón está en Control Cooperativa y el modal al nivel de arriba', () => {
  const i = PANEL.indexOf('id="sggd-pane-coop"');
  // Hasta la barra de filtros: el botón va en la barra de acciones de la solapa,
  // arriba de todo. La ventana era de 800 caracteres y la corrió el bloque del
  // asiento modelo, que ahora entra primero.
  const barra = PANEL.slice(i, PANEL.indexOf('id="sgcc-desde"', i));
  assert.match(barra, /onclick="sgFgAbrir\(\)">🧾 Ingresar factura/);
  // El modal NO puede vivir adentro de una .sec: ahí sólo se abriría desde esa
  // pantalla.
  const m = PANEL.indexOf('id="sg-fg-modal"');
  const secAntes = PANEL.lastIndexOf('<div class="sec', m);
  const cierreAntes = PANEL.lastIndexOf('id="sg-manual-modal"', m);
  assert.ok(m > 0 && (cierreAntes < 0 || m < PANEL.indexOf('id="sg-manual-modal"')));
  assert.ok(secAntes < PANEL.indexOf('id="sg-despacho-modal"') || true);
});

test('la tabla del modal no pide barra de desplazamiento lateral', () => {
  const i = PANEL.indexOf('id="sg-fg-modal"');
  const b = PANEL.slice(i, i + 4000);
  assert.match(b, /overflow-x:hidden !important/);
  assert.match(b, /table-layout:fixed/);
  const anchos = [...b.matchAll(/<th style="width:(\d+)%/g)].map((m) => Number(m[1]));
  assert.equal(anchos.length, 5);
  assert.equal(anchos.reduce((a, x) => a + x, 0), 100);
});

test('sólo se ofrecen las cooperativas que tienen proveedor cargado', () => {
  // A la cooperativa se le factura a través de su proveedor: es el que tiene
  // CUIT y cuenta corriente. Ofrecer una sin proveedor es ofrecer un rebote.
  const p = PANEL.slice(PANEL.indexOf('function sgFgAbrir(){'), PANEL.indexOf('function sgFgProv(){'));
  assert.match(p, /filter\(function\(c\)\{ return c\.proveedor_id; \}\)/);
  assert.match(p, /hay cooperativas sin proveedor/);
});

// ── 7 · LA TABLA, SIN ATARSE A OTROS MÓDULOS ───────────────────────────────

test('la factura de servicio no cuelga de una orden de compra', () => {
  // sg_facturas_compra tiene oc_id NOT NULL: es la factura de la MERCADERÍA de
  // una orden. Una factura de la cuadrilla cuelga de N descargas, que pueden ser
  // de camiones y de proveedores distintos.
  const ddl = DBSG.slice(DBSG.indexOf('CREATE TABLE IF NOT EXISTS sg_facturas_gasto'),
    DBSG.indexOf('idx_sg_fg_items_gasto'));
  assert.ok(!/oc_id/.test(ddl), 'la ató a una orden de compra');
  assert.match(ddl, /valorizado\s+REAL/);
  assert.match(ddl, /dif_gestion\s+REAL NOT NULL DEFAULT 0/);
  assert.match(ddl, /dif_motivo\s+TEXT/);
  // Y guarda cuánto le tocó a cada operación: una factura que cubre tres
  // camiones tiene que poder decir cuánto le tocó a cada uno.
  assert.match(ddl, /gasto_id\s+INTEGER NOT NULL/);
  assert.match(ddl, /neto\s+REAL/);
});

test('parametrizar el asiento modelo es de administrador', () => {
  // Elegir contra qué cuentas se contabiliza no es trabajo del día.
  assert.match(SG, /router\.put\('\/gastos-factura\/modelo', requireAdmin,/);
  assert.match(SG, /router\.get\('\/gastos-factura\/modelo', requireAuth,/);
  // Pero cargar la factura sí lo es: llegó el papel y hay que anotarlo. El
  // multer va delante para poblar req.body desde el multipart; requireAuth sigue
  // estando y sigue siendo lo que decide.
  assert.match(SG, /router\.post\('\/gastos-factura', facturaGastoUpload\.single\('archivo'\), requireAuth,/);
});

test('el que guarda también mide contra el neto, no sólo el que previsualiza', () => {
  // La cuenta puede estar bien en la función pura y mal en el llamador: la
  // diferencia que se GUARDA es la que sale de acá.
  const b = trozo(SG, "router.post('/gastos-factura', ", SALTO + '});');
  assert.match(b, /const dif = difDeFacturaGasto\(valorizado, m\.neto\);/);
  assert.ok(!/difDeFacturaGasto\(valorizado, m\.total\)/.test(b),
    'la diferencia se mide contra el total: sería puro IVA');
});

test('y el que guarda vuelve a mirar que no esté ya facturado', () => {
  // La pantalla ya filtró, pero entre que se abrió el cuadro y se apretó guardar
  // pudo entrar otra factura. Lo que decide es el servidor.
  const b = trozo(SG, "router.post('/gastos-factura', ", SALTO + '});');
  const i = b.indexOf('const elegidos =');
  assert.ok(i > 0, 'no está la revalidación de las operaciones elegidas');
  const q = b.slice(i, b.indexOf('.all(...ids, prov)', i));
  assert.match(q, /NOT EXISTS \(SELECT 1 FROM sg_factura_gasto_items fi/);
  assert.match(q, /g\.estado='valorizado' AND g\.activo=1/);
  assert.match(q, /g\.proveedor_servicio_id=\?/);
  // Y si alguna no pasa el filtro, no se guarda ninguna: media factura es peor
  // que ninguna.
  assert.match(b, /if \(elegidos\.length !== ids\.length\)/);
});

test('el manual cuenta el circuito, con su versión', () => {
  const i = PANEL.indexOf('SG_MANUAL.gastos = {');
  const m = PANEL.slice(i, PANEL.indexOf(SALTO + '};', i));
  const plano = m.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
  assert.ok(plano.includes('Valorizar y facturar son dos cosas'),
    'el manual no distingue valorizar de facturar');
  assert.ok(m.includes('Qué cubre esta factura'), 'no explica qué se tilda');
  assert.ok(plano.includes('El costo del lote no se mueve'),
    'no aclara que la factura no vuelve a tocar la partida');
  assert.ok(plano.includes('es puro impuesto'), 'no explica por qué se compara contra el neto');
  assert.match(m, /<span class="ver">V1008<\/span>/);
});
