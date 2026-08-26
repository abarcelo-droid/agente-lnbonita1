// ══ BORRAR LOS DATOS DE PRUEBA ═════════════════════════════════════════════
//
// Pablo, 26/8/2026: un botón por módulo, sólo para administradores, que se pueda sacar
// al lanzar, y que borre DATOS y no CONFIGURACIONES.
//
// Este test no mira el código: LO CORRE. Levanta el esquema real —el DDL de db_sg.js y
// db_sg_finanzas.js, tal cual, con las claves foráneas ENCENDIDAS como en producción—,
// le mete una fila en cada tabla y ejecuta el borrado entero en el orden declarado.
//
// Es la única forma de probar esto. Un mapa de borrado se ve bien en la pantalla y
// revienta con «FOREIGN KEY constraint failed» recién cuando hay datos — y para
// entonces ya es el día de la limpieza, con Pablo mirando.
//
// De hecho, así apareció el problema que ningún orden resolvía: sg_lotes.reproceso_id
// apunta a sg_reprocesos y sg_reprocesos.lote_madre_id apunta a sg_lotes. Es un ciclo:
// borrando cualquiera de las dos primero, SQLite corta. Se rompe con un UPDATE a NULL
// antes de los DELETE, que es lo que hace `previo`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULOS, contar, limpiar, limpiarTodo, enOrden, limpiezaHabilitada, CLAVE_HABILITADA }
  from '../src/servicios/sg_limpieza.js';
import '../src/servicios/sg_limpieza_mapa.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// ── EL ESQUEMA REAL ────────────────────────────────────────────────────────
//
// Se saca cada CREATE TABLE del código fuente, uno por uno, contando paréntesis. No
// se puede ejecutar el bloque entero: adentro hay interpolaciones de plantilla que no
// son SQL, y SQLite corta en la primera. Y las tablas no están todas en el mismo
// archivo — algunas las crea el router que las usa.
const FUENTES = [
  'src/servicios/db_sg.js', 'src/servicios/db_sg_finanzas.js',
  'src/servicios/afip-wsfe-emision.js', 'src/rutas/liquidaciones.js',
  'src/rutas/sg_ventas.js', 'src/rutas/sg_tesoreria.js',
];
function creates(archivo) {
  let src;
  try { src = fs.readFileSync(path.join(RAIZ, archivo), 'utf8'); } catch (_) { return []; }
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
    // Las de migración (_new, _v2) rehacen una tabla que ya está: no van.
    if (/_new\b|_v2\b|_vieja\b/i.test(m[1])) continue;
    if (/\$\{/.test(sql)) continue;                       // lleva interpolación: no es SQL
    out.push({ tabla: m[1], sql });
  }
  return out;
}

function baseReal() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const puestas = new Set();
  for (const a of FUENTES) {
    for (const c of creates(a)) {
      if (puestas.has(c.tabla)) continue;
      try { db.exec(c.sql + ';'); puestas.add(c.tabla); } catch (_) { /* depende de otra que no está */ }
    }
  }
  // Y las columnas que se agregaron después por migración. Sin ellas falta, por
  // ejemplo, liquidaciones.oc_id — que es justo por donde se distingue una liquidación
  // de San Gerónimo de una de Abasto.
  for (const a of FUENTES) {
    let src;
    try { src = fs.readFileSync(path.join(RAIZ, a), 'utf8'); } catch (_) { continue; }
    for (const m of src.matchAll(/ALTER TABLE ([a-z_]+) ADD COLUMN ([^"'`]+)/gi)) {
      try { db.exec('ALTER TABLE ' + m[1] + ' ADD COLUMN ' + m[2].trim() + ';'); }
      catch (_) { /* ya está, o la tabla no se creó */ }
    }
  }
  return db;
}

const CONFIG = ['sg_productos', 'sg_familias', 'sg_especies', 'sg_variedades',
  'sg_presentaciones', 'sg_envases', 'sg_clientes', 'sg_proveedores', 'sg_pisos',
  'sg_cooperativas', 'sg_condiciones_pago', 'sg_puntos_venta', 'sg_fin_cuentas',
  'sg_cuentas', 'sg_asientos_modelo', 'sg_config_impositiva', 'sg_config'];

// Las tablas que el mapa declara como DATOS, sin repetir.
function tablasDeDatos() {
  const t = new Set();
  for (const m of MODULOS) for (const x of m.tablas) t.add(x.tabla);
  return [...t];
}

// Mete una fila mínima en cada tabla: sólo las columnas NOT NULL sin default, con un
// valor del tipo que corresponda. Alcanza para que los DELETE tengan qué borrar y para
// que las claves foráneas tengan a quién apuntar.
function sembrar(db, tabla) {
  let cols;
  try { cols = db.prepare('PRAGMA table_info(' + tabla + ')').all(); } catch (_) { return false; }
  if (!cols.length) return false;
  const nombres = [], valores = [];
  for (const c of cols) {
    if (c.pk && /INTEGER/i.test(c.type)) continue;          // el id lo pone SQLite
    if (!c.notnull) continue;                                // sólo lo obligatorio
    if (c.dflt_value != null) continue;                      // ya tiene valor
    nombres.push(c.name);
    valores.push(/INT|REAL|NUM/i.test(c.type) ? 1 : 'x');
  }
  const sql = nombres.length
    ? 'INSERT INTO ' + tabla + ' (' + nombres.join(',') + ') VALUES (' + nombres.map(() => '?').join(',') + ')'
    : 'INSERT INTO ' + tabla + ' DEFAULT VALUES';
  try { db.prepare(sql).run(...valores); return true; } catch (_) { return false; }
}

// ── EL MAPA, ANTES DE CORRERLO ──────────────────────────────────────────────
test('ninguna tabla tiene dos dueños: el conteo no puede mentir', () => {
  // Si una tabla estuviera en dos módulos, el cartel sumaría sus filas dos veces y le
  // diría a Pablo que se va más de lo que se va.
  const vistas = new Map();
  for (const m of MODULOS) {
    for (const t of m.tablas) {
      const k = t.tabla + (t.donde ? '|' + t.donde : '');
      assert.ok(!vistas.has(k),
        'la tabla ' + k + ' está en ' + vistas.get(k) + ' y en ' + m.clave);
      vistas.set(k, m.clave);
    }
  }
  assert.ok(vistas.size > 40, 'el mapa cubre el módulo entero');
});

test('no se toca una sola tabla de configuración', () => {
  const datos = new Set(tablasDeDatos());
  for (const c of CONFIG) {
    assert.ok(!datos.has(c), c + ' es configuración y el mapa la está borrando');
  }
});

test('cada módulo declara qué otro tiene que ir antes, y esos existen', () => {
  const claves = new Set(MODULOS.map((m) => m.clave));
  for (const m of MODULOS) {
    for (const r of (m.requiere || [])) {
      assert.ok(claves.has(r), m.clave + ' pide ' + r + ', que no existe');
    }
    // Y el que va antes tiene que tener un orden MENOR: si no, la pantalla lo
    // ofrecería después del que depende de él.
    for (const r of (m.requiere || [])) {
      const otro = MODULOS.find((x) => x.clave === r);
      assert.ok(otro.orden < m.orden,
        m.clave + ' (' + m.orden + ') va antes que ' + r + ' (' + otro.orden + ')');
    }
  }
});

// ── Y AHORA CORRIÉNDOLO DE VERDAD ───────────────────────────────────────────
test('el esquema real se levanta y el mapa lo cubre', () => {
  const db = baseReal();
  const hay = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map((r) => r.name);
  assert.ok(hay.length > 60, 'se crearon las tablas del módulo: ' + hay.length);
  // Toda tabla del mapa tiene que existir en el esquema real. Una que no exista es un
  // nombre mal escrito, y un DELETE sobre un nombre mal escrito no borra nada y no avisa.
  const faltan = tablasDeDatos().filter((t) => !hay.includes(t));
  assert.deepEqual(faltan, [], 'el mapa nombra tablas que no existen: ' + faltan.join(', '));
});

test('EL BORRADO COMPLETO PASA, con las claves foráneas encendidas', () => {
  const db = baseReal();
  // Una fila en cada tabla de datos. Se siembra en orden inverso al de borrado, para
  // que las padres existan antes que las hijas.
  const orden = MODULOS.slice().sort((a, b) => a.orden - b.orden);
  // Se siembra con las claves foráneas APAGADAS: armar un grafo entero de datos
  // válidos no es lo que este test prueba, y pelearse con eso lo volvería frágil. Lo
  // que se prueba es el BORRADO con las claves ENCENDIDAS, que es como corre en
  // producción — y para eso alcanza con que haya filas.
  db.exec('PRAGMA foreign_keys = OFF');
  const sembradas = [];
  for (const t of tablasDeDatos()) if (sembrar(db, t)) sembradas.push(t);
  db.exec('PRAGMA foreign_keys = ON');
  assert.ok(sembradas.length > 30, 'se sembraron ' + sembradas.length + ' tablas');

  // Y el ciclo de verdad: una partida que salió de un reproceso, y el reproceso que la
  // nombra como madre. Es el par que ningún orden de borrado resuelve.
  // EL CICLO, atado de verdad: una partida que salió de un reproceso, y el reproceso
  // que la nombra como madre. Es el par que ningún orden de borrado resuelve.
  db.exec('PRAGMA foreign_keys = OFF');
  const lote = db.prepare('SELECT MAX(id) id FROM sg_lotes').get().id;
  const rep = db.prepare('SELECT MAX(id) id FROM sg_reprocesos').get().id;
  db.prepare('UPDATE sg_reprocesos SET lote_madre_id=? WHERE id=?').run(lote, rep);
  db.prepare('UPDATE sg_lotes SET reproceso_id=? WHERE id=?').run(rep, lote);
  db.exec('PRAGMA foreign_keys = ON');
  // Y se comprueba que el ciclo es real: sin romperlo, NINGÚN orden funciona.
  for (const [a, b] of [['sg_reprocesos', 'sg_lotes'], ['sg_lotes', 'sg_reprocesos']]) {
    assert.throws(() => {
      db.exec('BEGIN; DELETE FROM ' + a + '; DELETE FROM ' + b + '; COMMIT;');
    }, /FOREIGN KEY/i, 'borrando ' + a + ' primero tendría que fallar');
    try { db.exec('ROLLBACK'); } catch (_) { /* ya cerró */ }
  }

  // El borrado entero, módulo por módulo, en el orden declarado.
  for (const m of orden) {
    const r = limpiar(db, m.clave, { confirmacion: m.clave });
    assert.equal(r.ok, true, 'falló ' + m.clave + ': ' + (r.error || ''));
  }

  // No puede quedar una sola fila de lo que el mapa dice que se lleva. Las tablas con
  // filtro se miden POR SU FILTRO: `liquidaciones` es compartida con Abasto y sólo se
  // lleva las de San Gerónimo, así que exigirle cero sería exigir que borre de más.
  for (const m of MODULOS) {
    for (const t of m.tablas) {
      const n = db.prepare('SELECT COUNT(*) c FROM ' + t.tabla
        + (t.donde ? ' WHERE ' + t.donde : '')).get().c;
      assert.equal(n, 0, 'quedaron ' + n + ' filas en ' + t.tabla
        + (t.donde ? ' (' + t.donde + ')' : ''));
    }
  }
});

test('y la configuración sigue entera', () => {
  const db = baseReal();
  db.exec('PRAGMA foreign_keys = OFF');
  for (const c of CONFIG) sembrar(db, c);
  db.exec('PRAGMA foreign_keys = ON');
  const antes = {};
  for (const c of CONFIG) {
    try { antes[c] = db.prepare('SELECT COUNT(*) n FROM ' + c).get().n; } catch (_) { antes[c] = null; }
  }
  for (const m of MODULOS.slice().sort((a, b) => a.orden - b.orden)) {
    limpiar(db, m.clave, { confirmacion: m.clave });
  }
  for (const c of CONFIG) {
    if (antes[c] == null) continue;
    const n = db.prepare('SELECT COUNT(*) n FROM ' + c).get().n;
    assert.equal(n, antes[c], c + ' se tocó: tenía ' + antes[c] + ' y quedó en ' + n);
  }
});

test('la liquidación de ABASTO no se toca: la tabla es compartida', () => {
  // oc_id se llena sólo cuando la liquidación sale de una partida de San Gerónimo. Las
  // que se cargan sueltas son de Abasto, y un DELETE sin filtro se las llevaría.
  const db = baseReal();
  db.prepare("INSERT INTO liquidaciones (n_liquidacion, fecha, oc_id) VALUES ('SG-1','2026-08-26',7)").run();
  db.prepare("INSERT INTO liquidaciones (n_liquidacion, fecha, oc_id) VALUES ('AB-1','2026-08-26',NULL)").run();
  limpiar(db, 'sg-liquidaciones-productor', { confirmacion: 'sg-liquidaciones-productor' });
  const quedan = db.prepare('SELECT n_liquidacion FROM liquidaciones').all().map((r) => r.n_liquidacion);
  assert.deepEqual(quedan, ['AB-1'], 'se borró la de Abasto');
});

// ── LAS PUERTAS ─────────────────────────────────────────────────────────────
test('sin escribir el nombre del módulo no se borra nada', () => {
  const db = baseReal();
  db.exec('PRAGMA foreign_keys = OFF'); sembrar(db, 'sg_ven_cobranzas'); db.exec('PRAGMA foreign_keys = ON');
  const antes = db.prepare('SELECT COUNT(*) n FROM sg_ven_cobranzas').get().n;
  for (const mal of ['', 'si', 'BORRAR', 'sg-cc-cliente']) {
    const r = limpiar(db, 'sg-cc-clientes', { confirmacion: mal });
    assert.equal(r.ok, false);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_ven_cobranzas').get().n, antes);
});

test('BORRAR TODO deja el sistema limpio de una, y en orden', () => {
  // Es lo que hace falta de verdad para lanzar. Apretar dieciséis botones adivinando
  // el orden no sirve — y encima hay pantallas que muestran datos de OTRO módulo, así
  // que su botón dice «no hay nada» sobre una pantalla llena y parece roto.
  const db = baseReal();
  db.exec('PRAGMA foreign_keys = OFF');
  const sembradas = [];
  for (const t of tablasDeDatos()) if (sembrar(db, t)) sembradas.push(t);
  db.exec('PRAGMA foreign_keys = ON');
  assert.ok(sembradas.length > 30);

  const r = limpiarTodo(db, { confirmacion: 'BORRAR TODO' });
  assert.equal(r.ok, true, r.error || '');
  assert.ok(r.total > 30, 'se borraron ' + r.total);
  for (const m of MODULOS) {
    for (const t of m.tablas) {
      const n = db.prepare('SELECT COUNT(*) c FROM ' + t.tabla
        + (t.donde ? ' WHERE ' + t.donde : '')).get().c;
      assert.equal(n, 0, 'quedaron ' + n + ' en ' + t.tabla);
    }
  }
});

test('BORRAR TODO es todo o nada, y pide escribirlo', () => {
  const db = baseReal();
  db.exec('PRAGMA foreign_keys = OFF'); sembrar(db, 'sg_ven_cobranzas'); db.exec('PRAGMA foreign_keys = ON');
  const antes = db.prepare('SELECT COUNT(*) n FROM sg_ven_cobranzas').get().n;
  for (const mal of ['', 'si', 'BORRAR', 'borrar-todo']) {
    assert.equal(limpiarTodo(db, { confirmacion: mal }).ok, false);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sg_ven_cobranzas').get().n, antes);
  // Minúsculas sí: lo que se cuida es que se escriba, no la tecla de bloqueo.
  assert.equal(limpiarTodo(db, { confirmacion: 'borrar todo' }).ok, true);
});

test('el orden de borrado sale del mapa, no de cómo estén escritos', () => {
  const o = enOrden().map((m) => m.clave);
  assert.equal(o[o.length - 1], 'sg-asientos', 'los asientos van últimos, sí o sí');
  assert.ok(o.indexOf('sg-cc-proveedores') < o.indexOf('sg-tesoreria'),
    'pagos antes que caja y bancos');
  assert.ok(o.indexOf('sg-salidas') < o.indexOf('sg-stock'),
    'los remitos antes que las partidas');
  assert.ok(o.indexOf('sg-comprobantes-emitidos') < o.indexOf('sg-salidas'));
});

test('cada pantalla dice DÓNDE vive lo que muestra y no borra', () => {
  // «Partidas pendientes de facturar» son ÓRDENES, no facturas. El botón decía «no hay
  // nada que borrar» sobre una pantalla con siete renglones, y se leyó como una falla.
  const fac = MODULOS.find((m) => m.clave === 'sg-facturas-compra');
  assert.match(fac.tambien, /ÓRDENES DE COMPRA/);
  const liq = MODULOS.find((m) => m.clave === 'sg-liquidaciones-productor');
  assert.match(liq.tambien, /ÓRDENES DE COMPRA/);
  assert.match(PANEL, /Esta pantalla no tiene datos propios para borrar/);
  assert.match(PANEL, /Borrar TODOS los datos de San Gerónimo/);
  assert.match(PANEL, /function sgLimTodo\(\)/);
});

test('el interruptor arranca APAGADO y se apaga con un solo valor', () => {
  const db = baseReal();
  assert.equal(limpiezaHabilitada(db), false, 'sin el valor, apagado');
  db.prepare('INSERT INTO sg_config (clave, valor) VALUES (?,?)').run(CLAVE_HABILITADA, '0');
  assert.equal(limpiezaHabilitada(db), false);
  db.prepare('UPDATE sg_config SET valor=? WHERE clave=?').run('1', CLAVE_HABILITADA);
  assert.equal(limpiezaHabilitada(db), true);
});

test('apagado, los endpoints no existen: contestan 404, no 403', () => {
  // Un 403 le diría a cualquiera que hay una puerta ahí. Para el que no tiene que
  // verlo, la función no existe.
  assert.match(SG, /function limpiezaViva\(req, res\)/);
  assert.match(SG, /res\.status\(404\)\.json\(\{ ok: false, error: 'No encontrado' \}\)/);
  assert.match(SG, /router\.get\('\/limpieza', requireAdmin/);
  assert.match(SG, /router\.post\('\/limpieza\/:modulo\/borrar', requireAdmin/);
  // Y la copia de la base va con el mismo interruptor.
  assert.match(SG, /router\.get\('\/limpieza-backup\/clientes\.db', requireAdmin/);
  assert.match(SG, /wal_checkpoint\(TRUNCATE\)/,
    'sin el checkpoint, lo último que se escribió no entra en la copia');
});

test('el conteo dice qué se va y qué NO se toca', () => {
  const db = baseReal();
  db.exec('PRAGMA foreign_keys = OFF'); sembrar(db, 'sg_ven_cobranzas'); db.exec('PRAGMA foreign_keys = ON');
  const c = contar(db, 'sg-cc-clientes');
  assert.equal(c.clave, 'sg-cc-clientes');
  assert.ok(c.total >= 1);
  assert.ok(c.no_se_tocan.length > 0, 'se le dice al que aprieta qué queda en pie');
  assert.ok(c.aviso, 'y qué tiene que saber antes');
});

test('dice lo que se borró DE VERDAD, y lo que quedó a propósito', () => {
  // El caso real: 7 liquidaciones, 4 de una partida de San Gerónimo y 3 sueltas de
  // Abasto. Se borran 4, quedan 3 — y apretando otra vez son 0, con razón.
  //
  // Eso pasó y se leyó como «no funciona»: el resultado estaba en un cartel que se iba
  // solo, así que la primera vez no se vio, y la segunda dijo cero. Un resultado que
  // se va solo no es un resultado.
  const db = baseReal();
  for (let i = 1; i <= 4; i++) {
    db.prepare('INSERT INTO liquidaciones (n_liquidacion,fecha,oc_id) VALUES (?,?,?)')
      .run('SG-' + i, '2026-08-25', i);
  }
  for (let i = 1; i <= 3; i++) {
    db.prepare('INSERT INTO liquidaciones (n_liquidacion,fecha,oc_id) VALUES (?,?,NULL)')
      .run('AB-' + i, '2026-08-25');
  }
  const antes = contar(db, 'sg-liquidaciones-productor');
  assert.equal(antes.total, 4, 'se van las 4 que salieron de una partida');
  assert.equal(antes.quedan[0].filas, 3, 'y se avisa que quedan 3 ANTES de apretar');
  assert.match(antes.quedan[0].por_que, /Abasto/);

  const r = limpiar(db, 'sg-liquidaciones-productor', { confirmacion: 'sg-liquidaciones-productor' });
  assert.equal(r.total, 4, 'informa lo que se borró de verdad');
  assert.equal(r.quedan[0].filas, 3);
  // Y apretando otra vez: cero, porque ya no queda nada suyo. Es correcto, y ahora se
  // explica en vez de parecer una falla.
  const r2 = limpiar(db, 'sg-liquidaciones-productor', { confirmacion: 'sg-liquidaciones-productor' });
  assert.equal(r2.total, 0);
  assert.equal(r2.quedan[0].filas, 3);
});

test('el resultado se queda en la pantalla, no en un cartel que se va', () => {
  assert.match(PANEL, /Se borraron '\s*\+ nr\(d\.total\)/);
  assert.match(PANEL, /No había nada que borrar/);
  assert.match(PANEL, /Quedó a propósito:/);
  assert.match(PANEL, /Listo, refrescar/, 'la recarga la decide el que mira, no un temporizador');
  // Y ya no se informa el conteo previo como si fuera lo borrado.
  assert.doesNotMatch(PANEL, /toast\('Se borraron '/);
});

test('el interruptor tiene DÓNDE tocarse', () => {
  // No alcanza con que el valor exista: no había una sola pantalla en el panel que
  // escribiera la configuración de San Gerónimo, así que la clave no se podía tocar
  // desde ningún lado. Un interruptor sin dónde apretarlo es un interruptor que no
  // existe.
  assert.match(PANEL, /function sgLimSwitch\(on\)/);
  assert.match(PANEL, /api\('\/api\/sg\/config', 'PUT', \{ limpieza_habilitada:/);
  assert.match(PANEL, /caja\.id = 'sg-lim-switch';/);
  // Y se ve en TODAS las pantallas que tienen algo que borrar, no en una sola. Estaba
  // en el Dashboard —que en el menú se llama «Dash» y cuelga de Informes— y ahí no lo
  // encontró nadie. Un control que no se encuentra es un control que no existe.
  assert.match(PANEL, /function sgLimSwitchMontar\(secId\)/);
  assert.match(PANEL, /if \(!SG_LIMPIEZA_PANTALLAS\[secId\]\) return;/);
  assert.match(PANEL, /sgLimSwitchMontar\('sec-' \+ s\)/, 'se monta al cambiar de pantalla');
  // Un solo nodo: se MUEVE a la pantalla abierta, no se clona.
  assert.equal((PANEL.match(/id: 'sg-lim-switch'|id="sg-lim-switch"/g) || []).length, 0);
  // Y sólo lo ve un administrador.
  assert.match(PANEL, /var esAdmin = !!\(window\.LNB_USER && window\.LNB_USER\.rol === 'admin'\);/);
  // Al apagarlo, los botones que ya estaban dibujados se sacan.
  assert.match(PANEL, /querySelectorAll\('\[data-limpieza\]'\)\.forEach\(function\(n\)\{ n\.remove\(\); \}\);/);
});

test('los dos Diarios de IVA no tienen botón', () => {
  // No guardan una sola fila propia: se arman leyendo los comprobantes y las
  // liquidaciones. Un botón ahí sería un botón que no hace nada.
  assert.equal(MODULOS.find((m) => /iva/i.test(m.clave)), undefined);
  assert.match(PANEL, /sgLimpiezaBoton|sg-limpieza/,
    'el panel tiene el botón compartido');
});
