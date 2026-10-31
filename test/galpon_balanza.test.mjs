// ══ ⚖️ LA BALANZA POR PUERTO SERIE ═══════════════════════════════════════
//
// Andy, 31/10/2026: «vamos a comprar un cable» y «vamos a poner la computadora
// al lado». El indicador es un PRECISION F9, con salida RS-232 de fábrica.
//
// EL PARSER SE EJECUTA DE VERDAD. `src/balanza.js` es un script de navegador y
// no un módulo ESM, así que no se puede importar — pero sí evaluar con
// new Function(), que es lo mismo que hace el navegador. Un test que leyera el
// archivo como TEXTO y buscara expresiones regulares no probaría nada: lo que
// puede estar mal acá es el número que sale, no cómo está escrito.
//
// Lo que falla CALLADO, y por eso tiene test:
//
//   1. GRAMOS. Un indicador puesto en gramos manda 12340 donde van 12,34 kg.
//      Es el mismo cero de más de siempre, con otra ropa.
//   2. «NO DICE SI ESTÁ ESTABLE» NO ES «INESTABLE». Tratarlos igual hace que
//      una balanza que no manda el estado no cargue jamás un kilo.
//   3. MEDIA TRAMA. Lo último que llega por el puerto puede estar cortado al
//      medio: parsearlo da 12,3 donde iban 123,4 y el número es creíble.
//   4. EL CONTADOR DE PIEZAS. Estos indicadores mandan varios números en la
//      misma línea; agarrar el que no es da un peso plausible y equivocado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUENTE = fs.readFileSync(path.join(RAIZ, 'src/balanza.js'), 'utf8');

// El archivo de verdad, ejecutado. Si algún día hace algo al cargarse que
// necesite un navegador, este test se cae — y eso también estaría bien saberlo.
const BAL = new Function(FUENTE + '\nreturn BAL;')();

// ══════════════════════════════════════════════════════════════════════════
// 1 · LAS TRAMAS QUE MANDAN ESTOS INDICADORES
// ══════════════════════════════════════════════════════════════════════════
test('la trama más común: ST,GS,+0012.34kg', () => {
  const l = BAL.leerTrama('ST,GS,+0012.34kg');
  assert.equal(l.kilos, 12.34);
  assert.equal(l.estable, true);
  assert.equal(l.unidad, 'kg');
});

test('US es moviéndose, ST es firme', () => {
  assert.equal(BAL.leerTrama('US,GS,+0012.34kg').estable, false);
  assert.equal(BAL.leerTrama('ST,NT,   8.5kg').estable, true);
  assert.equal(BAL.leerTrama('ST,NT,   8.5kg').kilos, 8.5);
});

test('«NO DICE» NO ES «INESTABLE»', () => {
  // Son tres valores y no dos. Si null se tratara como inestable, una balanza
  // que no manda el estado no cargaría jamás un kilo — y nadie entendería por
  // qué, porque el peso se ve perfecto en la pantalla del indicador.
  assert.equal(BAL.leerTrama('  12.34 kg').estable, null);
  assert.equal(BAL.leerTrama('+0012,34').estable, null);
  assert.notEqual(BAL.leerTrama('  12.34 kg').estable, false);
});

test('la coma decimal se entiende igual que el punto', () => {
  assert.equal(BAL.leerTrama('+0012,34').kilos, 12.34);
  assert.equal(BAL.leerTrama('ST,GS,+0012,34kg').kilos, 12.34);
});

test('los ceros a la izquierda no cambian nada', () => {
  assert.equal(BAL.leerTrama('+000012.34kg').kilos, 12.34);
  assert.equal(BAL.leerTrama('0012').kilos, 12);
});

test('el peso negativo se lee negativo, no se pierde el signo', () => {
  // Pasa cuando levantan algo con la plataforma tarada. Mostrarlo en positivo
  // sería inventar kilos.
  assert.equal(BAL.leerTrama('ST,GS,-0002.50kg').kilos, -2.5);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LA UNIDAD
// ══════════════════════════════════════════════════════════════════════════
test('GRAMOS SE CONVIERTEN A KILOS', () => {
  // Un indicador puesto en gramos manda 12340. Guardado tal cual son doce mil
  // kilos en un cajón: el mismo cero de más de siempre, por mil.
  assert.equal(BAL.leerTrama('12340 g').kilos, 12.34);
  assert.equal(BAL.leerTrama('ST,GS,+012340g').kilos, 12.34);
  assert.equal(BAL.leerTrama('12340 g').unidad, 'g');
});

test('libras también, por si el indicador viene de fábrica así', () => {
  const l = BAL.leerTrama('ST,GS,+00010.00lb');
  assert.equal(l.unidad, 'lb');
  assert.equal(l.kilos, 4.536);
});

test('«g» pegada a otra letra no es gramos', () => {
  // «GS» (gross) termina en S, pero hay tramas con palabras. Una «g» adentro de
  // una palabra no puede dividir el peso por mil.
  assert.equal(BAL.leerTrama('ST,GS,+0012.34 kg').kilos, 12.34);
  assert.equal(BAL.leerTrama('12.34 grs').unidad, 'kg',
    'tomó una palabra que empieza con g como la unidad gramos');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · CUÁL DE LOS NÚMEROS ES EL PESO
// ══════════════════════════════════════════════════════════════════════════
test('EL QUE TIENE LA UNIDAD PEGADA GANA', () => {
  // Estos indicadores mandan varios números en la misma línea —neto, tara,
  // piezas—. Agarrar el que no es da un peso plausible y equivocado.
  assert.equal(BAL.leerTrama('ST,GS,+0012.34kg,PCS,25').kilos, 12.34);
  assert.equal(BAL.leerTrama('N 5 ST,GS,+0012.34kg').kilos, 12.34);
});

test('sin unidad, gana el primero que tenga pinta de peso', () => {
  // Un peso casi siempre trae signo o decimales; un contador de piezas, casi
  // nunca. No es una certeza — por eso existe el probador, que muestra la trama
  // de verdad para ajustar esto contra el aparato.
  assert.equal(BAL.leerTrama('25 +12.34').kilos, 12.34);
  assert.equal(BAL.leerTrama('ST,GS,+0012.34').kilos, 12.34);
});

test('una línea sin ningún número no es una lectura', () => {
  for (const mala of ['', '   ', 'ERROR', 'ST,GS,', null, undefined, '\r\n']) {
    assert.equal(BAL.leerTrama(mala), null, 'leyó un peso en ' + JSON.stringify(mala));
  }
});

test('los caracteres de control no rompen la lectura', () => {
  // Muchos indicadores enmarcan con STX/ETX y ensucian con nulos.
  assert.equal(BAL.leerTrama('\x02ST,GS,+0012.34kg\x03').kilos, 12.34);
  assert.equal(BAL.leerTrama('ST,GS,+0012.34kg\r').kilos, 12.34);
  assert.equal(BAL.leerTrama('\x00\x00 12.34 kg').kilos, 12.34);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · CORTAR EL CHORRO DE BYTES
// ══════════════════════════════════════════════════════════════════════════
test('MEDIA TRAMA NO SE PARSEA: queda de resto', () => {
  // Lo último que llega por el puerto está cortado donde quiso el sistema
  // operativo. Parsearlo daría 12,3 donde iban 123,4 — y 12,3 es un peso
  // perfectamente creíble para un cajón.
  const p = BAL.partir('ST,GS,+1.5kg\r\nST,GS,+2.5kg\r\nST,GS,+12');
  assert.deepEqual(p.lineas, ['ST,GS,+1.5kg', 'ST,GS,+2.5kg']);
  assert.equal(p.resto, 'ST,GS,+12');
});

test('el resto se completa con lo que llega después', () => {
  let buf = '';
  const salidas = [];
  for (const trozo of ['ST,GS,+1', '2.34kg\r\nST,', 'GS,+9.9kg\r\n']) {
    buf += trozo;
    const p = BAL.partir(buf);
    buf = p.resto;
    for (const l of p.lineas) salidas.push(BAL.leerTrama(l).kilos);
  }
  assert.deepEqual(salidas, [12.34, 9.9]);
  assert.equal(buf, '');
});

test('corta con CR, con LF, con CRLF y con STX/ETX', () => {
  assert.equal(BAL.partir('a\rb\rc\r').lineas.length, 3);
  assert.equal(BAL.partir('a\nb\nc\n').lineas.length, 3);
  assert.equal(BAL.partir('a\r\nb\r\nc\r\n').lineas.length, 3);
  assert.equal(BAL.partir('\x02a\x03\x02b\x03').lineas.length, 2);
});

test('las líneas vacías no son lecturas', () => {
  assert.deepEqual(BAL.partir('\r\n\r\n12.3kg\r\n').lineas, ['12.3kg']);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · EL PROBADOR
// ══════════════════════════════════════════════════════════════════════════
test('el hexa muestra los bytes de a dos, en mayúscula', () => {
  // Es la mitad del probador: cuando el texto se ve como basura, lo que dice de
  // qué se trata es el byte — y casi siempre es que los baudios están mal.
  assert.equal(BAL.hex([2, 83, 84, 13, 10, 255]), '02 53 54 0D 0A FF');
  assert.equal(BAL.hex([]), '');
});

test('los caracteres de control se ven', () => {
  // Sin esto, un CR y un espacio se ven igual y no hay forma de saber dónde
  // corta la trama.
  assert.equal(BAL.visible('ST\r\n'), 'ST⏎␊');
  assert.equal(BAL.visible('\x02a\x03'), '␂a␃');
  assert.equal(BAL.visible('12.34 kg'), '12.34 kg');
});

// ══════════════════════════════════════════════════════════════════════════
// 6 · SIN NAVEGADOR NO SE CAE
// ══════════════════════════════════════════════════════════════════════════
test('sin Web Serial dice que no, en vez de explotar', () => {
  // Es el caso de un celular o de Safari. La pantalla lo usa para no ofrecer un
  // botón que no puede funcionar.
  assert.equal(BAL.soportado(), false, 'node no tiene navigator.serial y dijo que sí');
  assert.equal(typeof BAL.recordado, 'function');
});

test('recordado() devuelve null y no tira cuando no hay navegador', async () => {
  assert.equal(await BAL.recordado(), null);
});

test('pedirPuerto explica POR QUÉ no se puede, no tira un error técnico', async () => {
  // El que lo lee está parado al lado de la balanza, no leyendo una consola.
  await assert.rejects(() => BAL.pedirPuerto(), (e) => {
    assert.match(e.message, /Chrome o Edge/);
    assert.match(e.message, /celular|Safari/);
    return true;
  });
});

test('el archivo no hace nada al cargarse', () => {
  // Si tocara navigator o document al evaluarse, el new Function de arriba se
  // habría caído. Que este archivo exista prueba que no.
  assert.equal(typeof BAL.leerTrama, 'function');
  assert.equal(typeof BAL.partir, 'function');
  assert.equal(BAL.estado.conectada, false);
  assert.equal(BAL.estado.puerto, null);
});
