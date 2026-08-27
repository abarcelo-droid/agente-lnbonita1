// ══ TRES AGUJEROS DEL CIRCUITO DE COBRO ════════════════════════════════════
//
// Aparecieron mapeando el circuito antes de rehacerlo, y los tres son de plata:
//
// 1. Cobrar con DOS cheques y después anular devolvía sólo el primero a la
//    cartera. El segundo quedaba vivo y bueno contra una cobranza que ya no
//    existe. Se ataban por un TEXTO en las notas —«Cobranza #123»— que no se
//    puede consultar, y la cabecera guarda UN solo cheque.
//
// 2. El cobro no controlaba de quién es la caja. El pago a proveedores lo hace
//    desde siempre; el cobro aceptaba cualquier cuenta que le mandaran, así que
//    se podía meter plata en la caja de otro escribiendo el número. El front
//    escondía las ajenas, pero eso es cortesía del front.
//
// 3. Un cheque que cobró la parte SIN comprobante volvía al libro fiscal al
//    depositarlo: el movimiento y el asiento salían sin ámbito. Quedaba un débito
//    de gestión en cartera que no se cancelaba nunca y un crédito fiscal que nadie
//    debía — y el arqueo fiscal del banco se llevaba plata que nunca entró al
//    libro fiscal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VEN = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');
const TES = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_tesoreria.js'), 'utf8');
const FIN = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg_finanzas.js'), 'utf8');

// ── 1 · LOS DOS CHEQUES ────────────────────────────────────────────────────
test('el cheque recuerda de qué cobranza vino, en una columna', () => {
  // La nota 'Cobranza #123' no se puede consultar: por eso la vuelta atrás sólo
  // alcanzaba al de la cabecera.
  assert.match(FIN, /addCol\('sg_fin_cheques_terceros', 'cobranza_id', 'INTEGER'\)/);
  assert.match(VEN, /cobranza_id\)\s*\r?\n\s*VALUES \(\?,\?,\?,\?,\?,\?,\?,\?,\?,\?\)/);
});

test('anular devuelve TODOS los cheques, no sólo el primero', () => {
  const i = VEN.indexOf('TODOS los cheques de esta cobranza');
  assert.ok(i > 0, 'no se arregló la anulación');
  const b = VEN.slice(i, i + 1400);
  assert.match(b, /WHERE cobranza_id=\? AND estado='en_cartera'/);
  assert.match(b, /for \(const chId of chIds\)/);
  // Y las cobranzas VIEJAS, cargadas antes de que existiera la columna, siguen
  // funcionando por el id de la cabecera.
  assert.match(b, /if \(!chIds\.length && co\.cheque_terceros_id\) chIds\.push\(co\.cheque_terceros_id\)/);
  // El depositado no se toca: la plata entró al banco.
  assert.match(b, /ch\.estado === 'en_cartera'/);
});

test('la cuenta corre contra la base, y devuelve los DOS', () => {
  // Se corre de verdad: una consulta mal escrita devuelve uno y el test de arriba
  // no lo notaría.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sg_fin_cheques_terceros (id INTEGER PRIMARY KEY, cobranza_id INTEGER,
    estado TEXT, monto REAL)`);
  const ins = db.prepare('INSERT INTO sg_fin_cheques_terceros (cobranza_id, estado, monto) VALUES (?,?,?)');
  ins.run(7, 'en_cartera', 1000);
  ins.run(7, 'en_cartera', 2000);
  ins.run(7, 'depositado', 3000);   // éste no se toca
  ins.run(8, 'en_cartera', 4000);   // de otra cobranza
  const ids = db.prepare("SELECT id FROM sg_fin_cheques_terceros WHERE cobranza_id=? AND estado='en_cartera'")
    .all(7).map((x) => x.id);
  assert.deepEqual(ids, [1, 2], 'tiene que traer los dos de la cobranza 7, y sólo ésos');
});

// ── 2 · LA CAJA TIENE DUEÑO ────────────────────────────────────────────────
test('el cobro ya controla de quién es la cuenta', () => {
  assert.match(VEN, /import \{ puedeMoverCuenta \} from '\.\/sg_tesoreria\.js'/);
  assert.match(VEN, /if \(!puedeMoverCuenta\(u, cuenta\.id\)\)/);
  assert.match(VEN, /la maneja otra persona/);
  assert.match(VEN, /res\.status\(403\)/);
});

test('el control va DESPUÉS de resolver la cuenta y ANTES de escribir', () => {
  const i = VEN.indexOf('if (!puedeMoverCuenta(u, cuenta.id))');
  const cuenta = VEN.indexOf("error: 'Elegí en qué cuenta entra la plata'");
  const tx = VEN.indexOf('db.transaction(() => {', cuenta);
  assert.ok(cuenta > 0 && i > cuenta, 'primero hay que tener la cuenta');
  assert.ok(i < tx, 'y el corte va antes de empezar a escribir');
});

test('es la MISMA regla que el pago a proveedores', () => {
  // Una sola regla en todo el sistema: si tiene gente asignada la tocan sólo
  // ellos; si no tiene a nadie, la toca cualquiera con permiso.
  const b = TES.slice(TES.indexOf('export function puedeMoverCuenta'), TES.indexOf('export function puedeMoverCuenta') + 600);
  assert.match(b, /if \(u\.rol === 'admin'\) return true/);
  assert.match(b, /if \(!n\) return true/);
  assert.equal((TES.match(/export function puedeMoverCuenta/g) || []).length, 1);
});

// ── 3 · EL CHEQUE NO CAMBIA DE LIBRO ───────────────────────────────────────
test('el cheque se lleva puesta la mitad que canceló', () => {
  assert.match(FIN, /addCol\('sg_fin_cheques_terceros', 'ambito', 'TEXT'\)/);
  assert.match(FIN, /addCol\('sg_fin_cheques_terceros', 'motivo', 'TEXT'\)/);
  assert.match(VEN, /UPDATE sg_fin_cheques_terceros SET ambito=\?, motivo=\? WHERE id=\?/);
});

test('el ámbito se escribe DESPUÉS del reparto, que es cuando se sabe', () => {
  // En el INSERT todavía no se sabe: el reparto entre las dos mitades corre más
  // abajo. Escribirlo ahí habría dejado todos los cheques en fiscal.
  const ins = VEN.indexOf('INSERT INTO sg_fin_cheques_terceros');
  const reparto = VEN.indexOf('const gesPorMedio = repartirAmbito(');
  const upd = VEN.indexOf('UPDATE sg_fin_cheques_terceros SET ambito=?');
  assert.ok(ins > 0 && reparto > ins, 'el reparto corre después del insert');
  assert.ok(upd > reparto, 'y la marca del ámbito, después del reparto');
  // El insert ya no pretende saberlo.
  const b = VEN.slice(ins - 400, ins + 600);
  assert.ok(!/ambito, motivo\)/.test(b), 'el insert volvió a escribir el ámbito que no sabe');
});

test('sólo se marca si el cheque es ENTERO de una mitad', () => {
  // Si cubre las dos, partirlo al depositarlo es otro problema; poner una de las
  // dos sería elegir por el que cobra.
  assert.match(VEN, /if \(m\._chId && partesM\.length === 1\)/);
});

test('el depósito respeta esa mitad, en el movimiento y en el asiento', () => {
  const i = TES.indexOf('EL DEPÓSITO NO CAMBIA DE LIBRO');
  assert.ok(i > 0, 'no se arregló el depósito');
  const b = TES.slice(i, i + 2600);
  assert.match(b, /const ambCh = \(c\.ambito === 'gestion'\) \? 'gestion' : 'fiscal'/);
  // Una línea de gestión sin motivo no entra al asiento.
  assert.match(b, /const motCh = ambCh === 'gestion' \? \(c\.motivo \|\| 'ajuste_gestion'\) : null/);
  assert.match(b, /usuario_id, ambito, motivo\)/);
  // Las dos líneas del asiento. El patrón tolera el salto de línea: están
  // partidas en dos renglones en el archivo.
  assert.match(b, /ambito: ambCh, motivo: motCh, descripcion: cuenta\.nombre/);
  assert.match(b, /ambito: ambCh, motivo: motCh,\s*descripcion: 'Cheques en cartera'/);
});

test('y el RECHAZO vuelve por el mismo libro por el que entró', () => {
  // Deshacerlo en el libro fiscal deja las dos mitades descuadradas —una de más y
  // otra de menos— y el asiento del rechazo parece correcto porque el total cierra.
  const i = TES.indexOf('El rechazo tiene que volver por el MISMO libro');
  assert.ok(i > 0, 'no se arregló el rechazo');
  const b = TES.slice(i, i + 2600);
  assert.match(b, /const ambR = \(c\.ambito === 'gestion'\) \? 'gestion' : 'fiscal'/);
  assert.match(b, /cuenta_id: ctaRech, debe: c\.monto, haber: 0, ambito: ambR, motivo: motR/);
  assert.match(b, /cuenta_id: contra, debe: 0, haber: c\.monto, ambito: ambR, motivo: motR/);
  // Y el egreso del banco, cuando el cheque ya estaba depositado.
  assert.match(b, /usuario_id, ambito, motivo\)/);
});

test('sin ámbito guardado, se comporta como antes: fiscal', () => {
  // Los cheques cargados antes de que existiera la columna tienen ambito NULL. No
  // pueden romper el depósito: caen en fiscal, que es lo que hacían siempre.
  const amb = (c) => (c.ambito === 'gestion') ? 'gestion' : 'fiscal';
  assert.equal(amb({ ambito: null }), 'fiscal');
  assert.equal(amb({}), 'fiscal');
  assert.equal(amb({ ambito: 'gestion' }), 'gestion');
  assert.equal(amb({ ambito: 'fiscal' }), 'fiscal');
});
