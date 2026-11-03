// ══ 📷 GALPÓN · LA VENTANA QUE REVISA LA PLANILLA ════════════════════════
//
// El paso del medio es el que importa: leer no guarda, y lo que la IA devuelve
// es una propuesta que alguien compara contra el papel antes de confirmar.
// Esta ventana ES ese paso, así que se prueba EJECUTÁNDOLA — con un DOM de
// mentira y un fetch de mentira — y no leyendo el código.
//
// Lo que puede salir mal acá no se ve en pantalla:
//
//   · que se cargue un renglón sin peso. Entra como 0 y baja el promedio.
//   · que el total de arriba no sea el de lo que se va a cargar. Es el único
//     control contra una coma leída de más, y si miente no sirve para nada.
//   · que apretar dos veces duplique los veintiún renglones.
//   · que el viaje salga del encabezado y no de cada fila: once cargas
//     atribuidas al camión equivocado, que es lo que pasaría con la foto del
//     2/11 — tiene el final de un camión y el principio del siguiente.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// ── EL DOM DE MENTIRA ────────────────────────────────────────────────────
function elemento(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '', disabled: false,
    options: [], selectedIndex: -1, files: [],
    style: { display: '' },
    classList: { add() {}, remove() {}, contains: () => false },
    getAttribute: () => null,
    click() { el.clicado = (el.clicado || 0) + 1; },
    querySelectorAll(q) {
      if (q !== 'select') return [];
      return (el.innerHTML.match(/<select[\s\S]*?<\/select>/g) || []).map((x) => {
        const m = /<option value="([^"]*)" selected/.exec(x);
        return { value: m ? m[1] : '' };
      });
    },
  };
  return el;
}

function domFalso() {
  const nodos = {};
  return {
    nodos,
    document: {
      getElementById: (id) => {
        if (!nodos[id]) nodos[id] = elemento(id);
        return nodos[id];
      },
    },
  };
}

function corte(desde, hasta) {
  const a = PANEL.indexOf(desde);
  assert.ok(a > 0, 'no encontré en panel.html: ' + desde);
  const b = PANEL.indexOf(hasta, a);
  assert.ok(b > a, 'no encontré el final: ' + hasta);
  return PANEL.slice(a, b);
}

// El JS de la ventana, sacado de panel.html y ejecutado de verdad.
function pantalla(dom, opts) {
  const o = opts || {};
  const codigo =
    // Los helpers que la ventana usa: el escape, el formato de número, el uuid.
    corte('function galKgEsc(s){', 'async function galKgInit(){')
    // La lista de cuadrillas y el lector de kilos.
    + corte('/* ── 👷 DOS CUADRILLAS EN EL MISMO CAJÓN ─', 'function galLdAbrir(id){')
    /* Y la ventana. Arranca en var GFOT y no en el banner de arriba: el banner es el
       ABRIR de un comentario de bloque, y cortar ahí deja el cierre sin su apertura —
       el new Function revienta con «Invalid or unexpected token», que no dice nada. */
    + corte('var GFOT = {', '\r\n/* ═══');

  const f = new Function('document', 'fetch', 'window', 'GKG', 'galKgLlenarLote',
    'galKgCargar', 'paComprimirImagen',
    codigo
    + '\nreturn { GFOT, galFotoAbrir, galFotoCerrar, galFotoElegida, galFotoLeer,'
    + ' galFotoPintar, galFotoFila, galFotoTotal, galFotoCargar, galFotoOtra,'
    + ' galFotoAvisos, galCuadPintar, galCuadIds, galKgLeerKilos };');

  dom.recargas = 0;
  return f(
    dom.document,
    o.fetch || (() => Promise.reject(new Error('sin fetch en este test'))),
    { LNB_USER: { id: 2, nombre: 'Juan' } },
    Object.assign({
      fecha: '2026-11-20', hoy: '2026-11-20', cargas: [], resumen: null,
      propuesta: null, ultimo: null,
      lotes: [{ id: 10, nombre: 'Cuadro 3', finca: 'La Estación' }],
      cuadrillas: [{ id: 1, nombre: 'Norte' }, { id: 2, nombre: 'Sur' }],
    }, o.GKG || {}),
    () => {},
    () => { dom.recargas++; return Promise.resolve(); },
    o.comprimir || ((file) => Promise.resolve({
      dataUrl: 'data:image/jpeg;base64,AAAA', newSize: 120000, originalSize: 3000000 })),
  );
}

// Lo que devuelve el servidor leyendo la primera foto del 2/11, ya normalizado.
const FILA = (viaje, numero, kilos, extra) => Object.assign(
  { viaje, finca: 'La Estación', lote: null, numero, kilos,
    sanitario: null, observacion: null, ok: kilos != null && kilos > 0, duda: null },
  extra || {});

/* UNA FUNCIÓN Y NO UNA CONSTANTE. La ventana MUTA las filas —les pone el uuid, las
   marca cargadas, las destilda— así que un objeto compartido entre tests hace que el
   tercero reciba lo que le dejó el primero. Pasó: tres tests en verde y cuatro en rojo
   sin que el código tuviera nada. */
const LEIDO = () => ({
  ok: true, fecha: null, cultivo: null, avisos: [],
  filas: [FILA(13, 48, 15.9, { sanitario: 'B' }), FILA(14, 1, 9.7, { sanitario: 'B' }),
          FILA(14, 2, 15.4)],
});

function conLectura(leido, opts) {
  const o = opts || {};
  const pedidos = [];
  const dom = domFalso();
  const p = pantalla(dom, Object.assign({
    fetch: (u, x) => {
      const body = x && x.body ? JSON.parse(x.body) : null;
      pedidos.push([String(u), body]);
      if (String(u).indexOf('leer-foto') >= 0) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(leido || LEIDO()) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(
        o.alCargar ? o.alCargar(body, pedidos) : { ok: true, id: pedidos.length }) });
    },
  }, o));
  return { dom, p, pedidos };
}

async function hastaRevisar(leido, opts) {
  const x = conLectura(leido, opts);
  x.p.galFotoAbrir();
  x.dom.document.getElementById('gal-foto-inp').files = [{ name: 'planilla.jpg', size: 3000000 }];
  await x.p.galFotoElegida(x.dom.document.getElementById('gal-foto-inp'));
  // galFotoElegida resuelve en una promesa interna: se espera un tick.
  await new Promise((r) => setTimeout(r, 0));
  await x.p.galFotoLeer();
  return x;
}

// ══════════════════════════════════════════════════════════════════════════
// 1 · LOS TRES PASOS
// ══════════════════════════════════════════════════════════════════════════
test('LA VENTANA ABRE EN BLANCO, en el paso de la foto', async () => {
  /* Una ventana que sólo se esconde conserva lo que tenía (CLAUDE.md), y acá
     eso sería volver a cargar los veintiún renglones de la planilla anterior. */
  const { dom, p } = conLectura();
  p.galFotoAbrir();
  assert.equal(dom.nodos['gal-foto-p1'].style.display, '');
  assert.equal(dom.nodos['gal-foto-p2'].style.display, 'none');
  assert.equal(dom.nodos['gal-foto-leer'].style.display, 'none');
  assert.equal(p.GFOT.imagen, null);
  assert.deepEqual(p.GFOT.filas, []);
});

test('abrir dos veces no se trae las filas de la vez anterior', async () => {
  const x = await hastaRevisar();
  assert.equal(x.p.GFOT.filas.length, 3);
  x.p.galFotoAbrir();
  assert.deepEqual(x.p.GFOT.filas, []);
  assert.equal(x.dom.nodos['gal-foto-p1'].style.display, '');
});

test('LA FOTO SE ACHICA ANTES DE MANDARLA', async () => {
  // 1568 px es el lado largo con el que trabaja el modelo: más grande es subir
  // megas que se tiran igual, y la foto de un teléfono son cuatro o cinco.
  const medidas = [];
  const { dom, p } = conLectura(null, {
    comprimir: (f, lado, q) => {
      medidas.push([lado, q]);
      return Promise.resolve({ dataUrl: 'data:image/jpeg;base64,AAAA', newSize: 90000 });
    },
  });
  p.galFotoAbrir();
  dom.document.getElementById('gal-foto-inp').files = [{ name: 'x.jpg', size: 4000000 }];
  p.galFotoElegida(dom.document.getElementById('gal-foto-inp'));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(medidas, [[1568, 0.9]]);
  assert.equal(p.GFOT.imagen, 'data:image/jpeg;base64,AAAA');
  assert.equal(dom.nodos['gal-foto-leer'].style.display, '');
});

test('LEER PASA AL PASO DE REVISAR, no carga nada', async () => {
  const { dom, p, pedidos } = await hastaRevisar();
  assert.equal(dom.nodos['gal-foto-p2'].style.display, '');
  assert.equal(dom.nodos['gal-foto-p1'].style.display, 'none');
  assert.equal(p.GFOT.filas.length, 3);
  assert.deepEqual(pedidos.map((x) => x[0]), ['/api/galpon/volcados/leer-foto']);
});

test('«otra foto» vuelve al principio y suelta lo leído', async () => {
  const x = await hastaRevisar();
  x.p.galFotoOtra();
  assert.deepEqual(x.p.GFOT.filas, []);
  assert.equal(x.p.GFOT.imagen, null);
  assert.equal(x.dom.nodos['gal-foto-p1'].style.display, '');
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL TOTAL QUE SE COMPARA CONTRA EL PAPEL
// ══════════════════════════════════════════════════════════════════════════
test('EL TOTAL ES EL DE LO QUE SE VA A CARGAR, no el de lo que se leyó', async () => {
  /* Si contara los renglones sin peso, o los destildados, diría que está todo
     bien justo cuando falta algo — y entonces no sirve para comparar contra el
     papel, que es lo único para lo que está. */
  const x = await hastaRevisar();
  assert.deepEqual(x.p.galFotoTotal(), { cargas: 3, kilos: 41, fuera: 0, sin_peso: 0 });
  assert.match(x.dom.nodos['gal-foto-tot'].innerHTML, /<b>3<\/b> renglones/);
  assert.match(x.dom.nodos['gal-foto-tot'].innerHTML, /41<\/b> kg/);
  assert.match(x.dom.nodos['gal-foto-tot'].innerHTML, /Comparalo con el papel/);
});

test('un renglón sin peso NO suma cero: se cuenta aparte y en rojo', async () => {
  const x = await hastaRevisar({
    ok: true, avisos: [], filas: [FILA(13, 1, 10), FILA(13, 2, null, { duda: 'borroso' })],
  });
  assert.deepEqual(x.p.galFotoTotal(), { cargas: 1, kilos: 10, fuera: 0, sin_peso: 1 });
  assert.match(x.dom.nodos['gal-foto-tot'].innerHTML, /<b>1<\/b> sin peso/);
  assert.match(x.dom.nodos['gal-foto-body'].innerHTML, /gfo-mal/);
  assert.match(x.dom.nodos['gal-foto-body'].innerHTML, /borroso/);
});

test('escribir el peso saca la fila del rojo y la suma', async () => {
  const x = await hastaRevisar({
    ok: true, avisos: [], filas: [FILA(13, 1, 10), FILA(13, 2, null, { duda: 'borroso' })],
  });
  x.p.galFotoFila(1, 'kilos', '12,40');
  assert.deepEqual(x.p.galFotoTotal(), { cargas: 2, kilos: 22.4, fuera: 0, sin_peso: 0 });
  // Y la duda de la IA se va: la tenía porque no pudo leerlo, y ahora lo leyó
  // una persona.
  assert.equal(x.p.GFOT.filas[1].duda, null);
  assert.ok(!/borroso/.test(x.dom.nodos['gal-foto-body'].innerHTML));
});

test('destildar una fila la saca del total y se nota', async () => {
  const x = await hastaRevisar();
  x.p.galFotoFila(0, 'excluida', true);
  assert.deepEqual(x.p.galFotoTotal(), { cargas: 2, kilos: 25.1, fuera: 1, sin_peso: 0 });
  assert.match(x.dom.nodos['gal-foto-tot'].innerHTML, /1 fuera/);
  assert.match(x.dom.nodos['gal-foto-body'].innerHTML, /gfo-fuera/);
});

test('el botón dice cuántas y se apaga si no queda ninguna', async () => {
  const x = await hastaRevisar();
  assert.match(x.dom.nodos['gal-foto-cargar'].textContent, /Cargar 3 renglones/);
  for (let i = 0; i < 3; i++) x.p.galFotoFila(i, 'excluida', true);
  assert.equal(x.dom.nodos['gal-foto-cargar'].disabled, true);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LOS AVISOS
// ══════════════════════════════════════════════════════════════════════════
test('los avisos de la lectura se muestran', async () => {
  const x = await hastaRevisar({
    ok: true, filas: [FILA(13, 1, 10)],
    avisos: ['Los números de bolsón saltan del 2 al 4.'],
  });
  assert.match(x.dom.nodos['gal-foto-avisos'].innerHTML, /saltan del 2 al 4/);
});

test('AVISA SI EL DÍA YA TIENE CARGAS DE ESE VIAJE', async () => {
  /* Subir la misma foto dos veces son veintiún renglones repetidos, y la
     velocidad es justamente lo que hace que pase. No frena: avisa, porque un
     camión puede entrar en dos tandas. */
  const x = await hastaRevisar(null, {
    GKG: { cargas: [{ id: 1, viaje: 14, kilos: 9.7 }, { id: 2, viaje: 14, kilos: 15.4 }] },
  });
  assert.match(x.dom.nodos['gal-foto-avisos'].innerHTML, /ya hay <b>2<\/b> cargas/);
  assert.match(x.dom.nodos['gal-foto-avisos'].innerHTML, /la misma planilla/);
});

test('y no avisa si las cargas que hay son de otro viaje', async () => {
  const x = await hastaRevisar(null, { GKG: { cargas: [{ id: 1, viaje: 9, kilos: 9.7 }] } });
  assert.ok(!/ya hay/.test(x.dom.nodos['gal-foto-avisos'].innerHTML));
});

test('ni si el día que se está cargando es otro', async () => {
  const x = await hastaRevisar(null, { GKG: { cargas: [{ id: 1, viaje: 14, kilos: 9.7 }] } });
  x.dom.nodos['gal-foto-fecha'].value = '2026-11-19';
  x.p.galFotoPintar();
  assert.ok(!/ya hay/.test(x.dom.nodos['gal-foto-avisos'].innerHTML));
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · CARGAR
// ══════════════════════════════════════════════════════════════════════════
test('SIN LOTE NO CARGA NADA, y lo dice', async () => {
  // La planilla no dice de qué lote son estos kilos. Atribuirlos tiene que
  // seguir siendo un acto deliberado.
  const x = await hastaRevisar();
  x.dom.nodos['gal-foto-lote'].value = '';
  await x.p.galFotoCargar();
  assert.equal(x.dom.nodos['gal-foto-error'].style.display, '');
  assert.match(x.dom.nodos['gal-foto-error'].textContent, /Elegí el lote/);
  assert.equal(x.pedidos.filter((p) => p[0] === '/api/galpon/volcados').length, 0);
});

test('CADA FILA VA POR EL POST DE SIEMPRE, con su uuid y un cajón', async () => {
  /* Por el mismo camino que una carga tipeada a mano: la misma validación, el
     mismo tope de kilos y la misma cola sin señal. */
  const x = await hastaRevisar();
  x.dom.nodos['gal-foto-lote'].value = '10';
  x.dom.nodos['gal-foto-prod'].value = 'Damasco';
  x.p.galCuadPintar('gal-foto-cuads', [1, 2]);
  await x.p.galFotoCargar();

  const cargas = x.pedidos.filter((p) => p[0] === '/api/galpon/volcados').map((p) => p[1]);
  assert.equal(cargas.length, 3);
  for (const c of cargas) {
    assert.equal(c.ifcos, 1, 'cada fila del papel es UN bolsón');
    assert.equal(c.lote_id, '10');
    assert.equal(c.producto, 'Damasco');
    assert.deepEqual(c.cuadrilla_ids, ['1', '2']);
    assert.equal(c.fecha, '2026-11-20');
    assert.ok(c.uuid, 'una carga sin uuid se duplica al reintentar');
  }
  assert.equal(new Set(cargas.map((c) => c.uuid)).size, 3, 'dos filas con el mismo uuid');
  assert.deepEqual(cargas.map((c) => c.kilos), [15.9, 9.7, 15.4]);
});

test('EL VIAJE SALE DE CADA FILA, no del encabezado', async () => {
  /* La foto del 2/11 tiene el final de un camión y el principio del siguiente.
     Con un viaje único para toda la foto, once cargas quedarían atribuidas al
     camión equivocado — y la planilla de control no se podría reconstruir. */
  const x = await hastaRevisar();
  x.dom.nodos['gal-foto-lote'].value = '10';
  await x.p.galFotoCargar();
  const cargas = x.pedidos.filter((p) => p[0] === '/api/galpon/volcados').map((p) => p[1]);
  assert.deepEqual(cargas.map((c) => c.viaje), [13, 14, 14]);
});

test('LO DESTILDADO Y LO SIN PESO NO SE CARGAN', async () => {
  const x = await hastaRevisar({
    ok: true, avisos: [],
    filas: [FILA(13, 1, 10), FILA(13, 2, null), FILA(13, 3, 12)],
  });
  x.dom.nodos['gal-foto-lote'].value = '10';
  x.p.galFotoFila(2, 'excluida', true);
  await x.p.galFotoCargar();
  const cargas = x.pedidos.filter((p) => p[0] === '/api/galpon/volcados').map((p) => p[1]);
  assert.deepEqual(cargas.map((c) => c.kilos), [10]);
});

test('LO QUE ENTRÓ SALE DE LA LISTA: es así como se aprieta Cargar dos veces', async () => {
  const x = await hastaRevisar();
  x.dom.nodos['gal-foto-lote'].value = '10';
  await x.p.galFotoCargar();
  assert.deepEqual(x.p.GFOT.filas, []);
  assert.match(x.dom.nodos['gal-foto-ok'].innerHTML, /Entraron 3 cargas/);
  // Y la ventana NO se cierra: adentro queda el acuse (CLAUDE.md).
  assert.equal(x.dom.nodos['gal-foto-p2'].style.display, '');
  // La pantalla de atrás sí se refresca: es donde se ven las cargas que entraron.
  assert.equal(x.dom.recargas, 1);
});

test('volver a apretar después de cargar no manda nada', async () => {
  const x = await hastaRevisar();
  x.dom.nodos['gal-foto-lote'].value = '10';
  await x.p.galFotoCargar();
  await x.p.galFotoCargar();
  assert.equal(x.pedidos.filter((p) => p[0] === '/api/galpon/volcados').length, 3);
});

test('LO QUE FALLA QUEDA EN LA LISTA, con su motivo', async () => {
  /* A diferencia del borrado, acá el parcial es recuperable y es lo correcto:
     las que entraron se ven en la lista de atrás, y las que no se corrigen y se
     vuelven a mandar. Lo que no puede pasar es que desaparezcan en silencio. */
  const x = await hastaRevisar(null, {
    alCargar: (body) => (body.kilos === 9.7
      ? { ok: false, error: 'La cuadrilla 9 no existe' }
      : { ok: true, id: 1 }),
  });
  x.dom.nodos['gal-foto-lote'].value = '10';
  await x.p.galFotoCargar();
  assert.equal(x.p.GFOT.filas.length, 1);
  assert.equal(x.p.GFOT.filas[0].kilos, 9.7);
  assert.match(x.dom.nodos['gal-foto-error'].innerHTML, /Entraron 2/);
  assert.match(x.dom.nodos['gal-foto-error'].innerHTML, /La cuadrilla 9 no existe/);
  assert.equal(x.dom.nodos['gal-foto-ok'].style.display, 'none');
});

test('Y REINTENTAR NO DUPLICA LO QUE YA HABÍA ENTRADO', async () => {
  /* El uuid se genera una vez por renglón y se guarda en la fila. Generado de
     nuevo en cada intento, el segundo envío crearía una segunda carga de los
     mismos kilos — y el libro del día quedaría con el doble. */
  let falla = true;
  const x = await hastaRevisar(null, {
    alCargar: (body) => (falla && body.kilos === 9.7
      ? { ok: false, error: 'se cayó la red' } : { ok: true, id: 1 }),
  });
  x.dom.nodos['gal-foto-lote'].value = '10';
  await x.p.galFotoCargar();
  const primera = x.pedidos.filter((p) => p[0] === '/api/galpon/volcados')
    .find((p) => p[1].kilos === 9.7)[1].uuid;
  falla = false;
  await x.p.galFotoCargar();
  const todas = x.pedidos.filter((p) => p[0] === '/api/galpon/volcados' && p[1].kilos === 9.7);
  assert.equal(todas.length, 2, 'no reintentó');
  assert.equal(todas[1][1].uuid, primera,
    'el reintento fue con otro uuid: el servidor lo guarda como una carga nueva');
});

test('EL ERROR DE LA IA SE MUESTRA TAL CUAL LO MANDÓ EL SERVIDOR', async () => {
  // Es el que está escrito para el operador, y dice que puede seguir a mano.
  const { dom, p } = conLectura();
  p.galFotoAbrir();
  p.GFOT.imagen = 'data:image/jpeg;base64,AAAA';
  const dom2 = dom;
  // Se reemplaza la respuesta por la de una IA caída.
  const p2 = pantalla(dom2, {
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({
      ok: false, ia_caida: true,
      error: 'El lector de planillas no está disponible. Cargá los renglones a mano.',
      motivo_admin: 'La cuenta de la API se quedó sin crédito.' }) }),
  });
  p2.GFOT.imagen = 'data:image/jpeg;base64,AAAA';
  await p2.galFotoLeer();
  const av = dom2.nodos['gal-foto-aviso1'].innerHTML;
  assert.match(av, /Cargá los renglones a mano/);
  assert.ok(!/crédito/.test(av), 'le mostró el motivo técnico al operador');
  // Y no pasa al paso de revisar: no hay nada que revisar.
  assert.equal(dom2.nodos['gal-foto-p2'].style.display, 'none');
});
