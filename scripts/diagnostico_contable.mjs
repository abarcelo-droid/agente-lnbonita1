// scripts/diagnostico_contable.mjs
// ── EL DIAGNÓSTICO CONTABLE, DESDE LA CONSOLA ─────────────────────────────
//
//     node scripts/diagnostico_contable.mjs
//     DB_PATH=/data/clientes.db node scripts/diagnostico_contable.mjs
//
// El informe vive en src/servicios/diagnostico_contable.js y sale también por el
// panel (/api/org/diagnostico-contable, solo admin). Acá sólo se abre la base y
// se imprime lo que esa función devuelve: una sola versión del informe, no dos.
//
// SE ABRE EN READONLY A PROPÓSITO. Aunque alguien lo corra contra producción por
// error, la base no lo deja escribir: el modo de apertura lo impide, no la buena
// intención de quien lo corre.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { informeContable } from '../src/servicios/diagnostico_contable.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RUTA = process.env.DB_PATH || path.join(AQUI, '..', 'data', 'clientes.db');

if (!fs.existsSync(RUTA)) {
  console.error(`\n  No encuentro la base en ${RUTA}`);
  console.error('  Si está en otro lado: DB_PATH=/ruta/clientes.db node scripts/diagnostico_contable.mjs\n');
  process.exit(1);
}

const db = new Database(RUTA, { readonly: true });
console.log('  base: ' + RUTA);
// Desde la consola no se puede saber si una migración falló: eso pasa cuando
// arranca el servidor, no acá. Se pasa vacío y el informe lo dice.
console.log(informeContable(db, []));
db.close();
