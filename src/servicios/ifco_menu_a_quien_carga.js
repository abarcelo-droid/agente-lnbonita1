// src/servicios/ifco_menu_a_quien_carga.js
// ── CERRAR IFCO SIN DEJAR A NADIE SIN TRABAJAR ─────────────────────────────
//
// EL PROBLEMA. La app de celular de IFCO (src/mifco.html, servida en /m/ifco)
// escribe en seis direcciones: sellar un remito, mandar una recepción, cargar
// stock real, el OCR. Esas direcciones NO tienen control de nivel, o sea que
// cualquiera con sesión puede llamarlas. Para ponérselo hay que declarárselas al
// menú "IFCOs" — pero la app NO ES UN MENÚ: si el galponero que sella remitos
// desde el teléfono no tiene ese menú tildado, al declararlas se queda sin poder
// trabajar. Y por eso quedaron abiertas 22 escrituras.
//
// LA SALIDA, SIN PREGUNTARLE A NADIE. La respuesta ya está en los datos: quien
// cargó un remito o una recepción ES alguien que hace ese trabajo. Así que en
// vez de averiguar a quién hay que tildarle el menú, se le tilda solo — y recién
// después se cierra la puerta. Nadie pierde acceso, porque el acceso se le da
// mirando lo que efectivamente hizo.
//
// NO ES REGALAR PERMISOS. Se le da el menú a quien YA venía haciendo ese
// trabajo, con nivel "operar" (no "anular": borrar sigue siendo de otro). Si
// alguno no corresponde, se destilda desde Usuarios y listo — y como esto corre
// UNA SOLA VEZ, no se lo vuelve a poner en el próximo despliegue.
//
// Descubre las tablas solo: cualquier ifco_* que tenga usuario_id. Así no hay
// una lista de nombres que se desactualice cuando se agregue una tabla nueva.
import db from './db.js';

const MARCA = 'ifco_menu_a_quien_carga_v1';
const MENU  = 'ab-ifcos';

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sistema_flags (
      key          TEXT PRIMARY KEY,
      valor        TEXT,
      ejecutado_en TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  const yaCorrio = db.prepare('SELECT key FROM sistema_flags WHERE key = ?').get(MARCA);
  const hayTabla = (t) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

  if (yaCorrio || !hayTabla('usuario_modulos') || !hayTabla('modulos_config')) {
    // Ya corrió, o el esquema de permisos todavía no existe. Silencio.
  } else if (!db.prepare('SELECT 1 FROM modulos_config WHERE modulo = ?').get(MENU)) {
    console.warn(`[IFCO] No existe el menú ${MENU}: no se reparten accesos.`);
  } else {
    // ── Quién cargó algo por IFCO, alguna vez ────────────────────────────
    const tablas = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ifco@_%' ESCAPE '@'
    `).all().map(r => r.name);

    const ids = new Set();
    for (const t of tablas) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      for (const col of ['usuario_id', 'creado_por']) {
        if (!cols.includes(col)) continue;
        for (const r of db.prepare(
          `SELECT DISTINCT ${col} AS u FROM ${t} WHERE ${col} IS NOT NULL`).all()) {
          if (Number.isInteger(r.u)) ids.add(r.u);
        }
      }
    }

    const tieneMenu = db.prepare(
      'SELECT 1 FROM usuario_modulos WHERE usuario_id = ? AND modulo = ?');
    const dar = db.prepare(
      "INSERT INTO usuario_modulos (usuario_id, modulo, nivel) VALUES (?, ?, 'operar')");

    const dados = [], yaTenian = [];
    db.transaction(() => {
      for (const id of ids) {
        const u = db.prepare('SELECT id, nombre, rol, activo FROM usuarios WHERE id = ?').get(id);
        if (!u || !u.activo) continue;         // usuario borrado o dado de baja
        if (u.rol === 'admin') continue;       // el admin entra a todo por su rol
        if (tieneMenu.get(id, MENU)) { yaTenian.push(u.nombre); continue; }
        dar.run(id, MENU);
        dados.push(u.nombre);
      }
      db.prepare('INSERT INTO sistema_flags (key, valor) VALUES (?, ?)')
        .run(MARCA, JSON.stringify({ dados: dados.length, ya_tenian: yaTenian.length, tablas: tablas.length }));
    })();

    console.log(`[IFCO] Menú "IFCOs" según quién carga de verdad: ${dados.length} persona(s) ` +
                `lo recibieron, ${yaTenian.length} ya lo tenían (${tablas.length} tabla(s) miradas).`);
    for (const n of dados) console.log(`       + ${n}`);
    if (dados.length) {
      console.log('       Si alguno no corresponde, destildalo en Usuarios: esto no vuelve a correr.');
    }
  }
} catch (e) {
  console.error('[IFCO] Error repartiendo el menú de IFCO:', e.message);
}

export default db;
