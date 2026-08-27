// ══ RECHAZO TOTAL DE UNA PARTIDA ═══════════════════════════════════════════
//
// Pablo, 27/8/2026: «desde la recepción de una orden de compra debemos tener la
// posibilidad de hacer un RECHAZO TOTAL directamente desde la pantalla general».
//
// El camión llegó y se volvió entero: mala calidad, producto equivocado, llegó
// podrido. No entra nada al stock y la orden se cierra — pero queda anotado que el
// proveedor VINO, con el motivo.
//
// NO ES LO MISMO QUE ANULAR. Anular es «esta orden no va a pasar»; rechazar es «el
// proveedor entregó y se lo devolvimos». Un proveedor al que se le rechazan tres
// camiones es un problema, y si se guarda como una anulación más no queda registro
// de que llegó a venir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const DB = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');

const cuerpo = (txt, nombre) => {
  const i = txt.indexOf('function ' + nombre + '(');
  assert.ok(i > 0, 'no encontré ' + nombre);
  let d = 0, j = txt.indexOf('{', i);
  for (; j < txt.length; j++) {
    if (txt[j] === '{') d++;
    else if (txt[j] === '}') { d--; if (d === 0) { j++; break; } }
  }
  return txt.slice(i, j);
};

// ── EL HECHO SE GUARDA ─────────────────────────────────────────────────────
test('el rechazo deja su marca, su motivo y quién lo hizo', () => {
  for (const c of ['rechazado_en', 'rechazado_motivo', 'rechazado_por']) {
    assert.ok(DB.includes("addCol('sg_oc', '" + c + "'"), 'falta la columna ' + c);
  }
});

test('el estado sigue siendo anulada, y se explica por qué', () => {
  // El CHECK de sg_oc no admite otro valor, y rehacer esa tabla arrastra media
  // docena de claves foráneas. El hecho vive en las columnas.
  const b = cuerpo(SG, 'cerrarOcSinEntrada');
  assert.match(b, /UPDATE sg_oc SET estado='anulada'/);
  assert.match(b, /rechazado_en=datetime\('now','localtime'\)/);
  assert.match(b, /rechazado_motivo=\?, rechazado_por=\?/);
  // Y sólo se escribe si es un rechazo: anular no anota ningún hecho del proveedor.
  assert.match(b, /if \(rechazo\) \{/);
});

// ── EL MOTIVO ES OBLIGATORIO ───────────────────────────────────────────────
test('sin motivo no se rechaza', () => {
  // Un rechazo sin motivo, a los dos meses, es una orden anulada cualquiera: no se
  // puede reclamar ni discutir con nadie.
  const i = SG.indexOf("router.post('/oc/:id/rechazar'");
  assert.ok(i > 0);
  const b = SG.slice(i, i + 1400);
  assert.match(b, /if \(!motivo \|\| motivo\.length < 3\)/);
  assert.match(b, /Escribí por qué se rechaza: queda registrado/);
  // Y la pantalla lo pide antes de mandar nada.
  const f = cuerpo(PANEL, 'sgOcRechazar');
  assert.match(f, /if \(String\(motivo\)\.trim\(\)\.length < 3\)/);
});

// ── SÓLO SI NO ENTRÓ NADA ──────────────────────────────────────────────────
test('con mercadería ya recibida NO es un rechazo total, y se dice qué hacer', () => {
  // Si parte ya entró, esa parte está en el stock: «rechazar todo» sería mentira.
  // El camino es dar la orden por terminada con lo que entró.
  const b = cuerpo(SG, 'cerrarOcSinEntrada');
  assert.match(b, /SELECT COUNT\(\*\) c FROM sg_recepciones WHERE oc_id=\? AND activo=1/);
  assert.match(b, /un rechazo TOTAL es cuando no entró nada/);
  assert.match(b, /usá «Terminada»/);
});

test('la pantalla no ofrece las dos salidas a la vez', () => {
  // «Terminada» y «Rechazar todo» son excluyentes: si ya entró algo se termina con
  // lo que entró; si no entró nada y el camión se volvió, es un rechazo.
  const i = PANEL.indexOf('var accion = f.primero');
  const b = PANEL.slice(i, i + 1200);
  assert.match(b, /Number\(f\.o\.entradas\) > 0/);
  assert.match(b, /✅ Terminada<\/button>'/);
  assert.match(b, /🚫 Rechazar todo<\/button>'\)/);
  // El rechazo está en la rama del ELSE, no sumado a la otra.
  assert.ok(b.indexOf('Terminada') < b.indexOf('Rechazar todo'));
  assert.match(b, /: ' <button class="btn bd bs"/);
});

test('una orden ya cerrada no se rechaza dos veces', () => {
  const i = SG.indexOf("router.post('/oc/:id/rechazar'");
  const b = SG.slice(i, i + 1400);
  assert.match(b, /if \(oc\.estado === 'anulada'\) return res\.status\(400\)/);
  assert.match(b, /Orden no encontrada/);
});

// ── UNA SOLA LIMPIEZA ──────────────────────────────────────────────────────
test('rechazar y anular hacen la MISMA limpieza, escrita una sola vez', () => {
  // Las dos cancelan las reservas en tránsito y sueltan los vencimientos impagos.
  // Copiarla sería dos lugares donde arreglar la próxima reserva que quede colgada.
  assert.equal((SG.match(/function cerrarOcSinEntrada\(/g) || []).length, 1);
  assert.match(SG, /cerrarOcSinEntrada\(db, Number\(req\.params\.id\), uid\(req\), \{ motivo \}\)/);
  assert.match(SG, /cerrarOcSinEntrada\(db, Number\(req\.params\.id\), uid\(req\), null, motivo\)/);
  // Y el anular viejo ya no tiene su propia copia.
  const i = SG.indexOf("router.post('/oc/:id/anular'");
  const b = SG.slice(i, i + 1200);
  assert.ok(!/UPDATE sg_reservas SET estado='cancelada'/.test(b), 'quedó la copia vieja');
});

test('se cancelan las reservas y se sueltan los vencimientos impagos', () => {
  const b = cuerpo(SG, 'cerrarOcSinEntrada');
  assert.match(b, /DELETE FROM sg_oc_vencimientos WHERE oc_id=\? AND pagado=0/);
  assert.match(b, /UPDATE sg_reservas SET estado='cancelada'/);
  assert.match(b, /rs\.tipo='oc_item' AND rs\.estado='activa'/);
});

// ── LOS PEDIDOS QUE SE QUEDAN SIN MERCADERÍA ───────────────────────────────
test('los pedidos afectados se avisan en pantalla, no en el log', () => {
  // Contaban con esta mercadería y su reserva se canceló. Dejarlo en el log del
  // servidor es no avisarle a nadie.
  const b = cuerpo(SG, 'cerrarOcSinEntrada');
  assert.match(b, /SELECT DISTINCT pe\.numero FROM sg_reservas rs/);
  const f = cuerpo(PANEL, 'sgOcRechazar');
  assert.match(f, /r\.data && r\.data\.pedidos_afectados/);
  assert.match(f, /su reserva se canceló/);
  assert.match(f, /alert\(/, 'con un toast que se va solo no alcanza');
});

// ── SE VE QUE FUE UN RECHAZO ───────────────────────────────────────────────
test('la lista distingue rechazada de anulada', () => {
  // Las dos quedan en el mismo estado, pero son hechos distintos y el que mira la
  // lista tiene que poder separarlos.
  assert.match(PANEL, /o\.rechazado_en \? \['ber', 'Rechazada'\] : \['ber', 'Anulada'\]/);
});

test('el botón manda SÓLO el id', () => {
  // Meter la partida y el proveedor serializados adentro de un atributo HTML es
  // frágil por diseño: una comilla en una razón social rompe el atributo y el
  // botón deja de responder, sin ningún error visible.
  assert.match(PANEL, /onclick="sgOcRechazar\(' \+ f\.o\.id \+ '\)"/);
  const f = cuerpo(PANEL, 'sgOcRechazar');
  assert.match(f, /\(SG\._pendFilas \|\| \[\]\)\.filter/);
});
