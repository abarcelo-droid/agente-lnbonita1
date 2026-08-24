#!/usr/bin/env node
// scripts/share_import_masivo.js
// ── CARGA MASIVA DEL BACKLOG DE PLANNINGS ─────────────────────────────────────────────
// Recorre una carpeta, ordena los .xlsx por la fecha que sugiere el nombre y los importa con
// EXACTAMENTE la misma lógica que el botón de la pantalla (share_import.js). Si tuviera la
// suya, el histórico quedaría normalizado distinto de lo que se carga todos los días y
// ningún informe que cruce las dos épocas serviría.
//
// SE PUEDE VOLVER A CORRER LAS VECES QUE HAGA FALTA: la idempotencia es por hash del
// contenido, así que un archivo ya cargado se saltea aunque lo hayan renombrado.
//
//   npm run share:import -- "/ruta/a/los/plannings"
//   npm run share:import -- "/ruta" --dry          (no escribe: sólo dice qué haría)
//
// ── ESTO SÓLO SIRVE DONDE ESTÁ LA BASE ────────────────────────────────────────────────
// `data/clientes.db` vive en el volume de Railway, NO en la máquina de nadie. Corrido desde
// una notebook, db.js hace mkdir + new Database() y CREA una base nueva y vacía: los archivos
// entrarían ahí y no los vería nadie, sin un solo mensaje de error. Por eso lo primero que
// hace el script es verificar que la base exista, y si no está manda a la carga masiva de la
// pantalla, que le habla al servidor que sí la tiene.
//
// El orden CRONOLÓGICO importa: cuando dos archivos cubren el mismo día, el que se carga
// después reemplaza al anterior. Cargarlos en el orden del directorio dejaría activo el
// planning viejo y el corregido marcado como reemplazado — al revés de lo que corresponde.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/clientes.db');
if (!fs.existsSync(BASE)) {
  console.error(`
No encuentro la base de datos:
  ${BASE}

Este script escribe DIRECTO sobre el archivo SQLite, así que hay que correrlo donde ese
archivo está — en Railway. Desde una máquina de escritorio crearía una base nueva y vacía, y
los planning entrarían en un archivo que no mira nadie.

Para cargar el backlog histórico desde tu máquina:
  Panel → SHARE Carrefour → solapa Carga → arrastrá todos los .xlsx de una.
  Se suben de a uno y en orden, y los que ya estén cargados se saltean solos.
`);
  process.exit(1);
}

// El import va DESPUÉS del chequeo a propósito: db.js crea el archivo apenas se lo importa,
// así que importarlo arriba haría que la verificación de recién nunca falle.
const { default: db } = await import('../src/servicios/db_share.js');
const { importar, analizar } = await import('../src/servicios/share_import.js');
const { fechaDelNombre } = await import('../src/servicios/share_parser.js');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const forzar = args.includes('--forzar');
const carpeta = args.find(a => !a.startsWith('--'));

if (!carpeta) {
  console.error('Falta la carpeta.\n  npm run share:import -- "C:\\ruta\\a\\los\\plannings" [--dry] [--forzar]');
  process.exit(1);
}
if (!fs.existsSync(carpeta) || !fs.statSync(carpeta).isDirectory()) {
  console.error(`No existe la carpeta: ${carpeta}`);
  process.exit(1);
}

const archivos = fs.readdirSync(carpeta)
  .filter(f => /\.xlsx?$/i.test(f) && !f.startsWith('~$'))   // ~$ son los temporales de Excel
  .map(f => ({ nombre: f, ruta: path.join(carpeta, f), fecha: fechaDelNombre(f) }))
  // Por fecha del nombre; los que no la tienen van al final, en orden alfabético.
  .sort((a, b) => (a.fecha || '9999').localeCompare(b.fecha || '9999') || a.nombre.localeCompare(b.nombre));

if (!archivos.length) {
  console.error(`No hay ningún .xlsx en ${carpeta}`);
  process.exit(1);
}

console.log(`${archivos.length} archivo(s) en ${carpeta}${dry ? '  [SIMULACIÓN — no se escribe nada]' : ''}\n`);

const t0 = Date.now();
const res = { cargados: 0, duplicados: 0, conflictos: 0, errores: 0, filas: 0, bultos: 0 };
const avisos = [], problemas = [];

for (const a of archivos) {
  let buffer;
  try { buffer = fs.readFileSync(a.ruta); }
  catch (e) { res.errores++; problemas.push([a.nombre, 'no se pudo leer: ' + e.message]); continue; }

  try {
    if (dry) {
      const an = analizar(db, { buffer, nombre: a.nombre });
      if (an.duplicado) { res.duplicados++; console.log(`  = ${a.nombre}  (ya estaba, carga #${an.duplicado.id})`); continue; }
      if (an.conflictos.length) { res.conflictos++; problemas.push([a.nombre, 'se pisa a medias con la carga #' + an.conflictos[0].id]); console.log(`  ! ${a.nombre}  CONFLICTO`); continue; }
      res.cargados++; res.filas += an.filas; res.bultos += an.bultos_total;
      console.log(`  + ${a.nombre}  ${an.fecha_entrega}  ${an.filas} filas  ${Math.round(an.bultos_total).toLocaleString('es-AR')} bultos` +
        (an.reemplaza.length ? `  (reemplazaría ${an.reemplaza.length})` : ''));
      for (const w of an.warnings) avisos.push([a.nombre, w]);
      continue;
    }

    const r = importar(db, { buffer, nombre: a.nombre, usuario: 'carga masiva', forzar });
    if (r.salteado === 'duplicado') { res.duplicados++; console.log(`  = ${a.nombre}  (ya estaba, carga #${r.carga_id})`); continue; }
    if (!r.ok) { res.conflictos++; problemas.push([a.nombre, r.error]); console.log(`  ! ${a.nombre}  CONFLICTO`); continue; }

    const an = r.analisis;
    res.cargados++; res.filas += an.filas; res.bultos += an.bultos_total;
    console.log(`  + ${a.nombre}  ${an.fecha_entrega}  ${an.filas} filas  ${Math.round(an.bultos_total).toLocaleString('es-AR')} bultos` +
      (an.reemplaza.length ? `  (reemplazó ${an.reemplaza.length})` : '') +
      (an.articulos_nuevos.length ? `  +${an.articulos_nuevos.length} art. nuevos` : '') +
      (an.proveedores_nuevos.length ? `  +${an.proveedores_nuevos.length} prov. nuevos` : ''));
    for (const w of an.warnings) avisos.push([a.nombre, w]);

  } catch (e) {
    // Un archivo roto NO corta el backlog: se anota y se sigue con el resto. Cortar dejaría
    // 400 archivos sin cargar por culpa de uno, y habría que descubrir cuál a mano.
    res.errores++; problemas.push([a.nombre, e.message]);
    console.log(`  ✗ ${a.nombre}  ${e.message}`);
  }
}

const seg = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${'─'.repeat(78)}`);
console.log(`Cargados: ${res.cargados}   Ya estaban: ${res.duplicados}   Conflictos: ${res.conflictos}   Errores: ${res.errores}   (${seg}s)`);
if (res.cargados) console.log(`Entraron ${res.filas.toLocaleString('es-AR')} filas / ${Math.round(res.bultos).toLocaleString('es-AR')} bultos.`);

if (avisos.length) {
  console.log(`\nAVISOS (${avisos.length}) — la carga entró igual:`);
  for (const [f, w] of avisos.slice(0, 40)) console.log(`  · ${f}: ${w}`);
  if (avisos.length > 40) console.log(`  … y ${avisos.length - 40} más.`);
}
if (problemas.length) {
  console.log(`\nNO ENTRARON (${problemas.length}):`);
  for (const [f, w] of problemas) console.log(`  ✗ ${f}: ${w}`);
  console.log('\nLos conflictos se resuelven dando de baja la carga que se pisa desde la pantalla');
  console.log('de Cargas, o volviendo a correr con --forzar si ya sabés cuál vale.');
}

if (!dry) {
  const est = db.prepare(`SELECT COUNT(*) cargas, MIN(fecha_entrega) desde, MAX(fecha_entrega) hasta
    FROM share_cargas WHERE estado='activa'`).get();
  const l = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(bultos),0) b FROM share_v').get();
  const pend = db.prepare('SELECT COUNT(*) n FROM share_articulos WHERE pendiente_revision=1').get().n;
  console.log(`\nLa base quedó con ${est.cargas} carga(s) activa(s), del ${est.desde} al ${est.hasta}: ` +
    `${l.n.toLocaleString('es-AR')} líneas, ${Math.round(l.b).toLocaleString('es-AR')} bultos.`);
  if (pend) console.log(`Hay ${pend} artículo(s) esperando mapeo en la solapa Mapeos (marcar "la vendemos", familia y unidad).`);
}

process.exit(res.errores || res.conflictos ? 1 : 0);
