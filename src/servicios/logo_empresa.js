// src/servicios/logo_empresa.js
// ── EL LOGO DE UNA EMPRESA: QUÉ SE ACEPTA, EN UN SOLO LUGAR ────────────────
//
// Este texto termina metido en el `src` de un <img> del documento que se le manda al proveedor. Si
// se aceptara cualquier cosa, una comilla adentro cerraría el atributo y lo que siguiera sería
// marcado, y un SVG puede traer el suyo propio.
//
// Vive acá y no adentro del router porque lo usan DOS lugares: la ruta que lo sube y la siembra del
// arranque. Dos copias de un filtro de seguridad es como no tener ninguno — alcanza con que mañana
// alguien afloje una para que la otra no sirva de nada.

// Mapa de bits en base64 y nada más. Con este filtro el texto no puede tener comillas ni signos de
// mayor o menor.
export const LOGO_FORMATO = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

// 250.000 caracteres de base64 son unos 185 KB de imagen: de sobra para un logo, y poco para que la
// foto de 4 MB de un celular termine en la base y en cada impresión. La pantalla la reduce antes de
// mandarla; esto es el techo, para el que llame a la API por su cuenta.
export const LOGO_MAX = 250000;

// Los tres tipos que se aceptan, con su FIRMA: los primeros bytes que tiene un archivo de ese
// tipo. La extensión sola no alcanza —cualquiera puede llamar «logo.jpg» a un texto— y este archivo
// termina impreso arriba de una orden que se le manda al proveedor.
const TIPOS = {
  '.png':  { mime: 'image/png',  firma: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  '.jpg':  { mime: 'image/jpeg', firma: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  '.jpeg': { mime: 'image/jpeg', firma: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  '.webp': { mime: 'image/webp', firma: (b) => b.length > 11 && b.toString('ascii', 0, 4) === 'RIFF'
                                            && b.toString('ascii', 8, 12) === 'WEBP' },
};

export function validarLogo(txt) {
  const s = String(txt == null ? '' : txt).trim();
  if (!s) return null;                        // vacío: se quita el logo
  if (s.length > LOGO_MAX) {
    throw new Error('La imagen es muy grande (hasta 185 KB). Probá con una más chica o recortada.');
  }
  if (!LOGO_FORMATO.test(s)) {
    throw new Error('El logo tiene que ser una imagen PNG, JPG o WEBP.');
  }
  return s;
}

// Arma el data URI de una imagen que está en el repo, a partir de sus bytes y del nombre del
// archivo. Devuelve null —y no una cadena rota— si no es una imagen de las tres, o si el resultado
// no pasa el mismo filtro que valida la ruta: el que siembra no tiene por qué tener menos control
// que el que sube.
//
// Y MIRA LOS BYTES, NO SÓLO EL NOMBRE. Con la extensión sola, un archivo mal copiado —un puntero de
// git-lfs, un HTML de error, un texto— se sembraba como «image/jpeg» perfectamente válido: pasaba
// el filtro del formato, entraba a la base, y quedaba ahí para siempre porque la siembra corre una
// sola vez. Arriba de la orden se vería el ícono de imagen rota, en un papel que se manda afuera.
export function logoDeArchivo(bytes, nombre) {
  const ext = String(nombre || '').toLowerCase().slice(String(nombre || '').lastIndexOf('.'));
  const tipo = TIPOS[ext];
  // Sin `!bytes.length`: un archivo vacío lo rechaza el filtro de abajo, porque el formato exige
  // que después de «base64,» haya algo. Se sacó porque no lo distinguía ninguna prueba —y un
  // chequeo que no se puede probar no está protegiendo nada, sólo tapa al que sí protege.
  if (!tipo || !bytes) return null;
  const buf = Buffer.from(bytes);
  if (buf.length < 12 || !tipo.firma(buf)) return null;
  const uri = 'data:' + tipo.mime + ';base64,' + buf.toString('base64');
  try { return validarLogo(uri); } catch (_) { return null; }
}

export default { LOGO_FORMATO, LOGO_MAX, validarLogo, logoDeArchivo };
