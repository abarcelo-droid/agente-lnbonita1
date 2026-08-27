// ══ DOS COSAS DE LA PANTALLA DE FACTURAR ═══════════════════════════════════
// Pablo, 27/8/2026.
//
// 1) «Después de emitir un comprobante, queda en el último cliente. Debería
//    mostrarme toda la lista con los clientes disponibles.»
// 2) «Dame la posibilidad a mí y a todos los ADM de ver el asiento contable
//    que realizamos.»
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

const bloqueDe = (nombre, largo = 1800) => {
  const i = PANEL.indexOf('function ' + nombre + '(');
  assert.ok(i > 0, 'no encontré ' + nombre);
  return PANEL.slice(i, i + largo);
};

// ── EL CLIENTE NO QUEDA PEGADO ─────────────────────────────────────────────
test('después de emitir, el cliente se borra de los DOS lados', () => {
  // El control es un <select> escondido más un campo de texto a la vista.
  // sgFdInit reseteaba sólo el select: la pantalla seguía mostrando al cliente
  // anterior cuando por dentro ya no había ninguno.
  assert.match(PANEL, /function sgCliLimpiar\(selectId\)\{/);
  const b = bloqueDe('sgCliLimpiar', 500);
  assert.match(b, /sel\.value = '';/, 'el select escondido');
  assert.match(b, /inp\.value = '';/, 'y el texto que se ve');
  // Y que sgFdInit lo llame: sin esto la función existe y no arregla nada.
  assert.match(bloqueDe('sgFdInit', 3000), /sgCliLimpiar\('sgfd-cli'\)/);
});

test('al abrir el campo se ve la lista ENTERA, no un «ningún cliente dice»', () => {
  // La etiqueta que queda en el campo es "ALIAS · RAZÓN SOCIAL", y el filtro
  // compara contra el alias Y la razón social POR SEPARADO: la etiqueta junta no
  // matchea ninguno de los dos. Resultado: "Ningún cliente dice …" sobre una
  // lista llena. Si el texto es exactamente la etiqueta del elegido, no es una
  // búsqueda — es lo que quedó de la vez anterior.
  const i = PANEL.indexOf('var pintar = function(){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 1600);
  assert.match(b, /String\(inp\.value \|\| ''\) === sgCliLabel\(elegido\)/);
  assert.match(b, /inp\.select\(\)/, 'y si escribe, que reemplace en vez de agregar');
  // La lista completa, no la filtrada.
  assert.match(b, /\(SG\.cacheCli \|\| \[\]\)\.slice\(0, 60\)/);
});

// ── EL ASIENTO, PARA TODA LA ADMINISTRACIÓN ────────────────────────────────
test('el asiento lo ve quien lleva la contabilidad, no sólo el dueño', () => {
  // Antes miraba el ROL. El que lleva los libros tiene que poder mirar el debe y
  // el haber en el momento en que se genera —el único momento en que se puede
  // frenar— sin depender de que el dueño esté al lado.
  const b = bloqueDe('sgAsientoEsAdmin', 500);
  assert.match(b, /rol === 'admin'/, 'el admin sigue entrando');
  assert.match(b, /lnbNivel\(SG_MODULOS_CONTABLES\[i\]\)/);
  assert.match(PANEL, /var SG_MODULOS_CONTABLES = \[/);
  for (const m of ['sgct-plan-cuentas', 'sgct-asientos', 'sgct-modelos',
    'sgct-iva-compras', 'sgct-iva-ventas', 'sgct-puntos-venta']) {
    assert.ok(PANEL.includes("'" + m + "'"), m + ' falta en la lista contable');
  }
});

test('el que sólo vende sigue sin ver el cuadro', () => {
  // No es su trabajo, le ocupa media pantalla y no puede hacer nada con él.
  const i = PANEL.indexOf('var SG_MODULOS_CONTABLES = [');
  const fin = PANEL.indexOf('];', i);
  const lista = PANEL.slice(i, fin);
  for (const m of ['sg-ventas', 'sg-pedidos', 'sg-vta-comprobantes', 'sg-remitos-pend']) {
    assert.ok(!lista.includes(m), m + ' no es contabilidad');
  }
});

test('sigue habiendo UNA sola puerta, adentro de los armadores', () => {
  // Se envuelve dentro de los armadores de cuadro y no en las diez pantallas que
  // los llaman: una pantalla nueva no puede olvidarse de cerrarla.
  assert.match(PANEL, /function sgAsientoPlegado\(html, titulo\)\{/);
  assert.match(bloqueDe('sgAsientoPlegado', 400), /if \(!sgAsientoEsAdmin\(\)\) return '';/);
  assert.equal((PANEL.match(/function sgAsientoEsAdmin\(\)/g) || []).length, 1);
});

test('el cartel ya no dice que lo ve uno solo', () => {
  assert.ok(!PANEL.includes('(sólo lo ves vos)'), 'quedó el texto viejo y ahora miente');
  assert.match(PANEL, /\(lo ve la administración\)/);
});
