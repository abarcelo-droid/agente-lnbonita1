// ══ MERMA: EL STOCK QUE SE TIRA ════════════════════════════════════════════
//
// Pablo, 2/9/2026: «dentro de stock vamos a avanzar con el módulo MERMA. Qué son
// las mermas: stock que se tira. Obviamente debe descontar cantidades de la partida
// y lo facturado es 0. Motivo obligatorio, subir foto opcional».
//
// «LO FACTURADO ES 0» ES LA DEFINICIÓN. La merma no se vende: sale de lo disponible,
// sale del piso, no entra un peso — y sin embargo la partida ya la pagó. Por eso el
// margen la absorbe entera, y por eso la pantalla muestra el COSTO de lo tirado.
//
// El decomiso ya existía y descontaba bien; lo que se hizo fue traerlo a Stock —que
// es donde está parado el que lo carga—, darle foto y una pantalla propia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const DBSG = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');

// ── 1 · DESCUENTA DE LA PARTIDA, CORRIDO ───────────────────────────────────

function trozo(desde, hasta) {
  const i = SG.indexOf(desde);
  assert.ok(i > 0, 'no existe ' + desde);
  return SG.slice(i, SG.indexOf(hasta, i + desde.length));
}

test('lo que se tira sale de lo disponible', () => {
  // Es lo primero que pidió Pablo: «debe descontar cantidades de la partida».
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, kg_reales REAL, bultos REAL);
    CREATE TABLE sg_lote_decomisos (lote_id INTEGER, kg REAL, bultos REAL);
    CREATE TABLE sg_transformaciones (lote_origen_id INTEGER, kg_transformados REAL, bultos_transformados REAL);
    CREATE TABLE sg_reprocesos (lote_madre_id INTEGER, kg_procesados REAL, bultos_procesados REAL, estado TEXT);
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, activo INTEGER);
    CREATE TABLE sg_despacho_items (id INTEGER PRIMARY KEY, despacho_id INTEGER, lote_id INTEGER,
      kg_despachados REAL, bultos REAL);
    CREATE TABLE sg_devoluciones (id INTEGER PRIMARY KEY, estado TEXT);
    CREATE TABLE sg_devolucion_items (id INTEGER PRIMARY KEY, devolucion_id INTEGER,
      despacho_item_id INTEGER, lote_id INTEGER, kg REAL, bultos REAL, destino TEXT, piso_id INTEGER,
      descuenta_al_productor INTEGER);
    INSERT INTO sg_lotes VALUES (1, 1000, 50);
  `);
  const src = [
    trozo('const SUM_TRANSF ', ';\r\n') + ';',
    trozo('const SUM_DECOMISO ', '\r\n'),
    trozo('const SUM_DESPACHADO ', ';\r\n') + ';',
    trozo('const SUM_DEV = (destino)', ';\r\n') + ';',
    trozo('const SUM_DEV_STOCK =', '\r\n'),
    trozo('const SUM_DEV_PROV ', ';\r\n') + ';',
    trozo('const KG_VIGENTE_STOCK =', '\r\n'),
    trozo('const KG_DISPONIBLE =', '\r\n'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const F = new Function(src + '\nreturn { KG_DISPONIBLE, KG_VIGENTE_STOCK };')();
  const disp = () => Number(db.prepare(
    `SELECT ${F.KG_DISPONIBLE} v FROM sg_lotes l WHERE l.id=1`).get().v);

  assert.equal(disp(), 1000);
  db.prepare('INSERT INTO sg_lote_decomisos VALUES (1, 120, 6)').run();
  assert.equal(disp(), 880, 'los 120 tirados salen de lo disponible');
  // Y también de lo VIGENTE: no es que estén afuera vendidos, es que no existen más.
  assert.equal(Number(db.prepare(
    `SELECT ${F.KG_VIGENTE_STOCK} v FROM sg_lotes l WHERE l.id=1`).get().v), 880);
  db.close();
});

test('no se puede tirar más de lo que hay', () => {
  const b = trozo("router.post('/lotes/:id/decomiso'", '\r\n});');
  assert.match(b, /const disp = \(lote\.kg_reales \|\| 0\) - kgDespachados\(db, lote\.id\) - kgDecomisado\(db, lote\.id\) - kgTransformado\(db, lote\.id\);/);
  assert.match(b, /if \(kg > disp \+ 0\.01\)/);
});

test('y sale del PISO, o la pantalla dice lleno un lugar vacío', () => {
  const b = trozo("router.post('/lotes/:id/decomiso'", '\r\n});');
  assert.match(b, /descontarDeUbicacion\(db, lote\.id, bultosDecomisados\(db, lote\.id, kg\), kg, null\);/);
  // Y la partida queda en amarillo si estaba en verde: algo le pasó.
  assert.match(b, /semaforo='amarillo'/);
});

// ── 2 · MOTIVO OBLIGATORIO, FOTO OPCIONAL ──────────────────────────────────

test('sin motivo no se registra', () => {
  // Un número de kilos tirados sin decir por qué, a los dos meses, no se le puede
  // reclamar a nadie.
  const b = trozo("router.post('/lotes/:id/decomiso'", '\r\n});');
  assert.match(b, /if \(!motivo\) return res\.status\(400\)\.json\(\{ ok: false, error: 'motivo requerido' \}\);/);
  const i = PANEL.indexOf('function sgMermaGuardar(){');
  assert.match(PANEL.slice(i, i + 1400), /El motivo es obligatorio: sin él, a los dos meses nadie puede explicar esos kilos/);
});

test('la foto es opcional, y se guarda donde se puede ver', () => {
  // El motivo dice qué pasó; la foto lo prueba. Pero exigirla haría que el que está
  // en la cámara no cargue la merma, y una merma sin registrar es peor.
  assert.match(DBSG, /addCol\('sg_lote_decomisos',\s+'foto_ruta',\s+'TEXT'\)/);
  assert.match(DBSG, /addCol\('sg_lote_decomisos',\s+'foto_nombre',\s+'TEXT'\)/);
  const b = trozo("router.post('/lotes/:id/decomiso'", '\r\n});');
  assert.match(b, /sgUpload\.single\('foto'\)/);
  // '/data/sg/' es la carpeta que index.js sirve estática: con otra ruta el archivo
  // se guarda igual y la foto no se ve nunca.
  assert.match(b, /req\.file \? \('\/data\/sg\/' \+ req\.file\.filename\) : null,/);
  const IDX = fs.readFileSync(path.join(RAIZ, 'src/index.js'), 'utf8');
  assert.match(IDX, /app\.use\("\/data\/sg",\s+express\.static/);
  // Y nada la exige.
  assert.ok(!/foto.*requerida|falta la foto/i.test(b), 'la foto se volvió obligatoria');
});

// ── 3 · LA PANTALLA, ADENTRO DE STOCK ──────────────────────────────────────

test('la solapa está en Stock, no en Reprocesos', () => {
  // Tirar mercadería es una operación de STOCK: el que la carga está parado en la
  // cámara mirando la partida, no reprocesando nada.
  const i = PANEL.indexOf('id="sec-sg-stock"');
  const b = PANEL.slice(i, i + 2600);
  assert.match(b, /onclick="sgStockTab\('merma'\)">🗑️ Merma<\/button>/);
  assert.match(b, /id="sg-st-tab-merma"/);
  // Y las tres solapas se manejan por una tabla: con ifs encadenados, agregar la
  // cuarta es tocar cinco líneas y olvidarse de alguna.
  // SG_STOCK_TABS se declara ARRIBA de la funcion: se corta desde ahi.
  const j = PANEL.indexOf('var SG_STOCK_TABS =');
  const c = PANEL.slice(j, j + 800);
  assert.match(c, /var SG_STOCK_TABS = \['partidas', 'pisos', 'merma'\];/);
  assert.match(c, /if \(elegida === 'merma'\) sgMermaLoad\(\);/);
});

test('se carga en CAJONES y se manda en kilos', () => {
  // Es la unidad en la que se tira y en la que la pantalla muestra la partida.
  // Pedirle los kilos al que está en la cámara es pedirle una cuenta a mano.
  const i = PANEL.indexOf('function sgMermaKg(){');
  assert.ok(i > 0);
  assert.match(PANEL.slice(i, i + 400), /return kpb>0 \? Math\.round\(n\*kpb\*100\)\/100 : n;/);
  // Y si la partida no tiene cajones, el rótulo lo dice en vez de mentir.
  const j = PANEL.indexOf('function sgMermaLotePick(){');
  assert.match(PANEL.slice(j, j + 900), /kpb>0 \? 'Cajones que se tiran' : 'Kilos que se tiran'/);
});

test('sólo ofrece partidas que tienen algo', () => {
  // Ofrecer una vacía es ofrecer un renglón que el servidor va a rechazar.
  const i = PANEL.indexOf('function sgMermaAbrir(){');
  assert.match(PANEL.slice(i, i + 1200), /\.filter\(function\(l\)\{ return Number\(l\.kg_disponibles\)>0\.01; \}\)/);
});

test('el botón se apaga si se pasa de lo que hay', () => {
  const i = PANEL.indexOf('function sgMermaCalc(){');
  const b = PANEL.slice(i, i + 1200);
  assert.match(b, /No se puede tirar más de lo que hay/);
  assert.match(b, /b\.disabled = !l \|\| !\(kg>0\) \|\| !!mal;/);
});

test('el listado muestra el COSTO de lo que se tiró', () => {
  // Es la plata que se perdió, que es lo que se mira. «Lo facturado es 0»: no va a
  // entrar un peso por esa mercadería y la partida ya la pagó.
  const b = trozo("router.get('/decomisos'", '\r\n});');
  assert.match(b, /d\.bultos, d\.foto_ruta, d\.foto_nombre,/);
  assert.match(b, /ROUND\(d\.kg \* COALESCE\(l\.costo_final \/ NULLIF\(l\.kg_reales,0\), 0\), 2\) AS costo/);
  const i = PANEL.indexOf('function sgMermaLoad(){');
  const c = PANEL.slice(i, i + 2000);
  assert.match(c, /Se tiraron ' \+ sgMoney/);
  // El cartel de la solapa lo dice: vive en el HTML, no en el JS.
  assert.match(PANEL, /y <b>no se factura<\/b>/);
});

// ── 4 · LA REGLA DEL MANUAL ────────────────────────────────────────────────

test('Stock tiene su «¿Cómo se usa?», con la merma adentro', () => {
  assert.match(PANEL, /onclick="sgManualAbrir\('stock'\)">❓ ¿Cómo se usa\?<\/button>/);
  const i = PANEL.indexOf("SG_MANUAL.stock = {");
  assert.ok(i > 0, 'Stock no tiene manual');
  const m = PANEL.slice(i, PANEL.indexOf('\r\n};', i));
  const plano = m.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
  for (const campo of ['Partida', 'Cuánto se tira', '¿Por qué se tira?', 'Foto']) {
    assert.ok(m.includes(campo), 'al manual de Stock le falta: ' + campo);
  }
  assert.ok(plano.includes('no se factura'), 'el manual no dice que la merma no se factura');
  assert.ok(plano.includes('La merma no se deshace'), 'no avisa que no hay vuelta atrás');
  // Y el cambio queda anotado con su versión, que es la regla.
  assert.match(m, /<span class="ver">V993<\/span>/);
  assert.match(m, /Qué cambió, y desde cuándo/);
});

test('y la versión del manual no le gana al panel', () => {
  const SB = fs.readFileSync(path.join(RAIZ, 'src/sidebar-v2.js'), 'utf8');
  const actual = Number((SB.match(/const VERSION = 'V(\d+)'/) || [])[1]);
  const i = PANEL.indexOf("SG_MANUAL.stock = {");
  const m = PANEL.slice(i, PANEL.indexOf('\r\n};', i));
  for (const v of (m.match(/<span class="ver">V(\d+)<\/span>/g) || [])) {
    const n = Number(v.match(/V(\d+)/)[1]);
    assert.ok(n <= actual, 'el manual de Stock cita la V' + n + ' y el panel va en la V' + actual);
  }
});
