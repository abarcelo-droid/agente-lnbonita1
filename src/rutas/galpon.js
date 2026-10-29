// src/rutas/galpon.js
// ── 🏭 GALPÓN — configuración y tarjetas ─────────────────────────────────────────────
// Lo que hay que tener listo ANTES de que llegue el primer camión: qué cuadrillas hay,
// de qué color es cada una, qué rango de tarjetas le toca, y cuánto pesa un IFCO vacío.
//
// ── QUIÉN TOCA QUÉ ──────────────────────────────────────────────────────────────────
// Las escrituras de acá son PARAMETRIZAR: asignarle a una cuadrilla su color y su rango,
// fijar la tara. Se tocan una vez por temporada y una mal puesta desvía los kilos de una
// cuadrilla entera. Por eso van con admin, que es la línea que ya usa el resto del repo.
//
// Lo que NO va con admin es el trabajo del día —volcar, pesar— y eso llega en el PR que
// viene con `requireAuth`. Poner admin ahí obligaría a que todo lo cargue el dueño.
//
// Las lecturas y el PDF van con `requireAuth`: imprimir una hoja de tarjetas no rompe
// nada, y el que las imprime a las seis de la mañana no suele ser el admin.
import express from 'express';
import db from '../servicios/db_galpon.js';
import { exigirEmpresa, PUENTE_CORDON } from '../servicios/sociedad_modulo.js';
import {
  COLORES, config, guardarConfig, cuadrillas, rangoSuperpuesto, colorSugerido,
  loteVigente, tramosDelDia, tramoChoca, huecoDelDia, lotesParaElDia, volcadosEnTramo,
  hhmm, esFecha,
} from '../servicios/galpon.js';
import { generarTarjetasPDF, tarjetasAImprimir } from '../servicios/galponTarjetasPDF.js';

const router = express.Router();

function getUser(req) {
  try { return req.cookies?.lnb_user ? JSON.parse(req.cookies.lnb_user) : null; }
  catch (e) { return null; }
}

function requireAuth(req, res, next) {
  const u = getUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'no autenticado' });
  req._user = u;
  next();
}

function requireAdmin(req, res, next) {
  if (req._user?.rol !== 'admin') {
    return res.status(403).json({
      ok: false,
      error: 'Configurar las cuadrillas y las tarjetas es de administrador: un rango mal '
           + 'puesto le atribuye los kilos de una cuadrilla a otra toda la temporada.',
    });
  }
  next();
}

router.use(requireAuth);

// El cerrojo de empresa, en todo el router. El galpón es de Puente Cordón; parado en San
// Gerónimo no se configura ni se imprime nada de acá.
router.use((req, res, next) => {
  if (exigirEmpresa(req, res, PUENTE_CORDON) === null) return;  // ya contestó 403
  next();
});

const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

// La fecha y la hora SALEN DEL SERVIDOR, no del navegador que preguntó. Dos máquinas
// con la hora corrida cargarían dos tramos distintos del mismo cambio de lote, y el de
// la tarde le ganaría al de la mañana sin que nadie lo note.
const hoy   = () => new Date().toLocaleDateString('en-CA');
const ahora = () => new Date().toLocaleTimeString('es-AR',
                      { hour: '2-digit', minute: '2-digit', hour12: false });

// ── LA CONFIGURACIÓN ─────────────────────────────────────────────────────────────────
router.get('/config', (req, res) => {
  try {
    res.json({ ok: true, config: config(db), colores: COLORES });
  } catch (e) {
    console.error('[GALPON] GET /config:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Las claves que se pueden tocar desde la pantalla, declaradas. Sin esta lista, un PUT con
// una clave inventada ensucia gal_config con filas que nadie lee nunca más.
const CLAVES = ['tara_ifco', 'objetivo_kg_hora', 'motivos_calidad',
                'balanza_puerto', 'balanza_baudios'];

router.put('/config', requireAdmin, (req, res) => {
  try {
    const guardadas = [];
    for (const clave of CLAVES) {
      if (!(clave in (req.body || {}))) continue;
      let valor = req.body[clave];
      if (clave === 'tara_ifco' || clave === 'objetivo_kg_hora' || clave === 'balanza_baudios') {
        // El campo en blanco se rechaza EXPLÍCITAMENTE, porque `Number('')` es 0 y 0 es
        // un número finito y no negativo. Sin esto, borrar el casillero de la tara la
        // deja en cero y todos los netos del día salen dos kilos de más.
        const n = (valor === '' || valor === null || valor === undefined) ? NaN : Number(valor);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ ok: false, error: clave + ' tiene que ser un número' });
        }
        valor = String(n);
      }
      if (clave === 'motivos_calidad' && Array.isArray(valor)) valor = valor.join(',');
      guardarConfig(db, clave, valor);
      guardadas.push(clave);
    }
    res.json({ ok: true, guardadas, config: config(db) });
  } catch (e) {
    console.error('[GALPON] PUT /config:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── LAS CUADRILLAS Y SUS RANGOS ──────────────────────────────────────────────────────
router.get('/cuadrillas', (req, res) => {
  try {
    res.json({
      ok: true,
      cuadrillas: cuadrillas(db, { incluir_inactivas: req.query.todas === '1' }),
      colores: COLORES,
    });
  } catch (e) {
    console.error('[GALPON] GET /cuadrillas:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Darle a una cuadrilla un rango de tarjetas.
//
// ── ACÁ SÍ SE RECHAZA, Y ES LA EXCEPCIÓN ────────────────────────────────────────────
// En el volcado nada rechaza porque la fruta ya está en la tolva. Acá es al revés: no pasó
// nada todavía, y dos rangos que se pisan son un error que NO se puede descubrir después.
// La tarjeta del medio se le atribuye a una de las dos para siempre y los kilos de la otra
// desaparecen sin dejar rastro. Se corta antes de guardar.
router.post('/cuadrillas/:id/tarjetas', requireAdmin, (req, res) => {
  try {
    const cuadrilla_id = num(req.params.id);
    const desde = num(req.body?.desde_id);
    const hasta = num(req.body?.hasta_id);
    if (!cuadrilla_id) return res.status(400).json({ ok: false, error: 'falta la cuadrilla' });
    if (desde === null || hasta === null || desde <= 0 || hasta < desde) {
      return res.status(400).json({
        ok: false, error: 'El rango no se entiende: el "desde" tiene que ser un número '
                        + 'positivo y menor o igual al "hasta".' });
    }

    const choca = rangoSuperpuesto(db, desde, hasta);
    if (choca) {
      return res.status(409).json({
        ok: false,
        error: 'Las tarjetas ' + desde + '–' + hasta + ' se pisan con las '
             + choca.desde_id + '–' + choca.hasta_id + ' de '
             + (choca.cuadrilla_nombre || 'otra cuadrilla')
             + '. Una misma tarjeta no puede ser de dos cuadrillas: los kilos de una de '
             + 'las dos se perderían sin que nadie lo note.',
        choca_con: choca,
      });
    }

    // El color es OPCIONAL: si no viene, se resuelve solo (el de la cuadrilla si ya
    // tiene, o el primero libre de la paleta). Obligar a elegirlo en cada rango termina
    // en dos cuadrillas del mismo color, que es el error que el color no puede corregir.
    const color = /^#[0-9a-f]{6}$/i.test(String(req.body?.color || ''))
      ? req.body.color : colorSugerido(db, cuadrilla_id);
    const r = db.prepare(
      'INSERT INTO gal_cuadrilla_tarjetas (cuadrilla_id, desde_id, hasta_id, color, notas) '
      + 'VALUES (?,?,?,?,?)')
      .run(cuadrilla_id, desde, hasta, color, req.body?.notas || null);
    res.json({ ok: true, id: Number(r.lastInsertRowid), color });
  } catch (e) {
    console.error('[GALPON] POST /cuadrillas/:id/tarjetas:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cambiarle el color a una cuadrilla cambia TODOS sus rangos. El color identifica a la
// cuadrilla, no al rango: dos tandas del mismo equipo con colores distintos es exactamente
// lo que el color estaba para evitar.
router.patch('/cuadrillas/:id/color', requireAdmin, (req, res) => {
  try {
    const cuadrilla_id = num(req.params.id);
    const color = String(req.body?.color || '');
    if (!/^#[0-9a-f]{6}$/i.test(color)) {
      return res.status(400).json({ ok: false, error: 'El color tiene que ser un hex #rrggbb' });
    }
    const r = db.prepare(
      'UPDATE gal_cuadrilla_tarjetas SET color = ? WHERE cuadrilla_id = ? AND activo = 1')
      .run(color, cuadrilla_id);
    res.json({ ok: true, rangos: r.changes });
  } catch (e) {
    console.error('[GALPON] PATCH color:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Dar de baja un rango. NO se borra la fila: un volcado viejo guardó la cuadrilla
// CONGELADA, pero el rango sigue siendo cómo se explica de dónde salió esa atribución.
router.delete('/tarjetas/:id', requireAdmin, (req, res) => {
  try {
    const r = db.prepare('UPDATE gal_cuadrilla_tarjetas SET activo = 0 WHERE id = ?')
      .run(num(req.params.id));
    if (!r.changes) return res.status(404).json({ ok: false, error: 'no existe ese rango' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[GALPON] DELETE /tarjetas/:id:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── EL PDF DE TARJETAS ───────────────────────────────────────────────────────────────
// Tres maneras de pedirlo, porque son tres momentos distintos:
//
//   ?cuadrilla_id=3        la tanda entera de una cuadrilla, al empezar la temporada
//   ?desde=1&hasta=200     un rango a mano
//   ?ids=7,9,11            reposición de las que se perdieron
//
// `inline` y no `attachment`: se abre en el visor del navegador y de ahí se imprime. Un
// archivo que se descarga primero agrega un paso y una carpeta de Descargas con veinte
// `tarjetas.pdf`.
router.get('/tarjetas.pdf', async (req, res) => {
  try {
    let opts = {};
    let datos = { porId: {}, colorPorId: {} };
    let nombre = 'tarjetas';

    const cid = num(req.query.cuadrilla_id);
    if (cid) {
      const rangos = db.prepare(
        'SELECT * FROM gal_cuadrilla_tarjetas WHERE cuadrilla_id = ? AND activo = 1 '
        + 'ORDER BY desde_id').all(cid);
      const c = db.prepare('SELECT nombre FROM pa_cuadrillas WHERE id = ?').get(cid);
      const ids = [];
      for (const r of rangos) for (let i = r.desde_id; i <= r.hasta_id; i++) ids.push(i);
      opts = { ids };
      datos.cuadrilla = c?.nombre || null;
      datos.color = rangos.length ? rangos[0].color : null;
      nombre = 'tarjetas-' + (c?.nombre || cid).toString().replace(/[^\w-]+/g, '_');
    } else {
      if (req.query.ids) {
        opts = { ids: String(req.query.ids).split(',') };
      } else {
        opts = { desde: req.query.desde, hasta: req.query.hasta };
      }
      // Cada tarjeta busca su cuadrilla por su cuenta: un rango tipeado a mano puede
      // cruzar dos cuadrillas, y salir todas con el nombre de la primera sería peor que
      // salir sin nombre.
      const rangos = db.prepare(
        'SELECT t.*, c.nombre AS cuadrilla_nombre FROM gal_cuadrilla_tarjetas t '
        + 'LEFT JOIN pa_cuadrillas c ON c.id = t.cuadrilla_id WHERE t.activo = 1').all();
      for (const id of tarjetasAImprimir(opts)) {
        const r = rangos.find((x) => id >= x.desde_id && id <= x.hasta_id);
        if (!r) continue;
        datos.porId[id] = r.cuadrilla_nombre || null;
        datos.colorPorId[id] = r.color;
      }
    }

    const pdf = await generarTarjetasPDF(datos, opts);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="' + nombre + '.pdf"',
    });
    res.send(pdf);
  } catch (e) {
    console.error('[GALPON] GET /tarjetas.pdf:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════
// 🗓️ EL LOTE DEL DÍA
// ═══════════════════════════════════════════════════════════════════════════════════
// Qué se está cosechando, y desde qué hora. Es la pregunta que el volcado le hace al
// sistema por cada IFCO, y hasta ahora no había dónde contestarla: lo más parecido era
// `pa_asistencias.fecha`, que es por DÍA y además registra quién trabajó, no qué entró.
//
// ── ESTO NO ES PARAMETRIZAR, ES EL TRABAJO DEL DÍA ────────────────────────────────
// Arriba, configurar las cuadrillas va con `requireAdmin`: se toca una vez por temporada
// y un rango mal puesto desvía los kilos de una cuadrilla entera. Esto es al revés — se
// carga todas las mañanas, lo hace el que abre el galpón, y si pide admin termina
// cargándolo el dueño por teléfono mientras el primer camión espera.
//
// Va con `requireAuth`, y el nivel lo decide `exigirNivel` mirando la URL contra
// `ensure_api_prefijos.js`. Es la regla de CLAUDE.md: operar no es ser admin.

// Los lotes entre los que se elige. Salen de Producción (`pa_lotes`): acá no se dan de
// alta, igual que las cuadrillas.
router.get('/lotes', (req, res) => {
  try {
    res.json({ ok: true, lotes: lotesParaElDia(db) });
  } catch (e) {
    console.error('[GALPON] GET /lotes:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// El día entero: sus tramos, el hueco de la mañana si lo hay, y qué está vigente ahora.
router.get('/lote-dia', (req, res) => {
  try {
    const fecha = esFecha(req.query.fecha) || hoy();
    const tramos = tramosDelDia(db, fecha);
    // Cuántos IFCOs cayeron en cada tramo. Es lo que decide si todavía se puede corregir,
    // así que la pantalla lo necesita ANTES de ofrecer el botón de borrar — ofrecer uno
    // que va a contestar 409 hace creer al que lo aprieta que rompió algo.
    for (const t of tramos) t.volcados = volcadosEnTramo(db, fecha, t.desde_hora, t.hasta_hora);
    res.json({
      ok: true,
      fecha,
      tramos,
      hueco: huecoDelDia(db, fecha),
      hoy: hoy(),
      // EL VIGENTE LO RESUELVE EL SERVIDOR, no la pantalla. La regla —el último tramo
      // cuya hora ya pasó— es la misma que usa el volcado, y repetirla en el navegador
      // sería tener dos copias de la única cosa que este módulo tiene que contestar
      // igual en los dos lados. Un día cambia una y el cartel dice un lote mientras el
      // volcado guarda otro.
      vigente: fecha === hoy() ? (function(){ const v = loteVigente(db, fecha, ahora());
                                              return v.ok ? v : null; })() : null,
      // La hora de la máquina del SERVIDOR, para que la pantalla no proponga la del
      // operador: dos navegadores con la hora corrida cargan dos tramos distintos del
      // mismo cambio de lote, y el de la tarde le gana al de la mañana.
      ahora: ahora(),
    });
  } catch (e) {
    console.error('[GALPON] GET /lote-dia:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// La pregunta del volcado: qué lote estaba vigente a tal hora. Contesta SIEMPRE 200 —con
// `ok:false` adentro cuando no hay lote cargado— porque el que la hace está por guardar
// un IFCO que YA ESTÁ EN LA TOLVA, y un 404 lo dejaría sin saber qué hacer con la fruta.
// Es el principio que ordena todo el volcado: nada se puede rechazar después del hecho.
router.get('/lote-vigente', (req, res) => {
  try {
    const fecha = esFecha(req.query.fecha) || hoy();
    const hora = hhmm(req.query.hora) || ahora();
    res.json(Object.assign({ fecha, hora }, loteVigente(db, fecha, hora)));
  } catch (e) {
    console.error('[GALPON] GET /lote-vigente:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cargar el lote del día, o un cambio de lote a media mañana. Son la misma operación: una
// fila con su hora de inicio. Una sola fila en el día = «el lote del día» y la hora no
// importa; varias = los cambios, cada uno con la suya.
router.post('/lote-dia', (req, res) => {
  try {
    const b = req.body || {};
    const fecha = esFecha(b.fecha);
    if (!fecha) return res.status(400).json({ ok: false, error: 'La fecha tiene que ser YYYY-MM-DD' });

    const lote_id = num(b.lote_id);
    if (!lote_id) return res.status(400).json({ ok: false, error: 'Falta el lote' });
    const lote = db.prepare('SELECT id, nombre FROM pa_lotes WHERE id = ?').get(lote_id);
    if (!lote) return res.status(400).json({ ok: false, error: 'Ese lote no existe' });

    // La hora: si es el PRIMER tramo del día, por defecto arranca a las 00:00 — así el
    // caso normal (un lote, todo el día) no deja la mañana sin cubrir, que es el error
    // más fácil de cometer: el que carga a las ocho pone las ocho, y el IFCO de las 6:40
    // se queda sin lote.
    //
    // A partir del segundo hay que decirla, porque un cambio de lote sin hora no es un
    // cambio de lote: es pisar el anterior.
    const hayTramos = db.prepare('SELECT COUNT(*) AS n FROM gal_lote_vigente WHERE fecha = ?')
      .get(fecha).n;
    const hora = hhmm(b.desde_hora) || (hayTramos ? null : '00:00');
    if (!hora) {
      return res.status(400).json({
        ok: false, error: 'Un cambio de lote necesita su hora: el IFCO que se vuelca a las '
                        + '14:30 es del lote que estaba vigente a las 14:30.' });
    }

    const choca = tramoChoca(db, fecha, hora);
    if (choca) {
      return res.status(409).json({
        ok: false,
        error: 'A las ' + hora + ' ya está cargado ' + (choca.lote_nombre || 'otro lote')
             + '. Dos lotes a la misma hora no se pueden resolver: el sistema se queda con '
             + 'uno de los dos y los kilos del otro no se atribuyen a nada. Corregí el que '
             + 'está, o poné otra hora.',
        choca_con: choca,
      });
    }

    // El nombre del lote lo pone el SERVIDOR, no el cliente. Está denormalizado para que
    // la etiqueta del pallet no salga a buscarlo, y si lo mandara la pantalla podría
    // llegar uno que no es el del lote_id — y entonces el tramo diría una cosa y
    // apuntaría a otra.
    const producto = String(b.producto || '').trim() || null;
    const u = req._user || {};
    const r = db.prepare(
      'INSERT INTO gal_lote_vigente (fecha, desde_hora, lote_id, lote_nombre, producto, '
      + 'usuario_id, usuario) VALUES (?,?,?,?,?,?,?)')
      .run(fecha, hora, lote.id, lote.nombre, producto, u.id || null, u.nombre || null);
    res.json({ ok: true, id: Number(r.lastInsertRowid), desde_hora: hora });
  } catch (e) {
    console.error('[GALPON] POST /lote-dia:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── UN TRAMO CON VOLCADOS ENCIMA NO SE TOCA ─────────────────────────────────────────
// Cada volcado CONGELA su lote_id al guardarse, igual que el total de un comprobante. O
// sea: corregir el tramo a las dos de la tarde no arregla los IFCOs de la mañana — lo
// único que hace es dejar esos kilos atribuidos a un lote que ya nadie declaró, y nadie
// se entera hasta que no cierran los números de la temporada.
//
// Mientras el tramo no atribuyó nada se corrige y se borra libremente, y ése es el caso
// normal: el error se descubre a los diez minutos de cargarlo. Después, lo que se corrige
// son los volcados, uno por uno y desde el Tablero, que es donde se ve cuáles son.
function tramoEditable(id) {
  const t = db.prepare('SELECT * FROM gal_lote_vigente WHERE id = ?').get(id);
  if (!t) return { error: 404, msg: 'No existe ese tramo' };
  const sig = db.prepare(
    'SELECT desde_hora FROM gal_lote_vigente WHERE fecha = ? AND desde_hora > ? '
    + 'ORDER BY desde_hora LIMIT 1').get(t.fecha, t.desde_hora);
  const n = volcadosEnTramo(db, t.fecha, t.desde_hora, sig ? sig.desde_hora : null);
  if (n) {
    return { tramo: t, error: 409, msg:
      'Ese tramo ya tiene ' + n + ' IFCO' + (n === 1 ? '' : 's') + ' volcado'
      + (n === 1 ? '' : 's') + ', y cada uno guardó su lote en el momento. Cambiarlo acá no '
      + 'los corrige: los dejaría apuntando a un lote que ya nadie declaró. Si el lote está '
      + 'mal, corregí esos volcados desde el Tablero.' };
  }
  return { tramo: t };
}

router.patch('/lote-dia/:id', (req, res) => {
  try {
    const chk = tramoEditable(num(req.params.id));
    if (chk.error) return res.status(chk.error).json({ ok: false, error: chk.msg });
    const t = chk.tramo;
    const b = req.body || {};

    const sets = [], par = [];
    if (b.desde_hora !== undefined) {
      const h = hhmm(b.desde_hora);
      if (!h) return res.status(400).json({ ok: false, error: 'La hora tiene que ser HH:MM' });
      const choca = tramoChoca(db, t.fecha, h, t.id);
      if (choca) {
        return res.status(409).json({
          ok: false,
          error: 'A las ' + h + ' ya está cargado ' + (choca.lote_nombre || 'otro lote') + '.',
          choca_con: choca });
      }
      sets.push('desde_hora = ?'); par.push(h);
    }
    if (b.lote_id !== undefined) {
      const lote = db.prepare('SELECT id, nombre FROM pa_lotes WHERE id = ?').get(num(b.lote_id));
      if (!lote) return res.status(400).json({ ok: false, error: 'Ese lote no existe' });
      sets.push('lote_id = ?', 'lote_nombre = ?'); par.push(lote.id, lote.nombre);
    }
    if (b.producto !== undefined) {
      sets.push('producto = ?'); par.push(String(b.producto || '').trim() || null);
    }
    if (!sets.length) return res.json({ ok: true, sin_cambios: true });

    par.push(t.id);
    db.prepare('UPDATE gal_lote_vigente SET ' + sets.join(', ') + ' WHERE id = ?').run(...par);
    res.json({ ok: true });
  } catch (e) {
    console.error('[GALPON] PATCH /lote-dia/:id:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/lote-dia/:id', (req, res) => {
  try {
    const chk = tramoEditable(num(req.params.id));
    if (chk.error) return res.status(chk.error).json({ ok: false, error: chk.msg });
    db.prepare('DELETE FROM gal_lote_vigente WHERE id = ?').run(chk.tramo.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[GALPON] DELETE /lote-dia/:id:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
