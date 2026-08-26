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
- Push + abrir PR siempre. NO pushear a main directo, pero **el squash-merge del PR
  lo hacés vos** (Pablo, 25/8/2026: "abrí el link solo y hacé el squash y merge
  vos"). `gh pr merge <n> --squash --delete-branch`, y avisá qué quedó en main.
- **NO pushees nada a un PR después de darlo por listo.** Se mergea al toque y lo
  que llegue después queda afuera — ya pasó dos veces (#874 y #885). Si hace falta
  un cambio más, va en un PR nuevo.
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

### NADA DE BARRAS DE DESPLAZAMIENTO LATERAL
En ninguna pantalla ni modal del proyecto. Si una tabla no entra, se usa el
ancho disponible (`max-width:98vw`), se fijan anchos por columna con
`table-layout:fixed`, se deja partir sólo lo de largo variable (concepto,
descripción) y el resto se trunca con `text-overflow:ellipsis`.

El `.ab-table-wrap` trae su propio `overflow-x:auto` desde la clase, así que
hace falta `overflow-x:hidden !important` para ganarle. Se deja `auto` sólo bajo
`@media(max-width:900px)`, que es un teléfono. Hay dos ejemplos hechos en
`panel.html`: `#sg-ccficha-modal` y `#sg-pago-modal`.

Por qué: para leer un saldo o un total había que arrastrar la tabla, y el número
que importa suele ser el de la última columna.

### EL BOTÓN ANULAR SE MUESTRA POR NIVEL, NO A CUALQUIERA
`/api/auth/me` devuelve `user.niveles` (módulo → nivel). En el panel se mira con
`lnbPuedeAnular('<modulo>')`, que usa la MISMA regla que el servidor: `anular` y
`borrar` pesan igual (ver `ORDEN_NIVEL` en `servicios/permisos.js`). Admin
siempre puede.

Esto NO reemplaza el control: `exigirNivel` sigue decidiendo. Es para no ofrecer
un botón que va a contestar 403 — el que lo aprieta cree que rompió algo.

Y la anulación necesita su PROPIA dirección (`POST .../:id/anular`), porque
`exigirNivel` la reconoce por la URL. Un `PATCH .../:id/estado` que aceptara
`estado='anulado'` es una puerta lateral: quien sólo puede operar, anula.

### TODA OPERACIÓN QUE ASIENTA MUESTRA EL ASIENTO — AL QUE PUEDE LEERLO

**Acotado el 25/8/2026.** Pablo: *"los asientos deben ser visibles sólo para
administradores; dejalo como una flechita para abajo para que los administradores lo
podamos desplegar"*. El cuadro se sigue armando SIEMPRE y sigue siendo el momento en
que se puede frenar — pero se le muestra a quien puede hacer algo con él. El que
factura no tiene por qué ver un debe y haber que le ocupa media pantalla.

Se envuelve DENTRO de los tres armadores (`sgAsientoTabla`, `sgFmAsientoTabla`,
`sgAsientoCuadro`) con `sgAsientoPlegado()`, no en cada pantalla: una sola puerta, y
una pantalla nueva no puede olvidarse de cerrarla. Los bloques de "contra qué se
contabiliza" (el selector de asiento modelo) se esconden enteros — elegir el modelo
es PARAMETRIZAR, y eso ya era de admin.

Lo que sigue valiendo entero, abajo:

Si toca rubros contables y genera asiento —un pago, una cobranza, el depósito de
un cheque, un ajuste—, la pantalla muestra el CUADRO del asiento (cuenta,
descripción, debe, haber) y abajo la fila de totales con el cartel **balancea**,
igual que la factura de compra. En rojo y con la diferencia si descuadra.

Por qué: el asiento se arma en el backend y el usuario lo veía recién después,
entrando a Asientos Contables. Si estaba mal, ya estaba hecho. El cuadro es el
único momento en que se puede frenar.

El preview del front ESPEJA lo que arma el backend; el backend sigue siendo el
único que decide. Si una operación toca rubros contables y todavía no genera
asiento, eso es un pendiente — no una excepción.

### OPERAR NO ES SER ADMIN
`requireAdmin` sirve para PARAMETRIZAR (dar de alta una cuenta bancaria, una
caja, decidir quién la toca, tocar el asiento modelo). El trabajo del día
—registrar un pago, cargar un movimiento de caja— va con `requireAuth`, y el
nivel lo decide `exigirNivel` mirando la URL contra `ensure_api_prefijos.js`.

Poner `requireAdmin` en una acción operativa parece prudente y no lo es: obliga
a que todo lo cargue el dueño, y el que hace el trabajo termina dictándoselo.

Y una cuenta de `sg_fin_cuentas` puede tener dueño (`sg_fin_cuenta_usuarios`).
UNA sola regla, en todos lados: **si tiene gente asignada la tocan sólo ellos;
si no tiene a nadie, la toca cualquiera que tenga permiso en el módulo.** Está
en `puedeMoverCuenta()` (`rutas/sg_tesoreria.js`) y la usan tanto la tesorería
como el circuito de pagos. Los GET devuelven `puedo` (1/0) para que la pantalla
no ofrezca lo que va a rebotar.

- Usuario admin tiene rol `'admin'`. Hay flag `solo_lectura` que NO aplica a admin.
- Auth por cookie `lnb_user` (JSON con id, nombre, rol, etc)
- Las acciones de cambio (POST/PUT/PATCH/DELETE) van con `requireAuth`
- Soft delete usa columna `eliminado_en` (TIMESTAMP)
- Pablo trabaja paralelo en módulos AB (abasto) y MD (módulos contables); coordinar antes de tocar esos archivos

## Limitaciones del entorno
- Si npm install falla en Windows, ya está resuelto: tenemos Node y npm OK
- **SÍ HAY TESTS Y HAY QUE CORRERLOS**: `npm test` (runner nativo de Node, sin
  framework). Esta línea decía "no hay tests automáticos" y era falsa: hay ocho
  archivos en `test/`, incluido `plata_sg.test.mjs`, que clava los cinco bugs de
  plata del 25/8/2026 (alícuota del producto, gestión sin IVA sacado, cajones vs
  kilos, redondeo, carteles al centavo).
- `test/share_import.test.mjs` queda SIEMPRE en rojo porque importa `xlsx` y no hay
  `node_modules`. Es ruido conocido: mirar que los demás pasen. Un suite en rojo
  permanente deja de ser señal a los dos días.
- No hay `node_modules`: no se puede levantar el server ni usar better-sqlite3. Los
  tests usan `node:sqlite` (viene con Node 24) y copian `src/servicios` a un temporal
  reemplazando sólo los módulos que abren la base. Ver `test/plata_sg.test.mjs`.
## Módulos contables (Pablo) — contexto crítico

Estas notas son del área contable/administrativa (módulos MD). Respetarlas al pie: varias cosas ya se resolvieron y NO hay que "arreglarlas".

### Ramas de Pablo
- Cuando trabaja Pablo, la rama va con prefijo `pablo/feat-...` o `pablo/fix-...` (no `andy/...`).
- Path local de Pablo: `C:\Users\pablo\Documents\agente-lnbonita1`

### UNA sola base de datos (esto decía lo contrario y era falso)
- Hay **un solo archivo SQLite**: `data/clientes.db`. Verificado: las 6 llamadas a
  `new Database(...)` del repo (db.js, db2.js, catalogo.js, catalogo_v2.js,
  conversaciones.js, rutas/oferta.js) abren todas el mismo path, y `db_pa.js` hace
  `import db from './db.js'` y lo re-exporta: `dbPa === getDb()`, es el mismo handle.
- Los dos nombres siguen siendo útiles como criterio de ORGANIZACIÓN, no de archivo:
  - `src/servicios/db.js` → tablas operativas: stock/producción, `pa_insumos`.
  - `src/servicios/db_pa.js` → tablas contables: `pa_cuentas`, `pa_cuentas_titulos`,
    `pa_cuentas_secciones`, `pa_asientos`, `adm_proveedores`,
    `adm_asientos_modelo(_lineas)`, `adm_config_impositiva`, `fin_cuentas`,
    `fin_movimientos`, `pa_insumo_modelo`.
- **Sí se pueden hacer JOINs entre unas y otras.** Antes esto decía que no y que había
  que leer de cada una y combinar en JS: eso es trabajo de más y código más frágil.
- Lo que sí sigue valiendo: **no poner foreign keys hacia tablas de otro módulo**. Con
  `foreign_keys=ON` (db.js:22), una FK desde una tabla nueva hacia, por ejemplo,
  `sg_oc`, hace fallar los DELETE de ese módulo. JOINs de lectura sí, FKs no.
- Ojo también: `eliminado_en` está declarado `TEXT` en las 39 tablas que lo usan, no
  `TIMESTAMP`.
- No abrir un handle nuevo sobre otro archivo `.db`: el graceful shutdown de
  `index.js` hace el checkpoint del WAL sobre el handle de `db.js` únicamente, y el
  backup del volume de Railway cubre ese archivo.

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

### Validación antes de entregar
- **`npm test` SIEMPRE.** Esta sección decía "no hay tests" y contradecía a la de
  Limitaciones del entorno, setenta líneas más arriba, que dice lo contrario y es la
  que tiene razón. Mientras las dos frases convivieron, cada sesión eligió la que le
  quedaba más cómoda.
- panel.html es enorme (**62.000 líneas**, 3,6 MB — no las 33k que decía acá).
  Validar el JS de los 7 bloques `<script>` con `new Function(...)` y los .js con
  `node --check`.
- Y lo que ninguna de las dos ve: una función USADA y nunca DEFINIDA. El chequeo de
  sintaxis pasa igual y el error aparece recién cuando alguien abre esa pantalla.

## PARA ANDRÉS (y para quien mire el deploy) — HAY TRES RAILWAY, NO UNO

Este repositorio lo escuchan **tres proyectos de Railway distintos**, cada uno con
su entorno `production`:

| Proyecto | Project ID |
|---|---|
| `fabulous-heart`      | `c68f77b2-1e79-4dfe-9540-bdce3cf838eb` |
| `creative-creativity` | `da04d4f1-170f-4ff9-ba47-9ab78456c6c0` |
| `joyful-enjoyment`    | `cf18e353-e9f5-43e5-b91f-5009f0bc47af` |

**Cada merge a main dispara TRES builds**, y Railway los hace de a uno. Con
cuatro PR seguidos eso son doce builds en cola, y el panel sigue mostrando el
`VERSION` viejo un buen rato después de mergear. Ya pasó: el 19/8 el panel decía
V731 cuando main estaba en V746, y no había nada roto — venía atrás.

**Antes de salir a buscar un deploy fallado, mirá si simplemente está encolado.**

**Pregunta abierta para Andrés:** ¿los tres son a propósito? Si alguno es de
prueba o quedó de antes, apagarle el auto-deploy hace que todo salga tres veces
más rápido (y deja de pagarse tres veces el mismo build). Pablo no sabe de dónde
salieron los tres.

### Cómo mirar el deploy sin entrar a Railway

Railway publica el estado de cada deploy en GitHub, así que se ve con `gh`:

```bash
# Qué commit está desplegado en cada proyecto, y cómo le fue
gh api "repos/{owner}/{repo}/deployments?per_page=12"   --jq '.[] | "\(.created_at)  \(.environment)  \(.ref[0:8])"'

# El detalle de uno (success / failure / in_progress) + link al log
gh api "repos/{owner}/{repo}/deployments/<id>/statuses"   --jq '.[] | "\(.created_at)  \(.state)  \(.log_url)"'
```

Y qué versión está sirviendo el server AHORA, que es la prueba final:

```bash
curl -s https://agente-lnbonita1-production.up.railway.app/static/sidebar-v2.js   | grep "const VERSION"
```

`/static` manda `Cache-Control: no-cache`, así que lo que devuelve ese curl es lo
que ve el navegador: si ahí dice V746, el problema no es la caché de nadie.

### DOS NÚMEROS DE LA MISMA OPERACIÓN: FISCAL Y GESTIÓN

El comprador cierra el tomate en 20.000 y la factura llega por 10.000. A AFIP se
le informa la factura de 10.000; al proveedor se le deben 20.000. Los dos son
ciertos.

**El ámbito viaja en la LÍNEA, nunca en el recipiente.** Un solo asiento —un solo
número, el que se cita cuando hay que discutir algo— lleva las líneas fiscales y
las de gestión. Lo mismo del lado de la plata: el `ambito` lo lleva el
`sg_fin_movimientos`, y el de la caja es apenas el valor que se propone. Una
misma caja puede tener los dos sin partirla en dos cajas.

**Cada ámbito balancea POR SU CUENTA dentro del asiento.** Que el total cierre no
alcanza: lo fiscal puede estar descuadrado y lo de gestión compensarlo al revés,
y entonces el asiento dice "balancea" con el libro fiscal mal. Se valida antes de
escribir.

**Un solo lugar escribe asientos: `servicios/asientos.js`.** Había nueve INSERT
en cuatro archivos. El test `t-un-solo-escritor` falla si aparece otro, o si
alguien consulta las líneas del libro sin decir qué ámbito quiere. Cuando la
consulta necesita los dos, se declara con el marcador `ambito: todos` y su razón.

**Una línea de gestión sin motivo no entra.** Cuatro motivos, no texto libre
(`MOTIVOS` en `servicios/asientos.js`). Texto libre son cuarenta maneras de
escribir lo mismo y ningún informe posible.

**El `total` de un comprobante NO se toca**: es lo que dice el papel y es lo que
va al libro fiscal. La diferencia vive en `dif_gestion` + `dif_motivo`, tanto en
`sg_facturas_compra` como en `sg_ven_facturas` y `sg_ven_liquidaciones`.

**Sin IVA del lado de gestión.** El crédito y el débito fiscal salen del
comprobante y de nada más.

**La DEUDA es lo acordado; el LIBRO FISCAL es lo facturado.** La cuenta corriente
de proveedores y de clientes, lo pendiente de cada comprobante y los controles
que frenan imputar de más miran `total + dif_gestion`.

**Y EL MARGEN SE MIDE CONTRA GESTIÓN** (decisión de Pablo, 19/8/2026). La partida
del ejemplo costó 20.000, no 10.000: `costo_base` sale de los kilos por el precio
ACORDADO en la orden. El balance y el margen van a dar distinto siempre, y eso
es correcto — no lo "corrijas" para que cierren.
