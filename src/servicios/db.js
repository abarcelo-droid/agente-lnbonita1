import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../../data/clientes.db");

// Asegurar que existe el directorio de datos
import fs from "fs";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ── Esquema ────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    telefono     TEXT PRIMARY KEY,
    tipo         TEXT NOT NULL CHECK(tipo IN ('mayorista_a','mayorista_mcba','minorista_mcba','minorista_entrega','dedicados','food_service','consumidor_final','nuevo')),
    nombre       TEXT,
    empresa      TEXT,
    email        TEXT,
    direccion    TEXT,
    zona         TEXT,
    horario_entrega TEXT,
    cuenta_corriente INTEGER DEFAULT 0,
    activo       INTEGER DEFAULT 1,
    creado_en    TEXT DEFAULT (datetime('now','localtime')),
    notas        TEXT
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    telefono     TEXT PRIMARY KEY,
    mensajes     TEXT NOT NULL DEFAULT '[]',
    estado       TEXT DEFAULT 'activo',
    actualizado  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS pedidos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono     TEXT NOT NULL,
    tipo_cliente TEXT NOT NULL,
    detalle      TEXT NOT NULL,
    total        REAL,
    estado       TEXT DEFAULT 'pendiente',
    horario_entrega TEXT,
    creado_en    TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── Clientes ───────────────────────────────────────────────────────────────
export function obtenerCliente(telefono) {
  return db.prepare("SELECT * FROM clientes WHERE telefono = ?").get(telefono);
}

export function crearCliente(datos) {
  const stmt = db.prepare(`
    INSERT INTO clientes (telefono, tipo, nombre, empresa, email, direccion, zona, notas, codigo_abasto, metodo_pago)
    VALUES (@telefono, @tipo, @nombre, @empresa, @email, @direccion, @zona, @notas, @codigo_abasto, @metodo_pago)
  `);
  stmt.run({
    ...datos,
    codigo_abasto: datos.codigo_abasto || null,
    metodo_pago:   datos.metodo_pago   || 'cuenta_corriente',
  });
  return obtenerCliente(datos.telefono);
}

export function actualizarCliente(telefono, datos) {
  const campos = Object.keys(datos).map(k => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE clientes SET ${campos} WHERE telefono = @telefono`)
    .run({ ...datos, telefono });
}

export function listarClientes(tipo, excluirCancelados) {
  const condCancelado = excluirCancelados
    ? " AND (metodo_pago IS NULL OR metodo_pago != 'cancelado')"
    : "";
  const query = tipo
    ? "SELECT * FROM clientes WHERE tipo = ? AND activo = 1" + condCancelado + " ORDER BY nombre"
    : "SELECT * FROM clientes WHERE activo = 1 AND tipo != 'nuevo'" + condCancelado + " ORDER BY tipo, nombre";
  return tipo ? db.prepare(query).all(tipo) : db.prepare(query).all();
}

// Valida si un cliente puede comprar segun su metodo de pago
export function validarPuedeComprar(telefono) {
  const c = obtenerCliente(telefono);
  if (!c) return { puede: true, motivo: null };
  if (c.metodo_pago === 'cancelado') {
    return { puede: false, motivo: 'cuenta_cancelada' };
  }
  return { puede: true, motivo: null, metodo: c.metodo_pago || 'cuenta_corriente' };
}

// ── Sesiones ───────────────────────────────────────────────────────────────
export function obtenerSesion(telefono) {
  const row = db.prepare("SELECT * FROM sesiones WHERE telefono = ?").get(telefono);
  if (!row) return { telefono, mensajes: [] };
  return { ...row, mensajes: JSON.parse(row.mensajes) };
}

export function guardarSesion(telefono, mensajes) {
  db.prepare(`
    INSERT INTO sesiones (telefono, mensajes, actualizado)
    VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(telefono) DO UPDATE SET
      mensajes = excluded.mensajes,
      actualizado = excluded.actualizado
  `).run(telefono, JSON.stringify(mensajes));
}

export function limpiarSesion(telefono) {
  db.prepare("DELETE FROM sesiones WHERE telefono = ?").run(telefono);
}

// ── Pedidos ────────────────────────────────────────────────────────────────
export function crearPedido(datos) {
  const result = db.prepare(`
    INSERT INTO pedidos (telefono, tipo_cliente, detalle, total, horario_entrega)
    VALUES (@telefono, @tipo_cliente, @detalle, @total, @horario_entrega)
  `).run(datos);
  return result.lastInsertRowid;
}

export function listarPedidos(filtros = {}) {
  let query = "SELECT * FROM pedidos WHERE 1=1";
  const params = [];
  if (filtros.tipo_cliente) { query += " AND tipo_cliente = ?"; params.push(filtros.tipo_cliente); }
  if (filtros.estado)       { query += " AND estado = ?";       params.push(filtros.estado); }
  if (filtros.fecha)        { query += " AND date(creado_en) = ?"; params.push(filtros.fecha); }
  query += " ORDER BY creado_en DESC";
  return db.prepare(query).all(...params);
}

export function actualizarEstadoPedido(id, estado) {
  db.prepare("UPDATE pedidos SET estado = ? WHERE id = ?").run(estado, id);
}

export default db;

// ── Migracion: agregar columnas nuevas si no existen ───────────────────────
(function migrar() {
  var cols = db.prepare("PRAGMA table_info(clientes)").all().map(function(c){ return c.name; });
  if (cols.indexOf('codigo_abasto') < 0) {
    db.exec("ALTER TABLE clientes ADD COLUMN codigo_abasto TEXT");
    console.log("[DB] Columna codigo_abasto agregada");
  }
  if (cols.indexOf('metodo_pago') < 0) {
    db.exec("ALTER TABLE clientes ADD COLUMN metodo_pago TEXT DEFAULT 'cuenta_corriente'");
    console.log("[DB] Columna metodo_pago agregada");
  }
  if (cols.indexOf('modo') < 0) {
    db.exec("ALTER TABLE clientes ADD COLUMN modo TEXT DEFAULT 'pausa'");
    console.log("[DB] Columna modo agregada");
  }
  if (cols.indexOf('comercial_asignado') < 0) {
    db.exec("ALTER TABLE clientes ADD COLUMN comercial_asignado TEXT");
    console.log("[DB] Columna comercial_asignado agregada");
  }
  if (cols.indexOf('dias_contacto') < 0) {
    db.exec("ALTER TABLE clientes ADD COLUMN dias_contacto TEXT DEFAULT '[]'");
    console.log("[DB] Columna dias_contacto agregada");
  }
})();

// ── Facturas y cobranza ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS facturas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id       INTEGER,
    telefono        TEXT NOT NULL,
    tipo_cliente    TEXT NOT NULL,
    numero_factura  TEXT,
    archivo_path    TEXT NOT NULL,
    nombre_archivo  TEXT,
    fecha_emision   TEXT DEFAULT (date('now','localtime')),
    fecha_vencimiento TEXT,
    monto           REAL,
    estado          TEXT DEFAULT 'subida' CHECK(estado IN ('subida','enviada','pagada','vencida')),
    notas           TEXT,
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );
`);

export function crearFactura(datos) {
  return db.prepare(`
    INSERT INTO facturas (pedido_id, telefono, tipo_cliente, numero_factura,
      archivo_path, nombre_archivo, fecha_vencimiento, monto, notas)
    VALUES (@pedido_id, @telefono, @tipo_cliente, @numero_factura,
      @archivo_path, @nombre_archivo, @fecha_vencimiento, @monto, @notas)
  `).run(datos).lastInsertRowid;
}

export function listarFacturas(filtros) {
  filtros = filtros || {};
  var query = "SELECT f.*, c.nombre as cliente_nombre FROM facturas f LEFT JOIN clientes c ON c.telefono = f.telefono WHERE 1=1";
  var params = [];
  if (filtros.estado)       { query += " AND f.estado = ?";        params.push(filtros.estado); }
  if (filtros.tipo_cliente) { query += " AND f.tipo_cliente = ?";   params.push(filtros.tipo_cliente); }
  if (filtros.telefono)     { query += " AND f.telefono = ?";       params.push(filtros.telefono); }
  query += " ORDER BY f.creado_en DESC";
  return db.prepare(query).all(...params);
}

export function actualizarEstadoFactura(id, estado, notas) {
  db.prepare("UPDATE facturas SET estado = ?, notas = COALESCE(?, notas) WHERE id = ?").run(estado, notas || null, id);
}

export function obtenerFactura(id) {
  return db.prepare("SELECT * FROM facturas WHERE id = ?").get(id);
}

export function resumenCobranza() {
  return db.prepare(`
    SELECT
      estado,
      COUNT(*) as cantidad,
      SUM(monto) as total
    FROM facturas
    WHERE tipo_cliente IN ('mayorista_b','minorista','food_service')
    GROUP BY estado
  `).all();
}

// ── CRM Dedicados ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS crm_clientes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono        TEXT NOT NULL,
    comercial       TEXT NOT NULL,
    situacion       TEXT DEFAULT 'pendiente' CHECK(situacion IN ('pendiente','enviado','venta','fallido')),
    dias_contacto   TEXT DEFAULT '[]',
    tipo_oferta     TEXT DEFAULT 'mayorista_mcba',
    notas           TEXT,
    ultima_gestion  TEXT DEFAULT (date('now','localtime')),
    creado_en       TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// Migracion crm_clientes
(function() {
  try {
    const cols = db.prepare("PRAGMA table_info(crm_clientes)").all().map(c => c.name);
    if (!cols.includes('tipo_oferta')) {
      db.exec("ALTER TABLE crm_clientes ADD COLUMN tipo_oferta TEXT DEFAULT 'mayorista_mcba'");
    }
  } catch(e) {}
})();

export function listarCRM(comercial) {
  const hoy = new Date();
  const diasSemana = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
  const diaHoy = diasSemana[hoy.getDay()];
  const hoyStr = hoy.toISOString().slice(0,10);

  // Auto-sync: clientes WhatsApp con modo='crm'
  try {
    const clientesCRM = db.prepare("SELECT * FROM clientes WHERE modo='crm' AND activo=1 AND tipo != 'consumidor_final'").all();
    clientesCRM.forEach(function(c) {
      const existe = db.prepare("SELECT id FROM crm_clientes WHERE telefono = ?").get(c.telefono);
      if (!existe) {
        db.prepare("INSERT INTO crm_clientes (telefono, comercial, dias_contacto, tipo_oferta, notas) VALUES (?, ?, ?, ?, ?)")
          .run(c.telefono, c.comercial_asignado || 'Sin asignar', c.dias_contacto || '[]', c.tipo, null);
      } else {
        // Actualizar comercial/dias si cambiaron
        db.prepare("UPDATE crm_clientes SET comercial=?, dias_contacto=?, tipo_oferta=? WHERE telefono=?")
          .run(c.comercial_asignado || 'Sin asignar', c.dias_contacto || '[]', c.tipo, c.telefono);
      }
    });
    // Remover del CRM clientes que ya no tienen modo='crm' (excepto dedicados)
    const enCRM = db.prepare("SELECT telefono FROM crm_clientes WHERE telefono NOT LIKE 'ded-%'").all();
    enCRM.forEach(function(r) {
      const cli = db.prepare("SELECT modo FROM clientes WHERE telefono=?").get(r.telefono);
      if (cli && cli.modo !== 'crm') {
        db.prepare("DELETE FROM crm_clientes WHERE telefono=?").run(r.telefono);
      }
    });
  } catch(e) { console.error('[CRM] Auto-sync clientes error:', e.message); }

  // Auto-sync dedicados_clientes
  try {
    const dedicados = db.prepare("SELECT * FROM dedicados_clientes WHERE activo = 1").all();
    dedicados.forEach(function(d) {
      const key = d.telefono || ('ded-' + d.id);
      const existe = db.prepare("SELECT id FROM crm_clientes WHERE telefono = ?").get(key);
      if (!existe) {
        db.prepare("INSERT INTO crm_clientes (telefono, comercial, dias_contacto, tipo_oferta, notas) VALUES (?, ?, ?, ?, ?)")
          .run(key, d.comercial || 'Sin asignar', d.dias_venta || '[]', d.tipo_oferta || 'mayorista_mcba', d.notas || null);
      } else if (d.dias_venta && d.dias_venta !== '[]') {
        const crmRow = db.prepare("SELECT dias_contacto FROM crm_clientes WHERE telefono = ?").get(key);
        if (crmRow && (!crmRow.dias_contacto || crmRow.dias_contacto === '[]')) {
          db.prepare("UPDATE crm_clientes SET dias_contacto=? WHERE telefono=?").run(d.dias_venta, key);
        }
      }
    });
  } catch(e) { console.error('[CRM] Auto-sync dedicados error:', e.message); }
  const todos = db.prepare("SELECT * FROM crm_clientes").all();
  todos.forEach(function(c) {
    if (c.situacion === 'venta' || c.situacion === 'fallido') {
      const dias = JSON.parse(c.dias_contacto || '[]');
      if (dias.includes(diaHoy) && c.ultima_gestion !== hoyStr) {
        db.prepare("UPDATE crm_clientes SET situacion='pendiente', ultima_gestion=? WHERE id=?").run(hoyStr, c.id);
      }
    }
  });

  // Traer todos los crm con nombre desde dedicados_clientes
  const crmRows = comercial
    ? db.prepare("SELECT * FROM crm_clientes WHERE comercial = ? ORDER BY situacion").all(comercial)
    : db.prepare("SELECT * FROM crm_clientes ORDER BY comercial, situacion").all();

  // Enriquecer con nombre/empresa desde dedicados_clientes o clientes
  return crmRows.map(function(cr) {
    var ded = db.prepare("SELECT nombre, empresa FROM dedicados_clientes WHERE telefono = ? OR id = ?").get(
      cr.telefono,
      cr.telefono && cr.telefono.startsWith('ded-') ? parseInt(cr.telefono.slice(4)) : -1
    );
    var cli = !ded ? db.prepare("SELECT nombre, empresa, tipo FROM clientes WHERE telefono = ?").get(cr.telefono) : null;
    return Object.assign({}, cr, {
      nombre: (ded && ded.nombre) || (cli && cli.nombre) || cr.telefono || '-',
      empresa: (ded && ded.empresa) || (cli && cli.empresa) || '',
      tel: cr.telefono
    });
  });
}

export function upsertCRM(datos) {
  const existe = db.prepare("SELECT id FROM crm_clientes WHERE telefono = ?").get(datos.telefono);
  if (existe) {
    db.prepare(`UPDATE crm_clientes SET comercial=?, dias_contacto=?, tipo_oferta=?, notas=? WHERE telefono=?`)
      .run(datos.comercial, JSON.stringify(datos.dias_contacto||[]), datos.tipo_oferta||'mayorista_mcba', datos.notas||null, datos.telefono);
  } else {
    db.prepare(`INSERT INTO crm_clientes (telefono, comercial, dias_contacto, tipo_oferta, notas) VALUES (?,?,?,?,?)`)
      .run(datos.telefono, datos.comercial, JSON.stringify(datos.dias_contacto||[]), datos.tipo_oferta||'mayorista_mcba', datos.notas||null);
  }
}

export function actualizarSituacionCRM(id, situacion, nota) {
  const hoy = new Date().toISOString().slice(0,10);
  if (nota) {
    db.prepare("UPDATE crm_clientes SET situacion=?, ultima_gestion=?, notas=COALESCE(notas||char(10)||?,?) WHERE id=?")
      .run(situacion, hoy, nota, nota, id);
  } else {
    db.prepare("UPDATE crm_clientes SET situacion=?, ultima_gestion=? WHERE id=?").run(situacion, hoy, id);
  }
}

export function actualizarModoCliente(telefono, modo, comercial, dias_contacto) {
  db.prepare("UPDATE clientes SET modo=?, comercial_asignado=?, dias_contacto=? WHERE telefono=?")
    .run(modo||'pausa', comercial||null, JSON.stringify(dias_contacto||[]), telefono);
}

export function obtenerCRM(telefono) {
  return db.prepare("SELECT * FROM crm_clientes WHERE telefono = ?").get(telefono);
}

// ── CRM Historial ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS crm_historial (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    crm_id      INTEGER NOT NULL,
    telefono    TEXT,
    comercial   TEXT,
    situacion   TEXT,
    nota        TEXT,
    fecha       TEXT DEFAULT (date('now','localtime')),
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );
`);

export function guardarSnapshotCRM() {
  const fecha = new Date().toLocaleDateString('es-AR', {day:'2-digit',month:'2-digit',year:'numeric'});
  const clientes = db.prepare("SELECT * FROM crm_clientes").all();
  let guardados = 0;
  clientes.forEach(function(c) {
    // Solo guardar si tuvo actividad hoy (ultima_gestion = hoy) o si está en enviado/venta/fallido
    if (c.situacion !== 'pendiente' || c.ultima_gestion === new Date().toISOString().slice(0,10)) {
      const yaExiste = db.prepare("SELECT id FROM crm_historial WHERE crm_id=? AND fecha=date('now','localtime')").get(c.id);
      if (!yaExiste) {
        db.prepare("INSERT INTO crm_historial (crm_id, telefono, comercial, situacion, nota, fecha) VALUES (?,?,?,?,?,date('now','localtime'))")
          .run(c.id, c.telefono, c.comercial, c.situacion, c.notas||null);
        guardados++;
      }
    }
  });
  console.log(`[CRM] Snapshot medianoche: ${guardados} registros guardados`);
  return guardados;
}
