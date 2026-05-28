# PLAN — Refactor Módulo Personal V1 (Asistencia + Valorización + CC)

> Entregable de planificación. **No tocué código de implementación todavía.** Esto es para tu revisión antes de arrancar Fase 1.
> Nota: el brief pedía `/mnt/user-data/outputs/PLAN_PERSONAL_V1.md`, pero esa ruta no existe en este entorno Windows. Lo dejé en la raíz del repo (mismo lugar que `PLAN_SAN_GERONIMO_V1.md`).

---

## 1. ANÁLISIS DEL REPO

### 1.1 Plan de cuentas (read-only, zona de Pablo)

- **Tabla real:** `pa_cuentas` (definida en `src/servicios/db_pa.js:1514`). Router: `src/rutas/cuentas.js`, montado en `/api/pa/cuentas`.
- **Columnas:** `id, codigo, nombre, seccion_id, tipo ('resultado'|'patrimonial'), permite_lote (0/1), permite_campania (0/1), es_sistema (0/1), orden, activo, creado_en, actualizado_en`. Secciones en `pa_cuentas_secciones`.
- **NO hay campo "MO" / "Mano de Obra" explícito.** La clasificación de mano de obra es **por nombre**: las cuentas relevantes arrancan con `MO ` (ej. `1.01 MO PRODUCCION GENERAL`, `2.05 MO COSH Y EMP UVA`, `3.01 MO COSH TOMATE INDUSTRIA`) más algunas de sección 4 (`4.05 CUADRILLAS`, `4.10 HONORARIOS`, etc.).
- **Criterio de filtro propuesto para "rubros MO":** `WHERE activo=1 AND permite_lote=1 AND (nombre LIKE 'MO %' OR nombre LIKE 'MO %' OR nombre IN ('CUADRILLAS','HONORARIOS'))`. Lo dejo configurable en una constante en el backend para ajustarlo si Pablo agrega cuentas nuevas. **Decisión a confirmar (ver §3).**
- **Lectura:** `GET /api/pa/cuentas?seccion_id=&q=`. Personal solo hace `SELECT`. No se crea, no se modifica, no se toca `cuentas.js`.

### 1.2 Módulo Equipo (personas / áreas / sociedades)

- Definido en `src/servicios/db_org.js`, router `src/rutas/org.js` (`/api/org`).
- `personas`: `id INTEGER PK AUTOINCREMENT`, `dni, nombre, apellido, mail, telefono, foto_url, ubicacion_id, cargo, activo, ...`. **`personas.id` es INTEGER PK** → la FK `pa_personal.persona_id REFERENCES personas(id)` es directa y limpia.
- Lectura para el dropdown de linkeo de fijos: `GET /api/org/personas?q=&include_inactivos=0`.

### 1.3 Estado actual de Personal (lo que reemplazamos / mantenemos)

| Tabla | Estado | Decisión V1 |
|---|---|---|
| `pa_trabajadores` (`db_pa.js:1138`) | Activa. `nombre, dni, cuadrilla_habitual_id, tipo_relacion, jornal_base, unidad_jornal, grupo_id, activo` | **Legacy.** Migrar a `pa_personal`, conservar tabla + endpoints viejos |
| `pa_cuadrillas` (`db_pa.js:1116`) | Activa | **Mantener sin cambios estructurales** |
| `pa_grupos` (`db_pa.js:1129`) | Activa | **Legacy**, queda en DB |
| `pa_partes_trabajo` (`db_pa.js:1164`) + `pa_partes_valorizacion` + `pa_partes_trabajo_items` | Activa, flujo viejo | **Legacy.** No se migra; la UI nueva no los muestra |
| `pa_fichajes_cuadrilla` (`db_pa.js:1211`) | Activa (Scout/GPS) | **Legacy**, endpoints quedan |
| `pa_tareas_tipos` (`db_pa.js:1152`) | Activa | **Mantener** (catálogo de tareas) |
| `pa_rubros_contables` | Activa (usada por partes viejas) | Mantener; el flujo nuevo imputa contra `pa_cuentas`, no contra `pa_rubros_contables` |

### 1.4 Imputación a `pa_costos_lote` (cómo funciona hoy)

- Esquema (`db_pa.js:177`): `id, lote_id, campaña_id (NOT NULL, legacy), categoria CHECK IN ('fertilizante','agroquimico','semilla','labor_propia','labor_contratada','cosecha','otros'), referencia_id, fecha, monto, descripcion, creado_en, campaña_anual_id, campaña_estacional_id`.
- **Patrón de valorización de partes** (`produccion.js:3239` `valorizar`, `:3301` `anular`), que el flujo nuevo replica casi 1:1:
  - Todo en `db.transaction()`.
  - Inserta en `pa_costos_lote` con `referencia_id = -parte.id` (prefijo negativo "para no colisionar con otros módulos"), `categoria` derivada de `tipo_labor`, `descripcion = 'MO · {tarea} · {rubro} · ...'`, `campaña_id = anual`, más `campaña_anual_id`/`campaña_estacional_id`.
  - **Anular** borra de `pa_costos_lote WHERE categoria IN (...) AND referencia_id = -id`.
- ⚠️ **Riesgo de colisión real** (ver §3): partes usan `referencia_id = -parte.id` y el brief propone `referencia_id = -asistencia_id`. Si `parte.id == asistencia.id` y comparten categoría, el `DELETE` de anular podría borrar el costo del otro. Lo resuelvo (propuesta en §3).
- `campañasActivas(db)` (`produccion.js:37`): `SELECT id FROM pa_campañas WHERE activa=1 AND tipo='anual'` y otra para `tipo='estacional'`. Una activa por tipo simultáneamente.

### 1.5 Convenciones reales confirmadas en código

- **Auth:** `requireAuth` / `requireAdmin` están definidas **localmente** en `produccion.js:15-33` (leen `req.cookies.lnb_user` JSON, admin = `rol === 'admin'`). Reutilizo esas mismas.
- **Permisos:** hoy solo existe `solo_lectura` (en `usuarios`, leído fresco en `/api/auth/me`). **No hay flags por módulo todavía** → hay que crearlos.
- **Respuesta API:** `{ok:true, data:...}` / `{ok:false, error:'...'}`, try/catch por endpoint.
- **Migraciones:** patrón IIFE + `PRAGMA table_info(tabla)` + `ALTER TABLE ADD COLUMN` idempotente, todo en `db_pa.js` al cargar el módulo. Para resets de un solo disparo hay tabla `sistema_flags` (key/valor).
- **Soft delete:** conviven `activo=0/1` (mayoría de catálogos) y `eliminado_en`/`eliminado_por_id` (órdenes, campañas). El brief fija `activo=0` + sello para `pa_personal` → uso ese.
- **Montaje de rutas:** `app.use("/api/pa", produccionRouter)` (`index.js:174`) → un `router.get('/personal/...')` queda en `/api/pa/personal/...`.
- **Frontend:** sección `#sec-pa-personal` (`panel.html:2877`), sub-tabs `.pp-subtab[data-sub]` + `ppShowSub(sub)` (`panel.html:17594`), helper `paF(url,opts)`, objeto global `LNB_USER` (`{id,nombre,rol,solo_lectura,...}`), modales `.mb/.mbox` (`mb.on` muestra), export Excel vía `window.open('/api/.../x.xlsx')` (patrón IFCO).

---

## 2. PLAN EN FASES (4 fases mergeables, apiladas)

Siguiendo la convención San Gerónimo (branches apiladas: cada fase brancha de la anterior hasta mergear a `main`). Dependencia lineal: **F1 → F2 → F3 → F4**.

---

### 🔹 FASE 1 — Padrón unificado + migración + permisos

**Branch:** `andy/feat-personal-v1-padron` · **Tamaño: M**

**Tablas:**
- **Crea** `pa_personal` (esquema completo del brief: `tipo, nombre, dni, cuit, persona_id, contratista_madre_id, cuadrilla_default_id, tarifa_default, unidad_tarifa, activo, notas` + auditoría `creado_en/por, modificado_en/por, eliminado_en, eliminado_por_id`).
- **Migración idempotente** `pa_trabajadores → pa_personal`: por cada `pa_trabajadores` activo crea fila `tipo='fijo'`, `tarifa_default=jornal_base`, `unidad_tarifa` mapeado desde `unidad_jornal` (`dia→jornal`, `hora→hora`, resto→`tanto`), `cuadrilla_default_id=cuadrilla_habitual_id`. Idempotente vía `sistema_flags` (`migracion_pa_personal_v1`).
- **Agrega** `pa_trabajadores.personal_id` (FK a `pa_personal`) para cruce posterior.
- **Permisos:** agrega columnas `personal_asistencia INTEGER DEFAULT 0` y `personal_valorizacion INTEGER DEFAULT 0` a `usuarios` (migración en `db.js`). Admin las recibe siempre por código (no por columna).

**Endpoints (`produccion.js`):**
- `GET/POST /personal/padron` · `PATCH /personal/padron/:id` · `DELETE` (soft) · `POST /personal/padron/:id/reactivar`.
- `GET /personal/cuentas-mo` (proxy read-only de `pa_cuentas` filtrado a MO).
- `GET /personal/personas-equipo` (proxy de `org` para el dropdown de linkeo de fijos).
- `pa_cuadrillas`: reutiliza endpoints existentes.

**Backend permisos (`auth.js`):** agregar `personal_asistencia`/`personal_valorizacion` al objeto `userData` del login y del `/me`, y a los endpoints de alta/edición de usuarios. Admin → ambos `true`. **Toca `auth.js` + UI admin de usuarios (zona Pablo) → ver §3.**

**Frontend (`panel.html`):**
- Reorganizar las sub-tabs de `#sec-pa-personal` al set nuevo (esqueleto con gating por permiso/rol; las tabs de fases siguientes quedan como placeholders vacíos).
- Sub-tab **👥 Personal** (padrón) funcional: lista con filtros tipo/activo/búsqueda, modal alta/edición, dropdown `personas` para fijos, sin columna de tarifa para rol asistencia.
- Sub-tab **🚜 Cuadrillas**: mantener la existente.
- Gating: `LNB_USER.rol==='admin' || LNB_USER.personal_asistencia` etc.

**Criterio "hecha":** migración corre idempotente sin romper datos; padrón CRUD operativo; fijos linkeables a `personas`; permisos viajan en la cookie y togglean sub-tabs.

---

### 🔹 FASE 2 — Asistencia diaria (dato físico)

**Branch:** `andy/feat-personal-v1-asistencia` (de F1) · **Tamaño: L**

**Tablas:** crea `pa_asistencias` (esquema completo del brief). `jornales_calc = cantidad*horas/8.0` calculado al insertar/actualizar. `finca`/`cultivo` denormalizados desde el lote.

**Endpoints:**
- `GET /personal/asistencias?fecha=` (grilla del día) · `POST` · `PATCH /:id` (solo si `estado='pendiente_valorizar'`) · `DELETE /:id` (solo pendientes).
- Validaciones: `campaña_anual_id` debe ser `tipo='anual'` y `campaña_estacional_id` `tipo='estacional'` (ambas obligatorias); `personal_id` NULL ⇒ `contratista_id` requerido; `cantidad ≥ 1`.
- `GET /personal/asistencias/defaults` (campañas vigentes sugeridas + lotes + tareas).

**Frontend:** sub-tab **📝 Asistencia diaria**: selector de fecha (default hoy), grilla tipo Excel, modal Nueva/Editar fila (Individual/Bloque, dropdowns cuadrilla/personal/contratista/rubro MO/campañas/lote/tarea/cultivo). **Sin columnas $.** Badge de estado. Valorizadas en read-only.

**Criterio "hecha":** rol Asistencia carga N filas mixtas (individual + bloque), el sistema valida campañas obligatorias y bloque-sin-contratista, una persona puede tener varias filas el mismo día, no se ve ningún monto.

---

### 🔹 FASE 3 — Valorización + Cuenta Corriente + imputación a costos

**Branch:** `andy/feat-personal-v1-valorizacion` (de F2) · **Tamaño: XL** (la fase más pesada)

**Tablas:** crea `pa_asistencia_valorizacion` y `pa_cc_movimientos` (esquemas del brief). Migración aditiva en `pa_costos_lote` para resolver colisión de `referencia_id` (ver §3 — propongo columna `origen TEXT`).

**Endpoints:**
- `GET /personal/valorizar?desde=&hasta=` — asistencias `pendiente_valorizar` del rango (semana jueves-a-jueves), agrupadas por titular, con tarifa default + preview de monto.
- `POST /personal/valorizar` (bulk, **transaccional**): por cada asistencia → crea `pa_asistencia_valorizacion`, inserta en `pa_costos_lote` (mapeo rubro→categoría, campañas anual+estacional, `referencia_id`+`origen='asistencia'`), crea `pa_cc_movimientos` (`devengado`, monto>0, `saldo_acumulado` recalculado), cruza IDs, pasa estado a `valorizado`.
- `POST /personal/asistencias/:id/anular` (**transaccional**): `pa_cc_movimientos` `anulacion` (monto opuesto), borra/soft-delete el costo del lote (`origen='asistencia'` + ref), estado `anulado`, `anulado_motivo` obligatorio, recalcula saldos.
- CC: `GET /personal/cc/titulares` · `GET /personal/cc/:tipo/:id` (detalle cronológico con saldo acumulado) · `POST /personal/cc/pago` · `/adelanto` · `/ajuste`.

**Frontend:** sub-tabs **💰 Por valorizar** (semana jueves-jueves, override de tarifa por línea, "Valorizar selección" + resumen), **📒 Cuenta Corriente** (titulares con saldo, detalle + botones Pago/Adelanto/Ajuste/Export), **💸 Pagos/Adelantos** (modal rápido + últimos N). Todo gated a `personal_valorizacion`/admin.

**Criterio "hecha":** valorización bulk con override impacta `pa_costos_lote` (campañas correctas) y CC (devengado +); anular revierte CC y costo transaccionalmente; saldo acumulado correcto; pagos/adelantos/ajustes bajan/ajustan saldo.

---

### 🔹 FASE 4 — Reportes + Export Excel + Rubros/Tareas

**Branch:** `andy/feat-personal-v1-reportes` (de F3) · **Tamaño: L**

**Endpoints:** `GET /personal/reportes/por-trabajador` · `/por-contratista` · `/por-finca` · `/por-rubro` · `/cierre-semanal?fecha_inicio_jueves=`, cada uno con su variante `.xlsx` (reutilizando el helper SheetJS del módulo IFCO).

**Frontend:** sub-tab **📊 Reportes** (selectores de período/titular/finca/rubro + tablas + botón Export) y sub-tab **🏷️ Tareas / Rubros** (catálogo de tareas existente + rubros MO read-only con conteo de uso en asistencias).

**Criterio "hecha":** los 5 reportes devuelven JSON estructurado y `.xlsx` descargable; el cierre semanal arranca siempre en jueves y consolida el rango; rubros se muestran read-only con conteo.

---

### Resumen de dependencias

```
F1 (padron) ──► F2 (asistencia) ──► F3 (valorizacion) ──► F4 (reportes)
   M               L                   XL                    L
```

Cada fase es mergeable a `main` por separado y deja el módulo en estado consistente.

---

## 3. CONFLICTOS / DECISIONES A CONFIRMAR

1. **🔴 Colisión de `referencia_id` en `pa_costos_lote`.** Partes viejas ya usan `referencia_id = -id`; el brief propone lo mismo para asistencias. Si una asistencia y un parte tienen el mismo `id` y categoría solapada, el `DELETE` de anular borraría el costo del otro. **Propuesta:** agregar columna aditiva `origen TEXT` a `pa_costos_lote` (valores `'parte'`/`'asistencia'`/`'aplicacion'`) y filtrar siempre por `origen`. Es un `ALTER ADD COLUMN` no destructivo dentro del dominio PA. *(Alternativa sin tocar esquema: offset grande, ej. `referencia_id = -(1e9 + asistencia_id)`. Más feo pero cero cambio de schema.)* **¿Cuál preferís?**

2. **🟡 Toca zona de Pablo (permisos).** Agregar `personal_asistencia`/`personal_valorizacion` obliga a editar `auth.js` (objeto `userData` en login/`/me` + alta/edición de usuarios) y la **UI admin de usuarios en `panel.html`** (que el brief marca como co-mantenida por Pablo). NO toco `cuentas.js` ni `pa_cuentas`. ¿OK que toque `auth.js` + el form de usuarios, o coordinás con Pablo primero?

3. **🟡 Criterio "cuentas MO".** No existe campo MO; propongo filtrar por `nombre LIKE 'MO %'` + algunas de sección 4 (`CUADRILLAS`, `HONORARIOS`), configurable por constante. ¿Te sirve ese criterio o querés una lista explícita de códigos?

4. **🟡 Mapeo rubro → `categoria` de `pa_costos_lote`.** El enum `categoria` no se mapea 1:1 con `pa_cuentas`. Propongo: `tipo_titular='contratista' → 'labor_contratada'`, `'fijo' → 'labor_propia'`, y si la cuenta MO es de cosecha/empaque (`nombre LIKE '%COSH%'`) → `'cosecha'`. ¿Confirmás esa regla?

5. **🟢 `pa_costos_lote.campaña_id` es NOT NULL (legacy).** Lo seteo `= campaña_anual_id` para retrocompat (igual que hace el flujo de partes). Sin acción de tu parte, solo lo dejo registrado.

6. **🟢 Tabla de migración como flag.** Uso `sistema_flags` para que la migración `pa_trabajadores→pa_personal` corra una sola vez en Railway. Idempotente y seguro.

---

**Espero tu OK (y las decisiones de §3) para arrancar Fase 1.**
