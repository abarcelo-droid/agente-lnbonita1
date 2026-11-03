// src/servicios/galponPlanillaOCR.js
// ══════════════════════════════════════════════════════════════════════════════════════
// 📷 LEER LA PLANILLA DE PAPEL Y PROPONER LAS CARGAS
// ══════════════════════════════════════════════════════════════════════════════════════
// Andy, 2/11/2026: «¿podremos desarrollar una carga rápida por foto? O sea cargamos la
// foto de esto y que genere sola los ingresos. Va a necesitar intervención de algún
// operador para completar datos faltantes, pero puede ayudar a cargar bastante rápido».
//
// El papel es el REGISTRO DE CONTROL EN GALPÓN DE EMPAQUE: una fila por bolsón, con su
// número correlativo dentro del viaje y su peso. Veintiún renglones por camión, tipeados
// a mano uno por uno, es media hora de alguien y veintiuna oportunidades de equivocarse.
//
// ── LO QUE ESTO NO ES ───────────────────────────────────────────────────────────────
// NO guarda nada. Devuelve una PROPUESTA que el operador mira, corrige y recién entonces
// confirma. Es la diferencia entre ahorrar tipeo y delegarle a una máquina los kilos con
// los que se paga un jornal.
//
// Por eso tampoco adivina: un peso que no se lee vuelve en `null` y con su aviso, y la
// pantalla lo muestra en rojo y no lo deja cargar hasta que alguien lo escriba. Un peso
// inventado es exactamente el error que nadie va a encontrar nunca — entra un número
// plausible, el renglón existe, y el total del día cierra.
//
// ── Y NO GUARDA LA FOTO ─────────────────────────────────────────────────────────────
// Se manda, se lee y se descarta. El original es el PAPEL, que lo firman tres personas y
// queda archivado por calidad; acá lo que vale son los renglones. Guardar la imagen
// sería un archivo más que servir —y las carpetas que hoy se sirven salen ANTES del
// portón de sesión (index.js:110-115)— a cambio de una copia de algo que ya existe.
//
// ── POR QUÉ LA LÓGICA VIVE ACÁ Y NO EN EL ROUTER ────────────────────────────────────
// Lo que puede salir mal no es la llamada a la IA: es lo que se hace con lo que
// contesta. Acá adentro no se importa nada, así que se prueba ejecutándolo contra
// respuestas de mentira copiadas de planillas de verdad — sin red, sin clave y sin
// gastar un centavo.
// ══════════════════════════════════════════════════════════════════════════════════════

import { kilos, entero, esFecha, sanitarioDe } from './galpon.js';

// ── EL PEDIDO QUE SE LE HACE AL MODELO ───────────────────────────────────────────────
// Escrito contra DOS fotos de verdad de la planilla (Andy, 2/11/2026). Cada línea de
// acá abajo está porque algo en esas dos fotos la necesitaba:
//
//   · La segunda foto está ACOSTADA 90°. Pasa siempre: se saca con el teléfono apoyado
//     en la mesa.
//   · El viaje y la finca se escriben UNA VEZ y abajo van comillas o una rayita. Sin
//     decirlo, el modelo devuelve veinte filas sin finca.
//   · El estado sanitario está PREIMPRESO como «B / R / M» en las veintiún filas y lo
//     que cambia es cuál está CIRCULADO. Leer la columna sin mirar el círculo devuelve
//     «B» en todas, que es la respuesta más peligrosa: una planilla donde todo figura
//     bueno porque nadie completó la columna.
//   · El peso va con COMA decimal.
const PROMPT = [
  'Leés una planilla de papel argentina: el REGISTRO DE CONTROL EN GALPÓN DE EMPAQUE,',
  'control de ingreso de materia prima. Una fila por bolsón/cajón que entró al galpón.',
  '',
  'LA FOTO PUEDE ESTAR ROTADA 90 o 180 grados. Orientala vos antes de leer.',
  '',
  'Columnas, de izquierda a derecha:',
  '  N° de viaje | Finca | Lote y/o Llave | N° de bolsas/bolsón/cajón/bins | Peso |',
  '  Estado sanitario | Observaciones',
  '',
  'Devolvé SOLO un objeto JSON, sin markdown y sin texto alrededor:',
  '{',
  '  "fecha": "YYYY-MM-DD" o null   // del encabezado; suele estar en blanco',
  '  "cultivo": string o null        // del encabezado "Cultivo/Variedad"',
  '  "filas": [',
  '    { "viaje": entero o null,',
  '      "finca": string o null,',
  '      "lote": string o null,',
  '      "numero": entero o null,    // el N° de bolsón, correlativo dentro del viaje',
  '      "kilos": número o null,     // el Peso. Punto decimal en el JSON: 15,90 -> 15.9',
  '      "sanitario": "B" | "R" | "M" | null,',
  '      "observacion": string o null,',
  '      "duda": string o null }     // por qué no estás seguro de esta fila',
  '  ]',
  '}',
  '',
  'REGLAS, y son las que importan:',
  '',
  '1. UNA FILA DEL JSON POR CADA FILA ESCRITA DEL PAPEL, en el mismo orden. Las filas',
  '   vacías del final no se devuelven.',
  '',
  '2. EL VIAJE, LA FINCA Y EL LOTE SE ESCRIBEN UNA SOLA VEZ y abajo van comillas (") o',
  '   una rayita vertical, que significan "lo mismo de arriba". Repetí el valor en cada',
  '   fila. Cuando aparece un valor NUEVO, de ahí para abajo vale el nuevo.',
  '',
  '3. EL ESTADO SANITARIO ESTÁ PREIMPRESO "B / R / M" EN TODAS LAS FILAS. Lo que vale es',
  '   cuál está CIRCULADO o marcado a mano. Si en esa fila no hay ninguno marcado,',
  '   devolvé null. NO devuelvas "B" porque la B esté impresa: null significa "no se',
  '   miró", y es una respuesta correcta y frecuente.',
  '',
  '4. EL PESO LLEVA COMA DECIMAL en el papel ("15,90"). En el JSON va con punto (15.9).',
  '   Son kilos de fruta: entre 5 y 25 es lo normal.',
  '',
  '5. SI NO LEÉS ALGO CON SEGURIDAD, PONÉ null Y EXPLICÁ EN "duda". No adivines un',
  '   número. Un peso inventado entra como un renglón creíble y no lo encuentra nadie;',
  '   un null lo completa una persona en dos segundos.',
].join('\n');

export function promptPlanilla() { return PROMPT; }

// ── LA FOTO QUE LLEGA ────────────────────────────────────────────────────────────────
// Viaja como data URL en el cuerpo del pedido, igual que el dibujo de una
// presentación: sin multer, sin archivo temporal y sin nada que limpiar después.
//
// ACEPTA JPEG, PNG Y WEBP y no sólo PNG como el dibujito, porque esto sale de la
// cámara de un teléfono. Lo que NO acepta es SVG: es un documento, puede traer un
// <script> adentro, y acá además se le manda a un modelo — un SVG con texto
// escondido es la forma de decirle a la IA algo que el que sacó la foto no escribió.
export const TIPOS_FOTO = {
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  'image/png':  [0x89, 0x50, 0x4E, 0x47],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
};

// 5 MB es el máximo que acepta la API por imagen. El panel la achica antes de
// mandarla, así que llegar acá con más es señal de que alguien pegó el data URL a
// mano — o de que el achicador no corrió.
export const FOTO_MAX_BYTES = 5 * 1024 * 1024;

// Devuelve { ok, media_type, base64, bytes } o { ok:false, motivo }. No tira.
export function fotoDeDataUrl(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return { ok: false, motivo: 'No llegó ninguna foto' };
  const m = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(t);
  if (!m) return { ok: false, motivo: 'Eso no es una foto' };
  const tipo = m[1];
  if (!TIPOS_FOTO[tipo]) {
  return { ok: false, motivo: 'La foto tiene que ser JPG, PNG o WEBP (llegó ' + tipo + ')' };
}
  let buf;
try { buf = Buffer.from(m[2], 'base64'); } catch (e) {
  return { ok: false, motivo: 'No se pudo leer la foto' };
}
  if (!buf.length) return { ok: false, motivo: 'La foto llegó vacía' };
  if (buf.length > FOTO_MAX_BYTES) {
  return { ok: false, motivo: 'La foto pesa ' + Math.round(buf.length / 1024 / 1024 * 10) / 10
    + ' MB y el máximo son 5 MB. Sacala de nuevo con menos resolución.' };
}
  /* LOS MAGIC BYTES Y NO EL ENCABEZADO DEL DATA URL. "data:image/png" lo escribe
   quien manda el pedido y no prueba nada sobre el contenido: sin esto, un archivo
   cualquiera rotulado como PNG se le manda igual al modelo. */
  const magia = TIPOS_FOTO[tipo];
  for (let i = 0; i < magia.length; i++) {
    if (buf[i] !== magia[i]) {
      return { ok: false, motivo: 'El archivo dice ser ' + tipo + ' y no lo es' };
    }
  }
  return { ok: true, media_type: tipo, base64: m[2], bytes: buf.length };
}

// ── SACAR EL JSON DE LO QUE CONTESTÓ ─────────────────────────────────────────────────
// Puede venir envuelto en ```json ... ``` aunque se le pida que no. Mismo criterio que
// _extraerJson en rutas/ifco.js, que ya pasó por esto.
export function jsonDeRespuesta(texto) {
  const t = String(texto == null ? '' : texto);
  if (!t.trim()) return null;
  const cercado = t.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const cand = cercado ? cercado[1] : t;
  const m = cand.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

const txt = (v) => {
  const s = String(v == null ? '' : v).trim();
  // Las comillas y la rayita son el "ídem" del papel. Si el modelo las devuelve tal
  // cual en vez de resolverlas, acá valen lo mismo que una celda vacía — y la celda
  // vacía se resuelve propagando, que es lo que hace normalizar().
  if (!s || /^["'”“|¡!·.\-–—]+$/.test(s)) return null;
  return s;
};

// Un entero de planilla. A diferencia de entero() —que acepta el 0 y es para los IFCOs—
// acá el cero no existe: no hay bolsón número cero ni viaje cero.
export function enteroPlanilla(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── EL TECHO DE FILAS ────────────────────────────────────────────────────────────────
// Una planilla tiene 21 renglones impresos y pueden venir dos hojas. Cien es holgado y
// corta una respuesta delirante antes de que llene la pantalla con basura.
export const MAX_FILAS = 100;

// ── LO QUE SE LE MUESTRA AL OPERADOR ─────────────────────────────────────────────────
// Devuelve { ok, fecha, cultivo, filas, avisos }. NO tira nunca: una respuesta rota de
// la IA tiene que terminar en "no se pudo leer, cargalo a mano", no en un 500.
//
// Cada fila sale con `ok` (si se puede cargar tal cual) y `duda` (por qué no). La
// pantalla usa las dos: las que no están ok van en rojo y no entran en el total hasta
// que alguien las complete.
export function filasDePlanilla(datos) {
  const d = datos && typeof datos === 'object' ? datos : null;
  if (!d) {
    return { ok: false, motivo: 'La IA no devolvió nada que se pueda leer',
             fecha: null, cultivo: null, filas: [], avisos: [] };
  }
  const crudas = Array.isArray(d.filas) ? d.filas : [];
  if (!crudas.length) {
    return { ok: false, motivo: 'No se reconoció ninguna fila en la foto. Probá con una '
             + 'foto más derecha y con mejor luz, o cargalo a mano.',
             fecha: null, cultivo: null, filas: [], avisos: [] };
  }

  const avisos = [];
  if (crudas.length > MAX_FILAS) {
    avisos.push('La foto devolvió ' + crudas.length + ' filas y se tomaron las primeras '
      + MAX_FILAS + '. Revisá que sea una planilla.');
  }

  /* EL ÍDEM SE RESUELVE ACÁ TAMBIÉN, aunque se le pida al modelo que lo haga. No es
     desconfianza gratuita: en el papel, una celda vacía en el medio de un viaje SIEMPRE
     significa «lo mismo de arriba» —es como está impreso el formulario— así que
     propagar es lo correcto mire quien mire. Y si el modelo ya lo resolvió, esto no
     cambia nada: sólo rellena lo que vino en null. */
  let viaje = null; let finca = null; let lote = null;
  const filas = [];
  for (const c of crudas.slice(0, MAX_FILAS)) {
    const f = c && typeof c === 'object' ? c : {};
    const v = enteroPlanilla(f.viaje);
    if (v != null) viaje = v;
    const fi = txt(f.finca);
    if (fi != null) finca = fi;
    const lo = txt(f.lote);
    if (lo != null) lote = lo;

    const kg = kilos(f.kilos);
    const dudas = [];
    if (txt(f.duda)) dudas.push(txt(f.duda));
    /* El cero y el negativo se tratan como ilegible y no como un peso: un bolsón de 0 kg
       no existe, así que si eso llegó es que se leyó mal. Se devuelve para completar, no
       se descarta — descartarla sería perder la fila entera por una celda. */
    if (kg === null) dudas.push('no se pudo leer el peso');
    else if (kg <= 0) dudas.push('el peso leído fue ' + kg + ' kg, que no puede ser');

    filas.push({
      viaje,
      finca,
      lote,
      numero: enteroPlanilla(f.numero),
      kilos: kg !== null && kg > 0 ? kg : null,
      sanitario: sanitarioDe(f.sanitario),
      observacion: txt(f.observacion),
      // Lista para cargar, o hay que completarla a mano.
      ok: kg !== null && kg > 0,
      duda: dudas.length ? dudas.join('; ') : null,
    });
  }

  const faltan = filas.filter((f) => !f.ok).length;
  if (faltan) {
    avisos.push(faltan === 1
      ? 'Hay 1 renglón sin peso: completalo antes de cargar.'
      : ('Hay ' + faltan + ' renglones sin peso: completalos antes de cargar.'));
  }

  /* EL CORRELATIVO ES LA RED DE SEGURIDAD DE LA LECTURA. En el papel el N° de bolsón
     arranca en 1 con cada viaje y sube de a uno; un salto quiere decir que se saltó una
     fila o que un número se leyó mal. No frena nada —el papel también puede tener el
     salto— pero es lo único que avisa de una fila PERDIDA, que es el error que ni el
     total ni el peso delatan. */
  const salto = saltoDeNumeracion(filas);
  if (salto) avisos.push(salto);

  return {
    ok: true,
    fecha: esFecha(d.fecha) || null,
    cultivo: txt(d.cultivo),
    filas,
    avisos,
  };
}

// Devuelve el aviso, o null si la numeración de cada viaje va de a uno.
export function saltoDeNumeracion(filas) {
  const l = Array.isArray(filas) ? filas : [];
  let ant = null; let viaje;
  for (const f of l) {
    if (f.viaje !== viaje) { viaje = f.viaje; ant = null; }
    const n = f.numero;
    if (n == null) continue;
    if (ant != null && n !== ant + 1) {
      return 'Los números de bolsón saltan del ' + ant + ' al ' + n
           + '. Mirá si falta un renglón o si alguno se leyó mal.';
    }
    ant = n;
  }
  return null;
}

// El total que el operador compara contra el papel ANTES de confirmar. Es el control más
// barato que hay contra una lectura mal hecha: el papel no tiene el total escrito, pero
// veintiún pesos de entre 7 y 19 kg que den 240 son creíbles y que den 2.400 no.
export function totalDePlanilla(filas) {
  const l = Array.isArray(filas) ? filas : [];
  const buenas = l.filter((f) => f && f.ok && f.kilos > 0);
  const kg = buenas.reduce((t, f) => t + Number(f.kilos), 0);
  return {
    cargas: buenas.length,
    sin_peso: l.length - buenas.length,
    kilos: Math.round(kg * 100) / 100,
    promedio: buenas.length ? Math.round((kg / buenas.length) * 100) / 100 : 0,
  };
}

// Lo que la pantalla le manda al servidor por cada fila, ya con el encabezado común
// pegado. Vive acá y no en el panel para que se pueda probar: es donde se decide qué
// kilos se le anotan a qué lote y a qué cuadrilla.
export function cargaDeFila(fila, comun) {
  const c = comun || {};
  const f = fila || {};
  return {
    fecha: c.fecha,
    lote_id: c.lote_id,
    producto: c.producto || null,
    cuadrilla_ids: Array.isArray(c.cuadrilla_ids) ? c.cuadrilla_ids : [],
    kilos: f.kilos,
    // UNO. Cada fila del papel es un bolsón, igual que en la carga rápida: es lo que
    // hace que el promedio por cajón signifique algo.
    ifcos: 1,
    // El viaje sale de la FILA y no del encabezado: una misma foto puede tener el final
    // de un camión y el principio del siguiente, que es exactamente lo que pasa en las
    // dos fotos del 2/11.
    viaje: f.viaje == null ? null : f.viaje,
    sanitario: f.sanitario || null,
    observacion: f.observacion || c.observacion || null,
    // De dónde salió el peso. No es 'balanza' —nadie lo leyó de un indicador— ni es del
    // todo 'manual': lo tipeó una persona en el papel y lo transcribió una máquina.
    origen: 'manual',
  };
}
