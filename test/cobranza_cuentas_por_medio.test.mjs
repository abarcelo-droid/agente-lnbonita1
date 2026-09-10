// ══════════════════════════════════════════════════════════════════════════
// LAS CUATRO CUENTAS DE LA COBRANZA SE PONEN DONDE SE COBRA
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 10/9/2026: «el asiento modelo de cobranzas... lo ideal sería configurarlo
// desde el módulo de CC clientes, porque el asiento depende con qué nos pagan:
// entonces en cada medio de pago necesito configurar un rubro distinto. Lo mejor es
// que me lo pongas ahí».
//
// El botón ⚙️ ya estaba en Cuenta corriente de clientes. Lo que hacía era ELEGIR un
// modelo de una lista: para decir contra qué rubro va el efectivo, contra cuál la
// transferencia y contra cuál el cheque había que irse a Contabilidad SG → Asiento
// Modelo, crear un modelo y marcar línea por línea qué era cada una.
//
// NO HAY TABLA NUEVA. Las cuatro siguen siendo líneas de sg_asientos_modelo_lineas
// con su tipo_linea — que es lo que lee el cobro. Si esto guardara en otro lado
// habría dos verdades y el cobro seguiría usando la del modelo.
//
// El handler corre DE VERDAD contra una base en memoria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONT = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_contable.js'), 'utf8');
const VENTAS = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

function trozoDe(src, desde, cierre) {
  const i = src.indexOf(desde);
  assert.ok(i > 0, 'no se encontró: ' + desde);
  const f = src.indexOf(cierre, i);
  assert.ok(f > i, 'no cierra: ' + desde);
  return src.slice(i, f + cierre.length);
}
const trozo = (desde, cierre) => trozoDe(CONT, desde, cierre);

// Los cuatro tipos, del módulo de verdad: si alguien los cambia allá, este test
// cambia con ellos en vez de quedar pinneado a una copia.
const TIPOS_COBRANZA = (() => {
  const src = fs.readFileSync(path.join(RAIZ, 'src/servicios/asiento-cobranza.js'), 'utf8');
  const t = trozoDe(src, 'export const TIPOS_COBRANZA = [', '\r\n];')
    .replace('export const', 'const');
  // eslint-disable-next-line no-new-func
  return new Function(t + '\nreturn TIPOS_COBRANZA;')();
})();

// ── El handler, corriendo ─────────────────────────────────────────────────
function armar({ conModelo, compartido } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_asientos_modelo (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT,
      descripcion TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_asientos_modelo_lineas (id INTEGER PRIMARY KEY AUTOINCREMENT,
      modelo_id INTEGER, cuenta_id INTEGER, lado TEXT, descripcion TEXT, orden INTEGER,
      tipo_linea TEXT DEFAULT 'libre');
    CREATE TABLE sg_cuentas (id INTEGER PRIMARY KEY, codigo TEXT, nombre TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_cuentas_usuarios (cuenta_id INTEGER, usuario_id INTEGER);
    CREATE TABLE usuarios (id INTEGER PRIMARY KEY, nombre TEXT);
    CREATE TABLE sg_config (clave TEXT PRIMARY KEY, valor TEXT, modificado_en TEXT, modificado_por INTEGER);
    INSERT INTO sg_cuentas (id, codigo, nombre) VALUES
      (10,'1.01.02.0001','Deudores por ventas'),
      (20,'1.01.01.0001','Caja pesos'),
      (30,'1.01.01.0002','Banco Nación c/c'),
      (40,'1.01.01.0009','Cheques en cartera'),
      (50,'1.01.01','Disponibilidades'),        -- NO imputable: es padre de las de arriba
      (60,'1.01.01.0099','Cuenta de baja'),
      (70,'1.01.01.0077','Cuenta restringida');
    UPDATE sg_cuentas SET activo=0 WHERE id=60;
    INSERT INTO usuarios (id, nombre) VALUES (9,'Sofía');
    INSERT INTO sg_cuentas_usuarios VALUES (70, 9);
  `);
  if (conModelo) {
    db.exec(`INSERT INTO sg_asientos_modelo (id, nombre, activo) VALUES (5,'Cobranza de clientes',1);
      INSERT INTO sg_config (clave, valor) VALUES ('asiento_modelo_cobranza','5');
      -- Una línea que NO es de cobranza: tiene que sobrevivir a la edición.
      INSERT INTO sg_asientos_modelo_lineas (modelo_id, cuenta_id, lado, descripcion, orden, tipo_linea)
        VALUES (5, 30, 'debe', 'Un renglón que alguien agregó a mano', 9, 'libre');`);
  }
  if (compartido) {
    db.exec(`INSERT INTO sg_config (clave, valor) VALUES ('asiento_modelo_venta','5');`);
  }

  const fuente = [
    trozo('function cuentaEsImputable(db, cuentaId) {', '\r\n}'),
    trozo('function usuariosDeCuenta(cuentaId) {', '\r\n}'),
    trozo('function puedeUsarCuenta(usuario, cuentaId) {', '\r\n}'),
    trozo('function mensajeRestringida(cuenta) {', '\r\n}'),
    trozo('function erroresCobranza(lineas, prov) {', '\r\n}'),
    trozo('const CIRCUITOS = [', '\r\n];'),
    trozo("router.put('/modelos/cobranza'", '\r\n});'),
  ].join('\n\n');

  // node:sqlite no trae .transaction() como better-sqlite3. Se le pone una DE
  // VERDAD —BEGIN / COMMIT / ROLLBACK— y no un envoltorio que sólo ejecuta: la
  // atomicidad es justamente lo que hay que probar. Si el handler se cae en el
  // medio, la base tiene que quedar como estaba.
  db.transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try {
      const r = fn(...args);
      db.exec('COMMIT');
      return r;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const cap = {};
  const router = { put: (p, mw, h) => { cap.ruta = p; cap.mw = mw; cap.put = h; } };
  const requireAdmin = function requireAdmin() {};
  const esModeloDeCobranza = (lineas) => {
    const tipos = TIPOS_COBRANZA.map((t) => t.tipo);
    return (lineas || []).some((l) => tipos.includes(l.tipo_linea));
  };
  // eslint-disable-next-line no-new-func
  new Function('db', 'router', 'requireAdmin', 'TIPOS_COBRANZA', 'CLAVE_MODELO_COBRANZA',
    'esModeloDeCobranza', fuente)(
    db, router, requireAdmin, TIPOS_COBRANZA, 'asiento_modelo_cobranza', esModeloDeCobranza);
  assert.ok(cap.put, 'no se registró PUT /modelos/cobranza');

  return {
    db, ruta: cap.ruta, mw: cap.mw,
    PUT: (body, user) => {
      let out = null, code = 200;
      const res = { status(c) { code = c; return this; }, json(j) { out = j; return this; } };
      cap.put({ body: body || {}, _user: user || { id: 1, rol: 'admin' } }, res);
      return { code, ...out };
    },
    lineas: () => db.prepare(`SELECT cuenta_id, lado, tipo_linea, orden FROM sg_asientos_modelo_lineas
      ORDER BY orden, id`).all().map((l) => ({ ...l })),
    elegido: () => {
      const c = db.prepare("SELECT valor FROM sg_config WHERE clave='asiento_modelo_cobranza'").get();
      return c && c.valor ? Number(c.valor) : null;
    },
    modelos: () => db.prepare('SELECT COUNT(*) n FROM sg_asientos_modelo').get().n,
  };
}

const CUATRO = { clientes: 10, efectivo: 20, banco: 30, cheques: 40 };

// ══════════════════════════════════════════════════════════════════════════
// 1 · GUARDAR LAS CUATRO ALCANZA: NO HAY QUE IR A OTRO MÓDULO
// ══════════════════════════════════════════════════════════════════════════

test('sin modelo, guardar las cuatro lo CREA y lo deja elegido', () => {
  const a = armar();
  const r = a.PUT({ cuentas: CUATRO });
  assert.equal(r.code, 200, r.error);
  assert.equal(r.data.creado, true);
  assert.equal(a.modelos(), 1, 'no se creó el modelo');
  // Y QUEDA ELEGIDO. Sin esto quedaría un modelo huérfano: el circuito seguiría
  // sin modelo y el cobro seguiría sin entrar, que es el problema que esto viene
  // a resolver.
  assert.equal(a.elegido(), r.data.modelo_id);
  assert.equal(a.lineas().length, 4);
});

test('el LADO lo pone el servidor, no el que llama', () => {
  // Que el cliente pueda mandar «Clientes al debe» es la puerta que el editor
  // cierra a mano. Un cobro con la cuenta corriente al debe SUBE la deuda del
  // cliente en vez de bajarla: cobrarle le quedaría debiendo el doble.
  const a = armar();
  a.PUT({ cuentas: CUATRO, lado: 'debe',
    lineas: [{ tipo_linea: 'cobro_clientes', lado: 'debe' }] });
  const porTipo = {};
  for (const l of a.lineas()) porTipo[l.tipo_linea] = l.lado;
  assert.equal(porTipo.cobro_clientes, 'haber', 'cobrar es que el cliente DEJE de deber');
  assert.equal(porTipo.cobro_efectivo, 'debe');
  assert.equal(porTipo.cobro_banco, 'debe');
  assert.equal(porTipo.cobro_cheques, 'debe');
});

test('con modelo ya elegido lo EDITA: no crea uno nuevo cada vez', () => {
  const a = armar({ conModelo: true });
  const r = a.PUT({ cuentas: CUATRO });
  assert.equal(r.code, 200, r.error);
  assert.equal(r.data.creado, false);
  assert.equal(a.modelos(), 1, 'creó un modelo de más');
  assert.equal(r.data.modelo_id, 5, 'le cambió el id al modelo');
  assert.equal(a.elegido(), 5);
});

test('y editar NO se lleva puestas las otras líneas del modelo', () => {
  // El PUT del editor borra TODAS las líneas y las reescribe. Hacer eso acá se
  // llevaría cualquier renglón que alguien haya agregado a mano, en silencio.
  const a = armar({ conModelo: true });
  a.PUT({ cuentas: CUATRO });
  const libres = a.lineas().filter((l) => l.tipo_linea === 'libre');
  assert.equal(libres.length, 1, 'se borró una línea que no era de cobranza');
  assert.equal(libres[0].cuenta_id, 30);
});

test('guardar dos veces no duplica las líneas', () => {
  const a = armar();
  a.PUT({ cuentas: CUATRO });
  a.PUT({ cuentas: { ...CUATRO, efectivo: 40 } });
  assert.equal(a.lineas().filter((l) => l.tipo_linea === 'cobro_efectivo').length, 1);
  assert.equal(a.lineas().find((l) => l.tipo_linea === 'cobro_efectivo').cuenta_id, 40);
});

test('las que se dejan en blanco no existen como línea', () => {
  // Efectivo, banco y cheques son un PISO: pueden no hacer falta si las cajas
  // traen la suya. Guardar una línea sin cuenta sería un renglón del asiento
  // apuntando a la nada.
  //
  // El que no cobra con cheque no tiene por qué configurar dónde va un cheque:
  // acá se guardan Clientes y Efectivo y las otras dos quedan sin existir.
  const a = armar();
  const r = a.PUT({ cuentas: { clientes: 10, efectivo: 20, banco: null, cheques: '' } });
  assert.equal(r.code, 200, r.error);
  assert.deepEqual(a.lineas().map((l) => l.tipo_linea), ['cobro_clientes', 'cobro_efectivo']);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LO QUE NO SE PUEDE GUARDAR
// ══════════════════════════════════════════════════════════════════════════

test('sin la cuenta de Clientes no se guarda NADA', () => {
  // Es la única que corta: sin ella no hay contra qué cancelar y no se puede
  // cobrar con ningún medio. Y tiene que cortar ANTES de escribir: un modelo a
  // medias dejaría el circuito peor que antes.
  const a = armar();
  const r = a.PUT({ cuentas: { efectivo: 20, banco: 30 } });
  assert.equal(r.code, 400);
  assert.match(r.error, /cuenta corriente/i);
  assert.equal(a.modelos(), 0, 'creó el modelo igual');
  assert.equal(a.elegido(), null);
});

test('una cuenta que agrupa a otras no se puede imputar', () => {
  const a = armar();
  const r = a.PUT({ cuentas: { ...CUATRO, efectivo: 50 } });
  assert.equal(r.code, 400);
  assert.match(r.error, /agrupa a otras/);
  assert.equal(a.modelos(), 0);
});

test('ni una dada de baja', () => {
  const a = armar();
  const r = a.PUT({ cuentas: { ...CUATRO, banco: 60 } });
  assert.equal(r.code, 400);
  assert.match(r.error, /no existe o está dada de baja/);
});

test('ni una restringida a otra persona: 403 y dice a quién pedirle', () => {
  const a = armar();
  const r = a.PUT({ cuentas: { ...CUATRO, efectivo: 70 } }, { id: 3, rol: 'operador' });
  assert.equal(r.code, 403);
  assert.match(r.error, /Sofía/);
});

test('no se pisa un modelo que otro circuito está usando', () => {
  // Nada impide hoy que dos circuitos apunten al mismo modelo. Editarlo desde acá
  // le metería líneas de cobranza al modelo de VENTA, y las ventas dejarían de
  // asentarse sin que nadie se entere hasta que alguien factura.
  const a = armar({ conModelo: true, compartido: true });
  const r = a.PUT({ cuentas: CUATRO });
  assert.equal(r.code, 400);
  assert.match(r.error, /también se usa para «Venta»/);
  assert.equal(a.lineas().filter((l) => l.tipo_linea.startsWith('cobro_')).length, 0);
});

test('lo que la pantalla deja guardar es lo que el editor aceptaría', () => {
  // Si no, las dos pantallas dirían cosas distintas del mismo modelo.
  const a = armar();
  const r = a.PUT({ cuentas: { clientes: 10 } });
  assert.equal(r.code, 400);
  assert.match(r.error, /al menos una línea de dónde entra la plata/);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · UNA SOLA FUENTE DE VERDAD
// ══════════════════════════════════════════════════════════════════════════

test('lo guardado es EXACTAMENTE lo que después lee el cobro', async () => {
  // cuentasDeCobranza() es la que usa el POST de la cobranza. Se corre la de
  // verdad contra la base que dejó el handler: si esto guardara en una tabla
  // propia, acá saldría todo en null y el cobro seguiría sin entrar.
  const a = armar();
  a.PUT({ cuentas: CUATRO });
  a.db.exec('CREATE TABLE sg_config_impositiva (clave TEXT, cuenta_id INTEGER);');

  const src = fs.readFileSync(path.join(RAIZ, 'src/servicios/asiento-cobranza.js'), 'utf8');
  const fuente = [
    trozoDe(src, 'export function modeloCobranzaLineas(db) {', '\r\n}'),
    trozoDe(src, 'export function cuentasDeCobranza(db) {', '\r\n}'),
    trozoDe(src, 'export function cuentaCorrienteDe(db, cliente) {', '\r\n}'),
  ].join('\n\n').replace(/export function/g, 'function');
  // eslint-disable-next-line no-new-func
  const api = new Function('CLAVE_MODELO_COBRANZA',
    fuente + '\nreturn { cuentasDeCobranza, cuentaCorrienteDe };')('asiento_modelo_cobranza');

  const c = api.cuentasDeCobranza(a.db);
  assert.equal(c.clientes, 10);
  assert.equal(c.efectivo, 20);
  assert.equal(c.banco, 30);
  assert.equal(c.cheques, 40);
  // Y el cliente SIN cuenta propia cae al rubro común, que es toda la gracia.
  assert.deepEqual(api.cuentaCorrienteDe(a.db, { cuenta_contable_id: null }),
    { cuenta_id: 10, de: 'modelo' });
  // El que la tiene, la conserva: hay clientes con cuenta corriente propia en el plan.
  assert.deepEqual(api.cuentaCorrienteDe(a.db, { cuenta_contable_id: 99 }),
    { cuenta_id: 99, de: 'cliente' });
});

test('un solo escritor de sg_asientos_modelo: sigue siendo sg_contable.js', () => {
  // Escribir el endpoint en sg_ventas.js habría sido el segundo escritor de la
  // misma tabla — el problema que servicios/asientos.js ya resolvió del lado del
  // libro. Esto lo evita el año que viene también.
  const raiz = path.join(RAIZ, 'src');
  const hits = [];
  (function rec(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { rec(p); continue; }
      if (!f.name.endsWith('.js')) continue;
      const t = fs.readFileSync(p, 'utf8');
      if (/INSERT INTO sg_asientos_modelo\b/.test(t)) hits.push(path.relative(RAIZ, p));
    }
  })(raiz);
  assert.deepEqual(hits, ['src\\rutas\\sg_contable.js'.replace(/\\/g, path.sep)],
    'apareció otro escritor de asientos modelo: ' + hits.join(', '));
});

test('la ruta va ANTES de /modelos/:id, o esa se la come', () => {
  // 'cobranza' entraría como :id, parseInt daría NaN y contestaría «modelo no
  // encontrado» — un 404 por un problema de orden de rutas es media hora perdida.
  const iCob = CONT.indexOf("router.put('/modelos/cobranza'");
  const iId = CONT.indexOf("router.get('/modelos/:id'");
  const iPutId = CONT.indexOf("router.put('/modelos/:id'");
  assert.ok(iCob > 0 && iId > 0 && iPutId > 0);
  assert.ok(iCob < iId && iCob < iPutId, 'la ruta quedó después de /modelos/:id');
});

test('y pide admin: escribe las cuentas con las que entra al libro toda la plata', () => {
  const a = armar();
  assert.equal(a.mw && a.mw.name, 'requireAdmin');
  assert.equal(a.ruta, '/modelos/cobranza');
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LA CARTERA DE CHEQUES TENÍA LA PRECEDENCIA AL REVÉS
// ══════════════════════════════════════════════════════════════════════════

test('la cuenta de cheques que se configura es la que se usa', () => {
  // El cobro leía PRIMERO sg_config_impositiva['cheques_cartera'] y después el
  // modelo. Con eso, la cuenta elegida en la pantalla se mostraba y NO se usaba:
  // el asiento iba contra la otra y la pantalla mentía.
  const i = VENTAS.indexOf('let ctaCartera = null;');
  assert.ok(i > 0);
  const b = VENTAS.slice(i, VENTAS.indexOf('const ch = m.cheque || {};', i));
  assert.match(b, /ctaCartera = cuentasDeCobranza\(db\)\.cheques \|\| null;/);
  assert.ok(!/SELECT cuenta_id FROM sg_config_impositiva/.test(b),
    'el cobro sigue leyendo la config impositiva antes que el modelo');
});

test('pero no se pierde la de Configuración impositiva', () => {
  // Las instalaciones que sólo tienen aquélla siguen igual: el resolutor cae solo
  // a ella cuando el modelo no trae la línea. Lo único que cambia es cuál gana
  // cuando están las dos — y la que gana pasa a ser la que se ve.
  const src = fs.readFileSync(path.join(RAIZ, 'src/servicios/asiento-cobranza.js'), 'utf8');
  const f = trozoDe(src, 'export function modeloCobranzaLineas(db) {', '\r\n}');
  assert.match(f, /cheques_cartera/);
  assert.match(f, /!lineas\.some\(\(l\) => l\.tipo_linea === 'cobro_cheques'\)/);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LA PANTALLA
// ══════════════════════════════════════════════════════════════════════════

const trozoP = (desde, cierre) => trozoDe(PANEL, desde, cierre);

test('el bloque se pinta en los DOS estados del modal', () => {
  // La rama del «todavía no se eligió» es JUSTO el estado en que se entra a
  // configurar por primera vez. Si el bloque fuera sólo al final, no aparecería
  // nunca cuando más hace falta.
  const f = trozoP('function sgModeloPintar(k){', '\r\n}');
  const marca = "k === 'cobranza' ? sgModeloCobranzaBloque(d)";
  assert.equal(f.split(marca).length, 3, 'el bloque no se pinta en los dos estados');
  // Y el primero de los dos está ANTES del return temprano — que es el estado
  // «todavía no se eligió modelo», o sea el de la primera vez que se configura.
  assert.ok(f.indexOf(marca) < f.indexOf('    return;'),
    'el primero quedó después del return: no se ve cuando no hay modelo');
});

test('vive adentro de #sg-modelo-cuerpo, no colgado del modal', () => {
  // Es lo único que se reescribe entero en cada pintada. Un hermano sobreviviría
  // al cierre y aparecería al abrir el circuito de descarga o el de flete: es el
  // bug de «un formulario que sólo se esconde CONSERVA lo que tenía».
  assert.ok(!/id="sg-cobcta-clientes"/.test(PANEL), 'el bloque está escrito en el HTML estático');
  const f = trozoP('function sgModeloPintar(k){', '\r\n}');
  assert.match(f, /box\.innerHTML/);
});

test('los cuatro renglones salen del SERVIDOR, no de una lista en el panel', () => {
  // TIPOS_COBRANZA existe para que el asiento, el editor y la pantalla digan lo
  // mismo. Una cuarta copia acá es la que un día queda distinta.
  const f = trozoP('function sgModeloCobranzaBloque(d){', '\r\n}');
  assert.match(f, /var tipos = d\.tipos \|\| \[\]/);
  assert.ok(!/cobro_efectivo'\s*,\s*'/.test(f), 'la pantalla tiene su propia lista de medios');
  // Y el GET los manda.
  assert.match(VENTAS, /const tipos = TIPOS_COBRANZA;/);
});

test('se guardan las cuatro juntas, con un botón', () => {
  // Con onchange se escribirían estados intermedios inválidos —el primero
  // rebotaría por faltar la de Clientes— y el operador vería un error por algo
  // que estaba a medio cargar.
  const f = trozoP('function sgModeloCobranzaBloque(d){', '\r\n}');
  assert.match(f, /onclick="sgModeloCobranzaGuardar\(\)"/);
  assert.ok(!/onchange=/.test(f), 'guarda con cada cambio');
  const g = trozoP('function sgModeloCobranzaGuardar(){', '\r\n}');
  assert.match(g, /'\/api\/sg\/contable\/modelos\/cobranza', 'PUT'/);
  // Y NO se cierra el modal: adentro queda lo que hay que leer.
  assert.ok(!/closeMB/.test(g), 'se cierra al guardar y no se ve contra qué quedó');
});

test('y si hay un cobro abierto, su cuadro se rehace', () => {
  // El asiento que muestra se armó con las cuentas VIEJAS: sin esto se aprueba un
  // cuadro que no es el que se va a grabar.
  const g = trozoP('function sgModeloCobranzaGuardar(){', '\r\n}');
  assert.match(g, /sg-cob-modal.*classList\.contains\('on'\)/s);
  assert.match(g, /sgCobAsientoPintar\(\)/);
  assert.match(g, /sgModeloCargar\('cobranza'\)/);
});

test('sólo lo ve el administrador: el PUT es requireAdmin', () => {
  // Ofrecer un control que va a contestar 403 hace creer que se rompió algo.
  //
  // SE MIRAN LAS DOS PINTADAS, no que exista una. La primera versión de este test
  // buscaba el patrón UNA vez y sobrevivía a sacarle el `esAdmin` a la segunda
  // rama: el bloque quedaba visible para cualquiera con sesión en el estado
  // «ya hay modelo», que es el 99% del tiempo.
  const f = trozoP('function sgModeloPintar(k){', '\r\n}');
  const todas = (f.match(/sgModeloCobranzaBloque\(d\)/g) || []).length;
  const guardadas = (f.match(/esAdmin && k === 'cobranza' \? sgModeloCobranzaBloque\(d\)/g) || []).length;
  assert.equal(todas, 2, 'se pinta ' + todas + ' veces y tienen que ser dos');
  assert.equal(guardadas, todas, 'una de las pintadas no pide administrador');
  // Y el plan de cuentas ni siquiera viaja para el que no puede guardarlo.
  assert.match(VENTAS, /const esAdmin = req\._user\?\.rol === 'admin';/);
  assert.match(VENTAS, /const plan = esAdmin/);
});

test('el plan que viaja ya viene sin las cuentas que agrupan', () => {
  // Al desplegable largo se le monta solo el buscador, y ése rearma las opciones:
  // un `disabled` se perdería y se podría elegir una cuenta no imputable. Lo que
  // no se puede elegir, no viaja.
  //
  // SE CORRE LA CONSULTA, no se lee. La primera versión de este test miraba que el
  // texto dijera NOT EXISTS y sobrevivía a romperle el LIKE de adentro: la consulta
  // seguía diciendo lo correcto y devolvía todo igual.
  const i = VENTAS.indexOf("? db.prepare(`SELECT c.id, c.codigo, c.nombre FROM sg_cuentas c");
  assert.ok(i > 0, 'cambió la consulta del plan de cuentas');
  const sql = VENTAS.slice(VENTAS.indexOf('SELECT', i), VENTAS.indexOf('`)', i));
  const a = armar();
  const ids = a.db.prepare(sql).all().map((c) => Number(c.id));
  // 50 es '1.01.01', padre de las tres de abajo: agrupa y no se puede imputar.
  assert.ok(!ids.includes(50), 'viaja una cuenta que agrupa a otras: se podría imputar contra ella');
  // 60 está dada de baja.
  assert.ok(!ids.includes(60), 'viaja una cuenta dada de baja');
  // Y las que sí se pueden usar están todas.
  for (const ok of [10, 20, 30, 40]) assert.ok(ids.includes(ok), 'falta la cuenta ' + ok);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · Y EL MANUAL DICE LO QUE EL CÓDIGO HACE
// ══════════════════════════════════════════════════════════════════════════
//
// Se prueba contra el CÓDIGO, no contra sí mismo: lo que hay que clavar es que lo
// que el manual AFIRMA sigue siendo cierto.
// EL MANUAL SE LEE COMO SE VE, no como está escrito. En el fuente cada párrafo
// viene cortado en pedazos —'… ' + '…'— así que una frase de doce palabras puede
// tener tres cortes en el medio, y un assert sobre ella falla por DÓNDE se cortó la
// línea y no por lo que dice. Se pegan los pedazos y se busca sobre el texto.
const plano = (txt) => String(txt).replace(/'\s*\+\s*'/g, '');

const MAN_CC = (() => {
  const i = PANEL.indexOf('SG_MANUAL.ccclientes = ');
  const j = PANEL.indexOf('SG_MANUAL.catalogo', i);
  assert.ok(i > 0 && j > i, 'no está el manual de Cuenta corriente de clientes');
  return plano(PANEL.slice(i, j));
})();

test('el manual tiene la entrada, con su versión', () => {
  assert.match(MAN_CC, /Un rubro distinto por cada medio de pago <span class="ver">V1039<\/span>/);
});

test('«la de Clientes se usa siempre» — y es la única obligatoria', () => {
  assert.match(MAN_CC, /<b>Se usa siempre\.<\/b>/);
  assert.match(MAN_CC, /Es la única obligatoria/);
  // Y el endpoint corta sin ella, sin escribir nada.
  const a = armar();
  assert.equal(a.PUT({ cuentas: { efectivo: 20 } }).code, 400);
  assert.equal(a.modelos(), 0);
  // Mientras que sin la de cheques guarda igual.
  assert.equal(a.PUT({ cuentas: { clientes: 10, efectivo: 20 } }).code, 200);
});

test('«Efectivo y Banco son el piso» — y el cobro usa la de la caja si la tiene', () => {
  assert.match(MAN_CC, /son el piso<\/b>/);
  assert.match(MAN_CC, /<b>manda ésa<\/b>/);
  // El backend: la cuenta elegida manda, y sólo cae al piso si no la trae.
  const i = VENTAS.indexOf('if (!cuenta.cta) {');
  assert.ok(i > 0);
  const b = VENTAS.slice(i, i + 320);
  assert.match(b, /const piso = cuentasDeCobranza\(db\);/);
  assert.match(b, /forma === 'efectivo' \? piso\.efectivo : piso\.banco/);
});

test('«si se deja vacía la de cheques se usa la de Configuración impositiva»', () => {
  assert.match(MAN_CC, /se usa la de Configuración impositiva/);
  const src = fs.readFileSync(path.join(RAIZ, 'src/servicios/asiento-cobranza.js'), 'utf8');
  const f = trozoDe(src, 'export function modeloCobranzaLineas(db) {', '\r\n}');
  assert.match(f, /!lineas\.some\(\(l\) => l\.tipo_linea === 'cobro_cheques'\)/);
  assert.match(f, /ci\.clave = 'cheques_cartera'/);
});

test('«guardar las cuentas lo crea y lo deja elegido» — y así es', () => {
  assert.match(MAN_CC, /guardar las cuentas lo crea y lo deja elegido/);
  const a = armar();
  const r = a.PUT({ cuentas: CUATRO });
  assert.equal(r.data.creado, true);
  assert.equal(a.elegido(), r.data.modelo_id);
});

test('«el resto del modelo queda intacto» — y queda', () => {
  assert.match(MAN_CC, /el resto del modelo queda intacto/);
  const a = armar({ conModelo: true });
  a.PUT({ cuentas: CUATRO });
  assert.equal(a.lineas().filter((l) => l.tipo_linea === 'libre').length, 1);
});

test('«no se puede usar el mismo modelo para dos circuitos» — y lo frena', () => {
  assert.match(MAN_CC, /no<\/b> se puede es usar el mismo modelo para dos circuitos/);
  const a = armar({ conModelo: true, compartido: true });
  assert.equal(a.PUT({ cuentas: CUATRO }).code, 400);
});

test('«la ventana no se cierra» al guardar — y no se cierra', () => {
  assert.match(MAN_CC, /La ventana <b>no se cierra<\/b>/);
  const g = trozoP('function sgModeloCobranzaGuardar(){', '\r\n}');
  assert.ok(!/closeMB/.test(g));
});

test('«el cuadro muestra la del asiento modelo y lo aclara» — y lo aclara', () => {
  assert.match(MAN_CC, /muestra la del <b>asiento modelo<\/b> y lo aclara/);
  const f = trozoP('function sgCobAsientoPintar(){', '\r\n}');
  assert.match(f, /\(por el asiento modelo\)/);
});

test('y el manual del editor avisa que hay una segunda puerta al mismo modelo', () => {
  const i = PANEL.indexOf('SG_MANUAL.modelos = ');
  const j = PANEL.indexOf('SG_MANUAL.gastos', i);
  const man = plano(PANEL.slice(i, j));
  assert.match(man, /segunda puerta<\/b> <span class="ver">V1039<\/span>/);
  assert.match(man, /Es el <b>mismo<\/b> modelo/);
  // Y es cierto: las dos puertas escriben las MISMAS líneas del MISMO modelo.
  const f = trozo("router.put('/modelos/cobranza'", '\r\n});');
  assert.match(f, /INSERT INTO sg_asientos_modelo_lineas/);
  assert.ok(!/CREATE TABLE/.test(f), 'guardó en una tabla propia');
});

test('la pantalla dice cuál es el piso y cuál se usa siempre', () => {
  // Es lo que va a confundir: se configura «Banco Nación» y el cobro sale contra
  // otra cuenta porque el banco elegido trae la suya. Dicho en la pantalla, deja
  // de ser un misterio.
  const f = trozoP('function sgModeloCobranzaBloque(d){', '\r\n}');
  assert.match(f, /Se usa siempre\. Sólo la pisa el cliente que tenga cuenta propia/);
  assert.match(f, /Piso: manda la cuenta contable de la caja o el banco/);
  assert.match(f, /Si la dejás vacía se usa la de Configuración impositiva/);
  // Y lo convierte en un número: cuántas cuentas de Caja y Bancos no traen la suya.
  assert.match(f, /no tienen la suya/);
  assert.match(VENTAS, /const sin_contable = \{ caja:/);
});
