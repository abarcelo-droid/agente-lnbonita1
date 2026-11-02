/* ══════════════════════════════════════════════════════════════════════════════════════
   📴 EL GALPÓN SIN INTERNET — LA PARTE DEL NAVEGADOR
   ══════════════════════════════════════════════════════════════════════════════════════
   La lógica está en galponOffline.js (GOFF), que se prueba ejecutándola contra un
   almacén de mentira. Acá vive lo que sólo existe en el navegador y no se puede probar
   sin él: IndexedDB, los eventos de conexión, y la barra que ve el operador.

   TRES PIEZAS:

   1. EL ALMACÉN. IndexedDB y no localStorage: localStorage es síncrono —congela la
      pantalla mientras escribe— y tiene 5 MB para todo el sitio. Una jornada de carga
      son cientos de pedidos y la cola no puede competir por ese espacio con el resto
      del panel.

   2. EL CACHÉ DE LECTURAS. Sin señal, un GET al galpón devuelve LO ÚLTIMO que contestó
      el servidor, con un aviso. Sin esto la pantalla abre vacía: no hay lotes, no hay
      cuadrillas, no hay presentaciones — y no se puede cargar nada aunque la cola
      funcione.

   3. LA BARRA. Un contador de lo que está esperando. Es lo único que le dice al operador
      que sus kilos están guardados y todavía no llegaron; sin eso, «sin conexión» se
      parece demasiado a «se perdió».
   ══════════════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof GOFF === 'undefined') return;

  var BASE = 'lnb-galpon';
  var VERSION = 1;
  var COLA = 'cola';
  var LECTURAS = 'lecturas';

  // ── 1 · EL ALMACÉN ────────────────────────────────────────────────────────────────
  var bd = null;
  function abrir() {
    if (bd) return bd;
    bd = new Promise(function (ok, mal) {
      var p = indexedDB.open(BASE, VERSION);
      p.onupgradeneeded = function () {
        var d = p.result;
        if (!d.objectStoreNames.contains(COLA)) d.createObjectStore(COLA, { keyPath: 'uuid' });
        if (!d.objectStoreNames.contains(LECTURAS)) d.createObjectStore(LECTURAS, { keyPath: 'url' });
      };
      p.onsuccess = function () { ok(p.result); };
      p.onerror = function () { mal(p.error); };
    });
    return bd;
  }

  function pedido(store, modo, fn) {
    return abrir().then(function (d) {
      return new Promise(function (ok, mal) {
        var t = d.transaction(store, modo);
        var r = fn(t.objectStore(store));
        t.oncomplete = function () { ok(r && r.result); };
        t.onerror = function () { mal(t.error); };
      });
    });
  }

  var almacen = {
    guardar: function (f) { return pedido(COLA, 'readwrite', function (s) { return s.put(f); }); },
    borrar: function (u) { return pedido(COLA, 'readwrite', function (s) { return s.delete(u); }); },
    listar: function () {
      return pedido(COLA, 'readonly', function (s) { return s.getAll(); })
        .then(function (l) { return l || []; });
    },
  };

  // ── 2 · EL CACHÉ DE LECTURAS ──────────────────────────────────────────────────────
  /* Sólo los GET del galpón, y sólo los que contestaron bien. Guardar una respuesta de
     error sería servirla mañana como si fuera el stock. */
  function guardarLectura(url, texto) {
    return pedido(LECTURAS, 'readwrite', function (s) {
      return s.put({ url: url, texto: texto, cuando: Date.now() });
    }).catch(function () { /* sin espacio: se sigue sin caché, no se rompe nada */ });
  }
  function leerGuardado(url) {
    return pedido(LECTURAS, 'readonly', function (s) { return s.get(url); })
      .catch(function () { return null; });
  }

  // ── 3 · LA BARRA ──────────────────────────────────────────────────────────────────
  var barra = null;
  function pintar(e) {
    if (!barra) {
      barra = document.createElement('div');
      barra.id = 'gal-off-barra';
      barra.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;'
        + 'padding:7px 14px;font:13px system-ui,sans-serif;display:none;'
        + 'align-items:center;gap:10px;box-shadow:0 -2px 10px rgba(15,23,42,.12)';
      document.body.appendChild(barra);
    }
    var sinRed = !navigator.onLine;
    var n = (e && e.pendientes) || 0;
    if (!sinRed && !n) { barra.style.display = 'none'; return; }
    barra.style.display = 'flex';
    /* Rojo sólo cuando hay algo TRABADO. Sin señal con la cola andando es una situación
       normal en el campo y pintarla de rojo enseña a ignorar el rojo. */
    var trabado = e && e.trabados > 0;
    barra.style.background = trabado ? '#fee2e2' : (sinRed ? '#fef3c7' : '#dcfce7');
    barra.style.color = trabado ? '#991b1b' : (sinRed ? '#92400e' : '#166534');
    barra.innerHTML =
      (sinRed ? '📴 <b>Sin conexión.</b> ' : '📶 <b>Conectado.</b> ')
      + (n
        ? ('Hay <b>' + n + '</b> carga' + (n === 1 ? '' : 's') + ' esperando'
           + (trabado
              ? (' — <b>' + e.trabados + ' no está' + (e.trabados === 1 ? '' : 'n')
                 + ' pudiendo salir.</b> Avisá.')
              : (sinRed ? ' en este equipo. Se mandan solas cuando vuelva.'
                        : '; mandando…')))
        : 'Se puede seguir cargando: lo que entre ahora se guarda acá.');
    if (n && navigator.onLine) {
      barra.innerHTML += ' <button type="button" id="gal-off-ya" style="margin-left:auto;'
        + 'border:1px solid currentColor;background:transparent;color:inherit;'
        + 'border-radius:7px;padding:3px 9px;cursor:pointer;font:inherit">Mandar ahora</button>';
      var b = document.getElementById('gal-off-ya');
      if (b) b.onclick = function () { GOFF.mandar().then(avisarRechazos); };
    }
  }

  /* Lo que el servidor RECHAZÓ no puede desaparecer en silencio: esa carga no entró y
     alguien la tiene que volver a hacer. Se muestra una vez, con lo que se había
     cargado, porque el operador ya no lo tiene en pantalla. */
  function avisarRechazos(r) {
    if (!r || !r.rechazados || !r.rechazados.length) return;
    var det = r.rechazados.map(function (x) {
      var d = {};
      try { d = JSON.parse(x.cuerpo); } catch (e) { /* queda vacío */ }
      return '· ' + x.motivo + (d.kilos ? (' (eran ' + d.kilos + ' kg)') : '');
    }).join('\n');
    alert('El servidor no aceptó ' + r.rechazados.length + ' carga'
      + (r.rechazados.length === 1 ? '' : 's') + ':\n\n' + det
      + '\n\nHay que volver a cargarlas.');
  }

  // ── EL ENVOLTORIO ─────────────────────────────────────────────────────────────────
  var real = window.fetch.bind(window);
  var conCola = GOFF.arrancar({
    almacen: almacen,
    fetch: real,
    alCambiar: pintar,
  });

  window.fetch = function (url, opts) {
    var u = typeof url === 'string' ? url : (url && url.url) || '';
    var metodo = String((opts || {}).method || 'GET').toUpperCase();
    // Sólo el galpón: el resto del panel sigue andando exactamente como antes.
    if (u.indexOf('/api/galpon/') < 0) return real(url, opts);

    if (metodo === 'GET') {
      return real(url, opts).then(function (r) {
        /* Se guarda una COPIA: el cuerpo de una Response se lee una sola vez, y leerlo
           acá dejaría a la pantalla con las manos vacías. */
        if (r && r.ok) { r.clone().text().then(function (t) { guardarLectura(u, t); }); }
        return r;
      }).catch(function (e) {
        return leerGuardado(u).then(function (g) {
          if (!g) throw e;
          /* Lo guardado viaja con la marca de cuándo se leyó: una pantalla que muestra
             datos de ayer sin decirlo es peor que una vacía. */
          var d;
          try { d = JSON.parse(g.texto); } catch (e2) { throw e; }
          d.de_cache = true;
          d.cache_cuando = g.cuando;
          return new Response(JSON.stringify(d), { status: 200,
            headers: { 'Content-Type': 'application/json' } });
        });
      });
    }
    return conCola(url, opts);
  };

  // ── LOS DISPARADORES ──────────────────────────────────────────────────────────────
  window.addEventListener('online', function () {
    pintar({ pendientes: 0 });
    GOFF.mandar().then(avisarRechazos);
  });
  window.addEventListener('offline', function () { GOFF.estado().then(pintar); });

  /* Un tic lento por si el evento 'online' no llega: pasa cuando el equipo tiene red
     pero el servidor no contesta, que para el navegador NO es estar offline. Dos
     minutos: lo suficiente para que no se note la espera, lo bastante poco para no
     golpear el servidor con una cola grande. */
  setInterval(function () {
    GOFF.estado().then(function (e) {
      if (e.pendientes && navigator.onLine) GOFF.mandar().then(avisarRechazos);
      else pintar(e);
    });
  }, 120000);

  // Al abrir: lo que haya quedado de ayer sale ahora.
  GOFF.estado().then(function (e) {
    pintar(e);
    if (e.pendientes && navigator.onLine) GOFF.mandar().then(avisarRechazos);
  });
})();
