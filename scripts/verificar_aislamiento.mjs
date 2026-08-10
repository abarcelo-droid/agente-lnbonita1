// scripts/verificar_aislamiento.mjs
// ── QUE LAS EMPRESAS SIGAN SIN MEZCLARSE ──────────────────────────────────
//
//     node scripts/verificar_aislamiento.mjs
//
// El aislamiento entre San Gerónimo, Puente Cordón y Barceló no lo garantiza una
// promesa: lo garantiza que los datos de cada una viven en tablas con prefijo
// propio y que ningún módulo lee las del otro. Eso hoy se cumple —está verificado—
// pero es exactamente el tipo de cosa que se rompe de a poco: alguien necesita un
// dato, escribe un JOIN "sólo para este informe", y seis meses después nadie sabe
// que ese informe cruza dos empresas.
//
// Esto lo revisa en dos segundos leyendo el código. No necesita base ni servidor.
// Corre en cada cambio grande, y sobre todo antes de dar por buena una pantalla
// nueva que mezcle módulos.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RUTAS = path.join(AQUI, '..', 'src', 'rutas');

// Qué prefijo de tabla es de quién, y qué routers son los dueños legítimos.
const EMPRESAS = [
  {
    nombre: 'San Gerónimo',
    prefijos: ['sg_'],
    // abasto e ifco manejan los módulos ab-*/ifco-*, que en modulos_config están
    // bajo San Gerónimo: son parte del mismo circuito, no otra empresa.
    duenos: [/^sg\b/, /^sg_/, /^abasto/, /^ifco/],
  },
  {
    nombre: 'Puente Cordón',
    prefijos: ['pa_', 'adm_'],
    // scout es pa-scout (Puente Cordón) y por eso lee pa_*.
    // ventas es el caso raro y está anotado abajo: sus MÓDULOS figuran en San
    // Gerónimo, pero escribe los asientos en las tablas contables pa_*, pasando
    // sociedad_id. O sea, la contabilidad de pa_* es COMPARTIDA y separa por
    // empresa con esa columna — no es "las tablas de Puente Cordón".
    duenos: [/^produccion/, /^cuentas/, /^proveedores/, /^pagos/, /^ordenes/,
             /^personal/, /^scout/, /^ventas/],
  },
  {
    nombre: 'Barceló Transporte',
    prefijos: ['bt_'],
    duenos: [/^bt/],
  },
];

// Una consulta de verdad: FROM/INTO/UPDATE/JOIN seguido del nombre de tabla.
const usa = (txt, prefijo) =>
  (txt.match(new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${prefijo}\\w+`, 'gi')) || []).length;

const archivos = fs.readdirSync(RUTAS).filter(f => f.endsWith('.js'));
const problemas = [];

for (const f of archivos) {
  const base = f.replace(/\.js$/, '');
  const txt = fs.readFileSync(path.join(RUTAS, f), 'utf8');

  for (const emp of EMPRESAS) {
    const esDueno = emp.duenos.some(re => re.test(base));
    if (esDueno) continue;
    for (const p of emp.prefijos) {
      const n = usa(txt, p);
      if (n > 0) {
        problemas.push(
          `rutas/${f} consulta ${n} vez/veces tablas ${p}* (${emp.nombre}) y no es un módulo de esa empresa`
        );
      }
    }
  }
}

console.log('');
console.log('  AISLAMIENTO ENTRE EMPRESAS');
console.log('  ' + '─'.repeat(64));
for (const emp of EMPRESAS) {
  const suyos = archivos.filter(f => emp.duenos.some(re => re.test(f.replace(/\.js$/, ''))));
  const cuenta = suyos.reduce((n, f) => {
    const txt = fs.readFileSync(path.join(RUTAS, f), 'utf8');
    return n + emp.prefijos.reduce((m, p) => m + usa(txt, p), 0);
  }, 0);
  console.log(
    `  ${emp.nombre.padEnd(20)} ${String(cuenta).padStart(4)} consultas, ` +
    `desde ${suyos.length} módulo(s): ${suyos.map(s => s.replace(/\.js$/, '')).join(', ')}`
  );
}
console.log('  ' + '─'.repeat(64));

if (problemas.length) {
  console.log('\n  SE MEZCLARON:\n');
  for (const p of problemas) console.log('   · ' + p);
  console.log('\n  Los datos de una empresa se leen desde un módulo de otra. Si el cruce');
  console.log('  hace falta de verdad, el módulo tiene que declararse dueño acá arriba y');
  console.log('  quedar escrito por qué.\n');
  process.exit(1);
}

console.log('\n  Ningún módulo lee las tablas de otra empresa. Se puede seguir.\n');
process.exit(0);
