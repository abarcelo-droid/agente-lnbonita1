// ══════════════════════════════════════════════════════════════════════════
// EL ASIENTO MODELO DE LA DESCARGA, EN LA PANTALLA DONDE SE TRABAJA
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 3/9/2026: «necesito un selector de rubros... si querés en Cooperativa,
// ponéme con qué asiento modelo lo hacemos y lo seleccionamos ahí».
//
// Dos puertas al MISMO cuarto: la de Contabilidad SG (el cuadro de circuitos) y
// ésta, arriba de Control Cooperativa. Que haya dos puertas está bien; que
// hubiera dos valores sería el problema, y de eso se ocupa el primer test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const CONT = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_contable.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// ── LAS DOS PUERTAS, EL MISMO VALOR ───────────────────────────────────────

test('las dos pantallas guardan el modelo de la descarga en la MISMA clave', () => {
  // Si una escribiera 'asiento_modelo_descarga' y la otra
  // 'asiento_modelo_cooperativa', cada pantalla mostraría un valor distinto y
  // el que contabiliza usaría uno de los dos. Nadie lo notaría hasta el cierre.
  assert.match(SG, /const CLAVE_MODELO_GASTO = 'asiento_modelo_descarga';/);
  const i = CONT.indexOf('const CIRCUITOS = [');
  assert.match(CONT.slice(i, CONT.indexOf('];', i)), /'asiento_modelo_descarga'/);
});

// ── UN SOLO CHEQUEO DE «¿SIRVE ESTE MODELO?» ──────────────────────────────

test('el chequeo del modelo está escrito UNA vez, y lo usan los cuatro circuitos', () => {
  // Estaba copiado TRES veces —liquidación, factura de mercadería y flete— y la
  // descarga iba a ser la cuarta. Copias de la misma regla son reglas distintas:
  // se corrige una y las otras quedan como estaban.
  assert.equal((SG.match(/function queLeFaltaAlModelo\(/g) || []).length, 1);
  assert.equal((SG.match(/queLeFaltaAlModelo\(m\.lineas,/g) || []).length, 4,
    'algún circuito dejó de usar el chequeo común');
  // Y no quedó ninguna copia suelta.
  assert.equal((SG.match(/faltan\.push\('no tiene ninguna línea'\)/g) || []).length, 1,
    'quedó una copia del chequeo fuera del helper');
});

test('y al flete le vuelve el chequeo que su copia había perdido', () => {
  // La copia del flete no miraba si el modelo tenía alguna línea en el HABER:
  // un modelo todo al debe pasaba como bueno y ese asiento no podía balancear
  // nunca. Es exactamente lo que hacen las copias.
  const i = SG.indexOf("router.get('/flete/modelo'");
  const h = SG.slice(i, SG.indexOf('\r\n});', i));
  assert.match(h, /queLeFaltaAlModelo\(m\.lineas, 'lo que se le debe al fletero'\)/);
  const f = chequeo();
  const todoAlDebe = [
    { lado: 'debe', tipo_linea: 'libre',       cuenta_codigo: '5.01.01.0001' },
    { lado: 'debe', tipo_linea: 'proveedores', cuenta_codigo: '2.01.01.0001' },
  ];
  assert.ok(f(todoAlDebe, 'lo que se le debe al fletero')
    .includes('no tiene ninguna línea en el haber'));
});

function chequeo() {
  const i = SG.indexOf('function queLeFaltaAlModelo(');
  const src = SG.slice(i, SG.indexOf('\r\n}', i) + 3);
  return new Function(src + '\r\nreturn queLeFaltaAlModelo;')();
}

test('un modelo sin línea de Proveedores no sirve, y lo dice con las palabras del circuito', () => {
  const f = chequeo();
  const completo = [
    { lado: 'debe',  tipo_linea: 'libre',        cuenta_codigo: '5.01.01.0001' },
    { lado: 'haber', tipo_linea: 'proveedores',  cuenta_codigo: '2.01.01.0001' },
  ];
  assert.deepEqual(f(completo, 'lo que se le queda debiendo a la cooperativa'), []);

  const sinProv = [{ lado: 'debe', tipo_linea: 'libre', cuenta_codigo: '5.01.01.0001' },
                   { lado: 'haber', tipo_linea: 'libre', cuenta_codigo: '2.01.01.0001' }];
  assert.deepEqual(f(sinProv, 'lo que se le queda debiendo a la cooperativa'),
    ['no tiene la línea de Proveedores, que es lo que se le queda debiendo a la cooperativa']);
  // La frase la pone el circuito: en una compra el haber es otra cosa.
  assert.match(f(sinProv, 'el haber de la compra')[0], /el haber de la compra$/);
});

test('y avisa de las otras tres formas de estar a medias', () => {
  const f = chequeo();
  assert.deepEqual(f([], 'x'), [
    'no tiene ninguna línea',
    'no tiene la línea de Proveedores, que es x',
    'no tiene ninguna línea en el debe',
    'no tiene ninguna línea en el haber',
  ]);
  // Una cuenta dada de baja: la línea quedó apuntando a la nada.
  const rota = [{ lado: 'debe', tipo_linea: 'libre', cuenta_codigo: null },
                { lado: 'haber', tipo_linea: 'proveedores', cuenta_codigo: '2.01.01.0001' }];
  assert.deepEqual(f(rota, 'x'), ['1 línea(s) apuntan a una cuenta que ya no existe']);
});

// ── EL ENDPOINT QUE ALIMENTA LA PANTALLA ──────────────────────────────────

function armar() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_asientos_modelo (id INTEGER PRIMARY KEY, nombre TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_asientos_modelo_lineas (id INTEGER PRIMARY KEY, modelo_id INTEGER,
      cuenta_id INTEGER, lado TEXT, tipo_linea TEXT, descripcion TEXT, orden INTEGER);
    CREATE TABLE sg_cuentas (id INTEGER PRIMARY KEY, codigo TEXT, nombre TEXT);
    CREATE TABLE sg_config (clave TEXT PRIMARY KEY, valor TEXT);
    CREATE TABLE sg_config_impositiva (clave TEXT PRIMARY KEY, cuenta_id INTEGER);
    INSERT INTO sg_cuentas (id, codigo, nombre) VALUES
      (10,'5.01.03.0001','Servicios de descarga'),
      (20,'2.01.01.0001','Proveedores'),
      (30,'1.01.05.0001','IVA Crédito Fiscal');
    INSERT INTO sg_asientos_modelo (id, nombre, activo) VALUES (7,'Descarga cooperativa',1), (8,'Otro',1);
    INSERT INTO sg_asientos_modelo_lineas (modelo_id, cuenta_id, lado, tipo_linea, orden) VALUES
      (7, 10, 'debe',  'libre',       1),
      (7, 20, 'haber', 'proveedores', 2);
    INSERT INTO sg_config_impositiva (clave, cuenta_id) VALUES ('iva_credito_fiscal', 30);
  `);

  const pedazo = (desde, cierre) => {
    const i = SG.indexOf(desde);
    assert.ok(i > 0, 'no se encontró: ' + desde);
    const f = SG.indexOf(cierre, i);
    return SG.slice(i, f + cierre.length);
  };
  const fuente = [
    "const CLAVE_MODELO_GASTO = 'asiento_modelo_descarga';",
    pedazo('function queLeFaltaAlModelo(', '\r\n}'),
    pedazo('function lineasModeloDe(db, CLAVE) {', '\r\n}'),
    pedazo("router.get('/gastos-factura/modelo'", '\r\n});'),
    pedazo("router.put('/gastos-factura/modelo'", '\r\n});'),
  ].join('\n\n');

  const cap = {};
  const router = {
    get: (p, mw, h) => { cap.get = h; cap.getMw = mw; },
    put: (p, mw, h) => { cap.put = h; cap.putMw = mw; },
  };
  const requireAuth = function requireAuth() {};
  const requireAdmin = function requireAdmin() {};
  new Function('getDb', 'router', 'requireAuth', 'requireAdmin', fuente)(
    () => db, router, requireAuth, requireAdmin);

  const correr = (h, body) => {
    let out = null, code = 200;
    h({ body: body || {} }, {
      status(c) { code = c; return this; },
      json(j) { out = j; return this; },
    });
    return { code, ...out };
  };
  return { db, GET: () => correr(cap.get), PUT: (b) => correr(cap.put, b), cap };
}

test('sin modelo elegido, la pantalla igual puede ofrecer la lista para elegirlo', () => {
  // Devolver sólo `modelo: null` dejaba el selector vacío: no había con qué
  // llenarlo, así que la pantalla que avisa del problema no dejaba resolverlo.
  const a = armar();
  const r = a.GET();
  assert.equal(r.data.modelo, null);
  assert.deepEqual(r.data.modelos.map(m => m.id), [7, 8]);
});

test('con modelo elegido devuelve las CUENTAS, que es lo que se viene a mirar', () => {
  const a = armar();
  a.PUT({ modelo_id: 7 });
  const m = a.GET().data.modelo;
  assert.equal(m.nombre, 'Descarga cooperativa');
  const codigos = m.lineas.map(l => l.cuenta_codigo);
  assert.ok(codigos.includes('5.01.03.0001'), 'falta la cuenta de gasto');
  assert.ok(codigos.includes('2.01.01.0001'), 'falta la cuenta de proveedores');
  // Y la del IVA, que NO está en el modelo: la agrega la configuración
  // impositiva global. Si la pantalla mostrara sólo las del modelo, el asiento
  // que se ve no sería el que se graba.
  assert.ok(codigos.includes('1.01.05.0001'),
    'no muestra el IVA que la configuración global le agrega al asiento');
});

test('un modelo a medias se avisa ANTES, no cuando ya está la factura cargada', () => {
  const a = armar();
  a.db.exec("DELETE FROM sg_asientos_modelo_lineas WHERE tipo_linea='proveedores'");
  a.PUT({ modelo_id: 7 });
  const r = a.GET();
  assert.ok(r.data.faltan.length, 'no avisó que el modelo no sirve');
  assert.match(r.data.faltan.join(' '), /Proveedores/);
});

test('si el modelo elegido se da de baja, lo dice — no vuelve a «sin elegir»', () => {
  const a = armar();
  a.PUT({ modelo_id: 7 });
  a.db.exec('UPDATE sg_asientos_modelo SET activo=0 WHERE id=7');
  const r = a.GET();
  assert.equal(r.data.modelo, null);
  assert.equal(r.data.id_perdido, 7);
  assert.ok(r.data.modelos, 'sin la lista no se puede elegir el reemplazo');
});

test('elegir el modelo desde esta pantalla es de administrador', () => {
  const a = armar();
  assert.equal(a.cap.putMw.name, 'requireAdmin');
  assert.equal(a.cap.getMw.name, 'requireAuth', 'leer contra qué se contabiliza no es de admin');
});

// ── LA PANTALLA ───────────────────────────────────────────────────────────

function panelCoop() {
  const i = PANEL.indexOf('id="sggd-pane-coop"');
  assert.ok(i > 0);
  return PANEL.slice(i, PANEL.indexOf('id="sgcc-desde"', i));
}

test('el bloque está arriba de Control Cooperativa', () => {
  const b = panelCoop();
  assert.match(b, /id="sggd-modelo-box"/);
  assert.match(b, /id="sggd-modelo-cuerpo"/);
  // Arriba de la barra de acciones: es lo primero que se ve al entrar.
  assert.ok(b.indexOf('id="sggd-modelo-box"') < b.indexOf('sgFgAbrir()'),
    'el bloque quedó debajo de los botones');
});

test('y se esconde para el que no es administrador, por la MISMA puerta que los otros tres', () => {
  // Elegir el asiento modelo es parametrizar. Si esta pantalla se escondiera
  // sola, el día que cambie la regla habría que acordarse de las cuatro.
  const i = PANEL.indexOf('function sgAsientoModeloVisible(){');
  const f = PANEL.slice(i, PANEL.indexOf('\r\n}', i));
  assert.match(f, /'sggd-modelo-box'/);
  // Y el selector se dibuja con la MISMA regla que las tres pantallas hermanas.
  const j = PANEL.indexOf('function sgCcoopModeloCargar(){');
  const g = PANEL.slice(j, PANEL.indexOf('\r\n}\r\n', j));
  assert.match(g, /if \(esAdmin\)\{[\s\S]*sggd-modelo-sel/);
});

test('el SELECTOR se le ofrece sólo a quien el servidor va a dejar guardar', () => {
  // sgAsientoEsAdmin() es «tiene alguna pantalla contable de SG», no «es
  // administrador»: un operador con nivel «ver» en Modelos daba true, veía el
  // selector, elegía, y el PUT —que es requireAdmin— le contestaba 403. VER el
  // bloque y CAMBIARLO son dos permisos distintos; así lo resuelven la
  // liquidación, la factura de mercadería y las ventas.
  const j = PANEL.indexOf('function sgCcoopModeloCargar(){');
  const g = PANEL.slice(j, PANEL.indexOf('\r\n}\r\n', j));
  assert.match(g, /var esAdmin = sgFmEsAdmin\(\);/);
  assert.ok(!/var esAdmin = sgAsientoEsAdmin\(\)/.test(g),
    'el selector se decide con «tiene pantalla contable» en vez de «es admin»');
  // Y sgFmEsAdmin sigue siendo estrictamente el rol.
  const k = PANEL.indexOf('function sgFmEsAdmin(){');
  assert.match(PANEL.slice(k, PANEL.indexOf('\r\n}', k)), /LNB_USER\.rol === 'admin'/);
});

test('el bloque nace escondido: no se ve mientras vuelve la primera llamada', () => {
  // sgCcoopInit pide los proveedores y recién dentro del .then llama a la carga.
  // Sin el display:none inicial, el que no puede verlo lo veía ese rato.
  const b = panelCoop();
  const i = b.indexOf('id="sggd-modelo-box"');
  assert.match(b.slice(i, i + 120), /style="display:none;/);
});

test('se carga al ENTRAR a la solapa, y no con cada filtro', () => {
  // Entrar a 🤝 Control Cooperativa corre sgCcoopInit, así que volver desde
  // Contabilidad SG después de cambiar el modelo lo muestra actualizado.
  const i = PANEL.indexOf('function sgCcoopInit(){');
  assert.match(PANEL.slice(i, i + 400), /sgCcoopModeloCargar\(\);/);
  // Y NO adentro de sgCcoopLoad, que se dispara con cada fecha, cada ↻ y cada
  // asignación: rehacer el bloque pedía una llamada de red por cada movimiento
  // del filtro y cerraba el cuadro que estaba abierto.
  const j = PANEL.indexOf('function sgCcoopLoad(){');
  assert.ok(!/sgCcoopModeloCargar\(\)/.test(PANEL.slice(j, PANEL.indexOf('\r\n}\r\n', j))),
    'el bloque se rehace con cada filtro');
});

test('el cuadro debe/haber se abre de UN clic', () => {
  // sgFmAsientoTabla se envuelve sola en sgAsientoPlegado —los tres armadores lo
  // hacen, es la regla del repo—, así que un botón «Ver detalle» propio encima
  // dejaba DOS desplegables: el primero abría un <details> cerrado y hacía falta
  // un segundo clic para ver el cuadro. El desplegable del armador ES el botón.
  const i = PANEL.indexOf('function sgCcoopModeloCargar(){');
  const f = PANEL.slice(i, PANEL.indexOf('\r\n}\r\n', i));
  assert.match(f, /sgFmAsientoTabla\(m\.lineas \|\| \[\]\)/);
  assert.ok(!/Ver detalle/.test(f), 'quedó el botón que sumaba un segundo clic');
  assert.ok(!PANEL.includes('sggd-modelo-det'), 'quedó el div del desplegable de más');
  // Y sgFmAsientoTabla se banca que la llamen con un solo argumento: sin
  // importes muestra la estructura, que es lo que hay hasta que llega la factura.
  const j = PANEL.indexOf('function sgFmAsientoTabla(');
  assert.match(PANEL.slice(j, j + 500), /var monto = importes \? /);
});

test('sin modelo, la pantalla dice qué pasa si se deja así', () => {
  // «Sin elegir» a secas no explica nada. Lo que importa es la consecuencia:
  // la factura se guarda igual y queda sin contabilizar.
  const i = PANEL.indexOf('function sgCcoopModeloCargar(){');
  const f = PANEL.slice(i, PANEL.indexOf('\r\n}\r\n', i));
  assert.match(f, /sin contabilizar/);
});

test('y está en el manual, con su versión', () => {
  const i = PANEL.indexOf("SG_MANUAL.gastos = {");
  const m = PANEL.slice(i, PANEL.indexOf('\r\n};', i));
  assert.match(m, /Contra qué se contabiliza la descarga <span class="ver">V1010<\/span>/);
  assert.match(m, /no asienta/);
  // Y el manual de Asiento Modelo avisa de la segunda puerta: si sólo lo dijera
  // una de las dos pantallas, desde la otra parecen dos configuraciones.
  const j = PANEL.indexOf("SG_MANUAL.modelos = {");
  assert.match(PANEL.slice(j, PANEL.indexOf('\r\n};', j)),
    /La segunda puerta <span class="ver">V1010<\/span>/);
});

// ══════════════════════════════════════════════════════════════════════════
// EL ASIENTO DE LA FACTURA DE DESCARGA — LO QUE SE GRABA Y LO QUE SE VE
// ══════════════════════════════════════════════════════════════════════════
//
// Los dos venían de la versión anterior y no se veían porque el circuito no se
// podía usar: no había dónde elegir el asiento modelo, así que nunca se llegaba
// a armar el asiento. Al abrir el selector, aparecen los dos a la primera
// factura.

function armador() {
  const pedazo = (desde, cierre) => {
    const i = SG.indexOf(desde);
    assert.ok(i > 0, 'no está: ' + desde);
    return SG.slice(i, SG.indexOf(cierre, i) + cierre.length);
  };
  const src = [
    'const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;',
    pedazo('function armarAsientoFactura(', '\r\n}'),
    pedazo('function lineasGestionFactura(', '\r\n}'),
    pedazo('function montosDeFlete(', '\r\n}'),
    pedazo('function montosDeFacturaGasto(', '\r\n}'),
    pedazo('function difDeFacturaGasto(', '\r\n}'),
    pedazo('function asientoDeFacturaGasto(', '\r\n}'),
  ].join('\n');
  // lineasModeloDe se reemplaza por el modelo del test: lo que se prueba acá es
  // el armado, no la lectura de la parametrización.
  const LINEAS = [
    { id: 1, cuenta_id: 10, lado: 'debe',  tipo_linea: 'libre',       cuenta_codigo: '5.01.03.0001', cuenta_nombre: 'Servicios de descarga' },
    { id: 2, cuenta_id: 20, lado: 'haber', tipo_linea: 'proveedores', cuenta_codigo: '2.01.01.0001', cuenta_nombre: 'Proveedores' },
    { id: -1, cuenta_id: 30, lado: 'debe', tipo_linea: 'iva',         cuenta_codigo: '1.01.05.0001', cuenta_nombre: 'IVA Crédito Fiscal' },
  ];
  const f = new Function('lineasModeloDe', 'CLAVE_MODELO_GASTO',
    src + '\nreturn asientoDeFacturaGasto;')(() => LINEAS, 'asiento_modelo_descarga');
  return (total, valorizado, motivo) =>
    f(null, { total, iva_alicuota: 21, dif_motivo: motivo }, valorizado);
}

test('el asiento se arma con IMPORTES, no con ceros', () => {
  // armarAsientoFactura devuelve {lado, monto}; crearAsiento lee {debe, haber}.
  // Este circuito pasaba las líneas crudas: las tres fiscales llegaban con debe
  // y haber en undefined. Y no se notaba, porque `balancea` se calculaba sobre
  // los montos y decía que sí — recién frenaba crearAsiento con «la parte fiscal
  // del asiento está en cero», o sea que la factura no se podía guardar.
  const as = armador()(121000, 100000);
  const fiscales = as.lineas.filter((l) => l.ambito === 'fiscal');
  assert.equal(fiscales.length, 3);
  for (const l of fiscales) {
    assert.ok(typeof l.debe === 'number' && typeof l.haber === 'number',
      'la línea de la cuenta ' + l.cuenta_id + ' no trae debe/haber');
  }
  const gasto = fiscales.find((l) => l.cuenta_id === 10);
  const prov  = fiscales.find((l) => l.cuenta_id === 20);
  const iva   = fiscales.find((l) => l.cuenta_id === 30);
  assert.deepEqual([gasto.debe, gasto.haber], [100000, 0]);
  assert.deepEqual([prov.debe, prov.haber], [0, 121000]);
  assert.deepEqual([iva.debe, iva.haber], [21000, 0]);
});

test('y trae el balance POR ÁMBITO, que es lo que muestra el cuadro', () => {
  // El cuadro de la pantalla lee d.totales[ambito].balancea. Sin eso no había
  // cartel «balancea» en ningún lado, que es la regla del repo.
  const as = armador()(121000, 100000);
  assert.ok(as.totales, 'no devuelve totales');
  assert.deepEqual(as.totales.fiscal, { debe: 121000, haber: 121000, balancea: true });
  assert.ok(!as.totales.gestion, 'sin diferencia no hay líneas de gestión');
});

test('la diferencia contra lo valorizado va a gestión, y gestión balancea sola', () => {
  // Valorizado 150.000, la factura llega por 121.000 (100.000 + IVA): faltan
  // 50.000 de gestión contra el neto. Cada ámbito cierra por su cuenta —que el
  // total cierre no alcanza, es la regla del módulo.
  const as = armador()(121000, 150000, 'ajuste_gestion');
  assert.equal(as.dif_gestion, 50000);
  const ges = as.lineas.filter((l) => l.ambito === 'gestion');
  assert.equal(ges.length, 2);
  for (const l of ges) assert.equal(l.motivo, 'ajuste_gestion');
  assert.equal(as.totales.fiscal.balancea, true);
  assert.equal(as.totales.gestion.balancea, true);
  assert.deepEqual([as.totales.gestion.debe, as.totales.gestion.haber], [50000, 50000]);
  // Y sin IVA del lado de gestión: el crédito fiscal sale del comprobante.
  assert.ok(!ges.some((l) => l.cuenta_id === 30), 'metió IVA en el asiento de gestión');
});

test('las líneas de gestión llegan con su cuenta, para que el cuadro las pueda nombrar', () => {
  const ges = armador()(121000, 150000, 'ajuste_gestion').lineas.filter((l) => l.ambito === 'gestion');
  for (const l of ges) assert.ok(l.cuenta_codigo, 'línea de gestión sin código de cuenta');
});

test('el freno antes de grabar mira cada ámbito, no el balance de arriba', () => {
  // `as.balancea` de armarAsientoFactura no ve las líneas de gestión: si la
  // parte de gestión quedara descuadrada, el freno la dejaba pasar y el error
  // aparecía adentro de crearAsiento, con la factura a medio guardar.
  const i = SG.indexOf("router.post('/gastos-factura'");
  const h = SG.slice(i, SG.indexOf('\r\n});', i));
  assert.match(h, /Object\.entries\(as\.totales/);
  assert.ok(!/if \(!as\.balancea\) throw/.test(h), 'sigue mirando el balance general');
});
