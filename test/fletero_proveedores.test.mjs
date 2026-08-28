// ══ A QUIÉN SE LE PAGA EL FLETE ════════════════════════════════════════════
//
// Pablo, 27/8/2026: «a qué fletero se le paga debería traer la lista de
// proveedores. Dentro de proveedores podemos marcar algunos como fleteros».
//
// El selector traía SÓLO los marcados con es_servicio=1, y en una base recién
// cargada eso es NINGUNO: se abría con «— Elegir —» y nada más. La marca existía
// en el maestro y no había forma de enterarse de que hacía falta ponerla —así que
// el flete no se podía valorizar y la pantalla no decía por qué.
//
// Es la misma trampa que ya resolvió puedeMoverCuenta(): si nadie está asignado, lo
// toca cualquiera. La marca ORDENA la lista; no es el requisito para trabajar.
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

// La consulta real del endpoint, corrida contra una base de verdad.
function consulta(solo) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sg_proveedores (id INTEGER PRIMARY KEY, razon_social TEXT,
    activo INTEGER DEFAULT 1, es_servicio INTEGER)`);
  const ins = db.prepare('INSERT INTO sg_proveedores (id, razon_social, activo, es_servicio) VALUES (?,?,?,?)');
  ins.run(1, 'ZETA FLETES', 1, 1);
  ins.run(2, 'ABRAHAM VICTOR', 1, null);
  ins.run(3, 'PUENTE CORDON SA', 1, null);
  ins.run(4, 'BAJA LOGISTICA', 1, 1);
  ins.run(5, 'VIEJO INACTIVO', 0, 1);
  return db.prepare(`SELECT * FROM sg_proveedores
     WHERE activo=1 ${solo ? 'AND es_servicio=1' : ''}
     ORDER BY es_servicio DESC, razon_social COLLATE NOCASE`).all();
}

// La función del panel que arma las opciones, ejecutada de verdad.
function opts() {
  const i = PANEL.indexOf('function sgFleteroOpts(lista, sel, vacio){');
  assert.ok(i > 0, 'no encontré sgFleteroOpts');
  let d = 0, j = PANEL.indexOf('{', i);
  for (; j < PANEL.length; j++) {
    if (PANEL[j] === '{') d++;
    else if (PANEL[j] === '}') { d--; if (d === 0) { j++; break; } }
  }
  return new Function('esc', PANEL.slice(i, j) + '; return sgFleteroOpts;')((x) => String(x));
}

// ── EL ENDPOINT ────────────────────────────────────────────────────────────
test('por defecto trae TODO el padrón, con los fleteros arriba', () => {
  const r = consulta(false);
  assert.equal(r.length, 4, 'los cuatro activos');
  // Los marcados primero, y entre ellos alfabético.
  assert.deepEqual(r.map((x) => x.razon_social),
    ['BAJA LOGISTICA', 'ZETA FLETES', 'ABRAHAM VICTOR', 'PUENTE CORDON SA']);
});

test('el inactivo no aparece aunque esté marcado', () => {
  assert.ok(!consulta(false).some((x) => x.razon_social === 'VIEJO INACTIVO'));
  assert.ok(!consulta(true).some((x) => x.razon_social === 'VIEJO INACTIVO'));
});

test('solo_marcados=1 sigue existiendo, para los FILTROS', () => {
  // En un filtro de listado el padrón entero no ayuda: ahí se filtra por quien
  // efectivamente hace fletes.
  const r = consulta(true);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x.razon_social), ['BAJA LOGISTICA', 'ZETA FLETES']);
  assert.match(SG, /const solo = String\(req\.query\.solo_marcados \|\| ''\) === '1'/);
  assert.match(PANEL, /proveedores-servicio\?solo_marcados=1/);
});

test('el endpoint dice cuántos hay marcados', () => {
  // La pantalla lo usa para avisar que ninguno lo está, en vez de dejar al
  // operador mirando una lista que no entiende por qué está mezclada.
  assert.match(SG, /marcados: rows\.filter\(\(r\) => r\.es_servicio === 1\)\.length/);
});

// ── EL SELECTOR ────────────────────────────────────────────────────────────
test('los fleteros van en su grupo y el resto abajo', () => {
  const f = opts();
  const h = f(consulta(false), '', '— Elegir —');
  assert.match(h, /<optgroup label="Fleteros">/);
  assert.match(h, /<optgroup label="Otros proveedores">/);
  assert.ok(h.indexOf('Fleteros') < h.indexOf('Otros proveedores'), 'los marcados primero');
  // Y están los cuatro: el que no está marcado se puede elegir igual.
  for (const n of ['ZETA FLETES', 'ABRAHAM VICTOR', 'PUENTE CORDON SA', 'BAJA LOGISTICA']) {
    assert.ok(h.includes(n), n + ' tiene que poder elegirse');
  }
});

test('SIN NINGUNO MARCADO el selector NO queda vacío — era el bug', () => {
  const f = opts();
  const h = f([{ id: 2, razon_social: 'ABRAHAM VICTOR', es_servicio: null },
               { id: 3, razon_social: 'PUENTE CORDON SA', es_servicio: null }], '', '— Elegir —');
  assert.ok(h.includes('ABRAHAM VICTOR'));
  assert.ok(h.includes('PUENTE CORDON SA'));
  assert.ok(!h.includes('<optgroup label="Fleteros">'), 'no hay grupo de fleteros si no hay ninguno');
  // Y el grupo dice por qué están todos juntos.
  assert.match(h, /ninguno marcado como fletero/);
});

test('la lista vacía de verdad sigue diciendo «elegir», no rompe', () => {
  const f = opts();
  const h = f([], '', '— Elegir —');
  assert.equal(h, '<option value="">— Elegir —</option>');
  assert.equal(f(null, '', '— Sin fletero —'), '<option value="">— Sin fletero —</option>');
});

test('respeta el que ya estaba elegido', () => {
  const f = opts();
  const h = f(consulta(false), 3, '— Elegir —');
  assert.match(h, /<option value="3" selected>PUENTE CORDON SA<\/option>/);
});

test('el remito usa el MISMO armador de fleteros, no una copia', () => {
  // Dos reglas distintas sobre lo mismo terminan diciendo cosas distintas.
  assert.match(PANEL, /eid\('sg-desp-fletero'\)\.innerHTML=sgFleteroOpts\(fls, '', '— Sin fletero —'\)/);
  assert.equal((PANEL.match(/function sgFleteroOpts\(/g) || []).length, 1);
});

test('pero la COOPERATIVA de carga sale de su catálogo, no de los proveedores', () => {
  // Pablo, 28/8/2026: «acá debería tomar sólo los que están dados de alta en
  // cooperativas». El fletero es un proveedor marcado como tal; la cooperativa
  // es una cuadrilla que se da de alta aparte, y ofrecerlas juntas dejaba elegir
  // de cuadrilla de carga a un proveedor de tomates.
  assert.ok(!/eid\('sg-desp-coop'\)\.innerHTML=sgFleteroOpts/.test(PANEL));
  const i = PANEL.indexOf("api('/api/sg/cooperativas').then(function(rc){");
  assert.ok(i > 0, 'el remito no pide el catálogo de cooperativas');
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /sel=eid\('sg-desp-coop'\)/);
  assert.match(b, /no hay cooperativas dadas de alta/);
});

test('la pantalla avisa cuando no hay ninguno marcado, y dice dónde se marcan', () => {
  assert.match(PANEL, /id="sgfe-fletero-ayuda"/);
  assert.match(PANEL, /Ningún proveedor está marcado como fletero/);
  assert.match(PANEL, /Maestros → Proveedores/);
});

test('el maestro dice qué hace la marca, no sólo cómo se llama', () => {
  // «¿Proveedor de servicio?» no decía para qué servía tildarlo.
  assert.match(PANEL, /¿Hace fletes o cargas\? \(aparece primero al pagar un flete\)/);
});
