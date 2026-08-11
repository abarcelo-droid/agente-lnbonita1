// src/servicios/porton_api.js
// ── PARA ENTRAR A /api HAY QUE ESTAR LOGUEADO ──────────────────────────────
//
// EL AGUJERO QUE TAPA
// No había ninguna autenticación global. Sobre /api corrían tres middlewares
// —sesionFirmada, bloquearSiSoloLectura y exigirNivel— y NINGUNO exigía sesión:
// los dos últimos hacen next() explícito cuando no hay usuario. Y exigirNivel
// además es un no-op real: depende de la columna modulos_config.api_prefijos,
// que se crea pero no la escribe nadie en todo el repo.
//
// Medido sobre el código: 16 routers con escrituras alcanzables sin sesión, unas
// 130 en total. Crear una cuenta bancaria, cargar una oferta, tocar la tesorería
// de San Gerónimo — todo sin loguearse.
//
// UN PORTÓN, NO 130 PARCHES
// Poner requireAuth endpoint por endpoint deja el problema para siempre: el
// próximo que alguien escriba nace abierto y nadie se entera. Acá la regla es al
// revés — todo pide sesión salvo lo que esté en esta lista, que es corta y está
// justificada una por una.
//
// LAS EXCEPCIONES NO SON AGUJEROS
// Ninguna es "esto no lo protegemos". Son pedidos que por definición llegan sin
// sesión y traen su propia forma de identificarse:
//   · El login no puede pedir sesión para crear la sesión.
//   · El agente de Barceló es una máquina: se identifica con un token en un
//     header, no con una cookie, y su router lo verifica contra la base.
//   · El link de IFCO lo abre un proveedor que no tiene cuenta, y lleva un token
//     de un solo uso en la URL que el router valida contra el remito.
//
// DOS TRAMPAS, LAS DOS RESUELTAS ACÁ
//   1. Dos excepciones llevan un número variable en el medio de la ruta. Una
//      lista de textos fijos NO las matchea, así que se comparan con expresiones.
//   2. El 401 TIENE que traer cuerpo JSON. La pantalla de Scout hace r.json()
//      sobre toda respuesta sin mirar el estado: con el HTML que Express manda
//      por defecto, revienta y la pantalla queda en blanco, sin mensaje y sin
//      mandar al login.

// Cada excepción con su motivo. Si algún día una deja de hacer falta, se saca de
// acá y listo — no hay que buscarla en 16 archivos.
//
// Las rutas se escriben COMPLETAS (con /api). El middleware arma el path entero
// antes de comparar, porque montado con app.use('/api', ...) Express le saca el
// prefijo a req.path y compararlo así es el error clásico.
const PUBLICAS = [
  // ── El circuito de contraseñas. Los llama login.html, que es la única
  //    pantalla pública. Si falta UNO solo, se rompe el ingreso.
  ['POST', /^\/api\/auth\/login$/,              'crear la sesión: no puede pedir sesión'],
  // Primer ingreso con clave asignada por el admin: el login NO emite cookie en
  // ese camino —devuelve requiere_setear_password y corta antes—, así que el
  // usuario llega acá sin sesión. Se autentica solo, revalidando la clave.
  ['POST', /^\/api\/auth\/setear-password$/,    'cambio de clave del primer ingreso, sin sesión emitida'],
  ['POST', /^\/api\/auth\/solicitar-reset$/,    'olvido de contraseña: lo usa quien no puede entrar'],
  ['GET',  /^\/api\/auth\/validar-token$/,      'valida el link del mail antes de mostrar el formulario'],
  ['POST', /^\/api\/auth\/resetear-con-token$/, 'graba la clave nueva; se autentica con el token del mail'],
  // Salir tiene que funcionar aunque la sesión ya no valga: si devuelve 401 no
  // borra las cookies y el navegador queda con basura que nadie limpia.
  ['POST', /^\/api\/auth\/logout$/,             'borra las cookies; tiene que andar con la sesión vencida'],
  // "¿Estoy logueado?" — es la pregunta, no puede exigir que la respuesta sea sí.
  // Contesta su propio 401 y de paso limpia la sesión muerta.
  ['GET',  /^\/api\/auth\/me$/,                 'la sonda de sesión: contesta su propio 401 y limpia'],

  // ── El agente de sincronización de Barceló. Corre desatendido en el servidor
  //    de Transoft y empuja ~330.000 filas. Se identifica con el header
  //    X-BT-Token, que su router verifica contra la base. La cookie no le sirve:
  //    dura un día y el agente corre a las 3 de la mañana.
  ['POST', /^\/api\/bt\/sync$/,                 'agente de Transoft: se autentica con X-BT-Token'],
  ['POST', /^\/api\/bt\/sync\/cerrar$/,         'cierra el lote; sin esto queda "en curso" para siempre'],

  // ── El link de remito IFCO que se le manda al proveedor por WhatsApp. El
  //    proveedor no tiene cuenta. Lleva un token en ?t= que el router valida
  //    contra el remito. El segundo es una ESCRITURA —la aceptación firmada con
  //    nombre y DNI— y está bien que lo sea: es el proveedor confirmando.
  ['GET',  /^\/api\/ifco\/r\/[^/]+$/,           'remito público: lo abre el proveedor con token en la URL'],
  ['POST', /^\/api\/ifco\/r\/[^/]+\/aceptar$/,  'el proveedor firma la recepción; token en la URL'],

  // ── PENDIENTE DE DECISIÓN. Este link se manda por WhatsApp a CLIENTES y hoy
  //    no lleva token: cualquiera con el número de remito lo ve. Se deja pasar
  //    para no romper links ya enviados, pero conviene cerrarlo poniéndole un
  //    token como el de IFCO. Está anotado en el PR que lo introdujo.
  ['GET',  /^\/api\/abasto\/remitos\/\d+\/pdf$/, 'remito que se manda al cliente por WhatsApp — SIN token todavía'],
];

function esPublica(metodo, ruta) {
  for (const [m, re] of PUBLICAS) {
    if (m === metodo && re.test(ruta)) return true;
  }
  return false;
}

// El portón. Se monta DESPUÉS de sesionFirmada y ANTES de todos los routers.
export default function portonApi(req, res, next) {
  // OPTIONS es el pedido que el navegador manda solo antes de un POST a otro
  // dominio. No lleva cookies y no hace nada: pedirle sesión rompería sin motivo.
  if (req.method === 'OPTIONS') return next();

  // La ruta completa. Montado con app.use('/api', ...), Express deja el prefijo
  // en req.baseUrl y el resto en req.path: hay que juntarlos para comparar
  // contra las expresiones de arriba, que están escritas con /api adelante.
  const ruta = (req.baseUrl || '') + (req.path || '');
  if (esPublica(req.method, ruta)) return next();

  // ── DE DÓNDE SALE LA IDENTIDAD ────────────────────────────────────────
  // De req.cookies.lnb_user, NO de req.user. Esto tiró producción abajo una vez
  // y vale la pena que quede escrito.
  //
  // sesionFirmada NO puebla req.user. Lo que hace es verificar la cookie firmada
  // lnb_auth, releer al usuario de la base y REESCRIBIR req.cookies.lnb_user con
  // los datos verdaderos; si la identidad no es válida, BORRA esa cookie. Recién
  // adentro de cada router, que la parsea por su cuenta, aparece req.user.
  //
  // O sea que acá req.user está siempre vacío, y preguntarle a él daba 401 para
  // todo el mundo: el panel cargaba, la primera llamada contestaba 401, el panel
  // mandaba al login, el login andaba, volvía al panel y otra vez 401. Loop.
  //
  // Confiar en que la cookie exista es exactamente lo mismo que confiar en la
  // firma: si la firma no valida, sesionFirmada ya la borró antes de llegar acá.
  const crudo = req.cookies && req.cookies.lnb_user;
  if (crudo) {
    try {
      const u = typeof crudo === 'string' ? JSON.parse(crudo) : crudo;
      if (u && u.id) return next();
    } catch (e) { /* cookie ilegible: se trata como sin sesión */ }
  }
  // Por si algún middleware anterior sí lo dejó puesto (los routers lo hacen).
  if (req.user && req.user.id) return next();

  // El cuerpo va en JSON SÍ O SÍ. Scout llama a r.json() sobre toda respuesta
  // sin mirar el estado: con el HTML que Express manda por defecto revienta con
  // un error de sintaxis y la pantalla queda en blanco, sin decir nada.
  return res.status(401).json({
    ok: false,
    error: 'Necesitás iniciar sesión.',
    // Lo lee el panel para mandar al login en vez de quedarse cargando.
    sesion_expirada: true,
  });
}

// Se exporta para poder probarla sin levantar el servidor.
export { esPublica, PUBLICAS };
