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
import fs from 'node:fs';
import path from 'node:path';
import db from '../servicios/db_galpon.js';
import { exigirEmpresa, PUENTE_CORDON } from '../servicios/sociedad_modulo.js';
import {
  COLORES, config, guardarConfig, cuadrillas, rangoSuperpuesto, colorSugerido,
  loteVigente, tramosDelDia, tramoChoca, lotesParaElDia, volcadosEnTramo,
  hhmm, esFecha,
  registrarVolcado, editarVolcado, borrarVolcado, borrarVolcados,
  volcadosDelDia, resumenDelDia,
  acumulado, rangoCargado, resumenParaPlanilla,
  ultimaCarga,
  DESTINOS, presentaciones, guardarPresentacion, borrarPresentacion,
  lotesConDatos, guardarDatosDeLote, variedadATodos,
  palletAbierto, abrirPallet, contenidoDelPallet, cerrarPallet, reabrirPallet,
  proximoNumero,
  pisoParaDespacho, palletsParaDespacho, unidadesDelDespacho,
  agregarPalletAlDespacho, sacarPalletDelDespacho,
  despachos, itemsDelDespacho, abrirDespacho, editarDespacho,
  stockPorPresentacion, guardarIcono, borrarIcono, rutaDelIcono,
  procesosDelRango,
  stockParaArmar, stockPorArticulo, enPallets, palletsArmados, abrirPalletArmado,
  moverAlPallet,
  procesoPorDia, procesoTotal, rindePorLote, planillaIngreso,
  sacarDelPalletArmado, lineasDelPallet, palletResumen,
  agregarAlDespacho, sacarDelDespacho, emitirDespacho, anularDespacho, borrarDespacho,
  despachoPorNumero,
  camion, camionesParaCargar, nuevoCamion, escanearPallet, bajarPallet, marcarCargado,
  cargaDelDespacho, registroDeCulata, cambiarNumeroPallet,
  borrarPallet, sacarDelPallet, pallets, palletPorNumero, valorConfig,
  registrarProceso, editarProceso, borrarProceso, procesosDelDia,
  tableroProceso, stockGalpon, stockPorLote, stockPorProducto, lotesVolcados,
} from '../servicios/galpon.js';
import { generarTarjetasPDF, tarjetasAImprimir } from '../servicios/galponTarjetasPDF.js';
import { promptPlanilla, jsonDeRespuesta, filasDePlanilla, fotoDeDataUrl,
         resolverLotes }
  from '../servicios/galponPlanillaOCR.js';
/* UNA SOLA PUERTA A LA IA (servicios/ia.js): deja el consumo registrado y traduce el
   error una vez. Había siete archivos llamando por su cuenta y ninguno dejaba rastro
   — el 14/10 la cuenta se quedó sin crédito y no hubo forma de saber qué lo gastó. */
import { llamarIA, hayIA, motivoFalla, MODELO_CHAT } from '../servicios/ia.js';
/* El nivel de la persona en el módulo, con la MISMA regla que usa el servidor para
   dejar pasar el pedido (ORDEN_NIVEL en servicios/permisos.js). Acá no se decide si
   entra —eso ya lo contestó exigirNivel— sino hasta dónde llega adentro: borrar lo de
   hoy lo puede cualquiera que opere, y lo de un día cerrado no.

   Se importa de permisos.js y no se reescribe: dos copias de la escala de niveles son
   dos lugares donde «borrar» y «anular» pueden dejar de pesar lo mismo. */
import { nivelEnModulo } from '../servicios/permisos.js';

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

// ¿Puede esta persona sacar un renglón de un día YA CERRADO? Admin siempre. Para el
// resto hace falta el nivel que CLAUDE.md llama de anulación, donde «anular» y
// «borrar» pesan igual.
function puedeAnularCargas(u) {
  if (!u) return false;
  if (u.rol === 'admin') return true;
  const n = nivelEnModulo(u, 'galpon-carga');
  return n === 'anular' || n === 'borrar';
}

// La fecha y la hora SALEN DEL SERVIDOR, no del navegador que preguntó. Dos máquinas
// con la hora corrida cargarían dos tramos distintos del mismo cambio de lote, y el de
// la tarde le ganaría al de la mañana sin que nadie lo note.
const hoy   = () => new Date().toLocaleDateString('en-CA');
const ahora = () => new Date().toLocaleTimeString('es-AR',
                      { hour: '2-digit', minute: '2-digit', hour12: false });

// ── LA CONFIGURACIÓN ─────────────────────────────────────────────────────────────────
router.get('/config', (req, res) => {
  try {
    /* Y CUÁL VA A SER EL PRÓXIMO NÚMERO DE PALLET. Es lo único que permite ver, ANTES
       de cerrar, si el arranque configurado abre un hueco o pisa algo: el que lo
       configura escribe «269» y acá lee «PC-26-00269». Se calcula con la fecha de hoy
       porque es la que va a tener el pallet que se cierre ahora. */
    res.json({ ok: true, config: config(db), colores: COLORES,
               proximo_pallet: proximoNumero(db, hoy()) });
  } catch (e) {
    console.error('[GALPON] GET /config:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Las claves que se pueden tocar desde la pantalla, declaradas. Sin esta lista, un PUT con
// una clave inventada ensucia gal_config con filas que nadie lee nunca más.
const CLAVES = ['tara_ifco', 'objetivo_kg_hora', 'motivos_calidad',
                'balanza_puerto', 'balanza_baudios',
                'pallet_desde', 'pallet_desde_anio'];

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
      /* EL ARRANQUE DEL CORRELATIVO. Entero y no negativo —0 lo apaga— porque un
         «269,5» guardado como texto volvería del padStart como 269.5 y el número del
         pallet dejaría de ser un número. Con decimales se rechaza en vez de truncarse:
         truncar en silencio un dato que se imprime y se pega es peor que no guardarlo. */
      if (clave === 'pallet_desde') {
        const n = (valor === '' || valor === null || valor === undefined) ? 0 : Number(valor);
        if (!Number.isInteger(n) || n < 0) {
          return res.status(400).json({ ok: false,
            error: 'El primer número de pallet tiene que ser un entero (0 lo apaga)' });
        }
        valor = String(n);
      }
      /* Y EL AÑO, EXACTAMENTE DOS DÍGITOS: es lo que va adentro del número. Un «2026»
         acá no coincidiría nunca con el «26» que arma proximoNumero(), y el arranque
         quedaría guardado y sin efecto — que es la peor de las tres respuestas. */
      if (clave === 'pallet_desde_anio') {
        const a = String(valor == null ? '' : valor).trim();
        if (a !== '' && !/^\d{2}$/.test(a)) {
          return res.status(400).json({ ok: false,
            error: 'El año del arranque va con dos dígitos, como 26' });
        }
        valor = a;
      }
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

    // ── EL PRIMER LOTE DEL DÍA ARRANCA A LAS 00:00, Y NO SE PREGUNTA ────────────────
    // Antes esto era un default que el operador podía cambiar, y la pantalla le pedía la
    // hora. El que ponía 07:00 —la hora en que abre el galpón, o sea el dato más fiel—
    // se comía un cartel avisándole de un agujero.
    //
    // No hay tal agujero: el primer lote del día es el lote del día hasta que cambie.
    // Lo que venga en `desde_hora` se ignora a propósito, para que lo que dice la
    // pantalla y lo que hace el sistema sean la misma cosa.
    //
    // A partir del SEGUNDO la hora es obligatoria, porque ahí sí significa algo: un
    // cambio de lote sin hora no es un cambio de lote, es pisar el anterior.
    const hayTramos = db.prepare('SELECT COUNT(*) AS n FROM gal_lote_vigente WHERE fecha = ?')
      .get(fecha).n;
    const hora = hayTramos ? hhmm(b.desde_hora) : '00:00';
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

// ═══════════════════════════════════════════════════════════════════════════════════
// LOS KILOS, CARGADOS A MANO
// ═══════════════════════════════════════════════════════════════════════════════════
// Andy, 30/10/2026: *«hará algo más manual, donde se puedan cargar los kilos a mano...
// el operador elige kilos, lote, cuadrilla, fecha, producto. Porque todavía no
// instalamos la impresora»*.
//
// Sin impresora no hay tarjetas, sin tarjetas no hay escaneo — y la cosecha no espera.
// Esto escribe en `gal_volcados`, el MISMO libro donde va a escribir el escaneo: lo que
// cambia es quién llena los campos, no qué se guarda ni de dónde lo lee el tablero.
//
// ── Y VA CON requireAuth, NO CON requireAdmin ──────────────────────────────────────
// Cargar los kilos del día es el trabajo del día, no parametrizar. El nivel lo decide
// `exigirNivel` mirando la URL contra ensure_api_prefijos.js. Pedir admin acá obligaría
// a que los kilos los cargue el dueño, y el que los cuenta terminaría dictándoselos.

// Lo cargado un día, con su resumen. Un solo pedido: la pantalla necesita las dos cosas
// a la vez y partirlo en dos deja la mitad de arriba contradiciendo a la de abajo
// mientras llega la segunda respuesta.
router.get('/volcados', (req, res) => {
  try {
    const fecha = esFecha(req.query.fecha) || hoy();
    res.json({
      ok: true,
      fecha,
      hoy: hoy(),
      cargas: volcadosDelDia(db, fecha),
      // El encabezado de la carga rápida: lo último que esta persona escribió, con
      // la bandera de si viene de otro día. El usuario sale de la COOKIE: «lo último
      // que cargué yo» preguntado por el cliente lo contesta cualquiera.
      ultimo: ultimaCarga(db, fecha, (req._user || {}).id),
      resumen: resumenDelDia(db, fecha),
      /* Si esta persona puede sacar un renglón de un día cerrado. La pantalla lo usa
         para no ofrecer la × en un día pasado cuando va a contestar 403 — el que la
         aprieta y le rebota cree que rompió algo. NO reemplaza el control: lo de
         arriba sigue decidiendo. */
      puede_anular: puedeAnularCargas(req._user),
      // El lote declarado para ese día, para proponerlo en la ventana. Es una PROPUESTA:
      // el que carga a mano elige el lote que quiera, y de hecho puede no haber ninguno
      // declarado — la carga manual no depende del lote del día, lo aprovecha si está.
      propuesta: (function () {
        const v = loteVigente(db, fecha, fecha === hoy() ? ahora() : '23:59');
        return v.ok ? { lote_id: v.lote_id, lote_nombre: v.lote_nombre, producto: v.producto } : null;
      })(),
    });
  } catch (e) {
    console.error('[GALPON] GET /volcados:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/volcados', (req, res) => {
  try {
    const u = req._user || {};
    const r = registrarVolcado(db, Object.assign({}, req.body || {}, {
      // El usuario SALE DE LA COOKIE, no del cuerpo del pedido. Es la firma de quién
      // contó esos kilos, y una firma que manda el cliente no firma nada.
      usuario_id: u.id || null,
      usuario: u.nombre || null,
    }));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /volcados:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/volcados/:id', (req, res) => {
  try {
    const r = editarVolcado(db, num(req.params.id), req.body || {});
    if (!r.ok) return res.status(r.motivo === 'Esa carga no existe o ya se borró' ? 404 : 400)
                        .json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] PATCH /volcados/:id:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── BORRAR LO DE HOY LO PUEDE CUALQUIERA (V1133) ──────────────────────────────────
   Andy, 2/11/2026: «necesito que todos los usuarios puedan borrar algo del día vigente
   (fecha día hoy)».

   El nivel ya lo aflojó exigirNivel para esta dirección (BORRAR_ES_OPERAR en
   servicios/permisos.js). Lo que ese middleware NO puede ver es la FECHA de la fila:
   sin lo de abajo, aflojar el nivel dejaría a cualquiera borrar la temporada pasada.
   Las dos mitades son una sola decisión y las dos tienen que estar. */
/* ── BORRAR VARIAS DE UNA VEZ (V1134) ──────────────────────────────────────────────
   Andy, 2/11/2026: «quiero poder seleccionar varios para eliminar, como si tuvieran un
   casillero».

   VA COMO POST Y NO COMO DELETE porque lleva CUERPO: la lista de ids. Un DELETE con
   body lo tiran algunos intermediarios sin avisar, y meter ochenta ids en el query
   string topa con el largo máximo de una URL.

   El nivel lo resuelve igual: la dirección cuelga de /api/galpon/volcados, que está en
   BORRAR_ES_OPERAR (servicios/permisos.js), y además la palabra «borrar» en la URL ya
   la hace pasar por el control de anulación. Y el control de la FECHA está adentro,
   como en el de una sola — es la otra mitad de la misma decisión. */
/* ── 📷 LEER LA PLANILLA DE PAPEL (V1135) ──────────────────────────────────────────
   Andy, 2/11/2026: «¿podremos desarrollar una carga rápida por foto? O sea cargamos la
   foto de esto y que genere sola los ingresos. Va a necesitar intervención de algún
   operador para completar datos faltantes».

   ESTO NO GUARDA NADA. Lee la foto y devuelve una PROPUESTA; las cargas las crea
   después la pantalla con el POST /volcados de siempre, una por fila, cuando el
   operador confirma. Que la lectura no escriba es lo que hace que una lectura mala
   sea un rato perdido y no veintiún renglones de kilos inventados.

   Y LA FOTO NO SE GUARDA: se manda, se lee y se descarta. El original es el papel,
   que lo firman tres personas y lo archiva calidad.

   MODELO_CHAT y no MODELO_OCR, que es el barato. Esto es una tabla manuscrita de
   veintiún pesos con coma, y cada uno se convierte en kilos que pagan un jornal: un
   «15,90» leído «13,90» son dos kilos que no encuentra nadie. Una foto por camión,
   diez por día: la diferencia de costo es despreciable y la de lectura no.
   ──────────────────────────────────────────────────────────────────────────────── */
router.post('/volcados/leer-foto', async (req, res) => {
  try {
    if (!hayIA()) {
      return res.status(503).json({ ok: false, ia_caida: true,
        error: 'El lector de planillas no está disponible. Cargá los renglones a mano'
             + ' y avisá a la oficina.',
        motivo_admin: 'Sin ANTHROPIC_API_KEY.' });
    }
    const foto = fotoDeDataUrl((req.body || {}).imagen);
    if (!foto.ok) return res.status(400).json({ ok: false, error: foto.motivo });

    const u = req._user || {};
    const msg = await llamarIA('galpon-leer-planilla', {
      model: MODELO_CHAT,
      /* Veintiún renglones de JSON entran holgados en 4096. Cortado, la respuesta
         llega sin cerrar y el JSON no parsea: se pierde la lectura entera —y lo que
         costó— por las últimas tres filas. */
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64',
                                     media_type: foto.media_type, data: foto.base64 } },
          { type: 'text', text: promptPlanilla() },
        ],
      }],
    }, { usuario_id: u.id, usuario: u.nombre });

    const texto = (msg.content || [])
      .filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const r = filasDePlanilla(jsonDeRespuesta(texto));
    if (!r.ok) return res.status(502).json({ ok: false, error: r.motivo });

    /* ── LA FINCA Y EL LOTE DEL PAPEL SE RESUELVEN CONTRA EL PADRÓN ──────────────
       Andy, 2/11/2026: «a veces en la misma hoja tenemos algunos cajones que son de
       una cuadrilla y otros de otra. Y fincas también puede pasar lo mismo».

       La planilla trae las columnas Finca y «Lote y/o Llave» y el lector ya las lee:
       preguntárselas igual renglón por renglón sería pedirle a una persona que
       transcriba lo que acaba de transcribir una máquina.

       SE RESUELVE ACÁ Y NO EN LA PANTALLA porque acá está el padrón y se puede
       probar con una base de verdad. Y NO ADIVINA: con dos candidatos o con ninguno
       devuelve null y el motivo escrito, y lo elige una persona. Un lote mal
       atribuido no se nota nunca —los kilos están, el total cierra— y deja el rinde
       de dos cuadros cruzado para toda la temporada. */
    /* Y SI ESTO FALLA, LA LECTURA VUELVE IGUAL. Resolver el lote es una comodidad;
       la lectura es lo que costó una llamada al modelo y treinta segundos de alguien
       parado con la planilla en la mano. Perderla entera porque una consulta al
       padrón se cayó sería cambiar lo barato por lo caro — y el operador no tiene
       cómo distinguir eso de «la IA no anda»: elegiría los lotes a mano igual, pero
       después de volver a sacar la foto. */
    let rl = { filas: r.filas, avisos: [], resueltos: 0 };
    try {
      rl = resolverLotes(lotesParaElDia(db), r.filas);
    } catch (e2) {
      console.error('[GALPON] leer-foto, resolver lotes: ' + e2.message);
    }
    res.json(Object.assign({ ok: true }, r, {
      filas: rl.filas,
      avisos: (r.avisos || []).concat(rl.avisos),
      lotes_resueltos: rl.resueltos,
    }));
  } catch (e) {
    /* El motivo técnico va al log y a motivo_admin, no a la cara del que está con la
       planilla en la mano. Lo que él necesita saber es que puede seguir cargando a
       mano, no el JSON de facturación de Anthropic en inglés. */
    const m = motivoFalla(e);
    console.error('[GALPON] leer-foto: ' + m.admin + ' — ' + m.crudo);
    res.status(502).json({ ok: false, ia_caida: true,
      error: m.operador.replace('Cargalo a mano', 'Cargá los renglones a mano'),
      motivo_admin: m.admin });
  }
});

router.post('/volcados/borrar', (req, res) => {
  try {
    const r = borrarVolcados(db, (req.body || {}).ids, {
      hoy: hoy(),
      puede_anular: puedeAnularCargas(req._user),
    });
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /volcados/borrar:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/volcados/:id', (req, res) => {
  try {
    const r = borrarVolcado(db, num(req.params.id), {
      // La fecha de hoy la pone el SERVIDOR. Tomada del navegador, adelantar el reloj
      // del equipo del galpón alcanzaría para que «hoy» fuera cualquier día.
      hoy: hoy(),
      puede_anular: puedeAnularCargas(req._user),
    });
    if (!r.ok) return res.status(r.status || 404).json({ ok: false, error: r.motivo });
    res.json({ ok: true });
  } catch (e) {
    console.error('[GALPON] DELETE /volcados/:id:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── CUÁNTO LLEVAMOS ─────────────────────────────────────────────────────────────────
// La pantalla de carga contesta cuánto entró HOY. Ésta contesta cuánto llevamos, que es
// la pregunta con la que se cierra una temporada.
//
// Sin fechas devuelve TODO lo cargado, de la primera carga a la última. Es la respuesta
// correcta a "cuánto llevamos" y evita que la pantalla abra en blanco esperando que
// alguien elija un desde — un rango por defecto que arranca el 1 de enero esconde lo que
// pasó antes y el total sale corto sin que se note.
router.get('/acumulado', (req, res) => {
  try {
    const r = rangoCargado(db);
    res.json({
      ok: true,
      hoy: hoy(),
      rango: r,
      ...acumulado(db, req.query.desde, req.query.hasta),
    });
  } catch (e) {
    console.error('[GALPON] GET /acumulado:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════════════
// 📦 EL PROCESO (V1112)
// ════════════════════════════════════════════════════════════════════════════════════
// gal_volcados es lo que entró; esto es lo que salió. Y las dos juntas son el rinde.
//
// Cargar el proceso es TRABAJO DEL DÍA y va con requireAuth, como la carga de kilos. Lo
// que pide admin es el CATÁLOGO de presentaciones, que es parametrización: una caja mal
// definida multiplica mal todas las cargas que entren con ella.

// El catálogo lo LEE cualquiera con el módulo: sin él la pantalla de proceso no tiene
// baldosas que mostrar.
router.get('/presentaciones', (req, res) => {
  try {
    res.json({ ok: true, destinos: DESTINOS,
               presentaciones: presentaciones(db, { todas: req.query.todas === '1' }) });
  } catch (e) {
    console.error('[GALPON] GET /presentaciones:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/presentaciones', requireAdmin, (req, res) => {
  try {
    const r = guardarPresentacion(db, req.body || {});
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /presentaciones:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/presentaciones/:id', requireAdmin, (req, res) => {
  try {
    const r = guardarPresentacion(db, Object.assign({}, req.body || {},
                                                    { id: num(req.params.id) }));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] PATCH /presentaciones/:id:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/presentaciones/:id', requireAdmin, (req, res) => {
  try {
    const r = borrarPresentacion(db, num(req.params.id));
    if (!r.ok) return res.status(404).json({ ok: false, error: r.motivo });
    res.json({ ok: true });
  } catch (e) {
    console.error('[GALPON] DELETE /presentaciones/:id:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Todo lo que la pantalla necesita para pintarse, en UN pedido: los lotes entre los que
// se elige, el catálogo, lo ya cargado, el tablero del lote y el stock. Partirlo en
// cinco deja la pantalla contradiciéndose a sí misma mientras llegan las respuestas.
router.get('/procesos', (req, res) => {
  try {
    const fecha = esFecha(req.query.fecha) || hoy();
    /* UNO O VARIOS. Con la mezcla, lo que se está procesando puede ser de dos o tres
       lotes a la vez, y el tablero tiene que sumarlos: mostrar el pendiente de uno solo
       mientras se carga contra todos es un número que invita a procesar de más. */
    const loteId = String(req.query.lote_ids || req.query.lote_id || '').split(',');
    res.json({
      ok: true,
      fecha,
      hoy: hoy(),
      destinos: DESTINOS,
      presentaciones: presentaciones(db),
      lotes: lotesVolcados(db),
      procesos: procesosDelDia(db, fecha, loteId),
      tablero: tableroProceso(db, fecha, loteId),
      /* EL STOCK YA NO VIAJA ACÁ. Andy, 5/11/2026: «eso es análisis; la parte de
         proceso tiene que ser bien operativa». Iban tres cortes del stock —el total,
         por lote y por producto— y los tres son agregados sobre TODA gal_procesos sin
         cortar por fecha. La pantalla de proceso se recarga después de cada carga, así
         que eran tres barridos de la tabla entera por cada caja que alguien tipea, y
         desde que la pantalla no los dibuja nadie los miraba.

         Lo que hay guardado se lee en 🚚 Stock y Despachos, que pega contra /stock. */
      // El pallet que se está armando y los cerrados: la pantalla de proceso ES la de
      // cierre de pallet, así que van en el mismo pedido que todo lo demás.
      pallet_abierto: (function () {
        const x = palletAbierto(db);
        return x ? Object.assign({}, x, { contenido: contenidoDelPallet(db, x.id) }) : null;
      })(),
      pallets: pallets(db, { limite: 50 }),
    });
  } catch (e) {
    console.error('[GALPON] GET /procesos:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── 📋 A TRAVÉS DE LOS DÍAS ──────────────────────────────────────────────────────
   Andy, 4/11/2026: «quiero un lugar que sea transversal a los días, es decir que
   pueda ver todos los procesos de cada día».

   Va aparte de GET /procesos y no como un parámetro suyo. Ese devuelve la pantalla
   de carga entera —lotes, presentaciones, tablero, pallets, el stock— parada en UN
   día, porque es con lo que se carga. Esto devuelve una lista y nada más: meterlos
   en la misma puerta sería un endpoint con dos formas de respuesta y la mitad de
   los campos en null según con qué se lo llame.

   Y se declara ANTES de /procesos/:id —aunque hoy ninguno sea GET— porque Express
   resuelve por orden: el día que alguien escriba un GET /procesos/:id arriba, este
   se volvería la carga con id «rango» y contestaría 400 sin que nadie entienda. */
router.get('/procesos/rango', (req, res) => {
  try {
    res.json(Object.assign({ ok: true, hoy: hoy() },
      procesosDelRango(db, req.query.desde, req.query.hasta,
        { destino: req.query.destino })));
  } catch (e) {
    console.error('[GALPON] GET /procesos/rango:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/procesos', (req, res) => {
  try {
    const u = req._user || {};
    const r = registrarProceso(db, Object.assign({}, req.body || {}, {
      // La firma sale de la COOKIE, como en la carga de kilos: una firma que manda el
      // cliente no firma nada.
      usuario_id: u.id || null,
      usuario: u.nombre || null,
    }));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /procesos:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/procesos/:id', (req, res) => {
  try {
    const r = editarProceso(db, num(req.params.id), req.body || {});
    if (!r.ok) {
      return res.status(r.motivo === 'Ese proceso no existe o ya se borró' ? 404 : 400)
                .json({ ok: false, error: r.motivo });
    }
    res.json(r);
  } catch (e) {
    console.error('[GALPON] PATCH /procesos/:id:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/procesos/:id', (req, res) => {
  try {
    const r = borrarProceso(db, num(req.params.id));
    if (!r.ok) return res.status(404).json({ ok: false, error: r.motivo });
    res.json({ ok: true });
  } catch (e) {
    console.error('[GALPON] DELETE /procesos/:id:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// El stock es DERIVADO: se suma gal_procesos cada vez. No hay tabla de saldos que
// mantener al día, y por eso corregir una carga de la semana pasada lo arregla solo.

// ── LA PLANILLA DEL RESUMEN ─────────────────────────────────────────────────────────
// Andy, 1/11/2026: «quiero que en acumulado se pueda descargar un archivo como el que
// te saco foto».
//
// ExcelJS se importa ACÁ ADENTRO y no arriba. Es el patrón del repo: un import suelto
// en el encabezado hace que todo el router se caiga al cargarse donde no están los
// node_modules, y con él se caen las otras veinte rutas del galpón — por una planilla
// que nadie pidió todavía.
router.get('/resumen.xlsx', async (req, res) => {
  try {
    const r = rangoCargado(db);
    const desde = esFecha(req.query.desde) || r.primera || hoy();
    const hasta = esFecha(req.query.hasta) || r.ultima || hoy();
    const filas = resumenParaPlanilla(db, desde, hasta);

    const { default: ExcelJS } = await import('exceljs');
    const { galponResumenExcel } = await import('../servicios/galponResumenExcel.js');
    const buf = await galponResumenExcel(ExcelJS, { filas, desde, hasta });

    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      'attachment; filename="galpon-resumen-' + desde + '-a-' + hasta + '.xlsx"');
    res.end(Buffer.from(buf));
  } catch (e) {
    console.error('[GALPON] GET /resumen.xlsx:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// ── LO QUE EL TARJETÓN NECESITA DE CADA LOTE ────────────────────────────────────────
// RENSPA, variedad y cuartel. Es PARAMETRIZACIÓN y pide admin: un RENSPA mal cargado
// se imprime en cada etiqueta que salga de ese lote, y lo que se imprimió es lo que
// viajó.
router.get('/lote-datos', (req, res) => {
  try {
    res.json({ ok: true, lotes: lotesConDatos(db) });
  } catch (e) {
    console.error('[GALPON] GET /lote-datos:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/lote-datos', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    /* Dos operaciones en una ruta porque son la misma cosa: copiar la variedad a todos
       los lotes de un cultivo es cargarla veinte veces de una. Con dos rutas, la de
       copiar habría que declararla aparte en los prefijos y es la clase de línea que se
       olvida. */
    const r = b.todos_del_cultivo
      ? variedadATodos(db, b.todos_del_cultivo, b.variedad)
      : guardarDatosDeLote(db, b);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(Object.assign({ ok: true }, r, { lotes: lotesConDatos(db) }));
  } catch (e) {
    console.error('[GALPON] POST /lote-datos:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// ════════════════════════════════════════════════════════════════════════════════════
// 🧱 EL PALLET
// ════════════════════════════════════════════════════════════════════════════════════
// Cerrar un pallet es TRABAJO DEL DÍA y va con requireAuth, como cargar kilos. El que
// arma el pallet es el que lo cierra: pedir admin acá terminaría con el dueño cerrando
// pallets a pedido por teléfono.
router.get('/pallets', (req, res) => {
  try {
    res.json({
      ok: true,
      abierto: (function () {
        const a = palletAbierto(db);
        return a ? Object.assign({}, a, { contenido: contenidoDelPallet(db, a.id) }) : null;
      })(),
      pallets: pallets(db, { estado: req.query.estado, desde: req.query.desde,
                             hasta: req.query.hasta }),
    });
  } catch (e) {
    console.error('[GALPON] GET /pallets:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/pallets', (req, res) => {
  try {
    const u = req._user || {};
    const r = abrirPallet(db, Object.assign({}, req.body || {}, {
      usuario_id: u.id || null, usuario: u.nombre || null,
    }));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /pallets:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/pallets/:id/cerrar', (req, res) => {
  try {
    const r = cerrarPallet(db, num(req.params.id), req.body || {});
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /pallets/:id/cerrar:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/pallets/:id/reabrir', (req, res) => {
  try {
    const r = reabrirPallet(db, num(req.params.id));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /pallets/:id/reabrir:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/pallets/:id', (req, res) => {
  try {
    const r = borrarPallet(db, num(req.params.id));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json({ ok: true });
  } catch (e) {
    console.error('[GALPON] DELETE /pallets/:id:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ✏️ CAMBIAR EL NÚMERO (V1151). Trabajo del día, como cerrar: lo corrige el que se
// equivocó, en el momento, y no el dueño por teléfono. Un número repetido NO es un
// error del pedido: vuelve 200 con los repetidos para que la pantalla los muestre en
// rojo. 400 es sólo lo que no se puede: un formato que no es un número, o un pallet
// que ya salió con un remito emitido.
router.patch('/pallets/:id/numero', (req, res) => {
  try {
    const u = req._user || {};
    const r = cambiarNumeroPallet(db, num(req.params.id), (req.body || {}).numero,
      { usuario_id: u.id || null, usuario: u.nombre || null });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] PATCH /pallets/:id/numero:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Sacar una carga del pallet sin borrarla: la caja existe, estaba en el montón
// equivocado.
router.post('/pallets/sacar/:procesoId', (req, res) => {
  try {
    const r = sacarDelPallet(db, num(req.params.procesoId));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json({ ok: true });
  } catch (e) {
    console.error('[GALPON] POST /pallets/sacar:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── EL TARJETÓN ─────────────────────────────────────────────────────────────────────
// jspdf y qrcode se importan ACÁ ADENTRO, como el resto del repo: un import suelto en
// el encabezado se lleva puestas las otras treinta rutas del galpón donde no están los
// node_modules.
router.get('/pallets/:id/tarjeton.pdf', async (req, res) => {
  try {
    const id = num(req.params.id);
    const p = db.prepare('SELECT * FROM gal_pallets WHERE id = ? AND eliminado_en IS NULL')
                .get(id);
    if (!p) return res.status(404).json({ ok: false, error: 'Ese pallet no existe' });
    const contenido = contenidoDelPallet(db, id);
    if (!contenido.length) {
      return res.status(400).json({ ok: false, error: 'Ese pallet no tiene nada adentro' });
    }

    const { galponPalletPDF } = await import('../servicios/galponPalletPDF.js');
    const buf = await galponPalletPDF(p, contenido, {
      marca: valorConfig(db, 'etq_marca', 'LA NIÑA BONITA'),
      comercializa: valorConfig(db, 'etq_comercializa', ''),
      origen: valorConfig(db, 'etq_origen', ''),
    });

    res.setHeader('Content-Type', 'application/pdf');
    /* inline y no attachment: esto se abre para mandarlo a la impresora, y un archivo
       que se baja a Descargas obliga a buscarlo. El nombre igual va, para el que lo
       guarde. */
    res.setHeader('Content-Disposition',
      'inline; filename="pallet-' + (p.numero || p.id) + '.pdf"');
    res.end(buf);
  } catch (e) {
    console.error('[GALPON] GET /pallets/:id/tarjeton.pdf:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Buscar por número: es lo que se hace cuando llega un reclamo con una etiqueta en la
// mano. El número es lo único que tiene quien llama.
router.get('/pallets/numero/:numero', (req, res) => {
  try {
    const p = palletPorNumero(db, req.params.numero);
    if (!p) return res.status(404).json({ ok: false, error: 'No hay ningún pallet con ese número' });
    res.json({ ok: true, pallet: p });
  } catch (e) {
    console.error('[GALPON] GET /pallets/numero:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════════════
// 🚚 EL DESPACHO
// ════════════════════════════════════════════════════════════════════════════════════
// Despachar es TRABAJO DEL DÍA y va con requireAuth, como cargar kilos y cerrar pallets.
// El que arma el camión es el que lo despacha; pedir admin acá terminaría con el dueño
// emitiendo remitos por teléfono. El nivel lo decide exigirNivel por la URL.
//
// Y anular tiene su PROPIA dirección (POST .../:id/anular), por la regla de CLAUDE.md:
// un PATCH .../:id que aceptara estado='anulado' sería una puerta lateral por donde
// cualquiera que pueda editar anula.
router.get('/stock', (req, res) => {
  try {
    res.json({
      ok: true,
      hoy: hoy(),
      destinos: DESTINOS,
      stock: stockGalpon(db, { lote_id: num(req.query.lote_id) }),
      presentaciones: stockPorPresentacion(db, { destino: req.query.destino }),
      productos: stockPorProducto(db),
      lotes: stockPorLote(db),
      /* LAS DOS MANERAS DE CARGAR UN CAMIÓN, por separado. «piso» es lo suelto y lo
         que está en un pallet abierto; «pallets» son los cerrados, que van enteros.
         Antes había una sola lista que mezclaba las dos cosas, y por eso se podía
         pedir una cantidad que terminaba partiendo un pallet armado. */
      piso: pisoParaDespacho(db, { destino: req.query.destino }),
      pallets: palletsParaDespacho(db, { destino: req.query.destino }),
      despachos: despachos(db, { limite: 50 }).map((x) => Object.assign({}, x,
        { items: itemsDelDespacho(db, x.id), unidades: unidadesDelDespacho(db, x.id),
          carga: cargaDelDespacho(db, x.id) })),
    });
  } catch (e) {
    console.error('[GALPON] GET /stock:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/despachos', (req, res) => {
  try {
    const l = despachos(db, { estado: req.query.estado, desde: req.query.desde,
                              hasta: req.query.hasta, limite: req.query.limite });
    res.json({ ok: true, despachos: l.map((x) => Object.assign({}, x,
      { items: itemsDelDespacho(db, x.id), unidades: unidadesDelDespacho(db, x.id),
        carga: cargaDelDespacho(db, x.id) })) });
  } catch (e) {
    console.error('[GALPON] GET /despachos:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/despachos', (req, res) => {
  try {
    const u = req._user || {};
    res.json(abrirDespacho(db, Object.assign({}, req.body || {}, {
      usuario_id: u.id || null, usuario: u.nombre || null,
    })));
  } catch (e) {
    console.error('[GALPON] POST /despachos:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/despachos/:id', (req, res) => {
  try {
    const r = editarDespacho(db, num(req.params.id), req.body || {});
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] PATCH /despachos/:id:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/despachos/:id/items', (req, res) => {
  try {
    const u = req._user || {};
    const r = agregarAlDespacho(db, num(req.params.id), Object.assign({}, req.body || {}, {
      usuario_id: u.id || null, usuario: u.nombre || null,
    }));
    if (!r.ok) return res.status(400).json(Object.assign({ ok: false, error: r.motivo }, r));
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /despachos/:id/items:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/despachos/items/:procesoId', (req, res) => {
  try {
    const r = sacarDelDespacho(db, num(req.params.procesoId));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] DELETE /despachos/items:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* UN PALLET ENTERO. Es una ruta propia y no un item con una cantidad: la cantidad es
   lo que tiene adentro y no hay nada que elegir. Y así exigirNivel la reconoce por
   la URL, como el resto del repo. */
router.post('/despachos/:id/pallets', (req, res) => {
  try {
    const u = req._user || {};
    const r = agregarPalletAlDespacho(db, req.params.id, (req.body || {}).pallet_id,
      Object.assign({}, req.body || {}, { usuario_id: u.id, usuario: u.nombre }));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo, en_pallet: r.en_pallet });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /despachos/:id/pallets:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/despachos/:id/pallets/:palletId', (req, res) => {
  try {
    const r = sacarPalletDelDespacho(db, req.params.id, req.params.palletId);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] DELETE /despachos/:id/pallets:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/despachos/:id/emitir', (req, res) => {
  try {
    const r = emitirDespacho(db, num(req.params.id));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /despachos/:id/emitir:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/despachos/:id/anular', (req, res) => {
  try {
    const r = anularDespacho(db, num(req.params.id), (req.body || {}).motivo);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /despachos/:id/anular:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/despachos/:id', (req, res) => {
  try {
    const r = borrarDespacho(db, num(req.params.id));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json({ ok: true });
  } catch (e) {
    console.error('[GALPON] DELETE /despachos/:id:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Buscar por número: lo que se hace cuando llega un reclamo con un remito en la mano.
router.get('/despachos/numero/:numero', (req, res) => {
  try {
    const x = despachoPorNumero(db, req.params.numero);
    if (!x) return res.status(404).json({ ok: false, error: 'No hay ningún despacho con ese número' });
    res.json({ ok: true, despacho: x });
  } catch (e) {
    console.error('[GALPON] GET /despachos/numero:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── 🖼️ EL DIBUJO PROPIO DE UNA PRESENTACIÓN ─────────────────────────────────────────
// Andy, 1/11/2026: «quiero yo poder subirle algún dibujito desde la computadora».
//
// VA A data/galpon/iconos, que NO está en ningún express.static. Las carpetas que sí
// lo están —data/sg, data/ifco, data/uploads— se sirven ANTES del portón de sesión
// (index.js:110-115), o sea alcanzables sin cookie. El dibujo de una caja no es un
// secreto, pero tampoco hay una razón para publicarlo, y el día que alguien copie este
// bloque para algo que sí lo sea se lleva el agujero puesto.
const IC_DIR = path.join(process.cwd(), 'data', 'galpon', 'iconos');
const iconoIO = {
  escribir(nombre, buf) {
    try {
      fs.mkdirSync(IC_DIR, { recursive: true });
      const ruta = path.join(IC_DIR, nombre);
      fs.writeFileSync(ruta, buf);
      return { ok: true, ruta };
    } catch (e) {
      console.error('[GALPON] guardando icono:', e.message);
      return { ok: false, motivo: 'No se pudo guardar el archivo' };
    }
  },
  borrar(ruta) { try { fs.unlinkSync(ruta); } catch (e) { /* ya no estaba */ } },
};

// Subirlo y borrarlo es PARAMETRIZAR —es el catálogo— así que va con requireAdmin,
// igual que el resto de /presentaciones. Mirarlo es trabajo del día y va con la sesión.
router.post('/presentaciones/:id/icono', requireAdmin, (req, res) => {
  try {
    const r = guardarIcono(db, num(req.params.id), (req.body || {}).imagen, iconoIO);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /presentaciones/:id/icono:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/presentaciones/:id/icono', requireAdmin, (req, res) => {
  try {
    const r = borrarIcono(db, num(req.params.id), iconoIO);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] DELETE /presentaciones/:id/icono:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/presentaciones/:id/icono', (req, res) => {
  try {
    const ruta = rutaDelIcono(db, num(req.params.id));
    if (!ruta || !fs.existsSync(ruta)) return res.status(404).end();
    /* Un año de caché y privada. La URL lleva ?v= con la versión, así que subir otro
       dibujo cambia la dirección y el navegador lo pide de nuevo; sin el ?v= seguiría
       mostrando el anterior para siempre. Y private porque pasa por requireAuth: un
       proxy compartido no tiene por qué quedárselo. */
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(ruta);
  } catch (e) {
    console.error('[GALPON] GET /presentaciones/:id/icono:', e.message);
    res.status(500).end();
  }
});


// EL REGISTRO DE LA CULATA (V1150), para la oficina. Cuelga de /despachos y no de
// /camion: lo lee el que arma y emite los remitos, con el permiso de Stock y Despachos.
router.get('/despachos/:id/culata', (req, res) => {
  try {
    const c = cargaDelDespacho(db, num(req.params.id));
    if (!c) return res.status(404).json({ ok: false, error: 'Ese despacho no existe' });
    res.json({ ok: true, carga: c, registro: registroDeCulata(db, num(req.params.id)) });
  } catch (e) {
    console.error('[GALPON] GET /despachos/:id/culata:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 📲 CARGAR EL CAMIÓN, ESCANEANDO (V1149) ──────────────────────────────────────────
// Lo usa la app del cargador, /m/galpon-camion. Todas bajo /camion para que tengan su
// PROPIO permiso (galpon-camion en ensure_api_prefijos.js): el que carga camiones no
// tiene por qué poder armar despachos, emitirlos ni anularlos, y si estas rutas
// colgaran de /despachos heredarían todo eso.
//
// Es trabajo del día: requireAuth, y el nivel lo decide exigirNivel. Las respuestas
// que no suben nada vuelven con 200 y ok:false — no son errores del pedido, son lo
// que la pantalla tiene que pintar en rojo.
const quien = (req) => ({ usuario_id: (req._user || {}).id || null,
                         usuario: (req._user || {}).nombre || null });

router.get('/camion', (req, res) => {
  try {
    res.json({ ok: true, hoy: hoy(), camiones: camionesParaCargar(db) });
  } catch (e) {
    console.error('[GALPON] GET /camion:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/camion', (req, res) => {
  try {
    const r = nuevoCamion(db, Object.assign({}, req.body || {}, quien(req)));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /camion:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/camion/:id', (req, res) => {
  try {
    const c = camion(db, num(req.params.id));
    if (!c) return res.status(404).json({ ok: false, error: 'Ese despacho no existe' });
    res.json({ ok: true, camion: c });
  } catch (e) {
    console.error('[GALPON] GET /camion/:id:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/camion/:id/escanear', (req, res) => {
  try {
    const b = req.body || {};
    const r = escanearPallet(db, num(req.params.id), b.numero,
      Object.assign({ agregar: b.agregar ? 1 : 0 }, quien(req)));
    if (r.resultado === 'sin_camion') return res.status(404).json(Object.assign(
      { error: r.motivo }, r));
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /camion/:id/escanear:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/camion/:id/bajar', (req, res) => {
  try {
    const r = bajarPallet(db, num(req.params.id), (req.body || {}).pallet_id, quien(req));
    if (!r.ok) return res.status(400).json(Object.assign({ error: r.motivo }, r));
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /camion/:id/bajar:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/camion/:id/cargado', (req, res) => {
  try {
    const r = marcarCargado(db, num(req.params.id), Object.assign(
      { confirmar: (req.body || {}).confirmar ? 1 : 0 }, quien(req)));
    /* Faltan pallets y no se confirmó: no es un error, es la pregunta. 200 con
       necesita_confirmar, y la pantalla la hace. */
    if (!r.ok && !r.necesita_confirmar) {
      return res.status(400).json(Object.assign({ error: r.motivo }, r));
    }
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /camion/:id/cargado:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── 🧱 ARMAR UN PALLET CON LO QUE YA ESTÁ EN CÁMARA ─────────────────────────────────
// Andy, 1/11/2026: «necesito un lugar donde pueda hacer cierre de pallet de mercadería
// que está suelta en el stock, donde puedo agarrar pallets mixtos y todo».
//
// Armar un pallet es TRABAJO DEL DÍA, como cargar kilos o cerrar el del proceso: va con
// requireAuth. El que arma el camión en el playón es el que lo arma en la pantalla.
router.get('/armado', (req, res) => {
  try {
    res.json({
      ok: true,
      hoy: hoy(),
      destinos: DESTINOS,
      /* SÓLO EL PISO. Andy, 5/11/2026: «al momento de armar un pallet tiene que estar
         disponible solo lo que está SIN PALLET... sino va a quedar duplicado». Los dos
         cortes salen de lo mismo: por artículo es el camino normal —el sistema reparte
         entre lotes y días— y por lote hace falta cuando el que arma quiere elegir. */
      articulos: stockPorArticulo(db, { destino: req.query.destino, suelto: true }),
      stock: stockParaArmar(db, { destino: req.query.destino, suelto: true }),
      /* Y lo que NO se puede, para poder decir por qué: sin esto la lista pasa de 2.109
         cajas a 40 y parece que desapareció mercadería. */
      en_pallets: enPallets(db, { destino: req.query.destino }),
      /* TODOS los pallets de la cámara, no sólo los armados: desde que a un pallet no
         se le sacan cajas desde afuera, ésta es la única pantalla desde la que se
         puede abrir uno del proceso para desarmarlo. */
      pallets: palletsArmados(db, { estado: req.query.estado, todos: true }).map((x) =>
        Object.assign({}, x, { lineas: lineasDelPallet(db, x.id) })),
    });
  } catch (e) {
    console.error('[GALPON] GET /armado:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/armado', (req, res) => {
  try {
    const u = req._user || {};
    res.json(abrirPalletArmado(db, Object.assign({}, req.body || {}, {
      usuario_id: u.id || null, usuario: u.nombre || null,
    })));
  } catch (e) {
    console.error('[GALPON] POST /armado:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/armado/:id/mover', (req, res) => {
  try {
    const u = req._user || {};
    const r = moverAlPallet(db, num(req.params.id), Object.assign({}, req.body || {}, {
      usuario_id: u.id || null, usuario: u.nombre || null,
    }));
    if (!r.ok) return res.status(400).json(Object.assign({ ok: false, error: r.motivo }, r));
    res.json(r);
  } catch (e) {
    console.error('[GALPON] POST /armado/:id/mover:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/armado/linea/:procesoId', (req, res) => {
  try {
    const r = sacarDelPalletArmado(db, num(req.params.procesoId));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });
    res.json(r);
  } catch (e) {
    console.error('[GALPON] DELETE /armado/linea:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── 📄 EL INFORME DEL ACUMULADO ─────────────────────────────────────────────────────
// Andy, 2/11/2026: «quiero que me sumes en la parte de acumulado un buen informe en PDF
// con gráficos. Gráficos de torta. Stock».
//
// Sale con el MISMO período que está en pantalla, igual que la planilla: bajar siempre
// todo dejaría al que filtró tres días con un informe de la temporada entera y sin
// ninguna señal de que no es lo que estaba mirando.
router.get('/informe.pdf', async (req, res) => {
  try {
    const r = rangoCargado(db);
    const desde = esFecha(req.query.desde) || r.primera || hoy();
    const hasta = esFecha(req.query.hasta) || r.ultima || hoy();

    const ac = acumulado(db, desde, hasta);
    const pt = procesoTotal(db, desde, hasta);
    const stock = stockGalpon(db, {});

    /* LOS DIBUJITOS SUBIDOS, leídos del disco y pasados como data URL. Los emojis de
       texto no se pueden imprimir —jsPDF con Helvetica los convierte en basura— pero un
       PNG sí, y es exactamente para lo que Andy puede subirlos desde el catálogo. */
    const iconos = {};
    for (const f of db.prepare(
      'SELECT id, icono FROM gal_presentaciones WHERE eliminado_en IS NULL').all()) {
      if (!f.icono) continue;
      try {
        iconos[f.id] = 'data:image/png;base64,'
          + fs.readFileSync(f.icono).toString('base64');
      } catch (e) { /* el archivo no está: va el disco de color */ }
    }

    const { galponInformePDF } = await import('../servicios/galponInformePDF.js');
    const buf = await galponInformePDF({
      desde, hasta, hoy: hoy(),
      usuario: (req._user && req._user.nombre) || null,
      totales: {
        kilos: (ac.total && ac.total.kilos) || 0,
        dias: (ac.total && ac.total.dias) || 0,
        procesado: pt.procesado || 0,
        comercial: pt.comercial || 0,
        verde: pt.verde || 0,
        descarte: pt.descarte || 0,
        stock: stock.kilos || 0,
      },
      stock,
      presentaciones: stockPorPresentacion(db, {}),
      por_dia: procesoPorDia(db, desde, hasta),
      rinde: rindePorLote(db, desde, hasta),
    }, { iconos });

    res.setHeader('Content-Type', 'application/pdf');
    /* inline y no attachment: esto se abre para mirarlo o mandarlo a la impresora, y un
       archivo que cae en Descargas obliga a ir a buscarlo. El nombre igual va, para el
       que lo guarde. */
    res.setHeader('Content-Disposition',
      'inline; filename="galpon-informe-' + desde + '-a-' + hasta + '.pdf"');
    res.end(buf);
  } catch (e) {
    console.error('[GALPON] GET /informe.pdf:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── 📋 LA PLANILLA DE CONTROL DE INGRESO ────────────────────────────────────────────
// Andy, 2/11/2026, con la foto del papel: «necesito que en el panel de ingreso de kilos
// pueda descargarse un exportable en PDF exactamente con esta información».
//
// Es de UN DÍA, como el papel: el formulario se llena por jornada y lo firman tres
// personas. Un rango de fechas en esta hoja sería otro documento.
router.get('/planilla.pdf', async (req, res) => {
  try {
    const f = esFecha(req.query.fecha) || hoy();
    const datos = planillaIngreso(db, f);
    const { galponPlanillaPDF } = await import('../servicios/galponPlanillaPDF.js');
    const buf = await galponPlanillaPDF(datos, { en_blanco: num(req.query.en_blanco) });
    res.setHeader('Content-Type', 'application/pdf');
    /* inline: esto se abre para imprimirlo y llevarlo al galpón, no para guardarlo. */
    res.setHeader('Content-Disposition',
      'inline; filename="control-ingreso-' + f + '.pdf"');
    res.end(buf);
  } catch (e) {
    console.error('[GALPON] GET /planilla.pdf:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
