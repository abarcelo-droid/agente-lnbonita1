// src/servicios/etlAbastoSg.js
// ── ETL TEMPORAL #401 — Taxonomía + Artículos ABASTO → sg_* ──────────────────
// Inserta el catálogo precomputado (etlAbastoSgPayload.json) en las tablas sg_*.
// El parseo/encoding/colapso del dump (231MB) se hizo OFFLINE y validado por dry-run;
// acá solo se INSERTA el modelo ya resuelto. Driven por CÓDIGOS (no ids) → portable.
//
// Guards (los mismos del dry-run):
//   - aborta si ya hay especies/productos cargados (evita doble inserción).
//   - guard FK: aborta si las familias seed (codigo 1..5) están referenciadas.
// Todo en UNA transacción. iva_alicuota de las 17 familias queda NULL (decidido).
//
// TEMPORAL: este archivo + el router + el payload se remueven una vez verificado (#401).

export function getCounts(db) {
  const c = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  return {
    familias: c('sg_familias'),
    especies: c('sg_especies'),
    variedades: c('sg_variedades'),
    envases: c('sg_envases'),
    productos: c('sg_productos'),
    presentaciones: c('sg_presentaciones'),
  };
}

export function runEtl(db, payload) {
  // ── GUARD 1: catálogo debe estar vacío (especies/productos) ──
  const yaEsp = db.prepare('SELECT COUNT(*) n FROM sg_especies').get().n;
  const yaProd = db.prepare('SELECT COUNT(*) n FROM sg_productos').get().n;
  if (yaEsp || yaProd) {
    return { ok: false, abort: 'catalogo_no_vacio', error: `Ya hay ${yaEsp} especies y ${yaProd} productos en sg_*. El ETL asume catálogo vacío.` };
  }
  // ── GUARD 2: FK de familias seed (codigo 1..5) no referenciadas ──
  const seedIds = db.prepare('SELECT id FROM sg_familias WHERE codigo IN (1,2,3,4,5)').all().map(r => r.id);
  if (seedIds.length) {
    const ph = seedIds.map(() => '?').join(',');
    const depEsp = db.prepare(`SELECT COUNT(*) n FROM sg_especies  WHERE familia_id IN (${ph})`).get(...seedIds).n;
    const depProd = db.prepare(`SELECT COUNT(*) n FROM sg_productos WHERE familia_id IN (${ph})`).get(...seedIds).n;
    if (depEsp || depProd) {
      return { ok: false, abort: 'fk_seed_referenciado', error: `Seed de familias (1..5) referenciado por ${depEsp} especies y ${depProd} productos. No se reemplaza.` };
    }
  }

  const tx = db.transaction(() => {
    // 1) familias: borrar seed de 5 → insertar las 17 (iva_alicuota queda NULL)
    db.prepare('DELETE FROM sg_familias WHERE codigo IN (1,2,3,4,5)').run();
    const insFam = db.prepare('INSERT INTO sg_familias (codigo, nombre) VALUES (?,?)');
    const famId = new Map(); // familiaCodigo → id
    for (const f of payload.familias) famId.set(f.codigo, insFam.run(f.codigo, f.nombre).lastInsertRowid);

    // 2) especies
    const insEsp = db.prepare('INSERT INTO sg_especies (familia_id, codigo, nombre) VALUES (?,?,?)');
    const espId = new Map(); // `${familiaCodigo}.${especieCodigo}` → id
    for (const e of payload.especies) espId.set(`${e.familiaCodigo}.${e.codigo}`, insEsp.run(famId.get(e.familiaCodigo), e.codigo, e.nombre).lastInsertRowid);

    // 3) variedades
    const insVar = db.prepare('INSERT INTO sg_variedades (especie_id, codigo, nombre) VALUES (?,?,?)');
    const varId = new Map(); // `${familiaCodigo}.${especieCodigo}.${variedadCodigo}` → id
    for (const v of payload.variedades) {
      const eid = espId.get(`${v.familiaCodigo}.${v.especieCodigo}`);
      varId.set(`${v.familiaCodigo}.${v.especieCodigo}.${v.codigo}`, insVar.run(eid, v.codigo, v.nombre).lastInsertRowid);
    }

    // 4) envases base (INSERT OR IGNORE; el seed ya trae 8 por UNIQUE(nombre))
    const insEnv = db.prepare('INSERT OR IGNORE INTO sg_envases (nombre) VALUES (?)');
    for (const nombre of payload.envases) insEnv.run(nombre);
    const envId = new Map(db.prepare('SELECT id, nombre FROM sg_envases').all().map(r => [r.nombre, r.id]));

    // 5) productos + 6) presentaciones
    const insProd = db.prepare(`INSERT INTO sg_productos
      (codigo, familia_id, especie_id, variedad_id, nombre, variedad, familia, unidad_base, codigo_abasto, ean)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const insPres = db.prepare('INSERT INTO sg_presentaciones (producto_id, nombre, factor_conversion, envase_id) VALUES (?,?,?,?)');
    let nProd = 0, nPres = 0;
    for (const p of payload.productos) {
      const especie_id = espId.get(`${p.familiaCodigo}.${p.especieCodigo}`);
      const variedad_id = p.variedadCodigo ? varId.get(`${p.familiaCodigo}.${p.especieCodigo}.${p.variedadCodigo}`) : null;
      const pid = insProd.run(p.codigo, famId.get(p.familiaCodigo), especie_id, variedad_id,
        p.nombre, p.variedad ?? null, p.familia, p.unidad_base || 'kg', p.codigo_abasto ?? null, p.ean ?? null).lastInsertRowid;
      nProd++;
      for (const pr of p.presentaciones) {
        insPres.run(pid, pr.nombre, pr.factor_conversion, envId.get(pr.envase) ?? null);
        nPres++;
      }
    }
    return { nFam: famId.size, nEsp: espId.size, nVar: varId.size, nEnv: envId.size, nProd, nPres };
  });

  const r = tx();
  return { ok: true, inserted: r, counts: getCounts(db) };
}
