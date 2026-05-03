// ═════════════════════════════════════════════════════════════════════════
// rutas/clima.js — proxy a fuentes externas de clima (SMN, futuro UNSJ-PGICH)
// ═════════════════════════════════════════════════════════════════════════
import express from "express";

const router = express.Router();

// ── CONFIG ──────────────────────────────────────────────
const CARPINTERIA_LAT = -31.7995;
const CARPINTERIA_LON = -68.5618;
const CACHE_MS  = 10 * 60 * 1000;  // 10 minutos
const FETCH_TIMEOUT_MS = 8000;     // 8s para no colgar el dashboard
const SMN_URL = "https://ws.smn.gob.ar/map_items/weather";

// ── CACHE EN MEMORIA ────────────────────────────────────
let smnCache = { data: null, ts: 0 };

// ── HELPERS ─────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function fetchConTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(id);
  }
}

// ═════════════════════════════════════════════════════════════════════════
// GET /api/pa/clima/smn
// Devuelve la estación SMN más cercana a Carpinteria con sus datos actuales.
// La API de SMN no tiene CORS abierto y sus URLs no son oficiales, por eso
// hacemos proxy desde el backend con cache de 10min.
// ═════════════════════════════════════════════════════════════════════════
router.get("/smn", async (req, res) => {
  // Cache hit
  if (smnCache.data && (Date.now() - smnCache.ts) < CACHE_MS) {
    return res.json({ ok: true, data: smnCache.data, cached: true });
  }

  try {
    const r = await fetchConTimeout(SMN_URL, FETCH_TIMEOUT_MS);
    if (!r.ok) throw new Error(`SMN respondió ${r.status}`);
    const all = await r.json();

    if (!Array.isArray(all)) throw new Error("Respuesta inesperada");

    // Quedarme solo con estaciones que tengan coords válidas y datos de tiempo
    const candidatas = all
      .filter(s => s && s.weather && s.lat && s.lon)
      .map(s => {
        const latNum = parseFloat(s.lat);
        const lonNum = parseFloat(s.lon);
        if (isNaN(latNum) || isNaN(lonNum)) return null;
        return {
          name: s.name,
          province: s.province,
          lat: latNum,
          lon: lonNum,
          updated: s.updated,
          weather: s.weather,
          distKm: haversineKm(CARPINTERIA_LAT, CARPINTERIA_LON, latNum, lonNum)
        };
      })
      .filter(Boolean);

    if (!candidatas.length) throw new Error("Sin estaciones válidas en respuesta");

    // Ordenar por distancia ascendente
    candidatas.sort((a, b) => a.distKm - b.distKm);
    const closest = candidatas[0];

    const data = {
      estacion: closest.name,
      provincia: closest.province,
      distancia_km: Math.round(closest.distKm),
      lat: closest.lat,
      lon: closest.lon,
      updated: closest.updated,
      weather: closest.weather
    };

    smnCache = { data, ts: Date.now() };
    return res.json({ ok: true, data, cached: false });

  } catch (e) {
    console.error('[clima/smn]', e.message);
    // Si hay cache vieja, mejor devolverla que un error en blanco
    if (smnCache.data) {
      return res.json({ ok: true, data: smnCache.data, cached: true, stale: true });
    }
    return res.status(503).json({ ok: false, error: 'No se pudo obtener datos del SMN' });
  }
});

export default router;
