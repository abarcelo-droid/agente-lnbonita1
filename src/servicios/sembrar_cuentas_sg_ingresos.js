// src/servicios/sembrar_cuentas_sg_ingresos.js
// ── LAS PRIMERAS CUENTAS DE INGRESOS DE SAN GERÓNIMO ──────────────────────
//
// El plan de San Gerónimo arrancó con el esqueleto de secciones y títulos
// copiado de Puente Cordón y CERO cuentas: ésas las carga el contable. Estas
// seis son las primeras, pedidas por nombre para la sección 4.01 de Ingresos.
//
// Va como siembra de arranque y no "que las cargue él con el botón" por una
// razón concreta: yo no tengo acceso a la base de producción, así que no puedo
// verificar el resultado. Dejándolo acá, el próximo despliegue las carga y el
// log dice exactamente qué pasó. El botón "+ Varias cuentas" de la pantalla
// hace lo mismo y queda para las ~250 que faltan.
//
// ── CORRE UNA SOLA VEZ ────────────────────────────────────────────────────
// Con una marca en `sistema_flags`, que es el mecanismo que ya usa el repo
// (db_pa.js:1809, :3604). Importa que sea una MARCA y no "¿ya están las
// cuentas?": él dijo "yo después las acomodo", o sea que las va a renombrar,
// mover o borrar. Cualquiera de esas cosas haría que un chequeo por contenido
// las volviera a crear en el próximo despliegue, y aparecerían solas cuentas
// que él ya había sacado.
//
// ── QUÉ HACE SI NO ENCUENTRA LA 4.01 ──────────────────────────────────────
// NADA, y lo avisa. Crear una sección adivinando el nombre sería meter en el
// plan de cuentas una fila que nadie pidió. Si no está, él la crea desde la
// pantalla y carga las seis con el botón.
import db from './db_sg_finanzas.js';

const MARCA = 'sg_cuentas_ingresos_401_v1';
const SECCION = '4.01';

// Tal cual las pidió, con su puntuación y sus acentos.
const CUENTAS = [
  'I - Climatización',
  'Descarga Ganadas . Liquidaciones',
  'Elementos Empaque - Liquidaciones',
  'Fletes Ganados - Liquidaciones',
  'Comisiones Ganadas - Liquidaciones',
  'VENTAS',
];

// Mismo criterio que el alta por lote: sin mayúsculas ni espacios de más, que
// es como se duplican las cuentas en la vida real.
const clave = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sistema_flags (
      key          TEXT PRIMARY KEY,
      valor        TEXT,
      ejecutado_en TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  if (db.prepare('SELECT key FROM sistema_flags WHERE key = ?').get(MARCA)) {
    // Ya corrió. Silencio: esto pasa en cada despliegue a partir del segundo.
  } else {
    const sec = db.prepare('SELECT * FROM sg_cuentas_secciones WHERE codigo = ?').get(SECCION);

    if (!sec) {
      // Sin marca: se reintenta en el próximo arranque, por si para entonces la
      // sección existe.
      console.warn(
        `[SG] No se cargaron las ${CUENTAS.length} cuentas de Ingresos: no existe la sección ` +
        `${SECCION} en el plan de San Gerónimo. Creala desde la pantalla (grupo Ingresos) y ` +
        `cargalas con el botón "+ Varias cuentas", o volvé a desplegar y se cargan solas.`
      );
    } else {
      // El prefijo .00 es el mismo tramo que usa el alta por lote para las
      // cuentas todavía sin título: quedan en "Sin título asignado", que es
      // donde se las puede arrastrar a su lugar definitivo.
      const prefijo = `${sec.codigo}.00`;
      if (!/^\d\.\d{2}$/.test(String(sec.codigo))) {
        throw new Error(`la sección ${sec.codigo} no respeta el formato X.XX`);
      }

      const enUso = (cod) =>
        !!(db.prepare('SELECT 1 FROM sg_cuentas_secciones WHERE codigo = ?').get(cod)
        || db.prepare('SELECT 1 FROM sg_cuentas_titulos   WHERE codigo = ?').get(cod)
        || db.prepare('SELECT 1 FROM sg_cuentas           WHERE codigo = ?').get(cod));

      const yaEstan = new Map();
      for (const c of db.prepare('SELECT codigo, nombre FROM sg_cuentas WHERE seccion_id = ?').all(sec.id)) {
        yaEstan.set(clave(c.nombre), c);
      }

      let ultimo = 0;
      for (const h of db.prepare('SELECT codigo FROM sg_cuentas WHERE codigo LIKE ?').all(prefijo + '.%')) {
        const p = String(h.codigo).split('.');
        if (p.length !== 4) continue;
        const n = parseInt(p[3], 10);
        if (Number.isInteger(n) && n > ultimo) ultimo = n;
      }
      let orden = db.prepare('SELECT COALESCE(MAX(orden), 0) AS m FROM sg_cuentas WHERE seccion_id = ?')
                    .get(sec.id).m;

      const insertar = db.prepare(`
        INSERT INTO sg_cuentas
          (codigo, nombre, seccion_id, titulo_id, tipo, permite_lote, permite_campania, es_sistema, orden, activo)
        VALUES (?, ?, ?, NULL, 'resultado', 0, 0, 0, ?, 1)
      `);
      const anotar = db.prepare(`
        INSERT INTO sg_cuentas_log (cuenta_id, seccion_id, accion, detalle, usuario_id)
        VALUES (?, NULL, 'crear', ?, NULL)
      `);

      const creadas = [], salteadas = [];
      db.transaction(() => {
        let n = ultimo;
        for (const nombre of CUENTAS) {
          const previa = yaEstan.get(clave(nombre));
          if (previa) { salteadas.push(`${nombre} (ya estaba como ${previa.codigo})`); continue; }

          let codigo = null;
          while (n < 9999) {
            n++;
            const cand = `${prefijo}.${String(n).padStart(4, '0')}`;
            if (!enUso(cand)) { codigo = cand; break; }
          }
          if (!codigo) { salteadas.push(`${nombre} (no quedan códigos libres bajo ${prefijo})`); continue; }

          orden += 10;
          const r = insertar.run(codigo, nombre, sec.id, orden);
          anotar.run(r.lastInsertRowid, JSON.stringify({ codigo, nombre, siembra: MARCA }));
          yaEstan.set(clave(nombre), { codigo, nombre });
          creadas.push(`${codigo} ${nombre}`);
        }
        // La marca va DENTRO de la transacción: si algo falla, no queda puesta
        // y el próximo arranque vuelve a intentarlo.
        db.prepare('INSERT INTO sistema_flags (key, valor) VALUES (?, ?)')
          .run(MARCA, JSON.stringify({ seccion: sec.codigo, creadas: creadas.length, salteadas: salteadas.length }));
      })();

      console.log(`[SG] Cuentas de Ingresos en ${sec.codigo} — ${sec.nombre}: ${creadas.length} creada(s).`);
      for (const c of creadas) console.log(`     · ${c}`);
      for (const s of salteadas) console.log(`     (salteada) ${s}`);
      if (sec.grupo !== 'ingresos') {
        console.warn(
          `[SG] OJO: la sección ${sec.codigo} está en el grupo "${sec.grupo}", no en "ingresos". ` +
          `Las cuentas se ven en la pestaña de ese grupo, no en "4 · Ingresos".`
        );
      }
    }
  }
} catch (e) {
  console.error('[SG] Error cargando las cuentas de Ingresos de la sección ' + SECCION + ':', e.message);
}

export default db;
