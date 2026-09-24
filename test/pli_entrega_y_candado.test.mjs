// ══ LA FECHA DE ENTREGA, Y EL CAMPO QUE DECÍA QUE HABÍA GUARDADO ═══════════
//
// Dos cosas que el módulo prometía y no cumplía:
//
//  1. El documento que se le manda al proveedor tiene una columna «Entrega» desde el primer día, y
//     ningún endpoint escribía esa fecha: salía «—» en todos los renglones. Una columna vacía en un
//     papel que se manda afuera enseña a leerlo por arriba, y es el mismo papel donde el precio tiene
//     que quedar firme. Ahora la fecha se carga, y si ningún renglón la tiene la columna no se dibuja.
//
//  2. El selector de insumo de una compra ya cargada dejaba elegir otro, el UPDATE nunca escribía
//     insumo_id y la pantalla contestaba «✓ Compra registrada». El que lo cambió se iba convencido
//     de que había quedado. Un ok mentiroso es peor que un error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const RUTA = leer('src/rutas/planificacion.js');
const DDL = leer('src/servicios/db_pli.js');
const PANEL = leer('src/panel.html');

function fuente(txt, firma) {
  const i = txt.indexOf(firma);
  assert.ok(i >= 0, 'no está: ' + firma);
  let prof = 0, k = txt.indexOf('{', i);
  for (; k < txt.length; k++) {
    if (txt[k] === '{') prof++;
    else if (txt[k] === '}') { prof--; if (prof === 0) break; }
  }
  return txt.slice(i, k + 1);
}

// ── LA FECHA DE ENTREGA ────────────────────────────────────────────────────

test('el alta y la corrección escriben la fecha de entrega', () => {
  // La columna ya estaba en la tabla, marcada «RESERVADO»: cero migración.
  assert.match(DDL, /fecha_entrega\s+TEXT,/);
  const alta = fuente(RUTA, "router.post('/planes/:id/compras'");
  assert.match(alta, /lugar_entrega, fecha_entrega, creado_por_id/);
  assert.match(alta, /vFecha\(b\.fecha_entrega, 'La fecha de entrega'\)/);
  const patch = fuente(RUTA, "router.patch('/planes/:id/compras/:compraId'");
  assert.match(patch, /lugar_entrega=\?, fecha_entrega=\?/);
  // Y la corrección que no la manda no la borra: se conserva la de la fila.
  assert.match(patch, /b\.fecha_entrega === undefined \? a\.fecha_entrega : vFecha\(b\.fecha_entrega, 'La fecha de entrega'\)/);
});

test('la pantalla tiene el campo, al lado del lugar, y lo manda', () => {
  assert.match(PANEL, /<input id="pli-cmp-fentrega" type="date"/);
  const g = fuente(PANEL, 'function pliCompraGuardar()');
  assert.match(g, /fecha_entrega: document\.getElementById\('pli-cmp-fentrega'\)\.value \|\| null,/);
  // Vacío viaja como null y no como cadena vacía: '' entraría a la base como una fecha que no es.
  assert.match(g, /\|\| null,/);
  const a = fuente(PANEL, 'function pliCompraAbrir');
  assert.match(a, /getElementById\('pli-cmp-fentrega'\)\.value = c \? \(c\.fecha_entrega \|\| ''\) : '';/);
});

test('la columna «Entrega» del documento se dibuja sólo si algún renglón la tiene', () => {
  const doc = fuente(PANEL, 'function pliOrdenHtml(d)');
  assert.match(doc, /var conEntrega = \(d\.renglones \|\| \[\]\)\.some\(function\(r\) \{ return !!r\.fecha_entrega; \}\);/);
  assert.match(doc, /conEntrega \? '<th>Entrega<\/th>' : ''/);
  // Y con ella, TODO se corre: el colgroup, la celda, el colspan de la nota y el pie del total.
  // Si alguno queda fijo, la tabla sale con una columna de más o de menos y el total se desalinea.
  assert.match(doc, /conEntrega \? '<col style="width:13%">' : ''/);
  assert.match(doc, /conEntrega \? '<td>' \+ pliEsc\(r\.fecha_entrega \|\| '—'\) \+ '<\/td>' : ''/);
  assert.match(doc, /colspan="' \+ \(conEntrega \? 6 : 5\) \+ '"/);
  assert.match(doc, /conEntrega \? '<td><\/td>' : ''/);
  // El ancho del insumo se queda el lugar que dejó libre, en vez de sobrar 13% a la derecha.
  assert.match(doc, /\(conEntrega \? '25' : '33'\) \+ '%">'/);
});

test('el documento armado sin fechas no trae ni el título ni una celda de más', () => {
  const armar = new Function('pliEsc', 'pliN', 'pliHoyISO', 'window', [
    'var PLI_LOGO_FORMATO = ' + /var PLI_LOGO_FORMATO = (.*);/.exec(PANEL)[1] + ';',
    fuente(PANEL, 'function pliOrdenLogoHtml(d)'),
    fuente(PANEL, 'function pliOrdenHtml(d)'), 'return pliOrdenHtml;',
  ].join('\n'))((s) => String(s == null ? '' : s), (n, d) => Number(n).toFixed(d === undefined ? 0 : d),
    () => '2026-09-24', { LNB_USER: { rol: 'admin' } });

  const DOC = (fecha) => ({
    sociedad: 'Puente Cordón SA', nro_orden: 'OC-880', proveedor: 'CARTOCOR', fecha: '2026-09-02',
    renglones: [{ id: 1, insumo: 'CAJA GRANDE', codigo: 'CJ-600', cantidad: 100, unidad: 'UN',
      precio: 1811.3, moneda: 'ARS', subtotal: 181130, fecha_entrega: fecha }],
    total: 181130, moneda: 'ARS', sin_precio: 0, varias_monedas: false,
  });

  const sin = armar(DOC(null));
  assert.ok(!/<th>Entrega<\/th>/.test(sin), 'dibuja la columna aunque ningún renglón traiga fecha');
  const con = armar(DOC('2026-10-15'));
  assert.match(con, /<th>Entrega<\/th>/);
  assert.match(con, /2026-10-15/);
  // Y la tabla queda cuadrada en los dos casos: tantas celdas por fila como títulos.
  for (const html of [sin, con]) {
    const cols = (html.match(/<th>|<th style/g) || []).length;
    const fila = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
    assert.equal((fila.match(/<td/g) || []).length, cols, 'la fila no tiene una celda por columna');
    const colgroup = html.slice(html.indexOf('<colgroup>'), html.indexOf('</colgroup>'));
    assert.equal((colgroup.match(/<col /g) || []).length, cols, 'el colgroup no coincide con los títulos');
  }
});

// ── EL CANDADO DEL INSUMO ──────────────────────────────────────────────────

test('el insumo de una compra ya cargada no se cambia, y el servidor lo dice', () => {
  const patch = fuente(RUTA, "router.patch('/planes/:id/compras/:compraId'");
  // El cerrojo NO mira si está recibida: el UPDATE nunca escribió insumo_id, así que para las otras
  // la pantalla contestaba «✓» sin cambiar nada.
  assert.match(patch, /if \(b\.insumo_id !== undefined && parseInt\(b\.insumo_id, 10\) !== a\.insumo_id\) \{/);
  // Dos mensajes, porque son dos situaciones: una tiene el stock aplicado y la otra no.
  assert.match(patch, /ya se recibió y su mercadería entró al stock de ese insumo/);
  assert.match(patch, /borrá esta compra y cargala de nuevo con el insumo que/);
  // Y el UPDATE sigue sin escribir insumo_id: si mañana alguien lo agrega, el stock quedaría sumado
  // en el insumo equivocado y ninguna de las dos fichas lo podría explicar.
  //
  // Se ancla en «UPDATE pli_compras SET» y no en la primera columna: buscando `SET fecha=?`, un
  // insumo_id agregado ADELANTE hacía que el recorte no encontrara nada y el assert pasaba solo.
  const i = patch.indexOf('UPDATE pli_compras SET');
  assert.ok(i > 0, 'no encontré el UPDATE de la compra');
  assert.ok(!/insumo_id=\?/.test(patch.slice(i)), 'el UPDATE empezó a mover el insumo de una compra');
});

test('en la pantalla el selector queda con candado al editar, y dice qué hacer', () => {
  const a = fuente(PANEL, 'function pliCompraAbrir');
  assert.match(a, /selIns\.disabled = !!c;/);
  assert.match(a, /El insumo no se cambia: borrá esta compra y cargala de nuevo\./);
  // En un alta se puede elegir: es el único momento en que el insumo se decide.
  assert.match(a, /\? 'El insumo no se cambia[^']*' : '';/);
  assert.match(PANEL, /<div class="pli-cel-chica" id="pli-cmp-insumo-nota"/);
});
