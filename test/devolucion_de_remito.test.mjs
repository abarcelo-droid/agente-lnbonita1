// ══ DEVOLVER MERCADERÍA DE UN REMITO ═══════════════════════════════════════
//
// Pablo, 2/9/2026: «devolución de mercadería de los súper. De un remito particular
// permite hacer una devolución parcial o total, y la mercadería devuelta tiene dos
// opciones: o vuelve al stock eligiendo alguno de los pisos, o se devuelve al
// proveedor. En caso de que se devuelva al proveedor se genera un remito de
// devolución, que lo que hace es descontar de la mercadería ingresada de esa
// partida».
//
// Y las tres respuestas del 2/9, que definen el resto:
//
//   · «Los supermercados devuelven ANTES de facturar, así que no deberíamos tener
//     ese problema.»
//   · «Si querés, ficticiamente para hacer el remito lo tenés que hacer pasar por
//     un piso.» → TODA devolución entra por un piso; la que va al productor sale de
//     nuevo con el remito de devolución.
//   · «Una vez liquidado ya todo es firme.» → si la partida ya se liquidó, la
//     devolución NO se frena, pero deja de bajarle lo que se le debe: es pérdida
//     nuestra, y hay que decirlo.
//
// EL REMITO ORIGINAL NO SE TOCA. Lo que salió, salió: bajarle los kilos sería
// reescribir lo que pasó y rompería la cuenta de lo que falta facturar del renglón.
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

// ── LAS FÓRMULAS REALES, SACADAS DEL ROUTER Y CORRIDAS ─────────────────────
//
// No se reescriben acá: si el test corriera su propia copia, invertir un signo en
// el router lo dejaría en verde. Se recortan del fuente por su nombre, así que
// renombrarlas revienta el test en vez de vaciarlo en silencio.
function trozo(desde, hasta) {
  const i = SG.indexOf(desde);
  assert.ok(i > 0, 'no existe ' + desde + ' — ¿se renombró? el test dejó de cubrir la fórmula');
  const j = SG.indexOf(hasta, i + desde.length);
  assert.ok(j > i, 'no encontré el final de ' + desde);
  return SG.slice(i, j);
}
const FORMULAS = (() => {
  const src = [
    trozo('const SUM_TRANSF ', ';\r\n') + ';',
    trozo('const SUM_DECOMISO ', '\r\n'),
    trozo('const SUM_DESPACHADO ', ';\r\n') + ';',
    trozo('const SUM_DEV = (destino)', ';\r\n') + ';',
    trozo('const SUM_DEV_STOCK =', '\r\n'),
    // SUM_DEV_PROV se escribe entero y no con el armador `SUM_DEV`, porque además
    // del destino mira la marca congelada: va en varias líneas.
    trozo('const SUM_DEV_PROV ', ';\r\n') + ';',
    trozo('const KG_VIGENTE_STOCK =', '\r\n'),
    trozo('const KG_DISPONIBLE =', '\r\n'),
    trozo('const KG_INGRESADO_NETO =', '\r\n'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(src
    + '\nreturn { KG_VIGENTE_STOCK, KG_DISPONIBLE, KG_INGRESADO_NETO };')();
})();

function base() {
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
    -- Una partida de 1000 kg. Salieron 400 con un remito.
    INSERT INTO sg_lotes VALUES (1, 1000, 50);
    INSERT INTO sg_despachos VALUES (7, 1);
    INSERT INTO sg_despacho_items VALUES (70, 7, 1, 400, 20);
  `);
  return db;
}
const num = (db, expr) => Number(db.prepare(
  `SELECT ${expr} AS v FROM sg_lotes l WHERE l.id=1`).get().v);
const disp = (db) => num(db, FORMULAS.KG_DISPONIBLE);
const ingr = (db) => num(db, FORMULAS.KG_INGRESADO_NETO);

// `descuenta` es la marca que se CONGELA al registrar la devolución:
//   1 → le baja al productor lo que se le debe (la partida estaba libre)
//   0 → la partida ya estaba firme: la mercadería vuelve igual, pero es pérdida
//       nuestra. «Una vez liquidado ya todo es firme» — Pablo, 2/9/2026.
function devolver(db, kg, destino, id, descuenta) {
  db.prepare("INSERT OR IGNORE INTO sg_devoluciones VALUES (?, 'registrada')").run(id || 1);
  db.prepare(`INSERT INTO sg_devolucion_items
      (devolucion_id, despacho_item_id, lote_id, kg, bultos, destino, piso_id, descuenta_al_productor)
    VALUES (?,70,1,?,?,?,3,?)`).run(id || 1, kg, kg / 20, destino, descuenta == null ? 1 : descuenta);
}

// ── 1 · LA CUENTA DEL STOCK, CORRIDA ───────────────────────────────────────

test('el punto de partida: 1000 entraron, 400 salieron, quedan 600', () => {
  const db = base();
  assert.equal(disp(db), 600);
  assert.equal(ingr(db), 1000);
  db.close();
});

test('lo que vuelve al STOCK se puede volver a vender', () => {
  // Estaba restado como despachado; para volver a estar disponible hay que sumarlo.
  const db = base();
  devolver(db, 100, 'stock');
  assert.equal(disp(db), 700, 'los 100 devueltos vuelven a estar disponibles');
  assert.equal(ingr(db), 1000, 'y la partida siguió entrando igual: no cambia lo que se le debe');
  db.close();
});

test('lo que vuelve al PRODUCTOR no reaparece en el piso', () => {
  // Ya había salido con el remito. Sumarlo a lo disponible haría aparecer en el
  // depósito cajones que están en el camión del productor.
  const db = base();
  devolver(db, 100, 'proveedor');
  assert.equal(disp(db), 600, 'lo disponible NO cambia');
  // Lo que cambia es lo que entró de verdad de esa partida: es la cuenta de lo que
  // se le debe. «Descontar de la mercadería ingresada» — Pablo.
  assert.equal(ingr(db), 900, 'y lo ingresado baja en 100');
  db.close();
});

test('los dos destinos juntos no se pisan', () => {
  const db = base();
  devolver(db, 100, 'stock', 1);
  devolver(db, 50, 'proveedor', 2);
  assert.equal(disp(db), 700, '1000 − 400 + 100');
  assert.equal(ingr(db), 950, '1000 − 50');
  db.close();
});

test('la devolución ANULADA no cuenta para nada', () => {
  // Una devolución mal cargada se anula, no se borra: el papel salió y el cliente
  // tiene su copia. Pero deja de mover números.
  const db = base();
  devolver(db, 100, 'stock', 1);
  devolver(db, 50, 'proveedor', 2);
  db.prepare("UPDATE sg_devoluciones SET estado='anulada'").run();
  assert.equal(disp(db), 600);
  assert.equal(ingr(db), 1000);
  db.close();
});

test('devolver TODO deja la partida como si no se hubiera despachado', () => {
  const db = base();
  devolver(db, 400, 'stock');
  assert.equal(disp(db), 1000);
  db.close();
});

test('y un decomiso sigue restando: la devolución no lo tapa', () => {
  const db = base();
  db.prepare('INSERT INTO sg_lote_decomisos VALUES (1, 30, 1.5)').run();
  devolver(db, 100, 'stock');
  assert.equal(disp(db), 670, '1000 − 30 − 400 + 100');
  db.close();
});

// ── 2 · LOS CAJONES TAMBIÉN VUELVEN ────────────────────────────────────────

test('lo despachado se cuenta NETO de lo que volvió al piso, también en cajones', () => {
  // La pantalla de venta ofrece por cajón y el estado del lote se decide por cajón:
  // si sólo volvieran los kilos, la partida podía quedar en «despachado total» con
  // mercadería adentro.
  const i = SG.indexOf('function bultosDespachados(db, loteId) {');
  assert.ok(i > 0);
  const b = SG.slice(i, i + 700);
  assert.match(b, /return desp - bultosDevueltosAStock\(db, loteId\);/);
  const j = SG.indexOf('function bultosDevueltosAStock(db, loteId) {');
  assert.ok(j > 0, 'no existe la cuenta en cajones');
  const c = SG.slice(j, j + 500);
  assert.match(c, /dv\.estado='registrada'/);
  assert.match(c, /dvi\.destino='stock'/, 'los que van al productor no vuelven al piso');
});

// ── 3 · TODA DEVOLUCIÓN ENTRA POR UN PISO ──────────────────────────────────

test('sin piso no se registra, vaya donde vaya después', () => {
  // Pablo: «si querés, ficticiamente para hacer el remito lo tenés que hacer pasar
  // por un piso». Y sin piso la partida figuraría disponible sin estar en ningún
  // lado.
  const i = SG.indexOf("router.post('/despachos/:id/devolver'");
  const b = SG.slice(i, i + 5200);
  assert.match(b, /if \(!p\.pisoId\) return res\.status\(400\)/);
  assert.match(b, /Elegí por qué piso entra: aunque vuelva al productor/);
  // Y el piso con dueño lo toca sólo él.
  assert.match(b, /const noPuede = exigirPiso\(db, req, p\.pisoId, 'devolver mercadería'\);/);
});

test('entra por el piso, y si va al productor vuelve a salir', () => {
  // El neto sobre lo disponible es cero —esa mercadería no la tenemos— y queda el
  // rastro de por dónde pasó, que es de donde sale el papel.
  const i = SG.indexOf("router.post('/despachos/:id/devolver'");
  const b = SG.slice(i, i + 6000);
  assert.match(b, /ubicMover\(db, ln\.it\.lote_id, ln\.p\.pisoId, ln\.bultos, r2\(ln\.p\.kg\)\);/);
  assert.match(b, /if \(ln\.p\.destino === 'proveedor'\) \{\r?\n\s*ubicMover\(db, ln\.it\.lote_id, ln\.p\.pisoId, -ln\.bultos, -r2\(ln\.p\.kg\)\);/);
});

test('al anular, el piso no queda en negativo', () => {
  // Lo que fue al productor entró y salió: ya estaba en cero. Sacarlo otra vez
  // dejaría el piso debiendo mercadería.
  const i = SG.indexOf("router.post('/devoluciones/:id/anular'");
  const b = SG.slice(i, i + 1800);
  assert.match(b, /if \(it\.destino === 'stock' && it\.piso_id\) \{/);
  assert.match(b, /Sacarlo igual dejaría el piso en negativo/);
  assert.match(b, /Poné el motivo/, 'una devolución anulada sin motivo no se puede explicar');
});

// ── 4 · NO SE DEVUELVE MÁS DE LO QUE SALIÓ ─────────────────────────────────

test('el tope cuenta lo YA devuelto antes', () => {
  // Sin esta cuenta, dos devoluciones parciales del mismo renglón hacen aparecer
  // mercadería que nunca existió.
  const i = SG.indexOf('function kgDevueltoItem(db, despachoItemId) {');
  assert.ok(i > 0);
  assert.match(SG.slice(i, i + 400), /dv\.estado='registrada'[\s\S]*?WHERE dvi\.despacho_item_id = \?/);
  const j = SG.indexOf("router.post('/despachos/:id/devolver'");
  const b = SG.slice(j, j + 5200);
  assert.match(b, /const pend = kgSalio - kgDevueltoItem\(db, p\.id\);/);
  assert.match(b, /if \(p\.kg > pend \+ 0\.01\)/);
});

// ── 5 · LO LIQUIDADO ES FIRME, PERO NO FRENA ───────────────────────────────

test('si la partida ya se liquidó, avisa — y no frena', () => {
  // Pablo: «una vez liquidado ya todo es firme… a lo sumo es como una pérdida en la
  // partida». La mercadería vuelve igual: el súper ya la devolvió.
  const i = SG.indexOf("router.get('/despachos/:id/devolver'");
  const b = SG.slice(i, i + 3000);
  assert.match(b, /baja_lo_que_se_le_debe: !firme,/);
  assert.match(b, /la mercadería vuelve igual, pero NO se le descuenta al productor/);
  assert.match(b, /Queda como pérdida nuestra/);
  // Y no quedó ningún 409 que lo trabe.
  const j = SG.indexOf("router.post('/despachos/:id/devolver'");
  assert.ok(!/status\(409\)/.test(SG.slice(j, j + 5200)), 'volvió el freno que Pablo sacó');
});

test('la pantalla lo dice antes de registrarla', () => {
  // Una pérdida silenciosa es peor que un freno: el que la carga cree que le
  // descontó al productor y no le descontó nada.
  const i = PANEL.indexOf('function sgDevPintar(){');
  const b = PANEL.slice(i, i + 4000);
  assert.match(b, /it\.destino==='proveedor' && it\.aviso_liquidada/);
  assert.match(b, /color:var\(--err\)/);
});

// ── 6 · LA PANTALLA ────────────────────────────────────────────────────────

test('la solapa existe y está enganchada', () => {
  assert.match(PANEL, /data-sub="devoluciones"/);
  assert.match(PANEL, /id="sgv-sub-devoluciones"/);
  const i = PANEL.indexOf('function sgVenSub(s){');
  assert.match(PANEL.slice(i, i + 1100), /else if \(s==='devoluciones'\) sgDevLoad\(\);/);
});

test('parcial o total es la misma pantalla', () => {
  // Un modo aparte obliga a elegir antes de mirar los renglones, que es cuando
  // recién se sabe. Y lo que vuelve arranca en CERO: «devolver todo» es un botón,
  // no lo que pasa si nadie mira.
  const i = PANEL.indexOf('function sgDevTodo(){');
  assert.ok(i > 0, 'no hay atajo para la devolución total');
  assert.match(PANEL.slice(i, i + 200), /it\.kg = it\.kg_pendiente;/);
  assert.match(PANEL, /kg: 0, destino: 'stock', piso_id: '',/);
});

test('el botón se apaga si falta el piso o se devuelve de más', () => {
  const i = PANEL.indexOf('function sgDevTotales(){');
  const b = PANEL.slice(i, i + 1600);
  assert.match(b, /if\(it\.kg > it\.kg_pendiente \+ 0\.01\) deMas\+\+;/);
  assert.match(b, /if\(!it\.piso_id\) sinPiso\+\+;/);
  assert.match(b, /b\.disabled = !\(kg>0\) \|\| deMas>0 \|\| sinPiso>0;/);
});

test('lo tipeado está en cajones y se guarda en kilos', () => {
  // Es la unidad en la que se cuenta el stock.
  const i = PANEL.indexOf('function sgDevUpd(i, campo, v){');
  assert.match(PANEL.slice(i, i + 500), /it\.kg = \(it\.kpb>0\) \? Math\.round\(n\*it\.kpb\*10000\)\/10000 : n;/);
});

test('la devolución sale del remito, y el botón está en su renglón', () => {
  const i = PANEL.indexOf('function sgDespListar(modo){');
  const b = PANEL.slice(i, i + 3000);
  assert.match(b, /onclick="sgDevAbrir\('\+d\.id\+'\)">↩️<\/button>/);
  // Y sólo a quien puede operar: el botón que contesta 403 hace creer que se rompió.
  assert.match(b, /lnbPuedeOperar\('sg-ventas'\)/);
});

test('el remito de devolución se imprime, y marca lo que va al productor', () => {
  const i = PANEL.indexOf('function sgDevImprimir(id){');
  assert.ok(i > 0, 'no hay papel');
  const b = PANEL.slice(i, i + 3000);
  assert.match(b, /<h1>Remito de devolución /);
  assert.match(b, /Devuelve del remito/);
  assert.match(b, /vuelve al productor<\/b>/);
  assert.match(b, /renglón\(es\) vuelven al productor/);
  // Y si está anulada, el papel lo dice: uno impreso antes sigue dando vueltas.
  assert.match(b, /ANULADA/);
});

// ── 7 · LAS TABLAS Y EL PERMISO ────────────────────────────────────────────

test('las tablas existen con lo que hace falta', () => {
  assert.match(DBSG, /CREATE TABLE IF NOT EXISTS sg_devoluciones/);
  assert.match(DBSG, /CREATE TABLE IF NOT EXISTS sg_devolucion_items/);
  assert.match(DBSG, /destino\s+TEXT NOT NULL CHECK\(destino IN \('stock','proveedor'\)\)/);
  assert.match(DBSG, /piso_id\s+INTEGER REFERENCES sg_pisos\(id\)/);
});

test('la dirección está declarada, o contesta 403 a todo el mundo', () => {
  // El prefijo matchea por segmento completo: /api/sg/devoluciones/12/anular no
  // cuelga de 'sg/despachos'. Es el mismo agujero que ya se comió
  // 'sg/despachos-pendientes'.
  const PRE = fs.readFileSync(path.join(RAIZ, 'src/servicios/ensure_api_prefijos.js'), 'utf8');
  assert.match(PRE, /\['sg-ventas',\s+'[^']*sg\/devoluciones[^']*'\]/);
});

// ── 8 · LA NOTA DE CRÉDITO Y LA DEVOLUCIÓN SON DOS COSAS ───────────────────
//
// Pablo, 2/9/2026: «las notas de crédito deberían permitirnos o no (selector)
// devolver la mercadería. Hay veces que son por precio y otras por cantidad.
// Obviamente deben afectar la partida».
//
// El selector ya existía y anda. Lo que faltaba era decir hasta dónde llega cada
// una: la NOTA arregla el comprobante y la deuda; la DEVOLUCIÓN mueve la
// mercadería. Hacer que la nota mueva stock sola sería un segundo escritor del
// stock, que es justo lo que este código evita.

test('el selector de la nota sigue en pie, con sus dos modos', () => {
  const VEN = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');
  assert.match(VEN, /const modo = \(String\(req\.body\?\.modo \|\| ''\) === 'precio'\) \? 'precio' : 'devolucion';/);
  // Por PRECIO no vuelven kilos; por CANTIDAD sí.
  assert.match(VEN, /elegidos\.push\(\{ ren, cantidad: ren\.cantidad, neto, devuelveKg: false \}\);/);
  assert.match(VEN, /kg: e\.devuelveKg \? Math\.min\(e\.cantidad, e\.ren\.kg_documentados\) : 0,/);
  assert.match(PANEL, /name="sg-nc-modo" value="devolucion"/);
  assert.match(PANEL, /name="sg-nc-modo" value="precio"/);
});

test('y el cartel dice que la nota NO mueve la mercadería de lugar', () => {
  // Sin esto, el que emite la nota cree que ya devolvió el stock y la partida queda
  // figurando disponible sin estar en ningún piso.
  const i = PANEL.indexOf('function sgNcModo(){');
  const b = PANEL.slice(i, i + 1200);
  assert.match(b, /Después se registra la devolución/);
  assert.match(b, /la nota arregla el comprobante, no mueve la mercadería de lugar/);
});

test('al emitirla en modo devolución, se ofrece registrar la devolución', () => {
  // Un paso para el que la carga, dos documentos: que es lo que son.
  const i = PANEL.indexOf('function sgNcEmitir(){');
  const b = PANEL.slice(i, i + 2600);
  assert.match(b, /var remito = sgNcRemitoDe\(b\);/);
  assert.match(b, /if \(!precio && remito\) \{/);
  assert.match(b, /¿Registramos la devolución\?'\)\) sgDevAbrir\(remito\);/);
});

test('y si la nota toca varios remitos, no se adivina cuál', () => {
  // Abrir el equivocado es peor que no abrir ninguno.
  const i = PANEL.indexOf('function sgNcRemitoDe(base){');
  assert.ok(i > 0);
  assert.match(PANEL.slice(i, i + 400), /return ids\.length === 1 \? ids\[0\] : null;/);
});

// ── 9 · EL HISTORIAL DE LA PARTIDA LA CONOCE ──────────────────────────────
//
// El historial se AUTOCONTROLA: al final compara la suma de los movimientos contra
// lo disponible y avisa si no cierra. Sin esta vuelta, la primera devolución hacía
// que dijera que no cierra — y una alarma que se dispara por algo que está bien
// deja de servir a los dos días.

test('la devolución aparece en el historial de la partida', () => {
  const i = SG.indexOf("router.get('/lotes/:id/movimientos'");
  const b = SG.slice(i, i + 9000);
  assert.match(b, /tipo: 'devolucion', fecha: dv\.fecha,/);
  assert.match(b, /FROM sg_devolucion_items dvi/);
  assert.match(b, /JOIN sg_devoluciones dv ON dv\.id = dvi\.devolucion_id AND dv\.estado = 'registrada'/);
});

test('y suma en el saldo SÓLO lo que volvió al piso', () => {
  // Lo que fue al productor entró y salió: en el saldo no mueve nada. Sumarlo haría
  // que el historial dejara de cerrar, que es justo lo que esto viene a evitar.
  const i = SG.indexOf("router.get('/lotes/:id/movimientos'");
  const b = SG.slice(i, i + 9000);
  assert.match(b, /kg: alProd \? 0 : kg,/);
  assert.match(b, /bultos: alProd \? 0 : dv\.bultos,/);
  // Pero se muestra igual: es lo que explica por qué a esa partida le entraron
  // menos kilos de los que dice la balanza.
  assert.match(b, /kg salieron del depósito/);
  assert.match(b, /Devuelta al productor/);
  assert.match(b, /Devuelta al stock/);
});

test('el helper que usa existe de verdad', () => {
  // Una función usada y nunca definida pasa el chequeo de sintaxis y explota recién
  // cuando alguien abre esa pantalla.
  const i = SG.indexOf("router.get('/lotes/:id/movimientos'");
  const b = SG.slice(i, i + 9000);
  const usados = [...b.matchAll(/([a-zA-Z_$][\w$]*)\(/g)].map((m) => m[1]);
  for (const f of ['r2']) {
    assert.ok(usados.includes(f), 'el historial no usa ' + f);
    assert.ok(new RegExp('(const|function)\\s+' + f + '\\s*[=(]').test(SG), f + ' no está definida');
  }
  assert.ok(!/\bnr2\(/.test(b), 'quedó nr2, que no existe en este archivo');
});

// ── 10 · LO LIQUIDADO ES FIRME: LA DEVOLUCIÓN NO LE DESCUENTA ──────────
//
// Pablo, 2/9/2026: «una vez liquidado ya todo es firme… a lo sumo es como una
// pérdida en la partida». La mercadería vuelve igual —el súper ya la devolvió— pero
// deja de bajarle lo que se le debe al productor.

test('sobre partida firme, la mercadería vuelve pero NO le descuenta', () => {
  const db = base();
  devolver(db, 100, 'proveedor', 1, 0);   // 0 = la partida ya estaba firme
  assert.equal(ingr(db), 1000, 'no se le descuenta nada al productor');
  assert.equal(disp(db), 600, 'y lo disponible sigue igual: ya había salido');
  db.close();
});

test('y si estaba libre, sí le descuenta', () => {
  const db = base();
  devolver(db, 100, 'proveedor', 1, 1);
  assert.equal(ingr(db), 900);
  db.close();
});

test('la marca se CONGELA al registrarla, no se recalcula', () => {
  // Si se recalculara cada vez, liquidar la partida después haría que las
  // devoluciones viejas dejaran de descontar de golpe, y la liquidación ya emitida
  // quedaría «de más» sin que nadie tocara nada.
  assert.match(DBSG, /addCol\('sg_devolucion_items', 'descuenta_al_productor', 'INTEGER'\)/);
  const i = SG.indexOf("router.post('/despachos/:id/devolver'");
  const b = SG.slice(i, i + 6000);
  assert.match(b, /let descuenta = 0;/);
  assert.match(b, /if \(p\.destino === 'proveedor'\) \{/);
  assert.match(b, /descuenta = firme \? 0 : 1;/);
  assert.match(b, /ln\.p\.pisoId, ln\.descuenta\);/);
  // Y lo ingresado neto mira la MARCA, no el destino.
  assert.match(SG, /AND COALESCE\(dvi\.descuenta_al_productor,1\)=1\),0\)/);
});

test('las devoluciones viejas, sin la marca, siguen descontando', () => {
  // COALESCE(...,1): las que se registraron antes de que existiera la columna se
  // hicieron sobre partidas libres, que era la única manera de registrarlas.
  const db = base();
  db.prepare("INSERT INTO sg_devoluciones VALUES (1,'registrada')").run();
  db.prepare(`INSERT INTO sg_devolucion_items
      (devolucion_id, despacho_item_id, lote_id, kg, bultos, destino, piso_id, descuenta_al_productor)
    VALUES (1,70,1,100,5,'proveedor',3,NULL)`).run();
  assert.equal(ingr(db), 900);
  db.close();
});
