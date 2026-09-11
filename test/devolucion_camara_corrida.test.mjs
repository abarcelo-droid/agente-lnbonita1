// ══════════════════════════════════════════════════════════════════════════
// LA DEVOLUCIÓN AL PROVEEDOR DESDE LA CÁMARA, CORRIDA DE PUNTA A PUNTA
// ══════════════════════════════════════════════════════════════════════════
//
// Complementa a devolver_al_proveedor_desde_stock.test.mjs, y existe por la tercera
// revisión del cambio: 45 mutaciones sobre el código de la devolución sobrevivieron a
// aquellos tests. Verificaban demasiado con «el código dice X» —una expresión regular
// sobre el texto— y demasiado poco corriendo el código. Una devolución anulada que
// seguía restando en cuatro de las cinco cuentas pasaba en verde. Un «-» cambiado por
// «+» también.
//
// Acá se registra y se anula POR LOS ENDPOINTS DE VERDAD, con las funciones de verdad
// de los pisos, la numeración y el costo, contra una base. Lo único simulado es lo que
// vive en otros módulos (la sesión, si la partida está firme) y el estado del lote.
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
const A = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/sg_acordado.js')).href);
const P = await import(pathToFileURL(path.join(RAIZ, 'src/servicios/sg_partida_terminada.js')).href);

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const hasta = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i >= 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i + desde.length);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};
const fn = (nombre) => hasta(SG, 'function ' + nombre + '(', '\r\n}');

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

// ── LAS FÓRMULAS Y LAS FUNCIONES DE VERDAD ────────────────────────────────
const KG_DISPONIBLE = (() => {
  const src = [
    hasta(SG, 'const SUM_TRANSF ', ';\r\n'), hasta(SG, 'const SUM_DECOMISO ', '\r\n'),
    hasta(SG, 'const SUM_DEV_CAMARA ', ';\r\n'), hasta(SG, 'const SUM_DESPACHADO ', ';\r\n'),
    hasta(SG, 'const SUM_DEV = (destino)', ';\r\n'), hasta(SG, 'const SUM_DEV_STOCK =', '\r\n'),
    hasta(SG, 'const KG_DISPONIBLE =', '\r\n'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(src + '\nreturn KG_DISPONIBLE;')();
})();

const REALES = (() => {
  const nombres = ['val', 'kpbEfectivo', 'bultosDespachados', 'bultosDevueltosAStock', 'bultosDecomisado',
    'bultosTransformado', 'bultosDevueltoCamara', 'bultosDisponibles', 'kgDevueltoCamara',
    'kgDevueltoCamaraConCosto', 'ubicacionesDeLote', 'ubicMover', 'descontarDeUbicacion', 'nextNumero',
    'costoTransferido', 'recalcCostoLote', 'kgDecomisado', 'kgTransformado', 'frenosDeEdicionLote'];
  const src = nombres.map(fn).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('r2', 'precioFirmeDetalle', src + '\nreturn {' + nombres.join(',') + '};')(r2, () => null);
})();

// Una partida de 50 cajones de 20 kg = 1.000 kg a $100/kg, repartida en dos pisos
// (30 en la Cámara 1, 20 en la Cámara 2), de la orden 7 del proveedor 3, pactada a
// $2.000 el cajón: se le deben $100.000.
function base(opts = {}) {
  const bultos = opts.bultos != null ? opts.bultos : 50;
  const kg = opts.kg != null ? opts.kg : 1000;
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  db.exec(`
    CREATE TABLE sg_proveedores (id INTEGER PRIMARY KEY, razon_social TEXT, cuit TEXT);
    CREATE TABLE sg_productos (id INTEGER PRIMARY KEY, nombre TEXT);
    CREATE TABLE sg_envases (id INTEGER PRIMARY KEY, nombre TEXT);
    CREATE TABLE sg_pisos (id INTEGER PRIMARY KEY, nombre TEXT, codigo TEXT, orden INTEGER);
    CREATE TABLE sg_lote_ubicaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER, piso_id INTEGER,
      bultos REAL NOT NULL DEFAULT 0, kg REAL NOT NULL DEFAULT 0, UNIQUE(lote_id, piso_id));
    CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, proveedor_id INTEGER, flete_a_cargo TEXT, numero TEXT);
    CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY, oc_id INTEGER, precio_estimado_por_kg REAL,
      modo_carga TEXT, kg_por_bulto REAL, presentacion_id INTEGER);
    CREATE TABLE sg_presentaciones (id INTEGER PRIMARY KEY, factor_conversion REAL);
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, codigo_lote TEXT, estado TEXT, bultos REAL,
      kg_reales REAL, kg_por_bulto REAL, presentacion_id INTEGER, oc_item_id INTEGER,
      activo INTEGER DEFAULT 1, costo_base REAL, costo_final REAL, precio_unitario_kg REAL,
      fecha_ingreso TEXT, recepcion_id INTEGER, transformado_de INTEGER, reproceso_id INTEGER,
      origen TEXT, modificado_en TEXT, producto_id INTEGER, envase_id INTEGER);
    CREATE TABLE sg_lote_decomisos (lote_id INTEGER, kg REAL, bultos REAL);
    CREATE TABLE sg_transformaciones (lote_origen_id INTEGER, kg_transformados REAL,
      bultos_transformados REAL, costo_transferido REAL, fecha TEXT);
    CREATE TABLE sg_reprocesos (lote_madre_id INTEGER, kg_procesados REAL, bultos_procesados REAL,
      estado TEXT, costo_madre_consumido REAL, fecha TEXT);
    CREATE TABLE sg_despachos (id INTEGER PRIMARY KEY, activo INTEGER);
    CREATE TABLE sg_despacho_items (id INTEGER PRIMARY KEY, despacho_id INTEGER, lote_id INTEGER,
      kg_despachados REAL, bultos REAL);
    CREATE TABLE sg_devoluciones (id INTEGER PRIMARY KEY, estado TEXT);
    CREATE TABLE sg_devolucion_items (id INTEGER PRIMARY KEY, devolucion_id INTEGER, lote_id INTEGER,
      kg REAL, bultos REAL, destino TEXT, descuenta_al_productor INTEGER);
    CREATE TABLE sg_gastos_directos_lote (lote_id INTEGER, monto REAL, activo INTEGER);
    CREATE TABLE sg_gastos_directos (recepcion_id INTEGER, tipo_gasto TEXT, estado TEXT, activo INTEGER, monto REAL);
    CREATE TABLE sg_recepciones (id INTEGER PRIMARY KEY, oc_id INTEGER);
    CREATE TABLE sg_lote_reclasificaciones (id INTEGER PRIMARY KEY, lote_origen_id INTEGER,
      lote_destino_id INTEGER, anulada_en TEXT);
    INSERT INTO sg_proveedores VALUES (3, 'ABRAHAM VICTOR', '20123456789');
    INSERT INTO sg_productos VALUES (1, 'Tomate');
    INSERT INTO sg_envases VALUES (1, 'Cajón');
    INSERT INTO sg_pisos VALUES (4, 'Cámara 1', 'C1', 1), (5, 'Cámara 2', 'C2', 2);
    INSERT INTO sg_oc VALUES (7, 3, 'nosotros', 'OC-7');
    INSERT INTO sg_oc_items VALUES (70, 7, 100, 'bulto', 20, NULL);
  `);
  db.prepare(`INSERT INTO sg_lotes (id, codigo_lote, estado, bultos, kg_reales, kg_por_bulto, oc_item_id,
      costo_base, costo_final, precio_unitario_kg, origen, producto_id, envase_id)
    VALUES (1, 'L-1', 'disponible', ?, ?, 20, 70, ?, ?, 100, 'compra', 1, 1)`)
    .run(bultos, kg, kg * 100, kg * 100);
  if (opts.unPiso) {
    db.prepare('INSERT INTO sg_lote_ubicaciones (lote_id, piso_id, bultos, kg) VALUES (1, 4, ?, ?)').run(bultos, kg);
  } else if (!opts.sinPisos) {
    db.exec(`INSERT INTO sg_lote_ubicaciones (lote_id, piso_id, bultos, kg) VALUES (1, 4, 30, 600), (1, 5, 20, 400);`);
  }
  db.exec(ddl('sg_devoluciones_stock'));
  db.exec(ddl('sg_devolucion_stock_items'));
  db.transaction = (f) => (...a) => {
    db.exec('BEGIN');
    try { const r = f(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return db;
}

function handler(ancla) {
  const i = SG.indexOf(ancla);
  assert.ok(i > 0, 'no está: ' + ancla);
  const a = SG.indexOf('(req, res) => {', i);
  return SG.slice(a, SG.indexOf('\r\n});', a) + 3);
}
const correrCon = (h, req) => {
  let out = null, code = 200;
  h(req, { status(c) { code = c; return this; }, json(j) { out = j; return this; } });
  return { code, ...out };
};

// El alta, con todo lo de verdad salvo lo que vive en otros módulos. Lo simulado ANOTA
// con qué se lo llamó, para que llamarlo con el dato equivocado también se note.
function alta(db, opts = {}) {
  const log = { firme: [], piso: [], costo: [], estado: [], margen: [], disp: 0 };
  const mundo = {
    getDb: () => db, r2, val: REALES.val, uid: () => 9, KG_DISPONIBLE,
    kpbEfectivo: REALES.kpbEfectivo,
    bultosDisponibles: (d, id) => {
      log.disp++;
      // La segunda consulta es la de ADENTRO de la transacción: simular que otro se
      // llevó los cajones entre las dos.
      if (opts.seLlevanEnElMedio && log.disp === 2) return 0;
      return REALES.bultosDisponibles(d, id);
    },
    exigirPiso: (d, req, pisoId) => { log.piso.push(pisoId); return opts.pisoAjeno ? 'Ese piso es de otro.' : null; },
    precioFirmeDetalle: (d, ocId) => {
      log.firme.push(ocId);
      return opts.firme ? { error: 'firme', firme: { como: opts.como || 'factura', id: 1 } } : null;
    },
    nextNumero: REALES.nextNumero,
    descontarDeUbicacion: REALES.descontarDeUbicacion,
    recalcCostoLote: (d, id) => {
      // Tiene que correr DESPUÉS de anotar la devolución: si no, recalcula sin ella.
      log.costo.push(d.prepare('SELECT COUNT(*) n FROM sg_devolucion_stock_items').get().n);
      return REALES.recalcCostoLote(d, id);
    },
    recalcEstadoLote: (d, id) => { log.estado.push(d.prepare('SELECT COUNT(*) n FROM sg_devolucion_stock_items').get().n); },
    recalcMargenDespachos: (d, id) => { log.margen.push(id); },
  };
  // eslint-disable-next-line no-new-func
  const h = new Function(...Object.keys(mundo), 'return ' + handler("router.post('/lotes/:id/devolver-proveedor'") + ';')(
    ...Object.values(mundo));
  return { log, correr: (body, id = 1) => correrCon(h, { params: { id }, body }) };
}

function anular(db, opts = {}) {
  const log = { firme: [], margen: [] };
  const mundo = {
    getDb: () => db, uid: () => 9,
    ubicMover: REALES.ubicMover,
    recalcCostoLote: REALES.recalcCostoLote,
    recalcEstadoLote: () => {},
    recalcMargenDespachos: (d, id) => { log.margen.push(id); },
    precioFirmeDetalle: (d, ocId) => { log.firme.push(ocId); return opts.firme ? { error: 'firme', firme: {} } : null; },
  };
  // eslint-disable-next-line no-new-func
  const h = new Function(...Object.keys(mundo), 'return ' + handler("router.post('/devoluciones-stock/:id/anular'") + ';')(
    ...Object.values(mundo));
  return { log, correr: (id, body) => correrCon(h, { params: { id }, body }) };
}

const pisos = (db) => db.prepare('SELECT piso_id, bultos, kg FROM sg_lote_ubicaciones WHERE lote_id=1 ORDER BY piso_id')
  .all().map((x) => ({ piso: x.piso_id, bultos: x.bultos, kg: x.kg }));
const foto = (db) => ({
  // Las dos piezas de JS: las usan el estado del lote, los topes de tirar, transformar
  // y reprocesar, y los divisores del costo por kilo. Una devolución anulada que
  // siguiera sumando acá dejaría todos ésos mal sin tocar ninguna de las otras cuentas.
  kgCamara: REALES.kgDevueltoCamara(db, 1),
  cajonesCamara: REALES.bultosDevueltoCamara(db, 1),
  disponible: r2(db.prepare(`SELECT ${KG_DISPONIBLE} AS v FROM sg_lotes l WHERE l.id=1`).get().v),
  cajones: REALES.bultosDisponibles(db, 1),
  costo: r2(REALES.recalcCostoLote(db, 1)),
  deuda: A.acordadoDeOC(db, 7).total,
  recibido: A.recibidoDeOC(db, 7),
  terminado: P.avanceDePartida(db, 7).terminado,
  pisos: pisos(db),
});

// ══════════════════════════════════════════════════════════════════════════
// 1 · IDA Y VUELTA: ANULAR DEJA TODO DONDE ESTABA
// ══════════════════════════════════════════════════════════════════════════

test('registrar mueve las SEIS cuentas, y anular las devuelve todas', () => {
  // Una devolución anulada que siguiera contando en cualquiera de ellas deja la
  // partida mal: cajones que no se pueden remitir, un costo o una deuda bajados de
  // más, una partida que se da por terminada con mercadería adentro.
  const db = base();
  const antes = foto(db);
  assert.deepEqual(antes, { kgCamara: 0, cajonesCamara: 0, disponible: 1000, cajones: 50, costo: 100000, deuda: 100000,
    recibido: { bultos: 50, kg: 1000 }, terminado: 0,
    pisos: [{ piso: 4, bultos: 30, kg: 600 }, { piso: 5, bultos: 20, kg: 400 }] });

  const r = alta(db).correr({ bultos: 10, kg: 200, piso_id: 5, motivo: 'Llegó en mal estado' });
  assert.equal(r.code, 200, r.error);
  assert.deepEqual(foto(db), { kgCamara: 200, cajonesCamara: 10, disponible: 800, cajones: 40, costo: 80000, deuda: 80000,
    recibido: { bultos: 40, kg: 800 }, terminado: 10,
    pisos: [{ piso: 4, bultos: 30, kg: 600 }, { piso: 5, bultos: 10, kg: 200 }] });

  const anu = anular(db);
  const an = anu.correr(r.data.id, { motivo: 'se cargó a la partida equivocada' });
  assert.equal(an.code, 200, an.error);
  // Antes de anular se le preguntó a SU orden si ya estaba firme.
  assert.deepEqual(anu.log.firme, [7]);
  assert.deepEqual(foto(db), antes, 'la anulación no dejó la partida como estaba');
});

test('anular dos veces no mueve dos veces', () => {
  const db = base();
  const r = alta(db).correr({ bultos: 10, kg: 200, piso_id: 5, motivo: 'x' });
  const an = anular(db);
  assert.equal(an.correr(r.data.id, { motivo: 'uno' }).code, 200);
  const segunda = an.correr(r.data.id, { motivo: 'dos' });
  assert.equal(segunda.code, 404);
  assert.deepEqual(pisos(db), [{ piso: 4, bultos: 30, kg: 600 }, { piso: 5, bultos: 20, kg: 400 }]);
});

test('con la partida firme, la ida baja cajones y pisos pero ni el costo ni la deuda', () => {
  const db = base();
  const r = alta(db, { firme: true }).correr({ bultos: 10, kg: 200, piso_id: 5, motivo: 'x' });
  assert.equal(r.code, 200, r.error);
  const f = foto(db);
  assert.equal(f.cajones, 40);
  assert.equal(f.costo, 100000);
  assert.equal(f.deuda, 100000);
  assert.deepEqual(f.recibido, { bultos: 50, kg: 1000 });
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL ALTA, CON LOS DATOS QUE SE LLEVA
// ══════════════════════════════════════════════════════════════════════════

test('los kilos salen con el factor REAL de la partida, no con el nominal', () => {
  // 64 cajones que pesaron 1.184 kg: cada uno es de 18,5 kg aunque el nominal diga 20.
  // Con el nominal, 10 cajones serían 200 kg y el piso quedaría con kilos que no hay.
  const db = base({ bultos: 64, kg: 1184, unPiso: true });
  const r = alta(db).correr({ bultos: 10, kg: 185, piso_id: 4, motivo: 'x' });
  assert.equal(r.code, 200, r.error);
  assert.equal(db.prepare('SELECT kg FROM sg_devolucion_stock_items').get().kg, 185);
  assert.deepEqual(pisos(db), [{ piso: 4, bultos: 54, kg: 999 }]);
});

test('se le pregunta a la partida correcta y al piso correcto', () => {
  const db = base();
  const { correr, log } = alta(db);
  correr({ bultos: 10, kg: 200, piso_id: 5, motivo: 'x' });
  assert.deepEqual(log.firme, [7], '¿está firme? se le preguntó a otra orden');
  assert.deepEqual(log.piso, [5], 'el permiso del piso se pidió sobre otro piso');
  // El costo y el estado se recalculan DESPUÉS de anotar la devolución.
  assert.deepEqual(log.costo, [1]);
  assert.deepEqual(log.estado, [1]);
  assert.deepEqual(log.margen, [1]);
});

test('guarda lo que se cargó: proveedor, motivo, fecha, chofer y dominio', () => {
  const db = base();
  const r = alta(db).correr({ bultos: 10, kg: 200, piso_id: 5, motivo: 'Calibre distinto',
    fecha: '2026-09-11', chofer: 'Juan Pérez', dominio: 'AB123CD' });
  const cab = db.prepare('SELECT * FROM sg_devoluciones_stock WHERE id=?').get(r.data.id);
  assert.equal(cab.proveedor_id, 3);
  assert.equal(cab.motivo, 'Calibre distinto');
  assert.equal(cab.fecha, '2026-09-11');
  assert.equal(cab.chofer, 'Juan Pérez');
  assert.equal(cab.dominio, 'AB123CD');
  assert.equal(cab.estado, 'registrada');
  assert.equal(db.prepare('SELECT piso_id FROM sg_devolucion_stock_items').get().piso_id, 5);
});

test('dos devoluciones el mismo día tienen números distintos', () => {
  // Con la numeración mirando otra tabla, la segunda del día chocaría con la primera.
  const db = base();
  const { correr } = alta(db);
  const a = correr({ bultos: 5, kg: 100, piso_id: 4, motivo: 'x' });
  const b = correr({ bultos: 5, kg: 100, piso_id: 4, motivo: 'y' });
  assert.equal(a.code, 200, a.error);
  assert.equal(b.code, 200, b.error);
  assert.match(a.data.numero, /^SG-DVP-\d{8}-0001$/);
  assert.match(b.data.numero, /^SG-DVP-\d{8}-0002$/);
});

test('no acepta cajones negativos, ni una partida dada de baja', () => {
  const db = base();
  const { correr } = alta(db);
  assert.equal(correr({ bultos: -5, kg: -100, piso_id: 4, motivo: 'x' }).code, 400);
  db.prepare("UPDATE sg_lotes SET estado='bajado' WHERE id=1").run();
  const r = correr({ bultos: 5, kg: 100, piso_id: 4, motivo: 'x' });
  assert.equal(r.code, 400);
  assert.match(r.error, /dada de baja/);
});

test('si otro se llevó los cajones entre la validación y el guardado, no queda nada a medias', () => {
  const db = base();
  const r = alta(db, { seLlevanEnElMedio: true }).correr({ bultos: 10, kg: 200, piso_id: 5, motivo: 'x' });
  assert.equal(r.code, 400);
  assert.match(r.error, /Alguien acaba de sacar cajones/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_devoluciones_stock').get().n, 0);
  assert.deepEqual(pisos(db), [{ piso: 4, bultos: 30, kg: 600 }, { piso: 5, bultos: 20, kg: 400 }]);
});

test('el aviso de partida firme dice qué la hizo firme', () => {
  const db = base();
  assert.match(alta(db, { firme: true, como: 'liquidacion' })
    .correr({ bultos: 1, kg: 20, piso_id: 4, motivo: 'x' }).data.aviso, /se liquidó/);
  assert.match(alta(db, { firme: true, como: 'marca' })
    .correr({ bultos: 1, kg: 20, piso_id: 4, motivo: 'x' }).data.aviso, /se marcó a mano como firme/);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LA DEUDA, EL COSTO Y LA PARTIDA TERMINADA, CON DATOS
// ══════════════════════════════════════════════════════════════════════════

test('dos devoluciones IGUALES descuentan dos veces', () => {
  // Dos renglones idénticos —mismo lote, mismos cajones— son dos devoluciones. Si la
  // cuenta los juntara como uno, al proveedor se le seguiría debiendo uno.
  const db = base();
  const { correr } = alta(db);
  correr({ bultos: 5, kg: 100, piso_id: 4, motivo: 'x' });
  correr({ bultos: 5, kg: 100, piso_id: 4, motivo: 'x' });
  assert.equal(A.acordadoDeOC(db, 7).total, 80000);
  assert.deepEqual(A.recibidoDeOC(db, 7), { bultos: 40, kg: 800 });
});

test('la partida que salió entera —vendida, tirada y devuelta— queda terminada y se deja liquidar', () => {
  const db = base();
  db.exec('INSERT INTO sg_despachos VALUES (1, 1); INSERT INTO sg_despacho_items VALUES (1, 1, 1, 600, 30);');
  db.exec('INSERT INTO sg_lote_decomisos VALUES (1, 200, 10);');
  alta(db, { firme: true }).correr({ bultos: 10, kg: 200, piso_id: 5, motivo: 'x' });
  const a = P.avanceDePartida(db, 7);
  assert.equal(a.terminada, true);
  assert.equal(P.frenoPartidaSinTerminar(db, 7), null, 'la partida terminada no se deja liquidar');
});

test('las dos pantallas de partidas cuentan lo devuelto con su SQL de verdad', () => {
  // partidasRecibidas y ventaDePartida tienen su propia consulta. Se corren las dos.
  const db = base();
  alta(db).correr({ bultos: 10, kg: 200, piso_id: 5, motivo: 'x' });
  const sub = hasta(SG, '(SELECT COALESCE(SUM(it.bultos),0) FROM sg_devolucion_stock_items it', ') AS bultos_devueltos_prov');
  const q1 = sub.slice(0, sub.length - ' AS bultos_devueltos_prov'.length);
  assert.equal(db.prepare(`SELECT ${q1} AS n FROM sg_oc o WHERE o.id = 7`).get().n, 10);
  const i = SG.indexOf('const devueltosProv = r2(db.prepare(`');
  const q2 = SG.slice(SG.indexOf('`', i) + 1, SG.indexOf('`).get(ocId)', i));
  assert.equal(db.prepare(q2).get(7).s, 10);
  // Y lo vendido de partidasRecibidas es neto de lo que el cliente devolvió al piso.
  db.exec(`INSERT INTO sg_despachos VALUES (1, 1); INSERT INTO sg_despacho_items VALUES (1, 1, 1, 400, 20);
    INSERT INTO sg_devoluciones VALUES (1, 'registrada');
    INSERT INTO sg_devolucion_items VALUES (1, 1, 1, 100, 5, 'stock', 1);`);
  const iv = SG.indexOf('((SELECT COALESCE(SUM(di.bultos),0) FROM sg_despacho_items di');
  const qv = SG.slice(iv, SG.indexOf(') AS bultos_vendidos,', iv) + 1);
  assert.equal(db.prepare(`SELECT ${qv} AS n FROM sg_oc o WHERE o.id = 7`).get().n, 15);
});

test('el costo con descarga de la recepción: lo devuelto sale al precio, la descarga se queda', () => {
  // La descarga se reparte por kilo entre los lotes de la recepción y se pagó por el
  // camión entero: sigue siendo costo de lo que quedó.
  const db = base();
  db.exec(`INSERT INTO sg_recepciones VALUES (1, 7);
    INSERT INTO sg_gastos_directos VALUES (1, 'descarga_ingreso', 'valorizado', 1, 6000);`);
  db.prepare('UPDATE sg_lotes SET recepcion_id=1 WHERE id=1').run();
  assert.equal(r2(REALES.recalcCostoLote(db, 1)), 106000);
  alta(db).correr({ bultos: 10, kg: 200, piso_id: 5, motivo: 'x' });
  assert.equal(r2(REALES.recalcCostoLote(db, 1)), 86000);
});

test('corregir las cantidades de un lote con una devolución se frena; el precio no', () => {
  const db = base();
  alta(db).correr({ bultos: 10, kg: 200, piso_id: 5, motivo: 'x' });
  const cant = REALES.frenosDeEdicionLote(db, 1);
  assert.ok(cant && /anulá primero esa devolución/.test(cant.error), 'corregir cantidades no se frenó');
  const precio = REALES.frenosDeEdicionLote(db, 1, { soloPrecio: true });
  assert.ok(!precio || !/devolución/.test(precio.error || ''), 'la devolución frena también el precio');
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LAS LISTAS, CORRIDAS
// ══════════════════════════════════════════════════════════════════════════

test('la lista y el detalle devuelven lo que se registró', () => {
  const db = base();
  const r = alta(db).correr({ bultos: 10, kg: 200, piso_id: 5, motivo: 'Llegó en mal estado', fecha: '2026-09-11' });
  // eslint-disable-next-line no-new-func
  const lista = new Function('getDb', 'return ' + handler("router.get('/devoluciones-stock', requireAuth") + ';')(() => db);
  const l = correrCon(lista, { params: {}, query: {} });
  assert.equal(l.code, 200, l.error);
  assert.equal(l.data.length, 1);
  assert.equal(l.data[0].proveedor_nombre, 'ABRAHAM VICTOR');
  assert.equal(l.data[0].bultos, 10);
  assert.equal(l.data[0].kg, 200);
  assert.equal(l.data[0].partidas, 'L-1');
  assert.equal(l.data[0].productos, 'Tomate');
  assert.equal(l.data[0].descuenta, 1);
  // eslint-disable-next-line no-new-func
  const uno = new Function('getDb', 'return ' + handler("router.get('/devoluciones-stock/:id', requireAuth") + ';')(() => db);
  const d = correrCon(uno, { params: { id: r.data.id } });
  assert.equal(d.code, 200, d.error);
  assert.equal(d.data.proveedor_cuit, '20123456789');
  assert.equal(d.data.items[0].oc_numero, 'OC-7');
  assert.equal(d.data.items[0].piso_nombre, 'Cámara 2');
  assert.equal(d.data.items[0].envase_nombre, 'Cajón');
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LA AUDITORÍA: TODO LO QUE RESTA LA MERMA, RESTA LA DEVOLUCIÓN
// ══════════════════════════════════════════════════════════════════════════
//
// La versión anterior buscaba que el nombre APARECIERA cerca: cambiar un «-» por un
// «+» pasaba, escribir kgDecomisado(db,x) sin espacio también, y una línea suelta con
// el nombre debajo de la cuenta la daba por buena. Ésta mira la SENTENCIA entera y
// exige el signo y el mismo argumento.

function sentencia(txt, i) {
  let a = i;
  while (a > 0 && !/[;{}]/.test(txt[a - 1])) a--;
  return txt.slice(a, txt.indexOf(';', i) + 1);
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('en JS: cada resta de la merma resta también la devolución, con el mismo lote y con signo menos', () => {
  const NO_VAN = [
    // Separar por calidad: la madre conserva los kilos tirados; los cajones devueltos
    // ya los topea bultosDisponibles.
    'const kgTirados',
    // La cubeta es un lote sin orden de compra: la devolución no la acepta.
    'const dispCubeta', 'const restante = (cubeta',
  ];
  const faltan = [];
  for (const [nombre, dev] of [['kgDecomisado', 'kgDevueltoCamara'], ['bultosDecomisado', 'bultosDevueltoCamara']]) {
    const re = new RegExp(nombre + '\\(\\s*db\\s*,\\s*([^)]+?)\\s*\\)', 'g');
    let m;
    while ((m = re.exec(SG))) {
      // Si la MENCIÓN está en un comentario, no es una cuenta.
      const linea = SG.slice(SG.lastIndexOf('\n', m.index) + 1, SG.indexOf('\n', m.index));
      if (/^\s*\/\//.test(linea)) continue;
      // La sentencia, SIN sus líneas de comentario. La primera versión salteaba toda
      // sentencia que empezara con un comentario —y la sentencia arranca en el «;»
      // anterior, o sea arriba del bloque de comentarios—: justo las cuentas con una
      // explicación encima quedaban sin auditar, y un «+» ahí pasaba en verde.
      const s = sentencia(SG, m.index).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      if (s.includes('function ' + nombre + '(')) continue;
      if (NO_VAN.some((k) => s.includes(k))) continue;
      const arg = esc(m[1]);
      const resta = new RegExp('-\\s*' + dev + '\\(\\s*db\\s*,\\s*' + arg + '\\s*\\)');
      const pregunta = new RegExp('\\|\\|\\s*' + dev + '\\(\\s*db\\s*,\\s*' + arg + '\\s*\\)\\s*>');
      if (!resta.test(s) && !pregunta.test(s)) faltan.push(nombre + '(' + m[1] + '): ' + s.trim().slice(0, 100));
    }
  }
  assert.deepEqual(faltan, [], 'restan la merma y no la devolución desde la cámara');
});

test('en SQL: cada fórmula de kilos que resta la merma resta la devolución, con signo menos', () => {
  // Las definiciones de las propias sumas de la merma, y el stock del lote DESTINO de una
  // transformación, que no tiene orden de compra y no se puede devolver.
  const NO_VAN = ['const SUM_DECOMISO', 'function kgDecomisado', 'function bultosDecomisado', 'destino_disponible'];
  const faltan = [];
  for (const [nombreArchivo, txt] of [['sg.js', SG], ['db_sg.js', DBSG]]) {
    const re = /\$\{SUM_DECOMISO\}|FROM sg_lote_decomisos WHERE lote_id/g;
    let m;
    while ((m = re.exec(txt))) {
      const ini = txt.lastIndexOf('const ', m.index);
      const fin = txt.indexOf(';\r\n', m.index);
      const s = txt.slice(ini, fin + 1);
      // La sentencia tiene que empezar en ese `const`: si hay un «;» en el medio, la
      // resta de la merma está en una consulta armada a mano, fuera de una fórmula.
      if (txt.slice(ini, m.index).includes(';\r\n')) {
        const ctx = txt.slice(Math.max(0, m.index - 300), m.index);
        if (NO_VAN.some((k) => ctx.includes(k))) continue;
        faltan.push(nombreArchivo + ': consulta suelta que resta la merma: …' + txt.slice(m.index - 80, m.index + 40).replace(/\s+/g, ' '));
        continue;
      }
      if (NO_VAN.some((k) => s.includes(k))) continue;
      const ok = /-\s*\$\{SUM_DEV_CAMARA\}/.test(s) || /-\s*"\s*\+\s*SUM_DEV_CAMARA/.test(s)
        || /-\s*COALESCE\(\(SELECT SUM\(dvc\.kg\) FROM sg_devolucion_stock_items/.test(s);
      if (!ok) faltan.push(nombreArchivo + ': ' + s.slice(0, 80).replace(/\s+/g, ' '));
    }
  }
  assert.deepEqual(faltan, [], 'fórmulas que restan la merma y no la devolución');
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · EL LIBRO, LA PANTALLA Y LOS TESTS VIEJOS
// ══════════════════════════════════════════════════════════════════════════

test('el libro de movimientos toma las devoluciones DE ESE lote, registradas, en negativo', () => {
  assert.match(SG, /FROM sg_devolucion_stock_items it\s+JOIN sg_devoluciones_stock ds ON ds\.id = it\.devolucion_id AND ds\.estado = 'registrada'\s+WHERE it\.lote_id = \? ORDER BY ds\.fecha, ds\.id`\)\.all\(id\)\) \{\s+movs\.push\(\{ tipo: 'devolucion_proveedor', fecha: x\.fecha, kg: -\(Number\(x\.kg\) \|\| 0\)/);
});

test('la pantalla manda el piso, carga la solapa y pasa lo devuelto a la barra', () => {
  const g = hasta(PANEL, 'function sgDvpGuardar(){', '\r\n}');
  assert.match(g, /var body = \{ motivo: motivo, piso_id: x\.piso_id \|\| null,/);
  assert.match(hasta(PANEL, 'function sgStockTab(cual){', '\r\n}'), /if \(elegida === 'devprov'\) sgDvpLoad\(\);/);
  assert.match(PANEL, /sgAvanceBarra\(p\.bultos_vendidos, p\.bultos_recibidos, p\.bultos_merma, p\.bultos_devueltos_prov\)/);
  // Y la barra suma el cuarto de verdad.
  // eslint-disable-next-line no-new-func
  const barra = new Function('nr', hasta(PANEL, 'function sgAvanceBarra(vendidos, ingresados, merma, devueltos){', '\r\n}')
    + '\nreturn sgAvanceBarra;')((n) => String(Math.round(n)));
  assert.match(barra(30, 50, 10, 10), /100%/);
  assert.match(barra(30, 50, 10, 0), /80%/);
});

test('el test viejo de la solapa de merma encuentra su marca, o no mira nada', () => {
  // Cortaba hasta la marca de la solapa de partidas; si la marca cambiara, cortaría
  // hasta -1 y miraría el resto del archivo entero sin decir nada.
  const T = leer('test/merma.test.mjs');
  assert.match(T, /const fin = PANEL\.indexOf\('<div id="sg-st-tab-partidas">', i\);\s+assert\.ok\(fin > i/);
});
