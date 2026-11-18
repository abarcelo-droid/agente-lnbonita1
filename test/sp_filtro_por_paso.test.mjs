// ══ «¿QUÉ ME FALTA FIRMAR?» (V1153) ═══════════════════════════════════════
//
// Pablo, 18/11/2026: «agregame un filtro del "qué paso está", así filtro por los
// que me falta firmar».
//
// El filtro YA existía. Se llamaba «Cualquier paso», y con ese nombre no se
// adivina que recorta por el paso en el que la solicitud está parada AHORA —se
// lee como un "cualquiera" más, al lado de «Cualquiera que pidió»—. Lo que hacía
// falta no era un filtro nuevo sino que el que está diga qué hace.
//
// Y mirándolo apareció el agujero de al lado, que es el que importa de verdad:
// la bandeja se arma en JS DESPUÉS del LIMIT 400 de la consulta. Con 521
// solicitudes, las 121 más viejas no se miraban nunca, así que «Me toca a mí 32»
// podía estar dejando afuera una orden parada esperando una firma desde hace
// meses — justo la que hay que ver. El contador decía 32 como si fueran todas.
//
// Los dos se prueban EJECUTANDO: el armado del WHERE del router corre de verdad
// contra cada solapa, y el recorte se reproduce con la consulta real sobre una
// base con 520 filas. Un assert sobre el texto no habría distinguido "la fila
// aparece" de "la fila la recorta el tope".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const SP = leer('src/rutas/sp.js');
const MOTOR = leer('src/servicios/sp_motor.js');
const PANEL = leer('src/panel.html');
const DDL = leer('src/servicios/db_sp.js');

// El cuerpo de una función, contando llaves: así el test corre el código de
// verdad en vez de una copia escrita al lado.
function fuente(txt, firma) {
  const i = txt.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  // El cuerpo arranca en la primera llave que ABRE algo: el `ctx = {}` de un
  // parámetro por defecto está antes y no es el cuerpo.
  let k = i;
  for (;;) {
    k = txt.indexOf('{', k);
    assert.ok(k >= 0, 'no abre: ' + firma);
    if (txt[k + 1] !== '}') break;
    k += 2;
  }
  let prof = 0;
  for (; k < txt.length; k++) {
    if (txt[k] === '{') prof++;
    else if (txt[k] === '}') { prof--; if (prof === 0) break; }
  }
  return txt.slice(i, k + 1);
}

// ══ 1 · EL DESPLEGABLE DICE QUÉ HACE ══════════════════════════════════════

test('el desplegable del paso se llama por lo que hace, no «Cualquier paso»', () => {
  const f = fuente(PANEL, 'function spFiltrosRender(vista, r)');
  assert.match(f, /sel\('sp-f-paso-' \+ vista, 'paso', 'En qué paso está: todos'/);
  assert.ok(!/'Cualquier paso'/.test(f), 'quedó el nombre viejo en la barra de filtros');
});

// ── La barra de filtros, ejecutada ────────────────────────────────────────
// Se corre la función de verdad: lo que se mide es el HTML que sale, no que el
// código mencione la variable `bandeja`.
const PASOS = [
  { clave: 'solicitud', nombre: 'Pedida' },
  { clave: 'autorizacion', nombre: 'Autorización' },
  { clave: 'fechas', nombre: 'Fechas de pago' },
  { clave: 'confeccion', nombre: 'Confección' },
  { clave: 'firma', nombre: 'Firma' },
  { clave: 'comprobantes', nombre: 'Comprobantes' },
];

function barra(vista, filtroInicial) {
  const src = /var SP_ESTADOS = \[[\s\S]*?\];/.exec(PANEL)[0]
    + '\n' + fuente(PANEL, 'function spFiltro(vista)')
    + '\n' + fuente(PANEL, 'function spFiltrosRender(vista, r)')
    + '\nreturn spFiltrosRender(vista, r);';
  const SPfake = { filtros: {}, listas: {} };
  SPfake.listas[vista] = [];
  if (filtroInicial) SPfake.filtros[vista] = filtroInicial;
  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return new Function('SP', 'spEsc', 'vista', 'r', src)(
    SPfake, esc, vista, { opciones: { pasos: PASOS, solicitantes: [] }, total: 10 });
}

test('y en las cuatro solapas ofrece los pasos del circuito vigente', () => {
  for (const vista of ['pendiente', 'otros', 'mias', 'todas']) {
    const h = barra(vista);
    assert.ok(h.indexOf('id="sp-f-paso-' + vista + '"') >= 0, vista + ': no está el filtro de paso');
    assert.ok(h.indexOf('En qué paso está: todos') >= 0, vista + ': no dice qué filtra');
    assert.ok(h.indexOf('>Firma<') >= 0, vista + ': no se puede elegir Firma');
  }
});

test('el estado NO se ofrece en las bandejas, donde sólo puede devolver vacío', () => {
  // Una solicitud cerrada no le toca a nadie: en «Me toca a mí» y «Dirigidas a
  // otro» elegir «Completadas» sólo podía dar la lista vacía, y una lista vacía
  // se lee como que el panel se rompió, no como que no hay nada.
  for (const vista of ['pendiente', 'otros']) {
    const h = barra(vista);
    assert.ok(h.indexOf('id="sp-f-est-' + vista + '"') < 0, vista + ': sigue ofreciendo el estado');
    assert.ok(h.indexOf('Todos los estados') < 0, vista + ': sigue ofreciendo el estado');
  }
  for (const vista of ['mias', 'todas']) {
    const h = barra(vista);
    assert.ok(h.indexOf('id="sp-f-est-' + vista + '"') >= 0, vista + ': se perdió el filtro de estado');
    assert.ok(h.indexOf('Completadas') >= 0, vista + ': se perdieron los estados');
  }
});

test('el paso elegido queda marcado al volver a pintar la barra', () => {
  // Sin esto el desplegable vuelve a «todos» en cada carga y parece que el
  // filtro no se aplicó, aunque la lista venga recortada.
  const h = barra('pendiente', { q: '', estado: '', paso: 'firma', solicitante_id: '', aviso: '' });
  assert.match(h, /<option value="firma" selected>Firma<\/option>/);
  assert.ok(h.indexOf('✕ limpiar') >= 0, 'con un filtro puesto no ofrece limpiarlo');
});

// ══ 2 · EL WHERE DEL ROUTER, EJECUTADO ════════════════════════════════════

function donde(vista, query, userId = 7) {
  const ini = SP.indexOf('  const params = [soc];');
  assert.ok(ini > 0, 'no está el armado de params');
  const fin = SP.indexOf('params.push(like, like, like, like);', ini);
  assert.ok(fin > ini, 'no está el final del armado del where');
  const bloque = SP.slice(ini, SP.indexOf('\n  }', fin) + 4);
  return new Function('soc', 'vista', 'req',
    bloque + '\n  return { where: where, params: params };')(1, vista, { query: query || {}, user: { id: userId } });
}

test('las bandejas se recortan a lo que está en curso, y las otras dos no', () => {
  assert.match(donde('pendiente').where, /AND s\.estado_global = 'en_curso'/);
  assert.match(donde('otros').where, /AND s\.estado_global = 'en_curso'/);
  assert.ok(!/en_curso/.test(donde('mias').where), '«Mis solicitudes» perdió lo cerrado');
  assert.ok(!/en_curso/.test(donde('todas').where), '«Todas» dejó de mostrar todo');
});

test('el filtro de paso mira dónde está PARADA, no por dónde pasó', () => {
  // s.paso_actual_clave es el paso de AHORA. Por dónde pasó está en sp_eventos,
  // y ese no es el filtro que se pidió: «me falta firmar» es estar en Firma hoy.
  const r = donde('pendiente', { paso: 'firma' });
  assert.match(r.where, /AND s\.paso_actual_clave = \?/);
  assert.ok(r.params.indexOf('firma') >= 0, 'no viaja la clave del paso');
  assert.ok(!/sp_eventos/.test(r.where), 'el filtro mira el historial en vez del paso actual');
});

test('«Mis solicitudes» sigue siendo sólo lo mío, y las bandejas no', () => {
  assert.ok(donde('mias').params.indexOf(7) >= 0, 'se perdió el filtro por solicitante');
  assert.equal(donde('pendiente').params.length, 1, 'la bandeja se ató al solicitante');
});

// ══ 3 · POR QUÉ EL RECORTE NUEVO NO CAMBIA NI UNA FILA ════════════════════

test('lo cerrado nunca tuvo acciones, así que filtrarlo no saca nada', () => {
  // Es la razón por la que la condición es segura. Si alguien saca este return,
  // una solicitud cerrada podría tener acciones y el recorte en SQL empezaría a
  // esconder filas de verdad — por eso falla acá y no en producción.
  const f = fuente(MOTOR, 'export function accionesDisponibles(def, solicitud, usuario, ctx = {})');
  assert.match(f, /if \(solicitud\.estado_global !== 'en_curso'\) return \[\];/);
  // Y el otro motivo por el que una fila entra a la bandeja: el bloqueo por
  // segregación de funciones, que tampoco se calcula fuera de «en curso».
  assert.match(SP, /habilitado && s\.estado_global === 'en_curso'\)\s*\r?\n?\s*\? bloqueadoPorSoD/);
  // Y la bandeja no mira nada más que esas dos cosas.
  assert.match(SP, /filas\.filter\(s => \(s\.acciones\.length > 0 \|\| s\.bloqueo_sod\) && !s\.dirigida_a_otro\)/);
  assert.match(SP, /filas\.filter\(s => s\.acciones\.length > 0 && s\.dirigida_a_otro\)/);
});

// ══ 4 · EL RECORTE DE 400, REPRODUCIDO ════════════════════════════════════

function base() {
  const db = new DatabaseSync(':memory:');
  const i = DDL.indexOf('CREATE TABLE IF NOT EXISTS sp_solicitudes (');
  assert.ok(i > 0, 'no está el DDL de sp_solicitudes');
  db.exec(DDL.slice(i, DDL.indexOf('\n  );', i) + 4)
    .replace(/REFERENCES [a-z_]+\([a-z_]+\)/g, ''));
  db.exec('CREATE TABLE sp_eventos (id INTEGER PRIMARY KEY, solicitud_id INTEGER)');
  const ins = db.prepare(`INSERT INTO sp_solicitudes
    (id, sociedad_id, numero, flujo_version_id, def_snapshot_json, solicitante_id,
     proveedor_texto, concepto, monto, moneda, paso_actual_clave, estado_global, prioridad)
    VALUES (?,1,?,1,'{}',7,'Proveedor','Concepto',100,'ARS',?,?,'normal')`);
  // La nº 1 es la más vieja y es la que espera una firma. Arriba de ella hay 519
  // cerradas, bastante más que el tope de 400.
  ins.run(1, 'SP-2026-0001', 'firma', 'en_curso');
  for (let n = 2; n <= 520; n++) {
    ins.run(n, 'SP-2026-' + String(n).padStart(4, '0'), 'comprobantes', 'aprobada_final');
  }
  return db;
}

// La consulta REAL del router, con su tope y su orden.
function consulta(where) {
  const m = /const sql = `([\s\S]*?)`;/.exec(SP);
  assert.ok(m, 'no está la consulta de la bandeja');
  assert.match(m[1], /LIMIT 400/, 'cambió el tope: revisá este test');
  return m[1].replace('${where}', where);
}

test('la orden vieja esperando firma entra en la bandeja, con 519 cerradas arriba', () => {
  const db = base();
  const { where, params } = donde('pendiente');
  const filas = db.prepare(consulta(where)).all(...params);
  assert.ok(filas.some((f) => f.id === 1),
    'la que espera firma no llegó: la recortó el tope de 400');
  assert.equal(filas.length, 1, 'entró algo que no está en curso');
  db.close();
});

test('y sin el recorte en SQL se perdía: el tope la dejaba afuera', () => {
  // La demostración de que el arreglo hacía falta. Este es el WHERE que tenía
  // «Me toca a mí» antes: el mismo que hoy tiene «Todas».
  const db = base();
  const { where, params } = donde('todas');
  const filas = db.prepare(consulta(where)).all(...params);
  assert.equal(filas.length, 400, 'el tope dejó de ser 400');
  assert.ok(!filas.some((f) => f.id === 1),
    'la base de prueba no reproduce el recorte: revisá cuántas filas se insertan');
  db.close();
});

test('y filtrando por paso aparece igual, porque el recorte va después del filtro', () => {
  // Es lo que ya decía el comentario del router sobre por qué los filtros van en
  // SQL. Vale también para el caso viejo: buscar el paso la encuentra.
  const db = base();
  const { where, params } = donde('todas', { paso: 'firma' });
  const filas = db.prepare(consulta(where)).all(...params);
  assert.deepEqual(filas.map((f) => f.id), [1]);
  db.close();
});

// ══ 5 · LAS OPCIONES DEL DESPLEGABLE ══════════════════════════════════════

test('los pasos salen del circuito vigente, no de una lista escrita a mano', () => {
  // Si mañana se agrega un paso al circuito tiene que aparecer solo. Y los pasos
  // finales se dejan afuera: no son un lugar donde algo esté esperando.
  const h = fuente(SP, "router.get('/solicitudes'");
  assert.match(h, /const v = versionActiva\(\);/);
  assert.match(h, /armarSnapshot\(v\.id\)\.pasos \|\| \[\]\)\s*\r?\n?\s*\.filter\(p => p\.tipo !== 'final_ok' && p\.tipo !== 'final_rechazo'\)/);
  assert.match(h, /\.map\(p => \(\{ clave: p\.clave, nombre: p\.nombre \}\)\)/);
  // Y «Firma» es un paso de verdad del circuito sembrado, así que el desplegable
  // lo va a tener: es la respuesta literal a lo que se pidió.
  assert.match(leer('src/servicios/db_sp.js'), /\['firma',\s+'Firma',/);
});

// ══ 6 · EL MANUAL ═════════════════════════════════════════════════════════

test('el ¿Cómo se usa? lo cuenta, con su versión, y lo que afirma es cierto', () => {
  const f = fuente(PANEL, 'function spAyudaHtml(d)');
  assert.match(f, /Cómo encontrar lo tuyo en la lista/);
  assert.match(f, /V1153/);

  // Afirma que el desplegable se llama así →
  assert.match(f, /«En qué paso está»/);
  assert.match(fuente(PANEL, 'function spFiltrosRender(vista, r)'), /'En qué paso está: todos'/);

  // Afirma que recorta por dónde está AHORA →
  assert.match(f, /está parada <strong>ahora<\/strong>/);
  assert.match(SP, /AND s\.paso_actual_clave = \?/);

  // Afirma que el de estado sólo está en Mis solicitudes y en Todas →
  assert.match(f, /aparece sólo en <strong>Mis solicitudes<\/strong> y en <strong>Todas<\/strong>/);
  assert.ok(barra('mias').indexOf('Todos los estados') >= 0);
  assert.ok(barra('pendiente').indexOf('Todos los estados') < 0);

  // Afirma que lo cerrado lo descarta la consulta ANTES del tope. No dice "no
  // recorta nunca", que sería falso: el LIMIT 400 sigue ahí. Lo que es cierto y
  // se puede clavar es que la condición va en el WHERE, no después.
  assert.match(f, /lo cerrado lo descarta la consulta, antes del tope/);
  assert.match(donde('pendiente').where, /AND s\.estado_global = 'en_curso'/);
  const sqlReal = consulta(donde('pendiente').where);
  assert.ok(sqlReal.indexOf("estado_global = 'en_curso'") < sqlReal.indexOf('LIMIT 400'),
    'el recorte quedó después del tope: el manual estaría mintiendo');

  // Y nombra el paso de firma leyéndolo del circuito, no escrito a mano: si
  // alguien lo renombra, el manual lo dice bien solo.
  assert.match(f, /var pFir = spPasoDe\(d, 'firma'\);/);
  assert.match(f, /spEsc\(pFir \? pFir\.nombre : 'Firma'\)/);
});
