import { Router } from "express";

const router = Router();

// Precios mayoristas del Mercado Central (XLS oficial)
import ExcelJS from "exceljs";

async function descargarXLS(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error('No se pudo descargar el archivo');
  const buffer = await resp.arrayBuffer();
  return Buffer.from(buffer);
}

function urlXLS(tipo, fecha) {
  // tipo: 'RH' (hortalizas) o 'RF' (frutas)
  const d = String(fecha.getDate()).padStart(2,'0');
  const m = String(fecha.getMonth()+1).padStart(2,'0');
  const y = String(fecha.getFullYear()).slice(-2);
  return `https://mercadocentral.gob.ar/sites/default/files/precios_mayoristas/${tipo}${d}${m}${y}.XLS`;
}

async function buscarEnXLS(buffer, busqueda) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const resultados = [];
  const termino = busqueda.toUpperCase().trim();

  wb.eachSheet(function(sheet) {
    sheet.eachRow(function(row) {
      const vals = [];
      row.eachCell(function(cell) { vals.push(String(cell.value||'').trim()); });
      const linea = vals.join(' ').toUpperCase();
      if (linea.includes(termino)) {
        // Buscar números que parezcan precios en la fila
        const precios = vals.filter(function(v){
          const n = parseFloat(v.replace(/\./g,'').replace(',','.'));
          return !isNaN(n) && n > 10;
        }).map(function(v){ return parseFloat(v.replace(/\./g,'').replace(',','.')); });
        if (precios.length) {
          resultados.push({
            descripcion: vals.filter(function(v){ return v && isNaN(parseFloat(v)); }).join(' ').trim().slice(0,80),
            precios,
            min: Math.min(...precios),
            max: Math.max(...precios),
          });
        }
      }
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
    for (let d = 0; d <= 3; d++) {
      const fecha = new Date(hoy);
      fecha.setDate(fecha.getDate() - d);
      const url = urlXLS(tipo, fecha);
      try {
        const buffer = await descargarXLS(url);
        const encontrados = await buscarEnXLS(buffer, producto);
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
