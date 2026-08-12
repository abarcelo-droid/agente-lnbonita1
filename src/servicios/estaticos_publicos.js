// src/servicios/estaticos_publicos.js
// ── /static SERVÍA EL CÓDIGO DEL SERVIDOR ──────────────────────────────────
//
// EL AGUJERO. index.js montaba `express.static(src/)` en /static, o sea la
// carpeta ENTERA del servidor, y antes de cualquier middleware de sesión. Sin
// loguearse se bajaban:
//
//   /static/servicios/db.js        el acceso a la base
//   /static/servicios/auth_sesion.js  cómo se firma la cookie de sesión
//   /static/rutas/auth.js          el login entero
//   /static/index.js               el arranque del servidor, con la lista de
//                                  middlewares y el orden en que corren
//   /static/ifco.js                otro router que quedó en la raíz
//   /static/panel.html             las 44.000 líneas del panel, con cada
//                                  dirección de la API y cada nombre de campo
//   /static/login.html.viejo.bak   una versión vieja del login
//
// No hay contraseñas ahí —el secreto de las cookies vive en la base— pero es el
// plano completo del sistema entregado a cualquiera que sepa la URL. Y sirve
// para encontrar el próximo agujero sin tener que adivinar.
//
// LA REGLA, Y POR QUÉ ES ASÍ
// El navegador sólo necesita archivos de la RAÍZ de src: imágenes, hojas de
// estilo, los .js del front y los manifiestos. Todo el código del servidor vive
// en subcarpetas. Así que:
//
//   1. Nada de subcarpetas. Una sola regla que tapa servicios/, rutas/, config/
//      y agentes/ de una, y también cualquier carpeta de código que se agregue
//      mañana — que es lo que una lista de prohibidos no haría.
//   2. En la raíz, sólo extensiones de navegador.
//   3. Y una lista corta de archivos que ESTÁN en la raíz pero son del servidor.
//
// Se eligió prohibir subcarpetas en vez de listar los archivos permitidos uno
// por uno a propósito: una lista de permitidos deja el panel roto el día que
// alguien agrega una imagen y se olvida de anotarla, y ese error se descubre en
// producción. Este camino falla al revés — si algún día hace falta servir una
// subcarpeta, se agrega acá y se ve enseguida.
import path from 'path';

// Lo que el navegador puede pedir. `.html` NO está: las pantallas se sirven por
// sus propias rutas, que sí miran la sesión.
const EXTENSIONES = new Set([
  '.js', '.css', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico', '.webp',
  '.json', '.webmanifest', '.woff', '.woff2', '.ttf', '.map', '.pdf',
]);

// Archivos de SERVIDOR que quedaron en la raíz de src. Son la excepción a la
// regla de "en la raíz todo es del navegador", así que van nombrados.
const DEL_SERVIDOR = new Set([
  'index.js',   // el arranque del servidor
  'ifco.js',    // un router de Express que quedó en la raíz (src/rutas/ifco.js es otro)
]);

export default function estaticosPublicos(req, res, next) {
  // El path que pidió el navegador, ya sin el /static (Express lo saca).
  const pedido = decodeURIComponent(String(req.path || ''));

  // 1) Nada de subcarpetas. Alcanza con que quede algo después de la primera
  //    barra: '/servicios/db.js' tiene dos barras, '/logo.jpg' una sola.
  const sinBarra = pedido.replace(/^\/+/, '');
  if (sinBarra.includes('/') || sinBarra.includes('\\')) return res.sendStatus(404);

  // 2) Sólo extensiones de navegador.
  const ext = path.extname(sinBarra).toLowerCase();
  if (!EXTENSIONES.has(ext)) return res.sendStatus(404);

  // 3) Y no los archivos del servidor que viven en la raíz.
  if (DEL_SERVIDOR.has(sinBarra.toLowerCase())) return res.sendStatus(404);

  // Copias de seguridad y temporales que alguien haya dejado tiradas.
  if (/\.(bak|old|orig|tmp|swp)$/i.test(sinBarra) || sinBarra.includes('.viejo')) {
    return res.sendStatus(404);
  }

  next();
}

export { EXTENSIONES, DEL_SERVIDOR };
