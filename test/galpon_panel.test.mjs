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
const MANUAL = (() => {
  const i = PANEL.indexOf("SG_MANUAL['galpon-config']");
  assert.ok(i > 0, 'el módulo no tiene «¿Cómo se usa?» — escribirlo ES actualizarlo');
  return PANEL.slice(i, PANEL.indexOf('\n};', i))
    .replace(/'\s*\r?\n\s*\+\s*'/g, '');
})();

// `assert.match` contra el manual escupe las 90 líneas enteras en cada fallo, y entre
// tanto texto no se ve cuál era la frase. Esto dice sólo la que falta.
function dice(frase, nota) {
  const re = frase instanceof RegExp ? frase : new RegExp(frase);
  assert.ok(re.test(MANUAL),
    'EL MANUAL NO DICE: ' + (frase.source || frase) + (nota ? '\n  (' + nota + ')' : ''));
}

// ── 1 · LAS CINCO PIEZAS DEL REGISTRO ─────────────────────────────────────
test('el módulo se registra SIEMPRE, no sólo con la tabla vacía', () => {
  // El seed de db_org.js hace `if (n > 0) return`: agregar una fila a ese array
  // no hace nada en producción, donde la tabla ya tiene filas.
  assert.match(ENSURE, /INSERT OR IGNORE INTO modulos_config/);
  assert.match(ENSURE, /'galpon-config'/);
  assert.match(ORG, /^import "\.\/ensure_modulo_galpon\.js";$/m,
    'el ensure existe pero nadie lo importa: no corre nunca');
});

test('EL PREFIJO DE LA API ESTÁ DECLARADO, o exigirNivel deja pasar a cualquiera', () => {
  // Sin esta línea moduloDeRuta devuelve null, el guardián no resuelve el módulo
  // y el nivel que el admin marcó en Usuarios no se aplica.
  const m = /\['galpon-config',\s*'([^']+)'\]/.exec(PREFIJOS);
  assert.ok(m, 'galpon-config no está en ensure_api_prefijos.js');
  // Y están TODAS las direcciones que el router monta, no las que alguien recordó.
  const declaradas = m[1].split(',').map((x) => x.trim().replace(/^galpon\//, ''));
  for (const r of RUTA.matchAll(/router\.(get|post|put|patch|delete)\('\/([^'/?]+)/g)) {
    assert.ok(declaradas.some((d) => r[2].startsWith(d.split('.')[0])),
      'la ruta /' + r[2] + ' no está cubierta por el prefijo declarado');
  }
  // Y NO se declara el prefijo pelado: le daría las rutas de los cuatro módulos
  // del galpón a un solo menú. Es la trampa que el propio archivo advierte.
  assert.ok(!/\[\s*'galpon[^']*',\s*'galpon'\s*\]/.test(PREFIJOS), 'se declaró el prefijo pelado');
});

test('el router está montado', () => {
  assert.match(INDEX, /import galponRouter\s+from "\.\/rutas\/galpon\.js";/);
  assert.match(INDEX, /app\.use\("\/api\/galpon",\s*galponRouter\);/);
});

test('LAS DOS PIEZAS DEL SIDEBAR, que hacen falta juntas', () => {
  // El sidebar de verdad lo arma /api/org/sidebar filtrado por permisos, y lo que
  // hace es CLICKEAR este div escondido. Con una sola de las dos no pasa nada.
  assert.match(PANEL, /<div class="ni" data-sec="galpon-config">/);
  assert.match(PANEL, /<div class="sec sg-mod" id="sec-galpon-config">/);
});

test('y el dispatcher la sabe abrir', () => {
  // Sin esta línea la pantalla aparece vacía: el HTML está, pero nada la carga.
  assert.match(PANEL, /'galpon-config': function\(\)\{ galInit\(\); \}/);
  assert.match(PANEL, /function galInit\(/);
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

test('y el manual lleva el V### al lado de cada cosa, como pide CLAUDE.md', () => {
  const vers = [...MANUAL.matchAll(/<span class="ver">(V\d+)<\/span>/g)].map((m) => m[1]);
  assert.ok(vers.length >= 6, 'sólo ' + vers.length + ' entradas numeradas');
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
