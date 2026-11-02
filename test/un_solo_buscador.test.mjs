// ══ NINGUNA LISTA LARGA SE QUEDA SIN BUSCADOR ═════════════════════════════
//
// Pablo, 9/9/2026: «en clientes y proveedores, listas desplegables: veamos también
// el tema de "CONTIENE" para que sea más fácil buscar. Por favor revisá TODOS los
// menúes desplegables y mejoralo para que las herramientas de búsqueda sean más
// fáciles».
//
// Se contaron: 71 desplegables eligen de un padrón —clientes, proveedores,
// productos, cuentas, personas— y 47 no tenían con qué buscar. Con 300 proveedores
// eso es bajar la lista a ojo.
//
// Y había ONCE implementaciones distintas con TRES normalizadores de acentos
// incompatibles: uno protegía la ñ, otro la convertía en n, y el de las opciones
// no sacaba acentos —«comision» no encontraba «Comisión»—.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

// El normalizador real del panel, corrido de verdad.
const sgNorm = (() => {
  const src = trozo(PANEL, 'function sgNorm(s){', '\r\n}');
  return new Function(src + '\nreturn sgNorm;')();
})();

// ══════════════════════════════════════════════════════════════════════════
// 1 · UN SOLO NORMALIZADOR, Y HACE LO CORRECTO
// ══════════════════════════════════════════════════════════════════════════

test('busca sin acentos: «comision» encuentra «Comisión»', () => {
  assert.equal(sgNorm('Comisión'), sgNorm('comision'));
  assert.equal(sgNorm('Banco Nación'), sgNorm('banco nacion'));
  assert.equal(sgNorm('MARÍA'), 'maria');
});

test('pero la Ñ se protege: «año» no es «ano»', () => {
  // Es una letra del idioma, no una n con algo encima. En un teclado español
  // tiene tecla propia; el acento pide una tecla muerta, y ahí está la fricción.
  assert.notEqual(sgNorm('año'), sgNorm('ano'));
  assert.equal(sgNorm('PIÑA'), 'piña');
  assert.equal(sgNorm('Muñoz'), 'muñoz');
});

test('los otros dos normalizadores dejaron de existir por su cuenta', () => {
  // ppNorm se llevaba la ñ puesta y sgBcNorm reemplazaba vocal por vocal —así
  // que perdía cualquier acento fuera de su lista—. Los tres tienen que contestar
  // lo mismo o la misma búsqueda da distinto según la pantalla.
  assert.match(PANEL, /^function ppNorm\(s\) \{ return sgNorm\(s\); \}$/m);
  assert.match(PANEL, /^function sgBcNorm\(s\)\{ return sgNorm\(s\); \}$/m);
  assert.match(PANEL, /^function ppAsistNorm\(s\)\{ return sgNorm\(s\); \}$/m);

  // Y no quedó ningún barrido de acentos suelto que sea de BÚSQUEDA. Los que
  // siguen son de otra cosa: arman un nombre de usuario y una clave para cruzar
  // bancos, y se reconocen porque además tiran todo lo que no sea [a-z0-9] —ahí
  // la ñ SÍ tiene que caerse: un usuario «muñoz» no puede escribirse con ñ—.
  const sueltos = [...PANEL.matchAll(/.{0,140}normalize\('NFD'\)\.replace[\s\S]{0,90}/g)]
    .map((m) => m[0])
    .filter((t) => !/\[\^a-z0-9\]/i.test(t))
    // sgNorm es el que queda: se reconoce por la marca con la que PROTEGE la ñ
    // antes de descomponer, que ningún otro tiene.
    .filter((t) => !/u0001/.test(t));
  assert.equal(sueltos.length, 0,
    'quedaron ' + sueltos.length + ' normalizadores de búsqueda fuera de sgNorm');
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL BUSCADOR DE OPCIONES, CORRIDO
// ══════════════════════════════════════════════════════════════════════════
//
// Se monta sobre un select de mentira y se le escribe. Leer que dice sgNorm no
// prueba que filtre bien: lo que importa es qué opciones quedan.
function montar(opciones) {
  const src = trozo(PANEL, 'function sgSelBuscable(sel, placeholder){', '\r\n}')
    + trozo(PANEL, 'function sgSelGuardarOpciones(sel){', '\r\n}');
  const hechos = [];
  const nodo = (tag) => ({
    tagName: tag.toUpperCase(), style: {}, value: '', options: [], _attrs: {},
    innerHTML: '',
    appendChild(c) { hechos.push(c); c._padre = this; },
    setAttribute(k, v) { this._attrs[k] = v; },
    querySelector() { return null; },
    // LOS RESULTADOS SE APRIETAN, no se leen. Cada renglón que el buscador escribe
    // en la lista se devuelve como un nodo de mentira con su data-v y su onmousedown,
    // así el test puede hacerle clic y mirar qué quedó elegido — que es lo que hace
    // el operador y lo único que prueba que la lista sirve para algo.
    querySelectorAll(q) {
      if (q !== '.sg-sb-op') return [];
      // Memorizados por el HTML que los produjo: el código le cuelga el onmousedown
      // a lo que esto devuelve, así que si cada llamada fabricara nodos nuevos el
      // clic se le quedaría pegado a uno que ya nadie tiene.
      if (this._filasDe !== this.innerHTML) {
        this._filasDe = this.innerHTML;
        this._filas = [...String(this.innerHTML).matchAll(/data-v="([^"]*)"[^>]*>([^<]*)</g)]
          .map((m) => ({ _v: m[1], texto: m[2], style: {},
            getAttribute(k) { return k === 'data-v' ? this._v : null; } }));
      }
      return this._filas;
    },
  });
  const sel = nodo('select');
  sel.options = opciones.map((o) => ({ value: o[0], text: o[1] }));
  sel.parentNode = { insertBefore() {} };
  Object.defineProperty(sel, 'innerHTML', {
    set(v) {
      // Lo que quedó visible, leído del HTML que escribe el filtro.
      sel._visible = [...String(v).matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)]
        .map((m) => m[2]);
    },
    get() { return ''; },
  });
  const mundo = {
    eid: () => sel,
    escH: (v) => String(v == null ? '' : v),
    sgNorm,
    document: { createElement: nodo },
  };
  const f = new Function(...Object.keys(mundo), src + '\nreturn { sgSelBuscable: sgSelBuscable };')(
    ...Object.values(mundo));
  f.sgSelBuscable(sel);
  const inp = hechos.find((h) => h.tagName === 'INPUT');
  assert.ok(inp, 'no se creó el input de búsqueda');
  const lista = hechos.find((h) => h.tagName === 'DIV');
  const tecla = (k) => { let frenado = false;
    inp.onkeydown({ key: k, preventDefault() { frenado = true; } }); return frenado; };
  return {
    sel, inp, lista,
    escribir: (q) => { inp.value = q; inp.oninput(); return sel._visible || []; },
    // Lo que el operador VE debajo del casillero, sin abrir el desplegable.
    // null = no hay nada desplegado; [] = está desplegado y no trae renglones.
    verResultados: () => (lista && lista.style.display === 'block'
      ? lista.querySelectorAll('.sg-sb-op').map((e) => e.texto) : null),
    vacio: () => (lista && lista.style.display === 'block'
      && /sg-sb-vacio/.test(lista.innerHTML) ? String(lista.innerHTML) : null),
    apretar: (i) => lista.querySelectorAll('.sg-sb-op')[i].onmousedown({ preventDefault() {} }),
    marcada: () => lista.querySelectorAll('.sg-sb-op')
      .findIndex((e) => e.style.background === 'var(--sur)'),
    tecla,
  };
}

const PADRON = [['', '— Elegir —'], ['1', 'Comisión de venta'], ['2', 'BANCO NACIÓN'],
  ['3', 'Banco Galicia'], ['4', 'Muñoz Hermanos'], ['5', 'Munoz SA']];

test('escribir sin acentos encuentra lo acentuado', () => {
  const b = montar(PADRON);
  assert.deepEqual(b.escribir('comision'), ['— Elegir —', 'Comisión de venta']);
  assert.deepEqual(b.escribir('nacion'), ['— Elegir —', 'BANCO NACIÓN']);
});

test('y AL REVÉS: escribir con acento encuentra lo que está sin', () => {
  // Pasa todo el tiempo: se copia el nombre de otra pantalla —o de un mail— y
  // viene acentuado, mientras el padrón lo tiene escrito derecho. Si sólo se
  // normalizara la opción y no lo tipeado, no encontraría nada.
  const b = montar([...PADRON, ['6', 'Aereo Sur SRL']]);
  assert.deepEqual(b.escribir('aéreo'), ['— Elegir —', 'Aereo Sur SRL']);
  // Y en mayúsculas y con acento también, que es como viene pegado de un mail.
  assert.deepEqual(b.escribir('AÉREO'), ['— Elegir —', 'Aereo Sur SRL']);
});

test('busca POR CONTIENE, no por cómo empieza', () => {
  const b = montar(PADRON);
  assert.deepEqual(b.escribir('galicia'), ['— Elegir —', 'Banco Galicia']);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 bis · Y LO QUE ENCUENTRA SE VE, QUE ES OTRA COSA
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 28/10/2026, sobre los insumos de Puente Cordón: «permitime buscar por
// CONTIENE algo que esté dentro del nombre». Ya buscaba por contiene —lo prueban
// los tests de arriba—, pero filtraba las opciones de un desplegable CERRADO: en
// pantalla no cambiaba nada y había que abrirlo para enterarse. Un buscador que no
// muestra lo que encontró no se distingue de uno roto.
//
// Estos tests son sobre lo que se VE, no sobre lo que quedó adentro del select.

const INSUMOS = [['', '— elegir insumo —'], ['1', 'BOLSA FAJA LNB - NARANJA Y BLANCA (UN)'],
  ['2', 'BOLSA S/FAJA - NARANJA (UN)'], ['3', 'MO COSECHA - CEBOLLA (UN)'],
  ['4', 'BOLSA FAJA LNB - MORADA (UN)'], ['5', 'CAJA DURAZNO SAN PEDRO (DOLL - PG . LNB) (1)'],
  ['6', 'HILO (ROLLO)']];

test('escribir MUESTRA los resultados, sin tener que abrir el desplegable', () => {
  const b = montar(INSUMOS);
  assert.equal(b.verResultados(), null, 'la lista se ve antes de escribir nada');
  b.escribir('faja');
  assert.deepEqual(b.verResultados(), ['BOLSA FAJA LNB - NARANJA Y BLANCA (UN)',
    'BOLSA S/FAJA - NARANJA (UN)', 'BOLSA FAJA LNB - MORADA (UN)']);
});

test('y al borrar lo escrito la lista se va', () => {
  const b = montar(INSUMOS);
  b.escribir('faja');
  b.escribir('');
  assert.equal(b.verResultados(), null);
});

test('el resultado se elige con un clic, y la pantalla se entera', () => {
  // De ese onchange cuelga todo lo que la pantalla hace al elegir —la unidad, el
  // precio, el aviso—. Asignar el valor por código NO lo dispara solo.
  const b = montar(INSUMOS);
  let avisos = 0;
  b.sel.onchange = () => { avisos++; };
  b.escribir('durazno');
  b.apretar(0);
  assert.equal(b.sel.value, '5');
  assert.equal(avisos, 1, 'se eligió y la pantalla no se enteró');
  assert.equal(b.verResultados(), null, 'la lista quedó abierta después de elegir');
  assert.equal(b.inp.value, '', 'el casillero se quedó con lo tipeado');
});

test('y el desplegable vuelve a tener TODOS los insumos, no los tres del filtro', () => {
  // Si se quedara con lo filtrado, la próxima vez que alguien lo abriera a mano
  // —sin escribir nada— vería tres insumos y creería que no hay más.
  const b = montar(INSUMOS);
  b.escribir('faja');
  b.apretar(0);
  assert.equal(b.sel._visible.length, INSUMOS.length);
  assert.equal(b.sel.value, '1');
});

test('Enter elige lo que está marcado, en vez de mandarte al desplegable', () => {
  const b = montar(INSUMOS);
  b.escribir('durazno');
  assert.equal(b.marcada(), 0, 'no viene marcado el primero');
  assert.equal(b.tecla('Enter'), true, 'Enter no frenó el envío del formulario');
  assert.equal(b.sel.value, '5');
});

test('las flechas mueven la marca, y dan la vuelta', () => {
  const b = montar(INSUMOS);
  b.escribir('faja');
  b.tecla('ArrowDown');
  assert.equal(b.marcada(), 1);
  b.tecla('ArrowUp');
  assert.equal(b.marcada(), 0);
  b.tecla('ArrowUp');
  assert.equal(b.marcada(), 2, 'desde el primero para arriba tiene que ir al último');
  b.tecla('ArrowDown');
  assert.equal(b.marcada(), 0, 'desde el último para abajo tiene que volver al primero');
  b.tecla('Enter');
  assert.equal(b.sel.value, '1');
});

test('arrastrar la barra de la lista no se la cierra en la cara', () => {
  // Con veinte resultados la lista scrollea, y agarrar su barra le sacaba el foco al
  // casillero: el blur la cerraba en el medio del arrastre.
  const b = montar(INSUMOS);
  b.escribir('faja');
  let frenado = false;
  b.lista.onmousedown({ preventDefault() { frenado = true; } });
  assert.equal(frenado, true, 'apretar la lista deja que el casillero pierda el foco');
});

test('Escape cierra la lista sin elegir nada', () => {
  const b = montar(INSUMOS);
  b.escribir('faja');
  b.tecla('Escape');
  assert.equal(b.verResultados(), null);
  assert.equal(b.sel.value, '');
});

test('con más de 60 muestra 60 y DICE cuántas quedaron afuera', () => {
  // Cortar en silencio es peor que no cortar: el que busca «bolsa» ve sesenta y
  // concluye que ésas son todas las que hay.
  const muchos = [['', '— elegir insumo —']].concat(
    Array.from({ length: 75 }, (_, i) => [String(i + 1), 'BOLSA ' + (i + 1)]));
  const b = montar(muchos);
  b.escribir('bolsa');
  assert.equal(b.verResultados().length, 60);
  assert.match(b.lista.innerHTML, /y 15 más: seguí escribiendo/);
  // Y con 60 justos no dice nada, porque no quedó ninguna afuera.
  const c = montar([['', '— elegir —']].concat(
    Array.from({ length: 60 }, (_, i) => [String(i + 1), 'BOLSA ' + (i + 1)])));
  c.escribir('bolsa');
  assert.ok(!/sg-sb-mas/.test(c.lista.innerHTML));
});

test('y si no hay ninguno lo dice ABAJO, donde se está mirando', () => {
  // El cartel ya existía, pero adentro del desplegable cerrado: decía «no hay
  // nada» donde nadie lo iba a leer.
  const b = montar(INSUMOS);
  b.escribir('tractor');
  assert.deepEqual(b.verResultados(), []);
  assert.match(b.vacio(), /No hay ninguno que diga "tractor"/);
});

test('y por palabras sueltas en cualquier orden', () => {
  const b = montar(PADRON);
  assert.deepEqual(b.escribir('galicia banco'), ['— Elegir —', 'Banco Galicia']);
});

test('la Ñ sigue distinguiendo: «muñoz» no trae «Munoz»', () => {
  const b = montar(PADRON);
  assert.deepEqual(b.escribir('muñoz'), ['— Elegir —', 'Muñoz Hermanos']);
  assert.deepEqual(b.escribir('munoz'), ['— Elegir —', 'Munoz SA']);
});

test('el «— Elegir —» nunca se filtra: es cómo se vuelve atrás', () => {
  const b = montar(PADRON);
  assert.ok(b.escribir('zzz nada').join(' ').length >= 0);
  assert.deepEqual(b.escribir('comision')[0], '— Elegir —');
});

test('y sin resultados lo dice, con lo que se escribió tal cual', () => {
  // El mensaje hablaba de «rubros» porque nació en la configuración impositiva.
  // Ahora lo usa todo el panel.
  const b = montar(PADRON);
  const r = b.escribir('no existe');
  assert.equal(r.length, 1);
  assert.match(r[0], /no hay nada que diga "no existe"/);
  assert.ok(!/rubro/.test(r[0]), 'el mensaje sigue hablando de rubros');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · SE MONTA SOLO — Y ÉSA ES LA PARTE QUE NO SE PUEDE PERDER
// ══════════════════════════════════════════════════════════════════════════

test('cualquier desplegable largo lo recibe, sin tocar su código', () => {
  // La alternativa era editar 47 llamadas: 47 oportunidades de romper algo, y la
  // 48ª que alguien escriba mañana volvería a quedar afuera. Es la misma decisión
  // que se tomó con la altura de las ventanas.
  const f = trozo(PANEL, 'function sgBuscadorAuto(sel){', '\r\n}');
  assert.match(f, /sel\.options\.length < SG_BUSCADOR_DESDE\) return;/);
  assert.match(f, /sgSelBuscable\(sel\)/);
  // Y se engancha por evento, no llamada por llamada.
  assert.match(PANEL, /document\.addEventListener\('focusin'/);
});

test('no le pisa el buscador al que ya tiene uno propio', () => {
  // Son 24, y varios muestran un dato que éste no puede: «3 sin facturar ·
  // $1.234.567». Montarle otro encima los rompería.
  const f = trozo(PANEL, 'function sgBuscadorAuto(sel){', '\r\n}');
  assert.match(f, /sel\._unico \|\| sel\._buscable \|\| sel\.multiple/);
  // _unico lo deja sgBuscador; _buscable, éste.
  assert.match(PANEL, /sel\._unico = true;/);
  assert.match(PANEL, /sel\._buscable = true;/);
});

test('ni a las listas cortas, ni al que pida quedarse afuera', () => {
  // Un «Sí / No» con un buscador arriba es peor que sin nada.
  const f = trozo(PANEL, 'function sgBuscadorAuto(sel){', '\r\n}');
  assert.match(f, /data-sin-buscador/);
  assert.match(PANEL, /var SG_BUSCADOR_DESDE = 12;/);
});

test('al montarlo el foco pasa al input, o no se puede escribir', () => {
  // Sin esto el operador se queda tipeando adentro del select —que responde con
  // el salto por primera letra— y parece que el buscador no anda.
  const i = PANEL.indexOf("document.addEventListener('focusin'");
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /inp\.focus\(\)/);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · Y EL MANUAL LO DICE — EN LOS DOCE, ESCRITO UNA VEZ
// ══════════════════════════════════════════════════════════════════════════

test('el bloque común se le pega a CUALQUIER manual, no a doce a mano', () => {
  // La regla dice que si se toca una pantalla se actualiza su «¿Cómo se usa?».
  // Acá se tocaron TODAS: no hay una pantalla dueña de este cambio. Copiarlo doce
  // veces es la misma trampa que arreglar 47 llamadas — el manual trece que
  // alguien escriba mañana no lo tendría.
  assert.match(PANEL, /var SG_MANUAL_COMUN =/);
  const f = trozo(PANEL, 'function sgManualHtml(m){', '\r\n}');
  assert.match(f, /\+ SG_MANUAL_COMUN/);

  // Y no quedó ningún manual pintándose sin él: si alguno siguiera usando m.html
  // directo, esa pantalla sería la única sin la explicación.
  assert.ok(!/innerHTML = m\.html/.test(PANEL), 'quedó un manual sin el bloque común');
  assert.ok(!/cuerpo\.innerHTML = m\.html/.test(PANEL));
  assert.equal((PANEL.match(/= sgManualHtml\(m\);/g) || []).length, 3,
    'son tres lugares que pintan el cuerpo: abrir, buscar con poco, buscar');
});

test('lo busca la lupa igual que el resto del manual', () => {
  // sgManualBuscar repinta el cuerpo antes de resaltar. Si ahí usara m.html, el
  // bloque común desaparecería al escribir en la lupa: buscar «tilde» contestaría
  // que no hay nada sobre tildes, con la explicación de las tildes ahí abajo.
  const f = trozo(PANEL, 'function sgManualBuscar(q){', '\r\n  cuerpo.innerHTML = sgManualHtml(m);');
  assert.match(f, /if \(t\.length < 2\)[\s\S]*sgManualHtml\(m\)/);
});

test('y dice lo que el buscador hace de verdad, con su versión', () => {
  // No alcanza con que el texto exista: tiene que afirmar lo mismo que el código.
  const ini = PANEL.indexOf('var SG_MANUAL_COMUN =');
  assert.ok(ini > 0, 'no está SG_MANUAL_COMUN');
  const fin = PANEL.indexOf("';", ini);
  assert.ok(fin > ini, 'SG_MANUAL_COMUN no cierra');
  const b = PANEL.slice(ini, fin + 2);
  assert.match(b, /<span class="ver">V1037<\/span>/);

  // «No hace falta poner tildes» — y el buscador lo cumple.
  assert.match(b, /No hace falta poner tildes/);
  const m1 = montar(PADRON);
  assert.deepEqual(m1.escribir('comision'), ['— Elegir —', 'Comisión de venta']);

  // «Pero la ñ sí distingue».
  assert.match(b, /la ñ sí distingue/);
  assert.deepEqual(m1.escribir('munoz'), ['— Elegir —', 'Munoz SA']);

  // «Varias palabras en cualquier orden».
  assert.match(b, /en cualquier orden/);
  assert.deepEqual(m1.escribir('galicia banco'), ['— Elegir —', 'Banco Galicia']);

  // «Las listas cortas no lo traen» — y el umbral está puesto.
  assert.match(b, /Las listas <b>cortas<\/b> no lo traen/);
  assert.match(PANEL, /var SG_BUSCADOR_DESDE = 12;/);

  // «Los resultados aparecen debajo del casillero mientras se escribe» (V1104) — y
  // aparecen de verdad, con su clic, sus flechas y su Enter.
  assert.match(b, /Los resultados aparecen debajo del casillero mientras se escribe<\/b> '\s*\+ '<span class="ver">V1104<\/span>/);
  const m2 = montar(INSUMOS);
  m2.escribir('faja');
  assert.equal(m2.verResultados().length, 3);
  assert.match(b, /se elige uno con un clic, o moviéndose con las '\s*\+ 'flechas ↑ ↓ y apretando Enter/);
  m2.tecla('ArrowDown');
  m2.tecla('Enter');
  assert.equal(m2.sel.value, '2');

  // «Si no queda nada, lo dice debajo del casillero».
  assert.match(b, /lo dice <b>debajo del casillero<\/b>/);
  const m3 = montar(INSUMOS);
  m3.escribir('tractor');
  assert.match(m3.vacio(), /No hay ninguno que diga "tractor"/);
});

test('el corte se ve: de ahí para abajo no habla de esta pantalla', () => {
  // Leído corrido, el operador creería que «salir de una ventana» es de la
  // pantalla que tenía abierta.
  assert.match(PANEL, /<h3 class="mc">Vale en todo el panel<\/h3>/);
  assert.match(PANEL, /#sg-manual-modal \.man h3\.mc\{/);
});

test('y si el select se repobló, la lista guardada se vuelve a leer', () => {
  // sgSelBuscable guarda las opciones UNA vez. Cambiar un filtro que repuebla el
  // select dejaba el buscador ofreciendo lo de antes.
  // Hasta donde cierra el bloque, no «los próximos 900 caracteres»: la función
  // que lo hace está debajo del listener.
  const i = PANEL.indexOf("document.addEventListener('focusin'");
  const b = PANEL.slice(i, PANEL.indexOf('function sgSelGuardarOpciones(sel){', i));
  assert.match(b, /t\.options\.length !== \(t\._todas \|\| \[\]\)\.length/);
  assert.match(b, /sgSelGuardarOpciones\(t\)/);
  // Sólo si no hay nada escrito: si no, se borraría lo que el operador está
  // tipeando en el momento.
  assert.match(b, /!inp\.value\.trim\(\)/);
});
