// Tests del costo por lote de Producción (Puente Cordón).
//
// Se testea el SQL, no el router: acá lo que falla, falla en silencio. Un costo
// que no se escribe, un cultivo que se clasifica como producción cuando es
// inversión o una cantidad que suma de más no rompen nada — devuelven un número
// distinto, y el número se cree.
//
// El SQL se EXTRAE de los archivos fuente en vez de copiarse: si alguien cambia
// el query, el test corre el query nuevo (o falla al no encontrarlo), y no una
// copia que se desincronizó hace meses.
//
// Corre con `npm test` (node --test). Usa node:sqlite, que viene con Node 24 —
// sin better-sqlite3, que no compila en Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const leer = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PROD = leer('../src/rutas/produccion.js');
const DBPA = leer('../src/servicios/db_pa.js');

// Devuelve el template literal que contiene `texto`.
function sqlConteniendo(fuente, texto, cual = 0) {
  let i = -1;
  for (let k = 0; k <= cual; k++) i = fuente.indexOf(texto, i + 1);
  assert.ok(i >= 0, 'no está en el fuente: ' + texto);
  return fuente.slice(fuente.lastIndexOf('`', i) + 1, fuente.indexOf('`', i));
}

// Base mínima con la forma real de las tablas que tocan estos queries.
function baseDePrueba() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_sectores (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, hectareas REAL, sector_id INTEGER, finca TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE pa_campañas (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT, activa INTEGER DEFAULT 0);
    CREATE TABLE pa_cultivos_lote (id INTEGER PRIMARY KEY, lote_id INTEGER, cultivo TEXT, campaña TEXT,
      en_desarrollo INTEGER DEFAULT 0, productividad_pct INTEGER, UNIQUE(lote_id,campaña));
    CREATE TABLE pa_costos_lote (id INTEGER PRIMARY KEY, lote_id INTEGER, campaña_id INTEGER NOT NULL,
      campaña_anual_id INTEGER, campaña_estacional_id INTEGER,
      categoria TEXT NOT NULL CHECK(categoria IN ('fertilizante','agroquimico','semilla','labor_propia','labor_contratada','cosecha','otros')),
      origen TEXT, referencia_id INTEGER, fecha TEXT, monto REAL NOT NULL DEFAULT 0, descripcion TEXT);
    CREATE TABLE pa_compras (id INTEGER PRIMARY KEY, fecha TEXT, proveedor_txt TEXT, activo INTEGER DEFAULT 1,
      campaña_id INTEGER, campaña_anual_id INTEGER, campaña_estacional_id INTEGER, tipo_factura TEXT);
    CREATE TABLE pa_compras_items (id INTEGER PRIMARY KEY, compra_id INTEGER, insumo_id INTEGER, cantidad REAL,
      precio_unit REAL, subtotal REAL, subtotal_neto REAL, precio_modo TEXT, concepto TEXT, lote_id INTEGER, cuenta_codigo TEXT);
    CREATE TABLE pa_insumos (id INTEGER PRIMARY KEY, nombre TEXT, unidad TEXT, tipo TEXT);
    CREATE TABLE pa_ordenes (id INTEGER PRIMARY KEY, nro_orden TEXT, estado TEXT, eliminada_en TEXT);
    CREATE TABLE pa_ordenes_items (id INTEGER PRIMARY KEY, orden_id INTEGER, insumo_id INTEGER, dosis REAL, unidad_dosis TEXT, notas TEXT);
    CREATE TABLE pa_aplicaciones (id INTEGER PRIMARY KEY, orden_id INTEGER, lote_id INTEGER, insumo_id INTEGER,
      fecha_real TEXT, cantidad_real REAL, costo_total REAL DEFAULT 0);

    INSERT INTO pa_sectores (id,nombre,tipo) VALUES (1,'El Abuelo','finca'),(2,'La Niña Bonita','finca');
    INSERT INTO pa_campañas (id,nombre,tipo,activa) VALUES (10,'2026/27','anual',1),(11,'2027/28','anual',0);
    INSERT INTO pa_lotes (id,nombre,hectareas,sector_id,finca) VALUES
      (1,'20 21',4.5,1,'El Abuelo'), (2,'13',1,1,'El Abuelo'), (3,'26-31',6,2,'La Niña Bonita');
    -- El lote 1 es damasco recién plantado: no produce, lo que se le gasta es inversión.
    INSERT INTO pa_cultivos_lote (lote_id,cultivo,campaña,en_desarrollo) VALUES
      (1,'Damasco','2026/27',1), (2,'Damasco','2026/27',0), (3,'Cebolla','2026/27',0);
    INSERT INTO pa_costos_lote (lote_id,campaña_id,campaña_anual_id,categoria,origen,referencia_id,fecha,monto,descripcion) VALUES
      (1,10,10,'agroquimico','aplicacion',1,'2026-08-01',100000,'Aplicación OA: Sol Ks'),
      (2,10,10,'agroquimico','aplicacion',2,'2026-08-02', 40000,'Aplicación OA: Sol Ks');
    INSERT INTO pa_insumos (id,nombre,unidad,tipo) VALUES (7,'Sol Ks','lt','fertilizante');
  `);
  return db;
}

// Una factura de servicios de Granadino, con el lote 26-31 (cebolla) elegido.
function facturaDeServicio(db, { compraId = 50, itemId = 500, campAnual = 10 } = {}) {
  db.prepare(`INSERT INTO pa_compras (id,fecha,proveedor_txt,activo,campaña_id,campaña_anual_id,tipo_factura)
              VALUES (?,'2026-08-10','GRANADINO SRL',1,?,?,'servicio')`).run(compraId, campAnual, campAnual);
  db.prepare(`INSERT INTO pa_compras_items (id,compra_id,insumo_id,cantidad,precio_unit,subtotal_neto,precio_modo,concepto,lote_id)
              VALUES (?,?,NULL,1,250000,250000,'servicio','Siembra neumática',3)`).run(itemId, compraId);
}

// Corre el backfill REAL de db_pa.js (el query + el INSERT que hace el módulo).
function correrBackfill(db) {
  const pendientes = db.prepare(sqlConteniendo(DBPA, "cl.origen = 'compra_servicio' AND cl.referencia_id = ci.id")).all();
  const ins = db.prepare(sqlConteniendo(DBPA, "'labor_contratada','compra_servicio'"));
  for (const p of pendientes) {
    const anual = p.campaña_anual_id || p.campaña_id || null;
    const estac = p.campaña_estacional_id || null;
    ins.run(p.lote_id, anual || estac, anual, estac, p.id, p.fecha,
            Math.round((Number(p.subtotal_neto) || 0) * 100) / 100,
            'Servicio ' + p.proveedor_txt + ': ' + p.concepto);
  }
  return pendientes.length;
}

const AGG = 'cl.campaña_anual_id = ?';
const resumenDe = (db) => db.prepare(
  sqlConteniendo(PROD, 'GROUP_CONCAT(DISTINCT cl.categoria)').replace('${aggWhere}', AGG)
).all('2026/27', 10);
const porCultivoDe = (db) => db.prepare(
  sqlConteniendo(PROD, "'— Sin cultivo asignado —'").replace('${aggWhere}', AGG)
).all(10, '2026/27');

// ── EL SERVICIO CON LOTE ES COSTO DE ESE LOTE ──────────────────────────────

test('el servicio facturado con lote llega al costo del lote (y del cultivo)', () => {
  const db = baseDePrueba();
  facturaDeServicio(db);
  assert.equal(correrBackfill(db), 1, 'el backfill tiene que encontrar el servicio pendiente');
  const cebolla = db.prepare("SELECT SUM(monto) m FROM pa_costos_lote WHERE lote_id=3").get();
  assert.equal(cebolla.m, 250000);
  const fila = db.prepare("SELECT * FROM pa_costos_lote WHERE origen='compra_servicio'").get();
  assert.equal(fila.categoria, 'labor_contratada');
  assert.equal(fila.referencia_id, 500, 'la referencia es el ítem, no la factura: una factura puede tener varios');
});

test('el backfill no duplica al segundo arranque', () => {
  const db = baseDePrueba();
  facturaDeServicio(db);
  correrBackfill(db);
  assert.equal(correrBackfill(db), 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pa_costos_lote WHERE origen='compra_servicio'").get().n, 1);
});

test('la factura dada de baja pierde el costo, y el backfill no se lo devuelve', () => {
  const db = baseDePrueba();
  facturaDeServicio(db);
  correrBackfill(db);
  const borrado = db.prepare(`DELETE FROM pa_costos_lote
     WHERE origen = ? AND referencia_id IN (SELECT id FROM pa_compras_items WHERE compra_id = ?)`)
    .run('compra_servicio', 50);
  assert.equal(borrado.changes, 1);
  db.exec("UPDATE pa_compras SET activo=0 WHERE id=50");
  assert.equal(correrBackfill(db), 0, 'una factura desactivada no vuelve sola');
});

test('la compra de BIENES con lote no genera costo — lo genera la aplicación', () => {
  const db = baseDePrueba();
  db.exec(`INSERT INTO pa_compras (id,fecha,proveedor_txt,activo,campaña_id,campaña_anual_id,tipo_factura)
             VALUES (60,'2026-08-10','AGRO SA',1,10,10,'compra');
           INSERT INTO pa_compras_items (id,compra_id,insumo_id,cantidad,precio_unit,subtotal_neto,precio_modo,lote_id)
             VALUES (600,60,7,100,900,90000,'bulto',3)`);
  assert.equal(correrBackfill(db), 0, 'si entrara acá, el insumo se contaría dos veces: al comprarlo y al aplicarlo');
});

test('reasignar la campaña de la factura arrastra el costo del lote', () => {
  const db = baseDePrueba();
  facturaDeServicio(db);
  correrBackfill(db);
  db.exec("UPDATE pa_compras SET campaña_anual_id=11 WHERE id=50");
  db.prepare(
    sqlConteniendo(PROD, 'SET campaña_anual_id      = (SELECT c.campaña_anual_id FROM pa_compras c')
      .replace('${COSTO_ORIGEN_SERVICIO}', 'compra_servicio').replace('${ph}', '?')
  ).run(50);
  const f = db.prepare("SELECT campaña_anual_id, campaña_id FROM pa_costos_lote WHERE origen='compra_servicio'").get();
  assert.equal(f.campaña_anual_id, 11);
  assert.equal(f.campaña_id, 11, 'campaña_id es NOT NULL y tiene que seguir a la anual');
});

// ── INVERSIÓN vs PRODUCCIÓN ────────────────────────────────────────────────

test('el lote en desarrollo es inversión; el maduro, producción', () => {
  const db = baseDePrueba();
  facturaDeServicio(db);      // así el lote 3 también tiene costo y entra al resumen
  correrBackfill(db);
  const porId = Object.fromEntries(resumenDe(db).map(r => [r.lote_id, r]));
  assert.equal(porId[1].destino, 'inversion');
  assert.equal(porId[1].en_desarrollo, 1);
  assert.equal(porId[2].destino, 'produccion');
  assert.equal(porId[3].destino, 'produccion');
});

test('el mismo cultivo aparece dos veces si tiene lotes de los dos lados', () => {
  const db = baseDePrueba();
  const damascos = porCultivoDe(db).filter(c => c.cultivo === 'Damasco');
  assert.equal(damascos.length, 2, 'damasco en producción y damasco en inversión son dos plata distintas');
  assert.equal(damascos.find(c => c.destino === 'inversion').costo_total, 100000);
  assert.equal(damascos.find(c => c.destino === 'produccion').costo_total, 40000);
});

test('producción + inversión da el total (no se pierde ni se duplica nada)', () => {
  const db = baseDePrueba();
  facturaDeServicio(db);
  correrBackfill(db);
  const resumen = resumenDe(db);
  const suma = (arr) => arr.reduce((a, l) => a + (l.costo_total || 0), 0);
  const inv = suma(resumen.filter(l => l.destino === 'inversion'));
  const prod = suma(resumen.filter(l => l.destino !== 'inversion'));
  assert.equal(inv, 100000);
  assert.equal(prod, 290000, '40.000 del damasco maduro + 250.000 del servicio de la cebolla');
  assert.equal(inv + prod, suma(resumen));
});

test('el lote sin cultivo cargado cuenta como producción, no como inversión', () => {
  const db = baseDePrueba();
  db.exec("DELETE FROM pa_cultivos_lote WHERE lote_id=1");
  const l1 = resumenDe(db).find(r => r.lote_id === 1);
  assert.equal(l1.destino, 'produccion', 'sin dato no se asume inversión: escondería costo de la campaña');
});

test('el servicio se ve como "Servicios" en el tipo de gasto', () => {
  const db = baseDePrueba();
  facturaDeServicio(db);
  correrBackfill(db);
  const caseTipo = PROD.slice(PROD.indexOf('`', PROD.indexOf('const tipoGastoCase = ')) + 1,
                              PROD.indexOf('`', PROD.indexOf('`', PROD.indexOf('const tipoGastoCase = ')) + 1));
  const tipos = db.prepare(`
    SELECT ${caseTipo} AS tipo, SUM(cl.monto) AS costo
    FROM pa_costos_lote cl
    JOIN pa_lotes l ON l.id = cl.lote_id
    JOIN pa_sectores s ON s.id = l.sector_id
    WHERE ${AGG} GROUP BY ${caseTipo}
  `).all(10);
  assert.equal(tipos.find(t => t.tipo === 'Servicios').costo, 250000);
  assert.equal(tipos.find(t => t.tipo === 'Insumos').costo, 140000,
    'las aplicaciones siguen siendo Insumos: el rubro nuevo no se comió nada');
});

// ── CUÁNTO PRODUCTO SE USÓ (Excel de órdenes) ──────────────────────────────

test('la cantidad usada suma todas las aplicaciones de la orden', () => {
  const db = baseDePrueba();
  db.exec(`
    INSERT INTO pa_ordenes (id,nro_orden,estado) VALUES (900,'OA-00119','ejecutada');
    INSERT INTO pa_ordenes_items (id,orden_id,insumo_id,dosis,unidad_dosis) VALUES (901,900,7,2.5,'lt/ha');
    INSERT INTO pa_aplicaciones (orden_id,lote_id,insumo_id,fecha_real,cantidad_real,costo_total) VALUES
      (900,1,7,'2026-08-11',11.25,30000),
      (900,2,7,'2026-08-11', 2.5,  7000);
  `);
  const it = db.prepare(sqlConteniendo(PROD, 'AS cantidad_aplicada')).all(900)[0];
  assert.equal(it.cantidad_aplicada, 13.75, 'la orden es de dos lotes: se usó lo de los dos');
  assert.equal(it.costo_aplicado, 37000);
  assert.equal(it.unidad, 'lt');
  assert.equal(it.dosis, 2.5, 'la dosis planificada sigue estando: son dos números distintos');
});

test('la orden emitida y sin ejecutar informa 0, no null', () => {
  const db = baseDePrueba();
  db.exec(`
    INSERT INTO pa_ordenes (id,nro_orden,estado) VALUES (901,'OA-00121','emitida');
    INSERT INTO pa_ordenes_items (id,orden_id,insumo_id,dosis,unidad_dosis) VALUES (902,901,7,3,'lt/ha');
  `);
  const it = db.prepare(sqlConteniendo(PROD, 'AS cantidad_aplicada')).all(901)[0];
  assert.equal(it.cantidad_aplicada, 0);
  assert.equal(it.costo_aplicado, 0);
});
