// src/servicios/etlProveedoresSg.js
// ── ETL TEMPORAL #401 — Padrón de PROVEEDORES ABASTO → sg_proveedores ──────────
// Inserta el padrón precomputado (etlProveedoresSgPayload.json, 955 proveedores).
// El parseo/encoding/mapeo del dump se hizo OFFLINE y se validó por dry-run.
// Mapeo: CUIT inválido→NULL, categoria_fiscal de CatIVA, origen de Nacional,
// trabaja_consignacion/comision_pct de liquido/PorcLiquido, Direccion/CodPostal a las
// columnas nuevas (#421). NO toca sg_clientes ni nada más.
// Guard: aborta si sg_proveedores no está vacío (forzar reset antes). 1 transacción.
// TEMPORAL: este archivo + router + payload se remueven en un PR de limpieza.

export function getProveedoresCount(db) {
  return db.prepare('SELECT COUNT(*) n FROM sg_proveedores').get().n;
}

export function runEtlProveedores(db, payload) {
  // columnas de #421 deben existir (mergeado + deployado)
  const cols = db.prepare('PRAGMA table_info(sg_proveedores)').all().map(c => c.name);
  for (const need of ['direccion', 'codigo_postal']) {
    if (!cols.includes(need)) return { ok: false, abort: 'falta_columna', error: `Falta la columna sg_proveedores.${need}. Mergeá y deployá #421 antes de correr.` };
  }
  // guard: catálogo vacío (forzar reset antes → evita doble inserción)
  const ya = getProveedoresCount(db);
  if (ya) return { ok: false, abort: 'no_vacio', error: `Ya hay ${ya} proveedores en sg_proveedores. Hacé el /reset primero.` };

  const ins = db.prepare(`INSERT INTO sg_proveedores
    (razon_social, cuit, categoria_fiscal, origen, trabaja_consignacion, comision_pct,
     localidad, provincia, telefono, email, direccion, codigo_postal)
    VALUES (@razon_social, @cuit, @categoria_fiscal, @origen, @trabaja_consignacion, @comision_pct,
     @localidad, @provincia, @telefono, @email, @direccion, @codigo_postal)`);
  const tx = db.transaction(() => {
    let n = 0;
    for (const p of payload.proveedores) { ins.run(p); n++; }
    return n;
  });
  const inserted = tx();
  return { ok: true, inserted, count: getProveedoresCount(db) };
}
