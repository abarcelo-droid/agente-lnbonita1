# Análisis de mapeo Módulo → Sociedad

> **Tipo de documento:** diagnóstico + plan. **Solo lectura.** No modifica código ni
> ejecuta migraciones. Requiere **OK explícito de Andy + Pablo** (dueño de la zona
> contable) antes de implementar cualquier cambio sobre `cuentas.js`, `db_pa.js` o la
> zona contable del panel.
>
> **Fecha original:** 2026-05-30
> **Contexto:** BETA, sin datos productivos reales (arrancan en julio 2026). No hay
> que preservar ni inferir históricos: se puede ir directo al schema correcto y crear
> columnas `NOT NULL` desde el arranque. El backfill **no** es una restricción.

---

## ⚠️ ACTUALIZACIÓN — 2026-07-04 (reemplaza el diagnóstico del 2026-05-30)

> **Este bloque supersede el hallazgo central del diagnóstico original.** El resto del
> documento (PARTE A en adelante) se conserva como registro histórico, pero **quedó
> viejo en un punto clave**: cuando se escribió (30/5) decía *"ninguna tabla de datos
> tiene `sociedad_id`"*. **Eso ya no es cierto.** Entre junio y julio corrieron tres
> migraciones (MS-F1/F2/F3) que bajaron `sociedad_id` a todo el mundo contable/financiero
> de Puente Cordón, y San Gerónimo se construyó como **copia física paralela**. Leer
> este bloque primero; lo de abajo, como contexto.
>
> Material para la charla **Andy + Pablo**. Read-only: no propone implementación, deja
> la decisión de Ola 2 diagnosticada. **Zona contable = de Pablo — coordinar.**

### U.0 TL;DR actualizado

- **El principio "`sociedad_id` transversal" YA está implementado — pero solo para el
  universo PC/legacy (`pa_*` / `fin_*` / `ven_*` / `adm_*`).** Todo lo existente quedó
  asignado a Puente Cordón (`NOT NULL DEFAULT = PC`).
- **San Gerónimo NO se sumó a ese modelo particionado.** Se construyó como **copia
  física completa** (`sg_*` / `sg_fin_*`, PR #420), **sin `sociedad_id`**, aislada por
  prefijo de tabla.
- **Resultado: hoy hay DOS ledgers heterogéneos** (PC particionado por `sociedad_id` +
  SG copiado físicamente), no un único ledger particionado. Es la **divergencia clave**
  entre el principio decidido y lo construido.
- **Plan de cuentas: ya NO es único.** `pa_cuentas` tiene `sociedad_id` +
  `UNIQUE(sociedad_id, codigo)`; las 75 cuentas originales son `sociedad_id = PC`. SG
  tiene su propio plan en `sg_cuentas` (aparte). En la práctica `pa_cuentas.sociedad_id`
  es **mono-valuado (solo PC)** porque SG nunca inserta ahí.
- **Intercompany: 0%.** No hay flag ni tabla de marcado entre sociedades.
- **Consolidación de familia: 0% financiero.** "Familia" existe como capa de org/UI, sin
  reporting consolidado ni eliminación de intercompany.

### U.1 Las tres migraciones que cambiaron el estado (zona Pablo, `db_pa.js`)

| Fase | Ref | Tablas que recibieron `sociedad_id` |
|---|---|---|
| **MS-F1** — cimiento contable | `db_pa.js:2925` | `pa_cuentas`, `pa_cuentas_secciones`, `pa_movimientos_contables`, `pa_asientos` — `NOT NULL`, **`UNIQUE(sociedad_id, codigo)`**, existentes→PC |
| **MS-F2** — financiero | `db_pa.js:3129` | `fin_cuentas`, `fin_chequeras`, `fin_cheques_propios`, `fin_cheques_terceros`, `fin_movimientos`, `fin_extracto_lineas`, `fin_conciliaciones`; `fin_ordenes_pago` **rebuild** con `UNIQUE(sociedad_id, numero)` (`fin_op_compras` deriva por join) |
| **MS-F3** — proveedores + ventas | `db_pa.js:3105` | `adm_proveedores`, `pa_pagos_proveedores`, `ven_clientes`, `ven_liquidaciones`, `ven_facturas`, `ven_cobranzas` |

`ordenes.js` (Tesorería/OP) ya opera la dimensión punta a punta: deriva `sociedad_id` de
`fin_cuentas`/`adm_proveedores` y la propaga a `fin_movimientos`, `fin_ordenes_pago` y
`pa_asientos` (`ordenes.js:34-234`) → es el router más alineado con el principio.

### U.2 Inventario real — tres estrategias conviviendo

| Grupo | Tablas | ¿`sociedad_id`? | Estrategia | Zona |
|---|---|---|---|---|
| **PC contable/financiero** | `pa_cuentas*`, `pa_asientos`, `pa_movimientos_contables`, `fin_*` (7), `ven_*` (4), `adm_proveedores`, `pa_pagos_proveedores` | ✅ **SÍ** (MS-F1/F2/F3) | dimensión transversal (existentes→PC) | **Pablo** |
| **SG completo** | `sg_cuentas*`, `sg_asientos*`, `sg_movimientos_contables`, `sg_asientos_modelo*`, `sg_fin_cuentas`, `sg_fin_movimientos`, `sg_fin_ordenes_pago`, `sg_*` operativo | ❌ **NO** | copia física (aislamiento por prefijo) | **Pablo** (contable) + Andy (operativo) |
| **Operativo / UI** | `sociedades`, `areas`, `modulos_config` (`db_org.js`) | ✅ (org) | capa presentación/permisos | Andy / org |
| **Legacy suelto** | `proveedores` (`db_org.js:74`) | ⚠️ columna existe pero **siempre NULL** (sin uso) | huérfana | — |

### U.3 GAP — principio de diseño vs realidad (actualizado)

| Principio | Realidad hoy | Estado | Costo de cerrar | Zona |
|---|---|---|---|---|
| `sociedad_id` transversal en ledger/cajas/comprobantes | ✅ hecho en `pa_/fin_/ven_/adm_` (PC); ❌ ausente en `sg_*` | 🟡 **parcial** (PC sí, SG no) | Alto (unificar dos stacks) | **Pablo** |
| Plan de cuentas por sociedad | ✅ `pa_cuentas` particionado; ❌ SG en `sg_cuentas` aparte | 🟡 **parcial / inconsistente** | Medio-alto | **Pablo** |
| 3 sociedades como un solo modelo particionado | ❌ PC=`pa_`, SG=`sg_` (dos mundos físicos) | 🔴 **divergente** | Alto (migrar SG a `pa_`, o aceptar híbrido) | **Pablo** |
| Familia = capa de consolidación | ⚠️ existe como org/UI; sin consolidación financiera | 🔴 **0% financiero** | Alto (UNION heterogéneo `pa_`+`sg_` + eliminaciones) | **Pablo** + transversal |
| Intercompany marcable/eliminable | ❌ inexistente | 🔴 **0%** | Medio (flag + tabla de matcheo) | **Pablo** + operativo |
| Catálogo de sociedades correcto | ✅ `sociedades` (PC/SG/BT/Familia) bien modelado | 🟢 **alineado** | — | transversal (Andy/org) |
| Sidebar por sociedad | ✅ `modulos_config.sociedad_id` | 🟢 **alineado** | — | transversal (Andy/org) |

### U.4 Las dos piezas en 0% (imprescindibles para "mirada de familia")

1. **Flag intercompany.** No existe forma de marcar operaciones entre sociedades
   (PC produce → SG comercializa; BT transporta para ambas). Conceptualmente el vínculo
   existe (`sg_lotes` origen `finca_propia`/`granel` = "viene de PC"), pero **no es
   marcable ni distinguible**. Falta columna/tabla de marcado + criterio de matcheo.
2. **Motor de consolidación de familia.** No hay ningún reporting financiero consolidado
   (ni UNION PC+SG, ni eliminación de intercompany). "Familia" (`sociedades` id=4) es hoy
   solo etiqueta de org/UI. Falta el motor de consolidación con eliminaciones.

### U.5 La decisión de Ola 2 (SG) — dos caminos (ZONA PABLO)

La pregunta de fondo **ya no es "falta `sociedad_id`"** (está para PC). Es: **¿SG se
unifica al stack particionado, o se acepta el híbrido?**

| | **Camino A — Unificar** | **Camino B — Híbrido** |
|---|---|---|
| Qué | Migrar contable/tesorería/ventas de SG desde `sg_*`/`sg_fin_*` a `pa_/fin_/ven_` con `sociedad_id = SG` | Mantener `sg_*` físico; construir la mirada de familia como capa de reporting que UNE `pa_` + `sg_` |
| Ledger | **Uno solo**, particionado por `sociedad_id` | **Dos**, heterogéneos, unidos en reporting |
| Consolidación familia | Sale casi sola (`GROUP BY sociedad_id` + eliminaciones) | Requiere mapear planes de cuenta heterogéneos y UNION explícito |
| Costo | **Alto** — re-migra todo lo que Pablo copió en #420 | **Medio-alto en reporting** — no re-migra SG |
| Riesgo | Toca contable SG productivo (Pablo) | Deuda estructural: dos schemas espejo que hay que mantener en paralelo |
| Fidelidad al principio | ✅ Fiel ("un ledger particionado") | ⚠️ Convive con la divergencia |

**En ambos caminos** siguen faltando las dos piezas de U.4 (intercompany + motor de
consolidación). La elección es **arquitectónica y enteramente zona contable de Pablo** —
este documento la deja diagnosticada, sin proponer implementación.

---

## 0. Resumen ejecutivo (TL;DR)

- El sistema **ya modela sociedad, pero solo en la capa de presentación/permisos**
  (`sociedades`, `areas`, `modulos_config.sociedad_id` en `db_org.js`). Esto decide
  **qué módulo se le muestra a quién**, no a qué sociedad pertenece **cada registro**.
- **Ninguna tabla de datos operativos, financieros o contables tiene `sociedad_id`.**
  La única tabla de datos con la columna es `proveedores` (legacy), que la recibió por
  un `ALTER` de la Fase 1 de Org y **hoy está sin usar** (siempre NULL).
- La sociedad de cada registro hoy se infiere **por la familia de tablas / prefijo**
  (`pa_*` → Puente Cordón, `sg_*` → San Gerónimo, `ifco_*`/abasto → San Gerónimo), no
  por una dimensión explícita. Eso funciona mientras una familia de tablas pertenezca a
  **una sola** sociedad — y deja de funcionar exactamente en la capa **contable/financiera**,
  que es **compartida** entre sociedades.
- **Mayor riesgo:** el **ledger contable y el plan de cuentas son únicos y globales**
  (`pa_cuentas`, `pa_cuentas_secciones`, `pa_movimientos_contables`, `pa_asientos`),
  y las cajas, cheques, órdenes de pago, facturas y cobranzas (`fin_*`, `ven_*`, `adm_*`,
  legacy `caja`/`cheques_*`) **no tienen sociedad**. Hoy, un asiento, un movimiento de
  caja o una factura **no se pueden atribuir a una sociedad** salvo por convención implícita.
- **Operaciones intercompany** (Puente Cordón produce → San Gerónimo comercializa;
  Barceló transporta para ambas) **existen conceptualmente** (`sg_lotes.recepcion_id`
  NULL = `finca_propia` "viene de PA") pero **no son marcables ni distinguibles** hoy.

**Veredicto adelantado:** **NO** está claro hoy a qué sociedad afecta cada registro en
la zona contable/financiera. Sí está razonablemente claro en la zona operativa (por
prefijo de tabla). Falta `sociedad_id` transversal en ledger, cajas, comprobantes,
proveedores y movimientos; plan de cuentas por sociedad; y un flag intercompany.

---

# PARTE A — DIAGNÓSTICO

## A.0 Cómo está modelada hoy la "sociedad"

`db_org.js` crea y siembra cuatro entidades en la tabla `sociedades`:

| id (seed) | nombre               | funcion     | ¿Es sociedad jurídica real? |
|-----------|----------------------|-------------|-----------------------------|
| 1         | Puente Cordón SA     | productiva  | Sí (Producción — San Juan)  |
| 2         | San Gerónimo SA      | comercial   | Sí (Comercialización — MCBA)|
| 3         | Barceló Transporte SRL | transporte| Sí (Logística — sin desarrollar) |
| 4         | Familia              | estructura  | **No** — consolidación/reporting |

Esto coincide con el contexto de negocio (3 sociedades + Familia como capa de
consolidación). **El problema no es el catálogo de sociedades — está bien. El problema
es que esa dimensión no baja a las tablas de datos.**

`modulos_config.sociedad_id` (también en `db_org.js`) mapea **cada módulo del sidebar**
a una sociedad, para filtrar el sidebar (`sidebar-v2.js` → `moduloVisibleEnSociedad()`).
Es una etiqueta de UI, no una FK de datos. Y como se verá, **ese mapeo de UI no siempre
coincide con la semántica real de las tablas** (casos `ven-*` y el header de `db_sg.js`).

---

## A.1 Inventario completo de módulos y tablas

Fuentes cruzadas: routers en `src/rutas/` (montados en `src/index.js`), seed de
`modulos_config` (65 módulos de sidebar en `db_org.js`), y definiciones `CREATE TABLE`
en `src/servicios/db*.js`, `catalogo*.js`, `sheets.js`.

### Tabla resumen Parte A

> "¿Tiene `sociedad_id`?" se refiere a las **tablas de datos** del módulo. **NO** = ninguna
> tabla de datos del módulo tiene la columna. La etiqueta de `modulos_config` (UI) no cuenta
> como dato del registro.

| # | Módulo (router / grupo sidebar) | Sociedad(es) real(es) | Clasificación | ¿`sociedad_id` en datos? | Tablas afectadas | Riesgo |
|---|---|---|---|---|---|---|
| 1 | **Auth / Usuarios** (`auth.js`, `org maestro-usuarios`) | — | TRANSVERSAL/SISTEMA | N/A | `usuarios`, `sesiones` | Bajo |
| 2 | **Org / Organigrama** (`org.js`, `sidebar.js`) | Todas (catálogo) | TRANSVERSAL/SISTEMA | Sí (es el dueño del concepto) | `sociedades`, `areas`, `ubicaciones`, `personas`, `personas_areas`, `modulos_config`, `usuarios_favoritos` | Bajo |
| 3 | **Clima** (`clima.js`) | Puente Cordón (implícito) | IMPLÍCITO | NO | (sin tabla propia / clima externo) | Bajo |
| 4 | **CRM Dedicados** (`crm.js`) | San Gerónimo | IMPLÍCITO | NO | `crm_clientes`, `crm_historial` | Bajo |
| 5 | **Cotización / Oferta / Pricing** (`cotizacion.js`, `oferta.js`) | San Gerónimo | IMPLÍCITO | NO | `catalogo_items`, `sheet_*` (precios) | Bajo |
| 6 | **Abasto / Stock / Remitos / Partidas** (`abasto.js`) | San Gerónimo | IMPLÍCITO | NO (salvo `proveedores`, col. sin uso) | `proveedores`, `partidas`, `movimientos_stock`, `remitos_salida`, `remitos_items` | Medio |
| 7 | **Abasto — Comprobantes/Financiero legacy** (`abasto.js`) | San Gerónimo | IMPLÍCITO | **NO** | `facturas_compra`, `facturas_venta`, `liquidaciones_consignacion`, `gastos`, `cta_cte_proveedores`, `cta_cte_clientes`, `caja`, `caja_operador`, `cheques_propios`, `cheques_terceros` | **ALTO** |
| 8 | **IFCO / Abasto IFCO** (`ifco.js`, `mandata.js`) | San Gerónimo | IMPLÍCITO | NO | `ifco_talonarios(_log)`, `ifco_remitos_super`, `ifco_envios_proveedor`, `ifco_movimientos`, `ifco_recepciones_proveedor`, `mandatas`, `mandatas_items` | Medio |
| 9 | **Retail** (`catalogo_v2.js`) | San Gerónimo | IMPLÍCITO | NO | `retail_productos`, `retail_gastos`, `retail_precios_canal`, `retail_ean`, `retail_seleccion` | Medio (`retail_gastos` toca números) |
| 10 | **Guardias / Comerciales / Turnos** (`db2.js`) | San Gerónimo | IMPLÍCITO | NO | `comerciales`, `turnos_base`, `guardias`, `catalogo_items`, `facturas` (db2) | Bajo |
| 11 | **San Gerónimo Comercialización** (`sg.js`) | San Gerónimo | IMPLÍCITO (fuerte) | NO | `sg_productos`, `sg_presentaciones`, `sg_condiciones_pago(_cuotas)`, `sg_proveedores`, `sg_clientes`, `sg_oc(_items)`, `sg_recepciones`, `sg_lotes`, `sg_gastos_directos_lote`, `sg_gastos_globales_periodo`, `sg_oc_vencimientos`, `sg_pedidos(_items)`, `sg_despachos(_items)` | Medio-Alto (genera costos/márgenes/vencimientos) |
| 12 | **Producción Agrícola — operativa** (`produccion.js`, `scout.js`) | Puente Cordón | IMPLÍCITO (fuerte) | NO | `pa_sectores`, `pa_lotes`, `pa_cultivos_lote`, `pa_campañas`, `pa_insumos`, `pa_proveedores`, `pa_compras(_items)`, `pa_movimientos_stock`, `pa_ordenes(_lotes/_items)`, `pa_aplicaciones`, `pa_costos_lote`, `pa_combustible_*`, `pa_vehiculos`, `pa_vinculacion_factura_recarga`, `pa_panol_*` | Medio |
| 13 | **Personal / Cuadrillas / Asistencia** (`produccion.js`) | Puente Cordón | IMPLÍCITO | NO | `pa_cuadrillas`, `pa_grupos`, `pa_trabajadores`, `pa_tareas_tipos`, `pa_partes_trabajo(_items)`, `pa_partes_valorizacion`, `pa_fichajes_cuadrilla`, `pa_personal`, `pa_permisos_personal`, `pa_asistencias` | Medio (`pa_partes_valorizacion` toca costos) |
| 14 | **Plan de Cuentas + Ledger contable** (`cuentas.js`, `produccion.js/costos`) | **Compartido** (hoy = plan agrícola PC, usado también por SG) | **AMBIGUO** | **NO** | `pa_cuentas`, `pa_cuentas_secciones`, `pa_movimientos_contables`, `pa_cuentas_log`, `pa_rubros_contables` | **ALTO** |
| 15 | **Asientos (partida doble)** (`cuentas.js`) | **Ambiguo** | **AMBIGUO** | **NO** | `pa_asientos`, `pa_asientos_lineas`, `adm_asientos_modelo(_lineas)` | **ALTO** |
| 16 | **Administración Contable / Proveedores** (`proveedores.js`, `pagos.js`) | **Ambiguo** (UI=Familia) | **AMBIGUO** | **NO** | `adm_proveedores`, `adm_config_impositiva`, `pa_pagos_proveedores`, `pa_pagos_compras` | **ALTO** |
| 17 | **Financiero — Caja/Bancos/Cheques/OP/Conciliación** (`bancos.js`, `ordenes.js`) | **Ambiguo** (UI=Familia) | **AMBIGUO** | **NO** | `fin_cuentas`, `fin_chequeras`, `fin_cheques_propios`, `fin_cheques_terceros`, `fin_movimientos`, `fin_ordenes_pago`, `fin_op_compras`, `fin_extracto_lineas`, `fin_conciliaciones` | **ALTO** |
| 18 | **Ventas (liquidaciones acopiador / facturas / cobranzas)** (`ventas.js`, `liquidaciones.js`) | **Ambiguo** (UI=SG, semántica=productor/PC) | **AMBIGUO** | **NO** | `ven_clientes`, `ven_liquidaciones`, `ven_liquidacion_items`, `ven_facturas`, `ven_factura_items`, `ven_cobranzas`, `ven_cobranza_docs` | **ALTO** |
| 19 | **Cobranza (legacy)** (`cobranza.js`) | San Gerónimo | IMPLÍCITO | NO | reusa `cta_cte_clientes`, `facturas_venta` | Medio |
| 20 | **Panel / Buscar / Nuevos / Sheets sync** (`panel.js`, `buscar.js`, `nuevos.js`, `sheets.js`) | Mixto/Sistema | TRANSVERSAL/SISTEMA | N/A | `sheet_compras`, `sheet_ventas`, `sheet_sync_log`, `sistema_flags` | Bajo |
| 21 | **Barceló Transporte** | Barceló Transporte | — | N/A (sin desarrollar) | (ninguna tabla aún) | — (futuro) |

---

## A.2 Detalle de los módulos AMBIGUOS

Estos son el centro del problema. En todos, el código **no** modela sociedad y la
inferencia por prefijo **falla** porque la tabla es compartida o está mal etiquetada.

### AMBIGUO-1 — Plan de cuentas y ledger contable (`pa_cuentas`, `pa_movimientos_contables`) — **el más crítico**

- **Problema concreto:** existe **un único** plan de cuentas global (`pa_cuentas` +
  `pa_cuentas_secciones`) y **un único** ledger (`pa_movimientos_contables`). El plan
  sembrado es claramente **agrícola de Puente Cordón** (secciones "COSTO DE PRODUCCION",
  cuentas "MO PRODUCCION UVA/MELON/DAMASCO", "ABONOS Y FERTILIZANTES", etc.).
- **Pero** otras zonas referencian ese mismo plan:
  - `ven_clientes.cuenta_contable_id → pa_cuentas(id)`
  - `fin_cuentas.cuenta_contable_id → pa_cuentas(id)`
  - `fin_cheques_terceros.cuenta_contable_id → pa_cuentas(id)`
  - `adm_config_impositiva.cuenta_id → pa_cuentas(id)`
  - `adm_asientos_modelo_lineas.cuenta_id → pa_cuentas(id)`
  - `pa_asientos_lineas.cuenta_id → pa_cuentas(id)`
- **Qué pasa hoy con un registro:** un movimiento en `pa_movimientos_contables` tiene
  `lote_id`, `campania_id`, `cultivo_id`, `origen_tipo/origen_id`, pero **no sociedad**.
  Si una venta de San Gerónimo o un pago de "Familia" impacta una cuenta de este plan,
  el asiento queda mezclado con la contabilidad agrícola de Puente Cordón. **No hay forma
  de generar un balance por sociedad** ni de separar la contabilidad de las tres personas
  jurídicas. Contradice de raíz el principio "plan de cuentas POR sociedad".
- **Conclusión:** AMBIGUO de máximo riesgo. Requiere decisión de Pablo sobre la estrategia
  (un plan por sociedad vs. plan único con `sociedad_id` por cuenta).

### AMBIGUO-2 — Financiero: cajas, bancos, cheques, órdenes de pago (`fin_*`)

- **Problema concreto:** `fin_cuentas` (cajas y cuentas bancarias) no tiene dueño-sociedad.
  Una cuenta bancaria pertenece **a una** persona jurídica (la titular del CBU). Hoy todas
  las cuentas viven en un pool único. `fin_movimientos`, `fin_cheques_propios/terceros`,
  `fin_ordenes_pago`, `fin_conciliaciones` heredan esa ambigüedad.
- **UI vs. realidad:** `modulos_config` etiqueta `fin-caja-bancos` y `fin-ordenes-pago`
  como **Familia**. Pero Familia **no opera ni tiene caja propia** (es consolidación). Las
  cajas/bancos reales son de Puente Cordón y/o San Gerónimo. La etiqueta "Familia" acá es
  un placeholder, no una verdad de negocio.
- **Qué pasa hoy:** un cheque emitido o un movimiento de banco **no se puede atribuir** a
  la sociedad que efectivamente pagó/cobró. Imposible armar flujo de caja por sociedad.

### AMBIGUO-3 — Administración / Proveedores contables (`adm_proveedores`, pagos)

- **Problema concreto:** `adm_proveedores` es el padrón contable unificado (migró
  `pa_proveedores` hacia acá). No tiene `sociedad_id`. Un mismo proveedor puede facturar
  a Puente Cordón y a San Gerónimo; o la deuda con él pertenece a una sola sociedad. Hoy
  no se distingue. `pa_pagos_proveedores`/`pa_pagos_compras` (que saldan `pa_compras`)
  tampoco tienen sociedad.
- **Fragmentación de padrones de proveedores (problema relacionado):** existen **cuatro**
  padrones distintos — `proveedores` (legacy abasto SG, única con `sociedad_id` y sin uso),
  `pa_proveedores` (PC, en deprecación), `adm_proveedores` (contable unificado),
  `sg_proveedores` (San Gerónimo). `sg_proveedores.adm_proveedor_id` es un gancho NULLABLE
  previsto para reconciliar, **sin uso en V1**. La multisociedad debería decidir si el
  padrón es único con `sociedad_id` por relación, o por sociedad.

### AMBIGUO-4 — Ventas `ven_*`: etiqueta UI (San Gerónimo) ≠ semántica (productor / Puente Cordón)

- **Problema concreto:** las tablas `ven_*` están **físicamente en `db_pa.js`**, referencian
  el **plan de cuentas agrícola** (`pa_cuentas`) y los **asientos** (`pa_asientos`), y
  `ven_liquidaciones` se define como *"Liquidaciones de Producto (recibidas del acopiador)"* —
  esa es la operatoria del **productor que vende su cosecha vía acopiador/consignatario**,
  es decir **Puente Cordón**. Sin embargo, `modulos_config` etiqueta todos los `ven-*` como
  **San Gerónimo**.
- **Coexistencia con `sg_*`:** San Gerónimo ya tiene su propio universo de venta moderno
  (`sg_pedidos`, `sg_despachos`, `sg_lotes`...). Entonces hay **dos** subsistemas de venta
  con dueños distintos pero etiquetas que se pisan. **No se puede saber del código** si
  `ven_*` es venta de SG o de PC sin una decisión de negocio.
- **Qué pasa hoy:** una `ven_factura` o una `ven_cobranza` **no se puede atribuir** con
  certeza a una sociedad; el código sugiere PC (productor), la UI dice SG.

### AMBIGUO-5 — Asientos manuales (`pa_asientos`)

- **Problema concreto:** un asiento de partida doble puede pertenecer a cualquiera de las
  sociedades. Hoy `pa_asientos` no tiene `sociedad_id` y se apoya en el plan único. Sin
  separar sociedad, el libro diario es uno solo para todo el grupo — lo opuesto a tres
  contabilidades separadas.

---

## A.3 Detalle de los módulos IMPLÍCITOS (sociedad inferible pero no modelada)

En estos, la inferencia por prefijo/familia de tabla es **confiable hoy** (cada familia
pertenece a una sola sociedad), pero **no es un dato**: si Barceló empezara a compartir
tablas, o si se quisiera un filtro/refuerzo a nivel registro, no hay columna.

- **Producción Agrícola (`pa_*` operativo, ítems #12–13):** todo es **Puente Cordón**.
  Inferencia segura por prefijo `pa_`. Riesgo: las que tocan plata (`pa_costos_lote`,
  `pa_partes_valorizacion`, `pa_compras`, `pa_aplicaciones.costo_total`) alimentan el
  ledger compartido, así que su falta de sociedad **contamina** AMBIGUO-1.
- **San Gerónimo (`sg_*`, ítem #11):** todo es **San Gerónimo**. Inferencia segura por
  prefijo `sg_`. Riesgo medio-alto porque genera costos por lote, márgenes y vencimientos
  de pago (`sg_oc_vencimientos`, `sg_gastos_*`) que eventualmente deben asentarse en la
  contabilidad de SG — y esa contabilidad hoy no existe separada (ver AMBIGUO-1).
- **Abasto / IFCO / Retail / CRM / Guardias (db.js legacy, db2.js, catalogo_v2.js):**
  todo **San Gerónimo**. Inferencia por dominio. Las tablas financieras legacy de abasto
  (`caja`, `cheques_*`, `cta_cte_*`, `facturas_*`, `gastos`) son **ALTO riesgo** (ítem #7):
  generan movimientos financieros sin sociedad y **podrían solaparse** con el subsistema
  `fin_*` moderno (ver A.5).
- **Clima (`clima.js`):** Puente Cordón (clima de fincas San Juan). Sin tabla propia
  relevante; riesgo nulo.

> **Header engañoso a corregir (documental):** `db_sg.js` línea 2 dice
> `"MÓDULO SAN GERÓNIMO — PUENTE CORDON SA"`. El cuerpo describe operatoria mayorista
> MCBA (que es San Gerónimo). El `— PUENTE CORDON SA` parece un copy-paste erróneo y
> **contradice** tanto el contexto de negocio como el seed de `modulos_config` (que asigna
> `sg` a San Gerónimo SA). No afecta datos, pero confunde el mapeo. Conviene corregir el
> comentario cuando se toque el archivo.

---

## A.4 Módulos que generan movimientos contables/financieros SIN `sociedad_id` (máximo riesgo)

Lista priorizada — son los que, sin sociedad, rompen la contabilidad separada:

1. `pa_movimientos_contables` — **ledger central**, fuente única de verdad de reportes.
2. `pa_asientos` / `pa_asientos_lineas` — libro diario (partida doble).
3. `pa_cuentas` / `pa_cuentas_secciones` — **plan de cuentas único** (debería ser por sociedad).
4. `fin_cuentas` + `fin_movimientos` — cajas/bancos y sus movimientos.
5. `fin_cheques_propios` / `fin_cheques_terceros` / `fin_chequeras`.
6. `fin_ordenes_pago` / `fin_op_compras`.
7. `fin_extracto_lineas` / `fin_conciliaciones`.
8. `adm_proveedores` (+ `pa_pagos_proveedores` / `pa_pagos_compras`).
9. `ven_facturas` / `ven_liquidaciones` / `ven_cobranzas` (+ ítems y `ven_cobranza_docs`).
10. **Legacy abasto (db.js):** `caja`, `caja_operador`, `cheques_propios`, `cheques_terceros`,
    `cta_cte_proveedores`, `cta_cte_clientes`, `facturas_compra`, `facturas_venta`,
    `liquidaciones_consignacion`, `gastos`.
11. **Operativas que alimentan el ledger:** `pa_costos_lote`, `pa_partes_valorizacion`,
    `pa_compras`, `pa_aplicaciones`, `sg_gastos_directos_lote`, `sg_gastos_globales_periodo`,
    `sg_oc_vencimientos`, `sg_lotes` (costo).

---

## A.5 Operaciones intercompany detectadas y si el sistema las distingue

| Intercompany potencial | Evidencia en el código | ¿Distinguible hoy? |
|---|---|---|
| **Puente Cordón (produce) → San Gerónimo (comercializa)** | `sg_lotes` modalidad `finca_propia`; `sg_lotes.recepcion_id`/`oc_item_id` NULL = *"stub V1, viene de PA"*; `sg_oc.modalidad IN (...,'finca_propia')` | **NO.** No hay FK ni flag que ligue un lote PA con su recepción SG, ni marca de "transferencia interna". |
| **Puente Cordón (productor) → venta vía acopiador** (`ven_*`) vs. venta SG (`sg_*`) | Dos subsistemas de venta paralelos, etiquetas cruzadas (AMBIGUO-4) | **NO.** No se distingue qué venta es de qué sociedad ni si hay reventa interna. |
| **Barceló Transporte → fletes a PC y SG** | `sg_gastos_directos_lote.tipo_gasto='flete'`, `sg_despachos.transporte='propio'`, costos de flete en `ven_liquidaciones.desc_flete` | **NO.** El flete se carga como gasto/decuento, sin contraparte sociedad. Barceló aún no tiene tablas. |
| **Proveedor compartido facturando a varias sociedades** | `adm_proveedores` único sin sociedad; 4 padrones fragmentados | **NO.** |
| **Caja/banco de una sociedad pagando gasto de otra** | `fin_movimientos`/`fin_ordenes_pago` sin sociedad | **NO.** |

**Conclusión A.5:** el sistema **no puede marcar ni eliminar** operaciones intercompany
para consolidación. No existe `es_intercompany` ni `sociedad_contraparte_id` en ninguna
tabla de movimiento. Es un requisito nuevo a construir.

---

# PARTE B — ESTIMACIÓN DE ESFUERZO (planificación, NO ejecución)

## B.0 Criterio general

- **BETA sin datos reales ⇒ `NOT NULL` desde el arranque** es viable y recomendado en la
  mayoría de las tablas: se evita la deuda de una columna nullable que después hay que
  "rellenar y endurecer".
- **Excepción recomendada (dejar nullable):**
  - **Tablas de catálogo/maestro que pueden ser legítimamente transversales** a una
    sociedad (p. ej. `pa_insumos`, `sg_productos`, `pa_tareas_tipos`): si el negocio
    decide que un maestro es compartido, forzar `NOT NULL` obliga a duplicar. Conviene
    `sociedad_id` nullable = "compartido/transversal" (mismo patrón que `modulos_config`).
  - **Tablas-hijo (ítems/líneas)** donde la sociedad **se deriva del padre** (`*_items`,
    `*_lineas`, `pa_ordenes_lotes`, `ven_factura_items`, etc.): **no agregar columna**;
    la sociedad se obtiene por join. Agregarla sería denormalización redundante (y un
    punto más de inconsistencia). Salvo que se necesite por performance de query.
- **Distinción schema vs. lógica:** agregar la columna (DDL) es barato. Lo caro y riesgoso
  es la **lógica nueva**: selector de sociedad en UI, default/validación al crear,
  filtrado por sociedad en todas las queries de lectura, y reportes por sociedad.

## B.1 Tabla resumen Parte B

> Esfuerzo: **chico** (DDL + 1-2 endpoints) · **medio** (DDL + varios endpoints + UI selector)
> · **grande** (DDL + lógica de negocio nueva + reportes + decisión de arquitectura).

| Tabla | `sociedad_id` hoy | NOT NULL / nullable sugerido | Dependencias (qué tocar) | Riesgo de romper | Esfuerzo |
|---|---|---|---|---|---|
| `pa_cuentas` + `pa_cuentas_secciones` | NO | **Decisión Pablo** (ver B.2). Si plan único→nullable; si plan por soc→NOT NULL | `cuentas.js`, todo lo que lee plan (`produccion.js` costos, `ventas.js`, `bancos.js`, `pagos.js`, modelos de asiento) | **ALTO** | **grande** |
| `pa_movimientos_contables` | NO | NOT NULL | `cuentas.js`, generadores de movimientos (costos, ventas, pagos), reportes | **ALTO** | **grande** |
| `pa_asientos` (+ líneas: no) | NO | NOT NULL en cabecera; líneas derivan | `cuentas.js`, `ventas.js`, `ordenes.js` (asiento_id) | **ALTO** | medio-grande |
| `fin_cuentas` | NO | NOT NULL (la cuenta es de una sociedad) | `bancos.js`, `ordenes.js` (cuenta_fin_id), conciliación | **ALTO** | medio |
| `fin_movimientos` | NO | NOT NULL (deriva de `fin_cuentas`) o derivar por join | `bancos.js`, conciliación, reportes flujo | Medio | medio |
| `fin_cheques_propios` / `fin_cheques_terceros` / `fin_chequeras` | NO | NOT NULL (deriva de cuenta) | `bancos.js`, `ordenes.js` | Medio | medio |
| `fin_ordenes_pago` (+ `fin_op_compras`: no) | NO | NOT NULL | `ordenes.js`, `pagos.js` | Medio-Alto | medio |
| `fin_extracto_lineas` / `fin_conciliaciones` | NO | NOT NULL (deriva de cuenta) | `bancos.js` conciliación | Bajo-Medio | chico-medio |
| `adm_proveedores` | NO | **Decisión:** nullable (padrón único multi-soc) recomendado | `proveedores.js`, `pagos.js`, `ventas.js`, joins de compras | **ALTO** | grande |
| `pa_pagos_proveedores` (+ `pa_pagos_compras`: no) | NO | NOT NULL | `pagos.js` | Medio | chico-medio |
| `ven_clientes` | NO | nullable o NOT NULL según decisión AMBIGUO-4 | `ventas.js` | **ALTO** (definir dueño) | medio |
| `ven_liquidaciones` / `ven_facturas` / `ven_cobranzas` | NO | NOT NULL | `ventas.js`, `liquidaciones.js`, reportes | **ALTO** | grande |
| `pa_compras` | NO | NOT NULL (PC, hoy fijo) | `produccion.js`, `pagos.js`, pañol (`compra_id`) | Medio | chico-medio |
| `pa_costos_lote` | NO | NOT NULL (PC) | `produccion.js` costos | Medio | chico |
| `pa_partes_valorizacion` | NO | NOT NULL (PC) | `produccion.js` personal | Bajo-Medio | chico |
| `sg_lotes` / `sg_gastos_directos_lote` / `sg_gastos_globales_periodo` / `sg_oc_vencimientos` | NO | NOT NULL (SG, hoy fijo) | `sg.js` | Medio | chico-medio |
| `sg_oc` / `sg_pedidos` / `sg_despachos` (+ ítems: no) | NO | NOT NULL (SG) o derivar | `sg.js` | Bajo (todo SG) | chico |
| `pa_*` operativas restantes (lotes, insumos, ordenes, aplicaciones, combustible, panol, personal, trabajadores, partes, fichajes, asistencias) | NO | NOT NULL (PC) o **no agregar** (inferencia por prefijo) | `produccion.js`, `scout.js` | Bajo (todo PC) | chico (o nulo si se difiere) |
| **Legacy abasto financiero** (`caja`, `caja_operador`, `cheques_propios`, `cheques_terceros`, `cta_cte_proveedores`, `cta_cte_clientes`, `facturas_compra`, `facturas_venta`, `liquidaciones_consignacion`, `gastos`) | NO | **Decisión:** ¿deprecar a favor de `fin_*`/`ven_*`? | `abasto.js`, `cobranza.js` | Medio | **depende** (ver B.3) |
| `proveedores` (legacy abasto) | **SÍ** (col. sin uso) | ya existe | `abasto.js` — sólo poblar/usar | Bajo | chico |
| Tablas operativas Abasto/IFCO/Retail/CRM/db2 (no financieras) | NO | NOT NULL (SG) o no agregar | `abasto.js`, `ifco.js`, `crm.js`, `catalogo_v2.js` | Bajo (todo SG) | chico (o diferir) |
| `usuarios`, `sesiones`, `sociedades`, `areas`, `personas`, `modulos_config`, `sheet_*`, `sistema_flags` | N/A (sistema) | N/A | — | — | — |

## B.2 Decisión de arquitectura previa (bloqueante de Pablo): plan de cuentas

Antes de tocar nada hay que resolver **cómo se separa el plan de cuentas**. Dos opciones:

- **Opción A — Un plan por sociedad** (`pa_cuentas.sociedad_id NOT NULL`): cada sociedad
  tiene su propio árbol. El plan agrícola actual queda de Puente Cordón; San Gerónimo y
  Barceló arrancan su plan. Más fiel al principio "plan POR sociedad", pero obliga a
  re-sembrar planes y a que cada movimiento elija cuenta dentro de su sociedad.
- **Opción B — Plan único con `sociedad_id` por cuenta o cuentas compartidas**: un árbol
  común donde cada cuenta declara su sociedad (o NULL = compartida). Menos duplicación,
  pero más difícil de auditar como tres contabilidades separadas.

> **Recomendación (sujeta a Pablo):** Opción A para cumplir el objetivo de contabilidades
> separadas, dado que en BETA sin datos el costo de re-sembrar es nulo. Sea cual sea, **es
> la pieza keystone**: todo el ledger, asientos, ventas y financiero cuelgan de esta
> decisión.

## B.3 Decisión previa: legacy abasto financiero vs. `fin_*`/`ven_*`

Hay **dos generaciones** de tablas financieras solapadas:

- Legacy en `db.js`: `caja`, `cheques_propios/terceros`, `cta_cte_*`, `facturas_compra/venta`,
  `liquidaciones_consignacion`, `gastos` (módulo Abasto, San Gerónimo).
- Moderno en `db_pa.js`: `fin_*` (caja/bancos/cheques/OP) y `ven_*` (facturas/cobranzas).

**Antes de agregar `sociedad_id` a las legacy**, hay que decidir si se deprecan/migran al
stack `fin_*`/`ven_*` o se mantienen. Como estamos en BETA sin datos reales, **deprecar la
generación legacy es la jugada de menor deuda** — evita poner `sociedad_id` (y mantener
lógica multisociedad) en dos stacks que hacen lo mismo. **Requiere confirmación** de que
abasto SG va a usar `fin_*`/`ven_*` y no las legacy.

## B.4 Lógica nueva requerida (además del schema)

Agregar la columna es lo fácil. Lo que **sí** es trabajo de negocio:

1. **Selector de sociedad en UI** al crear comprobantes/asientos/movimientos (o derivarlo
   del contexto del módulo). Ya existe el selector de sociedad en el sidebar
   (`sidebar-v2.js`, `CURRENT_SOCIEDAD`) — se puede reusar como contexto por defecto.
2. **Validación/at-write:** cada `INSERT` de las tablas con `sociedad_id NOT NULL` debe
   setearla; en `requireAuth` ya hay usuario, falta el "sociedad activa".
3. **Filtrado por sociedad en lecturas:** todas las queries de reportes/listados deben
   filtrar (o agrupar) por `sociedad_id`. Es el grueso del esfuerzo en `cuentas.js`,
   `bancos.js`, `ventas.js`, `produccion.js`.
4. **Coherencia de FKs cruzadas:** validar que `fin_ordenes_pago.cuenta_fin_id`,
   `*.cuenta_contable_id`, etc., apunten a la **misma** sociedad que el registro.
5. **Intercompany:** agregar `es_intercompany INTEGER DEFAULT 0` y opcional
   `sociedad_contraparte_id` en tablas de movimiento (ledger, fin, ventas), + lógica de
   eliminación en consolidación (capa Familia).
6. **Vínculo PA→SG (`finca_propia`):** modelar la transferencia interna PC→SG como
   operación intercompany real (hoy es un stub NULL).

## B.5 Orden de migración sugerido (NO ejecutar)

Pensado para minimizar riesgo y no bloquear módulos en uso. Cada fase debería ser su
propio PR, validado manualmente, sin tocar lo contable sin OK de Pablo.

- **Fase 0 — Decisiones de negocio (bloqueante, sin código):**
  (a) estrategia de plan de cuentas (B.2); (b) deprecación legacy (B.3); (c) dueño real
  de `ven_*` y `fin_*` (¿Familia es placeholder?); (d) padrón de proveedores único vs.
  por sociedad. **Sin esto, no se toca schema contable.**

- **Fase 1 — Cimiento contable (alto valor, alto riesgo, requiere Pablo):**
  `pa_cuentas` + `pa_cuentas_secciones` (según B.2) → `pa_movimientos_contables` →
  `pa_asientos`. Es el keystone: habilita reportes por sociedad. Se hace primero porque
  todo lo demás referencia el plan/ledger.

- **Fase 2 — Financiero (cajas/bancos):** `fin_cuentas` (raíz) → cascada a `fin_movimientos`,
  `fin_cheques_*`, `fin_chequeras`, `fin_ordenes_pago`, conciliación. La sociedad nace en
  `fin_cuentas` y se deriva hacia abajo.

- **Fase 3 — Comprobantes y proveedores:** `adm_proveedores` (decisión padrón) →
  `ven_*` (resuelto AMBIGUO-4) → `pa_pagos_proveedores`. Conecta compras/ventas con el
  ledger ya sociedad-izado.

- **Fase 4 — Operativas que alimentan costos (bajo riesgo, todo de una sola sociedad):**
  `pa_compras`, `pa_costos_lote`, `pa_partes_valorizacion` (PC) y
  `sg_lotes`/`sg_gastos_*`/`sg_oc_vencimientos` (SG). Acá `sociedad_id` es casi una
  constante por tabla; el valor real es habilitar el join uniforme al ledger.

- **Fase 5 — Resto operativo + legacy (opcional / diferible):** `pa_*` y `sg_*`/abasto/IFCO
  restantes. Como la inferencia por prefijo ya es segura, esto puede **diferirse** o
  resolverse con **vistas** (`sociedad_id` calculada) en vez de columna física, salvo que
  se necesite uniformidad transversal o que Barceló empiece a compartir tablas.

- **Fase 6 — Intercompany + consolidación Familia:** flags `es_intercompany` /
  `sociedad_contraparte_id`, modelar PC→SG `finca_propia`, y la capa de eliminación para
  reporting consolidado de "Familia".

**Justificación del orden:** se empieza por el ledger (Fase 1) porque es la fuente de
verdad de la que cuelgan ventas, financiero y costos; sin sociedad ahí, nada más cierra.
Luego se baja por las raíces (cuentas bancarias → movimientos; proveedores → comprobantes)
para que la sociedad se **derive** en lugar de setearse manualmente en cada hijo. Lo
puramente operativo (inferible por prefijo) queda al final porque es el de menor riesgo y
mayor volumen de queries a tocar.

---

# Veredicto final

**¿Está claro hoy a qué sociedad afecta cada módulo? → Parcialmente. Para la zona
contable/financiera: NO.**

- **Operativo (`pa_*`, `sg_*`, abasto/IFCO/retail/CRM):** la sociedad es **inferible con
  seguridad por la familia de tablas**, pero **no es un dato** (no hay `sociedad_id`).
  Funciona mientras cada familia siga siendo de una sola sociedad.
- **Contable/financiero (`pa_cuentas`, `pa_movimientos_contables`, `pa_asientos`, `fin_*`,
  `adm_*`, `ven_*`, legacy `caja`/`cheques_*`/`cta_cte_*`/`facturas_*`):** **NO está claro.**
  El plan de cuentas y el ledger son **únicos y globales**; cajas, cheques, OP, facturas y
  cobranzas **no tienen sociedad**; y hay **etiquetas de UI que contradicen la semántica**
  (`ven-*` = SG vs. productor/PC; `fin-*`/`adm-*` = "Familia" que no opera).

**Qué falta para cumplir la arquitectura objetivo:**
1. `sociedad_id` transversal y obligatorio en **ledger, cajas, comprobantes y movimientos**.
2. **Plan de cuentas por sociedad** (decisión de Pablo, B.2).
3. **Resolver ambigüedades de dueño:** `ven_*`, el rol real de "Familia", el header de
   `db_sg.js`, y el padrón único/fragmentado de proveedores.
4. **Marca intercompany** (`es_intercompany` / `sociedad_contraparte_id`) y modelado de la
   transferencia PC→SG (`finca_propia`) para poder eliminar en consolidación.
5. **Deprecar el stack financiero legacy** para no mantener multisociedad por duplicado.

**Honestidad sobre lo no determinable del código:**
- No se puede saber del código si `ven_*` pertenece a San Gerónimo o a Puente Cordón:
  la UI dice una cosa y la semántica/FKs sugieren otra. **Requiere definición de negocio.**
- No se puede saber a qué sociedad pertenece una cuenta bancaria, un proveedor contable o
  un asiento existente: **el dato no existe**, solo convenciones implícitas.
- "Familia" aparece como dueño de módulos financieros, pero por contexto **no es una
  sociedad operativa**; si es un placeholder o un dueño real es una **decisión pendiente**.

---

> **Próximo paso:** esperar OK explícito de **Andy** y de **Pablo** sobre las decisiones de
> Fase 0 (B.2/B.3) antes de implementar nada. Este documento no toca `cuentas.js`,
> `db_pa.js` ni la zona contable del panel.
