// ══ CUANDO EL LECTOR DE REMITOS SE CAE, EL GALPÓN SIGUE ═══════════════════════
//
// 14/10/2026. Santiago, cargando despachos desde el teléfono, vio esto:
//
//   Error en OCR: 400 {"type":"error","error":{"type":"invalid_request_error",
//   "message":"Your credit balance is too low to access the Anthropic API.
//   Please go to Plans & Billing to upgrade or purchase credits."}}
//
// Dos cosas mal, y la segunda es la grave:
//
//   1. El error de la API viajaba CRUDO hasta el teléfono. En inglés, hablando de
//      facturación, y con cara de que la culpa es del que sacó la foto.
//   2. La pantalla de error tenía UN SOLO BOTÓN: «Volver al inicio». Santiago
//      parado en el galpón con el remito en la mano y nada que hacer.
//
// Lo segundo dolía de más porque el formulario YA ESTABA: el OCR sólo lo
// prellena. confirmarDespacho() lee de los inputs y de S.fotoFile, no de
// S.ocrData. Cargar a mano siempre fue posible; faltaba que la app lo ofreciera.
//
// Este test clava las dos cosas, y lo hace donde se rompen: el mensaje contra el
// ROUTER —con la API fallando de verdad— y la salida contra el JS DE LA APP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = fs.readFileSync(path.join(RAIZ, 'src/rutas/ifco.js'), 'utf8');
// Sin los comentarios: contar apariciones de algo que el propio comentario nombra da un
// número que no es el que se quiere medir. Ya pasó antes en este repo.
const ROUTER_COD = ROUTER.replace(/^\s*\/\/.*$/gm, '');
const APP    = fs.readFileSync(path.join(RAIZ, 'src/mifco.html'), 'utf8');

// El JS de la app, con los strings concatenados juntos: dónde cae cada corte de línea es
// incidental y un test atado a eso se rompe la primera vez que alguien reacomoda un renglón.
const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};
const fn = (nombre) => trozo(APP, 'function ' + nombre + '(', '\r\n}')
  .replace(/'\s*\r?\n\s*\+ '/g, '');

// ── _motivoOcr, EJECUTÁNDOSE DE VERDAD ────────────────────────────────────────
// Se extrae del router y se corre. Mirar el texto del archivo no alcanza: lo que
// importa es qué devuelve con el error que la API manda de verdad.
const _motivoOcr = new Function(
  trozo(ROUTER, 'function _motivoOcr(', '\r\n}') + ';return _motivoOcr;')();

// El cuerpo exacto que contestó la API el 14/10, tal como lo envuelve el SDK.
const ERROR_SIN_CREDITO = Object.assign(
  new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":'
    + '"Your credit balance is too low to access the Anthropic API. Please go to Plans & '
    + 'Billing to upgrade or purchase credits."},"request_id":"req_011CfbRuBWGTpnDVUAhaTiM"}'),
  { status: 400 });

test('EL OPERADOR NO VE EL ERROR DE LA API', () => {
  const m = _motivoOcr(ERROR_SIN_CREDITO);
  // Nada de lo que vio Santiago puede volver a salir por ahí.
  for (const fuga of ['credit balance', 'Anthropic', 'Plans & Billing', 'invalid_request_error',
                      'request_id', '400']) {
    assert.ok(!m.operador.includes(fuga),
      'al operador le llega «' + fuga + '»: ' + m.operador);
  }
  // Y lo que sí ve está en castellano y dice qué hacer.
  assert.match(m.operador, /sin servicio/);
  assert.match(m.operador, /a mano/, 'no le dice qué puede hacer');
});

test('pero el motivo de verdad NO se pierde: va al log y al panel', () => {
  // Si se tragara el error, el que tiene que destrabarlo no se enteraría nunca.
  const m = _motivoOcr(ERROR_SIN_CREDITO);
  assert.match(m.admin, /sin crédito/i);
  assert.match(m.crudo, /credit balance/, 'se perdió el texto original');
  assert.match(ROUTER, /console\.error\('\[IFCO\]\[OCR\] ' \+ m\.admin \+ ' — ' \+ m\.crudo\)/);
});

test('el saldo se distingue de todo lo demás', () => {
  // Es el único que no se arregla reintentando ni sacando otra foto: lo tiene que
  // destrabar una persona. Por eso el mensaje manda a avisar a la oficina.
  assert.match(_motivoOcr(ERROR_SIN_CREDITO).operador, /avisá a la oficina/);
  const saturado = Object.assign(new Error('429 rate_limit_error'), { status: 429 });
  assert.match(_motivoOcr(saturado).operador, /probá de nuevo/);
  assert.ok(!/avisá a la oficina/.test(_motivoOcr(saturado).operador),
    'una saturación no necesita que nadie destrabe nada');
});

test('la credencial vencida manda a revisar la clave, no a sacar otra foto', () => {
  const m = _motivoOcr(Object.assign(new Error('401 authentication_error'), { status: 401 }));
  assert.match(m.admin, /ANTHROPIC_API_KEY/);
  assert.match(m.operador, /a mano/);
});

test('y una caída de red también deja seguir', () => {
  const m = _motivoOcr(new Error('fetch failed'));
  assert.match(m.operador, /a mano/);
  assert.equal(m.caido, true);
});

test('CUALQUIER falla del lector marca ocr_caido', () => {
  // La distinción que le importa al que carga no es por qué se cayó: es si puede seguir
  // trabajando. Un caso sin clasificar que devolviera caido:false lo dejaría sin salida.
  for (const e of [ERROR_SIN_CREDITO, new Error('cualquier cosa rara'), new Error(''), {}]) {
    assert.equal(_motivoOcr(e).caido, true, 'quedó sin salida con: ' + JSON.stringify(String(e)));
  }
});

test('los dos catch del router usan el traductor, y no el error pelado', () => {
  // Eran dos lugares distintos escribiendo el mismo error crudo.
  assert.ok(!/Error en OCR: ' \+ \(e\.message/.test(ROUTER),
    'quedó un catch devolviendo e.message al operador');
  // Se cuentan los LLAMADOS, no la firma: `function _motivoOcr(e)` matchea igual y daría 3.
  assert.equal((ROUTER_COD.match(/const m = _motivoOcr\(e\);/g) || []).length, 2);
  assert.equal((ROUTER_COD.match(/ocr_caido/g) || []).length, 4,
    'alguna respuesta de "lector no disponible" se quedó sin la marca');
});

test('el OCR apagado y el SDK sin cargar contestan lo MISMO que una caída', () => {
  // Para el que carga son el mismo problema: no hay lector. Si contestaran distinto, la
  // app tendría que tratarlos distinto sin ninguna razón.
  const apagado = trozo(ROUTER, "if (!OCR_ENABLED || !ANTHROPIC_API_KEY) {", '});');
  assert.match(apagado, /ocr_caido: true/);
  assert.match(apagado, /Cargalo a mano/);
  assert.match(ROUTER, /if \(!client\) return res\.status\(503\)[\s\S]{0,220}ocr_caido: true/);
});

// ── LA APP: QUE HAYA SALIDA ───────────────────────────────────────────────────
test('UN LECTOR CAÍDO CAE AL FORMULARIO, no a un cartel sin salida', () => {
  // Es el cambio que importa. Antes era showError() y return.
  const despacho = fn('onFotoDespacho');
  assert.match(despacho, /if \(data && data\.ocr_caido\) \{ cargarDespachoAMano\(file, data\); return; \}/);
  const sellado = fn('crearNuevoDesdeFoto');
  assert.match(sellado, /if \(d2 && d2\.ocr_caido\) \{ crearSelladoAMano\(data, file, d2\); return; \}/);
});

test('y una foto mala TAMBIÉN ofrece seguir a mano, sin obligar', () => {
  // Ahí sí tiene sentido probar otra foto primero, así que el cartel queda — pero con el
  // botón al lado. Antes el único botón era «Volver al inicio».
  for (const f of ['onFotoDespacho', 'crearNuevoDesdeFoto']) {
    const js = fn(f);
    assert.match(js, /texto: 'Cargarlo a mano'/, f + ' no ofrece la salida');
  }
});

test('LA FOTO SE GUARDA IGUAL, aunque los datos los tipee una persona', () => {
  // Si se perdiera, el despacho cargado a mano quedaría sin su respaldo escaneado — y eso
  // es lo que se mira cuando el súper discute una cantidad seis meses después.
  const js = fn('cargarDespachoAMano');
  assert.match(js, /S\.fotoFile = file \|\| S\.fotoFile/);
  assert.match(js, /setFotoPrev\('d-foto-prev', file\)/);
  // Y confirmarDespacho la manda: es lo que hace que esto funcione de punta a punta.
  assert.match(fn('confirmarDespacho'), /if \(S\.fotoFile\) fd\.append\('escaneo_original', S\.fotoFile\)/);
});

test('el formulario a mano arranca EN BLANCO', () => {
  // Un formulario que conserva lo del remito anterior es la trampa de Scout otra vez:
  // se guarda el despacho de antes con sólo apretar Crear.
  const js = fn('cargarDespachoAMano');
  for (const campo of ['d-numero', 'd-cadena', 'd-cant']) {
    assert.match(js, new RegExp("\\$\\('" + campo + "'\\)\\.value\\s*=\\s*''"),
      campo + ' no se limpia');
  }
  assert.match(js, /S\.ocrData = null/, 'quedan los datos leídos del remito anterior');
});

test('el N° que el operador YA corrigió a mano no se le pide dos veces', () => {
  // En el sellado es lo único que puede venir bueno de la pasada anterior.
  assert.match(fn('crearSelladoAMano'),
    /\$\('ns-numero'\)\.value = \(data && data\.n_remito_ifco\) \|\| ''/);
});

test('confirmarDespacho NO necesita el OCR — por eso todo esto es posible', () => {
  // Es el hecho sobre el que se apoya el arreglo. Si mañana alguien hace que el guardado
  // dependa de S.ocrData, la carga a mano se rompe en silencio.
  const js = fn('confirmarDespacho');
  assert.ok(!/S\.ocrData/.test(js), 'el guardado pasó a depender del OCR');
});

// ── EL CARTEL DE ARRIBA DEL FORMULARIO ────────────────────────────────────────
test('el cartel NO sigue diciendo "prellenado por la IA" con el formulario en blanco', () => {
  // Un cartel que miente es peor que ninguno.
  const js = fn('avisoAMano');
  assert.match(js, /El lector de remitos no está disponible/);
  assert.match(js, /La foto se guarda igual/);
  assert.match(APP, /<div class="alert ok" id="d-aviso">/);
  assert.match(APP, /<div class="alert warn" id="ns-aviso">/);
});

test('Y VUELVE A SU LUGAR en el remito siguiente', () => {
  // Sin esto, el primer remito cargado a mano deja «el lector no está disponible» puesto
  // para siempre: el siguiente, leído bien, lo muestra igual.
  assert.match(fn('onFotoDespacho'), /avisoNormal\('d-aviso'\)/);
  assert.equal((APP.match(/avisoNormal\('ns-aviso'\)/g) || []).length, 2,
    'falta restaurarlo en alguno de los dos caminos que llegan a crear+sellar');
  const js = fn('avisoNormal');
  assert.match(js, /AVISO_NORMAL\[id\]/);
  // Los dos textos viven juntos: separados, el día que se toque uno el otro queda
  // contando otra historia.
  assert.match(APP, /const AVISO_NORMAL = \{/);
  assert.match(APP, /'d-aviso':\s*\['alert ok'/);
  assert.match(APP, /'ns-aviso':\s*\['alert warn'/);
});

test('la pantalla de error dejó de tener un solo botón', () => {
  const js = fn('showError');
  assert.match(js, /salida\) \{/, 'showError no acepta una salida');
  assert.match(js, /btn\.style\.display = 'none'/, 'el botón no se esconde cuando no hay salida');
  assert.match(APP, /id="err-salida"/);
  // Y «Volver al inicio» deja de ser el botón principal cuando hay algo mejor que hacer.
  assert.match(APP, /<button class="btn bo full" onclick="goHome\(\)">Volver al inicio<\/button>/);
});

test('un showError sin salida no se queda con el botón del error anterior', () => {
  // Es el bug que tendría este arreglo si no se limpiara: el cartel de «sin conexión»
  // ofreciendo «Cargarlo a mano» de un remito que ya no está en pantalla.
  const js = fn('showError');
  assert.match(js, /if \(salida && salida\.fn\)/);
  assert.match(js, /btn\.onclick = null/);
});

// ══ Y EL PANEL, QUE ME COMÍ LA PRIMERA VEZ ════════════════════════════════════
//
// 16/10/2026. Arreglé la app del teléfono y no miré el panel. El mensaje nuevo
// del servidor llegó igual —eso estuvo bien— pero la pantalla de escritorio tenía
// el MISMO callejón: «⚠️ La IA no pudo leer el N° de remito», el texto diciendo
// «cargalo a mano», y abajo sólo «Probar otra foto» y «Cancelar».
//
// O sea que lo dejé peor que antes: el mensaje prometía algo que la pantalla no
// daba. Sacar otra foto no arregla una cuenta sin crédito.
//
// Y había un tercero escondido: el N° del sellado directo era `readonly` y el
// guardado lo leía de IFCO._sdData, no del campo. Sin un campo escribible no hay
// carga a mano posible — y Pablo ya había pedido poder corregir ese número
// («no siempre lo lee bien»), que estaba hecho en el teléfono y no acá.
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const fnPanel = (nombre) => trozo(PANEL, 'function ' + nombre + '(', '\r\n}')
  .replace(/'\s*\r?\n\s*\+ '/g, '');

test('EL PANEL YA NO DEJA AL OPERADOR SIN SALIDA', () => {
  // Es el caso de la captura: antes caía en _ifcoCargarSelladoMostrarError y ahí
  // terminaba el camino.
  const js = fnPanel('ifcoCargarSelladoFoto');
  assert.match(js, /if \(data\.ocr_caido\) \{\s*\r?\n\s*_ifcoSelladoDirectoAMano\(file, data\);/,
    'el lector caído no va derecho a la carga a mano');
  // Y el orden importa: tiene que mirarse ANTES del caso "no leyó el número", que
  // es el que mostraba el cartel.
  assert.ok(js.indexOf('data.ocr_caido') < js.indexOf("accion === 'sin_numero'"),
    'el caído se evalúa después del sin_numero: vuelve a caer en el cartel');
});

test('el formulario del panel es el que YA EXISTÍA, no uno nuevo', () => {
  // Es el mismo mini-modal al que se llega cuando el remito no está en la base.
  // Inventar otro habría sido una segunda pantalla que mantener.
  const js = fnPanel('_ifcoSelladoDirectoAMano');
  assert.match(js, /ifco-mb-sellado-directo'\)\.classList\.add\('on'\)/);
  assert.match(js, /ifco-mb-cargar-sellado'\)\.classList\.remove\('on'\)/);
});

test('LA FOTO SE SUBE IGUAL desde el panel', () => {
  // Sin esto el remito queda sin su respaldo escaneado, que es lo que se mira
  // cuando el súper discute una cantidad seis meses después.
  assert.match(fnPanel('_ifcoSelladoDirectoAMano'), /file: file/);
  assert.match(fnPanel('_ifcoSelladoDirectoAMano'), /escaneo_path:/);
});

test('EL N° DEL SELLADO DIRECTO SE PUEDE TIPEAR', () => {
  // Era readonly y gris. Sin esto, «cargalo a mano» es una frase vacía.
  const input = (PANEL.match(/<input id="ifco-sd-nremito"[^>]*>/) || [''])[0];
  assert.ok(input, 'no está el input del N°');
  assert.ok(!/readonly/.test(input), 'el N° volvió a ser de sólo lectura: ' + input);
  assert.match(input, /placeholder="00015-/, 'no dice qué formato va');
});

test('y el guardado LEE ESE CAMPO, no lo que leyó el OCR', () => {
  // Es la mitad que faltaba: con el input editable pero el guardado mirando
  // IFCO._sdData, tipear el número no servía de nada y la pantalla no lo decía.
  const js = fnPanel('ifcoSelladoDirectoGuardar');
  assert.match(js, /const nRemito = \(document\.getElementById\('ifco-sd-nremito'\)\.value \|\| ''\)\.trim\(\)/);
  assert.match(js, /if \(!nRemito\) \{ alert\('Escribí el N° de remito'\); return; \}/,
    'deja guardar sin número');
});

test('el cartel del panel no sigue diciendo "lo detectamos del OCR"', () => {
  // Arriba de un formulario en blanco sería mentira.
  const js = fnPanel('_ifcoSdAviso');
  assert.match(js, /El lector de remitos no está disponible/);
  assert.match(js, /la foto queda guardada/);
  assert.match(PANEL, /<div id="ifco-sd-aviso"/, 'el cartel no tiene id: no se puede cambiar');
  // Los dos textos viven juntos, como en la app del teléfono.
  assert.match(PANEL, /const IFCO_SD_AVISO_OK =/);
});

test('Y VUELVE A SU LUGAR en el remito siguiente', () => {
  // El camino normal (crear_nuevo) lo restaura: si no, el primero cargado a mano
  // deja el cartel amarillo puesto para siempre.
  assert.match(fnPanel('ifcoCargarSelladoFoto'), /_ifcoSdAviso\(null\)/);
});

test('una foto mala en el panel ofrece las DOS cosas', () => {
  // Ahí sí tiene sentido probar otra foto — pero no como único camino.
  const js = fnPanel('_ifcoCargarSelladoMostrarError');
  assert.match(js, /Probar otra foto/);
  assert.match(js, /Cargarlo a mano/);
  // El File no entra en un onclick, así que viaja por IFCO._csFile.
  assert.match(js, /IFCO\._csFile = file \|\| null/);
});

test('los otros dos caminos del panel dejan de culpar a la IA', () => {
  // Cuando el lector está caído la IA no «no pudo leer»: nunca llegó a mirar la
  // foto. Esos dos ya caían al formulario solos —eso estaba bien— pero el texto
  // le echaba la culpa al que sacó la foto.
  for (const campo of ['r', 's']) {
    const i = PANEL.indexOf("document.getElementById('ifco-" + campo + "-ocr-error').textContent = data && data.ocr_caido");
    assert.ok(i > 0, 'ifco-' + campo + '-ocr-error sigue culpando a la IA siempre');
  }
});
