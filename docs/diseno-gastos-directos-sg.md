# Diseño — Costeo punta a punta de gastos directos (San Gerónimo)

> **Estado:** análisis + propuesta para revisar. **No implementado.** Documento read‑only.
> **Fecha:** 2026‑06‑02 · **Autor:** Andy (con relevamiento del código actual).
> **Alcance:** módulo SG (comercializador frutihortícola). No toca Puente Cordón salvo donde se indica coordinación con Pablo.

---

## 0. Resumen ejecutivo (TL;DR)

- **La "partida" ya existe** en el modelo: es `sg_lotes` (identificador estable `codigo_lote`, formato `SG-LT-YYYYMMDD-NNNN`). Es trazable de **compra → venta** en ambos sentidos. **No hay que inventarla; hay que extenderla.** Esta es la mejor noticia del relevamiento.
- **Lo que falta para el costeo punta a punta del brief:**
  1. **Gastos de SALIDA** (carga, flete de entrega): hoy **no existen**. Solo hay gastos de **ingreso** atados al lote.
  2. **Muchos‑a‑muchos gasto ↔ partida**: hoy un gasto directo va a **un solo lote** (1:1). El brief pide que un gasto afecte **varias** partidas.
  3. **Prorrateo con ajuste manual**: hoy el prorrateo es **100% por kg, sin override**. El brief pide default por kg **+ ajuste manual** con la restricción suma = total.
  4. **Estimación del comercial + alerta de desvío**: hoy **no existe** ninguna de las dos.
  5. **Margen reactivo**: hoy el margen se calcula y persiste **al despachar** (congelado). Si un gasto de salida llega después, el margen ya grabado **no se actualiza solo**. Es el problema más delicado del diseño.
- **Riesgo de fondo:** el brief dice "los costos VIAJAN con la partida en ambos sentidos y se acumulan". Eso obliga a que el costo de la partida sea **mutable después de la venta** (un flete de entrega que llega tarde sube el costo de una partida ya vendida). Eso choca con el margen congelado actual y exige un **motor de recosteo**. Es construible, pero es el corazón de la complejidad.
- **Zona de Pablo:** SG hoy es un **universo aislado** (`sg_*`, sin tocar `pa_*/fin_*/adm_*`). Mientras el costeo siga interno, **no toca a Pablo**. Toca su zona el día que: (a) los gastos generen egresos en `fin_movimientos`/cajas, (b) se quiera mapear `tipo_gasto` → plan de cuentas, o (c) se consolide rentabilidad SG en lo contable multisociedad.

---

## 1. Mapeo del modelo ACTUAL (relevamiento read‑only)

Backend SG: rutas en `src/rutas/sg.js`, esquema en `src/servicios/db_sg.js`. **Universo independiente** — el header de `db_sg.js` lo dice explícito: *"Todas las tablas usan prefijo `sg_` … NO se vincula con `pa_*/adm_*/fin_*`"*.

### 1.1 Cadena de compra

| Entidad | Tabla (db_sg.js) | Rol |
|---|---|---|
| Orden de compra | `sg_oc` (:135) + `sg_oc_items` (:159) | Cabecera + ítems; `total_estimado_kg`, `total_estimado_monto`; `precio_estimado_por_kg`, `kg_estimados` por ítem. |
| Recepción | `sg_recepciones` (:171) | Recibo de mercadería de una OC. |
| **Partida** | **`sg_lotes` (:190)** | **Entidad central.** `codigo_lote` (único), `kg_reales`, `costo_base`, `costo_final`, `estado` (disponible→reservado→despachado_parcial→despachado_total→bajado), FKs `recepcion_id` + `oc_item_id`. |

### 1.2 Gastos (hoy solo lado compra)

| Tabla | Vínculo | Detalle |
|---|---|---|
| `sg_gastos_directos_lote` (:218) | `lote_id NOT NULL` → **1 gasto = 1 lote** | `tipo_gasto` ∈ `flete \| comision_productor \| descarga_especifica \| acondicionamiento \| otros`. Se suma a `costo_final` del lote. |
| `sg_gastos_globales_periodo` (:236) | por `periodo` (YYYY‑MM) | `tipo_gasto` ∈ `luz_camara \| sueldo_descarga \| iibb \| alquiler_puesto \| otros`. Se prorratea por kg entre **todos** los lotes del período. *(Renombrado en UI a "Gastos Variables".)* |

### 1.3 Cómo se calcula el costo hoy (`recalcCostoLote`, sg.js:287)

```
costo_final(lote) = costo_base
                  + Σ(gastos_directos del lote, activos)
                  + prorrateo_global
prorrateo_global  = Σ(gastos_globales del período) × (kg_lote / Σ kg_reales de lotes del período)
```

- `costo_final` es el **TOTAL del lote**, no por kg (confirmado por el backfill de db_sg.js:419 y la fórmula `costo_final / kg_reales`).
- `recalcCostoLote` se dispara en cada POST/PUT/DELETE de gasto directo; `recalcPeriodo` (sg.js:304) recalcula todos los lotes del período al tocar un gasto global.
- **Prorrateo 100% por kg. Sin columna ni endpoint de ajuste manual.** (búsqueda de `override/manual/ajuste` → nada).

### 1.4 Cadena de venta y margen

| Entidad | Tabla (db_sg.js) | Clave |
|---|---|---|
| Pedido | `sg_pedidos` (:273) + `sg_pedido_items` (:294) | Orden de venta del cliente. |
| Despacho | `sg_despachos` (:306) + `sg_despacho_items` (:329) | **`sg_despacho_items.lote_id` = clave de trazabilidad forward.** FEFO valida kg disponibles del lote antes de despachar (sg.js:1020). |

**Margen (sg.js:1051):**
```
costoPorKg = lote.costo_final / lote.kg_reales        // prorratea el total por kg
margen     = subtotal − kg_despachados × costoPorKg     // BRUTO
```
- Se **persiste** `sg_despacho_items.margen_estimado` al crear el despacho (congelado en ese momento).
- **No se descuentan gastos de salida** (no existen). El margen es bruto compra→venta.

### 1.5 Trazabilidad (#283)

- **Forward:** `GET /despachos/:id/trazabilidad` (sg.js:1104): despacho → items(lote_id) → recepción → OC → proveedor.
- **Backward:** `GET /lotes/:id/trazabilidad` (sg.js:823): lote → recepción/OC/proveedor + gastos directos + prorrateo + despachos donde se vendió.
- **El hilo de la partida está tendido en ambos sentidos.** Lo que falta es colgar de él los **costos de salida** y permitir gastos **compartidos** entre partidas.

### 1.6 CC clientes

- No hay tabla dedicada: se calcula al vuelo en `/cc-clientes` (sg.js:1141). `total_cobrado` = 0 (TODO V2 cobranzas/DSO). Sin impacto directo en este diseño, pero relevante para "rentabilidad por cliente".

---

## 2. ¿La partida existe como entidad rastreable? (punto crítico)

**Sí — y es la base sobre la que se construye todo.**

- **Identidad:** `sg_lotes.codigo_lote` (único, estable durante todo el ciclo de vida).
- **Origen (compra):** `lote.recepcion_id → sg_recepciones.oc_id → sg_oc → sg_proveedores`.
- **Destino (venta):** `sg_despacho_items.lote_id → sg_despachos → cliente`.
- **Venta parcial:** soportada. `kg_disponibles = kg_reales − Σ kg_despachados` (calculado al vuelo, sg.js:998).

**Limitaciones de la partida hoy (lo que hay que extender):**

1. **Una partida = un `oc_item` de una recepción.** Si una OC trae 3 productos, son 3 lotes. Bien para "partida comprada", pero implica que un gasto que cubre toda la OC (ej. un flete de un camión con 3 lotes) hoy **no se puede** atar a la OC y repartir: hay que cargar 3 gastos a mano. → motiva el **M:N** y el **ancla a OC/recepción** (§3).
2. **El costo de la partida es solo de compra.** El lado venta no acumula sobre la partida. → §3.
3. **Pizarra:** si la OC es a precio pizarra, `precio_unitario_kg`/`costo_base` quedan NULL hasta que se cierra el precio. El costeo de esa partida está **incompleto** hasta entonces. (riesgo, §7).

**Veredicto:** no hay que crear una entidad nueva. Hay que **extender el lote** con (a) costos de ambos lados, (b) repartos M:N, (c) ajuste manual, (d) estimaciones. El hilo ya existe.

---

## 3. Propuesta de modelo de datos

Objetivo: que **cualquier gasto** (ingreso o salida) pueda **repartirse entre varias partidas** con una proporción auditable, que el costo se **acumule sobre la partida**, y que **se herede a la venta** vía el cost‑per‑kg del lote.

### 3.1 Un gasto genérico + tabla de reparto (M:N)

Reemplaza/generaliza `sg_gastos_directos_lote`. Dos tablas:

**`sg_gastos`** (cabecera del gasto, sin importar a qué partidas pegue):
```
id
familia            TEXT  -- 'ingreso' | 'salida'
tipo_gasto         TEXT  -- ingreso: flete_ingreso|descarga|repaso|otros
                         -- salida:  carga|flete_entrega|otros
proveedor_id_gasto INTEGER → sg_proveedores
monto_total        REAL  -- el monto del gasto real
fecha              TEXT
ancla_tipo         TEXT  -- 'oc'|'recepcion'|'lote'|'despacho'|'pedido'|null
ancla_id           INTEGER  -- documento de origen (de dónde "nace" el gasto)
estimado_de_id     INTEGER → sg_gastos(id)  -- si este gasto REAL cierra una estimación (§4)
es_estimacion      INTEGER DEFAULT 0  -- 1 = fila de estimación del comercial (§4)
estado             TEXT  -- 'borrador'|'confirmado'|'anulado'
observaciones      TEXT
+ auditoría
```

**`sg_gasto_reparto`** (junción gasto ↔ partida, el M:N):
```
id
gasto_id        INTEGER NOT NULL → sg_gastos
lote_id         INTEGER NOT NULL → sg_lotes      -- la partida que recibe el costo
monto_asignado  REAL NOT NULL                    -- $ que cae en esta partida
criterio        TEXT  -- 'kg' (prorrateo automático) | 'manual' (override)
kg_snapshot     REAL  -- kg de la partida al momento del reparto (auditoría)
+ auditoría
```

**Invariante duro:** `Σ sg_gasto_reparto.monto_asignado (por gasto_id) = sg_gastos.monto_total`. Se valida en el endpoint de guardado (rechaza si no cuadra, con tolerancia de redondeo).

> **Migración:** los `sg_gastos_directos_lote` actuales mapean a un `sg_gastos` (familia='ingreso') con **un solo** `sg_gasto_reparto` (criterio='kg' o 'manual', monto = monto). Migración 1:1, idempotente, sin pérdida.

### 3.2 Acumulación sobre la partida y herencia a la venta

Nuevo `costo_final` del lote:
```
costo_final(lote) = costo_base
                  + Σ(sg_gasto_reparto.monto_asignado donde lote_id = este lote, gasto confirmado)   // ingreso Y salida
                  + prorrateo_global (igual que hoy)
```
- El costo de **ambas familias** vive en la misma junción → **un solo lugar** acumula el costo de la partida.
- **Herencia a la venta:** el margen sigue usando `costo_final / kg_reales`. Como ahora `costo_final` incluye gastos de salida, el margen los refleja automáticamente. **Pero** ver §3.4 (timing) — es el punto delicado.

### 3.3 Cómo "viaja" un gasto de salida hacia las partidas

Un gasto de salida nace en un **despacho** (ancla_tipo='despacho'). Ese despacho consumió kg de N lotes (`sg_despacho_items.lote_id`). El reparto default del gasto de salida = prorrateo por kg **entre los lotes de ese despacho**:
```
monto_asignado(lote_i) = monto_total × kg_despachados(lote_i) / Σ kg_despachados(despacho)
```
…con ajuste manual encima si el operador lo necesita. Así el flete de entrega de una venta sube el costo de **las partidas que se entregaron en esa venta** — exactamente el "viaja en ambos sentidos" del brief.

### 3.4 El problema del timing (margen congelado vs costo mutable) — **leer con atención**

- Hoy `margen_estimado` se **graba al despachar**. Si mañana llega un flete de entrega que sube `costo_final` de la partida, **ese margen grabado queda viejo**.
- Dos caminos posibles (decisión de negocio, §7):
  - **(A) Margen como vista (recomendado):** no persistir margen; calcularlo siempre on‑the‑fly desde `costo_final` vigente. Ventaja: siempre refleja el costo real acumulado. Costo: los reportes recalculan; "el margen de una venta cambia con el tiempo" hasta que la partida cierra.
  - **(B) Margen congelado + recosteo explícito:** persistir, y cuando un gasto tardío toca una partida ya vendida, **recalcular y reescribir** los `margen_estimado` de los despachos afectados (cascada `recalcCostoLote` → buscar despacho_items de ese lote → recomputar). Más control, más motor.
- En cualquier caso aparece un concepto nuevo: **"partida abierta" vs "partida cerrada"** a efectos de costo. Mientras esté abierta, su costo (y el margen de sus ventas) puede moverse.

### 3.5 Rentabilidad punta a punta (las tres lecturas del brief)

Con el modelo de arriba, las tres vistas salen de la misma junción:
- **Por compra (partida/OC):** `Σ ventas de la partida − costo_final(partida)`. Para OC: agregás sus lotes.
- **Por venta (despacho):** `Σ subtotal − Σ (kg × costo_final/kg_reales) − Σ gastos_salida del despacho`.
- **Por cliente:** agregás despachos del cliente.

---

## 4. Estimación del comercial + alerta de desvío

**Flujo propuesto (reusa `sg_gastos` con `es_estimacion=1`):**

1. Al crear la OC, el comercial carga un gasto **estimado** de flete de ingreso: `sg_gastos(familia='ingreso', tipo='flete_ingreso', es_estimacion=1, ancla=oc, monto_total=estimado)`.
2. Cuando llega el flete **real**, se carga como gasto normal y se **linkea** a la estimación (`estimado_de_id`).
3. **Desvío** = `real.monto_total − estimacion.monto_total`. Si `real > estimacion × (1 + tolerancia)` → **alerta**.

**Cómo materializar la alerta (de menor a mayor):**
- Mínimo: badge/flag en la UI de la OC y en un listado "desvíos pendientes de revisión" (patrón ya usado en SG, ej. KPIs/pills del resumen).
- Medio: estado `requiere_revision` en el gasto real hasta que un responsable lo OK‑ea.
- (No recomendado al inicio: bloquear el cierre de la OC).

**Decisiones abiertas:** % de tolerancia (¿5%? ¿$ fijo?), quién resuelve la alerta, si la estimación es obligatoria u opcional por OC.

---

## 5. Fases de implementación (de menor a mayor riesgo)

Separadas en **UI de carga** (barato, reversible) vs **motor de costeo** (caro, delicado).

| Fase | Qué | Riesgo | Toca modelo de costeo |
|---|---|---|---|
| **F0 — Reporte punta a punta (read‑only)** | Vista que combina lo que YA existe: costo de partida + margen de despachos + traza, agregado por compra/venta/cliente. Cero cambios de modelo. Entrega valor inmediato y valida el concepto con el negocio. | **Bajo** | No |
| **F1 — Gastos de SALIDA (UI carga)** | Permitir cargar carga/flete de entrega. Mínimo: extender el modelo de gasto por‑lote actual con familia='salida' atada al despacho (todavía 1 gasto→reparto simple). Sin M:N todavía. | Bajo‑medio | Sí (aditivo) |
| **F2 — M:N + prorrateo manual** | Introducir `sg_gastos` + `sg_gasto_reparto`; migrar gastos directos; default kg + override manual con invariante suma=total. **El cambio estructural grande.** | **Alto** | Sí (núcleo) |
| **F3 — Estimación + alerta de desvío** | Estimación en OC + link real↔estimado + alerta. | Medio | Aditivo |
| **F4 — Motor de recosteo / margen reactivo** | Resolver el timing (§3.4): margen como vista o recosteo en cascada. Rentabilidad consolidada definitiva. | **Alto** | Núcleo |

**Recomendación:** arrancar por **F0** (sin tocar modelo, demuestra el valor y descubre huecos de negocio antes de invertir en F2/F4). Decidir A vs B de §3.4 **antes** de F2, porque condiciona el esquema.

---

## 6. Qué toca la zona de Pablo (coordinar)

Hoy SG es **aislado** (sin `pa_*/fin_*/adm_*`), así que el costeo interno **no toca a Pablo**. Puntos de contacto a coordinar **antes** de cruzarlos:

1. **Egresos de caja:** si pagar un gasto/proveedor SG debe generar un egreso en `fin_movimientos`/cajas (como hizo Personal con el pago masivo), eso es zona Pablo → su OK explícito (igual que el OK que dio para Personal).
2. **Plan de cuentas:** si se quiere que `tipo_gasto` SG mapee a cuentas contables (para consolidar rentabilidad en lo contable), el mapeo vive en el plan de cuentas de Pablo. Mantener SG con su propio catálogo de `tipo_gasto` mientras tanto.
3. **Multisociedad:** según las decisiones cerradas de multisociedad (`docs/analisis-multisociedad` / memoria), el rumbo es plan/cajas/ventas/proveedores **por sociedad** y SG "espeja" a PC. Si la rentabilidad SG va a entrar en esa consolidación, definir con Pablo dónde vive el costo (interno SG vs ledger común).
4. **`sg_proveedores ↔ adm_proveedores`:** el hook `adm_proveedor_id` existe sin uso (db_sg.js:93). Si los gastos referencian proveedores que también son del padrón central, conviene reconciliar — coordinable.

**Mientras el costeo siga 100% dentro de `sg_*`, no hay dependencia dura con Pablo.** El cruce es una decisión, no un requisito técnico inmediato.

---

## 7. Honestidad: complejidad, riesgos y decisiones abiertas

**Lo complejo (no subestimar):**
- **Margen mutable post‑venta (§3.4).** Es el verdadero núcleo. "Los costos viajan en ambos sentidos" implica que el costo de una partida ya vendida puede cambiar → o el margen es una vista recalculada siempre, o hace falta un motor de recosteo en cascada. Cualquiera de los dos es trabajo serio y cambia cómo se leen los reportes históricos.
- **Invariante suma = total con ajuste manual.** Fácil de enunciar, incómodo en UI (redondeos, edición de una fila que descuadra el resto, qué pasa si cambian los kg de un lote después de un reparto manual). Hay que decidir si el reparto manual se "congela" o se reprorratea.
- **Migración de `sg_gastos_directos_lote`** a la junción nueva: 1:1 conceptual, pero hay que hacerla idempotente y validada contra estado de prod (lección de los crashes de migración previos).
- **Pizarra:** partidas sin precio cerrado tienen `costo_final` incompleto → el costeo punta a punta de esas partidas es provisorio hasta el cierre. Hay que mostrarlo como tal, no como dato firme.
- **Interacción prorrateo global × reparto manual:** hoy el global se prorratea por kg sobre el período; si encima hay repartos manuales de gastos directos, conviven dos lógicas. Definir precedencia.

**Riesgos:**
- Tocar `recalcCostoLote`/`recalcPeriodo` y el cálculo de margen sin romper los despachos ya grabados.
- Reportes de rentabilidad que "cambian solos" cuando llega un gasto tardío → puede confundir al usuario si no se comunica el concepto de partida abierta/cerrada.
- Performance del recosteo en cascada si una partida tocó muchos despachos.

**Decisiones de negocio que quedan ABIERTAS (hay que cerrarlas con Andy/negocio antes de F2):**
1. **¿Margen vista o congelado?** (§3.4 A vs B). Condiciona el esquema.
2. **¿Un gasto de salida sube el costo de la COMPRA de la partida** (afectando la rentabilidad de la compra), o solo la de la venta? El brief dice "ambos sentidos" → asumimos que sí, pero confirmar el efecto contable.
3. **Tolerancia de desvío** y quién aprueba la alerta.
4. **Reparto manual:** ¿se congela o se reprorratea si cambian los kg?
5. **¿Partida = `oc_item` siempre?** ¿O puede haber partidas que agrupen varios ítems/OC? (afecta cómo se ancla un gasto a "la OC").
6. **¿Costeo SG se mantiene aislado o se integra al contable de Pablo** (plan de cuentas / consolidación multisociedad) y cuándo?
7. **Estado de partida abierta/cerrada:** ¿cuándo se "cierra" una partida a efectos de costo y deja de aceptar gastos tardíos?

---

## 8. Conclusión

El hilo de la partida (`sg_lotes`) **ya existe y es trazable** en ambos sentidos — eso reduce mucho el riesgo. El costeo punta a punta del brief es **alcanzable de forma incremental**: empezar por un **reporte read‑only (F0)** que consolide lo que ya hay, agregar **gastos de salida (F1)**, y recién entonces meterse en el cambio estructural fuerte — **M:N + prorrateo manual (F2)** y **margen reactivo (F4)** — que son los que tienen riesgo real y dependen de cerrar las decisiones de negocio del §7.

La recomendación firme: **no arrancar por el modelo de fondo.** Primero F0 para validar la lectura de rentabilidad con datos reales y destapar los huecos de negocio; cerrar las 7 decisiones abiertas; y entonces sí construir el motor.
