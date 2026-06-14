// src/servicios/etlClientesSg.js
// ── ETL TEMPORAL #401 Paso 4 — Padrón de CLIENTES (CSV limpio) → sg_clientes ────
// Inserta el padrón precomputado (etlClientesSgPayload.json, 545 clientes, del CSV
// depurado a mano — NO del dump). categoria_abasto → categoria_id resuelto por nombre
// contra sg_cliente_categorias (#430). Guard: aborta si sg_clientes no está vacío.
// TEMPORAL: archivo + router + payload se remueven en un PR de limpieza.

export function getClientesCount(db) {
  return db.prepare('SELECT COUNT(*) n FROM sg_clientes').get().n;
}

export function runEtlClientes(db, payload) {
  // columnas de #430/#428/#429 deben existir (mergeado + deployado)
  const cols = db.prepare('PRAGMA table_info(sg_clientes)').all().map(c => c.name);
  for (const need of ['categoria_id', 'comercial', 'codigo_postal', 'codigo_abasto', 'nombre_comercial']) {
    if (!cols.includes(need)) return { ok: false, abort: 'falta_columna', error: `Falta la columna sg_clientes.${need}. Mergeá y deployá #430 antes de correr.` };
  }
  const ya = getClientesCount(db);
  if (ya) return { ok: false, abort: 'no_vacio', error: `Ya hay ${ya} clientes en sg_clientes. Hacé el /reset primero.` };

  const catMap = new Map(db.prepare('SELECT id, nombre FROM sg_cliente_categorias').all().map(r => [r.nombre, r.id]));
  const sinCategoria = new Set();

  const ins = db.prepare(`INSERT INTO sg_clientes
    (razon_social, nombre_comercial, cuit, categoria_fiscal, direccion_entrega, localidad,
     codigo_postal, telefono, email, comercial, codigo_abasto, categoria_id)
    VALUES (@razon_social, @nombre_comercial, @cuit, @categoria_fiscal, @direccion_entrega, @localidad,
     @codigo_postal, @telefono, @email, @comercial, @codigo_abasto, @categoria_id)`);
  const tx = db.transaction(() => {
    let n = 0;
    for (const c of payload.clientes) {
      let categoria_id = null;
      if (c.categoria) {
        categoria_id = catMap.get(c.categoria) ?? null;
        if (categoria_id === null) sinCategoria.add(c.categoria);
      }
      ins.run({
        razon_social: c.razon_social, nombre_comercial: c.nombre_comercial ?? null,
        cuit: c.cuit ?? null, categoria_fiscal: c.categoria_fiscal ?? null,
        direccion_entrega: c.direccion_entrega ?? null, localidad: c.localidad ?? null,
        codigo_postal: c.codigo_postal ?? null, telefono: c.telefono ?? null,
        email: c.email ?? null, comercial: c.comercial ?? null,
        codigo_abasto: c.codigo_abasto ?? null, categoria_id,
      });
      n++;
    }
    return n;
  });
  const inserted = tx();
  return { ok: true, inserted, count: getClientesCount(db), categorias_sin_match: [...sinCategoria] };
}
