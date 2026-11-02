// ══ 📋 LA PLANILLA DE CONTROL DE INGRESO ════════════════════════════════════
//
// Andy, 2/11/2026, con la foto del papel: «necesito que en el panel de ingreso
// de kilos pueda descargarse un exportable en PDF exactamente con esta
// información».
//
// Es el REGISTRO DE CONTROL EN GALPÓN DE EMPAQUE: un documento controlado, con
// número de versión y vigencia, que firman tres personas. Lo que se clava acá:
//
//   1. EL CORRELATIVO DE BOLSÓN ARRANCA EN 1 CON CADA VIAJE. En el papel es
//      así, y es lo que permite cotejar la hoja impresa contra la del camión.
//      Si siguiera de largo entre viajes, los dos papeles no coinciden.
//   2. UN ESTADO SANITARIO QUE NO SE MIRÓ NO ES «BUENO». Una planilla donde
//      todo figura B porque nadie completó la columna es peor que una con
//      huecos: la firman tres personas.
//   3. QUE LAS COLUMNAS SEAN LAS DEL PAPEL, en el mismo orden. Reordenarlas
//      obliga a quien revisa a buscar dónde quedó cada cosa.
//   4. QUE SE PUEDA SEGUIR LLENANDO A MANO. El camión que entra después de
//      imprimir se anota con la lapicera, como hoy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = process.env.LNB_RAIZ
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUENTE = fs.readFileSync(path.join(RAIZ, 'src/servicios/galponPlanillaPDF.js'), 'utf8');

import {
  registrarVolcado, planillaIngreso, sanitarioDe, SANITARIOS,
} from '../src/servicios/galpon.js';

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pa_lotes (id INTEGER PRIMARY KEY, nombre TEXT, finca TEXT,
      sector_id INTEGER, activo INTEGER DEFAULT 1);
    INSERT INTO pa_lotes (id,nombre,finca) VALUES
      (10,'10','La Estación'), (11,'11','La Estación'), (12,'13','El Abuelo');
    CREATE TABLE pa_cuadrillas (id INTEGER PRIMARY KEY, nombre TEXT, tipo TEXT,
      activo INTEGER DEFAULT 1);
    INSERT INTO pa_cuadrillas (id,nombre) VALUES (1,'Norte');
    CREATE TABLE gal_config (clave TEXT PRIMARY KEY, valor TEXT, actualizado TEXT);
    INSERT INTO gal_config (clave,valor) VALUES
      ('kg_max_carga','20000'), ('plan_version','02'),
      ('plan_vigencia','diciembre 2028'), ('plan_modifico','Ing. Videla, Erika'),
      ('plan_reviso','Lic. Vives, Carina'), ('plan_aprobo','Carlos Barceló');
    CREATE TABLE gal_lote_datos (lote_id INTEGER PRIMARY KEY, renspa TEXT, variedad TEXT,
      cuartel TEXT, notas TEXT, actualizado TEXT);
    INSERT INTO gal_lote_datos (lote_id,variedad) VALUES (10,'Castle Brite');
    CREATE TABLE gal_volcados (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE,
      fecha TEXT NOT NULL, hora TEXT, lote_id INTEGER NOT NULL, lote_nombre TEXT,
      producto TEXT, cuadrilla_id INTEGER, cuadrilla TEXT, kilos REAL NOT NULL,
      ifcos INTEGER, bruto REAL, tara REAL, tarjeta_id INTEGER, viaje INTEGER,
      sanitario TEXT, origen TEXT NOT NULL DEFAULT 'manual', observacion TEXT,
      estado TEXT NOT NULL DEFAULT 'ok', revision_motivo TEXT, usuario_id INTEGER,
      usuario TEXT, creado_en TEXT, eliminado_en TEXT);
  `);
  return db;
}

const F = '2026-11-02';
const carga = (db, d) => registrarVolcado(db, Object.assign(
  { fecha: F, lote_id: 10, kilos: 10, producto: 'Damasco' }, d));

// ══════════════════════════════════════════════════════════════════════════
// 1 · EL CORRELATIVO DE BOLSÓN
// ══════════════════════════════════════════════════════════════════════════
test('EL NÚMERO DE BOLSÓN ARRANCA EN 1 CON CADA VIAJE', () => {
  // En el papel es así, y es lo que permite cotejar la hoja impresa contra la
  // del camión. Si siguiera de largo entre viajes, los dos papeles no
  // coinciden y el que revisa no sabe cuál está mal.
  const db = base();
  for (const k of [6.9, 14.3, 15.4]) carga(db, { viaje: 5, kilos: k, uuid: 'a' + k });
  for (const k of [13.2, 9.1]) carga(db, { viaje: 6, kilos: k, uuid: 'b' + k });

  const p = planillaIngreso(db, F);
  assert.equal(p.viajes.length, 2);
  assert.deepEqual(p.viajes[0].filas.map((f) => f.n), [1, 2, 3]);
  assert.deepEqual(p.viajes[1].filas.map((f) => f.n), [1, 2],
    'el correlativo siguió de largo entre dos viajes');
  assert.equal(p.viajes[0].viaje, 5);
  assert.equal(p.viajes[1].viaje, 6);
});

test('EL CORRELATIVO NO SE GUARDA: se calcula al armar la planilla', () => {
  /* Guardarlo obligaría a renumerar todas las filas de abajo cada vez que
     alguien borra una del medio — y esa renumeración es la que después no
     coincide con el papel que ya se firmó. */
  const db = base();
  const ids = [];
  for (const k of [1, 2, 3, 4]) ids.push(carga(db, { viaje: 5, kilos: k, uuid: 'u' + k }).id);
  // Se borra la segunda: las que quedan se renumeran 1,2,3 en la planilla nueva.
  db.prepare("UPDATE gal_volcados SET eliminado_en = 'x' WHERE id = ?").run(ids[1]);
  const p = planillaIngreso(db, F);
  assert.deepEqual(p.viajes[0].filas.map((f) => f.n), [1, 2, 3]);
  assert.deepEqual(p.viajes[0].filas.map((f) => f.kilos), [1, 3, 4]);
  // Y la columna no existe en la tabla: no hay nada que renumerar.
  const cols = db.prepare('PRAGMA table_info(gal_volcados)').all().map((c) => c.name);
  assert.ok(!cols.includes('bolson'), 'el correlativo se está guardando');
});

test('lo que NO tiene viaje va al final, no al principio', () => {
  // En SQLite NULL ordena primero, y eso pondría lo que todavía no se asignó
  // arriba de los camiones que sí se registraron.
  const db = base();
  carga(db, { viaje: null, kilos: 1, uuid: 'sin' });
  carga(db, { viaje: 3, kilos: 2, uuid: 'tres' });
  carga(db, { viaje: 1, kilos: 3, uuid: 'uno' });
  const p = planillaIngreso(db, F);
  assert.deepEqual(p.viajes.map((v) => v.viaje), [1, 3, null]);
});

// ══════════════════════════════════════════════════════════════════════════
// 2 · EL ESTADO SANITARIO
// ══════════════════════════════════════════════════════════════════════════
test('SIN MIRAR NO ES BUENO', () => {
  // Una planilla donde todo figura B porque nadie completó la columna es peor
  // que una con huecos: la firman tres personas.
  const db = base();
  carga(db, { kilos: 10, uuid: 'a' });                    // sin estado
  carga(db, { kilos: 11, sanitario: 'B', uuid: 'b' });
  const p = planillaIngreso(db, F);
  assert.equal(p.viajes[0].filas[0].sanitario, null, 'puso un estado que nadie miró');
  assert.equal(p.viajes[0].filas[1].sanitario, 'B');
});

test('sólo B, R o M: tres letras y no texto libre', () => {
  // Texto libre serían cuarenta maneras de escribir lo mismo y ningún informe
  // posible, que es la razón por la que los motivos de gestión son cuatro.
  assert.deepEqual(SANITARIOS, ['B', 'R', 'M']);
  assert.equal(sanitarioDe('b'), 'B', 'no acepta la minúscula');
  assert.equal(sanitarioDe(' r '), 'R');
  assert.equal(sanitarioDe('Bueno'), 'B', 'no toma la inicial de la palabra');
  assert.equal(sanitarioDe('X'), null);
  assert.equal(sanitarioDe('regular pero pasable'), 'R');
  for (const v of [null, '', '  ', 0, {}]) assert.equal(sanitarioDe(v), null);
});

test('el estado se guarda normalizado, no como vino', () => {
  const db = base();
  carga(db, { kilos: 10, sanitario: 'r', uuid: 'a' });
  carga(db, { kilos: 11, sanitario: 'chirimbolo', uuid: 'b' });
  const f = planillaIngreso(db, F).viajes[0].filas;
  assert.equal(f[0].sanitario, 'R');
  assert.equal(f[1].sanitario, null, 'guardó basura en la columna de calidad');
});

// ══════════════════════════════════════════════════════════════════════════
// 3 · LO QUE LLEVA EL ENCABEZADO
// ══════════════════════════════════════════════════════════════════════════
test('la finca sale del LOTE y no de lo que mandó la pantalla', () => {
  // Es la misma razón por la que el nombre del lote se lee de la base: dos
  // pantallas con distinta versión del padrón escribirían dos fincas para el
  // mismo lote.
  const db = base();
  carga(db, { lote_id: 10, kilos: 10, uuid: 'a' });
  carga(db, { lote_id: 12, kilos: 11, uuid: 'b' });
  const f = planillaIngreso(db, F).viajes[0].filas;
  assert.equal(f[0].finca, 'La Estación');
  assert.equal(f[1].finca, 'El Abuelo');
});

test('el cultivo y la variedad salen de lo cargado', () => {
  // En el papel se escriben una vez arriba porque un viaje trae una sola cosa.
  const db = base();
  carga(db, { kilos: 10, producto: 'Damasco', uuid: 'a' });
  const p = planillaIngreso(db, F);
  assert.equal(p.cultivo, 'Damasco');
  assert.equal(p.variedad, 'Castle Brite');
});

test('si entraron DOS cultivos se listan los dos', () => {
  // Mentir con el primero sería peor: la planilla dice qué entró ese día.
  const db = base();
  carga(db, { kilos: 10, producto: 'Damasco', uuid: 'a' });
  carga(db, { kilos: 11, producto: 'Ciruela', uuid: 'b' });
  assert.equal(planillaIngreso(db, F).cultivo, 'Damasco · Ciruela');
});

test('el encabezado y las firmas salen de la configuración', () => {
  // Es un documento controlado: lo revisa calidad, no un programador. El día
  // que cambie el que aprueba se cambia en una pantalla.
  const db = base();
  const p = planillaIngreso(db, F);
  assert.equal(p.version, '02');
  assert.equal(p.vigencia, 'diciembre 2028');
  assert.equal(p.aprobo, 'Carlos Barceló');
  assert.equal(p.reviso, 'Lic. Vives, Carina');
  assert.equal(p.modifico, 'Ing. Videla, Erika');
});

test('un día sin nada devuelve una planilla vacía, no un error', () => {
  // Es la hoja que se imprime EN BLANCO para llevar al galpón.
  const db = base();
  const p = planillaIngreso(db, '2026-01-01');
  assert.deepEqual(p.viajes, []);
  assert.equal(p.total.bultos, 0);
  assert.equal(p.version, '02', 'la hoja en blanco perdió su encabezado');
});

test('lo BORRADO no figura en la planilla', () => {
  const db = base();
  const r = carga(db, { kilos: 10, uuid: 'a' });
  carga(db, { kilos: 11, uuid: 'b' });
  db.prepare("UPDATE gal_volcados SET eliminado_en = 'x' WHERE id = ?").run(r.id);
  const p = planillaIngreso(db, F);
  assert.equal(p.total.bultos, 1);
  assert.equal(p.viajes[0].filas[0].kilos, 11);
});

// ══════════════════════════════════════════════════════════════════════════
// 4 · EL PDF ES EL MISMO FORMULARIO
// ══════════════════════════════════════════════════════════════════════════
let falta = false;
try { await import('jspdf'); }
catch { falta = 'falta el paquete jspdf: corré npm install para que estos tests corran'; }
const t = (nombre, fn) => test(nombre, { skip: falta }, fn);

function dibujado(buf) {
  const s = buf.toString('latin1');
  let txt = '';
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    try { txt += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1') + '\n'; }
    catch (e) { txt += m[1] + '\n'; }
  }
  return { crudo: txt, textos: [...txt.matchAll(/\((.*?)\)\s*Tj/g)].map((x) => x[1]) };
}

const DATOS = {
  fecha: '2026-11-02', cultivo: 'Damasco', variedad: 'Castle Brite',
  version: '02', vigencia: 'diciembre 2028',
  modifico: 'Ing. Videla, Erika', reviso: 'Lic. Vives, Carina', aprobo: 'Carlos Barceló',
  viajes: [{ viaje: 5, bultos: 2, kilos: 21.2, filas: [
    { n: 1, finca: 'La Estación', lote: '10', kilos: 6.9, sanitario: 'B', observacion: null },
    { n: 2, finca: 'La Estación', lote: '11', kilos: 14.3, sanitario: 'R', observacion: 'golpeado' },
  ] }],
  total: { kilos: 21.2, bultos: 2, viajes: 1 },
};

t('LAS COLUMNAS SON LAS DEL PAPEL, en el mismo orden', async () => {
  // Reordenarlas obliga a quien revisa a buscar dónde quedó cada cosa, y el
  // que lo aprueba firma algo que no reconoce.
  const { galponPlanillaPDF } = await import('../src/servicios/galponPlanillaPDF.js');
  const buf = await galponPlanillaPDF(DATOS, {});
  const { textos } = dibujado(buf);
  const t1 = textos.join(' | ');
  for (const c of ['N° de viaje', 'Finca', 'Lote y/o', 'llave', 'N° de',
    'bolsas/bolsón', '/cajón/bins', 'Peso', 'Estado', 'sanitario', 'Observaciones']) {
    assert.ok(textos.includes(c), 'falta la columna «' + c + '»');
  }
  // Y en orden: el índice de cada título crece.
  const orden = ['N° de viaje', 'Finca', 'Lote y/o', 'Peso', 'Observaciones']
    .map((c) => textos.indexOf(c));
  assert.deepEqual(orden.slice().sort((a, b) => a - b), orden,
    'las columnas salieron en otro orden que el papel');
  assert.match(t1, /REGISTRO DE CONTROL EN GALPÓN/);
  assert.match(t1, /Control de ingreso de materia prima/);
});

t('LAS TRES FIRMAS ESTÁN: es por lo que existe el formulario', async () => {
  const { galponPlanillaPDF } = await import('../src/servicios/galponPlanillaPDF.js');
  const { textos } = dibujado(await galponPlanillaPDF(DATOS, {}));
  const t1 = textos.join(' | ');
  assert.match(t1, /Modificó: Ing. Videla, Erika/);
  assert.match(t1, /Revisó: Lic. Vives, Carina/);
  assert.match(t1, /Aprobó: Carlos Barceló/);
  assert.equal(textos.filter((x) => x === 'Firma:').length, 3,
    'faltan casilleros de firma');
  assert.match(t1, /Versión 02/);
  assert.match(t1, /Vigencia: diciembre 2028/);
});

t('EL ESTADO SANITARIO SALE CON LAS TRES LETRAS, y una circulada', async () => {
  /* En el papel se circula una de las tres. Imprimir sólo la que se cargó
     dejaría la hoja sin poder completarse a mano, y sin el círculo no se
     distingue la que se eligió. */
  const { galponPlanillaPDF } = await import('../src/servicios/galponPlanillaPDF.js');
  const buf = await galponPlanillaPDF(DATOS, {});
  const { textos, crudo } = dibujado(buf);
  assert.ok(textos.filter((x) => x === 'B / R / M').length >= 2,
    'no imprime las tres letras en cada fila');
  /* Los círculos: jsPDF dibuja un círculo con cuatro curvas Bézier. Dos filas
     con estado cargado son dos círculos. */
  const curvas = (crudo.match(/ c\n/g) || []).length;
  assert.ok(curvas >= 8, 'no se dibujaron los círculos del estado: ' + curvas + ' curvas');
});

t('UN ESTADO SIN MIRAR NO LLEVA CÍRCULO', async () => {
  const { galponPlanillaPDF } = await import('../src/servicios/galponPlanillaPDF.js');
  const sin = Object.assign({}, DATOS, { viajes: [{ viaje: 5, bultos: 1, kilos: 10,
    filas: [{ n: 1, finca: 'x', lote: '10', kilos: 10, sanitario: null }] }] });
  const con = Object.assign({}, DATOS, { viajes: [{ viaje: 5, bultos: 1, kilos: 10,
    filas: [{ n: 1, finca: 'x', lote: '10', kilos: 10, sanitario: 'B' }] }] });
  // Un círculo son cuatro curvas Bézier: se cuentan los operadores `c`.
  const curvas = async (d) => {
    const buf = await galponPlanillaPDF(d, { en_blanco: 0 });
    return (dibujado(buf).crudo.match(/ c\n/g) || []).length;
  };
  const a = await curvas(sin);
  const b = await curvas(con);
  assert.ok(b > a, 'el estado cargado no se distingue del que nadie miró');
  // Pero las tres letras están en los dos casos: la hoja se completa a mano.
  const { textos } = dibujado(await galponPlanillaPDF(sin, { en_blanco: 0 }));
  assert.ok(textos.includes('B / R / M'));
});

t('QUEDAN FILAS EN BLANCO para seguir anotando a mano', async () => {
  /* El camión que entra después de imprimir se anota con la lapicera, como
     hoy. Un formulario que sólo sirve si todo está cargado es uno que el día
     que falla la señal no se usa. */
  const { galponPlanillaPDF } = await import('../src/servicios/galponPlanillaPDF.js');
  const buf = await galponPlanillaPDF(DATOS, { en_blanco: 6 });
  const { crudo } = dibujado(buf);
  /* Las celdas son rectángulos: 7 columnas × (2 filas con datos + 6 vacías +
     la cabecera) más el encabezado y las firmas. Se cuentan los `re`. */
  const rects = (crudo.match(/ re\n/g) || []).length;
  assert.ok(rects >= 7 * 9, 'faltan filas en blanco: ' + rects + ' celdas');
  // Y con en_blanco en 0 hay menos.
  const corto = dibujado(await galponPlanillaPDF(DATOS, { en_blanco: 0 }));
  assert.ok((corto.crudo.match(/ re\n/g) || []).length < rects,
    'el parámetro en_blanco no hace nada');
});

t('el número de bolsón y el peso salen en la fila', async () => {
  const { galponPlanillaPDF } = await import('../src/servicios/galponPlanillaPDF.js');
  const { textos } = dibujado(await galponPlanillaPDF(DATOS, {}));
  assert.ok(textos.includes('6,90'), 'el peso no sale con dos decimales');
  assert.ok(textos.includes('14,30'));
  assert.ok(textos.includes('La Estación'));
  assert.ok(textos.includes('golpeado'), 'se perdió la observación');
  // El viaje se escribe UNA vez, en la primera fila de su grupo.
  assert.equal(textos.filter((x) => x === '5').length, 1,
    'el número de viaje se repite en cada fila');
});

t('una planilla de un día SIN NADA sale igual, para llenar a mano', async () => {
  const { galponPlanillaPDF } = await import('../src/servicios/galponPlanillaPDF.js');
  const { textos, crudo } = dibujado(await galponPlanillaPDF(
    { fecha: '2026-11-02', version: '02', viajes: [], total: {} }, { en_blanco: 10 }));
  assert.match(textos.join(' | '), /REGISTRO DE CONTROL EN GALPÓN/);
  assert.ok((crudo.match(/ re\n/g) || []).length > 70, 'no dibujó la grilla vacía');
  // Sin filas no hay total: una hoja en blanco no dice «0 kg».
  assert.ok(!textos.some((x) => /Total del día/.test(x)));
});

t('con MUCHAS filas se pagina y cada hoja lleva su encabezado', async () => {
  // Un día de cosecha fuerte son cien cajones. Cada hoja de un documento
  // controlado tiene que poder leerse sola: con su versión y sus firmas.
  const { galponPlanillaPDF } = await import('../src/servicios/galponPlanillaPDF.js');
  const muchos = Object.assign({}, DATOS, {
    viajes: [{ viaje: 5, bultos: 100, kilos: 1000,
      filas: Array.from({ length: 100 }, (_, i) => ({
        n: i + 1, finca: 'La Estación', lote: '10', kilos: 10, sanitario: 'B' })) }],
    total: { kilos: 1000, bultos: 100, viajes: 1 },
  });
  const buf = await galponPlanillaPDF(muchos, {});
  const { textos } = dibujado(buf);
  const hojas = textos.filter((x) => /REGISTRO DE CONTROL EN GALPÓN/.test(x)).length;
  assert.ok(hojas >= 3, 'no paginó: ' + hojas + ' encabezados para 100 filas');
  assert.equal(textos.filter((x) => x === 'Firma:').length, hojas * 3,
    'alguna hoja quedó sin las tres firmas');
  assert.ok(textos.some((x) => /Página 1 de/.test(x)));
});

t('el PDF no lleva emojis: Helvetica los dibuja como basura', async () => {
  const { galponPlanillaPDF } = await import('../src/servicios/galponPlanillaPDF.js');
  const { textos } = dibujado(await galponPlanillaPDF(DATOS, {}));
  const basura = textos.filter((x) => /[ØÜß][\u0000-ÿ]/.test(x));
  assert.deepEqual(basura, [], 'hay emojis dibujados como basura');
});

t('nada se dibuja fuera de la hoja', async () => {
  const { galponPlanillaPDF } = await import('../src/servicios/galponPlanillaPDF.js');
  const { crudo } = dibujado(await galponPlanillaPDF(DATOS, { en_blanco: 40 }));
  const pts = [];
  for (const m of crudo.matchAll(/([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re/g)) {
    pts.push([+m[1], +m[2]], [+m[1] + +m[3], +m[2] + +m[4]]);
  }
  for (const m of crudo.matchAll(/([\d.-]+) ([\d.-]+) Td/g)) pts.push([+m[1], +m[2]]);
  const fuera = pts.filter(([x, y]) => x < -1 || y < -1 || x > 596 || y > 843);
  assert.deepEqual(fuera.slice(0, 3), [], fuera.length + ' puntos fuera de la A4');
});

t('la fecha no se corre un día', async () => {
  // Una fecha sola, sin hora, la toma como UTC de medianoche: parada en
  // Argentina eso se muestra como el día anterior.
  const { fechaLarga } = await import('../src/servicios/galponPlanillaPDF.js');
  assert.equal(fechaLarga('2026-11-02'), '02/11/2026');
  assert.equal(fechaLarga('2026-01-01'), '01/01/2026');
  assert.equal(fechaLarga(''), '');
});
