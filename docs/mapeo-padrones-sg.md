# Mapeo de padrones ABASTO → LNB (SG) — Issue #400

**Estado:** MAPEO VALIDADO contra DDL real de ABASTO + modelo de catálogo cerrado + PR aditivo de columnas. NO se migran datos en este paso — eso es **#401**.
**Origen:** sistema legacy ABASTO (MySQL, **`latin1`**).
**Destino:** LNB, SQLite, tablas `sg_*` en `src/servicios/db_sg.js`.
**Alcance:** 3 padrones — Taxonomía+Artículos, Proveedores, Clientes.

---

## 0. Modelo de catálogo (decisión CERRADA)

- **`sg_producto` único = especie + variedad + envase.** Esas 3 dimensiones lo definen.
- **TAMAÑO y CALIDAD NO van al producto** → van al **lote** (`sg_lotes.calibre` / `sg_lotes.calidad`), como atributo de cada partida al recibir. `art_tamano` (193) y `art_calidad` (163) **no se migran como catálogo**.
- **Colapso:** los **1.156 `articulos`** de ABASTO se agrupan por **(especie, variedad, envase)**. Las filas que solo diferían en tamaño/calidad colapsan a un mismo `sg_producto`.
- **Variedad nula:** algunas especies no tienen variedad (ej. Zapallo) → el producto es **especie+envase** y `variedad_id`/`variedad` quedan **NULL** (la columna lo permite; el código `FF.EE.00`).

### Estructura origen vs destino
| | ABASTO | LNB / SG |
|---|---|---|
| Taxonomía | 5 dimensiones ortogonales (especie×variedad×tamaño×calidad×envase) | 3 niveles jerárquicos (familia→especie→variedad) |
| Tamaño | `art_tamano` (193) | `sg_lotes.calibre` (texto libre, por lote) — **descartado del catálogo** |
| Calidad | `art_calidad` (163) | `sg_lotes.calidad` CHECK(`primera`/`segunda`/`tercera`) — **descartado del catálogo** |
| Envase | `art_envase` (143) | `sg_envases` + `sg_presentaciones` |
| Unidad comercial | `articulos` (1.156) | `sg_productos` (clave de colapso: especie+variedad+envase) |

---

## 1. Columnas aprobadas y agregadas (PR aditivo a `db_sg.js`)

Migraciones idempotentes (`PRAGMA table_info` → `ALTER ADD COLUMN`), aditivas, no tocan datos:

| Tabla | Columna nueva | Tipo | Mapea de ABASTO |
|---|---|---|---|
| `sg_productos` | `codigo_abasto` | TEXT | `articulos.CodArt` (trazabilidad legacy en transición) |
| `sg_productos` | `ean` | TEXT | `articulos.EAN` |
| `sg_proveedores` | `trabaja_consignacion` | INTEGER (0/1) | `proveedor.liquido` |
| `sg_proveedores` | `comision_pct` | REAL | `proveedor.PorcLiquido` |

**Decisiones de gaps aplicadas:**
- **TRAER** → las 4 columnas de arriba.
- **NO al master** → retenciones Ganancias/IIBB de proveedor (`RetGanancias`, `RetIngBrutos`, `PorcRetIBru`, …): se calculan al pagar/liquidar, no se guardan en `sg_proveedores`.
- **DESCARTAR (Fase B / facturación AFIP)** → percepciones por jurisdicción de clientes (`Salta_*`, `Misiones_*`, `*Tucu`, `CodJurisIIBB`, `Grupo_Tasa_Cba`); CBU/FCE de cliente (`FCE_CBU`, `FCE_ALIAS`).
- **DESCARTAR (G8 GLN)** → **no hay infra EDI/GLN activa en LNB** (verificado: cero referencias reales en el código). `cliente.GLN` no se migra.

---

## 2. Esquema destino (columnas + constraints reales, post-PR)

**`sg_familias`** — `id` PK · `codigo` INT **NOT NULL UNIQUE** · `nombre` **NOT NULL** · `iva_alicuota` REAL · `activo`. Seed fijo: `(1 Frutas)(2 Hortalizas Pesadas)(3 Hortalizas Livianas)(4 Hoja)(5 Otros)`.
**`sg_especies`** — `familia_id` **NOT NULL→sg_familias** · `codigo` INT **NOT NULL** · `nombre` **NOT NULL** · `UNIQUE(familia_id,codigo)`.
**`sg_variedades`** — `especie_id` **NOT NULL→sg_especies** · `codigo` INT **NOT NULL** · `nombre` **NOT NULL** · `UNIQUE(especie_id,codigo)`.
**`sg_productos`** — `codigo` TEXT **NOT NULL UNIQUE** (`FF.EE.VV`) · `familia_id`/`especie_id`/`variedad_id` (FK nullable) · `nombre` **NOT NULL** (denorm especie) · `variedad`/`familia` (denorm, nullable) · `unidad_base` **NOT NULL** DEF `kg` CHECK(`kg`/`unidad`/`atado`) · `vida_util_dias_default` DEF 7 · **`codigo_abasto` TEXT (nuevo)** · **`ean` TEXT (nuevo)** · `activo`.
**`sg_envases`** — `nombre` TEXT **NOT NULL UNIQUE** · `activo`.
**`sg_presentaciones`** — `producto_id` **NOT NULL→sg_productos** · `nombre` **NOT NULL** · `factor_conversion` REAL **NOT NULL** DEF 1 · `envase_id`→sg_envases · `paletizado` INT.
**`sg_condiciones_pago`** — `nombre` **NOT NULL** · `activo`.
**`sg_proveedores`** — `razon_social` **NOT NULL** · `nombre_comercial` · `origen` **NOT NULL** DEF `nacional` CHECK(`nacional`/`extranjero`) · `cuit` · `tipo` CHECK(`productor`/`importador`/`mayorista_regional`/`otros`) · `categoria_fiscal` CHECK(`resp_inscripto`/`monotributista`/`exento`/`no_inscripto`) · `tipo_fiscal_habitual` DEF `factura_a` CHECK(`factura_a`/`factura_b`/`liquidacion`/`invoice`) · `condicion_pago_habitual_id`→FK · `cbu` · `alias_cbu` · `localidad` · `provincia` · `telefono` · `email` · `observaciones` · `es_servicio` · **`trabaja_consignacion` INTEGER (nuevo)** · **`comision_pct` REAL (nuevo)** · `activo`.
**`sg_clientes`** — `razon_social` **NOT NULL** · `cuit` · `tipo` CHECK(`horeca`/`supermercado`/`mayorista_regional`/`minorista`/`consumidor_final`/`otros`) · `categoria_fiscal` CHECK(4) · `tipo_fiscal_habitual` DEF `factura_a` CHECK(3) · `condicion_pago_habitual_id`→FK · `modalidad_pedido` DEF `mixto` CHECK(`con_pedido`/`sobre_stock`/`mixto`) · `limite_credito` REAL **NOT NULL** DEF 0 · `localidad` · `provincia` · `direccion_entrega` · `telefono` · `email` · `observaciones` · `activo`.

> **Sin UNIQUE en `cuit`/`razon_social`** en clientes/proveedores → unicidad NO garantizada por DB. Ver §6 (dedup).

---

## 3. Mapeo A — Taxonomía + Artículos

### A.1 Familia (ABASTO `categoria` → `sg_familias`)
ABASTO no tiene "familia": el contenedor más cercano es `categoria` (`CodigoCat`, `NombreCat`, límites de crédito). LNB tiene 5 familias fijas seedeadas.

| ABASTO | Destino | Transformación | ¿Destino? |
|---|---|---|---|
| `categoria.NombreCat` | `sg_familias` (match contra seed) | **Mapeo manual N→5** (cada categoría ABASTO → 1 de las 5 familias; sin encaje → `Otros`/crear). `categoria` es más de crédito que de taxonomía: probablemente **no aporta familia** y la familia se asigna por especie a mano. | ✅ existe (seed) |

### A.2 Especie (`art_especie` 171 → `sg_especies`)
| ABASTO | Destino | Transformación | ¿Destino? |
|---|---|---|---|
| `art_especie.CodEspecie` | (tabla equivalencia `CodEspecie→sg_especies.id`) | Para resolver FKs de `articulos` | — |
| `art_especie.Especie` (varchar30) | `sg_especies.nombre` | Trim + **latin1→UTF-8** + Title Case | ✅ |
| — | `sg_especies.familia_id` (**NOT NULL**) | Asignar familia por especie (mapeo manual A.1). Sin dato fiable de origen → revisión humana. | ⚠️ se asigna en ETL |
| — | `sg_especies.codigo` (**NOT NULL**) | **Autogenerar** correlativo 2 díg dentro de familia | ✅ generar |

### A.3 Variedad (`art_variedad` 275 → `sg_variedades`)
| ABASTO | Destino | Transformación | ¿Destino? |
|---|---|---|---|
| `art_variedad.CodVariedad` | (tabla equivalencia) | — | — |
| `art_variedad.Variedad` (varchar20) | `sg_variedades.nombre` | Trim + transcodificar + Title Case | ✅ |
| — | `sg_variedades.especie_id` (**NOT NULL**) | **`art_variedad` NO referencia especie** (es dimensión ortogonal). **Derivar el par (especie,variedad) desde `articulos`** (`codespecie`+`codvariedad`). Una misma variedad usada con N especies → **duplicar** la variedad bajo cada especie. | ⚠️ derivar de `articulos` |
| — | `sg_variedades.codigo` (**NOT NULL**) | Autogenerar correlativo dentro de la especie | ✅ generar |

### A.4 Tamaño (`art_tamano` 193) y A.5 Calidad (`art_calidad` 163) — **descartados del catálogo**
| ABASTO | Destino | Transformación |
|---|---|---|
| `art_tamano.Tamano` | `sg_lotes.calibre` (por lote) | **NO migra al catálogo.** Reaparece al recibir partida. |
| `art_calidad.Calidad` | `sg_lotes.calidad` CHECK(3) | **NO migra al catálogo.** Se setea por lote (colapso 163→3 si se quisiera mapear, opcional). |

### A.6 Envase (`art_envase` 143 → `sg_envases` + `sg_presentaciones`)
| ABASTO | Destino | Transformación | ¿Destino? |
|---|---|---|---|
| `art_envase.CodEnvase` | (equivalencia) + `articulos.Envase` | El FK de artículo a envase es `articulos.Envase` (int) | — |
| `art_envase.Descripcion` (varchar50) | `sg_envases.nombre` (UNIQUE) | **Dedup/normalizar** (143 → catálogo corto), `INSERT OR IGNORE` | ✅ catálogo editable |
| `art_envase.KG` | `sg_presentaciones.factor_conversion` | kg por envase → factor (ej. cajón 20kg → 20). **Por producto.** | ✅ (en presentación) |
| `art_envase.Precio` | — | **Sin destino.** Precio es dato comercial, no de catálogo de envase. Descartar (no aprobado en PR). | ❌ descartar |
| `art_envase.Tolerancia` / `Gastos` / `CtaCte` / `Marca` | — | **Sin destino.** Descartar (no aprobados; Tolerancia/Gastos son de costeo legacy). | ❌ descartar |

### A.7 Artículo (`articulos` 1.156 → `sg_productos` + `sg_presentaciones`)
**Clave de colapso = (`codespecie`, `codvariedad`, `Envase`).** Filas que solo difieren en `codtamano`/`codcalidad` → mismo `sg_producto`.

| ABASTO | Destino | Transformación | ¿Destino? |
|---|---|---|---|
| `articulos.CodArt` (int, PK) | `sg_productos.codigo_abasto` | Guardar como TEXT para trazabilidad. **Ojo:** tras el colapso varios `CodArt` caen en un producto → guardar el "representante" (menor CodArt) o lista CSV; definir en ETL. | ✅ (col nueva) |
| `articulos.codespecie`+`codvariedad` | `sg_productos.especie_id`/`variedad_id` | Resolver vía equivalencias A.2/A.3. `codvariedad` NULL/0 → variedad NULL (caso Zapallo) | ✅ |
| (taxonomía resuelta) | `sg_productos.codigo` (`FF.EE.VV`) | **Autogenerar** desde familia.codigo+especie.codigo+variedad.codigo (`VV`=`00` si sin variedad) | ✅ generar |
| `art_especie.Especie` | `sg_productos.nombre` (NOT NULL) | denorm = nombre de especie | ✅ |
| `art_variedad.Variedad` | `sg_productos.variedad` | denorm (NULL si sin variedad) | ✅ |
| (familia resuelta) | `sg_productos.familia` | denorm | ✅ |
| `articulos.EAN` (varchar20) | `sg_productos.ean` | directo (normalizar dígitos). Tras colapso, varios EAN por producto → el EAN suele ser por envase: si difiere, conservar el del envase representativo o mover a presentación (decidir en ETL). | ✅ (col nueva) |
| `articulos.Articulo` (varchar50) | (`observaciones` o descartar) | Nombre libre legacy; redundante con denorm. Descartable. | ➖ opcional |
| `articulos.CodSuper` / `DescripSuper` | — | **Sin destino** (código/descr. del súper, EDI). Descartar (G8 sin infra EDI). | ❌ descartar |
| `articulos.Envase` | `sg_presentaciones` (producto_id, envase_id, factor_conversion=KG) | 1 presentación por (producto, envase) único | ✅ |
| `articulos.unidad` (no hay campo explícito) | `sg_productos.unidad_base` | Derivar: atados→`atado`, por unidad→`unidad`, resto `kg` (default) | ✅ |

---

## 4. Mapeo B — Proveedores (`proveedor` 955 → `sg_proveedores`)

| ABASTO | Destino | Transformación | ¿Destino? |
|---|---|---|---|
| `CodProv` (PK) | (`observaciones` o equivalencia ETL) | No hay `codigo_abasto` en proveedores (solo en productos). Guardar referencia para dedup/log; no se persiste columna. | ➖ |
| `Nombre` (varchar50) | `razon_social` (NOT NULL) | Trim + transcodificar | ✅ |
| `Cuit` (varchar13) | `cuit` | Normalizar `XX-XXXXXXXX-X` | ✅ |
| `CatIVA` | `categoria_fiscal` CHECK(4) | Mapear: RI→`resp_inscripto`, Mono→`monotributista`, Exento→`exento`, resto→`no_inscripto` | ✅ |
| `PersonaFisica` | (informa `categoria_fiscal`) | bool; ayuda a desambiguar mono/RI. No hay columna propia. | ➖ |
| `liquido` | **`trabaja_consignacion`** (col nueva) | bool 0/1 directo | ✅ (col nueva) |
| `PorcLiquido` | **`comision_pct`** (col nueva) | % directo (validar 0–100) | ✅ (col nueva) |
| (derivado de `liquido`) | `tipo_fiscal_habitual` | si consignación → `liquidacion`; si RI → `factura_a` | ✅ |
| `RetGanancias`,`RetIngBrutos`,`PorcRetIBru`,`PorcRetMis`,`*Tucu`,`Grupo_CBA_Ret` | — | **NO al master** (decisión #400). Se calculan al pagar. | ❌ descartar del master |
| `Acopiador` | `tipo` (CHECK) o descartar | Si marca tipo de proveedor → mapear a `productor`/`otros`; si no, descartar | ➖ |
| `Direccion`,`Localidad`,`Provincia`,`CodPostal` | `localidad`,`provincia`,(`observaciones`) | `direccion`/`CodPostal` no tienen columna propia en prov → a `observaciones` o descartar | ⚠️ parcial |
| `Telefono`/`mail` | `telefono`/`email` | directo | ✅ |
| (días/condición de pago) | `condicion_pago_habitual_id`→FK | Precargar `sg_condiciones_pago` y linkear, o NULL | ⚠️ requiere precarga |
| — | `origen` (NOT NULL) | DEF `nacional` (importadores → `extranjero`) | ✅ |
| (baja) | `activo`/`eliminado_en` | baja lógica | ✅ |

---

## 5. Mapeo C — Clientes (`cliente` 679 → `sg_clientes`)

| ABASTO | Destino | Transformación | ¿Destino? |
|---|---|---|---|
| `Codigo` (PK) | (equivalencia ETL) | Sin columna; referencia para dedup/log | ➖ |
| `Nombre` (varchar30) | `razon_social` (NOT NULL) | Trim + transcodificar | ✅ |
| `Alias` | (`observaciones`) | `sg_clientes` no tiene nombre_comercial → a `observaciones` o descartar | ➖ |
| `Cuit` (varchar13) | `cuit` | Normalizar formato | ✅ |
| `CatIVA` | `categoria_fiscal` CHECK(4) | Mapear (igual que prov) | ✅ |
| `Fisica` | (informa `categoria_fiscal`) | bool persona física | ➖ |
| `Categoria` (FK `categoria`) | `tipo` CHECK(6) | Mapear categoría ABASTO → tipo (`supermercado`/`horeca`/`mayorista_regional`/`minorista`/…) | ✅ |
| `Tope_Saldo` | `limite_credito` (NOT NULL DEF 0) | directo (0 si NULL) | ✅ |
| `Dias_Pago` | `condicion_pago_habitual_id`→FK | Precargar condiciones y linkear, o NULL | ⚠️ requiere precarga |
| `Direccion` | `direccion_entrega` | directo | ✅ |
| `Localidad`/`Provincia` | `localidad`/`provincia` | directo | ✅ |
| `CodPostal` | (`observaciones`) | sin columna propia | ➖ |
| `Telefono`/`mail` | `telefono`/`email` | directo | ✅ |
| `FCE_CBU`,`FCE_ALIAS` | — | **DESCARTAR** (Fase B / no se cobra por débito en V1) | ❌ descartar |
| `GLN` | — | **DESCARTAR** (G8: sin infra EDI en LNB) | ❌ descartar |
| `CodInt` | — | código interno legacy; sin destino → descartar | ❌ descartar |
| `Salta_*`,`Misiones_*`,`*Tucu`,`CodJurisIIBB`,`Grupo_Tasa_Cba` | — | **DESCARTAR** percepciones por jurisdicción (Fase B / facturación AFIP) | ❌ descartar |
| (baja) | `activo`/`eliminado_en` | baja lógica | ✅ |

---

## 6. Regla de deduplicación app-side (no hay UNIQUE en `cuit`/`razon_social`)

Antes de **insertar** cada cliente/proveedor, decidir **insertar / actualizar / saltar** con esta cascada (reutiliza `src/servicios/dedup.js`):

1. **Match exacto por CUIT** (clave fuerte): normalizar CUIT de origen y destino quitando guiones/espacios (`cuit.replace(/\D/g,'')`). Si el CUIT existe y es no vacío/no genérico (≠ `0`, ≠ consumidor final) y hay fila destino con el mismo CUIT normalizado → **es la misma entidad** → UPDATE de campos faltantes o SKIP (no duplicar). Es la regla principal: la mayoría trae CUIT.
2. **Sin CUIT o CUIT genérico** → **fuzzy por nombre** con `dedup.js`: `ratio(normalizar(razon_social_origen), normalizar(razon_social_destino))`. `normalizar()` ya hace minúsculas + sin acentos + colapsa espacios.
   - `ratio ≥ umbral` (el de `dedup.js`) → **candidato duplicado** → no insertar automático: **marcar para revisión** (reporte ETL), no bloquear el lote entero.
   - `ratio < umbral` → tratar como **nuevo** → INSERT.
3. **Capa semántica (IA Haiku)** de `dedup.js`: solo si el fuzzy quedó por debajo del umbral pero cerca (sinónimos/abreviaturas tipo "S.A."/"SA", "Coop."/"Cooperativa"). Opcional en el ETL por costo; útil en modo revisión.

**Taxonomía:** la dedup la dan los **UNIQUE** del esquema → usar `INSERT OR IGNORE`:
- `sg_familias.codigo`, `sg_especies(familia_id,codigo)`, `sg_variedades(especie_id,codigo)`, `sg_envases.nombre`, `sg_productos.codigo`.
- Para envases/especies, normalizar el nombre **antes** de insertar para que el UNIQUE agarre ("Cajón" vs "cajon").

**Salida obligatoria del ETL (#401):** correr en **dry-run** y emitir reporte de (a) inserts nuevos, (b) matches por CUIT, (c) candidatos fuzzy a revisar, (d) filas inválidas (sin `razon_social`/`Nombre`). Recién después, escribir.

---

## 7. Orden de migración (#401)

```
1. sg_familias        (seed; mapear categorías ABASTO → 5 + iva_alicuota)
      ↓ familia_id NOT NULL
2. sg_especies        (art_especie → genera codigo; asigna familia)
      ↓ especie_id NOT NULL
3. sg_variedades      (art_variedad → derivar par (especie,variedad) desde articulos; duplicar si ortogonal)
4. sg_envases         (art_envase.Descripcion → dedup/normalizar; en paralelo a 2-3)
      ↓ (2,3,4 listos)
5. sg_productos       (articulos → COLAPSAR por (especie,variedad,envase); codigo FF.EE.VV; codigo_abasto + ean)
      ↓ producto_id NOT NULL
6. sg_presentaciones  (producto × envase × factor_conversion=art_envase.KG)
──────────────────────────────────────────────
7. sg_condiciones_pago (precargar plazos distintos; prerequisito FK de 8 y 9)
8. sg_proveedores     (955; liquido→trabaja_consignacion, PorcLiquido→comision_pct)
9. sg_clientes        (679)
```
Bloque taxonomía/artículos (1-6) y bloque padrones (7-9) son **independientes**; dentro de cada uno el orden es estricto por FK NOT NULL.

---

## 8. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | **Encoding `latin1`→UTF-8** (ñ/acentos: "Limón", "Zapallo") | `SET NAMES latin1` al leer MySQL + transcodificar a UTF-8 en el ETL; validar muestra con acentos antes de cargar. |
| R2 | **Duplicados** contra datos ya cargados en `sg_*` | Regla §6 (CUIT exacto → fuzzy `dedup.js`); taxonomía con `INSERT OR IGNORE` sobre UNIQUE. Dry-run + reporte. |
| R3 | **Colapso 1.156→N por (especie,variedad,envase)** | Generar reporte "CodArt → sg_producto resultante" para revisión humana; resolver multiplicidad de `codigo_abasto`/`ean` por producto en el ETL. |
| R4 | **Variedad ortogonal** (`art_variedad` sin especie) | Derivar pares desde `articulos`; duplicar variedad bajo cada especie que la use. |
| R5 | **NOT NULL sin origen** (`especie.familia_id`, `variedad.especie_id`, `producto.codigo`, `razon_social`) | familia/especie por derivación+mapeo; `codigo` autogenerado; fila sin `Nombre`/`Articulo` → inválida, excluir y reportar. |
| R6 | **FK condición de pago sin precarga** | Precargar `sg_condiciones_pago` (paso 7) o migrar con FK NULL y completar luego. |
| R7 | **EAN/codigo_abasto multi-valor tras colapso** | EAN suele ser por envase → conservar el de la presentación; `codigo_abasto` = representante (menor CodArt) o CSV. Definir en #401. |

---

## 9. Pendiente para #401 (script de importación)
1. Acceso de lectura al MySQL ABASTO (o dump) con transcodificación `latin1`→UTF-8.
2. Tabla de **mapeo categoría→familia** y **especie→familia** (revisión humana).
3. Precarga de `sg_condiciones_pago` (plazos distintos de `Dias_Pago`).
4. ETL **dry-run** con reporte de dedup (§6) antes de escribir. **No** ejecutar hasta aprobar este PR de columnas.
