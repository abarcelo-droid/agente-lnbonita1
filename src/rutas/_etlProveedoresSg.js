// src/rutas/_etlProveedoresSg.js
// ── ENDPOINT ADMIN TEMPORAL #401 — backup → reset(sg_proveedores) → run → verify ──
// Admin-only. Mismo patrón seguro que el ETL de catálogo (ya removido). REMOVER tras verificar.
//   GET  /api/admin/_etl-proveedores/verify          → conteo sg_proveedores (esperado 955)
//   GET  /api/admin/_etl-proveedores/backup          → db.backup() online (WAL-safe)
//   GET  /api/admin/_etl-proveedores/backup/download  → descarga off-box
//   POST /api/admin/_etl-proveedores/reset?confirmo=SI → vacía SOLO sg_proveedores (exige backup)
//   POST /api/admin/_etl-proveedores/run?confirmo=SI   → inserta el payload (exige backup + vacío)
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, dbPath } from '../servicios/db.js';
import { runEtlProveedores, getProveedoresCount } from '../servicios/etlProveedoresSg.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PAYLOAD_PATH = path.join(__dir, '../servicios/etlProveedoresSgPayload.json');
const BACKUP_PREFIX = 'backup-pre-prov-';
const router = express.Router();

router.use((req, res, next) => {
  try { const c = req.cookies?.lnb_user; if (c) req.user = JSON.parse(c); } catch (_) {}
  next();
});
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.rol !== 'admin') return res.status(403).json({ ok: false, error: 'Solo admin' });
  next();
};
const backupDir = () => path.dirname(dbPath);
const listBackups = () => { try { return fs.readdirSync(backupDir()).filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith('.db')); } catch { return []; } };

// ── VERIFY ──
router.get('/verify', requireAdmin, (req, res) => {
  res.json({ ok: true, sg_proveedores: getProveedoresCount(getDb()), esperado: 701 });
});

// ── BACKUP (online, WAL-safe; estado actual CON catálogo migrado) ──
router.get('/backup', requireAdmin, async (req, res) => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `${BACKUP_PREFIX}${stamp}.db`;
    const dest = path.join(backupDir(), file);
    await getDb().backup(dest);
    const sizeBytes = fs.statSync(dest).size;
    res.json({ ok: true, file, ruta: dest, sizeBytes, sizeMB: +(sizeBytes / 1048576).toFixed(1),
      downloadUrl: `/api/admin/_etl-proveedores/backup/download?file=${encodeURIComponent(file)}` });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/backup/download', requireAdmin, (req, res) => {
  const file = String(req.query.file || '');
  if (!/^backup-pre-prov-[\w.\-]+\.db$/.test(file)) return res.status(400).json({ ok: false, error: 'Nombre inválido' });
  const full = path.join(backupDir(), file);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: 'No existe' });
  res.download(full);
});

// ── RESET (solo sg_proveedores; exige backup + confirmo=SI) ──
router.post('/reset', requireAdmin, (req, res) => {
  if (String(req.query.confirmo) !== 'SI') return res.status(400).json({ ok: false, error: 'Falta ?confirmo=SI' });
  if (listBackups().length === 0) return res.status(400).json({ ok: false, error: 'No hay backup previo. Hacé GET /backup primero.' });
  const db = getDb();
  const before = getProveedoresCount(db);
  try {
    const deleted = db.prepare('DELETE FROM sg_proveedores').run().changes;
    res.json({ ok: true, tabla: 'sg_proveedores', before, deleted, preservado: ['sg_clientes', 'sg_condiciones_pago', 'ifco_*', 'catálogo/operaciones/OC SG', 'contable'] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── RUN (exige backup + confirmo=SI; aborta si no está vacío o faltan columnas #421) ──
router.post('/run', requireAdmin, (req, res) => {
  if (String(req.query.confirmo) !== 'SI') return res.status(400).json({ ok: false, error: 'Falta ?confirmo=SI' });
  if (listBackups().length === 0) return res.status(400).json({ ok: false, error: 'No hay backup previo. Hacé GET /backup primero.' });
  let payload;
  try { payload = JSON.parse(fs.readFileSync(PAYLOAD_PATH, 'utf8')); }
  catch (e) { return res.status(500).json({ ok: false, error: 'No se pudo leer el payload: ' + e.message }); }
  try {
    const r = runEtlProveedores(getDb(), payload);
    if (!r.ok) return res.status(409).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message, stack: e.stack }); }
});

export default router;
