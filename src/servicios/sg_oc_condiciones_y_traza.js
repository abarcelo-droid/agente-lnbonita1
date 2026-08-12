// src/servicios/sg_oc_condiciones_y_traza.js
// Dos arreglos de arranque para las órdenes de compra de San Gerónimo.
import db from './db_sg.js';

// ── 1) LAS CONDICIONES DE PAGO QUE SE USAN ────────────────────────────────
// Las definió el dueño: contado, 30, 30-60, 60 y a coordinar. Son las que se
// negocian de verdad con los productores.
//
// Se AGREGAN las que falten y se apagan las demás — pero sólo las que no esté
// usando ninguna orden. Apagar una que está en uso dejaría órdenes ya cargadas
// apuntando a una condición que no existe más, y el dato con el que se pactó
// esa compra dejaría de poder leerse.
const CONDICIONES = ['Contado', '30 días', '30-60 días', '60 días', 'A coordinar'];

try {
  const hay = (nombre) =>
    db.prepare('SELECT id FROM sg_condiciones_pago WHERE lower(nombre) = lower(?)').get(nombre);
  const insertar = db.prepare(
    'INSERT INTO sg_condiciones_pago (nombre, activo) VALUES (?, 1)');
  const reactivar = db.prepare('UPDATE sg_condiciones_pago SET activo = 1 WHERE id = ?');

  const nuevas = [];
  db.transaction(() => {
    for (const nombre of CONDICIONES) {
      const f = hay(nombre);
      if (f) { reactivar.run(f.id); continue; }
      insertar.run(nombre);
      nuevas.push(nombre);
    }
  })();

  // Las que sobran: se apagan si nadie las usa, y si alguien las usa se avisa.
  const idsBuenas = CONDICIONES.map(n => hay(n)).filter(Boolean).map(f => f.id);
  const sobran = db.prepare(`
    SELECT c.id, c.nombre,
           (SELECT COUNT(*) FROM sg_oc o WHERE o.condicion_pago_id = c.id) AS usos
      FROM sg_condiciones_pago c
     WHERE c.activo = 1 AND c.id NOT IN (${idsBuenas.length ? idsBuenas.join(',') : '0'})`).all();
  const apagadas = [], enUso = [];
  for (const c of sobran) {
    if (c.usos > 0) { enUso.push(`${c.nombre} (${c.usos} orden/es)`); continue; }
    db.prepare('UPDATE sg_condiciones_pago SET activo = 0 WHERE id = ?').run(c.id);
    apagadas.push(c.nombre);
  }
  if (nuevas.length || apagadas.length) {
    console.log(`[SG] Condiciones de pago: ${nuevas.length} agregada(s)` +
                (nuevas.length ? ` (${nuevas.join(', ')})` : '') +
                `, ${apagadas.length} retirada(s)` + (apagadas.length ? ` (${apagadas.join(', ')})` : '') + '.');
  }
  if (enUso.length) {
    console.warn('[SG] Estas condiciones de pago no están en la lista nueva pero SIGUEN ACTIVAS ' +
                 'porque hay órdenes que las usan: ' + enUso.join(', '));
  }
} catch (e) {
  console.error('[SG] Error normalizando las condiciones de pago:', e.message);
}

// ── 2) EL CÓDIGO DE TRAZABILIDAD DE LAS ÓRDENES YA CARGADAS ───────────────
// El código PPPP.DD.MM.AAAA.XX empezó a generarse ahora, así que las órdenes de
// antes no lo tienen — y en pantalla se las identifica con él. Sin esto, las
// viejas se seguirían viendo con el número interno del sistema y convivirían dos
// formas de nombrar lo mismo.
//
// Se recorren POR ORDEN DE CREACIÓN dentro de cada día, que es el mismo criterio
// con el que se numeran las nuevas: la primera del día es la 01.
try {
  const cols = db.prepare('PRAGMA table_info(sg_oc)').all().map(c => c.name);
  if (cols.includes('trazabilidad')) {
    const sinCodigo = db.prepare(`
      SELECT id, proveedor_id, fecha_oc FROM sg_oc
       WHERE (trazabilidad IS NULL OR trazabilidad = '')
       ORDER BY date(fecha_oc), id`).all();

    if (sinCodigo.length) {
      // Cuántas ya tienen código en cada día, para seguir la numeración y no
      // pisar una que ya se generó.
      const yaEnElDia = new Map();
      for (const r of db.prepare(`
        SELECT date(fecha_oc) AS d, COUNT(*) AS n FROM sg_oc
         WHERE trazabilidad IS NOT NULL AND trazabilidad <> '' GROUP BY date(fecha_oc)`).all()) {
        yaEnElDia.set(r.d, r.n);
      }
      const poner = db.prepare('UPDATE sg_oc SET trazabilidad = ? WHERE id = ?');
      let n = 0;
      db.transaction(() => {
        for (const oc of sinCodigo) {
          const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(oc.fecha_oc || ''));
          if (!m) continue;                       // sin fecha no hay código posible
          const dia = `${m[1]}-${m[2]}-${m[3]}`;
          const orden = (yaEnElDia.get(dia) || 0) + 1;
          yaEnElDia.set(dia, orden);
          const prov = String(oc.proveedor_id || 0).padStart(4, '0');
          poner.run(`${prov}.${m[3]}.${m[2]}.${m[1]}.${String(orden).padStart(2, '0')}`, oc.id);
          n++;
        }
      })();
      if (n) console.log(`[SG] Trazabilidad: se le calculó el código a ${n} orden(es) de compra ya cargada(s).`);
      const sinFecha = sinCodigo.length - n;
      if (sinFecha) {
        console.warn(`[SG] ${sinFecha} orden(es) quedaron sin código porque no tienen fecha. ` +
                     'Se las sigue identificando con su número interno.');
      }
    }
  }
} catch (e) {
  console.error('[SG] Error calculando la trazabilidad de las órdenes viejas:', e.message);
}

export default db;
