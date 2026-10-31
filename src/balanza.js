/* ═══════════════════════════════════════════════════════════════════════════════════
   ⚖️ LA BALANZA, LEÍDA POR EL PUERTO SERIE
   ═══════════════════════════════════════════════════════════════════════════════════
   Andy, 31/10/2026: «vamos a comprar un cable» y «vamos a poner la computadora al lado».
   El indicador es un PRECISION F9, que trae una salida RS-232 de fábrica.

   Va por Web Serial, del lado del navegador. Tres cosas que conviene saber antes de
   tocar este archivo:

   1. WEB SERIAL ES SÓLO DE ESCRITORIO. Chrome y Edge en Windows, Mac, Linux y ChromeOS.
      No existe en Safari ni en ningún navegador de celular. Por eso al lado de la
      balanza va una PC y no una tablet.

   2. EL PUERTO LO ELIGE UNA PERSONA, NO EL CÓDIGO. El navegador abre un diálogo y hace
      falta un gesto (un clic) para que aparezca. Lo que SÍ se puede es reabrir sin
      preguntar uno que ya se eligió antes: `navigator.serial.getPorts()`. Eso es lo que
      hace que no haya que elegir el puerto todas las mañanas.

   3. EL FORMATO DE LA TRAMA TODAVÍA NO ESTÁ CONFIRMADO. El manual del F9 no está, y el
      parser de acá cubre los formatos que mandan casi todos estos indicadores. Por eso
      existe el probador en Configuración: muestra lo que llega EN CRUDO al lado de lo
      que se entendió, y con eso se ajusta contra el aparato de verdad. Está escrito así
      a propósito — adivinar el formato y después "arreglarlo" a ciegas es peor.

   Vive en src/ y se sirve por /static (ver servicios/estaticos_publicos.js). Es un
   script de navegador común, sin módulos, para que lo pueda cargar panel.html — y
   los tests lo ejecutan de verdad con new Function() en vez de leerlo como texto. */
var BAL = (function () {
  'use strict';

  /* ── EL PARSER ─────────────────────────────────────────────────────────────────
     Devuelve { kilos, estable, unidad, crudo } o null si la línea no tiene un peso.

     `estable` tiene TRES valores y no dos: true, false y null. null es «la trama no lo
     dice», que no es lo mismo que «inestable». Tratarlos igual haría que una balanza
     que no manda el estado no cargue nunca un kilo. */
  function aNumero(s) {
    var n = Number(String(s).replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  function leerTrama(linea) {
    var crudo = String(linea == null ? '' : linea);
    // Los de control se vuelven espacio salvo CR y LF, que ya partieron la línea.
    var t = crudo.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim();
    if (!t) return null;

    var estable = /(^|[^A-Za-z])ST([^A-Za-z]|$)/.test(t) ? true
      : (/(^|[^A-Za-z])US([^A-Za-z]|$)/.test(t) ? false : null);

    /* EL NÚMERO. Primero el que venga con la unidad pegada: ése es el peso y no hay
       dudas. Si ninguno la trae, se prefiere el primero que tenga signo o coma decimal
       —un peso casi siempre los tiene y un contador de piezas casi nunca— y recién
       después, el primero a secas. */
    var unidad = null, valor = null;
    var m = /([+-]?\d+(?:[.,]\d+)?)\s*(kg|g|lb)(?![A-Za-z])/i.exec(t);
    if (m) {
      valor = aNumero(m[1]);
      unidad = m[2].toLowerCase();
    } else {
      var todos = t.match(/[+-]?\d+(?:[.,]\d+)?/g) || [];
      if (!todos.length) return null;
      var conPinta = todos.filter(function (x) { return /[+\-.,]/.test(x); });
      valor = aNumero((conPinta.length ? conPinta : todos)[0]);
    }
    if (valor == null) return null;

    /* GRAMOS. Es el mismo error de siempre con otra ropa: un indicador puesto en gramos
       manda 12340 donde se esperan 12,34 kg, y el número entra mil veces más grande sin
       que nada avise. Se convierte acá, que es el único lugar que sabe la unidad. */
    var kilos = unidad === 'g' ? valor / 1000
      : (unidad === 'lb' ? valor * 0.45359237 : valor);

    return {
      kilos: Math.round(kilos * 1000) / 1000,
      estable: estable,
      unidad: unidad || 'kg',
      crudo: crudo,
    };
  }

  /* Corta el chorro de bytes en líneas. STX y ETX se tratan como cortes: hay
     indicadores que enmarcan con eso en vez de terminar con CR/LF.

     Devuelve el RESTO aparte: lo último que llegó puede ser media trama, y parsearla
     daría un peso cortado por la mitad — 12,3 donde iban 123,4. */
  function partir(buffer) {
    var t = String(buffer == null ? '' : buffer).replace(/[\x02\x03]/g, '\n');
    var partes = t.split(/\r\n|\r|\n/);
    var resto = partes.pop();
    return {
      lineas: partes.filter(function (l) { return l.trim() !== ''; }),
      resto: resto,
    };
  }

  /* ── EL PUERTO ─────────────────────────────────────────────────────────────── */
  var S = {
    puerto: null, lector: null, cerrando: false, buffer: '',
    baudios: 9600, conectada: false,
    onLectura: null,   // (lectura|null, linea)  — una por trama
    onCrudo: null,     // (texto, bytes)         — para el probador
    onEstado: null,    // (estado, detalle)
  };

  function soportado() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
  }

  function avisar(estado, detalle) {
    S.conectada = estado === 'conectada';
    if (S.onEstado) { try { S.onEstado(estado, detalle || ''); } catch (e) {} }
  }

  /* Un puerto ya autorizado antes. No hace falta gesto: es lo que permite que la
     pantalla se reconecte sola al abrirse y que nadie elija el puerto cada mañana. */
  async function recordado() {
    if (!soportado()) return null;
    try {
      var ps = await navigator.serial.getPorts();
      return ps && ps.length ? ps[0] : null;
    } catch (e) { return null; }
  }

  // Esto SÍ necesita el clic: el navegador no deja abrir el diálogo por código.
  async function pedirPuerto() {
    if (!soportado()) throw new Error('Este navegador no tiene Web Serial. '
      + 'Hace falta Chrome o Edge de escritorio: en celular y en Safari no existe.');
    return await navigator.serial.requestPort();
  }

  async function conectar(puerto, baudios) {
    if (S.puerto) await desconectar();
    var b = Number(baudios) || 9600;
    await puerto.open({ baudRate: b, dataBits: 8, stopBits: 1, parity: 'none' });
    S.puerto = puerto; S.baudios = b; S.buffer = ''; S.cerrando = false;
    avisar('conectada');
    bucle();
    return true;
  }

  async function bucle() {
    var dec = new TextDecoder();
    while (S.puerto && S.puerto.readable && !S.cerrando) {
      S.lector = S.puerto.readable.getReader();
      try {
        while (true) {
          var r = await S.lector.read();
          if (r.done) break;
          var txt = dec.decode(r.value, { stream: true });
          if (S.onCrudo) { try { S.onCrudo(txt, r.value); } catch (e) {} }
          S.buffer += txt;
          // Un indicador que no manda terminadores haría crecer esto para siempre.
          if (S.buffer.length > 4000) S.buffer = S.buffer.slice(-500);
          var p = partir(S.buffer);
          S.buffer = p.resto;
          for (var i = 0; i < p.lineas.length; i++) {
            if (S.onLectura) {
              try { S.onLectura(leerTrama(p.lineas[i]), p.lineas[i]); } catch (e) {}
            }
          }
        }
      } catch (e) {
        if (!S.cerrando) avisar('error', e.message);
      } finally {
        try { S.lector.releaseLock(); } catch (e) {}
        S.lector = null;
      }
    }
    if (!S.cerrando) avisar('desconectada');
  }

  async function desconectar() {
    S.cerrando = true;
    try { if (S.lector) await S.lector.cancel(); } catch (e) {}
    try { if (S.puerto) await S.puerto.close(); } catch (e) {}
    S.puerto = null; S.lector = null; S.buffer = '';
    avisar('desconectada');
  }

  /* El hexa de lo que llegó. Es la mitad del probador: cuando el texto se ve como
     basura, lo que dice de qué se trata es el byte. */
  function hex(bytes) {
    var out = [];
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16).toUpperCase();
      out.push(h.length < 2 ? '0' + h : h);
    }
    return out.join(' ');
  }

  // Los de control, visibles: sin esto un CR y un espacio se ven igual.
  function visible(txt) {
    return String(txt).replace(/[\x00-\x1f\x7f]/g, function (c) {
      var n = c.charCodeAt(0);
      if (n === 13) return '⏎';
      if (n === 10) return '␊';
      if (n === 2) return '␂';
      if (n === 3) return '␃';
      return '·';
    });
  }

  return {
    leerTrama: leerTrama,
    partir: partir,
    hex: hex,
    visible: visible,
    soportado: soportado,
    recordado: recordado,
    pedirPuerto: pedirPuerto,
    conectar: conectar,
    desconectar: desconectar,
    estado: S,
  };
})();

if (typeof window !== 'undefined') window.BAL = BAL;
