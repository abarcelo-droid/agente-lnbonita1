// ══ 📴 EL GALPÓN SIN INTERNET ═══════════════════════════════════════════════
//
// Andy, 2/11/2026: «quiero que hagas todo el módulo de galpón disponible sin
// conexión a INTERNET. Que los chicos puedan cargar info sin necesidad de
// estar conectados».
//
// Lo que se clava acá, en orden de qué duele más:
//
//   1. PERDER UNA CARGA. Es todo el punto: unos kilos que el operador tipeó y
//      que nadie va a volver a tipear.
//   2. DUPLICARLA. Una señal que va y viene reintenta, y sin uuid eso son los
//      mismos kilos contados dos veces — que es peor que perderlos, porque
//      nadie lo nota.
//   3. DECIR QUE SE GUARDÓ ALGO QUE EL SERVIDOR RECHAZÓ. Un 400 reintentado
//      mil veces no se convierte en un sí, y mientras tanto la pantalla dice
//      que está todo bien.
//   4. ENCOLAR LO QUE NECESITA RESPUESTA. Abrir un pallet offline es inventar
//      un id que después no existe, y todo lo que se le cargue encima cuelga
//      de la nada.
//   5. REPRODUCIR EN DESORDEN. Cargar y después borrar esa misma carga, al
//      revés, borra algo que no existe y después lo crea: queda una fila que
//      el operador ya había sacado.
//
// El archivo es un script de navegador, igual que src/balanza.js: se carga
// EJECUTÁNDOLO, con un almacén y un fetch de mentira.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUENTE = fs.readFileSync(path.join(RAIZ, 'src/galponOffline.js'), 'utf8');

// Cada test estrena su propio GOFF: el módulo guarda estado adentro y dos
// tests compartiéndolo se pisan la cola.
function cargar() {
  return new Function(FUENTE + '\nreturn GOFF;')();
}

// Un almacén de mentira, con el mismo contrato que el de IndexedDB.
function almacenFalso() {
  const filas = new Map();
  return {
    filas,
    async guardar(f) { filas.set(f.uuid, Object.assign({}, f)); },
    async borrar(uuid) { filas.delete(uuid); },
    async listar() { return [...filas.values()]; },
  };
}

// Un fetch de mentira que se puede apagar.
function redFalsa() {
  const r = {
    hay: true,
    pedidos: [],
    responde: () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    async fetch(url, opts) {
      r.pedidos.push({ url: String(url), metodo: (opts || {}).method || 'GET',
                       cuerpo: (opts || {}).body });
      if (!r.hay) throw new TypeError('Failed to fetch');
      return r.responde(url, opts);
    },
  };
  return r;
}

const POST = (b) => ({ method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

// ══════════════════════════════════════════════════════════════════════════
// 1 · NO SE PIERDE NADA
// ══════════════════════════════════════════════════════════════════════════
test('SIN SEÑAL, LA CARGA SE GUARDA EN EL EQUIPO', async () => {
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch });

  red.hay = false;
  const r = await f('/api/galpon/volcados', POST({ fecha: '2026-12-15',
    lote_id: 10, kilos: 450 }));
  const j = await r.json();
  /* LA PANTALLA MIRA j.ok, EL DEL CUERPO — las treinta llamadas del galpón hacen
     `if (!j.ok) throw`. El r.ok del status es otra cosa, y verificar ése dejaba
     pasar un cuerpo que dijera que falló: el operador vería «no se pudo» justo
     cuando sí se guardó, y cargaría todo de nuevo. Lo delató la mutación. */
  assert.equal(j.ok, true, 'el cuerpo dice que falló: la pantalla va a mostrar error');
  assert.equal(r.ok, true);
  assert.equal(j.encolado, true);
  assert.ok(j.aviso);
  assert.equal((await G.pendientes()).length, 1);
});

test('Y SALE SOLA CUANDO VUELVE LA SEÑAL', async () => {
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch });

  red.hay = false;
  await f('/api/galpon/volcados', POST({ kilos: 450 }));
  await f('/api/galpon/volcados', POST({ kilos: 320 }));
  assert.equal((await G.pendientes()).length, 2);

  red.hay = true;
  const r = await G.mandar();
  assert.equal(r.enviados, 2);
  assert.equal((await G.pendientes()).length, 0);
  // Y lo que salió es lo que se cargó, no un resumen.
  const kilos = red.pedidos.filter((p) => p.metodo === 'POST')
    .map((p) => JSON.parse(p.cuerpo).kilos).filter(Boolean);
  assert.deepEqual(kilos, [450, 320, 450, 320]);
});

test('EN EL ORDEN EN QUE SE HICIERON', async () => {
  // Cargar y después borrar esa misma carga, reproducido al revés, borra algo
  // que todavía no existe y después lo crea: queda una fila que el operador ya
  // había sacado.
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  let t = 1000;
  const f = G.arrancar({ almacen: alm, fetch: red.fetch, reloj: () => t });

  red.hay = false;
  await f('/api/galpon/volcados', POST({ kilos: 1 }));
  t = 900;                                   // el segundo se hizo ANTES
  await f('/api/galpon/volcados', POST({ kilos: 2 }));
  t = 1100;
  await f('/api/galpon/volcados', POST({ kilos: 3 }));

  red.hay = true;
  red.pedidos.length = 0;
  await G.mandar();
  assert.deepEqual(red.pedidos.map((p) => JSON.parse(p.cuerpo).kilos), [2, 1, 3]);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · NO SE DUPLICA
// ══════════════════════════════════════════════════════════════════════════
test('CADA CARGA ENCOLADA LLEVA SU UUID', async () => {
  // Es lo que el servidor mira para no duplicar: gal_volcados.uuid y
  // gal_procesos.uuid son UNIQUE. Sin él, una señal que va y viene cuenta los
  // mismos kilos dos veces y nadie lo nota.
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch });

  red.hay = false;
  await f('/api/galpon/volcados', POST({ kilos: 450 }));
  const [p] = await G.pendientes();
  assert.ok(p.uuid, 'la fila encolada no tiene uuid');
  assert.equal(JSON.parse(p.cuerpo).uuid, p.uuid,
    'el uuid no viaja en el cuerpo, que es donde el servidor lo mira');
});

test('y RESPETA el uuid que la pantalla ya puso', async () => {
  // La carga rápida genera el suyo para que el doble clic no duplique.
  // Pisarlo acá rompería esa protección justo cuando hay menos señal.
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch });
  red.hay = false;
  await f('/api/galpon/volcados', POST({ kilos: 450, uuid: 'el-de-la-pantalla' }));
  const [p] = await G.pendientes();
  assert.equal(p.uuid, 'el-de-la-pantalla');
});

test('mandar dos veces a la vez no manda nada dos veces', async () => {
  // El evento de «volvió la señal» y el tic del reintento pueden caer juntos.
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch });
  red.hay = false;
  await f('/api/galpon/volcados', POST({ kilos: 450 }));

  red.hay = true;
  red.pedidos.length = 0;
  const [a, b] = await Promise.all([G.mandar(), G.mandar()]);
  assert.equal(red.pedidos.length, 1, 'mandó la misma carga dos veces');
  assert.ok(a.ya_estaba || b.ya_estaba);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · «NO LLEGUÉ» NO ES «ME DIJERON QUE NO»
// ══════════════════════════════════════════════════════════════════════════
test('UN 400 NO SE ENCOLA: el servidor contestó', async () => {
  // Reintentarlo mil veces no lo va a convencer, y mientras tanto la pantalla
  // diría que está todo bien.
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch });
  red.responde = () => ({ ok: false, status: 400,
    json: async () => ({ ok: false, error: 'Falta el lote' }) });

  const r = await f('/api/galpon/volcados', POST({ kilos: 450 }));
  assert.equal(r.status, 400, 'se tragó el error del servidor');
  assert.equal((await G.pendientes()).length, 0, 'encoló algo que el servidor rechazó');
});

test('un 503 SÍ se reintenta: no llegó a ejecutarse', async () => {
  // Lo contesta un intermediario cuando el servidor no está, así que el pedido
  // no se ejecutó. Es la única familia de respuestas que se reintenta.
  const G = cargar();
  assert.equal(G.esFalloDeRed(null, { status: 503 }), true);
  assert.equal(G.esFalloDeRed(null, { status: 504 }), true);
  assert.equal(G.esFalloDeRed(null, { status: 500 }), false, 'reintentaría un 500');
  assert.equal(G.esFalloDeRed(null, { status: 403 }), false);
  assert.equal(G.esFalloDeRed(null, { status: 200 }), false);
  assert.equal(G.esFalloDeRed(new Error('Failed to fetch'), null), true);
});

test('lo que el servidor RECHAZA sale de la cola y se informa', async () => {
  // Si se quedara, la cola nunca baja y el operador aprende a no mirarla. Y si
  // desapareciera en silencio, esa carga no entró y nadie se entera.
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch });
  red.hay = false;
  await f('/api/galpon/volcados', POST({ kilos: 450 }));
  await f('/api/galpon/volcados', POST({ kilos: 320 }));

  red.hay = true;
  let n = 0;
  red.responde = () => (++n === 1
    ? { ok: false, status: 400, json: async () => ({ ok: false, error: 'Falta el lote' }) }
    : { ok: true, status: 200, json: async () => ({ ok: true }) });

  const r = await G.mandar();
  assert.equal(r.enviados, 1);
  assert.equal(r.rechazados.length, 1);
  assert.equal(r.rechazados[0].motivo, 'Falta el lote');
  assert.ok(r.rechazados[0].cuerpo, 'no devolvió qué se había cargado');
  assert.equal((await G.pendientes()).length, 0, 'el rechazado se quedó en la cola');
});

test('sin señal CORTA: no insiste con el resto', async () => {
  // Si se cayó la señal, seguir intentando los demás gasta tiempo y deja la
  // cola en un orden que no es el de carga.
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch });
  red.hay = false;
  for (const k of [1, 2, 3]) await f('/api/galpon/volcados', POST({ kilos: k }));

  red.pedidos.length = 0;
  await G.mandar();
  assert.equal(red.pedidos.length, 1, 'intentó los tres sin señal');
  assert.equal((await G.pendientes()).length, 3);
});

test('los que fallan varias veces se cuentan aparte', async () => {
  // Una cola que crece y no baja no es «sin señal», es algo roto — y el que
  // carga tiene que poder distinguirlo antes de que sean cien.
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch });
  red.hay = false;
  await f('/api/galpon/volcados', POST({ kilos: 450 }));
  for (let i = 0; i < 3; i++) await G.mandar();
  const e = await G.estado();
  assert.equal(e.pendientes, 1);
  assert.equal(e.trabados, 1);
  assert.ok(e.mas_viejo, 'no dice desde cuándo está esperando');
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · QUÉ SE ENCOLA Y QUÉ NO
// ══════════════════════════════════════════════════════════════════════════
test('SE ENCOLA LO QUE NO NECESITA LA RESPUESTA', async () => {
  const G = cargar();
  for (const [m, u] of [
    ['POST', '/api/galpon/volcados'],
    ['POST', '/api/galpon/procesos'],
    ['PATCH', '/api/galpon/volcados/12'],
    ['DELETE', '/api/galpon/procesos/7'],
    ['POST', '/api/galpon/lote-dia'],
    ['POST', '/api/galpon/lote-datos'],
  ]) assert.equal(G.esEncolable(m, u), true, 'no encola ' + m + ' ' + u);
});

test('NO SE ENCOLA LO QUE INVENTA UN ID O UN NÚMERO', async () => {
  // Abrir un pallet offline es inventar un id que después no existe, y todo lo
  // que se le cargue encima cuelga de la nada. Cerrar asigna el NÚMERO del
  // correlativo, que no se puede decidir en un equipo sin saber qué hay en los
  // otros. Y mover al pallet se valida contra el stock de verdad.
  const G = cargar();
  for (const [m, u] of [
    ['POST', '/api/galpon/armado'],
    ['POST', '/api/galpon/armado/3/mover'],
    ['POST', '/api/galpon/pallets'],
    ['POST', '/api/galpon/pallets/3/cerrar'],
    ['POST', '/api/galpon/pallets/3/reabrir'],
    ['POST', '/api/galpon/despachos'],
    ['POST', '/api/galpon/despachos/3/emitir'],
    ['POST', '/api/galpon/despachos/3/items'],
    ['POST', '/api/galpon/presentaciones'],
    ['PUT', '/api/galpon/config'],
    ['GET', '/api/galpon/volcados'],
  ]) assert.equal(G.esEncolable(m, u), false, 'encola ' + m + ' ' + u);
  // Y nada que no sea del galpón.
  assert.equal(G.esEncolable('POST', '/api/sg/despachos'), false);
  assert.equal(G.esEncolable('POST', '/api/pa/asientos'), false);
});

test('lo NO encolable devuelve el error de red tal cual', async () => {
  // La pantalla tiene que poder decir «para esto hace falta señal» en vez de
  // fingir que se guardó.
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch });
  red.hay = false;
  await assert.rejects(() => f('/api/galpon/pallets/3/cerrar', POST({})),
    /Failed to fetch/);
  assert.equal((await G.pendientes()).length, 0);
});

test('un cuerpo que no es JSON no se encola: no hay dónde poner el uuid', async () => {
  // Y sin uuid, un reintento duplica.
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch });
  red.hay = false;
  await assert.rejects(() => f('/api/galpon/volcados',
    { method: 'POST', body: 'kilos=450' }));
  assert.equal((await G.pendientes()).length, 0);
  assert.equal(G.conUuid('kilos=450'), null);
  assert.equal(G.conUuid('[1,2,3]'), null, 'un array no tiene dónde llevar el uuid');
  assert.equal(G.conUuid(undefined).uuid.length > 0, true, 'un cuerpo vacío sí puede');
});

test('la URL con parámetros se reconoce igual', async () => {
  const G = cargar();
  assert.equal(G.esEncolable('POST', '/api/galpon/volcados?sociedad_id=7'), true);
  assert.equal(G.esEncolable('post', '/api/galpon/volcados'), true, 'es sensible a mayúsculas');
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · EL AVISO
// ══════════════════════════════════════════════════════════════════════════
test('avisa cada vez que la cola cambia', async () => {
  // El contador de pendientes es lo único que le dice al operador que sus
  // kilos están esperando. Si no se actualiza, la barra miente.
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const vistos = [];
  const f = G.arrancar({ almacen: alm, fetch: red.fetch,
    alCambiar: (e) => vistos.push(e.pendientes) });

  red.hay = false;
  await f('/api/galpon/volcados', POST({ kilos: 1 }));
  await f('/api/galpon/volcados', POST({ kilos: 2 }));
  red.hay = true;
  await G.mandar();
  assert.deepEqual(vistos, [1, 2, 0]);
});

test('un pedido que SALE empuja la cola sin que nadie lo pida', async () => {
  // Cuando vuelve la señal, el operador acaba de ver que su carga salió: la
  // cola tiene que vaciarse mientras mira, no en el próximo tic.
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch });
  red.hay = false;
  await f('/api/galpon/volcados', POST({ kilos: 1 }));

  red.hay = true;
  await f('/api/galpon/volcados', POST({ kilos: 2 }));
  // mandar() se dispara sin await adentro del envoltorio: se le da un respiro.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal((await G.pendientes()).length, 0, 'la cola no se vació sola');
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · LO QUE SE VE EN PANTALLA MIENTRAS ESPERA
// ══════════════════════════════════════════════════════════════════════════
test('LA RESPUESTA ENCOLADA TRAE LA FILA que se cargó', async () => {
  // Las pantallas arman su lista con lo que el servidor devuelve. Sin `fila`,
  // el renglón sale vacío: el operador no ve lo que acaba de cargar y lo
  // carga de nuevo — que es el problema que esto venía a resolver.
  const G = cargar();
  const red = redFalsa();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch });
  red.hay = false;
  const r = await f('/api/galpon/volcados', POST({ kilos: 450, lote_id: 10,
    lote_nombre: 'Cuadro 3' }));
  const j = await r.json();
  assert.equal(j.fila.kilos, 450, 'la fila no trae lo que se cargó');
  assert.equal(j.fila.lote_nombre, 'Cuadro 3');
  assert.equal(j.fila.encolado, 1, 'el renglón no se puede distinguir de uno guardado');
});

test('EL ID LOCAL SE NOTA: no se inventa un número', async () => {
  // Un número inventado que se parece a uno real es el que después nadie
  // puede distinguir de uno del servidor — y el día que choquen, el deshacer
  // borra la fila equivocada.
  const G = cargar();
  const red = redFalsa();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch });
  red.hay = false;
  const j = await (await f('/api/galpon/volcados', POST({ kilos: 1 }))).json();
  assert.match(String(j.id), /^enc:/, 'el id encolado se parece a uno del servidor');
  assert.equal(Number.isFinite(Number(j.id)), false);
  assert.equal(G.esLocal('/api/galpon/volcados/' + j.id), true);
  assert.equal(G.esLocal('/api/galpon/volcados/42'), false);
});

test('DESHACER UNA CARGA ENCOLADA LA SACA DE LA COLA', async () => {
  // Es lo primero que se aprieta cuando se tipea un cero de más, y sin señal
  // es justamente cuando más se tipea. Sin esto, el DELETE le pediría al
  // servidor que borre una fila que nunca recibió — y se encolaría también.
  const G = cargar();
  const alm = almacenFalso();
  const red = redFalsa();
  const f = G.arrancar({ almacen: alm, fetch: red.fetch });
  red.hay = false;
  const j = await (await f('/api/galpon/volcados', POST({ kilos: 4500 }))).json();
  assert.equal((await G.pendientes()).length, 1);

  red.pedidos.length = 0;
  const d = await f('/api/galpon/volcados/' + j.id, { method: 'DELETE' });
  assert.equal(d.ok, true);
  assert.equal((await d.json()).borrado_local, true);
  assert.equal((await G.pendientes()).length, 0, 'la carga deshecha sigue en la cola');
  assert.equal(red.pedidos.length, 0, 'le pidió al servidor que borre algo que no tiene');

  // Y al volver la señal no sale nada: se deshizo antes de salir.
  red.hay = true;
  assert.equal((await G.mandar()).enviados, 0);
});

test('corregir una encolada avisa en vez de hacerlo a medias', async () => {
  // Reescribir el cuerpo en la cola es poco frecuente y hacerlo mal deja la
  // fila con la mitad de los datos viejos. Se borra y se carga de nuevo.
  const G = cargar();
  const red = redFalsa();
  const f = G.arrancar({ almacen: almacenFalso(), fetch: red.fetch });
  red.hay = false;
  const j = await (await f('/api/galpon/volcados', POST({ kilos: 1 }))).json();
  const r = await f('/api/galpon/volcados/' + j.id,
    { method: 'PATCH', body: JSON.stringify({ kilos: 2 }) });
  assert.equal(r.ok, false);
  const e = await r.json();
  assert.match(e.error, /todavía no salió/);
  assert.equal((await G.pendientes()).length, 1, 'perdió la carga al querer corregirla');
});
