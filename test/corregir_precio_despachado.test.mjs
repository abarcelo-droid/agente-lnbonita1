// ══ EL FRENO DE «YA SE DESPACHÓ» ES DE CANTIDADES, NO DE PRECIO ════════════
//
// Pablo, 29/8/2026: «si le quiero cambiar el precio a una mercadería que tiene una
// subcategoría de segunda, no me deja. Entiendo que el motivo es porque ya se vendió
// y se despachó toda, PERO ESO NO TIENE NADA QUE VER CON QUE PUEDA CAMBIARLE EL
// PRECIO… la partida es a liquidar precio cerrado, debería poder cambiar el precio
// porque el proveedor me reconoció la mercadería en mal estado».
//
// Tenía razón, y el repo ya lo decía en otro lado: el endpoint que cambia el precio
// de la orden lleva escrito «NO se pide el freno de "ya se despachó": corregir el
// precio de una venta ya hecha es una cuestión de rentabilidad» (Pablo, 26/8/2026), y
// hay un test que PROHÍBE que ese endpoint tenga el freno. La corrección de la
// partida lo tenía, y el mensaje hasta lo delataba: decía «no se pueden corregir sus
// CANTIDADES» y bloqueaba todo.
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

// ── EL FRENO REAL, CORRIDO CONTRA UNA BASE ─────────────────────────────────
//
// No alcanza con mirar el fuente: la pregunta es qué CONTESTA. Se saca la función
// del router y se le da una base de mentira con las tablas que consulta.
function traerFreno() {
  const i = SG.indexOf('function frenosDeEdicionLote(db, loteId, opts) {');
  assert.ok(i > 0, 'no existe frenosDeEdicionLote con la opción');
  const src = SG.slice(i, SG.indexOf('\n}', i) + 2);
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  // precioFirmeDetalle vive en otro módulo y se inyecta: acá se prueban los frenos
  // de ESTE archivo, y el de la partida documentada ya tiene sus propios tests.
  // eslint-disable-next-line no-new-func
  return new Function('r2', 'precioFirmeDetalle',
    src + '; return frenosDeEdicionLote;')(r2, () => null);
}
const frenos = traerFreno();

function base(opts = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, kg_reales REAL, bultos REAL,
      kg_por_bulto REAL, presentacion_id INTEGER, transformado_de INTEGER,
      reproceso_id INTEGER, oc_item_id INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY, oc_id INTEGER);
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_despacho_items (id INTEGER PRIMARY KEY, despacho_id INTEGER,
      lote_id INTEGER, kg_despachados REAL, subtotal REAL, margen_estimado REAL);
    CREATE TABLE sg_transformaciones (id INTEGER PRIMARY KEY, lote_origen_id INTEGER,
      kg_transformados REAL);
    CREATE TABLE sg_reprocesos (id INTEGER PRIMARY KEY, lote_madre_id INTEGER, estado TEXT,
      kg_procesados REAL);
    CREATE TABLE sg_lote_reclasificaciones (id INTEGER PRIMARY KEY, lote_origen_id INTEGER,
      lote_destino_id INTEGER, anulada_en TEXT);
    CREATE TABLE sg_lote_decomisos (id INTEGER PRIMARY KEY, lote_id INTEGER, kg REAL);
  `);
  db.prepare('INSERT INTO sg_oc_items VALUES (1, 7)').run();
  db.prepare(`INSERT INTO sg_lotes (id, kg_reales, bultos, oc_item_id, transformado_de, reproceso_id)
    VALUES (1, ?, ?, ?, ?, ?)`).run(
    opts.kg != null ? opts.kg : 810, opts.bultos != null ? opts.bultos : 45,
    opts.sinOc ? null : 1, opts.transformado_de || null, opts.reproceso_id || null);
  if (opts.despachado) {
    db.prepare('INSERT INTO sg_despachos (id, activo) VALUES (9, 1)').run();
    db.prepare(`INSERT INTO sg_despacho_items (despacho_id, lote_id, kg_despachados, subtotal, margen_estimado)
      VALUES (9, 1, ?, ?, ?)`).run(opts.despachado, opts.subtotal || 0, opts.margen || 0);
  }
  if (opts.separada) {
    db.prepare(`INSERT INTO sg_lote_reclasificaciones (lote_origen_id, lote_destino_id, anulada_en)
      VALUES (1, 2, NULL)`).run();
  }
  if (opts.dioCosto === 'transformacion') {
    db.prepare('INSERT INTO sg_transformaciones (lote_origen_id, kg_transformados) VALUES (1, 100)').run();
  }
  if (opts.dioCosto === 'reproceso') {
    db.prepare("INSERT INTO sg_reprocesos (lote_madre_id, estado) VALUES (1, 'activo')").run();
  }
  return db;
}

// ── 1 · EL CASO QUE TRAJO PABLO ────────────────────────────────────────────

test('la mercadería de segunda ya despachada: el precio SÍ se corrige', () => {
  // Es la partida de la foto: separada por calidad y con todo despachado. Antes
  // rebotaba con «ya se despacharon 180 kg» y no dejaba tocar nada.
  const db = base({ despachado: 180, separada: true });
  const solo = frenos(db, 1, { soloPrecio: true });
  assert.equal(solo.error, undefined, 'sigue frenando una corrección de precio: ' + solo.error);
  assert.equal(solo.ok, true);
});

test('pero los KILOS de esa misma partida siguen trabados', () => {
  // El stock ya salió con ese número, y los dos lotes tienen que seguir sumando lo
  // que entró. Eso no cambió.
  const db = base({ despachado: 180, separada: true });
  const cant = frenos(db, 1, { soloPrecio: false });
  assert.match(cant.error, /ya se despacharon 180 kg/);
});

test('y sin la opción se comporta como siempre: frena todo', () => {
  // Es lo que necesita DELETE —eliminar un lote es la mayor corrección de
  // cantidad— y es el default seguro para cualquier llamador nuevo.
  const db = base({ despachado: 180 });
  assert.match(frenos(db, 1).error, /ya se despacharon/);
});

test('el mensaje deja de mentir: decía «cantidades» y bloqueaba todo', () => {
  const db = base({ despachado: 180 });
  const e = frenos(db, 1, { soloPrecio: false }).error;
  assert.match(e, /No se pueden corregir sus cantidades/);
  assert.match(e, /El precio sí se puede corregir/);
});

// ── 2 · LOS DOS FRENOS DE CANTIDAD ─────────────────────────────────────────

test('sólo despachada: precio sí, kilos no', () => {
  const db = base({ despachado: 180 });
  assert.equal(frenos(db, 1, { soloPrecio: true }).ok, true);
  assert.match(frenos(db, 1, { soloPrecio: false }).error, /despacharon/);
});

test('sólo separada por calidad: precio sí, kilos no', () => {
  // Y acá está el motivo de fondo: la mercadería de segunda es justamente la que se
  // renegocia con el productor.
  const db = base({ separada: true });
  assert.equal(frenos(db, 1, { soloPrecio: true }).ok, true);
  const e = frenos(db, 1, { soloPrecio: false }).error;
  assert.match(e, /se separó por calidad/);
  assert.match(e, /El precio sí se puede corregir/);
});

test('el lote DESTINO de la separación también, no sólo el origen', () => {
  // El freno mira los dos lados. El de segunda es el destino: si sólo se hubiera
  // liberado el origen, el caso de Pablo seguía trabado.
  const db = base({});
  db.prepare(`INSERT INTO sg_lote_reclasificaciones (lote_origen_id, lote_destino_id, anulada_en)
    VALUES (5, 1, NULL)`).run();
  assert.equal(frenos(db, 1, { soloPrecio: true }).ok, true);
  assert.match(frenos(db, 1, { soloPrecio: false }).error, /se separó por calidad/);
});

test('una separación ANULADA no frena nada', () => {
  const db = base({});
  db.prepare(`INSERT INTO sg_lote_reclasificaciones (lote_origen_id, lote_destino_id, anulada_en)
    VALUES (1, 2, '2026-08-29')`).run();
  assert.equal(frenos(db, 1, { soloPrecio: false }).ok, true);
});

// ── 3 · LOS QUE SIGUEN FRENANDO EL PRECIO ──────────────────────────────────

test('el lote cuyo costo ya viajó NO se reprecia, ni siquiera sólo el precio', () => {
  // sg_transformaciones.costo_transferido es un snapshot congelado que recalcCostoLote
  // le resta al padre para siempre. Cambiarle el costo_base deja al padre inflado y al
  // hijo de menos: el total cierra y la distribución queda mal en los dos lados.
  for (const via of ['transformacion', 'reproceso']) {
    const db = base({ dioCosto: via });
    assert.match(frenos(db, 1, { soloPrecio: true }).error,
      /salió mercadería a una transformación o un reproceso/, via);
  }
});

test('y el lote que VINO de una transformación, menos todavía', () => {
  // Su costo no sale de un precio: recalcCostoLote toma la rama de transformado_de y
  // usa el snapshot de costo_base. Como los hijos se insertan SIEMPRE con precio en
  // NULL, corregirlo escribiría costo_base = kilos × nada y borraría el costo heredado.
  for (const campo of ['transformado_de', 'reproceso_id']) {
    const db = base({ [campo]: 5 });
    assert.match(frenos(db, 1, { soloPrecio: true }).error,
      /vino de una transformación o un reproceso/, campo);
  }
});

test('un reproceso ya anulado no frena', () => {
  const db = base({});
  db.prepare("INSERT INTO sg_reprocesos (lote_madre_id, estado) VALUES (1, 'anulado')").run();
  assert.equal(frenos(db, 1, { soloPrecio: true }).ok, true);
});

test('la partida DOCUMENTADA frena las dos cosas — la regla no se aflojó', () => {
  // Pablo, 26/8/2026: «una vez que se perfecciona la orden con una FACTURA o una
  // LIQUIDACIÓN, ese precio queda FIRME». Ése es el freno que sí tiene que alcanzar
  // al precio, y es el único.
  const i = SG.indexOf('function frenosDeEdicionLote(db, loteId, opts) {');
  const b = SG.slice(i, i + 6200);
  const doc = b.indexOf('precioFirmeDetalle(db, l.oc_id');
  const desp = b.indexOf('if (desp > 0 && !soloPrecio)');
  assert.ok(doc > 0 && desp > doc, 'el freno del comprobante tiene que ir primero');
  assert.ok(!/soloPrecio/.test(b.slice(doc - 400, doc + 300)),
    'el freno de la partida documentada quedó condicionado a soloPrecio');
});

// ── 4 · EL ENDPOINT DECIDE MIRANDO LO QUE CAMBIA DE VERDAD ─────────────────

test('«sólo precio» se mide contra el lote, no contra si el campo vino', () => {
  // La pantalla manda SIEMPRE los cuatro campos —un input deshabilitado igual tiene
  // valor y el payload se arma a mano—, así que «vino el kilo» no significa «cambió
  // el kilo». Mirando la presencia, ninguna corrección sería nunca «sólo precio».
  const i = SG.indexOf("router.put('/lotes/:id/corregir'");
  const b = SG.slice(i, i + 2600);
  assert.match(b, /const cambiaCantidades =/);
  assert.match(b, /Math\.abs\(r2\(pedKg\) - r2\(prev\.kg_reales\)\) > 0\.001/);
  assert.match(b, /pedBultos != null && pedBultos !== prevBultos/);
  assert.match(b, /frenosDeEdicionLote\(db, req\.params\.id, \{ soloPrecio: !cambiaCantidades \}\)/);
});

test('la CALIDAD cuenta como cantidad: mueve mercadería de categoría', () => {
  const i = SG.indexOf("router.put('/lotes/:id/corregir'");
  const b = SG.slice(i, i + 2600);
  assert.match(b, /b\.calidad !== undefined && txt\(val\(b\.calidad\)\) !== txt\(prev\.calidad\)/);
});

test('el lote se lee ANTES del freno, o no habría con qué comparar', () => {
  const i = SG.indexOf("router.put('/lotes/:id/corregir'");
  const b = SG.slice(i, i + 2600);
  assert.ok(b.indexOf('const prev = db.prepare') < b.indexOf('frenosDeEdicionLote(db, req.params.id'));
  assert.match(b, /SELECT \* FROM sg_lotes WHERE id=\? AND activo=1/);
});

test('y DELETE sigue pidiendo los frenos enteros', () => {
  // Eliminar un lote es la mayor de las correcciones de cantidad.
  const i = SG.indexOf("router.delete('/lotes/:id'");
  const b = SG.slice(i, i + 900);
  assert.match(b, /frenosDeEdicionLote\(db, req\.params\.id\)/);
  assert.ok(!/soloPrecio/.test(b), 'DELETE quedó pasando la opción');
});

// ── 5 · EL ÚNICO NÚMERO QUE QUEDABA CONGELADO ──────────────────────────────

test('el margen guardado del remito se rehace con el costo nuevo', () => {
  // sg_despacho_items.margen_estimado es una foto sacada al emitir el remito. Los
  // informes recalculan (MARGEN_LINEA) pero la ficha del remito lee la foto: sin
  // esto, el mismo remito mostraba un margen en su ficha y otro en el informe.
  assert.match(SG, /function recalcMargenDespachos\(db, loteId\) \{/);
  const i = SG.indexOf('function recalcMargenDespachos(db, loteId) {');
  const b = SG.slice(i, i + 1200);
  assert.match(b, /UPDATE sg_despacho_items/);
  // Con la MISMA cuenta que el alta del remito: kilos VIGENTES, no kg_reales.
  assert.match(b, /SUM\(kg\) FROM sg_lote_decomisos WHERE lote_id = l\.id/);
  assert.match(b, /SUM\(kg_transformados\) FROM sg_transformaciones/);
});

test('y se rehace DESPUÉS de recalcular el costo, no antes', () => {
  const i = SG.indexOf("router.put('/lotes/:id/corregir'");
  const costo = SG.indexOf('recalcCostoLote(db, prev.id)', i);
  const margen = SG.indexOf('recalcMargenDespachos(db, prev.id)', i);
  assert.ok(costo > i, 'no recalcula el costo');
  assert.ok(margen > costo, 'rehace el margen antes de recalcular el costo: lee el viejo');
});

test('la cuenta del margen corre y da', () => {
  // 810 kg a $1.000 = costo_final 810.000. Se despacharon 180 kg por $300.000.
  // Margen = 300.000 − 180 × (810.000/810) = 300.000 − 180.000 = 120.000.
  const i = SG.indexOf('function recalcMargenDespachos(db, loteId) {');
  const src = SG.slice(i, SG.indexOf('\n}', i) + 2);
  // eslint-disable-next-line no-new-func
  const recalc = new Function(src + '; return recalcMargenDespachos;')();
  const db = base({ despachado: 180, subtotal: 300000, margen: 999 });
  db.exec('ALTER TABLE sg_lotes ADD COLUMN costo_final REAL');
  db.prepare('UPDATE sg_lotes SET costo_final = 810000 WHERE id = 1').run();
  recalc(db, 1);
  assert.equal(db.prepare('SELECT margen_estimado m FROM sg_despacho_items WHERE lote_id=1').get().m,
    120000);
});

test('y con la partida mermada usa los kilos VIGENTES, no los que entraron', () => {
  // Es la diferencia con el auto-arreglo del arranque, que divide por kg_reales: la
  // merma concentra el costo en lo que queda, y ésa es la cuenta que hizo el remito.
  const i = SG.indexOf('function recalcMargenDespachos(db, loteId) {');
  const src = SG.slice(i, SG.indexOf('\n}', i) + 2);
  // eslint-disable-next-line no-new-func
  const recalc = new Function(src + '; return recalcMargenDespachos;')();
  const db = base({ despachado: 180, subtotal: 300000 });
  db.exec('ALTER TABLE sg_lotes ADD COLUMN costo_final REAL');
  db.prepare('UPDATE sg_lotes SET costo_final = 810000 WHERE id = 1').run();
  db.prepare('INSERT INTO sg_lote_decomisos (lote_id, kg) VALUES (1, 10)').run();
  recalc(db, 1);
  // vigentes = 810 − 10 = 800 → costo/kg = 1.012,50 → margen = 300.000 − 182.250
  assert.equal(db.prepare('SELECT margen_estimado m FROM sg_despacho_items WHERE lote_id=1').get().m,
    117750);
});

// ── 6 · LA PANTALLA LO DICE ANTES ──────────────────────────────────────────

test('el modal apaga los kilos y explica que el precio sí va', () => {
  // Descubrirlo con un error después de tipear es peor: el que lo ve cree que la
  // pantalla está rota.
  assert.match(PANEL, /id="sg-loteed-cant-nota"/);
  const i = PANEL.indexOf('var despK = Math.round(Math.max(0,');
  assert.ok(i > 0, 'la pantalla no calcula lo despachado');
  const b = PANEL.slice(i, i + 1500);
  assert.match(b, /\(Number\(l\.kg_vigente\) \|\| 0\) - \(Number\(l\.kg_disponibles\) \|\| 0\)/);
  assert.match(b, /Number\(l\.bultos_reclasificados\) > 0 \|\| l\.reclasificado_de_codigo/);
  // Y el candado cuelga de que HAYA un motivo, no está suelto: sin esta condición el
  // bloque se puede desactivar sin que se note.
  assert.match(b, /if \(motivos\.length\) \{[\s\S]{0,120}kge\.disabled = true/);
  assert.match(b, /<b>El precio sí<\/b>/);
});

test('y si no hay nada que trabe, los campos vuelven a estar', () => {
  // El modal se reusa: dejar el candado de la partida anterior sería peor que no
  // ponerlo nunca.
  const i = PANEL.indexOf('var despK = Math.round(Math.max(0,');
  const b = PANEL.slice(i, i + 1500);
  assert.match(b, /\} else \{[\s\S]{0,200}bte\.disabled = false/);
  assert.match(b, /cnota\.style\.display = 'none'/);
});

test('y el factor kg/bulto NO se rehace en una corrección de sólo precio', () => {
  // El factor existe para que corregir el PESO no rompa la correspondencia con los
  // bultos —el despacho pasa de cajones a kilos con él—. Reescribirlo sin peso nuevo
  // mueve un número de cantidad en una partida que quizá ya despachó.
  const i = SG.indexOf('let kpbNuevo = null;');
  assert.ok(i > 0);
  assert.match(SG.slice(i, i + 260), /if \(cambiaCantidades && nuevo\.bultos > 0 && kpb > 0/);
});

// ── 7 · LO QUE LA CORRECCIÓN NO PUEDE ARREGLAR SOLA ────────────────────────

test('si el cronograma no se pudo rehacer, la corrección lo dice', () => {
  // generarVencimientos se corta cuando la orden ya tiene una cuota PAGADA: no puede
  // borrar y rehacer algo contra lo que ya salió plata. La deuda queda con el importe
  // viejo, y hay que arreglarla a mano.
  //
  // Ahora que se puede corregir el precio de una partida YA DESPACHADA, el caso es
  // mucho más probable: una partida despachada es una partida vieja.
  const i = SG.indexOf("router.put('/lotes/:id/corregir'");
  const j = SG.indexOf('const cuotasPagas', i);
  assert.ok(j > i, 'la corrección no mira si quedaron cuotas pagadas');
  const b = SG.slice(j, j + 700);
  assert.match(b, /FROM sg_oc_vencimientos WHERE oc_id=\? AND pagado=1/);
  assert.match(b, /aviso: cuotasPagas > 0[\s\S]{0,20}\? AVISO_CRONOGRAMA_CONGELADO/);
  // LAS MISMAS PALABRAS EN LAS TRES PUERTAS que mueven ese número: cambiar el precio
  // de la orden, completarla, y corregir una partida. El mismo problema contado
  // distinto en tres pantallas son tres problemas — así que el texto vive una vez.
  assert.equal(SG.split('cronograma de vencimientos no se ').length - 1, 1,
    'el aviso volvió a estar copiado');
  assert.equal(SG.split('AVISO_CRONOGRAMA_CONGELADO').length - 1, 4,
    'la constante y sus tres usos');
});

test('y el aviso se ve, no se va solo', () => {
  // Exige ir a otra pantalla: un toast que desaparece a los tres segundos no alcanza.
  const i = PANEL.indexOf("toast('Corregido — queda registrado quién y qué cambió', 'ok');");
  assert.ok(i > 0);
  assert.match(PANEL.slice(i, i + 600), /if \(r\.aviso\) alert\(r\.aviso\);/);
});

test('y el cartel dice los kilos con decimales, no «0 kg»', () => {
  // nr() redondea a entero: una partida con 0,4 kg despachados diría «ya salieron
  // 0 kg», que se lee como que no salió nada y el candado no se entiende.
  const i = PANEL.indexOf("motivos.push('ya salieron <b>'");
  assert.ok(i > 0);
  assert.match(PANEL.slice(i, i + 300), /toLocaleString\('es-AR', \{ maximumFractionDigits: 2 \}\)/);
});

// ── 8 · EL PRECIO, QUE ES LO QUE ESTE CAMBIO ABRE ──────────────────────────

test('un precio en CERO o en NEGATIVO no entra', () => {
  // Mientras el freno de «ya se despachó» tapaba todo, esto era inalcanzable en una
  // partida vendida. Ahora es el camino principal: un menos delante del número dejaba
  // la deuda con el productor en negativo —pasaba a deberle plata a la empresa—
  // porque generarVencimientos reparte SUM(costo_base) = kilos × precio.
  //
  // Los dos endpoints hermanos ya validaban; éste era el único sin nada.
  const i = SG.indexOf("router.put('/lotes/:id/corregir'");
  const j = SG.indexOf('const pedPrecio', i);
  assert.ok(j > i, 'la corrección no valida el precio');
  const b = SG.slice(j, j + 1200);
  assert.match(b, /!\(pedPrecio > 0\)/);
  assert.match(b, /al productor sale al revés/);
});

test('y VACÍO no es cero: es «no lo mandé»', () => {
  // La pantalla manda el campo siempre, y a quien no puede ver costos el filtro se lo
  // borra de la respuesta: abriría el modal con el precio en blanco y al guardar se lo
  // borraría a la partida. Con el precio en null, generarVencimientos ni siquiera
  // genera el cronograma.
  const i = SG.indexOf('const pedPrecio', SG.indexOf("router.put('/lotes/:id/corregir'"));
  const b = SG.slice(i, i + 1800);
  assert.match(b, /b\.precio_unitario_kg === undefined \|\| b\.precio_unitario_kg === null/);
  assert.match(b, /precio_unitario_kg: pedPrecio != null \? pedPrecio : prev\.precio_unitario_kg/);
});

test('lo que no cambia, no se escribe', () => {
  // El detector compara redondeado a dos decimales y el escritor no redondeaba:
  // 810,004 contra 810 daba «no cambió nada» —el freno de despacho no corría— y el
  // UPDATE escribía 810,004 igual. Detector y escritor tienen que mirar lo mismo.
  const i = SG.indexOf("router.put('/lotes/:id/corregir'");
  const b = SG.slice(i, SG.indexOf('if (!(nuevo.kg_reales > 0))', i) + 60);
  assert.match(b, /kg_reales: \(cambiaCantidades && numF\(b\.kg_reales\) != null\)/);
  assert.match(b, /calidad: \(cambiaCantidades && b\.calidad !== undefined\)/);
});

test('y la pantalla no ofrece un precio que va a rebotar', () => {
  const i = PANEL.indexOf('id="sg-loteed-precio"');
  assert.ok(i > 0);
  assert.match(PANEL.slice(i - 120, i + 60), /min="0\.01"/);
});

// ── 9 · LO QUE EL PRECIO PROPIO DE UNA PARTIDA DESTAPA ─────────────────────

test('pisar el precio del renglón queda escrito EN EL LOTE', () => {
  // aplicarPrecioItem pisa el precio de TODOS los lotes del ítem con uno solo. Era
  // inocuo mientras dos hermanos no podían tener precios distintos; desde que se
  // puede corregir el de una partida separada por calidad, sí pueden — y este UPDATE
  // le devuelve al de segunda el precio del de primera.
  //
  // No se frena (el renglón es lo pactado), pero se anota donde se lo va a buscar:
  // antes sólo quedaba registrado sobre sg_oc_items.
  const i = SG.indexOf('function aplicarPrecioItem(');
  const b = SG.slice(i, i + 2400);
  assert.match(b, /anotarEdicion\(db, \{ tabla: 'sg_lotes', registroId: l\.id, campo: 'precio_unitario_kg'/);
  assert.match(b, /antes: l\.precio_unitario_kg, despues: neto/);
  assert.match(b, /recalcMargenDespachos\(db, Number\(l\.id\)\)/);
});

test('y el arreglo del arranque deja de pisar el margen con otra cuenta', () => {
  // El backfill de db_sg.js dividía por kg_reales y el remito divide por los kilos
  // VIGENTES: en toda partida con merma escribía un margen distinto del que había
  // escrito el remito, y lo reescribía en cada arranque. Sin esto, la corrección del
  // precio arreglaba el margen y el próximo deploy se lo volvía a romper.
  const DB = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');
  const i = DB.indexOf('const MARGEN_COSTO_KG');
  assert.ok(i > 0, 'el backfill sigue con su propia cuenta');
  const b = DB.slice(i, i + 700);
  assert.match(b, /SUM\(kg\) FROM sg_lote_decomisos WHERE lote_id = l\.id/);
  assert.match(b, /SUM\(kg_transformados\) FROM sg_transformaciones/);
  assert.ok(!/NULLIF\(l\.kg_reales,0\)/.test(DB.slice(i, i + 1400)),
    'quedó la división por kg_reales');
});
