# Módulo PERSONAL / Mano de Obra — Puente Cordón (PC)

> **Alcance de este documento:** revisión y documentación de solo lectura del módulo de Personal de Puente Cordón.
> Documentado contra `main` @ commit `a206ac3` (#293), 2026-05-31.
> Archivos involucrados: `src/servicios/db_pa.js` (schema), `src/rutas/produccion.js` (API, montado en `/api/pa`), `src/panel.html` (UI, sección `#sec-pa-personal`).
> **Nada de esto se modificó.** Los problemas detectados se anotan en §7, no se tocaron.

---

## 1. Resumen ejecutivo

El módulo de Personal gestiona la mano de obra de campo de Puente Cordón: el **padrón** de trabajadores (fijos y contratistas), la **carga diaria de asistencia** (quién trabajó, cuántas horas, en qué lote/tarea/campaña — un "dato físico" sin plata), la **valorización** semanal (aplicar tarifas para convertir esa asistencia en costo $), la imputación automática de ese costo a `pa_costos_lote` y a la **cuenta corriente** de cada trabajador/contratista, y un set de **reportes** con exportación a Excel. Conviven en el mismo módulo **dos sistemas**: el nuevo ("Personal V1": padrón + asistencias + valorización + CC, refactor en 4 fases ya completo en main) y uno **legacy** anterior (partes de trabajo + fichajes con GPS + trabajadores/cuadrillas/grupos viejos) que quedó vivo y montado en paralelo. Todo el módulo es **PC-only**: ninguna de sus tablas tiene `sociedad_id`.

---

## 2. Estructura de datos

Todas las tablas viven en `src/servicios/db_pa.js` (SQLite / better-sqlite3, creadas con `CREATE TABLE IF NOT EXISTS`). **Ninguna tabla de personal tiene columna `sociedad_id`** (ver §8).

### 2.1 Tablas "Personal V1" (sistema nuevo)

| Tabla | Qué guarda | `sociedad_id` |
|---|---|---|
| `pa_personal` | Padrón unificado de personas: fijos y contratistas | No |
| `pa_permisos_personal` | Permisos del módulo por usuario | No |
| `pa_asistencias` | Asistencia diaria (dato físico, sin $) | No |
| `pa_asistencia_valorizacion` | Valorización 1:1 de cada asistencia (agrega $) | No |
| `pa_cc_movimientos` | Cuenta corriente unificada (fijos + contratistas) | No |

**`pa_personal`** — padrón (`db_pa.js:1282`). Columnas: `id`, `tipo` (CHECK `fijo`/`contratista`), `nombre`, `dni`, `cuit`, `persona_id` (→ `personas(id)`, link opcional al módulo Equipo, solo fijos), `contratista_madre_id` (autorreferencia → `pa_personal(id)`: un fijo que pertenece a un contratista), `cuadrilla_default_id` (→ `pa_cuadrillas`), `tarifa_default` (REAL, default 0), `unidad_tarifa` (CHECK `jornal`/`hora`/`tanto`/`tacho`/`planta`/`kg`), `activo`, `notas`, auditoría (`creado_en/por`, `modificado_en/por`, `eliminado_en`, `eliminado_por_id` — soft delete). Índices por tipo, activo, madre y persona.

**`pa_permisos_personal`** — (`db_pa.js:1309`). `usuario_id` (PK → `usuarios`), `personal_asistencia` (0/1), `personal_valorizacion` (0/1), `modificado_en/por`. Una fila por usuario. El admin (`rol='admin'`) obtiene ambos permisos por código, no necesita fila.

**`pa_asistencias`** — el corazón del sistema nuevo (`db_pa.js:1377`). Columnas:

| Columna | Tipo | Notas |
|---|---|---|
| `id` | INTEGER PK | |
| `fecha` | TEXT NOT NULL | día de la asistencia |
| `cuadrilla_id` | INTEGER → `pa_cuadrillas` | de dónde viene la gente (Silva/Gordillo/…) |
| `personal_id` | INTEGER → `pa_personal` | NULL si es bloque sin nombre |
| `contratista_id` | INTEGER → `pa_personal` | contratista madre (requerido en bloque) |
| `cantidad` | INTEGER NOT NULL (def 1) | nº de personas (bloque) |
| `horas` | REAL NOT NULL | |
| `jornales_calc` | REAL | `cantidad*horas/8` (calculado al guardar) |
| `rubro_cuenta_id` | INTEGER NOT NULL | **FK lógica a `pa_cuentas(id)`** (plan de cuentas, read-only; siempre una cuenta `MO %`) — sin REFERENCES |
| `campaña_anual_id` | INTEGER NOT NULL → `pa_campañas` | |
| `campaña_estacional_id` | INTEGER NOT NULL → `pa_campañas` | |
| `lote_id` | INTEGER NOT NULL → `pa_lotes` | |
| `finca` | TEXT | denormalizado del lote |
| `tarea_tipo_id` | INTEGER → `pa_tareas_tipos` | |
| `cultivo` | TEXT | denormalizado opcional |
| `estado` | TEXT | CHECK `pendiente_valorizar`/`valorizado`/`anulado` |
| `notas`, `cargado_por`, auditoría, `anulado_en/por/motivo` | | |

Índices por fecha, estado, personal, contratista, lote.

**`pa_asistencia_valorizacion`** — (`db_pa.js:1417`). `asistencia_id` (**UNIQUE** → relación 1:1 con `pa_asistencias`), `tarifa_unitaria`, `unidad_tarifa` (copiada del padrón al valorizar), `monto_total`, `detalle_json` (breakdown), `valorizado_por`, `fecha_valorizacion`, `costo_lote_id` (→ `pa_costos_lote`), `cc_movimiento_id` (→ `pa_cc_movimientos`). Cruza los IDs de las dos cosas que genera al valorizar.

**`pa_cc_movimientos`** — cuenta corriente (`db_pa.js:1431`). `tipo_titular` (CHECK `fijo`/`contratista`), `titular_id` (→ `pa_personal`), `fecha`, `tipo_mov` (CHECK `devengado`/`pago`/`adelanto`/`ajuste`/`anulacion`), `monto` (**>0 le debemos** / **<0 le pagamos**), `descripcion`, `referencia_tipo` + `referencia_id` (FK lógica polimórfica: apunta a `pa_asistencias` cuando `referencia_tipo='asistencia'`, o a movimientos manuales), `saldo_acumulado` (denormalizado, recalculado cronológicamente), `cargado_por`, `anulado` (0/1), `anulado_en/por`. Índices por `(tipo_titular, titular_id)` y fecha.

### 2.2 Tablas LEGACY (sistema viejo, sin borrar)

| Tabla | Qué guarda | `sociedad_id` |
|---|---|---|
| `pa_trabajadores` | Padrón viejo (reemplazado conceptualmente por `pa_personal`) | No |
| `pa_grupos` | Clasificación administrativa del trabajador (ej. "Personal Fijo") | No |
| `pa_cuadrillas` | Cuadrillas (Silva/Gordillo/…) — **compartida** con el sistema nuevo | No |
| `pa_tareas_tipos` | Catálogo de tareas — **compartida** (la usa `pa_asistencias`) | No |
| `pa_rubros_contables` | Rubros del sistema viejo (≠ plan de cuentas) — seedeada con 20 filas | No |
| `pa_partes_trabajo` (+ `_items`) | Cabecera + items de partes de trabajo (carga vieja de MO) | No |
| `pa_partes_valorizacion` | Valorización de partes (1:1 con parte) | No |
| `pa_fichajes_cuadrilla` | Fichajes mañana/tarde con GPS (capataz desde el Scout) | No |

Notas:
- `pa_cuadrillas` y `pa_tareas_tipos` son **compartidas**: las usa tanto el sistema viejo como el nuevo, por eso siguen vivas y necesarias.
- `pa_trabajadores` recibió 2 columnas por migración: `grupo_id` (→ `pa_grupos`) y `personal_id` (→ `pa_personal`, para cruzarse con el padrón nuevo).
- **Ojo conceptual:** el sistema viejo imputa rubros vía `pa_rubros_contables`; el nuevo (`pa_asistencias.rubro_cuenta_id`) apunta al **plan de cuentas** (`pa_cuentas`, las cuentas `MO %`). Son dos universos de "rubro" distintos.

### 2.3 Migraciones y seeds relevantes

- `migrarTrabajadoresGrupo()` (`db_pa.js:1247`) — agrega `pa_trabajadores.grupo_id`.
- `migrarTrabajadoresPersonalId()` (`db_pa.js:1319`) — agrega `pa_trabajadores.personal_id`.
- `migrarTrabajadoresAPersonal()` (`db_pa.js:1332`) — **migración de datos** idempotente (guardada por `sistema_flags` key `migracion_pa_personal_v1`): copia los `pa_trabajadores` activos a `pa_personal` como `tipo='fijo'` y los vincula de vuelta.
- `migrarCostosLoteOrigen()` (`db_pa.js:1456`) — agrega `pa_costos_lote.origen TEXT`. Clave para Personal V1: el valor `'asistencia'` aísla los costos generados por asistencias de los generados por partes viejos o aplicaciones (que comparten la columna `referencia_id`).
- `seedGrupoDefault()` (`db_pa.js:1258`) y `seedRubrosContables()` (`db_pa.js:1467`) — seeds del sistema viejo.

### 2.4 Mapa de relaciones (flujo de datos)

```
                 personas (Equipo)        pa_cuadrillas      pa_tareas_tipos      pa_lotes / pa_campañas
                      │  (solo fijos)          │  (compartidas)      │                     │
                      ▼                        ▼                     ▼                     ▼
   ┌──────────────────────────────────────────────────────────────────────────────────────────┐
   │  pa_personal  ──(personal_id / contratista_id)──►  pa_asistencias  ◄── rubro_cuenta_id ── pa_cuentas (MO %)
   │     (padrón)                                          (dato físico)        (FK lógica, read-only)
   └──────────────────────────────────────────────────────┬───────────────────────────────────┘
                                                           │ valorizar (bulk)
                                                           ▼
                                              pa_asistencia_valorizacion (1:1, agrega $)
                                                  │                    │
                                  costo_lote_id  ▼                    ▼  cc_movimiento_id
                                   pa_costos_lote                 pa_cc_movimientos
                                 (origen='asistencia',            (devengado +monto;
                                  referencia_id positivo)          pago/adelanto/ajuste −;
                                                                   saldo_acumulado)

   LEGACY paralelo:  pa_trabajadores → pa_partes_trabajo(_items) → pa_partes_valorizacion
                                                              └→ pa_costos_lote (referencia_id NEGATIVO, sin CC)
                     pa_fichajes_cuadrilla (GPS, capataz)
```

---

## 3. Flujos principales (paso a paso)

### 3.1 Alta de una persona (padrón)
1. Sub-tab **👥 Personal** → botón **+ Nuevo** → abre el modal de padrón (Modal A).
2. Se elige `tipo`: **fijo** o **contratista**.
   - Si es **fijo**: puede linkearse a una `persona` del módulo Equipo (`persona_id`) y/o a un **contratista madre** (`contratista_madre_id`). Puede tener tarifa.
   - Si es **contratista**: NO puede tener `persona_id` ni madre (el backend lo valida).
3. La **tarifa** (`tarifa_default` + `unidad_tarifa`) solo la puede cargar/ver quien tenga permiso de **valorización** (o admin). Quien solo tiene permiso de **asistencia** no ve ni edita tarifas (separación de funciones).
4. `POST /api/pa/personal/padron` inserta en `pa_personal` con `creado_por`.

### 3.2 Carga de asistencia diaria
1. Sub-tab **📝 Asistencia diaria** → se elige la **Fecha** (default hoy) → botón **+ Nueva fila** → abre el modal de asistencia (Modal B, 14 campos).
2. Se elige **Tipo de registro**:
   - **Individual** → se selecciona una **Persona** (`personal_id`).
   - **Bloque** → se selecciona un **Contratista** + **Cantidad de personas** (sin nombrar a cada uno).
3. Se completan horas, **rubro** (una cuenta `MO %` del plan de cuentas), **campaña anual + estacional** (por default las vigentes), **finca/lote** (autocompleta el cultivo), tarea opcional, notas.
4. `POST /api/pa/personal/asistencias` valida (`_validarAsistencia`), calcula `jornales = cantidad*horas/8`, denormaliza la finca, y guarda con `estado='pendiente_valorizar'`. **No hay plata todavía.**
5. La pantalla lista las asistencias de esa fecha; cada fila se **edita** (solo si está pendiente) o **borra** vía el modal. Hay un resumen "N filas · X jornales".

### 3.3 Valorización → costo + cuenta corriente (el flujo $)
1. Sub-tab **💰 Por valorizar** → navega por **semana (jueves→jueves)** → ve las asistencias `pendiente_valorizar` con la **tarifa default** del padrón precargada (editable por fila) y un **monto preview** en vivo.
2. Selecciona filas → **💰 Valorizar selección** → `POST /api/pa/personal/valorizar` (bulk, transaccional). Por cada asistencia:
   - Inserta el costo en **`pa_costos_lote`** (`origen='asistencia'`, `referencia_id` positivo, categoría según rubro/titular vía `_categoriaCostoAsistencia`).
   - Inserta un **devengado** (+monto) en **`pa_cc_movimientos`** del titular.
   - Inserta `pa_asistencia_valorizacion` cruzando ambos IDs.
   - Pasa la asistencia a `estado='valorizado'`.
   - Recalcula el `saldo_acumulado` de los titulares tocados.
3. **Anular** una asistencia valorizada (`POST /personal/asistencias/:id/anular`, requiere motivo): borra el costo del lote, inserta un contramovimiento `anulacion` (−monto) en la CC, recalcula saldo y marca la asistencia `anulado`. Todo transaccional.

### 3.4 Cuenta corriente: pagos / adelantos / ajustes
1. Sub-tab **📒 Cuenta Corriente** → lista de titulares con su saldo → click abre el detalle cronológico con saldo corrido.
2. Sub-tab **💸 Pagos/Adelantos** o el botón del detalle → modal (Modal C) → `POST /personal/cc/movimiento`. **Pago/Adelanto** se guardan en negativo (bajan el saldo); **Ajuste** respeta el signo.

### 3.5 Consulta / reportes
- Sub-tab **📈 Reportes**: 5 reportes (por trabajador / por contratista / por finca / por rubro / cierre semanal), todos sobre asistencias **valorizadas**, con rango de fechas y **export a Excel** (`.xlsx` generado server-side con SheetJS).
- Sub-tab **🏷️ Tareas / Rubros**: read-only — rubros MO con conteo de uso + catálogo de tareas.

---

## 4. Endpoints

Todos montados en `/api/pa` (router `produccion.js`, `index.js:174`). Auth: `requireAuth` (cookie `lnb_user`) o `requireAdmin` (rol admin). El gating fino de personal lo resuelve `permisosPersonal(db, user)` (`produccion.js:2986`): admin → todo; resto → flags de `pa_permisos_personal`.

### 4.1 Permisos del módulo
| Método + Path | Gating | Qué hace |
|---|---|---|
| `GET /personal/mis-permisos` | requireAuth | Devuelve los permisos del usuario actual |
| `GET /personal/permisos` | **requireAdmin** | Lista usuarios con sus flags asistencia/valorización |
| `POST /personal/permisos` | **requireAdmin** | UPSERT de permisos de un usuario |

### 4.2 Padrón (`pa_personal`)
| Método + Path | Gating | Qué hace |
|---|---|---|
| `GET /personal/personas-equipo` | requireAuth | Proxy read-only a `personas` (para linkear fijos), `?q=` |
| `GET /personal/padron` | requireAuth | Lista padrón (`?tipo=&q=&incluir_inactivos=`); oculta tarifas sin permiso de valorización |
| `GET /personal/padron/:id` | requireAuth | Detalle; si es contratista adjunta sus fijos |
| `POST /personal/padron` | requireAuth + perms | Alta (valida tipo/madre; solo val/admin fijan tarifa) |
| `PATCH /personal/padron/:id` | requireAuth + perms | Edición |
| `DELETE /personal/padron/:id` | requireAuth + perms | Soft delete |
| `POST /personal/padron/:id/reactivar` | requireAuth + perms | Reactiva |

### 4.3 Asistencia (`pa_asistencias`)
| Método + Path | Gating | Qué hace |
|---|---|---|
| `GET /personal/cuentas-mo` | requireAuth | Cuentas del plan con `nombre LIKE 'MO %'` |
| `GET /personal/asistencias/defaults` | requireAuth | Catálogos para el modal (campañas, cuentas MO, lotes, tareas, cuadrillas, personal) |
| `GET /personal/asistencias` | requireAuth | Grilla por `?fecha=` o `?desde=&hasta=&estado=` (excluye anuladas por default) |
| `POST /personal/asistencias` | requireAuth + perms | Alta de asistencia (dato físico) |
| `PATCH /personal/asistencias/:id` | requireAuth + perms | Edita **solo si pendiente_valorizar** |
| `DELETE /personal/asistencias/:id` | requireAuth + perms | Borra (físico) **solo si pendiente** |

### 4.4 Valorización + CC
| Método + Path | Gating | Qué hace |
|---|---|---|
| `GET /personal/valorizar` | val/admin | Pendientes del rango con tarifa default + monto preview |
| `POST /personal/valorizar` | val/admin | **Bulk transaccional**: costo + devengado CC + valorización + estado=valorizado |
| `POST /personal/asistencias/:id/anular` | val/admin | Revierte costo + CC + estado (requiere motivo) |
| `GET /personal/cc/titulares` | val/admin | Titulares con saldo (`?tipo=&q=&con_saldo=`) |
| `GET /personal/cc/:tipo/:id` | val/admin | Detalle cronológico + saldo corrido |
| `POST /personal/cc/movimiento` | val/admin | Pago/adelanto (signo −) o ajuste |
| `POST /personal/cc/movimiento/:id/anular` | val/admin | Anula mov manual (rechaza devengado/anulacion) |

### 4.5 Reportes (Fase 4) + Tareas/Rubros
| Método + Path | Gating | Qué hace |
|---|---|---|
| `GET /personal/reportes/{por-trabajador,por-contratista,por-finca,por-rubro}` (+ `.xlsx`) | val/admin | 4 reportes sobre valorizadas, JSON o Excel, `?desde=&hasta=` |
| `GET /personal/reportes/cierre-semanal` (+ `.xlsx`) | val/admin | Consolida la semana jueves→jueves (`?fecha_inicio_jueves=`) |
| `GET /personal/reportes/rubros-uso` | asist/val/admin | Cuentas MO con conteo de uso |
| `GET/POST /personal/tareas-tipos` (+ `PATCH /:id`) | requireAuth | CRUD catálogo de tareas |
| `GET /personal/sugerir-rubro` | requireAuth | Sugiere rubro según lote+tarea |
| `GET/POST /personal/admin/costos-origen` | **requireAdmin** | Backfill one-shot de `pa_costos_lote.origen` (dry-run + ejecución) |

### 4.6 Legacy (siguen montados)
- **Partes de trabajo**: `GET /personal/partes`, `GET /personal/partes/:id`, `POST /personal/partes` (guarda foto en `data/scout/personal/`), `DELETE /personal/partes/:id`, `POST /personal/partes/:id/valorizar` (imputa a `pa_costos_lote` con `referencia_id` **negativo**, **sin** CC), `POST /personal/partes/:id/anular`, `GET /personal/dashboard` (dashboard de **partes**, no de asistencias).
- **Fichajes con GPS**: `POST/GET /personal/fichajes`, `PATCH/DELETE /personal/fichajes/:id`, `GET /personal/fichajes-stats`.
- **Catálogos viejos** (todos `requireAuth`): CRUD de `/personal/rubros`, `/personal/cuadrillas`, `/personal/grupos`, `/personal/trabajadores` (+ sus `:id/reactivar`).

> ⚠️ Todos los endpoints legacy usan **solo `requireAuth`** (no chequean permisos de personal). Ver §7.2.

---

## 5. UI

Sección `#sec-pa-personal` (`panel.html:3848`). Estado global `PP` (`panel.html:18903`), fetch helper `paF()`, navegación por sub-tabs `ppShowSub()`. El gating (`ppAplicarGating`) muestra/oculta los tabs nuevos: `verModulo = asistencia||val||admin` (tabs Asistencia/Personal/Tareas-Rubros), `verVal = val||admin` (Por valorizar/CC/Pagos/Reportes), `admin` (Permisos).

### 5.1 Sub-tabs (14)
| Sub-tab | Tipo | Gated |
|---|---|---|
| ⏰ Pendientes / 📚 Histórico (fichajes) | legacy | No (siempre visible) |
| 👥 Trabajadores / 🏷️ Grupos / 🚜 Cuadrillas / 📊 Rubros | legacy | No |
| 📝 Asistencia diaria | V1 | verModulo |
| 👥 Personal (padrón) | V1 | verModulo |
| 💰 Por valorizar | V1 | verVal |
| 📒 Cuenta Corriente | V1 | verVal |
| 💸 Pagos/Adelantos | V1 | verVal |
| 📈 Reportes | V1 | verVal |
| 🏷️ Tareas / Rubros | V1 | verModulo |
| ⚙️ Permisos | V1 | admin |

Los 6 primeros (sistema viejo) están siempre visibles incluso sin permisos del módulo. Al entrar, si el usuario tiene algún permiso de módulo abre **Asistencia**; si no, **Pendientes** (fichajes).

### 5.2 Modales (3)

**Modal A — Personal / padrón** (`mb-pp-personal`): Tipo* (select fijo/contratista), Nombre*, DNI, CUIT, Persona (Equipo)*, Contratista madre*, Cuadrilla default, Tarifa default ($)†, Unidad tarifa†, Notas. (* = campos "solo fijo" se ocultan si es contratista; † = campos "solo valorización" se ocultan sin permiso.)

**Modal B — Asistencia diaria** (`mb-pp-asist`): **14 campos** — Fecha*, Cuadrilla, Tipo de registro* (radios individual/bloque), Persona* (individual), Contratista* + Cantidad de personas* (bloque), Horas*, Rubro (cuenta MO)*, Campaña anual*, Campaña estacional*, Finca/Lote*, Tarea, Cultivo (auto del lote), Notas.

**Modal C — Movimiento de CC** (`mb-pp-ccmov`): Titular*, Tipo* (pago/adelanto/ajuste), Monto $*, Fecha, Descripción.

### 5.3 La planilla de asistencia
No es una grilla tipo Excel ni filas editables inline. Es una **tabla de lectura por día**: selector de **Fecha** arriba + botón **+ Nueva fila** (que abre el Modal B). Columnas: Cuadrilla · Persona/Bloque · Cant. · Horas · Jorn. · Rubro · Campañas · Finca/Lote · Tarea · Cultivo · Estado · acciones. Cada "fila" es una asistencia (un POST). El `<thead>` se arma por JS (en el HTML está vacío). Sin paginación.

---

## 6. Estado real de la asistencia (vs. el brief)

El brief original mencionaba **~12.000 filas** y un **modal de 11 campos**. La realidad en main es distinta:

- **No existe ninguna planilla de 12.000 filas.** La asistencia se carga **de a una fila por vez** mediante el Modal B, y se consulta **por día** (o por rango en los reportes). No hay una grilla masiva ni carga bulk de filas; no hay paginación ni virtualización porque no se diseñó para volúmenes grandes en una sola vista. La "planilla" es una tabla de lectura del día elegido.
- **El modal tiene 14 campos, no 11** (Fecha, Cuadrilla, Tipo de registro, Persona, Contratista, Cantidad, Horas, Rubro, Campaña anual, Campaña estacional, Finca/Lote, Tarea, Cultivo, Notas). Los campos Persona vs Contratista+Cantidad se muestran/ocultan según el modo (individual/bloque), así que el usuario nunca ve los 14 a la vez.
- El modelo de datos sí soporta volumen (`pa_asistencias` indexada por fecha/estado/personal/etc.), pero la **UI no está pensada para visualizar miles de filas juntas**: si se quisiera una vista de planilla anual, hoy no existe.

En resumen: el sistema quedó como **carga puntual + valorización semanal + reportes**, no como una planilla anual de 12k filas editable.

---

## 7. Deuda técnica / cosas raras (anotadas, NO tocadas)

### 7.1 Dos sistemas de carga de MO coexisten
El módulo tiene el sistema **viejo** (partes de trabajo + fichajes GPS + trabajadores/cuadrillas/grupos) y el **nuevo** (padrón + asistencias + valorización + CC) montados en paralelo, ambos accesibles. Ambos imputan a `pa_costos_lote` pero con convenciones distintas: asistencias usan `referencia_id` **positivo** + `origen='asistencia'`; partes usan `referencia_id` **negativo**. Riesgo de **doble carga** del mismo trabajo y de confusión conceptual (Trabajadores viejo vs Personal nuevo; Rubros viejos vs cuentas MO; Tareas viejo vs Tareas/Rubros nuevo).

### 7.2 Gating inconsistente entre legacy y V1
Toda la rama nueva (padrón, asistencias, valorización, CC, reportes) chequea `permisosPersonal`. **Todos los endpoints legacy** (partes, fichajes, trabajadores, cuadrillas, grupos, rubros, tareas-tipos) usan **solo `requireAuth`**: cualquier usuario logueado —aunque no tenga permisos de personal— puede crear/editar/borrar/**valorizar partes** e impactar `pa_costos_lote`. En particular `POST /personal/partes/:id/valorizar` imputa costo al lote sin chequear permiso de valorización.

### 7.3 "Pagos/Adelantos" no lista movimientos
El sub-tab 💸 Pagos/Adelantos (`ppLoadPagos`, `panel.html:19604`) deja un comentario ("listar sería caro") y siempre muestra un **placeholder**; su tabla (Fecha/Titular/Tipo/Monto/Descripción) nunca recibe datos reales. Funcionalmente incompleto (el alta sí funciona; lo que falta es el listado).

### 7.4 UI huérfana: panel "Tareas"
Existe el div `#pp-sub-tareas` (`panel.html:3940`) con su tabla, pero **no hay ningún `.pp-subtab` que lo invoque** ni dispatch en `ppShowSub` → es UI inalcanzable / código muerto (su función la cubre el tab "Tareas / Rubros" nuevo).

### 7.5 Backfill como endpoint permanente
`/personal/admin/costos-origen` es claramente una **migración one-shot** (clasifica `pa_costos_lote.origen` de filas viejas, guardada por `sistema_flags`) que quedó como endpoint admin permanente. Si el flag ya está seteado, no hace nada.

### 7.6 Otras menores
- `cc/titulares?con_saldo=1` filtra por **cantidad de movimientos > 0**, no por saldo ≠ 0 → el nombre del flag es engañoso (titulares con saldo cero pero con movimientos siguen apareciendo).
- En valorización de asistencias se pasa `campaña_anual_id` tanto a `campaña_id` como a `campaña_anual_id` de `pa_costos_lote` (duplicado intencional por la columna legacy `campaña_id NOT NULL`). La lógica de campañas no es homogénea entre asistencias y partes.
- El nombre de propiedad del body usa eñe (`campaña_anual_id`/`campaña_estacional_id`): frágil pero funciona (debe coincidir exacto con el backend).
- `<thead>` de asistencia y padrón están **vacíos en el HTML** (se llenan por JS): si el render falla, la tabla queda sin encabezados; además dificulta auditar la UI solo desde el markup.
- Sin paginación/virtualización en asistencia, padrón, valorizar, histórico de fichajes ni CC: todo con `.map().join('')`. Para días/padrones grandes puede degradar.
- La **foto de un parte** se escribe a `data/scout/personal/` desde el request sin validar tamaño/MIME más allá del prefijo base64 (cualquier usuario autenticado) — superficie de abuso menor.

> Nota: ninguno de estos puntos se corrigió. Quedan como observaciones para una eventual limpieza/decisión futura (especialmente §7.1 y §7.2, que son de fondo).

---

## 8. Relación con multisociedad

**El módulo de Personal es PC-only por naturaleza y NO está sociedad-izado.** Ninguna de sus 13 tablas (V1 ni legacy) tiene columna `sociedad_id`. Las migraciones de multisociedad (Fases que agregan `sociedad_id`, `db_pa.js:2762` y siguientes) listan sus tablas **explícitamente** y tocan únicamente lo **contable** (`pa_cuentas`, `pa_cuentas_secciones`, `pa_movimientos_contables`, `pa_asientos`), **financiero** (`fin_*`) y **proveedores/ventas** (`adm_proveedores`, `pa_pagos_proveedores`, `ven_*`). Ninguna `pa_*` de personal aparece ahí.

**¿Habría que tocarlo en alguna fase?** Depende de la decisión de negocio:
- Hoy la mano de obra de campo es de Puente Cordón (la operatoria agrícola). San Gerónimo (comercializadora) tiene su propio personal/IFCO en otro circuito, y no hay personal de campo "por sociedad" en este módulo.
- Si en el futuro se quisiera registrar asistencia/mano de obra de **otra sociedad** en este mismo módulo, habría que **sociedad-izar** las tablas centrales (`pa_personal`, `pa_asistencias`, `pa_cc_movimientos`, valorización) agregando `sociedad_id` y filtrando por sociedad en endpoints y UI — pero **eso no está planificado** y no forma parte de las fases de multisociedad ya hechas.
- Mientras tanto, lo correcto es asumir que **todo el personal de este módulo pertenece a PC** y que los costos que genera (`pa_costos_lote`) son de la operatoria PC. El módulo queda fuera del alcance de las fases de multisociedad actuales.

---

*Fin del documento. Generado por revisión de solo lectura — no se modificó código.*
