// ══ EL CUADRO DE VALORIZAR ═════════════════════════════════════════════════
//
// Pablo, 3/9/2026: «mejoremos un poco la pantalla de valorización. No barras
// laterales… y por ahora saquemos las 2 opciones que me das. Simplemente aclará
// que la valorización se hace en valores SIN IVA. Y permitinos poner el valor en
// la partida».
//
// LAS DOS OPCIONES SÓLO APARECEN CUANDO SIRVEN. Con UNA operación —que es siempre
// el caso de una descarga— «monto por operación» y «total a repartir» dan
// exactamente el mismo número: es una pregunta cuya respuesta no cambia nada, y
// encima esconde el campo donde hay que escribir. Con varias sí importa: la
// cuenta de un fletero con veinte remitos se reparte de un total, y obligar a
// tipear veinte importes a mano sería peor que la pregunta.
//
// Y LA BARRA DE ABAJO ERA EL CAMPO DEL IMPORTE: tenía 110 píxeles fijos y
// empujaba la tabla fuera del modal, así que justo la columna donde había que
// escribir quedaba afuera de la pantalla.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const SALTO = String.fromCharCode(13, 10);

// ── Se corren las funciones DEL REPO ───────────────────────────────────────

function cuadro(items) {
  const nombres = ['sgGdsValRender', 'sgGdsValModoActual', 'sgGdsValModo', 'sgGdsValResumen',
    'sgGdsValUnit', 'sgGdsValPorUnidad', 'sgGdsValMonto'];
  let src = '';
  for (const n of nombres) {
    const i = PANEL.indexOf('function ' + n + '(');
    assert.ok(i > 0, 'no existe ' + n);
    src += PANEL.slice(i, PANEL.indexOf(SALTO + '}', i) + 3) + SALTO;
  }
  const campos = {
    'sg-val-items': { innerHTML: '' },
    'sg-val-modobox': { style: { display: 'none' } },
    'sg-val-totalbox': { style: { display: 'none' } },
    'sg-val-total': { value: '' },
    'sg-val-resumen': { innerHTML: '', textContent: '' },
  };
  const SGGD = { valItems: items };
  let radio = 'remito';
  const entorno = {
    SGGD,
    eid: (id) => campos[id],
    esc: (x) => String(x == null ? '' : x).replace(/"/g, '&quot;'),
    escH: (x) => String(x == null ? '' : x).replace(/</g, '&lt;'),
    nr: (x) => String(x),
    sgMoney: (x) => '$' + x,
    sgMoney2: (x) => '$' + x,
    document: {
      querySelector: (sel) => (sel.indexOf(':checked') >= 0 ? { value: radio } : null),
    },
  };
  const ns = Object.keys(entorno);
  // eslint-disable-next-line no-new-func
  const F = new Function(...ns, src
    + 'return { sgGdsValRender, sgGdsValModo, sgGdsValModoActual, sgGdsValUnit,'
    + ' sgGdsValPorUnidad, sgGdsValMonto };')(...ns.map((n) => entorno[n]));
  return { ...F, campos, items: SGGD.valItems, elegir: (v) => { radio = v; } };
}

const UNA = [{ id: 9, ref: '0549.03.09.2026.01', sub: 'PUENTE CORDON SA', fecha: '2026-09-03', base: 5, unidadLbl: 'pallet', monto: '' }];
const VARIAS = [
  { id: 1, ref: 'R-1', sub: 'Cliente A', fecha: '2026-09-01', base: 100, unidadLbl: 'kg', monto: '' },
  { id: 2, ref: 'R-2', sub: 'Cliente B', fecha: '2026-09-02', base: 300, unidadLbl: 'kg', monto: '' },
];

// ── 1 · CON UNA SOLA, NO SE PREGUNTA NADA ──────────────────────────────────

test('con una sola operación el selector no se muestra', () => {
  const c = cuadro(UNA);
  c.sgGdsValModo();
  assert.equal(c.campos['sg-val-modobox'].style.display, 'none',
    'pregunta entre dos caminos que dan el mismo número');
  assert.equal(c.campos['sg-val-totalbox'].style.display, 'none');
});

test('y el importe se escribe en la fila de la partida', () => {
  const c = cuadro(UNA);
  c.sgGdsValModo();
  const h = c.campos['sg-val-items'].innerHTML;
  assert.match(h, /0549\.03\.09\.2026\.01/, 'no se ve la partida');
  assert.match(h, /<input type="number"[^>]*oninput="sgGdsValMonto\(0,this\.value\)"/);
  assert.ok(!/readonly/.test(h), 'el campo del importe quedó bloqueado');
});

test('aunque alguien deje marcado «total», con una sola se escribe igual', () => {
  // El radio queda del uso anterior. Si mandara, el campo saldría de sólo
  // lectura y el operador no podría escribir el importe de su descarga.
  const c = cuadro(UNA);
  c.elegir('total');
  c.sgGdsValModo();
  assert.equal(c.sgGdsValModoActual(), 'remito');
  assert.ok(!/readonly/.test(c.campos['sg-val-items'].innerHTML),
    'el campo quedó bloqueado por un radio que ni se muestra');
});

// ── 2 · CON VARIAS SÍ, PORQUE AHÍ SIRVE ────────────────────────────────────

test('con varias operaciones vuelve a preguntarse', () => {
  // La cuenta de un fletero con veinte remitos se reparte de un total: obligar a
  // tipear veinte importes a mano sería peor que la pregunta.
  const c = cuadro(VARIAS);
  c.sgGdsValModo();
  assert.equal(c.campos['sg-val-modobox'].style.display, 'flex');
});

test('y eligiendo «total» los campos se bloquean, que es el punto', () => {
  const c = cuadro(VARIAS);
  c.elegir('total');
  c.sgGdsValRender();
  assert.match(c.campos['sg-val-items'].innerHTML, /readonly/);
  assert.equal(c.sgGdsValModoActual(), 'total');
});

// ── 3 · NADA SE SALE DE ANCHO ──────────────────────────────────────────────

test('el campo del importe usa su columna, no 110 píxeles fijos', () => {
  // Ese ancho fijo era la barra de abajo: empujaba la tabla y la columna donde
  // hay que escribir quedaba fuera del modal.
  const i = PANEL.indexOf('function sgGdsValRender(){');
  const b = PANEL.slice(i, PANEL.indexOf(SALTO + '}', i));
  assert.match(b, /var inSty='width:100%;box-sizing:border-box;/);
  assert.ok(!b.includes('width:110px'), 'volvió el ancho fijo');
});

test('la tabla del modal tiene anchos por columna y no pide barra lateral', () => {
  const i = PANEL.indexOf('id="sg-val-modal"');
  const b = PANEL.slice(i, i + 3000);
  assert.match(b, /overflow-x:hidden !important/);
  assert.match(b, /table-layout:fixed/);
  const anchos = [...b.matchAll(/<th style="width:(\d+)%/g)].map((m) => Number(m[1]));
  assert.equal(anchos.length, 6, 'la tabla no tiene seis columnas con ancho fijo');
  assert.equal(anchos.reduce((a, x) => a + x, 0), 100, 'los anchos no suman 100%');
  assert.match(b, /width:min\(960px,96vw\);max-width:96vw/);
  assert.match(b, /overflow-y:auto;overflow-x:hidden/);
});

test('la primera columna dice PARTIDA, que es lo que el operador busca', () => {
  const i = PANEL.indexOf('id="sg-val-modal"');
  const b = PANEL.slice(i, i + 3000);
  assert.match(b, /<th style="width:\d+%">Partida<\/th>/);
});

test('TODO lo que se cuelga del cuerpo ocupa el ancho entero', () => {
  // El cuerpo del modal es .fg, una grilla de DOS columnas: lo que no lleva .ff
  // ocupa media fila. El aviso se colgó ahí sin la clase y le comió la mitad del
  // ancho a la tabla — la partida salía «0549.03.09…» y la fecha «20…».
  const i = PANEL.indexOf('id="sg-val-modal"');
  const cuerpo = PANEL.slice(PANEL.indexOf('<div class="fg">', i), PANEL.indexOf('<div class="ab-modal-footer">', i));
  // Los hijos directos del cuerpo: van indentados con seis espacios.
  const bloques = cuerpo.split(SALTO)
    .filter((l) => /^ {6}<div /.test(l))
    .map((l) => l.trim());
  assert.ok(bloques.length >= 4, 'no se encontraron los bloques del cuerpo');
  for (const b of bloques) {
    assert.ok(/class="[^"]*ff/.test(b), 'este bloque ocupa media fila: ' + b.slice(0, 70));
  }
  // Y la regla es la que ya existía en el panel, no una copia.
  assert.match(PANEL, /\.ff\{grid-column:1\/-1\}/);
});

test('el aviso del IVA va ABAJO de la tabla, no al lado', () => {
  const i = PANEL.indexOf('id="sg-val-modal"');
  const b = PANEL.slice(i, i + 3000);
  assert.ok(b.indexOf('<tbody id="sg-val-items">') < b.indexOf('Los importes se cargan'),
    'el aviso volvió arriba, donde le come el ancho a la tabla');
});

test('y no se corta ningún dato: lo largo baja de renglón', () => {
  // Media partida no sirve para nada. Bajar de renglón muestra todo y no produce
  // barra lateral, que es lo que se estaba evitando con el recorte.
  const i = PANEL.indexOf('function sgGdsValRender(){');
  const b = PANEL.slice(i, PANEL.indexOf(SALTO + '}', i));
  assert.match(b, /var cel='white-space:normal;word-break:break-word';/);
  assert.ok(!b.includes('text-overflow:ellipsis'), 'volvió el recorte');
  // La fecha sí queda en un renglón: es corta y partida se lee peor.
  assert.ok(b.includes("+';white-space:nowrap\">'+escH(it.fecha"),
    'la fecha se puede partir en dos renglones');
});

// ── 4 · SIN IVA, DICHO DONDE SE ESCRIBE ────────────────────────────────────

test('el cuadro avisa que los importes van SIN IVA', () => {
  // Es el número que entra al costo de la partida, y el costo no lleva IVA: el
  // crédito fiscal se recupera aparte. Cargado con IVA, la partida sale un 21%
  // más cara y el margen miente.
  const i = PANEL.indexOf('id="sg-val-modal"');
  const b = PANEL.slice(i, i + 3000);
  assert.match(b, /Los importes se cargan <b>SIN IVA<\/b>/);
  // Y el campo del total también lo dice, porque ahí se carga la cuenta entera.
  assert.match(b, /Total de la cuenta \(\$, sin IVA\)/);
});

// ── 5 · Y EL MANUAL LO CUENTA, QUE ES LA REGLA ─────────────────────────────

test('el manual dice que el importe va sin IVA y por qué', () => {
  const i = PANEL.indexOf('SG_MANUAL.gastos = {');
  assert.ok(i > 0);
  const m = PANEL.slice(i, PANEL.indexOf(SALTO + '};', i));
  const plano = m.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
  assert.ok(plano.includes('SIN IVA'), 'el manual no dice que va sin IVA');
  assert.ok(plano.includes('el crédito fiscal se recupera aparte'),
    'no explica por qué: sin el porqué, el que carga con IVA no entiende qué hizo mal');
  assert.ok(plano.includes('al lado de la partida'), 'no dice dónde se escribe');
  assert.match(m, /<span class="ver">V1004<\/span>/);
});

// ── 6 · EL PRECIO POR UNIDAD ───────────────────────────────────────────────
//
// Pablo, 3/9/2026: «sería bueno agregar el precio unitario».
//
// La cuadrilla no cotiza un total: cotiza «dos mil el pallet». Pedir sólo el
// total obliga a multiplicar a mano y a redondear, y ese redondeo se va derecho
// al costo de la partida.

test('escribiendo el precio por unidad sale el total', () => {
  const c = cuadro([{ ...UNA[0] }]);
  c.sgGdsValPorUnidad(0, '2060');
  assert.equal(c.items[0].monto, 10300, '5 pallets a 2.060 son 10.300');
});

test('y escribiendo el total sale el precio por unidad, EN PANTALLA', () => {
  // Se mira el renglón dibujado, no la cuenta: si sólo se refrescara el total,
  // el campo de al lado seguiría mostrando el precio de antes.
  const c = cuadro([{ ...UNA[0] }]);
  c.sgGdsValMonto(0, '10300');
  assert.equal(c.sgGdsValUnit(c.items[0]), 2060);
  assert.match(c.campos['sg-val-items'].innerHTML, /value="2060"/,
    'el precio por unidad se quedó con el número viejo');
});

test('los dos campos se ven en la fila', () => {
  const c = cuadro([{ ...UNA[0], monto: 10300 }]);
  c.sgGdsValRender();
  const h = c.campos['sg-val-items'].innerHTML;
  assert.match(h, /oninput="sgGdsValPorUnidad\(0,this\.value\)"/);
  assert.match(h, /oninput="sgGdsValMonto\(0,this\.value\)"/);
  // Y el de la unidad arranca con el número, no vacío.
  assert.match(h, /value="2060"/);
});

test('sin cantidad no inventa un precio por unidad', () => {
  // Dividir por cero da Infinity, y eso impreso al lado de un importe es peor
  // que no mostrar nada.
  const c = cuadro([{ ...UNA[0], base: 0, monto: 500 }]);
  assert.equal(c.sgGdsValUnit(c.items[0]), '');
});

test('borrar el precio por unidad borra el total, no lo pone en cero', () => {
  // Cero es un importe válido —un servicio bonificado— y guardarlo sin querer
  // hace que la partida quede como si la descarga no hubiera costado nada.
  const c = cuadro([{ ...UNA[0], monto: 10300 }]);
  c.sgGdsValPorUnidad(0, '');
  assert.equal(c.items[0].monto, '');
});

test('el precio por unidad se redondea a dos decimales', () => {
  const c = cuadro([{ ...UNA[0], base: 3, monto: 100 }]);
  assert.equal(c.sgGdsValUnit(c.items[0]), 33.33);
});

// ── 7 · EDITAR UNA VALORIZACIÓN ────────────────────────────────────────────

test('el cuadro abre con el importe que ya tenía', () => {
  // Abrir en blanco obligaba a acordarse de cuánto se había puesto — y a volver
  // a tipearlo entero.
  const i = PANEL.indexOf('function sgGdsValAbrir(opts){');
  const b = PANEL.slice(i, PANEL.indexOf(SALTO + '}', i));
  assert.match(b, /monto:\(x\.monto!=null&&x\.monto!==''\)\?Number\(x\.monto\):''/);
  assert.ok(!/unidadLbl:x\.unidadLbl\|\|'', monto:''/.test(b), 'vuelve a tirar el importe');
});

test('y el título dice que se está corrigiendo, no cargando', () => {
  // Con el importe ya puesto y el mismo rótulo, se duda de si se va a duplicar
  // el gasto.
  const i = PANEL.indexOf('function sgGdsValAbrir(opts){');
  const b = PANEL.slice(i, PANEL.indexOf(SALTO + '}', i));
  assert.match(b, /yaTiene\?'Editar valorización — ':'Valorizar cuenta — '/);
});

test('la fila valorizada ofrece Editar', () => {
  const i = PANEL.indexOf('function sgCcoopRender(){');
  const b = PANEL.slice(i, i + 6000);
  assert.match(b, /f\.estado === 'valorizado'/);
  assert.match(b, /onclick="sgCcoopValorizar\(' \+ f\.gasto_id \+ '\)">✏️ Editar/);
  // Y le pasa el importe de hoy, o el cuadro abriría vacío.
  const j = PANEL.indexOf('function sgCcoopValorizar(gastoId){');
  assert.match(PANEL.slice(j, PANEL.indexOf(SALTO + '}', j)), /monto: f\.monto,/);
});

test('y el servidor deja pisar un importe ya cargado', () => {
  // Antes el UPDATE llevaba AND estado='pendiente_valorizar': se cargaba una vez
  // y quedaba clavado. Un cero de más se arrastraba al costo sin arreglo posible.
  const i = SG.indexOf("router.post('/gastos-servicio/valorizar'");
  const b = SG.slice(i, SG.indexOf(SALTO + '});', i));
  assert.match(b, /WHERE id=\? AND proveedor_servicio_id=\? AND estado <> 'anulado' AND activo=1/);
  assert.ok(!/AND estado='pendiente_valorizar' AND activo=1/.test(b), 'volvió el candado');
  // Un gasto ANULADO no vuelve por la puerta de atrás.
  assert.match(b, /estado <> 'anulado'/);
  // Y se rehace el costo del lote, o corregir dejaría el costo viejo.
  assert.match(b, /for \(const l of lotes\) recalcCostoLote\(db, l\.id\);/);
});

test('la fila muestra el precio por unidad debajo del monto', () => {
  // En la misma celda y no en una columna nueva: son doce y una más pide barra
  // lateral.
  const i = PANEL.indexOf('function sgCcoopRender(){');
  const b = PANEL.slice(i, i + 6000);
  assert.match(b, /Number\(f\.monto\) \/ Number\(f\.cantidad\)/);
  assert.match(b, /escH\(f\.unidad \|\| 'unidad'\)/);
  // Y se VE: renglón chico y gris debajo del total, no escondido.
  assert.ok(b.includes('<div style="font-size:10.5px;color:var(--mut)">\'' + SALTO),
    'el precio por unidad quedó escondido');
  // Sin cantidad no se divide: Infinity al lado de un importe es peor que nada.
  assert.match(b, /Number\(f\.cantidad\) > 0/);
  const cab = b.slice(b.indexOf('<th>Fecha</th>'), b.indexOf('</tr></thead>', b.indexOf('<th>Fecha</th>')));
  assert.equal((cab.match(/<th/g) || []).length, 12, 'la tabla cambió de cantidad de columnas');
});

test('el manual cuenta el precio por unidad, el editar y su riesgo', () => {
  const i = PANEL.indexOf('SG_MANUAL.gastos = {');
  const m = PANEL.slice(i, PANEL.indexOf(SALTO + '};', i));
  const plano = m.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
  assert.ok(m.includes('✏️ Editar'), 'el manual no cuenta que se puede corregir');
  assert.ok(plano.includes('precio por unidad'), 'no cuenta el precio por unidad');
  // Y avisa lo que corregir NO hace: mover una liquidación ya emitida.
  assert.ok(plano.includes('ya liquidada'), 'no avisa el riesgo de corregir después de liquidar');
  assert.match(m, /<span class="ver">V1006<\/span>/);
});
