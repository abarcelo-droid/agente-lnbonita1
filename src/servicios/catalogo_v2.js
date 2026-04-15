// Catalogo v2 — Oferta 1 y Oferta 2 con precios por tipo de cliente
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "../../data/clientes.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

// Tipos de cliente del sistema
export const TIPOS_CLIENTE = [
  'mayorista_a',
  'mayorista_mcba',
  'minorista_mcba',
  'minorista_entrega',
  'food_service',
  'consumidor_final',
];

export const LABEL_TIPO = {
  mayorista_a:       'Mayorista A',
  mayorista_mcba:    'Mayorista MCBA',
  minorista_mcba:    'Minorista MCBA',
  minorista_entrega: 'Minorista Entrega',
  dedicados:         'Dedicados',
  food_service:      'Food Service',
  consumidor_final:  'Consumidor Final',
};

export const OFERTA_POR_TIPO = {
  mayorista_a:       'oferta1',
  mayorista_mcba:    'oferta1',
  minorista_mcba:    'oferta1',
  minorista_entrega: 'oferta1',
  food_service:      'oferta2',
  consumidor_final:  'oferta2',
};

// Tabla principal de productos del catalogo
db.exec(`
  CREATE TABLE IF NOT EXISTS oferta_productos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    oferta      TEXT NOT NULL CHECK(oferta IN ('oferta1','oferta2')),
    codigo      TEXT NOT NULL,
    nombre      TEXT NOT NULL,
    categoria   TEXT,
    descripcion TEXT,
    unidad      TEXT,
    origen      TEXT,
    kilaje      TEXT,
    marca       TEXT,
    foto_path   TEXT,
    proveedor   TEXT,
    costo       REAL DEFAULT 0,
    flete       REAL DEFAULT 0,
    consignacion INTEGER DEFAULT 0,
    retail       INTEGER DEFAULT 0,
    disponible_general INTEGER DEFAULT 1,
    nombre_retail TEXT,
    notas       TEXT,
    activo      INTEGER DEFAULT 1,
    actualizado TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(oferta, codigo)
  );

  -- Precios y disponibilidad por tipo de cliente
  CREATE TABLE IF NOT EXISTS oferta_precios (
    producto_id  INTEGER NOT NULL,
    tipo_cliente TEXT NOT NULL,
    precio       REAL DEFAULT 0,
    disponible   INTEGER DEFAULT 1,
    PRIMARY KEY (producto_id, tipo_cliente)
  );
`);

// Tabla de nombres retail
db.exec(`
  CREATE TABLE IF NOT EXISTS retail_productos (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre    TEXT NOT NULL UNIQUE,
    categoria TEXT,
    activo    INTEGER DEFAULT 1,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Matriz de gastos generales
  CREATE TABLE IF NOT EXISTS retail_gastos (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre    TEXT NOT NULL,
    proveedor TEXT,
    monto     REAL DEFAULT 0,
    kg_bulto  REAL DEFAULT 1,
    activo    INTEGER DEFAULT 1
  );

  -- Precios por canal de venta
  CREATE TABLE IF NOT EXISTS retail_precios_canal (
    retail_producto_id INTEGER NOT NULL,
    canal              TEXT NOT NULL,
    precio             REAL DEFAULT 0,
    perdida_kg         REAL DEFAULT 0,
    PRIMARY KEY (retail_producto_id, canal)
  );

  -- EAN por supermercado para cada producto retail
  CREATE TABLE IF NOT EXISTS retail_ean (
    retail_producto_id INTEGER NOT NULL,
    supermercado       TEXT NOT NULL,
    ean                TEXT,
    PRIMARY KEY (retail_producto_id, supermercado)
  );

  -- Seleccion de proveedor y gastos por producto retail
  CREATE TABLE IF NOT EXISTS retail_seleccion (
    retail_producto_id INTEGER NOT NULL,
    oferta_producto_id INTEGER NOT NULL,
    gastos_ids         TEXT DEFAULT '[]',
    observaciones      TEXT,
    PRIMARY KEY (retail_producto_id)
  );
`);

// Migracion kg_bulto en retail_gastos
(function() {
  var cols = db.prepare("PRAGMA table_info(retail_gastos)").all().map(function(c){ return c.name; });
  if (cols.indexOf('kg_bulto') < 0) {
    try { db.exec("ALTER TABLE retail_gastos ADD COLUMN kg_bulto REAL DEFAULT 1"); } catch(e) {}
  }
})();

// Migracion observaciones en retail_seleccion
(function() {
  try {
    var cols = db.prepare("PRAGMA table_info(retail_seleccion)").all().map(function(c){ return c.name; });
    if (cols.indexOf('observaciones') < 0) {
      db.exec("ALTER TABLE retail_seleccion ADD COLUMN observaciones TEXT");
    }
  } catch(e) {}
})();

// Migracion observaciones en retail_seleccion
(function() {
  try {
    var cols = db.prepare("PRAGMA table_info(retail_seleccion)").all().map(function(c){ return c.name; });
    if (cols.indexOf('observaciones') < 0) {
      db.exec("ALTER TABLE retail_seleccion ADD COLUMN observaciones TEXT");
    }
  } catch(e) {}
})();

// Migracion perdida_kg en retail_precios_canal
(function() {
  try {
    var cols = db.prepare("PRAGMA table_info(retail_precios_canal)").all().map(function(c){ return c.name; });
    if (cols.indexOf('perdida_kg') < 0) {
      db.exec("ALTER TABLE retail_precios_canal ADD COLUMN perdida_kg REAL DEFAULT 0");
    }
  } catch(e) {}
})();

// Migracion proveedor en retail_gastos
(function() {
  var cols = db.prepare("PRAGMA table_info(retail_gastos)").all().map(function(c){ return c.name; });
  if (cols.indexOf('proveedor') < 0) {
    try { db.exec("ALTER TABLE retail_gastos ADD COLUMN proveedor TEXT"); } catch(e) {}
  }
})();

// Migracion categoria en retail_productos
(function() {
  var cols = db.prepare("PRAGMA table_info(retail_productos)").all().map(function(c){ return c.name; });
  if (cols.indexOf('categoria') < 0) {
    try { db.exec("ALTER TABLE retail_productos ADD COLUMN categoria TEXT"); } catch(e) {}
  }
  if (cols.indexOf('bxp_salida') < 0) {
    try { db.exec("ALTER TABLE retail_productos ADD COLUMN bxp_salida INTEGER"); console.log("[DB] bxp_salida agregado en retail_productos"); } catch(e) {}
  }
})();

export function listarRetailProductos() {
  return db.prepare("SELECT * FROM retail_productos WHERE activo = 1 ORDER BY categoria, nombre").all();
}
export function crearRetailProducto(nombre, categoria) {
  return db.prepare("INSERT OR IGNORE INTO retail_productos (nombre, categoria) VALUES (?,?)").run(nombre, categoria||null);
}
export function eliminarRetailProducto(id) {
  db.prepare("UPDATE retail_productos SET activo = 0 WHERE id = ?").run(id);
}

export function obtenerEANs(retailProductoId) {
  const rows = db.prepare("SELECT supermercado, ean FROM retail_ean WHERE retail_producto_id = ?").all(retailProductoId);
  const map = {};
  rows.forEach(function(r){ map[r.supermercado] = r.ean; });
  return map;
}
export function guardarEAN(retailProductoId, supermercado, ean) {
  db.prepare("INSERT INTO retail_ean (retail_producto_id, supermercado, ean) VALUES (?,?,?) ON CONFLICT(retail_producto_id,supermercado) DO UPDATE SET ean=excluded.ean").run(parseInt(retailProductoId), supermercado, ean||null);
}
export function actualizarRetailProducto(id, nombre, categoria, bxp_salida) {
  db.prepare("UPDATE retail_productos SET nombre=?, categoria=?, bxp_salida=? WHERE id=?").run(nombre, categoria||null, bxp_salida||null, id);
}

// Gastos generales
export function listarGastos() {
  return db.prepare("SELECT * FROM retail_gastos WHERE activo = 1 ORDER BY nombre").all();
}
export function crearGasto(nombre, proveedor, monto, kg_bulto) {
  return db.prepare("INSERT INTO retail_gastos (nombre, proveedor, monto, kg_bulto) VALUES (?,?,?,?)").run(nombre, proveedor||null, parseFloat(monto)||0, parseFloat(kg_bulto)||1);
}
export function actualizarGasto(id, nombre, proveedor, monto, kg_bulto) {
  db.prepare("UPDATE retail_gastos SET nombre=?, proveedor=?, monto=?, kg_bulto=? WHERE id=?").run(nombre, proveedor||null, parseFloat(monto)||0, parseFloat(kg_bulto)||1, id);
}
export function eliminarGasto(id) {
  db.prepare("UPDATE retail_gastos SET activo = 0 WHERE id = ?").run(id);
}

// Seleccion proveedor y gastos por producto retail
export function obtenerSeleccion(retailProductoId) {
  return db.prepare("SELECT * FROM retail_seleccion WHERE retail_producto_id = ?").get(retailProductoId);
}
export function guardarSeleccion(retailProductoId, ofertaProductoId, gastosIds, observaciones) {
  db.prepare(`
    INSERT INTO retail_seleccion (retail_producto_id, oferta_producto_id, gastos_ids, observaciones)
    VALUES (?,?,?,?)
    ON CONFLICT(retail_producto_id) DO UPDATE SET
      oferta_producto_id=excluded.oferta_producto_id,
      gastos_ids=excluded.gastos_ids,
      observaciones=COALESCE(excluded.observaciones, observaciones)
  `).run(parseInt(retailProductoId), parseInt(ofertaProductoId), JSON.stringify(gastosIds||[]), observaciones||null);
}

export function guardarObservacionRetail(retailProductoId, observaciones) {
  const existe = db.prepare("SELECT retail_producto_id FROM retail_seleccion WHERE retail_producto_id = ?").get(retailProductoId);
  if (existe) {
    db.prepare("UPDATE retail_seleccion SET observaciones = ? WHERE retail_producto_id = ?").run(observaciones||null, parseInt(retailProductoId));
  } else {
    db.prepare("INSERT INTO retail_seleccion (retail_producto_id, oferta_producto_id, gastos_ids, observaciones) VALUES (?,0,'[]',?)").run(parseInt(retailProductoId), observaciones||null);
  }
}

export function guardarPreciosCanal(retailProductoId, precios) {
  const stmt = db.prepare("INSERT INTO retail_precios_canal (retail_producto_id, canal, precio, perdida_kg) VALUES (?,?,?,?) ON CONFLICT(retail_producto_id,canal) DO UPDATE SET precio=excluded.precio, perdida_kg=excluded.perdida_kg");
  Object.keys(precios).forEach(function(canal) {
    const val = precios[canal];
    const precio   = typeof val === 'object' ? (parseFloat(val.precio)||0)  : (parseFloat(val)||0);
    const perdida  = typeof val === 'object' ? (parseFloat(val.perdida)||0) : 0;
    stmt.run(parseInt(retailProductoId), canal, precio, perdida);
  });
}

export function obtenerPreciosCanal(retailProductoId) {
  const rows = db.prepare("SELECT canal, precio, perdida_kg FROM retail_precios_canal WHERE retail_producto_id = ?").all(retailProductoId);
  const map = {};
  rows.forEach(function(r){ map[r.canal] = { precio: r.precio, perdida: r.perdida_kg || 0 }; });
  return map;
}

// Vista retail completa: productos con proveedores disponibles y precio por kilo
export function vistaRetail() {
  const retailProds = listarRetailProductos();
  const gastos      = listarGastos();
  const ofertaProds = db.prepare("SELECT * FROM oferta_productos WHERE retail = 1 AND activo = 1").all();

  return retailProds.map(function(rp) {
    const seleccion = obtenerSeleccion(rp.id);
    const gastosSelIds = seleccion ? JSON.parse(seleccion.gastos_ids||'[]') : [];

    // Encontrar productos de oferta que tienen este nombre_retail
    const proveedores = ofertaProds.filter(function(op){ return op.nombre_retail === rp.nombre; }).map(function(op) {
      const cbase   = (parseFloat(op.costo)||0) + (parseFloat(op.flete)||0);
      const kilos   = parseFloat(op.kilaje) || parseFloat((op.kilaje||'').replace(/[^0-9.]/g,'')) || 1;
      const precioKg = kilos > 0 ? (cbase / kilos) : 0;
      return {
        id:          op.id,
        codigo:      op.codigo,
        nombre:      op.nombre,
        proveedor:   op.proveedor||'-',
        costo:       op.costo,
        flete:       op.flete,
        cbase:       cbase,
        kilaje:      op.kilaje,
        kilos:       kilos,
        precio_kg:   precioKg,
        seleccionado: seleccion && seleccion.oferta_producto_id === op.id,
      };
    });

    const provSeleccionado = proveedores.find(function(p){ return p.seleccionado; }) || proveedores[0];
    const kilosProveedor = provSeleccionado ? (provSeleccionado.kilos || 1) : 1;
    const bxpSalida = rp.bxp_salida || 1;
    // gastosSum: bulto → monto/kg_bulto; pallet → monto/(kg_bulto × bxp_salida)
    const gastosSum = gastos.filter(function(g){ return gastosSelIds.indexOf(g.id) >= 0; }).reduce(function(s,g){
      var divisor = g.presentacion === 'pallet' ? (kilosProveedor * bxpSalida) : kilosProveedor;
      return s + ((g.monto||0) / divisor);
    }, 0);
    const costoBase = provSeleccionado ? (provSeleccionado.cbase / kilosProveedor) : 0;
    const costoTotal = costoBase + gastosSum;

    const preciosCanal = obtenerPreciosCanal(rp.id);
    return {
      id:           rp.id,
      nombre:       rp.nombre,
      categoria:    rp.categoria,
      proveedores:  proveedores,
      gastos_seleccionados: gastosSelIds,
      gastos_sum:   gastosSum,
      costo_kg_base: costoBase,
      costo_kg_total: costoTotal,
      oferta_producto_id: seleccion ? seleccion.oferta_producto_id : null,
      observaciones: seleccion ? seleccion.observaciones : null,
      precios_canal: preciosCanal,
      observaciones: seleccion ? seleccion.observaciones : null,
    };
  });
}

// Migracion: agregar columna retail si no existe
(function() {
  var cols = db.prepare("PRAGMA table_info(oferta_productos)").all().map(function(c){ return c.name; });
  if (cols.indexOf('retail') < 0) {
    try { db.exec("ALTER TABLE oferta_productos ADD COLUMN retail INTEGER DEFAULT 0"); } catch(e) {}
  }
  if (cols.indexOf('nombre_retail') < 0) {
    try { db.exec("ALTER TABLE oferta_productos ADD COLUMN nombre_retail TEXT"); } catch(e) {}
  }
  if (cols.indexOf('disponible_general') < 0) {
    try { db.exec("ALTER TABLE oferta_productos ADD COLUMN disponible_general INTEGER DEFAULT 1"); } catch(e) {}
  }
  // Migrar disponible de INTEGER a TEXT en oferta_precios
  const colsPrecios = db.prepare("PRAGMA table_info(oferta_precios)").all().map(c => c.name);
  if (!colsPrecios.includes('disponible_text')) {
    try {
      db.exec("ALTER TABLE oferta_precios ADD COLUMN disponible_text TEXT DEFAULT 'disponible'");
      db.exec("UPDATE oferta_precios SET disponible_text = CASE WHEN disponible = 1 THEN 'disponible' ELSE 'sin_stock' END");
      console.log("[DB] Columna disponible_text agregada en oferta_precios");
    } catch(e) { console.error("[DB] Error migrando disponible_text:", e.message); }
  }
})();

// ── Productos ──────────────────────────────────────────────────────────────
export function listarProductos(oferta) {
  const productos = db.prepare(
    "SELECT * FROM oferta_productos WHERE oferta = ? AND activo = 1 ORDER BY categoria, nombre"
  ).all(oferta);

  // Para cada producto traer sus precios por tipo
  return productos.map(p => {
    const precios = db.prepare(
      "SELECT tipo_cliente, precio, COALESCE(disponible_text, CASE WHEN disponible=1 THEN 'disponible' ELSE 'sin_stock' END) as disponible FROM oferta_precios WHERE producto_id = ?"
    ).all(p.id);
    const preciosMap = {};
    precios.forEach(pr => { preciosMap[pr.tipo_cliente] = { precio: pr.precio, disponible: pr.disponible }; });
    return { ...p, precios: preciosMap };
  });
}

export function obtenerProducto(id) {
  const p = db.prepare("SELECT * FROM oferta_productos WHERE id = ?").get(id);
  if (!p) return null;
  const precios = db.prepare("SELECT tipo_cliente, precio, COALESCE(disponible_text, CASE WHEN disponible=1 THEN 'disponible' ELSE 'sin_stock' END) as disponible FROM oferta_precios WHERE producto_id = ?").all(p.id);
  const preciosMap = {};
  precios.forEach(pr => { preciosMap[pr.tipo_cliente] = { precio: pr.precio, disponible: pr.disponible }; });
  return { ...p, precios: preciosMap };
}

export function upsertProducto(datos) {
  const result = db.prepare(`
    INSERT INTO oferta_productos (oferta, codigo, nombre, categoria, descripcion, origen, kilaje, marca, proveedor, costo, flete, consignacion, retail, nombre_retail, foto_path, notas)
    VALUES (@oferta, @codigo, @nombre, @categoria, @descripcion, @origen, @kilaje, @marca, @proveedor, @costo, @flete, @consignacion, @retail, @nombre_retail, @foto_path, @notas)
    ON CONFLICT(oferta, codigo) DO UPDATE SET
      nombre=excluded.nombre, categoria=excluded.categoria, descripcion=excluded.descripcion,
      origen=excluded.origen, kilaje=excluded.kilaje, marca=excluded.marca, proveedor=excluded.proveedor, costo=excluded.costo, flete=excluded.flete, consignacion=excluded.consignacion, retail=excluded.retail, nombre_retail=excluded.nombre_retail,
      foto_path=COALESCE(excluded.foto_path, foto_path), notas=excluded.notas,
      actualizado=datetime('now','localtime')
  `).run({
    oferta: datos.oferta, codigo: datos.codigo, nombre: datos.nombre,
    categoria: datos.categoria || '', descripcion: datos.descripcion || '',
    origen: datos.origen || '', kilaje: datos.kilaje || '', marca: datos.marca || '',
    proveedor: datos.proveedor || '', costo: parseFloat(datos.costo) || 0, flete: parseFloat(datos.flete) || 0, consignacion: parseInt(datos.consignacion) || 0, retail: parseInt(datos.retail) || 0, nombre_retail: datos.nombre_retail || null,
    foto_path: datos.foto_path || null, notas: datos.notas || '',
  });
  return result.lastInsertRowid || db.prepare("SELECT id FROM oferta_productos WHERE oferta=? AND codigo=?").get(datos.oferta, datos.codigo).id;
}

export function actualizarPrecio(productoId, tipoCliente, precio, disponible) {
  // disponible puede ser 'disponible', 'sin_stock', 'mnc' o legacy 0/1
  const dispText = (disponible === 'disponible' || disponible === 'sin_stock' || disponible === 'mnc')
    ? disponible
    : (disponible ? 'disponible' : 'sin_stock');
  const dispInt = dispText === 'disponible' ? 1 : 0;
  db.prepare(`
    INSERT INTO oferta_precios (producto_id, tipo_cliente, precio, disponible, disponible_text)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(producto_id, tipo_cliente) DO UPDATE SET precio=excluded.precio, disponible=excluded.disponible, disponible_text=excluded.disponible_text
  `).run(productoId, tipoCliente, parseFloat(precio) || 0, dispInt, dispText);
}

export function eliminarProducto(id) {
  db.prepare("UPDATE oferta_productos SET activo = 0 WHERE id = ?").run(id);
}

// Texto para el agente — catalogo filtrado por tipo de cliente
export function catalogoParaTipo(tipoCliente) {
  const oferta = OFERTA_POR_TIPO[tipoCliente] || 'oferta1';
  const productos = listarProductos(oferta);
  const disponibles = productos.filter(p => {
    const prec = p.precios[tipoCliente];
    return prec && prec.disponible === 'disponible';
  });
  const agotados = productos.filter(p => {
    const prec = p.precios[tipoCliente];
    return !prec || prec.disponible !== 'disponible';
  });

  if (!disponibles.length) return "Catalogo no disponible en este momento.";

  let texto = "";
  let catActual = "";
  disponibles.forEach(p => {
    if (p.categoria !== catActual) {
      catActual = p.categoria;
      if (catActual) texto += `\n${catActual.toUpperCase()}:\n`;
    }
    const prec = p.precios[tipoCliente];
    texto += `- [${p.codigo}] ${p.nombre}`;
    if (p.descripcion) texto += ` - ${p.descripcion}`;
    texto += ` | $${Number(prec?.precio || 0).toLocaleString("es-AR")}`;
    if (p.unidad) texto += ` por ${p.unidad}`;
    if (p.origen) texto += ` | Origen: ${p.origen}`;
    if (p.kilaje) texto += ` | ${p.kilaje}`;
    if (p.marca)  texto += ` | ${p.marca}`;
    if (p.consignacion) texto += " (consignacion)";
    if (p.notas)  texto += ` (${p.notas})`;
    texto += "\n";
  });

  if (agotados.length) {
    texto += `\nSin stock para vos: ${agotados.map(p => p.nombre).join(", ")}\n`;
  }

  return texto.trim();
}

// ── Dedicados ───────────────────────────────────────────────────────────────

// Crear tablas si no existen
(function() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dedicados_clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        empresa TEXT,
        telefono TEXT,
        email TEXT,
        direccion TEXT,
        zona TEXT,
        comercial TEXT,
        notas TEXT,
        activo INTEGER DEFAULT 1,
        creado_en TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE IF NOT EXISTS dedicados_precios (
        cliente_id INTEGER NOT NULL,
        producto_id INTEGER NOT NULL,
        precio REAL DEFAULT 0,
        PRIMARY KEY (cliente_id, producto_id)
      );
    `);
  } catch(e) { console.error('[DB] dedicados:', e.message); }
})();

export function listarDedicados() {
  return db.prepare("SELECT * FROM dedicados_clientes WHERE activo = 1 ORDER BY nombre").all();
}

export function crearDedicado(datos) {
  return db.prepare(`
    INSERT INTO dedicados_clientes (nombre, empresa, telefono, email, direccion, zona, comercial, notas)
    VALUES (@nombre, @empresa, @telefono, @email, @direccion, @zona, @comercial, @notas)
  `).run({
    nombre:    datos.nombre    || '',
    empresa:   datos.empresa   || null,
    telefono:  datos.telefono  || null,
    email:     datos.email     || null,
    direccion: datos.direccion || null,
    zona:      datos.zona      || null,
    comercial: datos.comercial || null,
    notas:     datos.notas     || null,
  }).lastInsertRowid;
}

export function actualizarDedicado(id, datos) {
  const campos = Object.keys(datos).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE dedicados_clientes SET ${campos} WHERE id = @id`).run({ ...datos, id });
}

export function eliminarDedicado(id) {
  db.prepare("UPDATE dedicados_clientes SET activo = 0 WHERE id = ?").run(id);
}

export function obtenerPreciosDedicado(clienteId) {
  return db.prepare(`
    SELECT dp.producto_id, dp.precio, op.nombre, op.categoria, op.kilaje, op.descripcion
    FROM dedicados_precios dp
    JOIN oferta_productos op ON op.id = dp.producto_id
    WHERE dp.cliente_id = ?
  `).all(clienteId);
}

export function guardarPrecioDedicado(clienteId, productoId, precio) {
  db.prepare(`
    INSERT INTO dedicados_precios (cliente_id, producto_id, precio)
    VALUES (?,?,?)
    ON CONFLICT(cliente_id, producto_id) DO UPDATE SET precio = excluded.precio
  `).run(parseInt(clienteId), parseInt(productoId), parseFloat(precio)||0);
}

export function eliminarPrecioDedicado(clienteId, productoId) {
  db.prepare("DELETE FROM dedicados_precios WHERE cliente_id = ? AND producto_id = ?").run(parseInt(clienteId), parseInt(productoId));
}

export function crearPedidoDedicado(clienteId, detalle, total) {
  const cliente = db.prepare("SELECT * FROM dedicados_clientes WHERE id = ?").get(clienteId);
  if (!cliente) throw new Error("Cliente dedicado no encontrado");
  return db.prepare(`
    INSERT INTO pedidos (telefono, tipo_cliente, detalle, total)
    VALUES (?, 'dedicados', ?, ?)
  `).run(cliente.telefono || ('ded-' + clienteId), detalle, parseFloat(total)||0).lastInsertRowid;
}
