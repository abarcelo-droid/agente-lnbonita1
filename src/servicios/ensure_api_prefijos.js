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
//
// ── LA REGLA QUE MÁS CARO SALE OLVIDAR ────────────────────────────────────
// ESTO COMPARA POR PREFIJO. Un prefijo sólo sirve si la parte VARIABLE de la
// ruta va al FINAL. Si la ruta real es /abasto/partidas/:id/ajuste, el prefijo
// 'abasto/partidas/ajuste' NO MATCHEA NUNCA — hay un número en el medio.
//
// El daño es doble y silencioso: la pantalla que dependía de ese prefijo se
// queda sin poder trabajar, y la dirección que se quería proteger sigue
// abierta. Nadie se entera, porque el síntoma es "a fulano no le anda el botón".
//
// Antes de agregar un prefijo de tres tramos o más, mirá la ruta en el router:
// si tiene un :id antes del último tramo, declaralo hasta el tramo anterior y
// asumí que se comparte. Es lo que se hizo con 'abasto/partidas'.
const PREFIJOS = [
  // ── Contabilidad de Puente Cordón ──────────────────────────────────────
  ['adm-asientos',       'pa/cuentas/asientos'],
  ['adm-plan-cuentas',   'pa/cuentas,pa/cuentas/secciones,pa/cuentas/titulos,pa/cuentas/config-impositiva'],
  ['adm-modelos',        'pa/cuentas/modelos'],
  ['adm-proveedores',    'pa/proveedores'],
  // La pantalla usa DOS direcciones: el saldo sale de /pa/cc y los pagos de
  // /pa/pagos (dos routers distintos). Si falta una, media pantalla queda sin
  // control.
  ['adm-cc-proveedores', 'pa/cc,pa/pagos'],

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
  // 'sg/contable' a secas va en el Plan de Cuentas y NO sobra: la lista de
  // cuentas cuelga de la raíz del router (GET /api/sg/contable, POST para crear
  // una, /lote, /:id, /:id/mover…) y sin declararla moduloDeRuta devolvía null y
  // exigirNivel dejaba pasar. Se medía: cualquier sesión válida leía el plan de
  // cuentas entero de San Gerónimo. Las tres direcciones más largas de abajo le
  // ganan igual, porque gana el prefijo MÁS LARGO.
  ['sgct-asientos',      'sg/contable/asientos'],
  ['sgct-plan-cuentas',  'sg/contable,sg/contable/secciones,sg/contable/titulos,sg/contable/config-impositiva'],
  ['sgct-modelos',       'sg/contable/modelos'],

  // ── Los tres módulos de una sola empresa, con router propio ────────────
  ['pli-planificacion',  'pli'],
  ['sp-pagos',           'sp'],
  ['fp-flujo',           'fp'],

  // ── Administración del sistema (Familia) ───────────────────────────────
  // 'auth/usuarios' y NO 'auth': ver el comentario de arriba.
  ['maestro-usuarios',   'auth/usuarios,auth/asignar-password-inicial'],
  ['equipo',             'org/personas,org/areas,org/ubicaciones'],

  // ── Producción Agrícola (Puente Cordón) ────────────────────────────────
  // produccion.js tiene 165 rutas y sirve a muchos menús, así que van
  // sub-prefijos. NUNCA 'pa' pelado: se llevaría las 165 y se las daría a uno.
  ['pa-lotes',           'pa/lotes,pa/aplicaciones,pa/cultivos'],
  ['pa-insumos',         'pa/insumos'],
  ['pa-combustible',     'pa/combustible'],
  ['pa-panol',           'pa/panol'],
  ['pa-ordenes',         'pa/ordenes'],
  // /leer-remito es el OCR que dispara la carga de la factura: es la misma acción.
  ['pa-compras',         'pa/compras,pa/leer-remito'],
  ['pa-scout',           'pa/scout'],

  // ── Personal (Puente Cordón) ───────────────────────────────────────────
  // Las 77 rutas /personal/* viven todas en produccion.js y las comparten seis
  // pantallas. Se separan por sub-path.
  ['personal-padron',     'pa/personal/padron,pa/personal/grupos,pa/personal/cuadrillas'],
  ['personal-asistencia', 'pa/personal/asistencias'],
  ['personal-valorizar',  'pa/personal/valorizar,pa/personal/liquidaciones,pa/personal/semanas-pago,pa/personal/pago-masivo,pa/personal/tarifas-persona,pa/personal/tarifas-rol'],
  ['personal-cc',         'pa/personal/cc'],
  ['personal-catalogo',   'pa/personal/rubros,pa/personal/tareas-tipos'],

  // ── Abasto San Gerónimo ────────────────────────────────────────────────
  // Los diez comparten /api/sg. Se separan por sub-path; el desempate por
  // longitud hace que sg/ventas le gane a sg, igual que en el montaje real.
  ['sg-compras',         'sg/recepciones,sg/oc,sg/compra-retroactiva'],
  ['sg-stock',           'sg/lotes,sg/disponibilidad,sg/decomisos'],
  ['sg-ventas',          'sg/despachos,sg/pedidos,sg/ventas'],
  ['sg-catalogo',        'sg/productos,sg/familias,sg/especies,sg/variedades,sg/proveedores,sg/condiciones-pago,sg/envases,sg/config'],
  ['sg-gvariables',      'sg/gastos-globales'],
  ['sg-gastos-directos', 'sg/gastos-directos,sg/gastos-servicio,sg/proveedores-servicio'],
  ['sg-reprocesos',      'sg/reprocesos,sg/transformaciones'],
  ['sg-importacion',     'sg/embarques'],
  // Control Cooperativa es casi todo lectura, pero tiene UNA escritura: asignar
  // la cooperativa de una descarga que entró sin saber de quién fue
  // (POST /sg/control-coop/:id/cooperativa). Esa es la que el prefijo cierra.
  // El GET del listado NO queda cerrado por esto: exigirNivel deja pasar los GET
  // salvo en los prefijos de LECTURA_CONTROLADA (permisos.js), donde /api/sg no
  // está. El prefijo se declara igual, corto: la parte variable va al final, así
  // que '/sg/control-coop/12/cooperativa' matchea con 'sg/control-coop'.
  ['sg-control-coop',    'sg/control-coop,sg/cooperativas'],

  // ═══════════════════════════════════════════════════════════════════════
  // LAS QUE FALTABAN. Se declaran POR QUIÉN ESCRIBE, no por quién llama.
  //
  // Esa distinción es la que hace que esto sea seguro. Muchas direcciones las
  // LEEN pantallas que nunca escriben ahí: /api/abasto/partidas lo leen Stock,
  // Remitos, Gastos y Mandata, pero la única que da de alta partidas es
  // Partidas. Si se declarara "a todos los que la llaman", cualquiera de esas
  // cuatro podría crear partidas — y con /api/auth/usuarios, que lo leen ocho
  // pantallas de Producción, se estarían dando de alta usuarios desde el padrón
  // de personal. Como el nivel hoy sólo se aplica a las ESCRITURAS, declarar por
  // escritor no le saca nada a nadie: el que sólo lee sigue leyendo igual.
  //
  // Todo esto salió de relevar pantalla por pantalla qué direcciones llama, con
  // archivo y línea. Lo que no se pudo atar a una pantalla quedó sin declarar y
  // está anotado abajo.
  // ═══════════════════════════════════════════════════════════════════════

  // ── Gestión Insumos (Abasto) ──────────────────────────────────────────
  ['ab-gastos',          'abasto/gastos'],
  ['ab-proveedores',     'abasto/proveedores'],
  ['ab-remitos',         'abasto/remitos'],
  // ── HASTA DÓNDE SE PUEDE AFINAR ────────────────────────────────────────
  // El botón "Ajuste" está en Partidas Y en Stock, y su dirección es
  // /api/abasto/partidas/:id/ajuste. Sería lindo declarar sólo ese tramo a
  // Stock y dejarle el alta de partidas a Partidas, pero NO SE PUEDE: la
  // variable está en el MEDIO, y esto compara por prefijo. 'abasto/partidas/
  // ajuste' no matchea nunca, y el efecto sería dejar a Stock sin poder
  // ajustar — un menú que hoy funciona, roto en silencio.
  // Así que el prefijo va entero a las dos pantallas. Se gana precisión donde
  // se puede y se es honesto donde no: Stock queda pudiendo dar de alta una
  // partida, que es de su mismo grupo y su mismo trabajo.
  ['ab-partidas',        'abasto/partidas'],
  ['ab-stock',           'abasto/partidas,abasto/mandatas,abasto/caja'],
  ['ab-mandata',         'abasto/mandatas,abasto/caja'],
  // IFCO: sólo los tramos que escribe ÚNICAMENTE el panel. Los que también usa
  // la app de celular quedan afuera a propósito — ver la nota al final.
  // 'ifco' A SECAS, y ahora sí: cubre TODAS las direcciones de IFCO, incluidas
  // las seis que usa la app de celular. Antes quedaban afuera porque la app no
  // es un menú y no había a quién tildárselo — el que sellaba remitos desde el
  // teléfono se habría quedado sin poder trabajar. Eso lo resuelve la migración
  // ifco_menu_a_quien_carga.js, que le da el menú "IFCOs" a quien YA venía
  // cargando por ahí, mirando los datos. Primero se reparte el acceso, después
  // se cierra la puerta.
  ['ab-ifcos',           'ifco'],
  ['ab-liquidaciones',   'liquidaciones'],

  // ── Comercial ─────────────────────────────────────────────────────────
  // Las seis pantallas de clientes son literalmente la misma función
  // —loadCli(tipo, tabla)— así que todas escriben en /api/clientes. Pedidos,
  // Remitos IFCO, Mandata y Stock la leen, y por eso NO están acá.
  ['may-a',              'clientes'],
  ['may-mcba',           'clientes'],
  ['min-mcba',           'clientes'],
  ['min-ent',            'clientes'],
  ['food',               'clientes'],
  ['cons-final',         'clientes'],
  ['pedidos',            'pedidos'],
  ['crm',                'crm'],
  ['dedicados',          'dedicados,crm'],   // guardar un dedicado con teléfono da de alta en CRM
  ['repet',              'enviar-repeticion'],

  // ── Logística ─────────────────────────────────────────────────────────
  // El cambio de estado de un pedido se dispara desde tres pantallas distintas.
  ['logistica',          'logistica,pedidos'],
  ['preparacion',        'pedidos,abasto/etiqueta'],
  ['envios',             'enviar-listado'],
  ['guardias',           'guardias,turnos-base,comerciales'],

  // ── Pricing y Retail ──────────────────────────────────────────────────
  ['oferta1',            'oferta'],
  ['oferta2',            'oferta'],
  ['pricing1',           'oferta/precio'],
  ['pricing2',           'oferta/precio'],
  ['retail-gastos',      'retail/gastos'],
  ['retail-prod',        'retail/productos'],

  // ── Cobranzas y el resto ──────────────────────────────────────────────
  ['cobranza',           'cobranza'],
  ['conv',               'conversaciones'],
  ['calendario',         'calendario,buscar'],
  ['ingreso-factura',    'factura'],
  ['admin-actividad',    'admin/actividad'],
  ['tr-dashboard',       'org/enlaces'],
  ['bt-viajes',          'bt/llaves'],
  ['sg-dashboard',       'sg/dashboard'],
  ['sg-reportes',        'sg/reportes'],
];

// ── LO QUE QUEDA SIN NIVEL, Y POR QUÉ ──────────────────────────────────────
// No es olvido: en estos casos la dirección NO alcanza para saber de qué menú se
// trata, y declarar un prefijo compartido bloquearía pantallas que se usan todos
// los días. Protegerlos mal es peor que no protegerlos.
//
//   (La app de celular de IFCO ya NO está en esta lista: se cerró. Ver el
//   comentario de 'ab-ifcos' arriba y la migración ifco_menu_a_quien_carga.js.)
//
//   /api/auth NO se declara nunca: mezcla la administración de usuarios con el
//   circuito de sesión (/auth/me, /auth/logout) que llama TODO el panel, la app
//   de celular y scout.html. Declararlo deja a cualquiera sin poder salir.
//
//   /api/bt/sync lo llama el agente que corre en la máquina de Transoft, no una
//   pantalla. Va sin declarar.
//   pa-dashboard, pa-costos, pa-clima, pa-calendario, sg-dashboard, sg-reportes,
//   personal-reportes → sólo leen, no tienen escrituras propias.
//   pa-despachos y pa-electricidad → pantallas en construcción, sin endpoints.
//   sg/tesoreria (Caja y Bancos de San Gerónimo) → el router existe y está
//     montado, pero TODAVÍA NO HAY PANTALLA: panel.html no lo llama ni una vez,
//     así que no hay módulo de menú al que colgarle el prefijo. Mientras tanto
//     NO queda abierto: sus dieciséis escrituras piden admin y tiene el cerrojo
//     de empresa. El día que se arme la pantalla, declarar acá su prefijo — si
//     no, el nivel Ver/Operar/Anular no se le aplica.
//
// UNA QUE NECESITA UNA DECISIÓN, NO CÓDIGO:
//   · POST /personal/permisos, /personal/acceso-sensible y /personal/admin son
//     transversales al módulo Personal y no son de ninguna de sus seis pantallas.
//
// Para cerrarlos hay que separarles las rutas a los routers compartidos. Es
// trabajo prolijo y sin decisiones, pero es otro cambio.


// ── LO QUE UNA PANTALLA PUEDE LEER SIN QUE SEA SUYO ────────────────────────
// Desde ahora el nivel también se aplica a las LECTURAS, pero sólo en las
// direcciones donde se pudo verificar quién lee (ver LECTURA_CONTROLADA en
// permisos.js: la plata y los sueldos). Estas dos son las pantallas que leen
// ahí adentro sin ser dueñas — se relevaron mirando TODAS las llamadas del
// panel a esos prefijos, una por una, no por convención de nombres.
//
// Va en una columna aparte de api_prefijos a propósito: adentro de ésa,
// "puede leer" se convertiría en "puede escribir". Pañol necesita el padrón
// para saber a quién le entrega una herramienta, y no por eso tiene que poder
// tocar un legajo.
const LECTURA = [
  // panel.html:26950 — pnInit lee el padrón para poblar el selector de a quién
  // se le entrega la herramienta.
  ['pa-panol',              'pa/personal/padron'],

  // LAS SEIS PANTALLAS DE PERSONAL SE LEEN ENTRE ELLAS AL ABRIR.
  // ppCargarBase (panel.html:24916-24926) trae el padrón, los rubros y los
  // tipos de tarea PARA LAS SEIS, sin importar en cuál estés parado: son los
  // datos con los que se dibujan los desplegables. Las escrituras sí están bien
  // repartidas —el padrón lo escribe Padrón, los rubros el Catálogo— y eso no se
  // toca. Sin estas líneas, Asistencia se abría vacía para quien no tuviera
  // además tildado Padrón.
  ['personal-padron',       'pa/personal/rubros,pa/personal/tareas-tipos'],
  ['personal-catalogo',     'pa/personal/padron'],
  ['personal-asistencia',   'pa/personal/padron,pa/personal/rubros,pa/personal/tareas-tipos'],
  ['personal-valorizar',    'pa/personal/padron,pa/personal/rubros,pa/personal/tareas-tipos'],
  ['personal-cc',           'pa/personal/padron,pa/personal/rubros,pa/personal/tareas-tipos'],
  ['personal-reportes',     'pa/personal/padron,pa/personal/rubros,pa/personal/tareas-tipos'],

  // Control Cooperativa arma su filtro con el catálogo de cooperativas, que es
  // de Gastos Directos. Hoy no hace falta —/api/sg no está en la lista de
  // lecturas controladas de permisos.js, así que el GET pasa igual— pero la
  // dependencia queda declarada: el día que /api/sg se cierre para lectura,
  // esta pantalla no se abre vacía sin que nadie entienda por qué.
  ['sg-control-coop',       'sg/proveedores-servicio'],
];

try {
  // La columna la crea db_org.js, pero ESTE archivo lo importa db_org ANTES de
  // correr su propio cuerpo (los import se hoistean), así que acá todavía puede
  // no existir. Sin esto el UPDATE fallaba y el try/catch se lo comía: las
  // lecturas declaradas no se aplicaban y nadie se enteraba.
  try { db.exec('ALTER TABLE modulos_config ADD COLUMN api_lectura TEXT'); } catch (_) {}

  const upd = db.prepare('UPDATE modulos_config SET api_prefijos = ? WHERE modulo = ?');
  const updLec = db.prepare('UPDATE modulos_config SET api_lectura = ? WHERE modulo = ?');
  const hay = db.prepare('SELECT 1 FROM modulos_config WHERE modulo = ?');
  let n = 0;
  const faltan = [];
  db.transaction(() => {
    for (const [modulo, prefijos] of PREFIJOS) {
      if (!hay.get(modulo)) { faltan.push(modulo); continue; }
      n += upd.run(prefijos, modulo).changes;
    }
    for (const [modulo, prefijos] of LECTURA) {
      if (!hay.get(modulo)) { faltan.push(modulo + ' (lectura)'); continue; }
      updLec.run(prefijos, modulo);
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

// ── UNA SOLA PANTALLA DE PLAN DE CUENTAS EN PUENTE CORDÓN ──────────────────
// Había DOS sobre la misma dirección: 'pa-cuentas' y 'adm-plan-cuentas'. Además
// de confundir —dos menús que muestran lo mismo y se pisan— hacían que la
// dirección no se pudiera declarar a ninguna, porque declarársela a una dejaba
// a la otra sin poder trabajar. Seis escrituras sin control por una duplicación.
//
// Queda 'adm-plan-cuentas', que es la que tiene modo edición y arrastre — la
// misma estructura que la de San Gerónimo, que se clonó de ella. 'pa-cuentas'
// no tiene nada de eso.
//
// Se OCULTA, no se borra: la fila queda por si alguien le tenía permisos, y
// volver atrás es poner oculto = 0.
try {
  const r = db.prepare("UPDATE modulos_config SET oculto = 1 WHERE modulo = 'pa-cuentas' AND oculto = 0").run();
  if (r.changes) {
    console.log('[NIVEL] Plan de Cuentas de Puente Cordón: se retiró la pantalla duplicada ' +
                '(pa-cuentas). Queda adm-plan-cuentas, que es la que se puede editar.');
  }
} catch (e) { console.error('[NIVEL] No se pudo retirar pa-cuentas:', e.message); }
