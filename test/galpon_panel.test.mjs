// ══ 🏭 GALPÓN — el módulo enchufado, y su manual ══════════════════════════
//
// Dos cosas distintas que fallan calladas:
//
// 1. UN MÓDULO A MEDIO REGISTRAR. Son cinco piezas en cinco archivos, y si
//    falta una no hay error: el menú no aparece, o aparece y no abre nada, o
//    —la peor— abre y la API deja pasar a cualquiera con sesión porque nadie
//    declaró su prefijo.
//
// 2. UN MANUAL QUE AFIRMA ALGO QUE YA NO ES CIERTO. CLAUDE.md: «el manual se
//    prueba contra el código, no contra sí mismo». Un test que verifica que el
//    texto existe no sirve para nada; lo que se clava acá es que cada cosa que
//    el manual AFIRMA sigue pasando, con su assert al lado contra el router o
//    el servicio. El molde es test/manual_remitos.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');

const PANEL   = leer('src/panel.html');
const RUTA    = leer('src/rutas/galpon.js');
const SERV    = leer('src/servicios/galpon.js');
const DDL     = leer('src/servicios/db_galpon.js');
const PDF     = leer('src/servicios/galponTarjetasPDF.js');
const ENSURE  = leer('src/servicios/ensure_modulo_galpon.js');
const ORG     = leer('src/servicios/db_org.js');
const PREFIJOS= leer('src/servicios/ensure_api_prefijos.js');
const INDEX   = leer('src/index.js');

// El manual, recortado del panel y PEGADO: en el archivo es una cadena de JS cortada
// cada 95 columnas con `' + '`, así que casi cualquier frase que uno quiera buscar cae
// justo arriba de un corte. Se saca la concatenación y queda la prosa corrida, que es lo
// que el operador lee.
function manualDe(modulo) {
  const i = PANEL.indexOf("SG_MANUAL['" + modulo + "']");
  assert.ok(i > 0, modulo + ' no tiene «¿Cómo se usa?» — escribirlo ES actualizarlo');
  return PANEL.slice(i, PANEL.indexOf('\n};', i))
    .replace(/'\s*\r?\n\s*\+\s*'/g, '');
}
const MANUAL    = manualDe('galpon-config');
const MANUAL_LD = manualDe('galpon-lote-dia');

// `assert.match` contra el manual escupe las 90 líneas enteras en cada fallo, y entre
// tanto texto no se ve cuál era la frase. Esto dice sólo la que falta.
function lector(texto) {
  return function (frase, nota) {
    const re = frase instanceof RegExp ? frase : new RegExp(frase);
    assert.ok(re.test(texto),
      'EL MANUAL NO DICE: ' + (frase.source || frase) + (nota ? '\n  (' + nota + ')' : ''));
  };
}
const dice   = lector(MANUAL);
const diceLd = lector(MANUAL_LD);

// ── 1 · LAS CINCO PIEZAS DEL REGISTRO, PARA TODOS LOS MÓDULOS ─────────────
// Antes esto auditaba 'galpon-config' escrito a mano cinco veces. Con el módulo
// número dos esa lista se vuelve lo mismo que la de modales_fuera_de_pantalla:
// protege lo que alguien se acordó de anotar, y el tercero que alguien escriba
// mañana queda afuera.
//
// Así que la lista sale del PROPIO ensure: cada módulo que se registre entra al
// audit solo.
const MODULOS = [...ENSURE.matchAll(/\['(galpon-[\w-]+)',\s*'([^']+)',\s*(\d+)\]/g)]
  .map((m) => ({ modulo: m[1], label: m[2] }));

test('hay módulos que auditar, y salen del ensure, no de una lista a mano', () => {
  assert.ok(MODULOS.length >= 2, 'sólo encontré ' + MODULOS.length + ': el regex se rompió');
  assert.ok(MODULOS.some((m) => m.modulo === 'galpon-config'));
  assert.ok(MODULOS.some((m) => m.modulo === 'galpon-lote-dia'));
});

test('cada módulo se registra SIEMPRE, no sólo con la tabla vacía', () => {
  // El seed de db_org.js hace `if (n > 0) return`: agregar una fila a ese array
  // no hace nada en producción, donde la tabla ya tiene filas.
  assert.match(ENSURE, /INSERT OR IGNORE INTO modulos_config/);
  assert.match(ORG, /^import "\.\/ensure_modulo_galpon\.js";$/m,
    'el ensure existe pero nadie lo importa: no corre nunca');
  for (const { label } of MODULOS) {
    // El emoji va en el LABEL: el sidebar no tiene mapa de íconos para galpon-* y
    // usa el primero del texto. Sin emoji el ítem sale pelado.
    assert.ok(/^[^\w\s]/.test(label), 'el label no arranca con emoji: ' + label);
  }
});

test('LOS PREFIJOS DE LA API ESTÁN DECLARADOS, o exigirNivel deja pasar a cualquiera', () => {
  // Sin la línea, moduloDeRuta devuelve null, el guardián no resuelve el módulo y
  // el nivel que el admin marcó en Usuarios no se aplica a nadie.
  const declaradas = [];
  for (const { modulo } of MODULOS) {
    const m = new RegExp("\\['" + modulo + "',\\s*'([^']+)'\\]").exec(PREFIJOS);
    assert.ok(m, modulo + ' no está en ensure_api_prefijos.js');
    for (const d of m[1].split(',')) declaradas.push(d.trim().replace(/^galpon\//, ''));
  }
  // Y están TODAS las direcciones que el router monta, no las que alguien recordó.
  // Cada una tiene que caer bajo ALGÚN módulo del galpón: a qué menú pertenece lo
  // decide el que la escribió, pero quedar afuera de todos no es una opción.
  for (const r of RUTA.matchAll(/router\.(get|post|put|patch|delete)\('\/([^'/?]+)/g)) {
    assert.ok(declaradas.some((d) => r[2].startsWith(d.split('.')[0])),
      'la ruta /' + r[2] + ' no está cubierta por ningún prefijo declarado');
  }
  // Y NO se declara el prefijo pelado: le daría las rutas de los siete módulos del
  // galpón a un solo menú. Es la trampa que el propio archivo advierte.
  assert.ok(!/\[\s*'galpon[^']*',\s*'galpon'\s*\]/.test(PREFIJOS), 'se declaró el prefijo pelado');
});

test('el router está montado', () => {
  assert.match(INDEX, /import galponRouter\s+from "\.\/rutas\/galpon\.js";/);
  assert.match(INDEX, /app\.use\("\/api\/galpon",\s*galponRouter\);/);
});

test('LAS DOS PIEZAS DEL SIDEBAR, que hacen falta juntas, y el dispatcher', () => {
  // El sidebar de verdad lo arma /api/org/sidebar filtrado por permisos, y lo que
  // hace es CLICKEAR el div escondido. Con una sola de las dos no pasa nada, y sin
  // la del dispatcher la pantalla abre vacía: el HTML está, pero nadie la carga.
  for (const { modulo } of MODULOS) {
    assert.match(PANEL, new RegExp('<div class="ni" data-sec="' + modulo + '">'),
      'falta el puente del nav de ' + modulo);
    assert.match(PANEL, new RegExp('<div class="sec sg-mod" id="sec-' + modulo + '">'),
      'falta la pantalla de ' + modulo);
    const d = new RegExp("'" + modulo + "': function\\(\\)\\{ (\\w+)\\(\\); \\}").exec(PANEL);
    assert.ok(d, 'falta la línea del dispatcher de ' + modulo);
    assert.ok(PANEL.includes('function ' + d[1] + '('),
      'el dispatcher de ' + modulo + ' llama a ' + d[1] + '(), que no está definida');
  }
});

// ── 2 · EL MANUAL, CONTRA EL CÓDIGO ───────────────────────────────────────
// Cada afirmación del manual con su assert al lado. Se verificó mutando el
// CÓDIGO: romper lo que el manual promete pone en rojo la línea de acá.

test('MANUAL: «el color se lo da el sistema si no elegís uno»', () => {
  dice(/el primero de la paleta que no esté usando otra/);
  assert.match(SERV, /export function colorSugerido\(/);
  assert.match(SERV, /const libre = COLORES\.find\(\(c\) => !usados\.has/);
  // Y el router lo usa cuando no vino color.
  assert.match(RUTA, /: colorSugerido\(db, cuadrilla_id\)/);
});

test('MANUAL: «el color se hereda al ampliar la tanda»', () => {
  dice(/el color se hereda solo/);
  // colorSugerido devuelve PRIMERO el de la cuadrilla, antes de buscar uno libre.
  const i = SERV.indexOf('export function colorSugerido(');
  const cuerpo = SERV.slice(i, SERV.indexOf('\n}', i));
  const iMio = cuerpo.indexOf('if (mio && mio.color) return mio.color;');
  const iLibre = cuerpo.indexOf('const libre');
  // Las dos presencias se exigen ANTES de comparar el orden: sin esto, borrar la
  // primera línea da -1, y -1 < iLibre es cierto, así que el test pasaba con la
  // herencia rota. Lo encontró la mutación, no la lectura.
  assert.ok(iMio > 0, 'colorSugerido ya no devuelve el color que la cuadrilla ya tiene');
  assert.ok(iLibre > 0, 'colorSugerido ya no busca un color libre');
  assert.ok(iMio < iLibre, 'busca uno libre antes de repetir el suyo');
});

test('MANUAL: «dos cuadrillas no pueden compartir un número» — y se rechaza AL GUARDAR', () => {
  dice(/Dos cuadrillas no pueden compartir un número/);
  dice(/dice con quién se pisa/);
  assert.match(SERV, /export function rangoSuperpuesto\(/);
  assert.match(RUTA, /const choca = rangoSuperpuesto\(db, desde, hasta\);/);
  assert.match(RUTA, /res\.status\(409\)/);
  // Y el mensaje nombra a la otra cuadrilla.
  assert.match(RUTA, /choca\.cuadrilla_nombre/);
});

test('MANUAL: «dar de baja no borra nada»', () => {
  dice(/No borra nada/);
  dice(/queda apagado/);
  // El DELETE apaga, no borra.
  assert.match(RUTA, /UPDATE gal_cuadrilla_tarjetas SET activo = 0 WHERE id = \?/);
  assert.ok(!/DELETE FROM gal_cuadrilla_tarjetas/.test(RUTA), 'hay un DELETE de verdad');
});

test('MANUAL: «la tara se le resta al bruto en cada volcado»', () => {
  dice(/Se le resta al bruto de la balanza/);
  assert.match(SERV, /export function neto\(bruto, tara\)/);
  assert.match(SERV, /Math\.round\(\(b - t\) \* 100\) \/ 100/);
  assert.match(DDL, /\['tara_ifco', '2\.0'\]/);
});

test('MANUAL: «salen 8 por hoja A4»', () => {
  dice(/8 por hoja A4/);
  assert.match(PDF, /const COLS = 2;/);
  assert.match(PDF, /const FILAS = 4;/);
  assert.match(PDF, /const POR_HOJA = COLS \* FILAS;/);
});

test('MANUAL: «el QR lleva el número pelado, sin dirección»', () => {
  dice(/el número pelado/);
  assert.match(MANUAL, /la lectora USB se comporta como un teclado/i);
  assert.match(PDF, /export const contenidoQR = \(id\) => String\(id\);/);
  assert.match(PDF, /QRCode\.toDataURL\(contenidoQR\(id\)/);
});

test('MANUAL: «si el rango cruza dos cuadrillas, cada tarjeta sale con la suya»', () => {
  dice(/cada tarjeta sale con la suya/);
  assert.match(RUTA, /datos\.porId\[id\] = r\.cuadrilla_nombre \|\| null;/);
});

test('MANUAL: «imprimir lo puede cualquiera; configurar, sólo el administrador»', () => {
  dice(/Cualquiera con el módulo.*<\/b> puede mirar la configuración e <b>imprimir/s);
  dice(/Sólo el administrador<\/b> cambia colores, asigna rangos y toca la tara/);
  // El PDF y las lecturas NO llevan requireAdmin; las escrituras SÍ.
  const linea = (re) => (RUTA.match(re) || [''])[0];
  assert.ok(!/requireAdmin/.test(linea(/router\.get\('\/tarjetas\.pdf'[^\n]*/)),
    'imprimir quedó pedido a admin');
  assert.ok(!/requireAdmin/.test(linea(/router\.get\('\/cuadrillas'[^\n]*/)));
  for (const re of [/router\.put\('\/config'[^\n]*/, /router\.post\('\/cuadrillas\/:id\/tarjetas'[^\n]*/,
                    /router\.patch\('\/cuadrillas\/:id\/color'[^\n]*/, /router\.delete\('\/tarjetas\/:id'[^\n]*/]) {
    assert.match(linea(re), /requireAdmin/, 'escritura sin admin: ' + re);
  }
});

test('MANUAL: «las cuadrillas salen de Personal, acá no se dan de alta»', () => {
  dice(/Personal → Cuadrillas/);
  dice(/no se dan de alta/);
  assert.match(SERV, /FROM pa_cuadrillas c/);
  // Y no hay ningún INSERT ni ALTER sobre la tabla de Personal: es de otro módulo.
  assert.ok(!/INSERT INTO pa_cuadrillas/.test(RUTA + SERV + DDL));
  assert.ok(!/ALTER TABLE pa_cuadrillas/.test(DDL), 'le agregó una columna a la tabla de Personal');
});

test('MANUAL: «esta pantalla es de Puente Cordón»', () => {
  dice(/Puente Cordón/);
  assert.match(RUTA, /exigirEmpresa\(req, res, PUENTE_CORDON\)/);
});

test('y cada manual lleva el V### al lado de cada cosa, como pide CLAUDE.md', () => {
  for (const [nombre, texto] of [['config', MANUAL], ['lote del día', MANUAL_LD]]) {
    const v = [...texto.matchAll(/<span class="ver">(V\d+)<\/span>/g)].map((m) => m[1]);
    assert.ok(v.length >= 5, nombre + ': sólo ' + v.length + ' entradas numeradas');
  }
  const vers = [...MANUAL.matchAll(/<span class="ver">(V\d+)<\/span>/g)].map((m) => m[1]);
  assert.equal(new Set(vers).size, 1, 'hay versiones mezcladas: ' + [...new Set(vers)].join(', '));
  // Y no puede ser del futuro. Antes esto exigía que fuera IGUAL al VERSION del panel,
  // y estaba mal: una entrada del manual lleva la versión en la que salió y se queda con
  // ella. Al PR siguiente —que no tocó Galpón— el test se ponía rojo solo.
  const actual = parseInt((/const VERSION = 'V(\d+)';/.exec(leer('src/sidebar-v2.js')) || [, 0])[1], 10);
  const dice = parseInt(vers[0].slice(1), 10);
  assert.ok(dice <= actual, 'el manual dice ' + vers[0] + ' y el panel va en V' + actual);
});

// ── 3 · SIN BARRA DE DESPLAZAMIENTO LATERAL ───────────────────────────────
test('la tabla no se arrastra de costado (CLAUDE.md)', () => {
  // .ab-table-wrap trae su propio overflow-x:auto desde la clase: hace falta el
  // !important para ganarle, y se deja auto sólo abajo de 900px, que es un teléfono.
  assert.match(PANEL, /#sec-galpon-config \.ab-table-wrap\{overflow-x:hidden !important\}/);
  assert.match(PANEL, /#sec-galpon-config \.gal-tbl\{table-layout:fixed/);
  assert.match(PANEL, /@media\(max-width:900px\)\{ #sec-galpon-config \.ab-table-wrap\{overflow-x:auto !important\}/);
});

test('Y CADA ABRIDOR DEJA LA VENTANA EN BLANCO', () => {
  // Un formulario que sólo se esconde CONSERVA lo que tenía. Acá eso sería
  // asignarle a una cuadrilla el rango que se tipeó para otra.
  const abr = PANEL.slice(PANEL.indexOf('function galRangoAbrir('),
                          PANEL.indexOf('function galRangoCerrar('));
  for (const id of ['gal-rg-hasta', 'gal-rg-notas']) {
    assert.match(abr, new RegExp("getElementById\\('" + id + "'\\)\\.value = '';"),
      abr.includes(id) ? id + ' no se limpia al abrir' : 'falta ' + id);
  }
  assert.match(abr, /gal-rg-error'\)\.style\.display = 'none'/);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · MANUAL LOTE DEL DÍA, CONTRA EL CÓDIGO
// ══════════════════════════════════════════════════════════════════════════
// Cada afirmación con su assert al lado. Lo que se clava no es que el texto
// exista —eso no prueba nada— sino que lo que promete siga pasando.

// El JS de la pantalla, recortado del panel.
const JS_LD = (() => {
  const i = PANEL.indexOf('var GLD =');
  assert.ok(i > 0, 'no encontré el JS de la pantalla');
  return PANEL.slice(i, PANEL.indexOf('</script>', i));
})();

test('MANUAL LD: «el IFCO de las 14:30 es del lote vigente a las 14:30»', () => {
  diceLd(/vigente <b>a las '?\n?14:30/);
  diceLd(/el último cambio cuya hora ya pasó/);
  // Y la regla es literalmente ésa: el último tramo del día cuya hora ya pasó.
  assert.match(SERV, /WHERE fecha = \? AND desde_hora <= \?/);
  assert.match(SERV, /ORDER BY desde_hora DESC, id DESC LIMIT 1/);
});

test('MANUAL LD: «el primero no pregunta la hora; el cambio sí» (V1108)', () => {
  diceLd(/no pregunta la hora del primero/);
  // Lo decide el SERVIDOR mirando si el día ya tiene tramos, y la hora que venga
  // para el primero LA IGNORA. Si sólo lo hiciera la pantalla, el que llama por
  // fuera del panel seguiría metiendo primeros tramos a las 08:00.
  assert.match(RUTA, /const hora = hayTramos \? hhmm\(b\.desde_hora\) : '00:00';/);
  assert.match(RUTA, /Un cambio de lote necesita su hora/);
  // Y la pantalla no la manda cuando el campo está escondido: mandarla escondida
  // sería mandar lo que quedó de la vez anterior, y en un PATCH eso le cambia la
  // hora a un tramo que nadie tocó.
  assert.match(JS_LD, /gal-ld-hora-fld'\)\.style\.display !== 'none'/);
});

test('MANUAL LD: «un cambio es otra fila; la de la mañana no se borra»', () => {
  diceLd(/No se borra la anterior/);
  diceLd(/sigue explicando los kilos de la mañana/);
  // Cargar un cambio INSERTA. Si actualizara la fila anterior, el tramo de la
  // mañana desaparecería y con él la explicación de sus kilos.
  const post = RUTA.slice(RUTA.indexOf("router.post('/lote-dia'"),
                          RUTA.indexOf('function tramoEditable('));
  assert.match(post, /INSERT INTO gal_lote_vigente/);
  assert.ok(!/UPDATE gal_lote_vigente/.test(post), 'cargar un cambio pisa el tramo anterior');
});

test('MANUAL LD: «antes del primer lote no hay un agujero» (V1108)', () => {
  diceLd(/Antes del primer lote no hay un agujero/);
  diceLd(/el campo de hora <b>aparece recién en el segundo<\/b>/);
  diceLd(/«Todo el día»/);

  // Y lo que el manual afirma, contra el código:
  // 1. El servidor atribuye lo anterior al primer tramo del día.
  assert.match(SERV, /ORDER BY desde_hora, id LIMIT 1'\)\.get\(f\)/);
  assert.match(SERV, /antes_del_primero: !r,/);
  // 2. Y el cartel del agujero no está más, en ningún lado.
  assert.ok(!/huecoDelDia\s*\(/.test(SERV.replace(/^\s*\/\/.*$/gm, '')),
    'volvió huecoDelDia: con ella vuelve el cartel');
  assert.ok(!/galLdDesde00|gld-hueco/.test(JS_LD), 'quedó el botón de arreglar el hueco');
  // 3. El campo de hora se esconde para el primero.
  assert.match(JS_LD, /gal-ld-hora-fld'\)\.style\.display = esPrimero \? 'none' : ''/);
  // 4. Y un día de un solo tramo se muestra como «Todo el día».
  assert.match(JS_LD, /GLD\.tramos\.length === 1 \? 'Todo el día'/);
});

test('MANUAL LD: «EL CARTEL LO RESUELVE EL SERVIDOR, no la pantalla»', () => {
  diceLd(/Lo resuelve el <b>servidor<\/b>/);
  diceLd(/el cartel diría un lote y el volcado guardaría otro/);
  // Viene resuelto en la respuesta del día...
  assert.match(RUTA, /vigente: fecha === hoy\(\) \? \(function\(\)\{ const v = loteVigente\(db, fecha, ahora\(\)\);/);
  // ...y la pantalla lo USA en vez de recalcularlo. Ésta es la mitad que importa:
  // si el navegador volviera a comparar horas, serían dos copias de la única cosa
  // que este módulo tiene que contestar igual en los dos lados.
  assert.match(JS_LD, /if \(!j\.vigente\)/);
  assert.match(JS_LD, /j\.vigente\.lote_nombre/);
  assert.ok(!/desde_hora\s*<=/.test(JS_LD),
    'la pantalla volvió a implementar la regla del vigente por su cuenta');
});

test('MANUAL LD: «mirando otro día no hay “ahora mismo”»', () => {
  diceLd(/no hay un «ahora mismo» del martes/);
  assert.match(RUTA, /fecha === hoy\(\)/);
  assert.match(JS_LD, /if \(j\.fecha !== j\.hoy\)\{ el\.style\.display = 'none'; return; \}/);
});

test('MANUAL LD: «el producto se propone con el cultivo y queda editable»', () => {
  diceLd(/Se propone el\s*cultivo que tiene cargado el lote|se propone con el cultivo/);
  diceLd(/queda\s*editable/);
  assert.match(SERV, /export function lotesParaElDia\(/);
  // Es un campo de texto, no un espejo del cultivo: el cultivo dice qué árbol hay
  // plantado, y lo que entra al galpón un martes lo sabe el que está ahí.
  assert.match(PANEL, /<input type="text" id="gal-ld-prod"/);
  assert.ok(!/id="gal-ld-prod"[^>]*readonly/.test(PANEL), 'el producto quedó de sólo lectura');
  // Y el autocompletado no pisa lo tipeado a mano.
  assert.match(JS_LD, /if \(!p\.value \|\| p\.value === GLD\.sug\) p\.value = cultivo;/);
});

test('MANUAL LD: «el cultivo que se propone es el perenne, no el de la campaña activa»', () => {
  // Hay DOS campañas activas a la vez (anual y estacional), así que «activa = 1
  // LIMIT 1» devuelve una de las dos sin criterio.
  assert.match(SERV, /ORDER BY c2\.es_perenne DESC, c2\.campaña DESC LIMIT 1/);
  // Contra el CUERPO de la función, no contra el archivo entero: el comentario de
  // arriba cita la consulta mala para explicar por qué no se usa, y buscarla en el
  // texto completo daba rojo por la explicación.
  const cuerpo = SERV.slice(SERV.indexOf('export function lotesParaElDia('),
                            SERV.indexOf('export function volcadosEnTramo('));
  assert.ok(cuerpo.length > 200, 'no encontré el cuerpo de lotesParaElDia');
  assert.ok(!/activa\s*=\s*1/.test(cuerpo), 'volvió a colgarse de la campaña activa');
});

test('MANUAL LD: «propone el último lote, PERO HAY QUE APRETAR CARGAR»', () => {
  diceLd(/nada se arrastra\s*solo de un día al otro/);
  diceLd(/La\s*propuesta ahorra tipeo; el botón es la decisión/);
  const abrir = JS_LD.slice(JS_LD.indexOf('function galLdAbrir('),
                            JS_LD.indexOf('function galLdCerrar('));
  assert.match(abrir, /GLD\.tramos\[GLD\.tramos\.length - 1\]/, 'ya no propone el último');
  // Y abrir la ventana NO guarda nada: la propuesta es una propuesta.
  assert.ok(!/fetch\(/.test(abrir), 'abrir la ventana manda algo al servidor');
});

test('MANUAL LD: «con volcados encima el tramo no se toca» — y lo dice el servidor', () => {
  diceLd(/aparece un <b>candado<\/b>/);
  diceLd(/congelado/);
  diceLd(/corregí esos volcados|corrige son <b>los volcados/);
  assert.match(SERV, /export function volcadosEnTramo\(/);
  assert.match(RUTA, /function tramoEditable\(id\)/);
  // Las DOS acciones pasan por el mismo guardián: una sola puerta.
  for (const re of [/router\.patch\('\/lote-dia\/:id'[\s\S]{0,200}?tramoEditable/,
                    /router\.delete\('\/lote-dia\/:id'[\s\S]{0,200}?tramoEditable/]) {
    assert.match(RUTA, re, 'una de las dos acciones no pasa por tramoEditable');
  }
  // Y la pantalla no ofrece el botón que va a contestar 409: el que lo aprieta
  // cree que rompió algo.
  assert.match(JS_LD, /var trabado = !!t\.volcados;/);
  assert.match(JS_LD, /🔒/);
});

test('MANUAL LD: «mientras no exista el volcado, null no es cero»', () => {
  // null = todavía no hay dónde mirar; 0 = miré y no hay. Sin la diferencia, la
  // pantalla pondría el candado el día que exista la tabla y esté vacía.
  assert.match(SERV, /name='gal_volcados'/);
  assert.match(SERV, /if \(!hay\) return null;/);
});

test('MANUAL LD: «dos lotes a la misma hora se rechazan»', () => {
  diceLd(/Dos lotes a la misma hora se rechazan/);
  diceLd(/seguiría apareciendo en la lista/);
  assert.match(SERV, /export function tramoChoca\(/);
  assert.match(RUTA, /const choca = tramoChoca\(db, fecha, hora\);/);
  assert.match(RUTA, /res\.status\(409\)/);
  // Y abajo el cinturón: aunque entre por otro lado, la base no lo deja.
  assert.match(DDL, /CREATE UNIQUE INDEX IF NOT EXISTS gal_lote_vig_uq ON gal_lote_vigente\(fecha, desde_hora\)/);
});

test('MANUAL LD: «la hora se guarda con el cero adelante»', () => {
  // No está en el manual porque al operador no le importa: lo escribe el sistema.
  // Pero es el bug más silencioso del módulo y el servidor es quien lo evita.
  assert.match(SERV, /export function hhmm\(v\)/);
  assert.match(SERV, /String\(h\)\.padStart\(2, '0'\)/);
  assert.match(RUTA, /hhmm\(b\.desde_hora\)/);
});

test('MANUAL LD: «esto NO es parametrizar: lo carga el que abre el galpón»', () => {
  diceLd(/no es parametrizar/);
  diceLd(/el dueño cargándolo por teléfono/);
  // Ninguna de las rutas del lote del día pide admin. Es la regla de CLAUDE.md:
  // operar no es ser admin.
  for (const re of [/router\.get\('\/lote-dia'[^\n]*/, /router\.get\('\/lote-vigente'[^\n]*/,
                    /router\.get\('\/lotes'[^\n]*/, /router\.post\('\/lote-dia'[^\n]*/,
                    /router\.patch\('\/lote-dia\/:id'[^\n]*/, /router\.delete\('\/lote-dia\/:id'[^\n]*/]) {
    const linea = (RUTA.match(re) || [''])[0];
    assert.ok(linea, 'no encontré la ruta ' + re);
    assert.ok(!/requireAdmin/.test(linea), 'el trabajo del día quedó pedido a admin: ' + linea);
  }
  // Y el nivel lo decide exigirNivel por la URL, que es lo que hace que esto no
  // sea una pantalla abierta a cualquiera con sesión.
  assert.match(PREFIJOS, /\['galpon-lote-dia', 'galpon\/lote-dia,galpon\/lote-vigente,galpon\/lotes'\]/);
});

test('MANUAL LD: «sin lote cargado el IFCO se guarda igual, marcado para revisar»', () => {
  diceLd(/se guarda igual/);
  diceLd(/marcado para revisar/);
  // El principio del módulo: la fruta ya está en la tolva. /lote-vigente contesta
  // 200 con ok:false adentro, nunca 404 — un 404 dejaría al que pregunta sin
  // saber qué hacer con el IFCO.
  const g = RUTA.slice(RUTA.indexOf("router.get('/lote-vigente'"),
                       RUTA.indexOf("router.post('/lote-dia'"));
  assert.ok(!/status\(4\d\d\)/.test(g), '/lote-vigente aprendió a rechazar');
  assert.match(g, /res\.json\(Object\.assign\(\{ fecha, hora \}, loteVigente\(db, fecha, hora\)\)\);/);
});

test('MANUAL LD: «los lotes salen de Producción, acá no se dan de alta»', () => {
  diceLd(/Producción → Lotes/);
  diceLd(/no se dan de\s*alta/);
  assert.match(SERV, /FROM pa_lotes l/);
  assert.ok(!/INSERT INTO pa_lotes|ALTER TABLE pa_lotes/.test(RUTA + SERV + DDL),
    'el galpón le escribe a la tabla de otro módulo');
});

test('la pantalla del lote del día tampoco se arrastra de costado', () => {
  assert.match(PANEL, /#sec-galpon-lote-dia \.ab-table-wrap\{overflow-x:hidden !important\}/);
  assert.match(PANEL, /#sec-galpon-lote-dia \.gld-tbl\{table-layout:fixed/);
  assert.match(PANEL, /@media\(max-width:900px\)\{ #sec-galpon-lote-dia \.ab-table-wrap\{overflow-x:auto !important\}/);
});

test('Y SU VENTANA TAMBIÉN SE ABRE EN BLANCO', () => {
  // Un formulario que sólo se esconde CONSERVA lo que tenía. Acá eso sería cargar
  // el lote que se tipeó y se canceló hace un rato, con la hora de aquel momento.
  const abrir = JS_LD.slice(JS_LD.indexOf('function galLdAbrir('),
                            JS_LD.indexOf('function galLdCerrar('));
  assert.match(abrir, /gal-ld-error'\)\.style\.display = 'none'/);
  assert.match(abrir, /GLD\.sug = '';/);
  // Los tres campos se escriben SIEMPRE, por las dos ramas: la de corregir toma
  // los valores del tramo y la de cargar los propone. Ninguna los deja como
  // estaban.
  for (const id of ['gal-ld-prod', 'gal-ld-hora']) {
    const n = (abrir.match(new RegExp("getElementById\\('" + id + "'\\)\\.value =", 'g')) || []).length;
    assert.ok(n >= 2, id + ' no se escribe en las dos ramas del abridor (' + n + ')');
  }
  assert.ok((abrir.match(/sel\.value =/g) || []).length >= 2, 'el select no se fija en las dos ramas');
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · MANUAL CARGA DE KILOS, CONTRA EL CÓDIGO (V1108)
// ══════════════════════════════════════════════════════════════════════════
// Andy, 30/10/2026: «hará algo más manual... porque todavía no instalamos la
// impresora». Cada afirmación del manual con su assert al lado contra el
// router o el servicio — no contra el texto, que no prueba nada.
const MANUAL_KG = manualDe('galpon-carga');
const diceKg = lector(MANUAL_KG);

const JS_KG = (() => {
  const i = PANEL.indexOf('var GKG =');
  assert.ok(i > 0, 'no encontré el JS de la carga de kilos');
  return PANEL.slice(i, PANEL.indexOf('</script>', i));
})();

test('MANUAL KG: «es el MISMO libro que va a usar el escaneo»', () => {
  diceKg(/<code>gal_volcados<\/code>/);
  diceKg(/no es provisorio ni se va a migrar/);
  // Una sola tabla de kilos, y con las columnas del escaneo puestas desde ya:
  // agregarlas después sería un ALTER sobre datos que ya pagan jornales.
  assert.match(DDL, /CREATE TABLE IF NOT EXISTS gal_volcados/);
  for (const col of ['hora', 'tarjeta_id', 'bruto', 'tara', 'origen', 'uuid']) {
    assert.match(DDL, new RegExp('\\n\\s*' + col + '\\s+(TEXT|REAL|INTEGER)'),
      'falta la columna ' + col + ': el escaneo va a necesitar un ALTER sobre datos vivos');
  }
  // Y la escribe el router de la carga manual, no otro.
  assert.match(SERV, /INSERT OR IGNORE INTO gal_volcados/);
});

test('MANUAL KG: «el día de cosecha no es el día en que se tipea»', () => {
  diceKg(/Lo del sábado se puede cargar el lunes/);
  // Son dos columnas distintas: la que elige el operador y la que pone la base.
  assert.match(DDL, /fecha\s+TEXT NOT NULL,/);
  assert.match(DDL, /creado_en\s+TEXT DEFAULT \(datetime\('now','localtime'\)\)/);
  // La fecha SALE DEL PEDIDO y no del reloj del servidor: si la pusiera el
  // servidor, lo del sábado quedaría contado el lunes.
  assert.match(SERV, /const fecha = esFecha\(dd\.fecha\);/);
});

test('MANUAL KG: «se puede escribir 450, 450,5 o 1.250»', () => {
  diceKg(/<b>450<\/b>, <b>450,5<\/b> o <b>1\.250<\/b>/);
  // Las dos reglas del parseo, y la segunda es la que evita el error grande:
  // «1.250» leído como 1,25 kg no da error, entra mil veces más chico.
  assert.match(SERV, /if \(s\.includes\(','\)\) limpio = s\.replace\(\/\\\.\/g, ''\)\.replace\(',', '\.'\);/);
  assert.match(SERV, /\{1,3\}\(\\\.\\d\{3\}\)\+/, 'se perdió la regla del punto de miles');
});

test('MANUAL KG: «los IFCOs vacíos son null, no cero»', () => {
  diceKg(/no es lo mismo que cero/);
  assert.match(SERV, /export function entero\(v\) \{/);
  assert.match(SERV, /if \(!s\) return null;/);
});

test('MANUAL KG: «EL CERO DE MÁS SE MARCA Y ENTRA IGUAL»', () => {
  diceKg(/no frena nada/);
  diceKg(/20\.000 kg de fábrica/);
  diceKg(/partir el renglón en dos/);
  // El tope existe, es configurable y tiene su semilla.
  assert.match(DDL, /\['kg_max_carga', '20000'\]/);
  assert.match(SERV, /kg_max_carga: Number\(c\.kg_max_carga\) \|\| 0,/);
  // Y MARCA en vez de rechazar: el estado cambia, el ok sigue siendo true.
  const reg = SERV.slice(SERV.indexOf('export function registrarVolcado('),
                         SERV.indexOf('export function editarVolcado('));
  assert.match(reg, /estado = 'a_revisar';/);
  assert.ok(!/techo[\s\S]{0,200}return \{ ok: false/.test(reg),
    'el tope rechaza la carga: eso enseña a partir el renglón en dos');
  // En 0 queda apagado.
  assert.match(reg, /if \(techo > 0 && kg > techo\)/);
});

test('MANUAL KG: «el doble clic no duplica kilos»', () => {
  diceKg(/si el mismo llega dos veces, el servidor guarda una sola fila/);
  assert.match(DDL, /uuid\s+TEXT UNIQUE/);
  assert.match(SERV, /INSERT OR IGNORE INTO gal_volcados/);
  // Y el reintento devuelve la fila que YA estaba, no un error: el que apretó
  // dos veces tiene que ver lo mismo que vería si hubiera entrado recién.
  assert.match(SERV, /if \(!r\.changes\) \{/);
  assert.match(SERV, /repetido: true/);
  // La pantalla genera uno nuevo por carga, y otro después de guardar.
  assert.ok((JS_KG.match(/galKgNuevoUuid\(\)/g) || []).length >= 3,
    'el uuid no se renueva: dos cargas seguidas entrarían como una');
});

test('MANUAL KG: «corregir los kilos no borra la cuadrilla»', () => {
  diceKg(/Al corregir los kilos se vuelve a mirar el tope/);
  const ed = SERV.slice(SERV.indexOf('export function editarVolcado('),
                        SERV.indexOf('export function borrarVolcado('));
  // Sólo lo que VINO en el pedido. Un PATCH que pisara con null los campos
  // ausentes borraría la cuadrilla cada vez que alguien corrige los kilos, y
  // esos kilos saldrían del kg por jornal sin que nadie lo vea.
  for (const campo of ['fecha', 'lote_id', 'cuadrilla_id', 'producto', 'observacion', 'ifcos', 'kilos']) {
    assert.ok(ed.includes("'" + campo + "' in dd"),
      'editarVolcado pisa ' + campo + ' aunque no haya venido');
  }
  // Y el tope se revalida en los dos sentidos.
  assert.match(ed, /set\('estado', revision \? 'a_revisar' : 'ok'\);/);
});

test('MANUAL KG: «borrar es borrado blando»', () => {
  diceKg(/<b>borrado blando<\/b>/);
  assert.match(DDL, /eliminado_en TEXT/);
  assert.match(SERV, /UPDATE gal_volcados SET eliminado_en = datetime\('now','localtime'\)/);
  assert.ok(!/DELETE FROM gal_volcados/.test(SERV), 'hay un borrado duro de kilos');
  // Y lo borrado deja de contar en los tres lados que leen el libro.
  for (const fn of ['volcadosDelDia', 'resumenDelDia', 'volcadosEnTramo']) {
    const i = SERV.indexOf('export function ' + fn + '(');
    assert.ok(i > 0, 'no está ' + fn);
    assert.match(SERV.slice(i, i + 1400), /eliminado_en IS NULL/,
      fn + ' cuenta las cargas borradas');
  }
});

test('MANUAL KG: «los dos cortes son por cuadrilla y por lote»', () => {
  diceKg(/como se paga el jornal/);
  diceKg(/como se mide el rendimiento/);
  // Acotado al cuerpo de la función y no «hasta el final del archivo»: debajo vive
  // ahora el acumulado (V1109), que tiene sus propios GROUP BY y los contaba de más.
  const iRes = SERV.indexOf('export function resumenDelDia(');
  const res = SERV.slice(iRes, SERV.indexOf('\r\n}', iRes));
  assert.match(res, /GROUP BY cuadrilla_id/);
  assert.match(res, /GROUP BY lote_id/);
  // ORDENADOS POR EL TOTAL DEL GRUPO. Con el alias, SQLite ata el ORDER BY a la
  // COLUMNA kilos y no al SUM() que la tapa: sale una lista ordenada, sólo que
  // mal — y ordenada mal se ve igual que ordenada bien.
  assert.ok(!/ORDER BY kilos DESC/.test(res), 'ordena por el alias y no por el SUM');
  assert.ok((res.match(/ORDER BY SUM\(kilos\) DESC/g) || []).length === 2);
});

test('MANUAL KG: «el recuadro rojo aparece sólo si hay algo que revisar»', () => {
  diceKg(/Un «0» todos los días enseña a no mirar ese lugar/);
  assert.match(JS_KG, /if \(r\.a_revisar\) h \+= t\('Para revisar'/);
});

test('MANUAL KG: «la carga no depende del lote del día, lo aprovecha»', () => {
  diceKg(/no depende<\/b> de esa/);
  // La propuesta viene en la respuesta del día y puede ser null, y el POST no
  // mira gal_lote_vigente para nada: se puede cargar un día que nadie declaró.
  assert.match(RUTA, /propuesta: \(function \(\) \{/);
  const post = RUTA.slice(RUTA.indexOf("router.post('/volcados'"),
                          RUTA.indexOf("router.patch('/volcados/:id'"));
  assert.ok(!/loteVigente|gal_lote_vigente/.test(post),
    'cargar kilos quedó atado a que alguien haya declarado el lote del día');
});

test('MANUAL KG: «quién cargó sale de la cookie» y «no hace falta ser admin»', () => {
  diceKg(/no parametrizar/);
  diceKg(/no puede<\/b> declarar el lote del día/);
  const post = RUTA.slice(RUTA.indexOf("router.post('/volcados'"),
                          RUTA.indexOf("router.patch('/volcados/:id'"));
  // Ninguna de las cuatro rutas de kilos pide admin...
  const kg = RUTA.slice(RUTA.indexOf("router.get('/volcados'"));
  assert.ok(!/requireAdmin/.test(kg), 'cargar kilos pide admin: lo cargaría el dueño');
  // ...y la firma la pone el servidor, no el cuerpo del pedido.
  assert.match(post, /usuario_id: u\.id \|\| null,/);
  assert.match(post, /usuario: u\.nombre \|\| null,/);
  // Y el permiso de escribir es sólo sobre sus propias direcciones: lo que lee
  // de otros módulos va en api_lectura, que da leer y no escribir.
  assert.match(PREFIJOS, /\['galpon-carga', 'galpon\/volcados'\]/);
  assert.match(PREFIJOS, /\['galpon-carga',\s+'galpon\/lotes,galpon\/cuadrillas,galpon\/lote-vigente'\]/);
});

test('MANUAL KG: «la ventana no se cierra al cargar»', () => {
  diceKg(/no se cierra al cargar/);
  diceKg(/quedan<\/b> el lote y la cuadrilla/);
  const g = JS_KG.slice(JS_KG.indexOf('async function galKgGuardar('),
                        JS_KG.indexOf('async function galKgBorrar('));
  // Cierra SÓLO al corregir; cargando sigue abierta con el acuse.
  assert.match(g, /if \(GKG\.editId\)\{ galKgCerrar\(\); return; \}/);
  // Y se limpia lo que cambia de una pesada a la otra, no el lote ni la cuadrilla.
  for (const id of ['gal-kg-kilos', 'gal-kg-ifcos', 'gal-kg-obs']) {
    assert.ok(g.includes("getElementById('" + id + "').value = ''"), 'no se limpia ' + id);
  }
  assert.ok(!g.includes("getElementById('gal-kg-lote').value = ''"),
    'se limpia el lote entre cargas: ocho renglones seguidos serían ocho veces el desplegable');
  // El Enter en los kilos carga el renglón.
  assert.match(PANEL, /id="gal-kg-kilos"[\s\S]{0,200}galKgGuardar\(\);/);
});

test('LA VENTANA DE KILOS SE ABRE EN BLANCO, como todas', () => {
  // Un formulario que sólo se esconde CONSERVA lo que tenía: acá eso sería
  // cargarle a una cuadrilla los kilos que se tipearon para otra y se cancelaron.
  const abrir = JS_KG.slice(JS_KG.indexOf('function galKgAbrir('),
                            JS_KG.indexOf('function galKgCerrar('));
  assert.match(abrir, /gal-kg-error'\)\.style\.display = 'none'/);
  assert.match(abrir, /gal-kg-ok'\)\.style\.display = 'none'/);
  for (const id of ['gal-kg-kilos', 'gal-kg-ifcos', 'gal-kg-obs']) {
    assert.ok(abrir.includes("getElementById('" + id + "').value = ''"),
      id + ' conserva lo de la carga anterior');
  }
  // Y los que se escriben en las DOS ramas: la de corregir toma los del renglón,
  // la de cargar los propone. Ninguna los deja como estaban.
  for (const id of ['gal-kg-fecha', 'gal-kg-prod']) {
    const n = (abrir.match(new RegExp("getElementById\\('" + id + "'\\)\\.value =", 'g')) || []).length;
    assert.ok(n >= 2, id + ' no se escribe en las dos ramas del abridor (' + n + ')');
  }
  assert.ok((abrir.match(/sel\.value =/g) || []).length >= 2, 'el select no se fija en las dos ramas');
  assert.ok((abrir.match(/cu\.value =/g) || []).length >= 1, 'la cuadrilla no se fija al corregir');
});

test('la pantalla de kilos tampoco se arrastra de costado', () => {
  assert.match(PANEL, /#sec-galpon-carga \.ab-table-wrap\{overflow-x:hidden !important\}/);
  assert.match(PANEL, /#sec-galpon-carga \.gkg-tbl\{table-layout:fixed/);
  assert.match(PANEL, /@media\(max-width:900px\)\{ #sec-galpon-carga \.ab-table-wrap\{overflow-x:auto !important\}/);
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · EL ACUMULADO, CONTRA EL CÓDIGO (V1109)
// ══════════════════════════════════════════════════════════════════════════
// Andy, 31/10/2026: «mostrame algún lugar donde vamos acumulando el total, no
// sólo por día». Las sumas tienen su propio archivo
// (test/galpon_acumulado.test.mjs); acá se clava lo que el MANUAL promete.
const MANUAL_AC = manualDe('galpon-acumulado');
const diceAc = lector(MANUAL_AC);
const JS_AC = PANEL.slice(PANEL.indexOf('var GAC = {'),
                          PANEL.indexOf('\r\n</script>', PANEL.indexOf('var GAC = {')));
const ACUM = SERV.slice(SERV.indexOf('export function acumulado('));

test('MANUAL AC: «no hay nada que cerrar: suma los mismos renglones»', () => {
  diceAc(/suma los mismos renglones/i);
  diceAc(/el acumulado cambia solo/);
  // Y es cierto porque no existe ninguna tabla de totales: el servicio lee
  // gal_volcados y nada más. Una tabla de acumulados es un número que se
  // desincroniza en silencio cuando alguien corrige una carga vieja.
  assert.match(ACUM, /FROM gal_volcados/);
  assert.ok(!/gal_acumulado|gal_totales|gal_cierre/.test(SERV),
    'apareció una tabla de totales guardados: el manual promete que no hay');
  assert.ok(!/INSERT|UPDATE|DELETE/.test(ACUM),
    'el acumulado escribe algo, y el manual dice que sólo lee');
});

test('MANUAL AC: «se entra sin período y muestra TODO»', () => {
  diceAc(/sin período puesto/);
  diceAc(/todo lo que hay cargado/);
  // El servicio cae al rango completo cuando no le dan fechas...
  assert.match(ACUM, /if \(!d\) d = r\.primera/);
  assert.match(ACUM, /if \(!h\) h = r\.ultima/);
  // ...y la pantalla entra sin mandar ninguna, en vez de proponer un mes.
  assert.match(JS_AC, /if \(d && d\.value\) q\.push\('desde='/);
  assert.match(JS_AC, /async function galAcInit\(\)\{\r?\n(?:[^}]*\r?\n)*?\s*await galAcCargar\(\);/,
    'el abridor pone un período por defecto en vez de pedir todo');
});

test('MANUAL AC: «las dos fechas entran en la cuenta»', () => {
  diceAc(/Las dos fechas <b>entran<\/b> en la cuenta/);
  assert.match(ACUM, /fecha >= \? AND fecha <= \?/,
    'el rango dejó de ser inclusivo en alguna de las dos puntas');
});

test('MANUAL AC: «si las fechas van al revés se dan vuelta y se avisa»', () => {
  diceAc(/se dan vuelta solas y/);
  diceAc(/0 kg<\/b> con total aplomo/);
  assert.match(ACUM, /if \(d > h\) \{[^}]*invertido = true/);
  // Y la pantalla muestra el aviso: darlas vuelta sin decirlo deja al que mira
  // creyendo que pidió otra cosa.
  assert.match(JS_AC, /if \(!j \|\| !j\.invertido\)\{ el\.innerHTML = ''; return; \}/);
  assert.match(JS_AC, /Las fechas estaban al revés/);
});

test('MANUAL AC: «días trabajados son días, no renglones»', () => {
  diceAc(/Días <i>con al menos una carga<\/i>, no días del almanaque/);
  assert.match(ACUM, /COUNT\(DISTINCT fecha\) AS dias/,
    'los días trabajados cuentan filas: el promedio sale dividido por las pesadas');
});

test('MANUAL AC: «el promedio se divide por los días trabajados»', () => {
  diceAc(/metería los domingos y los días de lluvia en el divisor/);
  assert.match(ACUM, /promedio_dia: dias > 0 \? round2\(kilos \/ dias\) : 0/,
    'el promedio divide por otra cosa, o divide por cero');
});

test('MANUAL AC: «el acumulado del renglón de arriba es el total»', () => {
  diceAc(/El acumulado del renglón de arriba de todo es el total grande/);
  // Se suma en orden ascendente y recién después se da vuelta la lista. Al
  // revés, el primer renglón diría los kilos del último día.
  assert.match(ACUM, /ORDER BY fecha ASC/);
  const iSuma = ACUM.indexOf('f.acumulado = corrido;');
  const iVuelta = ACUM.indexOf('.slice().reverse()');
  assert.ok(iSuma > 0 && iVuelta > iSuma,
    'la lista se da vuelta ANTES de sumar: el acumulado queda al revés');
});

test('MANUAL AC: «los días sin cargas no aparecen»', () => {
  diceAc(/no aparecen/);
  // No hay relleno de días vacíos: la lista sale del GROUP BY y nada más.
  assert.match(ACUM, /GROUP BY fecha/);
  assert.ok(!/while \(|for \(let x = new Date/.test(ACUM),
    'se están rellenando los días del almanaque');
});

test('MANUAL AC: «los tres cortes van ordenados por kilos, con su porcentaje»', () => {
  diceAc(/Por cuadrilla/);
  diceAc(/Por producto/);
  diceAc(/es como se habla afuera/);
  for (const g of ['cuadrilla_id', 'lote_id', 'producto']) {
    assert.ok(ACUM.includes("corte('" + g + "'"), 'falta el corte por ' + g);
  }
  // Por el SUM() y no por el alias: en SQLite `ORDER BY kilos` adentro de un
  // GROUP BY se ata a la COLUMNA y la lista sale ordenada, sólo que mal.
  assert.match(ACUM, /ORDER BY SUM\(kilos\) DESC/);
  assert.ok(!/ORDER BY kilos DESC/.test(ACUM), 'ordena por el alias');
  // Y el porcentaje se calcula en UN lugar, no en la pantalla también.
  assert.match(ACUM, /pct: kilos > 0 \?/);
  assert.ok(!/\/ *total[.\w]* *\* *100/.test(JS_AC),
    'la pantalla recalcula el porcentaje: dos lugares que lo redondean distinto');
});

test('MANUAL AC: «un lote del que salió más de un producto los lista a los dos»', () => {
  diceAc(/<b>los lista a los dos<\/b>/);
  assert.match(ACUM, /GROUP_CONCAT\(DISTINCT producto\)/,
    'el producto del lote sale de una fila cualquiera del grupo');
});

test('MANUAL AC: «lo cargado sin cuadrilla se junta aparte»', () => {
  diceAc(/no entran<\/b> en el kg por jornal/);
  assert.match(ACUM, /sin cuadrilla/);
  assert.match(ACUM, /sin producto/);
});

test('MANUAL AC: «para revisar aparece sólo si hay»', () => {
  diceAc(/sólo<\/i> si hay cargas marcadas/);
  assert.match(JS_AC, /if \(t\.a_revisar\) h \+= caja\('Para revisar'/);
});

test('MANUAL AC: «esta pantalla sólo lee»', () => {
  diceAc(/no tiene ningún botón que escriba/);
  // Ni un fetch con método, ni un onclick que guarde.
  assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(JS_AC),
    'la pantalla del acumulado escribe');
  const sec = PANEL.slice(PANEL.indexOf('id="sec-galpon-acumulado"'),
                          PANEL.indexOf('id="sec-sg-importacion"'));
  assert.ok(!/galAcGuardar|galAcBorrar/.test(sec));
});

test('EL ACUMULADO ES UN MÓDULO APARTE, y el manual dice por qué', () => {
  // Una fila de usuario_modulos = un ítem de menú = un permiso. Con una solapa
  // adentro de la carga, dar una cosa daría la otra: el que pesa vería el total
  // por cuadrilla de toda la temporada, que es con lo que se discute plata.
  diceAc(/los miran dos personas distintas/);
  assert.match(ENSURE, /\['galpon-acumulado'/);
  assert.match(PREFIJOS, /\['galpon-acumulado', 'galpon\/acumulado'\]/);
});

test('EL MANUAL DE LA CARGA MANDA ACÁ PARA EL TOTAL', () => {
  // Si no lo dijera, el operador sumaría los días a mano — que es exactamente
  // lo que había antes de esta pantalla.
  const kg = manualDe('galpon-carga');
  assert.match(kg, /Galpón · Acumulado/,
    'el manual de la carga no menciona dónde está el total de la temporada');
  assert.match(kg, /V1109/, 'el puntero no lleva su número de versión');
});

test('la fecha de la tabla NO se arma con new Date(«2026-10-28»)', () => {
  // Una fecha sola la toma el navegador como UTC de medianoche, y parado en
  // Argentina (-3) eso se muestra como el día anterior: toda la columna
  // corrida un día, con los kilos del lunes figurando el domingo.
  assert.match(JS_AC, /new Date\(Number\(p\[0\]\), Number\(p\[1\]\) - 1, Number\(p\[2\]\)\)/);
  assert.ok(!/new Date\(\s*(f|x\.fecha|j\.\w+\.fecha)\s*\)/.test(JS_AC),
    'se está parseando la fecha con new Date(cadena): corre un día');
});

test('la pantalla del acumulado tampoco se arrastra de costado', () => {
  assert.match(PANEL, /#sec-galpon-acumulado \.ab-table-wrap\{overflow-x:hidden !important\}/);
  assert.match(PANEL, /#sec-galpon-acumulado \.gac-tbl\{table-layout:fixed/);
});

test('Y LA TABLA DEL DÍA NO PARTE LAS PALABRAS A LA MITAD', () => {
  // Andy mandó la pantalla con «PRO DUC TO» apilado en tres renglones y
  // «Damasco» en «Da mas co»: es `word-break:break-word`, que corta adentro de
  // la palabra. Entre palabras sí; adentro de una, sólo como último recurso.
  assert.ok(!/#sec-galpon-carga \.gkg-tbl th\.gkg-w\{/.test(PANEL),
    'los encabezados siguen partiéndose adentro de la palabra');
  assert.match(PANEL, /#sec-galpon-carga \.gkg-tbl td\.gkg-w\{\r?\n\s*white-space:normal;word-break:normal;overflow-wrap:break-word\}/);
});

test('CADA PREFIJO DECLARADO LO USA ALGUNA RUTA DE VERDAD', () => {
  // Al revés que el test de arriba, que mira que ninguna ruta quede sin prefijo.
  // Un prefijo declarado que NINGUNA ruta usa es la señal de que la dirección se
  // movió: sigue contestando, pero ahora cae bajo el prefijo de otro módulo y la
  // cuida el permiso del menú equivocado. Eso no da ningún error y no se ve: la
  // pantalla abre igual, para el que no debería poder abrirla.
  const rutas = [...RUTA.matchAll(/router\.(?:get|post|put|patch|delete)\('\/([^'/?]+)/g)]
    .map((m) => m[1]);
  assert.ok(rutas.length > 5, 'el regex de las rutas se rompió: ' + rutas.length);
  for (const { modulo } of MODULOS) {
    const m = new RegExp("\\['" + modulo + "',\\s*'([^']+)'\\]").exec(PREFIJOS);
    for (const d of m[1].split(',')) {
      const pref = d.trim().replace(/^galpon\//, '').split('.')[0];
      assert.ok(rutas.some((r) => r === pref || r.startsWith(pref + '/') || r.startsWith(pref + '.')),
        'el prefijo ' + d.trim() + ' (' + modulo + ') no lo usa ninguna ruta del router: '
        + '¿la dirección se movió abajo del prefijo de otro módulo?');
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · ⚡ LA CARGA RÁPIDA, CONTRA EL CÓDIGO (V1110)
// ══════════════════════════════════════════════════════════════════════════
// Andy, 31/10/2026: «quiero que el OPERADOR tenga que sólo poner los kilos...
// que ya quede guardado el último lote, comentarios y cuadrilla que puso».
const I_RAP = PANEL.indexOf('var GRP = {');
const JS_RAP = PANEL.slice(I_RAP, PANEL.indexOf('📈 GALPÓN · ACUMULADO', I_RAP));
const I_MOD = PANEL.indexOf('id="gal-rap-modal"');
const MOD_RAP = PANEL.slice(I_MOD, PANEL.indexOf('id="sec-galpon-acumulado"', I_MOD));
test('los cortes del panel no quedaron vacíos', () => {
  // Un slice vacío hace que TODOS los asserts de abajo miren la nada y pasen.
  assert.ok(JS_RAP.length > 2000, 'JS_RAP mide ' + JS_RAP.length);
  assert.ok(MOD_RAP.length > 1000, 'MOD_RAP mide ' + MOD_RAP.length);
});

test('MANUAL KG: «se abre en dos pasos, y el segundo es sólo los kilos»', () => {
  diceKg(/Primero, de qué son estos kilos/);
  diceKg(/Después, sólo los kilos/);
  // Los dos paneles existen, y el de carga arranca escondido.
  assert.match(MOD_RAP, /id="gal-rap-setup"/);
  assert.match(MOD_RAP, /id="gal-rap-carga" style="display:none"/);
  // El abridor muestra el primero y esconde el segundo, siempre.
  assert.match(JS_RAP, /getElementById\('gal-rap-setup'\)\.style\.display = '';/);
  assert.match(JS_RAP, /getElementById\('gal-rap-carga'\)\.style\.display = 'none';/);
});

test('MANUAL KG: «HAY QUE APRETAR EMPEZAR IGUAL» — no hay atajo que lo saltee', () => {
  // Es la línea entre una pantalla rápida y una pantalla que esconde a quién se
  // le anotan los kilos. Si el abridor pudiera dejar el paso 2 a la vista, la
  // tanda arrancaría con la cuadrilla de ayer sin que nadie la haya elegido.
  diceKg(/esconda <b>a quién se le están anotando los kilos<\/b>/);
  const abrir = JS_RAP.slice(JS_RAP.indexOf('function galRapAbrir('),
                             JS_RAP.indexOf('function galRapLotePick('));
  assert.ok(!/galRapEmpezar\(\)/.test(abrir), 'el abridor empieza la tanda solo');
  assert.match(abrir, /GRP\.fijo = null;/, 'no limpia lo fijo de la tanda anterior');
  // Y cargar sin haber pasado por Empezar no manda nada.
  assert.match(JS_RAP, /var f = GRP\.fijo; if \(!f\) return;/);
});

test('MANUAL KG: «viene propuesto con lo último que cargaste VOS»', () => {
  diceKg(/lo último que cargaste vos/);
  // Sale de GKG.ultimo, que el servidor arma con el usuario de la COOKIE.
  assert.match(JS_RAP, /var u = GKG\.ultimo, p = GKG\.propuesta;/);
  assert.match(RUTA, /ultimo: ultimaCarga\(db, fecha, \(req\._user \|\| \{\}\)\.id\)/);
  assert.match(SERV, /export function ultimaCarga\(db, fecha, usuarioId\)/);
  // Los tres campos que pidió Andy: lote, cuadrilla y observación.
  assert.match(JS_RAP, /sel\.value = u \? String\(u\.lote_id\)/);
  assert.match(JS_RAP, /cu\.value = \(u && u\.cuadrilla_id\)/);
  assert.match(JS_RAP, /gal-rap-obs'\)\.value = \(u && u\.observacion\)/);
});

test('MANUAL KG: «lo que se propone NO se guarda en ningún lado»', () => {
  diceKg(/no se guarda en ningún lado/);
  // No hay tabla ni columna de preferencias: se deduce de gal_volcados, y por eso
  // borrar la última carga hace que se proponga la anterior sola.
  const ult = SERV.slice(SERV.indexOf('export function ultimaCarga('),
                         SERV.indexOf('// ── EL RESUMEN DEL DÍA'));
  assert.match(ult, /FROM gal_volcados WHERE eliminado_en IS NULL/);
  assert.ok(!/INSERT|UPDATE/.test(ult), 'guarda la preferencia en algún lado');
  assert.ok(!/gal_preferencias|gal_ultimo/.test(SERV + DDL));
  // Y no se guarda en el navegador tampoco: eso sería una tanda que sobrevive a
  // cambiar de computadora, y otra que no — sin forma de saber cuál es cuál.
  assert.ok(!/localStorage|sessionStorage/.test(JS_RAP));
});

test('MANUAL KG: «si lo propuesto viene de otro día, lo dice»', () => {
  diceKg(/si lo propuesto viene de <b>otro día<\/b> la ventana lo dice/);
  assert.match(JS_RAP, /if \(u && u\.de_otro_dia\)\{/);
  assert.match(JS_RAP, /Esto viene del/);
  // Y la bandera la calcula el servidor comparando con el día que se está mirando.
  assert.match(SERV, /de_otro_dia: fila\.fecha !== f,/);
});

test('MANUAL KG: «Cambiar vuelve al primer paso SIN perder la tanda»', () => {
  diceKg(/vuelve al primer paso sin perder la tanda/);
  const camb = JS_RAP.slice(JS_RAP.indexOf('function galRapCambiar('),
                            JS_RAP.indexOf('function galRapPintarFijo('));
  assert.ok(!/GRP\.tanda = \[\]/.test(camb), 'Cambiar borra la lista de lo ya cargado');
  assert.match(camb, /gal-rap-setup'\)\.style\.display = '';/);
});

test('MANUAL KG: «Enter carga y la ventana queda abierta»', () => {
  diceKg(/<b>Enter<\/b>, y listo: el siguiente cajón/);
  assert.match(MOD_RAP, /onkeydown="galRapTecla\(event\)"/);
  assert.match(JS_RAP, /if \(ev\.key === 'Enter'\)\{ ev\.preventDefault\(\); galRapCargar\(\); \}/);
  // Y al cargar no se cierra: se limpia el casillero y vuelve el foco.
  const carg = JS_RAP.slice(JS_RAP.indexOf('async function galRapCargar('),
                            JS_RAP.indexOf('function galRapPintar('));
  assert.ok(!/classList\.remove\('on'\)/.test(carg), 'la ventana se cierra al cargar');
  assert.match(carg, /kg\.value = '';/);
  assert.match(carg, /kg\.focus\(\);/);
});

test('UN UUID NUEVO POR CARGA, o la segunda del Enter seguido no entra', () => {
  // El uuid es UNIQUE y el servidor hace INSERT OR IGNORE: reusarlo haría que la
  // segunda pesada de la tanda se descarte en silencio. Es el mismo mecanismo
  // que frena el doble clic, y acá se aprieta Enter veinte veces seguidas.
  const carg = JS_RAP.slice(JS_RAP.indexOf('async function galRapCargar('),
                            JS_RAP.indexOf('function galRapPintar('));
  assert.match(carg, /GRP\.uuid = galKgNuevoUuid\(\);/);
  const iOk = carg.indexOf('if (!j.ok)');
  const iUuid = carg.indexOf('GRP.uuid = galKgNuevoUuid();');
  assert.ok(iUuid > iOk, 'el uuid se renueva antes de saber si entró: una carga fallida '
    + 'y reintentada se duplicaría');
  assert.match(JS_RAP, /uuid: GRP\.uuid,/);
});

test('EL ERROR NO LIMPIA LOS KILOS', () => {
  // Si los borrara, el que escribió mal tendría que volver a tipearlos — en la
  // pantalla que existe para tipear lo menos posible.
  const carg = JS_RAP.slice(JS_RAP.indexOf('async function galRapCargar('),
                            JS_RAP.indexOf('function galRapPintar('));
  const iErr = carg.indexOf('err.textContent = j.error;');
  const iLimpia = carg.indexOf("kg.value = '';");
  assert.ok(iErr > 0 && iLimpia > iErr, 'el camino del error limpia los kilos');
  assert.match(carg, /kg\.focus\(\); kg\.select\(\); return;/);
});

test('MANUAL KG: «deshacer no pregunta», y por qué puede no preguntar', () => {
  diceKg(/borra esa carga sin '\s*\+\s*'preguntar|sin preguntar/);
  const des = JS_RAP.slice(JS_RAP.indexOf('async function galRapDeshacer('));
  assert.ok(!/confirm\(/.test(des), 'deshacer pregunta: es un clic de más en la pantalla '
    + 'que existe para sacar clics');
  assert.match(des, /method:'DELETE'/);
  // Y es blando porque el servidor lo hace blando, no porque la pantalla lo diga.
  assert.match(SERV, /export function borrarVolcado\([\s\S]{0,400}eliminado_en = datetime/);
});

test('LA VENTANA RÁPIDA VIVE FUERA DE TODA PANTALLA, como todas', () => {
  // Con .sec{display:none}, una ventana colgada de una pantalla sólo se abre
  // desde ésa. Lo audita ventanas_del_panel.test.mjs para todas; acá queda el
  // porqué al lado de la ventana nueva.
  const iSec = PANEL.lastIndexOf('<div class="sec', PANEL.indexOf('id="gal-rap-modal"'));
  const iFin = PANEL.lastIndexOf('</div>', PANEL.indexOf('id="gal-rap-modal"'));
  assert.ok(iFin > iSec, 'la ventana rápida quedó adentro de una .sec');
  assert.match(PANEL, /<div class="ab-modal-overlay sg-mod" id="gal-rap-modal">/,
    'sin ab-modal-overlay no hay fondo oscuro ni z-index: se abre abajo de la otra');
});

test('el botón de la carga rápida está en la pantalla, y el otro sigue estando', () => {
  // La ventana larga no se va: es la que corrige una carga, y la que sirve
  // cuando hay que cargar un solo renglón de un día viejo.
  assert.match(PANEL, /onclick="galRapAbrir\(\)">⚡ Carga rápida<\/button>/);
  assert.match(PANEL, /onclick="galKgAbrir\(\)">\+ Cargar kilos<\/button>/);
});

test('LOS DESPLEGABLES SE ARMAN EN UN SOLO LUGAR', () => {
  // Estaban escritos adentro de galKgAbrir. Con la segunda ventana serían dos
  // copias, y la de abajo se quedaría sin el agrupado por finca el día que
  // alguien toque una sola.
  assert.match(PANEL, /function galKgLlenarLote\(sel\)\{/);
  assert.match(PANEL, /function galKgLlenarCuad\(cu\)\{/);
  assert.equal((PANEL.match(/── ' \+ galKgEsc\(g\.f\) \+ ' ──/g) || []).length, 1,
    'el agrupado por finca está escrito más de una vez');
  for (const v of ['gal-kg-lote', 'gal-rap-lote']) {
    assert.ok(PANEL.includes("getElementById('" + v + "');\r\n  galKgLlenarLote(sel);")
      || PANEL.includes("getElementById('" + v + "');\r\n  galKgLlenarLote(sel);\r\n"),
      v + ' no usa el armador común');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 8 · 📦 UNA PESADA ES UN CAJÓN (V1111)
// ══════════════════════════════════════════════════════════════════════════
// Andy, 31/10/2026: «siempre trabado en 1 cajón, porque vas cargando siempre
// de a uno».
test('MANUAL KG: «no hay casillero de IFCOs y cada Enter cuenta uno»', () => {
  diceKg(/una pesada <b>es<\/b> un cajón/);
  // El uno lo pone la pantalla, no el operador: no hay casillero que llenar.
  assert.ok(!/grp-ifcos/.test(PANEL), 'quedó el casillero de IFCOs en la carga rápida');
  assert.match(JS_RAP, /ifcos: 1,/);
});

test('MANUAL KG: «un campo que hay que llenar con 1 cada vez se deja vacío»', () => {
  // Y entonces los kilos entran sin su cajón. No es sólo un casillero de menos:
  // sin el cajón no hay promedio por cajón, que es el número con el que se ve
  // una pesada mal tipeada.
  diceKg(/se deja vacío a la tercera/);
  diceKg(/el que está al '\s*\+\s*'doble salta solo|doble salta solo/);
  assert.match(JS_RAP, /kg por cajón/);
  assert.match(JS_RAP, /galKgNum\(kilos \/ cajones\)/);
});

test('la cuenta de la tanda habla de CAJONES y sale de lo cargado', () => {
  // De la suma de los ifcos y no de la cantidad de renglones: si mañana una
  // carga trae dos, la cuenta sigue estando bien sin tocar nada.
  const pin = JS_RAP.slice(JS_RAP.indexOf('function galRapPintar('),
                           JS_RAP.indexOf('async function galRapDeshacer('));
  assert.match(pin, /cajones \+= Number\(x\.ifcos\) \|\| 0;/);
  assert.match(pin, /cajones === 1 \? ' cajón' : ' cajones'/);
  assert.ok(!/GRP\.tanda\.length \+ \(GRP\.tanda\.length === 1 \? ' cajón'/.test(pin),
    'cuenta renglones en vez de cajones');
});

test('MANUAL KG: «varios cajones en una pesada van por la ventana larga»', () => {
  // La excepción tiene que tener adónde ir, o el operador la resuelve poniendo
  // 1 y el promedio miente para arriba sin que nada avise.
  diceKg(/varios cajones en una sola pesada/);
  diceKg(/el promedio mienta para arriba/);
  // Y la ventana larga efectivamente lo pregunta.
  assert.match(PANEL, /<input type="number" id="gal-kg-ifcos"/);
  // La rápida lo dice en pantalla, no sólo en el manual: nadie abre el manual
  // en el medio de una tanda.
  assert.match(MOD_RAP, /Si entraron varios juntos en una sola pesada/);
});

test('EL ENCABEZADO NO DICE «Damasco · Damasco»', () => {
  // Un lote que se llama como lo que produce salía repetido, y un cartel que
  // parece roto hace dudar del resto de lo que dice — que es justamente lo
  // único que separa la tanda bien atribuida de la mal atribuida.
  assert.match(JS_RAP, /f\.producto && f\.producto !== lote/);
  assert.match(JS_RAP, /p\.push\('1 cajón por carga'\);/,
    'el cartel fijo no dice la regla de esta ventana');
});
