// ══ EL ORDEN DEL MENÚ DE SAN GERÓNIMO ══════════════════════════════════════
//
// Pablo, 27/8/2026, dictó el orden: Ingresos, Administración de Ventas,
// Administración de Compras, Contabilidad. Sigue el camino de la mercadería:
// primero entra, después sale, después se paga el papel y al final se
// contabiliza. Antes Ventas encabezaba y el que recibía un camión tenía que
// bajar hasta la mitad del menú para encontrar su pantalla.
//
// El orden de los GRUPOS sale del `orden` de su primera pantalla —así lo arma
// /api/org/sidebar—, así que basta con que el mínimo de cada grupo esté en el
// bloque que le toca. Va con test porque es un número suelto en una tabla: se
// pisa sin querer al agregar una pantalla y nadie lo nota hasta que lo ve Pablo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (p) => fs.readFileSync(path.join(RAIZ, p), 'utf8');
const MOD = leer('src/servicios/ensure_modulo_sg.js');
const SGCT = leer('src/servicios/ensure_modulo_sgct.js');
const PREFIJOS = leer('src/servicios/ensure_api_prefijos.js');
const PANEL = leer('src/panel.html');

// La tabla MENU_SG tal cual la lee el arranque.
function menu() {
  const i = MOD.indexOf('const MENU_SG = [');
  assert.ok(i > 0);
  const fin = MOD.indexOf('\n  ];', i);
  const filas = [];
  for (const m of MOD.slice(i, fin).matchAll(/\[\s*'([^']+)',\s*(\d+),\s*'([^']+)'\s*\]/g)) {
    filas.push({ grupo: m[1], orden: Number(m[2]), modulo: m[3] });
  }
  assert.ok(filas.length >= 15, 'se leyeron sólo ' + filas.length + ' filas');
  return filas;
}

const primeroDe = (filas, grupo) => Math.min(...filas.filter((f) => f.grupo === grupo).map((f) => f.orden));

test('los grupos van en el orden que dictó Pablo', () => {
  const f = menu();
  const ingresos = primeroDe(f, 'Ingresos');
  const ventas = primeroDe(f, 'Administración de Ventas');
  const compras = primeroDe(f, 'Administración de Compras');
  // Contabilidad vive en su propio archivo.
  const conta = Math.min(...[...SGCT.matchAll(/\["sgct-[a-z-]+",\s*"[^"]+",\s*(\d+)\]/g)]
    .map((m) => Number(m[1])));
  assert.ok(ingresos < ventas, 'Ingresos tiene que ir primero (' + ingresos + ' vs ' + ventas + ')');
  assert.ok(ventas < compras, 'Ventas antes que Compras (' + ventas + ' vs ' + compras + ')');
  assert.ok(compras < conta, 'Compras antes que Contabilidad (' + compras + ' vs ' + conta + ')');
});

test('cada grupo tiene su bloque de diez, sin pisarse con el de al lado', () => {
  // Los bloques dejan huecos a propósito: es lo que permite meter una pantalla
  // nueva en el medio sin renumerar todo. Si dos grupos se solapan, el sidebar
  // los intercala y el menú queda mezclado.
  const f = menu();
  const rangos = {};
  for (const x of f) {
    rangos[x.grupo] = rangos[x.grupo] || { min: x.orden, max: x.orden };
    rangos[x.grupo].min = Math.min(rangos[x.grupo].min, x.orden);
    rangos[x.grupo].max = Math.max(rangos[x.grupo].max, x.orden);
  }
  const gs = Object.entries(rangos).sort((a, b) => a[1].min - b[1].min);
  for (let i = 1; i < gs.length; i++) {
    assert.ok(gs[i][1].min > gs[i - 1][1].max,
      gs[i][0] + ' (' + gs[i][1].min + ') se pisa con ' + gs[i - 1][0] + ' (hasta ' + gs[i - 1][1].max + ')');
  }
});

test('Stock encabeza Ventas: es la pregunta que más se hace', () => {
  const f = menu().filter((x) => x.grupo === 'Administración de Ventas');
  const primero = f.reduce((a, b) => (b.orden < a.orden ? b : a));
  assert.equal(primero.modulo, 'sg-stock');
});

test('«Salidas» pasa a decir qué se hace ahí', () => {
  assert.match(MOD, /label='📤 Remitos y Facturación' WHERE modulo='sg-ventas'/);
  assert.ok(!/label='📤 Salidas'/.test(MOD), 'quedó el UPDATE viejo y le gana al nuevo según el orden');
});

// ── PISOS SE PLEGÓ ADENTRO DE STOCK ────────────────────────────────────────
test('Pisos ya no es un renglón del menú', () => {
  // «Qué hay» y «dónde está» son la misma pregunta partida en dos pantallas.
  assert.match(MOD, /UPDATE modulos_config SET oculto=1 WHERE modulo='sg-pisos'/);
  assert.equal(menu().find((x) => x.modulo === 'sg-pisos'), undefined);
});

test('el módulo NO se borra: sigue siendo el permiso de quien lo tenía', () => {
  // Igual que Control Cooperativa. Borrarlo le sacaría el acceso a quien lo
  // tenía tildado, y eso no es lo que se pidió.
  assert.match(MOD, /\["sg-pisos", "🏢 Pisos", \d+\]/);
});

test('Stock hereda las direcciones de Pisos, o la solapa se abre vacía', () => {
  const i = PREFIJOS.indexOf("['sg-stock',");
  assert.ok(i > 0);
  const fila = PREFIJOS.slice(i, PREFIJOS.indexOf(']', i));
  assert.match(fila, /sg\/pisos/);
  assert.match(fila, /sg\/stock-pisos/);
  // Y sg-pisos las conserva: el que sólo tiene ese permiso sigue entrando.
  const j = PREFIJOS.indexOf("['sg-pisos',");
  assert.ok(j > 0 && /sg\/pisos/.test(PREFIJOS.slice(j, PREFIJOS.indexOf(']', j))));
});

test('la pantalla tiene las dos solapas y la de Pisos vive adentro', () => {
  assert.ok(!PANEL.includes('id="sec-sg-pisos"'), 'la sección vieja tiene que haberse ido');
  assert.match(PANEL, /id="sg-st-tab-partidas"/);
  assert.match(PANEL, /id="sg-st-tab-pisos"/);
  assert.match(PANEL, /function sgStockTab\(cual\)\{/);
  // Los tres pedazos de Pisos siguen enteros, no se perdió ninguno en la mudanza.
  for (const id of ['sg-pi-filtro', 'sg-pi-tot', 'sg-pi-cuerpo']) {
    assert.equal((PANEL.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id);
  }
  // Y el modal de administrar pisos quedó donde estaba: es global, no de la sección.
  assert.match(PANEL, /id="sg-piadm-modal"/);
});

test('quien entra por el módulo viejo cae en la solapa, no en una pantalla que ya no está', () => {
  // Un favorito guardado, una sesión vieja: el módulo sigue existiendo como
  // permiso, así que alguien va a llegar por ahí.
  assert.match(PANEL, /'sg-pisos':\s*function\(\)\{ sgStockInit\(\); sgStockTab\('pisos'\); \}/);
});

// ── EL CONTEO SE HACE POR BULTO ────────────────────────────────────────────
test('Stock cuenta bultos, con el kilo abajo', () => {
  // Pablo, 27/8/2026: «en general los conteos los hacemos por bulto».
  assert.match(PANEL, /<th style="width:\d+%;text-align:right">Bultos disp<\/th>/);
  assert.match(PANEL, /function sgStockBultosCell\(l\)\{/);
  assert.match(PANEL, /sgStockBultosCell\(l\)/);
  const i = PANEL.indexOf('function sgStockBultosCell(l){');
  const b = PANEL.slice(i, i + 600);
  assert.match(b, /l\.bultos_disponibles/);
  // El granel no está encajonado: ahí manda el kilo y se dice por qué.
  assert.match(b, /granel/);
  // Y el kilo no se pierde: lo que se vende por peso lo sigue necesitando.
  assert.match(b, /kg/);
});
