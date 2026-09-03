// ══ LA MERMA SE ELIGE COMO SE FACTURA, Y SALE DE UN PISO ═══════════════════
//
// Pablo, 2/9/2026: «en merma debería traerme algo parecido a lo que me muestra en
// facturación! Con el piso completo e ir seleccionando entre productos y partidas».
//
// Dos cosas, y la segunda es la que mueve plata:
//
//  1. El buscador. Antes era un combo con TODAS las partidas de la casa, ordenadas
//     por código. El que está en la cámara no sabe el código: sabe que va a tirar
//     tomate. Ahora es el mismo componente de la facturación —producto a la
//     izquierda, sus partidas a la derecha—, y las partidas vienen abiertas POR
//     PISO, con los cajones que hay en cada uno.
//
//  2. De qué piso sale. Antes la merma no lo decía y la baja se hacía por orden de
//     piso: se tiraban diez cajones de Cámara 2 y el sistema se los descontaba a
//     Playa 1 porque Playa 1 venía primero. A partir de ahí las dos pantallas
//     mienten —una dice lleno un lugar vacío y al revés— y el que va a buscar la
//     mercadería no la encuentra.
//
// Y con el piso viene la regla de siempre (Pablo, 1/9/2026): «los usuarios pueden
// tocar sólo sus pisos asignados, no cualquiera». Vale igual para tirar que para
// remitir.
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

function trozo(desde, hasta) {
  const i = SG.indexOf(desde);
  assert.ok(i > 0, 'no existe ' + desde);
  const j = SG.indexOf(hasta, i);
  assert.ok(j > i, 'no termina ' + desde);
  return SG.slice(i, j + hasta.length);
}

// ── 1 · EL SERVIDOR DICE DÓNDE ESTÁ CADA PARTIDA ───────────────────────────

test('/oferta trae los pisos de cada partida, y si los puedo tocar', () => {
  const b = trozo("router.get('/oferta'", '\r\n});');
  assert.match(b, /l\.pisos = ubicacionesDeLote\(db, l\.lote_id\)\.map\(/);
  for (const campo of ['piso_id', 'piso_nombre', 'bultos', 'kg']) {
    assert.ok(b.includes(campo + ':'), 'a /oferta le falta el ' + campo + ' del piso');
  }
  // `puedo` viaja con CADA piso: sin esto la pantalla ofrece un botón que el
  // servidor va a rechazar, y el que lo aprieta cree que rompió algo.
  assert.match(b, /const mios = new Set\(pisosDeUsuario\(db, req\)\);/);
  assert.match(b, /puedo: mios\.has\(u\.piso_id\) \? 1 : 0,/);
  assert.match(b, /res\.json\(\{ ok: true, data: \{ stock: conPisos, en_camino: en_caminoB \} \}\);/);
});

// ── 2 · Y SALE DE ESE PISO, CORRIDO CONTRA LA BASE ─────────────────────────
//
// Esta es la parte que mueve stock: no alcanza con que el router pase el piso,
// tiene que descontarse de ahí y de ningún otro.

function ubicacion() {
  const src = [
    'function r2(n){ return Math.round((Number(n)||0)*100)/100; }',
    trozo('function ubicacionesDeLote(db, loteId) {', '\n}'),
    trozo('function ubicMover(db, loteId, pisoId, dBultos, dKg) {', '\n}'),
    trozo('function descontarDeUbicacion(db, loteId, bultos, kg, pisoId) {', '\n}'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(src + '\nreturn { descontarDeUbicacion, ubicacionesDeLote };')();
}

function baseConDosPisos() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_pisos (id INTEGER PRIMARY KEY, nombre TEXT, codigo TEXT, orden INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_lote_ubicaciones (id INTEGER PRIMARY KEY, lote_id INTEGER, piso_id INTEGER, bultos REAL, kg REAL);
    INSERT INTO sg_pisos (id, nombre, codigo, orden) VALUES (1,'Playa 1','P1',1),(2,'Cámara 2','C2',2);
    INSERT INTO sg_lote_ubicaciones (lote_id, piso_id, bultos, kg) VALUES (7,1,30,330),(7,2,20,220);
  `);
  return db;
}
// node:sqlite devuelve filas sin prototipo: deepEqual estricto las ve distintas de
// un objeto comun aunque tengan los mismos numeros.
const enPiso = (db, p) => ({ ...db.prepare('SELECT bultos, kg FROM sg_lote_ubicaciones WHERE lote_id=7 AND piso_id=?').get(p) });

test('lo que se tira de Cámara 2 sale de Cámara 2, no del primero de la lista', () => {
  const db = baseConDosPisos();
  const U = ubicacion();
  const r = U.descontarDeUbicacion(db, 7, 8, 88, 2);
  assert.equal(r.ok, true);
  assert.deepEqual(enPiso(db, 1), { bultos: 30, kg: 330 }, 'Playa 1 no se tocó');
  assert.deepEqual(enPiso(db, 2), { bultos: 12, kg: 132 }, 'los 8 cajones salieron de Cámara 2');
  db.close();
});

test('y si en ese piso no hay tantos, no se descuenta nada', () => {
  const db = baseConDosPisos();
  const U = ubicacion();
  const r = U.descontarDeUbicacion(db, 7, 25, 275, 2);
  assert.equal(r.ok, false);
  assert.match(r.error, /Cámara 2/);
  assert.deepEqual(enPiso(db, 1), { bultos: 30, kg: 330 });
  assert.deepEqual(enPiso(db, 2), { bultos: 20, kg: 220 }, 'no se movió un solo cajón');
  db.close();
});

test('y a granel tampoco: un piso no queda en kilos negativos', () => {
  // El control miraba sólo los BULTOS. Una partida a granel no tiene, así que
  // pasaba de largo entera y el piso quedaba con kilos en menos: la pantalla de
  // pisos empieza a mostrar un número imposible y nadie sabe de dónde salió.
  const db = baseConDosPisos();
  db.exec('UPDATE sg_lote_ubicaciones SET bultos=0');
  const U = ubicacion();
  const r = U.descontarDeUbicacion(db, 7, 0, 400, 2);
  assert.equal(r.ok, false);
  assert.match(r.error, /hay 220 kg de esa partida y se piden 400/);
  assert.equal(enPiso(db, 2).kg, 220, 'el piso quedó en kilos negativos');
  db.close();
});

test('la mercadería sin ubicar se puede tirar igual', () => {
  // La que entró antes de que existieran los pisos. No puede ser que por eso no
  // se pueda tirar.
  const db = baseConDosPisos();
  db.exec('DELETE FROM sg_lote_ubicaciones');
  const U = ubicacion();
  assert.deepEqual(U.descontarDeUbicacion(db, 7, 8, 88, null), { ok: true, sinUbicar: true });
  db.close();
});

// ── 3 · EL RENGLÓN DE LA PANTALLA ──────────────────────────────────────────

test('cada partida se abre por piso, con los cajones de cada uno', () => {
  const i = PANEL.indexOf('function sgIPRenderDetalle(key){');
  const j = PANEL.indexOf('\r\n}', PANEL.indexOf('eid(key+\'-det\').innerHTML=h;', i));
  const b = PANEL.slice(i, j);
  assert.match(b, /porPiso=\(st\.modo==='merma'\)/);
  assert.match(b, /if\(porPiso\)\{/);
  assert.match(b, /var pisos=\(l\.pisos\|\|\[\]\);/);
  // Un input y un «+» POR PISO, y el piso viaja en el onclick.
  assert.match(b, /sgIPAdd\('\+sgQ\(key\)\+',\\'lote\\','\+l\.lote_id\+','\+sgQ\(iid\)\+','\+sgQ\(l\.codigo_lote\)\+','\+sgQ\(l\.semaforo\|\|'verde'\)\+','\+p\.piso_id\+'\)/);
  // El piso que maneja otro se VE —para entender dónde está el resto— pero sin botón.
  assert.match(b, /lo maneja otra persona/);
  assert.match(b, /\(p\.puedo\s*\?/);
  // Y la partida sin ubicar sigue teniendo su renglón.
  assert.match(b, /sin piso asignado/);
});

test('en facturación el piso se ve, aunque no haya que elegirlo', () => {
  // El que arma el remito después lo tiene que ir a buscar.
  const i = PANEL.indexOf('function sgIPPisosTxt(l){');
  assert.ok(i > 0, 'no existe sgIPPisosTxt');
  const j = PANEL.indexOf('function sgIPRenderDetalle(key){');
  const b = PANEL.slice(j, j + 6000);
  assert.match(b, /sgIPPisosTxt\(l\)\?\('<div style="font-size:10\.5px;color:var\(--mut\)">🏢 '\+sgIPPisosTxt\(l\)/);
});

// ── 4 · Y EL FRONT NO OFRECE MÁS DE LO QUE HAY EN ESE PISO ─────────────────
//
// El servidor lo valida igual —es el que decide—, pero rebotar después de haber
// tipeado el motivo y adjuntado la foto es hacerle rehacer todo al que carga.

function picker(onAdd) {
  const i = PANEL.indexOf('function sgIPPorBulto(st){');
  const j = PANEL.indexOf('function sgIPPisosTxt(l){', i);
  const a = PANEL.indexOf('function sgIPAdd(key, tipo, fuenteId, inputId, label, semaforo, pisoId){');
  assert.ok(a > 0, 'sgIPAdd no recibe el piso');
  const b = PANEL.indexOf('st.onAdd(tipo, fuenteId, kg, meta);\r\n}', a);
  const avisos = [];
  const src = [
    'var SG = { itemPicker: {} };',
    'function nr(n){ return String(n); }',
    'function toast(m){ avisos.push(m); }',
    'function eid(id){ return campos[id]; }',
    PANEL.slice(i, j),
    PANEL.slice(a, b + 'st.onAdd(tipo, fuenteId, kg, meta);\r\n}'.length),
  ].join('\n');
  const campos = {};
  // eslint-disable-next-line no-new-func
  const F = new Function('avisos', 'campos', src + '\nreturn { SG, sgIPAdd };')(avisos, campos);
  F.SG.itemPicker.k = {
    modo: 'merma',
    sel: 3,
    _prodNombre: 'Tomate Redondo',
    onAdd,
    oferta: {
      stock: [{
        lote_id: 7, codigo_lote: 'L-0912', kg_por_bulto: 11, kg_disponibles: 550,
        bultos_disponibles: 50,
        pisos: [{ piso_id: 1, piso_nombre: 'Playa 1', bultos: 30, kg: 330, puedo: 1 },
          { piso_id: 2, piso_nombre: 'Cámara 2', bultos: 20, kg: 220, puedo: 1 }],
      }],
      en_camino: [],
    },
  };
  return { F, campos, avisos };
}

test('no deja tirar 25 cajones de un piso que tiene 20', () => {
  const salidas = [];
  const { F, campos, avisos } = picker((...a) => salidas.push(a));
  campos.inp = { value: '25' };
  F.sgIPAdd('k', 'lote', 7, 'inp', 'L-0912', 'verde', 2);
  assert.equal(salidas.length, 0, 'dejó tirar más de lo que hay en ese piso');
  assert.match(avisos.join(' '), /En Cámara 2 hay 20 cajones/);
});

test('y con 12 de ese mismo piso, pasa — con el piso y los kilos derivados', () => {
  const salidas = [];
  const { F, campos } = picker((...a) => salidas.push(a));
  campos.inp = { value: '12' };
  F.sgIPAdd('k', 'lote', 7, 'inp', 'L-0912', 'verde', 2);
  assert.equal(salidas.length, 1);
  const [tipo, fuenteId, kg, meta] = salidas[0];
  assert.equal(tipo, 'lote');
  assert.equal(fuenteId, 7);
  assert.equal(kg, 132, '12 cajones de 11 kg — la cuenta la hace el sistema, no el que carga');
  assert.equal(meta.bultos, 12);
  assert.equal(meta.piso_id, 2);
  assert.equal(meta.piso_nombre, 'Cámara 2');
  assert.equal(meta.producto_nombre, 'Tomate Redondo');
  // Y el campo queda limpio para el siguiente.
  assert.equal(campos.inp.value, '');
});

test('sin piso —mercadería vieja— se mide contra el disponible de la partida', () => {
  const salidas = [];
  const { F, campos } = picker((...a) => salidas.push(a));
  campos.inp = { value: '40' };
  F.sgIPAdd('k', 'lote', 7, 'inp', 'L-0912', 'verde');
  assert.equal(salidas.length, 1, '40 cajones entran en los 50 de la partida');
  assert.equal(salidas[0][3].piso_id, null);
});

test('medio cajón no existe', () => {
  const salidas = [];
  const { F, campos, avisos } = picker((...a) => salidas.push(a));
  campos.inp = { value: '2.5' };
  F.sgIPAdd('k', 'lote', 7, 'inp', 'L-0912', 'verde', 2);
  assert.equal(salidas.length, 0);
  assert.match(avisos.join(' '), /cajón entero/);
});

// ── 5 · LA PANTALLA DE MERMA, ARMADA SOBRE ESO ─────────────────────────────

test('el combo de partidas se fue: ahora es el buscador de la facturación', () => {
  assert.ok(!PANEL.includes('id="sg-merma-lote"'),
    'quedó el combo viejo con todas las partidas de la casa');
  assert.match(PANEL, /<div id="sg-merma-pick"><\/div>/);
  const i = PANEL.indexOf('function sgMermaAbrir(){');
  const b = PANEL.slice(i, i + 1400);
  assert.match(b, /sgItemPicker\(\{ contenedor:'sg-merma-pick', modo:'merma', onAdd: sgMermaElegir \}\);/);
});

test('se tira UNA partida por vez: el motivo y la foto son de esa mercadería', () => {
  const i = PANEL.indexOf('function sgMermaElegir(');
  const b = PANEL.slice(i, i + 1400);
  // Elegir otra REEMPLAZA: no se acumulan renglones bajo un solo motivo.
  assert.match(b, /SGMER\.sel = \{ lote_id: fuenteId/);
  assert.match(b, /piso_id: meta\.piso_id \|\| null/);
  assert.ok(!/SGMER\.(lineas|items)/.test(PANEL.slice(i, i + 1400)));
});

test('y el piso elegido llega hasta el POST', () => {
  const i = PANEL.indexOf('function sgMermaGuardar(){');
  const b = PANEL.slice(i, i + 1800);
  assert.match(b, /if\(x\.piso_id\) fd\.append\('piso_id', String\(x\.piso_id\)\);/);
  assert.match(b, /fetch\('\/api\/sg\/lotes\/'\+x\.lote_id\+'\/decomiso'/);
});

test('el manual lo cuenta, con su versión', () => {
  const i = PANEL.indexOf('SG_MANUAL.stock = {');
  const m = PANEL.slice(i, PANEL.indexOf('\r\n};', i));
  const plano = m.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
  assert.match(m, /<span class="ver">V994<\/span>/);
  assert.ok(plano.includes('abiertas por piso'), 'el manual no dice que las partidas se abren por piso');
  assert.ok(plano.includes('no se puede tirar más de lo que hay <b>en ese piso</b>')
    || plano.includes('en ese piso'), 'el manual no dice que el tope es el del piso');
});
