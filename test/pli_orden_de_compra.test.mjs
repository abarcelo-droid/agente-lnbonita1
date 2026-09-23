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
  for (const m of DDL.match(/addCol\('[a-z_]+',\s*'[a-z_]+',\s*'[A-Z]+'\)/g) || []) {
    const [, t, col, tipo] = /addCol\('([a-z_]+)',\s*'([a-z_]+)',\s*'([A-Z]+)'\)/.exec(m);
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
  assert.match(alta, /const sug = precioDeProveedor\(insumoId, prov\);/);
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

// ── EL DOCUMENTO ───────────────────────────────────────────────────────────
const armar = new Function('pliEsc', 'pliN', 'pliHoyISO', [
  fuente(PANEL, 'function pliOrdenHtml(d)'), 'return pliOrdenHtml;',
].join('\n'))((s) => String(s == null ? '' : s), (n, d) => Number(n).toFixed(d === undefined ? 0 : d),
  () => '2026-09-23');

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
  // El primer «Compras registradas» del archivo es un comentario: la tabla se dibuja despues.
  const i = PANEL.lastIndexOf('Compras registradas</div>');
  assert.ok(i > 0, 'no encontre donde se dibuja la tabla de compras');
  const trozo = PANEL.slice(i, i + 3000);
  assert.match(trozo, /onclick="pliOrdenAbrir\(' \+ c\.id \+ '\)"/);
  assert.match(trozo, /title="Orden de compra para mandarle al proveedor"/);
  // El precio se ve en la lista: si no, no hay manera de saber cuál va a salir impreso.
  assert.match(trozo, /c\.precio == null \? '<span class="pli-cel-chica">sin precio<\/span>'/);
});
