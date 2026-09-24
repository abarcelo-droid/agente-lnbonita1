// ══ LA ORDEN DE COMPRA QUE SE LE MANDA AL PROVEEDOR ════════════════════════
//
// Pablo, 21/9/2026: «en compras registradas, sería bueno que en cada una de las compras me deje
// imprimir un pequeño documento tipo Orden de compra… no es nada oficial pero sí es importante
// para poder mandarle al proveedor y que el precio quede firme».
//
// «QUE EL PRECIO QUEDE FIRME» es el requisito, no un adorno: si el documento leyera el precio del
// proveedor al momento de imprimir, mañana saldría otro número con el mismo número de orden. Por
// eso el precio se congela EN LA COMPRA.
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
const PANEL = leer('src/panel.html');

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

const TABLAS = ['pli_insumos', 'pli_insumo_proveedores', 'pli_compras'];
function base() {
  const db = new DatabaseSync(':memory:');
  for (const t of TABLAS) {
    const i = DDL.indexOf('CREATE TABLE IF NOT EXISTS ' + t + ' (');
    assert.ok(i >= 0, 'no está la tabla ' + t);
    db.exec(DDL.slice(i, DDL.indexOf('\n  );', i) + 4).replace(/REFERENCES [a-z_]+\([a-z_]+\)/g, ''));
  }
  // Las columnas que llegaron por migración, leídas de db_pli.js: si mañana se agrega otra, este
  // banco de pruebas la toma sin que haya que tocarlo.
  for (const m of DDL.match(/addCol\('[a-z_]+',\s*'[a-z_]+',\s*'[^']+'\)/g) || []) {
    const [, t, col, tipo] = /addCol\('([a-z_]+)',\s*'([a-z_]+)',\s*'([^']+)'\)/.exec(m);
    if (!TABLAS.includes(t)) continue;
    if (!db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).includes(col)) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${tipo}`);
    }
  }
  db.exec(`INSERT INTO pli_insumos (id, sociedad_id, nombre, codigo, unidad_compra, unidad_uso)
           VALUES (1, 1, 'CAJA GRANDE 600*400*180', 'CJ-600', 'UN', 'UN')`);
  db.exec(`INSERT INTO pli_insumo_proveedores (id, insumo_id, nombre, preferido, precio_ref, moneda)
           VALUES (10, 1, 'CARTOCOR', 1, 1811.30, 'ARS'), (11, 1, 'Smurfit', 0, 2010.85, 'ARS')`);
  return db;
}

const precioDe = (db) => new Function('db', [
  fuente(RUTA, 'function precioDeProveedor(insumoId, proveedorTexto)'),
  'return precioDeProveedor;',
].join('\n'))(db);

test('el precio que se propone es el del proveedor escrito; si no es ninguno, el del preferido', () => {
  const db = base();
  const p = precioDe(db);
  assert.deepEqual(p(1, 'Smurfit'), { precio: 2010.85, moneda: 'ARS' });
  assert.deepEqual(p(1, 'smurfit'), { precio: 2010.85, moneda: 'ARS' }, 'el nombre tiene que casar sin importar mayúsculas');
  // EL PROVEEDOR DE UNA COMPRA ES TEXTO LIBRE: se puede escribir uno que no está cargado. Ahí se
  // propone el del preferido, que es con el que se costea el plan — no cero, que sería un precio
  // pactado que nadie pactó.
  assert.deepEqual(p(1, 'Cartonera del Sur'), { precio: 1811.30, moneda: 'ARS' });
  assert.deepEqual(p(1, ''), { precio: 1811.30, moneda: 'ARS' });
  // Y si el insumo no tiene proveedores con precio, no se inventa ninguno.
  assert.deepEqual(precioDe(base())(999, 'CARTOCOR'), { precio: null, moneda: null });
});

test('el precio queda CONGELADO en la compra: cambiar la lista de precios no toca las órdenes ya hechas', () => {
  const db = base();
  db.exec(`INSERT INTO pli_compras (id, plan_id, insumo_id, fecha, cantidad, proveedor_texto,
             nro_orden, estado, precio, moneda)
           VALUES (1, 5, 1, '2026-09-02', 100, 'CARTOCOR', 'OC-880', 'pedido', 1811.30, 'ARS')`);
  // Le suben el precio al proveedor DESPUÉS de mandar la orden.
  db.prepare('UPDATE pli_insumo_proveedores SET precio_ref=2500 WHERE id=10').run();
  const c = db.prepare('SELECT precio, moneda FROM pli_compras WHERE id=1').get();
  assert.equal(c.precio, 1811.30, 'la orden ya mandada cambió de precio sola');
  assert.equal(c.moneda, 'ARS');
  // Y el alta lo guarda, en vez de leerlo al imprimir.
  const alta = fuente(RUTA, "router.post('/planes/:id/compras'");
  assert.match(alta, /const { precio, moneda } = precioDeLaCompra\(insumoId, prov, b\);/);
  assert.match(alta, /INSERT INTO pli_compras \(plan_id, insumo_id, fecha, cantidad, proveedor_texto, nro_orden, estado, notas,\r?\n\s+precio, moneda,/);
  // La edición NO vuelve a proponer: corregir la cantidad de una orden mandada no puede cambiarle
  // el precio por atrás.
  const edicion = fuente(RUTA, "router.patch('/planes/:id/compras/:compraId'");
  assert.ok(!/precioDeProveedor/.test(edicion), 'al corregir una compra se le vuelve a pisar el precio');
});

test('varias compras con el mismo Nº de orden y proveedor son UNA orden, y las canceladas no van', () => {
  const orden = fuente(RUTA, "router.get('/planes/:id/compras/:compraId/orden'");
  // Mandarle al proveedor tres papeles con el mismo número por tres insumos del mismo pedido es
  // pedirle que los junte él.
  assert.match(orden, /AND TRIM\(COALESCE\(c\.nro_orden,''\)\)=\? COLLATE NOCASE/);
  assert.match(orden, /AND TRIM\(COALESCE\(c\.proveedor_texto,''\)\)=\? COLLATE NOCASE/);
  assert.match(orden, /AND c\.estado <> 'cancelado'/, 'una compra cancelada sale igual en la orden');
  // SIN NÚMERO DE ORDEN NO HAY CON QUÉ JUNTARLAS: el documento es el de esa compra sola. Si se
  // agruparan por proveedor a secas, dos pedidos distintos al mismo proveedor saldrían en el mismo
  // papel.
  assert.match(orden, /const renglones = \(nro && prov\)/);
  assert.match(orden, /WHERE c\.id=\?`\)\.all\(cid\)/);
});

const totalDe = new Function([
  fuente(RUTA, 'function totalDeOrden(renglones)'), 'return totalDeOrden;',
].join('\n'))();

test('el total de una orden: sólo si todos tienen precio y están en la misma moneda', () => {
  const r = (precio, moneda, cantidad) => ({ precio, moneda, cantidad: cantidad || 1 });
  assert.deepEqual(totalDe([r(100, 'ARS', 2), r(50, 'ARS', 3)]),
    { total: 350, moneda: 'ARS', sin_precio: 0, varias_monedas: 0 });
  // UN RENGLÓN SIN PRECIO NO SE PUEDE SUMAR: el total daría menos de lo que van a facturar.
  assert.deepEqual(totalDe([r(100, 'ARS', 2), r(null, null, 3)]),
    { total: null, moneda: 'ARS', sin_precio: 1, varias_monedas: 0 });
  // PESOS MÁS DÓLARES NO ES PLATA DE NINGUNA CLASE.
  assert.deepEqual(totalDe([r(100, 'ARS'), r(50, 'USD')]),
    { total: null, moneda: null, sin_precio: 0, varias_monedas: 1 });
  // Sin moneda escrita se asume pesos, que es como se carga todo acá.
  assert.equal(totalDe([r(100, null, 2)]).total, 200);
  // Y los centavos se redondean a dos, o el total sale con quince decimales.
  assert.equal(totalDe([r(0.1, 'ARS', 3)]).total, 0.3);
  assert.deepEqual(totalDe([]), { total: null, moneda: null, sin_precio: 0, varias_monedas: 0 });
});

const precioCompra = (db) => new Function('db', 'vNum', [
  fuente(RUTA, 'function precioDeProveedor(insumoId, proveedorTexto)'),
  fuente(RUTA, 'function precioDeLaCompra(insumoId, proveedorTexto, b)'),
  'return precioDeLaCompra;',
].join('\n'))(db, (v) => Number(v));

test('un precio en dólares no se guarda como pesos: la moneda viaja con el precio', () => {
  const db = base();
  db.prepare("UPDATE pli_insumo_proveedores SET precio_ref=1.20, moneda='USD' WHERE id=10").run();
  const p = precioCompra(db);
  // EL CAMINO QUE LA PANTALLA RECOMIENDA: dejar el precio vacío para que use el del proveedor. La
  // pantalla manda SIEMPRE una moneda —el selector arrancaba en ARS y no lo movía nadie—, así que
  // el proveedor que cotiza USD 1,20 quedaba guardado como ARS 1,20, y eso decía el papel.
  assert.deepEqual(p(1, 'CARTOCOR', { moneda: 'ARS' }), { precio: 1.2, moneda: 'USD' },
    'el precio vino del proveedor y la moneda del selector: el documento dice otro número');
  assert.deepEqual(p(1, 'CARTOCOR', { precio: '', moneda: 'ARS' }), { precio: 1.2, moneda: 'USD' });
  // Si el usuario ESCRIBE el precio, manda su moneda: ahí sí eligió las dos cosas.
  assert.deepEqual(p(1, 'CARTOCOR', { precio: 2500, moneda: 'ARS' }), { precio: 2500, moneda: 'ARS' });
  assert.deepEqual(p(1, 'CARTOCOR', { precio: 3, moneda: 'USD' }), { precio: 3, moneda: 'USD' });
  // Una moneda que no existe no se guarda: pesos, que es la de la casa.
  assert.deepEqual(p(1, 'CARTOCOR', { precio: 10, moneda: 'EUR' }), { precio: 10, moneda: 'ARS' });
  // Sin precio de proveedor no se inventa ni número ni moneda.
  assert.deepEqual(p(999, 'NADIE', {}), { precio: null, moneda: null });
});

test('una compra cancelada no emite orden, ni la suya ni la de al lado', () => {
  const orden = fuente(RUTA, "router.get('/planes/:id/compras/:compraId/orden'");
  // EL FILTRO DE CANCELADAS SACABA A LA PROPIA COMPRA que se apretó: el documento salía con los
  // OTROS renglones de ese número de orden —sin el que se pidió imprimir— y si era la única,
  // con número, proveedor, firmas y la tabla vacía.
  assert.match(orden, /if \(base\.estado === 'cancelado'\) \{/);
  assert.match(orden, /no se emite una orden de algo que se dio de baja/);
  // Y si después de juntar no quedó ningún renglón, tampoco sale un papel vacío.
  assert.match(orden, /if \(!renglones\.length\) throw notFound/);
  // En la pantalla, a una cancelada no se le ofrece el botón. Se lee la función que dibuja la
  // lista, no un pedazo de N caracteres: un comentario nuevo corría el recorte y el test fallaba
  // sin que nada estuviera roto.
  assert.match(fuente(PANEL, 'function pliCmpRenderHechas(cont)'), /c\.estado === 'cancelado' \? ''/);
});

test('la pantalla dice qué precio y qué moneda van a quedar firmes antes de guardar', () => {
  const f = fuente(PANEL, 'function pliCompraPrecioSugerido()');
  // El selector se pone en la moneda del insumo: si no, se escribe 1,20 pensando en dólares y
  // queda guardado 1,20 pesos.
  assert.match(f, /if \(!editando && i && Number\(i\.precio_ref\) > 0\) sel\.value = i\.moneda \|\| 'ARS';/);
  // Y se lee el número que se va a usar, con su moneda, antes de apretar Guardar.
  assert.match(f, /'Vacío: se usa ' \+ \(i\.moneda \|\| 'ARS'\) \+ ' ' \+ pliN\(i\.precio_ref, 2\)/);
  // Un insumo sin precio de proveedor lo dice, en vez de prometer uno que no existe.
  assert.match(f, /Este insumo no tiene precio de proveedor/);
  // Y editando no se pisa la moneda de una compra ya pactada.
  assert.match(f, /var editando = !!document\.getElementById\('pli-cmp-id'\)\.value;/);
  assert.match(fuente(PANEL, 'function pliCompraUnidad()'), /pliCompraPrecioSugerido\(\);/);
});

// ── RECIBIR MUEVE EL STOCK (V1082) ─────────────────────────────────────────
//
// Pablo, 24/9/2026: «tengo que poder confirmar la recepción de la orden de compra para que me
// afecte el stock y me lo ponga como recibido», y eligió poder decir CUÁNTO llegó.
const mover = (db) => new Function('db', 'bad', 'logPli', 'AHORA', [
  fuente(RUTA, 'function moverStockPorRecepcion(compra, nuevaCantidad, userId)'),
  'return moverStockPorRecepcion;',
].join('\n'))(db, (m) => { throw new Error(m); }, () => {}, "datetime('now','localtime')");

const stockDe = (db, id) => db.prepare('SELECT stock_inicial FROM pli_insumos WHERE id=?').get(id || 1).stock_inicial;

test('al recibir, la cantidad se convierte a la unidad en la que vive el stock', () => {
  const db = base();
  // UN MILLAR DE ETIQUETAS SON MIL ETIQUETAS. La compra va en unidad de COMPRA y el stock del
  // insumo en unidad de USO, que es en la que la receta lo consume: sumar 8 «millares» como 8
  // sería errarle por mil, y el plan diría que falta comprar todo de nuevo.
  db.exec(`INSERT INTO pli_insumos (id, sociedad_id, nombre, unidad_compra, unidad_uso, factor_compra, stock_inicial)
           VALUES (2, 1, 'ETIQUETA DAMASCO', 'MILLAR', 'unidad', 1000, 500)`);
  const m = mover(db);
  const r = m({ id: 1, insumo_id: 2, recibido_cantidad: null }, 8, 5);
  assert.deepEqual([r.delta, r.en_uso], [8, 8000]);
  assert.equal(stockDe(db, 2), 8500, 'el stock quedó en la unidad equivocada');
});

test('recibir dos veces no duplica: se mueve la DIFERENCIA con lo ya aplicado', () => {
  const db = base();
  db.prepare('UPDATE pli_insumos SET factor_compra=1, stock_inicial=0 WHERE id=1').run();
  const m = mover(db);
  m({ id: 1, insumo_id: 1, recibido_cantidad: null }, 8000, 5);
  assert.equal(stockDe(db), 8000);
  // Confirmar de nuevo lo MISMO no suma nada: es el mismo hecho, no dos entregas.
  // Ni siquiera toca el insumo: sin el corte, escribiría un movimiento de cero y dejaría dicho
  // que el stock se actualizó hoy, cuando no se movió nada.
  db.prepare("UPDATE pli_insumos SET stock_actualizado_en='2020-01-01' WHERE id=1").run();
  assert.equal(m({ id: 1, insumo_id: 1, recibido_cantidad: 8000 }, 8000, 5).delta, 0);
  assert.equal(stockDe(db), 8000);
  assert.equal(db.prepare('SELECT stock_actualizado_en t FROM pli_insumos WHERE id=1').get().t, '2020-01-01',
    'un movimiento de cero dejó dicho que el stock se tocó');
  // Corregir a menos devuelve la diferencia: llegaron 6.000 de los 8.000 que se habían anotado.
  m({ id: 1, insumo_id: 1, recibido_cantidad: 8000 }, 6000, 5);
  assert.equal(stockDe(db), 6000, 'corregir la cantidad recibida no ajustó el stock');
  // Y a más, la suma.
  m({ id: 1, insumo_id: 1, recibido_cantidad: 6000 }, 9000, 5);
  assert.equal(stockDe(db), 9000);
  // Deshacer devuelve todo.
  m({ id: 1, insumo_id: 1, recibido_cantidad: 9000 }, 0, 5);
  assert.equal(stockDe(db), 0);
});

test('el stock no queda negativo aunque alguien lo haya corregido a mano por abajo', () => {
  const db = base();
  db.prepare('UPDATE pli_insumos SET factor_compra=1, stock_inicial=0 WHERE id=1').run();
  const m = mover(db);
  m({ id: 1, insumo_id: 1, recibido_cantidad: null }, 500, 5);
  // Entre medio alguien arqueó el depósito y lo dejó en 100.
  db.prepare('UPDATE pli_insumos SET stock_inicial=100 WHERE id=1').run();
  m({ id: 1, insumo_id: 1, recibido_cantidad: 500 }, 0, 5);
  assert.equal(stockDe(db), 0, 'el stock quedó en negativo, que no es una cantidad posible');
});

test('cancelar, borrar o cambiarle el insumo a una compra recibida no descuadra el depósito', () => {
  const edicion = fuente(RUTA, "router.patch('/planes/:id/compras/:compraId'");
  // Cancelarla desde el formulario es el camino natural, y sin esto dejaba en el depósito
  // mercadería que nadie recibió.
  assert.match(edicion, /if \(recibida && estado !== 'recibido'\) revertirRecepcion\(a, req\.user\.id\);/);
  // Y el insumo no se cambia: el stock ya entró en el viejo. Se mira la CONDICIÓN, no el
  // mensaje: el texto queda escrito igual aunque el cerrojo no se aplique nunca.
  assert.match(edicion,
    /if \(recibida && b\.insumo_id !== undefined && parseInt\(b\.insumo_id, 10\) !== a\.insumo_id\) \{/);
  assert.match(edicion, /ya se recibió y su mercadería entró al stock de ese insumo/);
  const baja = fuente(RUTA, "router.delete('/planes/:id/compras/:compraId'");
  assert.match(baja, /revertirRecepcion\(a, req\.user\.id\);/);
  // Todo lo que toca el stock va en una transacción: a medio camino, el depósito queda mintiendo.
  assert.match(baja, /db\.transaction\(\(\) => \{/);
  const recep = fuente(RUTA, "router.post('/planes/:id/compras/:compraId/recepcion'");
  assert.match(recep, /db\.transaction\(\(\) => \{/);
  // Una compra cancelada no se recibe.
  assert.match(recep, /está cancelada: no se puede recibir/);
});

test('la ventana de recepción propone lo pedido y dice en qué unidad entra al stock', () => {
  const f = fuente(PANEL, 'function pliRecepAbrir(id)');
  assert.match(f, /document\.getElementById\('pli-rec-cant'\)\.value = ya \? c\.recibido_cantidad : c\.cantidad;/);
  // EN QUÉ UNIDAD ENTRA, antes de confirmar: es el número que hay que poder revisar.
  assert.match(f, /al stock entra por ' \+ i\.unidad_uso/);
  // Y si ya estaba recibida, que se va a mover la diferencia.
  assert.match(f, /al stock se le suma o se le resta la diferencia/);
  assert.match(f, /pli-rec-deshacer'\)\.style\.display = ya \? '' : 'none';/);
  // Lo que realmente llegó se ve en la lista cuando es menos de lo pedido: si no, «recibido» se
  // lee como que entró todo.
  const i = PANEL.lastIndexOf('Compras registradas</div>');
  assert.match(PANEL.slice(i, i + 3500), /llegaron ' \+ pliN\(c\.recibido_cantidad\)/);
});

test('el lugar de entrega va en la compra, sale en el documento y se propone el último', () => {
  assert.match(PANEL, /<input id="pli-cmp-lugar" list="pli-dl-lugar"/);
  // Se propone el último usado: casi siempre se pide a la misma planta, y volver a escribirlo en
  // cada compra es la manera más fácil de que termine vacío.
  assert.match(fuente(PANEL, 'function pliCompraAbrir(id)'), /\(PLI\.ultimoLugar \|\| ''\)/);
  assert.match(fuente(PANEL, 'function pliLugaresUsados()'), /dl\.innerHTML = vistos\.map/);
  // En el documento, y SIN renglón si está vacío: un «—» en un papel que se manda afuera se lee
  // como que no hay que entregarlo en ningún lado.
  const doc = fuente(PANEL, 'function pliOrdenHtml(d)');
  assert.match(doc, /d\.lugar_entrega \? '<tr><td>Entregar en<\/td>/);
  assert.match(armar(DOC({ lugar_entrega: 'Planta Puente Cordón' })), /Entregar en[\s\S]*Planta Puente Cordón/);
  assert.ok(!/Entregar en/.test(armar(DOC())), 'dibuja el renglón del lugar aunque esté vacío');
  // Y el servidor lo manda: sin esto el documento nunca lo vería.
  assert.match(fuente(RUTA, "router.get('/planes/:id/compras/:compraId/orden'"), /lugar_entrega: base\.lugar_entrega/);
});

// ── EL DOCUMENTO ───────────────────────────────────────────────────────────
const armar = new Function('pliEsc', 'pliN', 'pliHoyISO', 'window', [
  'var PLI_LOGO_FORMATO = ' + /var PLI_LOGO_FORMATO = (.*);/.exec(PANEL)[1] + ';',
  fuente(PANEL, 'function pliOrdenLogoHtml(d)'),
  fuente(PANEL, 'function pliOrdenHtml(d)'), 'return pliOrdenHtml;',
].join('\n'))((s) => String(s == null ? '' : s), (n, d) => Number(n).toFixed(d === undefined ? 0 : d),
  () => '2026-09-23', { LNB_USER: { rol: 'admin' } });

const DOC = (extra) => Object.assign({
  sociedad: 'Puente Cordón SA', nro_orden: 'OC-880', proveedor: 'CARTOCOR', fecha: '2026-09-02',
  renglones: [{ id: 1, insumo: 'CAJA GRANDE 600*400*180', codigo: 'CJ-600', cantidad: 100,
    unidad: 'UN', precio: 1811.30, moneda: 'ARS', subtotal: 181130, estado: 'pedido',
    notas: null, fecha_entrega: '2026-09-15' }],
  total: 181130, moneda: 'ARS', sin_precio: 0, varias_monedas: 0,
}, extra || {});

test('el documento dice de quién es, para quién, qué se pidió y a qué precio', () => {
  const h = armar(DOC());
  assert.match(h, /Puente Cordón SA/);
  assert.match(h, /Nº OC-880/);
  assert.match(h, /CARTOCOR/);
  assert.match(h, /CJ-600/);
  assert.match(h, /CAJA GRANDE 600\*400\*180/);
  assert.match(h, /ARS 1811\.30/);
  assert.match(h, /2026-09-15/, 'la entrega comprometida no sale, y es la mitad de lo que se acuerda');
  assert.match(h, /<b>TOTAL<\/b>/);
  // NO ES UN COMPROBANTE FISCAL, y lo dice arriba y abajo: se lo manda a un proveedor que factura
  // aparte, y un papel con precios que no aclara qué es se puede tomar por otra cosa.
  assert.match(h, /no es un comprobante fiscal/);
  assert.match(h, /no es una factura ni un remito/);
  // Emitida hoy: el proveedor tiene que saber de cuándo es el papel que le llegó.
  assert.match(h, /Emitida el 2026-09-23/);
  // Y con dónde firmar, que es para lo que se manda.
  assert.match(h, /Firma y aclaración/);
  assert.match(h, /Recibido/);
});

test('el total sólo se muestra si se puede sumar, y si no se dice por qué', () => {
  // UN RENGLÓN SIN PRECIO NO SE PUEDE SUMAR: un total que ignora un renglón es un número menor al
  // que el proveedor va a facturar.
  const sinPrecio = armar(DOC({ total: null, sin_precio: 1,
    renglones: [Object.assign({}, DOC().renglones[0], { precio: null, subtotal: null })] }));
  assert.ok(!/<b>TOTAL<\/b>/.test(sinPrecio), 'suma un total dejando afuera el renglón sin precio');
  assert.match(sinPrecio, /No se totaliza: un renglón no tiene precio pactado/);
  assert.match(sinPrecio, /—/, 'el renglón sin precio tiene que decir algo en su celda');
  const dos = armar(DOC({ total: null, sin_precio: 2 }));
  assert.match(dos, /No se totaliza: 2 renglones no tienen precio pactado/);
  // DOS MONEDAS TAMPOCO SE SUMAN: pesos más dólares no es plata de ninguna clase.
  const mixto = armar(DOC({ total: null, moneda: null, varias_monedas: 1, sin_precio: 0 }));
  assert.match(mixto, /No se totaliza: hay renglones en pesos y en dólares/);
  assert.ok(!/<b>TOTAL<\/b>/.test(mixto));
});

test('las notas del renglón salen impresas: es donde se aclara lo que el sistema no sabe', () => {
  // El módulo no maneja IVA ni flete, así que el documento no afirma nada de eso. Lo que se
  // necesite aclarar va en las notas de la compra, y por eso tienen que salir.
  const h = armar(DOC({ renglones: [Object.assign({}, DOC().renglones[0],
    { notas: 'Precio con IVA incluido. Flete por cuenta del proveedor.' })] }));
  assert.match(h, /Precio con IVA incluido\. Flete por cuenta del proveedor\./);
  assert.ok(!/IVA/.test(armar(DOC())), 'el documento inventa algo sobre el IVA, que este módulo no maneja');
});

test('al imprimir sale sólo el documento, no el panel entero', () => {
  const f = fuente(PANEL, 'function pliOrdenImprimir()');
  assert.match(f, /document\.body\.classList\.add\('pli-imprimiendo'\)/);
  assert.match(f, /window\.print\(\)/);
  assert.match(f, /classList\.remove\('pli-imprimiendo'\)/, 'la pantalla queda escondida después de imprimir');
  // La regla que lo hace posible: sin esto se imprimen tres hojas del panel con la orden en el medio.
  assert.match(PANEL, /body\.pli-imprimiendo>\*\{display:none !important\}/);
  assert.match(PANEL, /body\.pli-imprimiendo #pli-mb-orden\{display:block !important/);
  // Y el encabezado y los botones de la ventana no van al papel.
  assert.match(PANEL, /body\.pli-imprimiendo #pli-mb-orden \.mhd,\r?\n\s+body\.pli-imprimiendo #pli-mb-orden \.ab-modal-footer\{display:none !important\}/);
  // Nada de barras de costado: la tabla reparte los anchos y lo largo parte de renglón.
  assert.match(PANEL, /\.pli-oc-tbl\{width:100%;table-layout:fixed/);
  assert.match(PANEL, /word-break:break-word/);
  // Y los anchos repartidos: con las siete columnas iguales, el importe del total —que es el
  // número más largo del papel— se parte en dos renglones.
  const h2 = armar(DOC());
  assert.match(h2, /<colgroup><col style="width:10%">/);
  assert.match(PANEL, /\.pli-oc-tbl tfoot td\{[^}]*white-space:nowrap/);
});

test('el botón está en cada compra, y la lista muestra el precio que quedó firme', () => {
  const trozo = fuente(PANEL, 'function pliCmpRenderHechas(cont)');
  assert.match(trozo, /onclick="pliOrdenAbrir\(' \+ c\.id \+ '\)"/);
  assert.match(trozo, /title="Orden de compra para mandarle al proveedor"/);
  // El precio se ve en la lista: si no, no hay manera de saber cuál va a salir impreso.
  assert.match(trozo, /c\.precio == null \? '<span class="pli-cel-chica">sin precio<\/span>'/);
});
