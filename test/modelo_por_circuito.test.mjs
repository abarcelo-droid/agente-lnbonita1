// ══════════════════════════════════════════════════════════════════════════
// EL ASIENTO MODELO DE SAN GERÓNIMO ES POR CIRCUITO, Y SE PUEDE ELEGIR
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 3/9/2026: «no encuentro dónde guardar el asiento modelo del proveedor».
//
// No lo encontraba porque acá no existe: el modelo se elige por CIRCUITO. Lo que
// faltaba de verdad era la pantalla — de los cinco circuitos que asientan, dos
// tenían su selector escondido adentro de su propio modal y los otros TRES no se
// podían elegir desde ningún lado, así que la venta, el flete de entrada y la
// descarga no generaban asiento nunca.
//
// Estos tests corren los handlers de verdad contra una base de verdad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONT = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_contable.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// ── Sacar un pedazo del archivo, del ancla hasta su cierre ────────────────
function trozo(desde, cierre) {
  const i = CONT.indexOf(desde);
  assert.ok(i > 0, 'no se encontró: ' + desde);
  const f = CONT.indexOf(cierre, i);
  assert.ok(f > i, 'no se encontró el cierre de: ' + desde);
  return CONT.slice(i, f + cierre.length);
}

// ── Los dos handlers, corriendo ───────────────────────────────────────────
function armar() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_asientos_modelo (id INTEGER PRIMARY KEY, nombre TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_config (clave TEXT PRIMARY KEY, valor TEXT);
    INSERT INTO sg_asientos_modelo (id, nombre, activo) VALUES
      (1,'Compra de mercadería',1), (2,'Venta a supermercado',1), (3,'Modelo viejo',0);
    -- Un parámetro del módulo que NADA tiene que ver con los asientos: está para
    -- probar que este endpoint no lo puede pisar.
    INSERT INTO sg_config (clave, valor) VALUES ('tc_esperado','1450');
  `);

  const fuente = [
    trozo('const CIRCUITOS = [', '];'),
    trozo("router.get('/modelos/circuitos'", '\r\n});'),
    trozo("router.put('/modelos/circuitos'", '\r\n});'),
  ].join('\n\n');

  const capturado = {};
  const router = {
    get: (p, h) => { capturado.get = h; },
    // El PUT lleva requireAdmin en el medio: si alguien lo saca, acá llega el
    // handler como segundo argumento y el test lo dice.
    put: (p, mw, h) => { capturado.put = h; capturado.mw = mw; },
  };
  const requireAdmin = function requireAdmin() {};
  new Function('db', 'router', 'requireAdmin', fuente)(db, router, requireAdmin);
  assert.ok(capturado.get && capturado.put, 'no se registraron los dos handlers');

  const correr = (h, body) => {
    let out = null, code = 200;
    const res = {
      status(c) { code = c; return this; },
      json(j) { out = j; return this; },
    };
    h({ body: body || {} }, res);
    return { code, ...out };
  };
  return {
    db,
    GET: () => correr(capturado.get),
    PUT: (body) => correr(capturado.put, body),
    mw: capturado.mw,
  };
}

test('los cinco circuitos que asientan están, y arrancan sin modelo', () => {
  const a = armar();
  const r = a.GET();
  assert.ok(r.ok);
  const claves = r.data.circuitos.map(c => c.clave);
  assert.deepEqual(claves.slice().sort(), [
    'asiento_modelo_descarga',
    'asiento_modelo_factura_mercaderia',
    'asiento_modelo_flete',
    'asiento_modelo_liquidacion',
    'asiento_modelo_venta',
  ]);
  // Cada uno se explica solo: la pantalla muestra el «cuándo se usa».
  for (const c of r.data.circuitos) {
    assert.ok(c.label && c.donde, 'circuito sin label o sin explicación: ' + c.clave);
    assert.equal(c.modelo_id, null);
  }
  // Y sólo ofrece los modelos vivos.
  assert.deepEqual(r.data.modelos.map(m => m.id), [1, 2]);
});

test('elegir un modelo lo guarda, y se ve al volver a entrar', () => {
  const a = armar();
  const p = a.PUT({ clave: 'asiento_modelo_venta', modelo_id: 2 });
  assert.equal(p.code, 200);
  const c = a.GET().data.circuitos.find(x => x.clave === 'asiento_modelo_venta');
  assert.equal(c.modelo_id, 2);
  assert.equal(c.modelo_nombre, 'Venta a supermercado');
  // Y lo guarda donde el resto del sistema lo lee: sg_config, con esa clave.
  assert.equal(a.db.prepare("SELECT valor FROM sg_config WHERE clave='asiento_modelo_venta'").get().valor, '2');
});

test('y se puede sacar: el circuito vuelve a quedar sin modelo', () => {
  const a = armar();
  a.PUT({ clave: 'asiento_modelo_flete', modelo_id: 1 });
  assert.equal(a.PUT({ clave: 'asiento_modelo_flete', modelo_id: null }).code, 200);
  const c = a.GET().data.circuitos.find(x => x.clave === 'asiento_modelo_flete');
  assert.equal(c.modelo_id, null);
});

test('un circuito inventado no se guarda', () => {
  // La lista blanca es lo único que separa esto de un escritor genérico de
  // sg_config: la clave viaja en el cuerpo del pedido.
  const a = armar();
  const r = a.PUT({ clave: 'tc_esperado', modelo_id: 1 });
  assert.equal(r.code, 400);
  assert.equal(a.db.prepare("SELECT valor FROM sg_config WHERE clave='tc_esperado'").get().valor,
    '1450', 'pisó un parámetro que no es un asiento modelo');
});

test('un modelo que no existe —o que está dado de baja— no se puede elegir', () => {
  const a = armar();
  assert.equal(a.PUT({ clave: 'asiento_modelo_venta', modelo_id: 99 }).code, 400);
  assert.equal(a.PUT({ clave: 'asiento_modelo_venta', modelo_id: 3 }).code, 400,
    'dejó elegir un modelo dado de baja');
});

test('si el modelo elegido se da de baja después, el circuito lo avisa', () => {
  // Y no queda como «sin elegir»: son dos cosas distintas. Uno nunca se
  // configuró; el otro dejó de asentar solo, sin que nadie tocara nada.
  const a = armar();
  a.PUT({ clave: 'asiento_modelo_liquidacion', modelo_id: 1 });
  a.db.exec('UPDATE sg_asientos_modelo SET activo=0 WHERE id=1');
  const c = a.GET().data.circuitos.find(x => x.clave === 'asiento_modelo_liquidacion');
  assert.equal(c.perdido, 1);
  assert.equal(c.modelo_id, null);
});

test('elegir el modelo de un circuito es de administrador', () => {
  // Es parametrizar: define contra qué cuentas se contabiliza TODO un circuito.
  const a = armar();
  assert.equal(typeof a.mw, 'function');
  assert.equal(a.mw.name, 'requireAdmin');
});

test('la dirección se declara ANTES de /modelos/:id', () => {
  // Si va después, Express la toma como un id: parseInt('circuitos') da NaN y
  // el endpoint contesta «modelo no encontrado». El test lo clava porque el
  // orden de dos renglones no se ve en ninguna revisión.
  const circ = CONT.indexOf("router.get('/modelos/circuitos'");
  const porId = CONT.indexOf("router.get('/modelos/:id'");
  assert.ok(circ > 0 && porId > 0);
  assert.ok(circ < porId, '/modelos/circuitos quedó tapado por /modelos/:id');
});

test('NINGÚN circuito del código quedó sin su renglón en la pantalla', () => {
  // La razón de fondo del pedido de Pablo: la venta, el flete y la descarga
  // guardaban su modelo en sg_config y no había dónde elegirlo. Si mañana se
  // agrega un sexto circuito y no se agrega acá, pasa lo mismo — y no se nota
  // hasta el cierre, cuando esos asientos no están.
  const enPantalla = new Set(
    [...trozo('const CIRCUITOS = [', '];').matchAll(/'(asiento_modelo_[a-z_]+)'/g)].map(m => m[1]));
  const usadas = new Set();
  const dir = path.join(RAIZ, 'src');
  const barrer = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { barrer(p); continue; }
      if (!f.name.endsWith('.js')) continue;
      const t = fs.readFileSync(p, 'utf8');
      // La clave de un circuito se declara siempre así: `const CLAVE_MODELO_X =
      // 'asiento_modelo_y'`. Buscar el literal suelto traía además
      // `asiento_modelo_id`, que no es una clave sino la COLUMNA de
      // adm_proveedores —el modelo por proveedor de la otra empresa, que es
      // justamente lo que acá no existe—.
      for (const m of t.matchAll(/CLAVE_[A-Z_]*\s*=\s*'(asiento_modelo_[a-z_]+)'/g)) usadas.add(m[1]);
    }
  };
  barrer(dir);
  assert.ok(usadas.size >= 5, 'no se encontraron las claves en el código: ' + usadas.size);
  const huerfanas = [...usadas].filter(k => !enPantalla.has(k));
  assert.deepEqual(huerfanas, [],
    'estos circuitos asientan pero no se pueden elegir desde ninguna pantalla');
});

// ── LA PANTALLA ───────────────────────────────────────────────────────────

function seccionModelos() {
  const i = PANEL.indexOf('id="sec-sgct-modelos"');
  assert.ok(i > 0);
  return PANEL.slice(i, PANEL.indexOf('<div class="sec"', i + 10));
}

test('el cuadro está en la pantalla de Asiento Modelo, y se carga al entrar', () => {
  const b = seccionModelos();
  assert.match(b, /id="sgct-circ-tbody"/);
  assert.match(b, /Contra qué se contabiliza cada circuito/);
  // Sin este renglón el cuadro queda en «Cargando…» para siempre.
  assert.match(PANEL, /if \(s === 'sgct-modelos'\).*sgctCircCargar\(\);/);
});

test('el subtítulo ya no dice que el modelo es por proveedor', () => {
  // Fue exactamente lo que mandó a Pablo a buscar un campo que no existe. El
  // texto es correcto en la pantalla de la OTRA empresa, donde sí lo es.
  const b = seccionModelos();
  assert.ok(!/Plantillas contables por proveedor/.test(b),
    'el subtítulo de San Gerónimo sigue diciendo «por proveedor»');
  assert.match(PANEL, /Plantillas contables por proveedor/,
    'se cambió también el de la otra empresa, donde el texto era cierto');
});

test('el cuadro no pide barra de desplazamiento lateral', () => {
  const b = seccionModelos();
  const i = b.indexOf('id="sgct-circ-tbody"');
  const caja = b.slice(Math.max(0, i - 1200), i);
  assert.match(caja, /overflow-x:hidden !important/);
  assert.match(caja, /table-layout:fixed/);
});

test('y la pantalla tiene su «¿Cómo se usa?», con la respuesta adentro', () => {
  assert.match(seccionModelos(), /sgManualAbrir\('modelos'\)/);
  const i = PANEL.indexOf("SG_MANUAL.modelos = {");
  assert.ok(i > 0, 'el módulo no tiene entrada en el manual');
  const m = PANEL.slice(i, PANEL.indexOf('\r\n};', i));
  // La respuesta a la pregunta, en el lugar donde se la va a buscar.
  assert.match(m, /por CIRCUITO, no por proveedor/);
  assert.match(m, /<span class="ver">V1009<\/span>/);
  // Y la consecuencia de dejarlo sin elegir, que es lo que venía pasando.
  assert.match(m, /no genera asiento/);
});
