// src/servicios/db_sg_contactos.js
// ── CONTACTOS COMERCIALES DE SAN GERÓNIMO ────────────────────────────────────────────
// Dos niveles, y la distinción es el módulo entero:
//
//   LA EMPRESA es la CUENTA COMERCIAL. Lo que produce y en qué meses, el vínculo con la
//   planilla de ventas, la zona, quién la atiende. Es con la empresa que se hacen los
//   negocios.
//
//   LA PERSONA es a quién se llama. Su cargo, sus teléfonos, y las charlas que se tuvieron
//   con ella. Varias personas cuelgan de la misma empresa.
//
// ── POR QUÉ LOS PRODUCTOS SON DE LA EMPRESA Y NO DE LA PERSONA ───────────────────────
// Pablo, 9/10/2026: «tenés que dejar relacionar a dos personas con la misma empresa, donde
// la empresa es la que tiene la venta de producción de cada producto».
//
// En la primera versión los productos colgaban de la persona, y eso estaba mal: cargando al
// dueño de Giglio y al encargado del galpón, el calendario de melón quedaba cargado DOS
// VECES. A la semana uno de los dos tenía la ventana corregida y el otro no, y ninguna
// pantalla podía decir cuál era la buena. Peor todavía: «quién tiene melón en noviembre»
// devolvía dos filas de la misma finca, como si fueran dos proveedores.
//
// La finca produce melón una sola vez. El que lo cuenta por teléfono puede ser cualquiera
// de los dos.
//
// ── TODA PERSONA TIENE UNA EMPRESA, Y SI TRABAJA SOLA LA EMPRESA ES ELLA ─────────────
// `empresa_id` no admite nulo. La alternativa era dejarlo opcional y que la persona sin
// empresa guardara su propia zona, su propio tipo y sus propios productos — o sea los mismos
// campos en dos lugares, y dos lugares de donde leerlos en cada pantalla. Un fletero que
// trabaja solo entra como una empresa de una persona: es lo que de verdad es, la cuenta
// comercial es él.
//
// ── POR QUÉ NO ES UN CAMPO MÁS EN proveedores/clientes ───────────────────────────────
// El padrón tiene las empresas con su CUIT y su condición de IVA, que es lo que hace falta
// para facturar. Esto tiene lo que hace falta para VENDER Y COMPRAR: a quién se llama, qué
// tiene, cuándo lo tiene y qué se habló. Y tiene personas, que en el padrón no entran: ahí
// no hay lugar para Juan, el hijo de Giglio, que atiende el teléfono del galpón.
//
// El vínculo entre los dos se guarda POR NOMBRE (`cliente_nombre`, `proveedor_nombre`, en la
// EMPRESA), que es como ya se vincula todo lo comercial en este sistema: sheet_ventas trae
// nombres, no ids. No es elegante y es lo que hay; lo importante es que esté dicho, porque un
// cambio de nombre en la planilla corta el vínculo sin avisar.
//
// ── LOS MESES VAN DE JULIO A JUNIO ───────────────────────────────────────────────────
// El año comercial de la casa arranca en julio, igual que en Informes y en Ventanas. La
// máscara `meses` tiene doce posiciones y la PRIMERA ES JULIO. Si alguien la lee como
// enero, un productor de melón pasa a ser de invierno. Está dicho acá, en el router y en
// la pantalla, a propósito.
//
// Se usa máscara y no desde/hasta porque hay productores con DOS ventanas en el año —
// una temprana y una tardía— y un rango las aplasta en una sola.
import db from "./db.js";

db.exec(`
-- ═══════════════════════════════════════════════════════════════════════════
  -- LA CUENTA COMERCIAL
  -- ═══════════════════════════════════════════════════════════════════════════
  -- Con quién se hacen los negocios. De acá cuelgan los productos y el vínculo con
  -- la planilla, porque es la empresa la que produce y la que compra — no la
  -- persona que atiende el teléfono.
  CREATE TABLE IF NOT EXISTS sg_contacto_empresas (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre           TEXT NOT NULL,
    -- 'cliente' | 'proveedor' | 'ambos' | 'otro'. 'otro' existe porque un
    -- transportista o un laboratorio tampoco es ninguna de las dos y hay que poder
    -- guardarlo igual: si no entra acá, termina en el teléfono de alguien.
    tipo             TEXT NOT NULL DEFAULT 'otro',
    zona             TEXT,
    localidad        TEXT,
    -- A qué empresa del padrón corresponde. Por NOMBRE, ver el encabezado.
    cliente_nombre   TEXT,
    proveedor_nombre TEXT,
    vendedor         TEXT,
    etiquetas        TEXT,
    notas            TEXT,
    activo           INTEGER NOT NULL DEFAULT 1,
    creado_por_id    INTEGER,
    creado_en        TEXT DEFAULT (datetime('now','localtime')),
    actualizado_en   TEXT DEFAULT (datetime('now','localtime')),
    eliminado_en     TEXT
  );
  CREATE INDEX IF NOT EXISTS sg_cto_emp_nombre_idx ON sg_contacto_empresas(nombre);
  CREATE INDEX IF NOT EXISTS sg_cto_emp_tipo_idx   ON sg_contacto_empresas(tipo);
  -- El mismo nombre dos veces son dos fichas de la misma finca con la mitad de las
  -- charlas cada una, que es justamente lo que este módulo viene a evitar.
  CREATE UNIQUE INDEX IF NOT EXISTS sg_cto_emp_unica
    ON sg_contacto_empresas(nombre) WHERE eliminado_en IS NULL;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- LA FICHA
  -- ═══════════════════════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS sg_contactos (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre           TEXT NOT NULL,
    -- De qué cuenta comercial es. Varias personas comparten empresa_id: el dueño y
    -- el encargado del galpón son dos personas de la misma finca.
    empresa_id       INTEGER,
    -- El nombre de la empresa, DENORMALIZADO. No es la fuente: la fuente es
    -- sg_contacto_empresas.nombre, y el router lo reescribe acá cada vez que cambia.
    -- Está para que el buscador pueda mirar una sola tabla y para que la bandeja de
    -- pendientes no necesite un join más. Mismo criterio que sg_productos, que
    -- guarda familia y variedad al lado del código.
    empresa          TEXT,
    cargo            TEXT,
    notas            TEXT,
    activo           INTEGER NOT NULL DEFAULT 1,
    creado_por_id    INTEGER,
    creado_en        TEXT DEFAULT (datetime('now','localtime')),
    actualizado_en   TEXT DEFAULT (datetime('now','localtime')),
    eliminado_en     TEXT
  );
  CREATE INDEX IF NOT EXISTS sg_contactos_nombre_idx   ON sg_contactos(nombre);
  CREATE INDEX IF NOT EXISTS sg_contactos_empresa_idx  ON sg_contactos(empresa);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- CÓMO SE LO UBICA
  -- ═══════════════════════════════════════════════════════════════════════════
  -- Varios por contacto a propósito: un productor tiene el celular, el del galpón
  -- y el del hijo, y el que sabe cuál atiende es el comercial, no el sistema. Por
  -- eso 'preferido' y 'nota' ("sólo de mañana", "no contesta los lunes").
  CREATE TABLE IF NOT EXISTS sg_contacto_medios (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contacto_id   INTEGER NOT NULL,
    tipo          TEXT NOT NULL DEFAULT 'telefono',  -- telefono|whatsapp|mail|otro
    valor         TEXT NOT NULL,
    nota          TEXT,
    preferido     INTEGER NOT NULL DEFAULT 0,
    creado_en     TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS sg_contacto_medios_cto_idx ON sg_contacto_medios(contacto_id);
  -- Para que el buscador encuentre por teléfono sin recorrer todo.
  CREATE INDEX IF NOT EXISTS sg_contacto_medios_val_idx ON sg_contacto_medios(valor);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- QUÉ PRODUCE, Y CUÁNDO
  -- ═══════════════════════════════════════════════════════════════════════════
  -- Esto es lo DECLARADO: lo que la empresa dice que tiene. Al lado, la pantalla
  -- muestra lo OBSERVADO —lo que efectivamente le compramos, que sale de las ventas—
  -- y son dos cosas distintas: puede ofrecer brócoli y no habérselo comprado nunca.
  -- Mezclarlas haría imposible ver justamente ese hueco, que es una oportunidad.
  CREATE TABLE IF NOT EXISTS sg_contacto_productos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    -- DE LA EMPRESA, no de la persona. Ver el encabezado: la finca produce melón una
    -- sola vez, y el que lo cuenta por teléfono puede ser cualquiera de los dos.
    empresa_id   INTEGER NOT NULL,
    producto     TEXT NOT NULL,
    variedad     TEXT,
    -- Doce posiciones, LA PRIMERA ES JULIO. '000011111000' = noviembre a marzo.
    meses        TEXT NOT NULL DEFAULT '000000000000',
    volumen      TEXT,
    notas        TEXT,
    creado_en    TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS sg_contacto_prod_prod_idx ON sg_contacto_productos(producto);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- QUÉ SE HABLÓ
  -- ═══════════════════════════════════════════════════════════════════════════
  -- La bitácora. 'proximo_paso' y 'proximo_el' no son decoración: son lo que
  -- convierte una nota en una gestión. Una charla sin próximo paso se lee el mes
  -- que viene y no se sabe si quedó algo pendiente o no.
  CREATE TABLE IF NOT EXISTS sg_contacto_charlas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contacto_id   INTEGER NOT NULL,
    fecha         TEXT NOT NULL,
    canal         TEXT NOT NULL DEFAULT 'telefono',  -- telefono|whatsapp|mail|visita|otro
    resumen       TEXT NOT NULL,
    proximo_paso  TEXT,
    proximo_el    TEXT,
    hecho_en      TEXT,
    usuario_id    INTEGER,
    usuario       TEXT,
    creado_en     TEXT DEFAULT (datetime('now','localtime')),
    eliminado_en  TEXT
  );
  CREATE INDEX IF NOT EXISTS sg_contacto_charlas_cto_idx  ON sg_contacto_charlas(contacto_id);
  CREATE INDEX IF NOT EXISTS sg_contacto_charlas_fec_idx  ON sg_contacto_charlas(fecha);
  -- La bandeja de "me toca": lo pendiente con fecha.
  CREATE INDEX IF NOT EXISTS sg_contacto_charlas_prox_idx ON sg_contacto_charlas(proximo_el);
`);

// Migraciones de columnas nuevas, mismo patrón que el resto del repo: una por línea y con
// try/catch, porque SQLite no tiene ADD COLUMN IF NOT EXISTS.
for (const sql of [
  "ALTER TABLE sg_contactos ADD COLUMN cargo TEXT",
  "ALTER TABLE sg_contactos ADD COLUMN notas TEXT",
  "ALTER TABLE sg_contactos ADD COLUMN empresa TEXT",
  "ALTER TABLE sg_contactos ADD COLUMN empresa_id INTEGER",
  "ALTER TABLE sg_contacto_productos ADD COLUMN empresa_id INTEGER",
  "ALTER TABLE sg_contacto_charlas ADD COLUMN hecho_en TEXT",
  // ── LA FOTO DE LA TARJETA ─────────────────────────────────────────────────────────
  // Una foto, sin lector ni nada: la tarjeta que te dieron en la mano, guardada donde se
  // la puede volver a mirar. Lo que se tipea igual son el teléfono y el mail, que son lo
  // que el buscador tiene que poder encontrar — una foto no se busca.
  //
  // Se guarda la RUTA, no el archivo: una foto adentro de la base la infla y rompe el
  // backup del volume. Mismo criterio que las fotos de la recepción.
  //
  // Y el archivo NO va a data/sg: esa carpeta la sirve express.static ANTES del portón de
  // sesión, o sea que queda en una URL alcanzable sin cookie. La foto de una tarjeta ES
  // el teléfono directo de un comprador de cadena, que es exactamente lo que este módulo
  // decidió no dejar al alcance de cualquiera. Va a data/contactos/, que no se sirve
  // estática, y se entrega por GET /:id/tarjeta, que pasa por requireAuth.
  "ALTER TABLE sg_contactos ADD COLUMN tarjeta_path TEXT",
  "ALTER TABLE sg_contactos ADD COLUMN tarjeta_nombre TEXT",
  "ALTER TABLE sg_contactos ADD COLUMN tarjeta_en TEXT",
  // Van DESPUÉS de los ALTER, a propósito: en una base que ya existía la columna
  // empresa_id no estaba hasta recién, y un CREATE INDEX sobre una columna que no
  // existe se lleva puesto el arranque del módulo.
  "CREATE INDEX IF NOT EXISTS sg_contactos_empid_idx ON sg_contactos(empresa_id)",
  "CREATE INDEX IF NOT EXISTS sg_contacto_prod_emp_idx ON sg_contacto_productos(empresa_id)",
]) { try { db.exec(sql); } catch (_) {} }

// ── DE «LA PERSONA TIENE PRODUCTOS» A «LA EMPRESA TIENE PRODUCTOS» ───────────────────
//
// La V1090 colgaba los productos, el tipo, la zona y el vínculo con la planilla de la
// PERSONA. Esta migración los sube a la empresa. Corre una sola vez: si no quedan
// contactos sin empresa_id, no hace nada.
//
// Se hace en una transacción porque a mitad de camino la base queda en un estado que
// ninguna pantalla sabe leer — personas con empresa_id y productos sin él.
function columnas(tabla) {
  try { return db.prepare("SELECT name FROM pragma_table_info(?)").all(tabla).map((r) => r.name); }
  catch (_) { return []; }
}

try {
  const colC = columnas('sg_contactos');
  const pendiente = colC.includes('empresa_id')
    ? db.prepare("SELECT COUNT(*) n FROM sg_contactos WHERE empresa_id IS NULL AND eliminado_en IS NULL").get().n
    : 0;

  if (pendiente > 0) {
    // Las columnas viejas pueden no estar (base creada ya con la forma nueva), así que
    // cada una se lee sólo si existe. Sin esto, la migración se cae con "no such column"
    // en una instalación nueva — y se cae ANTES de que nadie pueda usar el módulo.
    const hay = (c) => colC.includes(c);
    const col = (c) => (hay(c) ? c : "NULL AS " + c);
    const personas = db.prepare(
      "SELECT id, nombre, " + [col('empresa'), col('tipo'), col('zona'), col('localidad'),
        col('cliente_nombre'), col('proveedor_nombre'), col('vendedor'), col('etiquetas')].join(', ') +
      "  FROM sg_contactos WHERE empresa_id IS NULL AND eliminado_en IS NULL").all();

    const buscarEmp = db.prepare(
      "SELECT id FROM sg_contacto_empresas WHERE nombre = ? AND eliminado_en IS NULL");
    const crearEmp = db.prepare(`INSERT INTO sg_contacto_empresas
      (nombre, tipo, zona, localidad, cliente_nombre, proveedor_nombre, vendedor, etiquetas)
      VALUES (?,?,?,?,?,?,?,?)`);
    // Lo que la primera persona dejó en blanco lo puede completar la segunda: dos personas
    // de la misma finca y la zona cargada en una sola es el caso normal, no el raro.
    const completarEmp = db.prepare(`UPDATE sg_contacto_empresas SET
         tipo = CASE WHEN tipo = 'otro' AND ? IS NOT NULL THEN ? ELSE tipo END,
         zona = COALESCE(zona, ?), localidad = COALESCE(localidad, ?),
         cliente_nombre = COALESCE(cliente_nombre, ?), proveedor_nombre = COALESCE(proveedor_nombre, ?),
         vendedor = COALESCE(vendedor, ?), etiquetas = COALESCE(etiquetas, ?)
       WHERE id = ?`);
    const ponerEmp = db.prepare("UPDATE sg_contactos SET empresa_id = ?, empresa = ? WHERE id = ?");

    db.exec('BEGIN');
      try {
        for (const p of personas) {
          // Sin empresa escrita, la empresa ES la persona: un fletero que trabaja solo es una
          // cuenta comercial de una persona. Ver el encabezado — la alternativa era un
          // empresa_id nulo y los mismos campos duplicados en las dos tablas.
          const nombre = (p.empresa && String(p.empresa).trim()) || String(p.nombre).trim();
          let e = buscarEmp.get(nombre);
          if (!e) {
            crearEmp.run(nombre, p.tipo || 'otro', p.zona, p.localidad,
                         p.cliente_nombre, p.proveedor_nombre, p.vendedor, p.etiquetas);
            e = buscarEmp.get(nombre);
          } else {
            completarEmp.run(p.tipo || null, p.tipo || null, p.zona, p.localidad,
                             p.cliente_nombre, p.proveedor_nombre, p.vendedor, p.etiquetas, e.id);
          }
          ponerEmp.run(e.id, nombre, p.id);
        }

        // Los productos siguen a su persona. Si dos personas de la misma empresa tenían el
        // mismo producto —el caso que motivó todo esto—, las dos ventanas SE SUMAN con un OR
        // mes a mes: lo que uno de los dos dijo que hay en marzo, hay en marzo. Quedarse con
        // una sola sería tirar lo que la otra persona contó.
        if (columnas('sg_contacto_productos').includes('contacto_id')) {
          const prods = db.prepare(`SELECT p.id, p.producto, p.variedad, p.meses, p.volumen, p.notas,
                                           c.empresa_id
                                      FROM sg_contacto_productos p
                                      JOIN sg_contactos c ON c.id = p.contacto_id
                                     WHERE p.empresa_id IS NULL`).all();
          const vistos = new Map();                       // empresa_id|PRODUCTO → {id, meses}
          const yaHay = db.prepare(
            "SELECT id, meses FROM sg_contacto_productos WHERE empresa_id = ? AND producto = ?");
          const subir = db.prepare("UPDATE sg_contacto_productos SET empresa_id = ? WHERE id = ?");
          const fundir = db.prepare("UPDATE sg_contacto_productos SET meses = ? WHERE id = ?");
          const tirar  = db.prepare("DELETE FROM sg_contacto_productos WHERE id = ?");
          for (const p of prods) {
            if (!p.empresa_id) { tirar.run(p.id); continue; }   // su persona ya no está
            const clave = p.empresa_id + '|' + String(p.producto).toUpperCase();
            const previo = vistos.get(clave) || yaHay.get(p.empresa_id, p.producto);
            if (previo && previo.id !== p.id) {
              const a = String(previo.meses || '000000000000');
              const b = String(p.meses || '000000000000');
              let o = '';
              for (let i = 0; i < 12; i++) o += (a[i] === '1' || b[i] === '1') ? '1' : '0';
              fundir.run(o, previo.id);
              tirar.run(p.id);
              vistos.set(clave, { id: previo.id, meses: o });
            } else {
              subir.run(p.empresa_id, p.id);
              vistos.set(clave, { id: p.id, meses: p.meses });
            }
          }

        // Lo que el JOIN de arriba NO alcanza: un producto cuyo contacto_id apunta a una
        // persona que ya no existe. No entra al bucle, así que se quedaría con empresa_id
        // nulo para siempre — una fila inalcanzable violando un NOT NULL, y el chequeo de
        // "ya migré" no podría distinguirla de trabajo pendiente. Ya eran inalcanzables
        // antes: la ficha vieja también consultaba por contacto_id.
        const sueltos = db.prepare(
          "DELETE FROM sg_contacto_productos WHERE empresa_id IS NULL").run().changes;
        if (sueltos) {
          console.log("[SG] Contactos: " + sueltos + " producto(s) sin dueño descartados " +
                      "(su persona ya no estaba)");
        }
        }
      db.exec('COMMIT');
    } catch (e) {
      // A mitad de camino la base queda en un estado que ninguna pantalla sabe leer:
      // personas ya con empresa_id y productos todavía sin él. Mejor volver atrás entera y
      // dejar el error en el log que arrancar con los datos partidos.
      db.exec('ROLLBACK');
      throw e;
    }
    const n = db.prepare("SELECT COUNT(*) n FROM sg_contacto_empresas WHERE eliminado_en IS NULL").get().n;
    console.log("[SG] Contactos: " + personas.length + " persona(s) agrupadas en " + n +
                " empresa(s); los productos pasaron a colgar de la empresa");
  }
} catch (e) {
  console.error("[SG] Contactos — migración a empresas:", e.message);
}

// ── EL MISMO PRODUCTO DOS VECES: LO FRENA LA BASE ────────────────────────────────────
// Dos ventanas del mismo melón en la misma finca se contradicen y ninguna pantalla puede
// decir cuál vale. El router ya contesta 409, pero eso no cubre lo que entra por abajo:
// un script de importación, una corrección a mano. Mismo criterio que el nombre único de
// la empresa.
//
// VA ACÁ, AL FINAL, y no arriba con los demás índices, por dos razones a la vez: en una
// base que ya existe la columna empresa_id no está hasta que corre el ALTER, y aunque
// estuviera, la tabla todavía tiene los duplicados que la migración acaba de fundir. Un
// CREATE INDEX que se cae se lleva puesto el arranque del módulo entero.
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS sg_contacto_prod_unico"
        + " ON sg_contacto_productos(empresa_id, upper(producto))");
} catch (e) {
  // Si quedó algún duplicado que la migración no supo fundir, se dice y se sigue: el
  // módulo tiene que arrancar igual, y el router sigue frenando los nuevos.
  console.warn("[SG] Contactos: no se pudo crear el índice único de producto por empresa"
             + " (¿quedaron duplicados?): " + e.message);
}

console.log("[SG] Tablas de Contactos comerciales verificadas");

export default db;
