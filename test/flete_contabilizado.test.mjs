// ══ LA FACTURA DEL FLETERO SE CONTABILIZA ══════════════════════════════════
//
// Pablo, 27/8/2026: «deberíamos poder cargar y contabilizar la factura de los
// fleteros ahí mismo. Armemos para que haga el asiento contable».
//
// Hasta acá el flete entraba al COSTO del lote y nada más: no generaba asiento ni
// deuda con el fletero. Son dos libros distintos y los dos tienen que estar — el
// costeo dice cuánto salió la mercadería; el asiento dice que se compró un
// servicio, que hay IVA crédito fiscal y que a alguien se le debe plata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const DB = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');

// Las dos funciones puras del router, sacadas del archivo y ejecutadas. Son la
// aritmética donde un signo cambia lo que se le paga al fletero.
function fn(nombre, extra = '') {
  const i = SG.indexOf('function ' + nombre + '(');
  assert.ok(i > 0, 'no encontré ' + nombre);
  let d = 0, j = SG.indexOf('{', i);
  for (; j < SG.length; j++) {
    if (SG[j] === '{') d++;
    else if (SG[j] === '}') { d--; if (d === 0) { j++; break; } }
  }
  return new Function('r2', extra + SG.slice(i, j) + '; return ' + nombre + ';')(
    (n) => Math.round((Number(n) || 0) * 100) / 100);
}

// ── EL NETO Y EL IVA ───────────────────────────────────────────────────────
test('del total se despeja el neto a la alícuota general', () => {
  const montos = fn('montosDeFlete');
  // $250.000 con IVA adentro al 21%.
  const m = montos({ monto: 250000 });
  assert.equal(m.total, 250000);
  assert.equal(m.iva_alicuota, 21);
  assert.equal(m.neto, 206611.57);
  assert.equal(m.iva_monto, 43388.43);
  // Y cierran entre sí: el asiento no puede quedar por un centavo.
  assert.equal(Math.round((m.neto + m.iva_monto) * 100) / 100, m.total);
});

test('EL TOTAL NO SE TOCA NUNCA', () => {
  // Es lo que dice el papel, lo que se le paga al fletero y lo que ya venía
  // entrando al costo del lote. Si el redondeo lo moviera, el costo de la partida
  // cambiaría por cargar un IVA.
  const montos = fn('montosDeFlete');
  for (const t of [250000, 133333.33, 1, 999999.99, 0.01]) {
    assert.equal(montos({ monto: t }).total, Math.round(t * 100) / 100);
  }
});

test('otra alícuota se respeta', () => {
  const montos = fn('montosDeFlete');
  const m = montos({ monto: 110500, iva_alicuota: 10.5 });
  assert.equal(m.iva_alicuota, 10.5);
  assert.equal(m.neto, 100000);
  assert.equal(m.iva_monto, 10500);
});

test('exento: todo va al neto y no hay IVA', () => {
  const montos = fn('montosDeFlete');
  const m = montos({ monto: 80000, iva_alicuota: 0 });
  assert.equal(m.neto, 80000);
  assert.equal(m.iva_monto, 0);
  assert.equal(m.iva_alicuota, 0);
});

test('si la factura trae neto e IVA por separado, mandan esos', () => {
  // Una factura puede no cerrar exactamente contra la alícuota (redondeos del
  // proveedor). Lo que dice el papel gana sobre la cuenta.
  const montos = fn('montosDeFlete');
  const m = montos({ monto: 250000, neto: 206611.50, iva_monto: 43388.50 });
  assert.equal(m.neto, 206611.50);
  assert.equal(m.iva_monto, 43388.50);
  assert.equal(m.total, 250000);
});

// ── EL ASIENTO ─────────────────────────────────────────────────────────────
test('sin modelo parametrizado no se inventa un asiento', () => {
  // Se avisa y el flete entra al costo igual: no se traba la operación del día por
  // una parametrización que hace el contador. Pero un gasto fuera del libro hay
  // que decirlo, o no se descubre hasta que el mayor no cierra.
  const armar = fn('asientoDeFlete',
    'const lineasModeloDe = () => null; const CLAVE_MODELO_FLETE = "x";'
    + 'const armarAsientoFactura = () => { throw new Error("no debería llamarse"); };');
  const d = armar({}, { monto: 250000 });
  assert.equal(d.sin_modelo, true);
  assert.equal(d.balancea, false);
  assert.deepEqual(d.lineas, []);
});

test('el asiento usa el MISMO armador que la factura de mercadería', () => {
  // Dos maneras de asentar una compra de servicio son dos respuestas a la misma
  // pregunta, y a los tres meses el mayor no cierra.
  const i = SG.indexOf('function asientoDeFlete(db, b)');
  const b = SG.slice(i, i + 900);
  assert.match(b, /armarAsientoFactura\(lineas, \{/);
  assert.match(b, /neto: m\.neto, iva_monto: m\.iva_monto, total: m\.total/);
  // Un flete no trae percepciones: van en cero explícito, no ausentes.
  assert.match(b, /percepcion_iva: 0, percepcion_ganancias: 0, percepciones_iibb: \[\]/);
});

test('el modelo se busca con el MISMO lector, no con una copia', () => {
  assert.match(SG, /function lineasModeloFactura\(db\) \{ return lineasModeloDe\(db, CLAVE_MODELO_FACT\); \}/);
  assert.match(SG, /function lineasModeloDe\(db, CLAVE\) \{/);
  assert.match(SG, /const CLAVE_MODELO_FLETE = 'asiento_modelo_flete'/);
  // Y sigue habiendo una sola definición del lector.
  assert.equal((SG.match(/function lineasModeloDe\(/g) || []).length, 1);
});

test('no hay factura sin su asiento: van en la MISMA transacción', () => {
  // Si se guardaran por separado, el segundo paso podía no correr nunca y quedaba
  // una deuda con el fletero que existe para él y no existe para la contabilidad.
  const i = SG.indexOf("router.post('/fletes-entrada/:recepcionId/valorizar'");
  const b = SG.slice(i, i + 7000);
  assert.match(b, /db\.transaction\(\(\) => \{/);
  const tx = b.indexOf('db.transaction(() => {');
  const asiento = b.indexOf('crearAsiento(db, {');
  const costo = b.indexOf('recalcCostoLote(db, Number(l.id))');
  assert.ok(tx > 0 && asiento > tx, 'el asiento se escribe adentro de la transacción');
  assert.ok(asiento < costo, 'y antes de recostear, para que un asiento roto no deje el costo cambiado');
});

test('el asiento que no balancea NO se guarda, y tampoco el flete', () => {
  const i = SG.indexOf("router.post('/fletes-entrada/:recepcionId/valorizar'");
  const b = SG.slice(i, i + 7000);
  assert.match(b, /if \(!as\.balancea\) \{/);
  assert.match(b, /no se guarda nada/);
  assert.match(b, /Hay líneas del asiento con importe y sin cuenta/);
});

test('el número del asiento queda pegado al gasto', () => {
  // Sin eso, el flete y su asiento quedan sueltos y no hay forma de ir de uno al
  // otro cuando alguien pregunta de dónde salió ese movimiento.
  assert.match(DB, /addCol\('sg_gastos_directos', 'asiento_id',\s*'INTEGER'\)/);
  assert.match(SG, /UPDATE sg_gastos_directos SET asiento_id=\? WHERE id=\?/);
  // Y el neto y el IVA también: son lo que va al Diario de IVA Compras.
  for (const c of ['neto', 'iva_alicuota', 'iva_monto']) {
    assert.ok(DB.includes("addCol('sg_gastos_directos', '" + c + "'"), 'falta la columna ' + c);
  }
});

// ── LA PANTALLA ────────────────────────────────────────────────────────────
test('el cuadro del asiento se muestra ANTES de guardar', () => {
  // Es la regla del repo: toda operación que asienta muestra el asiento, y es el
  // único momento en que se puede frenar.
  assert.match(PANEL, /function sgFeAsiento\(\)\{/);
  assert.match(PANEL, /id="sgfe-asiento"/);
  assert.match(PANEL, /sgAsientoPlegado\(sgAsientoTabla\(d\.lineas\), 'Asiento de este flete'\)/);
  // Se dispara al cambiar el total y la alícuota.
  assert.match(PANEL, /sgFeDif\(\);sgFeAsiento\(\)/);
  assert.match(PANEL, /id="sgfe-alic" onchange="sgFeAsiento\(\)"/);
});

test('el cuadro lo arma el BACKEND, la pantalla sólo lo dibuja', () => {
  // Si el front rehiciera la cuenta, tarde o temprano mostraría un asiento
  // distinto del que se graba y el cuadro dejaría de servir para frenar nada.
  const i = PANEL.indexOf('function sgFeAsiento(){');
  const b = PANEL.slice(i, i + 1800);
  assert.match(b, /api\('\/api\/sg\/fletes-entrada\/asiento-preview', 'POST'/);
  assert.match(SG, /router\.post\('\/fletes-entrada\/asiento-preview'/);
});

test('si no se contabilizó, se dice — y no con un toast que se va solo', () => {
  const i = PANEL.indexOf('function sgFeGuardar(){');
  const b = PANEL.slice(i, i + 1600);
  assert.match(b, /if \(r\.data && r\.data\.aviso\) \{ alert\(r\.data\.aviso\); \}/);
  assert.match(SG, /NO se contabilizó: falta elegir el asiento modelo/);
  // Y la alícuota viaja al guardar, o el backend despeja con la de por defecto.
  assert.match(b, /iva_alicuota: \(eid\('sgfe-alic'\) \|\| \{\}\)\.value/);
});

test('el desglose de neto e IVA se ve mientras se carga', () => {
  const i = PANEL.indexOf('function sgFeAsiento(){');
  const b = PANEL.slice(i, i + 1800);
  assert.match(b, /Neto <b>' \+ sgMoney2\(m\.neto\)/);
  assert.match(b, /IVA <b>' \+ sgMoney2\(m\.iva_monto\)/);
  // sgMoney2 y no sgMoney: esto se compara al centavo contra el papel.
  assert.ok(!/sgMoney\(m\.neto\)/.test(b), 'al peso redondo no se puede comparar contra la factura');
});

// ── EL PAPEL DEL FLETERO ───────────────────────────────────────────────────
test('el archivo va a R2 y la clave NO sale al navegador', () => {
  // Mismo camino que los documentos del embarque: en la base queda la referencia
  // y el archivo se baja por el backend, que verifica que sea el de ESE gasto.
  assert.match(SG, /router\.post\('\/gastos-directos\/:id\/archivo'/);
  assert.match(SG, /router\.get\('\/gastos-directos\/:id\/archivo'/);
  assert.match(SG, /await subirArchivo\(f\.buffer, key, f\.mimetype\)/);
  for (const c of ['storage_key', 'archivo_nombre', 'archivo_mime', 'archivo_bytes']) {
    assert.ok(DB.includes("addCol('sg_gastos_directos', '" + c + "'"), 'falta la columna ' + c);
  }
  // El listado dice SI hay archivo, no CUÁL es.
  assert.match(SG, /\(g\.storage_key IS NOT NULL\) AS tiene_archivo/);
});

test('la fila se actualiza DESPUÉS de subir, no antes', () => {
  // Al revés dejaría la fila apuntando a un archivo que no existe, y un botón de
  // descarga que rompe.
  const i = SG.indexOf("router.post('/gastos-directos/:id/archivo'");
  const b = SG.slice(i, i + 2200);
  const sube = b.indexOf('await subirArchivo(');
  const guarda = b.indexOf('UPDATE sg_gastos_directos SET storage_key=?');
  assert.ok(sube > 0 && guarda > sube, 'el UPDATE va después de la subida');
});

test('sólo PDF, JPG o PNG, y hasta 10MB', () => {
  const i = SG.indexOf("router.post('/gastos-directos/:id/archivo'");
  const b = SG.slice(i, i + 2200);
  assert.match(b, /DOC_MIMES\.has\(f\.mimetype\)/);
  assert.match(b, /f\.size > DOC_MAX_BYTES/);
  // Y usa uploadDoc, que es una FUNCIÓN declarada: uploadDocMem es una const que se
  // declara miles de líneas más abajo, y pasarla como middleware acá se evalúa al
  // registrar la ruta —antes de que exista— y el server no arranca.
  assert.match(b, /requireAuth, uploadDoc, async/);
});

test('sacar el archivo suelta la referencia, no borra el papel', () => {
  const i = SG.indexOf("router.delete('/gastos-directos/:id/archivo'");
  assert.ok(i > 0);
  const b = SG.slice(i, i + 900);
  assert.match(b, /SET storage_key=NULL, archivo_nombre=NULL/);
  assert.ok(!/borrarArchivo|deleteObject/.test(b), 'el archivo no se borra del depósito');
});

test('el modal no se cierra si todavía falta la factura', () => {
  // Recién después de valorizar existe el gasto al que colgar el papel. Cerrar
  // obligaría a volver a entrar para adjuntar la factura que se tiene en la mano.
  const i = PANEL.indexOf('function sgFeGuardar(){');
  const b = PANEL.slice(i, i + 2000);
  assert.match(b, /if \(r\.data && r\.data\.id && !\(SGFE\.sel && SGFE\.sel\.tiene_archivo\)\)/);
  assert.match(b, /SGFE\.sel\.gasto_id = r\.data\.id/);
});

test('sin gasto todavía, se dice — no se ofrece un botón que no puede andar', () => {
  const i = PANEL.indexOf('function sgFeArchPintar(){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 1400);
  assert.match(b, /Guardá primero la valorización/);
  assert.match(b, /x\.tiene_archivo/);
  assert.match(b, /inline=1/, 'se puede ver sin bajarlo');
});
