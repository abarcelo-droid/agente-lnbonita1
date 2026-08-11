// CADA ÍTEM DEL MENÚ PERTENECE A UNA EMPRESA
//
// Regla del dueño: "cada item del menu debe quedar en una de las empresas.
// Informes consolidados van a Familia."
//
// Quedaban seis módulos con sociedad_id en NULL, que significa "se ve desde
// cualquier empresa". Mientras existía la opción "Todas" en el selector eso no
// molestaba; ahora que el selector manda —siempre hay una empresa elegida y el
// menú muestra sólo lo suyo— un módulo sin empresa es un ítem que aparece en las
// cuatro y no se sabe sobre qué datos trabaja.
//
// A cada uno se le puso la empresa DE SUS DATOS, no la que quedaba cómoda:
//
//   inicio           → San Gerónimo. No es un tablero neutro: muestra pedidos
//                      del día, clientes activos, el CRM de Dedicados y los
//                      últimos pedidos. Son los datos del negocio comercial.
//                      Las otras tres empresas necesitan su propio Inicio, y eso
//                      es trabajo aparte: no se puede repartir lo que no existe.
//   calendario       → San Gerónimo. Es el calendario estacional por producto,
//                      armado sobre el historial de ventas.
//   conv             → San Gerónimo. Las conversaciones de WhatsApp del negocio.
//   ingreso-factura  → Puente Cordón. Carga facturas de compra contra pa_compras
//                      y genera el asiento en pa_asientos.
//   equipo           → Familia. Organigrama: se administra desde el holding.
//   maestro-usuarios → Familia. Usuarios y permisos, idem.
//
// Sólo se mueven los que siguen en NULL: si un admin ya le asignó empresa a
// alguno desde la pantalla de módulos, esa decisión es más nueva y manda.
import db from "./db.js";

const ASIGNACIONES = [
  ['inicio',           'San Ger%',     'el tablero comercial: pedidos, clientes y CRM'],
  ['calendario',       'San Ger%',     'calendario estacional sobre el historial de ventas'],
  ['conv',             'San Ger%',     'conversaciones de WhatsApp del negocio'],
  ['ingreso-factura',  'Puente Cord%', 'carga facturas en pa_compras y arma el asiento'],
  ['equipo',           'Familia',      'organigrama: se administra desde el holding'],
  ['maestro-usuarios', 'Familia',      'usuarios y permisos: idem'],
];

try {
  const upd = db.prepare(
    'UPDATE modulos_config SET sociedad_id = ? WHERE modulo = ? AND sociedad_id IS NULL');
  const buscar = db.prepare('SELECT id, nombre FROM sociedades WHERE nombre LIKE ?');
  let n = 0;
  const sinEmpresa = [];
  db.transaction(() => {
    for (const [modulo, patron] of ASIGNACIONES) {
      const soc = buscar.get(patron);
      if (!soc) { sinEmpresa.push(`${modulo} (no encontré "${patron}")`); continue; }
      n += upd.run(soc.id, modulo).changes;
    }
  })();
  if (n) console.log(`[MOD] ${n} módulo(s) que no tenían empresa fueron asignados a la suya.`);
  if (sinEmpresa.length) {
    console.warn(`[MOD] ${sinEmpresa.length} sin asignar porque falta la sociedad: ${sinEmpresa.join(', ')}`);
  }

  // Aviso, no arreglo: si queda alguno sin empresa va a aparecer en el menú de
  // las cuatro. Se avisa por nombre para poder decidirlo a mano en vez de que
  // pase inadvertido.
  const huerfanos = db.prepare(
    "SELECT modulo, label FROM modulos_config WHERE sociedad_id IS NULL AND oculto = 0").all();
  if (huerfanos.length) {
    console.warn(`[MOD] ${huerfanos.length} módulo(s) siguen SIN empresa y se ven desde todas: ` +
                 huerfanos.map(h => h.modulo).join(', '));
  }
} catch (e) {
  console.error('[MOD] Error asignando empresa a los módulos sueltos:', e.message);
}

export default db;
