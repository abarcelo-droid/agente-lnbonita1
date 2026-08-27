// ══ LAS VENTAS DE SAN GERÓNIMO NO SON PARA CUALQUIERA QUE TENGA USUARIO ════
//
// Los GET de ventas pedían sesión y nada más. El nivel de módulo —ver / operar /
// anular— no los miraba: exigirNivel sólo controla las lecturas cuya dirección
// está en LECTURA_CONTROLADA, y las de ventas no estaban. El menú escondía la
// pantalla y la dirección se escribía igual.
//
// Lo que salía por ahí: la cuenta corriente de cualquier cliente con su CUIT, el
// libro de ventas entero en Excel, las facturas, las liquidaciones, las cobranzas
// y el PDF de cualquier comprobante.
//
// LAS DOS LISTAS SON NECESARIAS. Una abre la puerta del control; la otra dice
// quién entra. Con sólo la primera, la pantalla se abre VACÍA y sin mensaje.
//
// Y HAY UNA TRAMPA QUE NO ESTÁ ESCRITA EN NINGÚN LADO: declarar un prefijo más
// largo no AGREGA un lector, REEMPLAZA el juego de dueños de esa dirección
// —modulosDeRuta() se queda con el largo máximo y descarta el resto—. Por eso
// 'sg/ventas/facturas-sin-asiento' figura en dos filas aunque una sola pantalla
// lo llame.
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
const PANEL = leer('src/panel.html');

function lecturaControlada() {
  const i = PERMISOS.indexOf('const LECTURA_CONTROLADA = new Set([');
  assert.ok(i > 0);
  const fin = PERMISOS.indexOf(']);', i);
  const cuerpo = PERMISOS.slice(i, fin).split('\n')
    .filter((l) => !l.trim().startsWith('//')).join('\n');
  return (cuerpo.match(/'(\/api\/[^']+)'/g) || []).map((x) => x.replace(/'/g, ''));
}

// Las dos tablas de ensure_api_prefijos.js: PREFIJOS (escribir) y LECTURA (leer).
function filas(constante) {
  const i = PREFIJOS.indexOf('const ' + constante + ' = [');
  assert.ok(i > 0, 'no encontré ' + constante);
  const fin = PREFIJOS.indexOf('\n];', i);
  const out = {};
  for (const m of PREFIJOS.slice(i, fin).matchAll(/\[\s*'([^']+)',\s*'([^']+)'\s*\]/g)) {
    // La MISMA fila, nunca dos: esto se guarda con un UPDATE de la columna, así
    // que un segundo ['sg-ventas', …] le borraría los prefijos al primero.
    assert.equal(out[m[1]], undefined, m[1] + ' está dos veces en ' + constante);
    out[m[1]] = m[2].split(',').map((x) => x.trim());
  }
  return out;
}

// La misma comparación que hace permisos.js: por SEGMENTO COMPLETO.
const cubre = (prefijo, url) => url === prefijo || url.startsWith(prefijo + '/');

// ── LA PUERTA DEL CONTROL ──────────────────────────────────────────────────
test('las ventas pasan a ser lectura controlada', () => {
  const l = lecturaControlada();
  for (const d of ['/api/sg/ventas', '/api/sg/despachos', '/api/sg/despachos-pendientes',
    '/api/sg/facturable', '/api/sg/pedidos', '/api/sg/cc-clientes']) {
    assert.ok(l.includes(d), d + ' sin esto el GET pasa derecho para cualquiera');
  }
});

test('cerrar /api/sg/ventas alcanza para todo lo que cuelga', () => {
  // Una sola entrada y no seis: así ninguna sub-dirección queda afuera el día
  // que alguien agregue un endpoint nuevo bajo ventas.
  for (const u of ['/api/sg/ventas/facturas', '/api/sg/ventas/facturas/9/pdf',
    '/api/sg/ventas/facturas/export.xlsx', '/api/sg/ventas/facturas-sin-asiento',
    '/api/sg/ventas/cc/4', '/api/sg/ventas/cobranzas/cuentas',
    '/api/sg/ventas/liquidaciones', '/api/sg/ventas/modelo-venta']) {
    assert.ok(cubre('/api/sg/ventas', u), u + ' queda afuera');
  }
});

test('despachos-pendientes necesita entrada PROPIA — es la trampa del guion', () => {
  // El prefijo matchea por segmento completo. Sin este renglón, la lista de
  // remitos sin facturar queda abierta y se cree cerrada.
  assert.equal(cubre('/api/sg/despachos', '/api/sg/despachos-pendientes'), false);
  assert.ok(lecturaControlada().includes('/api/sg/despachos-pendientes'));
});

test('NO se cierra /api/sg pelado', () => {
  // Apagaría doscientas rutas del router compartido, incluidas las que el panel
  // pide al abrir CUALQUIER pantalla de San Gerónimo.
  const l = lecturaControlada();
  assert.ok(!l.includes('/api/sg'), 'el panel entero se quedaría sin desplegables');
  for (const d of ['/api/sg/productos', '/api/sg/clientes', '/api/sg/proveedores',
    '/api/sg/envases', '/api/sg/presentaciones']) {
    assert.ok(!l.includes(d), d + ' lo precarga todo el módulo');
  }
});

// ── QUIÉN ENTRA ────────────────────────────────────────────────────────────
test('cada pantalla que lee algo de otra lo tiene declarado', () => {
  const L = filas('LECTURA');
  // El cartel de "comprobantes que NO están en el libro". Un 403 acá se lee
  // exactamente como "está todo contabilizado": el peor de los silencios.
  for (const m of ['sg-ventas', 'sg-vta-comprobantes']) {
    assert.ok(L[m] && L[m].includes('sg/ventas/facturas-sin-asiento'),
      m + ' se queda sin el cartel de comprobantes sin asiento');
  }
  // El PDF del comprobante recién emitido, y el detalle en la cuenta corriente.
  for (const m of ['sg-remitos-pend', 'sg-cc-clientes', 'sg-facturar']) {
    assert.ok(L[m] && L[m].includes('sg/ventas/facturas'), m + ' no puede abrir el comprobante');
  }
  // El selector de punto de venta: esto ya estaba roto ANTES de este cierre.
  for (const m of ['sg-ventas', 'sg-remitos-pend']) {
    assert.ok(L[m] && L[m].includes('sg/contable/puntos-venta'),
      m + ' dice "no hay puntos de venta cargados" y no se puede facturar');
  }
  // Y el selector de mercadería sigue en pie.
  for (const m of ['sg-pedidos', 'sg-ventas', 'sg-facturar', 'sg-vta-comprobantes', 'sg-remitos-pend']) {
    assert.ok(L[m].includes('sg/oferta') && L[m].includes('sg/disponibilidad'), m);
  }
});

test('el prefijo más largo REEMPLAZA a los dueños: por eso va en las dos filas', () => {
  // modulosDeRuta() se queda con el largo máximo. Si sólo sg-vta-comprobantes
  // declarara 'sg/ventas/facturas-sin-asiento', sg-ventas —que ganaba con
  // 'sg/ventas'— dejaría de ser dueño de esa dirección y comería 403.
  const L = filas('LECTURA'), P = filas('PREFIJOS');
  const duenos = (url) => {
    let mejor = '', out = [];
    for (const [mod, ps] of Object.entries({ ...P })) {
      for (const p of ps) if (cubre('/api/' + p, url) && p.length >= mejor.length) mejor = p.length > mejor.length ? p : mejor;
    }
    for (const tabla of [P, L]) {
      for (const [mod, ps] of Object.entries(tabla)) {
        for (const p of ps) if (p === mejor) out.push(mod);
      }
    }
    return [...new Set(out)];
  };
  assert.ok(duenos('/api/sg/ventas/facturas').includes('sg-ventas'));
  assert.ok(duenos('/api/sg/ventas/facturas').includes('sg-vta-comprobantes'));
});

test('una fila por módulo: la segunda le borraría los prefijos a la primera', () => {
  filas('PREFIJOS');   // el assert vive adentro
  filas('LECTURA');
});

// ── LOS DOS REBOTES QUE YA EXISTÍAN ────────────────────────────────────────
test('el que factura en ventanilla puede cobrar, y recibir una liquidación', () => {
  // Dos rebotes vivos, sin relación con el cierre: el que facturaba en ventanilla
  // desde Salidas emitía el comprobante fiscal y la plata NO entraba, porque el
  // prefijo de cobranzas era sólo de CC clientes.
  const P = filas('PREFIJOS');
  assert.ok(P['sg-ventas'].includes('sg/ventas/cobranzas'), 'la venta quedaba a medias');
  assert.ok(P['sg-ventas'].includes('sg/ventas/liquidaciones'),
    'el 403 llegaba después de cargar la liquidación entera');
});

// ── QUE EL SILENCIO NO SEA LA RESPUESTA ────────────────────────────────────
test('un 403 deja de leerse como «no hay datos»', () => {
  // Vale más que cualquier lista, porque protege también al lector que se escape
  // la próxima vez.
  const i = PANEL.indexOf('function api(url,method,body){');
  assert.ok(i > 0);
  const bloque = PANEL.slice(i, i + 700);
  assert.match(bloque, /r\.status===403/);
  assert.match(bloque, /sin_permiso/);
  assert.match(bloque, /No tenes acceso a este modulo/);
  // Y una sola definición: la segunda gana en silencio.
  assert.equal((PANEL.match(/function api\(url,method,body\)\{/g) || []).length, 1);
});
