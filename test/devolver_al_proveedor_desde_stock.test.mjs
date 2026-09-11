// ══════════════════════════════════════════════════════════════════════════
// DEVOLVERLE AL PROVEEDOR MERCADERÍA QUE ESTÁ EN LA CÁMARA
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 9/9/2026: «Desde el stock también necesitamos poder devolver mercadería al
// proveedor».
//
// Para la cámara es como la merma: la mercadería sale del piso sin venderse. Para la
// plata no: si la partida no estaba firme, baja lo que se le debe al proveedor y el
// costo de la partida. Y deja su remito de devolución.
//
// EL RIESGO de esta salida no está en el alta: está en los lugares que cuentan cuánto
// queda de una partida. Son más de veinte —lo disponible, los cajones que se pueden
// remitir, lo vigente para el costo por kilo, el estado, lo que frena tirar o
// reprocesar, la partida terminada, el libro de movimientos— y uno solo que se olvide
// ofrece para remitir cajones que ya se llevó el proveedor. Por eso acá se corren las
// cuentas de verdad, y hay un test que audita que todo lugar que resta la merma
// reste también esta salida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const SG = leer('src/rutas/sg.js');
const DBSG = leer('src/servicios/db_sg.js');
const PANEL = leer('src/panel.html');

const hasta = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i >= 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i + desde.length);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};
const fn = (nombre) => hasta(SG, 'function ' + nombre + '(', '\r\n}');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── LAS TABLAS REALES DE LA DEVOLUCIÓN, TAL CUAL LAS CREA EL ARRANQUE ──────
function ddl(tabla) {
  const i = DBSG.indexOf('CREATE TABLE IF NOT EXISTS ' + tabla + ' (');
  assert.ok(i > 0, 'no está el CREATE de ' + tabla);
  let d = 0, j = DBSG.indexOf('(', i);
  for (; j < DBSG.length; j++) {
    if (DBSG[j] === '(') d++;
    else if (DBSG[j] === ')') { d--; if (d === 0) break; }
  }
  return DBSG.slice(i, j + 1) + ';';
}

// Una partida de 50 cajones de 20 kg = 1.000 kg a $100/kg ($100.000), en la orden 7
// del proveedor 3.
function base() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  db.exec(`
    CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, proveedor_id INTEGER, flete_a_cargo TEXT, numero TEXT);
    CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY, oc_id INTEGER);
    CREATE TABLE sg_presentaciones (id INTEGER PRIMARY KEY, factor_conversion REAL);
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, codigo_lote TEXT, estado TEXT, bultos REAL,
      kg_reales REAL, kg_por_bulto REAL, presentacion_id INTEGER, oc_item_id INTEGER,
      activo INTEGER DEFAULT 1, costo_base REAL, costo_final REAL, precio_unitario_kg REAL,
      fecha_ingreso TEXT, recepcion_id INTEGER, transformado_de INTEGER, origen TEXT,
      modificado_en TEXT);
    CREATE TABLE sg_lote_decomisos (lote_id INTEGER, kg REAL, bultos REAL);
    CREATE TABLE sg_transformaciones (lote_origen_id INTEGER, kg_transformados REAL,
      bultos_transformados REAL, costo_transferido REAL);
    CREATE TABLE sg_reprocesos (lote_madre_id INTEGER, kg_procesados REAL, bultos_procesados REAL,
      estado TEXT, costo_madre_consumido REAL);
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, activo INTEGER);
    CREATE TABLE sg_despacho_items (id INTEGER PRIMARY KEY, despacho_id INTEGER, lote_id INTEGER,
      kg_despachados REAL, bultos REAL);
    CREATE TABLE sg_devoluciones (id INTEGER PRIMARY KEY, estado TEXT);
    CREATE TABLE sg_devolucion_items (id INTEGER PRIMARY KEY, devolucion_id INTEGER, lote_id INTEGER,
      kg REAL, bultos REAL, destino TEXT, descuenta_al_productor INTEGER);
    CREATE TABLE sg_gastos_directos_lote (lote_id INTEGER, monto REAL, activo INTEGER);
    CREATE TABLE sg_gastos_directos (recepcion_id INTEGER, tipo_gasto TEXT, estado TEXT, activo INTEGER, monto REAL);
    CREATE TABLE sg_recepciones (id INTEGER PRIMARY KEY, oc_id INTEGER);
    INSERT INTO sg_oc VALUES (7, 3, 'nosotros', 'OC-7');
    INSERT INTO sg_oc_items VALUES (70, 7);
    INSERT INTO sg_lotes (id, codigo_lote, estado, bultos, kg_reales, kg_por_bulto, oc_item_id,
      costo_base, costo_final, precio_unitario_kg, origen)
      VALUES (1, 'L-1', 'disponible', 50, 1000, 20, 70, 100000, 100000, 100, 'compra');
  `);
  db.exec(ddl('sg_devoluciones_stock'));
  db.exec(ddl('sg_devolucion_stock_items'));
  return db;
}
let _dev = 0;
function devolver(db, { lote = 1, bultos, kg, descuenta = 1, estado = 'registrada' }) {
  _dev++;
  db.prepare(`INSERT INTO sg_devoluciones_stock (id, numero, proveedor_id, motivo, estado)
    VALUES (?,?,3,'mal estado',?)`).run(_dev, 'SG-DVP-' + _dev, estado);
  db.prepare(`INSERT INTO sg_devolucion_stock_items (devolucion_id, lote_id, bultos, kg, descuenta_al_productor)
    VALUES (?,?,?,?,?)`).run(_dev, lote, bultos, kg, descuenta);
  return _dev;
}

// ══════════════════════════════════════════════════════════════════════════
// 1 · LO QUE QUEDA EN LA CÁMARA
// ══════════════════════════════════════════════════════════════════════════

const F = (() => {
  const cortar = (desde, fin) => hasta(SG, desde, fin);
  const src = [
    cortar('const SUM_TRANSF ', ';\r\n'),
    cortar('const SUM_DECOMISO ', '\r\n'),
    cortar('const SUM_DEV_CAMARA ', ';\r\n'),
    cortar('const SUM_DESPACHADO ', ';\r\n'),
    cortar('const SUM_DEV = (destino)', ';\r\n'),
    cortar('const SUM_DEV_STOCK =', '\r\n'),
    cortar('const KG_VIGENTE_STOCK =', '\r\n'),
    cortar('const KG_DISPONIBLE =', '\r\n'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(src + '\nreturn { KG_VIGENTE_STOCK, KG_DISPONIBLE };')();
})();
const kg = (db, expr) => Number(db.prepare(`SELECT ${expr} AS v FROM sg_lotes l WHERE l.id=1`).get().v);

test('lo devuelto sale de lo DISPONIBLE y de lo VIGENTE', () => {
  const db = base();
  assert.equal(kg(db, F.KG_DISPONIBLE), 1000);
  devolver(db, { bultos: 10, kg: 200 });
  assert.equal(kg(db, F.KG_DISPONIBLE), 800, 'lo devuelto se sigue ofreciendo para vender');
  // De lo vigente también: no está afuera vendido, se lo llevó el proveedor.
  assert.equal(kg(db, F.KG_VIGENTE_STOCK), 800);
});

test('y no aparece como vendido', () => {
  // El panel calcula lo despachado como vigente − disponible. Si la devolución
  // estuviera en una sola de las dos, se vería como venta.
  const db = base();
  db.exec('INSERT INTO sg_despachos VALUES (1, 1); INSERT INTO sg_despacho_items VALUES (1, 1, 1, 300, 15);');
  devolver(db, { bultos: 10, kg: 200 });
  assert.equal(kg(db, F.KG_VIGENTE_STOCK) - kg(db, F.KG_DISPONIBLE), 300);
});

test('una devolución anulada vuelve a estar disponible', () => {
  const db = base();
  devolver(db, { bultos: 10, kg: 200, estado: 'anulada' });
  assert.equal(kg(db, F.KG_DISPONIBLE), 1000);
});

test('lo que hay en cámara (tablero) también la resta', () => {
  const f = hasta(SG, 'const KG_EN_CAMARA =', '\r\n');
  assert.match(f, /- \$\{SUM_DEV_CAMARA\}/);
  // Y el divisor del costo por kilo de los informes.
  assert.match(hasta(SG, 'const KG_VIGENTE = ', '\r\n'), /\+ SUM_DEV_CAMARA \+/);
});

function cajones() {
  const src = ['bultosDespachados', 'bultosDevueltosAStock', 'bultosDecomisado', 'bultosTransformado',
    'bultosDevueltoCamara', 'bultosDisponibles'].map(fn).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(src + '\nreturn bultosDisponibles;')();
}

test('los cajones devueltos no se pueden remitir más', () => {
  // bultosDisponibles es el tope del remito, de la reserva, del reproceso, de separar
  // por calidad y de la propia devolución: si no los restara, esos cajones se
  // remitirían estando en el camión del proveedor.
  const db = base();
  const disp = cajones();
  assert.equal(disp(db, 1), 50);
  devolver(db, { bultos: 10, kg: 200 });
  assert.equal(disp(db, 1), 40);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL COSTO
// ══════════════════════════════════════════════════════════════════════════

function recalcCosto() {
  const src = ['costoTransferido', 'kgDevueltoCamaraConCosto', 'recalcCostoLote'].map(fn).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('r2', src + '\nreturn recalcCostoLote;')(r2);
}
const costoPorKgVigente = (db) => {
  const l = db.prepare('SELECT costo_final FROM sg_lotes WHERE id=1').get();
  return r2(l.costo_final / kg(db, F.KG_VIGENTE_STOCK));
};

test('si la partida no estaba firme, lo devuelto se lleva su costo', () => {
  // Esos kilos no se le van a pagar al proveedor. Si salieran sólo de los kilos, el
  // costo por kilo de lo que queda subiría como si se hubiera tirado.
  const db = base();
  devolver(db, { bultos: 10, kg: 200, descuenta: 1 });
  assert.equal(recalcCosto()(db, 1), 80000);
  assert.equal(costoPorKgVigente(db), 100, 'el costo por kilo de lo que queda cambió');
});

test('si ya estaba firme, el costo se queda: es la pérdida, y es nuestra', () => {
  const db = base();
  devolver(db, { bultos: 10, kg: 200, descuenta: 0 });
  assert.equal(recalcCosto()(db, 1), 100000);
  assert.equal(costoPorKgVigente(db), 125);
});

test('a pizarra: lo devuelto sale al precio que se cierre después, no a cero', () => {
  // El costo no se congela en la devolución: se calcula con el precio de la partida.
  const db = base();
  devolver(db, { bultos: 10, kg: 200, descuenta: 1 });
  db.prepare('UPDATE sg_lotes SET precio_unitario_kg=150, costo_base=150000 WHERE id=1').run();
  assert.equal(recalcCosto()(db, 1), 120000);
});

test('y el flete y la descarga se quedan con lo que quedó', () => {
  // Se pagaron por el camión entero: lo devuelto sale al precio de la partida, sin gastos.
  const db = base();
  db.exec('INSERT INTO sg_gastos_directos_lote VALUES (1, 5000, 1)');
  devolver(db, { bultos: 10, kg: 200, descuenta: 1 });
  assert.equal(recalcCosto()(db, 1), 85000);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LA DEUDA Y LA PARTIDA TERMINADA
// ══════════════════════════════════════════════════════════════════════════

test('baja lo que se le debe, por la misma cuenta que la devolución de un remito', async () => {
  const A = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/sg_acordado.js')).href);
  const db = base();
  db.exec(`CREATE TABLE sg_oc_items2 (x INTEGER);
    ALTER TABLE sg_oc_items ADD COLUMN precio_estimado_por_kg REAL;
    ALTER TABLE sg_oc_items ADD COLUMN modo_carga TEXT;
    ALTER TABLE sg_oc_items ADD COLUMN kg_por_bulto REAL;
    ALTER TABLE sg_oc_items ADD COLUMN presentacion_id INTEGER;
    UPDATE sg_oc_items SET precio_estimado_por_kg=100, modo_carga='bulto', kg_por_bulto=20;
    CREATE TABLE sg_lote_decomisos2 (x INTEGER);`);
  // 50 cajones × $2.000 = $100.000
  assert.equal(A.acordadoDeOC(db, 7).total, 100000);
  devolver(db, { bultos: 10, kg: 200, descuenta: 1 });
  assert.equal(A.acordadoDeOC(db, 7).total, 80000, 'la devolución desde la cámara no bajó la deuda');
  assert.deepEqual(A.recibidoDeOC(db, 7), { bultos: 40, kg: 800 });
  // Con la partida firme no baja.
  const db2 = base();
  db2.exec(`ALTER TABLE sg_oc_items ADD COLUMN precio_estimado_por_kg REAL;
    ALTER TABLE sg_oc_items ADD COLUMN modo_carga TEXT;
    ALTER TABLE sg_oc_items ADD COLUMN kg_por_bulto REAL;
    ALTER TABLE sg_oc_items ADD COLUMN presentacion_id INTEGER;
    UPDATE sg_oc_items SET precio_estimado_por_kg=100, modo_carga='bulto', kg_por_bulto=20;`);
  devolver(db2, { bultos: 10, kg: 200, descuenta: 0 });
  assert.equal(A.acordadoDeOC(db2, 7).total, 100000);
});

test('la partida termina aunque parte se haya devuelto', async () => {
  // Sin esto, la partida a la que se le devolvieron cajones no terminaba nunca y no
  // se podía liquidar.
  const P = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/sg_partida_terminada.js')).href);
  const db = base();
  db.exec('INSERT INTO sg_despachos VALUES (1, 1); INSERT INTO sg_despacho_items VALUES (1, 1, 1, 600, 30);');
  db.exec('INSERT INTO sg_lote_decomisos VALUES (1, 200, 10);');
  devolver(db, { bultos: 10, kg: 200, descuenta: 0 });
  const a = P.avanceDePartida(db, 7);
  assert.equal(a.recibidos, 50);
  assert.equal(a.devueltos, 10);
  assert.equal(a.terminado, 50);
  assert.equal(a.faltan, 0);
  // Y se suma a lo terminado, sin restarse además de lo recibido.
  assert.equal(a.recibidos - a.terminado, 0);
});

test('el panel dice lo mismo que el servidor sobre la partida terminada', () => {
  const src = hasta(PANEL, 'function sgPartTerminada(p){', '\r\n}') + '\n'
    + hasta(PANEL, 'function sgPartFaltaTxt(p){', '\r\n}') + '\n'
    + hasta(PANEL, 'function sgAvanceBarra(vendidos, ingresados, merma, devueltos){', '\r\n}');
  const nr = (n) => Math.round(parseFloat(n) || 0).toLocaleString('es-AR');
  // eslint-disable-next-line no-new-func
  const W = new Function('nr', src + '\nreturn { sgPartTerminada, sgPartFaltaTxt, sgAvanceBarra };')(nr);
  const p = { bultos_recibidos: 50, bultos_vendidos: 30, bultos_merma: 10, bultos_devueltos_prov: 10 };
  assert.equal(W.sgPartTerminada(p), true);
  assert.match(W.sgPartFaltaTxt({ ...p, bultos_vendidos: 20 }), /10 devueltos al proveedor\) y quedan 10/);
  assert.match(W.sgAvanceBarra(30, 50, 10, 10), /100% /);
  assert.match(W.sgAvanceBarra(30, 50, 10, 10), /10 devueltos al proveedor/);
  // Y quien la llama con tres sigue igual.
  assert.match(W.sgAvanceBarra(30, 50, 10), /80% /);
  // El servidor manda el dato en las dos pantallas que lo usan.
  assert.match(SG, /\) AS bultos_devueltos_prov,/);
  assert.match(SG, /bultos_devueltos_prov: devueltosProv,/);
  // Y en la de liquidar NO SÓLO LO MANDA: lo suma a lo terminado. La primera versión
  // de este test sólo miraba que viajara, y sobrevivía a sacarlo de la cuenta — la
  // partida quedaba «con cajones en el depósito» que ya se había llevado el proveedor.
  assert.match(SG, /const terminado = r2\(bultosOut \+ mermaBultos \+ devueltosProv\);/);
  assert.match(SG, /bultos_en_deposito: r2\(Math\.max\(0, bultosIn - terminado\)\),/);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · EL ALTA, CORRIDA
// ══════════════════════════════════════════════════════════════════════════

function handler(ruta) {
  const i = SG.indexOf("router.post('" + ruta + "'");
  assert.ok(i > 0, 'no existe ' + ruta);
  const a = SG.indexOf('(req, res) => {', i);
  const f = SG.indexOf('\r\n});', a);
  return SG.slice(a, f + 3);
}

function montarAlta(db, opts = {}) {
  const hechos = { descontado: [], recalcCosto: 0, recalcEstado: 0 };
  const mundo = {
    getDb: () => db, r2, val: (v) => (v == null || v === '' ? null : v), uid: () => 9,
    KG_DISPONIBLE: F.KG_DISPONIBLE,
    kpbEfectivo: new Function(fn('kpbEfectivo') + '\nreturn kpbEfectivo;')(),
    bultosDisponibles: cajones(),
    exigirPiso: () => opts.pisoAjeno ? 'Ese piso lo maneja otra persona.' : null,
    precioFirmeDetalle: () => opts.firme ? { error: 'firme', firme: { como: 'factura', id: 1 } } : null,
    nextNumero: () => 'SG-DVP-20260911-0001',
    descontarDeUbicacion: (d, lote, bultos, kg, piso) => {
      hechos.descontado.push({ lote, bultos, kg, piso });
      return opts.pisoSinStock ? { ok: false, error: 'En ese piso no hay tanto' } : { ok: true };
    },
    recalcCostoLote: () => { hechos.recalcCosto++; },
    recalcEstadoLote: () => { hechos.recalcEstado++; },
  };
  db.transaction = (fnx) => (...a) => {
    db.exec('BEGIN');
    try { const r = fnx(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  // eslint-disable-next-line no-new-func
  const h = new Function(...Object.keys(mundo), 'return ' + handler('/lotes/:id/devolver-proveedor') + ';')(
    ...Object.values(mundo));
  const correr = (id, body) => {
    let out = null, code = 200;
    h({ params: { id }, body }, { status(c) { code = c; return this; }, json(j) { out = j; return this; } });
    return { code, ...out };
  };
  return { correr, hechos };
}

test('registra la devolución, saca del piso y avisa a la partida', () => {
  const db = base();
  const { correr, hechos } = montarAlta(db);
  const r = correr(1, { bultos: 10, piso_id: 4, motivo: 'Llegó en mal estado', chofer: 'Juan' });
  assert.equal(r.code, 200, r.error);
  assert.equal(r.data.descuenta_al_productor, 1);
  assert.equal(r.data.aviso, null);
  const it = db.prepare('SELECT * FROM sg_devolucion_stock_items').get();
  assert.equal(it.bultos, 10);
  assert.equal(it.kg, 200, 'los kilos salen de los cajones con el factor de la partida');
  assert.equal(it.piso_id, 4);
  const cab = db.prepare('SELECT * FROM sg_devoluciones_stock').get();
  assert.equal(cab.proveedor_id, 3, 'se le devuelve al proveedor de la orden');
  assert.equal(cab.motivo, 'Llegó en mal estado');
  assert.deepEqual(hechos.descontado, [{ lote: 1, bultos: 10, kg: 200, piso: 4 }]);
  assert.equal(hechos.recalcCosto, 1);
  assert.equal(hechos.recalcEstado, 1);
});

test('sin motivo no se registra', () => {
  const db = base();
  const r = montarAlta(db).correr(1, { bultos: 10, piso_id: 4, motivo: '  ' });
  assert.equal(r.code, 400);
  assert.match(r.error, /por qué se devuelve/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_devoluciones_stock').get().n, 0);
});

test('en cajones enteros, y no más de los que quedan', () => {
  const db = base();
  const { correr } = montarAlta(db);
  assert.match(correr(1, { bultos: 2.5, motivo: 'x' }).error, /cajones enteros/);
  assert.match(correr(1, { bultos: 51, motivo: 'x' }).error, /quedan 50 cajón/);
  // Lo ya devuelto cuenta: dos devoluciones no pueden llevarse más de lo que hay.
  devolver(db, { bultos: 45, kg: 900 });
  assert.match(correr(1, { bultos: 10, motivo: 'x' }).error, /quedan 5 cajón/);
});

test('una partida sin orden de compra no tiene a quién devolverle nada', () => {
  // Un reproceso, una apertura: eso es una merma.
  const db = base();
  db.prepare('UPDATE sg_lotes SET oc_item_id=NULL WHERE id=1').run();
  const r = montarAlta(db).correr(1, { bultos: 10, motivo: 'x' });
  assert.equal(r.code, 400);
  assert.match(r.error, /se carga como merma/);
});

test('con la partida firme se registra igual, no descuenta, y lo dice', () => {
  const db = base();
  const r = montarAlta(db, { firme: true }).correr(1, { bultos: 10, piso_id: 4, motivo: 'x' });
  assert.equal(r.code, 200, r.error);
  assert.equal(r.data.descuenta_al_productor, 0);
  assert.match(r.data.aviso, /no le baja lo que se le debe/);
  assert.equal(db.prepare('SELECT descuenta_al_productor d FROM sg_devolucion_stock_items').get().d, 0);
});

test('si el piso no tiene tanto, no queda nada registrado', () => {
  // Una devolución registrada con el piso intacto es un piso que dice tener lo que ya
  // se llevó el proveedor.
  const db = base();
  const r = montarAlta(db, { pisoSinStock: true }).correr(1, { bultos: 10, piso_id: 4, motivo: 'x' });
  assert.equal(r.code, 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_devoluciones_stock').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_devolucion_stock_items').get().n, 0);
});

test('el piso de otro no se toca', () => {
  const db = base();
  const r = montarAlta(db, { pisoAjeno: true }).correr(1, { bultos: 10, piso_id: 4, motivo: 'x' });
  assert.equal(r.code, 403);
});

test('una partida con factor pero sin cajones contados se devuelve igual, en kilos', () => {
  // La pesada en la balanza: tiene factor —el selector cuenta en cajones— pero ningún
  // cajón contado. La pantalla manda las dos cosas y el servidor elige kilos. Si
  // pidiera cajones, esa partida no se podría devolver nunca desde la pantalla.
  const db = base();
  db.prepare('UPDATE sg_lotes SET bultos=NULL WHERE id=1').run();
  const r = montarAlta(db).correr(1, { bultos: 5, kg: 100, motivo: 'x' });
  assert.equal(r.code, 200, r.error);
  assert.equal(db.prepare('SELECT kg FROM sg_devolucion_stock_items').get().kg, 100);
  // Y la pantalla manda las dos.
  const g = hasta(PANEL, 'function sgDvpGuardar(){', '\r\n}');
  assert.match(g, /if \(x\.bultos != null && Number\(x\.bultos\) > 0\) body\.bultos = Number\(x\.bultos\);\r?\n\s*body\.kg = Number\(x\.kg\);/);
});

test('una fecha que no es fecha no se guarda', () => {
  // Se guardaba lo que viniera, y la lista lo dibujaba: una puerta para meter código en
  // la pantalla de quien la abra.
  const db = base();
  const r = montarAlta(db).correr(1, { bultos: 2, motivo: 'x', fecha: '<img src=x onerror=alert(1)>' });
  assert.equal(r.code, 400);
  assert.match(r.error, /fecha no es válida/);
  // Sin fecha, la de hoy.
  assert.equal(montarAlta(db).correr(1, { bultos: 2, motivo: 'x' }).code, 200);
  assert.match(db.prepare('SELECT fecha FROM sg_devoluciones_stock').get().fecha, /^\d{4}-\d{2}-\d{2}$/);
  // Y las dos listas la escapan igual, por si llega por otro lado.
  assert.match(hasta(PANEL, 'function sgDvpLoad(){', '\r\n}'), /escH\(sgDespFechaCorta\(d\.fecha\)\)/);
  assert.match(hasta(PANEL, 'function sgDespListar(modo){', '\r\n}'), /\+escH\(sup\?sgDespFechaCorta\(d\.fecha_despacho\)/);
});

test('el aviso dice QUÉ hizo firme la partida', () => {
  const b = handler('/lotes/:id/devolver-proveedor');
  assert.match(b, /factura: 'llegó la factura', liquidacion: 'se liquidó', marca: 'se marcó a mano como firme'/);
});

test('la partida a granel se devuelve en kilos', () => {
  const db = base();
  db.prepare('UPDATE sg_lotes SET bultos=NULL, kg_por_bulto=NULL WHERE id=1').run();
  const { correr } = montarAlta(db);
  assert.match(correr(1, { kg: 1200, motivo: 'x' }).error, /quedan 1000 kg/);
  const r = correr(1, { kg: 150.5, motivo: 'x' });
  assert.equal(r.code, 200, r.error);
  assert.equal(db.prepare('SELECT kg FROM sg_devolucion_stock_items').get().kg, 150.5);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · ANULARLA
// ══════════════════════════════════════════════════════════════════════════

function montarAnular(db, id, opts = {}) {
  const movidos = [], recalc = [];
  db.transaction = (fnx) => (...a) => fnx(...a);
  const mundo = {
    getDb: () => db, uid: () => 9,
    ubicMover: (d, lote, piso, b, k) => movidos.push({ lote, piso, b, k }),
    recalcCostoLote: (d, l) => recalc.push(['costo', l]),
    recalcEstadoLote: (d, l) => recalc.push(['estado', l]),
    precioFirmeDetalle: () => opts.firme
      ? { error: 'La partida ya tiene factura: anulala primero.', firme: { como: 'factura', id: 1 } } : null,
  };
  // eslint-disable-next-line no-new-func
  const h = new Function(...Object.keys(mundo), 'return ' + handler('/devoluciones-stock/:id/anular') + ';')(
    ...Object.values(mundo));
  const correr = (body) => {
    let out = null, code = 200;
    h({ params: { id }, body }, { status(c) { code = c; return this; }, json(j) { out = j; return this; } });
    return { code, ...out };
  };
  return { correr, movidos, recalc };
}

test('anular devuelve la mercadería al piso del que salió, y avisa a la partida', () => {
  const db = base();
  const id = devolver(db, { bultos: 10, kg: 200 });
  db.prepare('UPDATE sg_devolucion_stock_items SET piso_id=4').run();
  const { correr, movidos, recalc } = montarAnular(db, id);
  assert.equal(correr({ motivo: '' }).code, 400, 'se anuló sin motivo');
  assert.equal(correr({ motivo: 'se cargó a la partida equivocada' }).code, 200);
  assert.equal(db.prepare('SELECT estado FROM sg_devoluciones_stock WHERE id=?').get(id).estado, 'anulada');
  assert.deepEqual(movidos, [{ lote: 1, piso: 4, b: 10, k: 200 }]);
  assert.deepEqual(recalc, [['costo', 1], ['estado', 1]]);
  // Y ya no cuenta como salida.
  assert.equal(kg(db, F.KG_DISPONIBLE), 1000);
});

test('si bajó la deuda y la partida ya quedó firme, no se anula: se reabriría lo cerrado', () => {
  // Llegó la factura del proveedor después de la devolución. Anularla subiría otra vez
  // la deuda y el costo con el precio ya cerrado: se anula primero la factura.
  const db = base();
  const id = devolver(db, { bultos: 10, kg: 200, descuenta: 1 });
  const { correr, movidos } = montarAnular(db, id, { firme: true });
  const r = correr({ motivo: 'se cargó mal' });
  assert.equal(r.code, 400);
  assert.match(r.error, /anulala primero/);
  assert.equal(db.prepare('SELECT estado FROM sg_devoluciones_stock WHERE id=?').get(id).estado, 'registrada');
  assert.deepEqual(movidos, []);
});

test('pero la que no bajó la deuda se anula igual: sólo devuelve la mercadería al piso', () => {
  const db = base();
  const id = devolver(db, { bultos: 10, kg: 200, descuenta: 0 });
  db.prepare('UPDATE sg_devolucion_stock_items SET piso_id=4').run();
  const r = montarAnular(db, id, { firme: true }).correr({ motivo: 'se cargó mal' });
  assert.equal(r.code, 200, r.error);
});

test('y la devolución de un REMITO tiene el mismo freno', () => {
  // Desde la V1043 lo que vuelve al productor baja la deuda de verdad: anularla con la
  // partida firme la subiría otra vez.
  const i = SG.indexOf("router.post('/devoluciones/:id/anular'");
  const b = SG.slice(i, SG.indexOf('\r\n});', i));
  assert.match(b, /dvi\.destino = 'proveedor'/);
  assert.match(b, /COALESCE\(dvi\.descuenta_al_productor, 1\) = 1/);
  assert.match(b, /const firme = precioFirmeDetalle\(db, x\.oc_id, 'anular esta devolución'\);/);
  assert.ok(b.indexOf('precioFirmeDetalle(') < b.indexOf('db.transaction('), 'frena después de anular');
});

test('se marca anulada ANTES de recalcular, o la partida la seguiría contando', () => {
  const b = handler('/devoluciones-stock/:id/anular');
  assert.ok(b.indexOf("SET estado='anulada'") < b.indexOf('recalcCostoLote('),
    'recalcula la partida con la devolución todavía registrada');
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · LA AUDITORÍA: TODO LO QUE RESTA LA MERMA RESTA TAMBIÉN ESTA SALIDA
// ══════════════════════════════════════════════════════════════════════════

test('ninguna cuenta de «lo que queda» se olvidó de la devolución desde la cámara', () => {
  // Es la trampa de esta salida: más de veinte lugares cuentan cuánto queda de una
  // partida, cada uno a mano. Si mañana alguien escribe el veintiuno restando la
  // merma y no esto, acá sale.
  //
  // Los que restan la merma y NO tienen que restar la devolución, con su razón:
  const NO_VAN = {
    // separar por calidad: la madre tiene que conservar al menos los kilos tirados;
    // los cajones devueltos ya los topea bultosDisponibles.
    'const kgTirados = r2(kgDecomisado(db, madre.id));': 'kgTirados',
    // la cubeta es un lote sin orden de compra: la devolución no la acepta.
    'const dispCubeta = ': 'cubeta',
    'const restante = (cubeta.kg_reales': 'cubeta',
  };
  const faltan = [];
  const lineas = SG.split('\n');
  for (let n = 0; n < lineas.length; n++) {
    const l = lineas[n];
    if (!/kgDecomisado\(db, /.test(l)) continue;
    if (/^function kgDecomisado/.test(l)) continue;
    if (Object.keys(NO_VAN).some((k) => l.includes(k))) continue;
    // La devolución puede estar en la misma línea o en la siguiente.
    const tramo = l + (lineas[n + 1] || '');
    if (!/kgDevueltoCamara\(db, /.test(tramo)) faltan.push((n + 1) + ': ' + l.trim().slice(0, 90));
  }
  assert.deepEqual(faltan, [], 'restan la merma y no la devolución desde la cámara');

  // Lo mismo en cajones.
  for (const l of lineas) {
    if (/bultosDecomisado\(db, loteId\) - bultosTransformado\(db, loteId\)/.test(l)) {
      const n = lineas.indexOf(l);
      assert.match(l + lineas[n + 1], /bultosDevueltoCamara\(db, loteId\)/, 'en cajones: ' + l.trim());
    }
  }

  // Y en SQL: toda resta de la merma en una fórmula de kilos del lote.
  const sql = [
    hasta(SG, 'const KG_VIGENTE_STOCK =', '\r\n'),
    hasta(SG, 'const KG_DISPONIBLE =', '\r\n'),
    hasta(SG, 'const KG_EN_CAMARA =', '\r\n'),
    hasta(SG, 'const KG_VIGENTE = ', '\r\n'),
    hasta(SG, 'const KG_VIG = `', '`;'),
    hasta(DBSG, 'const MARGEN_COSTO_KG = `', '`;'),
  ];
  for (const s of sql) {
    assert.match(s, /SUM_DEV_CAMARA|sg_devolucion_stock_items/, 'no resta la devolución: ' + s.slice(0, 60));
  }
});

test('las otras preguntas de «¿ya salió algo de este lote?» también la ven', () => {
  // Separar por calidad y deshacer la separación preguntan si salió algo. Deshacer
  // da de baja el lote hijo, y lo acordado sólo mira lotes activos: la devolución se
  // caería de la deuda sin que nadie la anule.
  const salio = SG.match(/const salio = [^;]+;/g) || [];
  assert.ok(salio.length >= 2);
  for (const s of salio) assert.match(s, /kgDevueltoCamara\(db, /, s.slice(0, 70));
  // Y corregir o borrar el lote frena si tiene una devolución registrada.
  const f = fn('frenosDeEdicionLote');
  assert.match(f, /if \(!soloPrecio && kgDevueltoCamara\(db, loteId\) > 0\.01\)/);
});

test('el libro de movimientos la lista, y así su saldo sigue cerrando', () => {
  // El control del libro compara su saldo contra KG_DISPONIBLE. Sin la línea, diría
  // que no cierra en toda partida con una devolución.
  const i = SG.indexOf("tipo: 'devolucion_proveedor'");
  assert.ok(i > 0, 'el libro no lista la devolución desde la cámara');
  assert.match(SG.slice(i - 700, i + 120), /FROM sg_devolucion_stock_items it\s+JOIN sg_devoluciones_stock ds ON ds\.id = it\.devolucion_id AND ds\.estado = 'registrada'/);
  assert.match(SG.slice(i, i + 120), /kg: -\(Number\(x\.kg\) \|\| 0\)/);
});

test('el arranque crea las tablas ANTES del arreglo de márgenes que las lee', () => {
  // Si no, el primer arranque en una base nueva contesta «no such table» y se saltea
  // el arreglo.
  assert.ok(DBSG.indexOf('CREATE TABLE IF NOT EXISTS sg_devolucion_stock_items')
    < DBSG.indexOf('const MARGEN_COSTO_KG = `'));
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · LA PANTALLA, LOS PERMISOS Y LA LIMPIEZA
// ══════════════════════════════════════════════════════════════════════════

test('la solapa está en Stock, y la ventana abre en blanco', () => {
  assert.match(PANEL, /onclick="sgStockTab\('devprov'\)">↩️ Devoluciones al proveedor<\/button>/);
  assert.match(PANEL, /var SG_STOCK_TABS = \['partidas', 'pisos', 'merma', 'devprov'\];/);
  const f = hasta(PANEL, 'function sgDvpAbrir(){', '\r\n}');
  // Un formulario que sólo se esconde conserva lo de la vez pasada: sería devolverle
  // al proveedor la partida de otro.
  assert.match(f, /SGDVP\.sel = null;/);
  assert.match(f, /eid\('sg-dvp-motivo'\)\.value = ''/);
  assert.match(f, /eid\('sg-dvp-chofer'\)\.value = ''/);
  assert.match(f, /sgModalArriba\('sg-dvp-modal'\)/);
});

test('si no bajó la deuda, la ventana no se cierra: queda lo que hay que leer', () => {
  const g = hasta(PANEL, 'function sgDvpGuardar(){', '\r\n}');
  const iAviso = g.indexOf('if (r.data.aviso) {');
  const iCierre = g.indexOf("closeMB('sg-dvp-modal')");
  assert.ok(iAviso > 0 && iCierre > iAviso);
  assert.match(g.slice(iAviso, iCierre), /return;/);
  // Y el remito sale solo.
  assert.match(g, /sgDvpImprimir\(r\.data\.id\);/);
});

test('el remito de devolución trae lo que hay que firmar', () => {
  const src = hasta(PANEL, 'function sgDvpImprimir(id){', '\r\n}');
  const show = hasta(PANEL, 'function sgMilShow(n){', '\r\n}');
  let html = null;
  const mundo = {
    api: () => ({ then: (cb) => cb({ ok: true, data: { numero: 'SG-DVP-1', fecha: '2026-09-11',
      proveedor_nombre: 'ABRAHAM VICTOR', proveedor_cuit: '20123456789', motivo: 'Llegó en mal estado',
      chofer: 'Juan', dominio: 'AB123CD', estado: 'registrada',
      items: [{ oc_numero: 'OC-7', codigo_lote: 'L-1', producto_nombre: 'Tomate', envase_nombre: 'Cajón',
        bultos: 10, kg: 185 }] } }) }),
    escH: (v) => String(v == null ? '' : v),
    nr: (n) => Math.round(parseFloat(n) || 0).toLocaleString('es-AR'),
    toast: () => {},
    _ccImprimir: (t, h) => { html = h; },
  };
  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(mundo), show + '\n' + src + '\nreturn sgDvpImprimir;')(...Object.values(mundo))(1);
  for (const dato of ['Remito de devolución SG-DVP-1', 'ABRAHAM VICTOR', 'CUIT 20123456789',
    'Llegó en mal estado', 'Juan · AB123CD', 'OC-7', 'L-1', 'Tomate', 'Cajón', 'Recibí conforme (proveedor)']) {
    assert.ok(html.includes(dato), 'al remito le falta: ' + dato);
  }
  // 185 kg en 10 cajones: 18,5 por bulto, con decimales.
  assert.match(html, /<td class="d">10<\/td><td class="d">18,5<\/td><td class="d">185<\/td>/);
});

test('es de Stock, y la dirección nueva está declarada', () => {
  // El prefijo matchea por segmento completo: ni sg/lotes ni sg/devoluciones (que es
  // de Ventas) cubren sg/devoluciones-stock. Sin declararla, exigirNivel la dejaría
  // pasar para cualquiera con sesión.
  const P = leer('src/servicios/ensure_api_prefijos.js');
  assert.match(P, /\['sg-stock',\s+'[^']*sg\/devoluciones-stock'\]/);
  assert.match(SG, /router\.post\('\/lotes\/:id\/devolver-proveedor', requireAuth,/);
  assert.match(SG, /router\.post\('\/devoluciones-stock\/:id\/anular', requireAuth,/);
  // Y el botón de anular se ofrece por nivel, no a cualquiera.
  assert.match(hasta(PANEL, 'function sgDvpLoad(){', '\r\n}'), /lnbPuedeAnular\('sg-stock'\)/);
});

test('leerlas también es de Stock: la lista tiene el CUIT y el motivo de cada proveedor', () => {
  // El prefijo de escritura sólo protege escribir. La lista de devoluciones de remito ya
  // estaba cerrada a quien no tiene el módulo; ésta no puede quedar abierta.
  const PER = leer('src/servicios/permisos.js');
  assert.match(PER, /'\/api\/sg\/devoluciones-stock',/);
});

test('el selector no ofrece lo que va a rebotar, y después del aviso no deja cargar otra', () => {
  const e = hasta(PANEL, 'function sgDvpElegir(tipo, fuenteId, kg, meta){', '\r\n}');
  assert.match(e, /if \(meta\.lote && !meta\.lote\.proveedor_id\)/);
  assert.match(e, /if \(SGDVP\.hecho\) return;/);
  const g = hasta(PANEL, 'function sgDvpGuardar(){', '\r\n}');
  const i = g.indexOf('if (r.data.aviso) {');
  const aviso = g.slice(i, g.indexOf('return;', i));
  // Queda como resultado: sin buscador, sin botón de registrar, con Cerrar.
  assert.match(aviso, /SGDVP\.hecho = true;/);
  assert.match(aviso, /eid\('sg-dvp-pick'\)\.innerHTML = '';/);
  assert.match(aviso, /eid\('sg-dvp-btn'\)\.style\.display = 'none';/);
  assert.match(aviso, /eid\('sg-dvp-cancelar'\)\.textContent = 'Cerrar';/);
  // Y abrir otra vez lo deja listo.
  const a = hasta(PANEL, 'function sgDvpAbrir(){', '\r\n}');
  assert.match(a, /SGDVP\.hecho = false;/);
  assert.match(a, /eid\('sg-dvp-btn'\)\.style\.display = '';/);
});

test('el libro de movimientos la dibuja con su ícono', () => {
  assert.match(PANEL, /devolucion:'↩️', devolucion_proveedor:'↩️' \};/);
});

test('la limpieza de Stock se las lleva, los renglones antes que la cabecera', () => {
  const M = leer('src/servicios/sg_limpieza_mapa.js');
  const i = M.indexOf("tabla: 'sg_devolucion_stock_items'");
  const j = M.indexOf("tabla: 'sg_devoluciones_stock'");
  assert.ok(i > 0 && j > i);
  assert.ok(j < M.indexOf("tabla: 'sg_lotes'"));
});

// ══════════════════════════════════════════════════════════════════════════
// 8 · EL MANUAL DICE LO QUE EL CÓDIGO HACE
// ══════════════════════════════════════════════════════════════════════════

const plano = (t) => String(t).replace(/'\s*\+\s*'/g, '');
const MAN = plano(hasta(PANEL, 'SG_MANUAL.stock = ', 'SG_MANUAL.oc = '));

test('el manual tiene la entrada, con su versión', () => {
  assert.match(MAN, /<h3>↩️ Devolverle mercadería al proveedor <span class="ver">V1044<\/span><\/h3>/);
  assert.match(MAN, /<span class="ver">V1044<\/span> Se le puede <b>devolver mercadería al proveedor desde la cámara<\/b>/);
});

test('«baja lo disponible, los cajones y el piso» — y así es', () => {
  assert.match(MAN, /baja lo <b>disponible<\/b>, los <b>cajones<\/b> y el <b>piso<\/b>/);
  assert.match(hasta(SG, 'const KG_DISPONIBLE =', '\r\n'), /SUM_DEV_CAMARA/);
  assert.match(fn('bultosDisponibles'), /bultosDevueltoCamara/);
  assert.match(handler('/lotes/:id/devolver-proveedor'), /descontarDeUbicacion\(db, lote\.id, bultos, kg, pisoId\)/);
});

test('«si no tiene el precio firme baja la deuda y el costo; si lo tiene, es pérdida»', () => {
  assert.match(MAN, /<b>baja lo que se le debe al proveedor<\/b>, por producto y a su precio, y <b>baja el costo de la partida<\/b>/);
  // Y dice lo que pasa con los gastos, que es lo que el test de arriba mide: el flete y
  // la descarga quedan en lo que queda.
  assert.match(MAN, /El flete y la descarga se pagaron por el camión entero y quedan repartidos en lo que queda/);
  assert.match(MAN, /<b>no le baja la deuda<\/b>: es pérdida nuestra/);
  assert.match(fn('kgDevueltoCamaraConCosto'), /it\.descuenta_al_productor = 1/);
});

test('«sólo una partida que viene de una orden de compra»', () => {
  assert.match(MAN, /Sólo se puede devolver una partida que <b>viene de una orden de compra<\/b>/);
  assert.match(handler('/lotes/:id/devolver-proveedor'), /if \(!lote\.oc_id \|\| !lote\.proveedor_id\)/);
});

test('«anular la devuelve al piso del que salió»', () => {
  assert.match(MAN, /la mercadería <b>vuelve al piso del que salió<\/b>/);
  assert.match(handler('/devoluciones-stock/:id/anular'), /if \(it\.piso_id\) ubicMover\(db, it\.lote_id, it\.piso_id,/);
});
