// ══ LA OFERTA NO ES PARA CUALQUIERA QUE TENGA USUARIO ══════════════════════
//
// GET /api/sg/oferta devuelve, por cada partida en stock: de QUÉ PROVEEDOR es y qué
// descuento comercial tiene ese proveedor. Es la lista de compras de la casa. Y
// devolvía además el costo de la partida.
//
// Estaba abierta: exigirNivel sólo mira el nivel de módulo en los GET cuya dirección
// está en LECTURA_CONTROLADA, y /api/sg no estaba. El menú escondía la pantalla y la
// dirección se escribía igual.
//
// LAS DOS LISTAS SON NECESARIAS, y es la trampa de este arreglo: declarar el prefijo
// en api_prefijos NO controla lecturas —el mapa de módulos se consulta recién DENTRO
// del `if (soloLee)`, o sea después de que lecturaControlada() dijo que sí—. Una
// abre la puerta del control; la otra dice quién entra. Con sólo la primera, el
// selector de mercadería se dibuja VACÍO en Pedidos, Remitos y Facturación directa y
// sin ningún mensaje, porque el front trata el 403 como "no hay stock".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (p) => fs.readFileSync(path.join(RAIZ, p), 'utf8');
const PERMISOS = leer('src/servicios/permisos.js');
const PREFIJOS = leer('src/servicios/ensure_api_prefijos.js');
const SG = leer('src/rutas/sg.js');
const VENTAS = leer('src/rutas/sg_ventas.js');
const PANEL = leer('src/panel.html');

// La lista literal de LECTURA_CONTROLADA, tal como la lee permisos.js.
function lecturaControlada() {
  const i = PERMISOS.indexOf('const LECTURA_CONTROLADA = new Set([');
  assert.ok(i > 0, 'no encontré LECTURA_CONTROLADA');
  const fin = PERMISOS.indexOf(']);', i);
  // Sin los comentarios: adentro del bloque hay direcciones citadas en prosa
  // ("no se cierra /api/sg entero") que no son entradas de la lista.
  const cuerpo = PERMISOS.slice(i, fin).split('\n')
    .filter((l) => !l.trim().startsWith('//')).join('\n');
  return (cuerpo.match(/'(\/api\/[^']+)'/g) || []).map((x) => x.replace(/'/g, ''));
}

// api_lectura: qué módulo puede LEER qué prefijo, sin poder escribirlo.
function lectura() {
  const i = PREFIJOS.indexOf('const LECTURA = [');
  assert.ok(i > 0);
  const fin = PREFIJOS.indexOf('\n];', i);
  const filas = [];
  for (const m of PREFIJOS.slice(i, fin).matchAll(/\[\s*'([^']+)',\s*'([^']+)'\s*\]/g)) {
    filas.push({ modulo: m[1], prefijos: m[2].split(',').map((x) => x.trim()) });
  }
  return filas;
}

test('la oferta y la disponibilidad pasan a ser lectura controlada', () => {
  const l = lecturaControlada();
  assert.ok(l.includes('/api/sg/oferta'), 'sin esto el GET pasa derecho para cualquiera');
  assert.ok(l.includes('/api/sg/disponibilidad'));
  // Y NO se cierra '/api/sg' entero: son doscientas rutas de un router que leen
  // pantallas de otros módulos. Apagarlas todas de una rompe trabajo diario sin que
  // nadie entienda por qué.
  assert.ok(!l.includes('/api/sg'), 'cerrar el universo sg entero es otra cosa, y rompe');
});

test('y quedan declarados los que la leen, o el selector se abre VACÍO', () => {
  // sgItemPicker pide /sg/disponibilidad para la lista de productos y /sg/oferta para
  // las partidas de uno. Lo abren Pedidos, Remitos y Facturación directa.
  const filas = lectura();
  const de = (m) => (filas.find((x) => x.modulo === m) || { prefijos: [] }).prefijos;
  for (const m of ['sg-pedidos', 'sg-ventas', 'sg-facturar']) {
    assert.ok(de(m).includes('sg/oferta'), m + ' abre el selector y necesita leer la oferta');
    assert.ok(de(m).includes('sg/disponibilidad'), m + ' necesita la lista de productos');
  }
  // Una fila por módulo: la columna se guarda con un UPDATE que la pisa entera, así
  // que un segundo renglón para el mismo módulo le borra el primero sin avisar.
  const vistos = new Set();
  for (const f of filas) {
    assert.ok(!vistos.has(f.modulo), 'módulo repetido en LECTURA: ' + f.modulo
      + ' — el UPDATE pisa la columna y el primero se pierde');
    vistos.add(f.modulo);
  }
});

test('va en api_lectura, no en api_prefijos: leer no es escribir', () => {
  // Adentro de api_prefijos, "puede leer" se convierte en "puede escribir". Pañol
  // necesita el padrón para saber a quién le entrega una herramienta, y no por eso
  // puede tocar un legajo.
  const i = PREFIJOS.indexOf('const PREFIJOS = [');
  const fin = PREFIJOS.indexOf('const LECTURA = [');
  const arriba = PREFIJOS.slice(i, fin);
  assert.ok(!/'sg-pedidos',\s*'[^']*sg\/oferta/.test(arriba),
    'sg/oferta no puede entrar por api_prefijos: eso daría escritura');
});

test('el costo de la partida ya no viaja a la pantalla del que vende', () => {
  const i = SG.indexOf("router.get('/oferta'");
  assert.ok(i > 0);
  const cuerpo = SG.slice(i, i + 4000);
  assert.ok(!/\bl\.costo_final\b/.test(cuerpo),
    'el SELECT de /oferta no puede devolver el costo: lo consumen tres pantallas de VENTA');
  // El proveedor y su descuento SÍ siguen: la facturación directa aplica el descuento
  // del proveedor de cada partida, y sin el nombre no se sabe cuál se está eligiendo.
  assert.match(cuerpo, /prov\.descuento_pct AS proveedor_descuento_pct/);
  assert.match(cuerpo, /prov\.razon_social AS proveedor_nombre/);
});

test('y la pantalla no se quedó con una cuenta muerta del costo', () => {
  assert.ok(!/var ck=\(l\.kg_vigente>0\?\(l\.costo_final\|\|0\)\/l\.kg_vigente:0\)/.test(PANEL),
    'se calculaba el costo por kg y no se mostraba en ningún lado');
});

test('las diez lecturas de ventas que no pedían sesión ahora la piden', () => {
  // El libro de ventas entero en Excel, la cuenta corriente de cualquier cliente con
  // su CUIT, el PDF de cualquier comprobante. Es la misma puerta que /oferta, del
  // otro lado del pasillo.
  const sinAuth = [...VENTAS.matchAll(/^router\.get\('([^']+)',\s*([A-Za-z_$][\w$]*|\()/gm)]
    .filter((m) => m[2] !== 'requireAuth').map((m) => m[1]);
  assert.deepEqual(sinAuth, [], 'quedaron GET sin requireAuth: ' + sinAuth.join(', '));
});
