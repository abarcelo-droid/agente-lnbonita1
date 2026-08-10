// src/servicios/bt_continuo.js
// ── EL CONTINUO ───────────────────────────────────────────────────────────
//
// Que la historia de Transoft siga sirviendo el día que Transoft se apague.
// Veinte mil cargas y diez mil viajes de comportamiento real: si al cambiar de
// sistema los indicadores arrancan de cero, se pierde lo más valioso que hay.
//
// Migrar la historia a las tablas operativas es lo obvio y no alcanza. Hacen falta
// TRES cosas, y las tres viven acá:
//
//   1. QUÉ SE MIGRA — qué se considera terminado. Un viaje en curso no se migra:
//      sigue vivo en Transoft y se resincroniza. Un viaje cerrado se migra una vez
//      y queda. El criterio no se inventa: sale del flag CIERRA de Transoft.
//
//   2. CON QUÉ PALABRAS — el vocabulario. La historia dice "FLETE"; si mañana
//      alguien escribe "Flete", el informe por concepto muestra dos líneas donde va
//      una. Los códigos son este catálogo, copiados de Transoft, no texto libre.
//
//   3. DESDE QUÉ NÚMERO SIGUE — los contadores. Es el que se pasa por alto y el que
//      rompe todo: si el ERP arranca numerando en 1 después de traer la historia, la
//      primera carga nueva choca con la carga 1 de 2016.
//
// Nada de esto escribe en Transoft. Se lee del espejo (bt_tr_*) y se escribe en las
// tablas propias (bt_*).
import db from './db.js';
import './db_bt.js';       // el espejo: de acá sale bt_tr_filiales
import './db_bt_op.js';    // las tablas operativas: bt_catalogos, bt_contadores

// ══════════════════════════════════════════════════════════════════════════
// 1. EL VOCABULARIO
// ══════════════════════════════════════════════════════════════════════════
// Los códigos EXACTOS de Transoft (cgtipcar, cgtipbul, cgestado, cgestvia,
// cgconfor, cgconcar, cgconvia). No se traducen ni se "mejoran": si acá dijera
// "ENTREGADO" donde Transoft dice "ED", cada comparación entre los dos sistemas
// necesitaría una tabla de equivalencias en el medio, y la historia migrada
// quedaría hablando distinto que el espejo del que salió.
//
// `cierra` sale del flag CIERRA de allá y es lo que define qué está terminado.

export const CATALOGOS = {
  // Qué se transporta (cgtipcar).
  tipo_carga: [
    ['MI', 'Mercado interno'],
    ['VI', 'Bodega — vinos'],
    ['ME', 'Exportación'],
    ['PV', 'Pallets vacíos'],
    ['PQ', 'Paquetería'],
  ],

  // Cómo viene embalado (cgtipbul).
  tipo_bulto: [
    ['CA', 'Cajas'],
    ['PA', 'Pallets'],
    ['VI', 'Vinos'],
  ],

  // Dónde está físicamente la carga (cgestado). ED y NE son los dos finales: con
  // cualquiera de los dos la carga está terminada y se puede migrar.
  estado_carga: [
    ['TT', 'Tránsito terminal'],
    ['RL', 'Reparto al cliente'],
    ['DP', 'Depósito propio'],
    ['DT', 'Depósito de terceros, a retirar'],
    ['RT', 'Retenido en depósito'],
    ['RD', 'Rechazado por el destinatario'],
    ['ED', 'Entregado en destino', { cierra: 1 }],
    ['NE', 'No entregado', { cierra: 1 }],
  ],

  // El ciclo del viaje (cgestvia). Sólo dos estados, y CI es el que cierra.
  estado_viaje: [
    ['IN', 'En curso — salió a la ruta'],
    ['CI', 'Cerrado — finalizado', { cierra: 1 }],
  ],

  // Cómo llegó la mercadería (cgconfor).
  conformidad: [
    ['P', 'Pendiente'],
    ['C', 'Conforme'],
    ['F', 'Con faltantes'],
    ['O', 'Observado'],
    ['R', 'Rechazado — final'],
    ['V', 'Vuelve rechazado'],
    ['S', 'Siniestrado'],
    ['X', 'Sin conformar'],
  ],

  // Lo que se le COBRA al cliente por la carga (cgconcar). Los cuatro "SEGURO XXX"
  // son pólizas de clientes concretos; se conservan tal cual porque la historia
  // facturada los usa y agruparlos ahora rompería la comparación contra el pasado.
  concepto_carga: [
    ['FLETE', 'Servicio de flete'],
    ['COMPLETO', 'Completo — mercado interno'],
    ['MI', 'Mercado interno'],
    ['EXPO', 'Exportación'],
    ['PALLETS', 'Pallets vacíos'],
    ['FOJA', 'Foja'],
    ['SEGURO', 'Seguro'],
    ['SEGURO RP', 'Seguro — Ramos Pack'],
    ['SEGURO OVE', 'Seguro — Overprint'],
    ['SEGURO AVA', 'Seguro — Avalos'],
    ['SEGURO BYM', 'Seguro — Bymed'],
  ],

  // Lo que CUESTA el viaje (cgconvia). Mezcla costos de ruta (gasoil, peajes) con
  // conceptos de liquidación al chofer (básico, vacaciones, SAC): en Transoft están
  // en la misma lista y así se conserva, porque así están valorizados los viajes
  // históricos. Separarlos es una decisión posterior, no de la migración.
  concepto_viaje: [
    ['FLETE', 'Costo de flete'],
    ['GASOIL', 'Gasoil'],
    ['PEAJES', 'Peajes'],
    ['VIAJE', 'Importe convenido — San Juan/Bs.As.'],
    ['CONVENIO', 'Convenio — San Juan/Córdoba'],
    ['125', 'Viaje convenio'],
    ['ESTADIA', 'Estadía'],
    ['KM EXTRA', 'Kilómetros fuera del viaje'],
    ['ENLONADO', 'Enlonado'],
    ['ETIQUETAS', 'Etiquetas'],
    ['DESINFECCI', 'Desinfección'],
    ['INTERNO', 'Interno'],
    ['BASICO', 'Básico'],
    ['VACACIONES', 'Vacaciones'],
    ['SAC', 'SAC'],
    ['PARTE', 'Parte de enfermo'],
  ],
};

// Los códigos que dan por terminada una carga o un viaje, derivados del catálogo
// de arriba. Se calculan y no se escriben a mano: agregar un estado que cierre es
// tocar UN lugar, y el criterio de migración lo sigue solo.
function codigosQueCierran(tipo) {
  return new Set(
    (CATALOGOS[tipo] || []).filter(f => f[2] && f[2].cierra).map(f => f[0])
  );
}
export const ESTADOS_CARGA_CIERRAN = codigosQueCierran('estado_carga');
export const ESTADOS_VIAJE_CIERRAN = codigosQueCierran('estado_viaje');

// Siembra idempotente. Actualiza la descripción y los flags en cada arranque —así
// una corrección de texto llega sin migración— pero nunca borra: un código que se
// deja de usar se desactiva a mano, no desaparece, porque la historia lo referencia.
export function sembrarCatalogos() {
  const ins = db.prepare(
    `INSERT INTO bt_catalogos (tipo, codigo, descripcion, cierra, no_facturar, orden)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(tipo, codigo) DO UPDATE SET
       descripcion = excluded.descripcion,
       cierra      = excluded.cierra,
       orden       = excluded.orden`
  );

  let n = 0;
  db.transaction(() => {
    for (const [tipo, filas] of Object.entries(CATALOGOS)) {
      filas.forEach(([codigo, descripcion, opts], i) => {
        ins.run(tipo, codigo, descripcion, opts?.cierra ? 1 : 0, opts?.no_facturar ? 1 : 0, i + 1);
        n++;
      });
    }
  })();
  return n;
}

// ══════════════════════════════════════════════════════════════════════════
// 2. QUÉ ESTÁ TERMINADO (y por lo tanto se migra)
// ══════════════════════════════════════════════════════════════════════════
// Funciones puras sobre una fila del espejo. Se pueden probar sin base, que es
// justamente lo que hace falta: este criterio decide qué historia entra y qué se
// queda afuera, y equivocarlo se descubre tarde.
//
// Lo anulado nunca se migra. Sigue existiendo en el espejo —una carga anulada es
// parte de la historia y su número está quemado— pero no es una operación que haya
// pasado, así que no puede aparecer en un indicador de facturación ni de volumen.

export function viajeCerrado(v) {
  if (!v || Number(v.anulado) === 1) return false;
  if (ESTADOS_VIAJE_CIERRAN.has(String(v.estado || '').trim().toUpperCase())) return true;
  // Un viaje con fecha de cierre está cerrado aunque el estado haya quedado sin
  // actualizar. En veinte años de operación eso pasa, y perder el viaje por un
  // campo mal grabado sería peor que aceptarlo.
  return !!String(v.cierre || '').trim();
}

export function cargaCerrada(c) {
  if (!c || Number(c.anulado) === 1) return false;
  if (Number(c.cerrada) === 1) return true;
  return ESTADOS_CARGA_CIERRAN.has(String(c.estado || '').trim().toUpperCase());
}

// ══════════════════════════════════════════════════════════════════════════
// 3. DESDE QUÉ NÚMERO SIGUE EL ERP
// ══════════════════════════════════════════════════════════════════════════
// El punto que rompe el continuo si se pasa por alto.
//
// Transoft entregó hasta la carga 20.857 y el viaje 11.271 en Casa Central. Si el
// ERP arranca su contador en cero, la primera carga nueva pide el número 1 — y ese
// número ya lo tiene una carga de 2016 que trajo la migración.
//
// Y no alcanza con mirar el número más alto de lo migrado: hay 20.847 cargas pero
// el contador dice 20.857. Diez números entregados cuya fila ya no está. Tomando el
// máximo, el ERP volvería a entregar esos diez.
//
// Por eso el contador se siembra con el MAYOR de tres valores, y NUNCA BAJA:
//   · lo que ya tenía el ERP        → no retroceder si acá se cargó algo
//   · el contador de Transoft       → no reusar números que allá se entregaron
//   · el máximo número ya migrado   → por si el espejo de cgfilial no llegó todavía
//
// Se recalcula en cada arranque: es barato y arregla solo el caso de sincronizar
// cgfilial después de haber migrado.

export function sembrarContadores() {
  const hechos = [];

  const filiales = (() => {
    try {
      return db.prepare(
        `SELECT sucursal, ultcarga, ultviaje FROM bt_tr_filiales
          WHERE sucursal IS NOT NULL AND TRIM(sucursal) <> ''`
      ).all();
    } catch {
      return [];   // el espejo todavía no trajo cgfilial: se usa sólo lo migrado
    }
  })();
  const porSuc = new Map(filiales.map(f => [String(f.sucursal).trim().toUpperCase(), f]));

  const sucursales = db.prepare('SELECT id, codigo FROM bt_sucursales').all();
  const leer = db.prepare('SELECT ultimo FROM bt_contadores WHERE sucursal_id=? AND tipo=?');
  const guardar = db.prepare(
    `INSERT INTO bt_contadores (sucursal_id, tipo, ultimo) VALUES (?,?,?)
     ON CONFLICT(sucursal_id, tipo) DO UPDATE SET ultimo = excluded.ultimo`
  );
  const maxCarga = db.prepare('SELECT COALESCE(MAX(numero),0) m FROM bt_cargas WHERE sucursal_id=?');
  const maxViaje = db.prepare('SELECT COALESCE(MAX(numero),0) m FROM bt_viajes WHERE sucursal_id=?');

  db.transaction(() => {
    for (const s of sucursales) {
      const tr = porSuc.get(String(s.codigo).trim().toUpperCase());
      const candidatos = {
        carga: [leer.get(s.id, 'carga')?.ultimo || 0, tr?.ultcarga || 0, maxCarga.get(s.id).m],
        viaje: [leer.get(s.id, 'viaje')?.ultimo || 0, tr?.ultviaje || 0, maxViaje.get(s.id).m],
      };
      for (const [tipo, vals] of Object.entries(candidatos)) {
        const antes = vals[0];
        const ultimo = Math.max(...vals.map(Number));
        if (ultimo !== antes) {
          guardar.run(s.id, tipo, ultimo);
          hechos.push(`${s.codigo}/${tipo}: ${antes} → ${ultimo}`);
        } else if (!leer.get(s.id, tipo)) {
          guardar.run(s.id, tipo, ultimo);   // primera vez, aunque quede en 0
        }
      }
    }
  })();

  return hechos;
}

// El próximo número, atómico. Se llama DENTRO de la transacción del alta: sacarlo
// antes y usarlo después es exactamente cómo dos altas simultáneas se llevan el
// mismo número. `RETURNING` hace el incremento y la lectura en un solo paso.
export function proximoNumero(sucursalId, tipo) {
  const r = db.prepare(
    `UPDATE bt_contadores SET ultimo = ultimo + 1
      WHERE sucursal_id = ? AND tipo = ? RETURNING ultimo`
  ).get(sucursalId, tipo);
  if (r) return r.ultimo;

  // No existía el contador (sucursal nueva). Se crea arrancando en 1.
  db.prepare('INSERT OR IGNORE INTO bt_contadores (sucursal_id, tipo, ultimo) VALUES (?,?,0)')
    .run(sucursalId, tipo);
  return db.prepare(
    `UPDATE bt_contadores SET ultimo = ultimo + 1
      WHERE sucursal_id = ? AND tipo = ? RETURNING ultimo`
  ).get(sucursalId, tipo).ultimo;
}

// ── ARRANQUE ──────────────────────────────────────────────────────────────
// Contenido: si esto falla, falla el continuo, no el servidor.
try {
  const n = sembrarCatalogos();
  const hechos = sembrarContadores();
  console.log(`[BT-CONT] Vocabulario verificado (${n} códigos).`);
  if (hechos.length) {
    console.log('[BT-CONT] Contadores ajustados para no pisar números de Transoft:');
    for (const h of hechos) console.log(`[BT-CONT]   ${h}`);
  }
} catch (e) {
  console.error('[BT-CONT] Error inicializando el continuo:', e.message);
}

export default db;
