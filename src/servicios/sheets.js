// ── Servicio Google Sheets → SQLite ───────────────────────────────────────
// Lee BASE COMPRA y BASE VENTA del sheet y guarda en tablas locales
// para búsquedas rápidas sin depender de la conexión a Google en cada request

import db from './db.js';

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// ── Crear tablas locales ───────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sheet_compras (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    partida     TEXT,
    fecha       TEXT,
    nro_comprob TEXT,
    deposito    TEXT,
    proveedor   TEXT,
    guia        TEXT,
    articulo    TEXT,
    envase      TEXT,
    ingreso     REAL,
    convertidos REAL,
    mermas      REAL,
    vendidos    REAL,
    promedio    REAL,
    tot_ventas  REAL,
    raw         TEXT,
    sync_fecha  TEXT DEFAULT (date('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sheet_ventas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    id_venta    TEXT,
    fecha       TEXT,
    nro_comprob TEXT,
    cod_cli     TEXT,
    cliente     TEXT,
    alias       TEXT,
    cod_vend    TEXT,
    vendedor    TEXT,
    cod_art     TEXT,
    articulo    TEXT,
    cantidad    REAL,
    precio      REAL,
    total       REAL,
    partida     TEXT,
    raw         TEXT,
    sync_fecha  TEXT DEFAULT (date('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sheet_sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo        TEXT,
    filas       INTEGER,
    duracion_ms INTEGER,
    error       TEXT,
    creado_en   TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// Índices para búsqueda rápida
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_compras_articulo ON sheet_compras(articulo);
    CREATE INDEX IF NOT EXISTS idx_compras_proveedor ON sheet_compras(proveedor);
    CREATE INDEX IF NOT EXISTS idx_compras_fecha ON sheet_compras(fecha);
    CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON sheet_ventas(cliente);
    CREATE INDEX IF NOT EXISTS idx_ventas_alias ON sheet_ventas(alias);
    CREATE INDEX IF NOT EXISTS idx_ventas_articulo ON sheet_ventas(articulo);
    CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON sheet_ventas(fecha);
  `);
} catch(e) {}

// ── Obtener token de Google ────────────────────────────────────────────────
async function getGoogleToken() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT no configurado');
  const creds = JSON.parse(raw);

  // Crear JWT
  const header = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
  const now = Math.floor(Date.now()/1000);
  const claim = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${claim}`);
  const sig = sign.sign(creds.private_key).toString('base64url');
  const jwt = `${header}.${claim}.${sig}`;

  // Intercambiar JWT por access token
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type':'application/x-www-form-urlencoded'},
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } 
  catch(e) { 
    console.error('[Sheets] Respuesta token no es JSON:', text.slice(0,300));
    throw new Error('Token response no es JSON: '+text.slice(0,200)); 
  }
  if (!data.access_token) throw new Error('No se pudo obtener token: '+JSON.stringify(data));
  return data.access_token;
}

// ── Leer rango del sheet ───────────────────────────────────────────────────
async function leerRango(token, rango) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(rango)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); }
  catch(e) {
    console.error('[Sheets] leerRango no es JSON:', text.slice(0,300));
    throw new Error('Respuesta no es JSON para rango '+rango);
  }
  if (data.error) throw new Error(`Error leyendo ${rango}: ${data.error.message}`);
  return data.values || [];
}

// ── Sync BASE COMPRA ───────────────────────────────────────────────────────
async function syncCompras(token) {
  const t0 = Date.now();
  console.log('[Sheets] Iniciando sync BASE COMPRA...');

  // Leer en bloques de 5000 filas para no colapsar
  const BLOQUE = 5000;
  let fila = 2; // empieza en 2 (sin header)
  let total = 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO sheet_compras
    (partida,fecha,nro_comprob,deposito,proveedor,guia,articulo,envase,ingreso,convertidos,mermas,vendidos,promedio,tot_ventas,raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  // Limpiar tabla antes de sync completo
  db.exec("DELETE FROM sheet_compras");

  while (true) {
    const rango = `B COMPRAS!A${fila}:Q${fila + BLOQUE - 1}`;
    const rows = await leerRango(token, rango);
    if (!rows.length) break;

    const ins = db.transaction(() => {
      for (const r of rows) {
        if (!r[0]) continue;
        stmt.run(
          r[0]||null,  // partida
          r[2]||null,  // fecha (col C)
          r[3]||null,  // nro_comprob (col D)
          r[4]||null,  // deposito
          r[5]||null,  // proveedor
          r[6]||null,  // guia
          r[9]||null,  // articulo (col J)
          r[10]||null, // envase
          parseFloat(r[11])||0, // ingreso
          parseFloat(r[12])||0, // convertidos
          parseFloat(r[13])||0, // mermas
          parseFloat(r[14])||0, // vendidos
          parseFloat(r[15])||0, // promedio
          parseFloat(r[16])||0, // tot_ventas
          JSON.stringify(r)
        );
        total++;
      }
    });
    ins();
    fila += BLOQUE;
    if (rows.length < BLOQUE) break;
  }

  const dur = Date.now() - t0;
  db.prepare("INSERT INTO sheet_sync_log (tipo,filas,duracion_ms) VALUES (?,?,?)").run('compras', total, dur);
  console.log(`[Sheets] Sync compras: ${total} filas en ${dur}ms`);
  return total;
}

// ── Sync BASE VENTA ────────────────────────────────────────────────────────
async function syncVentas(token) {
  const t0 = Date.now();
  console.log('[Sheets] Iniciando sync BASE VENTA...');

  const BLOQUE = 5000;
  let fila = 2;
  let total = 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO sheet_ventas
    (id_venta,fecha,nro_comprob,cod_cli,cliente,alias,cod_vend,vendedor,cod_art,articulo,cantidad,precio,total,partida,raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  db.exec("DELETE FROM sheet_ventas");

  while (true) {
    const rango = `B VENTAS!A${fila}:N${fila + BLOQUE - 1}`;
    const rows = await leerRango(token, rango);
    if (!rows.length) break;

    const ins = db.transaction(() => {
      for (const r of rows) {
        if (!r[0]) continue;
        stmt.run(
          r[0]||null,  // id
          r[1]||null,  // fecha
          r[2]||null,  // nro_comprob
          r[3]||null,  // cod_cli
          r[4]||null,  // cliente
          r[5]||null,  // alias
          r[6]||null,  // cod_vend
          r[7]||null,  // vendedor
          r[8]||null,  // cod_art
          r[9]||null,  // articulo
          parseFloat(r[10])||0, // cantidad
          parseFloat(r[11])||0, // precio
          parseFloat(r[12])||0, // total
          r[13]||null, // partida
          JSON.stringify(r)
        );
        total++;
      }
    });
    ins();
    fila += BLOQUE;
    if (rows.length < BLOQUE) break;
  }

  const dur = Date.now() - t0;
  db.prepare("INSERT INTO sheet_sync_log (tipo,filas,duracion_ms) VALUES (?,?,?)").run('ventas', total, dur);
  console.log(`[Sheets] Sync ventas: ${total} filas en ${dur}ms`);
  return total;
}

// ── Sync completo ──────────────────────────────────────────────────────────
export async function syncSheets() {
  if (!SHEET_ID) { console.log('[Sheets] GOOGLE_SHEET_ID no configurado, skip sync'); return; }
  try {
    const token = await getGoogleToken();
    await syncCompras(token);
    await syncVentas(token);
    console.log('[Sheets] Sync completo OK');
  } catch(e) {
    console.error('[Sheets] Error en sync:', e.message);
    db.prepare("INSERT INTO sheet_sync_log (tipo,filas,duracion_ms,error) VALUES (?,?,?,?)").run('error', 0, 0, e.message);
  }
}

// ── Funciones de búsqueda ─────────────────────────────────────────────────
export function buscarProductoCompras(q) {
  return db.prepare(`
    SELECT proveedor,
      COUNT(*) as compras,
      MAX(fecha) as ultima_compra,
      MIN(fecha) as primera_compra,
      ROUND(AVG(promedio),2) as precio_promedio,
      ROUND(SUM(ingreso),0) as total_ingreso
    FROM sheet_compras
    WHERE articulo LIKE ? AND proveedor IS NOT NULL AND proveedor != ''
    GROUP BY proveedor
    ORDER BY ultima_compra DESC
  `).all(`%${q}%`);
}

export function buscarProductoVentas(q) {
  return db.prepare(`
    SELECT articulo,
      COUNT(*) as ventas,
      MAX(fecha) as ultima_venta,
      ROUND(AVG(precio),2) as precio_promedio,
      ROUND(SUM(total),0) as total_facturado,
      ROUND(SUM(cantidad),0) as total_cantidad
    FROM sheet_ventas
    WHERE articulo LIKE ?
    GROUP BY articulo
    ORDER BY ultima_venta DESC
    LIMIT 20
  `).all(`%${q}%`);
}

export function buscarClienteVentas(q) {
  return db.prepare(`
    SELECT cliente, alias,
      COUNT(*) as compras,
      MAX(fecha) as ultima_compra,
      MIN(fecha) as primera_compra,
      ROUND(SUM(total),0) as total_facturado,
      COUNT(DISTINCT articulo) as productos_distintos
    FROM sheet_ventas
    WHERE cliente LIKE ? OR alias LIKE ?
    GROUP BY cliente, alias
    ORDER BY ultima_compra DESC
    LIMIT 10
  `).all(`%${q}%`, `%${q}%`);
}

export function historialClienteVentas(q) {
  return db.prepare(`
    SELECT fecha, articulo, cantidad, precio, total, vendedor
    FROM sheet_ventas
    WHERE cliente LIKE ? OR alias LIKE ?
    ORDER BY fecha DESC
    LIMIT 200
  `).all(`%${q}%`, `%${q}%`);
}

export function estadoSync() {
  const compras = db.prepare("SELECT COUNT(*) as n, MAX(sync_fecha) as ultimo FROM sheet_compras").get();
  const ventas  = db.prepare("SELECT COUNT(*) as n, MAX(sync_fecha) as ultimo FROM sheet_ventas").get();
  const log     = db.prepare("SELECT * FROM sheet_sync_log ORDER BY id DESC LIMIT 5").all();
  return { compras, ventas, log };
}
