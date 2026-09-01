// ══ AL QUE PIDIÓ EL PAGO SE LE AVISA DE TODO ═══════════════════════════════
//
// Pablo, 1/9/2026: «por cada paso que avanza o cada novedad que tengamos sobre la
// orden de pago, avisale al que solicitó la OP».
//
// Los PASOS ya avisaban, y bien: devolución, rechazo, fecha confirmada, firma,
// cierre, edición, cancelación, y encima un aviso genérico para cualquier
// movimiento que nadie hubiera previsto. Lo que NO avisaba era el ADJUNTO — y es
// el que más le importa al que pidió el pago, porque el comprobante de la
// transferencia es el papel que él le manda al proveedor. Quedaba registrado en el
// historial y en ningún mail: para saber si ya estaba había que entrar al panel a
// mirar, que es exactamente lo que estos avisos existen para evitar.
//
// CÓMO CORRE SIN node_modules. `sp_outbox.js` importa `db_sp.js`, que abre la base
// con better-sqlite3 y no está instalado. Se copia `src/servicios` a un temporal y
// se reemplaza SÓLO ese módulo por uno equivalente sobre `node:sqlite`, que viene
// con Node 24. Lo que corre es el código del repo: el `render` de verdad y el
// `encolar` de verdad, escribiendo en una tabla sp_outbox de verdad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SP = fs.readFileSync(path.join(RAIZ, 'src/rutas/sp.js'), 'utf8');

// ── El outbox real, con la base cambiada por node:sqlite ───────────────────

let CACHE = null;
async function outboxReal() {
  if (CACHE) return CACHE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-aviso-'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/servicios'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(RAIZ, 'src/servicios', f), path.join(dir, f));
  }
  const base = path.join(dir, 'base.sqlite');
  fs.writeFileSync(path.join(dir, 'db_sp.js'),
    `import { DatabaseSync } from 'node:sqlite';\n`
    + `const db = new DatabaseSync(${JSON.stringify(base)});\n`
    + `db.exec(\`CREATE TABLE IF NOT EXISTS sp_outbox (\n`
    + `  id INTEGER PRIMARY KEY AUTOINCREMENT, solicitud_id INTEGER, evento_id INTEGER,\n`
    + `  dedup_key TEXT UNIQUE, destinatarios TEXT, asunto TEXT, cuerpo_texto TEXT,\n`
    + `  cuerpo_html TEXT, estado TEXT DEFAULT 'pendiente', intentos INTEGER DEFAULT 0,\n`
    + `  ultimo_error TEXT);\`);\n`
    + `export default db;\n`, 'utf8');
  // El mail no sale en un test: sólo interesa qué se encoló.
  fs.writeFileSync(path.join(dir, 'mail.js'),
    `export async function enviarMail(){ return { success: true }; }\n`, 'utf8');
  const mod = await import('file://' + path.join(dir, 'sp_outbox.js').replace(/\\/g, '/'));
  CACHE = { mod, db: new DatabaseSync(base) };
  return CACHE;
}

// Los textos de aviso salen del router: si alguien los cambia, corre el nuevo.
function avisoBase() {
  const i = SP.indexOf('const AVISO_BASE = {');
  assert.ok(i > 0, 'no existe AVISO_BASE');
  const fin = SP.indexOf('\n};', i) + 3;
  // eslint-disable-next-line no-new-func
  return new Function(SP.slice(i, fin) + '; return AVISO_BASE;')();
}

// ── 1 · LOS DOS AVISOS NUEVOS, ARMADOS DE VERDAD ───────────────────────────

const SOL = {
  numero: 'OP-2026-0142', proveedor: 'Semillería del Norte SRL', monto: '$ 1.480.000',
  destinatario: 'Pablo', link: 'https://panel/sp/142',
};

test('el aviso del comprobante dice QUÉ archivo y de qué tipo', async () => {
  // Sin esas dos cosas el mail dice «subieron un archivo» y hay que entrar igual a
  // ver cuál — que es justo lo que el aviso viene a evitar.
  const { mod } = await outboxReal();
  const txt = mod.render(avisoBase().adjunto.cuerpo, {
    ...SOL, actor: 'Tesorería',
    adjunto_tipo: 'Comprobante de pago', adjunto_nombre: 'transferencia-1480000.pdf' });
  assert.match(txt, /Tesorería subió un archivo/);
  assert.match(txt, /Qué es: Comprobante de pago/);
  assert.match(txt, /Archivo: transferencia-1480000\.pdf/);
  assert.match(txt, /Semillería del Norte SRL/);
  assert.match(txt, /\$ 1\.480\.000/);
  assert.match(txt, /https:\/\/panel\/sp\/142/);
});

test('y el de la baja dice qué se fue, y que se puede pedir de nuevo', async () => {
  const { mod } = await outboxReal();
  const txt = mod.render(avisoBase().adjunto_quitado.cuerpo, {
    ...SOL, actor: 'Administración',
    adjunto_tipo: 'PDF de cuenta corriente del proveedor', adjunto_nombre: 'cc-agosto.pdf' });
  assert.match(txt, /Administración sacó un archivo/);
  assert.match(txt, /Qué era: PDF de cuenta corriente del proveedor/);
  assert.match(txt, /pedile que lo vuelva a subir/);
});

test('un dato que falta sale como raya, no como "undefined"', async () => {
  // El render del repo reemplaza lo vacío por «—». Un mail que dice «Archivo:
  // undefined» es un mail que nadie vuelve a leer.
  const { mod } = await outboxReal();
  const txt = mod.render(avisoBase().adjunto.cuerpo, { ...SOL, actor: 'Tesorería' });
  assert.ok(!/undefined/.test(txt), 'se coló un undefined en el mail');
  assert.match(txt, /Archivo: —/);
});

// ── 2 · Y SE ENCOLAN, UNA SOLA VEZ ─────────────────────────────────────────

test('el aviso se encola, y el doble click no manda dos mails', async () => {
  const { mod, db } = await outboxReal();
  const clave = 'sol:142:adjunto:9001';
  db.prepare('DELETE FROM sp_outbox WHERE dedup_key=?').run(clave);
  const uno = mod.encolar({ solicitudId: 142, eventoId: 9001, dedupKey: clave,
    destinatarios: ['comprador@lnb.com'], asunto: 'Nuevo archivo', cuerpo: 'x' });
  const dos = mod.encolar({ solicitudId: 142, eventoId: 9001, dedupKey: clave,
    destinatarios: ['comprador@lnb.com'], asunto: 'Nuevo archivo', cuerpo: 'x' });
  assert.ok(uno, 'el primero se encoló');
  assert.equal(dos, null, 'el segundo no volvió a encolar');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sp_outbox WHERE dedup_key=?').get(clave).c, 1);
});

test('sin mail cargado queda el rastro de por qué no se avisó', async () => {
  // Salir en silencio deja al solicitante sin enterarse Y sin forma de saber por
  // qué. La fila descartada es lo que después lo explica.
  const { mod, db } = await outboxReal();
  const clave = 'sol:143:adjunto:9002';
  db.prepare('DELETE FROM sp_outbox WHERE dedup_key=?').run(clave);
  mod.encolar({ solicitudId: 143, eventoId: 9002, dedupKey: clave,
    destinatarios: [], asunto: 'Nuevo archivo', cuerpo: 'x' });
  const f = db.prepare('SELECT estado, ultimo_error FROM sp_outbox WHERE dedup_key=?').get(clave);
  assert.equal(f.estado, 'descartado');
  assert.match(f.ultimo_error, /sin destinatarios/);
});

// ── 3 · QUIÉN LOS DISPARA ──────────────────────────────────────────────────

test('los dos caminos del adjunto avisan', () => {
  // Subirlo y sacarlo. El segundo importa igual: si desaparece el papel que
  // respaldaba la orden, el que le da la cara al proveedor tiene que saberlo.
  const sub = SP.indexOf("router.post('/solicitudes/:id/adjuntos'");
  // Anclado al arranque del renglón: si no, un `if (0)` adelante deja el texto
  // igual y el test seguiría en verde con el aviso apagado.
  assert.match(SP.slice(sub, sub + 2600),
    /\r?\n {4}avisarSolicitanteSiNoEsEl\(req, s, 'adjunto', evId, \{/);
  const baja = SP.indexOf("router.delete('/adjuntos/:adjId'");
  assert.match(SP.slice(baja, baja + 1600),
    /\r?\n {2}avisarSolicitanteSiNoEsEl\(req, sol, 'adjunto_quitado', evId, \{/);
});

test('el id del evento se usa: sin él dos adjuntos serían el mismo aviso', () => {
  // La clave de deduplicación es `sol:<id>:<evento>:<eventoId>`. Con un eventoId
  // fijo, el segundo archivo del día no se encolaría nunca.
  const sub = SP.indexOf("router.post('/solicitudes/:id/adjuntos'");
  assert.match(SP.slice(sub, sub + 2600), /\r?\n {4}const evId = registrarEvento\(s\.id, \{/);
  const baja = SP.indexOf("router.delete('/adjuntos/:adjId'");
  assert.match(SP.slice(baja, baja + 1600), /\r?\n {2}const evId = registrarEvento\(a\.solicitud_id, \{/);
  assert.match(SP, /dedupKey: `sol:\$\{sol\.id\}:\$\{evento\}:\$\{eventoId\}`/);
});

test('el que sube el archivo no se avisa a sí mismo', () => {
  // Un mail contándole a alguien lo que acaba de hacer entrena a saltear los
  // avisos, y el que se saltea uno se saltea el que importaba. Es la misma regla
  // que ya usaban el movimiento y la cancelación.
  const i = SP.indexOf('function avisarSolicitanteSiNoEsEl(');
  assert.ok(i > 0);
  assert.match(SP.slice(i, i + 400),
    /if \(!sol \|\| req\.user\.id === sol\.solicitante_id\) return;/);
});

test('y si el aviso falla, el adjunto se guarda igual', () => {
  // En el circuito de pasos el aviso va DENTRO de la transacción a propósito. Acá
  // es al revés y también a propósito: cuando toca avisar, el archivo YA está en R2
  // y la fila YA está escrita. Un 500 acá haría que el usuario lo suba dos veces.
  const i = SP.indexOf('function avisarSolicitanteSiNoEsEl(');
  const b = SP.slice(i, i + 500);
  assert.match(b, /try \{/);
  assert.match(b, /\} catch \(e\) \{/);
  assert.match(b, /console\.error\('\[SP\] No se pudo avisar al solicitante/);
  // Y el parseo del snapshot —que es lo que puede tirar— va ADENTRO del try.
  const t = b.indexOf('try {'), c = b.indexOf('} catch');
  assert.ok(b.slice(t, c).includes('defDe(sol)'), 'defDe quedó afuera del try');
});

test('la cola se procesa después de contestar, en los dos caminos', () => {
  for (const [ruta, ancho] of [["router.post('/solicitudes/:id/adjuntos'", 2600],
                               ["router.delete('/adjuntos/:adjId'", 1600]]) {
    const i = SP.indexOf(ruta);
    assert.match(SP.slice(i, i + ancho), /procesarEnBackground\(\);/, ruta + ' no procesa la cola');
  }
});

// ── 4 · LO QUE YA ANDABA SIGUE ANDANDO ─────────────────────────────────────

test('los avisos de paso no se tocaron, y siguen siendo nueve', () => {
  // Devolución, rechazo, fecha, firma, cierre, movimiento, edición — más los dos
  // del adjunto. Si aparece un evento nuevo sin su texto de respaldo, la solicitud
  // se movería sin que el solicitante se entere: por eso se cuentan.
  const base = avisoBase();
  assert.deepEqual(Object.keys(base).sort(),
    ['adjunto', 'adjunto_quitado', 'cerrado', 'devuelto', 'editada',
     'fecha_confirmada', 'firmado', 'movimiento', 'rechazado']);
});

test('y el aviso genérico sigue siendo el piso de todo lo demás', () => {
  // Es el que cubre cualquier movimiento que nadie previó: sin él, un paso nuevo
  // del circuito nacería mudo.
  assert.match(SP, /AVISO_BASE\[evento\] \|\| AVISO_BASE\.movimiento/);
});
