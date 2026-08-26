// ══ RESCATE DE LOS EMBARQUES BORRADOS ══════════════════════════════════════════════════
//
// El 26/8/2026 un borrado de datos de prueba se llevó puestos ONCE EMBARQUES REALES que no
// estaban en su alcance. De un respaldo del archivo se rescataron los renglones —producto,
// envase, kilos por bulto, cajas y precio FOB— leyendo las páginas que SQLite había marcado
// como libres pero todavía no había pisado.
//
// LAS CABECERAS NO SE PUDIERON RESCATAR: nombre, proveedor, país, incoterm, fechas, tipo de
// cambio y costos. Esas filas ya estaban escritas encima. Así que esto NO devuelve los
// embarques como estaban: devuelve el CONTENIDO —que es lo caro de volver a tipear— dentro
// de una cabecera vacía marcada «(recuperado)» para completar a mano.
//
// Vive acá y no adentro del router para que el test lo CORRA de verdad contra el esquema
// real, con las claves foráneas encendidas. Un rescate que se prueba mirando el código es
// un rescate que se prueba el día que hace falta.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const RESCATE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'sg_embarques_rescate.json'), 'utf8'));

const lineasDe = (id) => RESCATE.lineas.filter((l) => l.embarque_id === id);

// QUÉ HAY PARA RECUPERAR Y QUÉ YA ESTÁ. Se mira por número de embarque: si ese número
// existe hoy, no se toca — ni se duplica ni se pisa.
export function estadoRescate(db) {
  const hay = db.prepare('SELECT id FROM sg_embarques WHERE id=?');
  const prod = db.prepare('SELECT nombre FROM sg_productos WHERE id=?');
  return RESCATE.embarques.map((e) => ({
    id: e.id,
    cajas: e.cantidad_cajas,
    renglones: lineasDe(e.id).length,
    creado_en: e.creado_en,
    ya_esta: hay.get(e.id) ? 1 : 0,
    productos: lineasDe(e.id).map((l) => {
      const p = prod.get(l.producto_id);
      return (p ? p.nombre : '#' + l.producto_id) + ' · ' + l.cajas + ' cajas'
        + (l.precio_unitario_usd == null ? '' : ' · USD ' + l.precio_unitario_usd);
    }),
  }));
}

// Se conserva el NÚMERO original de cada embarque: es como están anotados afuera, y los
// documentos que siguen en el disco cuelgan de ese número.
//
// Todo en UNA transacción: o entran los once o no entra ninguno. Un rescate a medias deja
// sin saber qué falta, que es peor que no haber empezado.
export function restaurar(db, usuarioId) {
  const hay = db.prepare('SELECT id FROM sg_embarques WHERE id=?');
  const insEmb = db.prepare(`INSERT INTO sg_embarques
    (id, nombre, moneda, estado, cantidad_cajas, observaciones, activo, creado_en, creado_por)
    VALUES (?,?,'USD','cotizacion',?,?,1,?,?)`);
  const insLin = db.prepare(`INSERT INTO sg_embarque_lineas
    (embarque_id, producto_id, envase_id, kg_por_bulto, cajas, precio_unitario_usd, creado_en, creado_por)
    VALUES (?,?,?,?,?,?,?,?)`);
  const NOTA = 'Recuperado del respaldo del 26/08/2026. Los renglones son los originales; '
    + 'faltan proveedor, país, incoterm, fechas, tipo de cambio y costos.';

  const puestos = [];
  db.exec('BEGIN');
  try {
    for (const e of RESCATE.embarques) {
      if (hay.get(e.id)) continue;
      insEmb.run(e.id, 'Embarque ' + e.id + ' (recuperado)', e.cantidad_cajas,
        NOTA, e.creado_en, usuarioId ?? null);
      let n = 0;
      for (const l of lineasDe(e.id)) {
        insLin.run(e.id, l.producto_id, l.envase_id, l.kg_por_bulto, l.cajas,
          l.precio_unitario_usd, l.creado_en, usuarioId ?? null);
        n++;
      }
      puestos.push({ id: e.id, renglones: n, cajas: e.cantidad_cajas });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { puestos, total: puestos.length };
}
