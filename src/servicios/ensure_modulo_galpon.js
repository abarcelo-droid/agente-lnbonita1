// Registro idempotente del módulo 🏭 Galpón en modulos_config.
//
// El seed de db_org.js hace `if (n > 0) return`: sólo corre con la tabla VACÍA, o sea que
// agregar una fila a ese array no hace nada en producción. Esto corre SIEMPRE.
//
// EL NOMBRE DEL MÓDULO ES TAMBIÉN EL data-sec Y EL id DE LA SECCIÓN:
//   modulos_config.modulo   →  'galpon-config'
//   <div class="ni" data-sec="galpon-config">   (el puente, dentro de <nav>)
//   <div class="sec" id="sec-galpon-config">    (la pantalla)
//
// ── POR QUÉ UN MÓDULO POR PANTALLA Y NO UNO SOLO CON SOLAPAS ────────────────────────
// Una fila de `usuario_modulos` = un ítem de menú = un permiso. El operario que vuelca
// IFCOs tiene que poder entrar al volcado SIN ver la configuración de las cuadrillas ni,
// más adelante, los costos. Con un módulo único y solapas adentro, el permiso es todo o
// nada y la única forma de limitarlo es no dárselo.
//
// Acá se registran los que hay. Los demás (volcado, tablero, costos) entran con su PR.
//
// Y el orden del array NO es decorativo: el sidebar los muestra por `orden`, y el
// galpón se usa de arriba hacia abajo —primero se configura una vez por temporada,
// después se carga el lote todas las mañanas—. Un menú ordenado por cuándo se toca
// cada cosa es un recordatorio del circuito; ordenado alfabéticamente no es nada.
//
// ── Y VA EN SU PROPIO GRUPO ─────────────────────────────────────────────────────────
// No en Abasto SG: el galpón es de Puente Cordón, que produce. San Gerónimo comercializa.
// Son dos empresas y el router tiene el cerrojo puesto sobre Puente Cordón.
import db from './db.js';

try {
  const soc = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE 'Puente Cord%'").get()
           || db.prepare('SELECT id FROM sociedades ORDER BY id LIMIT 1').get();
  const socId = soc ? soc.id : null;
  if (!soc) console.warn('[ORG] ensure_modulo_galpon: no encontré Puente Cordón; va a la primera sociedad');

  // El emoji VA en el label: el sidebar no tiene mapa de íconos para galpon-* y usa el
  // emoji inicial del label.
  const MODULOS = [
    ['galpon-config',   '⚙️ Galpón · Configuración', 700],
    ['galpon-lote-dia', '🗓️ Galpón · Lote del día',  701],
    // La carga de kilos a mano. Va DESPUÉS del lote del día porque ése es el orden en
    // que se usan: a la mañana se declara qué se cosecha, durante el día se cargan los
    // kilos. Y es un módulo aparte y no una solapa del anterior para que el que sólo
    // carga kilos no pueda cambiar el lote declarado.
    ['galpon-carga',    '⚖️ Galpón · Carga de kilos', 702],
  ];

  const ins = db.prepare(
    'INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) '
    + 'VALUES (?,?,?,?,?,?)');
  const upd = db.prepare(
    'UPDATE modulos_config SET label=?, grupo=?, oculto=0 WHERE modulo=?');
  for (const [modulo, label, orden] of MODULOS) {
    ins.run(modulo, label, 'Galpón', socId, 'operativo', orden);
    upd.run(label, 'Galpón', modulo);
  }

  console.log('[ORG] Módulo Galpón verificado en modulos_config');
} catch (e) {
  console.error('[ORG] ensure_modulo_galpon:', e.message);
}
