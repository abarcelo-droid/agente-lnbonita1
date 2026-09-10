// ══ LA COBRANZA NO DEPENDE DEL CLIENTE ════════════════════════════════════
//
// Pablo, 8/9/2026, después de que un cobro no se registrara: «la contabilización
// de la cobranza NO depende del cliente: toda la deuda va al rubro contable
// correspondiente». Y: «lo mejor es definir un asiento modelo para la cobranza y
// seleccionar qué rubros registra cuando seleccionamos efectivo, banco o cheques.
// En la facturación puesto la cobranza en las facturas es como un ATAJO de la
// cobranza por cuenta corriente: debería leer ahí los parámetros».
//
// LO QUE PASABA. El POST de la cobranza exigía sg_clientes.cuenta_contable_id y,
// sin ella, contestaba 400 y no tomaba el cobro. Nadie carga una cuenta por
// cliente —ni tiene por qué—: la deuda de todos vive en el mismo rubro, Deudores
// por Ventas, el mismo que ya usa el modelo de venta al emitir el comprobante.
// El cobro se cargaba entero, se apretaba guardar y no entraba.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');
const VEN = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_ventas.js'), 'utf8');
const CONT = fs.readFileSync(path.join(RAIZ, 'src/rutas/sg_contable.js'), 'utf8');

const trozo = (txt, desde, cierre) => {
  const i = txt.indexOf(desde);
  assert.ok(i > 0, 'no está: ' + desde);
  const j = txt.indexOf(cierre, i);
  assert.ok(j > i, 'no cierra: ' + desde);
  return txt.slice(i, j + cierre.length);
};

// ══════════════════════════════════════════════════════════════════════════
// 1 · EL RESOLUTOR DE LA CUENTA, CORRIDO CONTRA UN SQLITE DE VERDAD
// ══════════════════════════════════════════════════════════════════════════
//
// Es la decisión que dejó los cobros afuera. Se importa el módulo y se ejecuta:
// leer que dice «|| modelo» no prueba que el orden sea el correcto.
const { cuentaCorrienteDe, cuentasDeCobranza, modeloCobranzaFaltan, esModeloDeCobranza, TIPOS_COBRANZA } =
  await import(pathToFileURL(path.join(RAIZ, 'src/servicios/asiento-cobranza.js')).href);

// La validación del editor, sacada del archivo y corrida de verdad: es la que
// decide si un modelo a medias se puede guardar.
const erroresCobranza = (() => {
  const i = CONT.indexOf('function erroresCobranza(lineas, prov) {');
  assert.ok(i > 0, 'no está erroresCobranza');
  const src = CONT.slice(i, CONT.indexOf('\r\n}', i) + 3);
  return new Function('esModeloDeCobranza', src + '\nreturn erroresCobranza;')(esModeloDeCobranza);
})();

function base({ modelo = true, clientes = 300, efectivo = 101, banco = 102, cheques = null,
                cartera = null } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sg_config (clave TEXT PRIMARY KEY, valor TEXT);
    CREATE TABLE sg_asientos_modelo (id INTEGER PRIMARY KEY, nombre TEXT, activo INTEGER DEFAULT 1);
    CREATE TABLE sg_asientos_modelo_lineas (id INTEGER PRIMARY KEY, modelo_id INTEGER,
      cuenta_id INTEGER, lado TEXT, descripcion TEXT, orden INTEGER, tipo_linea TEXT);
    CREATE TABLE sg_cuentas (id INTEGER PRIMARY KEY, codigo TEXT, nombre TEXT);
    CREATE TABLE sg_config_impositiva (clave TEXT PRIMARY KEY, cuenta_id INTEGER);
    INSERT INTO sg_cuentas (id,codigo,nombre) VALUES
      (300,'1.06.00.0001','Deudores por Ventas'), (101,'1.01.00.0001','Caja'),
      (102,'1.02.00.0001','Banco'), (150,'1.03.00.0001','Cheques en cartera'),
      (999,'1.06.00.0099','Cuenta propia del cliente');
  `);
  if (modelo) {
    db.exec("INSERT INTO sg_asientos_modelo (id,nombre) VALUES (7,'Cobranza');");
    db.exec("INSERT INTO sg_config (clave,valor) VALUES ('asiento_modelo_cobranza','7');");
    const ins = db.prepare(`INSERT INTO sg_asientos_modelo_lineas
      (modelo_id,cuenta_id,lado,orden,tipo_linea) VALUES (7,?,?,?,?)`);
    if (clientes) ins.run(clientes, 'haber', 0, 'cobro_clientes');
    if (efectivo) ins.run(efectivo, 'debe', 1, 'cobro_efectivo');
    if (banco) ins.run(banco, 'debe', 2, 'cobro_banco');
    if (cheques) ins.run(cheques, 'debe', 3, 'cobro_cheques');
  }
  if (cartera) db.exec(`INSERT INTO sg_config_impositiva (clave,cuenta_id) VALUES ('cheques_cartera',${cartera});`);
  return db;
}

test('sin cuenta en la ficha, la cuenta corriente sale del RUBRO', () => {
  // Éste es el caso que dejaba los cobros afuera.
  const db = base();
  const r = cuentaCorrienteDe(db, { id: 1, razon_social: 'Un cliente', cuenta_contable_id: null });
  assert.equal(r.cuenta_id, 300);
  assert.equal(r.de, 'modelo');
});

test('pero el cliente que TIENE la suya la sigue usando', () => {
  // Hay clientes que se llevan su propia cuenta corriente en el plan. Quitárselo
  // sería romper algo que alguien configuró a propósito.
  const db = base();
  const r = cuentaCorrienteDe(db, { id: 1, razon_social: 'Grande SA', cuenta_contable_id: 999 });
  assert.equal(r.cuenta_id, 999);
  assert.equal(r.de, 'cliente');
});

test('y si no hay ni una ni otra, se dice — no se adivina', () => {
  const db = base({ clientes: null });
  assert.equal(cuentaCorrienteDe(db, { cuenta_contable_id: null }).cuenta_id, null);
  const sinModelo = base({ modelo: false });
  assert.equal(cuentaCorrienteDe(sinModelo, { cuenta_contable_id: null }).cuenta_id, null);
});

test('un modelo dado de baja no se usa como si estuviera', () => {
  // La config queda apuntando a la nada y el circuito deja de funcionar sin que
  // nadie lo toque. Se avisa en vez de tomarlo por bueno.
  const db = base();
  db.exec('UPDATE sg_asientos_modelo SET activo=0 WHERE id=7');
  const c = cuentasDeCobranza(db);
  assert.equal(c.modelo_id, null);
  assert.equal(c.perdido, 7);
  assert.equal(c.clientes, null);
});

test('las cuentas de los medios salen del modelo', () => {
  const db = base();
  const c = cuentasDeCobranza(db);
  assert.equal(c.efectivo, 101);
  assert.equal(c.banco, 102);
});

test('la de cheques la completa la configuración impositiva, que ya la tenía', () => {
  // 'cheques_cartera' existe desde antes de este modelo y la usa el depósito de
  // cheques. Dos lugares para la misma cuenta serían dos verdades.
  const db = base({ cheques: null, cartera: 150 });
  assert.equal(cuentasDeCobranza(db).cheques, 150);
});

test('y si el modelo la trae, gana la del modelo', () => {
  const db = base({ cheques: 150, cartera: null });
  assert.equal(cuentasDeCobranza(db).cheques, 150);
});

test('un modelo SIN ninguna línea de medio no pasa el editor', () => {
  // Se ejecuta la validación real, no se lee: es la que decide si un modelo a
  // medias se puede guardar, y guardado a medias el cobro revienta en producción.
  const err = erroresCobranza([{ tipo_linea: 'cobro_clientes', lado: 'haber' }], []);
  assert.match(String(err), /al menos una línea de dónde entra la plata/);
  // Con uno solo alcanza: quien cobra únicamente por transferencia no tiene por
  // qué configurar caja ni cheques.
  assert.equal(erroresCobranza([
    { tipo_linea: 'cobro_clientes', lado: 'haber' },
    { tipo_linea: 'cobro_banco', lado: 'debe' }], []), null);
});

test('y el editor rechaza lo que estaría al revés o mezclado', () => {
  const ok = { tipo_linea: 'cobro_clientes', lado: 'haber' };
  const banco = { tipo_linea: 'cobro_banco', lado: 'debe' };
  // Clientes al debe: cobrar es que el cliente DEJE de deber.
  assert.match(String(erroresCobranza([{ ...ok, lado: 'debe' }, banco], [])), /va en el HABER/);
  // Dos líneas de clientes: no se sabría cuál cancela.
  assert.match(String(erroresCobranza([ok, ok, banco], [])), /UNA línea de Clientes/);
  // Un medio al haber: es dónde ENTRA la plata.
  assert.match(String(erroresCobranza([ok, { ...banco, lado: 'haber' }], [])), /va en el DEBE/);
  // Dos veces el mismo medio.
  assert.match(String(erroresCobranza([ok, banco, banco], [])), /dos líneas del mismo medio/);
  // Con Proveedores: no se le está pagando a nadie.
  assert.match(String(erroresCobranza([ok, banco], [{ tipo_linea: 'proveedores' }])),
    /no lleva línea de Proveedores/);
  // Mezclado con las de venta.
  assert.match(String(erroresCobranza([ok, banco, { tipo_linea: 'ventas', lado: 'haber' }], [])),
    /no lleva las líneas de Ventas/);
  // Y un modelo que NO es de cobranza pasa de largo, o se rompería el de compras.
  assert.equal(erroresCobranza([{ tipo_linea: 'proveedores', lado: 'haber' }], []), null);
});

test('sólo la de Clientes CORTA: sin ella no se puede cobrar con nada', () => {
  // Las tres de los medios avisan pero NO frenan: cada banco tiene su cuenta
  // propia en Caja y Bancos, así que un modelo sin ellas puede ser correcto.
  const sinMedios = modeloCobranzaFaltan(base({ efectivo: null, banco: null, cheques: null }));
  assert.equal(sinMedios.corta, false, 'frena por algo que puede no hacer falta');

  // Las otras tres son un piso que puede no hacer falta —cada banco tiene su
  // cuenta propia— así que avisan pero no frenan.
  const sinCli = modeloCobranzaFaltan(base({ clientes: null }));
  assert.equal(sinCli.corta, true);
  assert.match(sinCli.faltan.join(' '), /Clientes \/ Deudores/);

  const completo = modeloCobranzaFaltan(base());
  assert.equal(completo.corta, false);
  assert.deepEqual(completo.faltan, []);

  const sinModelo = modeloCobranzaFaltan(base({ modelo: false }));
  assert.equal(sinModelo.corta, true);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL EDITOR ACEPTA UN MODELO DE COBRANZA
// ══════════════════════════════════════════════════════════════════════════

test('se reconoce por sus líneas, no por su nombre', () => {
  assert.equal(esModeloDeCobranza([{ tipo_linea: 'cobro_clientes' }]), true);
  assert.equal(esModeloDeCobranza([{ tipo_linea: 'cobro_banco' }]), true);
  assert.equal(esModeloDeCobranza([{ tipo_linea: 'ventas' }, { tipo_linea: 'clientes' }]), false);
  assert.equal(esModeloDeCobranza([]), false);
});

test('el editor tiene su rama, o los de venta y compra lo rechazaban', () => {
  const f = trozo(CONT, 'function erroresCobranza(lineas, prov) {', '\r\n}');
  // Sin Proveedores: no se le está pagando a nadie.
  assert.match(f, /no lleva línea de Proveedores/);
  // Ni las de venta: la misma cuenta con dos lados es dos líneas distintas.
  assert.match(f, /\['clientes', 'ventas'\]\.includes\(l\.tipo_linea\)/);
  // UNA de clientes, y en el HABER: cobrar es que el cliente DEJE de deber.
  assert.match(f, /cobro_clientes/);
  assert.match(f, /cli\[0\]\.lado !== 'haber'/);
  // Y al menos un medio, todos en el debe.
  assert.match(f, /'cobro_efectivo', 'cobro_banco', 'cobro_cheques'/);
  assert.match(f, /l\.lado !== 'debe'/);
  // Se llama desde el POST y desde el PUT: la validación de los otros modelos
  // vive duplicada y ésta no repite ese camino.
  assert.equal((CONT.match(/const _cob = erroresCobranza\(lineas, _prov\);/g) || []).length, 2);
});

test('y el circuito figura en el cuadro para poder elegirlo', () => {
  assert.match(CONT, /clave: 'asiento_modelo_cobranza', label: 'Cobranza de clientes'/);
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · EL POST YA NO EXIGE LA CUENTA DEL CLIENTE
// ══════════════════════════════════════════════════════════════════════════

test('el 400 que dejaba los cobros afuera ya no está', () => {
  assert.ok(!/no tiene cuenta contable asignada: sin ella no se sabe/.test(VEN),
    'sigue rechazando el cobro por no tener cuenta el cliente');
  const p = trozo(VEN, "router.post('/cobranzas', requireAuth", '\r\n});');
  assert.match(p, /const ctaCte = cuentaCorrienteDe\(db, cli\)/);
  // Y el asiento usa la cuenta RESUELTA, no la del cliente a secas: sin esto se
  // resolvía bien y después se escribía la vieja.
  assert.match(p, /cuenta_id: ctaCte\.cuenta_id, debe: 0, haber: x\.monto/);
  assert.ok(!/cuenta_id: cli\.cuenta_contable_id/.test(p));
});

test('si no hay ninguna cuenta, el error dice dónde se arregla', () => {
  const p = trozo(VEN, "router.post('/cobranzas', requireAuth", '\r\n});');
  assert.match(p, /if \(!ctaCte\.cuenta_id\)/);
  assert.match(p, /Cobranza de clientes/);
  assert.match(p, /No se configura cliente por cliente|línea de Clientes \/ Deudores/);
});

test('una caja sin cuenta contable ya no frena el cobro: el modelo es el piso', () => {
  // Cada banco es una cuenta distinta del plan y la suya gana. Pero una caja sin
  // cuenta asignada frenaba el cobro entero.
  const p = trozo(VEN, "router.post('/cobranzas', requireAuth", '\r\n});');
  assert.match(p, /const piso = cuentasDeCobranza\(db\)/);
  assert.match(p, /forma === 'efectivo' \? piso\.efectivo : piso\.banco/);
  // Y si tampoco está en el modelo, ahí sí corta y lo explica.
  assert.match(p, /el asiento modelo de `\r?\n?\s*\+ `cobranza tampoco dice dónde entra/);
});

test('el cheque toma la cartera del modelo si la config no la tiene', () => {
  const p = trozo(VEN, "router.post('/cobranzas', requireAuth", '\r\n});');
  assert.match(p, /cuentasDeCobranza\(db\)\.cheques \|\| null/);
});

test('elegir el modelo es de administrador; cobrar no', () => {
  // Parametrizar contra qué cuenta entra TODO lo que se cobra no es trabajo del
  // día. Registrar el cobro sí.
  assert.match(VEN, /router\.put\('\/modelo-cobranza', requireAdmin/);
  assert.match(VEN, /router\.get\('\/modelo-cobranza', requireAuth/);
  assert.match(VEN, /router\.post\('\/cobranzas', requireAuth/);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · LA PANTALLA
// ══════════════════════════════════════════════════════════════════════════

test('los cuatro tipos están en el selector de los DOS editores de modelo', () => {
  // Si faltaran, el modelo no se puede armar: no hay cómo marcar cuál línea es
  // cuál. Y son dos editores —el de SG y el de PC— con la misma lista.
  for (const t of TIPOS_COBRANZA.map((x) => x.tipo)) {
    assert.equal((PANEL.match(new RegExp("\\['" + t + "',", 'g')) || []).length, 2,
      'falta ' + t + ' en alguno de los dos editores');
  }
  // Y el de clientes dice HABER en su etiqueta, que es donde se equivoca uno.
  assert.match(PANEL, /'Clientes \/ Deudores \(Haber\) — cobranza'/);
});

test('la cobranza es un circuito más del bloque genérico', () => {
  const t = trozo(PANEL, 'var SG_MODELOS = {', '\r\n};');
  assert.match(t, /cobranza: \{/);
  assert.match(t, /ruta: '\/api\/sg\/ventas\/modelo-cobranza'/);
  assert.match(t, /btn: 'sgcob-modelo-btn', av: 'sgcob-modelo-falta'/);
});

test('el botón y el aviso están en Cuenta corriente de clientes', () => {
  assert.match(PANEL, /id="sgcob-modelo-btn"[\s\S]{0,120}sgModeloAbrir\('cobranza'\)/);
  assert.match(PANEL, /id="sgcob-modelo-falta"/);
  // Y el estado se pide al ENTRAR, no al abrir el cobro: si saliera de abrirlo,
  // habría que llegar hasta el final para enterarse.
  const f = trozo(PANEL, 'function sgLoadCC(){', '\r\n}');
  assert.match(f, /sgModeloCargar\('cobranza'\)/);
});

test('el aviso de la cobranza NO dice «se guarda igual»: el cobro no entra', () => {
  // En los otros cinco circuitos la operación se guarda y queda sin asiento. Acá
  // el cobro directamente no se registra, y decir lo otro sería mentir.
  const f = trozo(PANEL, 'function sgModeloEstado(k){', '\r\n}');
  assert.match(f, /var noEntra = \(k === 'cobranza'\)/);
  assert.match(f, /no se pueden registrar/);
  assert.match(f, /el cobro '\r?\n?\s*\+ 'no entra/);
});

test('el preview del asiento tampoco exige la cuenta del cliente', () => {
  // El cuadro tiene que espejar al backend: si el servidor toma el cobro con la
  // cuenta del rubro y la pantalla dice que no se puede, se frena una operación
  // que sí se podía hacer.
  const f = trozo(PANEL, 'function sgCobAsientoPintar(){', '\r\n}');
  assert.match(f, /SG_COB\.ctaCliente/);
  // Y SE LEE CON CÓDIGO Y NOMBRE. Esto pinneaba `cuentas.clientes`, que es un id
  // PELADO, y doce renglones más abajo se lo usaba como objeto (cli.codigo): en el
  // caso normal —el cliente sin cuenta propia, que desde la V1029 son todos— el
  // renglón del haber salía en blanco. El assert se endurece: tiene que salir de
  // cuentas_det, que es la que trae el código y el nombre.
  assert.match(f, /cobEst\.cuentas_det && cobEst\.cuentas_det\.clientes/);
  assert.ok(!/asignásela en su ficha de Maestros/.test(f),
    'sigue mandando a cargar una cuenta por cliente');
  // Y TAMPOCO EXIGE QUE LA CAJA TRAIGA LA SUYA. El backend cae al piso del modelo
  // (la línea de Efectivo o la de Banco) cuando la cuenta elegida no tiene cuenta
  // contable; el front cortaba antes, así que configurar el piso no se notaba.
  assert.match(f, /cuentas_det\.efectivo/);
  assert.match(f, /cuentas_det\.banco/);
  assert.ok(!/Elegí en cada renglón una cuenta con cuenta contable asignada/.test(f),
    'el preview sigue frenando un cobro que el servidor toma');
});

test('y Facturar en el puesto hereda: cobra por la misma puerta', () => {
  // Pablo: «la cobranza en las facturas es como un atajo de la cobranza por
  // cuenta corriente, debería leer ahí los parámetros». Lo hace porque postea al
  // MISMO endpoint — si tuviera el suyo, serían dos criterios.
  const f = trozo(PANEL, 'function sgFdCobrarAhora(r, cont){', '\r\n}');
  assert.match(f, /api\('\/api\/sg\/ventas\/cobranzas', 'POST'/);
});

// ══════════════════════════════════════════════════════════════════════════
// 5 · EL MANUAL VA CON EL CAMBIO
// ══════════════════════════════════════════════════════════════════════════

test('el manual de Asiento Modelo explica el circuito nuevo, con su versión', () => {
  assert.match(PANEL, /El de COBRANZAS, y por qué apareció[\s\S]{0,90}V1029/);
  // Lo que hay que entender: es un piso, no la última palabra.
  assert.match(PANEL, /<b>Las tres del debe son un piso, no la última palabra\.<\/b>/);
  assert.match(PANEL, /Antes esto se pedía cliente por cliente\.<\/b>/);
});

test('y CC clientes estrena el suyo, que no tenía', () => {
  assert.match(PANEL, /onclick="sgManualAbrir\('ccclientes'\)"/);
  const m = trozo(PANEL, "SG_MANUAL.ccclientes = { titulo: 'Cuenta corriente de clientes'", '\r\n};');
  // Lo que de verdad confunde: el saldo son dos mitades y suman.
  assert.match(m, /El saldo son dos mitades/);
  // Que el cheque no entra a ninguna cuenta hasta que se deposita.
  assert.match(m, /El cheque no entra a ninguna cuenta\.<\/b>/);
  // Y la diferencia con los otros circuitos: acá el cobro NO se registra.
  assert.match(m, /Sin ese modelo el cobro NO se registra<\/b>/);
  assert.match(m, /Contra qué cuenta se cancela <span class="ver">V1029<\/span>/);
  // Y no cita una versión que el panel todavía no alcanzó.
  const SIDEBAR = fs.readFileSync(path.join(RAIZ, 'src/sidebar-v2.js'), 'utf8');
  const actual = Number((SIDEBAR.match(/const VERSION = 'V(\d+)'/) || [])[1]);
  for (const v of (m.match(/V(\d{3,4})</g) || []).map((x) => Number(x.match(/\d+/)[0]))) {
    assert.ok(v <= actual, 'el manual cita la V' + v + ' y el panel va en la V' + actual);
  }
});
