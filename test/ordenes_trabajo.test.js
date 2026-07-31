// test/ordenes_trabajo.test.js
// Suite de Órdenes de Trabajo. Corre con `npm test` (node:test, sin dependencias).
//
// Usa node:sqlite en memoria en vez de la DB real: better-sqlite3 no compila en
// Windows y además no queremos tocar data/clientes.db. Por eso las validaciones
// viven en servicios/ot_validaciones.js, que recibe el db por parámetro.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { prorratear, normalizarLotes, validarCabecera } from '../src/servicios/ot_validaciones.js';

// ── Fixture ────────────────────────────────────────────────────────────────
// Dos sociedades: 1 = Puente Cordón (la de la orden), 2 = San Gerónimo.
// El plan de cuentas es por sociedad; proveedores y lotes son globales hoy.
const SOC_PC = 1, SOC_SG = 2;
const CTA_PC = 10, CTA_SG = 20;

let db;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sociedades (id INTEGER PRIMARY KEY, nombre TEXT);
    CREATE TABLE pa_cuentas (id INTEGER PRIMARY KEY, codigo TEXT, nombre TEXT, sociedad_id INTEGER);
    CREATE TABLE adm_proveedores (id INTEGER PRIMARY KEY, razon_social TEXT);
    CREATE TABLE pa_tareas (id INTEGER PRIMARY KEY, nombre TEXT);
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, hectareas REAL);

    INSERT INTO sociedades (id, nombre) VALUES (1,'Puente Cordón'), (2,'San Gerónimo');
    INSERT INTO pa_cuentas (id, codigo, nombre, sociedad_id) VALUES
      (10,'5.1.03','Servicios de terceros', 1),
      (20,'5.1.03','Servicios de terceros', 2);
    INSERT INTO adm_proveedores (id, razon_social) VALUES (7,'EL GRANADINO SRL');
    INSERT INTO pa_tareas (id, nombre) VALUES (3,'ARMAR CAMAS');
    INSERT INTO pa_lotes (id, nombre, hectareas) VALUES (100,'Lote A',10), (200,'Lote B',30);
  `);
});

// Cabecera válida mínima; cada test pisa lo que necesita.
const cabOK = (over = {}) => ({
  fecha: '2026-07-31',
  proveedor_id: 7,
  campania: 5,
  tarea_id: 3,
  cuenta_gasto_id: CTA_PC,
  monto_total: 1000,
  ...over,
});

// ── Prorrateo ──────────────────────────────────────────────────────────────
describe('prorratear', () => {
  test('reparte proporcional a las hectáreas', () => {
    const r = prorratear([{ lote_id: 1, hectareas: 10 }, { lote_id: 2, hectareas: 30 }], 1000);
    assert.deepEqual(r.map(x => x.monto_asignado), [250, 750]);
  });

  test('la suma cierra exacta con monto_total aunque haya redondeo', () => {
    const lotes = [{ hectareas: 1 }, { hectareas: 1 }, { hectareas: 1 }];
    const r = prorratear(lotes, 100);
    assert.deepEqual(r.map(x => x.monto_asignado), [33.33, 33.33, 33.34]);
    assert.equal(r.reduce((s, x) => s + x.monto_asignado, 0), 100);
  });

  test('con hectáreas en 0 reparte en partes iguales', () => {
    const r = prorratear([{ hectareas: 0 }, { hectareas: 0 }], 50);
    assert.deepEqual(r.map(x => x.monto_asignado), [25, 25]);
  });

  test('sin lotes devuelve lista vacía', () => {
    assert.deepEqual(prorratear([], 1000), []);
  });
});

// ── Tarea "Otra" ───────────────────────────────────────────────────────────
// "Otra" NO es una fila de pa_tareas: es una opción del <select> del front
// (value="__otra__"), que se traduce a tarea_id:null + tarea_otra:"<texto>".
describe('tarea "Otra"', () => {
  test('acepta tarea_otra con texto y deja tarea_id en null', () => {
    const r = validarCabecera(db, cabOK({ tarea_id: null, tarea_otra: 'DESTRONQUE' }), SOC_PC);
    assert.equal(r.error, undefined);
    assert.equal(r.datos.tarea_id, null);
    assert.equal(r.datos.tarea_otra, 'DESTRONQUE');
  });

  test('rechaza "Otra" con tarea_otra vacía', () => {
    const r = validarCabecera(db, cabOK({ tarea_id: null, tarea_otra: '' }), SOC_PC);
    assert.match(r.error, /escribí cuál es la tarea/i);
  });

  test('rechaza "Otra" con tarea_otra en blancos', () => {
    const r = validarCabecera(db, cabOK({ tarea_id: null, tarea_otra: '   ' }), SOC_PC);
    assert.match(r.error, /escribí cuál es la tarea/i);
  });

  test('rechaza cuando no viene ni tarea_id ni tarea_otra', () => {
    const r = validarCabecera(db, cabOK({ tarea_id: null, tarea_otra: undefined }), SOC_PC);
    assert.match(r.error, /escribí cuál es la tarea/i);
  });

  test('el centinela __otra__ posteado a mano no se cuela como NaN', () => {
    const r = validarCabecera(db, cabOK({ tarea_id: '__otra__', tarea_otra: 'DESTRONQUE' }), SOC_PC);
    assert.match(r.error, /tarea_id inválido/i);
  });

  test('si viene tarea_id del catálogo, tarea_otra se descarta', () => {
    const r = validarCabecera(db, cabOK({ tarea_id: 3, tarea_otra: 'texto que sobra' }), SOC_PC);
    assert.equal(r.datos.tarea_id, 3);
    assert.equal(r.datos.tarea_otra, null);
  });

  test('rechaza tarea_id que no está en el catálogo', () => {
    const r = validarCabecera(db, cabOK({ tarea_id: 999 }), SOC_PC);
    assert.match(r.error, /no existe en el catálogo/i);
  });
});

// ── Sociedad de la cuenta de gasto ─────────────────────────────────────────
describe('cuenta_gasto_id vs sociedad de la orden', () => {
  test('acepta una cuenta de la misma sociedad', () => {
    const r = validarCabecera(db, cabOK({ cuenta_gasto_id: CTA_PC }), SOC_PC);
    assert.equal(r.error, undefined);
    assert.equal(r.datos.cuenta_gasto_id, CTA_PC);
  });

  test('rechaza una cuenta de otra sociedad y nombra cuál', () => {
    const r = validarCabecera(db, cabOK({ cuenta_gasto_id: CTA_SG }), SOC_PC);
    assert.match(r.error, /San Gerónimo/);
    assert.match(r.error, /5\.1\.03/);
  });

  test('el mismo código de cuenta en la otra sociedad sigue siendo válido para esa orden', () => {
    const r = validarCabecera(db, cabOK({ cuenta_gasto_id: CTA_SG }), SOC_SG);
    assert.equal(r.error, undefined);
  });

  test('rechaza una cuenta inexistente', () => {
    const r = validarCabecera(db, cabOK({ cuenta_gasto_id: 999 }), SOC_PC);
    assert.match(r.error, /no existe/i);
  });
});

// ── Resto de la cabecera ───────────────────────────────────────────────────
describe('validarCabecera — campos obligatorios', () => {
  test('rechaza fecha con formato inválido', () => {
    assert.match(validarCabecera(db, cabOK({ fecha: '31/07/2026' }), SOC_PC).error, /fecha/i);
  });
  test('rechaza proveedor inexistente', () => {
    assert.match(validarCabecera(db, cabOK({ proveedor_id: 999 }), SOC_PC).error, /padrón/i);
  });
  test('rechaza sin campaña', () => {
    assert.match(validarCabecera(db, cabOK({ campania: null }), SOC_PC).error, /campaña/i);
  });
  test('rechaza monto negativo', () => {
    assert.match(validarCabecera(db, cabOK({ monto_total: -1 }), SOC_PC).error, /negativo/i);
  });
  test('monto 0 es válido', () => {
    assert.equal(validarCabecera(db, cabOK({ monto_total: 0 }), SOC_PC).error, undefined);
  });
  test('estado distinto de "ejecutada" cae a "pendiente"', () => {
    assert.equal(validarCabecera(db, cabOK({ estado: 'cualquiera' }), SOC_PC).datos.estado, 'pendiente');
  });
});

// ── Detalle de lotes ───────────────────────────────────────────────────────
describe('normalizarLotes', () => {
  test('hectáreas vacías toman las del lote completo', () => {
    const r = normalizarLotes(db, [{ lote_id: 100, hectareas: '' }]);
    assert.deepEqual(r.lotes, [{ lote_id: 100, hectareas: 10 }]);
  });
  test('rechaza lista vacía', () => {
    assert.match(normalizarLotes(db, []).error, /al menos un lote/i);
  });
  test('rechaza lote repetido', () => {
    const r = normalizarLotes(db, [{ lote_id: 100 }, { lote_id: 100 }]);
    assert.match(r.error, /repetido/i);
  });
  test('rechaza lote inexistente', () => {
    assert.match(normalizarLotes(db, [{ lote_id: 999 }]).error, /no existe/i);
  });
  test('rechaza ha mayores a las del lote', () => {
    const r = normalizarLotes(db, [{ lote_id: 100, hectareas: 11 }]);
    assert.match(r.error, /supera/i);
  });
  test('acepta ha exactamente iguales a las del lote', () => {
    assert.equal(normalizarLotes(db, [{ lote_id: 100, hectareas: 10 }]).error, undefined);
  });
  test('rechaza ha negativas', () => {
    assert.match(normalizarLotes(db, [{ lote_id: 100, hectareas: -1 }]).error, /inválidas/i);
  });
});
