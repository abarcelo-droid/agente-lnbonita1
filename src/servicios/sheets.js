// Lee los catálogos desde Google Sheets publicados como CSV.
// Para actualizar una URL: editá las constantes SHEET_URLS abajo.

const SHEET_URLS = {
  mayorista:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQajhLSQHVTZQWyZzSVZTgKDAgv_D8gk3iiXofhGQJ6mkqASLA-_r2iw6_dQPe2v5-qHrd2qqO_Qu2V/pub?gid=0&single=true&output=csv",
  mayorista_b:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQajhLSQHVTZQWyZzSVZTgKDAgv_D8gk3iiXofhGQJ6mkqASLA-_r2iw6_dQPe2v5-qHrd2qqO_Qu2V/pub?gid=1677640966&single=true&output=csv",
  minorista:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQajhLSQHVTZQWyZzSVZTgKDAgv_D8gk3iiXofhGQJ6mkqASLA-_r2iw6_dQPe2v5-qHrd2qqO_Qu2V/pub?gid=2140950770&single=true&output=csv",
  food_service:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQajhLSQHVTZQWyZzSVZTgKDAgv_D8gk3iiXofhGQJ6mkqASLA-_r2iw6_dQPe2v5-qHrd2qqO_Qu2V/pub?gid=975249691&single=true&output=csv",
};

// Cache en memoria: evita llamar a Sheets en cada mensaje
const TIPOS = ["mayorista", "mayorista_b", "minorista", "food_service"];
const cache = Object.fromEntries(TIPOS.map(t => [t, null]));
const ts    = Object.fromEntries(TIPOS.map(t => [t, 0]));
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// Parsea CSV simple a array de objetos
function parsearCSV(texto) {
  const lineas = texto.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  if (lineas.length < 2) return [];

  const [, ...filas] = lineas;

  return filas
    .map((fila) => {
      const cols = [];
      let actual = "";
      let enComillas = false;
      for (const ch of fila + ",") {
        if (ch === '"') { enComillas = !enComillas; }
        else if (ch === "," && !enComillas) { cols.push(actual.trim()); actual = ""; }
        else { actual += ch; }
      }

      const limpiar      = (s) => (s || "").replace(/^"|"$/g, "").trim();
      const limpiarPrecio = (s) => limpiar(s).replace(/[$\s.]/g, "").replace(/,/g, "");

      return {
        codigo:      limpiar(cols[0]),
        nombre:      limpiar(cols[1]),
        descripcion: limpiar(cols[2]),
        precio:      limpiarPrecio(cols[3]),
        unidad:      limpiar(cols[4]),
        stock:       limpiar(cols[5]).toLowerCase() !== "no",
        notas:       limpiar(cols[6]),
      };
    })
    .filter((p) => p.codigo);
}

export async function obtenerCatalogo(tipo) {
  const ahora = Date.now();

  if (cache[tipo] && ahora - (ts[tipo] || 0) < CACHE_TTL_MS) {
    return cache[tipo];
  }

  const url = SHEET_URLS[tipo];
  if (!url || url.startsWith("PEGAR")) throw new Error(`URL de catálogo no configurada para: ${tipo}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error leyendo Sheets (${tipo}): HTTP ${res.status}`);

  const texto     = await res.text();
  const productos = parsearCSV(texto);

  cache[tipo] = productos;
  ts[tipo]    = ahora;

  return productos;
}

export function invalidarCache(tipo) {
  const lista = tipo ? [tipo] : TIPOS;
  lista.forEach((t) => { cache[t] = null; ts[t] = 0; });
}

// Convierte el array de productos a texto legible para Claude
export function catalogoComoTexto(productos) {
  if (!productos.length) return "⚠️ Catálogo no disponible en este momento.";

  const disponibles = productos.filter((p) => p.stock);
  const agotados    = productos.filter((p) => !p.stock);

  let texto = "";

  disponibles.forEach((p) => {
    texto += `• [${p.codigo}] ${p.nombre}`;
    if (p.descripcion) texto += ` — ${p.descripcion}`;
    if (p.precio)      texto += ` | $${Number(p.precio).toLocaleString("es-AR")}`;
    if (p.unidad)      texto += ` por ${p.unidad}`;
    if (p.notas)       texto += ` (${p.notas})`;
    texto += "\n";
  });

  if (agotados.length) {
    texto += "\n⚠️ Sin stock:\n";
    agotados.forEach((p) => { texto += `• [${p.codigo}] ${p.nombre}\n`; });
  }

  return texto.trim();
}
