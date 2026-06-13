// src/servicios/etlProveedoresSg.js
// ── ETL TEMPORAL #401 — Padrón de PROVEEDORES (CSV limpio) → sg_proveedores ─────
// Inserta el padrón precomputado (etlProveedoresSgPayload.json, 701 proveedores,
// leído del CSV limpio a mano — NO del dump). Validado por dry-run.
// Mapeo: CUIT inválido→NULL, categoria_fiscal, origen, comision_pct, Direccion/CodPostal
// a las columnas de #424, y CATEGORIA → categoria_id resuelto por nombre contra
// sg_proveedor_categorias (#424). NO toca sg_clientes ni nada más.
// Guard: aborta si sg_proveedores no está vacío (forzar reset antes). 1 transacción.
// TEMPORAL: este archivo + router + payload se remueven en un PR de limpieza.

export function getProveedoresCount(db) {
  return db.prepare('SELECT COUNT(*) n FROM sg_proveedores').get().n;
}

export function runEtlProveedores(db, payload) {
  // columnas de #424 deben existir (mergeado + deployado)
  const cols = db.prepare('PRAGMA table_info(sg_proveedores)').all().map(c => c.name);
  for (const need of ['direccion', 'codigo_postal', 'categoria_id']) {
    if (!cols.includes(need)) return { ok: false, abort: 'falta_columna', error: `Falta la columna sg_proveedores.${need}. Mergeá y deployá #424 antes de correr.` };
  }
  // guard: catálogo vacío (forzar reset antes → evita doble inserción)
  const ya = getProveedoresCount(db);
  if (ya) return { ok: false, abort: 'no_vacio', error: `Ya hay ${ya} proveedores en sg_proveedores. Hacé el /reset primero.` };

  // CATEGORIA (texto) → categoria_id por nombre contra sg_proveedor_categorias
  const catMap = new Map(db.prepare('SELECT id, nombre FROM sg_proveedor_categorias').all().map(r => [r.nombre, r.id]));
  const sinCategoria = new Set();

  const ins = db.prepare(`INSERT INTO sg_proveedores
    (razon_social, cuit, categoria_fiscal, origen, comision_pct,
     localidad, provincia, telefono, email, direccion, codigo_postal, categoria_id)
    VALUES (@razon_social, @cuit, @categoria_fiscal, @origen, @comision_pct,
     @localidad, @provincia, @telefono, @email, @direccion, @codigo_postal, @categoria_id)`);
  const tx = db.transaction(() => {
    let n = 0;
    for (const p of payload.proveedores) {
      let categoria_id = null;
      if (p.categoria) {
        categoria_id = catMap.get(p.categoria) ?? null;
        if (categoria_id === null) sinCategoria.add(p.categoria);
      }
      ins.run({
        razon_social: p.razon_social, cuit: p.cuit ?? null,
        categoria_fiscal: p.categoria_fiscal ?? null, origen: p.origen || 'nacional',
        comision_pct: p.comision_pct ?? null, localidad: p.localidad ?? null,
        provincia: p.provincia ?? null, telefono: p.telefono ?? null, email: p.email ?? null,
        direccion: p.direccion ?? null, codigo_postal: p.codigo_postal ?? null, categoria_id,
      });
      n++;
    }
    return n;
  });
  const inserted = tx();
  return { ok: true, inserted, count: getProveedoresCount(db), categorias_sin_match: [...sinCategoria] };
}
