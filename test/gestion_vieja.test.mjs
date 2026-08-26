// ══ EL DIAGNÓSTICO DE LA VENTA DE GESTIÓN VIEJA ════════════════════════
//
// Se emiten ventas con la CUENTA VIEJA —la que restaba dos precios ya pasados a
// neto— contra una base de prueba, y se comprueba que el diagnóstico:
//   · las encuentra y dice por cuánto,
//   · NO propone corregir las que ya estaban bien,
//   · marca "a mano" las que no se pueden reconstruir, en vez de inventar un número.
//
// La cuenta vieja se escribe acá una sola vez, tal como estaba en el código, y de
// ella salen los datos de prueba: si el diagnóstico no la reconoce, falla.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { diagnosticoGestion, gestionCorrecta, modoDeLinea, esFiscalReal } from '../src/servicios/sg_gestion_vieja.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// La cuenta VIEJA, literal (main:src/rutas/sg.js, antes del #879).
function comoEraAntes({ kg, precioBruto, precioLista, alicuota, incluyeIva }) {
  const precioNeto = incluyeIva ? +(precioBruto / (1 + alicuota / 100)).toFixed(4) : precioBruto;
  const neto = r2(kg * precioNeto);
  const listaR2 = precioLista != null ? r2(precioLista) : null;
  const brutoR2 = r2(precioBruto);
  const listaBruto = (listaR2 != null && listaR2 > brutoR2) ? listaR2 : brutoR2;
  const listaNeto = incluyeIva ? +(listaBruto / (1 + alicuota / 100)).toFixed(4) : listaBruto;
  const gestion = r2(kg * (listaNeto - precioNeto));
  return { neto, iva: r2(neto * (alicuota / 100)), gestion: gestion > 0 ? gestion : 0 };
}

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_clientes (id INTEGER PRIMARY KEY, razon_social TEXT);
    CREATE TABLE sg_familias (id INTEGER PRIMARY KEY, iva_alicuota REAL);
    CREATE TABLE sg_productos (id INTEGER PRIMARY KEY, nombre TEXT, familia_id INTEGER, iva_alicuota REAL);
    CREATE TABLE sg_lotes (id INTEGER PRIMARY KEY, codigo_lote TEXT, oc_item_id INTEGER, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_despacho_items (id INTEGER PRIMARY KEY, lote_id INTEGER, producto_id INTEGER,
      precio_por_kg REAL, precio_lista_por_kg REAL);
    CREATE TABLE sg_ven_facturas (id INTEGER PRIMARY KEY, numero TEXT, fecha TEXT, cliente_id INTEGER,
      total REAL, estado TEXT, afip_estado TEXT, dif_gestion REAL, dif_motivo TEXT, asiento_id INTEGER,
      ambiente TEXT DEFAULT 'produccion', es_prueba INTEGER DEFAULT 0, cae TEXT DEFAULT '75000000000001');
    CREATE TABLE sg_factura_despachos (id INTEGER PRIMARY KEY, factura_id INTEGER, despacho_id INTEGER,
      despacho_item_id INTEGER, kg REAL, neto REAL, iva REAL, gestion REAL);
    INSERT INTO sg_clientes VALUES (1,'ASUNCION 4054 S.A.');
    INSERT INTO sg_familias VALUES (1, 10.5);
    INSERT INTO sg_productos VALUES (1,'Tomate',1,10.5);
  `);
  return db;
}

// Emite una venta con la cuenta vieja y devuelve lo que quedó guardado.
let seq = 0;
function emitirViejo(db, { kg, precioBruto, precioLista, alicuota = 10.5, incluyeIva = true,
                          estado = 'pendiente', afip = 'autorizado' }) {
  const n = ++seq;
  const v = comoEraAntes({ kg, precioBruto, precioLista, alicuota, incluyeIva });
  db.prepare('INSERT INTO sg_lotes VALUES (?,?,?,1)').run(n, 'LT-' + n, n);
  db.prepare('INSERT INTO sg_despacho_items VALUES (?,?,1,?,?)').run(n, n, precioBruto, precioLista);
  db.prepare(`INSERT INTO sg_ven_facturas
      (id,numero,fecha,cliente_id,total,estado,afip_estado,dif_gestion,dif_motivo,asiento_id)
      VALUES (?,?,?,1,?,?,?,?,?,NULL)`)
    .run(n, '0001-' + String(n).padStart(8, '0'), '2026-08-2' + (n % 10),
      r2(v.neto + v.iva), estado, afip, v.gestion, v.gestion > 0 ? 'ajuste_gestion' : null);
  db.prepare('INSERT INTO sg_factura_despachos VALUES (?,?,1,?,?,?,?,?)')
    .run(n, n, n, kg, v.neto, v.iva, v.gestion);
  return { id: n, ...v };
}

test('encuentra el caso real y dice por cuánto', () => {
  const db = base();
  // 45 cajas a $60.000 con IVA adentro y 30% de descuento.
  const v = emitirViejo(db, { kg: 45, precioBruto: 42000, precioLista: 60000 });
  assert.ok(v.gestion < 810000, 'la cuenta vieja tiene que haber guardado de menos');

  const d = diagnosticoGestion(db);
  const c = d.comprobantes[0];
  assert.equal(c.accion, 'corregible');
  assert.equal(c.dif_gestion_nueva, 810000, 'el número bueno son los pesos acordados');
  assert.equal(r2(c.dif_gestion + c.diferencia), 810000);
  assert.equal(d.resumen.corregibles, 1);
  assert.equal(d.resumen.diferencia_total, c.diferencia);
});

test('escalar lo viejo por (1 + alícuota) NO es un arreglo confiable', () => {
  // A veces da y a veces no: la cuenta vieja además cortaba el unitario a cuatro
  // decimales, y ese resto no vuelve multiplicando. Por eso el número bueno se
  // REHACE desde los precios del renglón en vez de estirar el guardado.
  const casos = [
    { kg: 45, precioBruto: 42000, precioLista: 60000 },
    { kg: 1184, precioBruto: 340.54, precioLista: 486.486486 },
    { kg: 259, precioBruto: 450.19, precioLista: 642.857142 },
    { kg: 3100, precioBruto: 631.77, precioLista: 902.53 },
    { kg: 9250, precioBruto: 466.9, precioLista: 667 },
  ];
  let falla = 0;
  for (const c of casos) {
    const viejo = comoEraAntes({ ...c, alicuota: 10.5, incluyeIva: true }).gestion;
    const bueno = gestionCorrecta({ kg: c.kg, precio_por_kg: c.precioBruto, precio_lista_por_kg: c.precioLista });
    if (r2(viejo * 1.105) !== bueno) falla++;
  }
  assert.ok(falla > 0,
    'si escalar diera bien en los cinco casos, el arreglo podría ser un UPDATE con '
    + 'una multiplicación — y no lo es. Si este test empieza a fallar, revisá la '
    + 'premisa antes de simplificar la corrección.');
});

test('no propone tocar lo que ya estaba bien', () => {
  const db = base();
  emitirViejo(db, { kg: 100, precioBruto: 500, precioLista: 700, incluyeIva: false });  // sin IVA: la vieja acertaba
  emitirViejo(db, { kg: 100, precioBruto: 500, precioLista: null });                    // sin descuento: cero
  emitirViejo(db, { kg: 100, precioBruto: 500, precioLista: 500 });                     // lista = facturado
  const d = diagnosticoGestion(db);
  assert.equal(d.resumen.corregibles, 0, 'ninguna de las tres quedó mal');
  assert.equal(d.resumen.ya_estaban_bien, 3);
  assert.equal(d.resumen.diferencia_total, 0);
});

test('lo que no se puede reconstruir se marca a mano, no se inventa', () => {
  const db = base();
  const v = emitirViejo(db, { kg: 100, precioBruto: 500, precioLista: 700 });
  // «Facturar remitos» deja pisar el precio: el del remito deja de ser el facturado.
  db.prepare('UPDATE sg_despacho_items SET precio_por_kg = 123.45 WHERE id=?').run(v.id);
  const d = diagnosticoGestion(db);
  assert.equal(d.comprobantes[0].accion, 'revisar_a_mano');
  assert.equal(d.comprobantes[0].dif_gestion_nueva, null, 'sin número propuesto: no se sabe');
  assert.equal(d.renglones[0].modo, 'no_reconstruible');
  assert.equal(d.resumen.corregibles, 0);
});

test('una factura con un solo renglón dudoso no propone total', () => {
  const db = base();
  const a = emitirViejo(db, { kg: 100, precioBruto: 500, precioLista: 700 });
  // Segundo renglón de la MISMA factura, con el precio pisado.
  db.prepare('INSERT INTO sg_lotes VALUES (99,?,99,1)').run('LT-99');
  db.prepare('INSERT INTO sg_despacho_items VALUES (99,99,1,999.99,700)').run();
  db.prepare('INSERT INTO sg_factura_despachos VALUES (99,?,1,99,50,1,0,0)').run(a.id);
  const d = diagnosticoGestion(db);
  assert.equal(d.comprobantes[0].accion, 'revisar_a_mano');
  assert.equal(d.comprobantes[0].dif_gestion_nueva, null,
    'sumar lo que se sabe con lo que no se sabe da un número que no es de nadie');
});

test('las que AFIP rechazó y no tienen renglones se listan aparte', () => {
  const db = base();
  db.prepare(`INSERT INTO sg_ven_facturas
    (id,numero,fecha,cliente_id,total,estado,afip_estado,dif_gestion,dif_motivo,asiento_id)
    VALUES (500,'0001-00000500','2026-08-20',1,1000,'pendiente','rechazado',733031.64,'ajuste_gestion',NULL)`).run();
  const d = diagnosticoGestion(db);
  assert.equal(d.huerfanas.length, 1);
  assert.equal(d.huerfanas[0].dif_gestion, 733031.64);
  assert.equal(d.resumen.huerfanas, 1);
});

test('avisa qué saldos van a reabrir', () => {
  const db = base();
  const v = emitirViejo(db, { kg: 45, precioBruto: 42000, precioLista: 60000, estado: 'cobrada' });
  const d = diagnosticoGestion(db);
  assert.equal(d.resumen.saldos_que_reabren, 1,
    'una factura marcada cobrada a la que le sube la deuda no aparece en ninguna pantalla de cobro');
  assert.equal(d.reabren[0].factura_id, v.id);
});

test('el diagnóstico NO escribe nada', () => {
  const db = base();
  emitirViejo(db, { kg: 45, precioBruto: 42000, precioLista: 60000 });
  const antes = db.prepare('SELECT gestion, neto, iva FROM sg_factura_despachos').all();
  const antesF = db.prepare('SELECT dif_gestion, dif_motivo, estado FROM sg_ven_facturas').all();
  diagnosticoGestion(db);
  assert.deepEqual(db.prepare('SELECT gestion, neto, iva FROM sg_factura_despachos').all(), antes);
  assert.deepEqual(db.prepare('SELECT dif_gestion, dif_motivo, estado FROM sg_ven_facturas').all(), antesF);
});

test('la cuenta nueva es la del repo: pesos pelados, sin IVA', () => {
  assert.equal(gestionCorrecta({ kg: 45, precio_por_kg: 42000, precio_lista_por_kg: 60000 }), 810000);
  assert.equal(gestionCorrecta({ kg: 45, precio_por_kg: 42000, precio_lista_por_kg: null }), 0);
  assert.equal(gestionCorrecta({ kg: 45, precio_por_kg: 60000, precio_lista_por_kg: 60000 }), 0);
  // Y por debajo del centavo por kilo no hay acuerdo: hay redondeo.
  assert.equal(gestionCorrecta({ kg: 1000, precio_por_kg: 486.486486, precio_lista_por_kg: 486.486999 }), 0);
});

// ══ LA PLATA DE PRUEBA NO SE CUENTA CON LA DE VERDAD ═══════════════════
//
// Le pasó a Pablo en la primera corrida: "$308.438,86 registrados de menos" en
// letras grandes, y eran los 14 comprobantes de su circuito de prueba. Un número
// que asusta y no es de nadie hace ignorar el cartel la vez que sí importa.
test('separa lo fiscal de lo que salió del circuito de prueba', () => {
  const db = base();
  const real = emitirViejo(db, { kg: 45, precioBruto: 42000, precioLista: 60000 });
  const prueba = emitirViejo(db, { kg: 45, precioBruto: 42000, precioLista: 60000 });
  db.prepare("UPDATE sg_ven_facturas SET numero='MANUAL-9999-1-2-abc', afip_estado='MANUAL — sin AFIP', cae=NULL WHERE id=?").run(prueba.id);

  const d = diagnosticoGestion(db);
  assert.equal(d.resumen.corregibles, 1, 'sólo la fiscal cuenta como corregible');
  assert.equal(d.resumen.corregibles_prueba, 1);
  assert.equal(d.resumen.diferencia_total, d.comprobantes.find((c) => c.factura_id === real.id).diferencia,
    'la plata que se informa es SÓLO la de los comprobantes fiscales');
  assert.ok(d.resumen.diferencia_prueba > 0, 'y la de prueba se cuenta aparte, no se esconde');
});

test('qué es un comprobante fiscal de verdad', () => {
  const ok = { afip_estado: 'autorizado', cae: '75000000000001', ambiente: 'produccion', numero: 'AFIP-1-1-1-x', es_prueba: 0 };
  assert.equal(esFiscalReal(ok), true);
  assert.equal(esFiscalReal({ ...ok, afip_estado: 'MANUAL — sin AFIP' }), false, 'manual no le informa nada a AFIP');
  assert.equal(esFiscalReal({ ...ok, ambiente: 'homologacion' }), false, 'homologación es el AFIP de prueba');
  assert.equal(esFiscalReal({ ...ok, numero: 'AFIPH-7-1-4-x' }), false);
  assert.equal(esFiscalReal({ ...ok, es_prueba: 1 }), false);
  assert.equal(esFiscalReal({ ...ok, cae: null }), false, 'sin CAE no es fiscal');
  assert.equal(esFiscalReal({ ...ok, afip_estado: 'rechazado' }), false);
});

test('reconoce cómo se facturó cada renglón', () => {
  assert.equal(modoDeLinea({ kg: 45, neto: r2(45 * +(42000 / 1.105).toFixed(4)), precio_por_kg: 42000, alicuota: 10.5 }), 'con_iva');
  assert.equal(modoDeLinea({ kg: 45, neto: r2(45 * 42000), precio_por_kg: 42000, alicuota: 10.5 }), 'sin_iva');
  assert.equal(modoDeLinea({ kg: 45, neto: 1, precio_por_kg: 42000, alicuota: 10.5 }), 'no_reconstruible');
  assert.equal(modoDeLinea({ kg: 0, neto: 0, precio_por_kg: 0, alicuota: 10.5 }), 'no_reconstruible');
});
