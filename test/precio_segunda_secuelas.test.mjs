// ══ LO QUE DESTAPÓ PODER CAMBIARLE EL PRECIO A UNA PARTIDA ═════════════════
//
// Desde el 29/8/2026 se puede corregir el precio de una partida ya despachada o
// separada por calidad (el pedido de Pablo: «el proveedor me reconoció la mercadería
// en mal estado»). Eso creó un estado que antes no existía: DOS LOTES HERMANOS CON
// PRECIOS DISTINTOS.
//
// Todo lo de acá son cosas que ese estado rompe, encontradas revisando el cambio.
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

// ── 1 · EL PRECIO DE LA PARTIDA ES NETO, Y NO LO DECÍA ─────────────────────

test('la pantalla avisa que el precio es NETO cuando la orden se pactó con IVA', () => {
  // La partida guarda el NETO cuando la orden dice «el precio incluye IVA»: lo hace
  // la recepción y lo hace la pantalla de precios de la orden. Pero la corrección
  // guarda lo que se escribe, sin convertir.
  //
  // El comprador acuerda «$20.000 el cajón» con el productor —con IVA, que es como se
  // habla—, tipea 20.000, y lo que se termina debiendo queda 10,5% ARRIBA de lo
  // acordado. Para el lado que nadie reclama.
  assert.match(PANEL, /id="sg-loteed-precio-iva"/);
  const i = PANEL.indexOf('SG.loteEdNeto = (Number(ocD.precio_incluye_iva) === 1');
  assert.ok(i > 0, 'la pantalla no mira si el precio de la orden trae IVA');
  const b = PANEL.slice(i - 300, i + 900);
  assert.match(b, /alicIt > 0\) \? alicIt : null/);
  assert.match(b, /este precio es NETO/);
});

test('y muestra cuánto es eso CON IVA mientras se tipea', () => {
  // Es el número que se habló con el productor. Tenerlo al lado es la única forma de
  // darse cuenta de que se puso el otro.
  const i = PANEL.indexOf('function sgLoteEdEq(){');
  const b = PANEL.slice(i, i + 1400);
  assert.match(b, /sgMoney2\(v \* \(1 \+ SG\.loteEdNeto \/ 100\)\)/);
  assert.match(b, /con IVA/);
  // Y sin kilos por bulto también: antes se cortaba antes de llegar acá.
  assert.match(b, /if \(!kpb\) \{ c\.innerHTML = conIva/);
});

// ── 2 · DESHACER LA SEPARACIÓN NO PUEDE BORRAR EL DESCUENTO ────────────────

test('al deshacer la separación, el precio de la madre sale del costo que volvió', () => {
  // El costo vuelve SUMADO pero el precio se quedaba en el de la madre: 2.000 kg con
  // un costo de 1.760.000 y un precio que dice 1.000. Y la próxima corrección
  // reescribe costo_base = kilos × precio, así que el descuento que el productor
  // había reconocido desaparecía sin que nadie lo viera.
  const i = SG.indexOf("router.post('/lotes/:id/reclasificaciones/:rid/anular'");
  const j = SG.indexOf('const pm = Number(madre.precio_unitario_kg)', i);
  assert.ok(j > i, 'deshacer la separación no rehace el precio de la madre');
  const b = SG.slice(j, j + 1400);
  // Sólo si eran distintos: si eran iguales no hay nada que promediar. Y la
  // condición arranca ahí: colgarla de otra cosa la apaga sin que se note.
  assert.match(b, /[\r\n]\s*if \(madre\.precio_unitario_kg != null && hijo\.precio_unitario_kg != null/);
  assert.match(b, /Math\.abs\(pm - ph\) > 0\.000001/);
  assert.match(b, /\(Number\(mAhora\.costo_base\) \|\| 0\) \/ kg/);
  assert.match(b, /anotarEdicion\(db, \{ tabla: 'sg_lotes', registroId: madre\.id, campo: 'precio_unitario_kg'/);
  assert.match(b, /UPDATE sg_lotes SET precio_unitario_kg=\? WHERE id=\?/);
});

test('la cuenta del promedio da lo que tiene que dar', () => {
  // 1.400 kg a $1.000 + 600 kg a $600 = 1.760.000 sobre 2.000 kg = $880/kg.
  const kgM = 1400, kgH = 600, pM = 1000, pH = 600;
  const costo = kgM * pM + kgH * pH;
  const kg = kgM + kgH;
  assert.equal(+(costo / kg).toFixed(6), 880);
  // Y el costo total no se mueve: es lo que se acordó por cada parte, no un invento.
  assert.equal(kg * 880, costo);
});

// ── 3 · PISAR EL PRECIO DEL RENGLÓN SE AVISA ───────────────────────────────

test('cambiar el precio de la orden dice qué partidas perdieron el suyo', () => {
  // aplicarPrecioItem pisa el precio de TODOS los lotes del renglón. Era inocuo
  // mientras dos hermanos no podían tener precios distintos; ahora sí pueden, y una
  // segunda renegociada con el productor pierde su descuento ahí.
  //
  // No se frena —el renglón es lo pactado— pero enterarse por la cuenta corriente
  // tres semanas después no sirve.
  const i = SG.indexOf('function aplicarPrecioItem(');
  const b = SG.slice(i, i + 2400);
  assert.match(b, /if \(Array\.isArray\(pisados\) && l\.precio_unitario_kg != null/);
  assert.match(b, /pisados\.push\(\{ id: l\.id, codigo: l\.codigo_lote/);
  const ep = SG.indexOf("router.put('/oc/:id/precios'");
  const be = SG.slice(ep, SG.indexOf('} catch (e)', ep));
  assert.match(be, /const pisados = \[\];/);
  // El aviso arranca en pisados.length: anteponerle algo lo apaga en silencio.
  assert.match(be, /[\r\n]\s*pisados\.length[\r\n]/);
  assert.match(be, /un precio propio y ahora tienen el del rengl/);
  assert.match(be, /Si eso era un descuento acordado, hay que volver a ponerlo/);
});

test('y los dos avisos conviven, no se pisan entre sí', () => {
  // El del cronograma congelado ya existía. Si el nuevo lo reemplazara, cambiar el
  // precio de una orden con cuotas pagadas dejaría de avisar que la deuda quedó vieja.
  const ep = SG.indexOf("router.put('/oc/:id/precios'");
  const be = SG.slice(ep, SG.indexOf('} catch (e)', ep));
  assert.match(be, /AVISO_CRONOGRAMA_CONGELADO : null,\r?\n\s*\]\.filter\(Boolean\)\.join/);
});

// ── 4 · EL MARGEN GUARDADO, CON LA MISMA CUENTA QUE EL REMITO ──────────────

function traerMargen() {
  const i = SG.indexOf('function recalcMargenDespachos(db, loteId) {');
  assert.ok(i > 0);
  const src = SG.slice(i, SG.indexOf('\n}', i) + 2);
  // eslint-disable-next-line no-new-func
  return new Function(src + '; return recalcMargenDespachos;')();
}
const recalcMargen = traerMargen();

function baseMargen() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, kg_reales REAL, costo_final REAL);
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_despacho_items (id INTEGER PRIMARY KEY, despacho_id INTEGER,
      lote_id INTEGER, kg_despachados REAL, subtotal REAL, margen_estimado REAL);
    CREATE TABLE sg_lote_decomisos (id INTEGER PRIMARY KEY, lote_id INTEGER, kg REAL);
    CREATE TABLE sg_transformaciones (id INTEGER PRIMARY KEY, lote_origen_id INTEGER,
      kg_transformados REAL);
    CREATE TABLE sg_reprocesos (id INTEGER PRIMARY KEY, lote_madre_id INTEGER,
      estado TEXT, kg_procesados REAL);
  `);
  db.prepare('INSERT INTO sg_lotes VALUES (1, 1000, 500000)').run();   // $500/kg
  db.prepare('INSERT INTO sg_despachos VALUES (1, 1), (2, 0)').run();  // el 2 está anulado
  db.prepare(`INSERT INTO sg_despacho_items (despacho_id, lote_id, kg_despachados, subtotal, margen_estimado)
    VALUES (1, 1, 100, 80000, 999), (2, 1, 50, 40000, 777)`).run();
  return db;
}
const margenDe = (db, id) =>
  db.prepare('SELECT margen_estimado m FROM sg_despacho_items WHERE id=?').get(id).m;

test('el margen se rehace con el costo por kilo vigente', () => {
  const db = baseMargen();
  recalcMargen(db, 1);
  assert.equal(margenDe(db, 1), 80000 - 100 * 500);
});

test('los REPROCESOS también bajan los kilos vigentes, como en el alta del remito', () => {
  // Le faltaban. Mientras esto lo llamaba sólo la corrección de una partida no
  // mordía —el freno corta cualquier lote con un reproceso activo— pero
  // aplicarPrecioItem lo llama sobre TODOS los lotes del renglón, y ahí sí entran.
  const db = baseMargen();
  db.prepare("INSERT INTO sg_reprocesos (lote_madre_id, estado, kg_procesados) VALUES (1,'activo',200)").run();
  recalcMargen(db, 1);
  // vigentes = 1000 − 200 = 800 → $625/kg → 80.000 − 62.500
  assert.equal(margenDe(db, 1), 17500);
});

test('y un reproceso ANULADO no cuenta', () => {
  const db = baseMargen();
  db.prepare("INSERT INTO sg_reprocesos (lote_madre_id, estado, kg_procesados) VALUES (1,'anulado',200)").run();
  recalcMargen(db, 1);
  assert.equal(margenDe(db, 1), 30000);
});

test('la merma también, y las dos juntas', () => {
  const db = baseMargen();
  db.prepare('INSERT INTO sg_lote_decomisos (lote_id, kg) VALUES (1, 100)').run();
  db.prepare("INSERT INTO sg_reprocesos (lote_madre_id, estado, kg_procesados) VALUES (1,'activo',100)").run();
  recalcMargen(db, 1);
  // vigentes = 1000 − 100 − 100 = 800 → $625/kg
  assert.equal(margenDe(db, 1), 17500);
});

test('el remito ANULADO no se toca', () => {
  // Ese remito ya no existe: su margen es historia de algo que se dio de baja, y el
  // freno de «ya se despachó» tampoco lo cuenta.
  const db = baseMargen();
  recalcMargen(db, 1);
  assert.equal(margenDe(db, 2), 777, 'reescribió el renglón de un remito anulado');
});

test('con los kilos vigentes en cero el costo va a CERO, como en el alta', () => {
  // El alta del remito hace `kgVig > 0 ? costo/kgVig : 0`. Si acá diera nulo, la
  // ficha del remito y el informe dirían cosas distintas — que es justo lo que este
  // recálculo viene a evitar.
  const db = baseMargen();
  db.prepare('INSERT INTO sg_lote_decomisos (lote_id, kg) VALUES (1, 1000)').run();
  recalcMargen(db, 1);
  assert.equal(margenDe(db, 1), 80000);
});
