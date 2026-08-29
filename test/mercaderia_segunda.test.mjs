// ══ MERCADERÍA DE SEGUNDA ══════════════════════════════════════════════════
//
// Pablo, 28/8/2026: «los compradores, dentro del stock, pueden asignar bultos de
// una partida y marcarlos como mercadería de segunda. Entraron 100 bultos, se
// vendieron 70, quedan 30; de esos 30 el comprador marca 15 —o el número que
// sea, siempre sin pasarse del stock— asumiendo que el precio va a ser más bajo
// y que la rentabilidad cae. Pero siempre sabiendo que queda registrado en la
// partida».
//
// El riesgo de esto no es que no ande: es que la partida deje de cerrar contra
// el proveedor, o que al lote de segunda le quede un costo distinto y entonces
// el margen mienta justo donde Pablo quiere mirarlo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const DBSG = fs.readFileSync(path.join(RAIZ, 'src/servicios/db_sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// ── LA CUENTA, CORRIDA CONTRA UNA BASE ─────────────────────────────────────
//
// Es la aritmética real del reparto, sobre SQLite. Acá es donde se ve si la
// partida sigue cerrando y si el costo por kilo se mantiene.
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_lotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, codigo_lote TEXT, recepcion_id INTEGER,
      oc_item_id INTEGER, producto_id INTEGER, kg_reales REAL DEFAULT 0,
      precio_unitario_kg REAL, costo_base REAL DEFAULT 0, calidad TEXT, calibre TEXT,
      origen TEXT, fecha_ingreso TEXT, fecha_vencimiento_estimada TEXT,
      estado TEXT DEFAULT 'disponible', costo_final REAL DEFAULT 0, semaforo TEXT,
      presentacion_id INTEGER, kg_por_bulto REAL, bultos INTEGER,
      reclasificado_de INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_gastos_directos_lote (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER, tipo_gasto TEXT,
      proveedor_id_gasto INTEGER, monto REAL DEFAULT 0, fecha TEXT,
      observaciones TEXT, activo INTEGER DEFAULT 1, creado_por INTEGER);
    CREATE TABLE sg_lote_reclasificaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lote_origen_id INTEGER, lote_destino_id INTEGER,
      bultos INTEGER, kg REAL, costo_movido REAL DEFAULT 0, calidad_anterior TEXT,
      calidad_nueva TEXT, motivo TEXT, piso_id INTEGER, usuario_id INTEGER,
      creado_en TEXT, anulada_en TEXT, anulada_por INTEGER, motivo_anulacion TEXT);
  `);
  // 100 cajones de 9 kg = 900 kg, a $2.000/kg → costo base 1.800.000.
  db.prepare(`INSERT INTO sg_lotes (codigo_lote, recepcion_id, oc_item_id, producto_id,
    kg_reales, precio_unitario_kg, costo_base, costo_final, calidad, kg_por_bulto, bultos)
    VALUES ('SG-LT-1', 7, 3, 11, 900, 2000, 1800000, 1800000, 'primera', 9, 100)`).run();
  return db;
}

// La misma aritmética que reclasificarLote, aislada para poder correrla.
function partir(db, loteId, bultos, calidad) {
  const m = db.prepare('SELECT * FROM sg_lotes WHERE id=?').get(loteId);
  const kpb = m.bultos > 0 && m.kg_reales > 0
    ? Math.round((m.kg_reales / m.bultos) * 1e6) / 1e6 : (m.kg_por_bulto || 0);
  const kgMov = Math.round(bultos * kpb * 1e4) / 1e4;
  const propor = kgMov / m.kg_reales;
  const baseMov = Math.round(m.costo_base * propor * 100) / 100;
  const baseQueda = Math.round((m.costo_base - baseMov) * 100) / 100;
  const info = db.prepare(`INSERT INTO sg_lotes (codigo_lote, recepcion_id, oc_item_id,
    producto_id, kg_reales, precio_unitario_kg, costo_base, costo_final, calidad,
    kg_por_bulto, bultos, reclasificado_de)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'SG-LT-' + (bultos + 100), m.recepcion_id, m.oc_item_id, m.producto_id, kgMov,
    m.precio_unitario_kg, baseMov, baseMov, calidad, kpb, bultos, m.id);
  db.prepare('UPDATE sg_lotes SET kg_reales=?, bultos=?, costo_base=?, costo_final=? WHERE id=?')
    .run(Math.round((m.kg_reales - kgMov) * 1e4) / 1e4, m.bultos - bultos,
         baseQueda, baseQueda, m.id);
  const gastos = db.prepare('SELECT * FROM sg_gastos_directos_lote WHERE lote_id=? AND activo=1').all(m.id);
  for (const g of gastos) {
    const mov = Math.round(g.monto * propor * 100) / 100;
    if (!(mov > 0)) continue;
    db.prepare('UPDATE sg_gastos_directos_lote SET monto=? WHERE id=?')
      .run(Math.round((g.monto - mov) * 100) / 100, g.id);
    db.prepare(`INSERT INTO sg_gastos_directos_lote (lote_id, tipo_gasto, monto) VALUES (?,?,?)`)
      .run(info.lastInsertRowid, g.tipo_gasto, mov);
  }
  db.prepare(`INSERT INTO sg_lote_reclasificaciones (lote_origen_id, lote_destino_id,
    bultos, kg, costo_movido, calidad_anterior, calidad_nueva, motivo)
    VALUES (?,?,?,?,?,?,?,?)`).run(m.id, info.lastInsertRowid, bultos, kgMov, baseMov,
    m.calidad, calidad, 'se pusieron viejos');
  return Number(info.lastInsertRowid);
}

const costoKg = (db, id) => {
  const l = db.prepare('SELECT * FROM sg_lotes WHERE id=?').get(id);
  const gd = db.prepare('SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_directos_lote WHERE lote_id=? AND activo=1').get(id).s;
  return Math.round(((l.costo_final + gd) / l.kg_reales) * 1e4) / 1e4;
};

// ══ LA PARTIDA SIGUE CERRANDO ══════════════════════════════════════════════

test('el ejemplo de Pablo: 100 entran, 15 pasan a segunda, la partida sigue en 100', () => {
  const db = base();
  const hijo = partir(db, 1, 15, 'segunda');
  const madre = db.prepare('SELECT * FROM sg_lotes WHERE id=1').get();
  const seg = db.prepare('SELECT * FROM sg_lotes WHERE id=?').get(hijo);
  assert.equal(madre.bultos, 85);
  assert.equal(seg.bultos, 15);
  // ESTO es lo que no se puede romper: sumado por ítem de la orden, la partida
  // sigue diciendo lo que entró. Si diera 115, se le pagaría de más al productor.
  const tot = db.prepare('SELECT SUM(bultos) b, SUM(kg_reales) k FROM sg_lotes WHERE oc_item_id=3 AND activo=1').get();
  assert.equal(tot.b, 100);
  assert.equal(Math.round(tot.k), 900);
});

test('y el hermano NO se cae de la partida', () => {
  // Los lotes de reproceso nacen con recepcion_id y oc_item_id en NULL, y eso
  // los saca de la liquidación al productor y del avance: la partida no se
  // podría liquidar nunca. Acá los dos se heredan.
  const db = base();
  const hijo = partir(db, 1, 15, 'segunda');
  const seg = db.prepare('SELECT * FROM sg_lotes WHERE id=?').get(hijo);
  assert.equal(seg.oc_item_id, 3);
  assert.equal(seg.recepcion_id, 7);
  assert.equal(seg.reclasificado_de, 1);
  // Y el código lo dice: hereda, no pone NULL como crearLoteHijo.
  const i = SG.indexOf('function reclasificarLote(');
  const b = SG.slice(i, i + 4200);
  assert.match(b, /madre\.recepcion_id, madre\.oc_item_id, madre\.producto_id/);
  assert.ok(!/VALUES \(\?, NULL, NULL,/.test(b), 'se coló el NULL de los lotes de reproceso');
});

// ══ EL COSTO NO CAMBIA — EL TEST DEL PEDIDO ════════════════════════════════

test('el costo por kilo es EL MISMO en los dos, al centavo', () => {
  // Un cajón de segunda costó lo mismo que uno de primera. Lo que baja es el
  // precio de venta, y por eso cae la rentabilidad. Inventarle un costo más
  // barato taparía justamente lo que Pablo quiere ver.
  const db = base();
  const antes = costoKg(db, 1);
  const hijo = partir(db, 1, 15, 'segunda');
  assert.equal(costoKg(db, 1), antes);
  assert.equal(costoKg(db, hijo), antes);
  assert.equal(antes, 2000);
});

test('y el costo TOTAL se conserva: no se duplica ni se pierde', () => {
  const db = base();
  const hijo = partir(db, 1, 15, 'segunda');
  const suma = db.prepare('SELECT SUM(costo_final) s FROM sg_lotes WHERE activo=1').get().s;
  assert.equal(Math.round(suma * 100) / 100, 1800000);
  assert.ok(hijo > 1);
});

test('con gastos directos encima, el costo/kg sigue igual', () => {
  // Los gastos directos del lote son lo único del costo que NO se reparte solo:
  // hay que partir cada fila. Si se omite, el lote de segunda queda más barato
  // por kilo y se rompe la promesa. Éste es el test que lo clava.
  const db = base();
  db.prepare("INSERT INTO sg_gastos_directos_lote (lote_id, tipo_gasto, monto) VALUES (1,'acondicionamiento',90000)").run();
  const antes = costoKg(db, 1);
  assert.equal(antes, 2100);   // (1.800.000 + 90.000) / 900
  const hijo = partir(db, 1, 15, 'segunda');
  assert.equal(costoKg(db, 1), 2100);
  assert.equal(costoKg(db, hijo), 2100);
  // Y el gasto no se duplicó.
  const g = db.prepare('SELECT COALESCE(SUM(monto),0) s FROM sg_gastos_directos_lote WHERE activo=1').get().s;
  assert.equal(Math.round(g * 100) / 100, 90000);
});

test('el redondeo lo absorbe la madre, no el hermano', () => {
  // Si el hermano se quedara con el resto, dos reclasificaciones seguidas irían
  // corriendo el costo de a un centavo.
  const i = SG.indexOf('function reclasificarLote(');
  const b = SG.slice(i, i + 4200);
  assert.match(b, /const baseQueda = Math\.round\(\(baseOrig - baseMov\) \* 100\) \/ 100;/);
  assert.match(b, /La madre absorbe el redondeo/);
});

test('el reparto es proporcional a los KILOS, no a los bultos', () => {
  // Los bultos pueden no ser todos iguales; los kilos son la base del costo.
  const i = SG.indexOf('function reclasificarLote(');
  const b = SG.slice(i, i + 4200);
  assert.match(b, /const propor = kgMov \/ kgOrig;/);
  assert.match(b, /const baseMov = Math\.round\(baseOrig \* propor \* 100\) \/ 100;/);
});

// ══ EL LÍMITE ══════════════════════════════════════════════════════════════

test('no se puede pasar más de lo que hay en stock', () => {
  // «Siempre sin pasarse del stock». Se valida contra bultosDisponibles, que ya
  // descuenta lo despachado, lo decomisado y lo transformado — el mismo número
  // que valida el reproceso.
  const i = SG.indexOf("router.post('/lotes/:id/reclasificar'");
  assert.ok(i > 0, 'no existe el endpoint');
  const b = SG.slice(i, i + 9600);
  assert.match(b, /const disp = bultosDisponibles\(db, madre\.id\);/);
  assert.match(b, /if \(bultos > disp\)/);
  assert.match(b, /Lo que ya se despachó salió como estaba y eso no se reescribe/);
});

test('cajones enteros, y al menos uno', () => {
  const i = SG.indexOf("router.post('/lotes/:id/reclasificar'");
  const b = SG.slice(i, i + 9600);
  assert.match(b, /Math\.round\(bultos\) !== bultos/);
  assert.match(b, /bultos <= 0/);
});

test('el granel no se separa por cajón: va a reproceso', () => {
  const i = SG.indexOf("router.post('/lotes/:id/reclasificar'");
  const b = SG.slice(i, i + 9600);
  assert.match(b, /if \(madre\.bultos == null\)/);
  assert.match(b, /Para separar mercadería a granel usá un reproceso/);
});

test('sin precio cerrado no se parte: los dos lotes quedarían a costo cero', () => {
  const i = SG.indexOf("router.post('/lotes/:id/reclasificar'");
  const b = SG.slice(i, i + 9600);
  assert.match(b, /if \(madre\.precio_unitario_kg == null\)/);
  assert.match(b, /Cerrale el precio primero/);
});

test('el motivo es obligatorio', () => {
  // Es lo que después explica el precio más bajo: sin él, a los dos meses hay
  // una partida de segunda y nadie sabe qué le pasó.
  const i = SG.indexOf("router.post('/lotes/:id/reclasificar'");
  const b = SG.slice(i, i + 9600);
  assert.match(b, /motivo\.length < 3/);
  assert.match(b, /queda registrado en la partida/);
});

test('pasarlo a la calidad que ya tiene rebota', () => {
  const i = SG.indexOf("router.post('/lotes/:id/reclasificar'");
  const b = SG.slice(i, i + 9600);
  assert.match(b, /ya son de ' \+ calidad \+ ': separarlos no cambiaría nada/);
});

test('si se marcan TODOS y no salió nada, no se parte: se re-etiqueta', () => {
  // Crear un lote nuevo dejaría la madre en cero, fantasma en la lista y sin
  // nada adentro.
  const i = SG.indexOf("router.post('/lotes/:id/reclasificar'");
  const b = SG.slice(i, i + 9600);
  assert.match(b, /if \(bultos === disp && !salio\)/);
  assert.match(b, /UPDATE sg_lotes SET calidad=\?/);
  // Pero si YA salió algo, se parte igual: esos 70 salieron como primera.
  assert.match(b, /const salio = kgDespachados\(db, madre\.id\) > 0\.01/);
});

// ══ DESHACER ═══════════════════════════════════════════════════════════════

test('se puede deshacer, y la palabra «anular» en la URL pide el nivel', () => {
  // Es lo primero que van a necesitar: se marcó de más o la partida equivocada.
  const i = SG.indexOf("router.post('/lotes/:id/reclasificaciones/:rid/anular'");
  assert.ok(i > 0, 'no existe el endpoint de deshacer');
  const b = SG.slice(i, i + 9600);
  assert.match(b, /motivo\.length < 3/);
  assert.match(b, /UPDATE sg_lote_reclasificaciones SET anulada_en=/);
  // La fila NO se borra: se sella.
  assert.ok(!/DELETE FROM sg_lote_reclasificaciones/.test(SG), 'se borra el registro');
  assert.match(b, /La fila NO se borra: se sella/);
});

test('pero no si de esos bultos ya salió mercadería', () => {
  const i = SG.indexOf("router.post('/lotes/:id/reclasificaciones/:rid/anular'");
  const b = SG.slice(i, i + 9600);
  assert.match(b, /const salio = kgDespachados\(db, hijo\.id\) > 0\.01/);
  assert.match(b, /su costo viajó a esa venta/);
  // Y ofrece el camino: volver a marcar lo que queda.
  assert.match(b, /Lo que queda se puede volver a/);
});

test('deshacer devuelve kilos, bultos y costo enteros', () => {
  const i = SG.indexOf("router.post('/lotes/:id/reclasificaciones/:rid/anular'");
  const b = SG.slice(i, i + 9600);
  assert.match(b, /UPDATE sg_lotes SET kg_reales=\?, bultos=\?, costo_base=\?/);
  assert.match(b, /UPDATE sg_lotes SET activo=0, eliminado_en=/);
});

test('la vuelta, corriéndola', () => {
  const db = base();
  const antesKg = db.prepare('SELECT kg_reales k, bultos b, costo_base c FROM sg_lotes WHERE id=1').get();
  const hijo = partir(db, 1, 15, 'segunda');
  const h = db.prepare('SELECT * FROM sg_lotes WHERE id=?').get(hijo);
  const m = db.prepare('SELECT * FROM sg_lotes WHERE id=1').get();
  // Deshacer = sumar de vuelta.
  db.prepare('UPDATE sg_lotes SET kg_reales=?, bultos=?, costo_base=? WHERE id=1').run(
    Math.round((m.kg_reales + h.kg_reales) * 1e4) / 1e4, m.bultos + h.bultos,
    Math.round((m.costo_base + h.costo_base) * 100) / 100);
  db.prepare('UPDATE sg_lotes SET activo=0 WHERE id=?').run(hijo);
  const fin = db.prepare('SELECT kg_reales k, bultos b, costo_base c FROM sg_lotes WHERE id=1').get();
  assert.equal(fin.b, antesKg.b);
  assert.equal(Math.round(fin.k * 100) / 100, Math.round(antesKg.k * 100) / 100);
  assert.equal(Math.round(fin.c * 100) / 100, Math.round(antesKg.c * 100) / 100);
});

// ══ QUEDA REGISTRADO ═══════════════════════════════════════════════════════

test('la tabla de registro NO es un contador', () => {
  // Ningún cálculo de stock ni de costo la lee: lo que se movió ya está
  // descontado en kg_reales y bultos. Si además fuera contador, alcanzaría con
  // que un sumador se olvidara de restarla para tener stock que no existe.
  assert.match(DBSG, /CREATE TABLE IF NOT EXISTS sg_lote_reclasificaciones/);
  assert.match(DBSG, /El REGISTRO, QUE NO ES UN CONTADOR|EL REGISTRO, QUE NO ES UN CONTADOR/);
  // No aparece en ninguna de las fórmulas de disponible.
  const i = SG.indexOf('const KG_DISPONIBLE');
  assert.ok(!/reclasificaciones/.test(SG.slice(i - 900, i + 300)));
});

test('el movimiento de la partida dice a dónde fueron los bultos', () => {
  // Un movimiento que dice que la mercadería se fue y no a dónde no sirve.
  const i = SG.indexOf("router.get('/lotes/:id/movimientos'");
  const b = SG.slice(i, i + 4200);
  assert.match(b, /tipo: 'reclasificacion'/);
  assert.match(b, /ref: rc\.destino_codigo \|\| null/);
  assert.match(b, /detalle: 'Pasados a ' \+ rc\.calidad_nueva/);
});

test('y el ALTA dice los kilos que entraron DE VERDAD, o el saldo no cierra', () => {
  // A la madre se le bajaron los kg_reales al separarle los cajones. Si el alta
  // dijera el saldo de hoy, el listado no cuadraría y parecería que entró menos.
  const i = SG.indexOf("router.get('/lotes/:id/movimientos'");
  const b = SG.slice(i, i + 4200);
  assert.match(b, /kg: Math\.round\(\(\(Number\(lote\.kg_reales\) \|\| 0\) \+ salioPorCalidad\) \* 1e4\) \/ 1e4/);
  // Y en el lote de segunda, el alta dice de dónde vino.
  assert.match(b, /Reclasificada desde/);
});

test('la trazabilidad muestra de dónde vino y qué se fue', () => {
  const i = SG.indexOf("router.get('/lotes/:id/trazabilidad'");
  const b = SG.slice(i, i + 4600);
  assert.match(b, /reclasificaciones/);
  assert.match(b, /reclasificado_de: vino/);
  assert.match(PANEL, /🏷️ <b>Viene de:<\/b>/);
});

test('el que pone el PRECIO ve que es de segunda', () => {
  // Es el momento en que se tipea el número. Sin esto, separar los bultos no
  // sirve para lo que se pidió — que se vendan más baratos.
  const i = PANEL.indexOf("+'<span style=\"font-size:12px\"><code>'+esc(l.codigo_lote)+'</code>'");
  assert.ok(i > 0, 'no está el renglón del selector de mercadería');
  const b = PANEL.slice(i, i + 900);
  assert.match(b, /l\.calidad !== 'primera'\) \? ' ' \+ sgCalidadBadge\(l\.calidad\)/);
  // Y el dato ya viajaba: /oferta lo manda desde antes.
  assert.match(SG, /SELECT l\.id AS lote_id, l\.codigo_lote, l\.producto_id, pr\.nombre AS producto_nombre, l\.calidad/);
});

test('los mensajes hablan como Pablo: separar y deshacer, no «reclasificar»', () => {
  // Pablo dijo «marcar». La palabra técnica quedó en los nombres del código, no
  // en lo que lee el que trabaja.
  assert.match(SG, /Esta partida se separó por calidad/);
  assert.match(SG, /Esa separación ya se deshizo/);
  assert.match(PANEL, /Marcar mercadería de segunda/);
  assert.match(PANEL, /🏷️ Bultos pasados a otra calidad/);
  assert.match(PANEL, /DESHACER la separación por calidad/);
  // La palabra técnica queda en los nombres del código y en la URL —donde no la
  // lee nadie—, no en los carteles.
  assert.ok(!/>Reclasificar</.test(PANEL));
  assert.ok(!/Reclasificación a /.test(PANEL));
});

test('el stock muestra la calidad en color y de qué partida salió', () => {
  assert.match(PANEL, /function sgCalidadBadge\(c\)\{/);
  assert.match(PANEL, /c === 'segunda'/);
  assert.match(PANEL, /l\.reclasificado_de_codigo/);
  assert.match(SG, /mad\.codigo_lote AS reclasificado_de_codigo/);
  assert.match(SG, /AS bultos_reclasificados/);
  assert.match(PANEL, /cj a otra calidad/);
});

// ══ LO QUE SE PROTEGE ══════════════════════════════════════════════════════

test('a una partida partida por calidad no se le corrigen las CANTIDADES', () => {
  // Bajarle los kilos a la madre después descuadraría la partida contra el
  // proveedor: la suma de los dos lotes dejaría de dar lo que entró.
  //
  // El PRECIO sí, y es justamente el caso que trajo Pablo el 29/8/2026: la
  // mercadería de segunda es la que se renegocia con el productor.
  const i = SG.indexOf('function frenosDeEdicionLote(');
  const b = SG.slice(i, i + 6200);
  assert.match(b, /FROM sg_lote_reclasificaciones\s*\n?\s*WHERE \(lote_origen_id=\? OR lote_destino_id=\?\) AND anulada_en IS NULL/);
  assert.match(b, /Deshacé esa separación antes de corregir las cantidades/);
  assert.match(b, /if \(reclas > 0 && !soloPrecio\) \{/);
});

test('NO es admin: es el trabajo del día del comprador', () => {
  const i = SG.indexOf("router.post('/lotes/:id/reclasificar'");
  const b = SG.slice(i - 900, i + 200);
  assert.match(b, /requireAuth/);
  assert.ok(!/requireAdmin, express\.json\(\), \(req, res\) => \{[\s\S]{0,80}reclasificar/.test(SG));
  assert.match(b, /NO ES ADMIN/);
});

test('crearLoteHijo y crearLoteTransformado NO se tocaron', () => {
  // Son del circuito de reprocesos: ahí el NULL en recepcion_id es correcto,
  // porque un lote reprocesado dejó de ser lo que se compró.
  assert.match(SG, /function crearLoteHijo\(db, \{ madre, reprocesoId/);
  assert.match(SG, /function crearLoteTransformado\(db, \{ origen, productoDestinoId/);
  const i = SG.indexOf('function crearLoteHijo(');
  assert.match(SG.slice(i, i + 1500), /VALUES \(\?, NULL, NULL,/);
});

// ══ LA PANTALLA ════════════════════════════════════════════════════════════

test('el preview dice que el costo NO cambia, antes de confirmar', () => {
  // Sin esta frase alguien va a pedir que el costo de la segunda baje, y ahí se
  // pierde justamente lo que Pablo quiere ver.
  const i = PANEL.indexOf('function sgReclasPreview(){');
  assert.ok(i > 0, 'no existe el preview');
  const b = PANEL.slice(i, i + 1600);
  assert.match(b, /en las dos — <b>el mismo<\/b>/);
  assert.match(b, /Lo que baja es el precio de venta, y por eso cae la rentabilidad/);
});

test('la pantalla frena antes de mandar, y el tope es el disponible', () => {
  const i = PANEL.indexOf('function sgReclasGuardar(){');
  const b = PANEL.slice(i, i + 1200);
  assert.match(b, /n > SG\.reclas\.disp/);
  assert.match(b, /motivo\.length < 3/);
  assert.match(b, /piso_id: piso \? piso\.value : null/);
});

test('el piso se pregunta SÓLO si la partida está repartida', () => {
  // Elegirlo cuando hay uno solo es una pregunta con una sola respuesta posible.
  assert.match(PANEL, /Number\(l\.n_pisos\) > 1/);
  assert.match(SG, /AS n_pisos/);
});

test('el botón no aparece si no hay cajones en stock', () => {
  assert.match(PANEL, /if \(l\.bultos != null && Number\(l\.bultos_disponibles\) > 0\)/);
});

test('deshacer se le ofrece sólo a quien puede', () => {
  assert.match(PANEL, /lnbPuedeAnular\(\['sg-stock','sg-compras'\]\)[\s\S]{0,120}sgReclasAnular/);
  assert.match(PANEL, /function sgReclasAnular\(loteId, rid\)\{/);
});

test('NINGUNA BARRA DE DESPLAZAMIENTO LATERAL en el stock', () => {
  // Esta tabla nunca tuvo el patrón: heredaba overflow-x:auto y ninguna celda
  // truncaba. Con diez columnas ya sacaba barra.
  assert.match(PANEL, /#sg-stock-wrap \{ overflow-x:hidden !important \}/);
  assert.match(PANEL, /#sg-stock-wrap \.pa-tbl \{ width:100%; table-layout:fixed \}/);
  assert.match(PANEL, /<div class="ab-table-wrap" id="sg-stock-wrap">/);
  assert.match(PANEL, /@media\(max-width:900px\)\{ #sg-stock-wrap \{ overflow-x:auto !important \}/);
});

test('los diez anchos del stock suman 100', () => {
  const i = PANEL.indexOf('<thead><tr><th style="width:4%;text-align:center" title="Semáforo">');
  assert.ok(i > 0);
  const th = PANEL.slice(i, PANEL.indexOf('</tr></thead>', i));
  assert.equal((th.match(/<th[ >]/g) || []).length, 10);
  const suma = (th.match(/width:(\d+)%/g) || []).reduce((a, w) => a + Number(w.match(/\d+/)[0]), 0);
  assert.equal(suma, 100);
});

// ══ EL NÚMERO DEL LOTE DE SEGUNDA ══════════════════════════════════════════

test('el lote de segunda se numera como la partida, no con un SG-LT suelto', () => {
  // Pablo, 29/8/2026: «al número de partida que vamos a asignar como segunda lo
  // vamos a renombrar con el mismo número que tiene la partida madre, pero en el
  // último dígito ponemos el siguiente».
  //
  // Salía SG-LT-20260829-0001, que no dice de dónde vino: en la lista de stock
  // quedaba al lado de su madre sin ninguna relación visible.
  const i = SG.indexOf('function reclasificarLote(');
  const b = SG.slice(i, i + 4200);
  assert.match(b, /const codigo = codigoLoteDePartida\(db, madre\.oc_item_id\);/);
  assert.ok(!/const codigo = nextNumero\(db, 'SG-LT', 'sg_lotes', 'codigo_lote'\);/.test(b),
    'volvió el número suelto');
});

test('y es la MISMA función que numera los lotes de una recepción', () => {
  // Dos formas de numerar lo mismo terminan chocando: el hermano se numera como
  // cualquier otro lote de la partida.
  assert.match(SG, /function codigoLoteDePartida\(db, ocItemId\) \{/);
  assert.match(SG, /const codigo = codigoLoteDePartida\(db, ocItem\.id\);/);
});

test('la numeración, corriéndola', () => {
  // Es la cuenta real: el dígito que sigue al último lote de esa partida, y
  // buscando hasta encontrar uno libre porque codigo_lote es UNIQUE.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, codigo_lote TEXT UNIQUE, oc_item_id INTEGER);
           CREATE TABLE sg_oc_items (id INTEGER PRIMARY KEY, oc_id INTEGER);
           CREATE TABLE sg_oc (id INTEGER PRIMARY KEY, trazabilidad TEXT)`);
  db.prepare("INSERT INTO sg_oc VALUES (7,'0015.29.08.2026.01')").run();
  db.prepare('INSERT INTO sg_oc_items VALUES (3,7)').run();
  db.prepare("INSERT INTO sg_lotes VALUES (1,'0015.29.08.2026.01.1',3)").run();

  const siguiente = () => {
    const oc = db.prepare(`SELECT o.id, o.trazabilidad FROM sg_oc_items i
      JOIN sg_oc o ON o.id = i.oc_id WHERE i.id = ?`).get(3);
    const usados = db.prepare(`SELECT COUNT(*) c FROM sg_lotes l
      JOIN sg_oc_items i ON i.id = l.oc_item_id WHERE i.oc_id = ?`).get(oc.id).c;
    for (let n = usados + 1; n <= usados + 50; n++) {
      const c = `${oc.trazabilidad}.${n}`;
      if (!db.prepare('SELECT 1 FROM sg_lotes WHERE codigo_lote = ?').get(c)) return c;
    }
    return null;
  };
  // El de la foto: la madre es .1, la segunda es .2.
  assert.equal(siguiente(), '0015.29.08.2026.01.2');
  db.prepare("INSERT INTO sg_lotes VALUES (2,'0015.29.08.2026.01.2',3)").run();
  // Y si se parte otra vez, .3 — no vuelve al .2 aunque el .2 se haya dado de baja.
  assert.equal(siguiente(), '0015.29.08.2026.01.3');
});

test('el número de la partida NO se toca: la segunda cuelga de la misma compra', () => {
  // Subir el .01 a .02 habría chocado con la segunda compra a ese proveedor ese
  // mismo día — que es lo que numera ese tramo.
  assert.match(SG, /El código es PPPP\.DD\.MM\.AAAA\.XX — la secuencia es el último tramo/);
  const i = SG.indexOf('function reclasificarLote(');
  const b = SG.slice(i, i + 4200);
  assert.ok(!/codigoTrazabilidad\(/.test(b), 'se está pidiendo un número de partida nuevo');
});

test('sin orden de compra cae en el número de siempre', () => {
  // Una partida que no viene de ninguna compra no tiene de qué colgar.
  const i = SG.indexOf('function codigoLoteDePartida(');
  const b = SG.slice(i, i + 900);
  assert.match(b, /if \(!ocItemId\) return nextNumero\(db, 'SG-LT', 'sg_lotes', 'codigo_lote'\);/);
});
