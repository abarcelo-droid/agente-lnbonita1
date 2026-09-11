// ══════════════════════════════════════════════════════════════════════════
// LOS REMITOS A SUPERMERCADOS, CADA UNO EN UNA LÍNEA
// ══════════════════════════════════════════════════════════════════════════
//
// Pablo, 9/9/2026: «acomodame todos los datos en los remitos de supermercado para
// que podamos ver todo en una línea».
//
// La tabla no tenía ninguna regla de ancho: «Qué se vendió», la razón social de la
// cadena o un turno largo partían cada remito en tres o cuatro renglones, y la tabla
// corría de costado. Mirar diez remitos era leer cuarenta renglones.
//
// Lo que no se puede perder al cortar es EL DATO: todo lo que se recorta con «…»
// tiene que quedar completo en el cartelito del mouse. Y lo que se viene a buscar o a
// apretar —el total, los botones— no se corta nunca.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const hasta = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i >= 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

// ══════════════════════════════════════════════════════════════════════════
// 1 · LA TABLA
// ══════════════════════════════════════════════════════════════════════════

const SUB = hasta(PANEL, '<div class="sgv-sub" id="sgv-sub-remsuper">', '<tbody id="sg-tb-remsuper">');
const CSS = hasta(SUB, '<style>', '</style>');

test('sin barra de costado, y cada celda en un renglón', () => {
  assert.match(CSS, /#sgv-sub-remsuper \.ab-table-wrap\{overflow-x:hidden !important\}/);
  assert.match(CSS, /#sgv-sub-remsuper table\{table-layout:fixed;width:100%\}/);
  assert.match(CSS, /#sgv-sub-remsuper th,#sgv-sub-remsuper td\{white-space:nowrap\}/);
});

test('las nueve columnas tienen su ancho — y son nueve', () => {
  // Si mañana alguien agrega una columna sin ancho, la tabla vuelve a correrse. Se
  // cuentan contra el encabezado de verdad y contra el colspan del «Cargando…».
  const ths = (SUB.match(/<th[\s>]/g) || []).length;
  assert.equal(ths, 9);
  for (let k = 1; k <= 9; k++) {
    assert.match(CSS, new RegExp('td:nth-child\\(' + k + '\\)\\{width:'), 'la columna ' + k + ' no tiene ancho');
  }
  assert.match(hasta(PANEL, 'function sgDespListar(modo){', '\r\n}'), /var cols = sup \? 9 : 8;/);
});

test('se corta lo de texto; el total y los botones, nunca', () => {
  // Las de texto (N°, fecha, turno, OC, cliente, qué se vendió) y el estado.
  assert.match(CSS, /#sgv-sub-remsuper td:nth-child\(-n\+6\),#sgv-sub-remsuper td:nth-child\(8\)\{overflow:hidden;text-overflow:ellipsis\}/);
  // El total (7) y los botones (9) NO están en esa regla: un total cortado con «…»
  // es un número que no se puede leer, y un botón cortado no se puede apretar.
  const regla = CSS.match(/([^}]*)\{overflow:hidden;text-overflow:ellipsis\}/)[1];
  assert.ok(!/nth-child\(7\)/.test(regla), 'el total se recorta');
  assert.ok(!/nth-child\(9\)/.test(regla), 'los botones se recortan');
  // Y los botones tienen un ancho fijo en píxeles, no un porcentaje: son cuatro y
  // en una pantalla angosta un porcentaje los partiría en dos renglones.
  assert.match(CSS, /td:nth-child\(9\)\{width:\d+px\}/);
});

test('en un teléfono sí se desplaza', () => {
  // Ahí no hay ancho para una línea y cortar todo con «…» dejaría la lista ilegible.
  assert.match(CSS, /@media\(max-width:900px\)\{[\s\S]*overflow-x:auto !important[\s\S]*table-layout:auto/);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · LA LISTA, CORRIDA
// ══════════════════════════════════════════════════════════════════════════

function listar(modo, filas) {
  const src = [
    hasta(PANEL, 'function esc(s){', '}'),
    hasta(PANEL, 'function escH(s){', '\r\n}'),
    hasta(PANEL, 'function sgDespFechaCorta(f){', '\r\n}'),
    hasta(PANEL, 'function sgDespTit(v){', '\r\n}'),
    hasta(PANEL, 'function sgDespListar(modo){', '\r\n}'),
  ].join('\n');
  const tb = { innerHTML: '' };
  const mundo = {
    eid: () => tb,
    api: () => ({ then: (cb) => cb({ ok: true, data: filas }) }),
    sgMoney: (n) => '$ ' + Number(n || 0).toLocaleString('es-AR'),
    SG_ESTDESP: { despachado: 'Despachado' },
    lnbPuedeOperar: () => true,
    lnbPuedeAnular: () => true,
  };
  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(mundo), src + '\nreturn sgDespListar;')(...Object.values(mundo))(modo);
  // Cada celda: su title (si tiene) y su texto visible.
  return [...tb.innerHTML.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map((m) => {
    const t = /title="([^"]*)"/.exec(m[1]);
    return { title: t ? t[1] : null, texto: m[2].replace(/<[^>]+>/g, '') };
  });
}

const REMITO = {
  id: 7, numero: 'SG-DESP-20260911-003', fecha_despacho: '2026-09-11',
  turno: 'Jueves 06:00 hs · CD Esteban Echeverría', oc_cliente: '4500123987',
  cliente_nombre: 'COTO CENTRO INTEGRAL DE COMERCIALIZACION SA', cliente_alias: 'Coto',
  vendido: 'Tomate redondo ×40 cj, Morrón rojo ×25 cj, Berenjena ×12 cj',
  total: 1234567, estado: 'despachado',
};

test('lo que se recorta queda COMPLETO en el cartelito', () => {
  const c = listar('super', [REMITO]);
  assert.equal(c.length, 9);
  assert.equal(c[0].title, 'SG-DESP-20260911-003');
  assert.equal(c[1].title, '2026-09-11');
  assert.equal(c[2].title, 'Jueves 06:00 hs · CD Esteban Echeverría');
  assert.equal(c[3].title, '4500123987');
  // El cliente: se ve el nombre corto y la razón social queda en el cartelito.
  assert.equal(c[4].texto, 'Coto');
  assert.equal(c[4].title, 'COTO CENTRO INTEGRAL DE COMERCIALIZACION SA');
  assert.equal(c[5].title, REMITO.vendido);
  assert.equal(c[5].texto, REMITO.vendido);
});

test('la fecha, corta: 11/09/26', () => {
  const c = listar('super', [REMITO]);
  assert.equal(c[1].texto, '11/09/26');
  const f = hasta(PANEL, 'function sgDespFechaCorta(f){', '\r\n}');
  // eslint-disable-next-line no-new-func
  const corta = new Function(f + '\nreturn sgDespFechaCorta;')();
  assert.equal(corta('2026-01-05'), '05/01/26');
  // Con hora pegada, igual.
  assert.equal(corta('2026-01-05 14:30:00'), '05/01/26');
  // Sin fecha, un guión: no una celda vacía que parezca un error.
  assert.equal(corta(null), '—');
});

test('sin nombre corto, se ve la razón social', () => {
  const c = listar('super', [{ ...REMITO, cliente_alias: null }]);
  assert.equal(c[4].texto, 'COTO CENTRO INTEGRAL DE COMERCIALIZACION SA');
});

test('un apóstrofo se lee como apóstrofo, y un «<» no rompe la fila', () => {
  // esc() está pensado para meter texto en un onclick: le pone una barra delante a
  // cada apóstrofo. En una celda o en un cartelito eso se ve: «D\'Angelo».
  const c = listar('super', [{ ...REMITO, cliente_alias: "D'Angelo", turno: 'antes de las <8 "sin falta"' }]);
  assert.equal(c[4].texto, "D'Angelo");
  assert.ok(!/\\'/.test(c[4].texto), 'el apóstrofo sale con barra');
  // Las comillas no cierran el atributo antes de tiempo.
  assert.equal(c[2].title, 'antes de las &lt;8 &quot;sin falta&quot;');
  assert.equal(c.length, 9, 'un «<» o una comilla desarmaron la fila');
});

test('la lista de remitos comunes no cambió', () => {
  // El pedido fue para la de supermercados. La común tiene su propia columna de
  // alias y sigue mostrando la razón social y la fecha entera.
  const c = listar('normal', [REMITO]);
  assert.equal(c.length, 8);
  assert.equal(c[0].title, null);
  assert.equal(c[1].texto, '2026-09-11');
  assert.equal(c[2].texto, 'Coto');
  assert.equal(c[3].texto, 'COTO CENTRO INTEGRAL DE COMERCIALIZACION SA');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL MANUAL DICE LO QUE EL CÓDIGO HACE
// ══════════════════════════════════════════════════════════════════════════

const plano = (txt) => String(txt).replace(/'\s*\+\s*'/g, '');
const MAN = plano(hasta(PANEL, 'SG_MANUAL.ventas = ', 'SG_MANUAL.reprocesos = '));

test('«cada remito ocupa una sola línea»', () => {
  assert.match(MAN, /<span class="ver">V1042<\/span> <b>Cada remito ocupa una sola línea\.<\/b>/);
  assert.match(MAN, /<b>V1042<\/b> — la lista de <b>remitos a supermercados<\/b> muestra cada remito <b>en una sola línea<\/b>/);
  assert.match(CSS, /white-space:nowrap/);
});

test('«al pasar el mouse aparece completo» — y el cliente, por su nombre corto', () => {
  assert.match(MAN, /<b>al pasar el mouse aparece completo<\/b>/);
  assert.match(MAN, /se ve por su <b>nombre corto<\/b> y la razón social queda en ese mismo cartelito/);
  const c = listar('super', [REMITO]);
  assert.equal(c[5].title, REMITO.vendido);
  assert.equal(c[4].texto, 'Coto');
});

test('«el total y los botones no se cortan nunca»', () => {
  assert.match(MAN, /El total y los botones no se cortan nunca/);
  const regla = CSS.match(/([^}]*)\{overflow:hidden;text-overflow:ellipsis\}/)[1];
  assert.ok(!/nth-child\(7\)|nth-child\(9\)/.test(regla));
});
