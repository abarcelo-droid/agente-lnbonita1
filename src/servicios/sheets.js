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
    partida_ok  TEXT,
    sem         TEXT,
    mes         TEXT,
    anio        TEXT,
    cod_fecha   TEXT,
    precio_ok   REAL,
    total_ok    REAL,
    dol_dia     REAL,
    prec_dol    REAL,
    tot_dol     REAL,
    periodo     TEXT,
    producto    TEXT,
    kilaje      TEXT,
    kilos_tot   REAL,
    categoria   TEXT,
    costeo      REAL,
    cate_clie   TEXT,
    subcategoria TEXT,
    boni        REAL,
    proveedor   TEXT,
    rent        REAL,
    rent_dol    REAL,
    mes_ok      TEXT,
    des         REAL,
    flete_largo REAL,
    descargas   REAL,
    ifco        REAL,
    flete_super REAL,
    pct         REAL,
    cat_pro     TEXT,
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

// Migración: verificar esquema de sheet_ventas
(function() {
  try {
    var cols = db.prepare("PRAGMA table_info(sheet_ventas)").all().map(function(c){ return c.name; });
    var necesarias = ['producto','kilos_tot','cate_clie','rent','rent_dol','cat_pro'];
    var falta = necesarias.some(function(c){ return cols.indexOf(c) < 0; });
    if (falta) {
      console.log('[Sheets] Tabla sheet_ventas desactualizada, recreando...');
      db.exec("DROP TABLE IF EXISTS sheet_ventas");
      db.exec("CREATE TABLE sheet_ventas (id INTEGER PRIMARY KEY AUTOINCREMENT, id_venta TEXT, fecha TEXT, nro_comprob TEXT, cod_cli TEXT, cliente TEXT, alias TEXT, cod_vend TEXT, vendedor TEXT, cod_art TEXT, articulo TEXT, cantidad REAL, precio REAL, total REAL, partida TEXT, partida_ok TEXT, sem TEXT, mes TEXT, anio TEXT, cod_fecha TEXT, precio_ok REAL, total_ok REAL, dol_dia REAL, prec_dol REAL, tot_dol REAL, periodo TEXT, producto TEXT, kilaje TEXT, kilos_tot REAL, categoria TEXT, costeo REAL, cate_clie TEXT, subcategoria TEXT, boni REAL, proveedor TEXT, rent REAL, rent_dol REAL, mes_ok TEXT, des REAL, flete_largo REAL, descargas REAL, ifco REAL, flete_super REAL, pct REAL, cat_pro TEXT, raw TEXT, sync_fecha TEXT DEFAULT (date('now','localtime')))");
      console.log('[Sheets] Tabla sheet_ventas recreada OK');
    }
  } catch(e) { console.error('[Sheets] Error migrando sheet_ventas:', e.message); }
})();

// Migración: agregar columnas nuevas si no existen
(function() {
  var cols = [];
  try { cols = db.prepare("PRAGMA table_info(sheet_ventas)").all().map(function(c){ return c.name; }); } catch(e) {}
  var nuevas = [
    ["partida_ok","TEXT"],["sem","TEXT"],["mes","TEXT"],["anio","TEXT"],
    ["cod_fecha","TEXT"],["precio_ok","REAL"],["total_ok","REAL"],
    ["dol_dia","REAL"],["prec_dol","REAL"],["tot_dol","REAL"],
    ["periodo","TEXT"],["producto","TEXT"],["kilaje","TEXT"],["kilos_tot","REAL"],
    ["categoria","TEXT"],["costeo","REAL"],["cate_clie","TEXT"],
    ["subcategoria","TEXT"],["boni","REAL"],["proveedor","TEXT"],
    ["rent","REAL"],["rent_dol","REAL"],["mes_ok","TEXT"],
    ["des","REAL"],["flete_largo","REAL"],["descargas","REAL"],
    ["ifco","REAL"],["flete_super","REAL"],["pct","REAL"],["cat_pro","TEXT"]
  ];
  nuevas.forEach(function(par) {
    if (cols.indexOf(par[0]) < 0) {
      try { db.exec("ALTER TABLE sheet_ventas ADD COLUMN "+par[0]+" "+par[1]); } catch(e) {}
    }
  });
})();

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
    CREATE INDEX IF NOT EXISTS idx_ventas_categoria ON sheet_ventas(categoria);
    CREATE INDEX IF NOT EXISTS idx_ventas_cate_clie ON sheet_ventas(cate_clie);
    CREATE INDEX IF NOT EXISTS idx_ventas_proveedor ON sheet_ventas(proveedor);
    CREATE INDEX IF NOT EXISTS idx_ventas_producto ON sheet_ventas(producto);
    CREATE INDEX IF NOT EXISTS idx_ventas_mes_ok ON sheet_ventas(mes_ok);
    CREATE INDEX IF NOT EXISTS idx_ventas_vendedor ON sheet_ventas(vendedor);
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
    (id_venta,fecha,nro_comprob,cod_cli,cliente,alias,cod_vend,vendedor,cod_art,articulo,cantidad,precio,total,partida,
     partida_ok,sem,mes,anio,cod_fecha,precio_ok,total_ok,dol_dia,prec_dol,tot_dol,periodo,producto,kilaje,kilos_tot,
     categoria,costeo,cate_clie,subcategoria,boni,proveedor,rent,rent_dol,mes_ok,des,flete_largo,descargas,ifco,flete_super,pct,cat_pro,raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,
            ?,?,?,?,?,?,?,?,?,?,?,?,?,?,
            ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  db.exec("DELETE FROM sheet_ventas");

  while (true) {
    const rango = `B VENTAS!A${fila}:AR${fila + BLOQUE - 1}`;
    const rows = await leerRango(token, rango);
    if (!rows.length) break;

    const ins = db.transaction(() => {
      for (const r of rows) {
        if (!r[0]) continue;
        stmt.run(
          r[0]||null,  // id_venta
          r[1]||null,  // fecha
          r[2]||null,  // nro_comprob
          r[3]||null,  // cod_cli
          r[4]||null,  // cliente
          r[5]||null,  // alias
          r[6]||null,  // cod_vend
          r[7]||null,  // vendedor
          r[8]||null,  // cod_art
          r[9]||null,  // articulo
          parseFloat(r[10])||0,  // cantidad
          parseFloat(r[11])||0,  // precio
          parseFloat(r[12])||0,  // total
          r[13]||null,           // partida
          r[14]||null,           // partida_ok  (O)
          r[15]||null,           // sem         (P)
          r[16]||null,           // mes         (Q)
          r[17]||null,           // anio        (R)
          r[18]||null,           // cod_fecha   (S)
          parseFloat(r[19])||0,  // precio_ok   (T)
          parseFloat(r[20])||0,  // total_ok    (U)
          parseFloat(r[21])||0,  // dol_dia     (V)
          parseFloat(r[22])||0,  // prec_dol    (W)
          parseFloat(r[23])||0,  // tot_dol     (X)
          r[24]||null,           // periodo     (Y)
          r[25]||null,           // producto    (Z)
          r[26]||null,           // kilaje      (AA)
          parseFloat(r[27])||0,  // kilos_tot   (AB)
          r[28]||null,           // categoria   (AC)
          parseFloat(r[29])||0,  // costeo      (AD)
          r[30]||null,           // cate_clie   (AE)
          r[31]||null,           // subcategoria(AF)
          parseFloat(r[32])||0,  // boni        (AG)
          r[33]||null,           // proveedor   (AH)
          parseFloat(r[34])||0,  // rent        (AI)
          parseFloat(r[35])||0,  // rent_dol    (AJ)
          r[36]||null,           // mes_ok      (AK)
          parseFloat(r[37])||0,  // des         (AL)
          parseFloat(r[38])||0,  // flete_largo (AM)
          parseFloat(r[39])||0,  // descargas   (AN)
          parseFloat(r[40])||0,  // ifco        (AO)
          parseFloat(r[41])||0,  // flete_super (AP)
          parseFloat(r[42])||0,  // pct         (AQ)
          r[43]||null,           // cat_pro     (AR)
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

// ── Funciones de informes ────────────────────────────────────────────────

export function rentPorMes() {
  return db.prepare(`
    SELECT mes_ok,
      ROUND(SUM(tot_dol),0) as venta_dol,
      ROUND(SUM(rent_dol),0) as rent_dol,
      ROUND(SUM(rent_dol)*100.0/NULLIF(SUM(tot_dol),0),1) as rent_pct,
      COUNT(DISTINCT cliente) as clientes,
      ROUND(SUM(kilos_tot),0) as kilos
    FROM sheet_ventas
    WHERE mes_ok IS NOT NULL AND mes_ok != '' AND tot_dol > 0
    GROUP BY mes_ok
    ORDER BY anio, mes
  `).all();
}

export function rentPorProducto(limite) {
  return db.prepare(`
    SELECT producto,
      categoria,
      ROUND(SUM(tot_dol),0) as venta_dol,
      ROUND(SUM(rent_dol),0) as rent_dol,
      ROUND(SUM(rent_dol)*100.0/NULLIF(SUM(tot_dol),0),1) as rent_pct,
      ROUND(SUM(kilos_tot),0) as kilos
    FROM sheet_ventas
    WHERE producto IS NOT NULL AND producto != '' AND tot_dol > 0
    GROUP BY producto
    ORDER BY venta_dol DESC
    LIMIT ?
  `).all(limite || 50);
}

export function rentPorCategoria() {
  return db.prepare(`
    SELECT categoria,
      ROUND(SUM(tot_dol),0) as venta_dol,
      ROUND(SUM(rent_dol),0) as rent_dol,
      ROUND(SUM(rent_dol)*100.0/NULLIF(SUM(tot_dol),0),1) as rent_pct,
      ROUND(SUM(kilos_tot),0) as kilos,
      COUNT(DISTINCT producto) as productos
    FROM sheet_ventas
    WHERE categoria IS NOT NULL AND categoria != '' AND tot_dol > 0
    GROUP BY categoria
    ORDER BY venta_dol DESC
  `).all();
}

export function rentPorCateCliente() {
  return db.prepare(`
    SELECT cate_clie,
      ROUND(SUM(tot_dol),0) as venta_dol,
      ROUND(SUM(rent_dol),0) as rent_dol,
      ROUND(SUM(rent_dol)*100.0/NULLIF(SUM(tot_dol),0),1) as rent_pct,
      COUNT(DISTINCT cliente) as clientes
    FROM sheet_ventas
    WHERE cate_clie IS NOT NULL AND cate_clie != '' AND tot_dol > 0
    GROUP BY cate_clie
    ORDER BY venta_dol DESC
  `).all();
}

export function rentPorVendedor() {
  return db.prepare(`
    SELECT vendedor,
      ROUND(SUM(tot_dol),0) as venta_dol,
      ROUND(SUM(rent_dol),0) as rent_dol,
      ROUND(SUM(rent_dol)*100.0/NULLIF(SUM(tot_dol),0),1) as rent_pct,
      COUNT(DISTINCT cliente) as clientes,
      ROUND(SUM(kilos_tot),0) as kilos
    FROM sheet_ventas
    WHERE vendedor IS NOT NULL AND vendedor != '' AND tot_dol > 0
    GROUP BY vendedor
    ORDER BY venta_dol DESC
  `).all();
}

export function rentPorProveedor(limite) {
  return db.prepare(`
    SELECT proveedor,
      ROUND(SUM(tot_dol),0) as venta_dol,
      ROUND(SUM(rent_dol),0) as rent_dol,
      ROUND(SUM(rent_dol)*100.0/NULLIF(SUM(tot_dol),0),1) as rent_pct,
      ROUND(SUM(kilos_tot),0) as kilos
    FROM sheet_ventas
    WHERE proveedor IS NOT NULL AND proveedor != '' AND tot_dol > 0
    GROUP BY proveedor
    ORDER BY venta_dol DESC
    LIMIT ?
  `).all(limite || 30);
}

export function calendarioEstacional() {
  // Por producto y mes numérico: kilos totales, rent%, valor/kg USD, ventas
  return db.prepare(`
    SELECT
      producto,
      categoria,
      CAST(mes AS INTEGER) as mes_num,
      ROUND(SUM(kilos_tot),0) as kilos,
      ROUND(SUM(rent_dol)*100.0/NULLIF(SUM(tot_dol),0),1) as rent_pct,
      ROUND(SUM(tot_dol)/NULLIF(SUM(kilos_tot),0),2) as valor_kg_dol,
      COUNT(DISTINCT anio) as anios_con_datos
    FROM sheet_ventas
    WHERE producto IS NOT NULL AND producto != ''
      AND mes IS NOT NULL AND mes != ''
      AND kilos_tot > 0 AND tot_dol > 0
    GROUP BY producto, mes_num
    ORDER BY producto, mes_num
  `).all();
}

export function proveedoresPorProductoMes(producto, mes) {
  return db.prepare(`
    SELECT
      proveedor,
      ROUND(SUM(kilos_tot),0) as kilos,
      ROUND(SUM(rent_dol)*100.0/NULLIF(SUM(tot_dol),0),1) as rent_pct,
      ROUND(SUM(tot_dol)/NULLIF(SUM(kilos_tot),0),2) as valor_kg_dol,
      ROUND(SUM(tot_dol),0) as total_dol,
      COUNT(DISTINCT anio) as anios,
      MAX(anio) as ultimo_anio
    FROM sheet_ventas
    WHERE producto = ?
      AND CAST(mes AS INTEGER) = ?
      AND proveedor IS NOT NULL AND proveedor != ''
      AND kilos_tot > 0
    GROUP BY proveedor
    ORDER BY kilos DESC
  `).all(producto, parseInt(mes));
}

export function estadoSync() {
  const compras = db.prepare("SELECT COUNT(*) as n, MAX(sync_fecha) as ultimo FROM sheet_compras").get();
  const ventas  = db.prepare("SELECT COUNT(*) as n, MAX(sync_fecha) as ultimo FROM sheet_ventas").get();
  const log     = db.prepare("SELECT * FROM sheet_sync_log ORDER BY id DESC LIMIT 5").all();
  return { compras, ventas, log };
}
