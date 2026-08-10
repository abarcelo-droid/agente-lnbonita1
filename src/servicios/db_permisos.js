// src/servicios/db_permisos.js
// ── QUIÉN PUEDE VER QUÉ EMPRESA ───────────────────────────────────────────
//
// EL PROBLEMA QUE RESUELVE
// Hasta acá la empresa activa vivía en el navegador (localStorage) y el servidor
// le creía: getSociedadId() tomaba el sociedad_id del pedido y sólo verificaba que
// ESA SOCIEDAD EXISTIERA, no que quien la pedía tuviera derecho a verla. Con eso,
// cambiar un valor en el navegador alcanzaba para leer los datos de otra empresa.
//
// El pedido del dueño es explícito y es el mismo que rigió el aislamiento de
// Barceló: cada empresa es autónoma y la información NO se mezcla. Para que eso
// sea verdad hace falta que la empresa la decida el SERVIDOR, y para decidirla
// tiene que saber a qué empresas pertenece cada persona. Eso es esta tabla.
//
// POR QUÉ UNA TABLA Y NO UNA COLUMNA
// Una persona puede trabajar en más de una empresa —el dueño está en las tres, la
// contadora en dos— así que "la sociedad del usuario" no es un dato único. Con una
// columna habría que elegir una y perder el resto.
//
// SIN FOREIGN KEYS, como el resto del sistema: con foreign_keys=ON, una FK hacia
// usuarios o sociedades haría fallar el DELETE de esas tablas. Se limpia al borrar
// el usuario, desde el propio endpoint.
import db from './db.js';
import './db_org.js';   // 'sociedades' tiene que existir antes de sembrar

db.exec(`
  CREATE TABLE IF NOT EXISTS usuario_sociedades (
    usuario_id   INTEGER NOT NULL,
    sociedad_id  INTEGER NOT NULL,
    creado_en    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    creado_por_id INTEGER,
    PRIMARY KEY (usuario_id, sociedad_id)
  );
  CREATE INDEX IF NOT EXISTS idx_usoc_usuario ON usuario_sociedades(usuario_id);

  -- ── QUÉ PUEDE HACER EN CADA MENÚ ────────────────────────────────────────
  -- Un permiso por (persona, módulo). Que la fila exista es el tilde: sin fila,
  -- no entra. El nivel dice hasta dónde llega adentro.
  --
  -- Tres niveles y no dos, porque la diferencia entre mirar y cargar es tan real
  -- como la que hay entre cargar y borrar:
  --   ver    → entra y mira. No puede tocar nada.
  --   operar → carga y edita. Es lo normal.
  --   borrar → además puede borrar o anular.
  --
  -- Borrar va aparte a propósito: es la única acción que destruye trabajo hecho, y
  -- en un sistema donde nada se borra de verdad (todo es baja lógica) igual deja
  -- afuera de los informes algo que alguien cargó. No es "editar un poco más".
  CREATE TABLE IF NOT EXISTS usuario_modulos (
    usuario_id   INTEGER NOT NULL,
    modulo       TEXT    NOT NULL,
    nivel        TEXT    NOT NULL DEFAULT 'operar'
                      CHECK(nivel IN ('ver','operar','borrar')),
    creado_en    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    creado_por_id INTEGER,
    PRIMARY KEY (usuario_id, modulo)
  );
  CREATE INDEX IF NOT EXISTS idx_umod_usuario ON usuario_modulos(usuario_id);
`);

// ── SIEMBRA: NADIE PIERDE ACCESO EL DÍA QUE ESTO SE DESPLIEGA ─────────────
// Es la regla que hace que esto se pueda soltar sin avisar a nadie: al arrancar,
// cada usuario que todavía no tenga ninguna empresa asignada las recibe TODAS. El
// comportamiento del sistema no cambia en absoluto.
//
// Restringir es después, a mano y de a uno, desde la pantalla de usuarios. Al
// revés —desplegar cerrado y abrir de a uno— la gente llega a la mañana y no puede
// trabajar, y el que arregla eso a las apuradas termina dando permisos de más.
//
// La condición es "sin NINGUNA empresa", no "sin ESTA empresa": una vez que a
// alguien se le sacó una empresa a propósito, el arranque no se la devuelve.
try {
  const usuarios = db.prepare('SELECT id FROM usuarios').all();
  const socs = db.prepare('SELECT id FROM sociedades WHERE activa = 1').all();
  if (usuarios.length && socs.length) {
    const tiene = db.prepare('SELECT 1 FROM usuario_sociedades WHERE usuario_id = ? LIMIT 1');
    const ins = db.prepare(
      'INSERT OR IGNORE INTO usuario_sociedades (usuario_id, sociedad_id) VALUES (?,?)'
    );
    let nuevos = 0;
    db.transaction(() => {
      for (const u of usuarios) {
        if (tiene.get(u.id)) continue;
        for (const s of socs) ins.run(u.id, s.id);
        nuevos++;
      }
    })();
    if (nuevos) {
      console.log(`[PERM] ${nuevos} usuario(s) sin empresas asignadas: se les dieron las ${socs.length}.`);
    }
  }
} catch (e) {
  console.error('[PERM] Error sembrando usuario_sociedades:', e.message);
}

// ── RED DE SEGURIDAD: SECCIONES VIEJAS QUE NO APUNTAN A NINGÚN MÓDULO ────
// El campo `usuarios.secciones` existía desde antes, pero estaba ANULADO: auth.js
// forzaba ['*'] para todos, así que nadie miraba lo que había guardado ahí. Al
// volver a hacerlo valer, cualquier lista con nombres de módulos que ya no existen
// deja a esa persona sin menú — llega a la mañana y no puede trabajar.
//
// Por eso, sólo si NINGUNA de sus secciones corresponde a un módulo actual, se le
// devuelve el acceso completo y se avisa. Una lista que apunta a módulos reales se
// respeta: esa la configuró alguien a propósito.
try {
  const modulos = new Set(db.prepare('SELECT modulo FROM modulos_config').all().map(r => r.modulo));
  if (modulos.size) {
    const arreglados = [];
    const upd = db.prepare("UPDATE usuarios SET secciones = '[\"*\"]' WHERE id = ?");
    db.transaction(() => {
      for (const u of db.prepare('SELECT id, nombre, secciones FROM usuarios').all()) {
        let v;
        try { v = JSON.parse(u.secciones || '["*"]'); } catch { v = null; }
        if (!Array.isArray(v) || v.includes('*')) continue;      // ya ve todo
        if (v.some(sec => modulos.has(sec))) continue;           // apunta a módulos reales
        upd.run(u.id);
        arreglados.push(u.nombre);
      }
    })();
    if (arreglados.length) {
      console.log(`[PERM] ${arreglados.length} usuario(s) tenían secciones que no existen ` +
                  `(${arreglados.slice(0, 5).join(', ')}): se les devolvió el acceso completo ` +
                  `para que no queden sin menú. Configuralos desde la pantalla de usuarios.`);
    }
  }
} catch (e) {
  console.error('[PERM] Error revisando secciones viejas:', e.message);
}

console.log('[PERM] Permisos por empresa inicializados');

export default db;
