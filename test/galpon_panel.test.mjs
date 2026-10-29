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

test('MANUAL LD: «el primero se propone a las 00:00, el cambio necesita su hora»', () => {
  diceLd(/por eso el primero se propone a las <b>00:00<\/b>/);
  // Lo decide el SERVIDOR mirando si el día ya tiene tramos: si lo decidiera la
  // pantalla, el que llama por fuera del panel dejaría la mañana sin cubrir.
  assert.match(RUTA, /const hora = hhmm\(b\.desde_hora\) \|\| \(hayTramos \? null : '00:00'\);/);
  assert.match(RUTA, /Un cambio de lote necesita su hora/);
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

test('MANUAL LD: «el hueco de la mañana se avisa, y el arreglo viene en un botón»', () => {
  diceLd(/El error más fácil de cometer/);
  diceLd(/Que arranque a las 00:00/);
  assert.match(SERV, /export function huecoDelDia\(/);
  // Y no se reporta hueco en un día que arranca a las 00:00, que no tiene ninguno.
  assert.match(SERV, /if \(!primero \|\| primero\.desde_hora === '00:00'\) return null;/);
  // El botón existe y hace el PATCH, no manda a corregirlo a otro lado.
  assert.match(JS_LD, /onclick="galLdDesde00\(/);
  assert.match(JS_LD, /body: JSON\.stringify\(\{ desde_hora:'00:00' \}\)/);
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
