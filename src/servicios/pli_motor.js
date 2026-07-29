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
 * @returns {{lineas, cobertura, totales_por_moneda, advertencias}}
 */
export function calcularPlan(ctx) {
  const productos   = ctx.productos || [];
  const objetivos   = ctx.objetivos || [];
  const recetas     = ctx.recetas || new Map();
  const insumos     = ctx.insumos || new Map();
  const existencias = ctx.existencias || new Map();

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
    objetivos_solapados: [],
    productos_sin_objetivo: [],
    nodos_sin_receta: [],
    insumo_inexistente: [],
    unidad_desincronizada: [],
    mix_excedido: [],
    mix_incompleto: [],
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

  function aplicarReceta(nodo, q, ruta) {
    const lineas = recetas.get(nodo.id) || [];
    if (!lineas.length) {
      cobertura.nodos_sin_receta.push({ id: nodo.id, ruta: ruta.slice(), nombre: nodo.nombre });
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
      const nom = q * cantidad / porCada / divMerma;
      const mn  = q * num(l.cant_min, cantidad) / porCada / divMerma;
      const mx  = q * num(l.cant_max, cantidad) / porCada / divMerma;

      const a = acc.get(l.insumo_id) || { bruta: 0, min: 0, max: 0 };
      a.bruta += nom; a.min += mn; a.max += mx;        // acumulación EXACTA
      acc.set(l.insumo_id, a);

      desg.push({
        insumo_id: l.insumo_id,
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

  function explotar(nodo, q, ruta, pila) {
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

    // A qué cantidad se aplica la receta del nodo: a su cantidad RETENIDA.
    let qRet;
    if (!hijos.length) qRet = qEf;                                   // hoja: todo
    else if (nodo.modo_reparto === 'particiona') qRet = qEf * (100 - suma) / 100;
    else qRet = qEf;                                                 // 'adicional': el padre no se reduce

    if (qRet > EPS) {
      aplicarReceta(nodo, qRet, ruta);
    } else if (hijos.length && (recetas.get(nodo.id) || []).length) {
      // Padre 'particiona' con 100% repartido: su receta existe pero no computa.
      // Reportarlo convierte un error silencioso en un aviso visible.
      cobertura.receta_no_computa.push({
        id: nodo.id, nombre: nodo.nombre,
        lineas: (recetas.get(nodo.id) || []).length,
        motivo: '100% repartido a subproductos'
      });
    }

    for (const h of hijos) {
      explotar(h, qEf * num(h.share_pct) / 100, [...ruta, h.nombre], [...pila, nodo.id]);
    }
  }

  // ── Disparo desde los objetivos ─────────────────────────────────────────

  if (!objetivos.length) {
    cobertura.plan_sin_objetivos = true;
  }

  const conObjetivo = new Set();
  for (const o of objetivos) {
    const nodo = porId.get(o.producto_id);
    if (!nodo) continue;
    conObjetivo.add(o.producto_id);
    const q = num(o.cantidad);
    // Un objetivo en 0 devolvía tabla vacía y cartel verde "cobertura completa".
    // El caso "0 cajas" tiene que ser explícito, no un vacío ambiguo.
    if (!(q > 0)) {
      cobertura.objetivos_en_cero.push({ id: nodo.id, nombre: nodo.nombre });
      continue;
    }
    explotar(nodo, q, [nodo.nombre], []);
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

  for (const [insumoId, a] of acc) {
    const ins = insumos.get(insumoId);
    if (!ins) continue;

    // Paso 4 — netting contra existencia declarada (en unidad de USO)
    const declarada = num(existencias.get(insumoId));
    const existencia = Math.min(declarada, a.bruta);
    if (declarada > a.bruta + EPS) {
      // El clamp absorbía en silencio un tipeo de 120.000 por 12.000 y la fila
      // mostraba "a comprar 0" como si fuera correcto.
      cobertura.existencia_supera_necesidad.push({
        insumo_id: insumoId, insumo: ins.nombre,
        declarada, necesidad: a.bruta, unidad_uso: ins.unidad_uso
      });
    }
    const neta = Math.max(0, a.bruta - existencia);
    const netaMin = Math.max(0, a.min - existencia);
    const netaMax = Math.max(0, a.max - existencia);

    // Paso 5 — conversión a unidad de compra
    const factor = num(ins.factor_compra, 1) || 1;
    const bultosTeoricos = neta / factor;

    // Paso 6 — lot sizing. ÚNICO redondeo del motor.
    // ceil y no round: comprar de menos frena la línea en plena temporada;
    // comprar de más es capital inmovilizado. En packing gana ceil.
    const multiplo = num(ins.multiplo_compra);
    const moq = num(ins.moq);
    let b = bultosTeoricos;
    let excesoMultiplo = 0, excesoMoq = 0, moqForzado = 0;

    if (b > 0 && b < UMBRAL_MATERIAL) {
      // Necesidad despreciable (residuo de reparto o ruido de float): no dispara
      // la orden mínima completa del proveedor.
      b = 0;
    } else {
      if (multiplo > 0) b = ceilTol(b, multiplo);
      excesoMultiplo = b - bultosTeoricos;
      if (b > 0 && b < moq) {
        const antes = b;
        b = moq;
        if (multiplo > 0) b = ceilTol(b, multiplo);
        excesoMoq = b - antes;
        moqForzado = 1;
      }
    }
    const excesoTotal = b - bultosTeoricos;

    // Paso 7 — costo. Nunca se suman monedas distintas con un TC implícito.
    const precio = num(ins.precio_ref);
    const sinPrecio = precio <= 0 ? 1 : 0;
    const moneda = ins.moneda || 'ARS';
    const costo = b * precio;
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
      cant_bruta_uso: a.bruta,
      cant_min_uso: netaMin,
      cant_max_uso: netaMax,
      existencia,
      existencia_declarada: declarada,
      cant_neta_uso: neta,
      bultos_teoricos: bultosTeoricos,
      bultos_a_comprar: b,
      exceso_multiplo: excesoMultiplo,
      exceso_moq: excesoMoq,
      exceso_uso: excesoTotal * factor,
      moq_forzado: moqForzado,
      precio_unit_snapshot: precio,
      moneda_snapshot: moneda,
      precio_fecha_snapshot: ins.precio_fecha || null,
      costo_estimado: costo,
      sin_precio: sinPrecio,
      desglose: desgPorInsumo.get(insumoId) || []
    });
  }

  // Orden: primero lo que más plata mueve, después alfabético.
  lineas.sort((x, y) => (y.costo_estimado - x.costo_estimado)
    || String(x.insumo_nombre).localeCompare(String(y.insumo_nombre), 'es'));

  for (const k of Object.keys(totales_por_moneda)) {
    totales_por_moneda[k] = round2(totales_por_moneda[k]);
  }

  // ── Paso 8 — veredicto de cobertura ─────────────────────────────────────
  // Definición EXPLÍCITA de qué bloquea. Lo que no está acá es advertencia y
  // no exige tildar nada: si todo bloqueara, el tilde se vuelve un reflejo
  // automático y la mitigación muere.
  cobertura.ok = (
    cobertura.plan_sin_objetivos === false &&
    cobertura.objetivos_en_cero.length === 0 &&
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
