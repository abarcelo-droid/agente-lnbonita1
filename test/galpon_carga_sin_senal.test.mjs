// ══ 📴 GALPÓN · LA CARGA DE KILOS SIN SEÑAL ══════════════════════════════
//
// Andy, 2/11/2026: «en la conexión sin internet aparece como en cero los kilos,
// es medio confuso, mejor mostrarlo de otra forma: que no está conectado a la
// red. O sea funciona todo pero lo muestra en cero».
//
// Y tenía razón en las dos cosas. El total del día lo suma el SERVIDOR, así que
// sin señal lo único que hay es la última foto que bajó —la de antes de empezar
// a cargar, o sea cero— y se mostraba con el mismo número grande que cuando es
// cierto. El operador que acaba de tipear ochenta cajones ve que no se guardó
// ninguno.
//
// Esto se prueba EJECUTANDO el JS de la pantalla contra un DOM de mentira,
// porque lo que puede estar mal se ve idéntico leyendo el código: un cero que
// miente y un cero que es cierto son el mismo cero.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { kilos } from '../src/servicios/galpon.js';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// ── EL DOM DE MENTIRA ────────────────────────────────────────────────────
// Los <select> de la lista de cuadrillas se rearman desde el innerHTML, igual
// que haría el navegador: así galCuadIds() se prueba leyendo lo que
// galCuadPintar() dibujó, y no una lista que el test le pasa por abajo.
function elemento(id) {
  const el = {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    options: [],
    style: { display: '' },
    classList: { add() {}, remove() {}, contains: () => false },
    _html: null,
    _sel: [],
    querySelectorAll(q) {
      if (q !== 'select') return [];
      if (el._html !== el.innerHTML) {
        el._html = el.innerHTML;
        el._sel = (el.innerHTML.match(/<select[\s\S]*?<\/select>/g) || []).map((s) => {
          const m = /<option value="([^"]*)" selected/.exec(s);
          return { value: m ? m[1] : '' };
        });
      }
      return el._sel;
    },
  };
  return el;
}

const IDS = ['gkg-fecha', 'gkg-aviso', 'gkg-tot', 'gkg-cortes', 'gkg-body',
  'gal-kg-cuads', 'gal-kg-cuads-av', 'gal-rap-cuads', 'gal-rap-cuads-av'];

function domFalso() {
  const nodos = {};
  for (const id of IDS) nodos[id] = elemento(id);
  return {
    nodos,
    document: {
      getElementById: (id) => {
        // Los -av los crea galCuadPintar adentro del contenedor; acá existen de
        // entrada porque el DOM de mentira no parsea HTML.
        if (!nodos[id]) nodos[id] = elemento(id);
        return nodos[id];
      },
    },
  };
}

// ── EL JS DE LA PANTALLA, SACADO DE panel.html Y EJECUTADO ──────────────
function corte(desde, hasta) {
  const a = PANEL.indexOf(desde);
  assert.ok(a > 0, 'no encontré en panel.html: ' + desde);
  const b = PANEL.indexOf(hasta, a);
  assert.ok(b > a, 'no encontré el final: ' + hasta);
  return PANEL.slice(a, b);
}

function pantalla(dom, opts) {
  const o = opts || {};
  const codigo = corte('/* ── 👷 DOS CUADRILLAS EN EL MISMO CAJÓN ─',
                       'function galLdAbrir(id){')
    + corte('var GKG = { fecha:null,', 'async function galLdBorrar(id){')
    /* La carga rápida también se EJECUTA. Es la ventana con la que se carga de
       verdad —una tanda son cien cajones— y lo que manda su POST es lo único que
       decide a qué cuadrilla se le anotan esos kilos. */
    + corte('var GRP = { fijo:null,', 'var GLDT = { lotes: [] };');

  const f = new Function('document', 'fetch', 'GOFF', 'window', 'galOffCartel',
    'galKgLlenarLote', 'galBalApuntar', 'GBAL', 'confirm', 'alert', 'setTimeout',
    codigo
    + '\nreturn { GKG, galKgCargar, galKgPintar, galKgPintarTot, galKgPintarCortes,'
    + ' galKgCola, galKgDeCola, galKgLeerKilos, galCuadPintar, galCuadIds,'
    + ' galCuadCrudos, galCuadAgregar, galCuadQuitar, galKgBorrar, galKgNum,'
    + ' galKgGuardar, galKgAbrir, GRP, galRapEmpezar, galRapCargar, galRapPintar };');

  dom.cartel = [];
  dom.alertas = [];
  return f(
    dom.document,
    o.fetch || (() => Promise.reject(new Error('sin fetch en este test'))),
    o.GOFF,
    { LNB_USER: { id: 2, nombre: 'Juan' } },
    (j, donde) => dom.cartel.push([donde, !!(j && j.de_cache)]),
    () => {},
    () => {},
    { usada: false },
    () => (o.confirmar !== false),
    (m) => dom.alertas.push(m),
    () => {},
  );
}

// Una respuesta del servidor, o la que la cola sirve de lo guardado.
function respuesta(j) {
  return () => Promise.resolve({ ok: true, json: () => Promise.resolve(j) });
}
const HOY = '2026-11-20';
const DIA = (extra) => Object.assign({
  ok: true, fecha: HOY, hoy: HOY, cargas: [], resumen: { kilos: 0, ifcos: 0, cargas: 0, a_revisar: 0 },
  propuesta: null, ultimo: null, puede_anular: false,
}, extra || {});

// Una fila de la cola, como la guarda galponOffline.js.
function enCola(uuid, cuerpo, metodo, url) {
  return {
    uuid,
    url: url || '/api/galpon/volcados',
    metodo: metodo || 'POST',
    cuerpo: JSON.stringify(cuerpo || {}),
    creado: 1,
    intentos: 0,
  };
}
const goff = (cola) => ({ pendientes: () => Promise.resolve(cola) });

// ══════════════════════════════════════════════════════════════════════════
// 1 · EL CERO QUE MENTÍA
// ══════════════════════════════════════════════════════════════════════════
test('SIN SEÑAL NO SE MUESTRA UN CERO: se muestra qué está pasando', async () => {
  const dom = domFalso();
  const p = pantalla(dom, {
    // La foto vieja: bajó a la mañana, antes de que se cargara nada.
    fetch: respuesta(DIA({ de_cache: true, cache_cuando: Date.parse('2026-11-20T09:14:00') })),
    GOFF: goff([
      enCola('a', { fecha: HOY, lote_id: 10, kilos: '450', ifcos: 1 }),
      enCola('b', { fecha: HOY, lote_id: 10, kilos: '1.250', ifcos: 1 }),
    ]),
  });
  p.GKG.lotes = [{ id: 10, nombre: 'Cuadro 3' }];
  p.GKG.cuadrillas = [];
  await p.galKgCargar();

  const tot = dom.nodos['gkg-tot'].innerHTML;
  assert.match(tot, /Sin conexión/, 'no dice que no hay señal');
  assert.ok(!/class="v">0</.test(tot), 'sigue mostrando un 0 grande como si fuera el total');
  // Lo que está esperando en este equipo: 450 + 1250, y «1.250» son mil doscientos
  // cincuenta kilos, no uno y cuarto.
  assert.match(tot, /1\.700 kg/, 'no muestra los kilos que están esperando: ' + tot);
  assert.match(tot, /2 cargas/);
  assert.match(tot, /Lo último que se vio/);
  assert.match(tot, /09:14/, 'no dice de cuándo es la foto vieja');
});

test('y el cartel de «esto es viejo» se pinta en esta pantalla', async () => {
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({ de_cache: true })),
    GOFF: goff([]),
  });
  await p.galKgCargar();
  assert.deepEqual(dom.cartel, [['gkg-aviso', true]]);
});

test('CON SEÑAL EL CERO SÍ ES UN CERO, y se muestra como siempre', async () => {
  // Un día sin nada cargado tiene que seguir diciendo 0: el arreglo no puede
  // tapar el caso en que el cero es cierto.
  const dom = domFalso();
  const p = pantalla(dom, { fetch: respuesta(DIA()), GOFF: goff([]) });
  await p.galKgCargar();
  const tot = dom.nodos['gkg-tot'].innerHTML;
  assert.match(tot, /Kilos del día/);
  assert.match(tot, /class="v">0</);
  assert.ok(!/Sin conexión/.test(tot));
  assert.deepEqual(dom.cartel, [['gkg-aviso', false]]);
});

test('LOS DOS NÚMEROS NO SE SUMAN', async () => {
  /* Sumar lo de la cola con la foto daría algo que parece el total del día y no
     lo es: a la foto le falta lo que cargaron los otros equipos desde entonces.
     Un total que parece completo y no lo está es peor que dos números chicos. */
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({ de_cache: true, resumen: { kilos: 800, ifcos: 2, cargas: 2, a_revisar: 0 } })),
    GOFF: goff([enCola('a', { fecha: HOY, lote_id: 10, kilos: '200' })]),
  });
  p.GKG.lotes = [{ id: 10, nombre: 'Cuadro 3' }];
  await p.galKgCargar();
  const tot = dom.nodos['gkg-tot'].innerHTML;
  assert.match(tot, /200 kg/);
  assert.match(tot, /800 kg/);
  assert.ok(!/1\.000/.test(tot), 'sumó la foto vieja con la cola y el total miente');
});

test('LOS CORTES NO SE MUESTRAN A MEDIAS', async () => {
  // El corte por cuadrilla es con lo que se paga un jornal. Sin señal le falta
  // lo que se acaba de cargar, así que se esconde en vez de mostrarse corto.
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({ de_cache: true,
      resumen: { kilos: 800, ifcos: 2, cargas: 2, a_revisar: 0,
                 por_cuadrilla: [{ nombre: 'Norte', kilos: 800 }], por_lote: [] } })),
    GOFF: goff([]),
  });
  await p.galKgCargar();
  assert.equal(dom.nodos['gkg-cortes'].innerHTML, '');
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LO QUE SE CARGÓ SIN SEÑAL SE VE
// ══════════════════════════════════════════════════════════════════════════
test('LA CARGA QUE TODAVÍA NO SALIÓ APARECE EN LA LISTA', async () => {
  // Es el síntoma de fondo: galKgCargar() repintaba la foto vieja y el renglón
  // que se acababa de tipear desaparecía de la pantalla.
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({ de_cache: true })),
    GOFF: goff([enCola('abc', { fecha: HOY, lote_id: 10, cuadrilla_ids: [1, 2],
                                kilos: '450,5', ifcos: 1, producto: 'Damasco' })]),
  });
  p.GKG.lotes = [{ id: 10, nombre: 'Cuadro 3' }];
  p.GKG.cuadrillas = [{ id: 1, nombre: 'Norte' }, { id: 2, nombre: 'Sur' }];
  await p.galKgCargar();

  const html = dom.nodos['gkg-body'].innerHTML;
  assert.match(html, /Cuadro 3/);
  assert.match(html, /Norte \+ Sur/, 'no resuelve los nombres de las cuadrillas');
  assert.match(html, /450,5/);
  assert.match(html, /sin mandar/, 'el renglón de la cola no se distingue del resto');
  assert.match(html, /gkg-enc/);
});

test('UNA CARGA DE OTRO DÍA NO SE CUELA EN EL DÍA QUE SE MIRA', async () => {
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({ de_cache: true })),
    GOFF: goff([enCola('x', { fecha: '2026-11-19', lote_id: 10, kilos: '300' })]),
  });
  p.GKG.lotes = [{ id: 10, nombre: 'Cuadro 3' }];
  await p.galKgCargar();
  assert.match(dom.nodos['gkg-body'].innerHTML, /Todavía no se cargó nada/);
  assert.ok(!/300/.test(dom.nodos['gkg-tot'].innerHTML));
});

test('LO QUE SE BORRÓ SIN SEÑAL DESAPARECE DE LA LISTA', async () => {
  // El renglón que el operador ya sacó no puede seguir ahí hasta que vuelva la
  // señal: lo va a borrar dos veces, o va a creer que el botón no anda.
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({
      de_cache: true,
      cargas: [{ id: 7, fecha: HOY, lote_id: 10, lote_nombre: 'Cuadro 3', kilos: 100 },
               { id: 8, fecha: HOY, lote_id: 10, lote_nombre: 'Cuadro 4', kilos: 200 }],
      resumen: { kilos: 300, ifcos: 0, cargas: 2, a_revisar: 0 },
    })),
    GOFF: goff([enCola('d', {}, 'DELETE', '/api/galpon/volcados/7')]),
  });
  await p.galKgCargar();
  const html = dom.nodos['gkg-body'].innerHTML;
  assert.ok(!/Cuadro 3/.test(html), 'la carga borrada sin señal sigue en la lista');
  assert.match(html, /Cuadro 4/);
});

test('un pedido de la cola que no es una carga no inventa un renglón', async () => {
  // La cola lleva también el lote del día y los datos del lote. Si entraran como
  // cargas, la pantalla mostraría kilos que nadie tipeó.
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({ de_cache: true })),
    GOFF: goff([
      enCola('l', { fecha: HOY, lote_id: 10 }, 'POST', '/api/galpon/lote-dia'),
      enCola('p', { fecha: HOY, lote_id: 10, kilos: '50' }, 'POST', '/api/galpon/procesos'),
      enCola('z', { fecha: HOY, lote_id: 10 }, 'POST', '/api/galpon/volcados?x=1'),
    ]),
  });
  p.GKG.lotes = [{ id: 10, nombre: 'Cuadro 3' }];
  await p.galKgCargar();
  assert.equal(p.GKG.encoladas.length, 1, 'entró algo que no es una carga de kilos');
});

test('si la cola no existe la pantalla no se rompe', async () => {
  // El panel se abre en equipos donde el envoltorio pudo no cargar. Sin este
  // respaldo, galKgCargar() tiraría y la pantalla quedaría en blanco CON señal.
  const dom = domFalso();
  const p = pantalla(dom, { fetch: respuesta(DIA()), GOFF: undefined });
  await p.galKgCargar();
  assert.deepEqual(p.GKG.encoladas, []);
  assert.match(dom.nodos['gkg-tot'].innerHTML, /Kilos del día/);
});

test('UNA COLA QUE FALLA TAMPOCO ROMPE NADA', async () => {
  /* IndexedDB puede estar bloqueada —modo privado, disco lleno, otra pestaña— y eso
     no tiene nada que ver con los kilos del día. Sin el respaldo, galKgCargar() tira
     y la pantalla queda mostrando el mensaje de error en vez de la tabla: o sea que
     un problema del caché deja sin pantalla a alguien que SÍ tiene señal. */
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({ resumen: { kilos: 800, ifcos: 2, cargas: 2, a_revisar: 0 } })),
    GOFF: { pendientes: () => Promise.reject(new Error('IndexedDB bloqueada')) },
  });
  await p.galKgCargar();
  assert.deepEqual(p.GKG.encoladas, []);
  assert.match(dom.nodos['gkg-tot'].innerHTML, /800/,
    'la pantalla se quedó sin los totales porque falló el caché');
  assert.ok(!/IndexedDB/.test(dom.nodos['gkg-body'].innerHTML),
    'el error del caché terminó en el lugar donde van las cargas');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LOS KILOS SE LEEN IGUAL QUE EN EL SERVIDOR
// ══════════════════════════════════════════════════════════════════════════
test('galKgLeerKilos CONTESTA LO MISMO QUE kilos() DEL SERVIDOR', () => {
  /* Son dos copias de la misma regla y eso se paga. La única manera de que no se
     separen es probarlas contra la misma tabla: sin esto, «1.250» se mostraría
     como 1,25 kg sin señal y como 1.250 kg con señal, y el operador no tendría a
     cuál creerle. */
  const dom = domFalso();
  const p = pantalla(dom, { GOFF: goff([]) });
  for (const v of ['450', '450,5', '450.5', '1.250', '1.250,75', '0.615', '0,615',
    '12345.6', '  700 kg ', '700kg', '2.000.000', '', '  ', 'tres', 'abc450',
    '-30', '1,2,3', '.5', '5.', 12345.6, 0.615, 450]) {
    assert.equal(p.galKgLeerKilos(v), kilos(v),
      'la pantalla y el servidor leen distinto ' + JSON.stringify(v));
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LA LISTA DE CUADRILLAS, EJECUTADA
// ══════════════════════════════════════════════════════════════════════════
test('se dibuja un renglón por cuadrilla, y se leen los que quedaron', () => {
  const dom = domFalso();
  const p = pantalla(dom, { GOFF: goff([]) });
  p.GKG.cuadrillas = [{ id: 1, nombre: 'Norte' }, { id: 2, nombre: 'Sur' },
                      { id: 3, nombre: 'Este' }];

  p.galCuadPintar('gal-kg-cuads', [1, 2]);
  assert.deepEqual(p.galCuadIds('gal-kg-cuads'), ['1', '2']);
  // Y se dice cómo se reparte: un número que parece medido y es un promedio es
  // peor que uno que se declara.
  assert.match(dom.nodos['gal-kg-cuads-av'].innerHTML, /partes iguales/);
  assert.match(dom.nodos['gal-kg-cuads-av'].innerHTML, /entre las 2/);
});

test('con UNA sola no se habla de reparto, y no hay × para sacarla', () => {
  // Con un renglón solo, sacarlo es elegir «— sin cuadrilla —»: dos maneras de
  // hacer lo mismo es una de más.
  const dom = domFalso();
  const p = pantalla(dom, { GOFF: goff([]) });
  p.GKG.cuadrillas = [{ id: 1, nombre: 'Norte' }];
  p.galCuadPintar('gal-kg-cuads', [1]);
  assert.equal(dom.nodos['gal-kg-cuads-av'].innerHTML, '');
  assert.ok(!/galCuadQuitar/.test(dom.nodos['gal-kg-cuads'].innerHTML));
});

test('EN BLANCO ES UN RENGLÓN VACÍO, no cero renglones', () => {
  const dom = domFalso();
  const p = pantalla(dom, { GOFF: goff([]) });
  p.GKG.cuadrillas = [{ id: 1, nombre: 'Norte' }];
  p.galCuadPintar('gal-kg-cuads', []);
  assert.deepEqual(p.galCuadCrudos('gal-kg-cuads'), ['']);
  assert.deepEqual(p.galCuadIds('gal-kg-cuads'), []);
  assert.match(dom.nodos['gal-kg-cuads'].innerHTML, /otra cuadrilla/,
    'no se puede agregar la segunda');
});

test('agregar deja lo elegido y suma un renglón vacío', () => {
  // Rearmar la lista perdiendo lo ya elegido obligaría a volver a elegirlo, que
  // es exactamente cuando alguien se equivoca de cuadrilla.
  const dom = domFalso();
  const p = pantalla(dom, { GOFF: goff([]) });
  p.GKG.cuadrillas = [{ id: 1, nombre: 'Norte' }, { id: 2, nombre: 'Sur' }];
  p.galCuadPintar('gal-kg-cuads', [1]);
  p.galCuadAgregar('gal-kg-cuads');
  assert.deepEqual(p.galCuadCrudos('gal-kg-cuads'), ['1', '']);
  assert.deepEqual(p.galCuadIds('gal-kg-cuads'), ['1']);
});

test('quitar saca LA QUE SE APRETÓ, no la última', () => {
  const dom = domFalso();
  const p = pantalla(dom, { GOFF: goff([]) });
  p.GKG.cuadrillas = [{ id: 1, nombre: 'Norte' }, { id: 2, nombre: 'Sur' },
                      { id: 3, nombre: 'Este' }];
  p.galCuadPintar('gal-kg-cuads', [1, 2, 3]);
  p.galCuadQuitar('gal-kg-cuads', 1);
  assert.deepEqual(p.galCuadIds('gal-kg-cuads'), ['1', '3']);
});

test('la repetida se manda una sola vez', () => {
  // Dejarla pasar dos veces partiría los kilos en dos mitades para la MISMA
  // cuadrilla, y la pantalla diría «Norte + Norte».
  const dom = domFalso();
  const p = pantalla(dom, { GOFF: goff([]) });
  p.GKG.cuadrillas = [{ id: 1, nombre: 'Norte' }];
  p.galCuadPintar('gal-kg-cuads', [1, 1]);
  assert.deepEqual(p.galCuadIds('gal-kg-cuads'), ['1']);
});

test('un contenedor que no existe no rompe nada', () => {
  const dom = domFalso();
  const p = pantalla(dom, { GOFF: goff([]) });
  dom.document.getElementById = () => null;
  p.galCuadPintar('no-existe', [1]);
  assert.deepEqual(p.galCuadIds('no-existe'), []);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · LA × Y EL ✎ DE CADA RENGLÓN
// ══════════════════════════════════════════════════════════════════════════
test('EL ID VA ENTRE COMILLAS: el de la cola es texto', async () => {
  /* Sin comillas, el onclick de una carga encolada queda
     `galKgBorrar(enc:9f…)`, que es un error de sintaxis: el botón no hace nada y
     no se ve por qué. */
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({
      de_cache: true,
      cargas: [{ id: 8, fecha: HOY, lote_id: 10, lote_nombre: 'Cuadro 4', kilos: 200 }],
      resumen: { kilos: 200, ifcos: 0, cargas: 1, a_revisar: 0 },
    })),
    GOFF: goff([enCola('abc', { fecha: HOY, lote_id: 10, kilos: '450' })]),
  });
  p.GKG.lotes = [{ id: 10, nombre: 'Cuadro 3' }];
  await p.galKgCargar();
  const html = dom.nodos['gkg-body'].innerHTML;
  assert.match(html, /galKgBorrar\('enc:abc'\)/);
  assert.match(html, /galKgBorrar\('8'\)/);
  // Y la de la cola NO se puede corregir: no tiene id del servidor todavía.
  assert.ok(!/galKgAbrir\('enc:abc'\)/.test(html));
  assert.match(html, /galKgAbrir\('8'\)/);
});

test('LA × NO SE OFRECE EN UN DÍA CERRADO si no se puede anular', async () => {
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({
      fecha: '2026-11-19', hoy: HOY, puede_anular: false,
      cargas: [{ id: 8, fecha: '2026-11-19', lote_id: 10, lote_nombre: 'Cuadro 4', kilos: 200 }],
      resumen: { kilos: 200, ifcos: 0, cargas: 1, a_revisar: 0 },
    })),
    GOFF: goff([]),
  });
  await p.galKgCargar();
  const html = dom.nodos['gkg-body'].innerHTML;
  assert.ok(!/galKgBorrar/.test(html), 'ofrece una × que el servidor va a rebotar con 403');
  assert.match(html, /galKgAbrir/, 'tampoco deja corregir, y corregir sí se puede');
});

test('pero con permiso de anular sí, en cualquier día', async () => {
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({
      fecha: '2026-11-19', hoy: HOY, puede_anular: true,
      cargas: [{ id: 8, fecha: '2026-11-19', lote_id: 10, lote_nombre: 'Cuadro 4', kilos: 200 }],
      resumen: { kilos: 200, ifcos: 0, cargas: 1, a_revisar: 0 },
    })),
    GOFF: goff([]),
  });
  await p.galKgCargar();
  assert.match(dom.nodos['gkg-body'].innerHTML, /galKgBorrar\('8'\)/);
});

test('y en el día de HOY la × está para cualquiera', async () => {
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({
      puede_anular: false,
      cargas: [{ id: 8, fecha: HOY, lote_id: 10, lote_nombre: 'Cuadro 4', kilos: 200 }],
      resumen: { kilos: 200, ifcos: 0, cargas: 1, a_revisar: 0 },
    })),
    GOFF: goff([]),
  });
  await p.galKgCargar();
  assert.match(dom.nodos['gkg-body'].innerHTML, /galKgBorrar\('8'\)/);
});

test('CON DOS CUADRILLAS EL RENGLÓN DICE CUÁNTO LE TOCÓ A CADA UNA', async () => {
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({
      cargas: [{ id: 8, fecha: HOY, lote_id: 10, lote_nombre: 'Cuadro 4', kilos: 700,
                 cuadrilla: 'Norte + Sur',
                 cuadrillas: [{ cuadrilla_id: 1, cuadrilla: 'Norte', kilos: 350 },
                              { cuadrilla_id: 2, cuadrilla: 'Sur', kilos: 350 }] }],
      resumen: { kilos: 700, ifcos: 0, cargas: 1, a_revisar: 0 },
    })),
    GOFF: goff([]),
  });
  await p.galKgCargar();
  const html = dom.nodos['gkg-body'].innerHTML;
  assert.match(html, /Norte \+ Sur/);
  assert.match(html, /Norte 350/, 'no dice cuánto le tocó a cada una');
  assert.match(html, /Sur 350/);
});

test('con UNA sola no se escribe un reparto que no existe', async () => {
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: respuesta(DIA({
      cargas: [{ id: 8, fecha: HOY, lote_id: 10, lote_nombre: 'Cuadro 4', kilos: 700,
                 cuadrilla: 'Norte',
                 cuadrillas: [{ cuadrilla_id: 1, cuadrilla: 'Norte', kilos: 700 }] }],
      resumen: { kilos: 700, ifcos: 0, cargas: 1, a_revisar: 0 },
    })),
    GOFF: goff([]),
  });
  await p.galKgCargar();
  assert.ok(!/Norte 700/.test(dom.nodos['gkg-body'].innerHTML));
});

test('BORRAR UNA DE LA COLA MANDA SU ID LOCAL, no un número inventado', async () => {
  const pedidos = [];
  const dom = domFalso();
  const p = pantalla(dom, {
    fetch: (u, o) => {
      pedidos.push([String(u), (o || {}).method || 'GET']);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(
        String(u).indexOf('DELETE') >= 0 ? { ok: true } : DIA({ de_cache: true })) });
    },
    GOFF: goff([enCola('abc', { fecha: HOY, lote_id: 10, kilos: '450' })]),
  });
  p.GKG.lotes = [{ id: 10, nombre: 'Cuadro 3' }];
  await p.galKgCargar();
  await p.galKgBorrar('enc:abc');
  assert.ok(pedidos.some((x) => x[0] === '/api/galpon/volcados/enc%3Aabc' && x[1] === 'DELETE'),
    'no mandó el id local: ' + JSON.stringify(pedidos));
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · LO QUE LAS DOS VENTANAS MANDAN DE VERDAD
// ══════════════════════════════════════════════════════════════════════════
// Que la lista se dibuje bien y que el servidor reparta bien no alcanza: en el
// medio está el POST, y si manda la lista vacía los kilos entran SIN cuadrilla.
// Eso no se ve en la pantalla —la carga aparece, con sus kilos— y aparece a fin
// de mes, cuando el kg por jornal de una cuadrilla sale en cero.

function conCampos(dom, ids) {
  for (const id of ids) dom.document.getElementById(id);
  return dom;
}

const CAMPOS_KG = ['gal-kg-error', 'gal-kg-ok', 'gal-kg-lote', 'gal-kg-fecha',
  'gal-kg-prod', 'gal-kg-kilos', 'gal-kg-ifcos', 'gal-kg-obs', 'gal-kg-viaje',
  'gal-kg-san', 'gal-kg-ok-btn', 'gal-kg-tit', 'gal-kg-salir', 'gal-kg-modal'];

test('LA VENTANA LARGA MANDA LAS CUADRILLAS ELEGIDAS', async () => {
  const cuerpos = [];
  const dom = conCampos(domFalso(), CAMPOS_KG);
  const p = pantalla(dom, {
    fetch: (u, o) => {
      if ((o || {}).method === 'POST') cuerpos.push(JSON.parse(o.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(
        (o || {}).method === 'POST' ? { ok: true, fila: { kilos: 700 } } : DIA()) });
    },
    GOFF: goff([]),
  });
  p.GKG.cuadrillas = [{ id: 1, nombre: 'Norte' }, { id: 2, nombre: 'Sur' }];
  dom.nodos['gal-kg-lote'].value = '10';
  dom.nodos['gal-kg-kilos'].value = '700';
  p.galCuadPintar('gal-kg-cuads', [1, 2]);

  await p.galKgGuardar();
  assert.equal(cuerpos.length, 1, 'no mandó la carga');
  assert.deepEqual(cuerpos[0].cuadrilla_ids, ['1', '2'],
    'la ventana larga no manda las cuadrillas: los kilos entran sin atribuir');
});

test('y si no se eligió ninguna, manda la lista vacía — no un renglón en blanco', async () => {
  const cuerpos = [];
  const dom = conCampos(domFalso(), CAMPOS_KG);
  const p = pantalla(dom, {
    fetch: (u, o) => {
      if ((o || {}).method === 'POST') cuerpos.push(JSON.parse(o.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(
        (o || {}).method === 'POST' ? { ok: true, fila: { kilos: 700 } } : DIA()) });
    },
    GOFF: goff([]),
  });
  p.GKG.cuadrillas = [{ id: 1, nombre: 'Norte' }];
  dom.nodos['gal-kg-lote'].value = '10';
  dom.nodos['gal-kg-kilos'].value = '700';
  p.galCuadPintar('gal-kg-cuads', []);
  await p.galKgGuardar();
  assert.deepEqual(cuerpos[0].cuadrilla_ids, []);
});

test('LA CARGA RÁPIDA MANDA LAS CUADRILLAS DE LA TANDA, en cada cajón', async () => {
  // Una tanda son cien cajones seguidos: si el encabezado no viaja, son cien
  // renglones sin cuadrilla y nadie los va a volver a tipear.
  const cuerpos = [];
  const dom = conCampos(domFalso(), ['gal-rap-serror', 'gal-rap-lote', 'gal-rap-fecha',
    'gal-rap-prod', 'gal-rap-obs', 'gal-rap-setup', 'gal-rap-carga', 'gal-rap-tit',
    'gal-rap-sub', 'grp-error', 'grp-kilos', 'grp-btn', 'grp-tanda', 'gal-rap-modal',
    'gal-rap-deotro']);
  const p = pantalla(dom, {
    fetch: (u, o) => {
      if ((o || {}).method === 'POST') cuerpos.push(JSON.parse(o.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(
        (o || {}).method === 'POST'
          ? { ok: true, id: cuerpos.length, fila: { kilos: 700, ifcos: 1 } }
          : DIA()) });
    },
    GOFF: goff([]),
  });
  p.GKG.cuadrillas = [{ id: 1, nombre: 'Norte' }, { id: 2, nombre: 'Sur' }];
  dom.nodos['gal-rap-lote'].value = '10';
  dom.nodos['gal-rap-lote'].options = [{ textContent: 'Cuadro 3 · La Esperanza' }];
  dom.nodos['gal-rap-lote'].selectedIndex = 0;
  p.galCuadPintar('gal-rap-cuads', [1, 2]);
  p.galRapEmpezar();
  assert.deepEqual(p.GRP.fijo.cuadrilla_ids, ['1', '2']);
  assert.equal(p.GRP.fijo.cuadrilla, 'Norte + Sur',
    'el cartel fijo no dice las dos cuadrillas con las que se está cargando');

  dom.nodos['grp-kilos'].value = '700';
  await p.galRapCargar();
  dom.nodos['grp-kilos'].value = '650';
  await p.galRapCargar();
  assert.equal(cuerpos.length, 2);
  for (const c of cuerpos) {
    assert.deepEqual(c.cuadrilla_ids, ['1', '2'],
      'la carga rápida no manda las cuadrillas: cien cajones sin atribuir');
  }
});
