// ══════════════════════════════════════════════════════════════════════════
// LA FACTURA DE SERVICIO SE ADJUNTA Y SE LEE SOLA
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 4/9/2026: «en ingresar factura siempre poné la versión para adjuntar un
// PDF y que los datos los lea sola».
//
// La lectura PROPONE; el que carga confirma. De esta pantalla salen una deuda con
// la cooperativa y un asiento contable: nada se guarda sin que alguien lo mire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const DDL = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const PREF = fs.readFileSync(path.join(RAIZ, 'src/servicios/ensure_api_prefijos.js'), 'utf8');

const pedazo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  return txt.slice(i, txt.indexOf(cierre, i) + cierre.length);
};

// ── LA COLUMNA NUEVA SOBRE UNA TABLA QUE YA EXISTE ────────────────────────

test('las columnas del archivo se agregan a la tabla QUE YA ESTÁ en producción', () => {
  // sg_facturas_gasto nació en la V1008. Un CREATE TABLE IF NOT EXISTS con
  // columnas nuevas NO las agrega: se queda con la tabla vieja y nadie se entera
  // hasta que revienta el INSERT. Por eso van por ALTER. Este test corre la
  // migración de verdad contra una tabla vieja.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sg_facturas_gasto (
    id INTEGER PRIMARY KEY AUTOINCREMENT, proveedor_servicio_id INTEGER,
    numero TEXT, total REAL, activo INTEGER NOT NULL DEFAULT 1)`);

  const mig = pedazo(DDL, "  for (const [col, tipo] of [\r\n    ['archivo_ruta',", '\r\n  }');
  new Function('db', mig)(db);

  const cols = db.prepare('PRAGMA table_info(sg_facturas_gasto)').all().map((c) => c.name);
  for (const c of ['archivo_ruta', 'archivo_nombre', 'leido_por_ia']) {
    assert.ok(cols.includes(c), 'falta la columna ' + c);
  }
  // Y no se rompe si vuelve a correr: arranca en cada boot del servidor.
  new Function('db', mig)(db);
  assert.equal(db.prepare('PRAGMA table_info(sg_facturas_gasto)').all()
    .filter((c) => c.name === 'archivo_ruta').length, 1);
  // leido_por_ia arranca en 0 y no es nula: una factura vieja no fue leída.
  db.prepare('INSERT INTO sg_facturas_gasto (numero, total) VALUES (?,?)').run('0001-1', 100);
  assert.equal(db.prepare('SELECT leido_por_ia l FROM sg_facturas_gasto').get().l, 0);
});

// ── LO QUE ENTRA POR EL FORMULARIO CON ARCHIVO ────────────────────────────

test('la lista de operaciones sobrevive al viaje por multipart', () => {
  // Con FormData TODO llega como texto: `gastos` viaja como el string "[3,7]".
  // Sin parsearlo, Array.isArray da false, ids queda vacío y la factura no
  // cubriría ninguna operación — contestaría «elegí al menos una».
  const h = pedazo(SG, "router.post('/gastos-factura', ", '\r\n});');
  assert.match(h, /if \(typeof b\.gastos === 'string'\)/);
  assert.match(h, /JSON\.parse\(b\.gastos\)/);
  // Y si viene basura no explota: queda vacío y el endpoint contesta el error
  // que corresponde en vez de un 500.
  assert.match(h, /catch \(_\) \{ b\.gastos = \[\]; \}/);

  const f = new Function('b', `
    if (typeof b.gastos === 'string') {
      try { b.gastos = JSON.parse(b.gastos); } catch (_) { b.gastos = []; }
    }
    return b.gastos;`);
  assert.deepEqual(f({ gastos: '[3,7]' }), [3, 7]);
  assert.deepEqual(f({ gastos: 'no es json' }), []);
  assert.deepEqual(f({ gastos: [1, 2] }), [1, 2], 'rompió el camino sin archivo');
});

test('el papel se guarda con la factura, y de dónde salieron los números', () => {
  const h = pedazo(SG, "router.post('/gastos-factura', ", '\r\n});');
  assert.match(h, /archivo_ruta, archivo_nombre, leido_por_ia/);
  assert.match(h, /req\.file \? \('\/data\/sg\/' \+ req\.file\.filename\) : null/);
  assert.match(h, /req\.file \? \(req\.file\.originalname \|\| null\) : null/);
  // El INSERT tiene que tener tantos ? como valores: uno de menos corre todo el
  // resto una posición y no falla, guarda mal.
  const ins = pedazo(h, 'INSERT INTO sg_facturas_gasto', '`).run(');
  const campos = ins.slice(ins.indexOf('(') + 1, ins.indexOf(')')).split(',').length;
  const signos = (ins.match(/VALUES \(([?,]+)\)/) || [])[1].split(',').length;
  assert.equal(campos, signos, 'el INSERT tiene ' + campos + ' columnas y ' + signos + ' valores');
});

test('el archivo NO se nombra con el id de una orden, que acá no existe', () => {
  // facturaStorage arma el nombre con req.params.id. En esta ruta no hay :id, así
  // que salían todos como "factura_x_...". Una factura de servicio no cuelga de
  // ninguna orden.
  assert.match(SG, /const facturaGastoUpload = multer\(\{/);
  assert.match(SG, /'factserv_' \+ Date\.now\(\)/);
  assert.match(SG, /router\.post\('\/gastos-factura', facturaGastoUpload\.single\('archivo'\)/);
});

// ── EL LECTOR ─────────────────────────────────────────────────────────────

function lector({ apiKey, respuesta } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sg_proveedores (id INTEGER PRIMARY KEY, razon_social TEXT, cuit TEXT, activo INTEGER DEFAULT 1);
           INSERT INTO sg_proveedores (id, razon_social, cuit) VALUES (5,'Coop Islas Malvinas','30707971203')`);

  const src = [
    'const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;',
    pedazo(SG, "router.post('/gastos-factura/leer'", '\r\n});'),
  ].join('\n');

  const cap = {};
  const router = { post: (p, mw, h) => { cap.h = h; cap.mw = mw; } };
  new Function('getDb', 'router', 'requireAuth', 'process', 'fetch', 'MODELO_CHAT', 'console', src)(
    () => db, router,
    function requireAuth() {},
    { env: apiKey ? { ANTHROPIC_API_KEY: apiKey } : {} },
    async () => ({ json: async () => respuesta }),
    'claude-x', console);

  return async (body) => {
    let out = null, code = 200;
    await cap.h({ body }, {
      status(c) { code = c; return this; },
      json(j) { out = j; return this; },
    });
    return { code, ...out, mw: cap.mw };
  };
}

const RESP = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

test('sin archivo no se llama a nadie', async () => {
  const r = await lector({ apiKey: 'x', respuesta: RESP({}) })({});
  assert.equal(r.code, 400);
  assert.match(r.error, /Falta el archivo/);
});

test('sin la lectura configurada lo dice, y aclara que el PDF se adjunta igual', async () => {
  // Es la diferencia entre «no anda» y «cargalo a mano». El operador tiene el
  // papel en la mano y necesita saber si puede seguir.
  const r = await lector({ respuesta: RESP({}) })({ base64: 'AAA', mediaType: 'application/pdf' });
  assert.equal(r.code, 503);
  assert.match(r.error, /se adjunta igual/);
});

test('lee los datos y avisa si el CUIT no es el del proveedor elegido', async () => {
  // Es el control que evita que una factura de otro genere una deuda con quien
  // no la tiene. La lectura no se descarta: se muestra con el aviso.
  const leer = lector({ apiKey: 'x', respuesta: RESP({
    tipo_comprobante: 'factura_a', punto_venta: '0001', numero: '00001234',
    fecha_emision: '2026-09-01', cuit_emisor: '20111111112',
    neto: 100000, iva_alicuota: 21, iva_monto: 21000, total: 121000, confianza: 'alta',
  }) });
  const r = await leer({ base64: 'AAA', mediaType: 'application/pdf', proveedor_servicio_id: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.data.leido.numero, '00001234');
  assert.equal(r.data.cuit_coincide, false);
  assert.equal(r.data.proveedor.razon_social, 'Coop Islas Malvinas');
});

test('y dice que sí cuando el CUIT coincide, aunque venga con guiones', async () => {
  const leer = lector({ apiKey: 'x', respuesta: RESP({ cuit_emisor: '30-70797120-3', total: 100 }) });
  const r = await leer({ base64: 'AAA', mediaType: 'application/pdf', proveedor_servicio_id: 5 });
  assert.equal(r.data.cuit_coincide, true);
});

test('el control de suma viaja con la propuesta', async () => {
  // Que el neto y el IVA leídos den el total es otra pregunta distinta de si la
  // factura coincide con lo valorizado. Las dos se muestran, por separado.
  const ok = await lector({ apiKey: 'x', respuesta: RESP({ neto: 100000, iva_monto: 21000, total: 121000 }) })
    ({ base64: 'A', mediaType: 'application/pdf' });
  assert.equal(ok.data.cierra, true);
  assert.equal(ok.data.suma_desglose, 121000);

  const mal = await lector({ apiKey: 'x', respuesta: RESP({ neto: 100000, iva_monto: 21000, total: 130000 }) })
    ({ base64: 'A', mediaType: 'application/pdf' });
  assert.equal(mal.data.cierra, false);
});

test('si la lectura no devuelve JSON, se dice qué contestó', async () => {
  // Un 500 pelado esconde si el problema fue el PDF o el prompt.
  const r = await lector({ apiKey: 'x', respuesta: { content: [{ type: 'text', text: 'Perdón, no puedo' }] } })
    ({ base64: 'A', mediaType: 'application/pdf' });
  assert.equal(r.code, 422);
  assert.match(r.raw, /no puedo/);
});

test('y si no devuelve nada, tampoco es un 500', async () => {
  const r = await lector({ apiKey: 'x', respuesta: { content: [] } })
    ({ base64: 'A', mediaType: 'application/pdf' });
  assert.equal(r.code, 502);
});

test('el prompt prohíbe inventar y prohíbe forzar los números', () => {
  const h = pedazo(SG, "router.post('/gastos-factura/leer'", '\r\n});');
  assert.match(h, /NUNCA inventado/);
  assert.match(h, /NO fuerces\s+los números/);
  assert.match(h, /ÚNICAMENTE\s*\n?un JSON válido/);
  // El PDF necesita su beta; una foto no.
  assert.match(h, /if \(esPDF\) headers\['anthropic-beta'\]/);
});

test('leer un comprobante es una acción, no una lectura suelta', () => {
  // Es un POST: gasta la clave de la API. Va bajo el prefijo del módulo, así que
  // exigirNivel lo mide, y bloquearSiSoloLectura lo frena para el visor —que si
  // no podría quemar la cuenta sin poder guardar nada.
  assert.match(SG, /router\.post\('\/gastos-factura\/leer', requireAuth,/);
  assert.match(PREF, /sg\/gastos-factura/);
});

// ── LA PANTALLA ───────────────────────────────────────────────────────────

function modal() {
  const i = PANEL.indexOf('id="sg-fg-modal"');
  assert.ok(i > 0);
  return PANEL.slice(i, PANEL.indexOf('id="sg-fg-btn"', i));
}

test('se adjunta arriba de todo, que es el orden en que se trabaja', () => {
  const m = modal();
  assert.match(m, /id="sg-fg-pdf"/);
  assert.match(m, /Adjuntar PDF/);
  assert.match(m, /id="sg-fg-leer"[^>]*onclick="sgFgLeerPdf\(\)"/);
  assert.match(m, /accept="application\/pdf,image\/\*"/, 'no acepta una foto del comprobante');
  // Antes del primer campo del formulario.
  assert.ok(m.indexOf('id="sg-fg-pdf"') < m.indexOf('id="sg-fg-prov"'),
    'el bloque del comprobante quedó debajo de los campos');
});

test('el botón de leer aparece recién cuando hay archivo', () => {
  const m = modal();
  assert.match(m, /id="sg-fg-leer"[^>]*style="display:none"/);
  const f = pedazo(PANEL, 'function sgFgPdfElegido(input){', '\r\n}');
  assert.match(f, /leer\.style\.display = f \? '' : 'none'/);
});

test('lo leído llena los campos y NO se guarda solo', () => {
  const f = pedazo(PANEL, 'function sgFgLeerPdf(){', '\r\n}\r\n');
  for (const id of ['sg-fg-tipo', 'sg-fg-fecha', 'sg-fg-numero', 'sg-fg-total', 'sg-fg-alic']) {
    assert.ok(f.includes(id), 'no llena ' + id);
  }
  // El número entero, como está impreso: punto de venta y número por separado no
  // le dicen nada a nadie cuando hay que buscarlo.
  assert.match(f, /L\.punto_venta \+ '-' \+ L\.numero/);
  // Y recalcula, para que el cuadro de la diferencia y el asiento se actualicen.
  assert.match(f, /sgFgCalc\(\);/);
  // Lo único que NO hace es guardar.
  assert.ok(!/sgFgGuardar\(\)/.test(f), 'la lectura guarda sola');
});

test('y avisa de las cuatro cosas que hay que mirar antes de dar por buena la lectura', () => {
  const f = pedazo(PANEL, 'function sgFgLeerPdf(){', '\r\n}\r\n');
  assert.match(f, /confianza === 'baja'/);
  assert.match(f, /L\.observaciones/);
  assert.match(f, /!d\.cierra/);
  assert.match(f, /!d\.cuit_coincide/);
  // El cartel se ESCONDE cuando no hay nada que avisar: dejarlo con el aviso de
  // la lectura anterior es peor que no tenerlo.
  assert.match(f, /cont\.style\.display = avisos\.length \? '' : 'none'/);
});

test('el archivo no se arrastra de la factura anterior', () => {
  // Quedaría el PDF de una cooperativa colgado de la factura de otra.
  const f = pedazo(PANEL, 'function sgFgAbrir(){', '\r\n}\r\n');
  assert.match(f, /SGFG\.archivo = null; SGFG\.leido = 0;/);
  assert.match(f, /eid\('sg-fg-pdf'\)\.value = '';/);
  assert.match(f, /eid\('sg-fg-aviso-lectura'\)\.style\.display = 'none';/);
});

test('el PDF viaja en el MISMO pedido que la factura', () => {
  // Dos pedidos serían una factura sin papel cada vez que el segundo no corre.
  const f = pedazo(PANEL, 'function sgFgGuardar(){', '\r\n}\r\n');
  assert.match(f, /new FormData\(\)/);
  assert.match(f, /fd\.append\('archivo', SGFG\.archivo\)/);
  assert.match(f, /fd\.append\('gastos', JSON\.stringify\(ids\)\)/);
  assert.match(f, /fd\.append\('leido_por_ia'/);
  // Y el fetch NO pone Content-Type a mano: el navegador tiene que poner el
  // boundary del multipart. Ponerlo rompe el parseo del lado del servidor.
  assert.ok(!/Content-Type/.test(f), 'le pisa el Content-Type al multipart');
});

test('está en el manual, con su versión', () => {
  const i = PANEL.indexOf("SG_MANUAL.gastos = {");
  const m = PANEL.slice(i, PANEL.indexOf('\r\n};', i));
  assert.match(m, /Adjuntar el comprobante y leerlo <span class="ver">V1011<\/span>/);
  assert.match(m, /es una PROPUESTA, no un dato/);
  // Y que se puede seguir trabajando sin la lectura.
  assert.match(m, /se adjunta igual aunque la lectura no esté disponible/);
});

test('un archivo demasiado grande se avisa ANTES, no al fallar', () => {
  // Sin esto el operador se entera cuando falla, y falla con un 413 en HTML que
  // la pantalla no sabe interpretar: sale «Error de red», que no dice nada.
  // Son dos topes distintos y por razones distintas: subirlo lo limita multer a
  // 15 MB; leerlo pasa por base64 —que abulta un tercio— contra un cuerpo de 20.
  assert.match(PANEL, /var SGFG_MB_SUBIR = 15, SGFG_MB_LEER = 12;/);
  const sub = pedazo(PANEL, 'function sgFgPdfElegido(input){', '\r\n}');
  assert.match(sub, /f\.size > SGFG_MB_SUBIR \* 1024 \* 1024/);
  assert.match(sub, /input\.value = ''; f = null;/, 'deja el archivo elegido igual');

  const leer = pedazo(PANEL, 'function sgFgLeerPdf(){', '\r\n}\r\n');
  assert.match(leer, /f\.size > SGFG_MB_LEER \* 1024 \* 1024/);
  // Y no se pierde el trabajo: el archivo sigue adjunto, sólo no se lee.
  assert.match(leer, /Queda adjunto igual/);
  assert.ok(leer.indexOf('SGFG_MB_LEER') < leer.indexOf('new FileReader'),
    'lo lee entero antes de mirar el tamaño');
});

test('los dos topes del front no mienten sobre los del servidor', () => {
  // Un cartel que dice 15 MB contra un multer de 10 es peor que no tenerlo.
  assert.match(SG, /const facturaGastoUpload = multer\(\{[\s\S]{0,600}?fileSize: 15 \* 1024 \* 1024/);
  const idx = fs.readFileSync(path.join(RAIZ, 'src/index.js'), 'utf8');
  const lim = (idx.match(/express\.json\(\{ limit: '(\d+)mb' \}\)/) || [])[1];
  assert.ok(Number(lim) >= 12 * 1.37,
    'el tope de lectura (12 MB en base64 ≈ ' + Math.ceil(12 * 1.37) + ' MB) no entra en el cuerpo de ' + lim + 'mb');
});
