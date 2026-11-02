// ══ ❓ EL MANUAL DE FINCAS Y LOTES DICE LA VERDAD ═══════════════════════════
//
// CLAUDE.md: «el manual se prueba contra el código, no contra sí mismo. Un test
// que sólo verifica que el texto existe no sirve para nada: lo que hay que
// clavar es que lo que el manual AFIRMA sigue siendo cierto».
//
// Así que cada afirmación de abajo tiene al lado su assert contra el código que
// la cumple. Si alguien cambia la regla y no el manual, esto se pone rojo — que
// es lo único que impide que el manual vaya una versión atrás, y un manual una
// versión atrás es peor que no tenerlo: el operador hace lo que dice y le sale
// mal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  noProduce, esProductivo, marcarNoProduce, lotesDeTemporada,
} from '../src/servicios/lotesProductivos.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
const PANEL = leer('src/panel.html');
const DBPA = leer('src/servicios/db_pa.js');
const RUTAS = leer('src/rutas/produccion.js');

// El manual, ejecutado y no grepeado: lo que se verifica es el HTML que ve el
// operador, no el código fuente que lo arma.
const MANUAL = (() => {
  const i = PANEL.indexOf("SG_MANUAL['pa-lotes'] = { titulo:");
  assert.ok(i > 0, 'Fincas y Lotes se quedó sin manual');
  const f = PANEL.indexOf('\n};', i);
  assert.ok(f > i, 'el manual de pa-lotes no cierra');
  const reg = {};
  // eslint-disable-next-line no-new-func
  new Function('SG_MANUAL', PANEL.slice(i, f + 3))(reg);
  return reg['pa-lotes'];
})();
const dice = (t2) => assert.ok(MANUAL.html.includes(t2),
  'el manual ya no dice: «' + t2 + '»');

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_campañas (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT,
      tipo TEXT, activa INTEGER DEFAULT 0);
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
      hectareas REAL, año_plantacion INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY AUTOINCREMENT,
      lote_id INTEGER NOT NULL, campaña TEXT NOT NULL, cultivo TEXT,
      en_desarrollo INTEGER DEFAULT 0, productividad_pct INTEGER,
      UNIQUE(lote_id, campaña));
  `);
  db.prepare("INSERT INTO pa_campañas (nombre,tipo,activa) VALUES ('2026/27','anual',1)").run();
  db.prepare("INSERT INTO pa_lotes (id,nombre,finca,activo) VALUES (41,'41 Nuevo','PC',1)").run();
  return db;
}

// ── El botón, que es por dónde se llega ─────────────────────────────────────
test('la pantalla de Lotes tiene su botón ¿Cómo se usa?', () => {
  // Un manual al que no se llega es un manual que no existe.
  assert.ok(PANEL.includes("sgManualAbrir('pa-lotes')"),
    'el botón del manual desapareció del encabezado de Fincas y Lotes');
  assert.equal(MANUAL.titulo, 'Fincas y Lotes');
});

test('el manual lleva su número de versión', () => {
  // La regla de CLAUDE.md: el V### al lado, para que se vea qué cambió y desde
  // cuándo sin leer un commit.
  assert.match(MANUAL.html, /V1132/);
  assert.match(MANUAL.html, /class="mv">V\d+/, 'falta la etiqueta de versión');
});

// ── «Todavía no produce es el único que manda el gasto a INVERSIÓN» ─────────
test('AFIRMA: sólo «todavía no produce» activa el gasto', () => {
  dice('es el único que manda el gasto a <b>INVERSIÓN</b>');
  // Produce → no activa. Parcial → no activa. Sólo el 0 explícito activa.
  assert.equal(noProduce({ en_desarrollo: 0, productividad_pct: null }), false);
  assert.equal(noProduce({ en_desarrollo: 1, productividad_pct: 60 }), false);
  assert.equal(noProduce({ en_desarrollo: 1, productividad_pct: 0 }), true);
});

test('AFIRMA: un lote que produce parcialmente sigue siendo costo de producción', () => {
  dice('<b>El gasto sigue siendo de producción:</b> ');
  const db = base();
  db.prepare("INSERT INTO pa_cultivos_lote (lote_id,campaña,cultivo)"
    + " VALUES (41,'2026/27','Damasco')").run();
  const r = marcarNoProduce(db, 41, '2026/27', true, 60);
  assert.equal(r.a_inversion, 0);
  assert.equal(esProductivo(db, 41, '2026/27'), true);
});

test('AFIRMA: se carga el % respecto de un lote maduro, y se guarda', () => {
  dice('% esperado respecto de un lote maduro');
  const db = base();
  db.prepare("INSERT INTO pa_cultivos_lote (lote_id,campaña,cultivo)"
    + " VALUES (41,'2026/27','Damasco')").run();
  assert.equal(marcarNoProduce(db, 41, '2026/27', true, 45).productividad_pct, 45);
});

// ── «Vale de ahora en más, no para atrás» ───────────────────────────────────
test('AFIRMA: marcar un lote no mueve los gastos ya cargados', () => {
  dice('<b>no mueve los gastos que ya estaban cargados</b>');
  /* Lo que lo garantiza es que el trigger es AFTER INSERT y nada más: no hay un
     UPDATE que recorra pa_costos_lote cuando cambia la marca. Si alguien
     agregara uno, este assert cae. */
  assert.ok(DBPA.includes('CREATE TRIGGER pa_costo_a_inversion AFTER INSERT ON pa_costos_lote'),
    'el trigger ya no es AFTER INSERT: puede estar reescribiendo el pasado');
  assert.ok(!/AFTER UPDATE ON pa_cultivos_lote/.test(DBPA),
    'apareció un trigger sobre pa_cultivos_lote: estaría moviendo costos viejos');
  // Y la ruta que marca no toca pa_costos_lote.
  const i = RUTAS.indexOf("router.post('/lotes/:id/productividad'");
  const fin = RUTAS.indexOf('});', RUTAS.indexOf('} catch', i));
  assert.ok(!RUTAS.slice(i, fin).includes('pa_costos_lote'),
    'la ruta que marca el lote ahora escribe en pa_costos_lote');
});

test('AFIRMA: el destino se escribe en cada costo cuando se carga', () => {
  dice('se escribe en cada costo cuando se carga y ahí queda');
  // La columna existe y su default es 0: se guarda en el costo, no se deduce.
  assert.ok(DBPA.includes("ALTER TABLE pa_costos_lote ADD COLUMN a_inversion"
    + " INTEGER NOT NULL DEFAULT 0"), 'a_inversion ya no se guarda en el costo');
});

// ── «Un lote sin cultivo cargado no se puede marcar» ────────────────────────
test('AFIRMA: sin cultivo no se marca, pero el lote APARECE', () => {
  dice('Aparece en la lista, para que se vea que falta, pero sin el selector');
  const db = base();
  // Sin fila de cultivo: no se puede marcar...
  const r = marcarNoProduce(db, 41, '2026/27', false);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no tiene cultivo cargado/);
  // ...y aun así aparece en la lista, marcado como que falta.
  const ls = lotesDeTemporada(db, '2026/27');
  assert.equal(ls.length, 1);
  assert.equal(ls[0].sin_cultivo, 1);
  // Y la pantalla no le pone select.
  assert.ok(PANEL.includes("cargá el cultivo primero"),
    'la pantalla ya no avisa que falta el cultivo');
});

// ── «Si nadie marcó nada, todo imputa a producción» ─────────────────────────
test('AFIRMA: falta de dato nunca significa «no produce»', () => {
  dice('<b>Falta de dato nunca ');
  const db = base();
  db.prepare("INSERT INTO pa_cultivos_lote (lote_id,campaña,cultivo)"
    + " VALUES (41,'2026/27','Damasco')").run();
  assert.equal(esProductivo(db, 41, '2026/27'), true, 'sin marca');
  db.prepare("UPDATE pa_cultivos_lote SET en_desarrollo=1, productividad_pct=NULL").run();
  assert.equal(esProductivo(db, 41, '2026/27'), true, 'en desarrollo sin %');
});

// ── «La categoría no cambia» ────────────────────────────────────────────────
test('AFIRMA: la categoría del costo no la toca nadie', () => {
  dice('La <b>categoría no cambia</b>');
  /* Lo garantiza que el trigger sólo escribe a_inversion. Si algún día tocara
     categoria, el manual estaría mintiendo y este assert cae. */
  const i = DBPA.indexOf('CREATE TRIGGER pa_costo_a_inversion');
  const fin = DBPA.indexOf('END;', i);
  const cuerpo = DBPA.slice(i, fin);
  assert.ok(cuerpo.includes('SET a_inversion = 1'));
  assert.ok(!cuerpo.includes('categoria ='),
    'el trigger ahora también cambia la categoría del costo');
  // Y el CHECK de categoria no ganó un valor nuevo: el qué y el dónde siguen
  // siendo dos dimensiones.
  assert.ok(!/categoria[^)]*'inversion'/i.test(DBPA),
    'inversion se coló dentro de las categorías: perdería el qué se gastó');
});

// ── «Lo mismo se puede marcar desde la ficha del lote» ──────────────────────
test('AFIRMA: la ficha y la pantalla escriben EL MISMO dato', () => {
  dice('Es el mismo dato: lo que se cambia en un lado se ve en el ');
  /* Las dos escriben en_desarrollo + productividad_pct de pa_cultivos_lote. Si
     alguien agregara una columna `productivo` aparte, serían dos campos con el
     mismo significado y el manual mentiría. */
  assert.ok(!/ADD COLUMN productivo\b/.test(DBPA),
    'apareció una columna productivo aparte: ya son dos campos para lo mismo');
  // La ficha manda en_desarrollo/productividad_pct a /lotes/cultivo...
  assert.ok(PANEL.includes('en_desarrollo:cd.en_desarrollo'),
    'la ficha ya no manda en_desarrollo');
  assert.ok(RUTAS.includes('en_desarrollo=excluded.en_desarrollo'),
    '/lotes/cultivo ya no guarda en_desarrollo');
  // ...y la pantalla, a /lotes/:id/productividad.
  assert.ok(RUTAS.includes("router.post('/lotes/:id/productividad'"));
});

test('AFIRMA: el casillero de la ficha se llama «En desarrollo»', () => {
  dice('<b>🌱 En desarrollo</b>');
  assert.ok(PANEL.includes('🌱 En desarrollo (no productivo al 100%)'),
    'el casillero de la ficha cambió de nombre y el manual quedó viejo');
});

// ── «El gasto activado imputa al rubro INVERSION» ───────────────────────────
test('AFIRMA: imputa a INVERSION, y la pantalla avisa si no está', () => {
  dice('imputa al rubro <b>INVERSION</b>');
  dice('la pantalla lo avisa arriba');
  // Se busca por NOMBRE, no por un id escrito a mano.
  const SRV = leer('src/servicios/lotesProductivos.js');
  assert.ok(SRV.includes("pa_rubros_contables WHERE nombre = ?"),
    'rubroInversion dejó de buscar por nombre');
  assert.ok(SRV.includes("'INVERSION'"));
  // Y la ruta lo devuelve para que la pantalla pueda avisar.
  assert.ok(RUTAS.includes('rubro: rubroInversion(db)'));
  assert.ok(PANEL.includes('No existe el rubro INVERSION en el plan'));
});

// ── «Tres vistas» ──────────────────────────────────────────────────────────
test('AFIRMA: son tres vistas, y las tres existen', () => {
  dice('<b>📋 Tabla</b> es la lista');
  dice('<b>🌱 Productividad</b> es nuevo');
  assert.ok(PANEL.includes("var PA_LOT_VISTAS = ['tabla','mapa','prod'];"),
    'la lista de vistas cambió');
  for (const v of ['tabla', 'mapa', 'prod']) {
    assert.ok(PANEL.includes('id="pa-lot-vista-' + v + '-cont"'),
      'falta el contenedor de la vista ' + v);
    assert.ok(PANEL.includes('id="pa-lot-vista-' + v + '"'),
      'falta el botón de la vista ' + v);
  }
});

// ── «Cuatro números arriba» ─────────────────────────────────────────────────
test('AFIRMA: los cuatro números de arriba son esos cuatro', () => {
  dice('cuántos lotes no producen, cuánto se ');
  for (const id of ['pa-prod-nprod', 'pa-prod-inv', 'pa-prod-prod', 'pa-prod-sincult']) {
    assert.ok(PANEL.includes('id="' + id + '"'), 'falta el número ' + id);
  }
  assert.ok(RUTAS.includes('resumen: resumenInversion(db, camp.id)'));
  assert.ok(RUTAS.includes('detalle: costosDeInversion(db, camp.id)'));
});

// ── «El cultivo es del lote en una temporada» ───────────────────────────────
test('AFIRMA: el cultivo es por (lote, temporada) y los dos años conviven', () => {
  dice('<b>no es del lote: es del lote en una temporada</b>');
  const db = base();
  db.prepare("INSERT INTO pa_campañas (nombre,tipo,activa) VALUES ('2027/28','anual',0)").run();
  for (const c of ['2026/27', '2027/28']) {
    db.prepare('INSERT INTO pa_cultivos_lote (lote_id,campaña,cultivo) VALUES (41,?,?)')
      .run(c, c === '2026/27' ? 'Tomate' : 'Zapallo');
  }
  marcarNoProduce(db, 41, '2026/27', false);
  // El año pasado queda marcado y el siguiente no: conviven.
  assert.equal(esProductivo(db, 41, '2026/27'), false);
  assert.equal(esProductivo(db, 41, '2027/28'), true);
  assert.equal(db.prepare("SELECT cultivo AS c FROM pa_cultivos_lote"
    + " WHERE campaña='2026/27'").get().c, 'Tomate');
});

// ── «Un frutal no lleva meses» ─────────────────────────────────────────────
test('AFIRMA: a un frutal no se le piden los meses', () => {
  dice('no se le piden mes de ');
  // paToggleDesarrolloFrutal esconde los dos selects de mes cuando es frutal.
  const i = PANEL.indexOf('function paToggleDesarrolloFrutal(key){');
  assert.ok(i > 0);
  const cuerpo = PANEL.slice(i, PANEL.indexOf('\n}', i));
  assert.ok(cuerpo.includes("msW.style.display=visible?'none':''"),
    'ya no esconde el mes de siembra para un frutal');
  assert.ok(cuerpo.includes("mcW.style.display=visible?'none':''"),
    'ya no esconde el mes de cosecha para un frutal');
});

// ── Y el común, que se pega solo ────────────────────────────────────────────
test('el manual trae pegado el bloque que vale en todo el panel', () => {
  // sgManualHtml le suma SG_MANUAL_COMUN a cualquiera: copiar el mismo párrafo
  // en los doce es la trampa que esa variable existe para evitar.
  const i = PANEL.indexOf('function sgManualHtml(m){');
  assert.ok(i > 0);
  assert.ok(PANEL.slice(i, i + 200).includes('SG_MANUAL_COMUN'),
    'sgManualHtml dejó de pegar el bloque común');
});
