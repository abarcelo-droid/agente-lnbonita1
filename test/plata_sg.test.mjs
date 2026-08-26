// ══ LOS NÚMEROS DE PLATA DE SAN GERÓNIMO ═══════════════════════════════
//
// Cinco bugs que llegaron a producción sin que nada los frenara, y que tenían en
// común la misma forma: un número se RECALCULABA en vez de respetarse el dato de
// origen. Este archivo los deja clavados.
//
//   1. La alícuota de IVA de la factura salía de la FAMILIA y no del producto.
//   2. Al descuento de gestión se le sacaba el IVA (810.000 quedaban en 733.031).
//   3. Los cajones recibidos se recalculaban desde los kilos y se perdían cinco.
//   4. El total se reconstruía desde un precio unitario cortado a 4 decimales.
//   5. Los carteles comparaban al centavo y mostraban al peso ("diferencia $0").
//
// CÓMO CORRE SIN node_modules. better-sqlite3 no está instalado (y no compila en
// Windows), así que la base es `node:sqlite`, que viene con Node 24. Los servicios
// se copian TAL CUAL a un directorio temporal y sólo se reemplazan los que abren la
// base por un doble que no hace nada: lo que se ejecuta es el código del repo, sin
// ninguna rama "si estoy en un test". Las funciones que viven adentro de sg.js y de
// panel.html --que no se pueden importar-- se extraen POR TEXTO del fuente, así que
// si alguien las renombra el test falla en vez de pasar en falso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SG = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Saca una función del fuente contando llaves. Si no está, revienta: es la señal
// de que la renombraron y este test dejó de cubrir lo que dice cubrir.
function extraer(src, nombre) {
  const i = src.indexOf('function ' + nombre + '(');
  assert.ok(i >= 0, `no está "function ${nombre}(" — ¿se renombró? el test dejó de cubrirla`);
  // Primero se salta la LISTA DE PARÁMETROS: con un parámetro desestructurado
  // --function f({ a, b })-- la primera llave del texto es la de la firma, y contar
  // desde ahí devuelve media función que no compila.
  let p = src.indexOf('(', i), prof = 0, k = p;
  for (; k < src.length; k++) {
    if (src[k] === '(') prof++;
    else if (src[k] === ')') { prof--; if (prof === 0) break; }
  }
  k = src.indexOf('{', k); prof = 0;
  for (; k < src.length; k++) {
    if (src[k] === '{') prof++;
    else if (src[k] === '}') { prof--; if (prof === 0) break; }
  }
  const txt = src.slice(i, k + 1);
  // Y que compile: si el corte quedó mal, que falle acá y no en un assert raro.
  new Function(txt + '; return ' + nombre + ';');
  return txt;
}

// El motor de emisión real, con los módulos que abren la base reemplazados.
async function motorDeEmision() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-plata-'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'src/servicios'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(RAIZ, 'src/servicios', f), path.join(dir, f));
  }
  const doble = `const noop = { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }),
    exec: () => {}, transaction: (fn) => fn, pragma: () => [] };
  export default noop; export const getDb = () => noop; export const dbPa = noop;\n`;
  for (const s of ['db.js', 'db2.js', 'db_sg.js', 'db_sg_finanzas.js', 'db_pa.js', 'catalogo.js', 'catalogo_v2.js']) {
    if (fs.existsSync(path.join(dir, s))) fs.writeFileSync(path.join(dir, s), doble, 'utf8');
  }
  // Firma con node-forge (no instalado) y no interviene en armar el comprobante.
  fs.writeFileSync(path.join(dir, 'afip-wsaa.js'),
    "export function ambienteActual(){ return 'homologacion'; }\n"
    + "export async function autenticar(){ throw new Error('acá no se llama a AFIP'); }\n", 'utf8');
  return import('file:///' + path.join(dir, 'afip-wsfe-emision.js').replace(/\\/g, '/'));
}

function baseDePrueba() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_clientes (id INTEGER PRIMARY KEY, razon_social TEXT, cuit TEXT, categoria_fiscal TEXT);
    CREATE TABLE sg_familias (id INTEGER PRIMARY KEY, nombre TEXT, iva_alicuota REAL);
    CREATE TABLE sg_productos (id INTEGER PRIMARY KEY, nombre TEXT, familia_id INTEGER, iva_alicuota REAL);
    INSERT INTO sg_clientes VALUES (1,'ASUNCION 4054 S.A.','30712400125','resp_inscripto');
    INSERT INTO sg_familias VALUES (1,'Frutas',10.5), (2,'Sin clasificar',NULL), (3,'Otros',NULL);
    INSERT INTO sg_productos VALUES
      (1,'Tomate',1,10.5),
      (2,'Insumo 21',1,21),        -- 21% en una familia al 10,5
      (3,'Estacionado',2,10.5),    -- con alícuota, en una familia SIN alícuota
      (4,'Sin cargar',3,NULL),     -- sin alícuota en ningún lado
      (5,'Exento 0',1,0);          -- 0% es válido y no es lo mismo que sin cargar
  `);
  return db;
}

// ── 1. LA ALÍCUOTA ES LA DEL PRODUCTO ──────────────────────────────────────
test('la alícuota de la factura sale del PRODUCTO, no de la familia', async () => {
  const { construirComprobante } = await motorDeEmision();
  const db = baseDePrueba();
  const c = construirComprobante(db, { clienteId: 1, items: [{ producto_id: 2, cantidad: 100, precio: 1000 }] });
  assert.equal(c.imp_iva, 21000, 'un producto al 21% en una familia al 10,5 tiene que facturar 21');
  assert.equal(c.iva[0].Id, 5, 'y el Id que se le informa a AFIP es el del 21%');
});

test('un producto con alícuota en una familia sin alícuota NO sale exento', async () => {
  const { construirComprobante } = await motorDeEmision();
  const db = baseDePrueba();
  const c = construirComprobante(db, { clienteId: 1, items: [{ producto_id: 3, cantidad: 100, precio: 1000 }] });
  assert.equal(c.imp_iva, 10500);
  assert.equal(c.imp_opex, 0, 'nada tiene que caer en operaciones exentas');
});

test('sin alícuota en ningún lado, la emisión FRENA y dice qué producto es', async () => {
  const { construirComprobante } = await motorDeEmision();
  const db = baseDePrueba();
  assert.throws(
    () => construirComprobante(db, { clienteId: 1, items: [{ producto_id: 4, cantidad: 10, precio: 100 }] }),
    /Sin cargar.*no tiene alícuota de IVA cargada/s,
    'un dato que falta no es una exención: antes salía exento en silencio');
});

test('alícuota 0 sigue siendo válida: gravado al 0%, distinto de exento', async () => {
  const { construirComprobante } = await motorDeEmision();
  const db = baseDePrueba();
  const c = construirComprobante(db, { clienteId: 1, items: [{ producto_id: 5, cantidad: 100, precio: 1000 }] });
  assert.equal(c.iva[0].Id, 3);
  assert.equal(c.imp_neto, 100000);
  assert.equal(c.imp_opex, 0);
});

// ── 4. EL TOTAL NO SE RECONSTRUYE ──────────────────────────────────────────
//
// OJO CON CÓMO SE PRUEBA ESTO. La primera versión de este archivo le pasaba al motor
// el unitario YA corregido (neto/kg) y comprobaba que el total diera: pasaba igual
// con el código viejo, porque el bug no estaba en el motor sino en quién le arma los
// importes. Un test que pasa con y sin el arreglo no protege nada.
//
// Lo que hay que ejercitar es `importesDeLinea`, que es la cuenta que cambió. Se
// extrae por texto de sg.js porque el archivo no se puede importar (arrastra express,
// multer, xlsx y el SDK).
const importesDeLinea = new Function('r2', extraer(SG, 'importesDeLinea') + '; return importesDeLinea;')(r2);
const gestionDeLinea = new Function('r2', extraer(SG, 'gestionDeLinea') + '; return gestionDeLinea;')(r2);

// La cuenta que se sacó: unitario neto cortado a 4 decimales y todo reconstruido
// desde ahí. Está acá para que el test muestre la diferencia, no para usarla.
function comoEraAntes({ kg, precioBruto, alicuota, incluyeIva }) {
  const precioNeto = incluyeIva ? +(precioBruto / (1 + alicuota / 100)).toFixed(4) : precioBruto;
  const neto = r2(kg * precioNeto);
  return { neto, iva: r2(neto * (alicuota / 100)) };
}

test('el neto y el IVA de la línea cierran contra el bruto, y antes no', () => {
  const casos = [
    { kg: 3100, precioBruto: 900, alicuota: 10.5 },
    { kg: 1184, precioBruto: 486.486486, alicuota: 10.5 },
    { kg: 20000, precioBruto: 113.33, alicuota: 21 },
    { kg: 259, precioBruto: 4500 / 7, alicuota: 10.5 },
  ];
  let algunaCambio = false;
  for (const c of casos) {
    const { bruto, neto, iva } = importesDeLinea({ ...c, incluyeIva: true });
    assert.equal(r2(neto + iva), bruto, `neto+IVA tiene que dar el bruto en ${JSON.stringify(c)}`);
    const v = comoEraAntes(c);
    if (r2(v.neto + v.iva) !== bruto) algunaCambio = true;
  }
  assert.ok(algunaCambio, 'si la cuenta vieja también cerraba, este test no está probando el arreglo');
});

test('sin "el precio incluye IVA" el neto es el bruto y el IVA se suma', () => {
  const { bruto, neto, iva } = importesDeLinea({ kg: 100, precioBruto: 1000, alicuota: 21, incluyeIva: false });
  assert.equal(bruto, 100000);
  assert.equal(neto, 100000);
  assert.equal(iva, 21000);
});

test('el importe que manda la pantalla gana sobre kg × precio', () => {
  // Es lo que hace la facturación directa: el descuento se acuerda sobre el TOTAL
  // de la línea, así que reconstruirlo desde el precio por kilo nunca da igual.
  const { bruto } = importesDeLinea({ kg: 1184, precioBruto: 486.486486, alicuota: 10.5,
    incluyeIva: true, importeBruto: 576000 });
  assert.equal(bruto, 576000);
});

test('neto + IVA da EXACTO el bruto tipeado, también en el comprobante', async () => {
  const { construirComprobante } = await motorDeEmision();
  const db = baseDePrueba();
  const BRUTO = 2790000, ALIC = 10.5;                    // comprobante 9999-00000009
  const { neto, iva } = importesDeLinea({ kg: 3100, precioBruto: BRUTO / 3100, alicuota: ALIC, incluyeIva: true });
  const c = construirComprobante(db, { clienteId: 1, items: [{
    producto_id: 1, cantidad: 3100, precio: neto / 3100,
    alicuota: ALIC, importe_neto: neto, importe_iva: iva }] });
  assert.equal(c.imp_total, BRUTO, 'el asiento cerraba en 2.789.999,98 contra un papel que decía 2.790.000');
});

test('con varias líneas el total sigue siendo la suma de los brutos', async () => {
  const { construirComprobante } = await motorDeEmision();
  const db = baseDePrueba();
  const ALIC = 10.5;
  let suma = 0;
  const items = [[1184, 486.486486], [900, 1211.37], [2304, 733.111]].map(([kg, pk]) => {
    const { bruto, neto, iva } = importesDeLinea({ kg, precioBruto: pk, alicuota: ALIC, incluyeIva: true });
    suma = r2(suma + bruto);
    return { producto_id: 1, cantidad: kg, precio: neto / kg, alicuota: ALIC,
      importe_neto: neto, importe_iva: iva };
  });
  assert.equal(construirComprobante(db, { clienteId: 1, items }).imp_total, suma);
});

// ── 2. LO RESIGNADO NO LLEVA IVA SACADO ────────────────────────────────────
test('el descuento de gestión son los pesos acordados, sin tocarle el IVA', () => {
  // El caso real: 45 cajas a $60.000 con IVA adentro y 30% de descuento. Lo que la
  // pantalla muestra y lo que el backend guarda tienen que ser EL MISMO número.
  const sgFdMontos = new Function('paRound2Fm', 'sgFdDescDe',
    extraer(PANEL, 'sgFdMontos') + '; return sgFdMontos;')(r2, (it) => it.descuento_pct);
  const mm = sgFdMontos({ kg: 45, precio: 60000, descuento_pct: 30 });
  assert.equal(mm.facturado, 1890000, 'lo que va al libro fiscal');
  assert.equal(mm.resignado, 810000, 'lo que la empresa puso sobre la mesa');

  // Y ahora la cuenta del BACKEND, que es la que cambió, sobre los mismos datos.
  const { bruto } = importesDeLinea({ kg: 45, precioBruto: 60000, alicuota: 10.5,
    incluyeIva: true, importeBruto: mm.facturado });
  const gestion = gestionDeLinea({ kg: 45, precioBruto: 42000, precioLista: 60000,
    brutoLinea: bruto, importeLista: mm.lista });
  assert.equal(gestion, 810000, 'el backend guarda lo mismo que muestra la pantalla');
  assert.equal(r2(bruto + gestion), 2700000, 'la deuda del cliente es lo acordado');

  // La cuenta vieja --restar los dos NETOS-- guardaba menos, y de ahí salía la
  // liquidación al productor.
  const vieja = r2(45 * (+(60000 / 1.105).toFixed(4) - +(42000 / 1.105).toFixed(4)));
  assert.ok(vieja < gestion, `la cuenta vieja daba ${vieja}`);
  assert.equal(r2(gestion - vieja), r2(810000 - vieja));
});

test('sin descuento la gestión es CERO, aunque el precio tenga trece decimales', () => {
  // El reintento desde "Remitos pendientes de comprobante" no manda los importes: la
  // gestión se arma desde el precio guardado en el remito, que ahora es exacto y
  // largo. Si el facturado se armara con el precio crudo y el de lista con el
  // redondeado, aparecerían pesos de gestión que nadie acordó.
  for (const [kg, precioCajon, kpb] of [[1184, 9000, 18.5], [259, 4500, 7], [9250, 12345, 18.5]]) {
    const precio = (precioCajon / kpb);                   // el $/kg que guarda el remito
    const { bruto } = importesDeLinea({ kg, precioBruto: precio, alicuota: 10.5, incluyeIva: true });
    // Sin descuento el remito guarda precio_lista_por_kg en null (postRemito).
    assert.equal(gestionDeLinea({ kg, precioBruto: precio, precioLista: null, brutoLinea: bruto }), 0,
      `${kg} kg a ${precio} $/kg no tiene ningún descuento acordado`);
    // Y con el mismo precio de lista que el facturado, tampoco.
    assert.equal(gestionDeLinea({ kg, precioBruto: precio, precioLista: precio, brutoLinea: bruto }), 0);
  }
});

test('con descuento, la gestión es la misma se mande el importe o no', () => {
  const kg = 1184, lista = 9000 / 18.5, facturado = lista * 0.7;
  const { bruto } = importesDeLinea({ kg, precioBruto: facturado, alicuota: 10.5, incluyeIva: true });
  const conImporte = gestionDeLinea({ kg, precioBruto: facturado, precioLista: lista,
    brutoLinea: bruto, importeLista: r2(kg * lista) });
  const sinImporte = gestionDeLinea({ kg, precioBruto: facturado, precioLista: lista, brutoLinea: bruto });
  assert.equal(conImporte, sinImporte, 'la primera vuelta y el reintento tienen que dar lo mismo');
  assert.ok(conImporte > 0);
});

// ── 3. MANDA EL CONTEO ─────────────────────────────────────────────────────
const kpbEfectivo = new Function(extraer(SG, 'kpbEfectivo') + '; return kpbEfectivo;')();
const derivarBultosLote = new Function('kpbEfectivo',
  extraer(SG, 'derivarBultosLote') + '; return derivarBultosLote;')(kpbEfectivo);

test('64 cajones que pesaron 1.184 kg son 64 cajones, no 59', () => {
  assert.equal(kpbEfectivo({ bultos: 64, kg_reales: 1184, kg_por_bulto: 20 }), 18.5);
  const f = derivarBultosLote({ bultos: 64, kg_reales: 1184, kg_por_bulto: 20,
    kg_vigente: 1184, kg_disponibles: 1184 });
  assert.equal(Math.floor(f.bultos_disponibles), 64, 'el front trunca hacia abajo: se prueba lo que ve');
  assert.equal(r2(64 * f.kg_por_bulto), 1184, 'y el despacho descuenta justo lo que hay');
});

test('sin conteo se usa el factor pactado, y sin nada no se inventa uno', () => {
  assert.equal(kpbEfectivo({ bultos: null, kg_reales: 1184, kg_por_bulto: 20 }), 20);
  assert.equal(kpbEfectivo({ bultos: 0, kg_reales: 0, kg_por_bulto: null }), 0);
});

test('el redondeo del factor no puede comerse un cajón', () => {
  // Factores que no dividen exacto son el caso peligroso: el residuo de la división
  // más el Math.floor del front es lo que escondía mercadería.
  for (const [b, kg] of [[59, 1184], [100, 300], [37, 259], [13, 234.7], [7, 100], [3, 47.3]]) {
    const f = derivarBultosLote({ bultos: b, kg_reales: kg, kg_por_bulto: 20,
      kg_vigente: kg, kg_disponibles: kg });
    assert.equal(Math.floor(f.bultos_disponibles), b, `${b} bultos de ${kg} kg`);
    assert.ok(r2(b * f.kg_por_bulto) <= kg + 0.005, `y despacharlos no se pasa de los ${kg} kg`);
  }
});

test('despachada una parte, lo que queda sigue cerrando en cajones enteros', () => {
  const f = derivarBultosLote({ bultos: 64, kg_reales: 1184, kg_por_bulto: 20,
    kg_vigente: 1184, kg_disponibles: 1184 - r2(30 * 18.5) });
  assert.equal(Math.floor(f.bultos_disponibles), 34);
});

test('facturar 64 cajones a $9.000 da $576.000 y no $531.000', () => {
  const f = derivarBultosLote({ bultos: 64, kg_reales: 1184, kg_por_bulto: 20,
    kg_vigente: 1184, kg_disponibles: 1184 });
  const precioKg = 9000 / f.kg_por_bulto;          // así pasa el front de $/cajón a $/kg
  assert.equal(r2(Math.floor(f.bultos_disponibles) * f.kg_por_bulto * precioKg), 576000);
});

// ── 5. LO QUE SE COMPARA AL CENTAVO SE MUESTRA AL CENTAVO ──────────────────
test('el formateador con centavos muestra los centavos', () => {
  const sgMoney2 = new Function(extraer(PANEL, 'sgMoney2') + '; return sgMoney2;')();
  assert.equal(sgMoney2(0.02), '$0,02');
  assert.equal(sgMoney2(0.49), '$0,49');
  assert.equal(sgMoney2(2789999.98), '$2.789.999,98');
});

// Y ESTE ES EL QUE IMPORTA. Que la función EXISTA no prueba nada: los carteles
// pueden seguir usando la de pesos enteros al lado de una comparación al centavo,
// que es como estaban. Acá se mira el código de cada cartel.
test('ningún cartel compara al centavo y muestra al peso', () => {
  // sgMoney y paMoney redondean a pesos enteros (Math.round). Un cartel que se
  // dispara con 0,01 y muestra con ellos dice "diferencia $0".
  const ENTEROS = /\b(sgMoney|paMoney)\(/;
  const casos = [
    // Ojo con enganchar el COMENTARIO en vez del código: el texto del cartel
    // también está escrito arriba de sgMoney2, contando la historia. Se ancla en
    // el cierre de etiqueta, que sólo está en el código.
    ['el cartel de la liquidación a precio cerrado', /NO da lo acordado<\/span>'[\s\S]{0,500}?<\/span>';/],
    ['el cuadro de asiento de pagos y cobranzas',    /✗ NO balancea — diferencia de[\s\S]{0,200}?'\)/],
    ['el cuadro de asiento por ámbito',              /⚠ NO balancea · diferencia[\s\S]{0,120}?\)\)/],
    ['el control de la factura de compra',           /no da contra lo acordado[\s\S]{0,300}?<\/span>'/],
    ['el aviso de "vino por más de lo acordado"',    /vino por <b>[\s\S]{0,400}?cuenta corriente\.'\)/],
    ['el reparto de costo del reproceso',            /Σ asignado[\s\S]{0,220}?<\/div>';/],
    ['la conciliación bancaria',                     /difEl\.textContent = \w+\(dif\);/],
  ];
  for (const [nombre, re] of casos) {
    const m = PANEL.match(re);
    assert.ok(m, `no encontré ${nombre} — ¿se reescribió? el test dejó de cubrirlo`);
    assert.doesNotMatch(m[0], ENTEROS,
      `${nombre} muestra con un formateador de pesos enteros mientras compara al `
      + `centavo: va a decir "diferencia $0" con el cartel en rojo.`);
  }
});
