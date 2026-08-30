// ══ DOS MEJORAS DEL REMITO ═════════════════════════════════════════════════
//
// Pablo, 28/8/2026: «acá debería tomar sólo los que están dados de alta en
// cooperativas. En el remito debo poder modificar el precio».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const cuerpo = (nombre, largo = 3000) => {
  const i = PANEL.indexOf(nombre);
  assert.ok(i > 0, 'no existe ' + nombre);
  return PANEL.slice(i, i + largo);
};

// ══ 1 · LA CUADRILLA SALE DEL CATÁLOGO ═════════════════════════════════════

test('el remito ofrece cooperativas, no todos los proveedores', () => {
  // Se podía elegir de cuadrilla de carga a un proveedor de tomates. La
  // recepción ya elegía del catálogo: es la misma pregunta con dos listas.
  const i = PANEL.indexOf("api('/api/sg/cooperativas').then(function(rc){");
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /sel=eid\('sg-desp-coop'\)/);
  assert.match(b, /'<option value="'\+c\.id\+'">'\+escH\(c\.nombre\)/);
  // Y con el proveedor al lado: es a quién se le va a pagar.
  assert.match(b, /c\.proveedor_nombre\?\(' — '\+escH\(c\.proveedor_nombre\)\)/);
});

test('sin cooperativas cargadas se dice, no se muestra una lista vacía', () => {
  const i = PANEL.indexOf("api('/api/sg/cooperativas').then(function(rc){");
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /no hay cooperativas dadas de alta/);
});

test('lo que viaja es el id del CATÁLOGO, y el servidor saca de ahí a quién se le paga', () => {
  // La recepción ya lo hacía así. Si el remito mandara un proveedor suelto, la
  // descarga quedaría sin cuadrilla y no se podría liquidar.
  assert.match(PANEL, /cooperativa_catalogo_id:eid\('sg-desp-coop'\)\.value\?Number\(eid\('sg-desp-coop'\)\.value\):null/);
  const i = SG.indexOf('LA CUADRILLA QUE CARGA SALE DEL CATÁLOGO DE COOPERATIVAS');
  assert.ok(i > 0, 'el servidor no acepta la cooperativa del catálogo');
  const b = SG.slice(i, i + 1600);
  assert.match(b, /SELECT id, proveedor_id FROM sg_cooperativas WHERE id=\? AND activo=1/);
  assert.match(b, /coopId = c\.proveedor_id;/);
  assert.match(b, /La cooperativa elegida no existe o está dada de baja/);
  // Y el gasto queda con las dos cosas: a quién se le paga y qué cuadrilla fue.
  assert.match(b, /cooperativaId: coopCatId/);
});

test('y el mismo criterio que la recepción, no uno nuevo', () => {
  // Dos reglas sobre lo mismo terminan diciendo cosas distintas.
  const rec = SG.indexOf("const coopCatId = b.cooperativa_catalogo_id ? Number(b.cooperativa_catalogo_id) : null;");
  assert.ok(rec > 0);
  // Tres lugares preguntan lo mismo con la MISMA consulta: la recepción, el
  // remito y la valorización de la carga. Distinta sería el problema.
  assert.equal((SG.match(/SELECT id, proveedor_id FROM sg_cooperativas WHERE id=\? AND activo=1/g) || []).length, 3);
});

// ══ 2 · EL PRECIO DEL REMITO SE PUEDE CORREGIR ═════════════════════════════

test('existe la puerta, y pide el motivo', () => {
  // Antes había que anular el remito y armarlo de nuevo entero por un número
  // mal tipeado — y anularlo devuelve el stock y lo vuelve a sacar, así que
  // dejaba dos movimientos falsos en la historia de la partida.
  const i = SG.indexOf("router.put('/despachos/:id/precios'");
  assert.ok(i > 0, 'no existe el endpoint');
  const b = SG.slice(i, i + 4200);
  assert.match(b, /motivo\.length < 3/);
  assert.match(b, /anotarEdicion\(db, \{ tabla: 'sg_despacho_items'/);
  assert.match(b, /campo: 'precio_por_kg'/);
});

test('NO se puede después de facturar, y se dice con qué comprobante', () => {
  // El precio salió en un papel que el cliente tiene: cambiarlo dejaría el
  // remito diciendo una cosa y la factura otra.
  const i = SG.indexOf("router.put('/despachos/:id/precios'");
  const b = SG.slice(i, i + 4200);
  assert.match(b, /FROM sg_factura_despachos fd/);
  assert.match(b, /status\(409\)/);
  assert.match(b, /Este remito ya se facturó/);
  assert.match(b, /Se corrige con una nota de crédito/);
  // Y el comprobante por nombre, no un «no se puede» a secas.
  assert.match(b, /fac\.punto_venta \+ '-' \+ fac\.cbte_nro/);
});

test('y una factura ACREDITADA no traba: esa venta ya no está en pie', () => {
  const i = SG.indexOf("router.put('/despachos/:id/precios'");
  const b = SG.slice(i, i + 4200);
  assert.match(b, /\$\{facturaCuenta\('f'\)\} AND \$\{noEsNotaDeCredito\('f'\)\}/);
});

test('el margen se rehace: si no, el informe de rentabilidad miente', () => {
  const i = SG.indexOf("router.put('/despachos/:id/precios'");
  const b = SG.slice(i, i + 4200);
  assert.match(b, /UPDATE sg_despacho_items SET precio_por_kg=\?, subtotal=\?, margen_estimado=\?/);
  assert.match(b, /El margen se rehace|EL MARGEN SE REHACE/);
});

test('la cuenta del margen, corriéndola', () => {
  // El costo por kilo se despeja del margen que quedó guardado al despachar: es
  // el de la partida en ese momento, y no cambia porque cambie el precio de
  // venta. Recalcularlo con el costo de HOY reescribiría el pasado.
  const despejar = (precioAntes, kg, margenAntes) =>
    (margenAntes != null && kg > 0 && precioAntes > 0)
      ? ((precioAntes * kg) - margenAntes) / kg : null;
  // 315 kg a $60.000, margen $18.187.330 → costo/kg = 2.261,65...
  const costoKg = despejar(60000, 315, 18187330);
  assert.equal(Math.round(costoKg * 100) / 100, 2262.44);
  // Y con el precio nuevo, el margen sale de la misma cuenta.
  const margenNuevo = (55000 * 315) - 315 * costoKg;
  assert.equal(Math.round(margenNuevo), 16612330);
  // Y baja exactamente lo que bajó la venta: el costo no se movió.
  assert.equal(Math.round(18187330 - margenNuevo), (60000 - 55000) * 315);
});

test('un renglón de otro remito no entra', () => {
  const i = SG.indexOf("router.put('/despachos/:id/precios'");
  const b = SG.slice(i, i + 4200);
  assert.match(b, /no es de este remito/);
});

test('y el precio que no cambió no se toca ni deja rastro', () => {
  // Guardar sin cambiar nada llenaría el registro de correcciones de ruido.
  const i = SG.indexOf("router.put('/despachos/:id/precios'");
  const b = SG.slice(i, i + 4200);
  assert.match(b, /if \(Math\.abs\(antes - p\.precio\) < 0\.000001\) continue;/);
});

// ── LA PANTALLA ────────────────────────────────────────────────────────────

test('el precio es un campo, no un número muerto', () => {
  const b = cuerpo('function sgDespVer(id){', 6200);
  assert.match(b, /var puedeEd = lnbPuedeOperar\('sg-ventas'\) && !d\.facturado;/);
  assert.match(b, /id="sg-dped-'\+i\+'"/);
  assert.match(b, /Por qué cambia el precio/);
});

test('el subtotal se rehace mientras se escribe', () => {
  // Es la única forma de ver si el número nuevo es el que se quería ANTES de
  // guardarlo.
  const b = cuerpo('function sgDespEdUpd(i, valor){', 2200);
  assert.match(b, /c\.textContent = sgMoney\(kg \* SG\.despEd\.items\[i\]\.precio\)/);
  assert.match(b, /Total con los precios nuevos/);
});

test('si ya se facturó se dice POR QUÉ, no se muestra apagado', () => {
  // Un campo deshabilitado sin explicación se lee como que falta un permiso.
  const b = cuerpo('function sgDespVer(id){', 8200);
  assert.match(b, /🔒 Este remito ya se facturó/);
  assert.match(b, /Se corrige con una nota de crédito/);
});

test('el servidor manda si está facturado', () => {
  const i = SG.indexOf('d.facturado = db.prepare(');
  assert.ok(i > 0, 'el GET no dice si está facturado');
  const b = SG.slice(i, i + 700);
  assert.match(b, /FROM sg_factura_despachos fd/);
  assert.match(b, /\$\{facturaCuenta\('f'\)\} AND \$\{noEsNotaDeCredito\('f'\)\}/);
});

test('el permiso que pide la pantalla es el que va a mirar el servidor', () => {
  // sg-ventas es el módulo dueño de sg/despachos: pedir otro ofrecería un botón
  // que rebota con 403.
  assert.match(PANEL, /sg-ventas es el módulo dueño de sg\/despachos/);
  const PREF = fs.readFileSync(path.join(RAIZ, 'src/servicios/ensure_api_prefijos.js'), 'utf8');
  assert.match(PREF, /\['sg-ventas',\s+'sg\/despachos,/);
});

// ── LA BASE ────────────────────────────────────────────────────────────────

test('el renglón aguanta el cambio de precio', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sg_despacho_items (id INTEGER PRIMARY KEY, despacho_id INTEGER,
    kg_despachados REAL, precio_por_kg REAL, subtotal REAL, margen_estimado REAL)`);
  db.prepare(`INSERT INTO sg_despacho_items VALUES (1, 9, 315, 60000, 18900000, 18187330)`).run();
  const it = db.prepare('SELECT * FROM sg_despacho_items WHERE id=1').get();
  const costoKg = ((it.precio_por_kg * it.kg_despachados) - it.margen_estimado) / it.kg_despachados;
  const nuevo = 55000;
  db.prepare('UPDATE sg_despacho_items SET precio_por_kg=?, subtotal=?, margen_estimado=? WHERE id=?')
    .run(nuevo, it.kg_despachados * nuevo, (it.kg_despachados * nuevo) - it.kg_despachados * costoKg, 1);
  const fin = db.prepare('SELECT * FROM sg_despacho_items WHERE id=1').get();
  assert.equal(fin.precio_por_kg, 55000);
  assert.equal(fin.subtotal, 17325000);
  // El margen bajó exactamente lo que bajó la venta: el costo no se movió.
  assert.equal(Math.round(it.margen_estimado - fin.margen_estimado), 1575000);
});
