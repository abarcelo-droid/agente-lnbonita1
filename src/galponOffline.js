/* ══════════════════════════════════════════════════════════════════════════════════════
   📴 EL GALPÓN SIN INTERNET
   ══════════════════════════════════════════════════════════════════════════════════════
   Andy, 2/11/2026: «quiero que hagas todo el módulo de galpón disponible sin conexión a
   INTERNET. Que los chicos puedan cargar info sin necesidad de estar conectados».

   El galpón está en el campo y la señal se corta. Hasta ahora, una carga sin señal se
   perdía: el botón contestaba un error de red y esos kilos no los volvía a tipear nadie.

   ── LA REGLA QUE ORDENA TODO ───────────────────────────────────────────────────────
   NADA SE PIERDE Y NADA SE INVENTA. Lo que no pudo salir se guarda en el equipo y se
   manda cuando vuelve la señal; pero un pedido que el SERVIDOR contestó que no —un 400,
   un 403— NO se encola: el servidor habló, y reintentarlo mil veces no lo va a
   convencer. La diferencia entre «no llegué» y «llegué y me dijeron que no» es la
   única que importa acá.

   ── POR QUÉ NO SE ENCOLA TODO ──────────────────────────────────────────────────────
   Se encola lo que no necesita la respuesta para seguir: una carga de kilos, un
   proceso. NO se encola abrir un pallet o un despacho, porque el id lo da el servidor y
   todo lo que viene después cuelga de ese id. Inventar uno acá es inventar un pallet
   que después no existe, y eso es peor que avisar que hace falta señal para esa acción.

   ── IDEMPOTENCIA ───────────────────────────────────────────────────────────────────
   Cada pedido encolado viaja con su `uuid`, que el servidor ya usa para no duplicar
   (gal_volcados.uuid y gal_procesos.uuid son UNIQUE). Reintentar diez veces el mismo
   pedido guarda una sola fila. Sin eso, una señal que va y viene duplica kilos.

   ── POR QUÉ ESTE ARCHIVO SE PRUEBA EJECUTÁNDOLO ────────────────────────────────────
   Es un script de navegador —no un módulo— igual que src/balanza.js, y el test lo carga
   con `new Function(FUENTE + '\nreturn GOFF;')`. El almacén y el reloj entran por
   parámetro, así que la lógica se prueba sin IndexedDB y sin esperar de verdad.
   ══════════════════════════════════════════════════════════════════════════════════════ */

var GOFF = (function () {
  'use strict';

  /* LO QUE SE PUEDE ENCOLAR. Una lista explícita y no «todo lo que sea POST»: lo que se
     encola se ejecuta MÁS TARDE, y hay pedidos cuyo resultado se necesita ya. Un método
     y una expresión; el orden importa y gana la primera que coincide. */
  var ENCOLABLES = [
    // Las cargas del día: es lo que hacen los chicos todo el día y lo que no se puede
    // perder. Las tres llevan uuid propio generado en la pantalla.
    { metodo: 'POST', re: /^\/api\/galpon\/volcados$/ },
    { metodo: 'POST', re: /^\/api\/galpon\/procesos$/ },
    // Corregir y borrar una carga que YA existe en el servidor: el id es del servidor,
    // así que el pedido es válido aunque salga más tarde.
    { metodo: 'PATCH', re: /^\/api\/galpon\/volcados\/\d+$/ },
    { metodo: 'DELETE', re: /^\/api\/galpon\/volcados\/\d+$/ },
    { metodo: 'PATCH', re: /^\/api\/galpon\/procesos\/\d+$/ },
    { metodo: 'DELETE', re: /^\/api\/galpon\/procesos\/\d+$/ },
    // El lote del día y los datos del lote: son del día y no devuelven nada que se use.
    { metodo: 'POST', re: /^\/api\/galpon\/lote-dia$/ },
    { metodo: 'PATCH', re: /^\/api\/galpon\/lote-dia\/\d+$/ },
    { metodo: 'POST', re: /^\/api\/galpon\/lote-datos$/ },
  ];

  /* LO QUE NO SE ENCOLA NUNCA, aunque sea del galpón. Se nombra con su razón porque la
     tentación de agregarlas es permanente: todas parecen «una carga más».

       · abrir un pallet o un despacho  → el id lo da el servidor y todo lo de después
                                          cuelga de ese id
       · cerrar / emitir                → asigna el NÚMERO del correlativo, que no se
                                          puede inventar en un equipo sin saber qué hay
                                          en los otros
       · mover al pallet, agregar ítems → el tope se calcula contra el stock de verdad;
                                          encolarlo deja armar pallets con cajas que
                                          otro ya se llevó
       · el catálogo y la configuración → es parametrización, no trabajo del día

     Estas devuelven el error de red tal cual, y la pantalla avisa que hace falta señal. */

  // ── EL ESTADO ───────────────────────────────────────────────────────────────────────
  var almacen = null;      // lo inyecta arrancar(): IndexedDB en el navegador
  var reloj = function () { return Date.now(); };
  var pedir = null;        // el fetch de verdad
  var alCambiar = function () {};
  var mandando = false;

  /* El prefijo del id de lo que todavía no salió. Se ve a simple vista en cualquier
     lugar donde aparezca, que es la idea: un número inventado que se parece a uno real
     es el que después nadie puede distinguir. */
  var ID_LOCAL = 'enc:';

  // ¿Es el id de algo que está en la cola y nunca llegó al servidor?
  function esLocal(url) {
    return /\/enc:[^/]+$/.test(String(url || '').split('?')[0]);
  }
  function uuidDeUrl(url) {
    var m = /\/enc:([^/?]+)/.exec(String(url || ''));
    return m ? m[1] : null;
  }

  function esEncolable(metodo, url) {
    var m = String(metodo || 'GET').toUpperCase();
    var ruta = String(url || '').split('?')[0];
    for (var i = 0; i < ENCOLABLES.length; i++) {
      if (ENCOLABLES[i].metodo === m && ENCOLABLES[i].re.test(ruta)) return true;
    }
    return false;
  }

  /* ¿ESTO ES «NO LLEGUÉ» O «LLEGARON Y DIJERON QUE NO»? Un fetch que TIRA es siempre lo
     primero: el navegador no pudo hablar con nadie. Un fetch que CONTESTA, aunque sea
     500, llegó — y un 500 que se reintenta solo es una pantalla que miente diciendo que
     se guardó.

     El 503 y el 504 son la excepción: los contesta un intermediario cuando el servidor
     no está, así que el pedido no se ejecutó y reintentarlo es correcto. */
  function esFalloDeRed(err, respuesta) {
    if (err) return true;
    if (!respuesta) return true;
    return respuesta.status === 503 || respuesta.status === 504;
  }

  // Un uuid para el pedido que no traiga el suyo. crypto.randomUUID existe en todo
  // navegador de escritorio desde 2021; el respaldo es por si el panel se abre en algo
  // viejo, y no tiene que ser criptográfico: sólo distinto de los demás.
  function nuevoUuid() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* sigue abajo */ }
    return 'g-' + reloj().toString(36) + '-'
      + Math.random().toString(36).slice(2, 10);
  }

  /* El uuid va en el CUERPO y no en un encabezado, porque es el que el servidor ya mira
     para no duplicar. Si el cuerpo no es JSON, el pedido no se encola: no hay dónde
     ponerlo y sin uuid un reintento duplica. */
  function conUuid(cuerpo) {
    var d;
    try { d = JSON.parse(cuerpo || '{}'); } catch (e) { return null; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    if (!d.uuid) d.uuid = nuevoUuid();
    return { texto: JSON.stringify(d), uuid: d.uuid };
  }

  // ── LA COLA ─────────────────────────────────────────────────────────────────────────
  async function encolar(url, opts) {
    var o = opts || {};
    var c = conUuid(o.body);
    if (!c) return null;
    var fila = {
      uuid: c.uuid,
      url: String(url),
      metodo: String(o.method || 'POST').toUpperCase(),
      cuerpo: c.texto,
      creado: reloj(),
      intentos: 0,
      ultimo_error: null,
    };
    await almacen.guardar(fila);
    alCambiar(await estado());
    return fila;
  }

  async function pendientes() {
    var l = await almacen.listar();
    // En el ORDEN EN QUE SE HICIERON. Cargar y después borrar esa misma carga,
    // reproducido al revés, borra algo que todavía no existe y después lo crea: queda
    // una fila que el operador ya había sacado.
    return l.slice().sort(function (a, b) { return a.creado - b.creado || 0; });
  }

  async function estado() {
    var l = await pendientes();
    return {
      pendientes: l.length,
      /* Los que ya fallaron varias veces se cuentan aparte: una cola que crece y no baja
         no es «sin señal», es algo roto, y el que carga tiene que poder distinguirlo. */
      trabados: l.filter(function (x) { return x.intentos >= 3; }).length,
      mas_viejo: l.length ? l[0].creado : null,
    };
  }

  /* MANDAR LO PENDIENTE. De a uno y en orden, y se CORTA al primer fallo de red: si se
     cayó la señal, seguir intentando los demás sólo gasta tiempo y desordena la cola.

     Un pedido que el servidor RECHAZA sale de la cola igual —con su error guardado—
     porque reintentarlo mil veces no lo va a convencer. Eso se le muestra al operador:
     es una carga que no entró y alguien tiene que mirarla. */
  async function mandar() {
    if (mandando) return { ok: true, ya_estaba: true };
    mandando = true;
    var enviados = 0;
    var rechazados = [];
    try {
      var l = await pendientes();
      for (var i = 0; i < l.length; i++) {
        var f = l[i];
        var res = null;
        var err = null;
        try {
          res = await pedir(f.url, {
            method: f.metodo,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: f.cuerpo,
          });
        } catch (e) { err = e; }

        if (esFalloDeRed(err, res)) {
          f.intentos = (f.intentos || 0) + 1;
          f.ultimo_error = err ? String(err.message || err) : ('HTTP ' + res.status);
          await almacen.guardar(f);
          break;                       // sigue sin señal: no tiene sentido insistir
        }
        if (res.ok) {
          enviados++;
        } else {
          var motivo = 'HTTP ' + res.status;
          try {
            var j = await res.json();
            if (j && j.error) motivo = j.error;
          } catch (e2) { /* el cuerpo no era JSON: queda el status */ }
          rechazados.push({ uuid: f.uuid, url: f.url, motivo: motivo, cuerpo: f.cuerpo });
        }
        await almacen.borrar(f.uuid);
      }
    } finally {
      mandando = false;
    }
    alCambiar(await estado());
    return { ok: true, enviados: enviados, rechazados: rechazados };
  }

  /* EL ENVOLTORIO. Se pone una vez sobre fetch y vale para las treinta llamadas del
     galpón: tocar las treinta serían treinta oportunidades de olvidarse de una, y la
     treinta y uno que alguien escriba mañana quedaría afuera.

     Lo que devuelve cuando encola es una Response de verdad con ok:true y
     `encolado:true` adentro, porque TODA la pantalla está escrita contra `j.ok`.
     Devolver un error haría que el operador vea «no se pudo» justo cuando sí se
     guardó. */
  function envolver(fetchReal) {
    pedir = fetchReal;
    return async function (url, opts) {
      var o = opts || {};
      var u = typeof url === 'string' ? url : (url && url.url) || '';
      /* BORRAR ALGO QUE NUNCA SALIÓ es sacarlo de la cola, no pedirle al servidor que
         borre una fila que no tiene. Y el deshacer de la carga rápida es lo primero
         que se aprieta cuando se tipea un cero de más: tiene que andar sin señal,
         porque sin señal es justamente cuando más se tipea. */
      if (esLocal(u)) {
        var m = String(o.method || 'GET').toUpperCase();
        if (m === 'DELETE') {
          await almacen.borrar(uuidDeUrl(u));
          alCambiar(await estado());
          return respuestaSimple({ ok: true, encolado: true, borrado_local: true });
        }
        /* Corregir una carga encolada sería reescribir su cuerpo en la cola. No está
           hecho a propósito: es poco frecuente y hacerlo a medias deja la fila con la
           mitad de los datos viejos. Se borra y se carga de nuevo, que son dos teclas. */
        return respuestaSimple({ ok: false,
          error: 'Esa carga todavía no salió de este equipo. Borrala y cargala de nuevo.' },
        400);
      }
      try {
        var r = await fetchReal(url, opts);
        /* Si volvió la señal, lo pendiente sale AHORA y no en el próximo tic: el
           operador acaba de ver que el pedido salió, y la cola tiene que vaciarse
           mientras mira. */
        if (r && r.ok) { mandar(); }
        return r;
      } catch (e) {
        if (!esEncolable(o.method, u)) throw e;
        var f = await encolar(u, o);
        if (!f) throw e;
        return respuestaEncolada(f);
      }
    };
  }

  function respuestaSimple(obj, status) {
    var cuerpo = JSON.stringify(obj);
    if (typeof Response !== 'undefined') {
      return new Response(cuerpo, { status: status || 200,
        headers: { 'Content-Type': 'application/json' } });
    }
    return { ok: !status || status < 400, status: status || 200,
             json: function () { return Promise.resolve(JSON.parse(cuerpo)); } };
  }

  /* LA RESPUESTA TRAE LA FILA QUE SE CARGÓ, no sólo un «ok». Las pantallas arman su
     lista con lo que el servidor devuelve —la carga rápida hace
     `unshift(Object.assign({id: j.id}, j.fila))`— y sin fila el renglón sale vacío: el
     operador no ve lo que acaba de cargar y lo carga de nuevo. Que es exactamente el
     problema que esto venía a resolver.

     El ID es LOCAL y se nota: 'enc:' + uuid. No se inventa un número que después va a
     chocar con uno de verdad, y el deshacer sabe por el prefijo que tiene que sacarlo
     de la cola en vez de pedirle al servidor que borre algo que nunca recibió. */
  function respuestaEncolada(f) {
    var fila = {};
    try { fila = JSON.parse(f.cuerpo) || {}; } catch (e) { /* queda vacía */ }
    var cuerpo = JSON.stringify({
      ok: true, encolado: true, uuid: f.uuid,
      id: ID_LOCAL + f.uuid,
      fila: Object.assign({}, fila, { id: ID_LOCAL + f.uuid, encolado: 1 }),
      aviso: 'Sin conexión: se guardó en este equipo y se manda solo cuando vuelva.',
    });
    if (typeof Response !== 'undefined') {
      return new Response(cuerpo, { status: 202,
        headers: { 'Content-Type': 'application/json' } });
    }
    // En el test no hay Response del navegador: alcanza con algo que se comporte igual.
    return { ok: true, status: 202, json: function () { return Promise.resolve(JSON.parse(cuerpo)); } };
  }

  function arrancar(cfg) {
    var c = cfg || {};
    almacen = c.almacen;
    if (c.reloj) reloj = c.reloj;
    if (c.alCambiar) alCambiar = c.alCambiar;
    return envolver(c.fetch);
  }

  return {
    arrancar: arrancar,
    encolar: encolar,
    pendientes: pendientes,
    estado: estado,
    mandar: mandar,
    esEncolable: esEncolable,
    esFalloDeRed: esFalloDeRed,
    conUuid: conUuid,
    ENCOLABLES: ENCOLABLES,
    ID_LOCAL: ID_LOCAL,
    esLocal: esLocal,
  };
})();

if (typeof window !== 'undefined') { window.GOFF = GOFF; }
