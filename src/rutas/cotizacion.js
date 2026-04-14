import { Router } from "express";
import * as XLSX from "xlsx";

const router = Router();

async function descargarXLS(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error('No se pudo descargar: ' + resp.status);
  const buffer = await resp.arrayBuffer();
  return Buffer.from(buffer);
}

function urlXLS(tipo, fecha) {
  const d = String(fecha.getDate()).padStart(2,'0');
  const m = String(fecha.getMonth()+1).padStart(2,'0');
  const y = String(fecha.getFullYear()).slice(-2);
  return `https://mercadocentral.gob.ar/sites/default/files/precios_mayoristas/${tipo}${d}${m}${y}.XLS`;
}

function buscarEnXLS(buffer, busqueda) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const resultados = [];
  const termino = busqueda.toUpperCase().trim();

  wb.SheetNames.forEach(function(sheetName) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    rows.forEach(function(row) {
      const esp = String(row[0] || '').toUpperCase().trim();
      if (!esp.includes(termino)) return;

      const vari = String(row[1] || '').trim();
      if (vari.toUpperCase().includes('PROM')) return; // saltar promedios

      const proc = String(row[2] || '').trim();
      const kg   = parseFloat(row[4]) || null;
      const cal  = String(row[5] || '').trim();
      const tam  = String(row[6] || '').trim();

      // Columna I (índice 8) = precio máx, columna J (índice 9) = precio mín
      const precMax = parseFloat(row[8]) || 0;
      const precMin = parseFloat(row[9]) || 0;

      if (precMax <= 0 && precMin <= 0) return;

      const desc = [esp, vari, proc, cal, tam].filter(Boolean).join(' ').trim();

      resultados.push({
        descripcion: desc.slice(0, 80),
        min: Math.min(precMin || precMax, precMax || precMin),
        max: Math.max(precMin || precMax, precMax || precMin),
        kg,
      });
    });
  });

  return resultados;
}

router.get("/cotizacion/mcba", async (req, res) => {
  const { producto } = req.query;
  if (!producto) return res.status(400).json({ error: "Falta parametro producto" });

  const hoy = new Date();
  const tipos = ['RH', 'RF'];
  let resultados = [];
  let fuenteUrl = '';

  for (const tipo of tipos) {
    // Buscar el archivo más reciente disponible para este tipo
    for (let d = 0; d <= 7; d++) {
      const fecha = new Date(hoy);
      fecha.setDate(fecha.getDate() - d);
      const url = urlXLS(tipo, fecha);
      try {
        const buffer = await descargarXLS(url);
        // Archivo existe — buscar el producto
        const encontrados = buscarEnXLS(buffer, producto);
        if (encontrados.length) {
          resultados = [...resultados, ...encontrados];
          if (!fuenteUrl) fuenteUrl = url;
        }
        break; // Archivo encontrado (aunque no tenga el producto), pasar al siguiente tipo
      } catch(e) {
        // Archivo no existe para esta fecha, probar día anterior
      }
    }
  }

  if (!resultados.length) {
    return res.json({ ok: false, mensaje: `No se encontro "${producto}" en precios del Mercado Central`, resultados: [] });
  }

  res.json({
    ok: true,
    fuente: 'mercadocentral.gob.ar',
    archivo: fuenteUrl.split('/').pop(),
    fecha: hoy.toLocaleDateString('es-AR'),
    resultados,
  });
});

// Busqueda de precios en gondola de supermercados (VTEX)
const SUPERS_VTEX = [
  { key: 'jumbo',       nombre: 'Jumbo',       url: 'https://www.jumbo.com.ar' },
  { key: 'carrefour',   nombre: 'Carrefour',   url: 'https://www.carrefour.com.ar' },
  { key: 'abastecedor', nombre: 'Abastecedor', url: 'https://www.abastecedor.com.ar' },
];

async function buscarVTEX(baseUrl, query) {
  const url = `${baseUrl}/api/catalog_system/pub/products/search/${encodeURIComponent(query)}?O=OrderByScoreASC&_from=0&_to=7`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.map(function(p) {
      const item = p.items && p.items[0] ? p.items[0] : {};
      const seller = item.sellers && item.sellers[0] ? item.sellers[0] : {};
      const precio = seller.commertialOffer ? seller.commertialOffer.Price || 0 : 0;
      return {
        id: p.productId, nombre: p.productName, precio,
        ean: item.ean || '', unidad: item.measurementUnit || '',
        multiplicador: item.unitMultiplier || 1,
        link: baseUrl + (p.linkText ? '/' + p.linkText + '/p' : ''),
      };
    }).filter(function(p){ return p.precio > 0; });
  } catch(e) {
    console.error('[VTEX]', baseUrl, e.message);
    return [];
  }
}

router.get("/cotizacion/gondola", async (req, res) => {
  const { producto } = req.query;
  if (!producto) return res.status(400).json({ error: "Falta parametro producto" });
  const resultados = {};
  await Promise.all(SUPERS_VTEX.map(async function(s) {
    resultados[s.key] = { nombre: s.nombre, productos: await buscarVTEX(s.url, producto) };
  }));
  res.json({ ok: true, query: producto, fecha: new Date().toLocaleDateString('es-AR'), resultados });
});

export default router;
