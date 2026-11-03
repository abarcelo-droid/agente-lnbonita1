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
    /* EL ARMADOR DE OPCIONES DE LOTE, DE VERDAD y no un doble: los desplegables de
       cada renglón salen de ahí, y lo que hay que verificar es que el renglón venga
       con SU lote seleccionado. Con un doble, el test diría que sí sin mirar nada.

       Y conviene saber por qué faltaba: sin él, galFotoPintar tiraba un
       ReferenceError que se comía el catch de galFotoLeer —queda como «no se pudo
       llegar al lector»— y el test fallaba tres líneas después, pidiendo el total
       de una tabla que nunca se pintó. */
    corte('function galKgLoteOpts(primera, valor){', 'function galKgLlenarLote(sel){')
    // Los helpers que la ventana usa: el escape, el formato de número, el uuid.
    + corte('function galKgEsc(s){', 'async function galKgInit(){')
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
    + ' galFotoAvisos, galCuadPintar, galCuadIds, galKgLeerKilos,'
    + ' galKgFechaCorta, galFotoLoteOpts, galFotoCuadOpts };');

  dom.recargas = 0;
  return f(
    dom.document,
    o.fetch || (() => Promise.reject(new Error('sin fetch en este test'))),
    { LNB_USER: { id: 2, nombre: 'Juan' } },
    Object.assign({
      fecha: '2026-11-20', hoy: '2026-11-20', cargas: [], resumen: null,
      propuesta: null, ultimo: null,
      /* Tres lotes en dos fincas, como el padrón de verdad: con uno solo no se
         puede probar que el renglón venga con EL SUYO elegido. */
      lotes: [{ id: 10, nombre: 'Cuadro 3', finca: 'La Estación' },
              { id: 11, nombre: 'Cuadro 4', finca: 'La Estación' },
              { id: 12, nombre: 'Peñas Sur', finca: 'Las Peñas' }],
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
    sanitario: null, observacion: null, ok: kilos != null && kilos > 0, duda: null,
    /* Lo que el servidor resolvió de la columna Finca/Lote del papel. null es la
       respuesta normal y correcta: La Estación tiene dos lotes, así que la finca
       sola no alcanza y lo elige una persona. */
    lote_id: null, lote_motivo: null },
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
  assert.deepEqual(x.p.galFotoTotal(), { cargas: 3, kilos: 41, fuera: 0, sin_peso: 0, lotes: 0, cuadrillas: 0 });
  assert.match(x.dom.nodos['gal-foto-tot'].innerHTML, /<b>3<\/b> renglones/);
  assert.match(x.dom.nodos['gal-foto-tot'].innerHTML, /41<\/b> kg/);
  assert.match(x.dom.nodos['gal-foto-tot'].innerHTML, /Comparalo con el papel/);
});

test('un renglón sin peso NO suma cero: se cuenta aparte y en rojo', async () => {
  const x = await hastaRevisar({
    ok: true, avisos: [], filas: [FILA(13, 1, 10), FILA(13, 2, null, { duda: 'borroso' })],
  });
  assert.deepEqual(x.p.galFotoTotal(), { cargas: 1, kilos: 10, fuera: 0, sin_peso: 1, lotes: 0, cuadrillas: 0 });
  assert.match(x.dom.nodos['gal-foto-tot'].innerHTML, /<b>1<\/b> sin peso/);
  assert.match(x.dom.nodos['gal-foto-body'].innerHTML, /gfo-mal/);
  assert.match(x.dom.nodos['gal-foto-body'].innerHTML, /borroso/);
});

test('escribir el peso saca la fila del rojo y la suma', async () => {
  const x = await hastaRevisar({
    ok: true, avisos: [], filas: [FILA(13, 1, 10), FILA(13, 2, null, { duda: 'borroso' })],
  });
  x.p.galFotoFila(1, 'kilos', '12,40');
  assert.deepEqual(x.p.galFotoTotal(), { cargas: 2, kilos: 22.4, fuera: 0, sin_peso: 0, lotes: 0, cuadrillas: 0 });
  // Y la duda de la IA se va: la tenía porque no pudo leerlo, y ahora lo leyó
  // una persona.
  assert.equal(x.p.GFOT.filas[1].duda, null);
  assert.ok(!/borroso/.test(x.dom.nodos['gal-foto-body'].innerHTML));
});

test('destildar una fila la saca del total y se nota', async () => {
  const x = await hastaRevisar();
  x.p.galFotoFila(0, 'excluida', true);
  assert.deepEqual(x.p.galFotoTotal(), { cargas: 2, kilos: 25.1, fuera: 1, sin_peso: 0, lotes: 0, cuadrillas: 0 });
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

// ══════════════════════════════════════════════════════════════════════════
// 6 · A QUÉ DÍA ENTRAN ESTOS KILOS (V1136)
// ══════════════════════════════════════════════════════════════════════════
//
// Andy, 2/11/2026: «funciona todo bien la foto pero al final la planilla no
// muestra ningún cambio: "todavía no se cargó nada para este día"».
//
// Y no era que no se hubiera cargado: se había cargado A OTRO DÍA. La fecha del
// encabezado del papel pisa la propuesta, las cargas entran a ese día, y la
// lista de atrás seguía mirando hoy. Veintiún renglones guardados que nadie
// podía ver.
//
// Es el peor modo de falla de esta ventana: todo contesta ok, el acuse dice
// «entraron 21», y el operador concluye que no se guardó nada — así que lo
// vuelve a cargar, ahora sí al día que mira, y quedan los dos.

test('UN DÍA SE ESCRIBE COMO SE LEE, y sin corrimiento de zona', async () => {
  const { p } = conLectura();
  assert.equal(p.galKgFechaCorta('2026-10-28'), '28/10/2026');
  /* EL CORRIMIENTO ES LA TRAMPA: new Date('2026-10-28') se interpreta en UTC y
     acá estamos en -03, así que mostrarlo con un Date devuelve el 27. Un aviso
     cuyo trabajo es decir la fecha diciendo la fecha de al lado es peor que no
     tenerlo. */
  assert.ok(p.galKgFechaCorta('2026-10-28').indexOf('27/') < 0);
  assert.equal(p.galKgFechaCorta('2026-01-01'), '01/01/2026');
  // Y lo que no es una fecha vuelve tal cual, sin inventar nada.
  assert.equal(p.galKgFechaCorta(''), '');
  assert.equal(p.galKgFechaCorta(null), '');
});

test('LA FECHA QUE TRAE EL PAPEL SE DICE, no se pisa en silencio', async () => {
  const x = await hastaRevisar(Object.assign(LEIDO(), { fecha: '2026-10-28' }),
                               { GKG: { fecha: '2026-11-02', hoy: '2026-11-02' } });
  // El casillero queda con la del papel, que es lo correcto: es ESTA planilla.
  assert.equal(x.dom.nodos['gal-foto-fecha'].value, '2026-10-28');
  assert.equal(x.p.GFOT.fechaPapel, '2026-10-28');
  // Y la ventana lo DICE, con los dos días escritos.
  const av = x.dom.nodos['gal-foto-avisos'].innerHTML;
  assert.match(av, /28\/10\/2026/, 'no dice a qué día van a entrar');
  assert.match(av, /02\/11\/2026/, 'no dice qué día está mirando');
  assert.match(av, /que trae el papel/);
});

test('el aviso también sale si la fecha la tipeó una persona', async () => {
  /* Se avisa por la DIFERENCIA, no por el origen. Lo que confunde es cargar a un
     día y mirar otro, y eso se ve comparando los dos — da igual quién la puso. */
  const x = await hastaRevisar(LEIDO(),
                               { GKG: { fecha: '2026-11-02', hoy: '2026-11-02' } });
  assert.equal(x.dom.nodos['gal-foto-avisos'].innerHTML, '');
  x.dom.nodos['gal-foto-fecha'].value = '2026-10-28';
  x.p.galFotoPintar();
  const av = x.dom.nodos['gal-foto-avisos'].innerHTML;
  assert.match(av, /28\/10\/2026/);
  // Pero NO dice que la trae el papel, porque no la trae.
  assert.ok(av.indexOf('que trae el papel') < 0);
});

test('sin diferencia no hay aviso: un cartel que sale siempre no se lee', async () => {
  const x = await hastaRevisar(Object.assign(LEIDO(), { fecha: '2026-11-02' }),
                               { GKG: { fecha: '2026-11-02', hoy: '2026-11-02' } });
  assert.equal(x.dom.nodos['gal-foto-avisos'].innerHTML, '');
});

test('LA LISTA DE ATRÁS SE VA AL DÍA EN QUE ENTRARON', async () => {
  /* Éste es el arreglo de fondo. El aviso de arriba avisa antes; esto hace que el
     resultado se vea aunque nadie lo haya leído. */
  const x = await hastaRevisar(Object.assign(LEIDO(), { fecha: '2026-10-28' }),
                               { GKG: { fecha: '2026-11-02', hoy: '2026-11-02' } });
  x.dom.nodos['gal-foto-lote'].value = '10';
  const fl = x.dom.document.getElementById('gkg-fecha');
  fl.value = '2026-11-02';
  await x.p.galFotoCargar();
  assert.equal(fl.value, '2026-10-28',
    'la lista se quedó en el día que estaba mirando: 21 renglones invisibles');
  assert.ok(x.dom.recargas >= 1);
});

test('y si no entró NINGUNA, la lista no se mueve', async () => {
  /* Mandar la pantalla a un día donde no entró nada es cambiar un vacío engañoso
     por otro, y encima le saca de la vista lo que sí tenía. */
  const x = await hastaRevisar(Object.assign(LEIDO(), { fecha: '2026-10-28' }), {
    GKG: { fecha: '2026-11-02', hoy: '2026-11-02' },
    alCargar: () => ({ ok: false, error: 'el lote 10 no existe' }),
  });
  x.dom.nodos['gal-foto-lote'].value = '10';
  const fl = x.dom.document.getElementById('gkg-fecha');
  fl.value = '2026-11-02';
  await x.p.galFotoCargar();
  assert.equal(fl.value, '2026-11-02',
    'la lista se fue a un día donde no entró nada, y encima perdió el que tenía');
});

test('EL ACUSE NOMBRA EL DÍA', async () => {
  /* Es el único dato del acuse que puede estar mal sin que se note: los kilos se
     acaban de revisar renglón por renglón, la fecha no la miró nadie. */
  const x = await hastaRevisar(Object.assign(LEIDO(), { fecha: '2026-10-28' }),
                               { GKG: { fecha: '2026-11-02', hoy: '2026-11-02' } });
  x.dom.nodos['gal-foto-lote'].value = '10';
  await x.p.galFotoCargar();
  const ok = x.dom.nodos['gal-foto-ok'];
  assert.equal(ok.style.display, '');
  assert.match(ok.innerHTML, /28\/10\/2026/);
  assert.match(ok.innerHTML, /Entraron 3/);
});

test('la fecha del papel NO se hereda de la planilla anterior', async () => {
  /* Si quedara, la segunda planilla —con la fecha tipeada— mostraría el aviso
     diciendo «la que trae el papel» sobre una fecha que el papel no trajo. */
  const x = await hastaRevisar(Object.assign(LEIDO(), { fecha: '2026-10-28' }),
                               { GKG: { fecha: '2026-11-02', hoy: '2026-11-02' } });
  assert.equal(x.p.GFOT.fechaPapel, '2026-10-28');
  x.p.galFotoOtra();
  assert.equal(x.p.GFOT.fechaPapel, null);
  x.p.galFotoAbrir();
  assert.equal(x.p.GFOT.fechaPapel, null);
});

// ══════════════════════════════════════════════════════════════════════════
// 7 · UNA HOJA MEZCLADA: LOTE Y CUADRILLA POR RENGLÓN (V1137)
// ══════════════════════════════════════════════════════════════════════════
//
// Andy, 2/11/2026: «a veces en la misma hoja tenemos algunos cajones que son
// de una cuadrilla y otros de otra. Y fincas también puede pasar lo mismo».
//
// El encabezado dejó de ser LA respuesta y pasó a ser el valor POR OMISIÓN.
// Lo que puede salir mal es callado y es siempre el mismo: que la pantalla
// muestre una cosa y el POST mande otra. Un lote mal atribuido no se nota
// nunca —los kilos están, el total cierra— y cruza el rinde de dos cuadros
// para toda la temporada.

// Una hoja de dos fincas: el primero lo resolvió el servidor, el otro no.
const MEZCLA = () => ({
  ok: true, fecha: null, cultivo: null, avisos: [],
  filas: [FILA(13, 1, 10.5, { lote_id: 11, finca: 'La Estación', lote: 'Cuadro 4' }),
          FILA(13, 2, 11, { finca: 'La Quinta', lote_motivo: 'no hay ninguna finca «La Quinta»' })],
});

test('CADA RENGLÓN TRAE SU DESPLEGABLE, con lo del papel ya elegido', async () => {
  const x = await hastaRevisar(MEZCLA());
  const b = x.dom.nodos['gal-foto-body'].innerHTML;
  assert.match(b, /galFotoFila\(0, 'lote_id'/);
  assert.match(b, /galFotoFila\(1, 'cuadrilla_id'/);
  /* EL PRIMERO VIENE CON EL LOTE DEL PAPEL SELECCIONADO, Y SE MIRA EN LO PINTADO
     y no en el armador suelto. Lo agarró la prueba de mutación: pintar el renglón
     con galFotoLoteOpts(null) —o sea tirando lo que el servidor resolvió— dejaba
     todos los tests en verde. Y el síntoma es que la función entera no sirve de
     nada: el operador ve «↑ el de arriba» en los veintiún renglones y los elige a
     mano igual, sin enterarse de que el papel ya lo decía. */
  assert.match(b, /value="11" data-cultivo="[^"]*" selected/,
    'el renglón se pinta sin el lote que vino del papel');
  // Y el segundo, el que no se pudo resolver, queda heredando.
  const fila2 = b.slice(b.indexOf('<tr', b.indexOf('<tr') + 1));
  assert.ok(!/value="1[12]"[^>]*selected/.test(fila2),
    'el renglón sin resolver viene con un lote elegido: alguien lo eligió por él');
  assert.match(x.p.galFotoLoteOpts(11), /value="11" data-cultivo="[^"]*" selected/);
  // Y la primera opción vale vacío: heredar es lo normal.
  assert.match(x.p.galFotoLoteOpts(null), /<option value="">↑ el de arriba<\/option>/);
  assert.match(x.p.galFotoCuadOpts(null), /<option value="">↑ la de arriba<\/option>/);
  assert.match(x.p.galFotoCuadOpts(2), /value="2" selected/);
});

test('LO DE LA FILA ES LO QUE VIAJA, y lo que no dijo nada hereda', async () => {
  const x = await hastaRevisar(MEZCLA());
  x.dom.nodos['gal-foto-lote'].value = '10';
  x.p.galCuadPintar('gal-foto-cuads', [1]);
  // El segundo renglón: su cuadrilla y su lote, elegidos a mano.
  x.p.galFotoFila(1, 'lote_id', '12');
  x.p.galFotoFila(1, 'cuadrilla_id', '2');
  await x.p.galFotoCargar();

  const cargas = x.pedidos.filter((q) => q[0] === '/api/galpon/volcados').map((q) => q[1]);
  assert.equal(cargas.length, 2);
  // El primero: el lote del papel (11, no el 10 de arriba) y la cuadrilla de arriba.
  assert.equal(cargas[0].lote_id, 11);
  assert.deepEqual(cargas[0].cuadrilla_ids, ['1']);
  // El segundo: los dos elegidos a mano.
  assert.equal(cargas[1].lote_id, '12');
  assert.deepEqual(cargas[1].cuadrilla_ids, ['2']);
});

test('volver a «↑ el de arriba» vuelve a heredar', async () => {
  /* El <select> manda '' en esa opción. Tratado como un valor, el renglón se
     cargaría sin lote — y el encabezado está elegido y a la vista. */
  const x = await hastaRevisar(MEZCLA());
  x.dom.nodos['gal-foto-lote'].value = '10';
  x.p.galFotoFila(0, 'lote_id', '');
  await x.p.galFotoCargar();
  const cargas = x.pedidos.filter((q) => q[0] === '/api/galpon/volcados').map((q) => q[1]);
  assert.equal(cargas[0].lote_id, '10');
});

test('la cuadrilla del renglón REEMPLAZA a las dos de arriba, no se suma', async () => {
  /* Arriba pueden ser dos: el cajón que llenaron entre las dos, y los kilos se
     reparten en partes iguales (V1133). El renglón que dice «Sur» dice que ESE
     cajón es de la Sur entero. Sumarlas repartiría sus kilos en tres. */
  const x = await hastaRevisar(MEZCLA());
  x.dom.nodos['gal-foto-lote'].value = '10';
  x.p.galCuadPintar('gal-foto-cuads', [1, 2]);
  x.p.galFotoFila(1, 'cuadrilla_id', '2');
  await x.p.galFotoCargar();
  const cargas = x.pedidos.filter((q) => q[0] === '/api/galpon/volcados').map((q) => q[1]);
  assert.deepEqual(cargas[0].cuadrilla_ids, ['1', '2']);
  assert.deepEqual(cargas[1].cuadrilla_ids, ['2']);
});

test('EL LOTE DE ARRIBA NO SE PIDE SI NINGÚN RENGLÓN LO NECESITA', async () => {
  /* Con las dos fincas resueltas desde el papel, exigir uno arriba obligaría a
     elegir al azar — y ése es justo el que se le atribuiría a cualquier renglón
     que quedara sin resolver. */
  const x = await hastaRevisar({
    ok: true, avisos: [],
    filas: [FILA(13, 1, 10, { lote_id: 11 }), FILA(13, 2, 11, { lote_id: 12 })],
  });
  assert.equal(x.dom.nodos['gal-foto-lote'].value, '');
  await x.p.galFotoCargar();
  assert.equal(x.dom.nodos['gal-foto-error'].style.display, 'none',
    'pide el lote de arriba aunque los dos renglones lo traen del papel');
  const cargas = x.pedidos.filter((q) => q[0] === '/api/galpon/volcados').map((q) => q[1]);
  assert.deepEqual(cargas.map((c) => c.lote_id), [11, 12]);
});

test('pero SÍ se pide si alguno quedó sin resolver', async () => {
  const x = await hastaRevisar(MEZCLA());
  await x.p.galFotoCargar();
  assert.equal(x.dom.nodos['gal-foto-error'].style.display, '');
  assert.match(x.dom.nodos['gal-foto-error'].textContent, /Elegí el lote/);
  assert.match(x.dom.nodos['gal-foto-error'].textContent, /no lo traen del papel/);
  // Y no mandó nada: o entran todas con su lote, o no entra ninguna.
  assert.equal(x.pedidos.filter((q) => q[0] === '/api/galpon/volcados').length, 0);
});

test('un renglón sin peso no obliga a elegir el lote de arriba', async () => {
  /* No se va a cargar, así que su lote no importa. Pedirlo por él sería frenar
     una hoja entera por el renglón que justamente se dejó afuera. */
  const x = await hastaRevisar({
    ok: true, avisos: [],
    filas: [FILA(13, 1, 10, { lote_id: 11 }),
            FILA(13, 2, null, { duda: 'borroso' })],
  });
  await x.p.galFotoCargar();
  assert.equal(x.dom.nodos['gal-foto-error'].style.display, 'none');
});

test('EL TOTAL DICE CUÁNTOS LOTES Y CUÁNTAS CUADRILLAS VAN A QUEDAR', async () => {
  /* Es el control de que una hoja mezclada se cargó mezclada: el papel tenía dos
     fincas y si acá dice «1 lote» es que las dos se fueron al mismo. */
  const x = await hastaRevisar(MEZCLA());
  x.dom.nodos['gal-foto-lote'].value = '10';
  x.p.galCuadPintar('gal-foto-cuads', [1]);
  x.p.galFotoFila(1, 'cuadrilla_id', '2');
  const t = x.p.galFotoTotal();
  assert.equal(t.lotes, 2, 'el papel traía dos fincas y el total dice una');
  assert.equal(t.cuadrillas, 2);
  assert.match(x.dom.nodos['gal-foto-tot'].innerHTML, /<b>2<\/b> lotes/);
  assert.match(x.dom.nodos['gal-foto-tot'].innerHTML, /<b>2<\/b> cuadrillas/);
});

test('y con una hoja de un solo lote no dice nada', async () => {
  /* Un «1 lote» que sale en todas las planillas es ruido, y el ruido es lo que
     hace que no se lea el «2 lotes» del día que importa. */
  const x = await hastaRevisar();
  x.dom.nodos['gal-foto-lote'].value = '10';
  x.p.galFotoPintar();
  assert.equal(x.p.galFotoTotal().lotes, 1);
  // Sin cuadrilla elegida en ningún lado son CERO, no una: no se eligió ninguna.
  assert.equal(x.p.galFotoTotal().cuadrillas, 0);
  assert.ok(!/ lotes/.test(x.dom.nodos['gal-foto-tot'].innerHTML));
  assert.ok(!/ cuadrillas/.test(x.dom.nodos['gal-foto-tot'].innerHTML));
});
