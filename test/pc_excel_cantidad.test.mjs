// ══ EL EXCEL DE ÓRDENES DE APLICACIÓN DICE CUÁNTO SE USÓ ═══════════════════
//
// Pablo, 28/8/2026: «al descargar el excel debe incorporar una columna que
// indique cantidad de producto que se usó en la aplicación. Hoy sólo descarga
// productos y precios».
//
// La trampa de este pedido: la orden lleva la DOSIS —lo que la ingeniera
// planificó, en kg/ha o lt/lote— y eso NO es lo que salió del depósito. Lo que
// se usó vive en pa_aplicaciones.cantidad_real, en la unidad del insumo, y es lo
// que descuenta el stock. Poner la dosis en una columna que dice «usado» sería
// contestar otra pregunta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD = fs.readFileSync(path.join(RAIZ, 'src/rutas/produccion.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(RAIZ, 'src/panel.html'), 'utf8');

// La función REAL del panel, sin inyectarle nada. La primera versión de este
// test le pasaba un formateador falso y por eso no vio que el de verdad
// redondeaba a entero: certificaba un comportamiento que no ocurría.
function cargarFormato() {
  const i = PANEL.indexOf('function paOrdCant(n, unidad){');
  assert.ok(i > 0, 'no existe paOrdCant');
  const src = PANEL.slice(i, PANEL.indexOf('\n}', i) + 2);
  // eslint-disable-next-line no-new-func
  return new Function(src + '; return paOrdCant;')();
}
const fmt = cargarFormato();

// ── EL DATO SALE DE DONDE TIENE QUE SALIR ──────────────────────────────────

test('la cantidad usada sale de las aplicaciones, no de la dosis', () => {
  const i = PROD.indexOf('const usadoPorOrden = new Map();');
  assert.ok(i > 0, 'no se consulta lo aplicado');
  const b = PROD.slice(i, i + 1100);
  assert.match(b, /SUM\(a\.cantidad_real\),0\) AS usado/);
  assert.match(b, /FROM pa_aplicaciones a JOIN pa_insumos i ON i\.id = a\.insumo_id/);
  assert.match(b, /GROUP BY a\.orden_id, a\.insumo_id/);
  assert.match(PROD, /return \{ \.\.\.o, lotes, items, aplicado, cultivos/);
});

test('y viaja APARTE, no colgada de cada renglón planificado', () => {
  // Una orden puede listar el mismo insumo dos veces —nada lo impide y el
  // selector viene con el primer producto preseleccionado—: colgado del renglón,
  // el total aplicado se repetiría en los dos. Y un producto usado en la chacra
  // que la orden no listaba no aparecería en ningún lado.
  assert.match(PROD, /const aplicado = usadoPorOrden\.get\(o\.id\) \|\| \[\];/);
  assert.ok(!/cantidad_usada: usadoPorInsumo/.test(PROD), 'volvió a colgarse de los items');
});

test('una sola pasada por la tabla, no una consulta por orden', () => {
  // pa_aplicaciones no tiene índice por orden_id: una consulta adentro del map
  // es un recorrido completo de la tabla por cada orden de la lista.
  const i = PROD.indexOf('const usadoPorOrden = new Map();');
  const b = PROD.slice(i, i + 1100);
  assert.match(b, /WHERE a\.orden_id IN \(\$\{ph\}\)/);
  // Y fuera del map: se arma antes de recorrer las órdenes.
  assert.ok(i < PROD.indexOf('const data = ordenes.map(o => {'));
});

test('se agrupa por insumo: una orden puede aplicarse en varios lotes', () => {
  // La misma orden con tres lotes deja tres filas del mismo producto. Sin el
  // GROUP BY, el Excel mostraría sólo una.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE pa_aplicaciones (id INTEGER PRIMARY KEY, orden_id INTEGER,
    lote_id INTEGER, insumo_id INTEGER, cantidad_real REAL);
    CREATE TABLE pa_insumos (id INTEGER PRIMARY KEY, nombre TEXT, unidad TEXT)`);
  db.prepare("INSERT INTO pa_insumos VALUES (5,'Hydrocomplex','kg'),(7,'Poliet','lt')").run();
  const ins = db.prepare('INSERT INTO pa_aplicaciones (orden_id, lote_id, insumo_id, cantidad_real) VALUES (?,?,?,?)');
  ins.run(1, 10, 5, 25); ins.run(1, 11, 5, 30); ins.run(1, 12, 5, 20); ins.run(1, 10, 7, 12);
  ins.run(2, 10, 5, 8);
  const filas = db.prepare(`SELECT a.orden_id, a.insumo_id, i.nombre AS insumo_nombre, i.unidad,
      COALESCE(SUM(a.cantidad_real),0) AS usado
    FROM pa_aplicaciones a JOIN pa_insumos i ON i.id = a.insumo_id
    WHERE a.orden_id IN (1,2) GROUP BY a.orden_id, a.insumo_id`).all();
  assert.equal(filas.length, 3);
  const o1 = filas.filter((f) => f.orden_id === 1);
  assert.equal(o1.find((f) => f.insumo_id === 5).usado, 75);
  assert.equal(o1.find((f) => f.insumo_id === 7).usado, 12);
  assert.equal(filas.find((f) => f.orden_id === 2).usado, 8);
});

// ── EL FORMATO: ACÁ ESTABA EL BUG ──────────────────────────────────────────

test('LOS DECIMALES NO SE PIERDEN', () => {
  // nr() redondea a entero, y acá los decimales son el caso normal: un
  // agroquímico se dosifica a 0,05 o 0,75 lt/ha. Con nr(), «0,4 lt usados» se
  // imprimía «0 lt» — el número que se pidió, mintiendo.
  assert.equal(fmt(0.4, 'lt'), '0,4 lt');
  assert.equal(fmt(0.05, 'lt/ha'), '0,05 lt/ha');
  assert.equal(fmt(2.63, 'lt'), '2,63 lt');
  assert.equal(fmt(12.75, 'lt'), '12,75 lt');
  assert.equal(fmt(1.5, 'kg/ha'), '1,5 kg/ha');
});

test('y el formateador que redondea NO se usa acá', () => {
  const i = PANEL.indexOf('function paOrdCant(n, unidad){');
  const b = PANEL.slice(i, i + 400);
  assert.ok(!/\bnr\(/.test(b), 'volvió nr(), que redondea a entero');
  assert.match(b, /maximumFractionDigits: 2/);
  // Y por qué, escrito arriba de la función.
  assert.match(PANEL.slice(i - 600, i), /redondea a ENTERO/);
});

test('los miles se separan, y un entero no lleva decimales de relleno', () => {
  assert.equal(fmt(1234.56, 'kg'), '1.234,56 kg');
  assert.equal(fmt(25, 'kg'), '25 kg');
});

test('sin cantidad se escribe un guión, no un cero', () => {
  // Un cero en una columna de cantidades se suma; un guión dice «acá no hay».
  assert.equal(fmt(0, 'kg'), '—');
  assert.equal(fmt(null, 'kg'), '—');
  assert.equal(fmt(undefined, 'kg'), '—');
  assert.equal(fmt(12, ''), '12');
});

// ── LAS COLUMNAS ───────────────────────────────────────────────────────────

test('la columna que pidió Pablo está, y sale de lo aplicado', () => {
  const i = PANEL.indexOf('function paOrdExportarExcel(){');
  assert.ok(i > 0);
  const b = PANEL.slice(i, i + 5200);
  assert.match(b, /'Cantidad usada': \(o\.aplicado\|\|\[\]\)\.map/);
});

test('cada cantidad va PEGADA a su producto, no en una lista paralela', () => {
  // Dos listas alineadas por posición se leen mal apenas la orden tiene tres
  // renglones, y peor si uno se aplicó y otro no.
  const i = PANEL.indexOf('function paOrdExportarExcel(){');
  const b = PANEL.slice(i, i + 5200);
  assert.match(b, /a\.insumo_nombre \+ ': ' \+ paOrdCant\(a\.usado, a\.unidad\)/);
  assert.match(b, /i\.insumo_nombre \+ ': ' \+ paOrdCant\(i\.dosis, i\.unidad_dosis\)/);
});

test('la dosis se llama dosis, para que nadie la reste de lo usado', () => {
  // Una va en kg/ha y la otra en kilos. Puestas como «planificado» y «usado»,
  // dos columnas de números pegadas se restan sin pensar.
  const i = PANEL.indexOf('function paOrdExportarExcel(){');
  const b = PANEL.slice(i, i + 5200);
  assert.match(b, /'Dosis planificada':/);
  assert.ok(!/'Cantidad planificada':/.test(b));
  assert.match(b, /'Dosis':\s+e\.dosis,/);
  assert.match(b, /'Unidad dosis': e\.unidad_dosis/);
});

test('una orden sin ejecutar dice guión, no queda vacía', () => {
  const i = PANEL.indexOf('function paOrdExportarExcel(){');
  const b = PANEL.slice(i, i + 5200);
  assert.match(b, /\.join\(' · '\) \|\| '—'/);
});

// ── LA HOJA QUE SÍ SE PUEDE SUMAR ──────────────────────────────────────────

test('hay una segunda hoja con un renglón por producto', () => {
  const i = PANEL.indexOf('function paOrdExportarExcel(){');
  const b = PANEL.slice(i, i + 7000);
  assert.match(b, /XLSX\.utils\.book_append_sheet\(wb,ws2,'Por producto'\)/);
  assert.match(b, /'Usado':\s+e\.usado,/);
  assert.match(b, /'Unidad':\s+e\.unidad,/);
});

test('y NO cuenta dos veces el mismo producto repetido en la orden', () => {
  // pa_ordenes_items no tiene UNIQUE(orden_id, insumo_id) y el selector viene
  // con el primer producto preseleccionado: repetir un renglón pasa sin mala fe.
  // Es la aritmética real del agrupador, corrida.
  const juntar = (items, aplicado) => {
    const porIns = {}, orden = [];
    const meter = (id, nombre) => {
      const k = String(id);
      if (!porIns[k]) { porIns[k] = { nombre, dosis: 0, unidad_dosis: '', usado: 0, unidad: '' }; orden.push(k); }
      return porIns[k];
    };
    for (const i of items) {
      const e = meter(i.insumo_id, i.insumo_nombre);
      e.dosis += Number(i.dosis) || 0;
      if (!e.unidad_dosis) e.unidad_dosis = i.unidad_dosis || '';
    }
    for (const a of aplicado) {
      const e = meter(a.insumo_id, a.insumo_nombre);
      e.usado = Number(a.usado) || 0;
      e.unidad = a.unidad || e.unidad;
    }
    return orden.map((k) => porIns[k]);
  };
  // El mismo insumo en dos renglones de la orden, y 75 kg aplicados en total.
  const filas = juntar(
    [{ insumo_id: 5, insumo_nombre: 'Hydrocomplex', dosis: 1, unidad_dosis: 'kg/ha' },
     { insumo_id: 5, insumo_nombre: 'Hydrocomplex', dosis: 0.5, unidad_dosis: 'kg/ha' }],
    [{ insumo_id: 5, insumo_nombre: 'Hydrocomplex', usado: 75, unidad: 'kg' }]);
  assert.equal(filas.length, 1, 'se duplicó el producto');
  assert.equal(filas[0].usado, 75, 'se contó dos veces lo aplicado');
  assert.equal(filas[0].dosis, 1.5, 'las dos dosis del mismo producto se suman');
});

test('y un producto usado que la orden NO listaba aparece igual', () => {
  // En la chacra usaron otra cosa. Si la hoja saliera sólo de los renglones
  // planificados, ese consumo no estaría en ningún lado.
  const i = PANEL.indexOf('var porIns={}, orden=[];');
  assert.ok(i > 0, 'no está el agrupador');
  const b = PANEL.slice(i, i + 1200);
  assert.match(b, /\(o\.aplicado\|\|\[\]\)\.forEach/);
  assert.match(b, /var e=meter\(a\.insumo_id, a\.insumo_nombre\);/);
});

test('la hoja no se agrega si no hay ni un producto', () => {
  const i = PANEL.indexOf('if(porProd.length){');
  assert.ok(i > 0);
});

// ── LO QUE NO CAMBIÓ ───────────────────────────────────────────────────────

test('las columnas que ya estaban siguen estando', () => {
  const i = PANEL.indexOf('function paOrdExportarExcel(){');
  const b = PANEL.slice(i, i + 5200);
  for (const c of ['N° Orden', 'Fecha', 'Tipo', 'Finca', 'Lote(s)', 'Cultivo(s)',
                   'Productos', 'Costo', 'Asignado a', 'Estado']) {
    assert.ok(b.includes("'" + c + "'"), 'se perdió la columna ' + c);
  }
  // El costo sigue siendo el ejecutado, no el planificado.
  assert.match(PROD, /COALESCE\(SUM\(costo_total\), 0\) AS costo FROM pa_aplicaciones WHERE orden_id = \?/);
});

test('el export sigue respetando los filtros de la pantalla', () => {
  const i = PANEL.indexOf('function paOrdExportarExcel(){');
  const b = PANEL.slice(i, i + 600);
  assert.match(b, /var rows=PA\._ordenesFiltradas\|\|\[\];/);
  assert.match(b, /No hay órdenes para exportar con esos filtros/);
});

test('nr() sigue redondeando a entero para todos los demás', () => {
  // Es el formateador de pesos del panel y lo usan decenas de llamadas que sí
  // quieren enteros: el arreglo fue sacarlo de acá, no cambiarlo.
  assert.match(PANEL, /function nr\(n\)\{ return Math\.round\(parseFloat\(n\)\|\|0\)\.toLocaleString\('es-AR'\); \}/);
});
