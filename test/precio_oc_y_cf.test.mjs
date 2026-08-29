// ══ DOS COSAS QUE FALTABAN ═════════════════════════════════════════════════
//
// 1. CAMBIARLE EL PRECIO A UNA ORDEN. No se podía por ningún lado: PUT /oc/:id sólo
//    edita la cabecera y sólo en borrador o abierta —una partida recibida ya no
//    tiene ese estado—, y el único UPDATE del precio vivía encerrado adentro de
//    /oc/:id/completar, que sólo acepta órdenes retroactivas. El propio código lo
//    dice: «no hay pantalla que edite los ítems de una orden ya cargada».
//
// 2. A QUIÉN SE LE INFORMÓ EL COMPROBANTE. El documento del comprador se resolvía en
//    cada emisión, se le informaba a ARCA y se tiraba. Una venta a consumidor final
//    identificado por DNI —las que superan el umbral de la RG 5700/2025— salía
//    impresa SIN ese DNI, y la nota de crédito de esa venta volvía a pedirlo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// facturaPDF.js importa jspdf y este repo no tiene node_modules: la función se
// saca del archivo por texto y se ejecuta sola, que es lo que hacen los demás tests.

// El cuerpo de un endpoint, hasta donde arranca el siguiente. Rebanar por tamaño
// fijo deja el test verde o rojo según cuánto haya crecido el archivo, que no es lo
// que se quiere probar.
function endpoint(src, firma) {
  const i = src.indexOf(firma);
  assert.ok(i > 0, 'no está: ' + firma);
  const j = src.indexOf('\nrouter.', i + firma.length);
  return src.slice(i, j > i ? j : src.length);
}

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const VENTAS = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');
const EMISION = fs.readFileSync(path.join(RAIZ, 'src/servicios/afip-wsfe-emision.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const PDF = fs.readFileSync(path.join(RAIZ, 'src/servicios/facturaPDF.js'), 'utf8');

const docReceptor = (function () {
  const i = PDF.indexOf('const DOC_LABEL =');
  assert.ok(i > 0, 'no está DOC_LABEL en facturaPDF.js');
  const fin = PDF.indexOf('\n}', PDF.indexOf('export function docReceptor')) + 2;
  const cuerpo = PDF.slice(i, fin).replace(/export\s+function/, 'function');
  // eslint-disable-next-line no-new-func
  return new Function('soloDig', 'cuitValido',
    cuerpo + '; return docReceptor;')(
    (x) => String(x == null ? '' : x).replace(/\D/g, ''),
    (x) => /^\d{11}$/.test(String(x || '')));
})();

// ── 1. EL PRECIO DE LA ORDEN ────────────────────────────────────────────────
test('existe el camino, por su propia dirección y con nivel OPERAR', () => {
  assert.match(SG, /router\.put\('\/oc\/:id\/precios', requireAuth,/);
  // NO requireAdmin: cambiar lo que se le pactó al productor es del comprador.
  // Pedir un administrador obliga a que lo cargue el dueño y el que hace el trabajo
  // termina dictándoselo («OPERAR NO ES SER ADMIN», CLAUDE.md).
  assert.doesNotMatch(SG, /router\.put\('\/oc\/:id\/precios', requireAdmin/);
});

test('el cerrojo de precio firme corre primero', () => {
  const cuerpo = endpoint(SG, "router.put('/oc/:id/precios'");
  assert.match(cuerpo, /frenoPrecioFirme\(db, oc\.id, 'cambiar el precio'\)/);
  assert.match(cuerpo, /res\.status\(409\)/);
});

test('sin motivo no se cambia un precio pactado', () => {
  const cuerpo = endpoint(SG, "router.put('/oc/:id/precios'");
  assert.match(cuerpo, /Poné por qué cambia el precio/);
  // Y el rastro va DENTRO de la transacción: no puede quedar el cambio sin registro
  // ni el registro sin cambio.
  assert.match(cuerpo, /anotarEdicion\(db, \{ tabla: 'sg_oc_items', registroId: p\.id,/);
  assert.match(cuerpo, /campo: 'precio_estimado_por_kg'/);
});

test('la partida de PRECIO ABIERTO no tiene precio en la orden', () => {
  // Ahí el precio vive en cada lote y se fija con «cerrar precio»: escribirlo en el
  // ítem dejaría un número que después nadie mira.
  assert.match(endpoint(SG, "router.put('/oc/:id/precios'"), /se compró a PRECIO ABIERTO/);
  // Y el botón tampoco se ofrece.
  assert.match(PANEL, /o\.tipo_precio !== 'pizarra' && lnbPuedeOperar\('sg-compras'\)/);
});

test('EL COSTO ES NETO, y ahora las dos puertas hacen la misma cuenta', () => {
  // /oc/:id/completar valorizaba el lote con el precio BRUTO sin mirar
  // precio_incluye_iva, mientras la recepción lo hacía NETO. Eran dos cuentas
  // distintas del mismo número, y con 10,5% dejaba el inventario y el margen de
  // todos los reportes un 10,5% arriba — que es el número con el que se decide a
  // cuánto vender.
  assert.match(SG, /function precioNetoDeOC\(db, ocId, ocItemId, precio\)/);
  assert.match(SG, /\+\(Number\(precio\) \/ \(1 \+ alic \/ 100\)\)\.toFixed\(6\)/);
  assert.match(SG, /function aplicarPrecioItem\(db, \{ ocId, ocItemId, precio, userId, motivo \}\)/);
  // Y /completar dejó de hacer la suya.
  assert.doesNotMatch(SG, /setLote\.run\(p\.precio, r2\(\(l\.kg_reales \|\| 0\) \* p\.precio\)/);
  // Dos llamadas —el endpoint nuevo y /completar— más la definición.
  const usos = (SG.match(/aplicarPrecioItem\(db,/g) || []).length;
  assert.equal(usos, 3, 'el endpoint nuevo, /completar, y la función');
});

test('la cascada corre entera y en orden', () => {
  const i = SG.indexOf('function aplicarPrecioItem(');
  const cuerpo = SG.slice(i, i + 1200);
  assert.match(cuerpo, /UPDATE sg_oc_items SET precio_estimado_por_kg=\?/, '1. el precio del ítem');
  assert.match(cuerpo, /UPDATE sg_lotes SET precio_unitario_kg=\?, costo_base=\?/, '2. cada lote vivo');
  assert.match(cuerpo, /recalcCostoLote\(db, Number\(l\.id\)\)/, '3. el costo final del lote');
  const ep = endpoint(SG, "router.put('/oc/:id/precios'");
  assert.match(ep, /recalcTotalesOC\(db, oc\.id\)/, '4. los totales de la cabecera');
  assert.match(ep, /generarVencimientos\(db, oc\.id\)/, '5. la deuda con el proveedor');
  // Y en ESE orden: generarVencimientos reparte total_estimado_monto, así que
  // rehacerlo después dejaba el cronograma con el importe viejo.
  assert.ok(ep.indexOf('recalcTotalesOC(db, oc.id)') < ep.indexOf('generarVencimientos(db, oc.id)'),
    'los totales se rehacen ANTES del cronograma');
});

test('y se avisa lo que la cascada NO alcanza', () => {
  // generarVencimientos sale por la puerta si ya hay una cuota pagada: el precio
  // nuevo no llega a la cuenta corriente y el ajuste va a mano. Callarlo dejaría el
  // saldo del proveedor mal sin que nadie se entere.
  assert.match(endpoint(SG, "router.put('/oc/:id/precios'"), /AVISO_CRONOGRAMA_CONGELADO/);
  assert.match(SG, /const AVISO_CRONOGRAMA_CONGELADO =[\s\S]{0,120}ya tiene cuotas pagadas/);
  assert.match(PANEL, /if \(r\.data && r\.data\.aviso\) alert\(r\.data\.aviso\);/);
});

test('la pantalla existe y no tiene barra lateral', () => {
  assert.match(PANEL, /function sgOcpOpen\(ocId\)/);
  assert.match(PANEL, /'\/precios', 'PUT', \{ items: items, motivo: motivo \}/);
  const i = PANEL.indexOf('id="sg-ocp-modal"');
  assert.ok(i > 0);
  assert.match(PANEL.slice(i, i + 1600), /overflow-x:hidden !important/);
  assert.match(PANEL.slice(i, i + 1600), /table-layout:fixed/);
});

test('el lote cuyo costo ya viajó a otro no se reprecia', () => {
  // Cuando de un lote salió mercadería a una transformación o un reproceso, lo
  // transferido quedó CONGELADO y no se recalcula nunca. Cambiarle el costo_base al
  // padre deja al padre con el costo por kilo inflado y al hijo con uno de menos: el
  // total cierra y la distribución queda mal en los dos lados.
  //
  // El repo ya lo prohíbe en frenosDeEdicionLote (freno 3) para PUT /lotes/:id/corregir,
  // que escribe el MISMO costo_base. Este endpoint lo escribía por otra puerta.
  assert.match(SG, /function loteConCostoViajado\(db, ocItemId\)/);
  assert.match(SG, /FROM sg_transformaciones t WHERE t\.lote_origen_id = l\.id/);
  assert.match(SG, /FROM sg_reprocesos rp WHERE rp\.lote_madre_id = l\.id AND rp\.estado='activo'/);
  const cuerpo = endpoint(SG, "router.put('/oc/:id/precios'");
  assert.match(cuerpo, /loteConCostoViajado\(db, p\.id\)/);
  assert.match(cuerpo, /ya viajó a otro lote/);
  // Y NO se pide el freno de «ya se despachó»: eso es rentabilidad, y se mira
  // después (Pablo, 26/8/2026). Acá el problema es que el inventario queda inventado.
  assert.doesNotMatch(cuerpo, /ya se despacharon/);
});

test('los totales de la cabecera se rehacen con la MISMA cuenta del alta', () => {
  // generarVencimientos reparte sg_oc.total_estimado_monto cuando la partida todavía
  // no tiene factura. Sin rehacerlo, se cambiaba el precio y la deuda con el
  // proveedor quedaba igual — y el PDF de la orden decía dos números distintos.
  assert.match(SG, /function recalcTotalesOC\(db, ocId\)/);
  const f = SG.slice(SG.indexOf('function recalcTotalesOC('), SG.indexOf('function loteConCostoViajado('));
  // La cuenta del alta: con IVA adentro el neto sale por división y el IVA por
  // diferencia; si no, el IVA se adiciona.
  assert.match(f, /neto = bruto \/ \(1 \+ alic \/ 100\); iva = bruto - neto;/);
  assert.match(f, /iva = bruto \* alic \/ 100;/);
  assert.match(f, /UPDATE sg_oc SET total_estimado_kg=\?, total_estimado_monto=\?, total_neto=\?, total_iva=\?/);
  assert.match(f, /UPDATE sg_oc_items SET neto_estimado=\?, iva_estimado=\?/);
});

test('el importe por renglón lo calcula el SERVIDOR; la pantalla lo escala', () => {
  // La cuenta no es «kg × precio»: por bulto lo pactado por bulto, por kilo lo que
  // entró pesado, y mixto cuando el mismo ítem tuvo las dos cosas. Rehacerla en el
  // navegador daba otro número —ignoraba modo_carga y los kilos a granel— y le
  // mostraba al comprador un total que no era el que iba a cobrar el productor.
  assert.match(SG, /it\.acordado_importe = d && d\.importe != null \? d\.importe : null;/);
  // Y la pantalla ESCALA, que es exacto porque el importe es lineal en el precio.
  assert.match(PANEL, /it\.importe_base \* \(p \/ it\.precio_base\)/);
  assert.doesNotMatch(PANEL, /it\.bultos \* \(p \* it\.kg_por_bulto\)/);
  // Sin importe de base no hay proporción, y se dice en vez de inventar un número.
  assert.match(PANEL, /'se calcula al guardar'/);
});

// ── 2. EL DOCUMENTO DEL COMPRADOR ───────────────────────────────────────────
test('lo que se le informó a ARCA queda guardado con el comprobante', () => {
  assert.match(EMISION, /_alter\('sg_ven_facturas', 'doc_tipo', 'doc_tipo INTEGER'\)/);
  assert.match(EMISION, /_alter\('sg_ven_facturas', 'doc_nro', 'doc_nro TEXT'\)/);
  assert.match(EMISION, /UPDATE sg_ven_facturas SET doc_tipo=\?, doc_nro=\? WHERE id=\?/);
});

test('el PDF imprime el documento que se informó, no el del cliente', () => {
  // 80 = CUIT, 86 = CUIL, 96 = DNI, 99 = consumidor final sin identificar.
  const cf = { razon_social: 'ALBERTO', cuit: null };
  // Venta que superó el umbral: se le pidió el DNI y se lo informó.
  const conDni = docReceptor(cf, 6, { doc_tipo: 96, doc_nro: '20345678' });
  assert.equal(conDni.tipo, 96);
  assert.equal(conDni.nro, '20345678');
  assert.equal(conDni.label, 'DNI');
  // Sin el dato guardado se cae a la reconstrucción de siempre, que es lo único que
  // hay para los comprobantes anteriores.
  const viejo = docReceptor(cf, 6, null);
  assert.equal(viejo.tipo, 99);
  assert.equal(viejo.label, 'Consumidor Final');
  // Y un CUIT informado se imprime como CUIT.
  assert.equal(docReceptor({ cuit: '30712400125' }, 1, { doc_tipo: 80, doc_nro: '30712400125' }).label, 'CUIT');
  // El 99 no lleva número: es «sin identificar».
  assert.equal(docReceptor(cf, 6, { doc_tipo: 99, doc_nro: '0' }).nro, '0');
});

test('la nota que corrige esa venta NO vuelve a pedir el documento', () => {
  // El operador tendría que ir a buscar el papel de una venta de hace un mes.
  assert.match(VENTAS, /const DOC_TIPO_CLAVE = \{ 80: 'cuit', 86: 'cuil', 96: 'dni' \};/);
  assert.match(VENTAS, /function identificacionDe\(f\)/);
  const usos = (VENTAS.match(/identificacion: req\.body\?\.identificacion \|\| identificacionDe\(f\)/g) || []).length;
  assert.equal(usos, 2, 'la nota de crédito y la de débito');
  // El 99 es «sin identificar»: no es un documento y no hay nada que reusar.
  assert.doesNotMatch(VENTAS, /99: '/);
});

test('el PDF lo lee de la factura, que es donde quedó', () => {
  assert.match(PDF, /docReceptor\(cliente, factura\.cbte_tipo, factura\)/);
  assert.match(PDF, /const DOC_LABEL = \{ 80: 'CUIT', 86: 'CUIL', 96: 'DNI', 99: 'Consumidor Final' \};/);
});
