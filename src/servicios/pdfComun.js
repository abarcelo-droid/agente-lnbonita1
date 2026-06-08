// src/servicios/pdfComun.js
// Identidad visual compartida de los PDF de San Gerónimo (OC, informe de calidad…)
// para que se vean como una familia: misma paleta azul/gris, mismo emisor fiscal y
// el mismo logo La Niña Bonita. Lo importan ocPDF.js y recepcionCalidadPDF.js.

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Paleta azul/gris
export const AZUL    = [20, 60, 120];
export const AZUL_CL = [222, 232, 245];
export const GRIS    = [90, 90, 90];
export const GRIS_CL = [244, 246, 249];

// Datos fiscales del emisor (San Gerónimo SA). Hardcodeado igual que ordenPDF.js
// hardcodea los datos de la empresa; si en el futuro se cargan en `sociedades`, leer de ahí.
export const EMISOR = {
  marca: 'La Niña Bonita',
  razon: 'San Gerónimo SA',
  cuit: '30-67325443-4',
  domicilio: 'Mercado Central de Buenos Aires, Nave 4, Puestos 2-4-6',
};

export const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const nr    = (n) => Number(n || 0).toLocaleString('es-AR');

// Logo cacheado en base64 (undefined=no intentado, null=falló, string=OK).
let _logoB64 = undefined;
export function getLogo() {
  if (_logoB64 !== undefined) return _logoB64;
  try {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'logo.jpg'));
    _logoB64 = 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch (e) {
    console.error('[PDF] No se pudo cargar logo.jpg:', e.message);
    _logoB64 = null;
  }
  return _logoB64;
}
