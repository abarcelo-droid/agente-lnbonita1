// ══ VALORIZAR LA DESCARGA DE LA COOPERATIVA ════════════════════════════════
//
// Pablo, 3/9/2026: «vamos a empezar a trabajar gastos directos. Primero
// Cooperativa. Sacá el logo de la frutilla, vamos con un autoelevador. Necesito
// un botón para poder valorizar ese movimiento».
//
// EL BOTÓN NO ERA UNA COMODIDAD: ERA LO ÚNICO QUE FALTABA. El cartel al pie de
// Control Cooperativa mandaba a «Gastos Directos → Cargas y Descargas», y esa
// solapa se fue cuando Control Cooperativa la reemplazó — su JS quedó huérfano
// apuntando a ids que ya no están en el documento.
//
// O sea: la descarga se cargaba en la recepción, quedaba «⏳ a valorizar» para
// siempre, y como la liquidación NO deja emitir con la descarga sin valorizar,
// la partida quedaba trabada. El aviso decía dónde destrabarla y ese lugar no
// existía. Tres carteles distintos mandaban ahí, uno de ellos por API.
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

// ── 1 · EL AUTOELEVADOR ────────────────────────────────────────────────────

test('la frutilla se fue de Gastos Directos', () => {
  const i = PANEL.indexOf('id="sec-sg-gastos-directos"');
  const b = PANEL.slice(i, i + 400);
  assert.match(b, /<div class="ph-t">🚜 San Gerónimo · Gastos Directos<\/div>/);
  assert.ok(!b.includes('🍅'), 'quedó el tomate');
});

// ── 2 · EL BOTÓN, CORRIDO DE VERDAD ────────────────────────────────────────

function valorizador(filas) {
  const i = PANEL.indexOf('function sgCcoopValorizar(gastoId){');
  assert.ok(i > 0, 'no existe sgCcoopValorizar');
  const src = PANEL.slice(i, PANEL.indexOf(SALTO + '}', i) + 3);
  const abiertos = [];
  const avisos = [];
  let recargas = 0;
  const entorno = {
    SGCC: { filas },
    toast: (m) => avisos.push(m),
    sgCcoopLoad: () => { recargas++; },
    sgGdsValAbrir: (o) => abiertos.push(o),
  };
  const nombres = Object.keys(entorno);
  // eslint-disable-next-line no-new-func
  const f = new Function(...nombres, src + SALTO + 'return sgCcoopValorizar;')(
    ...nombres.map((n) => entorno[n]));
  return { sgCcoopValorizar: f, abiertos, avisos, recargas: () => recargas };
}

const FILA = {
  gasto_id: 9, recepcion_id: 3, partida: '0549.03.09.2026.01',
  numero_recepcion: 'SG-REC-20260903-0001', proveedor_nombre: 'PUENTE CORDON SA',
  cooperativa_id: 4, cooperativa_nombre: 'COOP ISLAS MALVINAS SOBERANA',
  fecha: '2026-09-03', unidad: 'pallet', cantidad: 5, estado: 'pendiente_valorizar', monto: null,
};

test('abre el cuadro con la descarga que se está mirando', () => {
  const v = valorizador([FILA]);
  v.sgCcoopValorizar(9);
  assert.equal(v.abiertos.length, 1, 'no abrió el cuadro de valorización');
  const o = v.abiertos[0];
  assert.equal(o.items.length, 1, 'abrió con más de una operación');
  assert.equal(o.items[0].id, 9);
  assert.equal(o.nombre, 'COOP ISLAS MALVINAS SOBERANA');
});

test('y contra la COOPERATIVA, que es el proveedor del servicio', () => {
  // El endpoint agrupa por proveedor del servicio y sólo pisa los gastos que son
  // de ese proveedor. Mandando el proveedor de la mercadería —PUENTE CORDON, que
  // está en la misma fila— el servidor no cambiaría nada y contestaría que sí.
  const v = valorizador([FILA]);
  v.sgCcoopValorizar(9);
  assert.equal(v.abiertos[0].prov, 4);
});

test('la base es lo que se le cobra: pallets, no bultos', () => {
  // Con base equivocada, repartir un total entre las operaciones da otro número.
  const v = valorizador([FILA]);
  v.sgCcoopValorizar(9);
  assert.equal(v.abiertos[0].items[0].base, 5);
  assert.equal(v.abiertos[0].items[0].unidadLbl, 'pallet');
});

test('al guardar recarga ESTA pantalla, no la de fletes', () => {
  const v = valorizador([FILA]);
  v.sgCcoopValorizar(9);
  assert.equal(typeof v.abiertos[0].reload, 'function');
  v.abiertos[0].reload();
  assert.equal(v.recargas(), 1);
});

test('sin cooperativa asignada avisa en vez de abrir', () => {
  // Sin proveedor no hay a quién ponerle el importe: el servidor lo rebotaría.
  const v = valorizador([{ ...FILA, cooperativa_id: null, cooperativa_nombre: null }]);
  v.sgCcoopValorizar(9);
  assert.equal(v.abiertos.length, 0);
  assert.match(v.avisos.join(' '), /asignale la cooperativa/);
});

test('si la fila ya no está en la lista, lo dice y refresca', () => {
  const v = valorizador([]);
  v.sgCcoopValorizar(9);
  assert.equal(v.abiertos.length, 0);
  assert.match(v.avisos.join(' '), /ya no está en la lista/);
  assert.equal(v.recargas(), 1);
});

// ── 3 · Y SALE DONDE TIENE QUE SALIR ───────────────────────────────────────

test('el botón está en la fila, y sólo en la que falta valorizar', () => {
  const i = PANEL.indexOf('function sgCcoopRender(){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, PANEL.indexOf(SALTO + '}', PANEL.indexOf("La plata se carga en", i) - 400) + 3);
  const fila = PANEL.slice(i, i + 6000);
  assert.match(fila, /onclick="sgCcoopValorizar\(' \+ f\.gasto_id \+ '\)">💵 Valorizar/);
  // Sin cooperativa, primero hay que asignarla.
  assert.match(fila, /!f\.gasto_id\s*\n?\s*\?\s*'<button[^']*sgCcoopAsignar/);
  assert.ok(b.length >= 0);
});

test('a la ya valorizada no se le ofrece nada, porque el servidor no la pisaría', () => {
  // El UPDATE lleva AND estado='pendiente_valorizar': un botón de corregir
  // mandaría el pedido, no cambiaría nada, y contestaría que sí. Es el botón que
  // no hace nada, otra vez.
  const i = PANEL.indexOf('function sgCcoopRender(){');
  const b = PANEL.slice(i, i + 6000);
  assert.match(b, /f\.estado === 'valorizado'/);
  // Se mira el BOTÓN, no la palabra: el comentario del código explica por qué no
  // está, y buscar «Corregir» a secas se matchea a sí mismo.
  assert.ok(!b.includes('>Corregir<'), 'volvió el botón de corregir, que no corrige nada');
  const j = SG.indexOf("router.post('/gastos-servicio/valorizar'");
  const r = SG.slice(j, SG.indexOf(SALTO + '});', j));
  assert.match(r, /AND estado='pendiente_valorizar' AND activo=1/);
});

test('la tabla sigue sin pedir barra de desplazamiento lateral', () => {
  const i = PANEL.indexOf('function sgCcoopRender(){');
  const b = PANEL.slice(i, i + 6000);
  assert.match(b, /<div class="ab-table-wrap">/);
  // Sólo la cabecera de ESTA tabla. La ventana también agarra la del corte por
  // cooperativa, que va justo arriba y tiene siete columnas: se ancla en el
  // primer título propio.
  const a = b.indexOf('<th>Fecha</th>');
  assert.ok(a > 0, 'no está la cabecera de la tabla de descargas');
  const cab = b.slice(a, b.indexOf('</tr></thead>', a));
  // La columna de acciones ya existía: el botón entra ahí, no en una doceava.
  assert.equal((cab.match(/<th/g) || []).length, 12, 'la tabla cambió de cantidad de columnas');
  assert.match(b, /white-space:nowrap/);
});

// ── 4 · CERO NO ES UN ÉXITO ────────────────────────────────────────────────

test('si no se valorizó ninguna, no dice que sí', () => {
  // El servidor sólo pisa lo pendiente: si ya tenía importe, o la anularon, o es
  // de otro proveedor, contesta ok con cero cambios. Decir «0 operación(es)
  // valorizada(s)» y cerrar el cuadro deja al operador convencido de que cargó
  // la plata — y la partida sigue trabada sin que entienda por qué.
  const i = PANEL.indexOf('function sgGdsValGuardar(){');
  const b = PANEL.slice(i, PANEL.indexOf(SALTO + '}', i));
  assert.match(b, /Number\(r\.data&&r\.data\.valorizados\)>0/);
  assert.match(b, /No se valorizó ninguna/);
  // Y el cuadro NO se cierra en ese caso, o el operador pierde lo que tipeó.
  const rama = b.slice(b.indexOf('else if(r&&r.ok)'));
  assert.ok(!rama.includes("closeMB('sg-val-modal')"), 'cerró el cuadro sin haber guardado nada');
});

// ── 5 · LOS CARTELES YA NO MANDAN A UNA PANTALLA QUE NO EXISTE ─────────────

test('ningún aviso manda a «Cargas y Descargas», que se fue hace rato', () => {
  // Eran tres: el pie de la tabla, el freno de la liquidación en el panel, y el
  // que sale por API cuando la partida está terminada. Los tres mandaban a una
  // solapa que ya no está, así que el operador no tenía dónde destrabar.
  const vivos = [];
  for (const [arch, txt] of [
    ['panel.html', PANEL],
    ['sg_partida_terminada.js', fs.readFileSync(path.join(RAIZ, 'src/servicios/sg_partida_terminada.js'), 'utf8')],
  ]) {
    for (const m of txt.matchAll(/Gastos Directos → Cargas y Descargas/g)) {
      vivos.push(arch + ':' + txt.slice(0, m.index).split('\n').length);
    }
  }
  assert.deepEqual(vivos, [], 'quedaron avisos mandando a una pantalla que no existe');
});

test('y el freno de la liquidación manda al botón nuevo', () => {
  const i = PANEL.indexOf("frenos.push('La <b>descarga</b> está cargada pero sin valorizar");
  assert.ok(i > 0, 'no está el freno de la descarga sin valorizar');
  const b = PANEL.slice(i, i + 700);
  assert.match(b, /Gastos Directos → Control Cooperativa/);
  assert.match(b, /💵 Valorizar/);
});

test('el pie de la tabla también', () => {
  const i = PANEL.indexOf('function sgCcoopRender(){');
  const b = PANEL.slice(i, i + 6000);
  assert.match(b, /El importe se pone con /);
  assert.match(b, /hasta '\s*\n?\s*\+ 'que no entre, la partida no se puede liquidar/);
});

// ── 6 · Y EL CHIP ELEGIDO SE MARCA ─────────────────────────────────────────

test('el filtro de estado resalta el chip que se apretó', () => {
  // Buscaba los chips adentro de #sec-sg-control-coop, una sección que tampoco
  // existe: el filtro andaba, pero el resaltado se quedaba siempre en «Todas» y
  // no había forma de saber qué se estaba mirando.
  const i = PANEL.indexOf('function sgCcoopEstado(e){');
  const b = PANEL.slice(i, PANEL.indexOf(SALTO + '}', i));
  assert.match(b, /querySelectorAll\('#sggd-pane-coop \.sgcc-est'\)/);
  // Y ese contenedor existe de verdad, con sus cuatro chips.
  const j = PANEL.indexOf('id="sggd-pane-coop"');
  assert.ok(j > 0, 'no existe el pane de Control Cooperativa');
  const pane = PANEL.slice(j, j + 4000);
  assert.equal((pane.match(/class="sgcc-est/g) || []).length, 4);
});

// ── 7 · Y LA PANTALLA TIENE SU MANUAL, QUE ES LA REGLA ─────────────────────

test('Gastos Directos tiene su «¿Cómo se usa?»', () => {
  const i = PANEL.indexOf('id="sec-sg-gastos-directos"');
  assert.match(PANEL.slice(i, i + 3000),
    /onclick="sgManualAbrir\('gastos'\)">❓ ¿Cómo se usa\?<\/button>/);
  const j = PANEL.indexOf('SG_MANUAL.gastos = {');
  assert.ok(j > 0, 'Gastos Directos no tiene manual');
  const m = PANEL.slice(j, PANEL.indexOf(SALTO + '};', j));
  const plano = m.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
  for (const x of ['Fletes de salida', 'Fletes de entrada', 'Control Cooperativa', 'Repasos']) {
    assert.ok(plano.includes(x), 'al manual le falta la solapa: ' + x);
  }
  for (const campo of ['💵 Valorizar', 'Cobra por', 'Asignar']) {
    assert.ok(m.includes(campo), 'al manual le falta el campo: ' + campo);
  }
  // Lo que de verdad hay que saber: sin el importe no se liquida.
  assert.ok(plano.includes('frena la liquidación'), 'no dice que un gasto sin valorizar frena');
  assert.ok(plano.includes('entra al costo del lote'), 'no dice cuándo entra al costo');
  // Y que una vez valorizada no se corrige desde ahí, que es lo que se decidió.
  assert.ok(plano.includes('no se corrige desde acá'), 'no avisa que no se puede corregir');
});

test('y queda anotado con su versión', () => {
  const j = PANEL.indexOf('SG_MANUAL.gastos = {');
  const m = PANEL.slice(j, PANEL.indexOf(SALTO + '};', j));
  assert.match(m, /Qué cambió, y desde cuándo/);
  const SIDEBAR = fs.readFileSync(path.join(RAIZ, 'src/sidebar-v2.js'), 'utf8');
  const actual = Number((SIDEBAR.match(/const VERSION = 'V(\d+)'/) || [])[1]);
  const vs = (m.match(/<span class="ver">V(\d+)<\/span>/g) || [])
    .map((v) => Number(v.match(/V(\d+)/)[1]));
  assert.ok(vs.includes(1003), 'el cambio de esta versión no está anotado');
  for (const n of vs) assert.ok(n <= actual, 'el manual cita la V' + n + ' y el panel va en la V' + actual);
});
