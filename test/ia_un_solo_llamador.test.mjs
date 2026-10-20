// ══ UN SOLO LUGAR LLAMA A LA IA ═══════════════════════════════════════════
//
// El 14/10/2026 la cuenta de la API se quedó sin crédito, el lector de remitos
// de IFCO dejó de leer, y al buscar qué lo había consumido apareció el problema
// de fondo: NO HABÍA FORMA DE SABERLO.
//
// Las llamadas devuelven `usage` —cuántos tokens entraron y salieron— y nadie lo
// guardaba. La consola de Anthropic muestra el total por modelo, pero las doce
// funciones de este sistema usan LA MISMA clave: ahí el OCR, la lectura de
// facturas y el buscador son un solo número.
//
// Andy, 17/10/2026: «¿Si armamos un lugar en el panel donde podamos ver cuánto
// consume cada cosa? Creo que va a ser muy práctico a futuro».
//
// Este archivo clava la mitad que hace que eso funcione: que TODA llamada pase
// por servicios/ia.js. Es el mismo criterio que `t-un-solo-escritor` con los
// asientos — una llamada suelta no rompe nada hoy, y mañana la pantalla miente
// por omisión, que es la peor forma de mentir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Todos los .js de src/, menos el propio medidor.
function archivos(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivos(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}
const TODOS = archivos(path.join(RAIZ, 'src'));
const rel = (p) => path.relative(RAIZ, p).replace(/\\/g, '/');

// Una llamada a la IA se reconoce por la dirección cruda o por `.messages.create`
// CON un modelo al lado. Lo segundo importa: el SDK de Twilio también tiene un
// `messages.create`, y confundirlos haría que este test acusara a tres archivos
// que mandan WhatsApp. (Pasó al contarlas por primera vez.)
function llamadasSueltas(texto) {
  const lineas = texto.split(/\r?\n/);
  const hits = [];
  lineas.forEach((l, i) => {
    const esCruda = /api\.anthropic\.com\/v1\/messages/.test(l);
    const esSdk = /\.messages\.create\(/.test(l);
    if (!esCruda && !esSdk) return;
    // El contexto decide si es Anthropic: un modelo nombrado cerca.
    const ctx = lineas.slice(Math.max(0, i - 6), i + 6).join('\n');
    if (esSdk && !/model:|MODELO_|claude-/.test(ctx)) return;
    hits.push({ linea: i + 1, texto: l.trim().slice(0, 100) });
  });
  return hits;
}

// `src/ifco.js` es un huérfano de 3021 líneas: el router que corre es
// `src/rutas/ifco.js` (es el que monta index.js). Nadie lo importa — sólo lo
// nombran comentarios. No se borra acá porque borrar 3000 líneas es su propio
// cambio, pero se vigila que SIGA desconectado: el día que alguien lo enchufe,
// sus dos llamadas sueltas entran al sistema sin quedar registradas.
const HUERFANOS = ['src/ifco.js'];

test('NINGÚN ARCHIVO VIVO LLAMA A LA IA POR SU CUENTA', () => {
  const culpables = [];
  for (const f of TODOS) {
    const r = rel(f);
    if (r === 'src/servicios/ia.js' || HUERFANOS.includes(r)) continue;
    const hits = llamadasSueltas(fs.readFileSync(f, 'utf8'));
    if (hits.length) culpables.push(r + ' → ' + hits.map((h) => 'línea ' + h.linea).join(', '));
  }
  assert.deepEqual(culpables, [],
    'Estas llamadas no pasan por servicios/ia.js, así que no quedan registradas y la\n'
    + 'pantalla de Consumo de IA las ignora en silencio:\n  ' + culpables.join('\n  '));
});

test('y el huérfano sigue desconectado', () => {
  // Si alguien lo enchufa, sus llamadas entran sin registrarse. El día que pase,
  // este test falla y hay que convertirlas o borrar el archivo.
  const importa = TODOS.filter((f) => {
    const r = rel(f);
    if (HUERFANOS.includes(r)) return false;
    const t = fs.readFileSync(f, 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')            // los comentarios lo nombran, y no cuenta
      .replace(/\/\*[\s\S]*?\*\//g, '');
    return /from\s+['"][^'"]*\/ifco\.js['"]|require\(['"][^'"]*\/ifco\.js['"]\)/.test(t)
        && !/rutas\/ifco\.js/.test(t);
  }).map(rel);
  assert.deepEqual(importa, [], 'src/ifco.js dejó de ser código muerto: sus llamadas a la IA '
    + 'ahora corren sin quedar registradas. Convertilas a llamarIA() o borrá el archivo.');
});

test('el medidor es el único que construye el cliente de Anthropic', () => {
  // Un cliente propio en otro archivo es el primer paso para volver a tener una
  // llamada suelta. El único que puede crearlo es el que registra.
  const culpables = [];
  for (const f of TODOS) {
    const r = rel(f);
    if (r === 'src/servicios/ia.js' || HUERFANOS.includes(r)) continue;
    const t = fs.readFileSync(f, 'utf8');
    if (/new Anthropic\s*\(/.test(t)) culpables.push(r);
  }
  assert.deepEqual(culpables, []);
});

// ── LAS ETIQUETAS ─────────────────────────────────────────────────────────
const IA = fs.readFileSync(path.join(RAIZ, 'src/servicios/ia.js'), 'utf8');
const IAC = fs.readFileSync(path.join(RAIZ, 'src/servicios/ia_costo.js'), 'utf8');

test('toda llamada declara QUÉ FUNCIÓN la hace, y existe', () => {
  // Es la columna que hace útil a la pantalla: sin ella, todo vuelve a ser un
  // número por modelo, que es lo que ya mostraba la consola y no alcanzó.
  const declaradas = new Set(
    [...IAC.matchAll(/^\s*'([a-z0-9-]+)':\s*'/gm)].map((m) => m[1]));
  assert.ok(declaradas.size >= 10, 'FUNCIONES quedó casi vacío: ' + declaradas.size);

  const usadas = [];
  for (const f of TODOS) {
    if (rel(f) === 'src/servicios/ia.js') continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/llamarIA\(\s*'([^']+)'/g)) {
      usadas.push({ archivo: rel(f), funcion: m[1] });
    }
    // La forma con ternario (IFCO elige entre dos según el tipo de foto).
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/llamarIA\([^,]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) {
      usadas.push({ archivo: rel(f), funcion: m[1] });
      usadas.push({ archivo: rel(f), funcion: m[2] });
    }
  }
  assert.ok(usadas.length >= 10, 'esperaba al menos diez llamadas convertidas, hay ' + usadas.length);
  const inventadas = usadas.filter((u) => !declaradas.has(u.funcion));
  assert.deepEqual(inventadas, [],
    'Estas etiquetas no están en FUNCIONES, así que la pantalla las muestra como un\n'
    + 'código en crudo: ' + inventadas.map((u) => u.funcion + ' (' + u.archivo + ')').join(', '));
});

test('las etiquetas se leen, no son nombres de archivo', () => {
  // La lee alguien buscando qué se comió el crédito. «produccion» no le dice nada;
  // «Compras · leer un remito de insumos» sí.
  const pares = [...IAC.matchAll(/^\s*'([a-z0-9-]+)':\s*'([^']+)'/gm)];
  assert.ok(pares.length >= 10, 'FUNCIONES quedó corto: ' + pares.length);
  for (const [, clave, etiqueta] of pares) {
    assert.ok(etiqueta.includes('·'), clave + ' no dice de qué módulo es: "' + etiqueta + '"');
    assert.ok(etiqueta.length > 12, clave + ' es demasiado corta: "' + etiqueta + '"');
    assert.ok(/[a-záéíóúñ] [a-záéíóúñ]/.test(etiqueta.toLowerCase()),
      clave + ' no parece una frase: "' + etiqueta + '"');
  }
});

// ── EL COSTO ──────────────────────────────────────────────────────────────
// Se importa el módulo de verdad: el cálculo es lo único que no se puede mirar
// por texto, y equivocarlo hace que toda la pantalla mienta.
//
// Se importa `ia_costo.js` y NO `ia.js`: el primero no toca la base, así que entra
// de verdad. Con el segundo —que importa db.js, y por lo tanto better-sqlite3, que
// acá no está— estos ocho tests se salteaban EN SILENCIO y yo los contaba como
// verdes. Y sin `.catch(() => ({}))`: si el import falla, el test tiene que fallar.
const { costoMilesimas, PRECIOS, FUNCIONES, motivoFalla } =
  await import('file://' + path.join(RAIZ, 'src/servicios/ia_costo.js').replace(/\\/g, '/'));

test('el costo sale de los tokens y del precio del modelo', () => {
  // Sonnet: 3 dólares el millón de entrada, 15 el de salida.
  assert.equal(costoMilesimas('claude-sonnet-4-6', { input_tokens: 1e6, output_tokens: 1e6 }), 18000);
  // Haiku sale cinco veces menos.
  assert.equal(costoMilesimas('claude-haiku-4-5-20251001', { input_tokens: 1e6, output_tokens: 1e6 }), 6000);
});

test('la caché se cobra distinto: leer sale menos, escribir sale más', () => {
  // Si se cobraran igual que entrar normal, la pantalla no serviría para ver si
  // la caché está rindiendo — que es la primera palanca para gastar menos.
  assert.equal(costoMilesimas('claude-sonnet-4-6', { cache_read_input_tokens: 1e6 }), 300);
  assert.equal(costoMilesimas('claude-sonnet-4-6', { cache_creation_input_tokens: 1e6 }), 3750);
});

test('UN MODELO DESCONOCIDO NO SE COBRA CERO', () => {
  // Subestimar lo que no sabemos medir es la forma de que un modelo nuevo y caro
  // pase desapercibido justo hasta que llega la factura. Se cobra como el más caro.
  assert.equal(costoMilesimas('claude-loquesea-9', { input_tokens: 1e6 }), 3000);
  assert.ok(!PRECIOS['claude-loquesea-9']);
});

test('sin uso, no inventa un costo', () => {
  assert.equal(costoMilesimas('claude-sonnet-4-6', null), 0);
  assert.equal(costoMilesimas('claude-sonnet-4-6', {}), 0);
});

test('todo modelo que el repo usa de verdad tiene precio', () => {
  // Si config/ia.js incorpora un modelo y nadie le pone precio, su gasto se
  // estima con el del más caro — anda, pero el número queda mal y nadie se entera.
  const cfg = fs.readFileSync(path.join(RAIZ, 'src/config/ia.js'), 'utf8');
  const usados = [...cfg.matchAll(/'(claude-[a-z0-9.-]+)'/g)].map((m) => m[1]);
  assert.ok(usados.length >= 2, 'no encontré los modelos en config/ia.js');
  const sinPrecio = usados.filter((m) => !PRECIOS[m]);
  assert.deepEqual(sinPrecio, [],
    'Estos modelos se usan pero no tienen precio en PRECIOS: ' + sinPrecio.join(', '));
});

// ── EL ERROR QUE VE EL OPERADOR ───────────────────────────────────────────
test('el error de la API no llega crudo al que está trabajando', () => {
  // Es lo que pasó el 14/10: Santiago vio en el teléfono, en inglés, el JSON de
  // facturación de Anthropic.
  const sinCredito = Object.assign(
    new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":'
      + '"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 });
  const m = motivoFalla(sinCredito);
  for (const fuga of ['credit balance', 'Anthropic', 'invalid_request_error', '400']) {
    assert.ok(!m.operador.includes(fuga), 'al operador le llega «' + fuga + '»: ' + m.operador);
  }
  assert.match(m.operador, /a mano/, 'no le dice qué puede hacer');
  assert.match(m.admin, /sin crédito/i, 'el motivo técnico se perdió');
});

test('y la fila del consumo guarda el motivo técnico, no el de pantalla', () => {
  // La pantalla de consumo la mira un admin: ahí sirve el motivo de verdad.
  assert.match(IA, /error: m\.admin/);
});

// ── LA TABLA ──────────────────────────────────────────────────────────────
const BASE = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_ia_uso.js'), 'utf8');

test('la plata se guarda en enteros, no en coma flotante', () => {
  // Se suman miles de filas: en coma flotante eso junta error. Y el centavo no
  // alcanza como unidad porque una llamada de OCR cuesta una fracción de centavo.
  assert.match(BASE, /costo_mil\s+INTEGER NOT NULL/);
  assert.ok(!/costo\s+REAL|usd\s+REAL/.test(BASE), 'apareció un costo en coma flotante');
});

test('los cuatro tipos de token van por separado', () => {
  // Sumarlos en uno haría imposible ver si la caché está sirviendo.
  for (const c of ['tok_entrada', 'tok_salida', 'tok_cache_lee', 'tok_cache_crea']) {
    assert.ok(BASE.includes(c), 'falta la columna ' + c);
  }
});

test('la fallida se anota igual, con costo cero', () => {
  // Cien intentos fallidos no cuestan nada y sí dicen que algo se rompió: es la
  // fila que explica un día raro.
  assert.match(IA, /costo_mil: 0, ms: Date\.now\(\) - t0, ok: false/);
  assert.match(BASE, /ok\s+INTEGER NOT NULL DEFAULT 1/);
});

test('no se puede anotar una función que no existe', () => {
  assert.match(IA, /if \(!FUNCIONES\[funcion\]\)/);
  assert.match(IA, /función desconocida/);
});

test('ANOTAR NUNCA PUEDE VOLTEAR UNA CARGA', () => {
  // Que se caiga una carga de remito porque no se pudo anotar cuánto costó sería
  // cambiar un problema contable por uno operativo.
  const i = IA.indexOf('function anotar(');
  assert.ok(i > 0);
  const cuerpo = IA.slice(i, IA.indexOf('\n}', i));
  assert.match(cuerpo, /try \{/);
  assert.match(cuerpo, /catch \(e\) \{/);
  assert.match(cuerpo, /console\.error/);
});

// ── LA PANTALLA ───────────────────────────────────────────────────────────
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

test('la pantalla está registrada con los tres nombres iguales', () => {
  // modulos_config.modulo === data-sec === id="sec-X". Si falta el puente, la
  // pantalla abre EN BLANCO y sin ningún error.
  assert.match(PANEL, /data-sec="ia-uso"/);
  assert.match(PANEL, /id="sec-ia-uso"/);
  assert.match(PANEL, /'ia-uso': function\(\)\{ iuInit\(\); \}/);
  const reg = fs.readFileSync(path.join(RAIZ, 'src/servicios/ensure_modulo_ia_uso.js'), 'utf8');
  assert.match(reg, /'ia-uso'/);
  assert.match(fs.readFileSync(path.join(RAIZ, 'src/servicios/db_org.js'), 'utf8'),
    /ensure_modulo_ia_uso/);
});

test('SÓLO UN ADMIN VE EL GASTO DE LA EMPRESA', () => {
  // Es la misma línea que separa parametrizar de operar: el que carga un remito
  // no necesita saber cuánto cuesta leerlo, y mostrárselo lo único que hace es
  // invitarlo a no usar el lector.
  const r = fs.readFileSync(path.join(RAIZ, 'src/rutas/ia_uso.js'), 'utf8');
  assert.match(r, /u\.rol !== 'admin'/);
  assert.match(r, /status\(403\)/);
  // Y el cerrojo está en el router entero, no endpoint por endpoint.
  assert.ok(r.indexOf('router.use(') < r.indexOf("router.get('/'"),
    'el control quedó después del primer endpoint');
});

test('la tabla de la pantalla no genera barra lateral (CLAUDE.md)', () => {
  const i = PANEL.indexOf('id="sec-ia-uso"');
  const sec = PANEL.slice(i, PANEL.indexOf('</style>', i));
  assert.match(sec, /table-layout:fixed/);
  assert.match(sec, /overflow-x:hidden !important/);
  assert.match(sec, /@media\(max-width:900px\)/);
});

// ══ EL «¿CÓMO SE USA?» ════════════════════════════════════════════════════
//
// CLAUDE.md: «si modificás algo en el módulo lo agregás al "cómo se usa" con el
// número de versión». Y el manual se prueba CONTRA EL CÓDIGO, no contra sí
// mismo: lo que hay que clavar es que lo que afirma siga siendo cierto.
const MANUAL = (function () {
  const i = PANEL.indexOf("SG_MANUAL['ia-uso'] = {");
  assert.ok(i > 0, 'no está el manual');
  const j = PANEL.indexOf('\r\n};', i);
  assert.ok(j > i, 'el manual no cierra');
  // Se juntan los strings concatenados: dónde cae cada corte de línea es incidental.
  return PANEL.slice(i, j).replace(/'\s*\r?\n\s*\+ '/g, '');
})();

test('la pantalla tiene su botón, con la clave que el botón busca', () => {
  assert.match(PANEL, /onclick="sgManualAbrir\('ia-uso'\)"/);
  // Y con la MISMA clase que los otros quince: el mismo botón dibujado distinto
  // en cada pantalla es el mismo botón que no se encuentra.
  assert.match(PANEL, /<button class="btn bo bs" onclick="sgManualAbrir\('ia-uso'\)">/);
});

test('lo que explica lleva el V### del PR', () => {
  assert.ok((MANUAL.match(/class="ver">V1094</g) || []).length >= 4,
    'faltan las marcas de versión: ' + (MANUAL.match(/class="ver">V\d+</g) || []).join(' '));
});

test('AFIRMA QUE EL ORDEN ES POR GASTO, no por cantidad', () => {
  // Es lo que hace útil a la pantalla, y lo primero que alguien podría "arreglar"
  // pensando que está mal ordenada.
  assert.match(MANUAL, /ordenada por gasto, no por cantidad/);
  assert.match(MANUAL, /dos lecturas de factura pueden costar más que cien remitos/);
  const r = fs.readFileSync(path.join(RAIZ, 'src/rutas/ia_uso.js'), 'utf8');
  // Se ata a la consulta de POR FUNCIÓN y no a que el ORDER BY exista en alguna parte:
  // hay dos en el archivo (la otra es por modelo), así que romper la que importa dejaba
  // el test en verde. Lo encontró la mutación.
  const porFuncion = r.slice(r.indexOf('const porFuncion'), r.indexOf('const porDia'));
  assert.match(porFuncion, /ORDER BY costo_mil DESC/,
    'la tabla por función dejó de ordenar por gasto: el manual promete otra cosa');
});

test('afirma que el costo es una ESTIMACIÓN y que la factura es la de Anthropic', () => {
  // Si esto no estuviera dicho, el primer desvío contra la factura real se leería
  // como un bug — y no lo es.
  assert.match(MANUAL, /El costo es una ESTIMACIÓN/);
  assert.match(MANUAL, /La factura es la de Anthropic/);
  assert.match(MANUAL, /se congela ahí/);
  // Y el código efectivamente lo congela: guarda el costo, no lo recalcula al leer.
  assert.match(IA, /costo_mil: costoMilesimas\(modelo, msg\.usage\)/);
  const r = fs.readFileSync(path.join(RAIZ, 'src/rutas/ia_uso.js'), 'utf8');
  assert.ok(!/costoMilesimas/.test(r), 'la pantalla recalcula el costo en vez de leerlo');
  // Y la pantalla lo dice donde se lee la tabla, no sólo en el manual.
  assert.match(PANEL, /El costo es una estimación/);
});

test('afirma que las fallidas NO se cobran', () => {
  assert.match(MANUAL, /No se cobran<\/b>, pero son la señal/);
  assert.match(IA, /costo_mil: 0, ms: Date\.now\(\) - t0, ok: false/);
});

test('AFIRMA QUE LA CURVA DISTINGUE «parejo» DE «pasó algo»', () => {
  // Es la pregunta para la que se abre la pantalla cuando algo se rompió.
  assert.match(MANUAL, /Pendiente pareja/);
  assert.match(MANUAL, /Un pico en días puntuales/);
  const r = fs.readFileSync(path.join(RAIZ, 'src/rutas/ia_uso.js'), 'utf8');
  assert.match(r, /GROUP BY dia ORDER BY dia/, 'ya no hay serie por día que dibujar');
  assert.match(PANEL, /class="iu-dia"/);
});

test('afirma que proyecta el gasto al mes', () => {
  assert.match(MANUAL, /a cuánto da por mes a ese ritmo/);
  assert.match(PANEL, /a este ritmo, ' \+ iuUsd\(mes\) \+ ' por mes/);
});

test('afirma que al pie dice lo que NO se usó', () => {
  assert.match(MANUAL, /lo que <b>no se usó<\/b> en el período/);
  const r = fs.readFileSync(path.join(RAIZ, 'src/rutas/ia_uso.js'), 'utf8');
  assert.match(r, /sin_uso:/);
  assert.match(PANEL, /Sin usar en este período/);
});

test('afirma que sólo lo ve un administrador', () => {
  assert.match(MANUAL, /Por qué lo ve sólo un administrador/);
  const r = fs.readFileSync(path.join(RAIZ, 'src/rutas/ia_uso.js'), 'utf8');
  assert.match(r, /u\.rol !== 'admin'/);
});

test('afirma que se puede filtrar sólo lo que falló, con su motivo', () => {
  assert.match(MANUAL, /sólo las que fallaron<\/b>|sólo las que fallaron/);
  assert.match(MANUAL, /con el motivo técnico al lado/);
  const r = fs.readFileSync(path.join(RAIZ, 'src/rutas/ia_uso.js'), 'utf8');
  assert.match(r, /solo_fallidas === '1'/);
});

test('las funciones que el manual nombra son las que el código mide', () => {
  // El manual lista las pantallas que usan IA. Si alguna dejara de estar medida,
  // el párrafo quedaría prometiendo una fila que no existe.
  for (const [frag, clave] of [
    ['lector de remitos', 'ifco-ocr-remito'],
    ['liquidaciones', 'liquidacion-parseo'],
    ['duplicados', 'catalogo-duplicados'],
    ['buscador', 'buscador'],
  ]) {
    assert.ok(MANUAL.toLowerCase().includes(frag), 'el manual no nombra ' + frag);
    assert.ok(FUNCIONES[clave], 'no se mide ' + clave + ', que el manual nombra');
  }
});
