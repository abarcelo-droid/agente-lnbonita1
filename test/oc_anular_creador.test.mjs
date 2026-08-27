// ══ LA ORDEN LA ANULA EL QUE LA HIZO ═══════════════════════════════════════
//
// Pablo, 27/8/2026: «una orden de compra debe poder eliminarse íntegramente, y
// debe figurar como anulada; se puede anular solamente por el usuario que la
// generó».
//
// Antes la anulaba cualquiera que tuviera nivel en sg-compras, sin decir por qué:
// un confirm('¿Anular esta OC?') y listo. Es una compra que alguien cerró con un
// productor; el que la da de baja sin haberla hecho deja al comprador explicándole
// al proveedor una decisión que no tomó.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const DBSG = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');

const endpoint = () => {
  const i = SG.indexOf("router.post('/oc/:id/anular'");
  assert.ok(i > 0, 'no existe el endpoint de anular');
  return SG.slice(i, i + 2600);
};

// ── SÓLO EL QUE LA GENERÓ ──────────────────────────────────────────────────
test('el endpoint compara contra creado_por, no sólo contra el nivel', () => {
  const b = endpoint();
  assert.match(b, /SELECT id, estado, activo, creado_por FROM sg_oc/);
  assert.match(b, /puedeAnularOc\(req, oc\)/);
  assert.match(b, /status\(403\)/);
});

test('y el 403 dice de quién es la orden', () => {
  // «No podés» a secas manda a preguntar por los pasillos quién la hizo.
  const b = endpoint();
  assert.match(b, /SELECT nombre FROM usuarios WHERE id=\?/);
  assert.match(b, /Esta orden la anula quien la generó/);
  // Y a quién pedírsela: un «no podés» a secas deja la orden abierta igual.
  assert.match(b, /Pedísela a quien la hizo, o a un administrador/);
});

test('la regla, corriéndola', () => {
  // Es la función real del router, extraída y evaluada: el riesgo de este cambio
  // no es que rebote de más, es que deje pasar a cualquiera.
  const i = SG.indexOf('function puedeAnularOc(');
  assert.ok(i > 0, 'no existe puedeAnularOc');
  const src = SG.slice(i, SG.indexOf('\nrouter.post(', i));
  // eslint-disable-next-line no-new-func
  const puede = new Function(src + '; return puedeAnularOc;')();

  const camila = { id: 7, rol: 'operador' };
  const juan   = { id: 9, rol: 'operador' };
  const admin  = { id: 1, rol: 'admin' };

  // La suya, sí.
  assert.equal(puede({ user: camila }, { creado_por: 7 }), true);
  // La de otro, NO. Éste es el test: sin el cambio, esto daba true igual.
  assert.equal(puede({ user: juan }, { creado_por: 7 }), false);
  // El administrador entra siempre, como en todo el resto del sistema: si no, una
  // orden del que se fue de la empresa no la puede cerrar nadie.
  assert.equal(puede({ user: admin }, { creado_por: 7 }), true);
  // Sin sesión, nunca.
  assert.equal(puede({ user: null }, { creado_por: 7 }), false);
});

test('las órdenes viejas, sin creado_por, no le quedan trabadas a nadie', () => {
  // creado_por se empezó a guardar después de que ya había órdenes cargadas. Ahí
  // no hay a quién reservárselo, y trabarlas para todos dejaría un pendiente que
  // nadie puede sacar.
  const i = SG.indexOf('function puedeAnularOc(');
  const src = SG.slice(i, SG.indexOf('\nrouter.post(', i));
  // eslint-disable-next-line no-new-func
  const puede = new Function(src + '; return puedeAnularOc;')();
  assert.equal(puede({ user: { id: 9, rol: 'operador' } }, { creado_por: null }), true);
});

test('el id se compara como número, no como texto', () => {
  // La cookie trae el id y la base lo devuelve INTEGER; comparar '7' === 7 con
  // === da false y le trabaría la orden a su propio dueño.
  const i = SG.indexOf('function puedeAnularOc(');
  const src = SG.slice(i, SG.indexOf('\nrouter.post(', i));
  // eslint-disable-next-line no-new-func
  const puede = new Function(src + '; return puedeAnularOc;')();
  assert.equal(puede({ user: { id: '7', rol: 'operador' } }, { creado_por: 7 }), true);
});

// ── EL MOTIVO ──────────────────────────────────────────────────────────────
test('el motivo es obligatorio', () => {
  // Todo lo que deja trabajo afuera en este repo pide por qué. Anular una orden
  // era lo único que salía con un confirm y nada más.
  const b = endpoint();
  assert.match(b, /motivo\.length < 3/);
  assert.match(b, /Escribí por qué se anula/);
});

test('y se guarda, con quién y cuándo', () => {
  assert.match(DBSG, /addCol\('sg_oc', 'anulado_en',\s+'TEXT'\)/);
  assert.match(DBSG, /addCol\('sg_oc', 'anulado_motivo',\s+'TEXT'\)/);
  assert.match(DBSG, /addCol\('sg_oc', 'anulado_por',\s+'INTEGER'\)/);
  assert.match(SG, /UPDATE sg_oc SET anulado_en=datetime\('now','localtime'\),\s*\n?\s*anulado_motivo=\?, anulado_por=\? WHERE id=\?/);
});

test('el motivo se escribe DENTRO de la transacción que cierra la orden', () => {
  // Escribirlo después dejaría, si algo falla en el medio, una orden anulada sin
  // motivo — que es exactamente lo que este cambio vino a sacar.
  const i = SG.indexOf('function cerrarOcSinEntrada(');
  const b = SG.slice(i, i + 2600);
  const tx  = b.indexOf('db.transaction(');
  const upd = b.indexOf('anulado_motivo=?');
  const fin = b.indexOf('})();');
  assert.ok(tx > 0 && upd > tx && upd < fin, 'el motivo se escribe fuera de la transacción');
  assert.match(b, /function cerrarOcSinEntrada\(db, ocId, userId, rechazo, anulMotivo\)/);
});

// ── LO QUE NO CAMBIA ───────────────────────────────────────────────────────
test('una orden con mercadería recibida sigue sin poder anularse', () => {
  // El cerrojo viejo no se aflojó: con recepciones, la orden ya pasó.
  const i = SG.indexOf('function cerrarOcSinEntrada(');
  const b = SG.slice(i, i + 900);
  assert.match(b, /SELECT COUNT\(\*\) c FROM sg_recepciones WHERE oc_id=\? AND activo=1/);
  assert.match(b, /La OC ya tiene recepciones; no se puede anular/);
});

test('anular dos veces la misma orden rebota', () => {
  assert.match(endpoint(), /Esa orden ya está anulada/);
});

// ── LA PANTALLA ────────────────────────────────────────────────────────────
test('el botón se le ofrece sólo a quien puede usarlo', () => {
  // Mostrárselo al resto es ofrecer un 403: el que lo aprieta cree que rompió algo.
  const i = PANEL.indexOf('function sgOcLaAnulo(o){');
  assert.ok(i > 0, 'no existe sgOcLaAnulo');
  const b = PANEL.slice(i, i + 400);
  assert.match(b, /lnbPuedeAnular\('sg-compras'\)/);
  assert.match(b, /u\.rol === 'admin'/);
  assert.match(b, /String\(o\.creado_por\) === String\(u\.id\)/);
  // Y el nivel sigue haciendo falta: esto se suma, no reemplaza.
  const j = PANEL.indexOf("onclick=\"sgOcAnular('+o.id+')\"");
  assert.ok(j > 0);
  assert.ok(PANEL.slice(j - 400, j).includes('sgOcLaAnulo(o)'));
});

test('la pantalla espeja la regla del servidor, corriéndola', () => {
  const i = PANEL.indexOf('function sgOcLaAnulo(o){');
  const src = PANEL.slice(i, PANEL.indexOf('\nfunction sgOcAnular(', i));
  // eslint-disable-next-line no-new-func
  const fab = new Function('lnbPuedeAnular', 'window', src + '; return sgOcLaAnulo;');
  const con = (u) => fab(() => true, { LNB_USER: u });
  assert.equal(con({ id: 7, rol: 'operador' })({ creado_por: 7 }), true);
  assert.equal(con({ id: 9, rol: 'operador' })({ creado_por: 7 }), false);
  assert.equal(con({ id: 1, rol: 'admin' })({ creado_por: 7 }), true);
  assert.equal(con({ id: 9, rol: 'operador' })({ creado_por: null }), true);
  // Y sin nivel no entra ni el dueño: el permiso del módulo sigue mandando.
  assert.equal(fab(() => false, { LNB_USER: { id: 7 } })({ creado_por: 7 }), false);
});

test('también se puede anular un BORRADOR', () => {
  // «Debe poder eliminarse íntegramente». Una orden a medio cargar que se abandona
  // se quedaba en la lista para siempre: el botón sólo salía en 'abierta'.
  const j = PANEL.indexOf("onclick=\"sgOcAnular('+o.id+')\"");
  assert.ok(j > 0);
  const b = PANEL.slice(j - 400, j);
  assert.match(b, /o\.estado==='abierta' \|\| o\.estado==='borrador'/);
});

test('la pantalla pide el motivo, no sólo el servidor', () => {
  const i = PANEL.indexOf('function sgOcAnular(id){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 1400);
  assert.match(b, /Por qué se anula/);
  assert.match(b, /String\(motivo\)\.trim\(\)\.length < 3/);
  // Cancelar el prompt no es mandar vacío.
  assert.match(b, /if \(motivo === null\) return/);
  assert.match(b, /\{ motivo: String\(motivo\)\.trim\(\) \}/);
});

test('avisa qué pedidos se quedaron sin esa mercadería', () => {
  // Anular cancela las reservas: los pedidos que contaban con esa partida se
  // enteran acá, o no se enteran.
  const i = PANEL.indexOf('function sgOcAnular(id){');
  const b = PANEL.slice(i, i + 1400);
  assert.match(b, /pedidos_afectados/);
  // Y el rebote va en cartel, no en un toast que se apaga solo: el 403 dice de
  // quién es la orden y a quién pedírsela.
  assert.match(b, /alert\(\(r && r\.error\) \|\| 'No se pudo anular'\)/);
});

test('la lista muestra POR QUÉ se cerró la orden', () => {
  // «Anulada» y nada más obliga a preguntarle al comprador qué pasó con esa compra.
  assert.match(PANEL, /o\.anulado_motivo \|\| o\.rechazado_motivo/);
  // Y sin barra de desplazamiento: el motivo es texto libre y la columna es angosta.
  const i = PANEL.indexOf('o.anulado_motivo || o.rechazado_motivo');
  assert.match(PANEL.slice(i - 200, i + 200), /text-overflow:ellipsis/);
});

// ── Y QUEDA COMO ANULADA, NO BORRADA ───────────────────────────────────────
test('la orden no se borra: cambia de estado', () => {
  // «Debe figurar como anulada». Un DELETE dejaría la trazabilidad con un agujero
  // y los pedidos apuntando a una orden que no existe.
  const i = SG.indexOf('function cerrarOcSinEntrada(');
  const b = SG.slice(i, i + 2600);
  assert.match(b, /UPDATE sg_oc SET estado='anulada'/);
  assert.ok(!/DELETE FROM sg_oc\b/.test(b), 'se coló un borrado de la orden');
});

test('y la lista la distingue de un rechazo', () => {
  assert.match(PANEL, /o\.rechazado_en \? \['ber', 'Rechazada'\] : \['ber', 'Anulada'\]/);
});

// ── LA BASE ────────────────────────────────────────────────────────────────
test('las columnas nuevas aguantan una anulación de verdad', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, estado TEXT, activo INTEGER DEFAULT 1,
    creado_por INTEGER, anulado_en TEXT, anulado_motivo TEXT, anulado_por INTEGER)`);
  db.prepare("INSERT INTO sg_oc (id, estado, creado_por) VALUES (1,'abierta',7)").run();
  db.prepare(`UPDATE sg_oc SET estado='anulada', anulado_en=datetime('now','localtime'),
    anulado_motivo=?, anulado_por=? WHERE id=?`).run('el productor no cosechó', 7, 1);
  const oc = db.prepare('SELECT * FROM sg_oc WHERE id=1').get();
  assert.equal(oc.estado, 'anulada');
  assert.equal(oc.anulado_motivo, 'el productor no cosechó');
  assert.equal(oc.anulado_por, 7);
  assert.ok(oc.anulado_en);
  // Y sigue estando: no se borró.
  assert.equal(oc.activo, 1);
});
