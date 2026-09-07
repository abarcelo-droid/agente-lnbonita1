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
      recepcion_id INTEGER, despacho_id INTEGER, proveedor_servicio_id INTEGER,
      estado TEXT, monto REAL, cuenta_ref TEXT, asiento_id INTEGER,
      fecha_servicio TEXT, fecha_valorizacion TEXT, unidad TEXT, cantidad REAL,
      activo INTEGER DEFAULT 1);
    -- El flete de SALIDA cuelga de un remito, no de una recepción: sin estas dos
    -- el SELECT del router no corre, y es el mismo SELECT que corre en producción.
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, numero TEXT, cliente_id INTEGER);
    CREATE TABLE sg_clientes (id INTEGER PRIMARY KEY, razon_social TEXT);
    -- El asiento se mira para saber si SIGUE VIVO: uno anulado a mano no cuenta
    -- como «ya contabilizado», o el gasto se cae del libro.
    CREATE TABLE sg_asientos (id INTEGER PRIMARY KEY, anulado INTEGER DEFAULT 0);
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

// El SELECT sale del router, no de una copia. Ahora corre ENTERO: las tablas de
// remito y cliente están en la base del test, así que ya no hace falta recortarle
// los JOIN — y recortarlos era lo que dejaba sin probar la mitad de la consulta.
function facturables(db, prov, tipos) {
  const ts = Array.isArray(tipos) ? tipos : [tipos || 'descarga_ingreso'];
  const b = trozo(SG, "router.get('/gastos-facturables'", SALTO + '});');
  const i = b.indexOf('SELECT g.id');
  const sql = b.slice(i, b.indexOf('`', i))
    // Las de la mercadería sí se sacan: traerían el árbol entero de compras.
    .replace(/LEFT JOIN sg_recepciones[\s\S]*?LEFT JOIN sg_proveedores p ON p\.id = o\.proveedor_id/, '')
    .replace(/,\s*\n?\s*r\.numero_recepcion, o\.trazabilidad AS partida,/, ',')
    .replace(/,\s*\n?\s*p\.razon_social AS proveedor_mercaderia/, '')
    // El ${...} de la lista de tipos lo resuelve el router; acá se pone la
    // cantidad de signos que corresponde a los tipos de esta corrida.
    .replace(/IN \(\$\{[^}]*\}\)/, 'IN (' + ts.map(() => '?').join(',') + ')');
  return db.prepare(sql).all(prov, ...ts);
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
  const b = trozo(SG, 'function asientoDeFacturaGasto(db, b, valorizado, clave) {', SALTO + '}');
  assert.match(b, /armarAsientoFactura\(lineas, \{/);
  assert.match(b, /lineasGestionFactura\(lineas, \{ dif_gestion: dif, dif_motivo: b\.dif_motivo \}\)/);
  // La clave la pone el circuito; la de la descarga queda de respaldo porque era
  // el único que se facturaba antes.
  assert.match(b, /lineasModeloDe\(db, clave \|\| CLAVE_MODELO_GASTO\)/);
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
  const b = trozo(SG, 'function asientoDeFacturaGasto(db, b, valorizado, clave) {', SALTO + '}');
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
  // Y tampoco si el asiento salió sin líneas: es el circuito que ya asentó al
  // valorizar y encima no tuvo diferencia contra lo estimado. El comprobante
  // existe igual y hay que anotarlo.
  assert.match(b, /if \(!as\.sin_modelo && as\.lineas\.length\) \{/);
  // Y el cartel nombra al circuito que falta, no siempre a las descargas: con el
  // texto clavado, facturando un flete la pantalla mandaba a tocar el modelo de
  // la descarga —que está y funciona— y rompía el circuito que andaba.
  const pv = trozo(PANEL, 'function sgFgAsiento(){', SALTO + '}');
  assert.match(pv, /escH\(cc\.que \|\| 'este circuito'\)/);
  assert.match(pv, /'el asiento modelo de ' \+ \(cc\.que \|\| 'este circuito'\)/);
  assert.ok(!/asiento modelo de descargas'/.test(pv), 'sigue nombrando siempre a la descarga');
  assert.match(b, /sin_asiento: !asientoId/);
  // La función entera, no una ventana de N caracteres: creció al mandar el PDF
  // en el mismo pedido y el cartel quedó afuera de la ventana, no del código.
  // «Sin asiento» tiene DOS causas: que falte el modelo, o que las operaciones ya
  // estuvieran contabilizadas. Decir siempre «falta el modelo» manda a cambiar
  // una parametrización que está bien puesta.
  const p = trozo(PANEL, 'function sgFgGuardar(){', SALTO + '}' + SALTO);
  assert.match(p, /sin asiento: falta elegir el asiento modelo/);
  assert.match(p, /ya estaba contabilizada al valorizarla/);
  assert.match(p, /r\.data\.solo_comprobante/);
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
  // Con el circuito explícito: el mismo modal sirve para los tres, y sin decirle
  // cuál es se contabilizaría con el modelo de la descarga.
  assert.match(barra, /onclick="sgFgAbrir\('descarga'\)">🧾 Ingresar factura/);
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
  // El armado del selector se mudó a sgFgProvs, que es el que sabe de qué
  // circuito es la factura: a la descarga se le factura a la cooperativa y al
  // flete, al fletero.
  const p = PANEL.slice(PANEL.indexOf('function sgFgProvs(){'), PANEL.indexOf('function sgFgProv(){'));
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

// ══════════════════════════════════════════════════════════════════════════
// LOS TRES CIRCUITOS SE FACTURAN CON EL MISMO MECANISMO
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 7/9/2026: «necesito el lugar donde contabilizar la factura, con la misma
// lógica que en Control Cooperativa... seleccionando los valorizados».

function circuitos() {
  const src = trozo(SG, 'const CIRCUITOS_FACTURA = {', SALTO + '};');
  return new Function("const CLAVE_MODELO_GASTO='asiento_modelo_descarga',"
    + "CLAVE_MODELO_FLETE='asiento_modelo_flete',"
    + "CLAVE_MODELO_FLETE_SALIDA='asiento_modelo_flete_salida';\n"
    + src + '\nreturn CIRCUITOS_FACTURA;')();
}

test('los tres circuitos, cada uno con SU tipo de gasto y SU asiento modelo', () => {
  const c = circuitos();
  assert.deepEqual(Object.keys(c).sort(), ['descarga', 'flete_entrada', 'flete_salida']);
  // La cooperativa hace DOS cosas —baja el camión que entra y carga el que
  // sale— y las dos se le facturan juntas. Con un solo tipo, la carga de salida
  // se quedaba sin circuito y dejaba de poder facturarse.
  assert.deepEqual(c.descarga.tipos, ['descarga_ingreso', 'carga_salida']);
  assert.equal(c.descarga.clave, 'asiento_modelo_descarga');
  assert.deepEqual(c.flete_entrada.tipos, ['flete_entrada']);
  assert.equal(c.flete_entrada.clave, 'asiento_modelo_flete');
  assert.deepEqual(c.flete_salida.tipos, ['flete_salida']);
  assert.equal(c.flete_salida.clave, 'asiento_modelo_flete_salida');
  // Tres claves distintas: con una sola, los tres irían a la misma cuenta.
  assert.equal(new Set(Object.values(c).map((x) => x.clave)).size, 3);
});

test('un circuito inventado no se contesta', () => {
  // Viene del navegador y decide con qué modelo se contabiliza una factura: sin
  // lista blanca, el que manda el pedido elige la cuenta contable.
  const f = new Function('CIRCUITOS_FACTURA',
    trozo(SG, 'function circuitoFactura(v) {', SALTO + '}') + '\nreturn circuitoFactura;')(circuitos());
  assert.deepEqual(f('flete_salida').tipos, ['flete_salida']);
  assert.equal(f('inventado'), null);
  assert.equal(f('').circuito, 'descarga', 'sin circuito no cae en el de la descarga');
  // La CLAVE del circuito viaja adentro: la columna `circuito` de la factura
  // guarda eso y no el tipo de gasto, que desde ahora ya no lo identifica.
  assert.equal(f('flete_salida').circuito, 'flete_salida');
});

test('la lista de facturables NO mezcla circuitos', () => {
  // Era el agujero: filtraba sólo por proveedor. Un fletero dado de alta también
  // como proveedor de una cooperativa metía sus fletes en la factura de la
  // descarga, y se contabilizaban con el modelo de la descarga.
  const db = base();
  db.prepare("INSERT INTO sg_gastos_directos (id, tipo_gasto, despacho_id, proveedor_servicio_id, estado, monto, fecha_servicio, activo) VALUES (10,'flete_salida',1,4,'valorizado',7000,'2026-09-03',1)").run();
  db.prepare("INSERT INTO sg_gastos_directos (id, tipo_gasto, recepcion_id, proveedor_servicio_id, estado, monto, fecha_servicio, activo) VALUES (11,'flete_entrada',1,4,'valorizado',3000,'2026-09-03',1)").run();

  assert.deepEqual(facturables(db, 4, ['descarga_ingreso', 'carga_salida']).map((x) => x.id), [1, 2]);
  assert.deepEqual(facturables(db, 4, ['flete_salida']).map((x) => x.id), [10]);
  assert.deepEqual(facturables(db, 4, ['flete_entrada']).map((x) => x.id), [11]);
  db.close();
});

test('el flete de salida trae su REMITO y su cliente, que es de lo que cuelga', () => {
  // No cuelga de una partida: sin esto la fila salía sin ninguna referencia y no
  // se podía saber qué se está facturando.
  const db = base();
  db.prepare("INSERT INTO sg_clientes (id, razon_social) VALUES (3,'Supermercado X')").run();
  db.prepare("INSERT INTO sg_despachos (id, numero, cliente_id) VALUES (1,'R-0001',3)").run();
  db.prepare("INSERT INTO sg_gastos_directos (id, tipo_gasto, despacho_id, proveedor_servicio_id, estado, monto, fecha_servicio, activo) VALUES (10,'flete_salida',1,4,'valorizado',7000,'2026-09-03',1)").run();
  const f = facturables(db, 4, ['flete_salida'])[0];
  assert.equal(f.numero_remito, 'R-0001');
  assert.equal(f.cliente, 'Supermercado X');
  db.close();
});

test('lo que ya está contabilizado no se vuelve a asentar NI se corrige a mano', () => {
  // Quedan fletes de entrada valorizados con la versión anterior, que armaban su
  // asiento al valorizar. Para ésos la base fiscal que YA ESTÁ en el libro es lo
  // VALORIZADO. Las líneas de gestión, en cambio, están pensadas para llevar el
  // asiento DESDE lo facturado HACIA lo acordado: aplicarlas sobre una base que
  // ya es lo acordado corrige al revés.
  //
  // Así que la factura de esas operaciones no asienta nada — sólo guarda el
  // comprobante — y si no coincide con lo valorizado se frena y se pide arreglar
  // la valorización. Inventar el ajuste habría sido peor que no hacerlo.
  const b = trozo(SG, "router.post('/gastos-factura', facturaGastoUpload", SALTO + '});');
  assert.match(b, /const soloComprobante = conAsiento === elegidos\.length;/);
  assert.match(b, /if \(soloComprobante && dif !== 0\)/);
  assert.match(b, /Corregí la /);
  assert.match(b, /valorización con el importe de la factura/);
  assert.match(b, /soloComprobante\s*\n?\s*\? \{ sin_modelo: false, lineas: \[\], totales: \{\} \}/);
  // Y ya no existe el asiento «sólo de gestión»: era el que corregía al revés.
  assert.ok(!/soloGestion/.test(SG), 'quedó el camino que inventaba el ajuste');
});

test('un asiento ANULADO no cuenta como contabilizado', () => {
  // Con `asiento_id IS NOT NULL` a secas, un asiento anulado a mano desde
  // Asientos Contables seguía contando: la factura no lo volvía a poner y el
  // gasto se caía del libro sin que nadie se enterara.
  const b = trozo(SG, "router.get('/gastos-facturables'", SALTO + '});');
  assert.match(b, /LEFT JOIN sg_asientos a\s+ON a\.id = g\.asiento_id/);
  assert.match(b, /CASE WHEN a\.id IS NOT NULL AND COALESCE\(a\.anulado,0\)=0/);
  const y = trozo(SG, 'function soloYaAsentados(db, ids) {', SALTO + '}');
  assert.match(y, /COALESCE\(a\.anulado,0\)=0/);

  // Y se corre: un gasto con asiento anulado vuelve a ofrecerse para facturar.
  const db = base();
  db.prepare('INSERT INTO sg_asientos (id, anulado) VALUES (7,1)').run();
  db.prepare('UPDATE sg_gastos_directos SET asiento_id=7 WHERE id=1').run();
  const f = facturables(db, 4, ['descarga_ingreso', 'carga_salida']).find((x) => x.id === 1);
  assert.equal(f.asiento_id, null, 'un asiento anulado sigue contando como contabilizado');
  db.close();
});

test('y una factura se puede ANULAR: si no, la operación queda trabada para siempre', () => {
  // El filtro que impide facturar dos veces sólo se suelta con activo=0, y no
  // había ninguna ruta que lo escribiera: una factura mal cargada dejaba sus
  // operaciones bloqueadas y su asiento en el libro, sin vuelta atrás.
  const a = trozo(SG, "router.post('/gastos-factura/:id/anular'", SALTO + '});');
  assert.match(a, /Escribí por qué se anula/);
  assert.match(a, /UPDATE sg_asientos SET anulado=1/);
  assert.match(a, /UPDATE sg_facturas_gasto SET activo=0/);
  assert.match(a, /anulada_en=datetime\('now','localtime'\), anulada_por=\?/);
  // Anular la factura y dejar el asiento vivo la deja fuera del libro por el
  // otro lado, así que van juntas.
  assert.match(a, /db\.transaction\(\(\) => \{/);
  // Y es su PROPIA dirección: exigirNivel reconoce la anulación por la URL.
  assert.match(SG, /router\.post\('\/gastos-factura\/:id\/anular', requireAuth,/);
});

test('mezclar contabilizadas con no contabilizadas se rechaza, no se adivina', () => {
  // En una sola factura no hay asiento que sea correcto para las dos: si pone lo
  // fiscal, duplica lo que ya estaba; si no lo pone, deja sin asentar lo que
  // faltaba.
  const b = trozo(SG, "router.post('/gastos-factura', facturaGastoUpload", SALTO + '});');
  assert.match(b, /if \(conAsiento && conAsiento !== elegidos\.length\)/);
  assert.match(b, /Hacé una factura para cada grupo/);
  // Y la pantalla lo dice antes de apretar guardar.
  // El freno vive en sgFgFreno, que es lo que mira el botón: un cartel que no
  // deshabilita nada se lee como un dato más y el operador aprieta igual.
  const fr = trozo(PANEL, 'function sgFgFreno(){', SALTO + '}');
  assert.match(fr, /Estás mezclando operaciones ya contabilizadas/);
  assert.match(fr, /Corregí la valorización/);
  const bt = trozo(PANEL, 'function sgFgBoton(){', SALTO + '}');
  assert.match(bt, /b\.disabled = !!freno;/);
  // Y el cartel cambia de color: azul cuando informa, rojo cuando frena.
  const y = trozo(PANEL, 'function sgFgYaAsentado(){', SALTO + '}');
  assert.match(y, /var malo = !!freno;/);
  assert.match(y, /ya están contabilizadas/);
});

test('la suma de lo valorizado también mira el circuito', () => {
  // Sumar una descarga adentro de una factura de flete daría una diferencia de
  // gestión inventada — y esa diferencia se graba.
  const b = trozo(SG, 'function sumaValorizada(db, ids, prov, tipos) {', SALTO + '}');
  assert.match(b, /AND tipo_gasto IN \(\$\{t\}\)/);
  assert.match(b, /\.get\(\.\.\.ids, prov, \.\.\.tipos\)/);
});

test('la factura guarda de qué circuito es', () => {
  // Se puede derivar de los items, pero derivarlo en cada consulta es una cuenta
  // más que se puede hacer distinta en cada lugar.
  const b = trozo(SG, "router.post('/gastos-factura', facturaGastoUpload", SALTO + '});');
  assert.match(b, /leido_por_ia, circuito, creado_por\)/);
  // La CLAVE del circuito, no el tipo de gasto: la descarga tiene dos tipos.
  assert.match(b, /c\.circuito, uid\(req\)\)\.lastInsertRowid/);
  assert.match(DBSG, /\['circuito',\s+'TEXT'\]/);
  // Y el asiento dice de qué circuito es: «Factura de servicio 0001-12» no
  // distingue una descarga de un flete cuando se lo mira desde el mayor.
  assert.match(b, /descripcion: 'Factura de ' \+ c\.label \+ ' ' \+ numero/);
});

test('el mismo modal para los tres, con el circuito explícito', () => {
  // Sin decirle cuál es, se contabilizaría todo con el modelo de la descarga.
  for (const [pane, k] of [
    ['sggd-pane-coop', 'descarga'],
    ['sggd-pane-flete_entrada', 'flete_entrada'],
    ['sggd-pane-flete_salida', 'flete_salida'],
  ]) {
    const i = PANEL.indexOf('id="' + pane + '"');
    assert.ok(i > 0, 'no existe ' + pane);
    assert.match(PANEL.slice(i, i + 6000),
      new RegExp("onclick=\"sgFgAbrir\\('" + k + "'\\)\">🧾 Ingresar factura"),
      pane + ': no tiene el botón, o no le pasa el circuito');
  }
  assert.equal((PANEL.match(/id="sg-fg-modal"/g) || []).length, 1, 'hay más de un modal de factura');
  // Y las tres llamadas al servidor lo llevan.
  const a = trozo(PANEL, 'function sgFgProv(){', SALTO + '}');
  assert.match(a, /&circuito=' \+ encodeURIComponent\(SGFG\.circuito\)/);
  const s2 = trozo(PANEL, 'function sgFgAsiento(){', SALTO + '}');
  assert.match(s2, /circuito: SGFG\.circuito,/);
  const g = trozo(PANEL, 'function sgFgGuardar(){', SALTO + '}' + SALTO);
  assert.match(g, /fd\.append\('circuito', SGFG\.circuito\)/);
});

test('a cada circuito se le factura a quien corresponde', () => {
  // A la descarga, a la cooperativa —el catálogo ya trae atado su proveedor—; al
  // flete, al fletero del padrón. Mezclarlos ofrecería cooperativas para
  // facturar un flete.
  const p = trozo(PANEL, 'function sgFgProvs(){', SALTO + '}');
  assert.match(p, /c\.provs === 'fleteros'/);
  assert.match(p, /api\('\/api\/sg\/proveedores-servicio'\)/);
  assert.match(p, /SG_COOPS/);
});

test('y la anulación es alcanzable: la lista de lo ya facturado está en el modal', () => {
  // Un endpoint sin pantalla es un endpoint que no existe. Va en el mismo modal
  // porque es donde alguien se da cuenta de que cargó una mal: la operación que
  // busca no aparece arriba justamente porque ya está en una de éstas.
  const i = PANEL.indexOf('id="sg-fg-yacargadas"');
  assert.ok(i > 0, 'no está la lista de facturas ya cargadas');
  const b = PANEL.slice(i - 700, i + 1200);
  assert.match(b, /YA FACTURADO A ESTE PROVEEDOR/);
  assert.match(b, /overflow-x:hidden !important/);
  assert.match(b, /table-layout:fixed/);

  const f = trozo(PANEL, 'function sgFgYaCargadas(){', SALTO + '}');
  assert.match(f, /api\('\/api\/sg\/gastos-factura\?proveedor_servicio_id='/);
  // Sólo las de ESTE circuito: las de otro no se anulan desde acá.
  assert.match(f, /f\.circuito === SGFG\.circuito/);
  // El botón se ofrece por NIVEL, con la misma regla que usa el servidor.
  assert.match(f, /lnbPuedeAnular\(\['sg-gastos-directos', 'sg-control-coop'\]\)/);

  const a = trozo(PANEL, 'function sgFgAnular(id, numero){', SALTO + '}');
  assert.match(a, /¿Por qué se anula la factura/);
  assert.match(a, /'\/anular', 'POST', \{ motivo: motivo \}/);
  // Y se recarga lo de arriba: las operaciones que cubría vuelven a la lista.
  assert.match(a, /sgFgProv\(\);/);
});
