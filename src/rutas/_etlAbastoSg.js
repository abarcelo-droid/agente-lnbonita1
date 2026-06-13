// src/rutas/_etlAbastoSg.js
// ── ENDPOINT ADMIN TEMPORAL #401 — backup → ETL → verify (REMOVER tras verificar) ──
// Admin-only. Pasos separados y controlados (no todo de un saque):
//   GET  /api/admin/_etl-abasto/verify           → conteos actuales sg_*
//   GET  /api/admin/_etl-abasto/backup           → db.backup() online (WAL-safe) a archivo aparte
//   GET  /api/admin/_etl-abasto/backup/download   → descarga el último backup off-box
//   POST /api/admin/_etl-abasto/run?confirmo=SI   → corre el ETL en 1 transacción (exige backup previo)
// El dump de 231MB NO se sube al contenedor: se inserta el payload precomputado/auditable
// (etlAbastoSgPayload.json), validado por el dry-run.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, dbPath } from '../servicios/db.js';
import { runEtl, getCounts } from '../servicios/etlAbastoSg.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PAYLOAD_PATH = path.join(__dir, '../servicios/etlAbastoSgPayload.json');
const BACKUP_PREFIX = 'backup-pre-etl-abasto-';
const router = express.Router();

// auth: cookie lnb_user → req.user (mismo patrón que admin.js/org.js)
router.use((req, res, next) => {
  try { const c = req.cookies?.lnb_user; if (c) req.user = JSON.parse(c); } catch (_) {}
  next();
});
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.rol !== 'admin') return res.status(403).json({ ok: false, error: 'Solo admin' });
  next();
};
const backupDir = () => path.dirname(dbPath);
const listBackups = () => {
  try { return fs.readdirSync(backupDir()).filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith('.db')); }
  catch { return []; }
};

// ── VERIFY ──
router.get('/verify', requireAdmin, (req, res) => {
  res.json({ ok: true, counts: getCounts(getDb()), esperado: { familias: 17, especies: 100, variedades: 347, envases: 16, productos: 588, presentaciones: 725 } });
});

// ── BACKUP (online, WAL-safe) ──
router.get('/backup', requireAdmin, async (req, res) => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `${BACKUP_PREFIX}${stamp}.db`;
    const dest = path.join(backupDir(), file);
    await getDb().backup(dest);               // better-sqlite3 online backup (consistente con WAL)
    const sizeBytes = fs.statSync(dest).size;
    res.json({ ok: true, file, ruta: dest, sizeBytes, sizeMB: +(sizeBytes / 1048576).toFixed(1),
      downloadUrl: `/api/admin/_etl-abasto/backup/download?file=${encodeURIComponent(file)}` });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── DESCARGA DEL BACKUP off-box ──
router.get('/backup/download', requireAdmin, (req, res) => {
  const file = String(req.query.file || '');
  if (!/^backup-pre-etl-abasto-[\w.\-]+\.db$/.test(file)) return res.status(400).json({ ok: false, error: 'Nombre inválido' });
  const full = path.join(backupDir(), file);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: 'No existe' });
  res.download(full);
});

// ── RUN ETL (exige backup previo + confirmación explícita) ──
router.post('/run', requireAdmin, (req, res) => {
  if (String(req.query.confirmo) !== 'SI') return res.status(400).json({ ok: false, error: 'Falta ?confirmo=SI' });
  if (listBackups().length === 0) return res.status(400).json({ ok: false, error: 'No hay backup previo. Hacé GET /backup primero.' });
  let payload;
  try { payload = JSON.parse(fs.readFileSync(PAYLOAD_PATH, 'utf8')); }
  catch (e) { return res.status(500).json({ ok: false, error: 'No se pudo leer el payload: ' + e.message }); }
  try {
    const r = runEtl(getDb(), payload);
    if (!r.ok) return res.status(409).json(r);     // guard disparó (catálogo no vacío / FK seed)
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message, stack: e.stack }); }
});

export default router;
