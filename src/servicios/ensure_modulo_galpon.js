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
  // Sin «Galpón ·» adelante (V1118): los cinco cuelgan del grupo GALPÓN y repetirlo se
  // come la mitad del ancho del renglón. El `upd` de abajo pisa el label en cada
  // arranque, así que cambiar un nombre acá alcanza — no hay que tocar la base.
  const MODULOS = [
    ['galpon-config',   '⚙️ Configuración',  700],
    ['galpon-lote-dia', '🗓️ Lote del día',   701],
    // La carga de kilos a mano. Va DESPUÉS del lote del día porque ése es el orden en
    // que se usan: a la mañana se declara qué se cosecha, durante el día se cargan los
    // kilos. Y es un módulo aparte y no una solapa del anterior para que el que sólo
    // carga kilos no pueda cambiar el lote declarado.
    ['galpon-carga',    '⚖️ Carga de kilos', 702],
    // EL ACUMULADO (V1109). La carga contesta cuánto entró hoy; ésta, cuánto llevamos.
    // Va aparte y no como solapa de la carga porque las miran dos personas distintas:
    // el que pesa mira su día, y el total por cuadrilla de toda la temporada es con lo
    // que se discute un jornal.
    // EL PROCESO (V1112). Va entre la carga y el acumulado porque ése es el orden en
    // que se usa el galpón: entra fruta, se empaca, y al final se mira el rinde.
    ['galpon-proceso',  '📦 Proceso',        703],
    ['galpon-acumulado','📈 Acumulado',      704],
  ];

  const ins = db.prepare(
    'INSERT OR IGNORE INTO modulos_config (modulo, label, grupo, sociedad_id, tipo, orden) '
    + 'VALUES (?,?,?,?,?,?)');
  const upd = db.prepare(
    'UPDATE modulos_config SET label=?, grupo=?, orden=?, oculto=0 WHERE modulo=?');
  for (const [modulo, label, orden] of MODULOS) {
    ins.run(modulo, label, 'Galpón', socId, 'operativo', orden);
    upd.run(label, 'Galpón', orden, modulo);
  }

  console.log('[ORG] Módulo Galpón verificado en modulos_config');
} catch (e) {
  console.error('[ORG] ensure_modulo_galpon:', e.message);
}
