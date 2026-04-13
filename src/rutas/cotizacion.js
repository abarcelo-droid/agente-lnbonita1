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

export default router;
