// ══ EL LECTOR CAÍDO SE RECUERDA, Y LA CARGA A MANO NO ESPERA A FALLAR ════════
//
// 29/10/2026. Andy, con el galpón parado y la cuenta de la API sin crédito desde
// el 14/10: «estoy pensando si mejor habilitamos el cargado manual, así los
// chicos pueden seguir trabajando».
//
// La V1092 ya había dejado salida: cuando la foto falla, la app ofrece cargar a
// mano en vez de un callejón sin salida. Lo que faltaba es que la salida no
// cueste una foto inútil y cuarenta segundos de espera CADA VEZ. Con el lector
// caído dos semanas, eso son cientos de fotos que nadie va a mirar.
//
// Dos cosas, y la segunda es la que el operador nota:
//
//   1. El servidor se ACUERDA de la última caída y la cuenta en /ocr/status, y
//      una lectura buena la levanta sola — cuando vuelva el crédito nadie tiene
//      que acordarse de destrabar nada.
//   2. Las dos pantallas de foto ofrecen «Cargarlo a mano» SIEMPRE, sin tener
//      que fallar primero.
//
// ── LO QUE SE PRUEBA ES EL CÓDIGO CORRIENDO ──────────────────────────────────
// El disyuntor no se lee: se recorta del router de verdad y se EJECUTA, con un
// router de mentira que captura el handler de /ocr/status. Un test que verifica
// que el archivo dice `_ocrAnotarCaida` pasa igual con la llamada comentada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');

const ROUTER = leer('src/rutas/ifco.js');
const APP    = leer('src/mifco.html');

// ── EL PEDAZO DE ROUTER, CORRIENDO ───────────────────────────────────────────
// Desde el encabezado del disyuntor hasta donde arranca otra cosa. Se le pasan
// las variables del módulo como parámetros, así cada test arma su escenario
// (prendido, apagado, sin clave) sin tocar el archivo.
const DESDE = '// ── EL SERVIDOR SE ACUERDA DE QUE EL LECTOR ESTÁ CAÍDO';
const HASTA = '// Helper: extraer JSON limpio del texto que devuelve Claude';

function montar({ enabled = true, apiKey = 'sk-test' } = {}) {
  const i = ROUTER.indexOf(DESDE), f = ROUTER.indexOf(HASTA);
  assert.ok(i > 0 && f > i, 'no pude recortar el disyuntor del router');
  const fuente = ROUTER.slice(i, f);
  // El router de mentira sólo guarda el handler que se registra.
  const rutas = {};
  const router = { get: (ruta, fn) => { rutas[ruta] = fn; } };
  const callado = { log() {}, error() {}, warn() {} };
  const fab = new Function('router', 'OCR_ENABLED', 'ANTHROPIC_API_KEY', 'OCR_MODEL', 'console',
    fuente + '\nreturn { _ocrAnotarCaida, _ocrAnotarOk, _motivoOcr, ver: () => _ocrCaido };');
  const api = fab(router, enabled, apiKey, 'modelo-test', callado);
  assert.ok(rutas['/ocr/status'], 'el recorte no registró /ocr/status');
  api.status = () => {
    let salida = null;
    rutas['/ocr/status']({}, { json: (j) => { salida = j; } });
    return salida;
  };
  return api;
}

// ── 1 · EL DISYUNTOR ─────────────────────────────────────────────────────────
test('con el lector andando, /ocr/status no asusta a nadie', () => {
  const o = montar();
  const st = o.status();
  assert.equal(st.enabled, true);
  assert.equal(st.caido, false);
  assert.equal(st.motivo_operador, null);
  assert.equal(st.desde, null);
});

test('UNA CAÍDA QUEDA ANOTADA, y /ocr/status la cuenta', () => {
  const o = montar();
  // El error real del 14/10, tal cual lo devolvió la API.
  o._ocrAnotarCaida(o._motivoOcr(new Error(
    '400 {"type":"error","error":{"type":"invalid_request_error","message":'
    + '"Your credit balance is too low to access the Anthropic API."}}')));
  const st = o.status();
  assert.equal(st.caido, true);
  assert.match(st.motivo_operador, /a mano/i, 'no le dice al operador qué hacer');
  assert.ok(!/credit balance|Anthropic|API/i.test(st.motivo_operador),
    'el error crudo de la API le llegó al operador: ' + st.motivo_operador);
  // Y el motivo técnico sí sale, para el que puede destrabarlo.
  assert.match(st.motivo_admin, /crédito/i);
  assert.match(st.desde, /^\d{4}-\d{2}-\d{2}T/, 'no dice desde cuándo');
});

test('LA PRIMERA CAÍDA MANDA: la fecha no se pisa en cada intento', () => {
  // Si cada llamada fallida reescribiera `desde`, «caído desde hace dos semanas»
  // se leería siempre como «caído desde hace un minuto», que es justo lo que
  // haría pensar que recién empezó y que conviene reintentar.
  const o = montar();
  o._ocrAnotarCaida({ caido: true, operador: 'uno', admin: 'uno' });
  const primera = o.status().desde;
  o._ocrAnotarCaida({ caido: true, operador: 'dos', admin: 'dos' });
  assert.equal(o.status().desde, primera, 'la segunda caída pisó la fecha de la primera');
  assert.equal(o.status().motivo_operador, 'uno');
});

test('Y UNA LECTURA BUENA LO LEVANTA SOLA', () => {
  // Sin esto, el lector queda marcado caído para siempre y alguien tiene que
  // acordarse de reiniciar el servidor el día que se recarga el crédito.
  const o = montar();
  o._ocrAnotarCaida({ caido: true, operador: 'x', admin: 'x' });
  assert.equal(o.status().caido, true);
  o._ocrAnotarOk();
  assert.equal(o.status().caido, false);
  assert.equal(o.status().desde, null);
});

test('lo que NO es una caída no marca nada', () => {
  const o = montar();
  o._ocrAnotarCaida(null);
  o._ocrAnotarCaida({ caido: false, operador: 'x', admin: 'x' });
  assert.equal(o.status().caido, false);
});

test('el lector APAGADO se cuenta igual que el caído: para el operador es lo mismo', () => {
  // Apagado por configuración y sin crédito tienen causas distintas y una sola
  // consecuencia: el lector no está y hay que tipear.
  for (const caso of [{ enabled: false }, { apiKey: '' }]) {
    const st = montar(caso).status();
    assert.equal(st.enabled, false);
    assert.equal(st.caido, true, 'apagado pero no se reporta caído: ' + JSON.stringify(caso));
    assert.match(st.motivo_operador, /a mano/i);
  }
});

test('y `enabled` sigue significando lo mismo que antes, que es lo que lee el panel', () => {
  // panel.html y ifco2.js leen `enabled` desde antes de este cambio. Agregarle
  // sentido nuevo —por ejemplo apagarlo cuando se cae— rompería esas pantallas
  // sin que nadie las haya tocado.
  const o = montar();
  o._ocrAnotarCaida({ caido: true, operador: 'x', admin: 'x' });
  assert.equal(o.status().enabled, true, 'enabled cambió de significado');
  for (const f of ['src/panel.html', 'src/ifco2.js']) {
    assert.match(leer(f), /ocr\/status/, f + ' ya no lee /ocr/status: revisar este test');
  }
});

// ── 2 · LAS DOS CAÍDAS DEL ROUTER QUEDAN ENGANCHADAS ─────────────────────────
// Lo de arriba prueba el disyuntor; esto, que esté conectado. Sin los dos, el
// mecanismo anda perfecto y no lo llama nadie.
test('LOS DOS CAMINOS DE OCR ANOTAN LA CAÍDA, no uno', () => {
  const sinComentarios = ROUTER.replace(/^\s*\/\/.*$/gm, '');
  // Con el punto y coma: la línea que LLAMA. Sin él entra también la que DEFINE la
  // función, y entonces el test contaba tres donde hay dos llamadas — o sea que
  // habría pasado igual con una sola de las dos enganchada.
  const n = (sinComentarios.match(/_ocrAnotarCaida\(m\);/g) || []).length;
  assert.equal(n, 2, 'hay ' + n + ' enganches de caída: son dos (remito-super y match-sellado)');
  // Y cada uno al lado de SU _motivoOcr, no los dos pegados en el mismo bloque.
  //
  // Se ancla en _motivoOcr y no en el texto del log: la primera versión de este test
  // buscaba '[IFCO][OCR]' y daba con un console.warn de otra cosa, doscientas líneas
  // más arriba. El ancla correcta es la que marca el hecho que se quiere clavar —
  // «acá se clasificó una falla»— y no una cadena que alguien puede reusar.
  const clasifica = [...sinComentarios.matchAll(/const m = _motivoOcr\(e\);/g)];
  assert.equal(clasifica.length, 2, 'hay ' + clasifica.length + ' lugares que clasifican la falla');
  for (const c of clasifica) {
    assert.match(sinComentarios.slice(c.index, c.index + 200), /_ocrAnotarCaida\(m\);/,
      'se clasifica la falla pero no se anota: el lector se cae y /ocr/status no se entera');
  }
});

test('y los dos caminos la LEVANTAN cuando leen bien', () => {
  const sinComentarios = ROUTER.replace(/^\s*\/\/.*$/gm, '');
  const n = (sinComentarios.match(/_ocrAnotarOk\(\);/g) || []).length;
  assert.equal(n, 2, 'hay ' + n + ' levantadas: son dos, o el lector queda caído para siempre');
});

// ── 3 · LA APP OFRECE LA SALIDA SIN TENER QUE FALLAR ─────────────────────────
test('LAS DOS PANTALLAS DE FOTO TIENEN «Cargarlo a mano»', () => {
  // Es lo que se pidió: que no haga falta sacar una foto y esperar a que falle
  // para llegar al formulario.
  for (const [vista, fn] of [['view-foto-sellado', 'aManoSellado()'],
                             ['view-foto-despacho', 'aManoDespacho()']]) {
    const i = APP.indexOf('id="' + vista + '"');
    assert.ok(i > 0, 'no está la vista ' + vista);
    const cuerpo = APP.slice(i, APP.indexOf('\n</div>', i));
    assert.match(cuerpo, /Cargarlo a mano/, vista + ' no ofrece la carga a mano');
    assert.ok(cuerpo.includes('onclick="' + fn + '"'), vista + ' no llama a ' + fn);
    // Y el botón NO está escondido: una salida que hay que descubrir no es una salida.
    const btn = cuerpo.slice(cuerpo.indexOf('Cargarlo a mano') - 300, cuerpo.indexOf('Cargarlo a mano'));
    assert.ok(!/display:none/.test(btn), 'el botón de a mano arranca escondido en ' + vista);
  }
});

test('y las dos preguntan si el lector está, al entrar', () => {
  for (const [fn, que] of [['goCargarSellado', 'fs'], ['goCargarDespacho', 'fd']]) {
    const i = APP.indexOf('function ' + fn + '(');
    assert.ok(i > 0, 'no está ' + fn);
    const cuerpo = APP.slice(i, APP.indexOf('\n}', i));
    assert.ok(cuerpo.includes("cargarEstadoOcr('" + que + "')"),
      fn + ' no consulta el estado del lector');
  }
  // Y si la consulta falla, la app sigue andando: un aviso que no se pudo traer
  // no puede ser el motivo de que nadie cargue un remito.
  const ce = APP.slice(APP.indexOf('async function cargarEstadoOcr('),
                       APP.indexOf('function pintarLectorCaido('));
  assert.match(ce, /catch \(e\) \{ S\.ocrEstado = null; \}/,
    'cargarEstadoOcr puede romper la pantalla si no hay red');
});

test('EL AVISO DISTINGUE AL QUE ELIGIÓ CARGAR A MANO DEL QUE SE QUEDÓ SIN LECTOR', () => {
  // Decirle «el lector no está disponible» al que apretó «Cargarlo a mano» es
  // mentirle, y manda a buscar una falla que no pasó.
  assert.match(APP, /function avisoElegido\(id\) \{/);
  const el = APP.slice(APP.indexOf('function avisoElegido(id) {'),
                       APP.indexOf('function avisoNormal(id) {'));
  assert.ok(!/no está disponible/.test(el), 'el aviso del que eligió habla de una falla');
  assert.match(el, /Cargando a mano/);

  // Y el camino elegido sólo lo usa cuando el lector ANDA: si está caído, el
  // cartel correcto es el otro, que explica por qué y que no se arregla con otra foto.
  for (const fn of ['aManoDespacho', 'aManoSellado']) {
    const c = APP.slice(APP.indexOf('function ' + fn + '() {'), APP.indexOf('\n}', APP.indexOf('function ' + fn + '() {')));
    assert.match(c, /if \(!S\.ocrEstado\) avisoElegido\(/, fn + ' usa el aviso equivocado');
  }
});

test('LOS DOS CAMINOS A MANO USAN EL MISMO FORMULARIO', () => {
  // El que eligió y el que falló llenan el mismo. Dos formularios serían dos
  // lugares donde arreglar el mismo campo, y uno de los dos se olvidaría.
  const d = APP.slice(APP.indexOf('function aManoDespacho() {'), APP.indexOf('function aManoSellado() {'));
  assert.match(d, /cargarDespachoAMano\(null, S\.ocrEstado\)/);
  const s = APP.slice(APP.indexOf('function aManoSellado() {'), APP.indexOf('function mostrarCampoFoto('));
  assert.match(s, /crearSelladoAMano\(null, null, S\.ocrEstado\)/);
  // Y son los mismos que usa la salida de emergencia.
  assert.match(APP, /if \(d2 && d2\.ocr_caido\) \{ crearSelladoAMano\(/);
  assert.match(APP, /if \(data && data\.ocr_caido\) \{ cargarDespachoAMano\(/);
});

// ── 4 · LA FOTO NO SE PIERDE POR CARGAR A MANO ───────────────────────────────
test('CARGANDO A MANO SE PUEDE SUMAR LA FOTO IGUAL', () => {
  // La foto del remito firmado es la prueba, y vale aunque ninguna máquina la
  // lea. Antes los formularios tenían la vista previa pero no cómo elegirla: el
  // que entraba a mano desde el principio cargaba el remito sin respaldo.
  for (const [id, prev] of [['d', 'd-foto-prev'], ['ns', 'ns-foto-prev']]) {
    assert.match(APP, new RegExp('id="' + id + '-foto-input"'), 'falta el campo de foto en ' + id);
    assert.ok(APP.includes("adjuntarFoto(event,'" + prev + "')"), id + ' no engancha la foto');
  }
  const a = APP.slice(APP.indexOf('function adjuntarFoto('), APP.indexOf('// El cartel de arriba del formulario'));
  assert.match(a, /S\.fotoFile = f;/, 'la foto elegida no llega a la que se manda');
  assert.match(a, /setFotoPrev\(prevId, f\)/);
  // Y confirmarDespacho la manda: sin esto el campo es decorativo.
  assert.match(APP, /if \(S\.fotoFile\) fd\.append\('escaneo_original', S\.fotoFile\);/);
});

test('el campo de foto aparece sólo cuando NO hay foto todavía', () => {
  // Con una foto ya sacada está la vista previa, y un selector de archivo al
  // lado invita a reemplazarla sin querer.
  for (const fn of ['aManoDespacho', 'aManoSellado']) {
    const i = APP.indexOf('function ' + fn + '() {');
    assert.match(APP.slice(i, APP.indexOf('\n}', i)), /mostrarCampoFoto\('(d|ns)', true\)/,
      fn + ' no muestra el campo de foto');
  }
  for (const [fn, id] of [['cargarDespachoAMano', 'd'], ['crearSelladoAMano', 'ns']]) {
    const i = APP.indexOf('function ' + fn + '(');
    assert.ok(APP.slice(i, APP.indexOf('\n}', i)).includes("mostrarCampoFoto('" + id + "', !file)"),
      fn + ' no decide el campo de foto según si ya hay una');
  }
});

test('Y EL INPUT DE FOTO SE LIMPIA ENTRE CARGAS', () => {
  // Un input de archivo que conserva el de la carga anterior es la misma trampa
  // que el formulario que sólo se esconde: el remito de Coto sale con la foto
  // del de Cencosud.
  const r = APP.slice(APP.indexOf('function resetState() {'), APP.indexOf('function logout()'));
  for (const id of ['d-foto-input', 'ns-foto-input', 'd-foto-prev', 'ns-foto-prev']) {
    assert.ok(r.includes("$('" + id + "')"), 'resetState no limpia ' + id);
  }
});

// ── 5 · Y EL ERROR CRUDO SIGUE SIN LLEGAR AL TELÉFONO ────────────────────────
test('el router NO devuelve el error de la API tal cual', () => {
  // Es lo que arregló la V1092 y lo que este PR no puede desarmar sin querer.
  const sinComentarios = ROUTER.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/Error en OCR: /.test(sinComentarios),
    'volvió el error crudo de la API al teléfono');
  assert.ok(!/m\.crudo/.test(sinComentarios.replace(/console\.error\([^\n]*\)/g, '')),
    'el motivo crudo se escapa fuera del log');
});
