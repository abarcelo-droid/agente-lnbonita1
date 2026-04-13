import { Router } from "express";

const router = Router();

// Precios mayoristas del Mercado Central (XLS oficial)
import * as XLSX from "xlsx";

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
  const tipos = ['RH', 'RF']; // hortalizas primero, luego frutas
  let resultados = [];
  let fuenteUrl = '';

  for (const tipo of tipos) {
    // Intentar con hoy y los últimos 3 días (por si no publicaron aún)
    for (let d = 0; d <= 7; d++) {
      const fecha = new Date(hoy);
      fecha.setDate(fecha.getDate() - d);
      const url = urlXLS(tipo, fecha);
      try {
        const buffer = await descargarXLS(url);
        const encontrados = buscarEnXLS(buffer, producto);
        if (encontrados.length) {
          resultados = encontrados;
          fuenteUrl = url;
          break;
        }
      } catch(e) {
        // archivo no existe para esa fecha, seguir
      }
      if (resultados.length) break;
    }
    if (resultados.length) break;
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

export default router;
