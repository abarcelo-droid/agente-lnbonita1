# Unificar el padrón de Personal (PC): Trabajadores (viejo) vs Personal V1 (nuevo)

> **Estado:** análisis de solo lectura + plan. **No se ejecutó ningún borrado.** Es un proyecto de varios PRs (Pañol es el grueso); se encara aparte.
> Documentado contra `main` @ #296 (`e377a82`), con el flujo legacy de partes/fichajes ya eliminado. Método: referencias en el código (no se consultó la DB productiva).
> **Decisiones tomadas por Andy** (ver §2 y §4): (1) los **grupos se conservan** → se lleva `grupo_id` a `pa_personal`; (2) **no hay contratistas** en el padrón viejo (son todos fijos) → el mapeo a `tipo='fijo'` de la migración está OK, no hay nada que corregir.

---

## Resumen

En el módulo Personal de Puente Cordón conviven **dos padrones de personas**: el viejo `pa_trabajadores` (tab "👥 Trabajadores") y el nuevo `pa_personal` (tab "👥 Personal", refactor V1). Sobra uno. La decisión es **quedarse con `pa_personal`** (es un superset del viejo y es el que usa todo el flujo nuevo: asistencias, valorización, cuenta corriente, reportes). El único bloqueante real es **Pañol** (módulo de herramientas), que referencia a `pa_trabajadores` por FK; migrarlo a `pa_personal` es el grueso del trabajo.

---

## 1) Qué hace cada uno y en qué se diferencian

Ambos son CRUDs de padrón, cada uno con su tab y sus endpoints. **No están sincronizados** entre sí.

| | **Trabajadores** (`pa_trabajadores`, viejo) | **Personal** (`pa_personal`, V1) |
|---|---|---|
| Tab UI | `data-sub="trabajadores"` (siempre visible) | `data-sub="padron"` (gated a permiso del módulo) |
| Endpoints | `/api/pa/personal/trabajadores` (CRUD) | `/api/pa/personal/padron` (CRUD) |
| Campos propios | nombre, dni, `cuadrilla_habitual_id`, `tipo_relacion` (fijo/contratista), `jornal_base`, `unidad_jornal` (dia/hora/ha/unidad), **`grupo_id`**, activo, notas | `tipo` (fijo/contratista), nombre, dni, **`cuit`**, **`persona_id`** (link al módulo Equipo), **`contratista_madre_id`** (jerarquía contratista→fijos), `cuadrilla_default_id`, `tarifa_default`, `unidad_tarifa` (jornal/hora/tanto/tacho/planta/kg), activo, notas |
| Borrado | solo `activo=0` | `activo=0` + soft-delete auditable (`eliminado_en`, `eliminado_por_id`) + `creado_por`/`modificado_por` |
| Quién lo usa | **Pañol** (herramientas), conteos de **Grupos** y **Cuadrillas** | **Asistencias V1**, valorización, cuenta corriente, reportes |

**Diferencia de fondo:** `pa_personal` es el padrón "rico" del refactor (jerarquía contratista→fijos, link al módulo Equipo, tarifa con más unidades, auditoría completa). `pa_trabajadores` es más plano, pero tiene un concepto que el nuevo **no** tiene hoy: el **`grupo_id`** (clasificación administrativa: "Personal Fijo", "Tractoristas", etc.).

**Sin sincronización:** una migración **one-time** (guardada por el flag `migracion_pa_personal_v1` en `sistema_flags`) copió los trabajadores activos a `pa_personal` (como `tipo='fijo'`) y los vinculó con `pa_trabajadores.personal_id`. Después de eso **no hay sync**: dar de alta en un tab no crea la fila en el otro. Si se siguen usando los dos, divergen.

## 2) ¿`pa_personal` ya cubre todo lo de `pa_trabajadores`?

**Sí, salvo una cosa: el `grupo`.**

| Concepto del viejo | ¿Cubierto en `pa_personal`? |
|---|---|
| nombre, dni, activo, notas | ✅ |
| `tipo_relacion` (fijo/contratista) | ✅ `tipo` |
| `cuadrilla_habitual_id` | ✅ `cuadrilla_default_id` |
| `jornal_base` + `unidad_jornal` | ✅ `tarifa_default` + `unidad_tarifa` (enum más rico) |
| **`grupo_id`** (grupo administrativo) | ❌ **No existe en `pa_personal`** |

Además `pa_personal` **agrega** `cuit`, `persona_id`, `contratista_madre_id` y auditoría. Es un **superset, salvo `grupo`**.

> **✅ Decisión (Andy):** la clasificación por **grupo se conserva** → hay que **agregar `grupo_id` a `pa_personal`** (FK a `pa_grupos`) y migrar el valor desde `pa_trabajadores.grupo_id` (vía el vínculo `personal_id`). No se baja la feature.

**Sobre el mapeo de la migración one-time:** copió **todo** como `tipo='fijo'` y mapeó la unidad ('dia'/'ha'/'unidad' → 'jornal'; 'hora' → 'hora'). 

> **✅ Decisión (Andy):** **no hay contratistas** en el padrón viejo (son todos fijos), así que el mapeo a `tipo='fijo'` es correcto y **no hay nada que corregir**.

## 3) Referencias vivas a `pa_trabajadores` (a migrar antes de deprecar)

Tras el borrado del legacy (#296), `pa_trabajadores` ya **no** lo usan Scout ni el flujo de partes/fichajes. Lo que queda vivo:

### 🔴 Pañol (herramientas) — el bloqueante real
Es la única dependencia de fondo. Tiene **2 FKs** a `pa_trabajadores`:
- `pa_panol_unidades.trabajador_actual_id` → quién tiene la herramienta ahora (FK denormalizada).
- `pa_panol_movimientos.trabajador_id` → historial de préstamo/devolución.
- Su UI (`pnInit` en `panel.html`) llena el dropdown de trabajador desde **`/api/pa/personal/trabajadores`**.

Para deprecar `pa_trabajadores` hay que: **repuntar estas FKs a `pa_personal`** (agregar columnas `personal_id` en ambas tablas de Pañol), **backfillear** los datos existentes mapeando `trabajador_id → pa_trabajadores.personal_id`, **cambiar las queries** de Pañol y **cambiar el dropdown** a `/api/pa/personal/padron`.

Referencias concretas en `produccion.js`: `LEFT JOIN pa_trabajadores t ON t.id = u.trabajador_actual_id` (líneas ~4435, ~4454), `LEFT JOIN pa_trabajadores t ON t.id = m.trabajador_id` (~4463, ~4667), `SELECT nombre FROM pa_trabajadores WHERE id=?` (~4617).

### 🟡 Grupos
`pa_trabajadores.grupo_id` + el tab Grupos cuenta trabajadores por grupo (`SELECT COUNT(*) FROM pa_trabajadores WHERE grupo_id = g.id AND activo=1`, ~2873). Con la decisión de llevar `grupo_id` a `pa_personal`, el conteo pasa a `pa_personal`.

### 🟡 Cuadrillas
El tab Cuadrillas cuenta `pa_trabajadores WHERE cuadrilla_habitual_id = c.id` (~2828). Equivalente directo: `pa_personal.cuadrilla_default_id` (cambiar el conteo).

### 🟢 El propio tab/CRUD "Trabajadores"
`/personal/trabajadores` (GET/POST/PATCH/DELETE/reactivar) + el tab del panel. Se retira una vez que Pañol ya no lo use.

### ✅ Asistencias V1 — ya migrado
`pa_asistencias` usa `personal_id`/`contratista_id` (→ `pa_personal`), **no** `pa_trabajadores`. El flujo principal ya está en el padrón nuevo: **cero trabajo**.

## 4) Plan para quedarnos con uno solo (`pa_personal`)

Quedarse con **`pa_personal`**. Pasos, de menor a mayor riesgo, pensados como **PRs separados** (Pañol es el grueso):

| # | PR | Qué hace |
|---|---|---|
| 1 | **`grupo_id` en `pa_personal`** | ALTER ADD COLUMN `grupo_id INTEGER REFERENCES pa_grupos(id)`. Backfill desde `pa_trabajadores.grupo_id` vía `personal_id`. Mostrar/editar grupo en el tab "Personal". Cambiar el conteo del tab Grupos a `pa_personal`. |
| 2 | **Pañol → `pa_personal`** (el grueso) | Agregar `personal_id` a `pa_panol_unidades` y `pa_panol_movimientos`. Backfill (`trabajador_id` → `pa_trabajadores.personal_id`). Cambiar las queries y el dropdown de Pañol a `pa_personal`. Dejar las FKs viejas muertas (limpiar al final). |
| 3 | **Cuadrillas + retirar tab Trabajadores** | Conteo de cuadrillas → `pa_personal.cuadrilla_default_id`. Sacar el tab "Trabajadores" + endpoints `/personal/trabajadores` (cuando nadie los use). |
| 4 | **Reconciliación + deprecación** | Backfill de trabajadores creados DESPUÉS de la migración one-time que nunca se copiaron a `pa_personal` (la migración corrió una sola vez). Confirmado el COUNT en prod, dejar `pa_trabajadores` LEGACY vacía o dropearla (mismo patrón que el legacy de partes/fichajes). |

**Verificación previa a tocar nada (igual que con el legacy):** armar un endpoint temporal de COUNT (admin, read-only) que muestre en prod:
- trabajadores activos **sin** `personal_id` (no migrados por la one-time).
- filas de Pañol (`pa_panol_unidades` con `trabajador_actual_id` no nulo, `pa_panol_movimientos` con `trabajador_id` no nulo) que referencian trabajadores → dimensiona el backfill de Pañol.
- (los contratistas mal mapeados ya se descartaron: son todos fijos.)

**Notas:**
- Todo es PC (ninguna de estas tablas tiene `sociedad_id`; ver `docs/modulo-personal-pc.md` §8).
- El "puente" de mapeo viejo↔nuevo es `pa_trabajadores.personal_id` — clave para todos los backfills.
- No tocar `pa_cuadrillas`, `pa_tareas_tipos`, `pa_grupos`, `pa_rubros_contables` como tablas (son compartidas o se conservan); lo que cambia es a quién apuntan los conteos/FKs.

---

*Fin del documento. Análisis de solo lectura — no se modificó código. La ejecución (PRs 1-4) se encara por separado.*
