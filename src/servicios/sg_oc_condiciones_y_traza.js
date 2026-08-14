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
    // LA FECHA DE LA QUE NO TIENE FECHA. Antes, una orden sin fecha_oc se
    // salteaba y quedaba sin partida PARA SIEMPRE: el backfill la volvía a
    // saltear en cada arranque, y cada recepción contra ella seguía generando
    // lotes con el número viejo, en silencio y sin error. Una orden sin partida
    // es una partida que no se puede rastrear, que es justo lo que el código
    // existe para evitar.
    //
    // Se usa la fecha en que se cargó, que es el dato más cercano que hay. Si
    // tampoco está, la de hoy: un código con una fecha aproximada rastrea; sin
    // código no se rastrea nada.
    const sinCodigo = db.prepare(`
      SELECT id, proveedor_id,
             COALESCE(NULLIF(fecha_oc,''), date(creado_en), date('now','localtime')) AS fecha_oc
        FROM sg_oc
       WHERE (trazabilidad IS NULL OR trazabilidad = '')
       ORDER BY date(COALESCE(NULLIF(fecha_oc,''), creado_en)), id`).all();

    // El número que sigue sale del MÁXIMO YA ASIGNADO de cada día, leyendo el
    // propio código. Antes esto contaba filas mientras el alta contaba otra cosa:
    // los dos criterios se desincronizaban y podían asignar el mismo XX a dos
    // órdenes distintas. Ahora los dos leen lo mismo.
    const yaEnElDia = new Map();
    for (const r of db.prepare(
      "SELECT trazabilidad FROM sg_oc WHERE trazabilidad IS NOT NULL AND trazabilidad <> ''").all()) {
      const p = String(r.trazabilidad).split('.');
      if (p.length < 5) continue;
      const dia = `${p[3]}-${p[2]}-${p[1]}`;          // AAAA-MM-DD
      const xx = parseInt(p[4], 10);
      if (isNaN(xx)) continue;
      if (!yaEnElDia.has(dia) || xx > yaEnElDia.get(dia)) yaEnElDia.set(dia, xx);
    }

    if (sinCodigo.length) {
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
        console.warn(`[SG] ${sinFecha} orden(es) siguen sin código: no tienen fecha de orden, ni de carga, ` +
                     'ni se pudo leer la de hoy. Sus lotes van a seguir con el número viejo.');
      }
    }

    // EL CERROJO. La partida identifica toda la vida de la mercadería: desde
    // acá cuelgan los lotes, y dos órdenes con el mismo código sería el mismo
    // lote para dos compras distintas. El índice único lo hace imposible.
    //
    // Si en la base ya hay repetidos (los había: dos contadores distintos), no
    // se puede crear el índice. En vez de fallar en silencio se los renumera:
    // el primero por id se queda con el código y a los demás se les da el
    // siguiente libre de ese día.
    try {
      const dup = db.prepare(`
        SELECT trazabilidad, COUNT(*) c FROM sg_oc
         WHERE trazabilidad IS NOT NULL AND trazabilidad <> ''
         GROUP BY trazabilidad HAVING c > 1`).all();
      if (dup.length) {
        const arreglar = db.prepare('UPDATE sg_oc SET trazabilidad = ? WHERE id = ?');
        let renumeradas = 0;
        db.transaction(() => {
          for (const d of dup) {
            const filas = db.prepare(
              'SELECT id, proveedor_id, trazabilidad FROM sg_oc WHERE trazabilidad = ? ORDER BY id').all(d.trazabilidad);
            const p = String(d.trazabilidad).split('.');
            const dia = `${p[3]}-${p[2]}-${p[1]}`;
            for (let i = 1; i < filas.length; i++) {          // el primero se queda como está
              let siguiente = (yaEnElDia.get(dia) || 0) + 1;
              yaEnElDia.set(dia, siguiente);
              const prov = String(filas[i].proveedor_id || 0).padStart(4, '0');
              arreglar.run(`${prov}.${p[1]}.${p[2]}.${p[3]}.${String(siguiente).padStart(2, '0')}`, filas[i].id);
              renumeradas++;
            }
          }
        })();
        console.warn(`[SG] Había ${dup.length} código(s) de partida repetido(s): se renumeraron ${renumeradas} orden(es).`);
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sg_oc_trazabilidad_unica ON sg_oc(trazabilidad) WHERE trazabilidad IS NOT NULL AND trazabilidad <> \'\'');
    } catch (e) {
      console.error('[SG] No se pudo poner el cerrojo de partida única:', e.message);
    }
  }
} catch (e) {
  console.error('[SG] Error calculando la trazabilidad de las órdenes viejas:', e.message);
}

// ── 3) LOS LOTES SE LLAMAN COMO SU PARTIDA ────────────────────────────────
// La regla es que la partida se identifica con el número de la orden de compra y
// con nada más. Pero quedaron lotes con el número viejo (SG-LT-AAAAMMDD-NNNN) y
// se ven al lado de la partida, como si fueran dos identidades de lo mismo:
//
//   - todos los lotes cargados antes de que existiera el código de partida;
//   - los de las compras retroactivas, que nacían sin partida en la orden (el
//     alta no la asignaba) y por eso caían al numerador viejo. Después este
//     mismo archivo le ponía la partida a la orden, y el lote quedaba huérfano.
//
// Se renumeran acá y no en una migración aparte porque tiene que correr DESPUÉS
// del bloque 2: primero la orden tiene que tener su partida.
//
// SE PUEDE RENUMERAR SIN ROMPER NADA: codigo_lote existe en una sola columna de
// una sola tabla (sg_lotes.codigo_lote, TEXT NOT NULL UNIQUE). Todo lo demás
// —despachos, gastos, decomisos, transformaciones, reprocesos, PDFs— lo lee con
// un JOIN por lote_id, así que pasan a mostrar el código nuevo solos. No hay
// ninguna tabla que guarde el código copiado como texto.
//
// El dígito final cuenta los lotes de la orden POR id, que es el mismo criterio
// que usa codigoLoteDePartida() al crearlos: el primero que entró es el .1.
try {
  const colsOc = db.prepare('PRAGMA table_info(sg_oc)').all().map(c => c.name);
  if (colsOc.includes('trazabilidad')) {
    // Los que cuelgan de una orden CON partida y no se llaman como ella. Un lote
    // sin orden (apertura de inventario, reproceso, transformación, importación,
    // recepción sin OC todavía) no tiene partida de la cual colgar: no se toca.
    const desalineados = db.prepare(`
      SELECT l.id, l.codigo_lote, o.id AS oc_id, o.trazabilidad
        FROM sg_lotes l
        JOIN sg_oc_items i ON i.id = l.oc_item_id
        JOIN sg_oc o ON o.id = i.oc_id
       WHERE o.trazabilidad IS NOT NULL AND o.trazabilidad <> ''
         AND l.codigo_lote NOT LIKE o.trazabilidad || '.%'
       ORDER BY o.id, l.id`).all();

    if (desalineados.length) {
      const ocupado = db.prepare('SELECT 1 FROM sg_lotes WHERE codigo_lote = ? AND id <> ?');
      const renombrar = db.prepare('UPDATE sg_lotes SET codigo_lote = ? WHERE id = ?');
      // Por orden: el orden de los lotes de cada una decide el dígito.
      const porOc = new Map();
      for (const l of desalineados) {
        if (!porOc.has(l.oc_id)) porOc.set(l.oc_id, []);
        porOc.get(l.oc_id).push(l);
      }
      let n = 0, trabados = 0;
      db.transaction(() => {
        for (const [ocId, lotes] of porOc) {
          const traza = lotes[0].trazabilidad;
          // Todos los lotes de la orden, no sólo los desalineados: si alguno ya
          // se llama .1, el que se renumera tiene que ser el .2.
          const todos = db.prepare(`SELECT l.id, l.codigo_lote FROM sg_lotes l
             JOIN sg_oc_items i ON i.id = l.oc_item_id
            WHERE i.oc_id = ? ORDER BY l.id`).all(ocId);
          let d = 0;
          for (const l of todos) {
            d++;
            const nuevo = `${traza}.${d}`;
            if (l.codigo_lote === nuevo) continue;              // ya estaba bien
            // codigo_lote es UNIQUE. Si el número que toca lo tiene otro lote
            // —de otra orden, por un código repetido de antes— se saltea en vez
            // de reventar el arranque entero del servidor.
            if (ocupado.get(nuevo, l.id)) { trabados++; continue; }
            renombrar.run(nuevo, l.id);
            n++;
          }
        }
      })();
      if (n) console.log(`[SG] Partida: se renumeraron ${n} lote(s) para que se llamen como su orden de compra.`);
      if (trabados) {
        console.warn(`[SG] ${trabados} lote(s) no se pudieron renumerar porque el código que les tocaba ` +
                     'ya lo tenía otro lote. Conservan el suyo.');
      }
    }
  }
} catch (e) {
  console.error('[SG] Error alineando los códigos de lote con su partida:', e.message);
}

export default db;
