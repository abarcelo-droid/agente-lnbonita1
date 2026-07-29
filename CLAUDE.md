# Reglas para Claude Code trabajando en este repo

## Comportamiento general
- Trabajá de forma autónoma. NO pidas confirmaciones intermedias.
- Decidí vos los detalles cuando no estén especificados.
- Solo pausá si:
  - Necesitás info que NO está en el repo ni en el brief
  - Vas a hacer algo destructivo (rm, force-push, reset --hard, drop table)
  - Encontrás un blocker técnico real
- Avisame al final con un resumen de qué hiciste.

## Workflow de cambios
- Branch nueva siempre: `andy/feat-...` o `andy/fix-...`
- Commits con Conventional Commits: `feat(scope):`, `fix(scope):`, `refactor(scope):`
- Push + abrir PR siempre, NO mergees a main directo
- Pegame el link del PR al terminar
- Apenas crees un PR, abrí su URL en el navegador automáticamente (`Start-Process <url-del-PR>`), sin que lo pida

## Stack
- Node.js v24 + Express + better-sqlite3 + ES Modules
- SQLite en `data/clientes.db` (Railway volume persistente)
- Deploy automático en Railway al mergear a main
- Path Windows local: `C:\Users\Lenovo\Documents\Cloude\agente-lnbonita`

## Estructura
- `src/index.js` — entry point
- `src/panel.html` — frontend (un solo archivo grande, ~1.6MB)
- `src/rutas/` — routers Express por módulo (abasto, auth, ifco, org, etc)
- `src/servicios/` — DB, mail, OCR, helpers

## Convenciones
- Usuario admin tiene rol `'admin'`. Hay flag `solo_lectura` que NO aplica a admin.
- Auth por cookie `lnb_user` (JSON con id, nombre, rol, etc)
- Las acciones de cambio (POST/PUT/PATCH/DELETE) van con `requireAuth`
- Soft delete usa columna `eliminado_en` (TIMESTAMP)
- Pablo trabaja paralelo en módulos AB (abasto) y MD (módulos contables); coordinar antes de tocar esos archivos

## Limitaciones del entorno
- Si npm install falla en Windows, ya está resuelto: tenemos Node y npm OK
- No hay tests automáticos, validación es manual
## Módulos contables (Pablo) — contexto crítico

Estas notas son del área contable/administrativa (módulos MD). Respetarlas al pie: varias cosas ya se resolvieron y NO hay que "arreglarlas".

### Ramas de Pablo
- Cuando trabaja Pablo, la rama va con prefijo `pablo/feat-...` o `pablo/fix-...` (no `andy/...`).
- Path local de Pablo: `C:\Users\pablo\Documents\agente-lnbonita1`

### DOS bases de datos (¡importante no confundirlas!)
- `src/servicios/db.js` (getDb) → base OPERATIVA: stock/producción. Tabla `pa_insumos` (con cuenta_codigo, categoria_v2, etc). Es la que usan los endpoints de insumos.
- `src/servicios/db_pa.js` (dbPa) → base CONTABLE: `pa_cuentas`, `pa_cuentas_titulos`, `pa_cuentas_secciones`, `pa_asientos`, `adm_proveedores`, `adm_asientos_modelo(_lineas)`, `adm_config_impositiva`, `fin_cuentas`, `fin_movimientos`, `pa_insumo_modelo`.
- Son archivos SQLite SEPARADOS. No se pueden hacer JOINs entre una y otra; si se necesita cruzar datos, se lee de cada una y se combina en JS.

### Variable cirílica — NO tocar
- En `panel.html` existe la variable `PA._compraНето` donde "Нето" está en CIRÍLICO (no es "Neto" con N latina). Es preexistente y funciona. NO renombrar ni "corregir": romper esto rompe la carga de facturas.

### Plan de cuentas — jerarquía y formato
- Jerarquía: Grupo (pestañas: 1 Activo, 2 Pasivo, 3 Patrimonio, 4 Ingresos, 5 Egresos) → Sección (código `X.XX`) → Título (código `X.XX.XX`) → Cuenta (código `X.XX.XX.XXXX`).
- Solo las CUENTAS son imputables. Secciones y títulos son "NO IMPUTABLE": nunca se pueden seleccionar en un asiento.
- Una cuenta es "no imputable" si es padre de otra (su código es prefijo). El backend lo calcula en GET /api/pa/cuentas (flag `imputable`) y con `cuentaEsImputable()`.
- Los códigos NO pueden repetirse entre secciones, títulos y cuentas (validación cruzada `codigoEnUso`).
- Las cuentas nuevas DEBEN cumplir formato estricto `X.XX.XX.XXXX` y colgar de un título.
- Hay una migración en db_pa.js que renumera cuentas mal formateadas al arrancar (renumera bajo su título, el ID no cambia para no romper asientos).

### Asientos de factura (lógica contable vigente)
- El asiento de una factura se genera SOLO en el backend (`construirLineasAsientoCompra` en `src/rutas/produccion.js`) y es de SOLO LECTURA en el frontend. El front muestra un preview que debe espejar al backend.
- Factura de BIENES: el asiento sale del ASIENTO MODELO DE CADA INSUMO (no del proveedor). Cuenta de gasto de cada insumo (agrupando por cuenta), IVA Crédito Fiscal desde config global (una línea), Proveedores desde el modelo del insumo (una línea consolidada por el total). Bloquea si un insumo no tiene asiento modelo.
- Factura de SERVICIOS: el asiento sale del asiento modelo del PROVEEDOR. El concepto solo lleva descripción, monto e IVA (NO cuenta por concepto). Bloquea si el proveedor no tiene modelo.
- IVA Crédito Fiscal toma el MONTO de IVA (no el neto). Todo a 2 decimales (`round2` back, `paMoney2`/`paRound2` front).
- El vínculo insumo→asiento modelo vive en `pa_insumo_modelo` (en dbPa), porque el insumo está en db.js pero el modelo en db_pa.js.
- `adm_asientos_modelo_lineas` usa la columna `lado` (debe/haber), NO `tipo`. Y `tipo_linea` ('proveedores','iva','percepcion_iva','percepcion_iibb','percepcion_ganancias','retencion','libre').

### Caja y Bancos / Tesorería
- Las cajas de efectivo son cuentas de `fin_cuentas` con `tipo='caja'`, asociadas a una cuenta contable (`cuenta_contable_id`) y a un `ambito` ('fiscal' o 'interno'). El ámbito solo aplica a cajas; banco/cheque son siempre fiscales.
- La forma de pago "efectivo" usa las cuentas tipo caja.
- Hay una solapa "Caja" en Caja y Bancos que muestra saldo total de arqueo (fiscal + interno) y los movimientos, con el ámbito heredado de la caja.

### Selectores de cuentas en el front (panel.html)
- Asientos manuales: `admCuentasOpts()`. Asiento modelo: autocompletar `admModCuBuscar/Pick` sobre `ADM_MOD_CUENTAS`. Ambos deshabilitan las cuentas no imputables.
- Selector de insumos en factura: autocompletar `paInsBuscar` (agrupa por categoría). Al abrir la factura se recargan TODOS los insumos (no filtrar por categoría).

### Validación manual (no hay tests)
- panel.html es enorme (~33k líneas). Antes de dar por terminado, validar el JS de los <script> con `new Function(...)` y los .js con `node --check`.