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

// Un bloque de JS del panel: desde su marcador hasta el próximo banner /* ═══ , que es
// como están separados los módulos en panel.html. Cortar "hasta el final del archivo"
// se traga el bloque de abajo, y entonces un assert de 'esto NO aparece' mira código
// ajeno y pasa sin avisar.
function bloqueJs(marcador) {
  const i = PANEL.indexOf(marcador);
  assert.ok(i > 0, 'no encontré el bloque ' + marcador);
  const cortes = [PANEL.indexOf('\r\n/* ═══', i), PANEL.indexOf('</script>', i)]
    .filter((x) => x > 0);
  assert.ok(cortes.length, 'el bloque ' + marcador + ' no termina en ningún lado');
  return PANEL.slice(i, Math.min(...cortes));
}

// Lo mismo para un trozo de HTML: hasta el próximo <div de primer nivel.
function bloqueHtml(marcador) {
  const i = PANEL.indexOf(marcador);
  assert.ok(i > 0, 'no encontré el markup ' + marcador);
  const fin = PANEL.indexOf('\r\n  <div class=', i);
  return PANEL.slice(i, fin > 0 ? fin : undefined);
}

// Y el cuerpo de una función del servicio, hasta su llave de cierre en la columna 0.
// Para los asserts de "esto NO está": el código suele EXPLICAR por qué no hace algo, y
// entonces la explicación dispara el assert. Se miran las líneas sin sus comentarios.
function sinComentarios(txt) {
  // Sin ancla de fin de línea: en JS el punto no matchea el retorno de carro, y en
  // este repo toda línea termina en uno. Con el ancla puesta, el reemplazo no
  // matcheaba nada y el helper devolvía el texto con sus comentarios intactos — o
  // sea, no hacía nada, y el assert que depende de él pasaba por la razón equivocada.
  return String(txt).split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
}

function cuerpoServicio(firma) {
  const i = SERV.indexOf(firma);
  assert.ok(i > 0, 'no encontré ' + firma);
  return SERV.slice(i, SERV.indexOf('\r\n}', i));
}
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

test('NINGÚN MÓDULO REPITE «GALPÓN» EN SU NOMBRE', () => {
  // Andy, 1/11/2026: «todos los módulos se llaman "Galpón:". Sacar el galpón, es
  // redundante». Los cinco cuelgan del grupo GALPÓN, y repetirlo se come la mitad
  // del ancho del renglón.
  for (const { modulo, label } of MODULOS) {
    assert.ok(!/galp[óo]n/i.test(label),
      modulo + ' repite «Galpón» en su nombre: ' + label);
  }
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
    // Puede llamar a MÁS DE UNA: la configuración abre su pantalla y además carga el
    // catálogo de presentaciones. Se verifican todas, no la primera.
    const d = new RegExp("'" + modulo + "': function\\(\\)\\{ ([^}]*)\\}").exec(PANEL);
    assert.ok(d, 'falta la línea del dispatcher de ' + modulo);
    const llamadas = [...d[1].matchAll(/(\w+)\(\);/g)].map((m) => m[1]);
    assert.ok(llamadas.length, 'el dispatcher de ' + modulo + ' no llama a nada');
    for (const fn of llamadas) {
      assert.ok(PANEL.includes('function ' + fn + '('),
        'el dispatcher de ' + modulo + ' llama a ' + fn + '(), que no está definida');
    }
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
  // Cada entrada lleva el V### de CUANDO SALIÓ, así que un manual que se mantuvo
  // tiene varios números: eso es lo correcto, no un problema. Lo que no puede haber es
  // una versión del FUTURO — ahí alguien copió un número en vez de poner el suyo.
  const actual = parseInt((/const VERSION = 'V(\d+)';/.exec(leer('src/sidebar-v2.js')) || [, 0])[1], 10);
  for (const [nombre, texto] of [['config', MANUAL], ['lote del día', MANUAL_LD]]) {
    for (const m of texto.matchAll(/<span class="ver">V(\d+)<\/span>/g)) {
      assert.ok(parseInt(m[1], 10) <= actual,
        nombre + ': el manual dice V' + m[1] + ' y el panel va en V' + actual);
    }
  }
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
  return bloqueJs('var GKG =');
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
  // Acotado a las cuatro rutas de kilos: más abajo viven las del catálogo de
  // presentaciones, que SÍ piden admin con todo derecho.
  const iKg = RUTA.indexOf("router.get('/volcados'");
  const kg = RUTA.slice(iKg, RUTA.indexOf('// ── CUÁNTO LLEVAMOS', iKg));
  assert.ok(kg.length > 500 && kg.includes("router.delete('/volcados/:id'"),
    'el corte de las rutas de kilos quedó mal: mide ' + kg.length);
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
const JS_AC = bloqueJs('var GAC = {');
const ACUM = cuerpoServicio('export function acumulado(');

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
  assert.match(PREFIJOS, /\['galpon-acumulado', 'galpon\/acumulado,galpon\/resumen'\]/);
});

test('EL MANUAL DE LA CARGA MANDA ACÁ PARA EL TOTAL', () => {
  // Si no lo dijera, el operador sumaría los días a mano — que es exactamente
  // lo que había antes de esta pantalla.
  const kg = manualDe('galpon-carga');
  // El ítem se llamaba «Galpón · Acumulado» y desde la V1121 es «📈 Acumulado»: Andy,
  // 1/11/2026, «sacar el galpón, es redundante». El assert sigue al nombre REAL del
  // ítem, porque lo que importa es que el manual mande a un lugar que se pueda buscar
  // en el menú — no que diga una frase.
  assert.match(kg, /📈 Acumulado/,
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
const JS_RAP = bloqueJs('var GRP = {');
const MOD_RAP = bloqueHtml('id="gal-rap-modal"');
test('los cortes del panel no quedaron ni vacíos ni de más', () => {
  // Vacío hace que TODOS los asserts de abajo miren la nada y pasen. DE MÁS es peor:
  // pasan igual, pero mirando el bloque del vecino.
  assert.ok(JS_RAP.length > 2000, 'JS_RAP mide ' + JS_RAP.length);
  assert.ok(MOD_RAP.length > 1000, 'MOD_RAP mide ' + MOD_RAP.length);
  assert.ok(!JS_RAP.includes('var GAC'), 'JS_RAP se comió el acumulado');
  assert.ok(!JS_RAP.includes('var GPR = {'), 'JS_RAP se comió el proceso');
  assert.ok(!JS_RAP.includes('var GPRES'), 'JS_RAP se comió el catálogo');
  // Y que los cortes lleguen hasta el FINAL de su bloque. Un banner nuevo en el medio
  // lo parte al medio, y los asserts de la segunda mitad pasan a mirar la nada — sin
  // que el corte quede vacío, que es lo único que este centinela miraba antes.
  assert.ok(JS_PR.includes('function galPrPintarStock('),
    'JS_PR se corta antes del final del bloque de proceso');
  assert.ok(JS_AC.includes('function galAcPintar('),
    'JS_AC se corta antes del final del bloque del acumulado');
  assert.ok(!JS_AC.includes('var GPR = {'), 'JS_AC se comió el proceso');
  assert.ok(JS_AC.length < 30000, 'JS_AC se pasó de largo: ' + JS_AC.length);
  assert.ok(!JS_KG.includes('var GRP'), 'JS_KG se comió la carga rápida');
  assert.ok(!MOD_RAP.includes('gal-pres-modal'), 'MOD_RAP se comió la ventana de al lado');
  assert.ok(!ACUM.includes('registrarProceso'), 'ACUM se comió el servicio de proceso');
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

// ══════════════════════════════════════════════════════════════════════════
// 9 · 📦 EL PROCESO, CONTRA EL CÓDIGO (V1112)
// ══════════════════════════════════════════════════════════════════════════
// Andy, 31/10/2026: «quiero un lugar para cargar el proceso... hacé algo medio
// interactivo. Tipo un juego». Las cuentas están en
// test/galpon_proceso.test.mjs; acá se clava lo que el MANUAL promete.
const MANUAL_PR = manualDe('galpon-proceso');
const dicePr = lector(MANUAL_PR);
const JS_PR = bloqueJs('var GPR = {');
const JS_CAT = bloqueJs('var GPRES = {');
const SEC_PR = bloqueHtml('id="sec-galpon-proceso"');

test('MANUAL PR: «se elige entre los lotes VOLCADOS, no entre todos»', () => {
  dicePr(/Se elige entre los lotes <b>volcados<\/b>/);
  dicePr(/sólo '\s*\+\s*'puede salir lo que entró|puede salir lo que entró/);
  // La lista sale de gal_volcados, no de pa_lotes.
  const lv = cuerpoServicio('export function lotesVolcados(');
  assert.match(lv, /FROM gal_volcados WHERE eliminado_en IS NULL/);
  assert.match(lv, /sin_procesar: round2\(v\.volcado - procesado\)/);
  assert.match(JS_PR, /GPR\.datos && GPR\.datos\.lotes/);
});

test('MANUAL PR: «el lote es una declaración, no una traza»', () => {
  dicePr(/no existe forma física de decir/);
  dicePr(/el rinde puede dar más de 100%/);
  // Y por eso «de más» se calcula y se muestra, en vez de recortarse en cero.
  const tab = cuerpoServicio('export function tableroProceso(');
  assert.match(tab, /de_mas: procesado > volcado,/);
  // Sin los comentarios: el propio código EXPLICA por qué no hace Math.max(0, …), y
  // un assert que mira el texto crudo se dispara con la explicación.
  assert.ok(!/Math\.max\(0/.test(sinComentarios(tab)),
    'se recorta el sobrante en cero: tapa el único aviso');
  assert.match(JS_PR, /t\.de_mas \?/);
});

test('MANUAL PR: «son tres y son fijas, no un campo de texto»', () => {
  dicePr(/Son tres y son fijas/);
  assert.match(SERV, /export const DESTINOS = \[/);
  assert.match(SERV, /const esDestino = \(v\) => DESTINOS\.some/);
  // El destino de una carga sale de la presentación, no del cuerpo del pedido.
  const reg = cuerpoServicio('export function registrarProceso(');
  assert.match(reg, /const destino = pres \? pres\.destino : dd\.destino;/);
  assert.match(reg, /if \(!esDestino\(destino\)\)/);
});

test('MANUAL PR: «cada presentación es una baldosa que ya sabe su cuenta»', () => {
  dicePr(/sabe que son 7 kg por caja/);
  dicePr(/se escribe <b>100<\/b> y/);
  assert.match(JS_PR, /function galPrBaldosa\(p, d\)\{/);
  // Los saltos y el ± están, que es lo que la hace cargable de pie.
  assert.match(JS_PR, /\[1, 5, 10, 25\]/);
  assert.match(JS_PR, /function galPrMas\(n\)\{/);
  assert.match(JS_PR, /if \(ev\.key === 'Enter'\)\{ ev\.preventDefault\(\); galPrCargarUno\(\); \}/);
});

test('LOS BOTONES NO REDIBUJAN LA ZONA', () => {
  // Un redibujado por cada +5 le saca el foco al casillero y borra lo que se
  // venía escribiendo. Se toca el input a mano y se actualiza sólo el previo.
  const mas = JS_PR.slice(JS_PR.indexOf('function galPrMas(n){'),
                          JS_PR.indexOf('function galPrPresSel('));
  assert.ok(!/galPrPintarZonas\(\)/.test(mas), 'el ± vuelve a dibujar la zona');
  assert.match(mas, /galPrPrevio\(\);/);
  assert.match(mas, /c\.focus\(\);/);
});

test('MANUAL PR: «el número grande es un espejo, no la fuente»', () => {
  dicePr(/el rinde de la temporada dependería del navegador/);
  // La pantalla previsualiza, el servidor calcula. Lo que viaja son los bultos.
  const car = JS_PR.slice(JS_PR.indexOf('async function galPrCargarUno('),
                          JS_PR.indexOf('function galPrPintar('));
  assert.ok(!/kilos: *\w+ *\* *\w+/.test(car), 'la pantalla manda los kilos calculados');
  assert.match(car, /body\.bultos = c \? c\.value : '';/);
  assert.match(SERV, /export function kilosDeProceso\(bultos, porBulto, kgUnidad\)/);
  const reg = cuerpoServicio('export function registrarProceso(');
  assert.match(reg, /kg = kilosDeProceso\(bultos, porBulto, kgUnidad\);/);
});

test('MANUAL PR: «a granel se escriben los kilos y no hay cuenta»', () => {
  dicePr(/se pesan enteras y se escriben los kilos/);
  assert.match(JS_PR, /if \(p\.granel\) body\.kilos = c \? c\.value : '';/);
  const reg = cuerpoServicio('export function registrarProceso(');
  assert.match(reg, /if \(pres && !pres\.granel\) \{/);
});

test('MANUAL PR: «el volcado del lote no se corta por día»', () => {
  dicePr(/no se corta por día/);
  // Si lo cortara, lo que entró el martes y se procesa el jueves daría «de más»
  // todos los días.
  const tab = cuerpoServicio('export function tableroProceso(');
  assert.match(tab, /FROM gal_volcados'[\s\S]{0,80}WHERE lote_id IN \('/,
    'el tablero dejó de sumar el volcado de los lotes elegidos');
  assert.ok(!/gal_volcados[\s\S]{0,200}fecha = \?/.test(tab), 'el tablero corta el volcado por día');
});

test('MANUAL PR: «el stock no es una tabla aparte»', () => {
  dicePr(/No es una tabla aparte/);
  dicePr(/corregir una carga de la semana pasada lo arregla solo/);
  const st = cuerpoServicio('export function stockGalpon(');
  assert.match(st, /FROM gal_procesos WHERE eliminado_en IS NULL/);
  assert.ok(!/gal_stock|gal_saldos/.test(SERV + DDL), 'apareció una tabla de saldos');
  // Y las salidas ya restan, para el día que existan.
  assert.match(st, /CASE WHEN tipo = 'ingreso' THEN kilos ELSE -kilos END/);
});

test('MANUAL PR: «el cero de más tiene forma de gramos»', () => {
  dicePr(/700\.000 kg/);
  dicePr(/marca y deja entrar/);
  assert.match(DDL, /\['kg_max_proceso', '50000'\]/);
  const reg = cuerpoServicio('export function registrarProceso(');
  assert.match(reg, /estado = 'a_revisar';/);
  // NO rechaza: después de marcar sigue y escribe.
  const iMarca = reg.indexOf("estado = 'a_revisar'");
  const iInsert = reg.indexOf('INSERT OR IGNORE INTO gal_procesos');
  assert.ok(iInsert > iMarca, 'el techo corta la carga en vez de marcarla');
});

test('MANUAL CFG: «la unidad se pregunta» y el previo la muestra', () => {
  const cfg = manualDe('galpon-config');
  assert.match(cfg, /Por qué la unidad se pregunta/);
  assert.match(cfg, /700\.000 kg/);
  assert.match(PANEL, /<select id="gal-pres-uni" onchange="galPresPrevio\(\)">/);
  assert.match(PANEL, /<option value="g">gramos<\/option>/);
  // El previo muestra una caja Y cien: 700.000 no pasa desapercibido.
  assert.match(PANEL, /100 bultos = <b>' \+ galKgNum\(pb \* kg \* 100\)/);
  // Y adentro se guarda siempre en kilos.
  assert.match(PANEL, /=== 'g' \? pe \/ 1000 : pe/);
});

test('LA CONVERSIÓN DE GRAMOS ESTÁ EN EL GUARDADO, no sólo en el previo', () => {
  // Si estuviera sólo en el previo, la pantalla mostraría «700 kg» —correcto— y la base
  // guardaría 700 kg por cubeta. Es el peor caso: el número que se mira está bien y el
  // que se guarda está mil veces mal.
  const guardar = JS_CAT.slice(JS_CAT.indexOf('async function galPresGuardar('),
                               JS_CAT.indexOf('async function galPresBorrar('));
  assert.ok(guardar.length > 300, 'el corte de galPresGuardar quedó vacío');
  assert.match(guardar, /=== 'g' \? pe \/ 1000 : pe/,
    'el guardado no convierte los gramos a kilos');
  assert.match(guardar, /kg_unidad: granel \? 1 : kg,/);

  // Y el previo la tiene por su cuenta, que es lo que deja ver el error antes de guardar.
  const previo = JS_CAT.slice(JS_CAT.indexOf('function galPresPrevio('),
                              JS_CAT.indexOf('async function galPresGuardar('));
  assert.match(previo, /=== 'g' \? pe \/ 1000 : pe/);
});

test('MANUAL CFG: «sacarla del catálogo no toca lo ya cargado»', () => {
  const cfg = manualDe('galpon-config');
  assert.match(cfg, /no toca lo ya cargado/);
  // Porque el proceso guarda el NOMBRE además del id.
  assert.match(DDL, /presentacion {4}TEXT,/);
  const reg = cuerpoServicio('export function registrarProceso(');
  assert.match(reg, /pres \? pres\.nombre : null/);
  // Y el borrado del catálogo es blando.
  assert.match(SERV, /export function borrarPresentacion[\s\S]{0,300}eliminado_en = datetime/);
});

test('MANUAL AC: «el rinde es lo comercial sobre lo volcado»', () => {
  const ac = manualDe('galpon-acumulado');
  assert.match(ac, /es lo comercial sobre lo volcado/);
  assert.match(ac, /promediar porcentajes le da el mismo peso/);
  const ri = cuerpoServicio('export function rindePorLote(');
  assert.match(ri, /rinde: m\.volcado > 0 \? Math\.round\(\(m\.comercial \/ m\.volcado\)/);
  // El total de la tabla se calcula sobre el total, no promediando rindes.
  assert.match(JS_AC, /rinde: tot\.volcado > 0 \? Math\.round\(\(tot\.comercial \/ tot\.volcado\)/);
  assert.ok(!/rinde[\s\S]{0,80}\/ fs\.length/.test(JS_AC), 'promedia los rindes de cada lote');
});

test('EL RINDE VIAJA CON EL ACUMULADO, no en otro pedido', () => {
  assert.match(ACUM, /rinde: rindePorLote\(db, d, h\),/);
  assert.match(JS_AC, /GAC\.datos && GAC\.datos\.rinde/);
  assert.match(JS_AC, /galAcPintarRinde\(\);/);
});

test('la pantalla de proceso tampoco se arrastra de costado', () => {
  assert.match(PANEL, /#sec-galpon-proceso \.ab-table-wrap\{overflow-x:hidden !important\}/);
  assert.match(PANEL, /#sec-galpon-proceso \.gpr-tbl\{table-layout:fixed/);
  assert.match(PANEL, /#sec-galpon-acumulado \.gac-rtbl\{table-layout:fixed/);
});

test('LA PANTALLA DE PROCESO ES UNA LISTA: no abre ninguna ventana', () => {
  // La regla de CLAUDE.md es que un formulario de carga va en una ventana. Acá
  // la carga ES la pantalla —baldosa, número, Enter— y meterla en una ventana
  // sería tapar el tablero justo mientras se carga contra él.
  assert.ok(!/ab-modal-overlay/.test(SEC_PR), 'la pantalla de proceso tiene una ventana adentro');
  // La que SÍ es un formulario —definir una presentación— vive en una ventana,
  // y fuera de toda .sec.
  assert.match(PANEL, /<div class="ab-modal-overlay sg-mod" id="gal-pres-modal">/);
});

test('el catálogo se carga al abrir Configuración, o la tabla sale vacía', () => {
  assert.match(PANEL,
    /'galpon-config': function\(\)\{ galInit\(\); galPresCargar\(\); galLdtCargar\(\); \}/);
});

// ══════════════════════════════════════════════════════════════════════════
// 10 · LA FINCA, QUE ES COMO SE UBICA UN LOTE (V1113)
// ══════════════════════════════════════════════════════════════════════════
test('MANUAL PR: «arriba de cada tarjeta va la finca, y abajo el lote»', () => {
  dicePr(/la gente lo ubica por el + 'nombre de la finca|nombre de la finca/);
  dicePr(/El lote sigue abajo porque una finca tiene varios/);
  assert.match(JS_PR, /galPrEsc\(l\.finca \|\| 'Sin finca'\)/);
  // El lote NO se va: sin él, dos tarjetas de la misma finca serían iguales.
  assert.match(JS_PR, /<div class="dl">' \+ galPrEsc\(l\.nombre\)/);
  assert.match(PANEL, /#sec-galpon-proceso \.gpr-lote \.dl\{/);
});

test('MANUAL PR: «la finca se lee cada vez, el nombre del lote queda congelado»', () => {
  dicePr(/si se renombra, cambia en todos lados/);
  // Se lee de pa_lotes con un JOIN; no hay columna finca en gal_volcados ni en
  // gal_procesos, que es lo que haría que quedara vieja.
  assert.match(SERV, /export function fincasDeLotes\(db\)/);
  assert.match(SERV, /SELECT id, finca FROM pa_lotes/);
  assert.ok(!/finca\s+TEXT/.test(DDL), 'se denormalizó la finca en una tabla gal_');
  // Y sin FK hacia pa_*, que es la regla de CLAUDE.md.
  assert.ok(!/REFERENCES pa_/.test(DDL), 'apareció una FK cruzada hacia Personal/Producción');
});

test('la finca aparece también en el rinde y en los dos cortes por lote', () => {
  // Es la misma queja en tres pantallas: «11-12 y 16-17» suelto no ubica a nadie.
  assert.match(JS_AC, /f\.finca \? '<b>' \+ galAcEsc\(f\.finca\)/);
  assert.match(JS_AC, /\[x\.finca, x\.producto\]\.filter\(Boolean\)/);
  assert.match(JS_KG, /x\.finca \? x\.finca \+ ' · ' \+ x\.nombre : x\.nombre/);
  // El renglón de totales del rinde no tiene finca, y una vacía le dejaría un « · ».
  assert.match(JS_AC, /nombre:'TODOS LOS LOTES', finca:null/);
});

test('el servicio devuelve la finca en los cuatro lugares que la muestran', () => {
  assert.match(cuerpoServicio('export function lotesVolcados('), /finca: fincas\.get/);
  assert.match(cuerpoServicio('export function rindePorLote('), /finca: fincas\.get/);
  assert.match(ACUM, /finca: fincas\.get\(l\.gid\)/);
  assert.match(cuerpoServicio('export function resumenDelDia('), /finca: fincas\.get/);
});

// ══════════════════════════════════════════════════════════════════════════
// 11 · ⚖️ LA BALANZA, CONTRA EL CÓDIGO (V1114)
// ══════════════════════════════════════════════════════════════════════════
// El parser se ejecuta de verdad en test/galpon_balanza.test.mjs. Acá se clava
// lo que el MANUAL promete sobre cómo se comporta la pantalla.
const JS_BAL = bloqueJs('var GBAL = {');
const MOD_BAL = bloqueHtml('id="gal-bal-modal"');

test('el archivo de la balanza se sirve y la pantalla lo carga', () => {
  // Vive en la RAÍZ de src: estaticos_publicos.js prohíbe las subcarpetas, así
  // que un balanza.js adentro de servicios/ daría 404 y la pantalla fallaría
  // recién al abrirla.
  assert.ok(fs.existsSync(path.join(RAIZ, 'src/balanza.js')));
  assert.ok(!fs.existsSync(path.join(RAIZ, 'src/servicios/balanza.js')),
    'está en una subcarpeta: /static no la sirve');
  assert.match(PANEL, /<script src="\/static\/balanza\.js" defer><\/script>/);
});

test('MANUAL KG: «la balanza rellena, no carga»', () => {
  diceKg(/La balanza rellena, no carga/);
  diceKg(/cada vez que alguien se apoya en la plataforma/);
  // Y es cierto: la lectura escribe el casillero y NO dispara ninguna carga.
  const lec = JS_BAL.slice(JS_BAL.indexOf('function galBalLectura('),
                           JS_BAL.indexOf('function galBalAbrir('));
  assert.ok(lec.length > 200, 'el corte de galBalLectura quedó vacío');
  assert.ok(!/galRapCargar|galKgGuardar|galPrCargarUno/.test(sinComentarios(lec)),
    'la balanza carga sola: un peso estable crea un renglón sin que nadie lo vea');
  // Y lo escribe CON COMA: con punto, un peso de tres decimales —«12.345»— lo lee el
  // servidor como el separador de miles, o sea doce mil trescientos cuarenta y cinco.
  assert.match(lec, /c\.value = String\(l\.kilos\)\.replace\('\.', ','\);/);
});

test('MANUAL KG: «se escribe cuando está firme y cuando cambió»', () => {
  diceKg(/cuando está firme y cuando cambió/);
  const lec = JS_BAL.slice(JS_BAL.indexOf('function galBalLectura('),
                           JS_BAL.indexOf('function galBalAbrir('));
  // Inestable no escribe...
  assert.match(lec, /if \(!l \|\| l\.estable === false\) return;/);
  // ...pero «no dice si está estable» SÍ, que es otra cosa.
  assert.ok(!/l\.estable !== true/.test(lec),
    'trata «no dice» como inestable: una balanza que no manda el estado no cargaría nunca');
  // Y no se vuelve a escribir el mismo peso, o pisaría una corrección a mano.
  assert.match(lec, /Math\.abs\(l\.kilos - GBAL\.ultimo\) < 0\.02/);
});

test('MANUAL KG: «un peso de menos de 1 kg se ignora»', () => {
  // Al levantar el cajón la balanza vuelve a cero, y sin esto el casillero se
  // vacía justo antes del Enter.
  diceKg(/vuelve a cero, y sin eso el casillero se vaciaría/);
  assert.match(JS_BAL, /var GBAL_MIN = 1;/);
  assert.match(JS_BAL, /if \(Math\.abs\(l\.kilos\) < GBAL_MIN\) return;/);
});

test('LA BALANZA SUELTA EL CASILLERO AL CERRAR LA VENTANA', () => {
  // Si no, seguiría escribiendo en un campo que ya nadie ve, y el peso del
  // cajón siguiente entraría en una ventana cerrada.
  for (const fn of ['galRapCerrar', 'galKgCerrar']) {
    const c = PANEL.slice(PANEL.indexOf('function ' + fn + '('),
                          PANEL.indexOf('function ' + fn + '(') + 420);
    assert.match(c, /galBalApuntar\(null, null\)/, fn + ' no suelta el casillero');
  }
  // Y lo toma al abrir cada una, apuntando a SU campo.
  assert.match(PANEL, /galBalApuntar\('grp-kilos', 'gal-bal-chip-rap'\)/);
  assert.match(PANEL, /galBalApuntar\('gal-kg-kilos', 'gal-bal-chip-kg'\)/);
});

test('MANUAL KG: «cada carga guarda de dónde salió el peso»', () => {
  diceKg(/de dónde salió el peso/);
  diceKg(/la balanza está rota y nadie '\s*\+\s*'avisó|balanza está rota/);
  // Viaja en las dos ventanas...
  assert.equal((PANEL.match(/origen: GBAL\.usada \? 'balanza' : 'manual',/g) || []).length, 2);
  // ...y el servidor no se cree cualquier cosa: es una lista, no texto libre.
  assert.match(SERV, /export const ORIGENES = \['manual', 'balanza', 'escaneo'\];/);
  assert.match(SERV, /origenDe\(dd\.origen\)/);
  // Y lo que no está en la lista entra como manual, no se rechaza: acá nada se
  // rechaza después del hecho.
  assert.match(SERV, /ORIGENES\.indexOf\(String\(v \|\| ''\)\) >= 0 \? String\(v\) : 'manual'/);
});

test('EL PESO DE LA BALANZA SE SUELTA DESPUÉS DE CARGAR', () => {
  // Si no, una corrección a mano del cajón siguiente quedaría firmada como
  // pesada por la balanza.
  assert.equal((PANEL.match(/GBAL\.usada = false;/g) || []).length, 3,
    'falta soltar GBAL.usada en alguna de las dos ventanas, o al apuntar');
});

test('MANUAL KG: «tarala vos, el sistema no le resta nada»', () => {
  // Tarar por software encima de la tecla TARA del indicador serían dos kilos
  // menos por cajón: una tonelada cada quinientos, sin que nada avise.
  diceKg(/Tarala vos, con un IFCO vacío/);
  diceKg(/una tonelada cada quinientos/);
  assert.ok(!/tara_ifco/.test(sinComentarios(JS_BAL)),
    'la pantalla le resta la tara al peso de la balanza');
  // Y el seed dejó de decir que se resta, que es lo que decía y ya no es cierto.
  assert.match(DDL, /HOY NO SE LE RESTA A NADA/);
});

test('MANUAL: «hace falta Chrome o Edge de escritorio», y la pantalla lo dice', () => {
  diceKg(/Hace falta Chrome o Edge de escritorio/);
  const cfg = manualDe('galpon-config');
  assert.match(cfg, /Chrome o Edge de escritorio/);
  // Y no sólo en el manual: el probador lo explica cuando no se puede.
  assert.match(JS_BAL, /Web Serial '\s*\r?\n?\s*\+ 'existe sólo en|Web Serial/);
  assert.match(JS_BAL, /no está, y no hay forma de habilitarlo/);
});

test('SIN WEB SERIAL NO SE OFRECE NADA', () => {
  // Un botón que no puede funcionar es peor que no tenerlo: el operador lo
  // aprieta, no pasa nada, y deja de confiar en el resto de la pantalla.
  diceKg(/no aparece nada<\/b> y se carga '\s*\+\s*'a mano|no aparece nada/);
  const chip = JS_BAL.slice(JS_BAL.indexOf('function galBalChip('),
                            JS_BAL.indexOf('function galBalApuntar('));
  assert.match(chip, /if \(!galBalHay\(\)\)\{/);
  assert.match(chip, /el\.innerHTML = ''; return;/);
});

test('la ventana del probador vive fuera de toda pantalla', () => {
  assert.match(PANEL, /<div class="ab-modal-overlay sg-mod" id="gal-bal-modal">/);
  // Muestra las dos cosas: el crudo y lo interpretado. Una sola no alcanza —
  // con el texto solo no se ve dónde corta la trama ni si son los baudios.
  assert.match(MOD_BAL, /id="gal-bal-crudo"/);
  assert.match(MOD_BAL, /id="gal-bal-leido"/);
  assert.match(JS_BAL, /BAL\.hex\(bytes\)/);
  assert.match(JS_BAL, /BAL\.visible\(texto\)/);
});

test('el puerto ya autorizado se reusa, o habría que elegirlo cada mañana', () => {
  // El navegador pide un gesto sólo la primera vez: getPorts() devuelve los
  // que ya se autorizaron. Sin esto, cada recarga de la pantalla es un diálogo.
  assert.match(JS_BAL, /async function galBalReconectar\(\)/);
  assert.match(JS_BAL, /var p = await BAL\.recordado\(\);/);
  assert.match(JS_BAL, /\(await BAL\.recordado\(\)\) \|\| \(await BAL\.pedirPuerto\(\)\)/);
  assert.match(PANEL, /if \(galBalHay\(\) && !BAL\.estado\.conectada\) galBalReconectar\(\);/);
});

test('los baudios se piden UNA vez y quedan', () => {
  // La pantalla de carga no carga toda la configuración, y un pedido por cada
  // reconexión sería uno por cada vez que se abre la ventana.
  assert.match(JS_BAL, /if \(GBAL\.baudios\) return GBAL\.baudios;/);
  assert.match(JS_BAL, /balanza_baudios/);
  // Y la clave ya estaba declarada como guardable, no hace falta tocar el router.
  assert.match(RUTA, /'balanza_puerto', 'balanza_baudios'\]/);
});

// ══════════════════════════════════════════════════════════════════════════
// 12 · MEZCLAR LOTES Y CORREGIR UNA CARGA (V1115)
// ══════════════════════════════════════════════════════════════════════════
const MOD_PROC = bloqueHtml('id="gal-proc-modal"');

test('MANUAL PR: «se pueden marcar varios lotes a la vez»', () => {
  dicePr(/marcar varios lotes a la vez/);
  dicePr(/es todo Damasco/);
  // Tocar el segundo no apaga el primero: se suma o se saca de la lista.
  assert.match(JS_PR, /var i = GPR\.lotes\.indexOf\(id\);/);
  assert.match(JS_PR, /if \(i >= 0\) GPR\.lotes\.splice\(i, 1\); else GPR\.lotes\.push\(id\);/);
  assert.ok(!/GPR\.lote\b(?!s)/.test(sinComentarios(JS_PR)),
    'quedó código mirando el lote único: va a leer undefined');
  assert.match(PANEL, /onclick="galPrTodosLosLotes\(\)"/);
});

test('«todos los que están en la tolva» son los que TIENEN pendiente', () => {
  // Marcar todos los que alguna vez se volcaron metería en el reparto de hoy un
  // lote cerrado hace un mes, y esos kilos se le restarían a su rinde.
  const fn = JS_PR.slice(JS_PR.indexOf('function galPrTodosLosLotes('),
                         JS_PR.indexOf('function galPrPintarTablero('));
  assert.match(fn, /l\.sin_procesar > 0/);
});

test('MANUAL PR: «se reparte a prorrata, y se ve ANTES de cargar»', () => {
  dicePr(/reparte a prorrata de lo que le queda/);
  dicePr(/El cartel naranja lo muestra <b>antes<\/b> de cargar/);
  assert.match(JS_PR, /function galPrCartelReparto\(\)\{/);
  assert.match(JS_PR, /if \(GPR\.lotes\.length < 2\) return '';/);
  assert.match(JS_PR, /Mezcla de ' \+ ls\.length \+ ' lotes/);
  // Y el cartel usa el MISMO criterio que el servidor: lo que queda sin procesar.
  assert.match(JS_PR, /l\.sin_procesar > 0 \? l\.sin_procesar : 0/);
  assert.match(cuerpoServicio('export function pesosDelReparto('),
    /Number\(x\) > 0 \? Number\(x\) : 0/);
});

test('MANUAL PR: «una fila por lote, no una fila mezcla»', () => {
  dicePr(/una fila por lote<\/b>, no una sola «mezcla»/);
  // Por eso el rinde y el stock siguen siendo un GROUP BY lote_id sin nada especial.
  assert.match(cuerpoServicio('export function rindePorLote('), /GROUP BY lote_id/);
  assert.ok(!/reparto/.test(cuerpoServicio('export function rindePorLote(')),
    'el rinde tuvo que aprender qué es un reparto: la fila por lote no alcanzó');
});

test('MANUAL PR: «quedan marcadas ≈ mezcla»', () => {
  dicePr(/≈ mezcla/);
  dicePr(/no es el mismo dato que el de uno que entró solo/);
  assert.match(JS_PR, /x\.repartido \? ' <span class="gpr-mz"/);
  assert.match(PANEL, /#sec-galpon-proceso \.gpr-mz\{/);
  assert.match(DDL, /ADD COLUMN repartido INTEGER NOT NULL DEFAULT 0/);
});

test('MANUAL PR: «borrar una las borra a todas», y la pantalla lo avisa', () => {
  dicePr(/Borrar una las borra a todas/);
  assert.match(cuerpoServicio('export function borrarProceso('),
    /WHERE reparto = \? AND eliminado_en IS NULL/);
  // Y el confirm lo dice, que es donde se lee: nadie abre el manual para borrar.
  assert.match(JS_PR, /Es parte de una MEZCLA/);
});

test('MANUAL PR: «el lápiz deja cambiar el día, el lote, la presentación…»', () => {
  dicePr(/El lápiz de cada renglón/);
  dicePr(/no se podía hacer<\/b>/);
  assert.match(JS_PR, /onclick="galProcAbrir\(/);
  for (const id of ['gal-proc-fecha', 'gal-proc-lote', 'gal-proc-pres',
                    'gal-proc-cant', 'gal-proc-obs']) {
    assert.ok(MOD_PROC.includes('id="' + id + '"'), 'falta el campo ' + id);
  }
  assert.match(PANEL, /<div class="ab-modal-overlay sg-mod" id="gal-proc-modal">/);
});

test('cambiar la presentación en la ficha cambia QUÉ se pide', () => {
  // Dejar el casillero diciendo «Bultos» con una presentación a granel haría que
  // 55 se lea como 55 bultos — y 55 bultos de 7 kg son 385, no 55.
  assert.match(PANEL, /galProcPresPick\(\)/);
  assert.match(PANEL, /granel \? 'Kilos' : 'Bultos'/);
  assert.match(PANEL, /if \(granel\) body\.kilos = cant; else body\.bultos = cant;/);
});

test('una presentación que ya no está en el catálogo no se pierde al editar', () => {
  // Sin esto el desplegable mostraría otra, y guardar cambiaría la presentación de
  // la carga sin que nadie lo haya pedido.
  assert.match(PANEL, /fuera del catálogo/);
});

test('MANUAL PR: «en una repartida se corrige sólo ese pedazo»', () => {
  dicePr(/sólo ese pedazo<\/b>/);
  const abrir = JS_PR.slice(JS_PR.indexOf('function galProcAbrir('),
                            JS_PR.indexOf('function galProcCerrar('));
  assert.ok(abrir.length > 400, 'el corte de galProcAbrir quedó vacío');
  assert.match(abrir, /if \(x\.repartido\)\{/,
    'el aviso no depende de que la carga sea repartida: o se ve siempre, o nunca');
  assert.match(abrir, /Esta carga es parte de una mezcla/);
  assert.match(abrir, /\} else \{ rep\.style\.display = 'none'; \}/,
    'el aviso no se esconde en una carga normal');
});

test('el router acepta varios lotes y el tablero los suma', () => {
  assert.match(RUTA, /req\.query\.lote_ids \|\| req\.query\.lote_id/);
  assert.match(cuerpoServicio('export function tableroProceso('), /lote_id IN \('/);
  assert.match(JS_PR, /q\.push\('lote_ids=' \+ GPR\.lotes\.join\(','\)\)/);
  assert.match(JS_PR, /lote_ids: GPR\.lotes,/);
});

// ══════════════════════════════════════════════════════════════════════════
// 13 · LOS GRÁFICOS Y EL STOCK, CONTRA EL MANUAL (V1116)
// ══════════════════════════════════════════════════════════════════════════
// Los armadores se EJECUTAN en test/galpon_graficos.test.mjs. Acá se clava lo
// que el manual promete.
test('MANUAL AC: «son dos cuadros y no uno»', () => {
  const ac = manualDe('galpon-acumulado');
  assert.match(ac, /Por qué dos cuadros y no uno/);
  assert.match(ac, /deja elegir cuál sube y cuál baja/);
  // Y es cierto: dos contenedores, cada uno con su escala.
  assert.equal((JS_AC.match(/class="gac-plot"/g) || []).length, 2,
    'o hay un cuadro solo, o aparecieron tres');
});

test('MANUAL AC: «el rinde del día es sobre lo procesado»', () => {
  const ac = manualDe('galpon-acumulado');
  assert.match(ac, /sobre <b>lo procesado ese día<\/b>/);
  assert.match(ac, /cualquier '\s*\+\s*'jueves daría más de 100%|jueves daría más de 100%/);
  assert.match(cuerpoServicio('export function procesoPorDia('),
    /x\.comercial \/ x\.procesado/);
  assert.ok(!/x\.comercial \/ x\.volcado/.test(cuerpoServicio('export function procesoPorDia(')),
    'el rinde diario se calcula contra el volcado del mismo día');
});

test('MANUAL AC: «los días sin procesar no dibujan columna»', () => {
  const ac = manualDe('galpon-acumulado');
  assert.match(ac, /no es lo mismo que rendir '\s*\+\s*'cero|no es lo mismo que rendir cero/);
  assert.match(JS_AC, /x\.rinde == null \? ''/);
});

test('MANUAL PR: «el stock dice desde cuándo»', () => {
  dicePr(/4\.000 kg de ayer y 4\.000 kg de hace tres '\s*\+\s*'semanas|4\.000 kg de ayer/);
  assert.match(cuerpoServicio('export function stockGalpon('), /MIN\(fecha\) AS desde/);
  assert.match(JS_PR, /function galPrAntiguedad\(desde\)\{/);
  assert.match(JS_PR, /'hace ' \+ dias \+ ' días'/);
  // Y SE USA en la tarjeta: tenerla escrita y no llamarla pasaba el test igual.
  assert.match(JS_PR, /galPrEsc\(galPrAntiguedad\(d\.desde\)\)/);
  assert.match(JS_PR, /galPrAntiguedad\(x\.desde\)/);
});

test('MANUAL PR: «de qué lote es lo guardado es OTRA pregunta»', () => {
  dicePr(/No se deduce del '\s*\+\s*'de arriba|No se deduce del/);
  assert.match(SERV, /export function stockPorLote\(db\)/);
  assert.match(JS_PR, /function galPrPintarStockLote\(\)\{/);
  assert.match(RUTA, /stock_lotes: stockPorLote\(db\)/);
});

test('MANUAL PR: «hoy no sale nada, pero la tabla ya sabe restar»', () => {
  dicePr(/ya sabe restar salidas/);
  assert.match(cuerpoServicio('export function stockPorLote('),
    /CASE WHEN tipo = 'ingreso' THEN kilos ELSE -kilos END/);
  // Y se dice que cámara y playón todavía no son dos lugares distintos, en vez de
  // dejar creer que lo son.
  dicePr(/separar <b>cámara<\/b> de <b>playón<\/b>/);
});

test('el número grande del stock está arriba de todo', () => {
  // Lo que se viene a preguntar es «cuánto hay», y eso no se contesta con tres
  // tarjetas que hay que sumar de cabeza.
  assert.match(JS_PR, /bultos guardados · ' \+ galPrNum\(st\.kilos\)/);
  assert.match(PANEL, /#sec-galpon-proceso \.gpr-tot b\{font-size:34px/);
  assert.match(PANEL, /#sec-galpon-proceso \.gpr-sd \.hero\{font-size:30px/);
});

test('EL STOCK SE CUENTA EN BULTOS, no en kilos', () => {
  // Andy, 31/10/2026: «los stock van en cajas porque necesitamos saber qué cargar.
  // No me interesa ahí verlo en kilos». Es la única pantalla del galpón donde el
  // número grande no es el kilo — porque la pregunta es otra: cuántas cajas suben
  // al camión.
  dicePr(/El stock va en BULTOS, no en kilos/);
  assert.match(JS_PR, /function galPrBultos\(x\)\{/);
  assert.match(JS_PR, /\(b == null \? 'kg' : 'bultos'\)/);
  assert.match(JS_PR, /bultos guardados/);
});

test('lo que está A GRANEL no inventa un bulto', () => {
  // Inventarle «1 bulto» a un bin a granel sería un número que alguien va a usar
  // para cargar un camión.
  assert.match(JS_PR, /x && x\.bultos > 0 \? galPrNum\(x\.bultos, 0\) : null/);
  assert.match(JS_PR, /b == null \? 'a granel'/);
});

test('LA BARRA DEL STOCK SE REPARTE POR KILOS, no por bultos', () => {
  // Una caja de 7 kg y un bin de 300 ocupan lo mismo contados por bulto, y la
  // proporción saldría al revés de lo que hay. El bulto es para cargar; el kilo
  // es para comparar.
  const pin = JS_PR.slice(JS_PR.indexOf('function galPrPintarStock(){'),
                          JS_PR.indexOf('function galPrVerStockLote('));
  assert.match(pin, /d\.kilos \/ st\.kilos/);
  assert.ok(!/d\.bultos \/ \w+\.bultos/.test(sinComentarios(pin)),
    'la barra se reparte por bultos: la proporción sale al revés');
});

test('MANUAL AC: «cómo viene rindiendo la fruta» va PRIMERO y el lote PLEGADO', () => {
  // Andy, 31/10/2026: «hace mucho hincapié en cada lote; lo interesante es cómo
  // viene rindiendo en general... si me quiero meter a analizar algo del lote
  // entro y me fijo».
  const ac = manualDe('galpon-acumulado');
  assert.match(ac, /Cómo viene rindiendo la fruta/);
  assert.match(JS_AC, /function galAcPintarGeneral\(\)\{/);
  assert.match(JS_AC, /var GAC_VERLOTES = false;/,
    'el detalle por lote no arranca plegado');
  assert.match(JS_AC, /if \(!GAC_VERLOTES\)\{ el\.innerHTML = cab; return; \}/);
  // Y el titular va ANTES de los gráficos y de los cortes.
  const i = JS_AC.indexOf('galAcPintarGeneral();');
  const j = JS_AC.indexOf('galAcPintarGraficos();');
  assert.ok(i > 0 && j > i, 'el titular se pinta después de los gráficos');
});

test('el stock por lote también arranca plegado', () => {
  assert.match(JS_PR, /var GPR_VERLOTES = false;/);
  assert.match(JS_PR, /if \(!GPR_VERLOTES\)\{ el\.innerHTML = cab; return; \}/);
});

test('EL RINDE GRANDE ES SOBRE LO VOLCADO, y el reparto sobre lo procesado', () => {
  // Son dos preguntas distintas: cuánto de lo que entró del campo terminó vendible,
  // y cómo se partió lo que salió de la máquina. Un solo número para las dos sería
  // uno de los dos mal.
  const tot = cuerpoServicio('export function procesoTotal(');
  assert.match(tot, /out\[k\] \/ out\.procesado/);
  assert.match(tot, /out\.comercial \/ out\.volcado/);
  const ac = manualDe('galpon-acumulado');
  assert.match(ac, /sobre lo <b>volcado<\/b>|Rinde sobre lo volcado|sobre lo volcado/);
});

test('LOS COLORES DE LOS GRÁFICOS SON LOS MISMOS EN TODAS LAS PANTALLAS', () => {
  // Si el stock usara unos y el gráfico otros, el verde de una pantalla sería el
  // descarte de la otra — y eso no se nota hasta que alguien decide algo.
  // Las DOS veces: la barra de arriba y la tarjeta. Con un match suelto, cambiar una
  // sola dejaba media pantalla con la paleta vieja y el test en verde.
  assert.equal((JS_PR.match(/GAC_COL\[d\.clave\] \|\| d\.color/g) || []).length, 2,
    'alguna parte del stock dejó de usar la paleta común');
  assert.match(JS_PR, /tr\(.comercial.\)/);
  assert.equal((PANEL.match(/var GAC_COL = \{/g) || []).length, 1,
    'hay más de una definición de la paleta');
});

// ══════════════════════════════════════════════════════════════════════════
// 14 · EL ARTÍCULO Y LOS DATOS DEL TARJETÓN (V1119)
// ══════════════════════════════════════════════════════════════════════════
test('EL PALLET VIAJA CON LA PANTALLA DE PROCESO', () => {
  // La pantalla de proceso ES la de cierre de pallet: si no viaja, el cuadro bordó
  // queda vacío y el operador carga cajas sin ver adónde van — y la pantalla se ve
  // completa igual, con las baldosas y el stock.
  assert.ok(RUTA.includes('pallet_abierto: (function () {'),
    'el pallet abierto no viaja en la respuesta de la pantalla');
  assert.ok(RUTA.includes('pallets: pallets(db, { limite: 50 })'));
  assert.ok(JS_PR.includes('GPR.datos && GPR.datos.pallet_abierto'));
  assert.ok(JS_PR.includes('function galPrPintarPallet(){'));
  assert.ok(JS_PR.includes('galPrPintarPallet();'));
});

test('LOS DATOS DEL LOTE VIVEN EN UNA TABLA DEL GALPÓN, no en pa_lotes', () => {
  // pa_lotes la mantiene Producción. Una columna del galpón ahí la hace nuestra
  // para siempre — misma regla que las tarjetas de las cuadrillas.
  assert.match(DDL, /CREATE TABLE IF NOT EXISTS gal_lote_datos \(/);
  assert.ok(!/ALTER TABLE pa_/.test(DDL), 'el galpón le agregó una columna a Producción');
  assert.ok(!/REFERENCES pa_/.test(DDL), 'apareció una FK cruzada');
  assert.match(SERV, /export function datosDeLotes\(db\)/);
});

test('MANUAL CFG: «se congelan en cada carga»', () => {
  const cfg = manualDe('galpon-config');
  assert.match(cfg, /Se congelan en cada carga/);
  assert.match(cfg, /no cambia<\/b> las etiquetas ya emitidas/);
  const reg = cuerpoServicio('export function registrarProceso(');
  assert.match(reg, /datosLote\.get\(lotes\[i\]\) \|\| \{\}\)\.renspa/);
  assert.match(reg, /datosLote\.get\(lotes\[i\]\) \|\| \{\}\)\.variedad/);
});

test('MANUAL CFG: «la variedad se copia sin pisar el RENSPA»', () => {
  const cfg = manualDe('galpon-config');
  assert.match(cfg, /No pisa el RENSPA<\/b>/);
  assert.match(cfg, /«Castle Brite» y «Castle '\s*\+\s*'brite» son dos variedades|son dos variedades/);
  assert.match(cuerpoServicio('export function variedadATodos('),
    /renspa: ya\.renspa, cuartel: ya\.cuartel/);
});

test('MANUAL PR: «cada baldosa dice su categoría y su calibre»', () => {
  dicePr(/categoría y su calibre/);
  dicePr(/se aprieta la de al lado/);
  assert.match(JS_PR, /var art = 'CAT ' \+ \(p\.categoria \|\| 'I'\)/);
  assert.match(JS_PR, /galPrEsc\(art\)/);
});

test('el catálogo pide la categoría y el calibre', () => {
  const cfg = manualDe('galpon-config');
  assert.match(cfg, /<b>categoría<\/b> arranca en <b>I<\/b>/);
  assert.match(PANEL, /<input type="text" id="gal-pres-cat"/);
  assert.match(PANEL, /<input type="text" id="gal-pres-cal"/);
  assert.match(JS_CAT, /categoria: document\.getElementById\('gal-pres-cat'\)\.value,/);
  assert.match(JS_CAT, /calibre: document\.getElementById\('gal-pres-cal'\)\.value,/);
});

test('GUARDAR UN CAMPO DEL LOTE MANDA LOS TRES', () => {
  // El endpoint hace un upsert de la fila entera: mandar sólo el que cambió
  // borraría los otros dos, y el RENSPA es el más caro de volver a cargar.
  const js = bloqueJs('var GLDT = {');
  assert.ok(js.length > 500, 'el corte del bloque quedó vacío');
  assert.match(js,
    /var body = \{ lote_id: id, renspa: l\.renspa, variedad: l\.variedad, cuartel: l\.cuartel \};/);
  // Y no se manda nada si el campo no cambió: un guardado por cada clic afuera
  // del casillero es un guardado por cada vez que alguien pasa de largo.
  assert.match(js, /if \(\(l\[k\] \|\| ''\) === inp\.value\.trim\(\)\) return;/);
});

// ── 🚚 LA VENTANA DEL DESPACHO ────────────────────────────────────────────
// Las cuatro reglas de una ventana las audita ventanas_del_panel.test.mjs, que
// las mira TODAS. Las tres primeras —fuera de toda .sec, con sg-mod, no se
// cierra al clic afuera— salen gratis de ahí. La CUARTA no es auditable en
// general: «no se cierra al guardar si adentro queda algo que hay que leer»
// depende de qué queda adentro. Así que va acá, para esta ventana.
const JS_ST = bloqueJs('var GST = {');

test('LA VENTANA NO SE CIERRA AL EMITIR: adentro queda el número', () => {
  // Es la regla 4 de CLAUDE.md. El número del remito se emite ahí y es lo que
  // hay que leer; cerrarse solo lo tapa y no hay dónde volver a buscarlo sin
  // adivinar cuál de la lista era.
  const emitir = JS_ST.slice(JS_ST.indexOf('async function galDspEmitir()'),
                             JS_ST.indexOf('async function galDspAnular()'));
  assert.ok(emitir.length > 200, 'el corte de galDspEmitir salió vacío');
  assert.ok(!sinComentarios(emitir).includes('galDspCerrar('),
    'galDspEmitir cierra la ventana y se lleva puesto el número');
  // Y lo que queda adentro TIENE que repintarse, o la ventana muestra el
  // borrador de antes y el número no aparece en ningún lado.
  assert.match(emitir, /galDspPintar\(\)/);
});

test('el abridor DEJA LA VENTANA EN BLANCO antes de llenarla', () => {
  // Un formulario que sólo se esconde CONSERVA lo que tenía (CLAUDE.md). Acá
  // eso sería mandarle las cajas de este camión al destinatario del anterior.
  const abrir = JS_ST.slice(JS_ST.indexOf('async function galDspAbrir(id)'),
                            JS_ST.indexOf('function galDspCerrar()'));
  assert.ok(abrir.length > 200, 'el corte de galDspAbrir salió vacío');
  for (const k of ['gal-dsp-dest', 'gal-dsp-transp', 'gal-dsp-pat', 'gal-dsp-cant']) {
    assert.ok(abrir.includes(k), 'el abridor no limpia ' + k);
  }
  assert.match(abrir, /GST\.abierto = null/);
});

test('EL SELECTOR DE QUÉ CARGAR SALE DEL STOCK, no de un catálogo', () => {
  // Si saliera del catálogo de presentaciones se podría elegir un artículo que
  // no tiene una sola caja, y el error aparecería recién al apretar Agregar.
  assert.match(JS_ST, /GST\.disp\b/);
  const pintar = JS_ST.slice(JS_ST.indexOf('function galDspPintar()'),
                             JS_ST.indexOf('function galDspItemPick()'));
  assert.match(pintar, /\(GST\.disp\|\|\[\]\)\.map/,
    'el selector no se arma con el disponible');
});

test('el stock se muestra EN CAJAS, con los kilos al lado', () => {
  // Andy, 31/10/2026: «los stock van en cajas porque necesitamos saber qué
  // cargar. No me interesa ahí verlo en kilos».
  const html = bloqueHtml('<div class="sec sg-mod" id="sec-galpon-stock">');
  assert.match(html, /gst-kg\{font-size:11px/, 'los kilos no están en chico');
  assert.match(JS_ST, /<th style="text-align:right">Cajas<\/th>/);
  // Y el total general sí va en kilos: sumar cajas de 8 kg con bines de 400
  // daría un número que no significa nada físico.
  assert.match(JS_ST, /kg en cámara/);
});

test('EL MANUAL DEL STOCK dice que no se despacha más de lo que hay', () => {
  const m = manualDe('galpon-stock');
  assert.match(m, /V1121/, 'el manual no lleva su número de versión');
  assert.match(m, /única validación del galpón que frena/);
  // Y la vuelta del circuito, que es lo que Andy preguntó.
  assert.match(m, /procesa/);
  assert.match(m, /se <b>anula<\/b>, nunca se borra/);
});

test('LOS ATAJOS DE DIBUJITO SE PINTAN, y el mismo de nuevo lo saca', () => {
  // Se EJECUTA el armado contra un DOM de mentira: un audit de texto ve la
  // lista GAL_EMOS declarada y no sabe si alguien la pinta. Sin los atajos el
  // casillero queda solo y nadie se entera de que puede poner un emoji.
  const i = PANEL.indexOf('var GAL_EMOS =');
  assert.ok(i > 0, 'no encontré GAL_EMOS');
  const fin = PANEL.indexOf('function galPresCerrar(){', i);
  assert.ok(fin > i, 'el corte de los atajos salió vacío');
  const nodos = { 'gal-pres-emos': { innerHTML: '' }, 'gal-pres-emo': { value: '' } };
  const api = new Function('document',
    PANEL.slice(i, fin) + '\nreturn { galPresEmojis, galPresEmo, GAL_EMOS };')(
    { getElementById: (id) => nodos[id] || null });

  api.galPresEmojis();
  assert.equal((nodos['gal-pres-emos'].innerHTML.match(/<button/g) || []).length,
    api.GAL_EMOS.length, 'no pintó todos los atajos');
  // Dos veces no los duplica: el modal se abre y se cierra muchas veces. Sale del
  // `innerHTML =`, que reemplaza en vez de sumar — no de un guard, que además
  // impediría repintar si la lista cambiara en caliente.
  api.galPresEmojis();
  assert.equal((nodos['gal-pres-emos'].innerHTML.match(/<button/g) || []).length,
    api.GAL_EMOS.length, 'los duplicó al reabrir');

  api.galPresEmo('🍑');
  assert.equal(nodos['gal-pres-emo'].value, '🍑');
  // El mismo de nuevo lo SACA: es el único lugar donde se puede dejar sin
  // dibujito después de haber puesto uno, sin seleccionar y borrar a mano.
  api.galPresEmo('🍑');
  assert.equal(nodos['gal-pres-emo'].value, '');
  // Y otro distinto lo reemplaza, no lo suma.
  api.galPresEmo('🍑'); api.galPresEmo('📦');
  assert.equal(nodos['gal-pres-emo'].value, '📦');
});

test('el casillero del dibujito está PEGADO AL NOMBRE, en la primera fila', () => {
  // El dibujito es la identidad de la presentación, lo mismo que el nombre.
  // En una fila propia quedaba entre el nombre y la cuenta del bulto, que es
  // otra cosa — y le sumaba un renglón a un modal que ya es alto.
  const m = bloqueHtml('<div class="ab-modal-overlay sg-mod" id="gal-pres-modal">');
  const emo = m.indexOf('id="gal-pres-emo"');
  const nom = m.indexOf('id="gal-pres-nom"');
  const cat = m.indexOf('id="gal-pres-cat"');
  assert.ok(emo > 0 && nom > 0 && cat > 0, 'falta alguno de los tres campos');
  assert.ok(emo < nom, 'el dibujito quedó después del nombre');
  assert.ok(nom < cat, 'el nombre quedó después de la categoría');
  // Y en la MISMA fila: entre los dos no puede cerrarse el flex.
  assert.ok(!m.slice(emo, nom).includes('</div>\r\n        <div style="display:flex'),
    'el dibujito quedó en una fila aparte del nombre');
});

test('la LISTA del catálogo muestra el dibujito de cada una', () => {
  // Es donde se ve de un vistazo a cuál le falta. Sin esto habría que abrir
  // las siete para saberlo.
  const js = PANEL.slice(PANEL.indexOf('  b.innerHTML = GPRES.lista.map(function(p){'),
                         PANEL.indexOf('function galPresAbrir('));
  assert.ok(js.length > 200, 'el corte de la lista salió vacío');
  // Por galDibHtml, que decide entre el dibujo subido y el emoji en un solo
  // lugar para las cuatro pantallas. El assert anterior miraba `p.emoji` y el
  // markup exacto: se cayó al unificarlas, que es justamente lo que se quería.
  assert.match(js, /galDibHtml\(p, 16\)/, 'la lista no pinta el dibujito');
  // Con el hueco ocupado aunque no haya: si no, los nombres quedan en zigzag.
  assert.match(js, /display:inline-block;width:22px/);
});

test('UN SOLO LUGAR DECIDE QUÉ DIBUJITO VA, y las cuatro pantallas lo usan', () => {
  // Se pinta en la ventana del catálogo, en su lista, en las baldosas del
  // stock y en las de Proceso. Escrito cuatro veces, el día que cambie la
  // dirección del archivo quedan tres rotas — y se ven recién abriendo cada
  // pantalla, que es como se descubren estas cosas en producción.
  const usos = [...PANEL.matchAll(/galDibHtml\(/g)].length;
  assert.ok(usos >= 4, 'sólo ' + usos + ' usos de galDibHtml: alguna lo escribe aparte');
  // Y la URL también sale de un solo lado, con su ?v= o el navegador muestra
  // el dibujo anterior durante el año que dura la caché.
  const url = PANEL.slice(PANEL.indexOf('function galDibUrl(id, v){'),
                          PANEL.indexOf('function galDibHtml('));
  assert.ok(url.length > 50, 'el corte de galDibUrl salió vacío');
  assert.match(url, /\?v=/);
  assert.match(url, /encodeURIComponent/);
  // Nadie arma esa dirección a mano en otro lado.
  const aMano = [...PANEL.matchAll(/presentaciones\/[^'"]*\/icono/g)]
    .map((m) => m[0]).filter((x) => !x.includes('+ id +'));
  for (const x of aMano) {
    assert.ok(/' \+ GPRES\.editId \+ '|\$\{/.test(x) || x.includes('/api/galpon/presentaciones/'),
      'dirección del dibujo armada a mano: ' + x);
  }

  const di = PANEL.indexOf('function galDibHtml(p, px){');
  assert.ok(di > 0, 'no encontré galDibHtml');
  const dib = PANEL.slice(di, PANEL.indexOf('var GST = {', di));
  assert.ok(dib.length > 200, 'el corte de galDibHtml salió vacío');
  // El dibujo subido gana sobre el emoji, y los dos se esconden del lector.
  assert.ok(dib.indexOf('icono_v') < dib.indexOf('p.emoji'),
    'el emoji se evalúa antes que el dibujo subido');
  assert.equal((dib.match(/aria-hidden="true"/g) || []).length, 2,
    'alguno de los dos casos se lo lee el lector de pantalla');
});

test('LA VENTANA DEL ARMADO NO SE CIERRA AL CERRAR EL PALLET', () => {
  // Regla 4 de CLAUDE.md, la que no es auditable en general porque depende de
  // qué queda adentro: acá queda el NÚMERO del pallet, que es lo que hay que
  // leer antes de ir a imprimir el tarjetón y pegarlo.
  const js = bloqueJs('var GST = {');
  const cerrar = js.slice(js.indexOf('async function galArmCerrarPallet()'),
                          js.indexOf('async function galArmReabrir()'));
  assert.ok(cerrar.length > 200, 'el corte de galArmCerrarPallet salió vacío');
  assert.ok(!sinComentarios(cerrar).includes('galArmCerrar('),
    'galArmCerrarPallet cierra la ventana y se lleva el número');
  assert.match(cerrar, /galArmPintar\(\)/,
    'no repinta: la ventana queda mostrando el pallet abierto de antes');
});

test('el abridor del armado DEJA LA VENTANA EN BLANCO', () => {
  // Un formulario que sólo se esconde conserva lo que tenía: acá sería armar
  // el pallet del jueves con la observación del martes.
  const js = bloqueJs('var GST = {');
  const abrir = js.slice(js.indexOf('async function galArmAbrir(id)'),
                         js.indexOf('function galArmCerrar()'));
  assert.ok(abrir.length > 200, 'el corte de galArmAbrir salió vacío');
  for (const k of ['gal-arm-fecha', 'gal-arm-obs', 'gal-arm-cant']) {
    assert.ok(abrir.includes(k), 'el abridor no limpia ' + k);
  }
  assert.match(abrir, /GST\.armsel = null/);
});

// ── 📴 EL CABLEADO DEL MODO SIN INTERNET ──────────────────────────────────
test('EL ENVOLTORIO SE CARGA ANTES QUE TODO, Y SIN defer', () => {
  // Con `defer` los scripts corren en orden pero DESPUÉS del HTML, y una
  // pantalla que arranque sola en el camino usaría el fetch pelado — justo la
  // primera carga, que es la que al operador le importa.
  const i = PANEL.indexOf('<script src="/static/galponOffline.js">');
  assert.ok(i > 0, 'el panel no carga galponOffline.js');
  const j = PANEL.indexOf('<script src="/static/galponOfflineNav.js">');
  assert.ok(j > i, 'la parte del navegador se carga antes que la lógica');
  // Ninguno de los dos lleva defer.
  for (const f of ['galponOffline.js', 'galponOfflineNav.js']) {
    const tag = new RegExp('<script src="/static/' + f + '"([^>]*)>').exec(PANEL);
    assert.ok(tag, 'no está el tag de ' + f);
    assert.ok(!/defer|async/.test(tag[1]), f + ' se carga con defer/async');
  }
});

test('el service worker se registra y se sirve desde la RAÍZ', () => {
  // Un service worker sólo controla las URLs de su propia carpeta hacia
  // abajo: uno servido desde /static no vería /panel, que es justamente lo
  // que hay que poder abrir sin señal.
  assert.match(PANEL, /navigator\.serviceWorker\.register\('\/galpon-sw\.js'/,
    'el panel no registra el service worker, o lo busca en otro lado');
  const idx = fs.readFileSync(path.join(RAIZ, 'src/index.js'), 'utf8');
  assert.match(idx, /app\.get\("\/galpon-sw\.js"/, 'el servidor no sirve el SW en la raíz');
  const bloque = idx.slice(idx.indexOf('app.get("/galpon-sw.js"'),
                           idx.indexOf('app.get("/mifco-sw.js"'));
  assert.match(bloque, /Service-Worker-Allowed/, 'sin ese header el scope queda en /static');
  // Y NO se cachea: un navegador que se queda con un SW viejo decide para
  // siempre qué cachear, y eso no se corrige desde el servidor.
  assert.match(bloque, /Cache-Control['"]?,\s*['"]no-cache/,
    'el service worker se puede quedar cacheado para siempre');
});

test('EL CARTEL DE «ESTO ES VIEJO» ESTÁ EN LAS TRES PANTALLAS', () => {
  // Un dato viejo que no dice que es viejo es peor que una pantalla vacía: el
  // operador arma un camión con cajas que ya salieron. Y va en UNA función,
  // no copiado en cada pantalla.
  assert.match(PANEL, /function galOffCartel\(j, dondeId\)\{/);
  const usos = [...PANEL.matchAll(/galOffCartel\(j, '([a-z-]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(usos.sort(), ['gac-aviso', 'gpr-aviso', 'gst-aviso'],
    'alguna pantalla del galpón no avisa que está mostrando datos viejos');
  // Y los tres contenedores existen, o el cartel se pinta en la nada.
  for (const id of usos) {
    assert.ok(PANEL.includes('id="' + id + '"'), 'falta el contenedor ' + id);
  }
  // Dice DE CUÁNDO son los datos: «es viejo» sin fecha no deja decidir nada.
  const fn = PANEL.slice(PANEL.indexOf('function galOffCartel(j, dondeId){'),
                         PANEL.indexOf('function galStAviso(msg, tipo){'));
  assert.match(fn, /cache_cuando/);
  assert.match(fn, /toLocaleDateString/);
});
