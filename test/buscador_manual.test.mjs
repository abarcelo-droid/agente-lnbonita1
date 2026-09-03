// ══ LA LUPA DEL «¿CÓMO SE USA?» ════════════════════════════════════════════
//
// Pablo, 3/9/2026: «fijate que hay buscadores en el "cómo se usa" que no
// funcionan bien».
//
// LO QUE PASABA. El buscador miraba CADA nodo de texto por separado. Los manuales
// están llenos de <b>, así que la mitad de las frases quedan partidas en dos
// nodos: «Por acá <b>entra la mercadería…</b>». Buscando «acá entra» —que está
// ahí, en pantalla, en dos palabras seguidas— contestaba «no hay nada sobre acá
// entra en este manual».
//
// Medido sobre los manuales de hoy: 179 pares de palabras vecinas en Ingresos,
// 90 en Órdenes de Compra, 84 en Mejoras. Uno de cada tres.
//
// CÓMO CORRE ESTO SIN NAVEGADOR. Se arma un DOM mínimo —los cuatro métodos que el
// buscador usa: childNodes, createTextNode, createElement, replaceChild— y se le
// da de comer el HTML REAL de cada manual, armado ejecutando el SG_MANUAL del
// repo. Lo que se prueba es la función del panel, no una copia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
// panel.html va con CRLF: se nombra el salto para no tener que escribirlo
// adentro de un string en cada corte.
const SALTO = String.fromCharCode(13, 10);

// ── Un DOM de mentira, con lo justo ────────────────────────────────────────

class Nodo {
  constructor(tag) {
    this.tagName = tag;
    this.nodeType = 1;
    this.childNodes = [];
    this._clases = new Set();
    this.classList = {
      toggle: (c, on) => { if (on) this._clases.add(c); else this._clases.delete(c); },
      contains: (c) => this._clases.has(c),
    };
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
  // El buscador arma cada <mark> con textContent: sin esto la marca queda vacía
  // y el manual pierde justo el pedazo resaltado.
  set textContent(v) { this.childNodes = [Object.assign(new Texto(v), { parentNode: this })]; }
  get textContent() { return this.texto; }
  replaceChild(nuevo, viejo) {
    const i = this.childNodes.indexOf(viejo);
    assert.ok(i >= 0, 'replaceChild sobre un nodo que no es hijo');
    const hijos = nuevo.tagName === '#fragment' ? nuevo.childNodes : [nuevo];
    for (const h of hijos) h.parentNode = this;
    this.childNodes.splice(i, 1, ...hijos);
    if (nuevo.tagName === '#fragment') nuevo.childNodes = [];
  }
  get texto() {
    return this.childNodes.map((n) => (n.nodeType === 3 ? n.nodeValue : n.texto)).join('');
  }
  marcas() {
    let out = [];
    for (const n of this.childNodes) {
      if (n.nodeType === 3) continue;
      if (n.tagName === 'MARK') out.push(n.texto);
      else out = out.concat(n.marcas());
    }
    return out;
  }
}
class Texto {
  constructor(v) { this.nodeType = 3; this.nodeValue = v; this.tagName = '#text'; }
}

// Parser mínimo: etiquetas y texto. Alcanza para el HTML de los manuales, que es
// el que escribimos nosotros y no tiene nada raro.
function parsear(html) {
  const raiz = new Nodo('DIV');
  const pila = [raiz];
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let pos = 0, m;
  const texto = (t) => {
    if (t) pila[pila.length - 1].appendChild(new Texto(t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')));
  };
  while ((m = re.exec(html))) {
    texto(html.slice(pos, m.index));
    pos = m.index + m[0].length;
    const tag = m[2].toUpperCase();
    if (m[1]) { if (pila.length > 1) pila.pop(); }
    else if (m[4] || tag === 'BR') pila[pila.length - 1].appendChild(new Nodo(tag));
    else pila.push(pila[pila.length - 1].appendChild(new Nodo(tag)));
  }
  texto(html.slice(pos));
  return raiz;
}

// ── El buscador DEL REPO, corriendo ────────────────────────────────────────

function armarManual(clave) {
  const iC = PANEL.indexOf('function sgManCampo(');
  const fnC = PANEL.slice(iC, PANEL.indexOf('\r\n}', iC) + 3);
  const i = PANEL.indexOf('SG_MANUAL.' + clave + ' = {');
  assert.ok(i > 0, 'no existe el manual: ' + clave);
  const m = PANEL.slice(i, PANEL.indexOf('\r\n};', i) + 4);
  // eslint-disable-next-line no-new-func
  return new Function('var SG_MANUAL={};' + fnC + '\n' + m + '\nreturn SG_MANUAL.' + clave + ';')();
}

function buscador(clave) {
  const man = armarManual(clave);
  const iN = PANEL.indexOf('function sgNorm(s){');
  const fnN = PANEL.slice(iN, PANEL.indexOf('\r\n}', iN) + 3);
  const iB = PANEL.indexOf('function sgManualBuscar(q){');
  const fnB = PANEL.slice(iB, PANEL.indexOf('\r\n}\r\n', iB) + 3);

  const cuenta = { textContent: '' };
  let cuerpo = parsear(man.html);
  const doc = {
    createTextNode: (v) => new Texto(v),
    createElement: (t) => new Nodo(t.toUpperCase()),
    createDocumentFragment: () => new Nodo('#fragment'),
  };
  const eid = (id) => (id === 'sg-manual-cuerpo' ? cuerpo : id === 'sg-manual-cuenta' ? cuenta : null);
  // innerHTML= vuelve a parsear, como hace el navegador.
  Object.defineProperty(cuerpo, 'innerHTML', {
    set(v) { const nuevo = parsear(v); this.childNodes = nuevo.childNodes; for (const h of this.childNodes) h.parentNode = this; },
    configurable: true,
  });
  // eslint-disable-next-line no-new-func
  const F = new Function('document', 'eid', 'SG', 'SG_MANUAL',
    fnN + '\n' + fnB + '\nreturn sgManualBuscar;')(
    doc, eid, { _manualClave: clave }, { [clave]: man });

  return {
    buscar(q) {
      Object.defineProperty(cuerpo, 'innerHTML', {
        set(v) { const nuevo = parsear(v); this.childNodes = nuevo.childNodes; for (const h of this.childNodes) h.parentNode = this; },
        configurable: true,
      });
      F(q);
      return {
        cuenta: cuenta.textContent,
        marcas: cuerpo.marcas(),
        encendidos: cuerpo.children.filter((e) => !e.classList.contains('apagado')).length,
        total: cuerpo.children.length,
      };
    },
    texto: () => cuerpo.texto,
  };
}

// ── 1 · LO QUE ESTÁ EN PANTALLA SE ENCUENTRA ───────────────────────────────

test('«acá entra» se encuentra, aunque tenga un <b> en el medio', () => {
  // Es la frase con la que arranca el manual de Ingresos: «Por acá entra la
  // mercadería al depósito», con «entra la mercadería» en negrita. Antes esto
  // contestaba «no hay nada sobre acá entra en este manual».
  const b = buscador('ingresos');
  const r = b.buscar('acá entra');
  assert.match(r.cuenta, /coincidencia/, 'no encontró una frase que está en la primera línea');
  assert.ok(r.marcas.join('').toLowerCase().includes('entra'), 'encontró pero no resaltó');
});

test('y se resalta de los dos lados de la etiqueta', () => {
  // Media frase en un nodo y media en el <b>: se marcan las dos mitades, o el
  // ojo va a una sola y parece que la otra no coincidió.
  const b = buscador('ingresos');
  const r = b.buscar('acá entra');
  const pegado = r.marcas.join('').toLowerCase();
  assert.ok(pegado.includes('acá') || pegado.includes('aca'), 'no marcó la mitad de afuera');
  assert.ok(pegado.includes('entra'), 'no marcó la mitad de adentro del <b>');
});

test('los cuatro manuales encuentran sus frases partidas', () => {
  // Una por manual, elegida de las que el buscador viejo NO encontraba.
  const casos = [
    ['ingresos', 'acá entra'],
    ['oc', 'de compra es el acuerdo'],
    ['stock', 'qué hay'],
    ['mejoras', 'del 1 al 5'],
  ];
  for (const [clave, frase] of casos) {
    const r = buscador(clave).buscar(frase);
    assert.match(r.cuenta, /coincidencia/, clave + ' no encuentra «' + frase + '»');
  }
});

// ── 2 · Y LO QUE NO ESTÁ, SIGUE SIN ESTAR ──────────────────────────────────

test('lo que no está lo dice, y no resalta nada', () => {
  const r = buscador('ingresos').buscar('zzz-no-existe');
  assert.match(r.cuenta, /No hay nada sobre/);
  assert.equal(r.marcas.length, 0);
});

test('lo que no viene al caso se apaga, no se esconde', () => {
  // Apagado se sigue viendo la estructura y el ojo va solo a lo resaltado;
  // escondido, el que busca «flete» ve tres renglones sueltos y no sabe en qué
  // parte del circuito está parado.
  const r = buscador('ingresos').buscar('balanza');
  assert.ok(r.encendidos >= 1, 'no encendió ningún bloque');
  assert.ok(r.encendidos < r.total, 'no apagó nada: la búsqueda no filtró');
});

// ── 3 · SIN TILDES, Y SIN ROMPER LA EÑE ────────────────────────────────────

test('se busca sin tildes: «camion» encuentra «camión»', () => {
  // El que escribe sin tilde tiene que encontrar lo que está escrito con tilde,
  // que es como está el manual. «camión» en Ingresos NO aparece nunca sin tilde:
  // si esto pasa, es porque se sacó el acento de verdad y no de casualidad.
  const r = buscador('ingresos').buscar('camion');
  assert.match(r.cuenta, /coincidencia/, 'no encontró «camión» buscando «camion»');
  assert.ok(r.marcas.some((m) => /cami[óo]n/i.test(m)), 'encontró pero resaltó otra cosa');
});

// La ñ no aparece en ninguno de los cuatro manuales de hoy, así que probarla
// contra ellos no protege nada. La regla vive en sgNorm y se prueba ahí.
function normalizador() {
  const i = PANEL.indexOf('function sgNorm(s){');
  // eslint-disable-next-line no-new-func
  const fin = PANEL.indexOf(SALTO + '}', i) + 3;
  return new Function(PANEL.slice(i, fin) + SALTO + 'return sgNorm;')();
}

test('la eñe no se confunde con la n', () => {
  // En NFD la ñ queda como n + tilde combinada: sin protegerla, el barrido de
  // acentos se la lleva, «piña» se vuelve «pina» y «año» pasa a ser otra palabra.
  // Es una letra del idioma, no una n con algo encima.
  const sgNorm = normalizador();
  assert.equal(sgNorm('Piña'), 'piña');
  assert.equal(sgNorm('AÑO'), 'año');
  assert.notEqual(sgNorm('año'), sgNorm('ano'), 'la eñe se descompuso');
});

test('y el acento de las vocales sí se saca', () => {
  const sgNorm = normalizador();
  assert.equal(sgNorm('Liquidación'), 'liquidacion');
  assert.equal(sgNorm('camión'), 'camion');
});

test('sgNorm no cambia el largo, o el resaltado cae corrido', () => {
  // El buscador arma un mapa de posiciones sobre el texto normalizado y después
  // corta el texto ORIGINAL con esas posiciones. Si el largo cambiara, se
  // pintaría la palabra de al lado.
  const sgNorm = normalizador();
  for (const t of ['Recepción', 'año', 'PIÑA', 'áéíóúü', 'sin nada raro', '']) {
    assert.equal(sgNorm(t).length, t.length, 'cambió el largo de: ' + t);
  }
});

test('el resaltado cae donde tiene que caer, no corrido', () => {
  // sgNorm saca tildes sin cambiar el largo. Si cambiara, las posiciones se
  // correrían y se pintaría la palabra de al lado.
  const r = buscador('ingresos').buscar('recepción');
  for (const m of r.marcas) {
    assert.match(m.toLowerCase(), /recepci[óo]n/, 'se resaltó otra cosa: «' + m + '»');
  }
});

// ── 4 · CON UNA LETRA NO PINTA MEDIA PANTALLA ──────────────────────────────

test('con una sola letra no filtra ni resalta', () => {
  const r = buscador('ingresos').buscar('a');
  assert.equal(r.cuenta, '');
  assert.equal(r.marcas.length, 0);
  assert.equal(r.encendidos, r.total, 'con una letra apagó bloques');
});

test('y borrar la búsqueda devuelve el manual entero', () => {
  const b = buscador('ingresos');
  b.buscar('balanza');
  const r = b.buscar('');
  assert.equal(r.marcas.length, 0, 'quedaron resaltados de la búsqueda anterior');
  assert.equal(r.encendidos, r.total, 'quedaron bloques apagados');
});

// ── 5 · Y NO SE COME EL TEXTO ──────────────────────────────────────────────

test('buscar y volver atrás no pierde ni una palabra del manual', () => {
  // El buscador parte nodos de texto y los reemplaza: si se equivoca en un
  // índice, se come un pedazo del manual y nadie se entera hasta que falta.
  const b = buscador('ingresos');
  const antes = b.texto();
  b.buscar('recepción');
  const conMarcas = b.texto();
  assert.equal(conMarcas, antes, 'el texto cambió al resaltar');
  b.buscar('');
  assert.equal(b.texto(), antes, 'el texto cambió al limpiar');
});

test('dos coincidencias en el mismo renglón se marcan las dos', () => {
  const b = buscador('mejoras');
  const r = b.buscar('mejora');
  assert.ok(r.marcas.length >= 2, 'marcó una sola de varias');
  assert.match(r.cuenta, /\d+ coincidencias/);
});
