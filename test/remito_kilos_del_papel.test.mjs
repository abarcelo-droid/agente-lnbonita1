// ══════════════════════════════════════════════════════════════════════════
// AL SÚPER SE LE PUEDEN REMITIR MÁS KILOS, Y EL STOCK NO SE ENTERA
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 9/9/2026: «Solamente para el caso de los supermercados debemos poder
// remitir MÁS kilos de los ingresados. Por ejemplo si la partida tiene 14 kilos por
// ingresos, debemos poder poner a mano 15 kg para que figure en el remito. Los kilos
// quedan firmes con las recepciones del supermercado y ahí sacamos los kilos para
// facturar».
//
// Y el 10/9: «está correcto» que los kilos de más NO bajen el stock.
//
// Un renglón de remito pasa a tener dos números: los del GALPÓN (stock, costo,
// margen) y los del PAPEL (lo que se imprime, se factura y se liquida). El riesgo es
// que algún lector use el que no le toca: si el stock leyera el papel, la partida
// queda en negativo; si la factura leyera el galpón, el remito dice 15 y la factura
// se traba en 14.
//
// Y el mismo PR: el remito impreso trae ENVASE y KG/BULTO («En la impresión del
// remito debemos agregar: KG/BULTO. Agregar detalle del envase»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const VEN = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');
const DBSG = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const K = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/sg_kilos_del_papel.js')).href);

const hasta = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i >= 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

// ══════════════════════════════════════════════════════════════════════════
// 1 · LA REGLA, CORRIDA
// ══════════════════════════════════════════════════════════════════════════

test('el papel dice los declarados; sin declaración, lo que salió', () => {
  assert.equal(K.kgDelPapel({ kg_despachados: 14, kg_declarados: 15 }), 15);
  assert.equal(K.kgDelPapel({ kg_despachados: 14, kg_declarados: null }), 14);
  // Un cero guardado no es una declaración: sería un remito que dice 0 kg.
  assert.equal(K.kgDelPapel({ kg_despachados: 14, kg_declarados: 0 }), 14);
});

test('si la cadena devuelve el renglón ENTERO, se cancela entero', () => {
  // La devolución se mide en el galpón (14) y lo pendiente en el papel (15). Restar
  // 14 de 15 dejaría 1 kg pendiente de facturar para siempre, de mercadería que ni
  // siquiera salió.
  const di = { kg_despachados: 14, kg_declarados: 15 };
  assert.equal(K.kgPendienteDelPapel(di, 0, 14), 0);
  // Y la mitad devuelta cancela la mitad del papel.
  assert.equal(K.kgPendienteDelPapel(di, 0, 7), 7.5);
  // Lo ya facturado se resta tal cual: se facturó en kilos del papel.
  assert.equal(K.kgPendienteDelPapel(di, 10, 0), 5);
  // Y sin declaración es la cuenta de siempre.
  assert.equal(K.kgPendienteDelPapel({ kg_despachados: 14 }, 4, 3), 7);
});

test('sólo a una cadena', () => {
  const r = K.validarKgDeclarados({ esCadena: false, kgNominal: 14, kgDeclarados: 15 });
  assert.equal(r.ok, false);
  assert.match(r.error, /sólo a un supermercado/);
  // A la cadena, sí.
  assert.deepEqual(K.validarKgDeclarados({ esCadena: true, kgNominal: 14, kgDeclarados: 15 }),
    { ok: true, kg: 15 });
});

test('sólo MÁS, nunca menos', () => {
  // Declarar menos no destraba nada —se puede facturar menos igual— y abre la puerta
  // a un remito que dice menos de lo que se llevó el camión.
  const r = K.validarKgDeclarados({ esCadena: true, kgNominal: 14, kgDeclarados: 13 });
  assert.equal(r.ok, false);
  assert.match(r.error, /no se declaran menos kilos/);
});

test('igual a lo que sale, o vacío, no es una declaración', () => {
  assert.deepEqual(K.validarKgDeclarados({ esCadena: true, kgNominal: 14, kgDeclarados: 14 }),
    { ok: true, kg: null });
  assert.deepEqual(K.validarKgDeclarados({ esCadena: true, kgNominal: 14, kgDeclarados: '' }),
    { ok: true, kg: null });
  assert.deepEqual(K.validarKgDeclarados({ esCadena: false, kgNominal: 14, kgDeclarados: null }),
    { ok: true, kg: null }, 'a un cliente común, sin declaración, no hay nada que frenar');
});

test('y un cero de más no pasa', () => {
  // Lo declarado es lo que después se puede FACTURAR: un 150 que pasa es una factura
  // de diez veces lo que salió.
  const r = K.validarKgDeclarados({ esCadena: true, kgNominal: 14, kgDeclarados: 150 });
  assert.equal(r.ok, false);
  assert.match(r.error, /revisá que no sobre un cero/);
  // Justo en el tope, sí; un poco más, no.
  assert.equal(K.validarKgDeclarados({ esCadena: true, kgNominal: 14, kgDeclarados: 21 }).ok, true);
  assert.equal(K.validarKgDeclarados({ esCadena: true, kgNominal: 14, kgDeclarados: 21.1 }).ok, false);
  assert.equal(K.TOPE_DECLARADO, 1.5);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL STOCK NO SE ENTERA
// ══════════════════════════════════════════════════════════════════════════

test('el disponible de la partida baja lo que SALIÓ, no lo declarado', () => {
  // Se corre la suma de verdad, contra una base: una partida de 14 kg con un remito
  // al súper que declaró 15 tiene que quedar en 0, no en −1.
  const src = hasta(SG, 'const SUM_DESPACHADO = ', ';');
  // eslint-disable-next-line no-new-func
  const SUM_DESPACHADO = new Function(src + '\nreturn SUM_DESPACHADO;')();
  assert.ok(!/kg_declarados/.test(SUM_DESPACHADO), 'el stock lee los kilos del papel');

  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, kg_reales REAL);
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, activo INTEGER);
    CREATE TABLE sg_despacho_items (id INTEGER PRIMARY KEY, despacho_id INTEGER, lote_id INTEGER,
      kg_despachados REAL, kg_declarados REAL);
    INSERT INTO sg_lotes VALUES (1, 14);
    INSERT INTO sg_despachos VALUES (1, 1);
    INSERT INTO sg_despacho_items VALUES (1, 1, 1, 14, 15);`);
  const r = db.prepare(`SELECT l.kg_reales - ${SUM_DESPACHADO} AS disp FROM sg_lotes l WHERE l.id=1`).get();
  assert.equal(r.disp, 0);
});

test('ni el costo ni el margen', () => {
  // Se le cobra por lo declarado, pero el costo es de lo que salió. Si el margen
  // leyera el papel, cada remito al súper mostraría un costo inflado.
  for (const nombre of ['const KG_COMPROMETIDO_CAMINO', 'const MARGEN_LINEA']) {
    const b = hasta(SG, nombre, ';');
    assert.ok(!/kg_declarados/.test(b), nombre + ' lee los kilos del papel');
  }
  // Y el remito descuenta del piso los kilos nominales, no los declarados.
  const post = hasta(SG, 'const postRemito = (req, res) => {', '\r\n};');
  assert.match(post, /const rUb = descontarDeUbicacion\(db, ln\.loteId, bultos, kg, pisoLinea\);/);
  assert.match(post, /const subtotal = kg \* precio;/);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL PAPEL: FACTURAR Y LIQUIDAR
// ══════════════════════════════════════════════════════════════════════════

test('las tres puertas de la factura cuentan en kilos del papel', () => {
  // La lista de facturables, la bandeja de pendientes y el POST que emite. Si una
  // sola quedara en kilos del galpón, ofrecería 15 y rebotaría con «quedan 14».
  const fac = hasta(SG, "router.get('/facturable'", '\r\n});');
  assert.match(fac, /di\.kg_declarados/);
  assert.match(fac, /const kgPend = kgPendienteItem\(db, r\.despacho_item_id, r\);/);

  const pen = hasta(SG, "router.get('/despachos-pendientes'", '\r\n});');
  assert.match(pen, /di\.kg_declarados/);
  assert.match(pen, /const kgPend = kgPendienteItem\(db, r\.despacho_item_id, r\);/);

  const emi = hasta(SG, 'const postEmitir = async (req, res) => {', '\r\n};');
  assert.match(emi, /di\.kg_declarados/);
  assert.match(emi, /const kgPend = kgPendienteItem\(db, diId, di\);/);

  // Y la función es la del servicio: una sola regla.
  const f = hasta(SG, 'function kgPendienteItem(', '\r\n}');
  assert.match(f, /kgPendienteDelPapel\(di, kgDocumentadoItem\(db, despachoItemId\),/);
  assert.match(f, /kgDevueltoItem\(db, despachoItemId\)/);
});

test('y la liquidación que manda la cadena, también', () => {
  // La cadena liquida los kilos que recibió, que son los que dijo el remito.
  assert.match(VEN, /import \{ kgDelPapel \} from '\.\.\/servicios\/sg_kilos_del_papel\.js';/);
  assert.match(VEN, /SELECT kg_despachados, kg_declarados FROM sg_despacho_items WHERE id=\?/);
  assert.match(VEN, /const pend = Math\.round\(\(kgDelPapel\(di\) - yaFac - yaLiq\) \* 100\) \/ 100;/);
});

// ── Y LAS SUMAS EN SQL QUE RESTAN LO FACTURADO ─────────────────────────────
//
// Éstas no estaban en la primera pasada y ningún test las cubría: la suite quedó en
// verde con las tres leyendo el galpón. Restan lo facturado (del papel) a lo
// despachado: si lo despachado se mide en el galpón, un renglón declarado y facturado
// entero da −1 kg, y esa resta SE COME lo que otro renglón tiene sin facturar.

test('el freno para liquidar una partida no se deja engañar por un renglón declarado', async () => {
  // Es plata: sinFacturarDePartida es lo que impide liquidarle al productor una
  // partida que tiene mercadería vendida sin comprobante.
  const { sinFacturarDePartida } = await import(
    pathToFileURL(path.join(RAIZ, 'src/servicios/sg_partida_terminada.js')).href);
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY, oc_id INTEGER);
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, oc_item_id INTEGER, activo INTEGER);
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, activo INTEGER);
    CREATE TABLE sg_despacho_items (id INTEGER PRIMARY KEY, despacho_id INTEGER, lote_id INTEGER,
      kg_despachados REAL, kg_declarados REAL, precio_por_kg REAL);
    CREATE TABLE sg_ven_facturas (id INTEGER PRIMARY KEY);
    CREATE TABLE sg_factura_despachos (factura_id INTEGER, despacho_item_id INTEGER, kg REAL);
    INSERT INTO sg_oc_items VALUES (70, 7);
    INSERT INTO sg_lotes VALUES (1, 70, 1);
    INSERT INTO sg_despachos VALUES (1, 1), (2, 1);
    -- A la cadena: salieron 14, el remito dijo 15, y se facturaron los 15.
    INSERT INTO sg_despacho_items VALUES (11, 1, 1, 14, 15, 100);
    -- Otro remito de la misma partida: 10 kg, SIN facturar. Son $1.000 vendidos sin
    -- comprobante, y el freno tiene que verlos enteros.
    INSERT INTO sg_despacho_items VALUES (12, 2, 1, 10, NULL, 100);
    INSERT INTO sg_ven_facturas VALUES (1);
    INSERT INTO sg_factura_despachos VALUES (1, 11, 15);`);
  const monto = sinFacturarDePartida(db, 7, () => '1=1');
  assert.equal(monto, 1000,
    'el renglón declarado se comió parte de lo sin facturar: el freno dejaría liquidar');
});

test('las otras dos sumas usan la misma regla', () => {
  // La venta de la partida (GET /partidas/:id/venta) tiene que dar lo mismo que el
  // freno; y la mercadería entregada sin comprobante de CC clientes, igual.
  const venta = hasta(SG, 'const sinFac = db.prepare(`', '`).get(ocId);');
  assert.match(venta, /SUM\(\(\$\{kgPapelSql\('di'\)\}/);
  const cc = hasta(SG, "router.get('/cc-clientes'", '\r\n});');
  const usos = (cc.match(/\$\{kgPapelSql\('di'\)\}/g) || []).length;
  assert.equal(usos, 2, 'la columna «sin comprobante» tiene que medir en el papel en la suma Y en el filtro');
  assert.ok(!/\(di\.kg_despachados\s*\r?\n\s*- COALESCE\(\(SELECT SUM\(fd\.kg\)/.test(SG),
    'quedó una resta de lo facturado contra los kilos del galpón');
});

test('y en SQL, un cero guardado tampoco es una declaración', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE di (kg_despachados REAL, kg_declarados REAL);
    INSERT INTO di VALUES (14, 15), (14, NULL), (14, 0);`);
  const r = db.prepare(`SELECT ${K.kgPapelSql('di')} AS k FROM di`).all().map((x) => x.k);
  assert.deepEqual(r, [15, 14, 14]);
  // Y no acepta cualquier cosa como alias: termina adentro de un SQL.
  assert.throws(() => K.kgPapelSql('di; DROP TABLE x'), /alias inválido/);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · EL REMITO LO ACEPTA — SÓLO A UNA CADENA, Y LO DECIDE EL SERVIDOR
// ══════════════════════════════════════════════════════════════════════════

test('el servidor pregunta si es cadena con la regla de las listas, no con la pantalla', () => {
  // La pantalla en modo súper es un pedido. Si el servidor le creyera, bastaría con
  // mandar el campo desde el remito común.
  const post = hasta(SG, 'const postRemito = (req, res) => {', '\r\n};');
  assert.match(post, /const esCadena = !!db\.prepare\(`SELECT 1 FROM sg_clientes c WHERE c\.id=\? AND \$\{SQL_ES_CADENA\}`\)/);
  assert.match(post, /validarKgDeclarados\(\{ esCadena, kgNominal: kg, kgDeclarados: it\.kg_declarados,/);
  assert.match(post, /if \(!dec\.ok\) return res\.status\(400\)\.json\(\{ ok: false, error: dec\.error \}\);/);
  // Y se guarda.
  // Puede no ser la última columna: después se sumó el flete del renglón (V1045).
  assert.match(post, /piso_id, modo_precio, kg_declarados[,)]/);
  assert.match(post, /ln\.kgDeclarados != null \? ln\.kgDeclarados : null[,)]/);
});

test('la columna existe, y los remitos viejos quedan sin declaración', () => {
  assert.match(DBSG, /addCol\('sg_despacho_items',\s+'kg_declarados',\s+'REAL'\)/);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LA PANTALLA
// ══════════════════════════════════════════════════════════════════════════

test('el casillero aparece SÓLO en el remito al súper', () => {
  const f = hasta(PANEL, 'function sgDespRender(){', '\r\n}');
  assert.match(f, /var sup = SG\.despModo === 'super' && !enViaje;/);
  assert.match(f, /\(sup \? '1\.5fr 0\.55fr 0\.75fr 0\.8fr auto' : '1\.7fr 0\.7fr 0\.8fr auto'\)/);
  assert.match(f, /\+\(sup\r?\n?\s*\? \('<input type="text" inputmode="decimal"/);
  assert.match(f, /onchange="sgDespUpdDecl\('\+i\+',this\.value\)"/);
});

test('escribir lo mismo que sale no deja una declaración', () => {
  const src = hasta(PANEL, 'function sgDespUpdDecl(i, v){', '\r\n}');
  const parse = hasta(PANEL, 'function sgMilParse(str){', '\r\n}');
  const SGx = { despItems: [{ kg: 14 }] };
  // eslint-disable-next-line no-new-func
  const upd = new Function('SG', 'sgDespRender', parse + '\n' + src + '\nreturn sgDespUpdDecl;')(SGx, () => {});
  upd(0, '15');
  assert.equal(SGx.despItems[0].kg_declarados, 15);
  upd(0, '14');
  assert.equal(SGx.despItems[0].kg_declarados, '', 'igual a lo que sale quedó como declaración');
  // Con coma decimal, que es como se escribe acá.
  upd(0, '14,5');
  assert.equal(SGx.despItems[0].kg_declarados, 14.5);
});

test('viaja al servidor sólo desde el remito al súper', () => {
  const g = hasta(PANEL, 'function sgDespGuardar(){', '\r\n}');
  assert.match(g, /kg_declarados:\(SG\.despModo==='super' && Number\(it\.kg_declarados\)>0\) \? Number\(it\.kg_declarados\) : null,/);
  // Y los cajones siguen viajando aparte: si el campo pisara it.kg, el servidor
  // volvería a derivar los cajones de ahí y 15 sobre cajones de 14 serían 1,07.
  assert.match(g, /bultos:b, kg_despachados:Number\(it\.kg\),/);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · EL PAPEL IMPRESO, CORRIDO
// ══════════════════════════════════════════════════════════════════════════

function imprimir(despacho) {
  const src = hasta(PANEL, 'function sgDespImprimir(id){', '\r\n}');
  const kgPapel = hasta(PANEL, 'function sgDespKgPapel(it){', '\r\n}');
  const show = hasta(PANEL, 'function sgMilShow(n){', '\r\n}');
  let html = null;
  const mundo = {
    api: () => ({ then: (cb) => cb({ ok: true, data: despacho }) }),
    escH: (v) => String(v == null ? '' : v),
    nr: (n) => Math.round(parseFloat(n) || 0).toLocaleString('es-AR'),
    toast: () => {},
    sgFletePagaTxt: () => '',
    _ccImprimir: (t, h) => { html = h; },
  };
  // eslint-disable-next-line no-new-func
  const f = new Function(...Object.keys(mundo), kgPapel + '\n' + show + '\n' + src + '\nreturn sgDespImprimir;')(
    ...Object.values(mundo));
  f(1);
  assert.ok(html, 'no se imprimió nada');
  return html;
}

const celdas = (html) => [...html.matchAll(/<tr><td><code>[\s\S]*?<\/tr>/g)]
  .map((m) => [...m[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, '')));

test('el remito impreso trae el envase y los kg por bulto', () => {
  const html = imprimir({ numero: 'R-1', items: [
    { codigo_lote: 'L1', producto_nombre: 'Tomate', envase_nombre: 'Cajón plástico',
      bultos: 10, kg_despachados: 185 },
  ] });
  assert.match(html, /<th>Envase<\/th>/);
  assert.match(html, /<th class="d">Kg\/bulto<\/th>/);
  const [fila] = celdas(html);
  assert.deepEqual(fila, ['L1', 'Tomate', 'Cajón plástico', '10', '18,5', '185']);
});

test('con kilos declarados, el papel dice los declarados — y el kg/bulto cierra con ellos', () => {
  // Un remito que dijera «1 cajón × 14 kg = 15 kg» no cerraría a la vista de nadie.
  const html = imprimir({ numero: 'R-2', items: [
    { codigo_lote: 'L2', producto_nombre: 'Limón', envase_nombre: 'Jaula',
      bultos: 1, kg_despachados: 14, kg_declarados: 15 },
    { codigo_lote: 'L3', producto_nombre: 'Lima', envase_nombre: null,
      bultos: 2, kg_despachados: 29, kg_declarados: null },
  ] });
  const filas = celdas(html);
  assert.deepEqual(filas[0], ['L2', 'Limón', 'Jaula', '1', '15', '15']);
  // Sin envase cargado, un guión: no una celda vacía que parezca un error de impresión.
  assert.deepEqual(filas[1], ['L3', 'Lima', '—', '2', '14,5', '29']);
  // El total que firma el que recibe es el del papel: 15 + 29.
  assert.match(html, /<tr class="tot"><td colspan="3">Total<\/td><td class="d">3<\/td><td class="d"><\/td><td class="d">44<\/td><\/tr>/);
});

test('el envase sale del renglón y, en los viejos, de la partida', () => {
  const get = hasta(SG, "router.get('/despachos/:id', requireAuth", '\r\n});');
  assert.match(get, /COALESCE\(ev\.nombre, evl\.nombre\) AS envase_nombre/);
  assert.match(get, /LEFT JOIN sg_envases ev ON ev\.id=di\.envase_id/);
  assert.match(get, /LEFT JOIN sg_envases evl ON evl\.id=l\.envase_id/);
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · EL MANUAL DICE LO QUE EL CÓDIGO HACE
// ══════════════════════════════════════════════════════════════════════════

const plano = (txt) => String(txt).replace(/'\s*\+\s*'/g, '');
const MAN = plano(hasta(PANEL, 'SG_MANUAL.ventas = ', 'SG_MANUAL.reprocesos = '));

test('el manual tiene la entrada, con su versión', () => {
  assert.match(MAN, /Al súper, más kilos que los de la partida <span class="ver">V1040<\/span>/);
  assert.match(MAN, /<b>V1040<\/b> — al <b>súper se le pueden remitir más kilos<\/b>/);
});

test('«el stock baja lo que sale, no lo declarado» — y así es', () => {
  assert.match(MAN, /<b>El stock baja lo que sale, no lo declarado\.<\/b>/);
  assert.ok(!/kg_declarados/.test(hasta(SG, 'const SUM_DESPACHADO = ', ';')));
});

test('«lo que se imprime y lo que se puede facturar son los declarados»', () => {
  assert.match(MAN, /<b>Lo que se imprime y lo que se puede facturar son los declarados\.<\/b>/);
  assert.match(hasta(SG, 'const postEmitir = async (req, res) => {', '\r\n};'),
    /const kgPend = kgPendienteItem\(db, diId, di\);/);
  assert.match(hasta(PANEL, 'function sgDespImprimir(id){', '\r\n}'), /sgDespKgPapel\(/);
});

test('«si devuelve el renglón entero, se cancela entero»', () => {
  assert.match(MAN, /<b>devuelve el renglón entero<\/b>, se cancela entero/);
  assert.equal(K.kgPendienteDelPapel({ kg_despachados: 14, kg_declarados: 15 }, 0, 14), 0);
});

test('los tres frenos del manual son los tres del servidor', () => {
  assert.match(MAN, /<b>sólo a un cliente que sea cadena<\/b>/);
  assert.match(MAN, /<b>sólo más, nunca menos<\/b>/);
  assert.match(MAN, /<b>no más de la mitad por encima<\/b>/);
  assert.equal(K.validarKgDeclarados({ esCadena: false, kgNominal: 14, kgDeclarados: 15 }).ok, false);
  assert.equal(K.validarKgDeclarados({ esCadena: true, kgNominal: 14, kgDeclarados: 13 }).ok, false);
  assert.equal(K.validarKgDeclarados({ esCadena: true, kgNominal: 14, kgDeclarados: 22 }).ok, false);
});

test('«el papel trae el envase y los kg por bulto»', () => {
  assert.match(MAN, /<span class="ver">V1040<\/span> El papel trae, renglón por renglón, el <b>envase<\/b> y los <b>kg por bulto<\/b>/);
  const f = hasta(PANEL, 'function sgDespImprimir(id){', '\r\n}');
  assert.match(f, /<th>Envase<\/th>/);
  assert.match(f, /Kg\/bulto/);
});

test('«todo lo remitido y sin facturar cuenta en kilos del papel» — freno y cuenta corriente', () => {
  assert.match(MAN, /<b>«remitido y sin facturar»<\/b> cuenta en kilos del papel/);
  assert.match(MAN, /<b>freno que no deja liquidarle una partida al productor<\/b>/);
  const PT = fs.readFileSync(path.join(RAIZ, 'src/servicios/sg_partida_terminada.js'), 'utf8');
  assert.match(hasta(PT, 'export function sinFacturarDePartida(', '\r\n}'), /\$\{kgPapelSql\('di'\)\}/);
  const MANCC = plano(hasta(PANEL, 'SG_MANUAL.ccclientes = ', 'SG_MANUAL.catalogo'));
  assert.match(MANCC, /<span class="ver">V1040<\/span> A una cadena, esa columna cuenta <b>los kilos que dijo el remito<\/b>/);
  assert.equal((hasta(SG, "router.get('/cc-clientes'", '\r\n});').match(/\$\{kgPapelSql\('di'\)\}/g) || []).length, 2);
});
