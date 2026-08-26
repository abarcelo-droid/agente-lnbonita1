// ══ RECUPERAR LOS EMBARQUES BORRADOS ═══════════════════════════════════════
//
// El 26/8/2026 un borrado de datos de prueba se llevó once embarques REALES que no
// estaban en su alcance. Del respaldo se rescataron los renglones; las cabeceras ya
// estaban pisadas.
//
// Este test no mira el código: LO CORRE. Levanta el esquema real de db_sg.js con las
// claves foráneas ENCENDIDAS, siembra los productos y envases que el rescate nombra, y
// ejecuta el restaurar() entero. Es la única forma de saber que los datos rescatados
// ENTRAN — que ningún NOT NULL, ningún CHECK y ninguna clave foránea los rebota.
//
// Un rescate que se prueba mirando el código es un rescate que se prueba el día que
// hace falta, con el que perdió los datos esperando.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESCATE, estadoRescate, restaurar } from '../src/servicios/sg_rescate_embarques.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// ── EL ESQUEMA REAL ────────────────────────────────────────────────────────
// Cada CREATE TABLE del fuente, contando paréntesis: el bloque entero no se puede
// ejecutar porque adentro hay interpolaciones de plantilla que no son SQL.
function creates(archivo) {
  const src = fs.readFileSync(path.join(RAIZ, archivo), 'utf8');
  const out = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let m;
  while ((m = re.exec(src))) {
    let d = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') d++;
      else if (src[i] === ')') { d--; if (d === 0) { i++; break; } }
    }
    const sql = src.slice(m.index, i);
    if (/_new\b|_v2\b|_vieja\b/i.test(m[1])) continue;
    if (/\$\{/.test(sql)) continue;
    out.push({ tabla: m[1], sql });
  }
  return out;
}

function baseReal() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const puestas = new Set();
  for (const c of creates('src/servicios/db_sg.js')) {
    if (puestas.has(c.tabla)) continue;
    try { db.exec(c.sql + ';'); puestas.add(c.tabla); } catch (_) { /* depende de otra */ }
  }
  const src = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');
  for (const m of src.matchAll(/ALTER TABLE ([a-z_]+) ADD COLUMN ([^"'`]+)/gi)) {
    try { db.exec('ALTER TABLE ' + m[1] + ' ADD COLUMN ' + m[2].trim() + ';'); } catch (_) { /* ya está */ }
  }
  return db;
}

// Los productos y envases que el rescate nombra. Son CONFIGURACIÓN: el borrado no los
// tocó, así que en la base de verdad están. Acá hay que ponerlos para que las claves
// foráneas tengan a quién apuntar.
function sembrarConfig(db) {
  const prods = [...new Set(RESCATE.lineas.map((l) => l.producto_id))];
  const envs = [...new Set(RESCATE.lineas.map((l) => l.envase_id).filter((x) => x != null))];
  for (const id of prods) {
    db.prepare('INSERT INTO sg_productos (id, codigo, nombre) VALUES (?,?,?)')
      .run(id, 'P' + id, 'Producto ' + id);
  }
  for (const id of envs) {
    db.prepare('INSERT INTO sg_envases (id, nombre) VALUES (?,?)').run(id, 'Envase ' + id);
  }
}

// ── LOS DATOS RESCATADOS ───────────────────────────────────────────────────
test('el archivo del rescate tiene los once embarques y sus dieciocho renglones', () => {
  assert.equal(RESCATE.embarques.length, 11);
  assert.equal(RESCATE.lineas.length, 18);
  // Ningún renglón huérfano: cada uno cuelga de un embarque declarado.
  const ids = new Set(RESCATE.embarques.map((e) => e.id));
  for (const l of RESCATE.lineas) assert.ok(ids.has(l.embarque_id), 'renglón sin embarque');
  // Y ningún embarque vacío: uno sin renglones no aporta nada y confunde.
  for (const e of RESCATE.embarques) {
    assert.ok(RESCATE.lineas.some((l) => l.embarque_id === e.id), 'embarque ' + e.id + ' sin renglones');
  }
});

test('las cajas del cabezal son la suma de sus renglones', () => {
  // El total de cajas no se rescató: se deriva. Si no coincide, el cabezal miente sobre
  // lo que tiene adentro y el costo por caja sale mal.
  for (const e of RESCATE.embarques) {
    const suma = RESCATE.lineas.filter((l) => l.embarque_id === e.id)
      .reduce((s, l) => s + l.cajas, 0);
    assert.equal(e.cantidad_cajas, suma, 'embarque ' + e.id);
  }
});

test('cada renglón tiene lo que hace falta para volver a cotizarlo', () => {
  for (const l of RESCATE.lineas) {
    assert.ok(Number.isInteger(l.producto_id) && l.producto_id > 0);
    assert.ok(l.cajas > 0, 'cajas en cero no es un renglón');
    assert.ok(l.kg_por_bulto > 0, 'sin kilos por bulto no hay kilos');
    assert.ok(l.precio_unitario_usd > 0, 'sin precio FOB no hay costeo');
    assert.match(l.creado_en, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  }
});

// ── EL RESCATE, CORRIÉNDOLO ────────────────────────────────────────────────
test('los datos rescatados ENTRAN en el esquema real', () => {
  const db = baseReal();
  sembrarConfig(db);
  const r = restaurar(db, 1);
  assert.equal(r.total, 11);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_embarques').get().n, 11);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_embarque_lineas').get().n, 18);
});

test('se conserva el NÚMERO original de cada embarque', () => {
  // Es como están anotados afuera, y los documentos que siguen en el disco cuelgan de
  // ese número. Si SQLite les da uno nuevo, el papel deja de encontrar al embarque.
  const db = baseReal();
  sembrarConfig(db);
  restaurar(db, 1);
  const ids = db.prepare('SELECT id FROM sg_embarques ORDER BY id').all().map((x) => x.id);
  assert.deepEqual(ids, RESCATE.embarques.map((e) => e.id).sort((a, b) => a - b));
});

test('los renglones quedan pegados a SU embarque, con precio y kilos', () => {
  const db = baseReal();
  sembrarConfig(db);
  restaurar(db, 1);
  for (const e of RESCATE.embarques) {
    const ls = db.prepare(`SELECT producto_id, envase_id, kg_por_bulto, cajas, precio_unitario_usd
      FROM sg_embarque_lineas WHERE embarque_id=? ORDER BY producto_id`).all(e.id);
    const esp = RESCATE.lineas.filter((l) => l.embarque_id === e.id)
      .sort((a, b) => a.producto_id - b.producto_id);
    assert.equal(ls.length, esp.length, 'embarque ' + e.id);
    ls.forEach((l, i) => {
      assert.equal(l.producto_id, esp[i].producto_id);
      assert.equal(l.envase_id, esp[i].envase_id);
      assert.equal(l.kg_por_bulto, esp[i].kg_por_bulto);
      assert.equal(l.cajas, esp[i].cajas);
      assert.equal(l.precio_unitario_usd, esp[i].precio_unitario_usd);
    });
  }
});

test('apretar dos veces NO duplica nada', () => {
  // Es un botón que va a estar en pantalla y alguien lo va a apretar de nuevo para ver
  // si esta vez sí. Tiene que no pasar nada.
  const db = baseReal();
  sembrarConfig(db);
  restaurar(db, 1);
  const otra = restaurar(db, 1);
  assert.equal(otra.total, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_embarques').get().n, 11);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_embarque_lineas').get().n, 18);
});

test('un embarque que YA existe no se pisa', () => {
  // Si el número está ocupado, lo que hay adentro gana. Recuperar no puede destruir.
  const db = baseReal();
  sembrarConfig(db);
  db.prepare(`INSERT INTO sg_embarques (id, nombre, moneda, estado, activo)
    VALUES (5,'El mío de verdad','USD','abierto',1)`).run();
  const r = restaurar(db, 1);
  assert.equal(r.total, 10);
  assert.equal(db.prepare('SELECT nombre FROM sg_embarques WHERE id=5').get().nombre, 'El mío de verdad');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_embarque_lineas WHERE embarque_id=5').get().n, 0);
});

test('el embarque nace en cotización y avisa QUÉ le falta', () => {
  // Las cabeceras no se pudieron rescatar. Que nazca en «cotización» y lo diga en las
  // observaciones es la diferencia entre completarlo y creer que está completo.
  const db = baseReal();
  sembrarConfig(db);
  restaurar(db, 1);
  for (const e of db.prepare('SELECT * FROM sg_embarques').all()) {
    assert.equal(e.estado, 'cotizacion');
    assert.equal(e.proveedor_id, null, 'el proveedor no se rescató: tiene que estar vacío');
    assert.match(e.nombre, /\(recuperado\)/);
    assert.match(e.observaciones, /faltan proveedor, país, incoterm, fechas/);
    assert.equal(e.activo, 1);
  }
});

test('estadoRescate dice qué falta y qué ya está', () => {
  const db = baseReal();
  sembrarConfig(db);
  const antes = estadoRescate(db);
  assert.equal(antes.length, 11);
  assert.equal(antes.filter((e) => !e.ya_esta).length, 11);
  // Y nombra los productos, no los números: «#667» no le dice nada a nadie.
  assert.ok(antes[0].productos.length > 0);
  assert.match(antes[0].productos[0], /Producto \d+ · \d+ cajas · USD/);
  restaurar(db, 1);
  assert.equal(estadoRescate(db).filter((e) => !e.ya_esta).length, 0);
});

// ── LAS PUERTAS ────────────────────────────────────────────────────────────
test('las rutas van ANTES de /embarques/:id', () => {
  // Si no, Express lee «rescate» como número de embarque y contesta 404 sin llegar.
  const rescate = SG.indexOf("router.get('/embarques/rescate'");
  const porId = SG.indexOf("router.get('/embarques/:id'");
  assert.ok(rescate > 0 && porId > 0);
  assert.ok(rescate < porId, 'la ruta del rescate queda tapada por /embarques/:id');
});

test('el rescate es sólo de administradores', () => {
  assert.match(SG, /router\.get\('\/embarques\/rescate', requireAdmin,/);
  assert.match(SG, /router\.post\('\/embarques\/rescate', requireAdmin,/);
});

test('el cartel se ve solo, y sólo si queda algo', () => {
  // Pablo entró a la pantalla y no vio nada. Un botón más arriba se pierde entre los
  // seis que ya hay: esto va como cartel ancho sobre la tabla, y se mira al entrar.
  assert.match(PANEL, /id="sg-imp-rescate"/);
  assert.match(PANEL, /function sgImpRescateVer\(\)/);
  assert.match(PANEL, /function sgImpRescate\(\)/);
  assert.match(PANEL, /sgImpRescateVer\(\);/, 'sgImpInit tiene que mirarlo al entrar');
  assert.match(PANEL, /if \(!r \|\| !r\.ok \|\| !r\.data \|\| !r\.data\.pendientes\) \{ c\.style\.display='none'/);
  // Una sola definición de cada una: las duplicadas se ganan entre sí en silencio.
  for (const f of ['sgImpRescateVer', 'sgImpRescate']) {
    const n = (PANEL.match(new RegExp('function ' + f + '\\(', 'g')) || []).length;
    assert.equal(n, 1, f + ' está definida ' + n + ' veces');
  }
});

test('el cartel no trae barra de desplazamiento lateral', () => {
  const i = PANEL.indexOf('function sgImpRescateVer()');
  const bloque = PANEL.slice(i, PANEL.indexOf('function sgImpRescate()', i));
  assert.match(bloque, /overflow-x:hidden !important/);
  assert.match(bloque, /table-layout:fixed/);
  assert.match(bloque, /text-overflow:ellipsis/);
});

test('los embarques NO están en el mapa de borrado', () => {
  // Lo que hizo falta rescatar no puede volver a entrar en el borrado.
  const MAPA = fs.readFileSync(path.join(RAIZ, 'src/servicios/sg_limpieza_mapa.js'), 'utf8');
  for (const t of ['sg_embarques', 'sg_embarque_lineas']) {
    assert.ok(!MAPA.includes("'" + t + "'"), t + ' volvió al mapa de borrado');
  }
});
