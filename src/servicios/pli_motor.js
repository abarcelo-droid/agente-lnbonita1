// src/servicios/pli_motor.js
// ── MOTOR DE EXPLOSIÓN DE INSUMOS (Planificación Insumos) ─────────────────
// Función PURA: no toca la DB, no conoce `res`, no escribe nada. La usan por
// igual GET /calculo (preview) y POST /confirmar (persistencia), así que hay
// UNA sola implementación de la cuenta y el front nunca recalcula
// (mismo criterio que construirLineasAsientoCompra en produccion.js).
//
// Orden de operaciones (no es negociable, cada paso está justificado abajo):
//   1. recorrer el árbol y repartir el objetivo entre subproductos por %
//   2. aplicar la receta de cada nodo a su cantidad retenida (ratio + merma)
//   3. agregar por insumo_id  ← insumos compartidos entre productos caen acá
//   4. netear contra la existencia declarada
//   5. convertir de unidad de uso a unidad de compra
//   6. lot sizing: múltiplo y MOQ  ← ÚNICO redondeo de todo el motor
//   7. costo, separado por moneda
//   8. cobertura (hacer visible lo que si no sería un error silencioso)

// ── Disciplina numérica ───────────────────────────────────────────────────
// REGLA DURA: no se redondea NADA entre el paso 1 y el paso 6. Redondear por
// producto y después sumar acumula error SIEMPRE hacia arriba (por el ceil) y
// multiplica la sobrecompra. Ejemplo real con 3 productos que usan pallets:
// 666,67 + 210,5 + 88,33 → redondeando por producto da 967; acumulando exacto
// y redondeando una sola vez al final da 966.

const MAX_DEPTH = 10;
const EPS = 1e-9;              // tolerancia del ceil
const UMBRAL_MATERIAL = 1e-6;  // por debajo de esto, la necesidad es ruido de float

// ceil con tolerancia. Sin el -EPS, 7.000000000000001 pediría 8 múltiplos:
// es un bug reproducible, no teórico.
const ceilTol = (x, m) => (m > 0 ? Math.ceil(x / m - EPS) * m : x);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);

// Unidades contables vs continuas. Solo tiene sentido alertar por "ratio alto"
// en las contables: "200 gr por caja" es normal y dispararía la alarma siempre.
const UNIDADES_CONTABLES = new Set([
  'unidad', 'unidades', 'u', 'caja', 'cajas', 'pallet', 'pallets',
  'bolsa', 'bolsas', 'bolson', 'bolsones', 'rollo', 'rollos',
  'etiqueta', 'etiquetas', 'placa', 'placas', 'millar', 'millares'
]);
const esContable = (u) => UNIDADES_CONTABLES.has(String(u || '').trim().toLowerCase());

// Aritmética de fechas en UTC a propósito: sumar/restar días sobre la hora local
// se corre un día cuando cambia el horario de verano.
export function restarDias(fechaISO, dias) {
  const s = String(fechaISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const p = s.split('-').map(Number);
  const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]) - (Number(dias) || 0) * 86400000);
  const dd = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${dd(dt.getUTCMonth() + 1)}-${dd(dt.getUTCDate())}`;
}

// Lunes de la semana ISO que contiene la fecha. Los baldes de tiempo son semanas
// y se identifican por su lunes, así que cualquier fecha que cargue el usuario se
// normaliza acá y dos fechas de la misma semana caen en el mismo balde.
export function lunesDe(fechaISO) {
  const s = String(fechaISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const p = s.split('-').map(Number);
  const t = Date.UTC(p[0], p[1] - 1, p[2]);
  const dow = new Date(t).getUTCDay();          // 0 = domingo
  const corr = (dow === 0 ? 6 : dow - 1);       // días desde el lunes
  return restarDias(s, corr);
}

// Número de semana ISO 8601. El calendario agrícola se maneja por número de
// semana, así que es la etiqueta principal de cada balde.
// ISO 8601: la semana 1 es la que contiene el primer jueves del año, y por eso
// los primeros días de enero pueden pertenecer a la semana 52/53 del año anterior.
export function semanaISO(fechaISO) {
  const s = String(fechaISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  const dow = (d.getUTCDay() + 6) % 7;                 // 0 = lunes
  d.setUTCDate(d.getUTCDate() - dow + 3);              // jueves de esa semana
  const anio = d.getUTCFullYear();
  const pj = new Date(Date.UTC(anio, 0, 4));           // 4 de enero cae siempre en la semana 1
  const dowPj = (pj.getUTCDay() + 6) % 7;
  pj.setUTCDate(pj.getUTCDate() - dowPj + 3);
  const semana = 1 + Math.round((d.getTime() - pj.getTime()) / (7 * 86400000));
  return { anio, semana };
}

// Inversa: el lunes de la semana N de un año. Sirve para que el usuario cargue
// "semana 46" en vez de tener que buscar la fecha.
export function lunesDeSemanaISO(anio, semana) {
  const a = Number(anio), n = Number(semana);
  if (!Number.isInteger(a) || !Number.isInteger(n) || n < 1 || n > 53) return null;
  const pj = new Date(Date.UTC(a, 0, 4));
  const dowPj = (pj.getUTCDay() + 6) % 7;
  const lunesS1 = new Date(pj.getTime() - dowPj * 86400000);
  const d = new Date(lunesS1.getTime() + (n - 1) * 7 * 86400000);
  // Una semana 53 en un año que no la tiene cae en el año siguiente: se rechaza
  // para no crear un balde fuera de rango.
  const chk = semanaISO(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  if (!chk || chk.semana !== n) return null;
  const dd = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${dd(d.getUTCMonth() + 1)}-${dd(d.getUTCDate())}`;
}

// Formato es-AR para los textos de fórmula que lee el usuario.
function fmtNum(n, dec = 4) {
  const v = Number(n) || 0;
  const d = Number.isInteger(v) ? 0 : dec;
  return v.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// Texto auditable de una línea. Incluye SIEMPRE el tramo de merma cuando la hay:
// si no, el usuario lee "40.000 × 8 = 329.897" y la cuenta no le cierra, justo
// en la pantalla que existe para generar confianza.
function fmtFormula(q, unidadProd, linea, aporte, unidadUso) {
  const cant = num(linea.cantidad);
  const cada = num(linea.por_cada, 1);
  const merma = num(linea.merma_pct);
  const ratio = cada === 1
    ? `${fmtNum(cant)} ${unidadUso} por ${unidadProd}`
    : `${fmtNum(cant)} ${unidadUso} cada ${fmtNum(cada)} ${unidadProd}`;
  const bruto = q * cant / cada;
  let txt = `${fmtNum(q)} ${unidadProd} × ${ratio} = ${fmtNum(bruto)}`;
  if (merma > 0) txt += ` ÷ (1 − ${fmtNum(merma, 2)}% merma) = ${fmtNum(aporte)}`;
  return `${txt} ${unidadUso}`;
}

/**
 * @param {object} ctx
 *   plan        {object}
 *   objetivos   [{producto_id, cantidad, unidad, bucket_ini}]
 *   productos   [{id, padre_id, nombre, unidad, share_pct, modo_reparto, reproceso_pct, receta_version, activo}]
 *   recetas     Map(producto_id -> [linea, ...])   ya filtradas por versión vigente
 *   insumos     Map(insumo_id -> insumo)
 *   existencias Map(insumo_id -> cantidad en unidad de uso)
 *   comprado    Map(insumo_id -> bultos ya comprados, en unidad de compra)
 * @returns {{lineas, cobertura, totales_por_moneda, advertencias}}
 *
 * Cada línea trae además `buckets[]`: el detalle por semana de cosecha con la
 * fecha límite de pedido (semana − lead time) y el arrastre de sobrante.
 */
export function calcularPlan(ctx) {
  const productos   = ctx.productos || [];
  const objetivos   = ctx.objetivos || [];
  const recetas     = ctx.recetas || new Map();
  const insumos     = ctx.insumos || new Map();
  const existencias = ctx.existencias || new Map();
  // Lo ya comprado por insumo, en UNIDAD DE COMPRA. Cubre necesidad igual que la
  // existencia, y se aplica a las semanas más tempranas primero.
  const comprado    = ctx.comprado || new Map();

  // MODO COSTEO: se usa para sacar el costo unitario de un producto, no para
  // comprar. Apaga el lot sizing (múltiplo, mínimo del proveedor y ceil) porque
  // el costo de UNA caja no puede depender de que el pallet se venda de a uno:
  // con loteo, "1 pallet cada 60 cajas" costearía 1 pallet entero por caja.
  const costeo = ctx.modo === 'costeo';

  const porId    = new Map(productos.map(p => [p.id, p]));
  const porPadre = new Map();
  for (const p of productos) {
    if (p.activo !== 1 || p.eliminado_en) continue;
    const k = p.padre_id || 0;
    if (!porPadre.has(k)) porPadre.set(k, []);
    porPadre.get(k).push(p);
  }
  const hijosDe = (id) => (porPadre.get(id) || []).slice().sort((a, b) => a.orden - b.orden);

  // Acumuladores
  const acc = new Map();   // insumo_id -> {bruta, min, max}
  const desg = [];         // desglose plano: una entrada por (insumo × nodo)
  const advertencias = [];

  const cobertura = {
    ok: true,
    plan_sin_objetivos: false,
    objetivos_en_cero: [],
    objetivo_huerfano: [],
    objetivos_solapados: [],
    productos_sin_objetivo: [],
    nodos_sin_receta: [],
    insumo_inexistente: [],
    unidad_desincronizada: [],
    mix_excedido: [],
    mix_incompleto: [],
    // Se deja declarado y siempre vacío: los planes ya confirmados guardaron su
    // cobertura en JSON y la UI lo lee. Desde que la receta del padre se aplica a
    // la cantidad completa, este caso no existe más.
    receta_no_computa: [],
    existencia_supera_necesidad: [],
    insumos_sin_precio: [],
    ratios_sospechosos: []
  };

  // ── Validación previa: objetivos solapados (padre + hijo a la vez) ───────
  // Sin esto, cargar objetivo en Melón (40.000) Y en Caja chica (5.000) hace
  // que Caja chica se cuente dos veces, sin ningún error y con un desglose que
  // se lee como legítimo.
  const esAncestro = (posibleAncestro, id) => {
    let cur = porId.get(id);
    let guarda = 0;
    while (cur && cur.padre_id && guarda++ < MAX_DEPTH) {
      if (cur.padre_id === posibleAncestro) return true;
      cur = porId.get(cur.padre_id);
    }
    return false;
  };
  for (let i = 0; i < objetivos.length; i++) {
    for (let j = i + 1; j < objetivos.length; j++) {
      const a = objetivos[i], b = objetivos[j];
      if ((a.bucket_ini || '') !== (b.bucket_ini || '')) continue;
      let padre = null, hijo = null;
      if (esAncestro(a.producto_id, b.producto_id)) { padre = a; hijo = b; }
      else if (esAncestro(b.producto_id, a.producto_id)) { padre = b; hijo = a; }
      if (padre) {
        cobertura.objetivos_solapados.push({
          padre_id: padre.producto_id,
          padre: porId.get(padre.producto_id)?.nombre || '?',
          hijo_id: hijo.producto_id,
          hijo: porId.get(hijo.producto_id)?.nombre || '?'
        });
      }
    }
  }

  // ── Paso 1 y 2 — recorrido del árbol y aplicación de recetas ────────────

  // avisarSinReceta llega en false cuando el nodo reparte TODO entre sus
  // subproductos: ahí no tener receta propia no es una falta, ver más abajo.
  function aplicarReceta(nodo, q, ruta, bucket, avisarSinReceta = true) {
    const lineas = recetas.get(nodo.id) || [];
    if (!lineas.length) {
      if (avisarSinReceta) {
        cobertura.nodos_sin_receta.push({ id: nodo.id, ruta: ruta.slice(), nombre: nodo.nombre });
      }
      return;
    }
    for (const l of lineas) {
      const ins = insumos.get(l.insumo_id);

      // Insumo faltante: BLOQUEANTE, nunca un warning blando. Si fuera blando,
      // se podría confirmar un plan que compra 0 de algo que la receta pedía y
      // la fila simplemente no aparecería en la tabla.
      if (!ins || ins.eliminado_en) {
        cobertura.insumo_inexistente.push({
          insumo_id: l.insumo_id, producto_id: nodo.id, producto: nodo.nombre, ruta: ruta.slice()
        });
        continue;
      }

      // La unidad de la línea es un snapshot de insumo.unidad_uso al guardar.
      // Si alguien editó el maestro después (gr -> kg), multiplicar igual y
      // dividir por el factor nuevo da un error de 3 órdenes de magnitud sin
      // un solo aviso. Por eso es BLOQUEANTE, no warning.
      if (String(l.unidad) !== String(ins.unidad_uso)) {
        cobertura.unidad_desincronizada.push({
          insumo_id: ins.id, insumo: ins.nombre, producto: nodo.nombre,
          unidad_receta: l.unidad, unidad_insumo: ins.unidad_uso
        });
        continue;
      }

      if (ins.modo_provision !== 'compra') continue;   // RESERVADO v1: hoy no-op

      const cantidad = num(l.cantidad);
      const porCada  = num(l.por_cada, 1);
      const merma    = num(l.merma_pct);
      if (!(porCada > 0)) continue;                    // el CHECK lo garantiza; red de seguridad
      const divMerma = 1 - merma / 100;                // el CHECK garantiza > 0

      // SIN paréntesis alrededor de (cantidad / por_cada): agruparlos calcula
      // primero el cociente premultiplicado, que es exactamente lo que este
      // modelo existe para evitar. Verificado: 525*(1/75) = 7.000000000000001
      // mientras que 525*1/75 = 7 exacto.
      // OJO con el fallback del rango: num(null, def) NO devuelve def, devuelve 0,
      // porque Number(null) es 0 y 0 es finito. Sin el chequeo explícito de vacío,
      // una línea con mínimo cargado y máximo vacío producía una banda invertida
      // tipo "168.000–0" (visto en datos reales). Vacío = usar el nominal.
      const vacio = (v) => v === null || v === undefined || v === '';
      const cMin = vacio(l.cant_min) ? cantidad : num(l.cant_min, cantidad);
      const cMax = vacio(l.cant_max) ? cantidad : num(l.cant_max, cantidad);

      const nom = q * cantidad / porCada / divMerma;
      const mn  = q * cMin / porCada / divMerma;
      const mx  = q * cMax / porCada / divMerma;

      // Acumulación por insumo Y por balde de tiempo. El balde es la semana de
      // cosecha ('' = plan sin fechas, que es como quedan los planes viejos).
      if (!acc.has(l.insumo_id)) acc.set(l.insumo_id, new Map());
      const porBucket = acc.get(l.insumo_id);
      const a = porBucket.get(bucket) || { bruta: 0, min: 0, max: 0 };
      a.bruta += nom; a.min += mn; a.max += mx;        // acumulación EXACTA
      porBucket.set(bucket, a);

      desg.push({
        insumo_id: l.insumo_id,
        bucket_ini: bucket,
        ruta: ruta.slice(),
        producto_id: nodo.id,
        cantidad_producto: q,
        unidad_producto: nodo.unidad,
        cantidad, por_cada: porCada, modo_ratio: l.modo_ratio,
        merma_pct: merma,
        aporte_uso: nom,
        formula: fmtFormula(q, nodo.unidad, l, nom, ins.unidad_uso)
      });

      // Detección de tipeo de factor ("cada 6" en vez de "cada 60"), que es el
      // error de carga más probable y el que produce desvíos de un orden de
      // magnitud. Solo aplica a unidades contables.
      const ratio = cantidad / porCada;
      if (esContable(ins.unidad_uso) && (ratio > 10 || (ratio > 0 && ratio < 0.001))) {
        cobertura.ratios_sospechosos.push({
          producto: nodo.nombre, insumo: ins.nombre,
          consumo_por_unidad: ratio,
          motivo: ratio > 10 ? `${fmtNum(ratio, 2)} por ${nodo.unidad} — ¿el "cada" está bien?`
                             : `${fmtNum(ratio, 6)} por ${nodo.unidad} — ratio muy chico`
        });
      }
    }
  }

  function explotar(nodo, q, ruta, pila, bucket) {
    if (pila.length > MAX_DEPTH) {
      const e = new Error(`Árbol demasiado profundo (>${MAX_DEPTH} niveles) en "${nodo.nombre}"`);
      e.status = 400; throw e;
    }
    if (pila.includes(nodo.id)) {
      const e = new Error(`Referencia circular en "${nodo.nombre}"`);
      e.status = 400; throw e;
    }

    // Reproceso: se aplica DIVIDIENDO, igual criterio que la merma. Para cubrir
    // un 5% de descarte hay que arrancar con 1/0,95 = +5,26%, no con ×1,05.
    // RESERVADO v1: el default 0 lo hace no-op.
    const rep = num(nodo.reproceso_pct);
    const qEf = rep > 0 ? q / (1 - rep / 100) : q;

    const hijos = hijosDe(nodo.id);
    const suma = hijos.reduce((a, h) => a + num(h.share_pct), 0);

    if (hijos.length && nodo.modo_reparto === 'particiona') {
      if (suma > 100 + 1e-6) {
        cobertura.mix_excedido.push({ id: nodo.id, nombre: nodo.nombre, suma_pct: suma });
      } else if (suma < 100 - 1e-6) {
        cobertura.mix_incompleto.push({
          id: nodo.id, nombre: nodo.nombre, suma_pct: suma, sin_asignar: 100 - suma
        });
      }
    }

    // LA RECETA DEL PADRE ES COMÚN A TODOS SUS SUBPRODUCTOS.
    // Se aplica a la cantidad COMPLETA del nodo, no al resto sin asignar. Cargarle
    // un insumo al producto significa "esto lo lleva toda la producción de este
    // producto, sin importar en qué formato se empaque".
    //
    // Antes se aplicaba a la cantidad retenida —qEf × (100−Σpct)/100—, así que con
    // los subproductos sumando 100% la receta del padre quedaba multiplicada por
    // cero y el insumo desaparecía del plan y del costo sin que nada lo dijera.
    // Los subproductos suman ADEMÁS lo suyo, cada uno sobre su porcentaje.
    //
    // Y JUSTO POR ESO, un producto que reparte el 100% entre sus subproductos NO
    // necesita receta propia: la receta del padre es lo COMÚN a todos, y no tener
    // nada común es un caso perfectamente normal (cada formato lleva su etiqueta
    // y nada más). Avisar "no tiene receta" ahí mandaba a revisar un plan bien
    // calculado y encima marcaba la cobertura como incompleta, obligando a tildar
    // "entiendo que el plan tiene problemas" para confirmar algo que no los tenía.
    //
    // Se sigue avisando cuando el nodo NO delega todo:
    //   · sin hijos          -> nadie más aporta insumos por él
    //   · particiona < 100%  -> la parte sin asignar no produce nada (mix_incompleto
    //                           lo dice además con el porcentaje que falta)
    //   · adicional          -> el padre produce igual su cantidad completa, los
    //                           hijos son producción EXTRA, no un reparto
    const delegaTodo = hijos.length > 0
      && nodo.modo_reparto === 'particiona'
      && suma >= 100 - 1e-6;
    if (qEf > EPS) aplicarReceta(nodo, qEf, ruta, bucket, !delegaTodo);

    for (const h of hijos) {
      explotar(h, qEf * num(h.share_pct) / 100, [...ruta, h.nombre], [...pila, nodo.id], bucket);
    }
  }

  // ── Disparo desde los objetivos ─────────────────────────────────────────

  if (!objetivos.length) {
    cobertura.plan_sin_objetivos = true;
  }

  const conObjetivo = new Set();
  for (const o of objetivos) {
    const nodo = porId.get(o.producto_id);
    // El objetivo apunta a un producto que ya no está en el árbol (se dio de baja
    // mientras el plan seguía en borrador). Descartarlo en silencio hacía que el
    // plan comprara de menos MOSTRANDO "cobertura completa". Bloqueante, mismo
    // criterio que un insumo faltante.
    if (!nodo) {
      cobertura.objetivo_huerfano.push({
        producto_id: o.producto_id, cantidad: num(o.cantidad), unidad: o.unidad || ''
      });
      continue;
    }
    conObjetivo.add(o.producto_id);
    const q = num(o.cantidad);
    // Un objetivo en 0 devolvía tabla vacía y cartel verde "cobertura completa".
    // El caso "0 cajas" tiene que ser explícito, no un vacío ambiguo.
    if (!(q > 0)) {
      cobertura.objetivos_en_cero.push({ id: nodo.id, nombre: nodo.nombre });
      continue;
    }
    explotar(nodo, q, [nodo.nombre], [], String(o.bucket_ini || ''));
  }

  // Productos raíz sin objetivo cargado
  for (const p of hijosDe(0)) {
    if (!conObjetivo.has(p.id)) {
      cobertura.productos_sin_objetivo.push({ id: p.id, nombre: p.nombre });
    }
  }

  // ── Pasos 3 a 7 — por insumo ────────────────────────────────────────────

  const desgPorInsumo = new Map();
  for (const d of desg) {
    if (!desgPorInsumo.has(d.insumo_id)) desgPorInsumo.set(d.insumo_id, []);
    desgPorInsumo.get(d.insumo_id).push(d);
  }

  const lineas = [];
  const totales_por_moneda = {};

  // Lot sizing de un tramo: múltiplo y después mínimo del proveedor.
  function lotear(bultosNecesarios, multiplo, moq) {
    let b = bultosNecesarios;
    let excesoMultiplo = 0, excesoMoq = 0, moqForzado = 0;
    if (b > 0 && b < UMBRAL_MATERIAL) {
      // Necesidad despreciable (residuo de reparto o ruido de float): no dispara
      // la orden mínima completa del proveedor.
      b = 0;
    } else if (b > 0) {
      if (multiplo > 0) b = ceilTol(b, multiplo);
      excesoMultiplo = b - bultosNecesarios;
      if (b > 0 && b < moq) {
        const antes = b;
        b = moq;
        if (multiplo > 0) b = ceilTol(b, multiplo);
        excesoMoq = b - antes;
        moqForzado = 1;
      }
    } else {
      b = 0;
    }
    return { b, excesoMultiplo, excesoMoq, moqForzado };
  }

  for (const [insumoId, porBucket] of acc) {
    const ins = insumos.get(insumoId);
    if (!ins) continue;

    const factor = num(ins.factor_compra, 1) || 1;
    const multiplo = num(ins.multiplo_compra);
    const moq = num(ins.moq);
    const leadTime = Math.max(0, num(ins.lead_time_dias));

    // Baldes en orden cronológico. '' (plan sin fechas) ordena primero, así que
    // un plan viejo sin semanas se comporta exactamente como antes.
    const buckets = Array.from(porBucket.keys()).sort();
    const brutaTotal = buckets.reduce((s, k) => s + porBucket.get(k).bruta, 0);
    const minTotal   = buckets.reduce((s, k) => s + porBucket.get(k).min, 0);
    const maxTotal   = buckets.reduce((s, k) => s + porBucket.get(k).max, 0);

    // Paso 4 — netting contra existencia declarada (en unidad de USO)
    const declarada = num(existencias.get(insumoId));
    const existencia = Math.min(declarada, brutaTotal);
    if (declarada > brutaTotal + EPS) {
      // El clamp absorbía en silencio un tipeo de 120.000 por 12.000 y la fila
      // mostraba "a comprar 0" como si fuera correcto.
      cobertura.existencia_supera_necesidad.push({
        insumo_id: insumoId, insumo: ins.nombre,
        declarada, necesidad: brutaTotal, unidad_uso: ins.unidad_uso
      });
    }

    // Lo ya comprado también cubre necesidad, y se aplica a las semanas más
    // tempranas primero (lo que compraste sirve para la cosecha que viene).
    const compradoBultos = num(comprado.get(insumoId));

    // Paso 5 y 6 — por balde, CON ARRASTRE DEL REMANENTE.
    //
    // Redondear cada semana por su cuenta infla la compra siempre hacia arriba:
    // 4 semanas de 82,5 millares dan 83×4 = 332 en vez de 330. El sobrante de
    // cada pedido se arrastra a la semana siguiente, así el total termina igual
    // que redondeando una sola vez, pero comprando semana a semana.
    let existRest = existencia;           // en unidad de uso
    let cubiertoRest = compradoBultos;    // en unidad de compra
    let sobrante = 0;                     // en unidad de compra
    let totalComprar = 0, totalExcMult = 0, totalExcMoq = 0, moqForzadoAlguno = 0;
    const detalleBuckets = [];

    for (const k of buckets) {
      const brutaB = porBucket.get(k).bruta;
      const usaExist = Math.min(existRest, brutaB);
      existRest -= usaExist;
      const netaB = Math.max(0, brutaB - usaExist);
      const teoricosB = netaB / factor;

      // Lo ya pedido cubre primero las semanas más tempranas.
      const usaComprado = Math.min(cubiertoRest, teoricosB);
      cubiertoRest -= usaComprado;
      const pendienteB = teoricosB - usaComprado;

      // El sobrante de pedidos anteriores cubre parte de esta semana.
      const necesarioB = pendienteB - sobrante;
      let r = { b: 0, excesoMultiplo: 0, excesoMoq: 0, moqForzado: 0 };
      if (costeo) {
        // Cantidad exacta, sin redondear ni arrastrar: es un costo, no un pedido.
        r = { b: pendienteB, excesoMultiplo: 0, excesoMoq: 0, moqForzado: 0 };
      } else if (necesarioB > EPS) {
        r = lotear(necesarioB, multiplo, moq);
        sobrante = sobrante + r.b - pendienteB;
      } else {
        sobrante = sobrante - pendienteB;   // alcanza con el sobrante
      }
      if (sobrante < 0) sobrante = 0;       // guarda contra ruido de float

      totalComprar += r.b;
      totalExcMult += r.excesoMultiplo;
      totalExcMoq  += r.excesoMoq;
      if (r.moqForzado) moqForzadoAlguno = 1;

      const iso = k ? semanaISO(k) : null;
      detalleBuckets.push({
        bucket_ini: k,
        semana_iso: iso ? iso.semana : null,
        anio_iso: iso ? iso.anio : null,
        cant_bruta_uso: brutaB,
        existencia_aplicada: usaExist,
        cant_neta_uso: netaB,
        bultos_teoricos: teoricosB,
        ya_comprado: usaComprado,
        bultos_a_comprar: r.b,
        sobrante_arrastrado: sobrante,
        // Fechas: el insumo tiene que ESTAR el primer día de la semana de cosecha,
        // así que la fecha límite de pedido es esa fecha menos el lead time.
        fecha_necesidad: k || null,
        fecha_pedido_limite: k ? restarDias(k, leadTime) : null,
        lead_time_dias: leadTime
      });
    }

    const netaTotal = Math.max(0, brutaTotal - existencia);
    const teoricosTotal = netaTotal / factor;
    const netaMin = Math.max(0, minTotal - existencia);
    const netaMax = Math.max(0, maxTotal - existencia);

    // Paso 7 — costo. Nunca se suman monedas distintas con un TC implícito.
    const precio = num(ins.precio_ref);
    const sinPrecio = precio <= 0 ? 1 : 0;
    const moneda = ins.moneda || 'ARS';
    const costo = totalComprar * precio;
    if (sinPrecio) {
      cobertura.insumos_sin_precio.push({ insumo_id: insumoId, insumo: ins.nombre });
    } else {
      totales_por_moneda[moneda] = (totales_por_moneda[moneda] || 0) + costo;
    }

    lineas.push({
      insumo_id: insumoId,
      insumo_nombre: ins.nombre,
      categoria: ins.categoria || null,
      proveedor_texto: ins.proveedor_texto || null,
      unidad_uso: ins.unidad_uso,
      unidad_compra: ins.unidad_compra,
      factor_compra: factor,
      multiplo_compra: multiplo,
      moq,
      lead_time_dias: leadTime,
      cant_bruta_uso: brutaTotal,
      cant_min_uso: netaMin,
      cant_max_uso: netaMax,
      existencia,
      existencia_declarada: declarada,
      cant_neta_uso: netaTotal,
      bultos_teoricos: teoricosTotal,
      bultos_a_comprar: totalComprar,
      ya_comprado_bultos: compradoBultos,
      pendiente_bultos: Math.max(0, totalComprar),
      exceso_multiplo: totalExcMult,
      exceso_moq: totalExcMoq,
      exceso_uso: (totalComprar + compradoBultos - teoricosTotal) * factor,
      moq_forzado: moqForzadoAlguno,
      precio_unit_snapshot: precio,
      moneda_snapshot: moneda,
      precio_fecha_snapshot: ins.precio_fecha || null,
      costo_estimado: costo,
      sin_precio: sinPrecio,
      buckets: detalleBuckets,
      desglose: desgPorInsumo.get(insumoId) || []
    });
  }

  // Orden: primero lo que más plata mueve, después alfabético.
  lineas.sort((x, y) => (y.costo_estimado - x.costo_estimado)
    || String(x.insumo_nombre).localeCompare(String(y.insumo_nombre), 'es'));

  // En modo compra los totales son plata a pagar: van a 2 decimales.
  // En modo COSTEO no se redondean: el costo de UNA caja puede ser USD 0,5983 y
  // redondearlo a 0,60 rompe el número en cuanto se multiplica por el volumen
  // (sobre 40.000 cajas, 0,0017 de diferencia son USD 68). El redondeo, si hace
  // falta, es de la presentación.
  if (!costeo) {
    for (const k of Object.keys(totales_por_moneda)) {
      totales_por_moneda[k] = round2(totales_por_moneda[k]);
    }
  }

  // ── Paso 8 — veredicto de cobertura ─────────────────────────────────────
  // Definición EXPLÍCITA de qué bloquea. Lo que no está acá es advertencia y
  // no exige tildar nada: si todo bloqueara, el tilde se vuelve un reflejo
  // automático y la mitigación muere.
  cobertura.ok = (
    cobertura.plan_sin_objetivos === false &&
    cobertura.objetivos_en_cero.length === 0 &&
    cobertura.objetivo_huerfano.length === 0 &&
    cobertura.objetivos_solapados.length === 0 &&
    cobertura.nodos_sin_receta.length === 0 &&
    cobertura.insumo_inexistente.length === 0 &&
    cobertura.unidad_desincronizada.length === 0 &&
    cobertura.mix_excedido.length === 0 &&
    cobertura.existencia_supera_necesidad.length === 0
  );

  // Advertencias blandas (no bloquean el confirmar)
  if (cobertura.insumos_sin_precio.length) {
    advertencias.push(`${cobertura.insumos_sin_precio.length} insumo(s) sin precio cargado — el total es parcial`);
  }
  for (const m of cobertura.mix_incompleto) {
    advertencias.push(`"${m.nombre}": los subproductos suman ${fmtNum(m.suma_pct, 2)}% (sin asignar ${fmtNum(m.sin_asignar, 2)}%)`);
  }
  for (const r of cobertura.receta_no_computa) {
    advertencias.push(`"${r.nombre}": su receta de ${r.lineas} línea(s) no computa (${r.motivo})`);
  }
  for (const r of cobertura.ratios_sospechosos) {
    advertencias.push(`Revisá "${r.insumo}" en "${r.producto}": ${r.motivo}`);
  }
  for (const p of cobertura.productos_sin_objetivo) {
    advertencias.push(`"${p.nombre}" no tiene objetivo cargado en este plan`);
  }

  return { lineas, cobertura, totales_por_moneda, advertencias };
}

export const _internos = { ceilTol, fmtFormula, esContable, MAX_DEPTH, EPS, UMBRAL_MATERIAL };
