import { Router } from "express";

const router = Router();

// Scraping de preciosdelcentral.com.ar para traer precio mayorista MCBA
router.get("/cotizacion/mcba", async (req, res) => {
  const { producto } = req.query;
  if (!producto) return res.status(400).json({ error: "Falta parametro producto" });

  try {
    const resp = await fetch("https://preciosdelcentral.com.ar/buenosaires", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "es-AR,es;q=0.9",
      },
      signal: AbortSignal.timeout(8000),
    });

    const html = await resp.text();
    const busqueda = producto.toUpperCase().trim();

    // Buscar el bloque del producto en el HTML
    const resultados = [];
    const regex = new RegExp(
      `(${busqueda.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^<]*?)` +
      `[\\s\\S]{0,600}?Precio promedio[\\s\\S]{0,100}?\\$[\\s\\S]{0,20}?(\\d[\\d.]+)\\s*/\\s*Kg`,
      'gi'
    );

    let match;
    while ((match = regex.exec(html)) !== null && resultados.length < 5) {
      const nombre = match[1].trim().replace(/<[^>]+>/g, '').trim();
      const precio = parseInt(match[2].replace(/\./g, ''));
      if (!isNaN(precio) && precio > 0) {
        resultados.push({ nombre, precio_kg: precio });
      }
    }

    // Fallback: buscar con regex mas simple por lineas del HTML
    if (!resultados.length) {
      const lines = html.split('\n');
      let encontrado = false;
      let nombreActual = '';
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.toUpperCase().includes(busqueda)) {
          encontrado = true;
          nombreActual = l.replace(/<[^>]+>/g, '').trim();
        }
        if (encontrado && l.includes('Precio promedio')) {
          const mPrecio = lines.slice(i, i+5).join('').match(/\$\s*([\d.]+)\s*\/\s*Kg/i);
          if (mPrecio) {
            resultados.push({
              nombre: nombreActual || busqueda,
              precio_kg: parseInt(mPrecio[1].replace(/\./g,''))
            });
            encontrado = false;
          }
        }
      }
    }

    if (!resultados.length) {
      return res.json({ ok: false, mensaje: `No se encontro "${producto}" en Precios del Central`, resultados: [] });
    }

    res.json({ ok: true, fuente: "preciosdelcentral.com.ar", fecha: new Date().toLocaleDateString('es-AR'), resultados });

  } catch (err) {
    console.error("[COTIZACION] Error:", err.message);
    res.status(500).json({ ok: false, error: "No se pudo conectar con Precios del Central" });
  }
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
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.map(function(p) {
      const item = p.items && p.items[0] ? p.items[0] : {};
      const seller = item.sellers && item.sellers[0] ? item.sellers[0] : {};
      const precio = seller.commertialOffer ? seller.commertialOffer.Price || 0 : 0;
      return {
        id:            p.productId,
        nombre:        p.productName,
        precio,
        ean:           item.ean || '',
        unidad:        item.measurementUnit || '',
        multiplicador: item.unitMultiplier || 1,
        link:          baseUrl + (p.linkText ? '/' + p.linkText + '/p' : ''),
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
    resultados[s.key] = {
      nombre: s.nombre,
      productos: await buscarVTEX(s.url, producto),
    };
  }));
  res.json({ ok: true, query: producto, fecha: new Date().toLocaleDateString('es-AR'), resultados });
});

export default router;
