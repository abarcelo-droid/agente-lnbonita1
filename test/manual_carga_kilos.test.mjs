// ══ ❓ EL MANUAL DE CARGA DE KILOS, PROBADO CONTRA EL CÓDIGO ══════════════
//
// CLAUDE.md: «el manual se prueba contra el código, no contra sí mismo. Un test
// que sólo verifica que el texto existe no sirve para nada: lo que hay que
// clavar es que lo que el manual AFIRMA sigue siendo cierto».
//
// Un manual que va una versión atrás es peor que no tenerlo: el operador hace
// lo que dice y le sale mal. Así que cada afirmación de las tres secciones que
// entraron en la V1133 tiene acá su assert contra el código que la cumple.
//
// El manual se EJECUTA, no se lee con una expresión regular: SG_MANUAL es
// JavaScript y una comilla mal cerrada rompe el panel entero.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SERV  = fs.readFileSync(path.join(RAIZ, 'src/servicios/galpon.js'), 'utf8');
const RUTA  = fs.readFileSync(path.join(RAIZ, 'src/rutas/galpon.js'), 'utf8');
const DDL   = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_galpon.js'), 'utf8');
const PERM  = fs.readFileSync(path.join(RAIZ, 'src/servicios/permisos.js'), 'utf8');

// ── EL MANUAL, EJECUTADO ─────────────────────────────────────────────────
const HTML = (() => {
  const i = PANEL.indexOf("SG_MANUAL['galpon-carga'] = {");
  assert.ok(i > 0, 'no está el manual de galpon-carga');
  const j = PANEL.indexOf('\r\n};', i);
  assert.ok(j > i, 'no encontré el final del manual');
  const codigo = 'var SG_MANUAL = {};\n' + PANEL.slice(i, j + 4)
    + "\nreturn SG_MANUAL['galpon-carga'];";
  const m = new Function(codigo)();
  assert.equal(m.titulo, 'Galpón · Carga de kilos');
  return String(m.html);
})();

const dice = (re, que) => assert.match(HTML, re, 'el manual no dice: ' + (que || re));

// ── La función del servicio, acotada: un assert contra el archivo entero se
//    cumple con cualquier línea de otra función y no prueba nada.
function fn(fuente, firma) {
  const i = fuente.indexOf(firma);
  assert.ok(i > 0, 'no está ' + firma);
  const j = fuente.indexOf('\r\n}', i);
  assert.ok(j > i, 'no encontré el final de ' + firma);
  return fuente.slice(i, j);
}

// ══════════════════════════════════════════════════════════════════════════
// 0 · LA REGLA DE CLAUDE.md
// ══════════════════════════════════════════════════════════════════════════
test('cada sección nueva lleva su V###', () => {
  // Sin el número, el que lo lee no sabe si está mirando el manual de la
  // versión que tiene en pantalla.
  assert.equal((HTML.match(/<span class="ver">V1133<\/span>/g) || []).length, 3,
    'alguna de las tres secciones de la V1133 no lleva su número de versión');
  assert.equal((HTML.match(/<span class="ver">V1134<\/span>/g) || []).length, 1,
    'la sección del casillero no lleva su número de versión');
});

// ══════════════════════════════════════════════════════════════════════════
// 1 · 👷 DOS CUADRILLAS EN EL MISMO CAJÓN
// ══════════════════════════════════════════════════════════════════════════
test('MANUAL: «donde había un desplegable ahora hay una lista»', () => {
  dice(/\+ otra cuadrilla/);
  dice(/las dos ventanas/i);
  // Una lista de renglones, y el mismo mecanismo para las dos ventanas.
  assert.match(PANEL, /function galCuadPintar\(contId, ids\)\{/);
  for (const c of ['gal-kg-cuads', 'gal-rap-cuads']) {
    assert.ok(PANEL.includes('id="' + c + '"'), 'falta el contenedor ' + c);
    assert.ok(PANEL.includes("galCuadPintar('" + c + "'"), c + ' no usa el armador común');
  }
  assert.ok(!/function galKgLlenarCuad\(/.test(PANEL),
    'volvió el desplegable único y el manual habla de una lista');
});

test('MANUAL: «los kilos del cajón se reparten en partes iguales»', () => {
  dice(/partes iguales/);
  dice(/700 kg/);
  dice(/350 a cada una/);
  // Lo hace guardarCuadrillas con repartir() y pesos iguales.
  const g = fn(SERV, 'export function guardarCuadrillas(db, volcadoId, lista, kg)');
  assert.match(g, /repartir\(kg, l\.map\(\(\) => 1 \/ l\.length\)\)/,
    'el reparto dejó de ser en partes iguales');
  assert.match(g, /INSERT INTO gal_volcado_cuadrillas/);
  // Y la ventana lo dice donde se elige, no sólo en el manual.
  const av = fn(PANEL, 'function galCuadCambio(contId){');
  assert.match(av, /partes iguales/,
    'la ventana no avisa cómo se reparte: un promedio que parece medido');
});

test('MANUAL: «el cajón sigue siendo uno y los kilos no cambian»', () => {
  dice(/cajón sigue siendo uno/i);
  dice(/se cuenta una vez/);
  // La fila madre guarda los kilos tal cual: lo que se parte es la atribución.
  const r = fn(SERV, 'export function registrarVolcado(db, d)');
  assert.match(r, /const reparto = guardarCuadrillas\(db, id, cuads, kg\);/);
  assert.ok(!/UPDATE gal_volcados SET kilos/.test(SERV),
    'alguien le toca los kilos del cajón para que cierre el reparto');
  // Y el reparto vive en su propia tabla, no en una segunda columna.
  assert.match(DDL, /CREATE TABLE IF NOT EXISTS gal_volcado_cuadrillas/);
  /* Se busca la COLUMNA, no la palabra: el comentario de arriba de la tabla nombra
     cuadrilla2_id justamente para decir por qué no está. */
  assert.ok(!/cuadrilla2_id\s+INTEGER/.test(DDL), 'volvió la segunda columna de cuadrilla');
  assert.ok(!/ADD COLUMN cuadrilla2/.test(DDL), 'volvió la segunda columna de cuadrilla');
});

test('MANUAL: «el corte por cuadrilla suma lo mismo que el total, nunca más»', () => {
  dice(/suma siempre lo mismo que el total del día/);
  // Los dos cortes leen la tabla satélite, que es donde está el reparto.
  for (const f of ['export function resumenDelDia(db, fecha)',
                   'export function acumulado(db, desde, hasta)']) {
    const cuerpo = fn(SERV, f);
    assert.match(cuerpo, /LEFT JOIN gal_volcado_cuadrillas/,
      f + ' lee la cuadrilla de la fila madre: le da los kilos enteros a la primera');
    assert.match(cuerpo, /GROUP BY COALESCE\(vc\.cuadrilla_id, v\.cuadrilla_id\)/);
  }
});

test('MANUAL: «si una llenó bastante más, van dos cargas»', () => {
  dice(/van dos cargas/);
  // O sea: NO hay un casillero para repartir a mano. Si lo hubiera, el manual
  // estaría mandando a hacer dos cargas para algo que se puede hacer en una.
  const g = fn(SERV, 'export function guardarCuadrillas(db, volcadoId, lista, kg)');
  assert.ok(!/dd\.reparto|kilos_cuadrilla|\breparto_manual\b/.test(g),
    'hay una manera de repartir a mano y el manual manda a cargar dos veces');
});

test('MANUAL: «al corregir vienen ofrecidas las dos, y el reparto se rehace»', () => {
  dice(/vienen ofrecidas las que tenía, las dos/);
  dice(/el reparto se rehace solo/);
  const abrir = fn(PANEL, 'function galKgAbrir(id){');
  assert.match(abrir, /c\.cuadrillas\.map\(function\(q\)\{ return q\.cuadrilla_id; \}\)/,
    'la ventana de corregir ofrece una sola cuadrilla');
  const ed = fn(SERV, 'export function editarVolcado(db, id, d)');
  assert.match(ed, /if \(cuads !== null \|\| 'kilos' in dd\)/,
    'corregir los kilos no rehace el reparto: la pantalla diría 900 arriba y 700 abajo');
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · 🗑️ BORRAR UNA CARGA DEL DÍA
// ══════════════════════════════════════════════════════════════════════════
test('MANUAL: «lo cargado HOY lo borra cualquiera que pueda cargar»', () => {
  dice(/Lo cargado HOY lo borra cualquiera/);
  // Las dos mitades de la decisión.
  assert.match(PERM, /const BORRAR_ES_OPERAR = \["\/api\/galpon\/volcados"\]/,
    'el DELETE de una carga sigue pidiendo nivel de anulación');
  assert.match(PERM, /if \(anula && borrarEsOperar\(req\.originalUrl \|\| req\.url\)\) return next\(\);/);
  const b = fn(SERV, 'export function borrarVolcado(db, id, opts)');
  assert.match(b, /if \(!o\.puede_anular && o\.hoy && fila\.fecha !== o\.hoy\)/);
});

test('MANUAL: «lo de un día anterior necesita el permiso de anular»', () => {
  dice(/Lo de un día anterior, no/);
  dice(/permiso de anular/);
  dice(/jornal/);
  const b = fn(SERV, 'export function borrarVolcado(db, id, opts)');
  assert.match(b, /status: 403/);
  assert.match(b, /jornal/, 'el motivo que ve el operador no dice por qué');
  // Y la fecha de hoy la pone el servidor, no el navegador.
  const d = RUTA.slice(RUTA.indexOf("router.delete('/volcados/:id'"));
  assert.match(d.slice(0, 900), /hoy: hoy\(\)/);
  assert.match(RUTA, /const hoy\s+= \(\) => new Date\(\)\.toLocaleDateString\('en-CA'\)/,
    'la fecha de hoy no sale del servidor: alcanzaría con adelantar el reloj del equipo');
});

test('MANUAL: «cuando no se puede, la × no aparece — corregir sí se puede»', () => {
  dice(/la × no aparece/);
  dice(/<b>Corregir<\/b> '?\s*\+?\s*'?se puede siempre/);
  const pintar = fn(PANEL, 'function galKgPintar(){');
  assert.match(pintar, /var puedoBorrar = \(GKG\.fecha === GKG\.hoy\) \|\| !!GKG\.puedeAnular;/);
  assert.match(pintar, /\(\(puedoBorrar \|\| c\.encolado\)/,
    'la × no mira el permiso: ofrece un botón que va a rebotar');
  // El ✎ no depende del permiso de borrar.
  const i = pintar.indexOf('galKgAbrir');
  assert.ok(i > 0 && !/puedoBorrar[^;]*galKgAbrir/.test(pintar),
    'corregir quedó atado al permiso de borrar y el manual dice que se puede siempre');
});

test('MANUAL: «borrar no borra: la fila queda con la marca de cuándo»', () => {
  dice(/Borrar no borra/);
  dice(/se puede auditar después/);
  const b = fn(SERV, 'export function borrarVolcado(db, id, opts)');
  assert.match(b, /UPDATE gal_volcados SET eliminado_en = datetime\('now','localtime'\)/);
  assert.ok(!/DELETE FROM gal_volcados/.test(SERV), 'hay un borrado duro de kilos');
  // Y deja de contar en los tres lugares que el manual nombra.
  for (const f of ['export function volcadosDelDia(db, fecha)',
                   'export function resumenDelDia(db, fecha)',
                   'export function acumulado(db, desde, hasta)']) {
    assert.match(fn(SERV, f), /eliminado_en IS NULL/, f + ' cuenta las cargas borradas');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · 📴 CARGAR SIN SEÑAL
// ══════════════════════════════════════════════════════════════════════════
test('MANUAL: «el total del día lo suma el servidor»', () => {
  dice(/total del día lo suma el servidor/);
  // Y por eso la pantalla no lo recalcula: lo lee del resumen que viene.
  const tot = fn(PANEL, 'function galKgPintarTot(){');
  assert.match(tot, /var r = GKG\.resumen/);
  assert.ok(!/GKG\.cargas\.forEach[^;]*kilos/.test(tot),
    'la pantalla suma el total por su cuenta: dos cuentas del mismo número');
});

test('MANUAL: «sin señal se ven dos números y ninguno sumado con el otro»', () => {
  dice(/Esperando en este equipo/);
  dice(/Lo último que se vio/);
  dice(/No se suman a propósito/);
  const tot = fn(PANEL, 'function galKgPintarTot(){');
  assert.match(tot, /if \(GKG\.deCache\)\{/);
  assert.match(tot, /Esperando en este equipo/);
  assert.match(tot, /Lo último que se vio/);
  // Y no hay una suma de los dos en ningún lado de esa rama.
  const rama = tot.slice(tot.indexOf('if (GKG.deCache){'), tot.indexOf('return;'));
  assert.ok(!/kgEnc \+ |\+ kgEnc|r\.kilos \+ /.test(rama),
    'sumó la foto vieja con la cola: el total parece el del día y no lo es');
});

test('MANUAL: «cada carga sin mandar aparece arriba y marcada»', () => {
  dice(/sin '?\s*\+?\s*'?mandar/);
  const pintar = fn(PANEL, 'function galKgPintar(){');
  assert.match(pintar, /var filas = \(GKG\.encoladas \|\| \[\]\)\.concat\(guardadas\);/,
    'las cargas de la cola no van arriba');
  assert.match(pintar, /gkg-encp/, 'el renglón de la cola no se distingue');
  assert.match(PANEL, /#sec-galpon-carga tr\.gkg-enc\{/);
});

test('MANUAL: «se puede borrar pero no corregir, porque no tiene número del servidor»', () => {
  dice(/no se puede '?\s*\+?\s*'?corregir/);
  dice(/no tiene número del servidor/);
  const pintar = fn(PANEL, 'function galKgPintar(){');
  assert.match(pintar, /\(c\.encolado \? ''/,
    'ofrece corregir una carga que todavía está en la cola');
  // Y la cola contesta eso mismo si alguien lo intenta de todas formas.
  const off = fs.readFileSync(path.join(RAIZ, 'src/galponOffline.js'), 'utf8');
  assert.match(off, /Borrala y cargala de nuevo/);
});

test('MANUAL: «los cortes se esconden mientras no hay señal»', () => {
  dice(/se esconden mientras no hay '?\s*\+?\s*'?señal/);
  const c = fn(PANEL, 'function galKgPintarCortes(){');
  assert.match(c, /if \(GKG\.deCache\)\{ el\.innerHTML = ''; return; \}/);
});

test('MANUAL: «la hora a la que bajó la foto»', () => {
  dice(/con la hora a la que bajó/);
  const tot = fn(PANEL, 'function galKgPintarTot(){');
  assert.match(tot, /GKG\.cacheCuando/);
  assert.match(tot, /toLocaleTimeString/);
  // Y el dato viene marcado del envoltorio de la cola, no lo adivina la pantalla.
  const nav = fs.readFileSync(path.join(RAIZ, 'src/galponOfflineNav.js'), 'utf8');
  assert.match(nav, /d\.cache_cuando = g\.cuando;/);
  assert.match(PANEL, /GKG\.cacheCuando = j\.cache_cuando \|\| null;/);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · ☑️ BORRAR VARIAS DE UNA VEZ (V1134)
// ══════════════════════════════════════════════════════════════════════════

test('MANUAL: «cada renglón que se puede borrar tiene su casillero»', () => {
  dice(/casillero/);
  dice(/el del encabezado marca o desmarca todos/);
  const pintar = fn(PANEL, 'function galKgPintar(){');
  assert.match(pintar, /class="gkg-ck" data-id=/,
    'los renglones no traen casillero');
  assert.match(PANEL, /id="gkg-ck-todas"[\s\S]{0,200}galKgSelTodas\(this\.checked\)/,
    'falta el casillero del encabezado');
});

test('MANUAL: «sólo tienen casillero las que se pueden borrar»', () => {
  dice(/Sólo tienen casillero las que <b>se pueden<\/b> borrar/);
  const pintar = fn(PANEL, 'function galKgPintar(){');
  // La misma condición que la ×, no una copia suelta que pueda decir otra cosa.
  assert.match(pintar, /\(\(puedoBorrar \|\| c\.encolado\)[\s\S]{0,200}class="gkg-ck"/,
    'el casillero no mira el mismo permiso que la ×');
});

test('MANUAL: «la barra dice cuántas cargas y cuántos kilos»', () => {
  dice(/cuántas cargas y cuántos kilos/);
  dice(/5\.400 kg/);
  const b = fn(PANEL, 'function galKgPintarSel(){');
  assert.match(b, /galKgNum\(kg\)/, 'la barra no muestra los kilos');
  assert.match(b, /GKG\.sel\.forEach/);
  // Y aparece recién con algo marcado: lo normal es silencioso (CLAUDE.md).
  assert.match(b, /if \(!n\)\{[\s\S]{0,120}display = 'none'/);
  assert.match(PANEL, /#sec-galpon-carga \.gkg-barra\{display:none/);
});

test('MANUAL: «pregunta una vez, con esos dos números»', () => {
  dice(/pregunta una vez/);
  const b = fn(PANEL, 'async function galKgBorrarSel\(\)\{'.replace(/\\/g, ''));
  assert.match(b, /confirm\(/, 'borra veinte renglones sin preguntar');
  assert.match(b, /galKgNum\(kg\)/,
    'la confirmación no dice los kilos: «12 cargas» se parece a cualquier cosa');
});

test('MANUAL: «o todas o ninguna»', () => {
  dice(/O todas o ninguna/);
  dice(/no se borra ninguna/);
  const f = fn(SERV, 'export function borrarVolcados(db, ids, opts)');
  // La validación entera ANTES del primer UPDATE.
  const iVal = f.indexOf('filas.push(f);');
  const iUpd = f.indexOf('UPDATE gal_volcados SET eliminado_en');
  assert.ok(iVal > 0 && iUpd > iVal,
    'borra al pasar: una tanda puede quedar a medias y el manual promete que no');
  assert.match(f, /No se borró ninguna/,
    'el aviso no aclara que no se borró nada');
});

test('MANUAL: «la selección no se pierde» cuando el servidor dice que no', () => {
  dice(/no se pierde/);
  const b = fn(PANEL, 'async function galKgBorrarSel\(\)\{'.replace(/\\/g, ''));
  const i = b.indexOf('if (!j.ok)');
  assert.ok(i > 0, 'no mira si el servidor aceptó');
  const j = b.indexOf('GKG.sel = [];');
  assert.ok(j > i, 'suelta la selección antes de saber si se pudo borrar');
  assert.match(b.slice(i, i + 160), /return;/, 'sigue adelante después de un error');
});

test('MANUAL: «sin señal también funciona»', () => {
  dice(/Sin señal también funciona/);
  dice(/un solo pedido/);
  const off = fs.readFileSync(path.join(RAIZ, 'src/galponOffline.js'), 'utf8');
  assert.match(off, /\{ metodo: 'POST', re: \/\^\\\/api\\\/galpon\\\/volcados\\\/borrar\$\/ \}/,
    'el borrado múltiple no se puede encolar: sin señal devuelve error de red');
  // Lo de la cola sale de la cola, y la barra cuenta los kilos de las dos cosas.
  const b = fn(PANEL, 'async function galKgBorrarSel\(\)\{'.replace(/\\/g, ''));
  assert.match(b, /indexOf\('enc:'\) === 0/);
  const bar = fn(PANEL, 'function galKgPintarSel(){');
  assert.match(bar, /\(GKG\.encoladas \|\| \[\]\)\.concat\(GKG\.cargas\)/,
    'la barra no cuenta los kilos de la cola');
});

test('MANUAL: «hay un tope de 500 por vez»', () => {
  dice(/<b>tope de 500 por vez<\/b>/);
  const f = fn(SERV, 'export function borrarVolcados(db, ids, opts)');
  assert.match(f, /limpios\.length > 500/);
  assert.match(f, /demasiadas/);
});
