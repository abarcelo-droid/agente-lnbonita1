// ══ PAGARLE A UN PROVEEDOR CON INSUMOS ═════════════════════════════════════
//
// Pablo, 20/10/2026: «a veces hay proveedores a los que les pagamos con INSUMOS… necesito un lugar
// donde llevar el registro de lo que se le entregó, la factura del insumo, el costo de ese insumo
// (dólares o pesos), la cantidad… y saber si lo recuperé mediante factura al proveedor, de vuelta,
// qué precio le cobramos, pesos o dólares… que me permita adjuntar la factura».
//
// Lo que este archivo clava es lo que no se ve hasta que el depósito no cuadra:
//
//  1. QUE LA MERCADERÍA QUE SALE SALGA DEL STOCK, convertida de unidad de compra a unidad de uso,
//     y sólo cuando se dijo que salía del depósito.
//  2. QUE SE PUEDA VOLVER ATRÁS EXACTO: corregir, destildar, borrar. El número de lo aplicado es
//     el ancla, igual que en la recepción.
//  3. QUE NO SE RECUPERE CON LA FACTURA DE OTRO PROVEEDOR, que es el error que deja dos cuentas
//     corrientes mal y no se nota hasta conciliar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const RUTA = leer('src/rutas/planificacion.js');
const DDL = leer('src/servicios/db_pli.js');

function fuente(txt, firma) {
  const i = txt.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  let prof = 0, k = txt.indexOf('{', i);
  for (; k < txt.length; k++) {
    if (txt[k] === '{') prof++;
    else if (txt[k] === '}') { prof--; if (prof === 0) break; }
  }
  return txt.slice(i, k + 1);
}

const TABLAS = ['pli_insumos', 'pli_entregas', 'pli_entrega_lineas', 'pli_recuperos', 'pli_adjuntos'];
function base() {
  const db = new DatabaseSync(':memory:');
  for (const t of TABLAS) {
    const i = DDL.indexOf('CREATE TABLE IF NOT EXISTS ' + t + ' (');
    assert.ok(i >= 0, 'no está la tabla ' + t);
    db.exec(DDL.slice(i, DDL.indexOf('\n  );', i) + 4).replace(/REFERENCES [a-z_]+\([a-z_]+\)/g, ''));
  }
  for (const m of DDL.match(/addCol\('[a-z_]+',\s*'[a-z_]+',\s*'[^']+'\)/g) || []) {
    const [, t, col, tipo] = /addCol\('([a-z_]+)',\s*'([a-z_]+)',\s*'([^']+)'\)/.exec(m);
    if (!TABLAS.includes(t)) continue;
    if (!db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).includes(col)) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${tipo}`);
    }
  }
  // ETIQUETA: se compra por MILLAR y se consume por unidad. Es donde el factor amplifica
  // cualquier error, y es un insumo real del módulo.
  db.exec(`INSERT INTO pli_insumos (id, sociedad_id, nombre, unidad_compra, unidad_uso,
             factor_compra, stock_inicial, modo_provision)
           VALUES (1, 1, 'ETIQUETA DAMASCO', 'MILLAR', 'unidad', 1000, 50000, 'compra'),
                  (2, 1, 'CAJA GRANDE', 'UN', 'UN', 1, 8000, 'compra')`);
  return db;
}

// La puerta REAL, leída del router.
const puerta = (db) => new Function('db', 'bad', 'logPli', 'AHORA', [
  'const redondear = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;',
  fuente(RUTA, 'function moverStockPorEntrega(linea, objetivoCompra, mueveStock, userId)'),
  'return moverStockPorEntrega;',
].join('\n'))(db, (m) => Object.assign(new Error(m), { status: 400 }), () => {}, "datetime('now','localtime')");

const stock = (db, id = 1) => db.prepare('SELECT stock_inicial FROM pli_insumos WHERE id=?').get(id).stock_inicial;
const aplicado = (db, id) => db.prepare('SELECT stock_aplicado FROM pli_entrega_lineas WHERE id=?').get(id).stock_aplicado;

function linea(db, { insumo = 1, cantidad = 8 } = {}) {
  db.exec(`INSERT INTO pli_entregas (id, sociedad_id, proveedor_texto, fecha)
           VALUES (1, 1, 'CARTOCOR', '2026-10-20')`);
  const r = db.prepare(`INSERT INTO pli_entrega_lineas (entrega_id, insumo_id, cantidad, moneda)
    VALUES (1, ?, ?, 'ARS')`).run(insumo, cantidad);
  return db.prepare('SELECT * FROM pli_entrega_lineas WHERE id=?').get(r.lastInsertRowid);
}

// ── EL STOCK ───────────────────────────────────────────────────────────────

test('entregar 8 millares descuenta 8.000 unidades, no 8', () => {
  // La línea está en unidad de COMPRA y el stock vive en unidad de USO. Sin convertir, el plan
  // creería que en el depósito quedan 49.992 etiquetas cuando quedan 42.000.
  const db = base();
  const l = linea(db, { cantidad: 8 });
  puerta(db)(l, 8, 1, 7);
  assert.equal(stock(db), 42000);
  assert.equal(aplicado(db, l.id), 8000, 'lo aplicado se anota en unidad de uso');
});

test('si no sale del depósito, el stock no se toca', () => {
  // Es la casilla que eligió Pablo: a veces la mercadería se compra y va directo al proveedor.
  const db = base();
  const l = linea(db, { cantidad: 8 });
  puerta(db)(l, 8, 0, 7);
  assert.equal(stock(db), 50000);
  assert.equal(aplicado(db, l.id), 0);
});

test('guardar dos veces no descuenta dos veces', () => {
  const db = base();
  const l = linea(db, { cantidad: 8 });
  puerta(db)(l, 8, 1, 7);
  const otra = db.prepare('SELECT * FROM pli_entrega_lineas WHERE id=?').get(l.id);
  puerta(db)(otra, 8, 1, 7);
  assert.equal(stock(db), 42000);
});

test('corregir la cantidad mueve SÓLO la diferencia', () => {
  const db = base();
  const l = linea(db, { cantidad: 8 });
  puerta(db)(l, 8, 1, 7);
  const otra = db.prepare('SELECT * FROM pli_entrega_lineas WHERE id=?').get(l.id);
  puerta(db)(otra, 6, 1, 7);                       // llegaron a un acuerdo por menos
  assert.equal(stock(db), 44000, 'tenía que devolver 2.000, no recalcular desde cero');
  assert.equal(aplicado(db, l.id), 6000);
});

test('destildar que sale del depósito devuelve todo', () => {
  const db = base();
  const l = linea(db, { cantidad: 8 });
  puerta(db)(l, 8, 1, 7);
  const otra = db.prepare('SELECT * FROM pli_entrega_lineas WHERE id=?').get(l.id);
  puerta(db)(otra, 8, 0, 7);
  assert.equal(stock(db), 50000);
  assert.equal(aplicado(db, l.id), 0, 'si no vuelve a cero, borrarla después devolvería de más');
});

test('no se entrega más de lo que hay, y el aviso dice los dos números', () => {
  // El stock es un número solo: dejarlo negativo —o taparlo con un MAX(0, …)— rompe la cuenta de
  // lo que hay que devolver, porque lo anotado dejaría de ser lo que realmente salió.
  const db = base();
  const l = linea(db, { insumo: 2, cantidad: 9000 });   // hay 8.000 cajas
  assert.throws(() => puerta(db)(l, 9000, 1, 7), /8\.?000|8000/);
  assert.throws(() => puerta(db)(l, 9000, 1, 7), /destildá/);
  assert.equal(stock(db, 2), 8000, 'tocó el stock antes de frenar');
  assert.equal(aplicado(db, l.id), 0);
});

test('lo anotado y lo que salió del depósito no pueden decir cosas distintas', () => {
  // Mover el stock y anotar lo aplicado pasan por la MISMA función: si la anotación viviera
  // afuera, un `return` en el medio dejaría al depósito diciendo una cosa y a la línea otra, y a
  // partir de ahí no hay manera de saber cuánto devolver.
  const f = fuente(RUTA, 'function moverStockPorEntrega(linea, objetivoCompra, mueveStock, userId)');
  assert.equal((f.match(/UPDATE pli_entrega_lineas SET stock_aplicado/g) || []).length, 2,
    'la anotación tiene que estar en los dos caminos: el que mueve y el que no');
  // Y ningún otro lugar la escribe por su cuenta.
  assert.equal((RUTA.match(/UPDATE pli_entrega_lineas SET stock_aplicado/g) || []).length, 2,
    'alguien escribe lo aplicado fuera de la puerta');
});

test('se puede deshacer una entrega que se llevó TODO el stock', () => {
  // Es el caso que parece de laboratorio y es el más normal: se entrega todo lo que había, el
  // depósito queda en cero, y entonces la devolución es más grande que el stock. Un tope que
  // mirara el valor absoluto frenaría justo acá y dejaría la entrega sin poder deshacerse.
  const db = base();
  const l = linea(db, { insumo: 2, cantidad: 8000 });   // hay 8.000 cajas, se entregan las 8.000
  puerta(db)(l, 8000, 1, 7);
  assert.equal(stock(db, 2), 0);
  const otra = db.prepare('SELECT * FROM pli_entrega_lineas WHERE id=?').get(l.id);
  puerta(db)(otra, 8000, 0, 7);                          // se destilda que salía del depósito
  assert.equal(stock(db, 2), 8000, 'no se pudo devolver lo que había salido');
});

test('devolver el stock de una entrega lo devuelve de verdad', () => {
  // `devolverStockDeEntrega` lleva lo aplicado a cero. Si en vez de eso volviera a aplicar lo
  // mismo, el movimiento daría cero y la plata no volvería — y lo usan el borrado y la corrección.
  const db = base();
  const l = linea(db, { cantidad: 8 });
  puerta(db)(l, 8, 1, 7);
  assert.equal(stock(db), 42000);
  const devolver = new Function('db', 'moverStockPorEntrega', [
    'const ' + /const devolverStockDeEntrega = [\s\S]*?\n};/.exec(RUTA)[0].slice(6),
    'return devolverStockDeEntrega;',
  ].join('\n'))(db, puerta(db));
  devolver(db.prepare('SELECT * FROM pli_entrega_lineas WHERE entrega_id=1').all(), 7);
  assert.equal(stock(db), 50000, 'el stock no volvió');
  assert.equal(aplicado(db, l.id), 0);
});

test('un movimiento de cero no le estampa la fecha a un insumo que no cambió', () => {
  const db = base();
  const l = linea(db, { cantidad: 8 });
  puerta(db)(l, 0, 1, 7);
  assert.equal(db.prepare('SELECT stock_actualizado_en FROM pli_insumos WHERE id=1').get().stock_actualizado_en, null);
});

// ── VOLVER ATRÁS ───────────────────────────────────────────────────────────

test('borrar la entrega devuelve el stock, y una recuperada no se borra', () => {
  const baja = fuente(RUTA, "router.delete('/entregas/:id'");
  assert.match(baja, /devolverStockDeEntrega\(lineasDeEntrega\(e\.id\), req\.user\.id\)/);
  assert.match(baja, /db\.transaction\(\(\) => \{/, 'a medio camino el depósito queda mintiendo');
  // Y si ya se recuperó con una factura, primero hay que desvincularla: el papel que le hicimos al
  // proveedor dice un importe contra esta mercadería.
  assert.match(baja, /está recuperada con una factura/);
  const edicion = fuente(RUTA, "router.patch('/entregas/:id'");
  assert.match(edicion, /if \(e\.recupero_id\) \{/);
  assert.match(edicion, /Desvinculala de la factura antes de corregirla/);
});

test('corregir los renglones devuelve todo y vuelve a aplicar, en una transacción', () => {
  // Corregir renglón por renglón es la puerta por la que se cuela un descuadre: uno se actualiza,
  // otro falla, y el depósito queda a medias.
  const e = fuente(RUTA, "router.patch('/entregas/:id'");
  assert.match(e, /devolverStockDeEntrega\(viejas, req\.user\.id\)/);
  assert.match(e, /DELETE FROM pli_entrega_lineas WHERE entrega_id=\?/);
  assert.ok(e.indexOf('db.transaction') < e.indexOf('devolverStockDeEntrega'));
});

// ── EL RECUPERO ────────────────────────────────────────────────────────────

test('no se recupera con una factura hecha a otro proveedor', () => {
  const f = fuente(RUTA, "router.post('/entregas/:id/recupero'");
  assert.match(f, /TRIM\(\?\) = TRIM\(\?\) COLLATE NOCASE/);
  assert.match(f, /if \(!mismo\) \{/);
  assert.match(f, /Una entrega se recupera con una factura hecha al mismo proveedor/);

  // «Cartocor S.A.» y «CARTOCOR S.A.» son el mismo proveedor, y con un espacio de más también.
  // Se corre la comparación REAL contra SQLite: es la misma que usa el armado de la orden de
  // compra para juntar renglones, así que lo que empata en un lado empata en el otro.
  const db = base();
  const mismo = (a, b) => !!db.prepare('SELECT 1 n WHERE TRIM(?) = TRIM(?) COLLATE NOCASE').get(a, b);
  assert.ok(mismo('Cartocor S.A.', 'CARTOCOR S.A.'));
  assert.ok(mismo(' Cartocor S.A. ', 'Cartocor S.A.'));
  assert.ok(!mismo('CARTOCOR', 'SMURFIT'));
  // Y NO se inventa un normalizador propio para este caso: el módulo compara los nombres de
  // proveedor así en todos lados. Empatar los acentos acá y no en los otros doce lugares sería
  // peor que no empatarlos: la misma pregunta daría distinto según la pantalla.
  assert.ok(!/normalize\('NFD'\)/.test(RUTA), 'apareció un normalizador propio en el módulo');
});

test('borrar la factura deja las entregas otra vez pendientes', () => {
  // Si el puntero quedara apuntando a una factura borrada, esas entregas se verían recuperadas
  // por un papel que ya no existe — y nadie las volvería a facturar.
  const f = fuente(RUTA, "router.delete('/recuperos/:id'");
  assert.match(f, /UPDATE pli_entregas SET recupero_id=NULL[\s\S]*WHERE recupero_id=\?/);
  assert.match(f, /db\.transaction\(\(\) => \{/);
  const db = base();
  db.exec(`INSERT INTO pli_recuperos (id, sociedad_id, proveedor_texto, fecha) VALUES (9, 1, 'CARTOCOR', '2026-10-21')`);
  db.exec(`INSERT INTO pli_entregas (id, sociedad_id, proveedor_texto, fecha, recupero_id)
           VALUES (5, 1, 'CARTOCOR', '2026-10-20', 9)`);
  db.prepare('UPDATE pli_entregas SET recupero_id=NULL WHERE recupero_id=?').run(9);
  assert.equal(db.prepare('SELECT recupero_id FROM pli_entregas WHERE id=5').get().recupero_id, null);
});

test('se puede soltar una entrega de su factura sin borrar nada', () => {
  const f = fuente(RUTA, "router.post('/entregas/:id/recupero'");
  assert.match(f, /if \(crudo === null \|\| crudo === undefined \|\| crudo === ''\)/);
  assert.match(f, /recupero_id=NULL/);
});

// ── EL COSTO ───────────────────────────────────────────────────────────────

const costoDe = new Function([fuente(RUTA, 'function costoDeEntrega(lineas)'), 'return costoDeEntrega;'].join('\n'))();
const L = (cantidad, costo_unitario, moneda) => ({ cantidad, costo_unitario, moneda });

test('el costo de la entrega se suma sólo si se puede sumar', () => {
  assert.deepEqual(costoDe([L(8, 1000, 'ARS'), L(2, 500, 'ARS')]),
    { costo: 9000, moneda: 'ARS', sin_costo: 0, varias_monedas: false });
  // Con un renglón sin costo, cualquier total sería mentira: es el mismo criterio que el total de
  // la orden de compra.
  assert.equal(costoDe([L(8, 1000, 'ARS'), L(2, null, 'ARS')]).costo, null);
  assert.equal(costoDe([L(8, 1000, 'ARS'), L(2, null, 'ARS')]).sin_costo, 1);
  // Y con dos monedas tampoco: pesos y dólares no se suman.
  assert.equal(costoDe([L(8, 1000, 'ARS'), L(2, 10, 'USD')]).costo, null);
  assert.equal(costoDe([L(8, 1000, 'ARS'), L(2, 10, 'USD')]).varias_monedas, true);
  assert.equal(costoDe([]).costo, null);
});

test('los centavos no se pierden en el total', () => {
  assert.equal(costoDe([L(3, 1811.3, 'ARS')]).costo, 5433.9);
});

// ── LO QUE SE CARGA ────────────────────────────────────────────────────────

test('una entrega sin renglones no es una entrega', () => {
  const f = fuente(RUTA, 'function leerLineas(b, soc)');
  assert.match(f, /La entrega tiene que llevar al menos un insumo/);
  assert.match(f, /máximo 100/);
  // Y el insumo tiene que ser de esta sociedad: con el id en el body alcanzaría para entregar el
  // insumo de otra empresa y descontarle el stock.
  assert.match(f, /no existe o es de otra sociedad/);
  assert.match(f, /sociedad_id=\? AND eliminado_en IS NULL/);
});

test('la moneda de cada renglón es pesos o dólares, y nada más', () => {
  const f = fuente(RUTA, 'function leerLineas(b, soc)');
  assert.match(f, /\['ARS', 'USD'\]\.includes\(l\.moneda\) \? l\.moneda : 'ARS'/);
  // Y la tabla lo vuelve a decir: un valor raro por otra puerta tampoco entra.
  const t = DDL.slice(DDL.indexOf('CREATE TABLE IF NOT EXISTS pli_entrega_lineas'));
  assert.match(t.slice(0, t.indexOf('\n  );')), /CHECK\(moneda IN \('ARS','USD'\)\)/);
});

// ── LOS PAPELES ────────────────────────────────────────────────────────────

test('el adjunto de otra empresa no se baja poniendo el id en la dirección', () => {
  const f = fuente(RUTA, "router.get('/adjunto/:id'");
  assert.match(f, /dueñoDeAdjunto\(soc, a\.entidad, a\.entidad_id\)/);
  // Y contesta «no encontrado», no «no podés»: decir que existe ya es decir algo.
  assert.match(f, /Archivo no encontrado/);
  const d = fuente(RUTA, 'function dueñoDeAdjunto(soc, entidad, id)');
  assert.match(d, /WHERE id=\? AND sociedad_id=\? AND eliminado_en IS NULL/);
  // La entidad sale de una lista cerrada: sin eso, el nombre de la tabla lo elegiría el que llama.
  assert.match(d, /if \(!tabla\) throw bad\('Entidad inválida'\)/);

  // Y LA LISTA ES CERRADA DE VERDAD. Con un objeto literal, «constructor», «__proto__» y otras
  // diez palabras heredadas de Object devuelven algo truthy, pasan el guard y llegan a
  // interpolarse como nombre de tabla. No es una inyección —lo interpolado sale del prototipo— pero
  // convierte un 400 que explica en un 500 que no dice nada. Se corre la lista REAL.
  const ENTIDADES = new Function('return ' + /const ENTIDADES = (.*);/.exec(RUTA)[1] + ';')();
  for (const k of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'nada']) {
    assert.ok(!ENTIDADES[k], 'la palabra «' + k + '» pasa el guard y llega al SQL');
  }
  assert.equal(ENTIDADES.entrega, 'pli_entregas');
  assert.equal(ENTIDADES.recupero, 'pli_recuperos');
});

test('un papel sólo puede ser un PDF, un JPG o un PNG', () => {
  // Los adjuntos se bajan desde el MISMO ORIGEN que el panel y con `inline`: un .html subido como
  // «factura» se abriría como una página adentro de la sesión del que lo mira. Y el tipo que llega
  // en el pedido lo escribe el que sube, así que el filtro va de los dos lados.
  assert.match(RUTA, /const PAPEL_MIMES = new Set\(\['application\/pdf', 'image\/jpeg', 'image\/png'\]\);/);
  const post = fuente(RUTA, "router.post('/adjuntos/:entidad/:id'");
  assert.match(post, /if \(!PAPEL_MIMES\.has\(mime\)\)/);
  assert.match(post, /tiene que ser un PDF, un JPG o un PNG/);
  assert.ok(post.indexOf('PAPEL_MIMES.has') < post.indexOf('await subirArchivo'),
    'lo rechazado se sube igual a R2');
  // Y al devolverlo, el tipo sale de la lista y no del dato guardado.
  const get = fuente(RUTA, "router.get('/adjunto/:id'");
  assert.match(get, /const tipo = PAPEL_MIMES\.has\(a\.mime\) \? a\.mime : 'application\/octet-stream';/);
  assert.match(get, /'X-Content-Type-Options': 'nosniff'/);
  assert.match(get, /application\/octet-stream' \? 'attachment' : 'inline'/);
  assert.ok(!/'Content-Type': a\.mime/.test(RUTA), 'alguna ruta sigue devolviendo el tipo guardado');
  // LAS DOS RUTAS QUE BAJAN UN ARCHIVO, no una: la de los adjuntos y la de los papeles del insumo,
  // que es de donde se copió. Contarlas es lo que evita arreglar una y dejar la otra abierta.
  assert.equal((RUTA.match(/const tipo = PAPEL_MIMES\.has\(a\.mime\)/g) || []).length, 2);
  assert.equal((RUTA.match(/'X-Content-Type-Options': 'nosniff'/g) || []).length, 2);
  // Y la pantalla dice lo mismo en el campo de los papeles, para no ofrecer lo que va a rebotar.
  const campo = PANEL.slice(PANEL.indexOf('id="pli-pag-file"') - 200, PANEL.indexOf('id="pli-pag-file"') + 200);
  assert.match(campo, /accept="application\/pdf,image\/jpeg,image\/png"/);
});

test('la baja del archivo es lógica: el original queda en R2', () => {
  const f = fuente(RUTA, "router.delete('/adjunto/:id'");
  assert.match(f, /UPDATE pli_adjuntos SET eliminado_en=/);
  assert.ok(!/borrarArchivo|deleteObject/i.test(f), 'una baja por error no puede perder el original');
});

// ── LA PANTALLA ────────────────────────────────────────────────────────────

const PANEL = leer('src/panel.html');

test('la solapa existe y carga al entrar, como las otras', () => {
  assert.match(PANEL, /data-pli="pagos"\s+onclick="pliTab\('pagos'\)"/);
  assert.match(PANEL, /<div class="pli-pane" id="pli-pane-pagos">/);
  assert.match(fuente(PANEL, 'function pliTab(t)'), /if \(t === 'pagos'\) pliPagCargar\(\);/);
});

test('lo que se escribe en los renglones no se pierde al agregar otro', () => {
  // Los renglones se redibujan enteros cada vez que se agrega o se saca uno. Si el dato viviera
  // en los campos del formulario, cada redibujo borraría lo tipeado.
  const f = fuente(PANEL, 'function pliEntLineaCambio(i, campo, valor)');
  assert.match(f, /PLI\.entLineas\[i\]\[campo\] = valor;/);
  assert.match(fuente(PANEL, 'function pliEntLineasPintar()'), /PLI\.entLineas\.forEach/);
  assert.match(fuente(PANEL, 'function pliEntregaGuardar()'), /PLI\.entLineas/);
});

test('la pantalla no deja guardar una entrega vacía ni sin proveedor', () => {
  const g = fuente(PANEL, 'function pliEntregaGuardar()');
  assert.match(g, /Poné al menos un insumo con cantidad/);
  assert.match(g, /¿A qué proveedor se le entregó\?/);
  // Los renglones a medio llenar no se mandan: un insumo sin cantidad no es una entrega.
  assert.match(g, /l\.insumo_id && Number\(l\.cantidad\) > 0/);
});

test('se ve la unidad de compra y el factor en cada renglón', () => {
  // La cantidad va en unidad de COMPRA y al stock entra convertida: entregar 8 millares son 8.000
  // etiquetas, y el que carga tiene que ver cuál es cuál antes de guardar.
  const f = fuente(PANEL, 'function pliEntLineasPintar()');
  assert.match(f, /pliEsc\(ins\.unidad_compra\)/);
  assert.match(f, /Number\(ins\.factor_compra\) !== 1/);
  assert.match(f, /Al stock entra por/);
});

test('la lista avisa cuando la mercadería NO salió del depósito', () => {
  // Cambia lo que el plan va a mandar a comprar: si no se ve, dos entregas iguales con distinto
  // tilde se leen igual.
  const f = fuente(PANEL, 'function pliPagRender()');
  assert.match(f, /e\.mueve_stock \? '' :/);
  assert.match(f, /no salió del depósito/);
  // Y lo que falta recuperar se ve de lejos, que es lo que se va a buscar.
  assert.match(f, /pendiente/);
  assert.match(f, /recuperado/);
});

test('el total de la entrega no se inventa cuando no se puede sumar', () => {
  // Se CORRE la función, no se busca el texto: el cartel puede seguir escrito en una rama a la
  // que nunca se llega, y entonces la pantalla totaliza igual lo que no se puede totalizar.
  const total = (lineas) => {
    let html = '';
    const doc = { getElementById: () => ({ set innerHTML(v) { html = v; } }) };
    new Function('document', 'PLI', 'pliN', 'pliEsc', 'pliPlata', [
      fuente(PANEL, 'function pliEntLineasValidas()'),
      fuente(PANEL, 'function pliEntTotal()'), 'pliEntTotal();',
    ].join('\n'))(doc, { entLineas: lineas }, (n, d) => Number(n).toFixed(d || 0),
      (s) => String(s), (v, m) => (m || 'ARS') + ' ' + Number(v).toFixed(2));
    return html;
  };
  // Un renglón completo lleva insumo y cantidad: es lo que el POST manda.
  const L = (cantidad, costo_unitario, moneda) => ({ insumo_id: 1, cantidad, costo_unitario, moneda });
  assert.match(total([L(8, 1000, 'ARS'), L(2, 500, 'ARS')]), /Nos costó.*ARS 9000\.00/);
  assert.match(total([L(8, 1000, 'ARS'), L(2, '', 'ARS')]), /No se totaliza.*falta el costo de un renglón/);
  assert.match(total([L(8, 1000, 'ARS'), L(2, '', 'ARS'), L(1, '', 'ARS')]), /falta el costo de 2 renglones/);
  assert.match(total([L(8, 1000, 'ARS'), L(2, 10, 'USD')]), /No se totaliza.*pesos y en dólares/);
  assert.match(total([]), /No se totaliza/);

  // EL TOTAL ES EL DE LO QUE SE VA A GUARDAR. El renglón a medio llenar —con cantidad y costo pero
  // sin el insumo elegido todavía— no se manda, así que tampoco puede sumar en el número que se
  // lee justo antes de apretar Guardar: eran 100.000 pesos de diferencia, sin un cartel.
  const aMedias = total([L(100, 1000, 'ARS'), { insumo_id: '', cantidad: 50, costo_unitario: 2000, moneda: 'ARS' }]);
  assert.match(aMedias, /ARS 100000\.00/, 'el total sumó un renglón que el guardado tira');
  assert.ok(!/200000/.test(aMedias));
  // Y se dice: descartarlo en silencio es cómo desaparece un insumo entero de una entrega.
  assert.match(aMedias, /Hay un renglón sin insumo o sin cantidad/);
  assert.match(total([L(8, 1000, 'ARS'), { insumo_id: 3, cantidad: '', costo_unitario: 9, moneda: 'ARS' }]),
    /Hay un renglón sin insumo o sin cantidad/, 'el renglón sin cantidad también desaparecía');
  // Un renglón recién agregado, vacío del todo, no es un error: es el que se va a llenar.
  assert.ok(!/Hay un renglón/.test(total([L(8, 1000, 'ARS'), { insumo_id: '', cantidad: '', costo_unitario: '' }])));
});

test('guardar frena cuando hay un renglón a medio llenar', () => {
  const g = fuente(PANEL, 'function pliEntregaGuardar()');
  assert.match(g, /var aMedias = PLI\.entLineas\.filter/);
  assert.match(g, /completalo o sacalo/);
  // Y el que se manda sale del MISMO filtro que totaliza: dos listas distintas es cómo el número
  // de la pantalla y el de la base dejan de ser el mismo.
  assert.match(g, /pliEntLineasValidas\(\)/);
  assert.match(fuente(PANEL, 'function pliEntTotal()'), /pliEntLineasValidas\(\)/);
});

test('borrar avisa que el stock vuelve, y sólo cuando había salido', () => {
  const f = fuente(PANEL, 'function pliEntregaBorrar(id)');
  assert.match(f, /e\.mueve_stock/);
  assert.match(f, /vuelve al stock/);
  // Y borrar una factura avisa cuántas entregas quedan otra vez pendientes.
  assert.match(fuente(PANEL, 'function pliRecuperoBorrar(id)'), /vuelven a quedar pendientes de recuperar/);
});

test('la factura se elige de una lista, no tipeando un número', () => {
  // Un prompt() que pide escribir «2» es la manera de marcar la factura equivocada un martes a las
  // siete, y el panel abre una ventana para esto en todos lados.
  const f = fuente(PANEL, 'function pliEntRecuperar(id)');
  assert.ok(!/prompt\(/.test(f), 'volvió el prompt para elegir la factura');
  assert.match(f, /getElementById\('pli-mar-fact'\)\.innerHTML/);
  assert.match(f, /pli-mb-marcar'\)\.classList\.add\('on'\)/);
  assert.match(PANEL, /<div class="ab-modal-overlay" id="pli-mb-marcar">/);
  // Sólo las del MISMO proveedor: el servidor lo frena igual, pero ofrecer las otras es ofrecer
  // un error.
  assert.match(f, /f\.proveedor_texto\.trim\(\)\.toLowerCase\(\) === e\.proveedor_texto\.trim\(\)\.toLowerCase\(\)/);
  // Y si no hay ninguna, se puede cargar sin perder de vista cuál entrega se estaba marcando.
  assert.match(f, /no hay ninguna factura cargada a este proveedor/);
  assert.match(fuente(PANEL, 'function pliMarcarNueva()'), /pliRecuperoAbrir\(null, e \? e\.proveedor_texto : ''\)/);
  assert.match(fuente(PANEL, 'function pliMarcarGuardar()'), /Cargá primero la factura/);
});

test('el importe de la factura no se repite en cada entrega que cubre', () => {
  // ES EL ERROR MÁS CARO QUE TUVO ESTA PANTALLA. Una factura puede cubrir varias entregas, así que
  // poner su importe entero al lado de «nos costó», fila por fila, invita a restar dos números que
  // no se pueden restar: tres entregas de 100.000 contra una factura de 330.000 se leían como
  // +230.000 en CADA fila — 690.000 contra los 30.000 que son.
  const f = fuente(PANEL, 'function pliPagRender()');
  assert.ok(!/pliPlata\(e\.recupero_importe/.test(f), 'volvió el importe de la factura en la fila');
  assert.match(f, /cubre ' \+ fac\.entregas \+ ' entregas/);
  // Y el pie deja de prometer una resta que no se puede hacer ahí.
  assert.ok(!/la diferencia entre\s+'\s*\+\s*'las dos es lo que se gana/.test(f));
  assert.match(f, /ese número no se puede mirar fila por fila/);
});

test('la factura compara su importe contra TODO lo que cubre, por moneda', () => {
  // Ese es el número que Pablo vino a buscar: si recuperó lo que entregó, y por cuánto.
  const db = base();
  db.exec(`INSERT INTO pli_recuperos (id, sociedad_id, proveedor_texto, fecha, importe, moneda)
           VALUES (9, 1, 'CARTOCOR', '2026-10-21', 330000, 'ARS')`);
  for (const id of [11, 12, 13]) {
    db.exec(`INSERT INTO pli_entregas (id, sociedad_id, proveedor_texto, fecha, recupero_id)
             VALUES (${id}, 1, 'CARTOCOR', '2026-10-20', 9)`);
    db.prepare(`INSERT INTO pli_entrega_lineas (entrega_id, insumo_id, cantidad, costo_unitario, moneda)
                VALUES (?, 1, 1, 100000, 'ARS')`).run(id);
  }
  const cubre = new Function('db', [fuente(RUTA, 'function loQueCubre(recuperoId)'), 'return loQueCubre;'].join('\n'))(db);
  assert.deepEqual(cubre(9), { por: { ARS: 300000 }, sin_costo: 0 },
    'suma las tres entregas, no una');
  // Con dos monedas NO se mezclan: restar pesos contra dólares con una cotización que nadie
  // eligió daría una ganancia inventada.
  db.prepare(`INSERT INTO pli_entrega_lineas (entrega_id, insumo_id, cantidad, costo_unitario, moneda)
              VALUES (11, 1, 2, 50, 'USD')`).run();
  assert.deepEqual(cubre(9).por, { ARS: 300000, USD: 100 });
  // Y un renglón sin costo se cuenta aparte, no como cero.
  db.prepare(`INSERT INTO pli_entrega_lineas (entrega_id, insumo_id, cantidad, moneda)
              VALUES (12, 1, 5, 'ARS')`).run();
  assert.equal(cubre(9).sin_costo, 1);
  // Una entrega borrada deja de contar: si no, la factura seguiría cubriendo algo que no existe.
  db.prepare('UPDATE pli_entregas SET eliminado_en=? WHERE id=11').run('2026-10-22');
  assert.deepEqual(cubre(9).por, { ARS: 200000 });

  const ruta = fuente(RUTA, "router.get('/recuperos'");
  assert.match(ruta, /const comparable = monedas\.length === 1 && monedas\[0\] === r\.moneda && !c\.sin_costo && r\.importe != null;/);
  assert.match(ruta, /diferencia: comparable \?/);
});

test('no se ofrece adjuntar un papel donde todavía no hay dónde colgarlo', () => {
  const f = fuente(PANEL, 'function pliAdjPintar(entidad, id, destino)');
  assert.match(f, /if \(!id\)/);
  assert.match(f, /Guardá primero y después podés adjuntar el papel/);
  // Ni cuando el guardado de archivos no está configurado: el botón contestaría 503.
  assert.match(f, /r\.storage_ok/);
  assert.match(f, /no está configurado/);
});

test('elegir dos veces el mismo papel vuelve a subirlo', () => {
  assert.match(fuente(PANEL, 'function pliAdjElegir()'), /inp\.value = '';[\s\S]*inp\.click\(\)/);
});

// ── EL MANUAL ──────────────────────────────────────────────────────────────
//
// El módulo no tenía «¿Cómo se usa?» y la regla del repo es que si la pantalla no lo tiene,
// actualizarlo es ESCRIBIRLO. Y se prueba CONTRA EL CÓDIGO: un test que sólo verifica que el texto
// existe no sirve de nada — lo que hay que clavar es que lo que el manual AFIRMA siga siendo cierto.

// Se ARMA el manual y se prueba el texto que de verdad se lee, no el código que lo escribe: en el
// fuente está partido en veinte concatenaciones, así que cualquier frase cae entre dos pedazos.
const MANUAL = (() => {
  const i = PANEL.indexOf("SG_MANUAL.pli = { titulo:");
  assert.ok(i > 0, 'Planificación de Insumos sigue sin «¿Cómo se usa?»');
  const src = PANEL.slice(i, PANEL.indexOf('\r\n};', i));
  const m = new Function([
    fuente(PANEL, 'function sgManCampo(nombre, espera, liga, ver)'),
    'var SG_MANUAL = {};', src + '\n};', 'return SG_MANUAL.pli;',
  ].join('\n'))();
  assert.equal(m.titulo, 'Planificación de Insumos');
  return m.html;
})();

test('el módulo tiene su «¿Cómo se usa?» y se puede abrir', () => {
  assert.match(MANUAL, /Este módulo contesta <b>una<\/b> pregunta/);
  assert.match(PANEL, /onclick="sgManualAbrir\('pli'\)">❓ ¿Cómo se usa\?/);
});

test('lo que el manual dice de las unidades es lo que hace el código', () => {
  assert.match(MANUAL, /Unidad de USO/);
  assert.match(MANUAL, /en la que se guarda el STOCK/);
  // Y es cierto: el stock se lee de pli_insumos y la receta lo consume en unidad de uso.
  assert.match(RUTA, /SELECT id, stock_inicial FROM pli_insumos/);
  // «Todo lo que entra o sale se carga en unidad de COMPRA y se convierte con la equivalencia».
  assert.match(MANUAL, /se convierte con esta equivalencia/);
  assert.match(fuente(RUTA, 'function moverStockPorEntrega(linea, objetivoCompra, mueveStock, userId)'),
    /\* factor \* 1e6/);
});

test('lo que el manual dice del stock y de la entrega es cierto', () => {
  assert.match(MANUAL, /No se puede entregar más de lo que hay en el depósito/);
  assert.match(fuente(RUTA, 'function moverStockPorEntrega(linea, objetivoCompra, mueveStock, userId)'),
    /delta > \(Number\(ins\.stock_inicial\) \|\| 0\)/);
  assert.match(MANUAL, /Destildalo cuando la mercadería se/);
  assert.match(RUTA, /mueve_stock/);
});

test('lo que el manual dice de la diferencia es lo que la pantalla calcula', () => {
  assert.match(MANUAL, /lo que le cobraste menos lo que te costó/);
  assert.match(fuente(RUTA, "router.get('/recuperos'"), /Number\(r\.importe\) - c\.por\[monedas\[0\]\]/);
  // «No se puede mirar fila por fila»: y la fila, efectivamente, no trae el importe.
  assert.match(MANUAL, /No se puede mirar fila por fila en la lista de entregas/);
  assert.ok(!/pliPlata\(e\.recupero_importe/.test(PANEL));
  // «Con monedas distintas no se calcula»: y el código lo exige.
  assert.match(MANUAL, /la diferencia <b>no se calcula<\/b> y se dice por qué/);
  assert.match(fuente(RUTA, "router.get('/recuperos'"), /monedas\[0\] === r\.moneda/);
});

test('lo que el manual dice de la factura de compra es cierto', () => {
  assert.match(MANUAL, /Factura de compra \(por renglón\)/);
  assert.match(MANUAL, /Va por renglón/);
  // Y de verdad vive en el renglón, no en la cabecera.
  const t = DDL.slice(DDL.indexOf('CREATE TABLE IF NOT EXISTS pli_entrega_lineas'));
  assert.match(t.slice(0, t.indexOf('\n  );')), /factura_compra\s+TEXT/);
});

test('lo que el manual dice de lo que no se deshace solo es cierto', () => {
  assert.match(MANUAL, /Una entrega ya recuperada no se corrige ni se borra/);
  assert.match(fuente(RUTA, "router.patch('/entregas/:id'"), /if \(e\.recupero_id\) \{/);
  assert.match(fuente(RUTA, "router.delete('/entregas/:id'"), /if \(e\.recupero_id\) \{/);
});

test('«la factura del insumo» se carga, se guarda y se ve', () => {
  // Es una de las ocho cosas que Pablo nombró y va POR RENGLÓN: un mismo remito puede llevar tres
  // insumos de tres facturas de compra distintas.
  const db = base();
  db.exec(`INSERT INTO pli_entregas (id, sociedad_id, proveedor_texto, fecha)
           VALUES (1, 1, 'CARTOCOR', '2026-10-20')`);
  db.prepare(`INSERT INTO pli_entrega_lineas (entrega_id, insumo_id, cantidad, moneda, factura_compra)
              VALUES (1, 1, 8, 'ARS', 'A-0001-00012345')`).run();
  assert.equal(db.prepare('SELECT factura_compra FROM pli_entrega_lineas WHERE entrega_id=1').get().factura_compra,
    'A-0001-00012345', 'la columna no guarda el número');

  // El servidor la lee del body y la acota.
  assert.match(fuente(RUTA, 'function leerLineas(b, soc)'),
    /factura_compra: vTexto\(l\.factura_compra, 'La factura de compra', \{ max: 60 \}\)/);
  // Y los dos INSERT la escriben: el alta y la corrección, que reemplaza los renglones.
  assert.equal((RUTA.match(/moneda, factura_compra, notas\) VALUES \(\?,\?,\?,\?,\?,\?,\?\)/g) || []).length, 2);
  assert.equal((RUTA.match(/l\.moneda, l\.factura_compra, l\.notas\)/g) || []).length, 2);

  // La pantalla la carga, la manda y la muestra en la lista.
  assert.match(fuente(PANEL, 'function pliEntLineasPintar()'), /factura_compra\\?',this\.value/);
  assert.match(fuente(PANEL, 'function pliEntregaGuardar()'), /factura_compra: l\.factura_compra \|\| ''/);
  assert.match(fuente(PANEL, 'function pliEntResumen(e)'), /l\.factura_compra \? ' <span class="pli-cel-chica">\(fc\./);
  // Y al abrir una entrega ya cargada viene, en vez de perderse al corregir.
  assert.match(fuente(PANEL, 'function pliEntregaAbrir(id)'), /factura_compra: l\.factura_compra \|\| ''/);
  // El renglón en blanco la trae: tres copias del objeto son tres oportunidades de olvidarla.
  assert.match(fuente(PANEL, 'function pliEntLineaVacia()'), /factura_compra: ''/);
});

test('los botones que borran se ofrecen por NIVEL, y el lápiz no miente', () => {
  const f = fuente(PANEL, 'function pliPagRender()');
  // El que no puede borrar apretaría y le contestaría 403: el botón no se ofrece.
  assert.match(f, /lnbPuedeAnular\('pli-planificacion'\)/);
  // Y una entrega ya recuperada no se corrige: el servidor la frena, así que el lápiz se muestra
  // apagado y dice por qué en vez de fallar recién al guardar.
  assert.match(f, /e\.recupero_id\s*\?\s*'<button class="btn bo bs" disabled/);
  assert.match(f, /soltala primero/);
  assert.match(fuente(PANEL, 'function pliPagFacturas(cont)'), /lnbPuedeAnular\('pli-planificacion'\)/);
});

test('las dos listas nuevas no sacan barra de costado', () => {
  // Es la regla del proyecto, y acá lo que se iría de pantalla es justamente la plata.
  const f = fuente(PANEL, 'function pliPagRender()');
  assert.match(f, /table-layout:fixed/);
  assert.equal((f.match(/<col[ >]/g) || []).length, 7, 'faltan anchos de columna en las entregas');
  const g = fuente(PANEL, 'function pliPagFacturas(cont)');
  assert.equal((g.match(/<col[ >]/g) || []).length, 7, 'faltan anchos de columna en las facturas');
  // Y lo único de largo variable parte de renglón en vez de empujar la tabla.
  assert.match(PANEL, /#pli-pag-cont td \{ word-break:break-word \}/);
});

test('después de entregar, la lista de insumos se recarga', () => {
  // El stock de los insumos cambió: dejar la lista vieja es mostrar un depósito que ya no existe.
  for (const firma of ['function pliEntregaGuardar()', 'function pliEntregaBorrar(id)']) {
    assert.match(fuente(PANEL, firma), /pliInsCargar/, firma + ' no recarga los insumos');
  }
});
