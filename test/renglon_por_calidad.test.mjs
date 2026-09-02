// ══ DOS CALIDADES SON DOS RENGLONES DE LA ORDEN ════════════════════════════
//
// Pablo, 29/8/2026: «que separar por calidad parta también el renglón de la orden.
// Los 10 de segunda pasan a ser su propio renglón y ahí sí les ponés $20.000 sin
// tocar los 45. Es lo más parecido a la realidad: se pactaron dos precios».
//
// POR QUÉ EL RENGLÓN Y NO LA PARTIDA. Lo que se le paga al productor sale de
// sg_oc_items.precio_estimado_por_kg —lo mira acordadoDeOC y contra eso controla la
// liquidación a precio cerrado—. El precio de la partida es una copia derivada, y
// encima NETA de IVA: bajarlo cambiaba el costo y el cronograma pero no lo que la
// liquidación exigía. Dos números para la misma mercadería.
//
// EL INVARIANTE QUE TODO ESTO TIENE QUE CUMPLIR: partir el renglón NO cambia un peso
// de lo que se le debe al productor. Recién después se le pone otro precio, que es
// una decisión aparte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acordadoDeOC, precioUnicoDeOC } from '../src/servicios/sg_acordado.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const DB_SG = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');

// La función real, sacada del router. recalcTotalesOC se inyecta: rehace los totales
// de la cabecera y tiene sus propios tests; acá se prueba el reparto.
function traerPartir() {
  const i = SG.indexOf('function partirRenglonDeOrden(db, { itemId, loteId, kgMov, nota }) {');
  assert.ok(i > 0, 'no existe partirRenglonDeOrden');
  const src = SG.slice(i, SG.indexOf('\n}', i) + 2);
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  // eslint-disable-next-line no-new-func
  return new Function('r2', 'recalcTotalesOC', src + '; return partirRenglonDeOrden;')(r2, () => {});
}
const partir = traerPartir();

// La partida de la foto: 55 cajones de 18 kg a $2.777,78/kg ($50.000 el cajón),
// separada en 45 de primera y 10 de segunda.
function camion(opts = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, tipo_precio TEXT,
      precio_incluye_iva INTEGER, iva_alicuota_oc REAL);
    CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY AUTOINCREMENT, oc_id INTEGER,
      producto_id INTEGER, presentacion_id INTEGER,
      cantidad_estimada_presentaciones REAL, kg_estimados REAL,
      precio_estimado_por_kg REAL, observaciones_item TEXT, modo_carga TEXT,
      precio_referencia_venta REAL, iva_alicuota REAL, kg_por_bulto REAL,
      envase_id INTEGER, piso_id INTEGER);
    CREATE TABLE sg_presentaciones (id INTEGER PRIMARY KEY, factor_conversion REAL);
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, oc_item_id INTEGER, kg_reales REAL,
      bultos REAL, calidad TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_lote_decomisos (id INTEGER PRIMARY KEY, lote_id INTEGER, kg REAL, bultos INTEGER);
  `);
  db.prepare('INSERT INTO sg_oc VALUES (1, ?, 0, 10.5)').run(opts.tipo_precio || 'firme');
  db.prepare(`INSERT INTO sg_oc_items
    (id, oc_id, producto_id, presentacion_id, cantidad_estimada_presentaciones, kg_estimados,
     precio_estimado_por_kg, observaciones_item, modo_carga, precio_referencia_venta,
     iva_alicuota, kg_por_bulto, envase_id, piso_id)
    VALUES (1, 1, 7, 3, 55, 990, 2777.78, 'lo que se pidió', 'bulto', 9000, 10.5, 18, 4, 2)`).run();
  // Ya separada: 45 de primera y 10 de segunda, las dos del mismo renglón.
  db.prepare("INSERT INTO sg_lotes VALUES (1, 1, 810, 45, 'primera', 1)").run();
  db.prepare("INSERT INTO sg_lotes VALUES (2, 1, 180, 10, 'segunda', 1)").run();
  return db;
}
const item = (db, id) => db.prepare('SELECT * FROM sg_oc_items WHERE id=?').get(id);
const items = (db) => db.prepare('SELECT * FROM sg_oc_items WHERE oc_id=1 ORDER BY id').all();

// ── 1 · EL INVARIANTE: LO QUE SE DEBE NO SE MUEVE ──────────────────────────

test('partir el renglón NO cambia un peso de lo acordado', () => {
  // Es lo único que no puede pasar. Si partir el renglón moviera el total, cada
  // separación por calidad le cambiaría la plata al productor sin que nadie lo pida.
  const db = camion();
  const antes = acordadoDeOC(db, 1).total;
  assert.equal(antes, 55 * 18 * 2777.78, '55 cajones de 18 kg a $2.777,78');
  partir(db, { itemId: 1, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'segunda' });
  assert.equal(acordadoDeOC(db, 1).total, antes);
});

test('y ahora son DOS renglones, cada uno con lo suyo', () => {
  const db = camion();
  const nuevo = partir(db, { itemId: 1, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'segunda' });
  const todos = items(db);
  assert.equal(todos.length, 2);
  assert.equal(db.prepare('SELECT oc_item_id o FROM sg_lotes WHERE id=2').get().o, nuevo);
  assert.equal(db.prepare('SELECT oc_item_id o FROM sg_lotes WHERE id=1').get().o, 1);
});

test('el precio se COPIA: partir no es renegociar', () => {
  // Recién después se le pone otro, y eso es una decisión aparte con su pantalla.
  const db = camion();
  const nuevo = partir(db, { itemId: 1, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'segunda' });
  assert.equal(item(db, nuevo).precio_estimado_por_kg, 2777.78);
});

test('y con eso SÍ se le puede bajar el precio a la segunda sin tocar la primera', () => {
  // El pedido entero de Pablo, de punta a punta.
  const db = camion();
  const nuevo = partir(db, { itemId: 1, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'segunda' });
  db.prepare('UPDATE sg_oc_items SET precio_estimado_por_kg = ? WHERE id = ?')
    .run(20000 / 18, nuevo);   // $20.000 el cajón
  // 45 cajones al precio de la orden + 10 a $20.000. Los $1,80 de más son el
  // redondeo del propio precio de la orden ($2.777,78 × 18 = $50.000,04), no de esto.
  assert.equal(acordadoDeOC(db, 1).total, Math.round((45 * 18 * 2777.78 + 200000) * 100) / 100);
  assert.equal(Math.round(acordadoDeOC(db, 1).total / 1000) * 1000, 2450000);
  // Y la primera quedó como estaba.
  assert.equal(item(db, 1).precio_estimado_por_kg, 2777.78);
});

// ── 2 · LO PACTADO SE PARTE, NO SE DUPLICA ─────────────────────────────────

test('lo pactado se reparte en proporción y la suma da lo de antes', () => {
  // Si el renglón nuevo se llevara el pactado entero, la orden diría que se pidieron
  // 110 cajones. Y si no se llevara nada, «entró de más» contra lo pedido.
  const db = camion();
  const nuevo = partir(db, { itemId: 1, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'segunda' });
  const a = item(db, 1), b = item(db, nuevo);
  assert.equal(a.cantidad_estimada_presentaciones + b.cantidad_estimada_presentaciones, 55);
  assert.equal(Math.round((a.kg_estimados + b.kg_estimados) * 100) / 100, 990);
  assert.equal(b.cantidad_estimada_presentaciones, 10, '10 de 55');
  assert.equal(b.kg_estimados, 180);
});

test('la madre absorbe el redondeo, como con el costo', () => {
  // 7 de 55 cajones sobre 990 kg pactados = 126 kg exactos; con números que no dan
  // redondo, el sobrante se queda en la madre y la suma sigue cerrando.
  const db = camion();
  db.prepare('UPDATE sg_oc_items SET cantidad_estimada_presentaciones=57, kg_estimados=1000 WHERE id=1').run();
  const nuevo = partir(db, { itemId: 1, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'x' });
  const a = item(db, 1), b = item(db, nuevo);
  assert.equal(a.cantidad_estimada_presentaciones + b.cantidad_estimada_presentaciones, 57);
  assert.equal(Math.round((a.kg_estimados + b.kg_estimados) * 100) / 100, 1000);
});

test('el renglón nuevo se lleva la unidad, el envase y la alícuota', () => {
  // Sin modo_carga y kg_por_bulto, acordadoDeOC le hace OTRA cuenta —por kilo en vez
  // de por cajón— y el total del grupo deja de dar.
  const db = camion();
  const nuevo = partir(db, { itemId: 1, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'segunda' });
  const b = item(db, nuevo);
  assert.equal(b.modo_carga, 'bulto');
  assert.equal(b.kg_por_bulto, 18);
  assert.equal(b.iva_alicuota, 10.5);
  assert.equal(b.envase_id, 4);
  assert.equal(b.presentacion_id, 3);
  assert.equal(b.producto_id, 7);
  assert.equal(b.precio_referencia_venta, 9000);
  assert.equal(b.observaciones_item, 'segunda', 'el renglón dice de dónde salió');
});

test('y el precio por unidad del grupo deja de ser único, como corresponde', () => {
  // Con dos precios ya no hay UN precio por cajón: poner el de uno sería inventar el
  // del otro. precioUnicoDeOC tiene que devolver null.
  const db = camion();
  assert.equal(precioUnicoDeOC(db, 1).precio, Math.round(2777.78 * 18 * 100) / 100);
  const nuevo = partir(db, { itemId: 1, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'segunda' });
  db.prepare('UPDATE sg_oc_items SET precio_estimado_por_kg = ? WHERE id = ?').run(1111.11, nuevo);
  assert.equal(precioUnicoDeOC(db, 1).precio, null);
});

// ── 3 · LOS BORDES ─────────────────────────────────────────────────────────

test('cuando la mercadería entró PESADA, el reparto va por kilos', () => {
  const db = camion();
  db.prepare('UPDATE sg_lotes SET bultos = NULL').run();
  const nuevo = partir(db, { itemId: 1, loteId: 2, bultosMov: null, kgMov: 180, nota: 'x' });
  // 180 de 990 kg recibidos → esa proporción sobre lo pactado
  assert.equal(item(db, nuevo).kg_estimados, Math.round(990 * (180 / 990) * 100) / 100);
});

test('y en un renglón MIXTO lo pactado no se lo lleva todo el lote contado', () => {
  // El camión que descarga 55 cajones y después 800 kg sueltos del mismo producto.
  // Prorrateando por CAJONES, el lote a granel no entraba en el denominador: partir
  // el contado daba 55/55 = 1 y se llevaba TODO lo pactado, dejando el renglón de los
  // 800 kg pactado en CERO. Después la orden avisa «entró de más» de un lado y
  // «faltó» del otro, las dos falsas.
  const db = camion();
  db.prepare('UPDATE sg_lotes SET bultos = NULL, kg_reales = 800 WHERE id = 2').run();
  const nuevo = partir(db, { itemId: 1, loteId: 1, bultosMov: 45, kgMov: 810, nota: 'contado' });
  const a = item(db, 1), b = item(db, nuevo);
  // 810 de 1.610 kg: ni todo ni nada.
  assert.equal(b.kg_estimados, Math.round(990 * (810 / 1610) * 100) / 100);
  assert.ok(a.kg_estimados > 0, 'el renglón del granel quedó pactado en cero');
  assert.equal(Math.round((a.kg_estimados + b.kg_estimados) * 100) / 100, 990);
});

test('sin nada que mover, no se parte nada', () => {
  const db = camion();
  db.prepare('UPDATE sg_lotes SET bultos = 0, kg_reales = 0 WHERE id = 2').run();
  assert.equal(partir(db, { itemId: 1, loteId: 2, bultosMov: 0, kgMov: 0, nota: 'x' }), null);
  assert.equal(items(db).length, 1, 'creó un renglón vacío');
});

test('un renglón que no existe no rompe nada', () => {
  const db = camion();
  assert.equal(partir(db, { itemId: 99, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'x' }), null);
});

// ── 4 · SEPARAR POR CALIDAD LO HACE SOLO ───────────────────────────────────

test('reclasificar abre el renglón y lo deja apuntado', () => {
  // Apuntado: deshacer la separación tiene que saber qué renglón cerrar, sin adivinar.
  const i = SG.indexOf('function reclasificarLote(');
  const b = SG.slice(i, i + 8000);
  assert.match(b, /partirRenglonDeOrden\(db, \{ itemId: madre\.oc_item_id, loteId: nuevoId, kgMov/);
  assert.match(b, /motivo, piso_id, usuario_id, oc_item_creado\)/);
  assert.match(DB_SG, /ALTER TABLE sg_lote_reclasificaciones ADD COLUMN oc_item_creado INTEGER/);
});

test('una partida sin orden no intenta partir nada, y una DOCUMENTADA tampoco', () => {
  // Sin orden no hay renglón: llamar igual reventaría la recepción.
  //
  // Y con la orden ya facturada o liquidada el precio quedó firme: partir el renglón
  // ahí es tocar lo pactado por una puerta que no pide permiso. Es la misma regla que
  // ya tenía /renglon-propio — si no, separar un cajón por calidad hacía lo que darle
  // su renglón tiene prohibido. La separación por calidad se hace igual: es stock.
  const i = SG.indexOf('function reclasificarLote(');
  const b = SG.slice(i, i + 8000);
  assert.match(b, /const firme = ocDeMadre \? frenoPrecioFirme\(db, ocDeMadre, 'partirle el renglón'\) : null;/);
  assert.match(b, /const itemNuevo = \(madre\.oc_item_id && !firme\)/);
  assert.match(b, /: null;/);
});

test('y deshacer la separación también pide permiso', () => {
  // Si al renglón de la segunda le pusieron otro precio, deshacer devuelve esa
  // mercadería al renglón de la primera: la deuda vuelve al precio viejo. Era la
  // ÚNICA puerta que movía lo pactado sin pedirlo.
  const i = SG.indexOf("router.post('/lotes/:id/reclasificaciones/:rid/anular'");
  const b = SG.slice(i, i + 3000);
  assert.match(b, /frenoPrecioFirme\(db, ocDeMadre, 'deshacer la separación'\)/);
  assert.match(b, /if \(frenoF\) return res\.status\(409\)/);
});

test('y no se pasa a otra calidad lo que ya se tiró', () => {
  // La merma se anota contra el LOTE: al separar, los kilos se van al hermano y el
  // decomiso se queda. Si a la madre le quedan menos kilos de los que se le
  // decomisaron, la cuenta de lo que se le debe al productor trunca en cero y esos
  // kilos —que NO se le pagan— vuelven a la deuda.
  const i = SG.indexOf('function reclasificarLote(');
  const b = SG.slice(i, i + 3000);
  assert.match(b, /const kgTirados = r2\(kgDecomisado\(db, madre\.id\)\);/);
  assert.match(b, /if \(kgTirados > 0 && r2\(kgOrig - kgMov\) < kgTirados - 0\.01\)/);
  assert.match(b, /menos de lo que se tiró/);
});

test('y el decomiso guarda sus BULTOS, que era la raíz', () => {
  // La columna existía y nadie la escribía: bultosDecomisado() daba siempre cero y el
  // tope por bultos dejaba mover a otra calidad cajones ya tirados.
  const i = SG.indexOf("router.post('/lotes/:id/decomiso'");
  const b = SG.slice(i, i + 2600);
  // Desde el 2/9/2026 la merma tambien puede llevar foto: la lista de columnas
  // creció, pero  sigue ahí, que es lo que este test protege.
  assert.match(b, /INSERT INTO sg_lote_decomisos \(lote_id, kg, bultos, motivo, usuario_id,/);
  assert.match(b, /bultosDecomisados\(db, lote\.id, kg\), motivo/);
});

test('y un centavo de tolerancia es UN centavo', () => {
  // El importe se redondea POR RENGLÓN: la misma mercadería en dos renglones puede
  // dar un centavo distinto que en uno. Con «menos de un centavo», una liquidación
  // correcta dejaba de poder emitirse por haber partido el renglón.
  const AC = fs.readFileSync(path.join(RAIZ, 'src/servicios/sg_acordado.js'), 'utf8');
  assert.match(AC, /r2\(Math\.abs\(r2\(pagar\) - r2\(x\)\)\) <= 0\.01/);
});

// ── 5 · DESHACER CIERRA EL RENGLÓN ─────────────────────────────────────────

test('deshacer la separación devuelve lo pactado y borra el renglón', () => {
  // Dos renglones del mismo producto cuando ya no hay dos calidades es un renglón que
  // nadie sabe qué es.
  const i = SG.indexOf("router.post('/lotes/:id/reclasificaciones/:rid/anular'");
  const j = SG.indexOf('if (r.oc_item_creado', i);
  assert.ok(j > i, 'deshacer no cierra el renglón que se abrió');
  const b = SG.slice(j, j + 3200);
  assert.match(b, /cantidad_estimada_presentaciones = COALESCE\(cantidad_estimada_presentaciones,0\) \+ \?/);
  assert.match(b, /kg_estimados = ROUND\(COALESCE\(kg_estimados,0\) \+ \?, 2\)/);
  assert.match(b, /DELETE FROM sg_oc_items WHERE id=\?/);
  assert.match(b, /recalcTotalesOC/);
});

test('el lote dado de baja vuelve al renglón de la madre', () => {
  // Si quedara colgado del renglón que se abrió para él, ese renglón no se podría
  // cerrar y la orden quedaría con un renglón fantasma para siempre.
  const i = SG.indexOf("router.post('/lotes/:id/reclasificaciones/:rid/anular'");
  const b = SG.slice(i, i + 7200);
  assert.match(b, /eliminado_por_id=\?, oc_item_id=\? WHERE id=\?`\)\.run\(uid\(req\), madre\.oc_item_id, hijo\.id\)/);
});

test('lo pactado vuelve ENTERO a la madre, se pueda borrar el renglón o no', () => {
  // Devolverlo sólo cuando se puede borrar dejaba la orden pactada de menos; y
  // devolverlo y no poder borrar lo contaba DOS veces —la madre se lo quedaba y el
  // otro lo conservaba: la orden pasaba de 55 cajones pactados a 65—.
  //
  // Vuelve siempre, y el renglón que no se puede borrar queda VACÍO: sin pactado no
  // dispara el «entró distinto de lo que se había pedido» ni devuelve la orden a la
  // bandeja de pendientes de recibir.
  const i = SG.indexOf("router.post('/lotes/:id/reclasificaciones/:rid/anular'");
  const j = SG.indexOf('if (cre) {', i);
  assert.ok(j > i, 'la devolución sigue colgando de si se puede borrar');
  const b = SG.slice(j, j + 1800);
  assert.match(b, /cantidad_estimada_presentaciones = COALESCE\(cantidad_estimada_presentaciones,0\) \+ \?/);
  assert.match(b, /if \(!colgadosDeItem\(db, cre\.id\)\) \{/);
  assert.match(b, /DELETE FROM sg_oc_items WHERE id=\?/);
  assert.match(b, /SET cantidad_estimada_presentaciones = 0, kg_estimados = 0/);
  assert.match(b, /Renglón vacío: se deshizo la separación por calidad/);
});

test('y se pregunta por las CINCO tablas que apuntan a un renglón, no por dos', () => {
  // Con foreign_keys en ON, un DELETE que revienta se lleva puesta la anulación
  // entera: los kilos, los bultos, el costo, los gastos y la ubicación vuelven atrás
  // y el usuario recibe el texto crudo de SQLite.
  const i = SG.indexOf('function colgadosDeItem(db, itemId) {');
  assert.ok(i > 0, 'no existe la cuenta de lo que cuelga');
  const b = SG.slice(i, i + 1200);
  for (const t of ['sg_lotes', 'sg_despacho_items', 'sg_recepcion_fotos',
    'sg_recepcion_calidad', 'sg_reservas']) {
    assert.ok(b.includes('FROM ' + t + ' WHERE'), 'no mira ' + t);
  }
  assert.match(b, /origen_oc_item_id=\?/, 'sg_reservas apunta por dos columnas');
});

// ── 6 · LA PUERTA PARA LAS QUE YA ESTABAN SEPARADAS ────────────────────────

test('hay una puerta para las separaciones viejas, y pide lo mismo que siempre', () => {
  // La partida de Pablo ya estaba separada cuando esto se hizo: sin esta puerta, el
  // pedido no le sirve para la partida que lo motivó.
  const i = SG.indexOf("router.post('/lotes/:id/renglon-propio'");
  assert.ok(i > 0, 'no existe la puerta');
  const b = SG.slice(i, SG.indexOf('} catch (e)', i));
  assert.match(b, /requireAuth/, 'es trabajo del día, no de un administrador');
  // Con la orden ya documentada el precio quedó firme: misma regla que todo el resto.
  assert.match(b, /frenoPrecioFirme\(db, ocRow\.oc_id, 'darle su propio renglón'\)/);
  assert.match(b, /partirRenglonDeOrden\(db, \{ itemId: lote\.oc_item_id, loteId: lote\.id/);
  assert.match(b, /anotarEdicion\(db, \{ tabla: 'sg_lotes', registroId: lote\.id, campo: 'oc_item_id'/);
});

test('y no parte lo que ya está partido', () => {
  // Un renglón por lote no agrega nada y ensucia la orden.
  const i = SG.indexOf("router.post('/lotes/:id/renglon-propio'");
  const b = SG.slice(i, SG.indexOf('} catch (e)', i));
  assert.match(b, /const hermanos = db\.prepare\(`SELECT COUNT\(\*\) c FROM sg_lotes/);
  assert.match(b, /if \(!hermanos\) \{/);
  assert.match(b, /ya es la única de su renglón/);
});

test('la separación por calidad vieja queda apuntada al renglón nuevo', () => {
  // Para que deshacerla lo cierre, igual que las nuevas.
  const i = SG.indexOf("router.post('/lotes/:id/renglon-propio'");
  const b = SG.slice(i, SG.indexOf('} catch (e)', i));
  assert.match(b, /UPDATE sg_lote_reclasificaciones SET oc_item_creado=\?/);
  assert.match(b, /WHERE lote_destino_id=\? AND anulada_en IS NULL AND oc_item_creado IS NULL/);
});

// ── 7 · LA PANTALLA ────────────────────────────────────────────────────────

test('el modal dice cuándo la partida comparte renglón, y ofrece el suyo', () => {
  // Sin esto, alguien le corrige el precio, ve bajar el costo, y descubre al emitir la
  // liquidación que el sistema le exige el número viejo.
  assert.match(PANEL, /id="sg-loteed-renglon"/);
  const i = PANEL.indexOf('var comparten = (SG.ocVerLotes || []).filter(function(x){');
  assert.ok(i > 0, 'la pantalla no mira si el renglón es compartido');
  const b = PANEL.slice(i, i + 1400);
  assert.match(b, /String\(x\.oc_item_id\) === String\(l\.oc_item_id\)/);
  assert.match(b, /if \(comparten > 1\) \{/);
  assert.match(b, /comparte el renglón de la orden con otras/);
  assert.match(b, /sgLoteRenglonPropio\(\)/);
  // Y se limpia cuando no: el modal se reusa.
  assert.match(b, /\} else \{[\s\S]{0,160}rg\.style\.display = 'none'/);
});

test('y el botón avisa que el precio no se mueve al partir', () => {
  const i = PANEL.indexOf('function sgLoteRenglonPropio(){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 1200);
  assert.match(b, /lo que se le debe al productor no cambia/);
  assert.match(b, /'\/api\/sg\/lotes\/' \+ l\.id \+ '\/renglon-propio', 'POST'/);
  assert.match(b, /El precio se cambia desde la orden/);
});

test('y la pantalla de precios distingue los dos renglones del mismo producto', () => {
  // Sin esto son dos filas que dicen «Manzana» y el comprador no sabe a cuál bajarle
  // el precio — que es exactamente lo que el cambio vino a habilitar.
  assert.match(SG, /FROM sg_lotes l WHERE l\.oc_item_id=i\.id AND l\.activo=1\) AS calidades/);
  assert.match(SG, /AS lotes_codigos/);
  const i = PANEL.indexOf('function sgOcpRender(){');
  const b = PANEL.slice(i, i + 2200);
  assert.match(b, /var cal = String\(it\.calidades \|\| ''\)\.split\(','\)/);
  assert.match(b, /cal \? ' <b style="color:#92400e">· ' \+ esc\(cal\)/);
  assert.match(b, /it\.lotes_codigos \? ' · <code/);
});

test('y en un renglón MIXTO, el lote a granel también puede partirse', () => {
  // El camión que descarga 60 cajones y después 800 kg sueltos del mismo producto.
  // Mirando sólo si el RENGLÓN tiene bultos, el lote a granel daba proporción cero y
  // el sistema contestaba «no tiene bultos ni kilos con los que hacerlo».
  const db = camion();
  db.prepare('UPDATE sg_lotes SET bultos = NULL, kg_reales = 800 WHERE id = 2').run();  // a granel
  const antes = acordadoDeOC(db, 1).total;
  const nuevo = partir(db, { itemId: 1, loteId: 2, bultosMov: null, kgMov: 800, nota: 'granel' });
  assert.ok(nuevo, 'no partió el renglón del lote a granel');
  // 800 de 1.610 kg recibidos: la proporción sale de los KILOS, no de los cajones.
  assert.equal(item(db, nuevo).kg_estimados, Math.round(990 * (800 / 1610) * 100) / 100);
  // Y el invariante se sostiene igual.
  assert.equal(acordadoDeOC(db, 1).total, antes);
});

// ── 8 · EL INVARIANTE, EN LOS CASOS QUE NO SON EL NORMAL ───────────────────

const conLotes = (sql, opts) => {
  const db = camion(opts);
  db.prepare('DELETE FROM sg_lotes').run();
  db.prepare(sql).run();
  return db;
};

test('con TRES lotes, partir uno no mueve lo acordado', () => {
  const db = conLotes("INSERT INTO sg_lotes VALUES (1,1,360,20,'primera',1),(2,1,270,15,'primera',1),(3,1,180,10,'segunda',1)");
  const antes = acordadoDeOC(db, 1).total;
  partir(db, { itemId: 1, loteId: 3, bultosMov: 10, kgMov: 180, nota: 'x' });
  assert.equal(acordadoDeOC(db, 1).total, antes);
});

test('y DOS separaciones seguidas siguen dando lo mismo, con lo pactado entero', () => {
  // Es el caso que rompe cualquier reparto que no vuelva a medir contra lo que queda.
  const db = conLotes("INSERT INTO sg_lotes VALUES (1,1,540,30,'primera',1),(2,1,180,10,'segunda',1),(3,1,180,10,'tercera',1)");
  const antes = acordadoDeOC(db, 1).total;
  partir(db, { itemId: 1, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'x' });
  partir(db, { itemId: 1, loteId: 3, bultosMov: 10, kgMov: 180, nota: 'y' });
  assert.equal(acordadoDeOC(db, 1).total, antes);
  const todos = items(db);
  assert.equal(todos.length, 3);
  assert.equal(todos.reduce((s, x) => s + x.cantidad_estimada_presentaciones, 0), 55);
  assert.equal(Math.round(todos.reduce((s, x) => s + x.kg_estimados, 0) * 100) / 100, 990);
});

test('pactado por KILO: tampoco se mueve', () => {
  const db = camion();
  db.prepare("UPDATE sg_oc_items SET modo_carga='kilo' WHERE id=1").run();
  const antes = acordadoDeOC(db, 1).total;
  partir(db, { itemId: 1, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'x' });
  assert.equal(acordadoDeOC(db, 1).total, antes);
});

test('con kg_por_bulto NULL, el renglón nuevo hereda la PRESENTACIÓN', () => {
  // Las órdenes viejas tienen kg_por_bulto en NULL y el factor sale de la
  // presentación. Sin heredarla, acordadoDeOC le hace la cuenta por kilo al renglón
  // nuevo y por cajón al viejo: dos cuentas para la misma mercadería.
  const db = camion();
  db.prepare('INSERT INTO sg_presentaciones VALUES (3, 18)').run();
  db.prepare('UPDATE sg_oc_items SET kg_por_bulto=NULL WHERE id=1').run();
  const antes = acordadoDeOC(db, 1).total;
  const nuevo = partir(db, { itemId: 1, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'x' });
  assert.equal(item(db, nuevo).presentacion_id, 3);
  assert.equal(acordadoDeOC(db, 1).total, antes);
});

test('una partida de pizarra sin precio cerrado no rompe nada', () => {
  const db = camion();
  db.prepare('UPDATE sg_oc_items SET precio_estimado_por_kg=NULL WHERE id=1').run();
  const nuevo = partir(db, { itemId: 1, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'x' });
  assert.ok(nuevo);
  assert.equal(item(db, nuevo).precio_estimado_por_kg, null);
  assert.equal(acordadoDeOC(db, 1).total, 0);
});

test('y con la merma ya descontada, el invariante también', () => {
  const db = camion();
  db.prepare('INSERT INTO sg_lote_decomisos (lote_id, kg, bultos) VALUES (2, 36, 2)').run();
  const antes = acordadoDeOC(db, 1, { sinMermas: true }).total;
  partir(db, { itemId: 1, loteId: 2, bultosMov: 10, kgMov: 180, nota: 'x' });
  assert.equal(acordadoDeOC(db, 1, { sinMermas: true }).total, antes);
});

test('y el cartel de deshacer avisa que la deuda puede cambiar', () => {
  // Decía «los cajones vuelven con su costo». No decía que si tenían su propio
  // precio —el descuento que el productor reconoció por la segunda— vuelven al del
  // renglón de origen. Es plata, y el que aprieta tiene que saberlo antes.
  const i = PANEL.indexOf('function sgReclasAnular(loteId, rid){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 1200);
  assert.match(b, /vuelven al precio del /);
  assert.match(b, /lo que se le debe al productor cambia/);
});
