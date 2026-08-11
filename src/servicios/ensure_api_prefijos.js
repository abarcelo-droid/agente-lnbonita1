// QUÉ DIRECCIÓN DE LA API PERTENECE A QUÉ MENÚ
//
// Sin esto, el nivel que el admin marca en Usuarios —Ver, Operar, Anular— NO SE
// APLICA. El guardián existe y está montado, pero para decidir necesita saber a
// qué menú corresponde cada dirección, y esa relación vive en la columna
// modulos_config.api_prefijos, que hasta ahora se creaba vacía y no la llenaba
// nadie. Sin ella el guardián no resuelve el módulo y deja pasar todo.
//
// Consecuencia hasta hoy: el menú le escondía la pantalla al usuario, pero si
// llegaba a la dirección igual —un favorito, un link, la pantalla ya abierta
// cuando le sacaron el permiso— escribía lo mismo. Y el marcado "solo Ver" podía
// anular.
//
// ── POR QUÉ SÓLO ESTOS MÓDULOS ─────────────────────────────────────────────
// Se declaran los que tienen una dirección propia y sin ambigüedad: los
// contables y financieros, que son donde el nivel de verdad protege plata.
//
// Quedan AFUERA a propósito seis routers donde VARIOS menús comparten la misma
// dirección: /api/clientes sirve a seis pantallas comerciales, /api/sg a diez de
// Abasto, /api/retail a cuatro. Ahí la dirección no alcanza para saber de qué
// menú se trata, y declarar el prefijo compartido bloquearía pantallas que la
// gente usa todos los días. Protegerlos mal es peor que no protegerlos: se
// resuelven cuando cada uno tenga su propia ruta.
//
// ── DOS TRAMPAS QUE YA COSTARON CARO ───────────────────────────────────────
// · NUNCA declarar el prefijo pelado de un router que sirve a varios módulos.
//   'pa' agarraría las 165 rutas de producción y se las daría a un solo menú.
// · /api/auth NO se puede mapear entero a Usuarios. Ahí conviven la
//   administración de usuarios y el circuito de sesión de CUALQUIERA: un
//   usuario común con nivel "ver" no podría desloguearse ni cambiar su propia
//   contraseña. Por eso va el sub-prefijo 'auth/usuarios', no 'auth'.
import db, { rehacerTabla } from "./db.js";
// db_permisos crea usuario_modulos: tiene que existir antes de rehacerla.
import "./db_permisos.js";

// modulo → prefijos (separados por coma, sin /api adelante).
// Cada uno verificado contra las rutas reales de su router.
const PREFIJOS = [
  // ── Contabilidad de Puente Cordón ──────────────────────────────────────
  ['adm-asientos',       'pa/cuentas/asientos'],
  ['adm-plan-cuentas',   'pa/cuentas/secciones,pa/cuentas/titulos,pa/cuentas/config-impositiva'],
  ['adm-modelos',        'pa/cuentas/modelos'],
  ['adm-proveedores',    'pa/proveedores'],
  ['adm-cc-proveedores', 'pa/cc'],

  // ── Financiero de Puente Cordón ────────────────────────────────────────
  // Ojo con el orden implícito: /api/fin/ordenes es más largo que /api/fin, y
  // el mecanismo se queda con el más largo, así que Órdenes de Pago le gana a
  // Caja y Bancos aunque los dos matcheen. Verificado.
  ['fin-ordenes-pago',   'fin/ordenes'],
  ['fin-caja-bancos',    'fin'],

  // ── Ventas de Puente Cordón ────────────────────────────────────────────
  ['ven-clientes',       'ven/clientes'],
  ['ven-facturas',       'ven/facturas'],
  ['ven-cobranzas',      'ven/cobranzas'],
  ['ven-liquidaciones',  'ven/liquidaciones'],

  // ── Contabilidad de San Gerónimo ───────────────────────────────────────
  ['sgct-asientos',      'sg/contable/asientos'],
  ['sgct-plan-cuentas',  'sg/contable/secciones,sg/contable/titulos,sg/contable/config-impositiva'],
  ['sgct-modelos',       'sg/contable/modelos'],

  // ── Los tres módulos de una sola empresa, con router propio ────────────
  ['pli-planificacion',  'pli'],
  ['sp-pagos',           'sp'],
  ['fp-flujo',           'fp'],

  // ── Administración del sistema (Familia) ───────────────────────────────
  // 'auth/usuarios' y NO 'auth': ver el comentario de arriba.
  ['maestro-usuarios',   'auth/usuarios,auth/asignar-password-inicial'],
  ['equipo',             'org/personas,org/areas,org/ubicaciones'],
];

try {
  const upd = db.prepare('UPDATE modulos_config SET api_prefijos = ? WHERE modulo = ?');
  const hay = db.prepare('SELECT 1 FROM modulos_config WHERE modulo = ?');
  let n = 0;
  const faltan = [];
  db.transaction(() => {
    for (const [modulo, prefijos] of PREFIJOS) {
      if (!hay.get(modulo)) { faltan.push(modulo); continue; }
      n += upd.run(prefijos, modulo).changes;
    }
  })();
  if (n) console.log(`[NIVEL] ${n} módulo(s) con su dirección de API declarada: el nivel Ver/Operar/Anular ya se aplica ahí.`);
  if (faltan.length) console.warn(`[NIVEL] ${faltan.length} módulo(s) del mapa no existen en modulos_config: ${faltan.join(', ')}`);

  // ── El nivel "borrar" pasa a llamarse "anular" ─────────────────────────
  // Decisión del dueño: "borrar no debería existir, sólo anular". Y es lo que
  // el sistema hace de verdad — casi nada se borra, todo es baja lógica. Que el
  // botón dijera "Borrar" prometía algo que no pasa.
  //
  // La tabla tiene un CHECK que sólo acepta ver/operar/borrar, así que hay que
  // rehacerla. Se usa el helper que revierte entero si algo falla.
  const check = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='usuario_modulos'").get();
  if (check && check.sql && check.sql.includes("'borrar'")) {
    const ok = rehacerTabla('usuario_modulos', `
      CREATE TABLE usuario_modulos_v2 (
        usuario_id   INTEGER NOT NULL,
        modulo       TEXT    NOT NULL,
        nivel        TEXT    NOT NULL DEFAULT 'operar'
                          CHECK(nivel IN ('ver','operar','anular')),
        creado_en    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        creado_por_id INTEGER,
        PRIMARY KEY (usuario_id, modulo)
      );
      INSERT INTO usuario_modulos_v2 (usuario_id, modulo, nivel, creado_en, creado_por_id)
        SELECT usuario_id, modulo,
               CASE WHEN nivel = 'borrar' THEN 'anular' ELSE nivel END,
               creado_en, creado_por_id
          FROM usuario_modulos;
      DROP TABLE usuario_modulos;
      ALTER TABLE usuario_modulos_v2 RENAME TO usuario_modulos;
      CREATE INDEX IF NOT EXISTS idx_umod_usuario ON usuario_modulos(usuario_id);
    `);
    if (ok) console.log('[NIVEL] El nivel "borrar" pasó a llamarse "anular" (es lo que el sistema hace de verdad).');
  }
} catch (e) {
  console.error('[NIVEL] Error declarando las direcciones de API:', e.message);
}

export default db;
