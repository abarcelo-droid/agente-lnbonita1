// src/servicios/sociedad_modulo.js
// ── CADA MÓDULO ESCRIBE EN SU EMPRESA, Y EN NINGUNA OTRA ───────────────────
//
// EL PROBLEMA QUE RESUELVE
// Nueve routers tenían cada uno su propia copia de una función que decidía de
// qué empresa era cada pedido. Las nueve leían sociedad_id del pedido, y si no
// venía —o venía mal— ADIVINABAN: siete caían a Puente Cordón y dos a San
// Gerónimo. Adivinar mal en contabilidad no da error: da un asiento que cuadra
// perfecto en los libros de la empresa equivocada, y se descubre meses después.
//
// Ese patrón causó tres defectos reales en una sola semana: la factura de compra
// que caía en la empresa equivocada, el IVA de una liquidación de Ventas que
// agarraba la cuenta de otra, y la orden de pago que buscaba la cuenta de
// Proveedores sin filtrar empresa.
//
// LA PREGUNTA ESTABA MAL PLANTEADA
// Se relevaron los nueve routers y NINGUNO necesita elegir empresa: seis
// trabajan siempre sobre las tablas de Puente Cordón (pa_*, adm_*, fin_*, ven_*)
// y tres son de una sola empresa por diseño (Planificación Financiera y
// Seguimiento de OP son de San Gerónimo, Planificación de Insumos de Puente
// Cordón). Preguntar "¿de qué empresa es esto?" en un módulo que sólo puede ser
// de una es la puerta por la que entra la equivocada.
//
// Así que esto no decide: CORTA.
//
// LA REGLA, Y POR QUÉ ES ASÍ
//   · No viene empresa en el pedido  → pasa, con la empresa del módulo.
//   · Viene la empresa del módulo    → pasa.
//   · Viene OTRA empresa             → corta con 403 y lo dice con nombre.
//
// El primer caso NO es una concesión: es lo que mantiene todo andando. El
// interceptor del panel que inyecta la empresa cubre sólo seis prefijos de API,
// así que /api/pli, /api/sp y /api/fp NUNCA reciben el dato —está documentado a
// propósito en esos routers—, y con el selector en "Todas" (que es el estado por
// defecto) los GET tampoco lo mandan. Cortar ahí apagaría tres módulos enteros y
// dieciocho pantallas, para todos, incluido el admin.
//
// Lo que se cierra es el caso que de verdad hace daño: alguien parado en San
// Gerónimo apretando un botón que escribe en los libros de Puente Cordón.
//
// POR QUÉ NO SE USA resolverSociedad() DE permisos.js
// Esa función contesta otra pregunta —"¿esta PERSONA puede ver esta empresa?"— y
// necesita req.user. Seis de los nueve routers reciben req.user sólo por efecto
// colateral del orden en que están montados, y cuatro no tienen autenticación en
// ningún endpoint. Montarla tal cual devolvería 403 en el 100% de los pedidos.
// Las dos preguntas conviven: ésta es sobre el MÓDULO, aquélla sobre la PERSONA.
import db from './db.js';

// El id se resuelve una vez y se cachea: no cambia mientras viva el proceso.
const _cache = new Map();

export function empresaDelModulo(nombre) {
  if (_cache.has(nombre)) return _cache.get(nombre);
  // Se busca por nombre exacto y se cae al LIKE porque los nombres reales llevan
  // sufijo societario ("Puente Cordón SA") y en algún seed viejo pueden no
  // tenerlo. Si no está, se devuelve null en vez de inventar un id: un cerrojo
  // que apunta a la empresa equivocada es peor que no tener cerrojo.
  const r = db.prepare('SELECT id, nombre FROM sociedades WHERE nombre = ?').get(nombre)
         || db.prepare('SELECT id, nombre FROM sociedades WHERE nombre LIKE ?').get(nombre.split(' ')[0] + '%');
  const val = r || null;
  if (!val) console.warn(`[SOC] No encontré la sociedad "${nombre}": el cerrojo de ese módulo queda inactivo.`);
  _cache.set(nombre, val);
  return val;
}

// La empresa que pide el navegador, o null si no mandó ninguna.
//
// Devolver null y NO caer a una empresa es la diferencia que importa: quien
// llama sin decirla es el panel de siempre, un script o el lector de
// comprobantes, y tiene que seguir andando. Caer en silencio es lo que mete
// asientos en el libro de otro.
export function empresaPedida(req) {
  const raw = req?.body?.sociedad_id ?? req?.query?.sociedad_id;
  if (raw === undefined || raw === null || raw === '') return null;
  const id = parseInt(raw, 10);
  return Number.isInteger(id) ? id : null;
}

// EL CERROJO. Devuelve el id de la empresa del módulo si el pedido es válido, o
// null si hay que cortar (y en ese caso ya respondió con 403).
//
// Se usa así, al principio de cada endpoint que escribe:
//
//   const soc = exigirEmpresa(req, res, PUENTE_CORDON);
//   if (soc === null) return;          // ya contestó 403
//
export function exigirEmpresa(req, res, nombreEmpresa) {
  const emp = empresaDelModulo(nombreEmpresa);
  if (!emp) return 1;                       // sin sociedades cargadas: no se corta nada
  const pedida = empresaPedida(req);
  if (pedida === null || pedida === emp.id) return emp.id;

  const otra = db.prepare('SELECT nombre FROM sociedades WHERE id = ?').get(pedida);
  res.status(403).json({
    ok: false,
    error: `Esta pantalla trabaja sobre ${emp.nombre}, y estás parado en `
         + `${otra?.nombre || 'otra empresa'}. Cambiá de empresa arriba: los datos `
         + `de cada sociedad van en sus propias tablas y no se pueden mezclar.`,
  });
  return null;
}

// Para las LECTURAS, donde cortar sería exagerado: devuelve siempre la empresa
// del módulo. Reemplaza a los getSociedadId() que adivinaban, sin cambiar el
// comportamiento de ninguna pantalla que hoy funciona.
export function empresaFija(nombreEmpresa) {
  const emp = empresaDelModulo(nombreEmpresa);
  return emp ? emp.id : 1;
}

// Los nombres, en un solo lugar, para que un typo no deje un cerrojo apuntando a
// la nada. Se usan estos y no ids: los ids dependen del orden de siembra.
export const PUENTE_CORDON = 'Puente Cordón SA';
export const SAN_GERONIMO  = 'San Gerónimo SA';

export default { empresaDelModulo, empresaPedida, exigirEmpresa, empresaFija,
                 PUENTE_CORDON, SAN_GERONIMO };
