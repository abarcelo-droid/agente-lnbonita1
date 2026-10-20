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

export default router;
