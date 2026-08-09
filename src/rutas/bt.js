// src/rutas/bt.js
// ── BARCELÓ TRANSPORTE · API del espejo de Transoft ───────────────────────
// Montado en /api/bt. Solo toca tablas bt_*.
//
// AISLAMIENTO: además del prefijo propio, este router EXIGE que la empresa activa
// sea Barceló Transporte. Es el pedido explícito del dueño —que nada de BT se
// mezcle con las otras dos empresas— y la única forma de que el selector de
// empresa DEFINA algo: hoy ese selector filtra lo que se ve en el menú desde el
// navegador y no viaja al servidor, o sea que no protege nada.
//
// EL ERP NO ESCRIBE EN TRANSOFT. Acá no hay ni una línea que apunte a los .dbf:
// los datos llegan porque un agente que corre EN el servidor de Transoft los lee y
// los empuja a POST /sync. La regla de oro no depende de que nadie se equivoque,
// depende de que el camino de vuelta no exista.

import express from 'express';
import db from '../servicios/db_bt.js';   // este import crea el schema bt_tr_* (espejo)
import '../servicios/db_bt_op.js';       // y este el modelo operativo bt_*

const router = express.Router();

router.use((req, res, next) => {
  try {
    const c = req.cookies?.lnb_user;
    if (c) req.user = JSON.parse(c);
  } catch (_) { /* cookie corrupta: no autenticado */ }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user || !req.user.id) return res.status(401).json({ ok: false, error: 'No autenticado' });
  next();
}
router.use(requireAuth);

// ── LA EMPRESA ACTIVA DEFINE ──────────────────────────────────────────────
let _btId = null;
function sociedadBT() {
  if (_btId) return _btId;
  const r = db.prepare("SELECT id FROM sociedades WHERE nombre LIKE 'Barcel%Transporte%'").get();
  _btId = r ? r.id : null;
  return _btId;
}

// El panel manda la empresa elegida en el selector. Si viene otra, este módulo no
// contesta: es preferible un error claro a mostrarle a alguien datos de una empresa
// en la que cree no estar parado.
function soloBT(req, res, next) {
  const bt = sociedadBT();
  const raw = req.query?.sociedad_id ?? req.body?.sociedad_id;
  if (raw !== undefined && raw !== null && raw !== '') {
    if (parseInt(raw, 10) !== bt) {
      return res.status(403).json({
        ok: false, error: 'Este módulo es de Barceló Transporte. Cambiá la empresa en el selector.'
      });
    }
  }
  req.sociedadBT = bt;
  next();
}
router.use(soloBT);

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const wrap = (fn) => (req, res) => {
  try { fn(req, res); }
  catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
};
const esAdmin = (req) => req.user?.rol === 'admin';

// ══════════════════════════════════════════════════════════════════════════
// SINCRONIZACIÓN — lo que empuja el agente del servidor
// ══════════════════════════════════════════════════════════════════════════

// El mapa de qué se puede importar. Es una WHITELIST a propósito: el agente manda
// el nombre de la tabla y sin esta lista bastaría un nombre inventado para escribir
// donde no corresponde. Cada entrada declara además su clave, que es lo que hace
// que reimportar actualice en vez de duplicar.
const TABLAS = {
  viajes:       { tabla: 'bt_tr_viajes',       clave: ['filial', 'nrovia'] },
  cargas:       { tabla: 'bt_tr_cargas',       clave: ['filial', 'nrocar'] },
  carga_viaje:  { tabla: 'bt_tr_carga_viaje',  clave: ['cargasuc', 'carganro', 'renglon', 'viajesuc', 'viajenro', 'rengvia'] },
  valor_carga:  { tabla: 'bt_tr_valor_carga',  clave: ['cargasuc', 'carganro', 'renglon'] },
  valor_viaje:  { tabla: 'bt_tr_valor_viaje',  clave: ['viajesuc', 'viajenro', 'renglon'] },
  documentos:   { tabla: 'bt_tr_documentos',   clave: ['cargasuc', 'carganro', 'renglon'] },
  ordenes:      { tabla: 'bt_tr_ordenes',      clave: ['tiporden', 'nroorden'] },
  fojas:        { tabla: 'bt_tr_fojas',        clave: ['fojasuc', 'fojanro'] },
  clientes:     { tabla: 'bt_tr_clientes',     clave: ['codsuc', 'fichanro'] },
  choferes:     { tabla: 'bt_tr_choferes',     clave: ['codsuc', 'cuenta'] },
  unidades:     { tabla: 'bt_tr_unidades',     clave: ['tipuni', 'unidad'] },
  localidades:  { tabla: 'bt_tr_localidades',  clave: ['localidad'] },
  provincias:   { tabla: 'bt_tr_provincias',   clave: ['provincia'] },
  catalogos:    { tabla: 'bt_tr_catalogos',    clave: ['catalogo', 'codigo'] },
};

// Las columnas reales de cada tabla, para descartar lo que el agente mande de más.
// Transoft tiene decenas de campos de auditoría por fila y no tiene sentido
// espejarlos todos; el agente manda lo que sabe y acá se guarda lo que existe.
const columnasDe = (tabla) =>
  db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name);

router.post('/sync', wrap((req, res) => {
  if (!esAdmin(req)) return res.status(403).json({ ok: false, error: 'Solo un administrador puede sincronizar' });

  const clave = String(req.body?.tabla || '');
  const def = TABLAS[clave];
  if (!def) throw bad('Tabla desconocida: ' + clave + '. Válidas: ' + Object.keys(TABLAS).join(', '));

  const filas = Array.isArray(req.body?.filas) ? req.body.filas : null;
  if (!filas) throw bad('Falta la lista de filas');
  if (filas.length > 5000) throw bad(`Son ${filas.length} filas y el máximo por tanda es 5000.`);

  // El lote agrupa una corrida completa del agente. Se abre en la primera tanda y
  // se cierra al final: así se puede contestar "¿de cuándo son estos datos?" y
  // detectar un agente que dejó de correr.
  let loteId = parseInt(req.body?.lote_id, 10) || null;
  if (!loteId) {
    loteId = db.prepare(`INSERT INTO bt_tr_sync_lotes (origen, usuario_id) VALUES (?,?)`)
      .run(String(req.body?.origen || 'desconocido').slice(0, 120), req.user.id).lastInsertRowid;
  }

  const cols = columnasDe(def.tabla);
  const usables = cols.filter(c => c !== 'sincronizado_en' && c !== 'origen_lote');
  const lista = [...usables, 'sincronizado_en', 'origen_lote'];

  // UPSERT por la clave natural de Transoft: el agente puede reenviar la misma
  // ventana de datos las veces que haga falta sin duplicar ni una fila. Es lo que
  // permite que la sincronización sea "mandá todo de nuevo" en vez de tener que
  // llevar la cuenta de qué se mandó, que es donde estas cosas se rompen.
  const sql = `INSERT INTO ${def.tabla} (${lista.map(c => '"' + c + '"').join(',')})
     VALUES (${usables.map(c => '@' + c).join(',')}, datetime('now','localtime'), @__lote)
     ON CONFLICT(${def.clave.map(c => '"' + c + '"').join(',')}) DO UPDATE SET
       ${usables.filter(c => !def.clave.includes(c)).map(c => `"${c}"=excluded."${c}"`).join(', ')},
       sincronizado_en = excluded.sincronizado_en, origen_lote = excluded.origen_lote`;
  const ins = db.prepare(sql);

  let escritas = 0;
  const errores = [];
  db.transaction(() => {
    filas.forEach((f, i) => {
      const fila = { __lote: loteId };
      for (const c of usables) {
        let v = f[c];
        if (v === undefined) v = null;
        // Los lógicos de FoxPro llegan como true/false y SQLite guarda enteros.
        if (v === true) v = 1;
        if (v === false) v = 0;
        fila[c] = v;
      }
      try { ins.run(fila); escritas++; }
      catch (e) { if (errores.length < 20) errores.push({ fila: i + 1, error: e.message }); }
    });
    db.prepare(`UPDATE bt_tr_sync_lotes SET filas_total = filas_total + ? WHERE id = ?`).run(escritas, loteId);
  })();

  res.json({ ok: true, lote_id: loteId, recibidas: filas.length, escritas, errores });
}));

// Cierra el lote. El agente lo llama al terminar; si nunca llega, el lote queda
// 'en_curso' y eso mismo es la señal de que la corrida se cortó a la mitad.
router.post('/sync/cerrar', wrap((req, res) => {
  if (!esAdmin(req)) return res.status(403).json({ ok: false, error: 'Solo un administrador puede sincronizar' });
  const id = parseInt(req.body?.lote_id, 10);
  if (!id) throw bad('Falta lote_id');
  const err = req.body?.error ? String(req.body.error).slice(0, 2000) : null;
  db.prepare(`UPDATE bt_tr_sync_lotes SET terminado_en = datetime('now','localtime'),
     estado = ?, tablas = ?, error = ? WHERE id = ?`)
    .run(err ? 'error' : 'ok', JSON.stringify(req.body?.tablas || {}), err, id);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════════════════
// LECTURA
// ══════════════════════════════════════════════════════════════════════════

// De cuándo son los datos. Es lo primero que hay que poder contestar: sin esto, un
// agente caído hace tres días muestra sus números como si fueran de hoy.
router.get('/estado', wrap((req, res) => {
  const conteo = {};
  for (const [k, d] of Object.entries(TABLAS)) {
    const r = db.prepare(`SELECT COUNT(*) n, MAX(sincronizado_en) ult FROM ${d.tabla}`).get();
    conteo[k] = { filas: r.n, ultima_sync: r.ult };
  }
  const lote = db.prepare('SELECT * FROM bt_tr_sync_lotes ORDER BY id DESC LIMIT 1').get() || null;
  res.json({ ok: true, data: { tablas: conteo, ultimo_lote: lote } });
}));

// Los viajes, con lo que se cobró y lo que costó ya sumado. La rentabilidad se
// calcula acá y no en el front: es LA cuenta del módulo y tiene que salir de un
// solo lugar.
router.get('/viajes', wrap((req, res) => {
  const cond = ['v.anulado = 0'];
  const args = {};
  if (req.query.desde) { cond.push('v.fecviaje >= @desde'); args.desde = String(req.query.desde); }
  if (req.query.hasta) { cond.push('v.fecviaje <= @hasta'); args.hasta = String(req.query.hasta); }
  if (req.query.estado) { cond.push('v.estado = @estado'); args.estado = String(req.query.estado); }
  if (req.query.q) {
    cond.push(`(v.camion LIKE @q OR v.chresum LIKE @q OR v.origen LIKE @q OR v.destino LIKE @q
                OR CAST(v.nrovia AS TEXT) LIKE @q)`);
    args.q = '%' + String(req.query.q) + '%';
  }
  const filas = db.prepare(`
    SELECT v.*,
           u.patente AS camion_patente, u.descrip AS camion_descrip,
           ch.nombre AS chofer_nombre,
           (SELECT COUNT(*) FROM bt_tr_carga_viaje cv
             WHERE cv.viajesuc = v.filial AND cv.viajenro = v.nrovia AND cv.anulado = 0) AS cant_cargas,
           (SELECT IFNULL(SUM(vv.importe),0) FROM bt_tr_valor_viaje vv
             WHERE vv.viajesuc = v.filial AND vv.viajenro = v.nrovia AND vv.anulado = 0) AS costo,
           -- Lo cobrado del viaje es la suma de lo cobrado de SUS cargas. Se pasa
           -- por el puente porque una carga puede ir en varios viajes.
           (SELECT IFNULL(SUM(vc.importe),0) FROM bt_tr_valor_carga vc
             WHERE vc.anulado = 0 AND EXISTS (
               SELECT 1 FROM bt_tr_carga_viaje cv
                WHERE cv.viajesuc = v.filial AND cv.viajenro = v.nrovia AND cv.anulado = 0
                  AND cv.cargasuc = vc.cargasuc AND cv.carganro = vc.carganro)) AS cobrado
      FROM bt_tr_viajes v
      LEFT JOIN bt_tr_unidades u  ON u.tipuni = 'C' AND u.unidad = v.camion
      LEFT JOIN bt_tr_choferes ch ON ch.cuenta = v.chresum
     WHERE ${cond.join(' AND ')}
     ORDER BY v.fecviaje DESC, v.nrovia DESC
     LIMIT 300`).all(args);
  filas.forEach(f => { f.rentabilidad = Math.round(((f.cobrado || 0) - (f.costo || 0)) * 100) / 100; });
  const tot = db.prepare(`SELECT COUNT(*) n FROM bt_tr_viajes v WHERE ${cond.join(' AND ')}`).get(args);
  res.json({ ok: true, data: filas, total: tot.n, tope: 300 });
}));

// Un viaje con todo lo que cuelga: sus cargas, lo que costó y lo que se cobró.
router.get('/viajes/:filial/:nro', wrap((req, res) => {
  const filial = String(req.params.filial), nro = parseInt(req.params.nro, 10);
  const v = db.prepare('SELECT * FROM bt_tr_viajes WHERE filial = ? AND nrovia = ?').get(filial, nro);
  if (!v) return res.status(404).json({ ok: false, error: 'Viaje no encontrado' });

  const cargas = db.prepare(`
    SELECT cv.*, c.fechaing, c.tipocarga, c.origen AS c_origen, c.destino AS c_destino,
           c.m3 AS c_m3, c.kg AS c_kg, c.bultos AS c_bultos, c.impflete, c.estado AS c_estado,
           cli.resum AS cliente, cli.razsocc AS cliente_razon,
           rem.resum AS remitente, des.resum AS destinatario
      FROM bt_tr_carga_viaje cv
      LEFT JOIN bt_tr_cargas   c   ON c.filial = cv.cargasuc AND c.nrocar = cv.carganro
      LEFT JOIN bt_tr_clientes cli ON cli.codsuc = c.clisuc AND cli.fichanro = c.clinro
      LEFT JOIN bt_tr_clientes rem ON rem.codsuc = c.remsuc AND rem.fichanro = c.remnro
      LEFT JOIN bt_tr_clientes des ON des.codsuc = c.dessuc AND des.fichanro = c.desnro
     WHERE cv.viajesuc = ? AND cv.viajenro = ? AND cv.anulado = 0
     ORDER BY cv.rengvia, cv.carganro`).all(filial, nro);

  const costos = db.prepare(`SELECT * FROM bt_tr_valor_viaje
     WHERE viajesuc = ? AND viajenro = ? AND anulado = 0 ORDER BY renglon`).all(filial, nro);

  // Lo cobrado, desglosado por carga: es la única forma de ver de dónde sale el
  // ingreso cuando un viaje lleva ocho cargas de clientes distintos.
  const cobros = cargas.length ? db.prepare(`
    SELECT vc.* FROM bt_tr_valor_carga vc WHERE vc.anulado = 0 AND (${
      cargas.map(() => '(vc.cargasuc = ? AND vc.carganro = ?)').join(' OR ')})`)
    .all(...cargas.flatMap(c => [c.cargasuc, c.carganro])) : [];

  const suma = (a, k) => Math.round(a.reduce((s, x) => s + (Number(x[k]) || 0), 0) * 100) / 100;
  const costo = suma(costos, 'importe'), cobrado = suma(cobros, 'importe');

  res.json({ ok: true, data: {
    viaje: v, cargas, costos, cobros,
    totales: { costo, cobrado, rentabilidad: Math.round((cobrado - costo) * 100) / 100 },
  } });
}));

// Las cargas, para poder mirar el negocio desde el lado del cliente.
router.get('/cargas', wrap((req, res) => {
  const cond = ['c.anulado = 0'];
  const args = {};
  if (req.query.desde) { cond.push('c.fechaing >= @desde'); args.desde = String(req.query.desde); }
  if (req.query.hasta) { cond.push('c.fechaing <= @hasta'); args.hasta = String(req.query.hasta); }
  if (req.query.estado) { cond.push('c.estado = @estado'); args.estado = String(req.query.estado); }
  if (req.query.q) {
    cond.push(`(cli.resum LIKE @q OR c.origen LIKE @q OR c.destino LIKE @q OR CAST(c.nrocar AS TEXT) LIKE @q)`);
    args.q = '%' + String(req.query.q) + '%';
  }
  const filas = db.prepare(`
    SELECT c.*, cli.resum AS cliente, rem.resum AS remitente, des.resum AS destinatario,
           (SELECT COUNT(*) FROM bt_tr_carga_viaje cv
             WHERE cv.cargasuc = c.filial AND cv.carganro = c.nrocar AND cv.anulado = 0) AS en_viajes,
           (SELECT IFNULL(SUM(vc.importe),0) FROM bt_tr_valor_carga vc
             WHERE vc.cargasuc = c.filial AND vc.carganro = c.nrocar AND vc.anulado = 0) AS cobrado
      FROM bt_tr_cargas c
      LEFT JOIN bt_tr_clientes cli ON cli.codsuc = c.clisuc AND cli.fichanro = c.clinro
      LEFT JOIN bt_tr_clientes rem ON rem.codsuc = c.remsuc AND rem.fichanro = c.remnro
      LEFT JOIN bt_tr_clientes des ON des.codsuc = c.dessuc AND des.fichanro = c.desnro
     WHERE ${cond.join(' AND ')}
     ORDER BY c.fechaing DESC, c.nrocar DESC
     LIMIT 300`).all(args);
  const tot = db.prepare(`SELECT COUNT(*) n FROM bt_tr_cargas c
     LEFT JOIN bt_tr_clientes cli ON cli.codsuc = c.clisuc AND cli.fichanro = c.clinro
     WHERE ${cond.join(' AND ')}`).get(args);
  res.json({ ok: true, data: filas, total: tot.n, tope: 300 });
}));

router.get('/catalogos', wrap((req, res) => {
  const filas = db.prepare('SELECT * FROM bt_tr_catalogos ORDER BY catalogo, orden, codigo').all();
  const out = {};
  for (const f of filas) (out[f.catalogo] = out[f.catalogo] || []).push({ codigo: f.codigo, descrip: f.descrip });
  res.json({ ok: true, data: out });
}));

export default router;
