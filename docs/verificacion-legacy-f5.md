# Verificación de cobertura del stack legacy (previo a Fase 5)

> **Tipo:** verificación read-only (condición de la Decisión #5 antes de deprecar/borrar).
> No se borró ni modificó nada. **Fecha:** 2026-05-30.
> **Objetivo:** confirmar si `fin_*`/`ven_*` (stack moderno) cubre la función del stack
> financiero legacy de `db.js` ANTES de borrarlo, y si hay código vivo que lo use.

## Método
- Búsqueda de uso SQL real (`INSERT/UPDATE/DELETE/FROM/JOIN <tabla>`) de cada tabla legacy
  en todo `src/`.
- Distinción entre "definida" (solo `CREATE TABLE` en `db.js`) y "viva" (leída/escrita por
  algún router).
- Mapeo de cada tabla legacy a su equivalente en el stack moderno.

## Resultado por tabla

| Tabla legacy (`db.js`) | ¿Código vivo la usa? | Equivalente moderno | ¿Cubierto? | Veredicto F5 |
|---|---|---|---|---|
| `caja` | **No** (solo `CREATE`) | `fin_cuentas` (tipo caja) + `fin_movimientos` | Sí | **Borrar — segura** |
| `cheques_propios` | **No** (solo `CREATE`) | `fin_cheques_propios` | Sí | **Borrar — segura** |
| `cheques_terceros` | **No** (solo `CREATE`) | `fin_cheques_terceros` | Sí | **Borrar — segura** |
| `cta_cte_proveedores` | **No** (solo `CREATE`) | `pa_pagos_proveedores` + `pa_compras.saldo_pagado` (CC en `pagos.js`) | Sí | **Borrar — segura** |
| `cta_cte_clientes` | **No** (solo `CREATE`) | `ven_cobranzas` + `ven_cobranza_docs` (CC en `ventas.js /cc/:clienteId`) | Sí | **Borrar — segura** |
| `facturas_compra` | **No** (solo `CREATE` + FK entrante) | `pa_compras` | Sí | **Borrar — segura** (ver FK colgante) |
| `facturas_venta` | **No** (solo `CREATE` + FK entrante) | `ven_facturas` | Sí | **Borrar — segura** (ver FK colgante) |
| `liquidaciones_consignacion` | **No** (solo `CREATE`) | `ven_liquidaciones` (semántica distinta, pero nadie la escribe) | N/A (muerta) | **Borrar — segura** |
| `gastos` | **SÍ** — `abasto.js` (GET 778, INSERT 794) | **Sin equivalente** en `fin_*`/`ven_*` | **NO** | **NO borrar** (feature viva Abasto IFCO) |
| `caja_operador` | **SÍ** — `abasto.js` (GET 882, INSERT 898); lo llama `mandata.js` (`/caja`) | **Sin equivalente** en `fin_*` | **NO** | **NO borrar** (feature viva Abasto IFCO) |

## Hallazgo principal

El stack financiero legacy **NO es homogéneo**:

- **8 de 10 tablas están MUERTAS**: existen solo como `CREATE TABLE` en `db.js`, sin un
  solo `SELECT/INSERT/UPDATE` en ningún router. El stack moderno (`fin_*`, `ven_*`,
  `pa_pagos_*`, `pa_compras`) cubre su función. → **Borrado seguro e inmediato.**
- **2 tablas están VIVAS y NO cubiertas**: `gastos` y `caja_operador`. Pero **no son
  duplicados de `fin_*`** — son features operativas del módulo **Abasto IFCO (San Gerónimo)**:
  - `gastos`: gastos de abasto imputables a una partida o generales (`abasto.js`).
  - `caja_operador`: caja por operador del flujo IFCO mobile (`abasto.js` + `mandata.js`).
  - `fin_*` (caja/bancos contable) **no replica** estas funciones. Borrarlas **rompería**
    Abasto IFCO.

> **Conclusión:** la Decisión #5 ("deprecar legacy → todo a `fin_*`/`ven_*`") aplica
> **limpio solo a las 8 tablas muertas**. `gastos` y `caja_operador` **no entran**: o se
> mantienen como parte de Abasto IFCO, o su migración a `fin_*` es una **decisión de
> producto aparte** (zona SG/abasto, no un borrado mecánico). No están listas para deprecar.

## Detalle: FKs colgantes al borrar las muertas

Dos tablas muertas son referenciadas por columnas de tablas **vivas** (FK declarada, no
enforced porque `foreign_keys` está OFF en la app):

- `gastos.factura_compra_id → facturas_compra(id)` (db.js:572). `gastos` es viva.
- `mandatas.factura_venta_id → facturas_venta(id)` (db.js:874). `mandatas` (IFCO) es viva.

Al borrar `facturas_compra`/`facturas_venta`, esas columnas quedan apuntando a la nada.
Es **inofensivo** (FK no enforced, y son vínculos vestigiales del flujo viejo de facturación
que hoy nadie popula), pero conviene en F5 **limpiar también esas dos columnas** (o dejarlas
documentadas como muertas). Verificar antes que estén siempre NULL.

## Otras tablas legacy de `db.js` (fuera del stack financiero #5, para contexto)

- `proveedores` (legacy abasto), `partidas`, `movimientos_stock`, `remitos_salida`,
  `remitos_items`: **VIVAS** en `abasto.js` (stock/remitos IFCO). No son parte del stack
  financiero a deprecar; son la operatoria de Abasto IFCO. Su `sociedad_id` (todo SG) cae
  en la Fase 4/5 operativa, no acá.

## Veredicto

- **Cobertura confirmada** para las 8 tablas muertas → **F5 puede borrarlas con seguridad**
  (más limpieza de 2 columnas FK colgantes).
- **`gastos` y `caja_operador` NO están cubiertas** por `fin_*`/`ven_*` y están vivas en
  Abasto IFCO → **quedan fuera del borrado**; requieren decisión de producto (mantener vs.
  migrar) que excede la deprecación mecánica.
- **Recomendación:** F5 = borrar las 8 muertas + limpiar las 2 columnas colgantes, y
  **excluir explícitamente** `gastos`/`caja_operador` (tratarlas como Abasto IFCO, no como
  legacy financiero).

> Esto es diagnóstico. No se ejecuta ningún borrado sin OK explícito de Andy + Pablo.
